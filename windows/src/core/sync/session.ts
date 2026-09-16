import type { Resolution } from '../sync-merge.ts'
import {
  checkConflictFreeze,
  checkPackageCompleteness,
  checkRetryEligibility,
  checkTally,
  checkTallyNonNegative,
  checkWatermarkMonotone,
  checkWriteOrdering,
  packageIsComplete,
  type InvariantViolation,
  type PackageOutcome
} from './invariants.ts'
import {
  emptyTally,
  type ExecutionResult,
  type Step,
  type SyncFacts,
  type SyncState,
  type Tally
} from './types.ts'

/**
 * 同步会话的编排判据 · ★★ Step 6 · Commit B / D-292（2026-08-18）
 *
 * ── 这个文件存在的理由 ──────────────────────────────────────
 *
 * Commit A 把七条不变量写成了可证伪的判据，但**判据不等于实现**：
 * 判据说「四个桶必须对得上账」，真正决定每一行落进哪个桶的代码
 * 还在 `main/sync/index.ts` 里。Android 那一侧要么共用它，要么再写一份 ——
 * 再写一份的意思是：同一条协议在两个平台上各有一套记账、一套水位、
 * 一套「这一包算不算处理完」，而它们**分歧的时候不会有任何报错**，
 * 只会表现成「两台机器的数字对不上」，谁都查不出是哪一边错了。
 *
 * 所以这里放的是**决定**，不是 IO：
 *
 *     plan(state, facts) → Step        应该发生什么
 *     apply(state, result) → state'    发生完了怎么记账
 *
 * 平台层只负责「真的去做」：调云端、开事务、写库、报日志。
 *
 * ── Commit B 分五步搬，这是第 1 步 ──────────────────────────
 *
 * 第 1 步只搬**四桶记账**。它风险最低（纯算术、没有顺序依赖），
 * 而且搬完立刻能拿 `checkTally` 验恒等式 —— 先把最容易证伪的那一块
 * 挪过来，后面几步才有踩得稳的地面。
 */

// ══════════════════════════════════════════════════════════════
// 四桶记账 —— ★★ R-4-G-e · 全项目只有这一处
// ══════════════════════════════════════════════════════════════

/**
 * 一批处理完之后的**原料**。
 *
 * ★ 全是数，一个平台类型都没有 —— 这是它能被 Android 共用的前提。
 *   以前这个函数收的是 `WriteResult`（`main/` 里的结构，带 `SyncRow`），
 *   那意味着记账和 better-sqlite3 的行对象绑在一起，搬不走。
 */
export interface BatchTally {
  /** 这一批从云端收到多少行（包里一共多少行，不管收不收得下） */
  received: number
  /** 合并阶段就判定「不用动」的 */
  planSkipped: number
  /** 真的写进本地库的 */
  applied: number
  /** `writeRows` 里**有意**跳过的（认不出的出厂内容、空数据行……） */
  writeSkipped: number
  /** 想写但写不进去的 —— 这些会让整包不进 `applied`，下次自动重来 */
  failed: number
  /** 这一批判出来的冲突行数（两边都改过） */
  conflicts: number
}

/**
 * ★★ 把一批的原料记进四个桶。**恒等式靠这里成立，不靠减法凑。**
 *
 * ── 冲突行落在哪个桶，看他有没有做过决定（R-4-F）─────────────
 *
 *   · 没裁决         → `conflicted`。它在等一个人，既不是「有意跳过」
 *                      也不是「技术上写不进去」，混进任何一个都会让那个数
 *                      同时表示「处理完了」和「还没处理」
 *   · 选「用本地的」  → `skipped`。那是一个已经做完的决定，没什么可重试的
 *   · 选「用云端的」  → 它们在写入清单里，会作为 `applied` 回来 ——
 *                      所以这里两个桶都不加，否则同一行被数两次
 *
 * ── 为什么是累加而不是最后算一次 ──────────────────────────
 *
 * 旧实现把原料一批一批攒成散落的计数器（`received` / `planSkipped` /
 * `okRows` / `failedRows` / `writeSkipped` / `conflicts` 六个），
 * 收尾时才调一次 `tally()`。数值上等价（全是求和），但**多了六个
 * 可以各自漂掉的中间变量** —— R-4-G 那次漏计就是这么来的：
 * 加了一类跳过，note 那边加上了，返回值那边忘了。
 *
 * 现在每批只有一次记账，四个桶从同一个结构里出，结构上不可能再分家。
 */
