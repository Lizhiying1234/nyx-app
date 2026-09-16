/**
 * 认读线（阶段 4 第一件）—— **判据只有一份**：
 *   SM-2 / 四档 / 静默阈值 / 各档下次间隔 = `core/sm2-item.ts` direct import（D-365）。
 * 这里只逐字港 Windows `study.ts` 的三条队列 SQL 与 `gradeCard` 的两笔写：
 *   dueCards（368-418）· testCards / testCardsByIds（433-543 · I-061/I-097
 *   随时测：不看到期日，静默的也给 D-030）· gradeCard（545-586）。
 * 宏 **direct import 自 `core/sql/reading-card.ts`**（F-017 · 2026-09-01
 *   上提；此前是文件头逐字复制的第二份）。
 *
 * ★ D-296/D-298：`gradeCard` 的 UPDATE 是 **Android 在认读卡上唯一的写入面** ——
 *   只碰 reading_cards，items 一个字不动。
 * ★ D-349 采集：review_logs 带 `duration_ms` + `device`（sync.device，
 *   引擎铸的那个；没配同步时如实 null）。
 * ★ D-017：自第一天起完整记录 —— 不记则将来无法切 FSRS。
 * ★ sessions 不在这里造：它只有一个创建者 = 产出练习的 startSession
 *   （Windows audit 亲自看着这条）。
 */
import {
  applyReadingGrade,
  previewIntervals,
  DEFAULT_READING,
  dueAfter,
  type CardState,
  type ReadingConfig,
  type ReadingGrade,
  // ★ 认读卡宏（F-017）—— 漏掉 JOIN 那半句 = 软删的知识点重进队列，且不报错
  JOIN_CARD,
  ALIVE,
  CARD_ACTIVE,
  CARD_DUE,
  CARD_FIELDS
} from '../core-link.ts'
import { prefNumber } from './prefs.ts'
import type { Db } from './types.ts'

export interface CardRow {
  id: number
  term: string
  gloss: string | null
  glossZh: string | null
  layer: string
  quote: string | null
  nuance: string | null
  /** D-136 · 四档按钮上直接标出各自的下次间隔，让自评带上代价 */
  intervals: Record<ReadingGrade, number>
}

/**
 * 生效的认读参数：DEFAULT_READING + 他改过的那一项（main/params 同口径）。
 * ★ 更正（2026-08-30）：USER 偏好在 user_preferences（同步表），不是 settings。
 */
export async function readingConfig(db: Db): Promise<ReadingConfig> {
  const n = await prefNumber(db, 'param.readingSilenceDays', DEFAULT_READING.silenceDays)
  return { ...DEFAULT_READING, silenceDays: n > 0 ? n : DEFAULT_READING.silenceDays }
}

/** 写进学习事实的那一列 —— 空串统一成 null（main/db/device.ts::deviceCol 同语义） */
export async function deviceCol(db: Db): Promise<string | null> {
  const r = await db.get(`select value from settings where key = 'sync.device'`)
  const v = String(r?.['value'] ?? '').trim()
  return v || null
}

type RawCard = {
  id: number
  term: string
  gloss: string | null
  glossZh: string | null
  layer: string
  quote: string | null
  nuance: string | null
  ease: number
  interval: number
  reps: number
  lapses: number
  silent: number
}

async function shape(db: Db, rows: RawCard[]): Promise<CardRow[]> {
  const cfg = await readingConfig(db)
  return rows.map((r) => ({
    id: r.id,
    term: r.term,
    gloss: r.gloss,
    glossZh: r.glossZh,
    layer: r.layer,
    quote: r.quote,
    nuance: r.nuance,
    intervals: previewIntervals(
      { ease: r.ease, interval: r.interval, reps: r.reps, lapses: r.lapses, silent: r.silent !== 0 },
      cfg
    )
  }))
}

const CARD_SELECT = `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer,
        ${CARD_FIELDS()},
        (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
        (select content from analysis_blocks b
          where b.item_id = i.id and b.block = 'summary') as nuance
   from items i ${JOIN_CARD('i')}`

