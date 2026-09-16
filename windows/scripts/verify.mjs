/**
 * `npm run verify` —— 全量验收：**一套一套跑完，不短路**（2026-09-07）
 *
 * ══ 病 ═══════════════════════════════════════════════════════
 *
 * 以前 `verify` 是一条 `npm run gate && npm run smoke && npm run smoke:study && …`
 * 的长句。`&&` 会短路：**前面任何一套红，后面的一次都跑不到**，
 * 而屏幕上只剩一个非零退出码。人看到的是「跑了全量，红了一条」，
 * 事实是「跑到第 2 套就停了，后面 13 套今天没人跑过」。
 *
 * 2026-09-07 真发生了：`smoke:study` 上有一条既有的红（朗读页文案被 Voice 那批改了），
 * 于是那一轮所有人的 `verify` 都停在那里 —— nav / errors / esc / reading / ops / first
 * 一次都没跑。而「每轮收尾跑全量」这条规矩，正是为了不让别处的闸安静地红着。
 * **一条会中途停下的全量，比没有全量更坏**：它让人以为自己跑过了。
 *
 * ══ 药 ═══════════════════════════════════════════════════════
 *
 *   · 每一套都跑完，谁红都不影响别人开跑
 *   · 每一套当场打印一行结论（通过 / 失败 / cancelled / 退出码 / 用时）
 *   · 末尾一张汇总表，红的排在最上面
 *   · **任何一套红 → 整体 exit 1**（门还是门，只是不再瞒着后面那些）
 *
 * ★ `fail 0` 不等于全绿：`cancelled` 也要看（一套里前面的用例炸了，
 *   后面的会被标成 cancelled 而不是 fail）。所以汇总表把它单列一列。
 * ★ 跑哪几套**不写在这里** —— 名单在 `scripts/lib/suites.mjs`，
 *   由 `package.json` 里的 `smoke*` 自动得出，`check:suites` 守着同一份。
 *
 * 用法：node scripts/verify.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { verifyPlan } from './lib/suites.mjs'

const NL = String.fromCharCode(10)
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}
const plan = verifyPlan(scripts)

/**
 * 跑一条 npm 脚本：**边跑边打印**，同时把输出留一份下来数数。
 *
 * ★ 命令写成一条字符串 + `shell: true` —— Node 18.20+ 起不经 shell 执行 `.cmd`
 *   直接失败（`gate-android.mjs` / `build-if-stale.mjs` 头上都记着这一笔）。
 * ★ 不用 `stdio:'inherit'`：那样拿不到输出，数不出通过 / 失败 / cancelled。
 *   所以自己转发一遍 —— 屏幕上看到的和以前一模一样。
 */
function run(name) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(`npm run ${name}`, { shell: true })
    let out = ''
    const pass = (buf, to) => {
      const s = buf.toString()
      out += s
      to.write(s)
    }
    child.stdout.on('data', (b) => pass(b, process.stdout))
    child.stderr.on('data', (b) => pass(b, process.stderr))
    child.on('close', (code) => {
      resolve({ name, code: code ?? 1, out, ms: Date.now() - t0 })
    })
  })
}

/**
 * 从一套的输出里数出通过 / 失败 / cancelled。
 *
 * 两种格式都认：
 *   · `node --test` 的 `ℹ pass N` / `ℹ fail N` / `ℹ cancelled N`
 *   · `test:db` 自己那行 `通过 N · 失败 N`
 * 数不出来就留空（`gate` 是复合的，里面好几段各有各的汇总，不强行加总）。
 *
 * ★ 只认**行首**那几个字，不做全文正则：一条用例的名字里带「fail」很正常。
 */
function countsOf(out) {
  const got = { pass: null, fail: null, cancelled: null }
  for (const raw of out.split(NL)) {
    const line = raw.trim()
    for (const [k, head] of [
      ['pass', 'ℹ pass '],
      ['fail', 'ℹ fail '],
      ['cancelled', 'ℹ cancelled ']
    ]) {
      if (!line.startsWith(head)) continue
      const n = Number(line.slice(head.length).trim())
      if (Number.isFinite(n)) got[k] = (got[k] ?? 0) + n
    }
    // test:db 的收尾行：`通过 653 · 失败 0`
    if (line.startsWith('通过 ') && line.includes('失败')) {
      const parts = line.split('·').map((x) => x.trim())
      const p = Number(parts[0].replace('通过', '').trim())
      const f = Number((parts[1] ?? '').replace('失败', '').trim())
      if (Number.isFinite(p)) got.pass = (got.pass ?? 0) + p
      if (Number.isFinite(f)) got.fail = (got.fail ?? 0) + f
    }
  }
  return got
}

const secs = (ms) => `${Math.round(ms / 1000)} s`
const cell = (v, w) => String(v ?? '—').padStart(w)

console.log(`verify · ${plan.suites.length} 套，一套一套跑完，中途不停${NL}`)

const results = []
for (const name of plan.suites) {
  console.log(`${NL}▶ verify · ${name}（第 ${results.length + 1} / ${plan.suites.length} 套）`)
  const r = await run(name)
  const c = countsOf(r.out)
  results.push({ ...r, ...c })
  const verdict = r.code === 0 ? '✓' : '✗'
  console.log(
    `${verdict} ${name}　通过 ${c.pass ?? '—'} · 失败 ${c.fail ?? '—'} · ` +
      `cancelled ${c.cancelled ?? '—'} · 退出码 ${r.code} · ${secs(r.ms)}`
  )
}

// ── 汇总：红的排最上面，谁都不许被埋在 4000 行输出里 ──────────
const red = results.filter((r) => r.code !== 0)
const w = Math.max(...results.map((r) => r.name.length), 4)
console.log(`${NL}${NL}══ verify 汇总 ══════════════════════════════════════════`)
console.log(`  ${'套'.padEnd(w)}　通过　失败　cancel　退出码　用时`)
for (const r of [...red, ...results.filter((x) => x.code === 0)]) {
  console.log(
    `  ${r.name.padEnd(w)}　${cell(r.pass, 4)}　${cell(r.fail, 4)}　${cell(r.cancelled, 6)}　` +
      `${cell(r.code, 6)}　${secs(r.ms).padStart(6)}`
  )
}
const total = results.reduce((n, r) => n + r.ms, 0)
console.log(
  `  ${'─'.repeat(w + 40)}${NL}  ${results.length} 套 · 绿 ${results.length - red.length} · ` +
    `红 ${red.length} · 合计 ${Math.round(total / 60000)} 分钟`
)

if (red.length > 0) {
  console.error(
    `${NL}✗ verify：${red.length} 套红（${red.map((r) => r.name).join(' · ')}）。` +
      `${NL}  **其余的都跑完了** —— 这正是这个脚本存在的理由：` +
      `${NL}  以前 && 会在第一条红那里停住，后面十几套一次都跑不到，而人以为自己跑过了全量。` +
      `${NL}  往上翻找那几套自己的输出；`+
      `cancelled 不是 0 的那几套要一起看（fail 0 不等于全绿）。`
  )
  process.exit(1)
}
console.log(`${NL}✓ verify 全过 —— ${results.length} 套，一套都没跳过。`)
