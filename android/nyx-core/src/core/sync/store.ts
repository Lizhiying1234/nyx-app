/**
 * 远端存储 · D-201「Supabase 默认 + WebDAV 备选」
 *
 * ★★ 2026-08-29 · 阶段 3（Android 同步接线）：从 main/sync/store.ts 整体搬进 core。
 *   它本来就只用 fetch —— 唯一的平台痕迹是一处 Buffer，已换成纯实现。
 *   Android 与 Windows 从此用同一份传输层；main/sync/store.ts 只剩转发。
 *
 * 两个后端都只被当成**一个能放文件的地方**：放得进、取得出、列得了目录。
 * 这样增量同步的那套逻辑（sync/index.ts）一份就够，不用为两家各写一遍；
 * 将来想加第三家，实现这三个方法即可。
 *
 * 为什么不用 Supabase 的数据库而只用它的存储：用数据库就要在云端建表、
 * 建策略、配行级权限 —— 那是一整套使用者做不来的配置，而他要的只是
 * 「换台机器接着学」。存储桶只要一个 URL 加一个 key。
 */

import { withRetry } from './retry.ts'

export interface RemoteStore {
  /** 列出某个前缀下的文件名（不含路径） */
  list(prefix: string): Promise<string[]>
  get(path: string): Promise<string | null>
  put(path: string, body: string): Promise<void>
  /**
   * 删掉一个对象 · T-2.2（D-435「彻底删除后云端存量也要清」）
   *
   * **对象本来就不在 = 成功**（幂等）。压实要重跑、要能中途断，
   * 「删一个已经删掉的东西」必须是安全的，不然重跑一次就自己红了。
   *
   * 删不掉（没权限 / 服务端拒绝）**必须抛**：静默失败会让压实以为老包清干净了，
   * 而云端其实原封不动 —— 那正是 D-435 要治的那件事的加强版。
   */
  delete(path: string): Promise<void>
  /** 连得上吗。连不上要给一句人话，不是 401 */
  check(): Promise<void>
}

/** 这把凭据能不能删东西。`ok: false` 时 `why` 是给使用者看的一句人话 */
export type DeleteProbe = { ok: true } | { ok: false; why: string }

export interface SyncConfig {
  kind: 'off' | 'webdav' | 'supabase'
  /** WebDAV：目录 URL。Supabase：项目 URL */
  url: string
  /** WebDAV：账号。Supabase：桶名 */
  user: string
  /** WebDAV：应用密码。Supabase：anon key。都只存在本地 */
  secret: string
}

