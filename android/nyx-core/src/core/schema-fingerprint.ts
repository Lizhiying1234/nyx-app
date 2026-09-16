import { SYNC_TABLES } from './sync-tables.ts'

/**
 * 同步表面的结构指纹 · ★★ Step 1A / D-269（2026-08-17）
 *
 * ── 它挡的是哪个洞 ──────────────────────────────────────────
 *
 * 收包时那段「列以本机为准」的过滤（`sync/index.ts`）是对的：跨版本同步里
 * 接收方决定自己有哪些列。但它**分不出两件事**：
 *
 *   · 对方是旧版本，多给了一列   → 丢掉是对的
 *   · 我是新平台，少建了一列     → 丢掉是**静默数据丢失**
 *
 * 两者在数据上长得一模一样。后者的表现是：四个数全对、零失败、体检不亮，
 * 而两端永远差那一列。这是这个项目最贵的失败形态（CLAUDE.md 第九节）。
 *
 * 所以在收包**之前**先比一次结构：不一致就整包拒绝，绝不逐行丢列。
 *
 * ── 为什么不 hash `sqlite_master.sql` 原文 ──────────────────
 *
 * 那是**建表时写下的文本**，不是结构本身。空白、换行、引号风格、注释、
 * 列的书写顺序都会让语义完全相同的两端算出不同的值 ——
 * 而 Android 那边的建表语句无论如何都不会和 `migrations.ts` 逐字一样。
 * 一把动不动就误报的尺子，用两次就没人信了。
 *
 * 所以指纹算的是**规范化之后的语义结构**：
 * 表名排序 → 每张表内列/外键/索引/触发器各自排序 → 只取跨平台必须一致的属性。
 *
 * ── 为什么触发器只算名字，不算正文 ★ ────────────────────────
 *
 * 使用者裁决（D-269）：**指纹只表达结构**。触发器正文里装的是「uid 怎么算」
 * 这类**语义**，它变了要由 `protocolVersion` 表达，不要混进结构指纹。
 * 少一条触发器是结构变化（名字没了，指纹变）；改一条触发器的正文是语义变化，
 * 走 `core/sync-protocol.ts` 那条线。两件事分开表达，将来才说得清。
 *
 * ── 为什么这里只做规范化、不做哈希 ──────────────────────────
 *
 * `core/` 要能原样搬到 Android（D-238）。哈希两端都有现成的
 * （Node 的 `node:crypto`、Android 的 `MessageDigest`），而**规范化没有现成的**，
 * 那才是必须共用的一份。所以这里输出一段确定性文本，哈希留给平台层
 * （Windows 侧在 `main/db/fingerprint.ts`）。同一段文本、同一个 sha256，
 * 两端必然得到同一个值。
 */

/** `pragma table_info` 的一行，去掉平台差异之后 */
export interface SchemaColumn {
  name: string
  /** 声明类型，原样（`INTEGER` / `TEXT` / `REAL` / `''`） */
  type: string
  notNull: boolean
  /** `dflt_value`。没有默认值是 `null` */
  dflt: string | null
  /** 主键里的位次，0 = 不是主键 */
  pk: number
}

/** `pragma foreign_key_list` 的一行 */
export interface SchemaFk {
  from: string
  parent: string
  to: string
  onDelete: string
  onUpdate: string
}

/** `pragma index_list` + `index_info` 的一条 */
export interface SchemaIndex {
  name: string
  columns: string[]
  unique: boolean
  /**
   * `c` = 显式 `create index` 建的
   * `u` = 表定义里 `unique` 推出来的
   * `pk` = 主键推出来的
   *
   * 后两种的**名字是自动生成的**（`sqlite_autoindex_x_1`），
   * 序号会随表里约束的个数漂移 —— 所以它们只算列集，不算名字。
   */
  origin: 'c' | 'u' | 'pk'
}

