/**
 * F-2-②-a 挂进轮转中那一讲的新条目，立刻拿到认读卡
 *
 * 原 tests/db-safety.ts 第 10611–10923 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { Study } from '../../src/main/study.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, snapshotAll, cardDues, cloudReady, putChunk, configureSync, startedLecture } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ F-2-②-a · 挂进轮转中那一讲的新条目，立刻拿到认读卡
//
// `card_due_at` 的初始化以前只有 `startLearning` 一个入口，而那颗按钮
// 只在 `review` 时渲染 —— 已经在 training 的讲不会再进那道门。
// 实测三条路径全中：我的收集、手动加、同步导入，都是「新条目 1 条 · 认读卡 0 条」。
// 表现是静默失效：那几条好好地列在界面上，就是永远轮不到。
// ══════════════════════════════════════════════════════════════

console.log('\nF-2-②-a · 新条目的认读入口\n')

/** 造一条**已经在轮转**的讲（走真入口） */

/** 这一讲的排期 / 间隔 / 老条目的卡，一个字都不许动 */
function assertUntouched(
  r: ReturnType<typeof openDatabase>,
  before: { due: number; iv: number },
  who: string
): void {
  const l = r.db.prepare(`select due_at as d, interval_days as iv from lectures where id = 1`).get() as {
    d: number
    iv: number
  }
  assert(l.d === before.due, `★★ ${who} 改了这一讲的排期：${before.due} → ${l.d}`)
  assert(l.iv === before.iv, `★★ ${who} 改了这一讲的间隔：${before.iv} → ${l.iv}`)
}

const cardOf = (db: Database.Database, id: number): number | null =>
  (db.prepare(`select due_at as c from reading_cards where item_id = ?`).get(id) as { c: number | null }).c

check('★★ F-2-②-a · ① 我的收集：新条目立刻拿到认读卡', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const before = startedLecture(r)

  const added = new Repo(r.db).addChunks(1, '又贴一段', 'brand new phrase').added
  assert(added.length === 1, `前提没成立：该加进 1 条，实际 ${added.length}`)

  const c = cardOf(r.db, added[0]!.id)
  assert(c !== null, '★★ 新条目没拿到认读卡 —— 它会好好地列在界面上，但永远轮不到')
  const created = (
    r.db.prepare(`select created_at as t from item_lectures where item_id = ?`).get(added[0]!.id) as {
      t: number
    }
  ).t
  assert(c === created, `★ 认读时间该跟着这条关系的产生时间：${created} vs ${c}`)
  assertUntouched(r, before, '触发器')
  assert(cardDues(r.db, 1) !== before.cards, '前提：卡片集合本该多一条')
  r.db.close()
})

check('★★ F-2-②-a · ② 手动加一条：同样立刻拿到', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const before = startedLecture(r)

  const id = new Repo(r.db).addItem(1, 'another new phrase', '', 'B', '').id
  assert(cardOf(r.db, id) !== null, '★★ 手动加的那条没拿到认读卡')
  assertUntouched(r, before, '触发器')
  r.db.close()
})

