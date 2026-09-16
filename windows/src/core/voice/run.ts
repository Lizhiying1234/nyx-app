/**
 * 照序列跑 —— **预算的执行也只有一份** · D-466
 *
 * ── 为什么这一段必须在 core，而不是每个执行器各写一遍 ★★ ────
 *
 * `resolve()` 只说「词典这一步最多 150 ms」。**说了不等于做了。**
 * 真正让「Assist 慢」变成「Assist 不慢」的，是有人**真的**在 150 ms 上
 * 把那一步扔掉、往下走。这件事写三遍 = 三个平台各有一次写漏的机会，
 * 而写漏的症状是「有时候点了半天不响」—— 最难复现、最容易被当成玄学的那一类。
 *
 * 所以序列在 core，跑序列也在 core；平台只提供「这一步具体怎么做」。
 *
 * ── 超时之后那个 Promise 怎么办 ────────────────────────────
 *
 * **管不了，也不装作管得了。** JS 没有取消原语，词典那次慢查照样会跑完。
 * 我们能保证的只有一件事：**不再等它，也不让它把整趟带崩** ——
 * 所以给它挂一个空的 catch（否则它晚一点抛出来会变成 unhandledRejection，
 * 而那在 Electron 主进程里是会打日志、在 Android WebView 里是会红屏的）。
 */

import type {
  SourceId,
  StepOutcome,
  VoiceAttempt,
  VoicePlan,
  VoiceRequest,
  VoiceTrace,
  VoiceTraceStep
} from './types.ts'

/** 一步的结果：拿到了就返回值，没拿到返回 `null`（miss ≠ 错） */
export type VoiceStep<T> = (request: VoiceRequest, attempt: VoiceAttempt) => Promise<T | null>

/** ★ 定义在 `types.ts`（账本也要用它，放这里会循环依赖），这里只转出去 */
export type { StepOutcome } from './types.ts'

export interface StepRecord {
  source: SourceId
  outcome: StepOutcome
  ms: number
  message?: string
}

export interface VoiceRunResult<T> {
  /** 谁成的。一个都没成就是 `null` */
  source: SourceId | null
  value: T | null
  /** 每一步的账 —— 「为什么用的不是词典音」答得出来靠它 */
  tried: StepRecord[]
  /**
   * **运行账本**。含被跳过的那几步（`tried` 里没有它们）。
   * 平台拿它写日志 / 给界面；不写也不影响出声 —— 账本是诊断，不是判据。
   */
  trace: VoiceTrace
}

export interface RunOptions {
  /** 取时间的地方。默认 `Date.now`，注进来只为让账上的毫秒可测 */
  now?: () => number
  /**
   * ★★ T-7.12 · 这一步 miss 了，**平台知道一个更具体的原因**时说它。
   *
   * ── 为什么要开这个口 ────────────────────────────────────
   *
   * `VoiceStep` 的契约是「拿到了给值，没拿到给 null」—— miss 里没有位置放理由，
   * 于是账本只能说一句通用的「这本词典里没有这个词的发音」。
   * 而 Speex 那一种 miss（`I-165`：词条**有**发音，只是 Chromium 放不出来）
   * 说成「没有这个词的发音」是**假话**：他会去换一个词，而不是换一本词典。
   *
   * ★ 返回 `undefined` = 没有更具体的说法，用通用那句。判据仍在 core
   *   （话术是 `providers/dict-audio.ts::unplayableDictSays`），
   *   平台只负责把「这一趟到底是哪一种 miss」这个事实递进来。
   */
  missSays?: (source: SourceId) => string | undefined
}

/** 超时的哨兵。用独一份的对象比字符串稳 —— 不会和某个 step 的真返回值撞上 */
const TIMED_OUT = Symbol('voice-step-timed-out')

/**
 * 按 `plan` 依次试，每一步卡住 `budgetMs` 就放弃、走下一步。
 *
 * @param steps 每个来源具体怎么做。没给的来源算 `no-handler` —— 不是错，
 *              是「这个平台不做这一档」。
 */
