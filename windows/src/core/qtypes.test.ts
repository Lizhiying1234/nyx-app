import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ALL_QTYPE_IDS, QTYPES } from './qtypes.ts'

describe('题型多选 · 使用者 7', () => {
  it('★★ 出厂那 12 种都在，而且没有 tier 这个概念了（D-478）', () => {
    assert.equal(QTYPES.length, 12, '出厂题型的条数变了就要有人交代为什么')
    for (const q of QTYPES) {
      assert.ok(!('tier' in q), `★★ ${q.id} 身上还挂着 tier —— 档位机制 2026-09-08 取消了`)
    }
    // D-116 最早那五种仍然认得出来（`builtins` 建库时按它排在前面）
    assert.equal(QTYPES.filter((q) => q.canonical).length, 5, 'D-116 原本那五种应该都还标着')
  })

  it('★ 绝不出现选择题 / 连线题 / 选项式完形填空', () => {
    for (const q of QTYPES) {
      const text = `${q.name} ${q.brief} ${q.guide}`
      assert(!/选择题|连线|multiple[- ]choice|choose (the|one) (correct|right)/i.test(text), `${q.id} 是选项题`)
      assert(!/翻译|translate into|中译英|英译中/i.test(text), `${q.id} 涉及中英互译`)
    }
  })

  it('题面说明是英文 —— 「尽量不出现中文」（M-038 / D-157）', () => {
    for (const q of QTYPES) {
      assert(!/[一-龥]/.test(q.guide), `${q.id} 的出题说明里有中文：${q.guide.slice(0, 40)}`)
    }
  })

  it('★★ 题型的判据只有一处 —— 这个文件只描述「有哪几种」，不决定「出哪一道」', () => {
    /**
     * ★ 2026-09-08（D-478）· 这一条原来验的是「勾选改不了难度档」。
     *   档位取消后，那句话没有对象了；留下来的规矩是**分工**：
     *   有哪几种在 `qtypes.ts`，出哪一道在 `qtype-plan.ts`（含 M-027 的跨题型判据），
     *   两件事不许再拌回一个函数里（F-② 拆开之前就是拌着的）。
     */
    for (const q of QTYPES) {
      assert.ok(typeof q.id === 'string' && q.id.length > 0, '题型得有稳定标识')
      assert.ok(typeof q.guide === 'string' && q.guide.length > 0, `${q.id} 没有给提示词的说明`)
    }
  })

  it('老数据里的五个题型名字原样保留 —— 改了就对不上库里的行', () => {
    for (const old of ['造句', '句子改写', '错误订正', '限定写作', '情景任务']) {
      assert(ALL_QTYPE_IDS.includes(old), `${old} 不见了`)
    }
  })
})
