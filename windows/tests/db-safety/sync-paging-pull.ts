/**
 * R-4-C-a 拉取侧分批：不再把全部历史一次性读进内存
 *
 * 原 tests/db-safety.ts 第 10924–11561 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { SYNC_PROTOCOL_VERSION } from '../../src/core/sync-protocol.ts'
import { lastSyncProblems } from '../../src/main/sync/problems.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, cloudFiles, fakeServer, cloudReady, localIdentity, putChunk, configureSync, syncState, newSync, ghost, fPicks } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ R-4-C-a · 拉的时候一批一批来，不再把全部历史一次性读进内存
//
// 病：`for (const n of todo)` 把**所有**包的行堆进一个数组再统一处理。
// 新设备第一次同步 = 云端全部历史一次性进内存。推那一侧早就分页了
// （R-4-B 每包最多 5000 行），拉这一侧一直没有。
//
// 判据不是「内存占了多少」—— CI 的 RSS 受 GC 时机影响，量出来是噪声。
// 量的是它的**直接因**：`maxBatchRows`，单批装过的最大行数。
// 它有上界，峰值就有上界；它跟着总量一起涨，那就是没分批。
// ══════════════════════════════════════════════════════════════

console.log('\nR-4-C-a · 拉取侧分批\n')

/** 和 `src/main/sync/index.ts` 里的 `PULL_PACKS` / `PULL_ROWS` 对齐 */
const C_PACKS = 25
const C_ROWS = 5000

/** 一行远端 project —— uid 和 id 都唯一，写进去就数得出来 */
function cRow(i: number, base: number): Record<string, unknown> {
  const t = base + i
  const uid = `c-p-${i}`
  return {
    uid,
    table: 'projects',
    updatedAt: t,
    data: {
      id: 200_000 + i,
      name: `远端项目 ${i}`,
      color: '#666',
      sort: 0,
      pinned: 0,
      silent: 0,
      deleted_at: null,
      created_at: t,
      updated_at: t,
      uid
    }
  } as unknown as Record<string, unknown>
}

/** 真正落进库的那些远端行 —— 不看 `applied`、不看 `lastNote`（R-4-E 的教训） */
function cLanded(db: Database.Database): number {
  return (
    db.prepare(`select count(*) as n from projects where uid like 'c-p-%'`).get() as { n: number }
  ).n
}

interface CScene {
  r: ReturnType<typeof openDatabase>
  sync: Sync
  bucket: string
  /** 云端一共放了几行 */
  total: number
}

/** `sizes[i]` = 第 i 个包里放几行 */
async function cScene(bucket: string, sizes: number[]): Promise<CScene> {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const base = Date.now() - 5_000_000
  let n = 0
  for (let i = 0; i < sizes.length; i++) {
    const rows: Record<string, unknown>[] = []
    for (let k = 0; k < sizes[i]!; k++) rows.push(cRow(n++, base))
    putChunk(bucket, `other-${2_000_000 + i}.json`, rows)
  }
  return { r, sync: newSync(r, backups), bucket, total: n }
}

// ── ①②③④⑤⑥ 包数这一档：25 个包一批 ──────────────────────

for (const packs of [24, 25, 26, 1000, 5000, 10000]) {
  const want = Math.ceil(packs / C_PACKS)
  checkAsync(`★★ R-4-C-a · ${packs} 个包 → 分 ${want} 批，一行不少`, async () => {
    const s = await cScene(`ca-p${packs}`, new Array<number>(packs).fill(1))
    const out = await s.sync.run()

    assert(out.received === packs, `★★ 收到的行数不对：${out.received} / ${packs}`)
    assert(out.applied === packs, `★★ 落库数不对：${JSON.stringify(out)}`)
    assert(out.batches === want, `★★ 批数不对：分了 ${out.batches} 批，该 ${want} 批`)
    /**
     * ★★ 内存判据 · 每包 1 行 → 任何一批都不该超过 `PULL_PACKS` 行。
     * 这个数要是跟着 `packs` 一起涨，那就是又聚成一个数组了。
     */
    assert(
      out.maxBatchRows !== undefined && out.maxBatchRows <= C_PACKS,
      `★★ 单批装了 ${out.maxBatchRows} 行 —— 分批没生效，全部历史又进内存了`
    )
    const landed = cLanded(s.r.db)
    assert(landed === packs, `★★ 报了 ${out.applied} 条，库里只有 ${landed} 条`)
    s.r.db.close()
  })
}

