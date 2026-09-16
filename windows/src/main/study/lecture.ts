/**
 * Study · 讲次生命周期：开始学 · 结算 · 会话 · 总览 · 讲次日志 —— T-4.6 拆分（2026-09-06）
 *
 * 方法体从 `src/main/study.ts` 原样搬来：`this.<状态>` → `c.<状态>`，
 * `this.<公共方法>` → `c.self.<方法>`，私有方法整个搬进本文件、调用点也在本文件里。
 * ★ 模板字符串里的行一个空格都没动 —— 那里面是 SQL，缩进属于字符串内容。
 * ★ 判断规则一条都不在这里，全在 core/（D-238）：这一层只做
 *   「从库里取状态 → 交给 core 算 → 把结果写回去」。
 */

import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from '@core/silence.ts'
import { dueAfter, nextLectureInterval, overdueDays } from '@core/sm2-lecture.ts'
import { scheduleOnStart } from '@core/start-learning.ts'
import type { Settlement, StartLearningResult } from '@shared/api.ts'
import { Prefs } from '../db/prefs.ts'
import { deviceCol } from '../db/device.ts'
import { CARD_ACTIVE, CARD_DUE, JOIN_CARD } from '../db/reading-card-sql.ts'
import type { StudyCtx } from './ctx.ts'
import { now } from './util.ts'

/**
 * 「这批我看过了 · 开始学」——**这一讲才进入轮转**。
 *
 * 它不是仪式，是门：D-053 说 AI 后台自动归档、不做批量审批，那反对的是**逐条**打勾；
 * 这里是整批一个动作，什么都不点也能走。顺带回答了「首次到期日落在哪一天」——
 * 审阅之后的第二天，好让阶段④首轮认读有地方站（见 docs/archive/study-flow.html）。
 */
/**
 * ★★ P-1 · 这一步现在是**一个原子动作**，而且**只能从 review 进入**。
 *
 * ── 以前有两个洞 ────────────────────────────────────────
 *
 * ① **三条写入没有事务。** `update lectures` 成了、`update items` 炸了，
 *    结果是「这一讲进了轮转，可它的条目一张认读卡都没排期」——
 *    他点完「开始学」，认读队列是空的，而界面上一切正常。没有人查得到。
 *
 * ② **没有前置条件。** SQL 里只有 `where id = ?`，所以对一条**已经在轮转**的讲
 *    再调一次，会把 `interval_days` 打回 1、`due_at` 推到明天 ——
 *    **进度清零**。界面上那颗按钮只在 `review` 时渲染，挡住了正常路径；
 *    但「靠界面挡」不是保证，IPC 通道本身是敞开的（P-1 不变量 I-2）。
 *
 * ── 现在的语义 ────────────────────────────────────────
 *
 *   `status='review' ∧ silent=0 ∧ 没删` → 进入轮转，三条写入同生共死
 *   其它任何形状                        → **一个字都不写**，`refused` 说清是哪一种
 *
 * 判据放在 UPDATE 的 `where` 里而不是先 SELECT 再判断：
 * 「先查后改」中间有窗口，而 `where` 子句的判断和写入是同一次原子操作。
 *
 * ── ★★ F-2-②-e · 归档的讲也要挡住 ──────────────────────
 *
 * 门槛以前只有 `status='review'`。而 `silent=1 ∧ status='review'` 是一种
 * **合法**的形状（归档时只翻 silent 位、清 due_at，status 保持原样），
 * 于是绕过界面直接调这条 IPC，就会给一个已归档的讲写上 `due_at=明天` ——
 * 正好撞上体检里 `silent-but-due` 那条 error 级不变量。
 *
 * 和 P-1 是同一个形状：界面确实挡住了（归档的讲不在项目栏里，
 * 那颗按钮也只在 `status==='review'` 时渲染），但**靠界面挡不是保证**。
 *
 * ── 拒绝的理由不许糊在一起 ──────────────────────────────
 *
 * 以前只有一个 `alreadyRunning: true`，于是「已归档」会被说成
 * 「这一讲已经在轮转中」—— 他照着这句话去找轮转里的它，永远找不到。
 * 现在分四种，每一种给一句他能照着做下一步的话。
 */
