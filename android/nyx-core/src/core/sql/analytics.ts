/**
 * Learning Evidence 的**取数判据** · T-4.12（2026-09-07）
 *
 * 和 `core/sql/analysis.ts` · `core/sql/silence.ts` 同一个形状、同一条理由：
 * 判据只有一份，SQL 只是它的翻译。
 *
 * ```
 * Domain（这一句话）        「人做过的事，只从既有事件表里读，一个数都不新造」
 *         ↓ 翻译
 * SQL（本文件）             EVIDENCE_SQL 的十一句 select（全是只读）
 *         ↓ 喂给
 * 纯函数（core/analytics/） evidence · activity · funnel · weak / strong · trend · why
 *         ↓ 消费
 * Windows: main/analytics.ts → 分析报告独立页（T-4.11）
 * Android: 不显示（D-348）—— 判据仍放 core，将来「我」页那两个数从同一份算
 * ```
 *
 * ── 三个概念不许混（归档 d §K）─────────────────────────────
 *
 *   · **Knowledge Analysis** = `analysis_blocks`，AI 对**词**写的解析
 *   · **Learning Evidence**  = 本文件读的这些，**人做过的事**
 *   · **水平判断**           = 两者合成的判断 —— D-467 起**不存在**（本层照旧不碰）
 *
 * 混了的后果很具体：「他学得怎么样」被 AI 写的解析块数量顶替，
 * 而那是**软件替他做的事**，不是他做的事。
 *
 * ── 边界（十二问 12 · 十三）────────────────────────────────
 *
 * **不加表、不加列、不动同步指纹。** 本文件一句 insert / update 都没有，
 * 也没有一句 `delete`（D-436）。要新指标先问「哪张事件表里已经有这一行」，
 * 答不上来就是还不能做 —— 这一层的价值全在「每个数字都能指回一行」。
 *
 * ── 列名一律 alias 成 camelCase ────────────────────────────
 *
 * 取数层（`main/analytics.ts`）因此只是 `db.prepare(SQL).all(...)`，
 * 中间**没有一层手写映射**。手写映射是判据漂移最爱走的那道门：
 * SQL 改了列、映射没跟上，类型系统在这一层是瞎的（I-112 的教训）。
 */

import { NO_FULL_ANALYSIS } from './analysis.ts'

/** 查词那一行的 `op`（Android `engine/main.ts:235` 写的，随同步回电脑） */
export const LOOKUP_OP = 'lookup'
/** 收下那一行的 `op` / `target`（Android `db/capture.ts:336`：`target_id` = item id） */
export const CAPTURE_OP = 'capture'
export const CAPTURE_TARGET = 'item'

/**
 * 证据源 = 这八张事件表。
 *
 * ★ 报告页上每一个数字都要能指回其中一张（T-4.11 完成标准），
 *   所以这个名单本身就是契约：多一张少一张都要先说得出理由。
 */
export const EVIDENCE_TABLES = [
  'review_logs',
  'answers',
  'questions',
  'sessions',
  'state_events',
  'item_events',
  'lecture_logs',
  'ops_log'
] as const

export type EvidenceTable = (typeof EVIDENCE_TABLES)[number]

/**
 * 时间窗。**左闭右开** —— 和 `main/report.ts` 的 `[from, to)` 一致，
 * 否则同一天的行会在两个范围里各算一次。
 */
export const IN_RANGE = (col: string): string => `${col} >= ? and ${col} < ?`

// ── 状态（不是事件，但逐条证据要靠它认人）──────────────────

/**
 * 活着的条目。**参数：无。**
 *
 * 逐条证据只对活着的条目出行；已删的条目的事件仍然算进 `activity` 的总量
 * （他确实做过那些事），只是不再单列一行 —— 单列一行等于在报告里
 * 复活一条他删掉的知识点。
 */
export const EVIDENCE_ITEMS_SQL = `select i.id            as id,
              i.term          as term,
              i.layer         as layer,
              i.production_state as state,
              i.created_at    as createdAt
         from items i
        where i.deleted_at is null`

