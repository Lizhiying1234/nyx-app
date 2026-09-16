/**
 * 样式一览的**自洽闸**（F-005 · 2026-09-01）
 *
 * 这一页存在的唯一理由是「让人相信眼前这份就是现行设计」。
 * 所以它一旦漂了，比没有这一页更糟 —— 会**理直气壮地展示错的东西**。
 * 旧版就是这么烂掉的：整页写着 v3 的 `--accent` / `--fs-1..8`，
 * 而那些令牌在 v5 里一个都不存在，页面渲染出来是一片空白。
 *
 * 值那一半已经不会漂了（页面现场 `getComputedStyle` 读）。
 * 剩下会漂的两样在这里钉住：
 *   ① 引用的令牌名真的在 tokens.css 里
 *   ② 图标清单与 Sprite.svelte 逐枚对得上（少一枚 = 有符号没人看过）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const KIT = readFileSync(new URL('../src/ui/views/Kit.svelte', import.meta.url), 'utf8')
/**
 * ★★ 令牌住在**两份** CSS 里（2026-09-07 起）：
 *   `nyx-core/src/core/design/color-tokens.css`  两端共享的颜色真相（--color-* / --btn-* / --progress-*）
 *   `src/ui/styles/tokens.css`                   本端的别名与非颜色令牌（字号 / 圆角 / 间距 / 动效）
 * 后者 `@import` 前者。这道闸原来只读后一份，于是 2026-09-08 样式一览页
 * 补进进度五档时，它把 `--progress-*` 报成「不存在的令牌」——
 * **闸说的不是真话，是它只看了一半。**
 * `tools/tokens-to-android.mjs` 早就是按两份读的，这里跟上同一条判据。
 */
const TOKENS = [
  '../nyx-core/src/core/design/color-tokens.css',
  '../src/ui/styles/tokens.css'
]
  .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
  .join('\n')
/** ★ 图标几何 2026-09-01 上提 core（D-410 两端一起重画）—— 对的是那一份，不是 Sprite.svelte */
const SPRITE = readFileSync(
  new URL('../nyx-core/src/core/icons.ts', import.meta.url),
  'utf8'
)

/**
 * Kit 里引用到的令牌名。
 * ★ 结尾是 `-` 的不算 —— 那是 `t.replace('--fs-', '')` 这类前缀字符串，
 *   不是令牌引用（第一版就把它当成令牌报了假警）。
 */
function tokensIn(src: string): string[] {
  return [...src.matchAll(/'(--[a-z0-9-]*[a-z0-9])'/g)].map((m) => m[1]!)
}

describe('KIT · 样式一览不许漂', () => {
  it('KIT-1 · 它引用的每个令牌都真的定义在 tokens.css 里', () => {
    const defined = new Set([...TOKENS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!))
    const missing = [...new Set(tokensIn(KIT))].filter((t) => !defined.has(t))
    assert.deepEqual(missing, [], `Kit 引用了不存在的令牌：${missing.join(' · ')}`)
  })

  it('KIT-2 · 图标清单 = core/icons.ts 里的全部符号，一枚不多一枚不少', () => {
    const inSprite = new Set([...SPRITE.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]!))
    const inKit = new Set([...KIT.matchAll(/'(nyx-[a-z0-9-]+)'/g)].map((m) => m[1]!))
    const missed = [...inSprite].filter((s) => !inKit.has(s))
    const ghost = [...inKit].filter((s) => !inSprite.has(s))
    assert.deepEqual(missed, [], `core 里有、样式一览没列：${missed.join(' · ')}（没人看过它长什么样）`)
    assert.deepEqual(ghost, [], `样式一览列了、core 里没有：${ghost.join(' · ')}（会渲染成空白）`)
  })

  it('KIT-5 · ★ NYX_ICON_IDS 与 <defs> 里的符号一一对应', () => {
    const inDefs = [...SPRITE.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]!)
    const listed = [...SPRITE.matchAll(/^  '(nyx-[a-z0-9-]+)'/gm)].map((m) => m[1]!)
    assert.deepEqual(
      listed,
      inDefs,
      'NYX_ICON_IDS 是给两端当清单用的 —— 它跟 <defs> 对不上就没有意义了'
    )
  })

  it('KIT-6 · ★ Sprite.svelte 里一条几何都不许有（两端各画一份就是漂的开始）', () => {
    const android = readFileSync(new URL('../src/ui/lib/Sprite.svelte', import.meta.url), 'utf8')
    assert.ok(!/<symbols/.test(android), 'Android 的 Sprite 只许铺 core 那一份，不许自己画')
  })

  it('KIT-3 · ★ 值不许写死 —— 必须现场读，否则它就是第二份判据', () => {
    assert.match(KIT, /getComputedStyle/, '颜色值要 getComputedStyle 现场读')
    const hardCoded = [...KIT.matchAll(/'#[0-9A-Fa-f]{3,8}'/g)].map((m) => m[0])
    assert.deepEqual(hardCoded, [], `Kit 里写死了颜色：${hardCoded.join(' · ')}`)
  })

  it('KIT-4 · ★ 不许再有往库里写假数据的按钮（D-249 / D-346）', () => {
    assert.ok(!/seedDev|clearDev|dev-seed/.test(KIT), '真机上装着真实数据，播种按钮离 Settings 只有两下')
  })
})
