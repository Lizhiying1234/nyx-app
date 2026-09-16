/**
 * 学习那一半的金标准向量：sm2-item · sm2-lecture · grading · silence ·
 * daily-match · qtypes/progression · drills
 *
 * 与时区无关的模块全在这里。用到「今天」的（dueAfter / overdueDays /
 * start-learning）在 `generate-calendar.ts`，那份要按时区分别录。
 */

import { join } from 'node:path'
import { rec, write, type Vector } from './util.ts'

import {
  DEFAULT_READING,
  newCardState,
  intervalFor,
  previewIntervals,
  applyReadingGrade,
  penalizeFromHint,
  type CardState,
  type ReadingConfig
} from '../../2-可移植资产/core/sm2-item.ts'
import {
  DEFAULT_LECTURE,
  nextLectureInterval,
  type LectureConfig
} from '../../2-可移植资产/core/sm2-lecture.ts'
import {
  DEFAULT_GRADING,
  newItemProgress,
  applyGrade,
  explainDistance,
  type GradingConfig,
  type ItemProgress
} from '../../2-可移植资产/core/grading.ts'
import {
  isItemSilent,
  shouldRetireReadingCard,
  rollup,
  rollupLecture,
  rollupUnit,
  rollupProject,
  type ItemLines
} from '../../2-可移植资产/core/silence.ts'
import { matchToday, type DueLecture } from '../../2-可移植资产/core/daily-match.ts'
import {
  QTYPES,
  ALL_QTYPE_IDS,
  typesInTier,
  usableTypes,
  qtypeById
} from '../../2-可移植资产/core/qtypes.ts'
import {
  tierFor,
  questionTypeFor,
  typeFor,
  contextFor,
  limitFor,
  planFor,
  questionBankPlan,
  detailPlan,
  type Tier
} from '../../2-可移植资产/core/progression.ts'
import { normalizeDrills } from '../../2-可移植资产/core/drills.ts'
import {
  GRADE_NAMES,
  READING_GRADE_NAMES,
  PRODUCTION_STATE_NAMES,
  CONTEXT_DISTANCE_NAMES,
  QUESTION_TYPES,
  type Grade,
  type ProductionState,
  type ReadingGrade
} from '../../2-可移植资产/core/types.ts'

const OUT = join(import.meta.dirname, '..', '..', 'core', 'src', 'test', 'resources', 'golden')
const SOURCE = '2-可移植资产/core（Windows v1.0-stable · schema V25）'
const GRADES: Grade[] = [1, 2, 3, 4]
const RGRADES: ReadingGrade[] = [1, 2, 3, 4]
const TIERS: Tier[] = [1, 2, 3, 4, 5]

// ══════════════════════════════════════════════════════════════
// types.ts —— 四个名字表。它们是界面上的字，错一个字使用者立刻看得见
// ══════════════════════════════════════════════════════════════
write(join(OUT, 'types.json'), {
  module: 'types',
  source: SOURCE,
  zone: null,
  groups: {
    GRADE_NAMES: [{ in: null, out: GRADE_NAMES }],
    READING_GRADE_NAMES: [{ in: null, out: READING_GRADE_NAMES }],
    PRODUCTION_STATE_NAMES: [{ in: null, out: PRODUCTION_STATE_NAMES }],
    CONTEXT_DISTANCE_NAMES: [{ in: null, out: CONTEXT_DISTANCE_NAMES }],
    QUESTION_TYPES: [{ in: null, out: QUESTION_TYPES }]
  }
})

// ══════════════════════════════════════════════════════════════
// sm2-item · 认读线
// ══════════════════════════════════════════════════════════════
const READING_CFGS: Record<string, ReadingConfig> = {
  default: DEFAULT_READING,
  // 高级区调过的一套（D-179）——「参数可配，别写死」要真的被验到
  tuned: {
    initialEase: 2.0,
    minEase: 1.5,
    maxEase: 3.0,
    silenceDays: 30,
    newCard: { 1: 1, 2: 2, 3: 4, 4: 8 }
  }
}

