import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SyncEngine } from './engine.ts'
import type { EnginePorts } from './ports.ts'

/**
 * 同步的**排队闸** —— 同一时刻只许跑一趟。
 *
 * 为什么钉它：2026-09-02 在真桶里数出来，同一批 927 行**一秒一个躺了三份**，
 * 另一批 643 行躺了两份，桶里 57% 是重复内容。根因是没有这道闸 ——
 * 连点几下同步（或手点撞上自动同步），几趟同时开跑，各自 `collectSince`
 * 都拿到同一批还没标记的行（标记在 `put` 成功之后才写），于是各自传一个重复包。
 *
 * ★ 是**排队**不是「已经在跑就把在跑那趟的结果还给你」：`run(resolve)` 带着
 *   他对冲突的裁决，直接还别人的结果 = 把他刚做的决定丢掉。
 */
function fakePorts(): EnginePorts {
  const settings = new Map<string, string>([['sync.kind', 'supabase']])
  return {
    db: {
      get: async (sql: string, args?: unknown[]) => {
        if (sql.includes('settings')) {
          const v = settings.get(String(args?.[0] ?? ''))
          return v === undefined ? undefined : { value: v }
        }
        return undefined
      },
      all: async () => [],
      run: async () => undefined,
      exec: async () => undefined
    },
    identity: async () => ({}),
    secrets: { getSyncSecret: async () => 'k', setSyncSecret: async () => undefined },
    clock: () => Date.now(),
    uuid: () => 'u'
  } as unknown as EnginePorts
}

describe('同步 · 排队闸', () => {
  it('★ 连着开三趟：不许有任何两趟同时在跑，而且三趟都要跑到', async () => {
    const eng = new SyncEngine(fakePorts())
    let live = 0
    let maxLive = 0
    const order: number[] = []
    let n = 0
    // 用一趟「假的同步」顶掉真身：只记谁在跑、跑了几趟
    ;(eng as unknown as { runOnce: () => Promise<unknown> }).runOnce = async () => {
      const me = ++n
      live += 1
      maxLive = Math.max(maxLive, live)
      await new Promise((r) => setTimeout(r, 20))
      live -= 1
      order.push(me)
      return { note: '' }
    }
    await Promise.all([eng.run(), eng.run(), eng.run()])
    assert.equal(maxLive, 1, `同时在跑的趟数最多只能是 1，实测 ${maxLive}`)
    assert.deepEqual(order, [1, 2, 3], '三趟都要跑到，而且按先后顺序')
  })

  it('★ 前一趟炸了，后面的照样排上队（不许被一次失败卡死）', async () => {
    const eng = new SyncEngine(fakePorts())
    let n = 0
    ;(eng as unknown as { runOnce: () => Promise<unknown> }).runOnce = async () => {
      const me = ++n
      if (me === 1) throw new Error('第一趟故意炸')
      return { note: 'ok' }
    }
    const first = eng.run().then(
      () => 'ok',
      () => 'boom'
    )
    const second = eng.run().then(
      () => 'ok',
      () => 'boom'
    )
    assert.deepEqual(await Promise.all([first, second]), ['boom', 'ok'])
  })
})
