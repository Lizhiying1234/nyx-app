import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { purgeAllowed, PURGE_SKEW_LIMIT_MS } from './purge-guard.ts'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

describe('回收站硬删的时钟护栏（F-015）', () => {
  it('PG-1 · 从没同步过（没有远端参照）→ 放行', () => {
    const v = purgeAllowed({ now: NOW, maxRemoteSeen: 0 })
    assert.equal(v.ok, true)
    assert.equal(v.why, null)
  })

  it('PG-2 · 本机比远端稍微超前（几小时）→ 放行', () => {
    const v = purgeAllowed({ now: NOW, maxRemoteSeen: NOW - 6 * 3_600_000 })
    assert.equal(v.ok, true)
  })

  it('PG-3 · 本机落后远端很多 → 放行（这个方向只会少删）', () => {
    const v = purgeAllowed({ now: NOW, maxRemoteSeen: NOW + 900 * DAY })
    assert.equal(v.ok, true)
    assert.equal(v.aheadMs, 0, '落后时超前量记 0，不记负数')
  })

  it('★★★ PG-4 · 本机超前超过阈值 → 拒绝，并给一句**两种成因都说**的人话（I-188）', () => {
    /**
     * 拦本身没错（拿不准就别做不可撤销的事），错的是**下断言**：
     * 这个条件既可能是本机钟快，也可能只是对端好久没同步，而两者分不开。
     * ★ 反向对照：把 `why` 改回「看起来本机时钟不太对」那一版 → 下面三条当场红。
     */
    const v = purgeAllowed({ now: NOW, maxRemoteSeen: NOW - 30 * DAY })
    assert.equal(v.ok, false)
    assert.match(v.why ?? '', /30 天没同步过/, '★★ 成因一：对端久没动静 —— 而这恰恰是最常见的那一种')
    assert.match(v.why ?? '', /本机时间快了/, '★★ 成因二：本机的钟')
    assert.match(v.why ?? '', /一样没少/, '必须说清楚东西还在 —— 拒绝不是失败')
    assert.ok(!/不可撤销|已删除/.test(v.why ?? ''), 'D-412：文案必须说真话，这里什么都没删')
    assert.doesNotMatch(
      v.why ?? '',
      /早了/,
      '★★★ I-188：触发条件是本机比远端【晚】，说「早」会把他指向反的那一端'
    )
    assert.doesNotMatch(
      v.why ?? '',
      /时钟不太对/,
      '★★★ I-188：这个条件证不出本机的钟坏了，不许替他下这个断言'
    )
  })

  it('PG-5 · 边界：正好等于阈值放行，多 1 毫秒就拒', () => {
    assert.equal(purgeAllowed({ now: NOW, maxRemoteSeen: NOW - PURGE_SKEW_LIMIT_MS }).ok, true)
    assert.equal(purgeAllowed({ now: NOW, maxRemoteSeen: NOW - PURGE_SKEW_LIMIT_MS - 1 }).ok, false)
  })

  it('PG-6 · 阈值可以调（两端可以各有各的容忍度）', () => {
    const seen = NOW - 2 * DAY
    assert.equal(purgeAllowed({ now: NOW, maxRemoteSeen: seen }).ok, true)
    assert.equal(purgeAllowed({ now: NOW, maxRemoteSeen: seen, toleranceMs: DAY }).ok, false)
  })

  it('PG-7 · 脏数据（NaN / 负数）当作没有参照 → 放行，不炸', () => {
    assert.equal(purgeAllowed({ now: NOW, maxRemoteSeen: NaN }).ok, true)
    assert.equal(purgeAllowed({ now: NOW, maxRemoteSeen: -1 }).ok, true)
  })
})
