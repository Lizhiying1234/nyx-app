/**
 * 金标准向量（golden vectors）的写出工具
 *
 * ── 为什么是「向量」而不是「翻译测试」 ──────────────────────
 *
 * 使用者定的 M1 验收方式：不要求把 199 个 TS 测试逐字翻成 Kotlin，
 * 要求的是 **同一输入 → TS 与 Kotlin 输出完全一致**。
 *
 * 所以这里不断言任何东西，只做一件事：**把 Windows 端真实实现的输出录下来**。
 * 断言发生在 Kotlin 那一侧，拿这份录像当唯一真值。
 *
 * 这样做的好处是那 199 个测试守不住的东西它也能守住：
 * 测试只断言它想到的那几条，而向量把**每一个字段、每一句人话理由**都钉死了 ——
 * 包括 `reason` 里的中文，那是使用者会看见的东西。
 *
 * ── 铁律 ────────────────────────────────────────────────────
 *
 * 这个目录**只读** `2-可移植资产/`，一个字都不改。
 * 那份资产是 Windows v1.0-stable 的真相，改了它整件事就没有意义了。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一条向量：输入 → 输出。`out` 为 `{__error}` 表示原实现在这里抛异常 */
export interface Vector {
  in: unknown
  out: unknown
}

export interface GoldenFile {
  module: string
  /** 这份向量是从哪个真实实现录下来的 —— 将来换基线时要能对得上 */
  source: string
  /** 录制时的时区。与日历无关的模块是 null */
  zone: string | null
  groups: Record<string, Vector[]>
}

/**
 * 调一次，把抛出来的异常也录进去。
 *
 * **异常本身就是规格。** `applyGrade` 对已静默条目抛错、`parseLoose` 凑不出值时抛错，
 * 都是「上游有 bug 必须炸出来」的明确设计（见各文件注释）。
 * Kotlin 那边要是安静地返回一个值，那是行为不等价，必须被这条向量抓住。
 */
export function rec<T>(fn: () => T): unknown {
  try {
    return { ok: fn() }
  } catch (e) {
    return { __error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 笛卡尔积。写向量时大量用到 —— 手写矩阵会漏格，而漏掉的那一格
 * 通常正是边界（`>=` 写成 `>` 的那一格）。
 */
export function cross<A, B>(as: readonly A[], bs: readonly B[]): [A, B][] {
  const out: [A, B][] = []
  for (const a of as) for (const b of bs) out.push([a, b])
  return out
}

export function write(file: string, data: GoldenFile): void {
  mkdirSync(dirname(file), { recursive: true })
  // 缩进 2 空格 + 结尾换行：将来 diff 这份文件时要能看出改了哪一条
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
  const n = Object.values(data.groups).reduce((s, v) => s + v.length, 0)
  console.log(`  ${data.module.padEnd(18)} ${String(n).padStart(5)} 条  →  ${file}`)
}
