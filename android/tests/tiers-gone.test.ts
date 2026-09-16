/**
 * 档位机制真的没了（T-9.12 · D-478 ①）
 *
 * ── 为什么这一条要单独存在 ──────────────────────────────────
 *
 * 「取消一个机制」最容易留下的不是报错，是**半条链**：judgement 那半按新的走，
 * 而界面上还挂着旧的控件、旧的标签。那种状态下四门全绿、真机上却还能点到
 * 一个已经不接任何东西的档位 —— 他点了没反应，而没有任何东西会红。
 *
 * 所以这里钉的是**源码里还有没有那几件东西**（`kit.test.ts` 的同一手法）：
 *   ① Settings 题型页：五颗 T1–T5 pill 与 `T{q.tier}` 标签
 *   ② Practice 屏顶：那条 `· T{q.tier}`
 *   ③ 出题与取题：不再按 tier 排序、不再按 tier 过滤
 *   ④ core 那三个符号（`tierFor` · `Tier` · `typesInTier`）不许再出现在链里
 *
 * ★ `questions.tier` / `qtypes.tier` 两列**留在库上**（D-216 退役列只读不删），
 *   所以这里不扫 SQL 里的列名 —— 只扫「有没有人拿它当判据」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const SETTINGS = read('src/ui/views/Settings.svelte')
const PRACTICE_UI = read('src/ui/views/Practice.svelte')
const PRACTICE_DB = read('src/db/practice.ts')
const CORE_LINK = read('src/core-link.ts')

/** 注释不算 —— 说明为什么删掉的那几句本来就该留着 */
const code = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')

describe('TG · 档位机制取消（D-478 ①）', () => {
  it('TG-1 · Settings 题型页没有档位控件（五颗 T1–T5 与 T? 标签都不在）', () => {
    const s = code(SETTINGS)
    assert.ok(!/\[1, 2, 3, 4, 5\]/.test(s), '★ 五颗档位 pill 又回来了')
    assert.ok(!/q\.tier/.test(s), '★ 题型行上又读了 tier')
    assert.ok(!/难度档/.test(s), '★「难度档」那句说明又回来了')
  })

  it('TG-2 · 练习屏顶不再报档位', () => {
    assert.ok(!/T\{q\.tier\}/.test(code(PRACTICE_UI)), '★ 屏顶又挂上了 T{q.tier}')
  })

  it('TG-3 · 出题与取题不拿 tier 当判据（列还在库上，但没人读）', () => {
    const s = code(PRACTICE_DB)
    assert.ok(!/order by tier/.test(s), '★ 又按 tier 排序了')
    assert.ok(!/and tier = \?/.test(s), '★ 又按 tier 过滤了')
    assert.ok(!/select id, tier/.test(s), '★ 取题又把 tier 读出来了')
    // ★ 正面：一次出几道来自他的偏好，不是写死的常数
    assert.match(s, /clampQuestionsPerItem\(await prefRaw\(db, 'param\.questionsPerItem'\)\)/)
  })

  it('TG-4 · core 那三个符号不在链里（A 的 check:android-imports 红的就是这个）', () => {
    const s = code(CORE_LINK)
    for (const sym of ['tierFor', 'typesInTier', 'planTypesInTier']) {
      assert.ok(!new RegExp(`\\b${sym}\\b`).test(s), `★ core-link 还转出着 ${sym}，而 core 里已经没有它`)
    }
  })
})
