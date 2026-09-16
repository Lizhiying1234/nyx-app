/**
 * 节点树 → 保结构的纯文本 · D1（2026-08-19）
 *
 * ── 这个文件存在的全部理由 ★★★ ────────────────────────────────
 *
 * 现行 `main/dict/mdict.ts::toText()` 的换行判据是**一张块级标签白名单**：
 *
 *     .replace(/<\/(p|div|li|dd|dt|tr|h[1-6])>/gi, '\n')
 *
 * 而现代词典的正文是 `<span>` 和自定义标签堆出来的。实测 OALD10 的 `brunt`：
 *
 *     to receive the main force of something unpleasant承受某事的主要压力；首当其冲Schools
 *     will bear the brunt of cuts in government spending.政府削减开支，学校将首当其冲受到影响。
 *
 * 一行里粘着**四样东西**：英文释义 + 中文对译 + 英文例句 + 中文例句译文。
 * `core/dict-entry.ts::parseEntry()` 拿到的就是这个 —— 它抽不出释义不是它的错，
 * 是**上游把结构丢了**，下游再聪明的正则也补不回来。
 *
 * ── 判据反过来：默认成块，白名单是「行内」★ ───────────────────
 *
 * 原来是「白名单里的才换行」，于是没见过的标签一律粘住。
 * 这里改成「白名单里的才**不**换行」：
 *
 *   · 行内白名单是有限的、稳定的（`b i u em strong span a font …`）
 *   · 词典自定义的那些（`chn` `defT` `xT` `exat` `deft` `trn`）**全是语义块**，
 *     而它们恰恰是永远列不全的那一类
 *
 * 两种错法的代价也不对称：多换一行 = 版式松一点；少换一行 = 语义粘死、不可恢复。
 *
 * ── `<span>` 是个例外，所以留了钩子 ───────────────────────────
 *
 * `<span>` 在词典里两种用法都有：`span.pos` + `span.phon` 该在同一行（`noun /brʌnt/`），
 * 而 `span.def` / `span.x` 各自该独占一行。光看标签名分不出来，
 * 所以 `isBlock` 钩子让**画像**（`decode/profiles.ts`）来决定 —— 它认识这本词典。
 */

import { type ElNode, type HtmlNode, tidy } from './parse.ts'

export interface TextOptions {
  /**
   * 这个元素算不算块。返回 `undefined` 表示「我不管」，落回默认判据。
   * 画像用它把 `span.def` / `span.x` 这类语义 span 标成块。
   */
  isBlock?: (el: ElNode) => boolean | undefined
  /** 整棵子树都不要（栏目按钮、"jump to other results" 这类） */
  skip?: (el: ElNode) => boolean
}

/**
 * 行内元素白名单。**只有这些不换行**，其余一律换行（包括所有自定义标签）。
 */
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark', 'nobr', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
  'time', 'tt', 'u', 'var', 'wbr'
])

/** 这些前后要空一行，不是只换一行 —— 它们在视觉上是独立段落 */
const PARAGRAPH = new Set(['p', 'div', 'section', 'article', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ol', 'ul', 'table'])

function blockness(el: ElNode, opt: TextOptions): 'inline' | 'line' | 'para' {
  const forced = opt.isBlock?.(el)
  if (forced === true) return 'line'
  if (forced === false) return 'inline'
  if (el.tag === 'br') return 'line'
  if (PARAGRAPH.has(el.tag)) return 'para'
  if (INLINE.has(el.tag)) return 'inline'
  // ★ 没见过的标签一律当块 —— chn / defT / xT / exat / deft / trn 都落在这里
  return 'line'
}

/**
 * 把一棵子树摊成文本。
 *
 * 内部用 `\n` 和 `\n\n` 做记号，最后统一收拾 —— 边走边判「要不要加换行」
 * 会写出一堆「上一个是不是空的」判断，那种代码改一次坏一次。
 */
function emit(node: HtmlNode, opt: TextOptions, out: string[]): void {
  if (node.kind === 'text') {
    if (node.text) out.push(node.text)
    return
  }
  if (opt.skip?.(node)) return

  const how = blockness(node, opt)
  if (how === 'inline') {
    for (const c of node.children) emit(c, opt, out)
    return
  }
  const sep = how === 'para' ? '\n\n' : '\n'
  /**
   * ★ 没有孩子的块只加**一次**分隔。
   *   前后各加一次的话，`<br>` 会变成空行，而 `<br>` 在词典里到处都是
   *  （LDOCE5 的 `brunt` 一条里就有 39 个）—— 整条词条会被撑成隔行的样子。
   */
  if (node.children.length === 0) {
    out.push(sep)
    return
  }
  out.push(sep)
  for (const c of node.children) emit(c, opt, out)
  out.push(sep)
}

/**
 * 节点树 → 人读的纯文本。
 *
 * 这是**降级视图**：`RichDictionaryEntry.html` 保着原文，结构化解析产出 `senses`，
 * 而这一份是「三档都没抽出东西时至少还看得清」的那一层（见 `decode/html-entry.ts`）。
 */
export function toStructuredText(root: ElNode, opt: TextOptions = {}): string {
  const out: string[] = []
  for (const c of root.children) emit(c, opt, out)

  return out
    .join('')
    // 行内的连续空白折成一个空格，但**不要碰换行**
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 一个元素自己的文本（子树全算），折叠空白。
 * 判角色、取释义、取例句都用它。
 */
export function inlineText(node: HtmlNode): string {
  const out: string[] = []
  emit(node, { isBlock: () => false }, out)
  return tidy(out.join(''))
}
