import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { countUnanalysed, libraryState, UNANALYSED_LABEL, type LibraryRowFacts } from './library-state.ts'

/**
 * T-4.10 · 使用者点名的六类各一条（需求归档 §一·验证）。
 * 六类里有两类（「没有检测结果」与「刚采集」）在数据上是同一个形状 —— 那本来就是事实，
 * 分开写是为了让「他说的那两种情况都被盖住」看得见。
 */
const base: LibraryRowFacts = { gloss: '', derivedCount: 0, analysisBlocks: 0, edited: false }

describe('T-4.10 · 知识库行的状态判据', () => {
  it('① 正常：有释义 → glossed', () => {
    assert.equal(libraryState({ ...base, gloss: 'to take the worst part', analysisBlocks: 5 }), 'glossed')
  })

  it('② 真有问题：有 suspect 块（也是解析块）→ analysed，而不是「还没分析」', () => {
    // suspect 是一块解析块，所以它一定算进 analysisBlocks；修正记号是另一件事，不在这里判
    assert.equal(libraryState({ ...base, analysisBlocks: 1 }), 'analysed')
  })

  it('③ 没有检测结果：一块解析都没有 → unanalysed', () => {
    assert.equal(libraryState(base), 'unanalysed')
  })

  it('④ 新建（刚采集）：只有 term 与出处，没释义没解析 → unanalysed', () => {
    assert.equal(libraryState({ ...base, gloss: null }), 'unanalysed')
  })

  it('⑤ 已分析：有解析块又有释义 → glossed', () => {
    assert.equal(libraryState({ ...base, gloss: '承受最重的一击', analysisBlocks: 7 }), 'glossed')
  })

  it('⑥ 已编辑：他手改过 → 一定算分析过，绝不说「还没分析」', () => {
    assert.equal(libraryState({ ...base, edited: true }), 'analysed')
    assert.equal(libraryState({ ...base, edited: true, analysisBlocks: 0 }), 'analysed')
  })
})

describe('T-4.10 · 边界', () => {
  it('★ 只有空白的释义算没有 —— 否则一行空格会冒充「已分析」', () => {
    assert.equal(libraryState({ ...base, gloss: '   ' }), 'unanalysed')
    assert.equal(libraryState({ ...base, gloss: String.fromCharCode(10) }), 'unanalysed')
  })

  it('析出成分优先于释义（现状如此，这一轮不动它）', () => {
    assert.equal(libraryState({ ...base, gloss: '有释义', derivedCount: 3 }), 'derived')
  })

  it('★ 分析过但没写出释义 ≠ 还没分析 —— 这两种他要能分得开', () => {
    assert.equal(libraryState({ ...base, analysisBlocks: 4 }), 'analysed')
    assert.notEqual(libraryState({ ...base, analysisBlocks: 4 }), 'unanalysed')
  })

  it('表头计数只数「还没分析」那一支', () => {
    assert.equal(countUnanalysed(['unanalysed', 'glossed', 'unanalysed', 'derived', 'analysed']), 2)
    assert.equal(countUnanalysed([]), 0)
  })

  it('文案是中性的一句话，不是警告', () => {
    assert.equal(UNANALYSED_LABEL, '还没分析')
  })
})
