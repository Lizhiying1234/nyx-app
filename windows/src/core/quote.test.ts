import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findQuote, findQuoteIn, sentences } from './quote.ts'

const TEXT = `Coastal towns bear the brunt of these storms every winter. The damage compounds.

Orthodoxy held sway over the profession for the better part of a century. Mr. Smith disagreed.
It is precisely because proximity is cheap that accidents become productive.`

describe('切句（I-103）', () => {
  it('按 . ! ? 断句，换行也算一句', () => {
    const s = sentences(TEXT)
    assert.ok(s.includes('The damage compounds.'), `没切出来：${JSON.stringify(s)}`)
    assert.ok(s.some((x) => x.startsWith('Coastal towns bear the brunt')))
  })

  it('常见缩写不当成句号 —— 「Mr. Smith」不该被劈成两句', () => {
    const s = sentences(TEXT)
    assert.ok(
      s.some((x) => x === 'Mr. Smith disagreed.'),
      `Mr. 被当成句尾了：${JSON.stringify(s)}`
    )
  })
})

describe('从原文里找摘句（M-012 / I-103）', () => {
  it('★ 原样出现就返回整句 —— 而不是他贴进来的那一行', () => {
    assert.equal(
      findQuote(TEXT, 'bear the brunt of'),
      'Coastal towns bear the brunt of these storms every winter.'
    )
  })

  it('★ 词形变了也找得到：hold sway over → held sway over', () => {
    const q = findQuote(TEXT, 'hold sway over')
    assert.ok(q?.startsWith('Orthodoxy held sway over the profession'), `找歪了：${q}`)
  })

  it('大小写、弯引号、连字符不影响', () => {
    const t = 'The so‑called “new normal” is a far cry from what we expected.'
    assert.ok(findQuote(t, 'A FAR CRY FROM')?.includes('far cry from'))
  })

  it('★ 找不到就返回 null —— 宁可没有出处，也不要一个错的', () => {
    assert.equal(findQuote(TEXT, 'take root in the community'), null)
    // 错的出处会一路带进认读卡和导出的笔记，比没有更糟
  })

  it('★★ 同一段里出现好几次 → **取第一次那一句**（使用者 2026-09-13）', () => {
    /**
     * 他的原话：「如果一个知识点能够正确匹配到原文中的多个引文：
     *   以第一次出现的引文为准。」
     *
     * ★ 代码本来就是这么做的（按句子顺序扫、第一个命中就返回）——
     *   钉它是因为**没人钉过**：哪天有人改成「取最长的那句」或者
     *   「取最像的那句」，屏幕上只是出处变了一句，不会有任何报错。
     */
    const text =
      'The market will run counter to expectations. ' +
      'Analysts disagree about that. ' +
      'A second sentence also mentions counter, with more detail around it.'
    assert.equal(
      findQuote(text, 'counter'),
      'The market will run counter to expectations.',
      '★★ 取的不是第一次出现的那一句'
    )
  })

  it('多份材料按顺序找，第一份命中就用它', () => {
    const a = 'Nothing relevant here.'
    const b = 'Coastal towns bear the brunt of these storms every winter.'
    assert.equal(
      findQuoteIn([a, b], 'bear the brunt of'),
      'Coastal towns bear the brunt of these storms every winter.'
    )
    assert.equal(findQuoteIn([a], 'bear the brunt of'), null)
  })

  it('空输入不炸', () => {
    assert.equal(findQuote('', 'x'), null)
    assert.equal(findQuote(TEXT, ''), null)
    assert.equal(findQuoteIn([], 'x'), null)
  })
})
