/**
 * 迁移的形状 · T-4.6 拆分（2026-09-06）
 *
 * 从 migrations.ts 原样搬来，一个字没改。单独一个文件是为了不让
 * migrations.ts 与 migrations/vNN.ts 互相 import（循环依赖）。
 */
import type { Database } from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  /**
   * ★★ 这条迁移**有意**让这几张表少行（搬走 / 合并）。
   *
   * 不声明的一律按「掉行 = 出事」处理并回滚（D-236）。声明了也不等于放行：
   * 迁移自己必须验过「新的写进去了，才删旧的」—— V29 是逐键 select 回来确认的。
   */
  allowShrink?: readonly string[]
  up: (db: Database) => void
}
