#!/usr/bin/env node
/**
 * ══ Java 业务 SQL 闸（T-6.2）════════════════════════════════════
 *
 * **原生层不许自己查库。** 判据在 core / `src/db/*`，Java 只做采集与渲染
 * （D-238 / D-365：core 只有一份，判据不在平台层；ARCHITECTURE LOCKED 第 2 条）。
 *
 * ── 它挡的是哪一种事故（这道闸是有价的）────────────────────────
 *
 * T-6.1 之前，`NyxAssistService.java` 里有两处**自己写的判据**：
 *
 *   ① `queryL0()`  —— 一句 `select … from items … item_lectures il …`，
 *      注释写着「与 capture.ts::assistStatus 同源」。**它漂了**：漏了
 *      `il.deleted_at is null`。V36 起「把一条知识点从这一讲移出去」是软删、
 *      行还在，于是词已经移出去了，气泡还报着那一讲的名字。
 *   ② `saveLayer()` —— 去 `settings` 里读「他上一次选的层」当默认保存层，
 *      与使用者 2026-09-01 裁决 ⑩「默认 A、不记忆上一次」正相反。
 *
 * 两处的共同形状不是「写错了」，是**同一件事有第二把尺子**：改一边不报错，
 * 只会让两处给出不同答案。T-6.1 把它们收回引擎；这道闸负责让它们回不来。
 *
 * ★★ 注意 ② 落在 `settings` 上，而 `settings` **不是同步表**
 *    （`sync-tables.ts` 明写它被排除：里面有 API key，D-201 / D-220）。
 *    所以只扫同步表的闸**抓不到 saveLayer 那一类** —— 一道抓不到它要防的
 *    事故的闸没有价值。于是受管范围 = 同步表 ∪ `settings`，见下面 GUARDED。
 *
 * ── 判据从哪来 ──────────────────────────────────────────────
 *
 * 表清单**不在这里抄一份**：`SYNC_TABLES` 从 submodule 的
 * `nyx-core/src/core/sync-tables.ts` 直接 import（和 `tools/build-info.mjs`
 * 同一个办法）。core 加一张同步表，这道闸当天就跟着管住它。
 *
 * ── 怎么扫 ──────────────────────────────────────────────────
 *
 * 只看**字符串字面量**，不看注释 —— SQL 只会从字面量里执行，而这个仓的
 * Java 注释里写满了 SQL 片段（包括上面这段说明本身）。所以：
 *   ① 先把注释整片换成空格（换行保留，行号仍然对得上原文）
 *   ② 取出所有字符串字面量（含 Java 15 文本块 `"""…"""`）
 *   ③ 只隔着 `+` 与空白相邻的字面量**接起来** —— 旧的 `queryL0` 那句 SQL
 *      正是分五行 `+` 拼出来的，逐条看会漏
 *   ④ 在接好的整句上找 `from/join/into/update/delete from <受管表>`
 *   ⑤ 另外单独抓 Android 的便捷 API：`db.query("items", …)` 这种，
 *      表名是**裸字面量**，句子里根本没有 from
 *
 * 退出码：0 = 干净；1 = 有命中或扫不到源码目录。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JAVA_ROOT = join(ROOT, 'android', 'app', 'src', 'main', 'java')

// ── 受管表 ────────────────────────────────────────────────────
// 同步表：判据只有一份，从 core 读（不抄）
const { SYNC_TABLES } = await import(
  pathToFileURL(join(ROOT, 'nyx-core', 'src', 'core', 'sync-tables.ts')).href
)

/**
 * `settings` 不是同步表，但同样不许 Java 自己动：
 * 它装的是本机配置与凭据（D-220 API key 进 Keystore、协议游标、Assist 的落点设置），
 * 「默认层从哪来」这种判据一旦长在这里，就是 `saveLayer()` 那次事故的形状。
 */
const GUARDED = [...SYNC_TABLES, 'settings']

/**
 * 白名单 —— **只有两条，都是只读的开关位**（`NyxAssistService.readConfig()`）：
 *
 *   assist.enabled  总开关（D-400⑨ / D-408）。无障碍服务在**引擎起来之前**
 *                   就要知道该不该挂悬浮星；这一步走引擎会变成「为了知道要不要
 *                   开门，先把整个屋子点亮」。
 *   assist.probe    真机探针开关（2026-09-01 改成运行期开关）。它存在的理由
 *                   就是「诊断不该以重装为代价」—— 引擎坏掉时更要读得到它，
 *                   所以它不能依赖引擎。
 *
 * 两条都是 **select 一个值、键写死、不写库**，不构成判据。
 * 形状钉死在这条正则里：多一个字段、多一个键、或者变成写，都会红。
 */
const ALLOW = [
  /^\s*select\s+value\s+from\s+settings\s+where\s+key\s*=\s*'(?:assist\.enabled|assist\.probe)'\s*$/i
]

