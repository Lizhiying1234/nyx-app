import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
  FINGERPRINT_ALGO,
  normalizeSchema,
  readSyncSurface,
  type ReadableDb
} from '@core/schema-fingerprint.ts'

/**
 * 把本机的同步表结构量出来 · ★★ Step 1A（2026-08-17）
 *
 * ── 分工 ────────────────────────────────────────────────────
 *
 *   core/schema-fingerprint.ts   **规范化**（判据，两端必须一份）
 *   本文件                        读 pragma + 哈希（平台的事）
 *
 * 规范化没有现成的，哈希两端都有现成的（Node 的 `node:crypto`、
 * Android 的 `MessageDigest`）。所以只把规范化搬进 core ——
 * 同一段文本、同一个 sha256，两端必然得到同一个值。
 *
 * ★ 只量 `SYNC_TABLES`。全库不行：Android 本来就没有 `dictionaries` /
 *   `analysis_jobs`，把它们算进去会把「平台本来就不同」误判成结构不兼容
 *   （架构报告 §3 实测 ③）。
 *
 * ── 为什么只用 `prepare(...).all()`，不用 `db.pragma()` ★ ────
 *
 * `pragma()` 是 better-sqlite3 特有的糖。只用最小的那套接口，
 * 这段代码就能跑在任何「能 prepare、能 all」的驱动上 ——
 * 测试里的 `node:sqlite`、将来 Android 那一侧的驱动都算。
 * 指纹这种**两端必须算出同一个值**的东西，尤其不该绑死在某个驱动上。
 */

export type { ReadableDb }

/** 本机的三样身份，包头里带的就是它 */
export interface SchemaIdentity {
  schemaVersion: number
  schemaFingerprint: string
  /** 规范化之后的原文 —— 出问题时要能贴出来对，不然只有一个 hash 谁也查不了 */
  normalized: string
  algo: string
}

/**
 * 本机同步表面的身份。
 *
 * 一次同步里问一遍就够（`pragma` 不便宜），调用方自己缓存 ——
 * 但**不要跨同步缓存**：迁移可能在两次同步之间发生。
 */
export async function schemaIdentity(db: Database): Promise<SchemaIdentity> {
  /**
   * ★★ 2026-08-23：读表结构那一段**搬去了 `core/schema-fingerprint.ts`**。
   *   它只需要「能 prepare、能 all」，本来就没有平台味道，而留在这里会让
   *   非 Electron 的运行时算不出指纹（这个模块 import 了 `migrations.ts`）。
   *   这里只剩真正属于平台的两样：**哈希** 和 `user_version`。
   */
  const normalized = normalizeSchema(
    await readSyncSurface({ all: (sql, p = []) => db.prepare(sql).all(...(p as never[])) })
  )
  return {
    schemaVersion: Number(
      (db.prepare(`pragma user_version`).all()[0] as { user_version?: number } | undefined)?.user_version ?? 0
    ),
    schemaFingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 16),
    normalized,
    algo: FINGERPRINT_ALGO
  }
}
