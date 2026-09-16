/**
 * 轻量管理 · 写入面（阶段 2 扩到四件：改名 + 软删 + 静默 + 恢复轮转）。
 *
 * ══ 语义全部逐字对照 Windows ═══════════════════════════════
 *   rename          ← `repo.ts`（只改 name/updated_at，uid 是身份不碰）
 *   softDeleteItems ← `study.ts::deleteItems`（334-353）：软删 + 账本
 *                     noteMany('deleted') —— 账记在**字面**上（4.1：
 *                     item 会被彻底清掉，判断不能跟着没）+ ops_log
 *   undoDeleteItems   Windows 没有这个方法 —— 它是 D-379 P1（零确认+
 *                     Snackbar 撤销）要求的逆动作，用 Windows 原语组合：
 *                     清 deleted_at + `ledger.forget('deleted')`（R-3-e
 *                     的设计用途就是「他又把它收回来了」）+ op('restore')
 *   bulkSilence     ← `study.ts::bulkSilence`（1685-1730）：D-296 两张表
 *                     两条语句同一事务；state_events（D-043）；silenced_by
 *                     'self'/null（4.2）；账 noteMany/forgetMany('silenced')
 *   restoreItem     ← `study.ts::restoreItem`（2397-2423）：静默库「恢复
 *                     轮转」—— 清零 streak/attempts_in_stage，认读卡
 *                     due_at=现在（立刻回轮转），账 forget('silenced')
 *
 * ★ D-359：手机只有可撤销的那一半 —— 硬删（purge）不港。
 * ★ 回收站「打开即清」是写动作，随阶段 5 的连带恢复一起接（天数看 `TRASH_DAYS`）。
 * ★ P1-4 同类「第二份」，待上提 core。
 */
import { SILENCE_ACTIONS, moveItems as coreMoveItems, type MoveResult } from '../core-link.ts'
import type { Db } from './types.ts'
import * as ledger from './ledger.ts'

export type RenameKind = 'project' | 'unit' | 'lecture'

const TABLE: Record<RenameKind, string> = {
  project: 'projects',
  unit: 'units',
  lecture: 'lectures'
}

export async function rename(db: Db, kind: RenameKind, id: number, name: string): Promise<void> {
  const n = name.trim()
  if (!n) throw new Error('名字不能是空的')
  await db.run(`update "${TABLE[kind]}" set name = ?, updated_at = ? where id = ?`, [
    n,
    Date.now(),
    id
  ])
}

