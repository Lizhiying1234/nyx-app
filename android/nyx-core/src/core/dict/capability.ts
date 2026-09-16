/**
 * 词典能力 · D1（2026-08-19）
 *
 * ── 为什么不能假设所有词典都有所有能力 ★★ ────────────────────
 *
 * 实测使用者那 22 本（审计报告 §10）：
 *
 *   OALD10      音标英/美 · 27.4 万条 mp3 · 2009 张插图 · 中文对译 · 例句
 *   LDOCE5      有插图、有例句，**发音是 Speex，浏览器放不了**，没有中文
 *   21世纪大英汉  有中文对译，**一个音频、一张图都没有**
 *   TLD / UD    只有正文，音标都未必抽得出
 *
 * 界面如果按「词典 = 有发音」写，LDOCE5 上就会出现一个按下去没声音的喇叭。
 * 那是这个项目最贵的一类 bug —— 静默失效，他会以为是软件坏了。
 *
 * ── 判据：界面永远不问「有没有这个字段」，只问「有没有这个能力」★ ──
 *
 *     ✗  if (entry.phonetics.length)      ← 空数组的原因说不清：是没有，还是没解出来？
 *     ✓  if (has(entry.capabilities, 'phonetic'))
 *
 * 两级能力，都要：
 *
 *   **书级**（probe 时算，只读头部与资源清单，廉价）
 *       决定**设置页**显示什么 ——「这本词典有发音吗」
 *   **条目级**（decode 之后算）
 *       决定**卡片这一次**显示什么 ——「`brunt` 这一条有图吗」
 *
 * 只有书级 → 会出现「有发音按钮但这个词没有」。
 * 只有条目级 → 设置页在装载之前没法告诉他这本能干什么。
 */

export type DictionaryCapability =
  /** 有正文。所有词典都有 —— 它是「这本至少能查」的意思 */
  | 'text'
  /** 正文是结构化 HTML，可以富文本渲染（实测 22/22 的 `Format` 都是 `Html`） */
  | 'html'
  /** 能抽出音标 */
  | 'phonetic'
  /** 有**放得响**的发音。Speex 不算（见 `diagnostics.speex`） */
  | 'audio'
  /** 有词条配图 */
  | 'image'
  /** 能抽出成条的例句 */
  | 'example'
  /** 有中文对译（双解词典） */
  | 'translation'
  /** 有 `entry://` 交叉引用 */
  | 'crossReference'
  /** 用 `@@@LINK=` 做变体重定向（实测 OALD10 77.3%、朗文6 80.4%） */
  | 'redirect'
  /** 有独立的习语区 */
  | 'idiom'
  /** 有词源 */
  | 'etymology'

export const ALL_CAPABILITIES: readonly DictionaryCapability[] = [
  'text', 'html', 'phonetic', 'audio', 'image', 'example',
  'translation', 'crossReference', 'redirect', 'idiom', 'etymology'
]

export function has(caps: readonly DictionaryCapability[], c: DictionaryCapability): boolean {
  return caps.includes(c)
}

/** 排序后去重 —— 能力集要能直接比较、直接进库、直接进测试断言 */
export function normalizeCaps(caps: Iterable<DictionaryCapability>): DictionaryCapability[] {
  const seen = new Set(caps)
  return ALL_CAPABILITIES.filter((c) => seen.has(c))
}

/** 条目级能力 = 书级 ∩ 这一条实际解出来的 */
export function intersect(
  book: readonly DictionaryCapability[],
  entry: Iterable<DictionaryCapability>
): DictionaryCapability[] {
  const e = new Set(entry)
  return ALL_CAPABILITIES.filter((c) => book.includes(c) && e.has(c))
}

/** 算书级能力要的那点信息。**全部来自头部与文件清单，不解正文** */
export interface BookCapabilityInput {
  /** 头部的 `Format`：`Html` / `Text` */
  format?: string
  /** 资源包里出现过的扩展名（小写，不带点）：`mp3` `png` `spx` … */
  resourceExtensions?: readonly string[]
  /** 词表里出现过 `@@@LINK=`（probe 阶段抽样即可） */
  hasRedirects?: boolean
}

/**
 * 浏览器放得响的音频扩展名。
 *
 * ★ `spx`（Speex）**故意不在里面**。Chromium 早就移除了 Speex 解码 ——
 *   LDOCE5 的 18.4 万条发音全是这个格式。列进来 = 给一个按不响的按钮。
 */
const PLAYABLE_AUDIO = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'webm'])
const KNOWN_AUDIO = new Set([...PLAYABLE_AUDIO, 'spx', 'wma', 'amr', 'mid', 'midi'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

export function isPlayableAudioExt(ext: string): boolean {
  return PLAYABLE_AUDIO.has(ext.toLowerCase())
}

export function isAudioExt(ext: string): boolean {
  return KNOWN_AUDIO.has(ext.toLowerCase())
}

export function isImageExt(ext: string): boolean {
  return IMAGE.has(ext.toLowerCase())
}

/**
 * 书级能力。
 *
 * ★ 只给**结构性**的能力（正文形态、有没有资源、用不用重定向）。
 *   `phonetic` / `example` / `translation` / `idiom` / `etymology` 要解了正文才知道，
 *   它们由画像在 `decode` 阶段补上（见 `decode/profiles.ts` 的 `declares`）。
 *   这条边界很重要：probe 必须廉价（D5 的惰性装载全靠它），
 *   一旦为了算能力去解正文，惰性就白做了。
 */
export function bookCapabilities(input: BookCapabilityInput): DictionaryCapability[] {
  const caps = new Set<DictionaryCapability>(['text'])
  if ((input.format ?? '').toLowerCase().includes('html')) caps.add('html')
  for (const raw of input.resourceExtensions ?? []) {
    const ext = raw.toLowerCase()
    if (isPlayableAudioExt(ext)) caps.add('audio')
    if (isImageExt(ext)) caps.add('image')
  }
  if (input.hasRedirects) caps.add('redirect')
  return normalizeCaps(caps)
}

/**
 * 资源包里**有**音频、但一条都放不响 —— 需要一句诊断而不是静悄悄没有按钮。
 * 调用方（registry）拿它决定要不要挂 `diagnostics.speex(...)`。
 */
export function hasOnlyUnplayableAudio(resourceExtensions: readonly string[]): boolean {
  let sawAudio = false
  for (const raw of resourceExtensions) {
    const ext = raw.toLowerCase()
    if (isPlayableAudioExt(ext)) return false
    if (isAudioExt(ext)) sawAudio = true
  }
  return sawAudio
}
