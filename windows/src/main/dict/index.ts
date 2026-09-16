import type { Database } from 'better-sqlite3'
import type { DictCard, DictEntry, DictRow } from '@shared/api.ts'
import { parseEntry } from '@core/dict-entry.ts'
import { lookup as coreLookup, type CandidateKind } from '@core/dict/lookup.ts'
import { DictionaryRegistry } from './registry.ts'
import { buildRichCard } from './rich.ts'
import { parseMediaRef } from '@core/dict/media.ts'
import { pickDictAudio } from '@core/voice/providers/dict-audio.ts'
import type { BookAdapter } from './adapters/index.ts'

/**
 * 词典 · D-150 / D-151 / D-234
 *
 * ══ D2 之后这个文件只剩「查词」这一件事 ★★ ═══════════════════
 *
 * 扫描 / 认领 / 身份 / 启用 / 排序 / 默认 / 重扫 / 状态诊断 / 句柄生命周期
 * 全部搬到了 `registry.ts`；「怎么解析 .mdx / .ifo」在 `adapters/` 里。
 *
 * ══ D3（2026-08-19）· 查词语义换成 core 那一套 ★★★ ═══════════
 *
 * `lookup` / `lookupCard` / `examples` 现在走 `core/dict/lookup.ts`：
 * 候选词分档 → 命中 → **跟随 `@@@LINK`** → 防环 / 跳数上限 → 同形异义。
 *
 * ── 为什么这是 D3 的第一件事 ────────────────────────────────
 *
 * 在这之前，`Mdict.lookup()` 会把跳转记录**当成正文交出去** ——
 * 他右键查 `children`，屏幕上出现的是：
 *
 *     @@@LINK=child
 *
 * 实测 OALD10 抽样 79%、朗文6 81%、正确运用词汇 82% 的词目是跳转，
 * 所以这不是边角情况，是**天天撞得上**的。
 *
 * ── 改动被死死限制在 redirect 这一件事上 ★★ ─────────────────
 *
 * `D3_KINDS` 只开 `verbatim` + `word` 两档 —— 那正是老路径本来就有的两档。
 * `stripped`（`per cent`→`percent`）、`inflection`（`swayed`→`sway`）、`phrase`
 * 三档留着不开：它们会在**没有跳转**的词典里也改变结果，
 * 而他的规矩是「D3 允许改变查词结果，但只能出现在 redirect 相关路径」。
 *
 * ── 正文仍然是压平的文本 ────────────────────────────────────
 *
 * 跟到 `child` 之后取正文走的还是 `legacyText()` —— D3 换的是
 * **「哪一条记录」**，不是**「那条记录长什么样」**。富文本、发音、插图是 D4。
 *
 * D-151「词典**纯本地**，使用者把文件放进指定目录，软件自动识别并排优先级。**不做云端词典。**」
 * D-234「设置页给一个列表 —— 识别到几本、**可拖动排序定优先级、可停用某一本**」
 * D-150「例句来源优先级：**本地词典 → 联网搜索（开关开启时）→ AI 生成**，三种来源在界面上**明确标注**」
 */
/**
 * ★★ D3 只开这两档候选词 —— 老路径本来就有的那两档。
 *
 *   `verbatim`  他划拉的那串原样（归一之后就是老代码里的 `w` 与 `lower`）
 *   `word`      里面最实的那个词（老代码里那段 `words.sort(len desc)`）
 *
 * 关着的三档（`stripped` / `phrase` / `inflection`）都会在**没有跳转**的词典里
 * 改变结果，而 D3 的规矩是「允许改变查词结果，但只能出现在 redirect 相关路径」。
 * 它们在 core 里写好了、测过了，等他点头再开。
 */
const D3_KINDS: readonly CandidateKind[] = ['verbatim', 'word']

