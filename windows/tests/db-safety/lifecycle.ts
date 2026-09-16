/**
 * 数据层闭环验收 · R-2 静默生命周期 · N-2 删除 · P-1 学习闭环 · N-1 空状态 · R-1 启动自愈错误分级
 *
 * 原 tests/db-safety.ts 第 4037–5871 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { recoverAll } from '../../src/main/db/recover.ts'
import { MIGRATIONS } from '../../src/main/db/migrations.ts'
import { Exporter, RestoreAborted } from '../../src/main/export.ts'
import { Study } from '../../src/main/study.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { Browse } from '../../src/main/browse.ts'
import { isRowSilent } from '../../src/core/silence.ts'
import { normTerm } from '../../src/main/db/ledger.ts'
import { audit, repair } from '../../src/main/db/audit.ts'
import { factoryReset } from '../../src/main/factory-reset.ts'
import { HEAL_PROBLEM_KEY, isUnsafeDbError, startupHeal, UnsafeDatabase } from '../../src/main/db/startup-heal.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, dbThatFailsOn, simulateStartup, snapshotAll, auditIds, ledgerRows, readyLecture, cardDues } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// 数据层闭环验收 · Data Lifecycle Verification
//
// 上面那些验的是**零件**：这个函数修对了没有、那条检查会不会红。
// 这一节验的是**链**：照真实启动顺序跑一遍、照他的操作路径走一遍，
// 每一步之后跑一次数据体检，看这条链闭不闭合。
//
// 零件全对、链断掉，是这个项目最贵的那种 bug（第九节四例全是这个形状）。
// ══════════════════════════════════════════════════════════════

console.log('\n数据层闭环验收 · 启动 / 状态 / 导回 / 危险操作\n')

/**
 * 照 `src/main/index.ts` 的真实顺序模拟一次启动。
 *
 * **顺序本身是判据的一部分**：
 *   openDatabase（迁移 + 升级前备份 + 迁移自检）
 *     → ensureBuiltins（出厂内容自愈 · I-118）
 *     → recoverAll（状态自愈 · H-1 / N-2 / D-4）
 *
 * 自愈必须排在迁移之后 —— 迁移可能刚建出它要读的表；
 * 也排在 ensureBuiltins 之后 —— 顺序颠倒的话，出厂表被读到的是还没播种的样子。
 * `syncPrompts` 只碰文件不碰库，这里略去。
 */

/**
 * 整库快照 —— 用来证明「再启动一次，一个字都没变」。
 * 排除 `updated_at`：它是同步用的水位，本来就该随写入变；
 * 其余每一列都比。比总数、比状态位都不够 —— 那种比法漏得掉「改了别的字段」。
 */

// ── 闭环 A · 启动自愈的幂等 ────────────────────────────────

check('★★★ I-204 · 认读卡静默了而产出线还在训练：主进程带得出判据、判得对', () => {
  /**
   * ══ 这一条验的是什么 ═══════════════════════════════════
   * 界面判「算不算静默」要 `layer` / `kind` / `productionState` / `cardSilent` 四样。
   * 上一轮四处调用方自己拼了「或」（`productionState==='silent' || cardSilent`），
   * 而领域判据是条件式（跑产出线的只看产出线）。「或」严格更宽 ——
   * **界面把条目藏了，而引擎照样把它排进练习。**
   *
   * ★ 光有 core 的单测不够：**判据要用的字段得真能从主进程拿到**。
   *   `browse.search()` 以前就**不带 `kind`** —— 渲染层拿不到它，
   *   自然只能自己凑一个「或」。所以这一条同时钉两件事：
   *     ① 主进程把四样字段都带出来了
   *     ② 拿这四样过 core 的判据，答案是「不静默」
   *
   * ★ 这个局面**同步真的会造出来**：`items` 与 `reading_cards` 是两张表、两个包、
   *   到达有先后（当晚已见同型：`answers` 先到而父 `sessions` 未到）。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)

  // B 层、chunk —— 跑产出线的那一种
  const b = new Repo(r.db).addItem(1, 'i204 divergent', '', 'B', '').id
  // A 层 —— 不跑产出线的那一种
  const a = new Repo(r.db).addItem(1, 'i204 passive', '', 'A', '').id

  // 造分叉：两条都把认读卡静默掉，产出线一律留在 training
  r.db.prepare(`update reading_cards set silent = 1 where item_id in (?, ?)`).run(b, a)
  r.db.prepare(`update items set production_state = 'training' where id in (?, ?)`).run(b, a)

  const hits = new Browse(r.db).search('i204').items
  const rowB = hits.find((x) => x.id === b)
  const rowA = hits.find((x) => x.id === a)
  assert(rowB !== undefined && rowA !== undefined, `★ 搜不到刚造的两条：${JSON.stringify(hits)}`)

  // ① 四样字段都得在 —— 少一样，渲染层就只能自己凑判据
  for (const [name, row] of [['B 层那条', rowB!], ['A 层那条', rowA!]] as const) {
    for (const f of ['layer', 'kind', 'productionState', 'cardSilent'] as const) {
      assert(
        (row as Record<string, unknown>)[f] !== undefined,
        `★★★ ${name}：主进程没带出 \`${f}\` —— 渲染层判不了静默，只能自己凑一个「或」（I-204 就是这么来的）`
      )
    }
  }

  // ② 过 core 的判据
  assert(
    isRowSilent(rowB!) === false,
    '★★★ B 层：跑产出线的只看产出线。认读卡静默不等于整条静默 —— ' +
      '判成 true 就是旧的「或」，界面会把它藏起来而产出练习照样发它'
  )
  assert(isRowSilent(rowA!) === true, '★★ A 层：不跑产出线的看认读线，认读卡静默了就是静默')

  r.db.close()
})

check('★ 闭环 · 自愈幂等：坏→好，再启动一次 好→好（整库逐列比对）', () => {
  const { db: p, backups } = freshDir()
  {
    const r = openDatabase(p, backups)
    seedTree(r)
    new Repo(r.db).addChunks(1, '我的收集', 'hold sway over')
    // 三类异常各造一个
    r.db.prepare(`update lectures set status='empty', due_at=null where id=1`).run() // N-2
    r.db
      .prepare(`update lectures set status='training', silent=0, due_at=null, interval_days=8 where id=2`)
      .run() // D-4 可修
    r.db.prepare(`update lectures set status='analyzing', due_at=null where id=3`).run() // H-1
    r.db.close()
  }

  const first = simulateStartup(p, backups)
  assert(first.recovered.fixed.length === 3, `第一次该修 3 讲，实际 ${JSON.stringify(first.recovered.fixed)}`)
  const afterFirst = snapshotAll(first.r.db)
  const auditFirst = JSON.stringify(auditIds(first.r.db))
  first.r.db.close()

  const second = simulateStartup(p, backups)
  assert(
    second.recovered.fixed.length === 0,
    `★ 第二次启动又改了：${JSON.stringify(second.recovered.fixed)} —— 自愈不幂等`
  )
  assert(
    Object.keys(second.builtins.filled).length === 0,
    `★ 第二次启动又补了一遍出厂内容：${JSON.stringify(second.builtins.filled)}`
  )
  assert(snapshotAll(second.r.db) === afterFirst, '★ 第二次启动之后整库数据变了 —— 自愈不幂等')
  assert(JSON.stringify(auditIds(second.r.db)) === auditFirst, '两次启动之后体检结论不一致')
  second.r.db.close()
})

check('★ 闭环 · 自愈出错：抛出去，不许悄悄吞掉；已判定的那一批一行都不许半改', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  new Repo(r.db).addChunks(1, '我的收集', 'hold sway over')
  r.db.prepare(`update lectures set status='empty' where id=1`).run()

  // 把留痕表换成写不进去的形状 —— 自愈的每一笔都要留痕，这里必炸
  r.db.exec(`drop table lecture_logs`)
  r.db.exec(`create table lecture_logs (id integer primary key, nope integer not null)`)

  let threw = false
  try {
    recoverAll(r.db)
  } catch {
    threw = true
  }
  /**
   * 为什么「必须抛」是一条正经不变量：**静默降级是这个项目最贵的 bug**。
   * 自愈悄悄失败 = 库里一直坏着、日志里什么都没有、体检报的是别人。
   *
   * 注：抛到 `index.ts` 之后会被当成启动致命错误（fatal 对话框 + 退出）。
   * 那一层的处理是否合适，见本轮报告的 Remaining Risks —— 这里只管它不许被吞。
   */
  assert(threw, '★ 自愈失败被吞掉了 —— 库一直坏着，而日志和体检都不会说')

  const st = (r.db.prepare(`select status from lectures where id=1`).get() as { status: string }).status
  assert(st === 'empty', `★ 留痕失败了，状态却已经改成 ${st} —— 事务没兜住，出现了「改了但没记录」`)
  r.db.close()
})

// ── 闭环 B · 他库里 11 号讲的那个形状 ───────────────────────

check('★ 闭环 · empty+106 条那种讲：启动一次改好，再启动一个字不动', () => {
  const { db: p, backups } = freshDir()
  {
    const r = openDatabase(p, backups)
    seedTree(r)
    const lines = Array.from({ length: 106 }, (_, i) => `expression number ${i}`)
    new Repo(r.db).addChunks(1, '我的收集', lines.join(String.fromCharCode(10)))
    r.db
      .prepare(`update lectures set status='empty', due_at=null, interval_days=0, silent=0 where id=1`)
      .run()
    r.db.close()
  }

  const scale = (d: Database.Database): string =>
    JSON.stringify({
      items: (d.prepare(`select count(*) n from items where deleted_at is null`).get() as { n: number }).n,
      blocks: (d.prepare(`select count(*) n from analysis_blocks`).get() as { n: number }).n,
      occ: (d.prepare(`select count(*) n from occurrences`).get() as { n: number }).n,
      answers: (d.prepare(`select count(*) n from answers`).get() as { n: number }).n,
      logs: (d.prepare(`select count(*) n from review_logs`).get() as { n: number }).n,
      materials: (d.prepare(`select count(*) n from materials`).get() as { n: number }).n
    })

  const ro = new Database(p, { readonly: true })
  const before = scale(ro)
  ro.close()

  const s1 = simulateStartup(p, backups)
  const l1 = s1.r.db
    .prepare(`select status, due_at as d, interval_days as iv, silent from lectures where id=1`)
    .get() as { status: string; d: number | null; iv: number; silent: number }
  assert(l1.status === 'review', `该改成 review，实际 ${l1.status}`)
  assert(l1.d === null, `★ 顺手造出了一个排期：${l1.d} —— 这条修复只该动 status 一个字段`)
  assert(l1.iv === 0, `★ 间隔被动了：${l1.iv}`)
  assert(l1.silent === 0, '★ 静默位被动了')
  assert(scale(s1.r.db) === before, `★ 别的数据被动了：${before} → ${scale(s1.r.db)}`)
  const snap1 = snapshotAll(s1.r.db)
  s1.r.db.close()

  const s2 = simulateStartup(p, backups)
  assert(
    (s2.r.db.prepare(`select status from lectures where id=1`).get() as { status: string }).status ===
      'review',
    '第二次启动状态又变了'
  )
  assert(snapshotAll(s2.r.db) === snap1, '★ 第二次启动动了数据 —— 不幂等')
  assert(scale(s2.r.db) === before, `★ 第二次启动改了别的数据：${before} → ${scale(s2.r.db)}`)
  assert(!auditIds(s2.r.db).includes('empty-with-items'), '修完体检还在报同一条')
  s2.r.db.close()
})