export function addBatch(t: Tally, b: BatchTally, resolve?: Resolution): Tally {
  return {
    received: t.received + b.received,
    applied: t.applied + b.applied,
    skipped:
      t.skipped + b.planSkipped + b.writeSkipped + (resolve === 'local' ? b.conflicts : 0),
    failed: t.failed + b.failed,
    conflicted: t.conflicted + (resolve ? 0 : b.conflicts)
  }
}

/** 从零开始把若干批记完 —— 单测和重放用，`addBatch` 的语义不变 */
export function tallyOf(batches: readonly BatchTally[], resolve?: Resolution): Tally {
  return batches.reduce((t, b) => addBatch(t, b, resolve), emptyTally())
}

/**
 * 四个桶自己检查自己。
 *
 * ★ 返回违规而不是抛异常：同步跑到一半抛出去，他丢的是**这一趟已经
 *   写进去的东西的记账**，而不是数据本身。让它变成一条他看得见的问题
 *   （数据体检 + 设置页），比让整趟同步炸掉有用。
 */
export function auditTally(t: Tally): InvariantViolation[] {
  return [checkTally(t), checkTallyNonNegative(t)].filter(
    (x): x is InvariantViolation => x !== null
  )
}

// ══════════════════════════════════════════════════════════════
// 一包算不算处理完 —— ★★ R-4-A / R-4-F · 全项目只有这一处
// ══════════════════════════════════════════════════════════════

/**
 * 一批处理完之后，每个包发生过什么。
 *
 * ★ 三份名单都是**包名**，不是行 —— 平台层负责把「哪一行来自哪个包」
 *   翻成包名（那需要 `origin` 那张对象身份表，是平台的活），
 *   core 只管「知道了这三件事之后，这一包该不该进 applied」。
 */
export interface BatchPackages {
  /** 这一批下了哪几个包 */
  names: readonly string[]
  /** 整包被拒的（结构 / 协议 / 格式对不上） */
  rejected: readonly string[]
  /** 里面有行写不进去的 */
  withFailedRows: readonly string[]
  /** 里面还有未裁决冲突的 */
  withUnresolvedConflicts: readonly string[]
}

export interface CommitPlan {
  /** 这一批里可以记进 `applied` 的包 */
  commit: string[]
  /** 没处理完、必须留着下次再来的包 */
  retry: string[]
  /** 逐包的下场 —— 交给 `checkPackageCompleteness` 复核用 */
  outcomes: PackageOutcome[]
}

/**
 * ★★ 「这一包处理完了」的判定，**唯一入口**。
 *
 * 旧实现是三处 `badChunks.add(...)` 加一句 `if (!badChunks.has(n))`。
 * 三处散落的写法有一个不会报错的失败形态：**新增第四种「没处理完」时
 * 漏加一处**。漏了之后那一包照样进 `applied`，从此再也不会被读第二遍 ——
 * 两端永久差一截，而四个数全对、体检不亮。
 *
 * 收成一处之后，新增一种只能改 `PackageOutcome`，而 `PackageOutcome`
 * 一改，`packageIsComplete` 与这里都编译不过 —— 漏加变成编译错误。
 *
 * ★ 反过来也要成立：**处理干净的必须进去**。否则每次同步重下一遍，
 *   而且他会一直看到「有失败」——那是另一种形式的谎话。
 */