/**
 * ★★ 屏幕上那个词目该显示成什么样。
 *
 * 索引是**小写键**的（D2 那份），所以 core 命中之后拿回来的 `headword`
 * 一律是小写：他查 `ASIO`、`CD`，卡片标题会变成 `asio`、`cd`。
 * 那不是 redirect 带来的改变，是归一带来的 —— 而 D3 的规矩是
 * 「允许改变查词结果，但**只能出现在 redirect 相关路径**」。
 *
 * 所以：**跳转过就用跳到的那个词目**（`children` → `child`，那正是要改的），
 * **没跳转就用他那串字原样**（和 D3 之前逐字相同）。
 */
function shownHeadword(hit: { headword: string; candidate: { text: string }; redirectedFrom: string[] }): string {
  return hit.redirectedFrom.length > 0 ? hit.headword : hit.candidate.text
}

export class Dicts {
  readonly registry: DictionaryRegistry

  constructor(db: Database, dictsDir: string, adapters?: readonly BookAdapter[]) {
    this.registry = new DictionaryRegistry(db, dictsDir, adapters)
  }

  get dir(): string {
    return this.registry.dir
  }

  // ── 登记处那一摊，原样转发 ────────────────────────────────

  rescan(): DictRow[] {
    return this.registry.rescan()
  }

  list(): DictRow[] {
    return this.registry.list()
  }

  /** 现在手上开着几本 —— ★ 只读，验收用（见 `DictionaryRegistry.openCount`） */
  openCount(): number {
    return this.registry.openCount()
  }


  setEnabled(id: number, on: boolean): void {
    this.registry.setEnabled(id, on)
  }

  reorder(ids: number[]): void {
    this.registry.reorder(ids)
  }

  problemOf(path: string): string | null {
    return this.registry.problemOf(path)
  }

  // ── 朗读要用的那两件 · T-7.13（I-166）────────────────────

  /**
   * ★★ **朗读会先问哪一本** —— 判据只有这一处。
   *
   * 与卡片同一本（`defaultBook()`）：预热开的那一本必须正好是发音会问的那一本，
   * 否则预热就是白开一本书 —— 而两边各写一遍时，这种漂**不会报错**
   * （Android T-6.6 在 `db/dict.ts` 头上写着同一句话）。
   */
  private voiceBook(): DictRow | null {
    return this.registry.defaultBook().book
  }

  /**
   * ★★★ 朗读那一步现在**问得起吗** —— 「索引开好了没」。
   *
   * 开一本冷词典是同步的几百毫秒到几秒；同步代码堵住事件循环时，
   * `runVoicePlan` 那 150 ms 的预算连计时器都轮不上（A 量到 8963 / 14637 ms）。
   * 所以朗读不再赌运气：**没开好就当 miss**，让系统音立刻出声，
   * 并且顺手把预热踢起来（下一次点就是词典音了）。
   */
  voiceReady(): { ok: boolean; why?: string } {
    const book = this.voiceBook()
    if (!book) return { ok: false, why: '这台机器上还没有可用的词典' }
    /**
     * ★★★ 判据是「**预热跑完了没**」，不是「这本开着没」。
     *
     * 两者差着一次查词：实测开书只要 178 ms，而**这本书的第一次查词**还要 ~300 ms
     * （索引页解压 + `providers()` 那一圈）。只看「开着没」的话，
     * 预热开完、还没走完那一次查词的那个窗口里，他点下去仍要等 300 ms ——
     * 而完成标准是 200 ms。所以预热把那一次查词也走一遍，`prewarmed` 才置位。
     */
    if (!this.prewarmed) {
      // 没热好 —— 这一趟不等它，但把它踢起来（一次只跑一趟，见 prewarmVoice）
      this.prewarmVoiceSoon()
      return { ok: false, why: `「${book.bookname}」还在建索引，这次先用系统语音` }
    }
    if (!this.registry.isOpen(book.ifoPath)) {
      return { ok: false, why: `「${book.bookname}」这台机器上开不出来` }
    }
    return { ok: true }
  }

  /** 预热跑过没有 —— **一次只跑一趟**（Android T-6.6 同一条纪律） */
  private prewarming = false
  private prewarmed = false

