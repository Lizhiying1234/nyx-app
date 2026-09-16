/**
 * db-safety 的共用夹具 · T-4.6 拆分（2026-09-06）
 *
 * 被两个以上段用到的东西才放这里：建库 / 造树 · 进程内假云（假服务器 · putChunk · configureSync · newSync）
 * · 假 AI（fakeAi / setUpAi）· 各种快照与断言小工具 · 7E 的场景结果表 E7。
 * ★ 全部从 tests/db-safety.ts 原样搬来，一个字没改（只加了 export，以及下面写明的那一处 setter）。
 */

import { app, safeStorage } from 'electron'
import Database from 'better-sqlite3'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { recoverAll } from '../../src/main/db/recover.ts'
import { analyzeLecture } from '../../src/main/ai/analyze.ts'
import { MIGRATIONS, TARGET_VERSION } from '../../src/main/db/migrations.ts'
import { Exporter } from '../../src/main/export.ts'
import { writePlainDict } from '../make-dict.ts'
import { Study } from '../../src/main/study.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Sync } from '../../src/main/sync/index.ts'
import { schemaIdentity } from '../../src/main/db/fingerprint.ts'
import { SYNC_PROTOCOL_VERSION } from '../../src/core/sync-protocol.ts'
import type { SyncRow } from '../../src/core/sync-merge.ts'
import { snapshot, type ConvergenceDevice, type DbLike } from '../convergence.ts'
import { createHash } from 'node:crypto'
import { Repo } from '../../src/main/db/repo.ts'
import { Browse } from '../../src/main/browse.ts'
import { parseApplied } from '../../src/core/restore-merge.ts'
import { audit } from '../../src/main/db/audit.ts'
import { ensureBuiltins } from '../../src/main/db/builtins.ts'
import { assert, freshDir } from './harness.ts'

export const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')

export const require$hash = (s: string): string =>
  createHash('sha256')
    .update(s.replace(CRLF, String.fromCharCode(10)))
    .digest('hex')
    .slice(0, 16)

export function seedTree(r: { db: Database.Database }): void {
  const t = Date.now()
  r.db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t, t)
  r.db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`).run(t, t)
  r.db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (2,1,'U2',?,?)`).run(t, t)
  /**
   * 学习中的 lecture **必须有到期日** —— 没有就永远不进「今日」。
   * 第一版 fixture 直接写 status='ready' 却没给 due_at，
   * 体检当场报了出来。那是 fixture 不真实，不是代码错：
   * 真实路径上 due_at 是审阅那一步给的。
   */
  /**
   * ★ P-1 · 这里以前写的是 `'ready'` —— **一个软件永远产生不了的状态值**
   * （合法的是 empty / analyzing / review / training）。
   * 数据层封板那一轮就记录过这条夹具漂移，当时没有任何东西会因此变红；
   * 直到 `startLearning` 加上「只能从 review 进入」的后端前置条件，
   * 四条用例当场红了 —— 它们一直依赖「这个函数没有前置条件」这件事。
   *
   * 换成 `review`：既是真实路径上的状态，也让这些用例验的是真的东西。
   */
  const L = r.db.prepare(
    `insert into lectures (id,unit_id,name,status,due_at,created_at,updated_at)
     values (?,?,?,'review',?,?,?)`
  )
  L.run(1, 1, 'L1', t, t, t)
  L.run(2, 1, 'L2', t, t, t)
  L.run(3, 2, 'L3', t, t, t)
  const I = r.db.prepare(
    `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
     values (?,?,'g','B','chunk','ai','training',?,?)`
  )
  const IL = r.db.prepare(
    `insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,?,?,?)`
  )
  for (const [id, term, lec] of [
    [1, 'bear the brunt of', 1],
    [2, 'at the mercy of', 1],
    [3, 'a far cry from', 3]
  ] as const) {
    I.run(id, term, t, t)
    IL.run(id, lec, t, t)
    r.db
      .prepare(`insert into occurrences (item_id,lecture_id,quote,created_at,updated_at) values (?,?,?,?,?)`)
      .run(id, lec, 'quote ' + term, t, t)
  }
}

export const statusOf = (db: InstanceType<typeof Database>, id: number): string =>
  (db.prepare(`select status from lectures where id = ?`).get(id) as { status: string }).status

export function cleanLecture(r: ReturnType<typeof openDatabase>): number {
  const t = Date.now()
  r.db
    .prepare(
      `insert into lectures (id,unit_id,name,status,due_at,created_at,updated_at)
       values (9,1,'干净的一讲','empty',null,?,?)`
    )
    .run(t, t)
  new Repo(r.db).addOriginal(9, '待分析的原文', 'They hold sway over the region.', 'paste')
  return 9
}

export function dbThatFailsOn(db: Database.Database, sqlPart: string, code?: string): Database.Database {
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes(sqlPart)) {
            const e = new Error(`注入的故障：${sqlPart}`) as Error & { code?: string }
            // 带上 SQLite 错误码就能造出「库不可信」那一档（R-1 的分级判据）
            if (code) e.code = code
            throw e
          }
          return target.prepare(sql)
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    }
  }) as Database.Database
}

