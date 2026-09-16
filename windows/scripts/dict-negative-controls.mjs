#!/usr/bin/env node
/**
 * 反向验收 · 把修复删掉，看用例是不是真的会红（2026-08-19）
 *
 * ══ 为什么必须有这一条 ★★★ ═════════════════════════════════
 *
 * CLAUDE.md 9.1：
 *
 *   「第 ③ 档写完，把修复删掉再跑一次，确认它变红。
 *     不变红就说明这条用例没有在验你以为它在验的东西。」
 *
 * I-105 就是这么发现的：两个判断在那份数据上恰好一样，用例是**假绿**的。
 * 全绿的测试套件里混着几条假绿，比没有测试更糟 ——
 * **报警器不响的时候没人会去怀疑报警器。**
 *
 * ══ 它怎么做 ═══════════════════════════════════════════════
 *
 * 逐条：把源码里那一处修复替换成「没修之前的样子」→ 跑对应测试
 * → **必须失败** → 无论如何把文件还原。
 *
 * 还原是 `finally` + 收尾复查两道保险：中途被 Ctrl-C 打断也不会把源码留在改坏的状态。
 *
 * ══ 用法 ═══════════════════════════════════════════════════
 *
 *     node scripts/dict-negative-controls.mjs [--only <编号>]
 *
 * 全绿 = 每一条修复都有人守着。任何一条「删了还是绿」= 那条用例是假的。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOOKUP = 'src/core/dict/lookup.ts'
const IDENTITY = 'src/core/dict/identity.ts'
const REGISTRY = 'src/main/dict/registry.ts'
const MIGRATIONS = 'src/main/db/migrations.ts'
const PREFS = 'src/core/prefs.ts'
const SANITIZE = 'src/core/dict/html/sanitize.ts'
const LOOKUP_TEST = 'src/core/dict/lookup.test.ts'
const IDENTITY_TEST = 'src/core/dict/identity.test.ts'

/**
 * D2 那几条守在 `tests/db-safety.ts` 里 —— 它要 Electron（better-sqlite3 的 ABI）。
 * 所以那几条要**先重新打包再跑**，而且只跑名字里带 `D2 ·` 的那几条
 *（`--only` 是为这件事加的：跑得慢的闸没人会跑，那和没有闸是一回事）。
 */
const DB_SAFETY = { kind: 'electron', only: 'D2 ·' }

/**
 * 每一条 = 一处修复 + 「没修之前」的样子 + 谁应该因此变红。
 *
 * ★ `from` 必须在源码里**唯一**出现，找不到就直接判失败 ——
 *   源码改过之后这个脚本会先烂掉，而不是默默地什么都不验。
 */
