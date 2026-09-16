/**
 * 同步引擎 · Android 路径冒烟（S-1 ～ S-3）。
 *
 * 判据的重网在 Windows 仓库（db-safety 598 + smoke:sync + 对拍基线）——
 * 这里只钉「Android 这条 import 链真的能跑同一份引擎」：
 *   ① 纯 node:sqlite 适配器 + 内存 store 上，推/收/水位/记账成立
 *   ② 两库对拷：A 改名 → B 收到（④ 层判据的 ② 层缩影）
 *   ③ off 档的门：没配就抛人话
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACT_PENDING_KEY,
  decodeProblems,
  FINGERPRINT_ALGO,
  hardDelete,
  normalizeSchema,
  readSyncSurface,
  SYNC_PROBLEM_KEY,
  SyncEngine,
  type EnginePorts
} from '../src/core-link.ts'
import { builtDb, cleanup, seed, track, type Fixture } from './helpers.ts'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { NodeSqliteDb } from '../src/adapters/node-sqlite.ts'
import { AuditDb } from '../src/db/audit-db.ts'
import { editItem } from '../src/db/edit-item.ts'
import { LEASE, SYNC_LOCK_KEY, runAuto, runNow } from '../src/db/sync-runner.ts'
import type { Db } from '../src/db/types.ts'
import { encodeMeta } from '../src/core-link.ts'
import { fromBucketKeys, getSplashNames, toBucketKeys, writeSplashNames } from '../src/db/splash.ts'

after(cleanup)

const sha16 = async (text: string): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** 步进时钟 —— 三次 run 挤在同一毫秒会让包名同名互覆（真实世界是分钟级间隔） */
let tick = Date.now()
const nextTick = (): number => (tick += 1500)

function portsFor(db: Db): EnginePorts {
  return {
    db,
    identity: async () => {
      const normalized = normalizeSchema(await readSyncSurface(db))
      const v = Number((await db.get(`pragma user_version`))?.['user_version'] ?? 0)
      return { schemaVersion: v, schemaFingerprint: await sha16(normalized), normalized, algo: FINGERPRINT_ALGO }
    },
    backup: async () => {},
    audio: { list: async () => [], read: async () => null, write: async () => {} },
    secrets: {
      getSyncSecret: () => 's',
      setSyncSecret: () => {},
      hasSyncSecret: () => true
    },
    clock: { now: nextTick },
    uuid: () => crypto.randomUUID()
  }
}

function engineOf(f: Fixture): SyncEngine {
  return new SyncEngine(portsFor(f.db))
}

/**
 * ★ **第二个上下文** —— 同一个库文件上的第二个 `Db` 句柄。
 *
 * 手机上就是这个形状：App 的 WebView 与无障碍服务的无头 WebView 是两个
 * JS 上下文、两条连接、同一个 `nyx.db`。所以这里不做替身，开真的第二条。
 */
/**
 * ★ I-186 · 第二条连接交给 `helpers.track()` 记账，不再自己 `after` 关。
 *   原因是 `after` 按注册顺序跑：`after(cleanup)` 在文件头，会**先**删目录，
 *   那时这条连接还开着 —— Windows 上每跑一次漏 4 个临时目录（而空 catch 吞了证据）。
 */
function secondContext(f: Fixture): Db {
  const raw = track(new DatabaseSync(join(f.dir, 'nyx.db')))
  raw.exec('pragma foreign_keys = ON')
  return new AuditDb(new NodeSqliteDb(raw))
}

// 微型 dav（与 Windows smoke:sync 同手法）—— 引擎的 store 由 core::makeStore(config)
// 决定，所以给它一个真 http 端点比往 core 里塞替身诚实得多
import { createServer, type Server } from 'node:http'

let srv: Server | null = null
let port = 0
const files = new Map<string, string>()

async function davReady(): Promise<void> {
  if (srv) return
  await new Promise<void>((resolve) => {
    srv = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').replace(/\/+$/, ''))
      if (req.method === 'MKCOL') {
        const had = files.has(`dir:${path}`)
        files.set(`dir:${path}`, '')
        res.writeHead(had ? 405 : 201).end()
        return
      }
      if (req.method === 'PROPFIND') {
        const kids = [...files.keys()].filter(
          (k) => !k.startsWith('dir:') && k.startsWith(path ? `${path}/` : '')
        )
        res
          .writeHead(207, { 'content-type': 'application/xml' })
          .end(
            `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${kids
              .map((k) => `<D:response><D:href>/${k}</D:href></D:response>`)
              .join('')}</D:multistatus>`
          )
        return
      }
      if (req.method === 'GET') {
        const b = files.get(path)
        if (b === undefined) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200).end(b)
        return
      }
      if (req.method === 'PUT') {
        let body = ''
        req.on('data', (c) => (body += String(c)))
        req.on('end', () => {
          files.set(path, body)
          res.writeHead(201).end()
        })
        return
      }
      /**
       * ★ T-2.10 · DELETE 是压实的前提：`compact.ts` 动手之前先
       *   `probeDeletePermission`（PUT 一个探针 → DELETE 它 → GET 回来看还在不在），
       *   删不掉就**拒跑**而不是压。原来这个微 dav 一路落到 405，
       *   于是压实永远只会「拒」—— S-7 ①②③ 就验不到真正压实那条路。
       * ★ 桶名以 `nodel` 开头 = 这个「云端」**能写不能删**（403）。
       *   S-7 ④ 用它验「压实失败不改变同步结果」—— 不是替身，是一个
       *   真会拒绝删除的服务端，与他配了一把只读凭据时看到的是同一种失败。
       */
      if (req.method === 'DELETE') {
        if (path.startsWith('nodel')) {
          res.writeHead(403).end()
          return
        }
        files.delete(path)
        res.writeHead(204).end()
        return
      }
      res.writeHead(405).end()
    })
    srv.listen(0, '127.0.0.1', () => {
      port = (srv!.address() as { port: number }).port
      resolve()
    })
  })
}

