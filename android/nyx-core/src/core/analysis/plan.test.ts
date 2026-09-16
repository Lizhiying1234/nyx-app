import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planWrites, type ExistingBlock } from './plan.ts'
import { RENDERED_BLOCKS, isRenderedBlock } from './blocks.ts'

/**
 * T-7.8 · 写入计划的六条判据（见 plan.ts 文件头）。
 *
 * ★ 每一条判据坏掉的样子都是**静默的** —— 不报错、不崩，只是他手改的那段没了、
 *   或者例句里没了词典来源。所以这里一条一条钉。
 */

const NONE: ExistingBlock[] = []

describe('T-7.8 · planWrites · 普通区块', () => {
  it('字符串原样写，数组/对象转成 JSON', () => {
    const p = planWrites({ meaning: '承受最重的一击', chunks: ['a', 'b'] }, NONE, [])
    assert.deepEqual(
      p.blocks.map((b) => [b.block, b.content]),
      [
        ['meaning', '承受最重的一击'],
        ['chunks', '["a","b"]']
      ]
    )
    assert.equal(p.written, 2)
  })

  it('顺序按模型返回的键序，不排序', () => {
    const p = planWrites({ register: 'r', inSentence: 'm', chunks: 'c' }, NONE, [])
    assert.deepEqual(p.blocks.map((b) => b.block), ['register', 'inSentence', 'chunks'])
  })

  it('★ 空的一律不写：空串 · 只有空白 · [] · {} · null · undefined', () => {
    const p = planWrites(
      { a: '', b: '   ', c: [], d: {}, e: null, f: undefined, meaning: '真的有内容' },
      NONE,
      []
    )
    assert.deepEqual(p.blocks.map((b) => b.block), ['meaning'])
    assert.equal(p.written, 1)
  })

  it('regen：没有这一块从 0 开始，已经有就在原来的数上 +1', () => {
    const existing: ExistingBlock[] = [
      { block: 'inSentence', edited: 0, regenCount: 2 },
      { block: 'chunks', edited: 0, regenCount: 0 }
    ]
    const p = planWrites({ inSentence: 'm2', chunks: 'c2', register: 'p1' }, existing, [])
    assert.deepEqual(
      p.blocks.map((b) => [b.block, b.regen]),
      [
        ['inSentence', 3],
        ['chunks', 1],
        ['register', 0]
      ]
    )
  })
})

describe('T-7.8 · planWrites · D-149 手改过的一个字不动', () => {
  it('★★ edited 非 0 的区块不进计划（本轮的负向对照点）', () => {
    const existing: ExistingBlock[] = [{ block: 'meaning', edited: 1, regenCount: 0 }]
    const p = planWrites({ meaning: 'AI 想盖掉他写的那段', chunks: 'c' }, existing, [])
    assert.deepEqual(p.blocks.map((b) => b.block), ['chunks'])
    assert.ok(
      !p.blocks.some((b) => b.block === 'meaning'),
      '★★ 他手写的那一块被 AI 盖了 —— D-149 说这是绝不允许的'
    )
  })

  it('edited = 0 的照常覆盖（撤销手动编辑之后要能交还给 AI）', () => {
    const existing: ExistingBlock[] = [{ block: 'meaning', edited: 0, regenCount: 1 }]
    const p = planWrites({ meaning: '新的' }, existing, [])
    assert.deepEqual(p.blocks, [{ block: 'meaning', content: '新的', regen: 2 }])
  })

  it('★ 例句那一支也认 edited —— 词典再好也不能盖他手写的例句', () => {
    const existing: ExistingBlock[] = [{ block: 'examples', edited: 1, regenCount: 0 }]
    const p = planWrites({ examples: [{ text: 'ai' }] }, existing, [
      { text: '词典的句子', from: 'COCA' }
    ])
    assert.deepEqual(p.blocks, [])
  })
})

