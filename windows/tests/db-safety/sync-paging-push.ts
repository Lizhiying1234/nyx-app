/**
 * R-4-C 推送侧分页：「装不下」不许等于「悄悄少一截」
 *
 * 原 tests/db-safety.ts 第 9847–10220 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { makeStore } from '../../src/main/sync/store.ts'
import { checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, cloudFiles, fakeServer, cloudReady, configureSync, seedPicks, syncUntilDone } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ R-4-C · 「装不下」不许等于「悄悄少一截」
//
// 两处上限，两个方向：
//   本地收集  一包最多 5000 行 → 分页游标是**时间戳**（R-4-B）
//   远端列举  一页最多 1000 个 → 分页游标是 **offset**（本轮）
//
// 完整性判据只有一个：**把云端所有变更包拆开数 uid**，
// 和库里的 uid 集合逐个比。绝不拿 `pushed` / `applied` / 界面那句话当尺子 ——
// 那正是 R-4-E 修过的地方，不能拿它当自己的尺子。
// ══════════════════════════════════════════════════════════════

console.log('\nR-4-C · 分页\n')

/** 云端**真实存在**的某张表的 uid —— 拆开所有包数出来的 */
function cloudUids(bucket: string, table: string): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of cloudFiles) {
    if (!k.startsWith(`${bucket}/nyx/chunks/`)) continue
    try {
      const pack = JSON.parse(v) as { rows?: { table: string; uid: string }[] }
      for (const r of pack.rows ?? []) if (r.table === table) out.add(r.uid)
    } catch {
      /* 坏包不算 */
    }
  }
  return out
}

/** 库里某张表的 uid */
function localUids(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`select uid from "${table}"`).all() as { uid: string }[]).map((r) => r.uid)
  )
}

/** 塞 n 条 picks（无外键、最便宜）。`step = 0` 就是全挤在同一毫秒 */

/** 一直同步到推完为止，返回跑了几次 */

for (const [name, n, step] of [
  ['4999 条（一包装得下）', 4999, 1],
  ['5000 条（正好一包）', 5000, 1],
  ['5001 条（多一条）', 5001, 1],
  ['12000 条（要好几包）', 12000, 1],
  ['同一毫秒 6000 条', 6000, 0]
] as const) {
  checkAsync(`★★ R-4-C · 本地收集 · ${name} → 云端一条不少`, async () => {
    await cloudReady
    const bucket = `c1-${n}-${step}`
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    configureSync(r, bucket)
    seedPicks(r, n, Date.now() - 10_000_000, step)

    const want = localUids(r.db, 'picks')
    assert(want.size === n, `前提没成立：库里该有 ${n} 条，实际 ${want.size}`)

    const runs = await syncUntilDone(new Sync(r.db, join(backups, 'audio'), backups))
    assert(runs <= 8, '★ 推不完 —— 分页在原地打转')

    /**
     * ★ 判据：拆开云端**所有**变更包数 uid，和库里的逐个比。
     * 用 `pushed` 那个数字是不行的 —— 它是「这一趟发了多少」，
     * 不是「云端最终有多少」，而后者才是对面能收到的东西。
     */
    const got = cloudUids(bucket, 'picks')
    const missing = [...want].filter((u) => !got.has(u))
    assert(
      missing.length === 0,
      `★★ 云端少了 ${missing.length} 条 —— 对面永远收不到它们（库 ${want.size} · 云端 ${got.size}）`
    )
    assert(got.size === want.size, `★ 云端多出来了：${got.size} vs ${want.size}`)
    r.db.close()
  })
}

checkAsync('★★ R-4-C · 水位停在实推位置，不是 startedAt；重推不重不漏', async () => {
  await cloudReady
  const bucket = 'c1-wm'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const base = Date.now() - 10_000_000
  seedPicks(r, 12000, base, 1)
  const want = localUids(r.db, 'picks')

  const sync = new Sync(r.db, join(backups, 'audio'), backups)
  const first = await sync.run()
  assert((first.leftOver ?? 0) > 0, '前提没成立：12000 条该一次装不下')

  const wm = Number(
    (
      r.db.prepare(`select value from settings where key='sync.watermark'`).get() as {
        value: string
      }
    ).value
  )
  /**
   * ★ 水位必须落在**播种的那一段时间里**（base ~ base+12000），
   * 而不是「现在」。落在现在就等于宣布「水位之前的都推过了」——
   * 那 7000 条没推的从此再也不会被收集。
   */
  assert(
    wm >= base && wm < base + 12000,
    `★★ 水位没停在实推位置（那样没推的那些从此再也收不到）：${wm}`
  )
  assert(
    wm < Date.now() - 1_000_000,
    `★★ 水位跳到了 startedAt —— 这正是 R-4-B 修掉的那个洞：${wm}`
  )

  const runs = await syncUntilDone(sync)
  assert(runs <= 8, '★ 续推没完成')
  const got = cloudUids(bucket, 'picks')
  assert(got.size === want.size, `★ 续推之后对不上：库 ${want.size} · 云端 ${got.size}`)
  r.db.close()
})

