import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPTURE_OP,
  EVIDENCE_MARKS_SQL,
  EVIDENCE_RANGE_PAIRS,
  EVIDENCE_SQL,
  EVIDENCE_TABLES,
  IN_RANGE,
  LOOKUP_OP,
  type EvidenceSource
} from './analytics.ts'
import { NO_FULL_ANALYSIS } from './analysis.ts'
import { emptyInput } from '../analytics/types.ts'

/**
 * T-4.12 · 取数判据。
 *
 * 真正的对拍在 `tests/db-safety/analytics.ts`（真库形状跑一遍，逐个数字核）。
 * 这里只钉住几件不该漂的事：只读 · 参数个数 · 八张表都在 · 「已分析」不另写一份判据。
 */

const q = (sql: string): number => (sql.match(/\?/g) ?? []).length

describe('T-4.12 · 证据层的 SQL', () => {
  it('★★ 一句写都没有 —— 这一层只读', () => {
    for (const [key, sql] of Object.entries(EVIDENCE_SQL)) {
      const low = sql.toLowerCase()
      for (const bad of ['insert ', 'update ', 'delete ', 'drop ', 'alter ']) {
        assert.ok(!low.includes(bad), `★★ ${key} 里出现了 ${bad.trim()} —— 报告不许改库`)
      }
      assert.ok(low.trimStart().startsWith('select'), `${key} 不是一句 select`)
    }
  })

  it('取数层的 key 与 EvidenceInput 的字段一一对应', () => {
    assert.deepEqual(Object.keys(EVIDENCE_SQL).sort(), Object.keys(emptyInput()).sort())
    assert.deepEqual(Object.keys(EVIDENCE_RANGE_PAIRS).sort(), Object.keys(EVIDENCE_SQL).sort())
  })

  it('★ 每句要几个参数，说出来的和真有的一样多', () => {
    for (const [key, sql] of Object.entries(EVIDENCE_SQL)) {
      assert.equal(
        q(sql),
        EVIDENCE_RANGE_PAIRS[key as EvidenceSource] * 2,
        `★ ${key} 的问号个数和 EVIDENCE_RANGE_PAIRS 对不上 —— 取数时会当场抛，或者更糟：少切一段时间`
      )
    }
  })

  it('时间窗左闭右开 —— 同一天的行不许在两个范围里各算一次', () => {
    assert.equal(IN_RANGE('a.created_at'), 'a.created_at >= ? and a.created_at < ?')
  })

  it('八张事件表全都取到了（少一张，报告上就有一块没有出处）', () => {
    const all = Object.values(EVIDENCE_SQL).join(' ')
    for (const t of EVIDENCE_TABLES) {
      assert.ok(all.includes(t), `★ 没有一句读 ${t}`)
    }
  })

  it('查词 / 收下认的是 ops_log 里的那两个 op', () => {
    assert.ok(EVIDENCE_SQL.lookups.includes(`o.op = '${LOOKUP_OP}'`))
    assert.ok(EVIDENCE_SQL.captures.includes(`o.op = '${CAPTURE_OP}'`))
    assert.ok(EVIDENCE_SQL.captures.includes(`o.target = 'item'`), '收下那一行的 target_id 才是 item id')
  })

  it('★★ 「已分析」复用 NO_FULL_ANALYSIS，不在报告里另写一份', () => {
    assert.ok(
      EVIDENCE_MARKS_SQL.includes(NO_FULL_ANALYSIS('i')),
      '★★ 判据写了第二份 —— 「待分析 12 条」和报告里的「已分析」迟早对不上'
    )
  })

  it('「已编辑」看的是 corrections 那一块（T-5.14 的留痕）', () => {
    assert.ok(EVIDENCE_MARKS_SQL.includes(`b.block = 'corrections'`))
  })

  it('已删的条目不进逐条证据', () => {
    assert.ok(EVIDENCE_SQL.items.includes('i.deleted_at is null'))
    assert.ok(EVIDENCE_MARKS_SQL.includes('i.deleted_at is null'))
  })

  it('作答与判分按时间排好上来（顺序是 tailPasses / lastGrade 的前提）', () => {
    assert.ok(EVIDENCE_SQL.answers.includes('order by a.created_at, a.id'))
    assert.ok(EVIDENCE_SQL.reviews.includes('order by r.created_at, r.id'))
  })

  it('★ 题那一句有两支：这段时间出过的 + 这段时间的作答引用到的', () => {
    assert.ok(EVIDENCE_SQL.questions.includes('q.used_at'))
    assert.ok(
      EVIDENCE_SQL.questions.includes('exists (select 1 from answers a'),
      '★ 少了第二支，按题型看表现时会静默地少掉一批作答'
    )
  })
})
