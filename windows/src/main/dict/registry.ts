import type { Database } from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
// 取文件名一律用 basename，不要自己写正则切路径 ——
// `/[\\/]/` 里那个反斜杠经手几次转义就会少掉一层，变成「只按 / 切」，
// 而 Windows 路径里全是反斜杠：结果是静默地什么都没匹配上（I-106 踩过）
import { basename, join } from 'node:path'
import type { DictRow } from '@shared/api.ts'
import type { DictionaryFileSet } from '@core/dict/contract.ts'
import { DictionaryOpenError, toDiagnostic } from '@core/dict/contract.ts'
import type { DictionaryDiagnostic } from '@core/dict/diagnostics.ts'
import { diagnostics } from '@core/dict/diagnostics.ts'
import { titleIsInformative } from '@core/dict/identity.ts'
import type { KeyRules, LookupSource } from '@core/dict/lookup.ts'
import { Prefs } from '../db/prefs.ts'
import { ADAPTERS, adapterFor, type BookAdapter, type OpenBook } from './adapters/index.ts'
import { scanResources } from './adapters/mdict.ts'
import { nodeIO } from './adapters/io.ts'

/**
 * 词典总登记处 · D2（2026-08-19）
 *
 * ══ 一处判据，一个入口 ★★ ═════════════════════════════════
 *
 * 扫描 / 认领 / 身份 / 启用 / 排序 / 默认 / 重扫 / 状态诊断 / 句柄生命周期 ——
 * 这九件事在 D2 之前散在 `Dicts` 的各处，而且和「怎么解析 .mdx」搅在一起。
 * 现在格式知识全在 adapter 里，这个文件里**一个扩展名都没有**。
 *
 * ══ 三条不许破的 ★★★ ══════════════════════════════════════
 *
 *   ① **只增不删。** 文件不在了标 `missing`，不删行 ——
 *      他可能只是把移动硬盘拔了，而排序和启用状态记在那一行上。
 *   ② **认领要认得出同一本。** I-106：词典目录搬家之后，
 *      库里 22 条旧登记全指着老路径，于是列表变成「22 本不见了 + 22 本新的」，
 *      **他排好的顺序和停用状态全丢**。
 *   ③ **诊断落库。** 在这之前失败原因只活在内存里，靠每次启动全量装载重建；
 *      D5 要把全量装载改成惰性，那时诊断就没人重建了 —— 设置页会变成一片「未知」，
 *      那比现在更糟。所以 `status` / `diagnostic` 从一开始就写进 `dictionaries`。
 *
 * ══ 认领的三级判据 ═════════════════════════════════════════
 *
 *   ① 路径一样            → 就是它（最常见）
 *   ② **uid 一样**        → 就是它。路径变了、文件名也变了都认得出（D2 新增）
 *   ③ 文件名一样且只有一条 → 就是它（I-106 的老判据，留着兜底）
 *
 * ★ ② 比 ③ 强，但**不是无条件**：`identityStrength` 说身份只靠计数撑着
 *  （实测 8/21 本的 Title 是占位或空）时，再比一次文件名才认 ——
 *   身份撞车的后果是**把他两本词典的设置合成一本**，那是不可逆的。
 */

/** 一本词典在库里的完整一行（含 D2 新增的五列） */
export interface DictRecord extends DictRow {
  uid: string | null
  format: string | null
  status: string | null
  diagnostic: DictionaryDiagnostic | null
  capabilities: string[]
  resources: ResourceItem[]
  probedAt: number | null
  /** 上次探测时的文件指纹。**只用来判要不要重新探测**，不参与身份 */
  resourcesFp: string
}

export interface ResourceItem {
  name: string
  bytes: number
  ok: boolean
  count: number
  exts: [string, number][]
  why?: string
}

interface ProbeResult {
  uid: string | null
  format: string | null
  /**
   * 头部**声明**的词条数 · ★ D5.2
   *
   * 它不等于建成的索引大小（大小写归一会去重：OALD10 声明 283811、索引 276902）。
   * 启动不再全量装载之后，先拿这个数顶上 —— 真正装载过那一本，
   * `handle()` 会用实测值回填。宁可先显示一个差几千的数，
   * 也不要为了这个数在启动时把 790 万条索引全建一遍。
   */
  entryCount: number
  status: string
  diagnostic: DictionaryDiagnostic
  capabilities: string[]
  resources: ResourceItem[]
  /** 文件指纹 —— 只用来判「要不要重新数一遍资源包」，**不参与身份** */
  fp: string
  title: string
}

export class DictionaryRegistry {
  /** 装载好的句柄。**惰性**：查到这本才装（D5.2 之后启动不再预热，见 `rescan()` 结尾） */
  private open = new Map<string, OpenBook>()
  /**
   * 装不起来的原因（**原始异常文本**）。
   * ★ 这一份是给老界面用的 `DictRow.problem`，D2 一个字不许变；
   *   给人看的那句话在 `diagnostic.says` 里，D4 换过去。
   */
  private problems = new Map<string, string>()

