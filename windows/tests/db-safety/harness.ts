/**
 * db-safety 的验收骨架 · T-4.6 拆分（2026-09-06）
 *
 * 计数器 · check / checkAsync / checkAsyncSerial / assert · 三个命令行旗标 · freshDir。
 * ★ checkAsync 的身体在声明点就开跑、在每个 await 处互相穿插 —— 这是这份验收最要紧的性质，
 *   拆开之后各段由入口按原顺序 import，注册顺序与拆分前逐字一致。
 * ★ 从 tests/db-safety.ts 原样搬来，一个字没改（只加了 export）。
 */

import { app } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { TARGET_VERSION } from '../../src/main/db/migrations.ts'
import { schemaIdentity } from '../../src/main/db/fingerprint.ts'
import { dumpSchemaSql } from '../../src/main/db/schema-dump.ts'

export let failures = 0
export let passes = 0

/**
 * ★★ Step 4 · `--dump-schema` —— 重放全部 migration，把结果导成 schema/vNN.sql。
 *
 * 放在这个文件里是因为**只有它**能拿到解析好别名的 `migrations.ts`
 * （`@core/…` 由 electron-vite 打包时解析，纯 node 跑不通）。
 * 由 `npm run schema:dump` 调用。
 */
if (process.argv.includes('--dump-schema')) {
  void (async () => {
    const { db: dp, backups: dbk } = freshDir()
    const dr = openDatabase(dp, dbk)
    const dir = join(process.cwd(), 'schema')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `v${TARGET_VERSION}.sql`)
    writeFileSync(file, dumpSchemaSql(dr.db, TARGET_VERSION), 'utf8')
    console.log(`写好了 ${file}（v${TARGET_VERSION} · 同步表面指纹 ${(await schemaIdentity(dr.db)).schemaFingerprint}）`)
    dr.db.close()
    cleanupTempDirs()
    app.exit(0)
  })()
}

/**
 * ★ `--schema` —— 只跑 Step 4 那一批（`npm run check:schema` 用它）。
 * 别的用例要起真云端、要跑 Playwright，几分钟；结构这一档要能秒回，
 * 否则没人会在改 migration 之后顺手跑一下。
 */
export const ONLY_SCHEMA = process.argv.includes('--schema')
/**
 * `--only <字串>` —— 只跑名字里含这个字串的用例。
 *
 * ★ 反向验收（`scripts/dict-negative-controls.mjs`）靠它：删掉一处修复之后
 *   只需要重跑相关的那几条，而不是等整套 500 多条跑完。
 *   跑得慢的闸没人会跑，那和没有闸是一回事。
 */
const ONLY_ARG = process.argv.indexOf('--only')
export const ONLY = ONLY_ARG >= 0 ? (process.argv[ONLY_ARG + 1] ?? '') : ''
const wanted = (name: string): boolean =>
  (!ONLY_SCHEMA || name.includes('Step 4')) && (!ONLY || name.includes(ONLY))

/** ★ Step 6A.1 · 只跑基线那一批（`npm run sync:baseline` 录制时用） */
export const ONLY_BASELINE = process.argv.includes('--sync-baseline')