export function startLearning(c: StudyCtx, lectureId: number): StartLearningResult {
  const t = now()

  /**
   * ★★ 进轮转的门槛 —— **只有这一份**。
   *
   * 下面的 SELECT（读事实去算排期）和 UPDATE（真正写）共用同一个字符串。
   * 各写各的话，某天有人只在其中一处加条件，另一处就会为一行**根本写不进去**的
   * 讲算出一份排期 —— 而那种错不报警，只是「点了没反应」。
   */
  const GATE = `id = ? and status = 'review' and silent = 0 and deleted_at is null`

  const countOf = (): number =>
    (
      c.db
        .prepare(
          `select count(*) as n from item_lectures il join items i on i.id = il.item_id
              where il.lecture_id = ? and i.deleted_at is null`
        )
        .get(lectureId) as { n: number }
    ).n

  /**
   * `immediate()` = `BEGIN IMMEDIATE`：一开始就拿写锁。
   * 这样「判断 + 写入」之间不存在任何别人能插进来的窗口。
   */
  return c.db.transaction((): StartLearningResult => {
    /**
     * ★★ F-2-② · 先把**库里当前的事实**读出来，再让纯函数决定排期。
     *
     * 读和写在同一个 `immediate` 事务里，所以这中间没有窗口。
     * 判据一个字都不写在这里 —— 它在 `core/start-learning.ts`，
     * 那份两端共用（D-238），而且能单独跑测试。
     */
    const row = c.db
      .prepare(`select interval_days as interval, due_at as dueAt from lectures where ${GATE}`)
      .get(lectureId) as { interval: number; dueAt: number | null } | undefined

    if (!row) return refuseStart(c, lectureId, countOf())

    /**
     * ★★ F-2-② · item 级的事实：**有几条还没拿到认读卡**。
     *
     * 判据和下面那句真正写 `reading_cards.due_at` 的 `where` **逐字一致** ——
     * 界面上说「3 条新表达现在就能认读」，那个 3 必须就是被写的行数。
     * 两处各写一份的话，它们会在某次改动里悄悄分家，而表现是
     * 「界面说 3 条，认读队列里只有 1 条」，没有人查得出来。
     */
    const freshWhere = `rc.due_at is null and rc.silent = 0 and i.deleted_at is null
                and i.id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`
    const fresh = (
      c.db
        .prepare(
          `select count(*) as n from items i ${JOIN_CARD('i')} where ${freshWhere}`
        )
        .get(lectureId) as { n: number }
    ).n

    const plan = scheduleOnStart(
      { interval: row.interval, dueAt: row.dueAt, fresh, now: t },
      c.params.effective().lecture
    )

    const changed = c.db
      .prepare(
        `update lectures set status = 'training', interval_days = ?, due_at = ?, updated_at = ?
            where ${GATE}`
      )
      .run(plan.interval, plan.dueAt, t, lectureId).changes

    /**
     * 上面刚 SELECT 到，这里 UPDATE 却没命中 —— 在 `BEGIN IMMEDIATE` 里
     * 这不可能发生。真发生了就说明库出了别的问题，**当场炸**，
     * 别把「什么都没写」伪装成一次成功的开始学。
     */
    if (changed === 0) throw new Error('开始学：状态在同一个事务里变了，这一步没有写成')

    const count = countOf()
    // 新条目的认读卡立刻可练 —— 首轮认读就是它们的第一次复习，不是额外加出来的东西
    const gave = c.db
      .prepare(
        `update reading_cards set due_at = ?, updated_at = ?
            where id in (select rc.id from items i ${JOIN_CARD('i')} where ${freshWhere})`
      )
      .run(t, t, lectureId).changes

    if (gave !== fresh) {
      throw new Error(`开始学：说好给 ${fresh} 条新知识点排认读，实际写了 ${gave} 条`)
    }

    log(c, lectureId, 'reviewed', `审阅完成，${count} 条排进练习 —— ${plan.reason}`)
    return {
      dueAt: plan.dueAt,
      intervalDays: plan.interval,
      count,
      fresh,
      refused: null,
      reason: plan.reason
    }
  }).immediate()
}

