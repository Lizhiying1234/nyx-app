/**
 * 区块名单 ↔ 详情页，两个方向都要对得上 · I-112 / D-468
 *
 * ── 它挡的是哪一种事故 ────────────────────────────────────
 *
 * `core/analysis/blocks.ts::RENDERED_BLOCKS` 是「详情页真的会显示出来的区块名」
 * 这句话的**唯一判据**：`planWrites` 拿它数「这一次解析写出了几块他看得见的东西」，
 * `check:prompts` 拿它判提示词里的键认不认得。而这份名单和详情页之间
 * **从来没有一道闸**，全靠 `blocks.ts` 头上一句「必须和 ItemDetail.svelte 对得上」的注释。
 *
 * 两个方向坏掉的样子都是静默的：
 *
 *   · 名单里有、页面不画 → AI 老老实实返回它、软件老老实实写库，
 *     `shown` 也照加，而**屏幕上一个字没变**。这正是 I-112 那句「点了没反应」。
 *   · 页面画、名单里没有 → 提示词里写上它会被 `check:prompts` 拦下来，
 *     于是这一块永远拿不到内容，页面上永远是空的。
 *
 * ── 判据 ────────────────────────────────────────────────
 *
 * 页面这一侧的名字从 `ItemDetail.svelte` 的源码里取，两种取法都算数：
 *   ① 区块表里的字面量 `['key', '标题']`
 *   ② 直接点名取块 `blockOf(d, 'key')`
 * 然后与 `RENDERED_BLOCKS` 双向比对。
 *
 * ★ 例外只有两个，都在下面写明理由 —— 例外必须点名，不许按前缀放行。
 *
 * 用法：node scripts/check-blocks.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIST = join('src', 'core', 'analysis', 'blocks.ts')
const PAGE = join('src', 'renderer', 'src', 'ItemDetail.svelte')

/**
 * 名单里有、但**不是靠区块画出来**的那几个。
 * 一个都不许多 —— 多一个，这道闸就少守一块。
 */
const NOT_DRAWN_AS_BLOCK = new Map([
  ['gloss', '释义回写在 items.gloss 上（R-002），页面画的是 d.item.gloss，不是解析块'],
  ['glossZh', '同上，画的是 d.item.glossZh']
])

const listSrc = readFileSync(LIST, 'utf8')
const listed = new Set(
  (listSrc.match(/export const RENDERED_BLOCKS = \[([\s\S]*?)\] as const/)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
)
if (listed.size === 0) {
  console.error('check:blocks　读不到 RENDERED_BLOCKS —— 名单没了，这道闸就是摆设')
  process.exit(1)
}

const pageSrc = readFileSync(PAGE, 'utf8')
const drawn = new Set()
for (const m of pageSrc.matchAll(/\[\s*'([a-zA-Z][a-zA-Z0-9_]*)'\s*,\s*'[^']*'\s*\]/g)) drawn.add(m[1])
for (const m of pageSrc.matchAll(/blockOf\(\s*d\s*,\s*'([a-zA-Z][a-zA-Z0-9_]*)'\s*\)/g)) drawn.add(m[1])
if (drawn.size === 0) {
  console.error('check:blocks　在详情页里一个区块名都没认出来 —— 取法漂了，先修这个脚本')
  process.exit(1)
}

const problems = []
for (const b of listed) {
  if (drawn.has(b) || NOT_DRAWN_AS_BLOCK.has(b)) continue
  problems.push(
    `名单里有「${b}」，详情页却不画它 —— AI 会返回、软件会写库、shown 会加一，` +
      `而屏幕上一个字都不会变（I-112）。\n` +
      `      要么在 ItemDetail.svelte 里画出来，要么从 RENDERED_BLOCKS 里删掉。`
  )
}
for (const b of drawn) {
  if (listed.has(b)) continue
  problems.push(
    `详情页画了「${b}」，名单里却没有 —— 提示词一写这个键 check:prompts 就会拦，` +
      `于是这一块永远拿不到内容，页面上永远空着。`
  )
}

if (problems.length > 0) {
  console.error('\ncheck:blocks　不通过：\n')
  for (const p of problems) console.error('　　✖ ' + p)
  console.error('')
  process.exit(1)
}
console.log(
  `check:blocks　名单 ${listed.size} 块 · 详情页画出 ${drawn.size} 块 · 两个方向都对得上` +
    `（${[...NOT_DRAWN_AS_BLOCK.keys()].join(' / ')} 不是区块，已点名除外）`
)
console.log('\n✔ 通过')
