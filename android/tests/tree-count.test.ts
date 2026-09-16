/**
 * Atlas 三层计数 —— 「显示的数」必须等于「真的有多少条」
 *
 * 两条判据，各挡一次真实事故（2026-09-03 使用者报「数量对不上」）：
 *   ① 跨讲共享的知识点在项目 / 单元这一层**只算一条**（老写法是把每讲加起来）
 *   ② 静默 / 软删的那些，父级计数与树上看得见的东西口径一致
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { builtDb, cleanup } from './helpers.ts'
import { applyCounts, loadTree, loadTreeCounts } from '../src/db/tree.ts'

/**
 * ★ I-186：这个文件原来**一条 `after(cleanup)` 都没有** —— 每跑一次漏 7 个临时目录，
 *   而且没有任何东西会说话。全仓 33 个用例文件里只有它漏，隔离量出来的就是这 7 个。
 */
after(cleanup)

const t = Date.now()

function seedTree(): ReturnType<typeof builtDb> {
  const f = builtDb()
  const q = (sql: string, ...p: unknown[]): void => {
    f.raw.prepare(sql).run(...(p as never[]))
  }
  q(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`, t, t)
  q(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U1',?,?)`, t, t)
  q(`insert into units (id,project_id,name,created_at,updated_at) values (2,1,'U2',?,?)`, t, t)
  for (const [id, unit] of [[1, 1], [2, 1], [3, 2]] as [number, number][]) {
    q(
      `insert into lectures (id,unit_id,name,status,created_at,updated_at)
       values (?,?,?,'training',?,?)`,
      id, unit, `L${id}`, t, t
    )
  }
  for (const id of [1, 2, 3, 4]) {
    q(
      `insert into items (id,term,layer,kind,source,owner_lecture_id,confidence,created_at,updated_at)
       values (?,?,'A','chunk','ai',1,1.0,?,?)`,
      id, `w${id}`, t, t
    )
  }
  return f
}

const link = (f: ReturnType<typeof builtDb>, item: number, lec: number, owner = 0): void => {
  f.raw
    .prepare(
      `insert into item_lectures (item_id,lecture_id,is_owner,created_at,updated_at)
       values (?,?,?,?,?)`
    )
    .run(item, lec, owner, t, t)
}

describe('Atlas 计数 · 跨讲共享只算一条', () => {
  it('★★ 同一条挂两讲 —— 讲次各算一次，单元与项目只算一条', async () => {
    const f = seedTree()
    // U1/L1: w1 w2(共享)   U1/L2: w2(共享) w3   U2/L3: w4
    link(f, 1, 1, 1)
    link(f, 2, 1, 1)
    link(f, 2, 2)
    link(f, 3, 2, 1)
    link(f, 4, 3, 1)

    const tree = await loadTree(f.db)
    const p = tree[0]!
    const [u1, u2] = p.units

    assert.deepEqual(u1!.lectures.map((l) => l.itemCount), [2, 2], '讲次那一层照旧各算各的')
    assert.equal(u1!.itemCount, 3, '★ 单元把共享的那条数了两遍')
    assert.equal(u2!.itemCount, 1)
    assert.equal(p.itemCount, 4, '★ 项目把共享的那条数了两遍（老写法会给 5）')
  })

  it('一条都不挂的项目是 0，不是 undefined', async () => {
    const f = seedTree()
    const p = (await loadTree(f.db))[0]!
    assert.equal(p.itemCount, 0)
    assert.equal(p.units[0]!.itemCount, 0)
  })
})

describe('Atlas 计数 · 过滤条件', () => {
  it('★ 软删的知识点不算', async () => {
    const f = seedTree()
    link(f, 1, 1, 1)
    link(f, 2, 1, 1)
    f.raw.prepare(`update items set deleted_at = ? where id = 2`).run(t)
    const p = (await loadTree(f.db))[0]!
    assert.equal(p.units[0]!.lectures[0]!.itemCount, 1)
    assert.equal(p.itemCount, 1)
  })

  it('★ 收录关系被软删（从这一讲移出去）也不算 —— V36 之后它是软删不是删行', async () => {
    const f = seedTree()
    link(f, 1, 1, 1)
    link(f, 2, 1, 1)
    f.raw.prepare(`update item_lectures set deleted_at = ? where item_id = 2`).run(t)
    const p = (await loadTree(f.db))[0]!
    assert.equal(p.units[0]!.lectures[0]!.itemCount, 1)
    assert.equal(p.itemCount, 1)
  })

  it('★★ 静默的讲不在树上 —— 它底下的条目也不许算进父级，否则展开到底也对不出来', async () => {
    const f = seedTree()
    link(f, 1, 1, 1) // L1 · 看得见
    link(f, 2, 2, 1) // L2 · 马上静默
    f.raw.prepare(`update lectures set silent = 1 where id = 2`).run()
    const p = (await loadTree(f.db))[0]!
    assert.equal(p.units[0]!.lectures.length, 1, '前提：静默的讲本来就不在树上')
    assert.equal(p.units[0]!.itemCount, 1)
    assert.equal(p.itemCount, 1)
  })

  it('★ 只挂在静默讲上的那条，父级不算；但它同时挂着一个活着的讲时要算', async () => {
    const f = seedTree()
    link(f, 1, 1, 1)
    link(f, 1, 2) // 同一条也挂在即将静默的 L2 上
    link(f, 2, 2, 1) // 只挂在 L2
    f.raw.prepare(`update lectures set silent = 1 where id = 2`).run()
    const p = (await loadTree(f.db))[0]!
    assert.equal(p.itemCount, 1, 'w1 还看得见（挂在 L1），w2 只在静默讲下面')
  })
})

describe('Atlas 计数 · 不重装树也能刷新', () => {
  it('★★ 删掉一条之后只调 applyCounts —— 三层的数都跟着变（结构不动）', async () => {
    const f = seedTree()
    link(f, 1, 1, 1)
    link(f, 2, 1, 1)
    const tree = await loadTree(f.db)
    assert.equal(tree[0]!.itemCount, 2)

    f.raw.prepare(`update items set deleted_at = ? where id = 2`).run(t)
    applyCounts(tree, await loadTreeCounts(f.db))

    assert.equal(tree[0]!.itemCount, 1, '★ 项目上的数没跟着删除走')
    assert.equal(tree[0]!.units[0]!.itemCount, 1)
    assert.equal(tree[0]!.units[0]!.lectures[0]!.itemCount, 1, '★ 讲次上的数没跟着删除走')
  })
})
