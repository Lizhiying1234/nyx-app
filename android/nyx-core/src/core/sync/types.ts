/**
 * 同步会话的类型骨架 · ★★ Step 6 · Commit A / D-292（2026-08-18）
 *
 * ── 这一层要解决什么 ────────────────────────────────────────
 *
 * 同步的判据现在分两处：
 *   `core/`            合并、墓碑、裁决、身份、协议、边界翻译 —— 已经在了
 *   `main/sync/index.ts`  水位、applied、冲突冻结、四桶记账、写入顺序、
 *                         「一包算不算处理完」、重试资格 —— **还在平台层**
 *
 * 后面那七条**每一条写错都是静默的**（漏行、永久重试、冲突自己蒸发），
 * 而 Android 要么共用它们，要么写第二份。写第二份 = 把这个项目最擅长
 * 制造、也最难发现的那类 bug 复制到第二个平台。
 *
 * 所以把「决定应该发生什么」搬进 core，「真的去做」留在平台：
 *
 *     plan(state, facts) → Step        决定
 *     apply(state, result) → state'    记账
 *     平台执行 Step，把结果交回来
 *
 * ── Commit A 只做类型与判据骨架 ────────────────────────────
 *
 * 这一版**不改 Windows 的任何行为**。它建立三样东西：
 *   ① 三个明确的数据结构（State / Facts / Result）与 Step 联合类型
 *   ② 七条不变量的**纯判据**（`invariants.ts`），可以被单独证伪
 *   ③ `SyncRow` / `LocalRow` 的类型隔离
 * Commit B 再把 `run()` 改写成执行器。
 *
 * 分两步的理由：同步是这套代码里**唯一一处出错会静默丢数据**的子系统，
 * 一次性把 680 行编排推倒重来，然后靠「测试绿了」宣布成功 ——
 * 那正是第九节列的那种事故形状。先把判据固定下来、先把对拍基线录好，
 * 再动编排，每一步都有东西兜着。
 */

import type { SyncRow } from '../sync-merge.ts'
import type { RejectCode } from '../sync-protocol.ts'

// ══════════════════════════════════════════════════════════════
// ① 类型隔离：本地行 ≠ 同步行
// ══════════════════════════════════════════════════════════════

declare const LOCAL_BRAND: unique symbol
declare const SYNC_BRAND: unique symbol

/**
 * 从本地库读出来的一行，**原样**：带 `id`、外键是数字。
 *
 * ★ 打标记（brand）不是为了好看：C-2 之前 `writeRows` 就是把本地行
 *   原样塞进包里的，而那正是「两台各建一行抢同一个自增号」的来源。
 *   标记让「把本地行直接交给 RemoteStore」变成一个**编译期错误**，
 *   而不是一个要靠人记得的规矩。
 */
export type LocalData = Record<string, unknown> & { readonly [LOCAL_BRAND]?: never }

/** 同步包里的一行：**没有本地 id，关系全是 uid**（C-2 之后的形状） */
export type SyncData = Record<string, unknown> & { readonly [SYNC_BRAND]?: never }

/** 唯一的构造入口 —— 平台层翻译完之后调它，别处不许直接断言 */
export const asSyncData = (d: Record<string, unknown>): SyncData => d as SyncData
export const asLocalData = (d: Record<string, unknown>): LocalData => d as LocalData

// ══════════════════════════════════════════════════════════════
// ② 会话状态 · 事实 · 执行结果
// ══════════════════════════════════════════════════════════════

/**
 * 一次同步会话的**全部状态**。
 *
 * 判据只看它 —— `plan()` 不许自己去查库。同样的 `state + facts`
 * 必须算出同样的 `Step`，否则它就不是可重放、可单测的。
 */