after(() => srv?.close())

async function armed(f: Fixture, bucket: string): Promise<SyncEngine> {
  await davReady()
  const e = engineOf(f)
  await e.saveConfig({ kind: 'webdav', url: `http://127.0.0.1:${port}/${bucket}`, user: 'u', secret: 's' })
  return e
}

describe('S · 同步引擎（Android import 链）', () => {
  it('S-3 · 没配同步 → 一句人话的门', async () => {
    const f = builtDb()
    seed(f, { settings: {} }) // helpers 默认会灌一套 sync.* 假设置 —— 这里要干净的
    const e = engineOf(f)
    await assert.rejects(() => e.run(), /还没配同步/)
  })

  it('S-1 · 首推：本地行上云 · 水位前进 · 四桶自洽', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    const e = await armed(f, 's1')
    const r = await e.run()
    assert.ok(r.pushed > 0, `一行都没推：${r.lastNote}`)
    assert.equal(r.failed, 0)
    assert.equal(e.violations().length, 0, JSON.stringify(e.violations()))
    const chunk = [...files.keys()].find((k) => k.startsWith('s1/nyx/chunks/'))
    assert.ok(chunk, '云端没有变更包')
    const st = await e.status()
    assert.equal(st.pending, 0, '推完还有待推 —— 基状态没顶上去')
  })

  it('S-2 · 新设备首同步收下全部，随后 A 改名 → B 跟上（④ 判据的缩影）', async () => {
    const a = builtDb()
    seed(a, { settings: {} })
    const b = builtDb() // ★ 空的新设备 —— 手机第一次开同步就是这个样子

    const ea = await armed(a, 's2')
    const eb = await armed(b, 's2')
    await ea.run()
    const first = await eb.run()
    assert.equal(first.failed, 0, first.lastNote)
    const nItems = Number((await b.db.get(`select count(*) n from items`))?.['n'] ?? 0)
    assert.equal(nItems, 3, `首同步没把内容带下来（${first.lastNote}）`)

    await a.db.run(`update lectures set name = 'A 改的名字', updated_at = ? where uid = (select uid from lectures limit 1)`, [
      Date.now() + 500
    ])
    await ea.run()
    const rb = await eb.run()
    assert.equal(rb.failed, 0, rb.lastNote)
    const got = (await b.db.get(`select name from lectures limit 1`)) as { name: string }
    assert.equal(got.name, 'A 改的名字', `B 上没看到 A 的改名（${rb.lastNote}）`)
  })
})

describe('S-4 · 指纹哈希两条路一致', () => {
  it('纯 JS sha256 与 WebCrypto 算出同一个指纹前缀', async () => {
    const { sha256hex16 } = await import('../src/db/sync-ports.ts')
    // node 里 subtle 在 —— 对照对象是它自己的 subtle 结果
    const viaSubtle = async (t: string): Promise<string> => {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
    }
    const subtleBak = crypto.subtle
    for (const t of ['', 'abc', '夜历 Night Almanac · v35 表面', 'x'.repeat(200)]) {
      assert.equal(await sha256hex16(t), await viaSubtle(t))
      // 强制走纯实现那条路再比一次
      Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true })
      const pure = await sha256hex16(t)
      Object.defineProperty(crypto, 'subtle', { value: subtleBak, configurable: true })
      assert.equal(pure, await viaSubtle(t), `纯实现算错：${JSON.stringify(t.slice(0, 12))}`)
    }
  })
})

/**
 * S-5 · **同步单执行者**（T-2.1 · 审计 R-007）
 *
 * 手机上同一个 `nyx.db` 有两个 JS 上下文（App 的 WebView / 无障碍服务的无头
 * WebView）与三个触发点（前台 · 练完 · WorkManager）。这一组钉的是：
 *   ① 跨上下文同时触发 —— 只有一趟真的跑，桶里只长一个包
 *   ② 同一上下文里两次并发 —— 两趟都跑（不许丢掉他的冲突裁决），但仍只推一个包
 *   ③ **负向对照**：把互斥拆掉，① 立刻不成立
 */
const chunksIn = (bucket: string): string[] =>
  [...files.keys()].filter((k) => k.startsWith(`${bucket}/nyx/chunks/`))

