import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { activity, day0, trend } from './activity.ts'
import { emptyInput, UNKNOWN_DEVICE } from './types.ts'
import type { AnswerRow, EvidenceInput, LookupRow, ReviewRow, SessionRow } from './types.ts'

/**
 * T-4.12 · 学习活动与周对周。
 *
 * 这一套守三件事，每一件都对着一种**看不见的错**：
 *   ① 产出判分数两遍 → 「他练了多少」当场翻倍
 *   ② 没计时的行当 0 分钟 → 拿缺失当事实
 *   ③ 没有 device 的旧行归给本机 → 手机的账记到电脑头上
 */

const DAY = 86_400_000
const NOW = new Date('2026-09-07T20:00:00').getTime()
const RANGE = { from: NOW - 30 * DAY, to: NOW }
const PHONE = '5d0580fd'
const PC = 'aa11bb22'

/** 某天的某个钟点（本机时区）—— 按小时分桶那条必须用本机时区造数据 */
const at = (daysAgo: number, hour: number): number => {
  const d = new Date(NOW - daysAgo * DAY)
  d.setHours(hour, 30, 0, 0)
  return d.getTime()
}

const answer = (id: number, when: number, over: Partial<AnswerRow> = {}): AnswerRow => ({
  id,
  itemId: 1,
  questionId: null,
  grade: 3,
  isFirst: 1,
  durationMs: null,
  device: PHONE,
  at: when,
  ...over
})

const review = (id: number, when: number, over: Partial<ReviewRow> = {}): ReviewRow => ({
  id,
  itemId: 1,
  line: 'reading',
  grade: 3,
  durationMs: null,
  device: PHONE,
  at: when,
  ...over
})

const lookup = (id: number, when: number): LookupRow => ({ id, title: 'tangle up', detail: null, at: when })

const session = (id: number, when: number, device: string | null): SessionRow => ({
  id,
  kind: 'production',
  scope: '',
  device,
  startedAt: when,
  finishedAt: when + 60_000
})

const input = (over: Partial<EvidenceInput>): EvidenceInput => ({ ...emptyInput(), ...over })

describe('T-4.12 · 活动（按天 / 按小时 / 按设备）', () => {
  it('空库不炸：每一天都在，全是 0', () => {
    const a = activity(emptyInput(), RANGE)
    assert.equal(a.byDay.length, 31)
    assert.equal(a.byDay[0]!.at, day0(RANGE.from))
    assert.equal(a.byHour.length, 24)
    assert.deepEqual(a.byDevice, [])
    assert.deepEqual(a.totals, { answers: 0, reviews: 0, lookups: 0, minutes: 0, timed: 0, sessions: 0 })
  })

  it('★★ 产出判分不数两遍 —— review_logs 里 production 那一行跳过', () => {
    const a = activity(
      input({
        answers: [answer(1, at(2, 10))],
        reviews: [review(1, at(2, 10), { line: 'production' }), review(2, at(2, 11))]
      }),
      RANGE
    )
    assert.equal(a.totals.answers, 1)
    assert.equal(a.totals.reviews, 1, '★★ 数成 2 就等于把同一次作答数了两遍')
  })

  it('时长只算真有计时的行，并且报出「有几行有计时」', () => {
    const a = activity(
      input({
        answers: [answer(1, at(1, 9), { durationMs: 90_000 }), answer(2, at(1, 9), { durationMs: null })],
        reviews: [review(1, at(1, 9), { durationMs: 30_000 })]
      }),
      RANGE
    )
    assert.equal(a.totals.minutes, 2)
    assert.equal(a.totals.timed, 2, '★ 没计时的那一行不许算成 0 分钟混进来')
    assert.equal(a.totals.answers, 2)
  })

  it('按小时分桶用本机时区', () => {
    const a = activity(input({ answers: [answer(1, at(3, 22)), answer(2, at(4, 22)), answer(3, at(5, 7))] }), RANGE)
    assert.equal(a.byHour[22]!.answers, 2)
    assert.equal(a.byHour[7]!.answers, 1)
    assert.equal(a.byHour[0]!.answers, 0)
  })

  it('按天分桶：同一天的落一格', () => {
    const a = activity(input({ answers: [answer(1, at(3, 9)), answer(2, at(3, 21))] }), RANGE)
    const d = a.byDay.find((x) => x.at === day0(at(3, 9)))!
    assert.equal(d.answers, 2)
  })

  it('★★ 设备照抄，没有 device 的行落 unknown（V35 之前的旧行）', () => {
    const a = activity(
      input({
        answers: [answer(1, at(2, 10)), answer(2, at(2, 11), { device: PC }), answer(3, at(2, 12), { device: null })],
        sessions: [session(1, at(2, 10), PHONE), session(2, at(2, 11), null)]
      }),
      RANGE
    )
    const byName = new Map(a.byDevice.map((d) => [d.device, d]))
    assert.equal(byName.get(PHONE)!.answers, 1)
    assert.equal(byName.get(PC)!.answers, 1)
    assert.equal(byName.get(UNKNOWN_DEVICE)!.answers, 1, '★★ 旧行被归给某台真设备了')
    assert.equal(byName.get(PHONE)!.sessions, 1)
    assert.equal(byName.get(UNKNOWN_DEVICE)!.sessions, 1)
    assert.equal(a.totals.sessions, 2)
  })

  it('查词没有 device 列 —— 一律落 unknown，不拿别的行去猜', () => {
    const a = activity(input({ lookups: [lookup(1, at(2, 10)), lookup(2, at(2, 11))] }), RANGE)
    assert.deepEqual(a.byDevice.map((d) => d.device), [UNKNOWN_DEVICE])
    assert.equal(a.byDevice[0]!.lookups, 2)
  })

  it('★★ 多取的那一窗不算进活动 —— 取数为周对周会多取一窗', () => {
    const short = { from: NOW - 7 * DAY, to: NOW }
    const a = activity(
      input({
        answers: [answer(1, at(2, 10)), answer(2, at(9, 10), { device: 'ghost' })],
        sessions: [session(1, at(9, 10), 'ghost')],
        lookups: [lookup(1, at(9, 12))]
      }),
      short
    )
    assert.equal(a.totals.answers, 1, '★★ 范围外那一行漏进了总数')
    assert.equal(a.totals.lookups, 0)
    assert.equal(a.totals.sessions, 0)
    assert.equal(a.byHour[10]!.answers, 1)
    assert.ok(!a.byDevice.some((d) => d.device === 'ghost'), '★★ 范围外那一行漏进了按设备')
  })

  it('真库形状：练习事件全部来自手机，一台设备一行', () => {
    const a = activity(
      input({ answers: [answer(1, at(2, 10))], reviews: [review(1, at(2, 11))] }),
      RANGE
    )
    assert.deepEqual(a.byDevice.map((d) => d.device), [PHONE])
  })
})

