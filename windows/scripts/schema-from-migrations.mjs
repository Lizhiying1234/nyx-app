/**
 * 从迁移脚本里解析出「每张表到底有哪些列」。
 *
 * 为什么需要它：SQL 是**字符串**，TypeScript 在这一层是瞎的。
 * `settings` 只有 key / value / updated_at 三列，我在两处写成了四列 ——
 * `svelte-check` 322 个文件 0 错误，软件启动直接炸
 * （`table settings has no column named created_at`），
 * 另一处更糟：**他一点题型复选框才炸**，静态检查永远看不见。
 *
 * 这份解析出来的结构给 `check-sql.mjs` 用。
 * 解析本身也会被验证 —— `tests/db-safety.ts` 里有一条用例把它和
 * **真正迁移出来的数据库** 逐列比对，对不上就红。
 * 不这么做的话，解析器自己漂了，检查就变成一张永远绿的安慰牌。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 具名常量数组可能不在 `migrations.ts` 里 —— 协议事实已经搬进 core。
 * 这里按顺序找，找到第一个就用。
 */
const EXTRA_SOURCES = [
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'sync-tables.ts'),
  join(process.cwd(), 'src', 'core', 'sync-tables.ts')
]
import { fileURLToPath } from 'node:url'

/**
 * 找 migrations.ts。
 *
 * 两条路都要留：命令行跑时按脚本自己的位置找；
 * 被 `tests/db-safety.ts` 引用时它已经被打包进 `out/main/`，
 * `import.meta.url` 指向 out 里面，那条路是死的 —— 退回 cwd。
 * （第一次就栽在这儿：ENOENT `out/src/main/db/migrations.ts`。）
 */
function findMigrations() {
  const rel = join('src', 'main', 'db', 'migrations.ts')
  const byScript = join(dirname(fileURLToPath(import.meta.url)), '..', rel)
  if (existsSync(byScript)) return byScript
  const byCwd = join(process.cwd(), rel)
  if (existsSync(byCwd)) return byCwd
  throw new Error(`找不到 migrations.ts（试过 ${byScript} 和 ${byCwd}）`)
}

/**
 * ★ T-4.6（2026-09-06）· 迁移正文拆进了 `db/migrations/vNN-vMM.ts`，
 *   `migrations.ts` 本身只剩拼装 —— 只读它会解析出**零张表**。
 *   （这一条真的发生过：拆完第一次跑，`check:sql` 报「只解析出 0 张表，
 *   解析器多半坏了，不敢放行」，`test:db` 那条对拍用例同时红。
 *   那个「0 张表就拒绝放行」的设计救了这一次 —— 否则它会安静地全绿。）
 *
 *   所以这里读入口 **加上** `migrations/` 目录下的每一个文件。
 *   新开一段迁移文件不用回来改这里。
 */
function migrationSources() {
  const entry = findMigrations()
  const dir = join(dirname(entry), 'migrations')
  const files = [entry]
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) if (f.endsWith('.ts')) files.push(join(dir, f))
  }
  return files
}