// ── ⑦⑧⑨ 行数这一档：5000 行一批 ────────────────────────────

for (const [n, sizes, want] of [
  [4999, [1000, 1000, 1000, 1000, 999], 1],
  [5000, [1000, 1000, 1000, 1000, 1000], 1],
  [5001, [1000, 1000, 1000, 1000, 1000, 1], 2]
] as [number, number[], number][]) {
  checkAsync(`★★ R-4-C-a · ${n} 行 → 分 ${want} 批，一行不少`, async () => {
    const s = await cScene(`ca-r${n}`, sizes)
    assert(s.total === n, `夹具自己造错了：${s.total} / ${n}`)
    const out = await s.sync.run()

    assert(out.received === n, `★★ 收到的行数不对：${out.received} / ${n}`)
    assert(out.applied === n, `★★ 落库数不对：${JSON.stringify(out)}`)
    assert(out.batches === want, `★★ 批数不对：分了 ${out.batches} 批，该 ${want} 批`)
    assert(
      out.maxBatchRows !== undefined && out.maxBatchRows <= C_ROWS,
      `★★ 单批装了 ${out.maxBatchRows} 行，上限是 ${C_ROWS}`
    )
    const landed = cLanded(s.r.db)
    assert(landed === n, `★★ 报了 ${out.applied} 条，库里只有 ${landed} 条`)
    s.r.db.close()
  })
}

// ── ⑩ 单个包自己就超过上限 ──────────────────────────────────

checkAsync('★★ R-4-C-a · 单个包 6000 行（自己就超上限）→ 不拆开，允许略超', async () => {
  /**
   * 拆包会把「同一次推送的那一批行」割裂开，而 `origin` 那张表、
   * 「这一包干净不干净」的判定（R-4-A）全都是以包为单位的 ——
   * 拆了之后半个包进 `applied`，另外半个永远没人管。
   *
   * 所以宁可略超上限也不拆。两个 6000 行的包分两批，
   * 证明**批的边界永远落在包的边界上**。
   */
  const s = await cScene('ca-big', [6000, 6000])
  const out = await s.sync.run()

  assert(out.received === 12_000, `★★ 收到的行数不对：${out.received}`)
  assert(out.applied === 12_000, `★★ 落库数不对：${JSON.stringify(out)}`)
  assert(out.batches === 2, `★★ 该一包一批（共 2 批），实际 ${out.batches} 批`)
  assert(
    out.maxBatchRows === 6000,
    `★★ 单批 ${out.maxBatchRows} 行 —— 不是 6000 就说明包被拆开了`
  )
  assert(cLanded(s.r.db) === 12_000, `★★ 库里对不上：${cLanded(s.r.db)}`)
  s.r.db.close()
})

// ── ⑪⑫⑬ 第 N 批中途炸掉 · 重来只处理剩下的 ────────────────

interface CDav {
  port: number
  close: () => void
  /** 每一次 GET 的路径 —— 用来证明已经应用过的包**没有**被重下 */
  gets: string[]
  /** 第几次 GET 变成 500（0 = 不炸） */
  state: { failAt: number }
}

/**
 * 一台**能按第几次 GET 定点炸掉**的 WebDAV。
 *
 * 不复用上面那台共用的：那台是全部用例共享的，
 * 在它身上注入故障会把别的用例一起打红（夹具红了，被验的东西没红）。
 */
