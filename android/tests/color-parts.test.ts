/**
 * 配色可调清单必须等于「手机真的调得动的那些」（2026-09-14 重写判据）
 *
 * ── 原来这道闸比的是什么、为什么不够 ────────────────────────
 * 原来它比的是 **core 里所有的纯色语义令牌**。它确实拦住了「core 改了名 / 加了一个
 * 而清单没跟上」，但它拦不住**这一整类**：core 的语义层是两端共享的，里面一多半是
 * Windows 的词汇（声部色 · 图标色 · accent / warning 那两族 · primary 的 hover/pressed…），
 * 手机的样式一次都没引用过 —— 于是清单里有 **37 个格子调了屏上什么都不会变**，
 * 而这道闸一直是绿的，因为它们**确实在 core 里**。
 *
 * ── 现在比的是「可达性」────────────────────────────────────
 * 从手机自己的文件（`src` 下的 svelte / ts / css + `index.html`）里所有的 `var(--X)`
 * 出发，顺着令牌定义（core 那份 + 本端别名层 `src/ui/styles/tokens.css`）求**传递闭包**。
 * ★ 必须是传递的：`mobile.css` 里没有 `var(--color-primary)`，它用的是 `--violet`
 *   （别名层）和 `--btn-*`（core 组件层）。只扫一层会把主色误判成「没人用」，
 *   然后这道闸会反过来要求把主色那一格删掉 —— 闸算错的方向比不算更贵。
 * 清单必须正好等于「可达 ∩ core 里的纯色语义令牌」：
 *   · 少一个 → 他调不到那个颜色，屏上看不出少了什么；
 *   · 多一个 → 一个调了没反应的格子。**两种都不会自己红。**
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLOR_GROUPS, COLOR_TOKENS } from '../src/ui/lib/color-parts.ts'
import { cleanModeName, cleanOverrides } from '../src/db/colors.ts'
import { normalizeHex } from '../src/ui/lib/theme.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_CSS = 'nyx-core/src/core/design/color-tokens.css'
const ALIAS_LAYER = 'src/ui/styles/tokens.css'
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /^\s*\/\/.*$/gm
const CSS = readFileSync(join(ROOT, CORE_CSS), 'utf8')

const LINES = (s: string): string[] => s.split(/\r?\n/)
const DEF_RE = /^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/
const USE_RE = /var\(\s*--([a-z0-9-]+)\s*[),]/g

/** core 里**能用拾色器调**的那些语义令牌（值是 `var(--原语)` 的才算） */
function editableInCore(): string[] {
  const out: string[] = []
  for (const line of LINES(CSS)) {
    const m = DEF_RE.exec(line)
    if (!m || !m[1]!.startsWith('color-')) continue
    if (!m[2]!.trim().startsWith('var(--')) continue
    out.push(m[1]!)
  }
  return out
}

/** 令牌定义表：core 那份 + 本端别名层 */
function tokenDefs(): Map<string, string> {
  const defs = new Map<string, string>()
  for (const f of [CORE_CSS, ALIAS_LAYER]) {
    for (const line of LINES(readFileSync(join(ROOT, f), 'utf8'))) {
      const m = DEF_RE.exec(line)
      if (m) defs.set(m[1]!, m[2]!)
    }
  }
  return defs
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(svelte|ts|css|html)$/.test(n)) out.push(p)
  }
  return out
}

/** 传递闭包：活令牌的定义里引用的，也是活的（单独拎出来，好拿合成数据真考它） */
function closeOver(seed: Iterable<string>, defs: Map<string, string>): Set<string> {
  const live = new Set(seed)
  let grew = true
  while (grew) {
    grew = false
    for (const t of [...live]) {
      const d = defs.get(t)
      if (!d) continue
      for (const m of d.matchAll(USE_RE)) {
        if (!live.has(m[1]!)) {
          live.add(m[1]!)
          grew = true
        }
      }
    }
  }
  return live
}

/**
 * 剥掉注释再扫。
 *
 * ★★ 这一课栽过两次：`splash-label-keys` 那道闸扫到了注释里提的函数名；
 *   今天这道闸扫到了我写在 `color-parts.ts` 文件头里的 `var(--color-assist-glow)` ——
 *   那句话正是在解释「它为什么**不**算可达」，结果它自己把它变成了可达。
 *   **记账本来就该待在注释里，所以扫之前必须先把注释拿掉。**
 */
