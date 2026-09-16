/**
 * Lecture 内知识点合并 —— **一个事务**（T-9.13 · D-478② · D-026）
 *
 * ══ 分工 ═══════════════════════════════════════════════════
 *
 * 判据全在 `core/dedup/plan.ts`（分组 · 分档 · 选主 · 逐表迁移计划，T-2.11），
 * 与 Windows `src/main/db/merge.ts` **同一份**。这个文件只做两件平台活：
 * **把库里的行读成判据要的形状**、**按计划写库**。
 * 判据里一行 SQL 都没有，这里一条业务规则都不重新定 ——
 * 混起来的话，两端就会各有一套「什么算重复」，而它们会慢慢分叉。
 *
 * ══ 三条必须照抄 Windows 的判断（每一条都有它治的病）══════════
 *
 * ★★ ① **绝不走 `manage.ts::softDeleteItems`。**
 *   那是删知识点的入口，它会 `ledger.noteMany(terms, 'deleted')` ——
 *   往 `term_ledger` 记一笔「这个说法以后别再收」。而合并时被并那条和
 *   留下那条**是同一个字面**：记了这一笔，下次分析同一篇材料，
 *   **留下的那条也进不来了**，而且不报错。所以这里自己写那一句软删，
 *   只记 `ops_log`，一个字都不进 `term_ledger`。
 *
 * ★★ ② **绝不裸 `delete from`**（D-435 / D-436，Windows 的 `check:hard-deletes`
 *   连这个仓的 `src/db` 一起扫）。被并那条是**软删进回收站**：
 *   `TRASH_DAYS` 天内可反悔，而且照常同步。
 *
 * ★★ ③ **不动被并那条的 `item_lectures`。**
 *   回收站恢复知识点只是把 `items.deleted_at` 清空。这里要是顺手把它的
 *   Lecture 归属也软删了，恢复出来的就是一条**不属于任何 Lecture 的孤儿** ——
 *   他在回收站点了「恢复」，然后哪儿都找不到它。
 *
 * ══ 恢复不是完整撤销（界面上也要说）═════════════════════════
 *
 * 自然身份那四张表是「在 canonical 名下新建」，被并那条自己的行原样留着，
 * 所以恢复之后它还是完整的一条。但随机身份那几处（作答 · 复习 · 事件 ·
 * 练习题 · 状态流水 · 析出项的父）是**改 `item_id`**，改过去就留在
 * canonical 上，恢复不会把它们要回来。这是有意的：那些是学习史，
 * 合并的目的正是让它们归到一处。
 */
import { planMerge, scanDuplicates, type DedupItem, type ItemRows } from '../core-link.ts'
import * as ledger from './ledger.ts'
import type { Db, Row } from './types.ts'

// ── 界面要的形状（Windows `shared/api.ts` 里那三个的同款）──────

export interface DedupMemberView {
  id: number
  term: string
  gloss: string
  layer: string
  createdAt: number
  answers: number
  reviewLogs: number
  blocks: string[]
}

export interface DedupGroupView {
  norm: string
  bucket: 'safe' | 'review'
  reasons: string[]
  canonicalId: number
  members: DedupMemberView[]
}

export interface DedupReport {
  lectureId: number
  groups: DedupGroupView[]
  /** 受影响的条数（所有组的成员总数，含主记录） */
  affected: number
  safe: number
  review: number
}

/** 要并哪些：`safe` = 判据说安全的全部；`one` = 他在某个 Review 组里自己挑的 */
export type DedupPick = { kind: 'safe' } | { kind: 'one'; canonicalId: number; loserIds: number[] }

export interface DedupMergeResult {
  /** 处理了几组 */
  groups: number
  /** 被并掉（软删进回收站）的条数 */
  merged: number
  /** 每张表迁了多少行 —— D-458：给出一个数就要能答是哪些 */
  moved: Record<string, number>
}

// ── 读：把一讲的知识点读成判据要的形状 ────────────────────────

interface ItemRow {
  id: number
  uid: string | null
  term: string
  gloss: string
  layer: string
  createdAt: number
  answers: number
  reviewLogs: number
}

const num = (v: unknown): number => Number(v ?? 0)
const str = (v: unknown): string => String(v ?? '')

/** uid 是触发器插入时补的。真缺了就退回按 id 造一个稳定串，不让整趟扫描瘫掉 */
const keyOf = (uid: string | null, id: number): string => uid ?? `id:${id}`

