/**
 * 本地词典（D-336 / D-401 词典批）—— Android 装配层。
 *
 * ══ 判据来处 ═══════════════════════════════════════════════
 *   解析 = core/dict/mdx.ts（与 Windows 同一份；这里只注入两个端口：
 *   内存缓冲的 DictionaryIO + fflate 的 inflate —— D-238 的「换掉的只有 io」）
 *   登记 = v35 `dictionaries` 表（与 Windows 同表同列；本地面，不跨端同步）
 *
 * ══ 字节从哪来 ═════════════════════════════════════════════
 *   SAF 文件夹（用户在 Settings 选，树权限持久化）→ content:// →
 *   **真随机读**（`db/dict-io.ts` + 原生 `DictFiles.java`），两个 WebView
 *   装的是同一份 io。PC 测试注 fs 版的同形 io。
 *   与 ai.ts 的 keyProvider 同款注入纪律。
 *
 * ══ 内存策略（★ T-5.10 改了）═══════════════════════════════
 *   **有 io（随机读）**：只读索引与命中的块 —— 内存不随书大小长。
 *   **没有 io（PC 里没注 io 的路径）**：退回整本进内存、最多驻 2 本。
 *   在 T-5.10 之前 App 那一侧只有后者，于是大书必失败，而失败又被
 *   `hitOf` 吞成「这本里没有」。现在两条都在，走哪条看
 *   `globalThis.nyxDb.dictIo`（`random` / `memory`）—— ③ 档验收变量。
 */
import { unzlibSync } from 'fflate'
import {
  detectRedirect,
  dictExtensionOf,
  dictUid,
  dictMimeOf,
  DictionaryOpenError,
  isPlayableAudioExt,
  MAX_REDIRECT_HOPS,
  Mdx,
  mdxToText,
  normalizeResourceKey,
  toDiagnostic,
  type DictionaryIO,
  type DictionaryStatus,
  type FileHandle
} from '../core-link.ts'
import { prefRaw, prefSet } from './prefs.ts'
import type { Db } from './types.ts'

export type BytesProvider = (uri: string) => Promise<Uint8Array>

let bytesProvider: BytesProvider = () =>
  Promise.reject(new Error('词典字节源还没接（App 启动时注入）'))
export function setDictBytesProvider(p: BytesProvider): void {
  bytesProvider = p
  publishDictIo()
}

/**
 * **真随机读**（原生 ContentResolver + FileChannel，同步）：几十～几百 MB
 * 的书只读到索引与命中的那几块，首查从「等整本」变成「等几 KB」。
 *
 * ★ T-5.10：这条以前只有 Assist 引擎注得进来（D-404），App 那一侧没有 ——
 *   于是 Lookup 只能整本进内存（大书必败、音频卷根本不可能）。现在
 *   `DictPlugin.DictHost` 给 App 的 WebView 挂了同一条通道，两边注的是
 *   同一个 `DictionaryIO`（`db/dict-io.ts`）。
 * 接了 io 就走 io；没接仍走 bytes + 内存缓冲（PC 测试里两条都跑得到）。
 */
export type IoProvider = (uri: string, name: string) => DictionaryIO
let ioProvider: IoProvider | null = null
/** 传 null = 这台没有随机读（PC 预览 / 通道没挂上）—— 退回整本进内存那条路 */
export function setDictIoProvider(p: IoProvider | null): void {
  ioProvider = p
  publishDictIo()
}

/**
 * ③ 档验收变量（同 `nyxDb.busyTimeoutMs` / `nyxTts.engine()` 的纪律：
 * 不看界面，看变量）。真机上 App 与引擎都应当报 `random`；
 * 报 `memory` 就说明原生那条通道没挂上 —— 一眼看得出来，不用猜。
 */
function publishDictIo(): void {
  const g = globalThis as Record<string, unknown>
  const cur = (g['nyxDb'] as Record<string, unknown> | undefined) ?? {}
  cur['dictIo'] = ioProvider ? 'random' : 'memory'
  g['nyxDb'] = cur
}
publishDictIo()

/** 随机读在场吗 —— 「整本进内存」派生出来的那些上限只对没有它的路径成立 */
const randomIo = (): boolean => ioProvider !== null

/** 内存缓冲上的 DictionaryIO —— 契约语义：读到尾返回短的，不抛 */
function memIo(bytes: Uint8Array): DictionaryIO {
  return {
    open(path: string): FileHandle {
      return { path, size: bytes.length }
    },
    read(_h: FileHandle, at: number, len: number): Uint8Array {
      return bytes.subarray(at, Math.min(at + len, bytes.length))
    },
    close(): void {
      /* 内存缓冲无句柄 */
    }
  }
}

const inflate = (d: Uint8Array): Uint8Array => unzlibSync(d)

async function openMdx(uri: string, name: string, mdd = false): Promise<Mdx> {
  const opts = mdd ? { mdd: true } : undefined
  if (ioProvider) return Mdx.open(name, ioProvider(uri, name), inflate, opts)
  const bytes = await bytesProvider(uri)
  return Mdx.open(name, memIo(bytes), inflate, opts)
}

/** uri → 装好的书。Map 迭代顺序 = 装入顺序，超过 `MDX_CACHE_MAX` 本逐出最旧 */
const cache = new Map<string, Mdx>()

/** T-6.5 · 上一次 `loadedMdx` 是现开的吗（缓存没命中 = 索引重建）。只记账，不参与判断 */
let lastMdxOpened = false

async function loadedMdx(uri: string, name: string, pin = false): Promise<Mdx> {
  const hit = cache.get(uri)
  if (hit) {
    lastMdxOpened = false
    cache.delete(uri) // 重新排到最新
    cache.set(uri, hit)
    return hit
  }
  lastMdxOpened = true
  const m = await openMdx(uri, name)
  cache.set(uri, m)
  if (pin) pinnedUri = uri
  /**
   * ★ T-6.6 · 逐出时**跳过钉住的那一本**（默认词典的索引）。
   *   不跳的话 `MDX_CACHE_MAX = 2` 在他启用 15 本时会把默认书挤掉，
   *   下一次发音又是冷开 —— 那正是 ② 那条被实测证实的成因。
   * ★ 全钉住了就不逐（钉的只有一本，`cache` 至多比上限多一个）。
   */
  while (cache.size > MDX_CACHE_MAX) {
    const victim = [...cache.entries()].find(([u]) => u !== pinnedUri)
    if (!victim) break
    victim[1].close()
    cache.delete(victim[0])
  }
  return m
}

export function dropDictCache(): void {
  for (const m of cache.values()) m.close()
  cache.clear()
  for (const m of mddCache.values()) if (m) m.close()
  mddCache.clear()
  for (const m of pronVolCache.values()) if (m) m.close()
  pronVolCache.clear()
  assetCache.clear()
}

// ══ 「这一行本来就不是词典」（I-159）══════════════════════════
/**
 * 拷贝时留下的伴生文件（AppleDouble）：`._foo` 与 `_._foo` 都算。
 * ★ 判据只有这一份 —— 列夹子时用它决定跳过（`classifyDictFiles`），
 *   重扫时用它决定旧行要不要退役（`scanDictFolder`）。两处各写一遍，
 *   规则一改就有一边留在旧世界：真机上那一行正是这么来的（I-159）。
 */
export const isCompanionName = (name: string): boolean => /^_?\._/.test(name)

/**
 * 从入库那一列（SAF 的 `content://` URI）反推文件名。
 *
 * 表里**没有存文件名** —— 而「这一行的名字现在还像不像词典」只能从它这里看。
 * SAF 的文档 URI 长这样（末段把整条路径转义了进去）：
 *   `content://…/tree/primary%3ADict/document/primary%3ADict%2F_._TLD.mdx`
 * 解开转义之后，名字就在最后一个 `/`、`:` 或 `\` 之后（PC 上的用例喂的是真路径）。
 * ★ 半截转义（`%` 后面不是两位十六进制）会让 `decodeURIComponent` 抛 —— 那就原样用：
 *   宁可少认出一个，也不要让重扫整趟挂掉。
 */
export function fileNameOfUri(uri: string): string {
  let s = uri
  try {
    s = decodeURIComponent(uri)
  } catch {
    /* 半截转义的原样用 */
  }
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'), s.lastIndexOf('\\'))
  return cut >= 0 ? s.slice(cut + 1) : s
}

/**
 * 退役：`dictionaries.status` 上的一个值 —— **不加列**（结构指纹不动）。
 * 语义与 `error`（读不了）、`missing`（不在夹里了）都不一样：
 * 它说的是「这一行本来就不是词典」。
 */
export const NOT_A_DICT = 'notdict'

/** 退役行上写的那句 —— 诊断里查得到「它为什么不在书目里了」（D-412 说真话） */
export const RETIRED_WHY =
  '文件名是拷贝时留下的伴生文件（._ 或 _._ 开头），本来就不是词典 —— 已退役，不再当书列出'

export interface DictRow {
  id: number
  uri: string
  bookname: string
  wordCount: number
  enabled: boolean
  sortOrder: number
  missing: boolean
  status: string | null
  diagnostic: string | null
  /** 跨设备身份（core dictUid）—— dict.default 存的就是它；老行扫一次才有 */
  uid: string | null
}

