import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** 构建指纹（Settings › About）：我改的那份 = 你跑的那份 */
function buildStamp(): string {
  let hash = ''
  try {
    hash = execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    hash = 'dev'
  }
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${hash} · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * ★★ 这份 build 用的是哪一个 core（T-1.3 · 2026-09-04）
 *
 * core 与 schema 来自 git submodule `nyx-core/`（指向 nyx_project 仓库，**锁定 commit SHA**），
 * 不再是 Windows 工作树。改了 Windows 的 core 而没有更新指针，手机用的仍是锁定那一版 ——
 * 这一行让任何人一眼看出「手机跑的判据是哪一版」。算法在 `tools/build-info.mjs`
 * （指纹和 `tools/db-probe` 用同一把尺，和 Windows `check:schema` 打出来的是同一个值）。
 */
function coreStamp(): string {
  try {
    const j = JSON.parse(
      execFileSync('node', ['tools/build-info.mjs', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    ) as { pinned: string; checkedOut: string; dirty: boolean; schemaVersion: number; fingerprint: string }
    return `core ${j.pinned}${j.dirty ? `（工作树 ${j.checkedOut}，未提交）` : ''} · schema v${j.schemaVersion} · 指纹 ${j.fingerprint}`
  } catch (e) {
    return `core ?（build-info 没跑起来：${(e as Error).message.split('\n')[0]}）`
  }
}

/**
 * ★★ submodule 在不在 —— **构建前先说人话**（F-008 · 2026-09-01 → T-1.3 · 2026-09-04）
 *
 * core 与 schema 是 submodule `nyx-core/` 里锁定 SHA 的那一份（D-238/D-365：只有一份，
 * 不复制不包装）。它没初始化的时候，Vite 会吐几十行 `Cannot find module '../nyx-core/…'`，
 * 而真正的原因是「submodule 没拉下来」。这一条只把那几十行换成一句话。
 */
function assertCoreReachable(): void {
  const core = resolve(__dirname, 'nyx-core/src/core/types.ts')
  if (existsSync(core)) return
  throw new Error(
    '\n找不到 core：submodule nyx-core/ 还没初始化。\n' +
      `  期望在：${core}\n` +
      '  跑一次：git submodule update --init nyx-core\n' +
      '  （本机的 submodule URL 是文件路径，先 git config protocol.file.allow always —— 见 CLAUDE.md §七）\n'
  )
}

assertCoreReachable()
const BUILD = buildStamp()
const CORE = coreStamp()
// ★ 构建日志里也打一行：看 BUILD 就知道这份 Android 用的是哪个 core、哪版 schema
console.log(`BUILD · ${BUILD} · ${CORE}`)

export default defineConfig({
  plugins: [svelte()],
  define: { __NYX_BUILD__: JSON.stringify(BUILD), __NYX_CORE__: JSON.stringify(CORE) },
  // Capacitor 要的是一份可以直接塞进 WebView 的静态产物
  // ★ assetsInlineLimit: 0 —— Noto Sans SC 是几百个 unicode-range 小块，
  //   默认 <4KB 会被内联进 CSS，把「按需取块」变成启动全量解析。全部落文件。
  //   ★ 2026-08-31：中文换成 Noto Serif SC（DS v5 §2.2），同理仍然全部落文件。
  build: { outDir: 'www', emptyOutDir: true, assetsInlineLimit: 0 },
  // ★ core 与 schema 现在住在仓库自己的 nyx-core/ 里，不再需要放行 root 之外的目录
  server: { host: true }
})