export interface SchemaTable {
  name: string
  columns: SchemaColumn[]
  fks: SchemaFk[]
  indexes: SchemaIndex[]
  /** 挂在这张表上的触发器**名字**（不含正文，见文件头） */
  triggers: string[]
}

/** 指纹用的哈希算法。两端必须一致 —— 写在这里是为了将来换算法时只有一处 */
export const FINGERPRINT_ALGO = 'sha256-16'

/**
 * 算指纹只需要这么点能力 —— better-sqlite3 / node:sqlite / 将来手机那边的驱动都满足。
 *
 * ★ 故意**不用** `db.pragma()`（那是 better-sqlite3 特有的糖）。
 *   指纹这种「两端必须算出同一个值」的东西，尤其不该绑死在某个驱动上。
 */
/**
 * ★ 阶段 3（2026-08-29）：读器改成**可等待**接口 —— `await` 对普通值同样
 * 成立，所以同步驱动（better-sqlite3 包一层）与异步驱动（Capacitor）走的
 * 是同一份实现，一行判据都不用抄第二遍。
 */
export interface ReadableDb {
  all(sql: string, params?: readonly unknown[]): Promise<unknown[]> | unknown[]
}

interface ColRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}
interface FkRow {
  from: string
  table: string
  to: string
  on_delete: string
  on_update: string
}
interface IdxRow {
  name: string
  unique: number
  origin: string
}

/** 读一张表的结构。表不存在就返回 `null`（老库可能还没建出来） */
async function readTable(db: ReadableDb, name: string): Promise<SchemaTable | null> {
  const columns = (await db.all(`pragma table_info("${name}")`)) as ColRow[]
  if (columns.length === 0) return null

  const fks = (await db.all(`pragma foreign_key_list("${name}")`)) as FkRow[]
  const idxList = (await db.all(`pragma index_list("${name}")`)) as IdxRow[]

  const indexes: SchemaIndex[] = []
  for (const i of idxList) {
    indexes.push({
      name: i.name,
      unique: i.unique !== 0,
      origin: (i.origin === 'c' || i.origin === 'u' || i.origin === 'pk' ? i.origin : 'c') as
        | 'c'
        | 'u'
        | 'pk',
      columns: ((await db.all(`pragma index_info("${i.name}")`)) as { name: string | null }[])
        // 表达式索引的列名是 null —— 用一个占位符，别让它变成空串和别的列混起来
        .map((x) => x.name ?? '(expr)')
    })
  }

  const triggers = (
    (await db.all(
      `select name from sqlite_master where type = 'trigger' and tbl_name = ? order by name`,
      [name]
    )) as { name: string }[]
  ).map((r) => r.name)

  return {
    name,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      notNull: c.notnull !== 0,
      dflt: c.dflt_value,
      pk: c.pk
    })),
    fks: fks.map((f) => ({
      from: f.from,
      parent: f.table,
      to: f.to,
      onDelete: f.on_delete,
      onUpdate: f.on_update
    })),
    indexes,
    triggers
  }
}

/**
 * 量出**同步表面**的结构 · ★★（2026-08-23 从 `main/db/fingerprint.ts` 搬来）
 *
 * 为什么搬：它只需要「能 prepare、能 all」，本来就没有任何平台味道，
 * 可原来住在 main 侧、而且 import 了 `migrations.ts`（Electron-only 依赖），
 * 于是**非 Electron 的运行时算不出指纹** —— 手机第一次同步就会被整包拒绝，
 * 而在此之前谁都看不出来。
 *
 * ★ 只量 `SYNC_TABLES`。全库不行：手机端本来就没有 `dictionaries` /
 *   `analysis_jobs`，把它们算进去会把「平台本来就不同」误判成结构不兼容。
 *
 * 留在平台那一侧的只剩两样：**哈希**（各平台都有现成的）和 `user_version`。
 */
