/**
 * 提示词的两条硬规矩 · I-108 / I-112
 *
 * ── 一、输出示例里不许有真内容 ──────────────────────────────
 * 使用者在一条完全无关的词条详情页里，看到了 `hold sway over` 的释义、
 * 搭配、例句 —— 因为提示词的输出示例是**一整份填满的真实例子**，
 * 模型不严格听话时就照抄了。这类污染最难发现：JSON 合法、字段齐全、
 * 内容也读着像模像样，只有人眼看得出它讲的不是这个词。
 *
 * 所以示例里的每个值都必须写成 `⟪…⟫`。这个记号不可能出现在任何真实的
 * 英文或中文里，`extractJson` 见到它就当场拒收 —— 占位符本身是绊线。
 * 这个脚本守的是绊线**没有被后来的编辑悄悄拆掉**。
 *
 * 只检查 ```json 代码块里的**字符串值**。散文里提到 hold sway 是在讲判据
 * （「不要只给 hold sway 这种字典释义」），那是有用的，不管。
 *
 * ── 二、区块名要和详情页对得上 ──────────────────────────────
 * 详情页只渲染 RENDERED_BLOCKS 里那些名字。提示词里要是出现了一个
 * 详情页不认得的顶层字段，AI 会老老实实按它返回，软件会老老实实写进库，
 * 然后**屏幕上一个字都不会变** —— 使用者看到的就是「点了没反应」（I-112）。
 *
 * 用法：node scripts/check-prompts.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'prompts'
/**
 * ★ 名单 2026-09-05 从 `src/shared/api.ts` 搬到了 `src/core/analysis/blocks.ts`（T-7.8，
 *   Android 也要用同一份）。`api.ts` 那边只剩一层 re-export —— 从那里再也读不出条目，
 *   这个脚本会**当场喊出来**（下面那个 size === 0 的分支），不会安静地放行。
 */
const src = readFileSync(join('src', 'core', 'analysis', 'blocks.ts'), 'utf8')
const known = new Set(
  (src.match(/export const RENDERED_BLOCKS = \[([\s\S]*?)\] as const/)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
)
if (known.size === 0) {
  console.error('check:prompts　读不到 RENDERED_BLOCKS —— 名单没了，这个检查就是摆设')
  process.exit(1)
}

/**
 * 只有 analyse-item.md 的顶层字段会变成解析区块。
 * 别的提示词（判分、出题、导师）返回的是别的东西，不参与这条。
 */
const BLOCK_SOURCE = 'analyse-item.md'
/** 这些字段不进 analysis_blocks，但确实会出现在 analyse-item 的返回里 */
const NOT_A_BLOCK = new Set(['term', 'layer', 'kind', 'note'])

/**
 * 允许照抄的**固定词表**。
 * 这些不是内容，是字段的取值集合 —— 模型就该原样返回它们。
 * 名单是白名单而不是「按键名放行」：`register` 在 rewrites 里是词表，
 * 在顶层却是要写真内容的区块，同一个键名两种角色，只能按值来判。
 */
const VOCAB = new Set([
  'more formal',
  'more casual',
  'more neutral',
  'more academic',
  'fill-in-the-blank',
  'pattern transformation',
  'sentence writing',
  'error correction',
  'corpus',
  'dict',
  'ai',
  'spoken',
  'written',
  'academic',
  'active',
  'passive',
  'chunk',
  'sentence',
  'collocation',
  'grammar',
  'register',
  'word choice',
  // 题型（D-116 · 五种，固定词表）
  '造句',
  '句子改写',
  '错误订正',
  '限定写作',
  '情景任务',
  // 出题时的固定取值
  'original',
  'near',
  'far',
  'unseen',
  '1 sentence',
  '2 sentences',
  '3-4 sentences',
  'solid',
  'tentative'
])

const problems = []
const warnings = []

for (const f of readdirSync(DIR).filter((x) => x.endsWith('.md'))) {
  const text = readFileSync(join(DIR, f), 'utf8')
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1])

  for (const b of blocks) {
    // 字符串值：": \"…\"" 后面那一坨。键名不管。
    for (const m of b.matchAll(/:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const v = m[1]
      if (!v.trim()) continue
      if (v.includes('⟪') || v.includes('{{')) continue // 占位或变量，正是要的
      if (v === '…' || v === '...') continue
      if (VOCAB.has(v)) continue
      if (v.length <= 3) continue // "n." 之类的短标记
      problems.push(`${f}　输出示例里有真内容，模型会照抄：\n      "${v.slice(0, 90)}"`)
    }
    // 数组里的裸字符串
    for (const m of b.matchAll(/^\s*"((?:[^"\\]|\\.){4,})"\s*,?\s*$/gm)) {
      const v = m[1]
      if (v.includes('⟪') || v.includes('{{') || v === '…' || VOCAB.has(v)) continue
      problems.push(`${f}　输出示例的数组里有真内容：\n      "${v.slice(0, 90)}"`)
    }
  }

  if (f === BLOCK_SOURCE) {
    for (const b of blocks) {
      for (const m of b.matchAll(/^\s{2}"([a-zA-Z][a-zA-Z0-9_]*)"\s*:/gm)) {
        const key = m[1]
        if (known.has(key) || NOT_A_BLOCK.has(key)) continue
        problems.push(
          `${f}　顶层字段「${key}」详情页不认识 —— ` +
            `AI 会返回它、软件会写库，但屏幕上什么都不会变（I-112）。\n` +
            `      要么加进 src/shared/api.ts 的 RENDERED_BLOCKS 并在 ItemDetail.svelte 里渲染，要么从提示词里删掉。`
        )
      }
    }
  }

  // 散文里提到测试词条是允许的（在讲判据），但数量多了说明又开始拿它当例子写了
  const proseHits = (text.match(/hold sway/gi) ?? []).length
  if (proseHits > 3) warnings.push(`${f}　出现了 ${proseHits} 次 hold sway —— 确认都是在讲判据，不是又当例子了`)
}

for (const w of warnings) console.log('　　提醒　' + w)
if (problems.length > 0) {
  console.error('\ncheck:prompts　不通过：\n')
  for (const p of problems) console.error('　　✖ ' + p)
  console.error('')
  process.exit(1)
}
console.log(`check:prompts　${readdirSync(DIR).filter((x) => x.endsWith('.md')).length} 份提示词 · 示例污染 0 · 未知区块 0`)
console.log('\n✔ 通过')