export function planCommit(b: BatchPackages): CommitPlan {
  const bad = {
    rejected: new Set(b.rejected),
    failed: new Set(b.withFailedRows),
    conflicted: new Set(b.withUnresolvedConflicts)
  }
  const outcomes = b.names.map<PackageOutcome>((name) => ({
    name,
    hasFailedRows: bad.failed.has(name),
    hasUnresolvedConflicts: bad.conflicted.has(name),
    rejected: bad.rejected.has(name)
  }))
  const commit: string[] = []
  const retry: string[] = []
  for (const o of outcomes) (packageIsComplete(o) ? commit : retry).push(o.name)
  return { commit, retry, outcomes }
}

/**
 * 记完账之后复核一遍：该进的进了没有、该重试的还留着没有。
 *
 * ★ 这是**同一件事的第二个说法**，故意的 —— `planCommit` 说「谁该进」，
 *   这里拿最终的 `applied` 名单反过来查。一处写错时两边对不上，
 *   而不是双双沉默。
 */
export function auditCommit(plan: CommitPlan, applied: readonly string[]): InvariantViolation[] {
  return [
    checkPackageCompleteness(plan.outcomes, applied),
    checkRetryEligibility(plan.retry, applied)
  ].filter((x): x is InvariantViolation => x !== null)
}

// ══════════════════════════════════════════════════════════════
// 写入顺序 —— ★★ R-3 · 碑在前
// ══════════════════════════════════════════════════════════════

/**
 * ★★ 墓碑行排在普通实体行**前面**，同类之间保持原来的相对顺序。
 *
 * ── 这一条不是为了正确性 ────────────────────────────────────
 *
 * 判断那一层已经靠 `incoming` 提前看见了本批的碑，所以合并结果和顺序无关。
 * 它要的是**中途失败时库里的状态也自洽**：先落碑再落别的，
 * 万一后面某一行炸了，留下的至少是「碑在、东西没进来」，
 * 而不是反过来 —— 反过来那个形状是**复活的入口**。
 *
 * ── 为什么必须稳定 ──────────────────────────────────────────
 *
 * 同类之间的先后是包里的顺序，而外键依赖就藏在里面（父行在子行之前）。
 * 打乱它 = 凭空制造一批「外键还没到」的失败，那些包于是不进 `applied`，
 * 下次重来 —— 表现成「同步永远差一点」，而每一行看起来都没错。
 * 所以这里用**分组**而不是 `sort`：分组的稳定性是显然的，
 * 不依赖「某个 JS 引擎的 sort 是不是稳定的」这种得去查规范的事。
 */
export function orderForWrite<T extends { table: string }>(rows: readonly T[]): T[] {
  const tombs: T[] = []
  const rest: T[] = []
  for (const r of rows) (r.table === 'tombstones' ? tombs : rest).push(r)
  return [...tombs, ...rest]
}

/** 排完之后自己查一遍 —— 判据（`checkWriteOrdering`）和实现分开，一处写错另一处会报 */
export function auditWriteOrder(tables: readonly string[]): InvariantViolation[] {
  const v = checkWriteOrdering(tables)
  return v ? [v] : []
}

// ══════════════════════════════════════════════════════════════
// 水位 + 冲突冻结 —— ★★ R-4-B / R-4-F · 它们是**同一个决定**
// ══════════════════════════════════════════════════════════════

/**
 * ★ 这两条必须一起搬，分开搬会出现「水位在 core、冻结在平台」的中间态 ——
 *   那就是两份判据。而这两份判据分歧的下场是：**待裁决的冲突自己蒸发**，
 *   他从没做过的决定被替他做了。
 */

/** 一张表这一次收到哪儿为止 —— 后面还剩多少行 */
export interface CollectLimit {
  table: string
  /** 收到的最后那一毫秒。水位只能停在它上面（见下面「为什么是毫秒不是行」） */
  edge: number
  /** 这张表还剩多少行没收 */
  left: number
}

export interface PushReach {
  /** 一次装不下、被截断的表 */
  truncated: readonly CollectLimit[]
  /** ★★ C-2 · 本地关系断了、翻译不出跨设备身份的行 */
  untranslatable: readonly { at: number }[]
}