  /** 把预热排到下一个空闲片刻去（绝不在别人的关键路径上同步开书） */
  private prewarmVoiceSoon(): void {
    if (this.prewarming || this.prewarmed) return
    setTimeout(() => {
      void this.prewarmVoice()
    }, 0)
  }

  /**
   * ★★ 预热：把**发音会先问的那一本**提前开好。
   *
   * ── 照 Android T-6.6 那一套 ────────────────────────────────
   *   · 每开一本先看表   —— 先读 `dictionaries` 那一行，不去猜
   *   · 只问有音频卷的书 —— 没有 `audio` 能力的书预热了也永远发不出音
   *   · 默认那本钉住     —— 开过就留在 `registry.open` 里（它本来就不逐出）
   *   · 一次只跑一趟     —— `prewarming` / `prewarmed` 两把闩
   *
   * ★ 失败只是「没预热成」：吞掉、如实带回 `err`，**绝不许影响任何别的事**。
   *   它不在任何人的关键路径上 —— 朗读那一步问的是 `voiceReady()`，
   *   预热没成就一直走系统音，不会有人在等它。
   */
  async prewarmVoice(): Promise<{
    book: string
    opened: boolean
    ms: number
    err: string | null
  } | null> {
    if (this.prewarming || this.prewarmed) return null
    const t0 = Date.now()
    const book = this.voiceBook()
    if (!book) return null
    // 先看表：这本有没有放得响的发音（`capabilities` 是 probe 时算好落库的）
    const rec = this.registry.records().find((r) => r.id === book.id)
    if (!rec || !rec.capabilities.includes('audio')) {
      this.prewarmed = true
      return { book: book.bookname, opened: false, ms: Date.now() - t0, err: '这本没有放得响的发音' }
    }
    if (this.registry.isOpen(book.ifoPath)) {
      this.prewarmed = true
      return { book: book.bookname, opened: false, ms: Date.now() - t0, err: null }
    }
    this.prewarming = true
    try {
      const ok = this.registry.handle(book.ifoPath) !== null
      /**
       * ★★ 开完还要**走一次和发音一模一样的那条路**（`others: false` 的富词条）。
       *
       * 开书 178 ms，而这本书的第一次查词还要 ~300 ms —— 那笔钱同样得在这里花掉，
       * 否则它就落在他点的第一下上。查哪个词不重要（`the` 哪本英语词典都有），
       * 要紧的是**走的是同一条路**：预热了另一条路等于没预热，而且不会报错。
       */
      /**
       * ★★★ 走到底：查一个词 → 挑一条发音 → **真的把字节取出来**。
       *
       * 三段各有各的冷开销，实测（他真库 · OALD10）：
       *   开书（mdx 索引）      178 ms
       *   第一次查词             ~46 ms
       *   **第一次取字节**      ~200 ms  ← `.mdd` 资源包是惰性开的（四卷 2.1 GB）
       * 少走任何一段，那一段的钱就落在他点的第一下上 ——
       * 只开书不查词是 306 ms，开书 + 查词还有 249 ms，全走完才是 3～5 ms。
       */
      if (ok) {
        const card = buildRichCard(this.registry, 'the', undefined, { others: false })
        const ref = pickDictAudio(
          card.refs.audio.filter((x) => typeof x === 'string' && x !== ''),
          'en-GB'
        )
        const parsed = ref ? parseMediaRef(ref) : null
        if (parsed) await this.registry.resource(parsed.bookUid, parsed.key)
      }
      this.prewarmed = true
      return {
        book: book.bookname,
        opened: ok,
        ms: Date.now() - t0,
        err: ok ? null : (this.registry.problemOf(book.ifoPath) ?? '开不出来')
      }
    } catch (e) {
      /**
       * ★ 预热炸了也要置位：`voiceReady()` 看的是这把闩，不置位的话
       *   词典音就再也轮不上了 —— 「预热失败」不该等于「从此没有词典音」。
       *   下一趟朗读会照常问 `isOpen()`，开不出来就如实说开不出来。
       */
      this.prewarmed = true
      return {
        book: book.bookname,
        opened: false,
        ms: Date.now() - t0,
        err: e instanceof Error ? e.message : String(e)
      }
    } finally {
      this.prewarming = false
    }
  }

