import { dueAfter, overdueDays, DEFAULT_LECTURE, type LectureConfig } from './sm2-lecture.ts'

/**
 * 「这批我看过了 · 开始学」按下去之后，这一讲的排期该变成什么 · ★★ F-2-②
 *
 * ── 为什么这是一个函数，而不是三行 SQL 里的表达式 ────────────
 *
 * 它同时回答两个**不同层级**的问题，而以前它们被压在一句 `update` 里：
 *
 *   · lecture 级 —— `interval_days` / `due_at`：**这一讲已有的学习历史与排期身份**
 *   · item 级   —— `reading_cards.due_at`：**这一条知识点拿到首次认读资格了没有**
 *
 * 两件事的判据完全不同，混在一起的代价就是 F-2-② 这个 bug：
 * 为了给新条目一个认读窗口（item 级的理由），把整讲的间隔打回 1 天（lecture 级的代价）。
 *
 * 这个函数**只管 lecture 级**。item 级那一句 `where rc.due_at is null` 已经是对的，
 * 一个字都不动 —— 它早就正确地区分了「老条目保持自己的认读历史」和
 * 「新条目拿到第一次机会」。
 *
 * ── 规则从哪来 ────────────────────────────────────────────
 *
 * `interval_days` 是**这一讲的记忆保持期估计**（D-017 · SM-2）。
 * 它的合法更新来源只有一个：**一次真实测验的结果**（`settleLectures`）。
 * 重新分析不产生任何关于「他记不记得」的证据，所以它一个字都不该改。
 * 「重新开始」这个意图另有归宿 —— 右键的「打回待审阅」（`markUnread`）
 * 明写 `interval_days = 0`。两个动作各表达一个意图，判据只有一份。
 *
 * `due_at = 明天` 这条规则的**原始理由**写在 `docs/archive/study-flow.html` 阶段④：
 * 新条目要先过一遍认读，否则第一次产出作答测的是「你是否碰巧记得十分钟前
 * 列表里的一个词」—— 那是噪音，不是产出能力（M-019）。
 * 所以「明天」是**为新条目服务的**，不是这一讲的调度身份的一部分。
 * 下面让它只在那个理由真正成立时生效 —— 没有发明新判据，
 * 只是不再把它无条件套用到不适用的场合。
 */

export interface StartLearningFacts {
  /** 库里当前的间隔（天）。从没结算过 = 0 */
  interval: number
  /** 库里当前的排期。从没开始学过 = null */
  dueAt: number | null
  /**
   * 这一次会拿到首次认读资格的条目数（`reading_cards.due_at is null` 的那些）。
   *
   * 传**数量**而不是传 `boolean`：他在界面上要看到「3 条新知识点现在就能认读」，
   * 而那个数字必须和真正被写了 `due_at` 的行数是同一个数，不能各算各的。
   */
  fresh: number
  now: number
}

export interface StartLearningSchedule {
  interval: number
  dueAt: number
  /** 他在留痕和界面上看得见的一句话 —— 排期变了或者没变，都要说得出为什么 */
  reason: string
  /** 这一讲以前练过没有 —— 调用方用它决定文案，不用再自己判一遍 `interval > 0` */
  firstTime: boolean
}

/**
 * @param facts 库里当前的事实（**不要**在调用前先改它们）
 * @param cfg   `firstInterval` 从这里取，跟 D-179 高级区调的是同一份
 */
export function scheduleOnStart(
  facts: StartLearningFacts,
  cfg: LectureConfig = DEFAULT_LECTURE
): StartLearningSchedule {
  const firstTime = facts.interval <= 0

  /**
   * ① 间隔：有历史就原样保留，没有才给起步值。
   *
   * 用 `<= 0` 而不是 `=== 0`：负数是库被外力改坏了，那种情况下
   * 「当成没练过」是安全的方向 —— 总比拿一个负数去乘强。
   */
  const interval = firstTime ? cfg.firstInterval : facts.interval

  // ② 从没排过期（第一次开始学；或者归档时被清掉了）→ 明天
  if (facts.dueAt === null) {
    return {
      interval,
      dueAt: dueAfter(1, facts.now),
      reason: firstTime
        ? '第一次开始学 —— 先过一遍认读卡，明天开始产出练习'
        : `这个 Lecture 还没有排期 —— 间隔保持 ${interval} 天，明天开始产出练习`,
      firstTime
    }
  }

  /**
   * ③ 原排期还没到 → **一个字都不动**。
   *
   * 这一格就是 F-2-② 的正题：他的 12 天间隔和 D37 那个日子是**练出来的**，
   * 重新分析只是换了一批内容，凭什么把它提前到明天。
   *
   * 新条目在这一格也不吃亏 —— 它们的认读到期日现在就给了，
   * 从今天起就在认读队列里，到原排期那天有的是时间认熟。
   */
  if (overdueDays(facts.dueAt, facts.now) < 0) {
    return {
      interval,
      dueAt: facts.dueAt,
      reason:
        facts.fresh > 0
          ? `${facts.fresh} 条新知识点现在就能认读 —— 这个 Lecture 的间隔保持 ${interval} 天，产出练习仍按原排期`
          : `没有新知识点进来 —— 间隔保持 ${interval} 天，排期一个字没动`,
      firstTime
    }
  }

  /**
   * ④ 原排期已经到期或过期了。
   *
   *   · 有新条目 → 推到明天。**这是「明天」这条规则唯一真正适用的场合**：
   *     今天就考几条他连见都没见过的表达，测出来的是运气（M-019）。
   *     代价只有一天，而且间隔一点没丢。
   *   · 没有新条目 → **不许推迟**。逾期就是逾期，该今天练就今天练 ——
   *     否则「重新分析一下」会变成一个把作业往后拖的按钮。
   */
  if (facts.fresh > 0) {
    return {
      interval,
      dueAt: dueAfter(1, facts.now),
      reason:
        `原排期已经到了，而有 ${facts.fresh} 条新知识点还没认过 —— ` +
        `先认一遍，明天一起练。间隔保持 ${interval} 天`,
      firstTime
    }
  }

  return {
    interval,
    dueAt: facts.dueAt,
    reason: `没有新知识点进来 —— 间隔保持 ${interval} 天，这个 Lecture 已经到期，现在就能练`,
    firstTime
  }
}