const CONTROLS = [
  {
    id: 1,
    says: '不跟随 @@@LINK（把跳转记录当成正文交出去）',
    file: LOOKUP,
    from: `    const to = rec.redirectTo ?? detectRedirect(rec.body)
    if (!to) return { record: rec, headword: cur, occurrence: occ, redirectedFrom: path }`,
    to: `    const to = null
    if (!to) return { record: rec, headword: cur, occurrence: occ, redirectedFrom: path }`,
    test: LOOKUP_TEST
  },
  {
    id: 2,
    says: '不防环（A → B → A 会一直转下去，靠跳数上限才停）',
    file: LOOKUP,
    from: `    const key = normalizeKey(next, src.keyRules)
    if (visited.has(key)) {`,
    to: `    const key = normalizeKey(next, src.keyRules)
    if (false as boolean) {`,
    test: LOOKUP_TEST
  },
  {
    id: 3,
    says: '不限跳数（长链一直跟到底）',
    file: LOOKUP,
    from: `    if (hop >= maxHops) {`,
    to: `    if (false as boolean) {`,
    test: LOOKUP_TEST
  },
  {
    id: 4,
    says: '断链不给诊断（目标不存在就静悄悄返回空）',
    file: LOOKUP,
    from: `        diagnostic: diagnostics.redirectDangling(cur, to)`,
    to: `        diagnostic: undefined`,
    test: LOOKUP_TEST
  },
  {
    id: 5,
    says: '同形异义只留第一条（今天 main/dict/mdict.ts 就是这么写的）',
    file: LOOKUP,
    from: `  for (let i = 0; i < cap; i++) {
    const rec = src.raw(headword, i)
    if (!rec) break
    out.push(rec)
  }`,
    to: `  for (let i = 0; i < cap && i < 1; i++) {
    const rec = src.raw(headword, i)
    if (!rec) break
    out.push(rec)
  }`,
    test: LOOKUP_TEST
  },
  {
    id: 6,
    says: '无视 KeyCaseSensitive（一律折成小写）',
    file: LOOKUP,
    from: `  return rules.caseSensitive ? s : s.toLowerCase()`,
    to: `  return s.toLowerCase()`,
    test: LOOKUP_TEST
  },
  {
    id: 7,
    says: '无视 StripKey（不给去标点那一档候选）',
    file: LOOKUP,
    from: `  if (rules.stripKey) push(strippedKey(q, rules), 'stripped')`,
    to: `  if (false as boolean) push(strippedKey(q, rules), 'stripped')`,
    test: LOOKUP_TEST
  },
  {
    id: 8,
    says: '去标点当成主键形（re-cover 和 recover 并成一条）',
    file: LOOKUP,
    from: `export function normalizeKey(raw: string, rules: KeyRules): string {
  const s = raw.trim()`,
    to: `export function normalizeKey(raw: string, rules: KeyRules): string {
  const s = raw.trim().replace(/[-'’ ]/g, '')`,
    test: LOOKUP_TEST
  },
  {
    id: 9,
    says: '词典顺序压过候选词档次（词典在外层）',
    file: LOOKUP,
    from: `  for (const kind of allowed) {`,
    to: `  for (const kind of [...allowed].reverse()) {`,
    test: LOOKUP_TEST
  },
  {
    id: 10,
    says: '词形还原关掉（swayed 查不到 sway）',
    file: LOOKUP,
    from: `  const bases = ws.length === 1 ? [ws[0]!] : content
  for (const w of bases) for (const f of inflectionForms(w)) push(f, 'inflection')`,
    to: `  const bases: string[] = []
  for (const w of bases) for (const f of inflectionForms(w)) push(f, 'inflection')`,
    test: LOOKUP_TEST
  },
  {
    id: 11,
    says: 'formatVersion 过一道 parseFloat（"2.0" → "2"）',
    file: IDENTITY,
    from: `    normText(input.formatVersion),`,
    to: `    normText(String(parseFloat(String(input.formatVersion)))),`,
    test: IDENTITY_TEST
  },
  {
    id: 12,
    says: 'indexBytes 取成别的数（模拟取了 keyInfo 的长度）',
    file: IDENTITY,
    from: `    normInt(input.indexBytes)`,
    to: `    normInt(input.indexBytes === undefined || input.indexBytes === null ? null : 5336)`,
    test: IDENTITY_TEST
  },
  {
    id: 13,
    says: 'D2 · 删掉 I-106 的认领（搬家之后当成新词典）',
    /**
     * ★ 认领有**两处**：`claim()`（认出同一本，原地改路径）与
     *   `mergeOrphans()`（新旧两行并成一行，把设置过继过去）。
     *   只删前一处的话，后一处会把 enabled / sort_order 救回来 ——
     *   于是「删了还是绿」。第一版正是这样，这条控制当场把那个假绿抓了出来。
     *   所以这条控制删的是**整套 I-106 认领**。
     */
    patches: [
      {
        file: REGISTRY,
        from: `    const orphans = this.records().filter((r) => r.missing === 1)
    if (orphans.length === 0) return null`,
        to: `    const orphans = this.records().filter((r) => r.missing === 1)
    if (orphans.length >= 0) return null`
      },
      {
        file: REGISTRY,
        from: `  private mergeOrphans(now: number): void {`,
        to: `  private mergeOrphans(now: number): void {
    if (now > 0) return`
      }
    ],
    run: DB_SAFETY
  },
  {
    id: 14,
    says: 'D2 · 删掉 uid 识别（探测出来的身份不存）',
    file: REGISTRY,
    from: `      return {
        uid: p.uid,`,
    to: `      return {
        uid: null,`,
    run: DB_SAFETY
  },
  {
    id: 15,
    says: 'D2 · 诊断不落库（只留在内存里，重启就没了）',
    file: REGISTRY,
    from: `JSON.stringify(p.diagnostic)`,
    to: `null`,
    expect: 2,
    run: DB_SAFETY
  },
  {
    id: 16,
    says: 'D2 · 迁移里去读词典目录（升级时做词典 I/O）',
    patches: [
      {
        file: MIGRATIONS,
        from: `import type { Database } from 'better-sqlite3'`,
        to: `import type { Database } from 'better-sqlite3'
import { readdirSync } from 'node:fs'`
      },
      {
        file: MIGRATIONS,
        from: `    db.exec(\`alter table dictionaries add column uid text\`)`,
        to: `    void readdirSync('.').length
    db.exec(\`alter table dictionaries add column uid text\`)`
      }
    ],
    run: DB_SAFETY
  },
  {
    id: 17,
    says: 'D2.1 · 默认词典存回本机 id（换台设备就指到另一本书）',
    patches: [
      {
        file: PREFS,
        from: `      if (!text.startsWith(DICT_UID_PREFIX)) {`,
        to: `      if (false as boolean) {`
      },
      {
        file: REGISTRY,
        from: `    if (!row?.uid) return
    this.prefs.set('dict.default', row.uid)`,
        to: `    if (!row) return
    this.prefs.set('dict.default', String(row.id))`
      }
    ],
    run: { kind: 'electron', only: 'D2.1' }
  },
  {
    id: 18,
    says: 'D2.1 · 解析不出真实词典时编一个 uid 出来',
    file: MIGRATIONS,
    from: `        const uid = row?.uid ?? null`,
    to: `        const uid = row?.uid ?? 'dictionaries-nat-mdict|2.0|UTF-8|编出来的|1|1|1'`,
    run: { kind: 'electron', only: 'D2.1' }
  },
  {
    id: 19,
    says: 'D2.1 · 退回时偷偷把他的偏好改成本机现有的那本',
    file: REGISTRY,
    from: `    return { book: first, wanted, fellBack: wanted !== null && first !== null }
  }`,
    to: `    const sneaky = (first as DictRecord | null)?.uid
    if (sneaky) this.prefs.set('dict.default', sneaky)
    return { book: first, wanted, fellBack: wanted !== null && first !== null }
  }`,
    run: { kind: 'electron', only: 'D2.1' }
  },
  {
    id: 20,
    says: 'D3 · 不跟随 @@@LINK —— 第③档的真实屏幕必须变红',
    file: LOOKUP,
    from: `    const to = rec.redirectTo ?? detectRedirect(rec.body)
    if (!to) return { record: rec, headword: cur, occurrence: occ, redirectedFrom: path }`,
    to: `    const to = null
    if (!to) return { record: rec, headword: cur, occurrence: occ, redirectedFrom: path }`,
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 21,
    says: 'D3 · 屏幕上仍显示他划的那个词（跳转跟了，但没把命中的词目显示出来）',
    /**
     * ★ 两条路都要拆：D4 之后**卡片走的是富词条那条**（`rich.ts`），
     *   老那条（`shownHeadword`）只喂 `lookup` / `lookupCard`。
     *   只拆老的那条，屏幕照样显示 `child` —— 控制就假绿了（D4 跑完当场发现的）。
     */
    patches: [
      {
        file: 'src/main/dict/index.ts',
        from: `  return hit.redirectedFrom.length > 0 ? hit.headword : hit.candidate.text`,
        to: `  return hit.candidate.text`
      },
      {
        file: 'src/main/dict/rich.ts',
        from: `    headword: hit.headword,`,
        to: `    headword: query,`
      }
    ],
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 22,
    says: 'D4 · 删掉 MDD 取字节 —— 真实屏幕上的发音必须变红',
    file: 'src/main/dict/mdd.ts',
    from: `  get(key: string): Buffer | null {
    const at = this.index.get(normalizeResourceKey(key))`,
    to: `  get(key: string): Buffer | null {
    if (key) return null
    const at = this.index.get(normalizeResourceKey(key))`,
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 23,
    says: 'D4 · 图片引用不改写（<img> 拿不到 ref）—— 插图必须变红',
    file: SANITIZE,
    from: `        if (name === 'src' && el.tag === 'img') {`,
    to: `        if (false as boolean) {`,
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 24,
    says: 'D4 · 把 .spx 当成能播的 —— LDOCE5 会长出假的发音按钮',
    file: 'src/core/dict/capability.ts',
    from: `const PLAYABLE_AUDIO = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'webm'])`,
    to: `const PLAYABLE_AUDIO = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'webm', 'spx'])`,
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 25,
    says: 'D4 · 把词典 HTML 注进主文档（不用 Shadow DOM）—— 隔离必须变红',
    file: 'src/renderer/src/DictHtml.svelte',
    from: `    shadow ??= host.attachShadow({ mode: 'open' })
    const root = shadow`,
    to: `    const root = host as unknown as ShadowRoot`,
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 26,
    says: 'D4 · 不剥 <script> / on* —— 安全那一条必须变红',
    file: SANITIZE,
    from: `      if (name.startsWith('on')) {
        stripped.events++
        continue
      }`,
    to: `      if (false as boolean) {
        stripped.events++
        continue
      }`,
    test: 'src/core/dict/html/sanitize.test.ts',
    run: { kind: 'node' }
  },
  {
    id: 27,
    says: 'D4 · 不看 capability，「有这个字段就画按钮」—— 假能力必须变红',
    /**
     * ★ 他点名的反模式就是 `if (entry.audio)`。
     *   卡片上有**两道**闸：① 条目能力里有没有 audio ② 这一条资源放不放得响。
     *   只拆一道另一道还在（第一版只拆了 ②，控制照样绿）——
     *   所以这条控制把两道一起拆掉，还原成「有字段就显示」。
     */
    patches: [
      {
        file: 'src/renderer/src/DictCard.svelte',
        from: `    if (!has(caps, 'audio')) return []`,
        to: `    if (false as boolean) return []`
      },
      {
        file: 'src/renderer/src/DictCard.svelte',
        from: `      if (!p.audio || !mediaUsable(p.audio)) continue`,
        to: `      if (!p.audio) continue`
      }
    ],
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  /**
   * ★ 28 号退休（2026-08-20）。它守的是「中文对译单独成块」在**卡片上**的样子，
   *   而卡片现在只显示词典原文 —— 那一块在屏幕上已经不存在，
   *   再留着它只会永远绿，变成一张安慰牌。
   *   解析层面的那条保证还在：`tests/dict-behavior.ts` 的 rich 一节逐词对拍。
   */
  {
    id: 29,
    says: 'D5.1a · 拿掉 LZO 解压 —— 两本老版 MDict 必须重新变成「读不了」',
    file: 'src/core/dict/lzo1x.ts',
    from: `  if (src.length === 0) return new Uint8Array(0)`,
    to: `  if (src.length >= 0) throw new LzoError('LZO 解压被拿掉了')`,
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 30,
    says: 'D5.1a · 往回引用改成整段搬（不逐字节）—— 重叠引用必须变红',
    file: 'src/core/dict/lzo1x.ts',
    from: `    for (let i = 0; i < n; i++) out[op++] = out[from + i]!`,
    to: `    out.set(out.subarray(from, from + n), op)
    op += n`,
    test: 'src/core/dict/lzo1x.test.ts',
    run: { kind: 'node' }
  },
  {
    id: 31,
    says: '不把词典原文交给界面（out.html 置空）—— 卡片上就什么都没有了，必须变红',
    file: 'src/main/dict/rich.ts',
    from: `  out.html = clean.html`,
    to: `  out.html = ''`,
    test: 'tests/ui-dict.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 32,
    says: '纯文本词典不再保住自己的换行（当 HTML 揉成一段）—— 那本必须变红',
    file: 'src/renderer/src/DictHtml.svelte',
    from: `    if (plain) box.className = 'nyx-plain'`,
    to: ``,
    test: 'tests/study.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 33,
    says: 'D5.1b · GBK 当成 UTF-8（修之前的样子）—— 第①档必须变红',
    file: 'src/core/dict/encoding.ts',
    from: `  if (s.startsWith('GB')) return 'gbk'`,
    to: `  if (s.startsWith('GB')) return 'utf8'`,
    test: 'src/core/dict/encoding.test.ts',
    run: { kind: 'node' }
  },
  {
    id: 34,
    says: 'D5.1b · 读词那条路不解 GBK（体检那条路照旧说 gbk）—— 整条解析路必须变红',
    file: 'src/main/dict/mdict.ts',
    from: `      ? decodeGbk(buf.subarray(start, end))`,
    to: `      ? buf.toString('utf8', start, end)`,
    test: 'tests/dict-mdx.test.ts',
    run: { kind: 'node' }
  },
  {
    id: 35,
    says: 'D5.1b · GBK 当成 UTF-8 —— 第③档（他屏幕上那本 GBK）必须变红',
    file: 'src/core/dict/encoding.ts',
    from: `  if (s.startsWith('GB')) return 'gbk'`,
    to: `  if (s.startsWith('GB')) return 'utf8'`,
    test: 'tests/study.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 36,
    says: 'D5.1c · 正文按「第一个 0 字节」切（UTF-16 会只剩半个字符）—— 第①档必须变红',
    file: 'src/core/dict/encoding.ts',
    from: `  for (let i = 0; i + 1 < bytes.length; i += 2) {`,
    to: `  for (let i = 0; i + 1 < bytes.length; i += 1) {`,
    test: 'src/core/dict/encoding.test.ts',
    run: { kind: 'node' }
  },
  {
    id: 37,
    says: 'D5.1c · 1.2 版的索引 pad 又写死成 1（老代码的样子）—— 整条解析路必须变红',
    file: 'src/main/dict/mdict.ts',
    from: `        const pad = v2 ? 1 : 0`,
    to: `        const pad = this.encoding === 'utf16le' ? 1 : v2 ? 1 : 0`,
    test: 'tests/dict-mdx.test.ts',
    run: { kind: 'node' }
  },
  {
    id: 38,
    says: 'D5.1c · 正文的结尾又用 indexOf(0) —— 第③档（他屏幕上那本 UTF-16）必须变红',
    file: 'src/main/dict/mdict.ts',
    from: `    const cut = trimBodyTerminator(all, this.encoding)`,
    to: `    const nul = all.indexOf(0)
    const cut = nul >= 0 ? all.subarray(0, nul) : all`,
    test: 'tests/study.test.ts',
    run: { kind: 'node', build: true }
  },
  {
    id: 39,
    says: 'D5.2 · 扫描又把每一本都装载一遍（启动那 6.8 秒的来源）—— 第②档必须变红',
    file: 'src/main/dict/registry.ts',
    from: `    return this.list()
  }

  /**
   * ★★ I-106 · 认领。`,
    to: `    for (const r of this.records()) if (!r.missing) this.handle(r.ifoPath)
    return this.list()
  }

  /**
   * ★★ I-106 · 认领。`,
    test: '扫完一本都没装载',
    run: { kind: 'electron', only: '扫完一本都没装载' }
  },
  {
    id: 40,
    says: 'D5.2 · 只信二分、把兜底全扫删掉 —— BOM / 前导标点 / 首尾倒挂三条必须变红',
    file: 'src/main/dict/mdict-has.ts',
    from: `    for (let i = 0; i < blocks.length; i++) {
      if (i === guess) continue // 刚看过`,
    to: `    for (let i = 0; i < 0; i++) {
      if (i === guess) continue // 刚看过`,
    test: 'tests/dict-has.test.ts',
    run: { kind: 'node' }
  }
]


const only = process.argv.includes('--only')
  ? Number(process.argv[process.argv.indexOf('--only') + 1])
  : null

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)

