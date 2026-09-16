import type { Database } from 'better-sqlite3'
import { planMerge, scanDuplicates, type DedupItem, type ItemRows } from '@core/dedup/plan.ts'
import type { DedupReport, DedupMergeResult, DedupPick } from '@shared/api.ts'
import { Ledger } from './ledger.ts'

/**
 * 知识点「合并」领域操作 —— **一个事务**（T-2.11 · 需求归档 §六）
 *
 * ══ 分工 ═══════════════════════════════════════════════════
 *
 * 判据全在 `@core/dedup/plan.ts`（分组 · 分档 · 选主 · 逐表迁移计划），
 * 这里只做两件事：**把库里的行读成判据要的形状**，**按计划写库**。
 * 判据里一行 SQL 都没有，这里一条业务规则都不重新定 —— 混起来的话，
 * 手机将来要复用同一套判据就得连 SQLite 一起搬。
 *
 * ══ 三条必须写在这里的判断 ═════════════════════════════════
 *
 * ★★ ① **绝不走 `study.deleteItems`。**
 *   那是删知识点的唯一入口，它会往 `term_ledger` 记一笔 `deleted` ——
 *   意思是「这个说法以后别再收」。而合并时被并那条和留下那条**是同一个字面**：
 *   记了这一笔，下次分析同一篇材料，**留下的那条也进不来了**，而且不报错。
 *   （`study.ts` 那个入口的注释里管这种形状叫 I-119。）
 *   所以这里自己软删，只记 `ops_log`，一个字都不进 `term_ledger`。
 *
 * ★★ ② **绝不裸 `delete from`**（D-435 / D-436，`check:hard-deletes` 守着）。
 *   被并那条是**软删进回收站**：保留期内可反悔（`TRASH_DAYS`），照常同步。
 *
 * ★★ ③ **不动被并那条的 `item_lectures`。**
 *   回收站恢复知识点只是 `items.deleted_at = null`。这里要是顺手把它的
 *   讲次归属也软删了，恢复出来的就是一条**不属于任何讲次**的孤儿 ——
 *   他在回收站点了「恢复」，然后哪儿都找不到它。
 *
 * ══ 恢复不是完整撤销（写在这里，界面上也要说） ═════════════
 *
 * 自然身份那四张表是「在 canonical 名下新建」，被并那条自己的行原样留着，
 * 所以恢复之后它还是完整的一条。但随机身份那五处（作答 · 复习 · 事件 ·
 * 练习题 · 状态流水 · 析出项的父）是**改 `item_id`**，改过去就留在 canonical 上，
 * 恢复不会把它们要回来。这是有意的：那些是学习史，合并的目的正是让它们归到一处。
 */

/**
 * ★ 用 `Date.now()`，**不引** `clock.ts` 的可注入时间源 ——
 *   `study.ts` / `browse.ts`（另外两处软删知识点的地方）都是这么写的，
 *   而 `Step 7D · 时间源不许扩散` 那条用例守着那份白名单：
 *   时间源每多去一个文件，就多一个「测试里对、生产里不对」的口子。
 */
const now = (): number => Date.now()

/** uid 是触发器在插入时补的。真缺了就退回按 id 造一个稳定串，不让扫描整个瘫掉。 */
const keyOf = (uid: string | null, id: number): string => uid ?? `id:${id}`

interface Row {
  id: number
  uid: string | null
  term: string
  gloss: string
  layer: string
  createdAt: number
  recollected: number
  answers: number
  reviewLogs: number
}

export class Merge {
  private ledger: Ledger

  constructor(private db: Database) {
    this.ledger = new Ledger(db)
  }

  // ── 读：把一讲的知识点读成判据要的形状 ──────────────────────

  private itemsOf(lectureId: number): Row[] {
    return this.db
      .prepare(
        `select i.id, i.uid, i.term, i.gloss, i.layer, i.created_at as createdAt,
                i.recollected_count as recollected,
                (select count(*) from answers a where a.item_id = i.id) as answers,
                (select count(*) from review_logs r where r.item_id = i.id) as reviewLogs
           from items i
           join item_lectures il on il.item_id = i.id and il.deleted_at is null
          where il.lecture_id = ? and i.deleted_at is null
          order by i.id`
      )
      .all(lectureId) as Row[]
  }