/** @returns {Map<string, Set<string>>} 表名 → 列名集合 */
export function schemaFromMigrations() {
  const src = migrationSources()
    .map((f) => readFileSync(f, 'utf8'))
    .join(String.fromCharCode(10))
  const tables = new Map()

  // ── create table [if not exists] X ( ... ) ───────────────────
  const CREATE = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][\w]*)\s*\(/gi
  for (const m of src.matchAll(CREATE)) {
    const name = m[1]
    // 从左括号起做括号配平 —— 列定义里有 `references x(id)`、`default (0)` 这类嵌套
    let i = m.index + m[0].length
    let depth = 1
    let body = ''
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      if (depth > 0) body += c
      i++
    }
    const cols = tables.get(name) ?? new Set()
    for (const line of splitTopLevel(body)) {
      const t = line.trim()
      if (!t) continue
      // 跳过表级约束
      if (/^(primary|unique|foreign|check|constraint)\b/i.test(t)) continue
      const col = t.match(/^["`]?([a-z_][\w]*)["`]?\s/i)
      if (col) cols.add(col[1])
    }
    tables.set(name, cols)
  }

  // ── alter table X add column Y ───────────────────────────────
  const ALTER = /alter\s+table\s+([a-z_][\w]*)\s+add\s+column\s+["`]?([a-z_][\w]*)/gi
  for (const m of src.matchAll(ALTER)) {
    const cols = tables.get(m[1]) ?? new Set()
    cols.add(m[2])
    tables.set(m[1], cols)
  }

  /**
   * ── 表名是变量的那些 ────────────────────────────────────────
   *
   * V9 是**遍历 SYNC_TABLES** 给每张表加 `uid`：
   *     for (const t of SYNC_TABLES) db.exec(`alter table "${t}" add column uid text`)
   * 正则看不见变量表名，于是 `items.uid` 在解析结果里不存在，
   * 第一次跑这个检查就误报了一条。
   *
   * 所以这里把「循环里的 alter」也认出来：抓出循环变量对应的表名清单
   * （`SYNC_TABLES` 这个数组，或者就地写死的数组），再逐张加列。
   * 认不出清单就**不静默跳过** —— 记一笔 unresolved，让调用方报出来。
   */
  const unresolved = []
  const DYN = /alter\s+table\s+["`]?\$\{(\w+)\}["`]?\s+add\s+column\s+["`]?([a-z_][\w]*)/gi
  for (const m of src.matchAll(DYN)) {
    const list = listBehind(src, m.index, m[1])
    if (!list) {
      unresolved.push(m[0])
      continue
    }
    for (const name of list) {
      const cols = tables.get(name) ?? new Set()
      cols.add(m[2])
      tables.set(name, cols)
    }
  }
  /**
   * ── 表重建（`create X__new` → `drop X` → `rename X__new to X`）★ ──────
   *
   * SQLite 改主键只能整表重建。V27 就是这么把 `genres` / `qtypes`
   * 换成 uid 主键的（R-3-h）。
   *
   * 不认这一步的话，尺子会**同时**留着两张表：`genres`（旧列，还带 `id`）
   * 和 `genres__new`（新列）。于是 `check:sql` 拿着一份**已经不存在的表结构**
   * 去量真库 —— 它会以为 `genres.id` 还在，写 `where id = ?` 的新代码不会被拦下，
   * 而那正是这条检查存在的理由。**一把量错的尺子比没有尺子更坏。**
   *
   * 所以：重命名 = 把源表的列集整个搬到目标表名下，源表名随之消失。
   * 按出现顺序处理，多次重建也能跟得上。
   */
  const RENAME = /alter\s+table\s+["`]?([a-z_][\w]*)["`]?\s+rename\s+to\s+["`]?([a-z_][\w]*)["`]?/gi
  for (const m of src.matchAll(RENAME)) {
    const [, from, to] = m
    if (!tables.has(from)) {
      unresolved.push(m[0])
      continue
    }
    tables.set(to, tables.get(from))
    tables.delete(from)
  }

  tables.unresolved = unresolved

  return tables
}

/**
 * 往回找这个循环变量遍历的是哪一串表名。
 * 支持两种写法，项目里就这两种：
 *   `for (const t of SYNC_TABLES)`
 *   `for (const t of ['term_ledger', 'ops_log'])`
 */
function listBehind(src, idx, varName) {
  const before = src.slice(0, idx)
  const loop = [...before.matchAll(new RegExp(`for\\s*\\(\\s*const\\s+${varName}\\s+of\\s+([^)]+)\\)`, 'g'))].pop()
  if (!loop) return null
  const expr = loop[1].trim()

  const inline = expr.match(/^\[([^\]]*)\]$/)
  if (inline) {
    return inline[1]
      .split(',')
      .map((x) => x.trim().replace(/^['"`]|['"`]$/g, ''))
      .filter(Boolean)
  }

  if (/^[A-Z_]+$/.test(expr)) {
    /**
     * 具名常量数组：`export const SYNC_TABLES = [ 'projects', … ] as const`
     *
     * ★★ 2026-08-23：`SYNC_TABLES` **搬去了 `src/core/sync-tables.ts`**
     *   （它是协议事实，不是平台事实 —— 见那个文件的头）。
     *   所以先在 `migrations.ts` 里找，找不到再去 core 里找。
     *
     *   不这么做的后果不是「少查几条」，是 `check:sql` **当场判红**
     *   （解析不了动态 DDL → 表结构不完整 → 拒绝带着残缺结构往下查）。
     *   这条路我真的踩过一次：搬完之后 verify 就红了，而我那次是用
     *   `npm run verify | tail -30; echo $?` 看的 —— `$?` 取的是 tail 的退出码，
     *   永远是 0，于是报出去的是「PASS」。**管道会吃掉退出码。**
     */
    const re = new RegExp(`const\\s+${expr}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`)
    let decl = src.match(re)
    if (!decl) {
      for (const extra of EXTRA_SOURCES) {
        if (!existsSync(extra)) continue
        decl = readFileSync(extra, 'utf8').match(re)
        if (decl) break
      }
    }
    if (!decl) return null
    return [...decl[1].matchAll(/['"]([a-z_][\w]*)['"]/g)].map((x) => x[1])
  }
  return null
}

/** 按顶层逗号切列定义（括号内的逗号不算） */
function splitTopLevel(body) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of body) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  // 去掉 SQL 行注释
  return out.map((x) => x.replace(/--[^\n]*/g, ''))
}
