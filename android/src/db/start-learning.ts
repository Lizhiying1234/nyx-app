/**
 * 「这批我看过了 · 开始学」· Android 侧（2026-09-01 · X-Ray 审计 F-001）
 *
 * ══ 为什么会缺这一块 ★★★ ═══════════════════════════════════
 *
 * 在这个文件出现之前，**Android 上没有任何代码把 `lectures.status` 写成
 * `'training'`**。而那个状态是两条队列的**唯一准入**：
 *
 *   `today.ts::loadTodayPlan`  要求 `l.status = 'training'`
 *   `reading.ts::dueCards`     要求 `rc.due_at is not null`
 *   `trg_il_reading_card`      要求那一讲**已经**是 training 才给新收的词排期
 *
 * 于是在手机上收的词，Atlas 说「今天没事做」、讲次页说「今天没有到期的卡」——
 * 必须回电脑点一次「开始学」。
 *
 * 它被漏掉的原因很具体：继承矩阵（已删，结论进 nyx-system/parity/）把 `start-learning` 归进
 * FULL 类，而 FULL 的验收口径是「core 已 import」，于是标成 ✅ ——
 * **那个 ✅ 指判据接上了，不指功能做完了**（同一课见 D-409 完成三态）。
 *
 * ══ 判据一个字都不在这里 ═══════════════════════════════════
 *
 * 排期怎么算 = `core/start-learning.ts::scheduleOnStart`（两端同一份，
 * `tests/core-parity.test.ts` P-11 钉着）。这里只逐字港 Windows
 * `main/study.ts::startLearning`（2765 行文件里那一段）的**平台面**：
 * 两个共用常量 + 读事实 + 写两张表 + 留痕 + 拒绝诊断。
 *
 * ══ 与 Windows 的两处形变（都是平台差异，不是语义差异）★ ═════
 *
 * ① **事务不是 `BEGIN IMMEDIATE`。** Capacitor 插件的 `beginTransaction()`
 *    是普通 BEGIN。Windows 用 IMMEDIATE 是为了「判断 + 写入」之间没有窗口。
 *    这一端拿不到那个原语，所以改成**写完之后校验终态**（见下）——
 *    它比数 changes 更强：断言的是「库现在真的是这个样子」，
 *    而不是「刚才那句话影响了几行」。
 *    ★ 手机上确实存在第二个写者：Assist 引擎用**另一条原生连接**开同一个库文件
 *      （`AssistEngine` 的 `nyxHost.sql`）。它写不进去时 SQLite 会给 BUSY，
 *      不会写坏；而真出了怪事，下面两条断言会当场炸。
 *
 * ② **`Db` 没有 `changes`。** 所以 Windows 那两句 `.changes` 断言换成
 *    等价的终态查询（`status` 变没变 · 还剩几条 `due_at is null`）。
 */
// ★ 2026-09-02：`JOIN_CARD` 原来在本文件里又抄了一份（还抄成了字符串常量）——
//   改成走 core 那一份（F-017 上一轮漏了这个文件）。用 join 不用 left join 的
//   理由写在 `core/sql/reading-card.ts` 里，不在这里重复。
import {
  JOIN_CARD,
  ROTATION_WORDS,
  SILENCE_ACTIONS,
  SILENCE_FILTER_NAME,
  scheduleOnStart
} from '../core-link.ts'
import { effectiveParams } from './practice.ts'
import type { Db } from './types.ts'

/**
 * 结构与 Windows `@shared/api.ts::StartLearningResult` 逐字段一致。
 * ★ 不 import 那份 —— `core-link.ts` 只连 `core/`，`shared/` 是 Electron 侧的契约面。
 */
export type StartLearningRefusal =
  /** 已经在轮转中 —— 间隔和排期一个字都没动 */
  | 'alreadyRunning'
  /** 已归档（silent=1）—— 归档的讲不排期，先去静默库取消归档 */
  | 'archived'
  /** 还不是待审阅（empty 之类）—— 先收点内容进来 */
  | 'notReviewed'
  /** 找不到，或者在回收站里 */
  | 'missing'

