/**
 * 护栏 · 回收站的保留天数**只许有一个出处** —— I-202 / D-087（2026-09-09 使用者裁 30 → 10）。
 *
 * ══ 为什么要有它（真事）══════════════════════════════════════
 * 2026-09-09 把保留期从 30 天改成 10 天。当时**全仓有 20 处界面文案把「30 天」
 * 写死在句子里**，那一轮把话收进了 `core/sql/trash.ts`（`TRASH_KEEP_TEXT` /
 * `TRASH_PURGE_TEXT`），让话从数推导出来。
 *
 * **但漏了一处 —— 因为它不是句子，是算式**：
 *   `Trash.svelte`  const days = (t) => Math.max(0, 30 - Math.floor(…/86_400_000))
 * 于是回收站同一屏上：页头说「10 天后彻底清除」，**每一行说「还有 21 天」**，
 * 而真正执行清除的 `browse.ts` 用的是 `TRASH_DAYS`（10）。
 * ☞ **那一行向他承诺了 20 天他其实没有的时间**，而彻底删除是立碑永不同步的那一档，
 *   没有后悔余地。
 *
 * ══ 这道闸钉什么 ═══════════════════════════════════════════
 * 凡是**碰回收站保留期的文件**（提到 `TRASH_DAYS` 一族的，加上 `Trash.svelte` / `browse.ts`），
 * **不许出现「写成数字的天数」参与天数算式**：
 *     <数字> - Math.floor(…)      <数字> * 86_400_000      86_400_000 * <数字>
 * 天数只能从 `TRASH_DAYS` 来。
 *
 * ★ 为什么只钉算式、不钉「30 天」这几个字：
 *   `Kit.svelte` 有「近 7 天 / 近 30 天」两颗**统计区间**按钮 —— 那是另一件事，
 *   连坐会让这道闸第一次误报之后就被加白名单然后失效。
 *   **句子那一半已经由 `TRASH_KEEP_TEXT` / `TRASH_PURGE_TEXT` 守着了。**
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

/** 天数算式里出现裸数字 —— 三种写法 */
const BAD = [
  /(?<![\w.$])(\d[\d_]*)\s*-\s*Math\.floor/,
  /(?<![\w.$])(\d[\d_]*)\s*\*\s*(?:86_?400_?000|864e5)/,
  /(?:86_?400_?000|864e5)\s*\*\s*(\d[\d_]*)(?![\w.])/
]

/** 这几个文件一定在范围内，哪怕将来它们不再直接提 TRASH_DAYS */
const ALWAYS = ['src/renderer/src/Trash.svelte', 'src/main/browse.ts', 'src/core/sql/trash.ts']

const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|svelte)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p)
  }
}
walk(SRC)

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const scope = files.filter((p) => {
  const r = rel(p)
  if (ALWAYS.includes(r)) return true
  return /TRASH_DAYS|TRASH_KEEP_TEXT|TRASH_PURGE_TEXT/.test(fs.readFileSync(p, 'utf8'))
})

const bad = []
for (const p of scope) {
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  lines.forEach((ln, i) => {
    const bare = ln.trim()
    if (bare.startsWith('*') || bare.startsWith('//')) return // 注释里怎么写都行
    for (const re of BAD) {
      const m = ln.match(re)
      if (m) { bad.push({ r: rel(p), n: i + 1, num: m[1], txt: bare.slice(0, 92) }); break }
    }
  })
}

if (bad.length) {
  console.error('✗ 回收站的保留天数出现了第二个出处 —— 天数写成了数字，没走 TRASH_DAYS（I-202）：')
  for (const b of bad) console.error(`   ${b.r}:${b.n}  数字 ${b.num}  →  ${b.txt}`)
  console.error('')
  console.error('  真正执行清除的那条路用的是 `TRASH_DAYS`。屏上再出现另一个数，')
  console.error('  就等于向他承诺一个他其实没有的期限 —— 而彻底删除是立碑永不同步的那一档。')
  console.error('  改法：从 `@core/sql/trash.ts` 取 `TRASH_DAYS`，别写数字。')
  process.exit(1)
}
console.log(`✓ 回收站保留期只有一个出处（扫了 ${scope.length} 份碰它的文件，天数算式里没有裸数字）`)