export interface SyncState {
  /** 这一趟开始的时刻。水位推进的上界 */
  startedAt: number
  /** 上次同步完成的水位。`updated_at > watermark` 就是「这一侧改过」 */
  watermark: number
  /** 清空墓碑：比它旧的云端包一律不认（按包名里的时间戳判） */
  wipedAt: number
  /** 这台机器的编号 —— 用来跳过自己推的包 */
  device: string
  /**
   * ★ F-009 · 这台机器用过的**旧**编号（从备份恢复到新机器时会重新铸号）。
   * 旧号推的包同样是「自己推的」，一起跳过。没换过号就是空数组。
   */
  formerDevices: readonly string[]
  /** 本机的结构与协议身份，收包时拿它比 */
  identity: { schemaVersion: number; schemaFingerprint: string; protocolVersion: number }
  /** 已经处理完的包名 */
  applied: readonly string[]
  /** 还没处理的包名，按名字排好序 */
  todo: readonly string[]
  /** 游标：`todo` 里处理到第几个了 */
  cursor: number
  /** 四个桶 + 等裁决的那一个 */
  tally: Tally
  /** 这一趟被整包拒的 */
  rejections: readonly { chunk: string; code: RejectCode; reason: string }[]
  /** 没处理干净、**不许进 applied** 的包名（整趟累计，报数用） */
  badChunks: readonly string[]
  /**
   * ★★ R-4-C-a · **当前这一批**的包名，以及它们各自出了什么事。
   *
   * 「一包算不算处理完」是**批级**判定：这一批写完就要落 applied，
   * 不能等整趟收尾（第 N+1 批炸了，前 N 批的成果要算数）。
   * 所以状态里必须存得下「这一批是哪几个包」，否则 `plan()` 到了
   * `purged` 那一相说不出该记哪几个。
   */
  batch: readonly string[]
  /** 这一批里整包被拒的 */
  batchRejected: readonly string[]
  /** 这一批里有行写不进去的 */
  batchFailed: readonly string[]
  /** 这一批里还有未裁决冲突的 */
  batchConflicted: readonly string[]
  /** 还没裁决的冲突数。> 0 时水位冻住 */
  unresolved: number
  /** 这一趟真正推完到哪个时刻。`null` = 全推完了 */
  pushedUpTo: number | null
  /** 他这一趟的裁决。没裁决就是 `undefined` */
  resolve?: 'remote' | 'local'
  /** 走到哪一步了 */
  phase: SyncPhase
}

/**
 * 走到哪一步了。
 *
 * ★ Commit A 只列了六个（照参考形态排的）。Commit B 把 `run()` 真的改成
 *   plan/apply 循环之后，**「一批」内部的三步必须各自成相**：
 *   写完还没执行碑、执行完碑还没记 applied —— 这两个中间态是真实存在的，
 *   而且中途失败正好停在它们上面。相里没有它们，`plan()` 就没法说出
 *   「炸在这儿之后下一步该干嘛」。
 */
export type SyncPhase =
  | 'start'
  /** 列完了云端有哪些包 */
  | 'listed'
  /** ★★ 收完了本地要推的行（R-4-C-a：这一步**必须**早于任何 fetch） */
  | 'collected'
  /** 批循环：还有没处理的包就再切一批 */
  | 'batching'
  /** 这一批下下来了，还没写 */
  | 'fetched'
  /** 这一批写完了，本批新到的碑还没执行 */
  | 'written'
  /** 碑执行完了，这一批还没记进 applied */
  | 'purged'
  /** 包处理完了，正在推自己的 */
  | 'pushing'
  /** 推完了，水位还没落 */
  | 'pushed'
  | 'done'

/**
 * 四个桶。**只在一处算**（`apply()`），全项目一份。
 *
 * 恒等式：`received = applied + skipped + failed + conflicted`。
 * 它成立不是靠减法凑，是靠**每一行恰好落进一个桶**。
 */
export interface Tally {
  received: number
  applied: number
  skipped: number
  failed: number
  conflicted: number
}

export const emptyTally = (): Tally => ({
  received: 0,
  applied: 0,
  skipped: 0,
  failed: 0,
  conflicted: 0
})