/**
 * 这一趟**真正推完到哪个时刻**。`null` = 全推完了。
 *
 * ── 为什么不是「推了几行」而是一个时刻 ──────────────────────
 *
 * 水位本身就是游标（`updated_at > wm` 才算「这一侧改过」），
 * 所以「没推完」的正确表达是**让水位停在实推位置**，
 * 而不是另发明一套分页协议。下一次同步自然接着往下走。
 *
 * ── 两种把水位拽回来的力量 ──────────────────────────────────
 *
 * ① 表被截断（R-4-B）：停在**边界那一毫秒上**。
 *    停在它之后会跳过同一毫秒里的同伴，停在它之前下一次原地打转 ——
 *    所以收集那一侧把边界那一毫秒的行整组带上，水位正好落在它上面。
 * ② 有行翻译不出去（C-2）：停在**那一行之前**（`at - 1`）。
 *    越过去它就再也不会被收集，那正是「悄悄少一行」。
 *    卡住之后每次同步都会再碰到它、再报一次 —— 这是有意的。
 *
 * 两种一起出现时取**最小的那个**：任何一条没推干净，水位就不许越过它。
 */
export function pushedUpTo(f: PushReach): number | null {
  let upTo: number | null = null
  const hold = (at: number): void => {
    upTo = upTo === null ? at : Math.min(upTo, at)
  }
  for (const t of f.truncated) if (t.left > 0) hold(t.edge)
  for (const u of f.untranslatable) hold(Math.max(0, u.at - 1))
  return upTo
}

export interface WatermarkFacts {
  /** 上次同步完成的水位 */
  watermark: number
  /** 这一趟开始的时刻 —— 全推完时水位走到这里 */
  startedAt: number
  /** `pushedUpTo()` 的结果 */
  pushedUpTo: number | null
  /** 还没裁决的冲突数 */
  unresolved: number
}

/**
 * ★★ 水位推到哪里。**这一个表达式同时是两条不变量。**
 *
 * ── 冲突未决 → 一步都不许动（R-4-F / D-201）─────────────────
 *
 * 水位同时被两件事用着：「我推到哪了」和「这一行在上次同步之后改过没有」。
 * 水位一往前走，下一轮远端那一版就落到水位之下、不再算「改过」，
 * 于是判成 keep-local —— **冲突自己没了**，他从没做过的决定被替他做了。
 * 那正是 D-201 要防的「静默覆盖」。
 *
 * 代价是这期间每次同步会把水位之上那些行重推一遍（幂等，对面判 `same`
 * 直接跳过），他一裁决就恢复正常。「多花一次流量」和「悄悄替他做决定」
 * 之间，这个取舍不难选。
 *
 * ── 没推完 → 停在实推位置（R-4-B）──────────────────────────
 *
 * 一次装不下的时候推到 `startedAt`，等于宣布「水位之前的都推过了」——
 * 而没推的那些从此再也不会被收集。
 *
 * ── 单调（不变量 ①）────────────────────────────────────────
 *
 * 两条路都不会让它倒退：冻结那一路原样返回 `watermark`；
 * 前进那一路里 `pushedUpTo` 来自本趟收集的行，`startedAt` 是本趟开始的时刻，
 * 都在旧水位之上。**显式清空是唯一的例外，它走 `markWiped`，不经过这里。**
 */
export function nextWatermark(f: WatermarkFacts): number {
  if (f.unresolved > 0) return f.watermark
  return f.pushedUpTo ?? f.startedAt
}

/** 算完自己查一遍 —— 判据和实现分开，一处写错另一处会报 */
export function auditWatermark(
  before: number,
  after: number,
  unresolved: number
): InvariantViolation[] {
  return [
    checkWatermarkMonotone(before, after),
    checkConflictFreeze(unresolved, before, after)
  ].filter((x): x is InvariantViolation => x !== null)
}

// ══════════════════════════════════════════════════════════════
// 这一趟要处理哪些包、怎么切批 —— ★★ I-068 / R-4-C-a
// ══════════════════════════════════════════════════════════════

