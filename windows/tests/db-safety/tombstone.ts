/**
 * R-3 墓碑 · R-3-e 账本的撤销 · R-3-f 导回不许倒退 · R-3-g 父终结之后的子行
 *
 * 原 tests/db-safety.ts 第 8548–9846 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { MIGRATIONS, SYNC_TABLES } from '../../src/main/db/migrations.ts'
import { BUILTIN_TABLES } from '../../src/core/builtin-identity.ts'
import { needsTombstone, TOMBSTONE_KINDS } from '../../src/core/tombstone.ts'
import { Exporter } from '../../src/main/export.ts'
import { Study } from '../../src/main/study.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { Browse } from '../../src/main/browse.ts'
import { normTerm } from '../../src/main/db/ledger.ts'
import { Ledger } from '../../src/main/db/ledger.ts'
import { startupHeal } from '../../src/main/db/startup-heal.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, dbThatFailsOn, snapshotAll, auditIds, cloudReady, putChunk, configureSync, syncState, tombs, factsOf, readFacts, restoreCase, gt, ghost, purgeItem1 } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ R-3 · 硬删掉的东西，不许被旧同步包复活
//
// 软删是一次普通更新，跨设备传得好好的。硬删不是 ——
// `delete from` 之后本地一丝痕迹都不剩，于是远端那一行到了就被当成
// 「对面新建的」插回来。而复活不是假想：`applied` 只留最后 500 个包名、
// 新设备从头拉全部包、导回旧备份 —— 三条路都是必然会走到的。
//
// 这一块验的是数据层：碑立在该立的地方，不该立的地方一块都没有。
// ══════════════════════════════════════════════════════════════

console.log('\nR-3 · 墓碑\n')

/** 造一讲、几条知识点、几条材料，然后软删它 —— 垃圾箱里那个形状 */
function trashedLecture(r: ReturnType<typeof openDatabase>): { id: number; uid: string } {
  seedTree(r)
  const uid = (r.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid
  // 走真业务入口 —— 讲的软删在 browse 那边（D-091 还要处理独占知识点）
  new Browse(r.db).deleteLecture(1)
  return { id: 1, uid }
}

check('★★ R-3 · ③④ 软删和恢复都不立碑 —— 那是另一条生命周期', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const { uid } = trashedLecture(r)
  assert(tombs(r.db).length === 0, `★ 软删立了碑：${JSON.stringify(tombs(r.db))}`)

  new Browse(r.db).restore('lecture', 1)
  assert(tombs(r.db).length === 0, '★ 恢复之后冒出了碑')
  assert(
    (r.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid === uid,
    '★ 恢复把身份换了 —— 那它就不是原来那一行了'
  )
  r.db.close()
})

checkAsync('★★ R-3 · ① 垃圾箱里彻底删 → 立碑，而且身份就是被删那一行的 uid', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const { uid } = trashedLecture(r)
  const before = Date.now()

  await new Browse(r.db).purgeMany([{ kind: 'lecture', id: 1 }])

  const t = tombs(r.db)
  const mine = t.find((x) => x.target === uid)
  assert(mine, `★ 彻底删完没立碑：${JSON.stringify(t)}`)
  assert(mine!.kind === 'lectures', `碑上写错了表：${mine!.kind}`)
  assert(mine!.at >= before, '墓碑时间不对')
  assert(
    (r.db.prepare(`select count(*) as n from lectures where id = 1`).get() as { n: number }).n === 0,
    '前提没成立：那一讲还在'
  )
  r.db.close()
})

checkAsync('★★ R-3 · ② 30 天到期自动清理也立碑（他根本不会点那个按钮）', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const { uid } = trashedLecture(r)
  // 把删除时间推回 31 天前 —— 打开垃圾箱就会真删
  r.db
    .prepare(`update lectures set deleted_at = ? where id = 1`)
    .run(Date.now() - 31 * 86_400_000)

  await new Browse(r.db).trash() // 打开垃圾箱这一下就触发清理

  assert(
    (r.db.prepare(`select count(*) as n from lectures where id = 1`).get() as { n: number }).n === 0,
    '前提没成立：30 天规则没生效'
  )
  assert(tombs(r.db).some((x) => x.target === uid), `★ 自动清理没立碑：${JSON.stringify(tombs(r.db))}`)
  r.db.close()
})

