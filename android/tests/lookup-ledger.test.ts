/**
 * LL · **流水按形态记，「最近查过」只列词**（I-144 · 真机 2026-09-07）
 *
 * ══ 它防的是哪一件已经发生过的事 ═══════════════════════════
 *
 * 真机 `ops_log` 1196–1201：使用者在 Reddit 上用气泡查了六次，其中**两次是机器
 * 在 61 ms 内发的第二次 lookup** —— 宿主把**整段正文**报成了选区，
 * 于是 159 / 281 字符的一整段以 `target='term'`、`title=<整段>` 进了流水，
 * 并且出现在 Lookup 首页的「最近查过」里。
 *
 * 两处一起修，各钉各的：
 *   写入侧 `engine/main.ts` —— 按 `shapeOf` 记；整句整段不存原文
 *   读出侧 `ledger.ts::recentLookups` —— 只给词与短语（**既有脏行当场不再出现**）
 *
 * ★ 为什么读出侧也要修：`ops_log` 在 `SYNC_TABLES` 里，删它要走删除三档（D-435）、
 *   不许裸 `delete`（D-436），而且会传到电脑那边；何况那些行记的是他**真的做过**
 *   的动作。所以不动数据，在读的时候只给词。
 *
 * ══ LG · 同一行还要答三个问题（T-4.14 · 归档 d §三 G / 判断五）═══════
 *
 * 形态之外，一次查词的 `detail` 记 **从哪查（source）· 哪一面（face）· 收没收（saved）**。
 * 与 LL 同一个写入口（`noteLookup`）—— 所以它们在同一个文件里：
 * 改坏任一半，另一半的用例也会看见。不加表不加列，结构指纹不动。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  asLookupDetail,
  markLookupSaved,
  noteLookup,
  op as ledgerOp,
  recentLookups,
  lookupWeek
} from '../src/db/ledger.ts'
import { shapeOf } from '../src/db/lookup.ts'
import { assistCapture } from '../src/db/capture.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

/** 真机上那一段的形状（Reddit 正文，281 字符那一条同族） */
const PARAGRAPH =
  'The housemaid was standing there in the doorway, and she said nothing at all. ' +
  'I could not tell whether she had heard me, or whether she simply did not care. ' +
  'It went on like that for a long while.'

/**
 * ★ 调的是**真件**（`ledger.ts::noteLookup`），不是照抄一份长得一样的。
 *   判据本来写在 `engine/main.ts` 里，而那个文件在 node 里 import 不进来
 *   （顶层要 `nyxHost`）—— 照抄一份只能证明抄件对，证不到真件。
 */
const record = (db: Parameters<typeof noteLookup>[0], term: string): Promise<void> =>
  // ★ T-4.14 起 `noteLookup` 还要说清「谁在查 · 哪一面」（没有默认值 —— 默认值
  //   就等于「忘了写的人静默拿到别人的来源」）。形态这一半与这两个字段无关，
  //   所以这里固定填气泡那一路，下面 LG 组再逐个盯 detail。
  noteLookup(db, term, { source: 'assist', face: 'quick' })