describe('S-5 · 同步单执行者（跨上下文互斥）', () => {
  it('两个上下文同时触发 → 一趟跑、一趟跳过，桶里只有一个包', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await armed(f, 's5')
    const other = secondContext(f) // ★ 同一个库文件上的第二条连接 = 服务那侧

    const outs = await Promise.all([
      runAuto(f.db, portsFor, '切回前台自动同步'),
      runAuto(other, portsFor, '后台自动同步')
    ])

    const ran = outs.filter((r) => r.ran)
    const busy = outs.filter((r) => !r.ran && r.why === 'busy')
    assert.equal(ran.length, 1, `跑了 ${ran.length} 趟 —— 互斥没生效`)
    assert.equal(busy.length, 1, `没有一趟报 busy（${JSON.stringify(outs.map((o) => o.why))}）`)
    assert.ok(ran[0]!.pushed > 0, `真跑的那一趟一行都没推：${ran[0]!.note}`)
    assert.equal(chunksIn('s5').length, 1, `桶里 ${chunksIn('s5').length} 个包 —— 推了不止一趟`)

    // 跑完把租约还回去 —— 不还的话下一次触发会被自己挡住六分钟
    const lock = await f.db.get(`select value from settings where key = ?`, [SYNC_LOCK_KEY])
    assert.equal(lock, undefined, '同步跑完了租约还留在库里')
  })

  it('同一个上下文里两次并发触发 → 两趟都跑（裁决不丢），但只推一个包', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await armed(f, 's6')

    const outs = await Promise.all([
      runAuto(f.db, portsFor, '切回前台自动同步'),
      runAuto(f.db, portsFor, '练完自动上传')
    ])

    // ★ 同一个上下文里**不许**跳过：run(resolve) 带着他对冲突的裁决，
    //   跳过就是替他做决定。core 的队列把两趟排起来，第二趟已经没有行可推。
    assert.ok(
      outs.every((r) => r.ran),
      `同一个上下文里的第二趟被误判成跳过：${JSON.stringify(outs.map((o) => o.why))}`
    )
    assert.equal(chunksIn('s6').length, 1, `桶里 ${chunksIn('s6').length} 个包 —— 重复包又长出来了`)
    const lock = await f.db.get(`select value from settings where key = ?`, [SYNC_LOCK_KEY])
    assert.equal(lock, undefined, '两趟排完了租约还留在库里')
  })

  it('负向对照 · 把互斥拆掉 → 上面那条立刻不成立', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await armed(f, 'sneg')
    const other = secondContext(f)

    LEASE.on = false
    const outs = await Promise.allSettled([
      runAuto(f.db, portsFor, '切回前台自动同步'),
      runAuto(other, portsFor, '后台自动同步')
    ]).finally(() => {
      LEASE.on = true
    })

    const busy = outs.filter(
      (r) => r.status === 'fulfilled' && !r.value.ran && r.value.why === 'busy'
    )
    assert.equal(busy.length, 0, '互斥都拆了还有一趟报 busy —— 这条对照根本没在对照')

    // 拆掉之后两趟一起冲同一个库：要么都开跑（桶里多个包），要么当场撞库锁。
    // 两种都行，就是不许出现「一趟跑 · 一趟安静跳过」那个正常形状。
    const n = chunksIn('sneg').length
    const blew = outs.some((r) => r.status === 'rejected')
    assert.ok(
      n > 1 || blew,
      `拆掉互斥之后既没多推包（${n}）也没撞库锁 —— 那说明 S-5 那条证明不了什么`
    )
  })
})

/**
 * S-6 · **租约撞上库锁**（T-2.3 · 审计 R-012）
 *
 * S-5 钉的是「两处同时来，只许一处跑」。这一组钉的是它的**背面**：
 * 抢租约的那一句本身也是一次写，也会撞库锁 —— 而 `acquire()` 把任何写异常
 * 都当「没抢到」安静跳过（那个方向是对的，见 sync-runner 里的说明）。
 *
 * 于是**连接层肯等多久，直接决定一次瞬时锁会不会白白吃掉一趟自动同步**。
 * 手机上那三条连接原来一处都没写 busy_timeout，吃的是原生默认 2500 ms；
 * T-2.3 把三处都显式写下来了（15000 / 15000 / 2500，理由见各自文件与
 * `docs/nyx-system/android/ANDROID_ARCHITECTURE.md` 的三连接表）。
 *
 * ★ 这里能证到哪、证不到哪，说清楚：
 *   Node 这一侧是**单线程**的 —— B 在等的时候 A 没有机会提交，所以
 *   「等着等着对方放开了、于是这一趟真的跑成了」**在进程内证不出来**，
 *   那一条只能上真机（写进 T-2.3 的【未完成】）。
 *   这里证的是另外两件都能证的事：① 不等 → 当场跳过（就是那个病）；
 *   ② 肯等 → 真的等满了才放弃，而且那个值确实挂在这条连接上。
 */
