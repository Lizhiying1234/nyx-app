/**
 * `strip-comments.mjs` 的类型声明。
 *
 * ★ 为什么要这一份：`tests/*.test.ts` 走 `svelte-check`（`--threshold error`），
 *   而那套工具链**不认没有声明的 `.mjs`** —— 直接报
 *   「implicitly has an 'any' type」，`check` 当场红。
 *   ZA-1 第一次把闸改成 import 它时就是这么红的。
 *
 * ★ 实现只有一份（`strip-comments.mjs`），这里**只写形状不写行为** ——
 *   两份实现从第一天就会不一致，而这正是那份文件存在的理由。
 */

/** JS / TS 注释。字符串与模板串整段原样留下 */
export function stripJsComments(src: string, keepLines?: boolean): string

/** `<!-- … -->`。换成空格而不是删空 —— 免得把两边的词粘成一个新词 */
export function stripHtmlComments(src: string, keepLines?: boolean): string

/**
 * 按后缀分流。`file` 只用来看后缀，可以是相对路径。
 * `.svelte` / `.html` → 先剥 markup 注释，再只在 `<script>` 里剥 JS 注释。
 */
/**
 * ★ `keepLines: true` —— 逐字符挖空、换行原样留下，剥完行号 = 文件里的行号。
 *   纯新增，默认关；三个老调用方（闸）一个字不动，它们只做子串匹配、不关心位置。
 *   要它的是**报「文件 : 行」的清单**：剥注释会把注释里的换行一起吃掉，
 *   12 行 JSDoc 塌成一个空格，后面行号全前移（B 在 Windows 侧返工过一次）。
 */
export function stripSource(src: string, file: string, keepLines?: boolean): string

/**
 * 这份判据自己的用例，跑通返回句数；哪一句不对就抛。
 * ★ 由 `check:gates` 在量之前先跑一遍 —— **歪尺量出来的地板会被当成事实钉死**。
 */
export function selfCheck(): number
