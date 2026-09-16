/**
 * 多选里的「全选」三态 —— 纯函数（T-5.18 起在 Android，T-9.15 搬进 core）
 *
 * ── 为什么是 core 的一份 ──────────────────────────────────
 *
 * 它最容易在每一屏里各写一遍（Android 的 Vault 就有过一个只会「全选」、
 * 不会「取消」的半份），而它错的时候**界面不会报错，只会说错话**：
 * 明明只选了 3 条，按钮却写着「已全选这 20 条」。
 * 两端各写一份的结果是同一个按钮在两台机器上说不同的话 —— 而两边都不报错。
 *
 * ★ 判据原文来自 Android `src/ui/lib/selection.ts`（T-5.18），逐字搬来。
 *   Android 那份下次提指针时改成从 core 引，两端就真的是一份
 *   （改它的文件归 Android 那半场，本仓不动）。
 *
 * ── 一个按钮三种状态 ──────────────────────────────────────
 *
 *   `none` · 不在多选态（sel = null）、或这一屏一条都没有 —— 按钮不出现
 *            （D-431②「数是 0 的入口不出现」）
 *   `some` · 选了一部分 —— 按钮是「全选这 N 条」
 *   `all`  · 列表上每一条都在选中里 —— 按钮是「取消全选」
 *
 * ★ 「取消全选」= **退出多选**（返回 null），不新造一个「空选」态：这几屏本来就
 *   约定「空数组自动退出」（省掉一次「退出多选」的必按），为一个按钮长出第四种
 *   状态，就是第二套 selection 系统的开头。
 * ★ 选中里混进了列表上没有的 id（在别处删掉的那种）不影响判断：看的是
 *   「列表上的每一条在不在选中里」，不是两个数组相等。
 */
export type SelectAllState = 'none' | 'some' | 'all'

export function selectAllState(
  selected: readonly number[] | null,
  all: readonly number[]
): SelectAllState {
  if (selected === null || selected.length === 0 || all.length === 0) return 'none'
  const has = new Set(selected)
  return all.every((id) => has.has(id)) ? 'all' : 'some'
}

/** 按下那个按钮之后的选中集：没全选 → 全选（按列表顺序）· 已全选 → 退出多选 */
export function toggleSelectAll(
  selected: readonly number[] | null,
  all: readonly number[]
): number[] | null {
  if (all.length === 0 || selectAllState(selected, all) === 'all') return null
  return [...all]
}
