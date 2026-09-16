import { app } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { openDatabase } from '../src/main/db/open.ts'
import { Dicts } from '../src/main/dict/index.ts'
import { MddArchive } from '../src/main/dict/mdd.ts'
import type { DictRecord } from '../src/main/dict/registry.ts'
import { buildRichCard } from '../src/main/dict/rich.ts'
import { parseMediaRef } from '../src/core/dict/media.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 行为等价对拍 · D2 的第一道保险（2026-08-19）
 *
 * ══ 为什么必须先有它 ★★★ ═══════════════════════════════════
 *
 * D2 是**行为等价重构**：把 `Dicts` 拆成 adapter + registry，
 * 而 `lookup` / `lookupCard` / `examples` 对外**一个字都不许变**。
 *
 * 「一个字都不许变」这句话要能被验证，就必须有一份**改造之前**的实录。
 * 所以顺序是死的：
 *
 *     ① 重构之前先跑它 `--update`，把现状钉成 baseline
 *     ② 重构完再跑一次，逐项对拍
 *
 * 反过来做（改完再录 baseline）等于录了个寂寞 —— 那正是
 * CLAUDE.md 第九节说的「我验的是我改的那份」。
 *
 * ══ 为什么跑在 Electron 里 ═════════════════════════════════
 *
 * `Dicts` 要 `better-sqlite3`，那是按 Electron 的 ABI 编的，系统 node 加载不了。
 * 和 `tests/db-safety.ts` 同一个理由、同一种跑法。
 *
 * ══ 用法 ═══════════════════════════════════════════════════
 *
 *     electron out/main/dict-behavior.js            对拍
 *     electron out/main/dict-behavior.js --update   录 baseline
 *
 * 找不到他的词典目录就跳过并退 0 —— 只有他那台机器上才有那 22 本。
 */

const DIR = process.env['NYX_DICTS'] ?? 'D:/Nyx/data/dicts'
const UPDATE = process.argv.includes('--update')
const BASELINE = join(__dirname, '..', '..', 'scripts', 'dict-behavior-baseline.json')

/**
 * 对拍用的词。**不是随便挑的**：
 *
 *   children / crises / swayed / per cent   他点名要覆盖的四个（全是重定向重灾区）
 *   bear the brunt of / brunt               多词表达退到词目的那条路
 *   ASIO / marginalia                       备案过的英中粘连（dict-baseline.json）
 *   CD / cd                                 大小写（LCDT 是唯一 KeyCaseSensitive=Yes）
 *   resilient / ran / sway / abandon        画像四本都收的常见词
 *   zzzznotaword                            查不到的那条路也要对拍
 */
const WORDS = [
  'children', 'crises', 'swayed', 'per cent',
  'bear the brunt of', 'brunt', 'ASIO', 'marginalia',
  'CD', 'cd', 'resilient', 'ran', 'sway', 'abandon',
  'the', 'zzzznotaword'
]

