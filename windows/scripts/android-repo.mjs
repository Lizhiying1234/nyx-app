/**
 * 「Android 仓在哪」—— 一条约定，两处用（T-1.4 · 2026-09-04）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * `check-android-imports.mjs` 原来把位置写死成 `resolve(ROOT, '../../Nyx-Android')`。
 * 在主检出 `D:\claude_code_workspace\nyx_project` 上，`../..` 正好是 `D:\`，找得到。
 * 但从 2026-09-04 起活都在 **git worktree** 里干（`.claude/worktrees/xxx`），
 * 同一句 `../..` 落在 `nyx_project\.claude\` —— 找不到，于是它按约定**跳过并打印一行**。
 *
 * 结果是：那条跨仓护栏在 worktree 里一次都没生效过，而且它跳过时**是绿的**。
 * 这正是本仓最怕的那种「绿着却什么都没验到」。
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * 别再从「脚本自己在哪」往上数固定层数，改成**从本仓根一路往上找同名兄弟目录**：
 * worktree 里往上数到 `D:\` 照样撞见 `D:\Nyx-Android`，主检出里第二跳就撞见。
 * 不依赖 git、不依赖层数、不依赖盘符。
 *
 * ★ 找不到仍然是**跳过并打印一行**，不是报错：本仓的检查与合并门都不该要求
 *   另一台机器上必须也放着 Android 仓（T-1.6 上了 CI 之后尤其）。
 * ★ 环境变量 `NYX_ANDROID` **说了算**：设了就只认它，不再往上找。
 *   否则「设错了路径 → 悄悄回退到别处那一份」比找不到还难查。
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本仓根（scripts/ 的上一层） */
export const WIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一个目录像不像 Android 仓：有 package.json 就算（同名目录不会白白摆在那儿） */
const looksRight = (dir) => existsSync(resolve(dir, 'package.json'))

/** 从本仓根一路往上，每一层都试 `<层>/Nyx-Android`；近的优先。设了 NYX_ANDROID 就只认它 */
function candidates() {
  if (process.env.NYX_ANDROID) return [resolve(process.env.NYX_ANDROID)]
  const out = []
  let cur = WIN_ROOT
  for (;;) {
    out.push(resolve(cur, 'Nyx-Android'))
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return out
}

/**
 * @returns {{ dir: string | null, tried: string[] }}
 *   `dir` 为 null = 这台机器上没有 Android 仓，调用方按约定跳过。
 */
export function findAndroidRepo() {
  const tried = candidates()
  for (const c of tried) if (looksRight(c)) return { dir: c, tried }
  return { dir: null, tried }
}

/** 跳过时打的那一行（两处用同一句话，别各写各的） */
export function skipLine(what) {
  const where = process.env.NYX_ANDROID
    ? `NYX_ANDROID=${resolve(process.env.NYX_ANDROID)} 那里没有 package.json`
    : `本仓根往上 ${candidates().length} 层都没有 Nyx-Android/，也没有设 NYX_ANDROID`
  return (
    `跳过 · 找不到 Android 仓库（${where}）` +
    `\n  —— ${what} 不依赖 Android 存在。两个仓都在的机器上这一半才生效。`
  )
}