describe('T-4.12 · 周对周', () => {
  const rows = input({
    answers: [
      answer(1, at(1, 10), { grade: 4 }),
      answer(2, at(2, 10), { grade: 2 }),
      answer(3, at(9, 10), { grade: 2 }),
      answer(4, at(10, 10), { grade: 2 })
    ],
    reviews: [review(1, at(3, 10)), review(2, at(11, 10), { line: 'production' })],
    lookups: [lookup(1, at(1, 12))]
  })

  it('这一窗 vs 上一窗，各自数各自的', () => {
    const t = trend(rows, RANGE)
    assert.equal(t.days, 7)
    assert.equal(t.current.answers, 2)
    assert.equal(t.previous.answers, 2)
    assert.equal(t.current.reviews, 1)
    assert.equal(t.previous.reviews, 0, '★ 上一窗那一行是 production，不算认读')
    assert.equal(t.current.lookups, 1)
  })

  it('正确率只用第一次判定，两窗都有样本才给差值', () => {
    const t = trend(rows, RANGE)
    assert.equal(t.current.firstTry.rate, 0.5)
    assert.equal(t.previous.firstTry.rate, 0)
    assert.equal(t.delta.firstTryRate, 0.5)
  })

  it('一边没样本时差值是 null，不是 0', () => {
    const t = trend(input({ answers: [answer(1, at(1, 10), { grade: 4 })] }), RANGE)
    assert.equal(t.previous.firstTry.rate, null)
    assert.equal(t.delta.firstTryRate, null)
  })

  it('★ 上一窗没取全要标出来 —— 否则「本周翻倍」可能只是上周没取', () => {
    const short = { from: NOW - 10 * DAY, to: NOW }
    assert.equal(trend(rows, short).partial, true)
    assert.equal(trend(rows, RANGE).partial, false)
  })

  it('取数多取了一窗的话，partial 认取到哪天，不认显示范围', () => {
    const short = { from: NOW - 7 * DAY, to: NOW }
    assert.equal(trend(rows, short, 7, NOW - 21 * DAY).partial, false)
    assert.equal(trend(rows, short, 7, short.from).partial, true)
  })
})