async function queryDicts(db: Db, retired: boolean): Promise<DictRow[]> {
  return (
    await db.all(
      `select id, ifo_path as uri, bookname, word_count as wc, enabled, sort_order as so,
              missing, status, diagnostic, uid
         from dictionaries
        where coalesce(status, '') ${retired ? '=' : '<>'} ?
        order by sort_order, id`,
      [NOT_A_DICT]
    )
  ).map((r) => ({
    id: Number(r['id']),
    uri: String(r['uri']),
    bookname: String(r['bookname']),
    wordCount: Number(r['wc']),
    enabled: Number(r['enabled']) !== 0,
    sortOrder: Number(r['so']),
    missing: Number(r['missing']) !== 0,
    status: r['status'] != null ? String(r['status']) : null,
    diagnostic: r['diagnostic'] != null ? String(r['diagnostic']) : null,
    uid: r['uid'] != null ? String(r['uid']) : null
  }))
}

/**
 * 书目（设置页那一列 · 查词命中顺序的来源）—— **退役的行不在里面**。
 * 它们没被删（D-216 只增不删：排序与开关是使用者的配置），只是不再当书。
 */
export async function listDicts(db: Db): Promise<DictRow[]> {
  return queryDicts(db, false)
}

/** 退役了的那些行 —— 书目不列，但「它去哪了」要查得到（I-159） */
export async function listRetiredDicts(db: Db): Promise<DictRow[]> {
  return queryDicts(db, true)
}

export async function setDictEnabled(db: Db, id: number, enabled: boolean): Promise<void> {
  await db.run(`update dictionaries set enabled = ?, updated_at = ? where id = ?`, [
    enabled ? 1 : 0,
    Date.now(),
    id
  ])
}

/**
 * 拖动排序（D-361 · 阶段 7）：新顺序整表落 sort_order。
 * 这个顺序就是**查词命中顺序**（listDicts 按它排 → lookupDicts 逐本查、
 * defaultBook 回退取第一本、发音找卷也按它）——不是摆设。本地面，不跨端。
 */
export async function reorderDicts(db: Db, ids: number[]): Promise<void> {
  const t = Date.now()
  for (let i = 0; i < ids.length; i++) {
    await db.run(`update dictionaries set sort_order = ?, updated_at = ? where id = ?`, [
      i + 1,
      t,
      ids[i]
    ])
  }
}

export interface FolderFile {
  name: string
  uri: string
  size: number
  /**
   * 相对目录，顶层 = 空串，子目录形如 `Longman 5/`（T-5.16 起原生递归时带上）。
   * ★ 可选是因为**存量清单没有这个字段**（settings 里那份是上一版写的）——
   *   一律经 `dirOf` 读，缺省当顶层；App 每次开库刷一遍清单，自己就长齐了。
   */
  dir?: string
}

/** 看见了、但不当词典文件用的那些（T-5.16 —— 不许静默跳过） */
export interface SkippedItem {
  /** 看见的那个名字（目录那类就是相对路径） */
  name: string
  dir: string
  /** 为什么不当书用 —— 一句人话，直接上屏 */
  why: string
}

/** 原生列夹子时**没看全**的三种事实（不是判据，是事实；话术在 JS） */
export interface FolderLimits {
  maxDepth: number
  maxEntries: number
  /** 条数到顶了 */
  truncated: boolean
  /** 层数到顶、没进去的目录 */
  tooDeep: string[]
  /** 读不了的目录（多半是权限） */
  unreadable: string[]
}

export interface FolderListing {
  /** 真的当词典文件用的（.mdx / .mdd / .css） */
  files: FolderFile[]
  skipped: SkippedItem[]
  /** 没看全时那句人话；看全了 = null */
  incomplete: string | null
}

/**
 * ★★ T-5.16 · **夹子里哪些是词典文件、哪些跳过、跳过了怎么说。**
 *
 * 原生那一层（`DictPlugin.listFolder`）T-5.16 起**一条都不筛**，把树上看见的全给回来 ——
 * 判据与话术放在这里才有用例、才做得了负向对照（与 T-6.1 把 L0 收回引擎同一课）。
 * 而且「跳过 M 项」这个数只有在原生全给回来时才对得上目录里的真实文件。
 *
 * 两条判据，都来自真机：
 *   · `._` / `_._` 开头 = 拷贝时留下的 AppleDouble 伴生文件。**它会被当书登记** ——
 *     `scanDictFolder` 只按扩展名过滤，所以 `._某书.mdx` 照样进库。
 *     ★★ 2026-09-07 真机复核（C 装 `a8219e1`）：那个文件**真名叫 `_._TLD.mdx`**
 *     —— `_._` 前缀，不是 `._`。T-5.16 那版只认 `._`，于是它照旧闯过扩展名过滤、
 *     172 字节解析失败，**仍以 `status=error` 躺在书目第 6 本**。同族的
 *     `_._config.ini` / `_._fy.js` 当时进了跳过，只是因为它们的扩展名不是词典 ——
 *     那是**碰巧对了**，不是规则对了。所以前缀规则认两种：`/^_?\._/`。
 *   · 不是 .mdx / .mdd / .css 的（`config.ini` 这些）—— 原来在 Java 里被静默 `continue`，
 *     使用者看不到任何一句话。
 */
export function classifyDictFiles(
  all: FolderFile[],
  limits?: Partial<FolderLimits>
): FolderListing {
  const files: FolderFile[] = []
  const skipped: SkippedItem[] = []
  for (const f of all) {
    const dir = dirOf(f)
    // ★ `._foo` 与 `_._foo` 都算（真机上那个是后者）—— 见上面头注。
    //   判据在 `isCompanionName` 一份：重扫退役旧行（I-159）用的是同一把尺。
    if (isCompanionName(f.name)) {
      skipped.push({ name: f.name, dir, why: '拷贝时留下的伴生文件，不是词典' })
      continue
    }
    if (!/\.(mdx|mdd|css)$/i.test(f.name)) {
      skipped.push({ name: f.name, dir, why: '不是词典文件' })
      continue
    }
    files.push(f)
  }
  for (const d of limits?.tooDeep ?? []) {
    skipped.push({
      name: d,
      dir: d,
      why: `目录套得太深（超过 ${limits?.maxDepth ?? '?'} 层），没有进去看`
    })
  }
  for (const d of limits?.unreadable ?? []) {
    skipped.push({ name: d || '（这个夹子）', dir: d, why: '读不了 —— 多半是权限，重选一次夹子' })
  }
  return {
    files,
    skipped,
    incomplete: limits?.truncated
      ? `这个夹子里的东西太多，只看了前 ${limits.maxEntries ?? '?'} 项 —— 词典可能没扫全。`
      : null
  }
}

/** 相对目录 —— 存量清单没有这个字段，一律当顶层（T-5.16） */
const dirOf = (f: FolderFile | undefined): string => f?.dir ?? ''

/** 清单里这本书自己那一条（找伴生文件都从它出发） */
const selfOf = (files: FolderFile[], uri: string): FolderFile | undefined =>
  files.find((f) => f.uri === uri)

/**
 * ★★ T-5.16 · **同一目录里**的伴生文件。三处共用这一个：
 *   ① 发音的音频数字卷（`soundVolumesOf`）② 资源包 .mdd ③ 散在夹子里的 .css
 *
 * 为什么必须限定同目录：递归扫描之后，夹子里会有**同名的书在不同子目录**
 * （使用者那份 Eudic 夹里 Longman 就是这样）。跨目录同名匹配会让一本书拿到
 * 别家的 1.1 GB 数字卷 —— 而且它「找得到音」，所以坏得无声无息。
 * ★ 三处共用一个函数，不是三份写得像的：第四处伴生匹配出现时也走这里。
 * ★ 清单里找不到这本书自己（uri 对不上，书失踪了）→ 一个伴生也不给：
 *   不知道它在哪一层，就没法说谁是它的伴生。宁可素着，也不认错卷。
 */
function sameDir(
  files: FolderFile[],
  self: FolderFile | undefined,
  pick: (f: FolderFile) => boolean
): FolderFile[] {
  if (!self) return []
  return files.filter((f) => f.uri !== self.uri && dirOf(f) === dirOf(self) && pick(f))
}

export interface ScanResult {
  ok: number
  failed: number
  missing: number
  /** 看见了但不当书用的有几项（T-5.16） */
  skipped: number
  /** 库里有几行**本来就不是词典**（I-159；数的是这一趟看下来的全部退役行） */
  retired: number
}

/**
 * 扫描：对文件夹里每个 .mdx 真开一次（读出书名/词数），upsert 进 dictionaries；
 * 不在夹里的旧行标 missing。失败的行留着并写 diagnostic —— 设置页直说，不静默。
 */
