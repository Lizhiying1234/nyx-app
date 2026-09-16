/**
 * 查 → 收 → 练 → 过 / 挂 · T-4.12（2026-09-07）
 *
 * 「反复查同一个词」「查了没收」「收了没练」「练了失败」——
 * 归档 d §G 的原话：这是**最便宜也最真**的信号，而且四段全部来自既有的行，
 * 一张新表都不用加。
 *
 * ── 连接键 ──────────────────────────────────────────────────
 *
 *   查（`ops_log op='lookup'`，只有词面）
 *      ↓ `normalizeTerm`（core/normalize-term.ts —— **全项目唯一那把尺**，D-026）
 *   收（`items.term` / `ops_log op='capture'` 的 `target_id`）
 *      ↓ item id
 *   练（`answers` · `review_logs`）→ 过 / 挂（≥3 档 · D-133）
 *
 * ★★ 第一段**必须**归一化。他在气泡里查的是 `Tangle Up`，收进来的是 `tangle up`，
 *    大小写敏感地连一次就断在这里 —— 而断掉的表现不是报错，是**报告说他从没收过这个词**，
 *    然后「查了没收」那一栏里塞满他早就收好的词。`funnel.test.ts` 的负向对照打的就是这里。
 *
 * ★ 「收过、现在不在库里了」单独一档：他删掉 / 清掉一个词是**明确的动作**，
 *   把它算进「查了没收」等于反过来劝他再收一次（D-435 三档删除的语义）。
 */

import { normalizeTerm } from '../normalize-term.ts'
import { PASS_GRADE, termIndex } from './evidence.ts'
import type { EventRef, EvidenceInput, Funnel, FunnelItem, FunnelTerm, ItemEvidence } from './types.ts'

/** 这条最近一次判定（两条线里时间靠后的那一次）。没练过 → null */
export function lastJudgement(e: ItemEvidence): { at: number; grade: number } | null {
  const a =
    e.lastAnswerAt !== null && e.lastGrade !== null ? { at: e.lastAnswerAt, grade: e.lastGrade } : null
  const r =
    e.lastReviewAt !== null && e.lastReviewGrade !== null
      ? { at: e.lastReviewAt, grade: e.lastReviewGrade }
      : null
  if (a && r) return a.at >= r.at ? a : r
  return a ?? r
}

const practiced = (e: ItemEvidence): boolean => e.attempts > 0 || e.reviews > 0

export function funnel(input: EvidenceInput, ev: ItemEvidence[]): Funnel {
  const evById = new Map(ev.map((e) => [e.itemId, e]))
  const index = termIndex(input.items)

  /** 收下那一行：归一化词面 → 最早的那次收下 */
  const capturedAt = new Map<number, number>()
  const capturedTerms = new Set<string>()
  for (const c of input.captures) {
    const key = normalizeTerm(c.title ?? '')
    if (key) capturedTerms.add(key)
    if (c.itemId === null) continue
    const cur = capturedAt.get(c.itemId)
    if (cur === undefined || c.at < cur) capturedAt.set(c.itemId, c.at)
  }

  /** 查词按归一化词面收拢 */
  const looked = new Map<string, { n: number; lastAt: number; refs: EventRef[] }>()
  for (const l of input.lookups) {
    const key = normalizeTerm(l.title ?? '')
    if (!key) continue
    const cur = looked.get(key) ?? { n: 0, lastAt: 0, refs: [] }
    cur.n += 1
    cur.lastAt = Math.max(cur.lastAt, l.at)
    cur.refs.push({ table: 'ops_log', id: l.id, at: l.at })
    looked.set(key, cur)
  }

  const out: Funnel = {
    lookups: input.lookups.length,
    looked: looked.size,
    captured: 0,
    capturedGone: 0,
    practiced: 0,
    passed: 0,
    failed: 0,
    lookedNotCaptured: [],
    capturedNotPracticed: [],
    practicedFailing: []
  }

  for (const [term, seen] of looked) {
    const ids = (index.get(term) ?? []).filter((id) => evById.has(id))
    if (ids.length === 0) {
      // 收过、后来删了 —— 那是他的决定，不劝他再收一次
      if (capturedTerms.has(term)) out.capturedGone += 1
      else out.lookedNotCaptured.push({ term, n: seen.n, lastAt: seen.lastAt, refs: seen.refs })
      continue
    }

    out.captured += 1
    const rows = ids.map((id) => evById.get(id)!)
    const done = rows.filter(practiced)

    for (const e of rows.filter((x) => !practiced(x))) {
      out.capturedNotPracticed.push(item(e, seen, capturedAt))
    }
    if (done.length === 0) continue

    // 同一个词面对上好几条时，「至少练过一条」就算这一段走通了；明细里各条照列
    out.practiced += 1
    /** 这一词面最近的那一次判定说了算 —— 漏斗按词面计数，逐条明细在下面 */
    const last = done
      .map(lastJudgement)
      .filter((j): j is { at: number; grade: number } => j !== null)
      .sort((a, b) => b.at - a.at)[0]
    if (last) {
      if (last.grade >= PASS_GRADE) out.passed += 1
      else out.failed += 1
    }
    for (const e of done) {
      const j = lastJudgement(e)
      if (j && j.grade < PASS_GRADE) out.practicedFailing.push(item(e, seen, capturedAt))
    }
  }

  out.lookedNotCaptured.sort((a, b) => b.n - a.n || b.lastAt - a.lastAt || a.term.localeCompare(b.term))
  out.capturedNotPracticed.sort((a, b) => b.lookups - a.lookups || a.itemId - b.itemId)
  out.practicedFailing.sort((a, b) => b.fails - a.fails || a.itemId - b.itemId)
  return out
}

function item(
  e: ItemEvidence,
  seen: { n: number; refs: EventRef[] },
  capturedAt: Map<number, number>
): FunnelItem {
  return {
    itemId: e.itemId,
    term: e.term,
    lookups: seen.n,
    capturedAt: capturedAt.get(e.itemId) ?? null,
    attempts: e.attempts,
    fails: e.fails + e.lapses,
    lastGrade: lastJudgement(e)?.grade ?? null,
    refs: [...seen.refs, ...e.refs].sort((a, b) => a.at - b.at || a.id - b.id)
  }
}

/** 榜：反复查同一个词（不管收没收）—— 页面上「查词行为」那一块的第一栏 */
export function topLookups(input: EvidenceInput, n = 10): FunnelTerm[] {
  const by = new Map<string, FunnelTerm>()
  for (const l of input.lookups) {
    const term = normalizeTerm(l.title ?? '')
    if (!term) continue
    const cur = by.get(term) ?? { term, n: 0, lastAt: 0, refs: [] }
    cur.n += 1
    cur.lastAt = Math.max(cur.lastAt, l.at)
    cur.refs.push({ table: 'ops_log', id: l.id, at: l.at })
    by.set(term, cur)
  }
  return [...by.values()]
    .sort((a, b) => b.n - a.n || b.lastAt - a.lastAt || a.term.localeCompare(b.term))
    .slice(0, n)
}
