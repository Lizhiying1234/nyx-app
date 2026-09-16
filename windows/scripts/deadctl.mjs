/**
 * 找「死控件」—— 画着能点、点了什么都不会发生的东西。
 *
 * 为什么单独写一个：这一轮报出来的 bug 里，有好几个都是这一类 ——
 * 攻坚区和工作台的 `.ck` 是从总原型抄来的空 `<span>`，
 * 文件学习「路径：L1」那一行只是死字，右键菜单的遮罩用了一个不存在的 class。
 * 它们的共同点是：**类型检查全绿、单元测试全绿、截图上看着也对**，
 * 因为它们确实存在、样式也对，只是没接线。
 *
 * 判据（只报有把握的，宁可漏不可吵）：
 *   ① 带交互 class（.ck / .btn / .mi / .tg.dash / .dt3 / .fold / .sw / .car）
 *      或 role="button" / role="checkbox"，**却既没有 onclick 也没有 onkeydown**
 *   ② 组件里引用了 CSS 里根本不存在的 class（`.ovl` 就是这么漏过去的）
 *
 * ★★★ 2026-09-08 · 这道闸的「未知 class」半边**曾经整段失效**，值得写在这里
 *
 * 第 ①② 条判据都要先从标签属性里取出 class 名。取它的那两个正则里，
 * `\b`（单词边界）**在某一次编辑中被写成了字面的退格符 0x08** ——
 * 于是「退格符 + class=」永远匹配不到任何东西，`classes` 恒为空数组：
 *   · 「组件用了 CSS 里不存在的 class」→ 永远 0 处
 *   · 「看着能点却没接线」→ 少掉靠 class 判断的那一半（只剩 role 那一半）
 * 而它一直**绿着**，还每次都打印「扫了 N 个组件」，看上去在干活。
 *
 * ★ 发现它的方式值得留下：拿一个**绝不存在**的 class（`zzz-not-a-class`）
 *   塞进一个组件，看这道闸红不红。闸自己也要有负向对照。
 * ★ 教训与 D-460 是同一条：**带反斜杠的查找串一律绕开写**，改完当场看落到文件里的字节
 *   （`cat -A`）。这一次是 `\b`（单词边界），上一次是 `\s` 变成字面 `s`。
 *
 * 用法：node scripts/deadctl.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCss } from './css-parse.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'src', 'renderer', 'src')
const STYLES = join(root, 'src', 'renderer', 'styles')

// ── 所有 CSS 里定义过的 class ────────────────────────────────
const known = new Set()
for (const f of ['tokens.css', 'global.css', 'enhancements.css', 'kit.css']) {
  for (const r of parseCss(readFileSync(join(STYLES, f), 'utf8'))) {
    for (const m of r.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) known.add(m[1])
  }
}

/**
 * ★ 已知的缺口 —— **点名放行，附理由与去处**（2026-09-08）
 *
 * 这道闸的「未知 class」半边曾经**整段失效**（见文件头的修复说明），
 * 失效期间攒下几处「组件写了、CSS 里没有」的类。修好之后一次性清掉了
 * `.num` / `.chip`（它们从来没生效过，删掉屏幕上一个像素都不会变）。
 *
 * 只剩这一处不能顺手改：`Settings.svelte` 声音那两排（英音 / 美音、两档语速）
 * 写的是 `.seg`，而全仓真正存在的是 `.segs`（报告页那个分段控件）。
 * 改过去**会改变外观** —— 那两排会从两颗普通按钮变成分段控件。
 * D-441「Windows UI 现在不动」只对 bug 开例外，而「长什么样」要使用者点头，
 * 所以这里点名放行、等裁，不许扩大到「按前缀放行」。
 */
const KNOWN_GAPS = new Set(['Settings.svelte:seg'])

/** 这些 class 一出现就意味着「这里能点」 */
const INTERACTIVE = new Set(['ck', 'mi', 'dt3', 'fold', 'sw', 'car', 'xbtn', 'fadd', 'srt', 'add'])

const files = readdirSync(SRC).filter((f) => f.endsWith('.svelte'))
const dead = []
const unknownClass = []

