import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isBlocked, needsTombstone, tombKey, TOMBSTONE_KINDS, type Tombstone } from './tombstone.ts'
import { decideRow, planMerge, type SyncRow } from './sync-merge.ts'

/**
 * ★★ R-3 · 「删掉的东西不许被旧同步包复活」
 *
 * 这一套只验判据本身：没有库、没有网络。
 * 「墓碑存在时**两种**远端版本都拒绝」这条性质在这里三行就能造出来，
 * 而在真同步里要凑齐「A 删了 + B 在删之后改了 + 中间没同步过」才碰得到。
 */

const tomb = (purgedAt: number): Tombstone => ({
  targetUid: 'items-abc',
  kind: 'items',
  purgedAt,
  targetId: 1
})

const row = (updatedAt: number): SyncRow => ({
  uid: 'items-abc',
  table: 'items',
  updatedAt,
  data: { uid: 'items-abc', id: 1, term: 'foobar', updated_at: updatedAt }
})

describe('★★ R-3 · 墓碑判据', () => {
  it('没有墓碑 → 放行（原来的行为一个字不变）', () => {
    assert.deepEqual(isBlocked(undefined, 100), { blocked: false })
  })

  it('★ 遗骸（远端比墓碑旧）→ 拒绝', () => {
    const v = isBlocked(tomb(100), 50)
    assert.equal(v.blocked, true)
    assert.equal(v.blocked && v.postPurge, false)
  })

  it('★ 正好等于墓碑时刻 → 也拒绝（`≤`，不是 `<`）', () => {
    const v = isBlocked(tomb(100), 100)
    assert.equal(v.blocked, true, '★ 同一毫秒的那一版漏过去了')
    assert.equal(v.blocked && v.postPurge, false)
  })

  it('★★ 删后修改（远端比墓碑新）→ **仍然拒绝**，只是另记一笔', () => {
    const v = isBlocked(tomb(100), 200)
    assert.equal(v.blocked, true, '★★ 让它复活了 —— 删除是他明确按下去的')
    assert.equal(v.blocked && v.postPurge, true, '要能分辨出这是「删后修改」，好记账')
  })

  it('★★ 时钟怎么偏都不影响「会不会复活」，只影响记的是哪一种', () => {
    /**
     * 判「遗骸 vs 删后修改」比的是两台机器的墙钟（R-3-c 未解决）。
     * 这条用例把时间从远早于墓碑扫到远晚于墓碑 —— **一格都不许放行**。
     * 这正是「两种情况都拒绝」的第四条理由：删除安全性不依赖时钟。
     */
    for (const at of [0, 1, 99, 100, 101, 1e12, Number.MAX_SAFE_INTEGER]) {
      assert.equal(isBlocked(tomb(100), at).blocked, true, `★ updated_at=${at} 时放行了`)
    }
  })

  it('拒绝的理由要能直接给他看，不是一句代码术语', () => {
    const stale = isBlocked(tomb(100), 50)
    const post = isBlocked(tomb(100), 200)
    assert.match(stale.blocked ? stale.reason : '', /彻底删除/)
    assert.match(post.blocked ? post.reason : '', /重新建/, '删后修改要告诉他下一步能做什么')
  })

  it('只有六类实体立碑 —— 派生行一律不立', () => {
    for (const k of TOMBSTONE_KINDS) assert.equal(needsTombstone(k), true, k)
    for (const k of [
      'item_lectures', 'occurrences', 'answers', 'questions', 'review_logs',
      'analysis_blocks', 'state_events', 'item_events', 'settings', 'dictionaries',
      'term_ledger', 'sqlite_sequence', 'tombstones'
    ]) {
      assert.equal(needsTombstone(k), false, `★ ${k} 不该立碑`)
    }
  })

  it('★ 墓碑自己绝不能立碑 —— 否则要给墓碑立墓碑', () => {
    assert.equal(needsTombstone('tombstones'), false)
  })

  it('键把表名也算进去 —— 不同表的同名 uid 不许互相误伤', () => {
    assert.notEqual(tombKey('items', 'x'), tombKey('lectures', 'x'))
  })
})

describe('★★ R-3 · decideRow 接上墓碑之后的完整矩阵', () => {
  const localOf = (): SyncRow | undefined => undefined

  it('本地无 · 远端任意 · 无碑 → take-remote（现状不变）', () => {
    assert.equal(decideRow(undefined, row(200), 100, undefined).kind, 'take-remote')
  })

  it('★ 本地无 · 远端遗骸 · 有碑 → blocked', () => {
    const d = decideRow(undefined, row(50), 100, tomb(100))
    assert.equal(d.kind, 'blocked')
  })

  it('★★ 本地无 · 远端删后修改 · 有碑 → blocked 且标成 postPurge', () => {
    const d = decideRow(undefined, row(200), 100, tomb(100))
    assert.equal(d.kind, 'blocked')
    assert.equal(d.kind === 'blocked' && d.postPurge, true)
  })

  it('★★ 本地那份还在、碑也在 → **照样挡**（碑和老行同一批到达时就是这个形状）', () => {
    /**
     * A 删掉 X 推上去；B 这一次同时收到「X 的墓碑」和「别的设备推的 X」。
     * 那一刻 B 本地的 X 还在 —— 判断要是只写在 `!local` 里就漏过去了。
     */
    const local = row(80)
    const d = decideRow(local, row(200), 100, tomb(100))
    assert.equal(d.kind, 'blocked', '★ 本地那份还在就放行了 —— 碑说了算')
    assert.equal(d.kind === 'blocked' && d.postPurge, true)
  })

  it('★★ 被挡下的算进 skipped，绝不算 failed —— 恒等式靠它', () => {
    const rows = [row(50), { ...row(200), uid: 'items-def' }]
    const tombs = new Map<string, Tombstone>([
      [tombKey('items', 'items-abc'), tomb(100)],
      [tombKey('items', 'items-def'), { targetUid: 'items-def', kind: 'items', purgedAt: 100, targetId: 2 }]
    ])
    const plan = planMerge(rows, localOf, (t, uid) => tombs.get(tombKey(t, uid)))
    assert.equal(plan.apply.length, 0, '一行都不该进来')
    assert.equal(plan.skipped, 2, `被挡的要计进 skipped：${plan.skipped}`)
    assert.equal(plan.blocked.length, 2)
    assert.equal(plan.blocked.filter((b) => b.postPurge).length, 1, '其中一条是删后修改')
  })

  it('不传 tombOf 时行为和以前一模一样 —— 老调用点不受影响', () => {
    const plan = planMerge([row(200)], localOf)
    assert.equal(plan.apply.length, 1)
    assert.equal(plan.blocked.length, 0)
  })
})