// ── 闭环 C · D-4 的三种形状 ────────────────────────────────

check('★ 闭环 · D-4 甲：有间隔 → 恢复排期，间隔一个字不许改', () => {
  const { db: p, backups } = freshDir()
  {
    const r = openDatabase(p, backups)
    seedTree(r)
    r.db
      .prepare(`update lectures set silent=0, status='training', due_at=null, interval_days=10 where id=1`)
      .run()
    r.db.close()
  }
  const s = simulateStartup(p, backups)
  const l = s.r.db
    .prepare(`select due_at as d, interval_days as iv, status from lectures where id=1`)
    .get() as { d: number | null; iv: number; status: string }
  assert(l.d !== null, '★ 排期没恢复 —— 这一讲永远不进「今日」')
  assert(l.iv === 10, `★ 间隔被改了：10 → ${l.iv}（下一次结算会从错的地方接着扩）`)
  assert(l.status === 'training', `状态被改了：${l.status}`)
  assert(!auditIds(s.r.db).includes('training-without-due'), '修完体检还在报')
  s.r.db.close()
})

check('★ 闭环 · D-4 乙：没有间隔 → 不许猜日期，但必须报出来、软件照常起', () => {
  const { db: p, backups } = freshDir()
  {
    const r = openDatabase(p, backups)
    seedTree(r)
    r.db
      .prepare(`update lectures set silent=0, status='training', due_at=null, interval_days=0 where id=1`)
      .run()
    r.db.close()
  }
  const s = simulateStartup(p, backups)
  const l = s.r.db.prepare(`select due_at as d from lectures where id=1`).get() as { d: number | null }
  assert(l.d === null, '★ 凭空编了一个到期日 —— 那是在制造新的错误数据')
  assert(s.recovered.fixed.every((f) => f.lectureId !== 1), '★ 没有依据却动手改了')
  assert(
    s.recovered.reported?.some((x) => x.lectureId === 1),
    '★ 既没修也没报 —— 悄悄放过去了，他永远不会知道'
  )
  assert(auditIds(s.r.db).includes('training-without-due'), '★ 数据体检里也看不见它')
  s.r.db.close()
})

check('★ 闭环 · D-4 丙：静默 + 无排期是**合法**形态，不许动也不许报', () => {
  const { db: p, backups } = freshDir()
  {
    const r = openDatabase(p, backups)
    seedTree(r)
    r.db
      .prepare(`update lectures set silent=1, status='training', due_at=null, interval_days=5 where id=1`)
      .run()
    r.db.close()
  }
  const s = simulateStartup(p, backups)
  const l = s.r.db.prepare(`select due_at as d, interval_days as iv from lectures where id=1`).get() as {
    d: number | null
    iv: number
  }
  assert(l.d === null, '★ 给归档的讲塞了到期日 —— 归档就是不排期（D-024）')
  assert(l.iv === 5, `间隔被动了：${l.iv}`)
  assert(s.recovered.fixed.every((f) => f.lectureId !== 1), '★ 动了一个本来就合法的状态')
  assert(!auditIds(s.r.db).includes('training-without-due'), '★ 把合法形态误报成异常了')
  s.r.db.close()
})

// ── 闭环 D · 导回之后四层不许互相破坏 ──────────────────────

checkAsync('★ 闭环 · 合法导回 → 迁移 → 出厂自愈 → 状态自愈 → 体检', async () => {
  const { db: p, backups, dir } = freshDir()
  const r0 = openDatabase(p, backups)
  seedTree(r0)
  new Repo(r0.db).addChunks(1, '我的收集', 'hold sway over')
  const good = join(dir, 'good.db')
  new Exporter(r0.db).backupTo(good)
  const want = (r0.db.prepare(`select count(*) n from items where deleted_at is null`).get() as {
    n: number
  }).n

  // 之后把当前库改脏，再从那份好的导回
  r0.db.prepare(`update lectures set status='empty' where id=1`).run()
  await new Exporter(r0.db).restoreFrom(good, p, backups, MIGRATIONS.length)

  const s = simulateStartup(p, backups)
  const n = (s.r.db.prepare(`select count(*) n from items where deleted_at is null`).get() as {
    n: number
  }).n
  assert(n === want, `导回之后条数不对：${want} → ${n}`)
  assert(
    Object.keys(s.builtins.filled).length === 0,
    `★ 导回之后又补了一遍出厂内容：${JSON.stringify(s.builtins.filled)} —— 备份里本来就有，这是重复播种`
  )
  const ids = auditIds(s.r.db)
  assert(!ids.includes('foreign-key-check'), `★ 导回之后外键断了：${ids.join('、')}`)
  assert(!ids.includes('sync-uid-missing'), `★ 导回之后有行没了同步身份：${ids.join('、')}`)
  s.r.db.close()
})

checkAsync('★ 闭环 · 非法导回被挡下之后：原库照常启动、数据一条不少、体检干净', async () => {
  const { db: p, backups, dir } = freshDir()
  const r0 = openDatabase(p, backups)
  seedTree(r0)
  new Repo(r0.db).addChunks(1, '我的收集', 'hold sway over')
  const want = snapshotAll(r0.db)
  const badSrc = join(dir, 'bad.db')
  writeFileSync(badSrc, '这不是数据库', 'utf8')

  let threw = false
  try {
    await new Exporter(r0.db).restoreFrom(badSrc, p, backups, MIGRATIONS.length)
  } catch (err) {
    threw = true
    assert(!(err instanceof RestoreAborted), '★ 在验来源那一步就该拒绝，此时库根本不该被关过')
  }
  assert(threw, '★ 非法来源没被拒绝')
  r0.db.close()

  const s = simulateStartup(p, backups)
  assert(snapshotAll(s.r.db) === want, '★ 只是被拒绝了一次导回，原库的数据却变了')
  assert(auditIds(s.r.db).length === 0, `★ 拒绝之后体检不干净：${auditIds(s.r.db).join('、')}`)
  s.r.db.close()
})

// ── 闭环 E · 危险操作之后体检要干净 ────────────────────────

checkAsync('★ 闭环 · 出厂重置 → 启动 → 出厂内容回来 → 体检干净', async () => {
  const { db: p, backups, dir } = freshDir()
  const r0 = openDatabase(p, backups)
  seedTree(r0)
  new Repo(r0.db).addChunks(1, '我的收集', 'hold sway over')

  const sub = (n: string): string => {
    const d = join(dir, n)
    mkdirSync(d, { recursive: true })
    return d
  }
  const res = await factoryReset({
    db: r0.db,
    paths: {
      root: dir,
      data: dir,
      backups,
      audio: sub('audio'),
      logs: sub('logs'),
      prompts: sub('prompts'),
      shippedPrompts: sub('shipped'),
      dicts: sub('dicts'),
      resources: dir,
      db: p
    },
    clearSession: async () => {}
  })
  assert(res.ok, `重置有步骤失败：${res.steps.filter((x) => !x.ok).map((x) => x.name).join('、')}`)
  r0.db.close()

  const s = simulateStartup(p, backups)
  for (const t of ['tutors', 'genres', 'qtypes', 'prompt_presets']) {
    const n = (s.r.db.prepare(`select count(*) n from "${t}"`).get() as { n: number }).n
    assert(n > 0, `★ 重置之后 ${t} 还是空的 —— 「恢复出厂」比全新安装还差（I-118）`)
  }
  assert(auditIds(s.r.db).length === 0, `★ 重置 + 启动之后体检不干净：${auditIds(s.r.db).join('、')}`)
  // 再启动一次，不许重复播种
  s.r.db.close()
  const s2 = simulateStartup(p, backups)
  assert(
    Object.keys(s2.builtins.filled).length === 0,
    `★ 又补了一遍出厂内容：${JSON.stringify(s2.builtins.filled)} —— 会变成两套导师`
  )
  s2.r.db.close()
})

check('★ 闭环 · 静默来回一趟：排期回得来，体检两头都干净', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  r.db
    .prepare(`update lectures set status='training', silent=0, due_at=?, interval_days=6 where id=1`)
    .run(Date.now() + 6 * 86400000)

  repo.setSilent('lecture', 1, true)
  assert(auditIds(r.db).length === 0, `静默之后体检不干净：${auditIds(r.db).join('、')}`)
  repo.setSilent('lecture', 1, false)
  const l = r.db.prepare(`select due_at as d, interval_days as iv from lectures where id=1`).get() as {
    d: number | null
    iv: number
  }
  assert(l.d !== null, '★ 取消静默之后没有排期 —— 那一讲再也不进「今日」（D-4 原病）')
  assert(l.iv === 6, `★ 间隔被动了：${l.iv}`)
  assert(auditIds(r.db).length === 0, `取消静默之后体检不干净：${auditIds(r.db).join('、')}`)
  assert(recoverAll(r.db).fixed.length === 0, '★ 走完合法流程的讲，被自愈当成异常改了')
  r.db.close()
})