const originals = new Map()
const read = (rel) => {
  if (!originals.has(rel)) originals.set(rel, readFileSync(join(ROOT, rel), 'utf8'))
  return originals.get(rel)
}
const restoreAll = () => {
  for (const [rel, text] of originals) writeFileSync(join(ROOT, rel), text, 'utf8')
}

process.on('SIGINT', () => {
  restoreAll()
  process.exit(130)
})

const require_ = createRequire(import.meta.url)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** 打一次包 —— D2 那几条守在 `tests/db-safety.ts` 里，它跑的是 `out/main` 的产物 */
function rebuild() {
  const r = spawnSync(npm, ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 300_000 })
  return r.status === 0
}

/** 跑一条控制对应的测试。返回 `{ red, note }` */
function runTest(c) {
  if (c.run?.kind === 'electron') {
    if (!rebuild()) return { red: true, note: '打包就没过（也算红，但要看一眼是不是打包本身坏了）' }
    const electron = require_('electron')
    const r = spawnSync(electron, ['out/main/db-safety.js', '--only', c.run.only], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000
    })
    const failing = [...(r.stdout ?? '').matchAll(/✖ (.+)/g)].map((m) => m[1].trim())
    return { red: r.status !== 0, note: failing.slice(0, 3).join(' · ') }
  }
  /**
   * ★ 第③档跑的是 `out/` 里的**打包产物**，源码改了不重打就等于没改 ——
   *   那正是这个项目栽过四次的那种病（第九节）。所以 `build: true` 的必须先重打。
   */
  if (c.run?.build && !rebuild()) return { red: true, note: '打包就没过（要看一眼是不是打包本身坏了）' }
  const r = spawnSync(process.execPath, ['--test', c.test], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: c.run?.build ? 600_000 : 90_000
  })
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal !== null
  const failing = [...(r.stdout ?? '').matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1])
  return {
    red: timedOut || r.status !== 0,
    note: timedOut ? '**转死了**（超时 90 秒）—— 这本身就是没有上限的后果' : failing.slice(0, 3).join(' · ')
  }
}

