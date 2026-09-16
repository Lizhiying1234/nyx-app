/**
 * 数据安全四件套 · D-216 / D-217 / D-236：建库 · updated_at · uid · 备份 · 迁移回滚 · 掉行自检 · 滚动 10 份 · 导出导回 · 分析自愈两层 · 历史脏数据
 *
 * 原 tests/db-safety.ts 第 253–2832 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MigrationFailed, openDatabase } from '../../src/main/db/open.ts'
import { makeBackup } from '../../src/main/db/backup.ts'
import { recoverAll, recoverStuckAnalyzing } from '../../src/main/db/recover.ts'
import { analyzeLecture } from '../../src/main/ai/analyze.ts'
import type { Migration } from '../../src/main/db/migrations.ts'
import { MIGRATIONS, SYNC_TABLES } from '../../src/main/db/migrations.ts'
import { Exporter, RestoreAborted } from '../../src/main/export.ts'
import { recordOccurrence } from '../../src/main/db/repo.ts'
import { QTypes } from '../../src/main/db/qtypes.ts'
// @ts-expect-error —— .mjs 脚本没有类型声明；这条用例的意义就是拿真库校它
import { schemaFromMigrations } from '../../scripts/schema-from-migrations.mjs'
import { Study } from '../../src/main/study.ts'
import { PRESERVED_SYNC_KEYS } from '../../src/core/sync-metadata.ts'
import { syncPrompts } from '../../src/main/prompt-sync.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { Browse } from '../../src/main/browse.ts'
import { Ledger } from '../../src/main/db/ledger.ts'
import { audit, repair } from '../../src/main/db/audit.ts'
import { factoryReset } from '../../src/main/factory-reset.ts'
import { ensureBuiltins } from '../../src/main/db/builtins.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { require$hash, seedTree, statusOf, cleanLecture, dbThatFailsOn, analyzeDeps, lecRow } from './fixtures.ts'

console.log('\n数据安全四件套 · D-216 / D-217 / D-236\n')

// ── 1 · 全新库能建起来，版本号写对 ────────────────────────────────
check('全新数据库 → 迁移到最新版，user_version 写对（D-216 第 1、2 条）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  assert(r.migrated === true, '全新库应该跑迁移')
  assert(r.fromVersion === 0, `起始版本应为 0，实际 ${r.fromVersion}`)
  assert(
    r.toVersion === MIGRATIONS.length,
    `目标版本应为 ${MIGRATIONS.length}，实际 ${r.toVersion}`
  )
  const v = r.db.pragma('user_version', { simple: true }) as number
  assert(v === r.toVersion, `user_version 没写进去：${v}`)
  const tables = r.db
    .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
    .all()
    .map((x) => (x as { name: string }).name)
  assert(tables.includes('settings'), `settings 表没建出来，实际有：${tables.join(', ')}`)
  assert(tables.includes('migration_log'), 'migration_log 表没建出来')
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 2 · 每张表都有 updated_at（D-201，增量行级同步的前提）─────────
check('每张表都有 updated_at —— 后补需要全库迁移（D-201）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const tables = r.db
    .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
    .all()
    .map((x) => (x as { name: string }).name)
  const missing: string[] = []
  for (const t of tables) {
    const cols = r.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]
    if (!cols.some((c) => c.name === 'updated_at')) missing.push(t)
  }
  assert(missing.length === 0, `这些表没有 updated_at：${missing.join(', ')}`)
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 2b · 参与同步的表都要有 uid（D-201 增量行级同步的第二个前提）──
check('每张同步表都有 uid，而且新插入的行会自动拿到（D-201）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)

  const missing: string[] = []
  for (const t of SYNC_TABLES) {
    const cols = r.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]
    if (cols.length === 0) continue
    if (!cols.some((c) => c.name === 'uid')) missing.push(t)
  }
  assert(missing.length === 0, `这些表没有 uid：${missing.join(', ')}`)

  // 自增 id 不能当同步身份 —— 两台机器各自新建都会拿到同一个 id。
  // 所以每一行插进来就得有 uid，靠触发器兜底（漏一处就是那张表永远同步不出去）
  const t = Date.now()
  r.db
    .prepare(`insert into projects (name, color, pinned, sort, created_at, updated_at)
              values ('测试', '#000', 0, 0, ?, ?)`)
    .run(t, t)
  const uid = (r.db.prepare(`select uid from projects order by id desc limit 1`).get() as {
    uid: string | null
  }).uid
  assert(uid, '新插入的行没有 uid —— 这一行永远同步不出去，而且不报错')

  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 3 · 升级前自动备份（D-216 第 3 条）────────────────────────────
check('升级前自动备份，而且备份是能打开的真库（D-216 第 3 条）', () => {
  const { db: p, backups, dir } = freshDir()
  // 先建一个 v1 的库并塞一行数据
  const first = openDatabase(p, backups, [MIGRATIONS[0]!])
  first.db.prepare(`insert into settings (key,value,updated_at) values ('k','v',1)`).run()
  first.db.close()

  const v2: Migration = {
    version: 2,
    name: '测试用 · 加一列',
    up: (d) => d.exec(`alter table settings add column note text`)
  }
  const r = openDatabase(p, backups, [MIGRATIONS[0]!, v2])
  assert(r.migrated === true, '应该跑了迁移')
  assert(r.backupPath !== null, '升级前没有备份')
  assert(existsSync(r.backupPath!), `备份文件不存在：${r.backupPath}`)

  const bak = new Database(r.backupPath!, { readonly: true })
  const row = bak.prepare(`select value from settings where key='k'`).get() as
    | { value: string }
    | undefined
  assert(row?.value === 'v', '备份里没有升级前的数据 —— 备份是坏的')
  bak.close()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 4 · 迁移失败要回滚，数据必须完好（D-236）★ 最要紧的一条 ───────
check('★ 迁移中途失败 → 回滚 + 用备份还原，数据一行不少（D-236）', () => {
  const { db: p, backups, dir } = freshDir()
  const first = openDatabase(p, backups, [MIGRATIONS[0]!])
  const stmt = first.db.prepare(`insert into settings (key,value,updated_at) values (?,?,?)`)
  for (let i = 0; i < 25; i++) stmt.run(`key${i}`, `值${i}`, Date.now())
  first.db.close()

  const boom: Migration = {
    version: 2,
    name: '测试用 · 故意炸掉',
    up: (d) => {
      d.exec(`alter table settings add column note text`)
      throw new Error('故意在迁移中间抛错')
    }
  }

  let caught: MigrationFailed | null = null
  try {
    openDatabase(p, backups, [MIGRATIONS[0]!, boom])
  } catch (err) {
    caught = err as MigrationFailed
  }
  assert(caught !== null, '迁移炸了却没有抛错 —— 这正是「静默通过」，绝不允许')
  assert(caught instanceof MigrationFailed, `抛的不是 MigrationFailed：${caught}`)
  assert(caught.restoredFrom !== null, '没有从备份还原')

  // 关键断言：重新打开，25 行数据必须一行不少，版本号必须还停在 1
  const after = new Database(p)
  const n = (after.prepare(`select count(*) as n from settings`).get() as { n: number }).n
  assert(n === 25, `数据丢了！应有 25 行，实际 ${n} 行`)
  const v = after.pragma('user_version', { simple: true }) as number
  assert(v === 1, `版本号应该还停在 1，实际 ${v} —— 半升级状态是最危险的`)
  const cols = (after.prepare(`pragma table_info(settings)`).all() as { name: string }[]).map(
    (c) => c.name
  )
  assert(!cols.includes('note'), `失败的迁移留下了残迹（note 列还在）：${cols.join(', ')}`)
  after.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 5 · 自检能抓到「掉行」────────────────────────────────────────
check('迁移把数据删了 → 自检必须拦住并回滚（D-236 的正题）', () => {
  const { db: p, backups, dir } = freshDir()
  const first = openDatabase(p, backups, [MIGRATIONS[0]!])
  const stmt = first.db.prepare(`insert into settings (key,value,updated_at) values (?,?,?)`)
  for (let i = 0; i < 10; i++) stmt.run(`k${i}`, `v${i}`, Date.now())
  first.db.close()

  const deleter: Migration = {
    version: 2,
    name: '测试用 · 悄悄删数据',
    up: (d) => d.exec(`delete from settings where key in ('k1','k2','k3')`)
  }

  let caught: unknown = null
  try {
    openDatabase(p, backups, [MIGRATIONS[0]!, deleter])
  } catch (err) {
    caught = err
  }
  assert(caught !== null, '迁移偷偷删了 3 行，自检却放行了 —— 这就是数据静默丢失')
  assert(
    String((caught as Error).message).includes('少了 3 行'),
    `报错没说清丢了多少：${(caught as Error).message}`
  )
  const after = new Database(p)
  const n = (after.prepare(`select count(*) as n from settings`).get() as { n: number }).n
  assert(n === 10, `还原之后应有 10 行，实际 ${n}`)
  after.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 6 · 滚动保留 10 份（D-217）──────────────────────────────────
/**
 * ★ H-2 · 轮转只清**可再生**的那几种。
 *
 * 原来这条只数「一共几个 .db」，那时候轮转不分种类。
 * 现在判据分两半，两半都要守：
 *   · 可再生（startup / manual / before-sync）：保留 10 份
 *   · 不可再生（before-restore / before-wipe / before-reset / pre-vNN）：**一份都不许少**
 *
 * 后一类记录的是再也回不去的时间点，而每次启动都产生一份 startup ——
 * 不分开的话，十来次启动就把它们挤出去了，
 * 而界面上写着「后悔了从『从备份导回…』找回来」。
 */
const REGENERABLE = /-(startup|manual|before-sync)(-\d+)?\.db$/
check('★ H-2 · 可再生备份保留 10 份，保命备份一份不少（D-217）', () => {
  const { db: p, backups, dir } = freshDir()
  for (let i = 0; i < 14; i++) {
    const r = openDatabase(p, backups)
    r.db.close()
  }

  /**
   * 造几份「保命备份」，**并且把时间戳改到过去**。
   *
   * 这一步不能省：轮转是按 mtime 排序留最近 10 份的。
   * 如果这几份是「刚写的」，它们本来就排在最前面，怎么轮转都不会被删 ——
   * 用例照样绿，而真实场景恰恰相反：保命备份是几周前做的，
   * 每次启动的 startup 才是新的，被挤出去的正是它们。
   * 第一版就是这么写的，负向对照红在了另一条断言上才发现。
   */
  const old = Date.now() / 1000 - 90 * 86400
  for (const tag of ['before-restore', 'before-wipe', 'before-reset', 'pre-v99']) {
    const f = join(backups, `nyx-20260101-000000-${tag}.db`)
    writeFileSync(f, 'x', 'utf8')
    utimesSync(f, old, old)
  }
  // 再开几次，让轮转有机会去删它们
  for (let i = 0; i < 6; i++) {
    const r = openDatabase(p, backups)
    r.db.close()
  }

  const all = readdirSync(backups).filter((f) => f.endsWith('.db'))
  const regen = all.filter((f) => REGENERABLE.test(f))
  const precious = all.filter((f) => !REGENERABLE.test(f))

  assert(regen.length === 10, `可再生的应该保留 10 份，实际 ${regen.length} 份`)
  for (const tag of ['before-restore', 'before-wipe', 'before-reset', 'pre-v99']) {
    assert(
      precious.some((f) => f.includes(tag)),
      `★ ${tag} 被轮转掉了 —— 那是他后悔时唯一的退路。现有：${precious.join('、')}`
    )
  }
  rmSync(dir, { recursive: true, force: true })
})

// ── 7 · 导出 → 导回，数据一行不少，且反悔得回去（D-102 / D-232）─────
/**
 * ★ I-096 · 可读笔记的版式
 *
 * 使用者：「导出的时候，导出的文件是不是也要整理以及注意一下版式和格式呢。」
 * 上一版是把库里的东西按 id 倒出来 —— 区块标题是 `nuance` / `pitfalls` 这类原始键名，
 * 连练习题的 JSON 都一起倒了进去。这里守住新版式的几条硬要求。
 */
check('★ I-096 · 导出的笔记先分讲、再分主动被动，区块用中文，练习素材不进去', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t, t)
  r.db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`).run(t, t)
  r.db
    .prepare(`insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L1','ready',?,?)`)
    .run(t, t)

  const addItem = r.db.prepare(
    `insert into items (id,term,gloss,gloss_zh,layer,kind,source,production_state,created_at,updated_at)
     values (?,?,?,?,?,'phrase','ai','training',?,?)`
  )
  const link = r.db.prepare(
    `insert into item_lectures (item_id,lecture_id,is_owner,created_at,updated_at) values (?,1,1,?,?)`
  )
  addItem.run(1, 'hold sway over', 'to dominate', '主导', 'B', t, t)
  addItem.run(2, 'a far cry from', 'very different from', '相去甚远', 'A', t, t)
  link.run(1, t, t)
  link.run(2, t, t)
  r.db
    .prepare(`insert into occurrences (item_id,quote,para,created_at,updated_at) values (1,?,2,?,?)`)
    .run('Orthodoxy held sway over the profession.', t, t)
  const blk = r.db.prepare(
    `insert into analysis_blocks (item_id,block,content,created_at,updated_at) values (?,?,?,?,?)`
  )
  blk.run(1, 'nuance', 'Formal, argumentative register.', t, t)
  // 练习素材：**不该出现在笔记里**
  blk.run(1, 'suspect', JSON.stringify([{ was: 'hold sway', should: 'hold sway over' }]), t, t)

  const md = new Exporter(r.db).notesMarkdown([1])

  assert(md.includes('## L1'), `没有按讲分节：
${md.slice(0, 300)}`)
  assert(md.includes('### 写作层'), '没有分出写作层那一节')
  assert(md.includes('### 理解层'), '没有分出理解层那一节')
  assert(md.indexOf('### 写作层') < md.indexOf('### 理解层'), '被动排到主动前面了')
  assert(md.includes('**分寸**'), `区块标题没换成中文：
${md}`)
  assert(!md.includes('**nuance**'), '区块标题还是原始键名')
  assert(!md.includes('Rewrite this'), '练习题被倒进了笔记 —— 笔记是拿来读的')
  assert(md.includes('> Orthodoxy held sway'), 'M-012 · 原文出处没带上')
  assert(md.includes('主动 1 · 被动 1'), '开头那行统计不对')
  r.db.close()
})

