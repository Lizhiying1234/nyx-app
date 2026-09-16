/**
 * 词典画像 · D1（2026-08-19）
 *
 * ── 这些画像全部是**数出来的**，不是猜的 ★★★ ─────────────────
 *
 * 审计时把使用者真实的四本词典 dump 出来，统计每本的标签与 class 频次，
 * 再逐个看结构。**几条关键的，猜一百次也猜不到：**
 *
 *   朗文6   `<span class="def"><EN>英文释义</EN><TRAN>中文对译</TRAN></span>`
 *           `<span class="example"><EXAEN>英文例句</EXAEN><EXAMPLE>中文译文</EXAMPLE></span>`
 *           ★ `<EXAMPLE>` 装的是**中文**，不是例句
 *           ★ `<deft></deft>` `<exat></exat>` `<l6></l6>` 是**空分隔标签**，不装内容
 *
 *   OALD10  `<span class="def">…</span><defT><chn>中文</chn></defT>`
 *           `<span class="x">例句</span><xT><chn>译文</chn></xT>`
 *           ★ 中文挂在自定义标签 `chn` 上，`def`/`x` 的**兄弟**位置
 *
 *   21世纪   `<span class="pos">短语:</span>` ← 这是**栏目名**，不是词性
 *           真正的词性在 `<span class="pos-list-list">n.</span>`
 *           ★ 按名字想当然会把「短语:」当成词性贴到释义上
 *
 *   LDOCE5  **一个 class 都没有**。只有 `<ex>` `<b>` `<font>` `<img>`。
 *           所以它的画像是**按标签**认的，能力也天然比别的少。
 *
 * ── 画像的定位：第 ① 档，允许没有 ★ ──────────────────────────
 *
 * 三段式解码（见 `html-entry.ts`）里，画像是**最好的那一档**，不是唯一那一档。
 * 认不出的词典走结构化兜底、再兜不住走保底 —— 每一档都产出合法结果，
 * 只是 `capabilities` 逐档变短。所以**画像写错的代价是「这本降级」，不是「这本炸掉」**。
 *
 * 他有 22 本，将来还会加。逐本写规则不可维护 —— 画像只服务最主力的那几本。
 */

import { type ElNode, hasClass } from '../html/parse.ts'
import type { DictionaryCapability } from '../capability.ts'

/** 判断一个元素是不是某个角色 */
export type Matcher = (el: ElNode) => boolean

export const tag = (name: string): Matcher => (el) => el.tag === name
export const cls = (name: string): Matcher => (el) => hasClass(el, name)
export const tagCls = (t: string, c: string): Matcher => (el) => el.tag === t && hasClass(el, c)
export const any = (...ms: readonly Matcher[]): Matcher => (el) => ms.some((m) => m(el))
export const none: Matcher = () => false

export interface ProfileRoles {
  /** 一个义项的容器 */
  sense: Matcher
  /** 目标语释义 */
  def: Matcher
  /** 释义里的英文部分（朗文6 的 `<EN>`）。没有就整块当释义 */
  defText: Matcher
  /** 释义的中文对译 */
  defZh: Matcher
  /** 例句容器 */
  example: Matcher
  /** 例句里的原文部分（朗文6 的 `<EXAEN>`） */
  exampleText: Matcher
  /** 例句的中文译文 */
  exampleZh: Matcher
  /** 音标 */
  phonetic: Matcher
  /** 词性 */
  pos: Matcher
  /** 用法标签 */
  label: Matcher
  /** 词头 */
  headword: Matcher
  /** 可折叠的框（词源 / 用法 / 搭配） */
  box: Matcher
  /** 框的标题 */
  boxTitle: Matcher
  /** 整棵子树都不要 —— 栏目按钮、"jump to other results" 这类 */
  noise: Matcher
  /** 这些 span 是语义块，摊平成文本时要各占一行（见 `html/text.ts`） */
  block: Matcher
}