/**
 * UTF-8 → base64，纯实现 · ★ WebView 里没有 Buffer，Node 里懒得引 ——
 * Basic auth 一行的量，手写比引依赖便宜。TextEncoder 两端都是全局的。
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    out += c === undefined ? '=' : B64[c & 63]!
  }
  return out
}

function human(status: number, what: string): string {
  if (status === 401 || status === 403) {
    return `${what}：账号或密码不对（${status}）。WebDAV 要用「应用密码」，不是登录密码。`
  }
  if (status === 404) return `${what}：这个地址不存在（404）。检查一下 URL 有没有打错。`
  if (status >= 500) return `${what}：对方服务器出错（${status}），过一会再试。`
  return `${what}：返回 ${status}。`
}

// ── WebDAV ────────────────────────────────────────────────────────
// 坚果云、Nextcloud、群晖都是这一套。使用者只要填 URL + 账号 + 应用密码。
export class WebDavStore implements RemoteStore {
  private base: string
  private auth: string

  constructor(cfg: SyncConfig) {
    this.base = cfg.url.replace(/\/+$/, '')
    this.auth = 'Basic ' + utf8ToBase64(`${cfg.user}:${cfg.secret}`)
  }

  /**
   * ★★ T-2.9 · 这里是 WebDAV 这一侧**唯一**的 fetch，所以重试只需要包这一处。
   *
   * 包的是「发这一次请求」，不是「处理这一次响应」——
   * 状态码怎么翻译成人话（401 / 404 / 5xx）在各个方法里，那一段不重跑，
   * 也不该重跑：它们是配置问题，重试只会让他多等（判据见 `retry.ts` 头注）。
   *
   * ★ 这里**所有** WebDAV 动词都在重试范围里，包括 `PUT` 与 `MKCOL`：
   *   `withRetry` 重跑的是同一个闭包 —— 同一个方法、同一个路径、同一段字节。
   *   WebDAV 的 PUT 是覆盖语义，MKCOL 撞上已存在回 405（本来就当成功），
   *   所以「再发一次」= 结果一模一样。见 `put()` 上面那段。
   */
  private async req(method: string, path: string, body?: string, headers = {}): Promise<Response> {
    return withRetry(() =>
      fetch(`${this.base}/${path}`.replace(/([^:])\/{2,}/g, '$1/'), {
        method,
        headers: { authorization: this.auth, ...headers },
        body
      })
    )
  }

  async check(): Promise<void> {
    const r = await this.req('PROPFIND', '', undefined, { depth: '0' })
    if (!r.ok && r.status !== 207) throw new Error(human(r.status, '连不上这个 WebDAV 目录'))
  }

  async list(prefix: string): Promise<string[]> {
    await this.mkcol(prefix)
    const r = await this.req('PROPFIND', prefix, undefined, { depth: '1' })
    if (!r.ok && r.status !== 207) throw new Error(human(r.status, '列不出云端的文件'))
    const xml = await r.text()
    return [...xml.matchAll(/<[Dd]?:?href>([^<]+)<\/[Dd]?:?href>/g)]
      .map((m) => decodeURIComponent(m[1] ?? '').replace(/\/$/, '').split('/').pop() ?? '')
      .filter((n) => n.endsWith('.json'))
  }

  async get(path: string): Promise<string | null> {
    const r = await this.req('GET', path)
    if (r.status === 404) return null
    if (!r.ok) throw new Error(human(r.status, `读不到 ${path}`))
    return r.text()
  }

  /**
   * ★★ T-2.9 · **`put` 也重试** —— 这个裁定要写清楚，因为「写操作重试」
   * 通常是危险的，这里不是。
   *
   * 危险的是「重试一个我不知道有没有生效的写」。而这个 `put` 不是那种写：
   *   · 路径是**调用方算好之后传进来的**（`nyx/chunks/<设备>-<startedAt>.json`、
   *     `nyx/audio/<内容哈希>.json`、`nyx/devices/<设备>.json`）——
   *     重试用的是同一个参数，不可能变成第二个名字
   *   · 正文是**已经在手里的那一段字节**，第二次一个 bit 都不差
   *   · 两个后端都是覆盖语义（WebDAV PUT；Supabase 带 `x-upsert: true`）
   * 所以「第一次其实已经落地了、只是回执丢在半路」这种最坏情况下，
   * 重试的结果是**把同一份东西覆盖成同一份东西** —— 桶里的包数不变。
   * （`test:db` 里有一条盯着这句话：注入一次 ECONNRESET，桶里包数与正常一趟相同。）
   *
   * ★ 反过来说，这条理由**依赖「路径是参数」**。哪天有人让 `put` 自己去算路径
   *   （比如在里面取一次 `Date.now()`），这段理由当场失效，重试就会写出第二个文件。
   */
  async put(path: string, body: string): Promise<void> {
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await this.mkcol(dir)
    const r = await this.req('PUT', path, body, { 'content-type': 'application/json' })
    if (!r.ok) throw new Error(human(r.status, `写不进 ${path}`))
  }

  /**
   * ★ T-2.2 · WebDAV 的 DELETE。
   *
   * 204 / 200 / 207 都算删掉了；**404 也算** —— 幂等（见接口上的注释）。
   * 别的一律抛，压实那边靠这个异常停下来、一个老包都不删。
   */
  async delete(path: string): Promise<void> {
    const r = await this.req('DELETE', path)
    if (r.ok || r.status === 404) return
    throw new Error(human(r.status, `删不掉 ${path}`))
  }

  /** 目录不存在就建。已存在返回 405，不算错。 */
  private async mkcol(dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean)
    let at = ''
    for (const p of parts) {
      at = at ? `${at}/${p}` : p
      const r = await this.req('MKCOL', at)
      if (!r.ok && r.status !== 405 && r.status !== 301) {
        throw new Error(human(r.status, `建不了目录 ${at}`))
      }
    }
  }
}

// ── Supabase Storage ──────────────────────────────────────────────

/**
 * 一页要多少个 · R-4-C。
 *
 * 这是**服务端单页上限**，不是我们能随便调大的数字 ——
 * 完整性靠翻页保证，不靠这个数。
 */
const PAGE = 1000

/** 一次失败响应读出来的三样，读一次就够 —— `Response.text()` 只能消费一次 */
interface Diagnosis {
  /** 以正文里的 `statusCode` 为准，正文不是 JSON 才退回 HTTP 状态码 */
  status: number
  /** 正文里的 `code`（没有就退到 `error`） */
  code: string
  raw: string
}

