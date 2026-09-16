#!/usr/bin/env node
/**
 * check:ipc-guard · 渲染层每一次 IPC 调用都要有看得见的失败路径 · H-4c
 *
 * ══ 为什么要有这道闸 ═══════════════════════════════════════════
 *
 * H-4a 之前实测过一次真实的 IPC 拒绝：页面文字长度 451 → 451，
 * 屏幕上零变化，唯一的痕迹落在 `nyx.log` —— 而他不看日志。
 * H-4a 装了最外层的网，但网只保证「不至于完全看不见」；
 * **每个按钮自己该说什么话，仍然要各自写**，而写没写全凭记性。
 *
 * 「靠记得」这件事在这个项目里已经翻过车四次（第九节）。所以判据要变成代码。
 *
 * ══ 一、什么算一次 IPC 调用 ═══════════════════════════════════
 *
 * `CallExpression`，其 callee 是一条以 `window.nyx` 打头的 `MemberExpression` 链。
 * 判据落在 **AST 节点类型**上，不是字符串 —— 所以：
 *   · TS 类型位置里的 `typeof window.nyx.x.y` 不算（那是 TSTypeQuery，不是 MemberExpression）
 *   · 注释里出现的 `window.nyx.ledger.list` 不算（注释根本不进 AST）
 * 这两种情况都真实存在过，字符串扫描会把它们当成调用（上一版就误报了 3 处）。
 *
 * 另有一类单独处理：**引用了 `window.nyx.*` 却没有立刻调用**
 * （赋给变量、当回调传出去、解构）。这类静态上判不了它最终在哪儿被调，
 * 一律记为 `indirect`，必须写白名单。当前代码里是 0 处。
 *
 * ══ 二、什么算「被覆盖」 ══════════════════════════════════════
 *
 * 四种，满足任意一种即可：
 *
 * ① **try/catch**：祖先里有 `TryStatement`，调用在它的 `block` 内，
 *    **且这个 try 有 `handler`**。只有 `finally` 的不算 —— 它不接错误，只做清理。
 *    **且从调用点到那个 try 之间没有跨过函数边界**。
 *    跨了就不算，因为那多半是延迟执行（`setTimeout` / `.then` / 事件回调 /
 *    异步 IIFE），真到抛的时候 try 早就出栈了 —— 这种「看着被包住、
 *    实际接不到」的写法，正是静态检查最容易放过去的一种。
 *
 * ② **统一 guard 包装**：调用写在一个函数字面量里，而这个函数字面量是
 *    某次调用的实参，被调的那个函数是**本文件里经过验证的 guard**。
 *    「经过验证」= 它自己的 body 里有带 handler 的 try，并且在 try 内
 *    调用了它自己的某个形参。**不认名字，认结构** ——
 *    叫 `act` 但里面没有 try 的函数不算数。
 *
 * ③ **`.catch(handler)`**：promise 链上挂了 catch，**且 handler 的 body 非空**。
 *    空 body（或只有注释）算「静默吞掉」，见下。
 *
 * ④ **白名单**：写在 `scripts/ipc-guard-allow.json`，逐条五个字段。
 *
 * ══ 三、`.catch(() => {})` 为什么单独算一类 ═══════════════════
 *
 * 它在语法上「处理了」错误，在使用者那里等于什么都没发生 ——
 * 和裸调用的后果一模一样，只是更难被发现（看代码像是想过了）。
 * 所以空 handler 判为 `silent`，必须进白名单并写清「为什么允许静默」。
 * 有意静默是合法的（比如「没有缓存不是错误」），但必须是**明写的决定**。
 *
 * ══ 四、白名单的门槛 ═════════════════════════════════════════
 *
 * `scripts/ipc-guard-allow.json`，键是 `相对路径:行号:调用名`，值必须有五个字段：
 *   调用 / 原因 / 为什么失败不需要用户知道 / 为什么不会导致错误状态 / 为什么允许静默
 * 任何一条留空或缺字段 → **检查失败**。写不出理由的，就不是白名单，是 bug。
 * 行号会漂，所以键匹配是「文件 + 调用名」优先、行号只用来提示；
 * 同一文件同一调用出现多次时按出现顺序编号（`#2`、`#3`）。
 *
 * ══ 五、这套检查保证什么、不保证什么 ═══════════════════════════
 *
 * **保证**（在解析得到的 AST 上是完备的）：
 *   · 每一处**直接**的 `window.nyx.x.y(...)` 都会被看到，一个不漏
 *   · 「被 try 包住但跨了函数边界」这种假覆盖会被判为未覆盖
 *   · guard 包装必须真的有 try，光名字对不算
 *
 * **不保证**（近似，已知的口子，都会在报告里显式列出）：
 *   · catch 里到底有没有**让他看见** —— 只验 body 非空，验不了「他看得见」
 *   · 跨文件传出去的 `window.nyx.*` 引用（`indirect` 类，现在是 0，出现即拦）
 *   · 解构之后再调用（`const { data } = window.nyx; data.tree()`）——
 *     现在代码里没有，出现了这个检查看不见。这是这道闸最大的一个口子，
 *     写在这里是为了下次有人这么写的时候，至少有据可查
 *   · 主进程侧的错误分级（那是 R-1 管的，不在这道闸里）
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { parse } from 'svelte/compiler'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'renderer', 'src')
const ALLOW_PATH = join(ROOT, 'scripts', 'ipc-guard-allow.json')

const ALLOW_FIELDS = [
  '调用',
  '原因',
  '为什么失败不需要用户知道',
  '为什么不会导致错误状态',
  '为什么允许静默'
]

/** 会把函数推迟到「以后」再跑的东西 —— 跨过它们，外面的 try 就接不到了 */
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression'
])