check('★ I-097 · 只导勾中的那几条', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  for (const [id, term] of [[1, 'alpha'], [2, 'beta'], [3, 'gamma']] as [number, string][]) {
    r.db
      .prepare(
        `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
         values (?,?,'g','B','phrase','ai','training',?,?)`
      )
      .run(id, term, t, t)
  }
  const out = join(dir, 'picked.md')
  new Exporter(r.db).writeItemNotes(out, '挑出来的', [1, 3])
  const md = readFileSync(out, 'utf8')
  assert(md.includes('alpha') && md.includes('gamma'), '勾中的没导出来')
  assert(!md.includes('beta'), '没勾的也导出来了 —— 那「勾选」就没意义')
  assert(md.startsWith('# 挑出来的'), '标题没用传进去的名字')
  r.db.close()
})

/**
 * ★ I-102 · 清空必须真的清干净
 *
 * 使用者两次报「数据没有全部清除」。第二次查出来是同一个坏设计的两张脸：
 *   · `item_events`（V10 新加的表）忘了写进清空名单 → 外键挡住 `delete from items`
 *   · `materials` 排在 `analysis_jobs` 前面 → 同样被外键挡住
 * 而每张表都是 `try { … } catch {}`，**失败被吞掉，看起来像成功**。
 *
 * 现在的做法是反过来的：列出所有表、扣掉要保留的那几张、其余一律清，
 * 全程关外键，清完再数一遍。这条测试守的就是「将来加了新表也不会漏」。
 */
check('★ I-102 · 清空之后每一张业务表都是空的（新加的表也算）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t, t)
  r.db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`).run(t, t)
  r.db
    .prepare(`insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','ready',?,?)`)
    .run(t, t)
  r.db
    .prepare(
      `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
       values (1,'hold sway','g','B','phrase','ai','training',?,?)`
    )
    .run(t, t)
  r.db
    .prepare(`insert into item_lectures (item_id,lecture_id,is_owner,created_at,updated_at) values (1,1,1,?,?)`)
    .run(t, t)
  // ★ 正是这张表当初漏掉了 —— 它引用 items，挡住了 delete from items
  r.db
    // ★ 2026-09-03 起 `item_events` 没有活的写入方了（小操练已删），
    //   但表还在、还进同步、级联仍要正确 —— 这条夹具守的是级联，不是小操练
    .prepare(`insert into item_events (item_id,kind,detail,created_at,updated_at) values (1,'legacy','x',?,?)`)
    .run(t, t)
  r.db
    .prepare(
      `insert into materials (lecture_id,kind,title,content,origin,char_count,created_at,updated_at)
       values (1,'original','M','body','paste',4,?,?)`
    )
    .run(t, t)

  const out = new Exporter(r.db).wipeStudyData(backups, false)
  assert(existsSync(out.backup), '清空之前那份备份不存在')

  // 逐表数一遍 —— 保留名单之外的表必须全空
  const KEEP = ['migration_log', 'settings', 'tutors', 'dictionaries', 'prompt_presets', 'profile_facts']
  const tables = (
    r.db
      .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
      .all() as { name: string }[]
  )
    .map((x) => x.name)
    .filter((x) => !KEEP.includes(x))
  const left: string[] = []
  for (const tb of tables) {
    const n = (r.db.prepare(`select count(*) as n from "${tb}"`).get() as { n: number }).n
    if (n > 0) left.push(`${tb}(${n})`)
  }
  assert(left.length === 0, `清空之后还有数据：${left.join('、')}`)
  // 设置没勾就不该动
  assert(
    (r.db.prepare(`select count(*) as n from settings`).get() as { n: number }).n > 0,
    '没勾「连设置一起清」，设置却被清了'
  )
  r.db.close()
})

check('★ I-102 · 勾了「连设置一起清」，导师和词典这些配置也要一起走', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  r.db
    .prepare(`insert into settings (key,value,updated_at) values ('ai.key','secret',?)`)
    .run(t)
  const before = (r.db.prepare(`select count(*) as n from tutors`).get() as { n: number }).n

  new Exporter(r.db).wipeStudyData(backups, true)

  const after = (r.db.prepare(`select count(*) as n from tutors`).get() as { n: number }).n
  assert(after === 0, `导师配置没清（清前 ${before}，清后 ${after}）`)
  const keys = (r.db.prepare(`select key from settings`).all() as { key: string }[]).map((x) => x.key)
  assert(!keys.includes('ai.key'), 'API key 没清掉')
  // 墓碑必须留着 —— 清掉它，云端老数据下次同步又回来了
  assert(keys.includes('sync.wipedAt') || keys.includes('sync.watermark'), '同步墓碑/水位被清掉了')
  r.db.close()
})

/**
 * ★ I-107 · 原文出处只有一个入口，规则只写一遍
 *
 * 使用者第三次提出「原文摘录没做到」。前两次都只修了当时看到的那一条路径，
 * 而写出处的地方有四处。这一条守的是那个收口本身。
 */
check('★ I-107 · 出处回原文里定位；找不到就不写（宁可没有，也不要错的）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t, t)
  r.db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`).run(t, t)
  r.db
    .prepare(`insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','ready',?,?)`)
    .run(t, t)
  r.db
    .prepare(
      `insert into materials (id,lecture_id,kind,title,content,origin,char_count,created_at,updated_at)
       values (1,1,'original','原文',?, 'paste',80,?,?)`
    )
    .run('Coastal towns bear the brunt of these storms every winter. The damage compounds.', t, t)
  const addItem = r.db.prepare(
    `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
     values (?,?,'g','B','chunk','self','training',?,?)`
  )
  addItem.run(1, 'bear the brunt of', t, t)
  addItem.run(2, 'take root', t, t)

  const q = (id: number): string | undefined =>
    (r.db.prepare(`select quote from occurrences where item_id = ?`).get(id) as
      | { quote: string }
      | undefined)?.quote

  // ① 能在原文里定位 → 存**整句**，不是词条本身
  assert(
    recordOccurrence(r.db, 1, 1, 'bear the brunt of', { fallback: 'bear the brunt of' }),
    '原文里明明有，却没写出处'
  )
  assert(
    q(1) === 'Coastal towns bear the brunt of these storms every winter.',
    `没摘到整句：${q(1)}`
  )

  // ② 原文里没有 → **不写**。给了 fallback 也不行，因为它不在原文里
  assert(
    !recordOccurrence(r.db, 2, 1, 'take root', { fallback: 'The idea took root somewhere else.' }),
    '编造的出处被写进去了 —— 错的出处会一路带进认读卡和笔记'
  )
  assert(q(2) === undefined, '不该有出处却写了一条')

  /**
   * ③ **他自己打的出处要留住。**
   *
   * 这一条是我第一版漏掉的：我把「AI 给的」和「他自己打的」一视同仁地校验，
   * 结果手动加一条时他填的出处也被丢掉了。那不对 ——
   * 他是在告诉软件「我在这儿见到的」，校验不过就丢，等于说「你记错了」。
   * 软件没有这个资格。要校验的只是 AI 编出来的那种。
   */
  addItem.run(3, 'a standing invitation', t, t)
  assert(
    recordOccurrence(r.db, 3, 1, 'a standing invitation', {
      fallback: '在别的书上看到的，原话记不全了',
      trusted: true
    }),
    '他自己打的出处被丢了'
  )
  assert(q(3) === '在别的书上看到的，原话记不全了', `没照存：${q(3)}`)
  r.db.close()
})

/**
 * ★ I-104 · 分析进度**关掉软件也在**。
 *
 * 使用者的要求原话：「如果中途暂停了，下次进入的时候，可以接着分析，
 * 已经分析过的部分自动跳过。」这里的关键是 **关软件再开也算**。
 *
 * 实现上我**没有**另存一份「进度」—— 库里有没有解析块，本身就是进度。
 * 另存一份就会有两个真相，暂停在半路时它们必然对不上（写完了块、还没来得及记进度）。
 * 这条测试守的正是这个选择：**关库、重开、换一个新的 Study 实例**，
 * 待办队列必须原样还在，而且不含已经写过的那条。
 */
check('★ I-104 · 分析进度存在库里 —— 关掉软件再打开，接着没做的那条跑', () => {
  const { db: p, backups } = freshDir()
  const t = Date.now()
  const seed = (r: { db: Database.Database }): void => {
    r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t, t)
    r.db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`).run(t, t)
    r.db
      .prepare(`insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','ready',?,?)`)
      .run(t, t)
    const add = r.db.prepare(
      `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
       values (?,?,'g','B','chunk','ai','training',?,?)`
    )
    const link = r.db.prepare(
      `insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,1,?,?)`
    )
    for (const [id, term] of [[1, 'bear the brunt of'], [2, 'at the mercy of'], [3, 'a far cry from']] as const) {
      add.run(id, term, t, t)
      link.run(id, t, t)
    }
  }

  const first = openDatabase(p, backups)
  seed(first)
  const s1 = new Study(first.db, join(backups, 'prompts'), () => 'B2')
  assert(s1.pendingAnalysis(1, 'active').length === 3, '一开始应该三条都待办')

  // 只写完第 2 条就「暂停」了
  first.db
    .prepare(
      `insert into analysis_blocks (item_id,block,content,created_at,updated_at)
       values (2,'pitfalls','…',?,?)`
    )
    .run(t, t)
  assert(s1.pendingAnalysis(1, 'active').length === 2, '写过的那条没被跳过')
  first.db.close()

  // ── 关掉软件，重新打开 ──
  const again = openDatabase(p, backups)
  const s2 = new Study(again.db, join(backups, 'prompts'), () => 'B2')
  const rest = s2.pendingAnalysis(1, 'active').map((x) => x.term)
  assert(rest.length === 2, `重开之后待办数不对：${rest.length}`)
  assert(!rest.includes('at the mercy of'), '重开之后又要重跑已经写过的那条')
  assert(
    s2.analysisCounts(1).active.pending === 2,
    '下拉框上显示的数字和真正的队列对不上 —— 这两处必须同一个判据'
  )
  again.db.close()
})

/**
 * ★ 使用者 4.3 · 垃圾箱的两个已知问题
 *
 * 一、「先删除 Lecture/单元，再删除项目后，单独恢复 Lecture 时项目栏中不显示」
 *     —— 恢复只把 lecture 自己放出来，上级还躺在垃圾箱里，
 *     而项目栏只列没删的项目和单元。**东西回来了、人看不见**，
 *     比没恢复更糟：他会以为数据丢了。
 *
 * 二、「垃圾箱中执行彻底删除时出现的异常」
 *     —— `foreign_keys = ON` 且没有 on delete cascade，
 *     直接 delete 父行必抛 FOREIGN KEY constraint failed。
 */

checkAsync('★ 4.3 · 恢复 lecture 要连上级路径一起恢复，否则项目栏里看不见它', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  const browse = new Browse(r.db)

  // 他描述的顺序：先删 lecture，再删项目
  browse.deleteLecture(1)
  repo.softDelete('project', 1)

  assert((await browse.trash()).some((b) => b.kind === 'unit'), '垃圾箱里没有「单元」这一格（4.3 要求新增）')

  browse.restore('lecture', 1)

  const visible = (sql: string): number =>
    (r.db.prepare(sql).get() as { n: number }).n
  assert(
    visible(`select count(*) as n from lectures where id = 1 and deleted_at is null`) === 1,
    'lecture 自己都没恢复'
  )
  assert(
    visible(`select count(*) as n from units where id = 1 and deleted_at is null`) === 1,
    '★ 所属单元还在垃圾箱里 —— 项目栏里就看不见这一讲'
  )
  assert(
    visible(`select count(*) as n from projects where id = 1 and deleted_at is null`) === 1,
    '★ 所属项目还在垃圾箱里 —— 同上'
  )
  // 「其他未明确恢复的内容不自动加入该路径」
  assert(
    visible(`select count(*) as n from lectures where id = 2 and deleted_at is null`) === 0,
    '把同单元下别的 lecture 也拽回来了 —— 他明确说不要'
  )
  assert(
    visible(`select count(*) as n from units where id = 2 and deleted_at is null`) === 0,
    '把别的已删单元也拽回来了'
  )
  r.db.close()
})

check('★ 4.3 · 恢复单元：上级项目 + 这个单元里的所有 lecture', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  const browse = new Browse(r.db)

  repo.softDelete('project', 1)
  browse.restore('unit', 1)

  const n = (sql: string): number => (r.db.prepare(sql).get() as { n: number }).n
  assert(n(`select count(*) as n from projects where id = 1 and deleted_at is null`) === 1, '项目没恢复')
  assert(n(`select count(*) as n from units where id = 1 and deleted_at is null`) === 1, '单元没恢复')
  assert(
    n(`select count(*) as n from lectures where unit_id = 1 and deleted_at is null`) === 2,
    '★「恢复该单元内所有 Lecture」没做到'
  )
  assert(
    n(`select count(*) as n from units where id = 2 and deleted_at is null`) === 0,
    '别的已删单元被一起恢复了'
  )
  r.db.close()
})

checkAsync('★ 4.3 · 彻底删除不许抛外键错，而且要连引用一起删干净', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  const browse = new Browse(r.db)

  repo.softDelete('project', 1)

  // 以前这一行直接抛 FOREIGN KEY constraint failed
  const n = await browse.purgeMany([{ kind: 'project', id: 1 }])
  assert(n === 1, `彻底删除没删掉：${n}`)

  const left = (t: string): number =>
    (r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
  for (const t of ['projects', 'units', 'lectures', 'items', 'item_lectures', 'occurrences']) {
    assert(left(t) === 0, `${t} 里还剩 ${left(t)} 行 —— 彻底删除没删干净，库里留着孤儿`)
  }
  r.db.close()
})

