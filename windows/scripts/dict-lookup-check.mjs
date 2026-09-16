#!/usr/bin/env node
/**
 * 真词典查词回归 · D1 最后一项的验收（2026-08-19）
 *
 * ══ 为什么单元测试不够 ★★★ ═════════════════════════════════
 *
 * CLAUDE.md 第九节：**「我验的都是我改的那份，而他用的是另一份。」**
 *
 * `lookup.test.ts` 里的假词典是我写的 —— 它当然满足我写的语义。
 * 真词典里有的东西我猜不出来：
 *
 *   · `children` 到底是不是一条 `@@@LINK`（是 —— OALD10 里就是）
 *   · `per cent` 的键写法与跳转目标写法一致不一致
 *   · 同一个词目下真的会有第二条记录吗（有 —— 实测 OALD10 里 6900 多个）
 *   · 有没有哪一本真的存在互指的环
 *
 * 所以这个脚本拿**他机器上真的那 19 本能读的词典**跑一遍。
 *
 * ══ 它验的四条（全是硬闸）═══════════════════════════════════
 *
 *   ① 查词结果里不许出现 `@@@LINK` —— 跟随必须真的发生
 *   ② 跳转过的必须记下 `redirectedFrom`
 *   ③ 跳转链长度受上限约束，不许无限跳
 *   ④ 同形异义不许被吞掉：词表里有几条，查出来就要有几条
 *
 * ══ 用法 ═══════════════════════════════════════════════════
 *
 *     node scripts/dict-lookup-check.mjs [--dir <目录>] [--words children,crises,...]
 *
 * 找不到词典目录就跳过并返回 0 —— 只有他那台机器上才有这些词典，
 * 所以它**不进** `npm run verify`（verify 要在任何机器上都能跑）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const DIR = argOf('--dir', process.env['NYX_DICTS'] ?? 'D:/Nyx/data/dicts')
/** 他点名要覆盖的四个 */
const WORDS = argOf('--words', 'children,crises,swayed,per cent').split(',').map((w) => w.trim())

if (!existsSync(DIR)) {
  console.log(`跳过真词典查词回归：找不到词典目录 ${DIR}`)
  process.exit(0)
}

const here = new URL('..', pathToFileURL(process.argv[1])).href
const { probeMdict, readKeys } = await import(here + 'scripts/lib/mdict-read.mjs')
const { Mdict } = await import(here + 'src/main/dict/mdict.ts')
const { dictUid } = await import(here + 'src/core/dict/identity.ts')
const {
  MAX_REDIRECT_HOPS,
  keyRulesFromHeader,
  lookup,
  normalizeKey
} = await import(here + 'src/core/dict/lookup.ts')

// ── 找出所有 .mdx ────────────────────────────────────────────
const paths = []
const walk = (dir, depth) => {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const p = join(dir, n)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (depth < 3) walk(p, depth + 1)
    } else if (n.toLowerCase().endsWith('.mdx')) paths.push(p)
  }
}
walk(DIR, 0)
paths.sort()

/**
 * ★★ 脚本里的 adapter —— **它就是 D3 要写的那个 adapter 的雏形**。
 *
 * 三件事和 `src/main/dict/mdict.ts` 那份**不一样**，而且是故意的：
 *
 *   ① 索引是 `归一键 → 词目 → 偏移[]`，**同形异义一条都不丢**。
 *      现在跑着的那份写的是 `if (!index.has(lower)) index.set(...)` ——
 *      实测 OALD10 丢 6909 条、UrbanDictionary 丢 7254 条。
 *   ② 归一用的是 `core/dict/lookup.ts::normalizeKey` + 头部的 KeyRules，
 *      不是写死的 `trim().toLowerCase()`。
 *   ③ `raw()` 返回**原始记录**，不经过 `toText()`。
 *
 * 取字节仍然复用 `Mdict` 的 `readStream` —— 那部分 D1 不碰。
 */
