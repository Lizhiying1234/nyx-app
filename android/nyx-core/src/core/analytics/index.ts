/**
 * Learning Evidence 层 · 入口 · T-4.12（2026-09-07）
 *
 * ── 这一层是什么 ────────────────────────────────────────────
 *
 * **人做过的事**，从八张既有事件表（`review_logs · answers · questions · sessions ·
 * state_events · item_events · lecture_logs · ops_log`）聚合出来。
 * 取数判据在 `core/sql/analytics.ts`，本目录只有纯函数 —— 一行 SQL、一行 IO 都没有。
 *
 * ── 这一层**不是**什么 ──────────────────────────────────────
 *
 *   · 不是 Knowledge Analysis（`analysis_blocks`，AI 对词写的解析）
 *   · 不是水平判断（那一层 D-467 整块取消了，判层用固定基线 `@core/level-baseline.ts`）
 *   · 不是数据仓 / 埋点系统：**不新增表、不新增列、不动同步指纹**（归档 d 十二问 12）
 *   · 不产出评价词，也不叫 AI 写报告文字（归档 d §K）
 *
 * ── 谁消费 ──────────────────────────────────────────────────
 *
 *   Windows · `main/analytics.ts` → 分析报告独立页（T-4.11）
 *   Android · 不显示（D-348 手机不做统计与分析）；判据仍放 core，
 *             将来手机「我」页那两个数要和电脑上的**同一份**算出来。
 */

import { activity, trend } from './activity.ts'
import { evidence, strong, weak } from './evidence.ts'
import { changes } from './changes.ts'
import { funnel, topLookups } from './funnel.ts'
import { performance } from './performance.ts'
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds.ts'
import { why } from './why.ts'
import type { AnalyticsView, EvidenceInput, Range } from './types.ts'

export * from './types.ts'
export * from './thresholds.ts'
export { evidence, weak, strong, PASS_GRADE, LAPSE_GRADE, DUPLICATE_REVIEW_LINE, termIndex } from './evidence.ts'
export { activity, trend, day0, readingReviews } from './activity.ts'
export { funnel, topLookups, lastJudgement } from './funnel.ts'
export { why, deviceName, PLAIN_FACT, type WhyView } from './why.ts'
export { performance, UNKNOWN_KEY } from './performance.ts'
export { changes, originOf, UNKNOWN_ORIGIN } from './changes.ts'

/**
 * 一次算完 —— 报告页要的那一份。
 *
 * ★ 顺序有意义：`weak / strong` 吃 `evidence` 的结果，`funnel` 也吃它，
 *   `why` 吃前面全部。各自再算一遍的话，页面上「反复失败 7 条」和
 *   「为什么」里那句「有 6 条反复挂」就会对不上，而两处都说得通。
 */
export function analytics(
  input: EvidenceInput,
  range: Range,
  th: Thresholds = DEFAULT_THRESHOLDS,
  /** 取数实际取到哪一天（周对周要多取一窗）—— 见 `trend` */
  loadedFrom: number = range.from
): AnalyticsView {
  const ev = evidence(input, range)
  const w = weak(ev, th)
  const s = strong(ev, th)
  const act = activity(input, range)
  const fn = funnel(input, ev)
  return {
    range,
    evidence: ev,
    weak: w,
    strong: s,
    activity: act,
    trend: trend(input, range, 7, loadedFrom),
    funnel: fn,
    topLookups: topLookups(input, th.topN),
    performance: performance(input),
    changes: changes(input),
    why: why(input, { range, evidence: ev, weak: w, strong: s, funnel: fn, activity: act }, th)
  }
}
