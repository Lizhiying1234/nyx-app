/**
 * 真机侧 Db adapter —— `@capacitor-community/sqlite`。**只给能力，不含判据。**
 *
 * ── 这一层的全部职责 ────────────────────────────────────────
 *
 * 把 `src/db/*` 那份升级逻辑要的六件事（exec / run / get / all /
 * begin / commit / rollback）接到插件上。**一行判据都不许在这里出现** ——
 * 真机测试验的是「这个 adapter 与平台行为对不对」，不是另一套 upgrade logic。
 *
 * ── 两条踩过的坑，写在这里免得下次重踩 ★★ ──────────────────
 *
 * ① **不许用 `execute()` 跑整份 schema**（A-1，2026-08-24 真机实测）。
 *    插件 7.0.3 的 `execute()` 会先用它自带的切分器按 `";\n"` 切，
 *    `begin…end` 里有两条语句的触发器拼不回来 → `incomplete input`。
 *    所以 `exec()` 这里走的是 **`run(sql, [], false)`** —— 那条路不经过
 *    它的切分器，语句逐字进 `compileStatement()`。
 *    切分交给上层的 `core/sql-split.ts`，两端同一份。
 *
 * ② **显式事务里每一次调用都要 `transaction = false`**。
 *    插件的 `run()` / `execute()` 默认会自己包一层事务，
 *    在 `beginTransaction()` 之内再包就会打架。
 */
import type { Db, Row } from '../db/types.ts'

/** 插件连接对象里我们用到的那几个方法（不 import 插件类型，免得这一层依赖它） */
export interface CapacitorConnection {
  execute(statements: string, transaction?: boolean): Promise<unknown>
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown>
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>
  beginTransaction(): Promise<unknown>
  commitTransaction(): Promise<unknown>
  rollbackTransaction(): Promise<unknown>
}

export class CapacitorDb implements Db {
  private readonly c: CapacitorConnection
  constructor(c: CapacitorConnection) {
    this.c = c
  }

  /** ★ 见文件头 ①：走 run 而不是 execute */
  async exec(sql: string): Promise<void> {
    await this.c.run(sql, [], false)
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.c.run(sql, params as unknown[], false)
  }

  async get(sql: string, params: readonly unknown[] = []): Promise<Row | undefined> {
    const r = await this.c.query(sql, params as unknown[])
    return (r.values ?? [])[0] as Row | undefined
  }

  async all(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const r = await this.c.query(sql, params as unknown[])
    return (r.values ?? []) as Row[]
  }

  async begin(): Promise<void> {
    await this.c.beginTransaction()
  }
  async commit(): Promise<void> {
    await this.c.commitTransaction()
  }
  async rollback(): Promise<void> {
    await this.c.rollbackTransaction()
  }
}
