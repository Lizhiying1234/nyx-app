/**
 * 测试脚手架 —— 只造环境，**不含任何判据**。
 *
 * 判据在 `src/db/*`，PC 与真机跑的是同一份。这里的东西一条都不许
 * 复制那边的规则，否则「两份判据」就从测试这一侧长出来了。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeSqliteDb } from '../src/adapters/node-sqlite.ts'
import { AuditDb } from '../src/db/audit-db.ts'
import type { Db, Row } from '../src/db/types.ts'
import { splitSql } from '../src/core-link.ts'

/** core 与 schema 的唯一来源 —— submodule nyx-core/（锁定 SHA，T-1.3），不是 Windows 工作树 */
export const REPO = fileURLToPath(new URL('../nyx-core/', import.meta.url)).replace(/[\\/]$/, '')

/** 目标版本 = `schema/` 里最大的那个 vNN */
export const TARGET_VERSION = Math.max(
  ...readdirSync(join(REPO, 'schema'))
    .map((f) => /^v(\d+)\.sql$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
)

export const SCHEMA_SQL = readFileSync(
  join(REPO, 'schema', `v${TARGET_VERSION}.sql`),
  'utf8'
)

const dirs: string[] = []
/** I-186 · 开过的库句柄 —— `cleanup()` 要先关掉再删目录（Windows 上不关就删不掉） */
const open: DatabaseSync[] = []

/**
 * 用例自己在夹具目录上开的**第二条连接**也交给这里记账。
 *
 * ★★ 为什么不让用例自己 `after` 关：`after` 按**注册顺序**跑。
 *   `after(cleanup)` 写在文件头，它会**先于**用例自己那个关连接的 after 执行 ——
 *   于是 `rmSync` 那一刻句柄还开着，Windows 上抛 EPERM。
 *   `tests/sync-engine.test.ts` 就是这个形状：它**确实**关了连接，
 *   但每跑一次仍然漏 4 个目录，而且以前那个空 catch 把证据也吞了。
 *   统一记账之后，先关全部、再删全部，顺序不再是判据的一部分。
 */
export function track<T extends DatabaseSync>(raw: T): T {
  open.push(raw)
  return raw
}

export interface Fixture {
  raw: DatabaseSync
  db: AuditDb
  dir: string
}

/** 一个空库 */
export function freshDb(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-and-'))
  dirs.push(dir)
  const raw = new DatabaseSync(join(dir, 'nyx.db'))
  open.push(raw)
  raw.exec('pragma foreign_keys = ON')
  return { raw, db: new AuditDb(new NodeSqliteDb(raw)), dir }
}

/** 一个**已经建好目标结构**的库（模拟「手机上已经在用的那个库」） */
export function builtDb(): Fixture {
  const f = freshDb()
  for (const s of splitSql(SCHEMA_SQL)) f.raw.exec(s)
  f.raw.exec(`pragma user_version = ${TARGET_VERSION}`)
  return f
}

export interface SeedOptions {
  items?: number
  logsPerItem?: number
  /** 有多少行「还没同步上去」—— 它们在 row_sync_state 里没有记录 */
  unsynced?: number
  settings?: Record<string, string>
}

/** 往库里播一份「手机上会有的数据」 */
export function seed(f: Fixture, o: SeedOptions = {}): void {
  const items = o.items ?? 3
  const logs = o.logsPerItem ?? 5
  const t = Date.now()
  const q = (sql: string, ...p: unknown[]): void => {
    f.raw.prepare(sql).run(...(p as never[]))
  }

  q(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`, t, t)
  q(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`, t, t)
  q(
    `insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','review',?,?)`,
    t,
    t
  )
  for (let i = 1; i <= items; i++) {
    q(
      `insert into items (id,term,gloss,layer,kind,source,created_at,updated_at)
       values (?,?,'g','B','chunk','self',?,?)`,
      i,
      `term-${i}`,
      t,
      t
    )
    q(`insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,1,?,?)`, i, t, t)
    // 认读卡由触发器建出来 —— 这里把它改成「练过的样子」
    q(
      `update reading_cards set ease = ?, interval_days = ?, reps = ?, lapses = ?,
              due_at = ?, silent = 0, updated_at = ? where item_id = ?`,
      2.4 + i * 0.05,
      i * 2,
      i,
      i % 2,
      t + i * 86400000,
      t + i * 1000,
      i
    )
    for (let k = 0; k < logs; k++) {
      q(
        `insert into review_logs (item_id,line,grade,interval_before,interval_after,ease_after,duration_ms,created_at,updated_at)
         values (?,'reading',3,?,?,2.5,1200,?,?)`,
        i,
        k,
        k + 1,
        t + k,
        t + k
      )
    }
  }

  const st = o.settings ?? {
    'sync.kind': 'webdav',
    'sync.url': 'https://unreachable.invalid/nyx',
    'sync.user': 'me',
    'sync.auto': '1',
    'sync.secret': 'ENCRYPTED-BLOB',
    'sync.device': 'devA1234',
    'sync.wipedAt': String(t - 1000),
    'sync.watermark': String(t - 500),
    'sync.applied': '["a.json","b.json"]'
  }
  for (const [k, v] of Object.entries(st)) {
    q(
      `insert into settings (key,value,updated_at) values (?,?,?)
         on conflict(key) do update set value = excluded.value`,
      k,
      v,
      t
    )
  }

  // 让一部分行「已经同步过」，其余的是未同步 —— 升级后它们都该回到待推
  const synced = Math.max(0, items * logs - (o.unsynced ?? items * logs))
  const rows = f.raw
    .prepare(`select uid, updated_at from review_logs order by id limit ?`)
    .all(synced) as { uid: string; updated_at: number }[]
  for (const r of rows) {
    q(
      `insert into row_sync_state (table_name,uid,synced_updated_at,pushed_updated_at,updated_at)
       values ('review_logs',?,?,?,?)`,
      r.uid,
      r.updated_at,
      r.updated_at,
      t
    )
  }
}

/** 整库的一份「逐项快照」—— 用来断言「旧库原样」 */
export function snapshot(f: Fixture): string {
  const one = (sql: string): unknown => (f.raw.prepare(sql).get() as Row | undefined) ?? null
  const tables = (
    f.raw
      .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name`)
      .all() as { name: string }[]
  ).map((r) => r.name)
  const counts = tables.map((t) => {
    const n = (f.raw.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
    return `${t}=${n}`
  })
  const objs = (
    f.raw
      .prepare(`select type, name from sqlite_master where name not like 'sqlite_%' order by type, name`)
      .all() as { type: string; name: string }[]
  ).map((r) => `${r.type}:${r.name}`)
  const rc = f.raw
    .prepare(
      `select id, item_id, ease, interval_days, reps, lapses, due_at, silent, uid, updated_at
         from reading_cards order by id`
    )
    .all()
  const rl = f.raw
    .prepare(`select id, item_id, grade, uid, updated_at from review_logs order by id`)
    .all()
  const st = f.raw.prepare(`select key, value from settings order by key`).all()
  return JSON.stringify({
    uv: one(`pragma user_version`),
    counts,
    objs,
    rc,
    rl,
    st
  })
}

/** 待推行数 —— 判据照抄 Windows 那一句：当前版本 ≠ 已确认推出去的那一版 */
export function pendingCount(f: Fixture, table: string): number {
  const r = f.raw
    .prepare(
      `select count(*) as n from "${table}" t
         left join row_sync_state s on s.table_name = ? and s.uid = t.uid
        where s.pushed_updated_at is null or s.pushed_updated_at <> t.updated_at`
    )
    .get(table) as { n: number }
  return r.n
}

/**
 * 故障注入 —— 负向对照用。
 *
 * 它把某一句 SQL 换成坏的那一版，好验证「自检真的会红」。
 * 不这么做的话，「自检存在」和「自检有用」是两件事。
 */
export class FaultDb implements Db {
  private readonly inner: Db
  private readonly rewrite: (sql: string) => string
  constructor(inner: Db, rewrite: (sql: string) => string) {
    this.inner = inner
    this.rewrite = rewrite
  }
  exec(sql: string): Promise<void> {
    return this.inner.exec(this.rewrite(sql))
  }
  run(sql: string, p?: readonly unknown[]): Promise<void> {
    return this.inner.run(this.rewrite(sql), p)
  }
  get(sql: string, p?: readonly unknown[]): Promise<Row | undefined> {
    return this.inner.get(sql, p)
  }
  all(sql: string, p?: readonly unknown[]): Promise<Row[]> {
    return this.inner.all(sql, p)
  }
  begin(): Promise<void> {
    return this.inner.begin()
  }
  commit(): Promise<void> {
    return this.inner.commit()
  }
  rollback(): Promise<void> {
    return this.inner.rollback()
  }
}

/**
 * ══ I-186 · 临时目录泄漏 ★★ ═══════════════════════════════
 *
 * 每个夹具开一个 `DatabaseSync`，**从来没人 close**。Linux 上删得掉（文件可以
 * 在被打开的状态下 unlink），**Windows 上删不掉** —— `rmSync` 抛 `EBUSY`，
 * 而它正好落在下面那个**空 catch** 里被吞掉。
 *
 * 症状是零：用例全绿、闸全绿、屏上什么都不说，只有 `%TEMP%` 一直长。
 * 2026-09-15 数出来 **43512 个** `nyx-and-*`（两端合计 80 GB，本端这一半 18 GB）。
 *
 * ★ 两处都要改，少一处仍然是零症状：
 *   ① 先 `raw.close()` 再删 —— 句柄还开着的时候删不掉，这是根因；
 *   ② 空 catch 改 `console.warn` —— 下一次再有删不掉的东西，要有人看得见。
 *     （吞掉异常本身就是这个 bug 活了这么久的原因。）
 */
export function cleanup(): void {
  for (const f of open.splice(0)) {
    try {
      f.close()
    } catch (e) {
      console.warn(`[helpers] 关不掉库：${String(e)}`)
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch (e) {
      // ★ 不再吞：删不掉就说出来（临时目录留着不影响用例，但要看得见）
      console.warn(`[helpers] 删不掉临时目录 ${d}：${String(e)}`)
    }
  }
}