export const analyzeDeps = (r: ReturnType<typeof openDatabase>, promptsDir: string): Parameters<typeof analyzeLecture>[1] => ({
  db: r.db,
  promptsDir,
  level: 'B2',
  onStage: () => {}
})

export const lecRow = (db: InstanceType<typeof Database>, id: number): { status: string; dueAt: number | null; interval: number } =>
  db
    .prepare(`select status, due_at as dueAt, interval_days as interval from lectures where id = ?`)
    .get(id) as { status: string; dueAt: number | null; interval: number }

export function makeBook(root: string, name: string, words: { word: string; body: string }[]): string {
  const dir = join(root, name)
  writePlainDict(dir, name, words)
  return dir
}

export function simulateStartup(p: string, backups: string): {
  r: ReturnType<typeof openDatabase>
  builtins: ReturnType<typeof ensureBuiltins>
  recovered: ReturnType<typeof recoverAll>
} {
  const r = openDatabase(p, backups)
  const builtins = ensureBuiltins(r.db)
  const recovered = recoverAll(r.db)
  return { r, builtins, recovered }
}

export function snapshotAll(db: Database.Database): string {
  const tables = (
    db
      .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
      .all() as { name: string }[]
  )
    .map((x) => x.name)
    .sort()
  const out: Record<string, unknown> = {}
  for (const t of tables) {
    const cols = (db.prepare(`pragma table_info("${t}")`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c !== 'updated_at')
    if (cols.length === 0) continue
    out[t] = db.prepare(`select ${cols.map((c) => `"${c}"`).join(',')} from "${t}" order by rowid`).all()
  }
  return JSON.stringify(out)
}

export const auditIds = (db: Database.Database): string[] => audit(db).findings.map((f) => f.id).sort()

export const ledgerRows = (db: Database.Database): string =>
  JSON.stringify(
    db
      .prepare(
        `select norm, verdict, scope, lecture_id as l,
                case when revoked_at is null then 0 else 1 end as revoked
           from term_ledger order by norm, verdict`
      )
      .all()
  )

export function readyLecture(r: ReturnType<typeof openDatabase>, id: number): void {
  new Repo(r.db).addChunks(id, '我的收集', ['alpha one', 'beta two', 'gamma three'].join(String.fromCharCode(10)))
  r.db.prepare(`update lectures set status='review', due_at=null, interval_days=0 where id=?`).run(id)
}

export const cardDues = (db: Database.Database, id: number): string =>
  JSON.stringify(
    db
      .prepare(
        `select i.id, rc.due_at as cd from items i join reading_cards rc on rc.item_id = i.id
          join item_lectures il on il.item_id = i.id
         where il.lecture_id = ? and i.deleted_at is null order by i.id`
      )
      .all(id)
  )

export const cloudFiles = new Map<string, string>()

/**
 * ★★ T-4.6 · 这是整次拆分里**唯一**不是「原样搬」的地方。
 *
 * 原来它是顶层的 `let onCloudPut`，由 Step 6C / 7E 的 push race 用例直接赋值。
 * 拆开之后赋值点（convergence-cases.ts）和读取点（这里的假服务器）分属两个模块，
 * 而 ESM **不许给 import 进来的绑定赋值**。所以把它挂到一个对象上：
 * 读写仍是同一处状态，语义一个字没变，四个调用点只是从
 * `onCloudPut = x` 变成 `cloudHook.onPut = x`。
 *
 * ★ 有意不做成 setter 函数：那要把 `= x` 改写成 `(x)`，而那四处的右边是跨多行的
 *   箭头函数，文本改写容易改断；换成对象成员只是改个名字，不动语法结构。
 */
export const cloudHook: {
  onPut: ((path: string) => void) | null
  /**
   * ★★ T-2.9 · **掐一次连接**：把某个桶的下一发某种请求 RST 掉，只掐一次。
   *
   * 造的是 I-133 量到的那个形状：服务端把连接 RST 掉，客户端在写上去时收到
   * `ECONNRESET`（undici 在有些版本上报成 `UND_ERR_SOCKET: other side closed`，
   * 所以 `core/sync/retry.ts` 的名单两个都收）。
   *
   * ★★ **必须按桶定向，不能做成一个全局的「下一发」** ——
   *   这个假云是**整个 `test:db` 共用**的，而 `checkAsync` 的身体在声明点就开跑、
   *   在每个 `await` 处互相穿插。第一版我写成了全局一次性开关，结果那一发 RST
   *   被**别的用例**吃掉了：我自己的两条照样绿，红的是隔壁的 `R-4-F-a ④`。
   *   那是一次真正的假绿 —— 用例什么都没验到，还往并发套件里乱丢故障。
   *   桶名每条用例各不相同，所以按 `path` 的桶前缀 + 动词定向才打得准。
   *
   * ★★ 而且它必须是 **Map（桶 → 动词）**，不能是一个单槽位。
   *   第二版我写成了单槽位：两条并发的用例一前一后 arm，后一条把前一条的目标**盖掉**了 ——
   *   于是前一条那发 RST 永远不会发生，而它看起来还是绿的。
   *   同一类假绿连着撞两次，都是“共享夹具 + 并发用例”这一个根因。
   *
   * ★ 用 `resetAndDestroy()` 而不是 `destroy()`：后者是 FIN（正常关闭），
   *   前者才是 RST —— 我们要验的正是 RST 那一种。老 Node 上退回 `destroy()`。
   */
  rstAt: Map<string, string>
} = { onPut: null, rstAt: new Map() }

export let cloudPort = 0

export function fakeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const srv = createServer(handler)
  srv.keepAliveTimeout = 0
  return srv
}

