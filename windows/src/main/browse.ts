import type { Database } from 'better-sqlite3'
import { ALIVE, JOIN_CARD } from './db/reading-card-sql.ts'
import type { SearchResults, TrashBucket, TrashKind } from '@shared/api.ts'
import { hardDelete } from '@core/cascade.ts'
import { purgeMany as corePurgeMany, type PurgeLedger } from '@core/purge.ts'
import { PURGE_TABLES, TRASH_DAYS } from '@core/sql/trash.ts'
import { purgeAllowed } from '@core/purge-guard.ts'
import { decodeProblems, encodeProblems, SYNC_PROBLEM_KEY } from '@core/sync/problems.ts'
import { wrapDb } from './db/async-db.ts'
import { Ledger } from './db/ledger.ts'

const now = (): number => Date.now()


/**
 * 搜索 · 垃圾箱 · 项目页
 *
 * 这三样有个共同点：**它们都是「找回来」和「看全局」的入口**，
 * 而不是产生新数据的地方。放一个文件里。
 */
/**
 * ★ D-469（2026-09-07）· 这里原来有一个 `buildMatrix()`（4×4 状态矩阵，D-158 / D-169），
 * 项目页与单元页共用。那两页取消之后它没有调用方了 —— 同一张矩阵在综合知识库里
 * 由 `study/library.ts::matrix()` 自己算（那一处是**能点进去钻取**的那张，D-456b）。
 */

export class Browse {
  private ledger: Ledger
  constructor(private db: Database) {
    this.ledger = new Ledger(db)
  }

  // ── 搜索 · D-196 / D-106 ────────────────────────────────────

