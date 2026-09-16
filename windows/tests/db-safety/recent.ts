/**
 * 近几轮加的：T-2.11 知识点合并 · T-2.10 云端压实触发点 · T-2.5 还原被盖的那一版与时钟偏差 · T-7.8 解析下沉的等价用例与 item_events
 *
 * 原 tests/db-safety.ts 第 20507–21468 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { Study } from '../../src/main/study.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { hardDelete } from '../../src/core/cascade.ts'
import { wrapDb } from '../../src/main/db/async-db.ts'
import { lastSyncProblems } from '../../src/main/sync/problems.ts'
import { runUntilFixedPoint, snapshot, type ConvergenceDevice, type DbLike } from '../convergence.ts'
import { Browse } from '../../src/main/browse.ts'
import { Merge } from '../../src/main/db/merge.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, cloudFiles, cloudReady, putChunk, configureSync, syncState, newSync, fakeAi, setUpAi, twoDevices } from './fixtures.ts'

// ══ T-2.11 · 知识点合并 ══════════════════════════════════════
//
// 判据的用例在 `src/core/dedup/plan.test.ts`（纯函数）。这里验的是**落库**：
// 每张子表真的迁对了 · 被并那条真的只是软删 · 一轮同步之后另一端同形
// · 从回收站捡回来不炸 · Review 组一根手指都没碰。

console.log('\nT-2.11 · 知识点合并\n')

/**
 * 造一条重复：同一讲、同字面，可指定层与释义。返回新 item 的 id。
 *
 * ★★ `created_at` 用一个**严格递增**的计数器，不是 `Date.now()`。
 *   第一版两条同毫秒建出来，选主就落到「uid 字典序」那一档 ——
 *   而 uid 是随机的，于是 canonical 到底是哪一条**每次都可能不同**：
 *   一条用例偶尔绿、偶尔红，且红的时候看起来像业务错。
 *   这里先建的就是先创建的，选主因此确定。
 */
let dupClock = Date.now()
function dupItem(
  db: Database.Database,
  opts: { term: string; lecture: number; layer?: string; gloss?: string; recollected?: number }
): number {
  const t = ++dupClock
  const r = db
    .prepare(
      `insert into items (term,gloss,layer,kind,source,production_state,recollected_count,created_at,updated_at)
       values (?,?,?,'chunk','ai','training',?,?,?)`
    )
    .run(opts.term, opts.gloss ?? '', opts.layer ?? 'B', opts.recollected ?? 0, t, t)
  const id = Number(r.lastInsertRowid)
  db.prepare(`insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,?,?,?)`).run(
    id,
    opts.lecture,
    t,
    t
  )
  return id
}

const countOf = (db: Database.Database, sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...(args as never[])) as { n: number }).n

checkAsync('★★ T-2.11 · 逐表迁移：自然身份新建、随机身份改 FK、被并那条只是软删', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const db = r.db
  const t = Date.now()

  // 讲 1 里两条同字面、同层、canonical 有释义 / 被并那条没有 → Safe
  const keep = dupItem(db, { term: 'weather the storm', lecture: 1, gloss: '挺过难关' })
  const gone = dupItem(db, { term: 'Weather the Storm.', lecture: 1, recollected: 3 })

  // 被并那条独有的：多一个讲次归属、多一条出处、多一个分析块
  db.prepare(`insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,2,?,?)`).run(gone, t, t)
  db.prepare(`insert into occurrences (item_id,lecture_id,quote,created_at,updated_at) values (?,2,?,?,?)`).run(
    gone,
    'quote from L2',
    t,
    t
  )
  db.prepare(
    `insert into analysis_blocks (item_id,block,content,created_at,updated_at) values (?,'grammar','g',?,?)`
  ).run(gone, t, t)

  // 随机身份那五处，各放一行
  db.prepare(`insert into item_events (item_id,kind,created_at,updated_at) values (?,'x',?,?)`).run(gone, t, t)
  db.prepare(
    `insert into questions (item_id,tier,type,prompt,created_at,updated_at) values (?,1,'q','p',?,?)`
  ).run(gone, t, t)
  db.prepare(
    `insert into state_events (item_id,to_state,created_at,updated_at) values (?,'training',?,?)`
  ).run(gone, t, t)
  const child = dupItem(db, { term: 'child of gone', lecture: 1 })
  db.prepare(`update items set derived_from = ? where id = ?`).run(gone, child)

  const before = countOf(db, `select count(*) as n from items where id = ?`, gone)
  assert(before === 1, '前提：被并那条在库里')

  const out = new Merge(db).merge(1, { kind: 'safe' })
  assert(out.merged === 1, `该并掉 1 条，实际 ${out.merged}（组 ${out.groups}）`)

  // 自然身份：canonical 名下多出来，而且**旧行还在被并那条名下**
  assert(
    countOf(db, `select count(*) as n from item_lectures where item_id = ? and lecture_id = 2`, keep) === 1,
    '★ 讲 2 的归属没迁到 canonical 名下'
  )
  assert(
    countOf(db, `select count(*) as n from item_lectures where item_id = ? and lecture_id = 2`, gone) === 1,
    '★★ 自然身份的旧行被改了 FK —— uid 由 item uid 算出，改了身份就对不上'
  )
  assert(
    countOf(db, `select count(*) as n from occurrences where item_id = ? and lecture_id = 2`, keep) === 1,
    '★ 出处没在 canonical 名下新建'
  )
  assert(
    countOf(db, `select count(*) as n from analysis_blocks where item_id = ? and block = 'grammar'`, keep) === 1,
    '★ 分析块没在 canonical 名下新建'
  )

  // 随机身份：真的改了 item_id
  for (const [table, why] of [
    ['item_events', '事件'],
    ['questions', '★ 练习题还挂在回收站里那条上'],
    ['state_events', '★ 状态流水断在被并那条']
  ] as const) {
    assert(
      countOf(db, `select count(*) as n from "${table}" where item_id = ?`, keep) === 1,
      `${table} 没迁过来 —— ${why}`
    )
    assert(countOf(db, `select count(*) as n from "${table}" where item_id = ?`, gone) === 0, `${table} 还留在被并那条上`)
  }
  assert(
    countOf(db, `select count(*) as n from items where derived_from = ?`, keep) === 1,
    '★ 析出项的父没改 —— 它还指着一条躺进回收站的知识点'
  )

  // 计数相加
  assert(
    countOf(db, `select recollected_count as n from items where id = ?`, keep) === 3,
    'recollected_count 没相加'
  )

  // ★★ 软删，不是硬删
  assert(countOf(db, `select count(*) as n from items where id = ?`, gone) === 1, '★★ 被并那条被硬删了（D-435 第二档说的是软删）')
  assert(
    countOf(db, `select count(*) as n from items where id = ? and deleted_at is not null`, gone) === 1,
    '被并那条没有进回收站'
  )

  // ★★ 一个字都不许进 term_ledger —— 两条是同一个字面，记了 canonical 也再进不来
  assert(
    countOf(
      db,
      `select count(*) as n from term_ledger where norm = 'weather the storm' and verdict = 'deleted' and revoked_at is null`
    ) === 0,
    '★★ 合并往账本记了「以后别再收」—— 下次分析同一篇材料，留下的那条也进不来了，而且不报错'
  )

  // 账本上要留得下这一笔
  const op = db.prepare(`select detail from ops_log where op = 'merge'`).get() as { detail: string } | undefined
  assert(op !== undefined, '★ ops_log 里没有 merge 这一笔（D-458：给出一个数要能答是哪些）')
  const detail = JSON.parse(op.detail) as { canonical: string; merged: string; steps: unknown[] }
  assert(
    typeof detail.canonical === 'string' && typeof detail.merged === 'string' && detail.steps.length > 0,
    `merge 那一笔没写清两条 uid 与每表迁了什么：${op.detail}`
  )

  // 讲 1 的列表少一条
  assert(
    countOf(
      db,
      `select count(*) as n from items i join item_lectures il on il.item_id = i.id and il.deleted_at is null
        where il.lecture_id = 1 and i.deleted_at is null and i.term like 'weather%'`
    ) === 1,
    '讲次里应该只剩 canonical 一条'
  )
  db.close()
})

