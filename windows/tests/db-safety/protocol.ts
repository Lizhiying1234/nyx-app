/**
 * 同步协议前半：Step 1A 指纹握手 · 1B / 1C / 1D · Step 2 确定性身份 · Step 3 边界翻译 · Step 4 目标结构（--schema 只跑这一批）· Step 5A / 5B
 *
 * 原 tests/db-safety.ts 第 14086–17049 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { MIGRATIONS, SYNC_TABLES, TARGET_VERSION } from '../../src/main/db/migrations.ts'
import { V29_PREFS } from '../../src/main/db/migrations/v20-v29.ts'
import { Exporter } from '../../src/main/export.ts'
import { recordOccurrence } from '../../src/main/db/repo.ts'
import { QTypes } from '../../src/main/db/qtypes.ts'
import { Dicts } from '../../src/main/dict/index.ts'
import { dictUid } from '../../src/core/dict/identity.ts'
import { ParamStore } from '../../src/main/params.ts'
import { Prefs } from '../../src/main/db/prefs.ts'
import { ENC_PREFIX, isEncrypted, migratePlaintextSyncSecret, SecretStore, setCrypto, type Crypto } from '../../src/main/db/secrets.ts'
import { Tts } from '../../src/main/tts.ts'
import { checkPrefKey, checkPrefValue, looksLikeSecret, PREF_KEYS, PREF_SPECS, prefUid, type PrefSpec } from '../../src/core/prefs.ts'
import { Study } from '../../src/main/study.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { schemaIdentity } from '../../src/main/db/fingerprint.ts'
import { localSchemaOf, normalizeDdl } from '../../src/main/db/schema-dump.ts'
import type { NyxPaths } from '../../src/main/paths.ts'
import { SYNC_PROTOCOL_VERSION } from '../../src/core/sync-protocol.ts'
import { analysisBlockUid, escapePart, isNaturalUid, itemLectureUid, natUid, occurrenceLectureUid, occurrenceMaterialUid, qtypeUid, sqlEscapePart, sqlNatUid, termLedgerUid, tombstoneUid } from '../../src/core/identity.ts'
import { hardDelete } from '../../src/core/cascade.ts'
import { wrapDb } from '../../src/main/db/async-db.ts'
import { droppedOf, dynamicOf, EXTRA_RELATIONS, relationsOf, SCOPE_TABLES, syncColumnOf } from '../../src/core/fk-map.ts'
import { PRESERVED_SYNC_KEYS } from '../../src/core/sync-metadata.ts'
import { makeStore } from '../../src/main/sync/store.ts'
import { lastSyncProblems } from '../../src/main/sync/problems.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { factoryReset } from '../../src/main/factory-reset.ts'
import { check, checkAsync, checkAsyncSerial, assert, freshDir } from './harness.ts'
import { seedTree, makeBook, cloudFiles, cloudPort, fakeServer, cloudReady, localIdentity, putChunk, putLegacyChunk, putRaw, configureSync, syncState, packOf, newSync, r4Run, V27, twoDevices } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ Step 1A · 结构指纹 / 协议版本握手（2026-08-17）
//
// 守的是一句话：**结构或协议对不上时，整包不收，而且不许标成已处理。**
// 收一半、丢几列、标 applied —— 三件事任何一件发生，两端就永久差一截，
// 而四个数全对、体检不亮。那正是这个项目最贵的失败形态。
// ══════════════════════════════════════════════════════════════

checkAsync('★★ Step 1A · 两次全新迁移出来的库，同步表指纹相同', async () => {
  /**
   * 指纹方案的地基。它要是不稳定，握手就会天天误报，
   * 两次之后就没人信了 —— 那比没有握手更糟。
   */
  const a = freshDir()
  const b = freshDir()
  const ra = openDatabase(a.db, a.backups)
  const rb = openDatabase(b.db, b.backups)
  const ia = await schemaIdentity(ra.db)
  const ib = await schemaIdentity(rb.db)
  assert(
    ia.schemaFingerprint === ib.schemaFingerprint,
    `★★ 同一份代码建出来的两个库指纹不一样：${ia.schemaFingerprint} vs ${ib.schemaFingerprint}`
  )
  assert(ia.schemaVersion === TARGET_VERSION, `结构版本不对：${ia.schemaVersion}`)
  assert(/^[0-9a-f]{16}$/.test(ia.schemaFingerprint), `指纹形状不对：${ia.schemaFingerprint}`)
  ra.db.close()
  rb.db.close()
})

checkAsync('★★ Step 1A · 指纹只算同步表 —— 本地表不一样不该影响它', async () => {
  /**
   * Android 本来就没有 `dictionaries`（词典是本机文件）。
   * 全库指纹会把「平台本来就不同」误判成结构不兼容，那条路走不通。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const before = (await schemaIdentity(r.db)).schemaFingerprint
  r.db.exec(`create table if not exists local_only_thing (id integer primary key, x text)`)
  const after = (await schemaIdentity(r.db)).schemaFingerprint
  assert(before === after, '★ 加一张本地表就把指纹改了 —— Android 会被永久判成不兼容')
  r.db.close()
})

checkAsync('★★ Step 1A · 同步表少一列 → 指纹必须变', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const before = (await schemaIdentity(r.db)).schemaFingerprint
  r.db.exec(`alter table items drop column gloss_zh`)
  const after = (await schemaIdentity(r.db)).schemaFingerprint
  assert(before !== after, '★★ 少一列指纹没变 —— 那一列的值会被静默丢掉')
  r.db.close()
})

checkAsync('★★ Step 1A · 包头正常 → 照常收（新路径真的被走到了）', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-ok')
  const sync = newSync(r, backups)
  putChunk('s1a-ok', 'other-100.json', packOf(true, false))

  const out = await r4Run(sync)
  assert(out.applied === 1, `该落库 1 行，实际 ${out.applied}`)
  assert((out.rejected ?? 0) === 0, `不该有整包被拒：${JSON.stringify(out.rejections)}`)
  assert((out.legacyChunks ?? 0) === 0, '带了正确包头的包被当成 legacy 了')
  assert(syncState(r.db).applied.includes('other-100.json'), '成功的包没进 applied')
  r.db.close()
})

checkAsync('★★ Step 1A · 指纹不对 → 整包拒 + 不进 applied + 一行都没写', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-fp')
  const sync = newSync(r, backups)
  cloudFiles.set(
    's1a-fp/nyx/chunks/other-100.json',
    JSON.stringify({
      device: 'other',
      at: Date.now(),
      schemaVersion: 27,
      schemaFingerprint: 'deadbeefdeadbeef',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      rows: packOf(true, false)
    })
  )

  const out = await r4Run(sync)
  assert(out.rejected === 1, `该拒 1 个包，实际 ${out.rejected}`)
  assert(out.applied === 0 && out.received === 0, '★★ 结构对不上还收了行进来')
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★★ 被拒的包进了 applied —— 它永远不会被重试'
  )
  const has = r.db.prepare(`select count(*) as n from projects where uid = 'remote-project-1'`).get() as { n: number }
  assert(has.n === 0, '★★ 整包该拒，库里却有那一行')
  const probs = lastSyncProblems(r.db)?.problems ?? []
  assert(probs.some((x) => /结构/.test(x.message)), '★ 拒绝的原因没有落进体检')
  r.db.close()
})

checkAsync('★★ Step 1A · 协议版本不对 → 整包拒，而且话要说清「另一台去升级」', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-proto')
  const sync = newSync(r, backups)
  const id = localIdentity()
  cloudFiles.set(
    's1a-proto/nyx/chunks/other-100.json',
    JSON.stringify({
      device: 'other',
      at: Date.now(),
      schemaVersion: id.schemaVersion,
      schemaFingerprint: id.schemaFingerprint,
      protocolVersion: SYNC_PROTOCOL_VERSION + 1,
      rows: packOf(true, false)
    })
  )

  const out = await r4Run(sync)
  assert(out.rejected === 1, `该拒 1 个包，实际 ${out.rejected}`)
  assert(out.applied === 0, '协议对不上还写了东西进去')
  const why = out.rejections?.[0]?.reason ?? ''
  assert(/协议版本不兼容/.test(why), `话没说到点子上：${why}`)
  assert(/升级/.test(why), `没告诉他下一步做什么：${why}`)
  assert(!syncState(r.db).applied.includes('other-100.json'), '★★ 被拒的包进了 applied')
  r.db.close()
})

checkAsync('★★ Step 1A · 版本修好之后重来 → 收得进（拒绝不是死路）', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-retry')
  const sync = newSync(r, backups)
  const id = localIdentity()
  const rows = packOf(true, false)

  cloudFiles.set(
    's1a-retry/nyx/chunks/other-100.json',
    JSON.stringify({ device: 'other', at: 1, schemaVersion: 27, schemaFingerprint: 'bad', protocolVersion: SYNC_PROTOCOL_VERSION, rows })
  )
  const bad = await r4Run(sync)
  assert(bad.rejected === 1 && bad.applied === 0, '第一趟该整包拒')

  // 「另一台升级了」——同一个包名，换成正确的包头
  cloudFiles.set(
    's1a-retry/nyx/chunks/other-100.json',
    JSON.stringify({
      device: 'other',
      at: 1,
      schemaVersion: id.schemaVersion,
      schemaFingerprint: id.schemaFingerprint,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      rows
    })
  )
  const good = await r4Run(sync)
  assert(good.applied === 1, `★★ 修好之后没有自动重来：applied=${good.applied}`)
  assert(syncState(r.db).applied.includes('other-100.json'), '成功之后该进 applied')
  r.db.close()
})

checkAsync('★★ Step 2 · C-1 之后，没有版本头的老包**不再收**（身份算法换了，翻译不过来）', async () => {
  /**
   * Step 1 时这一条验的是「老包走兼容路径收得进」。
   * C-1 换了跨设备身份的算法之后，那条路**必须关掉**：
   * 老包里的 uid 是升级前随机生成的，收进来会和本机已有的行撞车 ——
   * 正是 C-1 要根除的那个病，从兼容这道门原样放回来。
   * 判据在 `core/sync-protocol.ts::LAST_PROTOCOL_ACCEPTING_LEGACY`。
   */
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-legacy')
  const sync = newSync(r, backups)
  putLegacyChunk('s1a-legacy', 'other-100.json', packOf(true, false))

  const out = await r4Run(sync)
  assert(out.rejected === 1, `老包该被整包拒，实际 rejected=${out.rejected}`)
  assert(out.applied === 0, '老包还是被收下来了')
  const why = out.rejections?.[0]?.reason ?? ''
  assert(/升级/.test(why), `没告诉他该做什么：${why}`)
  assert(!syncState(r.db).applied.includes('other-100.json'), '★★ 被拒的老包进了 applied')
  r.db.close()
})

checkAsync('★★ Step 1A · legacy 包缺必要字段 → 整包拒 + 不进 applied', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-legacy-bad')
  const sync = newSync(r, backups)
  // 一行没有 uid —— 谁都认不出它是谁，收进来就是脏数据
  putLegacyChunk('s1a-legacy-bad', 'other-100.json', [
    { table: 'projects', updatedAt: Date.now(), data: { id: 9, name: 'x' } }
  ])

  const out = await r4Run(sync)
  assert(out.rejected === 1, `该整包拒，实际 rejected=${out.rejected}`)
  assert(out.applied === 0, '缺 uid 的行被写进去了')
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★★ 被拒的老包进了 applied —— 永远不会重试'
  )
  r.db.close()
})

checkAsync('★★ Step 1A · 坏 JSON → 整包拒，不再当成空包标 applied', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-broken')
  const sync = newSync(r, backups)
  putRaw('s1a-broken', 'other-100.json', '{ this is not json')

  const out = await r4Run(sync)
  assert(out.rejected === 1, `坏包该被数出来，实际 ${out.rejected}`)
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★★ 坏包被当成空包标进了 applied —— 它以后再也不会被看一眼'
  )
  r.db.close()
})

checkAsync('★★ Step 1A · 新包带本机没有的列 → 那一行算失败，**不许静默丢列**', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-col')
  const sync = newSync(r, backups)
  const t = Date.now()
  putChunk('s1a-col', 'other-100.json', [
    {
      uid: 'remote-project-9',
      table: 'projects',
      updatedAt: t,
      data: { id: 91, uid: 'remote-project-9', name: '带私货的', created_at: t, updated_at: t, mystery: 'x' }
    }
  ])

  const out = await r4Run(sync)
  assert(out.failed === 1, `★★ 多出来的列被静默丢掉了（该算失败）：failed=${out.failed}`)
  assert(out.applied === 0, '不该写进去')
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★ 有行失败，包却进了 applied'
  )
  r.db.close()
})

checkAsync('★ Step 2 · legacy 包连「多一列」也不再讨论 —— 整包先就被拒了', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1a-col-legacy')
  const sync = newSync(r, backups)
  const t = Date.now()
  putLegacyChunk('s1a-col-legacy', 'other-100.json', [
    {
      uid: 'remote-project-9',
      table: 'projects',
      updatedAt: t,
      data: { id: 91, uid: 'remote-project-9', name: '老包', created_at: t, updated_at: t, mystery: 'x' }
    }
  ])

  const out = await r4Run(sync)
  assert(out.rejected === 1, `老包该整包拒：rejected=${out.rejected}`)
  assert(out.applied === 0 && out.failed === 0, '老包不该走到逐行那一层')
  r.db.close()
})