  /**
   * 「覆盖知识点（含静默库、攻坚区）+ 项目/单元/lecture/文件的名称 + 原文摘句。
   *  **不搜 AI 对话与解析正文** —— 机器生成的大量文本会淹没结果。」
   *
   * 这一条克制得有道理：解析正文每条几百字，搜「the」会把整个库倒出来。
   */
  search(qRaw: string): SearchResults {
    const q = qRaw.trim()
    if (!q) return { query: q, items: [], quotes: [], places: [], files: [] }
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`

    const items = this.db
      .prepare(
        `select i.id, i.term, i.gloss, i.layer, i.kind, i.production_state as productionState,
                i.silenced_by as silencedBy,
                rc.silent as cardSilent
           from items i ${JOIN_CARD('i')}
          where ${ALIVE('i')} and (i.term like ? escape '\\' or i.gloss like ? escape '\\')
          order by case when i.term like ? escape '\\' then 0 else 1 end, i.id
          limit 30`
      )
      .all(like, like, like)
      .map((r) => {
        const x = r as { cardSilent: number } & Record<string, unknown>
        return { ...x, cardSilent: x.cardSilent !== 0 }
      }) as SearchResults['items']

    // M-012 · 原文摘句是知识点的身份的一半，当然要能搜
    const quotes = this.db
      .prepare(
        `select o.item_id as itemId, i.term, o.quote, l.name as lecture
           from occurrences o join items i on i.id = o.item_id
           left join lectures l on l.id = o.lecture_id
          where i.deleted_at is null and o.quote like ? escape '\\'
          limit 20`
      )
      .all(like) as SearchResults['quotes']

    const places = [
      ...(this.db
        .prepare(
          `select id, name, 'project' as kind, null as parent from projects
            where deleted_at is null and name like ? escape '\\' limit 10`
        )
        .all(like) as SearchResults['places']),
      ...(this.db
        .prepare(
          `select u.id, u.name, 'unit' as kind, p.name as parent from units u
             join projects p on p.id = u.project_id
            where u.deleted_at is null and u.name like ? escape '\\' limit 10`
        )
        .all(like) as SearchResults['places']),
      ...(this.db
        .prepare(
          `select l.id, l.name, 'lecture' as kind, u.name as parent from lectures l
             join units u on u.id = l.unit_id
            where l.deleted_at is null and l.name like ? escape '\\' limit 15`
        )
        .all(like) as SearchResults['places'])
    ]

    const files = this.db
      .prepare(
        `select id, title from files where deleted_at is null and title like ? escape '\\' limit 10`
      )
      .all(like) as SearchResults['files']

    return { query: q, items, quotes, places, files }
  }

  // ── 垃圾箱 · D-087 / D-090 / D-034 ──────────────────────────

  /** 四类对象一视同仁：项目 / lecture / 知识点 / 文件。 */
  async trash(): Promise<TrashBucket[]> {
    const cutoff = now() - TRASH_DAYS * 86_400_000
    // 过期的先真删掉。屏上那句 `TRASH_PURGE_TEXT`（「N 天后彻底清除」）不是说说而已。
    await this.purgeExpired(cutoff)

    const q = <T>(sql: string): T[] => this.db.prepare(sql).all() as T[]
    return [
      {
        kind: 'project',
        label: '项目',
        rows: q(
          `select id, name as title, deleted_at as deletedAt from projects
            where deleted_at is not null order by deleted_at desc`
        )
      },
      {
        /**
         * 单元 · 使用者 4.3「垃圾箱支持『单元』整体删除」。
         *
         * 以前单元**被删得掉、却回不来** —— 删项目会把底下的单元一起标删，
         * 而垃圾箱里根本没有这一格。于是那些单元里的 lecture 就算单独恢复了，
         * 也因为上级还在已删状态而不出现在项目栏里。
         * 他报的「恢复 Lecture 时项目栏中不显示」，根子就在这儿。
         */
        kind: 'unit',
        label: '单元',
        rows: q(
          `select u.id, p.name || ' / ' || u.name as title, u.deleted_at as deletedAt
             from units u join projects p on p.id = u.project_id
            where u.deleted_at is not null order by u.deleted_at desc`
        )
      },
      {
        kind: 'lecture',
        label: 'lecture',
        rows: q(
          `select id, name as title, deleted_at as deletedAt from lectures
            where deleted_at is not null order by deleted_at desc`
        )
      },
      {
        kind: 'item',
        label: '知识点',
        rows: q(
          `select id, term as title, deleted_at as deletedAt from items
            where deleted_at is not null order by deleted_at desc limit 200`
        )
      },
      {
        kind: 'file',
        label: '文件',
        rows: q(
          `select id, title, deleted_at as deletedAt from files
            where deleted_at is not null order by deleted_at desc`
        )
      },
      {
        /**
         * 材料（原文 / 我的收集）· 使用者 2026-08-10
         * 「在 lecture 中和在文件学习中上传的文件可以删除（用小 × 表示）」。
         *
         * 删掉的是**这份材料**，不是从它里面提出来的知识点 ——
         * 那些是他学到的东西，和材料的去留无关。
         * 所以走垃圾箱而不是真删：贴错一份想撤掉是常事，
         * 而「撤掉」不该顺带把已经学的东西一起带走。
         */
        kind: 'material',
        label: '材料',
        rows: q(
          `select m.id, l.name || ' / ' || m.title as title, m.deleted_at as deletedAt
             from materials m left join lectures l on l.id = m.lecture_id
            where m.deleted_at is not null order by m.deleted_at desc`
        )
      }
    ]
  }

  /**
   * 保留期到期，真删 —— 天数只有 `TRASH_DAYS` 一个出处（I-202）。
   *
   * 顺序和级联都交给 `hardDelete` —— 以前是一张表一张表 `delete`，
   * 子表还引用着父行，`foreign_keys = ON` 当场抛错。
   * 更糟的是这个函数在 `trash()` 一开头就跑：**打开垃圾箱本身就会报错**。
   * 从子往父删（items → lectures → units → projects），每一级都连着自己的引用一起。
   */
  /**
   * ★★ F-015（2026-09-01）· **动手之前先问一句本机时钟对不对。**
   *
   * 硬删会立墓碑，墓碑推给另一端之后不可撤销 —— 这是系统里少数几个
   * 真正让数据永久消失的动作，而它此前只信 `Date.now()`。
   * 判据在 `@core/purge-guard.ts`（两端同一份），参照是同步时见过的
   * 最大远端时间戳（`sync.maxRemoteSeen`，由引擎落盘）。
   *
   * ★ 拒绝的后果只是「这次没清」，东西一样不少 —— 安全的方向是不删。
   */
  private clockOkForPurge(): boolean {
    const row = this.db
      .prepare(`select value from settings where key = 'sync.maxRemoteSeen'`)
      .get() as { value?: string } | undefined
    const v = purgeAllowed({ now: now(), maxRemoteSeen: Number(row?.value ?? 0) || 0 })
    if (v.ok) return true
    this.noteProblem('回收站清理', v.why!)
    return false
  }

  /** 留痕不弹窗（同 R-4-D）—— 合并进已有的那份，别把同步记的账冲掉 */
  private noteProblem(what: string, message: string): void {
    try {
      const row = this.db
        .prepare(`select value from settings where key = ?`)
        .get(SYNC_PROBLEM_KEY) as { value?: string } | undefined
      const had = decodeProblems(row?.value)?.problems ?? []
      const value = encodeProblems([{ kind: 'row', what, message }, ...had])
      if (value === null) return
      this.db
        .prepare(
          `insert into settings (key, value, updated_at) values (?, ?, ?)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(SYNC_PROBLEM_KEY, value, now())
    } catch {
      /* 记不上账是小事，把打开垃圾箱这个动作带崩是大事 */
    }
  }

  private async purgeExpired(cutoff: number): Promise<void> {
    if (!this.clockOkForPurge()) return
    /**
     * ★ 级联判据搬去了 `@core/cascade.ts`（同步引擎的墓碑执行也走它 ——
     * 只能有一份）。包装的 await 都是已解决的 Promise，事务仍是原子块。
     */
    const adb = wrapDb(this.db)
    this.db.prepare('begin').run()
    try {
      const refs = undefined
      // ★ 清单已上提 @core/sql/trash.ts（F-017）—— 两端对「什么该被彻底
      // 删掉」的理解必须一致：这一步会写墓碑，而墓碑推出去不可撤销。
      for (const t of PURGE_TABLES) {
        const cols = this.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]
        if (!cols.some((c) => c.name === 'deleted_at')) continue
        const rows = this.db
          .prepare(`select id from "${t}" where deleted_at is not null and deleted_at < ?`)
          .all(cutoff) as { id: number }[]
        if (rows.length === 0) continue
        await hardDelete(adb, t, rows.map((r) => r.id), refs)
      }
      this.db.prepare('commit').run()
    } catch (e) {
      this.db.prepare('rollback').run()
      throw e
    }
  }

  /**
   * 恢复 · D-090 + 使用者 4.3
   *
   * 他给的规则是逐条写死的，照抄在这里，因为每一条都对应一种曾经出过的错：
   *
   * | 恢复 | 一起恢复 | 不恢复 |
   * |---|---|---|
   * | **lecture** | 它的**完整上级路径**（所属项目 + 所属单元）、跟它一起删掉的知识点 | 同一单元下别的 lecture |
   * | **单元** | 上级项目、**这个单元里的所有 lecture** | 别的已删单元 |
   * | **项目** | 它下面所有单元和 lecture | —— |
   *
   * 「恢复上级路径」是他点名的 bug：先删 lecture、再删项目，
   * 之后单独恢复 lecture —— 项目栏里看不见它。因为项目栏只列
   * `deleted_at is null` 的项目和单元，路径断在上游，
   * 而恢复出来的 lecture 挂在一个仍然「已删除」的单元下面。
   * 东西回来了、人看不见，**比没恢复更糟**：他会以为数据丢了。
   *
   * 反过来，「不把别的东西一起拽回来」同样要紧 ——
   * 恢复上级是为了让这一条**看得见**，不是把整个项目倒回去。
   */
  restore(kind: TrashKind, id: number): number {
    const t = now()
    let n = 0
    const tx = this.db.transaction(() => {
      const table = {
        project: 'projects',
        unit: 'units',
        lecture: 'lectures',
        item: 'items',
        file: 'files',
        material: 'materials'
      }[kind]
      const del = this.db.prepare(`select deleted_at as d from "${table}" where id = ?`).get(id) as
        | { d: number | null }
        | undefined
      const undelete = (tb: string, rowId: number): number =>
        this.db
          .prepare(`update "${tb}" set deleted_at = null, updated_at = ? where id = ? and deleted_at is not null`)
          .run(t, rowId).changes

      undelete(table, id)
      n = 1

      /** 上级路径：一路往上，把还在「已删」状态的祖先放出来 */
      const restorePathOfUnit = (unitId: number): void => {
        const u = this.db.prepare(`select project_id as p from units where id = ?`).get(unitId) as
          | { p: number }
          | undefined
        if (!u) return
        n += undelete('units', unitId)
        n += undelete('projects', u.p)
      }

      if (kind === 'lecture') {
        const l = this.db.prepare(`select unit_id as u from lectures where id = ?`).get(id) as
          | { u: number }
          | undefined
        if (l) restorePathOfUnit(l.u)

        if (del?.d) {
          // 只恢复「跟它一起被删掉的」那些知识点（时间戳相近），
          // 不要把更早独立删掉的也拽回来 —— 那是他单独做过的决定
          const r = this.db
            .prepare(
              `update items set deleted_at = null, updated_at = ?
                where deleted_at is not null and abs(deleted_at - ?) < 2000
                  and id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`
            )
            .run(t, del.d, id)
          n += r.changes
        }
      }

      if (kind === 'unit') {
        restorePathOfUnit(id)
        // 「恢复该单元内所有 Lecture」—— 他写得很明确，不看时间戳
        const ls = this.db
          .prepare(`select id, deleted_at as d from lectures where unit_id = ? and deleted_at is not null`)
          .all(id) as { id: number; d: number }[]
        for (const l of ls) {
          n += undelete('lectures', l.id)
          const r = this.db
            .prepare(
              `update items set deleted_at = null, updated_at = ?
                where deleted_at is not null and abs(deleted_at - ?) < 2000
                  and id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`
            )
            .run(t, l.d, l.id)
          n += r.changes
        }
      }

      if (kind === 'project') {
        // 「连同其下所有单元和 Lecture 一起恢复」
        const us = this.db
          .prepare(`select id from units where project_id = ? and deleted_at is not null`)
          .all(id) as { id: number }[]
        for (const u of us) n += undelete('units', u.id)
        const ls = this.db
          .prepare(
            `select l.id, l.deleted_at as d from lectures l join units u on u.id = l.unit_id
              where u.project_id = ? and l.deleted_at is not null`
          )
          .all(id) as { id: number; d: number }[]
        for (const l of ls) {
          n += undelete('lectures', l.id)
          const r = this.db
            .prepare(
              `update items set deleted_at = null, updated_at = ?
                where deleted_at is not null and abs(deleted_at - ?) < 2000
                  and id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`
            )
            .run(t, l.d, l.id)
          n += r.changes
        }
      }

      /**
       * 账本要跟着改口 · 4.1
       * 他把东西捡回来了，那条「以后别再收」的记录就得撤掉 ——
       * 不撤的话，这条表达从此再也分析不进来，而他完全看不出为什么。
       *
       * ★★ N-2-b · **只撤 `deleted` 这一种**，以前是不带 verdict 的全撤。
       *
       * 账本里三种判定表达三件**不同的事**：
       *   `deleted`  我不要这个说法        ← 从垃圾箱捡回来，正是在收回这句话
       *   `silenced` 我已经会了，别再排它  ← 和「删了又捡回来」毫无关系
       *   `purged`   我彻底删掉了它
       *
       * 全撤的后果：他先静默一条（我会了）、后来又删了它、再从垃圾箱恢复 ——
       * 那条「我已经会了」被一次不相干的恢复擦掉，于是它重新排进轮转，
       * 而他只会觉得「静默怎么又失效了」。这正是这个项目里最贵的那种病：
       * 一个动作顺手改掉了另一件事的事实，不报错，也没人查得到。
       */
      const terms = this.termsUnder(kind, id)
      if (terms.length > 0) this.ledger.forgetMany(terms, 'deleted')
      this.ledger.op('restore', kind, id, terms[0] ?? null, { restored: n })
    })
    tx()
    return n
  }

  /** 这个对象下面涉及哪些知识点 id */
  /**
   * ★ `itemIdsUnder` 已随 `purgeMany` 一起上提 `@core/purge.ts`（2026-09-01）——
   *   本文件里那个唯一调用点没有了，留一份「没人调的私有方法」只会让下一个人
   *   以为它还管着什么。`termsUnder` 留着：`restore` 那条路还在用它。
   */
  /** 这个对象下面涉及哪些表达 —— 记账和撤账都要用同一份名单 */
  private termsUnder(kind: TrashKind, id: number): string[] {
    /**
     * ★ I-119 · `material` 必须在这里返回空，和 `file` 一样。
     *
     * 漏掉它的后果不是「少记一笔」，是**记错人**：
     * 下面那个三元表达式没有 material 分支，会掉进最后一档 `l.id = ?`，
     * 于是**拿材料的 id 当 lecture 的 id** 去查表达 ——
     * 彻底删除 3 号材料，会把 3 号 lecture 里所有表达写进「不再收录」名单，
     * 从此分析到它们全部自动跳过，**而他完全看不出为什么**。
     *
     * 材料是来源，不是表达的容器。删材料不牵连任何知识点（`itemIdsUnder` 同理）。
     */
    if (kind === 'file' || kind === 'material') return []
    if (kind === 'item') {
      const r = this.db.prepare(`select term from items where id = ?`).get(id) as
        | { term: string }
        | undefined
      return r ? [r.term] : []
    }
    const where =
      kind === 'project'
        ? `u.project_id = ?`
        : kind === 'unit'
          ? `u.id = ?`
          : `l.id = ?`
    return (
      this.db
        .prepare(
          `select distinct i.term from items i
             join item_lectures il on il.item_id = i.id and il.deleted_at is null
             join lectures l on l.id = il.lecture_id
             join units u on u.id = l.unit_id
            where ${where}`
        )
        .all(id) as { term: string }[]
    ).map((x) => x.term)
  }

  /**
   * 批量恢复 · I-075
   * 使用者：「垃圾箱里的东西要能勾选、能一起处理。」
   * 一条一条走 `restore`，因为 lecture / 项目的连带恢复规则在里面，不能绕过。
   */
  restoreMany(picks: { kind: TrashKind; id: number }[]): number {
    let n = 0
    for (const p of picks) {
      // 逐条各自成事务 —— 中间某条失败（比如已经被保留期规则清掉了）不该拖垮其余的
      try {
        this.restore(p.kind, p.id)
        n++
      } catch {
        /* 这一条恢复不了就跳过，返回值会少一个，界面照实说 */
      }
    }
    return n
  }

  /**
   * 立刻彻底删除 · I-075
   *
   * ★★ **编排已上提 `@core/purge.ts`（2026-09-01）** —— 两端唯一一份。
   * 这是整个应用里最不可逆的操作（真删行 + 写墓碑，墓碑随同步走到另一台机器
   * 让它照着删）。两端各写一份的后果不是样式不一致，是**两台机器对
   * 「什么该被永久删掉」的理解不同**。core 那份文件头写着两条学费很贵的规矩
   * （D-091 只删独占的 · I-119 材料与文件不牵连知识点）。
   *
   * 这里只剩三件平台的事：事务、ledger 适配、包一层 async Db。
   */
  async purgeMany(picks: { kind: TrashKind; id: number }[]): Promise<number> {
    const adb = wrapDb(this.db)
    const ledger: PurgeLedger = {
      op: async (name, target, id, note, counted) => {
        this.ledger.op(name, target, id, note, counted)
      },
      noteMany: async (terms, verdict, meta) => {
        this.ledger.noteMany(terms, verdict, meta)
      }
    }
    this.db.prepare('begin').run()
    try {
      const n = await corePurgeMany(adb, picks, ledger)
      this.db.prepare('commit').run()
      return n
    } catch (e) {
      this.db.prepare('rollback').run()
      throw e
    }
  }

  /**
   * 删除 lecture · D-091
   * 「只删它**独占**的知识点；被其他 lecture 引用的不删，
   *  归属自动转给下一个用到它的 lecture。」
   * 否则删一个旧 lecture 会把新 lecture 掏空。
   */
  deleteLecture(lectureId: number): { items: number; moved: number } {
    const t = now()
    let items = 0
    let moved = 0
    const tx = this.db.transaction(() => {
      const owned = this.db
        .prepare(
          `select item_id as id from item_lectures where lecture_id = ? and is_owner = 1`
        )
        .all(lectureId) as { id: number }[]

      for (const { id } of owned) {
        const other = this.db
          .prepare(
            `select lecture_id as l from item_lectures
              where item_id = ? and lecture_id != ? order by lecture_id limit 1`
          )
          .get(id, lectureId) as { l: number } | undefined
        if (other) {
          // 归属转给下一个用到它的 lecture
          this.db
            .prepare(`update items set owner_lecture_id = ?, updated_at = ? where id = ?`)
            .run(other.l, t, id)
          this.db
            .prepare(`update item_lectures set is_owner = 1, updated_at = ? where item_id = ? and lecture_id = ?`)
            .run(t, id, other.l)
          moved += 1
        } else {
          this.db.prepare(`update items set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, id)
          items += 1
        }
      }
      this.db.prepare(`update lectures set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, lectureId)
    })
    tx()
    return { items, moved }
  }

  /**
   * ★ D-469（2026-09-07）· `project()` / `unit()` 两个方法删了 ——
   * 项目主页与单元主页取消（使用者：「项目主页 / 单元主页都取消」）。
   * 它们算的是「按单元分组的 lecture 列表 + 4×4 知识分布矩阵 + 钻取」：
   * 前者侧边栏那棵树本来就在列，后者与综合知识库里那张矩阵是同一张。
   * 留着算而没有页面消费，就是每点一次树白跑一遍全表扫描。
   * ★ 下面那个「项目总览」（D-462 / D-464）是另一屏，**不受影响**。
   */

  /**
   * ★ D-475（2026-09-08）· 「项目」总览那一屏整个取消（使用者裁 D-R7 = 3；
   * D-462 ～ D-465 一并作废），给它取数的那个方法跟着删 —— 它是那一屏唯一的取数口。
   * 静默进度那套判据（`IS_SILENT` + `rollupLecture`）在别处照旧用着。
   */
}