checkAsync('★★ R-3 · ⑥ 删一个实体只立一块碑，派生行一块都不立', async () => {
  /**
   * 删一讲会连带删掉 `item_lectures` / `occurrences` / `answers` / `questions` /
   * `review_logs` / `analysis_blocks` / `state_events` / `item_events` ——
   * 给它们各立一块，墓碑会比数据还多，而且收益为零：
   * 它们的外键指向的父实体已经被父碑挡住了。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  // 给这一讲堆一点派生数据出来
  r.db.prepare(`insert into answers (item_id, session_id, question_id, text, is_first, grade, created_at, updated_at)
                values (1, null, null, '写的句子', 1, 3, ?, ?)`).run(t, t)
  r.db.prepare(`insert into review_logs (item_id, line, grade, interval_after, ease_after, created_at, updated_at)
                values (1, 'reading', 3, 3, 2.5, ?, ?)`).run(t, t)
  const derived = (
    r.db.prepare(`select count(*) as n from item_lectures`).get() as { n: number }
  ).n
  assert(derived > 0, '前提没成立：没有派生行')

  new Browse(r.db).deleteLecture(1)
  await new Browse(r.db).purgeMany([{ kind: 'lecture', id: 1 }])

  const kinds = new Set(tombs(r.db).map((x) => x.kind))
  for (const bad of [
    'item_lectures', 'occurrences', 'answers', 'questions',
    'review_logs', 'analysis_blocks', 'state_events', 'item_events'
  ]) {
    assert(!kinds.has(bad), `★ 给派生行 ${bad} 立了碑 —— 墓碑会比数据还多`)
  }
  assert(
    tombs(r.db).filter((x) => x.kind === 'lectures').length === 1,
    `★ 一讲立了不止一块碑：${JSON.stringify(tombs(r.db))}`
  )
  r.db.close()
})

checkAsync('★★ R-3 · ⑤ 立碑和删除同生共死：删到一半炸了，碑不许留下', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  trashedLecture(r)
  const snap = snapshotAll(r.db)

  // 注入故障：真正删 lectures 那一句失败
  const boom = dbThatFailsOn(r.db, 'delete from "lectures" where id in')
  let threw = false
  try {
    await new Browse(boom).purgeMany([{ kind: 'lecture', id: 1 }])
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没冒出来')
  assert(tombs(r.db).length === 0, '★★ 东西没删成，碑却留下了 —— 那一行从此再也同步不进来')
  assert(snapshotAll(r.db) === snap, '★ 库被改了一半')
  r.db.close()
})

checkAsync('★★ R-3 · ⑤ 反过来也要成立：碑写不进去，实体不许被删', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  trashedLecture(r)
  const snap = snapshotAll(r.db)

  const boom = dbThatFailsOn(r.db, 'insert into tombstones')
  let threw = false
  try {
    await new Browse(boom).purgeMany([{ kind: 'lecture', id: 1 }])
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没冒出来')
  assert(
    (r.db.prepare(`select count(*) as n from lectures where id = 1`).get() as { n: number }).n === 1,
    '★★ 碑没立成，东西却删掉了 —— 这正是复活的入口'
  )
  assert(snapshotAll(r.db) === snap, '★ 库被改了一半')
  r.db.close()
})

check('★★ R-3 · ⑦ 出厂表永远不该进 hardDelete（进了会挡住自愈补种）', () => {
  /**
   * 出厂内容的 uid 是**确定性**的（R-4-G）。要是哪天有路径把它送进 `hardDelete`，
   * 立下的碑会连 `ensureBuiltins` 补回来的那一条一起挡掉 —— 因为 uid 一样。
   *
   * 这条路目前不存在（清空/出厂重置走整表 delete，不经过 hardDelete；
   * 四张出厂表也不在垃圾箱那六类里）。但它是一条**隐含依赖**，得有人盯着。
   */
  // 判据不去扫源码文本 —— 直接问那条规则本身
  for (const t of BUILTIN_TABLES) {
    assert(!needsTombstone(t), `★ 出厂表 ${t} 被算进了立碑的六类`)
    assert(
      !(TOMBSTONE_KINDS as readonly string[]).includes(t),
      `★ 出厂表 ${t} 在立碑名单里 —— 碑会连自愈补回来的那一条一起挡掉`
    )
  }
  // 反过来：垃圾箱能彻底删的那六类，必须全都立碑，一个都不能漏
  for (const t of ['projects', 'units', 'lectures', 'items', 'materials', 'files']) {
    assert(needsTombstone(t), `★ 垃圾箱能删的 ${t} 却不立碑`)
  }
  // 而且真的没有任何一条路把出厂表送进 hardDelete
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'browse.ts'), 'utf8')
  for (const t of BUILTIN_TABLES) {
    assert(!src.includes(`hardDelete(this.db, '${t}'`), `★ 有路径把出厂表 ${t} 送进了 hardDelete`)
  }
})

