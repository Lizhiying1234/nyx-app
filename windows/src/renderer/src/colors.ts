import type { ColorTokens } from '../../shared/api.ts'
import { COLOR_SECTIONS, sectionOf, type ColorSection } from './colors-parts.ts'

/**
 * 把一套配色涂到屏上 · 界面这一半（使用者 2026-09-13）
 *
 * ══ 为什么这件事这么便宜 ═════════════════════════════════════
 * 整个 Windows 端的颜色**只有一个出处**：`core/design/color-tokens.css` 里
 * 那**一个** `:root{}` 块。`renderer/styles/tokens.css` 那 45 个老名字
 * （`--bg` / `--text-2` / `--line` …）**全部**是 `--color-*`的别名（值都是一句 var() 引用），
 * 一个写死的值都没有；两份样式表里也没有任何绕过令牌的颜色字面量
 * （只有注释里提到过几个旧账）。
 *
 * 于是：往 `:root` 上写**行内样式**就能整屏换色 ——
 * 行内样式压过任何样式表，现有 CSS 一行都不用改。
 *
 * ══ 唯一涂不到的地方 ════════════════════════════════════════
 * 开窗那一帧（`main/index.ts` 的 `backgroundColor`）—— 它在这段代码
 * 跑起来之前就画出去了。那一处由主进程自己去库里问（`main/colors.ts::windowBg`）。
 */

/**
 * 上一次涂上去的那些名字。
 * ★ 必须记着 —— 换模式时要先把上一套**移掉**再涂新的。
 *   不移的话，上一套里有、新一套里没有的那几项会**留在屏上**，
 *   于是他看到的是两套混出来的第三套，而且怎么改都甩不掉。
 */
let applied: string[] = []

/** 涂。传 `{}` = 回到出厂那套（把覆盖层清空）。 */
export function paint(tokens: ColorTokens): void {
  const root = document.documentElement
  for (const name of applied) root.style.removeProperty(name)
  applied = []
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value)
    applied.push(name)
  }
}

/**
 * 现在这个 token 实际是什么颜色。
 * ★ 走 `getComputedStyle` 而不是读样式表：他可能已经覆盖过它，
 *   而**屏上那个颜色**才是他要改的起点。
 */
export function currentValue(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  } catch {
    return ''
  }
}

/**
 * 全部**可调的颜色**令牌，**从样式表现读**。
 *
 * ★★ 不在这里写死一份名单。写死的那一份会和 `color-tokens.css` 各说各话 ——
 *   加了令牌忘了同步，它就**安静地从这一页上消失**：不报错、不留空白，
 *   只是他永远调不到那一项。`check:tokens` 的 TOK-3 守的是另一半
 *   （每个令牌都得能归进某一区）。
 *
 * ══ 两道筛子，都从现实推，不加第二份名单 ═════════════════════
 * ① **只从「定义了 `--color-bg` 的那条 `:root` 规则」里取。**
 *   打包后所有样式表并成一张，但 CSSOM 里**每个文件的 `:root` 仍是各自一条规则** ——
 *   所以认得出哪条是 `color-tokens.css`。
 *   不这么筛的话，`renderer/styles/tokens.css` 那 45 个老别名会漏进来 19 个
 *   （`--bg` `--text-2` `--accent` …，它们只是 `--color-*` 的别名，改它等于改两遍），
 *   连 `--btn-h` / `--btn-pad` / `--icon-btn` 这种**根本不是颜色**的也会漏
 *   （值是 `32px`，会画成一行选不了的颜色）。
 *   ★ 这一条是**截图之后**才发现的：分区加起来 156，而 CSS 里只有 137。
 * ② **值必须解析得出颜色。** 挡掉 `color-tokens.css` 自己那几个不是颜色的：
 *   `--progress-h`（4px）· `--progress-r`（999px）· `--color-shadow-*`
 *   （整条 box-shadow，`<input type="color">` 也选不了它）。
 *   ☞ 它们仍然**归了类**（TOK-3 照旧绿），只是这一页不画它们 ——
 *     「没归类所以消失」和「不是颜色所以不画」是两回事。
 */
