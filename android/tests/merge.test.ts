/**
 * MG · Lecture 内合并落库（T-9.13 · D-478②）
 *
 * ══ 这一套盯的是「写库那一半」，判据那一半在 core（`tests/core-parity.test.ts::P-19`）══
 *
 * 每一条都对着 `db/merge.ts` 文件头那三条必须照抄 Windows 的判断，
 * 它们的共同点是：**写歪了不会报错**，只会在几天后变成一件说不清的怪事。
 *
 *   MG-1  Safe 那一组真的并了：被并那条进回收站、学习史归到主记录名下
 *   MG-2  ★★ `term_ledger` **一行都不许有** —— 走了 `softDeleteItems` 就会有
 *   MG-3  ★ 被并那条的 `item_lectures` 不动（否则回收站恢复出来是个孤儿）
 *   MG-4  ★★ Review 那一组一根手指都没碰过（「不自动处理」落在 db 层，不在界面）
 *   MG-5  他自己挑主记录时要回判据里核一遍：不在同一组的两条不许并
 *   MG-6  账要记：`ops_log` 一行 `merge`，带两条 uid 与每张表迁了什么（D-458）
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dedupMerge, dedupScan } from '../src/db/merge.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

const T = 1_700_000_000_000

/**
 * 一讲四条：
 *   1 / 2  `bear the brunt` 同层、2 有释义、都没学习史        → Safe
 *   3 / 4  `take a toll` 跨层（A / B）                        → Review
 * ★ 给 1（主记录）与 2（被并的）各造一点子表行，好验「迁没迁」。
 */
function lecture(): Fixture {
  const f = builtDb()
  seed(f, { items: 0, logsPerItem: 0 })
  const q = (sql: string, ...p: unknown[]): void => {
    f.raw.prepare(sql).run(...(p as never[]))
  }
  const rows: [number, string, string, string][] = [
    [1, 'bear the brunt', '', 'B'],
    [2, 'Bear the Brunt.', '首当其冲', 'B'],
    [3, 'take a toll', '', 'A'],
    [4, 'take a toll', '', 'B']
  ]
  for (const [id, term, gloss, layer] of rows) {
    q(
      `insert into items (id,term,gloss,layer,kind,source,created_at,updated_at)
       values (?,?,?,?,'chunk','self',?,?)`,
      id, term, gloss, layer, T + id, T + id
    )
    q(`insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,1,?,?)`, id, T, T)
  }
  /**
   * 被并那条（2）身上挂一点**随机身份**的行 —— 合并要把它们改到主记录名下。
   *
   * ★★ 这里**不能挂 `answers` / `review_logs`**：那两样是「学习史」，
   *   而判据说「被并那条有学习史 → 整组进 Review」，挂了这一组就不再是 Safe，
   *   夹具自己把要验的那条路堵死了。选主也一样看学习史 ——
   *   挂了它，2 反而会变成主记录。所以用事件 / 练习题 / 状态流水这几张。
   * ★ 两条都没有学习史时选主取**最早 `created_at`**，所以主记录是 1。
   */
  q(`insert into item_events (item_id,kind,detail,created_at,updated_at) values (2,'note','x',?,?)`, T, T)
  q(
    `insert into questions (item_id,tier,type,prompt,created_at,updated_at)
     values (2,1,'cloze','填空',?,?)`,
    T, T
  )
  q(
    `insert into state_events (item_id,line,to_state,created_at,updated_at)
     values (2,'production','training',?,?)`,
    T, T
  )
  q(`update items set recollected_count = 2 where id = 2`)
  return f
}

const n = async (f: Fixture, sql: string): Promise<number> =>
  Number((await f.db.get(sql))?.['n'] ?? 0)

