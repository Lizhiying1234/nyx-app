/**
 * 颜色模式 · 两端共用的判据（使用者 2026-09-13「Settings → Resources → Colors」）
 *
 * ══ 他要的 ═════════════════════════════════════════════════════
 * 一个**模式**就是一整套配色。可以新建 · 命名 · 改名 · 改里面每一项 · 应用。
 * 再加一个全局的 **Reset to Default**，一键回到出厂那套。
 * ★ 「颜色不能只设一个总颜色」—— 要能拆到**具体的 UI 部件**逐项调。
 * ★ **两端不互相同步**，各管各的，配色也不需要一样。
 *
 * ══ 存哪儿，为什么不用改同步契约 ══════════════════════════════
 * 存 `settings` 表 —— 它**不在 `SYNC_TABLES` 里**（`core/sync-tables.ts`）。
 * 「资源本体可以共享、选了哪一套是各端自己的事」这条分界库里现成就有，
 * 启动页（D-480）走的也是它。所以这一整个功能**没动一个字的同步契约**。
 *
 * ══ 这份文件只管判据，不碰 DOM ════════════════════════════════
 * 「怎么把它涂到屏上」是各端的事（Windows 写 `:root` 的行内样式，
 * Android 那边同理）。这里只回答四件事：
 *   ① 一个颜色值**能不能信**（它要被写进 CSS —— 见下面那段）
 *   ② 一个模式的形状对不对
 *   ③ 存进 `settings` 的那串字怎么来回
 *   ④ 增删改应用这几个动作各自意味着什么
 */

/** 一个模式里，token 名 → 颜色值 */
export type ColorTokens = Readonly<Record<string, string>>

export interface ColorMode {
  /** 短随机 id。**不拿名字当 id** —— 他会改名，改名不该让「正在用的是哪套」失效 */
  readonly id: string
  readonly name: string
  /** 只存**他改过的**那些。没改的留空 = 跟着出厂那套走 */
  readonly tokens: ColorTokens
  readonly updatedAt: number
}

/** 模式数量上限。不是技术限制，是「这一页还能读」的限制 */
export const MAX_MODES = 24
/** 模式名长度上限 */
export const MAX_NAME = 40
/** 一个模式里最多能覆盖多少个 token（出厂语义层 74 + 组件层 22，留足余量） */
export const MAX_TOKENS = 200

/**
 * ★★★ **颜色值必须过这道闸才能进 CSS。**
 *
 * 这些值最后会走 `style.setProperty('--color-bg', v)` 落进页面。
 * 不验的话有两个后果，第二个更难查：
 *   ① CSS 里能塞的东西不只是颜色 —— `url(...)` 会发网络请求，
 *      而这一屏的整个前提是「颜色是本地的事」。
 *   ② 写错一个字（少个 `#`、多个空格）浏览器**静默丢弃**这条声明，
 *      屏上那一块保持原样 —— 他会以为「这个颜色改不动」，
 *      而真相是「它根本没被接受」。**闸挡下来才说得出这句话。**
 *
 * 只认三种写法（和 `color-tokens.css` 里现有的写法是同一套）：
 *   `#rgb` · `#rgba` · `#rrggbb` · `#rrggbbaa` · `rgb(…)` · `rgba(…)`
 * ★ 有意不认的：颜色关键字（`red`）· `hsl()` · `color-mix()` · `var()`。
 *   不是它们不好，是**这一版的取色器只产出上面那三种**，
 *   多认一种就多一种「存得进去、却没有任何界面能把它改回来」的值。
 */
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const RGB = /^rgba?\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*(?:,\s*(?:0|1|0?\.[0-9]{1,3})\s*)?\)$/

export function isColorValue(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length === 0 || s.length > 32) return false
  return HEX.test(s) || RGB.test(s)
}

/**
 * token 名也要验 —— 它同样进 CSS。
 * 只认 `--` 开头、只含小写字母 / 数字 / 连字符的名字（`color-tokens.css` 里全是这个形状）。
 */
const TOKEN_NAME = /^--[a-z0-9]+(?:-[a-z0-9]+)*$/
export function isTokenName(n: unknown): n is string {
  return typeof n === 'string' && n.length <= 64 && TOKEN_NAME.test(n)
}

/** 名字：去掉首尾空白、压掉换行；空的不算名字 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

/**
 * 新 id。**不用时间戳** —— 同一毫秒建两个会撞；
 * 也不用名字派生 —— 他会改名。
 */