function stripComments(s: string): string {
  return s.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '')
}

/**
 * 手机上真的够得着的令牌。
 *
 * ★★★ 根 = **真正的使用**，不含别名定义层。2026-09-14 第二刀的根因就在这儿：
 *   我原来把 `src/ui/styles/tokens.css` 里的 `var(--color-*)` 也算进了根 ——
 *   **那是定义，不是使用**（`--deep: var(--color-deep)` 只是给 `--deep` 起个名字，
 *   没有任何元素因此变色）。算进去的结果：深面那一整组明明零使用，却被判成活的，
 *   在屏上摆了三个调了没反应的格子。
 * ☞ 所以别名层只进 `defs`（供回推），不进 `seed`。
 */
function reachable(): Set<string> {
  const seed = new Set<string>()
  for (const f of [...walk(join(ROOT, 'src')), join(ROOT, 'index.html')]) {
    if (f === join(ROOT, ALIAS_LAYER)) continue
    for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(USE_RE)) seed.add(m[1]!)
  }
  return closeOver(seed, tokenDefs())
}

describe('COLORS · 可调清单 = 手机真的调得动的那些', () => {
  it('① 一个不多、一个不少（按可达性算，不是按 core 有没有）', () => {
    const live = reachable()
    const should = new Set(editableInCore().filter((t) => live.has(t)))
    const mine = new Set(COLOR_TOKENS)
    const missing = [...should].filter((t) => !mine.has(t))
    const extra = [...mine].filter((t) => !should.has(t))
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      '配色清单和「手机真的调得动的」对不上了：' +
        `\n  少了（他调不到）：${missing.join(', ') || '无'}` +
        `\n  多了（调了没反应的格子）：${extra.join(', ') || '无'}` +
        '\n  ☞ 去 src/ui/lib/color-parts.ts 补 / 删，中文名要手写。'
    )
  })

  it('★ ①b 盯住算法本身：闭包要能走完两跳（拿合成数据考，不靠真实数据碰巧走到）', () => {
    // ★★ 我原来这条写的是「主色必须经组件层才算可达」—— **那是我编的**。
    //    实测：只扫一层和求闭包一样多，闭包今天一个都没多出来。
    // ★ 那为什么还留着闭包：`mobile.css` 确实在用 core 的组件层（`--btn-outline-bg` 这些），
    //    哪天用到一个没经别名层的，只扫一层就会把它背后的语义令牌判成「没人用」，
    //    于是①会「正确地」要求删掉一个真在用的格子 —— 闸算错的方向比不算更贵。
    // ☞ 真实数据考不到的东西就别假装它考到了，拿合成的两跳链考：
    const defs = new Map([
      ['btn-fake-bg', 'var(--color-made-up)'],
      ['color-made-up', 'var(--aqua-500)']
    ])
    const out = closeOver(['btn-fake-bg'], defs)
    assert.ok(out.has('color-made-up'), '★ 第一跳没走到 —— 闭包退化成只扫一层了')
    assert.ok(out.has('aqua-500'), '★ 第二跳没走到 —— 闭包没走到不动为止')
  })

  it('★★ ①c 别名定义层不算「使用」（2026-09-14 第二刀的根因）', () => {
    // ★ 屏上出过的事：`--deep: var(--color-deep)` 这一行让 `color-deep` 看着像有人用，
    //   可 `--deep` 自己在 `mobile.css` 和所有 svelte 里**一次都没被引用**。
    //   于是「深面」那一整组摆在屏上，调了什么都不会发生。
    const live = reachable()
    for (const t of ['color-deep', 'color-on-deep', 'color-on-deep-accent']) {
      assert.ok(!live.has(t), `★ ${t} 只在别名层被定义过，没有任何元素用它 —— 不算可达`)
    }
    // ★ `color-assist-glow` 同理但死因不同：只有原生层读它（R.color.nyx_assist_glow），
    //   而原生色编译进 APK，运行期改 CSS 变量够不到。
    assert.ok(!live.has('color-assist-glow'), '★ 星光只有原生层读，运行期调不动')
  })


  it('★★ ①e 深面不许再长回一层本端别名（G-2 · 2026-09-14）', () => {
    /**
     * ★ 总控 2026-09-14 裁：判据不退（DS-Q20「深面只留三处」是使用者定的），
     *   退的是**本端那层别名** —— `--deep` / `--on-deep` / `--on-deep-2` /
     *   `--on-deep-3` / `--violet-lift` 在 `mobile.css` 和所有 svelte 里各被引用 0 次，
     *   而它们让 `color-deep` 那一组**看着像有人用**，在配色页上摆了三个调了没反应的格子。
     * ★ 深面**只从 core 取**（`--color-deep*`）。A7 做星 ON 那一面时直接引 core 的名字。
     * ☞ 这条只看**定义**：别名一旦回到 `tokens.css`，上面①c 那条也会跟着松。
     */
    const alias = readFileSync(join(ROOT, ALIAS_LAYER), 'utf8')
    const defined = new Set(
      [...alias.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1] as string)
    )
    const back = ['--deep', '--on-deep', '--on-deep-2', '--on-deep-3', '--violet-lift'].filter((t) =>
      defined.has(t)
    )
    assert.deepEqual(
      back,
      [],
      `★★ 深面的本端别名又回来了：${back.join(' · ')} —— 深面只许从 core 的 --color-deep* 取`
    )
  })

  it('★ ①d 真实数据上的两头：真在用的算可达，Windows 的词汇算不可达', () => {
    const live = reachable()
    assert.ok(live.has('color-primary'), '★ 主色在用（别名 --violet，16 处样式规则）')
    assert.ok(live.has('color-surface'), '★ 卡面在用（别名 --paper）')
    assert.ok(!live.has('color-atlas'), '★ 声部色是 Windows 的词汇，手机一次都没引过')
  })

  it('② 不重复，而且每个都有中文名', () => {
    assert.equal(new Set(COLOR_TOKENS).size, COLOR_TOKENS.length, '★ 清单里有重复')
    for (const g of COLOR_GROUPS) {
      assert.ok(g.zh.length > 0, '★ 组没有中文名')
      assert.ok(g.parts.length > 0, '★ 空的组不该出现在屏上（D-431：数是 0 的入口不出现）')
      for (const [t, zh] of g.parts) {
        assert.ok(zh.length > 0, `★ ${t} 没有中文名`)
        assert.notEqual(zh, t, `★ ${t} 的「中文名」就是令牌名本身 —— 那等于没起`)
      }
    }
  })

  it('★ ③ 不许把调不动的摆上来（scrim / 阴影 / 带透明度的）', () => {
    for (const t of COLOR_TOKENS) {
      assert.ok(
        !/scrim|shadow|on-deep-[23]/.test(t),
        `★ ${t} 不是纯色（rgba / box-shadow），拾色器调不动它 —— 摆一个调不动的格子比不摆更糟`
      )
    }
  })
})