// ── 解析 ────────────────────────────────────────────────────────

/** 把任何一份渲染层源码变成一棵能走的 AST。`.ts` 包一层 script 标签，用同一个解析器。 */
function toAst(file, src) {
  if (file.endsWith('.svelte')) return { ast: parse(src, { modern: true, filename: file }), offset: 0 }
  const prefix = '<script lang="ts">\n'
  const wrapped = `${prefix}${src}\n</script>`
  return { ast: parse(wrapped, { modern: true, filename: file }), offset: prefix.length }
}

/** 深走整棵树（含模板里的表达式），带父链。 */
function walk(node, visit, parents = []) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, parents)
    return
  }
  if (typeof node.type === 'string') {
    visit(node, parents)
    const next = [...parents, node]
    for (const [k, v] of Object.entries(node)) {
      if (k === 'type' || k === 'loc' || k === 'parent') continue
      walk(v, visit, next)
    }
    return
  }
  for (const v of Object.values(node)) walk(v, visit, parents)
}

/** `window.nyx.a.b` → 'a.b'；不是这条链就返回 null */
function nyxPath(node) {
  if (!node || node.type !== 'MemberExpression') return null
  const parts = []
  let cur = node
  while (cur && cur.type === 'MemberExpression') {
    if (cur.computed) return null
    parts.unshift(cur.property.name ?? cur.property.value)
    cur = cur.object
  }
  // 允许 `window.nyx?.store?.openFolder` 这种可选链写法
  if (cur && cur.type === 'Identifier' && cur.name === 'window' && parts[0] === 'nyx') {
    return parts.slice(1).join('.')
  }
  return null
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

// ── 判据 ────────────────────────────────────────────────────────

/**
 * 本文件里哪些函数是**验证过的** guard：
 * 自己 body 里有带 handler 的 try，且在 try 内调用了自己的形参。
 */
function verifiedGuards(root) {
  const names = new Set()
  walk(root, (n) => {
    if (!FUNCTION_TYPES.has(n.type)) return
    const params = new Set(n.params.map((p) => (p.type === 'Identifier' ? p.name : null)).filter(Boolean))
    if (params.size === 0) return
    let ok = false
    walk(n.body, (t, ps) => {
      if (t.type !== 'CallExpression') return
      if (t.callee.type !== 'Identifier' || !params.has(t.callee.name)) return
      // 这一次「调用形参」必须发生在带 handler 的 try 里
      if (ps.some((p) => p.type === 'TryStatement' && p.handler)) ok = true
    })
    if (!ok) return
    // 名字：函数声明用自己的名字，箭头函数用被赋给的变量名
    if (n.type === 'FunctionDeclaration' && n.id) names.add(n.id.name)
    else {
      const holder = n.__holder
      if (holder) names.add(holder)
    }
  })
  return names
}

/** 给箭头函数补上「它被赋给了谁」—— verifiedGuards 要用 */
function tagHolders(root) {
  walk(root, (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init && FUNCTION_TYPES.has(n.init.type)) {
      n.init.__holder = n.id.name
    }
  })
}