describe('S-6 · 租约撞上库锁（等多久由连接层说了算）', () => {
  /** 让第一条连接握住写锁 = 手机上「另一处正在写」（同步批量写 / Assist 落库） */
  async function underLock(f: Fixture, run: () => Promise<void>): Promise<void> {
    await f.db.begin() // NodeSqliteDb 用的是 begin immediate —— 一开始就拿写锁
    try {
      await run()
    } finally {
      await f.db.rollback()
    }
  }

  it('负向对照 · 连接不等（busy_timeout = 0）→ 一次瞬时锁就白吃掉一趟自动同步', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await armed(f, 'bt0')
    const other = secondContext(f)
    await other.exec('pragma busy_timeout = 0')

    await underLock(f, async () => {
      const t0 = Date.now()
      const out = await runAuto(other, portsFor, '后台自动同步')
      const waited = Date.now() - t0
      // ★ 病的形状：没跑、没报错、理由是 busy —— 与「另一处真的在同步」长得一模一样
      assert.equal(out.ran, false, '库被别人锁着还是跑了一趟')
      assert.equal(out.why, 'busy', `没跑的原因是 ${out.why}，不是 busy`)
      assert.ok(waited < 250, `设了不等却等了 ${waited}ms —— pragma 没生效，下面那条就不是对照`)
    })
  })

  it('连接肯等（busy_timeout = 500）→ 同一个瞬时锁，先等满再放弃', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await armed(f, 'bt500')
    const other = secondContext(f)
    await other.exec('pragma busy_timeout = 500')

    // ★ 先确认这个值真的挂在这条连接上 —— 手机上三处用的就是这一招
    //   （设 pragma，再读回来对一下），「设了没生效」是这类改动最常见的静默失败
    const got = Number((await other.get(`pragma busy_timeout`))?.['timeout'] ?? -1)
    assert.equal(got, 500, `读回来的 busy_timeout 是 ${got} —— 设进去的那一句没生效`)

    await underLock(f, async () => {
      const t0 = Date.now()
      const out = await runAuto(other, portsFor, '后台自动同步')
      const waited = Date.now() - t0
      // 单线程里对方不可能中途提交，所以结局仍然是 busy —— 变的是**它等了多久才认输**
      assert.equal(out.why, 'busy', `没跑的原因是 ${out.why}，不是 busy`)
      assert.ok(waited >= 400, `只等了 ${waited}ms —— 连接层根本没在等，这条与上一条没区别`)
      assert.ok(waited < 3000, `等了 ${waited}ms —— 远超设定的 500ms，等的不是这个值`)
    })
  })
})

/**
 * S-7 · **压实触发点接线**（T-2.10 Android 半场 · D-R18 已裁 D）
 *
 * 判据一行都不在 Android：该不该压由 `core/sync/compact-trigger.ts::shouldCompact`
 * 说了算，怎么压由 `compact.ts`。这一组钉的只是**这一侧的接线**：
 *   ① 立过碑 → 下一趟同步末尾真的压了一次（`ops_log` 一行 `op='compact'`）
 *   ② 紧接着再跑一趟 → 还是那一行（一次且只一次）
 *   ③ 手动档 `runNow` 也接了线（不是只接了自动档）
 *   ④ 压实失败**不改变同步的结果** —— 与压实根本没触发的那一趟逐字段相同
 *
 * ★ 负向对照不写成开关：把 `sync-runner.ts` 里那两句 `compactIfNeeded()` 删掉再跑，
 *   ①③ 当场红。会话报告里带实测结果。
 *
 * ★ 桶里必须**至少两个包**压实才动手（`compact.ts`：只剩一份时收益为零、风险照旧），
 *   所以每条用例都先推两趟再说。
 */
