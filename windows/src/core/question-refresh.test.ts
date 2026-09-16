import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planQuestionRefresh, onGenerateFailed, KEPT_OLD_NOTICE } from './question-refresh.ts'

describe('出题的替换次序（I-207）', () => {
  it('规则签名过期 → 生成，而且成功之后要替换旧的', () => {
    assert.deepEqual(planQuestionRefresh({ staleCount: 14, haveCount: 14 }), {
      generate: true,
      dropOld: true
    })
  })

  it('手上有题、没有过期的 → 什么都不做（D-129：别白花一次钱）', () => {
    assert.deepEqual(planQuestionRefresh({ staleCount: 0, haveCount: 15 }), {
      generate: false,
      dropOld: false
    })
  })

  it('一道都没有 → 生成，没有旧的可替换', () => {
    assert.deepEqual(planQuestionRefresh({ staleCount: 0, haveCount: 0 }), {
      generate: true,
      dropOld: false
    })
  })

  it('★★★ 只要计划要替换，就一定同时要生成 —— 不许出现「删了但不生成」', () => {
    for (const staleCount of [0, 1, 14]) {
      for (const haveCount of [0, 1, 15]) {
        const p = planQuestionRefresh({ staleCount, haveCount })
        assert.ok(
          !p.dropOld || p.generate,
          `staleCount=${staleCount} haveCount=${haveCount} 算出了「删旧但不生成」`
        )
      }
    }
  })

  it('生成失败但手上还有题 → 照旧用上一批，并说那一句', () => {
    assert.deepEqual(onGenerateFailed({ haveCount: 14 }), {
      kind: 'keep-old',
      notice: KEPT_OLD_NOTICE
    })
  })

  it('★★ 生成失败且一道都没有 → 必须报出去，不许假装练得下去', () => {
    assert.deepEqual(onGenerateFailed({ haveCount: 0 }), { kind: 'report' })
  })

  it('那句话不许把模型的事摆给他看', () => {
    assert.ok(!KEPT_OLD_NOTICE.includes('额度'), '这句是给他看的，模型那句进账本')
    assert.ok(!KEPT_OLD_NOTICE.includes('思考'), '同上')
  })
})
