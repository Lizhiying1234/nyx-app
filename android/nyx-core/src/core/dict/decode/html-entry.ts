/**
 * 词典正文 → RichDictionaryEntry · D1（2026-08-19）
 *
 * ══ 三段式，每一档都产出合法结果 ★★★ ════════════════════════
 *
 *   ① 画像命中   `profiles.ts` 认识这本 → 按它自己的 class/标签精确取
 *        ↓ 认不出，或者取不出释义
 *   ② 结构化兜底  按通用线索：`sound://` → 发音；`<img>` → 图；
 *                 IPA 字符 → 音标；像句子的行 → 例句
 *        ↓ 还是取不出
 *   ③ 保底       `html` 原样保留 + **保结构**的纯文本，`senses` 留空
 *
 * 三档的 `capabilities` 逐档变短，界面按 capability 决定显示什么，
 * 所以第 ③ 档也不会出现空白区块或假信息。
 *
 * ══ 「抽不出来就不抽」这条要继承下来 ★★ ══════════════════════
 *
 * `core/dict-entry.ts` 的注释写得很对：
 *
 *   > **抽不出来就不抽。** 卡片会原样显示 `raw`，他照样看得到内容。
 *   > 反过来 —— 猜一个释义标上去 —— 是这个功能最坏的失败方式：
 *   > 他信了，然后用错。**错的结构化结果比没有结构化结果更糟。**
 *
 * 这条一个字不改。变的只是**上游不再把结构丢掉**，于是「抽得出来」的比例大幅上升。
 *
 * ══ 中文对译怎么找到它的主人 ★ ═══════════════════════════════
 *
 * 两本词典把中文放在两个完全不同的位置：
 *
 *   朗文6   `<span class="def"><EN>英文</EN><TRAN>中文</TRAN></span>`     ← **里面**
 *   OALD10  `<span class="def">英文</span><defT><chn>中文</chn></defT>`   ← **兄弟**
 *
 * 所以不写两套逻辑，改成：把义项子树**按文档顺序摊成一串角色命中**，
 * 然后线性扫一遍，「中文」一律挂到**最近一个**释义或例句上。
 * 两种摆法都落在同一条规则下 —— 而且再来第三种摆法多半也落得下。
 */

import { type ElNode, type HtmlNode, walk } from '../html/parse.ts'
import { inlineText, toStructuredText } from '../html/text.ts'
import { parseHtml } from '../html/parse.ts'
import { pickProfile, type DictionaryProfile } from './profiles.ts'
import {
  type DictionaryCapability,
  intersect as _intersect,
  normalizeCaps
} from '../capability.ts'
import type { RawRecord } from '../contract.ts'
import {
  emptyEntry,
  renderEntryText,
  type DictionaryBox,
  type DictionaryCrossRef,
  type DictionaryExample,
  type DictionaryPhonetic,
  type DictionaryRef,
  type DictionarySense,
  type RichDictionaryEntry
} from '../entry.ts'
import { accentOf, makeMedia, normalizeResourceKey, type DictionaryMedia } from '../media.ts'

void _intersect // 保留导出以备 D4 用；能力交集在下面按结构/内容分开算，见 `entryCapabilities`

export interface DecodeInput {
  book: DictionaryRef
  /** 他选中的那串字 */
  query: string
  /** 真正命中的词目 */
  headword: string
  record: RawRecord
  /** 书级能力（`capability.ts::bookCapabilities`） */
  bookCapabilities: readonly DictionaryCapability[]
  /** 这个词目在这本里有几条记录 */
  homographs?: number
}

export type DecodeResult =
  /** 这条记录是个跳转。**跟随是 `lookup` 的事**（D3），解码层只负责认出来 */
  | { kind: 'redirect'; to: string }
  | { kind: 'entry'; entry: RichDictionaryEntry; tier: 1 | 2 | 3; profileId: string | null }

/**
 * `@@@LINK=目标词` —— MDict 的变体重定向标记。
 *
 * ★ 定义搬去了 `../lookup.ts`——**跟随**是查词语义，
 *   `contract.ts` 里那句「跟随是 `lookup.ts` 的事」就是说这个。
 *   这里 re-export 是为了让原来 import 它的地方一个字不用改 ——
 *   而两处各写一个正则会让「解码认得、查词不认得」，
 *   表现就是他偶尔看到一行 `@@@LINK=xxx`。
 */
