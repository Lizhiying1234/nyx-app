#!/usr/bin/env node
/**
 * 探针的**自证**：在 PC 上用 `node:sqlite` 跑同一套逻辑。
 *
 * ★ 为什么要有这一步：一个从没被跑过的探针，和没有探针是一回事。
 *   先证明「这套逻辑能复现 Windows 基线 9dde78ab1d916501」，
 *   再拿它去真机上跑 —— 那时候如果红了，就是**设备**的问题，不是探针的问题。
 *
 * 用法：
 *   node tools/db-probe/run-node.mjs [--repo <nyx_project 检出>]   （默认 = submodule nyx-core/，T-1.3）
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probe, compare, MAY_DIFFER } from './probe.mjs'

const args = process.argv.slice(2)
const REPO = (() => {
  const i = args.indexOf('--repo')
  return i >= 0 && args[i + 1] ? args[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'nyx-core')
})()
const here = dirname(fileURLToPath(import.meta.url))

if (!existsSync(join(REPO, 'src', 'core', 'schema-fingerprint.ts'))) {
  console.error(`✖ 找不到 core：${REPO}\n  submodule 没初始化就 git submodule update --init nyx-core；或用 --repo 指一下`)
  process.exit(2)
}

// ★ 判据只有一份：从 Windows 仓库的 core 里取，探针自己不带
const url = (rel) => pathToFileURL(join(REPO, rel)).href
const { SYNC_TABLES } = await import(url('src/core/sync-tables.ts'))
const { normalizeSchema, readSyncSurface } = await import(url('src/core/schema-fingerprint.ts'))

const versions = readdirSync(join(REPO, 'schema'))
  .map((f) => /^v(\d+)\.sql$/.exec(f))
  .filter(Boolean)
  .map((m) => Number(m[1]))
const TARGET = Math.max(...versions)

const dir = mkdtempSync(join(tmpdir(), 'nyx-probe-'))
const db = new DatabaseSync(join(dir, 'probe.db'))
db.exec(readFileSync(join(REPO, 'schema', `v${TARGET}.sql`), 'utf8'))
db.exec(`pragma user_version = ${TARGET}`)

const query = (sql, params) => db.prepare(sql).all(...(params ?? []))
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const got = await probe(query, { SYNC_TABLES, normalizeSchema, readSyncSurface, sha256 })
db.close()
rmSync(dir, { recursive: true, force: true })

console.log(`探针自证 · node:sqlite + schema/v${TARGET}.sql\n`)
console.log(`  user_version      ${got.userVersion}`)
console.log(`  同步表            ${got.syncTableCount} 张（缺 ${got.missingTables.length}）`)
console.log(`  列 / 外键 / 触发器  ${got.columnCount} / ${got.fkCount} / ${got.triggerCount}`)
console.log(`  规范化文本        ${got.normalizedBytes} 字`)
console.log(`  指纹              ${got.fingerprint}`)
console.log(`\n  平台项（允许各端不同）：`)
for (const k of MAY_DIFFER) console.log(`    ${k.padEnd(16)} ${got.platform[k]}`)
console.log(`    foreign_keys     ${got.platform.foreign_keys}`)
console.log(`    integrity_check  ${got.platform.integrity_check}`)

// 写/更新基线
const baselinePath = join(here, 'expected.json')
if (args.includes('--write-baseline')) {
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        says: 'Windows 基线 —— 真机探针拿这个比。由 run-node.mjs --write-baseline 生成',
        generatedAt: new Date().toISOString(),
        repo: REPO,
        schemaFile: `schema/v${TARGET}.sql`,
        userVersion: got.userVersion,
        syncTableCount: got.syncTableCount,
        syncTables: got.syncTables,
        fingerprint: got.fingerprint,
        normalizedBytes: got.normalizedBytes,
        columnCount: got.columnCount,
        fkCount: got.fkCount,
        triggerCount: got.triggerCount,
        platform: got.platform,
        normalized: got.normalized
      },
      null,
      2
    ) + '\n'
  )
  console.log(`\n✓ 基线已写入 ${baselinePath}`)
  process.exit(0)
}

if (!existsSync(baselinePath)) {
  console.log('\n（还没有 expected.json —— 用 --write-baseline 生成一次）')
  process.exit(0)
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const r = compare(got, baseline)
console.log(`\n${r.pass ? '✓ 与基线一致 —— 探针本身是好的，可以拿去真机' : '✖ 与基线不一致'}`)
for (const p of r.problems) console.log('  ' + p)
for (const n of r.notes) console.log('  · ' + n)
process.exit(r.pass ? 0 : 1)