/**
 * 逐条的两个记号。**参数：无。**
 *
 * · `analysed` —— **复用** `NO_FULL_ANALYSIS`（`core/sql/analysis.ts`）的反面。
 *   「有没有写过完整解析」这句判据全项目只有那一份，报告不许自己再写一遍：
 *   写第二遍的代价是「待分析 12 条」和报告里的「已分析」互相对不上，而两处都说得通。
 * · `edited`  —— `analysis_blocks` 里有没有 `corrections` 那一块（T-5.14 的留痕）。
 *   「他亲手改过这条」是证据的一种（归档 d §M）。
 */
export const EVIDENCE_MARKS_SQL = `select i.id as itemId,
              case when ${NO_FULL_ANALYSIS('i')} then 0 else 1 end as analysed,
              (select count(*) from analysis_blocks b
                where b.item_id = i.id and b.block = 'corrections') as edited
         from items i
        where i.deleted_at is null`

// ── 事件（八张表）──────────────────────────────────────────

/**
 * ① `answers` —— 每一次作答。**参数：from · to。**
 *
 * `is_first` 一起取出来，让纯函数自己按 D-121 只认第一次判定；
 * SQL 里**不**先过滤掉改到过关那些行 —— 「他改了几次才过」也是证据，
 * 只是不能混进正确率（`main/report.ts::accuracy` 头注同款理由）。
 * `question_id` 带上，才能按题型看表现（T-4.11 的「认读 / 产出表现」块）。
 */
export const EVIDENCE_ANSWERS_SQL = `select a.id          as id,
              a.item_id     as itemId,
              a.question_id as questionId,
              a.grade       as grade,
              a.is_first    as isFirst,
              a.duration_ms as durationMs,
              a.device      as device,
              a.created_at  as at
         from answers a
        where ${IN_RANGE('a.created_at')}
        order by a.created_at, a.id`

/**
 * ② `review_logs` —— 每一次判分（两条线都写这张）。**参数：from · to。**
 *
 * `line` 必须取：产出的「对」是「我写出来了」，认读的「对」是「我想起来了」，
 * 合成一个数什么都说明不了（D-085 / D-014）。纯函数按 `line` 分开算。
 */
export const EVIDENCE_REVIEWS_SQL = `select r.id          as id,
              r.item_id     as itemId,
              r.line        as line,
              r.grade       as grade,
              r.duration_ms as durationMs,
              r.device      as device,
              r.created_at  as at
         from review_logs r
        where ${IN_RANGE('r.created_at')}
        order by r.created_at, r.id`

/**
 * ③ `questions` —— 题。**参数：from · to · from · to。**
 *
 * 两支：这段时间**出过**的题（`used_at`），加上这段时间的作答**引用到**的题
 * （题可能是上一轮出的，答却答在这一轮）。少了第二支，按题型看表现时
 * 会有一批作答找不到自己的题，静默地少掉 —— 而页面上只会显示一个偏小的数。
 */
export const EVIDENCE_QUESTIONS_SQL = `select q.id      as id,
              q.item_id as itemId,
              q.type    as type,
              q.used_at as usedAt
         from questions q
        where ${IN_RANGE('q.used_at')}
           or exists (select 1 from answers a
                       where a.question_id = q.id and ${IN_RANGE('a.created_at')})`

/**
 * ④ `sessions` —— 一场练习。**参数：from · to。**
 *
 * 按 `started_at` 切窗（一场跨零点的练习算在它开始的那天），
 * `finished_at` 可能为 null（没结算完就退出）—— 纯函数按 null 处理，不猜。
 */
export const EVIDENCE_SESSIONS_SQL = `select s.id          as id,
              s.kind        as kind,
              s.scope       as scope,
              s.device      as device,
              s.started_at  as startedAt,
              s.finished_at as finishedAt
         from sessions s
        where ${IN_RANGE('s.started_at')}
        order by s.started_at, s.id`

/**
 * ⑤ `state_events` —— 产出线的状态跳变。**参数：from · to。**
 * 报告的「知识点变化」块（T-4.11）读它；`main/report.ts` 的①③也读它，
 * 但那两块算的是别的东西（逐日回放 / 攻坚区净值），这里只出原始行。
 */
export const EVIDENCE_STATE_EVENTS_SQL = `select e.id         as id,
              e.item_id    as itemId,
              e.line       as line,
              e.from_state as fromState,
              e.to_state   as toState,
              e.created_at as at
         from state_events e
        where ${IN_RANGE('e.created_at')}
        order by e.created_at, e.id`