checkAsync('★ 4.1 · 彻底删掉的表达进账本；捡回来账就撤掉', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  const browse = new Browse(r.db)
  const ledger = new Ledger(r.db)

  repo.softDelete('project', 1)
  await browse.purgeMany([{ kind: 'project', id: 1 }])

  assert(
    ledger.verdictOf('Bear The Brunt Of') === 'purged',
    '彻底删掉的表达没进账本 —— 下次分析又会把它捞回来（4.1 就是要防这个）'
  )
  assert(ledger.verdictOf('从来没见过的说法') === null, '没处理过的表达不该有判定')

  // 撤账：他把东西捡回来了，账要跟着改口，否则这条表达从此再也进不来
  const { db: p2, backups: b2 } = freshDir()
  const r2 = openDatabase(p2, b2)
  seedTree(r2)
  const browse2 = new Browse(r2.db)
  const ledger2 = new Ledger(r2.db)
  browse2.deleteLecture(1)
  new Repo(r2.db).softDelete('project', 1)
  ledger2.note('bear the brunt of', 'deleted')
  browse2.restore('lecture', 1)
  assert(
    ledger2.verdictOf('bear the brunt of') === null,
    '★ 恢复之后账没撤 —— 这条表达以后再也分析不进来，而他完全看不出为什么'
  )
  r.db.close()
  r2.db.close()
})

check('★★★ T-4.14 · 查一次词就一行账，三个字段逐字对；收下之后回填同一行', () => {
  /**
   * ★★★ 这一层钉的是**账本自己写出来的形状**（`Ledger.lookup` / `lookupSaved`）。
   *
   * ── 为什么两层各钉一份 ────────────────────────────────────
   *
   * `smoke:ops` 那三条走的是真界面（右键 → 查词典 → 收下），证明**那条路通**；
   * 但它要开 Electron，慢而且重。这一条不开界面，直接对着写入面 ——
   * 形状（`op` / `target` / `title` / `detail` 三个字段）该在这里钉死。
   * 主控 2026-09-07 拿「把 `source` 写成 `android`」做对照时跑的是 `smoke:study`，
   * 那一套根本不碰 `ops_log` —— 于是看着像「没人钉 source」。
   * （`smoke:ops` 当时就红，已复核；但对照跑错套这件事本身说明：
   *   **判据摆在最便宜的那一层，别人才找得到它。**）
   *
   * ── 三个字段各自回答什么 ──────────────────────────────────
   *
   *   `source` 从哪台机器查的（手机写 assist / app，电脑写 windows）
   *   `face`   词典还是 AI（Windows 今天只有词典那一面）
   *   `saved`  查完收没收 —— null = 没收，有值 = 收成了哪一条
   *
   * 少任何一个，报告就答不出「查了没收」「反复查同一个词」那几问，
   * 而那正是这条任务存在的理由（归档 d §三 G）。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const ledger = new Ledger(r.db)

  const rowsOf = (): { op: string; target: string; targetId: number | null; title: string | null; detail: string | null; updatedAt: number }[] =>
    r.db
      .prepare(
        `select op, target, target_id as targetId, title, detail, updated_at as updatedAt
           from ops_log where op = 'lookup' order by id`
      )
      .all() as ReturnType<typeof rowsOf>

  const id = ledger.lookup('abandon', 'dict')
  assert(id > 0, '★★★ 查词一行都没记上 —— 电脑这一半的查词行为还是空白')

  const one = rowsOf()
  assert(one.length === 1, `★★★ 查一次词该只有一行，实际 ${one.length} 行`)
  assert(one[0].target === 'term', `★★ target 要和手机那一行一样是 term，实际 ${one[0].target}`)
  assert(one[0].targetId === null, '★ 查词没有 target_id —— 那时候还没有 item')
  assert(one[0].title === 'abandon', `★★ title 该是词面，实际 ${JSON.stringify(one[0].title)}`)

  const d = JSON.parse(one[0].detail ?? 'null') as {
    source?: string
    face?: string
    saved?: number | null
  } | null
  assert(!!d, '★★★ detail 是空的 —— 那这一行和手机上那 1,142 条一样什么都说不出')
  assert(d?.source === 'windows', `★★★ source 不是 windows（是 ${JSON.stringify(d?.source)}）—— 报告分不出这笔是哪台机器查的`)
  assert(d?.face === 'dict', `★★★ face 不是 dict（是 ${JSON.stringify(d?.face)}）—— 分不出查的是词典还是 AI`)
  assert((d?.saved ?? null) === null, '★★ 还没收下，saved 就该是空的')

  // ── 收下 → **回填同一行**，不是再记一行 ──────────────────
  const before = one[0].updatedAt
  const changed = ledger.lookupSaved(id, 4242)
  assert(changed === 1, `★★★ 「查了之后收下了」没回填，改了 ${changed} 行`)
  const after = rowsOf()
  assert(after.length === 1, `★★★ 回填不该再记一行 —— 现在有 ${after.length} 行`)
  assert(
    JSON.parse(after[0].detail ?? 'null').saved === 4242,
    '★★★ saved 没写进去 —— 报告只能靠词面 + 时间去猜，那正是手机那批 lookup 的毛病'
  )
  assert(
    after[0].updatedAt >= before,
    '★★ 回填没顶 updated_at —— 改了也同步不出去（D-438 只比它）'
  )

  // 同一次查词只有一次「收下」：再回填不许把第一次的盖掉
  assert(ledger.lookupSaved(id, 9999) === 0, '★★ 同一行被回填了第二次')
  assert(
    JSON.parse(rowsOf()[0].detail ?? 'null').saved === 4242,
    '★★★ 第二次回填把第一次那条盖掉了'
  )

  // AI 那一面：Windows 今天没有这个入口，但契约两端同一份，写得进去
  const aiId = ledger.lookup('coherent', 'ai')
  assert(aiId > 0 && aiId !== id, '★ 第二次查词该是新的一行')
  const ai = rowsOf().find((x) => x.title === 'coherent')
  assert(JSON.parse(ai?.detail ?? 'null').face === 'ai', '★★ face 只认死了 dict —— 那 AI 搜索接上时会写不进来')

  r.db.close()
})

/**
 * ★ 使用者 4.2 · 静默是**级联**的，而且和 D-011 不矛盾
 *
 * 他的原话：「项目静默 → 整个项目从正常视图消失，只出现在静默知识库；
 * 项目内所有单元、Lecture、知识点全部进入静默知识库；测试与统计与静默知识完全无关。」
 *
 * 做法是**筛选**，不是移动（D-011）：只翻状态位，一行数据都没搬家，
 * 所以报告仍然统计得出「这条出自 L1」，恢复出来也是完整的。
 * 一条测试记录都没删 —— 删了就恢复不出完整的东西，而 D-013 说静默可恢复。
 */
/**
 * ★★ V35 / D-349 / D-350 · **接线**，不是机制。
 *
 * ── 为什么单独写这一条 ──────────────────────────────────────
 *
 * `check:schema` 只证明**列在库里**；它证明不了**有人往里写**。
 * 这正是 R-4-D-a 那次的教训：原来那条用例直接调 `noteRunFailure`，
 * 验的是记账机制，而漏掉的恰恰是**接线**。
 *
 * 所以这一条**一次 SQL 都不自己写**，全走真的 `Study` 方法，
 * 然后去库里查那三样有没有落下来。
 *
 * 反向验收：把 `study.ts` 里任意一处 `deviceCol(this.db)` 改回去，这条必须红。
 */
check('★★ V35 · 设备来源 / 产出反应时间 / 规则快照，真的写进去了（接线）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')

  // ── ① 设备编号：第一次需要时就该生成（D-355 §6.2 ①）────────
  //    ★ 这里**没有跑过任何一次同步** —— 旧行为是「第一次同步时才生成」，
  //      那样的话「先练几天再配同步」那几天的记录全都没有来源。
  const devBefore = r.db.prepare(`select value from settings where key = 'sync.device'`).get() as
    | { value: string }
    | undefined
  assert(!devBefore?.value, '前提没成立：还没练就已经有设备编号了，这条验不到「首次需要时生成」')

  // ── ② 开一次会话 → device + rules 都该落下来 ────────────────
  const sid = study.startSession('reading', 'today', 20)
  const sess = r.db.prepare(`select device, rules from sessions where id = ?`).get(sid) as {
    device: string | null
    rules: string | null
  }
  assert(!!sess.device, '★ sessions.device 是空的 —— 电脑那边分不出这是哪台设备练的')
  assert(!!sess.rules, '★ sessions.rules 是空的 —— 规则一改，这一批答案的可比性就断了（D-350）')

  const snap = JSON.parse(sess.rules!) as Record<string, unknown>
  assert(snap['v'] === 1, `规则快照没版本号：${sess.rules}`)
  assert(
    Object.prototype.hasOwnProperty.call(snap, 'qtypes') &&
      Object.prototype.hasOwnProperty.call(snap, 'params'),
    `★ 快照少了会改变出题与判分的那几样：${sess.rules}`
  )
  const params = snap['params'] as { dailyTarget?: number }
  assert(typeof params?.dailyTarget === 'number', `快照里的 params 不完整：${sess.rules}`)

  // ── ③ 认读判分 → review_logs 该带 device 与 duration_ms ──────
  study.gradeCard(1, 3, 4321)
  const rl = r.db
    .prepare(`select device, duration_ms as ms from review_logs where line = 'reading' order by id desc limit 1`)
    .get() as { device: string | null; ms: number | null }
  assert(!!rl.device, '★ review_logs.device 是空的（认读线）')
  assert(rl.ms === 4321, `★ 认读线的反应时间没记对：${rl.ms}`)

  // ── ④ 同一台机器上，三处盖的必须是**同一个戳** ★★ ────────────
  //    两处各生成一份的后果：电脑那边看到「A 推来的包里装着 B 产生的记录」，
  //    而且**不报错**，只会让事后分析悄悄得出错误结论。
  const dev = r.db.prepare(`select value from settings where key = 'sync.device'`).get() as {
    value: string
  }
  assert(
    sess.device === dev.value && rl.device === dev.value,
    `★★ 三处的设备编号对不上：settings=${dev.value} session=${sess.device} review=${rl.device}`
  )

  // ── ⑤ 历史行不许被编一个编号出来 ────────────────────────────
  //    「不知道」是事实，编一个是伪造，而伪造的那部分事后分辨不出来。
  r.db
    .prepare(
      `insert into review_logs (item_id, line, grade, created_at, updated_at) values (2, 'reading', 2, 1, 1)`
    )
    .run()
  const legacy = r.db
    .prepare(`select device from review_logs where item_id = 2 order by id desc limit 1`)
    .get() as { device: string | null }
  assert(legacy.device === null, '★ 老行被填了设备编号 —— 那是伪造')

  r.db.close()
})

check('★ 4.2 · 静默项目 → 底下的知识点整支进静默库，项目栏里不再显示', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')

  // 先手点静默一条 —— 取消上级静默时它**不该**被一起放出来
  study.bulkSilence([2], true)

  repo.setSilent('project', 1, true)

  const state = (id: number): { s: string; by: string | null } =>
    r.db.prepare(`select production_state as s, silenced_by as by from items where id = ?`).get(id) as {
      s: string
      by: string | null
    }
  assert(state(1).s === 'silent', '知识点没跟着进静默库')
  assert(state(1).by === 'project', `silenced_by 没记对：${state(1).by}`)
  assert(state(3).s === 'silent', '另一个单元下的知识点也该进去（整个项目）')
  assert(state(2).by === 'self', '★ 他手点过的那条被上级操作覆盖了')

  assert(repo.tree().length === 0, '★ 静默的项目还在项目栏里显示')
  const st = repo.silentTree()
  assert(st.length === 1 && st[0].kind === 'project', `静默知识库里看不见它：${JSON.stringify(st)}`)

  // 测试记录一条都没删 —— 这是和 D-011 / D-013 的分界线
  const n = (t: string): number => (r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
  assert(n('occurrences') === 3, `出处被删了 ${3 - n('occurrences')} 条 —— 静默不该动数据`)
  assert(n('items') === 3, '知识点被删了 —— 静默是筛选，不是删除')

  // ── 取消静默 ──
  repo.setSilent('project', 1, false)
  assert(state(1).s === 'training', '取消静默没放出来')
  assert(state(1).by === null, 'silenced_by 没清掉')
  assert(
    state(2).s === 'silent' && state(2).by === 'self',
    '★ 他一条一条点过的静默，被一个上级操作抹掉了 —— 那是他自己做过的决定'
  )
  assert(repo.tree().length === 1, '取消静默之后项目没回到项目栏')
  r.db.close()
})

/**
 * ★ 使用者 6.1 · 拖拽只在同一层、同一个父级里成立
 *
 * 「项目：只能在项目栏内拖动排序。单元：只能在本项目内。
 *   Lecture：只能在本单元内。**不允许跨级拖动。**」
 *
 * 界面上的 dragover 判断是给人看的反馈；**约束必须落在写数据这一层**，
 * 否则将来多一个入口（键盘排序、以后真做跨级移动）就绕过去了，
 * 而且绕过去不会报错 —— 数据悄悄乱掉，等他发现时已经理不清了。
 */
check('★ 6.1 · 排序只在同一父级内生效，跨级当场拒绝', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)

  // 单元 1、2 都在项目 1 下，可以互换
  repo.reorder('unit', 1, [2, 1])
  const order = (sql: string): number[] =>
    (r.db.prepare(sql).all() as { id: number }[]).map((x) => x.id)
  assert(
    order(`select id from units where project_id = 1 order by sort, id`).join(',') === '2,1',
    '同一项目内的单元换不了顺序'
  )

  // lecture 1、2 在单元 1 下；lecture 3 在单元 2 下 —— 3 不许混进来
  let threw = false
  try {
    repo.reorder('lecture', 1, [3, 1, 2])
  } catch (e) {
    threw = true
    assert(String(e).includes('不能跨级'), `报错没说清原因：${String(e)}`)
  }
  assert(threw, '★ 跨级排序被接受了 —— 数据会悄悄乱掉')
  assert(
    order(`select id from lectures where unit_id = 1 order by sort, id`).join(',') === '1,2',
    '拒绝之后留下了半截改动'
  )
  r.db.close()
})

