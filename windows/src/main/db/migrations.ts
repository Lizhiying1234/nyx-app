/**
 * 编号迁移脚本 · D-216 —— **入口**（T-4.6 拆分 · 2026-09-06）
 *
 * 铁律，四条缺一不可（另外三条在 open.ts）：
 *   1. 数据库内存版本号                    → PRAGMA user_version
 *   2. 每次结构变更写一个编号的迁移脚本      → 就是下面拼起来的这个数组
 *   3. 升级前自动备份                      → open.ts / backup.ts
 *   4. **只增不删** —— 加字段可以，删字段和改字段名一律不做
 *
 * 第 4 条的意思很具体：**已经写好的 up() 函数，从此一个字都不许改。**
 * 需要调整结构就在最后一段末尾追加一条新的。旧字段留着不用，代价只是几个空列，
 * 换来的是「任何一次升级都不可能丢数据」。
 *
 * 另：每张表**必须有 updated_at**（D-201）。增量行级同步的前提，后补需要全库迁移。
 *
 * ── 3,400 行拆成三段（T-4.6）─────────────────────────────
 * 正文一个字符没改，只是按版本号分成了三个文件；顺序仍由下面这个数组固定。
 * 加新迁移：写进 `migrations/v30-v38.ts` 末尾（或新开一段并接到下面），
 * 然后照 D-461 重生成 `schema/vNN.sql` 与同步基线。
 */
import type { Migration } from './migrations/types.ts'
import { SYNC_TABLES } from '@core/sync-tables.ts'
import { V01_V19 } from './migrations/v01-v19.ts'
import { V20_V29 } from './migrations/v20-v29.ts'
import { V30_V38 } from './migrations/v30-v38.ts'

export type { Migration } from './migrations/types.ts'
export { BUILTIN_IDENTITY_KEY } from './migrations/keys.ts'
export { SYNC_TABLES }

/** 按版本号从小到大 —— open.ts 就是照这个顺序一版一版往上跑的 */
export const MIGRATIONS: Migration[] = [...V01_V19, ...V20_V29, ...V30_V38]

export const TARGET_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)
