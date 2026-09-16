import Database from 'better-sqlite3'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { makeBackup, pruneBackups } from './backup.ts'
import { MIGRATIONS, type Migration } from './migrations.ts'

export class MigrationFailed extends Error {
  constructor(
    message: string,
    readonly restoredFrom: string | null
  ) {
    super(message)
    this.name = 'MigrationFailed'
  }
}

/** 每张用户表的行数快照，用于 D-236 迁移自检。 */
type Counts = Record<string, number>

function tableNames(db: Database.Database): string[] {
  return db
    .prepare(
      `select name from sqlite_master
        where type='table' and name not like 'sqlite_%'
        order by name`
    )
    .all()
    .map((r) => (r as { name: string }).name)
}

function countRows(db: Database.Database): Counts {
  const out: Counts = {}
  for (const t of tableNames(db)) {
    const row = db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }
    out[t] = row.n
  }
  return out
}

/**
 * 迁移自检 · D-236
 *
 * 「升级后自动比对升级前后的条目数，对不上就回滚并报错，不允许静默通过。」
 * 判据是**任何一张原有的表都不许掉行**。只增不删的前提下，掉行只可能是出事了。
 */
function diffCounts(before: Counts, after: Counts, allowShrink: ReadonlySet<string>): string | null {
  const lost: string[] = []
  for (const [t, n] of Object.entries(before)) {
    const now = after[t]
    if (now === undefined) lost.push(`表 ${t} 整张不见了（原有 ${n} 行）`)
    else if (now < n && !allowShrink.has(t)) lost.push(`表 ${t} 少了 ${n - now} 行（${n} → ${now}）`)
  }
  return lost.length ? lost.join('；') : null
}

export interface OpenResult {
  db: Database.Database
  fromVersion: number
  toVersion: number
  migrated: boolean
  backupPath: string | null
}

/**
 * 打开数据库并把结构升到最新版。
 *
 * 顺序是刻意的：**先备份，再迁移，迁移后自检，自检不过就用备份把库整个换回去。**
 * 使用者零编程经验，数据静默丢了他发现不了 —— 所以宁可启动失败并报错，也不能带着
 * 一个可能已经损坏的库继续跑。
 */
export function openDatabase(
  dbPath: string,
  backupDir: string,
  /** 只为把迁移表换成一份可控的版本，好让「失败要回滚」这条路真的被测到。生产调用不传。 */
  migrations: Migration[] = MIGRATIONS
): OpenResult {
  const TARGET_VERSION = migrations.reduce((m, x) => Math.max(m, x.version), 0)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const fromVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0

  if (fromVersion >= TARGET_VERSION) {
    // 没有结构变更，做一次常规的启动备份（D-217）。
    let path: string | null = null
    try {
      path = makeBackup(db, backupDir, 'startup')
      pruneBackups(backupDir, 10)
    } catch {
      /* 备份失败不该挡住启动，但要在日志里看得见 */
    }
    return { db, fromVersion, toVersion: fromVersion, migrated: false, backupPath: path }
  }

  const before = countRows(db)
  const pending = migrations
    .filter((m) => m.version > fromVersion)
    .sort((a, b) => a.version - b.version)

  // ── 升级前自动备份（D-216 第 3 条）。备份不出来就不许升级。 ──
  let backupPath: string | null = null
  try {
    backupPath = makeBackup(db, backupDir, `pre-v${TARGET_VERSION}`)
  } catch (err) {
    db.close()
    throw new MigrationFailed(
      `升级前的自动备份失败，为安全起见没有继续升级：${err instanceof Error ? err.message : String(err)}`,
      null
    )
  }

  try {
    db.transaction(() => {
      for (const m of pending) {
        m.up(db)
        db.prepare(
          `insert into migration_log (from_version, to_version, name, ran_at, ok, updated_at)
           values (?, ?, ?, ?, 1, ?)`
        ).run(fromVersion, m.version, m.name, Date.now(), Date.now())
      }
    })()

    /**
     * ★★ Step 5A · 有的迁移**有意**让某张表少几行 —— V29 把偏好从
     * `settings` 搬进 `user_preferences`，搬完就该把旧键删掉（不删就是双真相）。
     *
     * 「掉行 = 出事」这条护栏不能因此拆掉，但它得允许**明写的例外**：
     * 迁移自己声明 `allowShrink`，而且必须自己验过「搬进去了才删」
     * （V29 逐键 select 回来确认过才 delete）。
     * 不声明的一律照旧 —— 默认仍然是「少一行就回滚」。
     */
    const allowShrink = new Set<string>(pending.flatMap((m) => m.allowShrink ?? []))
    const problem = diffCounts(before, countRows(db), allowShrink)
    if (problem) throw new Error(`迁移自检没通过：${problem}`)

    db.pragma(`user_version = ${TARGET_VERSION}`)
    pruneBackups(backupDir, 10)
    return { db, fromVersion, toVersion: TARGET_VERSION, migrated: true, backupPath }
  } catch (err) {
    // ── 回滚：事务已经撤销了结构变更，但仍然用备份把整个文件换回去，双保险。 ──
    db.close()
    let restored: string | null = null
    try {
      if (backupPath && existsSync(backupPath)) {
        for (const suffix of ['-wal', '-shm']) {
          if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix)
        }
        copyFileSync(backupPath, dbPath)
        restored = backupPath
      }
    } catch {
      /* 换不回去也要把原始错误报出去，别被二次错误盖掉 */
    }
    throw new MigrationFailed(
      `数据库从 v${fromVersion} 升级到 v${TARGET_VERSION} 失败：` +
        `${err instanceof Error ? err.message : String(err)}`,
      restored
    )
  }
}