/**
 * ★ 使用者 6.3 · 重复收集只算**跨 lecture** 的那一种
 *
 * 「算重复收集：不同 Lecture 中再次出现完全相同的知识点。
 *   不算：同一 Lecture 因误操作重新上传了相同材料。」
 *
 * 以前的判据是「库里已经有 → 计数 +1」，于是同一讲重传一次材料也被算成
 * 「又遇到一次」。那不是学习信号，是操作失误 ——
 * 而 D-026 的重复收集是要提示「这个表达在你的阅读里反复出现」，
 * 计数被误操作污染之后，这个提示就不可信了。
 */
check('★ 6.3 · 同一讲里重复收进不算重复收集，换一讲才算', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)

  const times = (term: string): number =>
    (
      r.db
        .prepare(`select recollected_count as n from items where lower(trim(term)) = ? limit 1`)
        .get(term) as { n: number }
    ).n

  assert(times('bear the brunt of') === 0, '起点不是 0')

  // 同一讲里再收一次 —— 误操作，不算
  repo.addChunks(1, '重传的同一份', 'bear the brunt of')
  assert(times('bear the brunt of') === 0, '★ 同一讲里重传被算成了重复收集')

  // 换一讲收同一条 —— 这才是他要的信号
  repo.addChunks(2, '另一讲里又见到了', 'bear the brunt of')
  assert(times('bear the brunt of') === 1, `跨 lecture 没记上：${times('bear the brunt of')}`)
  r.db.close()
})

/**
 * ★ 使用者 9.1 / 9.2 · 数据体检
 *
 * 「全面检查所有数据之间的关联逻辑、算法、调度、统计计算…
 *   指出不合理之处并修正。」
 *
 * 这里验两件事：
 *   ① 正常用出来的库，体检应该**一条问题都没有**（否则日常操作本身在造脏数据）
 *   ② 故意造几种脏数据，体检**必须抓到**，能自动修的修掉
 *
 * ② 比 ① 重要：一个永远报「没问题」的体检等于没有，而且会让人放心。
 */
check('★ 9.1 · 正常操作出来的库，体检零问题', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  // 走几条真实路径：静默、删除、恢复、贴一批
  repo.setSilent('lecture', 1, true)
  repo.setSilent('lecture', 1, false)
  repo.addChunks(2, '我整理的', 'a far cry from')
  new Browse(r.db).deleteLecture(3)

  const rep = audit(r.db)
  assert(rep.checked >= 15, `体检只跑了 ${rep.checked} 条 —— 太少了，等于没检查`)
  assert(
    rep.findings.length === 0,
    '日常操作本身在造脏数据：' +
      rep.findings.map((f) => `${f.id}(${f.count}) ${f.title}`).join('；')
  )
  r.db.close()
})

check('★ 9.2 · 故意造脏数据，体检必须抓到，能修的修掉', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()

  // ① 静默了却还排着认读期 —— 「明明静默了还在考我」
  r.db.prepare(`update reading_cards set silent = 1, due_at = ? where item_id = 1`).run(t)
  // ② 答对次数比作答次数多 —— 正确率会超过 100%
  r.db.prepare(`update items set attempts = 2, corrects = 5 where id = 2`).run()
  // ③ lecture 静默了却还排着期 —— 归档了还催他练
  r.db.prepare(`update lectures set silent = 1, due_at = ? where id = 1`).run(t)
  // ④ 标着「因上级静默」，可上级根本没静默 —— 永远放不出来
  r.db.prepare(`update items set silenced_by = 'project' where id = 3`).run()
  // ⑤ 丢了同步身份 —— 这一行永远同步不出去，而且不报错
  r.db.prepare(`update items set uid = null where id = 2`).run()
  // ⑥ 活着的 lecture 挂在已删的单元下 —— 项目栏里看不见，却照进今日队列
  //    （这是 4.3 那个 bug 的残留形态，他真实的库里就有两条）
  r.db.prepare(`update units set deleted_at = ? where id = 2`).run(t)

  const before = audit(r.db)
  const ids = before.findings.map((f) => f.id)
  for (const want of [
    'silent-but-due',
    'corrects-over-attempts',
    'silent-lecture-due',
    'silenced-by-orphan',
    'sync-uid-missing',
    'live-child-dead-parent'
  ]) {
    assert(ids.includes(want), `体检漏了「${want}」—— 漏报比不检查更糟，它让人放心`)
  }
  // 每一条都要说清「违反之后他会看到什么」，写不出这句的检查不该存在
  for (const f of before.findings) {
    assert(f.impact.trim().length > 8, `${f.id} 没说清后果`)
    assert(f.samples.length > 0, `${f.id} 一个例子都没给 —— 他没法自己去核对`)
  }

  repair(r.db)
  const after = audit(r.db).findings.map((f) => f.id)
  for (const gone of [
    'silent-but-due',
    'corrects-over-attempts',
    'silent-lecture-due',
    'silenced-by-orphan',
    'sync-uid-missing',
    'live-child-dead-parent'
  ]) {
    assert(!after.includes(gone), `「${gone}」修完还在`)
  }
  r.db.close()
})

/**
 * ★ 题型可自定义（使用者「产出练习题型系统」）
 *
 * 这条钉住三件**违反了他就会在某个时刻卡住、而且看不出为什么**的事：
 *   ① 他写的提示词真的进了出题的那段上下文 —— 不然编辑框就是个摆设
 *   ② 删 / 停用不能把某一档掏空 —— 练到那一档会出不了题
 *   ③ 删掉的题型不影响历史题目（软删）—— 否则报告的知识流向图会断
 */
check('★ 题型自定义：提示词真的用上了，而且掏不空最后一种', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const qt = new QTypes(r.db)

  const all = qt.all()
  assert(all.length === 12, `内置题型该有 12 种，实际 ${all.length}`)
  /**
   * ★ 2026-09-08（D-478）· 这里原来断言「每一种都挂着 1–5 的难度档」。
   *   档位机制取消了：题型身上不该再有 tier，M-027 改由 `core/qtype-plan.ts`
   *   的 `preferDifferent` / `crossesEnoughTypes` 显式保证（core 那边有用例）。
   */
  assert(
    all.every((q) => !('tier' in (q as unknown as Record<string, unknown>))),
    '★★ 题型身上还挂着 tier —— 档位机制取消了（D-478），列留着但代码不许再读写'
  )

  // ① 他自己加一种，写自己的提示词
  const uid = qt.save({
    name: '看图说话',
    brief: '给个场景描述，用这个表达讲出来',
    prompt: 'Describe a scene in one line and ask them to narrate it using the expression.'
  })
  assert(uid.length > 0, '新题型没落库')
  const mine = qt.all().find((q) => q.uid === uid)!
  assert(mine.key === '看图说话', `key 不对：${mine.key}`)
  assert(!mine.builtin, '自己加的不该标成内置')

  const study = new Study(r.db, 'prompts', () => 'B2')
  study.setQtypes(qt.active().map((q) => q.key))
  /**
   * typesBrief / plan 都是私有的 —— 从它们的唯一出口验：
   * 出题上下文里必须出现他写的那句。
   *
   * ★ 一档只出 3 道，而这一档现在有 4 种（他新加的排在最后）。
   * 所以判据是「**换几条知识点下来**，他写的那句一定进得去」，
   * 而不是「第一条就必须有」—— 后者只是碰巧，起点一变就红，
   * 而红的是用例对 D-129「一档 3 道」的理解，不是软件。
   */
  const inner = study as unknown as {
    typesBrief(plan: unknown[]): string
    plan(itemId: number): unknown[]
  }
  const briefs = [0, 1, 2, 3].map((itemId) => inner.typesBrief(inner.plan(itemId)))
  assert(
    briefs.some((b) => b.includes('Describe a scene in one line')),
    '他写的提示词没进出题上下文 —— 那个编辑框就是个摆设'
  )
  assert(
    briefs.some((b) => b.includes('`看图说话`')),
    '题型的 key 没进上下文，AI 不知道该标成哪一种'
  )

  /**
   * ② 掏空要拦住 · ★ 2026-09-08 判据从「不能把某一档删空」收成「至少留一种启用的」。
   *   先把除两种之外的全停用，再验第二道护栏；`remove` 那道由「至少留一种」守着。
   */
  const list = qt.all()
  const keep = list.slice(0, 2)
  for (const q of list.slice(2)) qt.setEnabled(q.uid, false)
  qt.setEnabled(keep[0].uid, false)
  let blocked = ''
  try {
    qt.setEnabled(keep[1].uid, false)
  } catch (e) {
    blocked = (e as Error).message
  }
  assert(
    blocked.includes('就剩这一种是启用的'),
    `停用到一种不剩没被拦住：${blocked || '（没报错）'}`
  )
  // 放回去，后面的断言还要用
  for (const q of list) qt.setEnabled(q.uid, true)

  // ③ 删掉的是软删，历史题目认领得到
  const victim = qt.all()[0]
  qt.remove(victim.uid)
  const gone = qt.all().find((q) => q.uid === victim.uid)
  assert(!gone, '删掉的还在列表里')
  const still = r.db.prepare(`select key from qtypes where uid = ?`).get(victim.uid) as {
    key: string
  }
  assert(still?.key, '被硬删了 —— 用过它出的题会认不出来源，报告就断了')

  // ④ 恢复出厂只补内置，不动他自己加的
  qt.restoreBuiltin()
  assert(qt.all().some((q) => q.key === '看图说话'), '恢复出厂把他自己加的题型弄没了')
  assert(
    qt.all().some((q) => q.uid === victim.uid),
    '恢复出厂没把删掉的内置补回来'
  )

  // ⑤ 出题顺序两层，存得下读得回
  study.setOrder({ items: 'random', qtypes: 'random' })
  assert(study.order().items === 'random' && study.order().qtypes === 'random', '顺序没存住')
  study.setOrder({ items: 'seq', qtypes: 'seq' })
  assert(study.order().items === 'seq', '顺序改不回去')

  r.db.close()
})

/**
 * ★ Quest 停在当前问题卡（使用者「Enlighten / Quest 交互重构」）
 *
 * 「用户没有点击『下一个问题』之前，一直停留在当前问题卡片。」
 *
 * 这条不测 AI，测的是**它的前提**：消息按模式和题号分开存。
 * 分不开的话，「只围绕当前问题」就无从谈起 —— 喂进去的上下文里
 * 混着别的题和别的模式，提示词说什么都压不住。
 */
check('★ Quest：消息按模式和题号分开存，切过去看见的是另一条流', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  const fid = Number(
    r.db
      .prepare(
        `insert into files (title, content, lecture_id, created_at, updated_at)
         values ('文', '正文', null, ?, ?)`
      )
      .run(t, t).lastInsertRowid
  )
  const add = (role: string, kind: string, mode: string, no: number | null): void => {
    r.db
      .prepare(
        `insert into chat_messages (file_id, role, content, kind, mode, quest_no, created_at, updated_at)
         values (?, ?, 'x', ?, ?, ?, ?, ?)`
      )
      .run(fid, role, kind, mode, no, t, t)
  }
  add('user', 'message', 'enlighten', null)
  add('ai', 'message', 'enlighten', null)
  add('ai', 'task', 'quest', 1)
  add('user', 'message', 'quest', 1)
  add('ai', 'task', 'quest', 2)

  const rows = r.db
    .prepare(`select mode, quest_no as no, kind from chat_messages where file_id = ?`)
    .all(fid) as { mode: string; no: number | null; kind: string }[]
  assert(rows.filter((x) => x.mode === 'enlighten').length === 2, 'Enlighten 那条流不对')
  assert(rows.filter((x) => x.mode === 'quest').length === 3, 'Quest 那条流不对')
  assert(
    rows.filter((x) => x.mode === 'quest' && x.no === 1).length === 2,
    '第 1 题的线程收不齐 —— 追问就挂不到那张卡上'
  )
  assert(
    rows.filter((x) => x.mode === 'enlighten').every((x) => x.no === null),
    'Enlighten 的消息不该有题号'
  )
  r.db.close()
})

/**
 * ★ 清除全部数据真的清干净了吗（使用者 2026-08-10）
 *
 * 他点名：「不要留下『实际上没有完全清除，却显示清除成功』的状态。」
 * 那正是 I-102 的形状 —— 每张表 try/catch 吞异常，界面报「已清空」而数据还在。
 *
 * 所以这条用例干两件事：
 *   ① 造一个**有东西的**库，跑一遍 factoryReset，逐表数到 0
 *   ② 确认该留的还在：备份文件、migration_log、词典目录
 *
 * 界面那两阶段确认由 `tests/ui-real.test.ts` 验（那边不真清，
 * 真清会重启软件、把后面的用例一起带走）。两边合起来才算这功能验过了。
 */
/**
 * ★ I-119 · 彻底删除一份材料，不许把别人的表达写进「不再收录」名单
 *
 * `TrashKind` 加 `material` 时漏了 `termsUnder` 的分支，
 * 于是它掉进最后一档 `l.id = ?` —— **拿材料 id 当 lecture id** 去查表达。
 * 后果不是少记一笔，是**记错人**：彻底删 3 号材料，
 * 会把 3 号 lecture 里所有表达加进「以后自动跳过」名单，
 * 而他分析同一篇文章时会发现少收了一堆，**完全看不出为什么**。
 *
 * 这一条正是「整体排查」要找的那种：不崩、不报错、后果延迟且不可追溯。
 */
