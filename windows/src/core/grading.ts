import type { Grade, ProductionState } from './types.ts'
import { GRADE_NAMES } from './types.ts'
import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from './silence.ts'

/**
 * 产出线的判分与状态机 · D-119 / D-121 / D-133 / D-226 / D-025 / D-166 / M-023
 *
 * 这是整个软件的核心判断。它回答一件事：**这一次作答之后，这条知识点该往哪走。**
 */

export interface GradingConfig {
  /** 连续几次正确算静默 · D-017 / M-023 */
  silenceStreak: number
  /** 本阶段练满几次仍没做到 3 连，就进攻坚区 · D-025 */
  hardTrigger: number
  /** 前几次作答属于建立期，此期间第 2 档不推进也不清零 · D-226 */
  graceAttempts: number
}

/** 默认值。这几个数互相咬合，改动要走设置页高级区并标「已偏离默认值」（D-179 / O-201）。 */
export const DEFAULT_GRADING: GradingConfig = {
  silenceStreak: 3,
  hardTrigger: 5,
  graceAttempts: 3
}

export interface ItemProgress {
  state: ProductionState
  /** 连续正确次数 */
  streak: number
  /** 累计第一次判定的次数 —— **只记第一次作答**（D-121 / M-019） */
  attempts: number
  /** 进入当前阶段（训练中 / 攻坚区）之后练了几次，用于 5 次触发 */
  attemptsInStage: number
  /** 累计答对次数，题型递进按它走（见 progression.ts） */
  corrects: number
  /** 进过攻坚区几次 · D-166 —— 进过两次以上值得复核判层 */
  hardEntries: number
}

export function newItemProgress(): ItemProgress {
  return { state: 'new', streak: 0, attempts: 0, attemptsInStage: 0, corrects: 0, hardEntries: 0 }
}

export interface GradeOutcome {
  progress: ItemProgress
  /** 第 3、4 档算正确；第 2 档算失败 · D-133 */
  correct: boolean
  silenced: boolean
  enteredHard: boolean
  leftHard: boolean
  /** 这一次落在建立期里，第 2 档被豁免了 · D-226 */
  graced: boolean
  /**
   * 人话解释。界面上任何时候都要能回答「为什么这条还没进攻坚区 / 为什么它静默了」——
   * 不许出现「状态变了但说不出为什么」。
   */
  reason: string
}

/**
 * 判定一次作答。
 *
 * **只在第一次作答时调用**（D-121）。改到过关是「不能跳过」的门槛，不计入进度 ——
 * 第一次作答是唯一诚实的样本，改到对为止练的是「照着反馈修改」，那是另一种能力。
 */
export function applyGrade(
  prev: ItemProgress,
  grade: Grade,
  cfg: GradingConfig = DEFAULT_GRADING
): GradeOutcome {
  if (prev.state === 'silent') {
    // 静默条目除手动放出外不出现在任何测试中（D-024）。走到这里就是上游有 bug，
    // 必须炸出来 —— 悄悄改一条已静默条目的进度，正是「数据静默出错」的典型。
    throw new Error(
      `这条已经不用再练了，不该再判分。要重新练它，先${SILENCE_ACTIONS.restore}（D-024）。`
    )
  }

  const p: ItemProgress = { ...prev }
  p.attempts += 1
  p.attemptsInStage += 1

  const correct = grade >= 3
  const inGrace = p.attempts <= cfg.graceAttempts
  let graced = false

  if (correct) {
    p.streak += 1
    p.corrects += 1
  } else if (grade === 2 && inGrace) {
    // D-226 · 早期语域不匹配几乎是必然的（那正是「读得懂但产不出」的典型症状）。
    // 不给宽限，大量条目会在 5 次内涌进攻坚区，攻坚区就从「卡住的少数」变成「大多数」。
    graced = true
  } else {
    p.streak = 0
  }

  const bits: string[] = [`第 ${grade} 档「${GRADE_NAMES[grade]}」`]
  if (graced) bits.push(`建立期第 ${p.attempts}/${cfg.graceAttempts} 次，不推进也不清零`)
  else if (correct) bits.push(`连续正确 ${p.streak}/${cfg.silenceStreak}`)
  else bits.push('连续正确清零')

  let silenced = false
  let enteredHard = false
  let leftHard = false

  if (p.state === 'hard') {
    if (p.streak >= cfg.silenceStreak) {
      // D-166 · 攻坚区解决的是「卡住」，不是「毕业」。
      // 那里的练法是高提示的（D-134），在那里达标不等于正常语境里能用出来。
      p.state = 'training'
      p.streak = 0
      p.attemptsInStage = 0
      leftHard = true
      bits.push('攻出来了，回原 lecture 继续在练（连续正确重新计）')
    }
  } else {
    if (p.state === 'new') p.state = 'training'

    if (p.streak >= cfg.silenceStreak) {
      p.state = 'silent'
      silenced = true
      bits.push(`连续 ${cfg.silenceStreak} 次正确 —— 练成了`)
    } else if (p.attemptsInStage >= cfg.hardTrigger) {
      // D-025 · 移出 lecture，不再拖住整讲。
      p.state = 'hard'
      p.streak = 0
      p.attemptsInStage = 0
      p.hardEntries += 1
      enteredHard = true
      bits.push(`这个 Lecture 练满 ${cfg.hardTrigger} 次仍没做到 3 连 —— 进攻坚区（第 ${p.hardEntries} 次）`)
    }
  }

  return { progress: p, correct, silenced, enteredHard, leftHard, graced, reason: bits.join(' · ') }
}

/**
 * 一条知识点离静默还差多少 —— 给界面用，让「为什么它还没静默」随时答得出来。
 */
export function explainDistance(p: ItemProgress, cfg: GradingConfig = DEFAULT_GRADING): string {
  switch (p.state) {
    case 'silent':
      /** ★ 「已练成」2026-09-15 退役（D-489）。这一格答的是「它还差多远」—— 答案是「到了」 */
      return `${SILENCE_FILTER_NAME}中 —— 不再出题`
    case 'new':
      return `还没练过 · 需要连续 ${cfg.silenceStreak} 次第 3 档以上`
    case 'hard':
      return `攻坚区 · 已连续 ${p.streak}/${cfg.silenceStreak}，攻出去先回 lecture，不直接算练成`
    case 'training':
      return (
        `连续 ${p.streak}/${cfg.silenceStreak}` +
        ` · 本阶段已练 ${p.attemptsInStage}/${cfg.hardTrigger} 次` +
        (p.attempts < cfg.graceAttempts
          ? ` · 建立期还剩 ${cfg.graceAttempts - p.attempts} 次（第 2 档暂不清零）`
          : '')
      )
  }
}
