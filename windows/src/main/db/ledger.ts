import type { Database } from 'better-sqlite3'

/**
 * 行为与状态账本 · 使用者 4.1
 *
 * 「建立一个完整的『行为与状态』数据库…后续遇到相同表达时，
 *   自动判断是否已删除/静默，不再重复分析进知识库或 Lecture。」
 *
 * 两张表分工不同：
 *   · `term_ledger` 按**表达字面**记账 —— 回答「这个说法我处理过没有」。
 *     键是归一化字面而不是 item_id：item 会被彻底删掉，
 *     删掉之后判断就跟着没了，下次分析又原样捞回来。
 *   · `ops_log` 按**动作**记账 —— 只是事实，不参与任何判断。
 *
 * 这个模块只做记账和查账，**不做决定**。要不要跳过某个表达是调用方的事，
 * 这样「跳过规则」将来怎么改都不用动账本。
 */

export type Verdict = 'deleted' | 'purged' | 'silenced'

/**
 * 查词的「哪一面」· T-4.14。两端同一份取值：
 * `quick` = 气泡里的快速面（手机）· `dict` = 词典 · `ai` = AI 搜索。
 * Windows 今天只用 `dict`（见 `Ledger.lookup` 头注）。
 */
export type LookupFace = 'quick' | 'dict' | 'ai'

/**
 * 归一化 —— 判「同一个表达」的唯一判据。
 *
 * 只做三件事：去首尾空白、压中间空白、转小写。
 * **故意不做词形还原**：`bear the brunt of` 和 `bore the brunt of` 是不是同一条，
 * 使用者可能有不同看法；猜错的后果是「我明明没删过它，它却不进来了」——
 * 那种失败他看不见，只会觉得软件漏了东西。宁可保守。
 */
export function normTerm(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase()
}

const now = (): number => Date.now()

export class Ledger {
  constructor(private db: Database) {}

  /**
   * 记一笔「这个表达被这样处理过」。
   *
   * `scope`：`global` = 以后哪儿都别再收；`lecture` = 只在这一讲里别再收。
   * 默认 global —— 他说的是「后续遇到相同表达」，没有限定范围。
   */
  note(
    term: string,
    verdict: Verdict,
    opts: { lectureId?: number | null; note?: string | null } = {}
  ): void {
    const norm = normTerm(term)
    if (!norm) return
    const t = now()
    this.db
      .prepare(
        `insert into term_ledger (norm, term, verdict, scope, lecture_id, note, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(norm, verdict, coalesce(lecture_id, 0)) do update set
           term = excluded.term,
           note = excluded.note,
           /**
            * ★★ R-3-e · **撤销要清回去。**
            *
            * 「删掉 → 从垃圾箱捡回来（撤销）→ 又删掉」是很正常的一串动作。
            * 不清这一句的话，第二次删除**写进去了却不生效** ——
            * 账本里明明有这一行，AI 却照样把它收进来，
            * 而他完全看不出为什么。不报错，是那种最贵的静默失效。
            */
           revoked_at = null,
           updated_at = excluded.updated_at`
      )
      .run(
        norm,
        term.trim(),
        verdict,
        opts.lectureId ? 'lecture' : 'global',
        opts.lectureId ?? null,
        opts.note ?? null,
        t,
        t
      )
  }

  /** 一次记一批 —— 静默一整个项目时会有几百条 */
  noteMany(
    terms: string[],
    verdict: Verdict,
    opts: { lectureId?: number | null; note?: string | null } = {}
  ): number {
    let n = 0
    this.db.transaction(() => {
      for (const term of terms) {
        this.note(term, verdict, opts)
        n++
      }
    })()
    return n
  }

