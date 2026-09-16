/**
 * 阶段 5 · 管理动作全量（树三级 + 回收站级联 + 归档面）。
 *
 * 逐字港自 Windows repo.ts / browse.ts（行号为 2026-08-30 基线）：
 *   createProject/Unit/Lecture（380-439 · 默认名规则原样）· setPinned（505 ·
 *   只有项目有此列 —— 审计里单元/讲的置顶是能力缺口，不硬造）·
 *   moveNode（730 · 单元换项目/讲换单元 —— 与拖动排序是两件事 D-361）·
 *   reorder（701 · D-361 同类同父，跨父 id 一律拒收）·
 *   softDeleteContainer（452-480 · 同一时间戳批量下放 —— restore 的 ±2000 配对靠它）·
 *   deleteLecture（browse 552-586 · 独有词条跟着走，共用的把归属交给下一讲；
 *     ★ owner_lecture_id 在这里是**级联的机制内部维护** —— D-354 禁的是
 *     把它当「移动」动作改，原文辖域读过再定的，不是绕）·
 *   setSilentNode（repo 532-668 · 界面词「归档」：三层级联停排 +
 *     词条 silenced_by=tag；取消时只放 tag 的 —— 4.2 self 静默的不跟着出来）·
 *   markUnread（677）· restoreCascade（browse 245-361 · 父级补活 +
 *     同批 ±2000 子女 + 账本 forgetMany('deleted')）·
 *   listArchived（静默知识库容器面 —— 树的三层 where 都带 silent=0，
 *     不给这一面归档的就永远找不回来）· copyLines（I-098 从库里取）。
 * ★ P1-4 同类「第二份」（SQL 面），待上提 core。
 */
import * as ledger from './ledger.ts'
import type { Db } from './types.ts'

export type NodeKind = 'project' | 'unit' | 'lecture'

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

async function lastId(db: Db): Promise<number> {
  return Number((await db.get(`select last_insert_rowid() as id`))?.['id'] ?? 0)
}

export async function createProject(db: Db, name?: string): Promise<number> {
  const t = Date.now()
  const n = name?.trim() || `新项目 ${new Date().toLocaleDateString('zh-CN')}`
  await db.run(`insert into projects (name, created_at, updated_at) values (?, ?, ?)`, [n, t, t])
  return lastId(db)
}

export async function createUnit(db: Db, projectId: number, name?: string): Promise<number> {
  const t = Date.now()
  const c = Number(
    (
      await db.get(`select count(*) as c from units where project_id = ? and deleted_at is null`, [
        projectId
      ])
    )?.['c'] ?? 0
  )
  const n = name?.trim() || `第 ${c + 1} 单元`
  await db.run(`insert into units (project_id, name, created_at, updated_at) values (?, ?, ?, ?)`, [
    projectId,
    n,
    t,
    t
  ])
  return lastId(db)
}

export async function createLecture(db: Db, unitId: number, name?: string): Promise<number> {
  const t = Date.now()
  const c = Number(
    (await db.get(`select count(*) as c from lectures where unit_id = ? and deleted_at is null`, [unitId]))?.[
      'c'
    ] ?? 0
  )
  const n = name?.trim() || `L${c + 1}`
  await db.run(
    `insert into lectures (unit_id, name, number, status, created_at, updated_at)
     values (?, ?, ?, 'empty', ?, ?)`,
    [unitId, n, c + 1, t, t]
  )
  return lastId(db)
}

export async function setPinned(db: Db, id: number, on: boolean): Promise<void> {
  await db.run(`update projects set pinned = ?, updated_at = ? where id = ?`, [on ? 1 : 0, Date.now(), id])
}

export async function moveNode(
  db: Db,
  kind: 'unit' | 'lecture',
  id: number,
  newParentId: number
): Promise<void> {
  const t = Date.now()
  if (kind === 'unit') {
    await db.run(`update units set project_id = ?, updated_at = ? where id = ?`, [newParentId, t, id])
  } else {
    await db.run(`update lectures set unit_id = ?, updated_at = ? where id = ?`, [newParentId, t, id])
  }
}

