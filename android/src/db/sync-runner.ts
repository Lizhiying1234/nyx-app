/**
 * ══ 同步的**唯一执行者**（T-2.1 · 审计 R-007）════════════════════
 *
 * ★★★ 这里是全仓**唯一一处** `new SyncEngine`。
 *   `db/sync.ts`（App 的 Capacitor 装配）与 `engine/main.ts`（无障碍服务
 *   无头 WebView 的原生装配）都只往这里递一份端口，不自己造引擎。
 *
 * ══ 病是什么（2026-09-04 之前）═══════════════════════════════
 *
 * 同一个 SQLite 文件上有三个触发点，各建各的引擎、各跑各的：
 *
 *   前台        `store.autoSync`（冷启动 / 切回前台）· SyncPanel 手点
 *   练完        `Practice.svelte::settle`
 *   后台        WorkManager → `SyncWorker` → 服务的无头 WebView
 *
 * core 的 `SyncEngine.run()` 里已经有一道闸（2026-09-02，桶里 57% 重复包
 * 就是它修的），但那道闸**只挡得住同一个引擎实例内的并发**。
 * App 的 WebView 与服务的 WebView 是**两个 JS 上下文**：
 * `engine/main.ts::syncOnce` 每次调用还现造一个引擎，所以
 *   ① 后台自己连着跑两次都不排队；
 *   ② 后台跑着的时候把 App 切到前台，两趟同时开跑 ——
 *      各自 `collectSince` 拿到**同一批还没标记的行**，各自推一个一样的包。
 *
 * ══ 药：单入口 + 互斥（两层，各管各的）════════════════════════
 *
 *   第一层 · **同一上下文** —— 引擎实例按 `Db` 缓存（下面的 `ctxOf`），
 *     于是一个上下文里的多次触发落到**同一个实例**上，
 *     由 core 已有的那道队列串起来（后来的排队，不并发）。
 *     ★ 排队而不是丢掉：`run(resolve)` 带着他对冲突的裁决，丢了就是替他做决定。
 *
 *   第二层 · **跨上下文** —— 库里一条**租约**（`settings['sync.lock']`）。
 *     两个 WebView 唯一真正共享的东西就是这个库文件，所以判据放在它身上：
 *       · 抢租约是**一条语句**（`insert … on conflict do update … where 到期了`），
 *         SQLite 的写锁保证它原子；写完读回来对一下 owner 就知道自己有没有抢到。
 *       · `settings` **不在 `SYNC_TABLES` 里**（见 `core/sync-tables.ts` 头注），
 *         所以这一行永远不会被推上云，也不会跨设备互锁。
 *       · 抢不到的一方**不跑**（自动档安静跳过、手动档等一会儿再抛人话），
 *         而不是排队 —— 跨上下文没法把结果交回给对方。
 *
 * ★ 为什么不是「只有无障碍服务能同步」：服务没开的时候前台也得能同步
 *   （而且 `SyncWorker` 用的是它自己 new 出来的 `AssistEngine`，本来就不依赖
 *    服务开没开）。唯一执行者 = **互斥 + 单入口**，不是「只有某一处能跑」。
 *
 * ★ 为什么不用原生（Java 静态锁）：两个 WebView 到原生的桥不是同一条
 *   （一边 Capacitor 插件、一边 `nyxHost`），要加两处；而且判据就会掉进
 *    平台层。租约在 TS 里只有一份，进程怎么切都成立。
 */
import { SyncEngine, type EngineRunResult, type EnginePorts, type Resolution } from '../core-link.ts'
import {
  FINGERPRINT_ALGO,
  normalizeSchema,
  readSyncSurface,
  type SchemaIdentity
} from '../core-link.ts'
import { sha256hex16 } from './sha256.ts'
import type { Db } from './types.ts'

/**
 * 租约那一行的键。★ `settings` 不进 `SYNC_TABLES`，它只活在本机。
 */
export const SYNC_LOCK_KEY = 'sync.lock'