export interface DictionaryProfile {
  id: string
  says: string
  /** 认这本词典。**用正文特征认，不用 Title** —— Title 会被重打包的人改掉 */
  detect: (html: string) => boolean
  /** 这本画像能提供的内容能力。结构能力（audio/image）由书级算 */
  declares: readonly DictionaryCapability[]
  roles: ProfileRoles
  /** 判 uk/us。拿音频的 href 与 class 一起判 */
  region?: (href: string, classes: readonly string[]) => 'uk' | 'us' | 'other' | undefined
}

const EMPTY_ROLES: ProfileRoles = {
  sense: none, def: none, defText: none, defZh: none,
  example: none, exampleText: none, exampleZh: none,
  phonetic: none, pos: none, label: none, headword: none,
  box: none, boxTitle: none, noise: none, block: none
}

const roles = (over: Partial<ProfileRoles>): ProfileRoles => ({ ...EMPTY_ROLES, ...over })

// ── OALD10 · 牛津高阶第 10 版（他的默认词典）──────────────────

const oald10: DictionaryProfile = {
  id: 'oald10',
  says: '牛津高阶英汉双解（第 10 版）',
  detect: (h) => h.includes('class="oald"') || h.includes('id="entryContent"'),
  declares: ['phonetic', 'example', 'translation', 'crossReference', 'idiom', 'etymology'],
  roles: roles({
    sense: tagCls('li', 'sense'),
    def: tagCls('span', 'def'),
    defZh: tag('chn'),
    example: any(tagCls('span', 'x'), tagCls('span', 'unx')),
    exampleZh: tag('chn'),
    phonetic: tagCls('span', 'phon'),
    pos: tagCls('span', 'pos'),
    label: any(cls('labels'), cls('grammar'), cls('geo'), cls('cf')),
    headword: tagCls('h1', 'headword'),
    box: cls('unbox'),
    boxTitle: cls('box_title'),
    // `jump to other results` / 跳转链 —— 实测它们会被当成「释义」摆到第一屏
    noise: any(cls('link-right'), cls('jumplinks'), cls('jumplink'), cls('responsive_display_inline_on_smartphone')),
    block: any(tagCls('span', 'def'), tagCls('span', 'x'), tagCls('span', 'unx'), tag('chn'), tag('deft'), tag('xt'))
  }),
  /**
   * ★ 例句朗读要**先**认出来。OALD 的例句音频是 `_brunt__gbs_1.mp3`
   *   （前导下划线 + `gbs`），里面含有 `__gb` —— 先判 `__gb` 就会把
   *   例句朗读当成词头发音，D4 的界面会把它挂到音标上，按下去读的是整句。
   */
  region: (href, classes) => {
    if (/__gbs_|__uss_|\\exa\\|_sfx/.test(href)) return 'other'
    if (classes.includes('pron-uk')) return 'uk'
    if (classes.includes('pron-us')) return 'us'
    if (/__gb/.test(href)) return 'uk'
    if (/__us/.test(href)) return 'us'
    return undefined
  }
}

// ── 朗文当代高级英语辞典（第 6 版）英汉双解 ────────────────────

const ldoce6ec: DictionaryProfile = {
  id: 'ldoce6ec',
  says: '朗文当代高级英语辞典（第 6 版）英汉双解',
  detect: (h) => h.includes('ldoce6ec') || (h.includes('<exat>') && h.includes('class="hwd"')),
  declares: ['phonetic', 'example', 'translation', 'idiom', 'etymology'],
  roles: roles({
    sense: tagCls('span', 'sense'),
    def: tagCls('span', 'def'),
    // ★ `<EN>` 是英文释义，`<TRAN>` 是中文 —— 两个都在 `span.def` 里面
    defText: tag('en'),
    defZh: tag('tran'),
    example: tagCls('span', 'example'),
    // ★ `<EXAEN>` 是英文例句，`<EXAMPLE>` 装的是**中文**（名字是反的）
    exampleText: tag('exaen'),
    exampleZh: tag('example'),
    // ★ 只认 `span.pron`。`span.proncodes` 把外面那对 `/` 也裹进来了
    phonetic: tagCls('span', 'pron'),
    pos: tagCls('span', 'pos'),
    label: any(cls('lexunit'), cls('gram'), cls('register')),
    headword: tagCls('span', 'hwd'),
    box: cls('unbox'),
    boxTitle: cls('secheading'),
    /**
     * ★ 弹出层的栏目名就是实测里污染最重的那几条 ——
     *   `EXAMPLES FROM THE CORPUS` / `WORD ORIGIN` / `VERB TABLE`
     *   被 `parseEntry` 当成「核心释义」摆在了第一屏。
     *   注意只丢**栏目名**，不丢 `ul.exas` 里真正的例句。
     */
    noise: any(
      cls('popup-button'), cls('popheader'), cls('popexa'), cls('popcollo'),
      cls('arrow'), cls('expandable'), cls('hyphenation'), cls('neutral'),
      tag('atl'), tag('cnt')
    ),
    block: any(tagCls('span', 'def'), tagCls('span', 'example'), tag('en'), tag('tran'), tag('exaen'), tag('example'))
  }),
  region: (href) => {
    if (/\bbre\b|\/bre\/|\\bre\\/.test(href)) return 'uk'
    if (/\bame\b|\/ame\/|\\ame\\/.test(href)) return 'us'
    return undefined
  }
}

