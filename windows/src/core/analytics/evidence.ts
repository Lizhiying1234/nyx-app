/**
 * 逐条知识点的证据 · T-4.12（2026-09-07）
 *
 * 「这条我做过什么」——只回答这一句，不回答「我学得怎么样」。
 * 后者是「水平判断」——★ D-467（2026-09-07）：那一层**整块取消了**
 * （`MyLevel` 界面 · `assess.ts` · 六条 `level:*` 全删；判层改用固定基线
 * `@core/level-baseline.ts`）。所以现在没有任何东西在回答「我学得怎么样」，
 * 这一层照旧只回答「这条我做过什么」——**别顺手把它补上**。
 *
 * ── 三条不许违反的账 ────────────────────────────────────────
 *
 * ① **两条线分开算**（D-014 / D-085）。产出线只读 `answers`，认读线只读
 *    `review_logs` 里 `line='reading'` 那些。没有一个合成的「正确率」。
 *
 * ② **`review_logs` 里 `line='production'` 那些行不再算一遍。**
 *    产出判分是一次事件写两行：`answers` 一行 + `review_logs`（production）一行
 *    （`main/study/production.ts:659`，同一个 `run` 里）。两边都数就等于
 *    把同一次作答数成两次 —— 真库里 13 条 review_logs 有 7 条是这种，
 *    数错了「他练了多少」当场翻倍，而两处代码各自都说得通。
 *
 * ③ **只认第一次判定**（D-121）。改到过关那几次不是诚实样本；
 *    它们仍然算进 `activity` 的动作量（他确实动了手），但不进任何正确率。
 */

import { normalizeTerm } from '../normalize-term.ts'
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds.ts'
import {
  UNKNOWN_DEVICE,
  type EventRef,
  type EvidenceInput,
  type ItemEvidence,
  type Range
} from './types.ts'

const DAY = 86_400_000

/** 判对 = 第 3、4 档（D-133）。两条线的四档不是一回事，但「≥3 算过」这一条是同一句。 */
export const PASS_GRADE = 3

/** 认读线记一次「忘了」的档位（`sm2-item.ts`：只有第 1 档记 lapse） */
export const LAPSE_GRADE = 1

/** 产出判分同时写进 `review_logs` 的那一行 —— 算证据时要跳过它，见文件头 ② */
export const DUPLICATE_REVIEW_LINE = 'production'

const ref = (table: string, id: number, at: number): EventRef => ({ table, id, at })

/**
 * 按时间排一遍再算。
 *
 * ★ `EVIDENCE_ANSWERS_SQL` 里已经 `order by created_at, id` 了 —— 这里**再排一次**
 *   不是多余：`tailPasses`（末尾连续判对）和 `lastGrade` 完全依赖顺序，
 *   顺序错了不会报错，只会静默地给出一个错的「稳定通过」名单。
 *   靠调用方的自觉，是这个项目最不该有的那种依赖。
 */
const byTime = <T extends { at: number; id: number }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.at - b.at || a.id - b.id)

/**
 * 归一化词面 → 条目 id。
 *
 * ★ 一个词面可能对上**好几条**（重复条目在 T-2.11 合并之前是真实存在的状态）。
 *   这里全都对上，不挑一条：挑一条等于让另一条的查词证据凭空消失，
 *   而他看到的会是「我明明查过它」。漏斗那边按**不同词面**计数，不会因此翻倍。
 */
export function termIndex(items: { id: number; term: string }[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const it of items) {
    const key = normalizeTerm(it.term)
    if (!key) continue
    const cur = out.get(key)
    if (cur) cur.push(it.id)
    else out.set(key, [it.id])
  }
  return out
}

/**
 * 逐条证据。
 *
 * @param input 取数层交上来的原始行（已按范围切好；`items` / `marks` 是状态，不切）
 * @param range 这一段时间；`daysSince` 按 `range.to` 算，同一个范围重算结果才稳定
 */