async function cDav(files: Map<string, string>): Promise<CDav> {
  const gets: string[] = []
  const state = { failAt: 0 }
  const srv = fakeServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').replace(/\/+$/, ''))
    if (req.method === 'MKCOL') {
      res.writeHead(201).end()
      return
    }
    if (req.method === 'PROPFIND') {
      const kids = [...files.keys()].filter((k) => k.startsWith(path ? `${path}/` : ''))
      res
        .writeHead(207, { 'content-type': 'application/xml' })
        .end(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">` +
            kids.map((k) => `<D:response><D:href>/${k}</D:href></D:response>`).join('') +
            `</D:multistatus>`
        )
      return
    }
    if (req.method === 'PUT') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        files.set(path, body)
        res.writeHead(201).end()
      })
      return
    }
    if (req.method === 'GET') {
      gets.push(path)
      if (state.failAt > 0 && gets.length === state.failAt) {
        res.writeHead(500).end('boom')
        return
      }
      const v = files.get(path)
      if (v === undefined) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': 'application/json' }).end(v)
      return
    }
    res.writeHead(405).end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return { port: (srv.address() as { port: number }).port, close: () => srv.close(), gets, state }
}

/** 和 `configureSync` 一样，只是把 URL 指到另一台服务器 */
function configureSyncUrl(r: ReturnType<typeof openDatabase>, url: string): void {
  const t = Date.now()
  const set = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('sync.kind', 'webdav', t)
  set.run('sync.url', url, t)
  set.run('sync.user', 'u', t)
  set.run('sync.secret', 's', t)
  set.run('sync.device', 'me', t)
}

checkAsync('★★ R-4-C-a · 第 2 批中途炸掉：前一批的成果算数，重来只处理剩下的', async () => {
  await cloudReady // ★ 只为 localIdentity 的预载（本用例的 dav 是自建的）
  /**
   * 这一条是分批**唯一真正的好处**，也是唯一真正的新风险，所以必须验：
   *   · 好处 —— 以前中途炸了整趟白干（`applied` 一次都没落盘）
   *   · 风险 —— 半截状态记错了，那 25 个包会被当成没处理过，或者反过来
   *
   * 判据全部直接查库 / 查服务器收到的请求，不看 `lastNote`。
   */
  const files = new Map<string, string>()
  const dav = await cDav(files)
  try {
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    configureSyncUrl(r, `http://127.0.0.1:${dav.port}/x`)
    const base = Date.now() - 5_000_000
    const names: string[] = []
    for (let i = 0; i < 60; i++) {
      const n = `other-${3_000_000 + i}.json`
      names.push(n)
      files.set(
        `x/nyx/chunks/${n}`,
        // ★ Step 2 · 夹具要带包头 —— 不带就是 legacy 包，C-1 之后整包被拒
        JSON.stringify({
          device: 'other',
          at: base,
          schemaVersion: localIdentity().schemaVersion,
          schemaFingerprint: localIdentity().schemaFingerprint,
          protocolVersion: SYNC_PROTOCOL_VERSION,
          rows: [cRow(i, base)]
        })
      )
    }
    const sync = newSync(r, backups)

    // 第 2 批（第 26～50 个包）走到第 5 个包的时候炸
    dav.state.failAt = 30
    let threw = false
    try {
      await sync.run()
    } catch {
      threw = true
    }
    assert(threw, '★★ 云端读不到，却没有报出来 —— 静默失败')

    const st = syncState(r.db)
    assert(
      st.applied.length === C_PACKS,
      `★★ 第一批的成果没记下来：applied 里有 ${st.applied.length} 个，该有 ${C_PACKS} 个`
    )
    for (const n of names.slice(0, C_PACKS)) {
      assert(st.applied.includes(n), `★★ 第一批成功的包没进 applied：${n}`)
    }
    assert(
      cLanded(r.db) === C_PACKS,
      `★★ 第一批该落库 ${C_PACKS} 行，实际 ${cLanded(r.db)}`
    )
    /** 炸掉那一批**一行都不许落** —— 包是原子的，批也是 */
    for (const n of names.slice(C_PACKS)) {
      assert(!st.applied.includes(n), `★★ 没处理完的包进了 applied：${n}`)
    }

    // ── 重来 ──────────────────────────────────────────────
    dav.state.failAt = 0
    dav.gets.length = 0
    const out = await sync.run()

    assert(out.received === 60 - C_PACKS, `★★ 重来该只处理剩下的 35 个包，实际 ${out.received}`)
    for (const n of names.slice(0, C_PACKS)) {
      assert(
        !dav.gets.some((g) => g.endsWith(n)),
        `★★ 已经应用过的包又重下了一遍：${n}（applied 白记了）`
      )
    }
    assert(cLanded(r.db) === 60, `★★ 重来之后不全：库里 ${cLanded(r.db)} 行，该 60 行`)
    const st2 = syncState(r.db)
    for (const n of names) assert(st2.applied.includes(n), `★★ 重来之后这个包还没进 applied：${n}`)
    r.db.close()
  } finally {
    dav.close()
  }
})

