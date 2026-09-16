/**
 * check:decisions · 宪法版本块的漂移闸（T-1.5 · 2026-09-04 · 审计 R-019）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * `docs/decisions-e.md` 的文件头有一个**手写的**版本块：
 *
 *     **版本**：第四十九轮 ｜ **收录**：D-289 ～ D-465 ｜ **最后更新**：…
 *
 * 「收录」的上限每加一条决议就该跟着往上走，靠人记得。**它曾长期停在 D-332 没人刷** ——
 * 文件自己在正文里就记着这件事（「正是 D-370 要治的那类摘要漂移」）。
 *
 * 漂了的后果不是不好看：下一个会话读文件头，会以为宪法只到 D-332，
 * **于是把 D-333 之后的每一条都当成不存在** —— 判据层级最上面那一档直接失真。
 * 这就是给下一个会话喂旧真相。
 *
 * ── 判据（两条都是文件自己写在头上的，不是我发明的）────────
 *
 *   ① 版本块「**收录**：D-a ～ D-b」的**上限 b** = 文内最大的 `^## D-` 编号
 *      —— 文件第 9 行原话：「本块的『收录』上限 = 文内最大的 `## D-` 编号」
 *   ② 正文「**本文件当前收录 D-a ～ D-b**」那一行与版本块**逐字一致**（上下限都比）
 *      —— 那一行自己写着「此行随版本块同步更新」，于是它也会漂，得一起守
 *
 * ── 有意不做的 ────────────────────────────────────────────
 *
 * ★ 不看条目内容、不判断某条决议对不对 —— 那是人读的时候的事。
 * ★ **不报编号缺口**：D-290 ～ D-292 只在注释里出现过，是已知且有意的空档。
 * ★ **不把同号标题判成「编号复用」**：`## D-451 · 附记：…` 是同一条决议的附记，
 *   是对的写法。所以取最大值时按**不同编号**算，附记不影响判断。
 * ★ 这条闸**一个字都不改** `decisions-e.md` —— 它只负责说「漂了」，怎么改是使用者的事（C-001）。
 *
 * 用法：node scripts/check-decisions.mjs
 */
import { readFileSync } from 'node:fs'

const FILE = 'docs/decisions-e.md'
const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)

/** 版本块那一行的定位锚 */
const ANCHOR_BLOCK = '**收录**'
/** 正文那一行的定位锚 */
const ANCHOR_BODY = '本文件当前收录'

let src
try {
  src = readFileSync(FILE, 'utf8')
} catch {
  console.error(`✗ check:decisions　读不到 ${FILE}`)
  process.exit(1)
}
const lines = src.split(CR).join('').split(NL)

/**
 * 一行里出现的全部 `D-<数字>`，按出现顺序。
 * ★ 不用正则：全角标点（`～` `｜`）与 `` `## D-[0-9]*` `` 那种代码里的示例混在一起，
 *   扫字符比写一条要绕开反斜杠的正则更好读，也更不容易误伤（D-460）。
 */
function dNums(text) {
  const out = []
  for (let i = 0; i + 1 < text.length; i++) {
    if (text[i] !== 'D' || text[i + 1] !== '-') continue
    let j = i + 2
    let d = ''
    while (j < text.length && text[j] >= '0' && text[j] <= '9') d += text[j++]
    if (d) out.push(Number(d))
  }
  return out
}

/** 锚点之后的那一段里，头两个 `D-<数字>` = 这一行声称的下限与上限 */
function boundsAfter(line, anchor) {
  const ns = dNums(line.slice(line.indexOf(anchor) + anchor.length))
  return ns.length >= 2 ? { lo: ns[0], hi: ns[1] } : null
}

const fail = []

// ── 文内实际有哪些编号 ────────────────────────────────────
/**
 * ★ 只取标题行上的**第一个** `D-<数字>` —— 标题里经常还点着别的编号
 *   （`## D-294 · D-001 / D-208 的措辞更新` · `## D-337 · **D-243 修订**` …）。
 *   全收的话，被引用的编号会混进「本文件收录了哪些」，最大值也可能被引用抬高。
 */
const seen = new Set()
for (const line of lines) {
  if (!line.startsWith('## D-')) continue
  const ns = dNums(line)
  if (ns.length > 0) seen.add(ns[0])
}
if (seen.size === 0) {
  console.error(`✗ check:decisions　${FILE} 里一个 \`## D-\` 标题都没有 —— 文件被截断了？`)
  process.exit(1)
}
const nums = [...seen].sort((a, b) => a - b)
const maxNum = nums[nums.length - 1]
const minNum = nums[0]

// ── 版本块那一行 ──────────────────────────────────────────
const blockLine = lines.find((l) => l.includes(ANCHOR_BLOCK))
const block = blockLine ? boundsAfter(blockLine, ANCHOR_BLOCK) : null
if (!blockLine) {
  fail.push(`版本块里找不到「${ANCHOR_BLOCK}」那一行 —— 文件头的版本块被改坏了`)
} else if (!block) {
  fail.push(`「${ANCHOR_BLOCK}」那一行读不出「D-a ～ D-b」两个编号：${blockLine.trim()}`)
} else if (block.hi !== maxNum) {
  fail.push(
    `版本块「收录」上限是 D-${block.hi}，文内最大的 \`## D-\` 是 D-${maxNum}` +
      `${NL}    → 把文件头那一行的上限改成 D-${maxNum}（D-370：新增一轮必须同轮刷版本块）`
  )
}

// ── 正文「本文件当前收录」那一行 ──────────────────────────
const bodyLine = lines.find((l) => l.includes(ANCHOR_BODY))
const body = bodyLine ? boundsAfter(bodyLine, ANCHOR_BODY) : null
if (!bodyLine) {
  fail.push(`找不到「${ANCHOR_BODY} D-a ～ D-b」那一行 —— 它是版本块的副本，漂了没人发现`)
} else if (!body) {
  fail.push(`「${ANCHOR_BODY}」那一行读不出两个编号：${bodyLine.trim()}`)
} else if (block && (body.lo !== block.lo || body.hi !== block.hi)) {
  fail.push(
    `「${ANCHOR_BODY} D-${body.lo} ～ D-${body.hi}」与版本块「D-${block.lo} ～ D-${block.hi}」对不上` +
      `${NL}    → 那一行自己写着「此行随版本块同步更新」，两处要一模一样`
  )
}

if (fail.length > 0) {
  console.error(`${NL}✗ check:decisions · 宪法版本块漂了（${fail.length} 处）：${NL}`)
  for (const f of fail) console.error('  • ' + f)
  console.error(
    `${NL}  ── 怎么办 ────────────────────────────────────────────────` +
      `${NL}  版本块是下一个会话读到的第一句真话：它说「收录到 D-NNN」，` +
      `${NL}  下一个会话就会把 D-NNN 之后的决议当成不存在。` +
      `${NL}  · 刚加完一轮决议：把 ${FILE} 文件头的「收录」上限和` +
      `${NL}    「${ANCHOR_BODY}」那一行一起改到最新（D-370）。` +
      `${NL}  · 这条闸只报告不改文件 —— 宪法正文与版本块只由使用者点头后改（C-001）。${NL}`
  )
  process.exit(1)
}

console.log(
  `✓ check:decisions　版本块 D-${block.lo} ～ D-${block.hi} = 文内最大 \`## D-${maxNum}\`` +
    `（${nums.length} 个编号 · 最小 D-${minNum}）`
)
