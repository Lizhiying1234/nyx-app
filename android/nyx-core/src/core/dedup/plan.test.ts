import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planMerge, scanDuplicates, type DedupItem, type ItemRows } from './plan.ts'

/**
 * T-2.11 · 合并判据。
 *
 * 这一套里最要紧的是「同层」那一条 —— 去掉它，/[A]/ 理解层和 /[B]/ 写作层
 * 的同一个词会被判成可安全合并，然后**自动**并掉一条真实的学习状态。
 * 它是本轮的负向对照点，所以单独一条用例、断言里写清楚。
 */

const item = (over: Partial<DedupItem> & { uid: string }): DedupItem => ({
  term: 'bear the brunt',
  gloss: '',
  layer: 'A',
  createdAt: 1000,
  answers: 0,
  reviewLogs: 0,
  blocks: [],
  ...over
})

const rows = (over: Partial<ItemRows> = {}): ItemRows => ({
  lectures: [],
  occurrences: [],
  blocks: [],
  card: false,
  answers: 0,
  reviewLogs: 0,
  itemEvents: 0,
  questions: 0,
  stateEvents: 0,
  derived: 0,
  recollected: 0,
  ...over
})

describe('T-2.11 · 分组', () => {
  it('按 normalizeTerm 分组 —— 大小写 / 首尾空白 / 行尾标点不算差异', () => {
    const s = scanDuplicates([
      item({ uid: 'a', term: 'Bear the Brunt' }),
      item({ uid: 'b', term: '  bear the brunt.  ' }),
      item({ uid: 'c', term: 'bear   the   brunt' })
    ])
    assert.equal(s.groups.length, 1, '三条该归成一组')
    assert.equal(s.groups[0].norm, 'bear the brunt')
    assert.equal(s.affected, 3)
  })

  it('只有一条的不算重复；空字面不参与', () => {
    const s = scanDuplicates([
      item({ uid: 'a', term: 'alpha' }),
      item({ uid: 'b', term: 'beta' }),
      item({ uid: 'c', term: '   ' }),
      item({ uid: 'd', term: '  ' })
    ])
    assert.equal(s.groups.length, 0, '★ 空字面被当成一组重复了 —— 那是脏数据不是重复')
  })

  it('不同字面不合并 —— 语义相似这一轮不做', () => {
    const s = scanDuplicates([
      item({ uid: 'a', term: 'bear the brunt' }),
      item({ uid: 'b', term: 'bore the brunt' })
    ])
    assert.equal(s.groups.length, 0)
  })
})

describe('T-2.11 · 分档 Safe / Review', () => {
  it('同层 · 一方 gloss 为空 · 无块冲突 · 被并那条没学习史 → Safe', () => {
    const s = scanDuplicates([
      item({ uid: 'a', gloss: '承受最大冲击', createdAt: 100 }),
      item({ uid: 'b', gloss: '', createdAt: 200 })
    ])
    assert.equal(s.groups[0].bucket, 'safe')
    assert.deepEqual(s.groups[0].reasons, [])
    assert.equal(s.safe, 1)
    assert.equal(s.review, 0)
  })

  it('★★ 跨层 → 必须是 Review，绝不许自动并（本轮的负向对照点）', () => {
    const s = scanDuplicates([
      item({ uid: 'a', layer: 'A', createdAt: 100 }),
      item({ uid: 'b', layer: 'B', createdAt: 200 })
    ])
    assert.equal(
      s.groups[0].bucket,
      'review',
      '★★ 跨层进了 Safe —— 理解层和写作层的同一个词是两种学习状态，自动并掉会丢一种'
    )
    assert.ok(
      s.groups[0].reasons.some((r) => r.includes('层不同')),
      '理由里要说清楚是层不同，否则他看不懂为什么要他来看'
    )
  })

  it('两条都写了释义而且不一样 → Review', () => {
    const s = scanDuplicates([
      item({ uid: 'a', gloss: '承受冲击', createdAt: 100 }),
      item({ uid: 'b', gloss: '首当其冲', createdAt: 200 })
    ])
    assert.equal(s.groups[0].bucket, 'review')
  })

  it('同名分析块内容不同 → Review；内容逐字相同 → 不算冲突', () => {
    const conflict = scanDuplicates([
      item({ uid: 'a', createdAt: 100, blocks: [{ block: 'usage', content: '甲' }] }),
      item({ uid: 'b', createdAt: 200, blocks: [{ block: 'usage', content: '乙' }] })
    ])
    assert.equal(conflict.groups[0].bucket, 'review')

    const same = scanDuplicates([
      item({ uid: 'a', createdAt: 100, blocks: [{ block: 'usage', content: '甲' }] }),
      item({ uid: 'b', createdAt: 200, blocks: [{ block: 'usage', content: '甲' }] })
    ])
    assert.equal(same.groups[0].bucket, 'safe')
  })

  it('被并那条有学习史 → Review（并掉会丢历史）', () => {
    const s = scanDuplicates([
      item({ uid: 'a', createdAt: 100, answers: 5, reviewLogs: 5 }),
      item({ uid: 'b', createdAt: 200, reviewLogs: 1 })
    ])
    assert.equal(s.groups[0].canonical, 'a', '学习史多的那条留下')
    assert.equal(s.groups[0].bucket, 'review')
  })

  it('★ 一组里只要有一条不满足，整组进 Review —— 不做半自动', () => {
    const s = scanDuplicates([
      item({ uid: 'a', createdAt: 100, answers: 3 }),
      item({ uid: 'b', createdAt: 200 }),
      item({ uid: 'c', createdAt: 300, layer: 'B' })
    ])
    assert.equal(s.groups[0].bucket, 'review')
    assert.equal(s.groups[0].losers.length, 2)
  })
})

