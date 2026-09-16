import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyReadingGrade,
  DEFAULT_READING,
  newCardState,
  penalizeFromHint,
  previewIntervals,
  type CardState
} from './sm2-item.ts'
import type { ReadingGrade } from './types.ts'

function run(grades: ReadingGrade[], start: CardState = newCardState()) {
  let c = start
  const steps = grades.map((g) => {
    const o = applyReadingGrade(c, g)
    c = o.card
    return o
  })
  return { c, steps }
}

describe('认读线 SM-2 · 间隔（D-017）', () => {
  it('第 1 次「会」→ 1 天，第 2 次 → 3 天，之后 = 上次 × E', () => {
    const { steps } = run([3, 3, 3])
    assert.equal(steps[0]!.intervalDays, 1)
    assert.equal(steps[1]!.intervalDays, 3)
    // 第 3 次：3 × 2.5 = 7.5 → 8
    assert.equal(steps[2]!.intervalDays, 8)
  })

  it('「想了一下」→ ×1.2 且 E−0.15', () => {
    const { c: mature } = run([3, 3]) // interval 3, ease 2.5
    const o = applyReadingGrade(mature, 2)
    assert.equal(o.intervalDays, 4) // 3 × 1.2 = 3.6 → 4
    assert.equal(Number(o.card.ease.toFixed(2)), 2.35)
  })

  it('「太简单」→ ×E×1.3 且 E+0.15（E 封顶 2.5）', () => {
    const { c } = run([3, 3]) // interval 3, ease 2.5
    const o = applyReadingGrade(c, 4)
    assert.equal(o.intervalDays, 10) // 3 × 2.5 × 1.3 = 9.75 → 10
    assert.equal(o.card.ease, 2.5, 'E 已经在上限，不该超过 2.5')
  })

  it('「忘了」→ 打回 1 天、E−0.2，但**已累计的正确次数不清零**', () => {
    const { c } = run([3, 3, 3]) // reps 3
    const o = applyReadingGrade(c, 1)
    assert.equal(o.intervalDays, 1)
    assert.equal(o.card.reps, 3, '正确次数被清零了 —— 这是原型「失败即重置」的老毛病')
    assert.equal(o.card.lapses, 1)
    assert.equal(Number(o.card.ease.toFixed(2)), 2.3)
  })

  it('E 不会掉到 1.3 以下', () => {
    let c = newCardState()
    for (let i = 0; i < 20; i++) c = applyReadingGrade(c, 1).card
    assert.equal(c.ease, DEFAULT_READING.minEase)
  })
})

describe('按钮上要标出各自的间隔（D-136）', () => {
  it('四档都给得出数，且是递增的', () => {
    const { c } = run([3, 3])
    const p = previewIntervals(c)
    assert.ok(p[1] <= p[2] && p[2] <= p[3] && p[3] <= p[4], `四档间隔没递增：${JSON.stringify(p)}`)
  })

  it('预览不会改动卡片状态', () => {
    const c = newCardState()
    const before = JSON.stringify(c)
    previewIntervals(c)
    assert.equal(JSON.stringify(c), before)
  })
})

describe('认读线静默 · 超过 180 天（D-135）', () => {
  it('间隔涨过 180 天就静默', () => {
    let c = newCardState()
    let silenced = false
    for (let i = 0; i < 20 && !silenced; i++) {
      const o = applyReadingGrade(c, 4)
      c = o.card
      silenced = o.silenced
    }
    assert.equal(silenced, true, '一直答「太简单」也没静默')
    assert.ok(c.interval > 180)
    assert.equal(c.silent, true)
  })

  it('已静默的卡再排期要炸出来', () => {
    const c: CardState = { ...newCardState(), silent: true }
    assert.throws(() => applyReadingGrade(c, 3), /已经练成/)
  })
})

describe('两条线互相供给证据（D-138 / M-004）', () => {
  it('产出题里点提示 → 认读卡间隔打回，并说清是为什么', () => {
    const { c } = run([3, 3, 3])
    assert.equal(c.interval, 8)
    const o = penalizeFromHint(c)
    assert.equal(o.intervalDays, 1, '点了提示，认读卡该打回 1 天')
    assert.match(o.reason, /点了提示/)
    assert.equal(o.card.reps, 3, '这是认读线失败，不该动已累计的正确次数')
  })
})