checkAsync('★★ T-2.11 · Review 组一根手指都不许碰（跨层 · 有学习史）', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const db = r.db
  const t = Date.now()

  // ① 跨层
  dupItem(db, { term: 'call it a day', lecture: 1, layer: 'A' })
  dupItem(db, { term: 'call it a day', lecture: 1, layer: 'B' })
  // ② 同层但被并那条有学习史
  const a = dupItem(db, { term: 'in the long run', lecture: 1 })
  const b = dupItem(db, { term: 'in the long run', lecture: 1 })
  db.prepare(`insert into review_logs (item_id,line,grade,created_at,updated_at) values (?,'x',3,?,?)`).run(a, t, t)
  db.prepare(`insert into review_logs (item_id,line,grade,created_at,updated_at) values (?,'x',3,?,?)`).run(b, t, t)

  const m = new Merge(db)
  const report = m.scan(1)
  assert(report.groups.length === 2, `该扫出 2 组，实际 ${report.groups.length}`)
  assert(report.safe === 0 && report.review === 2, `两组都该是 Review，实际 safe=${report.safe} review=${report.review}`)

  const out = m.merge(1, { kind: 'safe' })
  assert(
    out.merged === 0,
    `★★ 「一键处理安全的」动了需要他看的组（并掉 ${out.merged} 条）—— 跨层与有学习史的合并不可逆，而他没看见`
  )
  assert(countOf(db, `select count(*) as n from items where deleted_at is not null`) === 0, '★★ 有条目被软删了')

  // 他自己在 Review 组里挑了主记录 → 这条路要通
  const one = m.merge(1, { kind: 'one', canonicalId: a, loserIds: [b] })
  assert(one.merged === 1, '他自己挑主记录之后应当并得掉')
  assert(countOf(db, `select count(*) as n from review_logs where item_id = ?`, a) === 2, '学习史该归到主记录名下')

  // ★ 界面递来的 id 必须回判据里核 —— 两条不相干的知识点不许并
  let refused = false
  try {
    m.merge(1, { kind: 'one', canonicalId: 1, loserIds: [2] })
  } catch {
    refused = true
  }
  assert(refused, '★ 不在同一组重复里的两条被并掉了 —— 一个拼错的 id 就能毁掉一条知识点')
  db.close()
})

checkAsync('★★ T-2.11 · 合并一轮同步之后，另一端同形（软删照常同步）', async () => {
  await cloudReady
  const bucket = 't211-merge'
  const mk = (device: string): { r: ReturnType<typeof openDatabase>; sync: Sync; audio: string } => {
    const f = freshDir()
    const r = openDatabase(f.db, f.backups)
    seedTree(r)
    configureSync(r, bucket)
    r.db.prepare(`update settings set value = ? where key = 'sync.device'`).run(device)
    return { r, sync: new Sync(r.db, join(f.dir, 'audio'), f.backups), audio: join(f.dir, 'audio') }
  }
  const A = mk('devA')
  const B = mk('devB')

  // 先把两台对齐，再在 A 上造重复并合并 —— 这样 B 收到的是「合并」这件事本身
  const devs: ConvergenceDevice[] = [
    { name: 'A', sync: () => A.sync.run(), snapshot: () => snapshot('A', A.r.db as unknown as DbLike, A.audio) },
    { name: 'B', sync: () => B.sync.run(), snapshot: () => snapshot('B', B.r.db as unknown as DbLike, B.audio) }
  ]
  await runUntilFixedPoint(devs, { maxRounds: 8 })

  const keep = dupItem(A.r.db, { term: 'hold water', lecture: 1, gloss: '站得住脚' })
  const gone = dupItem(A.r.db, { term: 'hold water', lecture: 1 })
  A.r.db
    .prepare(`insert into item_events (item_id,kind,created_at,updated_at) values (?,'x',?,?)`)
    .run(gone, Date.now(), Date.now())
  const out = new Merge(A.r.db).merge(1, { kind: 'safe' })
  assert(out.merged === 1, `A 上该并掉 1 条，实际 ${out.merged}`)

  const conv = await runUntilFixedPoint(devs, { maxRounds: 8 })
  assert(conv.problems.length === 0, `★★ 合并之后两台没收敛：${conv.problems.slice(0, 5).join(' | ')}`)

  const keepUid = (A.r.db.prepare(`select uid from items where id = ?`).get(keep) as { uid: string }).uid
  const goneUid = (A.r.db.prepare(`select uid from items where id = ?`).get(gone) as { uid: string }).uid
  assert(
    countOf(B.r.db, `select count(*) as n from items where uid = ? and deleted_at is not null`, goneUid) === 1,
    '★★ 被并那条在 B 上还活着 —— 软删没同步过去，他在两台上看到不一样的讲次'
  )
  assert(
    countOf(B.r.db, `select count(*) as n from items where uid = ? and deleted_at is null`, keepUid) === 1,
    '★ 留下那条在 B 上不见了'
  )
  assert(
    countOf(
      B.r.db,
      `select count(*) as n from item_events e join items i on i.id = e.item_id where i.uid = ?`,
      keepUid
    ) === 1,
    '★ 迁过去的事件在 B 上没归到主记录名下 —— 随机身份靠 fk-map 走 uid，改 FK 就该同步'
  )
  A.r.db.close()
  B.r.db.close()
})