/** 一批最多几个包 / 几行 · R-4-C-a。两个闸**先到者为准** */
export const PULL_PACKS = 25
export const PULL_ROWS = 5000

export interface TodoFacts {
  /** 云端列出来的包名，原样（不用先排序） */
  available: readonly string[]
  /** 这台机器的编号 —— 自己推的包不用再下回来 */
  device: string
  /**
   * ★★ F-009 · **这台机器用过的旧编号**（重新铸号之前那些）。
   *
   * 为什么需要它：Android 的自动备份会把整个库（含 `sync.device`）恢复到新机器上。
   * 恢复之后如果不换号，两台机器同号，各自把对方的包当成「自己推的」全部跳过 ——
   * 永远收不到对方的数据，而且两边都显示「同步成功，收到 0 行」。
   * 所以恢复时要铸新号；而旧号推的那些包**也是自己推的**，同样不该下回来
   * （下回来只会判成 `same`，纯浪费，而且会把 applied 撑满）。
   *
   * 不填 = 没换过号（Windows 就是这样）。
   */
  formerDevices?: readonly string[]
  /** 已经处理完的包名 */
  applied: readonly string[]
  /** 清空墓碑的时刻。0 = 没清空过 */
  wipedAt: number
}

/**
 * ★★ 这一趟要处理哪些包，**按什么顺序**。
 *
 * ── 三道过滤，每一道都有代价 ────────────────────────────────
 *
 * ① 自己推的不下（`<自己>-` 开头）—— 下回来只会判成 `same`，纯浪费
 * ② 已经处理完的不下 —— `applied` 是这条协议里唯一的重试机制
 * ③ **I-068 · 比清空墓碑旧的一律不认**。包名是 `<设备>-<时间戳>.json`，
 *    时间戳就在名字里，所以不用开包就判得出。
 *    ★ 名字里解析不出时间戳的（不是本软件写的）**也不认** ——
 *      宁可漏不可错：收一个来路不明的包进来，等于让清空这个动作失效。
 *
 * ── 为什么要排序 ────────────────────────────────────────────
 *
 * 名字里带时间戳，排序 = 按推送先后处理。同一条内容的多个版本落在
 * 不同包里时，顺序处理才收敛得对；而且**分批是按这个顺序切的**，
 * 顺序不定意味着「第 N 批装了哪几个包」每次都不一样，
 * 中途失败之后的续跑就不可复现了。
 */
export function planTodo(f: TodoFacts): string[] {
  const done = new Set(f.applied)
  /** 现用号 + 所有旧号 —— 空号不算（`-` 开头会把别人的包也误伤掉） */
  const mine = [f.device, ...(f.formerDevices ?? [])].filter((d) => d.trim() !== '').map((d) => `${d}-`)
  return f.available
    .filter((n) => !mine.some((p) => n.startsWith(p)) && !done.has(n))
    .filter((n) => {
      if (f.wipedAt === 0) return true
      const ts = Number(n.replace(/\.json$/, '').split('-').pop())
      return Number.isFinite(ts) && ts > f.wipedAt
    })
    .sort()
}

/**
 * ★★ 装到这一批为止了吗（R-4-C-a）。
 *
 * 「装不装得下」只能**边下边判** —— 列目录只给得出包名，给不出每个包有几行。
 * 所以判据是：**已经装了东西**，而且两个闸有一个到了。
 *
 * ★ 第一个条件不能省。省掉之后，单个包自己就超过行上限时会切出一个空批，
 *   于是一个包都处理不动 —— 死循环，而且看起来像「同步卡住了」。
 *   **一个包永远不拆开**：拆包会把「同一次推送的那批行」割裂开，
 *   而 `origin`、「这一包干净不干净」的判定全都以包为单位。
 */
export function batchIsFull(packs: number, rows: number): boolean {
  return packs > 0 && (packs >= PULL_PACKS || rows >= PULL_ROWS)
}

