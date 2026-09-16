/**
 * 产出线 · lecture 级轮转 · D-017 / D-139 / M-024
 *
 * 调度单位是 **lecture，不是知识点**。
 * 「lecture 层面的间隔自动为每个条目撑开了时间跨度，因此不需要额外的防速成规则」——
 * 一条要连续 3 次正确，就必须熬过 3 次 lecture 训练，而这 3 次之间天然隔着 4 天起步。
 */

export interface LectureConfig {
  /** 新 lecture 第一次的间隔（天） */
  firstInterval: number
  /** 本次样本少于这么多条，间隔不动 · D-139 */
  minSample: number
  /** 正确率 < 50% → 打回几天 */
  resetTo: number
}

export const DEFAULT_LECTURE: LectureConfig = {
  firstInterval: 1,
  minSample: 5,
  resetTo: 1
}

export interface LectureIntervalResult {
  interval: number
  changed: boolean
  multiplier: number | null
  reason: string
}

/**
 * 练完一轮之后，这个 lecture 下次什么时候再来。
 *
 * @param current   当前间隔（天）。新 lecture 传 0
 * @param accuracy  本次正确率，0–1。按 D-133 口径：第 3、4 档算对
 * @param sample    本次实际作答的条目数
 */
export function nextLectureInterval(
  current: number,
  accuracy: number,
  sample: number,
  cfg: LectureConfig = DEFAULT_LECTURE
): LectureIntervalResult {
  // D-139 · 用 4 条的正确率去决定一个 30 条 lecture 的排期，是拿噪音当信号。
  if (sample < cfg.minSample) {
    return {
      interval: current || cfg.firstInterval,
      changed: false,
      multiplier: null,
      reason: `本次只练了 ${sample} 条（少于 ${cfg.minSample} 条），间隔不动 —— 样本太小，不足以判断`
    }
  }

  const pct = Math.round(accuracy * 100)
  const base = current || cfg.firstInterval

  if (accuracy < 0.5) {
    return {
      interval: cfg.resetTo,
      changed: cfg.resetTo !== current,
      multiplier: null,
      reason: `正确率 ${pct}%（低于 50%）—— 打回 ${cfg.resetTo} 天重来`
    }
  }

  const multiplier = accuracy < 0.75 ? 1.2 : accuracy <= 0.9 ? 2.0 : 2.6
  const band = accuracy < 0.75 ? '50–75%' : accuracy <= 0.9 ? '75–90%' : '高于 90%'
  const interval = Math.max(1, Math.round(base * multiplier))

  return {
    interval,
    changed: interval !== current,
    multiplier,
    reason: `正确率 ${pct}%（${band}）—— 间隔 ×${multiplier}，${base} 天 → ${interval} 天`
  }
}

/** 从今天起 n 天后的时间戳（当天零点，避免同一天反复到期）。 */
export function dueAfter(days: number, from: number = Date.now()): number {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/** 欠了几天。负数表示还没到期。 */
export function overdueDays(dueAt: number, now: number = Date.now()): number {
  const a = new Date(now)
  a.setHours(0, 0, 0, 0)
  const b = new Date(dueAt)
  b.setHours(0, 0, 0, 0)
  return Math.round((a.getTime() - b.getTime()) / 86_400_000)
}