/**
 * ★★ F-2-②-e · 门槛没放行时，**说清楚是哪一种没放行**。
 *
 * 这一步的 SELECT 是**诊断，不是判据** —— 判据已经由上面那句 UPDATE 的
 * `where` 原子地做完了，这里只是回头看一眼「刚才为什么没命中」，
 * 好给他一句能照着做下一步的话。所以它不构成「先查后改」的那种窗口。
 *
 * 顺序是有讲究的：**先看归档**。一个归档过的、原本在轮转中的讲，
 * 两个条件都不满足，而对他有用的那句是「先把它放回去」（D-485 改名）——
 * 告诉他「已经在轮转中了」，他会去轮转里找它，而它不在那里。
 */
export function refuseStart(c: StudyCtx, lectureId: number, count: number): StartLearningResult {
  const cur = c.db
    .prepare(
      `select status, silent, due_at as dueAt, interval_days as iv, deleted_at as deletedAt
           from lectures where id = ?`
    )
    .get(lectureId) as
    | { status: string; silent: number; dueAt: number | null; iv: number; deletedAt: number | null }
    | undefined

  const base = { dueAt: cur?.dueAt ?? 0, intervalDays: cur?.iv ?? 0, count, fresh: 0 }

  if (!cur || cur.deletedAt !== null) {
    return {
      ...base,
      refused: 'missing',
      reason: '找不到这个 Lecture —— 它可能刚被删掉了。去回收站看看能不能恢复。'
    }
  }
  if (cur.silent === 1) {
    return {
      ...base,
      refused: 'archived',
      reason:
        `这个 Lecture 已${SILENCE_FILTER_NAME} —— ${SILENCE_FILTER_NAME}的不排期，所以没法开始学。` +
        `想重新练它，去 Vault 的「${SILENCE_FILTER_NAME}」把它${SILENCE_ACTIONS.restore}，进度会原样回来。`
    }
  }
  if (cur.status === 'training') {
    return {
      ...base,
      refused: 'alreadyRunning',
      reason: '这个 Lecture 已经在练了 —— 没有重新开始，你的间隔和排期一个字都没动。'
    }
  }
  return {
    ...base,
    refused: 'notReviewed',
    reason: `这个 Lecture 现在不是「待审阅」（是「${cur.status}」）—— 先分析出内容，再点开始学。`
  }
}

export function settle(c: StudyCtx, lectureId: number, sessionId: number | null): Settlement {
  return c.self.settleLectures([lectureId], sessionId)
}

/**
 * 结算 · D-127 / D-139
 *
 * **每个 lecture 各算各的间隔**（D-139）—— 今日练习会跨好几讲，
 * 用整场的正确率去决定每一讲的排期，等于拿别的讲次的表现给这一讲定期。
 */
/**
 * ★★ P-1 · 整场结算是**一个原子动作**，而且**一生只做一次**。
 *
 * 它是「一场 session」的业务动作，不是「一讲」的 —— 所以三讲里第二讲失败时，
 * 正确的结果是**三讲全部保持结算前的样子**，而不是第一讲已经扩张、第二讲没动。
 * 以前逐讲循环没有事务，那种半结算状态既没人恢复、`audit` 22 项也没有一条查得到：
 * 两讲的 status / due_at 都合法，只是数字错了。
 *
 * 同属这一个原子操作的：`lectures.interval_days` · `lectures.due_at` ·
 * `lecture_logs` 的 practiced 记录 · `sessions.finished_at`。
 * **不属于**它的：`answers` 与 `review_logs` —— 那些在答题那一刻就已经各自
 * 原子地落库了（见 `submitAnswer`），结算只读不写。
 */