/** 认出 `color-tokens.css` 那条 `:root` 的记号 —— 只有它定义这个名字 */
const MARKER = '--color-bg'

export function allColorTokens(): string[] {
  const out = new Set<string>()
  let sheets: StyleSheetList
  try {
    sheets = document.styleSheets
  } catch {
    return []
  }
  for (const sheet of Array.from(sheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      // 跨源样式表读不到 —— 我们自己的都是打进包里的，读得到；读不到就跳过
      continue
    }
    for (const rule of Array.from(rules)) {
      const r = rule as CSSStyleRule
      if (typeof r.selectorText !== 'string' || !r.selectorText.split(',').some((x) => x.trim() === ':root')) {
        continue
      }
      const names = Array.from(r.style)
      // 筛子①：这条规则得是 color-tokens.css 那一条（它定义了 --color-bg）
      if (!names.includes(MARKER)) continue
      for (const name of names) {
        if (!name.startsWith('--') || !sectionOf(name)) continue
        // 筛子②：值得真的是个颜色
        // ★ `transparent` 也算 —— `--btn-outline-bg` / `--btn-ghost-bg` 就是它，
        //   那是两颗真按钮的底，他想给它们填个色是合理的。
        const raw = currentValue(name)
        if (toRgb(raw) === null && raw !== 'transparent') continue
        out.add(name)
      }
    }
  }
  return [...out].sort()
}

export interface SectionRows {
  readonly section: ColorSection
  readonly tokens: readonly string[]
}

/** 按 `colors-parts.ts` 的分区把令牌摆好。空的分区不出现。 */
export function groupTokens(names: readonly string[]): SectionRows[] {
  const byId = new Map<string, string[]>()
  for (const n of names) {
    const s = sectionOf(n)
    if (!s) continue
    const arr = byId.get(s.id)
    if (arr) arr.push(n)
    else byId.set(s.id, [n])
  }
  const out: SectionRows[] = []
  for (const section of COLOR_SECTIONS) {
    const tokens = byId.get(section.id)
    if (tokens && tokens.length > 0) out.push({ section, tokens: tokens.sort() })
  }
  return out
}

/**
 * 对比度 —— 他一改色，U-014 / U-015 量过的那些比值就不成立了。
 *
 * ★ 这个数**只提示，不拦**：他是这个软件的独裁人，
 *   但「我不知道我把字调到看不清了」和「我知道，我就要这样」是两回事，
 *   而只有说出来才分得开这两件事（D-412：文案说真话）。
 * 算法是 WCAG 的相对亮度比，公式写死在这里 —— 它是标准，不是我们的判据。
 */
export function contrast(fg: string, bg: string): number | null {
  const a = luminance(fg)
  const b = luminance(bg)
  if (a === null || b === null) return null
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

function luminance(css: string): number | null {
  const rgb = toRgb(css)
  if (!rgb) return null
  const f = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

/** `#rgb` / `#rrggbb` / `rgb(…)` → 三个数。认不出来给 `null`（不猜）。 */
export function toRgb(css: string): [number, number, number] | null {
  const s = css.trim()
  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (h.length === 3 || h.length === 4) {
      const n = [0, 1, 2].map((i) => parseInt(h[i]! + h[i]!, 16))
      return n.some(Number.isNaN) ? null : [n[0]!, n[1]!, n[2]!]
    }
    if (h.length === 6 || h.length === 8) {
      const n = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
      return n.some(Number.isNaN) ? null : [n[0]!, n[1]!, n[2]!]
    }
    return null
  }
  const m = s.match(/^rgba?\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 取色器要的是 `#rrggbb`（`<input type="color">` 只认这一种）。转不了给空串。 */
export function toHex(css: string): string {
  // ★ transparent 给白：取色器只认 #rrggbb，给空串它默认黑 ——
  //   一排黑方块看着像坏了，而实情是「这里本来就没有底」。
  if (css.trim() === 'transparent') return '#ffffff'
  const rgb = toRgb(css)
  if (!rgb) return ''
  return '#' + rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')
}
