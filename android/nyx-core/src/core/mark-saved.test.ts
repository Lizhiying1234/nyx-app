import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { markSaved, type Seg } from './mark-saved.ts'

/**
 * 「已收进 Nyx」的标记 · 使用者 2026-09-13 第 4.4 条
 *
 * ★ 这一套钉的不是「好不好看」，是**标对没标对** ——
 *   标错了他会以为某个词收过了（于是不收），那是数据层面的误导。
 */

/** 把切块结果还原成一句好读的话：标中的用「〔〕」框起来 */
function show(segs: Seg[]): string {
  return segs.map((s) => (s.saved ? '〔' + s.text + '〕' : s.text)).join('')
}
/** 切出来的块拼回去必须等于原文 —— 这一条每个用例都该成立 */
function lossless(segs: Seg[], src: string): void {
  assert.equal(segs.map((s) => s.text).join(''), src, '★★ 切完拼不回原文 —— 文章会缺字')
}

describe('标记 · 基本形状', () => {
  it('★ 没有收过任何东西 → 整段一块，不标', () => {
    const src = 'The quick brown fox.'
    const segs = markSaved(src, [])
    assert.deepEqual(segs, [{ text: src, saved: false }])
  })

  it('★ 标中一个词', () => {
    const src = 'The quick brown fox.'
    const segs = markSaved(src, ['quick'])
    lossless(segs, src)
    assert.equal(show(segs), 'The 〔quick〕 brown fox.')
  })

  it('★ 同一个词出现几次，每次都标', () => {
    const src = 'run and run and run'
    const segs = markSaved(src, ['run'])
    lossless(segs, src)
    assert.equal(show(segs), '〔run〕 and 〔run〕 and 〔run〕')
  })

  it('★ 空段 / 空词 / 只有空白的词 —— 都不炸', () => {
    assert.deepEqual(markSaved('', ['a']), [])
    assert.equal(show(markSaved('abc', ['', '   '])), 'abc')
    assert.doesNotThrow(() => markSaved('abc', [null as unknown as string, 'b']))
  })

  it('★ 词比整段还长 → 跳过（标不出东西，不该白跑）', () => {
    assert.equal(show(markSaved('ab', ['abcdef'])), 'ab')
  })
})

describe('★★ 规则② · 英文卡词边界（否则标记会变成噪音）', () => {
  it('★★★ 收过 the 之后，there / other / theme 不许被标上', () => {
    const src = 'There is the other theme.'
    const segs = markSaved(src, ['the'])
    lossless(segs, src)
    assert.equal(
      show(segs),
      'There is 〔the〕 other theme.',
      '★★ 整篇的 there/other/theme 被标上的话，那不是标记，那是噪音'
    )
  })

  it('★ 大小写不算区别：The 也要标', () => {
    assert.equal(show(markSaved('The cat', ['the'])), '〔The〕 cat')
    assert.equal(show(markSaved('the CAT', ['Cat'])), 'the 〔CAT〕')
  })

  it('★ 中文不卡边界 —— 卡了就一个都标不出来', () => {
    const src = '这个词在句子里出现了两次：句子。'
    const segs = markSaved(src, ['句子'])
    lossless(segs, src)
    assert.equal(show(segs), '这个词在〔句子〕里出现了两次：〔句子〕。')
  })

  it('★ 词组里带空格 / 连字符，照样按两端定边界', () => {
    assert.equal(show(markSaved('a self-government here', ['self-government'])), 'a 〔self-government〕 here')
    assert.equal(show(markSaved('run counter to it', ['run counter to'])), '〔run counter to〕 it')
  })
})

describe('★★ 规则① + ③ · 长的先标、不许重叠', () => {
  it('★★★ 同时收过 chunk 和它里面的词 → 标成一整条，不是两截', () => {
    const src = 'They run counter to the plan.'
    const segs = markSaved(src, ['run', 'run counter to'])
    lossless(segs, src)
    assert.equal(
      show(segs),
      'They 〔run counter to〕 the plan.',
      '★★ 短的先标的话，长的那条只剩两个零碎尾巴 —— 屏上看着像标歪了'
    )
  })

  it('★ 两条交叉时先到先得，绝不切碎', () => {
    const src = 'abc def ghi'
    const segs = markSaved(src, ['abc def', 'def ghi'])
    lossless(segs, src)
    // 一样长 → 按字典序，'abc def' 先；'def ghi' 与它重叠，整条放弃
    assert.equal(show(segs), '〔abc def〕 ghi')
  })

  it('★ 每个字符只属于一个块（切出来的块不重叠、不丢字）', () => {
    const src = 'the theme of the theory'
    const segs = markSaved(src, ['the', 'theme', 'theory'])
    lossless(segs, src)
    assert.equal(show(segs), '〔the〕 〔theme〕 of 〔the〕 〔theory〕')
  })

  it('★ 重复传同一个词不会翻倍', () => {
    assert.equal(show(markSaved('run run', ['run', 'run', ' run '])), '〔run〕 〔run〕')
  })
})

describe('★ 真实一点的一段', () => {
  it('一段里既有词、又有 chunk、还有中文', () => {
    const src = 'The policy will run counter to what the House Minority said about 分权.'
    const segs = markSaved(src, ['run counter to', 'House Minority', '分权', 'policy'])
    lossless(segs, src)
    assert.equal(
      show(segs),
      'The 〔policy〕 will 〔run counter to〕 what the 〔House Minority〕 said about 〔分权〕.'
    )
  })
})
