/**
 * PC 侧 Db adapter —— `node:sqlite`。**只给能力，不含判据。**
 *
 * 它存在的唯一理由：让 U-1…U-12 / N-1…N-9 那一整套矩阵能在 PC 上跑完，
 * 而**跑的是与真机逐字相同的那一份升级逻辑**（`src/db/*`）。
 * 真机那一侧只验 adapter 与平台行为，不另写一套 upgrade logic。
 *
 * ★ D-265 记过这条退路：`node:sqlite` 是 better-sqlite3 的替代，
 *   Android 准入探针用的也是它。
 */
import { DatabaseSync } from 'node:sqlite'
import type { Db, Row } from '../db/types.ts'

export class NodeSqliteDb implements Db {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]))
  }

  async get(sql: string, params: readonly unknown[] = []): Promise<Row | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined
  }

  async all(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.db.prepare(sql).all(...(params as never[])) as Row[]
  }

  /**
   * ★ 用 `IMMEDIATE`：写事务一开始就拿锁。
   *   `DEFERRED` 要等第一次写才升级锁，中途可能被别人插进来。
   */
  async begin(): Promise<void> {
    this.db.exec('begin immediate')
  }
  async commit(): Promise<void> {
    this.db.exec('commit')
  }
  async rollback(): Promise<void> {
    this.db.exec('rollback')
  }
}