check('★ 闭环 · 学习 → 结算：间隔往前走、排期跟着推，体检干净、自愈不插手', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
  study.startLearning(1)
  const iv0 = (r.db.prepare(`select interval_days as iv from lectures where id=1`).get() as { iv: number }).iv

  const t = Date.now()
  const newSession = (): number =>
    Number(
      r.db
        .prepare(
          `insert into sessions (kind, scope, target, started_at, created_at, updated_at)
           values ('production','lecture',1,?,?,?)`
        )
        .run(t, t, t).lastInsertRowid
    )
  const ins = r.db.prepare(
    `insert into answers (session_id, item_id, question_id, attempt_no, is_first, text, grade,
                          hinted, created_at, updated_at)
     values (?, ?, null, 1, 1, 'x', ?, 0, ?, ?)`
  )

  /**
   * 先验 D-139 那道闸：**样本太小就不许动间隔**。
   * 拿 2 条的正确率去决定一整讲的排期是拿噪音当信号 ——
   * 这一条比「间隔会长」更容易在重构里被顺手改掉，所以先钉住它。
   */
  const small = newSession()
  ins.run(small, 1, 4, t, t)
  ins.run(small, 2, 4, t, t)
  study.settle(1, small)
  assert(
    (r.db.prepare(`select interval_days as iv from lectures where id=1`).get() as { iv: number }).iv ===
      iv0,
    '★ 只练了 2 条就把间隔往前推了 —— D-139 那道闸没生效'
  )

  // 够样本了（≥5）再结算一次
  const ids = new Repo(r.db).addChunks(1, '我的收集', ['aaa bbb', 'ccc ddd', 'eee fff', 'ggg hhh', 'iii jjj', 'kkk lll'].join(String.fromCharCode(10))).added
  const sid = newSession()
  for (const it of ids) ins.run(sid, it.id, 4, t, t)

  const s = study.settle(1, sid)
  assert(s.perLecture.length === 1, `结算没算到这一讲：${JSON.stringify(s.perLecture)}`)
  const l = r.db
    .prepare(`select status, due_at as d, interval_days as iv from lectures where id=1`)
    .get() as { status: string; d: number | null; iv: number }
  assert(l.status === 'training', `结算之后状态变了：${l.status}`)
  assert(l.iv > iv0, `★ 全答对却没往前走：${iv0} → ${l.iv}`)
  assert(l.d !== null && l.d > t, '★ 结算之后排期没往后推 —— 明天还会问一遍同样的东西')
  assert(
    (r.db.prepare(`select finished_at as f from sessions where id=?`).get(sid) as { f: number | null })
      .f !== null,
    '这一场没有收尾时间 —— 报告里它会一直算「进行中」'
  )
  assert(auditIds(r.db).length === 0, `结算之后体检不干净：${auditIds(r.db).join('、')}`)

  const before = snapshotAll(r.db)
  assert(recoverAll(r.db).fixed.length === 0, '★ 自愈动了一条刚正常结算完的讲')
  assert(snapshotAll(r.db) === before, '★ 自愈改了正常数据')
  r.db.close()
})