/**
 * Svelte 的 `{#await ... }{:catch}` 也是一条真的失败路径。
 * 漏掉它会误报 —— H-4a 自己写的 `{#await window.nyx.app.buildInfo()}…{:catch}`
 * 第一版就被这个检查冤枉了一次。
 */
function coveredByAwaitBlock(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]
    if (FUNCTION_TYPES.has(p.type)) return false
    if (p.type === 'AwaitBlock' && p.catch) return true
  }
  return false
}

/** 从调用点往上找：有没有一个「真的接得住」的 try */
function coveredByTry(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]
    // 先撞到函数边界 → 外面的 try 接不到这一次（延迟执行）
    if (FUNCTION_TYPES.has(p.type)) return false
    if (p.type !== 'TryStatement' || !p.handler) continue
    // 必须是在 block 里，不能是在 handler / finalizer 里（那是收拾现场，不受这层 try 保护）
    const child = parents[i + 1]
    if (child && p.block === child) return true
  }
  return false
}

/** 调用写在一个函数字面量里，而那个函数字面量被交给了本文件验证过的 guard */
function coveredByGuard(parents, guards) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]
    if (!FUNCTION_TYPES.has(p.type)) continue
    const owner = parents[i - 1]
    if (!owner || owner.type !== 'CallExpression') return false
    if (!owner.arguments.includes(p)) return false
    if (owner.callee.type === 'Identifier' && guards.has(owner.callee.name)) return true
    return false
  }
  return false
}

/**
 * promise 链上有没有 `.catch(h)`。
 * 返回 'none' | 'silent'（h 的 body 空）| 'handled'
 */
function catchOnChain(call, parents) {
  let node = call
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]
    if (p.type === 'MemberExpression' && p.object === node) {
      node = p
      continue
    }
    if (p.type === 'CallExpression' && p.callee === node) {
      const name = node.type === 'MemberExpression' && !node.computed ? node.property.name : null
      if (name === 'catch') {
        const h = p.arguments[0]
        if (!h || !FUNCTION_TYPES.has(h.type)) return 'handled'
        const body = h.body
        if (body.type === 'BlockStatement') return body.body.length === 0 ? 'silent' : 'handled'
        return 'handled'
      }
      node = p
      continue
    }
    break
  }
  return 'none'
}

// ── 跑 ──────────────────────────────────────────────────────────

function collectFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...collectFiles(p))
    else if (e.name.endsWith('.svelte') || e.name.endsWith('.ts')) out.push(p)
  }
  return out.sort()
}

function scan() {
  const findings = []
  for (const file of collectFiles(SRC)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const src = readFileSync(file, 'utf8')
    let ast
    try {
      ;({ ast } = toAst(file, src))
    } catch (err) {
      findings.push({ rel, line: 0, call: '(解析失败)', kind: 'parse-error', detail: String(err) })
      continue
    }
    tagHolders(ast)
    const guards = verifiedGuards(ast)
    const seen = new Map()

    walk(ast, (n, parents) => {
      if (n.type !== 'MemberExpression') return
      const path = nyxPath(n)
      if (path === null) return
      const parent = parents[parents.length - 1]
      // 只处理**链尾**：`window.nyx.data.tree` 里的 `window.nyx.data` 不单独算
      if (parent && parent.type === 'MemberExpression' && parent.object === n) return

      const line = lineOf(src, n.start ?? 0)
      const isCall = parent && parent.type === 'CallExpression' && parent.callee === n
      const n2 = seen.get(path) ?? 0
      seen.set(path, n2 + 1)
      const key = `${rel}:${path}${n2 > 0 ? `#${n2 + 1}` : ''}`

      if (!isCall) {
        findings.push({ rel, line, call: path || '(整个 window.nyx)', key, kind: 'indirect' })
        return
      }
      const callParents = [...parents]
      if (coveredByTry(callParents)) return
      if (coveredByGuard(callParents, guards)) return
      if (coveredByAwaitBlock(callParents)) return
      const c = catchOnChain(parent, parents.slice(0, -1))
      if (c === 'handled') return
      findings.push({ rel, line, call: path, key, kind: c === 'silent' ? 'silent-catch' : 'naked' })
    })
  }
  return findings
}