export async function scanDictFolder(
  db: Db,
  files: FolderFile[],
  skipped: SkippedItem[] = []
): Promise<ScanResult> {
  const t = Date.now()
  // ★ D-404 资源批：把**整份清单**留在本机 settings —— 词典自带的样式与图标
  //   是夹子里的散文件（oald10.css）或 .mdd 里的条目，而 Assist 引擎没有 SAF
  //   通道（它不在 App 进程里，掏不了插件）。清单是设备面，不跨端。
  await refreshDictFiles(db, files, skipped)
  const mdxFiles = files.filter((f) => /\.mdx$/i.test(f.name))
  let ok = 0
  let failed = 0
  for (const f of mdxFiles) {
    let bookname = f.name.replace(/\.mdx$/i, '')
    let wordCount = 0
    let status = 'ok'
    let diagnostic: string | null = null
    let uid: string | null = null
    try {
      const m = await openMdx(f.uri, f.name)
      // mdx 制作工具的占位标题（"Title (No HTML code allowed)"）不配当书名 ——
      // 剥掉占位；剥空了（或只剩 "Title"）退回文件名（真机 Eudic 夹里 3 本撞到）
      const t = m.title.replace(/\s*\(?no html code allowed\)?\s*/gi, ' ').trim()
      bookname = !t || /^title$/i.test(t) ? f.name.replace(/\.mdx$/i, '') : t
      wordCount = m.wordCount
      // ★ D2.1 · 跨设备身份：dict.default（USER 偏好）存的就是它 ——
      //   路径/文件名/设备都变了还认得出同一本书。原料 = 头里原样的字节（core）
      uid = dictUid(m.identity)
      m.close() // 扫描不留缓存 —— 元数据到手即弃
      ok++
    } catch (e) {
      /**
       * ★ T-5.10 · 原来这里落的是 `e.message` —— 也就是 D-262 骂过的那件事的
       *   Android 版：设置页上直接写异常原文。现在走 core 的 `toDiagnostic`
       *   （话术唯一出处）。core 还没认出来的那些，把词典自己报的那句原话
       *   接在后面 —— `Mdx` 抛的本来就是中文人话（「索引是加密的…」），
       *   丢掉它换成「原因还没认出来」是**更差**的一句真话。
       *   ★ 让 `says` 自己就说清楚，要 core 把 `Mdx` 的 throw 包成
       *     `DictionaryOpenError` —— 那是 core，本轮不动（报告里写了段落）。
       */
      status = 'error'
      const p = problemOf(bookname, e)
      diagnostic = problemLine(p).replace(/^「[^」]*」/, '')
      failed++
    }
    const prior = await db.get(`select id from dictionaries where ifo_path = ?`, [f.uri])
    if (prior) {
      await db.run(
        `update dictionaries set bookname = ?, word_count = ?, missing = 0,
                status = ?, diagnostic = ?, format = 'mdict', uid = coalesce(?, uid),
                probed_at = ?, updated_at = ?
          where id = ?`,
        [bookname, wordCount, status, diagnostic, uid, t, t, Number(prior['id'])]
      )
    } else {
      const mx = await db.get(`select coalesce(max(sort_order), 0) as m from dictionaries`)
      await db.run(
        `insert into dictionaries
           (ifo_path, folder, bookname, word_count, enabled, sort_order, missing,
            format, status, diagnostic, uid, probed_at, updated_at)
         values (?, 'saf', ?, ?, 1, ?, 0, 'mdict', ?, ?, ?, ?, ?)`,
        [f.uri, bookname, wordCount, Number(mx?.['m'] ?? 0) + 1, status, diagnostic, uid, t, t]
      )
    }
  }
  // 文件夹里已经没有的书：标 missing（行不删 —— 排序与开关是使用者的配置）
  const uris = mdxFiles.map((f) => f.uri)
  const rows = await db.all(`select id, ifo_path as u, status from dictionaries`)
  let missing = 0
  let retired = 0
  for (const r of rows) {
    const uri = String(r['u'])
    /**
     * ★★ I-159 · **先分一道：这一行的文件名现在还像不像词典。**
     *
     * 真机（C，2026-09-07）：`_._TLD.mdx` 在旧扫描里闯过扩展名过滤、当书登记了
     * （172 字节，解析失败，`status=error`）。跳过规则补上 `_._` 之后，它不再出现在
     * 文件清单里 —— 于是下面那条「不在清单里 = 失踪」把它标成了失踪，书目里从此挂着
     * 一行「_._TLD · 失踪 · 不在夹里了 —— 重新扫描或放回去」。**那句话是假的**：
     * 它就在夹子里，它只是从来就不是词典。
     *
     * 所以退役先判：文件名命中伴生规则 → `status = notdict` + `missing = 0`，
     * 书目不再列它（`listDicts`），诊断查得到（`listRetiredDicts` + `diagnostic`）。
     * ★ 不删行 —— D-216 只增不删；`enabled` / `sort_order` 也不动，那是他的配置。
     * ★ 幂等：已经退役过的行不再写库（不白抬 `updated_at` 让同步再推一遍），
     *   但仍计入这一趟的 `retired` —— 设置页那句话说的是「这一趟看下来有几行是退役的」。
     */
    if (isCompanionName(fileNameOfUri(uri))) {
      retired++
      if (String(r['status'] ?? '') !== NOT_A_DICT) {
        await db.run(
          `update dictionaries set status = ?, missing = 0, diagnostic = ?, updated_at = ?
            where id = ?`,
          [NOT_A_DICT, RETIRED_WHY, t, Number(r['id'])]
        )
      }
      continue
    }
    if (!uris.includes(uri)) {
      await db.run(`update dictionaries set missing = 1, updated_at = ? where id = ?`, [
        t,
        Number(r['id'])
      ])
      missing++
    }
  }
  dropDictCache() // 文件可能换了 —— 装过的书全放掉，下次查词重开
  return { ok, failed, missing, skipped: skipped.length, retired }
}

// ══ 词典自带资源（D-404④「按词典自己的信息结构显示」的另一半）══
//
// 词条正文是 HTML，可它的样子归**词典自己的 CSS** 管：朗文把词头那一份
// 藏起来的规则就在里头（不加载它，屏幕上会看到「deprecatedeprecate」这种
// 重复片段）。CSS 有两种放法，都要认：
//   ① 散在夹子里（oald10.css 186 KB · thes.css · UD.css —— 实测使用者的夹子）
//   ② 打进 .mdd（朗文6英汉双解.mdd 18 KB 里就是两份 css + 三枚喇叭图标）
// ★ 大卷不开：oald10 的 .mdd 有 4 卷、最大 1.1 GB —— 为一份 css 去建它的
//   索引不划算（它的 css 本来就散在夹子里）。上限 8 MB，超了跳过并如实记。

/** 扫描时留下的文件夹清单（设备面 settings） */
const FILES_KEY = 'dict.files'
/**
 * 上一次列夹子时**跳过了什么**（T-5.16，设备面 settings）。
 * 留下来是为了「进设置页就说得出」—— 不必为了看一眼跳过项去重扫一遍。
 */
const SKIPPED_KEY = 'dict.skipped'

/**
 * ★★ T-5.10 · 这三条上限**是「整本进内存」派生出来的**，不是产品判据。
 *
 * 8 MB 的 `.mdd` 上限原来的理由写在上面那段注释里：「为一份 css 去建
 * 1.1 GB 卷的索引不划算」—— 而不划算的真正原因是**要把它整个 fetch 进内存**。
 * 有了随机读之后这个理由不成立了：开一个卷只读它的索引段。
 * 于是「样式藏在大卷里的书就素着」「插图丢」这两条毛病跟着消失。
 *
 * ★ 没有随机读的那条路（PC 测试 / 通道没挂上）**保持原样** ——
 *   那条路上限就是保命的，去掉会把进程压死。
 */
const mddMax = (): number => (randomIo() ? Number.POSITIVE_INFINITY : 8 * 1024 * 1024)
/** 一条词条最多内联几张图 / 单张多大 */
const imgMax = (): number => (randomIo() ? 60 : 12)
const imgBytes = (): number => (randomIo() ? 512 * 1024 : 64 * 1024)

/**
 * 只更新清单，不重新解析任何一本书（很便宜：一次 SAF 列目录）。
 * App 每次开库顺手做一遍 —— 夹子里的 .css/.mdd 变了也跟得上，
 * 而且使用者不必为了「词典有样式了」专门去点一次重新扫描。
 */
export async function refreshDictFiles(
  db: Db,
  files: FolderFile[],
  skipped?: SkippedItem[]
): Promise<void> {
  const t = Date.now()
  const put = (k: string, v: unknown): Promise<void> =>
    db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [k, JSON.stringify(v), t]
    )
  await put(FILES_KEY, files)
  // ★ 不传就不动它 —— 只刷清单的那条路（App 开库）与扫描那条路都走这一个函数
  if (skipped) await put(SKIPPED_KEY, skipped)
  assetCache.clear()
}

/** 上一次列夹子跳过了哪些（设置页进页面就读，不必重扫）*/
export async function dictSkipped(db: Db): Promise<SkippedItem[]> {
  try {
    const r = await db.get(`select value from settings where key = ?`, [SKIPPED_KEY])
    const v = r?.['value']
    return v ? (JSON.parse(String(v)) as SkippedItem[]) : []
  } catch {
    return []
  }
}

async function folderFiles(db: Db): Promise<FolderFile[]> {
  try {
    const r = await db.get(`select value from settings where key = ?`, [FILES_KEY])
    const v = r?.['value']
    return v ? (JSON.parse(String(v)) as FolderFile[]) : []
  } catch {
    return []
  }
}

