import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promptPrefKey } from '@core/prompt-overrides.ts'

/**
 * 提示词是文件，不是代码 · D-213 / D-223
 *
 * 「42 条 M 规则要落进十几种 AI 调用，而这些提示词一定会反复调。写死在代码里意味着
 *  每次微调都要改代码重编译；放成 md 文件，使用者自己用记事本就能改。」
 *
 * D-223：打包时 `prompts/` 必须排除在 asar 之外，否则打包后使用者打不开也改不了，
 * D-213 当场失效。
 *
 * 兜底：文件被删了 / 改坏了，回落到内置副本并**在日志里说出来**，不静默。
 */

export interface Prompt {
  system: string
  user: string
  /**
   * 从哪儿读到的 —— 出问题时要能立刻分清用的是哪一份。
   * 三层与 `docs/PROMPT_LAYERS.md` §2.1 一一对应：
   *
   *   `override` 他改过的那份（`user_preferences['prompt.<name>']`，同步表，跟着人走）
   *   `file`     他电脑上那份 md（`data/prompts/<name>.md`，D-223 特意让他能直接改）
   *   `builtin`  代码里的内置副本（只有两份有）
   *
   * ★★ I-157（2026-09-07）之前只有 `file` / `builtin` 两种，**覆盖命中时报的是
   *   `file` 加上磁盘那份的 path** —— 于是他在手机上改过提示词之后，电脑这边的诊断
   *   会说「读的是 data/prompts/generate-questions.md」，而那句是假的：
   *   用的根本不是那个文件，那个文件甚至可能不存在。
   *   不影响用哪一份，只影响诊断 —— 但**诊断说假话比不说话更贵**：
   *   他照着那句去改文件，改完一点用没有，而软件全程不报错。
   */
  source: 'override' | 'file' | 'builtin'
  /**
   * `override` 时是**偏好键**（`prompt.<name>`，`promptPrefKey` 唯一那处拼）；
   * `file` / `builtin` 时是磁盘路径。
   * ★ 不在这里填磁盘路径充数 —— 那正是 I-157 修的那件事。
   */
  path: string
}