export async function runVoicePlan<T>(
  plan: VoicePlan,
  request: VoiceRequest,
  steps: Partial<Record<SourceId, VoiceStep<T>>>,
  opts: RunOptions = {}
): Promise<VoiceRunResult<T>> {
  const now = opts.now ?? ((): number => Date.now())
  const startedAt = now()
  const tried: StepRecord[] = []

  for (const attempt of plan.attempts) {
    const step = steps[attempt.source]
    if (!step) {
      tried.push({ source: attempt.source, outcome: 'no-handler', ms: 0 })
      continue
    }

    const started = now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const running = step(request, attempt)
      let value: T | null | typeof TIMED_OUT

      if (attempt.budgetMs === null) {
        value = await running
      } else {
        /**
         * ★★ 预算判据就是这一句。**把它拆掉 = 慢查阻塞后面的一切。**
         * `voice.test.ts` 里有一条永不 resolve 的词典步盯着它。
         */
        const budget = attempt.budgetMs
        value = await Promise.race([
          running,
          new Promise<typeof TIMED_OUT>((r) => {
            timer = setTimeout(() => r(TIMED_OUT), budget)
          })
        ])
        // 输掉比赛的那个 Promise 还在跑 —— 不等它，但也不许它变成 unhandledRejection
        if (value === TIMED_OUT) void Promise.resolve(running).catch(() => undefined)
      }

      if (value === TIMED_OUT) {
        tried.push({
          source: attempt.source,
          outcome: 'timeout',
          ms: now() - started,
          message: `超过 ${attempt.budgetMs} ms 没给出结果，不等了`
        })
        continue
      }
      if (value === null || value === undefined) {
        tried.push({ source: attempt.source, outcome: 'miss', ms: now() - started })
        continue
      }
      tried.push({ source: attempt.source, outcome: 'hit', ms: now() - started })
      return {
        source: attempt.source,
        value,
        tried,
        trace: buildTrace(plan, request, tried, attempt.source, startedAt, now(), opts)
      }
    } catch (err) {
      /** 一步炸了不该让整趟停 —— 后面还有兜底，这正是序列存在的理由 */
      tried.push({
        source: attempt.source,
        outcome: 'error',
        ms: now() - started,
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return {
    source: null,
    value: null,
    tried,
    trace: buildTrace(plan, request, tried, null, startedAt, now(), opts)
  }
}

/**
 * 把一趟的事实搬成账本 —— ★ **被跳过的也要进去**。
 *
 * 「为什么没用词典音」这个问题，答案往往不在 `tried` 里而在 `skipped` 里
 * （关着 / 这台机器上用不了）。只记 tried 就是把理由丢在半路。
 */
function buildTrace(
  plan: VoicePlan,
  request: VoiceRequest,
  tried: readonly StepRecord[],
  spoke: SourceId | null,
  startedAt: number,
  endedAt: number,
  opts: RunOptions
): VoiceTrace {
  const steps: VoiceTraceStep[] = []
  for (const t of tried) {
    steps.push({ source: t.source, outcome: t.outcome, ms: t.ms, reason: reasonOf(t, opts) })
  }
  for (const sk of plan.skipped) {
    steps.push({ source: sk.source, outcome: 'skipped', ms: 0, reason: sk.why })
  }
  return {
    at: startedAt,
    kind: request.kind,
    origin: request.origin,
    planned: plan.attempts.map((a) => a.source),
    steps,
    spoke,
    ms: endedAt - startedAt
  }
}

/** 一步的结果怎么用人话说 —— 账本与 `explain()` 共用这一份，不写两遍 */
function reasonOf(t: StepRecord, opts: RunOptions = {}): string {
  if (t.outcome === 'hit') return '就是它出的声'
  if (t.outcome === 'no-handler') return '这台机器上没接这一档'
  // ★ miss 要说得具体：词典那一步的 miss 就是「这个词它没有」，那才是他想知道的
  if (t.outcome === 'miss') {
    // ★★ T-7.12 · 平台知道得更具体就听它的（Speex 放不出来 / 索引还没建好）
    const said = opts.missSays?.(t.source)
    if (said) return said
    return t.source === 'dictionary' ? '这本词典里没有这个词的发音' : '没有现成的'
  }
  if (t.outcome === 'timeout') return t.message ?? '超时了'
  return t.message ?? '出错了'
}

/** 把账翻成一句人话 —— 「为什么用的不是词典音」 */
export function explain(result: VoiceRunResult<unknown>): string {
  const said: string[] = []
  for (const st of result.trace.steps) {
    if (st.outcome === 'hit') continue
    said.push(`${st.source}：${st.reason}`)
  }
  return said.join('；')
}
