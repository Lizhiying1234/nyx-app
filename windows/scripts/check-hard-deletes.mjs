/**
 * 护栏 · 同步表上的裸 `delete from` —— D-435 / D-436。
 *
 * 为什么要有它：删同步表的行**不会立墓碑**（`TOMBSTONE_KINDS` 只覆盖六类实体，
 * 那是有意设计），所以这种删除**传不到另一台设备**，云端老包里也照旧留着。
 * D-435 定死了「被删除的永不同步，就当死了」—— 而做到这一点的前提是
 * 删除得先走得通。已知的几处记在下面的名单里，**再多出一处就当场红**。
 *
 * 名单里的每一条都要写清楚为什么可以留。想加新的？先想清楚这个删除
 * 要不要传到另一端；要传，就别用裸 delete。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { findAndroidRepo } from './android-repo.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const WIN = path.join(HERE, '..')
/**
 * ★ 原来写死成 `../../../Nyx-Android`：在主检出上靠盘根截断碰巧对，**worktree 里永远落空**，
 *   于是 Android 那一半（`src/db` · `src/ui`）在 worktree 里从来没扫过，还绿着（T-1.4）。
 *   位置改由 `android-repo.mjs` 一处判断，和 `check:android-imports` / `gate:android` 同一条约定。
 */
const AND = findAndroidRepo().dir ?? path.join(WIN, 'Nyx-Android-not-found')

const { SYNC_TABLES } = await import(
  pathToFileURL(path.join(WIN, 'src/core/sync-tables.ts')).href
)
const SYNCED = new Set(SYNC_TABLES)

/** 审过的例外 —— `文件:表` → 为什么可以留 */
const ALLOW = new Map([
  ['src/core/cascade.ts', '立墓碑的那条路本身'],
  ['src/main/export.ts', '整库擦除 / 导回备份，走 markWiped 另一套语义'],
  ['src/main/factory-reset.ts', '恢复出厂，同上'],
  ['src/main/db/migrations.ts', '升级脚本，跑在同步之外'],
  /**
   * ★ T-4.6（2026-09-06）· 迁移正文拆进了 `db/migrations/` 下按版本分的几个文件。
   *   写成**目录前缀**（末尾那个 `/`）而不是逐个列文件名：豁免的理由是
   *   「这是升级脚本，跑在同步之外」——它对每一版都成立，也对以后新开的那一段成立。
   *   逐个列的话，下次加一段迁移就会莫名其妙地红一次，而红的原因和那段迁移无关。
   */
  ['src/main/db/migrations/', '升级脚本，跑在同步之外（T-4.6 拆分后的每一段）'],
  ['src/main/study.ts', 'D-436：questions / analysis_blocks 是派生数据，两端各自会重出，自愈'],
  /** ★ T-4.6（2026-09-06）· study.ts 拆成了入口 + study/ 下六个领域，那两处删除跟着搬了；理由同上 */
  ['src/main/study/', 'D-436：questions / analysis_blocks 是派生数据，两端各自会重出，自愈（T-4.6 拆分后的各领域）'],
  ['src/db/practice.ts', 'D-436：questions 同上（Android 侧同一条语句）'],
  ['src/ui/lib/dev-seed.ts', '开发期造数据用的，不上真机流程'],
  [
    'src/core/move-items.ts',
    '★ 已知缺陷 D-436③：移动会删掉旧的 item_lectures 行，那个删除传不过去 —— '
      + '另一端会两边都留着。修法要动 TOMBSTONE_KINDS 或加软删列，等单独一轮'
  ]
])

const RX = /delete\s+from\s+["'`]?([a-z_]+)["'`]?/gi

function walk(root, sub) {
  const out = []
  const dir = path.join(root, sub)
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(sub, e.name)
    if (e.isDirectory()) out.push(...walk(root, rel))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
  }
  return out
}

const bad = []
let scanned = 0
for (const [root, subs, label] of [
  [WIN, ['src/main', 'src/core'], 'Windows'],
  [AND, ['src/db', 'src/ui'], 'Android']
]) {
  if (!fs.existsSync(root)) {
    console.log(`（找不到 ${label} 仓库，跳过）`)
    continue
  }
  for (const sub of subs) {
    for (const rel of walk(root, sub)) {
      scanned++
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      for (const m of text.matchAll(RX)) {
        const table = m[1]
        if (!SYNCED.has(table)) continue
        // 名单里既可以写整个文件，也可以写一个目录前缀（末尾带 `/`）
        if ([...ALLOW.keys()].some((k) => (k.endsWith('/') ? rel.startsWith(k) : rel === k))) continue
        const line = text.slice(0, m.index).split('\n').length
        bad.push({ label, rel, line, table })
      }
    }
  }
}

if (bad.length) {
  console.error('✗ 同步表上出现了没审过的裸 delete —— 这种删除传不到另一台设备（D-435/D-436）：')
  for (const b of bad) console.error(`   ${b.label} ${b.rel}:${b.line} → delete from ${b.table}`)
  console.error('\n  要么别用裸 delete（软删 / 走 cascade.hardDelete），')
  console.error('  要么想清楚为什么这个删除不需要传过去，再加进 scripts/check-hard-deletes.mjs 的名单。')
  process.exit(1)
}
console.log(`✓ 扫了 ${scanned} 个文件，同步表上没有新的裸 delete（已审例外 ${ALLOW.size} 处）`)
