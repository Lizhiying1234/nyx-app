#!/usr/bin/env node
/**
 * 真词典全量扫描 · 只读取证（2026-08-19）
 *
 * ══ 为什么要有这一条，而不是直接信审计报告 ★★ ════════════════
 *
 * 上一轮的证据分两层：
 *   ① `dictionary-audit.md`（Artifact）—— 对他机器上 22 本真词典的取证
 *   ② D1 落地时的实测修正 —— `src/core/dict/fixtures/identity-corpus.json`
 *
 * 这个脚本**重新量一遍**，然后与 ② 逐字对拍。
 * 对不上就是有一份是错的，先说清楚差在哪，**不改实现**。
 *
 * ══ 只读 ═══════════════════════════════════════════════════
 *
 * 全程 `openSync(path, 'r')`。不写、不删、不建库、不动 `data/`。
 *
 * ══ 它量什么 ═══════════════════════════════════════════════
 *
 * 逐本：文件名 / 格式 / 身份 / probe / 状态 / 诊断 / 词条数 /
 *       html·音标·发音·插图·例句 五项能力 / 资源包 / 能不能正常 lookup
 *
 * 「资源包里有什么」是**真的解 .mdd 的词表**数出来的 ——
 * `dict-regression.mjs` 里那句 `b.resources.map(() => 'mp3')` 是占位，
 * 它会把 LDOCE5 的 Speex 当成 mp3、把没有音频的资源包也算成有发音。
 *
 * ══ 用法 ═══════════════════════════════════════════════════
 *
 *     node scripts/dict-scan.mjs [--dir <目录>] [--words 150] [--probe-only] [--json <路径>]
 *
 * 找不到目录就跳过并返回 0（别人的机器上不该因此变红）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const DIR = argOf('--dir', process.env['NYX_DICTS'] ?? 'D:/Nyx/data/dicts')
const SAMPLE = Number(argOf('--words', '150'))
const PROBE_ONLY = args.includes('--probe-only')
const JSON_OUT = argOf('--json', '')

if (!existsSync(DIR)) {
  console.log(`跳过真词典扫描：找不到词典目录 ${DIR}`)
  process.exit(0)
}

const here = new URL('..', pathToFileURL(process.argv[1])).href
const { probeMdict, readKeys } = await import(here + 'scripts/lib/mdict-read.mjs')
const { dictUid, dictIdentityParts, identityStrength } = await import(here + 'src/core/dict/identity.ts')
const { bookCapabilities, hasOnlyUnplayableAudio } = await import(here + 'src/core/dict/capability.ts')
const { diagnostics } = await import(here + 'src/core/dict/diagnostics.ts')
const { decodeEntry } = await import(here + 'src/core/dict/decode/html-entry.ts')
const { Mdict } = await import(here + 'src/main/dict/mdict.ts')

// ══ 一、枚举 ════════════════════════════════════════════════
// 与 `stardict.ts::scanDicts` 同一个判据（深度 < 3 的 .mdx / .ifo），
// 另外把**今天被完全忽略的** .mdd 也枚举出来 —— 孤儿资源包要看得见。

const files = []
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
      continue
    }
    files.push({ dir, name: n, path: p, size: st.size })
  }
}
walk(DIR, 0)

const lower = (s) => s.toLowerCase()
const isMdx = (f) => lower(f.name).endsWith('.mdx')
const isMdd = (f) => lower(f.name).endsWith('.mdd')
const isIfo = (f) => lower(f.name).endsWith('.ifo')

/** 一本 .mdx 的资源包：同目录、同词干、.mdd 结尾（含 `.1.mdd` `(1).mdd` 这些分卷写法） */
function resourcesOf(book) {
  const stem = lower(book.name.replace(/\.mdx$/i, ''))
  return files.filter((f) => f.dir === book.dir && isMdd(f) && lower(f.name).startsWith(stem))
}

const books = files.filter((f) => isMdx(f) || isIfo(f))
const claimedMdd = new Set()
for (const b of books.filter(isMdx)) for (const r of resourcesOf(b)) claimedMdd.add(r.path)
const orphanMdd = files.filter((f) => isMdd(f) && !claimedMdd.has(f.path))

// ══ 二、MDict 头部与词表的只读解析 ═══════════════════════════
// 搬到了 scripts/lib/mdict-read.mjs —— dict-lookup-check.mjs 也要用同一份。
// ★ 身份的两个取值约定（formatVersion 原字符串 / indexBytes = keyBlocksLen）
//   的唯一实现就在那里，见 src/core/dict/identity.ts 第二节之二。

