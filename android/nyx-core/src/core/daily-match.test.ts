import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchToday, type DueLecture } from './daily-match.ts'

const L = (id: number, day: number, pending: number): DueLecture => ({
  lectureId: id,
  dueAt: new Date(2026, 7, day).getTime(),
  pending
})

describe('半数规则（D-027）', () => {
  it('lecture 整取，不截断 —— 实际条数可以超过目标', () => {
    const r = matchToday(35, [L(1, 1, 20), L(2, 2, 19)])
    assert.equal(r.total, 39, '20 + 19 = 39，超过目标 35 是预期行为')
    assert.equal(r.picked.length, 2)
  })

  it('剩余额度不到下一个 lecture 的一半 → 停止', () => {
    // 收下 20 之后剩 15，下一个 40 条的一半是 20 > 15，停
    const r = matchToday(35, [L(1, 1, 20), L(2, 2, 40)])
    assert.equal(r.total, 20)
    assert.equal(r.picked.length, 1)
    assert.match(r.reason, /不到它的一半/)
  })

  it('剩余额度刚好等于一半 → 收下（判据是 ≥）', () => {
    const r = matchToday(35, [L(1, 1, 20), L(2, 2, 30)])
    assert.equal(r.total, 50, '剩 15，30 的一半正好是 15，应该收下')
  })

  it('停就是停，不跳过它去凑后面更小的', () => {
    const r = matchToday(20, [L(1, 1, 10), L(2, 2, 40), L(3, 3, 4)])
    assert.equal(r.picked.length, 1)
    assert.equal(r.total, 10, '不该跳过 L2 去把 L3 捡回来 —— D-027 写的是「否则停止」')
  })
})

describe('按到期次序（D-027）', () => {
  it('先到期的先收，与传入顺序无关', () => {
    const r = matchToday(100, [L(3, 5, 5), L(1, 1, 5), L(2, 3, 5)])
    assert.deepEqual(
      r.picked.map((l) => l.lectureId),
      [1, 2, 3]
    )
  })
})

describe('空 lecture 不许收（I-025）', () => {
  it('待练条目为 0 的 lecture 直接跳过', () => {
    const r = matchToday(35, [L(1, 1, 0), L(2, 2, 12)])
    assert.deepEqual(
      r.picked.map((l) => l.lectureId),
      [2],
      '收了一条待练条目都没有的 lecture —— 点进去会是空的'
    )
    assert.equal(r.total, 12)
  })

  it('全都是空的 → 今天没得练，而且说得出来', () => {
    const r = matchToday(35, [L(1, 1, 0), L(2, 2, 0)])
    assert.equal(r.total, 0)
    assert.equal(r.picked.length, 0)
    assert.match(r.reason, /没有到期/)
  })
})

describe('为什么今天是这个数', () => {
  it('任何情况下都给得出理由', () => {
    for (const due of [[], [L(1, 1, 5)], [L(1, 1, 80)], [L(1, 1, 5), L(2, 2, 90)]]) {
      assert.ok(matchToday(35, due).reason.length > 0)
    }
  })
})
