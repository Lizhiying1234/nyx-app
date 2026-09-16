/**
 * 「为什么」—— 规则化的一句话 · T-4.12（2026-09-07）
 *
 * ── 这一层**不许**做的事 ────────────────────────────────────
 *
 * 不叫 AI 写报告文字（归档 d §K 明写「不做 AI 生成的报告文字」），
 * 不给建议、不下判断、不说「你应该」。它只把已经算出来的证据
 * 翻成一句他看得懂的话，每一句都带着：
 *   · `threshold` —— 用的是哪个数
 *   · `source`    —— 那个数**谁定的**（不是决议 / 原话来的，必须标「★ 主控定、可调」）
 *   · `refs`      —— 指回具体是哪几行事件（T-4.11：点开能看到）
 *
 * 少了后面三样，这一栏就退化成「软件说了句听起来很像结论的话」，
 * 而他没有任何办法核对。这个项目里那种话一句都不该有。
 *
 * ── 规则清单（六条，顺序即页面顺序）────────────────────────
 *
 *   ① looked-not-captured    查了没收
 *   ② captured-not-practiced 收了没练
 *   ③ repeat-fail            反复失败
 *   ④ stable                 稳定通过
 *   ⑤ stale                  练过、最近没碰
 *   ⑥ device-origin          这些事发生在哪台机器上
 */

import { SILENCE_FILTER_NAME } from '../silence.ts'
import { DUPLICATE_REVIEW_LINE } from './evidence.ts'
import { normalizeTerm } from '../normalize-term.ts'
import { DEFAULT_THRESHOLDS, THRESHOLD_SOURCES, type Thresholds } from './thresholds.ts'
import {
  UNKNOWN_DEVICE,
  type Activity,
  type EventRef,
  type EvidenceInput,
  type Funnel,
  type ItemEvidence,
  type Range,
  type WhySentence
} from './types.ts'

const DAY = 86_400_000

/**
 * 没有阈值的那几句（纯事实陈述）标这个，免得 `source` 空着。
 *
 * ★ 本文件里凡是进 `text` / `threshold` / `source` 的字符串，都是**原样印给他看的**：
 *   不许写 Markdown 记号（星号粗体、反引号）—— 报告页不解析它们，星号会露在屏幕上。
 *   `why.test.ts` 有一条机器判据守着（截图上真露过一次）。
 */
export const PLAIN_FACT = '无阈值 · 事实陈述'

export interface WhyView {
  range: Range
  evidence: ItemEvidence[]
  weak: ItemEvidence[]
  strong: ItemEvidence[]
  funnel: Funnel
  activity: Activity
}

/**
 * 设备 id 是一串十六进制，直接印出来他看不懂 —— 至少说清哪一类。
 * ★ 导出给报告页用（T-4.11）：页面上那一行与这句话里的说法必须一样，
 *   各写一份的话「全部来自设备 5d0580fd」和列表里的「本机」会自相矛盾。
 */
export const deviceName = (d: string): string =>
  d === UNKNOWN_DEVICE ? '没有记设备的旧行' : `设备 ${d.slice(0, 8)}`

