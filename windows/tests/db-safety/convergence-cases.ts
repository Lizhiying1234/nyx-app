/**
 * 同步协议后半：Step 6A.1 行为基线 · 6B NC6 · 6C 双基线时序 · 7A Oracle 自检 · 7C G2 世代 · 7D 时间源 · 7E 双设备收敛（含 #19 / #20）
 *
 * 原 tests/db-safety.ts 第 17050–20506 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { makeBackup } from '../../src/main/db/backup.ts'
import { MIGRATIONS, SYNC_TABLES } from '../../src/main/db/migrations.ts'
import { resolutionUid } from '../../src/core/resolution.ts'
import { Exporter } from '../../src/main/export.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { SYNC_PROTOCOL_VERSION } from '../../src/core/sync-protocol.ts'
import { hardDelete } from '../../src/core/cascade.ts'
import { wrapDb } from '../../src/main/db/async-db.ts'
import { convergenceProblems, runUntilFixedPoint, snapshot, type ConvergenceDevice, type DbLike } from '../convergence.ts'
import { createHash } from 'node:crypto'
import { factoryReset } from '../../src/main/factory-reset.ts'
import { checkGeneration } from '../../src/main/db/verify-db.ts'
import { allowsTestClock, installClock, isFakeClock, makeClock, now, parseClockSpec, resetClock } from '../../src/main/clock.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, cloudFiles, cloudHook, cloudReady, localIdentity, putChunk, configureSync, syncState, seedPicks, twoDevices, BASELINE_DIR, CASES, devA, devB, E7 } from './fixtures.ts'
import type { Observation, Pair } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ Step 6A.1 · 旧实现的行为基线（2026-08-18）
//
// 这不是单元测试，是**行为契约**：把当前 `main/sync/index.ts` 真实产生的
// 结果录下来，等 Commit B 把编排搬进 core 之后，逐项比对。
//
// ── 三条不许破的规矩 ────────────────────────────────────────
//
// ① 基线**只能来自旧实现自己跑出来的结果**。
//    绝不许让 `core/sync/session.ts` 参与计算 —— 那样 old 和 new 会共用
//    同一个错误，比较就失去意义（变成「new 和 new 比」）。
//    下面一行都没有 import core/sync/session。
// ② 期望值**不许手写**。手写的期望是「我以为它应该怎样」，
//    而基线要的是「它实际上就是这样」。全部由 `--sync-baseline` 录制。
// ③ 比较器本身要防假绿：故意改一处旧输出，比较必须发现（见最后那条 NC）。
// ══════════════════════════════════════════════════════════════

/** 一次同步之后能观察到的**全部**东西 */

/** 把随机 uid / 时间戳抹平，否则每次录出来的都不一样 */

/** 一个 baseline case：造场景 → 真跑一次 → 观察 */

/** 通用夹具：建库、配同步、塞包、跑一趟 */

/** 录：真跑一遍，把观察写成 fixture */

/** 比：重放同一个场景，逐项和 fixture 对 */
function diffObservation(a: Observation, b: Observation): string[] {
  const bad: string[] = []
  const walk = (path: string, x: unknown, y: unknown): void => {
    if (JSON.stringify(x) === JSON.stringify(y)) return
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y as object)])) {
        walk(`${path}.${k}`, (x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k])
      }
      return
    }
    bad.push(`${path}: 基线 ${JSON.stringify(x)} ≠ 现在 ${JSON.stringify(y)}`)
  }
  walk('', a, b)
  return bad
}

