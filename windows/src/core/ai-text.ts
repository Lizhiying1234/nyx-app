/**
 * AI 写出来的那几段字，屏上怎么显示 —— **两端一份**（使用者 2026-09-15 真机点名）
 *
 * ══ 病是什么 ═══════════════════════════════════════════════
 *
 * 产出题的题面是 AI 写的，而它会写 markdown：
 *
 *     Use the target expression **rummaging** (be rummaging through something).
 *
 * 两端都是纯文本渲染（`{q.prompt}`），于是**那两对星号原样印在屏幕上**。
 * 不是哪一端的 bug —— Nyx-UI-Android 在真机上发现，两处一核，Windows 一模一样。
 *
 * ══ 为什么判据在 core ★★★ ═══════════════════════════════════
 *
 * 「题面里的 `**x**` 是强调」是一条**判据**，不是排版偏好。各端各写一份的话：
 * 同一道题在电脑上是粗体、在手机上是星号，或者两端的转义规则差一点 ——
 * **两边都说得通、都不报错**，而他只会以为是模型这次写得怪。
 *
 * ══ 为什么回「段」而不是 HTML ★★★ ═══════════════════════════
 *
 * 这段字是 **AI 写的内容**。回一串 HTML 的话，两端各自得保证转义正确，
 * 而**转义漏一处就是注入**（`{@html}` 那条路上没有第二道闸）。
 * 回结构化的段之后，两端各用自己的模板画 —— 谁都不需要 `{@html}`，
 * 这条路上就没有「漏转义」这种失败形态。
 * （这一条是 Nyx-UI-Android 提的，理由成立，原样采纳。）
 *
 * ══ 它只治存量 ★ ═══════════════════════════════════════════
 *
 * 真正的修法有两条，**两条都要**：
 *   ① 源头：`prompts/generate-questions.md` 里说清「`prompt` 字段写纯文本」——
 *      管**以后**出的题；
 *   ② 这里：把已经存进库的那些题面显示好 —— 管**存量**（他真库里至少有一道）。
 * 只做 ① 的话，他今天库里那些题还是一屏星号；只做 ② 的话，
 * 等于默许模型一直写 markdown，而下一处渲染（比如报告页）又会重蹈覆辙。
 */

/** 一段字：要不要加粗 */
export interface TextPart {
  readonly text: string
  readonly bold: boolean
}

/**
 * 把 `**x**` 拆成段。
 *
 * ★ **只认这一种**（成对的两个星号）。斜体、代码、链接、标题一律不认 ——
 *   认得越多，「这段字到底会被怎么显示」就越难说清，而这里要的只是
 *   「别把星号印在屏幕上」。多认一种就多一种要在两端对齐的规则。
 * ★ 没成对的星号**原样留着**：那多半是他自己或材料里的字符，不是格式。
 *   吞掉它比印出来更糟 —— 印出来他看得见，吞掉了他不知道少了什么。
 */
export function emphasisParts(raw: string | null | undefined): TextPart[] {
  const text = String(raw ?? '')
  if (!text) return []
  const out: TextPart[] = []
  /**
   * `at`   还没取走的那段从哪里开始
   * `from` 下一次从哪里找星号
   * ★ 两个光标必须分开：跳过一对不算数的星号时只该挪**找**的那个，
   *   两个合成一个的话，前面那截字会被悄悄丢掉（第一版就是这么写的，
   *   `a****b` 拆出来只剩 `**b`，而那正是这条判据要防的事）。
   */
  let at = 0
  let from = 0
  for (;;) {
    const open = text.indexOf('**', from)
    if (open < 0) break
    const close = text.indexOf('**', open + 2)
    if (close < 0) break
    /** 空的 `****` 不算强调 —— 拆出来会多一个空段，屏上是一个莫名的空隙 */
    if (close === open + 2) {
      from = close + 2
      continue
    }
    if (open > at) out.push({ text: text.slice(at, open), bold: false })
    out.push({ text: text.slice(open + 2, close), bold: true })
    at = close + 2
    from = at
  }
  if (at < text.length) out.push({ text: text.slice(at), bold: false })
  return out.length > 0 ? out : [{ text, bold: false }]
}