export function check(name: string, fn: () => void): void {
  if (ONLY_BASELINE) return
  if (!wanted(name)) return
  try {
    fn()
    passes++
    console.log(`  ✔ ${name}`)
  } catch (err) {
    failures++
    console.error(`  ✖ ${name}`)
    console.error(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 异步版。`check` 是同步的 —— 直接把 async 函数丢进去，
 * 断言失败会变成没人接的 rejected promise，**这一条就永远是绿的**。
 * 那正是「报警器不响」那一类，所以单独写一个，最后统一 await。
 */
export const pending: Promise<void>[] = []
export function checkAsync(name: string, fn: () => Promise<void>): void {
  if (ONLY_BASELINE) return
  if (!wanted(name)) return
  pending.push(
    fn().then(
      () => {
        passes++
        console.log(`  ✔ ${name}`)
      },
      (err: unknown) => {
        failures++
        console.error(`  ✖ ${name}`)
        console.error(`      ${err instanceof Error ? err.message : String(err)}`)
      }
    )
  )
}

/**
 * ★ setCrypto 是进程级全局 —— 用到它的 async 用例必须**串行**，
 *   否则 A 的 finally setCrypto(null) 会拔掉 B 正在用的加解密层
 *   （checkAsync 的身体在声明点就开跑、在每个 await 处互相穿插）。
 */
let cryptoQ: Promise<void> = Promise.resolve()
export function checkAsyncSerial(name: string, fn: () => Promise<void>): void {
  const prev = cryptoQ
  let release!: () => void
  cryptoQ = new Promise((r) => (release = r))
  checkAsync(name, async () => {
    await prev
    try {
      await fn()
    } finally {
      release()
    }
  })
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

/**
 * ══ I-186 · 这一趟造的临时目录，跑完要删掉 ★★★ ════════════════
 *
 * 2026-09-15 在他机器上数出来：`%TEMP%` 下 **94294 个 `nyx-dbtest-*`**（约 61 GB），
 * 全是这个函数造的 —— **造完就扔，一次都没删过**。
 *
 * 这种泄漏最难自己现形：每跑一次 `test:db` 只多几百个目录，用例全绿、
 * 报告好看、磁盘一年后才满。**它不会红，只会变大**。
 *
 * ★ 删不掉的时候**喊一声**，不许静默吞：Windows 上删不掉基本只有一个原因 ——
 *   那个目录里还有**没关的 SQLite 句柄**（用例忘了 `db.close()`）。
 *   静默吞掉的话，下一个人看到的又是「目录莫名其妙在长」，而账上什么都没有。
 */
const tempDirs: string[] = []

export function freshDir(): { db: string; backups: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-dbtest-'))
  tempDirs.push(dir)
  const backups = join(dir, 'backups')
  mkdirSync(backups, { recursive: true })
  return { db: join(dir, 'nyx.db'), backups, dir }
}

/**
 * 把这一趟造的临时目录删干净。
 *
 * ★ `maxRetries` / `retryDelay` 不是迷信：Windows 上文件刚被关掉的那一瞬，
 *   杀毒与索引服务还可能按着它，`rmSync` 会拿到 EBUSY / EPERM。重试几次就过去了。
 * ★ **删不掉不抛** —— 清理失败不该把一趟全绿的验收变成红的；
 *   但要把**哪一个目录、为什么**打出来，并在末尾给一个总数。
 */
export function cleanupTempDirs(): void {
  const kept: string[] = []
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    } catch (e) {
      kept.push(dir)
      console.warn(`⚠ 临时目录删不掉：${dir} —— ${(e as Error).message}`)
    }
  }
  if (kept.length > 0) {
    console.warn(
      `⚠ 这一趟有 ${kept.length} 个临时目录没删掉 —— ` +
        '多半是某条用例开了库没 `db.close()`（Windows 上句柄没关就删不掉那个目录）。'
    )
  }
}

/**
 * ★ 兜底：谁走别的路退出（抛异常 / 外面 kill）也尽量清一次。
 *
 * ★★ **实测结论（别再拿推理覆盖它）**：这一片我当初写的理由是
 *   「`app.exit()` 是立即终止，靠 `exit` 事件不保险」—— **那句是推的，而且不对**。
 *   2026-09-15 拿负向对照量过：只拆掉 `db-safety.ts` 那句显式调用，
 *   增量仍然是 **0** —— 这一行接住了，`app.exit()` 在这儿**是会**触发 `exit` 的。
 *   两处都留是**双保险**，不是因为哪一处不管用：
 *   把两道一起拆掉才复现（一趟漏 **657** 个目录）。
 *   `splice(0)` 保证清两次不会重复删。
 */
process.on('exit', cleanupTempDirs)

