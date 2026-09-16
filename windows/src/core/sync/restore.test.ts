/**
 * 还原被盖掉的那一版 · T-2.5 —— 判据用例
 *
 * 这一套只验判据：detail 解不解得开、要不要先翻译、该不该写、写哪几列。
 * 真的写库、真的两台设备走一遍在 `tests/db-safety.ts`。
 *
 * ★ 重点在**拒绝**那几条：还原是他为了找回内容点的，
 *   一次写错要他自己发现「这条记录变成了没见过的样子」—— 那种失败最贵。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsTranslate,
  parseOverride,
  planRestore,
  type LostVersion,
  type OverrideEntry,
  type RestoreInput
} from './restore.ts'

const NOW = 1_800_000_000_000

/** `engine.ts::noteOverrides` 写进 detail 的形状，一字不差 */
const detailOf = (over: Partial<LostVersion> = {}): string =>
  JSON.stringify({
    uid: 'projects-abc',
    kept: 'remote',
    keptAt: NOW - 1000,
    lostAt: NOW - 5000,
    lost: { uid: 'projects-abc', id: 7, name: '我起的名字', updated_at: NOW - 5000 },
    ...over
  })

const entryOf = (over: Partial<OverrideEntry> = {}): OverrideEntry => ({
  id: 42,
  table: 'projects',
  detail: detailOf(),
  ...over
})

const inputOf = (over: Partial<RestoreInput> = {}): RestoreInput => {
  const entry = over.entry ?? entryOf()
  const parsed = parseOverride(entry)
  assert.ok(parsed.ok, '夹具自己的 detail 该解得开')
  return {
    entry,
    v: parsed.v,
    localData: parsed.v.lost,
    current: { uid: 'projects-abc', id: 7, name: '对面起的名字', deleted_at: null, updated_at: NOW - 1000 },
    columns: ['id', 'uid', 'name', 'deleted_at', 'created_at', 'updated_at'],
    alreadyRestored: false,
    now: NOW,
    ...over
  }
}

describe('T-2.5 · 把 detail 解出来', () => {
  it('正常那一笔解得开，字段一个不少', () => {
    const r = parseOverride(entryOf())
    assert.ok(r.ok)
    assert.equal(r.v.uid, 'projects-abc')
    assert.equal(r.v.kept, 'remote')
    assert.equal(r.v.lostAt, NOW - 5000)
    assert.equal(r.v.lost['name'], '我起的名字')
  })

  it('★ 被 8000 字截断的那一笔 → 说人话，不猜', () => {
    const r = parseOverride(entryOf({ detail: detailOf().slice(0, 40) }))
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /不完整|截断/)
  })

  it('★ detail 是空 / 不是对象 / 缺 uid / 缺 kept / 缺 lost → 各自一句人话', () => {
    for (const bad of [
      '',
      '"就是一个字符串"',
      JSON.stringify({ kept: 'remote', lost: {} }),
      JSON.stringify({ uid: 'x', lost: {} }),
      JSON.stringify({ uid: 'x', kept: 'remote' }),
      JSON.stringify({ uid: 'x', kept: '谁知道', lost: {} })
    ]) {
      const r = parseOverride(entryOf({ detail: bad }))
      assert.equal(r.ok, false, `这一笔不该解得开：${bad}`)
      assert.ok((r as { why: string }).why.length > 0)
    }
  })
})

describe('T-2.5 · 形状判定（lost 有两种）', () => {
  it('★★★ kept=remote → 本地形，不用翻译；kept=local → 同步形，必须先过 toLocal', () => {
    const local = parseOverride(entryOf({ detail: detailOf({ kept: 'remote' }) }))
    const sync = parseOverride(entryOf({ detail: detailOf({ kept: 'local' }) }))
    assert.ok(local.ok && sync.ok)
    assert.equal(needsTranslate(local.v), false)
    assert.equal(needsTranslate(sync.v), true)
  })
})