/** 事务包裹 —— 出任何事回滚再抛，绝不留中间态（Windows db.transaction 的对应物） */
async function tx(db: Db, body: () => Promise<void>): Promise<void> {
  await db.begin()
  try {
    await body()
    await db.commit()
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
}

/** ids → 字面（termsOf 的最小面 —— 「我勾了什么就动什么」从库里取，不从界面凑） */
async function termsOf(db: Db, ids: number[]): Promise<string[]> {
  if (ids.length === 0) return []
  const q = ids.map(() => '?').join(',')
  return (await db.all(`select term from items where id in (${q})`, ids)).map((r) =>
    String(r['term'])
  )
}

export async function softDeleteItems(db: Db, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const t = Date.now()
  await tx(db, async () => {
    // 先取字面 —— 软删之后再取也取得到，但顺序写清楚更不容易被将来改坏（Windows 同注）
    const terms = await termsOf(db, ids)
    for (const id of ids) {
      await db.run(`update items set deleted_at = ?, updated_at = ? where id = ?`, [t, t, id])
    }
    await ledger.noteMany(db, terms, 'deleted', { note: '在知识点列表里删除' })
    await ledger.op(db, 'delete', 'item', null, terms.slice(0, 3).join('、'), { n: ids.length })
  })
  return ids.length
}

/** Snackbar 撤销（D-379 P1）：软删的逆 —— 账用 forget 撤，不是删账 */
export async function undoDeleteItems(db: Db, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const t = Date.now()
  await tx(db, async () => {
    const terms = await termsOf(db, ids)
    for (const id of ids) {
      await db.run(`update items set deleted_at = null, updated_at = ? where id = ?`, [t, id])
    }
    await ledger.forgetMany(db, terms, 'deleted')
    await ledger.op(db, 'restore', 'item', null, terms.slice(0, 3).join('、'), { n: ids.length })
  })
  return ids.length
}

export async function bulkSilence(db: Db, ids: number[], on: boolean): Promise<number> {
  const t = Date.now()
  await tx(db, async () => {
    for (const id of ids) {
      const prev = (await db.get(`select production_state as s from items where id = ?`, [id])) as
        | { s: string }
        | undefined
      await db.run(
        `update items
            set production_state = ?, updated_at = ?
          where id = ? and deleted_at is null`,
        [on ? 'silent' : 'training', t, id]
      )
      await db.run(
        `update reading_cards set silent = ?, updated_at = ?
          where item_id = ? and item_id in (select id from items where deleted_at is null)`,
        [on ? 1 : 0, t, id]
      )
      // 'self' = 他一条一条点过的。取消上级静默时不该把这些一起放出来（4.2）
      //
      // ★★ 2026-09-01 · X-Ray 审计 F-016：这一句原来既没有 `deleted_at` 护栏，
      //    也不顶 `updated_at`。上面那句 UPDATE 有护栏 —— 于是对一条**已软删**的
      //    知识点调 bulkSilence 时，前两句是 no-op（updated_at 不动），
      //    这一句照写 silenced_by → **那次改动永远同步不出去，而且不报错**
      //    （差分判据是 `pushed_updated_at <> updated_at`，见 collectSince）。
      //    补上护栏 + 自己顶时间戳：两条路都堵死，不依赖「上面那句一定跑过」。
      await db.run(
        `update items set silenced_by = ?, updated_at = ? where id = ? and deleted_at is null`,
        [on ? 'self' : null, t, id]
      )
      // D-043 · 状态一变就记一笔
      if (prev && prev.s !== (on ? 'silent' : 'training')) {
        await db.run(
          `insert into state_events (item_id, line, from_state, to_state, created_at, updated_at)
           values (?, 'production', ?, ?, ?, ?)`,
          [id, prev.s, on ? 'silent' : 'training', t, t]
        )
      }
    }
    const terms = await termsOf(db, ids)
    // ★ 这条备注只写进 `term_ledger.note`，**没有任何地方读它**（查过）——
    //   不是屏上的字。改走常量是为了将来的行读起来和屏上一致；
    //   **老行一个字不动**（不是覆盖，是新行才用新词）。
    if (on) await ledger.noteMany(db, terms, 'silenced', { note: `手动${SILENCE_ACTIONS.shelve}` })
    else await ledger.forgetMany(db, terms, 'silenced')
    await ledger.op(db, on ? 'silence' : 'unsilence', 'item', null, terms.slice(0, 3).join('、'), {
      n: ids.length
    })
  })
  return ids.length
}

/** 静默库「恢复轮转」—— 与 bulkSilence(false) 不同：清零建立期、认读卡立刻到期 */
export async function restoreItem(db: Db, itemId: number): Promise<void> {
  const t = Date.now()
  await tx(db, async () => {
    await db.run(
      `update items set production_state = 'training', streak = 0,
                        attempts_in_stage = 0, silenced_by = null, updated_at = ?
        where id = ?`,
      [t, itemId]
    )
    await db.run(
      `update reading_cards set silent = 0, due_at = ?, updated_at = ? where item_id = ?`,
      [t, t, itemId]
    )
  })
  const r = (await db.get(`select term from items where id = ?`, [itemId])) as
    | { term: string }
    | undefined
  if (r) await ledger.forget(db, r.term, 'silenced')
  await ledger.op(db, 'unsilence', 'item', itemId, r?.term ?? null)
}

/**
 * 批量改层级（⑨ · 2026-09-01）—— 「转入认读 A」/「转入练习 B」
 *
 * ★★★ **这一条与 D-302 有冲突，已在报告里点名，等使用者裁。**
 *   D-302（承 D-293）写的是「不能修改既有知识点的内容本身 —— term / gloss /
 *   归类 / **层级**，**对同步下来的内容仍然只读**」。
 *   而需求 ⑨ 明确要「批量转入认读 / 批量转入练习」，⑩ 又说
 *   「只有用户之后主动重新设置，知识点才可以变成『练习』等其他状态」——
 *   **⑩ 要成立就必须有这条路**：所有新知识点都进 A 了，没有改层级的手段，
 *   B 层就永远空着。两条新指令互相印证，所以先做，并把冲突明写在这里。
 *   ★ 它是**完全可逆**的（改回去就是再调一次），不像硬删那样不可挽回 ——
 *     这也是我选择先做、而不是停下来等的原因。
 *
 * ★ 只动 `layer`。term / gloss / 归类一个字不碰 —— D-302 的其余部分原样成立。
 */
export async function bulkSetLayer(db: Db, ids: number[], layer: 'A' | 'B'): Promise<number> {
  if (ids.length === 0) return 0
  const t = Date.now()
  let n = 0
  await db.begin()
  try {
    for (const id of ids) {
      const prev = (await db.get(`select layer as l from items where id = ? and deleted_at is null`, [
        id
      ])) as { l?: string } | undefined
      if (!prev || prev.l === layer) continue
      await db.run(`update items set layer = ?, updated_at = ? where id = ?`, [layer, t, id])
      n += 1
    }
    await ledger.op(db, 'setLayer', 'item', null, `${n} 条 → ${layer === 'A' ? '认读 A' : '练习 B'}`)
    await db.commit()
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
  return n
}

/**
 * 批量移动到另一讲（⑨ · 2026-09-01）
 *
 * ★ 判据在 `core/move-items.ts` —— **D-354「两端同款方法一起定」**。
 *   动的是收录关系 `item_lectures`；`owner_lecture_id` 只在「原讲正好是 owner
 *   而移动之后已经不在原讲里」这一种悬空情况下由级联内部改判（同 deleteLecture）。
 * ★ 这里只做平台的三件事：事务、时间戳、留痕。
 */
export async function moveItemsTo(
  db: Db,
  ids: number[],
  fromLectureId: number,
  toLectureId: number
): Promise<MoveResult> {
  const t = Date.now()
  await db.begin()
  try {
    const r = await coreMoveItems(db, ids, fromLectureId, toLectureId, t)
    await ledger.op(db, 'move', 'item', null, `${r.moved + r.merged} 条 → 讲 ${toLectureId}`, r)
    await db.commit()
    return r
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
}

// ③ 档验收通道（同 globalThis.nyx 的纪律：不看界面，看变量）——
// 移动的正确性有一半在**另一台设备上**，只能靠真机上真移一次再对账（V36 / D-436③）
;(globalThis as Record<string, unknown>)['nyxMove'] = moveItemsTo
