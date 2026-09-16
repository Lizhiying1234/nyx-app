/**
 * 悬空令牌闸 —— **一类 svelte-check 与 check:css 都抓不到的 bug**（2026-09-09）
 *
 * ── 它抓的是什么 ────────────────────────────────────────────
 * `fill: var(--violet-soft)` —— 这个令牌**从来没有被定义过**。
 * CSS 不会报错：无效的 `var()` 在**计算值阶段**被丢掉，属性退回它的初始值。
 * 于是空态那三粒星一直是**黑**的（fill 的初始值），而代码看起来在说「柔紫」。
 *
 * 同一类事故本轮撞了两次：
 *   `--zh`          三处 `font-family:var(--zh)`，一直什么都没做
 *   `--violet-soft` 一处 fill，把三粒星画成了黑的
 * 两次都不是「写错了值」，是**写了一个不存在的名字**，而没有任何东西会红。
 *
 * ── 判据两份 ────────────────────────────────────────────────
 * 令牌住在两份 CSS 里（core 的颜色真相 + 本端的别名与非颜色令牌），
 * 与 `tools/tokens-to-android.mjs` / `tests/kit.test.ts` 同一条判据。
 *
 * ── 运行时才有值的那几个要放行 ──────────────────────────────
 * 有几个令牌是 JS 在渲染时用内联 style 写上去的（图表柱高 · 词典 iframe 高度）。
 * 它们**按定义**不在 CSS 里，白名单放行，并且要求写清楚是谁写的。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEF_FILES = ['src/ui/styles/tokens.css', 'nyx-core/src/core/design/color-tokens.css']
const USE_FILES = ['src/ui/styles/tokens.css', 'src/ui/styles/mobile.css']

/** 运行时由 JS 写进内联 style 的 —— 名字后面写清楚谁写的 */
const RUNTIME_OK = new Map([
  ['--h', 'Lookup 统计图每根柱子的高度（Lookup.svelte 内联 style）'],
  ['--entry-h', '词典 iframe 的实际高度（Lookup.svelte 内联；用处带 62vh 兜底）']
])

/** CSS 注释里提令牌名是正常的（本文件与 mobile.css 里到处都是），扫之前剥掉 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

describe('TOK · 令牌不许悬空', () => {
  it('TOK-1 · 每个 var(--x) 都真的有人定义（或在运行时白名单里）', () => {
    const defined = new Set<string>()
    for (const f of DEF_FILES)
      for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g))
        defined.add(m[1]!)

    const dangling: string[] = []
    for (const f of USE_FILES) {
      const css = stripComments(readFileSync(join(ROOT, f), 'utf8'))
      css.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
          const t = m[1]!
          if (defined.has(t) || RUNTIME_OK.has(t)) continue
          dangling.push(`${f}:${i + 1} ${t}`)
        }
      })
    }
    assert.deepEqual(
      dangling,
      [],
      `这些令牌没人定义 —— CSS 不会报错，它只会静静退回属性的初始值：\n    ${dangling.join('\n    ')}`
    )
  })

  it('TOK-2 · 白名单里的每一个都还真的被 JS 写着（写没了就该从白名单删）', () => {
    const svelte = readFileSync(join(ROOT, 'src/ui/views/Lookup.svelte'), 'utf8')
    for (const t of RUNTIME_OK.keys())
      assert.ok(svelte.includes(t), `白名单说 ${t} 由 JS 在运行时写，但 Lookup.svelte 里已经找不到它`)
  })
})
