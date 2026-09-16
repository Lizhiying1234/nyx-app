/**
 * `Study` 用得到的三个小工具 · T-4.6 拆分（2026-09-06）
 *
 * 原来是 study.ts 里的模块级函数。拆分之后各领域文件都要用它们，
 * 而领域文件反过来 import study.ts 会形成**运行时**循环（那三个不是类型），
 * 所以单独放一份。正文一个字没改。
 */

/** annotations 存的是 JSON 字符串，坏了也不能把整页拖垮。 */
export function safeLabels(json: string | null): string[] {
  if (!json) return []
  try {
    const a = JSON.parse(json) as { label?: string }[]
    return Array.isArray(a) ? [...new Set(a.map((x) => x.label ?? '').filter(Boolean))] : []
  } catch {
    return []
  }
}

export const now = (): number => Date.now()

/** I-061 · 乱序。Fisher–Yates —— sort(() => Math.random()-0.5) 是不均匀的。 */
export function shuffled<T>(a: T[]): T[] {
  const out = [...a]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