// ══════════════════════════════════════════════════════════════
// ★★ plan / apply —— 编排本身
// ══════════════════════════════════════════════════════════════

/**
 * 一次会话的起点。平台把「查得到的事实」填进来，别的都由这里定。
 */
export function startSession(o: {
  startedAt: number
  watermark: number
  wipedAt: number
  device: string
  /** ★ F-009 · 这台机器用过的旧编号（从备份恢复过才有） */
  formerDevices?: readonly string[]
  identity: SyncState['identity']
  applied: readonly string[]
  resolve?: Resolution
}): SyncState {
  return {
    startedAt: o.startedAt,
    watermark: o.watermark,
    wipedAt: o.wipedAt,
    device: o.device,
    formerDevices: o.formerDevices ?? [],
    identity: o.identity,
    applied: o.applied,
    todo: [],
    cursor: 0,
    tally: emptyTally(),
    rejections: [],
    badChunks: [],
    batch: [],
    batchRejected: [],
    batchFailed: [],
    batchConflicted: [],
    unresolved: 0,
    pushedUpTo: null,
    resolve: o.resolve,
    phase: 'start'
  }
}

/**
 * ★★ 下一步该干什么。**同样的 `state + facts` 必须算出同样的 `Step`。**
 *
 * ── 这个函数存在的全部理由，是那条顺序 ────────────────────
 *
 * 判据（水位、记账、包完成度…）上面已经一条条搬过来了。剩下的、
 * 也是最容易被第二个平台写错的，是**步骤之间的先后**：
 *
 *   ① \`collect\` 必须排在**第一个 \`fetch\` 之前，而且只做一次**（R-4-C-a）。
 *      反过来的话，刚从云端拉下来的行会被算成「我这边的新改动」原样推回去 ——
 *      数据在两台机器之间来回弹，第三台还会看到同一条内容被两个设备
 *      分别声明改过。**这不是「先做哪个好看」，是一条不变量。**
 *   ② \`commitApplied\` 是**批级**的，不是终局的（坑 2）。第 N+1 批炸了，
 *      前 N 批的成果要算数 —— 所以它排在每一批的 \`purge\` 之后，
 *      而不是整趟的最后。
 *   ③ 水位（\`advanceWatermark\`）排在 \`push\` **之后**：推到哪儿才算到哪儿。
 *
 * 这三条只能从真实代码里读出来，凭想象排不出来 —— 而它们错了都不报错。
 */
export function plan(state: SyncState, facts: SyncFacts = {}): Step {
  switch (state.phase) {
    case 'start':
      return { kind: 'list' }

    /**
     * ★★ R-4-C-a · 列完包**马上收本地要推的行**，绝不先 fetch。
     * 相机器里这一条是靠「\`listed\` 只能通向 \`collect\`」保证的 ——
     * 没有任何一条路径能从 \`listed\` 直接走到 \`fetch\`。
     */
    case 'listed':
      return { kind: 'collect', since: state.watermark }

    case 'collected':
    case 'batching': {
      // 还有没处理的包 → 再切一批。切多少由执行器边下边判（`batchIsFull`）
      if (state.cursor < state.todo.length) {
        return { kind: 'fetch', packages: state.todo.slice(state.cursor) }
      }
      return { kind: 'push', rows: facts.outgoing ?? [] }
    }

    case 'fetched':
      return { kind: 'write', batch: facts.packages ?? [] }

    case 'written':
      return { kind: 'purge', batch: facts.packages ?? [] }

    /**
     * ★★ R-4-A · 这一批哪几个包算处理完了 —— 判据就是 \`planCommit\`，
     * 平台层拿到名单照着记就行。
     */
    case 'purged':
      return {
        kind: 'commitApplied',
        packages: planCommit({
          names: state.batch,
          rejected: state.batchRejected,
          withFailedRows: state.batchFailed,
          withUnresolvedConflicts: state.batchConflicted
        }).commit
      }

    case 'pushing':
      return { kind: 'push', rows: facts.outgoing ?? [] }

    /** ★ 水位在**推完之后**才动：推到哪儿才算到哪儿（R-4-B） */
    case 'pushed':
      return {
        kind: 'advanceWatermark',
        to: nextWatermark({
          watermark: state.watermark,
          startedAt: state.startedAt,
          pushedUpTo: state.pushedUpTo,
          unresolved: state.unresolved
        })
      }

    case 'done':
      return { kind: 'done', tally: state.tally }
  }
}