/**
 * 租约有效期。**必须长过任何一趟真实同步**，否则另一处会中途插进来 ——
 * 那就退回没有互斥的那一天（桶里长出重复包，而且不报错）。
 *
 * 6 分钟的来历：后台那一档自己的硬超时是 5 分钟
 * （`SyncWorker.TIMEOUT_MS`，超了就 `Result.retry()` 并 `engine.destroy()`），
 * 所以后台一趟**不可能**超过 5 分钟；留一分钟余量。
 * 前台一趟是秒级，正常路径走 `finally` 立刻还租约，压根用不到期。
 *
 * ★ 代价说清楚：进程被系统杀在半路时，这一行会**留到过期为止**（最多 6 分钟）——
 *   这段时间里自动档安静跳过、手动档等 20 秒后说一句人话。
 *   宁可少同步一趟，也不要两趟同时推 —— 前者下一轮自己好，后者往桶里写垃圾。
 */
export const LEASE_MS = 6 * 60 * 1000

/** 手动档抢不到租约时最多等多久（他按了按钮，站着等一会儿比直接报错好） */
export const MANUAL_WAIT_MS = 20 * 1000
const POLL_MS = 400

/**
 * ★ **测试用的开关，生产路径永远是 `true`。**
 *   `tests/sync-engine.test.ts` 的负向对照要把互斥拆掉，证明「拆掉就红」——
 *   没有这个开关，那条对照只能靠复制一份旧代码来做，那才是真的危险。
 */
export const LEASE = { on: true }

/** 这一趟没跑的话，为什么 */
export type SyncSkipWhy =
  /** 还没配同步 */
  | 'off'
  /** 自动同步关着（只有自动档会看这个） */
  | 'auto-off'
  /** 另一处正在同步 —— 租约在别人手里 */
  | 'busy'

/** 自动档的结果。★ 三个自动触发点（前台 / 练完 / 后台）拿到的是同一个形状 */
export interface SyncOutcome {
  /** 这一趟真的跑了吗 */
  ran: boolean
  /** 没跑的原因；跑了就是 `null` */
  why: SyncSkipWhy | null
  /** 跑了才有；没跑是 `null` */
  result: EngineRunResult | null
  /** 便捷字段（没跑时是 0 / 一句人话）—— 调用方不必到处判空 */
  applied: number
  pushed: number
  note: string
}

const SKIP_NOTE: Record<SyncSkipWhy, string> = {
  off: '还没配同步',
  'auto-off': '自动同步关着',
  busy: '另一处正在同步 —— 这一趟跳过'
}

const skipped = (why: SyncSkipWhy): SyncOutcome => ({
  ran: false,
  why,
  result: null,
  applied: 0,
  pushed: 0,
  note: SKIP_NOTE[why]
})

// ── 两个上下文都要的两件小事（原来在两处各写了一份）──────────────

/**
 * 结构身份。★ 两处装配**必须算出同一个指纹**：差一位 = 每个包都被结构闸
 * 拒掉，而且**不丢数据所以没人发现**。所以实现只留这一份。
 */
export async function identityOf(db: Db): Promise<SchemaIdentity> {
  const normalized = normalizeSchema(await readSyncSurface(db))
  const v = Number((await db.get(`pragma user_version`))?.['user_version'] ?? 0)
  return {
    schemaVersion: v,
    schemaFingerprint: await sha256hex16(normalized),
    normalized,
    algo: FINGERPRINT_ALGO
  }
}

/**
 * v4 UUID。`randomUUID` 要安全上下文，而 `androidScheme: http` 下没有 ——
 * 有就用，没有就拿 `getRandomValues` 手搓。
 */
export function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ── 上下文（一个 Db = 一个 JS 上下文）────────────────────────────

interface Ctx {
  engine: SyncEngine
  /** 这个上下文的租约持有者编号 —— 谁拿着 `sync.lock` 就是谁的 */
  owner: string
  /** 当前有几趟在跑。`> 0` = 租约在本上下文手里 */
  held: number
}

/**
 * ★ 按 `Db` 缓存而不是一个全局单例：生产里一个上下文本来就只有一个 `Db`，
 *   而测试里「两个 WebView」正好就是**同一个库文件上的两个 `Db` 句柄**。
 *   键成 Db 之后，测试跑的是与真机同一条判据，不是仿的。
 */
const ctxs = new WeakMap<Db, Ctx>()

