import type { Database } from 'better-sqlite3'

/**
 * 本地结构的规范化与导出 · ★★ Step 4 / F-02 / D-289（2026-08-18）
 *
 * ── 两把尺子，量的是两件事，不许互相替代 ──────────────────────
 *
 * | | 量什么 | 谁在乎 | 变了怎么办 |
 * |---|---|---|---|
 * | **本地结构指纹** | 这台机器的库**完整**长什么样（含触发器正文、CHECK、WITHOUT ROWID） | 只有本机 | 加一条 migration |
 * | **同步表面指纹** | 跨设备协议要求两端一致的那一部分 | 两台设备 | 两端都得升上来 |
 *
 * 本文件管**前一把**。后一把在 `fingerprint.ts`，Step 1 就定下来了，这一轮一个字没动。
 *
 * ── 为什么本地这把要严到「连触发器正文都算」──────────────────
 *
 * 它的用途只有一个：证明**两条路造出来的库是同一个库**。
 *
 *     A：空库 → 重放 26 条 migration → v28
 *     B：空库 → 执行 schema/v28.sql   → v28
 *
 * 这两条必须逐字相同，否则 `schema/v28.sql` 就不是真相，只是一份**复制品** ——
 * 而复制品会漂，漂了之后 Android 照着它建出来的库和 Windows 就不是一回事了。
 * 所以这一把尺子要尽可能严：漏掉的每一样，都是将来两端可能悄悄不同的地方。
 *
 * 与之相对，**同步表面那把不算触发器正文**（D-269）——
 * 正文里装的是「uid 怎么算」这类语义，它变了由 `protocolVersion` 表达。
 * 两把尺子敏感度不同，是有意的。
 */

/** `sqlite_master` 里一条对象定义 */
interface MasterRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

/**
 * 把一段 DDL 规范化。
 *
 * 只抹掉**不改变语义**的差异：
 *   · 换行与连续空白 → 单个空格
 *   · 括号 / 逗号周围的空白
 *   · 行尾分号
 *   · SQL 行注释与块注释
 *
 * **不抹**大小写：`INTEGER` 和 `integer` 在 SQLite 里语义相同，
 * 但它们会让两份文件看起来不一样，而这一把尺子的用途正是「逐字相同」——
 * 宁可让 `schema/v28.sql` 老老实实照抄 migration 写出来的形状，
 * 也不要用一层「大小写不敏感」把真正的差异一起抹平。
 */
export function normalizeDdl(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .replace(/;+$/, '')
    .trim()
}

/** 一份库的完整本地结构，按类型和名字排好序 —— 顺序不该造成差异 */
export function localSchemaOf(db: Database): string {
  const rows = db
    .prepare(
      `select type, name, tbl_name, sql from sqlite_master
        where name not like 'sqlite_%' and sql is not null`
    )
    .all() as MasterRow[]

  const rank: Record<string, number> = { table: 0, index: 1, trigger: 2, view: 3 }
  return rows
    .map((r) => ({ ...r, norm: normalizeDdl(r.sql ?? '') }))
    .sort(
      (a, b) =>
        (rank[a.type] ?? 9) - (rank[b.type] ?? 9) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    )
    .map((r) => `${r.type} ${r.name}\n  ${r.norm}`)
    .join('\n')
}

/**
 * 导出成一份可以直接执行的 `schema/v28.sql`。
 *
 * ★ 原样导出 `sqlite_master.sql`（不规范化）—— 那是 SQLite 自己记下来的
 *   建表语句，执行它必然造出同一个结构。规范化只用在**比对**那一步。
 *
 * ★ 不导 `sqlite_sequence`：它是 AUTOINCREMENT 的运行时状态，不是结构。
 */
export function dumpSchemaSql(db: Database, version: number): string {
  const rows = db
    .prepare(
      `select type, name, tbl_name, sql from sqlite_master
        where name not like 'sqlite_%' and sql is not null`
    )
    .all() as MasterRow[]

  const rank: Record<string, number> = { table: 0, index: 1, trigger: 2, view: 3 }
  const sorted = [...rows].sort(
    (a, b) =>
      (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )

  const head = [
    `-- Nyx 本地数据库的目标结构 · v${version}`,
    `--`,
    `-- ★★ 这份文件是**生成的，不要手改**。`,
    `--    重新生成：npm run schema:dump`,
    `--`,
    `-- ── 它是什么 ────────────────────────────────────────────────`,
    `--`,
    `--   migrations.ts    老库 → v${version}        （升级路径，只增不删）`,
    `--   本文件            v${version} 应该长什么样  （目标定义，两端共用）`,
    `--`,
    `-- 两者由 \`npm run check:schema\` 互相验证：`,
    `--   空库 → 重放全部 migration      → 结构 A`,
    `--   空库 → 执行本文件              → 结构 B`,
    `--   A 与 B 必须逐字相同，同步表面指纹也必须相同。`,
    `--   不相同就说明本文件不是真相，只是一份漂了的复制品。`,
    `--`,
    `-- ── Android 怎么用 ──────────────────────────────────────────`,
    `--`,
    `-- 全新安装**不重放历史 migration**，直接执行这一份建到 v${version}。`,
    `-- 之后的结构变更（v${version + 1} 起）两端共用同一份 DDL。`,
    `-- 本地独有的表（Windows 的 dictionaries / analysis_jobs）可以不一样 ——`,
    `-- 同步兼容性只看**同步表面**，不看整库。`,
    ``,
    `pragma foreign_keys = ON;`,
    ``
  ].join('\n')

  const body = sorted.map((r) => `${(r.sql ?? '').trim()};`).join('\n\n')
  return `${head}${body}\n\npragma user_version = ${version};\n`
}