describe('T-2.11 · 选主', () => {
  it('学习史最多者胜', () => {
    const s = scanDuplicates([
      item({ uid: 'a', createdAt: 100, answers: 1 }),
      item({ uid: 'b', createdAt: 200, answers: 2, reviewLogs: 3 })
    ])
    assert.equal(s.groups[0].canonical, 'b')
  })

  it('学习史平手取最早 created_at', () => {
    const s = scanDuplicates([
      item({ uid: 'late', createdAt: 900 }),
      item({ uid: 'early', createdAt: 100 })
    ])
    assert.equal(s.groups[0].canonical, 'early')
  })

  it('★ 再平手取 uid 字典序 —— 两台设备必须算出同一个主记录', () => {
    const one = scanDuplicates([item({ uid: 'zzz' }), item({ uid: 'aaa' })])
    const other = scanDuplicates([item({ uid: 'aaa' }), item({ uid: 'zzz' })])
    assert.equal(one.groups[0].canonical, 'aaa')
    assert.equal(
      other.groups[0].canonical,
      one.groups[0].canonical,
      '★ 输入顺序换一下就选出不同的主记录 —— 两台各并各的，合出来对不上'
    )
  })
})

describe('T-2.11 · 逐表迁移计划', () => {
  it('自然身份四张表：canonical 缺的新建，已有的留旧行不动', () => {
    const p = planMerge(
      'itm-c',
      'itm-l',
      rows({ lectures: ['lec-1'], occurrences: ['m|mat-1'], blocks: ['usage'], card: true }),
      rows({
        lectures: ['lec-1', 'lec-2'],
        occurrences: ['m|mat-1', 'l|lec-2'],
        blocks: ['usage', 'grammar'],
        card: true
      })
    )
    const at = (t: string, k: string): string | undefined =>
      p.steps.find((s) => 'key' in s && s.table === t && s.key === k)?.kind

    assert.equal(at('item_lectures', 'lec-1'), 'keep')
    assert.equal(at('item_lectures', 'lec-2'), 'create')
    assert.equal(at('occurrences', 'm|mat-1'), 'keep')
    assert.equal(at('occurrences', 'l|lec-2'), 'create')
    assert.equal(at('analysis_blocks', 'usage'), 'keep')
    assert.equal(at('analysis_blocks', 'grammar'), 'create')
    assert.equal(at('reading_cards', 'itm-c'), 'keep', '两边都有卡 → 留 canonical 那张')

    assert.ok(
      !p.steps.some((s) => s.kind === 'repoint' && ['item_lectures', 'occurrences', 'analysis_blocks', 'reading_cards'].includes(s.table)),
      '★★ 自然身份的表绝不许改 FK —— uid 是由 item uid 算出来的，改了正文和身份就对不上'
    )
  })

  it('canonical 没有认读卡而被并那条有 → 在 canonical 名下新建', () => {
    const p = planMerge('itm-c', 'itm-l', rows({ card: false }), rows({ card: true }))
    assert.equal(
      p.steps.find((s) => s.table === 'reading_cards')?.kind,
      'create'
    )
  })

  it('随机身份五处直接改 item_id，含 questions · state_events · derived_from', () => {
    const p = planMerge(
      'itm-c',
      'itm-l',
      rows(),
      rows({ answers: 2, reviewLogs: 3, itemEvents: 4, questions: 5, stateEvents: 6, derived: 7 })
    )
    const n = (t: string): number | undefined =>
      p.steps.find((s) => s.kind === 'repoint' && s.table === t)?.kind === 'repoint'
        ? (p.steps.find((s) => s.table === t) as { rows: number }).rows
        : undefined
    assert.equal(n('answers'), 2)
    assert.equal(n('review_logs'), 3)
    assert.equal(n('item_events'), 4)
    assert.equal(n('questions'), 5, '★ questions 不迁移 → 练习题还挂在回收站里那条上')
    assert.equal(n('state_events'), 6, '★ state_events 不迁移 → 状态流水断在被并那条')
    assert.equal(n('items.derived_from'), 7, '★ 析出项不改父 → 指着一条已经软删的知识点')
  })

  it('recollected_count 相加；没有就不出这一步', () => {
    const some = planMerge('c', 'l', rows(), rows({ recollected: 3 }))
    assert.deepEqual(
      some.steps.find((s) => s.kind === 'add'),
      { kind: 'add', table: 'items', column: 'recollected_count', value: 3 }
    )
    const none = planMerge('c', 'l', rows(), rows())
    assert.ok(!none.steps.some((s) => s.kind === 'add'))
  })

  it('term_ledger 不在任何一步里 —— 它按字面记账，跟 item 无关', () => {
    const p = planMerge('c', 'l', rows(), rows({ answers: 1, recollected: 1 }))
    assert.ok(!p.steps.some((s) => s.table === 'term_ledger'))
  })
})
