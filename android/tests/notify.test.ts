/**
 * 数据安全通知对照（NT-1 ～ NT-3）· D-373
 *
 * 通知只有两类（积压/连败），这里钉纯判据 dataSafetyVerdict：
 * 什么时候说话 · 说几条 · 一天最多一次 · 没配同步不说。
 * failStreak 本身是 core 引擎数的（成功清零/失败 +1），smoke:sync 那边看着。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BACKLOG_AFTER_DAYS, FAIL_AFTER, dataSafetyVerdict } from '../src/db/notify.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const quiet = { backlog: 0, fail: 0 }

describe('NT-1 · 两类各自的门槛', () => {
  it('积压：有孤本 + 上次成功 ≥ 3 天才说', () => {
    const base = { kind: 'webdav', pending: 5, failStreak: 0 }
    assert.equal(dataSafetyVerdict({ ...base, lastAt: NOW - 2 * DAY }, NOW, quiet).length, 0)
    const m = dataSafetyVerdict({ ...base, lastAt: NOW - BACKLOG_AFTER_DAYS * DAY }, NOW, quiet)
    assert.equal(m.length, 1)
    assert.equal(m[0]!.id, 1)
    assert.ok(m[0]!.body.includes('5 行'))
    assert.ok(m[0]!.body.includes('3 天'))
  })
  it('积压：没有孤本（pending 0）多久没同步都不说 —— 没什么可丢的', () => {
    assert.equal(
      dataSafetyVerdict({ kind: 'webdav', pending: 0, lastAt: NOW - 30 * DAY, failStreak: 0 }, NOW, quiet).length,
      0
    )
  })
  it('积压：从没成功过（lastAt 0）不按积压算 —— 连败那类盯着它', () => {
    assert.equal(
      dataSafetyVerdict({ kind: 'webdav', pending: 9, lastAt: 0, failStreak: 0 }, NOW, quiet).length,
      0
    )
  })
  it('连败：满 3 次才说', () => {
    const base = { kind: 'webdav', pending: 0, lastAt: NOW - DAY }
    assert.equal(dataSafetyVerdict({ ...base, failStreak: FAIL_AFTER - 1 }, NOW, quiet).length, 0)
    const m = dataSafetyVerdict({ ...base, failStreak: FAIL_AFTER }, NOW, quiet)
    assert.equal(m.length, 1)
    assert.equal(m[0]!.id, 2)
    assert.ok(m[0]!.body.includes('连续 3 次'))
  })
})

describe('NT-2 · 一天最多一条（同类）', () => {
  it('说过不到一天 → 闭嘴；过了一天 → 再说', () => {
    const st = { kind: 'webdav', pending: 5, lastAt: NOW - 4 * DAY, failStreak: 3 }
    assert.equal(dataSafetyVerdict(st, NOW, quiet).length, 2) // 两类都到门槛
    const saidJust = { backlog: NOW - DAY / 2, fail: NOW - DAY / 2 }
    assert.equal(dataSafetyVerdict(st, NOW, saidJust).length, 0)
    const saidOld = { backlog: NOW - DAY - 1, fail: NOW - DAY / 2 }
    const m = dataSafetyVerdict(st, NOW, saidOld)
    assert.equal(m.length, 1) // 只有积压那类过了冷却
    assert.equal(m[0]!.id, 1)
  })
})

describe('NT-3 · 没配同步不说话（引擎同款态度）', () => {
  it('kind off → 永远安静', () => {
    assert.equal(
      dataSafetyVerdict({ kind: 'off', pending: 99, lastAt: NOW - 30 * DAY, failStreak: 9 }, NOW, quiet).length,
      0
    )
  })
})