describe('COLORS · 存进去之前先洗（脏数据一律丢掉，不抛）', () => {
  it('覆盖表：令牌要在清单里、值要是 6 位 HEX', () => {
    const t = COLOR_TOKENS[0]!
    assert.deepEqual(cleanOverrides({ [t]: '#AABBCC' }), { [t]: '#aabbcc' })
    assert.deepEqual(cleanOverrides({ 'color-nope': '#aabbcc' }), {}, '★ 不认的令牌要丢')
    assert.deepEqual(cleanOverrides({ [t]: 'red' }), {}, '★ 颜色关键字不收（拾色器不产出它）')
    assert.deepEqual(cleanOverrides({ [t]: '#abc' }), {}, '★ 三位简写不收 —— 存进去的一律是 6 位')
    assert.deepEqual(cleanOverrides(null), {})
    assert.deepEqual(cleanOverrides([1, 2]), {})
  })

  it('模式名：洗空白、截 16 字、空的给 null', () => {
    assert.equal(cleanModeName('  夜  里  '), '夜 里')
    assert.equal(cleanModeName(''), null)
    assert.equal(cleanModeName('一'.repeat(30))!.length, 16)
    assert.equal(cleanModeName(123), null)
  })

  it('HEX 归一：三位 / 大写 / rgb() 都收得住', () => {
    assert.equal(normalizeHex('#ABC'), '#aabbcc')
    assert.equal(normalizeHex('#FCFCFD'), '#fcfcfd')
    assert.equal(normalizeHex('rgb(5, 47, 83)'), '#052f53')
    assert.equal(normalizeHex('汤'), null)
  })
})
