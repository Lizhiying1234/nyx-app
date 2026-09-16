/**
 * 「这一段我已经收进 Nyx 了」—— 在原文里把它标出来（使用者 2026-09-13 · 4.4）
 *
 * 他的原话：
 * > 当我从文件中 Save 某个词、Chunk 或其他内容之后，这个已经收入 Nyx 的内容，
 * > 在原来的文件中也应该有明显的视觉标记……要求是：用户能够一眼看出来，
 * > 这个内容已经被收入 Nyx。
 *
 * ══ 这份文件只做一件事：把一段话切成「标 / 不标」两种块 ════════
 * 画成什么样（波浪线 · 颜色 · 粗细）是样式的事，不在这儿。
 * 判据放 core 是因为它**不是显示逻辑，是「哪一段算已收」的判断** ——
 * 标错了会让他以为某个词收过了（于是不收），那是数据层面的误导，不是难看。
 *
 * ══ 四条规则，每条都有一个具体的坏结果在后面 ═══════════════════
 *
 * ① **长的先标。** 收过 `run counter to` 又收过 `run`，先标短的话，
 *    长的那条就只剩两个零碎的尾巴 —— 屏上看起来像标歪了。
 * ② **英文不区分大小写，但要卡词边界。** 收过 `the` 之后整篇的
 *    `there` / `other` / `theme` 全被标上，那不是标记，那是噪音。
 *    ★ 只有**两端是 ASCII 字母 / 数字**的词才卡边界 —— 中文没有词边界，
 *      对中文卡边界等于一个都标不出来。
 * ③ **不许重叠。** 一个字符只属于一个标记块，先到先得（配合 ① = 长的先到）。
 * ④ **空白的、比整段还长的，一律跳过。** 它们标不出东西，只会白跑。
 */

export interface Seg {
  readonly text: string
  /** 这一块是不是「已经收进 Nyx 的」 */
  readonly saved: boolean
}

/** 两端是不是 ASCII 字母 / 数字 —— 是的话才需要卡词边界（规则②）*/
const WORDY = /[A-Za-z0-9]/

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && WORDY.test(c)
}

/**
 * 把一段话切成「标 / 不标」的块。
 *
 * @param paragraph 原文的一段
 * @param terms 已经收进库的那些词 / chunk（顺序无所谓，函数自己排）
 *
 * ★ **绝不抛**：标记是锦上添花，一段话标不出来最多是没标，
 *   不该把整篇文章带崩。
 */
export function markSaved(paragraph: string, terms: readonly string[]): Seg[] {
  const text = typeof paragraph === 'string' ? paragraph : ''
  if (!text) return []
  if (!Array.isArray(terms) || terms.length === 0) return [{ text, saved: false }]

  /**
   * ★ 小写副本必须和原文**等长**，否则下标全错。
   *   绝大多数字符 `toLowerCase()` 不改长度，但有例外（比如 `İ` → `i̇` 变两个）。
   *   长度一旦对不上就**退回大小写敏感**匹配 —— 少标几个，好过标到别处去。
   */
  const lower = text.toLowerCase()
  const caseOk = lower.length === text.length
  const hay = caseOk ? lower : text

  /** 每个字符被哪一段占了。`false` = 还空着 */
  const taken = new Array<boolean>(text.length).fill(false)

  // 规则①：长的先标；一样长的按字典序，只为让结果稳定可测
  const sorted = [...new Set(terms.filter((t) => typeof t === 'string'))]
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= text.length)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))

  for (const term of sorted) {
    const needle = caseOk ? term.toLowerCase() : term
    if (needle.length === 0) continue
    let from = 0
    while (from <= hay.length - needle.length) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      const end = at + needle.length
      from = at + 1

      // 规则②：两端是 ASCII 词字符的，必须卡在词边界上
      if (isWordChar(term[0]) && isWordChar(text[at - 1])) continue
      if (isWordChar(term[term.length - 1]) && isWordChar(text[end])) continue

      // 规则③：碰到已经被占的一个字符就整条放弃（不做部分标记）
      let free = true
      for (let i = at; i < end; i++) {
        if (taken[i]) {
          free = false
          break
        }
      }
      if (!free) continue

      for (let i = at; i < end; i++) taken[i] = true
      from = end
    }
  }

  // 把 taken 压成连续的块
  const out: Seg[] = []
  let i = 0
  while (i < text.length) {
    const flag = taken[i] === true
    let j = i + 1
    while (j < text.length && (taken[j] === true) === flag) j++
    out.push({ text: text.slice(i, j), saved: flag })
    i = j
  }
  return out
}
