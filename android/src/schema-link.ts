/**
 * 目标结构的**唯一来源** —— submodule `nyx-core/` 里的 `schema/vNN.sql`（锁定 SHA，T-1.3）。
 *
 * ★ 和 `core-link.ts` 同一个道理：**不在这个仓库里放第二份 schema。**
 *   放了就会漂，而漂了之后没人说得清哪一份是对的。
 *   Vite 在构建时把它原文内联进产物，一个字不改。
 *
 * ★ 换版本时**只改这一处**（还要同步 `tools/db-probe/expected.json` 的基线）。
 */
import sql from '../nyx-core/schema/v36.sql?raw'

export const TARGET_VERSION = 36
export const SCHEMA_SQL: string = sql