checkAsync('★★ T-2.11 · 从回收站把被并那条捡回来，不炸，而且还在原来那一讲', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const db = r.db
  const keep = dupItem(db, { term: 'take it for granted', lecture: 1, gloss: '想当然' })
  const gone = dupItem(db, { term: 'take it for granted', lecture: 1 })

  assert(new Merge(db).merge(1, { kind: 'safe' }).merged === 1, '前提：先并掉一条')

  const browse = new Browse(db)
  const n = browse.restore('item', gone)
  assert(n >= 1, `恢复应当至少动一行，实际 ${n}`)
  assert(
    countOf(db, `select count(*) as n from items where id = ? and deleted_at is null`, gone) === 1,
    '恢复之后它该活过来'
  )
  /**
   * ★ 合并时**不动**被并那条的 `item_lectures`（`merge.ts` 文件头 ③）——
   * 动了的话恢复出来就是一条不属于任何讲次的孤儿：他点了「恢复」，然后哪儿都找不到它。
   */
  assert(
    countOf(
      db,
      `select count(*) as n from items i join item_lectures il on il.item_id = i.id and il.deleted_at is null
        where il.lecture_id = 1 and i.id = ? and i.deleted_at is null`,
      gone
    ) === 1,
    '★★ 恢复出来的是一条不属于任何讲次的孤儿'
  )
  assert(countOf(db, `select count(*) as n from items where id = ? and deleted_at is null`, keep) === 1, 'canonical 还在')
  db.close()
})

// ══ T-7.8 · 单条解析判据下沉 core 的**等价用例** ══════════════════════
/**
 * ★★ 这一条不是新功能的用例，是**重构的安全网**。
 *
 * `ensureAnalysis` 那 148 行里塞着七八条互相咬合的判据：edited 跳过（D-149）·
 * regen_count · gloss / glossZh 回写 · 例句与本地词典合并（D-150）· 空块丢弃 ·
 * 详情页认得几块（I-112）。把它们搬进 core 的时候，**任何一条走样都不会报错**，
 * 只会让某个区块从此不再写、或者把他手改过的那一块盖掉 —— 而测试照样绿。
 *
 * 所以先在**搬之前**把「同一批假 AI 输出写出来的东西」钉成一段字面量，
 * 搬完之后逐字比对。钉的是内容 / regen_count / edited，**不钉时间戳**：
 * 那是墙钟，两次跑必然不同，钉它只会让这条用例变成噪音。
 */
const T78_AI = JSON.stringify({
  gloss: '  to take the worst part of something  ',
  glossZh: '',
  meaning: '承受最重的那一击',
  chunks: ['bear the brunt', 'of'],
  pitfalls: '   ',
  empties: [],
  emptyObj: {},
  analysis: '模型自己多包的一层 —— 详情页认不出来',
  examples: [{ text: 'AI 补的一句' }, { nope: 1 }],
  nullish: null
})

/** 只给「bear the brunt of」有例句的假词典（D-150 的合并分支要走到） */
const t78Dicts = (): unknown => ({
  examples: (word: string): { text: string; from: string }[] =>
    word === 'bear the brunt of'
      ? [{ text: 'The poor bear the brunt of inflation.', from: 'COCA' }]
      : []
})

/** 摊平成一段可以逐字比对的文本；顺序固定（item id → block 名） */
function t78Dump(db: Database.Database): string {
  const items = db
    .prepare(`select id, term, gloss, gloss_zh from items order by id`)
    .all() as { id: number; term: string; gloss: string | null; gloss_zh: string | null }[]
  const blocks = db
    .prepare(
      `select item_id, block, content, regen_count, edited from analysis_blocks
        order by item_id, block`
    )
    .all() as {
    item_id: number
    block: string
    content: string
    regen_count: number
    edited: number
  }[]
  const lines: string[] = []
  for (const i of items) {
    lines.push(`item ${i.id} ${i.term} · gloss=${i.gloss ?? '∅'} · glossZh=${i.gloss_zh ?? '∅'}`)
    for (const b of blocks.filter((x) => x.item_id === i.id)) {
      lines.push(`  ${b.block} regen=${b.regen_count} edited=${b.edited} :: ${b.content}`)
    }
  }
  return lines.join(String.fromCharCode(10))
}

/**
 * 三条知识点，把每一条分支都走一遍：
 *   1 没有任何块 + 词典有例句      → 走「词典 + AI 合并」那一支
 *   2 只有 summary（不算有解析）   → 仍在队列里；词典没有例句 → examples 走普通那一支
 *   3 有 meaning(edited=1) 与 chunks(regen_count=2) → 队列里没有它，用 force 单独跑，
 *     验的是「手改过的一个字不动」与「regen_count 累加」
 */
function t78Scene(): { r: ReturnType<typeof openDatabase>; study: Study; restore: () => void } {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = 1_700_000_000_000
  r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t, t)
  r.db
    .prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`)
    .run(t, t)
  r.db
    .prepare(
      `insert into lectures (id,unit_id,name,status,due_at,created_at,updated_at)
       values (1,1,'L','review',?,?,?)`
    )
    .run(t, t, t)
  const I = r.db.prepare(
    `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
     values (?,?,'','B','chunk','ai','training',?,?)`
  )
  const IL = r.db.prepare(
    `insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,1,?,?)`
  )
  for (const [id, term] of [
    [1, 'bear the brunt of'],
    [2, 'at the mercy of'],
    [3, 'a far cry from']
  ] as const) {
    I.run(id, term, t, t)
    IL.run(id, t, t)
  }
  const B = r.db.prepare(
    `insert into analysis_blocks (item_id,block,content,edited,regen_count,created_at,updated_at)
     values (?,?,?,?,?,?,?)`
  )
  B.run(2, 'summary', '一句话摘要', 0, 0, t, t)
  B.run(3, 'meaning', '我自己写的那一句，谁都不许动', 1, 0, t, t)
  B.run(3, 'chunks', '["旧的"]', 0, 2, t, t)

  const study = new Study(
    r.db,
    join(process.cwd(), 'prompts'),
    () => 'B2',
    t78Dicts as () => never
  )
  return { r, study, restore: () => r.db.close() }
}

/** 改之前钉下来的那一份。任何一格对不上 = 下沉的时候把判据改掉了。 */
const T78_GOLDEN = `
item 1 bear the brunt of · gloss=to take the worst part of something · glossZh=
  analysis regen=0 edited=0 :: 模型自己多包的一层 —— 详情页认不出来
  chunks regen=0 edited=0 :: ["bear the brunt","of"]
  examples regen=0 edited=0 :: [{"text":"The poor bear the brunt of inflation.","source":"dict","note":"COCA"},{"text":"AI 补的一句"}]
  meaning regen=0 edited=0 :: 承受最重的那一击
item 2 at the mercy of · gloss=to take the worst part of something · glossZh=
  analysis regen=0 edited=0 :: 模型自己多包的一层 —— 详情页认不出来
  chunks regen=0 edited=0 :: ["bear the brunt","of"]
  examples regen=0 edited=0 :: [{"text":"AI 补的一句"},{"nope":1}]
  meaning regen=0 edited=0 :: 承受最重的那一击
  summary regen=0 edited=0 :: 一句话摘要
