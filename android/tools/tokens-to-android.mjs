/**
 * 令牌 → Android 资源 · DS §十五 账③（2026-09-01）· 2026-09-07 改读两份 CSS + 解析 var() 链
 *
 * ── 它治的是哪一种病 ──────────────────────────────────────
 *
 * Assist 的浮层与气泡是**原生 View**（无障碍服务画的，不是 WebView），
 * 于是 `NyxAssistService.java` 里有 34 处 `Color.parseColor("#5B44D6")` ——
 * 一份**手抄的**设计令牌。
 *
 * 2026-08-31 那次「28 处全量对齐 v5」已经证明了这条路走不通：
 * 对齐本身要人逐处比对，而且当场就漏了两处带 alpha 前缀的
 * （`#595B44D6` / `#F2FCFCFD` —— 它们不长得像颜色，grep `#5B44D6` 抓不到）。
 *
 * ★★ 这正是本项目定义的最贵事故形态：**同一件事有两份判据**。
 *    改 `tokens.css` 不会报错，只会让气泡和 App 慢慢长得不一样，
 *    而**两边都说得通**。
 *
 * ── 做法 ─────────────────────────────────────────────────
 *
 * 颜色的真相是 `nyx-core/src/core/design/color-tokens.css`（两端共享，原语 → 语义 → 组件）；
 * `src/ui/styles/tokens.css` 把 Android 的旧令牌名对到语义层（`--violet: var(--color-primary)`）。
 * 这个脚本把两份 CSS 一起读进来，**顺着 var() 链解析到 HEX**，
 * 再生成 `res/values/nyx_tokens.xml`，Java 只读 `R.color.nyx_*`。
 * 带透明度的用 `ALPHA` 表**从基色推出来** —— 基色一改，半透明那版跟着改。
 *
 * ★ 生成文件带「别手改」抬头；`npm run build` 每次都跑，所以它不可能过期。
 * ★ 配套的闸是 `npm run check:tokens`：Java 里**再出现颜色字面量就红**。
 *
 * 用法：node tools/tokens-to-android.mjs [--check]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 先读共享真相，再读本端别名 —— 后者只许引用前者，不许再写 HEX */
const SOURCES = [
  resolve(ROOT, 'nyx-core/src/core/design/color-tokens.css'),
  resolve(ROOT, 'src/ui/styles/tokens.css')
]
const OUT = resolve(ROOT, 'android/app/src/main/res/values/nyx_tokens.xml')

/**
 * 原生层真正用得到的那几个 —— **不是全量导出**。
 * 全导会让「Java 能读到什么」和「Java 该读什么」变成两件事，
 * 而清单本身就是一份说明：原生层只碰这几个颜色。
 * ★ 2026-09-07 加 `assist-glow`：星 ON 的柔光原来是 Java 里写死的 argb(91,68,214)。
 */
const WANT = ['bg', 'paper', 'surface', 'chip', 'soft', 'soft-bd', 'ink', 'ink-2', 'mute', 'faint', 'line', 'line-2', 'violet', 'violet-2', 'warn', 'assist-glow']

/**
 * 带透明度的那几个 —— 名字里写清楚是几成，别再出现看不懂的 `#595B44D6`。
 * `[基色, 十六进制 alpha, 名字, 干什么用的]`
 */
const ALPHA = [
  ['violet', '59', 'sel', '选区高亮底 —— 35%，压在宿主 App 自己的文字上'],
  ['paper', 'FC', 'card', '气泡卡面 —— 99%，几乎不透但不是死白'],
  ['bg', 'F5', 'star_card', '星旁小卡 —— 96%'],
  ['bg', 'F2', 'toast', '原生 toast 底 —— 95%']
]

/** 只认 `--name: #RRGGBB;` 与 `--name: var(--other);` 两种形状 —— 渐变 / rgba 不导 */
const raw = new Map()
const seen = []
for (const f of SOURCES) {
  if (!existsSync(f)) {
    console.error(`✗ 找不到 ${f} —— nyx-core submodule 初始化了吗？`)
    process.exit(1)
  }
  const css = readFileSync(f, 'utf8')
  seen.push(css)
  for (const m of css.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6}|var\(--[a-z0-9-]+\))\s*;/g)) {
    raw.set(m[1], m[2])
  }
}
function hexOf(name, seen = []) {
  const v = raw.get(name)
  if (!v) return null
  if (v.startsWith('#')) return v.toUpperCase()
  const ref = v.slice(6, -1)
  if (seen.includes(ref)) return null // 环
  return hexOf(ref, [...seen, name])
}
const colors = new Map()
for (const k of WANT) {
  const h = hexOf(k)
  if (h) colors.set(k, h)
}

