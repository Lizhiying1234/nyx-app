#!/usr/bin/env node
/**
 * ══ 引擎包纯净闸（T-7.6 补）════════════════════════════════════
 *
 * **Assist 引擎那个 WebView 没有 Capacitor 桥**（D-404）。所以引擎那条链上
 * 出现任何 Capacitor 的东西，都只有两种可能：
 *   ① 一份永远跑不到的死代码（白占 APK、白占启动解析时间）；
 *   ② 更糟 —— 有人真的在引擎里调了它，而它在那儿是坏的。
 *
 * ── 这道闸是怎么来的 ────────────────────────────────────────
 *
 * 2026-09-07 会话 D 干净重建时发现 `assist-engine.js` 里打进了
 * `@capacitor/core`（含 `CapacitorHttp` 的 web 实现）与 secure-storage，
 * **而且从 T-7.6 之前就在**。一年多没有任何东西拦过它 —— 眼睛显然拦不住。
 *
 * ── 为什么判**图**而不是只 grep 产物 ★★ ─────────────────────
 *
 * grep 产物只答得出「脏没脏」，答不出**哪条边**把它拖进来的；而这一轮真正
 * 费时间的正是找那条边。所以主判据是「从 `src/engine/main.ts` 走一遍 import
 * 图」，报出**完整链路**；产物 grep 留作第二道（防打包器把什么东西塞进来）。
 *
 * ★★ **动态 import 一样算**。引擎那一份是 `formats: ['iife']` 的单文件产物
 *   （`vite.engine.config.ts`），单文件没法代码分割，`await import()` 会被
 *   **内联进同一个包**。这一轮实测过两次：`db/secret.ts` 改成惰性加载，
 *   产物 185.51 kB 一字未减、`SecureStorage × 8` 一条不少。
 *   「用动态 import 就不会打进去」是这个仓库里流传过的一个错觉。**别再信。**
 *   ★ 校准（I-163）：`db/analyse.ts` 那句老注释其实说的是另一件事 ——
 *     「② 层测试跑在 node，静态 import 装不起来」。那条理由是真的、今天也
 *     还成立，它只是**只管测试那一半**，管不了打包那一半。两半都要。
 *
 * ── 为什么挂在 `build:engine` 后面 ──────────────────────────
 *
 * 它要读产物。挂在 `check` 上就得面对「产物还没生成怎么办」，而那只有两个
 * 答案：跳过（于是长期空转，R-018 最怕的「绿着什么都没验」）或报错（`check`
 * 再也不能单独跑）。挂在产物**刚生成**的地方，两难自然消失。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = resolve(ROOT, 'src/engine/main.ts')
const BUNDLE = resolve(ROOT, 'android/app/src/main/assets/assist-engine.js')

/** 认得出来就算 —— 这三个包都会把 `@capacitor/core` 一起带进来 */
const CAPACITOR = [
  '@capacitor/core',
  '@capacitor/filesystem',
  '@aparajita/capacitor-secure-storage'
]

/**
 * ★★ **还没治的边** —— 列在这里不是放行，是**把欠账写在明面上**。
 *
 * 空掉这个名单的那一天，下面产物 grep 那一段会自动从「只报数」升级成硬闸。
 * 加东西进来要有名有姓地说清为什么，别拿它当消音器。
 *
 * ★ 2026-09-07 · I-163 治掉了最后一条（`src/db/sync.ts`：三处
 *   `await import('./sync.ts')` 挪进 `db/sync-first-native.ts`，只有 App 入口
 *   import 它）。**名单从此是空的，产物那一段已经是硬闸** ——
 *   再往这里加东西，等于把一道跑起来的闸关回去，要先说服人。
 */
const ALLOWED = []

// ── 注释先剥掉（两处都要用）──────────────────────────────────
//
// ★★ 主控 2026-09-07 的对照打穿过这道闸：把 `installNativeSecrets()` 那一行
//   **注释掉**，闸照样绿 —— 因为它当时是一句 `includes()`。同一个毛病在走图
//   那一半是反向的：文件头注里引用一句 `import { SecureStorage } from '…'`
//   （`db/secret.ts` 就真有这么一句）会被当成真的 import，报一条**假红**。
//   一个 helper 修两处：**先剥注释，再判**。
//
// ★ 只剥「整行注释」与 `/* */` 块，不动字符串里的 `//`（`'https://…'` 那种）；
//   行尾注释另判（下面 `callsInCode`），避免为了严谨去写一个半吊子的词法分析器。

const stripBlockComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 整行注释（`//` · `*` · `/**`）一律丢掉 */
const codeLines = (src) =>
  stripBlockComments(src)
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })

/** 这一行里，`needle` 是不是出现在**代码**里（而不是行尾注释里） */
function callsInCode(src, needle) {
  return codeLines(src).some((l) => {
    const at = l.indexOf(needle)
    if (at < 0) return false
    const slash = l.indexOf('//')
    return slash < 0 || at < slash
  })
}

// ── 走图（静态 + 动态）────────────────────────────────────────

