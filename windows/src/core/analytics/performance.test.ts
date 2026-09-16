import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { changes, originOf, UNKNOWN_ORIGIN } from './changes.ts'
import { performance, UNKNOWN_KEY } from './performance.ts'
import { emptyInput } from './types.ts'
import type { EvidenceInput, PerformanceCell } from './types.ts'

/**
 * T-4.11 · 报告页新增那两块的判据（表现 · 知识点变化）。
 *
 * 守的是同样几件事：两条线不合成 · 只认第一次判定 · 认读没有题型 ·
 * 没样本是 null 不是 0 · `detail` 解不出来不许把整块报废。
 */

const DAY = 86_400_000
const NOW = new Date('2026-09-07T20:00:00').getTime()
const PHONE = '5d0580fd'

const rows: EvidenceInput = {
  ...emptyInput(),
  items: [
    { id: 1, term: 'a', layer: 'B', state: 'training', createdAt: NOW - 20 * DAY },
    { id: 2, term: 'b', layer: 'A', state: 'new', createdAt: NOW - 20 * DAY }
  ],
  questions: [
    { id: 11, itemId: 1, type: '造句', usedAt: NOW - 5 * DAY },
    { id: 12, itemId: 1, type: '改写', usedAt: NOW - 4 * DAY }
  ],
  answers: [
    { id: 1, itemId: 1, questionId: 11, grade: 4, isFirst: 1, durationMs: null, device: PHONE, at: NOW - 5 * DAY },
    { id: 2, itemId: 1, questionId: 12, grade: 2, isFirst: 1, durationMs: null, device: PHONE, at: NOW - 4 * DAY },
    // 改到过关：不进任何正确率（D-121）
    { id: 3, itemId: 1, questionId: 12, grade: 4, isFirst: 0, durationMs: null, device: PHONE, at: NOW - 4 * DAY },
    // 没有题的那一条（题被清过 / 手机直接判的）—— 单列 unknown，不猜题型
    { id: 4, itemId: 2, questionId: null, grade: 3, isFirst: 1, durationMs: null, device: PHONE, at: NOW - 3 * DAY }
  ],
  reviews: [
    { id: 1, itemId: 1, line: 'reading', grade: 1, durationMs: null, device: PHONE, at: NOW - 2 * DAY },
    { id: 2, itemId: 2, line: 'reading', grade: 4, durationMs: null, device: PHONE, at: NOW - 2 * DAY },
    // 产出判分的另一半 —— 认读那边不许再数一次
    { id: 3, itemId: 1, line: 'production', grade: 4, durationMs: null, device: PHONE, at: NOW - 5 * DAY }
  ],
  stateEvents: [
    { id: 1, itemId: 1, line: 'production', fromState: 'new', toState: 'training', at: NOW - 6 * DAY },
    { id: 2, itemId: 2, line: 'production', fromState: 'new', toState: 'training', at: NOW - 6 * DAY },
    { id: 3, itemId: 1, line: 'production', fromState: 'training', toState: 'silent', at: NOW - DAY }
  ],
  itemEvents: [
    { id: 1, itemId: 1, kind: 'analyzed', detail: JSON.stringify({ origin: 'android' }), at: NOW - 3 * DAY },
    { id: 2, itemId: 2, kind: 'analyzed', detail: '不是 JSON', at: NOW - 3 * DAY },
    { id: 3, itemId: 2, kind: 'edited', detail: '{}', at: NOW - 2 * DAY }
  ],
  lectureLogs: [
    { id: 1, lectureId: 1, event: 'practiced', detail: '正确率 62%', at: NOW - 3 * DAY },
    { id: 2, lectureId: 1, event: 'analyzed', detail: '', at: NOW - 3 * DAY }
  ]
}

const at = (cells: PerformanceCell[], key: string): PerformanceCell => cells.find((c) => c.key === key)!

describe('T-4.11 · 表现（按层级 / 题型）', () => {
  const p = performance(rows)

  it('空库不炸，四张表全是空的', () => {
    const e = performance(emptyInput())
    assert.deepEqual(e.production.byLayer, [])
    assert.deepEqual(e.production.byType, [])
    assert.deepEqual(e.reading.byLayer, [])
  })

  it('产出按层级：只认第一次判定（改到过关那次不算）', () => {
    assert.equal(at(p.production.byLayer, 'B').attempts, 2)
    assert.equal(at(p.production.byLayer, 'B').passes, 1)
    assert.equal(at(p.production.byLayer, 'B').rate, 0.5)
    assert.equal(at(p.production.byLayer, 'A').attempts, 1)
  })

  it('产出按题型：对不上题的单列 unknown，不猜', () => {
    assert.equal(at(p.production.byType, '造句').passes, 1)
    assert.equal(at(p.production.byType, '改写').passes, 0)
    assert.equal(at(p.production.byType, UNKNOWN_KEY).attempts, 1)
  })

  it('★★ 认读线单独一张，且不数产出判分那一半', () => {
    assert.equal(at(p.reading.byLayer, 'B').attempts, 1, '★★ production 那一行被数进认读了')
    assert.equal(at(p.reading.byLayer, 'B').passes, 0, '忘了 = 没过')
    assert.equal(at(p.reading.byLayer, 'A').passes, 1)
  })

  it('★ 认读没有「按题型」这张表 —— 认读卡不出题，画出来就是凭空造指标', () => {
    assert.equal(Object.keys(p.reading).join(','), 'byLayer')
  })

  it('每一格都带得回具体哪几行', () => {
    assert.deepEqual(
      at(p.production.byType, '造句').refs.map((r) => `${r.table}#${r.id}`),
      ['answers#1']
    )
  })
})

describe('T-4.11 · 知识点变化', () => {
  const c = changes(rows)

  it('空库不炸', () => {
    const e = changes(emptyInput())
    assert.deepEqual(e.transitions, [])
    assert.equal(e.analysed.total, 0)
    assert.equal(e.lectureRuns.n, 0)
  })

  it('状态跳变按 from → to 归堆，多的排前面', () => {
    assert.deepEqual(
      c.transitions.map((t) => `${t.from}→${t.to}:${t.n}`),
      ['new→training:2', 'training→silent:1']
    )
    assert.equal(c.transitions[0]!.refs.length, 2)
  })

  it('分析次数只数 kind=analyzed，来源从 detail 里读', () => {
    assert.equal(c.analysed.total, 2, '★ kind=edited 那行不是分析')
    assert.deepEqual(c.analysed.byOrigin, [
      { origin: 'android', n: 1 },
      { origin: UNKNOWN_ORIGIN, n: 1 }
    ])
  })

  it('★ detail 不是 JSON 也不许把整块报废（它是自由字段，不加列）', () => {
    assert.equal(originOf({ id: 9, itemId: 1, kind: 'analyzed', detail: '{坏', at: 0 }), UNKNOWN_ORIGIN)
    assert.equal(originOf({ id: 9, itemId: 1, kind: 'analyzed', detail: '', at: 0 }), UNKNOWN_ORIGIN)
  })

  it('讲次结算只数 practiced 那一种', () => {
    assert.equal(c.lectureRuns.n, 1)
    assert.deepEqual(c.lectureRuns.refs.map((r) => r.table), ['lecture_logs'])
  })
})