check('★ 闭环 · 一条讲走完 empty → review → training，每一步体检都干净', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
  const repo = new Repo(r.db)

  // ① empty —— seedTree 的 3 号本来就没有知识点
  r.db.prepare(`update lectures set status='empty', due_at=null, interval_days=0 where id=3`).run()
  r.db.prepare(`delete from item_lectures where lecture_id=3`).run()
  r.db.prepare(`update items set deleted_at=? where id=3`).run(Date.now())
  assert(auditIds(r.db).length === 0, `empty 这一步体检不干净：${auditIds(r.db).join('、')}`)
  assert(recoverAll(r.db).fixed.length === 0, '★ 空讲被自愈动了')

  // ② 有内容 → review
  repo.addChunks(3, '我的收集', 'a stone throw from')
  r.db.prepare(`update lectures set status='review' where id=3`).run()
  assert(auditIds(r.db).length === 0, `review 这一步体检不干净：${auditIds(r.db).join('、')}`)

  // ③ 真的走一次 startLearning → training
  study.startLearning(3)
  const l = r.db
    .prepare(`select status, due_at as d, interval_days as iv from lectures where id=3`)
    .get() as { status: string; d: number | null; iv: number }
  assert(l.status === 'training', `startLearning 之后不是 training：${l.status}`)
  assert(l.d !== null, '★ training 却没有排期 —— 今日队列要两者同时成立')
  assert(l.iv === 1, `首轮间隔该是 1，实际 ${l.iv}`)
  assert(auditIds(r.db).length === 0, `training 这一步体检不干净：${auditIds(r.db).join('、')}`)

  // ④ 走完全程的这一讲，自愈不许碰它
  const before = snapshotAll(r.db)
  assert(recoverAll(r.db).fixed.length === 0, '★ 自愈动了一条正常走完流程的讲')
  assert(snapshotAll(r.db) === before, '★ 自愈改了正常数据')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// R-2 · 静默的完整数据生命周期
//
// 病根不是「某个函数写错了」，是**同一个业务动作有两份实现**：
// 项目栏右键走 `setSilent`（联动条目、取消时恢复排期），
// 工作台那颗按钮走 `silenceLecture`（只翻 silent 位）。
// 两份都各自「正确」，错的是它们之间的差。
//
// 所以这一节验的不只是「现在对了」，还有**「以后不会再长出第二份」**。
// ══════════════════════════════════════════════════════════════

console.log('\nR-2 · 静默的完整数据生命周期\n')

/** 逐表快照 —— 用来断言「除了该变的那两张表，别的一个字没动」 */
function snapshotByTable(db: Database.Database): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of (
    db
      .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((x) => x.name)) {
    const cols = (db.prepare(`pragma table_info("${t}")`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c !== 'updated_at')
    if (cols.length === 0) continue
    out[t] = JSON.stringify(
      db.prepare(`select ${cols.map((c) => `"${c}"`).join(',')} from "${t}" order by rowid`).all()
    )
  }
  return out
}

const changedTables = (a: Record<string, string>, b: Record<string, string>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort()

/** 一条走到 training 的讲，带条目、带认读卡、带一次学习记录 */
function silenceFixture(): {
  r: ReturnType<typeof openDatabase>
  repo: Repo
  study: Study
  p: string
  backups: string
} {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
  study.startLearning(1) // 1 号讲：training + due_at + 两条条目拿到 card_due_at
  // 留一条真的学习记录，后面要断言它一个字不动
  const t = Date.now()
  r.db
    .prepare(
      `insert into review_logs (item_id, line, grade, interval_after, ease_after, created_at, updated_at)
       values (1, 'reading', 3, 2, 2.5, ?, ?)`
    )
    .run(t, t)
  r.db
    .prepare(
      `update items set attempts = 4, corrects = 3, streak = 2,
                        updated_at = ? where id in (1,2)`
    )
    .run(t)
  r.db
    .prepare(`update reading_cards set interval_days = 2, ease = 2.5, updated_at = ? where item_id in (1,2)`)
    .run(t)
  return { r, repo, study, p, backups }
}

/** 学习记录的全部载体 —— 静默前后必须逐字相同 */
const learningRecord = (db: Database.Database): string =>
  JSON.stringify({
    reviewLogs: db.prepare(`select * from review_logs order by id`).all(),
    answers: db.prepare(`select * from answers order by id`).all(),
    sessions: db.prepare(`select * from sessions order by id`).all(),
    progress: db
      .prepare(
        `select i.id, i.attempts, i.corrects, i.streak, i.attempts_in_stage as ais,
                rc.interval_days as ci, rc.ease as ce, rc.reps as cr, rc.lapses as cl
           from items i join reading_cards rc on rc.item_id = i.id order by i.id`
      )
      .all()
  })

// ── ④⑤ training 讲：静默 → 取消静默 ────────────────────────

check('★ R-2 · training 讲静默：停排期 · 条目跟着进静默库 · 学习记录一个字不动', () => {
  const { r, repo, study } = silenceFixture()
  const rec0 = learningRecord(r.db)
  const snap0 = snapshotByTable(r.db)
  const iv0 = (r.db.prepare(`select interval_days as iv from lectures where id=1`).get() as { iv: number }).iv

  repo.setSilent('lecture', 1, true)

  const l = r.db.prepare(`select silent, due_at as d, status, interval_days as iv from lectures where id=1`).get() as
    { silent: number; d: number | null; status: string; iv: number }
  assert(l.silent === 1, '静默位没置上')
  assert(l.d === null, '★ 静默了还排着到期日 —— 归档了还在催他练')
  assert(l.status === 'training', `★ 静默改了状态：${l.status} —— 静默是正交的位，不是第五种状态`)
  assert(l.iv === iv0, `★ interval_days 被动了：${iv0} → ${l.iv}`)

  // ⑧ 条目跟着进静默库
  const its = r.db
    .prepare(
      `select i.id, i.production_state as st, rc.silent as cs, i.silenced_by as by
         from items i join reading_cards rc on rc.item_id = i.id
        where i.deleted_at is null
          and i.id in (select item_id from item_lectures where lecture_id=1)
        order by i.id`
    )
    .all() as { id: number; st: string; cs: number; by: string | null }[]
  assert(its.length > 0, 'fixture 没条目')
  assert(
    its.every((x) => x.st === 'silent' && x.cs === 1 && x.by === 'lecture'),
    `★ 条目没跟着静默：${JSON.stringify(its)} —— 这正是工作台那条路的病`
  )

  // ⑪ 学习记录一个字不动
  assert(learningRecord(r.db) === rec0, '★ 静默动了学习记录 —— 静默是「不再轮转」，不是「清零重来」')
  /**
   * 只有这三张表该变。
   * ★ D-296（V34）· `reading_cards` 是新加的那一张 —— 认读线的静默位
   *   从 `items.card_silent` 搬过去了，所以它当然要跟着变。
   *   两条 UPDATE 在同一个事务里（`db/repo.ts`），不会只动一半。
   */
  assert(
    JSON.stringify(changedTables(snap0, snapshotByTable(r.db))) ===
      JSON.stringify(['items', 'lectures', 'reading_cards']),
    `★ 静默还动了别的表：${changedTables(snap0, snapshotByTable(r.db)).join('、')}`
  )
  assert(auditIds(r.db).length === 0, `静默之后体检不干净：${auditIds(r.db).join('、')}`)
  void study
  r.db.close()
})

check('★ R-2 · training 讲取消静默：排期回得来 · 条目放出来 · 进度不清零', () => {
  const { r, repo } = silenceFixture()
  const iv0 = (r.db.prepare(`select interval_days as iv from lectures where id=1`).get() as { iv: number }).iv
  repo.setSilent('lecture', 1, true)
  const rec0 = learningRecord(r.db)
  const t0 = Date.now()

  repo.setSilent('lecture', 1, false)

  const l = r.db.prepare(`select silent, due_at as d, status, interval_days as iv from lectures where id=1`).get() as
    { silent: number; d: number | null; status: string; iv: number }
  assert(l.silent === 0, '静默位没放下')
  assert(l.d !== null, '★ 取消静默之后没有排期 —— 那一讲再也不进「今日」（R-2 的核心症状）')
  assert(l.d >= t0, `★ 恢复的排期不是「立刻可练」：${l.d}`)
  assert(l.iv === iv0, `★ interval_days 被动了：${iv0} → ${l.iv} —— 下次结算会从错的地方接着扩`)
  assert(l.status === 'training', `状态被动了：${l.status}`)

  const its = r.db
    .prepare(
      `select i.production_state as st, rc.silent as cs, i.silenced_by as by, rc.due_at as cd
         from items i join reading_cards rc on rc.item_id = i.id
        where i.deleted_at is null
          and i.id in (select item_id from item_lectures where lecture_id=1) order by i.id`
    )
    .all() as { st: string; cs: number; by: string | null; cd: number | null }[]
  assert(
    its.every((x) => x.st === 'training' && x.cs === 0 && x.by === null && x.cd !== null),
    `★ 条目没被放出来：${JSON.stringify(its)}`
  )
  // 进度字段不许因为出入静默库而清零
  assert(learningRecord(r.db) === rec0, '★ 取消静默动了学习记录 / 进度')
  assert(auditIds(r.db).length === 0, `取消静默之后体检不干净：${auditIds(r.db).join('、')}`)
  r.db.close()
})

// ── ⑥⑦ review / empty 讲不许凭空产生排期 ──────────────────

// `empty` 必须挑一条**真的没有条目**的讲（seedTree 的 2 号）——
// 拿有条目的讲假装 empty，体检会当场报 empty-with-items，那是夹具不真实
for (const [st, id] of [
  ['review', 1],
  ['empty', 2]
] as const) {
  check(`★ R-2 · ${st} 讲静默 → 取消：不许凭空造出 training 的排期`, () => {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    const repo = new Repo(r.db)
    r.db.prepare(`update lectures set status=?, due_at=null, interval_days=0 where id=?`).run(st, id)

    repo.setSilent('lecture', id, true)
    const a = r.db.prepare(`select silent, due_at as d, status from lectures where id=?`).get(id) as
      { silent: number; d: number | null; status: string }
    assert(a.silent === 1 && a.d === null && a.status === st, `静默这一步就不对：${JSON.stringify(a)}`)

    repo.setSilent('lecture', id, false)
    const b = r.db.prepare(`select silent, due_at as d, status, interval_days as iv from lectures where id=?`).get(id) as
      { silent: number; d: number | null; status: string; iv: number }
    assert(b.silent === 0, '静默位没放下')
    assert(
      b.d === null,
      `★ ${st} 的讲被塞了一个到期日 —— 它会带着「没审阅过 / 没内容」的身份冒进今日队列`
    )
    assert(b.status === st, `状态被动了：${b.status}`)
    assert(b.iv === 0, `interval_days 被动了：${b.iv}`)
    assert(auditIds(r.db).length === 0, `体检不干净：${auditIds(r.db).join('、')}`)
    r.db.close()
  })
}

// ── ⑫⑬ 认读队列 ───────────────────────────────────────────

check('★ R-2 · 静默之后认读队列不再有那些条目，取消之后回得来（工作台那条路原来一张都没少）', () => {
  const { r, repo, study } = silenceFixture()
  const before = study.dueCards(1, 200).length
  assert(before > 0, 'fixture 里认读队列是空的，这条用例验不到东西')

  repo.setSilent('lecture', 1, true)
  const during = study.dueCards(1, 200).length
  assert(
    during === 0,
    `★ 静默之后认读队列还剩 ${during} 张（静默前 ${before} 张）—— 界面写着「不再排进今日练习」，却照常考他`
  )

  repo.setSilent('lecture', 1, false)
  const after = study.dueCards(1, 200).length
  assert(after === before, `★ 取消静默之后认读队列没回来：${before} → ${after}`)
  r.db.close()
})

// ── 防复发：不许再长出第二个入口 ───────────────────────────

check('★★ R-2 负向对照 · Repo 上不许再出现第二个「静默一讲」的方法', () => {
  /**
   * 这条守的不是某个字段，是**「同一个业务规则只能有一份实现」这条原则本身**。
   *
   * 被删掉的 `silenceLecture` 当初也是「顺手加一个更简单的」加出来的，
   * 两份各自看着都对，差别只在没人比过的地方。
   * 所以判据放在方法名这一层：Repo 上除了 `setSilent`，
   * 不许再有别的名字承担「把一讲静默掉」这件事。
   */
  const names = Object.getOwnPropertyNames(Repo.prototype)
    .filter((n) => /silence|silent/i.test(n))
    .sort()
  /**
   * `silentTree` 留着是因为它**只读** —— 静默知识库那一页靠它列出被藏起来的东西
   * （藏起来却没有出口就是个陷阱）。它不写任何字段，长不出第二套语义。
   * 会写的只许有 `setSilent` 一个。
   */
  assert(
    JSON.stringify(names) === JSON.stringify(['setSilent', 'silentTree']),
    `★ Repo 上和静默有关的方法只该有 setSilent（写）和 silentTree（只读），实际有：${names.join('、')}`
  )
})

// ══════════════════════════════════════════════════════════════
// N-2 · 「我不要这个说法」是一条持久、唯一、一致的业务事实
//
// 以前两个删除入口各写各的：逐条 ✕ 只软删，勾选批量删还会往 term_ledger
// 记一笔 deleted。而账本正是「以后 AI 别再收它」的载体（4.1）——
// 同一个动作产生了两种长期结果。更糟的是那个 ✕ 只在 review 时渲染，
// 也就是他审阅一批新分析结果、逐条剔掉不要的那一刻。
// ══════════════════════════════════════════════════════════════

console.log('\nN-2 · 删除是一条持久、唯一、一致的业务事实\n')

/**
 * ★★ R-3-e · 这条判定**现在还算不算数**。
 *
 * 撤销之后行还留着（它是「我改主意了」传到另一台设备的载体），
 * 所以「行在不在」已经不是判据了 —— 判据是 `verdictOf`，
 * 那是全项目唯一读账本做判断的地方。用例也必须跟着用它，
 * 否则验的是库里的形状，不是软件的行为。
 */
const liveVerdicts = (db: Database.Database, term: string): string[] =>
  (
    db
      .prepare(
        `select verdict from term_ledger where norm = ? and revoked_at is null order by verdict`
      )
      .all(normTerm(term)) as { verdict: string }[]
  ).map((r) => r.verdict)

// ── 两个入口必须产生同样的结果 ─────────────────────────────

check('★★ N-2 · 单条删除和批量删除，除 id 外逐表完全一致', () => {
  const shot = (useBulk: boolean): string => {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    const added = new Repo(r.db).addChunks(1, '我的收集', ['alpha one', 'beta two'].join(String.fromCharCode(10))).added
    const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
    if (useBulk) study.bulkDelete([added[0]!.id])
    else study.deleteItem(added[0]!.id)
    /**
     * 时间戳要归一化成「删了没有」。
     * 两次夹具是先后跑的，`deleted_at` 差几十毫秒 —— 那不是语义差异，
     * 拿它判不一致会红在一件与业务无关的事情上（第一版就是这样）。
     */
    const out = JSON.stringify({
      items: (
        r.db.prepare(`select term, deleted_at as d from items order by term`).all() as {
          term: string
          d: number | null
        }[]
      ).map((x) => ({ term: x.term, deleted: x.d !== null })),
      ledger: r.db.prepare(`select norm, verdict, scope from term_ledger order by norm`).all(),
      rel: r.db.prepare(`select item_id, lecture_id from item_lectures order by item_id`).all(),
      occ: r.db.prepare(`select item_id, quote from occurrences order by item_id`).all()
    })
    r.db.close()
    return out
  }
  const single = shot(false)
  const bulk = shot(true)
  assert(
    single === bulk,
    `★ 两个入口的结果不一样 —— 同一个意图产生了两种长期数据：\n  单条：${single}\n  批量：${bulk}`
  )
  assert(single.includes('"verdict":"deleted"'), '★ 两个入口都没往账本记「我不要这个说法」')
})

check('★ N-2 · 重复删除同一条：账本只有一行（本地幂等）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const added = new Repo(r.db).addChunks(1, '我的收集', 'alpha one').added
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
  study.deleteItem(added[0]!.id)
  const one = ledgerRows(r.db)
  study.deleteItem(added[0]!.id)
  study.bulkDelete([added[0]!.id])
  assert(ledgerRows(r.db) === one, `★ 重复删除把账本写重了：${ledgerRows(r.db)}`)
  r.db.close()
})

check('★★ N-2 · 账本写不进去 → deleted_at 一起回滚', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const added = new Repo(r.db).addChunks(1, '我的收集', 'alpha one').added
  const before = JSON.stringify(r.db.prepare(`select id, deleted_at as d from items order by id`).all())

  const boom = dbThatFailsOn(r.db, 'into term_ledger')
  let threw = false
  try {
    new Study(boom, join(backups, 'prompts'), () => 'B2').deleteItem(added[0]!.id)
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没炸')
  assert(
    JSON.stringify(r.db.prepare(`select id, deleted_at as d from items order by id`).all()) === before,
    '★ 账本没记上，条目却已经删了 —— 那正是「删了还会回来」的形状'
  )
  assert(!r.db.inTransaction, '★ 回滚之后还留在事务里')
  r.db.close()
})

check('★★ N-2 · 删整讲 / 删项目**不许**写「我不要这个说法」', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  repo.addChunks(1, '我的收集', ['alpha one', 'beta two'].join(String.fromCharCode(10)))
  new Browse(r.db).deleteLecture(1)
  assert(
    ledgerRows(r.db) === '[]',
    `★ 删掉一讲把它的表达全部拉黑了 —— 他完全看不出为什么（I-119 就是这个形状）：${ledgerRows(r.db)}`
  )
  repo.softDelete('project', 1)
  assert(ledgerRows(r.db) === '[]', `★ 删项目也拉黑了：${ledgerRows(r.db)}`)
  r.db.close()
})