check('★★ Step 1A · 协议版本号只有一处定义（不许散成 magic number）', () => {
  // ★ 阶段 3：执行器搬进 core/sync/engine.ts —— 正向断言跟着走；写死检查两处都做
  const adapter = readFileSync(join(process.cwd(), 'src', 'main', 'sync', 'index.ts'), 'utf8')
  const engine = readFileSync(join(process.cwd(), 'src', 'core', 'sync', 'engine.ts'), 'utf8')
  assert(
    /SYNC_PROTOCOL_VERSION/.test(engine),
    '★ 引擎没有引用统一的协议版本常量'
  )
  assert(
    !/protocolVersion:\s*\d/.test(engine) && !/protocolVersion:\s*\d/.test(adapter),
    '★★ 出现了写死的协议版本号 —— 以后升级会漏掉这一处'
  )
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 1C · F-05 · 出厂重置之后，同步身份与墓碑必须活下来
// ══════════════════════════════════════════════════════════════

/** 造一台「同步过、有身份有墓碑」的机器 */
function machineWithSync(wipedAt: number, watermark: number): ReturnType<typeof openDatabase> {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  const set = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('sync.device', 'dev-KEEPME', t)
  set.run('sync.wipedAt', String(wipedAt), t)
  set.run('sync.watermark', String(watermark), t)
  set.run('sync.applied', '["other-1.json"]', t)
  set.run('sync.kind', 'webdav', t)
  set.run('ai.heavy.key', 'secret', t)
  return r
}

const fakePaths = (dir: string): NyxPaths => ({
  root: dir,
  data: dir,
  db: join(dir, 'nyx.db'),
  backups: join(dir, 'backups'),
  logs: join(dir, 'logs'),
  audio: join(dir, 'audio'),
  dicts: join(dir, 'dicts'),
  prompts: join(dir, 'prompts'),
  shippedPrompts: join(dir, 'shipped-prompts'),
  resources: join(dir, 'resources')
})

const settingOf = (db: Database.Database, k: string): string | null =>
  ((db.prepare(`select value from settings where key = ?`).get(k) as { value: string } | undefined)
    ?.value ?? null)

checkAsync('★★ Step 1C · 出厂重置保住 device 与 wipedAt（F-05）', async () => {
  const r = machineWithSync(1_000_000, 900_000)
  const dir = dirname(r.db.name)
  const out = await factoryReset({
    db: r.db,
    paths: fakePaths(dir),
    clearSession: async () => {}
  })
  assert(out.ok, `重置没走完：${JSON.stringify(out.steps.filter((s) => !s.ok))}`)
  assert(
    settingOf(r.db, 'sync.device') === 'dev-KEEPME',
    '★★ 重置换掉了这台机器的同步编号 —— 它会把自己删掉的东西从云端拉回来'
  )
  const wiped = Number(settingOf(r.db, 'sync.wipedAt') ?? 0)
  assert(
    wiped >= 1_000_000,
    `★★ 重置把同步墓碑抹掉/退回了（${wiped}）—— 云端老数据会全部回来，而这正是 I-068 抱怨的那件事`
  )
  // 业务数据确实清空了
  const n = r.db.prepare(`select count(*) as n from projects`).get() as { n: number }
  assert(n.n === 0, '业务数据没清干净')
  // 配置类的确实清掉了（对话框答应过）
  assert(settingOf(r.db, 'ai.heavy.key') === null, 'AI key 没清掉 —— 对话框说过要清')
  assert(settingOf(r.db, 'sync.kind') === null, '同步配置没清掉')
  r.db.close()
})

checkAsync('★★ Step 1C · 墓碑只增不减 —— 时钟回拨也不许退回去', async () => {
  const future = Date.now() + 5 * 24 * 3600 * 1000
  const r = machineWithSync(future, future)
  const dir = dirname(r.db.name)
  await factoryReset({ db: r.db, paths: fakePaths(dir), clearSession: async () => {} })
  const wiped = Number(settingOf(r.db, 'sync.wipedAt') ?? 0)
  assert(wiped >= future, `★★ 墓碑倒退了：${wiped} < ${future}`)
  r.db.close()
})

checkAsync('★★ Step 1C · 水位不落在墓碑之前', async () => {
  const r = machineWithSync(2_000_000, 1)
  const dir = dirname(r.db.name)
  await factoryReset({ db: r.db, paths: fakePaths(dir), clearSession: async () => {} })
  const wiped = Number(settingOf(r.db, 'sync.wipedAt') ?? 0)
  const wm = Number(settingOf(r.db, 'sync.watermark') ?? 0)
  // ★ 先确认两个值真的还在 —— 都是 0 的话下面那句会空过（负向对照打出来的）
  assert(wiped > 0, '★★ 墓碑没了，这一条会空过')
  assert(wm > 0, '★★ 水位没了，这一条会空过')
  assert(wm >= wiped, `★★ 水位（${wm}）落在墓碑（${wiped}）之前 —— 碑之后的包会被当成没看过的新数据`)
  r.db.close()
})

checkAsync('★★ Step 1C · 重置之后，云端的老包仍然进不来', async () => {
  await cloudReady
  const r = machineWithSync(0, 0)
  const dir = dirname(r.db.name)
  configureSync(r, 's1c-stale')
  // 重置**之前**云端就躺着一个老包
  putChunk('s1c-stale', 'other-100.json', packOf(true, false))

  await factoryReset({ db: r.db, paths: fakePaths(dir), clearSession: async () => {} })
  // 重置会把同步配置清掉 —— 他重新配一遍，指回同一个桶
  configureSync(r, 's1c-stale')
  const out = await r4Run(newSync(r, join(dir, 'backups')))

  assert(out.applied === 0, `★★ 重置之后老包又被拉回来了：applied=${out.applied}`)
  const has = r.db.prepare(`select count(*) as n from projects where uid = 'remote-project-1'`).get() as { n: number }
  assert(has.n === 0, '★★ 清掉的数据从云端复活了 —— 这正是 I-068 那次事故')
  r.db.close()
})

check('★★ Step 1C · 两条清空路径用同一份保留清单（判据只有一处）', () => {
  for (const f of ['factory-reset.ts', 'export.ts']) {
    const src = readFileSync(join(process.cwd(), 'src', 'main', ...f.split('/')), 'utf8')
    assert(
      /PRESERVED_SYNC_KEYS/.test(src),
      `★★ ${f} 没有用统一的保留清单 —— 一条规则写在两个地方就会长成两个样子`
    )
  }
  assert(PRESERVED_SYNC_KEYS.length === 4, '保留清单的长度变了，测试要跟着更新')
})

checkAsync('★★ Step 1C · 清空学习数据（连设置一起清）也保住这四个键', async () => {
  const r = machineWithSync(1_500_000, 1_400_000)
  const dir = dirname(r.db.name)
  seedTree(r)
  new Exporter(r.db).wipeStudyData(join(dir, 'backups'), true)
  assert(settingOf(r.db, 'sync.device') === 'dev-KEEPME', '★★ 清空学习数据把同步编号也清了')
  assert(Number(settingOf(r.db, 'sync.wipedAt') ?? 0) >= 1_500_000, '★★ 墓碑被清掉了')
  assert(settingOf(r.db, 'ai.heavy.key') === null, '勾了「连设置一起清」，AI key 却还在')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 1B · F-06 · Supabase get() 的 400 语义
// ══════════════════════════════════════════════════════════════

/**
 * 一个只回固定形状的假 Supabase。
 *
 * 为什么不复用上面那个 WebDAV 假服务：这一条验的正是
 * **Supabase 把好几种错误都塞进 HTTP 400、真正的状态码写在正文里**这件事，
 * 换个后端就验不到了。
 */
const supaShapes = new Map<string, { status: number; body: string }>()
let supaPort = 0
const supaReady = new Promise<void>((resolve) => {
  const srv = fakeServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').replace(/^\/+/, ''))
    /**
     * ★ 列目录走的是 `POST /storage/v1/object/list/<桶>`，取对象走 `GET .../<桶>/<路径>`。
     * 按方法分，不要按「路径最后一段」—— 那样列目录会取到桶名，
     * 于是永远返回默认体，而默认体不是数组，`for...of` 一跑就抛。
     * 那条「取包失败」的用例本来就是这么**假绿**的（负向对照当场打出来的）。
     */
    if (req.method === 'POST') {
      let body = ''
      req.on('data', () => {})
      req.on('end', () => {
        const shape = supaShapes.get('list')
        body = shape ? shape.body : '[]'
        res
          .writeHead(shape?.status ?? 200, { 'content-type': 'application/json' })
          .end(body)
      })
      return
    }
    const key = path.split('/').pop() ?? ''
    const shape = supaShapes.get(key)
    if (!shape) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
      return
    }
    res.writeHead(shape.status, { 'content-type': 'application/json' }).end(shape.body)
  })
  srv.listen(0, '127.0.0.1', () => {
    supaPort = (srv.address() as { port: number }).port
    resolve()
  })
})

const supa400Store = (): ReturnType<typeof makeStore> =>
  makeStore({ kind: 'supabase', url: `http://127.0.0.1:${supaPort}`, user: 'nyx', secret: 'k' })

checkAsync('★ Step 1B · 对象真的不在（HTTP 404）→ null', async () => {
  await supaReady
  supaShapes.set('missing-404.json', { status: 404, body: '{}' })
  const got = await supa400Store().get('nyx/chunks/missing-404.json')
  assert(got === null, `真 404 该当成「没有这个对象」，实际 ${JSON.stringify(got)}`)
})

checkAsync('★ Step 1B · 对象不在（400 + 正文 statusCode 404）→ null', async () => {
  await supaReady
  supaShapes.set('missing-body.json', {
    status: 400,
    body: '{"statusCode":"404","error":"not_found","message":"Object not found"}'
  })
  const got = await supa400Store().get('nyx/chunks/missing-body.json')
  assert(got === null, `Supabase 的「对象不在」该当成 null，实际 ${JSON.stringify(got)}`)
})

checkAsync('★★ Step 1B · 400 AccessDenied → 抛，不许当成「对象不在」', async () => {
  await supaReady
  supaShapes.set('denied.json', {
    status: 400,
    body: '{"statusCode":"403","error":"Unauthorized","code":"AccessDenied"}'
  })
  let threw = ''
  try {
    const got = await supa400Store().get('nyx/chunks/denied.json')
    threw = `没有抛，返回了 ${JSON.stringify(got)}`
  } catch (err) {
    threw = ''
    assert(/权限/.test(String(err)), `话没说到点子上：${String(err)}`)
  }
  assert(
    threw === '',
    `★★ 权限被撤了却当成「这个包是空的」——那一批包会被标成已处理，永不重试。${threw}`
  )
})

checkAsync('★★ Step 1B · 400 NoSuchBucket → 抛', async () => {
  await supaReady
  supaShapes.set('nobucket.json', {
    status: 400,
    body: '{"statusCode":"404","error":"Bucket not found","code":"NoSuchBucket"}'
  })
  let ok = false
  try {
    await supa400Store().get('nyx/chunks/nobucket.json')
  } catch (err) {
    ok = /桶/.test(String(err))
  }
  assert(ok, '★★ 桶没了却当成「对象不在」—— 整批包会被静默标成已处理')
})

checkAsync('★★ Step 1B · 正文不是 JSON 的 400 → 抛', async () => {
  await supaReady
  supaShapes.set('malformed.json', { status: 400, body: '<html>Bad Request</html>' })
  let ok = false
  try {
    await supa400Store().get('nyx/chunks/malformed.json')
  } catch {
    ok = true
  }
  assert(ok, '★★ 认不出的 400 被当成「对象不在」了 —— 白名单之外一律该抛')
})

checkAsync('★★ Step 1B · 泛泛的 400 → 抛', async () => {
  await supaReady
  supaShapes.set('generic.json', { status: 400, body: '{"statusCode":"400","error":"bad"}' })
  let ok = false
  try {
    await supa400Store().get('nyx/chunks/generic.json')
  } catch {
    ok = true
  }
  assert(ok, '★★ 泛泛的 400 被当成「对象不在」了')
})

checkAsync('★★ Step 1B · 取包失败时，那一批包不进 applied（下次可重试）', async () => {
  await supaReady
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  const set = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('sync.kind', 'supabase', t)
  set.run('sync.url', `http://127.0.0.1:${supaPort}`, t)
  set.run('sync.user', 'nyx', t)
  set.run('sync.secret', 'k', t)
  set.run('sync.device', 'me', t)

  // 列目录返回一个包名，取它的时候权限被撤
  supaShapes.set('list', {
    status: 200,
    body: JSON.stringify([{ name: 'other-100.json' }])
  })
  supaShapes.set('other-100.json', {
    status: 400,
    body: '{"statusCode":"403","error":"Unauthorized","code":"AccessDenied"}'
  })

  let threw = false
  try {
    await r4Run(newSync(r, backups))
  } catch {
    threw = true
  }
  assert(threw, '★★ 取包失败却没有抛 —— 整趟会被当成「什么都没有」')
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★★ 取不到的包进了 applied —— 永不重试'
  )
  supaShapes.delete('list')
  supaShapes.delete('other-100.json')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 1D · F-08 · 同步音频的文件名白名单
// ══════════════════════════════════════════════════════════════

checkAsync('★★ Step 1D · 云端一个 ../ 的音频名 → 不落盘、记一笔、不影响包记账', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 's1d-audio')
  const audioDir = join(backups, 'audio')
  mkdirSync(audioDir, { recursive: true })

  const good = 'a'.repeat(40) + '.mp3'
  cloudFiles.set(
    `s1d-audio/nyx/audio/${good}.json`,
    JSON.stringify({ name: good, b64: Buffer.from('ID3ok').toString('base64') })
  )
  cloudFiles.set(
    `s1d-audio/nyx/audio/../evil.mp3.json`,
    JSON.stringify({ name: 'x', b64: Buffer.from('PWNED').toString('base64') })
  )
  // 顺带塞一个正常的变更包，验「拒一个音频不该影响包的记账」
  putChunk('s1d-audio', 'other-100.json', packOf(true, false))

  const out = await r4Run(newSync(r, backups))

  assert(existsSync(join(audioDir, good)), '合规的音频没有下载下来')
  assert(!existsSync(join(dirname(audioDir), 'evil.mp3')), '★★ 音频写到 data/audio 之外去了')
  assert(!existsSync(join(audioDir, '..', 'evil.mp3')), '★★ 路径穿越成功了')
  assert(out.applied === 1, `拒一个音频不该影响变更包：applied=${out.applied}`)
  assert(
    syncState(r.db).applied.includes('other-100.json'),
    '★ 一个坏音频名让好包也没进 applied —— 两条路不该互相牵连'
  )
  const probs = lastSyncProblems(r.db)?.problems ?? []
  assert(probs.some((x) => /音频/.test(x.message)), '★ 拒绝了却没有记一笔，他永远不知道')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★ Step 1 · F-09 · applied 上限 500 —— 只记录现状，不改机制（D-279）
// ══════════════════════════════════════════════════════════════

check('★ Step 1 · F-09 · applied 只留最近 500 个包名（现状，不是缺陷）', () => {
  /**
   * D-279：长期方案可以后置，但要**明确记录 + 有测试 + 不许被当成数据正确性问题**。
   *
   * 溢出之后老包会被重新下载重放 —— 正确性由三层兜着：
   *   墓碑（删掉的不许复活）· 水位（判 same 直接跳过）· 裁决（他做过的决定不倒退）
   * 代价只有流量与时间。这条用例把「500」这个数钉住，
   * 哪天有人改了它，得先看到这段话。
   */
  // ★ 阶段 3：applied 的两处落盘都在 core/sync/engine.ts
  const src = readFileSync(join(process.cwd(), 'src', 'core', 'sync', 'engine.ts'), 'utf8')
  const hits = [...src.matchAll(/slice\(-500\)/g)]
  assert(
    hits.length === 2,
    `★ applied 的上限出现了 ${hits.length} 处（该是 2 处：markAllApplied 与每批落盘）。` +
      `改动它之前请先读 D-279 · F-09：这不是正确性问题，是流量与时间的代价。`
  )
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 2 · C-1 · 确定性跨设备身份（2026-08-18）
//
// 七张表带着「uid 之外的唯一性」，而 uid 是随机的 ——
// 两台设备各自产生同一件业务事实就撞车、那一行永久失败。
// 这一批守两件事：**身份真的算得一样**，**回填真的没动别的**。
// ══════════════════════════════════════════════════════════════

/** V27 那一版（还没回填身份）—— 造「升级前」的库用 */

/** 造一个装了真实业务数据的 V27 库 */
function v27WithData(): { r: ReturnType<typeof openDatabase>; dir: string } {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups, V27)
  seedTree(r)
  /**
   * D-296 (V34): fixture stays at V27 on purpose, so it must NOT call Repo.
   * Production code joins `reading_cards` from V34 on, and that table does not
   * exist at V27 -> `no such table`. This fixture only needs "a v27 database
   * with representative rows"; how the rows got there is irrelevant, so raw SQL.
   */
  const t0 = Date.now()
  r.db
    .prepare(
      `insert into materials (id, lecture_id, kind, title, origin, content, char_count, created_at, updated_at)
       values (1, 1, 'original', 'M', 'paste', ?, 52, ?, ?)`
    )
    .run('They hold sway over the region. It is oddly evasive.', t0, t0)
  const mkItem = r.db.prepare(
    `insert into items (term, gloss, layer, kind, source, owner_lecture_id, created_at, updated_at)
     values (?, '', 'A', 'chunk', 'self', 1, ?, ?)`
  )
  const mkIl = r.db.prepare(
    `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at) values (?, 1, 1, ?, ?)`
  )
  const mkOcc = r.db.prepare(
    `insert into occurrences (item_id, material_id, lecture_id, quote, created_at, updated_at)
     values (?, 1, 1, ?, ?, ?)`
  )
  for (const term of ['hold sway over', 'oddly evasive']) {
    const id = Number(mkItem.run(term, t0, t0).lastInsertRowid)
    mkIl.run(id, t0, t0)
    /**
     * Only the FIRST item gets an occurrence: the "seven identity tables" test
     * later inserts one for the LAST item with the same material, and
     * `occurrenceMaterialUid(item, material)` would then collide.
     */
    if (term === 'hold sway over') {
      mkOcc.run(id, 'They hold sway over the region. It is oddly evasive.', t0, t0)
    }
  }
  const t = Date.now()
  // 手工补几条只有 V28 才关心的行
  const item = (r.db.prepare(`select id from items limit 1`).get() as { id: number }).id
  r.db
    .prepare(
      `insert into analysis_blocks (item_id, block, content, created_at, updated_at) values (?, 'summary', 'x', ?, ?)`
    )
    .run(item, t, t)
  r.db
    .prepare(
      `insert into term_ledger (norm, term, verdict, scope, created_at, updated_at) values ('hold sway', 'hold sway', 'deleted', 'global', ?, ?)`
    )
    .run(t, t)
  r.db
    .prepare(
      `insert into tombstones (target_uid, kind, target_id, purged_at, created_at, updated_at) values ('items-gone0000000', 'items', 99, ?, ?, ?)`
    )
    .run(t, t, t)
  return { r, dir }
}

check('★★ Step 2 · TS 与 SQL 算出来的身份必须逐字相同（200 个随机样本 + 边界）', () => {
  /**
   * ★ 这是本阶段最要紧的一条。
   *
   * 身份有两条生成路：生产代码（TS）和数据库触发器（SQL）。
   * 两条路要是慢慢漂开，表现是「大部分行对得上、偶尔一行撞车」——
   * 那种病没人查得出规律。所以不是「两边看起来一样」，是**逐字对拍**。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  r.db.exec(`create table _probe (v text)`)
  const ins = r.db.prepare(`insert into _probe (v) values (?)`)

  const edges = [
    '', 'a', '|', '||', '\\', '\\\\', '\\p', '\\|', '|\\', 'a|b', 'a\\b', 'a\\pb',
    'items-3f2a5b', '造句', '  空格  ', 'ＡＢＣ', '😀', '👨‍👩‍👧‍👦', 'é', 'é',
    '\t', 'x'.repeat(4000), "it's", '"quoted"', 'null', '0', '-', 'nat'
  ]
  /**
   * ★ 按**码点**取，不按码元 —— 否则会切出半个代理对（孤立的 \uD83D）。
   *
   * 这不是吹毛求疵：孤立代理**编不成合法 UTF-8**，塞进 SQLite 会被换成 U+FFFD，
   * 于是 SQL 那一侧拿到的根本不是 TS 那一侧给的东西，对拍必然红 ——
   * 而红的是夹具，不是被验的算法。第一版就是这么红的。
   * 真实业务里的字符串都经过 SQLite 往返，本来就不可能带孤立代理。
   */
  const chars = [...'ab|\\p造句 😀-_\t"\'0']
  const samples = [...edges]
  for (let i = 0; i < 200; i++) {
    let s = ''
    const n = 1 + Math.floor(Math.random() * 12)
    for (let j = 0; j < n; j++) s += chars[Math.floor(Math.random() * chars.length)]
    samples.push(s)
  }

  let checked = 0
  for (const s of samples) {
    ins.run(s)
    // ① 转义那一步
    const sqlEsc = (
      r.db.prepare(`select ${sqlEscapePart('v')} as e from _probe where rowid = last_insert_rowid()`).get() as
        | { e: string }
        | undefined
    )?.e
    assert(sqlEsc === escapePart(s), `★★ 转义对不上：${JSON.stringify(s)} → SQL ${JSON.stringify(sqlEsc)} / TS ${JSON.stringify(escapePart(s))}`)

    // ② 整个 uid（两段：一段是这个样本，一段固定）
    if (s !== '') {
      const expr = sqlNatUid('qtypes', ['v', `'fixed'`])
      const sqlUid = (
        r.db.prepare(`select ${expr} as u from _probe where rowid = last_insert_rowid()`).get() as
          | { u: string }
          | undefined
      )?.u
      assert(
        sqlUid === natUid('qtypes', [s, 'fixed']),
        `★★ uid 对不上：${JSON.stringify(s)}\n  SQL ${JSON.stringify(sqlUid)}\n  TS  ${JSON.stringify(natUid('qtypes', [s, 'fixed']))}`
      )
      checked++
    }
  }
  assert(checked >= 200, `样本太少，只对拍了 ${checked} 个`)

  // ③ 不同身份不许算出同一个 uid（碰撞当场失败）
  const seen = new Map<string, string>()
  for (const s of samples) {
    if (s === '') continue
    const u = natUid('qtypes', [s, 'fixed'])
    const had = seen.get(u)
    assert(had === undefined || had === s, `★★ 身份碰撞：${JSON.stringify(had)} 和 ${JSON.stringify(s)} 算出同一个 uid`)
    seen.set(u, s)
  }
  r.db.close()
})

check('★★ Step 2 · 七张表：触发器算的 uid == TS 算的 uid（真的插一行进去看）', () => {
  const { r } = v27WithData()
  // 先升到 V28（触发器换成确定性的）
  r.db.close()
  const dir2 = dirname(r.db.name)
  const up = openDatabase(join(dir2, 'nyx.db'), join(dir2, 'backups'))

  const uidOfRow = (table: string, where: string): string =>
    (up.db.prepare(`select uid from "${table}" where ${where}`).get() as { uid: string }).uid
  const u = (table: string, id: number): string =>
    (up.db.prepare(`select uid from "${table}" where id = ?`).get(id) as { uid: string }).uid

  const item = (up.db.prepare(`select id from items limit 1`).get() as { id: number }).id
  const lec = (up.db.prepare(`select id from lectures limit 1`).get() as { id: number }).id
  const t = Date.now()

  // item_lectures —— 换一讲插一条新的，看触发器算的对不对
  up.db.prepare(`insert into lectures (id, unit_id, name, created_at, updated_at) values (99,1,'新讲',?,?)`).run(t, t)
  up.db
    .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at) values (?,99,0,?,?)`)
    .run(item, t, t)
  assert(
    uidOfRow('item_lectures', `item_id=${item} and lecture_id=99`) === itemLectureUid(u('items', item), u('lectures', 99)),
    '★★ item_lectures 触发器算的和 TS 不一样'
  )

  // analysis_blocks
  up.db
    .prepare(`insert into analysis_blocks (item_id, block, content, created_at, updated_at) values (?, 'nuance', 'y', ?, ?)`)
    .run(item, t, t)
  assert(
    uidOfRow('analysis_blocks', `item_id=${item} and block='nuance'`) === analysisBlockUid(u('items', item), 'nuance'),
    '★★ analysis_blocks 触发器算的和 TS 不一样'
  )

  // qtypes
  new QTypes(up.db).save({ name: '我的题型', tier: 2, key: '我的题型' } as never)
  const qk = up.db.prepare(`select uid, key from qtypes where name = '我的题型'`).get() as { uid: string; key: string }
  assert(qk.uid === qtypeUid(qk.key), `★★ qtypes 触发器算的和 TS 不一样：${qk.uid} vs ${qtypeUid(qk.key)}`)

  // tombstones
  up.db
    .prepare(`insert into tombstones (target_uid, kind, target_id, purged_at, created_at, updated_at) values ('items-xyz','items',7,?,?,?)`)
    .run(t, t, t)
  assert(
    uidOfRow('tombstones', `target_uid='items-xyz'`) === tombstoneUid('items', 'items-xyz'),
    '★★ tombstones 触发器算的和 TS 不一样'
  )

  // term_ledger（全局作用域）
  up.db
    .prepare(`insert into term_ledger (norm, term, verdict, scope, created_at, updated_at) values ('abc','abc','silenced','global',?,?)`)
    .run(t, t)
  assert(
    uidOfRow('term_ledger', `norm='abc'`) === termLedgerUid('abc', 'silenced', null),
    '★★ term_ledger 触发器算的和 TS 不一样'
  )

  // occurrences（两个分支）
  const mat = (up.db.prepare(`select id from materials limit 1`).get() as { id: number }).id
  const it2 = (up.db.prepare(`select id from items order by id desc limit 1`).get() as { id: number }).id
  up.db
    .prepare(`insert into occurrences (item_id, material_id, lecture_id, quote, created_at, updated_at) values (?,?,?,'q',?,?)`)
    .run(it2, mat, lec, t, t)
  assert(
    uidOfRow('occurrences', `item_id=${it2} and material_id=${mat}`) ===
      occurrenceMaterialUid(u('items', it2), u('materials', mat)),
    '★★ occurrences（material 分支）触发器算的和 TS 不一样'
  )
  up.db
    .prepare(`insert into occurrences (item_id, material_id, lecture_id, quote, created_at, updated_at) values (?,null,?,'q2',?,?)`)
    .run(it2, lec, t, t)
  assert(
    uidOfRow('occurrences', `item_id=${it2} and material_id is null`) ===
      occurrenceLectureUid(u('items', it2), u('lectures', lec)),
    '★★ occurrences（lecture 分支）触发器算的和 TS 不一样'
  )
  up.db.close()
})

checkAsync('★★ 彻底删掉一个项目 → 它的 picks 跟着走，而墓碑一块不许少', async () => {
  /**
   * 实证来的（2026-09-02）：他把 Gone Girl 彻底删了，那条选读推荐还活着、
   * 还指着不存在的项目 —— **每次同步都推不出去、报一条问题**，
   * 而那条建议本身早就没有意义了。SQL 外键管不到 `picks`
   * （它靠 `(scope, scope_id)` 指，没有约束），所以级联要照
   * `DYNAMIC_RELATIONS` 里 `cascade: true` 的那几条补一刀。
   *
   * ★★★ 同一条用例把那个**绝对不许**也钉住：`tombstones` 是 `cascade: false`。
   *   它指着的正是刚被删的实体 —— 跟着删等于**把刚立的碑自己铲了**，
   *   删除从此传不到另一台，而且不报错。
   */
  const { db: path, backups, dir } = freshDir()
  const r = openDatabase(path, backups)
  const t = Date.now()
  const q = (sql: string, ...p: unknown[]): void => {
    r.db.prepare(sql).run(...(p as never[]))
  }
  q(`insert into projects (id,name,created_at,updated_at) values (1,'P1',?,?)`, t, t)
  q(`insert into projects (id,name,created_at,updated_at) values (2,'P2',?,?)`, t, t)
  q(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`, t, t)
  q(`insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','review',?,?)`, t, t)
  q(`insert into picks (scope,scope_id,content,created_at,updated_at) values ('project',1,'{}',?,?)`, t, t)
  q(`insert into picks (scope,scope_id,content,created_at,updated_at) values ('project',2,'{}',?,?)`, t, t)
  q(`insert into picks (scope,scope_id,content,created_at,updated_at) values ('lecture',1,'{}',?,?)`, t, t)

  await hardDelete(wrapDb(r.db), 'projects', [1])

  const left = r.db.prepare(`select scope, scope_id from picks order by id`).all() as {
    scope: string
    scope_id: number
  }[]
  assert(
    left.length === 1 && left[0]!.scope === 'project' && left[0]!.scope_id === 2,
    `★★ 只该剩别的项目那一条，实测 ${JSON.stringify(left)}`
  )
  assert(
    !left.some((x) => x.scope === 'lecture'),
    '★ 讲次被级联删掉了，挂在它上面的 picks 也不该留着'
  )
  const tombs = r.db.prepare(`select kind from tombstones`).all() as { kind: string }[]
  assert(
    tombs.some((x) => x.kind === 'projects') && tombs.some((x) => x.kind === 'lectures'),
    `★★★ 墓碑被顺手铲掉了 —— 删除从此传不到另一台：${JSON.stringify(tombs)}`
  )
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ Step 2 · V28 回填：行数 / 业务身份数 / 业务字段一个都没变，只有 uid 变了', () => {
  const { r, dir } = v27WithData()
  const path = r.db.name

  /**
   * 除 uid 外每一列拼起来 —— 逐行比对用。
   *
   * ★★ 列表**只按升级前那一份算**（`cols` 参数），两边用同一份。
   *   否则后来的迁移每加一列，这条用例都会误报「回填改了业务字段」——
   *   V36 给 `item_lectures` 加 `deleted_at` 时就撞上了：升级后那边多一个字段，
   *   串自然不同，而回填其实一个字都没动。**它要验的是「老字段没被动」。**
   */
  const colsOf = (db: Database.Database, table: string): string[] =>
    (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c !== 'uid')
      .sort()
  const dump = (db: Database.Database, table: string, cols: string[]): string[] => {
    const expr = cols.map((c) => `coalesce(cast("${c}" as text),'~')`).join(` || '§' || `)
    return (db.prepare(`select ${expr} as s from "${table}"`).all() as { s: string }[])
      .map((x) => x.s)
      .sort()
  }
  const tables = ['item_lectures', 'analysis_blocks', 'occurrences', 'qtypes', 'tombstones', 'term_ledger', 'drafts']
  const before = new Map<string, string[]>()
  const beforeCols = new Map<string, string[]>()
  const beforeUids = new Map<string, string[]>()
  for (const t of tables) {
    beforeCols.set(t, colsOf(r.db, t))
    before.set(t, dump(r.db, t, beforeCols.get(t)!))
    beforeUids.set(
      t,
      (r.db.prepare(`select uid from "${t}" order by uid`).all() as { uid: string }[]).map((x) => x.uid)
    )
    assert(before.get(t)!.length > 0 || t === 'drafts', `前提没成立：${t} 是空的，这条就什么都没验到`)
  }

  r.db.close()
  const up = openDatabase(path, join(dir, 'backups'))

  for (const t of tables) {
    const after = dump(up.db, t, beforeCols.get(t)!)
    assert(
      after.length === before.get(t)!.length,
      `★★ ${t} 回填之后行数变了：${before.get(t)!.length} → ${after.length}`
    )
    assert(
      JSON.stringify(after) === JSON.stringify(before.get(t)),
      `★★ ${t} 回填顺手改了业务字段（含 updated_at）—— 这一步只该动 uid`
    )
    const uids = (up.db.prepare(`select uid from "${t}"`).all() as { uid: string }[]).map((x) => x.uid)
    assert(new Set(uids).size === uids.length, `★★ ${t} 回填之后 uid 有重复`)
    assert(uids.every((x) => !!x), `★★ ${t} 回填之后有空 uid`)
    if (uids.length > 0) {
      assert(uids.every(isNaturalUid), `★★ ${t} 还有 uid 不是确定性身份：${uids.filter((x) => !isNaturalUid(x))[0]}`)
      /**
       * ★ `qtypes` 例外：出厂那一批的 uid 由 `canonicalUid()` 生成，
       * 而它现在转调 `qtypeUid()` —— 也就是说**播种那一刻就已经是确定性身份**，
       * V28 没有东西可回填。这条用例专门造了一个「他自己建的」题型（随机 uid），
       * 由下面那条断言盯着它真的被回填了。
       */
      if (t !== 'qtypes') {
        assert(
          JSON.stringify(uids.slice().sort()) !== JSON.stringify(beforeUids.get(t)),
          `★ ${t} 的 uid 一个都没变 —— 这条用例没验到东西`
        )
      }
    }
  }
  up.db.close()
})

check('★★ Step 2 · 天然身份撞车 → 迁移整体失败并回滚，不合并、不删行', () => {
  /**
   * 使用者裁决（2026-08-18）：发现同一天然身份有多行 →
   * **直接失败、回滚、报告冲突**。不 merge、不 delete、不 keep first/last、不静默修复。
   */
  const { r, dir } = v27WithData()
  const path = r.db.name
  const t = Date.now()
  const it = (r.db.prepare(`select id from items limit 1`).get() as { id: number }).id
  const mat = (r.db.prepare(`select id from materials limit 1`).get() as { id: number }).id
  const lec = (r.db.prepare(`select id from lectures limit 1`).get() as { id: number }).id
  /**
   * 造两条**同一天然身份**的出处：同一条知识点 + 同一份材料。
   * V27 那一版 occurrences 没有任何约束挡得住它（这正是审计里那个既有 bug 的形状）。
   *
   * ★ 要插**两条**，不是一条 —— 库里本来不一定已经有 (it, mat) 那一条
   *   （`addOriginal` 只建材料、不建出处）。第一版就是这么写的，
   *   于是「重复」根本没造出来，用例空过。
   */
  for (const q of ['重复的 A', '重复的 B']) {
    r.db
      .prepare(`insert into occurrences (item_id, material_id, lecture_id, quote, created_at, updated_at) values (?,?,?,?,?,?)`)
      .run(it, mat, lec, q, t, t)
  }
  const dupNow = (
    r.db
      .prepare(`select count(*) as n from occurrences where item_id = ? and material_id = ?`)
      .get(it, mat) as { n: number }
  ).n
  assert(dupNow >= 2, `前提没成立：没造出重复身份（只有 ${dupNow} 条），这条用例会空过`)
  const rowsBefore = (r.db.prepare(`select count(*) as n from occurrences`).get() as { n: number }).n
  r.db.close()

  let msg = ''
  try {
    openDatabase(path, join(dir, 'backups')).db.close()
    msg = '★★ 有重复身份却升级成功了 —— 那意味着有一份数据被悄悄合掉了'
  } catch (err) {
    const s = err instanceof Error ? err.message : String(err)
    assert(/业务身份/.test(s), `报错没说清是身份撞车：${s}`)
    assert(/occurrences/.test(s), `报错没说是哪张表：${s}`)
    assert(/rowid/.test(s), `报错没给出冲突的行，他没法自己核对：${s}`)
  }
  assert(msg === '', msg)

  // 回滚之后：库还是 V27，行一条没少
  const back = new Database(path, { readonly: true })
  assert(
    (back.pragma('user_version', { simple: true }) as number) === 27,
    '★★ 迁移失败之后库不是回到 V27'
  )
  const n = (back.prepare(`select count(*) as n from occurrences`).get() as { n: number }).n
  assert(n === rowsBefore, `★★ 迁移失败却动了数据：${rowsBefore} → ${n}`)
  back.close()
})

check('★★ Step 2 · 同一份材料重新分析一次 → 不长出第二条出处', () => {
  /**
   * 审计里报的既有 bug。修法是**确定性身份本身**（同一 (item, material) 算出同一个 uid，
   * `on conflict(uid) do nothing`），不是另写一套去重。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const repo = new Repo(r.db)
  repo.addOriginal(1, '原文', 'They hold sway over the region.', 'paste')
  const mat = (r.db.prepare(`select id from materials limit 1`).get() as { id: number }).id
  const t = Date.now()
  const itemId = Number(
    r.db
      .prepare(`insert into items (term, gloss, layer, created_at, updated_at) values ('hold sway over','',?,?,?)`)
      .run('B', t, t).lastInsertRowid
  )

  const once = (): boolean =>
    recordOccurrence(r.db, itemId, 1, 'hold sway over', { materialId: mat, trusted: true, fallback: 'hold sway over' })

  once()
  const after1 = (r.db.prepare(`select count(*) as n from occurrences where item_id = ?`).get(itemId) as { n: number }).n
  once()
  once()
  const after3 = (r.db.prepare(`select count(*) as n from occurrences where item_id = ?`).get(itemId) as { n: number }).n
  assert(after1 === 1, `第一次该写一条，实际 ${after1}`)
  assert(after3 === 1, `★★ 重新分析同一份材料长出了第 ${after3} 条出处`)

  // 但**另一份材料**里的出现仍然是新的一条（D-152 / M-013 要的就是这个）
  repo.addOriginal(1, '第二份原文', 'Others hold sway over nothing.', 'paste')
  const mat2 = (r.db.prepare(`select id from materials order by id desc limit 1`).get() as { id: number }).id
  recordOccurrence(r.db, itemId, 1, 'hold sway over', { materialId: mat2, trusted: true, fallback: 'hold sway over' })
  const after4 = (r.db.prepare(`select count(*) as n from occurrences where item_id = ?`).get(itemId) as { n: number }).n
  assert(after4 === 2, `★★ 另一篇材料里的出现被去重掉了（D-152 说要全部保存）：${after4}`)
  r.db.close()
})

check('★ Step 2 · uid 是身份，改业务字段不会把它改掉', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  const it = Number(
    r.db.prepare(`insert into items (term, gloss, layer, created_at, updated_at) values ('x','',?,?,?)`).run('B', t, t)
      .lastInsertRowid
  )
  r.db
    .prepare(`insert into analysis_blocks (item_id, block, content, created_at, updated_at) values (?,'summary','a',?,?)`)
    .run(it, t, t)
  const before = (r.db.prepare(`select uid from analysis_blocks where item_id=?`).get(it) as { uid: string }).uid
  r.db.prepare(`update analysis_blocks set content='b', updated_at=? where item_id=?`).run(t + 1, it)
  const after = (r.db.prepare(`select uid from analysis_blocks where item_id=?`).get(it) as { uid: string }).uid
  assert(before === after, '★★ 改了内容，身份跟着变了 —— uid 必须是不可变的身份')
  r.db.close()
})

check('★ Step 2 · 生产代码不许 UPDATE 身份列', () => {
  /**
   * 触发器只在 INSERT 时算 uid。要是有人 UPDATE 了身份列（`item_id` / `block` / `key` …），
   * uid 就会和身份对不上，而**没有任何东西会报错**。
   * 与其加一条 update 触发器去重算（那会把同步收下来的 uid 也改掉），
   * 不如守住「身份列从不被更新」这条事实。
   */
  const guard: Record<string, string[]> = {
    item_lectures: ['item_id', 'lecture_id'],
    analysis_blocks: ['item_id', 'block'],
    drafts: ['session_id', 'question_id'],
    tombstones: ['target_uid', 'kind'],
    qtypes: ['key'],
    occurrences: ['item_id', 'material_id'],
    term_ledger: ['norm', 'verdict']
  }
  const files = readdirSync(join(process.cwd(), 'src', 'main'), { recursive: true, encoding: 'utf8' })
    .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    .map((f) => join(process.cwd(), 'src', 'main', f as string))
  for (const f of files) {
    if (f.includes('migrations.ts')) continue // 迁移就是干这个的
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1')
    for (const [table, cols] of Object.entries(guard)) {
      const re = new RegExp(`update\\s+"?${table}"?\\s+set([\\s\\S]{0,300})`, 'gi')
      for (const m of src.matchAll(re)) {
        const body = (m[1] ?? '').split('where')[0] ?? ''
        for (const c of cols) {
          assert(
            !new RegExp(`(^|[\\s,(])${c}\\s*=`).test(body),
            `★★ ${f.split('src')[1]} 里 UPDATE 了 ${table}.${c} —— 那是身份列，改了 uid 就对不上了`
          )
        }
      }
    }
  }
})

// ── 双设备：Case A–E ──────────────────────────────────────────

/**
 * 造一对**真正同步过**的设备。
 *
 * ★ 不能两台各跑一次 `seedTree()`：那样两台的项目/单元/讲是**各建各的**，
 *   uid 不同、自增 id 还撞车（那是 F-01 轴 ①，C-2 才修）。
 *   真实场景是「B 是后装的，第一次同步把 A 的东西拉下来」——
 *   基础数据的 uid 与 id 两边一致，之后才谈得上「各自产生同一件业务事实」。
 */

/** 两台上各插一条**同一身份**的知识点（模拟它早就同步过了） */
function sameItemOnBoth(A: ReturnType<typeof openDatabase>, B: ReturnType<typeof openDatabase>, uid: string): void {
  const t = Date.now()
  for (const r of [A, B]) {
    r.db
      .prepare(
        `insert into items (id, uid, term, gloss, layer, created_at, updated_at) values (777, ?, 'hold sway', '', 'B', ?, ?)`
      )
      .run(uid, t, t)
  }
}

checkAsync('★★ Step 2 · Case A · A/B 各自新建同一业务事实 → 同一个 uid，一行，failed = 0', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('c1-caseA')
  sameItemOnBoth(A, B, 'items-shared0001')

  // 各自把它挂进第 1 讲 —— 同一件业务事实，两台各做一次
  const t = Date.now()
  for (const r of [A, B]) {
    r.db
      .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at) values (777,1,1,?,?)`)
      .run(t, t)
  }
  const ua = (A.db.prepare(`select uid from item_lectures where item_id=777`).get() as { uid: string }).uid
  const ub = (B.db.prepare(`select uid from item_lectures where item_id=777`).get() as { uid: string }).uid
  assert(ua === ub, `★★ 两台各自建同一件事实，uid 却不一样：\n  A ${ua}\n  B ${ub}`)

  await syncA.run()
  const got = await syncB.run()
  assert(
    got.failed === 0,
    `★★ Case A 有 ${got.failed} 行失败：${JSON.stringify(got.problems ?? []).slice(0, 400)}`
  )
  const n = (B.db.prepare(`select count(*) as n from item_lectures where item_id=777`).get() as { n: number }).n
  assert(n === 1, `★★ B 上长出了 ${n} 行 —— 同一件事实该只有一行`)
  A.db.close()
  B.db.close()
})

checkAsync('★★ Step 2 · Case B · A/B 同时删掉同一个对象 → 同一个墓碑 uid，failed = 0', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('c1-caseB')
  sameItemOnBoth(A, B, 'items-doomed0001')

  // 两台各自彻底删掉它 —— 双设备日常里最常见的一件事
  for (const r of [A, B]) await hardDelete(wrapDb(r.db), 'items', [777])

  const ta = (A.db.prepare(`select uid from tombstones where target_uid='items-doomed0001'`).get() as { uid: string })
    .uid
  const tb = (B.db.prepare(`select uid from tombstones where target_uid='items-doomed0001'`).get() as { uid: string })
    .uid
  assert(ta === tb, `★★ 两台各自删掉同一个东西，墓碑 uid 却不一样：\n  A ${ta}\n  B ${tb}`)
  assert(ta === tombstoneUid('items', 'items-doomed0001'), `墓碑 uid 不是算出来的那个：${ta}`)

  await syncA.run()
  const got = await syncB.run()
  assert(
    got.failed === 0,
    `★★ Case B 有 ${got.failed} 行失败 —— 坏掉的正是「删除会传播」这件事：${JSON.stringify(got.problems ?? []).slice(0, 400)}`
  )
  const n = (B.db.prepare(`select count(*) as n from tombstones where target_uid='items-doomed0001'`).get() as {
    n: number
  }).n
  assert(n === 1, `★★ B 上有 ${n} 块碑`)
  A.db.close()
  B.db.close()
})

checkAsync('★★ Step 2 · Case C · A/B 各自生成同一块解析 → 同一个 uid，一行', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('c1-caseC')
  sameItemOnBoth(A, B, 'items-shared0002')

  const t = Date.now()
  A.db
    .prepare(`insert into analysis_blocks (item_id, block, content, created_at, updated_at) values (777,'summary','A 写的',?,?)`)
    .run(t, t)
  B.db
    .prepare(`insert into analysis_blocks (item_id, block, content, created_at, updated_at) values (777,'summary','B 写的',?,?)`)
    .run(t, t)

  const ua = (A.db.prepare(`select uid from analysis_blocks where item_id=777`).get() as { uid: string }).uid
  const ub = (B.db.prepare(`select uid from analysis_blocks where item_id=777`).get() as { uid: string }).uid
  assert(ua === ub, `★★ 同一块解析算出两个 uid：\n  A ${ua}\n  B ${ub}`)

  await syncA.run()
  const got = await syncB.run()
  assert(got.failed === 0, `★★ Case C 有 ${got.failed} 行失败：${JSON.stringify(got.problems ?? []).slice(0, 400)}`)
  const n = (B.db.prepare(`select count(*) as n from analysis_blocks where item_id=777`).get() as { n: number }).n
  assert(n === 1, `★★ B 上长出了 ${n} 块`)
  A.db.close()
  B.db.close()
})

check('★★ Step 2 · Case D · 不同业务事实 → 不同 uid，两行都在', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  r.db
    .prepare(`insert into items (id, uid, term, gloss, layer, created_at, updated_at) values (7,'items-a0000000','x','','B',?,?)`)
    .run(t, t)
  r.db
    .prepare(`insert into items (id, uid, term, gloss, layer, created_at, updated_at) values (8,'items-b0000000','y','','B',?,?)`)
    .run(t, t)
  // 同一讲、不同知识点
  r.db.prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at) values (7,1,1,?,?)`).run(t, t)
  r.db.prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at) values (8,1,1,?,?)`).run(t, t)
  // 同一知识点、不同区块
  r.db.prepare(`insert into analysis_blocks (item_id, block, content, created_at, updated_at) values (7,'summary','a',?,?)`).run(t, t)
  r.db.prepare(`insert into analysis_blocks (item_id, block, content, created_at, updated_at) values (7,'nuance','b',?,?)`).run(t, t)

  // ★ 只看这条用例自己造的那几行 —— seedTree 也会造 item_lectures
  const il = (r.db.prepare(`select uid from item_lectures where item_id in (7,8) order by item_id`).all() as { uid: string }[]).map((x) => x.uid)
  const ab = (r.db.prepare(`select uid from analysis_blocks where item_id = 7 order by block`).all() as { uid: string }[]).map((x) => x.uid)
  assert(il.length === 2 && il[0] !== il[1], `★★ 不同知识点挂同一讲被算成同一个身份：${il.join(' / ')}`)
  assert(ab.length === 2 && ab[0] !== ab[1], `★★ 同一知识点的两个区块被算成同一个身份：${ab.join(' / ')}`)
  r.db.close()
})

checkAsync('★★ Step 2 · Case E · A 升级了、B 没升级 → 整包拒绝 + 不进 applied + 话里有「升级」', async () => {
  await cloudReady
  const bucket = 'c1-caseE'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  // B（没升级）推的包：协议版本还是 1
  const id = localIdentity()
  cloudFiles.set(
    `${bucket}/nyx/chunks/other-100.json`,
    JSON.stringify({
      device: 'other',
      at: Date.now(),
      schemaVersion: id.schemaVersion,
      schemaFingerprint: id.schemaFingerprint,
      protocolVersion: 1,
      rows: packOf(true, false)
    })
  )
  const out = await r4Run(newSync(r, backups))
  assert(out.rejected === 1, `该整包拒，实际 rejected=${out.rejected}`)
  assert(out.applied === 0, '没升级那台推的包被收下来了')
  const why = out.rejections?.[0]?.reason ?? ''
  assert(/协议版本不兼容/.test(why), `话没说清：${why}`)
  assert(/升级/.test(why), `没告诉他下一步：${why}`)
  assert(!syncState(r.db).applied.includes('other-100.json'), '★★ 被拒的包进了 applied')
  r.db.close()
})

checkAsync('★★ Step 2 · protocolVersion = 2，而且结构指纹**没有**跟着变', async () => {
  /**
   * 这一条把 D-269 那句裁决钉住：**指纹只表达结构，语义由 protocolVersion 表达。**
   * C-1 换的是触发器正文里那个表达式 —— 列、索引、触发器名字一个都没动，
   * 所以指纹纹丝不动。少了 protocolVersion 这一层，
   * 一台回填过、一台没回填的两台设备会互相写坏，而握手一声不吭。
   */
  assert(SYNC_PROTOCOL_VERSION === 3, `协议版本该是 3（C-2 那一版），实际 ${SYNC_PROTOCOL_VERSION}`)

  const a = freshDir()
  const b = freshDir()
  const v27 = openDatabase(a.db, a.backups, V27)
  /**
   * ★ 比的是 v27 与 **v28**，不是「当前版本」——
   *   V29（Step 5A）合法地往同步表面加了一张 `user_preferences`，
   *   那当然会改指纹。这条用例说的是「**C-1 那一步**只改触发器正文」。
   */
  const v28 = openDatabase(b.db, b.backups, MIGRATIONS.filter((m) => m.version <= 28))
  const f27 = (await schemaIdentity(v27.db)).schemaFingerprint
  const f28 = (await schemaIdentity(v28.db)).schemaFingerprint
  assert(
    f27 === f28,
    `★★ C-1 把结构指纹也改了（${f27} → ${f28}）—— 那说明有列/索引/触发器名字被动了，` +
      `而这一步本该只改触发器正文`
  )
  v27.db.close()
  v28.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 3 · C-2 · 同步边界的身份翻译（2026-08-18）
//
// 包里从此没有本地 id，也没有数字外键 —— 关系全靠 uid 重建。
// 这一批守两件事：**关系真的接得回去**、**接不回去时不许含糊**。
// ══════════════════════════════════════════════════════════════

check('★★ C-2 · 每一张同步表的每一个 *_id 列都有归宿（清单没漏）', () => {
  /**
   * 手写的那份 `EXTRA_RELATIONS` / `DYNAMIC_RELATIONS` / `DROP_ON_SYNC` 会漏，
   * 而漏掉的表现是**那个关系在另一台设备上断掉，不报错**。
   * 所以让机器扫：每张同步表里凡是 `id` 或 `*_id` 的列，
   * 必须要么是 SQL 外键、要么在这三份清单里，否则当场红。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const orphan: string[] = []
  for (const t of SYNC_TABLES) {
    const cols = (r.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
    if (cols.length === 0) continue
    const declared = new Set(
      (r.db.prepare(`pragma foreign_key_list("${t}")`).all() as { from: string }[]).map((f) => f.from)
    )
    const extra = new Set((EXTRA_RELATIONS[t] ?? []).map((x) => x.column))
    const dyn = new Set(dynamicOf(t).map((x) => x.column))
    const dropped = new Set(droppedOf(t))
    for (const c of cols) {
      if (c === 'id') continue // 每一行都删，见 ALWAYS_DROP
      if (!/_id$/.test(c)) continue
      if (declared.has(c) || extra.has(c) || dyn.has(c) || dropped.has(c)) continue
      orphan.push(`${t}.${c}`)
    }
  }
  assert(
    orphan.length === 0,
    `★★ 这几列既不是外键、也没在边界清单里 —— 它们会带着本机的号码跑到对面去：${orphan.join('、')}`
  )
  r.db.close()
})

checkAsync('★★ C-2 · 推出去的包里**不许**出现本地 id 或数字外键', () => {
  /**
   * 这一条是 C-2 的硬闸。判据不看代码，看**真正推上去的那些字节**。
   */
  return (async () => {
    await cloudReady
    const bucket = 'c2-noid'
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    const repo = new Repo(r.db)
    repo.addOriginal(1, '原文', 'They hold sway over the region.', 'paste')
    repo.addChunks(1, '我的收集', 'hold sway over')
    configureSync(r, bucket)
    const out = await r4Run(newSync(r, backups))
    assert(out.pushed > 0, `前提没成立：一行都没推上去`)

    let checked = 0
    for (const [name, body] of cloudFiles) {
      if (!name.startsWith(`${bucket}/nyx/chunks/`)) continue
      const pack = JSON.parse(body) as { rows: { table: string; data: Record<string, unknown> | null }[] }
      for (const row of pack.rows ?? []) {
        if (!row.data) continue
        checked++
        /**
         * ★★ 判据**不看配置**，直接从表结构推：
         * 这张表里凡是 `id` 或 `*_id` 的列，都不许出现在包里。
         * 从配置推的话，删掉一条配置就等于同时删掉了守它的那条判据 ——
         * 负向对照当场打出来的（拿掉 picks 的翻译，闸居然不响）。
         */
        const localCols = new Set(
          (r.db.prepare(`pragma table_info("${row.table}")`).all() as { name: string }[])
            .map((c) => c.name)
            .filter((c) => c === 'id' || /_id$/.test(c))
        )
        const bad = Object.keys(row.data).filter((k) => localCols.has(k))
        assert(
          bad.length === 0,
          `★★ ${row.table} 那一行带着本地列 ${bad.join('、')} 上云了 —— 到对面就指到别的行上去了`
        )
      }
    }
    assert(checked > 10, `检查的行太少（${checked}），这条用例没验到东西`)
    r.db.close()
  })()
})

/** 造一对真正同步过的设备（和 Step 2 那个同源） */
async function c2Pair(bucket: string, bumpB = true): Promise<{
  A: ReturnType<typeof openDatabase>
  B: ReturnType<typeof openDatabase>
  syncA: Sync
  syncB: Sync
}> {
  const fa = freshDir()
  const A = openDatabase(fa.db, fa.backups)
  seedTree(A)
  configureSync(A, bucket)
  A.db.prepare(`update settings set value = 'devA' where key = 'sync.device'`).run()
  const fb = freshDir()
  const B = openDatabase(fb.db, fb.backups)
  configureSync(B, bucket)
  B.db.prepare(`update settings set value = 'devB' where key = 'sync.device'`).run()
  /**
   * ★★ 把 B 的自增号推开。
   *
   * 不推的话 B 是空库、从 1 开始，拉完 A 的数据之后**两台的本地 id 恰好一样** ——
   * 于是「按 id 接关系」和「按 uid 接关系」都能过，用例就成了假绿。
   * 负向对照当场打出来的：删掉 picks / tombstone 的翻译，用例居然还是绿的。
   *
   * 直接顶 `sqlite_sequence`：不留任何多余数据，只是让号码错开。
   */
  if (bumpB) {
    // `sqlite_sequence.name` 上没有唯一约束，所以不能用 on conflict —— 先改再补
    const up = B.db.prepare(`update sqlite_sequence set seq = 500 where name = ?`)
    const ins = B.db.prepare(`insert into sqlite_sequence (name, seq) values (?, 500)`)
    B.db.transaction(() => {
      for (const t of ['projects','units','lectures','materials','items','occurrences','picks','tombstones','review_logs','analysis_blocks','questions','sessions']) {
        if (up.run(t).changes === 0) ins.run(t)
      }
    })()
  }
  const syncA = new Sync(A.db, join(fa.dir, 'audio'), fa.backups)
  const syncB = new Sync(B.db, join(fb.dir, 'audio'), fb.backups)
  await syncA.run()
  const got = await syncB.run()
  assert(got.failed === 0, `前提没成立：B 拉基础数据就失败了 ${JSON.stringify(got.problems ?? []).slice(0, 300)}`)
  return { A, B, syncA, syncB }
}

const newItem = (r: ReturnType<typeof openDatabase>, term: string): number => {
  const t = Date.now()
  return Number(
    r.db
      .prepare(`insert into items (term, gloss, layer, created_at, updated_at) values (?, '', 'B', ?, ?)`)
      .run(term, t, t).lastInsertRowid
  )
}

checkAsync('★★ C-2 · Test A · A/B 各建一条**不同**的知识点（本地 id 可能相同）→ 两行都在', async () => {
  /**
   * ★★ 这是 C-2 最核心的一条，也是 F-01 轴 ① 的正面。
   *
   * 从前：两台各自新建 → 都分到同一个自增号 → 包里带着 id →
   *       `on conflict(uid)` 不接管 → INSERT → 撞主键 → **那一行永久失败**。
   * 现在：包里没有 id，号是收的那一侧自己分的 —— 抢不起来。
   */
  await cloudReady
  // ★ 这一条要的正是「两台分到同一个号」，所以**不推**开 B 的自增号
  const { A, B, syncA, syncB } = await c2Pair('c2-testA', false)
  const ia = newItem(A, 'A 建的')
  const ib = newItem(B, 'B 建的')
  assert(ia === ib, `前提没成立：两台分到的本地 id 不一样（${ia} / ${ib}），这条就验不到撞号`)

  await syncA.run()
  const got = await syncB.run()
  assert(
    got.failed === 0,
    `★★ 两台各建一条就撞车了 —— C-2 没生效：${JSON.stringify(got.problems ?? []).slice(0, 400)}`
  )
  const terms = (B.db.prepare(`select term from items order by term`).all() as { term: string }[]).map((x) => x.term)
  assert(terms.includes('A 建的') && terms.includes('B 建的'), `★★ B 上少了一条：${terms.join('、')}`)
  await syncA.run()
  const ta = (A.db.prepare(`select term from items order by term`).all() as { term: string }[]).map((x) => x.term)
  assert(ta.includes('A 建的') && ta.includes('B 建的'), `★★ A 上少了一条：${ta.join('、')}`)
  A.db.close()
  B.db.close()
})

checkAsync('★★ C-2 · Test C · 两端本地 id 不同，关系照样绑对', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await c2Pair('c2-testC')
  // 先让两台的 items 表本地号码错开：B 上先建两条自己的
  newItem(B, 'B 的占位 1')
  newItem(B, 'B 的占位 2')
  const ia = newItem(A, 'A 的知识点')
  const t = Date.now()
  A.db
    .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at) values (?,1,1,?,?)`)
    .run(ia, t, t)

  await syncA.run()
  const got = await syncB.run()
  assert(got.failed === 0, `★★ 关系没绑上：${JSON.stringify(got.problems ?? []).slice(0, 400)}`)

  const row = B.db
    .prepare(
      `select i.term, l.name from item_lectures il
         join items i on i.id = il.item_id
         join lectures l on l.id = il.lecture_id
        where i.term = 'A 的知识点'`
    )
    .get() as { term: string; name: string } | undefined
  assert(row !== undefined, '★★ B 上那条关系不见了')
  const ib = (B.db.prepare(`select id from items where term = 'A 的知识点'`).get() as { id: number }).id
  assert(ib !== ia, `前提没成立：两台的本地 id 一样（${ia}），这条就验不到「id 不同也绑得对」`)
  A.db.close()
  B.db.close()
})

