/**
 * check:contract · 跨端契约的漂移闸（T-9.7 · 2026-09-06）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * `docs/DATA_CONTRACT.md` 是两端唯一的形状契约，它自己的文件头写着读法：
 *
 *   「读的人手上只有源码和它。**所以这里的每一句都必须能指回一个文件**；
 *     写错了撞到的是『照着合同写、跑起来不是那样』，而同步这一层的错**全是静默的**。」
 *
 * 可是 T-2.8 重述之后，§十一 那十六条里只有两条有机器闸，其余靠人读。
 * 合同因此会再漂 —— `qtypes` 那条（「自定义题型留给 Windows」，而手机 2026-09-01 起就能改了）
 * **漏了四天才被发现**。漂了的代价不是文档不好看：下一个会话照着合同写代码，
 * 写出来的东西和真实的库对不上，而且不报错。
 *
 * ── 判据：只判**可判定的事实**，一律不判措辞 ────────────────
 *
 *   ① §1.2 逐表清单里的表名集合 = `src/core/sync-tables.ts::SYNC_TABLES`
 *      （多一张少一张都红，并报出是哪张；小节标题里那个「N 张」也要对得上）
 *   ② 合同里写的偏好白名单项数 = `src/core/prefs.ts::PREF_KEYS.length`
 *      —— **import 那个 .ts 来算，不在这里自己数**
 *   ③ 合同里引用的源码路径都还存在（`src/…` · `tests/…` · `scripts/…` · `schema/…` ·
 *      `prompts/…` · `docs/…` · `core/…` → `src/core/…` · `main/…` → `src/main/…` ·
 *      `Nyx-Android/…` 去 Android 仓查）
 *   ④ 文件头「最近一次逐节对照源码」那一行的 `nyx_project@<sha>` 是本仓真实存在的提交
 *
 * ★ **有意不做的**：不判措辞、不判某一段说得对不对、不改合同一个字。
 *   那是人读的时候的事，而且合同正文只由主控改（C-001）。这条闸只负责说「哪一行漂了」。
 * ★ 拿不准的路径**不判红，只计数**（见 ③ 的 UNKNOWN_ROOT）——
 *   一条会误报的闸，用不了几次就会被人绕过去，那比没有闸更糟。
 * ★ 找不到 Android 仓就把那几条**跳过并打印一行**（和 `check:android-imports` 同一条约定）。
 *
 * 用法：node scripts/check-contract.mjs
 *   `NYX_CONTRACT=<别的 md>` 可以让它去查另一份文件 —— 负向对照拿副本做，
 *   仓里那份合同一个字节都不用动。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findAndroidRepo } from './android-repo.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = process.env.NYX_CONTRACT ?? join('docs', 'DATA_CONTRACT.md')
const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const TICK = String.fromCharCode(96)

let src
try {
  src = readFileSync(FILE, 'utf8')
} catch {
  console.error(`✗ check:contract　读不到 ${FILE}`)
  process.exit(1)
}
const lines = src.split(CR).join('').split(NL)
const fail = []
/** 报错要说得出「哪一行」——行号从 1 起 */
const at = (i) => `${FILE}:${i + 1}`

// ══ ① §1.2 的表名集合 = SYNC_TABLES ═══════════════════════
const { SYNC_TABLES } = await import(pathToFileURL(join(ROOT, 'src/core/sync-tables.ts')).href)
const want = new Set(SYNC_TABLES)