check('★★ R-3 · ⑧ 清空全部数据不许逐行立碑 —— 那是 wipedAt 的活', () => {
  /**
   * 整库清空由 `wipedAt` 表达（比它旧的云端包整个不读），粒度是「包」。
   * 逐行立碑的话，几百条知识点会变成几百块碑，而且一块都不需要 ——
   * 那些包本来就已经被 wipedAt 挡在外面了。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const rows = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
  assert(rows > 0, '前提没成立：库里没东西')

  new Exporter(r.db).wipeStudyData(backups)

  assert(
    (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n === 0,
    '前提没成立：清空没生效'
  )
  assert(
    tombs(r.db).length === 0,
    `★ 清空全部数据立了 ${tombs(r.db).length} 块碑 —— 清空的语义在 wipedAt，不在这里`
  )
  r.db.close()
})

checkAsync('★ R-3 · 墓碑自己是同步表：有 uid、有 updated_at、触发器会发身份', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const { uid } = trashedLecture(r)
  await new Browse(r.db).purgeMany([{ kind: 'lecture', id: 1 }])

  const row = r.db
    .prepare(`select uid, updated_at as u from tombstones where target_uid = ?`)
    .get(uid) as { uid: string | null; u: number }
  assert(row.uid && row.uid.startsWith('tombstones-'), `★ 墓碑自己没拿到同步身份：${row.uid}`)
  assert(row.u > 0, '★ 墓碑的 updated_at 是 0 —— 它永远推不出去')
  assert(
    (SYNC_TABLES as readonly string[]).includes('tombstones'),
    '★ 墓碑不在同步表名单里 —— 另一台永远不知道你删了什么'
  )
  assert(auditIds(r.db).length === 0, `体检不干净：${auditIds(r.db).join('、')}`)
  r.db.close()
})

checkAsync('★★ R-3 · 同一个东西删两次：碑只有一块，时间取最新的一次', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const { uid } = trashedLecture(r)
  const browse = new Browse(r.db)
  await browse.purgeMany([{ kind: 'lecture', id: 1 }])
  const first = tombs(r.db).find((x) => x.target === uid)!

  // 手工把同一个 uid 再走一遍（模拟同步把它带回来又被删）
  r.db
    .prepare(
      `insert into lectures (id, unit_id, name, status, sort, uid, created_at, updated_at, deleted_at)
       values (1, 1, '又回来的', 'empty', 0, ?, ?, ?, ?)`
    )
    .run(uid, Date.now(), Date.now(), Date.now())
  await browse.purgeMany([{ kind: 'lecture', id: 1 }])

  const all = tombs(r.db).filter((x) => x.target === uid)
  assert(all.length === 1, `★ 同一个身份立了 ${all.length} 块碑`)
  assert(all[0]!.at >= first.at, '★ 第二次删除没更新墓碑时间')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ R-3-e · 「我改主意了」这句话也要能传到另一台机器上
//
// 他从垃圾箱里把一条表达捡回来，以前走的是 `delete from term_ledger` ——
// 撤销之后本地和「从来没记过」逐字节相同，没有任何东西可以推出去。
// 于是 B 上那条「以后别再收它」永久留着。
//
// 现在撤销是一次普通的行更新（`revoked_at` + `updated_at`），
// 而 `term_ledger` 本来就在同步表里，它自己就会走过去。
// ══════════════════════════════════════════════════════════════

console.log('\nR-3-e · 账本的撤销\n')

const ledgerRow = (
  db: Database.Database,
  term: string,
  verdict: string
): { id: number; verdict: string; c: number; u: number; rev: number | null } | undefined =>
  db
    .prepare(
      `select id, verdict, created_at as c, updated_at as u, revoked_at as rev
         from term_ledger where norm = ? and verdict = ?`
    )
    .get(normTerm(term), verdict) as
    | { id: number; verdict: string; c: number; u: number; rev: number | null }
    | undefined

check('★★ R-3-e · 撤销之后行还在、带撤销标记，而且判据说它不算数了', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  led.note('bear the brunt of', 'deleted')
  const before = ledgerRow(r.db, 'bear the brunt of', 'deleted')!
  assert(before.rev === null, '前提：刚记的账不该是撤销状态')
  assert(led.verdictOf('bear the brunt of') === 'deleted', '前提：判据该说它有效')

  const n = led.forget('bear the brunt of', 'deleted')

  assert(n === 1, `该撤掉 1 条，实际 ${n}`)
  const after = ledgerRow(r.db, 'bear the brunt of', 'deleted')
  assert(after, '★★ 撤销把行删掉了 —— 这条撤销从此传不到另一台设备')
  assert(after!.rev !== null, '★ 行还在，却没有撤销标记')
  assert(
    led.verdictOf('bear the brunt of') === null,
    '★ 撤销了，判据还说它有效 —— 那条表达永远进不来'
  )
  r.db.close()
})

check('★★ R-3-e · 撤销只动 revoked_at 和 updated_at，别的一个字不改', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  led.note('a far cry from', 'deleted', { note: '在知识点列表里删除' })
  const before = ledgerRow(r.db, 'a far cry from', 'deleted')!
  const body = r.db
    .prepare(`select norm, term, verdict, scope, lecture_id, note, created_at from term_ledger`)
    .all()

  led.forget('a far cry from', 'deleted')

  const after = ledgerRow(r.db, 'a far cry from', 'deleted')!
  assert(after.id === before.id, '★ 换了一行')
  assert(after.c === before.c, '★ created_at 被改了')
  assert(after.verdict === before.verdict, '★ verdict 被改了 —— 那就分不清撤的是哪一种了')
  assert(after.u > before.u || after.u >= before.u, 'updated_at 该往前走')
  assert(
    JSON.stringify(
      r.db
        .prepare(`select norm, term, verdict, scope, lecture_id, note, created_at from term_ledger`)
        .all()
    ) === JSON.stringify(body),
    '★ 撤销顺手改了别的列'
  )
  r.db.close()
})

check('★★ R-3-e · 撤销必须抬 updated_at —— 不抬的话另一台永远看不到这次变化', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  led.note('hold sway over', 'deleted')
  // 把 updated_at 压到很早，模拟「这条账很久以前就同步过去了」
  r.db.prepare(`update term_ledger set updated_at = 1000 where norm = 'hold sway over'`).run()

  led.forget('hold sway over', 'deleted')

  const after = ledgerRow(r.db, 'hold sway over', 'deleted')!
  assert(
    after.u > 1000,
    `★★ 撤销没抬 updated_at —— 它不会被 collectSince 收走，另一台永远不知道：${after.u}`
  )
  r.db.close()
})

check('★★ R-3-e · 撤 deleted 不许碰 silenced 和 purged', () => {
  /**
   * N-2-b 已经为此付过账：他先静默一条、后来又删了它、再从垃圾箱恢复 ——
   * 那次恢复把「我已经会了」也一起擦掉，于是它重新排进轮转，
   * 而他只会觉得「静默怎么又失效了」。这条守的是那个边界。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  const term = 'at the mercy of'
  led.note(term, 'deleted')
  led.note(term, 'silenced')
  led.note(term, 'purged')

  led.forget(term, 'deleted')

  assert(ledgerRow(r.db, term, 'deleted')!.rev !== null, 'deleted 该被撤销')
  assert(ledgerRow(r.db, term, 'silenced')!.rev === null, '★ 顺手把「我已经会了」也撤了')
  assert(ledgerRow(r.db, term, 'purged')!.rev === null, '★ 顺手把「我彻底删了」也撤了')
  // 还有别的判定在，所以这个说法照样跳过 —— 只是理由换了一个
  assert(led.verdictOf(term) === 'purged', `剩下的判定该继续生效：${led.verdictOf(term)}`)
  r.db.close()
})

check('★★ R-3-e · 删 → 撤销 → 再删：第二次记账必须重新生效', () => {
  /**
   * `note()` 的 upsert 要把 `revoked_at` 清回 null。不清的话，
   * 第二次删除**写进去了却不生效** —— 账本里明明有这一行，
   * AI 却照样把它收进来，而他完全看不出为什么。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  const term = 'in the wake of'
  led.note(term, 'deleted')
  led.forget(term, 'deleted')
  assert(led.verdictOf(term) === null, '前提：撤销之后该不算数')

  led.note(term, 'deleted') // 他又删了一次

  assert(
    led.verdictOf(term) === 'deleted',
    '★★ 第二次删除写进去了却不生效 —— 账本里有这一行，AI 却照样收它'
  )
  assert(ledgerRow(r.db, term, 'deleted')!.rev === null, '★ revoked_at 没清回去')
  assert(
    (r.db.prepare(`select count(*) as n from term_ledger`).get() as { n: number }).n === 1,
    '★ 长出了第二行'
  )
  r.db.close()
})

check('★ R-3-e · 重复撤销是幂等的，不会平白抬高 updated_at 去挤同步流量', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  led.note('by dint of', 'deleted')
  assert(led.forget('by dint of', 'deleted') === 1, '第一次该撤掉 1 条')
  const first = ledgerRow(r.db, 'by dint of', 'deleted')!

  assert(led.forget('by dint of', 'deleted') === 0, '★ 第二次还报撤掉了一条')
  const again = ledgerRow(r.db, 'by dint of', 'deleted')!
  assert(again.rev === first.rev && again.u === first.u, '★ 重复撤销把时间戳又推了一次')
  r.db.close()
})

check('★ R-3-e · 手动撤一条（设置页那条契约）也是记撤销，不是删行', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  led.note('come to terms with', 'deleted')
  const id = ledgerRow(r.db, 'come to terms with', 'deleted')!.id

  assert(led.drop(id) === 1, 'drop 该撤掉 1 条')

  assert(ledgerRow(r.db, 'come to terms with', 'deleted'), '★ drop 把行删掉了')
  assert(led.verdictOf('come to terms with') === null, '★ drop 之后判据还说它有效')
  assert(led.list()[0]!.revokedAt !== null, '★ 名单上看不出它已经撤销了')
  r.db.close()
})

check('★★ R-3-e · 老库升级：现有账本行全是「有效」，一个字都没被改', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const led = new Ledger(r.db)
  led.note('under the guise of', 'deleted')
  led.note('under the guise of', 'silenced')
  const before = r.db
    .prepare(`select norm, term, verdict, scope, lecture_id, note, created_at, updated_at
                from term_ledger order by id`)
    .all()

  // 把这张表打回 V22 之前的样子（那一列和它的索引都不存在），再跑一次迁移
  r.db.exec(`drop index if exists idx_ledger_live`)
  r.db.exec(`alter table term_ledger drop column revoked_at`)
  const m = MIGRATIONS.find((x) => x.version === 22)!
  m.up(r.db)

  assert(
    JSON.stringify(
      r.db
        .prepare(`select norm, term, verdict, scope, lecture_id, note, created_at, updated_at
                    from term_ledger order by id`)
        .all()
    ) === JSON.stringify(before),
    '★ 迁移改了现有账本行'
  )
  const live = r.db.prepare(`select count(*) as n from term_ledger where revoked_at is null`).get() as {
    n: number
  }
  assert(live.n === 2, `★ 升级之后老账本不是「有效」状态：${live.n}`)
  // 再跑一次也不许出事
  m.up(r.db)
  assert(
    (r.db.prepare(`select count(*) as n from term_ledger`).get() as { n: number }).n === 2,
    '★ 迁移不幂等'
  )
  r.db.close()
})

checkAsync('★ R-3-e · 账本永远不进立碑的六类 —— 意图和实体生命周期是两回事', async () => {
  assert(!needsTombstone('term_ledger'), '★ 给账本立碑了 —— 那会把「改主意」当成「被终结」')
  assert(
    !(TOMBSTONE_KINDS as readonly string[]).includes('term_ledger'),
    '★ 账本出现在立碑名单里'
  )
})

// ══════════════════════════════════════════════════════════════
// ★★ R-3-f · 导回旧备份不许把「已经发生过的事」当成没发生
//
// 真跑一遍量出来的病：restore 之后墓碑 3→0、账本撤销 1→0、
// wipedAt 2000→1000。后果不是「东西立刻回来了」——
// 是**挡它们的那些事实没了**，下一次同步云端老包一到，全部复活。
//
// 这一块**必须走真实的 `restoreFrom()`**（验来源 → 安全备份 → 临时副本 →
// 验临时 → 合并 → 再验 → 原子替换），不许只调 merge helper：
// 病就出在那条链路的形状上。
// ══════════════════════════════════════════════════════════════

console.log('\nR-3-f · 导回不许倒退不可逆事实\n')

const setKey = (db: Database.Database, k: string, v: string): void => {
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, 1)
       on conflict(key) do update set value = excluded.value`
  ).run(k, v)
}

/**
 * 造出「一份旧备份 + 之后又发生了几件不可逆的事」这个形状。
 *
 * `shape` 决定旧备份里有什么，`after` 决定备份之后又发生了什么。
 */

/** 软删一讲再彻底删 —— 立一块碑 */
async function purgeLecture(r: ReturnType<typeof openDatabase>, id: number): Promise<void> {
  const b = new Browse(r.db)
  b.deleteLecture(id)
  await b.purgeMany([{ kind: 'lecture', id }])
}

checkAsync('★★ R-3-f · ① 当前有碑、备份没有 → 碑保留；同时备份里的业务数据确实恢复了', async () => {
  const { before, backup, final } = await restoreCase(
    () => {
      /* 备份里干干净净 */
    },
    (r) => purgeLecture(r, 1)
  )
  assert(backup.tombs.length === 0, `前提没成立：备份里本来就有碑 ${JSON.stringify(backup.tombs)}`)
  assert(before.tombs.length > 0, '前提没成立：当前库应该有碑')

  assert(
    final.tombs.length === before.tombs.length,
    `★★ 导回把当前的墓碑抹掉了 —— R-3 的保证当场作废：${JSON.stringify(final.tombs)}`
  )
  // ★ 业务数据必须真的回来了，否则「事实保住了」只是因为导回什么都没干
  assert(
    final.lectures === backup.lectures && final.lectures > before.lectures,
    `★ 备份里的讲没恢复：备份 ${backup.lectures} · 导回前 ${before.lectures} · 导回后 ${final.lectures}`
  )
  assert(final.items === backup.items, `★ 备份里的知识点没恢复：${final.items} ≠ ${backup.items}`)
})

checkAsync('★★ R-3-f · ② 当前没碑、备份有 → 备份那块碑跟着回来', async () => {
  const { before, backup, final } = await restoreCase(
    (r) => purgeLecture(r, 1),
    () => {
      /* 备份之后什么都没干 */
    }
  )
  assert(backup.tombs.length > 0, '前提没成立：备份里该有碑')
  assert(before.tombs.length === backup.tombs.length, '前提：当前库这时也有那块碑')
  assert(
    final.tombs.length === backup.tombs.length,
    `★ 备份里的碑没恢复：${JSON.stringify(final.tombs)}`
  )
})

checkAsync('★★ R-3-f · ③ 两边都有同一块碑 → 只留一块，purged_at 取较晚的', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  await purgeLecture(r, 1)
  // 备份里那块碑的时间压早
  r.db.prepare(`update tombstones set purged_at = 1000`).run()
  const src = join(dir, 'old.db')
  new Exporter(r.db).backupTo(src)
  const bak = readFacts(src)
  assert(
    bak.tombs.length > 0 && bak.tombs.every((t) => t.at === 1000),
    `前提：备份里的碑该全是 1000 —— ${JSON.stringify(bak.tombs)}`
  )

  // 当前库那几块碑更晚
  r.db.prepare(`update tombstones set purged_at = 5000`).run()

  await new Exporter(r.db).restoreFrom(src, p, backups, MIGRATIONS.length)
  r.db.close()
  const f = readFacts(p)
  assert(
    f.tombs.length === bak.tombs.length,
    `★ 同一块碑长成了两块：备份 ${bak.tombs.length} 块，导回后 ${f.tombs.length} 块`
  )
  assert(
    f.tombs.every((t) => t.at === 5000),
    `★★ 墓碑时刻取错了方向：该是 5000（较晚，挡得更严），实际 ${JSON.stringify(f.tombs)}`
  )
})

checkAsync('★★ R-3-f · ④ 当前撤销过、备份里还有效 → 撤销保留', async () => {
  const TERM = 'bear the brunt of'
  const { before, backup, final, p } = await restoreCase(
    (r) => {
      new Ledger(r.db).note(TERM, 'deleted')
    },
    (r) => {
      new Ledger(r.db).forget(TERM, 'deleted')
    }
  )
  assert(backup.revoked === 0, '前提没成立：备份里那条账该是有效的')
  assert(before.revoked === 1, '前提没成立：当前库那条该已撤销')

  assert(
    final.revoked === 1,
    `★★ 旧备份把当前的撤销擦掉了 —— 他捡回来的表达又进不去了：revoked=${final.revoked}`
  )
  // 判据要用真判据，不是数行数
  const d = new Database(p, { readonly: true })
  const live = d
    .prepare(`select count(*) as n from term_ledger where norm = ? and revoked_at is null`)
    .get(TERM) as { n: number }
  d.close()
  assert(live.n === 0, `★ 那条判定又生效了：${live.n}`)
})

checkAsync('★★ R-3-f · ⑤ 备份里那条更新（已撤销）、当前还有效 → 用备份的', async () => {
  const TERM = 'a far cry from'
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const led = new Ledger(r.db)
  led.note(TERM, 'deleted')
  led.forget(TERM, 'deleted') // 备份里：已撤销，时间很新
  const src = join(dir, 'old.db')
  new Exporter(r.db).backupTo(src)

  // 当前库：把它改回「有效」，而且时间戳更旧 —— 备份那一版更新
  r.db
    .prepare(`update term_ledger set revoked_at = null, updated_at = 1 where norm = ?`)
    .run(TERM)
  const beforeLive = (
    r.db.prepare(`select count(*) as n from term_ledger where norm=? and revoked_at is null`).get(TERM) as {
      n: number
    }
  ).n
  assert(beforeLive === 1, '前提没成立：当前库那条该是有效的')

  await new Exporter(r.db).restoreFrom(src, p, backups, MIGRATIONS.length)
  r.db.close()
  const d = new Database(p, { readonly: true })
  const live = (
    d.prepare(`select count(*) as n from term_ledger where norm=? and revoked_at is null`).get(TERM) as {
      n: number
    }
  ).n
  d.close()
  assert(live === 0, '★ 备份里更新的那次撤销没生效 —— 合并不该无脑保留当前那一行')
})

checkAsync('★★ R-3-f · ④b 撤 deleted 不许连累 silenced / purged（合并之后仍然独立）', async () => {
  const TERM = 'at the mercy of'
  const { p } = await restoreCase(
    (r) => {
      const l = new Ledger(r.db)
      l.note(TERM, 'deleted')
      l.note(TERM, 'silenced')
      l.note(TERM, 'purged')
    },
    (r) => {
      new Ledger(r.db).forget(TERM, 'deleted')
    }
  )
  const d = new Database(p, { readonly: true })
  const rows = d
    .prepare(`select verdict, revoked_at as rev from term_ledger where norm = ? order by verdict`)
    .all(TERM) as { verdict: string; rev: number | null }[]
  d.close()
  assert(rows.length === 3, `★ 三条判定没都留下：${JSON.stringify(rows)}`)
  assert(rows.find((x) => x.verdict === 'deleted')!.rev !== null, '★ deleted 的撤销没保住')
  assert(rows.find((x) => x.verdict === 'silenced')!.rev === null, '★ 顺手把 silenced 也撤了')
  assert(rows.find((x) => x.verdict === 'purged')!.rev === null, '★ 顺手把 purged 也撤了')
})

checkAsync('★★ R-3-f · ⑥ wipedAt 取较晚的 —— 不许因为导回让云端老包重新可读', async () => {
  const { before, backup, final } = await restoreCase(
    (r) => setKey(r.db, 'sync.wipedAt', '1000'),
    (r) => setKey(r.db, 'sync.wipedAt', '2000')
  )
  assert(backup.wipedAt === '1000' && before.wipedAt === '2000', '前提没成立')
  assert(
    final.wipedAt === '2000',
    `★★ wipedAt 退回旧值 —— 比它旧的云端包重新可读，正是 I-068 那个 bug：${final.wipedAt}`
  )
})

checkAsync('★★ R-3-f · ⑦ watermark 取较**小**的 —— 取 max 会静默丢掉备份里没推过的行', async () => {
  const { before, backup, final } = await restoreCase(
    (r) => setKey(r.db, 'sync.watermark', '1000'),
    (r) => setKey(r.db, 'sync.watermark', '2000')
  )
  assert(backup.watermark === '1000' && before.watermark === '2000', '前提没成立')
  assert(
    final.watermark === '1000',
    `★★ 水位取成了较大的那个 —— 备份里那些还没推上去的行从此再也收不到：${final.watermark}`
  )
})

checkAsync('★ R-3-f · ⑧ applied 取并集 —— 它是缓存，重复读一个包只是浪费流量', async () => {
  const { final } = await restoreCase(
    (r) => setKey(r.db, 'sync.applied', '["old-1.json"]'),
    (r) => setKey(r.db, 'sync.applied', '["new-1.json","new-2.json"]')
  )
  assert(
    ['old-1.json', 'new-1.json', 'new-2.json'].every((x) => final.applied.includes(x)),
    `★ 并集没并全：${JSON.stringify(final.applied)}`
  )
  assert(final.applied.length === 3, `★ 有重复：${JSON.stringify(final.applied)}`)
})

checkAsync('★★ R-3-f · ⑨ 导回失败 → 当前库的每一条事实一个字都不变', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  await purgeLecture(r, 1)
  new Ledger(r.db).note('hold sway over', 'deleted')
  new Ledger(r.db).forget('hold sway over', 'deleted')
  setKey(r.db, 'sync.wipedAt', '2000')
  const before = factsOf(r.db)
  assert(before.tombs.length > 0 && before.revoked === 1, '前提没成立')

  // 一个连 SQLite 都不是的「备份」
  const bad = join(dir, 'not-a-db.db')
  writeFileSync(bad, '这不是数据库，只是一段话。', 'utf8')

  let threw = false
  try {
    await new Exporter(r.db).restoreFrom(bad, p, backups, MIGRATIONS.length)
  } catch {
    threw = true
  }
  assert(threw, '这种来源居然被接受了')

  // 当前库**必须还开着**，而且每一条事实原封不动
  assert(
    JSON.stringify(factsOf(r.db)) === JSON.stringify(before),
    `★★ 导回失败却改了当前库：\n  前 ${JSON.stringify(before)}\n  后 ${JSON.stringify(factsOf(r.db))}`
  )
  r.db.close()
  // 磁盘上那份也一样
  assert(JSON.stringify(readFacts(p)) === JSON.stringify(before), '★ 磁盘上那份被改了')
  const junk = readdirSync(dirname(p)).filter((f) => /\.tmp\.db$/.test(f))
  assert(junk.length === 0, `留下了临时文件：${junk.join('、')}`)
})