checkAsync('★ I-119 · 彻底删材料不牵连任何表达（别把别人的写进黑名单）', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  // 1 号 lecture 里放几条表达；材料也落在 1 号 lecture 上，两者 id 都会是小数字
  repo.addChunks(1, '我的收集', ['hold sway over', 'bear the brunt of'].join(String.fromCharCode(10)))
  const mat = repo.addOriginal(1, '要彻底删的原文', 'They hold sway over the region.', 'paste')

  const browse = new Browse(r.db)
  const ledger = new Ledger(r.db)

  /**
   * ★ 让「材料 id 撞上 lecture id」成为必然。
   *
   * 第一版直接用 `addOriginal` 返回的 id —— 它恰好不等于任何 lecture 的 id，
   * 于是那句错查 `l.id = ?` 什么都没查到，**用例在有 bug 的代码上也是绿的**。
   * 把修复摘掉再跑一遍才发现（第 ③ 档那条规矩）。
   *
   * 现在按「有知识点的那一讲」的 id 去删材料 —— 两张表各自自增，
   * 这种撞车在真实使用中本来就常见。
   * 而且 `purgeMany` **先抄表达、后查这行在不在**，所以这一条不依赖
   * 「真有一份这个 id 的材料」，它验的就是那句错查本身。
   */
  const lecWithItems = (
    r.db
      .prepare(
        `select il.lecture_id as id from item_lectures il
           join items i on i.id = il.item_id where i.deleted_at is null limit 1`
      )
      .get() as { id: number }
  ).id
  r.db.prepare(`update materials set deleted_at = ? where id = ?`).run(Date.now(), mat.materialId)

  /**
   * 删前先数一遍 —— 别写死数字。
   * 第一版断言「还剩 2 条」，而 `seedTree` 自己就带条目，于是失败信息是
   * 「还剩 5 条」，看起来像功能坏了，其实是我的期望值凭空写的。
   */
  const itemsBefore = (
    r.db.prepare(`select count(*) as n from items where deleted_at is null`).get() as { n: number }
  ).n

  await browse.purgeMany([{ kind: 'material', id: lecWithItems }])

  const blacklisted = ledger.list().map((x) => x.term)
  assert(
    blacklisted.length === 0,
    `★ 删一份材料却把 ${blacklisted.length} 条表达写进了「不再收录」：${blacklisted.join('、')}`
  )
  // 表达本身也必须原封不动 —— 材料是来源，不是容器
  const left = (r.db.prepare(`select count(*) as n from items where deleted_at is null`).get() as {
    n: number
  }).n
  assert(left === itemsBefore, `删材料把知识点也带走了：${itemsBefore} → ${left}`)
  r.db.close()
})

/**
 * ★ I-118 · 清空之后，出厂内容必须自己回来。
 *
 * 导师 / 体裁 / 题型 / 分析预设是**迁移里播种的**，迁移只跑一次。
 * 清空之后重启，`user_version` 已是最新，迁移不再跑 —— 这四张表永远空着。
 * 三个是静默降级：Quest 拿到假体裁照常出题、出题提示词的题型段整段是空的。
 * 「恢复出厂」得到的状态**比全新安装还差**。
 *
 * 这条用例把「重启一次」模拟成「再调一次 ensureBuiltins」——
 * 那正是启动时做的事。
 */
check('★ I-118 · 清空四张出厂表 → 下次启动自己补回来', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)

  const n = (t: string): number =>
    (r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
  const TABLES = ['tutors', 'genres', 'qtypes', 'prompt_presets']

  // 全新库：迁移已经播过种
  for (const t of TABLES) assert(n(t) > 0, `全新库里 ${t} 就是空的 —— 迁移没播种？`)

  // 清空（模拟出厂重置 / 老的「连设置一起清」）
  for (const t of TABLES) r.db.prepare(`delete from "${t}"`).run()
  for (const t of TABLES) assert(n(t) === 0, `${t} 没清掉`)

  // 「下次启动」
  const res = ensureBuiltins(r.db)
  for (const t of TABLES) {
    assert(n(t) > 0, `★ ${t} 没有补回来 —— 恢复出厂之后比全新安装还差`)
    assert(res.filled[t] > 0, `${t} 补了但没报出来`)
  }
  /**
   * ★ 2026-09-08（D-478）· 这里原来验「五个难度档都补回来了」。档位取消后，
   *   该验的是**出厂那 12 种都回来了** —— 少补几种的表现是「练着练着某些形式再也不出现」。
   */
  const backKeys = (r.db.prepare(`select key from qtypes where deleted_at is null`).all() as {
    key: string
  }[]).length
  assert(backKeys === 12, `出厂题型没补齐：只有 ${backKeys} 种`)

  /**
   * ★ 只在**整张表空**的时候补。
   * 他删到只剩一个导师，那是他的选择，不该下次启动又冒出三个。
   */
  r.db.prepare(`delete from tutors where id not in (select id from tutors limit 1)`).run()
  const before = n('tutors')
  ensureBuiltins(r.db)
  assert(n('tutors') === before, `他只留了 ${before} 个导师，却被补成了 ${n('tutors')} 个`)

  r.db.close()
})

checkAsync('★ 清除全部数据：逐表清到 0，而备份和词典一个不动', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  repo.addChunks(1, '我的收集', 'hold sway over')
  repo.addOriginal(1, '原文', 'They hold sway over the region.', 'paste')

  const before = (
    r.db.prepare(`select count(*) as n from items`).get() as { n: number }
  ).n
  assert(before > 0, '造数据没造出来，后面白测')

  // 词典目录里放一个假词典 —— 它必须活下来（22 本词典的教训）
  const dictDir = join(dir, 'dicts')
  mkdirSync(dictDir, { recursive: true })
  writeFileSync(join(dictDir, '假词典.mdx'), 'not a real dict', 'utf8')

  const audioDir = join(dir, 'audio')
  mkdirSync(audioDir, { recursive: true })
  writeFileSync(join(audioDir, 'a.mp3'), 'x', 'utf8')

  const logsDir = join(dir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  writeFileSync(join(logsDir, 'nyx.log'), 'old log', 'utf8')

  const promptsDir = join(dir, 'prompts')
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, 'analyze-material.md'), '他改过的提示词', 'utf8')

  let sessionCleared = false
  const res = await factoryReset({
    db: r.db,
    paths: {
      root: dir,
      data: dir,
      backups,
      audio: audioDir,
      logs: logsDir,
      prompts: promptsDir,
      shippedPrompts: join(dir, 'shipped'),
      dicts: dictDir,
      resources: dir,
      db: p
    },
    clearSession: async () => {
      sessionCleared = true
    }
  })

  assert(res.ok, `有步骤失败了：${res.steps.filter((s) => !s.ok).map((s) => s.name + '/' + s.detail).join(' · ')}`)
  assert(sessionCleared, '没有清 Electron 的会话存储')
  assert(existsSync(res.backup), `动手前那份备份不见了：${res.backup}`)

  // ① 逐表数到 0（migration_log 除外 —— 它是升级履历，不是他的数据）
  const tables = (
    r.db
      .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
      .all() as { name: string }[]
  )
    .map((x) => x.name)
    .filter((t) => t !== 'migration_log')
  /**
   * ★★ Step 1C · D-273 · `settings` 例外：它现在应该**正好**只剩同步身份那几个键。
   *
   * 这一条以前写的是「所有表都数到 0」，而那正是 F-05 那个洞的形状 ——
   * 第 ② 步刚挂的同步墓碑被第 ③ 步一起抹掉，测试还在为它背书。
   * 现在改成「除了保留清单，一行都不许剩」，比原来更严，不是更松。
   */
  const guard = PRESERVED_SYNC_KEYS.map((k) => `'${k}'`).join(', ')
  const left = tables
    .map((t) => ({
      t,
      n:
        t === 'settings'
          ? (r.db
              .prepare(`select count(*) as n from settings where key not in (${guard})`)
              .get() as { n: number }).n
          : (r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
    }))
    .filter((x) => x.n > 0)
  assert(left.length === 0, `这几张表没清干净：${left.map((x) => x.t + '(' + x.n + ')').join('、')}`)

  // ★★ 而保留清单里的键必须**还在**（F-05：它们是同步身份与不可逆事实）
  const kept = (
    r.db
      .prepare(`select count(*) as n from settings where key in (${guard})`)
      .get() as { n: number }
  ).n
  assert(kept > 0, '★★ 同步身份与墓碑被一起清掉了 —— 云端老数据会全部拉回来（F-05）')

  // ② 该留的
  assert(existsSync(join(dictDir, '假词典.mdx')), '★ 词典被删了 —— 这正是 6.5 GB 那次的错')
  assert(!existsSync(join(audioDir, 'a.mp3')), '朗读缓存没清')
  assert(!existsSync(join(logsDir, 'nyx.log')), '日志没清')
  assert(!existsSync(join(promptsDir, 'analyze-material.md')), '他改过的提示词没重置')
  assert(
    (r.db.prepare(`select count(*) as n from migration_log`).get() as { n: number }).n >= 0,
    'migration_log 表被删了 —— 升级履历应该留着'
  )

  // ③ 备份目录里那份还在（后悔了要能回来）
  assert(readdirSync(backups).some((f) => f.includes('before-reset')), '没找到清除前那份备份')

  /**
   * ★ I-118 · 清完之后「下次启动」要把出厂内容补回来。
   * 不补的话，恢复出厂得到的状态比全新安装还差：
   * 没有导师（聊天报错）、没有体裁和题型（**静默降级**）。
   */
  ensureBuiltins(r.db)
  for (const t of ['tutors', 'genres', 'qtypes', 'prompt_presets']) {
    const left = (r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
    assert(left > 0, `★ 恢复出厂之后 ${t} 还是空的 —— 比全新安装还差`)
  }

  r.db.close()
})

/**
 * ★ C-1 · 导回：无论来源多坏、哪一步失败，当前这份数据都必须活着
 *
 * 老流程的危险在**顺序**：备份 → 关库 → 删 -wal/-shm → 直接覆盖 → 重启。
 * 来源文件一个字节都没验过。他选错一个 .db，好数据当场被盖掉，
 * 重启后打不开，走 fatal() 弹框退出 —— 软件从此起不来。
 *
 * 新流程：验源 → 备份 → 写临时 → 验临时 → 原子替换。
 * 下面每一条都断言同一件事：**失败之后，原来的库还能打开、数据还在**。
 */
function c1Fixture(): { p: string; backups: string; dir: string; r: ReturnType<typeof openDatabase> } {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  new Repo(r.db).addChunks(1, '我的收集', 'hold sway over')
  return { p, backups, dir, r }
}

/** 原库还好好的吗：能打开、表在、数据在 */
function stillGood(p: string, want: number): void {
  const d = new Database(p, { readonly: true })
  try {
    const n = (d.prepare(`select count(*) as n from items`).get() as { n: number }).n
    assert(n === want, `原库的数据变了：应该 ${want} 条，实际 ${n} 条`)
  } finally {
    d.close()
  }
}

for (const bad of [
  {
    name: '非 SQLite 文件（就是段文本）',
    make: (f: string): void => writeFileSync(f, '这不是数据库，只是一段话。', 'utf8')
  },
  {
    name: '空文件（0 字节）',
    make: (f: string): void => writeFileSync(f, '', 'utf8')
  },
  {
    name: '别人的 SQLite（能打开，但不是 Nyx 的）',
    make: (f: string): void => {
      const d = new Database(f)
      d.exec(`create table shopping (id integer primary key, item text)`)
      d.prepare(`insert into shopping (item) values ('milk')`).run()
      d.close()
    }
  },
  {
    name: '缺关键表的 Nyx 库（只剩 settings）',
    make: (f: string): void => {
      const d = new Database(f)
      d.exec(`create table settings (key text primary key, value text, updated_at integer)`)
      d.pragma('user_version = 18')
      d.close()
    }
  },
  {
    name: '损坏的 SQLite（头是对的，内容被涂掉）',
    make: (f: string): void => {
      const d = new Database(f)
      d.exec(`create table settings (key text primary key, value text, updated_at integer)`)
      d.exec(`create table migration_log (id integer primary key, name text, updated_at integer)`)
      for (let i = 0; i < 200; i++) {
        d.prepare(`insert into settings (key,value,updated_at) values (?,?,?)`).run(`k${i}`, 'v'.repeat(200), 1)
      }
      d.close()
      // 把中间的页涂成垃圾 —— 头还在，quick_check 会发现
      const buf = readFileSync(f)
      buf.fill(0xff, 4096, Math.min(buf.length, 12288))
      writeFileSync(f, buf)
    }
  },
  {
    name: '来自更新版本的备份（结构比当前软件新）',
    make: (f: string): void => {
      const { db: p2, backups: b2 } = freshDir()
      const r2 = openDatabase(p2, b2)
      r2.db.pragma(`user_version = ${MIGRATIONS.length + 5}`)
      r2.db.close()
      copyFileSync(p2, f)
    }
  },
  {
    name: '旁边带 -wal 的（从正在用的库直接拷的，不完整）',
    make: (f: string): void => {
      const { db: p2, backups: b2 } = freshDir()
      const r2 = openDatabase(p2, b2)
      r2.db.close()
      copyFileSync(p2, f)
      writeFileSync(f + '-wal', 'pretend wal', 'utf8')
    }
  }
]) {
  checkAsync(`★ C-1 · 拒绝导回：${bad.name}`, async () => {
    const { p, backups, dir, r } = c1Fixture()
    const before = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
    const src = join(dir, 'bad.db')
    bad.make(src)

    let threw = false
    try {
      await new Exporter(r.db).restoreFrom(src, p, backups, MIGRATIONS.length)
    } catch {
      threw = true
    }
    assert(threw, `★ 这种来源居然被接受了：${bad.name} —— 好数据会被它盖掉`)

    // 当前库**必须还开着**（验证阶段失败不许关库），而且数据没动
    const n = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
    assert(n === before, `拒绝之后当前库的数据变了：${before} → ${n}`)
    r.db.close()
    stillGood(p, before)

    // 不许留下临时文件
    const junk = readdirSync(dirname(p)).filter((f) => /\.tmp\.db$/.test(f))
    assert(junk.length === 0, `留下了临时文件：${junk.join('、')}`)
  })
}

checkAsync('★ C-1 · 来源文件不存在 → 拒绝，原库不动', async () => {
  const { p, backups, dir, r } = c1Fixture()
  const before = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
  let threw = false
  try {
    await new Exporter(r.db).restoreFrom(join(dir, '根本没有这个.db'), p, backups, MIGRATIONS.length)
  } catch {
    threw = true
  }
  assert(threw, '来源不存在却没有拒绝')
  r.db.close()
  stillGood(p, before)
})