const secAt = lines.findIndex((l) => l.startsWith('### 1.2'))
if (secAt < 0) {
  fail.push('找不到「### 1.2 逐表」那一节 —— 表清单是这条闸的主要判据，它没了就等于闸没了')
} else {
  // 小节标题里的「N 张」
  const nSaid = /(\d+)\s*张/.exec(lines[secAt])
  if (!nSaid) {
    fail.push(`${at(secAt)} 小节标题里读不到「N 张同步表」：${lines[secAt].trim()}`)
  } else if (Number(nSaid[1]) !== SYNC_TABLES.length) {
    fail.push(
      `${at(secAt)} 标题说「${nSaid[1]} 张同步表」，SYNC_TABLES 实际 ${SYNC_TABLES.length} 张` +
        `${NL}    → 改标题那个数字（判据在 src/core/sync-tables.ts，不在合同里）`
    )
  }

  // 表格第一列里的每一个 `name`
  const got = new Map() // 表名 → 行号
  for (let i = secAt + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('### ') || l.startsWith('## ')) break
    if (!l.startsWith('|')) continue
    const first = l.slice(1).split('|')[0] ?? ''
    for (const m of first.matchAll(new RegExp(TICK + '([a-z_][a-z0-9_]*)' + TICK, 'g'))) {
      if (!got.has(m[1])) got.set(m[1], i)
    }
  }
  if (got.size === 0) {
    fail.push(`${at(secAt)} §1.2 的表格里一张表都没读出来 —— 表格形状变了？这条闸看不住它了`)
  }
  for (const [t, i] of got) {
    if (!want.has(t)) {
      fail.push(
        `${at(i)} 合同列了 \`${t}\`，但 SYNC_TABLES 里没有它` +
          `${NL}    → 要么这张表已经不同步了（合同该改），要么表名拼错了`
      )
    }
  }
  for (const t of want) {
    if (!got.has(t)) {
      fail.push(
        `SYNC_TABLES 里有 \`${t}\`，§1.2 的逐表清单却没写它` +
          `${NL}    → 少一张表，读合同的人就不知道它归谁写、会不会冲突（${at(secAt)} 那一节）`
      )
    }
  }
}

// ══ ② 偏好白名单的项数 = PREF_KEYS.length ═════════════════
const { PREF_KEYS } = await import(pathToFileURL(join(ROOT, 'src/core/prefs.ts')).href)
/** 只认「确实在说偏好白名单」的那几行 —— 别的地方将来出现「N 项」不该被这条闸误伤 */
const ABOUT_PREFS = ['PREF_KEYS', '白名单', '跟着人走']
let prefHits = 0
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  if (!ABOUT_PREFS.some((k) => l.includes(k))) continue
  for (const m of l.matchAll(/(\d+)\s*项/g)) {
    prefHits++
    if (Number(m[1]) !== PREF_KEYS.length) {
      fail.push(
        `${at(i)} 合同写「${m[1]} 项」偏好白名单，PREF_KEYS 实际 ${PREF_KEYS.length} 项` +
          `${NL}    → 判据在 src/core/prefs.ts 的 PREF_SPECS（含 PROMPT_PREF_SPECS），改那个数字`
      )
    }
  }
}
if (prefHits === 0) {
  fail.push(
    '合同里一处「N 项白名单」都找不到了 —— 这条闸原本盯着三处（§1.2 / §二 / §四）' +
      `${NL}    → 措辞可以改，但请留一处带数字的说法，否则这一条就是摆设`
  )
}

// ══ ③ 引用的源码路径都还存在 ═══════════════════════════════
/** 反引号里像文件的东西：带斜杠 + 已知后缀。`a.ts::fn` 与 `a.ts:12` 都只取文件那一段 */
const EXT = ['.ts', '.tsx', '.mjs', '.js', '.svelte', '.sql', '.java', '.json']
const ANDROID = findAndroidRepo().dir

/**
 * 把合同里的写法映射到磁盘。**认不出前缀的一律不判红，只计数。**
 *
 * ★ 三条有意为之的边界（第一版四条误报，全出在这里）：
 *   · **不判文档**（`.md`、以及任何 `docs/` 下的东西）——
 *     合同的历史小节会点名当年改过的文档，那些文档后来被重组掉了。
 *     「源码路径还在不在」是可判定的事实；「历史记录里提到的文档还在不在」不是。
 *     （实测有两处这样的悬空引用，已在 T-9.7 的报告里列给主控，不由这条闸判。）
 *   · **带 `*` 的是通配，不是文件**（`tests/sync-baseline/*.json`）。
 *   · 合同是**跨仓**文档：Android 那边的路径常写成裸的 `src/db/sync-runner.ts`。
 *     所以本仓找不到时**再去 Android 仓找一次**，两个仓都没有才算错。
 */
