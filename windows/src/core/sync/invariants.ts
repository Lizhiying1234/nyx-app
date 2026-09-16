import type { SyncState, Tally } from './types.ts'

/**
 * 同步的七条跨平台不变量 · ★★ Step 6 · Commit A / D-292
 *
 * ── 为什么先把它们写成**可证伪的纯判据** ────────────────────
 *
 * 这七条现在活在 `main/sync/index.ts` 的注释和散落的 `if` 里。
 * 注释拦不住任何人，散落的 `if` 也没法单独验 ——
 * 想验「冲突未决时水位不许前进」，现在得起一个真云端、造一次冲突、跑一趟同步。
 *
 * 写成这里这样之后，同一件事三行就能验，而且**平台层与 core 都可以断言它**：
 * Commit B 把编排搬进 core 时，这七条就是「搬对了没有」的判据；
 * 搬完之后它们继续守着，防的是以后有人在平台层又写一份。
 *
 * ── 它们各自挡的是哪一种事故 ────────────────────────────────
 *
 * | | 违反之后会发生什么 |
 * |---|---|
 * | 水位单调 | 水位倒退 → 已经推过的行被重推、远端老行被当成「改过」→ 假冲突 |
 * | 冲突冻结 | 待裁决的冲突**自己蒸发** —— 他从没做过的决定被替他做了（D-201） |
 * | applied 只进不退 | 退了 → 每次同步重下一遍；乱进 → 那一包永远不再看一眼 |
 * | 四桶恒等 | 数对不上时没人再相信这些数（R-4-G-e） |
 * | 写入顺序 | 中途失败留下「东西进来了、碑没有」→ 复活入口 |
 * | 一包算不算处理完 | 判据两端不一致 = 一端永远重试或一端永远漏 |
 * | 重试资格 | 失败/未裁决/版本不符被当成 applied → 两端永久差一截 |
 */

export interface InvariantViolation {
  /** 哪一条 */
  id: InvariantId
  /** 一句人话 —— 报出来要能直接看懂 */
  why: string
}

export type InvariantId =
  | 'watermark-monotone'
  | 'conflict-freeze'
  | 'applied-monotone'
  | 'tally-identity'
  | 'write-ordering'
  | 'package-completeness'
  | 'retry-eligibility'

// ── ① 水位单调 ────────────────────────────────────────────────

/**
 * 水位只许前进（显式清空除外 —— 那条走 `markWiped`，不经过这里）。
 *
 * 倒退的后果不只是重推：远端那些落在新旧水位之间的行会重新被算成
 * 「上次同步之后改过」，于是本来干净的行开始报冲突。
 */
export function checkWatermarkMonotone(before: number, after: number): InvariantViolation | null {
  return after >= before
    ? null
    : {
        id: 'watermark-monotone',
        why: `同步进度倒退了（${before} → ${after}）—— 推过的行会重推，而且会冒出假冲突`
      }
}

// ── ② 冲突冻结 ────────────────────────────────────────────────

/**
 * ★★ 还有没裁决的冲突时，水位**一步都不许动**。
 *
 * 这一条最反直觉，也最要紧：水位同时被两件事用着 ——
 * 「我推到哪了」和「这一行在上次同步之后改过没有」。
 * 水位一往前走，下一轮远端那一版就落到水位之下、不再算「改过」，
 * 于是判成 keep-local，**冲突自己没了**。他从没做过的决定被替他做了。
 */
export function checkConflictFreeze(
  unresolved: number,
  before: number,
  after: number
): InvariantViolation | null {
  if (unresolved <= 0) return null
  return after === before
    ? null
    : {
        id: 'conflict-freeze',
        why:
          `还有 ${unresolved} 处冲突没裁决，水位却从 ${before} 走到了 ${after} —— ` +
          `下一轮那些冲突会自己蒸发，等于替他做了决定（D-201）`
      }
}

// ── ③ applied 只进不退 ────────────────────────────────────────

/** 已经处理完的包不会自己退出去（清空数据那条路除外，它走 `markWiped`） */
export function checkAppliedMonotone(
  before: readonly string[],
  after: readonly string[]
): InvariantViolation | null {
  const now = new Set(after)
  const gone = before.filter((n) => !now.has(n))
  return gone.length === 0
    ? null
    : {
        id: 'applied-monotone',
        why: `${gone.length} 个已处理的包退出了 applied（${gone.slice(0, 3).join('、')}）—— 它们会被重下重放`
      }
}

// ── ④ 四桶恒等 ────────────────────────────────────────────────

/**
 * `received = applied + skipped + failed + conflicted`。
 *
 * ★ 恒等式**不许用减法凑出来**（比如 `skipped = received - 其余三个`）——
 *   那样它永远成立，也就永远验不出任何东西。每一行必须被显式地放进一个桶。
 */
export function checkTally(t: Tally): InvariantViolation | null {
  const sum = t.applied + t.skipped + t.failed + t.conflicted
  return sum === t.received
    ? null
    : {
        id: 'tally-identity',
        why:
          `四个数对不上账：收到 ${t.received}，而 应用 ${t.applied} + 跳过 ${t.skipped} + ` +
          `失败 ${t.failed} + 等裁决 ${t.conflicted} = ${sum}`
      }
}

