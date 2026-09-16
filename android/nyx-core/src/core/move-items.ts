/**
 * 把知识点从一讲挪到另一讲 —— **两端同一份方法**（D-354，2026-09-01）
 *
 * ── 为什么这份判据一开始就放 core ────────────────────────
 *
 * D-354 明写「移动的方法**两端同款一起定**」。在这之前**两端都没有** ——
 * Windows 只有容器的 `move(unit|lecture)`，手机侧的「移动」按钮当初被拿掉，
 * 理由就是「方法未定，只会道歉的按钮没有价值」。
 * 需求 ⑨ 要它了，所以方法在这里定一次，Windows 将来接 UI 时直接用同一份。
 *
 * ── 「移动」到底动什么 ★★ ───────────────────────────────
 *
 * 动的是**收录关系** `item_lectures`：把 (item, 原讲) 那一行换成 (item, 目标讲)。
 *
 * ★ **不把 `owner_lecture_id` 当移动目标改** —— 这正是 D-354 禁的那一条。
 *   它记的是「这条是谁最先收下的」，是历史事实，不随收录关系走。
 *
 * ★ 但**级联可以内部维护它**（既有先例：`deleteLecture` 就是这么做的 ——
 *   「独有词条跟着走，共用的把归属交给下一讲」）。所以这里只在一种情况下动它：
 *   **原讲正好是 owner，而移动之后这条已经不在原讲里了** ——
 *   那个 owner 指向一个不再收录它的讲，是个悬空事实。
 *   这时把 owner 交给「下一个还收录它的讲」，与 `deleteLecture` 同一条规则。
 *
 * ── 一条边界 ─────────────────────────────────────────
 *
 * 目标讲里已经有这条了 → 只删原讲那一行，不重复插入
 * （`item_lectures` 上有唯一索引，硬插会炸；而且语义上「已经在那儿了」就是成功）。
 */
import type { CascadeDb } from './cascade.ts'
import { IL_ALIVE } from './sql/item-lectures.ts'

export interface MoveResult {
  /** 真的换了收录关系的条数 */
  moved: number
  /** 目标讲里本来就有、只是从原讲摘掉的条数 */
  merged: number
  /** 因为原讲变成悬空 owner 而改判归属的条数 */
  reowned: number
}

export async function moveItems(
  db: CascadeDb,
  ids: number[],
  fromLectureId: number,
  toLectureId: number,
  now: number
): Promise<MoveResult> {
  const out: MoveResult = { moved: 0, merged: 0, reowned: 0 }
  if (ids.length === 0 || fromLectureId === toLectureId) return out

  for (const id of ids) {
    const inFrom = await db.get(
      `select 1 as x from item_lectures where item_id = ? and lecture_id = ? and ${IL_ALIVE}`,
      [id, fromLectureId]
    )
    if (!inFrom) continue // 它根本不在原讲里 —— 不是这次移动的对象

    /**
     * ★★ V36 · 目标讲里**可能有一行已经软删的**（他之前把它移出去过）。
     *   那一行必须**复活**，不能新插一条 —— uid 是从 (知识点, 讲) 推出来的，
     *   插新的会撞 `unique(item_id, lecture_id)`。
     */
    const inTo = (await db.get(
      `select deleted_at as d from item_lectures where item_id = ? and lecture_id = ?`,
      [id, toLectureId]
    )) as { d: number | null } | undefined

    /**
     * ★★★ D-436③ · **软删，不删行。**
     *   删行不会立墓碑（`TOMBSTONE_KINDS` 只覆盖六类实体），
     *   于是「从旧讲摘出来」这一半**到不了另一台**，对面两个讲次都留着它。
     *   软删是一次普通的行更新，跟着同步走。
     */
    await db.run(
      `update item_lectures set deleted_at = ?, updated_at = ? where item_id = ? and lecture_id = ?`,
      [now, now, id, fromLectureId]
    )
    if (inTo && inTo.d === null) {
      out.merged += 1
    } else if (inTo) {
      // 之前移出去过 —— 把那一行复活，身份不变
      await db.run(
        `update item_lectures set deleted_at = null, updated_at = ? where item_id = ? and lecture_id = ?`,
        [now, id, toLectureId]
      )
      out.moved += 1
    } else {
      await db.run(
        `insert into item_lectures (item_id, lecture_id, created_at, updated_at) values (?, ?, ?, ?)`,
        [id, toLectureId, now, now]
      )
      out.moved += 1
    }

    // 悬空 owner 的收尾（见文件头）—— 同 deleteLecture 的规则
    const own = await db.get(`select owner_lecture_id as o from items where id = ?`, [id])
    if (Number(own?.['o'] ?? 0) === fromLectureId) {
      const next = await db.get(
        `select lecture_id as l from item_lectures where item_id = ? and ${IL_ALIVE} order by lecture_id limit 1`,
        [id]
      )
      if (next) {
        await db.run(`update items set owner_lecture_id = ?, updated_at = ? where id = ?`, [
          Number(next['l']),
          now,
          id
        ])
        out.reowned += 1
      }
    }
    await db.run(`update items set updated_at = ? where id = ?`, [now, id])
  }
  return out
}
