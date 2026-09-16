/**
 * 使用者改过的提示词 —— **两端同一份判据**（⑤ · 2026-09-01）
 *
 * ── 为什么不能只在手机上改 ★★★ ────────────────────────────
 *
 * 需求 ⑤ 要手机能「查看和修改 Prompt」。但 `generate-questions` 与
 * `score-answer` 是**两端都在用**的：Windows 从 `data/prompts/*.md` 读，
 * Android 构建时内联同一份原文。
 *
 * 如果覆盖只存在手机上，结果是**同一个 Nyx 在两台机器上出的题不一样、
 * 判分标准也不一样**，而两边都说得通、都不报错 ——
 * 这正是本项目定义的最贵事故形态。
 *
 * 所以覆盖存 `user_preferences`（**同步表**，跟着人走），
 * 两端读同一份，优先级：
 *
 *   使用者改过的（user_preferences） → 磁盘上的 md 文件 → 内置副本
 *
 * ★ 文件那一层保留：D-223 特意把 `prompts/` 排除在 asar 之外，
 *   就是为了让他在电脑上能直接改文件。两条路都留着，DB 那条优先。
 *
 * ── 哪些能覆盖 ───────────────────────────────────────────
 *
 * 只列**两端共用**的那些。Windows 独有的（analyze-material / tutor-chat …）
 * 不进这张表 —— 手机上没有对应功能，给了也只是让设置页更长。
 * ★ 题型自己的提示词不在这里：那是 `qtypes.prompt`，本来就同步。
 */

/**
 * 可被使用者覆盖的提示词。
 *
 * `scope` 说的是**谁在用它**，不是「存在哪」——
 * 两者都存 `user_preferences`（他写的东西都该跟着人走）。
 *   both    两端都在用 → 改了电脑也跟着变，**必须**同一份
 *   android 只有手机有这个功能（Windows 没有 Lookup 的 AI 搜索）
 *
 * `builtin` = 有没有一份内置原文可以「恢复默认」：
 * both 那两条的原文是 `prompts/*.md`；android 那条的默认写在
 * `Nyx-Android/src/db/lookup.ts`（Windows 那边没有对应文件）。
 */
export const OVERRIDABLE_PROMPTS = [
  { name: 'generate-questions', says: '产出练习出题', scope: 'both', builtin: 'file' },
  { name: 'score-answer', says: '产出练习判分', scope: 'both', builtin: 'file' },
  /**
   * ★★ 2026-09-13 · Windows 也接上了（使用者：「查词……进入后能够统一提供：
   *   词典 · AI · 语音」）。于是 scope 从 android 改成 **both** ——
   *   上面那句「Windows 没有 Lookup 的 AI 搜索」的前提今天不成立了。
   *
   *   默认正文随之搬进 `core/lookup-prompt.ts`，两端 import 同一份。
   *   理由和 `reading-card` 那次逐字相同：各写一份的话，**同一个词在电脑上和
   *   手机上讲法不同**，而两边都说得通、都不报错 —— 他只会以为模型不稳定。
   *
   *   `builtin: 'code'` 不变：默认在代码里，不是 `prompts/*.md`（原因见那份文件的头）。
   */
  { name: 'lookup-search', says: 'Lookup 的 AI 搜索', scope: 'both', builtin: 'code' }
] as const

/**
 * ══ `reading-card` 2026-09-15 摘掉了 · D-482 ★★★ ══════════════
 *
 * 它在这张表里待到 2026-09-15。那天使用者把认读那份出题规则从**写正文**
 * 改成**点三个选项**（`core/quiz-rules.ts`），于是「正文」这条输入方式退役。
 *
 * ★★ 为什么必须从名单里摘掉，而不是留着当个没人用的键：
 *   这张表是**生成物的源头** —— 设置页里那条通用「共用提示词」整页编辑框
 *   是照着它循环出来的（手机上尤其明显）。留着它 = 屏幕上仍然有一个
 *   能改认读出题规则的正文框，而**它写的东西已经不参与出题了**：
 *   他点保存，屏幕说存好了，出的题一个字不变。两条路设同一件事，
 *   其中一条是哑的 —— 这正是这个项目反复付学费的那种形状。
 *
 * ★ 库里 `user_preferences['prompt.reading-card']` 那一行**一个字不删**（D-216）：
 *   他以前写过的正文由 `main/reading-faces.ts::legacyReadingRules` 读出来，
 *   在认读那一块里**只读**展示。`Prefs.raw()` 不查白名单，读得到；
 *   `Prefs.set()` 从此拒写 —— 这正是要的（再没有人该往那里写）。
 *
 * ★ 原来那段「为什么它的默认在代码里不在 md」的注释跟着退役：
 *   默认正文与解析判据仍在 `core/reading-face.ts`，只是不再经过覆盖这条路。
 */
const RETIRED_2026_09_15 = 'reading-card'
export const RETIRED_OVERRIDABLE_PROMPTS: readonly string[] = [RETIRED_2026_09_15]

/**
 * ★ 它的来历（留着当记录，不再是一条可覆盖项）：
 *
 * 2026-09-01 使用者「加一个认读提示词」—— 它挂在**背面**（已经翻卡、答案看过了），
 * 管的是**理解**不是回忆，不影响判分。
 * 2026-09-03 Windows 也接上了（使用者：「认读测试也应该拥有自己的 Prompt」），
 * 默认正文与解析判据搬进 `core/reading-face.ts`，两端 import 同一份 ——
 * 各写一份的话，同一张卡在两台机器上考法不一样、红线松紧也不一样，
 * **而两边都说得通、都不报错**。那两条今天仍然成立，只是不再经过覆盖这条路。
 */

export type OverridablePrompt = (typeof OVERRIDABLE_PROMPTS)[number]['name']

/** 两端共用的那些 —— Windows 的 loadPrompt 钩子只认这几条 */
export const SHARED_PROMPTS = OVERRIDABLE_PROMPTS.filter((p) => p.scope === 'both')

/** 覆盖存在 `user_preferences` 的哪个键 */
export const promptPrefKey = (name: string): string => `prompt.${name}`

/** 给 PREF_SPECS 用的规格（在 prefs.ts 里展开进白名单） */
export const PROMPT_PREF_SPECS = OVERRIDABLE_PROMPTS.map((p) => ({
  key: promptPrefKey(p.name),
  kind: 'text' as const,
  says: `改过的提示词：${p.says}`
}))
