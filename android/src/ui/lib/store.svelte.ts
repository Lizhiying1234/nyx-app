/**
 * 应用状态 —— 库、树、当前在看哪一层。
 *
 * ★ 这一层**不含业务规则**：树怎么查在 `src/db/tree.ts`（照搬 Windows），
 *   升级怎么做在 `src/db/upgrade.ts`。这里只是把它们接到界面上，
 *   外加记住「现在展开了哪些、点进了哪一条」。
 */
import { openDb } from '../../db/open.ts'
import { snacks } from './snack.svelte.ts'
import { checkDataSafety } from '../../db/notify.ts'
import { runSyncAuto, syncEngine } from '../../db/sync.ts'
import { syncSplashMirror } from '../../db/splash.ts'
import { loadTodayPlan, type TodayPlan } from '../../db/today.ts'
import { applyCounts, loadTree, loadTreeCounts, type TreeProject } from '../../db/tree.ts'
import { SCHEMA_SQL, TARGET_VERSION } from '../../schema-link.ts'
import type { Db } from '../../db/types.ts'

/** 库还没打开 / 打开中 / 好了 / 失败了 —— 四态都要有界面，不能只处理顺利那条路 */
export type DbState =
  | { k: 'idle' }
  | { k: 'opening' }
  | { k: 'ok'; db: Db; note: string }
  | { k: 'error'; message: string }

export type TreeState =
  | { k: 'loading' }
  | { k: 'ok'; data: TreeProject[] }
  | { k: 'error'; message: string }

/**
 * Vault 首页要的几个数 —— **全是单句 SQL 直读，零判据**。
 *
 * ★ D-348 卫兵就写在类型里：这里**没有** silent 计数字段 ——
 *   「已静默总数」是宪法点名禁止的统计，取都不取。
 * ★ assist = 手机收进来的条数。v35 的 device 列在 review_logs/sessions 上，
 *   items 没有 —— 所以在 Capture 落地（阶段 6）之前它恒为 0，
 *   界面按「有才出现」隐藏专区，不造假数。
 */
export interface VaultStats {
  total: number
  hard: number
  redo: number
  trash: number
  assist: number
}

class Store {
  db = $state<DbState>({ k: 'idle' })
  tree = $state<TreeState>({ k: 'loading' })

  /**
   * 展开着的分组。
   *
   * ★ 键必须带上是哪一级（`p:1` / `u:1`）—— Windows 那边踩过：
   *   存裸 id 的话，项目 id 和单元 id 各自从 1 开始，
   *   展开一个项目会让某个毫不相干的单元跟着展开（I-079）。
   */
  open = $state<string[]>([])

  isOpen = (key: string): boolean => this.open.includes(key)

  toggle(key: string): void {
    this.open = this.isOpen(key) ? this.open.filter((k) => k !== key) : [...this.open, key]
  }

  async start(): Promise<void> {
    if (this.db.k === 'opening' || this.db.k === 'ok') return
    this.db = { k: 'opening' }
    try {
      const r = await openDb(SCHEMA_SQL, TARGET_VERSION)
      this.db = { k: 'ok', db: r.db, note: r.upgrade.notes.join(' · ') }
      await this.reload()
      /**
       * ★★ F-009 · 换过设备编号就说一句（从备份恢复到另一台机器）。
       *   不静默：它改变了这台机器在同步里的身份，而使用者有权知道
       *   为什么云端会多出一台设备（D-409 真实性）。
       */
      if (r.rebound) snacks.show(r.rebound)
      void this.refreshSyncFail()
      // 启动页那一帧读的是 localStorage 镜像（库还没开）—— 开好了校一次
      void syncSplashMirror(r.db)
      // D-347 · 打开 App 顺手同一次（Windows 先行已补：开机 + 30 分钟定时 + 练完；
      // 手机的对称面 = 打开时。同一把 auto 开关、同一份引擎判据）——
      // 之后再查数据安全（D-373）：查的就是这一次同步之后的新账。失败都静默，绝不挡开库
      void (async () => {
        await this.autoSync('打开自动同步')
        void this.refreshSyncFail()
        void checkDataSafety(r.db)
      })()
    } catch (e) {
      this.db = { k: 'error', message: (e as Error)?.message ?? String(e) }
      this.tree = { k: 'error', message: '库没打开' }
    }
  }

  /**
   * ★ 同步连败了几次（NT-Q2 · B4）—— 屏上那两级提示都读它：
   *     1–2 次 → 入口上一枚静态标记（Badge）
   *     ≥3 次  → 内容区顶部一条 Banner
   *   为什么分级：单次失败大多是网络抖，**不值得打断**；连败三次才是真出事了。
   *   ★ 数是 core 引擎自己数的（两端同一份），这里只读不算。
   *   ★ 读不到就当没事说 —— 它是提示，不该自己变成一个故障源。
   */
  syncFail = $state(0)

  async refreshSyncFail(): Promise<void> {
    if (this.db.k !== 'ok') return
    try {
      this.syncFail = (await syncEngine(this.db.db).status()).failStreak
    } catch {
      /* 读不出来就不说话 */
    }
  }

  /**
   * 上一次自动同步是什么时候（毫秒）—— 只在内存里，App 一关就没了。
   * ★ 它是**节流**，不是水位。水位在 core 里，别在这一层碰。
   */
  private lastAutoSyncAt = 0
  /** 切回 App 触发的自动同步，两次之间至少隔这么久 */
  static readonly AUTO_SYNC_THROTTLE_MS = 5 * 60 * 1000

