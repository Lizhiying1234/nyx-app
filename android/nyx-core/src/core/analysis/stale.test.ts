import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { staleAfterEdit, STALE_EXEMPT_BLOCKS } from './stale.ts'

/**
 * T-7.8 · 「这份解析是照着旧词条写的」。
 *
 * 病的样子：`acceptSuspect` 把词条从 `tangle up` 改成 `tangle with`，
 * `corrections` 里记了一笔，**而解析块一个字没动** —— 屏幕上是一份看起来很完整、
 * 其实在讲另一个词的解析，没有任何提示。
 */

describe('T-7.8 · staleAfterEdit', () => {
  it('改过词条、解析还是改之前那份 → 失效', () => {
    const stale = staleAfterEdit(
      [{ at: 200 }],
      [
        { block: 'meaning', updatedAt: 100 },
        { block: 'chunks', updatedAt: 150 }
      ]
    )
    assert.equal(stale, true)
  })

  it('★ 改完之后重新生成过（哪怕只有一块）→ 不再报失效，别去烦他', () => {
    const stale = staleAfterEdit(
      [{ at: 200 }],
      [
        { block: 'meaning', updatedAt: 100 },
        { block: 'chunks', updatedAt: 300 }
      ]
    )
    assert.equal(stale, false)
  })

  it('从来没改过词条 → 无从谈起', () => {
    assert.equal(staleAfterEdit([], [{ block: 'meaning', updatedAt: 1 }]), false)
  })

  it('压根没有解析 → 也谈不上过时（不该在空白页上挂一个警告）', () => {
    assert.equal(staleAfterEdit([{ at: 200 }], []), false)
  })

  it('多条修正取最近的那一条', () => {
    assert.equal(
      staleAfterEdit([{ at: 50 }, { at: 400 }, { at: 120 }], [{ block: 'meaning', updatedAt: 300 }]),
      true
    )
  })

  it('at 不是数字的那些条目忽略掉，不当成 0 也不当成无穷大', () => {
    assert.equal(
      staleAfterEdit(
        [{ at: undefined }, { at: 400 }] as { at?: number }[],
        [{ block: 'meaning', updatedAt: 300 }]
      ),
      true
    )
  })

  describe('★ T-5.14 · 哪一笔留痕算「改了词」（countsAsTermChange，主控 2026-09-05 裁定的技术规则）', () => {
    it('只改大小写 / 空白 / 尾标点（normalizeTerm 归一后相同）→ 不算改过词条，不报失效', () => {
      const stale = staleAfterEdit(
        [{ field: 'term', was: 'Abandon ', should: 'abandon', at: 200 }],
        [{ block: 'meaning', updatedAt: 100 }]
      )
      assert.equal(stale, false)
    })

    it('改的是 gloss / gloss_zh（field 不是 term）→ 解析讲的仍是同一个词，不报失效', () => {
      const stale = staleAfterEdit(
        [{ field: 'gloss', was: 'to leave', should: 'to give up', at: 200 }],
        [{ block: 'meaning', updatedAt: 100 }]
      )
      assert.equal(stale, false)
    })

    it('真改了词（abandon → abandons）→ 失效；没带 field / was / should 的老留痕照旧算', () => {
      assert.equal(
        staleAfterEdit([{ field: 'term', was: 'abandon', should: 'abandons', at: 200 }], [{ block: 'meaning', updatedAt: 100 }]),
        true
      )
      assert.equal(staleAfterEdit([{ at: 200 }], [{ block: 'meaning', updatedAt: 100 }]), true)
    })

    it('一条不算、一条算 → 按算的那条', () => {
      const stale = staleAfterEdit(
        [
          { field: 'term', was: 'abandon', should: 'abandons', at: 150 },
          { field: 'gloss', was: 'a', should: 'b', at: 400 }
        ],
        [{ block: 'meaning', updatedAt: 300 }]
      )
      assert.equal(stale, false, '150 那条算但早于解析 300；400 那条不算 —— 所以不失效')
    })
  })

  describe('★★ 三个除外的区块（本轮的负向对照点）', () => {
    it('corrections 自己不算 —— 不除外的话这个提示一次都不会出现', () => {
      const stale = staleAfterEdit(
        [{ at: 200 }],
        [
          { block: 'meaning', updatedAt: 100 },
          // acceptSuspect 写这一笔时用的就是同一个时刻
          { block: 'corrections', updatedAt: 200 }
        ]
      )
      assert.equal(
        stale,
        true,
        '★★ corrections 没被除外 —— 它自己的时间戳把判据顶掉了，失效提示永远不会出现'
      )
    })

    it('suspect 不算 —— 接受一条建议的同时会重写它', () => {
      const stale = staleAfterEdit(
        [{ at: 200 }],
        [
          { block: 'meaning', updatedAt: 100 },
          { block: 'suspect', updatedAt: 200 }
        ]
      )
      assert.equal(stale, true)
    })

    it('summary 不算 —— 摘要不属于完整解析（pendingAnalysis 也不认它）', () => {
      const stale = staleAfterEdit(
        [{ at: 200 }],
        [
          { block: 'meaning', updatedAt: 100 },
          { block: 'summary', updatedAt: 999 }
        ]
      )
      assert.equal(stale, true)
    })

    it('名单就是这三个 —— 加减一个都要改这条用例，逼人当场想清楚', () => {
      assert.deepEqual([...STALE_EXEMPT_BLOCKS], ['corrections', 'suspect', 'summary'])
    })
  })
})
