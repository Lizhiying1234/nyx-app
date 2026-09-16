/**
 * 提示词（Android 面）—— **文件只有一份**：Windows 仓库 `prompts/*.md`。
 *   · 应用里：Vite `?raw` 构建时原文内联（与 schema-link 同一个道理）
 *   · ② 层测试（node）：直接 fs 读同一个文件 —— 不是第二份，是同一份的两个门
 * `splitPrompt` 逐字港自 `main/ai/prompts.ts`；`fill` 同语义。
 * BUILTIN 兜底不港 —— 那是给「文件被他删了」的 Windows 情形准备的；
 * 这里文件在包里 / 在仓库里，缺了当场就炸。
 */

import { promptPrefKey } from '../core-link.ts'
import { prefRaw } from './prefs.ts'
import type { Db } from './types.ts'

export interface Prompt {
  system: string
  user: string
}

/** main/ai/prompts.ts::splitPrompt 逐字 */
function splitPrompt(md: string): Prompt {
  const sys = md.match(/^##\s+SYSTEM\s*$([\s\S]*?)(?=^##\s+USER\s*$)/m)
  const usr = md.match(/^##\s+USER\s*$([\s\S]*)$/m)
  return { system: (sys?.[1] ?? '').trim(), user: (usr?.[1] ?? md).trim() }
}

const NAMES = ['score-answer', 'generate-questions', 'analyse-item'] as const
type PromptName = (typeof NAMES)[number]

const cache = new Map<string, Prompt>()

async function rawOf(name: PromptName): Promise<string> {
  const isNode =
    typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined'
  if (isNode) {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    return readFileSync(
      join(here, '..', '..', 'nyx-core', 'prompts', `${name}.md`),
      'utf8'
    )
  }
  // Vite 静态分析得到这几条固定路径；WebView 里就是内联的原文
  if (name === 'score-answer') {
    return (await import('../../nyx-core/prompts/score-answer.md?raw')).default
  }
  // ★ T-5.12（D-R22）：手机也做单条解析，用的是**同一个文件**，不复制正文
  if (name === 'analyse-item') {
    return (await import('../../nyx-core/prompts/analyse-item.md?raw')).default
  }
  return (await import('../../nyx-core/prompts/generate-questions.md?raw')).default
}

/**
 * ★★ 使用者改过的那一版（⑤ · 2026-09-01）
 *
 * 优先级：**改过的（user_preferences）→ 包里内联的原文**。
 * （Windows 那边中间还有一层「磁盘 md」，因为 D-223 特意把 prompts/
 *   排在 asar 之外让他能直接改文件；手机上没有那一层。）
 *
 * ★ 存 `user_preferences` 而不是 `settings` —— 它是**同步表**。
 *   覆盖只存一端的话，同一个 Nyx 在两台机器上出的题不一样、判分标准也不一样，
 *   **而两边都说得通、都不报错**。名单与键名在 `core/prompt-overrides.ts`。
 * ★ 不进 `cache`：改完要当场生效，缓存住了他会以为没保存。
 */
export async function loadPromptFor(db: Db, name: string): Promise<Prompt> {
  const over = (await prefRaw(db, promptPrefKey(name)))?.trim()
  if (over) {
    const p = splitPrompt(over)
    if (p.user.trim()) return p
  }
  return loadPrompt(name)
}

/**
 * 「默认长什么样」——「恢复默认」要拿它回填，存的时候也要拿它比对。
 *
 * ★ 两种来源，因为默认本来就在两个地方（core/prompt-overrides.ts 的 `builtin` 字段）：
 *   file  包里内联的 md（出题 / 判分，两端共用同一份原文）
 *   code  写在代码里的常量（Lookup 的 AI 搜索 —— Windows 没这个功能，没有对应文件）
 */
export async function builtinPromptText(name: string): Promise<string> {
  /**
   * ★ 写在代码里的那几条默认（core/prompt-overrides.ts 的 builtin:'code'）。
   *
   * ★★ 2026-09-15（D-482）：`reading-card` 那一支删了 —— 那把键已经从
   *   `OVERRIDABLE_PROMPTS` 摘掉（退役的是**输入方式**：出题规则改成三个选项），
   *   于是这里永远走不到它，留着就是一支没人走的路等着下一个人误会
   *   「出题规则还能在提示词页改」。他以前写的正文照旧留在库里，
   *   认读设置页只读展示（`db/lookup.ts::legacyReadingRules`）。
   */
  if (name === 'lookup-search') {
    const m = await import('./lookup.ts')
    return m.DEFAULT_SEARCH_PROMPT
  }
  if (!NAMES.includes(name as PromptName)) throw new Error(`没有「${name}」这份提示词`)
  return rawOf(name as PromptName)
}

export async function loadPrompt(name: string): Promise<Prompt> {
  const hit = cache.get(name)
  if (hit) return hit
  if (!NAMES.includes(name as PromptName)) {
    throw new Error(`找不到提示词「${name}」—— 手机包里只带练习与解析要用的那几份。`)
  }
  const p = splitPrompt(await rawOf(name as PromptName))
  cache.set(name, p)
  return p
}