const candidatesFor = (p) => {
  if (p.includes('*') || p.includes('<')) return [] // 通配 / 占位符（`nyx/devices/<设备>.json`），不判
  if (p.endsWith('.md')) return [] // 文档不判，见上
  if (p.startsWith('Nyx-Android/')) {
    if (p.startsWith('Nyx-Android/docs/')) return []
    return ANDROID ? [join(ANDROID, p.slice('Nyx-Android/'.length))] : null // null = 没那个仓，跳过
  }
  if (p.startsWith('docs/')) return []
  const out = []
  for (const pre of ['src/', 'tests/', 'scripts/', 'schema/', 'prompts/']) {
    if (p.startsWith(pre)) out.push(join(ROOT, p))
  }
  // 合同里习惯省掉 `src/`：`core/prefs.ts` · `main/sync/index.ts`
  if (p.startsWith('core/') || p.startsWith('main/') || p.startsWith('renderer/') || p.startsWith('shared/')) {
    out.push(join(ROOT, 'src', p))
  }
  /**
   * ★ 再省一层的两种写法，两个仓都要试：
   *   `sync/types.ts`      → 本仓 src/core/sync/ 或 src/main/sync/
   *   `db/sync-runner.ts`  → Android 的 src/db/（合同里 Android 那侧常这么写）
   */
  if (p.startsWith('sync/') || p.startsWith('db/') || p.startsWith('analysis/') || p.startsWith('ui/')) {
    out.push(join(ROOT, 'src', 'core', p), join(ROOT, 'src', 'main', p))
    if (ANDROID) out.push(join(ANDROID, 'src', p))
  }
  if (out.length === 0) return undefined // 认不出，不判
  // 跨仓兜底：本仓没有就去 Android 仓看看（`src/db/…` 那一类）
  if (ANDROID) out.push(join(ANDROID, p))
  return out
}

let checked = 0
let unknown = 0
let androidSkipped = 0
let inFence = false
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  if (l.trimStart().startsWith('```')) {
    inFence = !inFence
    continue
  }
  if (inFence) continue // 代码块里的路径多半是示意，不逐条判
  for (const m of l.matchAll(new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g'))) {
    let p = m[1].trim().split('::')[0].trim()
    p = p.replace(/:\d+(?:[-–]\d+)?$/, '') // `a.ts:2301` / `a.ts:12-20`
    if (!p.includes('/')) continue
    if (!EXT.some((e) => p.endsWith(e))) continue
    const cands = candidatesFor(p)
    if (cands === undefined) {
      unknown++
      continue
    }
    if (cands === null) {
      androidSkipped++
      continue
    }
    if (cands.length === 0) continue // 通配 / 文档，有意不判
    checked++
    if (!cands.some((abs) => existsSync(abs))) {
      fail.push(
        `${at(i)} 合同引用了 \`${p}\`，这个文件不存在` +
          `${NL}    → 找过：${cands.join(' · ')}` +
          `${NL}    → 文件搬走 / 改名了就把合同里这一处改对（合同以源码为准）`
      )
    }
  }
}

// ══ ④ 文件头的对照提交号真实存在 ═══════════════════════════
const ANCHOR = '最近一次逐节对照源码'
const headAt = lines.findIndex((l) => l.includes(ANCHOR))
if (headAt < 0) {
  fail.push(`文件头找不到「${ANCHOR}」那一行 —— 没有它就不知道这份合同对的是哪一版源码`)
} else {
  // 那一行可能折行，往后再看两行
  const head = lines.slice(headAt, headAt + 3).join(NL)
  const m = /nyx_project@([0-9a-f]{7,40})/.exec(head)
  if (!m) {
    fail.push(
      `${at(headAt)}「${ANCHOR}」那一行读不出 \`nyx_project@<提交号>\`` +
        `${NL}    → 它是「这份合同对的是哪一版源码」的唯一凭据，别省掉`
    )
  } else {
    let ok = true
    try {
      execFileSync('git', ['cat-file', '-e', m[1] + '^{commit}'], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'ignore']
      })
    } catch {
      ok = false
    }
    if (!ok) {
      fail.push(
        `${at(headAt)} 文件头写着对照提交 \`${m[1]}\`，本仓里没有这个提交` +
          `${NL}    → 逐节对照过之后要把它刷成当时的 HEAD（写错了就没人查得回去）`
      )
    }
  }
}

