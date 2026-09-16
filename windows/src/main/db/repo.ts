import type { Database } from 'better-sqlite3'
import { findQuoteIn } from '@core/quote.ts'
import { normalizeTerm } from '@core/normalize-term.ts'
import { isRowSilent } from '@core/silence.ts'
import type { ProductionState } from '@core/types.ts'
import { occurrenceUid } from './identity.ts'
import { promoteOutOfEmpty } from './lecture-status.ts'
import type {
  ChunkResult,
  LectureDetail,
  ItemRow,
  MaterialRow,
  PresetRow,
  TreeProject
} from '@shared/api.ts'
import { now as clockNow } from '../clock.ts'
import { ALIVE, JOIN_CARD } from './reading-card-sql.ts'
import { TREE_LECTURES, TREE_PROJECTS, TREE_UNITS } from '@core/sql/tree.ts'

/**
 * ★ Step 7D · 本地写入的时间源走 `clock.ts`。
 *   生产默认真实系统时间；只有非打包 + 显式环境变量时测试才注入得进来。
 */
const now = (): number => clockNow()

/**
 * 用于查重的规范化：大小写、首尾空白、行尾标点不算差异（D-026）。
 *
 * ★ 正文 2026-09-05 上提到 `@core/normalize-term.ts`（T-2.11）—— 判据不在平台层（D-238），
 *   而 `core/dedup/plan.ts` 要按同一把尺分组。这里原样 re-export，
 *   `analyze.ts` / `study.ts` 的 `import { normalizeTerm } from './db/repo.ts'` 一处不用改。
 *   **不要在别处再写一份**：两份尺子的分歧不报错，只是悄悄漏掉重复。
 */
export { normalizeTerm }

export class Repo {
  constructor(private db: Database) {}

  // ── 三层结构 ────────────────────────────────────────────────

  /**
   * F-01 · 先贴，贴完再问归属。
   * 三级任何一级不存在都能就地新建，全部留空就用默认名 —— 不许「先建三层才能贴东西」。
   */
  ensurePath(projectName?: string, unitName?: string, lectureName?: string): number {
    const t = now()
    const pn = projectName?.trim() || '未命名项目'
    const un = unitName?.trim() || '第一单元'

    let project = this.db
      .prepare(`select id from projects where name = ? and deleted_at is null`)
      .get(pn) as { id: number } | undefined
    if (!project) {
      const r = this.db
        .prepare(`insert into projects (name, created_at, updated_at) values (?, ?, ?)`)
        .run(pn, t, t)
      project = { id: Number(r.lastInsertRowid) }
    }

    let unit = this.db
      .prepare(`select id from units where project_id = ? and name = ? and deleted_at is null`)
      .get(project.id, un) as { id: number } | undefined
    if (!unit) {
      const r = this.db
        .prepare(`insert into units (project_id, name, created_at, updated_at) values (?, ?, ?, ?)`)
        .run(project.id, un, t, t)
      unit = { id: Number(r.lastInsertRowid) }
    }

    const count = (
      this.db
        .prepare(`select count(*) as n from lectures where unit_id = ? and deleted_at is null`)
        .get(unit.id) as { n: number }
    ).n
    const ln = lectureName?.trim() || `L${count + 1}`

    const existing = this.db
      .prepare(`select id from lectures where unit_id = ? and name = ? and deleted_at is null`)
      .get(unit.id, ln) as { id: number } | undefined
    if (existing) return existing.id

    const r = this.db
      .prepare(
        `insert into lectures (unit_id, name, number, created_at, updated_at)
         values (?, ?, ?, ?, ?)`
      )
      .run(unit.id, ln, count + 1, t, t)
    return Number(r.lastInsertRowid)
  }

