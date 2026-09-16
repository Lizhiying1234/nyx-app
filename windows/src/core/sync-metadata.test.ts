import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterWipe,
  monotone,
  PRESERVED_SYNC_KEYS,
  verifyAfterWipe,
  type SyncMetaSnapshot
} from './sync-metadata.ts'

/**
 * 本地清空之后，同步元数据该是什么样 · Step 1C / D-273
 *
 * 这里守的是三句话：
 *   ① 这台机器的编号不因为清空而改变
 *   ② 墓碑只增不减
 *   ③ 游标不落在墓碑之前
 * 三句里任何一句坏掉，表现都是同一个：**下次同步把清掉的东西全拉回来**。
 */

const snap = (o: Partial<SyncMetaSnapshot> = {}): SyncMetaSnapshot => ({
  'sync.device': 'dev-a1b2',
  'sync.wipedAt': '1000',
  'sync.watermark': '900',
  'sync.applied': '["x.json","y.json"]',
  ...o
})

describe('清空之后写回什么', () => {
  it('★ 编号原样保留 —— 换了它就会把自己删掉的东西拉回来', () => {
    assert.equal(afterWipe(snap(), 5000)['sync.device'], 'dev-a1b2')
  })

  it('★ 墓碑取 max(旧, 现在)，只增不减', () => {
    assert.equal(afterWipe(snap(), 5000)['sync.wipedAt'], '5000')
    // 时钟回拨 / 导回老备份：现在比旧值还早，仍然保旧值
    assert.equal(afterWipe(snap({ 'sync.wipedAt': '9000' }), 5000)['sync.wipedAt'], '9000')
  })

  it('★ 游标不许落在墓碑之前', () => {
    const out = afterWipe(snap({ 'sync.wipedAt': '9000', 'sync.watermark': '100' }), 5000)
    assert.ok(Number(out['sync.watermark']) >= Number(out['sync.wipedAt']))
  })

  it('已应用名单清空 —— 它是缓存，老包由墓碑按名字挡掉', () => {
    assert.equal(afterWipe(snap(), 5000)['sync.applied'], '[]')
  })

  it('从来没同步过的机器：编号是空串，调用方据此不写', () => {
    assert.equal(afterWipe({}, 5000)['sync.device'], '')
    assert.equal(afterWipe({}, 5000)['sync.wipedAt'], '5000')
  })

  it('坏值（负数 / 非数字 / null）当成 0，不会让墓碑倒退', () => {
    assert.equal(afterWipe(snap({ 'sync.wipedAt': 'abc' }), 5000)['sync.wipedAt'], '5000')
    assert.equal(afterWipe(snap({ 'sync.wipedAt': '-1' }), 5000)['sync.wipedAt'], '5000')
    assert.equal(afterWipe(snap({ 'sync.wipedAt': null }), 5000)['sync.wipedAt'], '5000')
  })

  it('monotone 单独可用（导回那一路要用同一条规则）', () => {
    assert.equal(monotone('10', 5), 10)
    assert.equal(monotone('10', 50), 50)
    assert.equal(monotone(null, 50), 50)
  })

  it('保留清单就是这四个，写死在一处', () => {
    assert.deepEqual([...PRESERVED_SYNC_KEYS], [
      'sync.device',
      'sync.wipedAt',
      'sync.watermark',
      'sync.applied'
    ])
  })
})

describe('清完自检', () => {
  it('都对 → 没问题', () => {
    const before = snap()
    assert.equal(verifyAfterWipe(before, afterWipe(before, 5000), 5000), null)
  })

  it('★ 编号被换掉 → 报出来', () => {
    const before = snap()
    const after = { ...afterWipe(before, 5000), 'sync.device': 'dev-NEW' }
    assert.match(verifyAfterWipe(before, after, 5000) ?? '', /编号/)
  })

  it('★ 墓碑倒退 → 报出来', () => {
    const before = snap({ 'sync.wipedAt': '9000' })
    const after = { ...afterWipe(before, 5000), 'sync.wipedAt': '10' }
    assert.match(verifyAfterWipe(before, after, 5000) ?? '', /墓碑/)
  })

  it('★ 墓碑整个没了 → 报出来（这正是 F-05 那个洞的形状）', () => {
    const before = snap()
    const after: SyncMetaSnapshot = { 'sync.device': 'dev-a1b2' }
    assert.match(verifyAfterWipe(before, after, 5000) ?? '', /墓碑/)
  })

  /**
   * ★ 判据 2026-09-15 改了形态，不是放宽（文案审查 N-05）。
   *   原来钉的是「那句话里有『游标』两个字」—— 而「游标」是内部词，已退役；
   *   钉着它，等于**把屏上的用词当成行为的判据**：改一个词就红，
   *   而它本来要守的是「这种局面必须报出来」。
   * ☞ 现在钉两件：① 确实报了（不是 null）；
   *   ② 那句话**说得出是哪两样东西错位了** —— 同步进度 与 删除记录。
   *   用词换了照样过，局面漏报当场红。
   */
  it('同步位置落在删除记录之前 → 报出来', () => {
    const before = snap()
    const after = { ...afterWipe(before, 5000), 'sync.watermark': '1' }
    const why = verifyAfterWipe(before, after, 5000)
    assert.ok(why, '★ 这种局面一个字都没报 —— 那正是 F-05 那个洞')
    assert.match(why, /同步位置|进度/, `★ 没说清是同步进到哪儿出的问题：${why}`)
    assert.match(why, /删除记录|墓碑/, `★ 没说清另一头是什么：${why}`)
  })

  it('本来就没有编号的机器，不因为「编号是空的」而报错', () => {
    assert.equal(verifyAfterWipe({}, afterWipe({}, 5000), 5000), null)
  })
})