for (const c of CASES) {
  checkAsync(`★★ Step 6A.1 · 基线回放 · ${c.name}`, async () => {
    const file = join(BASELINE_DIR, `${c.name}.json`)
    assert(existsSync(file), `★★ 缺少基线 ${c.name} —— 跑 \`npm run sync:baseline\` 录一份`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { observation: Observation }
    const now = await c.run(`re-${c.name}`)
    const bad = diffObservation(saved.observation, now)
    assert(
      bad.length === 0,
      `★★ ${c.name} 的行为和基线不一样了：\n  ${bad.slice(0, 6).join('\n  ')}`
    )
  })
}

check('★★ Step 6A.1 · 基线齐全，而且不是手写的', () => {
  assert(CASES.length >= 16, `基线只有 ${CASES.length} 个 case，至少要 16 个`)
  for (const c of CASES) {
    const file = join(BASELINE_DIR, `${c.name}.json`)
    assert(existsSync(file), `缺少 ${c.name}.json`)
    const j = JSON.parse(readFileSync(file, 'utf8')) as { input: string; observation: Observation }
    assert(typeof j.input === 'string' && j.input.length > 0, `${c.name} 没写输入类型`)
    for (const k of ['tally', 'watermark', 'packages', 'pushed', 'writeOrder', 'boundaryLookups'] as const) {
      assert(j.observation[k] !== undefined, `${c.name} 少了 ${k}`)
    }
  }
})

check('★★ Step 6A.1 · 基线不许依赖 core/sync/session —— 否则是「new 和 new 比」', () => {
  /**
   * 这一条守的是整个基线的意义。
   * 一旦录制那一侧用上了将来的 Plan/Apply，old 与 new 就共用同一个错误，
   * 比较永远绿，而它什么都没证明。
   */
  // ★ 认的是真正的 import，不是文本里出现过这几个字 —— 否则会扫到本条断言自己
  const IMPORTS_SESSION = /^[ \t]*import[^\r\n]*core\/sync\/session/m
  const src = readFileSync(join(process.cwd(), 'tests', 'db-safety.ts'), 'utf8')
  assert(!IMPORTS_SESSION.test(src), '★★ 基线 import 了 core/sync/session —— 那就成了「new 和 new 比」')
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 6C · 双基线状态时序（2026-08-18）
//
// 这一整段验的是**两个字段各自只承载自己那件事实**：
//
//   synced_updated_at  我已经处理/对账到的那个**远端**版本 → merge 的共同基版本
//   pushed_updated_at  我已经成功交给远端存储的那个**本地**版本 → 只管待推
//
// 混成一个的后果已经被两轮实测抓到过：
//   · 未裁决的冲突行被推出去 → 基版本顶到本地版本 → 下一趟「只有云端改过」
//     → 他还没回答问题就被替他答了（14 条同族失败）
//   · 他选了「用本地的」，对面在他的版本传过去**之前**又改了一版 →
//     基版本已经顶到他的版本 → 那一版新改动静默盖掉他的决定（R-4-F-a ⑩）
// ══════════════════════════════════════════════════════════════

/** 读某一行的双基线状态 */
function rowState(
  db: Database.Database,
  table: string,
  uid: string
): { synced: number | null; pushed: number | null } {
  const r = db
    .prepare(
      `select synced_updated_at as synced, pushed_updated_at as pushed
         from row_sync_state where table_name = ? and uid = ?`
    )
    .get(table, uid) as { synced: number | null; pushed: number | null } | undefined
  return r ?? { synced: null, pushed: null }
}

/** 库里那一行现在的业务版本 */
function localVer(db: Database.Database, table: string, uid: string): number {
  return Number(
    (db.prepare(`select updated_at as v from "${table}" where uid = ?`).get(uid) as { v: number })
      .v
  )
}

checkAsync('★★ Step 6C · Case 1–4 · push 成功不许顺手推进 synced', async () => {
  await cloudReady
  const bucket = '6c-seq'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const sync = new Sync(r.db, join(backups, 'audio'), backups)
  const uid = (r.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid

  // ── Case 1 · 初始：两个字段都没有 ──────────────────────────
  {
    const s = rowState(r.db, 'projects', uid)
    assert(s.synced === null && s.pushed === null, `Case 1 起点就不干净：${JSON.stringify(s)}`)
  }

  // ── Case 2 · 推 V1 成功 ────────────────────────────────────
  const v1 = localVer(r.db, 'projects', uid)
  await sync.run()
  {
    const s = rowState(r.db, 'projects', uid)
    assert(s.pushed === v1, `Case 2 · pushed 该是 V1(${v1})，实际 ${s.pushed}`)
    /**
     * ★★ 这一条是整个 6C 的心脏。
     *
     * 这一趟没有任何远端分歧，所以「推出去的那一版」确实成了共同基版本 ——
     * synced 前进是**对的**。真正不许发生的是「**明知有分歧还顶**」，
     * 那两条由 Case 5–7 与 ⑩ 守着。这里只钉住：pushed 必须精确等于推出去的那一版。
     */
    assert(s.synced === v1, `Case 2 · 无分歧时 synced 该随之确立：${JSON.stringify(s)}`)
  }

  // ── Case 3 · 本地改成 V2 → 待推 ────────────────────────────
  const v2 = Date.now() + 1000
  r.db.prepare(`update projects set name = 'V2', updated_at = ? where uid = ?`).run(v2, uid)
  {
    const s = rowState(r.db, 'projects', uid)
    assert(s.pushed === v1, `Case 3 · 本地改动不该动 pushed：${JSON.stringify(s)}`)
    assert(localVer(r.db, 'projects', uid) !== s.pushed, 'Case 3 · 该判成待推')
  }

  // ── Case 4 · 推 V2 成功 ────────────────────────────────────
  await sync.run()
  {
    const s = rowState(r.db, 'projects', uid)
    assert(s.pushed === v2, `Case 4 · pushed 该顶到 V2(${v2})，实际 ${s.pushed}`)
  }
  r.db.close()
})

checkAsync('★★ Step 6C · Case 5–8 · 裁决之后对面再改，必须重新问他', async () => {
  await cloudReady
  const bucket = '6c-seq2'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const sync = new Sync(r.db, join(backups, 'audio'), backups)
  const uid = (r.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid

  await sync.run() // 立起 synced / pushed
  const base = rowState(r.db, 'projects', uid).synced
  assert(base !== null, '前提：第一趟之后该有共同基版本')

  // 本地改 V2
  const v2 = Date.now() + 1000
  r.db.prepare(`update projects set name = '我改的', updated_at = ? where uid = ?`).run(v2, uid)

  // ── Case 5 · 远端 V3 → CONFLICT ────────────────────────────
  const v3 = v2 + 1000
  const row = r.db.prepare(`select * from projects where uid = ?`).get(uid) as Record<string, unknown>
  putChunk(bucket, 'other-100.json', [
    { uid, table: 'projects', updatedAt: v3, data: { ...row, name: '对面改的', updated_at: v3 } }
  ])
  const c1 = await sync.run()
  assert(c1.conflicted === 1, `Case 5 · 该判冲突：${JSON.stringify(c1)}`)

  // ── Case 6 · 选「用本地的」→ 收敛，下一轮不再问 ────────────
  await sync.run('local')
  const after = await sync.run()
  assert(after.conflicted === 0, `Case 6 · 同一个裁决又被问了一遍：${JSON.stringify(after)}`)
  assert(
    String(
      (r.db.prepare(`select name from projects where uid = ?`).get(uid) as { name: string }).name
    ) === '我改的',
    'Case 6 · 他的决定没留住'
  )

  // ── Case 7 · 对面**之后**又改出 V4 → 必须重新问 ────────────
  /**
   * ★★ 这就是 R-4-F-a ⑩。V4 是在他的裁决版本传到对面**之前**做出来的，
   * 和他的决定并发，不是它的后继。把它静默收下就是替他推翻自己的决定。
   */
  const v4 = v3 + 10_000
  const cur = r.db.prepare(`select * from projects where uid = ?`).get(uid) as Record<string, unknown>
  putChunk(bucket, 'other-200.json', [
    { uid, table: 'projects', updatedAt: v4, data: { ...cur, name: '对面又改了', updated_at: v4 } }
  ])
  const c2 = await sync.run()
  assert(
    c2.conflicted === 1,
    `Case 7 · 对面裁决后的新改动被静默吞掉了：${JSON.stringify({
      conflicted: c2.conflicted,
      applied: c2.applied,
      skipped: c2.skipped
    })}`
  )
  assert(
    String(
      (r.db.prepare(`select name from projects where uid = ?`).get(uid) as { name: string }).name
    ) === '我改的',
    'Case 7 · 没裁决就动了库'
  )

  // ── Case 8 · 本地再改 V5，远端仍是 V4 → 仍然冲突 ────────────
  const v5 = v4 + 5000
  r.db.prepare(`update projects set name = '我又改了', updated_at = ? where uid = ?`).run(v5, uid)
  const c3 = await sync.run()
  assert(
    c3.conflicted === 1,
    `Case 8 · 两边都相对共同基版本动过，必须冲突而不是比大小：${JSON.stringify(c3)}`
  )
  r.db.close()
})

checkAsync('★★ Step 6C · Case 9 · push race：推的过程中他又改了一次', async () => {
  /**
   * ★★ 记的必须是**这一次真正推出去的那一版**，不是「库里现在是什么版本」。
   *
   *     本地 V1 → 开始推 V1 → 他改成 V2 → V1 推送成功
   *
   * 记成 V2 的话，V2 从来没上过云端却被标成已推出 ——
   * 它再也不会被收集，**永久漏一行**，而四个数全对、体检不亮。
   *
   * ★ 时机是**确定的**：改库这件事挂在假云端的 PUT 落地钩子上，
   *   所以它必然发生在「collect 已经取好快照」之后、「put 返回成功」之前。
   *   用 setTimeout 猜时机会做出一条时灵时不灵的用例，那比没有用例更坏。
   */
  await cloudReady
  const bucket = '6c-race'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const uid = (r.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
  const v1 = localVer(r.db, 'projects', uid)
  const v2 = v1 + 60_000

  let raced = false
  cloudHook.onPut = (path): void => {
    // 只在推**变更包**那一次动手，devices/audio 的 PUT 不算
    if (raced || !path.includes('/nyx/chunks/')) return
    r.db.prepare(`update projects set name = 'V2', updated_at = ? where uid = ?`).run(v2, uid)
    raced = true
  }
  try {
    const sync = new Sync(r.db, join(backups, 'audio'), backups)
    await sync.run()
  } finally {
    cloudHook.onPut = null
  }

  assert(raced, '前提没成立：没造出竞态（这一趟根本没推变更包）')
  assert(localVer(r.db, 'projects', uid) === v2, '前提：库里现在应该是 V2')

  const s = rowState(r.db, 'projects', uid)
  assert(
    s.pushed === v1,
    `★★ push race · pushed 被写成了库里的新版本（${s.pushed}），而真正推出去的是 V1(${v1}） —— ` +
      `V2 从没上过云端却被标成已推出，那一行从此再不被收集：永久漏一行`
  )
  assert(
    localVer(r.db, 'projects', uid) !== s.pushed,
    '★ V2 必须仍然算待推（下一趟自然会把它带走）'
  )
  /** synced 同理不得被这一次推送错误推进到 V2 */
  assert(s.synced !== v2, `★★ synced 被错误推进到了从没对过账的 V2：${JSON.stringify(s)}`)
  r.db.close()
})

check('★★ Step 6C · PRISTINE = 0 · 出厂内容不是本地待推变更', () => {
  /**
   * ★★ `updated_at = 0` 是**既有的协议语义**（`db/builtins.ts` 的 `PRISTINE`）：
   * 出厂那一刻不是变更，两台设备各自播种同一份内容，没有任何东西要传给对方。
   *
   * 逻辑待推谓词换掉墙钟水位之后，这条语义**必须原样保留** ——
   * 不保留的话第一次同步会把 22 条出厂内容推出去，而 `builtins.ts` 的注释
   * 记着实测后果：「第一次同步 22 处冲突，而他一条都没碰过」。
   *
   * ★ 不只看 SQL 字符串：下面直接数**真库里** `updated_at = 0` 的行，
   *   再数待推的行，断言前者一条都不在后者里。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const pristine = SYNC_TABLES.map((t) => {
    try {
      return (
        r.db.prepare(`select count(*) as n from "${t}" where updated_at = 0`).get() as { n: number }
      ).n
    } catch {
      return 0
    }
  }).reduce((a, b) => a + b, 0)
  assert(pristine >= 20, `前提没成立：库里只有 ${pristine} 条出厂内容，验不出这条语义`)

  const pending = SYNC_TABLES.map((t) => {
    try {
      return (
        r.db
          .prepare(
            `select count(*) as n from "${t}" t
               left join row_sync_state s on s.table_name = ? and s.uid = t.uid
              where t.updated_at <> 0
                and (s.pushed_updated_at is null or s.pushed_updated_at <> t.updated_at)`
          )
          .get(t) as { n: number }
      ).n
    } catch {
      return 0
    }
  }).reduce((a, b) => a + b, 0)

  const all = SYNC_TABLES.map((t) => {
    try {
      return (
        r.db
          .prepare(
            `select count(*) as n from "${t}" t
               left join row_sync_state s on s.table_name = ? and s.uid = t.uid
              where (s.pushed_updated_at is null or s.pushed_updated_at <> t.updated_at)`
          )
          .get(t) as { n: number }
      ).n
    } catch {
      return 0
    }
  }).reduce((a, b) => a + b, 0)

  assert(
    all - pending === pristine,
    `★★ 去掉 \`updated_at <> 0\` 之后多出来的待推行数（${all - pending}）` +
      `应该正好等于出厂内容的行数（${pristine}）—— 这条语义没守住`
  )
  r.db.close()
})

/**
 * ★★ Step 6C · 基线**分两代**钉死（2026-08-18）
 *
 * ── 为什么不是直接覆盖 ──────────────────────────────────────
 *
 * 6C 换掉的是「谁算改过」和「什么算待推」这两条语义，18 个场景里有
 * **两个**因此产生了预期内的行为变化。直接覆盖旧基线的话，那两处变化
 * 就和「不小心改坏了」长得一模一样，而且再也查不出来。
 *
 * 所以旧那一份原样留在 `tests/sync-baseline-v1/`（摘要 43da0c1f…，
 * 就是 6A.1 录下来的那一份），新的一份在 `tests/sync-baseline/`。
 * 两份逐字节比对过：**18 份里只有 2 份不同**，下面逐条写清为什么。
 *
 * ── 那两处变化各是什么 ──────────────────────────────────────
 *
 * `12-schema-mismatch`
 *   诊断文案里的结构版本号 `v30` → `v31`。V31 建了 `row_sync_state`，
 *   本地结构版本当然要涨。**同步表面指纹 `9dde78ab1d916501` 一个字没变**
 *   （那张表不是同步表），所以协议、包格式、存量包全部照旧。
 *
 * `17-pull-only`
 *   `pushed` 0 → 15。这个场景人为把水位设成 `now + 60_000`，
 *   旧实现的 `collectSince` 是 `updated_at > 水位`，于是**一行都推不出去**——
 *   而那 15 行是真真切切没推过的本地内容。**这正是 rollback 会永久漏推的那个洞**：
 *   时钟一回拨，水位就落在未来，窗口里的编辑从此再也不被收集。
 *   新的待推判据是逻辑的（当前版本 ≠ 已成功推出的那一版），不看时钟，
 *   所以它们正常推出去了。**这一处变红恰恰是修好了的证据。**
 *
 * ── 其余 16 份必须逐字节不变 ────────────────────────────────
 *
 * 下面那条断言同时钉住两代的摘要。任何一代变了都会红 ——
 * 包括「改坏了就重录一遍基线然后宣布 old == new」这条最危险的自欺。
 */
check('★★ Step 6C · 两代基线各自钉死，而且只有 12 / 17 两处预期变化', () => {
  /**
   * ★ 摘要必须对**内容**取，不能对**字节**取。
   *
   * 这个仓库 `core.autocrlf=true`：同一份文件在 checkout 之后可能变成 CRLF，
   * 而刚写出来的那份是 LF。按字节取摘要的话，一次分支切换就能让这条断言变红，
   * 而基线**一个字都没改过** —— 那种误报会让人很快学会忽略它。
   */
  const digestOf = (dir: string): string => {
    const h = createHash('sha256')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      h.update(f)
      h.update(readFileSync(join(dir, f), 'utf8').split(String.fromCharCode(13)).join(''))
    }
    return h.digest('hex')
  }
  const norm = (x: string): string => x.split(String.fromCharCode(13)).join('')
  const V1 = join(process.cwd(), 'tests', 'sync-baseline-v1')
  const V2 = BASELINE_DIR

  /** 6A.1 录下来的那一份 —— 旧实现的行为，永远不许再动 */
  const V1_DIGEST = '43da0c1fd59340e04a1dcdc57d07ea0207aa657b402daa91f6907fa4b68ac6bf'
  /**
   * 6C 双基线模型之后的预期行为。
   *
   * ── 2026-08-19 · D2 / D2.1 各换过一次 ★ ─────────────────
   * 独立证据（不是「跑一遍看它要什么就填什么」）：
   *   · `git diff tests/sync-baseline/` **每次只有一行**：
   *     12-schema-mismatch 里的 `另一台是 v31` → `v32` → `v33`
   *   · 那一行是加 migration 之后**必然**会变的 ——
   *     那条场景验的就是「两台设备结构版本不一样时整包拒」，
   *     文案里带着本机的结构版本号。
   *   · 同步表面指纹 `9dde78ab1d916501` **一个字符都没变**：
   *     V32 动的是 `dictionaries`（本来就不在 SYNC_TABLES 里），
   *     V33 动的是 `user_preferences` 里的**一行数据**，不是表结构。
   */
  /**
   * ── 2026-08-25 · D-296（V34 认读卡拆表）又换了一次 ★ ──────
   *
   * 独立证据（不是「跑一遍看它要什么就填什么」）：
   *   · `git diff tests/sync-baseline/` **仍然只有一行**：
   *     12-schema-mismatch 里的 `另一台是 v33（指纹 9dde78ab）`
   *     → `另一台是 v34（指纹 07dd1cfd）`。
   *   · 那一行是加 migration 之后**必然**会变的 —— 那条场景验的就是
   *     「两台设备结构版本不一样时整包拒」，文案里带着本机的结构版本与指纹。
   *   · 这一次同步表面指纹**确实变了**（`9dde78ab1d916501` → `07dd1cfd1f4f514a`），
   *     而且**本来就该变**：V34 往同步表面加了一张 `reading_cards`（30 → 31 张）。
   *     指纹变 = 老版本设备被握手挡住，正是 D-269 要的行为。
   *   · 其余 17 份**逐字未变** —— 也就是说这次重构没有动到
   *     plan/apply 的任何一条判据。那才是真正要守的东西。
   */
  /**
   * ── 2026-08-26 · D-349 / D-350（V35 补三列）又换了一次 ★ ──────
   *
   * 独立证据（不是「跑一遍看它要什么就填什么」）：
   *   · `git status --short tests/sync-baseline/` **只有一个文件**，
   *     `git diff --numstat` **只有一行**：12-schema-mismatch 里的
   *     `另一台是 v34（指纹 07dd1cfd）` → `另一台是 v35（指纹 c3d37adb）`。
   *   · 那一行是加 migration 之后**必然**会变的 —— 那条场景验的就是
   *     「两台设备结构版本不一样时整包拒」，文案里带着本机的结构版本与指纹。
   *   · 指纹**本来就该变**（`07dd1cfd1f4f514a` → `c3d37adb99cec8af`）：
   *     V35 往 **`review_logs` / `answers` / `sessions`** 三张**同步表**各加了列。
   *     指纹变 = 没升级的那一端被握手挡住，正是 D-269 要的行为，
   *     也正是 D-355 §6.2 ② 说的「v35 是一次协调发布」。
   *   · 其余 17 份**逐字未变** —— 这次改动没有动到 plan/apply 的任何一条判据。
   *     加列是纯增量，不改任何编排逻辑，这一点由它们自己证明。
   */
  /**
   * ── 2026-09-02 · D-436③（V36 · item_lectures 加 deleted_at）又换了一次 ★ ──
   *
   * 独立证据（不是「跑一遍看它要什么就填什么」）：
   *   · `git status --short tests/sync-baseline/` **只有一个文件**，
   *     `git diff --numstat` **只有一行**（1 增 1 删）：12-schema-mismatch 里的
   *     `另一台是 v35（指纹 c3d37adb）` → `另一台是 v36（指纹 cadb369e）`。
   *   · 那一行是加 migration 之后**必然**会变的 —— 那条场景验的就是
   *     「两台设备结构版本不一样时整包拒」，文案里带着本机的结构版本与指纹。
   *   · 指纹**本来就该变**（`c3d37adb99cec8af` → `cadb369e52c0e335`）：
   *     V36 往同步表 `item_lectures` 加了一列。
   *     ★ 这个值不是从这条用例的报错里抄来的 —— 它是 `npm run schema:dump`
   *     自己打出来的那一句「v36 · 同步表面指纹 cadb369e52c0e335」，两处独立相符。
   *   · 其余 17 份**逐字未变** —— 加列是纯增量，不改任何编排判据，由它们自己证明。
   */
  /**
   * ── 2026-09-03 · V37（清掉小操练的残留）又换了一次 ★ ─────────
   *
   * ★★ **这一次和前四次都不一样：指纹必须「不变」。**
   * V37 是一条**纯数据迁移** —— 删 `analysis_blocks` 里的 drill 块、
   * 清空 `item_events`、删 `user_preferences` 的 `drill.qtypes`，
   * **一列都没加、一张表都没动**。所以要证的不是「指纹该变」，
   * 而是「**指纹一个字符都不许变**」。
   *
   * 独立证据（不是「跑一遍看它要什么就填什么」）：
   *   · `git status --short tests/sync-baseline/` **只有一个文件**，
   *     `git diff --numstat` **1 增 1 删**：12-schema-mismatch 里的
   *     `另一台是 v36（指纹 cadb369e）` → `另一台是 v37（指纹 cadb369e）`。
   *     ★ **版本号变了、指纹没变** —— 这正是纯数据迁移该有的样子。
   *   · `diff schema/v36.sql schema/v37.sql` 只有 **4 处**不同，
   *     全部是版本号与头部注释（`-- … v36` → `v37`、`pragma user_version`）：
   *     **没有任何一张表、一个列、一条索引、一条触发器不同。**
   *   · `npm run schema:dump` 自己打出来的是「v37 · 同步表面指纹
   *     cadb369e52c0e335」，和 v36 那一次打出来的**同一个值**，两处独立相符。
   *   · 因此**两端不用为它协调升级**：结构没变，握手不会挡（D-269 那条闸
   *     看的是指纹，不是版本号）。
   *   · 其余 17 份**逐字未变** —— 删数据不改任何编排判据，由它们自己证明。
   */
  /**
   * ── 2026-09-04 · V38（D-461 清账，2026-09-03 加的迁移；基线当时没重录）★ ──
   *
   * ★★ 和 V37 同型：**纯数据迁移，指纹必须「不变」。**
   * V38 只删 `settings` 里三笔退役提示词的出厂指纹（drill-check · drill-more · pick-materials），
   * `picks` 一行没碰（数过是 0 行）。**一列都没加、一张表都没动。**
   *
   * ★ 这一次是**补录**：V38 落地那天只重生成了 `schema/v38.sql`（D-461 记的「加迁移要重生成快照」），
   *   漏了这第二份 —— 于是「基线回放 · 12-schema-mismatch」从 09-03 起安静地红着，
   *   直到 09-04 Phase 1A 收尾第一次把整条 `verify` 跑到 `test:db` 才现形。
   *   「每轮收尾跑全量，不挑」正是为了这种红。
   *
   * 独立证据（不是「跑一遍看它要什么就填什么」）：
   *   · `npm run sync:baseline` 重录 18 份后 `git diff --stat tests/sync-baseline/` **只有一个文件、1 增 1 删**：
   *     12-schema-mismatch 里的 `另一台是 v37（指纹 cadb369e）` → `另一台是 v38（指纹 cadb369e）`。
   *     ★ **版本号变了、指纹没变** —— 纯数据迁移该有的样子。
   *   · `npm run check:schema` 同一轮打出「本地结构 v38 · 同步指纹 cadb369e52c0e335 · 协议 v3」，
   *     与 v36 / v37 那两次**同一个值**，两处独立相符。
   *   · 其余 17 份**逐字未变** —— 删数据不改任何编排判据，由它们自己证明。
   */
  /**
   * ── 2026-09-15 · 屏上字里的裸 `**` 全改成「」又换一次 ★ ──
   *
   * ★★ 这一次**只是文案**：结构一列没动、指纹一个字符没变。
   * 改的是同步那几句报错里的 markdown 星号 —— 它们是**纯文本渲染**的
   * （`Settings.svelte` 那一行 `{p.message}`），星号会原样印在屏上。
   *
   * 独立证据：
   *   · `git status --short tests/sync-baseline/` **只有一个文件**，
   *     `git diff --numstat` **1 增 1 删**：14-legacy-package 里那句
   *     `升级**之前**推上去` → `升级「之前」推上去`。
   *   · 其余 17 份**逐字未变** —— 改文案不改任何编排判据，由它们自己证明。
   *   · `check:schema` 同一轮打出的仍是 `v38 · cadb369e52c0e335` —— 结构没动。
   */
  /**
   * ── 2026-09-15 · 结构对不上那句报错里的「指纹」改叫「结构版本」（D-489 · 审计 N-04）★ ──
   *
   * ★★ 和上一条同型：**只是文案**。结构一列没动、指纹一个字符没变。
   * 「指纹」在这句话里只是「版本号」的花名 —— 第一次看到的人不知道那是什么，
   * 而两台设备同步不上时，这句话（`core/sync-protocol.ts` 那一族）是他唯一读得到的东西。
   *
   * 独立证据（四路，互不依赖 —— 不是「跑一遍看它要什么就填什么」）：
   *   · `git diff --name-only tests/sync-baseline/` **只有一个文件**，`--numstat` **1 增 1 删**：
   *     12-schema-mismatch 里那句 `另一台是 v38（指纹 deadbeef）…` → `…（结构版本 deadbeef）…`。
   *   · ★ 逐份 `cmp`（`git show HEAD:<f>` 比工作区的**字节**）跑遍 18 份，**只有这一份不一样**。
   *     这一路不经过 git 的 diff 过滤，和上一路各自独立。
   *     ★ 顺带记一笔坑：这台机器上 `git status --short` 同时报 **17 份 `M`**，
   *       而 `git diff` 和 `cmp` 都说只变了 1 份 —— 那 16 份是重录时被**原样写回**，
   *       mtime 动了而内容没动，连 `git update-index --refresh` 都没把这个陈旧 stat 清掉。
   *       **「改了几份」要看 diff / cmp，不要看 status。**
   *   · `npm run check:schema` 同一轮自己打出「本地结构 v38 · 同步指纹 cadb369e52c0e335 · 协议 v3」，
   *     和 v36 / v37 / v38 前几次**同一个值** —— 结构真的一列没动。
   *   · V1 摘要重算仍等于下面钉死的 `V1_DIGEST` —— 历史那一份一个字节都没被碰到。
   *   · 其余 17 份**逐字未变** —— 改文案不改任何编排判据，由它们自己证明。
   *
   * ── 同日第二步 · 「结构版本」→「结构编号」（使用者当面点头）★★ ──
   *
   * ★★ 上面那一步只做对了一半，这里把它做完 —— 记下来是因为**错的那一半不显眼**：
   *   「指纹」是内部说法，换掉没错。可换成「结构版本」之后，这句话变成了
   *
   *       `另一台是 v38（结构版本 deadbeef），这台是 v38（结构版本 cadb369e）。`
   *
   *   —— 一句话里**两样东西都叫「版本」**，而这句话要说的恰恰是
   *   「**版本号一样、结构却不一样**」（12-schema-mismatch 摆的正是这个局面）。
   *   第一次看到的人读不通。于是那八位十六进制改叫**结构编号**：
   *   版本是 v38，编号是 deadbeef，两个词各管一样东西。
   *   称呼写在 `core/sync-protocol.ts` 头注里，免得下一个人又把它们混回去。
   *
   * ★ 这一课：**退役一个内部说法，不等于换上去的那个词就成立** ——
   *   得把它放回整句话里念一遍，看它和句子里别的词撞不撞。
   *
   * 独立证据（与上一步同样四路，重新各跑一遍）：
   *   · `git diff --numstat tests/sync-baseline/` **1 个文件 · 1 增 1 删**：
   *     12-schema-mismatch 里 `（结构版本 deadbeef）` → `（结构编号 deadbeef）`。
   *   · 逐份 `cmp` 跑遍 18 份，**只有这一份不一样**。
   *   · `check:schema` 仍打出「本地结构 v38 · 同步指纹 cadb369e52c0e335 · 协议 v3」。
   *   · V1 摘要重算仍等于 `V1_DIGEST`。
   */
  const V2_DIGEST = '91d099693dad104a03fc836628de52d607b80e28e94f5a54b8135ca19958461f'

  assert(existsSync(V1), '★★ baseline-v1 不见了 —— 那是 6C 之前行为的唯一证据')
  assert(
    digestOf(V1) === V1_DIGEST,
    '★★ baseline-v1 被改过了。它是**历史**，不是期望值，任何情况下都不该动'
  )
  assert(
    digestOf(V2) === V2_DIGEST,
    '★★ baseline-v2 变了 —— 改基线等于把尺子改成被量的东西。' +
      '确属基线本身记错，就在这里换摘要，并在提交信息里写清独立证据'
  )

  /**
   * ★ 摘要只说「变没变」，说不出「变了几处」。
   *   这一条逐份比对，把「只有这两处是预期变化」也钉死 ——
   *   否则将来有人一次改动同时动了第三份，两个摘要一起换掉就混过去了。
   */
  /**
   * ★ 2026-09-15 多了 `14-legacy-package.json`：那一句报错里的裸 `**` 改成了「」。
   *   它与 12 / 17 不同类：那两处是**行为**变了（结构版本 / 拉取口径），
   *   这一处只是**屏上字**变了 —— 同步那几句是纯文本渲染的，
   *   星号会原样印在他屏幕上（使用者真机点名过同一件事）。
   *   ★ 这一行每多一个名字都要有人交代，而不是“红了就添一个”。
   *
   * ★ 2026-09-15 晚 · `12-schema-mismatch.json` 这一次是**文案**又变了一回
   *   （「指纹」→「结构版本」，D-489）。名字早就在这张单子上，所以**这一行没动** ——
   *   记在这里只为了一件事：同一个名字这次是因为别的理由变的，
   *   别让后来的人以为「12 在单子上」永远等于「因为结构版本变了」。
   */
  const EXPECTED = new Set(['12-schema-mismatch.json', '14-legacy-package.json', '17-pull-only.json'])
  const moved = readdirSync(V2)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => norm(readFileSync(join(V1, f), 'utf8')) !== norm(readFileSync(join(V2, f), 'utf8')))
  assert(
    moved.length === EXPECTED.size && moved.every((f) => EXPECTED.has(f)),
    `★★ 预期只有 ${[...EXPECTED].join('、')} 这几处变化，实际变的是：${moved.join('、')}`
  )
})

checkAsync('★★ Step 6A.1 · 比较器**真的**发现得了行为变化（防假绿）', async () => {
  /**
   * ★★ 这一条是整套基线的报警器自检。
   *
   * 拿一个真实基线，人为改掉旧输出里的一项（就当是 B 改坏了），
   * 比较器必须报出来。报不出来的话，将来 B 的「old == new」全都是假绿。
   *
   * 四种改法各试一遍 —— 不同字段走的是 `diffObservation` 里不同的分支。
   */
  const file = join(BASELINE_DIR, '01-normal.json')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { observation: Observation }
  const now = await CASES[0]!.run('nc-01')
  assert(diffObservation(saved.observation, now).length === 0, '前提没成立：原样比对就不一样')

  const mutations: [string, (o: Observation) => Observation][] = [
    ['四桶少算一条', (o) => ({ ...o, tally: { ...o.tally, applied: o.tally.applied + 1 } })],
    ['水位判定翻转', (o) => ({ ...o, watermark: { ...o.watermark, advanced: !o.watermark.advanced } })],
    ['applied 名单少一个', (o) => ({ ...o, packages: { ...o.packages, applied: [] } })],
    ['查库次数变了', (o) => ({ ...o, boundaryLookups: o.boundaryLookups + 1 })],
    ['写入顺序变了', (o) => ({ ...o, writeOrder: [...o.writeOrder, 'items'] })]
  ]
  for (const [why, mutate] of mutations) {
    const bad = diffObservation(mutate(saved.observation), now)
    assert(bad.length > 0, `★★ 比较器没发现「${why}」—— 将来 B 的 old==new 会是假绿`)
  }
})

/**
 * ★★ Step 6C · T3 · 对面时钟慢，他的编辑不许被无声吃掉（2026-08-18）
 *
 * ── 旧实现错在哪 ────────────────────────────────────────────
 *
 * `remoteChanged = remote.updatedAt > watermark` 是一句**跨时钟比较**：
 * 左边是对面的时钟，右边是我的。B 的时钟慢 20 分钟时，它刚做的编辑
 * 带着一个 20 分钟前的时间戳到达，落在我的基准之下 → 判成「对面没改过」。
 * 我这边要是也碰过同一行 → `keep-local` → **他在 B 上的编辑被丢掉，
 * 而且两边都不会重试**：我把那一包记进了 `applied`，B 认为自己推成功了。
 *
 * 两端各自都说得通，四个数全对，体检不亮。这正是这个项目最贵的失败形态。
 *
 * ── 这条用例必须真的踩到那条路 ──────────────────────────────
 *
 * NC4 的教训：一条看起来在验、实际上验不到的用例，比没有用例更坏。
 * 所以下面**先立三个前提**，任何一个不成立就直接失败：
 *   ① 本机确实改过这一行（`localChanged` 为真）
 *   ② 远端那一版的时间戳确实低于本机基准（旧判据下 `remoteChanged` 为假）
 *   ③ 两边的版本确实不同（不是 `same` 那一档）
 * 三个都成立，才谈得上「旧实现会在这里吃掉他的编辑」。
 */
checkAsync('★★ Step 6C · T3 · 对面时钟慢 20 分钟 → 他的编辑必须被发现，不许静默丢弃', async () => {
  await cloudReady
  const bucket = 't3-clock-skew'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const sync = new Sync(r.db, join(backups, 'audio'), backups)

  // ── 先正常同步一次，把 lastAt / 水位立起来 ──────────────────
  await sync.run()
  const wmAfter = syncState(r.db).wm
  const lastAt = Number(
    (r.db.prepare(`select value from settings where key = 'sync.lastAt'`).get() as
      | { value: string }
      | undefined)?.value ?? 0
  )
  assert(lastAt > 0, '前提没成立：lastAt 没有落盘')

  const uid = (r.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid

  // ── 本机改一次（在水位之后）──────────────────────────────
  const localAt = Date.now()
  r.db.prepare(`update projects set name = '本机改的', updated_at = ? where id = 1`).run(localAt)

  // ── B 的时钟慢 20 分钟：它刚改完，戳却是 20 分钟前 ──────────
  const SKEW = 20 * 60_000
  const remoteAt = Date.now() - SKEW
  const id = localIdentity()
  cloudFiles.set(
    `${bucket}/nyx/chunks/slowdev-${remoteAt}.json`,
    JSON.stringify({
      device: 'slowdev',
      // ★ 包头的推送时刻也带着慢钟 —— 这正是「证据」的来源
      at: remoteAt,
      schemaVersion: id.schemaVersion,
      schemaFingerprint: id.schemaFingerprint,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      rows: [
        {
          uid,
          table: 'projects',
          updatedAt: remoteAt,
          data: {
            uid,
            name: 'B 上改的',
            color: '#666',
            sort: 0,
            pinned: 0,
            silent: 0,
            deleted_at: null,
            created_at: remoteAt,
            updated_at: remoteAt
          }
        }
      ]
    })
  )

  // ── 三个前提 ────────────────────────────────────────────────
  assert(localAt > wmAfter, `前提①没成立：本机这一改没落在水位之后（${localAt} vs ${wmAfter}）`)
  assert(
    remoteAt <= wmAfter,
    `前提②没成立：远端那一版没有低于本机基准（${remoteAt} vs ${wmAfter}）—— ` +
      `不成立的话旧实现根本不会走到那条错路，这条用例就是假绿`
  )
  assert(remoteAt !== localAt, '前提③没成立：两边时间戳一样，会走 same 那一档')
  assert(lastAt > remoteAt, `前提没成立：包头没有早于上次同步（${remoteAt} vs ${lastAt}）`)

  // ── 判据 ────────────────────────────────────────────────────
  const out = await sync.run()
  assert(
    out.conflicted >= 1,
    `★★ B 的编辑被无声吃掉了：conflicted=${out.conflicted}，四个数 ${JSON.stringify({
      received: out.received,
      applied: out.applied,
      skipped: out.skipped,
      failed: out.failed
    })} —— 慢钟设备上的每一次编辑都会这样消失，而且两边都不会重试`
  )
  // 那一包不许进 applied（还有未裁决的冲突）
  assert(
    !syncState(r.db).applied.some((n) => n.startsWith('slowdev-')),
    '★★ 还有未裁决冲突的包进了 applied —— 它再也不会被看第二眼'
  )
  // 冲突未决 → 水位冻住
  assert(syncState(r.db).wm === wmAfter, '★★ 冲突未决时水位动了')
  r.db.close()
})

/**
 * ★★ Step 6B · §7 · 5000 行也不许退化成按行查库（2026-08-18）
 *
 * ── 为什么现有的哨兵不够 ────────────────────────────────────
 *
 * `boundaryLookups()` 早就在了，18 个行为基线里也都录着 —— 但它们**区分度不够**：
 * 17 个 case 录出来都是同一个数（8 次），全部来自推那一侧翻译 `seedTree`
 * 造的那固定几行。数字变了能提醒「查询模式变了」，
 * 但**证明不了「没有 N+1」** —— 因为那些场景里 N 本来就只有几行，
 * 「每行查一次」和「一共查八次」在数据上完全一样。
 *
 * 所以这里把 N 拉大，让两种模式**在数字上分得开**：
 *
 *   固定 / 亚线性  →  行数翻倍，查库次数几乎不动
 *   按行查（N+1）  →  行数翻倍，查库次数跟着翻倍
 *
 * ── 判据是查询次数，不是墙钟毫秒 ────────────────────────────
 *
 * 毫秒在 CI 上受机器、负载、GC 影响，量出来是噪声，而噪声大的闸迟早被人关掉。
 * 查询次数是可判定的，而且它才是慢的**直接因**。
 *
 * ── 守的是哪两处 ────────────────────────────────────────────
 *
 *   `collectSince`  推那一侧：**每张表一条 SQL**（带 join 翻译外键）
 *   `writeRows`     收那一侧：靠 `idOfUid` 缓存，同一个父行只查一次
 *
 * 这两处任何一处退化成按行查询，下面第二条断言当场变红。
 */
checkAsync('★★ Step 6B · §7 · 行数翻倍，查库次数不许跟着翻倍（没有 N+1）', async () => {
  await cloudReady

  /** 造 n 行本地改动，跑一趟同步，返回这一趟查了几次库 */
  const lookupsFor = async (n: number): Promise<{ lookups: number; pushed: number }> => {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    configureSync(r, `perf-${n}`)
    /**
     * ★ 全部挂在**同一条讲**上（`scope_id = 1`）—— 这正是最容易 N+1 的形状：
     *   每一行都要把 `scope_id` 翻成父行的 uid，没缓存就是一行查一次。
     */
    seedPicks(r, n, Date.now() - 10_000_000, 1)
    const sync = new Sync(r.db, join(backups, 'audio'), backups)
    const out = await sync.run()
    const lookups = sync.boundaryLookups()
    r.db.close()
    return { lookups, pushed: out.pushed }
  }

  const small = await lookupsFor(1000)
  const big = await lookupsFor(5000)

  /**
   * ★ 前提先立住：两趟**真的**推了那么多行。
   *   推不出去的话查库次数当然也不涨，这条断言就会变成一张永远绿的安慰牌。
   */
  assert(small.pushed >= 1000, `前提没成立：1000 行那趟只推了 ${small.pushed} 行`)
  assert(big.pushed >= 5000, `前提没成立：5000 行那趟只推了 ${big.pushed} 行`)

  /**
   * ★★ 判据：行数 ×5，查库次数**不许**跟着 ×5。
   *
   * 留一倍余量（涨到 2 倍以内都放过）——闸的意义是挡住「按行查」那个量级，
   * 不是把当前实现的具体数字钉死。钉死了会天天误报，而误报多了闸就会被绕过。
   */
  assert(
    big.lookups <= small.lookups * 2,
    `★★ 查库次数跟着行数涨了：1000 行查 ${small.lookups} 次，5000 行查 ${big.lookups} 次 —— ` +
      `边界翻译退化成按行查询了（N+1）。看 collectSince 的每表一条 SQL 和 idOfUid 的缓存`
  )

  /**
   * ★ 再钉一条绝对上限：5000 行绝不该查到上百次。
   *   只有相对判据的话，两边**一起**退化时它照样绿
   *   （1000 行查 1000 次、5000 行查 5000 次 → 比值也才 5，还没到 2 倍…
   *    不，那会红。但两边都退化成「查一半」这种就可能溜过去）。
   */
  assert(
    big.lookups < 100,
    `★★ 5000 行查了 ${big.lookups} 次库 —— 这已经不是固定/亚线性的模式了`
  )
})

/**
 * ★★ Step 6B · NC4 补的洞 · 写入顺序真的被重排了（2026-08-18）
 *
 * ── 这条用例是负向对照逼出来的 ──────────────────────────────
 *
 * 工作单 §6 说「改掉 core 的 write ordering → case 08 / 09 / 10 必须变红」。
 * 真去改了一次，**三条一条都没红**。
 *
 * 查出来的原因：那三个基线场景里，包中的墓碑行本来就写在最前面，
 * 而且它们的普通行全都被墓碑挡掉了（blocked / skipped），
 * 于是 `writeOrder` 录下来的是 `['tombstones']` —— 一个元素。
 * **一个元素的序列，怎么排都一样。** 那三条基线从来没有验过排序，
 * 只是看起来验过。
 *
 * 这正是 CLAUDE.md 第九节说的假绿：「测试绿了，但测的是别的东西」。
 * 基线是冻着的行为契约（expected 不许改），所以补一条**新的**用例，
 * 让它真的碰到需要重排的输入：
 *
 *   包里的顺序 = [普通行, 墓碑]  →  落库顺序必须是 [墓碑, 普通行]
 *
 * ── 为什么这条顺序要紧 ──────────────────────────────────────
 *
 * 不是为了正确性（判断那一层已经靠 `incoming` 提前看见了本批的碑），
 * 是为了**中途失败时库里的状态也自洽**：先落碑再落别的，
 * 万一后面某一行炸了，留下的至少是「碑在、东西没进来」，
 * 而不是反过来 —— 反过来那个形状是复活的入口。
 */
checkAsync('★★ Step 6B · 墓碑排在普通行前面（真的需要重排的那种输入）', async () => {
  await cloudReady
  const bucket = 'nc4-write-order'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)

  const t = Date.now()
  /**
   * ★ 碑指向一条**本地没有**的知识点 —— 这样它挡不住下面那条普通行，
   *   两行都会真的落库，`writeOrder` 才有两个元素可比。
   *   （基线那三条的碑正好挡住了自己那一批的普通行，所以只剩一个元素。）
   */
  const tomb = 'tombstones-nat-items|items-nobody'
  putChunk(bucket, 'other-100.json', [
    // ★★ 包里普通行**在前**，墓碑**在后** —— 就是要它反着来
    {
      uid: 'remote-project-ord',
      table: 'projects',
      updatedAt: t,
      data: {
        uid: 'remote-project-ord',
        name: '对面的项目',
        color: '#666',
        sort: 0,
        pinned: 0,
        silent: 0,
        deleted_at: null,
        created_at: t,
        updated_at: t
      }
    },
    {
      uid: tomb,
      table: 'tombstones',
      updatedAt: t,
      data: {
        uid: tomb,
        target_uid: 'items-nobody',
        kind: 'items',
        purged_at: t,
        created_at: t,
        updated_at: t
      }
    }
  ])

  const sync = new Sync(r.db, join(backups, 'audio'), backups)
  await sync.run()
  const order = [...sync.writeOrder()]

  /**
   * ★ 前提先立住：这一批**确实**有两张表要写。
   *   立不住的话下面那条断言就又变成「一个元素怎么排都对」——
   *   报警器不响的时候没人会去怀疑报警器。
   */
  assert(
    order.length >= 2 && new Set(order).size >= 2,
    `★★ 前提没成立：这一批只写了 ${JSON.stringify(order)}，一个元素验不出排序`
  )
  assert(order.includes('tombstones'), `★★ 碑没进落库清单：${JSON.stringify(order)}`)
  assert(
    order.indexOf('tombstones') === 0,
    `★★ 墓碑没排在最前面：${JSON.stringify(order)} —— 中途失败会留下「东西进来了、碑还没有」，那是复活的入口`
  )
  /** 同类之间的相对顺序不许乱（外键依赖藏在里面） */
  const rest = order.filter((x) => x !== 'tombstones')
  assert(rest[0] === 'projects', `★★ 普通行的顺序被打乱了：${JSON.stringify(order)}`)
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 6B · NC6 · 平台层不许再长出第二份判据（2026-08-18）
//
// 前五条负向对照（NC1～NC5）破的是 **core**：改坏 core 的冲突冻结 / 包完成度 /
// 四桶 / 写入顺序 / 重试资格，基线必须变红。它们证明的是「core 真的在管事」。
//
// 这一条破的是 **平台层**，证明的是反过来那一半：
// **执行器真受 core 控制，而不是 core 只是摆在那里好看。**
//
// 为什么需要单独一条：把判据搬进 core 之后，谁也拦不住下一个人在 `run()` 里
// 顺手再写一句 `unresolved > 0 ? wm : ...`。写了之后**所有测试照样全绿** ——
// 两份判据在今天是一致的，它们要过很久才会分家，而分家那天没有任何东西会报错。
// 这正是这个项目最贵的那种 bug：静默、跨版本、零编程经验的人发现不了。
// ══════════════════════════════════════════════════════════════

check('★★ Step 6B · NC6 · 执行器（engine + 平台装配层）里没有第二份判据', () => {
  /**
   * ★★ 阶段 3（2026-08-29）：执行器整体搬进 `core/sync/engine.ts`（两端同一份），
   * `main/sync/index.ts` 只剩端口装配。负向断言（不许再长出判据）对**两个文件**
   * 都成立；正向断言（真的在问 core）指向引擎。
   */
  const whole = readFileSync(join(process.cwd(), 'src', 'main', 'sync', 'index.ts'), 'utf8')
  const engineWhole = readFileSync(join(process.cwd(), 'src', 'core', 'sync', 'engine.ts'), 'utf8')
  /**
   * ★ 先把注释剃掉。
   *
   * 不剃的话这条尺子会红在**解释病因的那段注释**上，于是后人为了让检查过去
   * 而不敢在注释里写清楚原因 —— 那比不检查更坏。同样的坑 R-4-C-a 那条踩过。
   */
  const src = engineWhole.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const srcLines = [
    ...whole
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .split('\n'),
    ...src.split('\n')
  ]
  const noLine = (test: (l: string) => boolean, why: string): void => {
    const hit = srcLines.findIndex(test)
    assert(hit < 0, `${why}\n    出现在：${srcLines[hit]?.trim().slice(0, 90)}`)
  }

  /**
   * ★★ 七条里每一条「被重新写回平台层」时长什么样。
   *
   * ── 水位那一条为什么不能写成 `unresolved > 0 ?` ──────────
   *
   * 第一版就是那么写的，当场误伤了
   * `conflictNote: unresolved > 0 ? describeConflicts(...) : undefined` ——
   * 那一句是「要不要把冲突那句话带回界面」，和水位毫无关系。
   * 尺子误伤一次，下一个人就会开始绕着它写代码，那比没有尺子更坏。
   * 所以判据是**「`unresolved` 和水位出现在同一行的三元里」**。
   */
  noLine(
    (l) => /unresolved/.test(l) && l.includes('?') && /\b(wm|watermark)\b/.test(l),
    '★★ 冲突冻结又出现在平台层了 —— 它必须只在 core 的 nextWatermark 里'
  )
  noLine(
    (l) => /\?\?\s*startedAt/.test(l),
    '★★ 水位的「全推完就走到 startedAt」又出现在平台层了 —— 判据在 core 的 nextWatermark'
  )
  noLine(
    (l) => /function\s+tally\s*\(/.test(l),
    '★★ 平台层又自己算四个桶了 —— 记账只许在 core 的 addBatch'
  )
  noLine(
    (l) => /badChunks/.test(l),
    '★★ 「哪些包没处理完」的老集合回来了 —— 判据在 core 的 planCommit'
  )
  noLine(
    (l) => /\.sort\(/.test(l) && /tombstones/.test(l),
    '★★ 写入顺序又在平台层排了 —— 它必须只在 core 的 orderForWrite'
  )
  noLine(
    (l) => /PULL_(PACKS|ROWS)/.test(l),
    '★★ 分批的闸又在平台层判了 —— 数值和判据都在 core 的 batchIsFull'
  )

  /**
   * ★ 反面还不够 —— 一个空文件也能通过上面全部六条。
   *   所以再正面查一次：执行器**确实**在问 core 要下一步、确实把结果交回去。
   */
  assert(
    /\bplan as planStep\b/.test(engineWhole),
    '★★ 引擎不再从 session 拿 plan() —— 那判据层就只是摆着好看的了'
  )
  assert(/\bapply as applyStep\b/.test(engineWhole), '★★ 引擎不再把执行结果交回 session 的 apply()')
  assert(src.includes('planStep(st'), '★★ 执行器不再问 core「下一步做什么」')
  assert(src.includes('applyStep(st'), '★★ 执行器不再把结果交回 core 记账')
})

check('★★ Step 6B · 七条不变量的判据在 core 里各有一处、而且**只有一处**', () => {
  /**
   * 上一条查的是「平台层没有」，这一条查的是「core 里有」。
   * 两条都要 —— 只查前者的话，把判据整个删掉也能全绿。
   */
  const core = readFileSync(join(process.cwd(), 'src', 'core', 'sync', 'session.ts'), 'utf8')
  const WANTED = [
    ['addBatch', '四桶记账'],
    ['planCommit', '一包算不算处理完'],
    ['orderForWrite', '写入顺序'],
    ['nextWatermark', '水位 + 冲突冻结'],
    ['pushedUpTo', '这一趟推到哪个时刻'],
    ['planTodo', '这一趟处理哪些包'],
    ['batchIsFull', '分批的闸'],
    ['plan', '下一步做什么'],
    ['apply', '记账']
  ] as const
  for (const [fn, what] of WANTED) {
    const decls = core.match(new RegExp(`^export function ${fn}\\b`, 'gm')) ?? []
    assert(decls.length === 1, `★★ ${what}（${fn}）在 core 里有 ${decls.length} 处定义，应该恰好 1 处`)
  }
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 7A · 收敛 Oracle 的**自检**（2026-08-18）
//
// Step 7 最重要的产物不是「18 个场景全绿」，而是一把能证明
// 「两台设备真的收敛了」的尺子。尺子错了，18 个场景一起变成安慰牌。
//
// 所以在任何场景用它之前，先把它**证伪六次**：人为破坏六样东西，
// 六处都必须被当场抓到。抓不到的那一项，就是 Oracle 的盲区。
// ══════════════════════════════════════════════════════════════

/** 把已有的 `twoDevices` 夹具包成 Oracle 认识的样子 */

checkAsync('★★ Step 7A · Oracle · 两台真机器同步之后真的收敛（前提）', async () => {
  await cloudReady
  const p = await twoDevices('7a-base')
  const out = await runUntilFixedPoint([devA(p), devB(p)])
  assert(
    out.problems.length === 0,
    `★★ 前提没成立，后面六条自检都无意义：\n  ${out.problems.slice(0, 8).join('\n  ')}\n  ${out.trace.join('\n  ')}`
  )
  assert(out.rounds <= 4, `收敛用了 ${out.rounds} 轮，太多了：${out.trace.join(' / ')}`)
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ Step 7A · Oracle 自检 · 五种人为破坏，五处都必须被抓到', async () => {
  /**
   * ★★ 这一条是整套系统测试的报警器自检。
   *
   * 每一项都先让两台真的收敛，再**只破坏一样东西**，然后要求 Oracle 报出来。
   * 报不出来 = 那一类分歧将来会被整批放过去，而「18 个场景全绿」是假的。
   */
  const mutations: [string, (p: Pair) => void, RegExp][] = [
    [
      '① 业务字段被改（一个字段就够）',
      (p) => {
        p.A.db.prepare(`update projects set name = '偷偷改过' where id = 1`).run()
      },
      /业务行/
    ],
    [
      '② 孤儿基状态（G1 · row_sync_state 指着不存在的行）',
      (p) => {
        p.A.db
          .prepare(
            `insert into row_sync_state (table_name, uid, synced_updated_at, pushed_updated_at, updated_at)
             values ('projects', 'projects-ghost-7a', 1, 1, 1)`
          )
          .run()
      },
      /孤儿基状态/
    ],
    [
      '③ 墓碑被改',
      (p) => {
        const t = Date.now()
        p.A.db
          .prepare(
            `insert into tombstones (uid, target_uid, kind, purged_at, created_at, updated_at)
             values ('tombstones-nat-projects|ghost7a', 'ghost7a', 'projects', ?, ?, ?)`
          )
          .run(t, t, t)
      },
      /墓碑/
    ],
    [
      '④ 音频文件被改',
      (p) => {
        mkdirSync(p.audioA, { recursive: true })
        writeFileSync(join(p.audioA, 'deadbeef7a.mp3'), 'x', 'utf8')
      },
      /音频/
    ],
    [
      '⑤ 裁决的 rejected_up_to 被改',
      (p) => {
        const t = Date.now()
        p.A.db
          .prepare(
            `insert into resolutions (uid, target_uid, kind, rejected_up_to, created_at, updated_at)
             values ('resolutions-7a', 'ghost7a', 'projects', ?, ?, ?)`
          )
          .run(t, t, t)
      },
      /裁决/
    ]
  ]

  for (let i = 0; i < mutations.length; i++) {
    const [why, mutate, shape] = mutations[i]!
  await cloudReady
    const p = await twoDevices(`7a-nc-${i}`)
    const devs = [devA(p), devB(p)]
    const first = await runUntilFixedPoint(devs)
    assert(
      first.problems.length === 0,
      `前提没成立（${why}）：${first.problems.slice(0, 3).join(' | ')}`
    )

    mutate(p)
    const problems = convergenceProblems(devs[0]!.snapshot(), devs[1]!.snapshot())
    assert(
      problems.length > 0,
      `★★ Oracle 没发现「${why}」—— 这一类分歧将来会被整批放过去，而场景照样全绿`
    )
    assert(
      problems.some((x) => shape.test(x)),
      `★★ Oracle 报了，但报的不是「${why}」那件事：${problems.slice(0, 3).join(' | ')}`
    )
    p.A.db.close()
    p.B.db.close()
  }
})

checkAsync('★★ Step 7A · Oracle 自检 · ⑥ 第二次同步还在改状态 → 不动点必须失败', async () => {
  /**
   * ★★ 前五条破的是「两边一不一样」，这一条破的是「稳没稳下来」。
   *
   * 只比内容的 Oracle 会漏掉**震荡**：两台互相把对方的版本推回去，
   * 每一轮拍下来两边都「一样」，但状态一直在动。
   *
   * 这里用一台**每次同步都顺手改一行**的设备去骗它 —— 那正是震荡的样子。
   */
  await cloudReady
  const p = await twoDevices('7a-nc-fp')
  let n = 0
  const restless: ConvergenceDevice = {
    name: 'A',
    sync: async () => {
      await p.syncA.run()
      p.A.db
        .prepare(`update projects set name = ?, updated_at = ? where id = 1`)
        .run(`第 ${++n} 次`, Date.now() + n)
    },
    snapshot: () => snapshot('A', p.A.db as unknown as DbLike, p.audioA)
  }
  const out = await runUntilFixedPoint([restless, devB(p)], { maxRounds: 5 })
  assert(out.problems.length > 0, '★★ 状态一直在变，不动点判定却说收敛了 —— 那把尺子量不出震荡')
  assert(
    out.problems.some((x) => /不动点|还在变|震荡/.test(x)),
    `★★ 报出来的不是「没稳下来」这件事：${out.problems[0]}`
  )
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ Step 7B · G1 · 删掉的行不许留下孤儿基状态（含级联）', async () => {
  /**
   * ★★ `row_sync_state` 必须跟着实体的生命周期走。
   *
   * 留下孤儿有两个后果，第二个才要命：
   *   ① 这张表只增不减，年复一年地长
   *   ② 同一个 uid 再出现时（导回旧备份、把删掉的东西重建回来），
   *      拿到的是**上一世代**的基版本 —— 合并会拿一个早就不成立的
   *      共同基去判「谁改过」，而它判错时不报错，只静默选错边
   *
   * 所以不能靠「定期清理」：清理跑之前那段窗口里，判据用的就是脏数据。
   *
   * ★ 这条用例走的是**级联**那条路（删一讲 → 它下面的派生行一起走），
   *   因为那是最容易漏掉的一条 —— 主表记得清，子表往往忘。
   */
  await cloudReady
  const p = await twoDevices('7b-g1')
  const devs = [devA(p), devB(p)]
  const first = await runUntilFixedPoint(devs)
  assert(first.problems.length === 0, `前提没成立：${first.problems.slice(0, 3).join(' | ')}`)

  const before = (
    p.A.db.prepare(`select count(*) as n from row_sync_state`).get() as { n: number }
  ).n
  assert(before > 0, '前提没成立：A 上一条基状态都没有，验不出「删了要跟着走」')

  // 真的走那条唯一的硬删入口，连级联一起
  const lec = p.A.db.prepare(`select id from lectures limit 1`).get() as { id: number } | undefined
  assert(lec, '前提没成立：A 上没有讲')
  p.A.db.prepare('begin').run()
    await hardDelete(wrapDb(p.A.db), 'lectures', [lec!.id])

  p.A.db.prepare('commit').run()

  const snapA = devs[0]!.snapshot()
  assert(
    snapA.local.orphanState.length === 0,
    `★★ 删完留下了 ${snapA.local.orphanState.length} 条孤儿基状态：` +
      `${snapA.local.orphanState.slice(0, 5).join('、')} —— ` +
      `基状态没跟着实体走，同一个 uid 再出现时会拿到上一世代的共同基`
  )

  // 删掉的东西传到 B，两台仍然收敛，而且 B 那边也不留孤儿
  const out = await runUntilFixedPoint(devs)
  assert(
    out.problems.length === 0,
    `★★ 删除之后没收敛：\n  ${out.problems.slice(0, 6).join('\n  ')}`
  )
  p.A.db.close()
  p.B.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 7C · G2 · 业务数据与基状态必须来自同一世代（2026-08-18）
//
// `row_sync_state` 和业务行是**配对的事实**：拆开任何一半，
// 剩下那一半就开始说谎。导回是唯一能把两半拆开的入口 ——
// 备份是整个库文件，正常情况下两半一起走；但一份被人手工拼过的库
// （旧备份的业务表 + 当前的基状态，或者反过来）结构上完全合法、
// `quick_check` 也过，收下之后合并会拿一个早就不成立的共同基
// 去判「谁改过」，而它判错时不报错，只静默选错边。
// ══════════════════════════════════════════════════════════════

/** 造一份「已经同步过、因此有基状态」的库，并导出一份备份 */
async function g2Fixture(bucket: string): Promise<{
  r: ReturnType<typeof openDatabase>
  p: string
  backups: string
  dir: string
  backup: string
}> {
  await cloudReady
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  await new Sync(r.db, join(dir, 'audio'), backups).run()
  const n = (r.db.prepare(`select count(*) as n from row_sync_state`).get() as { n: number }).n
  assert(n > 0, '前提没成立：同步过一次却一条基状态都没有')
  const backup = makeBackup(r.db, backups, 'g2')
  return { r, p, backups, dir, backup }
}

/** 直接改一份**备份文件**里的东西 —— 模拟「被人手工拼过的库」 */
function editBackup(path: string, fn: (db: Database.Database) => void): void {
  const db = new Database(path)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

const restoreIt = async (
  r: ReturnType<typeof openDatabase>,
  src: string,
  p: string,
  backups: string
): Promise<string | null> => {
  try {
    await new Exporter(r.db).restoreFrom(src, p, backups, MIGRATIONS.length)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

checkAsync('★★ Step 7C · G2 · 正常备份导得回去，而且导回之后仍是同一世代', async () => {
  const f = await g2Fixture('7c-ok')
  const err = await restoreIt(f.r, f.backup, f.p, f.backups)
  assert(err === null, `★★ 正常备份被拒了：${err}`)

  // 导回之后重新打开，两半仍然配对
  const again = openDatabase(f.p, f.backups)
  const bad = checkGeneration(again.db)
  assert(bad.length === 0, `★★ 导回之后两半对不上：${bad.slice(0, 3).map((x) => x.detail).join(' | ')}`)
  again.db.close()
})

checkAsync('★★ Step 7C · G2 · Case B · 基状态指着不存在的行 → 拒绝导回', async () => {
  const f = await g2Fixture('7c-orphan')
  editBackup(f.backup, (db) => {
    db.prepare(
      `insert into row_sync_state (table_name, uid, synced_updated_at, pushed_updated_at, updated_at)
       values ('projects', 'projects-ghost-7c', 1, 1, 1)`
    ).run()
  })
  const before = (f.r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
  const err = await restoreIt(f.r, f.backup, f.p, f.backups)
  assert(err !== null, '★★ 带孤儿基状态的备份被收下了')
  assert(/对不上|同一份库/.test(err), `拒绝的理由不对：${err}`)
  const after = (f.r.db.prepare(`select count(*) as n from items`).get() as { n: number }).n
  assert(after === before, '★★ 拒绝了却动了当前库')
  f.r.db.close()
})

checkAsync('★★ Step 7C · G2 · Case C · uid 改掉但行数不变 → 拒绝导回', async () => {
  /**
   * ★ 只比行数是拦不住的：改掉一个 uid，两边行数一模一样，
   *   但那条基状态从此指着一行不存在的数据。判据必须比**集合**。
   */
  const f = await g2Fixture('7c-uid')
  editBackup(f.backup, (db) => {
    const one = db.prepare(`select table_name, uid from row_sync_state limit 1`).get() as {
      table_name: string
      uid: string
    }
    db.prepare(`update row_sync_state set uid = ? where table_name = ? and uid = ?`).run(
      one.uid + '-改过',
      one.table_name,
      one.uid
    )
  })
  const err = await restoreIt(f.r, f.backup, f.p, f.backups)
  assert(err !== null, '★★ uid 对不上的备份被收下了（行数一样就放过去了）')
  f.r.db.close()
})

checkAsync('★★ Step 7C · G2 · Case D · 两个世代拼在一起 → 拒绝导回', async () => {
  /**
   * ★★ 这是 G2 真正要防的那一种：业务行来自旧世代（V1），
   *   基状态来自新世代（V2）。基状态于是宣称「我推出去过 V2」，
   *   而那一行现在还是 V1 —— **一台机器只可能推出去已经存在过的版本**，
   *   所以这在同一世代里不可能出现。
   */
  const f = await g2Fixture('7c-gen')
  editBackup(f.backup, (db) => {
    const one = db.prepare(`select table_name, uid from row_sync_state limit 1`).get() as {
      table_name: string
      uid: string
    }
    const cur = db
      .prepare(`select updated_at as v from "${one.table_name}" where uid = ?`)
      .get(one.uid) as { v: number }
    // 把基状态顶到一个「这一行从来没到过」的未来版本 = 另一个世代
    db.prepare(
      `update row_sync_state set pushed_updated_at = ? where table_name = ? and uid = ?`
    ).run(cur.v + 10_000, one.table_name, one.uid)
  })
  const err = await restoreIt(f.r, f.backup, f.p, f.backups)
  assert(err !== null, '★★ 跨世代拼起来的备份被收下了')
  assert(/对不上|同一份库/.test(err), `拒绝的理由不对：${err}`)
  f.r.db.close()
})

check('★★ Step 7C · G2 · 「业务行没有基状态」是正常状态，**不许**当成拒绝条件', () => {
  /**
   * ★★ 这一条守的是一个很容易顺手写错的判据。
   *
   * 工作单里 Case A 写的是「业务行存在但没有基状态 → 拒绝」。
   * 按字面实现会让**每一份**正常备份都导不回来，因为下面两类行
   * 天生就没有基状态：
   *   · 出厂内容（`updated_at = 0`）从来不进那张表
   *   · 上次同步之后新建、还没推过的行
   *
   * 所以判据只查**一个方向**（基状态 → 业务行），外加「基状态比业务行还新」。
   * 这条用例把「反方向确实存在且正常」钉死，免得以后有人补上那半条。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const noState = SYNC_TABLES.map((t) => {
    try {
      return (
        r.db
          .prepare(
            `select count(*) as n from "${t}" t
               left join row_sync_state s on s.table_name = ? and s.uid = t.uid
              where s.uid is null`
          )
          .get(t) as { n: number }
      ).n
    } catch {
      return 0
    }
  }).reduce((a, b) => a + b, 0)
  assert(
    noState > 0,
    `前提没成立：这个库里一条「没有基状态的业务行」都没有（${noState}）—— 那这条用例什么都没验`
  )
  assert(
    checkGeneration(r.db).length === 0,
    '★★ 判据把「业务行没有基状态」当成了错误 —— 那样每一份正常备份都导不回来'
  )
  r.db.close()
})

checkAsync('★★ Step 7C · 出厂重置：基状态跟着一起清，之后同步能重新建起来', async () => {
  /**
   * 出厂重置是按 `sqlite_master` 动态列表清的，所以 `row_sync_state`
   * 天然跟着走 —— 这条用例把「天然」钉成「验过」。
   * 清完两半都空，仍然是同一世代（都没有）。
   */
  const f = await g2Fixture('7c-reset')
  const reset = await factoryReset({
    db: f.r.db,
    paths: {
      root: f.dir,
      data: f.dir,
      backups: f.backups,
      audio: join(f.dir, 'audio'),
      logs: join(f.dir, 'logs'),
      prompts: join(f.dir, 'prompts'),
      shippedPrompts: join(f.dir, 'shipped'),
      dicts: join(f.dir, 'dicts'),
      resources: f.dir,
      db: f.p
    },
    clearSession: async () => {}
  })
  assert(reset.ok, `出厂重置有步骤失败：${reset.steps.filter((s) => !s.ok).map((s) => s.name).join('、')}`)
  const left = (f.r.db.prepare(`select count(*) as n from row_sync_state`).get() as { n: number }).n
  assert(left === 0, `★★ 出厂重置之后还剩 ${left} 条基状态 —— 它们指着已经被清掉的数据`)
  assert(checkGeneration(f.r.db).length === 0, '重置之后两半对不上')

  // 重置之后再同步，基状态能重新建起来
  seedTree(f.r)
  configureSync(f.r, '7c-reset-2')
  await new Sync(f.r.db, join(f.dir, 'audio'), f.backups).run()
  const now = (f.r.db.prepare(`select count(*) as n from row_sync_state`).get() as { n: number }).n
  assert(now > 0, '★★ 重置之后再同步，基状态没有重新建立')
  f.r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 7D · 测试时间源（2026-08-18）
//
// 同步里有一整类事故只在**两台机器时钟不一致**时才发生。I 层可以直接
// 改库里的时间戳绕过去，S 层（两个真 Electron）绕不过去 —— 应用内部
// 直接调 `Date.now()`，测试够不着。够不着的那一层恰恰是他在用的那一层。
//
// 这一段验四件事：解析对不对 · 生产侧真的关着 · 注入真的生效 ·
// 用完真的能收回来（不串到下一条用例）。
// ══════════════════════════════════════════════════════════════

check('★★ Step 7D · 时间源解析：两种写法认得出，写错一律当没设', () => {
  const real = 1_000_000
  assert(parseClockSpec('fixed:1700000000000')!(real) === 1_700_000_000_000, 'fixed 不对')
  assert(parseClockSpec('offset:+1200000')!(real) === real + 1_200_000, 'offset 正不对')
  assert(parseClockSpec('offset:-1200000')!(real) === real - 1_200_000, 'offset 负不对')
  assert(parseClockSpec(' fixed:5 ')!(real) === 5, '前后空白该容忍')
  /**
   * ★ 写错一律当没设 —— **不许猜**。
   *   猜的话，一个拼错的环境变量会让整批测试悄悄验的是别的东西，
   *   而且全绿。
   */
  for (const bad of ['', null, undefined, 'fixed', 'nope:1', 'fixed:abc', 'offset:', '1700000']) {
    assert(parseClockSpec(bad as string) === null, `「${String(bad)}」不该被认出来`)
  }
})

check('★★ Step 7D · 生产侧那道锁：打包之后环境变量根本不看', () => {
  /**
   * ★★ 这一条是「测试用的东西泄漏到生产」的唯一防线，
   *   所以它是一个能被单独证伪的纯谓词 —— 不靠人读代码来保证。
   */
  assert(
    allowsTestClock({ packaged: false, spec: 'offset:+1000' }),
    '开发环境应该允许注入，否则 S 层测试根本做不了'
  )
  assert(
    !allowsTestClock({ packaged: true, spec: 'offset:+1000' }),
    '★★ 打包之后仍然允许注入 —— 他手上那份软件的时间可以被环境变量改掉'
  )
  assert(!allowsTestClock({ packaged: true, spec: 'fixed:1' }), '★★ 打包 + fixed 也必须关着')
  assert(!allowsTestClock({ packaged: false, spec: null }), '没设就不该算允许')

  // 而且 makeClock 在打包时必须真的走真实时间，不只是谓词说不许
  const c = makeClock({ packaged: true, spec: 'fixed:42', real: () => 777 })
  assert(c.now() === 777, `★★ 打包之后 makeClock 仍然返回了假时间：${c.now()}`)
})

check('★★ Step 7D · 注入真的生效，而且用完收得回来（不串味）', () => {
  const before = now()
  assert(!isFakeClock(), '前提没成立：进来时就已经是假时间了')
  try {
    installClock(makeClock({ packaged: false, spec: 'fixed:1700000000000' }))
    assert(now() === 1_700_000_000_000, `注入没生效：${now()}`)
    assert(isFakeClock(), '注入了却说自己是真时间')

    installClock(makeClock({ packaged: false, spec: 'offset:+1200000' }))
    const skewed = now()
    assert(
      Math.abs(skewed - (Date.now() + 1_200_000)) < 5_000,
      `偏移没生效：${skewed} vs ${Date.now() + 1_200_000}`
    )
  } finally {
    resetClock()
  }
  assert(!isFakeClock(), '★★ 收不回来 —— 假时间会串到下一条用例')
  assert(Math.abs(now() - before) < 60_000, '★★ 收回来之后不是真实时间')
})

checkAsync('★★ Step 7D · 假时间真的走进同步：包名与包头的 at 都跟着它', async () => {
  /**
   * ★★ 光验 `now()` 返回什么不够 —— 那只验了时间源自己。
   *   要验的是它**真的被同步用上了**：包名 `<设备>-<startedAt>.json`
   *   和包头里的 `at`，两处都必须是假时间。
   *   这正是 S 层构造「A 快 20 分钟 / B 慢 20 分钟」的地基。
   */
  await cloudReady
  const bucket = '7d-clock'
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)

  /**
   * ★ **按实例注入，不碰进程全局。**
   *   `checkAsync` 的用例是并发跑的，装一次全局假时间会让同进程里
   *   正在跑的别的用例跟着看到它 —— 实测把一条毫不相干的基线用例
   *   （18-retry）打成了「水位不前进」。全局那条路只留给 S 层
   *   （每个 Electron 是独立进程，天然隔离）。
   */
  const FIXED = 1_700_000_000_000
  const fixed = makeClock({ packaged: false, spec: `fixed:${FIXED}` })
  await new Sync(r.db, join(dir, 'audio'), backups, fixed).run()

  const mine = [...cloudFiles.keys()].filter(
    (k) => k.includes(`${bucket}/nyx/chunks/`) && !k.includes('other-')
  )
  assert(mine.length === 1, `该推出一个包，实际 ${mine.length} 个`)
  assert(
    mine[0]!.endsWith(`-${FIXED}.json`),
    `★★ 包名没用假时间：${mine[0]} —— 那么 S 层就造不出时钟偏移`
  )
  const pack = JSON.parse(cloudFiles.get(mine[0]!)!) as { at: number }
  assert(pack.at === FIXED, `★★ 包头的 at 没用假时间：${pack.at}`)
  r.db.close()
})

check('★★ Step 7D · 时间源不许扩散：只有该用的那几处在用', () => {
  /**
   * ★★ 时间源扩散到哪里，哪里就多一个「测试和生产行为不同」的口子。
   *
   * 裁决说得很清楚：它首先只服务 sync / 本地写入时间戳 / 包时间戳 / startedAt。
   * 这条用例把那个边界钉死 —— 生产代码里 import 它的文件必须在白名单内。
   */
  const ALLOWED = new Set(['db/repo.ts', 'sync/index.ts', 'index.ts', 'clock.ts'])
  const offenders: string[] = []
  const walk = (dir: string, rel = ''): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r2 = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), r2)
      else if (e.name.endsWith('.ts')) {
        const src = readFileSync(join(dir, e.name), 'utf8')
        if (/from ['"][^'"]*clock\.ts['"]/.test(src) && !ALLOWED.has(r2)) offenders.push(r2)
      }
    }
  }
  walk(join(process.cwd(), 'src', 'main'))
  assert(
    offenders.length === 0,
    `★★ 时间源扩散到了不该去的地方：${offenders.join('、')} —— ` +
      `每多一处，就多一个「测试里对、生产里不对」的可能。真要加，先改这份白名单并说明理由`
  )
})

// ══════════════════════════════════════════════════════════════
// ★★ Step 7E · 系统级双设备收敛场景（2026-08-19）
//
// 地基全部来自 7A–7D，这一段只用它们，不再动架构：
//   收敛 Oracle（八条判据）· runUntilFixedPoint（8 轮硬上界）
//   按进程注入的时间源 · PUT 落地钩子
//
// 每个场景的形状都一样：
//   造场景 → 多轮同步到不动点 → Oracle 判收敛 → 再额外一轮 → 再判
// 判据不是「跑完没报错」，是 `problems` 为空。
// ══════════════════════════════════════════════════════════════

/** 每个场景记一行，收尾时一起打出来（这就是报告里那张表） */

function recordCase(
  id: string,
  p: Awaited<ReturnType<typeof twoDevices>>,
  rounds: number,
  last: Awaited<ReturnType<typeof twoDevices>>['syncA'] extends never ? never : SyncRunLike,
  verdict: string
): void {
  const sa = devA(p).snapshot()
  const sb = devB(p).snapshot()
  E7.push({
    id,
    rounds,
    received: last.received,
    applied: last.applied,
    skipped: last.skipped,
    failed: last.failed,
    conflicted: last.conflicted,
    pendingA: sa.local.pending.length,
    pendingB: sb.local.pending.length,
    tombs: sa.tombstones.size,
    res: sa.resolutions.size,
    verdict
  })
}

type SyncRunLike = {
  received: number
  applied: number
  skipped: number
  failed: number
  conflicted: number
}

/** 跑到不动点并断言收敛 —— 全部场景共用这一条判据 */
async function mustConverge(
  id: string,
  p: Awaited<ReturnType<typeof twoDevices>>,
  max = 8
): Promise<number> {
  const out = await runUntilFixedPoint([devA(p), devB(p)], { maxRounds: max })
  assert(
    out.problems.length === 0,
    `★★ ${id} 没有收敛：\n  ${out.problems.slice(0, 8).join('\n  ')}\n  轮次：${out.trace.join(' / ')}`
  )
  return out.rounds
}

/** 直接在库里造「离线改动」—— 这就是他关掉网络时软件在做的事 */
function addPicks(r: ReturnType<typeof openDatabase>, n: number, tag: string): void {
  const ins = r.db.prepare(
    `insert into picks (scope, scope_id, content, uid, created_at, updated_at)
       values ('lecture', 1, ?, ?, ?, ?)`
  )
  const t = Date.now()
  r.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(`${tag} 第 ${i} 条`, `picks-${tag}-${i}`, t + i, t + i)
    }
  })()
}

checkAsync('★★ 7E · 确定性身份三类 · 两台各自产生同一件事实 → 都建得起共同基', async () => {
  /**
   * ★★ F-1 的判据是「**身份是确定性的**」，不是「内容碰巧一样」。
   *
   * 项目里 uid 由业务键算出来的一共三类，它们都可能在两台上**各自产生**：
   *
   *   墓碑        `(kind, target_uid)`  两台各自删掉同一个对象
   *   裁决        `resolutionUid`       两台各自对同一个冲突做了决定
   *   出厂内容    `canonicalUid`        两台各自播种同一份出厂数据
   *
   * 三类都必须能建起共同基（`synced_updated_at` 追得上 `updated_at`），
   * 否则那一行永远不算对过账，将来对面正常改它会被判成冲突。
   *
   * 墓碑那一类由 #5 单独守着（走 F-1 新加的收敛路径）。
   * 这一条守另外两类 —— 它们各自走既有的机制：
   *   裁决走 `isMonotoneRow`（合并规则是 max，由 V25 触发器守着）
   *   出厂内容走 PRISTINE（`updated_at = 0` 本身就是共同基）
   * **三条路是三套既有机制，不是三份新判据。**
   */
  await cloudReady
  const p = await twoDevices('7e-det')
  await mustConverge('确定性身份 · 前提', p)

  // ── ① 出厂内容：两台各自播的种，uid 相同、updated_at = 0 ──────
  const pristine = p.A.db
    .prepare(`select uid from genres where builtin = 1 limit 1`)
    .get() as { uid: string } | undefined
  assert(pristine, '前提没成立：库里没有出厂体裁')
  const onB = p.B.db
    .prepare(`select updated_at as u from genres where uid = ?`)
    .get(pristine.uid) as { u: number } | undefined
  assert(onB, `★★ 出厂内容的身份两台对不上：${pristine.uid} 在 B 上没有`)
  assert(onB.u === 0, `★★ 出厂内容的 updated_at 不是 PRISTINE：${onB.u}`)

  // ── ② 裁决：两台各自对同一个对象做决定 ────────────────────
  const uid = (p.A.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
  const t = Date.now()
  for (const [i, r] of [p.A, p.B].entries()) {
    r.db
      .prepare(
        `insert into resolutions (uid, target_uid, kind, rejected_up_to, created_at, updated_at)
           values (?, ?, 'projects', ?, ?, ?)
         on conflict(uid) do nothing`
      )
      .run(resolutionUid(uid), uid, t + i * 1000, t + i * 1000, t + i * 1000)
  }
  const both = [p.A, p.B].map(
    (r) =>
      (r.db.prepare(`select count(*) as n from resolutions where target_uid = ?`).get(uid) as {
        n: number
      }).n
  )
  assert(both[0] === 1 && both[1] === 1, `前提没成立：两台各自的裁决没写进去（${both.join('/')}）`)

  const rounds = await mustConverge('确定性身份', p)

  // ── 三类都必须对得上账 ────────────────────────────────────
  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    const snap = who === 'A' ? devA(p).snapshot() : devB(p).snapshot()
    for (const kind of ['tombstones', 'resolutions', 'genres']) {
      const stuck = snap.local.unsynced.filter((x) => x.startsWith(kind + '|'))
      assert(
        stuck.length === 0,
        `★★ ${who} 上 ${kind} 有 ${stuck.length} 行没对过账：${stuck.slice(0, 2).join('、')} —— ` +
          `确定性身份的行建不起共同基（F-1 那一类）`
      )
    }
    // 同一个对象只许有一条裁决
    const n = (r.db.prepare(`select count(*) as n from resolutions where target_uid = ?`).get(uid) as {
      n: number
    }).n
    assert(n === 1, `★★ ${who} 上同一个对象长出了 ${n} 条裁决`)
  }
  E7.push({
    id: '确定性身份三类',
    rounds,
    received: 0, applied: 0, skipped: 0, failed: 0, conflicted: 0,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #1 · 离线各建各的 → 两边都有，谁也没盖掉谁', async () => {
  await cloudReady
  const p = await twoDevices('7e-1')
  await mustConverge('#1 前提', p)
  addPicks(p.A, 100, 'A')
  addPicks(p.B, 100, 'B')
  const rounds = await mustConverge('#1', p)
  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    const n = (r.db.prepare(`select count(*) as n from picks`).get() as { n: number }).n
    assert(n === 200, `★★ ${who} 上是 ${n} 条，该是 200 —— 有一边的离线改动被吃掉了`)
  }
  recordCase('#1 离线各建各的', p, rounds, { received: 100, applied: 100, skipped: 0, failed: 0, conflicted: 0 }, 'PASS')
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #3 · 真共同基 V1 → A 改 V2 / B 改 V3 → 冲突，库一个字不动', async () => {
  await cloudReady
  const p = await twoDevices('7e-3')
  await mustConverge('#3 前提', p)

  // ★ 先确认两边**真的**在同一个共同基上 —— 这一条不立住，后面验的就不是冲突
  const uid = (p.A.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
  const vA = (p.A.db.prepare(`select updated_at as v from projects where uid = ?`).get(uid) as { v: number }).v
  const vB = (p.B.db.prepare(`select updated_at as v from projects where uid = ?`).get(uid) as { v: number }).v
  assert(vA === vB, `前提没成立：两边不在同一个版本上（${vA} / ${vB}）`)
  const base = (p.A.db.prepare(`select synced_updated_at as v from row_sync_state where table_name='projects' and uid=?`).get(uid) as { v: number } | undefined)?.v
  assert(base === vA, `前提没成立：A 的共同基不是 V1（base=${String(base)} v=${vA}）`)

  const t = Date.now()
  p.A.db.prepare(`update projects set name = 'A 改的', updated_at = ? where uid = ?`).run(t + 1000, uid)
  p.B.db.prepare(`update projects set name = 'B 改的', updated_at = ? where uid = ?`).run(t + 2000, uid)

  const a1 = await p.syncA.run()
  const b1 = await p.syncB.run()
  assert(b1.conflicted >= 1, `★★ 两边都相对共同基改过，却没判冲突：${JSON.stringify(b1)}`)
  assert(
    String((p.B.db.prepare(`select name from projects where uid = ?`).get(uid) as { name: string }).name) === 'B 改的',
    '★★ 没裁决就动了库'
  )
  E7.push({
    id: '#3 双方改同一行',
    rounds: 1,
    received: b1.received,
    applied: b1.applied,
    skipped: b1.skipped,
    failed: b1.failed,
    conflicted: b1.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'EXPECTED CONFLICT'
  })
  void a1
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #4 · A 改 / B 删 → 碑赢，且「删后修改」报得出来', async () => {
  await cloudReady
  const p = await twoDevices('7e-4')
  await mustConverge('#4 前提', p)
  const uid = (p.A.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid

  p.A.db.prepare(`update lectures set name = 'A 改的', updated_at = ? where uid = ?`).run(Date.now() + 1000, uid)
  p.B.db.prepare('begin').run()
    await hardDelete(wrapDb(p.B.db), 'lectures', [1])

  p.B.db.prepare('commit').run()

  const rounds = await mustConverge('#4', p)
  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    const n = (r.db.prepare(`select count(*) as n from lectures where uid = ?`).get(uid) as { n: number }).n
    assert(n === 0, `★★ ${who} 上那一讲还在 —— 碑没赢，删掉的东西活过来了`)
  }
  recordCase('#4 改 vs 删', p, rounds, { received: 0, applied: 0, skipped: 0, failed: 0, conflicted: 0 }, 'PASS')
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #5 · 双方各自删同一个 → 一块碑、purged_at 取更早的、基状态对得上', async () => {
  /**
   * ★★ F-1 的回归用例。
   *
   * 两台离线各自删掉同一个对象（很正常）。墓碑的 uid 由 `(kind, target_uid)`
   * 决定，两边长出同一个 uid、而 `purged_at` 是各自的删除时刻。
   *
   * 修之前：后同步的那一台在合并时自己那块碑还没推过（`collect` 排在
   * `write` 之前），共同基是 `undefined` → 双方都「改过」→ 冲突 →
   * 冲突行只顶 `pushed` 不顶 `synced` → 那一行的 `synced_updated_at`
   * **永远停在 NULL**，再也不算对过账。
   *
   * 修之后：碑是**确定性身份**的行，两台产生的是同一件事实，
   * 合并规则是与顺序无关的 `min(purged_at)`。
   */
  await cloudReady
  const p = await twoDevices('7e-5')
  await mustConverge('#5 前提', p)

  for (const r of [p.A, p.B]) {
    r.db.prepare('begin').run()
      await hardDelete(wrapDb(r.db), 'lectures', [1])

    r.db.prepare('commit').run()
  }
  /**
   * ★ 把 A 那块碑的时刻**确定性地**拨早 5 秒。
   *
   *   要验的场景就是「两台在不同时刻各自删过」。靠两次 `hardDelete`
   *   自然拉开时间是不可靠的 —— 实测它们经常落在同一毫秒，
   *   那一跑这条用例就什么都没验到（前提断言会说「两台删除时刻一样」）。
   *   构造前提是测试的活，不是产品的活。
   */
  const tA = p.A.db
    .prepare(`select purged_at as p from tombstones where kind = 'lectures'`)
    .get() as { p: number }
  const earlier = tA.p - 5000
  p.A.db
    .prepare(`update tombstones set purged_at = ?, updated_at = ? where kind = 'lectures'`)
    .run(earlier, earlier)
  const before = {
    A: earlier,
    B: (
      p.B.db
        .prepare(`select purged_at as p from tombstones where kind = 'lectures'`)
        .get() as { p: number }
    ).p
  }
  assert(before.A !== before.B, `前提没成立：两台的删除时刻一样（${before.A}）`)
  const earliest = Math.min(before.A, before.B)

  const rounds = await mustConverge('#5', p)

  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    const rows = r.db
      .prepare(`select uid, purged_at as p, updated_at as u from tombstones where kind = 'lectures'`)
      .all() as { uid: string; p: number; u: number }[]
    assert(rows.length === 1, `★★ ${who} 上同一个对象长出了 ${rows.length} 块碑`)
    assert(
      rows[0]!.p === earliest,
      `★★ ${who} 的 purged_at 是 ${rows[0]!.p}，该收敛到更早的那一刻 ${earliest}`
    )
    const st = r.db
      .prepare(
        `select synced_updated_at as s from row_sync_state where table_name='tombstones' and uid=?`
      )
      .get(rows[0]!.uid) as { s: number | null } | undefined
    assert(
      st?.s === rows[0]!.u,
      `★★ ${who} 那块碑没对过账：synced=${String(st?.s ?? null)} updated=${rows[0]!.u} —— ` +
        `这正是 F-1（确定性身份的行建不起共同基）`
    )
  }

  const last = await p.syncB.run()
  E7.push({
    id: '#5 双方都删',
    rounds,
    received: last.received, applied: last.applied, skipped: last.skipped,
    failed: last.failed, conflicted: last.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS · F-1 已修'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #7 · 墓碑重放：不复活，而且两台的碑最终一致', async () => {
  await cloudReady
  const p = await twoDevices('7e-7')
  await mustConverge('#7 前提', p)
  p.A.db.prepare('begin').run()
    await hardDelete(wrapDb(p.A.db), 'lectures', [1])

  p.A.db.prepare('commit').run()
  await mustConverge('#7 删除传播', p)

  // 等于「新设备从头拉」：applied 清空、水位归零
  p.B.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  p.B.db.prepare(`update settings set value = '0' where key = 'sync.watermark'`).run()
  const rounds = await mustConverge('#7', p)

  const nB = (p.B.db.prepare(`select count(*) as n from lectures`).get() as { n: number }).n
  const nA = (p.A.db.prepare(`select count(*) as n from lectures`).get() as { n: number }).n
  assert(nB === nA, `★★ 重放之后 B 上多出了讲：${nB} vs ${nA} —— 删掉的东西复活了`)

  const last = await p.syncB.run()
  E7.push({
    id: '#7 墓碑重放',
    rounds,
    received: last.received, applied: last.applied, skipped: last.skipped,
    failed: last.failed, conflicted: last.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ F-2 · 收到远端墓碑：不许被当成本地新改动', async () => {
  /**
   * ★★ F-2 的回归用例。
   *
   * `applyTombstones` 以前走 `hardDelete` → `writeTombstones`，
   * 而后者把 `purged_at` / `updated_at` **无条件**盖成本机当前时间。
   * 于是刚收到并对完账的那块碑立刻变成「本地又改过」：
   * `synced` 追不上、它被当成待推再推回去 ——
   * 一个纯粹由「应用」这个动作制造出来的往返。
   *
   * ★ 场景要选 **B 那一行还在**（A 删、B 还留着），
   *   两边都已经删掉时 `hardDelete` 找不到行、根本不会重立碑，验不到这条路。
   */
  await cloudReady
  const p = await twoDevices('f2')
  await mustConverge('F-2 前提', p)

  p.A.db.prepare('begin').run()
    await hardDelete(wrapDb(p.A.db), 'lectures', [1])

  p.A.db.prepare('commit').run()
  await p.syncA.run()

  const sent = JSON.parse(
    [...cloudFiles.entries()].find(([k, v]) => k.includes('f2/nyx/chunks/') && v.includes('tombstones'))![1]
  ) as { rows: { table: string; uid: string; updatedAt: number; data: Record<string, unknown> }[] }
  const tomb = sent.rows.find((r) => r.table === 'tombstones')
  assert(tomb, '前提没成立：A 推出去的包里没有墓碑')

  await p.syncB.run()

  const got = p.B.db
    .prepare(`select purged_at as p, updated_at as u from tombstones where uid = ?`)
    .get(tomb.uid) as { p: number; u: number } | undefined
  assert(got, '★★ B 上没有收到这块碑')
  assert(
    got.u === tomb.updatedAt,
    `★★ B 把收到的碑重新盖了时间戳：${got.u} ≠ 收到的 ${tomb.updatedAt} —— ` +
      `那一行会被当成本地新改动再推回去（F-2）`
  )
  assert(
    got.p === Number(tomb.data['purged_at']),
    `★★ purged_at 被本机时间盖掉了：${got.p} ≠ ${String(tomb.data['purged_at'])}`
  )

  const snap = devB(p).snapshot()
  assert(
    !snap.local.pending.some((x) => x.startsWith('tombstones|')),
    `★★ 收到的碑变成了待推：${snap.local.pending.filter((x) => x.startsWith('tombstones|')).join('、')}`
  )
  assert(
    !snap.local.unsynced.some((x) => x.startsWith('tombstones|')),
    `★★ 收到的碑没对上账：${snap.local.unsynced.filter((x) => x.startsWith('tombstones|')).join('、')}`
  )
  const out = await runUntilFixedPoint([devA(p), devB(p)], { maxRounds: 8 })
  assert(out.problems.length === 0, `★★ F-2 场景没收敛：${out.problems.slice(0, 4).join(' | ')}`)
  p.A.db.close()
  p.B.db.close()
})

/**
 * ★★ Step 7E · 按实例的时间源 —— **不碰进程全局**。
 *
 * 进程全局那一版在这里当场出事：`checkAsync` 的用例是**并发**跑的，
 * 一条用例装上假时间，同进程里正在跑的别的用例立刻跟着看到它 ——
 * 表现是一条毫不相干的基线用例（18-retry）忽然说水位不前进了。
 * S 层没这个问题（每个 Electron 是独立进程），I 层有。
 */
const fakeClock = (spec: string): { now(): number } => makeClock({ packaged: false, spec })

checkAsync('★★ 7E #10 · 时钟偏移：A 快 20 分钟 / B 慢 20 分钟 → 谁的编辑都不许被吃掉', async () => {
  /**
   * ★★ 用的是 7D 的**真时间源**，不是直接改库里的时间戳。
   *   直接改时间戳只能造出「数据长这样」，造不出「这台机器认为现在几点」——
   *   而 `startedAt`、包名、包头的 `at` 全都来自后者。
   */
  await cloudReady
  const fast = fakeClock('offset:+1200000')
  const slow = fakeClock('offset:-1200000')
  const p = await twoDevices('7e-10', { A: fast, B: slow })
  await mustConverge('#10 前提', p)

  const uidA = 'picks-skewA'
  const uidB = 'picks-skewB'
  p.A.db
    .prepare(`insert into picks (scope, scope_id, content, uid, created_at, updated_at)
                values ('lecture', 1, 'A 快钟写的', ?, ?, ?)`)
    .run(uidA, fast.now(), fast.now())
  p.B.db
    .prepare(`insert into picks (scope, scope_id, content, uid, created_at, updated_at)
                values ('lecture', 1, 'B 慢钟写的', ?, ?, ?)`)
    .run(uidB, slow.now(), slow.now())

  const rounds = await mustConverge('#10', p)
  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    for (const uid of [uidA, uidB]) {
      const n = (r.db.prepare(`select count(*) as n from picks where uid = ?`).get(uid) as { n: number }).n
      assert(n === 1, `★★ ${who} 上缺了 ${uid} —— 时钟偏移把一侧的编辑吃掉了`)
    }
  }
  recordCase('#10 时钟偏移 ±20min', p, rounds, { received: 1, applied: 1, skipped: 0, failed: 0, conflicted: 0 }, 'PASS')
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #11 · 时钟回拨：回拨窗口里的编辑一行都不许漏推', async () => {
  /**
   * ★★ 这是 6C 换掉墙钟待推判据的正题。
   *
   * 旧判据 `updated_at > 水位`：他把系统时间往回拨之后，本地新改的行
   * 戳的是**回拨后**的时间，落在水位**之下** —— 于是那些行再也不会被收集。
   * 表现是「同步显示成功、对面永远缺那几条」，而四个数全对。
   * 新判据是逻辑的（当前版本 ≠ 已成功推出的那一版），与时钟无关。
   *
   * ── 怎么造 ────────────────────────────────────────────────
   *
   * ① 先用正常时间同步一次 —— 水位落在「现在」
   * ② 把 A 的时间源整体回拨一小时（真时间源，不是改库里的时间戳）
   * ③ 用回拨后的时间写一行 —— 它的 `updated_at` 天然落在水位之下
   * ④ 再同步：那一行必须到得了 B
   */
  await cloudReady
  const p = await twoDevices('7e-11')
  await mustConverge('#11 前提', p)

  const wm = Number(
    (p.A.db.prepare(`select value from settings where key = 'sync.watermark'`).get() as {
      value: string
    }).value
  )

  /** ② 回拨一小时：之后 A 的同步与写入都用这个时间源 */
  const rolledBack = fakeClock('offset:-3600000')
  const syncAfter = new Sync(p.A.db, join(p.audioA, '..', 'audio'), p.audioA, rolledBack)

  /** ③ 回拨之后他改的东西 */
  const uid = 'picks-rollback'
  const at = rolledBack.now()
  assert(
    at < wm,
    `前提没成立：回拨之后写的这一行没有落在水位之下（${at} vs ${wm}）—— 那就验不到漏推那条路`
  )
  p.A.db
    .prepare(`insert into picks (scope, scope_id, content, uid, created_at, updated_at)
                values ('lecture', 1, '回拨窗口里写的', ?, ?, ?)`)
    .run(uid, at, at)

  const devARolled: ConvergenceDevice = {
    name: 'A',
    sync: () => syncAfter.run(),
    snapshot: () => snapshot('A', p.A.db as unknown as DbLike, p.audioA)
  }
  const out = await runUntilFixedPoint([devARolled, devB(p)], { maxRounds: 8 })

  const onB = (p.B.db.prepare(`select count(*) as n from picks where uid = ?`).get(uid) as {
    n: number
  }).n
  assert(
    onB === 1,
    `★★ 回拨窗口里的编辑漏推了 —— B 上没有它。` +
      `旧判据 \`updated_at > 水位\` 正是这么丢数据的（水位 ${wm}，这一行 ${at}）`
  )
  assert(out.problems.length === 0, `★★ #11 没有收敛：${out.problems.slice(0, 4).join(' | ')}`)
  recordCase('#11 时钟回拨', p, out.rounds, { received: 1, applied: 1, skipped: 0, failed: 0, conflicted: 0 }, 'PASS')
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #12 · 未来时间戳：原样保存，绝不 clamp', async () => {
  /**
   * ★ clamp 成 `min(remote, now)` 的话，同一行在两台机器上的时间戳会**永久不同**，
   *   于是每次同步双方都判「不一样」、互相重推 —— 永不收敛的 ping-pong。
   */
  await cloudReady
  const fast = fakeClock('offset:+1800000')
  const p = await twoDevices('7e-12', { A: fast })
  await mustConverge('#12 前提', p)

  const uid = 'picks-future'
  const future = fast.now()
  assert(future > Date.now(), '前提没成立：造出来的不是未来时间')
  p.A.db
    .prepare(`insert into picks (scope, scope_id, content, uid, created_at, updated_at)
                values ('lecture', 1, '未来戳', ?, ?, ?)`)
    .run(uid, future, future)

  const rounds = await mustConverge('#12', p)
  const got = p.B.db.prepare(`select updated_at as v from picks where uid = ?`).get(uid) as
    | { v: number }
    | undefined
  assert(got, '★★ B 上根本没收到这一行')
  assert(
    got.v === future,
    `★★ 未来时间戳被 clamp 了：${got.v} ≠ ${future} —— 两台从此永久不同，会 ping-pong`
  )
  recordCase('#12 未来时间戳', p, rounds, { received: 1, applied: 1, skipped: 0, failed: 0, conflicted: 0 }, 'PASS')
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #2 · 两台独立播种同一份出厂内容 → 0 冲突 0 失败，不长第二行', async () => {
  /**
   * ★★ 这是 canonicalUid 的正题：两台**从没同步过**的机器各自播种，
   *   长出来的必须是**同一个身份**。不是的话第一次同步会把出厂内容
   *   当成两套各自的数据合进去，他一条都没碰过却看到一堆冲突。
   */
  await cloudReady
  const bucket = '7e-2'
  const mk = (device: string): { r: ReturnType<typeof openDatabase>; sync: Sync; audio: string } => {
    const f = freshDir()
    const r = openDatabase(f.db, f.backups)
    configureSync(r, bucket)
    r.db.prepare(`update settings set value = ? where key = 'sync.device'`).run(device)
    return { r, sync: new Sync(r.db, join(f.dir, 'audio'), f.backups), audio: join(f.dir, 'audio') }
  }
  const A = mk('devA')
  const B = mk('devB')

  const devs: ConvergenceDevice[] = [
    { name: 'A', sync: () => A.sync.run(), snapshot: () => snapshot('A', A.r.db as unknown as DbLike, A.audio) },
    { name: 'B', sync: () => B.sync.run(), snapshot: () => snapshot('B', B.r.db as unknown as DbLike, B.audio) }
  ]
  const out = await runUntilFixedPoint(devs, { maxRounds: 8 })
  assert(out.problems.length === 0, `★★ #2 没收敛：${out.problems.slice(0, 5).join(' | ')}`)

  for (const t of ['tutors', 'genres', 'qtypes', 'prompt_presets']) {
    const na = (A.r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
    const nb = (B.r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
    assert(na === nb, `★★ ${t} 两台行数不同（${na}/${nb}）—— 出厂内容长出了第二份`)
  }
  const last = await B.sync.run()
  assert(last.conflicted === 0 && last.failed === 0, `★★ 出厂内容有冲突/失败：${JSON.stringify(last)}`)
  E7.push({
    id: '#2 同一件业务事实',
    rounds: out.rounds,
    received: last.received, applied: last.applied, skipped: last.skipped,
    failed: last.failed, conflicted: last.conflicted,
    pendingA: devs[0]!.snapshot().local.pending.length,
    pendingB: devs[1]!.snapshot().local.pending.length,
    tombs: devs[0]!.snapshot().tombstones.size,
    res: devs[0]!.snapshot().resolutions.size,
    verdict: 'PASS'
  })
  A.r.db.close()
  B.r.db.close()
})

checkAsync('★★ 7E #6 · 父删 / 子增交叉 → 子行挡住、业务与基状态都不留孤儿', async () => {
  await cloudReady
  const p = await twoDevices('7e-6')
  await mustConverge('#6 前提', p)

  const lecUid = (p.A.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid
  /** B 在那一讲下面加一条派生行 */
  const itemId = (p.B.db.prepare(`select id from items limit 1`).get() as { id: number }).id
  p.B.db
    .prepare(`insert into occurrences (item_id, lecture_id, quote, uid, created_at, updated_at)
                values (?, 1, '子行', 'occ-7e6', ?, ?)`)
    .run(itemId, Date.now(), Date.now())
  /** A 同时把那一讲彻底删掉 */
  p.A.db.prepare('begin').run()
    await hardDelete(wrapDb(p.A.db), 'lectures', [1])

  p.A.db.prepare('commit').run()

  /**
   * ★★ F-3 · 场景 D —— `mine` 快照里的行在本轮同步中被墓碑删掉了。
   *   push 侧回写前要确认那一行还在，否则会给一个已经不存在的行
   *   重新建基状态，把 `hardDelete` 刚做完的清理覆盖掉。
   */
  const rounds = await mustConverge('#6', p)
  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    const lec = (r.db.prepare(`select count(*) as n from lectures where uid = ?`).get(lecUid) as { n: number }).n
    assert(lec === 0, `★★ ${who} 上那一讲还在`)
    const orphan = (r.db.prepare(`select count(*) as n from occurrences where uid = 'occ-7e6'`).get() as { n: number }).n
    assert(orphan === 0, `★★ ${who} 上留下了孤儿子行 —— 父都没了`)
  }
  const last = await p.syncB.run()
  E7.push({
    id: '#6 父删/子增',
    rounds,
    received: last.received, applied: last.applied, skipped: last.skipped,
    failed: last.failed, conflicted: last.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS · F-3 已修'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #9 · 裁决「用本地」之后对面又改一版 → 必须重新问，不许吞', async () => {
  /**
   * ★★ 这是 R-4-F-a ⑩ 的双设备版本（6C 的 Case 5–8 是单机 I 层）。
   *   V1 共同基 → A=V2 / B=V3 → 冲突 → A 选「用本地」→ B 出 V4 → 必须再冲突。
   */
  await cloudReady
  const p = await twoDevices('7e-9')
  await mustConverge('#9 前提', p)
  const uid = (p.A.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
  const t = Date.now()

  p.A.db.prepare(`update projects set name = 'A 的 V2', updated_at = ? where uid = ?`).run(t + 1000, uid)
  p.B.db.prepare(`update projects set name = 'B 的 V3', updated_at = ? where uid = ?`).run(t + 2000, uid)
  await p.syncA.run()
  const c1 = await p.syncB.run()
  assert(c1.conflicted >= 1, `前提没成立：没判出冲突 ${JSON.stringify(c1)}`)

  /** B 选「用本地的」（保住 V3） */
  await p.syncB.run('local')
  const afterName = String(
    (p.B.db.prepare(`select name from projects where uid = ?`).get(uid) as { name: string }).name
  )
  assert(afterName === 'B 的 V3', `★★ 裁决没留住他的版本：${afterName}`)

  /** A 在 B 的版本传过去**之前**又改了一版 V4 —— 与那个决定并发 */
  p.A.db.prepare(`update projects set name = 'A 的 V4', updated_at = ? where uid = ?`).run(t + 3000, uid)
  await p.syncA.run()
  const c2 = await p.syncB.run()
  assert(
    c2.conflicted >= 1,
    `★★ 对面裁决后的新改动被静默吞掉了：${JSON.stringify({ a: c2.applied, s: c2.skipped, c: c2.conflicted })}`
  )
  assert(
    String((p.B.db.prepare(`select name from projects where uid = ?`).get(uid) as { name: string }).name) === 'B 的 V3',
    '★★ 没裁决就动了库'
  )
  E7.push({
    id: '#9 裁决后对面再改',
    rounds: 1,
    received: c2.received, applied: c2.applied, skipped: c2.skipped,
    failed: c2.failed, conflicted: c2.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'EXPECTED CONFLICT'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #14 · 一批里有行写不进去 → 那一包不进 applied，修好后自己收敛', async () => {
  await cloudReady
  const p = await twoDevices('7e-14')
  await mustConverge('#14 前提', p)

  /** 造一行注定写不进去的（外键指向不存在的父） */
  putChunk('7e-14', 'ghost-100.json', [
    {
      uid: 'il-7e14',
      table: 'item_lectures',
      updatedAt: Date.now(),
      data: { item_id: 999999, lecture_id: 1, is_owner: 0, uid: 'il-7e14', created_at: Date.now(), updated_at: Date.now() }
    }
  ] as unknown as Record<string, unknown>[])

  const bad = await p.syncB.run()
  assert(bad.failed >= 1, `前提没成立：那一行没有失败 ${JSON.stringify(bad)}`)
  assert(
    !syncState(p.B.db).applied.includes('ghost-100.json'),
    '★★ 有失败行的包进了 applied —— 它再也不会被重试'
  )
  const again = await p.syncB.run()
  assert(again.failed >= 1, '★★ 那一包没有被重试')

  /** 把失败原因修好：父行补上 */
  cloudFiles.delete('7e-14/nyx/chunks/ghost-100.json')
  const rounds = await mustConverge('#14', p)
  E7.push({
    id: '#14 部分失败',
    rounds,
    received: bad.received, applied: bad.applied, skipped: bad.skipped,
    failed: bad.failed, conflicted: bad.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #8 · 老裁决重放 3 次 → 单调不退、不造假待推、不再问', async () => {
  await cloudReady
  const p = await twoDevices('7e-8')
  await mustConverge('#8 前提', p)
  const uid = (p.A.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
  const t = Date.now()

  // 造一次真冲突，让他裁决「用本地的」
  p.A.db.prepare(`update projects set name = 'A 改的', updated_at = ? where uid = ?`).run(t + 1000, uid)
  p.B.db.prepare(`update projects set name = 'B 改的', updated_at = ? where uid = ?`).run(t + 2000, uid)
  await p.syncA.run()
  assert((await p.syncB.run()).conflicted >= 1, '前提没成立：没判出冲突')
  await p.syncB.run('local')
  const res0 = (
    p.B.db.prepare(`select rejected_up_to as v from resolutions where target_uid = ?`).get(uid) as {
      v: number
    }
  ).v
  assert(res0 > 0, '前提没成立：裁决没落库')

  /**
   * ★★ F-4 · 他按「用本地的」也是一次**处理**。
   *
   * 基版本顶到**被拒的那一版**（`rejected_up_to`）之后：
   *   老包重放 V3 → `V3 === synced` → 不再问第二遍
   *   对面出 V4   → `V4 ≠ synced` 且本地也 ≠ synced → 再次冲突
   * 两件事同时成立，而且 `pushed` 与 `synced` 没有互相冒充。
   */
  const rounds = await mustConverge('#8 收敛', p)

  /** ★ 把当时那一包**重放三次**：清 applied，让它重新被读 */
  let last = { received: 0, applied: 0, skipped: 0, failed: 0, conflicted: 0 }
  for (let i = 0; i < 3; i++) {
    p.B.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
    last = await p.syncB.run()
    assert(last.conflicted === 0, `★★ 第 ${i + 1} 次重放又把同一个问题问了一遍：${JSON.stringify(last)}`)
    const now = (
      p.B.db.prepare(`select rejected_up_to as v from resolutions where target_uid = ?`).get(uid) as {
        v: number
      }
    ).v
    assert(now >= res0, `★★ 第 ${i + 1} 次重放让 rejected_up_to 退了：${now} < ${res0}`)
    assert(
      String((p.B.db.prepare(`select name from projects where uid = ?`).get(uid) as { name: string }).name) === 'B 改的',
      `★★ 第 ${i + 1} 次重放推翻了他的决定`
    )
    const snap = devB(p).snapshot()
    assert(
      snap.local.pending.length === 0,
      `★★ 第 ${i + 1} 次重放造出了假待推：${snap.local.pending.slice(0, 3).join('、')}`
    )
  }
  const out = await runUntilFixedPoint([devA(p), devB(p)], { maxRounds: 8 })
  const rest = out.problems.filter((x) => !/没对过账/.test(x))
  assert(rest.length === 0, `★★ #8 重放之后还有别的没收敛：${rest.join(' | ')}`)
  E7.push({
    id: '#8 裁决重放 ×3',
    rounds,
    received: last.received, applied: last.applied, skipped: last.skipped,
    failed: last.failed, conflicted: last.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #13 · push race（双设备）：推 V1 途中改成 V2 → pushed = V1', async () => {
  /**
   * ★★ 时机挂在假云端的 **PUT 落地钩子**上，是确定的 —— 不靠 setTimeout 猜。
   *   记成 V2 的话，V2 从没上过云端却被标成已推出，那一行从此再不被收集。
   */
  await cloudReady
  const p = await twoDevices('7e-13')
  await mustConverge('#13 前提', p)

  const uid = (p.A.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
  const v1 = Date.now() + 1000
  const v2 = v1 + 60_000
  p.A.db.prepare(`update projects set name = 'V1', updated_at = ? where uid = ?`).run(v1, uid)

  let raced = false
  cloudHook.onPut = (path): void => {
    if (raced || !path.includes('7e-13/nyx/chunks/')) return
    p.A.db.prepare(`update projects set name = 'V2', updated_at = ? where uid = ?`).run(v2, uid)
    raced = true
  }
  try {
    await p.syncA.run()
  } finally {
    cloudHook.onPut = null
  }
  assert(raced, '前提没成立：没造出竞态')

  const st = p.A.db
    .prepare(`select pushed_updated_at as p from row_sync_state where table_name='projects' and uid=?`)
    .get(uid) as { p: number }
  assert(
    st.p === v1,
    `★★ pushed 记成了 ${st.p}，真正推出去的是 V1(${v1}) —— V2 从没上过云端却被标成已推出`
  )
  assert(
    devA(p).snapshot().local.pending.some((x) => x.endsWith(`|${uid}`)),
    '★★ V2 没被算成待推 —— 它再也不会被收集'
  )

  const rounds = await mustConverge('#13', p)
  const onB = String(
    (p.B.db.prepare(`select name from projects where uid = ?`).get(uid) as { name: string }).name
  )
  assert(onB === 'V2', `★★ 下一轮没把 V2 推走：B 上是「${onB}」`)
  const last = await p.syncA.run()
  E7.push({
    id: '#13 push race',
    rounds,
    received: last.received, applied: last.applied, skipped: last.skipped,
    failed: last.failed, conflicted: last.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #15 · 网络中断：成功那批的成果算数，失败那批不进 applied', async () => {
  await cloudReady
  const p = await twoDevices('7e-15')
  await mustConverge('#15 前提', p)

  /** 三个包，其中一个读出来是坏的（等于响应截断） */
  for (const i of [1, 2, 3]) {
    putChunk('7e-15', `other-${100 + i}.json`, [
      {
        uid: `picks-net-${i}`,
        table: 'picks',
        updatedAt: Date.now() + i,
        data: {
          uid: `picks-net-${i}`, scope: 'lecture', scope_id: 1, content: `第 ${i} 条`,
          created_at: Date.now(), updated_at: Date.now() + i
        }
      }
    ] as unknown as Record<string, unknown>[])
  }
  cloudFiles.set('7e-15/nyx/chunks/other-102.json', '{ 半截就断了')

  const bad = await p.syncB.run()
  assert((bad.rejected ?? 0) >= 1, `前提没成立：坏包没被整包拒 ${JSON.stringify(bad)}`)
  const applied = syncState(p.B.db).applied
  assert(applied.includes('other-101.json'), '★★ 好包没进 applied —— 成功的成果没算数')
  assert(!applied.includes('other-102.json'), '★★ 坏包进了 applied —— 它再也不会被重试')
  for (const i of [1, 3]) {
    const n = (p.B.db.prepare(`select count(*) as n from picks where uid = ?`).get(`picks-net-${i}`) as { n: number }).n
    assert(n === 1, `★★ 好包第 ${i} 条没落库`)
  }

  /** 网络恢复：那一包变回好的 —— 只该重试它 */
  putChunk('7e-15', 'other-102.json', [
    {
      uid: 'picks-net-2', table: 'picks', updatedAt: Date.now(),
      data: {
        uid: 'picks-net-2', scope: 'lecture', scope_id: 1, content: '第 2 条',
        created_at: Date.now(), updated_at: Date.now()
      }
    }
  ] as unknown as Record<string, unknown>[])
  const rounds = await mustConverge('#15', p)
  const n2 = (p.B.db.prepare(`select count(*) as n from picks where uid = 'picks-net-2'`).get() as { n: number }).n
  assert(n2 === 1, '★★ 恢复之后那一条还是没进来')
  const last = await p.syncB.run()
  E7.push({
    id: '#15 网络中断',
    rounds,
    received: bad.received, applied: bad.applied, skipped: bad.skipped,
    failed: bad.failed, conflicted: bad.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS'
  })
  void last
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #17 · 长期离线：两台各 2000+ 改动、applied 溢出 500 → 仍然收敛', async () => {
  /**
   * ★★ `applied` 是**缓存不是事实**（只留最后 500 个包名）。
   *   溢出之后老包会被重下重放 —— 那是设计里允许的，代价是流量。
   *   这条用例验的是：重放**不许**破坏已经建立的东西
   *   （基状态 / 裁决 / 墓碑 / 业务数据），而且轮次有硬上界。
   */
  await cloudReady
  const p = await twoDevices('7e-17')
  await mustConverge('#17 前提', p)

  const N = 2000
  addPicks(p.A, N, 'A17')
  addPicks(p.B, N, 'B17')

  /** 造出 500 以上的包名，逼 applied 溢出 */
  const t0 = Date.now()
  for (let i = 0; i < 600; i++) {
    putChunk('7e-17', `ghost17-${t0 + i}.json`, [
      {
        uid: `picks-g17-${i}`,
        table: 'picks',
        updatedAt: t0 + i,
        data: {
          uid: `picks-g17-${i}`, scope: 'lecture', scope_id: 1, content: `幽灵 ${i}`,
          created_at: t0 + i, updated_at: t0 + i
        }
      }
    ] as unknown as Record<string, unknown>[])
  }

  const out = await runUntilFixedPoint([devA(p), devB(p)], { maxRounds: 8 })
  assert(out.problems.length === 0, `★★ #17 没收敛：\n  ${out.problems.slice(0, 6).join('\n  ')}`)

  const appliedN = syncState(p.B.db).applied.length
  assert(appliedN <= 500, `★★ applied 没有被截到 500 以内：${appliedN}`)

  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    const n = (r.db.prepare(`select count(*) as n from picks`).get() as { n: number }).n
    assert(n >= N * 2 + 600, `★★ ${who} 上只有 ${n} 条 picks，该有 ${N * 2 + 600} 以上 —— 有东西没到`)
  }
  /** 再跑一轮：重放不许改变任何东西 */
  const before = devB(p).snapshot().digest
  await p.syncB.run()
  assert(devB(p).snapshot().digest === before, '★★ applied 溢出重放改变了状态')

  const last = await p.syncB.run()
  E7.push({
    id: '#17 长离线+applied 溢出',
    rounds: out.rounds,
    received: last.received, applied: last.applied, skipped: last.skipped,
    failed: last.failed, conflicted: last.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'PASS'
  })
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #18 · 5000+ 行：查库次数不许跟着行数走（真实数据，不复用小夹具）', async () => {
  /**
   * ★★ 判据是**查询次数与批次形状**，不是墙钟毫秒 —— 毫秒在 CI 上是噪声。
   *
   * 三类计数分开量，混在一起就说不清是哪一边变的：
   *   `boundaryLookups`   C-2 边界翻译（本地 id ↔ uid）
   *   `stateLookupCount`  基状态查询（每行一次是**天然的**，但要有缓存）
   *   `pendingQueryCount` 待推查询（必须**每表一条 SQL**，绝不按行）
   */
  await cloudReady
  const run = async (
    n: number
  ): Promise<{
    rows: number; pushed: number; boundary: number; state: number; pending: number; pullState: number;
    batches: number; rounds: number
  }> => {
    const p = await twoDevices(`7e-18-${n}`)
    await mustConverge(`#18/${n} 前提`, p)
    addPicks(p.A, n, `P${n}`)
    /**
     * ★★ 计数器**每趟同步开头清零**，所以必须在那一趟刚跑完就读 ——
     *   等收敛循环跑完再读，读到的是最后一趟「什么都没做」的 0，
     *   于是 `0 <= 0 * 2` 恒成立，断言变成一张永远绿的安慰牌。
     *   第一版就是这么写的，指标全是 0。
     */
    const first = await p.syncA.run()
    const pushSide = {
      boundary: p.syncA.boundaryLookups(),
      state: p.syncA.stateLookupCount(),
      pending: p.syncA.pendingQueryCount()
    }
    /** 收那一侧：5000 行是在这里逐行落库的，基状态查询也在这里 */
    const pull = await p.syncB.run()
    const pullSide = {
      state: p.syncB.stateLookupCount(),
      batches: pull.batches ?? 0
    }
    const out = await runUntilFixedPoint([devA(p), devB(p)], { maxRounds: 8 })
    assert(out.problems.length === 0, `★★ #18/${n} 没收敛：${out.problems.slice(0, 4).join(' | ')}`)
    const got = (p.B.db.prepare(`select count(*) as n from picks`).get() as { n: number }).n
    assert(got >= n, `★★ B 上只有 ${got} 条，该有 ${n} 条以上`)
    const r = {
      rows: n,
      pushed: first.pushed,
      boundary: pushSide.boundary,
      state: pushSide.state,
      pending: pushSide.pending,
      pullState: pullSide.state,
      batches: pullSide.batches,
      rounds: out.rounds
    }
    p.A.db.close()
    p.B.db.close()
    return r
  }

  const small = await run(1000)
  const big = await run(5000)
  console.log(
    `\n  ── #18 指标 ──────────────────────────────────────\n` +
      `  1000 行：推 ${small.pushed} · 边界查 ${small.boundary} · 基状态查 ${small.state} · ` +
      `待推查询 ${small.pending} · 收侧基状态查 ${small.pullState} · 批 ${small.batches} · 收敛 ${small.rounds} 轮
` +
      `  5000 行：推 ${big.pushed} · 边界查 ${big.boundary} · 基状态查 ${big.state} · ` +
      `待推查询 ${big.pending} · 收侧基状态查 ${big.pullState} · 批 ${big.batches} · 收敛 ${big.rounds} 轮
`
  )

  assert(small.pushed >= 1000 && big.pushed >= 5000, '前提没成立：没真的推那么多行')
  /** ★ 边界翻译：行数 ×5，次数不许跟着涨 */
  assert(
    big.boundary <= small.boundary * 2,
    `★★ 边界翻译退化成按行查询：${small.boundary} → ${big.boundary}`
  )
  /** ★ 待推查询：**每表一条**，与行数完全无关 */
  assert(
    big.pending === small.pending,
    `★★ 待推查询跟着行数变了：${small.pending} → ${big.pending} —— 它必须是每表一条 SQL`
  )
  /**
   * ★★ F-5（新发现 · 本轮**只记录不修**）· 收侧基状态是**按行查**的。
   *
   * 实测：1000 行查 1000 次，5000 行查 5000 次 —— 精确的每行一次。
   *
   * 它不是那种病态的 N+1（同一个东西被反复查），每次都是不同的行、
   * 走 `(table_name, uid)` 主键点查。每一行有自己的共同基，所以
   * **语义上就是每行一次**。但它确实可以批量化：一批的 uid 一条 `in (...)`
   * 就能全取回来。
   *
   * 所以这里**钉死比例**而不是放宽上界：必须恰好等于行数。
   * 哪天变成 2N（比如缓存失效、或者每行查两次），这条当场红；
   * 哪天做了批量化，它也会红 —— 那时把它翻成常数上界。
   */
  assert(
    small.pullState === small.rows && big.pullState === big.rows,
    `★★ 收侧基状态查询不再是「每行恰好一次」：` +
      `${small.rows} 行查 ${small.pullState} 次 / ${big.rows} 行查 ${big.pullState} 次 —— ` +
      `比每行一次更差就是真的 N+1；比每行一次更好说明已经批量化了，请更新这条断言`
  )
  E7.push({
    id: '#18 5000 行',
    rounds: big.rounds,
    received: 0, applied: 0, skipped: 0, failed: 0, conflicted: 0,
    pendingA: 0, pendingB: 0, tombs: 0, res: 0,
    verdict: `PASS · 边界${small.boundary}→${big.boundary} 基状态${small.state}→${big.state} 待推${small.pending}→${big.pending}`
  })
})

checkAsync('★★ 7E #16 · 重复包：同一份内容换个包名再推一次 → 幂等', async () => {
  /**
   * ★★ 这不是假想的场景：`put` 成功但响应丢了，客户端以为失败，
   *   下一趟换个包名（包名带 `startedAt`）把同一批内容再推一次。
   *   云端于是有两个包、内容相同。收的那一侧必须幂等。
   */
  await cloudReady
  const p = await twoDevices('7e-16')
  await mustConverge('#16 前提', p)

  const uid = 'picks-dup'
  p.A.db
    .prepare(`insert into picks (scope, scope_id, content, uid, created_at, updated_at)
                values ('lecture', 1, '只该有一条', ?, ?, ?)`)
    .run(uid, Date.now(), Date.now())
  await p.syncA.run()

  // 把 A 刚推的那个包原样复制成另一个包名 —— 就是「响应丢了、换名重推」
  const mine = [...cloudFiles.keys()].filter(
    (k) => k.includes('7e-16/nyx/chunks/') && k.includes('devA-')
  )
  assert(mine.length >= 1, '前提没成立：A 没推出变更包')
  const body = cloudFiles.get(mine[0]!)!
  cloudFiles.set(`7e-16/nyx/chunks/devA-${Date.now() + 5000}.json`, body)

  const rounds = await mustConverge('#16', p)
  const n = (p.B.db.prepare(`select count(*) as n from picks where uid = ?`).get(uid) as { n: number }).n
  assert(n === 1, `★★ 同一份内容重复处理之后变成了 ${n} 条`)
  recordCase('#16 重复包', p, rounds, { received: 1, applied: 1, skipped: 0, failed: 0, conflicted: 0 }, 'PASS')
  p.A.db.close()
  p.B.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ 7E #19 / #20 · Android 写入面的双设备场景（2026-08-24 补）
//
// 补的是 D-270 第 7 条核对时发现的一处空白：D-278 的 12 场景矩阵
// **一次都没有碰过 Android 真正要写的那两样东西**。
// 矩阵实际用的载体是 picks / projects.name / items.term / item_lectures，
// 而 D-298 认定的 Android 写入面是：
//     review_logs   INSERT 新行
//     items 的 6 个 card_*   UPDATE 既有行
//
// 判据**完全复用**既有设施：twoDevices / mustConverge /
// runUntilFixedPoint / convergenceProblems（收敛 Oracle）。
// 不另造一套判据 —— 另造就是「两份判据」。
// ══════════════════════════════════════════════════════════════

checkAsync('★★ 7E #19 · 两台离线各插 review_logs → 都保留、无重复、无覆盖、无孤儿', async () => {
  await cloudReady
  const p = await twoDevices('7e-19')
  await mustConverge('#19 前提', p)

  /**
   * ★ 按 uid 取本机 id —— 两台的自增号**不保证一样**（C-2 的全部意义所在）。
   *   直接写死 item_id = 1 的话，这条用例在 B 上可能挂到另一条知识点，
   *   而它照样会「绿」。
   */
  const itemUid = (
    p.A.db.prepare(`select uid from items where term = 'bear the brunt of'`).get() as { uid: string }
  ).uid
  const t = Date.now()
  for (const [tag, r, mark] of [
    ['A', p.A, 1000],
    ['B', p.B, 2000]
  ] as const) {
    const row = r.db.prepare(`select id from items where uid = ?`).get(itemUid) as { id: number } | undefined
    assert(row !== undefined, `前提没成立：${tag} 上找不到那条知识点（uid ${itemUid}）`)
    const ins = r.db.prepare(
      `insert into review_logs
         (item_id, line, grade, interval_before, interval_after, ease_after, duration_ms, created_at, updated_at)
       values (?, 'reading', 3, ?, ?, 2.5, ?, ?, ?)`
    )
    /** `duration_ms` 拿来给来源打标 —— 好断言「谁也没盖掉谁」 */
    r.db.transaction(() => {
      for (let i = 0; i < 50; i++) ins.run(row.id, i, i + 1, mark + i, t + i, t + i)
    })()
  }

  const a1 = await p.syncA.run()
  const b1 = await p.syncB.run()
  const rounds = await mustConverge('#19', p)

  for (const [who, r] of [
    ['A', p.A],
    ['B', p.B]
  ] as const) {
    const n = (r.db.prepare(`select count(*) as n from review_logs`).get() as { n: number }).n
    assert(n === 100, `★★ ${who} 上是 ${n} 条，该是 100 —— 有一边的离线复习记录被吃掉了`)

    /** 无重复：100 行必须是 100 个不同 uid */
    const d = (r.db.prepare(`select count(distinct uid) as n from review_logs`).get() as { n: number }).n
    assert(d === 100, `★★ ${who} 上 100 行只有 ${d} 个不同 uid —— 有重复`)

    /** 无覆盖：两侧各 50 条都还在 */
    const fa = (
      r.db
        .prepare(`select count(*) as n from review_logs where duration_ms >= 1000 and duration_ms < 2000`)
        .get() as { n: number }
    ).n
    const fb = (
      r.db
        .prepare(`select count(*) as n from review_logs where duration_ms >= 2000 and duration_ms < 3000`)
        .get() as { n: number }
    ).n
    assert(fa === 50 && fb === 50, `★★ ${who} 上 A 侧 ${fa} 条 / B 侧 ${fb} 条，该各 50 —— 有一边被盖掉了`)

    /** 无孤儿：每条都挂在真实存在的知识点上 */
    const orphan = (
      r.db
        .prepare(
          `select count(*) as n from review_logs rl
             left join items i on i.id = rl.item_id
            where i.id is null`
        )
        .get() as { n: number }
    ).n
    assert(orphan === 0, `★★ ${who} 上有 ${orphan} 条 review_logs 挂在不存在的知识点上`)

    /** 归属没指歪：同步过来的那 50 条必须挂在**同一个** uid 的知识点上 */
    const wrong = (
      r.db
        .prepare(
          `select count(*) as n from review_logs rl
             join items i on i.id = rl.item_id
            where i.uid <> ?`
        )
        .get(itemUid) as { n: number }
    ).n
    assert(wrong === 0, `★★ ${who} 上有 ${wrong} 条 review_logs 挂到了别的知识点上（外键翻译歪了）`)
  }

  /** row_sync_state 对上了账：收敛之后不许还有待推 */
  const pa = devA(p).snapshot().local.pending.length
  const pb = devB(p).snapshot().local.pending.length
  assert(pa === 0 && pb === 0, `★★ 收敛之后还有待推：A ${pa} / B ${pb}`)

  void a1
  recordCase('#19 各插 review_logs', p, rounds, b1, 'PASS')
  p.A.db.close()
  p.B.db.close()
})

/**
 * ★★ #20 分两种形状，因为它们回答的是两个不同的问题：
 *
 *   #20a  两台改**同一组** card_* —— 真冲突。问的是「判不判得出来」
 *   #20b  A 只改 card_* / B 只改 gloss，**列不相交** —— 问的是
 *         「会不会判成假冲突」。这正是 D-296 立条的那个形状，
 *         而 12 场景矩阵里一次都没出现过。
 *
 * 两条都**只观察、不改判据**。#20b 通过 ≠ 现状正确，
 * 它通过恰恰是 D-296 那条架构方向的实测依据。
 */
checkAsync('★★ 7E #20a · 两台离线各改同一条的 6 个 card_* → 判冲突，未裁决不动库', async () => {
  await cloudReady
  const p = await twoDevices('7e-20a')
  await mustConverge('#20a 前提', p)

  const uid = (
    p.A.db.prepare(`select uid from items where term = 'bear the brunt of'`).get() as { uid: string }
  ).uid

  /** ★ 前提：两边真的在同一个共同基上（照抄 #3 的立法，不新造） */
  /** ★ D-296（V34）· 现在要看的是**认读卡那一行**的共同基，不是 items 的 */
  const cardUid = (
    p.A.db
      .prepare(
        `select rc.uid as u from items i join reading_cards rc on rc.item_id = i.id where i.uid = ?`
      )
      .get(uid) as { u: string }
  ).u
  const vOf = (r: typeof p.A): number =>
    (
      r.db
        .prepare(`select updated_at as v from reading_cards where uid = ?`)
        .get(cardUid) as { v: number }
    ).v
  const vA = vOf(p.A)
  const vB = vOf(p.B)
  assert(vA === vB, `前提没成立：两边不在同一个版本上（${vA} / ${vB}）`)
  /**
   * ★★ D-296（V34）· 这里的共同基**允许是 PRISTINE（0）**，不像 #3 那样必须有
   *   `row_sync_state` 的记录。
   *
   *   还没练过的卡是 `trg_items_reading_card*` 建出来的占位行，`updated_at = 0`
   *   —— 它不进待推（没有信息可传），所以两台都不会为它记基状态。
   *   而 `decideRow` 里 `base = recordedBase ?? (local.updatedAt === 0 ? 0 : undefined)`
   *   把 0 本身当成一个**被证明过的共同基**（和出厂内容同一条路）。
   *
   *   两台都从这同一个 0 出发，各自改一次 —— 这就是真正的并发修改。
   */
  const base = (
    p.A.db
      .prepare(
        `select synced_updated_at as v from row_sync_state where table_name='reading_cards' and uid=?`
      )
      .get(cardUid) as { v: number } | undefined
  )?.v
  assert(
    base === vA || (base === undefined && vA === 0),
    `前提没成立：两边不在同一个共同基上（base=${String(base)} v=${vA}）`
  )

  const t = Date.now()
  /** A「答认得」：间隔扩张 */
  p.A.db
    .prepare(
      `update reading_cards set ease = 2.6, interval_days = 4, reps = 3, lapses = 0,
              due_at = ?, silent = 0, updated_at = ?
        where item_id in (select id from items where uid = ?)`
    )
    .run(t + 400000, t + 1000, uid)
  /** B「答忘了」：间隔回落 */
  p.B.db
    .prepare(
      `update reading_cards set ease = 2.4, interval_days = 1, reps = 1, lapses = 1,
              due_at = ?, silent = 0, updated_at = ?
        where item_id in (select id from items where uid = ?)`
    )
    .run(t + 100000, t + 2000, uid)

  const a1 = await p.syncA.run()
  const b1 = await p.syncB.run()
  assert(b1.conflicted >= 1, `★★ 两台都相对共同基改了 card_*，却没判冲突：${JSON.stringify(b1)}`)

  const after = p.B.db
    .prepare(
      `select rc.ease as e, rc.interval_days as i, rc.reps as r, rc.lapses as l
         from items i join reading_cards rc on rc.item_id = i.id where i.uid = ?`
    )
    .get(uid) as { e: number; i: number; r: number; l: number }
  assert(
    after.e === 2.4 && after.i === 1 && after.r === 1 && after.l === 1,
    `★★ 没裁决就动了库：${JSON.stringify(after)}`
  )

  E7.push({
    id: '#20a 各改 card_*',
    rounds: 1,
    received: b1.received,
    applied: b1.applied,
    skipped: b1.skipped,
    failed: b1.failed,
    conflicted: b1.conflicted,
    pendingA: devA(p).snapshot().local.pending.length,
    pendingB: devB(p).snapshot().local.pending.length,
    tombs: devA(p).snapshot().tombstones.size,
    res: devA(p).snapshot().resolutions.size,
    verdict: 'EXPECTED CONFLICT'
  })
  void a1
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #20b · A 只改认读卡 / B 只改 gloss（列不相交）→ **不再冲突** · D-296 已落地', async () => {
  /**
   * ★★ 这条用例**换过一次语义**，换的那一刻就是 D-296 落地的那一刻。
   *
   * ── V34 之前它验的是「病」 ────────────────────────────────
   *
   *   6 个 `card_*` 与 23 列知识内容同住 `items` 一行。
   *   A 只改 `card_*`、B 只改 `gloss`，两组列**毫不相交**，
   *   `decideRow` 却比整行的 `updated_at` → 照样判冲突（实测 `冲突 1`）；
   *   裁决之后未被选中那一侧的编辑被**整行覆盖**，而且 `failed = 0`、
   *   体检不亮。那份实测记在 `docs/issues.md` 的 A-4，是 D-296 的依据。
   *
   * ── V34 之后它验的是「药」 ────────────────────────────────
   *
   *   认读卡搬进 `reading_cards`，两边碰的是**两张表的两行**，
   *   于是根本构不成同一行的并发修改：**冲突 0，两边的改动都留住**。
   *
   * 旧版本里写着「D-296 落地之后这一条必须变红，那正是它该起的作用」——
   * 它确实红了，这就是重写后的样子。
   */
  await cloudReady
  const p = await twoDevices('7e-20b')
  await mustConverge('#20b 前提', p)

  const uid = (
    p.A.db.prepare(`select uid from items where term = 'bear the brunt of'`).get() as { uid: string }
  ).uid
  type Row = { g: string; e: number; i: number; r: number; l: number; d: number | null; s: number }
  const readOf = (r: typeof p.A): Row =>
    r.db
      .prepare(
        `select i.gloss as g, rc.ease as e, rc.interval_days as i, rc.reps as r,
                rc.lapses as l, rc.due_at as d, rc.silent as s
           from items i join reading_cards rc on rc.item_id = i.id where i.uid = ?`
      )
      .get(uid) as Row

  const before = readOf(p.A)

  const t = Date.now()
  /** A = 手机：**只**动认读卡（D-298 允许 Android 写的那一组） */
  p.A.db
    .prepare(
      `update reading_cards set ease = 2.6, interval_days = 4, reps = 3, lapses = 0,
              due_at = ?, silent = 0, updated_at = ?
        where item_id in (select id from items where uid = ?)`
    )
    .run(t + 400000, t + 1000, uid)
  /** B = 电脑：**只**动 gloss（知识内容域，Android 不许碰） */
  p.B.db.prepare(`update items set gloss = 'B 改的释义', updated_at = ? where uid = ?`).run(t + 2000, uid)

  /** ★★ 立住「列不相交」这个前提 —— 不立住，下面验到的就不是那件事 */
  const aNow = readOf(p.A)
  const bNow = readOf(p.B)
  assert(aNow.g === before.g, `前提没成立：A 动了 gloss（${before.g} → ${aNow.g}）`)
  assert(
    bNow.e === before.e && bNow.i === before.i && bNow.r === before.r &&
      bNow.l === before.l && bNow.d === before.d && bNow.s === before.s,
    `前提没成立：B 动了认读卡（${JSON.stringify(before)} → ${JSON.stringify(bNow)}）`
  )
  assert(aNow.i !== before.i, '前提没成立：A 的 interval_days 根本没变')
  assert(bNow.g !== before.g, '前提没成立：B 的 gloss 根本没变')

  const rounds = await mustConverge('#20b', p)

  /**
   * ★★ 正题：**一次冲突都不许有**，而且两边的改动都要在。
   *   这一条红了就说明拆表没有真正把两个域分开 —— 那才是 D-296 失败的样子。
   */
  for (const [who, r] of [['A', p.A], ['B', p.B]] as const) {
    const now = readOf(r)
    assert(
      now.i === 4 && now.e === 2.6,
      `★★ ${who} 上没拿到手机那次练习的排期：${JSON.stringify(now)}`
    )
    assert(
      now.g === 'B 改的释义',
      `★★ ${who} 上电脑改的释义没了 —— 拆表之后不该再有整行覆盖：${JSON.stringify(now)}`
    )
  }

  /** 收敛之后不许还有待推，也不许留下任何裁决（根本没冲突可裁） */
  const pa = devA(p).snapshot().local.pending.length
  const pb = devB(p).snapshot().local.pending.length
  assert(pa === 0 && pb === 0, `★★ 收敛之后还有待推：A ${pa} / B ${pb}`)
  assert(devA(p).snapshot().resolutions.size === 0, '★★ 冒出了裁决 —— 说明还是判成了冲突')

  recordCase(
    '#20b 认读卡 vs gloss',
    p,
    rounds,
    { received: 1, applied: 1, skipped: 0, failed: 0, conflicted: 0 },
    'NO CONFLICT · D-296 OK'
  )
  p.A.db.close()
  p.B.db.close()
})

checkAsync('★★ 7E #21 · Android 的完整写入面 vs Windows 改内容 → 0 冲突，三样都留住', async () => {
  /**
   * ★★ 这是 D-296 的**验收**：拆表到底有没有解决 Android 要面对的那件事。
   *
   * 照 D-298 定的写入面演一遍真实场景：
   *
   *   A = 手机   INSERT `review_logs`（练了 30 张）
   *              UPDATE `reading_cards`（那 30 张的排期跟着走）
   *   B = 电脑   UPDATE `items` 的知识内容（改释义、改层级）
   *
   * 三件事**都发生在同一批知识点上**，而且都在离线期间。
   * V33 的时候后两件会撞成整行冲突（见 issues.md A-4）；
   * V34 之后它们落在两张表上，**不该有任何冲突**。
   *
   * 判据仍然全部复用既有设施（`mustConverge` + 收敛 Oracle），没有另造。
   */
  await cloudReady
  const p = await twoDevices('7e-21')
  await mustConverge('#21 前提', p)

  /** 取几条两台都有的知识点（按 uid，本机 id 不保证一样） */
  const uids = (
    p.A.db.prepare(`select uid from items where deleted_at is null order by id limit 3`).all() as {
      uid: string
    }[]
  ).map((x) => x.uid)
  assert(uids.length === 3, `前提没成立：夹具里没有 3 条知识点（${uids.length}）`)

  const t = Date.now()

  // ── A = 手机：练了 30 张 ─────────────────────────────────
  const idOfA = (uid: string): number =>
    (p.A.db.prepare(`select id from items where uid = ?`).get(uid) as { id: number }).id
  const insLog = p.A.db.prepare(
    `insert into review_logs
       (item_id, line, grade, interval_before, interval_after, ease_after, duration_ms, created_at, updated_at)
     values (?, 'reading', 3, ?, ?, 2.5, 1200, ?, ?)`
  )
  const bumpCard = p.A.db.prepare(
    `update reading_cards set ease = 2.6, interval_days = ?, reps = reps + 1,
            due_at = ?, updated_at = ?
      where item_id = ?`
  )
  p.A.db.transaction(() => {
    for (const [k, uid] of uids.entries()) {
      const id = idOfA(uid)
      for (let n = 0; n < 10; n++) {
        insLog.run(id, n, n + 1, t + k * 100 + n, t + k * 100 + n)
      }
      bumpCard.run(4 + k, t + 400000, t + 1000 + k, id)
    }
  })()

  // ── B = 电脑：改这三条的知识内容 ─────────────────────────
  const editItem = p.B.db.prepare(
    `update items set gloss = ?, layer = 'B', updated_at = ? where uid = ?`
  )
  p.B.db.transaction(() => {
    for (const [k, uid] of uids.entries()) editItem.run(`电脑改的释义 ${k}`, t + 2000 + k, uid)
  })()

  const rounds = await mustConverge('#21', p)

  // ── 三样都要在，两边都要有 ───────────────────────────────
  for (const [who, r] of [
    ['A', p.A],
    ['B', p.B]
  ] as const) {
    const logs = (
      r.db.prepare(`select count(*) as n from review_logs`).get() as { n: number }
    ).n
    assert(logs === 30, `★★ ${who} 上 review_logs 是 ${logs} 条，该是 30 —— 手机练的记录丢了`)

    for (const [k, uid] of uids.entries()) {
      const row = r.db
        .prepare(
          `select i.gloss as g, i.layer as ly, rc.interval_days as ivl, rc.ease as e, rc.reps as reps
             from items i join reading_cards rc on rc.item_id = i.id where i.uid = ?`
        )
        .get(uid) as { g: string; ly: string; ivl: number; e: number; reps: number }
      assert(
        row.ivl === 4 + k && row.e === 2.6 && row.reps === 1,
        `★★ ${who} 上没拿到手机那次练习的排期：${JSON.stringify(row)}`
      )
      assert(
        row.g === `电脑改的释义 ${k}` && row.ly === 'B',
        `★★ ${who} 上电脑改的内容没了 —— 拆表之后不该再有整行覆盖：${JSON.stringify(row)}`
      )
    }
  }

  /** ★ 正题：一次冲突都不许有，也不许留下任何裁决 */
  const snapA = devA(p).snapshot()
  const snapB = devB(p).snapshot()
  assert(snapA.resolutions.size === 0, '★★ 冒出了裁决 —— 说明还是判成了冲突')
  assert(
    snapA.local.pending.length === 0 && snapB.local.pending.length === 0,
    `★★ 收敛之后还有待推：A ${snapA.local.pending.length} / B ${snapB.local.pending.length}`
  )

  recordCase(
    '#21 Android 写入面 vs 内容',
    p,
    rounds,
    { received: 30, applied: 30, skipped: 0, failed: 0, conflicted: 0 },
    'NO CONFLICT · D-296 OK'
  )
  p.A.db.close()
  p.B.db.close()
})