async function itemsOf(db: Db, lectureId: number): Promise<ItemRow[]> {
  const rows = await db.all(
    `select i.id, i.uid, i.term, i.gloss, i.layer, i.created_at as createdAt,
            (select count(*) from answers a where a.item_id = i.id) as answers,
            (select count(*) from review_logs r where r.item_id = i.id) as reviewLogs
       from items i
       join item_lectures il on il.item_id = i.id and il.deleted_at is null
      where il.lecture_id = ? and i.deleted_at is null
      order by i.id`,
    [lectureId]
  )
  return rows.map((r: Row) => ({
    id: num(r['id']),
    uid: r['uid'] === null || r['uid'] === undefined ? null : String(r['uid']),
    term: str(r['term']),
    gloss: str(r['gloss']),
    layer: str(r['layer']),
    createdAt: num(r['createdAt']),
    answers: num(r['answers']),
    reviewLogs: num(r['reviewLogs'])
  }))
}

async function blocksOf(db: Db, ids: number[]): Promise<Map<number, { block: string; content: string }[]>> {
  const out = new Map<number, { block: string; content: string }[]>()
  if (ids.length === 0) return out
  const rows = await db.all(
    `select item_id as itemId, block, content from analysis_blocks
      where item_id in (${ids.map(() => '?').join(',')}) order by item_id, block`,
    ids
  )
  for (const r of rows) {
    const id = num(r['itemId'])
    const one = { block: str(r['block']), content: str(r['content']) }
    const arr = out.get(id)
    if (arr) arr.push(one)
    else out.set(id, [one])
  }
  return out
}

/** 一条知识点在各张子表上现有的东西 —— 自然身份的键写成 `core/identity.ts` 那套形状 */
async function rowsOf(db: Db, itemId: number): Promise<ItemRows> {
  const one = async (sql: string): Promise<number> => num((await db.get(sql, [itemId]))?.['n'])
  const many = async (sql: string): Promise<string[]> =>
    (await db.all(sql, [itemId])).map((r) => str(r['k']))

  return {
    lectures: await many(
      `select coalesce(l.uid, 'id:' || l.id) as k from item_lectures il
         join lectures l on l.id = il.lecture_id
        where il.item_id = ? and il.deleted_at is null order by k`
    ),
    /**
     * `identity.ts` 的规则：material 非空时自然键是 (知识点, 材料)，否则是 (知识点, 讲) ——
     * 所以这里写成 `m|<材料 uid>` / `l|<讲 uid>`，与那份规则一一对应。
     */
    occurrences: await many(
      `select case when o.material_id is not null
                   then 'm|' || coalesce(m.uid, 'id:' || m.id)
                   else 'l|' || coalesce(lc.uid, 'id:' || lc.id) end as k
         from occurrences o
         left join materials m on m.id = o.material_id
         left join lectures lc on lc.id = o.lecture_id
        where o.item_id = ? order by k`
    ),
    blocks: (await db.all(`select block from analysis_blocks where item_id = ? order by block`, [itemId])).map(
      (r) => str(r['block'])
    ),
    card: (await one(`select count(*) as n from reading_cards where item_id = ?`)) > 0,
    answers: await one(`select count(*) as n from answers where item_id = ?`),
    reviewLogs: await one(`select count(*) as n from review_logs where item_id = ?`),
    itemEvents: await one(`select count(*) as n from item_events where item_id = ?`),
    questions: await one(`select count(*) as n from questions where item_id = ?`),
    stateEvents: await one(`select count(*) as n from state_events where item_id = ?`),
    derived: await one(`select count(*) as n from items where derived_from = ?`),
    recollected: await one(`select recollected_count as n from items where id = ?`)
  }
}

// ── 扫描 ────────────────────────────────────────────────────

/**
 * 扫一个 Lecture。**只读，一个字都不写** ——
 * 他按下按钮先看见结果，再决定动不动手。
 */
