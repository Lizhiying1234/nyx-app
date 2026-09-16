import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ANALYSIS_MAX_TOKENS, analysisVars, buildRequest } from './request.ts'

const FACTS = { term: 'bear the brunt of', kind: 'chunk', layer: 'B', quote: 'They bore it.' }

describe('T-7.8 · buildRequest', () => {
  it('★ 一份变量喂两段 —— SYSTEM 段里的占位符也要填掉', () => {
    const r = buildRequest(
      FACTS,
      { system: 'kind={{KIND}} level={{LEVEL}}', user: 'term={{TERM}} quote={{QUOTE}}' },
      'B2'
    )
    assert.equal(r.system, 'kind=chunk level=B2')
    assert.equal(r.user, 'term=bear the brunt of quote=They bore it.')
  })

  it('LAYER 给的是中文全称，不是那个字母（模型猜不出 "B" 是什么）', () => {
    assert.equal(analysisVars(FACTS, 'B2').LAYER, 'B 主动词汇')
    assert.equal(analysisVars({ ...FACTS, layer: 'A' }, 'B2').LAYER, 'A 被动词汇')
  })

  it('没有出处时 QUOTE 是空串，不是 "null"', () => {
    assert.equal(analysisVars({ ...FACTS, quote: null }, 'B2').QUOTE, '')
  })

  it('永远要 JSON，上限沿用原实现的 4000', () => {
    const r = buildRequest(FACTS, { system: 's', user: 'u' }, 'B2')
    assert.equal(r.json, true)
    assert.equal(r.maxTokens, ANALYSIS_MAX_TOKENS)
    assert.equal(r.maxTokens, 4000)
  })

  it('★★ 提示词里有没人填的变量 → 当场抛，不许把 {{X}} 原样发给 AI', () => {
    assert.throws(
      () => buildRequest(FACTS, { system: '{{TYPES}}', user: 'u' }, 'B2'),
      /TYPES/,
      '★★ 占位符原样发出去了 —— 出来的解析一定是错的，而一切看起来都"成功"'
    )
  })
})