checkAsync('★★ C-2 · Case B/F · 子行先到 → 失败重试；父行到了 → 自己就好了（乱序多跳）', async () => {
  /**
   * 四层：project → unit → lecture → item。**故意倒着推**。
   * 判据有两条，缺一不可：
   *   · 父行没到时**失败**（不是跳过）—— 跳过等于那一行从此消失
   *   · 那一包**不进 applied** —— 否则再也不会重试
   */
  await cloudReady
  const bucket = 'c2-order'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  configureSync(r, bucket)
  const t = Date.now()
  const row = (table: string, uid: string, data: Record<string, unknown>): Record<string, unknown> => ({
    uid,
    table,
    updatedAt: t,
    data: { ...data, uid, created_at: t, updated_at: t }
  })
  // 倒序：item 在最前，project 在最后
  putChunk(bucket, 'other-100.json', [
    row('items', 'items-x', { term: '孙子的孙子', gloss: '', layer: 'B' }),
    row('item_lectures', itemLectureUid('items-x', 'lectures-x'), {
      item_uid: 'items-x',
      lecture_uid: 'lectures-x',
      is_owner: 1
    }),
    row('lectures', 'lectures-x', { unit_uid: 'units-x', name: 'L', number: 1, status: 'empty' }),
    row('units', 'units-x', { project_uid: 'projects-x', name: 'U' }),
    row('projects', 'projects-x', { name: 'P' })
  ])
  const sync = newSync(r, backups)

  const first = await sync.run()
  assert(first.failed > 0, `★★ 父行没到却没失败 —— 那几行会被静默丢掉：${JSON.stringify(first)}`)
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★★ 有行失败，这一包却进了 applied —— 永远不会重试'
  )

  // 重试若干次：每一轮多接上一层，最终必须全部落地
  let last = first
  for (let i = 0; i < 6 && last.failed > 0; i++) last = await sync.run()
  assert(last.failed === 0, `★★ 反复重试仍然收不敛：${JSON.stringify(last.problems ?? []).slice(0, 400)}`)
  assert(syncState(r.db).applied.includes('other-100.json'), '全成功之后该进 applied')

  const ok = r.db
    .prepare(
      `select p.name as pn from item_lectures il
         join items i on i.id = il.item_id
         join lectures l on l.id = il.lecture_id
         join units u on u.id = l.unit_id
         join projects p on p.id = u.project_id
        where i.uid = 'items-x'`
    )
    .get() as { pn: string } | undefined
  assert(ok?.pn === 'P', '★★ 四层关系没接起来 —— 出现了孤儿')
  r.db.close()
})