export function evidence(input: EvidenceInput, range: Range): ItemEvidence[] {
  const byId = new Map<number, ItemEvidence>()
  for (const it of input.items) {
    byId.set(it.id, {
      itemId: it.id,
      term: it.term,
      layer: it.layer,
      state: it.state,
      attempts: 0,
      passes: 0,
      fails: 0,
      firstTryRate: null,
      tailPasses: 0,
      lastGrade: null,
      lastAnswerAt: null,
      reviews: 0,
      lapses: 0,
      lastReviewGrade: null,
      lastReviewAt: null,
      lookups: 0,
      lastLookupAt: null,
      lastAt: null,
      daysSince: null,
      edited: false,
      analysed: false,
      devices: [],
      refs: []
    })
  }

  const devicesOf = new Map<number, Set<string>>()
  const touch = (id: number, device: string | null): Set<string> => {
    let s = devicesOf.get(id)
    if (!s) devicesOf.set(id, (s = new Set()))
    s.add(device ?? UNKNOWN_DEVICE)
    return s
  }

  // ── 产出线：只认第一次判定，且必须真的判过分 ────────────────
  for (const a of byTime(input.answers)) {
    const e = byId.get(a.itemId)
    if (!e) continue
    e.refs.push(ref('answers', a.id, a.at))
    touch(a.itemId, a.device)
    if (a.isFirst !== 1 || a.grade === null) continue
    e.attempts += 1
    if (a.grade >= PASS_GRADE) {
      e.passes += 1
      e.tailPasses += 1
    } else {
      e.fails += 1
      e.tailPasses = 0 // 末尾连续 —— 挂一次就断
    }
    // `answers` 按 created_at 排好上来（`EVIDENCE_ANSWERS_SQL`），所以最后一条就是最近一次
    e.lastGrade = a.grade
    e.lastAnswerAt = a.at
  }

  // ── 认读线 ─────────────────────────────────────────────
  for (const r of byTime(input.reviews)) {
    if (r.line === DUPLICATE_REVIEW_LINE) continue
    const e = byId.get(r.itemId)
    if (!e) continue
    e.refs.push(ref('review_logs', r.id, r.at))
    touch(r.itemId, r.device)
    e.reviews += 1
    if (r.grade === LAPSE_GRADE) e.lapses += 1
    e.lastReviewGrade = r.grade
    e.lastReviewAt = r.at
  }

  // ── 查词：按归一化词面对上条目 ──────────────────────────
  const index = termIndex(input.items)
  for (const l of byTime(input.lookups)) {
    const key = normalizeTerm(l.title ?? '')
    if (!key) continue
    for (const id of index.get(key) ?? []) {
      const e = byId.get(id)
      if (!e) continue
      e.refs.push(ref('ops_log', l.id, l.at))
      e.lookups += 1
      e.lastLookupAt = l.at
    }
  }

  // ── 两个记号 ───────────────────────────────────────────
  for (const m of input.marks) {
    const e = byId.get(m.itemId)
    if (!e) continue
    e.analysed = m.analysed === 1
    e.edited = m.edited > 0
  }

  for (const e of byId.values()) {
    e.firstTryRate = e.attempts === 0 ? null : e.passes / e.attempts
    const last = [e.lastAnswerAt, e.lastReviewAt, e.lastLookupAt].filter(
      (t): t is number => t !== null
    )
    e.lastAt = last.length === 0 ? null : Math.max(...last)
    e.daysSince = e.lastAt === null ? null : Math.floor((range.to - e.lastAt) / DAY)
    e.devices = [...(devicesOf.get(e.itemId) ?? [])].sort()
    e.refs.sort((a, b) => a.at - b.at || a.id - b.id)
  }

  return [...byId.values()]
}

/**
 * 反复失败的那些 —— 「攻坚区之前的信号」。
 *
 * 两条线**各自**数（D-014），任一条挂够次数就上榜；榜上把两个数都显示出来，
 * 页面不许再把它们加成一个「失败数」。
 */
export function weak(
  ev: ItemEvidence[],
  th: Thresholds = DEFAULT_THRESHOLDS,
  n: number = th.topN
): ItemEvidence[] {
  return ev
    .filter((e) => e.fails >= th.weakFails || e.lapses >= th.weakFails)
    .sort(
      (a, b) =>
        b.fails + b.lapses - (a.fails + a.lapses) ||
        (b.lastAt ?? 0) - (a.lastAt ?? 0) ||
        a.itemId - b.itemId
    )
    .slice(0, n)
}

/**
 * 稳定通过的那些。
 *
 * 判据 = 产出线**末尾连续判对** ≥ `strongStreak`，而那个数就是判分用的
 * `silenceStreak`（D-017 / M-023）—— 报告不另立一份「稳」的定义。
 * 认读线的 lapses 不参与筛选（两条线分开），但一起显示：
 * 「产出稳了、认读还在忘」正是这一层最该说出来的那种事。
 */
export function strong(
  ev: ItemEvidence[],
  th: Thresholds = DEFAULT_THRESHOLDS,
  n: number = th.topN
): ItemEvidence[] {
  return ev
    .filter((e) => e.tailPasses >= th.strongStreak)
    .sort((a, b) => b.tailPasses - a.tailPasses || b.attempts - a.attempts || a.itemId - b.itemId)
    .slice(0, n)
}
