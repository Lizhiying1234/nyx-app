import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { builtDb, cleanup, seed } from './helpers.ts'
import { moveItemsTo } from '../src/db/manage.ts'

after(cleanup)

/**
 * MV · 移动（⑨ / D-436③ / V36）—— 钉的是**跨端**那一半。
 *
 * 老实现是「删旧收录行 + 插新收录行」。`item_lectures` 是同步表，
 * 而删一行**不会立墓碑**（`TOMBSTONE_KINDS` 只覆盖六类实体，有意的），
 * 所以「从旧讲摘出来」这一半**到不了另一台** —— 对面两个讲次里都留着它。
 * V36 改成软删：那是一次普通的行更新，跟着同步走。
 *
 * ★ 下面每一条都在问同一件事：**这次移动，另一台能不能知道**。
 */
describe('MV · 移动（V36 软删）', () => {
  /** 播一个两讲的库：L1 有 term-1..3，L2 是空的 */
  function twoLectures(): ReturnType<typeof builtDb> {
    const f = builtDb()
    seed(f, { items: 3 })
    const t = Date.now()
    f.raw
      .prepare(`insert into lectures (id,unit_id,name,status,created_at,updated_at) values (2,1,'L2','review',?,?)`)
      .run(t, t)
    return f
  }
  const link = (f: ReturnType<typeof builtDb>, item: number, lec: number) =>
    f.raw
      .prepare(`select deleted_at as d, uid from item_lectures where item_id=? and lecture_id=?`)
      .get(item, lec) as { d: number | null; uid: string } | undefined

  it('MV-1 · 移动之后，旧收录行**还在**，只是被软删了（不然对面不知道它走了）', async () => {
    const f = twoLectures()
    const r = await moveItemsTo(f.db, [1], 1, 2)
    assert.equal(r.moved, 1)
    const old = link(f, 1, 1)
    assert.ok(old, '★ 旧行不许被删掉 —— 删了就没有东西可以同步过去')
    assert.ok(old.d !== null, '旧行要带上 deleted_at')
    const now = link(f, 1, 2)
    assert.ok(now && now.d === null, '新讲那行是活的')
  })

  it('MV-2 · 讲次里的条目数按「活着的」算', () => {
    const f = twoLectures()
    const count = (lec: number): number =>
      (
        f.raw
          .prepare(
            `select count(*) as n from item_lectures il join items i on i.id = il.item_id
              where il.lecture_id = ? and i.deleted_at is null and il.deleted_at is null`
          )
          .get(lec) as { n: number }
      ).n
    assert.equal(count(1), 3)
    return moveItemsTo(f.db, [1, 2], 1, 2).then(() => {
      assert.equal(count(1), 1, '移走两条，原讲只剩一条')
      assert.equal(count(2), 2)
    })
  })

  it('MV-3 · ★★ 移回原讲 = **复活同一行**，不是插一条新的（uid 不变）', async () => {
    const f = twoLectures()
    const before = link(f, 1, 1)!
    await moveItemsTo(f.db, [1], 1, 2)
    await moveItemsTo(f.db, [1], 2, 1)
    const back = link(f, 1, 1)!
    assert.equal(back.d, null, '移回来那行要活过来')
    assert.equal(back.uid, before.uid, '★ uid 必须一模一样 —— 它是从 (知识点,讲) 推出来的，插新行会撞主键')
    const rows = (
      f.raw
        .prepare(`select count(*) as n from item_lectures where item_id = 1 and lecture_id = 1`)
        .get() as { n: number }
    ).n
    assert.equal(rows, 1, '只能有一行')
    // 而它离开的那一讲，这次轮到它被软删
    assert.ok(link(f, 1, 2)!.d !== null)
  })

  it('MV-4 · 目标讲里已经有它（活着的）→ 只摘不插，算「合并」', async () => {
    const f = twoLectures()
    const t = Date.now()
    f.raw
      .prepare(`insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (1,2,?,?)`)
      .run(t, t)
    const r = await moveItemsTo(f.db, [1], 1, 2)
    assert.equal(r.merged, 1)
    assert.equal(r.moved, 0)
    assert.ok(link(f, 1, 1)!.d !== null, '原讲那行照样软删')
    assert.equal(link(f, 1, 2)!.d, null)
  })

  it('MV-5 · 它根本不在原讲里 → 什么都不做（软删的也算「不在」）', async () => {
    const f = twoLectures()
    await moveItemsTo(f.db, [1], 1, 2) // 现在 (1,L1) 是软删的
    const r = await moveItemsTo(f.db, [1], 1, 2) // 再从 L1 移一次
    assert.equal(r.moved, 0)
    assert.equal(r.merged, 0)
  })
})
