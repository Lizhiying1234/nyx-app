/**
 * 在手机上把库打开 —— **应用启动时唯一的入口。**
 *
 * ══ 顺序不能变 ═══════════════════════════════════════════════
 *
 *   ① 连上插件、打开库文件
 *   ② `upgrade()`  —— 空库建库 / 旧库重建 + 本地保全（B′ / D-297）
 *   ③ 交给上层用
 *
 * ★ 升级**全程不碰网络**。云端可不可达与能不能启动无关 ——
 *   这是 B′ 的核心原则，不是实现细节。
 *
 * ★ 判据一份都不在这里：`upgrade()` 是 `src/db/upgrade.ts` 那一份，
 *   PC 上跑的是同一份。这个文件只负责「把 adapter 接上」。
 */
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import { CapacitorDb } from '../adapters/capacitor.ts'
import { upgrade } from './upgrade.ts'
import { bindDevice } from './device-bind.ts'
import type { Db, UpgradeResult } from './types.ts'

/** 库名。`@capacitor-community/sqlite` 会自己加 `SQLite.db` 后缀 */
const DB_NAME = 'nyx'

/**
 * ══ 撞上库锁时等多久（T-2.3 · 审计 R-012）══════════════════════
 *
 * ★ 手机上**同一个 `nyx.db` 有三条连接**（三处装配各一条，表在
 *   `docs/nyx-system/android/ANDROID_ARCHITECTURE.md`）：
 *     ① 这一条 —— Capacitor 插件（App 的 WebView；同步引擎也跑在它上面）
 *     ② `AssistEngine.java` 的 `OPEN_READWRITE` 直连（无障碍服务）
 *     ③ `NyxAssistService.java::readConfig` 的 `OPEN_READONLY` 直连
 *
 * ★★ 而这个库**不是 WAL** —— 真机实测 `journal_mode = delete`
 *    （`tools/db-probe/results-v34/README.md`：OnePlus PJE110 · Android 16 ·
 *     插件 7.0.3）。非 WAL 意味着**写的时候读也被挡**：一处在写，另外两处
 *    连读都会撞 `SQLITE_BUSY`。三条连接不是理论上的并发。
 *
 * ══ 原来是多少 ═══════════════════════════════════════════════
 *
 * 三处**一个字都没写**，全靠原生默认 —— 那个默认是 **2500 ms**：
 * AOSP `frameworks/base/core/jni/android_database_SQLiteConnection.cpp`
 * 里 `static const int BUSY_TIMEOUT_MS = 2500;`，`nativeOpen` 时
 * `sqlite3_busy_timeout(db, BUSY_TIMEOUT_MS)`。插件走的
 * `net.zetetic.database.sqlcipher`（SQLCipher 4.10.0）是 AOSP 那套绑定的分支，
 * Java 层零 busy 设置，真机量到的正是 2500 —— 它沿用了同一个原生默认。
 *
 * ══ 为什么 2500 不够，为什么是 15 秒 ═════════════════════════
 *
 * 2500 ms 挡得住 Assist 那种毫秒级的小写入，挡不住**同步引擎自己那一批**：
 * 一次 `inTx` 里最多 `PACK_ROWS / PULL_ROWS = 5000` 行，在手机上是**秒级**的。
 * 而 `sync-runner.ts::acquire` 把任何写异常都当「没抢到租约」安静跳过 ——
 * 于是一次两秒半的瞬时锁，就能让这一趟自动同步白白跳掉，**而且不报错**。
 *
 * 15 秒的来历（上下都有界，不是拍的）：
 *   下界 —— 必须长过另一条连接可能握住的**最长一个写事务**（5000 行那一批）；
 *   上界 —— 必须远短于后台那一档自己的硬超时 5 分钟（`SyncWorker.TIMEOUT_MS`）
 *           与租约的 6 分钟（`LEASE_MS`），否则真死锁时是「一直转」而不是报错。
 *
 * ★ 等这 15 秒**不卡界面**：Capacitor 的插件调用跑在后台
 *   `HandlerThread("CapacitorPlugins")` 上（`Bridge.java` 的 `taskHandler`），
 *   不是 UI 线程。卡住的是这一条 SQL，不是屏幕。
 *
 * ★ 三条连接的值不一样，因为**线程**不一样 —— ③ 那条跑在无障碍服务的主线程上
 *   （`onServiceConnected` / `enterMode`），只能钉住 2500 不能跟着涨。
 */
export const BUSY_TIMEOUT_MS = 15_000

export interface OpenResult {
  db: Db
  upgrade: UpgradeResult
  /**
   * ★ F-009 · 「这份数据是从另一台设备恢复过来的，已经换了设备编号」——
   * 有话要说才非 null。开库那一层如实说出来，不静默（D-409）。
   */
  rebound: string | null
}

let opened: OpenResult | null = null

/**
 * 打开并升级。重复调用返回同一个 —— 应用生命周期里只该有一个连接。
 *
 * @param schemaSql 目标结构的原文（`schema/vNN.sql`），由调用方 fetch 进来。
 *                  ★ 一个字都不许在路上改。
 * @param targetVersion 目标版本号
 */
