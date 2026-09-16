import { parseLoose } from '../json-repair.ts'
import { detectProtocol, normalizeBaseUrl, type Protocol, type Slot } from './protocol.ts'

/**
 * AI 调用 · D-202 三协议 / D-205 统一四种失败态
 *
 * 「所有 AI 调用统一四种失败态，每种给明确文案与重试入口；**失败不吞数据**；
 *  连续三次失败时提示检查配置。」
 *
 * 这一条是直接对着 I-001 写的：上一版无论失败原因是什么（key 不对、模型不支持 JSON、
 * 返回格式异常、超时），表现**都是「点了没反应」**。分不清原因，就给不出下一步。
 */

export type FailureKind = 'offline' | 'auth' | 'quota' | 'server' | 'format'

export interface Failure {
  kind: FailureKind
  /** 一句话说清发生了什么 */
  title: string
  /** 展开说明，含服务商原文（如果有） */
  detail: string
  /** 下一步能做什么 */
  actions: ('retry' | 'settings' | 'switchSlot' | 'removeMaterial')[]
  /** 连续第几次失败了 —— 到 3 次要提示检查配置 */
  consecutive: number
}

export class AiError extends Error {
  /** ★ 不用「参数属性」写法 —— Android 侧 node 以 strip-only 跑 TS，不认它 */
  readonly failure: Failure
  constructor(failure: Failure) {
    super(`${failure.title} · ${failure.detail}`)
    this.failure = failure
    this.name = 'AiError'
  }
}

export interface SlotConfig {
  apiKey: string
  baseUrl: string
  model: string
  protocol: Protocol | 'auto'
}

export interface CallOptions {
  system?: string
  user: string
  /** 要求返回 JSON。不是所有模型都支持，所以失败时要能说清是「格式」问题 */
  json?: boolean
  maxTokens?: number
  /**
   * 采样温度 · I-069
   *
   * **判分必须可复现**（D-119 / D-237）。以前一处都没设过，
   * 于是默认走服务商的 1.0 —— 同一句话两次判分给出不同档位，
   * 使用者报的「第一次说不规范、第二次就规范了」就是这么来的。
   *
   * 分工：判分 / 分析 / 判读这类**要求一致性**的任务传 0；
   * 出题、导师对话这类**要求多样性**的不传（用服务商默认）。
   */
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * ★ I-115 · 出参：这次是**因为长度被切断**的吗。
   *
   * 每家 API 都会明说自己为什么停（`finish_reason` / `stop_reason` / `finishReason`），
   * 而原来的 `pick()` 只取正文，**把这句话扔了**。
   * 于是回复被截断时，界面上只剩一句他看不懂的
   * `Expected ',' or ']' after array element in JSON at position 23050` ——
   * 明明服务商已经告诉过我们原因了。
   *
   * 传一个对象进来，调用完读 `meta.truncated`。
   */
  meta?: {
    truncated?: boolean
    stopReason?: string
    /**
     * ★ 2026-09-13 · 这一次模型把多少字符写进了「思考」而不是正文。
     *
     * 推理模型（DeepSeek 的 reasoning_content · Anthropic 的 thinking 块 ·
     * Gemini 的 thought part）**先想后写，而想和写共用同一个 max_tokens**。
     * 额度不够时思考写满、正文一个字都没有 —— 光看正文只知道「空」，
     * 看这个数才知道「空成这样是因为额度全花在思考上了」。
     *
     * ★ 只出**长度**，绝不出内容：**思考不是答案**，
     *   把它当正文显示会是一条很难发现的假话（D-412）。
     */
    reasoningChars?: number
  }
}

/**
 * ★★ 连续失败到第几次开始提醒 —— **判断和那句话用同一个数**（R-01，2026-09-15）。
 *
 * 这句话以前在两处各写一遍：设置 › 测试连接（`Settings.svelte`）与
 * 工作台 › 分析失败（`Workbench.svelte`），**一处带「AI」一处不带**。
 * 同一个事件，屏上两种说法 —— 改词时必漏一处，而且不会报错。
 * ★ 阈值也一起收进来：屏上说「3 次」而条件写 `>= 3`，两个 3 各写各的，
 *   哪天调阈值就会出现「已连续失败 3 次」而其实是第 5 次。
 */