/**
 * ★★ 执行完一步之后，状态变成什么样。**记账只在这里发生。**
 *
 * 纯函数：不改传进来的 `state`，返回新的。可重放、可单测 ——
 * 「中途炸了会怎样」因此变成一个能写下来的测试，而不是要真造一次断网。
 */
export function apply(state: SyncState, r: ExecutionResult): SyncState {
  switch (r.step) {
    case 'list':
      return {
        ...state,
        todo: planTodo({
          available: r.packages,
          device: state.device,
          formerDevices: state.formerDevices,
          applied: state.applied,
          wipedAt: state.wipedAt
        }),
        phase: 'listed'
      }

    case 'collect':
      return { ...state, pushedUpTo: r.upTo, phase: 'collected' }

    /** 执行器实际拿了几个包，游标就走几个 —— **一个包永远不拆开** */
    case 'fetch':
      return {
        ...state,
        cursor: state.cursor + r.packages.length,
        batch: r.packages.map((p) => p.name),
        batchRejected: [],
        batchFailed: [],
        batchConflicted: [],
        phase: 'fetched'
      }

    case 'write': {
      const failed = [...new Set(r.failed.map((f) => f.chunk).filter((c): c is string => !!c))]
      const conflicted = [...new Set(r.conflictChunks)]
      return {
        ...state,
        tally: addBatch(
          state.tally,
          {
            received: r.received,
            planSkipped: r.planSkipped,
            applied: r.applied,
            writeSkipped: r.skipped,
            failed: r.failed.length,
            conflicts: r.conflicted
          },
          state.resolve
        ),
        unresolved: state.unresolved + (state.resolve ? 0 : r.conflicted),
        batchRejected: [...state.batchRejected, ...r.rejected],
        batchFailed: failed,
        batchConflicted: conflicted,
        badChunks: [
          ...new Set([...state.badChunks, ...r.rejected, ...failed, ...conflicted])
        ],
        phase: 'written'
      }
    }

    case 'purge':
      return { ...state, phase: 'purged' }

    /**
     * ★★ applied **每批落一次盘**（坑 2）。所以这里回到 `batching`，
     * 而不是往终局走 —— 下一批接着来。
     */
    case 'commitApplied':
      return {
        ...state,
        applied: [...new Set([...state.applied, ...r.packages])],
        phase: 'batching'
      }

    case 'push':
      return { ...state, phase: 'pushed' }

    case 'advanceWatermark':
      return { ...state, watermark: r.to, phase: 'done' }

    case 'error':
      return state
  }
}

// ══════════════════════════════════════════════════════════════
// ★★ Step 6C · 推送游标 ≠ 判别基准（2026-08-18 / D-292）
// ══════════════════════════════════════════════════════════════

