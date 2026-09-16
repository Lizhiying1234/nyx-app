/**
 * 题型管理（Android 面）—— ⑤（2026-09-01）
 *
 * ★★ 规则在 `core/qtypes-store.ts`，这里只做平台的两件事：**事务 + 留痕**。
 *
 * ── 为什么规则那边是两份实现 ────────────────────────────────
 *
 * 试过把 Windows 也接到 core，**没成**：core 的库面是 async（这一端的
 * SQLite 走 Capacitor 桥，天生异步），而 Windows 的 `study.ts` 在
 * **同步的出题路径里有 7 处** `this.qt.active()`。改成 async 会波及整个
 * study 模块 —— 那是产品的心脏，代价远大于收益。
 * 所以两端两份实现、**一套规则**，靠 `core/qtypes-parity.test.ts` 钉住：
 * 改了一边不同步改另一边，当场红。
 *
 * ── 有一条不是口味问题 ★★★ ────────────────────────────────
 *
 * **五个难度档（tier 1–5）是机制。** 删空一档 / 把一档全停用，
 * 练到那一档就出不了题；更坏的是「3 连正确」会全落在同一个难度上，
 * **静默判定当场失效，而分数还很好看**。core 里那两条护栏会抛错，
 * 这一层原样把话传上去 —— 不许吞。
 */
import {
  allQTypes,
  removeQType,
  reorderQTypes,
  restoreBuiltinQTypes,
  saveQType,
  setQTypeEnabled,
  type QTypeRow
} from '../core-link.ts'
import * as ledger from './ledger.ts'
import type { Db } from './types.ts'

export type { QTypeRow }

export const listQTypes = (db: Db): Promise<QTypeRow[]> => allQTypes(db)

async function inTx<T>(db: Db, body: () => Promise<T>): Promise<T> {
  await db.begin()
  try {
    const out = await body()
    await db.commit()
    return out
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
}

export async function saveQTypeRow(
  db: Db,
  q: Partial<QTypeRow> & { name: string }
): Promise<string> {
  const t = Date.now()
  return inTx(db, async () => {
    const uid = await saveQType(db, q, t)
    await ledger.op(db, 'qtype', 'qtype', null, `${q.uid ? '改' : '新建'}「${q.name}」`)
    return uid
  })
}

export async function deleteQType(db: Db, uid: string, name: string): Promise<void> {
  const t = Date.now()
  await inTx(db, async () => {
    await removeQType(db, uid, t)
    await ledger.op(db, 'qtype', 'qtype', null, `删「${name}」`)
  })
}

export async function toggleQType(db: Db, uid: string, on: boolean): Promise<void> {
  const t = Date.now()
  await inTx(db, () => setQTypeEnabled(db, uid, on, t))
}

/**
 * ══ 题型排序 · **FROZEN**（使用者 2026-09-14 裁）★ ═══════════
 *
 * 后端写好了，**界面上没有入口** —— 屏上排不了序。
 * 2026-09-14 双端对账把它当「零引用」报上去，使用者原话：
 * **「题型排序，不需要整个删除」** = 「暂时没做」，不是「不做了」。
 * ☞ 出处：`NYX_MASTER_PLAN.md` 的 NEXT ACTION（2026-09-14 那段，主控记的三件裁决之一）。
 *   解冻条件 = 他要一个排序入口。
 *
 * ★ 所以它是**半个功能**，不是死代码。扫零引用的人看到这段就别删了。
 * ★ 排序判据本身在 core（`reorderQTypes`），这里只负责事务那一层 ——
 *   解冻那天界面接上就行，不用重写。
 * ☞ 闸：`tests/qtypes-frozen.test.ts`（它还在 · 真的会改顺序 · 不留半截事务）。
 */
export async function reorderQTypeList(db: Db, uids: string[]): Promise<void> {
  const t = Date.now()
  await inTx(db, () => reorderQTypes(db, uids, t))
}

export async function restoreQTypes(db: Db): Promise<number> {
  const t = Date.now()
  return inTx(db, async () => {
    const n = await restoreBuiltinQTypes(db, t)
    await ledger.op(db, 'qtype', 'qtype', null, `恢复出厂题型 ${n} 种`)
    return n
  })
}
