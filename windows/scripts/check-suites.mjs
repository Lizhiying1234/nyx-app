/**
 * check:suites · 测试套的分层闸（T-1.4 · 2026-09-04 · R-018）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * `verify` 是一条手写的 20 多段 `&&` 长句。新加一套 smoke 时要记得回来接上去，
 * **忘了也没有任何提示** —— 于是到 2026-09-04 审计时，`smoke:ops` · `smoke:hint` ·
 * `smoke:fold` · `smoke:badge` · `smoke:first` 五套已经掉在 `verify` 之外好一阵子：
 * 脚本还在、单独跑还是绿的，只是**没人跑它们了**。R-018 记的就是这件事。
 *
 * 「每轮收尾跑全量」这条规矩，靠人记得往一条长句里补一段，是守不住的。
 *
 * ── 药：把分层写成断言，掉队当场红 ────────────────────────
 *
 *   ① 门的四件事都在：`gate` 能到达 `check` · `test` · `test:db` · `gate:android`
 *   ② 门里没有 Electron smoke —— 门要几分钟内跑完，smoke 是 `verify` 的活
 *   ③ 一条 smoke 都不许掉队：每条 `smoke:*` 都能从 `verify:all` 到达
 *   ④ 除 `smoke:packaged`（它要先 `npm run package`，只属于 `verify:all`）外，
 *      每条 `smoke:*` 都在 `verify` 里
 *   ⑤ `verify` ⊇ `gate` —— 门是全量的真子集，不是另一条平行的线
 *   ⑥ 每条 `smoke:*` 都带 `--test-concurrency=1`：smoke 套不并行，宁可慢不要偶发
 *   ⑦ 每条 `test:*` 都在 `gate` 里；每条 `check:*` 都在 `check` 里
 *
 * ★ 判据只看 `package.json` 的 `scripts`，一个字都不猜：`npm run x` / `npm x` 顺着走，
 *   走成传递闭包。所以 `verify` 只要写 `npm run gate`，`check` 那一串就自动算在里面。
 * ★ 有意不做的：不看测试文件内容、不判断某套该不该存在。那是人读的时候的事。
 *
 * 用法：node scripts/check-suites.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { PACKAGED_ONLY, verifyPlan } from './lib/suites.mjs'

const NL = String.fromCharCode(10)
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}
const fail = []

/**
 * 一条脚本里点名了哪些别的脚本。
 * ★ 不用正则 —— 反斜杠一律绕开写（D-460）。按空格切开找 `npm` 就够：
 *   `npm run check:css` → check:css；`npm test` → test；`npm run build` → build。
 */
function refsIn(body) {
  const out = []
  const parts = body.split(' ').filter((p) => p.length > 0)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== 'npm') continue
    let j = i + 1
    if (parts[j] === 'run') j++
    const name = parts[j]
    if (name && scripts[name] !== undefined) out.push(name)
  }
  return out
}

/** 从一条脚本出发能到达的全部脚本（含它自己） */
function reach(name, seen = new Set()) {
  if (seen.has(name)) return seen
  seen.add(name)
  if (scripts[name] === undefined) return seen
  for (const r of refsIn(scripts[name])) reach(r, seen)
  return seen
}

const names = Object.keys(scripts)
const smokes = names.filter((n) => n === 'smoke' || n.startsWith('smoke:'))
const tests = names.filter((n) => n === 'test' || n.startsWith('test:'))
const checks = names.filter((n) => n.startsWith('check:'))


for (const must of ['gate', 'gate:android', 'verify', 'verify:all', 'check', 'test', 'test:db']) {
  if (scripts[must] === undefined) fail.push(`缺脚本：${must}`)
}
if (fail.length > 0) {
  console.error(NL + '✗ check:suites' + NL + fail.map((f) => '  • ' + f).join(NL))
  process.exit(1)
}

const inGate = reach('gate')
/**
 * ★★ `verify` 从「&& 长句」换成了 `node scripts/verify.mjs`（2026-09-07）——
 *   顺着 `npm run x` 走的那套闭包在这里断了，所以要把**它真正会跑的那几套**接上。
 *
 * 名单不是抄的，是同一份：`scripts/lib/suites.mjs::verifyPlan`（跑的那个脚本也用它）。
 * 判据搬了，守它的闸就得跟着搬 —— 各写一份的话，某天两边分家，
 * 而表现是「闸说全在册，实际少跑几套」，没人看得见。
 */
const plan = verifyPlan(scripts)
/** `verify` 得真的是那个跑全量的脚本，下面才认它「跑到了」那几套 */
const VERIFY_RUNNER = 'scripts/verify.mjs'
const verifyIsRunner = (scripts.verify ?? '').includes(VERIFY_RUNNER)
/**
 * 顺着 `npm run x` 走完之后，凡是到得了 `verify` 的，都补上它真正会跑的那几套。
 *
 * ★ **只有 `verify` 真是那个脚本时才补**。否则（比如有人把它改回一条 &&
 *   长句、还顺手删掉几套）③④ 那两条会变成永远成立的空话 ——
 *   一条永远不红的闸，和没有闸对使用者是同一回事。
 */
const withPlan = (name) => {
  const set = reach(name)
  if (verifyIsRunner && set.has('verify')) {
    for (const s of plan.suites) for (const x of reach(s)) set.add(x)
  }
  return set
}
const inVerify = withPlan('verify')
const inVerifyAll = withPlan('verify:all')
const inCheck = reach('check')

// ① 门的四件事
for (const must of ['check', 'test', 'test:db', 'gate:android']) {
  if (!inGate.has(must)) fail.push(`gate 里没有 ${must} —— 合并门 = check + 单测 + test:db + Android ② 档`)
}