/** uri → 装好的资源包（null = 开不了/太大，记住免得每次重试） */
const mddCache = new Map<string, Mdx | null>()

/**
 * 上一次取资源走的哪条路 —— ③ 档验收通道（同 `pronWhy` 的纪律：
 * 结果里带得出去，不靠 logcat）。「样式没出来」到底是没找到 css、
 * 还是卷开不了，得能说出来。
 */
export let assetWhy = ''

async function loadedMdd(f: FolderFile): Promise<Mdx | null> {
  if (mddCache.has(f.uri)) return mddCache.get(f.uri) ?? null
  let m: Mdx | null = null
  if (!f.size || f.size <= mddMax()) {
    try {
      m = await openMdx(f.uri, f.name, true)
    } catch (e) {
      // 坏的资源包不该挡住查词 —— 但也不该无声无息（T-5.10 (b) 的同族）
      m = null
      assetWhy += `${f.name}: ${toDiagnostic(e).says}; `
    }
  } else {
    assetWhy += `${f.name}: 资源包 ${Math.round(f.size / 1048576)} MB，没有随机读通道时不开; `
  }
  mddCache.set(f.uri, m)
  while (mddCache.size > 4) {
    const [oldUri, old] = mddCache.entries().next().value as [string, Mdx | null]
    if (old) old.close()
    mddCache.delete(oldUri)
  }
  return m
}

export interface BookAssets {
  /** 词典自己的样式表（原文；找不到就是 null —— 不编造） */
  css: string | null
  /** 资源名 → data: URI。★ 跨词条**累积**：每条词条把自己的图补进来 */
  images: Record<string, string>
  /** 找样式表那一趟的账（缓存命中时也要说得出来，否则第二条词条起就没人报了） */
  cssWhy: string
}

/**
 * 每本书的**样式表**只解析一次（css 几十～两百 KB，别每次查词重解）。
 *
 * ★★ 2026-09-13 · 这里曾经藏着「插图出不来」那个 bug：
 *   缓存整份按**书**存，`if (hit) return hit` 把 `html` 参数完全忽略 ——
 *   可 `images` 是按**词条**找的（扫的是这条词条里的 `<img src>`）。
 *   于是一本书里你查的**第一条**词条决定了哪些图被内联，
 *   之后每条词条自己的插图全变成破图框。
 *   真机实据（LDOCE5 · 先查 resilient 再查 bicycle）：6 张图里 5 张是
 *   前一条词条留下的喇叭图标，唯独 `bicycle.jpg` 原样留着 ——
 *   而探针证明它就在那本 1.07 GB 的 .mdd 里、只有 50 KB，取得出来。
 *   ☞ 现在：css 仍按书缓存，**图每条词条都补一次**（已有的不重取）。
 */
const assetCache = new Map<number, BookAssets>()

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function bytesToText(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b)
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

/** 整个文件读进来（散文件用；io 端口有就走随机读的那条） */
async function wholeFile(f: FolderFile): Promise<Uint8Array> {
  if (ioProvider) {
    const io = ioProvider(f.uri, f.name)
    const h = io.open(f.name)
    try {
      return io.read(h, 0, h.size)
    } finally {
      io.close(h)
    }
  }
  return bytesProvider(f.uri)
}

/**
 * 这本书的样式表与小图标。
 * 找法按可靠度排：**词条自己 `<link>` 的那个名字**最准（oald10-V1_4.mdx
 * 链的是 oald10.css —— 靠文件名相似猜是猜不中的），其次同名 .css，
 * 最后才在同名 .mdd 里找任意一份 .css。
 */
async function bookAssets(db: Db, dict: DictRow, html: string): Promise<BookAssets> {
  const hit = assetCache.get(dict.id)
  if (hit) {
    /**
     * ★★ 命中的是**样式表**那一半 —— 图还得按这条词条再补一次。
     *   以前这里直接 `return hit`，那正是「一本书只有第一条词条的图能出来」的根因。
     *   `addEntryImages` 只取 `images` 里还没有的，所以重复的喇叭图标不会重取。
     */
    assetWhy = hit.cssWhy
    await addEntryImages(db, dict, html, hit)
    return hit
  }
  assetWhy = ''
  const out: BookAssets = { css: null, images: {}, cssWhy: '' }
  try {
    const files = await folderFiles(db)
    const self = selfOf(files, dict.uri)
    const base = baseName(self?.name ?? dict.bookname).toLowerCase()
    // ★ T-5.16 · 资源包也限定同一目录（同一条理由，同一个 sameDir）
    const mdds = sameDir(
      files,
      self,
      (f) => /\.mdd$/i.test(f.name) && baseName(f.name).toLowerCase().startsWith(base)
    )
    // ① 词条里 <link href="…css">
    const linked: string[] = []
    for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/gi)) linked.push(m[1]!)
    const wanted = [...linked, `${base}.css`]
    /**
     * ★★ T-5.10 · 原来这里是「找到第一份就 break」。
     *   词条 `<link>` 了两份（thes.css + UD.css 这种）时，第二份永远不加载，
     *   而 CSS 是**互补**的：少一份就是半套排版。现在按顺序**全部收下**、
     *   按 `<link>` 的先后拼起来（层叠顺序 = 词典自己写的顺序）。
     *   去重靠 seen —— 同一份被 link 两次不该拼两遍。
     */
    const sheets: string[] = []
    const seen = new Set<string>()
    for (const name of wanted) {
      const plain = name.split(/[\/]/).pop()!.toLowerCase()
      if (seen.has(plain)) continue
      seen.add(plain)
      // ★ T-5.16 · 散样式表也限定同一目录 —— 否则子目录里的书会去顶层捡 oald10.css
      const loose = sameDir(files, self, (f) => f.name.toLowerCase() === plain)[0]
      if (loose) {
        try {
          sheets.push(bytesToText(await wholeFile(loose)))
        } catch (e) {
          assetWhy += `${plain}: ${toDiagnostic(e).says}; `
        }
        continue
      }
      const key = normalizeResourceKey(name)
      for (const f of mdds) {
        const m = await loadedMdd(f)
        const bytes = m?.bytesOf(key)
        if (bytes) {
          sheets.push(bytesToText(bytes))
          break
        }
      }
    }
    // ② 一份都没指名 → 资源包里任意一份 .css（朗文6 就是这种）
    if (sheets.length === 0) {
      for (const f of mdds) {
        const m = await loadedMdd(f)
        if (!m) continue
        const k = [...m.keys()].find((x) => x.endsWith('.css'))
        const bytes = k ? m.bytesOf(k) : null
        if (bytes) {
          sheets.push(bytesToText(bytes))
          break
        }
      }
    }
    out.css = sheets.length > 0 ? sheets.join('\n') : null
    if (!out.css) out.cssWhy += `${dict.bookname}: 没找到自带样式表; `
    assetWhy += out.cssWhy
  } catch (e) {
    // 资源找不到不该影响词条本身 —— 正文照出，只是素一点。
    // ★ 但「素一点」的原因要说得出来（assetWhy），不再是纯静默。
    assetWhy += `${dict.bookname}: ${toDiagnostic(e).says}; `
  }
  await addEntryImages(db, dict, html, out)
  assetCache.set(dict.id, out)
  return out
}

/**
 * 把**这一条词条**里还没内联过的 `<img>` 补进 `out.images`。
 *
 * ══ 为什么它必须按词条做 ════════════════════════════════════
 * 图是从词条 HTML 里扫出来的（`<img src="bicycle.jpg">`），而词条每次都不一样。
 * 以前它长在 `bookAssets` 的缓存分支**里面**，于是一本书只有第一条词条被扫过 ——
 * 之后每条词条自己的插图都是破图框（2026-09-13 使用者报的那条）。
 *
 * ══ 为什么仍然共用一张表 ════════════════════════════════════
 * 喇叭图标这类每条词条都出现的小图，取一次就够；`out.images[ref]` 已经有的跳过。
 * 表跟着书活，图跟着词条补 —— 两件事各按各的周期。
 *
 * ★ 取不到的**要说出来**（`assetWhy`）：以前这里静默跳过，
 *   于是屏上是个破图框、账上一个字都没有。我查这条 bug 时正是因为它不说话，
 *   才不得不写探针去问那本 1 GB 的 .mdd（`\bicycle.jpg` 就在里面，50 KB）。
 */