/**
 * 平台喂给 `plan()` 的**事实**。
 *
 * 全都是「已经查到的东西」，不是「可以去查的能力」——
 * `plan()` 拿不到数据库，也拿不到网络。
 */
export interface SyncFacts {
  /** 云端列出来的包名（原样，不排序） */
  availablePackages?: readonly string[]
  /** 这一批下下来的包 */
  packages?: readonly FetchedPackage[]
  /** 本地这一趟要推的行（已经过 C-2 边界翻译） */
  outgoing?: readonly SyncRow[]
}

export interface FetchedPackage {
  name: string
  /** 包头。`null` = 读不出来 */
  header: Record<string, unknown> | null
  /** 包里的行。整包被拒时是空的 */
  rows: readonly SyncRow[]
}

/** 平台执行完一个 Step 之后交回来的东西 */
export type ExecutionResult =
  | { step: 'list'; packages: readonly string[] }
  | { step: 'collect'; rows: readonly SyncRow[]; upTo: number | null; untranslatable: number }
  | { step: 'fetch'; packages: readonly FetchedPackage[] }
  | {
      step: 'write'
      /** 这一批从云端收到多少行 */
      received: number
      /** 合并阶段就判「不用动」的 */
      planSkipped: number
      /** 真的写进本地库的 */
      applied: number
      /** `writeRows` 里**有意**跳过的 */
      skipped: number
      /** 想写但写不进去的。`chunk` 是它来自哪个包 —— 那一包不许进 applied */
      failed: readonly { chunk?: string; message: string }[]
      /** 这一批判出来的冲突行数 */
      conflicted: number
      /** 还有未裁决冲突的包 */
      conflictChunks: readonly string[]
      /**
       * ★ 整包被拒的（结构 / 协议 / 格式对不上）。
       *
       * 它和 `failed` 不是一回事：那是写不进去，这是**根本没打开**。
       * 两者都让那一包不进 `applied`，但报给他看的话完全不同。
       */
      rejected: readonly string[]
    }
  | { step: 'purge'; purged: number }
  | { step: 'commitApplied'; packages: readonly string[] }
  | { step: 'advanceWatermark'; to: number }
  | { step: 'push'; rows: number }
  | { step: 'error'; what: string; message: string }

// ══════════════════════════════════════════════════════════════
// ③ Step —— 「应该发生什么」
// ══════════════════════════════════════════════════════════════

/**
 * 从当前 `run()` 的实际行为归纳出来的九步。
 *
 * 不是照抄参考形态：`collect` 之所以排在 `fetch` 之前，是因为
 * **「先把要推的收好，再往本地写」**是一条不变量（R-4-C-a）——
 * 反过来的话，刚拉下来的行会被算成本地新改动原样弹回云端。
 * 这种顺序上的约束只有从真实代码里读出来，凭想象排不出来。
 */
export type Step =
  /** 列云端有哪些包 */
  | { kind: 'list' }
  /** 收本地要推的行。**必须在任何写入之前**（R-4-C-a） */
  | { kind: 'collect'; since: number }
  /** 下一批包（一批不拆包，见 `PULL_PACKS` / `PULL_ROWS`） */
  | { kind: 'fetch'; packages: readonly string[] }
  /** 合并并落库这一批。顺序：墓碑行在前（R-3） */
  | { kind: 'write'; batch: readonly FetchedPackage[] }
  /** 执行这一批新到的墓碑 */
  | { kind: 'purge'; batch: readonly FetchedPackage[] }
  /** 这几个包处理完了，记进 applied */
  | { kind: 'commitApplied'; packages: readonly string[] }
  /** 推自己的变更 */
  | { kind: 'push'; rows: readonly SyncRow[] }
  /** 水位推到这里 */
  | { kind: 'advanceWatermark'; to: number }
  /** 收工 */
  | { kind: 'done'; tally: Tally }

export type StepKind = Step['kind']
