/**
 * 管理动作对照（N-1 ～ N-8 · 阶段 5）。
 *
 * 判据：`manage-nodes.ts` 与 Windows repo.ts / browse.ts 逐字同源。
 * 钉最容易改坏的口径：
 *   ① 新建默认名规则 ② reorder 跨父拒收（D-361）③ 容器软删同一时间戳
 *   批量下放 —— 恢复 ±2000 配对靠它 ④ 删讲：共用词条归属转移、独有的
 *   跟着走 + 账本 ⑤ 归档级联 + silenced_by=tag（4.2：取消只放 tag 的，
 *   self 静默的不跟着出来）⑥ 连带恢复 + 账本撤销 ⑦ markUnread 排期清零
 *   ⑧ 归档面/复制行。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  copyLines,
  createLecture,
  createProject,
  createUnit,
  deleteLecture,
  listArchived,
  markUnread,
  moveNode,
  reorder,
  restoreCascade,
  setPinned,
  setSilentNode
} from '../src/db/manage-nodes.ts'
import { softDeleteContainer } from '../src/db/manage-nodes.ts'
import { bulkSilence } from '../src/db/manage.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

const led = (f: Fixture, norm: string): Record<string, unknown> | undefined =>
  f.raw.prepare(`select revoked_at from term_ledger where norm = ? and verdict = 'deleted'`).get(norm) as
    | Record<string, unknown>
    | undefined

describe('N · 管理动作', () => {
  it('N-1 · 新建三级：默认名规则照 Windows；置顶只有项目', async () => {
    const f = builtDb()
    seed(f)
    const p = await createProject(f.db)
    const nm = f.raw.prepare(`select name, pinned from projects where id = ?`).get(p) as {
      name: string
      pinned: number
    }
    assert.ok(nm.name.startsWith('新项目 '), '默认名带日期')
    const u = await createUnit(f.db, p)
    assert.equal(
      (f.raw.prepare(`select name from units where id = ?`).get(u) as { name: string }).name,
      '第 1 单元'
    )
    const l = await createLecture(f.db, u)
    const lec = f.raw.prepare(`select name, number, status from lectures where id = ?`).get(l) as {
      name: string
      number: number
      status: string
    }
    assert.deepEqual({ ...lec }, { name: 'L1', number: 1, status: 'empty' })

    await setPinned(f.db, p, true)
    assert.equal((f.raw.prepare(`select pinned from projects where id = ?`).get(p) as { pinned: number }).pinned, 1)
  })

  it('N-2 · reorder：同父写 0..n；跨父 id 一律拒收（D-361）', async () => {
    const f = builtDb()
    seed(f)
    const u2 = await createUnit(f.db, 1)
    const l2 = await createLecture(f.db, 1)
    await reorder(f.db, 'lecture', 1, [l2, 1])
    const sorts = f.raw.prepare(`select id, sort from lectures where unit_id = 1 order by sort`).all() as {
      id: number
      sort: number
    }[]
    assert.deepEqual(sorts.map((x) => x.id), [l2, 1])

    const stray = await createLecture(f.db, u2)
    await assert.rejects(() => reorder(f.db, 'lecture', 1, [1, stray]), /不能跨级拖动/)
  })

  it('N-3 · 移动：讲换单元 · 单元换项目（与排序是两件事）', async () => {
    const f = builtDb()
    seed(f)
    const p2 = await createProject(f.db, 'P2')
    const u2 = await createUnit(f.db, p2)
    await moveNode(f.db, 'lecture', 1, u2)
    assert.equal(
      (f.raw.prepare(`select unit_id as u from lectures where id = 1`).get() as { u: number }).u,
      u2
    )
    await moveNode(f.db, 'unit', 1, p2)
    assert.equal(
      (f.raw.prepare(`select project_id as p from units where id = 1`).get() as { p: number }).p,
      p2
    )
  })

  it('N-4 · 删讲：共用词条归属交给下一讲；独有的跟着走 + 账本', async () => {
    const f = builtDb()
    seed(f)
    const l2 = await createLecture(f.db, 1, 'L2')
    const t = Date.now()
    // item1 同时挂在 L2（共用）；item2/3 独有
    f.raw
      .prepare(`insert into item_lectures (item_id, lecture_id, created_at, updated_at) values (1, ?, ?, ?)`)
      .run(l2, t, t)
    f.raw.prepare(`update items set owner_lecture_id = 1 where id in (1,2,3)`).run()
    f.raw.prepare(`update item_lectures set is_owner = 1 where lecture_id = 1`).run()

    const r = await deleteLecture(f.db, 1)
    assert.deepEqual({ items: r.items, moved: r.moved }, { items: 2, moved: 1 })
    const it1 = f.raw
      .prepare(`select owner_lecture_id as o, deleted_at as d from items where id = 1`)
      .get() as { o: number; d: number | null }
    assert.equal(it1.o, l2, '归属交给下一个用到它的讲')
    assert.equal(it1.d, null, '共用的不删')
    assert.ok(
      (f.raw.prepare(`select deleted_at as d from items where id = 2`).get() as { d: number | null }).d,
      '独有的跟着走'
    )
    assert.equal(led(f, 'term-2')?.['revoked_at'], null, '账本记了 deleted')
  })

  it('N-5 · 归档级联 + 4.2：取消只放 tag 静默的，self 静默的不出来', async () => {
    const f = builtDb()
    seed(f)
    // item3 先手动静默（self）
    await bulkSilence(f.db, [3], true)
    await setSilentNode(f.db, 'unit', 1, true)

    const lec = f.raw.prepare(`select silent, due_at as d from lectures where id = 1`).get() as {
      silent: number
      d: number | null
    }
    assert.equal(lec.silent, 1)
    assert.equal(lec.d, null, '归档停排')
    const tags = f.raw
      .prepare(`select id, production_state as s, silenced_by as by from items order by id`)
      .all() as { id: number; s: string; by: string | null }[]
    assert.deepEqual(
      tags.map((x) => x.by),
      ['unit', 'unit', 'self'],
      'self 的保持 self'
    )

    await setSilentNode(f.db, 'unit', 1, false)
    const after = f.raw
      .prepare(`select id, production_state as s, silenced_by as by from items order by id`)
      .all() as { id: number; s: string; by: string | null }[]
    assert.deepEqual(after.map((x) => x.s), ['training', 'training', 'silent'], '4.2：self 静默的不跟着出来')
    assert.equal(after[2]!.by, 'self')
  })

  it('N-6 · 连带恢复：单元 → 父级补活 + 同批 ±2000 词条 + 账本撤销', async () => {
    const f = builtDb()
    seed(f)
    f.raw.prepare(`update item_lectures set is_owner = 1 where lecture_id = 1`).run()
    f.raw.prepare(`update items set owner_lecture_id = 1 where id in (1,2,3)`).run()
    await deleteLecture(f.db, 1)
    await softDeleteContainer(f.db, 'unit', 1) // 讲已删，再删单元（补齐父链删除态）
    f.raw.prepare(`update projects set deleted_at = ? where id = 1`).run(Date.now())

    const n = await restoreCascade(f.db, 'unit', 1)
    assert.ok(n >= 2, `恢复了 ${n} 行`)
    assert.equal(
      (f.raw.prepare(`select deleted_at as d from units where id = 1`).get() as { d: number | null }).d,
      null
    )
    assert.equal(
      (f.raw.prepare(`select deleted_at as d from projects where id = 1`).get() as { d: number | null }).d,
      null,
      '父级补活'
    )
    assert.equal(
      (f.raw.prepare(`select deleted_at as d from lectures where id = 1`).get() as { d: number | null }).d,
      null
    )
    assert.equal(
      (f.raw.prepare(`select count(*) c from items where deleted_at is null`).get() as { c: number }).c,
      3,
      '同批词条回来了'
    )
    assert.ok(led(f, 'term-2')?.['revoked_at'] !== null, '账是撤销的')
  })

  it('N-7 · markUnread：status=review · 排期清零', async () => {
    const f = builtDb()
    seed(f)
    f.raw.prepare(`update lectures set status='training', due_at=1, interval_days=9 where id=1`).run()
    await markUnread(f.db, 1)
    const l = f.raw
      .prepare(`select status, due_at as d, interval_days as i from lectures where id = 1`)
      .get() as { status: string; d: number | null; i: number }
    assert.deepEqual({ ...l }, { status: 'review', d: null, i: 0 })
  })

  it('N-8 · 归档面列容器；copyLines 从库里取', async () => {
    const f = builtDb()
    seed(f)
    await setSilentNode(f.db, 'lecture', 1, true)
    const arch = await listArchived(f.db)
    assert.deepEqual(arch.map((a) => `${a.kind}:${a.id}`), ['lecture:1'])

    const text = await copyLines(f.db, [1, 2])
    assert.equal(text, 'term-1 — g\nterm-2 — g')
  })
})
