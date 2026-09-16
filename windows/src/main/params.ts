import { prefSays } from '@core/prefs.ts'
import type { Database } from 'better-sqlite3'
import { DEFAULT_GRADING, type GradingConfig } from '@core/grading.ts'
import { DEFAULT_LECTURE, type LectureConfig } from '@core/sm2-lecture.ts'
import { DEFAULT_READING, type ReadingConfig } from '@core/sm2-item.ts'
import {
  DEFAULT_QUESTIONS_PER_ITEM,
  QUESTIONS_PER_ITEM_MAX,
  QUESTIONS_PER_ITEM_MIN
} from '@core/qtype-plan.ts'
import type { ParamRow } from '@shared/api.ts'
import { Prefs } from './db/prefs.ts'

/**
 * 机制参数 · D-179 / O-201
 *
 * 「『5 次进攻坚区』『3 连正确静默』这些数是设计时定的、**未经验证**，
 *  必须留调节余地；但它们互相咬合，改动需明确提示。」
 *
 * **这一层必须真的接进算法**，否则设置页就是装饰 ——
 * 那正是这个项目反复警告的病（画了却点不动 / 显示了却不生效）。
 * 所以 Study 每次判分、排期都从这里取值，不用 core 的默认值。
 */

export interface Params {
  grading: GradingConfig
  lecture: LectureConfig
  reading: ReadingConfig
  dailyTarget: number
  /** D-229 · 认读每日软上限，超出自动顺延 */
  readingDailyCap: number
  /** ★ D-478 · 一次给一条知识点出几道题（使用者 2026-09-08 要求做成设置项） */
  questionsPerItem: number
}

export const DEFAULTS: Params = {
  grading: DEFAULT_GRADING,
  lecture: DEFAULT_LECTURE,
  reading: DEFAULT_READING,
  dailyTarget: 35,
  readingDailyCap: 100,
  questionsPerItem: DEFAULT_QUESTIONS_PER_ITEM
}

/** 每一项：存哪个 key、默认值、给使用者看的说明、改了会牵动什么。 */
export const PARAM_SPEC = [
  {
    key: 'silenceStreak',
    label: '练成所需连续正确',
    unit: '次',
    def: DEFAULTS.grading.silenceStreak,
    min: 1,
    max: 10,
    common: false,
    note: '改成 1 的话，「连续 3 次正确」这个门槛就消失了 —— 整套判定的意义都会变。',
    ref: 'D-017 / M-023'
  },
  {
    key: 'hardTrigger',
    label: '进攻坚区的触发次数',
    unit: '次',
    def: DEFAULTS.grading.hardTrigger,
    min: 2,
    max: 20,
    common: false,
    note: '调小了攻坚区会挤满，就失去「卡住的少数」这个意义；调大了卡住的条目会一直拖着整讲。',
    ref: 'D-025'
  },
  {
    key: 'graceAttempts',
    label: '建立期长度',
    unit: '次',
    def: DEFAULTS.grading.graceAttempts,
    min: 0,
    max: 10,
    common: false,
    note: '前几次作答里第 2 档不清零。早期语域不匹配几乎是必然的，没有这个宽限，大量条目会在 5 次内涌进攻坚区。',
    ref: 'D-226'
  },
  {
    key: 'minSample',
    label: '样本不足的阈值',
    unit: '条',
    def: DEFAULTS.lecture.minSample,
    min: 1,
    max: 30,
    common: false,
    note: '本次练的条数少于它，lecture 间隔就不动 —— 拿 4 条的正确率决定 30 条 lecture 的排期是噪音。',
    ref: 'D-139'
  },
  {
    key: 'readingSilenceDays',
    label: '认读线练成阈值',
    unit: '天',
    def: DEFAULTS.reading.silenceDays,
    min: 30,
    max: 730,
    common: false,
    note: '下次间隔超过它就算练成 —— 已经稳到不用再排了。',
    ref: 'D-135'
  },
  {
    key: 'dailyTarget',
    label: prefSays('param.dailyTarget'),
    unit: '条',
    def: DEFAULTS.dailyTarget,
    min: 1,
    max: 500,
    common: true,
    note: 'Today 也能直接改。实际条数会有出入 —— lecture 永远整取，不截断。',
    ref: 'D-027'
  },
  {
    key: 'questionsPerItem',
    label: prefSays('param.questionsPerItem'),
    unit: '道',
    def: DEFAULTS.questionsPerItem,
    min: QUESTIONS_PER_ITEM_MIN,
    max: QUESTIONS_PER_ITEM_MAX,
    common: true,
    note:
      '出厂 15 道（原来是「五档各 3 道」，档位 2026-09-08 取消）。' +
      '一次生成是一次 AI 调用，调大了更贵更慢；调到 3 以下，' +
      '「连续 3 次正确必须横跨 3 种题型」就无从谈起，所以下限是 3。',
    ref: 'D-478 / D-129'
  },
  {
    key: 'readingDailyCap',
    label: '认读每日软上限',
    unit: '张',
    def: DEFAULTS.readingDailyCap,
    min: 10,
    max: 1000,
    common: true,
    note: '超出的自动顺延。纯 SM-2 的欠债堆积是它最劝退的地方 —— 停练一周回来面对 300 张，多数人就此放弃。',
    ref: 'D-229'
  }
] as const