// ── ⑭ 四个桶跨批也要对得上账 ────────────────────────────────

checkAsync('★★ R-4-C-a · 跨 3 批的混合：received = applied + skipped + failed + conflicted', async () => {
  /**
   * 四个桶的原料现在是**一批一批攒出来的**（R-4-G-e 的 `tally()` 一个字没改）。
   * 攒的时候少加一次、多加一次，那条恒等式当场不平 ——
   * 写这一段时真的多加过一次（选「用本地」的冲突行被加了两遍），
   * 是 R-4-F 的用例把它抓出来的。
   *
   * 所以这里要的不只是恒等式成立，还要**四个桶都非零**：
   * 全零也能让恒等式成立，那种绿是假的。
   */
  await cloudReady
  const bucket = 'ca-mix'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const base = Date.now() - 5_000_000

  // 本地先造 10 条 picks，同步一次让水位落到它们之后
  fPicks(r, 10, base)
  const sync = newSync(r, backups)
  await sync.run()
  const picks = r.db.prepare(`select * from picks order by id`).all() as Record<string, unknown>[]

  const now = Date.now()
  // 本地改前 5 条 → 它们是真冲突
  r.db.prepare(`update picks set content = '我改的', updated_at = ? where id <= 5`).run(now + 500)

  let good = 0
  for (let i = 0; i < 60; i++) {
    const name = `other-${4_000_000 + i}.json`
    const kind = i % 12
    if (kind < 8) {
      // 全新的行 → applied（40 个包）
      putChunk(bucket, name, [cRow(good++, base)])
    } else if (kind < 10) {
      // 外键指向不存在的讲 → failed（10 个包）
      putChunk(bucket, name, [
        {
          uid: `c-il-${i}`,
          table: 'item_lectures',
          updatedAt: now,
          data: {
            item_id: 1,
            lecture_id: 999,
            is_owner: 0,
            created_at: now,
            updated_at: now,
            uid: `c-il-${i}`
          }
        }
      ])
    } else if (kind === 10) {
      // 和本地**一模一样**的行 → same → skipped（5 个包）
      const row = picks[5 + ((i / 12) | 0)]!
      putChunk(bucket, name, [
        { uid: String(row['uid']), table: 'picks', updatedAt: Number(row['updated_at']), data: row }
      ])
    } else {
      // 两边都改过 → conflicted（5 个包）
      const row = picks[(i / 12) | 0]!
      putChunk(bucket, name, [
        {
          uid: String(row['uid']),
          table: 'picks',
          updatedAt: now + 900,
          data: { ...row, content: '对面改的', updated_at: now + 900 }
        }
      ])
    }
  }

  const out = await sync.run()
  assert(out.batches === 3, `★ 该分 3 批，实际 ${out.batches} 批 —— 这条要的就是跨批`)
  assert(
    out.received === out.applied + out.skipped + out.failed + out.conflicted,
    `★★ 跨批之后四个桶对不上账：${JSON.stringify(out)}`
  )
  assert(out.applied === 40, `★ applied 不对：${JSON.stringify(out)}`)
  assert(out.failed === 10, `★ failed 不对：${JSON.stringify(out)}`)
  assert(out.skipped === 5, `★ skipped 不对：${JSON.stringify(out)}`)
  assert(out.conflicted === 5, `★ conflicted 不对：${JSON.stringify(out)}`)
  assert(cLanded(r.db) === 40, `★★ 报了应用 40 条，库里只有 ${cLanded(r.db)} 条`)

  /** 失败与冲突的包**跨批也不许**进 applied（R-4-A / R-4-F 靠它重试） */
  const st = syncState(r.db)
  let bad = 0
  for (let i = 0; i < 60; i++) {
    const kind = i % 12
    const name = `other-${4_000_000 + i}.json`
    if (kind >= 8 && kind < 10 && st.applied.includes(name)) bad++
    if (kind === 11 && st.applied.includes(name)) bad++
  }
  assert(bad === 0, `★★ 有 ${bad} 个没处理完的包进了 applied —— 分批把重试机制弄丢了`)
  r.db.close()
})

