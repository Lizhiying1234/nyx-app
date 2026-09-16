/**
 * Study · 认读线：认读面 · 到期卡 · 测试卡与队列 · 判分 —— T-4.6 拆分（2026-09-06）
 *
 * 方法体从 `src/main/study.ts` 原样搬来：`this.<状态>` → `c.<状态>`，
 * `this.<公共方法>` → `c.self.<方法>`，私有方法整个搬进本文件、调用点也在本文件里。
 * ★ 模板字符串里的行一个空格都没动 —— 那里面是 SQL，缩进属于字符串内容。
 * ★ 判断规则一条都不在这里，全在 core/（D-238）：这一层只做
 *   「从库里取状态 → 交给 core 算 → 把结果写回去」。
 */

import { ITEM_NOT_FOUND } from '@shared/api.ts'
import { applyReadingGrade, previewIntervals, type CardState } from '@core/sm2-item.ts'
import { dueAfter } from '@core/sm2-lecture.ts'
import { PRODUCTION_APPLIES } from '../db/silence-sql.ts'
import type { ReadingGrade } from '@core/types.ts'
import type { CardRow, ReadingResult } from '@shared/api.ts'
import {
  buildReadingPrompt,
  onFaces,
  parseFace,
  parseFacePrefs,
  resolveFace,
  revealsAnswer,
  type FacePref,
  type ReadingFace
} from '@core/reading-face.ts'
import { noteLastFace, parseLastFace, readingRulesOf } from '@core/quiz-rules.ts'
import { deviceCol } from '../db/device.ts'
import { callAi } from '../ai/client.ts'
import { resolveSlot } from '../ai/config.ts'
import { ALIVE, CARD_ACTIVE, CARD_DUE, CARD_FIELDS, JOIN_CARD } from '../db/reading-card-sql.ts'
import type { StudyCtx } from './ctx.ts'
import { now, shuffled } from './util.ts'

/** 到期的认读卡。不传 lectureId 就是跨 lecture 的混合队列（D-021）。 */
/**
 * ★ 认读测试的牌面由 AI 出 · 使用者 2026-09-03「认读测试也应该拥有自己的 Prompt」
 *
 * ── 提示词在哪 ────────────────────────────────────────────
 *
 * ★★ D-479（2026-09-08）· 提示词现在是**两件东西拼出来的**：
 *   · 出题规则   `user_preferences['prompt.reading-card']`（键没变，含义改了：只装规则）
 *   · 勾了哪几面 `user_preferences['reading.faces']`
 * 两个都是同步表、跟着人走；拼装在 core 一处（`buildReadingPrompt`），
 * 所以同一份偏好在两台机器上算出**同一份提示词** —— 各拼各的话，两边都说得通、都不报错。
 *
 * ★ 一面都没勾 → `buildReadingPrompt` 回 `null`，这里就**不叫 AI**、直接退回机械牌面。
 *   不兜底（不偷偷按全开出题）：那是他明确取消掉的东西。
 *
 * ── 失败一律返回 null ─────────────────────────────────────
 *
 * 没配 AI / 超时 / 格式不对 / 露了答案，统统安静返回 null，
 * 界面退回机械挖空（D-338 · AI 不在不许阻断认读）。
 * 认读是每天都要跑的事，它不能因为 AI 不在就跑不起来。
 */