checkAsync('★ C-1 · 临时文件写不出去（目录不可用）→ 拒绝，原库不动', async () => {
  const { p, backups, dir, r } = c1Fixture()
  const before = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n

  // 做一份**合法**的备份当来源 —— 这一条要验的是「验证通过之后写临时失败」
  const good = join(dir, 'good.db')
  new Exporter(r.db).backupTo(good)

  // 把 dbPath 指到一个不存在的目录：临时文件写不出去
  const nowhere = join(dir, '不存在的目录', 'nyx.db')
  let threw = false
  try {
    await new Exporter(r.db).restoreFrom(good, nowhere, backups, MIGRATIONS.length)
  } catch {
    threw = true
  }
  assert(threw, '临时文件写不出去却没有报错')
  r.db.close()
  stillGood(p, before)
})

checkAsync('★ C-1 · 正常情况：合法备份导得回来，数据对得上', async () => {
  const { p, backups, dir, r } = c1Fixture()
  const good = join(dir, 'good.db')
  new Exporter(r.db).backupTo(good)
  const want = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n

  // 之后再改一改当前库 —— 导回应该把它换回备份那一刻的样子
  new Repo(r.db).addChunks(1, '导回之后不该有的', 'this should be gone after restore')
  const dirty = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
  assert(dirty > want, '造脏数据没造上')

  const out = await new Exporter(r.db).restoreFrom(good, p, backups, MIGRATIONS.length)
  assert(existsSync(out.safetyBackup), '导回前那份备份不见了')

  const d = new Database(p, { readonly: true })
  const n = (d.prepare(`select count(*) as n from items`).get() as { n: number }).n
  d.close()
  assert(n === want, `导回之后条数不对：应该 ${want}，实际 ${n}`)

  // 临时文件要清干净，-wal/-shm 不许留下旧的
  const junk = readdirSync(dirname(p)).filter((f) => /\.tmp\.db$/.test(f))
  assert(junk.length === 0, `留下了临时文件：${junk.join('、')}`)
  assert(!existsSync(p + '-wal'), '旧的 -wal 没清掉 —— 下次打开会拿它去「恢复」新库')
})

/**
 * ★★ C-1 的负向对照：**旧流程真的会把好数据毁掉**
 *
 * 这一条不测新代码，它**复刻老流程**（备份 → 关库 → 删 -wal/-shm → 直接覆盖），
 * 然后证明：随便给一个非 Nyx 文件，当前那份好数据就没了、库也打不开。
 *
 * 为什么把它永久留在用例里，而不是临时把产品代码改回去跑一次：
 * 临时改一次只有我看见，改回来就没了。留成用例，它是**这条修复存在的理由**本身 ——
 * 谁哪天觉得「验证是不是太啰嗦了，去掉一点」，先看这条会发生什么。
 */
checkAsync('★★ C-1 负向对照 · 老流程（不验来源直接覆盖）会毁掉当前数据库', async () => {
  const { p, backups, dir, r } = c1Fixture()
  const before = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
  assert(before > 0, '造数据没造上')

  const src = join(dir, 'not-a-db.db')
  writeFileSync(src, '他在文件对话框里点错了一个文件。', 'utf8')

  // ── 老流程，逐行照抄 ──────────────────────────────────────
  makeBackup(r.db, backups, 'before-restore')
  r.db.close()
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(p + suffix)) rmSync(p + suffix)
  }
  copyFileSync(src, p)
  // ────────────────────────────────────────────────────────

  // 现在的 nyx.db 是什么？—— 打不开了
  let opened = false
  try {
    const d = new Database(p, { readonly: true })
    d.prepare(`select count(*) from items`).get()
    d.close()
    opened = true
  } catch {
    opened = false
  }
  assert(
    !opened,
    '★ 负向对照本身失效了：老流程居然没把库弄坏 —— 这条用例没在验它该验的东西'
  )

  /**
   * 这就是他会遇到的：重启之后 `openDatabase` 打不开，走 `fatal()` 弹框退出，
   * **软件从此起不来**。安全备份确实还在，但要他自己去 data/backups 找、
   * 改名、放回去 —— 而他零编程经验。
   */
  const saved = readdirSync(backups).filter((f) => f.includes('before-restore'))
  assert(saved.length === 1, `安全备份应该有一份，实际 ${saved.length} 份`)
  const back = new Database(join(backups, saved[0]!), { readonly: true })
  const n = (back.prepare(`select count(*) as n from items`).get() as { n: number }).n
  back.close()
  assert(n === before, `连备份里的数据都不对：应该 ${before}，实际 ${n}`)
})

/**
 * ★ C-1 · 替换那一步失败（目标文件被别的进程占着）
 *
 * Windows 上这是最真实的一种：杀毒软件扫到 `nyx.db` 会短暂持有句柄，
 * 这时 `rename` 报 EPERM / EBUSY。新流程会重试 6 次（约 0.7 秒），
 * 还不行就**中止**——而这时 `nyx.db` 一个字节都没被动过（rename 失败不写目标）。
 *
 * 这里用「另开一个连接一直握着」来模拟占用。
 * 断言两件事：① 抛的是 `RestoreAborted`（调用方要据此重启，因为库已经关了）
 *            ② 原来的数据还在、还能打开
 */
checkAsync('★ C-1 · 替换失败（文件被占用）→ 中止，原库完好', async () => {
  const { p, backups, dir, r } = c1Fixture()
  const before = (r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n

  const good = join(dir, 'good.db')
  new Exporter(r.db).backupTo(good)

  // 另一个连接死死握着目标文件 —— 模拟杀毒软件 / 另一个程序
  const hold = new Database(p)
  hold.prepare(`select count(*) from items`).get()

  let aborted = false
  let msg = ''
  try {
    await new Exporter(r.db).restoreFrom(good, p, backups, MIGRATIONS.length)
  } catch (err) {
    aborted = err instanceof RestoreAborted
    msg = err instanceof Error ? err.message : String(err)
  }
  hold.close()

  /**
   * 说明：Windows 上被占用时 rename 会失败；但**如果这一次它居然成功了**
   * （某些文件系统 / 权限组合下允许），那也不算 bug —— 数据照样是对的。
   * 所以这里不强求一定 abort，只要求：**要么中止且数据完好，要么成功且数据完好**。
   * 硬要求「必须失败」会让这条用例在别的机器上假红。
   */
  const d = new Database(p, { readonly: true })
  const n = (d.prepare(`select count(*) as n from items`).get() as { n: number }).n
  d.close()
  assert(n === before, `原库数据变了：${before} → ${n}（中止=${aborted}，${msg.slice(0, 80)}）`)

  // 无论哪条路，都不许留下临时文件
  const junk = readdirSync(dirname(p)).filter((f) => /\.tmp\.db$/.test(f))
  assert(junk.length === 0, `留下了临时文件：${junk.join('、')}`)
})

/**
 * ★ H-1 · lecture 不许永久卡在「分析中」
 *
 * `analyzing` 既不是 `review` 也不是 `training`，工作台上
 * 「这批我看过了 · 开始学」那个按钮不出现 —— 卡住就等于这一讲被废掉。
 *
 * 两层各验各的：
 *   ① `analyzeLecture` 无论从哪条路出去都要收尾（try/finally）
 *   ② 进程被直接杀掉时 finally 根本不跑 → 启动自愈兜底
 */

/**
 * 造一讲**干净的**：有材料待分析，但一条知识点都没有、也没有排期。
 *
 * 不能直接用 seedTree 那三讲 —— 它们都带着知识点和 due_at，
 * 于是「该回 empty」的期望永远落空。第一版就栽在这儿，
 * 失败信息是「应该 empty，实际 review」，看着像代码错，其实是 fixture 不真实。
 */

/** 有知识点的那一讲（seedTree 的 1 号）—— 用来验「部分结果保住」 */
function lectureWithMaterial(r: ReturnType<typeof openDatabase>): number {
  new Repo(r.db).addOriginal(1, '待分析的原文', 'They hold sway over the region.', 'paste')
  return 1
}

/**
 * 故障注入：让某一条 SQL 一执行就炸。
 *
 * 为什么要这么干 —— 我一开始想用「prompt 文件读不到」当触发点，
 * 结果发现 `loadPrompt` **缺文件时不抛**，它退回内置副本。
 * `resolveSlot` 解不开 key 时也不抛，它当成没配。
 * 也就是说这两条我原先以为的触发路径**并不存在**。
 *
 * 真实世界里剩下的触发点是「进程被直接杀掉」（finally 根本不跑，
 * 由启动自愈那一层兜）和「库写入失败」。后者没法自然造出来，
 * 所以在这里精确注入：分析循环开头那句 `insert into analysis_jobs`
 * **在外层 try 之内、内层 try 之外** —— 正是会一路冒到 finally 的那条路。
 */

// ── 层一：analyzeLecture 自己收尾 ────────────────────────────

checkAsync('★ H-1 · 中途抛异常 → 状态不许留在 analyzing', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const lec = cleanLecture(r)

  const boom = dbThatFailsOn(r.db, 'insert into analysis_jobs')
  let threw = false
  try {
    await analyzeLecture(lec, { ...analyzeDeps(r, dir), db: boom })
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没有冒出来')
  const st = statusOf(r.db, lec)
  assert(st !== 'analyzing', `★ 卡在 analyzing 了 —— 这一讲等于废掉`)
  assert(st === 'empty', `一条都没捞到、也没排期，应该回 empty，实际 ${st}`)
  r.db.close()
})

checkAsync('★ H-1 · 本来在轮转（training）的讲，分析失败要放回 training', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const lec = lectureWithMaterial(r)

  // 先让它进轮转
  const t = Date.now()
  r.db
    .prepare(`update lectures set status='training', due_at=?, interval_days=1 where id=?`)
    .run(t + 86400000, lec)

  try {
    await analyzeLecture(lec, { ...analyzeDeps(r, dir), db: dbThatFailsOn(r.db, 'insert into analysis_jobs') })
  } catch {
    /* 意料之中 */
  }

  const st = statusOf(r.db, lec)
  assert(
    st === 'training',
    `★ 重新分析失败把一个轮转中的讲打成了 ${st} —— 下次「开始学」会把排期重设成 1 天后`
  )
  const due = (r.db.prepare(`select due_at as d from lectures where id=?`).get(lec) as { d: number })
    .d
  assert(due !== null, '排期被清掉了')
  r.db.close()
})

checkAsync('★ H-1 · 已经捞到东西时失败 → 回 review，部分结果保住', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const lec = lectureWithMaterial(r)
  // 造出「这一讲已经有知识点」的既成事实
  new Repo(r.db).addChunks(lec, '我的收集', 'hold sway over')

  r.db.prepare(`update lectures set due_at = null where id = ?`).run(lec)
  try {
    await analyzeLecture(lec, { ...analyzeDeps(r, dir), db: dbThatFailsOn(r.db, 'insert into analysis_jobs') })
  } catch {
    /* 意料之中 */
  }
  assert(
    statusOf(r.db, lec) === 'review',
    `有知识点却没回 review，实际 ${statusOf(r.db, lec)} —— 部分结果没被承认`
  )
  r.db.close()
})

// ── 层二：启动自愈 ──────────────────────────────────────────

check('★ H-1 · 启动自愈：进程被杀留下的 analyzing，按数据恢复', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()

  // 三讲，各自代表一种「本来是什么」
  //  1 号：曾经 startLearning 过（有 due_at）→ 该回 training
  //  2 号：有知识点、没排期        → 该回 review
  //  3 号：什么都没有             → 该回 empty
  new Repo(r.db).addChunks(1, '我的收集', 'hold sway over')
  r.db.prepare(`update lectures set status='analyzing', due_at=? where id=1`).run(t + 86400000)
  // seedTree 只给 1、3 号挂了知识点，2 号是空的 —— 给它一条**没出现过**的说法
  //（重复词条走「重复收集」那条路，不新建条目）
  new Repo(r.db).addChunks(2, '我的收集', 'a stone throw from')
  r.db.prepare(`update lectures set status='analyzing', due_at=null where id=2`).run()
  // 第三种情况要一讲**什么都没有**的 —— seedTree 那三讲都带着知识点和 due_at
  cleanLecture(r)
  r.db.prepare(`update lectures set status='analyzing', due_at=null where id=9`).run()

  const res = recoverStuckAnalyzing(r.db)
  assert(res.fixed.length === 3, `应该收拾 3 讲，实际 ${res.fixed.length}`)
  assert(statusOf(r.db, 1) === 'training', `1 号该回 training，实际 ${statusOf(r.db, 1)}`)
  const cnt2 = (
    r.db
      .prepare(
        `select count(*) as n from item_lectures il join items i on i.id = il.item_id
          where il.lecture_id = 2 and i.deleted_at is null`
      )
      .get() as { n: number }
  ).n
  assert(
    statusOf(r.db, 2) === 'review',
    `2 号该回 review，实际 ${statusOf(r.db, 2)}（这一讲的知识点数 = ${cnt2}）`
  )
  assert(statusOf(r.db, 9) === 'empty', `干净那一讲该回 empty，实际 ${statusOf(r.db, 9)}`)

  // 留痕：他在日志里看得见发生过什么，不是状态莫名其妙变了
  const logs = (
    r.db.prepare(`select count(*) as n from lecture_logs where event='recovered'`).get() as {
      n: number
    }
  ).n
  assert(logs === 3, `应该留 3 条恢复记录，实际 ${logs}`)
  r.db.close()
})

check('★ H-1 · 启动自愈不许碰 review / training / empty 的讲', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  r.db.prepare(`update lectures set status='review' where id=1`).run()
  r.db.prepare(`update lectures set status='training', due_at=? where id=2`).run(t)
  r.db.prepare(`update lectures set status='empty' where id=3`).run()

  const res = recoverStuckAnalyzing(r.db)
  assert(res.fixed.length === 0, `不该动任何一讲，却动了 ${res.fixed.length} 讲`)
  assert(statusOf(r.db, 1) === 'review', `1 号被动了：${statusOf(r.db, 1)}`)
  assert(statusOf(r.db, 2) === 'training', `2 号被动了：${statusOf(r.db, 2)}`)
  assert(statusOf(r.db, 3) === 'empty', `3 号被动了：${statusOf(r.db, 3)}`)
  r.db.close()
})

check('★ H-1 · 已删除的讲不去打扰它', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  r.db
    .prepare(`update lectures set status='analyzing', deleted_at=? where id=1`)
    .run(Date.now())
  const res = recoverStuckAnalyzing(r.db)
  assert(res.fixed.length === 0, '把垃圾箱里的讲也收拾了 —— 它不该被动')
  r.db.close()
})