checkAsync('★★ C-2 · 父行永远不来 → 一直失败重试，绝不写进一行半截数据', async () => {
  await cloudReady
  const bucket = 'c2-orphan'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const t = Date.now()
  putChunk(bucket, 'other-100.json', [
    {
      uid: 'review_logs-orphan',
      table: 'review_logs',
      updatedAt: t,
      data: {
        uid: 'review_logs-orphan',
        item_uid: 'items-never-existed',
        line: 'reading',
        grade: 3,
        created_at: t,
        updated_at: t
      }
    }
  ])
  const out = await r4Run(newSync(r, backups))
  assert(out.failed === 1, `该失败，实际 ${JSON.stringify(out)}`)
  assert(out.applied === 0, '半截数据被写进去了')
  assert(!syncState(r.db).applied.includes('other-100.json'), '★★ 失败的包进了 applied')
  const n = (r.db.prepare(`select count(*) as n from review_logs`).get() as { n: number }).n
  assert(n === 0, `★★ 写进来了 ${n} 行没有归属的数据`)
  r.db.close()
})

checkAsync('★★ C-2 · **可空**外键的父行不在 → 也必须失败，不许拿 null 顶', async () => {
  /**
   * ★ 上一条用的是 `review_logs.item_id`（NOT NULL）—— 就算代码拿 null 顶，
   * 数据库也会自己挡住，于是那条用例**测不出**「拿 null 顶」这件事。
   * 可空外键才是真正的考场：填了 null 照样写得进去，而且看起来完全正常，
   * 只是那一行从此没有归属。
   */
  await cloudReady
  const bucket = 'c2-nullable'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const t = Date.now()
  putChunk(bucket, 'other-100.json', [
    {
      uid: 'items-noowner',
      table: 'items',
      updatedAt: t,
      data: {
        uid: 'items-noowner',
        term: '没有归属的知识点',
        gloss: '',
        layer: 'B',
        owner_lecture_uid: 'lectures-never-existed', // ← 可空外键，父行不在
        created_at: t,
        updated_at: t
      }
    }
  ])
  const out = await r4Run(newSync(r, backups))
  assert(
    out.failed === 1,
    `★★ 父行不在却把这一行写进去了（多半是拿 null 顶了 owner_lecture_id）：${JSON.stringify(out)}`
  )
  const n = (r.db.prepare(`select count(*) as n from items where uid = 'items-noowner'`).get() as { n: number }).n
  assert(n === 0, '★★ 写进来了一条没有归属的知识点 —— 它在任何列表里都出不来')
  assert(!syncState(r.db).applied.includes('other-100.json'), '★★ 失败的包进了 applied')
  r.db.close()
})

