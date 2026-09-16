/**
 * 今日练习的匹配 · D-027 / D-228 / D-164 / I-025
 *
 * 「你定条数，系统按到期次序凑 lecture。**lecture 永远整取，不截断。**
 *  实际条数会高于或低于目标值，属预期行为。」
 */

export interface DueLecture {
  lectureId: number
  /** 到期时间戳，越早越先 */
  dueAt: number
  /** 本讲**扣除当天已练之后**还待练的条目数 · D-228 / D-164 */
  pending: number
  name?: string
}

export interface MatchResult {
  picked: DueLecture[]
  total: number
  /** 为什么停在这里 —— 界面上要答得出「为什么今天是 39 条不是 35 条」 */
  reason: string
}

/**
 * 半数规则 · D-027
 *
 * 设目标 N、已累计 S、下一个到期 lecture 的条目数 K：
 * 若 `(N − S) ≥ K ÷ 2` 就收下并继续；否则停止。
 */
export function matchToday(target: number, due: DueLecture[]): MatchResult {
  // I-025 · 一条待练条目都没有的 lecture 不该被「收下」—— 上一版会收，
  // 结果今日练习里混进空讲次，点进去什么都没有。
  const queue = due.filter((l) => l.pending > 0).sort((a, b) => a.dueAt - b.dueAt)

  if (queue.length === 0) {
    return { picked: [], total: 0, reason: '今天没有到期的 lecture' }
  }

  const picked: DueLecture[] = []
  let total = 0

  for (const lec of queue) {
    const remaining = target - total
    if (remaining >= lec.pending / 2) {
      picked.push(lec)
      total += lec.pending
    } else {
      return {
        picked,
        total,
        reason:
          `凑到 ${total} 条（目标 ${target}）。` +
          `下一个到期的还差 ${lec.pending} 条，只剩 ${remaining} 条额度、不到它的一半，` +
          `所以停在这里 —— lecture 永远整取，不截断`
      }
    }
  }

  return {
    picked,
    total,
    reason: `到期的 ${queue.length} 个 lecture 全部收下，共 ${total} 条（目标 ${target}）`
  }
}
