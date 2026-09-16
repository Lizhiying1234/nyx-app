#!/usr/bin/env node
/**
 * 真词典回归 · D1（2026-08-19）
 *
 * ══ 为什么必须有这一条 ★★★ ═════════════════════════════════
 *
 * CLAUDE.md 第九节：**「我验的都是我改的那份，而他用的是另一份。」**
 *
 * `src/core/dict/fixtures/*.html` 是从他真词典里抽出来的**结构骨架**
 *（标签与 class 原样，文本换成占位）—— 单元测试跑的是那一份。
 * 骨架保住了结构，但保不住：
 *
 *   · 真实文本的长度与形状（例句到底多长、释义里有没有分号）
 *   · 夹具没覆盖到的那 18 本词典
 *   · 夹具没覆盖到的那几万个词
 *
 * 所以这个脚本拿**他机器上真的那 22 本**跑一遍，量四件事：
 *
 *   ① 每本词典落在第几档（画像认得几本）
 *   ② 抽得出释义的比例 —— 这是 D3/D4 的基线
 *   ③ **`@@@LINK` 有没有漏到 text 里**（R2 的验收点）
 *   ④ **英文和中文有没有粘在同一行**（R3 的验收点）
 *
 * ══ 用法 ═══════════════════════════════════════════════════
 *
 *     node scripts/dict-regression.mjs [--dir <词典目录>] [--words 200]
 *
 * 找不到词典目录就**跳过并返回 0** —— 别人的机器上、CI 里都不该因此变红。
 * 它不进 `npm run verify`：verify 要在任何机器上都能跑。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const DIR = argOf('--dir', process.env['NYX_DICTS'] ?? 'D:/Nyx/data/dicts')
const SAMPLE = Number(argOf('--words', '150'))

if (!existsSync(DIR)) {
  console.log(`跳过真词典回归：找不到词典目录 ${DIR}`)
  console.log('（这不是失败 —— 只有他那台机器上才有那 22 本词典）')
  process.exit(0)
}

const here = new URL('..', pathToFileURL(process.argv[1])).href
const { Mdict } = await import(here + 'src/main/dict/mdict.ts')
const { decodeEntry } = await import(here + 'src/core/dict/decode/html-entry.ts')
const { bookCapabilities } = await import(here + 'src/core/dict/capability.ts')
const { dictUid } = await import(here + 'src/core/dict/identity.ts')

// ── 找出所有 .mdx 与它们的资源包 ──────────────────────────────
const books = []
const walk = (dir, depth) => {
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue }
    if (!n.toLowerCase().endsWith('.mdx')) continue
    const stem = n.replace(/\.mdx$/i, '')
    const resources = names.filter((x) => {
      const lx = x.toLowerCase()
      return lx.endsWith('.mdd') && (lx === (stem + '.mdd').toLowerCase() || lx.startsWith(stem.toLowerCase() + '.'))
    })
    books.push({ path: p, name: stem, folder: dir, resources })
  }
}
walk(DIR, 0)

/**
 * \u2605 \u5fc5\u987b\u8bfb**\u539f\u59cb\u8bb0\u5f55**\uff0c\u4e0d\u80fd\u7528 `Mdict.lookup()`\u3002
 *   `lookup()` \u91cc\u9762\u5c31\u8c03\u4e86 `toText()` \u2014\u2014 \u90a3\u6b63\u662f\u8fd9\u6b21\u8981\u6362\u6389\u7684\u4e1c\u897f\u3002
 *   \u62ff\u538b\u5e73\u540e\u7684\u6587\u672c\u53bb\u9a8c\u300c\u538b\u5e73\u6709\u6ca1\u6709\u4e22\u7ed3\u6784\u300d\uff0c\u6c38\u8fdc\u9a8c\u4e0d\u51fa\u95ee\u9898\uff08\u7b2c\u4e00\u7248\u5c31\u662f\u8fd9\u4e48\u5199\u7684\uff0c
 *   \u8dd1\u51fa\u6765\u300c\u753b\u50cf\u4e00\u672c\u90fd\u6ca1\u547d\u4e2d\u300d\u624d\u53d1\u73b0\uff09\u3002
 */