describe('T-7.8 · planWrites · D-150 例句来源', () => {
  it('★ 词典的排前面并标 source=dict，AI 补的排后面', () => {
    const p = planWrites({ examples: [{ text: 'AI 补的' }] }, NONE, [
      { text: '出版过的真句子', from: 'COCA' }
    ])
    assert.deepEqual(JSON.parse(p.blocks[0]!.content), [
      { text: '出版过的真句子', source: 'dict', note: 'COCA' },
      { text: 'AI 补的' }
    ])
  })

  it('AI 那边没有 text 的条目丢掉（模型偶尔会返回别的形状）', () => {
    const p = planWrites({ examples: [{ text: 'ok' }, { nope: 1 }, null] }, NONE, [
      { text: 'd', from: 'X' }
    ])
    assert.equal(JSON.parse(p.blocks[0]!.content).length, 2)
  })

  it('★ 没有词典时走普通那一支 —— AI 给什么写什么（没放词典也照常能用）', () => {
    const p = planWrites({ examples: [{ text: 'ok' }, { nope: 1 }] }, NONE, [])
    assert.deepEqual(JSON.parse(p.blocks[0]!.content), [{ text: 'ok' }, { nope: 1 }])
  })
})

describe('T-7.8 · planWrites · R-002 释义回写到条目', () => {
  it('gloss / glossZh 不当区块存，去 items 那两列', () => {
    const p = planWrites({ gloss: '  英文释义  ', glossZh: '中文释义' }, NONE, [])
    assert.deepEqual(p.blocks, [])
    assert.deepEqual(p.gloss, [
      { column: 'gloss', value: '英文释义' },
      { column: 'gloss_zh', value: '中文释义' }
    ])
  })

  it('空释义不回写（别把已有的释义擦成空的）', () => {
    const p = planWrites({ gloss: '', glossZh: '   ' }, NONE, [])
    assert.deepEqual(p.gloss, [])
    assert.equal(p.shown, 0)
  })

  it('★ 释义不看 edited —— edited 是区块上的标记，释义不是区块', () => {
    const existing: ExistingBlock[] = [{ block: 'gloss', edited: 1, regenCount: 0 }]
    const p = planWrites({ gloss: 'x' }, existing, [])
    assert.deepEqual(p.gloss, [{ column: 'gloss', value: 'x' }])
  })
})

describe('T-7.8 · planWrites · I-112 数「详情页认得几块」', () => {
  it('★★ 模型多包一层：写进去了，但他一个字都看不见', () => {
    const p = planWrites({ analysis: { meaning: '被包起来了' } }, NONE, [])
    assert.equal(p.written, 1, '确实写了一块')
    assert.equal(p.shown, 0, '★★ 而详情页一块都认不得 —— 这就是「点了没反应」')
    assert.deepEqual(p.keys, ['analysis'], '报给他看的字段名要拿得到')
  })

  it('认得的块与回写的释义都算进 shown', () => {
    const p = planWrites({ meaning: 'm', gloss: 'g', analysis: 'x' }, NONE, [])
    assert.equal(p.written, 2, 'meaning 与 analysis 写进了库，gloss 不是区块')
    assert.equal(p.shown, 2, 'meaning 与 gloss 他看得见，analysis 看不见')
  })

  it('例句那一支永远算他看得见（词典的句子一定显示得出来）', () => {
    const p = planWrites({ examples: [] }, NONE, [{ text: 'd', from: 'X' }])
    assert.equal(p.shown, 1)
  })
})

describe('T-7.8 · RENDERED_BLOCKS', () => {
  it('名单搬进 core 之后内容没变（gloss / meaning / examples / suspect 都在）', () => {
    for (const b of ['gloss', 'glossZh', 'inSentence', 'chunks', 'examples', 'suspect']) {
      assert.ok(isRenderedBlock(b), `${b} 该在名单里`)
    }
    assert.ok(!isRenderedBlock('analysis'), 'analysis 是模型多包的一层，不该在名单里')
    assert.equal(RENDERED_BLOCKS.length, 23, '名单条数变了就要同步改 ItemDetail.svelte')
  })
})