  /**
   * 他后来又把它收回来了 —— ★★ R-3-e · **记一条撤销，不是删一行。**
   *
   * ── 为什么不能删 ──────────────────────────────────────────
   *
   * 删掉之后，本地和「从来没记过」逐字节相同 —— 没有任何东西可以推给
   * 另一台设备。于是 B 上那条「以后别再收它」永久留着：
   * 他在 B 上重新分析同一篇文章，那条表达仍然进不来，
   * 而他刚刚才明确把它捡回来。
   *
   * 现在是一次普通的行更新，而 `term_ledger` 本来就在 `SYNC_TABLES` 里 ——
   * **这条撤销自己就会走到另一台机器上**，同步那层一个字都不用改。
   *
   * ── `verdict` 为什么必填 ──────────────────────────────────
   *
   * 以前不传就是「这个说法的所有判定全撤」。N-2-b 已经为此付过账：
   * 他先静默一条（我会了）、后来又删了它、再从垃圾箱恢复 ——
   * 那次恢复把「我已经会了」也一起擦掉，于是它重新排进轮转，
   * 而他只会觉得「静默怎么又失效了」。
   * 三个调用点现在都传了 verdict，那条分支是死代码 ——
   * 但**留着就是一把上膛的枪**，下一个人顺手调一次就把 N-2-b 踩回去。
   */
  forget(term: string, verdict: Verdict): number {
    const norm = normTerm(term)
    if (!norm) return 0
    const t = now()
    // 已经撤过的不再动 —— 幂等，而且不会平白抬高 updated_at 去挤同步流量
    return this.db
      .prepare(
        `update term_ledger set revoked_at = ?, updated_at = ?
          where norm = ? and verdict = ? and revoked_at is null`
      )
      .run(t, t, norm, verdict).changes
  }

  forgetMany(terms: string[], verdict: Verdict): number {
    let n = 0
    this.db.transaction(() => {
      for (const term of terms) n += this.forget(term, verdict)
    })()
    return n
  }

  /** 这个表达之前被怎么处理过？没处理过返回 null。 */
  verdictOf(term: string, lectureId?: number | null): Verdict | null {
    const norm = normTerm(term)
    if (!norm) return null
    const r = this.db
      .prepare(
        /**
         * ★★ R-3-e · `revoked_at is null` —— **撤销过的不算数。**
         *
         * 这里是全项目**唯一**读账本做判断的地方（`analyze` 那两处都走它，
         * `skipSet` 也是）。所以这一个条件加在这里就够了，
         * 绝不要跑到调用点上各加一遍 —— 那样迟早有一处漏掉，
         * 而漏掉的表现是「他捡回来的表达还是进不来」。
         */
        `select verdict from term_ledger
          where norm = ? and (scope = 'global' or lecture_id = ?) and revoked_at is null
          order by case verdict when 'purged' then 0 when 'deleted' then 1 else 2 end
          limit 1`
      )
      .get(norm, lectureId ?? -1) as { verdict: Verdict } | undefined
    return r?.verdict ?? null
  }

  /**
   * 一批表达里，哪些是要跳过的。
   *
   * 分析一份材料会一次问几十个，所以做成批量 ——
   * 一条一条查在 SQLite 上不算慢，但调用方会忍不住写成循环里发 IPC。
   */
  skipSet(terms: string[], lectureId?: number | null): Map<string, Verdict> {
    const out = new Map<string, Verdict>()
    for (const term of terms) {
      const v = this.verdictOf(term, lectureId)
      if (v) out.set(normTerm(term), v)
    }
    return out
  }

  /** 账本全貌 —— 设置页里要能看见、能撤销，否则这是一个看不见的黑名单 */
  list(limit = 500): {
    id: number
    term: string
    verdict: Verdict
    scope: string
    lectureId: number | null
    lectureName: string | null
    at: number
    /** ★ R-3-e · 撤销过的行还留着（它是传播的载体），要能看出来 */
    revokedAt: number | null
  }[] {
    return this.db
      .prepare(
        `select tl.id, tl.term, tl.verdict, tl.scope, tl.lecture_id as lectureId,
                l.name as lectureName, tl.updated_at as at, tl.revoked_at as revokedAt
           from term_ledger tl
           left join lectures l on l.id = tl.lecture_id
          order by tl.updated_at desc limit ?`
      )
      .all(limit) as ReturnType<Ledger['list']>
  }

  /** 手动撤一条（设置页那个名单的写入口，界面按他的要求撤掉了，契约还在） */
  drop(id: number): number {
    const t = now()
    return this.db
      .prepare(
        `update term_ledger set revoked_at = ?, updated_at = ?
          where id = ? and revoked_at is null`
      )
      .run(t, t, id).changes
  }

  // ── 动作日志 ────────────────────────────────────────────────

