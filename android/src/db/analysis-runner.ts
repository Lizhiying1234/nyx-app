/**
 * ══ 讲次批量分析 · 执行器（T-5.13 · D-R22）════════════════════════
 *
 * 一讲几十上百条，逐条点「分析」是不现实的。这里排一个队慢慢跑。
 *
 * ── 它**不是**第二份判据 ★★ ─────────────────────────────────
 *
 * 一条怎么分析，全在 `db/analyse.ts::analyseItem`（那一份又照 `core/analysis`
 * 的计划执行）。这里只回答三件平台上的事：
 *   ① **谁进队**   —— core 的 `NO_FULL_ANALYSIS`（「只有 summary 不算有解析」）
 *   ② **怎么排队** —— 并发 1、可取消、可续、失败分流
 *   ③ **状态存哪** —— 本机 `settings` 一条 JSON
 *
 * ── 三条设计决定，每条都有理由 ──────────────────────────────
 *
 * **① 模块单例，不挂组件。**
 *    挂在讲次页上的话，他切到 Atlas 再回来，组件重建 = 批次没了。
 *    「切页继续」这条要求只能靠一个不随页面生灭的东西来兑现。
 *
 * **② 状态存 `settings` 一条 JSON，不加表。**
 *    加表 = 结构迁移 = ARCHITECTURE LOCKED 第 6 条，为一个进度条不值得。
 *    `settings` 不进 `SYNC_TABLES` —— 批次进度是**这台机器此刻在做什么**，
 *    不是他的学习事实，不该跨设备跑。
 *
 * **③ 一批只在开头同步一趟。**
 *    单条那一版每次都同步（`analyseItem` 的默认），因为单条就一次。
 *    批量里每条都同步 = 一百趟网络，而窗口并没有因此变小多少 ——
 *    真撞上两端同时改，处置归 D-438，不靠同步频率去躲。
 *
 * ── 失败分流（`AiError.failure.kind`）───────────────────────
 *
 *   `offline` / `auth`   **整批停** —— 没网、key 不对，后面九十九条注定同样下场，
 *                        继续跑只是把同一个错误报一百遍
 *   `quota` / `server` / `format`  只记这一条，接着跑 —— 额度、服务端抖动、
 *                        某一条的模型输出不听话，都不代表下一条也不行
 *
 * ── 单执行者（`settings['analysis.lock']`）─────────────────────
 *
 * App 的 WebView 与无障碍服务的无头 WebView 是**两个 JS 上下文**，
 * 后台任务醒来时前台可能正跑着。两个一起跑会对同一条重复花钱调 AI。
 * 所以一把租约，形状照抄 `sync-runner.ts` 那一把 —— 但**不共用它**：
 * 同步与分析可以同时跑，共用会让两件不相干的事互相饿死。
 */
import { NO_FULL_ANALYSIS, AiError, type FailureKind } from '../core-link.ts'
import { analyseItem } from './analyse.ts'
import { syncFirstFor, type SyncFirst, type SyncNote } from './sync-first.ts'
import type { Db } from './types.ts'

// ── 键与常量 ─────────────────────────────────────────────────

/** 批次状态（本机，一条 JSON，不进 SYNC_TABLES） */
export const BATCH_KEY = 'analysis.batch'
/** 租约那一行（同上，只活在本机） */
export const ANALYSIS_LOCK_KEY = 'analysis.lock'

/**
 * 租约有效期。**必须长过任何一次「跑一段」的预算**，否则另一处会中途插进来。
 * 后台那一档的硬预算是 4 分钟（`AnalysisWorker.TIMEOUT_MS` 是 5 分钟，
 * 引擎自己留一分钟收尾），所以 6 分钟留得下余量 —— 与 `sync-runner` 同一个数。
 * ★ 代价说清楚：进程被杀在半路时这一行留到过期为止（最多 6 分钟），
 *   这段时间里另一处安静跳过。宁可少跑一段，也不要两处同时对一条花钱。
 */
export const ANALYSIS_LEASE_MS = 6 * 60 * 1000

/**
 * ★ **测试用的开关，生产路径永远是 `true`。**
 *   负向对照要把互斥拆掉证明「拆掉就红」—— 没有这个开关，那条对照
 *   只能靠复制一份旧代码来做，那才是真的危险（同 `sync-runner.ts::LEASE`）。
 */
export const ANALYSIS_LEASE = { on: true }

/** 前台跑一段的预算：足够跑掉几条，又不至于长时间占着租约不放 */
const FOREGROUND_BUDGET_MS = 60 * 1000

// ── 状态 ─────────────────────────────────────────────────────

export type BatchStatus = 'queued' | 'running' | 'done' | 'cancelled'

export interface BatchFailure {
  id: number
  /** 给他看的一句话（core 的话术，不在这里拼） */
  why: string
  /** 分流用的那个字段 —— 「重试失败的」时不看它，只是留个账 */
  kind?: FailureKind
}