/**
 * ★★★ 开库之前**先确认有原生桥** —— 2026-08-26 真机撞了三次才想明白。
 *
 * ══ 现象 ══════════════════════════════════════════════════
 *
 * 在普通浏览器里打开这个应用（没有 Capacitor 壳），界面渲染出来之后
 * **整个卡死**：停在「读取中…」，Tab 点了没反应，30 秒也不动。
 *
 * ══ 我先走的那条弯路 ★★ ═══════════════════════════════════
 *
 * 第一反应是「加个超时，把无限等待变成一句话」。加了 8 秒 —— 没用；
 * 以为是没包住 `upgrade()`，改成包住整件事、放宽到 20 秒 —— **还是没用**。
 *
 * 直到点 Tab 发现**界面根本不响应**才明白：
 *
 *   **主线程被阻塞了，而 `setTimeout` 是排在主线程上的。**
 *   **一个被阻塞的线程，救不了它自己。**
 *
 * 超时能处理「对方不回答」，处理不了「我这边停了」。
 * 这两件事在界面上长得一模一样（都是「一直转」），但成因和解法完全不同。
 *
 * ══ 正确的做法：不去调它 ═════════════════════════════════
 *
 * `@capacitor-community/sqlite` 在没有原生实现时会走 web 兜底，
 * 而那条路会把主线程占住。所以判断放在**调用之前**，而且是**同步**的：
 * 没有原生平台就当场抛，一次插件调用都不发生。
 *
 * ★ 这样浏览器里打开会**立刻**说清楚，而不是假装在加载。
 */
function requireNativeBridge(): void {
  /**
   * ★ 看**全局**，不 import `@capacitor/core`。
   *   实测：把那个包 import 进来，在普通浏览器里会让整个 bundle 起不来
   *   （白屏，连界面都不渲染）——**比原来的卡死还难查**。
   *   Capacitor 注入的是一个全局对象，直接看它，零 import 风险。
   */
  const g = globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }
  if (g.Capacitor?.isNativePlatform?.() === true) return
  throw new Error(
    [
      '这里没有 Capacitor 原生桥，数据库打不开。',
      '★ 在普通浏览器里直接打开会这样 —— 界面看得到，数据看不到。',
      '要连真库，得跑在 Android 壳里（npx cap run android）。'
    ].join('\n')
  )
}

export async function openDb(schemaSql: string, targetVersion: number): Promise<OpenResult> {
  if (opened) return opened
  // ★ 同步判断，放在任何插件调用之前 —— 见上面那段
  requireNativeBridge()
  return doOpen(schemaSql, targetVersion)
}

async function doOpen(schemaSql: string, targetVersion: number): Promise<OpenResult> {
  const sqlite = new SQLiteConnection(CapacitorSQLite)

  /**
   * ★★ 失败过一次之后，原生侧的连接**还在**（进程不死它不消失）。
   *    不接手的话，下一次尝试永远撞 `Connection nyx already exists` ——
   *    2026-08-29 真机实测：真错误（`no such table: reading_cards`）
   *    被这句彻底盖住，看到的全是重试的尸体。
   */
  const existing = (await sqlite.isConnection(DB_NAME, false)).result === true
  const conn = existing
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
  if ((await conn.isDBOpen()).result !== true) await conn.open()

  const db = new CapacitorDb(conn)
  /**
   * ★ 顺序：**在 `upgrade()` 之前**。升级本身就是这个库上最长的一串写；
   *   等升级之后再设，第一次开库那一趟正好是没有保护的那一趟。
   * ★ 走 `get` 而不是 `run`：`pragma busy_timeout = N` 是**有回值**的语句，
   *   插件的 query 路径（`Database.java::selectSQL`）会 `while (moveToNext())`
   *   把游标读干净 —— 所以既执行得到，又能把生效值读回来。走 `run` 只是执行，
   *   读不回来，而「设了没生效」正是这类改动最容易静默失败的地方。
   */
  let busyTimeoutMs = -1
  try {
    await db.get(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`)
    busyTimeoutMs = Number((await db.get(`pragma busy_timeout`))?.['timeout'] ?? -1)
  } catch {
    // ★ 设不上只该**降级**（退回原生默认 2500），绝不能把开库整条打死 ——
    //   等待时长是优化，开库是本职。真相也不藏：下面那个数会留着 -1。
  }
  // ③ 档验收通道（同 nyxSync / nyxAi 的纪律：不看界面，看变量）。
  // 真机上 `nyxDb.busyTimeoutMs` 应当是 15000；`tools/db-probe` 报的是同一个数。
  // 是 -1 或 2500 就说明这一步没生效 —— 一眼看得出来，不用猜。
  // ★ 合并不覆盖：`db/dict.ts` 往同一个对象上挂 `dictIo`（T-5.10 的验收变量），
  //   两处谁先跑都不该把对方的字段抹掉。
  {
    const g = globalThis as Record<string, unknown>
    const cur = (g['nyxDb'] as Record<string, unknown> | undefined) ?? {}
    cur['busyTimeoutMs'] = busyTimeoutMs
    g['nyxDb'] = cur
  }
  try {
    const result = await upgrade(db, {
      targetVersion,
      schemaSql,
      now: Date.now()
    })
    /**
     * ★★ F-009 · 升级完、**同步开始之前**换号。
     *   编号是第一次同步时铸的，从备份恢复来的库里已经有一个旧机器的号；
     *   不在这里换掉，第一次同步就会用它推包 —— 两台同号，
     *   各自跳过对方的全部包，而且两边都显示「同步成功，收到 0 行」。
     *   这一步自己吞掉所有异常（见 device-bind.ts），不会把开库带崩。
     */
    const rebound = await bindDevice(db)
    opened = { db, upgrade: result, rebound }
    return opened
  } catch (e) {
    // ★ 升级失败就把原生连接收干净再抛 —— 让重试从头来、报真错误
    await sqlite.closeConnection(DB_NAME, false).catch(() => {})
    throw e
  }
}