export const cloudReady = new Promise<void>((resolve) => {
  const srv = fakeServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').replace(/\/+$/, ''))
    /** ★ T-2.9 · 一次性 RST，**只掐点名的那个桶 + 那个动词**（理由见 `rstAt` 上面那段） */
    const rstBucket = path.split('/')[0] ?? ''
    if (cloudHook.rstAt.get(rstBucket) === req.method) {
      cloudHook.rstAt.delete(rstBucket)
      const s = req.socket as unknown as { resetAndDestroy?: () => void; destroy: () => void }
      if (typeof s.resetAndDestroy === 'function') s.resetAndDestroy()
      else s.destroy()
      return
    }
    if (req.method === 'MKCOL') {
      res.writeHead(cloudFiles.has(`dir:${path}`) ? 405 : 201).end()
      cloudFiles.set(`dir:${path}`, '')
      return
    }
    if (req.method === 'PROPFIND') {
      const kids = [...cloudFiles.keys()].filter(
        (k) => !k.startsWith('dir:') && k.startsWith(path ? `${path}/` : '')
      )
      res
        .writeHead(207, { 'content-type': 'application/xml' })
        .end(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">` +
            kids.map((k) => `<D:response><D:href>/${k}</D:href></D:response>`).join('') +
            `</D:multistatus>`
        )
      return
    }
    if (req.method === 'PUT') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        cloudFiles.set(path, body)
        if (cloudHook.onPut) cloudHook.onPut(path)
        res.writeHead(201).end()
      })
      return
    }
    if (req.method === 'GET') {
      const v = cloudFiles.get(path)
      if (v === undefined) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': 'application/json' }).end(v)
      return
    }
    /**
     * ★ T-2.10 · DELETE。这个假云此前一路 405（T-2.2 的删除用例走的是
     * `tests/sync.test.ts` 里那个真 WebDAV），而压实的触发点要在**这里**验 ——
     * 「一趟 run 之后压了没有」只有走完整的主进程才算数。
     *
     * ★ 桶名里带 `nodel` 的**故意不给删**：`probeDeletePermission` 探到之后压实会拒，
     *   「压实失败不改变同步结果」那条用例要的就是这个形状。
     * ★ 别的桶不受影响：`run()` 这条路一次 DELETE 都不发，
     *   之前那几十条用例看到的行为一个字都没变。
     */
    if (req.method === 'DELETE') {
      if (path.includes('nodel')) {
        res.writeHead(403).end()
        return
      }
      cloudFiles.delete(path)
      res.writeHead(204).end()
      return
    }
    res.writeHead(405).end()
  })
  srv.listen(0, '127.0.0.1', () => {
    cloudPort = (srv.address() as { port: number }).port
    /**
     * ★ 阶段 3：schemaIdentity 变异步（读器单份、双端共用）之后，
     * putChunk 仍要**同步**拿本机身份 —— 在这里预载一次：
     * 所有云用例都先 `await cloudReady`，顺序天然成立。
     */
    void (async () => {
      const { db: pp, backups } = freshDir()
      const r = openDatabase(pp, backups)
      const id = await schemaIdentity(r.db)
      cachedIdentity = { schemaVersion: id.schemaVersion, schemaFingerprint: id.schemaFingerprint }
      r.db.close()
      resolve()
    })()
  })
})

export let cachedIdentity: { schemaVersion: number; schemaFingerprint: string } | null = null

export function localIdentity(): { schemaVersion: number; schemaFingerprint: string } {
  if (!cachedIdentity) {
    throw new Error(
      'localIdentity 还没预载 —— 云用例要先 await cloudReady（阶段 3 预载点在 listen 回调里）'
    )
  }
  return cachedIdentity
}

export function putChunk(bucket: string, name: string, rows: unknown[]): void {
  const id = localIdentity()
  cloudFiles.set(
    `${bucket}/nyx/chunks/${name}`,
    JSON.stringify({
      device: 'other',
      at: Date.now(),
      schemaVersion: id.schemaVersion,
      schemaFingerprint: id.schemaFingerprint,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      rows
    })
  )
}

export function putLegacyChunk(bucket: string, name: string, rows: unknown[]): void {
  cloudFiles.set(
    `${bucket}/nyx/chunks/${name}`,
    JSON.stringify({ device: 'other', at: Date.now(), rows })
  )
}

export function putRaw(bucket: string, name: string, body: string): void {
  cloudFiles.set(`${bucket}/nyx/chunks/${name}`, body)
}