/**
 * 两份名单，性质完全不同：
 *   allow —— **永久豁免**，五个字段必须写满
 *   debt  —— **已知欠账**，等 H-4b 逐处收口。闸门放行，但只出不进：
 *            新长出来的裸调用不在 debt 里，一定会红。这是一把只能往下走的棘轮
 */
function loadAllow() {
  if (!existsSync(ALLOW_PATH)) return { entries: {}, debt: {}, bad: [] }
  const raw = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'))
  const entries = raw.allow ?? {}
  const debt = Object.fromEntries(
    Object.entries(raw.debt ?? {}).filter(([k]) => !k.startsWith('$'))
  )
  const bad = []
  for (const [k, v] of Object.entries(entries)) {
    if (k.startsWith('$')) continue
    for (const f of ALLOW_FIELDS) {
      if (typeof v?.[f] !== 'string' || v[f].trim().length === 0) {
        bad.push(`${k} 缺「${f}」`)
      }
    }
  }
  for (const [k, v] of Object.entries(debt)) {
    if (typeof v !== 'string' || v.trim().length === 0) {
      bad.push(`欠账 ${k} 没写清「失败时他会看到什么」`)
    }
  }
  const both = Object.keys(entries).filter((k) => k in debt)
  for (const k of both) bad.push(`${k} 同时出现在 allow 和 debt 里 —— 它到底是合法的还是欠着的？`)
  return { entries, debt, bad }
}

const findings = scan()
const { entries: allow, debt, bad: badAllow } = loadAllow()

const unlisted = findings.filter((f) => !(f.key in allow) && !(f.key in debt))
const listed = findings.filter((f) => f.key in allow)
const owed = findings.filter((f) => f.key in debt)
const stale = [...Object.keys(allow), ...Object.keys(debt)].filter(
  (k) => !k.startsWith('$') && !findings.some((f) => f.key === k)
)

const label = { naked: '裸调用（失败时屏幕上什么都没有）', 'silent-catch': '静默吞掉（.catch 空 body）', indirect: '间接引用（静态判不了）', 'parse-error': '解析失败' }

console.log(
  `check:ipc-guard　扫了 ${collectFiles(SRC).length} 个文件 · ` +
    `需要交代的调用 ${findings.length} 处 · 永久豁免 ${listed.length} · 欠账 ${owed.length}`
)

let failed = false

if (unlisted.length) {
  failed = true
  console.log(`\n✖ ${unlisted.length} 处 IPC 调用没有可验证的失败路径，也不在白名单里：\n`)
  const byFile = new Map()
  for (const f of unlisted) byFile.set(f.rel, [...(byFile.get(f.rel) ?? []), f])
  for (const [rel, list] of byFile) {
    console.log(`  ${rel}`)
    for (const f of list) console.log(`    :${f.line}  ${f.call}　${label[f.kind]}　key=${f.key}`)
  }
  console.log(
    `\n  要么给它一条看得见的失败路径（try/catch · 统一 guard · 非空 .catch），` +
      `\n  要么写进 scripts/ipc-guard-allow.json 并逐条交代 ${ALLOW_FIELDS.length} 个字段。`
  )
}

if (badAllow.length) {
  failed = true
  console.log(`\n✖ 白名单有 ${badAllow.length} 条没写清楚（写不出理由的就不是白名单，是 bug）：`)
  for (const b of badAllow) console.log(`    ${b}`)
}

if (owed.length) {
  console.log(
    `\n· 欠账 ${owed.length} 处 —— H-4b 逐处收口，每收一处从 ipc-guard-allow.json 的 debt 里删一行。` +
      `\n  闸门放行它们，但**只出不进**：新长出来的裸调用不在 debt 里，一定会红。`
  )
}

if (stale.length) {
  console.log(`\n· 名单里有 ${stale.length} 条已经不对应任何调用了（改完记得删）：`)
  for (const k of stale) console.log(`    ${k}`)
}

if (!failed) console.log('\n✔ 通过')
process.exit(failed ? 1 : 0)