/**
 * ★★ 换行符对齐 —— 这把尺子自己的一处坑（2026-08-20 补）。
 *
 * 这个文件里的锚点都是 LF 写的，而仓库工作副本是 CRLF（git 的 autocrlf）。
 * 只要有谁对某个文件 `git checkout` 一次，它就从 LF 变回 CRLF，
 * 于是这里所有多行锚点**一次都匹配不上** —— 报出来是「锚点出现 0 次」，
 * 看着像「这条控制过时了」，实际上是**报警器自己坏了**。
 * （22 号就这么坏过一次：它守的是 MDD 取字节，正好是最不该没人守的地方。）
 */
const align = (src, text) => (src.includes(CR + LF) ? text.split(LF).join(CR + LF) : text)

const results = []
try {
  for (const c of CONTROLS) {
    if (only !== null && c.id !== only) continue
    /** 一条控制可以动好几处（比如「迁移里做 I/O」要先补一句 import） */
    const patches = c.patches ?? [{ file: c.file, from: c.from, to: c.to, expect: c.expect ?? 1 }]

    let broken = null
    for (const patch of patches) {
      const src = read(patch.file)
      const want = patch.expect ?? 1
      const hits = src.split(align(src, patch.from)).length - 1
      if (hits !== want) {
        broken = `锚点在 ${patch.file} 里出现 ${hits} 次，应该是 ${want} 次`
        break
      }
    }
    if (broken) {
      results.push({ ...c, verdict: 'BROKEN', note: broken })
      continue
    }

    for (const patch of patches) {
      const src = readFileSync(join(ROOT, patch.file), 'utf8')
      writeFileSync(join(ROOT, patch.file), src.split(align(src, patch.from)).join(align(src, patch.to)), 'utf8')
    }

    const { red, note } = runTest(c)
    restoreAll()
    results.push({ ...c, verdict: red ? 'RED' : 'GREEN', note })
  }
} finally {
  restoreAll()
  /**
   * ★★ 还原源码还不够：Electron 那几条跑的是 `out/main` 里的**打包产物**，
   *   而那份产物是用**改坏的源码**打出来的。不重打一次就走人，
   *   下一个人跑 `npm run test:db` 用的就是那份坏的 —— 而源码看上去完全正常。
   *   「我改的那份和他跑的那份不是同一份」在这个项目里已经出过四次了（第九节）。
   */
  if (results.some((r) => r.run?.kind === 'electron' || r.run?.build)) {
    console.log('还原之后重新打包一次（Electron 那几条跑的是打包产物）…')
    console.log(rebuild() ? '  打包好了' : '  ★ 打包失败，手动跑一次 npm run build')
  }
}