describe('LL · 查询流水按形态记（I-144）', () => {
  it('LL-1 · ★★ 整段不再记成 term，也不把原文抄进库', async () => {
    const f = builtDb()
    await record(f.db, PARAGRAPH)

    const rows = await f.db.all(`select target, title from ops_log where op = 'lookup'`)
    assert.equal(rows.length, 1, '这一次查询照旧要记下来（D-362 数动作）')
    assert.equal(
      String(rows[0]!['target']),
      'passage',
      '★★ 记成 term 就是真机上那个病 —— 整段被当成了一个词'
    )
    assert.equal(
      rows[0]!['title'],
      null,
      '★★ 整段是第三方 App 屏幕上的正文，流水要的是「他查了一次」这个事实，不是把帖子抄进库'
    )
  })

  it('LL-2 · 词与短语照旧原样记（别把这条修成「什么都不记」）', async () => {
    const f = builtDb()
    await record(f.db, 'stairwell')
    await record(f.db, 'in spite of')

    const rows = await f.db.all(
      `select target, title from ops_log where op = 'lookup' order by id`
    )
    assert.deepEqual(
      rows.map((r) => [String(r['target']), String(r['title'])]),
      [
        ['term', 'stairwell'],
        ['term', 'in spite of']
      ],
      '词与短语仍然是 term + 原文'
    )
  })

  it('LL-3 · ★★ 库里已经有的脏行：「最近查过」当场不再列它（一行同步数据都不动）', async () => {
    const f = builtDb()
    // 真机上那几行的样子：整段以 target='term' + title=<整段> 躺在库里
    await ledgerOp(f.db, 'lookup', 'term', null, PARAGRAPH)
    await ledgerOp(f.db, 'lookup', 'term', null, 'stairwell')

    const recent = await recentLookups(f.db, 3)
    assert.deepEqual(
      recent.map((r) => r.word),
      ['stairwell'],
      '★★ 整段还在库里（没删），但「最近查过」承诺的是词 —— 读的时候就只给词'
    )

    // 数据一行没动：两条 lookup 都还在，「一共查过几次」不受影响
    const left = await f.db.get(`select count(*) as n from ops_log where op = 'lookup'`)
    assert.equal(Number(left?.['n']), 2, '★ 不许去删 ops_log —— 它在 SYNC_TABLES 里（D-436）')
    assert.equal((await lookupWeek(f.db)).looked, 2, '「这周查过几次」按 op 数，两条都算')
  })

  it('LL-4 · 形态判据用的是既有那一份（不另发明一把尺）', () => {
    assert.equal(shapeOf('stairwell'), 'word')
    assert.equal(shapeOf('in spite of'), 'phrase')
    assert.equal(shapeOf(PARAGRAPH), 'passage')
  })
})

/** 账面本身（不经任何判据读回来） */
const lookupRows = (f: Fixture): Array<Record<string, unknown>> =>
  f.raw
    .prepare(`select id, title, detail, created_at, updated_at from ops_log where op = 'lookup' order by id`)
    .all() as Array<Record<string, unknown>>

const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

/**
 * 只留真代码 —— 头注里**引用旧写法**是正当的（`engine/main.ts` 的 I-144 那一段就把
 * `ledgerOp(db,'lookup',…)` 原样抄在注释里说明病因）。守卫要看的是有没有人再那么写，
 * 不是有没有人提起它。
 */
const NL = String.fromCharCode(10)

const codeOf = (s: string): string =>
  s
    .split(NL)
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join(NL)

