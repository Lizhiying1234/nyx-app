import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analytics } from './index.ts'
import { DEFAULT_THRESHOLDS, OWN_CALL_MARK } from './thresholds.ts'
import { emptyInput } from './types.ts'
import type { AnswerRow, CaptureRow, EvidenceInput, ItemRow, LookupRow, ReviewRow, WhySentence } from './types.ts'

/**
 * T-4.12 · 「为什么」那几句话。
 *
 * 判据不是「话说得好不好」，而是三件可查的事：
 *   ① 每句都带阈值 + 阈值**来源**（拍的数要标「★ 主控定、可调」）
 *   ② 每句都带得回具体事件行（T-4.11：点开能看到）
 *   ③ 没有事实就没有那句话 —— 空库一句都不出
 */

const DAY = 86_400_000
const NOW = new Date('2026-09-07T20:00:00').getTime()
const RANGE = { from: NOW - 30 * DAY, to: NOW }
const PHONE = '5d0580fd'

const item = (id: number, term: string, over: Partial<ItemRow> = {}): ItemRow => ({
  id,
  term,
  layer: 'B',
  state: 'training',
  createdAt: NOW - 25 * DAY,
  ...over
})

const answer = (id: number, itemId: number, grade: number, at: number): AnswerRow => ({
  id,
  itemId,
  questionId: null,
  grade,
  isFirst: 1,
  durationMs: null,
  device: PHONE,
  at
})

const review = (id: number, itemId: number, grade: number, at: number): ReviewRow => ({
  id,
  itemId,
  line: 'reading',
  grade,
  durationMs: null,
  device: PHONE,
  at
})

const lookup = (id: number, title: string, at: number): LookupRow => ({ id, title, detail: null, at })
const capture = (id: number, itemId: number, title: string, at: number): CaptureRow => ({ id, itemId, title, at })
const input = (over: Partial<EvidenceInput>): EvidenceInput => ({ ...emptyInput(), ...over })

/** 六条规则各有一个真实的由头 */
const rows: EvidenceInput = input({
  items: [
    item(1, 'tangle up'), // 产出挂两次 → 反复失败
    item(2, 'bear the brunt of'), // 收了没练
    item(3, 'ubiquitous'), // 连续三次一次过
    item(4, 'hinge on'), // 20 天前练过，之后没碰
    item(5, 'let bygones be', { state: 'silent' }) // 静默：不算「凉了」
  ],
  lookups: [
    lookup(1, 'serendipity', NOW - 6 * DAY),
    lookup(2, 'Serendipity', NOW - 5 * DAY),
    lookup(3, 'serendipity.', NOW - 4 * DAY),
    lookup(4, 'bear the brunt of', NOW - 3 * DAY),
    // 窗口之外的那个词：查了 3 次，但都在 14 天以前
    lookup(5, 'quixotic', NOW - 25 * DAY),
    lookup(6, 'quixotic', NOW - 24 * DAY),
    lookup(7, 'quixotic', NOW - 23 * DAY)
  ],
  captures: [capture(11, 2, 'bear the brunt of', NOW - 20 * DAY)],
  answers: [
    answer(1, 1, 2, NOW - 9 * DAY),
    answer(2, 1, 1, NOW - 8 * DAY),
    answer(3, 3, 3, NOW - 7 * DAY),
    answer(4, 3, 4, NOW - 6 * DAY),
    answer(5, 3, 3, NOW - 5 * DAY),
    answer(6, 4, 3, NOW - 20 * DAY),
    answer(7, 5, 3, NOW - 20 * DAY)
  ],
  reviews: [review(1, 1, 1, NOW - 2 * DAY)]
})

const view = analytics(rows, RANGE)
const byRule = new Map(view.why.map((w) => [w.rule, w]))
const need = (rule: string): WhySentence => {
  const w = byRule.get(rule)
  assert.ok(w, `少了这条规则：${rule}`)
  return w
}