checkAsync('★★ C-2 · picks 的两个 scope 都能来回翻译', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await c2Pair('c2-picks')
  const t = Date.now()
  const lecUid = (A.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid
  const proUid = (A.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
  A.db
    .prepare(`insert into picks (scope, scope_id, content, created_at, updated_at) values ('lecture',1,'讲级精选',?,?)`)
    .run(t, t)
  A.db
    .prepare(`insert into picks (scope, scope_id, content, created_at, updated_at) values ('project',1,'项目级精选',?,?)`)
    .run(t, t)

  await syncA.run()
  const got = await syncB.run()
  assert(got.failed === 0, `★★ picks 没同步过去：${JSON.stringify(got.problems ?? []).slice(0, 300)}`)

  const lecOnB = (B.db.prepare(`select id from lectures where uid = ?`).get(lecUid) as { id: number }).id
  assert(lecOnB !== 1, `前提没成立：两台的本地号码一样（${lecOnB}），这条会假绿`)

  for (const [scope, parentUid, table] of [
    ['lecture', lecUid, 'lectures'],
    ['project', proUid, 'projects']
  ] as const) {
    const row = B.db.prepare(`select scope_id, content from picks where scope = ?`).get(scope) as
      | { scope_id: number; content: string }
      | undefined
    assert(row !== undefined, `★★ B 上没有 ${scope} 那条精选`)
    const back = (B.db.prepare(`select uid from "${table}" where id = ?`).get(row.scope_id) as { uid: string }).uid
    assert(back === parentUid, `★★ ${scope} 的归属绑错了：${back} 该是 ${parentUid}`)
  }
  A.db.close()
  B.db.close()
})

checkAsync('★★ C-2 · Test E · 两台各自删掉同一个东西 → 一块逻辑墓碑，target_id 在本机重新接上', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await c2Pair('c2-tomb')
  const t = Date.now()
  for (const r of [A, B]) {
    r.db
      .prepare(`insert into items (uid, term, gloss, layer, created_at, updated_at) values ('items-doom','x','','B',?,?)`)
      .run(t, t)
  }
  // 只有 A 删；B 那边那一行还在，正等着被碑删掉
  const idOnB = (B.db.prepare(`select id from items where uid = 'items-doom'`).get() as { id: number }).id
  const idOnA = (A.db.prepare(`select id from items where uid = 'items-doom'`).get() as { id: number }).id
  assert(idOnA !== idOnB, `前提没成立：两台的本地号码一样（${idOnA}），这条会假绿`)
  await hardDelete(wrapDb(A.db), 'items', [idOnA])

  await syncA.run()
  const got = await syncB.run()
  assert(got.failed === 0, `★★ 墓碑没同步过去：${JSON.stringify(got.problems ?? []).slice(0, 300)}`)

  const tb = B.db.prepare(`select target_id, target_uid from tombstones where target_uid = 'items-doom'`).get() as
    | { target_id: number | null; target_uid: string }
    | undefined
  assert(tb !== undefined, '★★ B 上没有收到那块碑')
  /**
   * ★ `target_id` 由**本机执行这块碑时**（`cascade.writeTombstones`）写成本机的号码 ——
   * 不是从包里带过来的（包里根本没有它）。这一条验的就是「跨设备之后号码是本机的」。
   */
  assert(
    tb.target_id === idOnB,
    `★★ 碑上的号码不是本机的：${tb.target_id} 该是 ${idOnB}（A 上那一行是第 ${idOnA} 号）`
  )
  const gone = (B.db.prepare(`select count(*) as n from items where uid = 'items-doom'`).get() as { n: number }).n
  assert(gone === 0, '★★ 收到碑了，本机那一份却还在')
  A.db.close()
  B.db.close()
})

checkAsync('★ C-2 · 本地关系断了的行 → 推不出去、报出来、而且水位卡住不放过它', async () => {
  await cloudReady
  const bucket = 'c2-broken'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const t = Date.now()
  // 造一条外键指向不存在的行（关外键约束才塞得进去 —— 现实里是历史脏数据）
  r.db.pragma('foreign_keys = OFF')
  r.db
    .prepare(
      `insert into review_logs (item_id, line, grade, uid, created_at, updated_at)
       values (99999, 'reading', 3, 'review_logs-broken', ?, ?)`
    )
    .run(t, t)
  r.db.pragma('foreign_keys = ON')

  const out = await r4Run(newSync(r, backups))
  const probs = lastSyncProblems(r.db)?.problems ?? []
  assert(
    probs.some((x) => /推不出去/.test(x.message)),
    `★★ 断掉的关系被悄悄跳过了，他永远不会知道：${JSON.stringify(probs).slice(0, 300)}`
  )
  // 那一行没被推出去
  for (const [name, body] of cloudFiles) {
    if (!name.startsWith(`${bucket}/nyx/chunks/`)) continue
    assert(!body.includes('review_logs-broken'), '★★ 一条没有归属的行被推上云了')
  }
  assert(out.pushed >= 0, '')
  r.db.close()
})