  defaultBook(): { book: DictRow | null; wanted: DictRow | null; fellBack: boolean } {
    return this.registry.defaultBook()
  }

  setDefaultBook(id: number): void {
    this.registry.setDefaultBook(id)
  }

  closeAll(): void {
    this.registry.closeAll()
  }

  // ── 查词（老路径，D2 逐字不动，D3 换）────────────────────

  /**
   * 悬浮卡片要的那一份。
   *
   * 和 `lookup()` 的关系：`lookup()` 是**多本并列**（词条详情页的「N 本查到」
   * 和 D-150 捞例句都靠它）。这里是**单本**，因为卡片一次只显示一本。
   *
   * `others` 是「还有哪几本也收了这个词」，给选择器用 ——
   * 让他一眼看出换哪本有内容，而不是换过去才发现是空的。
   */
  lookupCard(word: string, bookId?: number): DictCard {
    const usable = this.registry.usable()
    const def = this.registry.defaultBook()
    const picked = (bookId ? usable.find((r) => r.id === bookId) : null) ?? def.book

    const out: DictCard = {
      word: word.trim(),
      headword: '',
      book: picked ? { id: picked.id, name: picked.bookname } : null,
      others: [],
      senses: [],
      raw: '',
      fellBackFrom: def.fellBack && def.wanted ? def.wanted.bookname : null
    }
    if (!picked || !out.word) return out

    const providers = this.registry.providersForLookup()
    const mine = providers.find((p) => p.row.id === picked.id)
    if (mine) {
      const r = coreLookup([mine.source], out.word, { maxBooks: 1, kinds: D3_KINDS })
      const hit = r.hits[0]
      if (hit) {
        const text = mine.text(hit.headword) ?? ''
        const parsed = parseEntry(text, hit.headword)
        out.headword = shownHeadword(hit)
        out.senses = parsed.senses
        out.raw = parsed.raw
        if (parsed.phonetic) out.phonetic = parsed.phonetic
        if (hit.redirectedFrom.length > 0) out.redirectedFrom = hit.redirectedFrom
      } else if (r.diagnostics.length > 0) {
        /**
         * 查不到正文、而且原因**不是**「这本没收这个词」——
         * 实际会出现的就一种：这本词典里的跳转坏了。
         * 不说的话界面只会显示「里没有这个词」，那是假话：词目就在那儿，
         * 是它指向的地方出了问题。他会去怀疑软件，而不是那本词典。
         */
        const d = r.diagnostics[0]
        out.diagnostic = { status: d.status, says: d.says }
      }
    }

    /**
     * 别的哪几本也有它 —— 只问「有没有」。
     *
     * ★★★ D5.2 · 这里原来是 `handle(...)?.legacyText(probe)` ——
     *   为了一个布尔值**把其余每一本都装载一遍**（建全量索引）。
     *   实测：其余 20 本 6542 ms，790 万条索引。
     *   `registry.hasWord()` 三档回答同一个问题，结果逐字相同。
     */
    const probe = out.headword || out.word
    for (const r of usable) {
      if (r.id === picked.id) continue
      if (this.registry.hasWord(r.ifoPath, probe)) out.others.push({ id: r.id, name: r.bookname })
    }
    return out
  }

