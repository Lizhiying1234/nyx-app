import type { Database } from 'better-sqlite3'
import { occurrenceLectureUid, occurrenceMaterialUid } from '@core/identity.ts'

/**
 * 确定性身份在**写入路径**上的翻译层 · ★★ Step 2 / C-1
 *
 * ── 分工（和 `silence-sql.ts` 一个形状）──────────────────────
 *
 *   core/identity.ts   身份是什么       ← 判据，两端共用
 *   本文件              本地 id → uid    ← 查库，平台的事
 *
 * ── 为什么写入路径要自己算 uid，而不是全交给触发器 ★ ──────────
 *
 * 触发器是 `after insert`：它在行**已经插进去之后**才算 uid。
 * 对「同一份材料重新分析一次」那种情况，第二次插入会先落库、
 * 触发器再算出一个已经存在的 uid → 撞唯一索引 → **整条 INSERT 失败**，
 * 于是重新分析会直接抛错。
 *
 * 所以要在插入**之前**就把 uid 算出来，配上 `on conflict(uid) do nothing` ——
 * 「这条出处已经有了」变成一次安静的无操作，而不是一个异常。
 *
 * 触发器仍然留着兜底：它管的是所有**没有显式给 uid** 的插入路径，
 * 包括以后新写的代码。两条路算的是同一个表达式（都从 `core/identity.ts` 出），
 * `identity.test.ts` 里有一条 TS ↔ SQL 对拍守着它们真的一致。
 */

/** 某张表某一行的 uid。行不在、或者它还没有 uid，都返回 `null` */
export function uidOf(db: Database, table: string, id: number | null | undefined): string | null {
  if (id === null || id === undefined) return null
  const r = db.prepare(`select uid from "${table}" where id = ?`).get(id) as
    | { uid: string | null }
    | undefined
  return r?.uid ?? null
}

/**
 * 一条原文出处的跨设备身份。
 *
 * 业务身份（使用者 2026-08-18 裁决）：
 *   · `materialId` 非空 → `(item, material)`
 *   · `materialId` 为空 → `(item, lecture)`
 *
 * 算不出来（父行没有 uid）就返回 `null` —— 调用方据此**不传 uid**，
 * 让触发器那条路去兜；触发器同样算不出来时会留下空 uid，
 * 由数据体检的 `sync-uid-missing` 报出来。宁可留一个看得见的空，
 * 也不要编一个 uid 出来。
 */
export function occurrenceUid(
  db: Database,
  itemId: number,
  materialId: number | null | undefined,
  lectureId: number | null | undefined
): string | null {
  const item = uidOf(db, 'items', itemId)
  if (!item) return null
  if (materialId !== null && materialId !== undefined) {
    const material = uidOf(db, 'materials', materialId)
    return material ? occurrenceMaterialUid(item, material) : null
  }
  const lecture = uidOf(db, 'lectures', lectureId)
  return lecture ? occurrenceLectureUid(item, lecture) : null
}