export function configureSync(r: ReturnType<typeof openDatabase>, bucket: string): void {
  const t = Date.now()
  const set = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('sync.kind', 'webdav', t)
  set.run('sync.url', `http://127.0.0.1:${cloudPort}/${bucket}`, t)
  set.run('sync.user', 'u', t)
  set.run('sync.secret', 's', t)
  set.run('sync.device', 'me', t)
  /**
   * ★★ D-438 · **这一套用例把自动裁决关掉**（默认是开的）。
   *   它们验的是**冲突裁决机制本身**：检测准不准、四个桶对不对、
   *   裁决落不落库、重放会不会翻案、第三台机器拿到哪一版。
   *   自动裁决开着时冲突当场就没了，这些不变式**一条都验不到** ——
   *   而它们是这套同步最贵的一部分，不能因为默认不再问他就变成没人看的代码。
   *   ★ 开着的那条路另有用例专门验（见「D-438 · 自动裁决」那组）。
   */
  set.run('sync.autoResolve', '0', t)
}

export const syncState = (db: Database.Database): { wm: number; applied: string[]; note: string } => {
  const g = (k: string, d = ''): string =>
    ((db.prepare(`select value from settings where key = ?`).get(`sync.${k}`) as
      | { value: string }
      | undefined)?.value ?? d)
  return {
    wm: Number(g('watermark', '0')) || 0,
    applied: JSON.parse(g('applied', '[]')) as string[],
    note: g('lastNote')
  }
}

export function packOf(good: boolean, bad: boolean): Record<string, unknown>[] {
  const t = Date.now()
  const rows: Record<string, unknown>[] = []
  if (good) {
    rows.push({
      uid: 'remote-project-1',
      table: 'projects',
      updatedAt: t,
      data: { id: 77, name: '对面的项目', color: '#666', sort: 0, pinned: 0, silent: 0,
              deleted_at: null, created_at: t, updated_at: t, uid: 'remote-project-1' }
    } as unknown as Record<string, unknown>)
  }
  if (bad) {
    rows.push({
      uid: 'remote-item-lecture-1',
      table: 'item_lectures',
      updatedAt: t,
      // lecture_id = 999 不存在 → 外键当场挡住，这一行永远写不进去
      data: { item_id: 1, lecture_id: 999, is_owner: 0, created_at: t, updated_at: t,
              uid: 'remote-item-lecture-1' }
    } as unknown as Record<string, unknown>)
  }
  return rows
}

export function newSync(r: ReturnType<typeof openDatabase>, backups: string): Sync {
  r.db
    .prepare(
      `insert into settings (key, value, updated_at) values ('sync.autoResolve', '0', ?)
         on conflict(key) do update set value = '0'`
    )
    .run(Date.now())
  return new Sync(r.db, join(backups, 'audio'), backups)
}

export async function r4Run(sync: Sync): Promise<Awaited<ReturnType<Sync['run']>>> {
  return await sync.run()
}

export const tombs = (db: Database.Database): { kind: string; target: string; at: number }[] =>
  db
    .prepare(`select kind, target_uid as target, purged_at as at from tombstones order by id`)
    .all() as { kind: string; target: string; at: number }[]

export interface Facts {
  tombs: { kind: string; target: string; at: number }[]
  revoked: number
  ledgerRows: number
  wipedAt: string | null
  watermark: string | null
  applied: string[]
  lectures: number
  items: number
  /** ★★ R-4-F-a · 他按过的「用本地的」*/
  resolutions: { target: string; kind: string; at: number }[]
}

export function factsOf(db: Database.Database): Facts {
  const one = (k: string): string | null =>
    (db.prepare(`select value from settings where key = ?`).get(k) as { value: string } | undefined)
      ?.value ?? null
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  return {
    tombs: db
      .prepare(`select kind, target_uid as target, purged_at as at from tombstones order by target_uid`)
      .all() as { kind: string; target: string; at: number }[],
    revoked: n(`select count(*) as n from term_ledger where revoked_at is not null`),
    ledgerRows: n(`select count(*) as n from term_ledger`),
    wipedAt: one('sync.wipedAt'),
    watermark: one('sync.watermark'),
    applied: parseApplied(one('sync.applied')),
    lectures: n(`select count(*) as n from lectures where deleted_at is null`),
    items: n(`select count(*) as n from items where deleted_at is null`),
    resolutions: db
      .prepare(
        `select target_uid as target, kind, rejected_up_to as at from resolutions
          order by target_uid`
      )
      .all() as { target: string; kind: string; at: number }[]
  }
}

export const readFacts = (p: string): Facts => {
  const d = new Database(p, { readonly: true })
  try {
    return factsOf(d)
  } finally {
    d.close()
  }
}