/**
 * ★★★ T-4.13 / T-5.18 · **按 ids 练的那一场，只动卡，不动讲次间隔**
 *   （D-R28「排期是推荐，不是门禁」的边界，两端同一条）
 *
 * ── 规矩 ──────────────────────────────────────────────────
 *
 * 他勾了几条直接练（知识库勾选 · 攻坚区 · 讲次页长按选中 · 单条「练这一条」），
 * 走的是 `queueByIds` / `testCardsByIds` 这条路，**`lectureIds` 是空的** ——
 * 于是这个循环一次都不进，`lectures.interval_days` 与 `due_at` 一个字不动。
 * 这是**有意的**，不是漏了：
 *
 *   · 练了就算数 —— `answers` · `review_logs` · `sessions` · SM-2 卡状态
 *     **照写照更新**（那些在答题那一刻就落库了，见上一段）；
 *   · 但**讲次的排期不该被一次局部练习重定**：他勾的那 3 条不能代表这一讲的
 *     40 条，拿这 3 条的正确率去给整讲重新定期，等于用样本冒充总体 ——
 *     和 D-139「每个 lecture 各算各的间隔」反对的是同一件事。
 *
 * 想给整讲重定期，就整讲练（首页今日 / 讲次页产出练习 / 随时练习都带 `lectureIds`）。
 *
 * ★ Android 那一侧（`T-5.18`）按同一条走：ids 场只动卡。
 *   两端不一致的话，同一批条目在手机上练完讲次日期变了、在电脑上没变，
 *   而两边的库会互相同步 —— 谁也说不清哪个日期是对的。
 */
export function settleLectures(c: StudyCtx, lectureIds: number[], sessionId: number | null): Settlement {
  return c.db.transaction((): Settlement => settleInTx(c, lectureIds, sessionId)).immediate()
}