export async function dedupScan(db: Db, lectureId: number): Promise<DedupReport> {
  const rows = await itemsOf(db, lectureId)
  const blocks = await blocksOf(db, rows.map((r) => r.id))
  const byKey = new Map<string, ItemRow>()
  const items: DedupItem[] = rows.map((r) => {
    const uid = keyOf(r.uid, r.id)
    byKey.set(uid, r)
    return {
      uid,
      term: r.term,
      gloss: r.gloss,
      layer: r.layer,
      createdAt: r.createdAt,
      answers: r.answers,
      reviewLogs: r.reviewLogs,
      blocks: blocks.get(r.id) ?? []
    }
  })

  const scan = scanDuplicates(items)
  const view = (uid: string): DedupMemberView => {
    const r = byKey.get(uid)!
    return {
      id: r.id,
      term: r.term,
      gloss: r.gloss,
      layer: r.layer,
      createdAt: r.createdAt,
      answers: r.answers,
      reviewLogs: r.reviewLogs,
      blocks: (blocks.get(r.id) ?? []).map((b) => b.block)
    }
  }

  return {
    lectureId,
    affected: scan.affected,
    safe: scan.safe,
    review: scan.review,
    groups: scan.groups.map((g) => ({
      norm: g.norm,
      bucket: g.bucket,
      reasons: [...g.reasons],
      canonicalId: byKey.get(g.canonical)!.id,
      members: [g.canonical, ...g.losers].map(view)
    }))
  }
}

// ── 合并 ────────────────────────────────────────────────────

/**
 * `pick.kind === 'safe'`：**只**合并判据说 Safe 的组。
 * `pick.kind === 'one'`：他在某个 Review 组里自己挑了主记录。
 *
 * ★★ 「Review 不自动处理」这条策略落在**这里**，不在界面上。
 *   放界面的话，任何一处调用绕过它都不会有人发现，而后果是
 *   跨层 / 有学习史的条目被**自动**并掉 —— 不可逆，且他没看见。
 *
 * ★ `one` 那一支要**回到判据里核一遍**：他挑的那几条必须真的在同一组重复里。
 *   界面传什么就并什么的话，一个错的 id 就能把两条毫不相干的知识点并掉。
 */
export async function dedupMerge(
  db: Db,
  lectureId: number,
  pick: DedupPick
): Promise<DedupMergeResult> {
  const report = await dedupScan(db, lectureId)
  const jobs: { canonicalId: number; loserIds: number[] }[] = []

  if (pick.kind === 'safe') {
    for (const g of report.groups) {
      if (g.bucket !== 'safe') continue
      jobs.push({
        canonicalId: g.canonicalId,
        loserIds: g.members.filter((m) => m.id !== g.canonicalId).map((m) => m.id)
      })
    }
  } else {
    const group = report.groups.find((g) => g.members.some((m) => m.id === pick.canonicalId))
    if (!group) throw new Error('这一条已经不在任何一组重复里了 —— 先重新扫一次。')
    const inGroup = new Set(group.members.map((m) => m.id))
    for (const id of [pick.canonicalId, ...pick.loserIds]) {
      if (!inGroup.has(id)) throw new Error(`知识点 ${id} 不在这一组重复里，不能并。`)
    }
    jobs.push({ canonicalId: pick.canonicalId, loserIds: [...pick.loserIds] })
  }

  const moved: Record<string, number> = {}
  let merged = 0
  await db.begin()
  try {
    for (const job of jobs) {
      for (const loserId of job.loserIds) {
        await mergeOne(db, job.canonicalId, loserId, moved)
        merged++
      }
    }
    await db.commit()
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }

  return { groups: jobs.length, merged, moved }
}

/** 随机身份那几张表 —— 白名单在这里再核一次，防的是将来判据里加了表却忘了接线 */
const REPOINTABLE = ['answers', 'review_logs', 'item_events', 'questions', 'state_events']