  /**
   * 记一个动作。**永远不抛** —— 记日志失败不该把正事带崩。
   * 这一条是刻意的：日志是附加价值，业务是本体。
   */
  op(
    op: string,
    target: string,
    targetId: number | null,
    title?: string | null,
    detail?: unknown
  ): void {
    try {
      const t = now()
      this.db
        .prepare(
          `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          op,
          target,
          targetId,
          title ?? null,
          detail === undefined ? null : JSON.stringify(detail),
          t,
          t
        )
    } catch (err) {
      console.error('[ledger] 动作没记上：', err)
    }
  }

  // ── 查词记账 · T-4.14 ───────────────────────────────────────

  /**
   * 查一次词，记一行 · T-4.14（使用者 2026-09-07 第四批 三 · 五）
   *
   * ── 为什么值得记 ──────────────────────────────────────────
   *
   * 「反复查同一个词」「查了没收」「收了没练」是最便宜也最真的学习信号，
   * 而 `ops_log` 早就在两端的同步合约里（`core/sync-tables.ts`）——
   * **写了自然就同步**：不新开表、不加列、不动指纹（D-461）。
   * 使用者原话：「不要为了什么都记录而无脑增加大量数据」——
   * 所以只记这一件事，不做点击流。
   *
   * ── 形状：两端同一份 ──────────────────────────────────────
   *
   * `op = 'lookup'` · `target = 'term'` · `title` = 词面 ——
   * 这三样和手机上那一行**逐字一样**（Android `engine/main.ts` 的 `ledgerOp`），
   * 否则同到一起之后就是两种形状，报告得写两份解析。
   * 新增的只有 `detail`（自由 JSON）：
   *
   *   `{ source: 'assist' | 'app' | 'windows', face: 'quick' | 'dict' | 'ai', saved: item_id | null }`
   *
   * ★ `source` 在**这里**写死 `'windows'`，不由界面传 ——
   *   界面传不了它，也就传不错。
   * ★ Windows 今天只有词典那一面（`Capture.svelte` 的「查词典」）。
   *   `'ai'` 这个值是给 AI 搜索留的位（手机已经有那一面，Windows 还没有），
   *   接上的那天调用方换个参数就行，账本这一层不用再动。
   * ★ **不记设置页那个词典探针**（`Settings.svelte` 的「试查一个词」）：
   *   那是自检，不是他在查词。记了会把账本和后面的报告一起弄脏。
   *
   * 返回这一行的 id，`lookupSaved` 用它回填「后来收下了」。
   * 和 `op()` 同一条纪律：**永远不抛** —— 记账失败不该把查词带崩，
   * 失败返回 0，调用方拿 0 当「没记上」。
   */
  lookup(term: string, face: LookupFace): number {
    try {
      const t = now()
      const r = this.db
        .prepare(
          `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
           values ('lookup', 'term', null, ?, ?, ?, ?)`
        )
        .run(term.trim(), JSON.stringify({ source: 'windows', face, saved: null }), t, t)
      return Number(r.lastInsertRowid)
    } catch (err) {
      console.error('[ledger] 查词没记上：', err)
      return 0
    }
  }

  /**
   * 那次查词之后他把这条收下了 —— 回填 `detail.saved` · T-4.14
   *
   * ★ 为什么是**改那一行**，不是再记一行：
   *   「查了没收 / 查了收了」是同一次查词的两种结局，拆成两行之后
   *   报告要靠「词面 + 时间」把它们再拼回去 —— 那正是今天手机那批
   *   `lookup` 行的毛病（归档 d §三 G）。一行说完，谁都不用猜。
   * ★ 只回填**还没回填过**的那一行：同一次查词只有一次「收下」，
   *   再来一次是别的事（他又查了一遍）。
   * ★ 顶新的 `updated_at` —— 不顶的话这一行改了也同步不出去（D-438 只比它）。
   */
  lookupSaved(opId: number, itemId: number): number {
    try {
      const row = this.db
        .prepare(`select detail from ops_log where id = ? and op = 'lookup'`)
        .get(opId) as { detail: string | null } | undefined
      if (!row) return 0
      const detail = JSON.parse(row.detail ?? '{}') as { saved?: number | null }
      if (detail.saved) return 0
      const t = now()
      return this.db
        .prepare(`update ops_log set detail = ?, updated_at = ? where id = ?`)
        .run(JSON.stringify({ ...detail, saved: itemId }), t, opId).changes
    } catch (err) {
      console.error('[ledger] 「查了之后收下了」没记上：', err)
      return 0
    }
  }

  ops(limit = 200): {
    id: number
    op: string
    target: string
    targetId: number | null
    title: string | null
    at: number
  }[] {
    return this.db
      .prepare(
        `select id, op, target, target_id as targetId, title, created_at as at
           from ops_log order by created_at desc limit ?`
      )
      .all(limit) as ReturnType<Ledger['ops']>
  }
}