export class ParamStore {
  private prefs: Prefs
  constructor(private db: Database) {
    this.prefs = new Prefs(db)
  }

  /**
   * ★ Step 5A · 机制参数是**跟着人走**的偏好，住在 `user_preferences`。
   * 键名一个字没变（`param.dailyTarget`），V29 从 `settings` 搬过来并删掉了旧的。
   */
  private raw(key: string): number | null {
    const v = this.prefs.raw(`param.${key}`)
    if (v === null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  get(key: string, fallback: number): number {
    return this.raw(key) ?? fallback
  }

  set(key: string, value: number): void {
    const spec = PARAM_SPEC.find((s) => s.key === key)
    if (!spec) throw new Error(`没有这个参数：${key}`)
    const v = Math.max(spec.min, Math.min(spec.max, Math.round(value)))
    this.prefs.set(`param.${key}`, String(v))
  }

  /**
   * D-179 · 一键还原默认值。
   *
   * ★★ **写默认值，不删行**（D-435 / D-436 · 2026-09-02 改）。
   *   原来这里走 `prefs.del()` 裸删 `user_preferences` —— 那是张同步表，
   *   而删行**不立墓碑**（`TOMBSTONE_KINDS` 只覆盖六类实体，有意如此）。
   *   后果：在电脑上「还原默认」，**这个动作到不了手机** ——
   *   手机照旧用着他改过的值，两端悄悄分岔，而且谁都不报错。
   *
   *   写默认值就没这个问题：它是一次普通的行更新，跟着同步走。
   *   `list()` 的 `changed` 判据本来就是 `cur !== s.def`，
   *   所以显式存一份等于默认值的行，界面上照样显示「没偏离」。
   */
  reset(key?: string): void {
    const specs = key ? PARAM_SPEC.filter((s) => s.key === key) : PARAM_SPEC
    const tx = this.db.transaction(() => {
      for (const s of specs) this.prefs.set(`param.${s.key}`, String(s.def))
    })
    tx()
  }

  /** 给设置页看的清单，含「已偏离默认值」标记（D-179）。 */
  list(): ParamRow[] {
    return PARAM_SPEC.map((s) => {
      const cur = this.raw(s.key)
      return {
        key: s.key,
        label: s.label,
        unit: s.unit,
        value: cur ?? s.def,
        def: s.def,
        min: s.min,
        max: s.max,
        common: s.common,
        note: s.note,
        ref: s.ref,
        changed: cur !== null && cur !== s.def
      }
    })
  }

  /** 真正喂给算法的那份。**Study 每次都从这里取，不用 core 的默认值。** */
  effective(): Params {
    return {
      grading: {
        silenceStreak: this.get('silenceStreak', DEFAULTS.grading.silenceStreak),
        hardTrigger: this.get('hardTrigger', DEFAULTS.grading.hardTrigger),
        graceAttempts: this.get('graceAttempts', DEFAULTS.grading.graceAttempts)
      },
      lecture: {
        ...DEFAULTS.lecture,
        minSample: this.get('minSample', DEFAULTS.lecture.minSample)
      },
      reading: {
        ...DEFAULTS.reading,
        silenceDays: this.get('readingSilenceDays', DEFAULTS.reading.silenceDays)
      },
      dailyTarget: this.get('dailyTarget', DEFAULTS.dailyTarget),
      readingDailyCap: this.get('readingDailyCap', DEFAULTS.readingDailyCap),
      questionsPerItem: this.get('questionsPerItem', DEFAULTS.questionsPerItem)
    }
  }
}