/**
 * ★★ 一个数不许再干两件事。
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * 到 Step 6B 为止，`watermark` 同时是两样东西：
 *
 *   ① 推送游标      「本机时间戳 ≤ W 的行我都交给云端了」
 *   ② 判别基准      「时间戳 > W 的行算作『上次同步之后改过』」——**两侧都用它**
 *
 * 这两个角色对单调性的要求**方向相反**：
 *
 *   ① 必须允许后退。后退 = 重推，对面判 `same` 跳过，幂等，只花流量。
 *      前进过头 = 那些行再也不会被收集 —— 静默丢数据。
 *      （`core/restore-merge.ts` 的 `mergeWatermark` 取 min，就是这条。）
 *   ② 必须不许进入未来。一旦基准 > 现在，本地行和远端行的时间戳**双双**
 *      落在它之下，`localChanged` 与 `remoteChanged` 同时为 false，
 *      `decideRow` 掉进最后那条兜底分支 → **冲突检测被静默关掉**，
 *      退化成 last-writer-wins-by-clock。那正是 D-201 要防的静默覆盖。
 *
 * 合在一个数上，就只能二选一。选了 ①（现在这样），②在未来态下就是错的。
 *
 * ── 怎么进入未来态 ──────────────────────────────────────────
 *
 * 两条路，都不经过任何校验：
 *   · 本机时钟被回拨（手动改、自动校时、离线漂移）—— 存下来的值相对
 *     「现在」就成了未来。**Android 上这是家常便饭。**
 *   · 远端行带着未来戳原样入库（这是对的，见下），之后经 `pushedUpTo`
 *     的 `untranslatable`（`at - 1`）或截断 `edge` 把游标顶进未来。
 *
 * ── 为什么不 clamp 远端的 `updated_at` ──────────────────────
 *
 * 因为 `decideRow` 的第一档判据是 `local.updatedAt === remote.updatedAt → same`。
 * 入库时 clamp 成 `min(remote, now)`，同一行在两台机器上的时间戳就**永久不同**，
 * 于是每次同步双方都判「不一样」、互相重推互相覆盖 —— 永不收敛的 ping-pong，
 * 而且四个数全对、体检不亮。**clamp 比不 clamp 坏得多。**
 */
export function decisionCutoff(pushCursor: number, startedAt: number): number {
  return Math.min(pushCursor, startedAt)
}

/**
 * ★ 判别基准**只用来判**，绝不落盘。
 *
 * 落盘的还是推送游标 —— 它的语义一个字没变（`collectSince` / `countPending`
 * 照旧读它）。钳制发生在**读取的那一刻**，所以：
 *   · 时钟回拨造成的未来态，下一趟自己就走出来了（游标仍然允许后退）
 *   · 而在走出来之前的那些趟里，冲突检测**不会被关掉**
 *
 * 换句话说：自愈机制保留，危险窗口关掉。
 */
export function isCutoffInFuture(pushCursor: number, startedAt: number): boolean {
  return pushCursor > startedAt
}

/**
 * ★★ 观测到的时钟偏移 —— **纯诊断，不参与任何判断。**
 *
 * 「设备时钟错」和「数据真的在未来」在协议层**分不清，也不该试图分清**：
 * store 是哑的 blob 存储，没有服务端时钟，没有第三方可以裁决；
 * 而手动改时间、时区变化、自动校时、离线漂移在 Android 上全是正常操作。
 * 把未来戳当 corruption 去拒包，等于让正常使用的人永久失去同步 ——
 * 而且**拒绝是不可逆的**（那一包永远不进 `applied`，也永远不被接受）。
 *
 * 所以：合并照收照用，同时把偏移量量出来告诉他。
 * 因为这两件事**他能做的处置完全不同** —— 时钟错就去把那台设备的时间调对，
 * 数据真在未来就什么都不用做。软件分不清的时候，正确的做法是把观测到的事实
 * 交给唯一分得清的人，不是替他猜，更不是替他改时间。
 */
export function clockSkewObservedMs(maxRemoteUpdatedAt: number, localNow: number): number {
  return Math.max(0, maxRemoteUpdatedAt - localNow)
}

/** 偏移大到值得说一句的门槛 —— 低于它不吭声，免得变成天天亮的红灯 */
export const SKEW_NOTICE_MS = 5 * 60_000

export function describeClockSkew(skewMs: number): string | null {
  if (skewMs < SKEW_NOTICE_MS) return null
  const m = Math.round(skewMs / 60_000)
  const how = m >= 120 ? `约 ${Math.round(m / 60)} 小时` : `约 ${m} 分钟`
  return (
    `发现另一台设备的时间可能比本机快${how}。` +
    `同步照常进行、数据一条都没丢，但两台机器的「谁更新」会按各自的时钟算 —— ` +
    `请把那台设备的时间调准。`
  )
}