export async function readingFace(c: StudyCtx, itemId: number, signal?: AbortSignal): Promise<ReadingFace | null> {
  try {
    const r = c.db
      .prepare(
        `select i.term as term, i.gloss as gloss,
                  (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote
             from items i where i.id = ? and i.deleted_at is null`
      )
      .get(itemId) as { term: string; gloss: string | null; quote: string | null } | undefined
    if (!r) return null

    /**
     * ★★ 2026-09-15 起拼装收的是**三个选项**，不再是 `prompt.reading-card` 那段正文
     *   （D-482）。他以前写的那段留在库里、设置页上只读可看，但不再参与出题 ——
     *   两个真相里只能留一个，而他裁的是「点选项」那一个。
     */
    const rules = readingRulesOf((k) => c.prefs.raw(k))
    /**
     * ★ 递**整条**不递 id（使用者 2026-09-14 第一条）：
     *   他自建的那几面不在任何一张表里，正文就在这条偏好里。
     *   只递 id 的话，拼装那一步查不回来，会被静静丢掉。
     */
    const faces = onFaces(parseFacePrefs(c.prefs.raw('reading.faces')))
    /** R-1「轮着来」要的那个数 —— 别的两档拿到 null 也照样算得出顺序 */
    const built = buildReadingPrompt(rules, faces, r.term, r.gloss, r.quote, lastFaceOf(c, itemId))
    // ★ 一面都没勾：不叫 AI，直接退回机械牌面（界面那句话由 Reading.svelte 说）
    if (!built) return null
    const text = await callAi(
      // D-202 · 量大要求低，和练习出题同槽
      resolveSlot(c.db, 'light'),
      {
        system: built.system,
        user: built.user,
        /**
         * ★ 2026-09-13 · 从 200 抬到 700（使用者当面把这个数交给我定）。
         *
         * 判断依据三条：
         * ① **上限不是目标** —— 不做思考的模型写完一张牌面就停，
         *    200 和 700 对它们是同一笔账。
         * ② 推理模型在 200 下**一张牌面都出不来**，而这条路上的失败是
         *    `catch { return null }` **静默**退回机械牌面（D-338：AI 不在
         *    不许阻断认读）—— 他永远不会知道 AI 牌面为什么从来没出现过。
         *    「安静地什么都不出」比「说一句话然后失败」更难查。
         * ③ 为什么是 700 不是 1200：这是全软件**调用量最大**的一条
         *    （每天按 readingDailyCap 张跑）。真把推理模型配进 light 槽的话，
         *    700 给的是「一段短思考 + 一张牌面」的余量，不是无底洞。
         *    牌面本身只有一两句，200 从来不是给正文卡的，是给思考卡的。
         * ☞ light 槽本来就写着「量大要求低」—— 往里配推理模型是他的选择，
         *   这个数只保证「配了也能出东西」，不保证便宜。
         */
        maxTokens: 700,
        timeoutMs: 20_000,
        signal
      },
      'light'
    )
    const f = parseFace(text)
    if (!f) return null
    // ★★ 红线自查：露了答案就作废（D-390）。判据在 core，两端同一份
    if (revealsAnswer(f.text, r.term)) return null
    /**
     * ★★ 记一笔「这一条刚用了哪一面」—— R-1「轮着来」全靠这个数（A-2）。
     *   ★ 只在**真的出成了一张卡**之后记：作废的那几版（格式不对 / 露答案）
     *     他根本没看见，记下去的话下一次会跳过一面**他从没见过的**牌面。
     */
    markLastFace(c, itemId, faces, f.form)
    return f
  } catch {
    // D-338 · AI 不在不许阻断认读
    return null
  }
}

/**
 * ══ 这一条上次用了哪一面 —— **DEVICE**（主控 2026-09-15 改判）══════
 *
 * 存 `settings['reading.lastFace']`：`{ 知识点 uid: 牌面 id }`，有界（core 里 200）。
 * 不进同步表、不加列 —— 理由写在 `core/quiz-rules.ts` 那一段（加列必改结构指纹，
 * 而协调升级要 Android 真上机一次，和这一轮「不装机」冲突）。
 *
 * ★ 按 **uid** 存不按本机 id：settings 不同步，但库会被还原 / 导回（R-3-f），
 *   本机 id 在那之后可能指向另一条知识点，而 uid 不会。
 */
const LAST_FACE_KEY = 'reading.lastFace'

function lastFaceRaw(c: StudyCtx): string | null {
  const r = c.db.prepare(`select value from settings where key = ?`).get(LAST_FACE_KEY) as
    | { value: string }
    | undefined
  return r?.value ?? null
}

function itemUidOf(c: StudyCtx, itemId: number): string | null {
  const r = c.db.prepare(`select uid from items where id = ?`).get(itemId) as
    | { uid: string | null }
    | undefined
  return r?.uid ?? null
}

function lastFaceOf(c: StudyCtx, itemId: number): string | null {
  const uid = itemUidOf(c, itemId)
  if (!uid) return null
  return parseLastFace(lastFaceRaw(c))[uid] ?? null
}

/**
 * 记下「这一条刚用了哪一面」。
 *
 * ★★ 模型回来的是**形式名**（「挖空」），而轮转要的是 id。所以按**这次可用的那几面**
 *   反查名字 —— 认不出来就**什么都不记**：宁可这一次不计入轮转，也不要把一个猜出来的
 *   id 写进去（写错了的后果是「轮着来」永远跳过某一面，而屏幕上什么都不会说）。
 * ★ `settings` 是本机那张表：不带 uid、不进 `SYNC_TABLES`，所以这一笔不会推上云，
 *   也不会和另一台机器撞。它自己那一列 `updated_at` 照写（D-201 对每张表都成立）。
 */