function rawOf(h, word) {
  const at = h.index.get(word)
  if (at === undefined) return null
  const offs = h.offsets
  const i = offs.indexOf(at)
  const end = i >= 0 && i + 1 < offs.length ? offs[i + 1] : Infinity
  const buf = h.readStream(at, end)
  return buf ? buf.toString(h.encoding) : null
}

/**
 * \u300c\u82f1\u4e2d\u7c98\u8fde\u300d\u7684\u5224\u636e\u8981**\u7cbe\u786e**\uff0c\u4e0d\u80fd\u53ea\u770b\u300c\u540c\u4e00\u884c\u91cc\u65e2\u6709\u82f1\u6587\u53c8\u6709\u4e2d\u6587\u300d\u2014\u2014
 * 21 \u4e16\u7eaa\u90a3\u672c\u662f\u82f1\u6c49\u8bcd\u5178\uff0c`alpha cutoff (frequency) \u3010\u7535\u5b50\u5b66\u3011\u03b1\u622a\u6b62\u9891\u7387`
 * \u672c\u6765\u5c31\u957f\u8fd9\u6837\uff0c\u90a3\u4e0d\u662f\u75c5\u3002
 *
 * \u771f\u6b63\u7684\u75c5\u75c7\u662f**\u4e2d\u95f4\u4e00\u4e2a\u5206\u9694\u7b26\u90fd\u6ca1\u6709**\uff1a
 *   `...something unpleasant\u627f\u53d7\u67d0\u4e8b\u7684\u4e3b\u8981\u538b\u529b`
 *   `...burying a dead body\u57cb\u846c\uff1b\u846c\u793c`
 * \u5373\uff1a\u5c0f\u5199\u5b57\u6bcd**\u7d27\u6328\u7740**\u6c49\u5b57\u3002
 */
const CJK_CH = /[\u4e00-\u9fff]/

function isGlued(s) {
  /**
   * ★ 先看整条的语言构成。
   *
   * 「英文释义粘上了它的中文译文」**必然**意味着这条释义里有相当分量的英文。
   * 反过来，一条 95% 是中文的释义不可能是这种粘连 —— 那是中文行文里引了个英文词组，
   * 比如《英语常用词疑难用法手册》：
   *   `4. may (might) (just) as well有两个可能的意义。第一个意义，是表示…`
   * 那本书通篇如此，作者只是没打空格。
   *
   * 这不是为了把数字调到 0 才加的条件 —— 它是这个病症的定义的一部分。
   */
  const latinChars = (s.match(/[a-zA-Z]/g) ?? []).length
  if (latinChars / s.length < 0.25) return false

  for (let i = 1; i < s.length; i++) {
    if (!CJK_CH.test(s[i]) || !/[a-z]/.test(s[i - 1])) continue
    // \u8fd9\u4e2a\u6c49\u5b57\u4e4b\u524d\u90a3\u4e00\u6bb5\u8fde\u7eed\u7684\u62c9\u4e01\u6587\u672c
    let j = i - 1
    while (j >= 0 && !CJK_CH.test(s[j])) j--
    const latin = s.slice(j + 1, i).trim()
    /**
     * \u2605 \u81f3\u5c11\u56db\u4e2a\u8bcd\u624d\u7b97\u300c\u4e00\u6574\u53e5\u82f1\u6587\u300d\u3002
     *   `cast\u7684\u4e09\u5355\u5f62\u5f0f`\u3001`already\u800c\u4e0d\u7528yet` \u91cc\u7d27\u6328\u6c49\u5b57\u7684\u53ea\u6709\u4e00\u4e2a\u82f1\u6587\u8bcd \u2014\u2014
     *   \u90a3\u662f\u4e2d\u6587\u91ca\u4e49**\u6b63\u5e38\u5f15\u7528**\u4e00\u4e2a\u82f1\u6587\u8bcd\uff0c\u4e0d\u662f\u7c98\u8fde\u3002
     *   \u5224\u636e\u653e\u677e\u4e00\u70b9\u4f1a\u628a\u6574\u672c\u4e2d\u6587\u8bcd\u5178\u8bef\u62a5\u6210\u6709\u75c5\uff0c\u90a3\u6bd4\u6f0f\u62a5\u66f4\u7cdf\uff1a
     *   \u62a5\u8b66\u5668\u5929\u5929\u54cd\uff0c\u5c31\u6ca1\u4eba\u770b\u5b83\u4e86\u3002
     */
    if (latin.split(/\s+/).filter(Boolean).length < 4) continue
    // \u540e\u9762\u4e5f\u8981\u662f\u6210\u7247\u7684\u4e2d\u6587\uff0c\u4e0d\u662f\u4e00\u4e24\u4e2a\u5b57
    let k = i
    while (k < s.length && CJK_CH.test(s[k])) k++
    if (k - i >= 4) return true
  }
  return false
}