checkAsync('★ C-2 · 性能：5000 行的包，翻译不靠逐行查库', async () => {
  /**
   * 判据不是「几毫秒」（机器不一样），是**有没有把查库次数摊到每一行**。
   * 边界缓存按 (表, id) 记，5000 条 `review_logs` 挂在同几条知识点上时，
   * 查库次数应该远小于行数。这里量的是墙钟，够粗但抓得住数量级退化。
   */
  await cloudReady
  const bucket = 'c2-perf'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const t = Date.now()
  const ins = r.db.prepare(
    `insert into review_logs (item_id, line, grade, created_at, updated_at) values (1, 'reading', 3, ?, ?)`
  )
  r.db.transaction(() => {
    for (let i = 0; i < 5000; i++) ins.run(t + i, t + i)
  })()

  const sync = newSync(r, backups)
  const t0 = Date.now()
  const out = await sync.run()
  const ms = Date.now() - t0
  const look = sync.boundaryLookups()
  assert(out.pushed >= 5000, `该推 5000+ 行，实际 ${out.pushed}`)
  /**
   * ★★ 硬判据：5000 行 `review_logs` 全挂在同几个父行上，
   * 查库次数该是**父行的个数**那个量级，不是行数。
   * 去掉缓存这个数会立刻变成 5000+，当场红。
   */
  assert(
    look < 100,
    `★★ 边界翻译查了 ${look} 次库（5000 行）—— 缓存没生效，退化成逐行查了`
  )
  console.log(`      · 5000 行推送 ${ms}ms · 边界查库 ${look} 次`)
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 4 · F-02 · v28 目标结构的单一真相（2026-08-18）
//
// 两条路造出来的必须是同一个库：
//   A  空库 → 重放 26 条 migration
//   B  空库 → 执行 schema/v28.sql
// 不相同，`schema/v28.sql` 就不是真相，只是一份会漂的复制品。
// ══════════════════════════════════════════════════════════════

const SCHEMA_SQL = join(process.cwd(), 'schema', `v${TARGET_VERSION}.sql`)

/** A · 重放全部 migration */
function replayDb(): ReturnType<typeof openDatabase> {
  const { db: p, backups } = freshDir()
  return openDatabase(p, backups)
}

/** B · 照 schema/vNN.sql 建一个全新的库 */
function freshFromSql(sqlText: string): Database.Database {
  const { db: p } = freshDir()
  const db = new Database(p)
  db.exec(sqlText)
  return db
}

check('★★ Step 4 · schema/v28.sql 存在，而且是生成的那一份', () => {
  assert(
    existsSync(SCHEMA_SQL),
    `★★ 缺少目标结构定义 ${SCHEMA_SQL} —— 跑 \`npm run schema:dump\` 生成`
  )
  const text = readFileSync(SCHEMA_SQL, 'utf8')
  assert(/不要手改/.test(text), '★ 文件头少了「不要手改」那句 —— 它是给下一个人看的')
  assert(
    new RegExp(`pragma user_version = ${TARGET_VERSION}`).test(text),
    `★ 文件里没有把 user_version 定到 ${TARGET_VERSION}`
  )
  assert(/create table/i.test(text), '★ 文件里没有建表语句')
})

check('★★ Step 4 · Path A（重放 migration）与 Path B（执行 v28.sql）造出同一个库', () => {
  /**
   * ★ 这一条是 F-02 的全部内容。
   *
   * 比的是**完整本地结构**（含触发器正文、CHECK、WITHOUT ROWID），
   * 不是同步表面 —— 后者宽松得多（不算触发器正文），
   * 拿它来比会让「两条路其实不一样」溜过去。
   */
  const a = replayDb()
  const b = freshFromSql(readFileSync(SCHEMA_SQL, 'utf8'))

  const sa = localSchemaOf(a.db)
  const sb = localSchemaOf(b)
  if (sa !== sb) {
    // 报出第一处差异，不然一大段文本对不出来
    const la = sa.split('\n')
    const lb = sb.split('\n')
    let i = 0
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++
    assert(
      false,
      `★★ 两条路造出来的结构不一样（第 ${i + 1} 行起）：\n` +
        `  重放：${(la[i] ?? '（没有了）').slice(0, 200)}\n` +
        `  文件：${(lb[i] ?? '（没有了）').slice(0, 200)}\n` +
        `  跑 \`npm run schema:dump\` 重新生成，或者去看那条 migration 是不是漏了什么`
    )
  }

  assert(
    (b.pragma('user_version', { simple: true }) as number) === TARGET_VERSION,
    `★ 照 sql 建出来的库 user_version 不是 ${TARGET_VERSION}`
  )
  a.db.close()
  b.close()
})

checkAsync('★★ Step 4 · 两条路的**同步表面指纹**也必须相同', async () => {
  const a = replayDb()
  const b = freshFromSql(readFileSync(SCHEMA_SQL, 'utf8'))
  const fa = (await schemaIdentity(a.db)).schemaFingerprint
  const fb = (await schemaIdentity(b)).schemaFingerprint
  assert(fa === fb, `★★ 同步表面指纹不一样：重放 ${fa} / 文件 ${fb}`)
  console.log(`      · v${TARGET_VERSION} 同步表面指纹 ${fa}`)
  a.db.close()
  b.close()
})

checkAsync('★★ Step 4 · 本地结构版本与同步协议版本是两个东西', async () => {
  /**
   * 使用者 §7 / §16：不能混成一个。
   *   本地结构版本 = 28（这台机器的库长什么样）
   *   同步协议版本 = 3（包里装什么、身份怎么算）
   * C-2 只改了后者，本地表一个字没动 —— 这一条把它钉住。
   */
  const a = replayDb()
  const id = await schemaIdentity(a.db)
  assert(
    id.schemaVersion === TARGET_VERSION,
    `本地结构版本该是 ${TARGET_VERSION}，实际 ${id.schemaVersion}`
  )
  assert(SYNC_PROTOCOL_VERSION === 3, `同步协议版本该是 3，实际 ${SYNC_PROTOCOL_VERSION}`)
  assert(
    (id.schemaVersion as number) !== (SYNC_PROTOCOL_VERSION as number),
    '★ 两个版本号恰好相等 —— 这一条会看不出它们被混成了一个，换个数再验'
  )
  a.db.close()
})

/**
 * ★★ 变异测试：把 `schema/v28.sql` 改坏，`check:schema` 必须红。
 *
 * 判据不是「快照字符串相等」那种脆的比较 —— 每一种变异都对应一类**真实的
 * 结构差异**，而且分开验「本地结构」与「同步表面」两把尺子各自的敏感度。
 */
const MUTATIONS: { name: string; mutate: (sql: string) => string; syncToo: boolean }[] = [
  {
    name: '删掉一列（items.gloss_zh）',
    mutate: (s) => s.replace(/\n\s*gloss_zh[^\n]*\n/, '\n'),
    syncToo: true
  },
  {
    name: '加一列（items.mystery）',
    // ★ 导出的是 SQLite 自己记下来的建表语句：大写，而且 `if not exists` 已经被规范掉了
    mutate: (s) => s.replace(/(create table\s+items\s*\()/i, '$1\n  mystery text,'),
    syncToo: true
  },
  {
    name: '改可空性（items.term 去掉 not null）',
    mutate: (s) => s.replace(/term\s+text\s+not null/i, 'term text'),
    syncToo: true
  },
  {
    name: '改默认值（items.layer 由 A 改成 B）',
    mutate: (s) => s.replace(/layer\s+text\s+not null default 'A'/i, "layer text not null default 'B'"),
    syncToo: true
  },
  {
    name: '删掉唯一索引（idx_items_uid）',
    mutate: (s) => s.replace(/create unique index[^;]*idx_items_uid[^;]*;/i, ''),
    syncToo: true
  },
  {
    name: '删掉普通索引（idx_items_term）',
    mutate: (s) => s.replace(/create index[^;]*idx_items_term[^;]*;/i, ''),
    syncToo: true
  },
  {
    name: '删掉一条外键（items.derived_from）',
    mutate: (s) => s.replace(/derived_from\s+integer\s+references\s+items\s*\(id\)/i, 'derived_from integer'),
    syncToo: true
  },
  {
    name: '删掉一条触发器（trg_items_uid）',
    mutate: (s) => s.replace(/create trigger[^;]*trg_items_uid[\s\S]*?end;/i, ''),
    syncToo: true
  },
  {
    name: '★ 只改触发器**正文**（不动名字）',
    /**
     * ★★ 这一条专门验两把尺子的分工（D-269）：
     *   本地结构指纹 —— **必须变**（库真的不一样了）
     *   同步表面指纹 —— **不变**（正文里是语义，由 protocolVersion 表达）
     */
    mutate: (s) => s.replace(/lower\(hex\(randomblob\(8\)\)\)/, "lower(hex(randomblob(9)))"),
    syncToo: false
  }
]

for (const m of MUTATIONS) {
  checkAsync(`★★ Step 4 · 变异：${m.name} → 本地结构指纹必须变`, async () => {
    const original = readFileSync(SCHEMA_SQL, 'utf8')
    const broken = m.mutate(original)
    assert(broken !== original, `★ 变异没改动文件 —— 这条用例什么都没验（正则失配）`)

    const a = replayDb()
    let b: Database.Database
    try {
      b = freshFromSql(broken)
    } catch {
      // 改坏到建不出来也算「红」—— check:schema 同样会失败
      a.db.close()
      return
    }
    const same = localSchemaOf(a.db) === localSchemaOf(b)
    assert(!same, `★★ ${m.name} 之后两条路居然还一样 —— 这把尺子对它是瞎的`)

    const fa = (await schemaIdentity(a.db)).schemaFingerprint
    const fb = (await schemaIdentity(b)).schemaFingerprint
    if (m.syncToo) {
      assert(fa !== fb, `★★ ${m.name} 之后同步表面指纹没变 —— 两台设备会以为彼此兼容`)
    } else {
      assert(
        fa === fb,
        `★★ 只改触发器正文却让同步指纹变了 —— 那样每次改 uid 算法都会让两台互相拒收，` +
          `而语义变化本该由 protocolVersion 表达（D-269）`
      )
    }
    a.db.close()
    b.close()
  })
}

check('★ Step 4 · 恢复之后必须重新绿（变异没有留下痕迹）', () => {
  const a = replayDb()
  const b = freshFromSql(readFileSync(SCHEMA_SQL, 'utf8'))
  assert(localSchemaOf(a.db) === localSchemaOf(b), '★★ 变异测试污染了 schema/v28.sql')
  a.db.close()
  b.close()
})

check('★ Step 4 · 规范化：排版差异不许改变结果', () => {
  const base = 'create table t (\n  a integer  not null,\n  b text\n)'
  const same = [
    'create table t(a integer not null,b text)',
    'create table t (\n\n  a   integer not null ,\n  b text\n) ;',
    'create table t (a integer not null, b text) -- 注释\n'
  ]
  for (const s of same) {
    assert(
      normalizeDdl(s) === normalizeDdl(base),
      `★ 排版差异改变了结果：\n  ${normalizeDdl(s)}\n  ${normalizeDdl(base)}`
    )
  }
  assert(normalizeDdl('create table t (a integer)') !== normalizeDdl(base), '★ 少一列却没看出来')
})

checkAsync('★★ Step 4 · schemaInfo() 三样都读得到，而且是只读的', async () => {
  const a = replayDb()
  const sync = new Sync(a.db, join(dirname(a.db.name), 'audio'), dirname(a.db.name))
  const before = localSchemaOf(a.db)
  const info = await sync.schemaInfo()
  assert(info.schemaVersion === TARGET_VERSION, `本地结构版本不对：${info.schemaVersion}`)
  assert(/^[0-9a-f]{16}$/.test(info.schemaFingerprint), `指纹形状不对：${info.schemaFingerprint}`)
  assert(info.protocolVersion === SYNC_PROTOCOL_VERSION, `协议版本不对：${info.protocolVersion}`)
  assert(info.algo === 'sha256-16', `算法标记不对：${info.algo}`)
  assert(localSchemaOf(a.db) === before, '★★ 自检写了东西 —— 它必须是只读的')
  console.log(
    `      · schemaInfo() = 本地结构 v${info.schemaVersion} · 同步指纹 ${info.schemaFingerprint} · 协议 v${info.protocolVersion}`
  )
  a.db.close()
})

checkAsync('★★ Step 4 · 结构版本对、指纹不对 → 整包拒（版本号不能替指纹背书）', async () => {
  await cloudReady
  const bucket = 's4-fp'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  cloudFiles.set(
    `${bucket}/nyx/chunks/other-100.json`,
    JSON.stringify({
      device: 'other',
      at: Date.now(),
      schemaVersion: TARGET_VERSION, // ← 说自己是 v28
      schemaFingerprint: 'deadbeefdeadbeef', // ← 实际结构对不上
      protocolVersion: SYNC_PROTOCOL_VERSION,
      rows: packOf(true, false)
    })
  )
  const out = await r4Run(newSync(r, backups))
  assert(out.rejected === 1, `★★ 版本号说 28 就放行了 —— 指纹才是判据：${JSON.stringify(out)}`)
  assert(out.applied === 0, '收进来了')
  assert(!syncState(r.db).applied.includes('other-100.json'), '★★ 被拒的包进了 applied')
  r.db.close()
})

checkAsync('★★ Step 4 · 指纹对、协议版本不对 → 也要整包拒', async () => {
  await cloudReady
  const bucket = 's4-proto'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const id = localIdentity()
  cloudFiles.set(
    `${bucket}/nyx/chunks/other-100.json`,
    JSON.stringify({
      device: 'other',
      at: Date.now(),
      schemaVersion: id.schemaVersion,
      schemaFingerprint: id.schemaFingerprint, // ← 结构一模一样
      protocolVersion: SYNC_PROTOCOL_VERSION - 1, // ← 但协议语义不同
      rows: packOf(true, false)
    })
  )
  const out = await r4Run(newSync(r, backups))
  assert(out.rejected === 1, `★★ 结构一样就放行了 —— 协议语义也得对：${JSON.stringify(out)}`)
  assert(/协议版本不兼容/.test(out.rejections?.[0]?.reason ?? ''), '话没说清是协议不兼容')
  r.db.close()
})

check('★★ Step 4 · 同步必需的关系全部能从库结构 + 契约推出来，没有第二份清单', () => {
  /**
   * 使用者 §15：不许再手抄一份 `SYNC_SCHEMA_RELATIONS`。
   *
   * 判据：把「同步要用到的每一条关系」按 C-2 那套（pragma + fk-map 的明写清单）
   * 推一遍，每一条的父表都必须真实存在、父表都必须有 uid 列。
   * 推不出来就说明有一条关系只活在某个人的记忆里。
   */
  const a = replayDb()
  const missing: string[] = []
  for (const t of SYNC_TABLES) {
    const cols = (a.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
    if (cols.length === 0) continue
    const declared = (a.db.prepare(`pragma foreign_key_list("${t}")`).all() as {
      from: string
      table: string
    }[]).map((f) => ({ column: f.from, parent: f.table, syncColumn: syncColumnOf(f.from) }))
    for (const rel of relationsOf(t, declared)) {
      const pcols = (a.db.prepare(`pragma table_info("${rel.parent}")`).all() as { name: string }[]).map(
        (c) => c.name
      )
      if (pcols.length === 0) missing.push(`${t}.${rel.column} → ${rel.parent}（父表不存在）`)
      else if (!pcols.includes('uid')) missing.push(`${t}.${rel.column} → ${rel.parent}（父表没有 uid）`)
      else if (!cols.includes(rel.column)) missing.push(`${t}.${rel.column}（本地没有这一列）`)
    }
    for (const d of dynamicOf(t)) {
      if (!cols.includes(d.column)) missing.push(`${t}.${d.column}（本地没有这一列）`)
      if (!cols.includes(d.discriminator)) missing.push(`${t}.${d.discriminator}（判别列不存在）`)
    }
  }
  assert(missing.length === 0, `★★ 这几条关系对不上真实结构：\n  ${missing.join('\n  ')}`)
  for (const parent of Object.values(SCOPE_TABLES)) {
    const pcols = (a.db.prepare(`pragma table_info("${parent}")`).all() as { name: string }[]).map((c) => c.name)
    assert(pcols.includes('uid'), `★★ SCOPE_TABLES 指向的 ${parent} 没有 uid 列`)
  }
  a.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 5A · F-07 · user_preferences（2026-08-18）
//
// 三件事：跟着人走的搬过去、旧键删干净（**只能有一个真相**）、
// 秘密与设备配置一步都不许跨出这台机器。
// ══════════════════════════════════════════════════════════════

check('★★ Step 5A · 偏好清单：29 项，一个不多一个不少', () => {
  /**
   * ★ 这个数字**是闸不是记录** —— 它每变一次，都必须有人说清楚为什么。
   *
   * 17（D2.1 加 `dict.default`）→ 21（⑤ 的四条 `prompt.*`）→ 20（删小操练的
   * `drill.qtypes`）→ 21（T-7.5 的 `tts.sources`）→ 20（T-7.9 退三进二）→
   * 22（I-156 的两把记号）→ **19（2026-09-07 · D-466「语音设置简化」）**。
   *
   * ── 这一次为什么少了三项 ────────────────────────────────
   *
   * 使用者定：语音只剩**词典语音 · 系统语音**两个开关，默认都开，顺序写死。
   * 多厂商那整条线（Provider 契约 / 注册表 / 来源排序 / 云端缓存）撤掉，于是
   *   **退五**：`tts.sources` · `tts.sourcesEditedAt` · `tts.sourcesMigratedAt` ·
   *            `tts.provider.openai-compatible.voice` · `tts.provider.google-cloud.voice`
   *   **进二**：`tts.dictionary` · `tts.system`
   * 它们归 USER 的理由和当初 `tts.sources` 一样：「我要不要词典音」是**他想要的
   * 东西**；「哪本词典装在哪、系统 TTS 起没起」才是这台机器怎么实现 ——
   * 后者在 `core/voice` 里叫 `availability`，是**事实**，压根不进偏好。
   *
   * ★ 退役 ≠ 删掉：库里那五行不动（只增不删，D-216），只是白名单不再收、
   *   代码不再读写。**这一次没有回填** —— 两档出厂都是开的，旧值里没有任何
   *   一个字对得上这两把新开关，硬翻只会翻出一个谁也说不清来处的状态。
   * ★ Android 的 `core-parity` P-13 钉着同一个数，会话 C 提指针时一起改。
   */
  /**
   * ★ 2026-09-08 → **20 项**：D-478 取消档位那一轮进一把 `param.questionsPerItem`
   *   （一次给一条知识点出几道题）。归 USER 的理由：「我一次要练几道」是他想要的，
   *   换台设备该自动恢复；靠同步收敛。
   *   （原来这里写「Android 没有练习设置页」—— 那句是错的，手机**有**题型页；
   *     但**这一个键在手机上确实没有入口**，靠同步跟电脑走。2026-09-15 两头都核过。）
   */
  /**
   * ★ 2026-09-08 → **22 项**：D-479「牌面与出题规则分开」进两把 ——
   *   `reading.faces`（勾了哪几面）与 `reading.facesMigratedAt`（迁移记号）。
   *   出题规则仍走既有的 `prompt.reading-card`（键没变、含义改成规则正文）。
   *
   * ★★★ 当天又退回 **21 项**：`reading.facesMigratedAt` 归 DEVICE（在 `settings` 里）。
   *   不是口味问题，是同步语义：那一行**无条件写**（第一次读认读状态就写），
   *   而偏好行的 uid 由键名算 —— 两台算出同一个 uid、各写各的时间戳 = 必然冲突，
   *   输掉那版进 `ops_log`，`applied` 溢出重放时再判一次 → **重放改变了状态**，
   *   `smoke:sync` 的 S7 当场红。下面那条「记号不许再回白名单」守着它。
   */
  /**
   * ★ 2026-09-15 → **28 项**：D-482「出题规则改成点选项」一次进七把
   *   （`core/quiz-rules.ts::QUIZ_PREF_SPECS`）——
   *     理解层 `reading.facePick` · `reading.hintLevel` · `reading.shiftContext`
   *     写作层 `practice.hintLevel` · `practice.contextSpread` ·
   *            `practice.requireFullSentence` · `practice.matchRegister`
   *   归 USER 的理由是同一句判据：「我要怎么被考」是**他想要的**，换台设备该自动恢复。
   *   手机**也有**产出练习的设置页（PROMPTS ›「题型」→ 编辑，2026-09-15 核出来的），
   *   那四个键两端都有人改，靠同步收敛。
   *
   * ★★★ 这一轮的两个**认账记号**（`reading.optionsMigratedAt` /
   *   `qtypes.optionsMigratedAt`）**没进来** —— 和 `reading.facesMigratedAt`
   *   同一个理由，下面那条「记号不许再回白名单」现在守着三个。
   */
  /**
   * ★★★ 同日**退一把**：`prompt.reading-card` 从 `OVERRIDABLE_PROMPTS` 摘掉（主控裁）。
   *   退役的是**输入方式** —— 认读出题规则改成点选项之后，那个正文框写的东西
   *   不再参与出题：他点保存，屏幕说存好了，出的题一个字不变。
   *   留着它 = 屏幕上有两条路设同一件事，其中一条是哑的。
   *   **库里那一行一个字不删**（D-216），只读展示；`Prefs.set` 从此拒写它。
   *   所以是 21 + 7 − 1 = **27**。
   */
  /**
   * ★ 2026-09-15 → **29 项**：D-486「三层补齐」再进两把 ——
   *   `practice.face`（产出的牌面：整块 / 分栏 / 专注）与
   *   `reading.qtype`（认读的题型：翻卡自评 / 先写再翻 / 限时认读）。
   *   归 USER 的理由还是那句判据：「我要用什么方式被考」换台设备该自动恢复。
   * ★★ 两端**一起**进：一端加了另一端没加时，没升级的那一端拒写这一行，
   *   **而且什么都不会说**。
   */
  assert(PREF_KEYS.length === 29, `偏好清单是 ${PREF_KEYS.length} 项，该是 29`)
  for (const k of ['practice.face', 'reading.qtype']) {
    assert(PREF_KEYS.includes(k), `清单里少了 ${k}（D-486 那两把）`)
  }
  assert(
    !PREF_KEYS.includes('prompt.reading-card'),
    '★★★ `prompt.reading-card` 又回白名单了 —— 那条输入方式已经退役（D-482）'
  )
  /** D-482 那七把，一把都不许漏 —— 漏了的那一项是**静默失败**：写不进去，屏上不说 */
  for (const k of [
    'reading.facePick',
    'reading.hintLevel',
    'reading.shiftContext',
    'practice.hintLevel',
    'practice.contextSpread',
    'practice.requireFullSentence',
    'practice.matchRegister'
  ]) {
    assert(PREF_KEYS.includes(k), `清单里少了 ${k}（D-482 那七把之一）`)
  }
  /** ★★ 两个认账记号是 DEVICE，**永远不许**出现在白名单里（同步表上的无条件写 = 必然冲突） */
  for (const k of ['reading.optionsMigratedAt', 'qtypes.optionsMigratedAt']) {
    assert(!PREF_KEYS.includes(k), `★★★ 认账记号进了偏好白名单：${k} —— 那是同步表`)
  }
  for (const k of ['qtypes', 'practice_order', 'param.dailyTarget', 'tts.dictionary', 'tts.system', 'tts.accent', 'tts.rate', 'ai.split', 'dict.default', 'prompt.generate-questions', 'prompt.score-answer']) {
    assert(PREF_KEYS.includes(k), `清单里少了 ${k}`)
  }
  /** ★★ D-466 退役的那五把**一把都不许还在**（撤过的东西加回来之前先问为什么，D-457） */
  for (const k of ['tts.sources', 'tts.sourcesEditedAt', 'tts.sourcesMigratedAt', 'tts.provider.openai-compatible.voice', 'tts.provider.google-cloud.voice']) {
    assert(!PREF_KEYS.includes(k), `★★★ ${k} 还在白名单里 —— D-466 把它退役了`)
  }
  /**
   * ★★★ **一次性迁移的记号一把都不许进这份白名单**（2026-09-08 · S7 的教训）。
   *
   * 这类键长得最像偏好、也最容易顺手加进来：它跟着这个人的数据走、名字里带
   * `reading.` / `tts.`，看着就该同步。但它们是**每台机器无条件各写一次**的东西，
   * 而偏好行的 uid 由键名算 —— 同一个 uid、不同的值 = 每次都冲突，
   * 重放老包时状态还会再变一次（S7 红的正是这一条）。
   * 这里按名字拦：新加一个 `xxxMigratedAt` 想进白名单，先在这条上撞一次。
   */
  for (const k of PREF_KEYS) {
    assert(
      !/MigratedAt$/.test(k),
      `★★★ ${k} 是一次性迁移的记号，不该进同步白名单 —— 它每台机器各写一次，` +
        `同一个 uid 不同的值就是必然冲突（smoke:sync S7）。记号归 DEVICE，放 settings。`
    )
  }
})

check('★★ Step 5A · 清单里一个像密钥的都没有', () => {
  for (const k of PREF_KEYS) {
    assert(!looksLikeSecret(k), `★★ 偏好清单里混进了一个像密钥的键：${k}`)
    assert(checkPrefKey(k).ok, `${k} 自己过不了自己的闸`)
  }
  // 反过来：密钥一律拒
  for (const bad of ['ai.heavy.key', 'tts.key', 'sync.secret', 'my.token', 'x.password']) {
    const v = checkPrefKey(bad)
    assert(!v.ok, `★★ ${bad} 居然能进偏好表`)
    assert(/密钥|不在偏好清单/.test(v.why), `理由没说清：${v.why}`)
  }
  // 清单外的普通键也拒
  assert(!checkPrefKey('dict.anything.else').ok, '★ 清单外的键不该能进偏好表')
})

/**
 * ★★ D2.1 · `dict.default` 从 DEVICE 改判 USER（他 2026-08-19 的裁决）
 *
 * 旧决议成立的前提是**它存的是本机 id**：`31` 在另一台机器上什么都不是。
 * D1/D2 之后存的是 `dictUid` —— 同一本词典在任何机器、任何路径下都是同一个字符串。
 * 前提没了，结论跟着变。这条用例是那条旧断言的替身。
 */
check('★★ D2.1 · dict.default 现在是 USER：进得了偏好表，但只认 dictUid', () => {
  assert(checkPrefKey('dict.default').ok, '★★ dict.default 现在该进偏好表了')
  assert(PREF_KEYS.includes('dict.default'), '清单里没有 dict.default')

  const uid = dictUid({
    format: 'mdict',
    formatVersion: '2.0',
    encoding: 'UTF-8',
    title: '牛津高阶（第10版 英汉双解） V1.4',
    entryCount: 283811,
    blockCount: 181,
    indexBytes: 1850985
  })
  assert(checkPrefValue('dict.default', uid).ok, `真身份被拒了：${uid}`)

  /**
   * ★★ 存本机 id 必须**当场拒**。
   *   悄悄存进去的后果：换台设备之后 `31` 指向另一本词典 ——
   *   而且不报错、不报警，他只会发现「默认词典莫名其妙变了一本」。
   */
  for (const bad of ['31', '0', '', 'oald10', 'dictionaries-nat', '牛津高阶']) {
    const v = checkPrefValue('dict.default', bad)
    assert(!v.ok, `★★ 「${bad}」居然能当成默认词典存进去`)
  }
  const idCheck = checkPrefValue('dict.default', '31')
  assert(!idCheck.ok && /本机 id|跨设备身份/.test(idCheck.why), '理由没说清')
})

check('★★ Step 5A · 偏好身份是算出来的，走的是 Step 2 那套', () => {
  assert(prefUid('qtypes') === prefUid('qtypes'), '同一个键算两次不一样')
  assert(prefUid('qtypes') !== prefUid('practice_order'), '不同的键撞了')
  assert(prefUid('a|b') !== prefUid('a\\pb'), '★ 没走转义 —— 带分隔符的键会撞')
  assert(isNaturalUid(prefUid('qtypes')), '不是确定性身份的形状')
})

check('★★ Step 5A · V29 迁移：白名单里的搬过去、旧键删干净、值一个不差；退役的留在原处', () => {
  /**
   * ★ 这条用例会塞一个明文 `sync.secret`，而 V30（Step 5B）会去加密它。
   *   测试进程里 `safeStorage` 不可用，所以换一份可控的加解密层 ——
   *   否则红的是「凭据不可用」，不是这条用例要验的东西。
   */
  setCrypto(fakeCrypto())
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 28))
  const t = Date.now()
  const set = old.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value`
  )
  // 他真机上那几项的真实形状
  const seed: [string, string][] = [
    ['qtypes', JSON.stringify(['搭配填空', '释义改写'])],
    ['practice_order', JSON.stringify({ items: 'random', qtypes: 'seq' })],
    ['param.dailyTarget', '95'],
    ['param.hardTrigger', '7'],
    ['tts.accent', 'en-GB'],
    ['tts.rate', '1.2'],
    ['ai.split', '1']
  ]
  /**
   * ★★ T-7.9 退役的三把（`tts.cloud` / `tts.model` / `tts.voice`）**不在白名单里了**，
   *   所以 V29 不会再搬它们 —— 它们留在 `settings` 里。
   *
   *   这不是丢了：`main/tts.ts` 读不到偏好表里那一份时会回头读 `settings`
   *   （只读兼容）。反而更对：退役的键本来就不该被搬进一张**会同步**的表。
   *   ★ 顺带暴露的一件事：V29 是**动态遍历 `PREF_SPECS`** 的 ——
   *     白名单一变，一条已经写完的历史迁移行为就跟着变了。
   *     本轮没动它（不在 T-7.9 范围），但它值一条单独的任务。
   */
  const retired: [string, string][] = [
    ['tts.cloud', '1'],
    ['tts.model', 'tts-1'],
    ['tts.voice', 'alloy']
  ]
  for (const [k, v] of [...seed, ...retired]) set.run(k, v, t)
  // 设备级 / 秘密：必须原地不动
  set.run('ai.heavy.model', 'deepseek-chat', t)
  set.run('ai.heavy.key', 'ENCRYPTED-BLOB', t)
  set.run('sync.secret', 'sb_publishable_xxx', t)
  set.run('dict.default', '31', t)
  old.db.close()

  const up = openDatabase(p, backups)
  const prefs = new Prefs(up.db)

  for (const [k, v] of seed) {
    assert(prefs.raw(k) === v, `★★ ${k} 没搬对：${JSON.stringify(prefs.raw(k))} ≠ ${JSON.stringify(v)}`)
    const left = up.db.prepare(`select 1 as x from settings where key = ?`).get(k)
    assert(!left, `★★ ${k} 的旧键没删 —— 双真相就是这么来的`)
  }
  /** ★★ 退役的三把：**留在 settings、值一字不差、不进偏好表** */
  for (const [k, v] of retired) {
    const left = up.db.prepare(`select value from settings where key = ?`).get(k) as
      | { value: string }
      | undefined
    assert(left?.value === v, `★★★ 退役键 ${k} 被搬走或弄丢了 —— 他的设置就没了`)
    assert(!prefs.raw(k), `★★ 退役键 ${k} 还是进了会同步的偏好表`)
  }
  // 设备级 / 秘密原地不动
  for (const k of ['ai.heavy.model', 'ai.heavy.key', 'sync.secret']) {
    const r = up.db.prepare(`select value from settings where key = ?`).get(k) as { value: string } | undefined
    assert(r, `★★ ${k} 被搬走了 —— 它是设备级/秘密，必须留在 settings`)
    assert(!prefs.raw(k), `★★ ${k} 进了偏好表`)
  }
  /**
   * ★★ D2.1 · `dict.default` 现在是 USER，但**这一趟不该被搬走** ——
   *   这个库里一本词典都没有，`31` 解析不出任何 uid。
   *   规矩是「解析不出真实 uid 就一个字都不写、旧键留着」，
   *   **绝不编一个 uid 出来**：编出来的后果是他换台设备之后
   *   默认词典指向一本根本不存在的书，而且什么都不报。
   */
  const legacyDict = up.db.prepare(`select value from settings where key = 'dict.default'`).get() as
    | { value: string }
    | undefined
  assert(legacyDict?.value === '31', '★★ 解析不出 uid 却把旧键删了 —— 他的设置丢了')
  assert(!prefs.raw('dict.default'), '★★ 编了一个 uid 出来 —— 那会指到一本不存在的词典上')
  assert(prefs.strays().length === 0, `★ 偏好表里有清单外的键：${prefs.strays().join('、')}`)
  up.db.close()
  setCrypto(null)
})

/**
 * ★★★ T-2.12 补 · 冻住的名单**少一把键，得有人当场喊**（判据在这里，独立于被测对象）
 *
 * 这 22 条是**照着 2026-09-07 那天的 `PREF_SPECS` 抄下来的**，抄完逐条比过：
 * 两边一个不差（所以那次冻结不改变当时的行为）。它**故意和 `V29_PREFS` 各写一份** ——
 * 判据要是从被测对象推出来的，两边一起漂的时候照样绿，那就等于没有判据。
 * 从今往后：动 `V29_PREFS` 就必须同时动这里，**让「改历史迁移的键面」变成一件
 * 非过一次脑子不可的事**。
 */
const EXPECTED_V29: readonly { key: string; kind: string }[] = [
  { key: 'qtypes', kind: 'json-array' },
  { key: 'practice_order', kind: 'json' },
  { key: 'param.silenceStreak', kind: 'number' },
  { key: 'param.hardTrigger', kind: 'number' },
  { key: 'param.graceAttempts', kind: 'number' },
  { key: 'param.minSample', kind: 'number' },
  { key: 'param.readingSilenceDays', kind: 'number' },
  { key: 'param.dailyTarget', kind: 'number' },
  { key: 'param.readingDailyCap', kind: 'number' },
  { key: 'tts.accent', kind: 'text' },
  { key: 'tts.rate', kind: 'number' },
  { key: 'tts.sources', kind: 'json-array' },
  { key: 'tts.sourcesEditedAt', kind: 'number' },
  { key: 'tts.sourcesMigratedAt', kind: 'number' },
  { key: 'tts.provider.openai-compatible.voice', kind: 'text' },
  { key: 'tts.provider.google-cloud.voice', kind: 'text' },
  { key: 'ai.split', kind: 'bool' },
  { key: 'dict.default', kind: 'dict-uid' },
  { key: 'prompt.generate-questions', kind: 'text' },
  { key: 'prompt.score-answer', kind: 'text' },
  { key: 'prompt.lookup-search', kind: 'text' },
  { key: 'prompt.reading-card', kind: 'text' }
]

/**
 * ★★★ T-2.12 补 · 冻住的名单**少一把键，得有人当场喊**
 *
 * ── 上一版漏掉的那一半 ────────────────────────────────────
 *
 * 「往白名单加一把键 → V29 不动」守的是**加**这个方向。
 * 主控 2026-09-07 的对照走的是**减**：把 `V29_PREFS` 最后一条整行删掉 ——
 * `check:sql` 绿、`test:db` 659 全过。也就是说**冻结名单少一把、V29 从此漏搬一把，
 * 没有任何用例看得见**。
 *
 * 这是冻结本身**带进来的新失败面**：以前名单是算出来的（遍历白名单），
 * 少不了；改成字面量之后，它就能少 —— 而少了的表现是**静默的**：
 * 那一把键的值永远留在 `settings` 里，`Prefs.raw()` 读不到，
 * 界面拿到默认值。他升级完发现「我勾的题型怎么没了」，而日志里什么都没有。
 * 所以这道闸是这一轮欠下的债，必须这一轮还上。
 *
 * ── 两条一起才够 ──────────────────────────────────────────
 *
 *   ① **行为**：22 把键各放一行 v28 形状的值 → 只跑到 V29 → **每一把**都搬成功。
 *      少一把、或者某一把的 `kind` 写错导致校验不过，这一条当场红（点名是哪一把）。
 *   ② **快照**：`V29_PREFS` 的 key 集合 = 下面这 22 个**字面量**。
 *      ★ 判据故意**不从 `PREF_KEYS` 推** —— 推的话，名单和白名单一起漂时它照样绿，
 *        那就又回到了「历史迁移跟着当前常量走」，正是 T-2.12 要消灭的东西。
 *
 * ★ 负向对照（主控那一条）：删掉 `V29_PREFS` 最后一条 → ①② 同时红。
 */
check('★★★ T-2.12 · 冻住的那 22 把键，V29 一把都不许漏搬', () => {
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 28))
  const t = Date.now()
  const set = old.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value`
  )

  /** 各种 kind 的一份**合法的 v28 旧值**（已经是归一后的形状，搬完应当一字不差） */
  const sampleFor = (kind: string): string => {
    if (kind === 'number') return '7'
    if (kind === 'bool') return '1'
    if (kind === 'json-array') return JSON.stringify(['甲', '乙'])
    if (kind === 'json') return JSON.stringify({ items: 'random' })
    // ★ dict-uid 只认 `dictionaries-nat-` 开头 —— 存本机 id 会指到另一本书上
    if (kind === 'dict-uid') return 'dictionaries-nat-probe'
    return 'v28 旧值'
  }

  /**
   * ★★★ 种子来自**下面那份独立的字面量表**，不是 `V29_PREFS` 本身。
   *
   *   第一版就是从 `V29_PREFS` 遍历着播种的 —— 于是名单少一把时，
   *   这条用例**连播都不播那一把**，自然也就查不出来：主控删掉最后一条，
   *   它照样绿。**用被测对象生成判据，等于没有判据** ——
   *   这正是 T-2.12 本身在修的那个毛病（历史迁移引用会变的常量），
   *   我在用例里又犯了一次。判据必须独立于被测对象。
   */
  const want = new Map<string, string>()
  for (const spec of EXPECTED_V29) {
    const v = sampleFor(spec.kind)
    want.set(spec.key, v)
    set.run(spec.key, v, t)
  }
  old.db.close()

  // ★ 只跑到 V29：这一条验的是 V29 自己，别让 V30+ 的后续动作混进结论
  const up = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 29))
  const prefs = new Prefs(up.db)

  const missed: string[] = []
  const wrong: string[] = []
  const leftBehind: string[] = []
  for (const [key, v] of want) {
    const got = prefs.raw(key)
    if (got === null) missed.push(key)
    else if (got !== v) wrong.push(`${key}（搬成了 ${JSON.stringify(got)}，本该是 ${JSON.stringify(v)}）`)
    if (up.db.prepare(`select 1 as x from settings where key = ?`).get(key)) leftBehind.push(key)
  }
  up.db.close()

  assert(
    missed.length === 0,
    `★★★ 这 ${missed.length} 把键 V29 没搬：${missed.join('、')} —— ` +
      '八成是 `V29_PREFS` 里少了它（或者 kind 写错、值校验没过）。' +
      '漏搬是**静默**的：值留在 settings 里，界面拿到的是默认值，' +
      '他只会发现「我设过的东西升级完没了」，而日志里什么都没有'
  )
  assert(wrong.length === 0, `★★★ 搬过去的值变了：${wrong.join('；')}`)
  assert(
    leftBehind.length === 0,
    `★★ 搬成功了却没删旧键：${leftBehind.join('、')} —— 双真相就是这么来的`
  )
})

check('★★★ T-2.12 · `V29_PREFS` 的键集就是这 22 个字面量（快照，不从白名单推）', () => {
  /**
   * ★ 这 22 个字面量是**照着 2026-09-07 那天的 `PREF_SPECS` 抄下来的**，
   *   抄完那天逐条比过：两边一个不差（所以冻结不改变当时的行为）。
   *   从今往后它**只应该因为有人明确决定而变**，而且改它就要改这条用例 ——
   *   那正是我们要的：让「动历史迁移的键面」变成一件**必须过一次脑子**的事。
   * ★ 绝不写成 `assert(keys = PREF_KEYS)`，也绝不从 `V29_PREFS` 自己推出判据：
   *   那样两边一起漂的时候它照样绿（第一版的 ① 就是这么漏掉「名单变短」的）。
   */
  const EXPECTED = EXPECTED_V29.map((x) => x.key).sort()
  const got = V29_PREFS.map((s) => s.key).sort()
  const lost = EXPECTED.filter((k) => !got.includes(k))
  const extra = got.filter((k) => !EXPECTED.includes(k))
  assert(
    lost.length === 0,
    `★★★ 冻住的名单里少了：${lost.join('、')} —— V29 从此漏搬这几把，而且没有任何提示`
  )
  assert(extra.length === 0, `★★ 冻住的名单里多了：${extra.join('、')} —— 多搬也要是明确决定`)
  assert(got.length === EXPECTED.length, `★ 条数对不上：${got.length} ≠ ${EXPECTED.length}`)
})

check('★★★ T-2.12 · 往当前白名单里加一把键 → V29 一个字都不跟着变（键面已冻）', () => {
  /**
   * ★★★ I-149 · 这条守的是**一条已经写完的历史迁移不会被别处改掉**。
   *
   * V29 原来 `for (const spec of PREF_SPECS)` —— 遍历当前白名单。
   * 于是 T-7.9 退役三把语音键的那天，V29 的行为跟着变了，
   * 而没有人改过 V29 一个字（D-216 想挡的正是这个，只是它以前只管
   * 「别去编辑旧迁移」，管不住「旧迁移引用了会变的常量」）。
   *
   * 做法：往**当前**白名单里塞一把假键（`readonly` 只在编译期），
   * 再跑一次升级。冻结之前它会被当场搬进会同步的偏好表；
   * 冻结之后 V29 认的是自己那份 `V29_PREFS`，假键连看都不看一眼。
   *
   * ★ 负向对照：把 `V29_PREFS` 换回 `PREF_SPECS` 遍历 → 这一条当场红
   *   （`check:sql` 那道静态闸也会同时红）。
   * ★ 用完必须弹回去：`PREF_SPECS` 是模块级常量，留着会污染同进程后面的用例。
   */
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 28))
  const t = Date.now()
  const set = old.db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)`)
  set.run('param.dailyTarget', '95', t) // 冻住那份里的 —— 它必须照常搬
  set.run('fake.newpref', 'yes', t) // 假键 —— 它必须一动不动
  old.db.close()

  const live = PREF_SPECS as PrefSpec[]
  live.push({ key: 'fake.newpref', kind: 'text', says: 'T-2.12 的假键' })
  try {
    const up = openDatabase(p, backups)
    const prefs = new Prefs(up.db)
    assert(
      prefs.raw('param.dailyTarget') === '95',
      '前提没成立：冻住的那份键本来就该搬 —— 这一条不该把 V29 整个搬家关掉'
    )
    assert(
      !prefs.raw('fake.newpref'),
      '★★★ 白名单一加键，V29 就跟着搬了 —— 一条已经跑过的迁移又被别处改掉（I-149）'
    )
    const left = up.db.prepare(`select value from settings where key = 'fake.newpref'`).get() as
      | { value: string }
      | undefined
    assert(left?.value === 'yes', '★★★ 假键被搬走了，`settings` 里那份也删了 —— 他的设置就是这么丢的')
    up.db.close()
  } finally {
    live.pop()
  }
})

check('★★ Step 5A · canonical 已经有值 → 不许被旧键反向覆盖', () => {
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 28))
  const t = Date.now()
  // 先手工造出「偏好表已经有值」那个状态（模拟同步先到）
  old.db.exec(`
    create table if not exists user_preferences (
      uid text primary key not null, key text not null, value text not null,
      created_at integer not null, updated_at integer not null);
    create unique index if not exists idx_user_preferences_key on user_preferences (key);
  `)
  old.db
    .prepare(`insert into user_preferences (uid, key, value, created_at, updated_at) values (?,?,?,?,?)`)
    .run(prefUid('param.dailyTarget'), 'param.dailyTarget', '120', t, t)
  old.db
    .prepare(`insert into settings (key, value, updated_at) values ('param.dailyTarget', '95', ?)`)
    .run(t)
  old.db.close()

  const up = openDatabase(p, backups)
  assert(
    new Prefs(up.db).raw('param.dailyTarget') === '120',
    '★★ 旧键把已经有的 canonical 值盖掉了 —— 那是拿老值覆盖新值'
  )
  assert(
    !up.db.prepare(`select 1 as x from settings where key = 'param.dailyTarget'`).get(),
    '★ 旧键该删掉（它已经没有意义了）'
  )
  up.db.close()
})

check('★★ Step 5A · 值不合法 → 原地留着并记一笔，不「洗一下再塞进去」', () => {
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 28))
  const t = Date.now()
  const set = old.db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)`)
  set.run('param.dailyTarget', '', t) // 空串 —— Number('') 是 0，V26 那条坑
  set.run('qtypes', '{不是 JSON', t)
  set.run('tts.cloud', '真', t)
  old.db.close()

  const up = openDatabase(p, backups)
  const prefs = new Prefs(up.db)
  for (const k of ['param.dailyTarget', 'qtypes', 'tts.cloud']) {
    assert(prefs.raw(k) === null, `★★ ${k} 的坏值被搬进偏好表了`)
    assert(
      up.db.prepare(`select 1 as x from settings where key = ?`).get(k),
      `★★ ${k} 搬不动却把旧的删了 —— 数据丢了`
    )
  }
  const note = up.db
    .prepare(`select note from migration_log where name = '偏好搬家明细' order by id desc limit 1`)
    .get() as { note: string } | undefined
  assert(note && /param.dailyTarget/.test(note.note), '★ 搬不动的没记进 migration_log，他看不见')
  up.db.close()
})