describe('MG · Lecture 内合并落库', () => {
  it('MG-1 · Safe 那一组并了：被并那条进回收站，学习史归到主记录名下', async () => {
    const f = lecture()
    const out = await dedupMerge(f.db, 1, { kind: 'safe' })

    assert.equal(out.groups, 1, '只处理 Safe 那一组')
    assert.equal(out.merged, 1)
    assert.equal(await n(f, `select count(*) as n from items where id = 2 and deleted_at is not null`), 1,
      '被并那条软删进回收站（30 天可恢复）')
    assert.equal(await n(f, `select count(*) as n from items where id = 1 and deleted_at is null`), 1,
      '主记录还在')
    assert.equal(await n(f, `select count(*) as n from item_events where item_id = 1`), 1,
      '★ 随机身份那几张表改到主记录名下 —— 合并的目的正是让它们归到一处')
    assert.equal(await n(f, `select count(*) as n from questions where item_id = 1`), 1)
    assert.equal(await n(f, `select count(*) as n from state_events where item_id = 1`), 1)
    assert.equal(
      Number((await f.db.get(`select recollected_count as n from items where id = 1`))?.['n']),
      2,
      '「再收一次」的计数相加（D-026）'
    )
    assert.deepEqual(out.moved, {
      item_events: 1,
      questions: 1,
      state_events: 1,
      recollected_count: 2
    })
  })

  it('MG-2 · ★★ term_ledger 一行都不许有 —— 记了「以后别再收」，留下那条也进不来了', async () => {
    /**
     * 这是这套用例里最要紧的一条。`manage.ts::softDeleteItems` 会
     * `ledger.noteMany(terms, 'deleted')` —— 那是「这个说法以后别再收」。
     * 而合并时被并那条和留下那条**是同一个字面**：记了这一笔，
     * 下次分析同一篇材料，**留下的那条也进不来了，而且不报错**。
     * 所以合并必须自己写那一句软删，绝不借那个入口。
     */
    const f = lecture()
    await dedupMerge(f.db, 1, { kind: 'safe' })
    assert.equal(
      await n(f, `select count(*) as n from term_ledger`),
      0,
      '★★ 合并往 term_ledger 记了账 —— 那句「以后别再收」会把留下的那条也挡在门外'
    )
  })

  it('MG-3 · ★ 不动被并那条的 item_lectures（否则从回收站恢复出来是个孤儿）', async () => {
    const f = lecture()
    await dedupMerge(f.db, 1, { kind: 'safe' })
    assert.equal(
      await n(f, `select count(*) as n from item_lectures where item_id = 2 and deleted_at is null`),
      1,
      '★ 归属被顺手软删了的话，他在回收站点「恢复」，然后哪儿都找不到它'
    )
  })

  it('MG-4 · ★★ Review 那一组一根手指都没碰过（策略在 db 层，不在界面）', async () => {
    const f = lecture()
    await dedupMerge(f.db, 1, { kind: 'safe' })
    for (const id of [3, 4]) {
      assert.equal(
        await n(f, `select count(*) as n from items where id = ${id} and deleted_at is null`),
        1,
        `★★ 跨层的第 ${id} 条被自动并掉了 —— 那是两种学习状态，而且他一眼都没看过`
      )
    }
    const after = await dedupScan(f.db, 1)
    assert.deepEqual(
      after.groups.map((g) => `${g.norm}:${g.bucket}`),
      ['take a toll:review'],
      '并完之后还剩那一组需要他看'
    )
  })

  it('MG-5 · 他自己挑主记录：要回判据里核一遍，不在同一组的不许并', async () => {
    const f = lecture()
    await assert.rejects(
      () => dedupMerge(f.db, 1, { kind: 'one', canonicalId: 3, loserIds: [1] }),
      /不在这一组重复里/,
      '★ 界面传什么就并什么的话，一个错的 id 就能把两条毫不相干的知识点并掉'
    )
    // 同一组里挑另一条为主 —— 这一支要真的能走通
    const out = await dedupMerge(f.db, 1, { kind: 'one', canonicalId: 4, loserIds: [3] })
    assert.equal(out.merged, 1)
    assert.equal(await n(f, `select count(*) as n from items where id = 3 and deleted_at is not null`), 1)
  })

  it('MG-6 · 账记在 ops_log：一行 merge，带两条 uid 与每张表迁了什么（D-458）', async () => {
    const f = lecture()
    await dedupMerge(f.db, 1, { kind: 'safe' })
    const row = await f.db.get(`select target, target_id as id, title, detail from ops_log where op = 'merge'`)
    assert.ok(row, '★ 没有账 = 事后问「那天到底并了什么」没人答得出')
    assert.equal(row?.['target'], 'item')
    assert.equal(Number(row?.['id']), 1)
    const detail = JSON.parse(String(row?.['detail'])) as {
      canonical: string
      merged: string
      steps: { kind: string; table: string }[]
    }
    assert.notEqual(detail.canonical, detail.merged, '两条 uid 都要记下来')
    assert.ok(
      detail.steps.some((s) => s.kind === 'repoint' && s.table === 'questions'),
      '每张表迁了什么也要记 —— D-458：给出一个数就要能答是哪些'
    )
  })
})