function ctxOf(db: Db, portsOf: (db: Db) => EnginePorts): Ctx {
  const hit = ctxs.get(db)
  if (hit) return hit
  const made: Ctx = { engine: new SyncEngine(portsOf(db)), owner: uuidV4(), held: 0 }
  ctxs.set(db, made)
  // ③ 档验收通道（同 globalThis.nyx 的纪律：不看界面，看变量）
  ;(globalThis as Record<string, unknown>)['nyxSync'] = made.engine
  return made
}

/** 拿引擎本身 —— 只读配置 / 状态 / 测连通用它，**跑同步不要用它**（要走下面两个入口） */
export function engineFor(db: Db, portsOf: (db: Db) => EnginePorts): SyncEngine {
  return ctxOf(db, portsOf).engine
}

// ── 租约 ────────────────────────────────────────────────────────

/**
 * 抢租约。抢到返回 `true`。
 *
 * ★ 一条语句就是一次原子的比较并交换：`where settings.updated_at <= ?`
 *   意思是「**到期了或者根本没有**才让你写」。SQLite 把它整条放在写锁里，
 *   两个连接同时来只有一个能改到那一行；写完读回来对 owner 就知道是谁。
 * ★ 这一行的 `updated_at` 存的是**到期时刻**，不是写入时刻 —— 因为要拿它做
 *   上面那个比较。`settings` 不进同步，这一行只活在本机，没有别人读它。
 */