const extOf = (key) => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(key)
  return m ? m[1].toLowerCase() : ''
}

/** 一个 .mdd 里到底有什么 —— 扩展名直方图 */
function scanResourcePackage(path) {
  const p = probeMdict(path, { mdd: true })
  if (!p.ok) return { path, ok: false, why: p.why, detail: p.detail }
  const exts = new Map()
  let count = 0
  const r = readKeys(path, p, (key) => {
    count++
    const e = extOf(key) || '(无扩展名)'
    exts.set(e, (exts.get(e) ?? 0) + 1)
  })
  return {
    path,
    ok: r.ok,
    why: r.why ?? null,
    detail: r.detail ?? null,
    declared: p.numEntries,
    count,
    exts: [...exts.entries()].sort((a, b) => b[1] - a[1])
  }
}

// ══ 三、正文抽样 ════════════════════════════════════════════
// 用**真的那条代码路径**（`Mdict.open` → 内部索引 → 原始记录）。
// 读原始记录而不是 `lookup()`：`lookup()` 里已经调了 `toText()`，
// 拿压平后的文本去量「有没有图片引用」永远量不出来。

/**
 * 取未压平的正文。
 *
 * ★★★ 2026-08-20：这里原本自己抄了一遍 `Mdict.rawOf` 的实现，
 *   最后一句是 `buf.toString(h.encoding)`。D5.1b 之后那本朗文插图版的
 *   `h.encoding` 是 `'gbk'`，而 **Buffer 根本不支持 gbk** —— 当场抛，
 *   外面那个 `catch { continue }` 把它吞得干干净净：
 *   抽样从 150 条变成 **0 条**，报告上却只是一行安静的「抽样 0 条」。
 *
 *   两个教训，都记在这里：
 *   ① 取证脚本抄一份实现 = 多一条会自己漂走的路。改成调类自己的方法。
 *   ② 吞掉异常的 `catch` 是这个项目最贵的东西 —— 现在它至少会计数（见 decodeErrors）。
 */
function rawOf(h, word) {
  return h.rawOf(word)
}