/** Android 的便捷 API：表名作为裸字面量传进去，句子里没有 from */
const BARE_TABLE_API =
  /\.(?:query|queryWithFactory|rawQueryWithFactory|insert|insertOrThrow|insertWithOnConflict|replace|replaceOrThrow|update|updateWithOnConflict|delete)\s*\(\s*$/

const DML = (t) =>
  new RegExp(`(?:\\bfrom|\\bjoin|\\binto|\\bupdate|\\bdelete\\s+from)\\s+["'\`]?\\b${t}\\b`, 'i')

// ── ① 注释换空格（行号保持对齐）· ② 取字面量 ────────────────────

/** 注释整片换成空格，换行原样留着 —— 之后的偏移量与原文一一对应 */
function blankComments(src) {
  const out = src.split('')
  let i = 0
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = i
      while (j < src.length && src[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
      blank(i, Math.min(j + 2, src.length))
      i = j + 2
      continue
    }
    if (c === '"' || c === "'") {
      // 字符串 / 字符字面量整段跳过 —— 里面的 // 和 /* 不是注释
      if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
        const end = src.indexOf('"""', i + 3)
        i = end < 0 ? src.length : end + 3
        continue
      }
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++
        if (src[j] === '\n') break // 未闭合：别把后面整片吃掉
        j++
      }
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

/** 取出所有字符串字面量：{ text, start, end }（text 是解出转义后的内容） */
function literals(code) {
  const out = []
  let i = 0
  while (i < code.length) {
    const c = code[i]
    if (c === "'") {
      // 字符字面量：不是 SQL，跳过
      let j = i + 1
      while (j < code.length && code[j] !== "'") {
        if (code[j] === '\\') j++
        j++
      }
      i = j + 1
      continue
    }
    if (c !== '"') {
      i++
      continue
    }
    if (code[i + 1] === '"' && code[i + 2] === '"') {
      const end = code.indexOf('"""', i + 3)
      const stop = end < 0 ? code.length : end
      out.push({ text: code.slice(i + 3, stop), start: i, end: Math.min(stop + 3, code.length) })
      i = stop + 3
      continue
    }
    let j = i + 1
    let text = ''
    while (j < code.length && code[j] !== '"') {
      if (code[j] === '\n') break
      if (code[j] === '\\') {
        const e = code[j + 1]
        text += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : (e ?? '')
        j += 2
        continue
      }
      text += code[j]
      j++
    }
    out.push({ text, start: i, end: j + 1 })
    i = j + 1
  }
  return out
}

/** 只隔着 `+` 与空白的相邻字面量接成一句（旧 queryL0 就是这么拼的） */
function joinConcat(code, lits) {
  const out = []
  for (const lit of lits) {
    const prev = out[out.length - 1]
    if (prev && /^[\s+]*$/.test(code.slice(prev.end, lit.start))) {
      prev.text += lit.text
      prev.end = lit.end
      prev.parts.push(lit)
      continue
    }
    out.push({ ...lit, parts: [lit] })
  }
  return out
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length

function javaFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) javaFiles(p, out)
    else if (name.endsWith('.java')) out.push(p)
  }
  return out
}

// ── 扫 ────────────────────────────────────────────────────────

let files = []
try {
  files = javaFiles(JAVA_ROOT)
} catch {
  console.error(`✗ 扫不到 ${relative(ROOT, JAVA_ROOT)} —— 源码目录挪了还是没了？`)
  console.error('  这道闸扫不到东西就等于没有，所以这里直接红，不当作「没问题」。')
  process.exit(1)
}

const hits = []
let allowed = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const code = blankComments(src)
  const stmts = joinConcat(code, literals(code))
  for (const s of stmts) {
    const text = s.text.replace(/\s+/g, ' ').trim()

    // ⑤ 便捷 API：整个字面量就是一个表名，前面紧跟 .query( / .insert( …
    const bare = GUARDED.find((t) => t === s.text.trim())
    if (bare && BARE_TABLE_API.test(code.slice(Math.max(0, s.start - 60), s.start))) {
      hits.push({ f, line: lineOf(src, s.start), table: bare, text: `（便捷 API）"${bare}"` })
      continue
    }

    // ④ 句子里的 DML
    const table = GUARDED.find((t) => DML(t).test(text))
    if (!table) continue
    if (ALLOW.some((re) => re.test(text))) {
      allowed++
      continue
    }
    hits.push({ f, line: lineOf(src, s.start), table, text })
  }
}

if (hits.length) {
  console.error(`✗ Java 里出现了业务 SQL（${hits.length} 处）—— 判据不许长在平台层`)
  for (const h of hits) {
    console.error(`\n  ${relative(ROOT, h.f).replace(/\\/g, '/')}:${h.line}  → 表 ${h.table}`)
    console.error(`     ${h.text.length > 160 ? h.text.slice(0, 160) + '…' : h.text}`)
  }
  console.error(`
  ── 怎么办 ────────────────────────────────────────────────
  判据只有一份（D-238 / D-365）：core 与 src/db/*。原生只做采集与渲染。
  · 气泡 / 服务要一个答案 → 走引擎 RPC（src/engine/main.ts::run 加一个 op，
    里面**调已有的判据函数**，不要在引擎里写第二份 SQL）
  · 那一份判据缺东西 → 去 src/db/* 或 core 里改它，两端一起受益
  ★ 反面教材见本文件头：queryL0 的注释也写着「同源」，它照样漂了 ——
    「抄得对」不是保证，「只有一份」才是。`)
  process.exit(1)
}

console.log(
  `✓ ${files.length} 个 Java 文件里没有业务 SQL（受管表 ${GUARDED.length} 张 = core 的同步表 ${SYNC_TABLES.length} + settings；白名单放行 ${allowed} 处开关读取）`
)