describe('S-7 · 压实触发点接线（T-2.10 Android 半场）', () => {
  const compactRows = async (db: Db): Promise<Record<string, unknown>[]> =>
    db.all(`select id, title from ops_log where op = 'compact' order by id`)

  /** ★ `decodeProblems` 一条都没有时回的是 `null`（不是空数组）—— 这里抹平成数组 */
  const problemsOf = async (db: Db): Promise<{ what: string; message: string }[]> => {
    const r = await db.get(`select value from settings where key = ?`, [SYNC_PROBLEM_KEY])
    const p = decodeProblems(r?.['value'] == null ? null : String(r['value']))
    return (p?.problems ?? []).map((x) => ({ what: x.what, message: x.message }))
  }

  /** 推两趟 = 桶里两个包（第二趟靠改一行制造「有东西要推」） */
  async function twoPacks(f: Fixture, bucket: string): Promise<void> {
    await armed(f, bucket)
    await runAuto(f.db, portsFor, '第一趟')
    f.raw
      .prepare(`update items set gloss = ?, updated_at = ? where id = 1`)
      .run('压实前再动一下', Date.now() + 1)
    await runAuto(f.db, portsFor, '第二趟')
  }

  /**
   * 立碑走**真的那条路** —— `core/cascade.ts::hardDelete`（唯一的硬删入口，
   * 它在 `depth === 0 && writeTomb && 真删掉了行` 时就地记 `sync.compactPending`）。
   * 不直接写那个 settings 键：写键只能证明「键在就压」，证不到「彻底删除会立碑」。
   */
  async function purgeOne(f: Fixture, itemId: number): Promise<void> {
    await f.db.begin()
    try {
      await hardDelete(f.db, 'items', [itemId])
      await f.db.commit()
    } catch (e) {
      await f.db.rollback().catch(() => {})
      throw e
    }
    const pend = await f.db.get(`select value from settings where key = ?`, [COMPACT_PENDING_KEY])
    assert.ok(pend, 'hardDelete 没有立下待压实的碑 —— 后面几条就不是在验触发点了')
  }

  it('① 彻底删除立过碑 → 下一趟同步末尾压实一次，ops_log 恰好一行 compact', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await twoPacks(f, 'cp1')
    await purgeOne(f, 3)

    const out = await runAuto(f.db, portsFor, '立碑之后这一趟')
    assert.equal(out.ran, true, '这一趟同步本身要照常跑')

    const rows = await compactRows(f.db)
    assert.equal(rows.length, 1, `ops_log 里 compact 有 ${rows.length} 行 —— 期望恰好 1`)
    assert.match(String(rows[0]!['title']), /折了 \d+ 个变更包/, '账本记的是「做过什么」（D-458）')
    const pend = await f.db.get(`select value from settings where key = ?`, [COMPACT_PENDING_KEY])
    assert.equal(pend, undefined, '碑压完就该清掉（noteCompactTried），否则每趟都重来')
    assert.deepEqual(await problemsOf(f.db), [], '压成了就不该有问题留下')
  })

  it('② 紧接着再跑一趟（没有新碑、包数没到线）→ 还是那一行，一次且只一次', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await twoPacks(f, 'cp2')
    await purgeOne(f, 3)
    await runAuto(f.db, portsFor, '立碑之后这一趟')
    assert.equal((await compactRows(f.db)).length, 1, '前置：第一趟应当压了一次')

    await runAuto(f.db, portsFor, '紧接着再来一趟')
    const rows = await compactRows(f.db)
    assert.equal(rows.length, 1, `又压了一次（现在 ${rows.length} 行）—— 触发点没有「一次且只一次」`)
  })

  it('③ 手动档 runNow 同样接了线：立碑 → runNow → 一行', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    await twoPacks(f, 'cp3')
    await purgeOne(f, 3)

    const r = await runNow(f.db, portsFor, '手动同步')
    assert.ok(r, 'runNow 要照常返回引擎的结果')
    const rows = await compactRows(f.db)
    assert.equal(rows.length, 1, `手动档压了 ${rows.length} 次 —— 期望 1（接线漏了手动这一档？）`)
  })

  it('④ 压实失败不改变同步结果：能写不能删的云端 → ran/applied/pushed 与不压实时逐字段相同', async () => {
    /**
     * 对照组：**逐字相同的操作**（含那次彻底删除 —— 它会多出一行墓碑要推，
     * 少做一次两组就不可比了），只把碑擦掉，于是这一趟压实压根不触发。
     * 「不压实时」= 就是这一趟。
     */
    const ctrl = builtDb()
    seed(ctrl, { settings: {} })
    await twoPacks(ctrl, 'cp4ok')
    ctrl.raw.prepare(`update items set gloss = ?, updated_at = ? where id = 2`).run('x', Date.now() + 2)
    await purgeOne(ctrl, 3)
    ctrl.raw.prepare(`delete from settings where key = ?`).run(COMPACT_PENDING_KEY)
    const base = await runAuto(ctrl.db, portsFor, '对照：这一趟不压实')
    assert.equal((await compactRows(ctrl.db)).length, 0, '对照组不该压实')

    // 实验组：桶名以 nodel 开头 —— 这个云端能写不能删（微 dav 回 403）
    const f = builtDb()
    seed(f, { settings: {} })
    await twoPacks(f, 'nodel-cp4')
    f.raw.prepare(`update items set gloss = ?, updated_at = ? where id = 2`).run('x', Date.now() + 2)
    await purgeOne(f, 3)
    const out = await runAuto(f.db, portsFor, '实验：这一趟压实会失败')

    assert.deepEqual(
      { ran: out.ran, applied: out.applied, pushed: out.pushed },
      { ran: base.ran, applied: base.applied, pushed: base.pushed },
      '压实失败把同步结果带偏了 —— 这一句是这条用例的全部意义'
    )
    assert.equal(out.why, null, '同步本身没有被判成「没跑」')

    const rows = await compactRows(f.db)
    assert.equal(rows.length, 0, `压实没做成却记了 ${rows.length} 行账 —— 账本只记做过的事`)
    const probs = await problemsOf(f.db)
    assert.equal(probs.length, 1, `sync.problems 里有 ${probs.length} 条 —— 期望恰好 1`)
    assert.equal(probs[0]!.what, '云端压实', '问题要说清是哪一步坏的')
    assert.match(probs[0]!.message, /删/, `问题里没提删除：「${probs[0]!.message}」`)
  })
})

/**
 * S-8 · **手机改了词条之后，同步仍然成立**（T-5.14）
 *
 * 这一组住在这里而不是 `edit-item.test.ts`，是因为两台假端要的微 dav
 * 就在本文件里 —— 再抄一份服务端就是第二份 fixture。
 *
 * 钉两件：
 *   ① 改词条是**普通的行更新**：对面按**同一个 uid** 拿到新 term 与新摘句，
 *      不多出一条。uid 换了的话对面看见的是「删一条、来一条新的」。
 *   ② 两端同时改同一条 → 走既有的 D-438（新的定），被盖掉的那一版落 `ops_log`。
 *      **没有为「编辑」发明任何新的同步规则** —— 这正是要证的事。
 */
