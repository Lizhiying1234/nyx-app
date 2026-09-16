import type { Database } from 'better-sqlite3'
import type { EngineDb, EngineRow } from '@core/sync/ports.ts'

/**
 * better-sqlite3 → 异步 `EngineDb` 包装 · 阶段 3（2026-08-29）
 *
 * core 里的共享判据（同步引擎 / 级联删除）按异步端口写（D-275 方向：
 * 判据只有一份，PC 迁就异步）。这里的 await 都落在**已经解决的 Promise**
 * 上 —— 一条 await 链在同一个宏任务里跑完，IPC 事件插不进事务中间，
 * 语义与原来的同步块一样原子。
 */
export function wrapDb(db: Database): EngineDb {
  return {
    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      db.prepare(sql).run(...(params as never[]))
    },
    async get(sql: string, params: readonly unknown[] = []): Promise<EngineRow | undefined> {
      return db.prepare(sql).get(...(params as never[])) as EngineRow | undefined
    },
    async all(sql: string, params: readonly unknown[] = []): Promise<EngineRow[]> {
      return db.prepare(sql).all(...(params as never[])) as EngineRow[]
    },
    async begin(): Promise<void> {
      db.prepare('begin').run()
    },
    async commit(): Promise<void> {
      db.prepare('commit').run()
    },
    async rollback(): Promise<void> {
      db.prepare('rollback').run()
    }
  }
}
