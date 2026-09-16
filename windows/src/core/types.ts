/**
 * core/ 的公共类型 · D-238
 *
 * 这一层是**业务逻辑的真相**：两套 SM-2、四档判分、状态机、静默判定、半数规则匹配。
 * 铁律：**本目录下一行 import 都不许指向 electron / svelte / better-sqlite3。**
 * 判据很简单 —— 它必须能用 `node --test src/core` 直接跑，不启动应用。
 * 将来做手机端时，这一整个目录原样搬走。
 */

/** 四档语用刻度 · D-119 / M-016 —— 形式 → 语域 → 得体 → 分寸 */
export type Grade = 1 | 2 | 3 | 4

export const GRADE_NAMES: Record<Grade, string> = {
  1: '用错',
  2: '可懂但不地道',
  3: '准确得体',
  4: '分寸到位'
}

/** 认读卡自评四档 · D-017 / D-093 —— 与判分四档是两套东西，别混 */
export type ReadingGrade = 1 | 2 | 3 | 4

export const READING_GRADE_NAMES: Record<ReadingGrade, string> = {
  1: '忘了',
  2: '想了一下',
  3: '会',
  4: '太简单'
}

import { SILENCE_FILTER_NAME } from './silence.ts'

/** 产出线状态 · D-084 */
export type ProductionState = 'new' | 'training' | 'hard' | 'silent'

/**
 * ★ 终点那一档叫 `SILENCE_FILTER_NAME`（2026-09-15 · D-489）。
 *   使用者裁「已练成」这个说法退役；而这一档、Vault 那个预设、⋮ 上那个动作
 *   **说的是同一件事**，所以它们只许有一个名字，从一处来。
 * ☆ `silence.ts` 只从这里 `import type`，运行期没有环。
 */
export const PRODUCTION_STATE_NAMES: Record<ProductionState, string> = {
  new: '未开始',
  training: '训练中',
  hard: '攻坚区',
  silent: SILENCE_FILTER_NAME
}

/**
 * 题型是**使用者可以自己增删改的**（V17 之后），所以它的身份是一个字符串 key，
 * 不是一个字面量联合类型。
 *
 * 这里原来写死着五种（`QUESTION_TYPES = ['造句', ...]` + 由它派生的 `QuestionType`）。
 * 那是 D-116 最初的样子，V17 把题型搬进 `qtypes` 表之后它就名不副实了：
 * 库里存的是 key 字符串，他可以加第 13 种、可以改名、可以停用，
 * 而那个联合类型永远只认最早的五个。F-③ 删掉它 ——
 * **出厂的那 12 种在 `core/qtypes.ts::QTYPES` 里，那才是真的那一份。**
 *
 * 绝不出现选择题 / 连线题 / 选项式完形填空（M-028）—— 那条约束由
 * `qtypes.test.ts` 逐条扫出厂题型的文案来守，不靠类型。
 */
export type QuestionType = string

/** 语境距离 · D-132 / M-014 —— 难度的第三个维度 */
export type ContextDistance = 'original' | 'near' | 'far' | 'unseen'

export const CONTEXT_DISTANCE_NAMES: Record<ContextDistance, string> = {
  original: '原语境',
  near: '原语境的延伸话题',
  far: '相邻领域',
  unseen: '完全陌生的场景'
}