describe('T-4.12 · 「为什么」', () => {
  it('空库一句话都不出', () => {
    assert.deepEqual(analytics(emptyInput(), RANGE).why, [])
  })

  it('① 查了没收：只数窗口内的查词', () => {
    const w = need('looked-not-captured')
    assert.deepEqual(w.terms, ['serendipity'], '★ quixotic 那三次在 14 天以外，不该算进来')
    assert.match(w.text, /14 天/)
    assert.match(w.text, /3 次/)
    assert.equal(w.refs.length, 3)
    assert.ok(w.refs.every((r) => r.table === 'ops_log'))
  })

  it('② 收了没练：指得出是哪一条、放了多久', () => {
    const w = need('captured-not-practiced')
    assert.deepEqual(w.itemIds, [2])
    assert.match(w.text, /20 天/)
  })

  it('③ 反复失败：两条线的次数分开说', () => {
    const w = need('repeat-fail')
    assert.deepEqual(w.itemIds, [1])
    assert.match(w.text, /产出线第一次判定挂了 2 次/)
    assert.match(w.text, /认读线忘了 1 次/)
    assert.ok(w.source.includes(OWN_CALL_MARK), '★ 这条的阈值是我定的，必须标出来')
  })

  it('④ 稳定通过：用的是判分那个数', () => {
    const w = need('stable')
    assert.deepEqual(w.itemIds, [3])
    assert.equal(w.threshold, `连续 ${DEFAULT_THRESHOLDS.strongStreak} 次`)
  })

  it('⑤ 练过、最近没碰 —— ★ 静默的不算（D-030：不再轮转 ≠ 没学）', () => {
    const w = need('stale')
    assert.deepEqual(w.itemIds, [4], '★ 静默那条被说成「凉了」就是冤枉他')
  })

  it('⑥ 这些事发生在哪台机器上 —— 真库形状：全是手机', () => {
    const w = need('device-origin')
    assert.match(w.text, /全部来自设备 5d0580fd/)
    assert.ok(w.refs.length > 0)
  })

  it('★ 每一句都带阈值 + 来源 + 能点开的行', () => {
    for (const w of view.why) {
      assert.ok(w.text.length > 0, `${w.rule} 没有话`)
      assert.ok(w.threshold.length > 0, `${w.rule} 没写用的哪个阈值`)
      assert.ok(w.source.length > 0, `${w.rule} 没写阈值是谁定的`)
      assert.ok(w.refs.length > 0, `★ ${w.rule} 指不回任何一行事件 —— 他没法核对`)
    }
  })

  it('★ 每句话都是原样印给他看的 —— 不许带 Markdown 记号（星号会露在屏幕上）', () => {
    const TICK = String.fromCharCode(96)
    for (const w of view.why) {
      for (const [k, t] of [['text', w.text], ['threshold', w.threshold], ['source', w.source]]) {
        assert.ok(!t.includes('**'), `${w.rule} 的 ${k} 里有粗体记号：${t}`)
        assert.ok(!t.includes(TICK), `${w.rule} 的 ${k} 里有反引号：${t}`)
      }
    }
  })

  it('句子的顺序 = 规则的顺序（页面按 rule 认位置，不按文案）', () => {
    assert.deepEqual(view.why.map((w) => w.rule), [
      'looked-not-captured',
      'captured-not-practiced',
      'repeat-fail',
      'stable',
      'stale',
      'device-origin'
    ])
  })

  it('一次算完的那份里，「为什么」与各块的名单对得上', () => {
    assert.deepEqual(need('repeat-fail').itemIds, view.weak.map((e) => e.itemId))
    assert.deepEqual(need('stable').itemIds, view.strong.map((e) => e.itemId))
    assert.deepEqual(
      need('captured-not-practiced').itemIds,
      view.funnel.capturedNotPracticed.map((i) => i.itemId)
    )
  })
})
