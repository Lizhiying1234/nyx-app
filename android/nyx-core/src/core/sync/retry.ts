/**
 * 传输层重试 · T-2.9（审计 I-133 的尾巴）
 *
 * ── 病是量出来的，不是猜的 ──────────────────────────────────
 *
 * T-9.5（I-133）给失败加了一层 `cause` 链之后量到：**156 条失败的 cause
 * 全是 `code=ECONNRESET syscall=read`，一条不差。** 形状是这样的 ——
 *
 *   服务端（Node 默认 keep-alive 5 s）先关掉空闲连接
 *   → undici 池子里还留着它
 *   → 下一个请求写上去，收到 RST
 *   → `fetch` 抛 `TypeError: fetch failed`，真凶在 `err.cause.code`
 *
 * I-133 修的是**假云那一侧**（`srv.keepAliveTimeout = 0`），并且在结尾留了一句：
 * 「真实的 Supabase / WebDAV 也会关空闲连接，而 `store.ts` 的 fetch 对
 *  ECONNRESET **没有重试**。机器卡顿时真实用户会不会看到同一种失败，要单独一轮定。」
 * 这一轮就是那一轮。
 *
 * ── 只做一件事，别做第二件 ★★ ──────────────────────────────
 *
 * 这里**只**在「连接在半路被拆了」时把同一个调用原样再发一次。
 * 它不认识包、不认识水位、不认识 applied —— 编排层（`run()`）一个字都没动。
 * 传输层聪明起来是同步系统最经典的翻车方式：一层重试、一层重放、
 * 两层都以为对方会兜底，然后同一份数据进去两遍。
 *
 * ── 为什么只重试一次 ────────────────────────────────────────
 *
 * 写死，不给选项。ECONNRESET 这一类的真实分布是「第二次就好」——
 * 第二次还不行，多半不是瞬时问题（服务端真的挂了 / 网真的断了），
 * 那时候**如实失败**比继续等有用：`run()` 的重试资格机制（R-4-A：
 * 没应用干净的包不进 `applied`）本来就会让下一趟自动重来，
 * 而那一趟离现在几秒到几十分钟，比在这里死等强。
 *
 * ── 名单为什么就这三种 ★★ ──────────────────────────────────
 *
 * 判据是**「这条连接被拆了，跟请求本身没关系」**，不是「看着像能重试」。
 *
 *   ECONNRESET      对面把连接 RST 了 —— I-133 实测到的那一种
 *   EPIPE           我们往一个已经关掉的 socket 上写 —— 同一件事的另一面
 *   UND_ERR_SOCKET  undici 自己的说法（`other side closed`）；
 *                   同一个事件在不同 Node 版本上会走这两条路中的一条
 *
 * **有意不收的，每条都有理由**：
 *
 *   ECONNREFUSED  「没人在那个端口上听」—— 地址配错了 / 服务没起来。
 *                 这种状态不会在 300 ms 里自己好，重试只是让一个配置错误
 *                 **晚一倍才说出来**。他要的是那句「检查一下 URL」，不是多等 300 ms。
 *   ETIMEDOUT     「什么都没回来」不等于「连接被拆了」。重试会把他的等待翻倍，
 *                 而超时这种情况一次重试很少救得回来。
 *   ENOTFOUND / EAI_AGAIN  DNS。同上：要么是打错了，要么要等的远不止 300 ms。
 *   任何 HTTP 响应（4xx / 5xx）  `fetch` **成功返回**了，是我们自己按状态码抛的人话错误
 *                 （401 / 403 / 404 / NoSuchBucket / AccessDenied）。那些是配置问题，
 *                 重试一次除了让他多等，什么都不会变。
 *                 ★ 这一条不用额外写代码挡：我们抛的那些 Error 没有带这三个 code 的
 *                   `cause`，白名单天生认不出它们。
 *   AbortError    他自己取消的。同理，白名单认不出 → 不重试。
 */

/** 只有这三种叫「这条连接被拆了」。名单窄是有意的，理由见文件头 */
const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])

/** 两次之间等这么久。几百毫秒够对面把新连接建起来，又不至于让他觉得卡住了 */
export const RETRY_DELAY_MS = 300

/**
 * 顺着 `cause` 链找真凶。
 *
 * `fetch` 抛出来的是一个光秃秃的 `TypeError: fetch failed`，
 * **`code` 在 `err.cause` 上**（undici 有时还会再套一层）。
 * I-133 就是给失败打印加了这一层才把 156 条的真凶看清楚的。
 * 链子设个上限：`cause` 成环的话不设上限就是死循环。
 */
export function transientCode(err: unknown): string | null {
  let cur: unknown = err
  for (let depth = 0; depth < 8 && cur; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

/** 这个异常是不是「连接在半路被拆了」 */
export const isTransient = (err: unknown): boolean => transientCode(err) !== null

export interface RetryOptions {
  /** 两次之间等多久。默认 `RETRY_DELAY_MS`；用例传 0 免得白等 */
  delayMs?: number
  /** 等一会儿的实现。注进来只为让用例不真的睡 */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms)
  })

/**
 * 把 `fn` 跑一次；**只在「连接被拆了」时，原样再跑一次**。
 *
 * ★★ 「原样」是这件事安全的全部理由：`fn` 是一个不带参数的闭包，
 *   第二次跑的是**同一个方法、同一个路径、同一段字节**。
 *   对 `put` 来说这意味着「同名同内容再写一遍」= 覆盖成一模一样的东西
 *   （WebDAV 的 PUT 覆盖；Supabase 带 `x-upsert: true`）——
 *   所以 `put` 也在重试范围里，见 `store.ts` 里 `put` 上面那段。
 *
 * ★ 不返回「重试过没有」：传输层不记账。要不要让他看见「网络在抖」，
 *   那是编排层与产品的事（本轮明确不动 `run()`）。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isTransient(err)) throw err
    const sleep = opts.sleep ?? defaultSleep
    await sleep(opts.delayMs ?? RETRY_DELAY_MS)
    // ★ 第二次不再兜 —— 抛出去的就是他看到的那一个（如实失败）
    return await fn()
  }
}
