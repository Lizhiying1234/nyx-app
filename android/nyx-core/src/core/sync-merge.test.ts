import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyResolution,
  decideRow,
  describeConflicts,
  planMerge,
  type SyncRow
} from './sync-merge.ts'

const row = (uid: string, updatedAt: number, table = 'items'): SyncRow => ({
  uid,
  table,
  updatedAt,
  data: { id: 1, term: 'x' }
})

/**
 * ★★ Step 6C · 第三个参数是**共同基版本**，不是水位。
 *
 * 判据从「比大小」换成了「和共同基版本比**相等**」：
 *
 *   local == base && remote != base  → 收下对面的
 *   local != base && remote == base  → 留本地的
 *   local != base && remote != base  → 冲突
 *   local == base && remote == base  → 什么都不用做
 *
 * 时钟快慢从此不参与因果判断 —— 慢钟设备刚做的编辑不会再被判成
 * 「对面没改过」然后被无声吃掉。
 */
const BASE = 1000

describe('D-201 · 一行该怎么办', () => {
  it('本地没有 → 收下（另一台机器新增的）', () => {
    assert.equal(decideRow(undefined, row('a', 2000), BASE).kind, 'take-remote')
  })

  it('时间戳一样 → 什么都不做', () => {
    assert.equal(decideRow(row('a', 500), row('a', 500), BASE).kind, 'same')
  })

  it('只有云端改过（本地还停在共同基版本）→ 收下', () => {
    const d = decideRow(row('a', BASE), row('a', 2000), BASE)
    assert.equal(d.kind, 'take-remote')
    assert.match(d.reason, /只有云端/)
  })

  it('只有本地改过（云端还停在共同基版本）→ 留着，等推上去', () => {
    assert.equal(decideRow(row('a', 2000), row('a', BASE), BASE).kind, 'keep-local')
  })

  it('★ 两边都相对共同基版本动过 → 冲突，绝不自己决定', () => {
    const d = decideRow(row('a', 2000), row('a', 3000), BASE)
    assert.equal(d.kind, 'conflict', '这正是 D-201 说的「不静默覆盖」')
    if (d.kind === 'conflict') {
      assert.equal(d.localAt, 2000)
      assert.equal(d.remoteAt, 3000)
    }
  })

  it('★ 本地那版时间戳更大，仍然是冲突 —— 不许「新的赢」', () => {
    // 「取 updated_at 大的」是最容易顺手写出来的实现，
    // 而它恰恰会把本地刚改的东西悄悄盖掉 —— D-201 反对的就是这个
    assert.equal(decideRow(row('a', 3000), row('a', 2000), BASE).kind, 'conflict')
  })

  it('★★ 没有共同基版本（从没确认同步过）→ 两侧都算动过 → 冲突', () => {
    /**
     * 不拿 `updated_at` 去猜、不当成 0、不当成现在。猜错的那一半是
     * 「把没推过的行标成已同步」，那会永久漏数据。宁可多问一次。
     */
    assert.equal(decideRow(row('a', 500), row('a', 800), undefined).kind, 'conflict')
  })

  it('★★ 慢钟：对面那版时间戳比本地小，但都不等于共同基版本 → 冲突', () => {
    /**
     * 旧判据 `remote.updatedAt > watermark` 会把它判成「对面没改过」→
     * keep-local → 他在那台设备上的编辑被无声吃掉，两边都不会重试。
     * 换成和共同基版本比相等之后，时间戳谁大谁小不再影响因果判断。
     */
    const d = decideRow(row('a', 2000), row('a', 200), BASE)
    assert.equal(d.kind, 'conflict', '慢钟设备的编辑被当成「没改过」了')
  })
})

/**
 * ★★ Step 6C · 这一批的共同基版本：**取本地那一版**。
 *
 * 于是「本地没动过、云端动过」的行判 take-remote，
 * 而故意让 b / c 的基版本停在更早的一版 —— 它们两边都动过，就是冲突。
 */
const BASES: Record<string, number> = {
  /** a：共同基版本 = 本地那一版 → 只有云端动过 → take-remote */
  a: 500,
  /** b：两边都不等于共同基版本 → 冲突 */
  b: 1,
  /** c：共同基版本 = 云端那一版 → 只有本地动过 → keep-local */
  c: 500
  /** d 本地根本没有，走  那一档，基版本用不上 */
}
const baseOf = (_t: string, uid: string): number | undefined => BASES[uid]