export interface BatchState {
  lectureId: number
  /** 这一讲一共多少条（分母） */
  total: number
  /** 还没做的 —— 进程重启之后从这里接着跑 */
  queue: number[]
  /** 已经分析成功的条数 */
  done: number
  /** 本来就有完整解析、根本没进队的条数（不消耗 AI） */
  skipped: number
  failed: BatchFailure[]
  status: BatchStatus
  /** `cancelled` 时的原因（给他看的一句话） */
  cancelReason?: string
  startedAt: number
  updatedAt: number
}

/**
 * ★★ I-151（真机 2026-09-07）· **这一批现在能做哪几个动作。**
 *
 * 真机上「重试失败的」按钮**永远出不来**：整行动作被 `status !== 'done'` 罩着，
 * 而「跑完了但有几条没成」恰恰就是 `done` + `failed` 非空 —— 唯一想按它的那一刻，
 * 它正好不在。失败的那几条于是没有任何出路，只能重跑整讲。
 *
 * ★ 判据放在这里而不是模板里：模板上一句 `{#if}` 写错了没有任何东西会报，
 *   而它决定的是「他还能不能把这几条捞回来」。
 */
export interface BatchActions {
  /** 取消：只有真在跑的时候 */
  cancel: boolean
  /** 继续分析：还有排队的，而且此刻没在跑 */
  continue: boolean
  /** 重试失败的：**只看有没有失败的**，与 status 无关（I-151 的病根） */
  retry: boolean
}

export function batchActions(s: BatchState): BatchActions {
  return {
    cancel: s.status === 'running',
    continue: s.queue.length > 0 && s.status !== 'running',
    retry: s.failed.length > 0
  }
}

/**
 * 失败的那几条**为什么**没成 —— 给「为什么」一个去处（I-151 的另一半）。
 *
 * ★ 同样的一句话归成一行带条数：一批里十二条撞同一个原因是常态
 *   （额度用完、key 不对），逐条列十二遍只会把真正不同的那一条埋掉。
 * ★ 话术是 core 写进 `failed[].why` 的那一句，这里一个字都不重编。
 */
export function failureSummary(failed: readonly BatchFailure[]): string {
  if (failed.length === 0) return ''
  const byWhy = new Map<string, number>()
  for (const f of failed) byWhy.set(f.why, (byWhy.get(f.why) ?? 0) + 1)
  const parts = [...byWhy.entries()].map(([why, n]) => (n > 1 ? `${why}（${n} 条）` : why))
  return `${failed.length} 条没成：${parts.join('；')}`
}

// ── 读写状态 ─────────────────────────────────────────────────

export async function loadBatch(db: Db): Promise<BatchState | null> {
  try {
    const r = await db.get(`select value from settings where key = ?`, [BATCH_KEY])
    const v = r?.['value']
    if (!v) return null
    const s = JSON.parse(String(v)) as BatchState
    return Array.isArray(s?.queue) ? s : null
  } catch {
    // 坏了的状态不该让整个功能瘫掉 —— 当作没有批次（他可以重新点一次）
    return null
  }
}

async function saveBatch(db: Db, s: BatchState): Promise<void> {
  s.updatedAt = Date.now()
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [BATCH_KEY, JSON.stringify(s), s.updatedAt]
  )
  publish(s)
}

export async function clearBatch(db: Db): Promise<void> {
  await db.run(`delete from settings where key = ?`, [BATCH_KEY])
  publish(null)
}

// ── 界面订阅（执行器不挂组件，页面订阅它）──────────────────────

type Listener = (s: BatchState | null) => void
const listeners = new Set<Listener>()
let mirror: BatchState | null = null

function publish(s: BatchState | null): void {
  mirror = s
  for (const fn of listeners) {
    try {
      fn(s)
    } catch {
      /* 一个订阅者炸了不该拖垮批次 */
    }
  }
}

/** 订阅进度。返回退订函数。★ 立刻回调一次当前值 —— 页面不必自己先读一遍 */
export function onBatch(fn: Listener): () => void {
  listeners.add(fn)
  fn(mirror)
  return () => listeners.delete(fn)
}

/** 内存里的那一份（页面刚挂上时先拿它；权威仍是 settings） */
export function currentBatch(): BatchState | null {
  return mirror
}

// ── 租约 ─────────────────────────────────────────────────────