// ── 恢复只撤 deleted ───────────────────────────────────────

check('★★ N-2-b · 先静默、再删、再恢复 → 「我已经会了」那条账必须还在', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const added = new Repo(r.db).addChunks(1, '我的收集', 'alpha one').added
  const id = added[0]!.id
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')

  study.bulkSilence([id], true) // → 账本 silenced
  study.deleteItem(id) // → 账本 deleted
  const both = ledgerRows(r.db)
  assert(both.includes('silenced') && both.includes('deleted'), `前提没成立：${both}`)

  new Browse(r.db).restore('item', id)
  const live = liveVerdicts(r.db, 'alpha one')
  const after = ledgerRows(r.db)
  assert(!live.includes('deleted'), `★ 恢复了却没撤销「我不要」：${after}`)
  assert(
    live.includes('silenced'),
    `★ 恢复顺手把「我已经会了」也擦掉了 —— 它会重新排进轮转，而他只会觉得「静默怎么又失效了」：${after}`
  )
  /**
   * ★ R-3-e · 撤销之后那一行**必须还在**（带着撤销标记）——
   * 删掉的话，这条「我改主意了」就传不到另一台设备上，
   * 而那正是 R-3-e 要修的病。
   */
  assert(
    after.includes('"verdict":"deleted","scope":"global","l":null,"revoked":1'),
    `★★ 撤销把行删掉了 —— 这条撤销从此传不出去：${after}`
  )
  r.db.close()
})

checkAsync('★ N-2-b · purged 那条账不许被别人的恢复顺手擦掉', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const added = new Repo(r.db).addChunks(1, '我的收集', ['alpha one', 'beta two'].join(String.fromCharCode(10))).added
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
  const browse = new Browse(r.db)

  // 第一条彻底删掉（→ purged），第二条只是删掉（→ deleted）
  study.deleteItem(added[0]!.id)
  await browse.purgeMany([{ kind: 'item', id: added[0]!.id }])
  study.deleteItem(added[1]!.id)
  assert(ledgerRows(r.db).includes('purged'), `前提没成立：${ledgerRows(r.db)}`)

  browse.restore('item', added[1]!.id)
  assert(
    ledgerRows(r.db).includes('purged'),
    `★ 恢复第二条把第一条的「彻底删除」记录也擦了：${ledgerRows(r.db)}`
  )
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// P-1 · 学习闭环：原子性 · 幂等 · 前置条件
//
// 三个函数以前一个事务都没有，而它们正好是学习闭环的全部：
//   startLearning（进轮转）· submitAnswer（判分落库）· settleLectures（整场结算）
// 半途失败留下的形状全部合法（status/due_at 都在），只是数字错了 ——
// recoverAll 三条规则和 audit 22 项没有一条查得到。
// ══════════════════════════════════════════════════════════════

console.log('\nP-1 · 学习闭环：原子性 · 幂等 · 前置条件\n')

/** 一条走到 review、带条目的讲 */

/** 这一讲的调度位 —— 断言「一个字没动」用 */
const schedule = (db: Database.Database, id: number): string =>
  JSON.stringify(
    db.prepare(`select status, due_at as d, interval_days as iv from lectures where id=?`).get(id)
  )

/** 这一讲全部条目的认读排期 */

// ── startLearning ──────────────────────────────────────────

check('★ P-1 · review → training 正常：排期、间隔、认读卡一起就位', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  readyLecture(r, 1)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')

  const out = study.startLearning(1)
  assert(out.refused === null, `正常路径不该被拒绝：${out.refused}`)
  const l = r.db.prepare(`select status, due_at as d, interval_days as iv from lectures where id=1`).get() as
    { status: string; d: number | null; iv: number }
  assert(l.status === 'training' && l.d !== null && l.iv === 1, `进轮转不对：${JSON.stringify(l)}`)
  assert(
    !cardDues(r.db, 1).includes('"cd":null'),
    `★ 有条目没拿到认读排期 —— 认读队列会是空的：${cardDues(r.db, 1)}`
  )
  assert(auditIds(r.db).length === 0, `体检不干净：${auditIds(r.db).join('、')}`)
  r.db.close()
})

check('★★ P-1 · training 讲再调一次 startLearning：一个字都不许改（I-2）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  readyLecture(r, 1)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
  study.startLearning(1)
  // 假装已经练了几轮，间隔扩到 12 天
  r.db.prepare(`update lectures set interval_days=12, due_at=? where id=1`).run(Date.now() + 12 * 86400000)
  const before = schedule(r.db, 1)
  const cards = cardDues(r.db, 1)
  const logs = (r.db.prepare(`select count(*) n from lecture_logs`).get() as { n: number }).n

  const again = study.startLearning(1)
  assert(again.refused === 'alreadyRunning', `★ 后端没拦住，或者说错了理由：${again.refused}`)
  assert(
    schedule(r.db, 1) === before,
    `★ 进度被清零了：${before} → ${schedule(r.db, 1)} —— 12 天的间隔被打回 1 天`
  )
  assert(cardDues(r.db, 1) === cards, '★ 认读排期被动了')
  assert(
    (r.db.prepare(`select count(*) n from lecture_logs`).get() as { n: number }).n === logs,
    '★ 被拒绝了却还是记了一笔「审阅完成」'
  )
  r.db.close()
})

for (const st of ['empty', 'analyzing'] as const) {
  check(`★ P-1 · ${st} 状态调 startLearning：不许破坏数据`, () => {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    readyLecture(r, 1)
    r.db.prepare(`update lectures set status=? where id=1`).run(st)
    const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
    const before = schedule(r.db, 1)
    const cards = cardDues(r.db, 1)

    const out = study.startLearning(1)
    assert(out.refused !== null, `★ ${st} 竟然被当成可以开始学习`)
    assert(schedule(r.db, 1) === before, `★ ${st} 的调度位被动了`)
    assert(cardDues(r.db, 1) === cards, `★ ${st} 的认读排期被动了`)
    r.db.close()
  })
}

check('★★ P-1 · startLearning 中途 SQL 失败 → 整个事务回滚', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  readyLecture(r, 1)
  const before = schedule(r.db, 1)
  const cards = cardDues(r.db, 1)

  // 让「给认读卡排期」那一句炸 —— 它排在 lectures 更新之后
  // 针要挑一段**不像完整语句**的：check:sql 会把 `update items set …` 当成真 SQL 去校列名
  // ★ 故意不以 `update` 开头：check:sql 会把「以 update 开头且没有 where」的字符串
  //   当成一条真 SQL 继续往下解析，把后面的 JS 变量名读成列名（实测 13 处误报）
  const boom = dbThatFailsOn(r.db, 'set due_at = ?, updated_at = ?')
  let threw = false
  try {
    new Study(boom, join(backups, 'prompts'), () => 'B2').startLearning(1)
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没炸')
  assert(
    schedule(r.db, 1) === before,
    `★ 讲已经进了轮转，条目却一张认读卡都没排 —— 他会以为「开始学」没用：${schedule(r.db, 1)}`
  )
  assert(cardDues(r.db, 1) === cards, '★ 认读排期留下了半截')
  assert(!r.db.inTransaction, '★ 回滚之后还留在事务里')
  r.db.close()
})

// ── settleLectures ─────────────────────────────────────────

/** 铺一场练习：n 讲各自 training，answers 挂在同一个 session 上 */
function practiceFixture(
  r: ReturnType<typeof openDatabase>,
  lectureIds: number[]
): { sessionId: number; study: Study } {
  const t = Date.now()
  const study = new Study(r.db, 'prompts', () => 'B2')
  const sessionId = Number(
    r.db
      .prepare(
        `insert into sessions (kind, scope, target, started_at, created_at, updated_at)
         values ('production','mixed',0,?,?,?)`
      )
      .run(t, t, t).lastInsertRowid
  )
  const ins = r.db.prepare(
    `insert into answers (session_id, item_id, question_id, attempt_no, is_first, text, grade,
                          hinted, created_at, updated_at)
     values (?, ?, null, 1, 1, 'x', 4, 0, ?, ?)`
  )
  for (const id of lectureIds) {
    // 每讲 6 条（≥ D-139 的 minSample=5），全对
    const added = new Repo(r.db).addChunks(
      id,
      '我的收集',
      Array.from({ length: 6 }, (_, i) => `lec${id} phrase ${i}`).join(String.fromCharCode(10))
    ).added
    for (const it of added) ins.run(sessionId, it.id, t, t)
    r.db
      .prepare(`update lectures set status='training', interval_days=4, due_at=? where id=?`)
      .run(t, id)
  }
  return { sessionId, study }
}

check('★ P-1 · 三讲正常结算：各自扩张一次，session 收尾时间写上', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { sessionId, study } = practiceFixture(r, [1, 2, 3])

  const s = study.settleLectures([1, 2, 3], sessionId)
  assert(s.perLecture.length === 3, `该算三讲，实际 ${s.perLecture.length}`)
  for (const id of [1, 2, 3]) {
    const l = r.db.prepare(`select interval_days as iv, due_at as d from lectures where id=?`).get(id) as
      { iv: number; d: number | null }
    assert(l.iv > 4, `第 ${id} 讲的间隔没扩张：${l.iv}`)
    assert(l.d !== null, `第 ${id} 讲没有排期`)
  }
  assert(
    (r.db.prepare(`select finished_at as f from sessions where id=?`).get(sessionId) as { f: number | null })
      .f !== null,
    '★ 结算完了 session 还是「进行中」'
  )
  r.db.close()
})