// ══ ⑤ `tts.*` 的键面分层 —— **D-466 之后只剩两把开关，闸跟着收窄** ═══
//
// ── 原来这一段在守什么 ────────────────────────────────────
//
// Voice 的键曾经分两层，而两层长得一模一样（都是 `tts.` 开头的字符串）：
// 音色 / 来源顺序跟着人走，地址 / 密钥 / 区域跟着机器走。名单是手写的，
// 加一家提供者时最容易顺手多写一行 —— 把 baseUrl / apiKey 错分到 USER，
// 他的凭据就上了他自己的云端桶（D-220 写死了「secret 永不上云」）。
//
// ── D-466 之后 ────────────────────────────────────────────
//
// 提供者整条线撤了：没有八家、没有音色键、没有地址与凭据要分层。
// 语音偏好只剩四把（两个开关 + 口音 + 语速），一把都不带凭据。
// 所以那一整段（照 `VOICE_SOURCES` 生成名单、逐家比对 voicePref）删掉 ——
// **守一个不存在的分层的闸，只会在下一次重构时被人当噪音绕过去**。
//
// 留下来的是与那张注册表无关、而且永远该成立的那两条：
// 任何 `tts.` 开头的白名单键，都不许过得了 `looksLikeSecret`，也不许长得像地址。
const { looksLikeSecret } = await import(pathToFileURL(join(ROOT, 'src/core/prefs.ts')).href)

const prefSet = new Set(PREF_KEYS)
/** 长得像地址的：这些词出现在键名里就不该跟着人走 */
const ADDRESSY = ['baseurl', 'endpoint', 'url', 'host', 'region', 'account']
let ttsChecked = 0

for (const k of PREF_KEYS) {
  if (!k.startsWith('tts.')) continue
  ttsChecked += 1
  if (looksLikeSecret(k)) {
    fail.push(`★★★ Voice 键面：白名单里的 \`${k}\` 过不了 looksLikeSecret —— 凭据不许跟着人走`)
  }
  const low = k.toLowerCase()
  const hit = ADDRESSY.find((w) => low.includes(w))
  if (hit) {
    fail.push(
      `★★ Voice 键面：白名单里的 \`${k}\` 名字里带「${hit}」，像是地址而不是偏好` +
        `${NL}    → 地址跟着机器走；真要同步它得先有人点头（D-404⑫ / D-220）`
    )
  }
}

/**
 * ★★ D-466 · 退役的那一串**一把都不许回到白名单里**。
 *
 * 它们是「云端 + 多厂商 + 来源排序」那个世界的产物，库里那几行按 D-216 留着，
 * 但代码不再读写、白名单不再收。写死一份名单在这里是有意的：
 * 判据要是从被测对象（当前白名单）推出来的，两边一起漂的时候照样绿。
 */
const D466_RETIRED = [
  'tts.sources',
  'tts.sourcesEditedAt',
  'tts.sourcesMigratedAt',
  'tts.cloud',
  'tts.model',
  'tts.voice',
  'tts.provider.openai-compatible.voice',
  'tts.provider.google-cloud.voice'
]
for (const k of D466_RETIRED) {
  ttsChecked += 1
  if (prefSet.has(k)) {
    fail.push(
      `★★★ Voice 键面：\`${k}\` 又回到 PREF_KEYS 里了 —— D-466 把它退役了` +
        `${NL}    → 撤销过的东西再加回来之前，先找出当初为什么撤（D-457）`
    )
  }
}