function openSource(path) {
  const probe = probeMdict(path)
  if (!probe.ok) return { ok: false, why: probe.why, detail: probe.detail }

  let h
  try {
    h = Mdict.open(path)
  } catch (err) {
    return { ok: false, why: 'open', detail: String(err.message).split('\n')[0] }
  }

  const rules = keyRulesFromHeader(probe.attrs)
  /** 归一键 → Map<真实词目, 偏移[]> */
  const index = new Map()
  let keyCount = 0
  const r = readKeys(path, probe, (word, at) => {
    const head = word.trim()
    if (!head) return
    keyCount++
    const k = normalizeKey(head, rules)
    let byHead = index.get(k)
    if (!byHead) {
      byHead = new Map()
      index.set(k, byHead)
    }
    const offs = byHead.get(head)
    if (offs) offs.push(at)
    else byHead.set(head, [at])
  })
  if (!r.ok) {
    h.close()
    return { ok: false, why: r.why, detail: r.detail }
  }

  /** 解压后正文流里的有序偏移 —— 一条记录到下一条之间就是它的正文 */
  const offsets = h.offsets
  const endOf = (at) => {
    let lo = 0
    let hi = offsets.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] === at) return mid + 1 < offsets.length ? offsets[mid + 1] : Infinity
      if (offsets[mid] < at) lo = mid + 1
      else hi = mid - 1
    }
    return lo < offsets.length ? offsets[lo] : Infinity
  }

  const src = {
    book: { uid: dictUid({
      format: 'mdict',
      formatVersion: probe.versionRaw,
      encoding: probe.declaredEncoding || null,
      title: probe.title || null,
      entryCount: probe.numEntries,
      blockCount: probe.numKeyBlocks,
      indexBytes: probe.keyBlocksLen
    }), id: 0, name: path.split(/[\\/]/).pop().replace(/\.mdx$/i, '') },
    keyRules: rules,
    match: (key) => [...(index.get(key)?.keys() ?? [])],
    raw: (headword, occurrence = 0) => {
      const offs = index.get(normalizeKey(headword, rules))?.get(headword)
      if (!offs) return null
      const at = offs[occurrence]
      if (at === undefined) return null
      const buf = h.readStream(at, endOf(at))
      if (!buf) return null
      return { body: buf.toString(h.encoding), shape: 'html' }
    }
  }
  return { ok: true, src, close: () => h.close(), index, keyCount, legacy: h }
}

// ── 跑 ───────────────────────────────────────────────────────

const failures = []
const rows = []
let redirectsFollowed = 0
let homographCases = 0
let maxHop = 0
const legacyLeaks = []