check('★★ P-1 · 第二讲失败 → 三讲全部回滚（整场是一个原子动作）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { sessionId, study: _s } = practiceFixture(r, [1, 2, 3])
  void _s
  const before = [1, 2, 3].map((id) => schedule(r.db, id)).join('|')

  // 让写 practiced 日志那一句炸 —— 它在每讲的循环里
  const boom = dbThatFailsOn(r.db, `values (?, ?, ?, ?, ?)`)
  let threw = false
  try {
    new Study(boom, 'prompts', () => 'B2').settleLectures([1, 2, 3], sessionId)
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没炸')
  assert(
    [1, 2, 3].map((id) => schedule(r.db, id)).join('|') === before,
    '★ 出现了半结算：一部分讲已经扩张、另一部分没有'
  )
  assert(
    (r.db.prepare(`select finished_at as f from sessions where id=?`).get(sessionId) as { f: number | null })
      .f === null,
    '★ 结算失败了，session 却标成已完成 —— 下次重试会被幂等挡掉，这一场就永远结算不了'
  )
  assert(
    (r.db.prepare(`select count(*) n from lecture_logs where event='practiced'`).get() as { n: number }).n ===
      0,
    '★ 留下了 practiced 日志'
  )
  assert(!r.db.inTransaction, '★ 回滚之后还留在事务里')
  r.db.close()
})

check('★★ P-1 · settle 两次：第二次一个业务字段都不许动（幂等）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { sessionId, study } = practiceFixture(r, [1, 2])

  const first = study.settleLectures([1, 2], sessionId)
  const after1 = [1, 2].map((id) => schedule(r.db, id)).join('|')
  const logs1 = (r.db.prepare(`select count(*) n from lecture_logs where event='practiced'`).get() as {
    n: number
  }).n

  const second = study.settleLectures([1, 2], sessionId)
  assert(
    [1, 2].map((id) => schedule(r.db, id)).join('|') === after1,
    `★ 第二次结算又把间隔扩了一次 —— 下次到期日凭空推后：\n  ${after1}\n  ${[1, 2].map((id) => schedule(r.db, id)).join('|')}`
  )
  assert(
    (r.db.prepare(`select count(*) n from lecture_logs where event='practiced'`).get() as { n: number }).n ===
      logs1,
    '★ 第二次结算又记了一笔 practiced'
  )
  // 展示用的统计仍然给得出来 —— 重试之后他还是要看得到结算页
  assert(second.sample === first.sample, `重试之后统计变了：${first.sample} → ${second.sample}`)
  assert(second.perLecture.length === 2, '重试之后结算页没有内容了')
  assert(
    second.perLecture.every((x) => x.reason.includes('已经结算过')),
    `没说清这是重试：${JSON.stringify(second.perLecture.map((x) => x.reason))}`
  )
  r.db.close()
})

check('★★ P-1 · 连着调两次（模拟双击）：仍然只结算一次', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { sessionId, study } = practiceFixture(r, [1])

  /**
   * better-sqlite3 是**同步**的，主进程也是单线程 —— 两次 IPC 调用之间
   * 不存在交错：第一次整段跑完，第二次才开始。所以「并发」在这里
   * 退化成「连着调两次」，而判据是同一条：结果只有一份。
   * 「检查 finished_at + 写入」还在同一个 immediate 事务里，
   * 所以就算将来真有第二个写者（另一个进程），也没有可乘之机。
   */
  study.settleLectures([1], sessionId)
  const after1 = schedule(r.db, 1)
  study.settleLectures([1], sessionId)
  assert(schedule(r.db, 1) === after1, `★ 第二次调用改了排期：${after1} → ${schedule(r.db, 1)}`)
  assert(
    (r.db.prepare(`select count(*) n from lecture_logs where event='practiced'`).get() as { n: number }).n ===
      1,
    '★ 一场 session 记了两笔结算'
  )
  r.db.close()
})

check('★ P-1 · finished_at 写失败 → 整场回滚，间隔一个字不动', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { sessionId } = practiceFixture(r, [1, 2])
  const before = [1, 2].map((id) => schedule(r.db, id)).join('|')

  // 同上 —— 用片段，别让 check:sql 拿它当语句解析
  const boom = dbThatFailsOn(r.db, 'set finished_at = ?')
  let threw = false
  try {
    new Study(boom, 'prompts', () => 'B2').settleLectures([1, 2], sessionId)
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没炸')
  assert(
    [1, 2].map((id) => schedule(r.db, id)).join('|') === before,
    '★ 收尾时间没写成，间隔却已经扩张了 —— 重试会再扩一次'
  )
  r.db.close()
})

check('★ P-1 · 结算不碰 answers / review_logs（它们在答题那一刻就已经落库）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { sessionId, study } = practiceFixture(r, [1])
  const a = (r.db.prepare(`select count(*) n from answers`).get() as { n: number }).n
  const rl = (r.db.prepare(`select count(*) n from review_logs`).get() as { n: number }).n

  study.settleLectures([1], sessionId)
  assert(
    (r.db.prepare(`select count(*) n from answers`).get() as { n: number }).n === a,
    '★ 结算动了 answers'
  )
  assert(
    (r.db.prepare(`select count(*) n from review_logs`).get() as { n: number }).n === rl,
    '★ 结算动了 review_logs'
  )
  r.db.close()
})

// ── P-1-a · 「答完却没结算」的可发现性 ─────────────────────

/**
 * 造一场练习。`answered` = 记几条首答，`ageHours` = 开场于多少小时前。
 * 不经过 Study —— 这里要的是**任意形状的历史数据**，包括正常路径产生不了的那些。
 */
function sessionShaped(
  r: ReturnType<typeof openDatabase>,
  opts: { target: number; answered: number; ageHours: number; finished: boolean }
): number {
  const t = Date.now()
  const started = t - opts.ageHours * 3600_000
  const id = Number(
    r.db
      .prepare(
        `insert into sessions (kind, scope, target, started_at, finished_at, created_at, updated_at)
         values ('production','lecture',?,?,?,?,?)`
      )
      .run(opts.target, started, opts.finished ? started + 60_000 : null, started, started)
      .lastInsertRowid
  )
  const added = new Repo(r.db).addChunks(
    1,
    '我的收集',
    Array.from({ length: Math.max(opts.answered, 1) }, (_, i) => `sess${id} item ${i}`).join(
      String.fromCharCode(10)
    )
  ).added
  const ins = r.db.prepare(
    `insert into answers (session_id, item_id, question_id, attempt_no, is_first, text, grade,
                          hinted, created_at, updated_at)
     values (?, ?, null, 1, 1, 'x', 4, 0, ?, ?)`
  )
  for (let i = 0; i < opts.answered; i++) ins.run(id, added[i]!.id, started, started)
  return id
}

const hasSessionFinding = (db: Database.Database): boolean =>
  auditIds(db).includes('session-never-settled')

check('★ P-1-a · 正在进行中的一场（刚开始、题也答完了）→ 不许报警', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  // 答完最后一题、停在结果页还没点「下一题」—— 正常状态，可能停留很久
  sessionShaped(r, { target: 3, answered: 3, ageHours: 2, finished: false })
  assert(!hasSessionFinding(r.db), '★ 把一场正在进行的练习报成了异常')
  r.db.close()
})

check('★★ P-1-a · 中途关掉练习（题没答完）→ 不许报警，哪怕过了很久', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  /**
   * 这是**正常用法**：关掉练习不会结算，那一场永远停在 finished_at = null。
   * 拿「null 就报」当判据的话，他每中断一次就多一条告警 —— 噪音会淹掉真告警。
   */
  sessionShaped(r, { target: 10, answered: 4, ageHours: 240, finished: false })
  assert(!hasSessionFinding(r.db), '★ 把「中途走开」误判成了数据损坏')
  r.db.close()
})

check('★★ P-1-a · 题全答完、过了 24 小时还没结算 → 必须报出来', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  sessionShaped(r, { target: 5, answered: 5, ageHours: 30, finished: false })
  assert(hasSessionFinding(r.db), '★ 结算跑到一半没了的那种，体检里看不见')
  const f = audit(r.db).findings.find((x) => x.id === 'session-never-settled')!
  assert(f.severity === 'warn', '这条不该是 error —— 数据没丢，重新练一轮就会结算')
  assert(f.samples[0]?.includes('5/5'), `样例里没说清答了几题：${JSON.stringify(f.samples)}`)
  r.db.close()
})

check('★ P-1-a · 正常结算完的那一场 → 不许报警', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  sessionShaped(r, { target: 5, answered: 5, ageHours: 30, finished: true })
  assert(!hasSessionFinding(r.db), '★ 把一场正常结算完的练习报成了异常')
  r.db.close()
})

