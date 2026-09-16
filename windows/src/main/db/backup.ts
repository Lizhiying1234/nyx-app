import type { Database } from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 备份文件名：nyx-20260803-142530-startup.db */
function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/**
 * 备份一份数据库 · D-217 / D-216 第 3 条
 *
 * 用 SQLite 自己的 `VACUUM INTO` 而不是复制文件：它是同步的、原子的，
 * 而且**在 WAL 模式下也能拿到一致快照**（直接 copy .db 会漏掉 -wal 里还没合并的内容）。
 */
export function makeBackup(db: Database, dir: string, tag: string): string {
  mkdirSync(dir, { recursive: true })
  let dest = join(dir, `nyx-${stamp()}-${tag}.db`)
  let n = 1
  while (existsSync(dest)) dest = join(dir, `nyx-${stamp()}-${tag}-${n++}.db`)
  db.prepare('vacuum into ?').run(dest)
  return dest
}

/**
 * 滚动保留最近 N 份 · D-217（磁盘几乎不花钱，SQLite 断电损坏是真实风险）。
 *
 * ★ 只清**自己生成的**那些（`nyx-20260805-061512-tag.db` 这种带时间戳的）。
 * 原来的判据是「`nyx-` 开头、`.db` 结尾」—— 于是使用者（或我）**手动放进来的
 * 一份备份也会被轮转掉**。备份目录是人会主动往里放东西的地方，
 * 在这里做模糊匹配等于给自己留一个删别人文件的口子。
 *
 * ★★ H-2 · 再收窄一层：只轮转**可再生**的那几种。
 *
 * 备份按「丢了还能不能再有」分成两类：
 *
 * | 可再生（参与轮转） | 什么时候做 |
 * |---|---|
 * | `startup`     | 每次启动。丢了下次启动就有 |
 * | `manual`      | 他点「立即备份」。想要随时能再点 |
 * | `before-sync` | 同步有落行时。下次同步就会再有 |
 *
 * | 不可再生（**永不轮转**） | 什么时候做 |
 * |---|---|
 * | `before-restore` | 从备份导回**之前**那一刻的样子 |
 * | `before-wipe`    | 清空学习数据之前 |
 * | `before-reset`   | 恢复出厂之前 |
 * | `pre-vNN`        | 数据库升级结构之前 |
 *
 * 后一类记录的是**一个再也回不去的时间点**。而每次启动都会产生一份 `startup`，
 * 于是十来次启动之后它们就被挤出去了 ——
 * 而界面上写着「后悔了从『从备份导回…』找回来」「动手前会先做一份完整备份」。
 * **承诺兑现不了比没有承诺更糟。**
 *
 * 不给这一类设上限：它们只在他主动做危险操作、或结构升级时产生，
 * 频率以「几个月一次」计，一份两三 MB。让它们无限留着，是这里最便宜的安全。
 */
const ROTATABLE = /^nyx-\d{8}-\d{6}-(startup|manual|before-sync)(-\d+)?\.db$/

export function pruneBackups(dir: string, keep = 10): void {
  if (!existsSync(dir)) return
  const files = readdirSync(dir)
    .filter((f) => ROTATABLE.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const { f } of files.slice(keep)) {
    try {
      rmSync(join(dir, f))
    } catch {
      /* 删不掉就算了，下次再说 —— 清不掉备份不该挡住启动 */
    }
  }
}
