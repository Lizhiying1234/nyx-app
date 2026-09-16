/**
 * 把源码里每一条 `insert` / `update` 的**列名**对着真实表结构核一遍。
 *
 * ── 为什么要有这一条 ────────────────────────────────────────
 *
 * I-112：`settings` 只有 key / value / updated_at 三列，我在两处写成了四列。
 * `svelte-check` 322 个文件 0 错误 —— 因为 SQL 是字符串，类型系统在这一层是瞎的。
 * 后果分两种，第二种才是要命的：
 *   · `prompt-sync` 那处：软件**启动就炸**，一眼看得见
 *   · `setQtypes` 那处：**他点到题型复选框才炸**。静态检查、单元测试、
 *     截图全绿，坏的地方要等他自己撞上去
 *
 * 「等他撞上去」正是这个项目最不能有的东西 —— 他零编程经验，
 * 撞上去只会得到一句看不懂的英文报错。
 *
 * ── 判据 ────────────────────────────────────────────────────
 *
 * 只查**列名写得明明白白**的那些，宁可漏不可吵：
 *   ① `insert into T (a, b, c)` —— 列清单是显式的
 *   ② `update T set a = ?, b = ?` —— 同上
 *   ③ `on conflict(...) do update set a = ...`
 * 表名是变量拼出来的（`"${t}"`）一律跳过 —— 那种查不了，也没炸过。
 *
 * 表结构从迁移脚本解析（`schema-from-migrations.mjs`）。
 * **解析器自己有测试**：`tests/db-safety.ts` 里拿真迁移出来的库逐列比对。
 *
 * 用法：node scripts/check-sql.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schemaFromMigrations } from './schema-from-migrations.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tables = schemaFromMigrations()

if (tables.size < 10) {
  console.error(`check:sql　只解析出 ${tables.size} 张表 —— 解析器多半坏了，不敢放行`)
  process.exit(1)
}
/**
 * 有看不懂的动态 DDL 就**当场停**，不带着一份残缺的表结构往下查。
 * 残缺的表结构会产出一堆假报警 —— 而假报警比不检查更糟：
 * 报几次之后人就不看了，真的那条也一起被忽略。
 */
if (tables.unresolved?.length) {
  console.error('check:sql　这几条动态 DDL 解析不了，表结构不完整：')
  for (const u of tables.unresolved) console.error('  ' + u)
  process.exit(1)
}

/** 递归收集 .ts */
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = [...walk(join(root, 'src', 'main')), ...walk(join(root, 'tests'))]

const problems = []

/** 某个位置在第几行 */
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length

function check(file, src, table, cols, idx, what) {
  const known = tables.get(table)
  if (!known) {
    // 表都不认识：可能是解析漏了，报出来让人看一眼，但不判失败
    problems.push({ file, line: lineOf(src, idx), level: 'warn', msg: `不认识的表 \`${table}\`` })
    return
  }
  for (const c of cols) {
    if (!known.has(c)) {
      problems.push({
        file,
        line: lineOf(src, idx),
        level: 'error',
        msg: `${what} \`${table}\` 没有列 \`${c}\`　（它有：${[...known].join(', ')}）`
      })
    }
  }
}