let totalWords = 0
let withSenses = 0
let redirects = 0
let leakedLink = 0
let gluedLines = 0
const tierCount = { 1: 0, 2: 0, 3: 0 }
const profileCount = {}
const failures = []
const rows = []
/** 每本词典各有几条粘连 —— 备案是按词典备的 */
const gluedByBook = new Map()

for (const b of books) {
  let h
  try {
    h = Mdict.open(b.path)
  } catch (err) {
    rows.push({ name: b.name, note: '装不起来：' + String(err.message).split('\n')[0].slice(0, 40) })
    continue
  }

  const exts = [...new Set(b.resources.map(() => 'mp3'))] // 资源包里到底有什么要解 MDD 才知道，D2 再补
  const caps = bookCapabilities({ format: 'Html', resourceExtensions: exts, hasRedirects: true })
  const uid = dictUid({
    format: 'mdict', formatVersion: String(h.version), encoding: 'UTF-8',
    title: h.title, entryCount: h.wordCount
  })
  const book = { uid, id: 0, name: b.name }

  const keys = [...h.index.keys()]
  const step = Math.max(1, Math.floor(keys.length / SAMPLE))
  let n = 0, sen = 0, red = 0, t1 = 0, t2 = 0, t3 = 0
  let profileId = null

  for (let i = 0; i < keys.length && n < SAMPLE; i += step) {
    const w = keys[i]
    let body
    try { body = rawOf(h, w) } catch { continue }
    if (!body) continue
    n++
    let r
    try {
      r = decodeEntry({ book, query: w, headword: w, record: { body, shape: 'html' }, bookCapabilities: caps })
    } catch (err) {
      failures.push(`${b.name} / ${w} · 解码抛异常：${err.message}`)
      continue
    }
    if (r.kind === 'redirect') { red++; continue }
    profileId ??= r.profileId
    if (r.tier === 1) t1++; else if (r.tier === 2) t2++; else t3++
    if (r.entry.senses.length > 0) sen++

    // ③ R2 的验收点
    if (r.entry.text.includes('@@@LINK')) {
      leakedLink++
      if (failures.length < 20) failures.push(`${b.name} / ${w} · text 里漏出了 @@@LINK`)
    }
    // ④ R3 的验收点：结构化出来的释义里，英文与中文不该粘在一起
    for (const s of r.entry.senses) {
      if (isGlued(s.gloss)) {
        gluedLines++
        gluedByBook.set(b.name, (gluedByBook.get(b.name) ?? 0) + 1)
        if (failures.length < 20) failures.push(`${b.name} / ${w} · 释义里英中粘连：${s.gloss.slice(0, 60)}`)
        break
      }
    }
  }

  h.close()
  totalWords += n
  withSenses += sen
  redirects += red
  tierCount[1] += t1; tierCount[2] += t2; tierCount[3] += t3
  if (profileId) profileCount[profileId] = (profileCount[profileId] ?? 0) + 1
  const decoded = n - red
  rows.push({
    name: b.name,
    n, red, sen, t1, t2, t3, profileId,
    pct: decoded > 0 ? Math.round((sen / decoded) * 100) : 0
  })
}

// ── 报告 ────────────────────────────────────────────────────
console.log(`真词典回归 · ${DIR}`)
console.log(`词典 ${books.length} 本，每本抽样 ${SAMPLE} 个词目\n`)
console.log(
  '本'.padEnd(2) + ' ' + '词典'.padEnd(38) +
  '抽样'.padStart(6) + '跳转'.padStart(6) + '有释义'.padStart(7) + '占比'.padStart(6) +
  '  档次(1/2/3)   画像'
)
console.log('─'.repeat(100))
for (const r of rows) {
  if (r.note) { console.log('   ' + r.name.slice(0, 38).padEnd(38) + '  ' + r.note); continue }
  console.log(
    '   ' + r.name.slice(0, 38).padEnd(38) +
    String(r.n).padStart(6) + String(r.red).padStart(6) + String(r.sen).padStart(7) +
    (r.pct + '%').padStart(6) +
    `   ${r.t1}/${r.t2}/${r.t3}`.padEnd(14) + (r.profileId ?? '—')
  )
}

