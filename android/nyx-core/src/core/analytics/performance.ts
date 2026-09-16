/**
 * 认读 / 产出表现 —— 按层级 · 按题型 · 按档位 · T-4.11（2026-09-07）
 *
 * 报告页那一块要回答的是「**我在哪一类上更吃力**」，
 * 而不是「我总体正确率多少」（那个数上面②已经有了，再出一次只会打架）。
 *
 * ── 三条与别处一致的账 ──────────────────────────────────────
 *
 * ① **两条线各出各的**（D-014 / D-085）：产出读 `answers`（只认第一次判定 · D-121），
 *    认读读 `review_logs` 里 `line='reading'` 那些。没有一个合起来的数。
 * ② **题型 / 档位只有产出线有** —— 认读卡不出题（`questions` 是产出线的表），
 *    给认读也画一张「按题型」的图就是凭空造指标。
 * ③ 分母是**判定次数**，不是知识点条数：同一条练三次算三次。
 *    每一格都带 `refs`，点开就是那几行 `answers` / `review_logs`。
 *
 * 没有样本的那一格 `rate` 是 `null`（**不是 0**）—— 0 会被读成「全错」。
 */

import { DUPLICATE_REVIEW_LINE, PASS_GRADE } from './evidence.ts'
import type { EventRef, EvidenceInput, ItemRow, Performance, PerformanceCell } from './types.ts'

/** 一格的累加器 */
class Cell {
  attempts = 0
  passes = 0
  refs: EventRef[] = []
  add(pass: boolean, ref: EventRef): void {
    this.attempts += 1
    if (pass) this.passes += 1
    this.refs.push(ref)
  }
}

function cells(map: Map<string, Cell>): PerformanceCell[] {
  return [...map.entries()]
    .map(([key, c]) => ({
      key,
      attempts: c.attempts,
      passes: c.passes,
      rate: c.attempts === 0 ? null : c.passes / c.attempts,
      refs: c.refs
    }))
    .sort((a, b) => b.attempts - a.attempts || a.key.localeCompare(b.key))
}

const bump = (m: Map<string, Cell>, key: string): Cell => {
  let c = m.get(key)
  if (!c) m.set(key, (c = new Cell()))
  return c
}

/** 题目找不到的时候用它 —— **不猜题型**，单列一格，让页面自己说「这批没有题的记录」 */
export const UNKNOWN_KEY = 'unknown'

export function performance(input: EvidenceInput): Performance {
  const layerOf = new Map<number, string>(input.items.map((i: ItemRow) => [i.id, i.layer]))
  const qById = new Map(input.questions.map((q) => [q.id, q]))

  const pLayer = new Map<string, Cell>()
  const pType = new Map<string, Cell>()
  const rLayer = new Map<string, Cell>()

  for (const a of input.answers) {
    if (a.isFirst !== 1 || a.grade === null) continue // D-121
    const pass = a.grade >= PASS_GRADE
    const ref: EventRef = { table: 'answers', id: a.id, at: a.at }
    bump(pLayer, layerOf.get(a.itemId) ?? UNKNOWN_KEY).add(pass, ref)
    const q = a.questionId === null ? undefined : qById.get(a.questionId)
    bump(pType, q?.type ?? UNKNOWN_KEY).add(pass, ref)
  }

  for (const r of input.reviews) {
    if (r.line === DUPLICATE_REVIEW_LINE) continue // 产出那一半在 answers 里算过了
    bump(rLayer, layerOf.get(r.itemId) ?? UNKNOWN_KEY).add(r.grade >= PASS_GRADE, {
      table: 'review_logs',
      id: r.id,
      at: r.at
    })
  }

  return {
    production: { byLayer: cells(pLayer), byType: cells(pType) },
    reading: { byLayer: cells(rLayer) }
  }
}