/**
 * ★ N-2 · 「这次分析没跑成」不该摧毁这一讲已经成立的状态
 *
 * 原来最后一行是 `anySuccess ? 'review' : 'empty'`，而 `anySuccess` 的真实含义是
 * **这次至少成功处理了一份材料** —— 它为假时（key 过期、断网、材料全失败）
 * 一个已经在轮转、有几十条知识点、有排期的讲会被写成 `empty`。
 *
 * 后果不止是显示不对：今日队列的条件是 `status='training' and due_at is not null`，
 * 状态一掉，**这一讲从今日练习里彻底消失**，而 due_at 还在。
 *
 * 下面每条都同时验三件事：状态对不对、**due_at 有没有被动**、已有数据在不在。
 */

const itemCount = (db: InstanceType<typeof Database>, id: number): number =>
  (
    db
      .prepare(
        `select count(*) as n from item_lectures il join items i on i.id = il.item_id
          where il.lecture_id = ? and i.deleted_at is null`
      )
      .get(id) as { n: number }
  ).n

/** 造一讲「已经在轮转」的：有知识点、有排期、有学习记录 */
function trainingLecture(r: ReturnType<typeof openDatabase>): { id: number; due: number } {
  const t = Date.now()
  const id = 1
  new Repo(r.db).addChunks(id, '我的收集', 'hold sway over')
  new Repo(r.db).addOriginal(id, '待重新分析的原文', 'They hold sway over the region.', 'paste')
  const due = t + 3 * 86400000
  r.db
    .prepare(`update lectures set status='training', due_at=?, interval_days=3 where id=?`)
    .run(due, id)
  return { id, due }
}

checkAsync('★ N-2 · training + 重新分析 + 一份都没跑成 → 还是 training，排期不动', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { id, due } = trainingLecture(r)
  const items = itemCount(r.db, id)

  /**
   * 让**每一份材料都失败**（AI 调用那一步炸）→ done=0、added=0 → anySuccess=false。
   * 这正是 key 过期 / 断网时的真实形状。注意这条路是**正常返回**的，
   * 不是抛异常 —— 所以它验的是正常路径那一行判据，不是 H-1 的 finally。
   */
  const res = await analyzeLecture(id, analyzeDeps(r, dir))
  assert(res.added === 0, `这一条要的是「什么都没捞到」，实际 added=${res.added}`)

  const row = lecRow(r.db, id)
  assert(row.status === 'training', `★ 被打成了 ${row.status} —— 这一讲会从今日练习里消失`)
  assert(row.dueAt === due, `★ 排期被动了：${due} → ${row.dueAt}`)
  assert(row.interval === 3, `间隔被动了：3 → ${row.interval}`)
  assert(itemCount(r.db, id) === items, `已有知识点被动了：${items} → ${itemCount(r.db, id)}`)
  r.db.close()
})

checkAsync('★ N-2 · review + 重新分析 + 一份都没跑成 → 还是 review', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { id } = trainingLecture(r)
  r.db.prepare(`update lectures set status='review', due_at=null, interval_days=0 where id=?`).run(id)

  await analyzeLecture(id, analyzeDeps(r, dir))
  assert(lecRow(r.db, id).status === 'review', `变成了 ${lecRow(r.db, id).status}`)
  r.db.close()
})

checkAsync('★ N-2 · empty + 重新分析 + 一份都没跑成 → 有知识点就 review，没有才 empty', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)

  // ① 干净的一讲：没有知识点 → empty
  const clean = cleanLecture(r)
  await analyzeLecture(clean, analyzeDeps(r, dir))
  assert(lecRow(r.db, clean).status === 'empty', `干净那一讲该是 empty，实际 ${lecRow(r.db, clean).status}`)

  // ② 有知识点但状态是 empty（比如上一轮被这个 bug 打下来的）→ 该回 review
  const { id } = trainingLecture(r)
  r.db.prepare(`update lectures set status='empty', due_at=null where id=?`).run(id)
  await analyzeLecture(id, analyzeDeps(r, dir))
  assert(
    lecRow(r.db, id).status === 'review',
    `有知识点却留在 ${lecRow(r.db, id).status} —— 状态和事实对不上`
  )
  r.db.close()
})

checkAsync('★ N-2 · training + 分析中途抛异常 → 还是 training，排期不动', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { id, due } = trainingLecture(r)

  try {
    await analyzeLecture(id, {
      ...analyzeDeps(r, dir),
      db: dbThatFailsOn(r.db, 'insert into analysis_jobs')
    })
  } catch {
    /* 意料之中 */
  }
  const row = lecRow(r.db, id)
  assert(row.status === 'training', `异常之后变成了 ${row.status}`)
  assert(row.dueAt === due, `异常之后排期被动了：${due} → ${row.dueAt}`)
  r.db.close()
})

checkAsync('★ N-2 · training + 用户取消 → 还是 training，排期不动', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { id, due } = trainingLecture(r)

  const ac = new AbortController()
  ac.abort() // 一进来就已经取消了 —— 循环第一句就 break
  await analyzeLecture(id, { ...analyzeDeps(r, dir), signal: ac.signal })

  const row = lecRow(r.db, id)
  assert(row.status === 'training', `取消之后变成了 ${row.status}`)
  assert(row.dueAt === due, `取消之后排期被动了：${due} → ${row.dueAt}`)
  r.db.close()
})

checkAsync('★ N-2 · 重新分析不许产生重复条目', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { id } = trainingLecture(r)
  const before = itemCount(r.db, id)

  await analyzeLecture(id, analyzeDeps(r, dir))
  await analyzeLecture(id, analyzeDeps(r, dir)).catch(() => null)

  assert(itemCount(r.db, id) === before, `重复分析多出了条目：${before} → ${itemCount(r.db, id)}`)
  r.db.close()
})

/**
 * ★★ D-4 · 取消静默要把排期放回来
 *
 * 判据原来写的是 `status = 'ready'` —— 这个状态值根本不存在，
 * 所以 CASE 永不命中、due_at 永不恢复：**那一讲静默一次就再也回不来了**。
 * 而 audit 里配套的检查查的是同一个错名字，**修复和检查一起瞎了**。
 */
const lecFull = (db: InstanceType<typeof Database>, id: number): { status: string; silent: number; dueAt: number | null; interval: number } =>
  db
    .prepare(
      `select status, silent, due_at as dueAt, interval_days as interval from lectures where id = ?`
    )
    .get(id) as { status: string; silent: number; dueAt: number | null; interval: number }

/** 造一讲「在轮转中」的：training + 有排期 + 有间隔 + 有学习记录 */
function inRotation(r: ReturnType<typeof openDatabase>, id: number, interval = 7): number {
  const t = Date.now()
  r.db
    .prepare(`update lectures set status='training', silent=0, due_at=?, interval_days=? where id=?`)
    .run(t + interval * 86400000, interval, id)
  return t + interval * 86400000
}

check('★ D-4 · training 讲静默再取消 → 排期回来了，间隔保留', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  inRotation(r, 1, 7)

  repo.setSilent('lecture', 1, true)
  const silenced = lecFull(r.db, 1)
  assert(silenced.silent === 1, '没静默成')
  assert(silenced.dueAt === null, '静默时该把排期清掉')
  assert(silenced.interval === 7, `静默不该动间隔，实际 ${silenced.interval}`)
  assert(silenced.status === 'training', `静默不该动 status，实际 ${silenced.status}`)

  repo.setSilent('lecture', 1, false)
  const back = lecFull(r.db, 1)
  assert(back.silent === 0, '没取消成')
  assert(
    back.dueAt !== null,
    '★ 取消静默之后还是没有排期 —— 这一讲永远不会再进「今日」'
  )
  assert(back.interval === 7, `间隔被动了：7 → ${back.interval}`)
  assert(back.status === 'training', `status 被动了：${back.status}`)
  r.db.close()
})

check('★ D-4 · 整个单元静默再取消，底下的 training 讲排期也要回来', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  inRotation(r, 1, 5)
  inRotation(r, 2, 9)

  repo.setSilent('unit', 1, true)
  assert(lecFull(r.db, 1).dueAt === null && lecFull(r.db, 2).dueAt === null, '静默没清排期')
  repo.setSilent('unit', 1, false)
  assert(lecFull(r.db, 1).dueAt !== null, '★ 1 号讲的排期没回来')
  assert(lecFull(r.db, 2).dueAt !== null, '★ 2 号讲的排期没回来')
  assert(lecFull(r.db, 1).interval === 5, '1 号的间隔被动了')
  assert(lecFull(r.db, 2).interval === 9, '2 号的间隔被动了')
  r.db.close()
})

check('★ D-4 · 项目静默再取消，同样要恢复', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  inRotation(r, 1, 3)
  repo.setSilent('project', 1, true)
  assert(lecFull(r.db, 1).dueAt === null, '静默没清排期')
  repo.setSilent('project', 1, false)
  assert(lecFull(r.db, 1).dueAt !== null, '★ 项目取消静默之后排期没回来')
  r.db.close()
})

check('★ D-4 · review / empty 的讲取消静默**不该**被塞一个到期日', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  r.db.prepare(`update lectures set status='review', due_at=null, interval_days=0 where id=1`).run()
  r.db.prepare(`update lectures set status='empty', due_at=null, interval_days=0 where id=2`).run()

  repo.setSilent('lecture', 1, true)
  repo.setSilent('lecture', 1, false)
  repo.setSilent('lecture', 2, true)
  repo.setSilent('lecture', 2, false)

  assert(lecFull(r.db, 1).dueAt === null, 'review 的讲被塞了到期日 —— 它该等审阅，不该排期')
  assert(lecFull(r.db, 2).dueAt === null, 'empty 的讲被塞了到期日')
  assert(lecFull(r.db, 1).status === 'review', 'review 的状态被动了')
  r.db.close()
})

check('★ D-4 · 静默来回一趟，学习记录一个字不许动', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  inRotation(r, 1, 7)

  const snap = (): string =>
    JSON.stringify({
      items: r.db.prepare(`select count(*) n from items where deleted_at is null`).get(),
      occ: r.db.prepare(`select count(*) n from occurrences`).get(),
      blocks: r.db.prepare(`select count(*) n from analysis_blocks`).get(),
      answers: r.db.prepare(`select count(*) n from answers`).get(),
      logs: r.db.prepare(`select count(*) n from review_logs`).get(),
      progress: r.db
        .prepare(`select i.id, i.attempts, i.corrects, i.streak, rc.interval_days as card_interval
                    from items i join reading_cards rc on rc.item_id = i.id order by i.id`)
        .all()
    })
  const before = snap()
  repo.setSilent('lecture', 1, true)
  repo.setSilent('lecture', 1, false)
  assert(snap() === before, '★ 静默来回一趟之后学习数据变了')
  r.db.close()
})

/**
 * ★★ D-4 的负向对照：把判据退回那个不存在的状态名，必须红。
 *
 * 不改产品代码 —— 直接照抄老 SQL 跑一遍，证明它什么都不做。
 * 这样这条对照是可重复的、留档的：谁哪天又想用一个状态名当判据，先看这条。
 */
check("★★ D-4 负向对照 · 用不存在的状态名当判据时，排期根本恢复不了", () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  inRotation(r, 1, 7)
  const t = Date.now()

  // 老流程：静默清排期
  r.db.prepare(`update lectures set silent=1, due_at=null, updated_at=? where id=1`).run(t)
  // 老流程：取消静默时按 'ready' 恢复
  r.db
    .prepare(
      `update lectures set due_at = coalesce(due_at, ?), updated_at = ?
        where id = ? and status = 'ready'`
    )
    .run(t, t, 1)
  r.db.prepare(`update lectures set silent=0 where id=1`).run()

  assert(
    lecFull(r.db, 1).dueAt === null,
    '★ 负向对照失效了：老判据居然恢复了排期 —— 这条用例没在验它该验的东西'
  )
  // 而这正是 audit 该抓到的形状
  const hit = audit(r.db).findings.find((f) => f.id === 'training-without-due')
  assert(hit, '★ 体检没抓到「在轮转中却没有到期日」—— 检查也瞎了')
  r.db.close()
})

// ── 历史脏数据 A：empty + 有知识点 ────────────────────────

check('★ N-2 存量 · empty 但有知识点 → 自愈成 review，别的字段一个不动', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  // 造出他库里 11 号讲那种形状：有知识点、状态却是 empty
  r.db
    .prepare(`update lectures set status='empty', due_at=?, interval_days=4 where id=1`)
    .run(t + 86400000)

  const snapshot = JSON.stringify({
    due: lecFull(r.db, 1).dueAt,
    interval: lecFull(r.db, 1).interval,
    items: r.db.prepare(`select id,attempts,corrects,streak from items order by id`).all(),
    occ: r.db.prepare(`select count(*) n from occurrences`).get(),
    blocks: r.db.prepare(`select count(*) n from analysis_blocks`).get(),
    mats: r.db.prepare(`select count(*) n from materials`).get(),
    answers: r.db.prepare(`select count(*) n from answers`).get(),
    settings: r.db.prepare(`select count(*) n from settings`).get()
  })

  // 修之前，体检要能看见
  assert(
    audit(r.db).findings.some((f) => f.id === 'empty-with-items'),
    '★ 体检没发现「状态是空却有知识点」'
  )

  const res = recoverAll(r.db)
  assert(res.fixed.some((f) => f.lectureId === 1 && f.to === 'review'), `没修：${JSON.stringify(res.fixed)}`)
  assert(lecFull(r.db, 1).status === 'review', `没改成 review，实际 ${lecFull(r.db, 1).status}`)

  const after = JSON.stringify({
    due: lecFull(r.db, 1).dueAt,
    interval: lecFull(r.db, 1).interval,
    items: r.db.prepare(`select id,attempts,corrects,streak from items order by id`).all(),
    occ: r.db.prepare(`select count(*) n from occurrences`).get(),
    blocks: r.db.prepare(`select count(*) n from analysis_blocks`).get(),
    mats: r.db.prepare(`select count(*) n from materials`).get(),
    answers: r.db.prepare(`select count(*) n from answers`).get(),
    settings: r.db.prepare(`select count(*) n from settings`).get()
  })
  assert(after === snapshot, '★ 除了 status 之外还动了别的东西')

  // 修完体检要绿
  assert(
    !audit(r.db).findings.some((f) => f.id === 'empty-with-items'),
    '修完体检还在报同一条'
  )
  r.db.close()
})

