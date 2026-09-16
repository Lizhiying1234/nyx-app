/**
 * 单条完整解析 · **请求装配**（T-7.8 · 2026-09-05）
 *
 * 原来这一段在 `main/study.ts::ensureAnalysis` 里，和读库、调 AI、写库缠在一起。
 * 搬出来的理由不是"整洁"，是 D-R22：手机也要做单条解析，
 * 而**装配规则一旦各写一份就必然漂** —— 电脑把 `layer='B'` 说成「B 主动词汇」、
 * 手机说成「主动」，同一条知识点在两台机器上会得到不一样的解析，
 * 而两边都不报错、都说得通。
 *
 * ★ 这里只做"把事实变成一次请求"这一件事：不读库、不发网络、不写库。
 *   `promptText` 由调用方读进来（Windows 读文件、Android 走 Vite `?raw`），
 *   `level` 也由调用方给（Windows 从设置里取）—— 那两样是平台的事。
 */
import { fill } from '../prompt-fill.ts'

/** 装配一次解析请求要用到的条目事实 —— 就这四样，多一样都不要 */
export interface ItemFacts {
  term: string
  kind: string
  /** 'A' 理解层 / 'B' 写作层 */
  layer: string
  /** 首条出处的原句；没有就是 null */
  quote: string | null
}

/** `prompts/analyse-item.md` 拆出来的两段 */
export interface PromptText {
  system: string
  user: string
}

export interface AnalysisRequest {
  system: string
  user: string
  json: true
  maxTokens: number
}

/** D-202 · 解析属轻任务，量大要求低；4000 是原实现里的数，搬过来不改 */
export const ANALYSIS_MAX_TOKENS = 4000

/**
 * 提示词里那五个变量。
 *
 * ★ `LAYER` 给的是**中文全称**而不是字母：提示词是写给模型看的，
 *   "B" 这一个字母它猜不出是什么意思。
 */
export function analysisVars(facts: ItemFacts, level: string): Record<string, string> {
  return {
    TERM: facts.term,
    KIND: facts.kind,
    LAYER: facts.layer === 'B' ? 'B 主动词汇' : 'A 被动词汇',  // copy:prompt
    QUOTE: facts.quote ?? '',
    LEVEL: level
  }
}

/**
 * ★ 一份变量**喂两段**。
 *
 * 老写法只填 USER 段，SYSTEM 段里的 `{{KIND}}` 原样发给了 AI
 * （和 `{{TYPES}}` 是同一个病，同一次审计揪出来的）：一切"成功"，
 * 而模型收到的是字面量。现在 `fill` 遇到没人填的变量会直接抛。
 */
export function buildRequest(
  facts: ItemFacts,
  prompt: PromptText,
  level: string
): AnalysisRequest {
  const vars = analysisVars(facts, level)
  return {
    system: fill(prompt.system, vars),
    user: fill(prompt.user, vars),
    json: true,
    maxTokens: ANALYSIS_MAX_TOKENS
  }
}