const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"]*['"]([^'"]+)['"]/gm
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

const parents = new Map()
const seen = new Set()
const hits = []

function walk(file) {
  if (seen.has(file) || !existsSync(file)) return
  seen.add(file)
  const src = codeLines(readFileSync(file, 'utf8')).join('\n')
  const specs = []
  for (const m of src.matchAll(STATIC_IMPORT)) specs.push(m[1])
  for (const m of src.matchAll(DYNAMIC_IMPORT)) specs.push(m[1])
  for (const spec of specs) {
    if (CAPACITOR.includes(spec)) hits.push({ file, spec })
    if (!spec.startsWith('.')) continue
    const next = resolve(dirname(file), spec)
    if (!parents.has(next)) parents.set(next, file)
    walk(next)
  }
}

const rel = (f) => f.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '')

function chainOf(file) {
  const out = []
  let cur = file
  while (cur) {
    out.push(rel(cur))
    cur = parents.get(cur)
  }
  return out.reverse()
}

parents.set(ENTRY, null)
walk(ENTRY)

const allowedModules = new Set(ALLOWED.map((a) => a.module))
const bad = hits.filter((h) => !chainOf(h.file).some((step) => allowedModules.has(step)))

if (bad.length > 0) {
  console.error('✗ 引擎那条链摸到了 Capacitor（D-404：那个 WebView 没有桥）：')
  for (const h of bad) {
    console.error(`\n    ${h.spec}\n      ` + chainOf(h.file).join('\n      → '))
  }
  console.error(
    '\n  治法（照 db/secret-native.ts · db/sync-first.ts 的先例）：\n' +
      '  把口子 / 纯函数摘进零依赖模块，带插件的那一份**只让 App 入口 import**。\n' +
      '  ★ 换成 `await import()` 不算治 —— 单文件 IIFE 会把它内联，实测一字未减。'
  )
  process.exit(1)
}

// ── 另一头：App 入口必须**真的把口子装上** ────────────────────
//
// 把插件关进 `db/secret-native.ts` 之后，App 那一侧就多了一个装配动作。
// 漏了它不会炸得很响 —— 每个 `catch { apiKey = '' }` 会把「装配漏了」
// 讲成「他还没配 key」。所以在这里盯一眼：这是**这道闸的另一半**，
// 一半防「引擎带上了不该带的」，一半防「App 忘了装该装的」。

// ★ I-163 起是两个口子：凭据、以及「写库之前先同步一趟」。两个都是
//   「漏了不炸、只是悄悄换一句话」的那一类，所以逐个盯。

const INSTALLS = [
  {
    call: 'installNativeSecrets()',
    what: '凭据口子',
    symptom: '症状不会是报错，是「设置页永远显示没配 key」「AI 永远说还没配置 API」。'
  },
  {
    call: 'installAppSyncFirst()',
    what: '「先同步一趟」的口子',
    symptom:
      '症状不会是报错，是分析 / 改词条那一句变成「没同步上（这一端还没装同步口子）」——\n' +
      '  而真相是装配漏了，不是他关了自动同步。'
  }
]

const APP_ENTRY = resolve(ROOT, 'src/ui/main.ts')
const appEntrySrc = readFileSync(APP_ENTRY, 'utf8')
for (const i of INSTALLS) {
  if (callsInCode(appEntrySrc, i.call)) continue
  console.error(`✗ ${rel(APP_ENTRY)} 里没有 ${i.call} —— App 那一侧的${i.what}没装上。`)
  console.error('  ' + i.symptom)
  console.error('  ★ 注释掉那一行也算没装 —— 这道检查只认非注释行里的真调用。')
  process.exit(1)
}

// ── 产物那一道（名单空了之后升级成硬闸）───────────────────────

const NEEDLES = [
  ['registerPlugin', '@capacitor/core（插件注册）'],
  ['CapacitorHttp', '@capacitor/core（原生 HTTP 的 web 实现）'],
  ['SecureStorage', '@aparajita/capacitor-secure-storage']
]

if (!existsSync(BUNDLE)) {
  console.error(`✗ 找不到引擎产物：${rel(BUNDLE)}\n  这道闸只在 build:engine 之后有意义。`)
  process.exit(1)
}
const out = readFileSync(BUNDLE, 'utf8')
const found = NEEDLES.map(([n, who]) => ({ n, who, c: out.split(n).length - 1 })).filter((x) => x.c > 0)
const kb = Math.round(out.length / 1024)

if (ALLOWED.length === 0) {
  if (found.length > 0) {
    console.error(`✗ 图是干净的，产物里却有 Capacitor（${kb} KB）—— 打包器塞进来的？`)
    for (const f of found) console.error(`    ${f.n} × ${f.c}  —— ${f.who}`)
    process.exit(1)
  }
  console.log(`✓ 引擎干净：图上没有 Capacitor，产物里也搜不到（${kb} KB）`)
} else {
  console.log(`✓ 引擎图上没有**未登记**的 Capacitor 边（产物 ${kb} KB）`)
  console.log('  ★ 还欠着的（名单空掉那天这一段自动变成硬闸）：')
  for (const a of ALLOWED) console.log(`    · ${a.module}`)
  if (found.length > 0) {
    console.log('    产物里因此仍有：' + found.map((f) => `${f.n}×${f.c}`).join(' · '))
  }
}
