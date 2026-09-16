/**
 * IA · 设置 › Prompt 的信息架构（D-488 · 使用者 2026-09-15 七条）
 *
 * 他给的树：`Prompt ├ 文件学习（体裁 ↔ AI 导师）└ 练习（认读 ↔ 产出）`，
 * 并点名**不许有**：重复标题 · 空层级 · 看起来像父子其实平级 · 不必要的嵌套。
 *
 * ★★★ 这一组钉的是**结构**，不是判据，所以断言落在源码文本上。
 *   为什么值得钉：信息架构漂了**不会有任何东西报错** —— 页面照样渲染、
 *   四门照样绿，只是他再也找不到某一项，或者同屏看见两个「牌面」。
 *   D-486 那一轮的教训同族：闸看得见「写了没有」，看不见「摆对了没有」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripSource } from '../tools/lib/strip-comments.mjs'

/**
 * 剥掉注释再扫 —— 记账本来就该待在注释里（splash-label-keys 那次的教训）。
 *
 * ★★★ ZA-1（2026-09-15）改成共用那一份。**这里原来漏剥行注释**：
 *   只剥了 `<!-- -->` 和 `/* *\/`，`//` 那种一个没剥。探针量过：
 *   往 `.svelte` 的 script 段塞一条 `// 文件学习 体裁 AI 导师`，IA-2 当场**假红**。
 *   ☞ 方向决定坏法：**反向断言**（不许出现 X）没剥注释 → 假红（吵，但看得见）；
 *     **正向断言**（必须有 X）没剥注释 → **假绿**（写个注释就当它有了，没人会发现）。
 *     这个文件两种都有，所以两种都中。
 */
const SRC = stripSource(
  readFileSync(new URL('../src/ui/views/Settings.svelte', import.meta.url), 'utf8'),
  'Settings.svelte'
)

/** Prompt 那一页的源码（`pg === 'prompts'` 到下一个分支之间） */
const PROMPTS = (() => {
  const a = SRC.indexOf("pg === 'prompts'")
  const b = SRC.indexOf("pg === 'prompt-edit'")
  return SRC.slice(a, b)
})()