export async function reorder(db: Db, kind: NodeKind, parentId: number | null, ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const t = Date.now()
  const table = kind === 'project' ? 'projects' : kind === 'unit' ? 'units' : 'lectures'
  await tx(db, async () => {
    if (kind !== 'project') {
      const col = kind === 'unit' ? 'project_id' : 'unit_id'
      const ok = new Set(
        (await db.all(`select id from "${table}" where ${col} = ? and deleted_at is null`, [parentId])).map(
          (x) => Number(x['id'])
        )
      )
      const stray = ids.filter((x) => !ok.has(x))
      if (stray.length > 0) {
        throw new Error(
          `不能跨级拖动：${stray.join('、')} 不在这个${kind === 'unit' ? '项目' : '单元'}下面。`
        )
      }
    }
    for (let i = 0; i < ids.length; i++) {
      await db.run(`update "${table}" set sort = ?, updated_at = ? where id = ?`, [i, t, ids[i]])
    }
  })
}

export async function softDeleteContainer(
  db: Db,
  kind: 'project' | 'unit',
  id: number
): Promise<{ lectures: number }> {
  const t = Date.now()
  let n = 0
  await tx(db, async () => {
    const lecRows =
      kind === 'project'
        ? await db.all(
            `select l.id from lectures l join units u on u.id = l.unit_id
              where u.project_id = ? and l.deleted_at is null`,
            [id]
          )
        : await db.all(`select id from lectures where unit_id = ? and deleted_at is null`, [id])
    for (const l of lecRows) {
      await db.run(`update lectures set deleted_at = ?, updated_at = ? where id = ?`, [t, t, Number(l['id'])])
    }
    n = lecRows.length
    if (kind === 'project') {
      await db.run(`update units set deleted_at = ?, updated_at = ? where project_id = ?`, [t, t, id])
      await db.run(`update projects set deleted_at = ?, updated_at = ? where id = ?`, [t, t, id])
    } else {
      await db.run(`update units set deleted_at = ?, updated_at = ? where id = ?`, [t, t, id])
    }
    await ledger.op(db, 'delete', kind, id, null, { lectures: n })
  })
  return { lectures: n }
}

export async function deleteLecture(db: Db, lectureId: number): Promise<{ items: number; moved: number }> {
  const t = Date.now()
  let items = 0
  let moved = 0
  const deletedTerms: string[] = []
  await tx(db, async () => {
    const owned = await db.all(
      `select item_id as id from item_lectures where lecture_id = ? and is_owner = 1`,
      [lectureId]
    )
    for (const row of owned) {
      const id = Number(row['id'])
      const other = await db.get(
        `select lecture_id as l from item_lectures
          where item_id = ? and lecture_id != ? order by lecture_id limit 1`,
        [id, lectureId]
      )
      if (other) {
        await db.run(`update items set owner_lecture_id = ?, updated_at = ? where id = ?`, [
          Number(other['l']),
          t,
          id
        ])
        await db.run(
          `update item_lectures set is_owner = 1, updated_at = ? where item_id = ? and lecture_id = ?`,
          [t, id, Number(other['l'])]
        )
        moved += 1
      } else {
        const r = await db.get(`select term from items where id = ?`, [id])
        if (r) deletedTerms.push(String(r['term']))
        await db.run(`update items set deleted_at = ?, updated_at = ? where id = ?`, [t, t, id])
        items += 1
      }
    }
    await db.run(`update lectures set deleted_at = ?, updated_at = ? where id = ?`, [t, t, lectureId])
    if (deletedTerms.length > 0) await ledger.noteMany(db, deletedTerms, 'deleted', { note: '随 Lecture 删除' })
    await ledger.op(db, 'delete', 'lecture', lectureId, null, { items, moved })
  })
  return { items, moved }
}