const RE_SOUND = /(?:href|src)\s*=\s*["']?\s*sound:\/\//i
const RE_IMG = /<img\b/i
const RE_ENTRY_LINK = /(?:href|src)\s*=\s*["']?\s*entry:\/\//i
const RE_HTML_TAG = /<(?:div|span|p|br|b|i|a|img|table|ul|li|dl|dd|dt|h[1-6])\b/i
const CJK = /[\u4e00-\u9fff]/

function sampleBook(h, bookRef, caps) {
  const keys = [...h.index.keys()]
  const step = Math.max(1, Math.floor(keys.length / SAMPLE))
  const out = {
    sampled: 0,
    redirects: 0,
    decodeErrors: 0,
    withSenses: 0,
    withPhonetic: 0,
    withExample: 0,
    withGlossZh: 0,
    withCjkGloss: 0,
    withCrossRef: 0,
    rawHtml: 0,
    rawSound: 0,
    rawImg: 0,
    rawEntryLink: 0,
    profileId: null,
    tiers: { 1: 0, 2: 0, 3: 0 },
    firstError: null
  }
  for (let i = 0; i < keys.length && out.sampled < SAMPLE; i += step) {
    const w = keys[i]
    let body
    try {
      body = rawOf(h, w)
    } catch (err) {
      out.decodeErrors++
      if (!out.firstError) out.firstError = String(err && err.message).slice(0, 100)
      continue
    }
    if (!body) continue
    out.sampled++
    if (RE_HTML_TAG.test(body)) out.rawHtml++
    if (RE_SOUND.test(body)) out.rawSound++
    if (RE_IMG.test(body)) out.rawImg++
    if (RE_ENTRY_LINK.test(body)) out.rawEntryLink++

    let r
    try {
      r = decodeEntry({
        book: bookRef,
        query: w,
        headword: w,
        record: { body, shape: 'html' },
        bookCapabilities: caps
      })
    } catch (err) {
      out.decodeErrors++
      out.firstError ??= `${w} · ${err instanceof Error ? err.message : String(err)}`
      continue
    }
    if (r.kind === 'redirect') {
      out.redirects++
      continue
    }
    out.profileId ??= r.profileId
    out.tiers[r.tier]++
    const e = r.entry
    if (e.senses.length > 0) out.withSenses++
    if (e.phonetics.length > 0) out.withPhonetic++
    if (e.senses.some((s) => s.examples.length > 0) || e.examples.length > 0) out.withExample++
    /**
     * ★ 「有中文」要分两种，混在一起会把英汉词典的形状描述错：
     *   · `glossZh` 有内容 —— 双解本（英文释义 + 独立的中文对译），如 OALD10 / 朗文6
     *   · `gloss` 本身是中文 —— 英汉本（释义就是中文），如 21 世纪大英汉
     * 第一版只量了 `glossZh`，于是 21 世纪那本量出「中译 0」，
     * 而它明明整本都是中文 —— 那是**尺子的问题**，不是词典的问题。
     */
    if (e.senses.some((x) => x.glossZh && CJK.test(x.glossZh))) out.withGlossZh++
    if (e.senses.some((x) => CJK.test(x.gloss))) out.withCjkGloss++
    if (e.crossRefs.length > 0) out.withCrossRef++
  }
  return out
}

/** 能不能正常 lookup —— 用他真正走的那条路（`Mdict.lookup`），拿真实词目去查 */
function lookupCheck(h) {
  const keys = [...h.index.keys()]
  if (keys.length === 0) return { tried: 0, hit: 0, ok: false }
  const picks = []
  for (let i = 0; i < 20; i++) picks.push(keys[Math.floor((keys.length * i) / 20)])
  let hit = 0
  let text = ''
  for (const w of picks) {
    let t = null
    try {
      t = h.lookup(w)
    } catch {
      t = null
    }
    if (t && t.trim()) {
      hit++
      if (!text) text = t.trim().slice(0, 60).replace(/\s+/g, ' ')
    }
  }
  return { tried: picks.length, hit, ok: hit > 0, sample: text }
}

// ══ 四、逐本扫描 ════════════════════════════════════════════

const rows = []
for (const b of books.sort((x, y) => x.path.localeCompare(y.path))) {
  const rel = relative(DIR, b.path).replace(/\\/g, '/')
  const row = {
    file: rel,
    folder: relative(DIR, b.dir).replace(/\\/g, '/') || '.',
    bytes: b.size,
    format: null,
    identity: null,
    identityParts: null,
    identityStrength: null,
    probe: null,
    status: null,
    diagnostic: null,
    entryCountHeader: null,
    entryCountIndex: null,
    caps: { html: null, phonetic: null, audio: null, image: null, example: null },
    capsBook: [],
    resources: [],
    lookup: null,
    notes: []
  }
  rows.push(row)

  if (isIfo(b)) {
    row.format = 'stardict'
    row.notes.push('StarDict —— 这次没有实测（他目录里一本都没有）')
    continue
  }

  const p = probeMdict(b.path)
  if (!p.ok) {
    row.format = 'mdict?'
    const d =
      p.why === 'size' || p.why === 'header-len' || p.why === 'no-attrs'
        ? diagnostics.notADictionary('文件太小或没有 MDict 头部', p.detail)
        : diagnostics.indexError(p.detail)
    row.status = d.status
    row.diagnostic = { says: d.says, detail: d.detail ?? p.detail }
    row.probe = { ok: false, why: p.why, detail: p.detail }
    continue
  }

  row.format = `mdict ${p.versionRaw}`
  row.probe = {
    ok: true,
    title: p.title,
    encoding: p.declaredEncoding || '(未声明)',
    format: p.format || '(未声明)',
    encryptedFlags: p.encFlags,
    registerBy: p.registerBy || null,
    numKeyBlocks: p.numKeyBlocks,
    numEntries: p.numEntries,
    keyIndexCompLen: p.keyIndexCompLen,
    keyIndexDecompLen: p.keyIndexDecompLen,
    keyBlocksLen: p.keyBlocksLen
  }
  row.entryCountHeader = p.numEntries

  const idInput = {
    format: 'mdict',
    formatVersion: p.versionRaw,
    encoding: p.declaredEncoding || null,
    title: p.title || null,
    entryCount: p.numEntries,
    blockCount: p.numKeyBlocks,
    /**
     * ★ `indexBytes` = **词条块段**的字节数（`keyBlocksLen`），不是 keyInfo 的字节数。
     *   两个都在头部里，一开始取错了：keyInfo 是「224 个块各自的元数据」，
     *   压完只有 5 KB，区分力远不如词条块段（2.9 MB）。
     *   判据是 D1 落地时的实测语料 `identity-corpus.json` —— 它记的是这一个。
     */
    indexBytes: p.keyBlocksLen
  }
  row.identityInput = idInput
  row.identity = dictUid(idInput)
  row.identityParts = dictIdentityParts(idInput)
  row.identityStrength = identityStrength(idInput)

  // ── 资源包（真的解 .mdd 的词表）──────────────────────────
  const exts = new Set()
  for (const r of resourcesOf(b)) {
    const res = scanResourcePackage(r.path)
    row.resources.push({
      name: r.name,
      bytes: r.size,
      ok: res.ok,
      why: res.why,
      detail: res.detail,
      count: res.count ?? 0,
      declared: res.declared ?? null,
      exts: res.exts ?? []
    })
    for (const [e] of res.exts ?? []) exts.add(e)
  }
  const looseCandidates = files.filter(
    (f) => f.dir === b.dir && !isMdx(f) && !isMdd(f) && !isIfo(f)
  )
  row.loose = looseCandidates.map((f) => f.name)

  const caps = bookCapabilities({
    format: p.format,
    resourceExtensions: [...exts],
    hasRedirects: false
  })
  row.capsBook = caps
  row.caps.audio = caps.includes('audio')
  row.caps.image = caps.includes('image')
  row.caps.html = caps.includes('html')
  if (hasOnlyUnplayableAudio([...exts])) {
    row.notes.push('资源包里有音频，但一条都放不响（Speex）')
  }

  if (p.encFlags & 1) {
    const d = diagnostics.encrypted(`Encrypted=${p.attrs['Encrypted']} RegisterBy=${p.registerBy}`)
    row.status = d.status
    row.diagnostic = { says: d.says, detail: d.detail }
    continue
  }

  if (PROBE_ONLY) continue

  // ── 真装一遍：词条数、正文抽样、lookup ─────────────────────
  let h = null
  try {
    h = Mdict.open(b.path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const d = /LZO/.test(msg)
      ? diagnostics.lzo(msg.split('\n')[0])
      : /不完整|对不上/.test(msg)
        ? diagnostics.corrupted(msg.split('\n')[0])
        : /加密/.test(msg)
          ? diagnostics.encrypted(msg.split('\n')[0])
          : diagnostics.indexError(msg.split('\n')[0])
    row.status = d.status
    row.diagnostic = { says: d.says, detail: msg.split('\n')[0] }
    row.lookup = { ok: false }
    continue
  }

  row.entryCountIndex = h.wordCount
  const bookRef = { uid: row.identity, id: 0, name: b.name.replace(/\.mdx$/i, '') }
  const s = sampleBook(h, bookRef, caps)
  row.sample = s
  row.lookup = lookupCheck(h)
  h.close()
  h.index.clear()
  h.offsets.length = 0

  row.caps.html = s.rawHtml > 0 || caps.includes('html')
  row.caps.phonetic = s.withPhonetic > 0
  row.caps.example = s.withExample > 0
  row.caps.translation = s.withGlossZh > 0 || s.withCjkGloss > 0
  row.caps.crossReference = s.rawEntryLink > 0 || s.withCrossRef > 0
  row.caps.redirect = s.redirects > 0

  // 正文引用了发音/图片，但资源包里没有 → 那些引用是死的
  if (s.rawSound > 0 && !row.caps.audio) {
    row.notes.push(
      row.resources.length === 0
        ? '正文里有 sound:// 引用，但一个 .mdd 都没有 —— 发音取不到'
        : '正文里有 sound:// 引用，但资源包里没有放得响的音频'
    )
  }
  if (s.rawImg > 0 && !row.caps.image) {
    row.notes.push('正文里有 <img>，但资源包里没有图片 —— 插图取不到')
  }

  if (!row.status) {
    if (!row.lookup.ok) {
      const d = diagnostics.indexError('索引建起来了，但抽样 20 个词目一条都查不到')
      row.status = d.status
      row.diagnostic = { says: d.says, detail: d.detail }
    } else if (s.decodeErrors > 0) {
      const d = diagnostics.partial('部分词条解不开。', caps, s.firstError ?? '')
      row.status = d.status
      row.diagnostic = { says: d.says, detail: d.detail }
    } else {
      const d = diagnostics.ready()
      row.status = d.status
      row.diagnostic = { says: d.says }
    }
  }
}

// ══ 五、报告 ════════════════════════════════════════════════

const yn = (v) => (v === null || v === undefined ? ' · ' : v ? ' ✓ ' : ' ✗ ')
const pad = (s, n) => {
  // 中文字符按两格算，否则表格会散
  let w = 0
  let out = ''
  for (const ch of String(s)) {
    const cw = /[\u2e80-\uffef]/.test(ch) ? 2 : 1
    if (w + cw > n) {
      out += '…'
      w += 1
      break
    }
    out += ch
    w += cw
  }
  return out + ' '.repeat(Math.max(0, n - w))
}
const num = (v) => (v === null || v === undefined ? '—' : String(v))

console.log(`真词典全量扫描 · ${DIR}`)
console.log(`.mdx/.ifo ${books.length} 个 · 孤儿 .mdd ${orphanMdd.length} 个 · 抽样 ${SAMPLE} 词/本`)
console.log()
console.log(
  pad('文件', 40) + pad('格式', 12) + pad('头部词条', 10) + pad('索引词条', 10) +
  pad('状态', 20) + ' html 音标 发音 插图 例句  lookup'
)
console.log('─'.repeat(130))
for (const r of rows) {
  const lk = r.lookup ? `${r.lookup.hit ?? 0}/${r.lookup.tried ?? 0}` : '—'
  console.log(
    pad(r.file, 40) + pad(r.format ?? '?', 12) +
    pad(num(r.entryCountHeader), 10) + pad(num(r.entryCountIndex), 10) +
    pad(r.status ?? '—', 20) +
    yn(r.caps.html) + '  ' + yn(r.caps.phonetic) + '  ' + yn(r.caps.audio) + '  ' +
    yn(r.caps.image) + '  ' + yn(r.caps.example) + '  ' + lk
  )
}

console.log()
console.log('══ 逐本明细 ══════════════════════════════════════════════')
for (const r of rows) {
  console.log()
  console.log(`● ${r.file}   ${(r.bytes / 1048576).toFixed(1)} MB`)
  console.log(`  格式        ${r.format}`)
  if (r.probe?.ok) {
    console.log(`  probe       Title=${JSON.stringify(r.probe.title)} Encoding=${r.probe.encoding} Format=${r.probe.format} Encrypted=${r.probe.encryptedFlags}`)
    console.log(`              词块 ${r.probe.numKeyBlocks} · 头部词条 ${r.probe.numEntries} · 索引 ${r.probe.keyIndexCompLen} 字节`)
  } else if (r.probe) {
    console.log(`  probe       失败（${r.probe.why}）：${r.probe.detail}`)
  }
  if (r.identity) {
    console.log(`  身份        ${r.identity}`)
    console.log(`              强度 ${r.identityStrength}`)
  }
  console.log(`  状态        ${r.status ?? '—'}`)
  if (r.diagnostic) {
    console.log(`  诊断        ${r.diagnostic.says}`)
    if (r.diagnostic.detail) console.log(`              detail: ${String(r.diagnostic.detail).slice(0, 120)}`)
  }
  console.log(`  词条数      头部 ${num(r.entryCountHeader)} · 建成索引 ${num(r.entryCountIndex)}`)
  if (r.sample) {
    const s = r.sample
    console.log(
      `  抽样        ${s.sampled} 条：重定向 ${s.redirects} · 有释义 ${s.withSenses} · 音标 ${s.withPhonetic} · ` +
      `例句 ${s.withExample} · 独立中译 ${s.withGlossZh} · 释义即中文 ${s.withCjkGloss}`
    )
    console.log(
      `  正文引用    sound:// ${s.rawSound} · <img> ${s.rawImg} · entry:// ${s.rawEntryLink} · ` +
      `HTML ${s.rawHtml}/${s.sampled}`
    )
    console.log(`  画像/档次   ${s.profileId ?? '无画像'} · 第①${s.tiers[1]} 第②${s.tiers[2]} 第③${s.tiers[3]}`)
    if (s.decodeErrors > 0) console.log(`  解码异常    ${s.decodeErrors} 条 · 首条：${s.firstError}`)
  }
  console.log(`  书级能力    ${r.capsBook.join(' ') || '—'}`)
  if (r.resources.length === 0) console.log('  资源包      无')
  for (const res of r.resources) {
    const head = `  资源包      ${res.name}  ${(res.bytes / 1048576).toFixed(1)} MB`
    if (!res.ok) {
      console.log(`${head}  → 解不开（${res.why}）${res.detail ? '：' + String(res.detail).slice(0, 60) : ''}`)
      continue
    }
    console.log(`${head}  ${res.count} 个资源`)
    console.log(`              ${res.exts.map(([e, n]) => `${e}×${n}`).join(' ')}`)
  }
  const bySig = new Map()
  for (const res of r.resources) {
    if (!res.ok) continue
    const sig = `${res.bytes}|${res.count}`
    bySig.set(sig, [...(bySig.get(sig) ?? []), res.name])
  }
  for (const [, names] of bySig) {
    if (names.length > 1) console.log(`  ⚠ 疑似重复资源包（大小与资源数完全相同）：${names.join(' · ')}`)
  }
  if (r.loose?.length) console.log(`  同目录散件  （整个目录共享）${r.loose.join(' · ')}`)
  if (r.lookup && r.lookup.tried) {
    console.log(`  lookup      抽 ${r.lookup.tried} 个词目，查到 ${r.lookup.hit} 个${r.lookup.sample ? ' · 例：' + r.lookup.sample : ''}`)
  } else if (r.lookup) {
    console.log('  lookup      装不起来，一个词都查不了')
  }
  for (const n of r.notes) console.log(`  ⚠ ${n}`)
}

if (orphanMdd.length > 0) {
  console.log()
  console.log('══ 孤儿资源包（有 .mdd 没有对应的 .mdx）════════════════')
  for (const f of orphanMdd) {
    const res = scanResourcePackage(f.path)
    console.log(
      `  ${relative(DIR, f.path).replace(/\\/g, '/')}  ${(f.size / 1024).toFixed(0)} KB  ` +
      (res.ok ? `${res.count} 个资源：${res.exts.map(([e, n]) => `${e}×${n}`).join(' ')}` : `解不开（${res.why}）`)
    )
  }
}

// ══ 六、与 D1 的实测语料对拍 ════════════════════════════════

const corpusPath = new URL('../src/core/dict/fixtures/identity-corpus.json', import.meta.url)
let corpus = null
try {
  corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
} catch {
  corpus = null
}

console.log()
console.log('══ 与 identity-corpus.json 对拍 ══════════════════════════')
if (!corpus) {
  console.log('  找不到 identity-corpus.json，跳过')
} else {
  const mine = rows.filter((r) => r.identityInput).map((r) => ({ file: r.file, input: r.identityInput }))
  console.log(`  语料 ${corpus.length} 本 · 本次量到 ${mine.length} 本`)
  const key = (o) =>
    [o.format, o.formatVersion, (o.encoding ?? '').toUpperCase(), o.title ?? '', o.entryCount, o.blockCount, o.indexBytes].join('|')
  const corpusKeys = new Map()
  for (const c of corpus) corpusKeys.set(key(c), c)
  const matched = []
  const unmatched = []
  for (const m of mine) {
    const k = key({
      format: m.input.format,
      formatVersion: m.input.formatVersion,
      encoding: m.input.encoding,
      title: m.input.title,
      entryCount: m.input.entryCount,
      blockCount: m.input.blockCount,
      indexBytes: m.input.indexBytes
    })
    if (corpusKeys.has(k)) {
      matched.push(m.file)
      corpusKeys.delete(k)
    } else unmatched.push(m)
  }
  console.log(`  逐字对上   ${matched.length} 本`)
  if (unmatched.length > 0) {
    console.log(`  对不上     ${unmatched.length} 本：`)
    for (const u of unmatched) {
      console.log(`      ${u.file}`)
      console.log(`        本次：${JSON.stringify(u.input)}`)
    }
  }
  if (corpusKeys.size > 0) {
    console.log(`  语料里有、这次没量到的 ${corpusKeys.size} 条：`)
    for (const c of corpusKeys.values()) console.log(`      ${JSON.stringify(c)}`)
  }
  const uids = new Set(rows.filter((r) => r.identity).map((r) => r.identity))
  console.log(`  身份碰撞   ${rows.filter((r) => r.identity).length} 本 → ${uids.size} 个身份 ${uids.size === rows.filter((r) => r.identity).length ? '✓' : '✗'}`)
}

if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(JSON_OUT, JSON.stringify({ dir: DIR, at: new Date().toISOString(), rows, orphanMdd: orphanMdd.map((f) => f.name) }, null, 2), 'utf8')
  console.log(`\nJSON 写到 ${JSON_OUT}`)
}
