/**
 * 把配色**打到屏上** —— 只有这一个地方碰 `document.documentElement.style`
 *
 * ══ 为什么一句 setProperty 就够 ════════════════════════════
 * 颜色的可改层是 core 那份 CSS 的 `:root{}`（语义层 `--color-*`）。
 * 行内样式压过任何样式表，所以
 *   `document.documentElement.style.setProperty('--color-bg', '#…')`
 * 一句就整屏改色 —— **一行现有 CSS 都不用动**，mobile.css 那 200 多处引用
 * 自动跟着走。这也是两端共用的机制（Windows 同理）。
 *
 * ══ 读「出厂值」为什么要先摘掉覆盖 ★★ ══════════════════════
 * `index.html` 在 JS 包起来之前就把镜像里的覆盖打上去了（免得启动时先闪一下
 * 出厂色再跳）。于是等这个模块跑起来时，`getComputedStyle` 读到的是**覆盖值**，
 * 不是出厂值。所以 `shippedColors()` 先把行内那几个属性摘掉、读完再放回去 ——
 * 中间不让出主线程，所以屏上不会闪。
 * ★ 只在打开配色页时调一次并缓存：它会强制一次样式重算，不该每帧跑。
 */
import { COLOR_TOKENS } from './color-parts.ts'

let shipped: Record<string, string> | null = null

/**
 * 出厂配色（样式表里那一份，= 「出厂配色」那一档真正长什么样）。
 * ★ 结果缓存：出厂值在一次运行里不会变（它跟着包走，不跟着他改）。
 */
export function shippedColors(): Record<string, string> {
  if (shipped !== null) return shipped
  const el = document.documentElement
  const saved: Record<string, string> = {}
  for (const t of COLOR_TOKENS) {
    const v = el.style.getPropertyValue('--' + t)
    if (v !== '') {
      saved[t] = v
      el.style.removeProperty('--' + t)
    }
  }
  const cs = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const t of COLOR_TOKENS) out[t] = cs.getPropertyValue('--' + t).trim()
  for (const [t, v] of Object.entries(saved)) el.style.setProperty('--' + t, v)
  shipped = out
  return out
}

/**
 * 整套应用。**先清后设** —— 不清的话切到一个覆盖更少的模式时，
 * 上一档多出来的那几个会赖着不走（那正是「切了模式还有旧颜色」的形状）。
 */
export function applyColors(overrides: Record<string, string>): void {
  const el = document.documentElement
  for (const t of COLOR_TOKENS) el.style.removeProperty('--' + t)
  for (const [t, v] of Object.entries(overrides)) el.style.setProperty('--' + t, v)
}

/**
 * 一个令牌现在**真正**是什么颜色：他改过就是他的值，没改过就是出厂值。
 * 拾色器要的是 `#rrggbb`，所以出厂值里那些写法（大写 / 简写）也在这里归一。
 */
export function colorNow(token: string, overrides: Record<string, string>): string {
  const mine = overrides[token]
  if (mine !== undefined) return mine
  return normalizeHex(shippedColors()[token] ?? '') ?? '#000000'
}

/** `#abc` / `#AABBCC` / `rgb(1,2,3)` → `#aabbcc`；认不出来给 null */
export function normalizeHex(raw: string): string | null {
  const s = raw.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toLowerCase()
  }
  const m = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/.exec(s)
  if (m) {
    const hex = (n: string): string =>
      Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')
    return ('#' + hex(m[1]!) + hex(m[2]!) + hex(m[3]!)).toLowerCase()
  }
  return null
}

/* ══════════════════════════════════════════════════════════════
   HEX ↔ HSL —— 拾色器要的换算（2026-09-13）

   ★ 为什么要自己做拾色器：`<input type="color">` 在 Android 的 **WebView**
     里会弹出系统自带的那个对话框 —— 八个纯红纯绿纯蓝的格子 +
     一个被挤断行的「Cust om」。真机上看过（2026-09-13）：它**能开**，
     但那八个饱和原色对这套配色毫无用处，而唯一能自定义的入口小到几乎点不中。
     所以换成应用内的 Dialog + 三条滑杆 + 一个 HEX 框。
   ★ 用 HSL 而不是 RGB：调色时人想的是「同一个色相再淡一点」，
     那在 HSL 里是动一根杆，在 RGB 里要同时动三根。
   ══════════════════════════════════════════════════════════════ */

export interface Hsl {
  /** 0–360 */
  h: number
  /** 0–100 */
  s: number
  /** 0–100 */
  l: number
}

/** `#rrggbb` → HSL。认不出来当黑色（调用方在此之前已经归一过）。 */
export function hexToHsl(hex: string): Hsl {
  const n = normalizeHex(hex) ?? '#000000'
  const r = parseInt(n.slice(1, 3), 16) / 255
  const g = parseInt(n.slice(3, 5), 16) / 255
  const b = parseInt(n.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/** HSL → `#rrggbb` */
export function hslToHex(hsl: Hsl): string {
  const h = ((hsl.h % 360) + 360) % 360 / 360
  const s = Math.max(0, Math.min(100, hsl.s)) / 100
  const l = Math.max(0, Math.min(100, hsl.l)) / 100
  if (s === 0) {
    const v = Math.round(l * 255)
    const c = v.toString(16).padStart(2, '0')
    return `#${c}${c}${c}`
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number): number => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const to = (v: number): string =>
    Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${to(hue(h + 1 / 3))}${to(hue(h))}${to(hue(h - 1 / 3))}`
}

/* ══════════════════════════════════════════════════════════════
   对比度 —— 改色时当场算给他看（2026-09-13）

   ★ 为什么要：出厂那套的比值是**量过**的（U-014 / U-015 · DS-Q23 定案
     「AA 4.5 是硬线」）。他一改色，那份保证就不成立了 ——
     只写一句「改了之后保证不成立」是对的，但**不够**：
     他改完看不清才发现，那时已经调了半天。
   ★ **只读数，不拦**（他是独裁人）。低于 4.5 亮一下，不挡他存。
   ★ 4.5 是**给正文的**。图标 / 线只要 3:1，大字也只要 3:1 ——
     所以屏上要说清「这个数是拿来比什么的」，不能只甩一个红字。
   ══════════════════════════════════════════════════════════════ */

/** WCAG 相对亮度 */
function luminance(hex: string): number {
  const n = normalizeHex(hex) ?? '#000000'
  const ch = (i: number): number => {
    const c = parseInt(n.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2)
}

/** 两色对比度（1–21）。顺序无所谓，亮的自动当分子。 */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** 屏上显示成一位小数（`4.5` 这种，不是 `4.4999999`） */
export function contrastText(a: string, b: string): string {
  return contrast(a, b).toFixed(1)
}