item 3 a far cry from · gloss=to take the worst part of something · glossZh=
  analysis regen=0 edited=0 :: 模型自己多包的一层 —— 详情页认不出来
  chunks regen=3 edited=0 :: ["bear the brunt","of"]
  examples regen=0 edited=0 :: [{"text":"AI 补的一句"},{"nope":1}]
  meaning regen=0 edited=1 :: 我自己写的那一句，谁都不许动
`.trim()

checkAsync('★★ T-7.8 · 同一批假 AI 输出：下沉 core 前后写出来的解析逐字相同', async () => {
  const { r, study, restore } = t78Scene()
  const { base, restore: offAi } = fakeAi(T78_AI)
  await setUpAi(r.db, base)

  const out = await study.analyseScope(1, 'active', () => {})
  assert(out.total === 2, `队列该是 2 条（有解析块的那条不进队列），实际 ${out.total}`)
  assert(out.done === 2 && out.failed === 0, `批量结果不对：${JSON.stringify(out)}`)

  // 第 3 条不在队列里 —— 手动「重新生成」才会动它，验 edited 跳过与 regen 累加
  await study.ensureAnalysis(3, true)

  const got = t78Dump(r.db)
  if (T78_GOLDEN === '__PENDING__') {
    console.log(String.fromCharCode(10) + '── T78 实际 ──' + String(String.fromCharCode(10)) + got + String.fromCharCode(10) + '── T78 完 ──')
  }
  assert(
    got === T78_GOLDEN,
    '★★ 下沉 core 之后写出来的解析和之前不一样了：' +
      String.fromCharCode(10) +
      '── 现在 ──' +
      String.fromCharCode(10) +
      got +
      String.fromCharCode(10) +
      '── 之前 ──' +
      String.fromCharCode(10) +
      T78_GOLDEN
  )

  offAi()
  restore()
})

checkAsync('★★ T-7.8 · 写完解析记一条 item_events —— 手机写的和电脑写的分得开', async () => {
  /**
   * D-R22 之后手机也会写解析块。`analysis_blocks` 是自然身份、照常同步，
   * 但同步过来的行**说不出是谁写的**：电脑上看到一块新的 meaning，
   * 分不清是自己上次生成的还是手机刚做的。所以写解析时记一笔来源。
   *
   * ★ 这张表会同步到他的云端桶和手机上 —— 所以 detail 里
   *   **不许出现 baseUrl，更不许出现 key**（D-220）。这条用例守的就是这一点。
   */
  const { r, study, restore } = t78Scene()
  const { base, restore: offAi } = fakeAi(T78_AI)
  await setUpAi(r.db, base)

  await study.ensureAnalysis(1, false)
  await study.ensureAnalysis(1, true) // 第二次是「重新生成」

  const evs = r.db
    .prepare(`select kind, detail from item_events where item_id = 1 order by id`)
    .all() as { kind: string; detail: string }[]
  assert(evs.length === 2, `该记两条（一次生成、一次重新生成），实际 ${evs.length}`)
  assert(
    evs.every((e) => e.kind === 'analyzed'),
    `kind 不对：${evs.map((e) => e.kind).join('/')}`
  )

  const d0 = JSON.parse(evs[0]!.detail) as Record<string, unknown>
  const d1 = JSON.parse(evs[1]!.detail) as Record<string, unknown>
  assert(d0.origin === 'windows', `origin 不对：${String(d0.origin)}`)
  assert(d0.slot === 'light', `槽位不对：${String(d0.slot)}`)
  assert(d0.model === 'test-model', `model 不对：${String(d0.model)}`)
  assert(d0.regen === false, '第一次不该算「重新生成」')
  assert(d1.regen === true, '★ 他亲手点的那次要记成「重新生成」')

  for (const e of evs) {
    assert(!e.detail.includes('test-key'), '★★ API key 漏进了会同步出去的表（D-220）')
    assert(!e.detail.includes('http'), '★★ baseUrl 漏进了会同步出去的表')
  }

  offAi()
  restore()
})

// ══════════════════════════════════════════════════════════════
// T-2.10 · 云端压实的触发点（D-R18 已裁：方案 D）
//
// 「该不该压」那份判据在 `core/sync/compact-trigger.ts`，它自己有一套纯用例。
// 这里验的是**接线** —— 判据用例够不着的正好是这一半：
//
//   · 彻底删除立了碑 → **下一趟同步末尾压一次，而且只压一次**
//   · 桶里包数到线也会压
//   · 上限拒的时候，云端**一个字都没动**
//   · 压实失败**不改变这一趟同步的结果**，问题落进 `sync.problems` 那条通道
//   · 成了在账本上留一行 `compact`，给出的每个数都能答「是哪些」（D-458）
//
// ★ 这几条用的假云**支持 DELETE**（见上面那个 handler）；桶名带 `nodel` 的
//   故意不给删，「压实失败」那条要的就是那个形状。
// ══════════════════════════════════════════════════════════════

console.log('\nT-2.10 · 云端压实的触发点\n')

/** settings 里那一个数 —— 读不到当 0 */
function settingNum(db: Database.Database, key: string): number {
  const row = db.prepare(`select value from settings where key = ?`).get(key) as
    | { value?: string }
    | undefined
  return Number(row?.value ?? 0) || 0
}

/** 这个桶里现在有哪几个变更包 */
function chunkNames(bucket: string): string[] {
  const head = `${bucket}/nyx/chunks/`
  return [...cloudFiles.keys()]
    .filter((k) => k.startsWith(head))
    .map((k) => k.slice(head.length))
    .sort()
}

/** ★ T-2.5 顺带补上 `id` 与 `target` —— 还原那几条要按 id 点某一笔 */
function opsOf(
  db: Database.Database,
  op: string
): { id: number; target: string; title: string; detail: string }[] {
  return db
    .prepare(`select id, target, title, detail from ops_log where op = ? order by id`)
    .all(op) as { id: number; target: string; title: string; detail: string }[]
}

checkAsync('★★ T-2.10 · 立碑 → 下一趟同步末尾压实**一次且只一次**，账本留一行', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 't210-once')
  const sync = newSync(r, backups)

  // ① 先正常同步一趟 —— 桶里有了第一个包
  await sync.run()
  /** ★ 负向对照（在套里的那一半）：没立过碑、包数也没到线 → **不压** */
  const idle = await sync.compactIfNeeded()
  assert(idle.ran === false, `★★ 没有任何理由却压了：${idle.why}`)
  assert(chunkNames('t210-once').length === 1, `前提：桶里该有 1 个包，实际 ${chunkNames('t210-once').length}`)

  // ② 彻底删掉一个项目 —— 走唯一的硬删入口，标记就是在那里记的
  await hardDelete(wrapDb(r.db), 'projects', [1])
  assert(
    settingNum(r.db, 'sync.compactPending') > 0,
    '★★ 彻底删除之后没有记下待压实标记 —— 云端那份存量永远不会被清'
  )

  // ③ 下一趟同步：推走墓碑，末尾压一次
  const out = await sync.run()
  const first = await sync.compactIfNeeded()
  assert(first.ran === true, `★★ 立过碑却没压：${first.why}`)
  assert(first.result?.ok === true, `★★ 压实没做成：${first.result?.why}`)
  assert(first.result!.folded >= 2, `该折掉至少两个包，实际 ${first.result!.folded}`)
  assert(
    chunkNames('t210-once').length === 1,
    `★ 压完之后桶里该只剩快照，实际 ${chunkNames('t210-once').join('、')}`
  )
  assert(out.applied >= 0, '同步结果照常返回')

  // ④ 标记清掉了、包数远没到线 → **不再压**
  await sync.run()
  const second = await sync.compactIfNeeded()
  assert(second.ran === false, `★★ 压了第二次（标记没清干净）：${second.why}`)
  assert(settingNum(r.db, 'sync.compactPending') === 0, '★ 标记该在尝试之后就清掉')
  assert(settingNum(r.db, 'sync.compactTriedAt') > 0, '★ 尝试过的时刻要记下来（阈值那条路的冷却靠它）')

  // ⑤ 账本上正好一行，而且给出的数能答「是哪些」（D-458）
  const rows = opsOf(r.db, 'compact')
  assert(rows.length === 1, `★★ 账本上该正好一行 compact，实际 ${rows.length} 行`)
  const detail = JSON.parse(rows[0]!.detail) as {
    snapshot: string
    folded: string[]
    deleted: number
    rows: number
  }
  assert(
    Array.isArray(detail.folded) && detail.folded.length === first.result!.folded,
    `★★ D-458 ·「折了 ${first.result!.folded} 个包」答不出是哪些：${rows[0]!.detail}`
  )
  assert(detail.snapshot === first.result!.snapshot, '账本里的快照名要对得上')
  assert(rows[0]!.title.includes('折了'), `账本标题要是人话，实际「${rows[0]!.title}」`)

  r.db.close()
})

checkAsync('★ T-2.10 · 桶里包数到线也会压（没立过碑）', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 't210-many')
  const sync = newSync(r, backups)

  /** 105 个包 —— 比 `COMPACT_PACK_LIMIT`（100）多几个。内容为空，验的是**包数**这条线 */
  for (let i = 0; i < 105; i++) putChunk('t210-many', `other-${200000 + i}.json`, [])

  await sync.run()
  assert(settingNum(r.db, 'sync.compactPending') === 0, '前提：这条路上没有立过碑')

  const v = await sync.compactIfNeeded()
  assert(v.ran === true, `★★ 桶里 105 个包却没压：${v.why}`)
  assert(v.why.includes('100'), `★ 说不清是哪条线触发的：${v.why}`)
  assert(v.result?.ok === true, `★ 压实没做成：${v.result?.why}`)
  assert(
    chunkNames('t210-many').length === 1,
    `★ 105 个包该折成一个快照，实际还剩 ${chunkNames('t210-many').length} 个`
  )

  r.db.close()
})

checkAsync('★★ T-2.10 · 桶超过上限 → 拒，而且云端一个字都没动', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 't210-limit')
  const sync = newSync(r, backups)

  await sync.run()
  // 再改一点东西，凑够两个包（只剩一份时压实本来就会拒，那验不到上限）
  r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (9,'P9',?,?)`).run(Date.now(), Date.now())
  await sync.run()
  const before = chunkNames('t210-limit')
  assert(before.length === 2, `前提：该有两个包，实际 ${before.join('、')}`)

  /** ★ 上限可注入是有意的 —— 造一个 24 MB 的桶不是一条跑得起来的用例 */
  const out = await sync.compact(Date.now(), { maxRows: 1, maxChars: 1e9 })
  assert(out.ok === false, '★★ 超上限了还是压了')
  assert(out.why!.includes('行'), `★ 拒的理由要说清是哪条上限：${out.why}`)
  assert(out.snapshot === undefined, '★★ 拒的时候不许写快照')
  assert(out.deleted === 0, '★★ 拒的时候不许删任何老包')
  assert(
    chunkNames('t210-limit').join('、') === before.join('、'),
    `★★★ 拒的时候桶被动过了：${before.join('、')} → ${chunkNames('t210-limit').join('、')}`
  )

  r.db.close()
})