export function settleInTx(c: StudyCtx, lectureIds: number[], sessionId: number | null): Settlement {
  const t = now()
  const marks = lectureIds.map(() => '?').join(',')

  const answers = (
    sessionId
      ? c.db
          .prepare(
            `select a.item_id as itemId, a.grade from answers a
                where a.is_first = 1 and a.grade is not null and a.session_id = ? order by a.id`
          )
          .all(sessionId)
      : c.db
          .prepare(
            `select a.item_id as itemId, a.grade from answers a
                where a.is_first = 1 and a.grade is not null
                  and a.item_id in (select item_id from item_lectures where lecture_id in (${marks}) and deleted_at is null)
                order by a.id`
          )
          .all(...lectureIds)
  ) as { itemId: number; grade: number }[]

  const dist = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>
  for (const a of answers) dist[a.grade] = (dist[a.grade] ?? 0) + 1
  const sample = answers.length
  const accuracy = sample === 0 ? 0 : ((dist[3] ?? 0) + (dist[4] ?? 0)) / sample

  /**
   * ★★ P-1 · 一场 session **一生只结算一次**。
   *
   * ── 以前会重复结算 ──────────────────────────────────────
   *
   * `nextLectureInterval(lec.interval, …)` 每次都**重新读当前的 interval**，
   * 而结算会把它写大。所以第二次结算 = 在已经扩张过的值上**再乘一次**：
   * 正确率 >90% 时 7 天 → 18 天 → 47 天，`due_at` 跟着往后推。
   *
   * 而通往第二次的路是敞开的：结算失败后错误页上那颗「重试」
   * 原本调的是 `loadQuestion()`，在队列末尾它会直接落进 `settle()`。
   * 也就是说 —— **「重试」这颗按钮的实际行为就是「再结算一次」**。
   * 如果第一次是中途失败（三讲里第二讲炸了），重试会让第一讲被乘第二次。
   *
   * ── 判据落在 `sessions.finished_at` 上 ────────────────────
   *
   * 它以前只写不读（全项目没有一处 SELECT 它），现在升格为业务事实：
   * **这一场结算过没有**。已结算 → 只重算展示用的数字，一个字都不写。
   *
   * 「检查 + 写入」在**同一个 immediate 事务**里 ——
   * 不是「先 SELECT 再开事务」那种留着竞争窗口的结构。
   * 加上 better-sqlite3 是同步的、主进程单线程，两次 IPC 调用之间
   * 根本不存在交错：第一次整段跑完，第二次才开始，看到的必然是已结算。
   */
  const settledAt = sessionId
    ? ((
        c.db.prepare(`select finished_at as f from sessions where id = ?`).get(sessionId) as
          | { f: number | null }
          | undefined
      )?.f ?? null)
    : null

  // 每讲各算各的：只用属于这一讲的作答
  const perLecture: Settlement['perLecture'] = []
  for (const id of lectureIds) {
    const own = c.db
      .prepare(
        `select count(*) as n,
                  sum(case when a.grade >= 3 then 1 else 0 end) as ok
             from answers a
            where a.is_first = 1 and a.grade is not null
              ${sessionId ? 'and a.session_id = ?' : ''}
              and a.item_id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`
      )
      .get(...(sessionId ? [sessionId, id] : [id])) as { n: number; ok: number | null }

    const lec = c.db
      .prepare(`select name, interval_days as interval from lectures where id = ?`)
      .get(id) as { name: string; interval: number } | undefined
    if (!lec) continue

    const acc = own.n === 0 ? 0 : (own.ok ?? 0) / own.n

    if (settledAt !== null) {
      /**
       * 这一场已经结算过了：**只给展示，不写任何东西**。
       * `nextDays` 报的是**库里当前的间隔**（也就是上一次结算的结果），
       * 不是「再算一次会变成多少」—— 后者算出来的是一个永远不会发生的数字。
       */
      perLecture.push({
        lectureId: id,
        name: lec.name,
        reason: `这一场已经结算过了 —— 间隔保持 ${lec.interval} 天，没有再动`,
        nextDays: lec.interval
      })
      continue
    }

    const next = nextLectureInterval(lec.interval, acc, own.n, c.params.effective().lecture)
    if (next.changed) {
      c.db
        .prepare(`update lectures set interval_days = ?, due_at = ?, updated_at = ? where id = ?`)
        .run(next.interval, dueAfter(next.interval), t, id)
    }
    // D-256 · lecture 级事件写 lecture_logs，**不塞进条目级的 review_logs**
    log(c, id, 'practiced', `${own.n} 题 · 正确率 ${Math.round(acc * 100)}% · ${next.reason}`)
    perLecture.push({ lectureId: id, name: lec.name, reason: next.reason, nextDays: next.interval })
  }

  // 收尾时间只在**第一次**结算时写 —— 它就是「这一场结算过了」这条事实本身
  if (sessionId && settledAt === null) {
    c.db
      .prepare(`update sessions set finished_at = ?, updated_at = ? where id = ?`)
      .run(t, t, sessionId)
  }

  const answered = [...new Set(answers.map((a) => a.itemId))]
  const termsIn = (state: string): string[] => {
    if (answered.length === 0) return []
    const m = answered.map(() => '?').join(',')
    return c.db
      .prepare(`select term from items where id in (${m}) and production_state = ? and deleted_at is null`)
      .all(...answered, state)
      .map((r) => (r as { term: string }).term)
  }

  // F-05 · 出口。这批里有认读卡也到期了 → 那是把两条线接上的位置（R-008 断点 3）
  const dueReading = c.self.dueCards(null, 999).length

  return {
    lectureIds,
    sample,
    distribution: dist,
    accuracy,
    silenced: termsIn('silent'),
    hard: termsIn('hard'),
    perLecture,
    dueReadingCount: dueReading
  }
}

