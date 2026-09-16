/**
 * 启动页图片的**名字** · 两端共用的判据（使用者 2026-09-13）
 *
 * 他的原话（在 Android 那边说的，本端已当面确认）：
 * > Windows 和 Android 两端的启动页图片名称也需要同步。同一张图片在两端都存在，
 * > 名称保持一致。任意一端修改了名称，同步到另一端。如果两端在不同时间分别改了
 * > 同一张图片的名称：**以最后一次修改的名称为准**。
 *
 * ══ 这推翻了 D-480 的一半，只推翻那一半 ═══════════════════════
 * D-480 定的是「资源共享 · **选了哪张**各端自己管」。名字**不是**「本机选了哪张」
 * 那一类，它是**资源本身的属性** —— 同一张图在两端理应同名。所以名字跟着资源走。
 * ★ 「**选了哪张不同步**」那一条**没有被推翻**，别一起改掉。
 *
 * ══ 为什么这份判据只能有一处 ═══════════════════════════════
 * 「谁赢」这种判断两端各写一份，必然在某个边角上不一致，
 * 而不一致的表现是**两端来回覆盖对方的名字**——最难查的那种抖动。
 * 所以放 core，两端都调这一个函数。
 */

/**
 * 一张图的名字，和它是什么时候被改成这样的。
 * 2026-09-14 起它还兼任**墓碑**（见下面 `gone`）。
 */
export interface SplashLabel {
  readonly label: string
  /** 改成这个名字 / 删掉它 / 把它加回来的那一刻（毫秒）*/
  readonly at: number
  /**
   * ══ 墓碑（使用者 2026-09-14 裁「选 a：连桶一起删」）★★★ ═══════════
   *
   * ── 为什么非要有它 ─────────────────────────────────────────
   * 在这之前「从资源库删除」只删本机文件、不动桶，于是**只删一端，
   * 下一趟同步就从桶里拉回来**。2026-09-13 真出过一次：一张 502 字节的测试图
   * 要在手机 / 桶 / 电脑三处各删一次才干净，中间还不能让任何一端同步 ——
   * 而那个窗口关不住（Windows 开机 4 秒自动同一趟、之后每 30 分钟一趟）。
   * 最后是使用者亲手去 Supabase 控制台删的。
   *
   * ── 为什么是**这里的一个字段**，不是桶里另开一种对象 ──────────
   * `<name>.meta.json` 本来就存在、本来就每张一份、本来就被
   * `isMetaEntry` 从图片清单里排掉了（那个坑 09-13 已经踩过一次：
   * 不排掉就会被当成「名字不合规的图片」，每同步一次往体检里塞一条假问题）。
   * 另开一种对象等于把那个坑再挖一遍，而且要再写一套排除逻辑。
   *
   * ── ★★ 三态，不是布尔 ─────────────────────────────────────
   *   `true`   这张被删了（墓碑）
   *   `false`  他**又把它加回来了**（复活，靠 `at` 压过旧墓碑）
   *   **缺失** 没表态 —— 老数据、从没删过。**「取不到」不等于 `false`。**
   * 这一条要紧：把缺失当 `false` 的话，任何一条老 meta 都会变成一次
   * 「主动声明它活着」，于是**它能压过另一端刚写的墓碑**，删了又回来。
   */
  readonly gone?: boolean
}

/**
 * 桶里那份 `<name>.meta.json` —— 比本地那份多一栏：**是哪台设备写上去的**。
 *
 * ══ ★★★ I-178 · 为什么非有这一栏不可（2026-09-15）═══════════
 * 时钟警告的判据是 `at` 和 `maxRemoteSeen` 比大小，而 `maxRemoteSeen`
 * **只被别的设备推的包抬**（`sync/engine.ts` 那个拉包循环）。
 * 可 `store.list('nyx/splash')` 列出来的 meta 里**有本机自己刚推上去的那几份** ——
 * 于是「本机刚改了名字 ＋ 对端半天没同步」= 本机拿自己的 `at` 去和一个
 * 不含自己的水位比，必然超前，必然报「另一端的时钟可能不准」。
 * 使用者 2026-09-14 看到的那句「10 小时以上」，骂的是他自己这台机器。
 *
 * ★ 所以判据要的不是更大的容差，是**一个能认出「这是我写的」的字段**。
 * ★ 缺失是第三态（和 `gone` 同一条规矩）：老 meta 没有这一栏，
 *   那就**既不算本机也不算别机 —— 不报**。没证据别骂人。
 */