for (const f of files) {
  const src = readFileSync(join(SRC, f), 'utf8')
  const lines = src.split('\n')

  /**
   * 逐个元素地看。**不能用正则找结束的 `>`** ——
   * `onclick={() => …}` 里就有一个 `>`，正则会在那里把属性切断，
   * 于是「明明接了 onclick」被报成死控件（第一版就是这样，报出来 3 条全是假的）。
   * 所以老实地扫字符，记着花括号和引号的深度。
   */
  const tags = []
  for (const t of src.matchAll(/<([a-z][\w-]*)[\s>]/g)) {
    let i = t.index + t[0].length - 1
    let depth = 0
    let quote = null
    while (i < src.length) {
      const c = src[i]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
      i++
    }
    tags.push({
      tag: t[1],
      attrs: src.slice(t.index + t[0].length - 1, i),
      line: src.slice(0, t.index).split('\n').length
    })
  }

  for (const { tag, attrs, line } of tags) {
    /**
     * 只取**静态**的 `class="a b c"`。
     * 一开始把 `class:on={tab === 'tut'}` 也一起抓了 —— 于是把表达式里的变量名
     * 当成 class 报出来（`.tab` / `.picked` / `.null`），50 条里 40 条是噪音。
     * `class:name={…}` 单独取那个 name。
     */
    const classes = [
      ...[...attrs.matchAll(/(?<!:)\bclass=["']([^"']*)["']/g)].flatMap((c) => c[1].split(/\s+/)),
      ...[...attrs.matchAll(/\bclass:([\w-]+)=/g)].map((c) => c[1])
    ].filter((c) => c && !c.includes('{'))
    const role = /role=["']([\w-]+)["']/.exec(attrs)?.[1]

    const looksClickable =
      classes.some((c) => INTERACTIVE.has(c)) || role === 'button' || role === 'checkbox'
    const wired =
      /\bon(click|keydown|mousedown|pointerdown|change|input)=/.test(attrs) ||
      tag === 'button' || // 原生 button 至少能聚焦；没接线的另说
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea'

    // 只报 role 明确说「我能点」的 —— 光有 class 的多半是父行统一接的事件委托，
    // 全报出来就是一屏噪音，报了没人看等于没报
    if (looksClickable && !wired && (role === 'button' || role === 'checkbox')) {
      dead.push({ file: f, line, tag, classes: classes.join('.'), role })
    }

    for (const c of classes) {
      // Svelte 的 `class:x={…}` 也会被上面的正则抓到，这里只看纯 class 名
      if (
        !known.has(c) &&
        !KNOWN_GAPS.has(`${f}:${c}`) &&
        /^[a-z][\w-]*$/.test(c) &&
        !c.includes('{')
      ) {
        unknownClass.push({ file: f, line, cls: c })
      }
    }
  }
}

let bad = false

if (unknownClass.length) {
  bad = true
  console.log(`\n✖ 组件里用了 CSS 里不存在的 class —— ${unknownClass.length} 处`)
  console.log('  这一类最阴：不报错、不变红，样式就是不生效。`.ovl` 就是这么漏过去的（I-092）。')
  const seen = new Set()
  for (const u of unknownClass) {
    const k = `${u.file}:${u.cls}`
    if (seen.has(k)) continue
    seen.add(k)
    console.log(`  ${u.file}:${u.line}  .${u.cls}`)
  }
}

if (dead.length) {
  console.log(`\n⚠ 看着能点、却没接任何事件 —— ${dead.length} 处`)
  console.log('  （有些是父元素统一接的事件委托，属正常。逐条看一眼再决定。）')
  for (const d of dead) {
    console.log(`  ${d.file}:${d.line}  <${d.tag} class="${d.classes}"${d.role ? ` role=${d.role}` : ''}>`)
  }
}

if (!bad && dead.length === 0) console.log('\n✔ 没发现死控件')
console.log(`\ndeadctl　扫了 ${files.length} 个组件 · 未知 class ${unknownClass.length} · 疑似死控件 ${dead.length}`)
process.exit(bad ? 1 : 0)
