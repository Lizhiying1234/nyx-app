import { SILENCE_FILTER_NAME } from './silence.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyGrade, explainDistance, newItemProgress, type ItemProgress } from './grading.ts'
import type { Grade } from './types.ts'

/** 连着判几次，返回最后的进度与每一步的结果。 */
function run(grades: Grade[], start: ItemProgress = newItemProgress()) {
  let p = start
  const steps = grades.map((g) => {
    const o = applyGrade(p, g)
    p = o.progress
    return o
  })
  return { p, steps, last: steps[steps.length - 1]! }
}

describe('四档判分 · 哪几档算正确（D-133 / M-017）', () => {
  it('第 3、4 档算正确', () => {
    assert.equal(applyGrade(newItemProgress(), 3).correct, true)
    assert.equal(applyGrade(newItemProgress(), 4).correct, true)
  })

  it('第 1、2 档算失败 —— 第 2 档是这套方法要消灭的东西本身', () => {
    assert.equal(applyGrade(newItemProgress(), 1).correct, false)
    assert.equal(applyGrade(newItemProgress(), 2).correct, false)
  })

  it('第 4 档不额外加速，只记入档案（D-133）', () => {
    const a = run([4, 4])
    const b = run([3, 3])
    assert.equal(a.p.streak, b.p.streak)
  })
})

describe('建立期 · 前 3 次的第 2 档不清零（D-226）', () => {
  it('建立期内：正确 → 第 2 档 → 正确，连续正确应该是 2 而不是 1', () => {
    const { p, steps } = run([3, 2, 3])
    assert.equal(steps[1]!.graced, true, '第 2 次应该落在建立期里')
    assert.equal(p.streak, 2, `第 2 档不该清零，实际 streak=${p.streak}`)
  })

  it('建立期内的第 1 档照样清零 —— 宽限只给第 2 档', () => {
    const { p, steps } = run([3, 1])
    assert.equal(steps[1]!.graced, false)
    assert.equal(p.streak, 0)
  })

  it('第 4 次起恢复正常清零（D-133）', () => {
    // 前三次用掉建立期，第 4 次再吃第 2 档就该清零
    const { p, steps } = run([3, 3, 2, 2])
    assert.equal(steps[2]!.graced, true, '第 3 次仍在建立期')
    assert.equal(steps[3]!.graced, false, '第 4 次不该再有宽限')
    assert.equal(p.streak, 0)
  })

  it('没有建立期的话，早期条目会大量涌进攻坚区 —— 这就是 D-226 存在的理由', () => {
    // 一条「一直不地道」的条目：五次全是第 2 档
    const withGrace = run([2, 2, 2, 2, 2])
    assert.equal(withGrace.p.state, 'hard', '五次不过还是该进攻坚区')
    // 但建立期让它在前三次没有被反复清零，streak 的语义才是干净的
    assert.equal(withGrace.steps[0]!.graced, true)
    assert.equal(withGrace.steps[2]!.graced, true)
    assert.equal(withGrace.steps[3]!.graced, false)
  })
})

describe('静默 · 连续 3 次正确（M-023 / D-017）', () => {
  it('连续 3 次第 3 档以上 → 静默', () => {
    const { p, last } = run([3, 3, 3])
    assert.equal(p.state, 'silent')
    assert.equal(last.silenced, true)
    assert.match(last.reason, /练成了/)
  })

  it('中间断一次就不算连续', () => {
    // 用第 1 档确保清零（第 2 档在建立期内会被豁免）
    const { p } = run([3, 1, 3, 3])
    assert.equal(p.state, 'training')
    assert.equal(p.streak, 2)
  })

  it('已静默的条目再判分要炸出来，不许悄悄改（D-024）', () => {
    const { p } = run([3, 3, 3])
    assert.throws(() => applyGrade(p, 3), /不用再练/)
  })
})

describe('攻坚区 · 进与出（D-025 / D-166）', () => {
  it('本讲练满 5 次仍没做到 3 连 → 进攻坚区', () => {
    const { p, last } = run([1, 1, 1, 1, 1])
    assert.equal(p.state, 'hard')
    assert.equal(last.enteredHard, true)
    assert.equal(p.hardEntries, 1)
  })

  it('第 5 次刚好凑成 3 连的话，是静默，不是攻坚 —— 静默优先', () => {
    const { p, last } = run([1, 1, 3, 3, 3])
    assert.equal(p.state, 'silent')
    assert.equal(last.silenced, true)
    assert.equal(last.enteredHard, false)
  })

  it('攻坚区里 3 连正确 → 回原 lecture，**不直接静默**（D-166）', () => {
    const start = run([1, 1, 1, 1, 1]).p
    assert.equal(start.state, 'hard')
    const { p, last } = run([3, 3, 3], start)
    assert.equal(p.state, 'training', '攻坚区达标只该回到训练中')
    assert.equal(last.leftHard, true)
    assert.equal(last.silenced, false)
    assert.equal(p.streak, 0, '高提示环境下的连续正确不该带回正常轮转')
  })

  it('攻出去之后还能再进 —— 次数累计，进过两次以上值得复核判层', () => {
    let p = run([1, 1, 1, 1, 1]).p // 第 1 次进
    p = run([3, 3, 3], p).p // 攻出来
    p = run([1, 1, 1, 1, 1], p).p // 第 2 次进
    assert.equal(p.state, 'hard')
    assert.equal(p.hardEntries, 2)
  })
})

describe('每一步都要说得出为什么', () => {
  it('applyGrade 的 reason 不为空', () => {
    for (const g of [1, 2, 3, 4] as Grade[]) {
      assert.ok(applyGrade(newItemProgress(), g).reason.length > 0)
    }
  })

  it('explainDistance 覆盖四种状态', () => {
    assert.match(explainDistance(newItemProgress()), /还没练过/)
    assert.match(explainDistance(run([3]).p), /连续 1\/3/)
    assert.match(explainDistance(run([1, 1, 1, 1, 1]).p), /攻坚区/)
    assert.match(explainDistance(run([3, 3, 3]).p), new RegExp(SILENCE_FILTER_NAME))
  })
})

describe('只记第一次判定（D-121 / M-019）', () => {
  it('attempts 就是第一次判定的次数 —— 改到过关不该再调用本函数', () => {
    const { p } = run([2, 3, 1, 3])
    assert.equal(p.attempts, 4)
    assert.equal(p.corrects, 2)
  })
})