/** 这个 JS 上下文的身份 —— 与 sync-runner 同款：进程内唯一即可 */
const owner = `a${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

async function acquire(db: Db): Promise<boolean> {
  if (!ANALYSIS_LEASE.on) return true // ★ 只有负向对照会走到这里
  const now = Date.now()
  try {
    await db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update
            set value = excluded.value, updated_at = excluded.updated_at
          where settings.updated_at <= ?`,
      [ANALYSIS_LOCK_KEY, owner, now + ANALYSIS_LEASE_MS, now]
    )
    const r = await db.get(`select value from settings where key = ?`, [ANALYSIS_LOCK_KEY])
    return String(r?.['value'] ?? '') === owner
  } catch {
    // 写不进去（多半是另一处正握着写事务）—— 当作没抢到，方向是安全的那一边
    return false
  }
}

async function release(db: Db): Promise<void> {
  try {
    await db.run(`delete from settings where key = ? and value = ?`, [ANALYSIS_LOCK_KEY, owner])
  } catch {
    /* 还不回去就等它过期（最多 6 分钟）—— 不值得为此抛 */
  }
}

// ── 队列 ─────────────────────────────────────────────────────

/**
 * 这一讲里**还没写过完整解析**的条目。
 * ★ 判据是 core 的 `NO_FULL_ANALYSIS`，与 Windows 的待分析队列同一句 ——
 *   已有解析的根本不进队，所以一次 AI 都不会花在它们身上。
 */
export async function pendingIn(db: Db, lectureId: number): Promise<number[]> {
  return (
    await db.all(
      `select i.id from items i
         join item_lectures il on il.item_id = i.id and il.deleted_at is null
        where il.lecture_id = ? and i.deleted_at is null and ${NO_FULL_ANALYSIS('i')}
        order by i.id`,
      [lectureId]
    )
  ).map((r) => Number(r['id']))
}

async function totalIn(db: Db, lectureId: number): Promise<number> {
  const r = await db.get(
    `select count(*) as n from items i
       join item_lectures il on il.item_id = i.id and il.deleted_at is null
      where il.lecture_id = ? and i.deleted_at is null`,
    [lectureId]
  )
  return Number(r?.['n'] ?? 0)
}

// ── 跑 ───────────────────────────────────────────────────────

/** 批量里每条都不再单独同步 —— 一批只在开头同步一趟（见文件头③） */
const noSyncPerItem: SyncFirst = () =>
  Promise.resolve({ ran: false, note: '这一批开头已经同步过了', why: 'batch' })

/** 整批停的那两种 */
const FATAL: readonly FailureKind[] = ['offline', 'auth']

/** 并发 1 —— 同一个 JS 上下文里也只许一趟在跑 */
let running = false

export interface TickResult {
  ran: boolean
  /** 没跑的原因（`busy` = 租约在别处 · `idle` = 没有待办） */
  why?: 'busy' | 'idle' | 'locked-out'
  state: BatchState | null
}

/**
 * 跑一段，跑到预算用完或队列空为止。
 *
 * @param budgetMs 这一段最多花多久。前台一分钟，后台由 Worker 给（4 分钟）。
 *
 * ★ 预算是**开始下一条之前**判的：不打断正在跑的那一条 ——
 *   打断只会浪费掉已经花掉的那次 AI 调用，而它的写库是原子的。
 */
export async function tick(db: Db, budgetMs = FOREGROUND_BUDGET_MS): Promise<TickResult> {
  if (running) return { ran: false, why: 'busy', state: mirror }
  const s0 = await loadBatch(db)
  if (!s0 || s0.status === 'done' || s0.status === 'cancelled' || s0.queue.length === 0) {
    publish(s0)
    return { ran: false, why: 'idle', state: s0 }
  }
  if (!(await acquire(db))) {
    // 另一处（前台 / 后台）正跑着 —— 安静跳过，不是错
    publish(s0)
    return { ran: false, why: 'locked-out', state: s0 }
  }

  running = true
  const until = Date.now() + budgetMs
  const s = s0
  s.status = 'running'
  await saveBatch(db, s)
  try {
    while (s.queue.length > 0 && Date.now() < until) {
      if (cancelRequested) {
        s.status = 'cancelled'
        s.cancelReason = '你取消了'
        cancelRequested = false
        await saveBatch(db, s)
        return { ran: true, state: s }
      }
      const id = s.queue[0]!
      try {
        const r = await analyseItem(db, id, { force: false, syncFirst: noSyncPerItem })
        s.queue.shift()
        if (r.skipped) s.skipped += 1
        else s.done += 1
      } catch (e) {
        const kind = e instanceof AiError ? e.failure.kind : undefined
        const why =
          e instanceof AiError
            ? e.failure.detail?.trim()
              ? `${e.failure.title} —— ${e.failure.detail.trim()}`
              : e.failure.title
            : ((e as Error)?.message ?? String(e))
        if (kind && FATAL.includes(kind)) {
          /**
           * ★ 整批停：没网 / key 不对，后面每一条都是同一个下场。
           *   ★★ **队列不清空** —— 他修好之后「重试失败的」或者重新点一次
           *   就能接着跑。清空等于把他做到一半的活扔了。
           */
          s.status = 'cancelled'
          s.cancelReason = why
          await saveBatch(db, s)
          return { ran: true, state: s }
        }
        s.queue.shift()
        s.failed.push({ id, why, ...(kind ? { kind } : {}) })
      }
      await saveBatch(db, s)
    }
    if (s.queue.length === 0) s.status = 'done'
    await saveBatch(db, s)
    return { ran: true, state: s }
  } finally {
    running = false
    await release(db)
  }
}