async function acquire(db: Db, ctx: Ctx): Promise<boolean> {
  if (!LEASE.on) return true // ★ 只有负向对照会走到这里
  if (ctx.held > 0) {
    // 本上下文已经拿着 —— 后来的这一趟交给 core 的队列排，不再抢一次
    ctx.held += 1
    return true
  }
  const now = Date.now()
  try {
    await db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update
            set value = excluded.value, updated_at = excluded.updated_at
          where settings.updated_at <= ?`,
      [SYNC_LOCK_KEY, ctx.owner, now + LEASE_MS, now]
    )
    const r = await db.get(`select value from settings where key = ?`, [SYNC_LOCK_KEY])
    if (String(r?.['value'] ?? '') !== ctx.owner) return false
  } catch {
    // 连这一句都写不进去（多半是另一处正握着写事务）—— 当作没抢到。
    // 方向是安全的那一边：宁可这一趟不跑，也不要两趟一起推。
    return false
  }
  ctx.held = 1
  return true
}

/** 还租约。★ 只删自己那一张：过期后被别人接手了就不该由我来删 */
async function release(db: Db, ctx: Ctx): Promise<void> {
  if (!LEASE.on) return
  if (ctx.held > 1) {
    ctx.held -= 1
    return
  }
  ctx.held = 0
  try {
    await db.run(`delete from settings where key = ? and value = ?`, [SYNC_LOCK_KEY, ctx.owner])
  } catch {
    /* 还不掉就等它过期 —— 最多 LEASE_MS */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 抢租约，抢不到就等到 `waitMs` 用完 */
async function acquireWithin(db: Db, ctx: Ctx, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs
  for (;;) {
    if (await acquire(db, ctx)) return true
    if (Date.now() >= until) return false
    await sleep(POLL_MS)
  }
}

// ── 两个入口（全仓跑同步只有这两条路）──────────────────────────

/**
 * **手动档** —— 他按了按钮，或者带着他对冲突的裁决。
 *
 * 抢不到租约就等一会儿（`MANUAL_WAIT_MS`），还抢不到就抛一句人话：
 * 他按了按钮，绝不能装作跑过了。
 */
export async function runNow(
  db: Db,
  portsOf: (db: Db) => EnginePorts,
  what: string,
  resolve?: Resolution
): Promise<EngineRunResult> {
  const ctx = ctxOf(db, portsOf)
  if (!(await acquireWithin(db, ctx, MANUAL_WAIT_MS))) {
    throw new Error('另一处正在同步（后台任务或另一个窗口），等它跑完再来一次。')
  }
  try {
    const r = await ctx.engine.run(resolve, what)
    await ctx.engine.compactIfNeeded() // ★ T-2.10 · 见文件末那一段
    return r
  } finally {
    await release(db, ctx)
  }
}

/**
 * **自动档** —— 冷启动 / 切回前台 / 练完 / 后台周期任务。
 *
 * 不该跑就安静跳过（`ran: false`），不抛错、不留痕：这几条路没人看着屏幕，
 * 一次跳过不值得惊动他。真正的失败由引擎自己记进 `settings['sync.problems']`（R-4-D）。
 *
 * `gateAuto` = 先过「配了吗 / 自动同步开着吗」这道闸。★ 判据只认 core 的
 * `config()` 与 `auto()`，不在这一层重读 `settings`（以前后台那份自己读，
 * 默认值与 core 的还不一样）。
 */
export async function runAuto(
  db: Db,
  portsOf: (db: Db) => EnginePorts,
  what: string,
  o: { gateAuto?: boolean } = {}
): Promise<SyncOutcome> {
  const ctx = ctxOf(db, portsOf)
  if (o.gateAuto === true) {
    if ((await ctx.engine.config()).kind === 'off') return skipped('off')
    if (!(await ctx.engine.auto())) return skipped('auto-off')
  }
  if (!(await acquire(db, ctx))) return skipped('busy')
  try {
    const r = await ctx.engine.run(undefined, what)
    await ctx.engine.compactIfNeeded() // ★ T-2.10 · 见下面那一段
    return { ran: true, why: null, result: r, applied: r.applied, pushed: r.pushed, note: r.lastNote }
  } finally {
    await release(db, ctx)
  }
}

/**
 * ══ 为什么两个入口末尾各有一句 `compactIfNeeded()`（T-2.10 · D-R18 已裁 D）══
 *
 * ★★ **这一层只接线，一行判据都没有。** 该不该压、压到什么程度、超了怎么办，
 *    全在 `core/sync/compact-trigger.ts` 与 `compact.ts` —— 两端调的是同一个方法
 *    （Windows 在 `main/index.ts` 的两处 `run()` 之后，这里是 `runNow` / `runAuto`）。
 *
 * ── 为什么放在 `run()` **之后**，而不是引擎内部 ────────────────
 *
 * ① `compact.ts` 只折**本机已经吸收过**的包（折别人推的、本机还没应用过的
 *    = 对本机丢数据）。而刚跑完的那一趟正好把桶里能收的收进了 `applied`、
 *    把本机的改动推了上去 —— T-2.2 的资格闸**天然满足**，不必为压实另开一条拉取。
 *    包数也用 `run()` 列桶时看见的那个数，不再多发一次 PROPFIND。
 * ② **压实坏了绝不许改变这一趟同步的结果**：`r` 这时候已经算完了，
 *    下面那一行一个字段都动不到它。
 *
 * ── 为什么不包 try/catch ──────────────────────────────────
 *
 * `compactIfNeeded()` 的契约就是**绝不抛**（core 的用例守着这条）：
 * 它自己把问题落进 `settings['sync.problems']`（设置页同步区与数据体检那条
 * 既有通道），成了才往 `ops_log` 记一行 `op='compact'`。
 * 在这里再包一层 catch，等于给一个已经不抛的东西加第二道判据 —— 那正是
 * 「同一件事两份真相」的形状；真哪天它抛了，我也宁可当场炸出来而不是吞掉。
 *
 * ── 为什么在**租约里**（`release` 之前）────────────────────
 *
 * 压实读的是 `applied` 与桶里的包名，而另一处的 `run()` 会改这两样。
 * 租约（T-2.1）保证同一时刻手机上只有一个上下文在做这件事；
 * 放到 `release` 之后，App 前台与无障碍服务那两个 WebView 就可能一边压一边推。
 *
 * ★ 后台那一档（`SyncWorker`，5 分钟硬超时）**不需要改 Java**：它走的就是
 *   `runAuto`。被杀在「快照已写、老包没删完」中间也不丢数据 —— 快照是一个
 *   普通 chunk，老包留着只是重复（`decideRow` 判成 same），下一次压实再折一遍，
 *   幂等，代价只是多一趟。而租约 6 分钟长过那 5 分钟，这段时间里没有第二处会插进来。
 */