export async function restoreCase(
  shape: (r: ReturnType<typeof openDatabase>) => void | Promise<void>,
  after: (r: ReturnType<typeof openDatabase>) => void | Promise<void>
): Promise<{ before: Facts; backup: Facts; final: Facts; p: string }> {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  await shape(r)
  const src = join(dir, `old-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  new Exporter(r.db).backupTo(src)
  const backup = readFacts(src)

  await after(r)
  const before = factsOf(r.db)

  await new Exporter(r.db).restoreFrom(src, p, backups, MIGRATIONS.length)
  r.db.close()
  return { before, backup, final: readFacts(p), p }
}

export const gt = Date.now() - 60_000

export function ghost(table: string, data: Record<string, unknown>): Record<string, unknown> {
  const uid = `${table}-ghost-${Math.random().toString(36).slice(2, 10)}`
  return { uid, table, updatedAt: gt, data: { ...data, uid } } as unknown as Record<string, unknown>
}

export const purgeItem1 = async (r: ReturnType<typeof openDatabase>): Promise<void> => {
  new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2').deleteItem(1)
  await new Browse(r.db).purgeMany([{ kind: 'item', id: 1 }])
}

export function seedPicks(r: ReturnType<typeof openDatabase>, n: number, base: number, step = 1): void {
  const ins = r.db.prepare(
    `insert into picks (scope, scope_id, content, created_at, updated_at)
     values ('lecture', 1, ?, ?, ?)`
  )
  r.db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(`第 ${i} 条`, base + i * step, base + i * step)
  })()
}

export async function syncUntilDone(sync: Sync, max = 8): Promise<number> {
  for (let i = 1; i <= max; i++) {
    const o = await sync.run()
    if (o.leftOver === 0) return i
  }
  return max + 1
}

export function fPicks(r: ReturnType<typeof openDatabase>, n: number, base: number): void {
  const ins = r.db.prepare(
    `insert into picks (scope, scope_id, content, created_at, updated_at) values ('lecture', 1, ?, ?, ?)`
  )
  r.db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(`原始 ${i}`, base + i, base + i)
  })()
}

export function startedLecture(r: ReturnType<typeof openDatabase>): {
  study: Study
  due: number
  iv: number
  cards: string
} {
  seedTree(r)
  r.db.prepare(`update lectures set status = 'review' where id = 1`).run()
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  study.startLearning(1)
  const l = r.db.prepare(`select due_at as d, interval_days as iv from lectures where id = 1`).get() as {
    d: number
    iv: number
  }
  return { study, due: l.d, iv: l.iv, cards: cardDues(r.db, 1) }
}

export const AI_ROUTES = new Map<string, { calls: { system: string; user: string }[]; content: string }>()

export let aiDispatcherOn = false

export let aiSeq = 0

export function fakeAi(questions: unknown[] | string): {
  base: string
  calls: { system: string; user: string }[]
  restore: () => void
} {
  const host = `ai-${++aiSeq}.invalid`
  const calls: { system: string; user: string }[] = []
  AI_ROUTES.set(host, {
    calls,
    content: typeof questions === 'string' ? questions : JSON.stringify({ questions })
  })

  if (!aiDispatcherOn) {
    aiDispatcherOn = true
    const real = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const u = String(typeof url === 'string' ? url : (url as { url?: string })?.url ?? '')
      const hit = [...AI_ROUTES.keys()].find((h) => u.includes(h))
      if (!hit) return real(url as string, init as RequestInit)
      const route = AI_ROUTES.get(hit)!
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: { role: string; content: string }[]
      }
      const msgs = body.messages ?? []
      route.calls.push({
        system: msgs.find((m) => m.role === 'system')?.content ?? '',
        user: msgs.find((m) => m.role === 'user')?.content ?? ''
      })
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: route.content }, finish_reason: 'stop' }] }),
        text: async () => JSON.stringify({ choices: [{ message: { content: route.content } }] })
      } as unknown as Response
    }) as typeof globalThis.fetch
  }
  return { base: `https://${host}/v1`, calls, restore: () => void AI_ROUTES.delete(host) }
}

export async function setUpAi(db: Database.Database, base: string): Promise<void> {
  await app.whenReady() // safeStorage 在 ready 之前不能用
  const t = Date.now()
  const put = (k: string, v: string): void => {
    db.prepare(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    ).run(k, v, t)
  }
  put('ai.light.baseUrl', base)
  put('ai.light.model', 'test-model')
  put('ai.light.protocol', 'openai')
  put('ai.light.key', safeStorage.encryptString('test-key').toString('base64'))
}

export const V27 = MIGRATIONS.filter((m) => m.version <= 27)

export async function twoDevices(
  bucket: string,
  /** ★ Step 7E · 给两台各自注入时间源（不传 = 真实时间） */
  clocks?: { A?: { now(): number }; B?: { now(): number } }
): Promise<{
  A: ReturnType<typeof openDatabase>
  B: ReturnType<typeof openDatabase>
  syncA: Sync
  syncB: Sync
  /** ★ Step 7A · 收敛 Oracle 要比音频文件集合（D-244） */
  audioA: string
  audioB: string
}> {
  const fa = freshDir()
  const A = openDatabase(fa.db, fa.backups)
  seedTree(A)
  configureSync(A, bucket)
  A.db.prepare(`update settings set value = 'devA' where key = 'sync.device'`).run()

  const fb = freshDir()
  const B = openDatabase(fb.db, fb.backups)
  configureSync(B, bucket)
  B.db.prepare(`update settings set value = 'devB' where key = 'sync.device'`).run()

  const syncA = new Sync(A.db, join(fa.dir, 'audio'), fa.backups)
  const syncB = new Sync(B.db, join(fb.dir, 'audio'), fb.backups)

  await syncA.run()
  const got = await syncB.run()
  assert(got.failed === 0, `前提没成立：B 拉基础数据就失败了 ${JSON.stringify(got.problems ?? []).slice(0, 300)}`)
  const nb = (B.db.prepare(`select count(*) as n from lectures`).get() as { n: number }).n
  assert(nb > 0, '前提没成立：B 没拉到讲')
  return { A, B, syncA, syncB, audioA: join(fa.dir, 'audio'), audioB: join(fb.dir, 'audio') }
}

export const BASELINE_DIR = join(process.cwd(), 'tests', 'sync-baseline')

export interface Observation {
  case: string
  tally: { received: number; applied: number; skipped: number; failed: number; conflicted: number }
  /**
   * ★ 水位记的是**关系**不是绝对值 —— 绝对值每次跑都不一样（`Date.now()`）。
   * 「有没有前进」「是不是被冲突冻住了」才是不变量关心的东西。
   */
  watermark: { advanced: boolean; frozenAtBefore: boolean; monotone: boolean }
  packages: {
    seen: number
    applied: string[]
    rejected: { chunk: string; code: string }[]
    /** 有行写不进去的包 —— 它们必须留在 applied 之外 */
    failedChunks: string[]
    /** 还有未裁决冲突的包 */
    conflictChunks: string[]
    legacy: number
  }
  /** 推出去的：行数 + 按表分布（uid 是随机的，记不得） */
  pushed: { rows: number; byTable: Record<string, number> }
  purged: number
  /** 不变量 ⑤：墓碑行有没有排在普通行前面 */
  writeOrder: string[]
  /** 不变量：DB 边界查询次数 —— 性能回归看它，不看毫秒 */
  boundaryLookups: number
  /** 报给他看的问题（uid 已归一） */
  problems: { kind: string; what: string; head: string }[]
  /** 冲突裁决之后的收敛结果（有冲突的 case 才有） */
  resolvedTo?: string | null
}

export function normalize(s: string): string {
  return s
    .replace(/-[0-9a-f]{16}\b/g, '-<rand>')
    .replace(/\b\d{13}\b/g, '<ts>')
    .replace(/\r?\n[\s\S]*$/, '')
    .slice(0, 120)
}

export function observe(name: string, r: ReturnType<typeof openDatabase>, sync: Sync, wmBefore: number, out: Awaited<ReturnType<Sync['run']>>, pushedRows: SyncRow[]): Observation {
  const wmAfter = syncState(r.db).wm
  const byTable: Record<string, number> = {}
  for (const row of pushedRows) byTable[row.table] = (byTable[row.table] ?? 0) + 1
  return {
    case: name,
    tally: {
      received: out.received,
      applied: out.applied,
      skipped: out.skipped,
      failed: out.failed,
      conflicted: out.conflicted
    },
    watermark: {
      advanced: wmAfter > wmBefore,
      frozenAtBefore: wmAfter === wmBefore,
      monotone: wmAfter >= wmBefore
    },
    packages: {
      seen: out.chunks ?? 0,
      applied: [...syncState(r.db).applied].sort(),
      rejected: (out.rejections ?? []).map((x) => ({ chunk: x.chunk, code: x.code })).sort((a, b) => (a.chunk < b.chunk ? -1 : 1)),
      failedChunks: [],
      conflictChunks: [],
      legacy: out.legacyChunks ?? 0
    },
    pushed: { rows: out.pushed, byTable },
    purged: 0,
    writeOrder: [...sync.writeOrder()],
    boundaryLookups: sync.boundaryLookups(),
    problems: (out.problems ?? [])
      .map((p) => ({ kind: p.kind, what: normalize(p.what), head: normalize(p.message) }))
      .sort((a, b) => (a.what < b.what ? -1 : 1))
  }
}

export interface Case {
  name: string
  /** 输入类型，写进报告用 */
  input: string
  run: (bucket: string) => Promise<Observation>
}

export async function once(
  name: string,
  bucket: string,
  prep: (r: ReturnType<typeof openDatabase>) => void,
  resolve?: 'remote' | 'local'
): Promise<Observation> {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  prep(r)
  const sync = new Sync(r.db, join(backups, 'audio'), backups)
  const wmBefore = syncState(r.db).wm
  const out = await sync.run(resolve)
  // 推了哪些行：从云端那一包里读回来（不依赖任何 core 计算）
  const mine = [...cloudFiles.entries()]
    .filter(([k]) => k.includes(`${bucket}/nyx/chunks/`) && !k.includes('other-') && !k.includes('ghost-'))
    .flatMap(([, v]) => {
      try {
        return ((JSON.parse(v) as { rows?: SyncRow[] }).rows ?? [])
      } catch {
        return []
      }
    })
  const obs = observe(name, r, sync, wmBefore, out, mine)
  r.db.close()
  return obs
}

export const t0 = 1_700_000_000_000

export const CASES: Case[] = [
  {
    name: '01-normal',
    input: '一个包、一行、结构与协议都对',
    run: (b) => once('01-normal', b, () => putChunk(b, 'other-100.json', packOf(true, false)))
  },
  {
    name: '02-empty',
    input: '云端一个包都没有，本地也没有新改动之外的东西',
    run: (b) => once('02-empty', b, () => {})
  },
  {
    name: '03-many-packages',
    input: '5 个包，每个一行',
    run: (b) =>
      once('03-many-packages', b, () => {
        for (let i = 0; i < 5; i++) putChunk(b, `other-${t0 + i}.json`, packOf(true, false))
      })
  },
  {
    name: '04-partial-failure',
    input: '一个包里一行好、一行外键指空',
    run: (b) => once('04-partial-failure', b, () => putChunk(b, 'other-100.json', packOf(true, true)))
  },
  {
    name: '05-single-row-failure',
    input: '一个包只有一行，而且注定写不进去',
    run: (b) => once('05-single-row-failure', b, () => putChunk(b, 'other-100.json', packOf(false, true)))
  },
  {
    name: '06-unresolved-conflict',
    input: '两边都改过同一行，不裁决',
    run: (b) =>
      once('06-unresolved-conflict', b, (r) => {
        const t = Date.now()
        r.db.prepare(`update projects set name = '本地改过', updated_at = ? where id = 1`).run(t)
        const uid = (r.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
        putChunk(b, 'other-100.json', [
          { uid, table: 'projects', updatedAt: t + 1, data: { uid, name: '云端改过', color: '#666', sort: 0, pinned: 0, silent: 0, deleted_at: null, created_at: t, updated_at: t + 1 } }
        ])
      })
  },
  {
    name: '07-resolved-conflict-local',
    input: '同上，但他选「用本地的」',
    run: (b) =>
      once(
        '07-resolved-conflict-local',
        b,
        (r) => {
          const t = Date.now()
          r.db.prepare(`update projects set name = '本地改过', updated_at = ? where id = 1`).run(t)
          const uid = (r.db.prepare(`select uid from projects where id = 1`).get() as { uid: string }).uid
          putChunk(b, 'other-100.json', [
            { uid, table: 'projects', updatedAt: t + 1, data: { uid, name: '云端改过', color: '#666', sort: 0, pinned: 0, silent: 0, deleted_at: null, created_at: t, updated_at: t + 1 } }
          ])
        },
        'local'
      )
  },
  {
    name: '08-tombstone',
    input: '收到一块碑，本地那一份还在',
    run: (b) =>
      once('08-tombstone', b, (r) => {
        const uid = (r.db.prepare(`select uid from lectures where id = 1`).get() as { uid: string }).uid
        const t = Date.now()
        putChunk(b, 'other-100.json', [
          {
            uid: 'tombstones-nat-lectures|' + uid,
            table: 'tombstones',
            updatedAt: t,
            data: { uid: 'tombstones-nat-lectures|' + uid, target_uid: uid, kind: 'lectures', purged_at: t, created_at: t, updated_at: t }
          }
        ])
      })
  },
  {
    name: '09-parent-blocking',
    input: '父被终结，同一批里来了它的子行',
    run: (b) =>
      once('09-parent-blocking', b, (r) => {
        const uid = (r.db.prepare(`select uid from items where id = 1`).get() as { uid: string } | undefined)?.uid
        const t = Date.now()
        const tomb = 'tombstones-nat-items|' + (uid ?? 'items-gone')
        putChunk(b, 'other-100.json', [
          { uid: tomb, table: 'tombstones', updatedAt: t, data: { uid: tomb, target_uid: uid ?? 'items-gone', kind: 'items', purged_at: t, created_at: t, updated_at: t } },
          { uid: 'review_logs-ghost1', table: 'review_logs', updatedAt: t, data: { uid: 'review_logs-ghost1', item_uid: uid ?? 'items-gone', line: 'reading', grade: 3, created_at: t, updated_at: t } }
        ])
      })
  },
  {
    name: '10-multihop-blocking',
    input: '父碑 + questions + drafts 两跳',
    run: (b) =>
      once('10-multihop-blocking', b, (r) => {
        const uid = (r.db.prepare(`select uid from items where id = 1`).get() as { uid: string } | undefined)?.uid ?? 'items-gone'
        const t = Date.now()
        const tomb = 'tombstones-nat-items|' + uid
        putChunk(b, 'other-100.json', [
          { uid: tomb, table: 'tombstones', updatedAt: t, data: { uid: tomb, target_uid: uid, kind: 'items', purged_at: t, created_at: t, updated_at: t } },
          { uid: 'questions-g1', table: 'questions', updatedAt: t, data: { uid: 'questions-g1', item_uid: uid, tier: 1, type: '造句', prompt: 'p', context: 'original', created_at: t, updated_at: t } },
          { uid: 'drafts-g1', table: 'drafts', updatedAt: t, data: { uid: 'drafts-g1', session_uid: 'sessions-none', question_uid: 'questions-g1', text: 'x', created_at: t, updated_at: t } }
        ])
      })
  },
  {
    name: '11-same-millisecond',
    input: '本地一批行的 updated_at 全在同一毫秒上',
    run: (b) =>
      once('11-same-millisecond', b, (r) => {
        const t = Date.now()
        r.db.prepare(`update items set updated_at = ?`).run(t)
        r.db.prepare(`update projects set updated_at = ?`).run(t)
      })
  },
  {
    name: '12-schema-mismatch',
    input: '包头结构指纹对不上',
    run: (b) =>
      once('12-schema-mismatch', b, () => {
        cloudFiles.set(
          `${b}/nyx/chunks/other-100.json`,
          JSON.stringify({ device: 'other', at: t0, schemaVersion: TARGET_VERSION, schemaFingerprint: 'deadbeefdeadbeef', protocolVersion: SYNC_PROTOCOL_VERSION, rows: packOf(true, false) })
        )
      })
  },
  {
    name: '13-protocol-mismatch',
    input: '包头协议版本对不上',
    run: (b) =>
      once('13-protocol-mismatch', b, () => {
        const id = localIdentity()
        cloudFiles.set(
          `${b}/nyx/chunks/other-100.json`,
          JSON.stringify({ device: 'other', at: t0, schemaVersion: id.schemaVersion, schemaFingerprint: id.schemaFingerprint, protocolVersion: SYNC_PROTOCOL_VERSION - 1, rows: packOf(true, false) })
        )
      })
  },
  {
    name: '14-legacy-package',
    input: '没有版本头的老包（C-1 之后一律拒）',
    run: (b) => once('14-legacy-package', b, () => putLegacyChunk(b, 'other-100.json', packOf(true, false)))
  },
  {
    name: '15-broken-package',
    input: '包读不出来（坏 JSON）',
    run: (b) => once('15-broken-package', b, () => putRaw(b, 'other-100.json', '{ 不是 json'))
  },
  {
    name: '16-push-only',
    input: '云端空的，本地有改动 —— 只推不拉',
    run: (b) =>
      once('16-push-only', b, (r) => {
        r.db.prepare(`update projects set name = '改过', updated_at = ? where id = 1`).run(Date.now())
      })
  },
  {
    name: '17-pull-only',
    input: '本地水位已经在最前，只拉不推',
    run: (b) =>
      once('17-pull-only', b, (r) => {
        r.db
          .prepare(`insert into settings (key,value,updated_at) values ('sync.watermark',?,?)
                      on conflict(key) do update set value = excluded.value`)
          .run(String(Date.now() + 60_000), Date.now())
        putChunk(b, 'other-100.json', packOf(true, false))
      })
  },
  {
    name: '18-retry-after-failure',
    input: '第一趟有行失败，第二趟同一个包重来',
    run: async (b) => {
      await cloudReady
      const { db: p, backups } = freshDir()
      const r = openDatabase(p, backups)
      seedTree(r)
      configureSync(r, b)
      putChunk(b, 'other-100.json', packOf(true, true))
      const sync = new Sync(r.db, join(backups, 'audio'), backups)
      await sync.run() // 第一趟：注定有失败
      const wmBefore = syncState(r.db).wm
      const out = await sync.run() // 第二趟：这才是被录的那一趟
      const obs = observe('18-retry-after-failure', r, sync, wmBefore, out, [])
      r.db.close()
      return obs
    }
  }
]

export async function recordBaseline(): Promise<void> {
  mkdirSync(BASELINE_DIR, { recursive: true })
  for (const c of CASES) {
    const obs = await c.run(`bl-${c.name}`)
    writeFileSync(
      join(BASELINE_DIR, `${c.name}.json`),
      JSON.stringify({ input: c.input, observation: obs }, null, 2) + '\n',
      'utf8'
    )
    console.log(`  录 ${c.name}  收 ${obs.tally.received} 应用 ${obs.tally.applied} 查库 ${obs.boundaryLookups}`)
  }
}

export type Pair = Awaited<ReturnType<typeof twoDevices>>

export const devA = (p: Pair): ConvergenceDevice => ({
  name: 'A',
  sync: () => p.syncA.run(),
  snapshot: () => snapshot('A', p.A.db as unknown as DbLike, p.audioA)
})

export const devB = (p: Pair): ConvergenceDevice => ({
  name: 'B',
  sync: () => p.syncB.run(),
  snapshot: () => snapshot('B', p.B.db as unknown as DbLike, p.audioB)
})

export interface CaseLine {
  id: string
  rounds: number
  received: number
  applied: number
  skipped: number
  failed: number
  conflicted: number
  pendingA: number
  pendingB: number
  tombs: number
  res: number
  verdict: string
}

export const E7: CaseLine[] = []

/**
 * `Study` 的全部源码 —— T-4.6（2026-09-06）
 *
 * 有几条「判据只有一份」的静态闸是**按文本扫 `study.ts`** 的
 * （门槛常量只有一处 · 不许再出现写死的兜底题型 · 退役判据接在生产路径上）。
 * 2,571 行拆成入口 + `study/` 下六个领域之后，只扫入口等于扫一个空壳 ——
 * 那些闸会安静地全绿，而它们守的正是「将来有人在第二处又写一遍」。
 *
 * 所以扫的时候把入口和六个领域文件**一起**读进来。新开一个领域文件不用回来改这里。
 */
export function studySources(): string {
  const dir = join(process.cwd(), 'src', 'main')
  const files = [join(dir, 'study.ts')]
  for (const f of readdirSync(join(dir, 'study')).sort()) {
    if (f.endsWith('.ts')) files.push(join(dir, 'study', f))
  }
  return files.map((f) => readFileSync(f, 'utf8')).join(String.fromCharCode(10))
}
