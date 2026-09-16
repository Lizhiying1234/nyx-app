/**
 * 讲次批量分析（B-1 ～ B-6 · T-5.13 / D-R22）
 *
 * ★★ 这一组盯的是**排队这件事的性质**，不是解析质量（那在 analyse.test.ts）：
 *   已有解析的一次 AI 都不许花 · 一条不成不停整批 · 没网/key 不对整批停 ·
 *   切页与进程重启之后接着跑 · 两个执行者撞上只有一个在跑。
 *
 * 每一条都可以这样读：**把它弄红的办法，就是把对应那道闸拆掉。**
 * AI = 本地 mock（OpenAI 形），可以按条切换成失败。
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { __setKeyProviderForTests } from '../src/db/ai.ts'
import {
  ANALYSIS_LEASE,
  ANALYSIS_LOCK_KEY,
  BATCH_KEY,
  cancelBatch,
  clearBatch,
  hasPending,
  loadBatch,
  pendingIn,
  resumeBatch,
  retryFailed,
  startBatch,
  tick
} from '../src/db/analysis-runner.ts'
import type { SyncFirst } from '../src/db/analyse.ts'
import { NodeSqliteDb } from '../src/adapters/node-sqlite.ts'
import { AuditDb } from '../src/db/audit-db.ts'
import type { Db } from '../src/db/types.ts'
import { builtDb, cleanup, type Fixture } from './helpers.ts'

after(cleanup)
__setKeyProviderForTests(() => Promise.resolve('mock-key'))

// ── 本地 mock AI ────────────────────────────────────────────────
/** 'ok' 全成 · 'server' 全 500 · 'auth' 全 401 · 'once-500' 第一条 500 其余成 */
type Mode = 'ok' | 'server' | 'auth' | 'once-500'
let mode: Mode = 'ok'
/** 真的被调了几次 —— 「已有解析的不花钱」靠它证明 */
let aiCalls = 0
let srv: Server | null = null
let port = 0

const BODY = { inSentence: 'm', chunks: ['c'], verbs: 'v' }

before(async () => {
  await new Promise<void>((resolve) => {
    srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += String(c)))
      req.on('end', () => {
        aiCalls += 1
        if (mode === 'auth') {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad key"}')
          return
        }
        if (mode === 'server' || (mode === 'once-500' && aiCalls === 1)) {
          res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}')
          return
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(BODY) } }] }))
      })
    })
    srv.listen(0, '127.0.0.1', () => {
      port = (srv!.address() as { port: number }).port
      resolve()
    })
  })
})
after(() => srv?.close())

const noSync: SyncFirst = () => Promise.resolve({ ran: true, note: '（测试里不真同步）' })

/**
 * 一讲 `n` 条，其中前 `analysed` 条已经有解析块。
 * ★ 「已有解析」用的是真的 `analysis_blocks` 行 —— 队列判据是 core 的
 *   `NO_FULL_ANALYSIS`，塞个假标记是骗不过它的。
 */
function lectureWith(n: number, analysed: number): Fixture {
  const f = builtDb()
  const t = Date.now()
  const q = (sql: string, ...p: unknown[]): void => {
    f.raw.prepare(sql).run(...(p as never[]))
  }
  q(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`, t, t)
  q(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`, t, t)
  q(
    `insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','review',?,?)`,
    t,
    t
  )
  for (let i = 1; i <= n; i++) {
    q(
      `insert into items (id,term,gloss,layer,kind,source,created_at,updated_at)
       values (?,?,'','A','chunk','self',?,?)`,
      i,
      `term-${i}`,
      t,
      t
    )
    q(`insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,1,?,?)`, i, t, t)
    if (i <= analysed) {
      q(
        `insert into analysis_blocks (item_id,block,content,regen_count,created_at,updated_at)
         values (?,'meaning','old',0,?,?)`,
        i,
        t,
        t
      )
    }
  }
  const set = f.raw.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('ai.light.baseUrl', `http://127.0.0.1:${port}/v1`, t)
  set.run('ai.light.model', 'mock', t)
  set.run('ai.light.protocol', 'openai', t)
  mode = 'ok'
  aiCalls = 0
  return f
}

