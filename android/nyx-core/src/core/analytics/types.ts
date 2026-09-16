/**
 * Learning Evidence 的形状 · T-4.12（2026-09-07）
 *
 * 「人做过的事」有多少种，这里就有多少种行 —— **一行都不是造出来的**，
 * 每一种都对着 `core/sql/analytics.ts` 里的一句 select，字段名逐字相同。
 *
 * ★ 两条线永远分开（D-014 / D-085）：产出的「对」是「我写出来了」，
 *   认读的「对」是「我想起来了」。所以下面**没有**一个叫 `correctRate` 的字段 ——
 *   合成一个数什么都说明不了，而且一旦有了这个字段，页面上就一定会有人用它。
 */

/** 一段时间。**左闭右开** `[from, to)`，毫秒。 */
export interface Range {
  from: number
  to: number
}

/** 没有 `device` 的旧行（V35 之前）落这个桶 —— **不猜是哪台**，见 `activity` 头注 */
export const UNKNOWN_DEVICE = 'unknown'

// ── 取数层交上来的原始行（字段名 = SQL 的 alias）────────────

export interface ItemRow {
  id: number
  term: string
  layer: string
  /** `items.production_state` */
  state: string
  createdAt: number
}

export interface MarkRow {
  itemId: number
  /** 0 / 1 —— 有没有写过完整解析（复用 `NO_FULL_ANALYSIS`） */
  analysed: number
  /** `corrections` 块的条数（0 = 他没改过这条） */
  edited: number
}

export interface AnswerRow {
  id: number
  itemId: number
  questionId: number | null
  /** 四档；没判分的（改到过关中途）是 null */
  grade: number | null
  /** 1 = 第一次判定（D-121 只认这一批） */
  isFirst: number
  durationMs: number | null
  device: string | null
  at: number
}

export interface ReviewRow {
  id: number
  itemId: number
  /** `production` | `reading` */
  line: string
  grade: number
  durationMs: number | null
  device: string | null
  at: number
}

export interface QuestionRow {
  id: number
  itemId: number
  type: string
  usedAt: number | null
}

export interface SessionRow {
  id: number
  kind: string
  scope: string
  device: string | null
  startedAt: number
  finishedAt: number | null
}

export interface StateEventRow {
  id: number
  itemId: number
  line: string
  fromState: string | null
  toState: string
  at: number
}

export interface ItemEventRow {
  id: number
  itemId: number
  kind: string
  detail: string
  at: number
}

export interface LectureLogRow {
  id: number
  lectureId: number
  event: string
  detail: string
  at: number
}

export interface LookupRow {
  id: number
  /** 词面。Android 写的时候就是词面本身（`engine/main.ts:235`） */
  title: string | null
  /** 今天是空的；T-4.14 之后是 `{source, face, saved}` —— 本层容得下两种 */
  detail: string | null
  at: number
}

export interface CaptureRow {
  id: number
  /** `ops_log.target_id` = 收下的那条的 item id */
  itemId: number | null
  title: string | null
  at: number
}

/** 取数层一次交上来的全部原始行。`core/sql/analytics.ts::EVIDENCE_SQL` 的 key 与它一一对应。 */
export interface EvidenceInput {
  items: ItemRow[]
  marks: MarkRow[]
  answers: AnswerRow[]
  reviews: ReviewRow[]
  questions: QuestionRow[]
  sessions: SessionRow[]
  stateEvents: StateEventRow[]
  itemEvents: ItemEventRow[]
  lectureLogs: LectureLogRow[]
  lookups: LookupRow[]
  captures: CaptureRow[]
}

/** 空的一份 —— 空库、或者某一段还没取数时用它，**不用 `as` 硬转** */
export function emptyInput(): EvidenceInput {
  return {
    items: [],
    marks: [],
    answers: [],
    reviews: [],
    questions: [],
    sessions: [],
    stateEvents: [],
    itemEvents: [],
    lectureLogs: [],
    lookups: [],
    captures: []
  }
}

// ── 指回去的那根线 ─────────────────────────────────────────

/**
 * 一条证据行的地址。
 *
 * ★ 报告上的每一句话都要能点开看到**具体哪几行**（T-4.11 完成标准）。
 *   所以凡是出结论的地方都带 `refs`：没有 refs 的结论 = 说不出出处的结论，
 *   而说不出出处的结论正是这一层要替掉的东西。
 */
export interface EventRef {
  table: string
  id: number
  at: number
}

// ── 逐条证据 ───────────────────────────────────────────────

export interface ItemEvidence {
  itemId: number
  term: string
  layer: string
  state: string

  // 产出线 · `answers`（只认第一次判定 · D-121）
  /** 第一次判定的次数 */
  attempts: number
  /** 第一次判定里判对（≥3 档 · D-133）的次数 */
  passes: number
  /** 第一次判定里判错的次数 */
  fails: number
  /** `passes / attempts`；没有样本时 null（**不写 0** —— 0 是「全错」，null 是「没练过」） */
  firstTryRate: number | null
  /** 末尾连续判对次数。★ 这是**事件算出来的**，`items.streak` 是状态机算的（含 D-226 宽限），两者不必相等 */
  tailPasses: number
  lastGrade: number | null
  lastAnswerAt: number | null

  // 认读线 · `review_logs`
  reviews: number
  /** 「忘了」的次数（第 1 档 —— `sm2-item.ts` 里只有这一档记 lapse） */
  lapses: number
  lastReviewGrade: number | null
  lastReviewAt: number | null

