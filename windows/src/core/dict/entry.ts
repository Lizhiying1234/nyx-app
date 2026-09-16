/**
 * RichDictionaryEntry · D1（2026-08-19）
 *
 * ── 一条设计原则，别的都从它推出来 ★★★ ───────────────────────
 *
 *     `text` 是 `html` 的**派生物**，不是它的替代品。
 *
 * 任何时候都可以从结构降级到纯文本；反过来永远不行。
 * 今天的 `DictEntry { bookname, headword, text }` 错就错在**只留了降级后的那一份** ——
 * 音标、发音、图片、对译、交叉引用在**类型层**就已经不存在了，
 * 后面所有环节（卡片、详情页、D-150 例句）都只能在那条压平的字符串上做正则。
 *
 * ── 中文对译为什么必须是独立字段 ★★ ─────────────────────────
 *
 * 实测 OALD10 的 `brunt`，压平之后是这么一行：
 *
 *     to receive the main force of something unpleasant承受某事的主要压力；首当其冲Schools
 *     will bear the brunt of cuts in government spending.政府削减开支，学校将首当其冲受到影响。
 *
 * 英文释义、中文对译、英文例句、中文译文，四样粘成一条。
 * 所以 `gloss` / `glossZh` 分开、`DictionaryExample.text` / `.zh` 分开 ——
 * **粘上就再也分不开了**，这是不可逆的损伤。
 *
 * ── 和 `DictEntry` 的关系 ────────────────────────────────────
 *
 * `@shared/api.ts` 里的 `DictEntry` / `DictCard` **一个字都不动**（D1 是纯新增）。
 * D4 接线时新增并行的 IPC，老的留着 —— 详情页那条「N 本查到」不该为这次改造停摆。
 */

import type { DictionaryCapability } from './capability.ts'
import type { DictionaryDiagnostic } from './diagnostics.ts'
import type { DictionaryMedia } from './media.ts'

/** 一本词典在结果里的标识 */
export interface DictionaryRef {
  /** 跨设备身份（`dict/identity.ts`）。跨机器引用**只能**用它 */
  uid: string
  /** 本地 surrogate。只在这台机器、这一次安装里有意义 */
  id: number
  name: string
}

export interface DictionaryPhonetic {
  region: 'uk' | 'us' | 'other'
  /** 音标本体，**不含**外面的 `/` 或 `[]` */
  ipa: string
  audio?: DictionaryMedia
}

export interface DictionaryExample {
  text: string
  /** 对译。★ 独立字段，绝不与 `text` 粘连 */
  zh?: string
  audio?: DictionaryMedia
  /**
   * 来源恒为 `dict`。留这个字段是为了和 D-150 的三种来源
   *（本地词典 / 联网搜索 / AI 生成）落在同一个形状上 ——
   * 「样板的可信度必须写在脸上」，那就不能靠调用方各自记得贴标签。
   */
  from: 'dict'
}

export interface DictionarySense {
  pos?: string
  /** 目标语释义 */
  gloss: string
  /** 中文对译 */
  glossZh?: string
  /** 用法标签：`[intransitive]` `[俚语]` `formal` … */
  labels: string[]
  examples: DictionaryExample[]
  media: DictionaryMedia[]
}

export type CrossRefKind = 'see' | 'inflection' | 'idiom' | 'synonym' | 'related'

export interface DictionaryCrossRef {
  /** `entry://run_2` → `run` */
  headword: string
  kind: CrossRefKind
  /** 界面上显示的字（可能与 `headword` 不同） */
  label: string
}

/**
 * 词源、用法框、搭配框这类整块内容。
 * **保留但可折叠**，不混进 `senses` —— 实测它们正是把「核心释义」挤掉的元凶
 *（`parseEntry` 抽出来的三条经常是 `Word Origin` / `Idioms` / `VERB TABLE`）。
 */
export interface DictionaryBox {
  title: string
  text: string
  kind: 'etymology' | 'idiom' | 'usage' | 'collocation' | 'other'
}

export interface RichDictionaryEntry {
  book: DictionaryRef
  /** 他选中的那串字，原样 */
  query: string
  /** 真正命中的词目 */
  headword: string
  /**
   * 跳过来的路径。`['children']` = 从 `children` 重定向到了这里。
   * 空数组 = 直接命中。★ 界面要显示它 —— 他查的是 `children`，
   * 看到的是 `child`，不说一句他会以为词典收错了。
   */
  redirectedFrom: string[]
  /** 同一词目在这本词典里有几条记录（同形异义）。1 = 只有一条 */
  homographs: number

  phonetics: DictionaryPhonetic[]
  senses: DictionarySense[]
  /** 不挂在任何义项下的例句 */
  examples: DictionaryExample[]
  crossRefs: DictionaryCrossRef[]
  boxes: DictionaryBox[]
  media: DictionaryMedia[]

  /** ★ 词典原始 HTML，一个字不删。渲染层放进 Shadow DOM（D4） */
  html: string | null
  /** ★ 降级视图。由结构化结果与保结构文本产出，**不是** `html` 的正则产物 */
  text: string

  /** 这一条**实际用到**的能力 = 书级 ∩ 本条解出来的 */
  capabilities: DictionaryCapability[]
  /** 解析到什么程度。完整成功时不带 */
  diagnostic?: DictionaryDiagnostic
}

/** 造一个空的（查不到 / 解不出时的形状）。**所有数组字段都不许是 undefined** */
export function emptyEntry(book: DictionaryRef, query: string): RichDictionaryEntry {
  return {
    book,
    query,
    headword: '',
    redirectedFrom: [],
    homographs: 0,
    phonetics: [],
    senses: [],
    examples: [],
    crossRefs: [],
    boxes: [],
    media: [],
    html: null,
    text: '',
    capabilities: []
  }
}

/**
 * 把结构化结果拼成一份人读的文本。
 *
 * ★ 这是 `text` 字段的**唯一**产法之一（另一条是完全没抽出结构时的
 *   `toStructuredText`）。**绝不**用正则去扒 `html` —— 那正是今天的病。
 */
export function renderEntryText(e: RichDictionaryEntry): string {
  const lines: string[] = []
  if (e.headword) {
    const ph = e.phonetics.map((p) => `/${p.ipa}/`).join(' ')
    lines.push(ph ? `${e.headword}  ${ph}` : e.headword)
  }
  for (const s of e.senses) {
    const head = [s.pos, ...s.labels].filter(Boolean).join(' ')
    lines.push(head ? `${head} ${s.gloss}` : s.gloss)
    if (s.glossZh) lines.push(`  ${s.glossZh}`)
    for (const ex of s.examples) {
      lines.push(`  · ${ex.text}`)
      if (ex.zh) lines.push(`    ${ex.zh}`)
    }
  }
  for (const ex of e.examples) {
    lines.push(`· ${ex.text}`)
    if (ex.zh) lines.push(`  ${ex.zh}`)
  }
  for (const b of e.boxes) lines.push(`【${b.title}】${b.text}`)
  if (e.crossRefs.length > 0) {
    lines.push(`→ ${e.crossRefs.map((x) => x.label || x.headword).join(' · ')}`)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
