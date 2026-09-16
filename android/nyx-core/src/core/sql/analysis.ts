/**
 * 「待分析」判据在查询层的**翻译** · T-7.8（2026-09-05）
 *
 * 和 `core/sql/silence.ts` 同一个形状、同一条理由：判据只有一份，SQL 只是它的翻译。
 *
 * ```
 * Domain（这一句话）              「还没写过完整解析的，按类别排队」
 *         ↓ 翻译
 * SQL（本文件）                  ANALYSIS_SCOPE_COND · NO_FULL_ANALYSIS · PENDING_ANALYSIS_SQL
 *         ↓ 引用
 * Windows: study.ts::pendingAnalysis / analysisCounts
 * Android: 讲次批量分析的队列（D-R22，第六轮）
 * ```
 *
 * ── 为什么必须只有这一份 ──────────────────────────────────
 *
 * 队列判据和"待分析 N 条"那个数字**必须是同一句 SQL**。各写一遍的话，
 * 下拉框说还有 12 条、真跑起来只跑了 9 条，而两处代码各自都说得通 ——
 * 这正是 I-104 那条用例最后一句断言守着的东西。
 * 现在再加一台机器（手机），漂的代价从"一个仓库里两处"变成"两台设备算不一样"。
 *
 * ★ SQL 正文是从 `study.ts` **原样搬过来**的，一个字没改：
 *   这一轮是下沉，不是重写。想改判据请另开一轮，并且先想清楚
 *   「库里有没有解析块本身就是进度」这个选择还成不成立（I-104）。
 */
import { PRODUCTION_APPLIES } from './silence.ts'

export type AnalysisScope = 'self' | 'active' | 'passive'

/**
 * 三类各自的条件。
 * 「我的收集」= 自己贴进来的整句（`source='self'` 且不是从别的条目析出来的）。
 */
export const ANALYSIS_SCOPE_COND = (scope: AnalysisScope, t = 'i'): string =>
  scope === 'self'
    ? `${t}.source = 'self' and ${t}.derived_from is null`
    : scope === 'active'
      ? PRODUCTION_APPLIES(t)
      : `${t}.layer = 'A' and not (${t}.source = 'self' and ${t}.derived_from is null)`

/**
 * 「这一条还没写过完整解析」。
 * ★ 只有 `summary` 那一块的**不算**有解析 —— 摘要是另一条线的产物。
 */
export const NO_FULL_ANALYSIS = (t = 'i'): string =>
  `not exists (
              select 1 from analysis_blocks b
               where b.item_id = ${t}.id and b.block <> 'summary'
            )`

/** 待分析队列。参数：`lecture_id` */
export const PENDING_ANALYSIS_SQL = (scope: AnalysisScope): string =>
  `select i.id, i.term from items i
           join item_lectures il on il.item_id = i.id and il.deleted_at is null
          where il.lecture_id = ? and i.deleted_at is null and ${ANALYSIS_SCOPE_COND(scope)}
            and ${NO_FULL_ANALYSIS()}
          order by i.id`

/** 这一类一共多少条（「待分析 N / 共 M 条」里的分母）。参数：`lecture_id` */
export const ANALYSIS_TOTAL_SQL = (scope: AnalysisScope): string =>
  `select count(*) as n from items i join item_lectures il on il.item_id = i.id and il.deleted_at is null
              where il.lecture_id = ? and i.deleted_at is null and ${ANALYSIS_SCOPE_COND(scope)}`