export interface SplashMeta extends SplashLabel {
  /** 把这份 meta 写进桶的那台设备的编号（`settings['sync.device']`）。缺失 = 老数据 */
  readonly device?: string
}

/** 这张图现在算被删了吗。**缺失 = 没表态 = 没删**（见 `gone` 那段） */
export const isGone = (v: SplashLabel | null | undefined): boolean => v?.gone === true

/** 名字最长多少个字。不是技术限制，是「那张卡上放得下」的限制 */
export const MAX_LABEL = 40

/** 一张图最多存几个名字？一个。这里限的是**整张表**能装多少张图的名字 */
export const MAX_LABELS = 500

/** 去掉首尾空白、压掉换行、截断。空的不算名字 */
export function cleanLabel(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
}

/**
 * ★★★ **谁赢** —— 这个项目里「最后一次修改为准」的唯一一处判据。
 *
 * @returns 该留下的那一个。两个都没有时给 `null`。
 *
 * ★ `at` 相等时**先看死活，再看名字**：
 *
 *   ① **活的赢**（`gone` 不是 `true` 的那个）。理由不是它更对，是
 *      **平局时别丢东西**：判错一次的后果不对称 —— 误留一张图他自己再删一次就行，
 *      误删一张图（桶里那份也删了）他要从头找回来。
 *      这一条是和 Nyx-UI-Android 议定的七条之一。
 *   ② 死活相同再取 **label 字典序大的那个**。
 *      理由**不是它更对，是它稳定**：两端各自算都会得到同一个结果，不会来回翻。
 *      「同一毫秒改两次的概率极低」—— 在同步里，**极低等于迟早**。
 *      （这一条是 Nyx-UI-Android 提的，理由原样采纳。）
 */
export function pickLabel(a: SplashLabel | null, b: SplashLabel | null): SplashLabel | null {
  if (!a) return b ?? null
  if (!b) return a
  if (a.at !== b.at) return a.at > b.at ? a : b
  if (isGone(a) !== isGone(b)) return isGone(a) ? b : a
  return a.label >= b.label ? a : b
}

/**
 * ★★ 时钟偏移：「最后一次为准」需要一个**可信的钟**，而两端的钟会偏。
 *
 * 某一端的钟快一天，它改的名字就会**永久赢** —— 对面怎么改都翻不过来，
 * 而且屏上什么都不会报。这正是这个仓最怕的那类账：**错了不报，只是安静地一直错**。
 *
 * 所以：一个名字的 `at` **明显超前于已经见过的最大远端时间戳**时，
 * 记一条体检问题，让他看得见。**不钳制、不改值** ——
 * 钳了的话他的改名会莫名其妙失效，而那比钟偏更难解释。
 *
 * @param at 这个名字声称的修改时刻
 * @param maxRemoteSeen 见过的最大远端时间戳（F-015 那一套已经在算）
 * @returns 超前了多少毫秒；没超前给 0
 */
export const SKEW_TOLERANCE = 6 * 60 * 60 * 1000 // 六小时：够容下时区 / 夏令时 / 一般漂移

export function labelSkew(at: number, maxRemoteSeen: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(maxRemoteSeen) || maxRemoteSeen <= 0) return 0
  const ahead = at - maxRemoteSeen
  return ahead > SKEW_TOLERANCE ? ahead : 0
}


/**
 * ★★★ I-178 · **这份 meta 值不值得为它报一句「那一端的钟不准」。**
 *
 * `labelSkew` 只会算差；差算得对，但**算给谁听**是另一件事。
 * 三态，缺一不可：
 *
 *   本机写的（`device === me`）→ **0**。自己不骂自己 —— 这就是 I-178 那条 bug。
 *   没写设备号（老 meta）      → **0**。它可能是本机上一版写的，没证据别骂人。
 *   别的设备写的              → 照 `labelSkew` 算。
 *
 * ★ `me` 是空串时也给 0：那说明本机连自己的编号都取不到（库还没 ready），
 *   这时候任何 meta 都**无法排除**是自己写的。
 * ★ 代价写在明处：老 meta 从此永远不报，哪怕它真是对端用坏钟写的。
 *   要让它重新说话，只需要任意一端再改一次名 —— 那一次就带上设备号了。
 */