describe('S-8 · 手机改词条之后同步仍成立（T-5.14）', () => {
  const occ = (f: Fixture, itemId: number, quote: string): void => {
    const t = Date.now() - 60_000
    f.raw
      .prepare(
        `insert into occurrences (item_id, material_id, lecture_id, quote, created_at, updated_at)
         values (?, null, 1, ?, ?, ?)`
      )
      .run(itemId, quote, t, t)
  }
  const uidOf = async (db: Db, term: string): Promise<string> =>
    String((await db.get(`select uid from items where term = ?`, [term]))!['uid'])

  it('A 改 term → B 按同一个 uid 拿到新 term 与新摘句，条目数不变', async () => {
    const a = builtDb()
    seed(a, { settings: {} })
    occ(a, 1, 'I could not term-1 the whole thing.')
    const b = builtDb() // 空的新设备

    const ea = await armed(a, 't514sync')
    const eb = await armed(b, 't514sync')
    await ea.run()
    const first = await eb.run()
    assert.equal(first.failed, 0, first.lastNote)
    const uid = await uidOf(b.db, 'term-1')

    await editItem(a.db, 1, { term: 'term-one' })
    await ea.run()
    const rb = await eb.run()
    assert.equal(rb.failed, 0, rb.lastNote)

    const row = await b.db.get(`select id, term from items where uid = ?`, [uid])
    assert.ok(row, '★ 同一个 uid 在 B 上找不到了 —— 那就是「删一条、来一条新的」')
    assert.equal(String(row!['term']), 'term-one', `B 没看到 A 改的词条（${rb.lastNote}）`)
    assert.equal(
      Number((await b.db.get(`select count(*) as n from items`))!['n']),
      3,
      'B 上多出了条目 —— 编辑变成了新建'
    )
    const q = await b.db.get(`select quote from occurrences where item_id = ?`, [Number(row!['id'])])
    assert.equal(
      String(q!['quote']),
      'I could not term-one the whole thing.',
      '出处摘句没跟过来 —— M-012 在同步这一侧断了'
    )
  })

  it('A、B 同时改同一条 → 新的那一版定，被盖掉的落 ops_log（D-438，没有新规则）', async () => {
    const a = builtDb()
    seed(a, { settings: {} })
    const b = builtDb()
    const ea = await armed(a, 't514conf')
    const eb = await armed(b, 't514conf')
    await ea.run()
    await eb.run()
    const uid = await uidOf(a.db, 'term-1')
    const bid = Number((await b.db.get(`select id from items where uid = ?`, [uid]))!['id'])

    await editItem(a.db, 1, { term: 'A 改的' })
    await editItem(b.db, bid, { term: 'B 改的' })
    // ★ 把 B 那一版明确推成更新的一版 —— 同毫秒内谁新谁旧不该由运气决定
    await b.db.run(`update items set updated_at = ? where id = ?`, [Date.now() + 5000, bid])

    /**
     * ★ 冲突是在**哪一趟、哪一端**被判出来的，值得写清楚（这一条我一开始断言错了端）：
     *   · A 这一趟只是推自己的，桶里还没有 B 的包 —— 无冲突
     *   · **B 这一趟**：本地改过、同时拉到了 A 那一版 —— 两边都动过 = 冲突，
     *     `autoResolve` 按 `updated_at` 判 B 自己那版新，于是**盖掉 A 的**，落账在 B
     *   · A 再跑一趟时，A 早已把自己那版推上去（基线跟着前进），
     *     所以收 B 的那一版只是「远端比基线新」的普通应用，不再是冲突
     *   收敛的结果两端一致，落账落在**真正做出取舍的那一端**。
     */
    await ea.run() // A 推自己的
    await eb.run() // ★ 判据发生在这一趟：B 本地改过 + 拉到 A 那一版
    await ea.run() // A 收 B 的（对 A 来说是普通更新）

    for (const [who, db] of [
      ['A', a.db],
      ['B', b.db]
    ] as const) {
      const got = await db.get(`select term from items where uid = ?`, [uid])
      assert.equal(String(got!['term']), 'B 改的', `D-438 · ${who} 上该由 updated_at 新的那版定`)
    }

    const logged = await b.db.all(
      `select target, title from ops_log where op = 'sync-override' order by id`
    )
    assert.ok(
      logged.length > 0,
      '被盖掉的那一版没有落账 —— 他会以为自己那次修改从来没发生过'
    )
    assert.ok(
      logged.some((r) => String(r['target']) === 'items'),
      `落账的不是 items：${JSON.stringify(logged.map((r) => r['target']))}`
    )
  })

  /**
   * ★ T-5.15 · **保存之前那一趟同步，用两台真的假端验一次**（E-8）
   *
   * E-6 用注入的假同步证了「顺序对」，但假的证不了「那一趟真能把对面的新值取来」。
   * 这一条把 `syncFirst` 换成**真的跑一趟** —— 于是链子是完整的：
   *   A 改 term → A 推 → B 保存前那一趟拉到 → B 读到的旧值就是 A 的新值 → 留痕的 `was` 是它。
   *
   * ★ 住在这个文件而不是 `edit-item.test.ts`：两台假端要的微 dav 在这里，
   *   搬过去就得再抄一份服务端。同 S-8 的理由。
   */
  it('S-9 · A 改了 term 推上去 → B 保存前那一趟把新值取来（T-5.15）', async () => {
    const a = builtDb()
    seed(a, { settings: {} })
    const b = builtDb()
    const ea = await armed(a, 't515sync')
    const eb = await armed(b, 't515sync')
    await ea.run()
    await eb.run() // B 先拿到全量
    const uid = await uidOf(a.db, 'term-1')
    const bid = Number((await b.db.get(`select id from items where uid = ?`, [uid]))!['id'])

    // A 改了词条并推上去；B 这时**还不知道**
    await editItem(a.db, 1, { term: 'A 改过的词' }, { syncFirst: () => Promise.resolve({ ran: true, note: '' }) })
    await ea.run()
    assert.equal(
      String((await b.db.get(`select term from items where id = ?`, [bid]))!['term']),
      'term-1',
      '前置：B 这时手里还是旧的'
    )

    // ★ B 保存时那一趟走**真的同步** —— 它应当先把 A 的新值拉下来，再读旧值
    const r = await editItem(
      b.db,
      bid,
      { gloss: 'B 补的释义' },
      {
        syncFirst: async (db) => {
          const out = await runAuto(db, portsFor, '修改前同步')
          return { ran: out.ran, note: out.note, ...(out.ran ? {} : { why: out.why ?? 'skip' }) }
        }
      }
    )

    assert.equal(r.sync.ran, true, `保存前那一趟没跑成：${r.sync.note}`)
    assert.equal(
      String((await b.db.get(`select term from items where id = ?`, [bid]))!['term']),
      'A 改过的词',
      '★ B 保存前那一趟没把 A 的新值取来 —— 他就是在过时的正文上改'
    )
    const log = JSON.parse(
      String(
        (await b.db.get(
          `select content from analysis_blocks where item_id = ? and block = 'corrections'`,
          [bid]
        ))!['content']
      )
    ) as Record<string, unknown>[]
    /**
     * ★ 两笔，不是一笔 —— 这一点值得记下来：`corrections` 是**跟着条目走的账**，
     *   所以 A 改词条那一笔**也同步到了 B**（那正是留痕该有的样子：
     *   「这一条被谁在什么时候改成什么」两台都查得到）。B 自己那一笔追加在后面。
     */
    assert.equal(log.length, 2, `留痕 ${log.length} 笔 —— 期望「A 的 term 一笔 + B 的 gloss 一笔」`)
    assert.equal(log[0]!['field'], 'term', 'A 那一笔跟着同步过来了')
    assert.equal(log[0]!['should'], 'A 改过的词')
    assert.equal(log[1]!['field'], 'gloss', 'B 自己那一笔追加在后面')
    assert.equal(
      String((await b.db.get(`select gloss from items where id = ?`, [bid]))!['gloss']),
      'B 补的释义',
      '两边各改各的列，B 这一次照常存下'
    )
  })
})

