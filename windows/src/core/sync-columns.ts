/**
 * 哪些列是**机器的账**，哪些是**他写的东西**（D-437）。
 *
 * ── 为什么要分 ────────────────────────────────────────────────
 *
 * 合并原本是**整行**判的：两边都在上次同步之后动过 → 冲突 → 问他选一边。
 * 可 `lectures.due_at`、`reading_cards.reps` 这些列，**两端都会在他正常用的时候
 * 顺手改**（手机练完顶一次，电脑分析完顶一次）。于是他明明一个字都没编辑过，
 * 却被拉去回答「哪边算数」—— 而那个问题本身没有意义：那三列他从来没写过。
 *
 * 实测：一次同步里 16 条讲次都卡在这上面。代码里还留着更早的同款案底
 * （`sync-merge.ts` 的注释：「22 处莫名其妙的冲突，而他一条都没碰过」）。
 *
 * ── 判据（使用者 2026-09-02 亲批「可以时间新的直接赢，不问」）──────
 *
 * 两边都改过时，**看真正不一样的是哪几列**：
 *   · 全都是机器的账      → **时间新的赢，不问**
 *   · 有一列是他写的东西  → 照旧问他（D-201 的正题在这里，一点没让）
 *
 * ── 这份名单只许收，不许放 ────────────────────────────────────
 *
 * 收错了（把机器的账当成他的东西）代价 = 偶尔多问他一次，也就是今天的行为。
 * 放错了（把他写的东西当成机器的账）代价 = **静默覆盖掉他写的字**。
 * 两边不对称，所以**拿不准就别放进来**。
 *
 * ★ 特别地，下面这几列**是他的决定，不许进来**：
 *   `silent` / `card_silent` / `silenced_by` —— 静默是学习决定不是机器算的（D-359）
 *   `layer`                                 —— 认读/产出由他定（⑩）
 *   `sort`                                  —— 拖动排序是他排的（D-361）
 *   `deleted_at`                            —— 删除是他的意思表示
 */
export const MACHINE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  /** 讲次的轮转状态：练一次、分析一次都会被顶 */
  lectures: ['status', 'interval_days', 'due_at'],
  /** 认读卡整张就是 SM2 的账（`silent` 除外 —— 那是他按的） */
  reading_cards: ['ease', 'interval_days', 'reps', 'lapses', 'due_at'],
  /** 知识点上的排期与计数（V34 之前卡还长在 items 上，两套都在） */
  items: [
    'card_ease',
    'card_interval',
    'card_reps',
    'card_lapses',
    'card_due_at',
    'streak',
    'attempts',
    'attempts_in_stage',
    'corrects',
    'hard_entries',
    'recollected_count',
    'production_state'
  ]
}

export const machineColumnsOf = (table: string): readonly string[] => MACHINE_COLUMNS[table] ?? []

/**
 * 两份数据**真正不一样的那几列，是不是全都是机器的账**。
 *
 * `false` 的三种情况都要挡住：这张表没登记过机器列 · 有一列是他写的东西 ·
 * 任何一边是删除标记（`data === null`）—— 删除永远是他的意思表示，不许悄悄合并。
 */
export function onlyMachineDiffs(
  table: string,
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null
): boolean {
  if (!a || !b) return false
  const machine = machineColumnsOf(table)
  if (machine.length === 0) return false
  const owned = new Set(machine)
  let sawDiff = false
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // 时间戳本身不算「内容不一样」—— 它是这次比较的依据，不是被比较的东西
    if (k === 'updated_at') continue
    if (Object.is(a[k] ?? null, b[k] ?? null)) continue
    if (!owned.has(k)) return false
    sawDiff = true
  }
  return sawDiff
}