checkAsync('★★ T-2.10 · 压实失败不改变同步的结果，问题落进 sync.problems', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  // ★ 桶名带 nodel = 这把凭据能写不能删（假云 403）
  configureSync(r, 't210-nodel')
  const sync = newSync(r, backups)

  await sync.run()
  await hardDelete(wrapDb(r.db), 'projects', [1])
  const out = await sync.run()
  const wmAfterRun = syncState(r.db).wm
  const noteAfterRun = syncState(r.db).note
  const chunksAfterRun = chunkNames('t210-nodel')

  const v = await sync.compactIfNeeded()
  assert(v.ran === true, `★ 立过碑就该试一次：${v.why}`)
  assert(v.result?.ok === false, '★★ 这把凭据删不掉东西，压实必须拒')

  // ① 同步的结果一个字都没变
  assert(syncState(r.db).wm === wmAfterRun, '★★★ 压实动了同步水位')
  assert(syncState(r.db).note === noteAfterRun, '★★★ 压实改写了这一趟同步的那句话')
  assert(out.failed === 0 && out.conflicted === 0, '前提：这一趟同步本身是干净的')
  assert(
    chunkNames('t210-nodel').join('、') === chunksAfterRun.join('、'),
    '★★★ 压实拒了却动了桶'
  )
  const st = await sync.status()
  assert(st.failStreak === 0, '★★ 压实失败不许算成「同步连败」（D-373）')

  // ② 但绝不许悄无声息 —— 落进他看得见的那条通道
  const problems = lastSyncProblems(r.db)?.problems ?? []
  assert(
    problems.some((x) => x.what === '云端压实'),
    `★★ 压实失败没有留痕：${JSON.stringify(problems)}`
  )

  // ③ 没做成就不进账本（账本记的是「做过什么」）
  assert(opsOf(r.db, 'compact').length === 0, '★ 没压成却在账本上记了一行')

  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// T-2.5 · 被盖掉的那一版还原得回来 · 时钟偏差进同步结果那一行
//         （D-438 / D-R4 使用者 2026-09-05 裁「要」）
//
// 判据在 `core/sync/restore.ts`（自带一套纯用例）。这里验的是**接线与真链路**：
//   · 两台各改同一行 → D-438 自动定 + 落账 → 在被盖的那台还原 →
//     再同步一轮，另一端也回到旧值，两边账本各多一行 `sync-restore`
//   · ★★★ `lost` 的**两种形状**都要还原得回去（见 restore.ts 文件头）：
//     `kept='remote'` 是本地形；`kept='local'` 是同步形（外键是 `*_uid`），
//     必须先过 `fk-map.ts::toLocal`
//   · 还原之后对方又改 → 再次 D-438，旧的那版又进账本
//   · 行被彻底删除之后不许还原（绝不复活）
//   · 时钟偏差那句话进 `lastNote`
// ══════════════════════════════════════════════════════════════

console.log('\nT-2.5 · 还原被盖掉的那一版 · 时钟偏差提示\n')

/** `twoDevices` 里的 `configureSync` 默认把自动裁决关了；这一组要的正是开着那条路 */
function autoResolveOn(...rs: ReturnType<typeof openDatabase>[]): void {
  for (const r of rs) {
    r.db.prepare(`update settings set value = '1' where key = 'sync.autoResolve'`).run()
  }
}

const lectureNameOf = (db: Database.Database, uid: string): string | undefined =>
  (db.prepare(`select name from lectures where uid = ?`).get(uid) as { name: string } | undefined)?.name

const lectureStampOf = (db: Database.Database, uid: string): number =>
  Number(
    (db.prepare(`select updated_at as t from lectures where uid = ?`).get(uid) as { t: number }).t
  )

interface Scene {
  A: ReturnType<typeof openDatabase>
  B: ReturnType<typeof openDatabase>
  syncA: Sync
  syncB: Sync
  uid: string
  t: number
}

/**
 * 造一次**真的 D-438 覆盖**。两个方向要**两种推送顺序**，这不是凑数：
 *
 * ★★ 推成功之后，没被争的那些行会 `markAgreed(自己这一版)`（`engine.ts` 推包那一段）——
 *   也就是说**一推完，本地这一版就成了共同基**，下一趟再收到别人的新版就只是
 *   「对面改了、我没改」→ `take-remote`，**根本不算冲突**。
 *   所以「谁先推」决定了冲突落在哪一台：先推的那台没有冲突，后推的那台才有。
 *   第一版这两个场景共用一个顺序，B 上一笔 override 都没有 —— 就是被这条咬的。
 */
async function sceneBase(bucket: string): Promise<Scene & { edit: (r: Scene['A'], name: string, at: number) => void }> {
  const { A, B, syncA, syncB } = await twoDevices(bucket)
  autoResolveOn(A, B)
  const uid = (A.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid
  const t = Date.now()
  const edit = (r: Scene['A'], name: string, at: number): void => {
    r.db.prepare(`update lectures set name = ?, updated_at = ? where uid = ?`).run(name, at, uid)
  }
  return { A, B, syncA, syncB, uid, t, edit }
}

/** 被盖的是 **B 自己**那版 → B 上 `kept='remote'`，`lost` 是**本地形** */
async function overrideOnB(bucket: string): Promise<Scene> {
  const s = await sceneBase(bucket)
  s.edit(s.B, '乙改的', s.t + 1000) // 旧的那版，先不推
  s.edit(s.A, '甲改的', s.t + 2000)
  await s.syncA.run() // A 先推 —— A 从此没有未推的改动
  await s.syncB.run() // B 带着未推的改动收到更新的那版 → 冲突 → 取云端
  return s
}

/** 被盖的是**对面**那版 → A 上 `kept='local'`，`lost` 是**同步形**（`unit_uid`） */
async function overrideOnA(bucket: string): Promise<Scene> {
  const s = await sceneBase(bucket)
  s.edit(s.B, '乙改的', s.t + 1000)
  s.edit(s.A, '甲改的', s.t + 2000)
  await s.syncB.run() // B 先推它那版（旧）
  await s.syncA.run() // A 带着更新的改动收到旧那版 → 冲突 → 留本地
  return s
}

checkAsync('★★★ T-2.5 · 被盖的那台点还原 → 自己回到旧值，再同步一轮另一台也回去', async () => {
  await cloudReady
  const { A, B, syncA, syncB, uid, t } = await overrideOnB('t25-main')

  // 前提：B 那版被盖了，账本上有一笔
  assert(lectureNameOf(B.db, uid) === '甲改的', `前提没成立：B 上现在是 ${lectureNameOf(B.db, uid)}`)
  const rows = opsOf(B.db, 'sync-override')
  assert(rows.length === 1, `B 上该正好一笔 sync-override，实际 ${rows.length}`)
  assert(
    (JSON.parse(rows[0]!.detail) as { kept: string }).kept === 'remote',
    '前提：B 上被盖的是本地那版'
  )

  // ① 还原
  const out = await syncB.restoreOverride(rows[0]!.id)
  assert(out.ok === true, `★★ 还原失败了：${out.ok ? '' : out.why}`)
  assert(lectureNameOf(B.db, uid) === '乙改的', `★★ 还原之后 B 上该是旧值，实际 ${lectureNameOf(B.db, uid)}`)
  /**
   * ★★★ 顶上去的那个时间戳必须**比盖住它的那一版新**（这里 A 那版是 t+2000，
   * 而真实时钟这会儿还没走到 t+2000 —— 光取 `now` 会输）。
   * 对面钟快时这就是真实形状：还原写回去、同步出去、当场又被盖回来。
   */
  const keptAt = (JSON.parse(rows[0]!.detail) as { keptAt: number }).keptAt
  assert(keptAt === t + 2000, `前提：盖住它的是 A 那版（${keptAt}）`)
  assert(
    lectureStampOf(B.db, uid) > keptAt,
    `★★★ 还原顶的时间戳（${lectureStampOf(B.db, uid)}）没有超过盖住它的那一版（${keptAt}）—— 同步出去会当场又被盖回来`
  )
  assert(opsOf(B.db, 'sync-restore').length === 1, '★ 账本上要留一笔 sync-restore')
  const back = JSON.parse(opsOf(B.db, 'sync-restore')[0]!.detail) as { from: number; columns: string[] }
  assert(back.from === rows[0]!.id, '★ 那一笔要指回被还原的那一行')
  assert(back.columns.includes('name') && back.columns.includes('updated_at'), `★ D-458 · 写了哪几列要记下来：${JSON.stringify(back.columns)}`)

  // ② 再点一次 —— 说「已经还原过」，不再写一遍
  const again = await syncB.restoreOverride(rows[0]!.id)
  assert(again.ok === false && again.why.includes('已经还原过'), `★★ 再点一次该被挡住：${JSON.stringify(again)}`)
  assert(opsOf(B.db, 'sync-restore').length === 1, '★ 被挡住就不该再记一笔')

  // ③ 同步一轮 —— 另一台也回到旧值，账本那一笔也过去了（ops_log 本来就是同步表）
  await syncB.run()
  await syncA.run()
  assert(lectureNameOf(A.db, uid) === '乙改的', `★★★ 还原没有传到另一台：A 上是 ${lectureNameOf(A.db, uid)}`)
  assert(
    opsOf(A.db, 'sync-restore').length === 1,
    '★ 两边账本各该有一笔 sync-restore（ops_log 是同步表，不用特殊照顾）'
  )

  A.db.close()
  B.db.close()
})

checkAsync('★★★ T-2.5 · kept=local 那一半是**同步形**（外键是 uid）—— 也要还原得回去', async () => {
  await cloudReady
  const { A, B, syncA, uid } = await overrideOnA('t25-shape')

  const rows = opsOf(A.db, 'sync-override')
  assert(rows.length === 1, `A 上该正好一笔，实际 ${rows.length}`)
  const d = JSON.parse(rows[0]!.detail) as { kept: string; lost: Record<string, unknown> }
  assert(d.kept === 'local', '前提：A 上被盖的是对面那版')
  /**
   * ★★★ 这就是那个非做不可的发现：同一个字段里躺着两种形状。
   * 这一条要是红了，说明 `autoResolve` 里 `lost` 的来源变了 ——
   * 那 `restore.ts` 的形状判定要跟着改。
   */
  assert(
    'unit_uid' in d.lost && !('id' in d.lost),
    `★★★ kept='local' 那一半该是同步形（有 unit_uid、没有 id），实际：${JSON.stringify(Object.keys(d.lost))}`
  )

  const out = await syncA.restoreOverride(rows[0]!.id)
  assert(out.ok === true, `★★ 同步形没还原成：${out.ok ? '' : out.why}`)
  assert(lectureNameOf(A.db, uid) === '乙改的', `★★ A 上该变成对面那版，实际 ${lectureNameOf(A.db, uid)}`)
  const unit = A.db.prepare(`select unit_id from lectures where uid = ?`).get(uid) as { unit_id: number }
  assert(
    Number(unit.unit_id) === 1,
    `★★★ 外键必须翻回本地 id，写进去的是 ${JSON.stringify(unit.unit_id)} —— 写 uid 进去等于把这一行挂到不存在的单元上`
  )

  A.db.close()
  B.db.close()
})

checkAsync('★★ T-2.5 · 还原之后对方又改 → 再次 D-438，旧的那版又进账本', async () => {
  await cloudReady
  const { A, B, syncA, syncB, uid } = await overrideOnB('t25-again')

  const first = opsOf(B.db, 'sync-override')[0]!
  assert((await syncB.restoreOverride(first.id)).ok === true, '前提：第一次还原要成功')
  await syncB.run()
  await syncA.run()
  assert(lectureNameOf(A.db, uid) === '乙改的', '前提：还原已经传到 A')

  /**
   * 两边各自再改一次。基准取**还原写下的那个时间戳**（它是 `Date.now()`，
   * 比场景开头的 `t` 晚）—— 拿 `t + 几秒` 去比会跟真实时钟赛跑，那是偶发的来源。
   * ★ 顺序照旧：A 先推，B 后收 —— 冲突才落在 B 上（见 `sceneBase` 头上那段）。
   */
  const r0 = lectureStampOf(B.db, uid)
  B.db.prepare(`update lectures set name = '乙又改的', updated_at = ? where uid = ?`).run(r0 + 1000, uid)
  A.db.prepare(`update lectures set name = '甲又改的', updated_at = ? where uid = ?`).run(r0 + 2000, uid)
  await syncA.run()
  await syncB.run()

  const rows = opsOf(B.db, 'sync-override')
  assert(rows.length === 2, `★★ 又被盖了一次就该再记一笔，实际 ${rows.length} 笔`)
  const latest = rows[1]!
  assert(
    (JSON.parse(latest.detail) as { lost: { name?: string } }).lost.name === '乙又改的',
    `★★ 新那一笔里该是刚被盖掉的那版：${latest.detail.slice(0, 200)}`
  )
  // 旧那一笔仍然「已经还原过」，新那一笔还原得动
  const old = await syncB.restoreOverride(first.id)
  assert(old.ok === false && old.why.includes('已经还原过'), `★ 旧那笔该仍被挡住：${JSON.stringify(old)}`)
  const fresh = await syncB.restoreOverride(latest.id)
  assert(fresh.ok === true, `★★ 新那笔该还原得动：${fresh.ok ? '' : fresh.why}`)
  assert(lectureNameOf(B.db, uid) === '乙又改的', `★ 还原之后该是 乙又改的，实际 ${lectureNameOf(B.db, uid)}`)

  A.db.close()
  B.db.close()
})

checkAsync('★★ T-2.5 · 行已经被彻底删除 → 拒绝还原（绝不复活）', async () => {
  await cloudReady
  const { A, B, syncB, uid } = await overrideOnB('t25-purged')

  const row = opsOf(B.db, 'sync-override')[0]!
  const id = (B.db.prepare(`select id from lectures where uid = ?`).get(uid) as { id: number }).id
  await hardDelete(wrapDb(B.db), 'lectures', [id])

  const out = await syncB.restoreOverride(row.id)
  assert(out.ok === false, '★★★ 立过碑的东西不许靠还原复活')
  assert(!out.ok && out.why.includes('不在库里'), `★ 要说人话：${out.ok ? '' : out.why}`)
  assert(opsOf(B.db, 'sync-restore').length === 0, '★ 拒了就不该记账')
  const n = (B.db.prepare(`select count(*) as n from lectures where uid = ?`).get(uid) as { n: number }).n
  assert(n === 0, '★★★ 那一行不许被还原重新建出来')

  A.db.close()
  B.db.close()
})

checkAsync('★★ T-2.5 · 时钟偏差那句话进同步结果这一行（不只落进问题清单）', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 't25-skew')
  const sync = newSync(r, backups)

  /** 对面那台的钟快了三个小时 —— 包里的行带着未来的时间戳 */
  const future = Date.now() + 3 * 3600_000
  putChunk('t25-skew', 'other-100.json', [
    {
      uid: 'remote-project-skew',
      table: 'projects',
      updatedAt: future,
      data: {
        id: 88, name: '未来的项目', color: '#666', sort: 0, pinned: 0, silent: 0,
        deleted_at: null, created_at: future, updated_at: future, uid: 'remote-project-skew'
      }
    }
  ])

  const out = await sync.run()
  assert(
    out.lastNote.includes('比本机快'),
    `★★ 时钟偏差那句话没进同步结果这一行 —— 他每次都会看的就是它：\n${out.lastNote}`
  )
  // ★ 原来落 problems 的那条照旧，两处都要
  assert(
    (out.problems ?? []).some((x) => x.what === '设备时钟'),
    `★ problems 那一条不许因此丢掉：${JSON.stringify(out.problems ?? [])}`
  )

  r.db.close()
})

