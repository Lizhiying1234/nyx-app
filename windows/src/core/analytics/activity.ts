/**
 * 学习活动 · 按天 / 按小时 / 按设备 + 周对周 · T-4.12（2026-09-07）
 *
 * 「数你做了什么，可以；说你做得怎么样，不行」（D-362 —— 手机那半边早就这么写的）。
 * 本文件只数动作与时长，一个评价词都不产出。
 *
 * ── 三条判据，每条都有具体的病要防 ──────────────────────────
 *
 * ① **产出判分不数两遍**：`review_logs` 里 `line='production'` 那些行与 `answers`
 *    是同一次事件的两半（`main/study/production.ts:659`）。数两遍的话
 *    「今天练了 8 次」会变成 15 次，而且两处代码各自都说得通。
 *
 * ② **时长只算真有计时的行**，并且把「有几行有计时」一起报出来
 *    （真库 13 条 review_logs 里只有 10 条有 `duration_ms`）。
 *    把没计时的当 0 分钟混进平均值，就是拿缺失当事实。
 *
 * ③ **设备归属照抄那一行的 `device`，不猜**。V35 之前的老行没有这个值
 *    （真库 25 条 sessions 里有 12 条是 null）—— 它们落 `unknown` 桶。
 *    猜成本机的后果很具体：他手机上练的账会记到电脑头上，
 *    而报告接下来就会说「你在电脑上学得更多」。
 *
 * 时区：按**本机时区**分天 / 分小时（归档 d §H：报告按本机时区画即可）。
 *
 * ★ 取数层为了「周对周」会**多取一窗**（`main/analytics.ts`），所以这一块自己
 *   把范围外的行滤掉：不滤的话按天那张图是对的（找不到桶就丢），
 *   而 `totals` 与按小时 / 按设备那三份会悄悄把多取的那一窗也算进去 ——
 *   页面上「这 30 天练了 N 次」于是比真相大一截，且哪张图都指不出错在哪。
 */

import { DUPLICATE_REVIEW_LINE, PASS_GRADE } from './evidence.ts'
import {
  UNKNOWN_DEVICE,
  type Activity,
  type ActivityBucket,
  type DayBucket,
  type DeviceBucket,
  type EvidenceInput,
  type HourBucket,
  type Range,
  type Trend,
  type TrendWindow
} from './types.ts'

const DAY = 86_400_000
const MIN = 60_000

