/**
 * 对比度：算得对，而且**出厂那套自己得过线**（2026-09-13）
 *
 * ── 两件事，一个文件 ────────────────────────────────────────
 * ① `contrast()` 的算法对不对 —— 拿 WCAG 的定值核（白压黑必须是 21）。
 * ② **出厂那套配色自己过不过 AA** —— DS-Q23 定案「AA 4.5 是硬线」，
 *    而 `tokens.css` 头注里那些比值是**手算记下来的**，会漂。
 *    这里直接从 core 那份 CSS 解析出真值再算一遍：
 *    哪天有人调了原语把正文压页面底压到 4.5 以下，当场红。
 *
 * ★ 解析 var() 链的那几行是**量东西**，不是第二份判据 ——
 *   判据（哪个压哪个、线在哪）写在这里，值从 core 读。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contrast } from '../src/ui/lib/theme.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = readFileSync(join(ROOT, 'nyx-core/src/core/design/color-tokens.css'), 'utf8')

/** 令牌 → 声明值（原样，可能是 hex 也可能是 var(--x)） */
const RAW = new Map<string, string>()
for (const m of CSS.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8}|var\(--[a-z0-9-]+\))\s*;/g)) {
  RAW.set(m[1]!, m[2]!)
}
/** 顺着 var() 链解到 hex；解不出来给 null（调用方断言它不该是 null） */
function hexOf(name: string, seen: string[] = []): string | null {
  const v = RAW.get(name)
  if (v === undefined || seen.includes(name)) return null
  if (v.startsWith('#')) return v
  return hexOf(v.slice(6, -1), [...seen, name])
}

describe('CONTRAST · 算法本身', () => {
  it('白压黑 = 21，同色 = 1', () => {
    assert.equal(contrast('#ffffff', '#000000').toFixed(1), '21.0')
    assert.equal(contrast('#38a8b4', '#38a8b4').toFixed(1), '1.0')
  })

  it('谁压谁都一样（亮的自动当分子）', () => {
    const a = contrast('#153b4a', '#f4f8f7')
    const b = contrast('#f4f8f7', '#153b4a')
    assert.equal(a.toFixed(4), b.toFixed(4))
  })
})

describe('CONTRAST · 出厂那套自己得过线（DS-Q23：AA 4.5 是硬线）', () => {
  /** [压谁, 被压的, 至少多少, 这是给什么用的] */
  const LINES: readonly (readonly [string, string, number, string])[] = [
    ['color-text', 'color-bg', 4.5, '正文压页面底'],
    ['color-text', 'color-surface', 4.5, '正文压卡面'],
    ['color-text-2', 'color-bg', 4.5, '次要文字压页面底'],
    ['color-text-3', 'color-bg', 4.5, '淡字压页面底 —— DS-Q23 就是为它定的'],
    ['color-text-accent', 'color-bg', 4.5, '主色字压页面底']
  ]
  /**
   * ★★ 这里**只钉文字**。我一开始还加了两条「图形件 ≥ 3:1」——
   *   当场红：`--color-primary`(#38A8B4) 压页面底只有 **2.64**、
   *   `--color-border-strong`(#A8DEDA) 只有 **1.39**。
   *
   *   但那两条是**我自己编的判据**，不是这个项目定的。
   *   `src/ui/styles/tokens.css` 的头注写得很清楚：
   *     「--violet（#38A8B4）是**线与图形**的色，压白 2.9:1；
   *       当文字用请换 --violet-2（#287986，4.8:1）」
   *   —— 也就是说**设计是知情地不走 WCAG 那条 3:1 的**，
   *   而 DS-Q23 定死的硬线只有「AA 4.5，给正文」。
   *
   *   我把编的那两条撤了。数如实记在这儿（2026-09-13 实测），
   *   要不要收紧是**设计层面的事，归总控裁**，不是一道用例能替它定的。
   */

  for (const [fg, bg, min, why] of LINES) {
    it(`${why} ≥ ${min}`, () => {
      const a = hexOf(fg)
      const b = hexOf(bg)
      assert.ok(a, `★ core 里解不出 --${fg}`)
      assert.ok(b, `★ core 里解不出 --${bg}`)
      const r = contrast(a, b)
      assert.ok(
        r >= min,
        `★ ${why}：实测 ${r.toFixed(2)}，低于 ${min}。\n` +
          `  ${fg}=${a} · ${bg}=${b}\n` +
          '  ☞ 这是**出厂那套**的数，不是他改出来的 —— 改原语之前先看这条。'
      )
    })
  }
})