export async function readSyncSurface(db: ReadableDb): Promise<SchemaTable[]> {
  const tables: SchemaTable[] = []
  for (const t of SYNC_TABLES) {
    const one = await readTable(db, t)
    if (one) tables.push(one)
  }
  return tables
}

/**
 * 默认值的规范化。
 *
 * SQLite 把 `dflt_value` 原样存的是**建表语句里写的那段文本**，
 * 所以 `default 'chunk'` 拿回来是带引号的 `'chunk'`。
 * 不同实现可能用双引号写同一个字面量，那是**同一个默认值**。
 * 统一成单引号，让「引号风格不同」不再是差异；
 * 但**保留「是不是字符串」这个区分** —— `'0'` 和 `0` 不是同一个默认值。
 */
function normDefault(v: string | null): string {
  if (v === null || v === undefined) return '-'
  const s = String(v).trim()
  if (s === '') return '-'
  if (/^null$/i.test(s)) return '-'
  const m = s.match(/^(['"])([\s\S]*)\1$/)
  if (m) {
    // 引号内成对的引号是转义，统一还原再用单引号包回去
    const inner = m[2]!.replace(new RegExp(m[1]! + m[1]!, 'g'), m[1]!)
    return `'${inner.replace(/'/g, "''")}'`
  }
  return s
}

/** 类型名的规范化：大小写与空白不算差异 */
const normType = (t: string): string => (t ?? '').toUpperCase().replace(/\s+/g, ' ').trim() || '-'

/** 外键动作：SQLite 不写就是 `NO ACTION`，两种写法是同一件事 */
const normAction = (a: string): string => (a ?? '').toUpperCase().replace(/\s+/g, ' ').trim() || 'NO ACTION'

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 把一批表规范化成一段确定性文本。
 *
 * **调用方负责只传同步表**（D-269：指纹只针对同步表面）。
 * 传全库的话，Android 本来就没有 `dictionaries` / `analysis_jobs`，
 * 会被误判成结构不兼容 —— 那是实测出来的（架构报告 §3 实测 ③）。
 *
 * 输出长这样，每张表五行：
 *
 * ```
 * T items
 * C attempts:INTEGER:1:0:0|card_due_at:INTEGER:0:-:0|…
 * F derived_from>items.id:NO ACTION:NO ACTION|…
 * X uid:U|…                       ← 表定义推出来的唯一约束，只有列集
 * I idx_items_term(term)|idx_items_uid(uid):U|…
 * G trg_items_uid
 * ```
 */
export function normalizeSchema(tables: readonly SchemaTable[]): string {
  const out: string[] = []
  for (const t of [...tables].sort((a, b) => byString(a.name, b.name))) {
    const cols = t.columns
      .map((c) => `${c.name}:${normType(c.type)}:${c.notNull ? 1 : 0}:${normDefault(c.dflt)}:${c.pk}`)
      .sort(byString)

    const fks = t.fks
      .map((f) => `${f.from}>${f.parent}.${f.to}:${normAction(f.onDelete)}:${normAction(f.onUpdate)}`)
      .sort(byString)

    /** 自动索引：名字是生成的，只算列集与唯一性 */
    const implicit = t.indexes
      .filter((i) => i.origin !== 'c')
      .map((i) => `${i.columns.join(',')}${i.unique ? ':U' : ''}`)
      .sort(byString)

    /** 显式索引：名字是我们自己起的，算进去 */
    const explicit = t.indexes
      .filter((i) => i.origin === 'c')
      .map((i) => `${i.name}(${i.columns.join(',')})${i.unique ? ':U' : ''}`)
      .sort(byString)

    const triggers = [...t.triggers].sort(byString)

    out.push(`T ${t.name}`)
    out.push(`C ${cols.join('|')}`)
    out.push(`F ${fks.join('|')}`)
    out.push(`X ${implicit.join('|')}`)
    out.push(`I ${explicit.join('|')}`)
    out.push(`G ${triggers.join('|')}`)
  }
  return out.join('\n')
}
