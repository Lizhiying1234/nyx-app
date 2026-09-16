/**
 * 「源码没变就别再编译一遍」· 2026-09-04
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * `verify` 串了 21 条命令，其中 15 条各自以 `npm run build &&` 开头，
 * 加上 `check:schema` 那次 —— **一次 verify 把同一份代码编译 16 遍**。
 * 实测单次 4.1 秒，合计约 66 秒；`verify` 中途任何一条红了就停，
 * 重跑又是 16 遍。使用者的原话：「修一个小功能而已，为什么要这么多测试」。
 *
 * ── 药，以及为什么不是「verify 开头 build 一次，后面都不 build」★★ ──
 *
 * 那样改，`npm run smoke:study` 单独跑时就**不再构建**了 ——
 * 于是他改完代码直接跑那一条，跑的是**上一次的产物**：
 * 测试全绿，而验的是旧代码。这个项目最怕的正是这种「绿着却什么都没验到」。
 *
 * 所以判据不放在调用方，放在这里：**按源码指纹决定要不要编译**。
 * 每条 smoke 照旧写 `npm run build:if-stale &&`，单独跑照样保证是新的；
 * verify 里第一条编译，后面 15 条各花几十毫秒算个指纹就过去了。
 *
 * ── 指纹算什么 ────────────────────────────────────────────
 *
 *   `src/` 下全部文件 · **`tests/` 下全部文件** · 构建配置 · package.json ·
 *   tsconfig · 当前 commit
 *
 * ★★ T-9.6（2026-09-05）· **`tests/` 也要进指纹。**
 *   `tests/db-safety.ts` · `tests/seed-demo.ts` · `tests/dict-behavior.ts` 三个
 *   **是被编译进 `out/main/` 的**（见 `electron.vite.config.ts` 的 `input`）——
 *   `npm run test:db` 跑的正是 `out/main/db-safety.js`。
 *   指纹不含 `tests/` 时，改完用例直接 `npm run test:db`，跑的是**上一次的产物**：
 *   新写的用例根本不存在，而屏幕上是一片绿。T-9.5 里 A 的第一次诊断就是这么被吃掉的。
 *   ★ 那些不进构建的 smoke（`tests/*.test.ts` 由 node 直接跑）算进指纹只是多编译一次，
 *     代价是几秒；**反过来那一侧的代价是「绿着却什么都没验到」**，不对称。
 *   ★ `tests/sync-baseline` 那两个目录只由 `npm run sync:baseline` 手工重录，跑测试不会写它们，
 *     所以不会出现「跑一次测试指纹就变一次」的自我否定（那是 `build-info.json` 的病）。
 *
 * ★ `src/main/build-info.json` **必须排除** —— 它是构建自己写出来的
 *   （commit / 时间戳 / dirty），算进去的话每编译一次指纹就变一次，
 *   于是永远判「变了」，这个脚本等于没有。
 * ★ commit 算进去：build-info 里嵌着它，换了 commit 那份产物就该重出。
 * ★ 只在**构建成功之后**才写指纹。半路炸了不留痕，下次照常重来。
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const STAMP = join(ROOT, 'out', '.build-stamp')
/** 构建自己写出来的，算进指纹就成了自我否定 —— 见文件头 */
const SKIP = new Set([join('src', 'main', 'build-info.json')])

/** `src/` 下所有文件，路径相对、排好序 —— 换台机器算出来也一样 */
function filesUnder(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

function fingerprint() {
  const h = createHash('sha256')
  const list = [
    ...filesUnder(join(ROOT, 'src')),
    // ★ T-9.6 —— 见文件头：tests/ 里有三个文件是被编译进 out/main/ 的
    ...filesUnder(join(ROOT, 'tests')),
    join(ROOT, 'electron.vite.config.ts'),
    join(ROOT, 'package.json'),
    join(ROOT, 'tsconfig.json'),
    join(ROOT, 'scripts', 'build-info.mjs')
  ]
  for (const p of list) {
    const rel = relative(ROOT, p)
    if (SKIP.has(rel)) continue
    if (!existsSync(p)) continue
    // 路径也进指纹：只按内容算的话，改名 / 挪目录看不出来
    h.update(rel.split(sep).join('/')).update('\u0000')
    h.update(readFileSync(p))
    h.update('\u0000')
  }
  try {
    h.update(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  } catch {
    /* 不在 git 里也能用 —— 少一味料而已，不影响「变没变」这个判断 */
  }
  return h.digest('hex')
}

const now = fingerprint()
const built = existsSync(join(ROOT, 'out', 'main', 'index.js'))
const same = built && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === now

if (same) {
  console.log('build:if-stale　源码没变，跳过构建（指纹 ' + now.slice(0, 12) + '）')
  process.exit(0)
}

/**
 * ★ 写成**一条命令字符串** + `shell: true`，不是 `(cmd, args[])`。
 *   两个坑各踩过一次：
 *     · `spawnSync('npm', ['run','build'], {shell:true})` → Node 打 DEP0190，
 *       每次构建都刷一屏警告；
 *     · 于是改成 `spawnSync('npm.cmd', [...])` 不带 shell → **Windows 上直接失败**
 *       （Node 18.20+ 起禁掉了不经 shell 执行 .cmd，CVE-2024-27980），
 *       而且 `stdio:'inherit'` 下它一个字都不打印，只留一个 exit 1 ——
 *       表现就是「构建没跑，也没人说为什么」。
 *   单条字符串两样都躲开了。
 * ★ 失败要**说出来**：这个脚本站在所有 smoke 前面，它闷声退出＝后面全线崩。
 */
const r = spawnSync('npm run build', { stdio: 'inherit', shell: true })
if (r.status !== 0) {
  console.error('build:if-stale　构建失败（退出码 ' + String(r.status) + '）—— 指纹不落盘，下次照常重来')
  process.exit(r.status ?? 1)
}
// ★ 编译成功之后才留指纹，而且**重算一次** —— build 会重写 build-info.json，
//   虽然它不进指纹，但重算一次最省心：以后往 SKIP 里加漏了也不会静默失效
writeFileSync(STAMP, fingerprint() + '\n')
