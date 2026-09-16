/**
 * 样式闸 · 第二条 —— **选择器匹配不上，就是一条永远没生效过的规则**（B-8 / I-179，2026-09-14）
 *
 * ── 它抓的是什么 ────────────────────────────────────────────
 *
 * `check:css` 抓的是「注释断掉把下一条规则吃了」。这一条抓的是另一种，
 * 而且它是**成片出现**的：每一次「整块删」——删一屏、删一个面板、换一套记号——
 * markup 走了，**CSS 留下了**。留下来的规则不报错、不警告、类型也对，
 * 它只是**永远匹配不到任何元素**，于是没有任何人会发现它已经死了。
 *
 * 2026-09-14 第一次系统扫的结果：三份样式表里 **64 个类名**在整个
 * `src/` `tests/` `scripts/` 里一次都没出现过。其中 43 个能一笔一笔指出是
 * 哪次删并留下的（词典释义 UI 那次一口气留了 9 条、D-469 取消项目/单元主页留了 7 条、
 * D-467 报告收窄留了 5 条……）。**没有任何闸看得见它们**：
 * `check:css` 只看注释、`check:dead` 只看「画着能点、点了没反应」的控件。
 *
 * ── 判据（故意比「有没有人提过」严）★★ ──────────────────────
 *
 * 一个类选择器算活着，当且仅当**它的名字出现在 `src/renderer` 的 `.svelte` / `.ts` 里**。
 *   · 注释里提到**不算**（`.pdot` 就是这么漏掉的：markup 早没了，
 *     只剩一条注释在讲它当年为什么长那样，于是「有人提过」而规则是死的）
 *     ★★ **这句话到 2026-09-15 才真的成立**（Z-1 / I-179 追加条）。在那之前
 *     `stripComments` 只作用在**样式表**上，扫源码那一步是 `readFileSync` 原样拼接 ——
 *     于是**源码注释里提到一个类名，就算这条 CSS 还活着**。实测：D-488 那一单里
 *     我在 Svelte 注释里写了一个类名，闸报 3 条；把注释里那个词换掉就报 4 条。
 *     闸的说明比闸本身更严，而**没有任何东西在核对这两者** —— 这是这一族第五次了。
 *   · `tests/` `scripts/` 里提到**也不算**（测试里写着选择器只说明有人在查它，
 *     不说明界面上画得出来）
 *
 * ── 为什么要白名单，以及白名单怎么才不烂掉 ★★ ────────────────
 *
 * 有些类名是**运行时拼出来的**（I-130：「搜不到引用」不等于死）。那种必须放行。
 * 但**白名单是这类闸唯一会烂掉的地方** —— `check-copy.mjs` 上那条教训原话：
 * 「一个会误报的闸，第一次误报之后就会被下一个人加进白名单，然后失效」。
 * 所以这里定两条纪律：
 *   ① **加一行就要写一行理由**，而且理由要说得出**谁在哪儿拼它**；
 *   ② 「待查」和「运行时拼的」**分开两张表** —— 待查那张是**临时**的，
 *      它上面每一条都在等一个裁决，裁完要么删规则要么搬进另一张表。
 *      混成一张的话，临时项会安静地变成永久项。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripSource } from './lib/strip-comments.mjs'

const BS = String.fromCharCode(92) // 反斜杠绕开写（D-460）
const NL = String.fromCharCode(10) // 换行符同理
const STYLES = 'src/renderer/styles'
const CODE = 'src/renderer'

/**
 * ★★★ 运行时拼出来的类名 —— **不写死名单，让闸自己去源码里认**（I-130）
 *
 * 第一版这里是一张空数组，注释还写着「本轮实测一个都不需要」。**那是错的**，
 * 而且差一点删掉三条活规则：`HardZone.svelte` 里写的是
 *
 *     <div class="ev a{h.grade}">          <span class="gr a{h.grade}">
 *
 * —— Svelte 允许**在引号里的属性值中间直接插值**，不需要 `class={...}`、也不需要反引号。
 * 于是 `.a1` / `.a2` / `.a3`（攻坚区那段历史里四档判分的颜色）在源码里**一次都搜不到**，
 * 而它们天天在屏上生效。按「搜不到就是死的」删下去，界面会安静地掉色：
 * **不报错、不红、没人会发现** —— 正是这道闸本来要治的那种病，反过来咬自己一口。
 *
 * 所以放行名单**不由人维护**，由闸去扫：把 `.svelte` 里所有带插值的 `class="…"`
 * 拆成词，取 `{` 前面那一截当**前缀**（`a{h.grade}` → `a`；模板串 `h${g}` 去掉尾巴的 `$` → `h`）。
 *
 * ★ 只放行「前缀 + 纯数字」：本仓四处拼的全是数字（判分档 · 刻度 · 小时热度），
 *   而放宽成「前缀 + 任意字符」的话，一个 `a` 就会把 `.angle` `.anch` `.ar2` 一起赦免，
 *   这道闸就废了一半。**将来要是有人拼出非数字的后缀，这里要跟着放宽** ——
 *   所以下面把认到的前缀**打印出来**，让它是看得见的，而不是藏在代码里。
 */
function composedPrefixes(files) {
  const found = new Map()
  for (const f of files) {
    if (!f.endsWith('.svelte')) continue
    /**
     * ★ Z-1：这里也要剥 —— 注释里一句 `class="a{x}"` 会凭空造出一个**放行前缀**，
     *   而放行前缀是**放宽**这道闸的东西，它的来源必须是真 markup。
     */
    const src = stripSource(readFileSync(f, 'utf8'), f)
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      const value = m[1]
      if (!value.includes('{')) continue
      for (const token of value.split(/\s+/)) {
        const at = token.indexOf('{')
        if (at <= 0) continue
        const prefix = token.slice(0, at).replace(/[$]$/, '')
        if (prefix && !found.has(prefix)) {
          found.set(prefix, f.split(BS).join('/') + ':' + src.slice(0, m.index).split('\n').length)
        }
      }
    }
  }
  return found
}

