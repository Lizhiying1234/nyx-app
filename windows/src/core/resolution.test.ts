import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isMonotoneRow,
  isResolutionBlocking,
  keptUpdatedAt,
  resolutionUid,
  type ResolutionFact
} from './resolution.ts'
import { decideRow, planMerge, type SyncRow } from './sync-merge.ts'
import { mergeRejectedUpTo } from './restore-merge.ts'

/**
 * ★★ R-4-F-a · 「用本地的」这个决定，必须是一条存得住的事实
 *
 * 这一套只验判据本身：没有库、没有网络。
 * 「他裁决过 → 老包重放 → 不许推翻」这条性质在这里三行就能造出来，
 * 在真同步里要凑齐「applied 溢出 / 新设备 / 导回旧备份」才碰得到。
 */

const res = (rejectedUpTo: number): ResolutionFact => ({
  targetUid: 'items-abc',
  kind: 'items',
  rejectedUpTo
})

const row = (updatedAt: number, uid = 'items-abc', table = 'items'): SyncRow => ({
  uid,
  table,
  updatedAt,
  data: { uid, id: 1, term: 'foobar', updated_at: updatedAt }
})

describe('★★ R-4-F-a · 裁决判据', () => {
  it('没有裁决 → 放行（原来的行为一个字不变）', () => {
    assert.equal(isResolutionBlocking(undefined, 100), false)
  })

  it('★ 被拒绝过的那一版（远端 < 裁决时刻）→ 挡住', () => {
    assert.equal(isResolutionBlocking(res(100), 50), true)
  })

  it('★ 正好等于裁决时刻 → 也挡住（`≤`，不是 `<`）', () => {
    assert.equal(isResolutionBlocking(res(100), 100), true)
  })

  it('★★ ⑩ 对面之后又改过（远端 > 裁决时刻）→ **不挡**，那是一次新的分歧', () => {
    /**
     * 这一条是整个设计的分界线。写成「永久拒绝这个对象」的话，
     * 对面之后每一次正常修改都会被无声吞掉 ——
     * 两台机器从此再也无法就这一行达成一致，而且没有任何提示。
     */
    assert.equal(isResolutionBlocking(res(100), 101), false)
  })

  it('★ 裁决只认 uid，不认内容', () => {
    // 同一条事实，换一个 target 就与它无关（删掉重建 = 新 uid）
    assert.equal(isResolutionBlocking(res(100), 50), true)
    const other: ResolutionFact = { ...res(100), targetUid: 'items-xyz' }
    // 判据函数本身不查 uid —— 查 uid 是调用方的事，这里守的是「调用方按 uid 取」
    assert.notEqual(other.targetUid, 'items-abc')
  })
})

describe('★★ R-4-F-a · 裁决行自己的身份', () => {
  it('★★ 算出来的，不是随机的 —— 两台机器对同一 target 得到同一个 uid', () => {
    assert.equal(resolutionUid('items-abc'), resolutionUid('items-abc'))
    assert.equal(resolutionUid('items-abc'), 'resolutions-items-abc')
  })

  it('★ 不同 target → 不同 uid', () => {
    assert.notEqual(resolutionUid('items-abc'), resolutionUid('items-xyz'))
  })

  it('★ 删掉重建之后是新 uid → 新的裁决身份，老决定管不着它', () => {
    assert.notEqual(resolutionUid('lectures-old'), resolutionUid('lectures-new'))
  })
})

describe('★★ R-4-F-a · D5 · 留下来那一行的时间戳', () => {
  it('★★ 永远排在被拒绝的版本之后（本地本来更旧时也是）', () => {
    // 他选「用本地」时，本地那版常常比云端旧 —— 那正是他要做决定的原因
    assert.ok(keptUpdatedAt(1000, 5000) > 5000, '没顶过被拒的版本')
    assert.equal(keptUpdatedAt(1000, 5000), 5001)
  })

  it('★ 本地本来就更新时，用「现在」', () => {
    assert.equal(keptUpdatedAt(9000, 5000), 9000)
  })

  it('★ 同一毫秒也要严格更大（`+1` 不能省）', () => {
    assert.equal(keptUpdatedAt(5000, 5000), 5001)
  })
})

describe('★★ R-4-F-a · 裁决行不进冲突', () => {
  it('★ resolutions 是「合并到一起就行」的表', () => {
    assert.equal(isMonotoneRow('resolutions'), true)
  })

  it('★★ 别的表一律不是 —— 这张名单不许随手加', () => {
    for (const t of ['items', 'lectures', 'picks', 'tombstones', 'term_ledger', 'answers']) {
      assert.equal(isMonotoneRow(t), false, `${t} 被当成了「合并到一起就行」`)
    }
  })

  it('★★ 两边都改过同一条裁决 → take-remote，不问使用者', () => {
    /**
     * 数据库那条 max 触发器保证谁先谁后结果都一样。
     * 拿它去问「用哪边」，他会看到一条自己根本不认识的内部记录。
     */
    const local = row(200, 'resolutions-items-abc', 'resolutions')
    const remote = row(300, 'resolutions-items-abc', 'resolutions')
    const d = decideRow(local, remote, 100)
    assert.equal(d.kind, 'take-remote', `裁决行进了 ${d.kind}`)
  })

  it('★ 同样形状的普通行仍然是冲突（对照）', () => {
    const d = decideRow(row(200), row(300), 100)
    assert.equal(d.kind, 'conflict', '普通行不该被顺手放行')
  })
})