// ── ⑮ 第二次同步幂等 ────────────────────────────────────────

checkAsync('★★ R-4-C-a · 第二次同步：一个包都不用再读，库里一个字不变', async () => {
  const s = await cScene('ca-idem', new Array<number>(30).fill(2))
  const first = await s.sync.run()
  assert(first.batches === 2, `前提：该分 2 批，实际 ${first.batches}`)
  assert(first.applied === 60, `前提：该落库 60 行，实际 ${first.applied}`)

  const digest = (): string =>
    JSON.stringify(
      s.r.db
        .prepare(`select uid, name, updated_at from projects where uid like 'c-p-%' order by uid`)
        .all()
    )
  const before = digest()

  const second = await s.sync.run()
  assert(second.received === 0, `★★ 已经应用过的包又被读了一遍：${JSON.stringify(second)}`)
  assert(second.batches === 0, `★★ 没有包要处理，却还是跑了 ${second.batches} 批`)
  assert(
    second.applied === 0 && second.failed === 0 && second.conflicted === 0,
    `★★ 第二次同步不该再动任何东西：${JSON.stringify(second)}`
  )
  assert(digest() === before, '★★ 第二次同步把已经落库的行又改了一遍')
  s.r.db.close()
})

// ── ⑯ 墓碑在第 1 批，被它挡的行在第 2 批 ────────────────────

checkAsync('★★ R-4-C-a · 碑在第 1 批、遗骸在第 2 批 → 照样挡住，算跳过不算失败', async () => {
  /**
   * 分批之前，一趟里所有的碑在任何一行被判定之前就都看见了。
   * 分批之后不再是这样 —— 碑可能落在前面的批次里，遗骸落在后面。
   *
   * 挡不住的后果不是「多写一行」：他删掉的东西会在另一台上**复活**，
   * 而且 R-3 那一整套用例一条都不会红（它们全在同一批里）。
   */
  await cloudReady
  const bucket = 'ca-tomb'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const base = Date.now() - 5_000_000
  const victim = 'c-p-victim'

  // 第 1 个包：一块碑，说「projects/c-p-victim 已经被彻底删掉了」
  putChunk(bucket, `other-${5_000_000}.json`, [
    ghost('tombstones', {
      target_uid: victim,
      kind: 'projects',
      target_id: 900_001,
      purged_at: base + 100_000,
      created_at: base,
      updated_at: base
    })
  ])
  // 中间 24 个包把这一批填满
  for (let i = 1; i <= 24; i++) putChunk(bucket, `other-${5_000_000 + i}.json`, [cRow(i, base)])
  // 第 26 个包（落在第 2 批）：那块碑指的那一行的老版本
  putChunk(bucket, `other-${5_000_025}.json`, [
    {
      uid: victim,
      table: 'projects',
      updatedAt: base,
      data: {
        id: 900_001, name: '删掉的项目', color: '#666', sort: 0, pinned: 0, silent: 0,
        deleted_at: null, created_at: base, updated_at: base, uid: victim
      }
    }
  ])

  const out = await newSync(r, backups).run()
  assert(out.batches === 2, `前提：该分 2 批，实际 ${out.batches}`)
  const back = (
    r.db.prepare(`select count(*) as n from projects where uid = ?`).get(victim) as { n: number }
  ).n
  assert(back === 0, '★★ 跨批之后墓碑挡不住了 —— 他删掉的东西在另一台上复活了')
  assert(out.failed === 0, `★ 被碑挡下的行算成了失败（会永远重试）：${JSON.stringify(out)}`)
  r.db.close()
})