/**
 * ★★ Step 1B · F-06 · **只有这几种意思是「这个对象真的不在」。**
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * `get()` 原来写的是 `if (r.status === 404 || r.status === 400) return null`。
 * 而这个类自己上面那段注释刚讲过：**Supabase 用 400 表示 NoSuchBucket 与
 * AccessDenied**。于是桶没了、权限被撤了，`get()` 一律返回 null ——
 * 上层看到 `!body` 就 `continue`，那一批包变成「空包」，
 * **整批被标进 `applied`，永不重试**。屏幕上写着「收到 0 行」，一切正常。
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * 分开问两件事：**是不是这个对象不在**（可以当没有），
 * 还是**别的什么错**（必须抛，让那一包留着下次重来）。
 * 用白名单不用黑名单：认不出的一律当错误，宁可多抛一次也不要静默吞掉。
 */
const MISSING_OBJECT = new Set(['NoSuchKey', 'NotFound', 'not_found', 'ObjectNotFound'])

export class SupabaseStore implements RemoteStore {
  private base: string
  private bucket: string
  private key: string

  constructor(cfg: SyncConfig) {
    this.base = cfg.url.replace(/\/+$/, '')
    this.bucket = cfg.user.trim() || 'nyx'
    this.key = cfg.secret
  }

  private get headers(): Record<string, string> {
    return { apikey: this.key, authorization: `Bearer ${this.key}` }
  }

  /**
   * ★★ T-2.9 · Supabase 这一侧的**唯一出口**，理由和 `WebDavStore.req` 一样。
   *
   * 五个方法原来各自直接 `fetch`。改成走这一处不是为了好看：
   * 「每个调用点自己记得包一层重试」= 加第六个方法时**一定**有人忘，
   * 而忘掉的症状是「偶尔整趟同步失败」—— 最不像 bug 的那一类。
   * 一个出口，判据只有一份。
   *
   * ★ 包的只是「发出去这一次」。响应怎么诊断（`diagnose` 那套：
   *   Supabase 的 HTTP 状态码不能信）在各个方法里，不重跑。
   */
  private async req(url: string, init?: RequestInit): Promise<Response> {
    return withRetry(() => fetch(url, init))
  }

  /**
   * ★★ Supabase Storage 的 **HTTP 状态码不能信**（2026-08-17 真机同步验收撞出来的）
   *
   * 桶不存在时它回的是 `400`，真正的 404 只写在正文里：
   *
   *     HTTP 400  {"statusCode":"404","error":"Bucket not found","code":"NoSuchBucket"}
   *     HTTP 400  {"statusCode":"403","error":"Unauthorized","code":"AccessDenied"}
   *
   * 于是所有按 `r.status` 分的支**全部落空**：他看到的是光秃秃一句
   * 「连不上桶「nyx」：返回 400」，而唯一能告诉他该做什么的那句
   * 「去后台建一个同名的桶」被 `r.status === 404` 挡在门外，**永远不显示**。
   *
   * 那天的实况：桶真的不存在，同步一跑就 400，四个数一动不动，
   * 他手上除了「返回 400」什么线索都没有 —— 而正文里明明白白写着 NoSuchBucket。
   *
   * 所以状态码以**正文里的 `statusCode` 为准**，正文不是 JSON 才退回 `r.status`。
   * 401/403 也不再借用 `human()` 那句「WebDAV 要用应用密码」—— 那是给 WebDAV 写的，
   * 对着 Supabase 说这句只会把他往错的方向指。
   */
  private async diagnose(r: Response): Promise<Diagnosis> {
    let status = r.status
    let code = ''
    let raw = ''
    try {
      raw = await r.text()
      const body = JSON.parse(raw) as { statusCode?: string; code?: string; error?: string }
      const n = Number(body.statusCode)
      if (Number.isFinite(n) && n >= 100 && n < 600) status = n
      code = String(body.code ?? body.error ?? '')
    } catch {
      /* 正文不是 JSON —— 那就只能按 HTTP 状态码来 */
    }
    return { status, code, raw }
  }

  private async failure(r: Response, what: string): Promise<Error> {
    return this.failureFrom(await this.diagnose(r), what)
  }

  private failureFrom(d: Diagnosis, what: string): Error {
    const { status, code } = d

    if (code === 'NoSuchBucket' || (status === 404 && !MISSING_OBJECT.has(code))) {
      return new Error(
        `${what}：云端没有叫「${this.bucket}」的桶（${status}）。\n` +
          `去 Supabase 后台 Storage 建一个同名的桶，建完还要在 Policies 里给这把 key 放行读写。`
      )
    }
    if (code === 'AccessDenied' || status === 401 || status === 403) {
      return new Error(
        `${what}：桶在，但这把 key 没有读写它的权限（${status}）。\n` +
          `去 Supabase 后台 Storage → Policies，给「${this.bucket}」加一条允许读写的策略。`
      )
    }
    return new Error(human(status, what))
  }