// 收尾复查：源码真的还原了吗
let dirty = 0
for (const [rel, text] of originals) {
  if (readFileSync(join(ROOT, rel), 'utf8') !== text) dirty++
}

console.log('反向验收 · 把修复删掉，用例应该变红\n')
console.log('  #  结果   删掉的是什么')
console.log('  ' + '─'.repeat(96))
for (const r of results) {
  const mark = r.verdict === 'RED' ? '红 ✓' : r.verdict === 'GREEN' ? '绿 ✗' : '坏 ✗'
  console.log(`  ${String(r.id).padStart(2)} ${mark}  ${r.says}`)
  if (r.note) console.log(`        ${r.note}`)
}

const bad = results.filter((r) => r.verdict !== 'RED')
console.log()
if (dirty > 0) {
  console.log(`⚠ 有 ${dirty} 个文件没还原干净 —— 立刻 git diff 看一眼`)
}
if (bad.length === 0) {
  console.log(`全部 ${results.length} 条都变红 —— 每一处修复都有人守着。`)
} else {
  console.log(`有 ${bad.length} 条没变红：`)
  for (const r of bad) console.log(`  ${r.id} · ${r.says}${r.note ? ' —— ' + r.note : ''}`)
  console.log('「删了还是绿」= 那条用例没有在验你以为它在验的东西（I-105）。')
}
process.exit(bad.length > 0 || dirty > 0 ? 1 : 0)
