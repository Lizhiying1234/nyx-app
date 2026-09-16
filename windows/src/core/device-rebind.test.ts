import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planRebind, MAX_FORMER_DEVICES, type RebindFacts } from './device-rebind.ts'

const F = (o: Partial<RebindFacts> = {}): RebindFacts => ({
  hardwareId: 'hw-A',
  knownHardwareId: 'hw-A',
  device: 'dev1',
  formerDevices: [],
  ...o
})

describe('设备编号防撞（F-009）', () => {
  it('DR-1 · 还是原来那台 → 什么都不做', () => {
    assert.deepEqual(planRebind(F()), { kind: 'none' })
  })

  it('DR-2 · 第一次运行（还没记过标识）→ 只记下来，不换号', () => {
    const a = planRebind(F({ knownHardwareId: '' }))
    assert.equal(a.kind, 'remember')
    assert.equal(a.kind === 'remember' && a.hardwareId, 'hw-A')
  })

  it('DR-3 · ★ 读不到本机标识 → 什么都不做（「说不清」不是「换机了」）', () => {
    assert.deepEqual(planRebind(F({ hardwareId: '' })), { kind: 'none' })
    assert.deepEqual(planRebind(F({ hardwareId: '   ' })), { kind: 'none' })
  })

  it('DR-4 · 换机了且铸过号 → 换号，旧号退休，并如实说一句', () => {
    const a = planRebind(F({ knownHardwareId: 'hw-OLD', device: 'dev1' }))
    assert.equal(a.kind, 'rebind')
    if (a.kind !== 'rebind') return
    assert.deepEqual(a.formerDevices, ['dev1'])
    assert.equal(a.hardwareId, 'hw-A')
    assert.match(a.message, /另一台设备/)
    assert.match(a.message, /数据一条都没动/, 'D-412：文案必须说真话')
  })

  it('DR-5 · 换机但从没铸过号 → 只记标识（没什么好退休的）', () => {
    const a = planRebind(F({ knownHardwareId: 'hw-OLD', device: '' }))
    assert.equal(a.kind, 'remember')
  })

  it('DR-6 · 历史编号累积：旧号排最前，不重复', () => {
    const a = planRebind(F({ knownHardwareId: 'hw-OLD', device: 'dev2', formerDevices: ['dev1'] }))
    assert.equal(a.kind === 'rebind' && a.formerDevices.join(','), 'dev2,dev1')
    const b = planRebind(F({ knownHardwareId: 'hw-OLD', device: 'dev2', formerDevices: ['dev2', 'dev1'] }))
    assert.equal(b.kind === 'rebind' && b.formerDevices.join(','), 'dev2,dev1', '不重复记同一个')
  })

  it(`DR-7 · 历史最多留 ${MAX_FORMER_DEVICES} 个`, () => {
    const many = Array.from({ length: 20 }, (_, i) => `old${i}`)
    const a = planRebind(F({ knownHardwareId: 'hw-OLD', device: 'devX', formerDevices: many }))
    assert.equal(a.kind === 'rebind' && a.formerDevices.length, MAX_FORMER_DEVICES)
    assert.equal(a.kind === 'rebind' && a.formerDevices[0], 'devX', '最近退休的排最前')
  })
})