const CARDS: Record<string, CardState> = {
  fresh: { ease: 2.5, interval: 0, reps: 0, lapses: 0, silent: false },
  // reps===1 那一格是 intervalFor 里唯一的特例（第 3 档给 3 天而不是乘 ease）
  reps1: { ease: 2.5, interval: 1, reps: 1, lapses: 0, silent: false },
  reps2: { ease: 2.5, interval: 3, reps: 2, lapses: 0, silent: false },
  mid: { ease: 2.3, interval: 10, reps: 4, lapses: 1, silent: false },
  floorEase: { ease: 1.3, interval: 3, reps: 2, lapses: 5, silent: false },
  ceilEase: { ease: 2.5, interval: 20, reps: 6, lapses: 0, silent: false },
  // 下面两张专为 silenceDays 的边界：170×2.5×1.3 = 552 > 180 → 静默
  nearSilence: { ease: 2.5, interval: 100, reps: 9, lapses: 0, silent: false },
  overSilence: { ease: 2.5, interval: 170, reps: 12, lapses: 0, silent: false },
  // reps 有值但 interval 是 0（库被外力改过的形状）—— 不该崩
  weird: { ease: 2.5, interval: 0, reps: 3, lapses: 0, silent: false },
  // 已静默：applyReadingGrade 必须抛错，那是明确的设计
  silent: { ease: 2.5, interval: 200, reps: 14, lapses: 0, silent: true }
}

{
  const intervalForV: Vector[] = []
  const previewV: Vector[] = []
  const applyV: Vector[] = []
  const hintV: Vector[] = []
  const newStateV: Vector[] = []

  for (const [cfgName, cfg] of Object.entries(READING_CFGS)) {
    newStateV.push({ in: { cfg: cfgName }, out: newCardState(cfg) })
    for (const [cardName, card] of Object.entries(CARDS)) {
      previewV.push({ in: { card: cardName, cfg: cfgName }, out: previewIntervals(card, cfg) })
      hintV.push({ in: { card: cardName, cfg: cfgName }, out: rec(() => penalizeFromHint(card, cfg)) })
      for (const g of RGRADES) {
        intervalForV.push({ in: { card: cardName, grade: g, cfg: cfgName }, out: intervalFor(card, g, cfg) })
        applyV.push({
          in: { card: cardName, grade: g, cfg: cfgName },
          out: rec(() => applyReadingGrade(card, g, cfg))
        })
      }
    }
  }

  write(join(OUT, 'sm2-item.json'), {
    module: 'sm2-item',
    source: SOURCE,
    zone: null,
    groups: {
      DEFAULT_READING: [{ in: null, out: DEFAULT_READING }],
      configs: [{ in: null, out: READING_CFGS }],
      cards: [{ in: null, out: CARDS }],
      newCardState: newStateV,
      intervalFor: intervalForV,
      previewIntervals: previewV,
      applyReadingGrade: applyV,
      penalizeFromHint: hintV
    }
  })
}

// ══════════════════════════════════════════════════════════════
// sm2-lecture · 产出线的 lecture 级排期（不含日历部分）
// ══════════════════════════════════════════════════════════════
const LECTURE_CFGS: Record<string, LectureConfig> = {
  default: DEFAULT_LECTURE,
  tuned: { firstInterval: 2, minSample: 3, resetTo: 2 }
}

{
  const v: Vector[] = []
  const currents = [0, 1, 4, 12, 30, 365]
  // 每一个乘数带的边界都取到：<0.5 / =0.5 / <0.75 / =0.75 / <=0.9 / >0.9
  const accuracies = [0, 0.3, 0.4999, 0.5, 0.6, 0.7499, 0.75, 0.8, 0.9, 0.9001, 1]
  const samples = [0, 1, 2, 3, 4, 5, 10]
  for (const [cfgName, cfg] of Object.entries(LECTURE_CFGS)) {
    for (const current of currents) {
      for (const accuracy of accuracies) {
        for (const sample of samples) {
          v.push({
            in: { current, accuracy, sample, cfg: cfgName },
            out: nextLectureInterval(current, accuracy, sample, cfg)
          })
        }
      }
    }
  }
  write(join(OUT, 'sm2-lecture.json'), {
    module: 'sm2-lecture',
    source: SOURCE,
    zone: null,
    groups: {
      DEFAULT_LECTURE: [{ in: null, out: DEFAULT_LECTURE }],
      configs: [{ in: null, out: LECTURE_CFGS }],
      nextLectureInterval: v
    }
  })
}

