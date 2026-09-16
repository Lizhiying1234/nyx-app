/**
 * 护栏 · 出题「先生成成功、再替换」—— I-207 / D-129。
 *
 * ══ 为什么要有它（真事）══════════════════════════════════════
 * 2026-09-16 手机真机实测：`quixoticism` 14 道未做题 → 0 道，
 * 全库未做 145 → 116。**不是做掉的**（`used_at` 没变多），是**删掉的**。
 *
 * 原因是这段代码的次序：
 *   ① 勾选/规则变了 → `delete from questions where item_id=? and 未做`
 *   ② 去调 AI 生成
 *   ③ 生成抛错（约一半会抛：模型把额度全用在思考上）
 *   ④ 旧题没了，新题也没有 —— 而屏上只说「模型额度」，一个字没提缓存题被清了
 *
 * I-198 那道护栏挡不住：它护的是**被 `answers` 指着的**行，
 * 这些题正好是没做过的，落在删除范围里。
 *
 * ══ 这道闸钉什么 ═══════════════════════════════════════════
 * **同一个函数里**，`delete from questions` 不许出现在这个函数第一次
 * `callAi(` 之前。要删旧题，必须先把新题拿到手。
 *
 * ★ 边界（说清楚，免得下一个人以为它管的比实际多）：
 *   · 判的是**函数内的行号先后**，靠顶层 `function` 声明切函数体；
 *     不认嵌套函数、不认箭头函数里的分支。
 *   · 它**不检查**删与插是不是在同一个事务里 —— 那条由 ② 档用例钉
 *     （`tests/db-safety/questions-replace.ts`）。
 *   · 注释行一概不算。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

const DEL = /delete\s+from\s+questions/i
const GEN = /callAi\s*\(/
const FN = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/

const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p)
  }
}
walk(SRC)

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const isComment = (ln) => {
  const b = ln.trim()
  return b.startsWith('*') || b.startsWith('//') || b.startsWith('/*')
}

const bad = []
let checked = 0
for (const p of files) {
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  // 顶层函数的起始行
  const starts = []
  lines.forEach((ln, i) => {
    const m = FN.exec(ln)
    if (m) starts.push({ at: i, name: m[1] })
  })
  lines.forEach((ln, i) => {
    if (isComment(ln) || !DEL.test(ln)) return
    checked += 1
    const fn = [...starts].reverse().find((s) => s.at < i)
    const from = fn ? fn.at : 0
    const genBefore = lines.slice(from, i).some((l) => !isComment(l) && GEN.test(l))
    if (!genBefore) {
      bad.push({ r: rel(p), n: i + 1, fn: fn ? fn.name : '（顶层）', txt: ln.trim().slice(0, 90) })
    }
  })
}

if (bad.length) {
  console.error('✗ 出题是「先删旧题、再去生成」—— 生成一抛错，他缓存的题就没了（I-207）：')
  for (const b of bad) console.error(`   ${b.r}:${b.n}  在 ${b.fn}() 里，之前没有 callAi(\n      ${b.txt}`)
  console.error('')
  console.error('  次序必须是：先拿到新题 → 再在同一个事务里删旧插新。')
  console.error('  生成抛错时旧题要一道不少，屏上说「这次没出成，还是上一批题」。')
  console.error('  判据在 `@core/question-refresh.ts`，两端调同一份。')
  process.exit(1)
}
console.log(`✓ 出题「先生成成功、再替换」（扫了 ${files.length} 份，核了 ${checked} 处删除）`)