const blocksCount = (f: Fixture, id: number): number =>
  (f.raw.prepare(`select count(*) as n from analysis_blocks where item_id = ?`).get(id) as { n: number }).n

describe('B · 讲次批量分析', () => {
  it('B-1 · 已有解析的**一次 AI 都不花**：10 条里 6 条有解析 → 只跑 4 条', async () => {
    const f = lectureWith(10, 6)
    assert.deepEqual(await pendingIn(f.db, 1), [7, 8, 9, 10], '队列判据 = core 的 NO_FULL_ANALYSIS')

    const s = await startBatch(f.db, 1, { syncFirst: noSync })
    assert.equal(s.status, 'done')
    assert.equal(s.total, 10)
    assert.equal(s.done, 4)
    assert.equal(s.skipped, 6, '本来就有解析的算跳过')
    assert.equal(s.failed.length, 0)
    assert.equal(
      aiCalls,
      4,
      '★★ 这条红了就是「跳过已有」被拆了 —— 那意味着他为已经有的解析重复付钱'
    )
    // 已有解析的那 6 条一个字没动
    assert.equal(
      (f.raw.prepare(`select content from analysis_blocks where item_id = 1`).get() as { content: string })
        .content,
      'old'
    )
    assert.equal(blocksCount(f, 7), 3, '新做的三块都在')
  })

  it('B-2 · 一条 server 失败不停整批；失败项记 why', async () => {
    const f = lectureWith(4, 0)
    mode = 'once-500'
    const s = await startBatch(f.db, 1, { syncFirst: noSync })
    assert.equal(s.status, 'done', '整批照样跑完')
    assert.equal(s.done, 3)
    assert.equal(s.failed.length, 1)
    assert.equal(s.failed[0]!.id, 1)
    assert.equal(s.failed[0]!.kind, 'server')
    assert.ok(s.failed[0]!.why.length > 0, '为什么没成，说得出来')
  })

  it('B-2b · offline / auth 立即停整批，**剩余队列还留着**', async () => {
    const f = lectureWith(5, 0)
    mode = 'auth'
    const s = await startBatch(f.db, 1, { syncFirst: noSync })
    assert.equal(s.status, 'cancelled')
    assert.ok(s.cancelReason && s.cancelReason.length > 0, '停下来的原因是一句人话')
    assert.equal(aiCalls, 1, '★ 认证不对，后面四条注定同样下场 —— 不该再花四次')
    assert.equal(s.queue.length, 5, '★★ 队列不清空：他修好 key 之后还能接着跑')
    assert.equal(s.done, 0)
  })

  it('B-3 · 切页不影响进度：执行器是模块单例，状态在 settings 里', async () => {
    const f = lectureWith(6, 0)
    // 只起批、不跑（模拟他点完就切走）
    const s0 = await startBatch(f.db, 1, { syncFirst: noSync, run: false })
    assert.equal(s0.queue.length, 6)
    assert.equal(s0.status, 'queued')

    // 「切回来」= 再读一次库；页面重建了，批次没有
    const s1 = await loadBatch(f.db)
    assert.deepEqual(s1?.queue, [1, 2, 3, 4, 5, 6])
    assert.equal(await hasPending(f.db), true)

    await tick(f.db)
    const s2 = await loadBatch(f.db)
    assert.equal(s2?.done, 6)
    assert.equal(await hasPending(f.db), false)
  })

  it('B-4 · 进程被回收之后接着跑：新执行者从 settings 里的队列续上', async () => {
    const f = lectureWith(5, 0)
    await startBatch(f.db, 1, { syncFirst: noSync, run: false })
    // 手工跑掉两条（模拟「上次跑到一半」）
    const half = (await loadBatch(f.db))!
    half.queue = [3, 4, 5]
    half.done = 2
    half.status = 'queued'
    f.raw
      .prepare(
        `insert into settings (key,value,updated_at) values (?,?,?)
           on conflict(key) do update set value = excluded.value`
      )
      .run(BATCH_KEY, JSON.stringify(half), Date.now())

    /**
     * ★ 「新进程」= 同一个库文件上的**第二条连接**（真机上就是这个形状：
     *   App 的 WebView 与服务的无头 WebView 是两个 JS 上下文）。
     */
    const raw = new DatabaseSync(join(f.dir, 'nyx.db'))
    raw.exec('pragma foreign_keys = ON')
    const db2: Db = new AuditDb(new NodeSqliteDb(raw))
    try {
      const r = await resumeBatch(db2)
      assert.equal(r.ran, true)
      const s = await loadBatch(db2)
      assert.equal(s?.status, 'done')
      assert.equal(s?.done, 5, '2 条旧的 + 3 条续上的')
      assert.equal(aiCalls, 3, '只跑剩下的三条')
    } finally {
      raw.close()
    }
  })

  it('B-5 · 租约：两个执行者同时起，只有一个在跑', async () => {
    const f = lectureWith(4, 0)
    await startBatch(f.db, 1, { syncFirst: noSync, run: false })

    const raw = new DatabaseSync(join(f.dir, 'nyx.db'))
    raw.exec('pragma foreign_keys = ON')
    const db2: Db = new AuditDb(new NodeSqliteDb(raw))
    try {
      // 手工占住租约（模拟另一处正跑着）
      f.raw
        .prepare(
          `insert into settings (key,value,updated_at) values (?,?,?)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(ANALYSIS_LOCK_KEY, 'someone-else', Date.now() + 60_000)

      const r = await tick(db2)
      assert.equal(r.ran, false)
      assert.equal(r.why, 'locked-out', '★ 这条红了就是租约被拆了 —— 两处会对同一条重复花钱')
      assert.equal(aiCalls, 0)

      // 租约过期之后就该轮到它
      f.raw
        .prepare(`update settings set updated_at = ? where key = ?`)
        .run(Date.now() - 1000, ANALYSIS_LOCK_KEY)
      const r2 = await tick(db2)
      assert.equal(r2.ran, true)
      assert.equal((await loadBatch(db2))?.done, 4)
    } finally {
      raw.close()
    }
  })

  it('B-6 · 「重试失败的」只重跑失败项，不重跑成功的', async () => {
    const f = lectureWith(4, 0)
    mode = 'once-500'
    const s = await startBatch(f.db, 1, { syncFirst: noSync })
    assert.equal(s.failed.length, 1)
    assert.equal(s.done, 3)

    mode = 'ok'
    aiCalls = 0
    const s2 = await retryFailed(f.db)
    assert.equal(s2?.failed.length, 0)
    assert.equal(s2?.done, 4, '补上的那一条算进 done')
    assert.equal(aiCalls, 1, '★ 只重跑没成的那一条 —— 重跑全部等于花两倍的钱')
  })

  it('B-7 · 取消：下一条开始之前生效，已经跑完的不回滚', async () => {
    const f = lectureWith(3, 0)
    await startBatch(f.db, 1, { syncFirst: noSync, run: false })
    cancelBatch()
    const r = await tick(f.db)
    assert.equal(r.state?.status, 'cancelled')
    assert.equal(r.state?.cancelReason, '你取消了')
    assert.equal(aiCalls, 0, '一条都还没开始，所以一次都没花')
    await clearBatch(f.db)
    assert.equal(await loadBatch(f.db), null)
  })
})

describe('B-8 · 负向对照的把手确实在（拆掉就红的那两处）', () => {
  it('租约开关拆掉 → 两个执行者都跑得起来', async () => {
    const f = lectureWith(2, 0)
    await startBatch(f.db, 1, { syncFirst: noSync, run: false })
    f.raw
      .prepare(
        `insert into settings (key,value,updated_at) values (?,?,?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(ANALYSIS_LOCK_KEY, 'someone-else', Date.now() + 60_000)

    ANALYSIS_LEASE.on = false
    try {
      const r = await tick(f.db)
      assert.equal(r.ran, true, '把 LEASE 关掉之后，租约在别人手里也照跑 —— 这就是负向对照要打的地方')
    } finally {
      ANALYSIS_LEASE.on = true
    }
  })
})