  /**
   * 按优先级查一个词。返回**每一本**查到的结果，界面按顺序显示。
   * 查不到就是空数组 —— 查不到是常态，不是错误（D-262 说的是「失败要看得见」，
   * 而「这本词典没收这个词」不是失败）。
   */
  lookup(word: string, limit = 3): DictEntry[] {
    if (!word.trim()) return []
    /**
     * ★ 参与查词的是 `providers()`：启用着 + 文件在 + **同一个 uid 只出一本**，
     *   顺序就是他在设置页拖出来的顺序。
     *   而「哪一档候选词先试、整条命中是不是优先于词目命中」由 **core 的契约**
     *   说了算 —— 不是这里，更不是界面（他的验收第 8 条）。
     */
    const providers = this.registry.providersForLookup()
    const r = coreLookup(
      providers.map((p) => p.source),
      word,
      { maxBooks: limit, kinds: D3_KINDS }
    )

    const out: DictEntry[] = []
    for (const hit of r.hits) {
      const p = providers.find((x) => x.row.id === hit.book.id)
      const text = p?.text(hit.headword) ?? ''
      if (!text) continue
      out.push({
        bookname: hit.book.name,
        headword: shownHeadword(hit),
        text,
        ...(hit.redirectedFrom.length > 0 ? { redirectedFrom: hit.redirectedFrom } : {})
      })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * D-150 · 例句先从本地词典里找。
   * 词典正文里的例句多半是「以句号结尾、含有这个词、够长」的那些行。
   * 捞得保守一点 —— 宁可少给几条，也别把释义当成例句摆出来当样板。
   */
  examples(word: string, max = 3): { text: string; from: string }[] {
    /**
     * ══ D4 · 先要**结构化**的例句，要不到才退回捞行 ★★ ═══════
     *
     * 老办法是在压平后的文本里按「够长 + 含这个词 + 句号结尾」捞行 ——
     * 捞得再小心，也免不了把释义、词形表、栏目名当成例句摆出来当样板。
     * 而 `RichDictionaryEntry.senses[].examples` 是词典**自己标好**的例句
     *（`<x-g>` / `.exm` / `<ex>` 那些标签），不用猜。
     *
     * ★ 他的 R4：**只影响以后产生的新内容。**
     *   这条路只在分析新材料时被调用（`study.ts` 写 `analysis_blocks` 之前），
     *   已经写进库的那些一个字都不动 —— 重新捞是另一个动作，
     *   按 D-149 手动触发、且不覆盖他改过的块。这里不碰。
     */
    /**
     * ★ 结构化的排前面，**不够的再用老那条路补足** ——
     *   不是「有一条结构化的就不要别的了」。实测 `brunt`：
     *   牛津高阶10 只标了 1 条例句，而老那条路能从另外两本捞到 2 条好句子。
     *   只给 1 条是白丢东西。
     */
    const out = this.richExamples(word, max)
    if (out.length >= max) return out

    for (const e of this.lookup(word, 3)) {
      // 按**实际命中的词目**筛例句：查 `bear the brunt of` 落到 `brunt` 上时，
      // 例句里出现的是 brunt，拿整条去筛会一条都留不下
      const w = e.headword.toLowerCase()
      for (const line of e.text.split(/\n+/)) {
        const s = line.trim().replace(/^[•·*\-–—\d.)\s]+/, '')
        if (s.length < 25 || s.length > 220) continue
        if (!s.toLowerCase().includes(w)) continue
        if (!/[.!?]["')\]]?$/.test(s)) continue
        if (/^[A-Z]{2,}\b/.test(s)) continue // 词性标注那种全大写开头的行
        // 结构化那几条已经在 out 里了，别再补一遍（一条句子说两遍最烦）
        if (out.some((x) => x.text === s || x.text.includes(s) || s.includes(x.text))) continue
        out.push({ text: s, from: e.bookname })
        if (out.length >= max) return out
      }
    }
    return out
  }

  /**
   * 结构化例句 —— 词典自己标好的那些。
   *
   * ★ 判据仍然保守：太短的不要（`He swayed.` 当不了样板）、
   *   太长的不要、带 `@@@LINK` 的不要。宁可少给几条。
   */
  private richExamples(word: string, max: number): { text: string; from: string }[] {
    const out: { text: string; from: string }[] = []
    /**
     * ★ 「前三本」的判据是**前三本收了这个词的**，不是前三本词典 ——
     *   老那条路（`lookup(word, 3)`）就是这么算的。
     *   写成 `.slice(0, 3)` 的话，他排在最前的恰好是两本 LZO 读不了的，
     *   牛津高阶10 根本轮不上 —— 而那本才是例句最好的。
     */
    let books = 0
    for (const p of this.registry.providersForLookup()) {
      if (books >= 3 || out.length >= max) break
      let card
      try {
        card = buildRichCard(this.registry, word, p.row.id)
      } catch {
        continue
      }
      const e = card.entry
      if (!e) continue
      /**
       * ★★ **只信有画像的那几本。**
       *
       *   实测：《Longman Dictionary of Common Errors》整本是用法说明，
       *   通用兜底会把「When you say the date, use 'March the twenty-fifth'…」
       *   这种教学注释当成例句。它不是例句 —— 而 D-150 说例句是他要模仿的样板。
       *
       *   有画像 = D1 逐条量过这本词典的标签到底是什么意思（oald10 / ldoce6ec /
       *   ldoce5 / c21 四本）；没画像 = 通用兜底在猜。猜出来的东西不配当样板，
       *   那几本仍然走老那条「捞行」的路。
       */
      if (!card.profileId) {
        // 没画像的也算「这本收了这个词」—— 名额照占，和老那条路一致
        books++
        continue
      }
      books++
      const all = [...e.senses.flatMap((s) => s.examples), ...e.examples]
      /**
       * ★ 例句得**含有这个词**，而且得是**一句话**。
       *
       *   实测两条都会出事：
       *     · 不查词形 → 查 abandon 捞到
       *       「Since capital punishment was abolished, …」（整句没有 abandon）
       *     · 不查句子形状 → 查 brunt 捞到
       *       「the brunt of a battle(或an attack)」（那是搭配，不是例句）
       *   老那套捞行的判据里本来就有这两条，换成结构化例句之后**不能丢**。
       *
       *   词形用「前 70%」当词干，好让 sway 能配上 swayed、abandon 配上 abandoned。
       */
      const head = e.headword.toLowerCase()
      const stem = head.includes(' ') ? head : head.slice(0, Math.max(4, Math.ceil(head.length * 0.7)))
      for (const ex of all) {
        let t = ex.text.trim().replace(/\s+/g, ' ')
        /**
         * ★★ 「错句示范」绝不能当样板。
         *
         *   《Longman Dictionary of Common Errors》整本是 `×: 错的` / `√: 对的`
         *   成对写的，两行**都**被标成例句。把 `×` 那行摆出来让他模仿，
         *   等于教他写错 —— 而 D-150 说例句是他要去模仿的样板。
         *   实测：查 `the` 捞到的第一条就是 `×: She is arriving on March the 25th.`
         */
        if (/^[×✗]/.test(t) || /[×✗]\s*[:：]/.test(t)) continue
        t = t.replace(/^[√✓]\s*[:：]\s*/, '')
        /**
         * ★ 老那套捞行的判据**一条都不能松** —— 换成结构化例句只是换了来源，
         *   「什么算例句」的标准没有变。实测松了就会漏进来这些：
         *     · `abandon = give up a plan, activity or attempt…`（那是释义，不是例句）
         *     · `VERB TABLE`（全大写开头的栏目名）
         */
        if (t.length < 25 || t.length > 220) continue
        if (t.includes('@@@LINK')) continue
        if (/\s=\s/.test(t)) continue
        // ★ 2026-09-14 · 这里的 `\b` 曾被吃成字面退格字符，于是 `VERB TABLE` 那类
        //   全大写标题行**一直没被跳过**，会混进例句里。见 analyze.ts 那处的长注释。
        if (/^[A-Z]{2,}\b/.test(t)) continue
        if (!t.toLowerCase().includes(stem)) continue
        if (!/[.!?。！？]["')\]]?$/.test(t)) continue
        if (t.split(/\s+/).length < 4) continue
        if (out.some((x) => x.text === t)) continue
        out.push({ text: t, from: p.row.bookname })
        if (out.length >= max) return out
      }
    }
    return out
  }
}

export { DictionaryRegistry } from './registry.ts'