// ── ⑰ 先收后写：拉下来的行不许原样弹回云端 ──────────────────

checkAsync('★★ R-4-C-a · 分批之后，拉下来的行仍然不许被当成「我的新改动」推回去', async () => {
  /**
   * `collectSince` 必须在**第一批写入之前**跑完。
   * 挪到循环里面或后面，第二批开工时前一批刚落库的行就成了「本地新改动」——
   * 数据在两台机器之间来回弹，第三台会看到同一条内容被两个设备分别声明改过。
   *
   * 分批把这件事从「一句顺序」变成了「一句必须守住的顺序」，所以单独验一条。
   */
  const s = await cScene('ca-bounce', new Array<number>(30).fill(2))
  const out = await s.sync.run()
  assert(out.batches === 2, `前提：该分 2 批，实际 ${out.batches}`)
  assert(out.applied === 60, `前提：该落库 60 行，实际 ${out.applied}`)

  let bounced = 0
  for (const [k, v] of cloudFiles) {
    if (!k.startsWith(`${s.bucket}/nyx/chunks/me-`)) continue
    for (const row of (JSON.parse(v) as { rows?: { uid: string }[] }).rows ?? []) {
      if (row.uid.startsWith('c-p-')) bounced += 1
    }
  }
  assert(bounced === 0, `★★ 有 ${bounced} 行是刚拉下来又原样推回去的 —— 数据在两台机器之间来回弹`)
  s.r.db.close()
})

// ── 同一行躺在好几个包里：问题清单只许记一条 ─────────────────

checkAsync('★★ 同一行在 3 个包里都冲突 → 只记一条问题（记多了整页会崩）', async () => {
  /**
   * ★ 这是 R-4-C-a 那条真双机用例撞出来的**真 bug**，不是想出来的边界。
   *
   * 设置页那份清单是 `{#each syncS.problems as p (p.what)}` ——
   * 同一行记两条，key 就撞了，Svelte 抛 `each_key_duplicate`，
   * **整个设置页变成「这一页出错了」**。他一点设置就什么都做不了。
   *
   * 而「同一行躺在好几个包里」根本不是边界：对面每改一次推一个包，
   * 那一行就多躺一个包 —— 冲突一天不裁决，它就一天在多一个包里。
   */
  await cloudReady
  const bucket = 'ca-dup'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const base = Date.now() - 1_000_000
  fPicks(r, 1, base)
  const sync = newSync(r, backups)
  await sync.run() // 先同步一次，水位落到这一行之后

  const row = r.db.prepare(`select * from picks order by id limit 1`).get() as Record<
    string,
    unknown
  >
  const now = Date.now()
  r.db
    .prepare(`update picks set content = '我改的', updated_at = ? where id = ?`)
    .run(now + 500, row['id'])
  for (let i = 0; i < 3; i++) {
    putChunk(bucket, `other-${6_000_000 + i}.json`, [
      {
        uid: String(row['uid']),
        table: 'picks',
        updatedAt: now + 900 + i,
        data: { ...row, content: `对面改的 ${i}`, updated_at: now + 900 + i }
      }
    ])
  }

  const out = await sync.run()
  assert(out.conflicted === 3, `前提：同一行、三个包，该有 3 处冲突：${JSON.stringify(out)}`)
  const probs = lastSyncProblems(r.db)?.problems ?? []
  assert(
    probs.length === 1,
    `★★ 同一行记了 ${probs.length} 条 —— 清单的 key 是 what，重复 key 会把整个设置页打崩`
  )
  assert(probs[0]!.what.includes(String(row['uid'])), `★ 记的不是那一行：${probs[0]!.what}`)
  r.db.close()
})

