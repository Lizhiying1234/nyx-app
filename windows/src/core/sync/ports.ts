/**
 * 同步引擎的**平台端口** · ★★ 阶段 3（2026-08-29）
 *
 * ── 这一层要解决什么 ────────────────────────────────────────
 *
 * `session.ts` 把「决定」搬进了 core，但「真的去做」那 2,200 行
 * （collect 的 SQL、写入、墓碑执行、四处记账）一直留在
 * `main/sync/index.ts` 里，绑死 better-sqlite3 与 node:fs ——
 * Android 要么写第二份（★★★ 禁），要么把它也搬进来。这里就是搬进来
 * 之后引擎向平台伸手要的**全部东西**：能不能跑在某个平台上，
 * 看这一个文件就够了。
 *
 * ★ 判据（谁先谁后、哪一行算失败、什么进 applied）**一个都不在端口里** ——
 *   端口只有 IO。读这个文件的人应该看不出同步协议长什么样。
 */

/** 一行结果 —— 列名到值 */
export type EngineRow = Record<string, unknown>

/**
 * 异步的 SQLite 能力 —— 和 Android 侧 `db/types.ts::Db` 同形。
 *
 * ★ 为什么是异步：`@capacitor-community/sqlite` 只有异步接口，
 *   而判据只能有一份 —— 所以把 PC 那一侧包成异步，不是反过来（同 D-275）。
 */
export interface EngineDb {
  run(sql: string, params?: readonly unknown[]): Promise<void>
  get(sql: string, params?: readonly unknown[]): Promise<EngineRow | undefined>
  all(sql: string, params?: readonly unknown[]): Promise<EngineRow[]>
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

/**
 * 本机的三样身份，包头里带的就是它。
 * （从 `main/db/fingerprint.ts` 搬来的类型 —— 规范化在
 * `core/schema-fingerprint.ts`，哈希留在平台，见那边头注。）
 */
export interface SchemaIdentity {
  schemaVersion: number
  schemaFingerprint: string
  /** 规范化之后的原文 —— 出问题时要能贴出来对，不然只有一个 hash 谁也查不了 */
  normalized: string
  algo: string
}

/** 密钥面 · D-220 —— Windows = safeStorage(DPAPI)，Android = Keystore。都可能是异步的 */
export interface SecretsPort {
  getSyncSecret(): Promise<string> | string
  setSyncSecret(plain: string): Promise<void> | void
  hasSyncSecret(): Promise<boolean> | boolean
}

/** 音频文件面 · D-244 —— 内容哈希命名的 mp3；引擎只认 base64 正文 */
export interface AudioPort {
  /** 本地已有哪些 `.mp3` 文件名（不含路径） */
  list(): Promise<string[]>
  /** 读一个，base64。没有返回 null */
  read(name: string): Promise<string | null>
  /** 写一个（base64 正文 → 落成文件） */
  write(name: string, b64: string): Promise<void>
}

/**
 * 资源文件面 —— 和 `AudioPort` **同一个形状，但是另一条流**。
 *
 * ★ 为什么不把两者合成一个通用的「资源端口」：
 *   合并要动 `AudioPort` 这个已经被 Android 直连的符号
 *   （`check:android-imports` 数着 235 个），而合并本身**不解决任何问题** ——
 *   两条流的名字判据不同（`.mp3` 内容哈希 vs 四种图片扩展名）、
 *   上限不同、失败话术不同。等第三种资源出现时再抽象（三次法则），
 *   今天抽象只是把两处清楚的代码换成一处含糊的。
 *
 * ★ 它是**可选的**（见 `EnginePorts.splash`）。
 *   ★★ **这条注释 2026-09-13 改过，因为它的理由过期了。**
 *   原来写的是「Android 那边产品取舍还没定（2026-09-09 对面会话原话：
 *   『我使用者没交办过这件事』）」—— 使用者 **2026-09-13 交办了**，
 *   手机那半也做了：分支 `ui/color-system` 上已经有 `db/splash.ts`、
 *   `db/splash-files.ts`、`ui/lib/Splash.svelte`，`sync-ports.ts` 里 `splash` 端口接上了。
 *   ★ 所以端口**仍然可选**，但理由换了：不是「他没交办」，
 *     而是**那一半还在分支上没合回 master**。合回之后两端都会给这个端口。
 *   ★★ 教训（我自己的）：拿「对面还没做」当论据之前，
 *     **别只看对方的 master 工作树** —— 活多半在分支上。
 *     我 2026-09-13 就是这么搜了一次，然后跟使用者说「那件事不成立」，被他当场纠正。
 */
import type { SplashLabel } from '../splash-names.ts'

export interface AssetPort {
  /** 本地已有哪些文件名（不含路径） */
  list(): Promise<string[]>
  /** 读一个，base64。没有返回 null */
  read(name: string): Promise<string | null>
  /** 写一个（base64 正文 → 落成文件）*/
  write(name: string, b64: string): Promise<void>
  /**
   * ══ 删一个（使用者 2026-09-14 裁「选 a：连桶一起删」）★★★ ═══════
   *
   * ★★ **这不是界面上那颗按钮，是「服从一次删除」。**
   *   引擎从桶里读到墓碑（`<name>.meta.json` 里 `gone: true`）之后叫它，
   *   把本机那一份也删掉。他在**哪一端**按的删除，另一端都走这条路。
   *   ——「谁发起」是界面的事，「怎么服从」是这个端口的事，两件事别混。
   *
   * ★ **文件本来就不在 = 成功**（幂等）。同步要能中途断、能重跑，
   *   「删一个已经没有的文件」必须是安全的，不然重跑一次自己就红了。
   *   （和 `RemoteStore.delete` 同一条规矩。）
   *
   * ★ 删不掉（占用 / 权限）**不要抛**：这一路抛出去会把整趟同步带停，
   *   而代价只是这一张图这一轮没删掉 —— 下一趟还会再试。
   */
  delete(name: string): Promise<void>
}

export interface EnginePorts {
  db: EngineDb
  /** 本机身份（pragma + 哈希）。一次同步里引擎只问一遍 */
  identity(): Promise<SchemaIdentity> | SchemaIdentity
  /** 动库之前的整库备份（同步是唯一一处「远端写进本地库」）。整趟只会被叫一次 */
  backup(reason: string): Promise<void> | void
  audio: AudioPort
  /**
   * 启动页图片资源（使用者 2026-09-09：「共享的是图片资源」）。
   *
   * ★★ **可选**：没给就整条流不跑，那一端既不传也不收。
   *   这不是「悄悄什么都不做」—— 不给端口的那一端本来就没有这个功能，
   *   而**给了端口的那一端照样把图传上桶**：等对面哪天接上，图已经在那儿了。
   *   （这也是为什么先做 Windows 半场是有意义的，而不是白做。）
   */
  splash?: AssetPort
  /**
   * 启动页图片的**名字**（使用者 2026-09-13）。
   *
   * ★★ **有意不塞进 `AssetPort`**：那三个方法的语义是「本机的那些文件」，
   *   而名字不是文件 —— 塞进去等于把一个不是文件的东西伪装成文件，
   *   下一个人会照着它再塞别的（这一条是 Nyx-UI-Android 提的，采纳）。
   * ★ 名字是**资源的属性**，两端一致；和「选了哪张」正好相反（那是各端自管的，D-480）。
   */
  splashLabels?: {
    read(): Promise<Record<string, SplashLabel>>
    write(map: Record<string, SplashLabel>): Promise<void>
  }
  secrets: SecretsPort
  clock: { now(): number }
  /** 生成设备编号用（8 位就够，引擎自己截） */
  uuid(): string
}