export interface StartLearningResult {
  /** 下一次产出练习的日子 */
  dueAt: number
  /** 这一讲的间隔（天）。★ F-2-②：有历史就是原值，不再无条件打回 1 */
  intervalDays: number
  /** 这一讲一共几条知识点 */
  count: number
  /** 这一次拿到首次认读资格的条目数（老条目不算 —— 它们有自己的认读历史） */
  fresh: number
  /** 没放行的话，是**哪一种**没放行。`null` = 真的开始了 */
  refused: StartLearningRefusal | null
  /** 排期为什么是这样 —— 直接显示给他看 */
  reason: string
}

/**
 * ★★ 进轮转的门槛 —— **只有这一份**。
 *
 * 下面的 SELECT（读事实去算排期）和 UPDATE（真正写）共用同一个字符串。
 * 各写各的话，某天有人只在其中一处加条件，另一处就会为一行**根本写不进去**的
 * 讲算出一份排期 —— 而那种错不报警，只是「点了没反应」。
 * （Windows `study.ts` 同名常量，逐字。）
 */
const GATE = `id = ? and status = 'review' and silent = 0 and deleted_at is null`

/**
 * ★★ 「有几条还没拿到认读卡」的判据 —— 也**只有这一份**。
 *
 * 它同时被三处用：数 fresh · 写 `reading_cards.due_at` · 写完之后校验。
 * 界面上说「3 条新表达现在就能认读」，那个 3 必须就是被写的行数。
 * 两处各写一份的话，它们会在某次改动里悄悄分家，而表现是
 * 「界面说 3 条，认读队列里只有 1 条」，没有人查得出来。
 */
const FRESH_WHERE = `rc.due_at is null and rc.silent = 0 and i.deleted_at is null
                     and i.id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`


async function countItems(db: Db, lectureId: number): Promise<number> {
  const r = await db.get(
    `select count(*) as n from item_lectures il join items i on i.id = il.item_id
      where il.lecture_id = ? and i.deleted_at is null`,
    [lectureId]
  )
  return Number(r?.['n'] ?? 0)
}

async function countFresh(db: Db, lectureId: number): Promise<number> {
  const r = await db.get(
    `select count(*) as n from items i ${JOIN_CARD('i')} where ${FRESH_WHERE}`,
    [lectureId]
  )
  return Number(r?.['n'] ?? 0)
}