// ══════════════════════════════════════════════════════════════
// grading · 产出线判分与状态机
// ══════════════════════════════════════════════════════════════
const GRADING_CFGS: Record<string, GradingConfig> = {
  default: DEFAULT_GRADING,
  tuned: { silenceStreak: 2, hardTrigger: 3, graceAttempts: 1 }
}

const PROGRESS: Record<string, ItemProgress> = {
  new: newItemProgress(),
  // 建立期内（attempts < graceAttempts）—— 第 2 档不推进也不清零
  grace1: { state: 'training', streak: 0, attempts: 1, attemptsInStage: 1, corrects: 0, hardEntries: 0 },
  grace2: { state: 'training', streak: 1, attempts: 2, attemptsInStage: 2, corrects: 1, hardEntries: 0 },
  // 第 3 次作答仍在建立期（attempts+1 <= 3），第 4 次就不是了 —— 边界
  graceEdge: { state: 'training', streak: 0, attempts: 2, attemptsInStage: 2, corrects: 0, hardEntries: 0 },
  pastGrace: { state: 'training', streak: 0, attempts: 3, attemptsInStage: 3, corrects: 1, hardEntries: 0 },
  // 再对一次就静默
  nearSilent: { state: 'training', streak: 2, attempts: 6, attemptsInStage: 3, corrects: 5, hardEntries: 0 },
  // 再练一次就满 5 次 → 进攻坚区
  nearHard: { state: 'training', streak: 1, attempts: 8, attemptsInStage: 4, corrects: 4, hardEntries: 0 },
  // 静默与攻坚同一次作答同时满足时，谁先判 —— 这一格必须钉死
  bothTriggers: { state: 'training', streak: 2, attempts: 9, attemptsInStage: 4, corrects: 6, hardEntries: 0 },
  hardFresh: { state: 'hard', streak: 0, attempts: 10, attemptsInStage: 0, corrects: 4, hardEntries: 1 },
  hardNearOut: { state: 'hard', streak: 2, attempts: 14, attemptsInStage: 4, corrects: 8, hardEntries: 1 },
  hardTwice: { state: 'hard', streak: 1, attempts: 22, attemptsInStage: 9, corrects: 11, hardEntries: 2 },
  silent: { state: 'silent', streak: 3, attempts: 12, attemptsInStage: 3, corrects: 9, hardEntries: 0 }
}

{
  const applyV: Vector[] = []
  const explainV: Vector[] = []
  for (const [cfgName, cfg] of Object.entries(GRADING_CFGS)) {
    for (const [pName, p] of Object.entries(PROGRESS)) {
      explainV.push({ in: { progress: pName, cfg: cfgName }, out: explainDistance(p, cfg) })
      for (const g of GRADES) {
        applyV.push({ in: { progress: pName, grade: g, cfg: cfgName }, out: rec(() => applyGrade(p, g, cfg)) })
      }
    }
  }
  write(join(OUT, 'grading.json'), {
    module: 'grading',
    source: SOURCE,
    zone: null,
    groups: {
      DEFAULT_GRADING: [{ in: null, out: DEFAULT_GRADING }],
      configs: [{ in: null, out: GRADING_CFGS }],
      progresses: [{ in: null, out: PROGRESS }],
      newItemProgress: [{ in: null, out: newItemProgress() }],
      applyGrade: applyV,
      explainDistance: explainV
    }
  })
}