const decoded = totalWords - redirects
console.log('\n' + '─'.repeat(100))
console.log(`合计抽样 ${totalWords} 个词目：`)
console.log(`  · 重定向（@@@LINK）        ${redirects}  (${pct(redirects, totalWords)})`)
console.log(`  · 真正解码的               ${decoded}`)
console.log(`  · 其中抽得出释义的         ${withSenses}  (${pct(withSenses, decoded)})`)
console.log(`  · 档次分布 第①/②/③        ${tierCount[1]} / ${tierCount[2]} / ${tierCount[3]}`)
console.log(`  · 画像命中的词典           ${Object.entries(profileCount).map(([k, v]) => `${k}(${v}本)`).join(' ') || '无'}`)

console.log('\n两条硬判据：')
console.log(`  R2 · text 里漏出 @@@LINK   ${leakedLink}   ${leakedLink === 0 ? '✓' : '✗'}`)
console.log(`  R3 · 释义里英中粘连         ${gluedLines}   ${gluedLines === 0 ? '✓' : '✗'}`)

if (failures.length > 0) {
  console.log('\n前几条问题：')
  for (const f of failures.slice(0, 20)) console.log('  ' + f)
}

function pct(a, b) {
  return b > 0 ? Math.round((a / b) * 100) + '%' : '—'
}

/**
 * ══ 判据 ═══════════════════════════════════════════════════
 *
 * 两条**硬闸**（没有备案，出现即失败）：
 *   · 解码抛异常 —— 一本词典的一个词能让解码炸掉，那本就整本查不了
 *   · `@@@LINK` 漏进 text —— R2 的验收点
 *
 * 一条**带备案的闸**：英中粘连。
 *   有些词典**自己**就把英文和中文放在同一个元素里、中间没有分隔符
 *  （实测 21 世纪的 `ASIO`）。那是源数据的形状，结构上拆不开 ——
 *   拆就是猜，而『错的结构化结果比没有结构化结果更糟』。
 *   所以按 `scripts/dict-baseline.json` 备案：**写得出理由的才放过，
 *   没备案的词典出现粘连一律判失败**（和 `dom-baseline.json` 同一个规矩）。
 */
const baseline = JSON.parse(readFileSync(new URL('./dict-baseline.json', import.meta.url), 'utf8'))
const excused = new Set(Object.keys(baseline.gluedBySource ?? {}).filter((k) => k !== 'says'))

const exceptions = failures.filter((f) => f.includes('抛异常')).length
const unexcused = [...gluedByBook.entries()].filter(([name]) => !excused.has(name))

console.log('\n判据：')
console.log(`  硬闸 · 解码抛异常          ${exceptions}   ${exceptions === 0 ? '✓' : '✗'}`)
console.log(`  硬闸 · @@@LINK 漏进 text   ${leakedLink}   ${leakedLink === 0 ? '✓' : '✗'}`)
if (gluedLines > 0) {
  console.log('  备案闸 · 英中粘连：')
  for (const [name, n] of gluedByBook) {
    const ok = excused.has(name)
    console.log(`      ${ok ? '备案' : '未备案'}  ${String(n).padStart(4)}  ${name}${ok ? '' : '   ← 判失败'}`)
  }
  if (unexcused.length === 0) {
    console.log('      （全部有备案，理由见 scripts/dict-baseline.json）')
  }
} else {
  console.log('  备案闸 · 英中粘连          0   ✓')
}

const bad = leakedLink + exceptions + unexcused.length
if (bad > 0) {
  console.log('\n失败。未备案的粘连要么去改画像，要么在 dict-baseline.json 里写清理由 ——')
  console.log('写不出理由的，就是 bug。')
}
process.exit(bad > 0 ? 1 : 0)