async function addEntryImages(
  db: Db,
  dict: DictRow,
  html: string,
  out: BookAssets
): Promise<void> {
  /** 这一条词条新补了几张 —— 上限按**词条**算，不跟着累积表长 */
  let n = 0
  try {
    const files = await folderFiles(db)
    const self = selfOf(files, dict.uri)
    const base = baseName(self?.name ?? dict.bookname).toLowerCase()
    let mdds: FolderFile[] | null = null
    for (const m0 of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      if (n >= imgMax()) {
        assetWhy += `这条词典条目的图超过 ${imgMax()} 张，后面的没取; `
        break
      }
      const ref = m0[1]!
      if (/^(data|https?):/i.test(ref) || out.images[ref]) continue
      // ★ 有图要取才列目录 —— 没图的词条不该为此多跑一次 SAF
      mdds ??= sameDir(
        files,
        self,
        (f) => /\.mdd$/i.test(f.name) && baseName(f.name).toLowerCase().startsWith(base)
      )
      const key = normalizeResourceKey(ref)
      /** 找到了但太大 —— 和「压根没有」是两回事，说法要分开 */
      let tooBig = 0
      for (const f of mdds) {
        const m = await loadedMdd(f)
        const bytes = m?.bytesOf(key)
        if (!bytes) continue
        if (bytes.length > imgBytes()) {
          tooBig = bytes.length
          continue
        }
        /**
         * ★ 片段里留着原文件名（真机 2026-08-30 撞的坑）：
         * 朗文那份 CSS 是用 **属性选择器** 给图标定尺寸的 ——
         *   `img[src*="spkr_"]{max-height:1em}`
         * 把 src 换成 data: 之后这条规则就不匹配了，200×200 的喇叭
         * 直接铺满卡片。data URI 的 `#片段` 浏览器会忽略，但它留在
         * 属性值里 —— 词典自己的规则照样命中。
         */
        const tail = ref.replace(/[#"']/g, '')
        out.images[ref] = `data:${dictMimeOf(key) ?? 'image/png'};base64,${b64(bytes)}#${tail}`
        n++
        tooBig = 0
        break
      }
      if (!out.images[ref]) {
        assetWhy +=
          tooBig > 0
            ? `${ref}: ${Math.round(tooBig / 1024)} KB，超过单张上限 ${Math.round(imgBytes() / 1024)} KB; `
            : `${ref}: 资源包里没有这个键; `
      }
    }
  } catch (e) {
    // 图取不出来不该影响词条本身 —— 正文照出，只是素一点。原因要说得出来。
    assetWhy += `${dict.bookname} 取图: ${toDiagnostic(e).says}; `
  }
}

export interface DictHit {
  book: string
  /** 压平正文（无 HTML 时的兜底显示） */
  text: string
  /** ★ D-404⑤ · 词条原始 HTML —— 词典自己的信息结构就在标签里，界面照它渲染 */
  html?: string
  /** 词典自己的样式表（那份结构长什么样归它管；没有就是 null，不编造） */
  css?: string
}

const CLIP = 1600
/** 原始 HTML 的上限：词典大条目能到几十 KB，气泡卡片里没必要全塞 */
const HTML_CLIP = 40_000
/**
 * Lookup Tab 是全条显示（D-151 单本卡），上限放到 1MB：朗文最大的功能词
 * （use 432KB）装得下，词条内「verb|noun」这类同页锚点跳转才不落空。
 * 超过的按理不存在 —— 真撞到就是尾部被裁，方框链可能跳空，如实接受。
 */
const LOOKUP_HTML_CLIP = 1_000_000

// ── 词条链接活化（阶段 7 第一件 —— 「方框链点了没反应」的修法）─────
//
// 真机 .mdx 实探（2026-08-31 · use/happy/satisfied）：朗文的链接只有三种：
//   entry://#锚点          同页跳（use 头上的 verb|noun 切换；锚点元素成对存在）
//   entry://词#锚点        跨词条跳（THESAURUS 方框 → satisfied#…_s5；词是 URL 编码）
//   sound://路径.mp3       音频（词头 hwd/… 与例句 exa/…，键在同名数字卷里）
// 死因不在词典：浏览器/WebView 不认识 entry:// 协议，点了就被当哑弹丢掉。
// 修法 = 判据在这里（解析 + 剥脚本），两个渲染面各接一个拦截器。

/**
 * 词条里的 <script> 全剥掉。两个渲染面现在都要跑**我们的**小脚本
 * （锚点滚动/链接拦截），JS 一开词典自带脚本也会活 —— D-404⑤ 「不跑脚本」
 * 的承诺从「关 JS」改成「剥脚本」，语义不变（它们此前也从没执行过）。
 */
export function stripDictScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
}

/**
 * 词典弹层方框的最小恢复（真机 2026-08-31 实探）：朗文的 Examples/Collocations/
 * Word family 这些黄框是 `<span class="popup-button" onclick="….showAtLink(this)">`
 * —— 靠词典自带 JS 弹层，而那份 JS 被剥掉了（该剥：来路不明的代码不进服务进程）。
 * 弹层**内容**其实就躺在相邻的 `.at-link` div 里 —— 这段是**我们写的**开关：
 * 点按钮就地展开/收起，不悬浮、不跑词典一行代码。附在词条 HTML 尾部，
 * 气泡 WebView 与 Lookup iframe 同一份。
 */
const WIDGET_JS =
  '<script>(function(){function has(n,c){return (" "+(n.getAttribute("class")||"")+" ").indexOf(" "+c+" ")>=0}' +
  'document.addEventListener("click",function(e){' +
  'var t=e.target;while(t&&t.nodeType===1&&!has(t,"popup-button"))t=t.parentNode;' +
  'if(!t||t.nodeType!==1)return;var d=t.nextElementSibling;' +
  'if(d&&has(d,"at-link")){d.style.display=d.style.display==="block"?"none":"block"}' +
  '},true)})()</script>'

/** entry:// 解析。word=null 表示同页（entry://#锚点）；不是 entry:// 给 null */
export function parseEntryLink(href: string): { word: string | null; anchor: string | null } | null {
  if (!href.startsWith('entry://')) return null
  const rest = href.slice('entry://'.length)
  const i = rest.indexOf('#')
  let w = i < 0 ? rest : rest.slice(0, i)
  const anchor = i < 0 ? null : rest.slice(i + 1) || null
  try {
    w = decodeURIComponent(w)
  } catch {
    /* 编码坏了就按原样 —— 查不到会如实说没命中 */
  }
  w = w.replace(/\/+$/, '').trim()
  return { word: w || null, anchor }
}

/**
 * 逐本查（enabled 且没失踪且 status=ok，按 sort_order）——
 * 命中就收；给气泡最多前两本，词条正文超长裁到 CLIP 并明说。
 */

// ── 发音音频卷（D-406④ · 指令十二「Dictionary 音频优先」）────────
//
// ★★ 键从**词条 HTML 里的 sound:// 链接**拿，不从文件名正推 —— 真机实探过
//   文件名语法根本没法穷举：`flexible0205`（变体号）、`use_v0205`（词性后缀）、
//   `l3use` / `ld41serendipity` / `ld44used` / `laad3vodcast`（四种年代前缀）。
//   词条链接是逐词精确的（第一条 hwd/bre + 第一条 hwd/ame 就是词头发音），
//   而且不用扫 18 万键建表 —— 音频卷只开索引，bytesOf 按需读命中块。
// ★ 音频卷 = 与书同名的数字卷（朗文6英汉双解.mdx ↔ 朗文6英汉双解.1.mdd）。
// ★ 只在引擎侧开（ioProvider = 原生真随机读）；App 侧 bytesProvider 是整本
//   进内存，1.3GB 会压死进程 —— 没有随机读就直接说没有。

/** 上一次发音查找的路径说明 —— ③ 档验收通道（结果里带出去，不靠 logcat） */
export let pronWhy = ''

/**
 * ★★ I-165 · 上一次发音查找里，**看见了、但浏览器放不响**的那几条链接（`.spx` 那一类）。
 *
 * 为什么要单记一份：`VoiceStep` 的契约是「拿到了给值，没拿到给 null」——
 * miss 里没有位置放理由，于是账本只能说通用的那句「这本词典里没有这个词的发音」。
 * 而这一种 miss 说成「没有这个词的发音」是**假话**：词条**有**发音，只是放不出来。
 * 他会去换一个词，而真正该做的是换一本词典。
 *
 * ★ 空数组 = 这一趟没遇到放不响的（`runVoice` 就不递更具体的说法，用 core 的通用那句）。
 * ★ 与 `pronWhy` / `pronStats` 同一个套路：只记账，不参与任何判断。
 */
export let pronUnplayable: string[] = []

/**
 * 上一次发音查找的**账**（T-6.5 · ③ 档验收通道，与 `pronWhy` 同一个套路）。
 *
 * 它答的是审计要问的两句（主控读码列的怀疑点 ①②）：
 *   ① 出声之前**扫了几本**书（`books`）—— App 侧 `speak()` 根本不查词典，
 *      Assist 这一条却要逐本开索引、读词条、找 `sound://`
 *   ② 其中**几本是现开的**（`opened`）—— 装好的书只驻 `MDX_CACHE_MAX` 本，
 *      启用得多了就每次逐出重开（= 索引重建），那是最贵的一步
 *
 * ★ 只是计数与毫秒，**不参与任何判断**：删掉它 `dictPronounce` 的行为一模一样。
 */
export interface PronStats {
  /** 真的会去问的有几本（T-6.6 起 = **有音频卷的**那些，不是全部启用的） */
  books: number
  /** 其中现开的几本（缓存没命中 = 索引重建） */
  opened: number
  /** 没问的有几本：没有音频卷的 + 过了预算没轮到的（T-6.6） */
  skipped: number
  /** 开了几个音频卷 */
  vols: number
  /** 这一趟总共多少毫秒 */
  ms: number
  /** 命中在第几本（1 起；没命中 = 0） */
  hitAt: number
  /** 是不是被预算掐断的（T-6.6）—— 真的就说真的，不假装自己找过了 */
  deadlineHit: boolean
}
export let pronStats: PronStats = {
  books: 0,
  opened: 0,
  skipped: 0,
  vols: 0,
  ms: 0,
  hitAt: 0,
  deadlineHit: false
}

/**
 * ★★ T-6.6 · 发音要问哪几本、按什么顺序问。
 *
 * ── 只问「可能有音频」的书（这是 T-7.5 / T-6.6 说的「标了 audio 能力的书」）──
 *
 * 那个「标记」不需要新加一列，也不需要开书 —— **它就是同名数字卷在不在**
 * （`朗文6.mdx` ↔ `朗文6.1.mdd`），`soundVolumesOf` 只看文件名。
 * 而原来的循环是**先开书读词条、再看有没有卷**：没有音频卷的书照样被整本开一遍
 * 索引。真机上他启用 15 本，其中大多数没有音频卷 —— 那些索引重建**一次都不必发生**。
 * ★ 语义没变：没有卷的书原来走到 `vols.length === 0` 也是 `continue`，
 *   现在只是**在开书之前**就知道了。
 *
 * ── 顺序：默认书排头 ────────────────────────────────────────
 *
 * 命中最可能发生在默认书上（他自己选的那本）。排头 = 命中那一趟只开一本，
 * 而且它会被 `pinnedUri` 钉住不被逐出（`MDX_CACHE_MAX` 只有 2，他启用 15 本，
 * 不钉的话下一次又是冷开）。其余按已有的 `sort_order`（= 查词命中顺序，D-361）。
 */
export function pronounceOrder(
  rows: DictRow[],
  files: FolderFile[],
  defaultUid: string | null
): DictRow[] {
  const withAudio = rows.filter((d) => soundVolumesOf(d, files).length > 0)
  const i = defaultUid ? withAudio.findIndex((d) => d.uid === defaultUid) : -1
  if (i <= 0) return withAudio
  return [withAudio[i]!, ...withAudio.slice(0, i), ...withAudio.slice(i + 1)]
}

/**
 * 「这一趟要问哪几本、按什么顺序」—— 从库里取事实，交给 `pronounceOrder` 排。
 *
 * ★★ T-6.6 第二段 · 这三行只有一份：`dictPronounce` 与 `prewarmPronounce`
 *   **必须问同一句话**。预热开的那一本要正好是发音会先问的那一本，
 *   否则预热就是白开一本书 —— 而两边各抄一遍时，这种漂是不会报错的。
 */
async function pronounceBooks(
  db: Db
): Promise<{ rows: DictRow[]; all: DictRow[]; files: FolderFile[] }> {
  const files = await folderFiles(db)
  const all = (await listDicts(db)).filter((d) => d.enabled && !d.missing && d.status === 'ok')
  return { rows: pronounceOrder(all, files, await prefRaw(db, 'dict.default')), all, files }
}

/**
 * 钉住不许逐出的那一本（默认词典的索引）。`MDX_CACHE_MAX` 是 2 而他启用 15 本，
 * 不钉的话默认书每隔一两次查询就被挤掉，下一次发音又要冷开一遍（T-6.6）。
 * ★ 只钉一本：随机读之后 `Mdx` 常驻的是索引不是正文（T-5.10），一本很便宜；
 *   钉多了就等于把上限偷偷改大，那要另说。
 */
let pinnedUri: string | null = null
export function pinDictionary(uri: string | null): void {
  pinnedUri = uri
}

/** 装好的书最多驻几本 —— 与下面 `loadedMdx` 的逐出上限同一个数，别各写各的 */
export const MDX_CACHE_MAX = 2

/** 词条 HTML 里的词头发音链接（sound://hwd/…）。返回 [bre 的, ame 的]（没有就 null） */
export function hwdSoundLinks(html: string): { bre: string | null; ame: string | null } {
  let bre: string | null = null
  let ame: string | null = null
  for (const m of html.matchAll(/sound:\/\/([^"'<>\s)]+)/g)) {
    const path = m[1]!
    if (!path.startsWith('hwd/')) continue
    if (bre === null && /(^|[/_])bre([/_.]|$)/.test(path)) bre = path
    else if (ame === null && /(^|[/_])ame([/_.]|$)/.test(path)) ame = path
    if (bre && ame) break
  }
  return { bre, ame }
}

/**
 * ★ I-165 · 两条链接里，**浏览器放得响**的留下；放不响的挡掉并记一笔。
 *
 * 判据在 core（`isPlayableAudioExt`，`core/dict/capability.ts`）——
 * 这一端不另列一张扩展名表：同一件事两份判据，是这个项目付过学费的那类病。
 * ★ 挡掉的记进 `pronUnplayable`，那一趟的 miss 才说得出真话。
 */
export function playableLinks(links: { bre: string | null; ame: string | null }): {
  bre: string | null
  ame: string | null
} {
  const keep = (l: string | null): string | null => {
    if (!l) return null
    if (isPlayableAudioExt(dictExtensionOf(l))) return l
    pronUnplayable.push(l)
    return null
  }
  return { bre: keep(links.bre), ame: keep(links.ame) }
}

/** 这本书的音频数字卷（朗文6英汉双解.mdx ↔ 朗文6英汉双解.1.mdd …） */
function soundVolumesOf(d: DictRow, files: FolderFile[]): FolderFile[] {
  const self = selfOf(files, d.uri)
  const prefix = self ? self.name.replace(/\.mdx$/i, '') : ''
  // ★ T-5.16 · **同一目录**（见 sameDir 的头注：跨目录同名会拿到别家 1.1 GB 的卷）
  return sameDir(
    files,
    self,
    (f) => f.name.startsWith(prefix + '.') && /\.(\d+\.)?mdd$/i.test(f.name)
  )
}

/** 音频卷缓存：uri → 开好的卷（null = 开不了，记住别重试） */
const pronVolCache = new Map<string, Mdx | null>()

async function openVolume(uri: string, name: string): Promise<Mdx | null> {
  if (pronVolCache.has(uri)) return pronVolCache.get(uri) ?? null
  let m: Mdx | null = null
  try {
    m = await openMdx(uri, name, true)
  } catch (e) {
    pronWhy += `${name}: ${(e as Error)?.message ?? e}; `
  }
  pronVolCache.set(uri, m)
  return m
}

/**
 * 词典真人发音。流程：词条 HTML → sound://hwd 链接（按口音挑）→ 同名数字卷
 * bytesOf。要的口音没有就给另一边 —— 真人音再错口音也比合成音强；都没有 = null。
 */
export async function dictPronounce(
  db: Db,
  term: string,
  wantAme: boolean,
  o: { budgetMs?: number } = {}
): Promise<{ b64: string; accent: 'bre' | 'ame'; key: string } | null> {
  pronWhy = ''
  pronUnplayable = []
  // ★ T-6.5 · 这一趟的账（只计数，不参与任何判断）
  const t0 = Date.now()
  pronStats = { books: 0, opened: 0, skipped: 0, vols: 0, ms: 0, hitAt: 0, deadlineHit: false }
  const done = <T,>(v: T): T => {
    pronStats.ms = Date.now() - t0
    return v
  }
  /**
   * ★★ T-6.6 · **截止时刻就是这一行存在的理由。**
   *
   * `runVoicePlan` 用 `Promise.race` 掍预算，而 `DictionaryIO.read`
   * （`nyxHost.dictRead`）是**同步** JS→Java 调用 —— 同步循环不让出事件循环，
   * 那个 `setTimeout` 永远没机会触发。真机上「最多多等 150 ms」实测 **53.4 秒**（C，2026-09-06）。
   *
   * 同步 IO 唯一的让出点是**两本书之间**，所以预算只能在这里自己看表：
   * 每开一本**之前**先问一句过线了没有。过了就停，当 miss 回，并把
   * `deadlineHit` 与 `skipped` 写清楚 —— **不假装自己找过了。**
   * ★ 预算判据仍然在 core（`attempt.budgetMs`），这里只是**让它真能生效**。
   * ★ 不传 `budgetMs` = 没有截止时刻（Lookup 那条路与以前一模一样）。
   */
  const deadline = typeof o.budgetMs === 'number' ? t0 + o.budgetMs : null
  const overtime = (): boolean => deadline !== null && Date.now() >= deadline

  if (!ioProvider) {
    pronWhy = 'no ioProvider'
    return done(null)
  }
  const { rows, all, files } = await pronounceBooks(db)
  pronStats.books = rows.length
  // 没有音频卷的那些一本都不开 —— 它们原来也是 continue，只是白开了一遍索引
  pronStats.skipped = all.length - rows.length
  // 排头那本（默认书，或第一本有音频的）钉住：每次发音都先问它，别让它被逐出
  pinDictionary(rows[0]?.uri ?? null)
  let nth = 0
  for (const d of rows) {
    nth += 1
    /**
     * ★★ T-6.6 · 开书**之前**看表。摆在循环顶上而不是底下：
     *   开一本就是一次索引重建（真机上平均 3.5 秒/本），开完再发现超时就晚了一整本。
     */
    if (overtime()) {
      pronStats.deadlineHit = true
      pronStats.skipped += rows.length - nth + 1
      pronWhy += `超过 ${o.budgetMs} ms 预算，剩下 ${rows.length - nth + 1} 本没再开; `
      return done(null)
    }
    let links: { bre: string | null; ame: string | null }
    try {
      const m = await loadedMdx(d.uri, d.bookname, d.uri === pinnedUri)
      if (lastMdxOpened) pronStats.opened += 1
      const raw = readEntry(m, term)
      if (!raw) continue
      links = hwdSoundLinks(raw)
      if (!links.bre && !links.ame) continue
      /**
       * ★★★ I-165 · **先挡放不响的，再挑口音** —— 顺序不能反。
       *
       * 反了就会「挑中一条英音的 `.spx`」，然后在渲染层静悄悄地失败：
       * 账本记词典命中、界面弹「这段音频放不出来」，两句话对不上。
       * ★ 判据借词典层那把尺（core `isPlayableAudioExt`），这一端不另列扩展名表。
       * ★ 挡掉的**记下来**（`pronUnplayable`）：这一趟要说的是「这本的音是 .spx」，
       *   不是「这个词没有发音」。
       */
      links = playableLinks(links)
      if (!links.bre && !links.ame) continue
    } catch {
      continue // 这本书读不了不该挡下一本
    }
    const vols = soundVolumesOf(d, files)
    pronStats.vols += vols.length
    const order: ('bre' | 'ame')[] = wantAme ? ['ame', 'bre'] : ['bre', 'ame']
    for (const acc of order) {
      const link = links[acc]
      if (!link) continue
      /**
       * ★★ 2026-09-13 · 这里原来是手搞的键，和 `normalizeResourceKey` 干同一件事，
       *   却漏了**转小写** —— 而词条 HTML 里写的是 `sound://GB_….spx`（大写），
       *   .mdd 里存的键是小写（探针列过），于是永远查不中。
       *   「同一件事两份判据」是这个项目一再付学费的那一类；图那条路一直用 core
       *   那一份，所以图是好的、音是坏的 —— 差别就在这一行。
       */
      const key = normalizeResourceKey(link)
      for (const v of vols) {
        const vol = await openVolume(v.uri, v.name)
        if (!vol) continue
        try {
          const bytes = vol.bytesOf(key)
          if (bytes && bytes.length > 0) {
            pronWhy = `${d.bookname} ${acc} ${link}`
            pronStats.hitAt = nth
            /**
             * ★ 带上 `key`（就是这条链接）—— **mime 由它算**（core 的 `dictMimeOf`）。
             *   以前调用方写死 `audio/mpeg`：`.ogg` 那种被贴上 mp3 的标签，
             *   放不放得响全看浏览器肯不肯猜。
             */
            return done({ b64: b64of(bytes), accent: acc, key: link })
          }
        } catch (e) {
          pronWhy += `${v.name} bytesOf: ${(e as Error)?.message ?? e}; `
        }
      }
      pronWhy += `; ${acc} '${link}' 卷里没有`
    }
  }
  return done(null)
}

/** 预热的结果（`null` = 没什么可预热的）。只给探针看，不参与任何判断 */
export interface PrewarmResult {
  /** 预热的是哪一本 */
  book: string
  /**
   * 这一次是**真的去开了文件**（`false` = 它本来就在缓存里，这趟只负责钉住）。
   * ★ 探针把这两种印成不同的词（`opened=true` / `cached=true`）——
   *   真机上 `opened=false` 让人猜了一轮（2026-09-07），见 `prewarmPronounce` 头注。
   */
  opened: boolean
  ms: number
  /** 开不出来时那句人话 —— 预热失败绝不许影响任何别的事 */
  err: string | null
}

/**
 * ★★ T-6.6 第二段 · **把「发音会先问的那一本」提前开好。**
 *
 * ── 为什么还需要它 ────────────────────────────────────────
 * 第一段（每开一本先看表）让未命中不再是 53 秒，但**代价仍是一本冷开**
 * （真机约 3.5 秒/本）—— 预算第一次看表是在开第一本**之前**，那一本无论如何要开。
 * 而完成标准写的是「与 A 组的 TTFA 差 ≤ 200 ms」。索引一旦在缓存里就不必重建
 * （它被 `pinnedUri` 钉住不逐出），所以只要这一本是**在他等答复之外的时刻**开的，
 * 那 3.5 秒就不落在他的表上。什么时刻算「之外」是调用方的事，见 `engine/main.ts`。
 *
 * ── 只开一本，而且只在它有音频卷时 ────────────────────────────
 * 开的正是 `pronounceBooks` 排头那一本（判据一份，见上）。一本都排不出来
 * （没有一本带同名数字卷）就**什么都不做** —— 没有音频卷的书预热了也永远发不出音。
 *
 * ── 它不碰账 ─────────────────────────────────────────────
 * 不写 `pronStats` / `pronWhy`：那两样记的是「上一次发音」，预热掺进去会把真机
 * 那张表读歪。预热自己的数从返回值走（原生写成一行 `dict prewarm …`）。
 * ★ 失败只是「没预热成」—— 吞掉并如实带回 `err`，绝不许冒泡打断调它的那条路。
 *
 * ── `opened === false` 是什么意思（真机 2026-09-07 读出来的那一行）★★ ──
 *
 * 真机上那一行是 `dict prewarm 牛津高阶（第10版 英汉双解） V1.4 opened=false 15ms`。
 * `opened` 记的是**这一次有没有真去开文件**（`lastMdxOpened`）——
 * `false` + 没有 `err` + 只花 15 ms，只可能是**它已经在缓存里了**：
 * 这一趟预热什么都没开，只做了「钉住」那一件事（而钉住本身正是 VF-7 守的）。
 *
 * 谁能在预热之前把它开进缓存？全仓只有三处调 `loadedMdx`，除去预热自己还剩两处：
 *   · `hitOf`         —— **`dict` 那一档查词**（气泡上的「词典」页）
 *   · `dictPronounce` —— 之前已经发过一次音
 * ★ 注意**不包括气泡默认那一次查词**：选区落定后原生发的是 `lookup quick`，
 *   而 `quick` / `full` / `search` 三档都只走 AI（`assistLookup` 里 `kind === 'dict'`
 *   才进 `dictLookup`）—— 一本词典都不开。所以正常那条路上，预热该报 `opened=true`；
 *   报 `false` 说明这台引擎在此之前已经查过词典页或发过音了。
 */
export async function prewarmPronounce(db: Db): Promise<PrewarmResult | null> {
  const t0 = Date.now()
  // 没有随机读就不预热：App 那侧是整本进内存（T-5.10），1.3 GB 会压死进程
  if (!ioProvider) return null
  let book = '?'
  try {
    const first = (await pronounceBooks(db)).rows[0]
    if (!first) return null
    book = first.bookname
    // 先钉再开：`loadedMdx` 的 pin 只在**没命中缓存**那一支生效，而这里要的是
    // 「不论它现在在不在缓存里，从此都别逐它」
    pinDictionary(first.uri)
    await loadedMdx(first.uri, first.bookname, true)
    return { book, opened: lastMdxOpened, ms: Date.now() - t0, err: null }
  } catch (e) {
    return { book, opened: false, ms: Date.now() - t0, err: (e as Error)?.message ?? String(e) }
  }
}

/**
 * 词条里任意一条 sound:// 音频（例句 exa/… 与词头 hwd/… 都走这条）——
 * 逐本启用书的数字卷找键。与 dictPronounce 同一条底路，只是键直接来自
 * 使用者点的那条链接。只在引擎侧可用（随机读）；App 侧如实说播不了。
 */
export async function dictSoundBytes(db: Db, path: string): Promise<string | null> {
  pronWhy = ''
  if (!ioProvider) {
    pronWhy = 'no ioProvider'
    return null
  }
  const files = await folderFiles(db)
  const rows = (await listDicts(db)).filter((d) => d.enabled && !d.missing && d.status === 'ok')
  // ★ 同上（2026-09-13）：判据只用 core 那一份
  const key = normalizeResourceKey(path)
  for (const d of rows) {
    for (const v of soundVolumesOf(d, files)) {
      const vol = await openVolume(v.uri, v.name)
      if (!vol) continue
      try {
        const bytes = vol.bytesOf(key)
        if (bytes && bytes.length > 0) {
          pronWhy = `${v.name} ${key}`
          return b64of(bytes)
        }
      } catch (e) {
        pronWhy += `${v.name} bytesOf: ${(e as Error)?.message ?? e}; `
      }
    }
  }
  pronWhy += `; '${key}' 哪本的卷里都没有`
  return null
}

/** 大块字节 → base64（WebView 有 btoa；分片免得爆调用栈） */
export function b64of(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(bin)
}

/**
 * 一本书查一条（含 @@@LINK 跟随 + 自带 CSS/图标内联 + 剥脚本）。
 *
 * ★★★ T-5.10 · 返回 `null` 只有一个意思：**这本里确实没有这个词。**
 *   读不了（大书装不下 / 权限丢了 / 文件被挪走 / 索引解不开）**一律抛**，
 *   由调用方转成一条 core 的诊断说给使用者听。
 *
 * ── 在这之前是什么样 ★ ──────────────────────────────────────
 *   这里包着一个 `catch { return null }`，注释写着「跳过，不挡别的书；
 *   扫描时会把话说清」。两个前提都不成立：
 *     · 扫描当时能开、查词时开不了（App 侧整本进内存，大书就是这样）——
 *       那句「扫描时会把话说清」永远不会发生；
 *     · 于是屏幕上写的是**「这本里没有」**，而真相是「这本读不了」。
 *   使用者报的「词典显示不出来、也不说为什么」就是这一行。
 */
async function hitOf(db: Db, d: DictRow, term: string, clip = HTML_CLIP): Promise<DictHit | null> {
  const m = await loadedMdx(d.uri, d.bookname)
  const raw = readEntry(m, term)
  if (!raw || !raw.trim()) return null
  const t = mdxToText(raw)
  const clipped = t.length > CLIP ? `${t.slice(0, CLIP).trimEnd()}\n…（词典条目太长，后略）` : t
  // 先剥脚本再裁（裁到 <script> 中间会让剥离落空）；尾部附我们的部件开关
  let html = stripDictScripts(raw).slice(0, clip) + WIDGET_JS
  const a = await bookAssets(db, d, html)
  // 图标换成 data:（喇叭那三枚）；换不到的原样留着，浏览器空着不炸
  for (const [ref, uri] of Object.entries(a.images)) html = html.split(ref).join(uri)
  return { book: d.bookname, text: clipped, html, ...(a.css ? { css: a.css } : {}) }
}

/**
 * 一本书用不了的**真相**。话术不在这儿拼 —— `says` 逐字来自
 * `core/dict/diagnostics.ts`（那个文件头写着「renderer 一个字都不许自己拼」）。
 */
export interface DictProblem {
  book: string
  /** 给他看的一句话（core 的话术） */
  says: string
  status: DictionaryStatus
  /**
   * core 认出这是哪一种失败了吗。
   * `false` = 走的是 `fromUnknownError` 兜底（says 只会说「原因还没认出来」）——
   * 这时候把 `detail` 也摆出来才算说了真话：`Mdx` 抛的本来就是中文人话
   * （「这本词典的索引是加密的…」），只是没包成 `DictionaryOpenError`。
   */
  recognized: boolean
  /** 原始异常（core 说它是给我看的；只在 recognized=false 时才上屏） */
  detail?: string
}

function problemOf(book: string, e: unknown): DictProblem {
  const g = toDiagnostic(e)
  return {
    book,
    says: g.says,
    status: g.status,
    recognized: e instanceof DictionaryOpenError,
    ...(g.detail ? { detail: g.detail } : {})
  }
}

/** 一条给界面直接用的话（recognized=false 时补上词典自己报的原话） */
export function problemLine(p: DictProblem): string {
  return p.recognized || !p.detail
    ? `「${p.book}」${p.says}`
    : `「${p.book}」${p.says}（词典报的原话：${p.detail.split('\n')[0]}）`
}

/**
 * 上一次 `lookupDicts` 里读不了的那些书 —— ③ 档验收通道，也是气泡那侧
 * 将来要用的入口（本轮不动气泡：T-5.10 的边界只到 Lookup）。
 */
export let lastDictProblems: DictProblem[] = []

export async function lookupDicts(db: Db, term: string): Promise<DictHit[]> {
  const rows = (await listDicts(db)).filter((d) => d.enabled && !d.missing && d.status === 'ok')
  const hits: DictHit[] = []
  const problems: DictProblem[] = []
  for (const d of rows) {
    if (hits.length >= 2) break
    try {
      const h = await hitOf(db, d, term)
      if (h) hits.push(h)
    } catch (e) {
      // 这一本读不了不该挡下一本 —— 但也不许无声无息
      problems.push(problemOf(d.bookname, e))
    }
  }
  lastDictProblems = problems
  return hits
}

// ── Lookup Tab · 单本卡（D-151 · F2）────────────────────────────
//
// 判据与 Windows registry.defaultBook() 同源：
//   dict.default（USER 偏好）存 **dictUid** —— 跨设备认书不认行（D2.1）。
//   默认那本停用/丢了/这台设备没有 → **临时退到第一本可用，绝不回写**
//   （他哪天把书拷回来/重新启用，就该自己恢复）；本机认得那本（有行）才报
//   fellBackFrom（有名字可说），本机根本没有就不说（说了他也不认识）。

export interface DefaultBookPick {
  book: DictRow | null
  /** 想用但用不上的那本的名字（null = 没退/没名字可说） */
  fellBackFrom: string | null
}

export async function defaultBook(db: Db): Promise<DefaultBookPick> {
  const rows = await listDicts(db)
  const usable = rows.filter((d) => d.enabled && !d.missing && d.status === 'ok')
  const first = usable[0] ?? null
  const uid = await prefRaw(db, 'dict.default')
  if (!uid) return { book: first, fellBackFrom: null }
  const live = usable.find((d) => d.uid === uid)
  if (live) return { book: live, fellBackFrom: null }
  const wanted = rows.find((d) => d.uid === uid) ?? null
  return { book: first, fellBackFrom: wanted && first ? wanted.bookname : null }
}

/** 换本 = 设默认（F2 原文）。书还没有 uid（老行没重扫过）就如实拒绝 */
export async function setDefaultBook(db: Db, d: DictRow): Promise<void> {
  if (!d.uid) throw new Error('这本书还没有跨设备身份 —— 在 设置 → 词典 里重新扫描一次')
  await prefSet(db, 'dict.default', d.uid)
}

export interface LookupCard {
  /** 用的哪本（null = 一本可用的都没有） */
  book: DictRow | null
  hit: DictHit | null
  fellBackFrom: string | null
  /** 换本选择器要的全部可用书（含当前） */
  books: DictRow[]
  /**
   * ★ T-5.10 (b) · 选中那本**读不了**的真相。
   * `hit === null && problem === null` 才是「这本里真的没有这个词」。
   */
  problem: DictProblem | null
  /**
   * ★ T-5.10 (c) · 被**无声排除**在查词之外的书（坏的 / 不在夹里的）。
   * 在这之前它们只是从 `usable` 里被 filter 掉，Lookup 上一个字都不说 ——
   * 使用者看到的是「这本里没有」，而真相是「那本书压根没参与这次查词」。
   */
  skipped: DictProblem[]
}

/**
 * 「不在夹里了」不是词典格式问题，core 的诊断词汇（格式 / 压缩 / 编码 / 资源）
 * 里没有这一档，所以这句话在平台层定**一次**，两处引用同一个常量。
 */
const MISSING_SAYS = '这本不在词典文件夹里了 —— 放回去，或者去 设置 → 词典 重新扫描一次。'

/** 被排除在查词之外的书，逐本给出为什么（扫描时落库的诊断就是 core 的话术） */
async function skippedBooks(rows: DictRow[]): Promise<DictProblem[]> {
  return rows
    .filter((d) => d.enabled && (d.missing || d.status !== 'ok'))
    .map((d) => ({
      book: d.bookname,
      says: d.missing ? MISSING_SAYS : (d.diagnostic ?? '这本读不了，原因没记下来。'),
      status: (d.missing ? 'RESOURCE_MISSING' : 'INDEX_ERROR') as DictionaryStatus,
      // 扫描时已经过一次 core 的话术了，这里不再重复摆原始异常
      recognized: true
    }))
}

export async function lookupCard(db: Db, term: string, bookId?: number): Promise<LookupCard> {
  const rows = await listDicts(db)
  const usable = rows.filter((d) => d.enabled && !d.missing && d.status === 'ok')
  const skipped = await skippedBooks(rows)
  const def = await defaultBook(db)
  const picked = (bookId != null ? usable.find((d) => d.id === bookId) : null) ?? def.book
  const base = { fellBackFrom: def.fellBackFrom, books: usable, skipped }
  if (!picked) return { book: null, hit: null, problem: null, ...base }
  try {
    const hit = await hitOf(db, picked, term, LOOKUP_HTML_CLIP)
    return { book: picked, hit, problem: null, ...base }
  } catch (e) {
    // ★ 读不了 ≠ 没这个词。这一条就是「零无声没有」的落点
    return { book: picked, hit: null, problem: problemOf(picked.bookname, e), ...base }
  }
}


/**
 * 取一条词条的**原始正文**，并跟随 `@@@LINK=` 变体重定向。
 *
 * ★ 真机 2026-08-30：不跟随时，在 X 里查 deprecated，卡片上原样显示
 *   「@@@LINK=deprecate」—— 词典里绝大多数变体词目都是这种指路条
 *   （core 实测：朗文6 80.4%、OALD10 77.3%），不跟随等于变形词全废。
 * 判据（怎么认、最多跟几跳）来自 core/dict/lookup.ts 同一份。
 */
function readEntry(m: Mdx, term: string): string | null {
  let cur = term
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const raw = m.rawOf(cur)
    if (raw === null) return null
    const to = detectRedirect(raw)
    if (!to) return raw
    cur = to
  }
  return null // 链太深（多半是两条互指）—— 当没命中，不把进程转死
}
