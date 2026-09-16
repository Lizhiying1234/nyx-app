/**
 * 提示词变量填充 —— **判据只有一份**（T-7.8 · 2026-09-05）
 *
 * 原来在 `main/ai/prompts.ts`。单条解析的请求装配要下沉 core（两端共用同一份判据），
 * 而装配的最后一步就是把 `{{TERM}}` 这些变量填进去 —— 填充规则跟着下来，
 * 否则 Android 那边只能再抄一份。**抄一份就会漂**：
 * 少填一个变量时 Windows 停下来报错、手机把 `{{KIND}}` 原样发给 AI，
 * 两边都不崩，只是手机那边出来的解析一直是错的。
 *
 * `main/ai/prompts.ts` 现在只留一层 re-export 壳（和 `db/silence-sql.ts` 同一个形状）：
 * 真相在 core，位置留在原处，十几个调用点一个字都不用改。
 *
 * ★ 「没人填就抛」不是防御性编程，是这个项目踩过的坑：
 *   `fill(p.system, { LEVEL })` 漏了 `{{TYPES}}`，那一段原样发给了 AI，
 *   题型要求一个字没到模型手上，而**一切看起来都成功了**（F-6 那条用例守的就是它）。
 */
export function fill(text: string, vars: Record<string, string>): string {
  const missing = [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string))].filter(
    (k) => vars[k] === undefined
  )
  if (missing.length > 0) {
    throw new Error(
      `提示词里的 ${missing.map((k) => `{{${k}}}`).join('、')} 没有人填 —— ` +
        `这一段会原样发给 AI，出来的结果一定是错的，所以停在这里。` +
        `（要么调用处补上这个变量，要么把它从提示词里删掉）`
    )
  }
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)
}
