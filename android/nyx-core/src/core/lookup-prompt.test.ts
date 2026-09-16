import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BRIEF_PROMPT, lookupUserMessage, parseBrief } from './lookup-prompt.ts'

/**
 * 词条顶部那两行简短释义 · 使用者 2026-09-13 第二轮
 *
 * ★ 这一套钉的是**有没有摆错位置** —— 英文那行显示在上面、中文那行点开才看，
 *   摆反了他会以为那行中文是英文释义的位置坏了，而屏上什么都不会报。
 */

describe('两行带前缀（提示词要的那个形状）', () => {
  it('EN / ZH 各归各位', () => {
    const b = parseBrief('EN: a long flat surface in a shop\nZH: 柜台；计数器；反驳')
    assert.equal(b.en, 'a long flat surface in a shop')
    assert.equal(b.zh, '柜台；计数器；反驳')
  })

  it('大小写、中文冒号、中文前缀都认', () => {
    assert.deepEqual(parseBrief('en：a flat surface\nzh：柜台'), {
      en: 'a flat surface',
      zh: '柜台'
    })
    assert.deepEqual(parseBrief('英文：a flat surface\n中文：柜台'), {
      en: 'a flat surface',
      zh: '柜台'
    })
    assert.deepEqual(parseBrief('英: a flat surface\n中: 柜台'), {
      en: 'a flat surface',
      zh: '柜台'
    })
  })

  it('顺序反了也认 —— 认的是前缀，不是第几行', () => {
    assert.deepEqual(parseBrief('ZH: 柜台\nEN: a flat surface'), {
      en: 'a flat surface',
      zh: '柜台'
    })
  })

  it('剥掉星号、反引号、围栏、引号', () => {
    const b = parseBrief('```\n**EN:** `a flat surface`\nZH: 「柜台」\n```')
    assert.equal(b.en, 'a flat surface')
    assert.equal(b.zh, '柜台')
  })

  it('同一个前缀出现两次 —— 留第一次那条，不拼起来', () => {
    // 拼起来的话，那一行会长到把词条头挤变形
    const b = parseBrief('EN: first\nEN: second\nZH: 一\nZH: 二')
    assert.equal(b.en, 'first')
    assert.equal(b.zh, '一')
  })
})

describe('★★ 一个前缀都没有的时候', () => {
  it('第一行是英文 → 按位置退', () => {
    assert.deepEqual(parseBrief('a long flat surface\n柜台；计数器'), {
      en: 'a long flat surface',
      zh: '柜台；计数器'
    })
  })

  it('★ 第一行是中文 → 中文归中文，**英文宁可空着**', () => {
    // 摆错位置比不摆更糟：他会以为那行中文就是英文释义
    assert.deepEqual(parseBrief('柜台；计数器'), { en: '', zh: '柜台；计数器' })
  })

  it('只有一行英文 → 中文空着，不去编一句', () => {
    assert.deepEqual(parseBrief('a long flat surface'), { en: 'a long flat surface', zh: '' })
  })
})

describe('绝不抛', () => {
  it('空 / 非字符串 → 两个空串', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      assert.deepEqual(parseBrief(bad as unknown as string), { en: '', zh: '' }, String(bad))
    }
  })
})

describe('提示词自己', () => {
  it('把那个形状说死了 —— 认不出形状的话上面整套都白搭', () => {
    assert.ok(DEFAULT_BRIEF_PROMPT.includes('EN: '))
    assert.ok(DEFAULT_BRIEF_PROMPT.includes('ZH: '))
  })

  it('说了「只回两行」，也说了不要 Markdown', () => {
    assert.ok(DEFAULT_BRIEF_PROMPT.includes('只回两行'))
    assert.ok(DEFAULT_BRIEF_PROMPT.includes('Markdown'))
  })
})

describe('送给模型的那一句说清形态', () => {
  it('一个词 / 一个词组 / 一段文字，叫法不一样', () => {
    assert.equal(lookupUserMessage('counter'), '这个词：counter')
    assert.equal(lookupUserMessage('run counter to'), '这个词组：run counter to')
    assert.ok(
      lookupUserMessage(
        'The policy will run counter to what the House Minority said last week.'
      ).startsWith('这段文字：')
    )
  })
})