import { detectRedirect } from '../lookup.ts'
export { detectRedirect }

/** 音标里必然出现的字符。判据收得紧：`[俚语]` 不是音标，`(现在分词)` 也不是 */
const IPA = /[ˈˌːəʌɪʊæɒɔɜɑθðʃʒŋɡɹɾʧʤ]/
const CJK = /[㐀-䶿一-鿿豈-﫿]/

/** 喇叭、箭头这类界面图标 —— 不是词条配图，不该算 `image` 能力 */
const UI_ICON = /spkr|snd_|sound|icon|arrow|btn|button|bullet|\bdot\b|blank|pixel/i

function isCjkHeavy(s: string): boolean {
  if (!s) return false
  const cjk = (s.match(/[一-鿿]/g) ?? []).length
  return cjk * 2 > [...s].length
}

// ── 角色命中：把子树摊成有序的一串 ────────────────────────────

type Role = 'def' | 'defZh' | 'example' | 'exampleZh' | 'pos' | 'label' | 'phonetic'

interface Hit {
  role: Role
  el: ElNode
}

/**
 * 按文档顺序收角色。
 *
 * ★ 命中之后**不再往里走**（除了释义/例句自己内部的原文与译文），
 *   否则朗文6 的 `<TRAN>` 会被当成独立的「中文」再命中一次，
 *   于是同一句译文出现两遍。
 */
/**
 * 找**最外层**的匹配元素 —— 命中之后不再往里走。
 *
 * ★ 义项容器会嵌套。实测 21 世纪那本用 `li.wordGroup` 同时表示
 *   「一个义项」和「一条短语」，而短语的 `li.wordGroup` 就套在义项的里面。
 *   不去重的话，内层的 `span.def` 会被外层和内层各收一次 ——
 *   实测 `brunt` 的 4 条释义变成了 8 条，而且**看不出哪四条是多的**
 *   （内容一模一样，只是重复）。
 */
function outermost(root: ElNode, pred: (el: ElNode) => boolean): ElNode[] {
  const out: ElNode[] = []
  const visit = (node: HtmlNode): void => {
    if (node.kind !== 'el') return
    if (pred(node)) { out.push(node); return }
    for (const c of node.children) visit(c)
  }
  for (const c of root.children) visit(c)
  return out
}

function collectHits(root: ElNode, p: DictionaryProfile, skip: (el: ElNode) => boolean): Hit[] {
  const out: Hit[] = []
  const visit = (node: HtmlNode): void => {
    if (node.kind !== 'el') return
    if (skip(node)) return
    const r = p.roles
    if (r.def(node)) { out.push({ role: 'def', el: node }); return }
    if (r.example(node)) { out.push({ role: 'example', el: node }); return }
    if (r.defZh(node) || r.exampleZh(node)) { out.push({ role: 'defZh', el: node }); return }
    if (r.phonetic(node)) { out.push({ role: 'phonetic', el: node }); return }
    if (r.pos(node)) { out.push({ role: 'pos', el: node }); return }
    if (r.label(node)) { out.push({ role: 'label', el: node }); return }
    for (const c of node.children) visit(c)
  }
  for (const c of root.children) visit(c)
  return out
}

/** 释义/例句自己内部的「原文」与「译文」（朗文6 那种摆法） */
function splitInner(el: ElNode, p: DictionaryProfile, which: 'def' | 'example'): { text: string; zh?: string } {
  const textM = which === 'def' ? p.roles.defText : p.roles.exampleText
  const zhM = which === 'def' ? p.roles.defZh : p.roles.exampleZh
  let text = ''
  let zh = ''
  for (const el2 of walk(el)) {
    if (!text && textM(el2)) text = inlineText(el2)
    else if (!zh && zhM(el2)) zh = inlineText(el2)
  }
  if (!text) {
    // 没有专门的原文标记 → 整块是原文，但要把译文那一段去掉
    const whole = inlineText(el)
    text = zh && whole.endsWith(zh) ? whole.slice(0, whole.length - zh.length).trim() : whole
  }
  return zh ? { text, zh } : { text }
}

