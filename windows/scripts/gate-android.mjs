/**
 * 合并门的 Android 半场（T-1.4 · 2026-09-04 · R-018）
 *
 * ── 为什么门里要有另一个仓 ────────────────────────────────
 *
 * core 只有一份，两端共用（D-238 / D-365）。T-1.3 之后 Android 经 submodule
 * 锁着一个 SHA 消费它 —— 好处是改 core 不会静默改掉手机，代价是**本仓全绿并不代表手机还编译得过**。
 * 本仓那侧的 `check:android-imports` 只看「符号还在不在」（编译期），
 * 看不见「行为变没变」；后者要真的去 Android 仓跑一遍它自己的 ② 档：
 *
 *     npm run check   svelte-check · check:plan · check:css · check:tokens
 *     npm test        含 core-parity（行为一致）与 core-lock（指针 = 工作树 = 锁定 commit）
 *
 * 这两条几十秒就跑完，放进门里不会把门撑过 5 分钟；真机与 Electron smoke 一律留在 `verify`。
 *
 * ── 两条踩过的坑 ──────────────────────────────────────────
 *
 * ★ 找不到 Android 仓就**跳过并打印一行**（和 `check-android-imports.mjs` 同一条约定，
 *   位置由 `android-repo.mjs` 统一判断）：门不该要求另一台机器上也放着 Android 仓。
 * ★ 命令写成**一条字符串** + `shell: true`，不写成 `('npm', [...])`：
 *   Node 18.20+ 起不经 shell 执行 `.cmd` 直接失败，而且 `stdio:'inherit'` 下**一个字都不打印**
 *   （`build-if-stale.mjs` 头上记着这一笔）。
 *
 * 用法：node scripts/gate-android.mjs
 */
import { spawnSync } from 'node:child_process'
import { findAndroidRepo, skipLine } from './android-repo.mjs'

const { dir: ANDROID } = findAndroidRepo()

if (!ANDROID) {
  console.log(skipLine('合并门的 Android 半场'))
  process.exit(0)
}

console.log(`gate · Android ② 档 · ${ANDROID}`)

const t0 = Date.now()
for (const step of ['npm run check', 'npm test']) {
  const t = Date.now()
  console.log(`\n▶ gate · Android · ${step}`)
  const r = spawnSync(step, { cwd: ANDROID, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(
      `\n✗ gate · Android「${step}」失败（退出码 ${String(r.status)}）—— 门到此为止。` +
        `\n  手机那边红了：要么本仓的 core 改动破了行为（改回去，或两端一起改），` +
        `\n  要么 Android 仓自己有活没干完。去 ${ANDROID} 单独跑一遍看详情。`
    )
    process.exit(r.status ?? 1)
  }
  console.log(`  ✓ ${step}（${Math.round((Date.now() - t) / 1000)} s）`)
}
console.log(`\n✓ gate · Android ② 档全过（${Math.round((Date.now() - t0) / 1000)} s）`)