for (const path of paths) {
  const rel = relative(DIR, path).replace(/\\/g, '/')
  const opened = openSource(path)
  if (!opened.ok) {
    rows.push({ rel, skipped: `${opened.why}` })
    continue
  }
  const { src, close, index, keyCount } = opened
  const row = { rel, keyCount, hits: [], homographs: 0 }

  for (const word of WORDS) {
    const res = lookup([src], word, { maxBooks: 1 })
    for (const d of res.diagnostics) {
      // 诊断本身不算失败（词典自己指坏了是它的事），但要看得见
      row.hits.push(`${word} → 诊断 ${d.status}`)
    }
    if (res.hits.length === 0) continue
    const h0 = res.hits[0]

    // ① 硬闸：结果里不许有 @@@LINK
    if (/@@@LINK/.test(h0.record.body)) {
      failures.push(`${rel} / ${word} · 结果里漏出了 @@@LINK：${h0.record.body.slice(0, 40)}`)
    }
    // ③ 硬闸：跳转链受上限约束
    if (h0.redirectedFrom.length > MAX_REDIRECT_HOPS) {
      failures.push(`${rel} / ${word} · 跳了 ${h0.redirectedFrom.length} 次，超过上限`)
    }
    maxHop = Math.max(maxHop, h0.redirectedFrom.length)
    if (h0.redirectedFrom.length > 0) redirectsFollowed++

    row.hits.push(
      `${word} → ${h0.headword}` +
      (h0.redirectedFrom.length ? ` （跳自 ${h0.redirectedFrom.join(' → ')}）` : '') +
      ` [${h0.candidate.kind}]` +
      (h0.homographs > 1 ? ` ×${h0.homographs}` : '')
    )

    /**
     * ★ 解析层对照：同一个词，`Mdict.lookup()`（**格式解析那一层**）
     *   交出来的原文是不是一行 `@@@LINK=`。
     *
     *   D3 之后它仍然是 —— 而且**应该**是：跟随跳转是查词语义的事，
     *   不是格式解析的事（`core/dict/lookup.ts` 干这个，adapter 只负责
     *   「这条记录说它是个跳转」）。软件对外那条路已经在 D3 接上了，
     *   见 `tests/dict-behavior.ts` 的 `redirects` 节与第③档 `tests/ui-dict.test.ts`。
     *   这份清单留着当基线：**哪些词在哪本词典里是跳转**，一目了然。
     */
    const legacy = opened.legacy.lookup(word)
    if (legacy && legacy.startsWith('@@@LINK')) legacyLeaks.push(`${rel} / ${word} → ${legacy.slice(0, 30)}`)
  }

  // ④ 硬闸：同形异义不许被吞掉
  let sample = null
  for (const [, byHead] of index) {
    for (const [head, offs] of byHead) {
      if (offs.length > 1) {
        sample = { head, n: offs.length }
        break
      }
    }
    if (sample) break
  }
  if (sample) {
    homographCases++
    row.homographs = sample.n
    const res = lookup([src], sample.head, { maxBooks: 1 })
    const got = res.hits.filter((h) => h.redirectedFrom.length === 0).length
    // 跳转过的那几条会落在别的词目上，所以只数直接命中的
    if (res.hits.length === 0) {
      failures.push(`${rel} · 同形异义样本 ${sample.head} 一条都查不到`)
    } else if (res.hits[0].homographs !== sample.n) {
      failures.push(
        `${rel} · 同形异义被吞了：${sample.head} 词表里有 ${sample.n} 条，` +
        `查出来 homographs=${res.hits[0].homographs}`
      )
    }
    row.homographSample = `${sample.head} ×${sample.n}（查到 ${res.hits.length} 条，直接命中 ${got}）`
  }

  rows.push(row)
  close()
}

// ── 报告 ─────────────────────────────────────────────────────

console.log(`真词典查词回归 · ${DIR}`)
console.log(`词典 ${paths.length} 个 · 查 ${WORDS.map((w) => `「${w}」`).join(' ')}\n`)
for (const r of rows) {
  if (r.skipped) {
    console.log(`  ○ ${r.rel}  —— 跳过（${r.skipped}）`)
    continue
  }
  console.log(`  ● ${r.rel}  ${r.keyCount} 个词目`)
  for (const h of r.hits) console.log(`      ${h}`)
  if (r.homographSample) console.log(`      同形异义：${r.homographSample}`)
  if (r.hits.length === 0) console.log('      （这四个词一个都没收）')
}

console.log('\n判据：')
console.log(`  硬闸 ① 结果里漏出 @@@LINK        ${failures.filter((f) => f.includes('@@@LINK')).length}`)
console.log(`  硬闸 ② 真的跟随了跳转            ${redirectsFollowed} 次（最长 ${maxHop} 跳）`)
console.log(`  硬闸 ③ 跳转链超上限              ${failures.filter((f) => f.includes('超过上限')).length}`)
console.log(`  硬闸 ④ 同形异义被吞              ${failures.filter((f) => f.includes('同形异义')).length}（验了 ${homographCases} 本）`)

if (redirectsFollowed === 0) {
  failures.push('一次跳转都没跟随过 —— 这条回归没有在验它以为在验的东西')
}
if (homographCases === 0) {
  failures.push('一本同形异义样本都没找到 —— 同上')
}

console.log('\n对照（不是判据）：老路径 `Mdict.lookup()` 把 @@@LINK 当正文交出去的：')
if (legacyLeaks.length === 0) console.log('  无')
for (const l of legacyLeaks) console.log(`  ${l}`)
console.log('  ↑ D3 已经在 `Dicts.lookup` / `lookupCard` 上接了跟随，屏幕上不会再出现它们。')

if (failures.length > 0) {
  console.log('\n失败：')
  for (const f of failures) console.log(`  ${f}`)
}
process.exit(failures.length > 0 ? 1 : 0)
