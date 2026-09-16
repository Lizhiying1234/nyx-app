import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYSIS_SCOPE_COND,
  ANALYSIS_TOTAL_SQL,
  NO_FULL_ANALYSIS,
  PENDING_ANALYSIS_SQL
} from './analysis.ts'
import { PRODUCTION_APPLIES } from './silence.ts'

/**
 * T-7.8 · 队列判据。
 *
 * ★ 真正的对拍在 `tests/db-safety.ts`（真库跑一遍，队列与「待分析 N 条」必须同一个数）。
 *   这里只钉住三件不该漂的事：三类各是什么条件 · summary 不算有解析 ·
 *   队列与计数用的是同一个条件。
 */

describe('T-7.8 · 待分析队列的 SQL 判据', () => {
  it('「我的收集」= 自己贴的整句，且不是从别的条目析出来的', () => {
    assert.equal(ANALYSIS_SCOPE_COND('self'), `i.source = 'self' and i.derived_from is null`)
  })

  it('「主动词汇」直接用产出线判据，不另写一份', () => {
    assert.equal(ANALYSIS_SCOPE_COND('active'), PRODUCTION_APPLIES('i'))
  })

  it('「被动词汇」= A 层里去掉「我的收集」那一批', () => {
    assert.equal(
      ANALYSIS_SCOPE_COND('passive'),
      `i.layer = 'A' and not (i.source = 'self' and i.derived_from is null)`
    )
  })

  it('表别名换得掉（同一句判据要能贴进不同的查询）', () => {
    assert.ok(ANALYSIS_SCOPE_COND('self', 'x').startsWith(`x.source = 'self'`))
    assert.ok(NO_FULL_ANALYSIS('x').includes('b.item_id = x.id'))
  })

  it('★ 只有 summary 的不算有解析 —— 摘要是另一条线的产物', () => {
    assert.ok(
      NO_FULL_ANALYSIS().includes(`b.block <> 'summary'`),
      '★ 少了这一句，写过摘要的条目就再也排不进队列了'
    )
  })

  it('★★ 队列与计数用的是同一个条件 —— 下拉框的数字不许和真跑的条数对不上', () => {
    for (const scope of ['self', 'active', 'passive'] as const) {
      const cond = ANALYSIS_SCOPE_COND(scope)
      assert.ok(PENDING_ANALYSIS_SQL(scope).includes(cond), `${scope} 队列漏了条件`)
      assert.ok(ANALYSIS_TOTAL_SQL(scope).includes(cond), `${scope} 计数漏了条件`)
    }
  })

  it('队列按 id 排 —— 顺序稳定，暂停再续才接得上', () => {
    assert.ok(PENDING_ANALYSIS_SQL('active').trimEnd().endsWith('order by i.id'))
  })

  it('分母那一句不带「还没解析」的条件（它是「一共多少条」）', () => {
    assert.ok(!ANALYSIS_TOTAL_SQL('active').includes('analysis_blocks'))
  })
})
