/**
 * 「为什么」那几句话用的阈值 · T-4.12（2026-09-07）
 *
 * ── 规矩：每个数都要说得出出处 ──────────────────────────────
 *
 * 报告里最容易出的错不是算错，是**拿一个谁也说不清哪来的数当判据**。
 * 「这 7 个词两周内查过 3 次以上却没练」听起来很像结论，
 * 可要是 3 和两周是我随手定的，那它只是一句**装成结论的猜测**。
 *
 * 所以这里每一项都配一句来源（`THRESHOLD_SOURCES`），并且分两种：
 *   · 从决议 / 使用者原话来的 —— 写清是哪一条，改它要走那条的流程
 *   · 我定的 —— **必须**带「★ 主控定、可调」六个字（D-413：我提的规则要标出来）
 *
 * `thresholds.test.ts` 逐项守着这条：漏一项、或者拍的数没标记，当场红。
 * 页面上（T-4.11）把 `source` 原样显示出来 —— 他看得见这个数是谁定的。
 *
 * ★ 所以下面那几句是**印给他看的文字**，不是注释：里面不许出现 Markdown 记号
 *   （`**粗体**`、反引号）—— 报告页会一个字不改地印出来，截图上当场露馅。
 */

import { DEFAULT_GRADING } from '../grading.ts'

export interface Thresholds {
  /** 「最近」是多久 */
  windowDays: number
  /** 查过几次算「反复查」 */
  lookupRepeats: number
  /** 第一次判定里挂过几次算「反复失败」 */
  weakFails: number
  /** 连续判对几次算「稳定通过」 */
  strongStreak: number
  /** 榜上列几条 */
  topN: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  windowDays: 14,
  lookupRepeats: 3,
  weakFails: 2,
  strongStreak: DEFAULT_GRADING.silenceStreak,
  topN: 7
}

/**
 * 每个阈值的出处。**页面直接显示这几句**，所以写成人话，不写成代码引用。
 *
 * ★ 「★ 主控定、可调」这六个字是机器判据（见 `thresholds.test.ts`），
 *   不是修辞 —— 别改成「我定的」「暂定」之类的近义词。
 */
export const THRESHOLD_SOURCES: Record<keyof Thresholds, string> = {
  windowDays:
    '使用者 2026-09-07 第四批原话里的「两周内」（T-4.12 目标：「这 7 个词两周内查过 3 次以上却没练」）',
  lookupRepeats: '同一句原话里的「3 次以上」',
  weakFails:
    '★ 主控定、可调 —— D-025 的判据是「本阶段练满 5 次仍没做到 3 连才进攻坚区」；' +
    '报告要的是比攻坚区更早的信号，所以取「挂过 2 次」。判分一个字没动，攻坚区还是 5 次',
  strongStreak:
    'D-017 / M-023 · DEFAULT_GRADING.silenceStreak（连续 3 次正确即算练成）—— ' +
    '与判分同一个数，不在报告里另立一份',
  topN: '使用者同一句原话里的「这 7 个词」；页面上实际列几条由 T-4.11 决定'
}

/** 「主控定的数」长这样 —— 判据在 `thresholds.test.ts`，改文案要一起改 */
export const OWN_CALL_MARK = '★ 主控定、可调'