// ══════════════════════════════════════════════════════════════
// silence · 静默判定与三级上卷
// ══════════════════════════════════════════════════════════════
{
  const itemV: Vector[] = []
  const retireV: Vector[] = []
  const states: ProductionState[] = ['new', 'training', 'hard', 'silent']
  for (const production of states) {
    for (const productionApplies of [true, false]) {
      for (const readingSilent of [true, false]) {
        const item: ItemLines = { production, productionApplies, readingSilent }
        itemV.push({ in: item, out: isItemSilent(item) })
        retireV.push({ in: item, out: shouldRetireReadingCard(item) })
      }
    }
  }

  const childSets: boolean[][] = [
    [],
    [true],
    [false],
    [true, true],
    [true, false],
    [false, true],
    [true, true, true],
    [true, true, false],
    [true, false, true, false, true, false, true] // 4/7 → 57%，验四舍五入
  ]
  const rollupV: Vector[] = []
  const lecV: Vector[] = []
  const unitV: Vector[] = []
  const projV: Vector[] = []
  for (const c of childSets) {
    rollupV.push({ in: { children: c, label: '容器' }, out: rollup(c) })
    rollupV.push({ in: { children: c, label: '自定义' }, out: rollup(c, '自定义') })
    lecV.push({ in: c, out: rollupLecture(c) })
    unitV.push({ in: c, out: rollupUnit(c) })
    projV.push({ in: c, out: rollupProject(c) })
  }

  write(join(OUT, 'silence.json'), {
    module: 'silence',
    source: SOURCE,
    zone: null,
    groups: {
      isItemSilent: itemV,
      shouldRetireReadingCard: retireV,
      rollup: rollupV,
      rollupLecture: lecV,
      rollupUnit: unitV,
      rollupProject: projV
    }
  })
}

// ══════════════════════════════════════════════════════════════
// daily-match · 半数规则
// ══════════════════════════════════════════════════════════════
{
  const L = (lectureId: number, dueAt: number, pending: number, name?: string): DueLecture =>
    name === undefined ? { lectureId, dueAt, pending } : { lectureId, dueAt, pending, name }

  const cases: { target: number; due: DueLecture[] }[] = [
    { target: 30, due: [] },
    { target: 30, due: [L(1, 100, 0), L(2, 200, 0)] }, // 全空 → 视同没有
    { target: 10, due: [L(1, 100, 20)] }, // 10 >= 20/2 恰好取到 —— `>=` 的边界
    { target: 10, due: [L(1, 100, 21)] }, // 10 >= 10.5 不成立 → 停
    { target: 0, due: [L(1, 100, 4)] },
    { target: 30, due: [L(3, 300, 10), L(1, 100, 12), L(2, 200, 8)] }, // 乱序进，按 dueAt 排
    { target: 30, due: [L(1, 100, 12), L(2, 200, 0), L(3, 300, 8)] }, // 中间夹一个空讲
    { target: 35, due: [L(1, 100, 20), L(2, 200, 20), L(3, 300, 20)] }, // 收 2 个超额，第 3 个停
    { target: 100, due: [L(1, 100, 5, 'L1'), L(2, 200, 7, 'L2')] }, // 全收，带名字
    { target: 5, due: [L(1, 100, 30)] }, // 第一个就收不下 → picked 空
    { target: 30, due: [L(1, 100, 1), L(2, 100, 1)] } // dueAt 相同 → 稳定顺序
  ]
  write(join(OUT, 'daily-match.json'), {
    module: 'daily-match',
    source: SOURCE,
    zone: null,
    groups: {
      matchToday: cases.map((c) => ({ in: c, out: matchToday(c.target, c.due) }))
    }
  })
}