export const CONSECUTIVE_FAIL_AT = 3

/** 那一句本身（K-07 / K-08 改词：去掉「回头」「一下」这两个垫词） */
export const CONSECUTIVE_FAIL_HINT = `已连续失败 ${CONSECUTIVE_FAIL_AT} 次，请检查 AI 配置。`

let consecutiveFailures = 0
export const resetFailureStreak = (): void => {
  consecutiveFailures = 0
}

function fail(
  kind: FailureKind,
  title: string,
  detail: string,
  actions: Failure['actions']
): never {
  consecutiveFailures += 1
  throw new AiError({ kind, title, detail, actions, consecutive: consecutiveFailures })
}

/** HTTP 状态码 → 四种失败态。分不清就归到 server，不许瞎猜。 */
function classify(status: number, body: string): { kind: FailureKind; title: string } {
  if (status === 401 || status === 403) {
    return { kind: 'auth', title: 'API key 或 Base URL 有误' }
  }
  if (status === 402 || status === 429) {
    // 429 也可能是限速而非欠费，文案上不要说死
    return { kind: 'quota', title: '额度用尽，或者被限速了' }
  }
  if (status === 404) {
    return { kind: 'auth', title: '这个地址没找到（Base URL 或模型名可能不对）' }
  }
  if (status >= 500) return { kind: 'server', title: '服务端出错了' }
  return { kind: 'server', title: `服务商返回了 ${status}` }
}

interface Shaped {
  url: string
  headers: Record<string, string>
  body: unknown
  pick: (json: unknown) => string
  /** 服务商说的「我为什么停下来」。三家字段名各不相同 */
  stop: (json: unknown) => string
  /**
   * 这一次模型把多少字符写进了「思考」。三家字段名同样各不相同：
   *   openai-compat  `message.reasoning_content`（DeepSeek / Qwen-QwQ 这一类）
   *   anthropic      `content[]` 里 `type === 'thinking'` 的块
   *   gemini         `parts[]` 里 `thought === true` 的段
   * ★ 只数长度，不取内容（见 CallOptions.meta.reasoningChars 那段）。
   */
  reasoningChars: (json: unknown) => number
}