check('★ P-1-a · 报出来之后**不许**自动改任何东西（只报不修）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const sid = sessionShaped(r, { target: 5, answered: 5, ageHours: 30, finished: false })
  const before = snapshotAll(r.db)
  assert(hasSessionFinding(r.db), '前提没成立')
  repair(r.db)
  assert(
    (r.db.prepare(`select finished_at as f from sessions where id=?`).get(sid) as { f: number | null })
      .f === null,
    '★ 「修掉能修的」把它标成了已结算 —— 那是在编一个没发生过的事实，而且会挡住重新结算'
  )
  assert(snapshotAll(r.db) === before, '★ 这条检查不该有任何自动修复')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// N-1 · 「空」这个状态只在没有内容时成立
//
// 病根不是 addChunks 漏了一行，是「这一讲现在有没有有效内容」这个事实
// **只有 AI 分析那条路会去结算**，我的收集 / 手动加 / 同步导入都不结算。
// 后果是界面死胡同：那颗「开始学」只在 review 时渲染，而它是唯一进轮转的路。
// ══════════════════════════════════════════════════════════════

console.log('\nN-1 · 有内容了就不该再叫「空」\n')

/** 一条干净的、状态可控的讲；返回它的 id */
function lectureIn(r: ReturnType<typeof openDatabase>, status: string): number {
  const t = Date.now()
  const id = Number(
    r.db
      .prepare(
        `insert into lectures (unit_id, name, status, created_at, updated_at)
         values (1, ?, ?, ?, ?)`
      )
      .run(`L-${status}-${Math.random().toString(36).slice(2, 7)}`, status, t, t).lastInsertRowid
  )
  return id
}

/**
 * 这一讲除 status 外的调度位与学习记录 —— 用来断言「一个字没动」。
 *
 * `progress` 只看**动手之前就存在**的那些条目：新加的当然会多出来，
 * 把它们算进去比对，这个断言就永远红（第一版就是这么写的，八条一起假红）。
 * 要验的是「已有的进度没被碰」，不是「一条都没多」。
 */
const schedOf = (db: Database.Database, id: number, itemIds: number[]): string =>
  JSON.stringify({
    lecture: db
      .prepare(`select due_at as d, interval_days as iv, silent from lectures where id = ?`)
      .get(id),
    logs: db.prepare(`select count(*) n from review_logs`).get(),
    answers: db.prepare(`select count(*) n from answers`).get(),
    sessions: db.prepare(`select count(*) n from sessions`).get(),
    progress:
      itemIds.length === 0
        ? []
        : db
            .prepare(
              `select i.id, i.attempts, i.corrects, i.streak, rc.interval_days as ci, rc.ease as ce,
                      rc.due_at as cd, i.production_state as st, rc.silent as cs
                 from items i join reading_cards rc on rc.item_id = i.id
                where i.id in (${itemIds.map(() => '?').join(',')}) order by i.id`
            )
            .all(...itemIds)
  })

const itemIdsOf = (db: Database.Database): number[] =>
  (db.prepare(`select id from items order by id`).all() as { id: number }[]).map((x) => x.id)

for (const how of ['addChunks', 'addItem'] as const) {
  check(`★ N-1 · empty + ${how} → 当场变 review（不用等重启）`, () => {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    const repo = new Repo(r.db)
    const id = lectureIn(r, 'empty')
    const kept = itemIdsOf(r.db)
    const before = schedOf(r.db, id, kept)

    if (how === 'addChunks') repo.addChunks(id, '我的收集', 'a stone throw from')
    else repo.addItem(id, 'a stone throw from', '', 'B', 'a stone throw from')

    const l = r.db
      .prepare(`select status, due_at as d, interval_days as iv, silent from lectures where id = ?`)
      .get(id) as { status: string; d: number | null; iv: number; silent: number }
    assert(
      l.status === 'review',
      `★ 还是 ${l.status} —— 工作台上那颗「开始学」不会出现，这一讲是个死胡同`
    )
    assert(l.d === null, `★ 顺手造出了排期：${l.d}`)
    assert(l.iv === 0, `★ 间隔被动了：${l.iv}`)
    assert(l.silent === 0, '★ 静默位被动了')
    assert(schedOf(r.db, id, kept) === before, '★ 动了调度位或学习记录')
    /**
     * 只断言 N-1 那一条没了。
     *
     * `addItem` 会顺带触发 `quote-equals-term` —— 它写的是
     * `kind='chunk', source='self'`，而那条检查只放过 `kind='sentence' AND source='self'`。
     * 那是**本轮范围之外的既有问题**（已记录），拿它把这条用例判红，
     * 只会让人以为 N-1 没修好。
     */
    assert(
      !auditIds(r.db).includes('empty-with-items'),
      `★ 体检还在报 empty-with-items：${auditIds(r.db).join('、')}`
    )
    r.db.close()
  })

  for (const st of ['review', 'training', 'analyzing'] as const) {
    check(`★ N-1 · ${st} + ${how} → 状态一个字不许改`, () => {
      const { db: p, backups } = freshDir()
      const r = openDatabase(p, backups)
      seedTree(r)
      const repo = new Repo(r.db)
      const id = lectureIn(r, st)
      // training 的讲要有真实的排期和进度 —— 否则「不许重置」验不到东西
      if (st === 'training') {
        r.db
          .prepare(`update lectures set due_at = ?, interval_days = 7 where id = ?`)
          .run(Date.now() + 7 * 86400000, id)
      }
      const kept = itemIdsOf(r.db)
      const before = schedOf(r.db, id, kept)

      if (how === 'addChunks') repo.addChunks(id, '我的收集', 'at the mercy of tides')
      else repo.addItem(id, 'at the mercy of tides', '', 'B', 'at the mercy of tides')

      const l = r.db.prepare(`select status from lectures where id = ?`).get(id) as { status: string }
      assert(
        l.status === st,
        `★ ${st} 被改成了 ${l.status}` +
          (st === 'training'
            ? ' —— 打回 review 会让下一次「开始学」把间隔重设成 1，进度清零'
            : st === 'analyzing'
              ? ' —— 分析结束时会按内存里的旧状态覆盖回去，这一笔写了也没用'
              : '')
      )
      assert(
        schedOf(r.db, id, kept) === before,
        `★ 排期 / 间隔 / 学习记录被动了：\n  前：${before}\n  后：${schedOf(r.db, id, kept)}`
      )
      r.db.close()
    })
  }
}

check('★ N-1 · 连续两次 addChunks：第二次不再改状态，也不重复结算', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  const id = lectureIn(r, 'empty')

  repo.addChunks(id, '我的收集', 'first batch here')
  const after1 = r.db.prepare(`select status from lectures where id = ?`).get(id) as { status: string }
  assert(after1.status === 'review', '第一次就没改对')

  repo.addChunks(id, '我的收集', 'second batch here')
  const after2 = r.db
    .prepare(`select status, due_at as d, interval_days as iv from lectures where id = ?`)
    .get(id) as { status: string; d: number | null; iv: number }
  assert(after2.status === 'review', `★ 第二次把状态改成了 ${after2.status}`)
  assert(after2.d === null && after2.iv === 0, '★ 第二次动了调度位')
  r.db.close()
})

check('★★ N-1 · 事务原子性：状态结算失败 → 知识点也一起回滚', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = lectureIn(r, 'empty')
  const n0 = (r.db.prepare(`select count(*) n from items`).get() as { n: number }).n

  // 让状态结算那一句炸掉 —— 它排在知识点写入之后、commit 之前
  const boom = dbThatFailsOn(r.db, `update lectures set status = 'review'`)
  let threw = false
  try {
    new Repo(boom).addChunks(id, '我的收集', 'this must not survive')
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没炸')

  const n1 = (r.db.prepare(`select count(*) n from items`).get() as { n: number }).n
  assert(
    n1 === n0,
    `★ 状态没结算成，知识点却留下了 ${n1 - n0} 条 —— 正是要消灭的那种「有内容却叫空」`
  )
  const mats = (r.db.prepare(`select count(*) n from materials where lecture_id = ?`).get(id) as {
    n: number
  }).n
  assert(mats === 0, `★ 材料也该一起回滚，实际留下 ${mats} 份`)
  assert(!r.db.inTransaction, '★ 回滚之后还留在事务里')
  assert(auditIds(r.db).length === 0, `回滚之后体检不干净：${auditIds(r.db).join('、')}`)
  r.db.close()
})

check('★ N-1 · 启动兜底照旧：不经写入路径造出来的 empty+items 仍然修得掉，且幂等', () => {
  const { db: p, backups } = freshDir()
  {
    const r = openDatabase(p, backups)
    seedTree(r)
    const id = lectureIn(r, 'empty')
    new Repo(r.db).addChunks(id, '我的收集', 'legacy shaped row')
    /**
     * 直接改库造出历史形状 —— 模拟同步导入 / 旧备份导回 / 旧版本产生的库。
     * 这几条路都**不经过写入路径**，所以启动自愈必须继续保留（不能因为修了 N-1 就删）。
     */
    r.db.prepare(`update lectures set status = 'empty' where id = ?`).run(id)
    r.db.close()
  }

  const s1 = simulateStartup(p, backups)
  assert(
    s1.recovered.fixed.some((f) => f.to === 'review'),
    '★ 启动自愈没修历史形状 —— 兜底被拆掉了'
  )
  assert(auditIds(s1.r.db).length === 0, `修完体检不干净：${auditIds(s1.r.db).join('、')}`)
  const snap = snapshotAll(s1.r.db)
  s1.r.db.close()

  const s2 = simulateStartup(p, backups)
  assert(s2.recovered.fixed.length === 0, `★ 第二次启动又改了：${JSON.stringify(s2.recovered.fixed)}`)
  assert(snapshotAll(s2.r.db) === snap, '★ 第二次启动动了数据 —— 不幂等')
  s2.r.db.close()
})

// ══════════════════════════════════════════════════════════════
// R-1 · 启动自愈的错误分级
//
// 两个方向都要防，而且它们互相拉扯：
//   · 一条自愈 SQL 写错 → 整个软件打不开　（原来的行为，太重）
//   · 一律 catch 掉     → 库坏了还照常跑　（更糟：静默，他发现不了）
//
// 判据：**这一步自己的毛病** 记一笔继续；**库已经不可信** 当场停。
// ══════════════════════════════════════════════════════════════

console.log('\nR-1 · 启动自愈的错误分级\n')

/** 造一条会被自愈盯上的坏数据 —— 每条用例都从「本来该修好」出发 */
function healable(): { p: string; backups: string; r: ReturnType<typeof openDatabase> } {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  new Repo(r.db).addChunks(1, '我的收集', 'hold sway over')
  r.db.prepare(`update lectures set status='empty', due_at=null where id=1`).run() // 该修成 review
  r.db.prepare(`update lectures set status='analyzing', due_at=null where id=3`).run() // 该收拾掉
  return { p, backups, r }
}

check('★ R-1 · 一步失败：记一笔、继续启动，**别的步骤照做**', () => {
  const { r } = healable()
  // 只让「状态说空却有知识点」这一步炸 —— 它是唯一一个 update 成 review 的
  const boom = dbThatFailsOn(r.db, `set status = 'review'`)
  const heal = startupHeal(boom)

  assert(heal.problems.length === 1, `该记 1 条没做成，实际 ${JSON.stringify(heal.problems)}`)
  assert(
    heal.problems[0]!.step.includes('状态说空却有知识点'),
    `★ 记的不是出事的那一步：${heal.problems[0]!.step}`
  )
  assert(heal.problems[0]!.message.includes('注入的故障'), '原始错误信息丢了 —— 他贴给 AI 时就没线索')

  // 出事的那一步没改成
  const l1 = (r.db.prepare(`select status from lectures where id=1`).get() as { status: string }).status
  assert(l1 === 'empty', `出事的那一步不该改成功：${l1}`)
  // ★ 别的步骤照做 —— 这才是分级的意义
  const l3 = (r.db.prepare(`select status from lectures where id=3`).get() as { status: string }).status
  assert(
    l3 !== 'analyzing',
    '★ 一步失败把另一步也放弃了 —— 拿一个小毛病换掉了一个能修好的问题'
  )
  r.db.close()
})