check('★ Step 5A · V29 幂等：再跑一次一个字不变', () => {
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 28))
  old.db
    .prepare(`insert into settings (key, value, updated_at) values ('param.dailyTarget','95',?)`)
    .run(Date.now())
  old.db.close()
  const a = openDatabase(p, backups)
  const before = JSON.stringify(new Prefs(a.db).all())
  a.db.close()
  const b = openDatabase(p, backups) // 已经是 v29，不会再跑 V29
  assert(JSON.stringify(new Prefs(b.db).all()) === before, '★ 再打开一次偏好变了')
  b.db.close()
})

check('★★ Step 5A · 只有一个真相：生产代码里不许再读写偏好的旧 settings 键', () => {
  /**
   * 这条守的是将来。`insert into settings (key…) values ('qtypes'…)` 写起来太顺手了，
   * 而它一旦回来，「他勾了哪几种题型」就又有了两份答案 ——
   * 读的时候读哪一份？改的时候改哪一份？漂了之后谁说了算？
   */
  // ★ T-4.6 · study.ts 拆开了，六个领域文件也要扫（判据搬走了，闸要跟着搬）
  const files = [
    'study.ts',
    ...readdirSync(join(process.cwd(), 'src', 'main', 'study'))
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => 'study/' + f),
    'params.ts',
    'tts.ts',
    'ai/config.ts'
  ]
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), 'src', 'main', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1')
    for (const k of PREF_KEYS) {
      const pat = new RegExp(`settings[^\\n]*['\`]${k.replace('.', '\\.')}['\`]`)
      assert(!pat.test(src), `★★ ${f} 里又出现了对 settings['${k}'] 的直接读写`)
    }
  }
})

check('★★ Step 5A · 真库里 settings 不该再有任何偏好键', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  /**
   * ★ 要把**每一条写入路径**都走一遍。
   *   第一版只走了 ParamStore 和 setOrder —— 负向对照往 `setQtypes` 里
   *   塞了一句双写，这条用例居然没红。红的是覆盖不够，不是产品。
   */
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  new ParamStore(r.db).set('dailyTarget', 95)
  study.setOrder({ items: 'random', qtypes: 'seq' })
  study.setQtypes(study.qtypes())
  new Tts(r.db).save({ dictionary: true, system: true, accent: 'en-GB', rate: 1.1 })
  for (const k of PREF_KEYS) {
    assert(
      !r.db.prepare(`select 1 as x from settings where key = ?`).get(k),
      `★★ 偏好键 ${k} 又出现在 settings 里 —— 双真相`
    )
  }
  assert(new Prefs(r.db).raw('param.dailyTarget') === '95', '写进去的没落在偏好表')
  r.db.close()
})

// ── 秘密与设备配置：不许到达网络层 ─────────────────────────

check('★★ Step 5A · 秘密与设备配置都不在 SYNC_TABLES 里', () => {
  assert(SYNC_TABLES.includes('user_preferences'), '偏好表没进同步')
  // ★ SYNC_TABLES 是 `as const`，类型上就排除了这两个名字 —— 用 string[] 断言才验得到运行时
  const syncNames = SYNC_TABLES as readonly string[]
  assert(!syncNames.includes('settings'), '★★ settings 整张进了同步 —— API key 会上云')
  assert(!syncNames.includes('dictionaries'), '本地词典表不该同步')
})

