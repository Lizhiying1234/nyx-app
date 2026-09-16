import type { Database } from 'better-sqlite3'
import {
  decodeProblems,
  encodeProblems,
  SYNC_PROBLEM_KEY,
  type SyncProblem,
  type SyncProblems
} from '@core/sync/problems.ts'

/**
 * 「上一次同步没有完全成功」· ★★ R-4-D —— **围绕 better-sqlite3 的薄读写**。
 *
 * ★★ 2026-08-29 · 阶段 3：键名 / 类型 / 去重 / 编解码搬去了
 * `core/sync/problems.ts`（引擎两端同一份要写，体检这边要读 ——
 * 格式只能有一份）。这里剩下的只有「怎么把那份字符串放进 settings」。
 */

export { SYNC_PROBLEM_KEY }
export type { SyncProblem, SyncProblems }

/**
 * 记下来（空清单 = 这一次全好了，把上一次的记录抹掉）。
 * 自己失败也不许抛 —— 记不上账是小事，把一次本来成功的同步带崩是大事。
 */
export function recordSyncProblems(db: Database, problems: SyncProblem[]): void {
  try {
    const t = Date.now()
    const value = encodeProblems(problems, t)
    if (value === null) {
      db.prepare(`delete from settings where key = ?`).run(SYNC_PROBLEM_KEY)
      return
    }
    db.prepare(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    ).run(SYNC_PROBLEM_KEY, value, t)
  } catch {
    /* 记不下来也不能因此让同步失败 */
  }
}

/** 上一次同步留下的问题。没有就是空的。 */
export function lastSyncProblems(db: Database): SyncProblems | null {
  try {
    const r = db.prepare(`select value from settings where key = ?`).get(SYNC_PROBLEM_KEY) as
      | { value: string }
      | undefined
    return decodeProblems(r?.value)
  } catch {
    return null
  }
}