// ── 远端列举 · Supabase 翻页 ────────────────────────────────

interface FakeSupa {
  port: number
  close: () => void
  /** 每次 list 请求收到的参数 —— 用来证明真的翻了页、真的带了排序 */
  calls: { limit: number; offset: number; sorted: boolean }[]
}

/**
 * 一个按 Supabase 真实契约行事的假服务。
 *
 * `shuffle = true` 时**故意不按名字排序**返回 —— 除非调用方
 * 显式要求 `sortBy: name asc`。这一条挡的是「默认顺序刚好稳定」那种假安全。
 */
async function fakeSupabase(count: number, shuffle = false): Promise<FakeSupa> {
  const objects: string[] = []
  for (let i = 0; i < count; i++) objects.push(`dev-${String(i).padStart(6, '0')}.json`)
  const calls: FakeSupa['calls'] = []

  const srv = fakeServer((req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url.includes('/storage/v1/bucket/')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    if (req.method === 'POST' && url.includes('/storage/v1/object/list/')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let q: {
          limit?: number
          offset?: number
          sortBy?: { column?: string; order?: string }
        } = {}
        try {
          q = JSON.parse(body) as typeof q
        } catch {
          /* 空 body 当默认 */
        }
        const sorted = q.sortBy?.column === 'name' && q.sortBy?.order === 'asc'
        calls.push({ limit: q.limit ?? -1, offset: q.offset ?? -1, sorted })

        // 没明说要排序 && 这个假服务是「乱序的」→ 就真的乱给
        const all = sorted || !shuffle ? objects : [...objects].reverse()
        const off = q.offset ?? 0
        const lim = q.limit ?? 100
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(all.slice(off, off + lim).map((n) => ({ name: n }))))
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return {
    port: (srv.address() as { port: number }).port,
    close: () => srv.close(),
    calls
  }
}

const supaStore = (port: number): ReturnType<typeof makeStore> =>
  makeStore({ kind: 'supabase', url: `http://127.0.0.1:${port}`, user: 'nyx', secret: 'k' })

for (const n of [999, 1000, 1001, 1500]) {
  checkAsync(`★★ R-4-C · 远端列举 · 云端 ${n} 个包 → 一个不少、不重`, async () => {
    const fake = await fakeSupabase(n)
    try {
      const names = await supaStore(fake.port).list('nyx/chunks')
      assert(names.length === n, `★★ 拿回 ${names.length} 个，云端真实有 ${n} 个`)
      assert(new Set(names).size === n, `★ 有重复：${names.length} vs ${new Set(names).size}`)
      // 1000 整除的那两档最容易写错（少一页 / 多空跑一页）
      const pages = fake.calls.length
      const want = Math.floor(n / 1000) + 1
      assert(pages === want, `翻页次数不对：翻了 ${pages} 次，该 ${want} 次`)
    } finally {
      fake.close()
    }
  })
}

checkAsync('★★ R-4-C · 翻页必须自己指定 name asc —— 不许指望服务端的默认顺序', async () => {
  /**
   * offset 分页的正确性**完全依赖顺序稳定**。
   * 这个假服务在没被明确要求排序时会倒着给 —— 那样翻页会漏行、会重行，
   * 而且**一样不报错**。「默认顺序刚好稳定」是假安全。
   */
  const fake = await fakeSupabase(1500, true)
  try {
    const names = await supaStore(fake.port).list('nyx/chunks')
    assert(
      fake.calls.every((c) => c.sorted),
      '★★ 有请求没带 sortBy: name asc —— 服务端顺序一变就会漏行'
    )
    assert(names.length === 1500, `★★ 乱序服务下漏了：拿回 ${names.length} 个`)
    assert(new Set(names).size === 1500, '★★ 乱序服务下重了')
  } finally {
    fake.close()
  }
})

// ── F-5 · Supabase 的 HTTP 状态码不能信（2026-08-17 真机同步验收）──────
//
// 桶不存在时它回 400，真正的 404 只写在正文 `{"statusCode":"404",...}` 里。
// 按 `r.status` 分支的提示语因此**全部落空**：他看到「返回 400」，
// 而唯一能告诉他该做什么的那句「去后台建一个同名的桶」永远不显示。
// 那天他手上除了「返回 400」什么都没有 —— 正文里明明白白写着 NoSuchBucket。

/** 一个只会按 Supabase 的方式报错的假服务：HTTP 400，真码在正文里 */
async function fakeSupaError(
  statusCode: string,
  code: string,
  httpStatus = 400
): Promise<{ port: number; close: () => void }> {
  const srv = fakeServer((_req, res) => {
    res
      .writeHead(httpStatus, { 'content-type': 'application/json' })
      .end(JSON.stringify({ statusCode, error: 'x', message: 'x', code }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return { port: (srv.address() as { port: number }).port, close: () => srv.close() }
}

const said = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

checkAsync('★★ F-5 · 桶不存在（HTTP 400 · 正文 404）→ 必须告诉他去建桶', async () => {
  const fake = await fakeSupaError('404', 'NoSuchBucket')
  try {
    const msg = await said(() => supaStore(fake.port).check())
    assert(msg !== '', '桶不存在却没报错')
    assert(
      /建一个同名的桶/.test(msg),
      `★★ 他看到的还是一句没法照做的话，缺「去建桶」那一句：\n      ${msg}`
    )
    assert(/nyx/.test(msg), `★ 没说是哪个桶：${msg}`)
    assert(!/返回 400/.test(msg), `★★ 还在拿没意义的 400 当结论：${msg}`)
  } finally {
    fake.close()
  }
})

checkAsync('★★ F-5 · 没权限（HTTP 400 · 正文 403）→ 说的是策略，不是「桶不存在」', async () => {
  const fake = await fakeSupaError('403', 'AccessDenied')
  try {
    const msg = await said(() => supaStore(fake.port).check())
    assert(/Policies|策略|权限/.test(msg), `★★ 没指向策略：${msg}`)
    assert(!/建一个同名的桶/.test(msg), `★★ 把「没权限」说成「桶不存在」，他会白跑一趟：${msg}`)
    assert(
      !/应用密码/.test(msg),
      `★★ 对着 Supabase 说 WebDAV 的「应用密码」—— 指错方向：${msg}`
    )
  } finally {
    fake.close()
  }
})

checkAsync('★ F-5 · 写和列目录也走同一条判断，不是只修了 check()', async () => {
  const fake = await fakeSupaError('404', 'NoSuchBucket')
  try {
    for (const [label, fn] of [
      ['put', () => supaStore(fake.port).put('nyx/chunks/a.json', '{}')],
      ['list', () => supaStore(fake.port).list('nyx/chunks')]
    ] as const) {
      const msg = await said(fn)
      assert(/建一个同名的桶/.test(msg), `★★ ${label}() 还是老样子：${msg}`)
    }
  } finally {
    fake.close()
  }
})

checkAsync('★ F-5 · 正文不是 JSON 时退回 HTTP 状态码，不许崩', async () => {
  const srv = fakeServer((_req, res) => res.writeHead(500).end('<html>502 bad gateway</html>'))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  try {
    const msg = await said(() => supaStore(port).check())
    assert(/500/.test(msg), `没把真实状态码说出来：${msg}`)
  } finally {
    srv.close()
  }
})

checkAsync('★★ R-4-C · 翻到一半那一页失败 → 整次报错，不许把半截当成全部', async () => {
  /**
   * 半截当全部是最坏的：调用方会以为「云端就这些」，
   * 于是把没见过的包当成不存在。所以中途失败必须整次抛，
   * 走 R-4-D 那条已有的通道（他在设置页和体检里看得见）。
   */
  let hits = 0
  const srv = fakeServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      hits += 1
      if (hits === 2) {
        res.writeHead(500).end('boom')
        return
      }
      const q = JSON.parse(body) as { offset?: number; limit?: number }
      const off = q.offset ?? 0
      const lim = q.limit ?? 100
      const all: { name: string }[] = []
      for (let i = 0; i < 1500; i++) all.push({ name: `dev-${String(i).padStart(6, '0')}.json` })
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(all.slice(off, off + lim)))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  try {
    let threw = false
    try {
      await supaStore(port).list('nyx/chunks')
    } catch {
      threw = true
    }
    assert(threw, '★★ 中间那一页失败了，却把前 1000 个当成了全部')
  } finally {
    srv.close()
  }
})