  private prefs: Prefs

  constructor(
    private db: Database,
    private dictsDir: string,
    private adapters: readonly BookAdapter[] = ADAPTERS
  ) {
    this.prefs = new Prefs(db)
    if (!existsSync(this.dictsDir)) mkdirSync(this.dictsDir, { recursive: true })
  }

  get dir(): string {
    return this.dictsDir
  }

  // ── 扫描 ──────────────────────────────────────────────────

  /**
   * 目录里有哪些「一组文件」。
   * ★ 认哪些扩展名**由 adapter 说了算**（`mainExtensions`），
   *   加一种格式不用动这里一个字。
   */
  scan(): DictionaryFileSet[] {
    const exts = new Set(this.adapters.flatMap((a) => a.mainExtensions.map((e) => e.toLowerCase())))
    const out: DictionaryFileSet[] = []
    /**
     * ★★ 顺序就是**登记顺序**，登记顺序就是他第一次看到的**排列顺序**（`sort_order`）。
     *
     *   目录项按 `readdirSync` 的顺序走，遇到子目录**当场递归**，遇到文件当场登记。
     *   这和 D2 之前的 `scanDicts()` 逐字一致 —— 换个顺序，查词结果里
     *   「哪本排前面」就全变了（第一版排序了一次，行为对拍当场红了 200 多处）。
     */
    const walk = (dir: string, depth: number): void => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      const isDir = new Map<string, boolean>()
      const files: string[] = []
      for (const n of names) {
        const p = join(dir, n)
        try {
          const st = statSync(p)
          isDir.set(p, st.isDirectory())
          if (!st.isDirectory()) files.push(p)
        } catch {
          isDir.set(p, false)
        }
      }
      for (const n of names) {
        const main = join(dir, n)
        if (isDir.get(main)) {
          if (depth < 3) walk(main, depth + 1)
          continue
        }
        const dot = main.lastIndexOf('.')
        if (dot < 0 || !exts.has(main.slice(dot).toLowerCase())) continue
        const siblings = files.filter((f) => f !== main)
        const a = adapterFor({ main, resources: [], loose: [], folder: dir }, nodeIO, this.adapters)
        const bag = a?.collect?.(main, siblings) ?? { resources: [], loose: siblings }
        out.push({ main, folder: dir, resources: bag.resources, loose: bag.loose })
      }
    }
    walk(this.dictsDir, 0)
    return out
  }

  /** 文件指纹：主文件与资源包的「大小 + 修改时间」。**只用来判要不要重新探测** */
  private fingerprintOf(files: DictionaryFileSet): string {
    const one = (p: string): string => {
      try {
        const st = statSync(p)
        return `${basename(p)}:${st.size}:${Math.round(st.mtimeMs)}`
      } catch {
        return `${basename(p)}:?`
      }
    }
    return [one(files.main), ...files.resources.map(one)].join('|')
  }

  /**
   * 探测一组文件。**只读头部 + 数一遍资源包的词表**，不建索引、不解正文。
   *
   * ★ mtime 在这里出现是**缓存失效判据**，不是身份 ——
   *   身份绝不用 mtime（拷贝、解压、网盘同步都会改它，而内容一个字节没动）。
   *   这两件事必须分清楚，混了就会得到「同一本词典换台机器算出不同 uid」。
   */
  probe(files: DictionaryFileSet, cached?: { fp: string; row: DictRecord }): ProbeResult {
    const fp = this.fingerprintOf(files)
    if (cached && cached.fp === fp && cached.row.probedAt !== null && cached.row.uid) {
      // 文件一个字节没动 → 上次探测的结论照样成立，几百毫秒的资源包扫描省下来
      return {
        uid: cached.row.uid,
        format: cached.row.format,
        status: cached.row.status ?? 'READY',
        diagnostic: cached.row.diagnostic ?? diagnostics.ready(),
        capabilities: cached.row.capabilities,
        resources: cached.row.resources,
        // 文件没动 → 库里那个数（可能已经是实测值）照样成立，别拿声明值把它冲掉
        entryCount: cached.row.wordCount,
        fp,
        title: cached.row.bookname
      }
    }

    const adapter = adapterFor(files, nodeIO, this.adapters)
    if (!adapter) {
      const d = diagnostics.notADictionary('没有哪种格式认得这个文件')
      return { uid: null, format: null, status: d.status, diagnostic: d, capabilities: [], resources: [], entryCount: 0, fp, title: '' }
    }

    let resources: ResourceItem[] = []
    try {
      const p = adapter.probe(files, nodeIO)
      // 资源清单单独再取一次形状（adapter 的 probe 只把扩展名折进了 capabilities）
      resources = adapter.format === 'mdict' ? scanResources(files, nodeIO).reports : []
      return {
        uid: p.uid,
        format: `${p.format}${p.formatVersion ? ' ' + p.formatVersion : ''}`,
        status: p.diagnostic?.status ?? 'READY',
        diagnostic: p.diagnostic ?? diagnostics.ready(),
        capabilities: [...p.capabilities],
        resources,
        entryCount: p.entryCount,
        fp,
        title: p.title
      }
    } catch (err) {
      const d = err instanceof DictionaryOpenError ? err.diagnostic : toDiagnostic(err)
      return { uid: null, format: adapter.format, status: d.status, diagnostic: d, capabilities: [], resources, entryCount: 0, fp, title: '' }
    }
  }

  // ── 重扫 ──────────────────────────────────────────────────

  /**
   * 扫一遍目录，把发现的登记进库；文件不在了的标 `missing`。**不删记录。**
   */
  rescan(): DictRow[] {
    const found = this.scan()
    const now = Date.now()
    const seen = new Set<string>(found.map((f) => f.main))

    /**
     * ★★ **先**把不在了的标成 missing，**再**去认领。顺序不能反。
     *
     * 反了会怎样：认领时那些旧行还是 `missing = 0`，`claim()` 一条都找不到
     * → 每一本都新插一行 → 旧行随后才被标 missing → `mergeOrphans()` 把设置
     * 过继给新行、删掉旧行。表面上「排序和启用都还在」，
     * 但 **id 变了**，而 `settings['dict.default']` 存的正是 id ——
     * 于是他设的默认词典指向一行不存在的记录，`defaultBook()` 悄悄退到第一本。
     *
     * 这个坑在 D2 之前就有（老代码是同样的顺序），一直没被发现是因为
     * 「退到第一本」和「他选的那本」在他的排列下**恰好是同一本**。
     * 反向验收把它翻出来了：把认领整个删掉，用例照样绿。
     */
    for (const r of this.db.prepare(`select id, ifo_path from dictionaries`).all() as {
      id: number
      ifo_path: string
    }[]) {
      if (seen.has(r.ifo_path)) continue
      this.db.prepare(`update dictionaries set missing = 1, updated_at = ? where id = ?`).run(now, r.id)
      this.open.get(r.ifo_path)?.close()
      this.open.delete(r.ifo_path)
    }

    const maxOrder =
      ((this.db.prepare(`select max(sort_order) as m from dictionaries`).get() as { m: number | null })
        .m ?? 0) + 1
    let next = maxOrder

    for (const files of found) {
      const existing = this.rowOfPath(files.main)
      const p = this.probe(files, existing ? { fp: this.storedFp(existing), row: existing } : undefined)
      const row = existing ?? this.claim(files, p)

      const bookname = this.booknameOf(files, p)
      if (row) {
        this.db
          .prepare(
            `update dictionaries
                set ifo_path = ?, folder = ?, bookname = ?, missing = 0, word_count = ?,
                    uid = ?, format = ?, status = ?, diagnostic = ?,
                    capabilities = ?, resources = ?, probed_at = ?, updated_at = ?
              where id = ?`
          )
          .run(
            files.main,
            files.folder,
            bookname,
            /**
             * ★★ D5.2 · 词数不再靠「启动时把每一本都装载一遍」拿。
             *
             * `p.entryCount` 一个字段表达了两种情形，不需要第二处判断：
             *   · 文件没动（probe 命中缓存）→ 它就是库里现有的那个数，
             *     已经回填过实测值的不会被冲掉
             *   · 文件是新的 / 变过 → 它是**头部声明值**，先顶上，
             *     等他真的查这本时 `handle()` 用实测值回填
             *
             * 声明值和实测值会差几千（OALD10：283811 / 276902）——
             * 大小写归一在建索引时去了重。差这几千，换回来的是启动少 6.8 秒。
             */
            p.entryCount,
            p.uid,
            p.format,
            p.status,
            JSON.stringify(p.diagnostic),
            JSON.stringify(p.capabilities),
            JSON.stringify({ fp: p.fp, items: p.resources }),
            now,
            now,
            row.id
          )
      } else {
        this.db
          .prepare(
            `insert into dictionaries
               (ifo_path, folder, bookname, word_count, enabled, sort_order, missing,
                uid, format, status, diagnostic, capabilities, resources, probed_at, updated_at)
             values (?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            files.main,
            files.folder,
            bookname,
            p.entryCount, // ★ D5.2 · 头部声明值，装载过再回填实测值
            next++,
            p.uid,
            p.format,
            p.status,
            JSON.stringify(p.diagnostic),
            JSON.stringify(p.capabilities),
            JSON.stringify({ fp: p.fp, items: p.resources }),
            now,
            now
          )
      }
    }

    this.mergeOrphans(now)
    /** 探测完才有 uid，这时候才搬得动老的 `dict.default`（D2.1） */
    this.healLegacyDefault()
    /**
     * ★★★ D5.2 · 这里**不再**「扫完立刻真装一遍」。
     *
     * 老那行是 `return this.verifyAll()` —— 把每一本都装载一遍，
     * 为的是当场查实「能不能用、多少词」。实测代价：**21 本 6831 ms**，
     * 而且是**同步的**，压在他双击图标到窗口能用之间。
     *
     * 它办的两件事各自搬走了，没有一件被静默丢掉：
     *   · 多少词  → probe 的头部声明值先顶上（`p.entryCount`），
     *              真装载过那一本时 `handle()` 用实测值回填
     *   · 能不能用 → `handle()` 装载失败时当场落库（原来那段判断原样搬过去，
     *              包括「只在 probe 说 READY 时才写」那条 —— 否则装载抛的
     *              `Attempt to access memory outside buffer bounds` 会盖掉
     *              probe 认出来的「这不是词典文件，可以直接删掉」）
     *
     * probe 本身留着（5 ms / 22 本），格式、身份、能力、资源清单照旧当场探。
     */
    return this.list()
  }

  /**
   * ★★ I-106 · 认领。路径变了要认出旧行，不要新建一条。
   *
   * 目录从 `<软件>/dicts` 搬到 `data/dicts` 那次，库里 22 条旧登记全指着老路径 ——
   * 列表变成「22 条文件不见了 + 22 条新的」，**排序和启用状态也全丢了**，
   * 因为它们记在旧行上。
   */
  private claim(files: DictionaryFileSet, p: ProbeResult): DictRecord | null {
    const orphans = this.records().filter((r) => r.missing === 1)
    if (orphans.length === 0) return null

    // ① uid 一样 —— 路径变了、文件名也变了都认得出
    if (p.uid) {
      const byUid = orphans.filter((r) => r.uid === p.uid)
      if (byUid.length === 1) {
        const one = byUid[0]!
        /**
         * ★ 身份只靠计数撑着（Title 是占位或空，实测 8/21 本如此）时再比一次文件名。
         *   撞车的后果是**把他两本词典的设置合并成一本**，不可逆。
         *   宁可当成新的一本（后果只是排序回到默认），也不要合错。
         */
        const weak = !titleIsInformative(p.title)
        if (!weak || basename(one.ifoPath) === basename(files.main)) return one
      }
    }

    // ② 文件名一样，而且只有那一条对得上（I-106 的老判据）
    const name = basename(files.main)
    const byName = orphans.filter((r) => basename(r.ifoPath) === name)
    return byName.length === 1 ? byName[0]! : null
  }

  /**
   * 合并「同一本词典的新旧两行」。
   *
   * 目录搬家之后会出现：旧行指着老路径（missing=1），新行指着新路径。
   * **他的启用状态和排序记在旧行上**，所以不是简单删掉旧行 —— 要先过继再删。
   * 有歧义就不动，宁可留着让他自己看。
   */
  private mergeOrphans(now: number): void {
    const all = this.records()
    const base = (p: string): string => basename(p)
    for (const old of all.filter((r) => r.missing === 1)) {
      const sameName = (r: DictRecord): boolean => base(r.ifoPath) === base(old.ifoPath)
      const sameUid = (r: DictRecord): boolean => Boolean(old.uid) && r.uid === old.uid
      const match = (r: DictRecord): boolean => sameUid(r) || sameName(r)
      const live = all.filter((r) => r.missing === 0 && match(r))
      const olds = all.filter((r) => r.missing === 1 && match(r))
      if (live.length !== 1 || olds.length !== 1) continue
      this.db
        .prepare(`update dictionaries set enabled = ?, sort_order = ?, updated_at = ? where id = ?`)
        .run(old.enabled, old.sortOrder, now, live[0]!.id)
      /**
       * ★ 老的 `settings['dict.default']` 存的是**这一行的 id**：行删了却不改它，
       *   默认词典就指向一条不存在的记录，`defaultBook()` 会不声不响退到第一本。
       *   D2.1 之后偏好里存的是 uid（换行不影响），但升级途中旧键可能还在，
       *   所以这一道保险留着。
       */
      const def = this.db.prepare(`select value from settings where key = 'dict.default'`).get() as
        | { value: string }
        | undefined
      if (def && Number(def.value) === old.id) {
        this.db
          .prepare(`update settings set value = ?, updated_at = ? where key = 'dict.default'`)
          .run(String(live[0]!.id), now)
      }
      this.db.prepare(`delete from dictionaries where id = ?`).run(old.id)
    }
  }

  /** 书名：优先用文件名（老行为一个字不变），probe 出来的 Title 只作参考存着 */
  private booknameOf(files: DictionaryFileSet, _p: ProbeResult): string {
    const name = basename(files.main)
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(0, dot) : name
  }

  // ── 读 ────────────────────────────────────────────────────

  private storedFp(r: DictRecord): string {
    return r.resourcesFp
  }

  /** 库里的完整记录（含 D2 新增的列） */
  records(): DictRecord[] {
    const rows = this.db
      .prepare(
        `select id, bookname, ifo_path as ifoPath, folder, word_count as wordCount,
                enabled, sort_order as sortOrder, missing,
                uid, format, status, diagnostic, capabilities, resources, probed_at as probedAt
           from dictionaries order by sort_order, id`
      )
      .all() as (DictRow & {
      uid: string | null
      format: string | null
      status: string | null
      diagnostic: string | null
      capabilities: string | null
      resources: string | null
      probedAt: number | null
    })[]

    return rows.map((r) => {
      const res = parseJson<{ fp?: string; items?: ResourceItem[] }>(r.resources) ?? {}
      const diag = parseJson<DictionaryDiagnostic>(r.diagnostic)
      const rec: DictRecord = {
        ...r,
        diagnostic: diag,
        capabilities: parseJson<string[]>(r.capabilities) ?? [],
        resources: res.items ?? [],
        resourcesFp: res.fp ?? '',
        /**
         * ★★★ D5.2 · 「这本用不了」那一行的来源（设置页 `dict-problem`，D-262）。
         *
         * 从前它只有内存里那一份 —— 而那一份是**启动时全量装载**顺手填的。
         * 惰性之后没人去装载了，它会一直是空的：坏词典在列表里安安静静躺着，
         * 什么都不说。**那正是「失败看不见」本身。**
         *
         * 所以退一档到**落库的诊断**：probe 看出来的（不是词典 / 文件不完整 /
         * 加密）当场就有，装载才暴露的那种由 `noteLoaded` 补写。
         * 顺带修好了老的一个毛病：从前重启之后这一行会消失（内存没了），
         * 现在它跟着库走。
         */
        problem: this.problems.get(r.ifoPath) ?? failureText(r.status, diag)
      }
      return rec
    })
  }

  /**
   * 设置页那一份。**字段与 D2 之前逐字相同**，新列是附加的 ——
   * 老界面读不到新字段也照样工作，D4 再用它们。
   */
  list(): DictRow[] {
    return this.records()
  }

  private rowOfPath(path: string): DictRecord | null {
    return this.records().find((r) => r.ifoPath === path) ?? null
  }

  /**
   * 装载过一本之后要落库的两件事 · ★★ D5.2
   *
   * 原来这两件由启动时的 `verifyAll()` 统一做（把每一本都装载一遍）。
   * 惰性之后没有那个时刻了，所以搬到「真的装载这一本」的那一刻 ——
   * `handle()` 有缓存，所以每本每次启动最多走一遍。
   *
   * ★ 装载失败必须**落库**，不能只记在内存里：
   *   那是「重启之后还看得见同一个失败原因」那条要求。
   */
  private noteLoaded(path: string, book: OpenBook | null): void {
    const r = this.rowOfPath(path)
    if (!r) return
    const t = Date.now()

    if (book) {
      // 实测词数回填 —— 它比头部声明值小（大小写归一去了重）
      const n = book.wordCount
      if (n > 0 && n !== r.wordCount) {
        this.db
          .prepare(`update dictionaries set word_count = ?, updated_at = ? where id = ?`)
          .run(n, t, r.id)
      }
      return
    }

    const problem = this.problems.get(path) ?? null
    /**
     * ★ 只在 probe 没看出毛病（`READY`）时才写装载失败的那条。
     *   probe 看得见头部的形状，装载只看得见抛出来的异常 ——
     *   `_._TLD.mdx` 那种文件 probe 说的是「这不是词典文件，可以直接删掉」，
     *   而装载抛的是 `Attempt to access memory outside buffer bounds`。
     *   后者盖掉前者，就等于把认出来的原因又丢回「认不出来」。
     */
    if (problem && (r.status === null || r.status === 'READY')) {
      const diag = this.openDiagnostics.get(path) ?? diagnostics.indexError(problem)
      if (r.status !== diag.status || r.diagnostic?.detail !== diag.detail) {
        this.db
          .prepare(`update dictionaries set status = ?, diagnostic = ?, updated_at = ? where id = ?`)
          .run(diag.status, JSON.stringify(diag), t, r.id)
      }
    }
  }

  /**
   * 「这本收没收这个词」· ★★ D5.2 —— `lookupCard` 的「别的哪几本也有它」用它。
   *
   * 三档，越靠前越便宜：
   *   ① 这本已经装载过 → 内存里的索引直接答，**免费而且精确**
   *   ② adapter 给得出便宜的答案（MDict：只读词表，不建索引）
   *   ③ 都不行 → 退回老路，装载再问（StarDict 走这一档，它的索引本来就是个小文件）
   *
   * ★ 结果必须和「装载全书再查」逐字相同 —— 否则某本词典会从选择器里
   *   悄悄消失，而他只会以为那本词典没收这个词。
   *   `tests/dict-has.test.ts` 拿他真的那 21 本、每本 136 个词逐条对过。
   */
  /**
   * 现在手上开着几本 —— ★ **只读，验收用**（语义一个字不参与）。
   *
   * D5.2 之后「启动开着 0 本」「查一个词开 1 本」「查第二个词还是 1 本」
   * 这三句话必须有东西替他看着：它们坏掉的样子是**软件照常能用，只是又慢回去了**，
   * 而慢是这个项目里最容易被当成"电脑今天卡"的一类回归。
   */
  openCount(): number {
    return this.open.size
  }

  /**
   * ★★ T-7.13（I-166）· **这一本的索引已经在手上了吗** —— 不开它，只问。
   *
   * 朗读那一步要用它：开一本冷词典是**同步**的几百毫秒到几秒，而同步代码
   * 堵住事件循环时，`runVoicePlan` 那 150 ms 的预算连计时器都轮不上
   * （A 2026-09-07 量到冷启动后第一次朗读 8963 / 14637 ms）。
   * 所以判据改成「问一句，没开就当 miss」，把开书的钱挪到预热那一趟去花。
   */
  isOpen(path: string): boolean {
    return this.open.has(path)
  }

  hasWord(path: string, key: string): boolean {
    const cached = this.open.get(path)
    if (cached) return cached.legacyText(key) !== null

    const files = this.filesOf(path)
    if (!files) return false
    const adapter = adapterFor(files, nodeIO, this.adapters)
    if (adapter?.hasWord) {
      try {
        return adapter.hasWord(files, nodeIO, key)
      } catch {
        return false
      }
    }
    const book = this.handle(path)
    return book ? book.legacyText(key) !== null : false
  }

  // ── 句柄生命周期 ──────────────────────────────────────────

  /** 装载失败时那条诊断（内存态；`noteLoaded` 会把它落库） */
  private openDiagnostics = new Map<string, DictionaryDiagnostic>()

  /**
   * 装载一本。**惰性 + 缓存**：查到哪本才装哪本，装过就留着。
   *
   * ★ 这里**没有任何扩展名判断** —— 哪个 adapter 认领由 `adapterFor` 决定。
   *   D2 之前这一行是 `path.endsWith('.mdx') ? Mdict.open : StarDict.open`，
   *   加第三种格式就得改它，而那正是「统一契约」要消灭的东西。
   */
  handle(path: string): OpenBook | null {
    const cached = this.open.get(path)
    if (cached) return cached

    const files = this.filesOf(path)
    if (!files) return null
    const adapter = adapterFor(files, nodeIO, this.adapters)
    if (!adapter) {
      const d = diagnostics.notADictionary('没有哪种格式认得这个文件')
      this.problems.set(path, d.says)
      this.openDiagnostics.set(path, d)
      return null
    }
    try {
      const book = adapter.open(files, nodeIO)
      this.open.set(path, book)
      this.problems.delete(path)
      this.openDiagnostics.delete(path)
      // ★ D5.2 · 实测词数回填（原来由启动时的 verifyAll 做）
      this.noteLoaded(path, book)
      return book
    } catch (err) {
      /**
       * ★ `problem` 里存的是**原始异常文本**，和 D2 之前逐字相同 ——
       *   设置页现在显示的就是它。给人看的那句话在 `openDiagnostics` 里，D4 换过去。
       */
      const raw =
        err instanceof DictionaryOpenError
          ? (err.diagnostic.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err)
      this.problems.set(path, raw)
      this.openDiagnostics.set(path, toDiagnostic(err))
      // ★ D5.2 · 装载失败当场落库（原来由启动时的 verifyAll 做）
      this.noteLoaded(path, null)
      return null
    }
  }

  /** 一个主文件对应的那一组文件（资源包 + 散件）。找不到就是它已经不在了 */
  private filesOf(main: string): DictionaryFileSet | null {
    return this.scan().find((f) => f.main === main) ?? null
  }

  problemOf(path: string): string | null {
    return this.problems.get(path) ?? null
  }

  /** 这本现在是什么状态 —— **从库里读**，所以重启之后还在（D2 的落库要求） */
  statusOf(id: number): { status: string | null; diagnostic: DictionaryDiagnostic | null } {
    const r = this.records().find((x) => x.id === id)
    return { status: r?.status ?? null, diagnostic: r?.diagnostic ?? null }
  }

  closeAll(): void {
    for (const d of this.open.values()) d.close()
    this.open.clear()
  }

  // ── 启用 / 排序 / 默认 ────────────────────────────────────

  setEnabled(id: number, on: boolean): void {
    this.db
      .prepare(`update dictionaries set enabled = ?, updated_at = ? where id = ?`)
      .run(on ? 1 : 0, Date.now(), id)
  }

  /** D-234 · 拖动排序定优先级。界面给的是排好的整串 id。 */
  reorder(ids: number[]): void {
    const now = Date.now()
    const up = this.db.prepare(`update dictionaries set sort_order = ?, updated_at = ? where id = ?`)
    this.db.transaction(() => {
      ids.forEach((id, i) => up.run(i + 1, now, id))
    })()
  }

  /**
   * 现在能用的那些：启用着、文件在、装得起来。
   * **顺序就是他在设置页拖出来的顺序**（`sort_order`）。
   *
   * ★ D2 新增一条：**同一个 uid 只出一本**。
   *   同一本词典的两份文件（他机器上 LDOCE5 的资源包就是重复的两份）
   *   不该在查词结果里并排出现两次 —— 那是同一本书，不是两本。
   *   被挡下的那一本仍然在列表里看得见，只是不参与查词。
   */
  usable(): DictRow[] {
    return this.providers().filter((r) => !r.problem)
  }

  /**
   * 参与查词的那些：启用着、文件在，**同一个 uid 只出一本**。
   *
   * ★ 去重这一条是 D2 新增的（他的验收要求：「同一 dictUid 的重复文件
   *   不能产生两个 provider，不同 dictUid 必须允许并存」）。
   *   实测他机器上 LDOCE5 的资源包就是重复的两份 —— 正文只有一个，
   *   但重复文件这种事随时会发生（网盘同步、手动备份都会留下 `xxx (1)`）。
   *   两份同一本词典在查词结果里并排出现，他会以为软件重复显示了。
   *   **被挡下的那一份仍然在列表里看得见**，删不删由他决定。
   */
  providers(): DictRecord[] {
    const seenUid = new Set<string>()
    const out: DictRecord[] = []
    for (const r of this.records()) {
      if (r.enabled !== 1 || r.missing !== 0) continue
      if (r.uid) {
        if (seenUid.has(r.uid)) continue
        seenUid.add(r.uid)
      }
      out.push(r)
    }
    return out
  }

  // ── 资源 · D4 ────────────────────────────────────────────

  /**
   * 按**跨设备身份 + 资源键**取字节。
   *
   * ★★ 惰性：只有真的有人要这一条资源，才会去开 `.mdd`
   *   （`adapters/mdict.ts` 里 `openArchives()` 是第一次调用时才建的）。
   *   他的 D4 第 8 条：不许因为打开一本词典就把整本资源解进内存 ——
   *   OALD10 的四个包合起来 2.1 GB。
   *
   * ★ 渲染层给的是 `ref`（`bookUid|key`），**永远不是路径**。
   *   这里按 uid 找本机那一行；找不到就是 null，不猜、不回退到别的书。
   */
  async resource(bookUid: string, key: string): Promise<Uint8Array | null> {
    const row = this.records().find((r) => r.uid === bookUid && r.missing === 0)
    if (!row) return null
    const book = this.handle(row.ifoPath)
    if (!book) return null
    try {
      return await book.resource(key)
    } catch {
      // 少一张图不该让查词炸掉
      return null
    }
  }

  /** 这个 uid 在本机是哪一行 —— 资源与样式表都要用 */
  rowOfUid(bookUid: string): DictRecord | null {
    return this.records().find((r) => r.uid === bookUid && r.missing === 0) ?? null
  }

  // ── 查词的来源 · D3 ──────────────────────────────────────

  /**
   * 一本参与查词的词典：core 要的抽象 + 老路径要的压平文本。
   *
   * ★ `text()` 仍然走 `legacyText()` —— D3 换的是**「哪一条记录」**（跟随跳转），
   *   不是**「那条记录长什么样」**（富文本渲染是 D4）。
   *   跟到 `child` 之后取的正文，与他直接查 `child` 看到的**逐字相同**。
   */
  providersForLookup(): { row: DictRecord; source: LookupSource; text(headword: string): string | null }[] {
    const out: { row: DictRecord; source: LookupSource; text(headword: string): string | null }[] = []
    for (const row of this.providers()) {
      const book = { uid: row.uid ?? `local-${row.id}`, id: row.id, name: row.bookname }
      /**
       * ★★ 这里给 core 的是**这个索引的真相**，不是文件头的原话。
       *
       *   D2 的索引是「小写键 → 记录」（`Mdict` / `StarDict` 建的那一份）。
       *   头部说 `KeyCaseSensitive=Yes` 的那本（21 本里只有 LCDT）
       *   要真正做到大小写敏感，得等 D5 重建索引 —— 在那之前谎称敏感，
       *   只会让 core 多试一个查不到的键。
       *
       *   `stripKey` 同理：D3 用 `kinds` 把 `stripped` 那一档整个关掉了
       *   （见 `Dicts.lookup` 的 `D3_KINDS`），这里填什么都不影响这一轮。
       */
      const keyRules: KeyRules = { caseSensitive: false, stripKey: false }
      const source: LookupSource = {
        book,
        keyRules,
        match: (key) => this.handle(row.ifoPath)?.match(key) ?? [],
        raw: (headword, occurrence) => this.handle(row.ifoPath)?.raw(headword, occurrence) ?? null
      }
      out.push({
        row,
        source,
        text: (headword: string) => this.handle(row.ifoPath)?.legacyText(headword) ?? null
      })
    }
    return out
  }

  /**
   * ★★ 卡片该用哪一本 —— **判据只有这一处**，界面不许自己算。
   *
   *   System Initial   他从没设过 → `sort_order` 最靠前的那本可用词典。**不写进设置**
   *   User Default     `settings['dict.default']`，值是 `dictionaries.id`
   *   Current          卡片内存里那本；他一切换就同时写回 Default
   *
   * ★ 默认那本停用了 / 文件不在了：**临时**退到第一本可用的，**绝不改写他的设置**
   *   —— 硬盘插回来就该自己恢复。退了要说一句（`fellBack`）。
   */
  defaultBook(): { book: DictRow | null; wanted: DictRow | null; fellBack: boolean } {
    const usable = this.usable()
    const first = usable[0] ?? null
    const uid = this.wantedUid()
    if (!uid) return { book: first, wanted: null, fellBack: false }

    /**
     * ★★ 他要的是**哪一本书**，不是「哪一行记录」。
     *   uid 认得出同一本词典在这台机器上的那一行 —— 路径变了、文件名变了、
     *   甚至换了一台设备，都还认得出。
     */
    const wanted = this.records().find((r) => r.uid === uid) ?? null
    const live = usable.find((r) => (r as DictRecord).uid === uid) ?? null
    if (live) return { book: live, wanted, fellBack: false }

    /**
     * ★ 三种「用不上」的情形，处理方式**完全一样**：临时退，**绝不回写**。
     *
     *   停用了 / 文件不在了            → 本机有这一行，退了要说一句
     *   这台设备根本没有这本词典        → 本机没有这一行，`wanted` 是 null，
     *                                    没有名字可说，就不说（说了他也不认识）
     *
     *   两种都不许改偏好：他哪天把那本词典拷过来、或者重新启用，就该自己回去。
     */
    return { book: first, wanted, fellBack: wanted !== null && first !== null }
  }

  /**
   * 他要的那本词典的 uid。
   *
   * ★ 兼容期：偏好表里没有、而老的 `settings['dict.default']` 还在（存的是本机 id）时，
   *   把那个 id 解析成 uid 来用。真正把它搬过去是 `healLegacyDefault()` 的事 ——
   *   那要等 `rescan()` 探测出 uid 之后才做得到（V33 迁移跑的时候 uid 还是 NULL）。
   */
  private wantedUid(): string | null {
    const fromPref = this.prefs.raw('dict.default')
    if (fromPref) return fromPref
    const legacy = this.db.prepare(`select value from settings where key = 'dict.default'`).get() as
      | { value: string }
      | undefined
    if (!legacy) return null
    const id = Number(legacy.value)
    if (!Number.isSafeInteger(id)) return null
    return this.records().find((r) => r.id === id)?.uid ?? null
  }

  /**
   * ★ 自愈：老的 `settings['dict.default']`（本机 id）→ 偏好表里的 uid。
   *
   * 为什么不在迁移里做：V32 刚把 `uid` 列加出来，值全是 NULL —— 要等
   * `rescan()` 探测过一遍才有。所以升级当时搬不了，**第一次重扫之后才搬得动**。
   * 规矩和迁移里一模一样：解析不出真实 uid 就一个字都不写，旧键留着等下一次。
   */
  private healLegacyDefault(): void {
    if (this.prefs.raw('dict.default')) {
      // canonical 已经有了 → 旧键没有意义了，清掉（只能有一个真相）
      this.db.prepare(`delete from settings where key = 'dict.default'`).run()
      return
    }
    const legacy = this.db.prepare(`select value from settings where key = 'dict.default'`).get() as
      | { value: string }
      | undefined
    if (!legacy) return
    const id = Number(legacy.value)
    if (!Number.isSafeInteger(id)) return
    const uid = this.records().find((r) => r.id === id)?.uid ?? null
    if (!uid) return // ★ 编不出来就不编 —— 宁可下次再搬
    this.prefs.set('dict.default', uid)
    this.db.prepare(`delete from settings where key = 'dict.default'`).run()
  }

  /**
   * 他在卡片里主动换了一本 —— **主动切换就等于设为默认**。
   * 只认真实存在的 id；认不出就不写。
   */
  setDefaultBook(id: number): void {
    const row = this.records().find((r) => r.id === id)
    /**
     * ★★ 存的是**这本词典的身份**，不是这一行的 id。
     *   存 id 的话，换台设备就指到另一本书上去了 —— 而且什么都不报。
     *   `Prefs.set` 那边还有一道 `checkPrefValue`（`dict-uid`）兜着，
     *   万一哪天有人在这里改回 id，那边会当场抛。
     *
     * ★ 探测不出 uid 的（装不起来的、根本不是词典的）**不写** ——
     *   宁可保持原样，也不要存一个指不到东西的值。
     */
    if (!row?.uid) return
    this.prefs.set('dict.default', row.uid)
    // 只能有一个真相：老的那把钥匙同时清掉
    this.db.prepare(`delete from settings where key = 'dict.default'`).run()
  }
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * 「这本用不了」要不要说、说什么 · ★ D5.2
 *
 * 只有**真的用不了**才说话。`READY` 与没有诊断的一律沉默 ——
 * 设置页那一行是红的，误报一次他就会去动一本其实好好的词典。
 */
function failureText(status: string | null, diag: DictionaryDiagnostic | null): string | null {
  if (!diag) return null
  if (status === null || status === 'READY') return null
  return diag.detail ? `${diag.says}\n${diag.detail}` : diag.says
}
