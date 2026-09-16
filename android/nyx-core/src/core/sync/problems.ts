/**
 * 「上一次同步没有完全成功」的**格式** · ★★ R-4-D
 *
 * ★★ 2026-08-29 · 阶段 3：键名、类型、去重、编解码从 `main/sync/problems.ts`
 *   搬进 core —— 引擎（两端同一份）要写它，Windows 的数据体检要读它，
 *   格式漂了就是「体检读不出引擎写的账」。main 那份只剩围绕 better-sqlite3
 *   的薄读写，判据全在这里。
 *
 * 背景（原文保留）：以前单行写不进去只有一句 `console.error`，打包后无处可看。
 * 结果是这条协议里最贵的失败形态：界面说「拉下来 47 行」，实际落库 46 行，
 * 两台设备从此永久差一行，而没有任何人、任何检查、任何时刻会发现。
 * 状态写进 `settings`，由数据体检端上来，设置页的同步区也直接显示。
 * 不弹窗：一次网络抖动不值得打断他；但也绝不许它悄无声息。
 */

/** 体检和设置页要读的那把钥匙 */
export const SYNC_PROBLEM_KEY = 'sync.problems'

export interface SyncProblem {
  /**
   * · `row` —— 某一行写不进去（外键还没到、主键撞车…）。
   *   它所在的包**没有**被标成已应用，下一次同步会重来。
   * · `run` —— 整次同步失败（多半是网络 / 配置）。
   */
  kind: 'row' | 'run'
  /** 出事的是什么 —— 「items/uid-abc3」「开机自动同步」 */
  what: string
  message: string
  /** 这一行来自哪个变更包。**它没进 applied，下次会再来一遍** */
  chunk?: string
}

export interface SyncProblems {
  at: number
  problems: SyncProblem[]
}

/**
 * ★★ **同一行只报一次**，不管它出现在几个包里。
 *
 * 同一行的冲突/失败每个装着它的包都会记一条，而「同一行躺在好几个包里」
 * 再正常不过。30 个包 = 同一条记 30 次 → 设置页 `{#each ... (p.what)}`
 * key 撞车，Svelte 抛 `each_key_duplicate`，**整页变「这一页出错了」**。
 * 判据就是 `what`，和界面那把 key 一模一样；留第一条。
 */
export function dedupeProblems(problems: SyncProblem[]): SyncProblem[] {
  const seen = new Set<string>()
  const out: SyncProblem[] = []
  for (const p of problems) {
    if (seen.has(p.what)) continue
    seen.add(p.what)
    out.push(p)
  }
  return out
}

/** 落库的那份字符串。空清单返回 null = 该把上一次的记录抹掉 */
export function encodeProblems(problems: SyncProblem[], at = Date.now()): string | null {
  if (problems.length === 0) return null
  return JSON.stringify({ at, problems: dedupeProblems(problems).slice(0, 50) } as SyncProblems)
}

/** 读回来。格式不对 / 空清单一律当没有 */
export function decodeProblems(value: string | undefined | null): SyncProblems | null {
  if (!value) return null
  try {
    const p = JSON.parse(value) as SyncProblems
    return Array.isArray(p.problems) && p.problems.length > 0 ? p : null
  } catch {
    return null
  }
}
