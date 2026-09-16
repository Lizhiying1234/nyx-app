import type { Database } from 'better-sqlite3'
import type { ReportData } from '@shared/api.ts'

const DAY = 86_400_000

/** 当天零点 */
function day0(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 分析报告 · D-043
 *
 * 「**核心主张**：报告回答『我的知识在往哪流』，不是『我做了多少题』。
 *  做题量是过程，不是进步。」
 *
 * ★ D-467（2026-09-07）· 收成三块：① 知识流向（主角）② 正确率趋势
 *   ③ 攻坚区进出（看净值）。原来的 ④ lecture 轮转 · ⑤ 练习密度 ·
 *   ⑥ 两条线的量级对照删了 —— 前两块与证据层那张「学习时间线与时段密度」
 *   讲的是同一件事，两条线与「认读 / 产出表现」讲的是同一件事。
 *   给它们算的三个私有方法一起删掉（`check:dead` 之外还有一条：留着算
 *   而界面不画，就是每开一次报告白跑三趟查询，谁都不会发现）。
 */
export class Report {
  constructor(private db: Database) {}

  build(days = 30, now = Date.now()): ReportData {
    const to = day0(now) + DAY
    const from = to - days * DAY

    return {
      from,
      to,
      days,
      flow: this.flow(from, to),
      accuracy: this.accuracy(from, to),
      hardFlow: this.hardFlow(from, to)
    }
  }

  /**
   * ① 知识流向 —— **主角**。每一天每条主动词汇处在哪一态。
   *
   * 做法：把每条条目的迁移事件按时间排好，逐日取「那一天结束时它在哪一态」。
   * 这就是为什么必须有 state_events —— 只看当前状态画不出流动。
   */
  private flow(from: number, to: number): ReportData['flow'] {
    /**
     * ★★★ 2026-09-03 · 「出生事件」在读的时候补，不在写的时候存
     *
     * ── 病是什么 ──────────────────────────────────────────────
     * `state_events` 只在**状态变化**时写（判分 / 静默 / 批量改），
     * **建条目的时候一条都不写**。于是一条刚析出、还没练过的知识点
     * `production_state = 'new'`，却**一条产出事件都没有** ——
     * 回放事件算出来的知识流向图里，**它根本不存在**。
     *
     * ★ 而「新增未练」这一档恰恰就是这批人：**该最厚的那条带子是空的。**
     *
     * ★★ 实测确认（不是读代码推的）：真软件里 `data.addItem` 建一条 →
     *   `items` 有行、`production_state='new'`、`state_events` **空表**。
     *
     * ── 为什么修在读侧 ────────────────────────────────────────
     * V5 迁移**一次性补过**出生事件，注释白纸黑字写着
     * 「已有条目补一条「出生」事件，否则它们在流向图上凭空出现」——
     * **作者知道这件事，但只补了那一次，后续新建的从来没接上。**
     *
     * 补写侧（触发器或四处 insert 各写一遍）要动 `state_events` 这张
     * **进同步的表**：新写的行要有确定性 uid、要 PRISTINE 才不会在两台之间
     * 打成冲突（同 `trg_items_reading_card` 那一套）。而这些代价换来的
     * 结果，和「读的时候把每条的出生按 `created_at` 补进回放」**一模一样**。
     *
     * ★ 读侧修还多两个好处：
     *   ① **他现有库里的历史数据当场就对了**，不用迁移
     *   ② 已经被 V5 补过出生事件的老条目会拿到重复的一笔 ——
     *      而回放是 `state.set(id, 'new')`，**重复设同一个值是幂等的**，不会重算
     */
    const births = this.db
      .prepare(
        `select i.id as id, 'new' as st, i.created_at as at
           from items i
          where i.deleted_at is null and i.created_at < ?`
      )
      .all(to) as { id: number; st: string; at: number }[]

    const real = this.db
      .prepare(
        `select e.item_id as id, e.to_state as st, e.created_at as at
           from state_events e join items i on i.id = e.item_id
          where i.deleted_at is null and e.line = 'production' and e.created_at < ?`
      )
      .all(to) as { id: number; st: string; at: number }[]

    /**
     * ★ 同一毫秒时，出生必须排在真事件**之前** ——
     *   一条「建出来当天就练了」的条目，两笔的 `at` 可能一样，
     *   顺序反了就会被出生那笔覆盖回 `new`。
     * ★ 第一版我拿 `id` 兜底，而出生和真事件的 `id` **是同一个**，
     *   根本分不出先后 —— 注释声称的事代码没做到。改成显式的 rank。
     */
    const events = [
      ...births.map((e) => ({ ...e, rank: 0 })),
      ...real.map((e) => ({ ...e, rank: 1 }))
    ].sort((a, b) => a.at - b.at || a.rank - b.rank || a.id - b.id)

    const out: ReportData['flow'] = []
    const state = new Map<number, string>()
    let k = 0

    for (let d = from; d < to; d += DAY) {
      const end = d + DAY
      while (k < events.length && events[k]!.at < end) {
        state.set(events[k]!.id, events[k]!.st)
        k += 1
      }
      const tally = { new: 0, training: 0, hard: 0, silent: 0 } as Record<string, number>
      for (const s of state.values()) tally[s] = (tally[s] ?? 0) + 1
      out.push({
        at: d,
        new: tally['new'] ?? 0,
        training: tally['training'] ?? 0,
        hard: tally['hard'] ?? 0,
        silent: tally['silent'] ?? 0
      })
    }
    return out
  }

  /**
   * ② 产出正确率趋势。只算**第一次判定**（D-121）——
   * 改到过关那些不是诚实样本，混进来趋势就假了。
   */
  private accuracy(from: number, to: number): ReportData['accuracy'] {
    const rows = this.db
      .prepare(
        `select created_at as at, grade from answers
          where is_first = 1 and grade is not null and created_at >= ? and created_at < ?
          order by created_at`
      )
      .all(from, to) as { at: number; grade: number }[]

    // 按天聚合，再做 7 天滑动 —— 单日样本太小，点会跳得没法看
    const perDay = new Map<number, { n: number; ok: number }>()
    for (const r of rows) {
      const d = day0(r.at)
      const cur = perDay.get(d) ?? { n: 0, ok: 0 }
      cur.n += 1
      if (r.grade >= 3) cur.ok += 1
      perDay.set(d, cur)
    }

    const points: ReportData['accuracy']['points'] = []
    for (let d = from; d < to; d += DAY) {
      let n = 0
      let ok = 0
      for (let w = 0; w < 7; w++) {
        const c = perDay.get(d - w * DAY)
        if (c) {
          n += c.n
          ok += c.ok
        }
      }
      if (n > 0) points.push({ at: d, rate: ok / n, sample: n })
    }

    const half = Math.floor(rows.length / 2)
    const rate = (a: { grade: number }[]): number =>
      a.length === 0 ? 0 : a.filter((x) => x.grade >= 3).length / a.length
    return {
      points,
      overall: rate(rows),
      firstHalf: rate(rows.slice(0, half)),
      secondHalf: rate(rows.slice(half)),
      sample: rows.length
    }
  }

  /**
   * ③ 攻坚区进出 —— **看净值**。
   * 「进得多出得少，说明判层太松。」（O-204：入口快过出口，攻坚区会越积越多。）
   */
  private hardFlow(from: number, to: number): ReportData['hardFlow'] {
    const n = (sql: string, ...a: unknown[]): number =>
      (this.db.prepare(sql).get(...a) as { n: number }).n
    const entered = n(
      `select count(*) as n from state_events
        where to_state = 'hard' and created_at >= ? and created_at < ?`,
      from,
      to
    )
    const left = n(
      `select count(*) as n from state_events
        where from_state = 'hard' and created_at >= ? and created_at < ?`,
      from,
      to
    )
    const staying = n(
      `select count(*) as n from items where deleted_at is null and production_state = 'hard'`
    )
    const byRepeat = n(
      `select count(*) as n from state_events e join items i on i.id = e.item_id
        where e.to_state = 'hard' and e.created_at >= ? and e.created_at < ? and i.recollected_count > 0`,
      from,
      to
    )
    return { entered, left, staying, net: left - entered, byRepeat }
  }
}
