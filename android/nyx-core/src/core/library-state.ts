/**
 * 知识库一行「释义位」处在哪个状态 · T-4.10（D-R24 已裁 A · 2026-09-06）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * 使用者 2026-09-06：「综合知识库几乎每个知识点旁边都有一个标记。」
 * 数他的真库：208 条里 **202 条 `gloss` 为空** —— 全部是手机采集来的，从来没分析过
 * （采集只写 `term` 与出处，释义由分析写回）。而空释义在行上没有自己的表达，
 * 界面就地判一句 `it.gloss || '—'`，于是 202 行整整齐齐挂着一根**没有意义的横线**。
 *
 * 这不是数据错、也不是条件反了：**是一个有产品意义的状态没有被表达出来**。
 * 「还没分析」在他的库里是**主流状态**，而且是可行动的（进那一讲点一次分析）。
 *
 * ── 为什么判据要在 core，而不是留在界面里 ──────────────────
 *
 * 「gloss 空不空」是**界面在猜**。猜的代价：
 *   · 「分析过了但没写出释义」和「从来没分析过」在界面看来一模一样，
 *     可它们对使用者是两件事 —— 前者点分析没用，后者点了就有；
 *   · 手机那边将来也要显示同一批行（D-R22 之后两端都写解析），
 *     判据留在 Svelte 里，手机只能再猜一遍，而两边猜歪的方式一定不一样。
 * 所以这里给出**一个明确的状态**，`libraryItems` 把它算好放进 `LibraryItem`，
 * 界面只管画，不再判。
 *
 * ── 有意不做的 ────────────────────────────────────────────
 *
 * ★ **`hasSuspect` 不是这里的输入。** 修正记号（词后那个小图标）是另一件事：
 *   它说的是「这条可能打错了」，与「释义位显示什么」互不相干，两端也各有各的判据。
 *   而且 suspect 本身就是一块解析块，已经算进了 `analysisBlocks`。
 *   把它塞进来只会让这个枚举同时表达两件事 —— 那正是「一个状态两份判据」的开头。
 * ★ 不判「该不该显示层级片 / 箭头」：那两个是每行都有的固定元素，不是状态。
 */

/** 一行「释义位」的四种状态，互斥 */
export type LibraryState =
  /** 有析出成分 —— 释义位让位给「已析出 n 个成分」（现状，优先级最高） */
  | 'derived'
  /** 有释义 —— 正常态 */
  | 'glossed'
  /** 分析过了，但没写出释义。**不是「还没分析」**：再点一次分析未必有用 */
  | 'analysed'
  /** 还没分析 —— D-R24 要表达的就是这一支 */
  | 'unanalysed'

export interface LibraryRowFacts {
  /** `items.gloss`；空串与 null 一样算「没有」 */
  gloss: string | null
  /** 从这一条析出去的成分数 */
  derivedCount: number
  /**
   * 这一条有几块解析（**不含 `summary`**）。
   * 0 = 从来没分析过 —— 与 `pendingAnalysis` 的队列判据同一把尺
   * （`core/sql/analysis.ts::NO_FULL_ANALYSIS`：只有 summary 的不算有解析）。
   */
  analysisBlocks: number
  /**
   * 有没有被手改过的块（`analysis_blocks.edited != 0`）。
   * ★ 它只用来**兜底**：他手改过就一定分析过，哪怕块数因为别的原因读成 0，
   *   也不该对着一条他亲手写过东西的行说「还没分析」。
   */
  edited: boolean
}

/**
 * @returns 这一行的释义位该是哪种状态
 *
 * 顺序有意如此：析出 → 释义 → 分析过 → 还没分析。
 * 前两支是现状（`derivedCount > 0` 本来就压过 gloss），后两支是这一轮拆出来的。
 */
export function libraryState(f: LibraryRowFacts): LibraryState {
  if (f.derivedCount > 0) return 'derived'
  if ((f.gloss ?? '').trim() !== '') return 'glossed'
  if (f.analysisBlocks > 0 || f.edited) return 'analysed'
  return 'unanalysed'
}

/** 界面上那句话 —— 文案是中性的：它是状态，不是警告（D-R24 A：不是警告色、不是图标） */
export const UNANALYSED_LABEL = '还没分析'

/** 「n 条还没分析」——表头计数用它，免得两处各写一遍 */
export const countUnanalysed = (states: readonly LibraryState[]): number =>
  states.filter((s) => s === 'unanalysed').length
