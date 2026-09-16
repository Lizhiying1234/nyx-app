import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emphasisParts } from './ai-text.ts'

/**
 * AI 写的那几段字怎么显示（使用者 2026-09-15 真机点名：题面里印着星号）
 *
 * ★ 这里钉的两件都是「错了不报错」的：
 *   · 星号没拆 → 屏上一串 `**`，看着像模型出了毛病
 *   · 拆过头（吞掉不成对的星号）→ 他的字少了一截，而他不知道少了什么
 */
describe('AI 文本 · 强调段', () => {
  it('★★★ `**x**` 拆成段，星号不进屏幕', () => {
    assert.deepEqual(emphasisParts('Use the target expression **rummaging** (be rummaging).'), [
      { text: 'Use the target expression ', bold: false },
      { text: 'rummaging', bold: true },
      { text: ' (be rummaging).', bold: false }
    ])
  })

  it('★★ 一段里可以有好几处', () => {
    assert.deepEqual(emphasisParts('**a** and **b**'), [
      { text: 'a', bold: true },
      { text: ' and ', bold: false },
      { text: 'b', bold: true }
    ])
  })

  it('★★★ 没成对的星号**原样留着** —— 吞掉比印出来更糟（他不知道少了什么）', () => {
    assert.deepEqual(emphasisParts('2 ** 3 是幂'), [{ text: '2 ** 3 是幂', bold: false }])
    assert.deepEqual(emphasisParts('**没关上'), [{ text: '**没关上', bold: false }])
  })

  it('★ 空的 `****` 不算强调（拆出来屏上是个莫名的空隙）', () => {
    assert.deepEqual(emphasisParts('a****b'), [{ text: 'a****b', bold: false }])
  })

  it('★ 没有星号就一整段，空串给空数组', () => {
    assert.deepEqual(emphasisParts('plain'), [{ text: 'plain', bold: false }])
    assert.deepEqual(emphasisParts(''), [])
    assert.deepEqual(emphasisParts(null), [])
  })

  it('★★ 拼回去 = 去掉那几对星号之后的原文（不丢字、不多字）', () => {
    const raw = 'x **a** y **b** z'
    assert.equal(
      emphasisParts(raw).map((p) => p.text).join(''),
      raw.split('**').join(''),
      '★★ 拆完再拼回去和原文对不上 —— 有字被吞了或多了'
    )
  })
})
