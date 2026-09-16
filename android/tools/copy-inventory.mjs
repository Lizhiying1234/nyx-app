/**
 * `copy-inventory` —— 把这一端**屏上能看到的每一句话**导出成一份清单。
 *
 * ══ 它不是闸 ═══════════════════════════════════════════════
 * **不进 `package.json`、不进 `check`**（派单 X-1 明写）。它只负责把话找齐，
 * 判好坏是人的事。闸红了要拦人，清单错了只是少看一句 —— 两种东西别混着跑。
 *
 * ══ ★★★ 范围必须和闸一样大，不许比它小 ═══════════════════════
 * 取字规则**逐条照抄 `tests/ui-copy.test.ts`**：同样的 `SCAN_DIRS` / `SCAN_FILES` /
 * `SKIP` / `MARKUP`，同样的两种取法（标记里的文字节点 · 含中文的字符串字面量），
 * 同样的 `dropExpr`。
 *   ☞ 清单比闸小的话，漏掉的那些句子**不会有任何东西报错** ——
 *     他划的是清单，清单没列到的从此没人看过。这正是本仓这一轮反复撞的形状。
 *   ☞ 所以跑完自己和闸对一次文件数（`--verify`），并**抽 60 行回原文核**。
 *
 * ══ ★★★ 这份清单**看不到**的两类字（2026-09-15 补，务必读） ═══
 * 它是**从源码文本抽的**，所以下面两类屏上的字**一个都不在里面**：
 *   ① **从常量渲染的** —— `{SILENCE_FILTER_NAME}` / `{ROTATION_WORDS.schedule}` 那些。
 *      屏上是「静默」「排进练习」，源码里只有标识符。
 *   ② **运行时拼出来的** —— `＋ 新建{CHILD[kind]}` 渲染成「＋ 新建Unit」，
 *      而全仓 grep「新建Unit」**零命中**。
 *
 * ☞ 后果一：**「清单 1143 句」≠「这一端屏上所有的字」**，它是
 *   「这一端源码里写死的字」。给人划的时候必须把这句话一起给他，
 *   否则他会以为没列到的就是没有。
 * ☞ 后果二（更贵）：**这两类只有真机看得见**。2026-09-15 当场兑现 ——
 *   「＋ 新建Unit」中文贴着拉丁词没空格（core 白纸黑字定过要留空格），
 *   **四门全绿 · 清单里没有 · 源码 grep 搜不到**，是上机点开菜单才看见的。
 *
 * ★ 不打算「修」这个盲区：把常量在这里求值等于**在清单里造第二份判据**，
 *   而那正是这个项目最贵的事故形态。正确的补法是**表现层一律真机量**（写进了闸的规矩）。
 *
 * ══ ★★ 行号为什么要 `keepLines` ═══════════════════════════════
 * 剥注释默认把整段换成一个空格，**注释里的换行一起没了** —— 12 行 JSDoc 塌成一格，
 * 后面每一行的行号全部前移。清单的全部价值就是「能定位」，
 * **一份定位不准的清单比没有清单更糟**：它看起来是可以核的。
 * （B 在 Windows 侧为这个返工过一次，`keepLines` 就是那次加的。）
 *
 * 用法：
 *   node tools/copy-inventory.mjs            → TSV 到 stdout
 *   node tools/copy-inventory.mjs --verify   → 统计 + 抽样回核（对不上退 1）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { stripSource } from './lib/strip-comments.mjs'

const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/* ── 以下四张表逐条照抄 tests/ui-copy.test.ts；改那边就要改这边 ── */
const SCAN_DIRS = [
  ['src', ['.svelte', '.ts']],
  ['android/app/src/main/java', ['.java']],
  ['android/app/src/main/res', ['.xml']]
]
const SCAN_FILES = ['index.html']
const SKIP = [
  'src/db/lookup.ts',
  'src/db/practice.ts',
  'src/db/analyse.ts',
  'android/app/src/main/res/values/nyx_tokens.xml'
]
const MARKUP = ['.svelte', '.html', '.xml']
const TEXT_NODE = />([^<>]{1,300})</g
const CJK_LITERAL = /(['"`])([^'"`\n]*[一-龥][^'"`\n]*)\1/g

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => p.endsWith(e))) out.push(p)
  }
  return out
}

function scanned() {
  const skip = new Set(SKIP.map((p) => join(ROOT, p)))
  return [
    ...SCAN_DIRS.flatMap(([d, exts]) => walk(join(ROOT, d), exts)),
    ...SCAN_FILES.map((f) => join(ROOT, f))
  ].filter((f) => !skip.has(f))
}

function dropExpr(text) {
  let cur = text
  for (;;) {
    const next = cur.replace(/\$\{[^{}]*\}/g, ' ')
    if (next === cur) return cur.replace(/\$\{[\s\S]*$/, ' ')
    cur = next
  }
}

/**
 * ★★ 字符串里的转义是**给编译器看的**，不是屏上的字。
 *   源码写 `'…自动补上。\n'`，屏上是一个换行；清单要是把 \n 两个字符原样摆出来，
 *   读的人会以为那是一处笔误 —— **照着清单「把多余的转义符删掉」，就把换行改没了**。
 *   ☘ 换行换成 `⏎` 摆明它在那儿（长度与断行要靠它判断），别的转义还原成本来的字符。
 *   ☘ 这是 2026-09-15 核对 B 从这份清单取的原文时发现的：三条「对不上」
 *     全是我这边多出来的转义符，**他取的是对的，错在我的清单**。
 *   ★ 用 split/join 不用正则：本环境的 heredoc 会把成对的反斜杠吃掉一个。
 */
function unescapeLiteral(s) {
  return s
    .split(BS + 'n').join('⏎')
    .split(BS + 't').join(' ')
    .split(BS + String.fromCharCode(39)).join(String.fromCharCode(39))
    .split(BS + '"').join('"')
    .split(BS + '`').join('`')
    .split(BS + BS).join(BS)
}

const lineAt = (body, at) => body.slice(0, at).split(NL).length

/** 值不值得进清单：去掉纯空白、纯符号、单字 */
const worth = (s) => {
  const t = s.trim()
  if (t.length < 2) return false
  return /[一-龥]/.test(t) || /[A-Za-z]{2}/.test(t)
}

/**
 * ★★ `<script>` / `<style>` 里**没有文字节点** —— 那里面的 `>` 与 `<` 是比较号、
 *   箭头函数、泛型。闸拿 `>…<` 硬扫没关系（它只找那几个禁词，扫多了不影响判断），
 *   清单不行：`{#each r.groups as g (g.` 这种半截代码会当成一句话摆到使用者面前。
 *   ☞ **范围没有变小**：脚本块里真正给人看的字是字符串，由 `CJK_LITERAL` 那一趟收。
 */
// ★ 这里故意不写反斜杠：本环境的 heredoc 会把成对的反斜杠吃掉一个
const SCRIPTY = new RegExp('<(script|style)[^>]*>[^]*?</' + BS + '1>', 'g')
const blankScripts = (src) =>
  src.replace(SCRIPTY, (blk) => blk.replace(new RegExp('[^' + NL + ']', 'g'), ' '))

/**
 * ★★★ 标记里的插值是 `{n}`，**不是** `${n}` —— `dropExpr` 只管后者。
 *   第一版我图省事，把「含花括号的一律丢掉」，句数从 2321 掉到 1098，
 *   我差点当成「去掉了垃圾」收工。查了降幅才发现丢的是**真的屏上字**：
 *   「共 {n} 条」「到期 {d} 天」这一整类全没了。
 *   ☞ **清单比闸小，漏掉的句子不会有任何东西报错** —— 他划的是清单，
 *     没列上的从此没人看过。所以由里往外把 `{…}` 换成空格，别整句丢。
 */
function dropSvelteExpr(text) {
  let cur = text
  for (;;) {
    const next = cur.replace(/\{[^{}]*\}/g, ' ')
    if (next === cur) return cur.replace(/[{}]/g, ' ')
    cur = next
  }
}

const rows = []
for (const f of scanned()) {
  const rel = relative(ROOT, f).split(BS).join('/')
  // ★ keepLines：行号 = 文件里的行号
  const body = stripSource(readFileSync(f, 'utf8'), f, true)
  if (MARKUP.some((e) => f.endsWith(e))) {
    for (const m of blankScripts(body).matchAll(TEXT_NODE)) {
      // ★ 跨行的不是一句话，是把两处文字节点之间的标记一起吞了 —— 只取第一行
      const t = unescapeLiteral(dropSvelteExpr(dropExpr(m[1].split(NL)[0]))).trim()
      if (worth(t)) rows.push({ rel, line: lineAt(body, m.index), kind: '标记', text: t })
    }
  }
  for (const m of body.matchAll(CJK_LITERAL)) {
    const t = unescapeLiteral(dropExpr(m[2])).trim()
    /**
     * ★★ 标记文件里，「一对引号之间」不等于「一个字符串」——
     *   `<div class="t zh2">读不出来</div><div class="s">` 这一行里，
     *   前一个属性的**收尾引号**和后一个属性的**起始引号**之间夹着
     *   `>读不出来</div><div class=`，含中文、不含引号，于是被当成一句话捡走。
     *   闸用同一条正则**没关系**（它只找那几个禁词，多扫不影响判断），
     *   清单不行：这种半截标记会当成一句话摆到使用者面前。
     *   ☞ 带尖括号的一律丢 —— 那一句本身由上面的文字节点那一趟正经收到了
     *     （`--verify` 最后一条会证明没漏）。
     */
    if (!worth(t)) continue
    if (MARKUP.some((e) => f.endsWith(e)) && /[<>]/.test(t)) continue
    rows.push({ rel, line: lineAt(body, m.index), kind: '字面量', text: t })
  }
}

const files = new Set(rows.map((r) => r.rel))
if (process.argv.includes('--verify')) {
  console.log(`句 ${rows.length} · 出现文案的文件 ${files.size} · 闸扫到的文件 ${scanned().length}`)
  const step = Math.max(1, Math.floor(rows.length / 60))
  let checked = 0
  const bad = []
  for (let i = 0; i < rows.length && checked < 60; i += step) {
    const r = rows[i]
    checked++
    const src = readFileSync(join(ROOT, r.rel), 'utf8').split(NL)[r.line - 1] ?? ''
    /**
     * ★ 拿**最长的一段连续非空白**去比，别拿整句 —— 整句里的 `${…}` 已经被
     *   `dropExpr` 换成空格，而原文那一行还留着表达式，逐字比必然对不上。
     *   第一版就这么假红了 29 行：**核对方法本身出错，比不核更误导**，
     *   因为它看起来是核过的。
     */
    const probe = r.text.split(/[\s⏎]+/).sort((a, b) => b.length - a.length)[0] ?? ''
    if (probe.length >= 2 && !src.includes(probe)) {
      bad.push(`${r.rel}:${r.line} 清单「${probe.slice(0, 20)}」，那一行是「${src.trim().slice(0, 44)}」`)
    }
  }
  console.log(`抽样回核 ${checked} 行 · 对不上 ${bad.length} 行`)

  /**
   * ★★★ 直接对着闸证明「没比它小」。
   *
   * 两趟取法里，`CJK_LITERAL` 和闸**逐字一样**，literal 不可能漏。
   * 唯一的差别是标记那一趟：我把 `<script>` / `<style>` 挖空了。
   * 所以这里拿**闸的原样取法**（不挖空）再跑一遍，把其中**含中文**的都捡出来，
   * 逐条问：清单里有没有覆盖到？没有就说明我那一刀切掉了真的屏上字。
   * ☞ 「我觉得挖掉的是代码」不算证明 —— 要让它自己说。
   */
  const mine = new Set(rows.map((r) => r.text))
  const uncovered = []
  for (const f of scanned()) {
    if (!MARKUP.some((e) => f.endsWith(e))) continue
    const rel = relative(ROOT, f).split(BS).join('/')
    const body = stripSource(readFileSync(f, 'utf8'), f, true)
    for (const m of body.matchAll(TEXT_NODE)) {
      const t = unescapeLiteral(dropSvelteExpr(dropExpr(m[1].split(NL)[0]))).trim()
      if (!worth(t) || !/[一-龥]/.test(t)) continue
      if (mine.has(t)) continue
      if ([...mine].some((x) => x.includes(t) || t.includes(x))) continue
      uncovered.push(`${rel}:${lineAt(body, m.index)} 「${t.slice(0, 40)}」`)
    }
  }
  console.log(`闸看得见、清单没覆盖的中文句 ${uncovered.length} 条`)
  for (const u of uncovered.slice(0, 10)) console.error('  ★ ' + u)
  if (uncovered.length) process.exitCode = 1
  for (const b of bad.slice(0, 8)) console.error('  ★ ' + b)
  process.exit(bad.length ? 1 : 0)
}
console.log('文件\t行\t类别\t现文')
for (const r of rows) console.log(`${r.rel}\t${r.line}\t${r.kind}\t${r.text}`)
