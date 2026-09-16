/**
 * 护栏 ·「这一条算不算静默」只许有一个出处 —— I-204 / D-023 / D-135 / M-003。
 *
 * ══ 为什么要有它（真事）══════════════════════════════════════
 * 领域判据是**条件式**（`core/silence.ts` · `core/sql/silence.ts`）：
 *   跑产出线的（B 层且不是整句）→ 只看产出线；不跑的 → 只看认读线。
 *
 * 但上一轮之前，SQL 里写的是**「或」**：`production_state='silent' or card_silent=1`
 * ——「任一线静默即视为静默」。那四处 SQL 收干净了，**界面层两处没跟**：
 *   `Workbench.svelte`  i.productionState === 'silent' || i.cardSilent
 *   `Search.svelte`     i.cardSilent || i.productionState === 'silent'
 *
 * 「或」比条件式**严格更宽**，所以错的方向只有一个，而且总是同一个：
 * **界面把条目藏起来了，而引擎照样把它排进练习。**
 * 他以为静默了、列表里也确实看不见了，练习却还在发它。
 *
 * ★ 2026-09-16 在他真库上逐条对拍：622 条未删知识点，两式**不一致 0 条** ——
 *   因为两条静默位**永远一起设**（`repo.ts` / `library.ts` 都在同一个事务里改两张表）。
 *   **但同步能造出分叉**：同步按表名逐行写，`items` 与 `reading_cards` 是两张表、
 *   两个包、到达有先后（同型现象当晚已见：`answers` 先到而父 `sessions` 未到）。
 *   窗口期内两条线不一致，上面那个后果就会真的发生。
 *
 * ══ 这道闸钉什么 ═══════════════════════════════════════════
 * 除了**权威那两份**（`core/silence.ts` 与 `core/sql/silence.ts`），
 * 全仓任何一行都不许把「产出线静默」和「认读线静默」**自己组合成一个判断**。
 * 要判就调 core 导出的 `isItemSilent` / `isRowSilent`，或用 SQL 宏 `IS_SILENT`。
 *
 * ★ 只看**同一行里两者同时出现**：写入语句（`set silent = 1` / `set production_state = 'silent'`）
 *   各自成行，不会被误伤；注释行一概不算。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

/** 权威那两份 —— 判据本来就该长在这里 */
const AUTHORITY = new Set(['src/core/silence.ts', 'src/core/sql/silence.ts'])

/** 「产出线静默」的各种写法 */
const PROD = /production_?[sS]tate\s*(===?|==)\s*['"]silent['"]/
/** 「认读线静默」的各种写法 */
const READ = /card_?[sS]ilent|\.silent\s*(===?|==)\s*1|\bsilent\s*=\s*1\b/

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
const bad = []
for (const p of files) {
  const r = rel(p)
  if (AUTHORITY.has(r)) continue
  fs.readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
    const bare = ln.trim()
    if (bare.startsWith('*') || bare.startsWith('//') || bare.startsWith('/*')) return
    if (PROD.test(ln) && READ.test(ln)) bad.push({ r, n: i + 1, txt: bare.slice(0, 96) })
  })
}

if (bad.length) {
  console.error('✗ 「算不算静默」出现了第二个出处 —— 有人把两条线自己组合成了一个判断（I-204）：')
  for (const b of bad) console.error(`   ${b.r}:${b.n}  ${b.txt}`)
  console.error('')
  console.error('  领域判据是**条件式**：跑产出线的只看产出线，不跑的只看认读线。')
  console.error('  写成「或」比它严格更宽 —— 界面会把条目藏起来，而引擎照样把它排进练习。')
  console.error('  改法：调 `@core/silence.ts` 的 `isRowSilent` / `isItemSilent`，或用 SQL 宏 `IS_SILENT`。')
  process.exit(1)
}
console.log(`✓ 「算不算静默」只有一个出处（扫了 ${files.length} 份，权威 ${AUTHORITY.size} 份除外）`)