// ── 历史脏数据 B：training + 没有 due_at ──────────────────

check('★ D-4 存量 · 有间隔可依据 → 自动恢复；没有 → 只报不改', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  // 1 号：有间隔 → 敢修
  r.db
    .prepare(`update lectures set status='training', silent=0, due_at=null, interval_days=6 where id=1`)
    .run()
  // 2 号：没有间隔 → 不敢猜
  r.db
    .prepare(`update lectures set status='training', silent=0, due_at=null, interval_days=0 where id=2`)
    .run()

  // 修之前体检要能看见两条
  const before = audit(r.db).findings.find((f) => f.id === 'training-without-due')
  assert(before && before.count === 2, `体检该报 2 条，实际 ${before?.count ?? 0}`)

  const res = recoverAll(r.db)
  assert(lecFull(r.db, 1).dueAt !== null, '1 号有间隔可依据，该自动恢复排期')
  assert(lecFull(r.db, 1).interval === 6, '恢复时不该动间隔')
  assert(
    lecFull(r.db, 2).dueAt === null,
    '★ 2 号没有任何依据，却被凭空编了一个到期日 —— 这是在制造错误数据'
  )
  assert(
    res.reported?.some((x) => x.lectureId === 2),
    '2 号没修也没报 —— 那就是悄悄放过去了'
  )

  // 修完还剩 1 条（那条是有意留下的）
  const after = audit(r.db).findings.find((f) => f.id === 'training-without-due')
  assert(after && after.count === 1, `修完该剩 1 条，实际 ${after?.count ?? 0}`)
  r.db.close()
})

check('★ 自愈不许碰正常数据', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  r.db.prepare(`update lectures set status='training', silent=0, due_at=?, interval_days=3 where id=1`).run(t)
  r.db.prepare(`update lectures set status='review', due_at=null where id=2`).run()
  // 静默的讲没有 due_at 是**正常形态**，不许被当成异常
  r.db.prepare(`update lectures set status='training', silent=1, due_at=null, interval_days=5 where id=3`).run()

  const before = JSON.stringify(
    r.db.prepare(`select id,status,silent,due_at,interval_days from lectures order by id`).all()
  )
  const res = recoverAll(r.db)
  assert(res.fixed.length === 0, `不该动任何一讲，却动了 ${JSON.stringify(res.fixed)}`)
  assert((res.reported ?? []).length === 0, `不该报任何一条，却报了 ${JSON.stringify(res.reported)}`)
  assert(
    JSON.stringify(
      r.db.prepare(`select id,status,silent,due_at,interval_days from lectures order by id`).all()
    ) === before,
    '自愈动了正常数据'
  )
  r.db.close()
})

/**
 * ★ 给 `check:sql` 的那把尺子自己量一遍
 *
 * `scripts/check-sql.mjs` 靠正则从迁移脚本里解析表结构。
 * 解析器一旦漂了（新写法它认不出），检查就变成**一张永远绿的安慰牌** ——
 * 那比没有还糟：报警不响的时候，人是不会去怀疑报警器的。
 *
 * 所以这里拿**真迁移出来的库** `pragma table_info` 逐列比对。
 * 尺子不准，这条先红。
 */
check('★ check:sql 的表结构解析必须和真库逐列一致（尺子自己要准）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)

  const parsed = schemaFromMigrations() as Map<string, Set<string>> & { unresolved?: string[] }
  assert(!parsed.unresolved?.length, `有动态 DDL 解析不了：${parsed.unresolved?.join(' / ')}`)

  const real = (
    r.db
      .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((x) => x.name)

  for (const t of real) {
    const cols = new Set(
      (r.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
    )
    const got = parsed.get(t)
    assert(got, `解析器根本不知道有 \`${t}\` 这张表`)
    const missing = [...cols].filter((c) => !got.has(c))
    const extra = [...got].filter((c) => !cols.has(c))
    assert(
      missing.length === 0,
      `\`${t}\`：解析器漏了列 ${missing.join(', ')} —— check:sql 会漏报`
    )
    assert(
      extra.length === 0,
      `\`${t}\`：解析器多认了列 ${extra.join(', ')} —— check:sql 会漏掉真错误`
    )
  }
  r.db.close()
})

/**
 * ★ I-114 · 体检要认得出「欠着的原文出处」，而且点一下能补上
 *
 * 他的原话「原句摘抄的也不行」。根因是**顺序**：他先贴「我的收集」、后传原文，
 * 而出处只在写入那一刻找一次，回头没人补。
 *
 * 这条用例连带钉住一件事：**报出来几条，修完就得少几条。**
 * 报 N 条、修完还剩 N 条，比不报还伤 —— 那个按钮会变成摆设。
 */
check('★ I-114 · 先收集后传原文 → 体检认得出，修一下就补回真句子', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)

  const typed = 'The power of disposal of modern nation states'
  const sentence =
    'You compare that to the powers at the disposal of modern nation-states, and you can see the contrast.'

  // ① 这一讲还没有原文，他先把收集贴了进来
  const repo = new Repo(r.db)
  const ch = repo.addChunks(1, '我的收集', typed)
  const itemId = ch.added[0].id
  const quoteOf = (): string =>
    (
      r.db.prepare(`select quote from occurrences where item_id = ? limit 1`).get(itemId) as {
        quote: string
      }
    ).quote
  assert(
    quoteOf().toLowerCase() === typed.toLowerCase(),
    '这一步出处本来就该等于他打的那行（原文还没到）'
  )

  // ② 原文到了 —— 正常路径会当场补上，这里绕开它，造出他库里那种历史数据
  r.db
    .prepare(
      `insert into materials (lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
       values (1, 'original', '讲稿', 'paste', ?, ?, ?, ?)`
    )
    .run(sentence, sentence.length, Date.now(), Date.now())

  const found = audit(r.db).findings.find((f) => f.id === 'quote-backfillable')
  assert(found, '体检没认出「出处等于词条，而原文里找得到整句」')
  assert(found.count === 1, `认出的条数不对：${found.count}`)
  assert(found.impact.trim().length > 8, '没说清后果')

  repair(r.db)
  assert(
    quoteOf() === sentence,
    `修完出处还是「${quoteOf()}」—— 按钮报了问题却没解决，比不报更糟`
  )
  assert(
    !audit(r.db).findings.some((f) => f.id === 'quote-backfillable'),
    '修完体检还在报同一条'
  )
  r.db.close()
})

/**
 * ★ I-113 · 升级时怎么处理他改过的提示词
 *
 * 装完新版一查才发现的：`data/prompts` 是**一次性播种**的，之后升级一个字不动 ——
 * 于是他那份 analyse-item.md 还带着 12 处 hold sway（I-108 的污染源），
 * generate-questions.md 里没有 {{TYPES}}。
 * **题型复选框会点、会存，就是不生效**，而且不报错。整几轮的提示词工作全部落空。
 *
 * 这里验四种情形，最要紧的是第 ③ 种：**一个字都不许删**。
 */
check('★ I-113 · 提示词升级：没动过的更新，改过的不动，跑不起来的另存后换', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-psync-'))
  const shipped = join(dir, 'shipped')
  const live = join(dir, 'live')
  mkdirSync(shipped, { recursive: true })
  mkdirSync(live, { recursive: true })

  const mem = new Map<string, string>()
  const store = {
    get: (f: string): string | null => mem.get(f) ?? null,
    set: (f: string, h: string): void => void mem.set(f, h)
  }

  // 出厂新版：四份，都带占位符
  writeFileSync(join(shipped, 'a.md'), '新版 A {{TERM}} {{TYPES}}', 'utf8')
  writeFileSync(join(shipped, 'b.md'), '新版 B {{TERM}}', 'utf8')
  writeFileSync(join(shipped, 'c.md'), '新版 C {{TERM}} {{TYPES}}', 'utf8')
  writeFileSync(join(shipped, 'd.md'), '新版 D {{TERM}}', 'utf8')
  writeFileSync(join(shipped, 'README.txt'), '这是出厂默认', 'utf8')

  // ① 他没动过（指纹对得上）→ 应该直接更新
  writeFileSync(join(live, 'a.md'), '旧版 A {{TERM}} {{TYPES}}', 'utf8')
  store.set('a.md', require$hash('旧版 A {{TERM}} {{TYPES}}'))
  // ② 他改过、占位符齐 → 不动
  writeFileSync(join(live, 'b.md'), '我自己改的 B {{TERM}}', 'utf8')
  store.set('b.md', require$hash('原来的 B'))
  // ③ 他改过（或没记录）、**缺占位符** → 另存后换新
  writeFileSync(join(live, 'c.md'), '我自己改的 C {{TERM}}', 'utf8')
  // ④ 他那份根本不存在 → 直接拷

  const r = syncPrompts(shipped, live, store)

  assert(readFileSync(join(live, 'a.md'), 'utf8').includes('新版 A'), '① 没动过的没更新')
  assert(readFileSync(join(live, 'b.md'), 'utf8').includes('我自己改的 B'), '② 他改过的被覆盖了')
  assert(r.kept.includes('b.md'), '② 没提示「这份是你改过的」')

  assert(readFileSync(join(live, 'c.md'), 'utf8').includes('新版 C'), '③ 跑不起来的那份没换')
  const rep = r.replaced.find((x) => x.file === 'c.md')
  assert(rep !== undefined, '③ 换掉了却没报出来 —— 悄悄换掉比不换更糟')
  assert(existsSync(rep.savedTo), '★ ③ 他原来那份没另存 —— 一个字都不许删')
  assert(
    readFileSync(rep.savedTo, 'utf8').includes('我自己改的 C'),
    '★ 另存的内容不是他原来那份'
  )

  assert(existsSync(join(live, 'd.md')), '④ 缺的那份没补上')
  assert(!existsSync(join(live, 'README.txt')), '出厂 README 不该进使用者那份')

  // 再跑一次：应该什么都不做（幂等）——否则每次启动都会「又换了一次」
  const again = syncPrompts(shipped, live, store)
  assert(again.replaced.length === 0 && again.updated.length === 0, '不幂等：又换了一遍')

  rmSync(dir, { recursive: true, force: true })
})

/**
 * ★ 7 · 题型勾选真的存得下、读得回
 *
 * **为什么要这条**：`setQtypes` 里我把 insert 写成了
 * `settings (key, value, created_at, updated_at)` —— 而 settings 只有三列。
 * **类型检查完全看不见**（SQL 是字符串），静态检查全绿，
 * 而使用者一点那个复选框就炸。同一个错误我在 prompt-sync 里又写了一遍。
 *
 * 凡是碰 SQL 列名的地方，必须有一条**真的跑一次**的测试。
 */
check('★ 7 · 题型勾选存得下、读得回，越界的 id 不收', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')

  // 没设置过 = 全都要
  assert(study.qtypes().length >= 12, `默认没有全选：${study.qtypes().length}`)

  study.setQtypes(['造句', '错误订正', '不存在的题型'])
  const got = study.qtypes()
  assert(got.includes('造句') && got.includes('错误订正'), `存丢了：${got.join('/')}`)
  assert(!got.includes('不存在的题型'), '不认识的题型也收下了 —— 以后删掉某种题型时老设置会把它带回来')

  /**
   * ★ 2026-08-14 · 这一条的语义**被使用者改掉了**。
   *
   * 原来是「全部取消 → 退回全选」，理由是「练习不能因为勾选而卡死」。
   * 但实测下来代价更大：他清空之后照样出题，而且出的是全部题型 ——
   * 「清空」这个动作看起来毫无作用，他会以为软件坏了。
   *
   * 现在：清空就是清空，出题那一步当场拒绝并说人话（另有用例守着）。
   */
  study.setQtypes([])
  assert(study.qtypes().length === 0, '★★ 清空之后又被补成了全选 —— 那正是他要取消的默认题型')
  r.db.close()
})

// 界面上跑不了这一条：导回成功之后主进程会立刻重启，测试没法接着往下走。
// 但这条路一旦有 bug 就是**用一个文件把好数据抹了**，所以在这里单独验。
checkAsync('★ 导出 → 导回，数据一行不少；导回前那份也备份下来了（D-102 / D-232）', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const put = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, 0)
       on conflict(key) do update set value = excluded.value`
  )
  for (let i = 0; i < 7; i++) put.run(`orig_${i}`, `v${i}`)

  const exportPath = join(dir, 'exported.db')
  new Exporter(r.db).backupTo(exportPath)
  assert(existsSync(exportPath), '导出的文件根本没生成')

  // 导出之后又改了一通 —— 导回要能把这些改动整个盖掉
  for (let i = 0; i < 7; i++) put.run(`orig_${i}`, 'RUINED')
  put.run('added_after_export', 'x')

  const { safetyBackup } = await new Exporter(r.db).restoreFrom(exportPath, p, backups, MIGRATIONS.length)
  assert(existsSync(safetyBackup), 'D-232 说导回前要备份当前库 —— 那份备份不存在')

  const after = new Database(p, { readonly: true })
  const v0 = (after.prepare(`select value from settings where key = 'orig_0'`).get() as
    | { value: string }
    | undefined)?.value
  assert(v0 === 'v0', `导回之后值不对：${v0}`)
  const stray = after.prepare(`select 1 from settings where key = 'added_after_export'`).get()
  assert(!stray, '导回是覆盖不是合并 —— 导出之后新增的行不该还在')
  after.close()

  // 反悔：那份安全备份里应该是**导回前**的样子（被改坏的那份）
  const back = new Database(safetyBackup, { readonly: true })
  const ruined = (back.prepare(`select value from settings where key = 'orig_0'`).get() as
    | { value: string }
    | undefined)?.value
  assert(ruined === 'RUINED', `安全备份里不是导回前的数据：${ruined}`)
  back.close()

  rmSync(dir, { recursive: true, force: true })
})

