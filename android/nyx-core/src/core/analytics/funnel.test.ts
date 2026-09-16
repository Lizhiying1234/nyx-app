import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evidence } from './evidence.ts'
import { funnel, lastJudgement, topLookups } from './funnel.ts'
import { emptyInput } from './types.ts'
import type { AnswerRow, CaptureRow, EvidenceInput, ItemRow, LookupRow, ReviewRow } from './types.ts'

/**
 * T-4.12 · 查 → 收 → 练 → 过 / 挂。
 *
 * ★★ 这一套的核心是**第一段的连接键**：查词那行只有词面，收下那行有 item id。
 *    两边不按 `normalizeTerm` 对，报告就会说他从没收过自己明明收过的词。
 *    负向对照打的就是这里（把连接改成大小写敏感 → 下面第三条当场红）。
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
const capture = (id: number, itemId: number | null, title: string, at: number): CaptureRow => ({ id, itemId, title, at })

const input = (over: Partial<EvidenceInput>): EvidenceInput => ({ ...emptyInput(), ...over })

/** 五个词：练过过了 · 收了没练 · 练了挂 · 查了没收 · 收过又删了 */
const rows: EvidenceInput = input({
  items: [item(1, 'tangle up'), item(2, 'bear the brunt of'), item(3, 'ubiquitous', { layer: 'A' })],
  lookups: [
    lookup(1, 'Tangle Up', NOW - 12 * DAY),
    lookup(2, 'tangle up ', NOW - 11 * DAY),
    lookup(3, 'bear the brunt of', NOW - 10 * DAY),
    lookup(4, 'Ubiquitous.', NOW - 9 * DAY),
    lookup(5, 'serendipity', NOW - 8 * DAY),
    lookup(6, 'Serendipity', NOW - 7 * DAY),
    lookup(7, 'serendipity', NOW - 6 * DAY),
    lookup(8, 'gone word', NOW - 5 * DAY)
  ],
  captures: [
    capture(11, 1, 'tangle up', NOW - 12 * DAY + 1000),
    capture(12, 2, 'bear the brunt of', NOW - 10 * DAY + 1000),
    capture(13, 3, 'ubiquitous', NOW - 9 * DAY + 1000),
    capture(14, 99, 'gone word', NOW - 5 * DAY + 1000)
  ],
  answers: [answer(1, 1, 4, NOW - 4 * DAY), answer(2, 3, 2, NOW - 4 * DAY)],
  reviews: [review(1, 3, 1, NOW - 3 * DAY)]
})

const view = funnel(rows, evidence(rows, RANGE))

describe('T-4.12 · 漏斗', () => {
  it('空库不炸，四段全是 0', () => {
    const f = funnel(emptyInput(), [])
    assert.equal(f.lookups, 0)
    assert.equal(f.looked, 0)
    assert.equal(f.captured, 0)
    assert.equal(f.practiced, 0)
    assert.deepEqual(f.lookedNotCaptured, [])
  })

  it('四段的数：查 8 行 / 5 个词 → 收 3 → 练 2 → 过 1 挂 1', () => {
    assert.equal(view.lookups, 8)
    assert.equal(view.looked, 5)
    assert.equal(view.captured, 3)
    assert.equal(view.practiced, 2)
    assert.equal(view.passed, 1)
    assert.equal(view.failed, 1)
  })

  it('★★ 查与收按归一化词面连（大小写 / 空白 / 尾标点都不该断）', () => {
    assert.equal(view.captured, 3, '★★ 连接键漂了 —— 报告会说他从没收过这几个词')
    assert.deepEqual(view.lookedNotCaptured.map((t) => t.term), ['serendipity'])
  })

  it('查了没收：按查的次数排，带着那几行的地址', () => {
    const top = view.lookedNotCaptured[0]!
    assert.equal(top.n, 3)
    assert.equal(top.lastAt, NOW - 6 * DAY)
    assert.deepEqual(top.refs.map((r) => `${r.table}#${r.id}`), ['ops_log#5', 'ops_log#6', 'ops_log#7'])
  })

  it('★ 收过、后来删了的不算「查了没收」—— 删是他的决定（D-435）', () => {
    assert.equal(view.capturedGone, 1)
    assert.ok(!view.lookedNotCaptured.some((t) => t.term === 'gone word'))
  })

  it('收了没练：列出条目，带收下时间', () => {
    assert.deepEqual(view.capturedNotPracticed.map((i) => i.itemId), [2])
    assert.equal(view.capturedNotPracticed[0]!.capturedAt, NOW - 10 * DAY + 1000)
    assert.equal(view.capturedNotPracticed[0]!.lookups, 1)
  })

  it('练了还挂：最后一次判定说了算（两条线里时间靠后的那次）', () => {
    assert.deepEqual(view.practicedFailing.map((i) => i.itemId), [3])
    assert.equal(view.practicedFailing[0]!.lastGrade, 1, '认读那次比产出那次晚，该由它说了算')
    assert.equal(view.practicedFailing[0]!.fails, 2, '产出挂 1 次 + 认读忘 1 次')
  })

  it('明细里的 refs 把查词行和练习行都带上（点开能看到）', () => {
    const tables = new Set(view.practicedFailing[0]!.refs.map((r) => r.table))
    assert.deepEqual([...tables].sort(), ['answers', 'ops_log', 'review_logs'])
  })

  it('lastJudgement：一次没练过是 null', () => {
    const ev = evidence(rows, RANGE)
    assert.equal(lastJudgement(ev.find((e) => e.itemId === 2)!), null)
    assert.equal(lastJudgement(ev.find((e) => e.itemId === 1)!)!.grade, 4)
  })

  it('查词榜按归一化后的词面数（Serendipity 与 serendipity 是一个词）', () => {
    const top = topLookups(rows, 3)
    assert.equal(top[0]!.term, 'serendipity')
    assert.equal(top[0]!.n, 3)
    assert.equal(top[1]!.term, 'tangle up')
    assert.equal(top[1]!.n, 2)
    assert.equal(top.length, 3)
  })
})