checkAsync('★★ F-2-②-a · ③ 同步从对面收到一条新条目：也要拿到', async () => {
  await cloudReady
  const bucket = 'f2a-sync'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const before = startedLecture(r)
  configureSync(r, bucket)

  const t = Date.now()
  putChunk(bucket, 'other-100.json', [
    {
      uid: 'items-newghost',
      table: 'items',
      updatedAt: t,
      data: {
        // source='self' —— 他在另一台机器上「我的收集」贴的那一条（真实的跨设备形状）
        id: 900, term: '远端来的新表达', gloss: '', gloss_zh: '', layer: 'B', source: 'self',
        kind: 'chunk', production_state: 'new', streak: 0, attempts: 0, attempts_in_stage: 0,
        corrects: 0, hard_entries: 0, card_ease: 2.5, card_interval: 0, card_reps: 0,
        card_lapses: 0, card_silent: 0, card_due_at: null, recollected_count: 0,
        confidence: 1.0, owner_lecture_id: 1, deleted_at: null,
        created_at: t, updated_at: t, uid: 'items-newghost'
      }
    },
    {
      uid: 'il-newghost',
      table: 'item_lectures',
      updatedAt: t,
      data: { item_id: 900, lecture_id: 1, is_owner: 1, created_at: t, updated_at: t, uid: 'il-newghost' }
    }
  ] as unknown as Record<string, unknown>[])

  const out = await new Sync(r.db, join(backups, 'audio'), backups).run()
  assert(out.failed === 0, `同步报了失败：${JSON.stringify(out)}`)
  assert(
    cardOf(r.db, 900) !== null,
    '★★ 同步过来的新条目没拿到认读卡 —— 换台机器学的人永远练不到它'
  )
  assert(cardOf(r.db, 900) === t, '★ 认读时间该等于那条关系的 created_at')
  assertUntouched(r, before, '触发器')
  r.db.close()
})

check('★★ F-2-②-a · ④ 已经有卡的老条目，一个字都不许改', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const before = startedLecture(r)
  // 只看**这一讲下面**的条目 —— seedTree 还造了别的讲，那些本来就没卡
  const old = r.db
    .prepare(
      `select i.id, rc.due_at as c from items i join reading_cards rc on rc.item_id = i.id
         join item_lectures il on il.item_id = i.id
        where il.lecture_id = 1 order by i.id`
    )
    .all() as { id: number; c: number | null }[]
  assert(old.length > 0 && old.every((x) => x.c !== null), '前提：开始学之后这一讲的条目都该有卡')

  // 把同一批老条目再挂进另一讲（第 2 讲也弄成 training）
  r.db.prepare(`update lectures set status = 'training', due_at = ?, interval_days = 5 where id = 2`).run(
    Date.now() + 86_400_000
  )
  const t = Date.now() + 999
  const ins = r.db.prepare(
    `insert or ignore into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
     values (?, 2, 0, ?, ?)`
  )
  for (const o of old) ins.run(o.id, t, t)

  for (const o of old) {
    assert(
      cardOf(r.db, o.id) === o.c,
      `★★ 老条目的认读排期被改了：${o.id} 从 ${o.c} 变成 ${cardOf(r.db, o.id)}`
    )
  }
  assertUntouched(r, before, '触发器')
  r.db.close()
})

for (const [name, status] of [
  ['review', 'review'],
  ['empty', 'empty'],
  ['analyzing（历史值）', 'analyzing']
] as const) {
  check(`★★ F-2-②-a · ⑤⑥⑦ ${name} 的讲不发卡 —— 那是「开始学」的活`, () => {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    r.db.prepare(`update lectures set status = ? where id = 1`).run(status)

    const added = new Repo(r.db).addChunks(1, '贴一段', `phrase for ${status}`).added
    assert(added.length === 1, '前提没成立')
    assert(
      cardOf(r.db, added[0]!.id) === null,
      `★★ ${status} 的讲发了认读卡 —— 抢了「开始学」的活，他还没审阅完就开始考他`
    )
    r.db.close()
  })
}

check('★★ F-2-②-a · 归档的讲（silent=1）不发卡', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  new Repo(r.db).setSilent('lecture', 1, true)

  const added = new Repo(r.db).addChunks(1, '贴一段', 'phrase for silent').added
  assert(
    cardOf(r.db, added[0]!.id) === null,
    '★★ 归档的讲发了认读卡 —— 归档就是「不再排期」'
  )
  r.db.close()
})

