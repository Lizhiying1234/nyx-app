import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dueAfter, nextLectureInterval, overdueDays } from './sm2-lecture.ts'

describe('lecture 间隔扩张（D-017）', () => {
  it('正确率低于 50% → 打回 1 天', () => {
    const r = nextLectureInterval(16, 0.4, 30)
    assert.equal(r.interval, 1)
    assert.match(r.reason, /低于 50%/)
  })

  it('50–75% → ×1.2', () => {
    assert.equal(nextLectureInterval(10, 0.6, 30).multiplier, 1.2)
    assert.equal(nextLectureInterval(10, 0.6, 30).interval, 12)
  })

  it('75–90% → ×2.0（含 90% 本身）', () => {
    assert.equal(nextLectureInterval(10, 0.8, 30).multiplier, 2.0)
    assert.equal(nextLectureInterval(10, 0.9, 30).multiplier, 2.0, '90% 应落在 75–90 这一档')
  })

  it('高于 90% → ×2.6', () => {
    assert.equal(nextLectureInterval(10, 0.95, 30).multiplier, 2.6)
    assert.equal(nextLectureInterval(10, 0.95, 30).interval, 26)
  })

  it('边界：50% 走 ×1.2，不走「打回」', () => {
    assert.equal(nextLectureInterval(10, 0.5, 30).multiplier, 1.2)
  })

  it('新 lecture（间隔 0）从 1 天起算', () => {
    assert.equal(nextLectureInterval(0, 1.0, 30).interval, 3) // 1 × 2.6 = 2.6 → 3
  })
})

describe('样本不足时间隔不动（D-139）', () => {
  it('本次只练了 4 条 → 间隔不动，且说明原因', () => {
    const r = nextLectureInterval(16, 0.25, 4)
    assert.equal(r.interval, 16, '4 条的正确率不该决定 30 条 lecture 的排期')
    assert.equal(r.changed, false)
    assert.match(r.reason, /样本太小/)
  })

  it('刚好 5 条就正常算', () => {
    assert.equal(nextLectureInterval(16, 0.25, 5).interval, 1)
  })
})

describe('到期日计算', () => {
  it('dueAfter 落在当天零点，同一天不会反复到期', () => {
    const t = dueAfter(3, new Date('2026-08-03T14:32:00').getTime())
    const d = new Date(t)
    assert.equal(d.getDate(), 6)
    assert.equal(d.getHours(), 0)
    assert.equal(d.getMinutes(), 0)
  })

  it('overdueDays 按自然日算，不受时分秒影响', () => {
    const due = new Date('2026-08-01T23:59:00').getTime()
    const now = new Date('2026-08-03T00:01:00').getTime()
    assert.equal(overdueDays(due, now), 2)
  })

  it('还没到期的返回负数', () => {
    const due = new Date('2026-08-10T00:00:00').getTime()
    const now = new Date('2026-08-03T12:00:00').getTime()
    assert.equal(overdueDays(due, now), -7)
  })
})