/** 到期的卡 · D-229 每日软上限（超出自动顺延 —— 没排进来的还在到期，明天继续） */
export async function dueCards(db: Db, lectureId: number | null, limit = 40): Promise<CardRow[]> {
  const t = Date.now()
  const rows = (await db.all(
    `${CARD_SELECT}
      where ${CARD_ACTIVE('i')} and ${CARD_DUE()}
        ${lectureId ? 'and i.id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)' : ''}
      order by rc.due_at, i.id
      limit ?`,
    lectureId ? [t, lectureId, limit] : [t, limit]
  )) as unknown as RawCard[]
  return shape(db, rows)
}

/** Fisher–Yates —— `sort(() => Math.random()-0.5)` 不均匀（Windows shuffled 同款） */
function shuffled<T>(rows: T[]): T[] {
  const out = [...rows]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** 随时测 · I-061 —— 不看到期日；静默的也给（D-030：他主动要测就给他） */
export async function testCards(db: Db, lectureIds: number[], shuffle = false): Promise<CardRow[]> {
  if (lectureIds.length === 0) return []
  const marks = lectureIds.map(() => '?').join(',')
  const rows = (await db.all(
    `${CARD_SELECT}
      where ${ALIVE('i')}
        and i.id in (select item_id from item_lectures where lecture_id in (${marks}) and deleted_at is null)
      order by i.id`,
    lectureIds
  )) as unknown as RawCard[]
  const out = await shape(db, rows)
  return shuffle ? shuffled(out) : out
}

/** 指定一批条目来测 · I-097（Vault 多选「认读这 N 条」走它） */
export async function testCardsByIds(db: Db, ids: number[], shuffle = false): Promise<CardRow[]> {
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(',')
  const rows = (await db.all(
    `${CARD_SELECT}
      where ${ALIVE('i')} and i.id in (${marks})
      order by i.id`,
    ids
  )) as unknown as RawCard[]
  const out = await shape(db, rows)
  return shuffle ? shuffled(out) : out
}

async function cardOf(db: Db, itemId: number): Promise<CardState> {
  const r = (await db.get(
    `select ease, interval_days as interval, reps, lapses, silent
       from reading_cards where item_id = ?`,
    [itemId]
  )) as { ease: number; interval: number; reps: number; lapses: number; silent: number } | undefined
  if (!r) throw new Error(`找不到这条知识点（id=${itemId}）`)
  return { ...r, silent: r.silent !== 0 }
}

export interface ReadingResult {
  intervalDays: number
  silenced: boolean
  reason: string
}

export async function gradeCard(
  db: Db,
  itemId: number,
  grade: ReadingGrade,
  durationMs?: number
): Promise<ReadingResult> {
  const card = await cardOf(db, itemId)
  const before = card.interval
  const out = applyReadingGrade(card, grade, await readingConfig(db))
  const t = Date.now()

  // ★★ D-296 · Android 在认读卡上唯一的 UPDATE 写入面（D-298）
  await db.run(
    `update reading_cards
        set ease = ?, interval_days = ?, reps = ?, lapses = ?,
            silent = ?, due_at = ?, updated_at = ?
      where item_id = ?`,
    [
      out.card.ease,
      out.card.interval,
      out.card.reps,
      out.card.lapses,
      out.card.silent ? 1 : 0,
      dueAfter(out.card.interval),
      t,
      itemId
    ]
  )

  // D-017 · 自第一天起完整记录，不记则将来无法切 FSRS；D-349 · device + duration
  await db.run(
    `insert into review_logs (item_id, line, grade, interval_before, interval_after,
                              ease_after, duration_ms, device, created_at, updated_at)
     values (?, 'reading', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [itemId, grade, before, out.card.interval, out.card.ease, durationMs ?? null, await deviceCol(db), t, t]
  )

  return { intervalDays: out.intervalDays, silenced: out.silenced, reason: out.reason }
}

/** 首页/讲次上的「今天几张到期」—— 单对象直读的任务量（状态，不是统计） */
export async function dueCount(db: Db, lectureId: number | null = null): Promise<number> {
  const t = Date.now()
  const r = await db.get(
    `select count(*) as n from items i ${JOIN_CARD('i')}
      where ${CARD_ACTIVE('i')} and ${CARD_DUE()}
        ${lectureId ? 'and i.id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)' : ''}`,
    lectureId ? [t, lectureId] : [t]
  )
  return Number(r?.['n'] ?? 0)
}
