#!/usr/bin/env node
/**
 * 这份 Android build 用的是哪一个 core —— 把三个数字打印出来（T-1.3 · 2026-09-04）
 *
 *   core SHA        Android 仓 HEAD 记录的 submodule 指针（`git ls-tree HEAD nyx-core`）
 *   checked out     `nyx-core/` 工作树实际检出的 commit —— 和上面不一样 = 有人 update 了没提交
 *   schema version  `src/schema-link.ts` 的 TARGET_VERSION
 *   fingerprint     用那份 `schema/vNN.sql` 建一个内存库，按 core 的 `schema-fingerprint` 量同步表面
 *                   （和 `tools/db-probe/probe.mjs` 同一把尺，和 Windows `check:schema` 打出来的是同一个值）
 *
 * `vite.config.ts` 构建时读它的 `--json` 输出，塞进 `__NYX_CORE__`（Settings › ABOUT 那一行）。
 * 直接跑它就是一句人话。它**不读** Windows 工作树，只读本仓和 submodule。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (args, cwd = ROOT) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

// HEAD 里的指针；还没提交过（第一次加 submodule）就看暂存区
const fromHead = git(['ls-tree', 'HEAD', 'nyx-core']).split(/\s+/)[2] ?? ''
const fromIndex = git(['ls-files', '--stage', 'nyx-core']).split(/\s+/)[1] ?? ''
const pinnedFull = fromHead || fromIndex
const pinned = pinnedFull.slice(0, 7)
const checkedOut = git(['rev-parse', '--short=7', 'HEAD'], join(ROOT, 'nyx-core'))
const schemaVersion = Number(
  /TARGET_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src', 'schema-link.ts'), 'utf8'))?.[1] ?? 0
)

let fingerprint = ''
try {
  // 判据只有一份：core 的读器 + 规范化；哈希按 FINGERPRINT_ALGO（sha256 取前 16 位）
  const core = (rel) => pathToFileURL(join(ROOT, 'nyx-core', 'src', 'core', rel)).href
  const { normalizeSchema, readSyncSurface } = await import(core('schema-fingerprint.ts'))
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(join(ROOT, 'nyx-core', 'schema', `v${schemaVersion}.sql`), 'utf8'))
  db.exec(`pragma user_version = ${schemaVersion}`)
  const readable = { all: (sql, params) => db.prepare(sql).all(...(params ?? [])) }
  const tables = await readSyncSurface(readable)
  fingerprint = createHash('sha256').update(normalizeSchema(tables)).digest('hex').slice(0, 16)
  db.close()
} catch (e) {
  fingerprint = `?（${String(e?.message ?? e).split('\n')[0]}）`
}

const out = { pinned, pinnedFull, checkedOut, dirty: pinned !== checkedOut, schemaVersion, fingerprint }
if (process.argv.includes('--json')) console.log(JSON.stringify(out))
else
  console.log(
    `core ${pinned || '?'}${out.dirty ? `（工作树 ${checkedOut || '?'}，未提交）` : ''} · schema v${schemaVersion} · 指纹 ${fingerprint}`
  )