/** 并一条。**必须在事务里调用** —— 中途炸掉不许留下半并的状态 */
async function mergeOne(
  db: Db,
  canonicalId: number,
  loserId: number,
  moved: Record<string, number>
): Promise<void> {
  if (canonicalId === loserId) throw new Error('不能把一条知识点并到它自己身上。')
  const t = Date.now()
  const c = await rowsOf(db, canonicalId)
  const l = await rowsOf(db, loserId)
  const plan = planMerge(String(canonicalId), String(loserId), c, l)
  const bump = (table: string, n = 1): void => {
    moved[table] = (moved[table] ?? 0) + n
  }
  /** 改了多少行 —— Android 的 `run` 不回 changes，只能自己数一次 */
  const countOf = async (sql: string, params: readonly unknown[]): Promise<number> =>
    num((await db.get(sql, params))?.['n'])

  for (const step of plan.steps) {
    // `keep`：canonical 已经有这一份，旧行留在被并那条名下不动（跟着它进回收站）
    if (step.kind === 'keep') continue

    if (step.kind === 'create') {
      // 自然身份：在 canonical 名下新建。uid 由触发器按自然键算，**这里不许自己拼**
      if (step.table === 'item_lectures') {
        await db.run(
          `insert or ignore into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
             select ?, il.lecture_id, 0, ?, ? from item_lectures il
              where il.item_id = ? and il.deleted_at is null
                and coalesce((select l.uid from lectures l where l.id = il.lecture_id), 'id:' || il.lecture_id) = ?`,
          [canonicalId, t, t, loserId, step.key]
        )
        bump('item_lectures')
      } else if (step.table === 'occurrences') {
        await db.run(
          `insert into occurrences (item_id, material_id, lecture_id, quote, para, created_at, updated_at)
             select ?, o.material_id, o.lecture_id, o.quote, o.para, ?, ?
               from occurrences o
               left join materials m on m.id = o.material_id
               left join lectures lc on lc.id = o.lecture_id
              where o.item_id = ?
                and case when o.material_id is not null
                         then 'm|' || coalesce(m.uid, 'id:' || m.id)
                         else 'l|' || coalesce(lc.uid, 'id:' || lc.id) end = ?
              limit 1`,
          [canonicalId, t, t, loserId, step.key]
        )
        bump('occurrences')
      } else if (step.table === 'analysis_blocks') {
        await db.run(
          `insert into analysis_blocks (item_id, block, content, edited, regen_count, created_at, updated_at)
             select ?, b.block, b.content, b.edited, b.regen_count, ?, ?
               from analysis_blocks b where b.item_id = ? and b.block = ?`,
          [canonicalId, t, t, loserId, step.key]
        )
        bump('analysis_blocks')
      } else if (step.table === 'reading_cards') {
        // 触发器保证每条知识点插入时就有一张卡，走到这里说明那张卡缺了 —— 补上
        await db.run(
          `insert or ignore into reading_cards (item_id, created_at, updated_at) values (?, ?, ?)`,
          [canonicalId, t, t]
        )
        bump('reading_cards')
      }
      continue
    }

    if (step.kind === 'repoint') {
      if (step.table === 'items.derived_from') {
        const n = await countOf(`select count(*) as n from items where derived_from = ?`, [loserId])
        await db.run(`update items set derived_from = ?, updated_at = ? where derived_from = ?`, [
          canonicalId,
          t,
          loserId
        ])
        bump('items.derived_from', n)
      } else {
        /**
         * 表名来自判据里写死的那几个常量，不是外来输入 —— 拼进 SQL 是安全的。
         * 白名单再核一次：将来往判据里加了表却忘了这里，要当场炸，不许静默少迁一张。
         */
        if (!REPOINTABLE.includes(step.table)) {
          throw new Error(`合并计划里出现了没接线的表：${step.table}`)
        }
        const n = await countOf(`select count(*) as n from "${step.table}" where item_id = ?`, [loserId])
        await db.run(`update "${step.table}" set item_id = ?, updated_at = ? where item_id = ?`, [
          canonicalId,
          t,
          loserId
        ])
        bump(step.table, n)
      }
      continue
    }

    if (step.kind === 'add') {
      await db.run(
        `update items set recollected_count = recollected_count + ?, updated_at = ? where id = ?`,
        [step.value, t, canonicalId]
      )
      bump('recollected_count', step.value)
    }
  }

  /**
   * 被并那条软删进回收站。★ 只动 `items.deleted_at`：
   * 不动 `item_lectures`（文件头 ③），不记 `term_ledger`（文件头 ①）。
   */
  await db.run(`update items set deleted_at = ?, updated_at = ? where id = ?`, [t, t, loserId])

  const uidOf = async (id: number): Promise<string> => {
    const r = await db.get(`select uid from items where id = ?`, [id])
    const uid = r?.['uid']
    return uid === null || uid === undefined ? `id:${id}` : String(uid)
  }
  const term = str((await db.get(`select term from items where id = ?`, [canonicalId]))?.['term'])

  /** D-458 · 给出一个数就要能答是哪些：两条 uid + 每张表迁了什么 */
  await ledger.op(db, 'merge', 'item', canonicalId, term, {
    canonical: await uidOf(canonicalId),
    merged: await uidOf(loserId),
    steps: plan.steps
  })
}