// ══════════════════════════════════════════════════════════════
// qtypes + progression · 递进
//
// ★ 这一份的用途和别的不一样：使用者裁决「qtypes 表是唯一事实来源」，
//   Kotlin 侧不保留运行时常量。所以这份向量录的是
//   **「用出厂那 12 条当表内容时，行为与 Windows 逐字节相同」**——
//   也就是裁决里那句「旧 Windows 的 12 个默认题型行为完全不变」的可执行形式。
//   「新增 qtype 不回退 tier 1」是新契约，TS 里没有对应物，在 Kotlin 侧单独测。
// ══════════════════════════════════════════════════════════════
{
  const ENABLED_SETS: Record<string, readonly string[] | null> = {
    null: null,
    all: ALL_QTYPE_IDS,
    canonicalOnly: QTYPES.filter((q) => q.canonical).map((q) => q.id),
    noneOfTier1: ALL_QTYPE_IDS.filter((id) => qtypeById(id)!.tier !== 1), // 第 1 档全没勾 → 退回 canonical
    empty: [],
    unknownOnly: ['根本不存在的题型'],
    single: ['开放填空'],
    twoInTier2: ['释义改写', '句子合并']
  }

  const typesInTierV: Vector[] = TIERS.map((t) => ({ in: t, out: typesInTier(t) }))
  const usableV: Vector[] = []
  const typeForV: Vector[] = []
  const planForV: Vector[] = []
  const bankV: Vector[] = []
  for (const [name, enabled] of Object.entries(ENABLED_SETS)) {
    bankV.push({ in: { enabled: name }, out: questionBankPlan(enabled) })
    for (const t of TIERS) {
      usableV.push({ in: { tier: t, enabled: name }, out: usableTypes(t, enabled) })
      for (const seq of [0, 1, 2, 3, 7]) {
        typeForV.push({ in: { tier: t, enabled: name, seq }, out: typeFor(t, enabled, seq) })
      }
    }
    for (const corrects of [0, 1, 2, 3, 4, 5, 9]) {
      for (const seq of [0, 1, 2]) {
        planForV.push({ in: { corrects, enabled: name, seq }, out: planFor(corrects, enabled, seq) })
      }
    }
  }

  write(join(OUT, 'qtypes.json'), {
    module: 'qtypes',
    source: SOURCE,
    zone: null,
    groups: {
      QTYPES: [{ in: null, out: QTYPES }],
      ALL_QTYPE_IDS: [{ in: null, out: ALL_QTYPE_IDS }],
      enabledSets: [{ in: null, out: ENABLED_SETS }],
      typesInTier: typesInTierV,
      usableTypes: usableV,
      qtypeById: [...ALL_QTYPE_IDS, '不存在的', ''].map((id) => ({ in: id, out: qtypeById(id) })),
      tierFor: [0, 1, 2, 3, 4, 5, 6, 20].map((c) => ({ in: c, out: tierFor(c) })),
      questionTypeFor: TIERS.map((t) => ({ in: t, out: questionTypeFor(t) })),
      contextFor: TIERS.map((t) => ({ in: t, out: contextFor(t) })),
      limitFor: [...ALL_QTYPE_IDS, '不存在的'].map((id) => ({ in: id, out: limitFor(id) })),
      typeFor: typeForV,
      planFor: planForV,
      questionBankPlan: bankV,
      detailPlan: [0, 1, 2, 3, 4, 9].map((c) => ({ in: c, out: detailPlan(c) }))
    }
  })
}

// ══════════════════════════════════════════════════════════════
// drills · 小操练字段归一
// ══════════════════════════════════════════════════════════════
{
  const raws: (string | null | undefined)[] = [
    null,
    undefined,
    '',
    '   ',
    '不是 JSON',
    '{}',
    '[]',
    '[null, 3, "x", true]',
    '[{"q":"Fill this in","answer":"a"}]',
    '[{"prompt":"老字段","answer":"b"}]', // analyse-item.md 出的那种
    '[{"q":"  ","prompt":"退回 prompt","answer":"c"}]', // q 是空白 → 退 prompt
    '[{"q":"两个都有","prompt":"忽略我","answer":"d"}]',
    '[{"answer":"没有题面"}]', // 题面空 → 整条丢掉
    '[{"q":"  带空白  ","answer":"  答案不 trim  "}]',
    '[{"q":"没有 answer"}]',
    '[{"q":"answer 不是字符串","answer":42}]',
    '[{"q":"带 type","answer":"e","type":" 造句 "}]',
    '[{"q":"type 是空白","answer":"f","type":"   "}]',
    '[{"q":"a","answer":"1"},{"prompt":"b","answer":"2"},{"answer":"丢"}]'
  ]
  write(join(OUT, 'drills.json'), {
    module: 'drills',
    source: SOURCE,
    zone: null,
    groups: {
      normalizeDrills: raws.map((r) => ({ in: r ?? null, out: normalizeDrills(r) }))
    }
  })
}

console.log('学习那一半：录完。')