export function newModeId(rand: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 8; i++) s += Math.floor(rand() * 36).toString(36)
  return 'm' + s
}

/**
 * 把任意一坨东西收成一个能用的模式。**认不出来的整条丢掉，绝不抛。**
 * （从 `settings` 里读出来的字符串是上一版写的，版本一换形状就可能变。）
 */
export function toMode(raw: unknown): ColorMode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && /^m[0-9a-z]{4,16}$/.test(o.id) ? o.id : null
  if (!id) return null
  const name = cleanName(o.name)
  if (!name) return null
  const src = typeof o.tokens === 'object' && o.tokens !== null ? (o.tokens as Record<string, unknown>) : {}
  const tokens: Record<string, string> = {}
  let n = 0
  for (const k of Object.keys(src)) {
    if (n >= MAX_TOKENS) break
    // ★ 逐项丢，不是整条丢：一个坏值不该让他整套配色消失
    if (!isTokenName(k)) continue
    const v = src[k]
    if (!isColorValue(v)) continue
    tokens[k] = (v as string).trim()
    n++
  }
  const updatedAt = typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0
  return { id, name, tokens, updatedAt }
}

/** 存进 `settings` 的那串字。 */
export function encodeModes(modes: readonly ColorMode[]): string {
  return JSON.stringify(modes.slice(0, MAX_MODES))
}

/** 读回来。**绝不抛** —— 配色读不出来最多是「回到出厂那套」，不该把设置页带崩。 */
export function decodeModes(raw: unknown): ColorMode[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ColorMode[] = []
  const ids = new Set<string>()
  for (const x of parsed) {
    if (out.length >= MAX_MODES) break
    const m = toMode(x)
    if (!m || ids.has(m.id)) continue
    ids.add(m.id)
    out.push(m)
  }
  return out
}

/**
 * 当前该涂哪一套。
 *
 * ★ **`活动 id` 认不出来 = 出厂那套**，不是报错。
 *   他删掉了正在用的那个模式、或者换了台机器 —— 屏上该回到出厂的样子，
 *   而不是卡在一个不存在的模式上。
 * ★ 「Reset to Default」在这一层就是**把活动 id 清掉**：
 *   出厂那套的真相**只有一份**，就是 `color-tokens.css` 本身。
 *   不往库里存一份 hex 快照 —— 存了它就会和样式表各说各话，
 *   而这个项目为「同一件事两份判据」付过最多学费。
 */
export function activeTokens(modes: readonly ColorMode[], activeId: unknown): ColorTokens {
  if (typeof activeId !== 'string' || activeId === '') return {}
  const m = modes.find((x) => x.id === activeId)
  return m ? m.tokens : {}
}

/** 加一套。名字重了不拦（他自己的事），但满了要说。 */
export function addMode(
  modes: readonly ColorMode[],
  name: string,
  tokens: ColorTokens,
  now: number,
  rand?: () => number
): { ok: true; modes: ColorMode[]; id: string } | { ok: false; why: string } {
  if (modes.length >= MAX_MODES) {
    return { ok: false, why: `最多 ${MAX_MODES} 套配色。先删掉一套再加。` }
  }
  const n = cleanName(name)
  if (!n) return { ok: false, why: '给这套配色起个名字。' }
  const m = toMode({ id: newModeId(rand), name: n, tokens, updatedAt: now })
  if (!m) return { ok: false, why: '这套配色存不下来（名字或颜色值不对）。' }
  return { ok: true, modes: [...modes, m], id: m.id }
}

/** 改名 / 改颜色。找不到那一套 → 原样返回（**不抛**，界面自己会发现它没了）。 */
export function editMode(
  modes: readonly ColorMode[],
  id: string,
  patch: { name?: string; tokens?: ColorTokens },
  now: number
): ColorMode[] {
  return modes.map((m) => {
    if (m.id !== id) return m
    const next = toMode({
      id: m.id,
      name: patch.name === undefined ? m.name : cleanName(patch.name) || m.name,
      tokens: patch.tokens === undefined ? m.tokens : patch.tokens,
      updatedAt: now
    })
    return next ?? m
  })
}

/** 删一套。 */
export function removeMode(modes: readonly ColorMode[], id: string): ColorMode[] {
  return modes.filter((m) => m.id !== id)
}
