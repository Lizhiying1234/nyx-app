/**
 * PC 端同步驱动（④ 层两端对拷用）—— 跑的是**同一份** core 引擎。
 *
 *   node tools/sync-pc.mjs --db <file.db> --url http://127.0.0.1:8722/nyx-lab --user u --secret s [--resolve local|remote] [--rename-lecture id=名字]
 *
 * 库若还是 v33 会先走**同一份**升级器（src/db/upgrade.ts —— 判据只有一份）。
 * 端口全是本地替身：身份=WebCrypto 哈希 · 备份=vacuum into 临时件 ·
 * 音频=空目录 · secret=命令行参数（试验场，不进 Keystore 的必要）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteDb } from '../src/adapters/node-sqlite.ts'
import { AuditDb } from '../src/db/audit-db.ts'
import { upgrade } from '../src/db/upgrade.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// schema-link 走 vite 的 ?raw —— node 直跑读文件（同一份 schema，从 submodule nyx-core 里读，不是第二份）
// ★ 版本跟 src/schema-link.ts 走（T-1.3 起从 v35 改成和它一致的 v36）
const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET_VERSION = 36
const SCHEMA_SQL = readFileSync(join(HERE, '..', 'nyx-core', 'schema', `v${TARGET_VERSION}.sql`), 'utf8')
import {
  FINGERPRINT_ALGO,
  normalizeSchema,
  readSyncSurface,
  SyncEngine
} from '../src/core-link.ts'

const arg = (k, d = null) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const dbPath = arg('db')
if (!dbPath) throw new Error('要 --db <file.db>')

const raw = new DatabaseSync(dbPath)
const db = new AuditDb(new NodeSqliteDb(raw))

const ver = Number(raw.prepare('pragma user_version').get().user_version ?? 0)
if (ver !== TARGET_VERSION) {
  console.log(`库在 v${ver} —— 先走同一份升级器到 v${TARGET_VERSION}…`)
  const r = await upgrade(db, { schemaSql: SCHEMA_SQL, targetVersion: TARGET_VERSION, now: Date.now() })
  console.log(`升级：${r.action} · 保全 ${Object.values(r.preserved.rows).reduce((a, b) => a + b, 0)} 行`)
}

const sha16 = async (text) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

let secret = arg('secret', '')
const engine = new SyncEngine({
  db,
  identity: async () => {
    const normalized = normalizeSchema(await readSyncSurface(db))
    const v = Number((await db.get('pragma user_version'))?.user_version ?? 0)
    return { schemaVersion: v, schemaFingerprint: await sha16(normalized), normalized, algo: FINGERPRINT_ALGO }
  },
  backup: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nyx-sync-pc-'))
    await db.run(`vacuum into '${join(dir, 'before-sync.db').replace(/\\/g, '/').replace(/'/g, "''")}'`)
  },
  audio: {
    list: async () => [],
    read: async () => null,
    write: async () => {}
  },
  secrets: {
    getSyncSecret: () => secret,
    setSyncSecret: (v) => {
      secret = v
    },
    hasSyncSecret: () => secret !== ''
  },
  clock: { now: () => Date.now() },
  uuid: () => crypto.randomUUID()
})

await engine.saveConfig({ kind: arg('kind', 'supabase'), url: arg('url'), user: arg('user', 'u'), secret })

const ren = arg('rename-lecture')
if (ren) {
  const [id, name] = ren.split('=')
  await db.run(`update lectures set name = ?, updated_at = ? where id = ?`, [name, Date.now(), Number(id)])
  console.log(`PC 端改名：lecture ${id} → ${name}`)
}

const r = await engine.run(arg('resolve') ?? undefined, 'PC 对拷驱动')
console.log('──', r.lastNote)
console.log(JSON.stringify({ pushed: r.pushed, received: r.received, applied: r.applied, skipped: r.skipped, failed: r.failed, conflicted: r.conflicted, rejected: r.rejected }, null, 1))
for (const row of await db.all(`select id, name from lectures where deleted_at is null order by id`)) {
  console.log('  lecture', row.id, row.name)
}
raw.close()