export function why(
  input: EvidenceInput,
  view: WhyView,
  th: Thresholds = DEFAULT_THRESHOLDS
): WhySentence[] {
  const out: WhySentence[] = []
  const winFrom = view.range.to - th.windowDays * DAY

  // ── ① 查了没收 ───────────────────────────────────────────
  // 窗口内重新数一遍（`funnel` 算的是整个范围）—— 「两周内查过 3 次」里的两周就是这里
  const recent = new Map<string, EventRef[]>()
  for (const l of input.lookups) {
    if (l.at < winFrom) continue
    const term = normalizeTerm(l.title ?? '')
    if (!term) continue
    const cur = recent.get(term) ?? []
    cur.push({ table: 'ops_log', id: l.id, at: l.at })
    recent.set(term, cur)
  }
  const uncaptured = new Set(view.funnel.lookedNotCaptured.map((t) => t.term))
  const hot = [...recent.entries()]
    .filter(([term, refs]) => uncaptured.has(term) && refs.length >= th.lookupRepeats)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  if (hot.length > 0) {
    out.push({
      rule: 'looked-not-captured',
      text: `最近 ${th.windowDays} 天里，有 ${hot.length} 个词查过 ${th.lookupRepeats} 次以上，一次都没收进来`,
      threshold: `${th.lookupRepeats} 次 / ${th.windowDays} 天`,
      source: `${THRESHOLD_SOURCES.lookupRepeats}；窗口：${THRESHOLD_SOURCES.windowDays}`,
      itemIds: [],
      terms: hot.slice(0, th.topN).map(([term]) => term),
      refs: hot.flatMap(([, refs]) => refs)
    })
  }

  // ── ② 收了没练 ───────────────────────────────────────────
  const idle = view.funnel.capturedNotPracticed
  if (idle.length > 0) {
    const oldest = Math.max(
      ...idle.map((i) =>
        i.capturedAt === null ? 0 : Math.floor((view.range.to - i.capturedAt) / DAY)
      )
    )
    out.push({
      rule: 'captured-not-practiced',
      text:
        `有 ${idle.length} 条查过、也收进来了，之后一次都没练过` +
        (oldest > 0 ? `（最久的一条收下已经 ${oldest} 天）` : ''),
      threshold: '一次都没有（不设阈值）',
      source: PLAIN_FACT,
      itemIds: idle.map((i) => i.itemId),
      terms: idle.map((i) => i.term),
      refs: idle.flatMap((i) => i.refs)
    })
  }

  // ── ③ 反复失败 ───────────────────────────────────────────
  if (view.weak.length > 0) {
    const fails = view.weak.reduce((n, e) => n + e.fails, 0)
    const lapses = view.weak.reduce((n, e) => n + e.lapses, 0)
    out.push({
      rule: 'repeat-fail',
      text: `有 ${view.weak.length} 条反复挂：产出线第一次判定挂了 ${fails} 次，认读线忘了 ${lapses} 次`,
      threshold: `挂过 ${th.weakFails} 次以上（两条线各自数）`,
      source: THRESHOLD_SOURCES.weakFails,
      itemIds: view.weak.map((e) => e.itemId),
      terms: view.weak.map((e) => e.term),
      refs: view.weak.flatMap((e) => e.refs)
    })
  }

  // ── ④ 稳定通过 ───────────────────────────────────────────
  if (view.strong.length > 0) {
    out.push({
      rule: 'stable',
      text: `有 ${view.strong.length} 条已经连续 ${th.strongStreak} 次一次过`,
      threshold: `连续 ${th.strongStreak} 次`,
      source: THRESHOLD_SOURCES.strongStreak,
      itemIds: view.strong.map((e) => e.itemId),
      terms: view.strong.map((e) => e.term),
      refs: view.strong.flatMap((e) => e.refs)
    })
  }

  // ── ⑤ 练过、最近没碰 ────────────────────────────────────
  // 静默的不算：静默是「不再轮转」的正常归宿（D-030），把它说成「凉了」是冤枉他
  const cold = view.evidence
    .filter(
      (e) =>
        e.state !== 'silent' &&
        (e.attempts > 0 || e.reviews > 0) &&
        e.daysSince !== null &&
        e.daysSince >= th.windowDays
    )
    .sort((a, b) => (b.daysSince ?? 0) - (a.daysSince ?? 0) || a.itemId - b.itemId)
  if (cold.length > 0) {
    out.push({
      rule: 'stale',
      text:
        `有 ${cold.length} 条练过、最近 ${th.windowDays} 天一次都没碰` +
        `（${SILENCE_FILTER_NAME}的不算在内）`,
      threshold: `${th.windowDays} 天`,
      source: THRESHOLD_SOURCES.windowDays,
      itemIds: cold.map((e) => e.itemId),
      terms: cold.map((e) => e.term),
      refs: cold.flatMap((e) => e.refs)
    })
  }

  // ── ⑥ 这些事发生在哪台机器上 ────────────────────────────
  const acted = view.activity.byDevice.filter((d) => d.answers + d.reviews > 0)
  if (acted.length > 0) {
    const n = acted.reduce((s, d) => s + d.answers + d.reviews, 0)
    const text =
      acted.length === 1
        ? `这段时间的 ${n} 次练习事件全部来自${deviceName(acted[0]!.device)}`
        : `这段时间的 ${n} 次练习事件来自 ${acted.length} 处：` +
          acted.map((d) => `${deviceName(d.device)} ${d.answers + d.reviews} 次`).join(' · ')
    out.push({
      rule: 'device-origin',
      text,
      threshold: '照 device 列原样分（没有值的不猜）',
      source: PLAIN_FACT,
      itemIds: [],
      terms: [],
      refs: refsOfDevices(input, new Set(acted.map((d) => d.device)))
    })
  }

  return out
}

/** ⑥ 那句话背后的行 —— 让「全部来自手机」也点得开 */
function refsOfDevices(input: EvidenceInput, want: Set<string>): EventRef[] {
  const out: EventRef[] = []
  for (const a of input.answers) {
    if (want.has(a.device ?? UNKNOWN_DEVICE)) out.push({ table: 'answers', id: a.id, at: a.at })
  }
  for (const r of input.reviews) {
    if (r.line === DUPLICATE_REVIEW_LINE) continue
    if (want.has(r.device ?? UNKNOWN_DEVICE)) out.push({ table: 'review_logs', id: r.id, at: r.at })
  }
  return out.sort((a, b) => a.at - b.at || a.id - b.id)
}