describe('IA · 设置 › Prompt 的层级（D-488）', () => {
  /**
   * ★★ IA-1 · 三个段名各有两套（D-486 结构对应，段名不许改），
   *   所以**必须一次只显示一个模式** —— 否则同屏两个「牌面」就是他说的重复标题。
   */
  it('★★ IA-1 · 顶部有模式开关，两块各在一个分支里（同屏不会出现两个「牌面」）', () => {
    /**
     * ★★★ 这一句 2026-09-15 改过一次，**因为它第一版是哑的**：
     *   原来写 `PROMPTS.includes("pTab === 'reading'")` —— 而那个串在
     *   开关按钮的 `class:sel={pTab === 'reading'}` 里也有。
     *   于是把 `{#if}` / `{:else}` 整个删掉、两块合回一页，**这条照样绿**。
     *   负向对照当场抓到（拆掉分支 → 不红）。钉的必须是**分支本身**。
     */
    assert.ok(
      PROMPTS.includes("{#if pTab === 'reading'}"),
      '★★ 认读那块没被放进 `{#if}` 分支 —— 两块会同屏，两个「牌面」一起出现'
    )
    // 两个「牌面」之间必须隔着一个 `{:else}`，否则它们在同一个分支里
    const faces = [...PROMPTS.matchAll(/<div class="sec">牌面<\/div>/g)].map((m) => m.index ?? -1)
    assert.equal(faces.length, 2, '★ 「牌面」应当两个模式各一套')
    assert.ok(
      PROMPTS.slice(faces[0], faces[1]).includes('{:else}'),
      '★★★ 两个「牌面」之间没有 `{:else}` —— 它们在同一个分支里，会同屏出现'
    )
    assert.ok(/onclick=\{\(\) => \(pTab = 'reading'\)\}/.test(PROMPTS), '★ 没有切到认读的开关')
    assert.ok(/onclick=\{\(\) => \(pTab = 'practice'\)\}/.test(PROMPTS), '★ 没有切到产出的开关')
    // 三个段名各出现两次（两个模式各一套）——这是对的，但必须分在两个分支里
    for (const name of ['牌面', '题型', '出题规则']) {
      const n = (PROMPTS.match(new RegExp(`<div class="sec">${name}</div>`, 'g')) ?? []).length
      assert.equal(n, 2, `★ 「${name}」应当两个模式各一套（D-486 结构对应），实际 ${n}`)
    }
  })

  /**
   * ★★★ IA-2 · **不许出现「文件学习」那一级**。
   *
   * `体裁` / `AI 导师` 属于文件学习线，而**那条线整条不进手机**（D-311，
   * `db/search.ts` 里那句话是同一条）。做出那一级 = 一个点进去什么都没有的入口，
   * 而「空层级」正是他这一单点名禁的。
   * ☞ 这条是**负向**的：将来谁照着他那棵树把这一级补回来，这里当场红。
   */
  it('★★★ IA-2 · 手机上不许出现「文件学习 / 体裁 / AI 导师」（D-311 那条线不进手机）', () => {
    for (const w of ['文件学习', '体裁', 'AI 导师']) {
      assert.ok(
        !PROMPTS.includes(w),
        `★★★ Prompt 页上出现了「${w}」—— 那条线整条不进手机（D-311），` +
          '做出来就是一个点进去什么都没有的空层级'
      )
    }
  })

  /**
   * ★★ IA-3 · 归类：名字叫「产出练习…」的东西不许摆在产出那一块**外面**。
   *   改之前它们在页顶一个叫「共用提示词」的块里 —— 归属和屏上的字对不上，
   *   正是他说的「归类不清」。
   */
  it('★★ IA-3 · 那两份产出的提示词在产出分支里；「共用提示词」「别处的提示词」两个块没了', () => {
    assert.ok(!PROMPTS.includes('共用提示词'), '★ 「共用提示词」那个块还在 —— 它把产出的东西摆到了产出外面')
    assert.ok(!PROMPTS.includes('别处的提示词'), '★ 「别处的提示词」那个指路块还在（主控裁：删）')
    const practice = PROMPTS.slice(PROMPTS.indexOf('{:else}'))
    assert.ok(practice.includes('OVERRIDABLE_PROMPTS.filter'), '★ 那两份提示词不在产出分支里')
    assert.ok(
      practice.includes("x.name !== 'lookup-search'"),
      '★★ `lookup-search` 没被排掉 —— 它两条学习线都不属于，不许混进产出'
    )
  })

  /**
   * ★ IA-4 · `lookup-search` 归 Settings › Lookup（按它真正服务的功能，不发明第三类）。
   */
  it('★ IA-4 · AI 搜索那份提示词的入口在 Lookup 页', () => {
    const a = SRC.indexOf("pg === 'lookup'")
    const b = SRC.indexOf("pg === 'prompts'")
    const lookup = SRC.slice(a, b)
    assert.ok(lookup.includes("openPrompt('lookup-search')"), '★ Lookup 页上没有那一行')
    assert.ok(
      lookup.includes('loadPromptStates') || SRC.includes("(refreshLkLabel(), loadPromptStates())"),
      '★★ 进 Lookup 页没读 `promptState` —— 那一行的「改过 / 默认」会永远显示默认'
    )
  })

  /**
   * ★ IA-5 · 没有空层级：每个 `<div class="sec">` 后面都得有真东西。
   *   ★ 负向对照就在这条里：把一个只有标题、底下什么都没有的 `.sec` 加进去 → 红。
   */
  it('★ IA-5 · 没有空标题（每个 sec 底下都有控件或说明）', () => {
    const parts = PROMPTS.split(/<div class="sec">/).slice(1)
    for (const seg of parts) {
      const after = seg.slice(seg.indexOf('</div>') + 6)
      const next = after.indexOf('<div class="sec">')
      const body = next < 0 ? after : after.slice(0, next)
      assert.ok(
        /<button|<div class="faces"|<div class="picks"|class="seclead"|class="m blk zh"/.test(body),
        `★ 有一个段标题底下是空的：「${seg.slice(0, 12)}…」`
      )
    }
  })
})
