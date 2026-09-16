/**
 * ══ QF · 题型排序是 **FROZEN**，不是死代码（使用者 2026-09-14 裁）★★ ═══════
 *
 * 2026-09-14 双端对账把 `reorderQTypeList` 报成「零引用」，使用者原话：
 * **「题型排序，不需要整个删除」** —— 也就是「暂时没做」，不是「不做了」。
 * 界面上没有排序入口，所以它今天确实没有调用方。
 *
 * ── 为什么要给一个没人调的函数写闸 ────────────────────────────
 * 冻着的半个功能最容易烂：没人调 → 没人发现它坏了 → 解冻那天界面接上去，
 * 拖一下顺序没反应，而所有人都以为「后端早就写好了」。
 * 而且**下一个扫零引用的人会再报它一次**：有这条用例在，它至少有一个调用方，
 * 报表上不会再出现「438 → 0 引用」那一行。
 *
 * ☞ 出处：`NYX_MASTER_PLAN.md` 的 NEXT ACTION（2026-09-14 三件裁决之一）；解冻 = 他要一个排序入口。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { listQTypes, reorderQTypeList, saveQTypeRow } from '../src/db/qtypes.ts'
import { builtDb, cleanup } from './helpers.ts'

after(cleanup)

describe('QF · 题型排序（FROZEN，界面还没有入口）', () => {
  it('★★ 它真的会改顺序 —— 不是一个留着好看的空壳', async () => {
    const f = builtDb()
    const a = await saveQTypeRow(f.db, { name: '甲' })
    const b = await saveQTypeRow(f.db, { name: '乙' })
    const c = await saveQTypeRow(f.db, { name: '丙' })

    const mine = async (): Promise<string[]> =>
      (await listQTypes(f.db)).filter((q) => ['甲', '乙', '丙'].includes(q.name)).map((q) => q.name)

    assert.deepEqual(await mine(), ['甲', '乙', '丙'], '★ 前提就不对：新建的三条本来不是这个顺序')

    await reorderQTypeList(f.db, [c, a, b])
    assert.deepEqual(
      await mine(),
      ['丙', '甲', '乙'],
      '★★ 排序没生效 —— 解冻那天界面接上去会「拖了没反应」，而后端看上去是写好的'
    )
  })

  it('★ 没点到的那些不受影响（出厂那 12 种还在，也没被挤乱）', async () => {
    const f = builtDb()
    const before = (await listQTypes(f.db)).map((q) => q.name)
    const a = await saveQTypeRow(f.db, { name: '甲' })
    await reorderQTypeList(f.db, [a])
    const after = (await listQTypes(f.db)).map((q) => q.name)
    for (const n of before) {
      assert.ok(after.includes(n), `★ 排一次序把「${n}」弄丢了`)
    }
  })
})