/**
 * ★★★ 2026-09-08 · 这道断言是**负向对照抓出来的**。
 *
 * 派单说的对照是「拆掉 tokens.css 里那行 @import → 生成器红 + App 变白」。
 * 真跑了一次：**App 确实变白**（产物里 `--color-bg` 一个定义都没有，
 * `body` 只剩 `margin:0;padding:0`，`background:var(--bg)` 在计算值阶段就被丢掉），
 * 而**生成器一声不吭地绿了**。
 *
 * 为什么：上面的 SOURCES 是**直接从磁盘读** core 那份 CSS 的，
 * 它根本不经过 `@import`。所以「原生层拿到的颜色」和「App 拿到的颜色」
 * 走的是两条独立的路 —— 断掉其中一条，另一条毫无察觉。
 * 这正是本仓最贵的事故形态：**同一件事两份判据，而且两边都说得通**
 * （气泡是对的、App 是白的，两个都不报错）。
 *
 * 所以在这里显式断言：**本端的 tokens.css 必须真的 @import 那一份 core**。
 * 少了它，闸立刻红，而不是等真机上看见一屏白。
 */
const ANDROID_CSS = seen[1] ?? ''
if (!/@import\s+["'][^"']*nyx-core\/src\/core\/design\/color-tokens\.css["']/.test(ANDROID_CSS)) {
  console.error('✗ src/ui/styles/tokens.css 没有 @import core 那份颜色真相。')
  console.error('  —— 生成器是直接读盘的，少了这行它照样绿，但 **App 会整屏变白**：')
  console.error('     --color-* 全部无定义 → --bg / --ink … 跟着失效 → body 连底色都没有。')
  process.exit(1)
}

const missing = WANT.filter((k) => !colors.has(k))
if (missing.length > 0) {
  console.error(`✗ 两份 tokens 里解析不出：${missing.join(' · ')}`)
  console.error('  —— 令牌改名了？改名要连这个清单一起改，否则原生层会静默用回旧色。')
  process.exit(1)
}

const id = (k) => 'nyx_' + k.replace(/-/g, '_')
const lines = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<!--',
  '  ★★★ 这个文件是**生成的，别手改**。',
  '',
  '  真相在 nyx-core/src/core/design/color-tokens.css（两端共享）+ src/ui/styles/tokens.css（本端别名）。',
  '  生成器 tools/tokens-to-android.mjs，`npm run build` 每次都会跑。',
  '',
  '  为什么要它：Assist 的浮层与气泡是原生 View，不在 WebView 里，',
  '  以前那 34 个颜色是**手抄的** —— 改了 tokens.css 不报错，',
  '  只会让气泡和 App 慢慢长得不一样，而两边都说得通。',
  '-->',
  '<resources>'
]
for (const k of WANT) lines.push(`    <color name="${id(k)}">${colors.get(k)}</color>`)
lines.push('')
lines.push('    <!-- 带透明度：从基色推出来，基色一改这里跟着改 -->')
for (const [base, a, name, why] of ALPHA) {
  lines.push(`    <!-- ${why} -->`)
  lines.push(`    <color name="${id(name)}">#${a}${colors.get(base).slice(1)}</color>`)
}
lines.push('</resources>')
const xml = lines.join('\n') + '\n'

if (process.argv.includes('--check')) {
  const had = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (had !== xml) {
    console.error('✗ res/values/nyx_tokens.xml 与 tokens 对不上（或不存在）。')
    console.error('  跑一次 `node tools/tokens-to-android.mjs` 重新生成。')
    process.exit(1)
  }
  console.log(`✓ nyx_tokens.xml 与 tokens 一致（${WANT.length} 色 + ${ALPHA.length} 半透明）`)
  process.exit(0)
}

writeFileSync(OUT, xml)
console.log(`✓ 写出 ${WANT.length} 色 + ${ALPHA.length} 半透明 → android/.../nyx_tokens.xml`)