/**
 * ★★ **判据先行的那一族 —— 有意留着，不是待查**（B-13，主控 2026-09-14 裁）
 *
 * 这 5 个是 `LAYOUT_TEMPLATES` 那套版式模板的名字。`enhancements.css` 里
 * 它们头上那条注释自己写着：「**造出来就好：本轮没有一屏引用它们，各屏在自己那一批换**」——
 * 也就是说它们**不是残留，是先写好的judge**：SC-* 各屏按 D-472 重做时照着它落地。
 * 所以这道闸对它们放行，而且这一条放行是**长期的**，不等谁再裁一次。
 *
 * ── 这张表和 B-8 那张「待查」的区别（别再混起来）★ ────────────
 *
 * B-8 时这里躺着 23 个，其中 18 个是**一出生就死**（git 史里从没上过 markup），
 * 主控 2026-09-14 裁定**全删**（B-13）：报告 / 阅读 / 查词卡 / 样式一览那几屏
 * 按 D-472 重做时自带 CSS，**旧的是靶子不是前提**；`.is-disabled` / `.tech`
 * 那两态等哪一屏真要时按 BUTTON_SYSTEM / NOTIFICATION_RULES 新写
 * （新加类名先 grep 两份样式表）。
 * ☞ 所以这张表现在只剩这一族。**再往里加东西之前先想清楚**：
 *   是「判据先行、屏还没做」（进这里），还是「屏没了、CSS 留下」（该删）。
 */
const PENDING = ['lt-axis', 'lt-detail', 'lt-form', 'lt-focus', 'lt-card']

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name).split(BS).join('/')
    if (e.name === 'styles') continue
    if (e.isDirectory()) walk(full, out)
    // ★ `.html` 也扫：`src/renderer/index.html` 今天没有类名，但它是真会上屏的一份 markup，
    //   漏在外面就是下一个「文案住在没人扫的地方」（check-copy 那边栽过两次）。
    else if (/[.](svelte|ts|html)$/.test(e.name)) out.push(full)
  }
  return out
}

/** 注释挖掉 —— 注释里提到一个类名不算它还活着（见头注） */
function stripComments(css) {
  const O = '/' + '*'
  const C = '*' + '/'
  let out = ''
  let i = 0
  while (i < css.length) {
    if (css.startsWith(O, i)) {
      const end = css.indexOf(C, i + 2)
      i = end === -1 ? css.length : end + 2
      continue
    }
    out += css[i++]
  }
  return out
}

/**
 * ★ 剥注释那套判据搬进了 `lib/strip-comments.mjs`（Z-5，2026-09-15）：写第三个扫源码的闸时，
 *   这块代码就要有第三份拷贝了 —— 而这一整轮反复撞的正是
 *   「两份实现从第一天就会不一致，而不一致的那天没人会发现」。
 *   行为一个字没改；两道闸的负向对照改完重跑过。
 */

const codeFiles = walk(CODE)
const PREFIXES = composedPrefixes(codeFiles)

let code = ''
for (const f of codeFiles) code += stripSource(readFileSync(f, 'utf8'), f) + NL

/** 「前缀 + 纯数字」= 运行时拼出来的那一族，放行（理由见 `composedPrefixes` 头注） */
const isComposed = (name) => {
  for (const p of PREFIXES.keys()) {
    if (name.length > p.length && name.startsWith(p) && /^[0-9]+$/.test(name.slice(p.length))) {
      return true
    }
  }
  return false
}

const CLASS = new RegExp(BS + '.([A-Za-z_][-A-Za-z0-9_]*)', 'g')
const seen = new Map()
for (const f of readdirSync(STYLES).filter((n) => n.endsWith('.css'))) {
  const css = stripComments(readFileSync(join(STYLES, f), 'utf8'))
  for (const m of css.matchAll(CLASS)) if (!seen.has(m[1])) seen.set(m[1], f)
}

const allowed = new Set(PENDING)
const dead = []
for (const [name, file] of seen) {
  if (allowed.has(name)) continue
  if (isComposed(name)) continue
  if (new RegExp(BS + 'b' + name + BS + 'b').test(code)) continue
  dead.push(`  ${file}　.${name}`)
}

if (dead.length > 0) {
  console.error('✖ 样式表里有匹配不上的类选择器 —— ' + dead.length + ' 条')
  console.error(
    '  判据：类名要在 src/renderer 的 .svelte / .ts 的**代码**里出现' +
      '（注释不算 —— 2026-09-15 起真的剥掉了；' +
      '字符串里**算**，类名住在字符串里是活的；tests / scripts 不算）'
  )
  console.error(dead.join('\n'))
  console.error('')
  console.error('★ 这类规则不报错也不警告，只是永远没生效过 —— 多半是某次「整块删」留下的。')
  console.error('  真是运行时拼出来的就加进 COMPOSED 并写清谁在哪儿拼它（I-130）；')
  console.error('  说不清的加进 PENDING 等裁决，**别直接放行**。')
  process.exit(1)
}

console.log(
  'check:css-dead　' +
    seen.size +
    ' 个类选择器都在 src/renderer 里找得到' +
    '（运行时拼的前缀 ' +
    [...PREFIXES.keys()].map((p) => JSON.stringify(p + '<数字>')).join(' ') +
    ' · 待裁决 ' +
    PENDING.length +
    ' 个）'
)