checkAsync('★★ Step 5A · 秘密一步都到不了网络层（不是只看表，是看真的推出去什么）', async () => {
  await cloudReady
  const bucket = 's5-secret'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const t = Date.now()
  const set = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value`
  )
  const SECRETS = [
    ['ai.heavy.key', 'SECRET-AI-HEAVY-xyz'],
    ['ai.light.key', 'SECRET-AI-LIGHT-xyz'],
    ['ai.long.key', 'SECRET-AI-LONG-xyz'],
    ['tts.key', 'SECRET-TTS-xyz'],
    ['ai.heavy.model', 'DEVICE-ONLY-MODEL'],
    ['ai.heavy.baseUrl', 'https://device-only.example'],
    /**
     * ★ 哨兵值要**够长够特别**：短值（比如 `31`）在任何一包 JSON 里
     *   都能当子串撞上（时间戳、行数、id）。第一版就是这么假红的 ——
     *   红的是判据太糙，不是产品泄漏。
     *
     * ★★ D2.1 起 `dict.default` **不在这份清单里**了：它改判 USER，
     *   存的是跨设备身份 `dictUid`，本来就该跟着人走上云。
     *   设备级的是它旁边那些（路径、启用、排序、缓存），那些在 `dictionaries` 里，
     *   而 `dictionaries` 整张表不进 SYNC_TABLES。
     */
    ['tts.device.sentinel', 'DEVICE-ONLY-987654321']
  ] as const
  for (const [k, v] of SECRETS) set.run(k, v, t)
  // 偏好照常写，证明这一趟真的推了东西
  new ParamStore(r.db).set('dailyTarget', 95)

  /**
   * ★ 设备编号也要够特别：`configureSync` 给的是 `me`，
   *   而 `me` 这两个字母在任何一段中文/英文里都能当子串撞上。
   */
  r.db.prepare(`update settings set value = 'devSENTINEL9' where key = 'sync.device'`).run()

  const out = await r4Run(newSync(r, backups))
  assert(out.pushed > 0, '这一趟什么都没推，用例验不到东西')

  // ★ 判据是**云端那些文件的字节**，不是「表里有没有」
  const files = [...cloudFiles.entries()].filter(([k]) => k.includes(`${bucket}/nyx/`))
  const body = files.map(([, v]) => v).join('\n')
  assert(body.length > 0, '云端没有任何文件，用例验不到东西')
  for (const [k, v] of SECRETS) {
    assert(!body.includes(v), `★★ ${k} 的值出现在了推上云的包里：${v}`)
    assert(!body.includes(`"${k}"`), `★★ ${k} 这个键出现在了推上云的包里`)
  }

  /**
   * ★★ `sync.device` 是个例外，而且必须把例外说清楚：
   *
   * 它**不作为一行设置同步**，但它**必然出现在包名与包头上** ——
   * 包名是 `<设备>-<时间戳>.json`，拉的时候靠 `!name.startsWith(me + '-')`
   * 跳过自己推的包。那是协议的一部分，不是泄漏。
   *
   * 分清这两件事本身就是判据：它不许出现在**行数据**里。
   */
  const rowsOnly = files
    .filter(([k]) => k.includes('/nyx/chunks/'))
    .map(([, v]) => {
      try {
        return JSON.stringify((JSON.parse(v) as { rows?: unknown }).rows ?? [])
      } catch {
        return ''
      }
    })
    .join('\n')
  const dev = (r.db.prepare(`select value from settings where key='sync.device'`).get() as {
    value: string
  }).value
  assert(!rowsOnly.includes(dev), `★★ 设备编号出现在了行数据里：${dev}`)
  assert(!rowsOnly.includes('"sync.device"'), '★★ sync.device 作为一行设置被同步了')
  assert(body.includes(dev), '★ 包名/包头里反而没有设备编号 —— 那拉包时就分不出哪些是自己推的')
  // 偏好确实推出去了
  assert(body.includes('param.dailyTarget'), '★ 偏好没推出去 —— 那这条用例的对照组不成立')
  assert(body.includes('user_preferences'), '★ 偏好表的行没进包')
  r.db.close()
})

checkAsync('★★ Step 5A · 偏好跨设备：A 设 95 → B 同步后就是 95', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('s5-pref')
  new ParamStore(A.db).set('dailyTarget', 95)
  await syncA.run()
  const got = await syncB.run()
  assert(got.failed === 0, `同步有失败：${JSON.stringify(got.problems ?? []).slice(0, 300)}`)
  assert(
    new ParamStore(B.db).effective().dailyTarget === 95,
    `★★ B 上还是 ${new ParamStore(B.db).effective().dailyTarget} —— 偏好没跟过去`
  )
  A.db.close()
  B.db.close()
})

checkAsync('★★ Step 5A · 设备级配置不跟过去（A 改 model，B 不变）', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('s5-device')
  const t = Date.now()
  A.db
    .prepare(
      `insert into settings (key, value, updated_at) values ('ai.heavy.model','A-ONLY',?)
         on conflict(key) do update set value = excluded.value`
    )
    .run(t)
  await syncA.run()
  await syncB.run()
  const onB = B.db.prepare(`select value from settings where key='ai.heavy.model'`).get() as
    | { value: string }
    | undefined
  assert(onB?.value !== 'A-ONLY', '★★ 设备级的 AI 模型跟着同步过去了')
  A.db.close()
  B.db.close()
})

checkAsync('★★ D2.1 · 两机 · B 上有同一本词典 → 默认自动恢复', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('d21-same')
  const homeA = join(dirname(A.db.name), 'dicts')
  const homeB = join(dirname(B.db.name), 'dicts')
  // 两台上各放**同一本**词典（内容逐字相同 → 同一个 uid）+ 各自另有一本
  makeBook(homeA, '共同', [{ word: 'gap', body: '同一本' }])
  makeBook(homeA, '只有A', [{ word: 'gap', body: 'A 独有' }])
  makeBook(homeB, 'B自己的', [{ word: 'gap', body: 'B 独有' }])
  makeBook(homeB, '共同', [{ word: 'gap', body: '同一本' }])

  const da = new Dicts(A.db, homeA)
  da.rescan()
  const shared = da.registry.records().find((x) => x.bookname === '共同')!
  da.setDefaultBook(shared.id)
  const uid = shared.uid!
  await syncA.run()
  da.closeAll()

  await syncB.run()
  const db2 = new Dicts(B.db, homeB)
  db2.rescan()

  assert(new Prefs(B.db).raw('dict.default') === uid, '★★ 偏好没同步过去')
  const def = db2.defaultBook()
  /**
   * ★★ B 上那本「共同」的**本机 id 和 A 上不是同一个**（B 先扫到的是「B自己的」）——
   *   这正是旧写法（存本机 id）会指错书的地方。
   */
  assert(def.book?.bookname === '共同', `★★ 没恢复成他选的那本：${String(def.book?.bookname)}`)
  assert((def.book as { uid?: string | null }).uid === uid, '★★ 恢复成了别的书')
  assert(def.fellBack === false, '★ 明明找得到，却说自己退了')
  db2.closeAll()
  A.db.close()
  B.db.close()
})

checkAsync('★★ D2.1 · 两机 · B 上没有那本 → 退到可用的，但偏好一个字不改', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('d21-miss')
  const homeA = join(dirname(A.db.name), 'dicts')
  const homeB = join(dirname(B.db.name), 'dicts')
  makeBook(homeA, '只有A有', [{ word: 'gap', body: 'A 独有' }])
  makeBook(homeB, 'B自己的', [{ word: 'gap', body: 'B 独有' }])

  const da = new Dicts(A.db, homeA)
  da.rescan()
  const only = da.registry.records()[0]!
  da.setDefaultBook(only.id)
  const uid = only.uid!
  await syncA.run()
  da.closeAll()

  await syncB.run()
  const db2 = new Dicts(B.db, homeB)
  db2.rescan()

  const def = db2.defaultBook()
  assert(def.book?.bookname === 'B自己的', `★ 没退到可用的那本：${String(def.book?.bookname)}`)
  /**
   * ★★ **绝不回写。** 他哪天把那本词典拷到 B 上，就该自己回去 ——
   *   偷偷把偏好改成 B 现有的那本，等于替他做了一个他没做过的决定，
   *   而且会同步回 A，把 A 上的默认也改掉。
   */
  assert(
    new Prefs(B.db).raw('dict.default') === uid,
    `★★ fallback 把他的偏好改了：${String(new Prefs(B.db).raw('dict.default'))}`
  )
  db2.closeAll()
  A.db.close()
  B.db.close()
})

checkAsync('★★ Step 5A · 数组偏好整项冲突，不做逐元素合并', async () => {
  await cloudReady
  const { A, B, syncA, syncB } = await twoDevices('s5-array')
  const pa = new Prefs(A.db)
  const pb = new Prefs(B.db)
  pa.set('qtypes', JSON.stringify(['a', 'b']))
  pb.set('qtypes', JSON.stringify(['c']))

  await syncA.run()
  await syncB.run()
  const after = pb.raw('qtypes')
  const arr = JSON.parse(after ?? '[]') as string[]
  /**
   * ★★ 判据不是「等于某一边」——冲突怎么裁是现有机制的事。
   *   判据是：**结果必须是两边中的某一份原样**，绝不能出现第三种数组。
   *   `[a,b,c]` 那种「合并」两边都不认，也不是任何人做过的决定。
   */
  const isA = JSON.stringify(arr) === JSON.stringify(['a', 'b'])
  const isB = JSON.stringify(arr) === JSON.stringify(['c'])
  assert(isA || isB, `★★ 出现了第三种数组（逐元素合并了）：${after}`)
  assert(!(arr.includes('a') && arr.includes('c')), `★★ 两边的元素被合到一起了：${after}`)
  A.db.close()
  B.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 5B · V30 · 同步密钥不再明文（2026-08-18）
//
// 本轮唯一的最高优先级：**宁可升级失败，也不能让密钥丢掉。**
// 所以每一条用例的判据都落在「明文还在不在」上。
// ══════════════════════════════════════════════════════════════

/** 造一个可控的加解密层 —— 三条失败路径要能真的走一遍 */
function fakeCrypto(opts: {
  available?: boolean
  encryptThrows?: boolean
  decryptThrows?: boolean
  /** 解出来故意不一样（最阴的一种：加密成功、写进去了、解出来是别的） */
  corrupt?: boolean
} = {}): Crypto {
  return {
    available: () => opts.available !== false,
    encrypt: (plain) => {
      if (opts.encryptThrows) throw new Error('加密炸了')
      return ENC_PREFIX + Buffer.from(plain, 'utf8').toString('base64')
    },
    decrypt: (blob) => {
      if (opts.decryptThrows) throw new Error('解密炸了')
      const s = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64').toString('utf8')
      return opts.corrupt ? s + '污染' : s
    }
  }
}

const SECRET = 'sb_publishable_TESTONLY_do_not_log'

/** 建一个停在 v29、带明文密钥的库 */
function v29WithPlainSecret(secret = SECRET): { p: string; backups: string } {
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 29))
  old.db
    .prepare(`insert into settings (key, value, updated_at) values ('sync.secret', ?, ?)`)
    .run(secret, Date.now())
  old.db.close()
  return { p, backups }
}

const rawSecret = (db: Database.Database): string | null =>
  ((db.prepare(`select value from settings where key='sync.secret'`).get() as
    | { value: string }
    | undefined)?.value ?? null)

check('★★ Step 5B · 明文 → 密文，而且解得回原样', () => {
  setCrypto(fakeCrypto())
  try {
    const { p, backups } = v29WithPlainSecret()
    const up = openDatabase(p, backups)
    const stored = rawSecret(up.db)
    assert(stored !== null && isEncrypted(stored), `★★ 库里那一行不是密文：${String(stored).slice(0, 12)}…`)
    assert(!String(stored).includes(SECRET), '★★ 密文里还看得见明文')
    assert(new SecretStore(up.db).getSyncSecret() === SECRET, '★★ 解不回原样')
    up.db.close()
  } finally {
    setCrypto(null)
  }
})

check('★★ Step 5B · 解出来对不上 → 整条升级回滚，**明文一个字没删**', () => {
  setCrypto(fakeCrypto({ corrupt: true }))
  try {
    const { p, backups } = v29WithPlainSecret()
    let threw = false
    try {
      openDatabase(p, backups).db.close()
    } catch {
      threw = true
    }
    assert(threw, '★★ 解出来对不上却升级成功了 —— 那是把密钥换成了一串解不开的东西')
    // 明文必须原样还在（openDatabase 会用升级前的备份把整个文件换回去）
    const back = new Database(p)
    assert(rawSecret(back) === SECRET, `★★ 密钥没了：${String(rawSecret(back)).slice(0, 20)}`)
    back.close()
  } finally {
    setCrypto(null)
  }
})

check('★★ Step 5B · 加密失败 → 回滚，明文还在', () => {
  setCrypto(fakeCrypto({ encryptThrows: true }))
  try {
    const { p, backups } = v29WithPlainSecret()
    let threw = false
    try {
      openDatabase(p, backups).db.close()
    } catch {
      threw = true
    }
    assert(threw, '★★ 加密炸了却升级成功了')
    const back = new Database(p)
    assert(rawSecret(back) === SECRET, '★★ 密钥没了')
    back.close()
  } finally {
    setCrypto(null)
  }
})

check('★★ Step 5B · 解密失败 → 回滚，明文还在', () => {
  setCrypto(fakeCrypto({ decryptThrows: true }))
  try {
    const { p, backups } = v29WithPlainSecret()
    let threw = false
    try {
      openDatabase(p, backups).db.close()
    } catch {
      threw = true
    }
    assert(threw, '★★ 验不回来却升级成功了')
    const back = new Database(p)
    assert(rawSecret(back) === SECRET, '★★ 密钥没了')
    back.close()
  } finally {
    setCrypto(null)
  }
})

check('★★ Step 5B · 系统凭据不可用 → 回滚，绝不 fallback 到明文', () => {
  setCrypto(fakeCrypto({ available: false }))
  try {
    const { p, backups } = v29WithPlainSecret()
    let msg = ''
    try {
      openDatabase(p, backups).db.close()
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    assert(msg !== '', '★★ 系统凭据不可用却照样升级了')
    assert(/凭据/.test(msg), `话没说清是凭据的问题：${msg.slice(0, 120)}`)
    const back = new Database(p)
    assert(rawSecret(back) === SECRET, '★★ 密钥没了')
    back.close()
  } finally {
    setCrypto(null)
  }
})

check('★ Step 5B · 从来没配过同步的库：不要求系统凭据可用，照常升级', () => {
  setCrypto(fakeCrypto({ available: false }))
  try {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups) // 全新库，没有 sync.secret
    assert(r.toVersion === TARGET_VERSION, `没配过密钥的库也该升上来：${r.toVersion}`)
    assert(rawSecret(r.db) === null, '凭空长出了一个密钥')
    r.db.close()
  } finally {
    setCrypto(null)
  }
})

check('★★ Step 5B · 幂等：再跑一次不重复加密、不覆盖、解出来仍然一样', () => {
  setCrypto(fakeCrypto())
  try {
    const { p, backups } = v29WithPlainSecret()
    const a = openDatabase(p, backups)
    const first = rawSecret(a.db)
    a.db.close()

    // 直接再调一次迁移那一步（正常路径下它不会再跑，这里是硬打一次）
    const again = new Database(p)
    const r = migratePlaintextSyncSecret(again)
    assert(r.state === 'already', `★★ 已经是密文却被当成明文又处理了一遍：${r.state}`)
    assert(rawSecret(again) === first, '★★ 密文被覆盖了')
    assert(new SecretStore(again).getSyncSecret() === SECRET, '★★ 再跑一次之后解不回原样')
    again.close()
  } finally {
    setCrypto(null)
  }
})

checkAsyncSerial('★★ Step 5B · saveConfig 只写密文；config 读得回明文', async () => {
  setCrypto(fakeCrypto())
  try {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    const sync = new Sync(r.db, join(backups, 'audio'), backups)
    await sync.saveConfig({ kind: 'supabase', url: 'https://x.example', user: 'nyx', secret: SECRET })

    const stored = rawSecret(r.db)
    assert(stored !== null && isEncrypted(stored), '★★ saveConfig 又写了明文')
    assert(!String(stored).includes(SECRET), '★★ 库里看得见明文')
    assert((await sync.config()).secret === SECRET, '★★ config() 读不回密钥')
    assert((await sync.status()).hasSecret === true, 'hasSecret 该是 true')
    r.db.close()
  } finally {
    setCrypto(null)
  }
})

checkAsyncSerial('★★ Step 5B · 系统凭据不可用时 saveConfig 抛，而且不留下明文', async () => {
  setCrypto(fakeCrypto({ available: false }))
  try {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    const sync = new Sync(r.db, join(backups, 'audio'), backups)
    let threw = false
    try {
      await sync.saveConfig({ kind: 'supabase', url: 'https://x.example', user: 'nyx', secret: SECRET })
    } catch {
      threw = true
    }
    assert(threw, '★★ 凭据不可用却把密钥保存了')
    assert(rawSecret(r.db) === null, '★★ 留下了明文 —— 绝不许 fallback')
    r.db.close()
  } finally {
    setCrypto(null)
  }
})

check('★★ Step 5B · 秘密的边界：safeStorage 只在 secrets.ts 里出现（同步这条线）', () => {
  // ★ 扫的是代码，不是注释 —— 注释里提一句「这一层之外没人碰 safeStorage」是好事
  const src = readFileSync(join(process.cwd(), 'src', 'main', 'sync', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/g, '$1')
  assert(!/safeStorage/.test(src), '★★ sync/index.ts 里又直接碰 safeStorage 了 —— 边界破了')
  const store = readFileSync(join(process.cwd(), 'src', 'main', 'db', 'secrets.ts'), 'utf8')
  assert(/safeStorage/.test(store), 'secrets.ts 里反而没有 safeStorage')
})

checkAsyncSerial('★★ Step 5B · 端到端：真跑一次同步，库里没有明文、云端也没有', async () => {
  await cloudReady
  setCrypto(fakeCrypto())
  try {
    const bucket = 's5b-e2e'
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    const sync = new Sync(r.db, join(backups, 'audio'), backups)
    // 走真实保存路径（不是直接塞 settings）
    await sync.saveConfig({
      kind: 'webdav',
      url: `http://127.0.0.1:${cloudPort}/${bucket}`,
      user: 'u',
      secret: SECRET
    })

    const out = await sync.run()
    assert(out.pushed > 0, '这一趟什么都没推，验不到东西')

    // ① 库里没有明文
    const all = (r.db.prepare(`select key, value from settings`).all() as { key: string; value: string }[])
      .map((x) => `${x.key}=${x.value}`)
      .join('\n')
    assert(!all.includes(SECRET), '★★ 数据库里还能搜到明文密钥')

    // ② 云端没有
    const body = [...cloudFiles.entries()]
      .filter(([k]) => k.includes(`${bucket}/nyx/`))
      .map(([, v]) => v)
      .join('\n')
    assert(body.length > 0, '云端没有文件，验不到东西')
    assert(!body.includes(SECRET), '★★ 密钥出现在了推上云的包里')
    assert(!body.includes('sync.secret'), '★★ sync.secret 这个键出现在了包里')

    // ③ 「重启」之后还能用：新开一个连接，配置读得回来、还能再同步一次
    r.db.close()
    const again = openDatabase(p, backups)
    const sync2 = new Sync(again.db, join(backups, 'audio'), backups)
    assert((await sync2.config()).secret === SECRET, '★★ 重开之后密钥用不了了')
    const out2 = await sync2.run()
    assert((out2.rejected ?? 0) === 0 && out2.failed === 0, `重开之后同步不正常：${JSON.stringify(out2).slice(0, 200)}`)
    again.db.close()
  } finally {
    setCrypto(null)
  }
})