// ── LDOCE5 全英 · 一个 class 都没有，只能按标签认 ───────────────

const ldoce5: DictionaryProfile = {
  id: 'ldoce5',
  says: '朗文当代英语辞典（第 5 版，全英）',
  /** 它的特征是 `<ex>` 标签 + `snd_uk.png` 那套喇叭图 */
  detect: (h) => h.includes('<ex>') && (h.includes('snd_uk.png') || h.includes('snd_us.png')),
  /**
   * ★ 只声明 `example`。
   *   · 没有中文（全英本），所以没有 `translation`
   *   · 发音全是 `.spx`，浏览器放不了 —— `audio` 由书级判掉，这里不声明
   *   · 释义没有任何标记，交给第 ② 档结构化兜底
   */
  declares: ['example'],
  roles: roles({
    example: tag('ex'),
    exampleText: tag('ex'),
    headword: tag('b'),
    block: tag('ex')
  }),
  region: (href) => {
    if (/^\\?gb_|\bgb_/i.test(href) || /snd_uk/.test(href)) return 'uk'
    if (/^\\?us_|\bus_/i.test(href) || /snd_us/.test(href)) return 'us'
    return undefined
  }
}

// ── 21 世纪大英汉词典 ────────────────────────────────────────

const c21: DictionaryProfile = {
  id: 'c21',
  says: '21 世纪大英汉词典',
  detect: (h) => h.includes('21century_dict') || h.includes('id="authDictTrans"'),
  /** 英汉词典：释义本身就是中文，所以不额外声明 `translation` */
  declares: ['phonetic', 'example'],
  roles: roles({
    sense: tagCls('li', 'wordGroup'),
    def: tagCls('span', 'def'),
    phonetic: tagCls('span', 'phonetic'),
    /**
     * ★★ 词性在 `span.pos-list-list`，**不是** `span.pos`。
     *    `span.pos` 装的是「短语:」「形近词:」这类**栏目名** ——
     *    按名字想当然会把「短语:」当成词性贴到释义前面。
     */
    pos: tagCls('span', 'pos-list-list'),
    headword: tagCls('h4', 'wordGroup'),
    example: tagCls('div', 'phrases_eng'),
    exampleZh: tagCls('div', 'phrases_trans'),
    noise: any(cls('show_more'), cls('show_less'), cls('search-js'), cls('more_sp'), tagCls('a', 'sp')),
    block: any(tagCls('span', 'def'), tagCls('div', 'phrases_eng'), tagCls('div', 'phrases_trans'))
  })
}

/** 认得的画像。顺序无关 —— `detect` 互斥（实测四本各自的特征都不重叠） */
export const PROFILES: readonly DictionaryProfile[] = [oald10, ldoce6ec, ldoce5, c21]

export function pickProfile(html: string): DictionaryProfile | null {
  for (const p of PROFILES) {
    try {
      if (p.detect(html)) return p
    } catch {
      /* 画像的 detect 绝不能让整条查词炸掉 */
    }
  }
  return null
}

export const profileById = (id: string): DictionaryProfile | undefined =>
  PROFILES.find((p) => p.id === id)