/** 四个桶都不许是负数 —— 负数说明某一处重复扣减了 */
export function checkTallyNonNegative(t: Tally): InvariantViolation | null {
  const bad = (Object.entries(t) as [keyof Tally, number][]).filter(([, v]) => v < 0)
  return bad.length === 0
    ? null
    : { id: 'tally-identity', why: `有桶是负数：${bad.map(([k, v]) => `${k}=${v}`).join('、')}` }
}

// ── ⑤ 写入顺序 ────────────────────────────────────────────────

/**
 * 墓碑行必须排在普通实体行**前面**。
 *
 * 判断那一层已经靠 `incoming` 提前看见了本批的碑，所以这一条不是为了正确性 ——
 * 是为了**中途失败时库里的状态也是自洽的**：先落碑再落别的，
 * 万一后面某一行炸了，留下的至少是「碑在、东西没进来」，而不是反过来。
 */
export function checkWriteOrdering(tables: readonly string[]): InvariantViolation | null {
  let seenOther = false
  for (const t of tables) {
    if (t === 'tombstones') {
      if (seenOther) {
        return {
          id: 'write-ordering',
          why: '有墓碑行排在了普通行后面 —— 中途失败会留下「东西进来了、碑还没有」，那是复活的入口'
        }
      }
    } else {
      seenOther = true
    }
  }
  return null
}

// ── ⑥ 一包算不算处理完 ────────────────────────────────────────

export interface PackageOutcome {
  name: string
  /** 这一包里有没有写不进去的行 */
  hasFailedRows: boolean
  /** 这一包里有没有还没裁决的冲突 */
  hasUnresolvedConflicts: boolean
  /** 这一包整包被拒了吗（结构 / 协议 / 格式） */
  rejected: boolean
}

/**
 * ★★ 「这一包处理完了」的**唯一定义**。
 *
 * 不是「我下过了」。三种情况都算没处理完：有行没写进去、
 * 还有冲突没裁决、整包被拒。三者任何一个成立，它就不许进 `applied` ——
 * 因为 `applied` 是这条协议里唯一的重试机制，进去了就再也不会被读第二遍。
 *
 * 反过来也要成立：**处理干净的必须进去**，否则每次同步重下一遍，
 * 而且他会一直看到「有失败」——那是另一种形式的谎话。
 */
export function packageIsComplete(o: PackageOutcome): boolean {
  return !o.hasFailedRows && !o.hasUnresolvedConflicts && !o.rejected
}

export function checkPackageCompleteness(
  outcomes: readonly PackageOutcome[],
  committed: readonly string[]
): InvariantViolation | null {
  const done = new Set(committed)
  const wrong: string[] = []
  for (const o of outcomes) {
    const should = packageIsComplete(o)
    if (should !== done.has(o.name)) {
      wrong.push(`${o.name}（该${should ? '进' : '不进'}，实际${done.has(o.name) ? '进了' : '没进'}）`)
    }
  }
  return wrong.length === 0
    ? null
    : {
        id: 'package-completeness',
        why: `这几个包的「处理完了没有」判错了：${wrong.slice(0, 5).join('；')}`
      }
}

// ── ⑦ 重试资格 ────────────────────────────────────────────────

/**
 * 该重试的一定还能重试：失败的、未裁决的、版本不符的，
 * 它们所在的包一个都不许在 `applied` 里。
 */
export function checkRetryEligibility(
  needRetry: readonly string[],
  applied: readonly string[]
): InvariantViolation | null {
  const done = new Set(applied)
  const lost = needRetry.filter((n) => done.has(n))
  return lost.length === 0
    ? null
    : {
        id: 'retry-eligibility',
        why:
          `${lost.length} 个还需要重试的包被标成了已处理（${lost.slice(0, 3).join('、')}）—— ` +
          `它们永远不会被再看一眼，两端从此差一截`
      }
}

// ── 一次跑完全部 ──────────────────────────────────────────────

export interface TransitionFacts {
  before: SyncState
  after: SyncState
  /** 这一趟每个包的下场 */
  outcomes?: readonly PackageOutcome[]
  /** 这一批实际写入的表顺序 */
  writeOrder?: readonly string[]
  /** 该重试的包 */
  needRetry?: readonly string[]
}

/**
 * 一次状态转移是否守住了全部七条。
 *
 * `plan` / `apply` 的每一步之后都可以调它 —— Commit B 会把它接进执行器，
 * 让「搬对了没有」变成每一步都在验的事，而不是最后统一看一眼四个数。
 */
export function checkAll(f: TransitionFacts): InvariantViolation[] {
  const out: (InvariantViolation | null)[] = [
    checkWatermarkMonotone(f.before.watermark, f.after.watermark),
    checkConflictFreeze(f.after.unresolved, f.before.watermark, f.after.watermark),
    checkAppliedMonotone(f.before.applied, f.after.applied),
    checkTally(f.after.tally),
    checkTallyNonNegative(f.after.tally),
    f.writeOrder ? checkWriteOrdering(f.writeOrder) : null,
    f.outcomes ? checkPackageCompleteness(f.outcomes, f.after.applied) : null,
    f.needRetry ? checkRetryEligibility(f.needRetry, f.after.applied) : null
  ]
  return out.filter((x): x is InvariantViolation => x !== null)
}