/** 把同一份请求塑成三种协议各自的形状。 */
function shape(cfg: SlotConfig, opts: CallOptions, protocol: Protocol): Shaped {
  const base = normalizeBaseUrl(cfg.baseUrl, protocol)
  const maxTokens = opts.maxTokens ?? 4096
  const temp = opts.temperature

  if (protocol === 'anthropic') {
    return {
      url: `${base}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: cfg.model,
        max_tokens: maxTokens,
        ...(temp === undefined ? {} : { temperature: temp }),
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: opts.user }]
      },
      /**
       * ★ 这个写法**本身一直是对的**：只收 `type === 'text'`，
       *   thinking 块自然被滤掉，从来没有漏成正文。
       *   但后果和别家一样 —— 额度被 thinking 吃光时 content 里只剩一个
       *   thinking 块，pick 返回 ''，撞的是同一句「空内容」。
       *   所以要修的不是 pick，是下面那句话。
       */
      pick: (j) => {
        const c = (j as { content?: { type: string; text?: string }[] }).content ?? []
        return c
          .filter((x) => x.type === 'text')
          .map((x) => x.text ?? '')
          .join('')
      },
      stop: (j) => (j as { stop_reason?: string }).stop_reason ?? '',
      reasoningChars: (j) => {
        const c = (j as { content?: { type: string; thinking?: string }[] }).content ?? []
        return c
          .filter((x) => x.type === 'thinking')
          .reduce((n, x) => n + (x.thinking ?? '').length, 0)
      }
    }
  }

  if (protocol === 'gemini') {
    return {
      url: `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
      headers: { 'content-type': 'application/json' },
      body: {
        ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: opts.user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(temp === undefined ? {} : { temperature: temp }),
          ...(opts.json ? { responseMimeType: 'application/json' } : {})
        }
      },
      /**
       * ★★ 2026-09-13 补的那个 `p.thought !== true`：**这是一根还没上的保险，不是在修活着的 bug。**
       *   Gemini 的「思考」段也带 `text`，和正文段长得一模一样，只多一个 `thought: true`。
       *   这段代码从来不发 `thinkingConfig`，默认不回思考段 —— 所以今天漏不出来。
       *   但一旦哪天有人加了 `includeThoughts`，思考就会**直接当释义显示**，
       *   而那是一条极难发现的假话（D-412）。一行门，现在就关上。
       */
      pick: (j) => {
        const c = (
          j as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] }
        ).candidates?.[0]
        return (c?.content?.parts ?? [])
          .filter((p) => p.thought !== true)
          .map((p) => p.text ?? '')
          .join('')
      },
      stop: (j) =>
        (j as { candidates?: { finishReason?: string }[] }).candidates?.[0]?.finishReason ?? '',
      reasoningChars: (j) => {
        const c = (
          j as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] }
        ).candidates?.[0]
        return (c?.content?.parts ?? [])
          .filter((p) => p.thought === true)
          .reduce((n, p) => n + (p.text ?? '').length, 0)
      }
    }
  }

  return {
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: {
      model: cfg.model,
      max_tokens: maxTokens,
      ...(temp === undefined ? {} : { temperature: temp }),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: opts.user }
      ]
    },
    /**
     * ★ **`reasoning_content` 不许收进来当正文。**
     *   它是模型的草稿（「我们需要回答用户。用户选中词组…」），
     *   拿去当释义显示会是一条他几乎不可能发现的假话（D-412）。
     *   它只出现在下面 `reasoningChars` 里，而且只出长度。
     */
    pick: (j) => {
      const c = (j as { choices?: { message?: { content?: string } }[] }).choices?.[0]
      return c?.message?.content ?? ''
    },
    stop: (j) =>
      (j as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason ?? '',
    reasoningChars: (j) => {
      const c = (j as { choices?: { message?: { reasoning_content?: string } }[] }).choices?.[0]
      return (c?.message?.reasoning_content ?? '').length
    }
  }
}

/** 三家的说法不一样，但意思都是「我写到上限了，被切断」 */
const TRUNCATED = new Set(['length', 'max_tokens', 'MAX_TOKENS'])