export function remoteMetaSkew(
  meta: SplashMeta | null | undefined,
  me: string,
  maxRemoteSeen: number
): number {
  if (!meta) return 0
  const who = typeof meta.device === 'string' ? meta.device : ''
  if (who === '') return 0
  if (typeof me !== 'string' || me === '') return 0
  if (who === me) return 0
  return labelSkew(meta.at, maxRemoteSeen)
}

/** 一张图的名字 → 存进 `settings` 的那串字 */
export function encodeLabels(map: Readonly<Record<string, SplashLabel>>): string {
  const out: Record<string, SplashLabel> = {}
  let n = 0
  for (const k of Object.keys(map)) {
    if (n >= MAX_LABELS) break
    const v = map[k]
    if (!v) continue
    const label = cleanLabel(v.label)
    /**
     * ★★ 墓碑**没有名字也要留下**（2026-09-14）。
     *   原来这里是「没名字就丢掉」—— 那条规则对「名字」成立，对墓碑是致命的：
     *   一张从没起过名的图被删掉之后，墓碑会在写回的这一步被扔掉，
     *   下一趟同步它就从桶里回来了，而屏上什么都不会说。
     */
    if (!label && v.gone !== true) continue
    out[k] = withGone({ label, at: Number.isFinite(v.at) ? v.at : 0 }, v.gone)
    n++
  }
  return JSON.stringify(out)
}

/** 读回来。**绝不抛** —— 名字读不出来最多是显示成默认那句，不该把设置页带崩。 */
export function decodeLabels(raw: unknown): Record<string, SplashLabel> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, SplashLabel> = {}
  let n = 0
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (n >= MAX_LABELS) break
    if (typeof k !== 'string' || k.length === 0 || k.length > 128) continue
    if (typeof v !== 'object' || v === null) continue
    const o = v as Record<string, unknown>
    const label = cleanLabel(o.label)
    const gone = readGone(o.gone)
    if (!label && gone !== true) continue
    const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
    out[k] = withGone({ label, at }, gone)
    n++
  }
  return out
}

/**
 * ★★ **没人起过名的那张图，屏上显示什么。**
 *
 * ══ 为什么这一条必须在 core、而且两端必须一模一样 ═══════════
 * 它是**算出来的**，不是存下来的 —— 存下来会出大事：
 * 两端各自导入 / 各自收到同一张图时都会写一次默认名（各带一个 `at`），
 * 于是**凭空产生两条互相覆盖的改名记录**：他一个字都没改，
 * 名字却在两端之间来回翻，而且屏上什么都不报。
 * （这个坑是 Nyx-UI-Android 提的，它那边已经按「不存默认名」做了。）
 *
 * ══ 用内容哈希的前六位，白拿一样东西 ═════════════════════════
 * 资源名本来就是 `<sha256>.<ext>`，所以**同一张图在两端算出来的默认名天生相同** ——
 * 他要的「同一张图两端名称一致」，在「还没改过名」这个绝大多数情形下**自动成立**，
 * 一个字节都不用同步。
 * ★ 但这也意味着：**两端的算法必须逐字一样**，否则默认名不一致，
 *   看起来就像同步坏了。所以它在 core，不在任何一端的界面里。
 */
export function defaultLabel(name: string): string {
  const id = typeof name === 'string' ? name.slice(0, 6) : ''
  return id ? `图 ${id}` : '图'
}

/**
 * `gone` 读出来是什么。**只认真正的布尔**，别的一律当「没表态」。
 * ★ 不写成 `!!o.gone`：那会把 `"false"` / `0` / `null` 全折成一个值，
 *   而这一栏的三态里「没表态」和 `false` 是两件事（见 `SplashLabel.gone`）。
 */