/**
 * ══ S-9 · **第一趟同步就服从桶里的墓碑**（使用者 2026-09-14 裁「连桶一起删」）★★★ ══
 *
 * ── 这条钉的其实是顺序 ──────────────────────────────────────
 * core 的 `syncSplash` 是 **①先把名字/墓碑合完并当场执行删除 → ②推 → ③拉**。
 * 顺序一反（先推后删），**本地那份还在的那一端会把图重新推上桶、盖掉对面刚立的碑**
 * —— 而屏上什么都不会说。那正是这一整条要治的毛病（「删了又回来」）。
 *
 * ★ 「**第一趟**」是关键字：服从那一步读的是**这一趟刚合出来的结果**（含刚从桶里
 *   拉下来的 meta），不是本地存量。所以手机第一次同步（本地一条 meta 都没有）
 *   就该服从，不用等下一趟。写死成读本地存量的话，这条会红。
 *
 * ── 这条用真的哪一半、假的哪一半（别把它当成 core 的用例重写一遍）────
 * · `splashLabels` 用**这一端真的那份**（`toBucketKeys` / `fromBucketKeys` +
 *   `getSplashNames` / `writeSplashNames`）—— 那层键形转换（桶里是资源名、
 *   本机表带 `user:` 前缀）是**我自己写的**，最容易把不认识的字段抹掉。
 * · `splash` 的文件 IO 用假的：真那份走 Capacitor `Filesystem`，Node 里跑不起来。
 * ☞ 所以这条覆盖的是「**我这一端接得对不对**」，不是 core 的顺序对不对
 *   （那一条 core 自己有）。但指针往前挪、core 把顺序改坏了，这条也会红。
 */
