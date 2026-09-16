import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evidence, strong, weak } from './evidence.ts'
import { DEFAULT_THRESHOLDS } from './thresholds.ts'
import { emptyInput, UNKNOWN_DEVICE } from './types.ts'
import type { AnswerRow, EvidenceInput, ItemRow, LookupRow, ReviewRow } from './types.ts'

/**
 * T-4.12 · 逐条证据。
 *
 * 用例形状照**真库**（Windows 副本 2026-09-07）：练习事件全是手机产生的，
 * `review_logs` 13 条里 7 条是产出判分的另一半、6 条是认读，`answers` 8 条。
 * 所以这里最要紧的两条断言是「产出不数两遍」和「设备照抄不猜」。
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
  createdAt: NOW - 20 * DAY,
  ...over
})

const answer = (id: number, itemId: number, grade: number | null, at: number, over: Partial<AnswerRow> = {}): AnswerRow => ({
  id,
  itemId,
  questionId: null,
  grade,
  isFirst: 1,
  durationMs: null,
  device: PHONE,
  at,
  ...over
})

const review = (id: number, itemId: number, grade: number, at: number, over: Partial<ReviewRow> = {}): ReviewRow => ({
  id,
  itemId,
  line: 'reading',
  grade,
  durationMs: null,
  device: PHONE,
  at,
  ...over
})

const lookup = (id: number, title: string, at: number): LookupRow => ({ id, title, detail: null, at })

const input = (over: Partial<EvidenceInput>): EvidenceInput => ({ ...emptyInput(), ...over })

const one = (over: Partial<EvidenceInput>): ReturnType<typeof evidence>[number] =>
  evidence(input({ items: [item(1, 'tangle up')], ...over }), RANGE)[0]!

describe('T-4.12 · 逐条证据', () => {
  it('空库不炸，出空数组', () => {
    assert.deepEqual(evidence(emptyInput(), RANGE), [])
    assert.deepEqual(weak([]), [])
    assert.deepEqual(strong([]), [])
  })

  it('产出线只认第一次判定（D-121）—— 改到过关那几次不进正确率', () => {
    const e = one({
      answers: [
        answer(1, 1, 2, NOW - 5 * DAY),
        answer(2, 1, 4, NOW - 5 * DAY + 1000, { isFirst: 0 }), // 改到过关
        answer(3, 1, 4, NOW - 3 * DAY)
      ]
    })
    assert.equal(e.attempts, 2, '★ 改到过关那次被算进第一次判定了')
    assert.equal(e.passes, 1)
    assert.equal(e.fails, 1)
    assert.equal(e.firstTryRate, 0.5)
    assert.equal(e.lastGrade, 4)
  })

  it('没判分的行（grade 为 null）不算一次判定', () => {
    const e = one({ answers: [answer(1, 1, null, NOW - 2 * DAY)] })
    assert.equal(e.attempts, 0)
    assert.equal(e.firstTryRate, null, '★ 没样本要是 null，不是 0 —— 0 会被读成「全错」')
  })

  it('★★ `review_logs` 里 production 那些行不再数一遍（它和 answers 是同一次事件的两半）', () => {
    const e = one({
      answers: [answer(1, 1, 3, NOW - 4 * DAY)],
      reviews: [
        review(1, 1, 3, NOW - 4 * DAY, { line: 'production' }),
        review(2, 1, 4, NOW - 2 * DAY)
      ]
    })
    assert.equal(e.attempts, 1, '产出线的次数只能来自 answers')
    assert.equal(e.reviews, 1, '★★ 认读次数把产出那一行也数进去了 —— 他练了多少会当场翻倍')
    assert.equal(e.lastReviewGrade, 4)
  })

  it('lapses 只数「忘了」那一档（sm2-item.ts 里只有第 1 档记 lapse）', () => {
    const e = one({
      reviews: [
        review(1, 1, 1, NOW - 6 * DAY),
        review(2, 1, 2, NOW - 5 * DAY),
        review(3, 1, 1, NOW - 4 * DAY)
      ]
    })
    assert.equal(e.reviews, 3)
    assert.equal(e.lapses, 2)
  })

  it('★ 查词按归一化词面对上条目（大小写 / 多余空白 / 尾标点都算同一个词）', () => {
    const e = one({
      lookups: [
        lookup(1, 'Tangle Up', NOW - 9 * DAY),
        lookup(2, '  tangle   up ', NOW - 8 * DAY),
        lookup(3, 'tangle up.', NOW - 7 * DAY),
        lookup(4, 'something else', NOW - 6 * DAY)
      ]
    })
    assert.equal(e.lookups, 3, '★ 归一化没生效 —— 报告会说他从没查过这个词')
    assert.equal(e.lastLookupAt, NOW - 7 * DAY)
  })

  it('同一个词面对上两条（T-2.11 合并之前的真实状态）时，两条都拿到这次查词', () => {
    const ev = evidence(
      input({
        items: [item(1, 'tangle up'), item(2, 'Tangle up')],
        lookups: [lookup(1, 'tangle up', NOW - DAY)]
      }),
      RANGE
    )
    assert.deepEqual(ev.map((e) => e.lookups), [1, 1])
  })

  it('★★ 设备照抄那一行的 device，没有值的落 unknown —— 不按别的行去猜', () => {
    const e = one({
      answers: [answer(1, 1, 3, NOW - 3 * DAY), answer(2, 1, 3, NOW - 2 * DAY, { device: null })]
    })
    assert.deepEqual(e.devices, [PHONE, UNKNOWN_DEVICE].sort())
  })

  it('真库形状：练习事件全部来自手机', () => {
    const e = one({
      answers: [answer(1, 1, 3, NOW - 3 * DAY)],
      reviews: [review(1, 1, 3, NOW - 2 * DAY)]
    })
    assert.deepEqual(e.devices, [PHONE])
  })

  it('daysSince 按范围末端算 —— 同一个范围重算，答案不许变', () => {
    const e = one({ answers: [answer(1, 1, 3, NOW - 3 * DAY - 1000)] })
    assert.equal(e.daysSince, 3)
    const never = one({})
    assert.equal(never.lastAt, null)
    assert.equal(never.daysSince, null)
  })

  it('两个记号来自 marks（已分析 = 复用 NO_FULL_ANALYSIS · 已编辑 = corrections 块）', () => {
    const e = one({ marks: [{ itemId: 1, analysed: 1, edited: 2 }] })
    assert.equal(e.analysed, true)
    assert.equal(e.edited, true)
    const bare = one({ marks: [{ itemId: 1, analysed: 0, edited: 0 }] })
    assert.equal(bare.analysed, false)
    assert.equal(bare.edited, false)
  })

  it('refs 指回具体哪一行（表名 + 行 id），按时间排好', () => {
    const e = one({
      answers: [answer(7, 1, 3, NOW - 2 * DAY)],
      reviews: [review(9, 1, 1, NOW - 3 * DAY)],
      lookups: [lookup(5, 'tangle up', NOW - 4 * DAY)]
    })
    assert.deepEqual(
      e.refs.map((r) => `${r.table}#${r.id}`),
      ['ops_log#5', 'review_logs#9', 'answers#7']
    )
  })

  it('tailPasses：挂一次就断（末尾连续判对）', () => {
    const e = one({
      answers: [
        answer(1, 1, 4, NOW - 6 * DAY),
        answer(2, 1, 4, NOW - 5 * DAY),
        answer(3, 1, 2, NOW - 4 * DAY),
        answer(4, 1, 3, NOW - 3 * DAY)
      ]
    })
    assert.equal(e.tailPasses, 1)
    assert.equal(e.passes, 3)
  })

  it('给的行没排好序也要算对 —— 顺序错了 tailPasses 会静默地错', () => {
    const e = one({
      answers: [answer(3, 1, 2, NOW - 3 * DAY), answer(1, 1, 4, NOW - 5 * DAY), answer(2, 1, 4, NOW - 4 * DAY)]
    })
    assert.equal(e.tailPasses, 0)
    assert.equal(e.lastGrade, 2)
  })
})

describe('T-4.12 · 弱项 / 强项', () => {
  const many: EvidenceInput = input({
    items: [item(1, 'alpha'), item(2, 'beta'), item(3, 'gamma'), item(4, 'delta')],
    answers: [
      // 1：产出挂两次
      answer(1, 1, 2, NOW - 9 * DAY),
      answer(2, 1, 1, NOW - 8 * DAY),
      // 3：连续三次一次过
      answer(3, 3, 3, NOW - 7 * DAY),
      answer(4, 3, 4, NOW - 6 * DAY),
      answer(5, 3, 3, NOW - 5 * DAY),
      // 4：只挂过一次 —— 够不上榜
      answer(6, 4, 2, NOW - 4 * DAY)
    ],
    reviews: [
      // 2：认读忘了两次（产出线一次没练）
      review(1, 2, 1, NOW - 3 * DAY),
      review(2, 2, 1, NOW - 2 * DAY)
    ]
  })
  const ev = evidence(many, RANGE)

  it('反复失败：两条线各自数，任一条挂够次数就上榜（挂得一样多时，最近挂的排前面）', () => {
    assert.deepEqual(weak(ev).map((e) => e.itemId), [2, 1])
    assert.equal(weak(ev)[0]!.lapses, 2, '认读忘了两次的那条')
    assert.equal(weak(ev)[1]!.fails, 2, '产出挂了两次的那条')
  })

  it('只挂过一次的不上榜（阈值 = 2，来源见 THRESHOLD_SOURCES.weakFails）', () => {
    assert.ok(!weak(ev).some((e) => e.itemId === 4))
  })

  it('稳定通过：末尾连续判对 ≥ silenceStreak（与判分同一个数）', () => {
    assert.deepEqual(strong(ev).map((e) => e.itemId), [3])
    assert.equal(DEFAULT_THRESHOLDS.strongStreak, 3)
  })

  it('榜的长度听 topN 的', () => {
    assert.equal(weak(ev, DEFAULT_THRESHOLDS, 1).length, 1)
    assert.equal(weak(ev, DEFAULT_THRESHOLDS, 1)[0]!.itemId, 2)
  })
})
