/**
 * 「这份解析是照着**旧词条**写的」· 失效判定（T-7.8 · 2026-09-05）
 *
 * ── 它答的是哪个问题 ──────────────────────────────────────
 *
 * `acceptSuspect` 会改 `items.term`（这是原句唯一会被改动的入口，而且必须他亲手点），
 * 改完在 `corrections` 区块里留一笔 `{ was, should, why, at }`。
 * 可是**解析块不会跟着改** —— 词条已经从 `tangle up` 改成 `tangle with` 了，
 * 而 meaning / chunks / examples 全都还在讲改之前那个词。
 * 屏幕上没有任何提示，他看到的是一份**看起来很完整、其实讲错了对象**的解析。
 *
 * 判据：`corrections` 里最近一条的 `at`，晚于**所有**解析块的 `updated_at`。
 * 「晚于所有」是有意从严：只要有任何一块是改词条之后重写的，
 * 就说明这份解析已经跟上了，不该再报失效去烦他。
 *
 * ── ★ 三个区块必须除外，否则这条判据永远不会成立 ──────────
 *
 *   · `corrections` —— 它自己就是那一笔留痕，`updated_at` 必然等于 `at`。
 *     不除外的话「最近一条 at 晚于所有块」永远为假，**这个提示一次都不会出现**。
 *   · `suspect`     —— 接受一条建议的同时会重写（或删掉）它，同上。
 *   · `summary`     —— 摘要不属于完整解析（`pendingAnalysis` 也不认它）。
 *
 * 这就是负向对照要打的地方：把除外名单拆掉，用例必须当场红。
 */

import { normalizeTerm } from '../normalize-term.ts'

/** 拆掉任何一个，这条判据都会静默失效 —— 见文件头 */
export const STALE_EXEMPT_BLOCKS = ['corrections', 'suspect', 'summary'] as const

/**
 * `corrections` 区块里的一条留痕。
 *
 * ★ T-5.14（2026-09-05，主控裁定的技术规则，D-413 标注）：手机上的「修改」会把
 *   term / gloss / gloss_zh 三列的改动都记进这同一个区块，所以留痕多带三个可选键：
 *   `field` 改的是哪一列；`was` / `should` 改前改后。**只有真改了词的那一笔才让解析失效**：
 *   · `field` 不是 `term`（改释义）→ 解析讲的仍是同一个词，不算
 *   · `was` / `should` 按 `normalizeTerm` 归一后相同（只改大小写 / 空白 / 尾标点）→ 不算
 *   · 老留痕（`acceptSuspect` 写的，没带 `field`）→ 照旧算：它改的就是 term
 *   两端算的是同一份，所以详情页那句提示在手机和电脑上给的答案一致（不加字段，D-R23）。
 */
export interface CorrectionEntry {
  at?: number
  field?: string
  was?: string
  should?: string
  /**
   * 为什么改的。★ 两端**早就在写**（`acceptSuspect` 写 AI 给的理由、
   * 手动修改写「手动修改」）—— 类型上一直漏着，T-9.14 补上。
   * 失效判定不看它，它是给人回头看的。
   */
  why?: string
}

/** 这一笔留痕算不算「改了词」—— 见 `CorrectionEntry` 头注 */
export function countsAsTermChange(c: CorrectionEntry): boolean {
  if (typeof c?.field === 'string' && c.field !== 'term') return false
  if (typeof c?.was === 'string' && typeof c?.should === 'string') {
    return normalizeTerm(c.was) !== normalizeTerm(c.should)
  }
  return true
}

export interface BlockStamp {
  block: string
  updatedAt: number
}

/**
 * @param corrections `corrections` 区块解出来的数组；没有这一块就传空数组
 * @param blocks      这条知识点现有的解析块与它们的 `updated_at`
 * @returns 这份解析是不是照着改之前的词条写的
 */
export function staleAfterEdit(corrections: CorrectionEntry[], blocks: BlockStamp[]): boolean {
  let lastEdit = 0
  for (const c of corrections) {
    if (!countsAsTermChange(c)) continue
    if (typeof c?.at === 'number' && c.at > lastEdit) lastEdit = c.at
  }
  // 从来没改过词条 —— 无从谈起
  if (lastEdit === 0) return false

  const exempt = new Set<string>(STALE_EXEMPT_BLOCKS)
  let newest = -1
  for (const b of blocks) {
    if (exempt.has(b.block)) continue
    if (b.updatedAt > newest) newest = b.updatedAt
  }
  // 压根没有解析 —— 也就谈不上"解析过时了"
  if (newest < 0) return false

  return lastEdit > newest
}
