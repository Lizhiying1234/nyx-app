import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAll,
  checkAppliedMonotone,
  checkConflictFreeze,
  checkPackageCompleteness,
  checkRetryEligibility,
  checkTally,
  checkTallyNonNegative,
  checkWatermarkMonotone,
  checkWriteOrdering,
  packageIsComplete,
  type PackageOutcome
} from './invariants.ts'
import { emptyTally, type SyncState, type Tally } from './types.ts'

/**
 * 七条跨平台不变量 · Step 6 · Commit A
 *
 * 每一条都要有**正反两面**：成立时不许误报，违反时必须报出来。
 * 只测「成立」的那一半等于没测 —— 一个永远返回 null 的判据也能全绿。
 */

const state = (o: Partial<SyncState> = {}): SyncState => ({
  startedAt: 1000,
  watermark: 500,
  wipedAt: 0,
  device: 'devA',
  formerDevices: [],
  identity: { schemaVersion: 30, schemaFingerprint: 'f'.repeat(16), protocolVersion: 3 },
  applied: [],
  todo: [],
  cursor: 0,
  tally: emptyTally(),
  rejections: [],
  badChunks: [],
  batch: [],
  batchRejected: [],
  batchFailed: [],
  batchConflicted: [],
  unresolved: 0,
  pushedUpTo: null,
  phase: 'start',
  ...o
})

const tally = (o: Partial<Tally> = {}): Tally => ({ ...emptyTally(), ...o })

describe('① 水位单调', () => {
  it('前进 / 不动 → 没问题', () => {
    assert.equal(checkWatermarkMonotone(500, 900), null)
    assert.equal(checkWatermarkMonotone(500, 500), null)
  })
  it('★ 倒退 → 报出来，而且话里说得出后果', () => {
    const v = checkWatermarkMonotone(900, 500)
    assert.ok(v)
    assert.equal(v.id, 'watermark-monotone')
    assert.match(v.why, /假冲突|重推/)
  })
})

describe('② 冲突冻结', () => {
  it('没有未决冲突 → 水位随便走', () => {
    assert.equal(checkConflictFreeze(0, 500, 9999), null)
  })
  it('有未决冲突 + 水位没动 → 没问题', () => {
    assert.equal(checkConflictFreeze(3, 500, 500), null)
  })
  it('★★ 有未决冲突 + 水位往前走 → 报出来（冲突会自己蒸发）', () => {
    const v = checkConflictFreeze(3, 500, 501)
    assert.ok(v)
    assert.equal(v.id, 'conflict-freeze')
    assert.match(v.why, /蒸发|替他做/)
  })
  it('★ 哪怕只前进 1 毫秒也算违反 —— 没有「差不多」这回事', () => {
    assert.ok(checkConflictFreeze(1, 100, 101))
  })
})

describe('③ applied 只进不退', () => {
  it('只增 → 没问题', () => {
    assert.equal(checkAppliedMonotone(['a'], ['a', 'b']), null)
  })
  it('顺序变了不算退', () => {
    assert.equal(checkAppliedMonotone(['a', 'b'], ['b', 'a']), null)
  })
  it('★ 少了一个 → 报出来', () => {
    const v = checkAppliedMonotone(['a', 'b'], ['a'])
    assert.ok(v)
    assert.match(v.why, /重下重放/)
  })
})

describe('④ 四桶恒等', () => {
  it('★ 对得上 → 没问题', () => {
    assert.equal(checkTally(tally({ received: 100, applied: 70, skipped: 10, failed: 15, conflicted: 5 })), null)
  })
  it('★★ 对不上 → 报出来，而且把四个数都摆出来', () => {
    const v = checkTally(tally({ received: 100, applied: 70, skipped: 10, failed: 15, conflicted: 0 }))
    assert.ok(v)
    assert.match(v.why, /收到 100/)
    assert.match(v.why, /= 95/)
  })
  it('★ 重复计数（和 > 收到）也要报', () => {
    assert.ok(checkTally(tally({ received: 10, applied: 8, skipped: 8 })))
  })
  it('★ 负数 → 报出来（说明某处重复扣减）', () => {
    assert.ok(checkTallyNonNegative(tally({ received: 1, applied: -1, skipped: 2 })))
    assert.equal(checkTallyNonNegative(tally({ received: 1, applied: 1 })), null)
  })
  it('★★ 空的一趟也满足恒等式', () => {
    assert.equal(checkTally(emptyTally()), null)
  })
})