  /**
   * 自动同步一次（冷启动 · 切回前台 · 将来的后台任务共用这一条）。
   *
   * ★★ 2026-09-01 · X-Ray 审计 F-003：在这之前手机**只有冷启动**会同步。
   *   于是「电脑上删了一个词，手机上什么时候消失」的答案是
   *   「下次你**冷启动** App 的时候」—— 而现代 Android 上 App 常年活在后台，
   *   点图标回来走的是 `resume`，压根不重跑 `start()`。实际延迟因此**没有上界**。
   *
   * ★ 节流是必要的：来回切 App 会把同步打成风暴（每次都要 list 整个 chunks 目录）。
   * ★ 失败一律静默 —— 引擎自己留痕（R-4-D），设置页同步区看得见。
   *   **绝不弹窗**：一次网络抖动不值得打断他（同 Windows `autoSyncNow`）。
   */
  async autoSync(what: string, opts: { throttle?: boolean } = {}): Promise<void> {
    if (this.db.k !== 'ok') return
    const now = Date.now()
    if (opts.throttle === true && now - this.lastAutoSyncAt < Store.AUTO_SYNC_THROTTLE_MS) return
    this.lastAutoSyncAt = now
    try {
      // ★ T-2.1 · 单入口：「配了吗 / 自动开着吗 / 另一处是不是正在跑」三道闸
      //   都在 runSyncAuto 里，与练完那条、后台那条同一份判据
      const run = await runSyncAuto(this.db.db, what, { gateAuto: true })
      if (run.applied > 0) await this.reload() // 云端拉下来新东西 —— 树和计数别显旧的
    } catch {
      /* 失败已由引擎留痕（R-4-D）——设置页同步区看得见 */
    }
  }

  vault = $state<VaultStats | null>(null)
  /** 今日排期（判据在 core/daily-match，喂数在 db/today）；null = 算不出来 */
  today = $state<TodayPlan | null>(null)

  async reload(): Promise<void> {
    if (this.db.k !== 'ok') return
    this.tree = { k: 'loading' }
    try {
      this.tree = { k: 'ok', data: await loadTree(this.db.db) }
    } catch (e) {
      this.tree = { k: 'error', message: (e as Error)?.message ?? String(e) }
    }
    await this.reloadCounts()
  }

  /** Vault 计数与今日排期。读挂了不挡树 —— 各自为政。 */
  async reloadCounts(): Promise<void> {
    if (this.db.k !== 'ok') return
    const db = this.db.db
    const n = async (sql: string): Promise<number> =>
      Number((await db.get(sql))?.['n'] ?? 0)
    try {
      this.vault = {
        total: await n(`select count(*) as n from items where deleted_at is null`),
        hard: await n(
          `select count(*) as n from items where deleted_at is null and production_state = 'hard'`
        ),
        redo: await n(
          `select count(*) as n from items where deleted_at is null and recollected_count > 0`
        ),
        // 回收站 = 四类对象各自的软删行（D-359 的那半）
        trash:
          (await n(`select count(*) as n from items where deleted_at is not null`)) +
          (await n(`select count(*) as n from lectures where deleted_at is not null`)) +
          (await n(`select count(*) as n from units where deleted_at is not null`)) +
          (await n(`select count(*) as n from projects where deleted_at is not null`)),
        // Assist 专区判据（D-400③ 改）：来源标记 = ops_log 的 capture 流水 ——
        // 默认保存位置可配之后，「落在 Inbox」不再等于「Assist 收的」
        assist: await n(
          `select count(distinct o.target_id) as n from ops_log o
             join items i on i.id = o.target_id
            where o.op = 'capture' and o.target = 'item' and i.deleted_at is null`
        )
      }
      // 今日排期跟着计数一起刷 —— 删除/静默会改 pending，别让 hero 显旧数
      this.today = await loadTodayPlan(db)
      /**
       * ★★ 树上那三个数也跟着刷（2026-09-03）。
       *
       * 删词条 / 加词条的路径绝大多数只调 `reloadCounts()`（ItemMenu、
       * Vault 的批量、讲次页的「加一个表达」都是），树是 `reload()` 才装的 ——
       * 于是 Atlas 上的条数停在上一次装树那一刻，「有时候对不上」就是这么来的。
       *
       * 这里只**盖数字**，不重装结构：不闪、不掉展开状态，三条 group by 而已。
       * 以后新长出来的写入点自动就是对的，不靠「记得再补一句 reload」。
       */
      if (this.tree.k === 'ok') applyCounts(this.tree.data, await loadTreeCounts(db))
    } catch {
      // 计数失败不值得吓人 —— Vault 界面对 null 有自己的说法
      this.vault = null
      this.today = null
    }
  }
}

export const store = new Store()

/**
 * ★ 真机调试通道要读得到它 —— `tools/device/eval.mjs` 读 `nyx.db.k`。
 *   真机上 console.log 不可用（logcat 限流 → loggingBehavior:"none"），
 *   第③档验收的纪律是「不看界面，看变量」（BUILD_PLAN 0.2）。
 *   这不是产品 API，业务代码不许从 globalThis 取它。
 */
;(globalThis as unknown as { nyx: Store }).nyx = store