export async function setSilentNode(db: Db, kind: NodeKind, id: number, on: boolean): Promise<void> {
  const table = kind === 'project' ? 'projects' : kind === 'unit' ? 'units' : 'lectures'
  const t = Date.now()
  const tag = kind
  await tx(db, async () => {
    await db.run(`update "${table}" set silent = ?, updated_at = ? where id = ?`, [on ? 1 : 0, t, id])

    if (kind === 'project') {
      await db.run(
        `update lectures
            set silent = ?,
                due_at = case when ? then null
                              when status = 'training' then coalesce(due_at, ?)
                              else due_at end,
                updated_at = ?
          where unit_id in (select id from units where project_id = ?)`,
        [on ? 1 : 0, on ? 1 : 0, t, t, id]
      )
      await db.run(`update units set silent = ?, updated_at = ? where project_id = ?`, [on ? 1 : 0, t, id])
    } else if (kind === 'unit') {
      await db.run(
        `update lectures
            set silent = ?,
                due_at = case when ? then null
                              when status = 'training' then coalesce(due_at, ?)
                              else due_at end,
                updated_at = ?
          where unit_id = ?`,
        [on ? 1 : 0, on ? 1 : 0, t, t, id]
      )
    } else if (on) {
      await db.run(`update lectures set due_at = null, updated_at = ? where id = ?`, [t, id])
    } else {
      await db.run(
        `update lectures set due_at = coalesce(due_at, ?), updated_at = ? where id = ? and status = 'training'`,
        [t, t, id]
      )
    }

    // 4.2 · 知识点跟着进 / 出静默库
    const lecIds =
      kind === 'lecture'
        ? [id]
        : (
            await db.all(
              kind === 'project'
                ? `select l.id from lectures l join units u on u.id = l.unit_id where u.project_id = ?`
                : `select id from lectures where unit_id = ?`,
              [id]
            )
          ).map((r) => Number(r['id']))
    if (lecIds.length === 0) return
    const list = lecIds.join(',')
    if (on) {
      const pick = `deleted_at is null
            and production_state <> 'silent'
            and id in (select item_id from item_lectures where lecture_id in (${list}) and deleted_at is null)`
      await db.run(
        `update reading_cards set silent = 1, due_at = null, updated_at = ?
          where item_id in (select id from items where ${pick})`,
        [t]
      )
      await db.run(
        `update items set production_state = 'silent', silenced_by = ?, updated_at = ? where ${pick}`,
        [tag, t]
      )
    } else {
      const pick = `deleted_at is null
            and silenced_by = ?
            and id in (select item_id from item_lectures where lecture_id in (${list}) and deleted_at is null)`
      await db.run(
        `update reading_cards set silent = 0, due_at = ?, updated_at = ?
          where item_id in (select id from items where ${pick})`,
        [t, t, tag]
      )
      await db.run(
        `update items set production_state = 'training', silenced_by = null, updated_at = ? where ${pick}`,
        [t, tag]
      )
    }
    await ledger.op(db, on ? 'archive' : 'unarchive', kind, id, null, null)
  })
}

export async function markUnread(db: Db, lectureId: number): Promise<void> {
  const t = Date.now()
  await db.run(
    `update lectures set status = 'review', due_at = null, interval_days = 0, updated_at = ? where id = ?`,
    [t, lectureId]
  )
}