describe('S-9 · 第一趟同步就服从桶里的墓碑', () => {
  const NAME = 'b142e4caf1d6c50d38b4408401892c79febfb8007988dee85d59150d3ab59089.webp'

  it('★ 桶里有碑、本机有图、本机一条 meta 都没有 → 这一趟图就该没', async () => {
    const f = builtDb()
    const bucket = 'sd'
    /** 本机图片库（假的文件 IO），以及被叫了几次 delete */
    const local = new Map<string, string>([[NAME, 'AAAA']])
    const deleted: string[] = []
    /** 桶里：一张碑（gone:true，时间很新，压得过本机的"没表态"） */
    files.set(
      `${bucket}/nyx/splash/${NAME}${'.meta.json'}`,
      encodeMeta({ label: '我那张图', at: Date.now(), gone: true })
    )

    const e = new SyncEngine({
      ...portsFor(f.db),
      splash: {
        list: async () => [...local.keys()],
        read: async (n: string) => local.get(n) ?? null,
        write: async (n: string, b: string) => void local.set(n, b),
        /** ★ 幂等 + 不抛，和真那份同一条规矩 */
        delete: async (n: string) => {
          deleted.push(n)
          local.delete(n)
        }
      },
      splashLabels: {
        read: async () => toBucketKeys(await getSplashNames(f.db)),
        write: async (m) => writeSplashNames(f.db, fromBucketKeys(m))
      }
    })
    await e.saveConfig({
      kind: 'webdav',
      url: `http://127.0.0.1:${port}/${bucket}`,
      user: 'u',
      secret: 's'
    })
    await e.run()

    assert.deepEqual(deleted, [NAME], '★★ 第一趟没服从那块碑 —— 多半是顺序反了，或者服从那一步读的是本地存量')
    assert.equal(local.has(NAME), false, '★ 本机那份还在')
    /** ★ 名字留着：他把同一张图加回来时还要用（`gone` 只是那条记录上的一个字段） */
    const names = toBucketKeys(await getSplashNames(f.db))
    assert.equal(names[NAME]?.label, '我那张图', '★ 图删了，名字不该跟着没')
    assert.equal(names[NAME]?.gone, true, '★★ 墓碑没穿过这一端的键形转换')
  })

  it('★ 没有碑的那种（老 meta，gone 缺失）→ 一个字都不许删', async () => {
    // ★ 负向的一半：**「取不到」不等于 false，更不等于 true**。
    //   要是哪天把「没表态」当成了碑，他所有的老图会在一趟同步里全没。
    const f = builtDb()
    const bucket = 'sd2'
    const local = new Map<string, string>([[NAME, 'AAAA']])
    const deleted: string[] = []
    files.set(
      `${bucket}/nyx/splash/${NAME}${'.meta.json'}`,
      encodeMeta({ label: '我那张图', at: Date.now() })
    )
    const e = new SyncEngine({
      ...portsFor(f.db),
      splash: {
        list: async () => [...local.keys()],
        read: async (n: string) => local.get(n) ?? null,
        write: async (n: string, b: string) => void local.set(n, b),
        delete: async (n: string) => {
          deleted.push(n)
          local.delete(n)
        }
      },
      splashLabels: {
        read: async () => toBucketKeys(await getSplashNames(f.db)),
        write: async (m) => writeSplashNames(f.db, fromBucketKeys(m))
      }
    })
    await e.saveConfig({
      kind: 'webdav',
      url: `http://127.0.0.1:${port}/${bucket}`,
      user: 'u',
      secret: 's'
    })
    await e.run()
    assert.deepEqual(deleted, [], '★★ 没表态被当成了碑 —— 他的老图会在一趟同步里全没')
    assert.equal(local.has(NAME), true, '★ 图不该被删')
  })

  /**
   * ★★★ S-9c · **复活**：他把同一张图加回来，碑要被压过去（`gone` 三态的第二档）
   *
   * ── 这条覆盖到什么、覆盖不到什么（说准，别让人以为它比实际强）──
   * 覆盖：**机制那一半** —— 桶里一块**更新的** `gone:false` 压过本机那块旧碑之后，
   *   拉那一步要放行，图要真的下来，本机那条记录要跟着变成 `gone:false`。
   * **覆盖不到**：跨端跨钟那一半。两边的 `at` 各来各的钟（电脑是 `markSplashBack`
   *   里的 `Date.now()`，手机是同步那一趟看到的桶里时间），偏移只有真跑才知道。
   *   ☞ 那一半要靠跨端那一步（电脑删 → 手机核 → 电脑加回来 → 两端核），等使用者在场。
   *
   * ★ 为什么值得单独钉：`gone:true` 两端各有用例罩着，**`false` 那一档原来一条都没有**。
   *   而它坏掉的样子是最难看的一种 —— 他把图加回来了，手机上永远不回来，
   *   而屏上什么都不说（拉那一步只是"跳过"，不报错）。
   */
  it('★★ S-9c · 桶里一块更新的 gone:false → 图要回来，本机那条也要跟着翻过来', async () => {
    const f = builtDb()
    const bucket = 'sd3'
    /** 本机：碑还在，图早被上一趟删掉了 */
    const local = new Map<string, string>()
    const deleted: string[] = []
    const OLD = Date.now() - 60_000
    await writeSplashNames(f.db, fromBucketKeys({ [NAME]: { label: '我那张图', at: OLD, gone: true } }))
    /** 桶里：图回来了，meta 是**更新的** gone:false */
    files.set(`${bucket}/nyx/splash/${NAME}.json`, JSON.stringify({ name: NAME, b64: 'AAAA' }))
    files.set(
      `${bucket}/nyx/splash/${NAME}${'.meta.json'}`,
      encodeMeta({ label: '我那张图', at: Date.now(), gone: false })
    )

    const e = new SyncEngine({
      ...portsFor(f.db),
      splash: {
        list: async () => [...local.keys()],
        read: async (n: string) => local.get(n) ?? null,
        write: async (n: string, b: string) => void local.set(n, b),
        delete: async (n: string) => {
          deleted.push(n)
          local.delete(n)
        }
      },
      splashLabels: {
        read: async () => toBucketKeys(await getSplashNames(f.db)),
        write: async (m) => writeSplashNames(f.db, fromBucketKeys(m))
      }
    })
    await e.saveConfig({
      kind: 'webdav',
      url: `http://127.0.0.1:${port}/${bucket}`,
      user: 'u',
      secret: 's'
    })
    await e.run()

    assert.deepEqual(deleted, [], '★★ 更新的 gone:false 没压过旧碑 —— 反倒又删了一次')
    assert.equal(local.get(NAME), 'AAAA', '★★ 图没回来（拉那一步多半还在拿旧碑跳过它）')
    const names = toBucketKeys(await getSplashNames(f.db))
    assert.equal(names[NAME]?.gone, false, '★ 本机那条还留着旧碑 —— 下一趟又会把它删掉')
    assert.equal(names[NAME]?.label, '我那张图', '★ 名字该原样留着')
  })
})