// ══ T-4.10 · 知识库行的「还没分析」状态（D-R24 ✅ A · 2026-09-06）══════
/**
 * 使用者点名的六类各一条。判据在 `core/library-state.ts`（那边有纯函数用例），
 * 这里验的是**真走主进程落库、读回来**之后 `LibraryItem.state` 是不是那个值 ——
 * 判据对不对是一件事，SQL 有没有把原料查出来是另一件事，后者只有这一档抓得住。
 *
 * ★★ 这一组同时钉住一个存在已久的 bug：`libraryItems` 的 SELECT 里
 *    **一直没有 `hasSuspect` 这一列**，而收尾写着 `x.hasSuspect !== 0` ——
 *    `undefined !== 0` 恒为 true，于是综合知识库**每一行**都在画修正记号。
 *    使用者 2026-09-06 报的「几乎每个知识点旁边都有一个标记」，208 / 208 对得上的就是它。
 */
function t410Scene(): { r: ReturnType<typeof openDatabase>; study: Study; add: (term: string, gloss: string) => number } {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = 1_700_000_000_000
  r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t, t)
  r.db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`).run(t, t)
  r.db
    .prepare(
      `insert into lectures (id,unit_id,name,status,due_at,created_at,updated_at)
       values (1,1,'L','review',?,?,?)`
    )
    .run(t, t, t)
  let next = 1
  const I = r.db.prepare(
    `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
     values (?,?,?,'A','chunk','self','new',?,?)`
  )
  const IL = r.db.prepare(
    `insert into item_lectures (item_id,lecture_id,is_owner,created_at,updated_at) values (?,1,1,?,?)`
  )
  const add = (term: string, gloss: string): number => {
    const id = next++
    I.run(id, term, gloss, t, t)
    IL.run(id, t, t)
    return id
  }
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  return { r, study, add }
}

/** 往一条知识点上挂一块解析 */
function t410Block(
  r: ReturnType<typeof openDatabase>,
  itemId: number,
  block: string,
  edited = 0
): void {
  const t = 1_700_000_000_000
  r.db
    .prepare(
      `insert into analysis_blocks (item_id,block,content,edited,regen_count,created_at,updated_at)
       values (?,?,'…',?,0,?,?)`
    )
    .run(itemId, block, edited, t, t)
}

check('★★ T-4.10 · 六类各一条：LibraryItem.state 与修正记号都要对', () => {
  const { r, study, add } = t410Scene()

  const glossed = add('bear the brunt of', '承受最重的一击') // ① 正常：有释义
  t410Block(r, glossed, 'meaning')
  const suspect = add('tangle up', '') // ② 真有问题：有 suspect 块
  t410Block(r, suspect, 'suspect')
  const noBlocks = add('at the mercy of', '') // ③ 没有检测结果：一块解析都没有
  const fresh = add('a far cry from', '') // ④ 新建（刚采集）
  const analysed = add('hold water', '站得住脚') // ⑤ 已分析
  t410Block(r, analysed, 'meaning')
  t410Block(r, analysed, 'chunks')
  const edited = add('call it a day', '') // ⑥ 已编辑：手改过的块
  t410Block(r, edited, 'meaning', 1)

  const rows = study.libraryItems({})
  const by = (id: number): { state: string; hasSuspect?: boolean; term: string } => {
    const x = rows.find((v) => v.id === id)
    assert(x !== undefined, `列表里没有 id=${id} 这一条`)
    return x as unknown as { state: string; hasSuspect?: boolean; term: string }
  }

  assert(by(glossed).state === 'glossed', `① 有释义该是 glossed，实际 ${by(glossed).state}`)
  assert(by(suspect).state === 'analysed', `② suspect 也是解析块 → analysed，实际 ${by(suspect).state}`)
  assert(by(noBlocks).state === 'unanalysed', `③ 无解析该是 unanalysed，实际 ${by(noBlocks).state}`)
  assert(by(fresh).state === 'unanalysed', `④ 刚采集该是 unanalysed，实际 ${by(fresh).state}`)
  assert(by(analysed).state === 'glossed', `⑤ 已分析且有释义该是 glossed，实际 ${by(analysed).state}`)
  assert(by(edited).state === 'analysed', `⑥ 手改过一定算分析过，实际 ${by(edited).state}`)

  /**
   * ★★ 修正记号只能出现在真有 suspect 块的那一条上。
   *    这条断言就是那个 bug 的负向对照 —— 把 SELECT 里的 hasSuspect 那一句拿掉，
   *    六条会全部变成 true，这里当场红。
   */
  const marked = rows.filter((x) => x.hasSuspect === true).map((x) => x.term)
  assert(
    marked.length === 1 && marked[0] === 'tangle up',
    `★★ 修正记号应当只在有 suspect 块的那一条上，实际出现在 ${marked.length} 条：${marked.join(' · ')}`
  )

  // 表头「n 条还没分析」数的就是这个
  const unan = rows.filter((x) => x.state === 'unanalysed').length
  assert(unan === 2, `该有 2 条还没分析（无解析 + 刚采集），实际 ${unan}`)

  r.db.close()
})

check('★★ 2026-09-06 · 布尔列必须真的是布尔 —— 列没查出来不许当成 true', () => {
  /**
   * 守的不是 `hasSuspect` 这一个名字，是**「列没查出来会把判断倒过来」这件事本身**。
   *
   * 那天的病：`hasSuspect: x.hasSuspect !== 0`，而 SELECT 里根本没有那一列 ——
   * `undefined !== 0` 恒为 true，于是知识库每一行都画上了修正记号
   * （真库副本实测：该出 0 条、实际 208 条），而编译、单测、运行**全都不报错**。
   *
   * 现在映射走 `boolCol()`：拿不到那一列就当场抛。这条用例把「出来的必须是布尔」
   * 钉住 —— 下一次换成别的列漏查，同样接得住。
   */
  const { r, study, add } = t410Scene()
  add('bear the brunt of', '承受最重的一击')
  add('at the mercy of', '')
  const rows = study.libraryItems({})
  assert(rows.length === 2, `前提：列表里该有 2 条，实际 ${rows.length}`)
  for (const x of rows) {
    assert(
      typeof x.hasSuspect === 'boolean',
      `★★ hasSuspect 该是布尔，实际 ${typeof x.hasSuspect}（${String(x.hasSuspect)}）—— ` +
        `多半是 SELECT 又漏了那一列，而 undefined !== 0 恒为 true`
    )
    assert(
      typeof x.cardSilent === 'boolean',
      `★★ cardSilent 该是布尔，实际 ${typeof x.cardSilent}（${String(x.cardSilent)}）`
    )
  }
  r.db.close()
})

check('★ T-4.10 · 析出成分仍然压过释义，且不算「还没分析」', () => {
  const { r, study, add } = t410Scene()
  const parent = add('the whole nine yards', '')
  const t = 1_700_000_000_000
  r.db
    .prepare(
      `insert into items (id,term,gloss,layer,kind,source,production_state,derived_from,created_at,updated_at)
       values (99,'nine yards','','A','word','self','new',?,?,?)`
    )
    .run(parent, t, t)

  const row = study.libraryItems({}).find((x) => x.id === parent)
  assert(row !== undefined, '列表里找不到那一条')
  assert(row.derivedCount === 1, `析出数该是 1，实际 ${row.derivedCount}`)
  assert(
    (row as unknown as { state: string }).state === 'derived',
    `有析出成分该是 derived，实际 ${(row as unknown as { state: string }).state}`
  )
  r.db.close()
})
