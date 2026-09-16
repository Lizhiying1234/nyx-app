/**
 * ★★ Step 7D · 时间源 —— **生产永远是真实系统时间，测试可以注入**
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 *
 * 同步里有一整类事故只有在**两台机器的时钟不一致**时才发生：
 * 慢钟设备的编辑被判成「对面没改过」、时钟回拨让水位落在未来、
 * 远端戳比本机 `now` 还新。这些都已经在 I 层（直接改库里的时间戳）验过，
 * 但 S 层（两个真 Electron 实例）验不了 —— 应用内部直接调 `Date.now()`，
 * 测试够不着。够不着的那一层，恰恰是他真正在用的那一层。
 *
 * ── 为什么不 monkey patch `Date.now()` ──────────────────────
 *
 * 那要同时改主进程、渲染进程、Playwright 三层，而且是**进程级全局**：
 * 一个测试改了时间，同一进程里别的测试跟着看到假时间，串味且极难排查。
 * 这里改成**显式的时间源** + **按进程注入**：每个 Electron 实例是独立进程，
 * 各自读自己的环境变量，天然互不干扰（并行隔离是免费得到的，不是设计出来的）。
 *
 * ── 边界：它只服务四件事 ────────────────────────────────────
 *
 *   `startedAt`（一次同步的开始时刻）· 变更包的时间戳（包名与包头 `at`）
 *   本地写入的 `updated_at`（`db/repo.ts` 那一个 `now()`）
 *
 * **不往业务层扩散**。业务代码要时间就继续用 `Date.now()` ——
 * 时间源扩散到哪里，哪里就多一个「测试和生产行为不同」的可能。
 *
 * ── 三条硬保证 ──────────────────────────────────────────────
 *
 *   ① **打包之后一律真实时间**：`packaged === true` 时环境变量直接不看。
 *      他手上那份软件不存在「时间被注入」这条路。
 *   ② **不落库**：这里只算数，没有任何写入。假时间产生的时间戳会随业务行
 *      落库（那是它的用途），但「现在几点」这件事本身不持久化。
 *   ③ **不进协议**：`SyncRow`、包格式、`protocolVersion` 一个字都没动。
 */

export interface Clock {
  now(): number
}

export const RealClock: Clock = { now: () => Date.now() }

/**
 * 环境变量的两种写法：
 *
 *   `fixed:1700000000000`   钉死在这一刻，不走
 *   `offset:+1200000`       真实时间 ± 这么多毫秒（快钟 / 慢钟）
 *
 * ★ 解析是**纯函数**，可以单独证伪 —— 时间源写错是静默的，
 *   它不会报错，只会让一整批测试悄悄验的是别的东西。
 */
export function parseClockSpec(spec: string | undefined | null): ((real: number) => number) | null {
  if (!spec) return null
  const m = /^(fixed|offset):([+-]?\d+)$/.exec(spec.trim())
  if (!m) return null
  const kind = m[1]
  const n = Number(m[2])
  if (!Number.isFinite(n)) return null
  return kind === 'fixed' ? () => n : (real: number) => real + n
}

/**
 * ★★ 允许注入吗。**打包之后永远不允许**，和环境变量里写了什么无关。
 *
 * 这一条是生产侧的唯一防线，所以它是一个可以单独测的纯谓词 ——
 * 「测试用的东西泄漏到生产」不该靠人读代码来保证。
 */
export function allowsTestClock(o: { packaged: boolean; spec?: string | null }): boolean {
  if (o.packaged) return false
  return parseClockSpec(o.spec) !== null
}

export function makeClock(o: {
  packaged: boolean
  spec?: string | null
  real?: () => number
}): Clock {
  const real = o.real ?? (() => Date.now())
  if (!allowsTestClock(o)) return { now: real }
  const map = parseClockSpec(o.spec)!
  return { now: () => map(real()) }
}

/**
 * 进程级的那一个。默认真实时间 —— **不装任何东西时行为和以前完全一样**，
 * 这是「所有现有测试默认行为不变」那条要求的落点。
 */
let current: Clock = RealClock

/** 只该在启动时调一次（`main/index.ts`），以及 I 层测试里调 */
export function installClock(c: Clock): void {
  current = c
}

/** 现在几点 —— 同步与本地写入的唯一时间入口 */
export function now(): number {
  return current.now()
}

/** 测试收尾用：把时间源放回真实时间，免得串到下一条用例 */
export function resetClock(): void {
  current = RealClock
}

/** 这个进程有没有被注入过假时间（诊断用，不参与判断） */
export function isFakeClock(): boolean {
  return current !== RealClock
}