check('★ R-1 · 事务内失败：整步回滚，不许出现「改了一半」', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  // 三条讲都是「状态说空却有知识点」，一步里要改三行
  for (const id of [1, 2, 3]) {
    repo.addChunks(id, '我的收集', `phrase for lecture ${id}`)
    r.db.prepare(`update lectures set status='empty', due_at=null where id=?`).run(id)
  }
  // 留痕表换成写不进去的形状 —— update 成功之后、insert 留痕时炸，正好在事务中间
  r.db.exec(`drop table lecture_logs`)
  r.db.exec(`create table lecture_logs (id integer primary key, nope integer not null)`)

  const heal = startupHeal(r.db)
  assert(heal.problems.length > 0, '★ 炸了却什么都没记 —— 悄悄吞掉了')
  const stuck = r.db
    .prepare(`select id, status from lectures where id in (1,2,3) order by id`)
    .all() as { id: number; status: string }[]
  assert(
    stuck.every((x) => x.status === 'empty'),
    `★ 事务没兜住，出现了「改了但没留痕」：${JSON.stringify(stuck)}`
  )
  assert(!r.db.inTransaction, '★ 回滚之后还留在事务里 —— 库处于半改状态')
  r.db.close()
})

check('★ R-1 · 出厂内容：一张表补不了，另外三张照补', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  for (const t of ['tutors', 'genres', 'qtypes', 'prompt_presets']) r.db.exec(`delete from "${t}"`)

  const boom = dbThatFailsOn(r.db, 'insert into genres')
  const heal = startupHeal(boom)

  assert(heal.problems.some((x) => x.step.includes('genres')), '没记下是哪张表出的事')
  assert(
    (r.db.prepare(`select count(*) n from genres`).get() as { n: number }).n === 0,
    '出事那张表不该补上'
  )
  for (const t of ['tutors', 'qtypes', 'prompt_presets']) {
    const n = (r.db.prepare(`select count(*) n from "${t}"`).get() as { n: number }).n
    assert(n > 0, `★ 一张表出事，${t} 也被放弃了 —— 那三个是静默降级，他一点都看不出来`)
  }
  r.db.close()
})

check('★★ R-1 · 库不可信（SQLITE_CORRUPT）→ 当场停，不许「继续启动」', () => {
  const { r } = healable()
  const boom = dbThatFailsOn(r.db, `set status = 'review'`, 'SQLITE_CORRUPT')
  let stopped: unknown = null
  try {
    startupHeal(boom)
  } catch (err) {
    stopped = err
  }
  assert(
    stopped instanceof UnsafeDatabase,
    `★ 库都报损坏了还继续往下跑 —— 后面每一次写入都是在未知状态上加东西（实际抛的是 ${String(stopped)}）`
  )
  assert((stopped as UnsafeDatabase).reason.includes('SQLITE_CORRUPT'), '人话里没带上错误码')
  assert(
    (stopped as UnsafeDatabase).step.includes('状态说空却有知识点'),
    `没说清停在哪一步：${(stopped as UnsafeDatabase).step}`
  )
  r.db.close()
})

check('★★ R-1 · 连接已经废了 → 也是「停」，不是「记一笔继续」', () => {
  const { r } = healable()
  r.db.close()
  let stopped: unknown = null
  try {
    startupHeal(r.db)
  } catch (err) {
    stopped = err
  }
  assert(
    stopped instanceof UnsafeDatabase,
    `★ 连接都没了还往下走 —— 后面每一步都会失败，继续没有意义（实际：${String(stopped)}）`
  )
})

check('★★ R-1 · 回滚没走完（还留在事务里）一律判为不可信', () => {
  /**
   * 这是唯一一种「看起来只是普通报错、实际库已经脏了」的情况，
   * 所以判据不看错误码，看 `db.inTransaction` —— 它为真就说明
   * better-sqlite3 的事务边界已经不成立，此刻库处于半改状态。
   */
  const plain = new Error('看起来平平无奇')
  assert(isUnsafeDbError(plain) === false, '普通错误不该被判成不可信')
  assert(
    isUnsafeDbError(plain, { inTransaction: true } as unknown as Database.Database) === true,
    '★ 回滚没走完却按「可恢复」放过去了'
  )
  // 磁盘 / 只读 / 不是数据库 —— 这几档也必须是「停」
  for (const code of ['SQLITE_IOERR_WRITE', 'SQLITE_READONLY_DBMOVED', 'SQLITE_NOTADB', 'SQLITE_FULL']) {
    const e = new Error('x') as Error & { code: string }
    e.code = code
    assert(isUnsafeDbError(e), `★ ${code} 被当成了「这一步自己的毛病」`)
  }
})

check('★ R-1 · 没做成的那几步要落进数据体检（他不看日志），下次做成了就消失', () => {
  const { r } = healable()
  const boom = dbThatFailsOn(r.db, `set status = 'review'`)
  startupHeal(boom)

  const f = audit(r.db).findings.find((x) => x.id === 'startup-heal-failed')
  assert(f, '★ 自愈没做成，数据体检里却看不见 —— 只写日志等于没人知道')
  assert(f.severity === 'error', '这条该是 error')
  assert(
    f.samples.some((s) => s.includes('状态说空却有知识点')),
    `体检里没说清是哪一步：${JSON.stringify(f.samples)}`
  )

  // 病根修掉之后再启动一次：那条记录必须自己消失，不能一直挂着吓他
  const again = startupHeal(r.db)
  assert(again.problems.length === 0, '这次不该再有问题')
  assert(
    !audit(r.db).findings.some((x) => x.id === 'startup-heal-failed'),
    '★ 修好了体检还在报 —— 报了不消的告警很快就没人看了'
  )
  assert(
    (r.db.prepare(`select status from lectures where id=1`).get() as { status: string }).status ===
      'review',
    '重试那一次没把它修好'
  )
  r.db.close()
})

check('★ R-1 · 一切正常时：不留记录、不多一条体检、结果和以前一样', () => {
  const { r } = healable()
  const heal = startupHeal(r.db)
  assert(heal.problems.length === 0, `正常路径不该有 problems：${JSON.stringify(heal.problems)}`)
  assert(heal.recovered.fixed.length === 2, `该修 2 讲，实际 ${JSON.stringify(heal.recovered.fixed)}`)
  assert(
    (r.db.prepare(`select count(*) n from settings where key = ?`).get(HEAL_PROBLEM_KEY) as { n: number })
      .n === 0,
    '★ 没出问题也往 settings 里塞了东西'
  )
  assert(auditIds(r.db).length === 0, `体检不干净：${auditIds(r.db).join('、')}`)
  r.db.close()
})

// ── 闭环 F · 拿真库的副本演练一次 ──────────────────────────
/**
 * 合成夹具能证明「这段逻辑对」，证明不了「**他那一份**跑下去会怎样」。
 * 这一条就是把他的库拷一份出来，照真实启动顺序走两遍，
 * 把「会改什么」原样打出来 —— 动手之前先看见。
 *
 *   set NYX_DRYRUN_DB=D:\Nyx\data\nyx.db
 *   npm run test:db
 *
 * **只读原库**：拷到临时目录再动，原文件一个字节都不碰。
 * 平时不指这个环境变量就整条跳过 —— 它依赖某一台机器上的数据，不能进常规回归。
 */
{
  const dry = process.env['NYX_DRYRUN_DB']?.trim()
  if (dry) {
    check(`★ 演练 · 拿真库副本跑两遍启动（${dry}）`, () => {
      const { db: p, backups } = freshDir()
      copyFileSync(dry, p)
      // -wal / -shm 一起拷，否则副本会缺掉还没落盘的那一截
      for (const ext of ['-wal', '-shm']) {
        if (existsSync(dry + ext)) copyFileSync(dry + ext, p + ext)
      }

      type L = { id: number; name: string; status: string; due: number | null; iv: number; silent: number }
      const lectures = (d: Database.Database): Map<number, L> =>
        new Map(
          (
            d
              .prepare(
                `select id, name, status, due_at as due, interval_days as iv, silent
                   from lectures where deleted_at is null order by id`
              )
              .all() as L[]
          ).map((x) => [x.id, x])
        )

      const ro = new Database(p, { readonly: true })
      const before = lectures(ro)
      console.log(`      演练前体检：${auditIds(ro).join('、') || '（干净）'}`)
      ro.close()

      const s1 = simulateStartup(p, backups)
      for (const [t2, n] of Object.entries(s1.builtins.filled)) {
        console.log(`      出厂自愈：${t2} 是空的，补回 ${n} 条`)
      }
      for (const f of s1.recovered.fixed) console.log(`      状态自愈：#${f.lectureId}《${f.name}》→ ${f.to}`)
      for (const r2 of s1.recovered.reported ?? []) {
        console.log(`      只报不改：#${r2.lectureId}《${r2.name}》${r2.problem}`)
      }

      const after = lectures(s1.r.db)
      let changed = 0
      for (const [id, a] of after) {
        const b = before.get(id)
        if (!b) {
          console.log(`      ⚠ 凭空多出一讲 #${id}`)
          changed++
          continue
        }
        const diff = (['status', 'due', 'iv', 'silent'] as const)
          .filter((k) => b[k] !== a[k])
          .map((k) => `${k}: ${String(b[k])} → ${String(a[k])}`)
        if (diff.length) {
          console.log(`      #${id}《${a.name}》${diff.join(' · ')}`)
          changed++
        }
      }
      assert(after.size === before.size, `★ 讲的条数变了：${before.size} → ${after.size}`)
      console.log(`      演练后体检：${auditIds(s1.r.db).join('、') || '（干净）'}　改动 ${changed} 讲`)
      const snap1 = snapshotAll(s1.r.db)
      s1.r.db.close()

      // 第二遍必须完全是空转
      const s2 = simulateStartup(p, backups)
      assert(s2.recovered.fixed.length === 0, `★ 第二遍又改了：${JSON.stringify(s2.recovered.fixed)}`)
      assert(
        Object.keys(s2.builtins.filled).length === 0,
        `★ 第二遍又补了出厂内容：${JSON.stringify(s2.builtins.filled)}`
      )
      assert(snapshotAll(s2.r.db) === snap1, '★ 第二遍启动动了数据 —— 在他真实的库上不幂等')
      s2.r.db.close()
      console.log('      第二遍：空转，一个字没动 ✔')
    })
  }
}