// ── 结构守：不许再回到「一次性聚成一个数组」 ────────────────

check('★★ R-4-C-a · 内存判据（结构守）：所有包的行不许再聚进同一个数组', () => {
  // ★ 阶段 3：执行器在 core/sync/engine.ts（两端同一份），尺子对着它量
  const ENGINE = join(process.cwd(), 'src', 'core', 'sync', 'engine.ts')
  /**
   * 这条守的是**将来**。上面那些用例验的是行为，行为对了不等于
   * 下一个人不会把它改回去 —— 而改回去之后**每一条都还是绿的**：
   * 分批与否对结果毫无影响，只有内存看得出来，而内存没人测。
   *
   * 所以直接盯源码的形状：`remoteRows` 只许有一处声明，且必须在循环体内。
   */
  const whole = readFileSync(ENGINE, 'utf8')

  /**
   * ★ Step 6B · 两个上限**搬去 core 了**（`core/sync/session.ts`），所以在那边查。
   *
   * 原来这两行查的是 `index.ts` 里的同名常量。Commit B 把「装到这一批为止了吗」
   * 这个判据收进 core 之后，平台层再留一份数字就是两份判据 —— 分家之后表现是
   * 「Windows 一批 25 个包、Android 一批 30 个」，两端「中途失败从哪儿接着来」
   * 不一样，而没有任何东西会报错。
   *
   * 这条断言的**意思一个字没变**：分批的两个闸必须还在，只是换了个地方查。
   */
  const core = readFileSync(join(process.cwd(), 'src', 'core', 'sync', 'session.ts'), 'utf8')
  assert(/export const PULL_PACKS/.test(core), '★ 包数上限没了')
  assert(/export const PULL_ROWS/.test(core), '★ 行数上限没了')
  assert(
    /export function batchIsFull/.test(core),
    '★★ 「装到这一批为止了吗」的判据没了 —— 它一没，分批就只剩两个没人读的常量'
  )

  /**
   * ★ 先把注释剃掉再扫。
   *
   * 第一版没剃，当场红了 —— 红在**我自己写的那段注释**上：
   * 「以前是 `for (const n of todo)` 把所有包的行堆进一个数组」。
   * 说明病的那句话被当成了病本身。这种尺子迟早会逼着后人
   * 「为了让检查过去而不敢在注释里写清楚原因」，那比不检查更坏。
   */
  const src = whole.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const flat = src.replace(/\s+/g, ' ')
  assert(
    !/Promise\.all\(\s*todo\.map/.test(flat),
    '★★ 又出现了 `Promise.all(todo.map(...))` —— 那是一次性把全部包拉进内存'
  )
  assert(!/for \(const n of todo\)/.test(flat), '★★ 又出现了「一次遍历完 todo」的老循环')

  const decls = src.match(/const remoteRows/g) ?? []
  assert(decls.length === 1, `★★ remoteRows 有 ${decls.length} 处声明 —— 分批的边界糊了`)
  /**
   * ★ Step 6B · 批循环的**头换了**：`while (cursor < todo.length)` 变成了
   *   「core 说下一步还是 fetch 就再来一批」。
   *
   *   这条断言查的东西一个字没变 —— `remoteRows` 必须声明在**批循环内部**，
   *   否则全部历史又一次性进内存。换的只是「哪一行是批循环的头」这个锚点。
   *   ★ 不能再拿 `while (cursor < todo.length)` 当锚点了：那个串现在匹配的是
   *     **批内**那个「边下边判装不装得下」的内层循环，它排在 `remoteRows`
   *     后面，于是这条断言会永远为假 —— 一条永远红的断言和一条永远绿的一样没用。
   */
  const loopAt = src.indexOf("kind === 'fetch'")
  assert(loopAt > 0, '★★ 分批的循环不在了')
  assert(
    src.indexOf('const remoteRows') > loopAt,
    '★★ remoteRows 被挪到循环外面了 —— 又变成全部历史一次性进内存'
  )
})

