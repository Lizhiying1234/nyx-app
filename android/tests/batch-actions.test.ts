/**
 * BA · **批次上还能做哪几个动作**（I-151 · 真机 2026-09-07）
 *
 * ══ 它防的是哪一件已经发生过的事 ═══════════════════════════
 *
 * 讲页上那一行动作（取消 / 继续分析 / 重试失败的）整个罩在 `status !== 'done'` 里。
 * 而**跑完了但有几条没成**这个状态，恰恰就是 `done` + `failed` 非空 ——
 * 于是唯一想按「重试失败的」的那一刻，它正好不在。失败的那几条没有任何出路。
 *
 * ★ 判据搬进 `analysis-runner::batchActions` 就是为了能在这里钉住：
 *   模板里一句 `{#if}` 写错了没有任何东西会报，而它决定的是
 *   「他还能不能把这几条捞回来」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  batchActions,
  failureSummary,
  type BatchFailure,
  type BatchState,
  type BatchStatus
} from '../src/db/analysis-runner.ts'

const state = (o: {
  status: BatchStatus
  queue?: number[]
  failed?: BatchFailure[]
}): BatchState => ({
  lectureId: 1,
  total: 10,
  done: 8,
  skipped: 0,
  queue: o.queue ?? [],
  failed: o.failed ?? [],
  status: o.status,
  startedAt: 1,
  updatedAt: 2
})

const fail = (id: number, why: string): BatchFailure => ({ id, why })

describe('BA · 批次动作（I-151）', () => {
  it('BA-1 · ★★ 跑完了但有几条没成 → 「重试失败的」必须在', () => {
    const s = state({ status: 'done', failed: [fail(1, 'AI 没回话')] })
    const a = batchActions(s)
    assert.equal(
      a.retry,
      true,
      '★★ 真机上就是这个状态（done + failed 非空），而按钮不见了 —— 那几条没有任何出路'
    )
    assert.equal(a.cancel, false, '都跑完了，没什么可取消')
    assert.equal(a.continue, false, '队列空了，没什么可继续')
  })

  it('BA-2 · 正在跑：能取消，不给「继续」（它已经在继续了）', () => {
    const a = batchActions(state({ status: 'running', queue: [2, 3] }))
    assert.deepEqual(a, { cancel: true, continue: false, retry: false })
  })

  it('BA-3 · 停下来还有排队的：给「继续分析」', () => {
    const a = batchActions(state({ status: 'cancelled', queue: [2, 3] }))
    assert.deepEqual(a, { cancel: false, continue: true, retry: false })
  })

  it('BA-4 · 取消时既有排队的也有失败的：两个都给', () => {
    const a = batchActions(
      state({ status: 'cancelled', queue: [2], failed: [fail(1, 'AI 没回话')] })
    )
    assert.deepEqual(a, { cancel: false, continue: true, retry: true })
  })

  it('BA-5 · 干干净净跑完：一个动作都不出现（数是 0 的入口不出现，D-431③）', () => {
    const a = batchActions(state({ status: 'done' }))
    assert.deepEqual(a, { cancel: false, continue: false, retry: false })
  })

  it('BA-6 · 「为什么没成」：同一句归成一行带条数，话术不重编', () => {
    assert.equal(failureSummary([]), '', '没有失败的就没有这句话')

    const one = failureSummary([fail(1, 'AI 没回话')])
    assert.equal(one, '1 条没成：AI 没回话', '只有一条时不加条数尾巴')

    const many = failureSummary([
      fail(1, '额度用完了'),
      fail(2, '额度用完了'),
      fail(3, 'AI 没回话')
    ])
    assert.equal(
      many,
      '3 条没成：额度用完了（2 条）；AI 没回话',
      '★ 一批里撞同一个原因是常态 —— 逐条列会把真正不同的那一条埋掉'
    )
  })
})