  async check(): Promise<void> {
    const r = await this.req(`${this.base}/storage/v1/bucket/${this.bucket}`, {
      headers: this.headers
    })
    if (!r.ok) throw await this.failure(r, `连不上桶「${this.bucket}」`)
  }

  /**
   * 列目录 —— ★★ R-4-C · **要翻页**。
   *
   * ── 病 ────────────────────────────────────────────────────
   *
   * 以前只发一次请求、`limit: 1000`，超出的**一个字都看不见**。
   * 实测：云端 1500 个包 → 只拿回 1000 个，漏掉 500 个。
   *
   * 而且漏掉的恰好是**最新的那一批**：包名是 `<设备>-<时间戳>.json`，
   * 按名字排序时间戳越大排越后。所以不是「少了些旧数据」，
   * 是**从此再也收不到新数据** —— 那些包压根没进 `todo`，
   * `applied` 里也没有它们，于是不报错、不算失败、体检也不亮。
   * 这是这个项目最贵的那种失败形态。
   *
   * WebDAV 那一侧没有这个问题（PROPFIND 一次返回整个目录，实测 1500/1500）。
   * 而他配的正是 Supabase。
   *
   * ── 药 ────────────────────────────────────────────────────
   *
   * 按 offset 翻页，直到某一页不满为止。**不是把 1000 改大**——
   * 那只是把问题推远，服务端自己也有上限。
   *
   * ★ `sortBy` 必须显式给 —— offset 分页的正确性**完全依赖顺序稳定**。
   * 靠服务端默认顺序是假安全：默认顺序哪天变了，翻页就会漏行或重行，
   * 而且一样不报错。测试里有一个**故意乱序**的假服务盯着这一点。
   *
   * ★ 翻页途中新对象追加进来不会出事：名字只增、新名字排在最后，
   * 已经翻过的页不会位移。
   */
  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    let offset = 0

    for (let page = 0; ; page++) {
      /**
       * 跑飞了才算错 —— 正常翻页（1000 → 1000 → 73）应该完全无感。
       * 这个上限挡的是「服务端每页都满、永远不结束」那种坏掉的情况，
       * 不是给结果数量设的闸。
       */
      if (page > 500) {
        throw new Error(
          `列云端文件时翻了 500 页还没到头（已经 ${out.length} 个）—— 对方的分页可能不正常，停下来了。`
        )
      }

      const r = await this.req(`${this.base}/storage/v1/object/list/${this.bucket}`, {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          prefix: `${prefix}/`,
          limit: PAGE,
          offset,
          // ★ 顺序必须自己定死，见上面
          sortBy: { column: 'name', order: 'asc' }
        })
      })
      if (!r.ok) throw await this.failure(r, '列不出云端的文件')
      const rows = (await r.json()) as { name: string }[]

      for (const x of rows) if (x.name.endsWith('.json')) out.push(x.name)
      if (rows.length < PAGE) return out
      offset += rows.length
    }
  }

  /**
   * ★★ Step 1B · F-06 · **不再把任意 400 当成「没有这个对象」。**
   *
   * 判据见上面 `MISSING_OBJECT`。落到 `throw` 的那条路很要紧：
   * 抛出去 → `run()` 整趟失败 → **那一批包一个都没进 `applied`** → 下次自动重来。
   * 返回 null 则相反：上层当成空包，标进 `applied`，**永不重试**。
   */
  async get(path: string): Promise<string | null> {
    const r = await this.req(`${this.base}/storage/v1/object/${this.bucket}/${path}`, {
      headers: this.headers
    })
    if (r.ok) return r.text()

    const d = await this.diagnose(r)
    // 桶不在、没权限 —— 这两种绝不是「对象不在」，必须抛
    if (d.code === 'NoSuchBucket' || d.code === 'AccessDenied') {
      throw this.failureFrom(d, `读不到 ${path}`)
    }
    // 真的只是这个对象不在
    if (MISSING_OBJECT.has(d.code)) return null
    if (d.status === 404 && d.code === '') return null

    throw this.failureFrom(d, `读不到 ${path}`)
  }

  async put(path: string, body: string): Promise<void> {
    const r = await this.req(`${this.base}/storage/v1/object/${this.bucket}/${path}`, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json', 'x-upsert': 'true' },
      body
    })
    if (!r.ok) throw await this.failure(r, `写不进 ${path}`)
  }

  /**
   * ★ T-2.2 · Supabase Storage 的 DELETE。
   *
   * 判「这个对象本来就不在」用的是**和 `get()` 同一份白名单**（`MISSING_OBJECT`）——
   * 这个后端的 HTTP 状态码不能信（见上面 `diagnose` 那段），
   * 所以这里也一样以正文里的 `code` / `statusCode` 为准，认不出的一律抛。
   */
  async delete(path: string): Promise<void> {
    const r = await this.req(`${this.base}/storage/v1/object/${this.bucket}/${path}`, {
      method: 'DELETE',
      headers: this.headers
    })
    if (r.ok) return

    const d = await this.diagnose(r)
    // 桶不在、没权限 —— 这两种绝不是「对象不在」，必须抛（和 `get()` 同一份判据）
    if (d.code === 'NoSuchBucket' || d.code === 'AccessDenied') {
      throw this.failureFrom(d, `删不掉 ${path}`)
    }
    // 幂等：真的只是这个对象不在
    if (MISSING_OBJECT.has(d.code)) return
    if (d.status === 404 && d.code === '') return

    throw this.failureFrom(d, `删不掉 ${path}`)
  }
}