describe('⑤ 写入顺序', () => {
  it('墓碑在前 → 没问题', () => {
    assert.equal(checkWriteOrdering(['tombstones', 'tombstones', 'items', 'questions']), null)
  })
  it('没有墓碑 → 没问题', () => {
    assert.equal(checkWriteOrdering(['items', 'questions']), null)
  })
  it('★★ 墓碑排在普通行后面 → 报出来', () => {
    const v = checkWriteOrdering(['items', 'tombstones'])
    assert.ok(v)
    assert.match(v.why, /复活/)
  })
})

describe('⑥ 一包算不算处理完', () => {
  const pkg = (o: Partial<PackageOutcome> = {}): PackageOutcome => ({
    name: 'p.json',
    hasFailedRows: false,
    hasUnresolvedConflicts: false,
    rejected: false,
    ...o
  })

  it('干净 → 算处理完', () => {
    assert.equal(packageIsComplete(pkg()), true)
  })
  it('★ 三种没处理完，一种都不许算完', () => {
    assert.equal(packageIsComplete(pkg({ hasFailedRows: true })), false)
    assert.equal(packageIsComplete(pkg({ hasUnresolvedConflicts: true })), false)
    assert.equal(packageIsComplete(pkg({ rejected: true })), false)
  })
  it('★★ 该进没进 → 报（每次都重下一遍，还一直说有失败）', () => {
    const v = checkPackageCompleteness([pkg()], [])
    assert.ok(v)
    assert.match(v.why, /该进/)
  })
  it('★★ 不该进却进了 → 报（那一包永远不会被再看一眼）', () => {
    const v = checkPackageCompleteness([pkg({ hasFailedRows: true })], ['p.json'])
    assert.ok(v)
    assert.match(v.why, /该不进/)
  })
})

describe('⑦ 重试资格', () => {
  it('该重试的都不在 applied 里 → 没问题', () => {
    assert.equal(checkRetryEligibility(['a'], ['b']), null)
  })
  it('★★ 该重试的进了 applied → 报出来', () => {
    const v = checkRetryEligibility(['a', 'b'], ['a'])
    assert.ok(v)
    assert.match(v.why, /永远不会被再看一眼/)
  })
})

describe('★★ checkAll · 一次转移守不守得住全部七条', () => {
  it('正常一趟：全过', () => {
    const before = state({ watermark: 500, applied: ['a'] })
    const after = state({
      watermark: 900,
      applied: ['a', 'b'],
      tally: tally({ received: 10, applied: 7, skipped: 3 })
    })
    assert.deepEqual(checkAll({ before, after, writeOrder: ['tombstones', 'items'] }), [])
  })

  it('★★ 冲突未决却推了水位 + 账对不上 → 两条都报，不是只报第一条', () => {
    const before = state({ watermark: 500 })
    const after = state({
      watermark: 900,
      unresolved: 2,
      tally: tally({ received: 10, applied: 7, skipped: 0, conflicted: 2 })
    })
    const bad = checkAll({ before, after })
    const ids = bad.map((b) => b.id).sort()
    assert.deepEqual(ids, ['conflict-freeze', 'tally-identity'])
  })

  it('★ 写入顺序与包完成度也一起看', () => {
    const before = state()
    const after = state({ applied: ['p.json'] })
    const bad = checkAll({
      before,
      after,
      writeOrder: ['items', 'tombstones'],
      outcomes: [{ name: 'p.json', hasFailedRows: true, hasUnresolvedConflicts: false, rejected: false }],
      needRetry: ['p.json']
    })
    const ids = bad.map((b) => b.id).sort()
    assert.deepEqual(ids, ['package-completeness', 'retry-eligibility', 'write-ordering'])
  })

  it('★ 判据不许是「永远返回 null」的安慰牌 —— 造一个全错的转移，必须全报', () => {
    const before = state({ watermark: 900, applied: ['a', 'b'] })
    const after = state({
      watermark: 100,
      applied: ['a'],
      unresolved: 1,
      tally: tally({ received: 5, applied: 99 })
    })
    const bad = checkAll({ before, after })
    assert.ok(bad.length >= 3, `只报了 ${bad.length} 条：${bad.map((b) => b.id).join('、')}`)
  })
})