check('★★ F-2-②-a · ⑧ 同一条挂第二讲：不重复初始化', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const id = new Repo(r.db).addItem(1, 'shared phrase', '', 'B', '').id
  const first = cardOf(r.db, id)
  assert(first !== null, '前提：第一次该拿到卡')

  r.db.prepare(`update lectures set status = 'training', due_at = ?, interval_days = 3 where id = 2`).run(
    Date.now() + 86_400_000
  )
  const t = Date.now() + 12_345
  r.db
    .prepare(
      `insert or ignore into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
       values (?, 2, 0, ?, ?)`
    )
    .run(id, t, t)

  assert(
    cardOf(r.db, id) === first,
    `★★ 挂第二讲时又初始化了一次：${first} → ${cardOf(r.db, id)}`
  )
  r.db.close()
})

check('★★ F-2-②-a · 触发器和插入同生共死：插入回滚，卡也不留', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const id = new Repo(r.db).addItem(1, 'rollback phrase', '', 'B', '').id
  // 造一条「没有卡」的干净条目
  r.db.prepare(`update reading_cards set due_at = null where item_id = ?`).run(id)
  r.db.prepare(`delete from item_lectures where item_id = ?`).run(id)
  const snap = snapshotAll(r.db)

  let threw = false
  try {
    r.db.transaction(() => {
      const t = Date.now()
      r.db
        .prepare(
          `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
           values (?, 1, 0, ?, ?)`
        )
        .run(id, t, t)
      assert(cardOf(r.db, id) !== null, '事务里那一刻卡该已经发了')
      throw new Error('故意炸')
    })()
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没冒出来')
  assert(cardOf(r.db, id) === null, '★★ 插入回滚了，认读卡却留下了 —— 触发器不在同一个事务里')
  assert(snapshotAll(r.db) === snap, '★ 库被改了一半')
  r.db.close()
})

check('★★ F-2-②-a · AI 提取的条目**不许**绕过 F-03 审阅门', () => {
  /**
   * ★ 这一条是和 F-03 撞出来的，不是想当然写的。
   *
   * F-2-① 之后分析**全程不动 status** —— 重新分析一条在轮转中的讲时，
   * AI 提取的条目插进来的那一刻这一讲**还是 training**。
   * 触发器要是不看 `source`，那些他还没审阅的提取结果会当场拿到认读卡，
   * 而 F-03 那道门的全部意义就是「让他先看一遍、删掉不要的，点了才进轮转」。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const t = Date.now()

  // 模拟分析：讲还停在 training，插一条 AI 提取的条目并挂上去
  const id = Number(
    r.db
      .prepare(
        `insert into items (term, gloss, layer, kind, source, owner_lecture_id, confidence,
                            created_at, updated_at)
         values ('ai extracted', '', 'B', 'chunk', 'ai', 1, 0.9, ?, ?)`
      )
      .run(t, t).lastInsertRowid
  )
  r.db
    .prepare(
      `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
       values (?, 1, 1, ?, ?)`
    )
    .run(id, t, t)

  assert(
    cardOf(r.db, id) === null,
    '★★ AI 提取的条目绕过了审阅门 —— 他还没看过、还没来得及删，就已经排进认读了'
  )

  // 而他审阅完点「开始学」，它照常拿到卡
  r.db.prepare(`update lectures set status = 'review' where id = 1`).run()
  new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2').startLearning(1)
  assert(cardOf(r.db, id) !== null, '★ 审阅完点了开始学，它该拿到卡')
  r.db.close()
})

check('★ F-2-②-a · 判据只有一份：触发器管所有插入入口', () => {
  /**
   * 这条守的是**将来**：以后新写一处 `insert into item_lectures`，
   * 触发器自动管得到；而如果哪天有人把它改成「在每个插入点调一次 helper」，
   * 漏掉一处的表现是「那几条永远练不到」，不报错，查很久。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const names = (
    r.db
      .prepare(`select name from sqlite_master where type = 'trigger' and tbl_name = 'item_lectures'`)
      .all() as { name: string }[]
  ).map((x) => x.name)
  assert(
    names.includes('trg_il_reading_card'),
    `★ 触发器不在了：${names.join('、') || '（一个都没有）'}`
  )
  r.db.close()
})

