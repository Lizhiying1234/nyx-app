/**
 * Android 侧数据库的**能力接口** —— 平台层只需要提供这几样。
 *
 * ══ 这一层不许出现任何判据 ★★★ ═════════════════════════════
 *
 * D-275 那条线在这里同样成立：**升级判据、保全范围、恢复顺序、自检、
 * 失败语义只实现一份**（在 `preserve.ts` / `upgrade.ts` / `selfcheck.ts`），
 * adapter 只负责「怎么把一句 SQL 送进去、怎么把结果拿回来」。
 *
 * 换句话说：读这个文件的人应该看不出来 Nyx 是干什么的。
 */

/** 一行结果 —— 列名到值 */
export type Row = Record<string, unknown>

/**
 * 异步的 SQLite 能力。两个 adapter（node:sqlite / Capacitor 插件）各实现一份。
 *
 * ★ 为什么是异步：`@capacitor-community/sqlite` **只有异步接口**，
 *   而判据只能有一份 —— 所以把 PC 那一侧也写成异步，不是反过来。
 */
export interface Db {
  /** 无参、无返回。DDL 与 pragma 走这里 */
  exec(sql: string): Promise<void>
  /** 有参写入 */
  run(sql: string, params?: readonly unknown[]): Promise<void>
  /** 取一行 */
  get(sql: string, params?: readonly unknown[]): Promise<Row | undefined>
  /** 取多行 */
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>

  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** 升级器做了什么 */
export type UpgradeAction =
  /** 空库 → 直接按目标结构建库（D-297 第一节） */
  | 'bootstrap'
  /** 有数据的旧库 → 保全 + 重建 + 导回 */
  | 'rebuild'
  /** 已经是目标版本，什么都没做 */
  | 'noop'

/** 保全下来的东西各有多少 —— 自检拿它对账 */
export interface PreservedTally {
  /** 表名 → 行数 */
  rows: Record<string, number>
  /** 保全了几个 settings 键 */
  settings: number
}

export interface UpgradeResult {
  action: UpgradeAction
  fromVersion: number
  toVersion: number
  preserved: PreservedTally
  /**
   * 出厂内容（tutors / genres / qtypes / prompt_presets）重建之后是空的，
   * 要由应用启动时那一步幂等地重新播种（判据在 `core/builtin-identity.ts`）。
   * 升级器**不拥有播种数据**，所以只报告，不代劳。
   */
  builtinsPending: boolean
  /** 人话记录，出问题时给他看的 */
  notes: string[]
}

/** 升级失败 —— 抛这个，调用方能分辨「升级没做成」和「别的错」 */
export class UpgradeFailed extends Error {
  /** 失败发生在哪一步 */
  readonly step: string
  /** 旧库还在不在（B′ 的硬保证：永远该是 true） */
  readonly oldDbIntact: boolean

  constructor(message: string, step: string, oldDbIntact: boolean) {
    super(message)
    this.name = 'UpgradeFailed'
    this.step = step
    this.oldDbIntact = oldDbIntact
  }
}