function readGone(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** 只有真的表了态才把这一栏写出去 —— 缺失是有意义的第三态，不许补默认值 */
function withGone(base: { label: string; at: number }, gone: unknown): SplashLabel {
  const g = readGone(gone)
  return g === undefined ? base : { ...base, gone: g }
}

/**
 * 桶里那个 `<name>.meta.json` 的正文。
 *
 * ★★ I-178 · `device` **在推的这一刻盖**，不跟着本地那份名字走：
 *   这一栏要回答的是「桶里这份是谁放上去的」，而放上去的那台机器就是本机。
 *   跟着本地走的话，从对端拉回来的名字会带着**对端的**编号被重新推上去，
 *   那就成了「我替你签了个名」。
 * ★ 空编号不写 —— 写一个空串等于凭空造出第四态，判据那边还要再认一次。
 */
export function encodeMeta(v: SplashLabel, device?: string): string {
  const body: Record<string, unknown> = {
    label: cleanLabel(v.label),
    at: Number.isFinite(v.at) ? v.at : 0
  }
  /** ★ 没表态就不写这一栏 —— 写了就成了「声明它活着」，会压过别人的墓碑 */
  if (typeof v.gone === 'boolean') body.gone = v.gone
  if (typeof device === 'string' && device !== '') body.device = device
  return JSON.stringify(body)
}

/**
 * 读桶里那一份。认不出来给 `null`，**绝不抛**。
 * ★ **有墓碑就算数，哪怕没有名字** —— 见 `encodeLabels` 里那段：
 *   「没名字就丢掉」这条规则对名字成立，对墓碑是致命的。
 */
export function decodeMeta(raw: unknown): SplashMeta | null {
  if (typeof raw !== 'string') return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const label = cleanLabel(o?.label)
    const gone = readGone(o?.gone)
    if (!label && gone !== true) return null
    const base = withGone(
      { label, at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0 },
      gone
    )
    /** ★ 和 `gone` 同一条规矩：不是非空字符串就当「没这一栏」，不补默认值 */
    const device = typeof o.device === 'string' && o.device !== '' ? o.device : undefined
    return device === undefined ? base : { ...base, device }
  } catch {
    return null
  }
}

/**
 * 立一块墓碑：名字留着，`gone` 置 true，时间推到 `at`。
 *
 * ★ **名字留着**（和 Nyx-UI-Android 议定的七条之一）：他哪天把同一张图加回来，
 *   名字还在，不用重起一次。资源名是内容 sha256，所以「同一张图」认得出来。
 * ★ 时间必须推 —— 墓碑靠 `at` 压过对面那份「它还活着」的 meta。
 */
export function tombstone(prev: SplashLabel | null | undefined, at: number): SplashLabel {
  return { label: cleanLabel(prev?.label) , at, gone: true }
}

/**
 * 把它加回来：`gone` 置 **false**（不是删掉这一栏）。
 *
 * ★ 为什么是显式 `false` 而不是「去掉 gone」：去掉的话它变成「没表态」，
 *   而没表态压不过对面那块墓碑 —— 他加回来的图会在下一趟同步里又被删掉。
 *   显式 `false` ＋ 更新的 `at` 才是一次**真正的复活声明**。
 */
export function revive(prev: SplashLabel | null | undefined, at: number): SplashLabel {
  return { label: cleanLabel(prev?.label), at, gone: false }
}

/**
 * 桶里那个键长什么样，以及**怎么把它和图片本身区分开**。
 *
 * ★★ 这一条必须有：`store.list('nyx/splash')` 会把 `<name>.meta.json` 一起列出来。
 *   不排掉的话，同步那一侧会把 `<sha>.meta` 当成一个**名字不合规的图片**，
 *   于是每同步一次就往体检里塞一条假问题 —— 而假问题会让真问题没人看。
 */
export const META_SUFFIX = '.meta.json'

export function metaKey(name: string): string {
  return `nyx/splash/${name}${META_SUFFIX}`
}

/** 这个列表项是 meta，不是图 */
export function isMetaEntry(entry: string): boolean {
  return entry.endsWith(META_SUFFIX)
}

/** 从 meta 的列表项里取回图片名 */
export function nameOfMeta(entry: string): string {
  return entry.slice(0, -META_SUFFIX.length)
}