/** ★ 反过来：两把新开关**必须**在白名单里（「我要不要词典音」跟着人走） */
for (const k of ['tts.dictionary', 'tts.system', 'tts.accent', 'tts.rate']) {
  ttsChecked += 1
  if (!prefSet.has(k)) {
    fail.push(
      `★★★ Voice 键面：\`${k}\` 不在 PREF_KEYS 里 —— 它是 USER 偏好，换台设备该自动恢复`
    )
  }
}

// ══ ⑥ 提示词覆盖体系：说明 ↔ OVERRIDABLE_PROMPTS 逐条对得上（T-7.3）═
//
// ── 为什么这条闸值得存在 ────────────────────────────────────
//
// 「他改过的提示词」这件事有三个地方能改（`docs/PROMPT_LAYERS.md` 说全了），
// 而**能被覆盖的名单只有一份**：`core/prompt-overrides.ts::OVERRIDABLE_PROMPTS`。
// 加一条提示词的动作是「往那个数组里写一行」——白名单 `PREF_SPECS` 是从它生成的，
// 所以代码这半边不会漏；**漏的一定是文档那半边**。
//
// 文档漂了的代价和别处不一样：下一个人读完那张表，以为某条能覆盖 / 以为默认在 md 里，
// 照着写出来的东西**跑起来不是那样，而且不报错**（`loadPrompt` 缺一层就静默往下落）。
//
// ── 判据：只判可判定的事实 ─────────────────────────────────
//
//   名字集合   §一 那张表的四条 = OVERRIDABLE_PROMPTS，多一条少一条都红
//   builtin    'file' ⇒ 那一行必须指名 `prompts/<name>.md`，而且那个文件真在
//              'code' ⇒ 那一行**不许**出现 .md（默认写在代码里，不是文件）
//   scope      'both' ⇒ 写「两端」· 'android' ⇒ 写「仅手机」
//   键         `prompt.<name>` 必须在 PREF_KEYS —— 不在的话他改了根本存不进去
//
// ★ 不判措辞、不判某一段说得对不对（同 ①～④ 的口径）。
// ★ 一律不用正则去切表格：按 `|` 分格、按字符判名字（D-460 · 反斜杠绕开写）。
const { OVERRIDABLE_PROMPTS } = await import(
  pathToFileURL(join(ROOT, 'src/core/prompt-overrides.ts')).href
)
const PROMPT_DOC_REL = 'docs/PROMPT_LAYERS.md'
const PROMPT_DOC_PATH = join(ROOT, PROMPT_DOC_REL)
let promptChecked = 0

