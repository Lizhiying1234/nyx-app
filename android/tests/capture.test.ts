/**
 * Assist 收词对照（C-1 ～ C-7 · ASSIST_CONTRACT 离线半场 + D-400 保存链）。
 * 判据链：normalizeTerm/addItem 语义 = repo.ts 逐字；落点 = D-305/306
 * （Inbox 是普通 Project，缺哪级建哪级）+ D-400②（Settings 指定优先）。钉：
 *   ① L0 直查两态 + 账本提醒（R-027）② 收下全链（items A 层 · occurrence
 *   quote=他给的原文 · empty 讲晋升 review · ops_log capture 带包名）
 *   ③ 重复收集只算跨讲（D-026/6.3）④ 包名 → Unit 名
 *   ⑤ 默认保存位置指定即落 ⑥ 指定失效回落约定位（不静默存错，回执如实）
 *   ⑦ Vault→Assist 统一收集 = ops_log 来源标记的过滤视图（不看落点）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { captureAt,
  assistCapture,
  assistStatus,
  ledgerVerdicts,
  resolveSaveTarget,
  saveTargetLabel,
  unitNameOf
} from '../src/db/capture.ts'
import { loadLibraryItems } from '../src/db/vault-lists.ts'
import { softDeleteItems } from '../src/db/manage.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

describe('C · Assist 收词', () => {
  it('C-1 · L0：认识/不认识两态；删过的账本提醒在', async () => {
    const f = builtDb()
    seed(f)
    const known = await assistStatus(f.db, '  Term-1! ')
    assert.equal(known.known, true, '归一后命中（大小写/尾标点）')
    assert.equal(known.productionState, 'new')

    const un = await assistStatus(f.db, 'serendipity')
    assert.equal(un.known, false)

    await softDeleteItems(f.db, [2])
    const v = await ledgerVerdicts(f.db, 'term-2')
    assert.deepEqual(v, ['deleted'], 'R-027 · 收下前如实说他删过它')
  })

  it('C-2 · 收下全链：Inbox 三级建齐 · occurrence · 晋升 · 流水', async () => {
    const f = builtDb()
    seed(f)
    const r = await assistCapture(f.db, 'serendipity', 'A', 'com.reddit.frontpage', 'assist', 'https://x')
    assert.equal(r.duplicateOf, null)
    assert.equal(r.pathLabel, 'Inbox › Reddit › Saved', 'D-400 · 路径三级说全（⑫ 条与气泡回执同一句）')

    const it2 = f.raw
      .prepare(`select term, gloss, layer, kind, source from items where id = ?`)
      .get(r.id) as Record<string, unknown>
    assert.deepEqual(
      { ...it2 },
      { term: 'serendipity', gloss: '', layer: 'A', kind: 'chunk', source: 'self' },
      'repo.addItem 同语义（source=self —— 他自己收的）'
    )
    const occ = f.raw
      .prepare(`select quote, material_id from occurrences where item_id = ?`)
      .get(r.id) as { quote: string; material_id: number | null }
    assert.equal(occ.quote, 'serendipity', 'M-012 · trusted fallback = 他给的原文')
    const lec = f.raw.prepare(`select status from lectures where id = ?`).get(r.lectureId) as {
      status: string
    }
    assert.equal(lec.status, 'review', 'N-1 · empty 讲收到内容晋升')
    const op = f.raw
      .prepare(`select detail from ops_log where op = 'capture' order by id desc limit 1`)
      .get() as { detail: string }
    assert.deepEqual(JSON.parse(op.detail), { pkg: 'com.reddit.frontpage', url: 'https://x', layer: 'A' })

    // 再收同一个词（还是 Inbox › Reddit 同一讲）→ 不算重复收集（6.3 同讲重贴=误操作）
    const r2 = await assistCapture(f.db, 'serendipity', 'A', 'com.reddit.frontpage', 'assist')
    assert.equal(r2.duplicateOf, r.id)
    assert.equal(
      (f.raw.prepare(`select recollected_count c from items where id = ?`).get(r.id) as { c: number }).c,
      0
    )
  })

  it('C-3 · 跨讲再收才算重复收集（D-026）', async () => {
    const f = builtDb()
    seed(f)
    // term-1 已在讲 1；从别的 App 收下同名 → 落 Inbox（别的讲）→ 原条 +1
    const r = await assistCapture(f.db, 'term-1', 'A', 'com.zhihu.android', 'assist')
    assert.equal(r.duplicateOf, 1)
    assert.equal(
      (f.raw.prepare(`select recollected_count c from items where id = 1`).get() as { c: number }).c,
      1
    )
  })

  it('C-4 · 包名 → Unit 名；拿不到包名落 Captured', async () => {
    assert.equal(unitNameOf('com.reddit.frontpage'), 'Reddit')
    assert.equal(unitNameOf('com.zhihu.android'), 'Zhihu')
    assert.equal(unitNameOf(null), 'Captured')
    const f = builtDb()
    seed(f)
    const r = await assistCapture(f.db, 'quixotic', 'B', null, 'assist')
    assert.equal(r.pathLabel, 'Inbox › Captured › Saved')
    assert.equal(
      (f.raw.prepare(`select layer from items where id = ?`).get(r.id) as { layer: string }).layer,
      'B'
    )
  })

  it('C-5 · 默认保存位置（D-400②）：Settings 指定的讲次优先于 Inbox 约定', async () => {
    const f = builtDb()
    seed(f) // 种子里有 P › U › L（lecture id=1）
    f.raw
      .prepare(`insert into settings (key,value,updated_at) values ('assist.save.lectureId','1',1)`)
      .run()
    const r = await assistCapture(f.db, 'flex', 'A', 'com.reddit.frontpage', 'assist')
    assert.equal(r.lectureId, 1, '落进指定讲次')
    assert.equal(r.pathLabel, 'P › U › L')
    assert.equal(
      f.raw.prepare(`select count(*) as n from projects where name = 'Inbox'`).get()!['n'],
      0,
      '指定了位置就不建 Inbox'
    )
    const occ = f.raw
      .prepare(`select lecture_id from occurrences where item_id = ?`)
      .get(r.id) as { lecture_id: number }
    assert.equal(occ.lecture_id, 1, '出处也挂在指定讲次上')
  })

  it('C-6 · 指定位置失效 → 回落约定位（不静默存错，回执路径如实）', async () => {
    const f = builtDb()
    seed(f)
    f.raw
      .prepare(`insert into settings (key,value,updated_at) values ('assist.save.lectureId','1',1)`)
      .run()
    f.raw.prepare(`update lectures set deleted_at = 999 where id = 1`).run() // 目标讲被软删
    const r = await assistCapture(f.db, 'flex', 'A', 'com.reddit.frontpage', 'assist')
    assert.equal(r.pathLabel, 'Inbox › Reddit › Saved', '回落 Inbox 约定位，路径说真话')
  })

  it('C-7 · Vault→Assist 统一收集（D-400③）：来源标记过滤，不看落点', async () => {
    const f = builtDb()
    seed(f) // 种子 3 条不是 Assist 收的
    f.raw
      .prepare(`insert into settings (key,value,updated_at) values ('assist.save.lectureId','1',1)`)
      .run()
    const a = await assistCapture(f.db, 'flex', 'A', 'com.reddit.frontpage', 'assist') // 落指定讲
    f.raw.prepare(`delete from settings where key = 'assist.save.lectureId'`).run()
    const b = await assistCapture(f.db, 'serendipity', 'A', 'com.reddit.frontpage', 'assist') // 落 Inbox
    const rows = await loadLibraryItems(f.db, { assistOnly: true, includeSilent: true, sort: 'recent' })
    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      [a.id, b.id].sort(),
      '两条都在收集视图里 —— 无论落进哪个 P/U/L；种子的 3 条不在'
    )
  })
})

describe('C+ · 指定讲次收词与逐日计数（第十一则指令）', () => {
  it('captureAt：收进指定讲次（添加表达的底） —— 与 assistCapture 同一份判据', async () => {
    const f = builtDb()
    seed(f)
    const lec = await f.db.get(`select id from lectures limit 1`)
    const lid = Number(lec!['id'])
    const r = await captureAt(f.db, 'bespoke-expression', 'B', lid)
    assert.equal(r.lectureId, lid, '落在指定讲次，不走默认保存位置')
    const row = await f.db.get(`select layer from items where id = ?`, [r.id])
    assert.equal(String(row!['layer']), 'B')
    const il = await f.db.get(`select lecture_id from item_lectures where item_id = ?`, [r.id])
    assert.equal(Number(il!['lecture_id']), lid)
    const oc = await f.db.get(`select quote from occurrences where item_id = ?`, [r.id])
    assert.equal(String(oc!['quote']), 'bespoke-expression', 'I-107 无句时出处=词本身')
    const card = await f.db.get(`select 1 as x from reading_cards where item_id = ?`, [r.id])
    assert.ok(card, '认读卡随建')
    const log = await f.db.get(
      `select 1 as x from ops_log where op = 'capture' and target_id = ?`,
      [r.id]
    )
    assert.ok(log, '流水在账')
  })

  it('lookupDays：近七天逐日真数据分桶（Lookup 数据区喂的就是它）', async () => {
    const f = builtDb()
    const { op, lookupDays } = await import('../src/db/ledger.ts')
    await op(f.db, 'lookup', 'term', null, 'alpha')
    await op(f.db, 'lookup', 'term', null, 'beta')
    const days = await lookupDays(f.db, 7)
    assert.equal(days.length, 7)
    assert.equal(days[6]!.looked, 2, '今天的桶=刚记的两笔')
    assert.equal(
      days.reduce((a, d) => a + d.looked, 0),
      2,
      '别的桶没被污染'
    )
  })
})

/**
 * C++ · **谁在收，决定默认落哪**（T-5.9② · D-R21 已裁 B）
 *
 * 同一条写入路径（`captureAt`，一个字没动）现在有两个入口：气泡与 Lookup。
 * 分开的只有「默认落哪」这一个维度，判据只有 `decideSaveTarget` 一份：
 *   assist → assist.save.lectureId 活着就用它，否则 Inbox › <宿主App> › Saved
 *   lookup → 自定活着就用它 → 否则跟随 Assist → 再否则 Inbox › Lookup › Saved
 *
 * ★ 这一组的**负向对照**不写成开关：把 capture.ts 里 origin 那一段判据删掉
 *   （lookup 直接走 assist 那一档）再跑，②④ 当场红 —— 会话报告里带实测结果。
 *   生产路径上不留「只给测试用的岔路」。
 */