describe('LG · 查词记账：从哪查 · 哪一面 · 收没收（T-4.14）', () => {
  it('LG-1 · 查一次 = 一行，detail 三字段都在（App 词典面）', async () => {
    const f = builtDb()
    seed(f)
    await noteLookup(f.db, 'serendipity', { source: 'app', face: 'dict' })

    const rows = lookupRows(f)
    assert.equal(rows.length, 1, '一次查询一行，不做点击流')
    assert.equal(rows[0]!['title'], 'serendipity', 'title 仍是词面（原来就有的那一格）')
    assert.deepEqual(
      JSON.parse(String(rows[0]!['detail'])),
      { source: 'app', face: 'dict', saved: null },
      'detail 三字段：从哪查 · 哪一面 · 收没收'
    )
  })

  it('LG-2 · 来源与面各记各的（气泡 quick · App 的 AI 搜索）', async () => {
    const f = builtDb()
    seed(f)
    await noteLookup(f.db, 'flex', { source: 'assist', face: 'quick' })
    await noteLookup(f.db, 'flex', { source: 'app', face: 'ai' })

    const rows = lookupRows(f)
    assert.equal(rows.length, 2)
    assert.deepEqual(asLookupDetail(rows[0]!['detail']), { source: 'assist', face: 'quick', saved: null })
    assert.deepEqual(asLookupDetail(rows[1]!['detail']), { source: 'app', face: 'ai', saved: null })
  })

  it('LG-3 · 查完就收：回填到那一行，updated_at 抬起来（同步才带得走）', async () => {
    const f = builtDb()
    seed(f)
    await noteLookup(f.db, 'serendipity', { source: 'assist', face: 'quick' })

    // 那一次查询是十分钟前的事 —— 时间戳挪开，回填有没有抬 updated_at 才看得出来
    const old = Date.now() - 600_000
    const id = Number(lookupRows(f)[0]!['id'])
    f.raw.prepare(`update ops_log set created_at = ?, updated_at = ? where id = ?`).run(old, old, id)

    const r = await assistCapture(f.db, 'serendipity', 'A', 'com.reddit.frontpage', 'assist')

    const rows = lookupRows(f)
    assert.equal(rows.length, 1, '收下不再记一行 lookup（capture 有它自己那一行）')
    assert.deepEqual(
      asLookupDetail(rows[0]!['detail']),
      { source: 'assist', face: 'quick', saved: r.id },
      'saved = 刚收下那条 items.id'
    )
    assert.ok(Number(rows[0]!['updated_at']) > old, 'updated_at 抬了 —— 这一行会再同步一次')
    assert.equal(Number(rows[0]!['created_at']), old, 'created_at 不动（原始时间不改，D-438）')

    const cap = f.raw
      .prepare(`select count(*) as n from ops_log where op = 'capture' and target_id = ?`)
      .get(r.id) as { n: number }
    assert.equal(Number(cap.n), 1, '收下那一行流水照旧')
  })

  it('LG-4 · 不乱回填：别的词 · 已回填过的 · 老行（detail 空）', async () => {
    const f = builtDb()
    seed(f)

    // ① 别的词的那一行不许被改
    await noteLookup(f.db, 'flex', { source: 'app', face: 'dict' })
    await noteLookup(f.db, 'serendipity', { source: 'app', face: 'dict' })
    const first = await assistCapture(f.db, 'serendipity', 'A', null, 'lookup')
    const afterFirst = lookupRows(f)
    assert.equal(asLookupDetail(afterFirst[0]!['detail'])!.saved, null, 'flex 那一行没被动')
    assert.equal(asLookupDetail(afterFirst[1]!['detail'])!.saved, first.id)

    // ② 同一个词第二次收（中间没再查）：改的不该是上一次那一行
    const again = await assistCapture(f.db, 'serendipity', 'A', null, 'lookup')
    assert.notEqual(again.id, first.id)
    assert.equal(
      asLookupDetail(lookupRows(f)[1]!['detail'])!.saved,
      first.id,
      '已回填过的不再动 —— 那一行说的是它自己那一次'
    )

    // ③ 老行：本条改动之前记的 lookup（detail 为空）——不知道 source/face 就不编
    await ledgerOp(f.db, 'lookup', 'term', null, 'quixotic')
    const done = await markLookupSaved(f.db, 'quixotic', 999)
    assert.equal(done, false, '认不出形状就不回填')
    const legacy = lookupRows(f).find((r) => r['title'] === 'quixotic')!
    assert.equal(legacy['detail'], null, '老行原样不动')
  })

  it('LG-5 · 两个入口都走同一份形状（不许哪一侧自己拼对象 / 裸记一行）', () => {
    const engine = src('../src/engine/main.ts')
    const page = src('../src/ui/views/Lookup.svelte')

    // 断言用整串比对（正则里的转义在这一层不值得）：两个入口都必须落在同一个函数上
    assert.ok(engine.includes('noteLookup(db, a.term, {'), '气泡（引擎）那一次走 noteLookup')
    assert.ok(engine.includes("source: 'assist'"), '气泡的来源是 assist')
    assert.ok(page.includes('noteLookup(db, w, {'), 'Lookup 页那一次走 noteLookup')
    assert.ok(page.includes("source: 'app'"), 'App 内的来源是 app')

    // 裸 `op(db, 'lookup', …)` = 第二份形状：写出来的 detail 是空的、形态也不看
    assert.ok(!codeOf(engine).toLowerCase().includes("op(db, 'lookup'"), '引擎不再自己写 lookup 流水')
    assert.ok(!codeOf(page).toLowerCase().includes("op(db, 'lookup'"), 'Lookup 页不再自己写 lookup 流水')
  })
})