/** 正文可能有几十 KB，全存进 baseline 没法看。存长度 + 开头 + 指纹 */
function fingerprint(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${s.length}:${(h >>> 0).toString(16)}`
}

const head = (s: string, n = 60): string => s.replace(/\s+/g, ' ').trim().slice(0, n)

async function capture(): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-dictbeh-'))
  const backups = join(dir, 'backups')
  mkdirSync(backups, { recursive: true })
  const r = openDatabase(join(dir, 'nyx.db'), backups)
  const dicts = new Dicts(r.db, DIR)

  const rows = dicts.rescan()
  const out: Record<string, unknown> = {
    says: '改造前的实录。D2 是行为等价重构 —— 这份文件对不上就是改坏了。',
    dir: DIR,
    books: rows
      .map((x) => ({
        // ★ 不存绝对路径：那是这台机器的事，换个盘符就全红
        file: relative(DIR, x.ifoPath).replace(/\\/g, '/'),
        bookname: x.bookname,
        wordCount: x.wordCount,
        enabled: x.enabled,
        sortOrder: x.sortOrder,
        missing: x.missing,
        problem: x.problem ? head(x.problem, 50) : null
      }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    words: {} as Record<string, unknown>
  }

  for (const w of WORDS) {
    const entries = dicts.lookup(w)
    const card = dicts.lookupCard(w)
    const ex = dicts.examples(w)
    ;(out['words'] as Record<string, unknown>)[w] = {
      lookup: entries.map((e) => ({
        bookname: e.bookname,
        headword: e.headword,
        text: fingerprint(e.text),
        textHead: head(e.text)
      })),
      card: {
        word: card.word,
        headword: card.headword,
        book: card.book?.name ?? null,
        others: card.others.map((o) => o.name),
        phonetic: card.phonetic ?? null,
        senses: card.senses.map((s) => ({ pos: s.pos ?? null, gloss: head(s.gloss, 80) })),
        raw: fingerprint(card.raw),
        rawHead: head(card.raw),
        fellBackFrom: card.fellBackFrom ?? null
      },
      examples: ex.map((e) => ({ from: e.from, text: head(e.text, 80) }))
    }
  }

  /**
   * ══ 登记结果 —— 他点名要的那四条（D2 验收 §9）★★ ══════════
   *
   *   19 本 READY · 2 本 LZO · 1 个不是词典
   *   **重复的 LDOCE5 资源包不许被登记成一本新词典**
   *
   * 这几条数字不是「应该差不多」，是 2026-08-19 那次全量扫描量出来的实数。
   * 对不上就说明扫描 / 认领 / 探测里有一处变了 —— 那正是要拦的。
   */
  const records = dicts.registry.records()
  const byStatus = new Map<string, number>()
  for (const x of records) byStatus.set(x.status ?? '未探测', (byStatus.get(x.status ?? '未探测') ?? 0) + 1)
  const resourceFiles = records.flatMap((x) => x.resources.map((y) => y.name))
  out['registry'] = {
    rows: records.length,
    byStatus: [...byStatus.entries()].sort(),
    /** 资源包**只能**作为某一本的附属出现，不许自己占一行 */
    mddRegisteredAsBook: records.filter((x) => /\.mdd$/i.test(x.ifoPath)).map((x) => x.bookname),
    /** 同一本词典的重复文件不许变成两个 provider */
    providers: dicts.registry.providers().length,
    uids: new Set(records.map((x) => x.uid).filter(Boolean)).size,
    resourceFiles: resourceFiles.length,
    /** LDOCE5 那两个一模一样的资源包 —— 它们是资源，不是词典 */
    ldoce5Resources: records
      .filter((x) => x.bookname.includes('Contemporary English'))
      .flatMap((x) => x.resources.map((y) => `${y.name}·${y.count}`))
      .sort()
  }

  /**
   * ══ D3 · `@@@LINK` 跟随（他点名的四个词）★★★ ══════════════
   *
   * 这四个词在**哪几本**里是跳转，是实测出来的，不是想当然：
   *
   *   children / crises / swayed  →  牛津高阶10 里是 `@@@LINK=`
   *   crises / swayed / per cent  →  朗文6英汉双解 里是 `@@@LINK=`
   *
   * D3 之前，这些词在那两本里查出来的「正文」就是一行 `@@@LINK=child` ——
   * 他右键查 children，屏幕上出现的就是那个。
   *
   * 这一节把「跟到底之后是什么」钉进 baseline：命中的词目、跳过的路、
   * 正文开头。**任何一条变回 `@@@LINK=` 都会当场红。**
   */
  const REDIRECT_WORDS = ['children', 'crises', 'swayed', 'per cent']
  const bookByName = (needle: string): DictRecord | undefined =>
    records.find((x) => x.bookname.includes(needle))
  const redirects: Record<string, unknown> = {}
  for (const needle of ['oald10', '朗文6']) {
    const book = bookByName(needle)
    if (!book) continue
    for (const w of REDIRECT_WORDS) {
      const card = dicts.lookupCard(w, book.id)
      redirects[`${needle} · ${w}`] = {
        headword: card.headword,
        redirectedFrom: card.redirectedFrom ?? null,
        /** ★★ 屏幕上绝不许出现它 */
        showsLink: card.raw.includes('@@@LINK') || card.senses.some((x) => x.gloss.includes('@@@LINK')),
        senses: card.senses.length,
        rawHead: head(card.raw, 50)
      }
    }
  }
  out['redirects'] = redirects

  /**
   * ══ D4 · 富词条 + 资源链路（他点名的那几个词）★★★ ═════════
   *
   * 他的 D4 第一优先级：「不是做一个好看的卡片，
   * 而是**证明完整资源链路真的成立**」。所以这一节钉的是链路，不是排版：
   *
   *   raw HTML → RichDictionaryEntry → media.ref → 真的取出字节
   *
   * 三本各验一件事：
   *   OALD10  UK/US 发音都取得到、图片取得到、中文对译分得开
   *   朗文6    同上（它的样式表在 .mdd 里，不是散文件）
   *   LDOCE5  spx **必须**被判成放不了：书级能力里没有 audio，
   *           每一条音频都带 unavailable —— 不许出现按了没声音的按钮
   */
  const rich: Record<string, unknown> = {}
  for (const [needle, words] of [
    ['oald10', ['brunt', 'sway', 'ostrich']],
    ['朗文6', ['brunt']],
    ['Contemporary English', ['brunt']]
  ] as [string, string[]][]) {
    const book = records.find((x) => x.bookname.includes(needle))
    if (!book) continue
    for (const w of words) {
      const card = buildRichCard(dicts.registry, w, book.id)
      const e = card.entry
      if (!e) {
        rich[`${needle} · ${w}`] = { found: false }
        continue
      }
      /** ★★ 真的把字节取出来 —— 「有 ref」不等于「取得到」 */
      const fetched: Record<string, string> = {}
      for (const m of e.media.slice(0, 4)) {
        const parsed = parseMediaRef(m.ref)
        const bytes = parsed ? await dicts.registry.resource(parsed.bookUid, parsed.key) : null
        fetched[`${m.kind}/${m.label ?? '-'}${m.unavailable ? '(×)' : ''}`] = bytes
          ? `${bytes.byteLength >= 1000 ? '够长' : bytes.byteLength + '字节'} magic=${[...bytes.subarray(0, 3)]
              .map((x) => x.toString(16).padStart(2, '0'))
              .join('')}`
          : '取不到'
      }
      rich[`${needle} · ${w}`] = {
        headword: e.headword,
        caps: e.capabilities,
        phonetics: e.phonetics.map((x) => `${x.region}${x.audio ? (x.audio.unavailable ? '(放不了)' : '♪') : ''}`),
        senses: e.senses.length,
        withZh: e.senses.filter((x) => x.glossZh).length,
        examples: e.senses.reduce((a, x) => a + x.examples.length, 0) + e.examples.length,
        boxes: e.boxes.length,
        crossRefs: e.crossRefs.length,
        htmlBytes: card.html.length,
        /** ★★ 消毒之后绝不许还有这些 */
        dirty: /<script|onclick=|javascript:|sound:\/\/|https?:\/\//i.test(card.html),
        refs: { audio: card.refs.audio.length, image: card.refs.image.length },
        styleRef: card.styleRef,
        fetched
      }
    }
  }
  out['rich'] = rich

  /**
   * ══ 资源包真的取得到字节吗 ★★ ════════════════════════════
   *
   * 「有发音」这个能力是从 `.mdd` 的词表数出来的 —— 数得出名字，
   * 不等于取得出字节。D3 的富卡片全靠这一步，所以在 D2 就把它验了：
   * 取第一本有发音的词典的第一条 mp3，看**头几个字节像不像 mp3**。
   *
   * 只记形状（扩展名、够不够长、magic 对不对），不记键名和长度 ——
   * 那些是他机器上的事，记进 baseline 只会让别的机器无谓地红。
   */
  const audioBook = records.find((x) => x.capabilities.includes('audio') && x.resources.some((y) => y.ok))
  let media: unknown = null
  if (audioBook) {
    const pack = audioBook.resources.find((y) => y.ok && y.exts.some(([e]) => e === 'mp3'))
    if (pack) {
      const archive = MddArchive.open(join(audioBook.folder, pack.name))
      const key = [...archive.keys()].find((k) => k.toLowerCase().endsWith('.mp3'))
      const buf = key ? archive.get(key) : null
      media = {
        book: audioBook.bookname,
        gotBytes: (buf?.length ?? 0) > 1000,
        // mp3 要么以 ID3 标签开头，要么直接是帧头 0xFF 0xFB/0xF3/0xF2
        looksLikeMp3:
          buf !== null &&
          (buf.subarray(0, 3).toString('latin1') === 'ID3' ||
            (buf[0] === 0xff && (buf[1] ?? 0) >= 0xf2))
      }
      archive.close()
    }
  }
  ;(out['registry'] as Record<string, unknown>)['media'] = media

  dicts.closeAll()
  r.db.close()
  keepOrClean(dir)
  return out
}

/** 逐项对拍，返回不一致的路径 */
function diff(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = []
    if (a.length !== b.length) out.push(`${path} 条数 ${b.length} → ${a.length}`)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      out.push(...diff(a[i], b[i], `${path}[${i}]`))
    }
    return out
  }
  if (isObj(a) && isObj(b)) {
    const out: string[] = []
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(...diff(a[k], b[k], path ? `${path}.${k}` : k))
    }
    return out
  }
  return [`${path}：${JSON.stringify(b)} → ${JSON.stringify(a)}`]
}

/**
 * ★ 用 async IIFE，**不用顶层 await** ——
 *   这份文件被打成 cjs，顶层 await 会让**整个构建失败**
 *  （`Module format "cjs" does not support top-level await`）。
 *   `tests/db-safety.ts` 文件尾有同一条注释，同一个坑。
 */
void (async () => {
  if (!existsSync(DIR)) {
    console.log(`跳过行为对拍：找不到词典目录 ${DIR}`)
    app.exit(0)
  } else {
    const now = await capture()
    if (UPDATE) {
      writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n', 'utf8')
      console.log(`baseline 已写入 ${BASELINE}`)
      app.exit(0)
    } else if (!existsSync(BASELINE)) {
      console.error('没有 baseline —— 先在改造之前跑一次 --update')
      app.exit(1)
    } else {
      const was = JSON.parse(readFileSync(BASELINE, 'utf8')) as unknown
      const d = diff(now, was).filter((x) => !x.startsWith('says'))
      console.log(`\n行为等价对拍 · ${DIR}`)
      console.log(`词 ${WORDS.length} 个 · lookup / lookupCard / examples 三条路都对\n`)
      if (d.length === 0) {
        console.log('  逐项一致 ✓')
        app.exit(0)
      } else {
        console.error(`  ✖ ${d.length} 处不一致（左边是 baseline，右边是现在）：`)
        /** 差异一多就看不全 —— 排查时用 `NYX_DIFF_CAP=400` 把全部列出来 */
        const cap = Number(process.env['NYX_DIFF_CAP'] ?? '60')
        for (const line of d.slice(0, cap)) console.error(`      ${line}`)
        if (d.length > cap) console.error(`      …还有 ${d.length - cap} 处`)
        app.exit(1)
      }
    }
  }
})()