/**
 * 一串角色命中 → 一组义项。
 *
 * 线性规则（见文件头「中文对译怎么找到它的主人」）：
 *   · 碰到释义 → 开一个新义项
 *   · 碰到例句 → 挂到当前义项；没有当前义项就进 `loose`
 *   · 碰到中文 → 挂到**最近一个**释义或例句上
 */
function buildSenses(hits: readonly Hit[], p: DictionaryProfile): {
  senses: DictionarySense[]
  loose: DictionaryExample[]
  phonetics: string[]
} {
  const senses: DictionarySense[] = []
  const loose: DictionaryExample[] = []
  const phonetics: string[] = []
  let pendingPos: string | undefined
  const pendingLabels: string[] = []
  /** 最近一个可以接中文的东西 */
  let lastZhTarget: { kind: 'sense'; s: DictionarySense } | { kind: 'example'; e: DictionaryExample } | null = null

  for (const h of hits) {
    if (h.role === 'pos') {
      const t = inlineText(h.el)
      // 「短语:」这种以冒号结尾的是栏目名，不是词性
      if (t && !/[:：]$/.test(t)) pendingPos = t
      continue
    }
    if (h.role === 'label') {
      const t = inlineText(h.el)
      if (t) pendingLabels.push(t)
      continue
    }
    if (h.role === 'phonetic') {
      const t = inlineText(h.el).replace(/^[[/]|[\]/]$/g, '').trim()
      if (t && !CJK.test(t)) phonetics.push(t)
      continue
    }
    if (h.role === 'def') {
      const { text, zh } = splitInner(h.el, p, 'def')
      if (!text) continue
      const s: DictionarySense = {
        ...(pendingPos ? { pos: pendingPos } : {}),
        gloss: text,
        ...(zh ? { glossZh: zh } : {}),
        labels: [...pendingLabels],
        examples: [],
        media: []
      }
      pendingLabels.length = 0
      senses.push(s)
      lastZhTarget = { kind: 'sense', s }
      continue
    }
    if (h.role === 'example') {
      const { text, zh } = splitInner(h.el, p, 'example')
      if (!text) continue
      const ex: DictionaryExample = { text, ...(zh ? { zh } : {}), from: 'dict' }
      const cur = senses[senses.length - 1]
      if (cur) cur.examples.push(ex)
      else loose.push(ex)
      lastZhTarget = { kind: 'example', e: ex }
      continue
    }
    // 中文：挂到最近一个
    const t = inlineText(h.el)
    if (!t || !lastZhTarget) continue
    if (lastZhTarget.kind === 'sense') {
      if (!lastZhTarget.s.glossZh) lastZhTarget.s.glossZh = t
    } else if (!lastZhTarget.e.zh) {
      lastZhTarget.e.zh = t
    }
  }
  return { senses, loose, phonetics }
}

// ── 媒体 / 交叉引用 / 框 ─────────────────────────────────────

function collectMedia(
  root: ElNode,
  bookUid: string,
  bookCaps: readonly DictionaryCapability[],
  profile: DictionaryProfile | null,
  skip: (el: ElNode) => boolean
): { media: DictionaryMedia[]; audioByRegion: Map<string, DictionaryMedia> } {
  const media: DictionaryMedia[] = []
  const audioByRegion = new Map<string, DictionaryMedia>()
  const seen = new Set<string>()
  const degraded = bookCaps.filter((c) => c !== 'audio')

  for (const el of walk(root)) {
    if (skip(el)) continue
    let raw = ''
    let label: string | undefined
    if (el.tag === 'a' && /^sound:/i.test(el.attrs['href'] ?? '')) {
      raw = el.attrs['href']!
      const href = normalizeResourceKey(raw)
      label = profile?.region?.(href, el.classes) ?? accentOf(href, el.classes)
    } else if (el.tag === 'img' && el.attrs['src']) {
      raw = el.attrs['src']
      if (UI_ICON.test(raw)) continue // 喇叭图标不是词条配图
      label = el.attrs['alt']
    } else {
      continue
    }
    const m = makeMedia(bookUid, raw, { ...(label ? { label } : {}), degradedTo: degraded })
    if (!m || seen.has(m.ref)) continue
    seen.add(m.ref)
    media.push(m)
    if (m.kind === 'audio' && m.label && !audioByRegion.has(m.label)) audioByRegion.set(m.label, m)
  }
  return { media, audioByRegion }
}