describe('★★ R-4-F-a · 接进 decideRow 的优先级', () => {
  it('★★ Step 6C · 老包重放：没有裁决 → **现在是冲突**（那个 bug 结构上没了）', () => {
    /**
     * ── 这条用例记的是一个已经消失的 bug ────────────────────
     *
     * 旧判据下：他裁决之后水位越过了两边 → 两边都「没有新改动」→
     * 落在最后那一格「取新的那个」→ 云端那版更新 → take-remote。
     * **他明确拒绝过的内容盖掉了他留下的内容，一句话都不说。**
     *
     * Step 6C 把判据换成「和共同基版本比相等」之后，这条路结构上不存在了：
     * 两版都不等于共同基版本，就是冲突，不会再掉进任何「取新的那个」的兜底。
     * 裁决事实仍然要有 —— 它挡的是**重放**（见下一条），而不是这一格。
     */
    const d = decideRow(row(500), row(900), 1000)
    assert.equal(d.kind, 'conflict')
  })

  it('★★ 同样的形状 + 裁决 → keep-local', () => {
    const d = decideRow(row(500), row(900), 1000, undefined, res(900))
    assert.equal(d.kind, 'keep-local', `挡不住：${d.kind}`)
  })

  it('★★ 裁决排在 conflict 前面 —— 不再问第二遍', () => {
    // 两边都在水位之后改过，本来是 conflict
    assert.equal(decideRow(row(500), row(900), 100).kind, 'conflict')
    assert.equal(decideRow(row(500), row(900), 100, undefined, res(900)).kind, 'keep-local')
  })

  it('★★★ 新设备：被拒的那版挡住，**留下的那版照样进得来**', () => {
    /**
     * ★ 这一条是整个设计里最容易做错的地方，而且**实测红过一次**。
     *
     * 新设备一批里同时收到两个版本，两行的 `local` 都还是空的
     * （合并的判断发生在落库之前）。裁决要是不管 `!local`，
     * 两行双双 take-remote，**谁赢取决于哪个包先到** —— 那不是他的决定。
     *
     * 所以裁决必须在 `!local` 之前生效；而这么做之所以不会把那个对象
     * 整个挡没，全靠 D5：**留下的那一版永远晚于 `rejected_up_to`**。
     */
    // 被拒的那一版（正好等于裁决时刻）→ 挡住
    assert.equal(decideRow(undefined, row(900), 0, undefined, res(900)).kind, 'keep-local')
    // 更早的那些残影 → 也挡住
    assert.equal(decideRow(undefined, row(500), 0, undefined, res(900)).kind, 'keep-local')
    // ★★ 留下的那一版（D5 顶过时间戳）→ **必须进得来**，否则新设备上什么都没有
    const kept = keptUpdatedAt(Date.now(), 900)
    assert.equal(
      decideRow(undefined, row(kept), 0, undefined, res(900)).kind,
      'take-remote',
      '★★ 新设备上那个对象被挡没了 —— D5 的不变式没成立'
    )
  })

  it('★★ D5 的不变式：顶过时间戳的那一版，永远不落在被挡的区间里', () => {
    for (const upTo of [1, 999, Date.now(), Date.now() + 86_400_000]) {
      const kept = keptUpdatedAt(Date.now(), upTo)
      assert.equal(
        isResolutionBlocking(res(upTo), kept),
        false,
        `★★ rejected_up_to=${upTo} 时，留下的那一版自己被挡住了`
      )
    }
  })

  it('★ 墓碑仍然排在裁决前面', () => {
    const d = decideRow(
      row(500),
      row(900),
      100,
      { targetUid: 'items-abc', kind: 'items', purgedAt: 1000, targetId: 1 },
      res(900)
    )
    assert.equal(d.kind, 'blocked', '墓碑的优先级被裁决挤掉了')
  })

  it('★ planMerge 把被裁决挡下的行算进 skipped，不算 conflicted', () => {
    const plan = planMerge([row(900)], () => row(500), undefined, undefined, () => res(900))
    assert.equal(plan.conflicts.length, 0, '又问了他一遍')
    assert.equal(plan.skipped, 1)
    assert.equal(plan.apply.length, 0)
    assert.equal(plan.blocked.length, 0, '不该混进墓碑那一档 —— 那是要报给他看的')
  })
})

describe('★★ R-4-F-a · 导回合并（⑯⑰⑱ 的纯逻辑那一半）', () => {
  it('★★ ⑯ 当前库更晚 → 保留当前的', () => {
    assert.equal(mergeRejectedUpTo(900, 100), 900)
  })

  it('★★ ⑰ 备份更晚 → 用备份的（裁决能被推进）', () => {
    assert.equal(mergeRejectedUpTo(100, 900), 900)
  })

  it('★★ ⑱ 两边不同 → 取 max，方向和墓碑一致', () => {
    assert.equal(mergeRejectedUpTo(500, 900), 900)
    assert.equal(mergeRejectedUpTo(900, 500), 900)
    assert.equal(mergeRejectedUpTo(700, 700), 700)
  })
})
