import type { ReadingGrade } from './types.ts'
import { READING_GRADE_NAMES } from './types.ts'

/**
 * 认读线 · 条目级 SM-2 · D-017 / D-021 / D-131 / D-135
 *
 * 与产出线彻底分开：各自队列、各自统计、互不干扰（D-014）。
 * 认读的「对」是「我想起来了」，产出的「对」是「我写出来了」——
 * 合成一个数就什么都说明不了，**两者的差距才是最有价值的指标**（M-040 / D-085）。
 */

export interface ReadingConfig {
  initialEase: number
  minEase: number
  maxEase: number
  /** 下次间隔超过这么多天就静默 · D-135 */
  silenceDays: number
  /**
   * 新卡（还没有任何间隔）时四档各给几天。
   * D-017 只写死了「第 1 次会了 → 1 天」，另外三档在**新卡**上的取值没有规定，
   * 这四个数是我按同类软件的日粒度惯例定的，放进配置里好让 D-179 高级区能调。
   */
  newCard: Record<ReadingGrade, number>
}

export const DEFAULT_READING: ReadingConfig = {
  initialEase: 2.5,
  minEase: 1.3,
  maxEase: 2.5,
  silenceDays: 180,
  newCard: { 1: 1, 2: 1, 3: 1, 4: 4 }
}

export interface CardState {
  ease: number
  /** 天。0 = 还没排过期的新卡 */
  interval: number
  /** 累计答对次数。「忘了」**不清零**（D-017 对原型「失败即重置」的软化） */
  reps: number
  /** 忘掉过几次 */
  lapses: number
  silent: boolean
}

export function newCardState(cfg: ReadingConfig = DEFAULT_READING): CardState {
  return { ease: cfg.initialEase, interval: 0, reps: 0, lapses: 0, silent: false }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 算出某一档会给多少天，不改状态 —— 供 D-136「按钮上直接标间隔」使用。 */
export function intervalFor(
  card: CardState,
  grade: ReadingGrade,
  cfg: ReadingConfig = DEFAULT_READING
): number {
  if (card.reps === 0) return cfg.newCard[grade]
  switch (grade) {
    case 1:
      return 1 // 打回 1 天
    case 2:
      return Math.max(1, Math.round(card.interval * 1.2))
    case 3:
      return card.reps === 1 ? 3 : Math.max(1, Math.round(card.interval * card.ease))
    case 4:
      return Math.max(1, Math.round(card.interval * card.ease * 1.3))
  }
}

/** 四档按钮上各自的下次间隔 · D-136 —— 让自评带上代价。 */
export function previewIntervals(
  card: CardState,
  cfg: ReadingConfig = DEFAULT_READING
): Record<ReadingGrade, number> {
  return {
    1: intervalFor(card, 1, cfg),
    2: intervalFor(card, 2, cfg),
    3: intervalFor(card, 3, cfg),
    4: intervalFor(card, 4, cfg)
  }
}

export interface ReadingOutcome {
  card: CardState
  intervalDays: number
  silenced: boolean
  reason: string
}

export function applyReadingGrade(
  prev: CardState,
  grade: ReadingGrade,
  cfg: ReadingConfig = DEFAULT_READING
): ReadingOutcome {
  if (prev.silent) {
    throw new Error('这张卡已经练成了，不该再排期（D-024 / D-135）。')
  }

  const next = intervalFor(prev, grade, cfg)
  const card: CardState = { ...prev, interval: next }

  switch (grade) {
    case 1:
      card.ease = clamp(prev.ease - 0.2, cfg.minEase, cfg.maxEase)
      card.lapses = prev.lapses + 1
      // reps 保持不变 —— 已累计的正确次数不清零（D-017）
      break
    case 2:
      card.ease = clamp(prev.ease - 0.15, cfg.minEase, cfg.maxEase)
      card.reps = prev.reps + 1
      break
    case 3:
      card.reps = prev.reps + 1
      break
    case 4:
      card.ease = clamp(prev.ease + 0.15, cfg.minEase, cfg.maxEase)
      card.reps = prev.reps + 1
      break
  }

  // D-135 · 下次间隔超过 180 天，说明它已经稳到不用再排了
  const silenced = card.interval > cfg.silenceDays
  if (silenced) card.silent = true

  const reason =
    `「${READING_GRADE_NAMES[grade]}」· 下次 ${card.interval} 天` +
    ` · 容易度 ${card.ease.toFixed(2)}` +
    (grade === 1 ? '（正确次数不清零）' : '') +
    (silenced ? ` · 超过 ${cfg.silenceDays} 天，认读线练成` : '')

  return { card, intervalDays: card.interval, silenced, reason }
}

/**
 * 产出题里点了「提示」· D-138
 *
 * 判分不受影响，但**记一次认读线失败、该卡间隔打回**。
 * 理由与 D-026 同源：「写产出题时想不起意思」是「这张认读卡排期错了」的硬证据 ——
 * 两条线因此互相供给证据（M-004）。
 */
export function penalizeFromHint(
  prev: CardState,
  cfg: ReadingConfig = DEFAULT_READING
): ReadingOutcome {
  const o = applyReadingGrade(prev, 1, cfg)
  return { ...o, reason: `产出题里点了提示 —— 记一次认读失败 · ${o.reason}` }
}