/** 留痕（Windows `study.ts::log` 逐字）—— `lecture_logs` 是同步表，这一笔会走到电脑上 */
async function log(db: Db, lectureId: number, event: string, detail: string): Promise<void> {
  const t = Date.now()
  await db.run(
    `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [lectureId, event, detail, t, t]
  )
}

/**
 * ★★ 门槛没放行时，**说清楚是哪一种没放行**（Windows `refuseStart` 逐字）。
 *
 * 这一步的 SELECT 是**诊断，不是判据** —— 判据已经由上面那句 UPDATE 的
 * `where` 原子地做完了，这里只是回头看一眼「刚才为什么没命中」。
 *
 * 顺序有讲究：**先看归档**。一个归档过的、原本在轮转中的讲，两个条件都不满足，
 * 而对他有用的那句是「先去取消归档」—— 告诉他「已经在轮转中了」，
 * 他会去轮转里找它，而它不在那里。
 */
async function refuseStart(db: Db, lectureId: number, count: number): Promise<StartLearningResult> {
  const cur = (await db.get(
    `select status, silent, due_at as dueAt, interval_days as iv, deleted_at as deletedAt
       from lectures where id = ?`,
    [lectureId]
  )) as
    | { status: string; silent: number; dueAt: number | null; iv: number; deletedAt: number | null }
    | undefined

  const base = {
    dueAt: Number(cur?.dueAt ?? 0),
    intervalDays: Number(cur?.iv ?? 0),
    count,
    fresh: 0
  }

  if (!cur || cur.deletedAt !== null) {
    return {
      ...base,
      refused: 'missing',
      reason: '找不到这个 Lecture —— 它可能刚被删掉了。去回收站看看能不能恢复。'
    }
  }
  if (Number(cur.silent) === 1) {
    return {
      ...base,
      refused: 'archived',
      reason:
        `这个 Lecture 已经${SILENCE_ACTIONS.shelve}了 —— ${SILENCE_ACTIONS.shelve}的不排期，所以没法开始学。` +
        `想重新练它，先去 Vault 的「${SILENCE_FILTER_NAME}」里${SILENCE_ACTIONS.restore}，进度会原样回来。`
    }
  }
  if (cur.status === 'training') {
    return {
      ...base,
      refused: 'alreadyRunning',
      reason: `这个 Lecture 已经${ROTATION_WORDS.inPractice}了 —— 没有重新开始，你的间隔和排期一个字都没动。`
    }
  }
  return {
    ...base,
    refused: 'notReviewed',
    reason: `这个 Lecture 现在不是「待审阅」（是「${cur.status}」）—— 先收点内容进来，再点开始学。`
  }
}

/**
 * 把一讲放进轮转。
 *
 * @returns `refused === null` = 真的开始了；否则 `reason` 是给他看的那句人话
 */
export async function startLearning(db: Db, lectureId: number): Promise<StartLearningResult> {
  const t = Date.now()
  const cfg = (await effectiveParams(db)).lecture

  await db.begin()
  try {
    // ── 先把库里当前的事实读出来，再让纯函数决定排期（F-2-②）─────
    const row = (await db.get(
      `select interval_days as interval, due_at as dueAt from lectures where ${GATE}`,
      [lectureId]
    )) as { interval: number; dueAt: number | null } | undefined

    if (!row) {
      const out = await refuseStart(db, lectureId, await countItems(db, lectureId))
      await db.commit() // 只读了，没写；提交比回滚更诚实（回滚会让日志以为出过错）
      return out
    }

    const fresh = await countFresh(db, lectureId)

    // ★ 判据在 core，两端同一份
    const plan = scheduleOnStart(
      { interval: Number(row.interval), dueAt: row.dueAt === null ? null : Number(row.dueAt), fresh, now: t },
      cfg
    )

    await db.run(
      `update lectures set status = 'training', interval_days = ?, due_at = ?, updated_at = ?
        where ${GATE}`,
      [plan.interval, plan.dueAt, t, lectureId]
    )

    /**
     * ★★ 终态断言①：上面刚 SELECT 到，这里 UPDATE 却没生效 ——
     * 在一个事务里这不该发生。真发生了就说明库出了别的问题，**当场炸**，
     * 别把「什么都没写」伪装成一次成功的开始学。
     */
    const after = await db.get(`select status from lectures where id = ?`, [lectureId])
    if (String(after?.['status'] ?? '') !== 'training') {
      throw new Error('开始学：状态在同一个事务里没有写成 training，这一步没有生效')
    }

    const count = await countItems(db, lectureId)

    // 新条目的认读卡立刻可练 —— 首轮认读就是它们的第一次复习，不是额外加出来的东西
    await db.run(
      `update reading_cards set due_at = ?, updated_at = ?
        where id in (select rc.id from items i ${JOIN_CARD('i')} where ${FRESH_WHERE})`,
      [t, t, lectureId]
    )

    /**
     * ★★ 终态断言②：说好给 `fresh` 条排认读，那么写完之后**一条都不该剩**。
     * （Windows 那边是比 `changes === fresh`；这一端没有 changes，
     *   于是断言更强的那一面：剩余量必须归零。）
     */
    const left = await countFresh(db, lectureId)
    if (left !== 0) {
      throw new Error(`开始学：说好给 ${fresh} 条新知识点排认读，写完还剩 ${left} 条没排上`)
    }

    await log(db, lectureId, 'reviewed', `审阅完成，${count} 条${ROTATION_WORDS.schedule} —— ${plan.reason}`)
    await db.commit()

    return {
      dueAt: plan.dueAt,
      intervalDays: plan.interval,
      count,
      fresh,
      refused: null,
      reason: plan.reason
    }
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
}