if (!existsSync(PROMPT_DOC_PATH)) {
  fail.push(
    `提示词覆盖：找不到 ${PROMPT_DOC_REL} —— 那是这套体系的唯一说明（T-7.3）` +
      `${NL}    → 没有它，「他改过的提示词存哪、谁盖谁」就只剩源码里散着的注释`
  )
} else {
  const doc = readFileSync(PROMPT_DOC_PATH, 'utf8')
  /** 只认「第一格是一个纯粹的 `名字`」的行 —— 别的表格（§二.2 / §三 / §四）都不长这样 */
  const isName = (s) =>
    s.length > 2 &&
    s.startsWith(TICK) &&
    s.endsWith(TICK) &&
    [...s.slice(1, -1)].every((ch) => (ch >= 'a' && ch <= 'z') || ch === '-')

  const rows = new Map()
  for (const raw of doc.split(NL)) {
    const line = raw.split(CR).join('').trim()
    if (!line.startsWith('| ')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 7 || !isName(cells[1])) continue
    rows.set(cells[1].slice(1, -1), cells)
  }

  if (rows.size === 0) {
    fail.push(
      `提示词覆盖：${PROMPT_DOC_REL} §一 那张表一行都没认出来 —— 这条闸会「绿着什么都没验」`
    )
  }

  for (const p of OVERRIDABLE_PROMPTS) {
    promptChecked += 1
    const cells = rows.get(p.name)
    if (!cells) {
      fail.push(
        `提示词覆盖：\`${p.name}\` 在 OVERRIDABLE_PROMPTS 里，${PROMPT_DOC_REL} §一 的表里没有` +
          `${NL}    → 加一条能覆盖的提示词，要同轮把那张表补上`
      )
      continue
    }
    const wantKey = `prompt.${p.name}`
    if (!prefSet.has(wantKey)) {
      fail.push(
        `★★ 提示词覆盖：\`${wantKey}\` 不在 PREF_KEYS —— 他改了存不进去，而且不报错`
      )
    }
    const builtinCell = cells[5]
    const mdName = `prompts/${p.name}.md`
    if (p.builtin === 'file') {
      if (!builtinCell.includes(mdName)) {
        fail.push(
          `提示词覆盖：\`${p.name}\` 的 builtin 是 'file'，表里「出厂默认在哪」没指 \`${mdName}\`` +
            `${NL}    → 现在写的是：${builtinCell}`
        )
      }
      if (!existsSync(join(ROOT, mdName))) {
        fail.push(
          `★★ 提示词覆盖：\`${p.name}\` 说默认在 \`${mdName}\`，那个文件不在` +
            `${NL}    → loadPrompt 会一路落到 BUILTIN；BUILTIN 里也没有的话当场抛`
        )
      }
    } else if (builtinCell.includes('.md')) {
      fail.push(
        `提示词覆盖：\`${p.name}\` 的 builtin 是 'code'（默认写在代码里），表里却指了一个 .md` +
          `${NL}    → 现在写的是：${builtinCell}`
      )
    }
    const scopeCell = cells[6]
    const wantScope = p.scope === 'both' ? '两端' : '仅手机'
    if (!scopeCell.includes(wantScope)) {
      fail.push(
        `提示词覆盖：\`${p.name}\` 的 scope 是 '${p.scope}'，表里「谁读它」没写「${wantScope}」` +
          `${NL}    → 现在写的是：${scopeCell}`
      )
    }
  }

  const known = new Set(OVERRIDABLE_PROMPTS.map((p) => p.name))
  for (const name of rows.keys()) {
    if (known.has(name)) continue
    fail.push(
      `提示词覆盖：${PROMPT_DOC_REL} §一 的表里有 \`${name}\`，OVERRIDABLE_PROMPTS 里没有` +
        `${NL}    → 要么它已经撤了（表该删这一行），要么代码那半边漏了`
    )
  }
}

// ══ 报告 ═══════════════════════════════════════════════════
if (fail.length > 0) {
  console.error(`${NL}✗ check:contract · 契约与源码对不上（${fail.length} 处）：${NL}`)
  for (const f of fail) console.error('  • ' + f)
  console.error(
    `${NL}  ── 怎么办 ────────────────────────────────────────────────` +
      `${NL}  合同自己写着：与源码冲突时**以源码为准，并回来把这里改对**。` +
      `${NL}  所以上面每一条的修法都是「改合同」，不是「改代码去迁就合同」——` +
      `${NL}  除非你判断真正错的是代码，那要单开一轮。` +
      `${NL}  这条闸只判可判定的事实（表名 / 数目 / 路径 / 提交号），不判措辞。${NL}`
  )
  process.exit(1)
}

const parts = [
  `§1.2 ${SYNC_TABLES.length} 张表与 SYNC_TABLES 逐一对上`,
  `偏好白名单 ${PREF_KEYS.length} 项（${prefHits} 处说法一致）`,
  `引用路径 ${checked} 条都在`,
  '文件头对照提交号存在',
  `tts 键面 ${ttsChecked} 条分层对（USER / DEVICE）`,
  `提示词 ${promptChecked} 条覆盖名单与说明逐条对上`
]
if (androidSkipped > 0) parts.push(`Android 那 ${androidSkipped} 条跳过（本机没有那个仓）`)
if (unknown > 0) parts.push(`另有 ${unknown} 条前缀认不出，未判`)
console.log('✓ check:contract　' + parts.join(' · '))