// ── 删除权限探测 · T-2.2 ──────────────────────────────────────────

/** 探针放这儿：不在 `nyx/chunks` / `nyx/devices` / `nyx/audio` 里，谁列目录都看不见它 */
const PROBE_PREFIX = 'nyx/probe'

/** 探针名只要不撞就行 —— 同一毫秒连着探两次也不撞 */
let probeSeq = 0

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * ★★ T-2.2 · 这把凭据到底能不能删东西 —— **真删一次才算数**。
 *
 * ── 为什么不放进 `check()` ────────────────────────────────
 *
 * `check()` 是设置页那个「测试连接」按钮走的路，**只读**。
 * 把「写一个再删掉」塞进去，等于让一次连通性测试变成一次写操作 ——
 * 他点「测试连接」的时候并没有同意让谁往他桶里放东西。
 * 所以单独一个函数，**只有压实与 `wipeRemote` 会叫它**。
 *
 * ── 为什么不去问服务端「我有没有 delete 权限」────────────
 *
 * 问不出来。WebDAV 没有这种接口；Supabase 的策略（Policies）是行级的，
 * 只有真发一次请求才知道结论。**能力探测只能靠做一次**。
 *
 * ── 三步，缺一不可 ────────────────────────────────────────
 *
 *   ① put   —— 连写都写不进去，那就更别谈删
 *   ② delete —— 这一步才是要问的问题
 *   ③ get 回头看一眼 —— ★ 有的服务端 DELETE 回 200 却什么都没删。
 *      少了这一步，压实会以为老包清掉了而其实原封不动。
 *
 * ★ 卡在 ② 时探针文件会留在云端。**如实告诉他文件名**，不假装干净；
 *   那个位置谁也列不到，留着是垃圾不是危险。
 */
export async function probeDeletePermission(store: RemoteStore): Promise<DeleteProbe> {
  const path = `${PROBE_PREFIX}/delete-probe-${Date.now()}-${probeSeq++}.json`

  try {
    await store.put(path, JSON.stringify({ probe: 'delete', at: Date.now() }))
  } catch (e) {
    return { ok: false, why: `这把凭据连写都写不进云端：${errText(e)}` }
  }

  try {
    await store.delete(path)
  } catch (e) {
    return {
      ok: false,
      why:
        `这把凭据能写、不能删：${errText(e)}\n` +
        `（测试文件 ${path} 留在云端了，可以手动删掉，它不影响同步。）`
    }
  }

  let after: string | null
  try {
    after = await store.get(path)
  } catch (e) {
    return { ok: false, why: `删除后无法再读回确认，不能当作已删除：${errText(e)}` }
  }
  if (after !== null) {
    return {
      ok: false,
      why:
        `删除请求返回成功，但那个对象「还在」云端 —— 这个服务端的删除不作数。\n` +
        `（测试文件 ${path} 留在云端了。）`
    }
  }

  return { ok: true }
}

export function makeStore(cfg: SyncConfig): RemoteStore {
  if (cfg.kind === 'webdav') return new WebDavStore(cfg)
  if (cfg.kind === 'supabase') return new SupabaseStore(cfg)
  throw new Error('还没配同步。设置 →「同步」里选一种。')
}