let cancelRequested = false

/** 取消：下一条开始之前生效（不打断正在跑的那一条） */
export function cancelBatch(): void {
  cancelRequested = true
}

export interface StartOptions {
  /** 一批开头那一趟同步（注入点：② 层测试用假的） */
  syncFirst?: SyncFirst
  /** 起完之后就地跑一段（默认跑）—— 测试里可以关掉自己控制节奏 */
  run?: boolean
  budgetMs?: number
}

/**
 * 开一批。已经有未完的批次时**先把它覆盖掉** —— 他刚点的这一讲才是他要的。
 * @returns 这一批的初始状态（队列已排好，skipped 已经数出来）
 */
export async function startBatch(
  db: Db,
  lectureId: number,
  o: StartOptions = {}
): Promise<BatchState> {
  cancelRequested = false
  // ① 一批只在开头同步一趟
  let sync: SyncNote
  try {
    sync = await (o.syncFirst ?? defaultBatchSync)(db)
  } catch (e) {
    sync = { ran: false, note: `分析前同步没跑成：${(e as Error)?.message ?? e}`, why: 'error' }
  }
  // ② 队列 = core 判据说「还没写过完整解析」的那些
  const queue = await pendingIn(db, lectureId)
  const total = await totalIn(db, lectureId)
  const now = Date.now()
  const s: BatchState = {
    lectureId,
    total,
    queue,
    done: 0,
    // ★ 已有完整解析的从来不进队 —— 一次 AI 都不花在它们身上
    skipped: total - queue.length,
    failed: [],
    status: queue.length === 0 ? 'done' : 'queued',
    startedAt: now,
    updatedAt: now
  }
  if (!sync.ran) s.cancelReason = undefined // 同步没跑不是取消，别混进状态里
  await saveBatch(db, s)
  if (o.run !== false && queue.length > 0) await tick(db, o.budgetMs)
  return (await loadBatch(db)) ?? s
}

/**
 * 一批开头那一趟。★ 真实现在 `db/sync-first-native.ts`，只有 App 入口装它 ——
 * 理由与 `analyse.ts::defaultSyncFirst` 同一条（I-163：这个文件在引擎的
 * import 图上，`db/sync.ts` 会把 Capacitor 带进无桥的 WebView）。
 *
 * ★★ 引擎那一侧**根本走不到这里**：`startBatch` 全仓只有
 *   `ui/views/Lecture.svelte` 一个调用点，引擎只有 `resumeBatch`（下面 `tick`
 *   每条都传 `noSyncPerItem`）。这条边一直是死代码，白白把插件打进了引擎包。
 */
const defaultBatchSync: SyncFirst = syncFirstFor('批量分析前同步')

/**
 * 「重试失败的」—— 把失败项放回队列，清空失败账。
 * ★ 不重跑成功的那些：他要的是「把没成的补上」，不是重来一遍花两倍的钱。
 */
export async function retryFailed(db: Db, o: StartOptions = {}): Promise<BatchState | null> {
  const s = await loadBatch(db)
  if (!s || s.failed.length === 0) return s
  cancelRequested = false
  s.queue = [...s.failed.map((f) => f.id), ...s.queue]
  s.failed = []
  s.status = 'queued'
  delete s.cancelReason
  await saveBatch(db, s)
  if (o.run !== false) await tick(db, o.budgetMs)
  return loadBatch(db)
}

/**
 * 接着跑（进程被回收之后下次打开 / 后台任务醒来）。
 * ★ 没有未完批次就安静返回 —— 它会被无条件调用，不该在这里报错。
 */
export async function resumeBatch(db: Db, budgetMs?: number): Promise<TickResult> {
  return tick(db, budgetMs)
}

/** 这台机器上现在有没有没做完的批次 —— 后台任务要不要排，看它 */
export async function hasPending(db: Db): Promise<boolean> {
  const s = await loadBatch(db)
  return s !== null && s.queue.length > 0 && s.status !== 'cancelled' && s.status !== 'done'
}

/** ③ 档验收通道（同 nyxDb / nyxTts 的纪律：不看界面，看变量） */
;(globalThis as Record<string, unknown>)['nyxAnalysis'] = {
  state: currentBatch,
  load: loadBatch,
  start: startBatch,
  tick,
  retry: retryFailed,
  cancel: cancelBatch,
  pending: hasPending
}
