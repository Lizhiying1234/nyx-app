/**
 * 今日排期（Atlas hero）—— **判据只有一份**：
 *   半数规则/整取/reason 全在 `core/daily-match.ts::matchToday`（direct import，D-365）；
 *   这里只逐字港 Windows `study.ts::todayPlan`（708-727）的**喂数 SQL**：
 *   到期讲次 = status='training' 且 due_at 已到；pending = 该讲产出线
 *   （PRODUCTION_APPLIES：B 层非句子）还在 new/training 的条目数。
 *
 * ★ reason 原样透出（D-356：机制透明 ——「为什么今天是 39 不是 35」要答得出；
 *   它是排期机制的说明，不是成绩）。
 * ★ 目标条数 = settings['param.dailyTarget']（USER 白名单第 3 项，随同步走），
 *   默认 35 —— 逐字沿 Windows `main/params.ts::DEFAULTS.dailyTarget`。
 * ★ PRODUCTION_APPLIES **direct import 自 `core/sql/silence.ts`**
 *   （F-017 · 2026-09-01 上提；此前两端各一份，改一处两台机器算出的
 *   「今日多少条」就会不一样，而且都不报错）。
 */
import { matchToday, PRODUCTION_APPLIES, type DueLecture } from '../core-link.ts'
import { prefNumber, prefSet } from './prefs.ts'
import type { Db } from './types.ts'

/** Windows main/params.ts DEFAULTS.dailyTarget —— 那边的注释就说了别用 core 默认值 */
const DAILY_TARGET_DEFAULT = 35

export interface TodayPlan {
  target: number
  total: number
  reason: string
  lectures: DueLecture[]
}

export async function dailyTarget(db: Db): Promise<number> {
  // ★ 更正（2026-08-30）：USER 偏好在 user_preferences（同步表），不是 settings
  return prefNumber(db, 'param.dailyTarget', DAILY_TARGET_DEFAULT)
}

/** 目标条数的合法区间 —— 太小凑不出一讲，太大等于没有目标（半数规则会全收） */
export const DAILY_TARGET_MIN = 5
export const DAILY_TARGET_MAX = 300

/**
 * 改「今天多少条」（2026-09-01 · X-Ray 审计 F-011）。
 *
 * ★★ 为什么手机上以前改不了：D-408 清查 Settings 时**主动删掉了整个「学习」区**
 *   （「Settings 只应该暴露用户真的需要主动改变的东西」）。那个判断是对的 ——
 *   但删的时候没注意到，**Atlas 主屏最大的那个数正好由这一项决定**，
 *   于是它变成了「最响却改不了」的东西。
 *
 * ★ 所以入口不放回 Settings，放在**它起作用的地方**（Atlas 那个数上长按）——
 *   零新增设置项，完全符合 D-408 那句原话。
 *
 * ★ 它是 USER 偏好（`core/prefs.ts::PREF_SPECS` 白名单第 9 项），
 *   写进 `user_preferences` → **随同步走**，在电脑上改也是同一个值。
 */
export async function setDailyTarget(db: Db, n: number): Promise<number> {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v < DAILY_TARGET_MIN || v > DAILY_TARGET_MAX) {
    throw new Error(`目标条数要在 ${DAILY_TARGET_MIN} ～ ${DAILY_TARGET_MAX} 之间`)
  }
  await prefSet(db, 'param.dailyTarget', String(v))
  return v
}

export async function loadTodayPlan(db: Db, target?: number): Promise<TodayPlan> {
  const t = Date.now()
  const n = target ?? (await dailyTarget(db))
  const rows = (await db.all(
    `select l.id as lectureId, l.due_at as dueAt, l.name,
            (select count(*) from item_lectures il join items i on i.id = il.item_id
              where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null
                and ${PRODUCTION_APPLIES('i')} and i.production_state in ('new','training')) as pending
       from lectures l
      where l.deleted_at is null and l.status = 'training'
        and l.due_at is not null and l.due_at <= ?
      order by l.due_at`,
    [t]
  )) as unknown as DueLecture[]

  const m = matchToday(n, rows)
  return { target: n, total: m.total, reason: m.reason, lectures: m.picked }
}