describe('T-2.5 · 该不该写、写哪几列', () => {
  it('★ 正常一条：写回旧值，顶新 updated_at，不碰 id 与 uid', () => {
    const r = planRestore(inputOf())
    assert.ok(r.ok, (r as { why?: string }).why)
    assert.equal(r.plan.table, 'projects')
    assert.equal(r.plan.uid, 'projects-abc')
    assert.equal(r.plan.set['name'], '我起的名字')
    assert.equal(r.plan.set['updated_at'], NOW, '★★★ 不顶新时间戳的话，还原同步不出去')
    assert.ok(Number(r.plan.set['updated_at']) > (NOW - 1000), '★ 至少要比盖住它的那一版新')
    assert.equal('id' in r.plan.set, false, '★ id 从不跨设备，还原也不许动它')
    assert.equal('uid' in r.plan.set, false, '★ uid 是身份，还原内容不许换身份')
    assert.deepEqual(r.plan.columns, ['name', 'updated_at'])
  })

  it('★★★ 盖住它的那一版带着未来的时间戳 → 还要再往前挪一毫秒，否则还原当场又被盖回来', () => {
    const future = NOW + 3 * 3600_000
    const entry = entryOf({ detail: detailOf({ keptAt: future }) })
    const r = planRestore(inputOf({ entry }))
    assert.ok(r.ok, (r as { why?: string }).why)
    assert.equal(
      r.plan.set['updated_at'],
      future + 1,
      '★★★ 只取 now 的话，对面钟快三小时时还原永远传不出去（他会看到「还原好了」然后什么都没变）'
    )
  })

  it('★ 表不在 SYNC_TABLES → 拒', () => {
    const r = planRestore(inputOf({ entry: entryOf({ table: 'settings' }) }))
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /不参与同步/)
  })

  it('★ 已经还原过 → 说「已经还原过」，不再写一遍', () => {
    const r = planRestore(inputOf({ alreadyRestored: true }))
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /已经还原过/)
  })

  it('★★ 行已经不在了（多半是被彻底删除）→ 拒，绝不 insert 复活它', () => {
    const r = planRestore(inputOf({ current: null }))
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /不在库里|复活/)
  })

  it('★ 这一条现在在回收站里 → 拒（一个按钮不做两件事）', () => {
    const r = planRestore(
      inputOf({ current: { uid: 'projects-abc', id: 7, name: 'x', deleted_at: NOW - 10 } })
    )
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /回收站/)
  })

  it('★ 被盖那一版本身是「已删除」→ 拒（还原不该等于替他重新删一次）', () => {
    const entry = entryOf({
      detail: detailOf({ lost: { uid: 'projects-abc', name: 'x', deleted_at: NOW - 900 } })
    })
    const r = planRestore(inputOf({ entry }))
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /重新扔进回收站/)
  })

  it('★★ 列对不上 → 拒，绝不静默丢列（只写一半 = 一条从来没存在过的记录）', () => {
    const entry = entryOf({
      detail: detailOf({ lost: { uid: 'projects-abc', name: 'x', 已经没有的列: 1 } })
    })
    const r = planRestore(inputOf({ entry }))
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /本机没有的列/)
  })

  it('★ 同步形没翻译就送进来 → 列对不上那条闸兜住（lecture_uid 本机没有这一列）', () => {
    const entry = entryOf({
      table: 'lectures',
      detail: detailOf({ kept: 'local', lost: { uid: 'lectures-1', name: 'L', unit_uid: 'units-9' } })
    })
    const r = planRestore(
      inputOf({
        entry,
        current: { uid: 'lectures-1', id: 3, name: 'L2', unit_id: 9, deleted_at: null },
        columns: ['id', 'uid', 'name', 'unit_id', 'deleted_at', 'updated_at']
      })
    )
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /unit_uid/)
  })

  it('★ 只剩 id / uid 可写 → 没有可以还原的内容', () => {
    const entry = entryOf({ detail: detailOf({ lost: { uid: 'projects-abc', id: 7 } }) })
    const r = planRestore(inputOf({ entry }))
    assert.equal(r.ok, false)
    assert.match((r as { why: string }).why, /没有可以还原的内容/)
  })

  it('翻译过的同步形（列名已经是本地的）→ 照常写得回去', () => {
    const entry = entryOf({
      table: 'lectures',
      detail: detailOf({ kept: 'local', lost: { uid: 'lectures-1', name: '对面的名字', unit_uid: 'units-9' } })
    })
    const r = planRestore(
      inputOf({
        entry,
        // 调用方过完 toLocal 之后的样子：unit_uid → unit_id
        localData: { uid: 'lectures-1', name: '对面的名字', unit_id: 9 },
        current: { uid: 'lectures-1', id: 3, name: '我的名字', unit_id: 9, deleted_at: null },
        columns: ['id', 'uid', 'name', 'unit_id', 'deleted_at', 'updated_at']
      })
    )
    assert.ok(r.ok, (r as { why?: string }).why)
    assert.equal(r.plan.set['name'], '对面的名字')
    assert.equal(r.plan.set['unit_id'], 9)
    assert.equal(r.plan.set['updated_at'], NOW)
  })
})