function collectCrossRefs(root: ElNode, skip: (el: ElNode) => boolean): DictionaryCrossRef[] {
  const out: DictionaryCrossRef[] = []
  const seen = new Set<string>()
  for (const el of walk(root)) {
    if (skip(el)) continue
    const href = el.attrs['href'] ?? ''
    if (el.tag !== 'a' || !/^entry:/i.test(href)) continue
    // `entry://run_2` → `run`；尾巴上的 `_2` 是义项序号，不是词的一部分
    const target = href.replace(/^entry:\/*/i, '').split('#')[0]!.replace(/_\d+$/, '').trim()
    if (!target) continue
    const label = inlineText(el) || target
    const key = `${target}\u0000${label}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ headword: target, kind: kindOfRef(label), label })
  }
  return out
}

function kindOfRef(label: string): DictionaryCrossRef['kind'] {
  if (/past tense|past participle|plural of|present participle|comparative|superlative/i.test(label)) {
    return 'inflection'
  }
  if (/synonym/i.test(label)) return 'synonym'
  return 'see'
}

function collectBoxes(root: ElNode, p: DictionaryProfile | null, skip: (el: ElNode) => boolean): DictionaryBox[] {
  if (!p) return []
  const out: DictionaryBox[] = []
  for (const el of walk(root)) {
    if (skip(el) || !p.roles.box(el)) continue
    let title = ''
    for (const c of walk(el)) {
      if (p.roles.boxTitle(c)) { title = inlineText(c); break }
    }
    const whole = inlineText(el)
    const text = title && whole.startsWith(title) ? whole.slice(title.length).trim() : whole
    if (!text) continue
    out.push({ title: title || '说明', text, kind: boxKind(title) })
  }
  return out
}

function boxKind(title: string): DictionaryBox['kind'] {
  if (/origin|词源|etymolog/i.test(title)) return 'etymology'
  if (/idiom|习语/i.test(title)) return 'idiom'
  if (/colloc|搭配/i.test(title)) return 'collocation'
  if (/usage|用法/i.test(title)) return 'usage'
  return 'other'
}

// ── 第 ② 档 · 结构化兜底 ─────────────────────────────────────

/** 从**保结构**的文本里找音标。只看前几行 —— 靠后的括号多半在例句里 */
function findPhoneticInText(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n').slice(0, 8)) {
    for (const m of line.matchAll(/[[/]([^[\]/\n]{2,40})[\]/]/g)) {
      const body = m[1]!.trim()
      if (!body || CJK.test(body)) continue
      if (!IPA.test(body) && !/['ˈ]/.test(body)) continue
      if (!out.includes(body)) out.push(body)
    }
  }
  return out
}

/** 一行看着像不像例句 */
function looksLikeExample(s: string): boolean {
  if (s.length < 20 || s.length > 240) return false
  if (!/[.!?。！？]["')\]]?$/.test(s)) return false
  if (/^[A-Z]{2,}\b/.test(s)) return false // 全大写开头的栏目名
  return true
}

/**
 * 光秃秃的词性，自己成一行。
 * ★ 它**不是释义** —— 现行 `parseEntry` 把 `noun` `[verb] /sweɪ/` 这类
 *   当成「核心释义」摆到第一屏，实测四本词典四个词抽出的 12 条里没有一条是释义。
 */
const BARE_POS =
  /^(n|v|vt|vi|adj|adv|prep|conj|pron|int|interj|aux|abbr|num|art)\.?$|^(noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|determiner)$/i

/** 一行看着像不像释义 */
function looksLikeGloss(s: string): boolean {
  if (s.length < 2 || s.length > 300) return false
  if (/^\d+$/.test(s)) return false
  if (/^[A-Z]{2,}\d+$/.test(s)) return false // TLD 的 VERB60267282
  if (BARE_POS.test(s)) return false
  if (/^(jump to other results|word origin|examples?|verb table|verb forms)$/i.test(s)) return false
  return true
}

// ── 能力 ────────────────────────────────────────────────────

/**
 * 条目级能力。
 *
 * ★ 分两类，不是一刀切的交集：
 *   **结构能力**（`audio` / `image` / `html` / `text` / `redirect`）要**书级也有**——
 *     正文里写着 `sound://x.mp3`，但 `.mdd` 根本不在（RESOURCE_MISSING）时，
 *     不许声称有发音。
 *   **内容能力**（音标 / 例句 / 对译 / 交叉引用 / 习语 / 词源）纯粹由这一条决定 ——
 *     书级算不出它们（算它们就要解正文，probe 的廉价就没了，见 `contract.ts`）。
 */
const STRUCTURAL = new Set<DictionaryCapability>(['text', 'html', 'audio', 'image', 'redirect'])

function entryCapabilities(
  found: Iterable<DictionaryCapability>,
  book: readonly DictionaryCapability[]
): DictionaryCapability[] {
  const out: DictionaryCapability[] = []
  for (const c of new Set(found)) {
    if (STRUCTURAL.has(c) && !book.includes(c)) continue
    out.push(c)
  }
  return normalizeCaps(out)
}

// ── 主入口 ──────────────────────────────────────────────────

export function decodeEntry(input: DecodeInput): DecodeResult {
  const body = input.record.body ?? ''
  const to = input.record.redirectTo ?? detectRedirect(body)
  if (to) return { kind: 'redirect', to }

  const entry = emptyEntry(input.book, input.query)
  entry.headword = input.headword
  entry.homographs = input.homographs ?? 1

  if (input.record.shape !== 'html') {
    // 纯文本正文（StarDict 的 `m` 类型）—— 没有结构可抽，直接进第 ③ 档
    entry.text = body.trim()
    entry.capabilities = entryCapabilities(['text'], input.bookCapabilities)
    return { kind: 'entry', entry, tier: 3, profileId: null }
  }

  entry.html = body
  const root = parseHtml(body)
  const profile = pickProfile(body)
  const skip = profile ? (el: ElNode): boolean => profile.roles.noise(el) : (): boolean => false

  // ── 通用部分：媒体、交叉引用、框、保结构文本 ────────────────
  const { media, audioByRegion } = collectMedia(root, input.book.uid, input.bookCapabilities, profile, skip)
  entry.media = media
  entry.crossRefs = collectCrossRefs(root, skip)
  entry.boxes = collectBoxes(root, profile, skip)

  const structured = toStructuredText(root, {
    ...(profile ? { isBlock: (el: ElNode): boolean | undefined => (profile.roles.block(el) ? true : undefined) } : {}),
    skip
  })

  const found = new Set<DictionaryCapability>(['text', 'html'])
  for (const m of media) {
    if (m.kind === 'audio' && !m.unavailable) found.add('audio')
    if (m.kind === 'image') found.add('image')
  }
  if (entry.crossRefs.length > 0) found.add('crossReference')
  for (const b of entry.boxes) {
    if (b.kind === 'etymology') found.add('etymology')
    if (b.kind === 'idiom') found.add('idiom')
  }

  // ── 第 ① 档 · 画像 ────────────────────────────────────────
  let tier: 1 | 2 | 3 = 3
  let phonetics: string[] = []
  if (profile) {
    const senseRoots = outermost(root, (el) => !skip(el) && profile.roles.sense(el))
    const hits: Hit[] = senseRoots.length > 0
      ? senseRoots.flatMap((r) => collectHits(r, profile, skip))
      : collectHits(root, profile, skip)
    /**
     * ★ 音标和词性常常在**义项外面**（词头那一行）。
     *   实测 OALD10：`<span class="pos">noun</span>` 在 `div.webtop` 里，
     *   而义项在 `li.sense` 里 —— 只收义项子树的话，所有释义都没有词性。
     *   只补这三种角色：释义和例句不能从外面收，否则会和义项内的重复。
     */
    const outer = collectHits(root, profile, skip).filter(
      (h) => h.role === 'phonetic' || h.role === 'pos' || h.role === 'label'
    )
    const built = buildSenses([...outer, ...hits], profile)
    phonetics = built.phonetics
    if (built.senses.length > 0) {
      entry.senses = built.senses
      entry.examples = built.loose
      tier = 1
    } else if (built.loose.length > 0) {
      /**
       * ★ 画像认得例句、但认不出释义 —— LDOCE5 就是这样（它一个 class 都没有，
       *   只有 `<ex>`）。例句留着，释义交给第 ② 档，**档位记 2 不记 1**：
       *   `tier` 说的是「结构化到什么程度」，有例句没释义不算第 ① 档。
       */
      entry.examples = built.loose
    }
  }

  // ── 第 ② 档 · 结构化兜底 ──────────────────────────────────
  if (tier !== 1) {
    if (phonetics.length === 0) phonetics = findPhoneticInText(structured)

    // 画像认得例句就用它的（LDOCE5 的 `<ex>`），否则从文本里认。
    // 上面第 ① 档已经收过就直接用，**不要再收一遍** —— 会出重复例句
    const exFromProfile: DictionaryExample[] = [...entry.examples]
    if (exFromProfile.length === 0 && profile) {
      for (const el of walk(root)) {
        if (skip(el) || !profile.roles.example(el)) continue
        const t = inlineText(el)
        if (t) exFromProfile.push({ text: t, from: 'dict' })
      }
    }

    /**
     * ★ 词头那一行不是释义。
     *   不能只靠传进来的 `headword` 比 —— 词典里印的词头常常和查询词不一样
     *   （大小写、连字符、`de‧te‧ri‧o‧rate` 这种带分隔点的）。
     *   画像认得词头元素时，用它印的那个字去比，稳得多。
     */
    let headwordText = ''
    if (profile) {
      for (const el of walk(root)) {
        if (skip(el) || !profile.roles.headword(el)) continue
        headwordText = inlineText(el)
        break
      }
    }

    const lines = structured.split('\n').map((l) => l.trim()).filter(Boolean)
    const exText = new Set(exFromProfile.map((e) => e.text))
    const hw = input.headword.trim().toLowerCase()
    const glossLines: string[] = []
    const exLines: DictionaryExample[] = []
    for (const line of lines) {
      if (exText.has(line)) continue
      /**
       * ★ 「词头 + 音标」那一行不是释义。
       *   实测 LDOCE5 的第一行是 `brunt /brʌnt/` —— 直接比 headword 比不掉它，
       *   所以先把已认出的音标从行里剔掉，再看剩下的是不是词头。
       */
      let bare = line
      for (const p of phonetics) bare = bare.split(`/${p}/`).join(' ').split(`[${p}]`).join(' ').split(p).join(' ')
      bare = bare.replace(/[\s/[\]|,·•]+/g, ' ').trim()
      if (!bare) continue
      if (bare.toLowerCase() === hw) continue
      if (headwordText && bare === headwordText) continue
      if (line.toLowerCase() === hw) continue
      if (headwordText && line === headwordText) continue
      if (looksLikeExample(line)) { exLines.push({ text: line, from: 'dict' }); continue }
      if (glossLines.length < 3 && looksLikeGloss(line)) glossLines.push(line)
    }

    if (glossLines.length > 0) {
      entry.senses = glossLines.map((g) => ({
        gloss: g,
        ...(isCjkHeavy(g) ? {} : {}),
        labels: [],
        examples: [],
        media: []
      }))
      tier = 2
    }
    entry.examples = [...exFromProfile, ...exLines].slice(0, 8)
    if (entry.examples.length > 0 && tier === 3) tier = 2
  }

  // ── 收尾 ──────────────────────────────────────────────────
  entry.phonetics = phonetics.slice(0, 4).map((ipa, i): DictionaryPhonetic => {
    const region: 'uk' | 'us' | 'other' = i === 0 ? 'uk' : i === 1 ? 'us' : 'other'
    const audio = audioByRegion.get(region)
    return { region, ipa, ...(audio ? { audio } : {}) }
  })
  if (entry.phonetics.length > 0) found.add('phonetic')
  if (entry.senses.some((s) => s.examples.length > 0) || entry.examples.length > 0) found.add('example')
  if (entry.senses.some((s) => s.glossZh) || entry.examples.some((e) => e.zh)) found.add('translation')
  if (entry.senses.some((s) => s.examples.some((e) => e.zh))) found.add('translation')

  entry.capabilities = entryCapabilities(found, input.bookCapabilities)
  const rendered = renderEntryText(entry)
  // ★ 结构抽得出来就用结构拼；抽不出来才落回保结构文本。**永远不用正则扒 html**
  entry.text = tier === 3 || rendered.length < 8 ? structured : rendered
  return { kind: 'entry', entry, tier, profileId: profile?.id ?? null }
}
