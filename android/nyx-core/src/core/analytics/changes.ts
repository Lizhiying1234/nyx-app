/**
 * 知识点变化 —— 这段时间里，库里发生了什么 · T-4.11（2026-09-07）
 *
 * 三张事件表，各答一句：
 *   · `state_events`  产出线的状态跳变（`new → training` 几次、`→ silent` 几次…）
 *   · `item_events`   分析发生过几次、其中手机做的几次（`detail.origin`）
 *   · `lecture_logs`  讲次结算过几次
 *
 * ★ 报告①（知识流向）画的是**逐日回放的存量**，这里数的是**这段时间的动作**。
 *   两者不是一回事，也不该互相校验 —— 存量图上一条平线，底下可能是
 *   「进 12 条出 12 条」；那正是这一块要说出来的。
 *
 * ★ `detail` 是自由 JSON（不加列，D-461 / 归档 d 十二问 12），所以解析必须**容错**：
 *   解不出来就算 `unknown`，绝不因为一行脏数据把整块报废。
 */

import type { Changes, EventRef, EvidenceInput, ItemEventRow } from './types.ts'

/** 解不出来 / 没写来源的那些 */
export const UNKNOWN_ORIGIN = 'unknown'

/** `item_events.detail` 里的 `origin`（Android 写 `'android'`，Windows 今天不写这张表） */
export function originOf(e: ItemEventRow): string {
  try {
    const d: unknown = JSON.parse(e.detail || '{}')
    const o = (d as { origin?: unknown }).origin
    return typeof o === 'string' && o.length > 0 ? o : UNKNOWN_ORIGIN
  } catch {
    return UNKNOWN_ORIGIN
  }
}

export function changes(input: EvidenceInput): Changes {
  const byPair = new Map<string, { from: string; to: string; n: number; refs: EventRef[] }>()
  for (const e of input.stateEvents) {
    const from = e.fromState ?? 'new'
    const key = `${from}→${e.toState}`
    const cur = byPair.get(key) ?? { from, to: e.toState, n: 0, refs: [] }
    cur.n += 1
    cur.refs.push({ table: 'state_events', id: e.id, at: e.at })
    byPair.set(key, cur)
  }

  const byOrigin = new Map<string, number>()
  const analysedRefs: EventRef[] = []
  for (const v of input.itemEvents) {
    if (v.kind !== 'analyzed') continue
    const o = originOf(v)
    byOrigin.set(o, (byOrigin.get(o) ?? 0) + 1)
    analysedRefs.push({ table: 'item_events', id: v.id, at: v.at })
  }

  const runs = input.lectureLogs.filter((g) => g.event === 'practiced')

  return {
    transitions: [...byPair.values()].sort((a, b) => b.n - a.n || a.to.localeCompare(b.to)),
    analysed: {
      total: analysedRefs.length,
      byOrigin: [...byOrigin.entries()]
        .map(([origin, n]) => ({ origin, n }))
        .sort((a, b) => b.n - a.n || a.origin.localeCompare(b.origin)),
      refs: analysedRefs
    },
    lectureRuns: {
      n: runs.length,
      refs: runs.map((g) => ({ table: 'lecture_logs', id: g.id, at: g.at }))
    }
  }
}