  /**
   * 项目栏 · 使用者 4.2
   *
   * 静默的三级**不出现在这里** ——「整个项目从正常视图消失，只出现在静默知识库」。
   * 放出来的入口在静默知识库那一页（`silentTree()`）。
   * 藏起来却没有出口，就是个陷阱：他会以为项目被删了。
   */
  /**
   * ★ 三句 SQL 已上提 `@core/sql/tree.ts`（F-017 · 2026-09-01）——
   * 手机端要显示同一棵树，「哪些看得见、按什么排」就必须是同一套规则。
   * 上提之前 Android `src/db/tree.ts` 是逐字抄的第二份。
   */
  tree(): TreeProject[] {
    const projects = this.db.prepare(TREE_PROJECTS).all() as {
      id: number
      name: string
      color: string
      pinned: number
    }[]

    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      pinned: !!p.pinned,
      units: (this.db.prepare(TREE_UNITS).all(p.id) as { id: number; name: string }[]).map((u) => ({
        id: u.id,
        name: u.name,
        lectures: this.db.prepare(TREE_LECTURES).all(u.id) as LectureDetail['lecture'][]
      }))
    }))
  }

  /**
   * 静默知识库里的「结构」那一半 · 4.2
   *
   * 项目 / 单元 / lecture 被静默之后从项目栏消失了，**必须有地方看得见它们**，
   * 而且必须能放回来。只藏不放是陷阱，他会以为东西被删了。
   *
   * 返回的是「因为自己被静默」的那一级：项目静默时不再逐条列出底下的单元，
   * 否则一个项目会在这一页上炸出几十行。
   */
  silentTree(): { kind: 'project' | 'unit' | 'lecture'; id: number; name: string; path: string }[] {
    const out: { kind: 'project' | 'unit' | 'lecture'; id: number; name: string; path: string }[] = []
    for (const p of this.db
      .prepare(`select id, name from projects where deleted_at is null and silent = 1 order by name`)
      .all() as { id: number; name: string }[]) {
      out.push({ kind: 'project', id: p.id, name: p.name, path: p.name })
    }
    for (const u of this.db
      .prepare(
        `select u.id, u.name, p.name as pname from units u join projects p on p.id = u.project_id
          where u.deleted_at is null and u.silent = 1 and p.silent = 0 order by p.name, u.name`
      )
      .all() as { id: number; name: string; pname: string }[]) {
      out.push({ kind: 'unit', id: u.id, name: u.name, path: `${u.pname} / ${u.name}` })
    }
    for (const l of this.db
      .prepare(
        `select l.id, l.name, u.name as uname, p.name as pname
           from lectures l join units u on u.id = l.unit_id join projects p on p.id = u.project_id
          where l.deleted_at is null and l.silent = 1 and u.silent = 0 and p.silent = 0
          order by p.name, u.name, l.name`
      )
      .all() as { id: number; name: string; uname: string; pname: string }[]) {
      out.push({
        kind: 'lecture',
        id: l.id,
        name: l.name,
        path: `${l.pname} / ${l.uname} / ${l.name}`
      })
    }
    return out
  }

  // ── 讲次工作台 ──────────────────────────────────────────────

  lecture(lectureId: number): LectureDetail {
    const lecture = this.db
      .prepare(
        `select l.id, l.name,
                case when l.silent = 1 then 'silent' else l.status end as status,
                l.due_at as dueAt, u.name as unitName, p.name as projectName,
                (select count(*) from item_lectures il
                   join items i on i.id = il.item_id and il.deleted_at is null
                  where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null) as itemCount
           from lectures l join units u on u.id = l.unit_id join projects p on p.id = u.project_id
          where l.id = ?`
      )
      .get(lectureId) as LectureDetail['lecture'] | undefined

    if (!lecture) throw new Error(`找不到这个 Lecture（id=${lectureId}）`)

    return {
      lecture,
      materials: this.db
        .prepare(
          `select id, kind, title, origin, char_count as charCount, analyzed_at as analyzedAt
             from materials where lecture_id = ? and deleted_at is null order by id`
        )
        .all(lectureId) as MaterialRow[],
      items: this.items(lectureId)
    }
  }

  items(lectureId: number): ItemRow[] {
    return this.db
      .prepare(
        `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer, i.kind, i.source,
                i.confidence, i.recollected_count as recollected,
                i.production_state as productionState, i.streak, i.attempts, i.corrects,
                i.silenced_by as silencedBy,
                rc.silent as cardSilent, i.derived_from as derivedFrom,
                (select count(*) from items d
                  where d.derived_from = i.id and d.deleted_at is null) as derivedCount,
                (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
                /* 6.2 · 分析判定「打错了 / 听岔了，需要修改」—— 列表上要有个记号。
                   改完之后 acceptSuspect 会把这一条从区块里去掉，
                   区块空了就整块删掉，于是记号自己消失，不需要另设一个「已处理」位。 */
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.block = 'suspect') as hasSuspect
           from items i join item_lectures il on il.item_id = i.id and il.deleted_at is null ${JOIN_CARD('i')}
          where il.lecture_id = ? and ${ALIVE('i')}
          order by i.confidence asc, i.id asc`
      )
      .all(lectureId)
      .map((r) => {
        // SQLite 没有布尔类型，存的是 0/1，转成 boolean 再交给界面。
        const row = r as Omit<ItemRow, 'cardSilent' | 'hasSuspect'> & {
          cardSilent: number
          hasSuspect: number
        }
        return { ...row, cardSilent: row.cardSilent !== 0, hasSuspect: row.hasSuspect !== 0 }
      })
  }

  // ── 落区① · 原文材料 ────────────────────────────────────────

  addOriginal(
    lectureId: number,
    title: string,
    content: string,
    origin = 'paste'
  ): { materialId: number; count: number } {
    const t = now()
    const count = (
      this.db
        .prepare(
          `select count(*) as n from materials
            where lecture_id = ? and kind = 'original' and deleted_at is null`
        )
        .get(lectureId) as { n: number }
    ).n

    /**
     * D-063 的「单讲最多 5 份材料」**已由使用者取消**（I-041，2026-08-04 确认）。
     *
     * 原来的理由是一次分析的成本与注意力范围。但每份材料本来就是**独立分析**的
     * （D-063 修订自己就是这么定的），所以份数多不会撑爆上下文，只是钱多一点 ——
     * 而那是使用者自己的判断。计数留着，只用来在界面上提示，不再拦人。
     */
    if (!content.trim()) throw new Error('材料是空的，没有可分析的内容。')

    const r = this.db
      .prepare(
        `insert into materials (lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
         values (?, 'original', ?, ?, ?, ?, ?, ?)`
      )
      .run(lectureId, title.trim() || '粘贴的文本', origin, content, content.length, t, t)

    this.touchLecture(lectureId, 'material_added', `原文《${title}》· ${content.length} 字`)
    // ★ I-114 · 原文到了，把这一讲里先前欠着出处的补上（他常常是先贴收集、后传原文）
    backfillQuotes(this.db, lectureId)
    return { materialId: Number(r.lastInsertRowid), count: count + 1 }
  }

  // ── 落区② · 我自己整理的 chunk ──────────────────────────────

  /**
   * D-006 / D-016 / D-064 / M-015
   *
   * 「整句原样入库，**禁止拆分与改写**」。这条路**整条不需要 AI** ——
   * 它是使用者自己挑好的表达，AI 没有插手的余地。
   *
   * 「不去重」的准确含义是**不合并、不丢弃**；但 D-026 要求**检测并提示** ——
   * 手动收集一条已在库中的表达，意味着上一次「学会」是假的，
   * 这是脱离测试环境、在真实阅读中自然暴露的证据，**比测试成绩更硬**（M-030）。
   */
  /**
   * 逐条手动输入 · D-064 第三个入口
   *
   * 「chunk 的三个入口：上传文件 / 整段粘贴按行拆分 / **逐条手动输入**」。
   * 和整段粘贴的区别：这一条是**自己判层**的 —— 你打算拿它来写，就选主动词汇。
   *
   * M-012 说「知识点入库**必须携带原文出处**」。手打的这一条本来就没有出处，
   * 所以出处是**可填的**，而且填不填在界面上看得见 ——
   * 不能假装有，也不能因为没有就不让加（D-064 明说这个入口存在）。
   */
  addItem(
    lectureId: number,
    term: string,
    gloss: string,
    layer: 'A' | 'B',
    quote?: string
  ): { id: number; layer: 'A' | 'B'; duplicateOf: number | null } {
    const t = now()
    const clean = term.trim()
    if (!clean) throw new Error('还没写要加什么。')

    // D-026 · 已经在库里的表达再收一次，是有意义的信号，不能悄悄合并
    const prior = this.db
      .prepare(
        `select id from items where deleted_at is null and lower(trim(term)) = ? limit 1`
      )
      .get(normalizeTerm(clean)) as { id: number } | undefined

    /**
     * 6.3 · 这条表达**在这一讲里**是不是已经收过了。
     * 收过 → 这次不是「重复收集」，是同一讲里的重复操作，计数不动。
     * 判断要在插入新行**之前**做，插完就分不清了。
     */
    const hadBefore =
      prior !== undefined &&
      this.db
        .prepare(`select 1 as x from item_lectures where item_id = ? and lecture_id = ? and deleted_at is null`)
        .get(prior.id, lectureId) !== undefined

    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `insert into items (term, gloss, layer, kind, source, owner_lecture_id, confidence, created_at, updated_at)
           values (?, ?, ?, 'chunk', 'self', ?, 1.0, ?, ?)`
        )
        .run(clean, gloss.trim(), layer, lectureId, t, t)
      const id = Number(r.lastInsertRowid)

      this.db
        .prepare(
          `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
           values (?, ?, 1, ?, ?)
           on conflict(item_id, lecture_id) do update set
             deleted_at = null, updated_at = excluded.updated_at
           where item_lectures.deleted_at is not null`
        )
        .run(id, lectureId, t, t)

      /**
       * ★ I-107 · 手动加 / 右键收进，出处同样要回原文里定位。
       *
       * 右键收进以前传的是「选中的那段文字」本身 —— 于是出处等于词条，
       * 认读卡挖空挖不出来。现在先去这一讲的原文（含挂上来的文件学习文章）里找整句；
       * 找不到，就看选中的那段是不是真的出现在原文里；都不成立就不写。
       */
      // trusted：手动加和右键收进，出处是**他自己**给的 —— 找不到更好的整句就照存
      this.recordOccurrence(id, lectureId, clean, { fallback: quote ?? null, trusted: true })

      // 6.3 · 只有在**别的 lecture** 里再次遇到才算重复收集。
      // 同一讲里重复收进多半是误操作，不该污染这个计数。
      if (prior && !hadBefore) {
        this.db
          .prepare(
            `update items set recollected_count = recollected_count + 1, updated_at = ? where id = ?`
          )
          .run(t, prior.id)
      }

      // ★ N-1 · 同上：手动加 / 右键收进 / 词条详情新增，也都产生了内容
      promoteOutOfEmpty(this.db, lectureId)

      return { id, layer, duplicateOf: prior?.id ?? null }
    })()
  }

  /**
   * 三层的增 / 改 / 删 · I-032 / I-033 / I-034
   *
   * 以前只有 `ensurePath`（贴东西时顺手建三层）。使用者要的是**主动建**：
   * 侧边栏的「＋」、每一级的「•••」。而且「不止一个入口」——
   * 所以这几个方法被侧边栏、项目页、单元页共用。
   *
   * **数量不设上限**（I-041）：项目、单元、lecture、条目都不限个数。
   */
  createProject(name?: string): number {
    const t = now()
    const n = name?.trim() || `新项目 ${new Date().toLocaleDateString('zh-CN')}`
    const r = this.db
      .prepare(`insert into projects (name, created_at, updated_at) values (?, ?, ?)`)
      .run(n, t, t)
    return Number(r.lastInsertRowid)
  }

  createUnit(projectId: number, name?: string): number {
    const t = now()
    const n =
      name?.trim() ||
      `第 ${
        (
          this.db
            .prepare(`select count(*) as c from units where project_id = ? and deleted_at is null`)
            .get(projectId) as { c: number }
        ).c + 1
      } 单元`
    const r = this.db
      .prepare(`insert into units (project_id, name, created_at, updated_at) values (?, ?, ?, ?)`)
      .run(projectId, n, t, t)
    return Number(r.lastInsertRowid)
  }

  createLecture(unitId: number, name?: string): number {
    const t = now()
    const count = (
      this.db
        .prepare(`select count(*) as c from lectures where unit_id = ? and deleted_at is null`)
        .get(unitId) as { c: number }
    ).c
    const n = name?.trim() || `L${count + 1}`
    const r = this.db
      .prepare(
        `insert into lectures (unit_id, name, number, status, created_at, updated_at)
         values (?, ?, ?, 'empty', ?, ?)`
      )
      .run(unitId, n, count + 1, t, t)
    return Number(r.lastInsertRowid)
  }

  /** 改名。派生显示全部走同一份数据，所以改完到处都跟着变（D-185）。 */
  renameLecture(lectureId: number, name: string): void {
    this.rename('lectures', lectureId, name)
  }

  rename(table: 'projects' | 'units' | 'lectures', id: number, name: string): void {
    const clean = name.trim()
    if (!clean) throw new Error('名字不能是空的。')
    this.db
      .prepare(`update "${table}" set name = ?, updated_at = ? where id = ?`)
      .run(clean, now(), id)
  }

  /**
   * 软删一整级。D-087 · 进回收站保留期内可恢复（`TRASH_DAYS`），**不真删**。
   * 下面几级跟着一起标 —— 恢复的时候一起回来。
   */
  /**
   * 删一份材料（使用者 2026-08-10：「上传的文件可以删除（用小 × 表示）」）。
   *
   * **软删，进垃圾箱** —— 贴错一份想撤掉是常事，而「撤掉」不该把
   * 已经从它里面学到的知识点一起带走：材料是来源，知识点是他学到的东西。
   * 所以这里只标这一行，`items` 和 `occurrences` 一个字不动。
   */
  deleteMaterial(id: number): void {
    const t = now()
    const m = this.db
      .prepare(`select lecture_id as lectureId, title from materials where id = ?`)
      .get(id) as { lectureId: number; title: string } | undefined
    this.db
      .prepare(`update materials set deleted_at = ?, updated_at = ? where id = ?`)
      .run(t, t, id)
    if (m) this.touchLecture(m.lectureId, 'material_deleted', `删掉了《${m.title}》`)
  }

  softDelete(kind: 'project' | 'unit', id: number): { lectures: number } {
    const t = now()
    return this.db.transaction(() => {
      const lectureIds =
        kind === 'project'
          ? (this.db
              .prepare(
                `select l.id from lectures l join units u on u.id = l.unit_id
                  where u.project_id = ? and l.deleted_at is null`
              )
              .all(id) as { id: number }[])
          : (this.db
              .prepare(`select id from lectures where unit_id = ? and deleted_at is null`)
              .all(id) as { id: number }[])

      for (const l of lectureIds) {
        this.db.prepare(`update lectures set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, l.id)
      }
      if (kind === 'project') {
        this.db
          .prepare(`update units set deleted_at = ?, updated_at = ? where project_id = ?`)
          .run(t, t, id)
        this.db.prepare(`update projects set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, id)
      } else {
        this.db.prepare(`update units set deleted_at = ?, updated_at = ? where id = ?`).run(t, t, id)
      }
      return { lectures: lectureIds.length }
    })()
  }

  /**
   * 三级菜单的动作 · I-047
   *
   * 使用者给的参考是 Pin / Mark as unread / Rename / Fork / Move to group /
   * Archive / Delete，并说「可以根据项目的不同改动」。按 Nyx 的语义对了一遍：
   *
   * | 参考          | Nyx 里是什么 | 哪一级有 |
   * |---|---|---|
   * | Pin           | 置顶         | 项目（`pinned` 列本来就有） |
   * | Archive       | **静默** —— 不再排期轮转，进度一个字不动 | 三级都有 |
   * | Mark as unread| **打回待审阅** —— 重新过一遍这一批 | lecture |
   * | Move to group | 移到别的父级 | 单元 → 项目 · lecture → 单元 |
   * | Fork          | **复制材料另起一讲** —— 换个指令重新拆一遍 | lecture |
   * | Rename/Delete | 已有 | 三级 |
   *
   * 另加两样他点名要的：**导出**（这一支的可读笔记）和**测试**（认读 / 产出两种）。
   */
  setPinned(id: number, on: boolean): void {
    this.db
      .prepare(`update projects set pinned = ?, updated_at = ? where id = ?`)
      .run(on ? 1 : 0, now(), id)
  }

  /**
   * 静默一整级 · D-013 / D-080 + 使用者 4.2
   *
   * 他把级联写得很死：
   *   · 项目静默 → 整个项目从正常视图消失，**只出现在静默知识库**；
   *     底下所有单元 / lecture / 知识点全部进静默库
   *   · 单元、lecture 同理，逐级往下
   *
   * **和 D-011 的关系（这一点很要紧）**：D-011 说静默是「筛选，不是移动，
   * 数据原地不动、归属关系完整保留」。这里做的正是筛选 ——
   * 只翻 `silent` / `production_state` 这几个位，一行数据都没搬家，
   * 所以报告仍然统计得出「这条出自 L1」，恢复出来也还是完整的。
   *
   * 他还说「测试与统计与静默知识完全无关」。那是**查询侧**的事：
   * 今日队列、认读队列、统计、水平评估一律排除静默内容（D-024 早有此意）。
   * **不删任何测试记录** —— 删了就恢复不出完整的东西，而 D-013 说静默可恢复。
   *
   * `silenced_by` 记的是「因为哪一级被静默的」。取消上级静默时，
   * 只把因这一级而静默的放出来；他一条一条手点过的（`'self'`）留在静默库里，
   * 那是他单独做过的决定，不该被一个上级操作抹掉。
   */
  setSilent(kind: 'project' | 'unit' | 'lecture', id: number, on: boolean): void {
    const table = kind === 'project' ? 'projects' : kind === 'unit' ? 'units' : 'lectures'
    const t = now()
    const tag = kind // 'project' | 'unit' | 'lecture'

    this.db.transaction(() => {
      this.db
        .prepare(`update "${table}" set silent = ?, updated_at = ? where id = ?`)
        .run(on ? 1 : 0, t, id)

      // 底下的 lecture 一起停排 —— 否则「归档了还在催我练」
      /**
       * ★ 取消静默时要把到期日**放回来**。
       *
       * 静默时 due_at 被清成 null（不再排期）；取消静默如果只翻 silent 位，
       * 这一讲就**永远不会再进「今日」** —— 界面上它回来了，人却再也练不到它。
       * 这个 bug 是我写完 4.2 之后被数据体检当场抓到的（9.1）：
       * 「取消静默 → 体检报 ready-without-due」。光看代码看不出来，
       * 因为两处都各自"正确"，错的是它们之间那个缺口。
       *
       * ── ★★ D-4 · 上面那次「修好了」其实一直没生效 ────────────
       *
       * 判据写的是 `status = 'ready'`，而**这个状态值根本不存在** ——
       * 合法的是 empty / review / training（`LectureStatus`；analyzing 已被 F-2-① 移出）。
       * 于是 CASE 永远不命中，due_at 永远不恢复：**那一讲静默一次就再也回不来了**。
       * 更糟的是 `audit.ts` 里配套的 `ready-without-due` 检查查的是同一个错名字，
       * 所以**修复无效、检查也再也抓不到** —— 两个一起瞎了。
       *
       * 教训写在这里：改名一个状态值时，`grep` 旧名字要连**检查代码**一起看。
       *
       * ── 为什么恢复成「现在」而不是原来的日期 ────────────────
       *
       * 原来的 due_at 在静默那一刻就被清成 null 了，**原值不存在，无从恢复**。
       * 而 `interval_days` 和 `status` 静默时都没动 —— 所以：
       *   · 恢复 `due_at = 现在`：他主动取消归档就是想练它，立刻可练是对的
       *   · `interval_days` 原样保留：下一次结算从它继续扩张，进度不清零
       * `coalesce(due_at, ?)` 保证「万一 due_at 还在」就用原来那个，不覆盖。
       *
       * 只有 `training` 需要恢复。`review` / `empty` 本来就没有排期
       * （review 是等审阅、empty 是没内容），给它们塞一个到期日反而错。
       */
      if (kind === 'project') {
        this.db
          .prepare(
            `update lectures
                set silent = ?,
                    due_at = case when ? then null
                                  when status = 'training' then coalesce(due_at, ?)
                                  else due_at end,
                    updated_at = ?
              where unit_id in (select id from units where project_id = ?)`
          )
          .run(on ? 1 : 0, on ? 1 : 0, t, t, id)
        this.db
          .prepare(`update units set silent = ?, updated_at = ? where project_id = ?`)
          .run(on ? 1 : 0, t, id)
      } else if (kind === 'unit') {
        this.db
          .prepare(
            `update lectures
                set silent = ?,
                    due_at = case when ? then null
                                  when status = 'training' then coalesce(due_at, ?)
                                  else due_at end,
                    updated_at = ?
              where unit_id = ?`
          )
          .run(on ? 1 : 0, on ? 1 : 0, t, t, id)
      } else if (on) {
        this.db.prepare(`update lectures set due_at = null, updated_at = ? where id = ?`).run(t, id)
      } else {
        this.db
          .prepare(
            `update lectures set due_at = coalesce(due_at, ?), updated_at = ?
              where id = ? and status = 'training'`
          )
          .run(t, t, id)
      }

      // ── 4.2 · 知识点跟着进 / 出静默库 ──────────────────────
      const lectureIds = this.lecturesUnder(kind, id)
      if (lectureIds.length === 0) return
      const list = lectureIds.join(',')

      if (on) {
        /**
         * ★ R-2 · 认读卡的到期日必须一起清掉。
         *
         * 以前只置静默位就完了。认读队列查的是「没静默 ∧ 到期了」，
         * 所以队列表面上是对的 —— 但库里留下了「静默 ∧ 还排着期」
         * 这种自相矛盾的行，正是体检的 `silent-but-due`
         * （D-024：静默是封闭的，封闭就不排期）。
         *
         * ★★ D-296（V34）· 两个域拆表之后这里变成**两条语句**：
         *   产出线的静默位在 `items`，认读线的在 `reading_cards`。
         *   两条都在同一个事务里（外层 `db.transaction`），
         *   否则会出现「产出线静默了、认读卡没退役」的中间态 —— 正是 D-135 禁止的。
         *
         * ★ **卡必须先改**：它的选择条件依赖 `items.production_state`
         *   还没有被下一条改掉。顺序反了就一行都选不中，而且不报错。
         */
        const pick = `deleted_at is null
                and production_state <> 'silent'
                and id in (select item_id from item_lectures where lecture_id in (${list}) and deleted_at is null)`
        this.db
          .prepare(
            `update reading_cards set silent = 1, due_at = null, updated_at = ?
              where item_id in (select id from items where ${pick})`
          )
          .run(t)
        this.db
          .prepare(
            `update items
                set production_state = 'silent', silenced_by = ?, updated_at = ?
              where ${pick}`
          )
          .run(tag, t)
      } else {
        // 只放出「因为这一级才静默」的那些
        /** ★ 同上：卡先改 —— 它的选择条件依赖 `silenced_by` 还没被清掉 */
        const pick = `deleted_at is null
                and silenced_by = ?
                and id in (select item_id from item_lectures where lecture_id in (${list}) and deleted_at is null)`
        this.db
          .prepare(
            `update reading_cards set silent = 0, due_at = ?, updated_at = ?
              where item_id in (select id from items where ${pick})`
          )
          .run(t, t, tag)
        this.db
          .prepare(
            `update items
                set production_state = 'training', silenced_by = null, updated_at = ?
              where ${pick}`
          )
          .run(t, tag)
      }
    })()
  }

  /**
   * 打回待审阅 · Mark as unread。
   * 这一讲重新走一遍 F-03 那道门 —— **条目进度一个字不动**，
   * 只是让你重新过一遍这一批、决定留哪些。
   */
  markUnread(lectureId: number): void {
    const t = now()
    this.db
      .prepare(
        `update lectures set status = 'review', due_at = null, interval_days = 0, updated_at = ?
          where id = ?`
      )
      .run(t, lectureId)
  }

  /**
   * 手动排序 · 使用者 6.1
   *
   * 「项目：只能在项目栏内拖动排序。单元：只能在本项目内。
   *   Lecture：只能在本单元内。**不允许跨级拖动。**」
   *
   * 范围限制在这里也守一道，不只靠界面。界面上的 `dragover` 判断是给人看的反馈；
   * 真正的约束要落在写数据这一层 —— 否则将来多一个入口（比如键盘排序、
   * 或者以后真做了跨级移动）就绕过去了，而且**绕过去不会报错**。
   *
   * 传的是**整个父级下的完整顺序**，不是「把 A 挪到第 3 位」。
   * 理由：后者要在服务端重算，两边对不上时会出现「松手之后跳回去」；
   * 前者是界面看到什么就存什么，所见即所得。
   */
  reorder(kind: 'project' | 'unit' | 'lecture', parentId: number | null, ids: number[]): void {
    if (ids.length === 0) return
    const t = now()
    const table = kind === 'project' ? 'projects' : kind === 'unit' ? 'units' : 'lectures'

    this.db.transaction(() => {
      if (kind !== 'project') {
        // 跨级 / 跨父的 id 一律拒收 —— 拖拽只在同一个父级里成立
        const col = kind === 'unit' ? 'project_id' : 'unit_id'
        const ok = new Set(
          (
            this.db
              .prepare(`select id from "${table}" where ${col} = ? and deleted_at is null`)
              .all(parentId) as { id: number }[]
          ).map((x) => x.id)
        )
        const stray = ids.filter((id) => !ok.has(id))
        if (stray.length > 0) {
          throw new Error(
            `不能跨级拖动：${stray.join('、')} 不在这个${kind === 'unit' ? '项目' : '单元'}下面。`
          )
        }
      }
      const stmt = this.db.prepare(`update "${table}" set sort = ?, updated_at = ? where id = ?`)
      ids.forEach((id, i) => stmt.run(i, t, id))
    })()
  }

  /** 移到别的父级。单元换项目、lecture 换单元。 */
  move(kind: 'unit' | 'lecture', id: number, newParentId: number): void {
    const t = now()
    if (kind === 'unit') {
      this.db.prepare(`update units set project_id = ?, updated_at = ? where id = ?`).run(newParentId, t, id)
    } else {
      this.db.prepare(`update lectures set unit_id = ?, updated_at = ? where id = ?`).run(newParentId, t, id)
    }
  }

  /**
   * 复制一讲 · Fork
   *
   * **只复制材料，不复制条目**，而且新的那份标成「没分析过」。
   * 为什么不连条目一起复制：条目是全局唯一的（D-089），进度挂在条目身上 ——
   * 复制一份出来两边练，进度只会互相打架。
   * Fork 真正有用的场景是「**换一套分析指令，把同一篇重新拆一遍**」，
   * 那正好只需要材料。
   */
  forkLecture(lectureId: number): number {
    const src = this.db
      .prepare(`select unit_id as unitId, name from lectures where id = ?`)
      .get(lectureId) as { unitId: number; name: string } | undefined
    if (!src) throw new Error(`找不到这个 Lecture（id=${lectureId}）`)

    const t = now()
    return this.db.transaction(() => {
      const id = this.createLecture(src.unitId, `${src.name} · 副本`)
      const mats = this.db
        .prepare(
          `select kind, title, origin, content, char_count as chars from materials
            where lecture_id = ? and deleted_at is null order by id`
        )
        .all(lectureId) as { kind: string; title: string; origin: string; content: string; chars: number }[]
      for (const m of mats) {
        this.db
          .prepare(
            `insert into materials (lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(id, m.kind, m.title, m.origin, m.content, m.chars, t, t)
      }
      return id
    })()
  }

  /** 某一支下面的全部 lecture id —— 导出和测试都要按范围取。 */
  lecturesUnder(kind: 'project' | 'unit' | 'lecture', id: number): number[] {
    if (kind === 'lecture') return [id]
    const sql =
      kind === 'unit'
        ? `select id from lectures where unit_id = ? and deleted_at is null`
        : `select l.id from lectures l join units u on u.id = l.unit_id
            where u.project_id = ? and l.deleted_at is null`
    return (this.db.prepare(sql).all(id) as { id: number }[]).map((r) => r.id)
  }

  /**
   * ★★ R-2 · 这里原本有第二个 `silenceLecture()`，已经删掉。
   *
   * 它和 `setSilent('lecture', …)` 是**同一个业务动作的两份实现**，
   * 而工作台上那颗「静默这一讲」走的正是被删掉的那一份。两处的差别是实测出来的：
   *
   * | | setSilent（项目栏右键） | 被删掉的 silenceLecture（工作台） |
   * |---|---|---|
   * | 条目跟着进静默库 | 是 | **否 —— 一条都不标** |
   * | 取消静默恢复排期 | 是（`coalesce(due_at, now)`，仅 training） | **否 —— due_at 永远是 null** |
   * | 通知项目栏刷新 | 是（`treeChanged`） | 否 |
   *
   * 后果：工作台上静默一讲，界面写着「它不再排进今日练习」，
   * 而**认读队列一张都没少**（实测静默前后都是 2 张）；
   * 取消静默之后那一讲**再也不进今日的产出轮转**（D-4 原病，这条路上一字未改）。
   *
   * 和 I-034「条目进度一个字不动」不冲突：`setSilent` 改的是**状态位**
   * （`production_state` / `reading_cards.silent` / `silenced_by`），
   * `attempts` / `corrects` / `streak` / `reading_cards.interval_days` 一个都不碰 ——
   * 静默是「不再轮转」，不是「清零重来」。
   *
   * 入口现在只剩一个：`data:silenceLecture` 这个 IPC 通道名保留（渲染层在用），
   * 但它转调 `setSilent('lecture', …)`。见 `index.ts`。
   */

  /**
   * 这一讲能当「原文」用的全部正文 · I-103 / I-107
   *
   * 两个来源，缺一不可：
   *   ① `materials` 里 kind='original' 的材料
   *   ② **挂在这一讲的文件学习文章**（`files.lecture_id`）
   *
   * ② 是第一版漏掉的，也是「原文摘录第三次还没做到」的直接原因之一：
   * 文件学习里的文章要**点过「分析这篇文章」之后**才会被挂成原文材料。
   * 在那之前右键收进的条目，这一讲里根本没有 original 材料可查 ——
   * 于是退回到「拿选中的那段文字当出处」，出处就等于词条本身。
   */
  originalTexts(lectureId: number): string[] {
    return originalTextsOf(this.db, lectureId)
  }

  /**
   * ★ I-107 · 写「原文出处」的**唯一入口**。
   *
   * 使用者第三次提出「原文摘录没做到」。前两次我都只修了当时看到的那一条路径，
   * 而写出处的地方有**四处**：整段粘贴、析出项、AI 主提取、手动加/右键收进。
   * 每次修一条，剩下三条照旧 —— 这就是为什么「修好了」但他还是看得到假摘录。
   *
   * 所以收口成一个函数，规则只写一遍：
   *   ① 先拿 `term` 去原文里定位那一整句（`findQuoteIn`）
   *   ② 定位不到，再看调用方给的 `fallback` —— 但**必须校验它真的出现在原文里**。
   *      AI 返回的 quote 尤其要过这一关：它经常「重写」原句，看着像、其实一个词都不对
   *   ③ 都不成立 → **不写**。宁可没有出处，也不要一个错的出处 ——
   *      错的出处会一路带进认读卡（挖空挖错地方）和导出的笔记
   *
   * 返回是否真的写了，调用方要据此决定说什么（D-262 · 失败要看得见）。
   */
  recordOccurrence(
    itemId: number,
    lectureId: number,
    term: string,
    opts: {
      fallback?: string | null
      trusted?: boolean
      /**
       * ★ Step 2 · 调用方已经确认这一段**就是原文里的那一句**，直接用它，不再找。
       *
       * 只有 `analyze.ts` 那条路会传：它拿到的 quote 是从原文段落切出来的，已经验过。
       * 加这个口子是为了把那处**绕过唯一入口的直插 INSERT** 收回来 ——
       * 绕过去的代价是确定性身份、去重、`on conflict` 三样全没有（I-107 的本意）。
       */
      exact?: string | null
      materialId?: number | null
      para?: number | null
    } = {}
  ): boolean {
    return recordOccurrence(this.db, itemId, lectureId, term, opts)
  }

  addChunks(lectureId: number, title: string, content: string): ChunkResult {
    const t = now()
    const lines = content
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    if (lines.length === 0) throw new Error('一句都没有 —— 每行一条，空行会被跳过。')

    const tx = this.db.transaction((): ChunkResult => {
      const mr = this.db
        .prepare(
          `insert into materials (lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
           values (?, 'chunk', ?, 'paste', ?, ?, ?, ?)`
        )
        .run(lectureId, title.trim() || '我整理的知识点', content, content.length, t, t)
      const materialId = Number(mr.lastInsertRowid)

      const added: ChunkResult['added'] = []
      const repeats: ChunkResult['repeats'] = []

      for (const line of lines) {
        const norm = normalizeTerm(line)
        const prior = this.db
          .prepare(
            /** ★ I-204 · `layer` / `kind` 是判静默要用的（`isRowSilent`），不是装饰 */
            `select i.id, i.layer, i.kind, i.production_state as productionState,
                    rc.silent as cardSilent, i.recollected_count as n
               from items i ${JOIN_CARD('i')}
              where ${ALIVE('i')} and lower(trim(i.term)) = ? limit 1`
          )
          .get(norm) as
          | {
              id: number
              layer: string
              kind: string
              productionState: ProductionState
              cardSilent: number
              n: number
            }
          | undefined

        /**
         * 原样入库：不拆、不改写。source='self'，layer='A'（只做理解与朗读，不出产出题）。
         * `source_material_id` 是**来源事实**（I-111），和有没有找到原文出处无关 ——
         * 析出那一步靠它反查母句，以前靠 occurrences 反查，
         * 于是「出处找不到就不写」把整条析出链掐断了。
         */
        const ir = this.db
          .prepare(
            `insert into items (term, layer, kind, source, owner_lecture_id, source_material_id,
                                confidence, created_at, updated_at)
             values (?, 'A', 'sentence', 'self', ?, ?, 1.0, ?, ?)`
          )
          .run(line, lectureId, materialId, t, t)
        const itemId = Number(ir.lastInsertRowid)

        this.db
          .prepare(
            `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
             values (?, ?, 1, ?, ?)
           on conflict(item_id, lecture_id) do update set
             deleted_at = null, updated_at = excluded.updated_at
           where item_lectures.deleted_at is not null`
          )
          .run(itemId, lectureId, t, t)

        // M-012 · 原文出处。走唯一入口，规则见 recordOccurrence（I-107）
        // trusted：这一行是他自己贴进来的。先去原文里找整句，找不到就照存这一行
        this.recordOccurrence(itemId, lectureId, line, { fallback: line, trusted: true, materialId })

        added.push({ id: itemId, term: line })

        if (prior) {
          /**
           * ★ I-204 · 这个值喂的是一句**当面说给他听**的话（「上一次『学会』是假的」）——
           *   判错就是当面说错话。判据只有 core 那一份。
           */
          const silent = isRowSilent({ ...prior, cardSilent: prior.cardSilent !== 0 })
          // 6.3 · 只有**跨 lecture** 才算重复收集；同一讲里重贴一遍是误操作
          const crossLecture =
            this.db
              .prepare(`select 1 as x from item_lectures where item_id = ? and lecture_id = ? and deleted_at is null`)
              .get(prior.id, lectureId) === undefined
          if (crossLecture) {
            this.db
              .prepare(
                `update items set recollected_count = recollected_count + 1, updated_at = ? where id = ?`
              )
              .run(t, prior.id)
          }
          repeats.push({
            term: line,
            priorItemId: prior.id,
            wasSilent: silent,
            times: prior.n + 1,
            note: silent
              ? '这条你以前收集过，当时已经判为练成 —— 说明上一次「学会」是假的'
              : '这条你以前收集过，库里已经有了'
          })
        }
      }

      this.touchLecture(lectureId, 'chunks_added', `我的收集 +${added.length} 句`)
      /**
       * ★ N-1 · 有内容了就不该再叫「空」。
       *
       * 在**这个事务里**做：写进去的句子和「这一讲不再是空的」这件事，
       * 要么一起成立、要么一起回滚。放到调用方去做就不同事务了，
       * 而且每加一个入口就要记得调一次 —— 忘了的表现是那一讲变成死胡同。
       * 判据只有一份，见 `lecture-status.ts`。
       */
      promoteOutOfEmpty(this.db, lectureId)
      return { materialId, added, repeats }
    })

    return tx()
  }

  // ── 分析预设 · 按材料给临时指令 ──────────────────────────────

  presets(): PresetRow[] {
    return this.db
      .prepare(
        `select id, name, target, extra, builtin from prompt_presets
          where deleted_at is null order by builtin desc, sort, id`
      )
      .all()
      .map((r) => {
        const row = r as Omit<PresetRow, 'builtin'> & { builtin: number }
        return { ...row, builtin: row.builtin !== 0 }
      })
  }

  savePreset(p: { id?: number; name: string; extra: string }): number {
    const t = now()
    const name = p.name.trim() || '未命名预设'
    if (p.id) {
      this.db
        .prepare(`update prompt_presets set name = ?, extra = ?, updated_at = ? where id = ?`)
        .run(name, p.extra, t, p.id)
      return p.id
    }
    const max = (
      this.db.prepare(`select coalesce(max(sort), 0) as n from prompt_presets`).get() as {
        n: number
      }
    ).n
    return Number(
      this.db
        .prepare(
          `insert into prompt_presets (name, target, extra, builtin, sort, created_at, updated_at)
           values (?, 'analyze-material', ?, 0, ?, ?, ?)`
        )
        .run(name, p.extra, max + 1, t, t).lastInsertRowid
    )
  }

  /** 软删 —— 只增不删（D-216）。内置的三个也能删，它们是例子不是规定。 */
  deletePreset(id: number): void {
    const t = now()
    this.db
      .prepare(`update prompt_presets set deleted_at = ?, updated_at = ? where id = ?`)
      .run(t, t, id)
    this.db.prepare(`update lectures set preset_id = null, updated_at = ? where preset_id = ?`).run(t, id)
  }

  /** 一个 lecture 通常就是一类材料，记住上次选的，不用每次重选。 */
  setLecturePreset(lectureId: number, presetId: number | null): void {
    const t = now()
    this.db
      .prepare(`update lectures set preset_id = ?, updated_at = ? where id = ?`)
      .run(presetId, t, lectureId)
  }

  lecturePreset(lectureId: number): { id: number; name: string; extra: string } | null {
    const r = this.db
      .prepare(
        `select p.id, p.name, p.extra from lectures l
           join prompt_presets p on p.id = l.preset_id
          where l.id = ? and p.deleted_at is null`
      )
      .get(lectureId) as { id: number; name: string; extra: string } | undefined
    return r ?? null
  }

  // ── 杂项 ────────────────────────────────────────────────────

  private touchLecture(lectureId: number, event: string, detail: string): void {
    const t = now()
    this.db
      .prepare(
        `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
         values (?, ?, ?, ?, ?)`
      )
      .run(lectureId, event, detail, t, t)
    this.db.prepare(`update lectures set updated_at = ? where id = ?`).run(t, lectureId)
  }

  countAll(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const t of ['projects', 'units', 'lectures', 'materials', 'items', 'occurrences']) {
      // 不是每张表都有 deleted_at —— occurrences 跟着 item 走，没有自己的软删。
      // 写死 `where deleted_at is null` 的那一版在这里直接抛错，而且**没人发现**：
      // 自检接口谁都没调过（D-265 的验收接口自己没被验收）。所以现在按表实际的列来。
      const soft = (this.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).some(
        (c) => c.name === 'deleted_at'
      )
      out[t] = (
        this.db
          .prepare(`select count(*) as n from "${t}"${soft ? ' where deleted_at is null' : ''}`)
          .get() as { n: number }
      ).n
    }
    return out
  }
}

/**
 * ★ I-107 · 写「原文出处」的唯一入口（独立函数版）。
 *
 * 抽成独立函数是因为 `analyze.ts` 拿着裸 `db` 干活，不持有 Repo 实例 ——
 * 而它正好是四条写入路径里的两条。规则只能有一份，否则又会走回老路：
 * 每次修一条，剩下几条照旧。
 */
export function recordOccurrence(
  db: Database,
  itemId: number,
  lectureId: number,
  term: string,
  opts: {
    fallback?: string | null
    /**
     * fallback 是**使用者自己给的**吗？
     *
     * 这个区分很要紧，我一开始漏了：
     *   · **AI 给的** quote 必须校验 —— 它经常把原句「顺一遍」再返回，
     *     看着像原文、一个词都对不上。这种出处比没有更糟：
     *     认读卡会照着它挖空，挖出来的空在原文里根本不存在。
     *   · **他自己打的 / 自己选中的** 就是事实。他在告诉软件「我在这儿见到的」——
     *     校验不过就丢掉，等于说「你记错了」。软件没有这个资格。
     */
    trusted?: boolean
    /**
     * ★ Step 2 · 调用方已经确认这一段**就是原文里的那一句**，直接用它，不再找。
     *
     * 只有 `analyze.ts` 那条路会传：它拿到的 quote 是从原文段落切出来的，已经验过。
     * 加这个口子是为了把那处**绕过唯一入口的直插 INSERT** 收回来 ——
     * 绕过去的代价是确定性身份、去重、`on conflict` 三样全没有（I-107 的本意）。
     */
    exact?: string | null
    materialId?: number | null
    para?: number | null
  } = {}
): boolean {
  const texts = originalTextsOf(db, lectureId)
  // ★ Step 2 · 调用方给了确认过的原句就直接用，省一次全文查找
  let quote = (opts.exact ?? '').trim() || findQuoteIn(texts, term)

  if (!quote) {
    const fb = opts.fallback?.trim()
    const flat = (x: string): string => x.toLowerCase().replace(/\s+/g, ' ').trim()
    if (fb && (opts.trusted || texts.some((t) => flat(t).includes(flat(fb))))) quote = fb
  }
  if (!quote) return false

  const t = now()
  /**
   * ★★ Step 2 · C-1 · **插入之前就把跨设备身份算出来。**
   *
   * 两件事一起解决：
   *   · 两台设备各自分析同一份材料 → 算出同一个 uid → upsert 接管，不再撞车
   *   · 同一份材料**重新分析一次** → 同一个 uid → `do nothing`，不再长出第二条
   *     （审计发现的那个既有 bug。修法是确定性身份本身，不是另写一套去重）
   *
   * `do nothing` 而不是 `do update`：出处记的是「第一次在哪儿见到的」。
   * 要把出处改好有 `backfillQuotes` 那条专门的路（I-114），
   * 让重新分析顺手覆盖它反而会把已经补好的那一句冲掉。
   *
   * 算不出身份（父行还没有 uid）就不传 uid，交给触发器兜底 ——
   * 那条路算的是同一个表达式（都从 `core/identity.ts` 出）。
   */
  const uid = occurrenceUid(db, itemId, opts.materialId ?? null, lectureId)
  if (uid) {
    db.prepare(
      `insert into occurrences (item_id, material_id, lecture_id, quote, para, uid, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(uid) do nothing`
    ).run(itemId, opts.materialId ?? null, lectureId, quote, opts.para ?? null, uid, t, t)
  } else {
    db.prepare(
      `insert into occurrences (item_id, material_id, lecture_id, quote, para, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    ).run(itemId, opts.materialId ?? null, lectureId, quote, opts.para ?? null, t, t)
  }
  return true
}

/**
 * ★ I-114 · 原文到得比收集晚，出处要回头补。
 *
 * ── 他的原话 ──「原句摘抄的也不行」
 *
 * I-107 把「出处必须是原文里真实那一句」做对了，但**只在写入那一刻找一次**。
 * 而他真实的用法是反过来的：
 *
 *     09:10  贴「我的收集」  → 这一讲还没有原文 → 出处只能记他打的那一行
 *     09:12  上传原文        → **没有任何东西回头去看一眼**
 *     09:13  分析            → 这批新条目出处都是对的
 *
 * 于是同一讲里一半出处是真句子、一半是他自己打的那行 —— 而且不报错。
 * 他数据库里 384 条出处，108 条「出处 = 词条」，其中 **89 条现在回原文里一找就有**。
 * 出处等于词条，认读卡就挖不出空，M-012 说的那半个身份也就没了。
 *
 * 所以：**原文一到，就把这一讲里还欠着出处的补上。**
 *
 * 边界（这条不靠自觉，我删过他 22 本词典）：
 *   · 只动「出处和词条一模一样」的那些 —— 那种出处等于没有出处
 *   · 只在**找到了更好的**时候才写；找不到就原样留着，绝不清空
 *   · 「贴一篇」进来的整句条目，term 本来就等于那一句，找回来还是它 → 跳过，不动
 *
 * @returns 补上了几条
 */
export function backfillQuotes(db: Database, lectureId: number): number {
  const texts = originalTextsOf(db, lectureId)
  if (!texts.some((t) => t.trim())) return 0

  const flat = (x: string): string => (x ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const rows = db
    .prepare(
      `select o.id, o.quote, i.term
         from occurrences o join items i on i.id = o.item_id
        where o.lecture_id = ? and i.deleted_at is null`
    )
    .all(lectureId) as { id: number; quote: string; term: string }[]

  const t = now()
  let n = 0
  for (const r of rows) {
    if (flat(r.quote) !== flat(r.term)) continue
    const q = findQuoteIn(texts, r.term)
    if (!q || flat(q) === flat(r.term)) continue
    db.prepare(`update occurrences set quote = ?, updated_at = ? where id = ?`).run(q, t, r.id)
    n++
  }
  return n
}

/** 引文匹配跑完之后的账。界面照这个说话 —— 别让他猜「到底动了没有」 */
export interface QuoteMatch {
  /** 这一讲一共几条出处 */
  total: number
  /** 真的换了句子的 */
  changed: number
  /** 找到了，而且和现在这句一样 —— 本来就对 */
  same: number
  /** 原文里没找到 —— **旧的留着不动** */
  missed: number
  /** 这一讲压根没有原文（那就什么都别做，照实说） */
  noText: boolean
}

/**
 * ★★ 引文匹配（使用者 2026-09-13）—— 整讲重配原文出处。
 *
 * 他的场景：「有时候我会先收集知识点，但当时还没有原文。等之后把原文添加进
 * Lecture 后，通过『引文匹配』，让每个知识点重新去匹配原文中正确的句子。」
 *
 * ── 和 `backfillQuotes` 的关系 ────────────────────────────────
 * 判据是**同一条**（`core/quote.ts::findQuoteIn`），差别只有覆盖面：
 *   `backfillQuotes`（I-114，加原文时自动跑）只修「出处 == 词条本身」那一种；
 *   这一条是他**主动点**的，修的是「**重新**匹配**正确的**句子」——
 *   出处是别的、但不对的那些也要重配。
 *
 * ── 三个不做 ─────────────────────────────────────────────────
 * ① **不调 AI**：这是文本查找，有唯一正确答案。上 AI 等于给一件有确定答案的事
 *    加上成本和「可能有误」。
 * ② **找不到不清空**：旧的留着。`quote.ts` 的原话是「宁可没有出处，也不要一个
 *    错的出处」—— 抹掉他仅有的那点出处比留着一个不完美的更糟。
 * ③ **不建新行**：实测他库里「完全没有出处的知识点」是 **0**，每条至少有一行，
 *    所以这里只 UPDATE。真需要 INSERT 那是另一件事，等有证据再说。
 *
 * ★ 「匹配到多个取第一次出现的」不在这里实现 —— `findQuote` 按句子顺序扫、
 *   第一个命中就返回，本来就是。`core/quote.test.ts` 有一条专门钉它。
 *
 * ★ 范围是**整讲**：按 `o.lecture_id` 取，不按层过滤 ——
 *   他要的正是「我的收集 / 写作层 / 理解层」一起，而不是某一层。
 */
export function matchQuotes(db: Database, lectureId: number): QuoteMatch {
  const texts = originalTextsOf(db, lectureId)
  if (!texts.some((t) => t.trim())) {
    return { total: 0, changed: 0, same: 0, missed: 0, noText: true }
  }

  const flat = (x: string): string => (x ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const rows = db
    .prepare(
      `select o.id, o.quote, i.term
         from occurrences o join items i on i.id = o.item_id
        where o.lecture_id = ? and i.deleted_at is null`
    )
    .all(lectureId) as { id: number; quote: string; term: string }[]

  const t = now()
  const out: QuoteMatch = { total: rows.length, changed: 0, same: 0, missed: 0, noText: false }
  const upd = db.prepare(`update occurrences set quote = ?, updated_at = ? where id = ?`)
  for (const r of rows) {
    const q = findQuoteIn(texts, r.term)
    if (!q) {
      out.missed++
      continue
    }
    if (flat(q) === flat(r.quote)) {
      out.same++
      continue
    }
    upd.run(q, t, r.id)
    out.changed++
  }
  return out
}

/** 这一讲能当「原文」用的全部正文：原文材料 + 挂在这一讲的文件学习文章 */
export function originalTextsOf(db: Database, lectureId: number): string[] {
  const mats = (
    db
      .prepare(
        `select content from materials
          where lecture_id = ? and kind = 'original' and deleted_at is null order by id`
      )
      .all(lectureId) as { content: string }[]
  ).map((r) => r.content)
  const files = (
    db.prepare(`select content from files where lecture_id = ? and deleted_at is null order by id`)
      .all(lectureId) as { content: string }[]
  ).map((r) => r.content)
  return [...mats, ...files]
}
