/**
 * 读路径对照（阶段 2 · R-1 ～ R-6）。
 *
 * 判据：`read-path.ts` 的查询与 Windows `repo.ts::lecture/items`、
 * `study.ts::itemDetail` **逐字同源** —— 这里验的是它在真 SQLite 上
 * 取回的形状与数目对不对，含三条最容易漏的口径：
 *   ① 软删的条目不出现（ALIVE）② 摘句取首处 ③ 详情页不再读历次作答（D-468）。
 *
 * ★ R-5 还多守一件事：**分组表与 core 的 `RENDERED_BLOCKS` 对得上** ——
 *   手机比 Windows 少画几块，差集必须一条条登记在 `BLOCKS_NOT_SHOWN` 里。
 *   没有这条，「有意不画」和「加了新块忘了铺」在屏幕上长得一模一样（I-112）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { RENDERED_BLOCKS } from '../src/core-link.ts'
import {
  loadItemDetail,
  loadLecture,
  BLOCK_GROUPS,
  BLOCKS_NOT_SHOWN,
  blocksToShow,
  blockLines
} from '../src/db/read-path.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

function seedReadPath(f: Fixture): void {
  const t = Date.now()
  const q = (sql: string, ...p: unknown[]): void => {
    f.raw.prepare(sql).run(...(p as never[]))
  }
  // 材料 + 两处出处（D-152：全存，界面默认显首处）
  q(`insert into materials (id, lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
     values (1, 1, 'original', 'M1', 'paste', 'text', 120, ?, ?)`, t, t)
  q(`insert into occurrences (item_id, material_id, lecture_id, quote, para, created_at, updated_at)
     values (1, 1, 1, 'first quote with term-1 inside', 0, ?, ?)`, t, t)
  // ★ 自然键 =（词条 × 材料）—— 同一材料不会有第二行；「多处」= 跨材料（D-152 的真实口径）
  q(`insert into materials (id, lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
     values (2, 1, 'original', 'M2', 'paste', 'text', 80, ?, ?)`, t, t)
  q(`insert into occurrences (item_id, material_id, lecture_id, quote, para, created_at, updated_at)
     values (1, 2, 1, 'second quote, also term-1', 3, ?, ?)`, t + 1, t + 1)
  // 解析块：item1 一块正文；item2 一块 suspect（列表 ✎ 的判据）
  q(`insert into analysis_blocks (item_id, block, content, edited, regen_count, created_at, updated_at)
     values (1, 'meaning', 'does something in this sentence', 0, 0, ?, ?)`, t, t)
  q(`insert into analysis_blocks (item_id, block, content, edited, regen_count, created_at, updated_at)
     values (2, 'suspect', '[{"i":0}]', 0, 0, ?, ?)`, t, t)
  // 历史：一条首答（带 annotations）+ 一条小操练事件（混入同线）
  q(`insert into questions (id, item_id, tier, type, prompt, created_at, updated_at)
     values (9, 1, 2, 'situation', 'Q?', ?, ?)`, t, t)
  q(`insert into answers (item_id, question_id, attempt_no, is_first, text, grade, annotations, hinted, created_at, updated_at)
     values (1, 9, 1, 1, 'my answer', 3, '[{"label":"语域"}]', 0, ?, ?)`, t + 10, t + 10)
  q(`insert into item_events (item_id, kind, detail, created_at, updated_at)
     values (1, 'drill', '{"q":"d?","mine":"mine","correct":true,"verdict":"对","why":"w"}', ?, ?)`, t + 20, t + 20)
  // 归属：owner 链是 lectureName 的判据（I-045）—— seed 没设，补上 item1 的
  q(`update item_lectures set is_owner = 1 where item_id = 1 and lecture_id = 1`)
  // 析出：item3 改挂 derived_from=1（D-148）
  q(`update items set derived_from = 1 where id = 3`)
  // 软删一条别的讲次外条目？—— 用 item2 验 ALIVE 的话会破别的断言；
  // 另插一条已软删的，确认列表不带它
  q(`insert into items (id, term, gloss, layer, kind, source, deleted_at, created_at, updated_at)
     values (99, 'ghost', 'g', 'B', 'chunk', 'self', ?, ?, ?)`, t, t, t)
  q(`insert into item_lectures (item_id, lecture_id, created_at, updated_at) values (99, 1, ?, ?)`, t, t)
}

describe('R · 读路径', () => {
  it('R-1 · loadLecture：头/材料/条目齐，软删不出现（ALIVE）', async () => {
    const f = builtDb()
    seed(f)
    seedReadPath(f)
    const d = await loadLecture(f.db, 1)
    assert.equal(d.lecture.name, 'L')
    assert.equal(d.lecture.projectName, 'P')
    assert.equal(d.lecture.itemCount, 3, '软删的 99 不该被数进去')
    assert.equal(d.materials.length, 2)
    assert.equal(d.items.length, 3)
    assert.ok(!d.items.some((i) => i.term === 'ghost'), '软删条目出现在列表里了')
  })

  it('R-2 · 行上的记号口径：摘句=首处 · ✎=存在 suspect 块 · 析出计数', async () => {
    const f = builtDb()
    seed(f)
    seedReadPath(f)
    const d = await loadLecture(f.db, 1)
    const i1 = d.items.find((i) => i.id === 1)!
    const i2 = d.items.find((i) => i.id === 2)!
    assert.equal(i1.quote, 'first quote with term-1 inside', '摘句必须取第一处')
    assert.equal(i1.derivedCount, 1, 'item3 挂在它名下')
    assert.equal(i2.hasSuspect, true)
    assert.equal(i1.hasSuspect, false)
  })

  it('R-3 · loadItemDetail：出处全存、块、析出', async () => {
    const f = builtDb()
    seed(f)
    seedReadPath(f)
    const d = await loadItemDetail(f.db, 1)
    assert.equal(d.occurrences.length, 2, 'D-152：多处出处全部保留')
    assert.equal(d.occurrences[0]!.quote.startsWith('first'), true)
    assert.ok(d.blocks.some((b) => b.block === 'meaning'))
    assert.equal(d.derived.length, 1)
    assert.equal(d.derived[0]!.id, 3)
    assert.equal(d.item.lectureName, 'L')
  })

  it('R-4 · 历次作答不再进这一屏（D-468）—— 但那一行答案还在库里', async () => {
    const f = builtDb()
    seed(f)
    seedReadPath(f)
    // ★ 夹具里那条首答（grade=3，带 annotations）是**故意留着**的：
    //   它证明「不画」是读路径不去问，不是数据没了（D-436 同步表一行不动）。
    assert.equal(
      (f.raw.prepare('select count(*) as n from answers where item_id = 1').get() as { n: number }).n,
      1,
      'answers 那一行不该被这次删减动到'
    )
    const d = await loadItemDetail(f.db, 1)
    assert.equal('history' in (d as object), false, '详情页数据里不该再有 history —— 取数那段该整段删掉')
  })

  it('R-5 · 分组表 ↔ core 名单：一块都不许悄悄掉（登记在案的除外）', () => {
    const keys = BLOCK_GROUPS.flatMap((g) => g.blocks.map(([k]) => k))
    const rendered = new Set<string>(RENDERED_BLOCKS as readonly string[])
    const notShown = Object.keys(BLOCKS_NOT_SHOWN)

    assert.equal(new Set(keys).size, keys.length, '分组里出现重复块名')

    for (const k of keys) {
      assert.ok(rendered.has(k), `分组里的 ${k} 不在 core 的 RENDERED_BLOCKS 里 —— 它永远不会有内容`)
    }
    for (const k of notShown) {
      assert.ok(rendered.has(k), `「有意不画」名单里的 ${k} 在 core 里已经没有了 —— 名单过期了，删掉它`)
    }
    // ★ 负向对照的落点：把 zhTrap / pitfalls 塞回分组表 → 这一条红
    for (const k of keys) {
      assert.ok(!notShown.includes(k), `${k} 一边登记着「有意不画」、一边又画出来了：${BLOCKS_NOT_SHOWN[k]}`)
    }
    // ★ core 加了新块而手机没铺 → 这一条红（既没画、也没登记）
    for (const k of rendered) {
      assert.ok(
        keys.includes(k) || notShown.includes(k),
        `core 的 ${k} 手机既没画也没登记 —— 写进去了但屏幕上看不见（I-112）`
      )
    }
  })

  it('R-5b · 详情页只剩一层正文，顺序是 正文 → REGISTER & NUANCE → CLOSE READING（D-468）', () => {
    assert.deepEqual(
      BLOCK_GROUPS.slice(1).map((g) => g.title),
      ['REGISTER & NUANCE', 'CLOSE READING'],
      '分寸辨析比 Close Reading 常用（M-037），它排在前面'
    )
    const titles = BLOCK_GROUPS.map((g) => g.title).join(' ')
    for (const dead of ['BASICS', 'ADVANCED', 'COMMON SLIPS', 'ZH TRAP']) {
      assert.ok(!titles.includes(dead), `「${dead}」这个名字不该还在（D-468 / D-471）`)
    }
    const body = BLOCK_GROUPS[0]!
    assert.deepEqual(
      body.blocks.map(([k]) => k),
      ['inSentence', 'meaning', 'barriers', 'verbs', 'pattern', 'pragmatics', 'variation'],
      '一层正文按「先看懂 → 再会用」排；合并块与它的两个老键排在最前'
    )
  })

  it('R-5c · 合并块：新解析一块、老词条两块，都落在同一个区域里（D-468）', () => {
    const body = BLOCK_GROUPS[0]!
    const [merged, ...legacy] = ['inSentence', 'meaning', 'barriers'].map(
      (k) => body.blocks.find(([b]) => b === k)!
    )
    assert.equal(legacy.length, 2)
    for (const [, title] of legacy) {
      assert.equal(title, merged![1], '三个键必须共用一个标签，否则老数据画出两个小标题')
    }

    // 新解析：只有合并块
    const fresh = blocksToShow(body.blocks, (k) => (k === 'inSentence' ? '新的一块' : null))
    assert.deepEqual(fresh, [{ key: 'inSentence', title: 'SENSE', lines: ['新的一块'] }])

    // 老词条：两块都在，两段正文一个字不丢，而小标题只画一次
    const old = blocksToShow(body.blocks, (k) =>
      k === 'meaning' ? '它在做什么' : k === 'barriers' ? '会绊住你的地方' : null
    )
    assert.deepEqual(old, [
      { key: 'meaning', title: 'SENSE', lines: ['它在做什么'] },
      { key: 'barriers', title: null, lines: ['会绊住你的地方'] }
    ])

    // 隔着别的块的同名（真出现的话）要重新画标题 —— 那时它们不再是一个区域
    const split = blocksToShow(
      [
        ['a', 'X'],
        ['b', 'Y'],
        ['c', 'X']
      ],
      () => 'v'
    )
    assert.deepEqual(split.map((r) => r.title), ['X', 'Y', 'X'])
  })

  it('R-5d · 数组块拆成人话，不把 JSON 打在屏幕上（2026-09-07 显示 bug）', () => {
    // 库里非字符串的块是 JSON.stringify 存的（core `plan.ts`）——
    // 原样打出去就是一屏方括号和引号，那是显示错，不是排版难看。
    assert.deepEqual(blockLines(JSON.stringify(['第一条', '第二条'])), ['第一条', '第二条'])
    assert.deepEqual(
      blockLines(JSON.stringify([
        { term: 'alleviate', note: '偏正式' },
        { term: 'ease', note: '中性', self: true }
      ])),
      ['alleviate —— 偏正式', 'ease —— 中性']
    )
    assert.deepEqual(blockLines('就是一句话'), ['就是一句话'], '普通字符串原样一行')

    assert.deepEqual(
      blockLines(JSON.stringify([
        { slot: '___ in [work]', fills: 'the film, the novel' },
        { slot: 'be ___ as', fills: 'heroic, tragic' }
      ])),
      ['___ in [work] —— the film, the novel', 'be ___ as —— heroic, tragic'],
      'slots 是提示词里定死的第三种形状（2026-09-07 主控裁：收）'
    )

    // ★ 坏 JSON / 认不出来的形状：原样露出原文，绝不抛 ——
    //   一块解析画不出来，不该炸掉整屏（D-338 的同一条道理）
    assert.deepEqual(blockLines('[{"term":"半截'), ['[{"term":"半截'])
    // 认不出来的对象形状：原样给出去，**不猜**着拼 ——
    // 猜错了屏幕上会多一句看着像解析、其实是我编的话
    const odd = JSON.stringify([{ foo: 'a', bar: 'b' }])
    assert.deepEqual(blockLines(odd), [odd], '不认识的对象形状原样给出去，不猜')
    const halfSlot = JSON.stringify([{ slot: '___', fills: 'a noun' }, { slot: '___' }])
    assert.deepEqual(blockLines(halfSlot), [halfSlot], '有一条缺字段就整块原样 —— 不半拼半漏')
    assert.deepEqual(blockLines('[]'), ['[]'], '空数组不吃掉内容')
  })

  it('R-6 · 找不到的 id 报人话，不静默', async () => {
    const f = builtDb()
    seed(f)
    await assert.rejects(() => loadItemDetail(f.db, 424242), /找不到这条知识点/)
    await assert.rejects(() => loadLecture(f.db, 424242), /找不到这个 Lecture/)
  })
})