  // 查词 · `ops_log`
  lookups: number
  lastLookupAt: number | null

  /** 任何一种事件里最近的一次；一次都没有是 null */
  lastAt: number | null
  /** 距 `range.to` 多少天。**按范围末端算**，同一个范围重算结果才稳定 */
  daysSince: number | null

  edited: boolean
  analysed: boolean
  /** 这条的练习事件来自哪几台（`UNKNOWN_DEVICE` = 那行没有 device 列的值） */
  devices: string[]
  refs: EventRef[]
}

// ── 活动 ───────────────────────────────────────────────────

export interface ActivityBucket {
  answers: number
  reviews: number
  lookups: number
  /** 有计时的那些行的时长之和（分钟，一位小数） */
  minutes: number
  /** 上面那个分钟数是几行凑出来的 —— 页面要能说「只算有计时的 N 行」 */
  timed: number
}

export interface DayBucket extends ActivityBucket {
  /** 当天零点（本机时区） */
  at: number
}

export interface HourBucket extends ActivityBucket {
  /** 0–23（本机时区） */
  hour: number
}

export interface DeviceBucket extends ActivityBucket {
  device: string
  sessions: number
}

export interface Activity {
  byDay: DayBucket[]
  byHour: HourBucket[]
  byDevice: DeviceBucket[]
  totals: ActivityBucket & { sessions: number }
}

// ── 周对周 ─────────────────────────────────────────────────

export interface TrendWindow {
  from: number
  to: number
  answers: number
  reviews: number
  lookups: number
  minutes: number
  /** 第一次判定的样本与正确率（`rate` 没样本时 null） */
  firstTry: { n: number; ok: number; rate: number | null }
}

export interface Trend {
  days: number
  current: TrendWindow
  previous: TrendWindow
  /** 上一窗只有一部分落在取数范围里 —— 页面必须标出来，否则「本周翻倍」可能只是上周没取全 */
  partial: boolean
  delta: {
    answers: number
    reviews: number
    lookups: number
    minutes: number
    /** 两窗都有样本才给差值，否则 null */
    firstTryRate: number | null
  }
}

// ── 漏斗 ───────────────────────────────────────────────────

export interface FunnelTerm {
  term: string
  n: number
  lastAt: number
  refs: EventRef[]
}

export interface FunnelItem {
  itemId: number
  term: string
  lookups: number
  capturedAt: number | null
  attempts: number
  fails: number
  lastGrade: number | null
  refs: EventRef[]
}

export interface Funnel {
  /** 查词行数 */
  lookups: number
  /** 查过的**不同**词数（归一化之后） */
  looked: number
  /** 其中已经在库里、还活着的 */
  captured: number
  /** 收过、现在不在库里了（删了 / 清了）—— 不算「没收」 */
  capturedGone: number
  /** 收进来的这些里，练过的（产出或认读任一） */
  practiced: number
  /** 练过的里，最后一次判定 ≥3 档 */
  passed: number
  failed: number
  lookedNotCaptured: FunnelTerm[]
  capturedNotPracticed: FunnelItem[]
  practicedFailing: FunnelItem[]
}

// ── 表现（按层级 / 题型 / 档位）· T-4.11 ───────────────────

export interface PerformanceCell {
  /** 层级（`A` / `B`）· 题型 key · 档位（`'1'`…）；对不上的是 `unknown` */
  key: string
  /** 判定次数（同一条练三次算三次） */
  attempts: number
  passes: number
  /** 没样本时 null（**不是 0**） */
  rate: number | null
  refs: EventRef[]
}

export interface Performance {
  /** 产出线 · `answers` 里的第一次判定（D-121） */
  production: { byLayer: PerformanceCell[]; byType: PerformanceCell[] }
  /** 认读线 · `review_logs` 里 `line='reading'` 那些。★ 认读卡不出题，所以没有按题型 */
  reading: { byLayer: PerformanceCell[] }
}

// ── 知识点变化 · T-4.11 ────────────────────────────────────

export interface Changes {
  /** 产出线状态跳变（`from → to` 各几次）· `state_events` */
  transitions: { from: string; to: string; n: number; refs: EventRef[] }[]
  /** 这段时间发生过几次分析、分别来自哪 · `item_events` 的 `kind='analyzed'` */
  analysed: { total: number; byOrigin: { origin: string; n: number }[]; refs: EventRef[] }
  /** 讲次结算过几次 · `lecture_logs` */
  lectureRuns: { n: number; refs: EventRef[] }
}

// ── 「为什么」 ─────────────────────────────────────────────

export interface WhySentence {
  /** 规则 id（页面按它认位置，不按文案） */
  rule: string
  /** 一句话 */
  text: string
  /** 这条规则用的阈值本身 */
  threshold: string
  /** ★ 阈值**来源**。不是从决议 / 使用者原话来的，必须标「★ 主控定、可调」 */
  source: string
  itemIds: number[]
  terms: string[]
  refs: EventRef[]
}

// ── 一次算完 ───────────────────────────────────────────────

export interface AnalyticsView {
  range: Range
  evidence: ItemEvidence[]
  weak: ItemEvidence[]
  strong: ItemEvidence[]
  activity: Activity
  trend: Trend
  funnel: Funnel
  /** 查词榜（反复查同一个词）—— 报告「查词行为」块的第一栏 */
  topLookups: FunnelTerm[]
  performance: Performance
  changes: Changes
  why: WhySentence[]
}
