/**
 * 令牌闸 —— **用了但没定义的 CSS 变量**（2026-09-09）
 *
 * ── 它抓的是什么 ────────────────────────────────────────────
 *
 * `color: var(--color-text-on-warm)` 里那个名字要是不存在，**CSS 一个字都不报** ——
 * 它静静退回属性的初始值。于是屏幕上是黑字，而代码看起来在说「暖底上的深色字」，
 * 两边都说得通，谁也不会去查。
 *
 * 这条闸是 Nyx-UI-Android 会话提的：它在 `--violet-soft` 上被咬过一次 ——
 * 空态那三粒星一直是**黑**的，而代码写着「柔紫」。它补了闸，当天就替它挡住了
 * 第二次（指针指到一条缺 `--color-text-on-warm` 的分支）。Windows 这边照做一份。
 *
 * ★ 加的时候它是**绿的**（259 个定义 · 220 个引用 · 0 欠账）——
 *   所以这不是「修一个 bug」，是**把一类静默失败钉住**。
 *
 * ── 为什么不能只扫样式表 ────────────────────────────────────
 *
 * `var(--x)` 也出现在 `.svelte` 的行内 `style=""` 里。只扫 `styles/*.css`
 * 会漏掉一半，而漏掉的那一半恰恰是最容易写错的（行内没有编辑器补全）。
 *
 * ── 白名单：运行期拼出来的名字 ──────────────────────────────
 *
 * `var(--g{g})` 这种在模板里拼名字的，静态扫描看到的是 `--g` —— 它当然没定义。
 * 这类**逐个点名**放行（不是按前缀放行）：点名的那一刻要说清「真名是哪几个、在哪定义」，
 * 否则白名单本身就成了下一个洞。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'

const CSS_DIRS = ['src/renderer/styles']
const EXTRA_CSS = ['src/core/design/color-tokens.css']
const SCAN_ROOT = 'src'

/**
 * 运行期拼名字的，逐个点名放行。
 * 格式：扫到的残名 → 它真正会拼出哪几个、以及那几个在哪定义。
 */
const RUNTIME = new Map([
  [
    '--g',
    'Practice.svelte 的 `var(--g{g})` —— g 是 1..4，拼成 --g1 / --g2 / --g3 / --g4，' +
      '四个都在 tokens.css 的「判分四档」那一节里定义'
  ]
])

const defined = new Set()
for (const f of EXTRA_CSS) collectDefs(f)
for (const d of CSS_DIRS) {
  for (const n of readdirSync(d)) if (n.endsWith('.css')) collectDefs(join(d, n))
}

function collectDefs(file) {
  const s = readFileSync(file, 'utf8')
  for (const m of s.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1])
}

/** 用到的：名字 → 出现在哪几个文件 */
const used = new Map()
walk(SCAN_ROOT)
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      walk(p)
      continue
    }
    if (!['.css', '.svelte', '.ts'].includes(extname(e.name))) continue
    const s = readFileSync(p, 'utf8')
    for (const m of s.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], new Set())
      used.get(m[1]).add(p)
    }
  }
}

const missing = [...used.keys()].filter((t) => !defined.has(t) && !RUNTIME.has(t)).sort()

/**
 * ★★ TOK-2 · **反过来盯白名单**（Nyx-UI-Android 会话提的，2026-09-09）——
 * 白名单里的每一个都必须**还真的被用着**，用没了就该从白名单删。
 *
 * 为什么这一条不能省：白名单是**放行**，而放行项一旦过期就成了一个洞 ——
 * 哪天有人真写了个 `var(--g)`（不拼名字的那种），它会被这条过期的放行悄悄咽下去。
 * 这是这个项目一再付学费的那类账：**判据自己也会漂，守判据的东西要盯着判据。**
 */
const stale = [...RUNTIME.keys()].filter((t) => !used.has(t)).sort()
if (stale.length > 0) {
  console.error('✖ 白名单里这几个已经没人用了 —— 放行项过期就是一个洞：\n')
  for (const t of stale) console.error(`  ${t}　（当初放行的理由：${RUNTIME.get(t)}）`)
  console.error('\n  从 scripts/check-tokens.mjs 的 RUNTIME 里删掉它。')
  process.exit(1)
}