  private blocksOf(ids: number[]): Map<number, { block: string; content: string }[]> {
    const out = new Map<number, { block: string; content: string }[]>()
    if (ids.length === 0) return out
    const rows = this.db
      .prepare(
        `select item_id as itemId, block, content from analysis_blocks
          where item_id in (${ids.map(() => '?').join(',')}) order by item_id, block`
      )
      .all(...ids) as { itemId: number; block: string; content: string }[]
    for (const r of rows) {
      const arr = out.get(r.itemId)
      if (arr) arr.push({ block: r.block, content: r.content })
      else out.set(r.itemId, [{ block: r.block, content: r.content }])
    }
    return out
  }

  /** 一条知识点在各张子表上现有的东西 —— 自然身份的键写成 `identity.ts` 那套形状 */
  private rowsOf(itemId: number): ItemRows {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get(itemId) as { n: number }).n

    return {
      lectures: (
        this.db
          .prepare(
            `select coalesce(l.uid, 'id:' || l.id) as k from item_lectures il
               join lectures l on l.id = il.lecture_id
              where il.item_id = ? and il.deleted_at is null order by k`
          )
          .all(itemId) as { k: string }[]
      ).map((r) => r.k),
      occurrences: (
        this.db
          .prepare(
            `select case when o.material_id is not null
                         then 'm|' || coalesce(m.uid, 'id:' || m.id)
                         else 'l|' || coalesce(lc.uid, 'id:' || lc.id) end as k
               from occurrences o
               left join materials m on m.id = o.material_id
               left join lectures lc on lc.id = o.lecture_id
              where o.item_id = ? order by k`
          )
          .all(itemId) as { k: string }[]
      ).map((r) => r.k),
      blocks: (
        this.db
          .prepare(`select block from analysis_blocks where item_id = ? order by block`)
          .all(itemId) as { block: string }[]
      ).map((r) => r.block),
      card:
        (this.db.prepare(`select count(*) as n from reading_cards where item_id = ?`).get(itemId) as {
          n: number
        }).n > 0,
      answers: one(`select count(*) as n from answers where item_id = ?`),
      reviewLogs: one(`select count(*) as n from review_logs where item_id = ?`),
      itemEvents: one(`select count(*) as n from item_events where item_id = ?`),
      questions: one(`select count(*) as n from questions where item_id = ?`),
      stateEvents: one(`select count(*) as n from state_events where item_id = ?`),
      derived: one(`select count(*) as n from items where derived_from = ?`),
      recollected: one(`select recollected_count as n from items where id = ?`)
    }
  }

  // ── 扫描 ────────────────────────────────────────────────────

  /**
   * 扫一讲。**只读**，一个字都不写 —— 他按下按钮先看见结果，再决定动不动手。
   */
  scan(lectureId: number): DedupReport {
    const rows = this.itemsOf(lectureId)
    const blocks = this.blocksOf(rows.map((r) => r.id))
    const byKey = new Map<string, Row>()
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
    const view = (uid: string): DedupReport['groups'][number]['members'][number] => {
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
   * ★ `one` 那一支也要**回到判据里核一遍**：他挑的两条必须真的在同一组重复里。
   *   界面传什么就并什么的话，一个拼错的 id 就能把两条毫不相干的知识点并掉。
   */
  merge(lectureId: number, pick: DedupPick): DedupMergeResult {
    const report = this.scan(lectureId)
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
      const wanted = new Set([pick.canonicalId, ...pick.loserIds])
      const group = report.groups.find((g) => g.members.some((m) => m.id === pick.canonicalId))
      if (!group) throw new Error('这一条已经不在任何一组重复里了 —— 先重新扫描。')
      const inGroup = new Set(group.members.map((m) => m.id))
      for (const id of wanted) {
        if (!inGroup.has(id)) throw new Error(`知识点 ${id} 不在这一组重复里，不能并。`)
      }
      jobs.push({ canonicalId: pick.canonicalId, loserIds: [...pick.loserIds] })
    }

    const moved: Record<string, number> = {}
    let merged = 0
    this.db.transaction(() => {
      for (const job of jobs) {
        for (const loserId of job.loserIds) {
          this.one(job.canonicalId, loserId, moved)
          merged++
        }
      }
    })()

    return { groups: jobs.length, merged, moved }
  }

  /** 并一条。**必须在事务里调用** —— 中途炸掉不许留下半并的状态。 */
  private one(canonicalId: number, loserId: number, moved: Record<string, number>): void {
    if (canonicalId === loserId) throw new Error('不能把一条知识点并到它自己身上。')
    const t = now()
    const c = this.rowsOf(canonicalId)
    const l = this.rowsOf(loserId)
    const plan = planMerge(String(canonicalId), String(loserId), c, l)
    const bump = (table: string, n = 1): void => {
      moved[table] = (moved[table] ?? 0) + n
    }

    for (const step of plan.steps) {
      if (step.kind === 'keep') continue

      if (step.kind === 'create') {
        // 自然身份：在 canonical 名下新建。uid 由触发器按自然键算，这里不许自己拼
        if (step.table === 'item_lectures') {
          this.db
            .prepare(
              `insert or ignore into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
                 select ?, il.lecture_id, 0, ?, ? from item_lectures il
                  where il.item_id = ? and il.deleted_at is null
                    and coalesce((select l.uid from lectures l where l.id = il.lecture_id), 'id:' || il.lecture_id) = ?`
            )
            .run(canonicalId, t, t, loserId, step.key)
          bump('item_lectures')
        } else if (step.table === 'occurrences') {
          this.db
            .prepare(
              `insert into occurrences (item_id, material_id, lecture_id, quote, para, created_at, updated_at)
                 select ?, o.material_id, o.lecture_id, o.quote, o.para, ?, ?
                   from occurrences o
                   left join materials m on m.id = o.material_id
                   left join lectures lc on lc.id = o.lecture_id
                  where o.item_id = ?
                    and case when o.material_id is not null
                             then 'm|' || coalesce(m.uid, 'id:' || m.id)
                             else 'l|' || coalesce(lc.uid, 'id:' || lc.id) end = ?
                  limit 1`
            )
            .run(canonicalId, t, t, loserId, step.key)
          bump('occurrences')
        } else if (step.table === 'analysis_blocks') {
          this.db
            .prepare(
              `insert into analysis_blocks (item_id, block, content, edited, regen_count, created_at, updated_at)
                 select ?, b.block, b.content, b.edited, b.regen_count, ?, ?
                   from analysis_blocks b where b.item_id = ? and b.block = ?`
            )
            .run(canonicalId, t, t, loserId, step.key)
          bump('analysis_blocks')
        } else if (step.table === 'reading_cards') {
          // 触发器保证每条知识点插入时就有一张卡，走到这里说明那张卡缺了 —— 补上
          this.db
            .prepare(
              `insert or ignore into reading_cards (item_id, created_at, updated_at) values (?, ?, ?)`
            )
            .run(canonicalId, t, t)
          bump('reading_cards')
        }
        continue
      }

      if (step.kind === 'repoint') {
        if (step.table === 'items.derived_from') {
          const r = this.db
            .prepare(`update items set derived_from = ?, updated_at = ? where derived_from = ?`)
            .run(canonicalId, t, loserId)
          bump('items.derived_from', r.changes)
        } else {
          /**
           * 表名来自判据里写死的那几个常量，不是外来输入 —— 拼进 SQL 是安全的。
           * 白名单再核一次，防的是将来有人往判据里加表却忘了这里。
           */
          const ok = ['answers', 'review_logs', 'item_events', 'questions', 'state_events']
          if (!ok.includes(step.table)) throw new Error(`合并计划里出现了没接线的表：${step.table}`)
          const r = this.db
            .prepare(`update ${step.table} set item_id = ?, updated_at = ? where item_id = ?`)
            .run(canonicalId, t, loserId)
          bump(step.table, r.changes)
        }
        continue
      }

      if (step.kind === 'add') {
        this.db
          .prepare(
            `update items set recollected_count = recollected_count + ?, updated_at = ? where id = ?`
          )
          .run(step.value, t, canonicalId)
        bump('recollected_count', step.value)
      }
    }

    /**
     * 被并那条软删进回收站。★ 只动 `items.deleted_at` ——
     * 不动 `item_lectures`（见文件头 ③），不记 `term_ledger`（见文件头 ①）。
     */
    this.db.prepare(`update items set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, loserId)

    const uid = (id: number): string =>
      ((this.db.prepare(`select uid from items where id = ?`).get(id) as { uid: string | null })
        ?.uid ?? null) ?? `id:${id}`
    const term = (
      this.db.prepare(`select term from items where id = ?`).get(canonicalId) as { term: string }
    ).term

    /** D-458 · 给出一个数就要能答是哪些：两条 uid + 每张表迁了什么 */
    this.ledger.op('merge', 'item', canonicalId, term, {
      canonical: uid(canonicalId),
      merged: uid(loserId),
      steps: plan.steps
    })
  }
}