export async function callAi(cfg: SlotConfig, opts: CallOptions, slot: Slot): Promise<string> {
  if (!cfg.apiKey.trim()) {
    fail(
      'auth',
      '还没有配置 API',
      `「${slot}」这一组还没填 API key。分析、判分、出题都要连 AI 才能跑。`,
      ['settings']
    )
  }

  /**
   * ★ I-2026-08-30 · **空的 baseUrl 必须当场拒绝**（Android 真机事故）。
   *
   * 以前这里不查：baseUrl 是空串时 `shape()` 拼出来的是一条**相对** URL
   * （`/chat/completions`）。在浏览器/WebView 里，相对 URL 会解析到**应用
   * 自己的源**上 —— 手机上正是 Capacitor 的本地服务器。于是：
   *   请求 200 ✅ → 拿回一整页 index.html → JSON.parse 失败 →
   *   失败详情把那页 HTML 原样带上屏。使用者看到的是「AI 返回乱码」。
   *
   * 真相是「地址没填」，但表现是「模型胡说」—— 中间隔着三层，谁也查不动。
   * 少一次判断，换来的是一个查了半天的假故障。模型名同理（空模型名多半
   * 被服务商拒成 400，但话术要说清是我们这边没填）。
   */
  if (!cfg.baseUrl.trim()) {
    fail(
      'auth',
      '还没填服务地址',
      `「${slot}」这一组只有 key，没有 Base URL。填了 key 不等于配好了 —— ` +
        `服务地址、模型名都得有（设置里有服务商快填，点一下三样一起填上）。`,
      ['settings']
    )
  }
  if (!cfg.model.trim()) {
    fail('auth', '还没填模型名', `「${slot}」这一组没填模型名，服务商不知道该用哪个模型。`, [
      'settings'
    ])
  }

  const protocol = cfg.protocol === 'auto' ? detectProtocol(cfg.apiKey, cfg.baseUrl) : cfg.protocol
  const s = shape(cfg, opts, protocol)

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000)
  opts.signal?.addEventListener('abort', () => ac.abort())

  let res: Response
  try {
    res = await fetch(s.url, {
      method: 'POST',
      headers: s.headers,
      body: JSON.stringify(s.body),
      signal: ac.signal
    })
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    if (ac.signal.aborted) {
      fail('server', '超时了', `等了 ${(opts.timeoutMs ?? 120_000) / 1000} 秒还没响应。${msg}`, [
        'retry',
        'settings'
      ])
    }
    fail(
      'offline',
      '连不上网',
      `没能连上 ${new URL(s.url).host}。检查一下网络，或者这个服务商在国内是不是要代理。\n（${msg}）`,
      ['retry', 'settings']
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()

  if (!res.ok) {
    const { kind, title } = classify(res.status, text)
    const actions: Failure['actions'] =
      kind === 'auth' ? ['settings', 'retry'] : kind === 'quota' ? ['settings', 'switchSlot'] : ['retry']
    fail(kind, title, `${new URL(s.url).host} 返回 ${res.status}。\n${text.slice(0, 500)}`, actions)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail(
      'format',
      '服务商返回的不是 JSON',
      `HTTP 200，但内容解析不了。多半是 Base URL 指到了网页而不是 API。\n${text.slice(0, 300)}`,
      ['settings', 'retry']
    )
  }

  /**
   * ★ 这三个数**先无条件算出来**，再看要不要写进 meta ——
   *   下面那句「为什么空」要用它们，而 `opts.meta` 是可选的。
   *   （原来它们藏在 `if (opts.meta)` 里，于是没传 meta 的调用点
   *     连自己为什么失败都说不出来。）
   */
  const reason = s.stop(parsed)
  const truncated = TRUNCATED.has(reason)
  const reasoningChars = s.reasoningChars(parsed)
  if (opts.meta) {
    opts.meta.stopReason = reason
    opts.meta.truncated = truncated
    opts.meta.reasoningChars = reasoningChars
  }

  const out = s.pick(parsed).trim()
  if (!out) {
    /**
     * ★★ 2026-09-13 · 原来这里只有一句话，而那句话在说假话：
     *   「可能是模型名不对，或这个模型不支持当前请求方式。」
     *   使用者当天拿到的响应里模型名没错、请求方式也没错 ——
     *   是 `deepseek-flash` 把额度全写进了 `reasoning_content`。
     *   那句话把他往「改一个本来就对的模型名」上带。
     *
     * ★ 现在按**已经拿到的事实**分岔。三条岔路都不猜，都只说手上有的东西：
     *   思考非空 + 说自己是被长度切断的 → 额度全花在思考上了
     *   思考非空 + 说自己是正常结束的   → 服务商的怪行为，重试有意义
     *   思考是空的 + 被长度切断         → 上限太低，正文还没开始就用完了
     *   两样都没有                       → 这时候「模型名不对」才**真的**是一种可能，
     *                                      所以那句原话**原样留在最后一档**。
     */
    if (reasoningChars > 0 && truncated) {
      fail(
        'format',
        '模型把额度全用在思考上了',
        `这个模型先写思考、再写正文，两者「共用同一个回复上限」。\n` +
          `这一次思考写了 ${reasoningChars} 个字符就到顶了，正文一个字都没轮到。\n` +
          `把回复上限调高，或者换一个不做思考的模型。`,
        ['settings', 'retry']
      )
    }
    if (reasoningChars > 0) {
      fail(
        'format',
        '模型只写了思考，没写正文',
        `它写了 ${reasoningChars} 个字符的思考，然后说自己正常结束了` +
          `（服务商给的理由：${reason || '没说'}）。这是服务商那边的怪行为，重试一次多半就好。`,
        ['retry']
      )
    }
    if (truncated) {
      fail(
        'format',
        '回复在第一个字之前就被切断了',
        `服务商说停下来的原因是「${reason}」—— 回复上限太低，正文还没开始就用完了。`,
        ['settings', 'retry']
      )
    }
    fail(
      'format',
      '模型返回了空内容',
      `请求成功但没有正文。可能是模型名不对，或这个模型不支持当前请求方式。\n${text.slice(0, 300)}`,
      ['settings', 'retry']
    )
  }

  consecutiveFailures = 0
  return out
}

/**
 * 从模型输出里抠出 JSON。
 * 模型很爱在 JSON 外面裹一层 ```json fence 或者加一句话，直接 JSON.parse 会炸。
 */
/**
 * ★ I-108 · 模板占位的绊线。
 *
 * 提示词里的输出示例以前是**一整份填满的真实例子**（全部围绕 `hold sway over` 写的）。
 * 模型不严格遵循指令时会照抄 —— 使用者于是在一条完全无关的词条详情页里
 * 看到 hold sway 的释义、搭配、例句。这类污染最难发现：JSON 合法、字段齐全、
 * 内容也「读着像模像样」，只有人眼看出它讲的不是这个词。
 *
 * 现在示例里的每个值都写成 `⟪…⟫`。它不可能出现在任何真实英文或中文里，
 * 所以只要输出里带着它，就是照抄了模板 —— 当场拒绝，不要落库。
 * 占位符本身变成了绊线。
 */
const TEMPLATE_MARK = /[⟪⟫]/

export function extractJson<T>(raw: string, meta?: { repaired?: boolean; dropped?: number }): T {
  if (TEMPLATE_MARK.test(raw)) {
    throw new AiError({
      kind: 'format',
      title: 'AI 照抄了模板',
      detail:
        'AI 把提示词里的示例模板原样返回了（里面带着 ⟪⟫ 占位记号），不是针对这一条写的。\n' +
        '这一条没有存下来 —— 多数情况下重试一次即可恢复；反复出现说明这个模型不够听话，换「重任务」那一组试试。',
      actions: ['retry', 'settings'],
      consecutive: 0
    })
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  let body = (fenced?.[1] ?? raw).trim()

  // 模型爱在 JSON 前后加一句话 —— 先掐到第一个 { 或 [
  const s = body.indexOf('{')
  const a = body.indexOf('[')
  const start = s === -1 ? a : a === -1 ? s : Math.min(s, a)
  if (start > 0) body = body.slice(start)

  try {
    /**
     * ★ I-115 · 截断的回复要救回前面那部分，而不是整份作废。
     *
     * 原来的做法是 `slice(第一个括号, 最后一个括号)` 再 parse ——
     * 对**截断**的回复没有用：最后那个括号属于某个写了一半的对象，
     * 括号仍然是不配平的，第二次 parse 照样炸，
     * 于是 AI 已经干完的八成活全部丢掉，他看到「这份材料没能分析成功」。
     *
     * 现在切在最后一个闭合的括号处，把残缺的尾巴丢掉、补上收尾括号。
     * 判据和用例都在 `core/json-repair.ts` —— 纯逻辑，能单独验。
     */
    const r = parseLoose<T>(body)
    if (meta) {
      meta.repaired = r.repaired
      meta.dropped = r.dropped
    }
    return r.value
  } catch {
    throw new AiError({
      kind: 'format',
      title: '模型返回的格式不对',
      detail: `期望 JSON，实际拿到：\n${raw.slice(0, 400)}`,
      actions: ['retry', 'settings'],
      consecutive: ++consecutiveFailures
    })
  }
}
