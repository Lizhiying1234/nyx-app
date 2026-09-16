/**
 * 馆藏搜索对照（SR-1 ～ SR-6）· 2026-09-01 · X-Ray 审计 F-013
 *
 * 判据逐字港自 Windows `main/browse.ts::search`（59-120），范围照 D-106：
 *   知识点（term / gloss，含静默与攻坚）+ 原文摘句 + 项目/单元/讲的名字
 *   **不搜** AI 对话与解析正文（机器写的长文本会把结果淹掉）
 *
 * 这一套钉四件事：
 *   ① 范围就是范围 —— 软删的不出现；解析正文不出现
 *   ② LIKE 的通配符**必须转义**（搜 `100%` 不能变成「整个库」，且不报错）
 *   ③ 字面命中排在释义命中前面
 *   ④ Android 形变：**不搜 files**（文件学习线整条不进手机 D-311，搜出来点不开）
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { search } from '../src/db/search.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

const t = Date.now()

/** 造一条知识点（seed 之外的），可指定字面与释义 */
function mkItem(f: Fixture, id: number, term: string, gloss: string): void {
  f.raw
    .prepare(
      `insert into items (id, term, gloss, layer, kind, source, created_at, updated_at)
       values (?, ?, ?, 'B', 'chunk', 'self', ?, ?)`
    )
    .run(id, term, gloss, t, t)
  f.raw
    .prepare(`insert into item_lectures (item_id, lecture_id, created_at, updated_at) values (?, 1, ?, ?)`)
    .run(id, t, t)
}

describe('SR · 馆藏搜索', () => {
  it('SR-1 · 词条与释义都搜，字面命中排前面', async () => {
    const f = builtDb()
    seed(f, { items: 0 })
    mkItem(f, 10, 'outrun', '跑得比…快')
    mkItem(f, 11, 'run', '跑')
    mkItem(f, 12, 'sprint', 'a short fast run')

    const r = await search(f.db, 'run')
    const terms = r.items.map((x) => x.term)

    assert.ok(terms.includes('run'))
    assert.ok(terms.includes('outrun'))
    assert.ok(terms.includes('sprint'), '★ 释义里有 run 的也要出来')
    // 字面命中（term like）排在只有释义命中的前面
    assert.ok(terms.indexOf('sprint') > terms.indexOf('run'))
  })

  it('SR-2 · 软删的不出现 —— 范围就是范围', async () => {
    const f = builtDb()
    seed(f, { items: 0 })
    mkItem(f, 10, 'stairwell', '楼梯间')
    mkItem(f, 11, 'stairway', '楼梯')
    f.raw.prepare(`update items set deleted_at = ? where id = 11`).run(t)

    const r = await search(f.db, 'stair')
    assert.deepEqual(r.items.map((x) => x.term), ['stairwell'])
  })

  it('SR-3 · ★ LIKE 通配符必须转义（否则搜 % 会倒出整个库，而且不报错）', async () => {
    const f = builtDb()
    seed(f, { items: 0 })
    mkItem(f, 10, 'cent', '百分之一')
    mkItem(f, 11, '100% sure', '十拿九稳')
    mkItem(f, 12, 'a_b', '带下划线的')

    const pct = await search(f.db, '%')
    assert.deepEqual(
      pct.items.map((x) => x.term),
      ['100% sure'],
      '★ `%` 要当字面量搜，不能当通配符'
    )

    const und = await search(f.db, '_')
    assert.deepEqual(und.items.map((x) => x.term), ['a_b'], '★ `_` 同理')
  })

  it('SR-4 · 原文摘句也搜（M-012：出处是知识点身份的一半）', async () => {
    const f = builtDb()
    seed(f, { items: 0 })
    mkItem(f, 10, 'stairwell', '楼梯间')
    f.raw
      .prepare(
        `insert into occurrences (item_id, material_id, lecture_id, quote, created_at, updated_at)
         values (10, null, 1, 'He waited in the dim stairwell for an hour.', ?, ?)`
      )
      .run(t, t)

    const r = await search(f.db, 'dim')
    assert.equal(r.items.length, 0, '词条里没有 dim')
    assert.equal(r.quotes.length, 1)
    assert.equal(r.quotes[0]!.term, 'stairwell')
    assert.equal(r.quotes[0]!.lecture, 'L', '带上它挂在哪一讲')
  })

  it('SR-5 · 节点名也搜；项目/单元/讲三级各自带 kind 与父级', async () => {
    const f = builtDb()
    seed(f, { items: 0 })
    f.raw.prepare(`update projects set name = 'Epigraph' where id = 1`).run()
    f.raw.prepare(`update units set name = 'Chapter 1' where id = 1`).run()
    f.raw.prepare(`update lectures set name = 'Epigraph reading' where id = 1`).run()

    const r = await search(f.db, 'epigraph')
    const kinds = r.places.map((p) => `${p.kind}:${p.name}`)
    assert.ok(kinds.includes('project:Epigraph'))
    assert.ok(kinds.includes('lecture:Epigraph reading'))
    const lec = r.places.find((p) => p.kind === 'lecture')!
    assert.equal(lec.parent, 'Chapter 1', '讲带上它的单元名 —— 同名讲要分得开')
  })

  it('SR-6 · ★ 范围外的一律不出现：解析正文 · 空查询', async () => {
    const f = builtDb()
    seed(f, { items: 0 })
    mkItem(f, 10, 'stairwell', '楼梯间')
    // 解析正文里塞一个只在那里出现的词 —— 它**不该**被搜到
    f.raw
      .prepare(
        `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
         values (10, 'summary', 'the vestibule of a tenement', ?, ?)`
      )
      .run(t, t)

    const r = await search(f.db, 'vestibule')
    assert.equal(r.items.length, 0, '★ D-106：不搜解析正文')
    assert.equal(r.quotes.length, 0)
    assert.equal(r.places.length, 0)

    const empty = await search(f.db, '   ')
    assert.deepEqual(empty, { query: '', items: [], quotes: [], places: [] })
  })
})