check('★★ R-3-f · ⑧b 合并只许写临时库，当前库在这一段里只许被读', () => {
  /**
   * ★ 这一条只能靠扫源码，运行时验不出来 —— 我试过了。
   *
   * 把合并改成写当前库之后，「导回失败 → 当前库不变」那条用例**照样绿**：
   * 它用的坏来源在第一步验证就被拒了，根本走不到合并那一步。
   * 而合并内部包着事务，中途抛错两边都会回滚，运行时也分辨不出来。
   *
   * 但这条约束是 C-1 的地基：**在原子替换成功之前，
   * 当前正在用的那个库一个字节都不能动。** 所以它必须有人守。
   */
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'export.ts'), 'utf8')
  const from = src.indexOf('private mergeIrreversible')
  const to = src.indexOf('async restoreFrom')
  assert(from > 0 && to > from, '找不到合并那一段 —— 函数改名了？')
  const body = src.slice(from, to)

  assert(body.includes('new Database(tmpPath)'), '★★ 合并没有打开临时库')

  /**
   * 判据：这一段里凡是 insert / update / delete，
   * 都必须是**在临时库那个连接上**准备的。
   * 先把换行压平再扫，免得被换行位置绕过去。
   */
  const flat = body.replace(/[\r\n]+/g, ' ')
  const stmts = flat.match(/(\w+(?:\.\w+)*)\s*\.prepare\(\s*`\s*(insert|update|delete)/gi) ?? []
  for (const st of stmts) {
    assert(
      /^tmp\s*\.prepare/i.test(st.trim()),
      `★★ 合并里有一句写操作不是发给临时库的 —— 导回失败时他的数据就回不去了：「${st.trim()}」`
    )
  }
  assert(stmts.length >= 3, `★ 一句写操作都没扫到，这条用例形同虚设：${stmts.length}`)
})

checkAsync('★★ R-3-f · ⑩ 导回之后再启动一次自愈 → 幂等，体检干净', async () => {
  const { p } = await restoreCase(
    () => {
      /* 空备份 */
    },
    (r) => purgeLecture(r, 1)
  )
  const d = new Database(p)
  try {
    const first = startupHeal(d)
    assert(first.problems.length === 0, `自愈报了毛病：${JSON.stringify(first.problems)}`)
    const snap = snapshotAll(d)
    startupHeal(d)
    assert(snapshotAll(d) === snap, '★ 第二次启动动了数据')
    assert(auditIds(d).length === 0, `体检不干净：${auditIds(d).join('、')}`)
  } finally {
    d.close()
  }
})

checkAsync('★★ R-3-f · ⑪ 导回一份「删除之前」的备份，再真同步一次 → 仍然不复活', async () => {
  /**
   * 这是整轮的正题。前面那些用例证明「墓碑保住了」，
   * 而保住的**意义**只有在这里才看得见：云端那些老包还在，
   * 一同步就会把删掉的行送过来，全靠那几块碑挡着。
   *
   * 走的是真 `restoreFrom()` + 真 `Sync.run()` + 真 HTTP（假 WebDAV 服务器）。
   * 界面上的导回是一个文件对话框，测试驱动不了它 ——
   * 而那一层在这个场景里不增加任何东西：病在数据和包之间。
   */
  await cloudReady
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'r3f')
  const uid = (r.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid

  // ① 先把「删除之前」的样子推上云端，并留一份那时的备份
  await new Sync(r.db, join(backups, 'audio'), backups).run()
  const src = join(dir, 'before-delete.db')
  new Exporter(r.db).backupTo(src)
  assert(readFacts(src).tombs.length === 0, '前提：这份备份里不该有任何碑')

  // ② 彻底删掉它 —— 立碑
  await purgeLecture(r, 1)
  assert(
    (r.db.prepare(`select count(*) as n from tombstones where target_uid = ?`).get(uid) as {
      n: number
    }).n === 1,
    '前提：该立碑了'
  )

  // ③ 导回那份「删除之前」的备份（真实链路）
  await new Exporter(r.db).restoreFrom(src, p, backups, MIGRATIONS.length)
  r.db.close()

  const back = openDatabase(p, backups)
  assert(
    (back.db.prepare(`select count(*) as n from tombstones where target_uid = ?`).get(uid) as {
      n: number
    }).n === 1,
    '★★ 导回把墓碑抹掉了 —— 下一次同步那一讲就会复活'
  )
  // 业务数据确实回来了（那一讲在备份里还在）
  assert(
    (back.db.prepare(`select count(*) as n from lectures where uid = ?`).get(uid) as { n: number })
      .n === 1,
    '★ 备份里的那一讲没恢复 —— 那这条用例什么都没验到'
  )

  /**
   * ④ 再同步一次。**`applied` 清空**，让云端那些老包重新被读一遍 ——
   * 那不是造假：`applied` 只留最后 500 个包名，溢出之后必然发生。
   * 老包里装着「删除之前」的那一讲。
   */
  back.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  // 那一讲此刻在库里（备份带回来的），先删掉它，好看清楚「同步会不会把它塞回来」
  await purgeLecture(back, 1)
  assert(
    (back.db.prepare(`select count(*) as n from lectures where uid = ?`).get(uid) as { n: number })
      .n === 0,
    '前提：这一刻它不该在库里'
  )

  const out = await new Sync(back.db, join(backups, 'audio'), backups).run()
  assert(out.failed === 0, `同步报了失败：${JSON.stringify(out)}`)
  assert(
    (back.db.prepare(`select count(*) as n from lectures where uid = ?`).get(uid) as { n: number })
      .n === 0,
    '★★ 导回旧备份之后，删掉的一讲被云端老包复活了 —— 这正是 R-3-f'
  )
  back.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ R-3-g · 父实体被终结之后，它那些旧子行
//
// 实测过的两种下场，都不好：
//   · 有外键的 → FOREIGN KEY constraint failed → 算失败 →
//     那一包永远不进 applied，**永远重试**，「没有完全成功」永远挂着
//   · 没外键的（只有 picks）→ 直接写进来，成了看不见的孤儿
//
// 判据是**碑**，不是「库里缺了那一行」——
// 子行先到、父行还在路上是正常时序，那时候必须失败并重试。
// 这条护栏是本块用例的重点（第 ④ 条）。
// ══════════════════════════════════════════════════════════════

console.log('\nR-3-g · 父终结之后的子行\n')

/**
 * ★★ C-2 · 包里不再有数字外键，关系一律是 uid。
 * 所以这些「别的设备推上来的」夹具也要按新协议造，否则验的是一个
 * 现实中根本不存在的包格式。
 */
const gUid = (r: ReturnType<typeof openDatabase>, table: string, id: number): string =>
  (r.db.prepare(`select uid from "${table}" where id = ?`).get(id) as { uid: string }).uid

const gRevLog = (itemUid: string): Record<string, unknown> =>
  ghost('review_logs', {
    item_uid: itemUid,
    line: 'reading',
    grade: 3,
    interval_after: 3,
    ease_after: 2.5,
    created_at: gt,
    updated_at: gt
  })

const gPick = (lecUid: string): Record<string, unknown> =>
  ghost('picks', {
    scope: 'lecture',
    scope_uid: lecUid,
    content: '精选材料',
    created_at: gt,
    updated_at: gt
  })

interface GRun {
  out: Awaited<ReturnType<Sync['run']>>
  db: Database.Database
  applied: boolean
  close: () => void
}

/** 跑一次：造库 → prep → 塞包 → 同步 → 返回四个数和落库情况 */
async function gRun(
  bucket: string,
  prep: (r: ReturnType<typeof openDatabase>) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
  chunk = 'other-100.json'
): Promise<GRun> {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  putChunk(bucket, chunk, (await prep(r)) as unknown as Record<string, unknown>[])
  const out = await new Sync(r.db, join(backups, 'audio'), backups).run()
  return {
    out,
    db: r.db,
    applied: syncState(r.db).applied.includes(chunk),
    close: () => r.db.close()
  }
}

const purgeLec1 = async (r: ReturnType<typeof openDatabase>): Promise<void> => {
  const b = new Browse(r.db)
  b.deleteLecture(1)
  await b.purgeMany([{ kind: 'lecture', id: 1 }])
}

const nOf = (db: Database.Database, t: string): number =>
  (db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n

checkAsync('★ R-3-g · ① 父还活着 → 子行正常写入（对照）', async () => {
  const g = await gRun('ga1', (r) => [gRevLog(gUid(r, 'items', 1))])
  assert(g.out.received === 1, `前提：包里该有 1 行，实际 ${g.out.received}`)
  assert(g.out.applied === 1 && g.out.failed === 0, `该正常落库：${JSON.stringify(g.out)}`)
  assert(nOf(g.db, 'review_logs') === 1, '★ 父活着却没写进去')
  g.close()
})

checkAsync('★★ R-3-g · ② 父只是软删（还在垃圾箱）→ 子行照样写入', async () => {
  // 软删不是终结 —— 他随时可能捡回来，那些子行必须留着
  const g = await gRun('ga2', (r) => {
    const u = gUid(r, 'items', 1)
    new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2').deleteItem(1)
    return [gRevLog(u)]
  })
  assert(g.out.received === 1, '前提：包里该有 1 行')
  assert(
    g.out.applied === 1 && g.out.failed === 0,
    `★★ 软删被当成了终结 —— 他从垃圾箱捡回来时进度就少了一截：${JSON.stringify(g.out)}`
  )
  g.close()
})

checkAsync('★★ R-3-g · ③ 父被终结 → 子行 skipped，而且这一包照样进 applied', async () => {
  const g = await gRun('ga3', async (r) => {
    const u = gUid(r, 'items', 1)
    await purgeItem1(r)
    return [gRevLog(u)]
  })
  assert(g.out.received === 1, '前提：那条子行确实在被处理的包里')
  assert(g.out.failed === 0, `★★ 还是算成了失败 —— 这一包会永远重试：${JSON.stringify(g.out)}`)
  assert(g.out.skipped === 1, `★ 没算进 skipped：${JSON.stringify(g.out)}`)
  assert(nOf(g.db, 'review_logs') === 0, '★ 居然写进去了')
  assert(g.applied, '★★ 全是 skipped 的包没进 applied —— 它会被无限重下')
  g.close()
})

checkAsync('★★ R-3-g · ④ 父不在、也没有碑 → **仍然失败并重试**（最重要的护栏）', async () => {
  /**
   * 子行先到、父行还在路上，是同步里再正常不过的时序。
   * 判据必须是「爹有没有碑」，绝不能是「爹在不在」——
   * 写成后者的话，「等父亲」就变成了「永久丢弃」。
   */
  const g = await gRun('ga4', () => [gRevLog('items-never-synced-000')])
  assert(g.out.received === 1, '前提：包里该有 1 行')
  assert(
    g.out.failed === 1 && g.out.skipped === 0,
    `★★ 把「父行还没到」当成了「父被终结」—— 那一行会被永久丢掉：${JSON.stringify(g.out)}`
  )
  assert(!g.applied, '★ 有失败的包不该进 applied（R-4-A）')
  g.close()
})

checkAsync('★★ R-3-g · ⑤ 父 lecture 终结 → item_lectures / occurrences 一起 skipped', async () => {
  const g = await gRun('ga5', async (r) => {
    const lecU = gUid(r, 'lectures', 1)
    const itemU = gUid(r, 'items', 2)
    await purgeLec1(r)
    return [
      ghost('item_lectures', {
        item_uid: itemU,
        lecture_uid: lecU,
        is_owner: 0,
        created_at: gt,
        updated_at: gt
      }),
      ghost('occurrences', {
        item_uid: itemU,
        lecture_uid: lecU,
        material_uid: null,
        quote: '一句原文',
        created_at: gt,
        updated_at: gt
      })
    ]
  })
  assert(g.out.received === 2, '前提：包里该有 2 行')
  assert(g.out.failed === 0 && g.out.skipped === 2, `★ 该全跳过：${JSON.stringify(g.out)}`)
  assert(g.applied, '★★ 这一包没进 applied，会永远重下')
  g.close()
})

checkAsync('★★ R-3-g · ⑥ 两跳：questions + drafts 一起 skipped（不靠包里的顺序）', async () => {
  /**
   * `drafts → questions → items`。drafts 的外键只够到 questions，
   * 而 questions 才是被父碑挡下的那一层。
   * **故意把 drafts 排在 questions 前面**，证明不是靠顺序蒙对的。
   */
  const g = await gRun('ga6', async (r) => {
    const itemU = gUid(r, 'items', 1)
    await purgeItem1(r)
    const q = ghost('questions', {
      item_uid: itemU,
      tier: 1,
      type: '造句',
      prompt: 'x',
      context: '',
      reference: '',
      qtype_sig: '',
      created_at: gt,
      updated_at: gt
    })
    const d = ghost('drafts', {
      question_uid: q['uid'] as string,
      session_uid: null,
      text: '写了一半',
      created_at: gt,
      updated_at: gt
    })
    return [d, q] // ← drafts 故意排在前面
  })
  assert(g.out.received === 2, '前提：包里该有 2 行')
  assert(
    g.out.failed === 0 && g.out.skipped === 2,
    `★★ 两跳没传递到 —— drafts 还在失败重试：${JSON.stringify(g.out)}`
  )
  assert(nOf(g.db, 'questions') === 0 && nOf(g.db, 'drafts') === 0, '★ 有一行写进去了')
  assert(g.applied, '★ 全 skipped 的包该进 applied')
  g.close()
})

checkAsync('★★ R-3-g · ⑦ picks 没有外键 —— 父讲终结之后不许留下孤儿', async () => {
  const g = await gRun('ga7', async (r) => {
    const u = gUid(r, 'lectures', 1)
    await purgeLec1(r)
    return [gPick(u)]
  })
  assert(g.out.received === 1, '前提：包里该有 1 行')
  assert(
    nOf(g.db, 'picks') === 0,
    '★★ 父讲已经被彻底删除，这条精选材料却写进来了 —— 查不到、看不见、只占地方'
  )
  assert(g.out.skipped === 1 && g.out.failed === 0, `该算跳过：${JSON.stringify(g.out)}`)
  g.close()
})

checkAsync('★★ R-3-g · ⑧ picks + 父讲还在（没碑）→ 保持原语义，不许顺手跳过', async () => {
  const g = await gRun('ga8', (r) => [gPick(gUid(r, 'lectures', 1))])
  assert(g.out.received === 1, '前提：包里该有 1 行')
  assert(nOf(g.db, 'picks') === 1, `★ 父讲好好的，精选材料却没进来：${JSON.stringify(g.out)}`)
  g.close()
})

checkAsync('★★ R-3-g · ⑨ 父碑与子行**同批**到达 → 子行也要 skipped', async () => {
  const g = await gRun('ga9', (r) => {
    // 本地先不删；碑跟着包一起来
    const uid = (r.db.prepare(`select uid from items where id = 1`).get() as { uid: string }).uid
    return [
      gRevLog(gUid(r, 'items', 1)),
      ghost('tombstones', {
        target_uid: uid,
        kind: 'items',
        target_id: 1,
        purged_at: gt + 30_000,
        created_at: gt,
        updated_at: gt
      })
    ]
  })
  assert(g.out.received === 2, '前提：包里该有 2 行')
  assert(g.out.failed === 0, `★★ 同批到达时子行还是失败了：${JSON.stringify(g.out)}`)
  /**
   * ★ 只看末态是**不够**的：碑落库之后 `applyTombstones` 会把本地那条知识点
   * 连同它的派生行一起级联删掉，所以就算子行先被写了进来，
   * `review_logs` 最后照样是 0 —— 这条用例会假绿（去掉父级判断验证过）。
   *
   * 所以要验**它压根没被写过**：碑那一行该应用（1），子行该跳过（1）。
   */
  assert(
    g.out.applied === 1 && g.out.skipped === 1,
    `★★ 子行是先被写进来、再被级联删掉的 —— 父级判断没生效：${JSON.stringify(g.out)}`
  )
  assert(nOf(g.db, 'review_logs') === 0, '★ 子行写进去了')
  g.close()
})

checkAsync('★★ R-3-g · ⑩ 旧包重放：不再产生失败重试，四个数对得上账', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'ga10')
  const item1Uid = gUid(r, 'items', 1)
  await purgeItem1(r)
  putChunk('ga10', 'other-100.json', [gRevLog(item1Uid), gRevLog(item1Uid)] as unknown as Record<
    string,
    unknown
  >[])
  const sync = new Sync(r.db, join(backups, 'audio'), backups)

  const first = await sync.run()
  assert(
    first.received === 2 && first.failed === 0 && first.skipped === 2,
    `第一次：${JSON.stringify(first)}`
  )
  assert(
    first.applied + first.skipped + first.failed === first.received,
    `★ 四个数对不上账：${JSON.stringify(first)}`
  )
  assert(syncState(r.db).applied.includes('other-100.json'), '★ 包没进 applied')

  // 重放一次（applied 清空 —— 那张名单只留 500 个，溢出必然发生）
  r.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  const again = await sync.run()
  assert(again.failed === 0, `★ 重放时冒出了失败：${JSON.stringify(again)}`)
  assert(nOf(r.db, 'review_logs') === 0, '★ 重放把它写进来了')
  assert(
    again.applied + again.skipped + again.failed === again.received,
    `★ 重放时四个数对不上账：${JSON.stringify(again)}`
  )
  r.db.close()
})

checkAsync('★★ C-2 · 老格式的碑（没有 target_id）**现在也拦得住**它的孩子', async () => {
  /**
   * ★★ 这一条的结论被 C-2 翻过来了，值得说清楚为什么不是放松标准。
   *
   * 从前：父级拦截比的是**本地 id**（包里带着 id，而 id 跨设备一致）。
   * V23 之前立的碑没记 id，事后补不出来，所以它们**不参与拦截** ——
   * 那时的选择是「诚实降级」：宁可让那几条子行继续失败重试，也不猜一个 id。
   *
   * C-2 之后包里根本没有 id 了，父级拦截改成比 **`target_uid`**。
   * 而**每一块碑都有 `target_uid`**（它是碑的主身份，从 R-3 第一天就有）——
   * 于是「老碑没有 id」这个残疾自动消失，一条都不用排除在外。
   *
   * 换句话说：这不是把判据放松了，是**换了一把根本不缺零件的尺子**。
   * `target_id` 从此只是本机自己留的一个号码，不参与任何判定。
   */
  const g = await gRun('ga11', async (r) => {
    const u = gUid(r, 'items', 1)
    await purgeItem1(r)
    r.db.prepare(`update tombstones set target_id = null`).run() // 打回老格式
    return [gRevLog(u)]
  })
  assert(g.out.received === 1, '前提：包里该有 1 行')
  assert(
    g.out.skipped === 1 && g.out.failed === 0,
    `★★ 老碑没拦住 —— 那几条子行会永远失败重试：${JSON.stringify(g.out)}`
  )
  assert(g.applied, '★ 全跳过的包该进 applied')
  assert(nOf(g.db, 'review_logs') === 0, '★★ 子行被写进来了')
  g.close()
})

checkAsync('★ R-3-g · ⑫ 只要一块父碑就够 —— 不给几百条子行各立一块', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t0 = Date.now()
  r.db
    .prepare(
      `insert into review_logs (item_id, line, grade, interval_after, ease_after, created_at, updated_at)
       values (1, 'reading', 3, 3, 2.5, ?, ?)`
    )
    .run(t0, t0)
  r.db
    .prepare(
      `insert into answers (item_id, session_id, question_id, text, is_first, grade, created_at, updated_at)
       values (1, null, null, '写的句子', 1, 3, ?, ?)`
    )
    .run(t0, t0)
  await purgeItem1(r)
  const kinds = r.db.prepare(`select kind, count(*) as n from tombstones group by kind`).all() as {
    kind: string
    n: number
  }[]
  assert(
    kinds.every((k) => k.kind === 'items'),
    `★ 给派生行也立了碑：${JSON.stringify(kinds)}`
  )
  assert(
    kinds.length === 1 && kinds[0]!.n === 1,
    `★ 一条知识点立了不止一块碑：${JSON.stringify(kinds)}`
  )
  r.db.close()
})