// ② 门里不许有 Electron smoke
for (const s of smokes) {
  if (inGate.has(s)) fail.push(`gate 里出现了 ${s} —— 门不含任何 Electron smoke（它要几分钟内跑完）`)
}

// ③④ 一条 smoke 都不许掉队
for (const s of smokes) {
  if (!inVerifyAll.has(s)) {
    fail.push(`${s} 从 verify:all 到不了 —— 脚本还在、单独跑还绿，但没人跑它了（R-018 就是这么发生的）`)
  } else if (!PACKAGED_ONLY.has(s) && !inVerify.has(s)) {
    fail.push(`${s} 不在 verify 里 —— verify 是全量；只属于 verify:all 的目前只有 smoke:packaged`)
  }
}

// ⑤ verify ⊇ gate
for (const g of inGate) {
  if (!inVerify.has(g)) fail.push(`gate 跑了 ${g}，verify 却到不了它 —— 门必须是全量的真子集`)
}

// ⑥ smoke 套不并行
for (const s of smokes) {
  if (!scripts[s].includes('--test-concurrency=1')) {
    fail.push(`${s} 没写 --test-concurrency=1 —— smoke 套不并行，宁可慢不要偶发`)
  }
}

// ⑦ 单测都在门里；检查都在 check 里
for (const t of tests) if (!inGate.has(t)) fail.push(`${t} 不在 gate 里 —— 单测属于合并门`)
for (const c of checks) if (!inCheck.has(c)) fail.push(`${c} 不在 npm run check 里`)

/**
 * ⑧ `tests/db-safety/` 下的每一段都要被入口 import 到（T-4.6 · 2026-09-06）
 *
 * ── 拆分带进来的一个新的静默失效面 ────────────────────────
 *
 * `tests/db-safety.ts` 从两万行拆成了入口 + 十几个段，入口靠 `import './db-safety/x.ts'`
 * 把它们串起来。**漏掉一行 import，那一段的用例就整段消失，而 `test:db` 照样 exit 0。**
 * 实测（T-4.6 的负向对照）：拿掉 `tombstone.ts` 那一行 → `通过 562 · 失败 0`，
 * 44 条用例无声没了，退出码还是 0。
 *
 * 拆分之前不存在这个失败形状 —— 一个文件里的东西没法「忘记引入」。
 * 所以这道闸是拆分自己带来的债，必须由拆分这一轮还上：
 * 段文件是自己声明的（放进那个目录就是一段），闸只问一句「入口认不认得它」。
 *
 * ★ 有意不数用例条数：那个数字每加一条用例就要改一次，改烦了就会被人调大调小，
 *   而这条判据一次都不用维护 —— 新加一段忘了接线，当场红。
 */
const DBS_DIR = 'tests/db-safety'
const DBS_ENTRY = 'tests/db-safety.ts'
/** 不是「一段用例」的那两个：骨架与共用夹具，由各段自己 import */
const NOT_A_SECTION = new Set(['harness.ts', 'fixtures.ts'])
if (existsSync(DBS_DIR) && existsSync(DBS_ENTRY)) {
  const entry = readFileSync(DBS_ENTRY, 'utf8')
  for (const f of readdirSync(DBS_DIR).sort()) {
    if (!f.endsWith('.ts') || NOT_A_SECTION.has(f)) continue
    if (!entry.includes(`./db-safety/${f}`)) {
      fail.push(
        `tests/db-safety/${f} 没有被 tests/db-safety.ts import —— ` +
          `那一段的用例一条都不会跑，而 test:db 会照样 exit 0`
      )
    }
  }
}

/**
 * ⑨ `verify` **不许再是一条 `&&` 长句**（2026-09-07）
 *
 * `&&` 会短路：第一条红之后，后面十几套一次都跑不到，
 * 而屏幕上只有一个非零退出码 —— 人以为自己跑了全量。
 * 2026-09-07 真发生过一整轮（`smoke:study` 上一条既有的红挡住了后面 13 套）。
 * 所以「跑全量」这件事必须由 `scripts/verify.mjs` 来做：它一套一套跑完再算总账。
 *
 * ★ 负向对照：把 `verify` 改回 `npm run gate && npm run smoke && …` → 这一条当场红。
 */
if (!verifyIsRunner) {
  fail.push(
    `verify 不是 ${VERIFY_RUNNER} —— 换回 && 长句就又会短路：` +
      '第一条红之后后面十几套一次都跑不到，而退出码看不出这件事'
  )
} else if ((scripts.verify ?? '').includes('&&')) {
  fail.push('verify 里还留着 && —— 那一段照样会短路，全量就不是全量了')
}

if (fail.length > 0) {
  console.error(NL + `✗ check:suites · 测试套分层不对（${fail.length} 处）：` + NL)
  for (const f of fail) console.error('  • ' + f)
  console.error(
    NL +
      '  ── 怎么办 ────────────────────────────────────────────────' +
      NL +
      '  · 新加了一套 smoke：接进 verify（或 verify:all），并带上 --test-concurrency=1' +
      NL +
      '  · 新加了一条 check:/test:：分别接进 npm run check / npm run gate' +
      NL +
      '  · 真要让某套只属于 verify:all：在本脚本的 PACKAGED_ONLY 里写明，并说清为什么' +
      NL
  )
  process.exit(1)
}

console.log(
  `✓ check:suites　gate ${inGate.size} 条（无 smoke）· verify ${inVerify.size} 条 ⊇ gate · ` +
    `smoke ${smokes.length} 套全部在册且不并行 · verify 逐套跑 ${plan.suites.length} 套（不短路）`
)
