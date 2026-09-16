/**
 * 语音 · 类型骨架 · D-466（使用者 2026-09-07「语音设置简化」）
 *
 * ── 只有两档 ────────────────────────────────────────────────
 *
 *   ① **词典语音** —— 词典自身带的原生音频（真人录的，已经在他硬盘上）
 *   ② **系统语音** —— 设备 / 系统自带的 TTS，零配置、永远在
 *
 * 两个开关**默认都开**，顺序**写死**：词典有音就用词典，没有就用系统，
 * 两个都关就说一句话。没有厂商、没有 Tab、没有来源排序、没有云端、没有缓存。
 *
 * ── 判据进 core，执行留平台（D-238）────────────────────────
 *
 *   `resolve()`      纯函数：两把开关 + 可用性 + kind → **带预算的尝试序列**
 *   `runVoicePlan()` 也在 core：**预算的执行**必须只有一份，
 *                    否则「词典慢查阻塞系统音」会在每个平台上各犯一次
 *   执行器           平台各一份，只负责「这一步具体怎么做」
 *
 * ★ 这里原来有一整套「资源 / 提供者」的分层、八家提供者的 id、旧 id 翻译表、
 *   以及一个叫 `SourcePref` 的「有序列表 + 每项开关」。D-466 把那条线整条撤了：
 *   两档之间没有顺序可排，所以偏好就是两个布尔量，不是一份清单。
 */

/** 读的是一个词、一个短语、一句话，还是一整段 */
export type VoiceKind = 'word' | 'phrase' | 'sentence' | 'passage'

/** 从哪儿点的读。**只用于记账与守卫，不参与选谁读** —— 见 `resolve()` 里那条注释 */
export type VoiceOrigin = 'lookup' | 'ai-search' | 'assist' | 'reading' | 'practice' | 'detail'

export interface VoiceRequest {
  text: string
  kind: VoiceKind
  origin: VoiceOrigin
}

/** 两档，就这两档 */
export type SourceId = 'dictionary' | 'system'

export const ALL_SOURCE_IDS: readonly SourceId[] = ['dictionary', 'system']

export const isSourceId = (v: unknown): v is SourceId =>
  typeof v === 'string' && (ALL_SOURCE_IDS as readonly string[]).includes(v)

/** 人看的名字 —— 界面、日志、账本共用这一份，不各写各的 */
export const SOURCE_LABEL: Readonly<Record<SourceId, string>> = {
  dictionary: '词典语音',
  system: '系统语音'
}

/**
 * 两把开关 —— **这就是全部的语音偏好**（外加口音与语速）。
 *
 * ★ 出厂都是 `true`（使用者原话：「这两个选项默认都开启」）。
 *   默认值只有一处（`DEFAULT_SWITCHES`），平台读不到偏好时回它。
 */
export interface VoiceSwitches {
  dictionary: boolean
  system: boolean
}

export const DEFAULT_SWITCHES: VoiceSwitches = { dictionary: true, system: true }

/**
 * 平台报上来的「现在有什么」。
 *
 * ★ 这是**事实**，不是偏好：他把词典语音打开也改变不了「这台机器上没有词典层」。
 *   两者分开之后，「为什么没用词典音」才答得出来。
 */
export interface VoiceAvailability {
  /** 「给我一个词、还我它的发音」这条通道在不在 */
  dictionary: boolean
  /** 系统 TTS 起没起 */
  system: boolean
}

/** 序列里的一步 */
export interface VoiceAttempt {
  source: SourceId
  /**
   * 这一步最多花多少毫秒；超了就走下一步。
   *
   * `null` = 不设上限。**只有 `system` 是 `null`** —— 它是最后一根稻草，
   * 给它设预算等于「放弃最后的兜底」，那不是保护，是把人扔在安静里。
   */
  budgetMs: number | null
  /** 为什么排在这里。报错、日志、用例都读它 */
  why: string
}

/** 一个**没进序列**的来源，以及为什么 —— `explain()` 要连它一起讲 */
export interface VoiceSkip {
  source: SourceId
  why: string
}

export interface VoicePlan {
  attempts: VoiceAttempt[]
  /** 被跳过的那些，**逐条留着**：「为什么没用词典音」这个问题得有地方答 */
  skipped: VoiceSkip[]
  /** 一步都排不上时说人话（界面直接显示） */
  why: string
}

// ══════════════════════════════════════════════════════════════
// 运行账本 —— D-466 把它缩成「这次谁出的声、为什么」一行日志（D-219：他能贴给我看）
// ══════════════════════════════════════════════════════════════

export type StepOutcome = 'hit' | 'miss' | 'timeout' | 'error' | 'no-handler'

/** 账本里的一步。`skipped` 的那些也进来，outcome 就是 `'skipped'` */
export interface VoiceTraceStep {
  source: SourceId
  outcome: StepOutcome | 'skipped'
  /** 花了多少毫秒。`skipped` 是 0 */
  ms: number
  /** 为什么是这个结果 —— 人话，界面直接显示 */
  reason: string
}

export interface VoiceTrace {
  /** 什么时候 */
  at: number
  kind: VoiceKind
  origin: VoiceOrigin
  /** 排出来的顺序（不含被跳过的） */
  planned: SourceId[]
  /** 每一步的结果，含被跳过的 */
  steps: VoiceTraceStep[]
  /** **实际出声的**那一个。一个都没成就是 `null` */
  spoke: SourceId | null
  /** 整趟花了多少毫秒 */
  ms: number
}