export async function restoreCascade(db: Db, kind: NodeKind | 'item', id: number): Promise<number> {
  const t = Date.now()
  let n = 0
  const undelete = async (tb: string, rowId: number): Promise<number> => {
    await db.run(
      `update "${tb}" set deleted_at = null, updated_at = ? where id = ? and deleted_at is not null`,
      [t, rowId]
    )
    return Number((await db.get(`select changes() as c`))?.['c'] ?? 0)
  }
  const itemsOfBatch = async (lecId: number, d: number): Promise<number> => {
    await db.run(
      `update items set deleted_at = null, updated_at = ?
        where deleted_at is not null and abs(deleted_at - ?) < 2000
          and id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`,
      [t, d, lecId]
    )
    return Number((await db.get(`select changes() as c`))?.['c'] ?? 0)
  }
  const restorePathOfUnit = async (unitId: number): Promise<void> => {
    const u = await db.get(`select project_id as p from units where id = ?`, [unitId])
    if (!u) return
    n += await undelete('units', unitId)
    n += await undelete('projects', Number(u['p']))
  }

  const table = { project: 'projects', unit: 'units', lecture: 'lectures', item: 'items' }[kind]
  await tx(db, async () => {
    const del = await db.get(`select deleted_at as d from "${table}" where id = ?`, [id])
    await undelete(table, id)
    n = 1

    if (kind === 'lecture') {
      const l = await db.get(`select unit_id as u from lectures where id = ?`, [id])
      if (l) await restorePathOfUnit(Number(l['u']))
      if (del?.['d'] != null) n += await itemsOfBatch(id, Number(del['d']))
    }
    if (kind === 'unit') {
      await restorePathOfUnit(id)
      const ls = await db.all(
        `select id, deleted_at as d from lectures where unit_id = ? and deleted_at is not null`,
        [id]
      )
      for (const l of ls) {
        n += await undelete('lectures', Number(l['id']))
        n += await itemsOfBatch(Number(l['id']), Number(l['d']))
      }
    }
    if (kind === 'project') {
      const us = await db.all(`select id from units where project_id = ? and deleted_at is not null`, [id])
      for (const u of us) n += await undelete('units', Number(u['id']))
      const ls = await db.all(
        `select l.id, l.deleted_at as d from lectures l join units u on u.id = l.unit_id
          where u.project_id = ? and l.deleted_at is not null`,
        [id]
      )
      for (const l of ls) {
        n += await undelete('lectures', Number(l['id']))
        n += await itemsOfBatch(Number(l['id']), Number(l['d']))
      }
    }

    // 账本撤销（R-3-e）：恢复出来的词条把「以后别再收」那笔撤掉
    let terms: string[]
    if (kind === 'item') {
      const r = await db.get(`select term from items where id = ?`, [id])
      terms = r ? [String(r['term'])] : []
    } else {
      terms = (
        await db.all(
          `select distinct i.term from items i
             join item_lectures il on il.item_id = i.id and il.deleted_at is null
             join lectures l on l.id = il.lecture_id
             join units u on u.id = l.unit_id
            where ${kind === 'project' ? 'u.project_id = ?' : kind === 'unit' ? 'u.id = ?' : 'l.id = ?'}`,
          [id]
        )
      ).map((r) => String(r['term']))
    }
    if (terms.length > 0) await ledger.forgetMany(db, terms, 'deleted')
    await ledger.op(db, 'restore', kind, id, terms[0] ?? null, { restored: n })
  })
  return n
}

/** 静默知识库的容器面 —— 树的三层 where 都带 silent=0，归档的只能从这里回来 */
export interface ArchivedRow {
  kind: NodeKind
  id: number
  name: string
  updatedAt: number
}
export async function listArchived(db: Db): Promise<ArchivedRow[]> {
  const out: ArchivedRow[] = []
  const grab = async (kind: NodeKind, table: string): Promise<void> => {
    for (const r of await db.all(
      `select id, name, updated_at as u from "${table}" where deleted_at is null and silent = 1 order by updated_at desc`
    )) {
      out.push({ kind, id: Number(r['id']), name: String(r['name']), updatedAt: Number(r['u']) })
    }
  }
  await grab('project', 'projects')
  await grab('unit', 'units')
  await grab('lecture', 'lectures')
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 复制词条（I-098：从库里取，不从界面凑）—— id → 「term — gloss」行 */
export async function copyLines(db: Db, ids: number[]): Promise<string> {
  if (ids.length === 0) return ''
  const q = ids.map(() => '?').join(',')
  return (await db.all(`select term, gloss from items where id in (${q}) order by id`, ids))
    .map((r) => `${String(r['term'])}${r['gloss'] ? ` — ${String(r['gloss'])}` : ''}`)
    .join('\n')
}