describe('D-201 · 一批行的合并计划', () => {
  const local = new Map<string, SyncRow>([
    ['items|a', row('a', 500)], // 只有云端动过
    ['items|b', row('b', 2000)], // 两边都动过 → 冲突
    ['items|c', row('c', 2000)] // 只有本地动过
  ])
  const localOf = (t: string, uid: string): SyncRow | undefined => local.get(`${t}|${uid}`)

  const remote = [row('a', 2500), row('b', 2600), row('c', 500), row('d', 2700)]

  it('分成「直接应用」和「要问使用者」两堆', () => {
    const plan = planMerge(remote, localOf, undefined, undefined, undefined, baseOf)
    assert.deepEqual(
      plan.apply.map((r) => r.uid).sort(),
      ['a', 'd'],
      '只有云端动过的、和本地根本没有的，才能直接应用'
    )
    assert.equal(plan.conflicts.length, 1)
    assert.equal(plan.conflicts[0]!.row.uid, 'b')
    assert.equal(plan.skipped, 1) // c 留在本地
  })

  it('选「用云端」→ 冲突那几行才跟着一起进来', () => {
    const plan = planMerge(remote, localOf, undefined, undefined, undefined, baseOf)
    assert.deepEqual(applyResolution(plan, 'remote').map((r) => r.uid).sort(), ['a', 'b', 'd'])
  })

  it('选「用本地」→ 冲突那几行一行都不动', () => {
    const plan = planMerge(remote, localOf, undefined, undefined, undefined, baseOf)
    assert.deepEqual(applyResolution(plan, 'local').map((r) => r.uid).sort(), ['a', 'd'])
  })

  it('★ 无论选哪边，没冲突的那些照常同步 —— 不因为一处冲突就整批停摆', () => {
    const plan = planMerge(remote, localOf, undefined, undefined, undefined, baseOf)
    for (const choice of ['remote', 'local'] as const) {
      const ids = applyResolution(plan, choice).map((r) => r.uid)
      assert.ok(ids.includes('a') && ids.includes('d'), `选 ${choice} 时把干净的行也丢了`)
    }
  })

  it('冲突说明是人话，带着「云端多久前、本地多久前」', () => {
    const now = 3_600_000 * 5
    const plan = planMerge([row('b', now - 3 * 3_600_000)], localOf, undefined, undefined, undefined, baseOf)
    const text = describeConflicts(plan, now)
    assert.match(text, /3 小时前/, `D-201 举的例子就是这句：${text}`)
    assert.match(text, /用哪边/)
  })

  it('没有冲突时不说话', () => {
    assert.equal(describeConflicts(planMerge([row('a', 2500)], localOf, undefined, undefined, undefined, baseOf), Date.now()), '')
  })
})

/**
 * D-437 · 不一样的全是**机器的账** → 时间新的赢，不问。
 *
 * 起因：一次同步里 16 条讲次报「两边都改过、等你决定」，而他一个字都没编辑过 ——
 * `lectures.due_at` / `status` 是两端各自在他正常用的时候顺手改的。
 * 名单在 `sync-columns.ts`，**收错了只是多问一次，放错了是静默覆盖他写的字**，
 * 所以下面既钉「该不问的不问」，也钉「该问的一条都不许少问」。
 */
describe('D-437 · 机器的账不拿去问他', () => {
  const row = (
    table: string,
    at: number,
    data: Record<string, unknown> | null
  ): SyncRow => ({ uid: `${table}-1`, table, updatedAt: at, data })

  it('★ 只有排期不一样 → 取新的那份，不冲突', () => {
    const base = { name: 'Epigraph', silent: 0, sort: 1 }
    const d = decideRow(
      row('lectures', 200, { ...base, status: 'training', interval_days: 1, due_at: 111 }),
      row('lectures', 300, { ...base, status: 'training', interval_days: 3, due_at: 222 }),
      100
    )
    assert.equal(d.kind, 'take-remote')
    const back = decideRow(
      row('lectures', 400, { ...base, due_at: 999 }),
      row('lectures', 300, { ...base, due_at: 222 }),
      100
    )
    assert.equal(back.kind, 'keep-local', '本地那份更新就留本地')
  })

  it('★★ 只要有一列是他写的东西，照旧问他（D-201 一点没让）', () => {
    const mk = (name: string, due: number, extra: Record<string, unknown> = {}) => ({
      name, silent: 0, sort: 1, status: 'training', interval_days: 1, due_at: due, ...extra
    })
    // 名字不一样 —— 必须问
    assert.equal(
      decideRow(row('lectures', 200, mk('Epigraph', 111)), row('lectures', 300, mk('题记', 222)), 100).kind,
      'conflict'
    )
    // ★ 这三样是他的决定，不许被当成机器的账悄悄合掉
    assert.equal(
      decideRow(row('lectures', 200, mk('A', 111, { silent: 0 })), row('lectures', 300, mk('A', 222, { silent: 1 })), 100).kind,
      'conflict',
      '静默是学习决定（D-359），不是机器算的'
    )
    assert.equal(
      decideRow(row('lectures', 200, mk('A', 111, { sort: 1 })), row('lectures', 300, mk('A', 222, { sort: 5 })), 100).kind,
      'conflict',
      '排序是他拖的（D-361）'
    )
    assert.equal(
      decideRow(
        row('items', 200, { term: 'x', layer: 'A', card_reps: 1 }),
        row('items', 300, { term: 'x', layer: 'B', card_reps: 2 }),
        100
      ).kind,
      'conflict',
      '认读/产出的层级由他定（⑩）'
    )
  })

  it('★ 删除永远是他的意思表示 —— 一边是删除标记就照旧问', () => {
    assert.equal(
      decideRow(row('lectures', 200, { name: 'A', due_at: 111 }), row('lectures', 300, null), 100).kind,
      'conflict'
    )
  })

  it('★ 名单里没有的表，行为一个字不变', () => {
    assert.equal(
      decideRow(row('projects', 200, { name: 'A' }), row('projects', 300, { name: 'B' }), 100).kind,
      'conflict'
    )
  })

  it('★ 认读卡：SM2 那几列合掉，但 silent 要问', () => {
    const card = (reps: number, silent = 0) => ({ ease: 2.5, interval_days: 1, reps, lapses: 0, due_at: 1, silent })
    assert.equal(decideRow(row('reading_cards', 200, card(1)), row('reading_cards', 300, card(4)), 100).kind, 'take-remote')
    assert.equal(
      decideRow(row('reading_cards', 200, card(1, 0)), row('reading_cards', 300, card(4, 1)), 100).kind,
      'conflict',
      'silent 是他按的'
    )
  })
})