/**
 * ⑥ `item_events` —— 分析 / 留痕。**参数：from · to。**
 * 真库里 8 行全是手机写的 `kind='analyzed'`（`detail` 里 `origin: android`）——
 * 所以「分析过几次」不能只看这张表（Windows 分析不写它），逐条的「已分析」
 * 记号走 `EVIDENCE_MARKS_SQL`。这张表回答的是「这段时间**发生过**几次分析」。
 */
export const EVIDENCE_ITEM_EVENTS_SQL = `select v.id         as id,
              v.item_id    as itemId,
              v.kind       as kind,
              v.detail     as detail,
              v.created_at as at
         from item_events v
        where ${IN_RANGE('v.created_at')}
        order by v.created_at, v.id`

/**
 * ⑦ `lecture_logs` —— 讲次结算摘要。**参数：from · to。**
 * `detail` 是文本（`main/report.ts::beats` 从里面抠正确率）；本层只出原始行，
 * 不再抠一遍 —— 抠第二遍就是第二份判据。
 */
export const EVIDENCE_LECTURE_LOGS_SQL = `select g.id         as id,
              g.lecture_id as lectureId,
              g.event      as event,
              g.detail     as detail,
              g.created_at as at
         from lecture_logs g
        where ${IN_RANGE('g.created_at')}
        order by g.created_at, g.id`

/**
 * ⑧-a `ops_log` 的查词行。**参数：from · to。**
 *
 * `title` = 词面（Android `engine/main.ts:235`）。`detail` 今天是空的，
 * T-4.14 会往里写 `{source, face, saved}` —— 本层**现在就把 detail 取出来**，
 * 但纯函数在它为空时照样出得了数：一层判据不该等另一条任务才活。
 */
export const EVIDENCE_LOOKUPS_SQL = `select o.id         as id,
              o.title      as title,
              o.detail     as detail,
              o.created_at as at
         from ops_log o
        where o.op = '${LOOKUP_OP}' and ${IN_RANGE('o.created_at')}
        order by o.created_at, o.id`

/**
 * ⑧-b `ops_log` 的收下行。**参数：from · to。**
 * `target_id` = item id，`title` = 收下时的词面 —— 漏斗的第二段
 * （查 → 收）靠这两个连起来。
 */
export const EVIDENCE_CAPTURES_SQL = `select o.id         as id,
              o.target_id  as itemId,
              o.title      as title,
              o.created_at as at
         from ops_log o
        where o.op = '${CAPTURE_OP}' and o.target = '${CAPTURE_TARGET}'
          and ${IN_RANGE('o.created_at')}
        order by o.created_at, o.id`

/**
 * 取数层照着这张表跑一遍就够了。
 * key 与 `EvidenceInput` 的字段一一对应（`core/analytics/types.ts`）。
 */
export const EVIDENCE_SQL = {
  items: EVIDENCE_ITEMS_SQL,
  marks: EVIDENCE_MARKS_SQL,
  answers: EVIDENCE_ANSWERS_SQL,
  reviews: EVIDENCE_REVIEWS_SQL,
  questions: EVIDENCE_QUESTIONS_SQL,
  sessions: EVIDENCE_SESSIONS_SQL,
  stateEvents: EVIDENCE_STATE_EVENTS_SQL,
  itemEvents: EVIDENCE_ITEM_EVENTS_SQL,
  lectureLogs: EVIDENCE_LECTURE_LOGS_SQL,
  lookups: EVIDENCE_LOOKUPS_SQL,
  captures: EVIDENCE_CAPTURES_SQL
} as const

export type EvidenceSource = keyof typeof EVIDENCE_SQL

/**
 * 每一句要几个 `[from, to]`。
 *
 * ★ 取数层照这个数补参数，**不各自数一遍问号** —— 数错了不会报错，
 *   只会 `RangeError: Too few parameter values`，或者更糟：
 *   `questions` 那句少给两个参数直接抛，而它恰恰是唯一一句要两对的。
 */
export const EVIDENCE_RANGE_PAIRS: Record<EvidenceSource, number> = {
  items: 0,
  marks: 0,
  answers: 1,
  reviews: 1,
  questions: 2,
  sessions: 1,
  stateEvents: 1,
  itemEvents: 1,
  lectureLogs: 1,
  lookups: 1,
  captures: 1
}