describe('C++ · Lookup 与 Assist 各自的默认保存位置（T-5.9②）', () => {
  /** 种子只有 P › U › L(1)。再加一条 P › U2 › L2，才分得清「Lookup 自己的」与「Assist 的」 */
  function secondLecture(f: Fixture): void {
    const t = Date.now()
    f.raw
      .prepare(`insert into units (id,project_id,name,created_at,updated_at) values (2,1,'U2',?,?)`)
      .run(t, t)
    f.raw
      .prepare(
        `insert into lectures (id,unit_id,name,status,created_at,updated_at) values (2,2,'L2','review',?,?)`
      )
      .run(t, t)
  }
  const set = (f: Fixture, k: string, v: string): void => {
    f.raw.prepare(`insert into settings (key,value,updated_at) values (?,?,1)`).run(k, v)
  }

  it('① follow 是缺省 —— Lookup 一个键都没配 → 用 Assist 配的那一讲', async () => {
    const f = builtDb()
    seed(f)
    set(f, 'assist.save.lectureId', '1')
    // ★ 缺省就是跟随：不写 lookup.save.mode 也该落在 Assist 那一讲上（= 本条之前的现状）
    assert.equal(await resolveSaveTarget(f.db, 'lookup', null), 1)
    assert.equal(await saveTargetLabel(f.db, 'lookup'), 'P › U › L')
  })

  it('② custom —— Lookup 落自己那一讲，Assist 那一侧一点不受影响', async () => {
    const f = builtDb()
    seed(f)
    secondLecture(f)
    set(f, 'assist.save.lectureId', '1')
    set(f, 'lookup.save.mode', 'custom')
    set(f, 'lookup.save.lectureId', '2')

    assert.equal(await resolveSaveTarget(f.db, 'lookup', null), 2, 'Lookup 走自定的那一讲')
    assert.equal(
      await resolveSaveTarget(f.db, 'assist', 'com.reddit.frontpage'),
      1,
      '气泡仍然走 Assist 自己的默认位置 —— 两侧互不干扰'
    )
    const r = await assistCapture(f.db, 'serendipity', 'A', null, 'lookup')
    assert.equal(r.lectureId, 2)
    assert.equal(r.pathLabel, 'P › U2 › L2', '回执路径如实（D-400②）')
  })

  it('③ custom 指的那一讲被删了 → 回落跟随 Assist（不静默存错）', async () => {
    const f = builtDb()
    seed(f)
    secondLecture(f)
    set(f, 'assist.save.lectureId', '1')
    set(f, 'lookup.save.mode', 'custom')
    set(f, 'lookup.save.lectureId', '2')
    f.raw.prepare(`update lectures set deleted_at = 999 where id = 2`).run()

    const r = await assistCapture(f.db, 'serendipity', 'A', null, 'lookup')
    assert.equal(r.lectureId, 1, '失效 → 回落 follow，也就是 Assist 那一讲')
    assert.equal(r.pathLabel, 'P › U › L', '路径说的是真的落点，不是那个已经没了的')
  })

  it('④ 两边都没配 → Inbox › Lookup › Saved（Assist 那侧仍是 Inbox › 宿主App › Saved）', async () => {
    const f = builtDb()
    seed(f)
    const lk = await assistCapture(f.db, 'serendipity', 'A', null, 'lookup')
    assert.equal(lk.pathLabel, 'Inbox › Lookup › Saved', '约定位的单元名是 Lookup 自己')
    const as = await assistCapture(f.db, 'quixotic', 'A', 'com.reddit.frontpage', 'assist')
    assert.equal(as.pathLabel, 'Inbox › Reddit › Saved', 'Assist 那侧一个字没变')
    assert.notEqual(lk.lectureId, as.lectureId, '两条约定位是两个讲次，没有混进同一个')
  })

  it('⑤ Lookup 收下全链（AI 搜索与词典模式同一条路）：items +1 · ops_log capture 一条', async () => {
    const f = builtDb()
    seed(f) // 种子 3 条
    const before = Number(
      (await f.db.get(`select count(*) as n from items where deleted_at is null`))!['n']
    )
    // ★ 两种模式在 UI 上渲染的是**同一个** SaveRow、调的是同一句 assistCapture，
    //   所以这里验一次就覆盖两种模式 —— 不是「AI 那条没验」，是它们本来就是一条。
    const r = await assistCapture(f.db, 'serendipity', 'A', null, 'lookup')
    const after = Number(
      (await f.db.get(`select count(*) as n from items where deleted_at is null`))!['n']
    )
    assert.equal(after, before + 1, 'items 多一条')
    const logs = await f.db.all(
      `select target_id from ops_log where op = 'capture' and target_id = ?`,
      [r.id]
    )
    assert.equal(logs.length, 1, 'ops_log 一条 capture 流水（Vault→Assist 的统一收集看的就是它）')
    const il = await f.db.get(`select lecture_id from item_lectures where item_id = ?`, [r.id])
    assert.equal(Number(il!['lecture_id']), r.lectureId, '归属挂在回执说的那一讲上')
  })

  it('⑥ saveTargetLabel 只说不建 —— 打开设置页不该凭空长出一个讲次', async () => {
    const f = builtDb()
    seed(f)
    const n = (t: string): number =>
      Number(f.raw.prepare(`select count(*) as n from ${t}`).get()!['n'])
    const [p0, u0, l0] = [n('projects'), n('units'), n('lectures')]
    const label = await saveTargetLabel(f.db, 'lookup')
    assert.equal(label, 'Inbox › Lookup › Saved', '说的是「会去哪」，不是一句「自动」')
    assert.deepEqual(
      [n('projects'), n('units'), n('lectures')],
      [p0, u0, l0],
      '只是显示一行字，库里一个节点都不许多出来'
    )
  })
})