/**
 * ★ 先把注释剃掉再扫。
 *
 * V25 那段注释里写着「以前这么写会撞主键」的**反面例子**，
 * 这把尺子当场把它当成真代码报了错。逼着后人「为了让检查过去
 * 而不敢在注释里写清原因」，比不检查更坏。
 *
 * 用空格换掉（不是删掉），行号才不会错位 —— 报错要指得回原处。
 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))

for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'))
  const rel = relative(root, f).replace(/\\/g, '/')

  // ① insert into T (a, b, c)
  for (const m of src.matchAll(/insert\s+(?:or\s+\w+\s+)?into\s+([a-z_][\w]*)\s*\(([^)]*)\)/gi)) {
    const cols = m[2]
      .split(',')
      .map((x) => x.trim().replace(/["`]/g, ''))
      .filter((x) => /^[a-z_][\w]*$/i.test(x))
    check(rel, src, m[1], cols, m.index, 'insert 的')
  }

  // ② update T set a = ?, b = ?　（到 where / 结尾为止）
  for (const m of src.matchAll(/update\s+([a-z_][\w]*)\s+set\s+([\s\S]*?)(?:\bwhere\b|`)/gi)) {
    const cols = [...m[2].matchAll(/([a-z_][\w]*)\s*=/gi)]
      .map((x) => x[1])
      .filter((x) => x.toLowerCase() !== 'excluded')
    check(rel, src, m[1], cols, m.index, 'update 的')
  }

  // ③ on conflict(...) do update set a = ...
  for (const m of src.matchAll(/on\s+conflict\s*\([^)]*\)\s*do\s+update\s+set\s+([\s\S]*?)(?:\bwhere\b|`)/gi)) {
    // 往前找最近的 insert into T
    const before = src.slice(0, m.index)
    const ins = [...before.matchAll(/insert\s+(?:or\s+\w+\s+)?into\s+([a-z_][\w]*)/gi)].pop()
    if (!ins) continue
    const cols = [...m[1].matchAll(/([a-z_][\w]*)\s*=/gi)]
      .map((x) => x[1])
      .filter((x) => x.toLowerCase() !== 'excluded')
    check(rel, src, ins[1], cols, m.index, 'on conflict 的')
  }
}

/**
 * ★★★ 第二段 · **历史迁移不许引用会变的偏好白名单**（T-2.12 / I-149）
 *
 * ── 病 ─────────────────────────────────────────────────────
 *
 * V29 原来写的是 `for (const spec of PREF_SPECS)` —— 遍历**当前**白名单。
 * 于是 T-7.9 退役三把语音键的那天，一条**已经写完、已经在他机器上跑过**的
 * 迁移，行为跟着变了，而没有人改过 V29 一个字。
 * D-216「编号迁移不回头改」以前只管「别去编辑旧迁移」，
 * 管不住「旧迁移自己引用了会变的常量」——这一段把那半边补上。
 *
 * ── 判据 ───────────────────────────────────────────────────
 *
 * `src/main/db/migrations/` 下面的源码里**不许出现** `PREF_SPECS` / `PREF_KEYS`
 * （注释已经被 `stripComments` 换成空格，所以头注里提它们不算）。
 * 要搬哪几把键，各条迁移自己冻一份字面量（见 `v20-v29.ts::V29_PREFS`）。
 *
 * ★ 只管这两个名字，**不是**「迁移里不许 import 任何 core 常量」——
 *   `SYNC_TABLES` / `IDENTITY_SPECS` / `PARAM_SPEC` / `QTYPES` 也是同一类耦合，
 *   但那几处该不该冻要一条条看（已报给主控），一次全禁只会逼人去绕。
 * ★ 负向对照：把 `V29_PREFS` 换回 `PREF_SPECS` 遍历 → 这一段当场红。
 */
const FROZEN_NAMES = ['PREF_SPECS', 'PREF_KEYS']
const migrationDir = join(root, 'src', 'main', 'db', 'migrations')
const frozenProblems = []
for (const f of walk(migrationDir)) {
  const src = stripComments(readFileSync(f, 'utf8'))
  // D-460 · 反斜杠绕开写：这里只是把 Windows 的路径分隔符换成 /
  const rel = relative(root, f).split(String.fromCharCode(92)).join('/')
  for (const name of FROZEN_NAMES) {
    const at = src.indexOf(name)
    if (at < 0) continue
    frozenProblems.push(
      `${rel}:${lineOf(src, at)}　历史迁移里出现了 ${name} —— ` +
        '白名单一改，一条已经写完的迁移行为就跟着改（D-216 / I-149）。' +
        '把这条迁移要搬的键冻成字面量，照 `v20-v29.ts::V29_PREFS` 那样写。'
    )
  }
}

const errors = problems.filter((p) => p.level === 'error')
const warns = problems.filter((p) => p.level === 'warn')

// ★ 红的时候不许还挂着 ✔ —— 一行说着「通过」的汇总比没有汇总更坏
console.log(
  `check:sql　${tables.size} 张表 · 扫了 ${files.length} 个文件 · ` +
    (frozenProblems.length === 0 ? '迁移键面冻结 ✔' : `迁移键面冻结 ✖ ${frozenProblems.length} 处`)
)
for (const p of frozenProblems) console.log(`  ✖ ${p}`)
if (frozenProblems.length > 0) {
  console.error(
    `
✖ ${frozenProblems.length} 处历史迁移引用了当前的偏好白名单。` +
      '这类错谁都看不见：迁移早就跑过了，行为却还会跟着白名单变。'
  )
  process.exit(1)
}
for (const p of warns) console.log(`  提醒 ${p.file}:${p.line}　${p.msg}`)
for (const p of errors) console.log(`  ✖ ${p.file}:${p.line}　${p.msg}`)

if (errors.length > 0) {
  console.error(`\n✖ ${errors.length} 处列名对不上表结构。这类错静态检查看不见，会等他点到才炸。`)
  process.exit(1)
}
console.log('✔ 通过')