if (missing.length > 0) {
  console.error('✖ 这些令牌用了但没人定义 —— CSS 不会报错，它只会静静退回属性的初始值：\n')
  for (const t of missing) {
    console.error(`  ${t}`)
    for (const f of [...used.get(t)].sort()) console.error(`      ${f}`)
  }
  console.error(
    '\n  要么补定义（core/design/color-tokens.css 或 styles/tokens.css），' +
      '\n  要么改成已有的那一个；确实是运行期拼出来的名字，' +
      '\n  就进 scripts/check-tokens.mjs 的 RUNTIME 白名单并**说清真名是哪几个**。'
  )
  process.exit(1)
}

/**
 * ★★ TOK-3 · **每个颜色令牌都得有一个归属的 UI 部件**（2026-09-13）
 *
 * 使用者要的 Settings → Resources → Colors 是「能拆到具体 UI 部件逐项调」。
 * 那一页上的 token 名单是从 `color-tokens.css` **现读**的（唯一真相），
 * 再按前缀落进 `renderer/src/colors-parts.ts` 里某一区。
 *
 * ★ 不守这一条会怎样：新加一个 `--color-foo-bar`，分区表里没有 `foo`，
 *   于是它**安静地从那一页上消失** —— 不报错、不留空白、什么都看不出来，
 *   只是他永远调不到那一项。
 * ★ 反方向也盯（同 TOK-2 的道理）：分区表里写了、CSS 里却没有的前缀，
 *   是一个过期的分组 —— 它会在那一页上画出一个永远是空的分区。
 */
const PARTS_FILE = 'src/renderer/src/colors-parts.ts'
const partsSrc = readFileSync(PARTS_FILE, 'utf8')
const knownPrefixes = new Set()
for (const blk of partsSrc.matchAll(/prefixes:\s*\[([^\]]*)\]/g)) {
  for (const m of blk[1].matchAll(/'([a-z0-9-]+)'/g)) knownPrefixes.add(m[1])
}

/** 一个颜色令牌名 → 它的分区前缀（和 colors-parts.ts 的 sectionOf 同一条判据）*/
function prefixOf(t) {
  if (t.startsWith('--btn-')) return 'btn'
  if (t.startsWith('--color-')) return t.slice('--color-'.length).split('-')[0]
  return t.slice(2).split('-')[0]
}

const colorTokens = []
for (const m of readFileSync('src/core/design/color-tokens.css', 'utf8').matchAll(
  /^\s*(--[a-zA-Z0-9_-]+)\s*:/gm
)) {
  colorTokens.push(m[1])
}
const unclassified = [...new Set(colorTokens.map(prefixOf))]
  .filter((p) => !knownPrefixes.has(p))
  .sort()
const deadSections = [...knownPrefixes]
  .filter((p) => !colorTokens.some((t) => prefixOf(t) === p))
  .sort()

if (unclassified.length > 0) {
  console.error(
    '✖ 这几个颜色令牌前缀没归类 —— 它们会从 Settings → Resources → Colors 上安静地消失：\n'
  )
  for (const p of unclassified) {
    const eg = colorTokens.filter((t) => prefixOf(t) === p).slice(0, 3)
    console.error(`  ${p}　（比如：${eg.join(' · ')}）`)
  }
  console.error(`\n  把它归进 ${PARTS_FILE} 的 COLOR_SECTIONS 里某一区的 prefixes。`)
  process.exit(1)
}
if (deadSections.length > 0) {
  console.error('✖ 分区表里这几个前缀 CSS 里已经没有了 —— 它会画出一个永远是空的分区：\n')
  for (const p of deadSections) console.error(`  ${p}`)
  console.error(`\n  从 ${PARTS_FILE} 的 prefixes 里删掉它。`)
  process.exit(1)
}

const runtimeNote = RUNTIME.size > 0 ? ` · 运行期拼名放行 ${RUNTIME.size} 个（都还用着）` : ''
console.log(
  `✓ check:tokens　定义 ${defined.size} 个 · 引用 ${used.size} 个 · 没有用了却没定义的${runtimeNote}` +
    `\n\u3000\u3000\u00b7 颜色令牌 ${colorTokens.length} 个，${knownPrefixes.size} 个前缀全部归了类（TOK-3）`
)
