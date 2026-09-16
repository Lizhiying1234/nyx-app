/**
 * repro:testdb · 把 `test:db` 的偶发 `fetch failed` 逼成必现（T-9.5 · issues I-133）
 *
 * ── 它复现的是什么 ────────────────────────────────────────
 *
 * 假云服务器和它的客户端（`core/sync/store.ts` 的 `fetch`）在**同一个进程**里，
 * 几十条 `checkAsync` 并发打它，undici 的连接池里同时躺着一把空闲 keep-alive 连接。
 * Node 服务端默认空闲 5 秒就把连接关掉，undici 靠 `Keep-Alive: timeout=5` 把自己的
 * 上限定在 4 秒、抢在前面撤出池子 —— 安全边际只有那一秒。
 * 机器被榨干时两边的定时器排在同一个被堵死的事件循环上，那一秒不够用：
 * 服务端先关，池子里还留着，下一个请求写上去收到 RST → `fetch failed` / `ECONNRESET`。
 *
 * 所以复现的办法不是「重试到中奖」，是**把事件循环真的堵住**：
 * 同时跑 K 份 `test:db`，外加 L 个把 CPU 榨干的进程。
 *
 * ── 用法 ──────────────────────────────────────────────────
 *
 *     npm run repro:testdb              K=4 份 · L=核数 个榨干进程 · 1 轮
 *     npm run repro:testdb -- 4 32 3    自己指定
 *
 * 退出码：**见红 = 1，没见红 = 0**。所以「修好了」的说法是
 * 「这条命令连跑三次都退出 0」，而不是「重跑一次就绿了」。
 *
 * ★ 一定要**强制**编译：`build:if-stale` 的指纹只算 `src/` 与构建配置，**不算 `tests/`** ——
 *   改完 `tests/db-safety.ts` 直接跑，跑的是上一次的产物。这一条骗过我一次。
 * ★ 日志写进系统临时目录，仓库里不落一个文件。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = mkdtempSync(join(tmpdir(), 'nyx-repro-testdb-'))
const ELECTRON = createRequire(join(ROOT, 'package.json'))('electron')

const K = Number(process.argv[2] ?? 4)
const L = Number(process.argv[3] ?? cpus().length)
const ROUNDS = Number(process.argv[4] ?? 1)

/** 榨干进程：一个死循环，跑满一核；每轮结束杀掉 */
const BURNER = 'const e=Date.now()+1000*900;while(Date.now()<e){Math.sqrt(Math.random())}'

console.log(`repro:testdb　${K} 份 test:db 并行 · ${L} 个榨干进程 · ${ROUNDS} 轮 · 日志 ${OUT}`)

if (spawnSync('npm run build', { cwd: ROOT, stdio: 'ignore', shell: true }).status !== 0) {
  console.error('✗ 构建失败 —— 复现不做了（产物不是这一份，跑了也不算数）')
  process.exit(2)
}

/** 一份 test:db，收全部输出，把 ✖ 那几行连同紧随其后的说明一起摘出来 */
function runOne(logPath) {
  return new Promise((done) => {
    const chunks = []
    const p = spawn(ELECTRON, ['out/main/db-safety.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (c) => chunks.push(c))
    p.stderr.on('data', (c) => chunks.push(c))
    p.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8')
      writeFileSync(logPath, text)
      const lines = text.split('\n')
      const bad = []
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('✖')) continue
        bad.push(lines[i].trim())
        for (let k = 1; k <= 3 && i + k < lines.length; k++) {
          if (lines[i + k].includes('✖') || lines[i + k].includes('✔')) break
          if (lines[i + k].trim()) bad.push('    ' + lines[i + k].trim())
        }
      }
      const total = lines.filter((l) => l.startsWith('通过 '))[0] ?? '(没有汇总行)'
      done({ code, bad, total: total.trim(), logPath })
    })
  })
}

let redRounds = 0
for (let round = 1; round <= ROUNDS; round++) {
  const burners = []
  for (let i = 0; i < L; i++) burners.push(spawn(process.execPath, ['-e', BURNER], { stdio: 'ignore' }))

  const t0 = Date.now()
  const res = await Promise.all(
    Array.from({ length: K }, (_, i) => runOne(join(OUT, `r${round}-copy${i}.log`)))
  )
  for (const b of burners) b.kill()

  console.log(`\n== 第 ${round} 轮 · ${Math.round((Date.now() - t0) / 1000)} s ==`)
  let red = false
  for (let i = 0; i < res.length; i++) {
    console.log(`  copy${i} exit=${res[i].code} · ${res[i].total}`)
    if (res[i].bad.length > 0) {
      red = true
      for (const b of res[i].bad) console.log(`      ${b}`)
      console.log(`      —— 完整输出：${res[i].logPath}`)
    }
  }
  if (red) redRounds++
}

console.log(`\n${ROUNDS} 轮里有 ${redRounds} 轮见红`)
if (redRounds > 0) {
  console.log('★ 复现到了。这就是 I-133 —— 看上面 ✖ 那几条的原因，应当是 fetch failed / ECONNRESET。')
  process.exit(1)
}
console.log('✓ 一轮都没红。')