/**
 * ★★ V35 / D-350 · 开一次会话，**并把当时生效的规则整块拍下来**。
 *
 * ══ 为什么要快照 ══════════════════════════════════════════
 *
 * 《总体开发指导》§14：「当前 session 使用**开始时锁定的规则**，
 * 新规则从下一 session 开始生效。」
 * 场景是真实的：手机开始练 → 电脑上改了题型 / 每日条数 → 规则同步下来了
 * → **这一轮不该中途换规则**。
 *
 * ══ 为什么落库而不是只放内存 ★★ ═══════════════════════════
 *
 *   ① 手机上练到一半被系统杀掉**是常态**。内存快照一死，
 *      恢复之后**悄悄换成了新规则** —— 而 §14 要防的正是这个。
 *   ② ★ `sessions` **已经在 `SYNC_TABLES` 里**，这一列自动同步到电脑。
 *      否则规则一改，历史数据的可比性**无声地断掉**：
 *      「这一批答案是在哪套题型下产生的」事后说不清（D-349）。
 *
 * ★ 整块存 JSON，**不拆成多列** —— 与 `core/prefs.ts::ARRAY_PREFS_MERGE_WHOLE`
 *   同一条理由：拆开之后跨设备合并会合出**两边都不认**的结果。
 * ★ 拍不下来**不许把开会话带崩** —— 少一列元数据是小事，练不了是大事。
 */
export function startSession(c: StudyCtx, kind: string, scope: string, target: number): number {
  const t = now()
  return Number(
    c.db
      .prepare(
        `insert into sessions (kind, scope, target, started_at, device, rules, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(kind, scope, target, t, deviceCol(c.db), rulesSnapshot(c), t, t).lastInsertRowid
  )
}

/**
 * 这一刻生效的**全部**学习规则，整块 JSON。
 *
 * 收哪些：会改变**出题与判分**的那些 —— 题型勾选、小操练题型、出题顺序，
 * 加上七个 `param.*`（清单以 `core/prefs.ts::PREF_SPECS` 为准）。
 *
 * ★ 不收 TTS / 词典 / AI —— 它们不影响这一轮出什么题、怎么判。
 */
export function rulesSnapshot(c: StudyCtx): string | null {
  try {
    const prefs = new Prefs(c.db)
    return JSON.stringify({
      v: 1,
      qtypes: JSON.parse(prefs.get('qtypes', '[]')) as unknown,
      practiceOrder: JSON.parse(prefs.get('practice_order', 'null')) as unknown,
      params: c.params.effective()
    })
  } catch {
    // 拍不下来就留空 —— 「不知道」是事实，不要编一个
    return null
  }
}

/** 首页状态行 · D-028 —— 如实显示欠账，不催、不弹窗。 */
export function overview(c: StudyCtx): {
  lectures: number
  dueLectures: number
  worstOverdue: number
  dueCards: number
  reviewLectures: number
} {
  const t = now()
  const lectures = c.db
    .prepare(`select due_at as dueAt from lectures where deleted_at is null and status = 'training'`)
    .all() as { dueAt: number | null }[]
  /**
   * ★ SC-02 / ST-Q3 · **partial** —— 「有一部分，其余在路上」这一态首页一直没说
   *   （UI_STATE_MATRIX §四 那一行点名的缺口）。分析完了停在「待审阅」的讲次
   *   是这条链上最容易断掉的一环：AI 跑完了，人没去过目，于是它既不在轮转里、
   *   也没人提醒。这里只多数一个数，**算法一个字没改**。
   */
  const review = (
    c.db
      .prepare(`select count(*) as n from lectures where deleted_at is null and status = 'review'`)
      .get() as { n: number }
  ).n
  const due = lectures.filter((l) => l.dueAt !== null && l.dueAt <= t)
  const worst = due.reduce((m, l) => Math.max(m, overdueDays(l.dueAt!, t)), 0)
  const cards = (
    c.db
      .prepare(
        `select count(*) as n from items i ${JOIN_CARD('i')}
            where ${CARD_ACTIVE('i')} and ${CARD_DUE()}`
      )
      .get(t) as { n: number }
  ).n
  return {
    lectures: lectures.length,
    dueLectures: due.length,
    worstOverdue: worst,
    dueCards: cards,
    reviewLectures: review
  }
}

export function log(c: StudyCtx, lectureId: number, event: string, detail: string): void {
  const t = now()
  c.db
    .prepare(
      `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
         values (?, ?, ?, ?, ?)`
    )
    .run(lectureId, event, detail, t, t)
}