/** 当天零点（本机时区）—— 与 `main/report.ts::day0` 同一算法 */
export function day0(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const blank = (): ActivityBucket => ({ answers: 0, reviews: 0, lookups: 0, minutes: 0, timed: 0 })

/** 毫秒攒够了再折成分钟 —— 每桶各自 round 会把误差攒起来 */
const toMinutes = (ms: number): number => Math.round((ms / MIN) * 10) / 10

/** 认读线的判分行（产出那一半在 `answers` 里已经算过一次） */
export const readingReviews = <T extends { line: string }>(rows: T[]): T[] =>
  rows.filter((r) => r.line !== DUPLICATE_REVIEW_LINE)

export function activity(input: EvidenceInput, range: Range): Activity {
  const days = new Map<number, { b: ActivityBucket; ms: number }>()
  for (let d = day0(range.from); d < range.to; d += DAY) days.set(d, { b: blank(), ms: 0 })
  const hours = Array.from({ length: 24 }, () => ({ b: blank(), ms: 0 }))
  const devices = new Map<string, { b: DeviceBucket; ms: number }>()
  const totalMs = { v: 0 }
  const totals = { ...blank(), sessions: 0 }

  const dev = (name: string | null): { b: DeviceBucket; ms: number } => {
    const key = name ?? UNKNOWN_DEVICE
    let cur = devices.get(key)
    if (!cur) devices.set(key, (cur = { b: { device: key, sessions: 0, ...blank() }, ms: 0 }))
    return cur
  }

  const put = (
    at: number,
    device: string | null,
    field: 'answers' | 'reviews' | 'lookups',
    durationMs: number | null
  ): void => {
    if (at < range.from || at >= range.to) return // 多取的那一窗只归趋势用
    const d = days.get(day0(at))
    const h = hours[new Date(at).getHours()]!
    const v = dev(device)
    const ms = durationMs && durationMs > 0 ? durationMs : 0
    for (const bucket of [d, h, v]) {
      if (!bucket) continue
      bucket.b[field] += 1
      bucket.ms += ms
      if (ms > 0) bucket.b.timed += 1
    }
    totals[field] += 1
    totalMs.v += ms
    if (ms > 0) totals.timed += 1
  }

  for (const a of input.answers) put(a.at, a.device, 'answers', a.durationMs)
  for (const r of readingReviews(input.reviews)) put(r.at, r.device, 'reviews', r.durationMs)
  // 查词没有 device 列（`ops_log` 没这一列，归档 d 十二问 6）—— 一律落 unknown，不按别的行去猜
  for (const l of input.lookups) put(l.at, null, 'lookups', null)

  for (const s of input.sessions) {
    if (s.startedAt < range.from || s.startedAt >= range.to) continue
    dev(s.device).b.sessions += 1
    totals.sessions += 1
  }

  const byDay: DayBucket[] = [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, v]) => ({ at, ...v.b, minutes: toMinutes(v.ms) }))
  const byHour: HourBucket[] = hours.map((v, hour) => ({ hour, ...v.b, minutes: toMinutes(v.ms) }))
  const byDevice: DeviceBucket[] = [...devices.values()]
    .map((v) => ({ ...v.b, minutes: toMinutes(v.ms) }))
    .sort((a, b) => b.answers + b.reviews - (a.answers + a.reviews) || a.device.localeCompare(b.device))

  return { byDay, byHour, byDevice, totals: { ...totals, minutes: toMinutes(totalMs.v) } }
}

// ── 周对周 ─────────────────────────────────────────────────

function window_(input: EvidenceInput, from: number, to: number): TrendWindow {
  const inWin = (t: number): boolean => t >= from && t < to
  const answers = input.answers.filter((a) => inWin(a.at))
  const reviews = readingReviews(input.reviews).filter((r) => inWin(r.at))
  const lookups = input.lookups.filter((l) => inWin(l.at))

  let ms = 0
  for (const a of answers) ms += a.durationMs && a.durationMs > 0 ? a.durationMs : 0
  for (const r of reviews) ms += r.durationMs && r.durationMs > 0 ? r.durationMs : 0

  const first = answers.filter((a) => a.isFirst === 1 && a.grade !== null)
  const ok = first.filter((a) => (a.grade ?? 0) >= PASS_GRADE).length

  return {
    from,
    to,
    answers: answers.length,
    reviews: reviews.length,
    lookups: lookups.length,
    minutes: toMinutes(ms),
    firstTry: { n: first.length, ok, rate: first.length === 0 ? null : ok / first.length }
  }
}

/**
 * 这一窗 vs 上一窗（默认 7 天对 7 天）。
 *
 * ★ `partial` 不是装饰：上一窗只要有一部分**没取到**，
 *   「本周翻倍」就可能只是上周没取全。页面必须把它显示出来。
 *
 * @param loadedFrom 取数**实际**取到了哪一天为止（取数层为周对周多取一窗，
 *                   所以它通常比 `range.from` 早；不传就按显示范围算）
 */
export function trend(
  input: EvidenceInput,
  range: Range,
  days = 7,
  loadedFrom: number = range.from
): Trend {
  const curFrom = range.to - days * DAY
  const prevFrom = curFrom - days * DAY
  const current = window_(input, curFrom, range.to)
  const previous = window_(input, prevFrom, curFrom)
  const rate =
    current.firstTry.rate === null || previous.firstTry.rate === null
      ? null
      : current.firstTry.rate - previous.firstTry.rate

  return {
    days,
    current,
    previous,
    partial: prevFrom < loadedFrom,
    delta: {
      answers: current.answers - previous.answers,
      reviews: current.reviews - previous.reviews,
      lookups: current.lookups - previous.lookups,
      minutes: Math.round((current.minutes - previous.minutes) * 10) / 10,
      firstTryRate: rate
    }
  }
}
