/**
 * Study · 跟着人走的设置：今日计划 · 每日目标 · 题型勾选 · 练习顺序 —— T-4.6 拆分（2026-09-06）
 *
 * 方法体从 `src/main/study.ts` 原样搬来：`this.<状态>` → `c.<状态>`，
 * `this.<公共方法>` → `c.self.<方法>`，私有方法整个搬进本文件、调用点也在本文件里。
 * ★ 模板字符串里的行一个空格都没动 —— 那里面是 SQL，缩进属于字符串内容。
 * ★ 判断规则一条都不在这里，全在 core/（D-238）：这一层只做
 *   「从库里取状态 → 交给 core 算 → 把结果写回去」。
 */

import { PRODUCTION_APPLIES } from '../db/silence-sql.ts'
import { matchToday, type DueLecture } from '@core/daily-match.ts'
import type { PracticeOrder, TodayPlan } from '@shared/api.ts'
import type { StudyCtx } from './ctx.ts'
import { now } from './util.ts'

/**
 * 今日练习的匹配 · D-027 / D-228 / D-139
 * 判断规则在 core/daily-match.ts，这里只负责把数据喂给它。
 */
export function todayPlan(c: StudyCtx, target?: number): TodayPlan {
  const t = now()
  const n = target ?? c.self.dailyTarget()
  const rows = c.db
    .prepare(
      `select l.id as lectureId, l.due_at as dueAt, l.name,
                (select count(*) from item_lectures il join items i on i.id = il.item_id
                  where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null
                    and ${PRODUCTION_APPLIES('i')} and i.production_state in ('new','training')) as pending
           from lectures l
          where l.deleted_at is null and l.status = 'training'
            and l.due_at is not null and l.due_at <= ?
          order by l.due_at`
    )
    .all(t) as DueLecture[]

  const m = matchToday(n, rows)
  return { target: n, total: m.total, reason: m.reason, lectures: m.picked }
}

export function dailyTarget(c: StudyCtx): number {
  return c.params.effective().dailyTarget
}

/**
 * ★★ V-1 · 走 `ParamStore`，**不再自己写一个键**（2026-08-16）。
 *
 * 以前这里写的是 `settings['daily.target']`，而读的那一侧
 * （`dailyTarget()` → `params.effective()`）读的是 `settings['param.dailyTarget']`——
 * **两个键从不相交**。表现是：他在首页点 +/−，当场那一屏是对的
 * （因为 `todayPlan(target)` 把数字当参数传了），**重开软件就回到 35**，
 * 因为 `load()` 调的是不带参数的 `todayPlan()`。
 *
 * 写了、存了、有人读、但读的是另一个键 —— 全项目 `grep daily.target`
 * 只有那一句 INSERT，零读取。现在首页和设置页共用同一条写入路径，
 * 顺带拿到 `ParamStore` 的上下限钳位。
 */
export function setDailyTarget(c: StudyCtx, n: number): void {
  c.params.set('dailyTarget', n)
}

/**
 * 他勾了哪些题型。没设置过 = 全都要。
 *
 * 存成一行设置而不是一张表：它是**一个偏好**，不是数据。
 * 存成表的话还得管排序、管软删、管同步冲突，为一个复选框列表不值得。
 */
export function qtypes(c: StudyCtx): string[] {
  const known = c.qt.active().map((q) => q.key)
  // ★ Step 5A · 偏好只有一个真相：`user_preferences`（旧的 settings 键已由 V29 搬走并删掉）
  const raw = c.prefs.raw('qtypes')
  // 从来没设置过 = 第一次用，全都要。**这和「他清空了」是两回事**
  if (raw === null) return known
  try {
    const v = JSON.parse(raw) as unknown
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    // 只保留还认识的 —— 他删掉或停用某个题型后，老设置不该把它带回来
    return list.filter((x) => known.includes(x))
  } catch {
    return known
  }
}

export function setQtypes(c: StudyCtx, ids: string[]): void {
  const known = new Set(c.qt.active().map((q) => q.key))
  const on = ids.filter((x) => known.has(x))
  c.prefs.set('qtypes', JSON.stringify(on))
  c.ledger.op('set-qtypes', 'settings', null, null, { n: on.length })
}

/**
 * 出题顺序 · 两层（使用者「出题顺序控制」）
 *
 * 第一层是知识点的先后，第二层是同一条知识点内部题型的先后。
 * 两层分开存，因为它们回答的是两个不同的问题：
 * 「今天先练哪几条」和「这一条先用哪种形式考」。
 */
export function order(c: StudyCtx): PracticeOrder {
  const raw = c.prefs.raw('practice_order')
  const def: PracticeOrder = { items: 'seq', qtypes: 'seq' }
  if (raw === null) return def
  try {
    const v = JSON.parse(raw) as Partial<PracticeOrder>
    return {
      items: v.items === 'random' ? 'random' : 'seq',
      qtypes: v.qtypes === 'random' ? 'random' : 'seq'
    }
  } catch {
    return def
  }
}

export function setOrder(c: StudyCtx, o: PracticeOrder): void {
  const clean: PracticeOrder = {
    items: o.items === 'random' ? 'random' : 'seq',
    qtypes: o.qtypes === 'random' ? 'random' : 'seq'
  }
  c.prefs.set('practice_order', JSON.stringify(clean))
  c.ledger.op('set-practice-order', 'settings', null, null, clean)
}
