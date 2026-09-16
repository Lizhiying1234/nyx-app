/**
 * 单条完整解析 · **AI 响应 → 写入计划**（T-7.8 · 2026-09-05）
 *
 * ── 这个文件是这一轮里最要紧的一份 ────────────────────────
 *
 * 原来这段逻辑长在 `main/study.ts::ensureAnalysis` 的一个事务里，
 * 判据和 SQL 缠着写。里头压着六条互相咬合的规矩，**每一条都是使用者的原话**：
 *
 *   ① D-149 · 手改过的区块一个字不动 —— 「你自己写下的一句理解，比 AI 写的十句都管用」
 *   ② D-150 · 例句先本地词典后 AI，来源标在脸上 —— 例句是他要去模仿的样板
 *   ③ R-002 · gloss / glossZh **回写到条目上**，不留在解析里 —— 释义要立得住
 *   ④ 空的不写：空字符串 · 只有空白 · `[]` · `{}` —— 写进去就是一块空区块占着位置
 *   ⑤ regen_count 是「这一块重来过几次」的账
 *   ⑥ I-112 · 数「详情页认得几块」，不是数「写了几块」
 *
 * 搬下来是因为 D-R22：手机也要做单条解析。这六条只要有一条在手机上写歪，
 * 后果都是**静默的**：他手改的那一段被盖掉、例句里没了词典来源、
 * 或者两台机器对同一条知识点写出不一样的解析。没有一条会报错。
 *
 * ★ 这里只**算**，不写库：返回一份计划，谁执行、用什么语句，是平台的事。
 *   Windows 用 SQLite 的 upsert，Android 用它自己的写法，判据是同一份。
 */
import { isRenderedBlock } from './blocks.ts'

/** 库里已经有的那些块 —— 判 edited 跳过与 regen 累加都要它 */
export interface ExistingBlock {
  block: string
  /** 非 0 = 他手动改过 */
  edited: number
  regenCount: number
}

/** 本地词典给的例句 */
export interface DictExample {
  text: string
  from: string
}

/** 要写进 analysis_blocks 的一块 */
export interface BlockWrite {
  block: string
  content: string
  /** 已经有这一块就是原来的 + 1，没有就是 0 */
  regen: number
}

/** 要回写到 items 上的释义 */
export interface GlossWrite {
  column: 'gloss' | 'gloss_zh'
  value: string
}

export interface WritePlan {
  blocks: BlockWrite[]
  gloss: GlossWrite[]
  /** 写进 analysis_blocks 的块数（含模型自己包出来的怪名字） */
  written: number
  /** 其中**详情页认得**的有几块（含回写的释义）—— I-112 靠它 */
  shown: number
  /** 模型这次返回了哪些键 —— 一块都不认得时要把它报给使用者看 */
  keys: string[]
}

/**
 * @param ai            `extractJson` 解出来的那个对象
 * @param existing      这条知识点库里已有的块
 * @param dictExamples  本地词典给的例句；没有词典就是空数组
 *
 * ★ 顺序**按模型返回的键序**走，不排序：写入顺序会落到 regen 与
 *   updated_at 上，排一下就和原实现不一样了。
 */
export function planWrites(
  ai: Record<string, unknown>,
  existing: ExistingBlock[],
  dictExamples: DictExample[]
): WritePlan {
  const editedSet = new Set(existing.filter((b) => b.edited !== 0).map((b) => b.block))
  const regenOf = new Map(existing.map((b) => [b.block, b.regenCount]))
  const nextRegen = (block: string): number => {
    const had = regenOf.get(block)
    return had === undefined ? 0 : had + 1
  }

  const blocks: BlockWrite[] = []
  const gloss: GlossWrite[] = []
  let written = 0
  let shown = 0

  for (const [block, value] of Object.entries(ai)) {
    if (value === null || value === undefined) continue

    /**
     * ② D-150 · 例句：词典的排前面（**出版过的真句子**），AI 补的排后面并标明。
     * ★ 只有词典真有例句时才走这一支；没有词典就落到下面那条普通路，
     *   AI 给什么写什么 —— 那正是「没放词典也照常能用」。
     */
    if (block === 'examples' && dictExamples.length > 0) {
      if (editedSet.has(block)) continue
      const fromAi = Array.isArray(value) ? (value as { text?: string }[]) : []
      const merged = [
        ...dictExamples.map((e) => ({ text: e.text, source: 'dict', note: e.from })),
        ...fromAi.filter((e) => e && typeof e.text === 'string')
      ]
      blocks.push({ block, content: JSON.stringify(merged), regen: nextRegen(block) })
      written += 1
      shown += 1
      continue
    }

    /**
     * ③ R-002 · 释义回写到条目上，不当解析块存。
     * ★ 这里**没有** edited 判定：`edited` 是区块上的标记，而释义不是区块。
     */
    if (block === 'gloss' || block === 'glossZh') {
      if (typeof value === 'string' && value.trim()) {
        gloss.push({ column: block === 'gloss' ? 'gloss' : 'gloss_zh', value: value.trim() })
        shown += 1
      }
      continue
    }

    // ① D-149 · 手改过的跳过，一个字都不动
    if (editedSet.has(block)) continue

    const content = typeof value === 'string' ? value : JSON.stringify(value)
    // ④ 空的不写
    if (!content.trim() || content === '[]' || content === '{}') continue

    blocks.push({ block, content, regen: nextRegen(block) })
    written += 1
    // ⑥ I-112 · 详情页认得的才算"他看得见"
    if (isRenderedBlock(block)) shown += 1
  }

  return { blocks, gloss, written, shown, keys: Object.keys(ai) }
}