/** 把 md 拆成 SYSTEM / USER 两段。约定：`## SYSTEM` 和 `## USER` 两个二级标题。 */
export function splitPrompt(md: string): { system: string; user: string } {
  const sys = md.match(/^##\s+SYSTEM\s*$([\s\S]*?)(?=^##\s+USER\s*$)/m)
  const usr = md.match(/^##\s+USER\s*$([\s\S]*)$/m)
  return { system: (sys?.[1] ?? '').trim(), user: (usr?.[1] ?? md).trim() }
}

const BUILTIN: Record<string, { system: string; user: string }> = {
  'analyze-material': {
    system:
      'You are the analysis engine of Nyx. Extract expressions a learner would understand ' +
      'while reading but never produce while writing. Every item must quote its source ' +
      'sentence verbatim. Proper nouns are comprehension-only. Return JSON only.',
    user:
      'Return JSON: {"items":[{"term","gloss","glossZh","layer":"A|B","kind","hitBy":[],' +
      '"confidence","quote","para","why"}]}\n\nPassage:\n\n{{MATERIAL}}'
  },
  'extract-derived': {
    system:
      'The learner collected these sentences themselves. Never rewrite or split a sentence — ' +
      'it is already stored verbatim. Only name the reusable components inside it. ' +
      'Prefer components that transfer to other topics. A sentence may yield none. ' +
      'Proper nouns are always layer A. Return JSON only.',
    user:
      'Return JSON: {"sentences":[{"index",' +
      '"derived":[{"term","gloss","glossZh","layer":"A|B","kind","confidence","why"}]}]}' +
      '\n\nSentences:\n\n{{SENTENCES}}'
  }
}

/** 全部提示词的名字。启动时自检用 —— 少一个内置副本就该当场知道，不是等到用的时候。 */
export const PROMPT_NAMES = Object.keys(BUILTIN)

/**
 * ★★ 使用者改过的提示词（⑤ · 2026-09-01）
 *
 * 手机上能改提示词了，而 `generate-questions` / `score-answer` 是**两端共用**的。
 * 覆盖只存一端的话，同一个 Nyx 在两台机器上出的题不一样、判分标准也不一样，
 * **而两边都说得通、都不报错** —— 本项目定义的最贵事故形态。
 *
 * 所以覆盖存 `user_preferences`（同步表），两端读同一份。
 * 这里只留一个**单点钩子**：库打开时接一次，`loadPrompt` 先问它。
 * ★ 不把 db 穿过那十个调用点 —— 那样每加一处调用就多一个忘记接的机会。
 */
let overrideOf: ((name: string) => string | null) | null = null
export function setPromptOverrides(fn: ((name: string) => string | null) | null): void {
  overrideOf = fn
}

export function loadPrompt(promptsDir: string, name: string): Prompt {
  const path = join(promptsDir, `${name}.md`)
  // 优先级：改过的 → 磁盘 md → 内置副本
  if (overrideOf) {
    try {
      const md = overrideOf(name)
      if (md && md.trim()) {
        const { system, user } = splitPrompt(md)
        // ★ I-157 · 报 `override` + 偏好键，**不冒充磁盘那份**（见 `Prompt.source` 头注）
        if (user.trim()) return { system, user, source: 'override', path: promptPrefKey(name) }
      }
    } catch {
      /* 覆盖读不出来就当没有 —— 绝不因为它让整条 AI 链断掉 */
    }
  }
  if (existsSync(path)) {
    try {
      const md = readFileSync(path, 'utf8')
      const { system, user } = splitPrompt(md)
      if (user.trim()) return { ...{ system, user }, source: 'file', path }
    } catch {
      /* 读不出来就走兜底 */
    }
  }
  const b = BUILTIN[name]
  if (!b) throw new Error(`找不到提示词「${name}」，内置副本里也没有。`)
  return { ...b, source: 'builtin', path }
}

/**
 * 把 `{{X}}` 换成真值。
 *
 * ★★ **模板里有、调用方没给的占位符 —— 当场抛错，不许发出去**（2026-08-17）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * 老实现是 `vars[k] ?? m`：没给就**把 `{{X}}` 原样留着**。于是那串字面量
 * 一路发给 AI，AI 看到的是一句没有内容的指令，只能自己发挥 ——
 * 而软件这边照常收货、照常按判据筛，一道都不合格，最后报的是
 * 「AI 出的题没一道能用」。**错的是我们，账记在了 AI 和使用者头上。**
 *
 * 真实事故：`generate-questions.md` 的 `{{TYPES}}` 写在 SYSTEM 段，
 * 而 `study.ts` 只把 TYPES 给了 USER 段（USER 段根本没有这个占位符）。
 * `typesBrief()` 老老实实算出 12 万字符的题型说明，**算完就扔**。
 * AI 收到的 system 里是字面量 `{{TYPES}}`，于是自己编了
 * `cloze` / `sentence-build` / `essay` 这些名字，15 道全被判非法丢掉。
 * 他连着点三次，每次都看到「一道都不是你选的题型」。
 *
 * 同一份审计里另外还揪出两处：`analyse-item` 的 SYSTEM 要 `{{KIND}}`、
 * `tutor-chat` 的 SYSTEM 要 `{{FREE}}`，代码都没给。**三处，同一个病。**
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * 判据放在**替换之前**：扫模板里出现的占位符，有一个没给就抛。
 * 不放在替换之后扫残留 —— 因为代入的值本身可能带 `{{`（他粘进来的文章、
 * 他自己写的提示词），那样会误伤。模板是我们的，值是他的，只查模板。
 */
/**
 * ★ 正文已上提 `@core/prompt-fill.ts`（T-7.8 · 2026-09-05），这里只剩一层 re-export 壳。
 *   单条解析的请求装配下沉 core 之后，填充规则必须跟着下去 —— 否则 Android 只能再抄一份，
 *   而抄一份就会漂：少填一个变量时电脑停下来报错、手机把 `{{KIND}}` 原样发出去，
 *   两边都不崩，只是手机那边的解析一直是错的。
 *   十几个调用点写的还是 `from './ai/prompts.ts'`，那个位置本身是对的，不用改。
 */
export { fill } from '@core/prompt-fill.ts'