function markLastFace(
  c: StudyCtx,
  itemId: number,
  faces: readonly FacePref[],
  form: string
): void {
  const name = form.trim()
  if (!name) return
  const hit = faces.find((p) => resolveFace(p)?.name === name)
  if (!hit) return
  const uid = itemUidOf(c, itemId)
  if (!uid) return
  const t = now()
  c.db
    .prepare(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(LAST_FACE_KEY, noteLastFace(lastFaceRaw(c), uid, hit.id), t)
}

export function dueCards(c: StudyCtx, lectureId: number | null, limit?: number): CardRow[] {
  limit ??= c.params.effective().readingDailyCap
  const t = now()
  const rows = c.db
    .prepare(
      `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer,
                ${CARD_FIELDS()},
                (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
                /* 6.2 · 分析判定「打错了 / 听岔了，需要修改」—— 列表上要有个记号。
                   改完之后 acceptSuspect 会把这一条从区块里去掉，
                   区块空了就整块删掉，于是记号自己消失，不需要另设一个「已处理」位。 */
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.block = 'suspect') as hasSuspect,
                (select content from analysis_blocks b
                  where b.item_id = i.id and b.block = 'summary') as nuance
           from items i ${JOIN_CARD('i')}
          where ${CARD_ACTIVE('i')} and ${CARD_DUE()}
            ${lectureId ? 'and i.id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)' : ''}
          order by rc.due_at, i.id
          limit ?`
    )
    .all(...(lectureId ? [t, lectureId, limit] : [t, limit])) as (CardRow & {
    ease: number
    interval: number
    reps: number
    lapses: number
    silent: number
  })[]

  return rows.map((r) => {
    const card: CardState = {
      ease: r.ease,
      interval: r.interval,
      reps: r.reps,
      lapses: r.lapses,
      silent: r.silent !== 0
    }
    return {
      id: r.id,
      term: r.term,
      gloss: r.gloss,
      glossZh: r.glossZh,
      layer: r.layer,
      quote: r.quote,
      nuance: r.nuance,
      // D-136 · 四档按钮上直接标出各自的下次间隔，让自评带上代价
      intervals: previewIntervals(card, c.params.effective().reading)
    }
  })
}

/**
 * 随时测 · I-061
 *
 * 使用者：「项目、单元和 lecture 中的测试，无论是认读还是其他测试，
 *          **不遵循间隔重复**，只要想测都能测试。」
 *
 * 和 `dueCards` 的区别只有一条：**不看到期日**。
 * 其余照旧 —— 判分仍然走同一套 SM-2（练了就算数，不能白练），
 * 但**要不要练由你决定，不由日程决定**。
 *
 * 静默的也一并给出来：D-030 说静默是「通过全部检验、不再轮转」，
 * 不是「不许再碰」——他主动要测，那就给他。
 */
export function testCards(c: StudyCtx, lectureIds: number[], shuffle = false): CardRow[] {
  if (lectureIds.length === 0) return []
  const marks = lectureIds.map(() => '?').join(',')
  const rows = c.db
    .prepare(
      `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer,
                ${CARD_FIELDS()},
                (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
                /* 6.2 · 分析判定「打错了 / 听岔了，需要修改」—— 列表上要有个记号。
                   改完之后 acceptSuspect 会把这一条从区块里去掉，
                   区块空了就整块删掉，于是记号自己消失，不需要另设一个「已处理」位。 */
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.block = 'suspect') as hasSuspect,
                (select content from analysis_blocks b
                  where b.item_id = i.id and b.block = 'summary') as nuance
           from items i ${JOIN_CARD('i')}
          where ${ALIVE('i')}
            and i.id in (select item_id from item_lectures where lecture_id in (${marks}) and deleted_at is null)
          order by i.id`
    )
    .all(...lectureIds) as (CardRow & {
    ease: number
    interval: number
    reps: number
    lapses: number
    silent: number
  })[]

  const out = rows.map((r) => ({
    id: r.id,
    term: r.term,
    gloss: r.gloss,
    glossZh: r.glossZh,
    layer: r.layer,
    quote: r.quote,
    nuance: r.nuance,
    intervals: previewIntervals(
      { ease: r.ease, interval: r.interval, reps: r.reps, lapses: r.lapses, silent: r.silent !== 0 },
      c.params.effective().reading
    )
  }))
  return shuffle ? shuffled(out) : out
}

/**
 * 随时测 · 认读线，**按勾中的条目**（I-097）
 *
 * 和按 lecture 取是同一套规则（不看到期日、静默的也给），只是范围换成一串 id。
 * 复用 `testCards` 的查询会更省事，但那要先反查这些条目属于哪些讲 ——
 * 那样会把没勾中的兄弟条目一起拖进来，正好违背「我勾了哪几条就测哪几条」。
 *
 * ★ T-4.13 / T-5.18 · **这一场只动卡，不动讲次间隔**（D-R28 的边界，两端同一条）：
 *   判分照写 `review_logs` + 照更新 `reading_cards`（练了就算数），
 *   但勾中的那几条代表不了整讲 —— 理由与出处见
 *   `main/study/lecture.ts::settleLectures` 头上那一段。
 *   认读线本来就不做讲次结算，所以这里不需要额外的判断，**只需要不长出一个**。
 */
export function testCardsByIds(c: StudyCtx, ids: number[], shuffle = false): CardRow[] {
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(',')
  const rows = c.db
    .prepare(
      `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer,
                ${CARD_FIELDS()},
                (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
                /* 6.2 · 分析判定「打错了 / 听岔了，需要修改」—— 列表上要有个记号。
                   改完之后 acceptSuspect 会把这一条从区块里去掉，
                   区块空了就整块删掉，于是记号自己消失，不需要另设一个「已处理」位。 */
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.block = 'suspect') as hasSuspect,
                (select content from analysis_blocks b
                  where b.item_id = i.id and b.block = 'summary') as nuance
           from items i ${JOIN_CARD('i')}
          where ${ALIVE('i')} and i.id in (${marks})
          order by i.id`
    )
    .all(...ids) as (CardRow & {
    ease: number
    interval: number
    reps: number
    lapses: number
    silent: number
  })[]

  const out = rows.map((r) => ({
    id: r.id,
    term: r.term,
    gloss: r.gloss,
    glossZh: r.glossZh,
    layer: r.layer,
    quote: r.quote,
    nuance: r.nuance,
    intervals: previewIntervals(
      { ease: r.ease, interval: r.interval, reps: r.reps, lapses: r.lapses, silent: r.silent !== 0 },
      c.params.effective().reading
    )
  }))
  return shuffle ? shuffled(out) : out
}

/**
 * 随时测 · 产出线。同样不看到期日、不看状态。
 * 攻坚区里的也给 —— 他要测就是要测。
 */
export function testQueue(c: StudyCtx, lectureIds: number[], shuffle = false): { id: number; term: string; corrects: number }[] {
  if (lectureIds.length === 0) return []
  const marks = lectureIds.map(() => '?').join(',')
  const rows = c.db
    .prepare(
      `select i.id, i.term, i.corrects
           from items i
          where i.deleted_at is null and ${PRODUCTION_APPLIES('i')}
            and i.id in (select item_id from item_lectures where lecture_id in (${marks}) and deleted_at is null)
          order by i.id`
    )
    .all(...lectureIds) as { id: number; term: string; corrects: number }[]
  return shuffle ? shuffled(rows) : rows
}

export function gradeCard(c: StudyCtx, itemId: number, grade: ReadingGrade, durationMs?: number): ReadingResult {
  const card = cardOf(c, itemId)
  const before = card.interval
  const out = applyReadingGrade(card, grade, c.params.effective().reading)
  const t = now()

  c.db
    .prepare(
      /**
       * ★★ D-296 · 这就是 Android 唯一的 UPDATE 写入面（D-298）。
       *   拆表之后它只碰 `reading_cards`，`items` 一个字都不动 ——
       *   两边改不相干的列不再互相判成冲突。
       */
      `update reading_cards
            set ease = ?, interval_days = ?, reps = ?, lapses = ?,
                silent = ?, due_at = ?, updated_at = ?
          where item_id = ?`
    )
    .run(
      out.card.ease,
      out.card.interval,
      out.card.reps,
      out.card.lapses,
      out.card.silent ? 1 : 0,
      dueAfter(out.card.interval),
      t,
      itemId
    )

  // D-017 · 自第一天起完整记录，不记则将来无法切 FSRS
  c.db
    .prepare(
      `insert into review_logs (item_id, line, grade, interval_before, interval_after,
                                  ease_after, duration_ms, device, created_at, updated_at)
         values (?, 'reading', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(itemId, grade, before, out.card.interval, out.card.ease, durationMs ?? null,
         deviceCol(c.db), t, t)

  return { intervalDays: out.intervalDays, silenced: out.silenced, reason: out.reason }
}

export function cardOf(c: StudyCtx, itemId: number): CardState {
  const r = c.db
    .prepare(
      `select ease, interval_days as interval, reps, lapses, silent
           from reading_cards where item_id = ?`
    )
    .get(itemId) as
    | { ease: number; interval: number; reps: number; lapses: number; silent: number }
    | undefined
  if (!r) throw new Error(ITEM_NOT_FOUND)
  return { ...r, silent: r.silent !== 0 }
}
