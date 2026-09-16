import type { Database } from 'better-sqlite3'
import { EVIDENCE_RANGE_PAIRS, EVIDENCE_SQL, type EvidenceSource } from '@core/sql/analytics.ts'
import { analytics, DEFAULT_THRESHOLDS, type Thresholds } from '@core/analytics/index.ts'
import type { AnalyticsView, EvidenceInput, Range } from '@core/analytics/index.ts'

const DAY = 86_400_000

/** 周对周比的窗口（core 的 `trend` 默认值，这里要跟着它多取一窗） */
export const TREND_DAYS = 7

/** 当天零点 —— 与 `main/report.ts::day0` 同一算法，两页的「一天」要是同一天 */
function day0(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Learning Evidence 的取数层 · T-4.12（2026-09-07）
 *
 * ── 它只做两件事 ────────────────────────────────────────────
 *
 *   ① 照着 `core/sql/analytics.ts` 把行读出来（**一句 SQL 都不在这里写**）
 *   ② 交给 `core/analytics` 的纯函数算
 *
 * 判据一个字都不在本文件里。这样将来手机要算同样的数时，
 * 搬走的是 core 那一份，这里只是一层 30 行的壳（D-238 / D-365）。
 *
 * ── 为什么要多取一窗 ────────────────────────────────────────
 *
 * 「本周 vs 上周」里的上周，可能整个落在显示范围之外（他选了「近 7 天」）。
 * 不多取的话上周永远是 0，页面上就成了「你这周比上周多了一倍」——
 * 一句凭空来的好消息。多取的那一窗**只归趋势用**，`activity` 那边
 * 自己把范围外的行滤掉（见 `core/analytics/activity.ts` 头注）。
 */
export class Learning {
  constructor(private db: Database) {}

  /**
   * 取数。`[from, to)`，毫秒。
   *
   * ★ 参数个数听 `EVIDENCE_RANGE_PAIRS` 的，不在这里数问号 ——
   *   数错了 better-sqlite3 当场抛（`Too few parameter values`），
   *   而更坏的一种是数对了个数、切错了时间段：那不报错。
   */
  load(from: number, to: number): EvidenceInput {
    const out: Record<string, unknown[]> = {}
    for (const [key, sql] of Object.entries(EVIDENCE_SQL)) {
      const args: number[] = []
      for (let i = 0; i < EVIDENCE_RANGE_PAIRS[key as EvidenceSource]; i++) args.push(from, to)
      out[key] = this.db.prepare(sql).all(...args) as unknown[]
    }
    /**
     * ★ 这一步是本文件唯一一处类型上的「相信」：SQL 的 alias 与 `EvidenceInput`
     *   的字段名一一对应（`core/sql/analytics.ts` 头注写着为什么要这样）。
     *   守它的不是类型系统 —— 是 `tests/db-safety/analytics.ts` 那一套：
     *   真库形状跑一遍，逐个数字核。alias 改了名而这里没跟上，那一套当场红。
     */
    return out as unknown as EvidenceInput
  }

  /**
   * 报告页要的那一份。
   *
   * @param days 显示范围（7 / 30 / 180，与 `main/report.ts::build` 同一套）
   */
  build(days = 30, now = Date.now(), th: Thresholds = DEFAULT_THRESHOLDS): AnalyticsView {
    const to = day0(now) + DAY
    const range: Range = { from: to - days * DAY, to }
    const loadedFrom = Math.min(range.from, to - 2 * TREND_DAYS * DAY)
    return analytics(this.load(loadedFrom, to), range, th, loadedFrom)
  }
}
