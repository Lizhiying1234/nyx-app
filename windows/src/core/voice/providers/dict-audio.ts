/**
 * 词典发音：**从一条词条里挑哪一段音** · D-466
 *
 * ── 为什么是判据，不是随便取第一条 ──────────────────────────
 *
 * 一条像样的词条里通常有**两段以上**发音：英音一段、美音一段，
 * 有的还带词形变化（`brunt__gb_1.mp3` · `brunt__us_1.mp3` · `brunts__gb_1.mp3`）。
 * 取第一条 = 他把口音设成美音、听到的却是英音，而**没有任何东西会报错** ——
 * 他只会觉得「这个设置没用」。
 *
 * ★ 挑不出对的那一档时**退回第一条**，不是放弃：有一段音总比没有强，
 *   而口音不对是他一耳朵能发现、也能自己再点一次的事。
 * ★ 这一份判据两端共用：Assist 引擎那侧也按同一条挑（D-238）。
 *
 * ── ★★★ T-7.12（I-165）· 放不响的那些**在这里就挡掉** ──────
 *
 * LDOCE5 的词头音是 `GB_serendipity.spx`（字节 `OggS`，Speex 编码），
 * 而 Chromium 的 `canPlayType('audio/ogg; codecs=speex')` 回的是空串 ——
 * **换 MIME 也没用，是编解码器根本不支持**（A 2026-09-07 在真机上量的）。
 *
 * 不挡的后果不是「没声音」那么简单，是**账本说假话**：
 * 词典这一步报 hit、日志写「词典语音出的声」，而渲染层那边 `play()` 抛异常、
 * 落进保命兜底用系统音读了出来 —— 两边都说得通，谁也没报错。
 *
 * ★ 判据**不新写一份**：词典层早就有它（`dict/capability.ts::isPlayableAudioExt`，
 *   `makeMedia` 挂 `diagnostics.speex` 用的就是这一条）。语音这条路以前绕过了它，
 *   这里接回去 —— 「同一件事两份判据」是这个项目付过学费的那类病。
 * ★ **不引 Speex 解码库**（T-7.12 明写）：多一个解码器换来的是多一个装不上的依赖，
 *   而系统语音本来就读得出这个词。
 */

import { isPlayableAudioExt } from '../../dict/capability.ts'
import { extensionOf } from '../../dict/media.ts'

/** 英音那一档在文件名里的样子 —— 各家词典的花样，全小写比对 */
const GB = ['_gb', '-gb', 'gb_', 'uk', 'brit', '_bre', 'en_gb', 'en-gb']
/** 美音那一档 */
const US = ['_us', '-us', 'us_', 'ame', 'namer', 'en_us', 'en-us']

/**
 * 这些引用里，**浏览器真放得响**的是哪几条。
 *
 * ★ 判据借词典层那一份（`isPlayableAudioExt`）—— 不在这里另列一张扩展名表。
 */
export function playableDictAudio(refs: readonly string[]): string[] {
  return refs.filter(
    (r) => typeof r === 'string' && r !== '' && isPlayableAudioExt(extensionOf(keyOf(r)))
  )
}

/**
 * 有音、但一条都放不响时说的那句话（账本与 `nyx.log` 直接用它）。
 *
 * ★ 说得出**是什么格式**：他看到「Speex」才有可能去换一本词典，
 *   看到「没有发音」只会以为这个词词典里没有。
 */
export function unplayableDictSays(refs: readonly string[]): string {
  const exts = [...new Set(refs.map((r) => extensionOf(keyOf(r))).filter(Boolean))]
  const said = exts.length > 0 ? exts.map((e) => `.${e}`).join(' / ') : '未知格式'
  return `这本词典的发音是 ${said}（Speex 这类编码 Chromium 放不出来），这次用系统语音`
}

/**
 * 从这条词条的音频引用里挑一段。
 *
 * @param refs   `RichCard.refs.audio` —— 形状是 `bookUid|key`，这里只看 key 那半截
 * @param accent `tts.accent`（`en-GB` / `en-US`）
 * @returns 挑中的那个 ref；一条都没有、或者一条都放不响就是 `null`
 *          （**miss，不是错**；放不响那一种由 `unplayableDictSays` 说清楚）
 */
export function pickDictAudio(refs: readonly string[], accent: string): string | null {
  // ★★ 先挡掉放不响的，再挑口音 —— 顺序不能反：
  //    反了就会「挑中了一条英音的 .spx」，然后在渲染层静悄悄地失败
  const list = playableDictAudio(refs)
  if (list.length === 0) return null
  const want = accent.toLowerCase().includes('us') ? US : GB
  const other = want === US ? GB : US

  /**
   * ★ 先挑「明确是这一档的」，再排除「明确是另一档的」，最后才退回第一条。
   *   中间那一步不能省：一本词典可能只标了美音那一档
   *   （`brunt__us_1.mp3` + `brunt.mp3`），这时候后者才是英音那一段。
   */
  const hit = list.find((r) => want.some((k) => keyOf(r).includes(k)))
  if (hit) return hit
  const neutral = list.find((r) => !other.some((k) => keyOf(r).includes(k)))
  return neutral ?? list[0] ?? null
}

/** ref 是 `bookUid|key` —— 挑的时候只看 key 那半截，uid 里的字母不算数 */
function keyOf(ref: string): string {
  const i = ref.indexOf('|')
  return (i >= 0 ? ref.slice(i + 1) : ref).toLowerCase()
}
