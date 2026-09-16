/**
 * Glance · 「选中就查」的判据（使用者 2026-09-13）
 *
 * 他要的：把 Android 的 Assist 核心能力移到 Windows。
 * 2026-09-14 晚定型成两条，**都不用框、都不认图**：
 *   **划词（Glance）** —— 正常选中文字后**直接自动查词**，不用任何按键。
 *   **指到就查（Point）** —— 一颗快捷键，问系统「指针下面是哪个词」。
 * ★ 原来那一档 **Frame（框选 + OCR）取消了**（他：「我不太喜欢框选这个东西」）。
 * 这份文件管两条路各自**最要紧的那个判断：这一次，要不要动。**
 *
 * ══ 为什么这个判断必须单独成一份、还要有用例 ═══════════════════
 * 零按键意味着**他在任何地方选中的任何东西都会经过这里**。
 * 判错一次的后果不是「查词没出来」，是**一段他没打算给 Nyx 的文字被读走了**
 * —— 聊天窗、银行页面、私信。
 * `ASSIST_CONTRACT` 的原则原话是「**Nyx 只看用户明确交给它的东西**」；
 * 零按键把「明确交给」这件事变模糊了，所以补偿必须落在**判据**上，
 * 而不是落在「我会小心」上。
 *
 * ══ 五道闸，顺序有意义（越便宜、越确定的排前面）═══════════════
 *   ① 总开关没开 → 不动。**默认就是没开。**
 *   ② 来源是密码框 → 不动（这一条在助手进程里就拦掉了，这里是第二道）
 *   ③ 来源程序在黑名单里 → 不动
 *   ④ 长度不对（太短没意义 · 太长不是查词是复制）→ 不动
 *   ⑤ 和上一次一模一样 → 不动（他只是挪了下鼠标，不是又查了一次）
 */

/**
 * ══ 一天之内这个类型改了三次，三次都写在这儿（2026-09-14）★★★ ═══════
 *
 *   早上  `'glance' | 'frame' | 'off'`   —— 划词 / 框选
 *   下午  `'glance' | 'off'`             —— 他：「留 point 和 glance，原来的 frame 取消」
 *         那时 Point 是**一颗快捷键**，不是一种模式，所以「哪一种」这个维度没了
 *   晚上  `'glance' | 'point' | 'off'`   —— 他：「Point 和 Glance 是两种独立的功能，
 *         **不能同时混在一起**……开 Point 时 Assist 当前只运行 Point，不运行 Glance」
 *
 * ★ 所以「模式」这个维度**回来了**，而且这一次它是真的互斥：
 *   开 Glance 就不注册 Point 那颗键；开 Point 就不起 Glance 那个助手进程。
 *   ☞ 谁看到这段觉得「怎么又加回来了」：不是回潮，是 Point 从一颗键升成了一档。
 *
 * ★★ `'frame'` 那一档**没了**（下午删的）。
 *
 * 当初为什么有它（D-457 要求说清）：2026-09-13 量到 ONLYOFFICE 那类自绘界面
 * 「整条链上一个文本接口都没有」，那种地方只能靠看 —— 所以做了框选 + OCR。
 * 当初为什么撤：09-14 他试过之后说「我不太喜欢框选这个东西」，
 * 而同一天量到 UI Automation 的 `RangeFromPoint` 能**直接说出指针下面是哪个词**
 * （Edge 里连着六个点六个正确词，见 `judgePoint` 那一段），
 * 也就是 Android Assist 走的那条路。他裁：留 Point 与 Glance，Frame 取消。
 * ★ 代价他听过并确认过：自绘界面 / 图里的字 / 视频字幕从此查不了。
 */
export type GlanceMode = 'glance' | 'point' | 'off'

/**
 * ══ 那段字在屏幕上的位置（使用者 2026-09-14 晚）★★ ═══════════════
 *
 * 他的原话：「弹窗应该正好出现在当前选中文字的下方。弹窗位置要根据选中文字的
 * 位置进行定位，而不是固定出现在其他位置。」
 *
 * 在这之前卡摆在**鼠标坐标**上 —— 他刚拖完选区时那两个位置很近，
 * 但他用键盘选、或者选完把鼠标挪开之后，卡就跑到别处去了。
 * UIA 给得出真的那一个：`TextPatternRange.GetBoundingRectangles()`。
 *
 * ★ 折行的选区有好几个矩形，助手吐的是**并集** ——「在选中文字下方」
 *   指的是在**整段**下面，不是在第一行下面。
 * ★ 屏幕物理坐标（不是窗口坐标）。取不到就没有这一栏，调用方退回鼠标位置。
 */
export interface ScreenRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 助手进程报上来的一次选中 */
export interface GlanceHit {
  /** 选中的那串字 */
  readonly text: string
  /** 哪个程序（进程名，小写，不带 .exe）*/
  readonly proc: string
  /** 来源是不是密码框 —— 助手进程问 UI Automation 的 `IsPassword` */
  readonly password?: boolean
  /** 那段字在屏幕上的矩形。取不到就没有这一栏（见 `ScreenRect`）*/
  readonly rect?: ScreenRect
}

/**
 * 助手吐的 `rect` 那一栏 → `ScreenRect`。**认不出来给 `undefined`，绝不抛**。
 * ★ 宽高必须为正：`0×0` 的矩形摆不出「在它下方」，那种时候退回鼠标位置更对。
 */
export function parseRect(v: unknown): ScreenRect | undefined {
  if (!Array.isArray(v) || v.length < 4) return undefined
  const [x, y, w, h] = v.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : NaN))
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return undefined
  if ((w as number) <= 0 || (h as number) <= 0) return undefined
  return { x: x as number, y: y as number, w: w as number, h: h as number }
}

export interface GlanceRules {
  readonly mode: GlanceMode
  /** 这些程序里不抓。小写进程名 */
  readonly blocked: readonly string[]
}

/**
 * 出厂就拦住的那几个。
 *
 * ★ 为什么是**黑名单**不是白名单：白名单更安全，但他得先把每一个
 *   要用的程序加进来才能用上 —— 那等于这个功能不存在。
 *   黑名单 ＋ 密码框那一闸 ＋ **默认关** ＋ 屏上一直有「正在监听」，
 *   四样合起来才是这个取舍的代价。
 * ★ 名单里只放**存在理由极其明确**的：密码管理器。
 *   银行 / 聊天软件**不进出厂名单** —— 那是他的判断，不是我的：
 *   他可能正想在聊天窗里查一个词。名单可以自己加。
 */
export const DEFAULT_BLOCKED: readonly string[] = [
  '1password',
  'bitwarden',
  'keepass',
  'keepassxc',
  'lastpass',
  'dashlane',
  'enpass',
  'credentialuibroker',
  'consent',
  'lsass'
]

/** 短于这个数的当没选（一两个字母多半是拖鼠标带出来的）*/
export const MIN_CHARS = 2
/**
 * 长过这个数的不是查词。
 * ★ 取 120 不是拍的：Assist 契约里 MVP 的对象是「词 / chunk」，
 *   长材料明确不做（D-311）。一段 120 字以上的选中，他多半是要复制。
 */
export const MAX_CHARS = 120

/** 有没有一个拉丁字母 —— 这是个英语软件，全中文的选中不该触发 */
const HAS_LATIN = /[A-Za-z]/

export type GlanceVerdict =
  | { readonly take: true; readonly text: string; readonly rect?: ScreenRect }
  | { readonly take: false; readonly why: string }

/**
 * 这一次选中，要不要动。
 *
 * @param last 上一次真的动了的那串字（去重用）。没有就传 `null`
 * ★ **绝不抛**：判据抛异常的话，助手进程那一路会整条死掉，
 *   而他不会知道 Glance 什么时候停的。
 */
/**
 * 两条路共用的那几道闸（②密码框 · ③黑名单 · ④长度与英文）。
 *
 * ★★ 抽出来不是为了少写几行，是为了**不许漂**（使用者 2026-09-14 加了 Point 这条路）：
 *   划词和指词是两个入口，但「什么不该读」必须是**同一份**。
 *   各写一份的后果不是「查词没出来」，是一段他没打算给 Nyx 的字从
 *   其中一条路溢出去了 —— 而两边都不报错。
 */
function commonGates(hit: GlanceHit, rules: GlanceRules): GlanceVerdict {
  // ② 密码框。助手进程已经拦过一道，这里是第二道 —— 这种事不嫌两道
  if (hit.password === true) return { take: false, why: '来源是密码框' }

  const proc = typeof hit.proc === 'string' ? hit.proc.toLowerCase() : ''
  const blocked = Array.isArray(rules.blocked) ? rules.blocked : []
  if (proc && blocked.some((b) => typeof b === 'string' && b.toLowerCase() === proc)) {
    return { take: false, why: `「${proc}」在不抓的名单里` }
  }

  /**
   * ★ 折行 / 制表压成单空格再判长度与去重。
   *   同一段话在网页上拖两次，中间的换行可能不一样 —— 不压的话去重会失效，
   *   于是同一个词会连着弹两次卡。
   */
  const text = hit.text.replace(/\s+/g, ' ').trim()
  if (text.length < MIN_CHARS) return { take: false, why: '太短了' }
  if (text.length > MAX_CHARS) return { take: false, why: '太长了 —— 这不是查词，是复制' }
  if (!HAS_LATIN.test(text)) return { take: false, why: '没有英文' }
  /** ★ 位置一路带到底 —— 卡要摆在它下方（使用者 2026-09-14 晚）*/
  return { take: true, text, rect: hit.rect }
}

export function judge(
  hit: GlanceHit | null | undefined,
  rules: GlanceRules,
  last: string | null
): GlanceVerdict {
  try {
    if (!rules || rules.mode !== 'glance') return { take: false, why: 'Glance 没开' }
    if (!hit || typeof hit.text !== 'string') return { take: false, why: '没有内容' }

    const v = commonGates(hit, rules)
    if (!v.take) return v
    if (last !== null && v.text === last) return { take: false, why: '和上一次一样' }
    return v
  } catch {
    // 判不了就当没选中 —— 这一条永远不许把助手那一路带崩
    return { take: false, why: '判不了' }
  }
}

/**
 * ★★ 助手进程说「选中没了」的那一行（使用者 2026-09-14 第三条）。
 *
 * 他的原话：「当我点击其他地方时，弹窗仍然不会正常消失。」
 *
 * ★ 为什么这个信号只能从助手进程来：那张卡住在一个
 *   `focusable: false` 的窗口里（契约 §五「不接管」）——
 *   一个永远不抢焦点的窗口永远收不到 blur，而屏幕别处的点击
 *   直接进了别的程序，**Nyx 压根没机会知道**。
 *   而「点别处」正好就是「清掉选中」，助手进程本来就在盯这件事。
 * ★ 单独一个函数、不搔进 `parseHit`：`parseHit` 的契约是
 *   「返回一次该查的选中」，而这一行正好相反。接不出来给 `false`，**绝不抛**。
 */
export function isCleared(line: unknown): boolean {
  if (typeof line !== 'string') return false
  const s = line.trim()
  if (!s.startsWith('{')) return false
  try {
    const o = JSON.parse(s) as Record<string, unknown>
    return o.cleared === true
  } catch {
    return false
  }
}

/**
 * ══ 指到哪个词就查哪个词（使用者 2026-09-14）══════════════
 *
 * 他的原话：「为什么 frame 不能像是手机上面的 assist 一样，精准识别文字……
 * 我不太喜欢框选这个东西」。
 *
 * 去看了 Android 那边怎么做的（`NyxAssistService.java`）：它的主路根本不是 OCR，
 * 是无障碍树 ＋ 逐字符坐标（`EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY`），
 * OCR 只是兜底（它自己的注释：D-406 T3 / D-395）。
 * Windows 的 UI Automation 有一模一样的能力，而且就在助手进程已经加载的
 * 那个程序集里（`RangeFromPoint` + `ExpandToEnclosingUnit(Word)`）。
 *
 * ══ 它和划词那条路差在哪里 ══════════════════════
 *   ① **只在 Point 那一档跑**（他：两种功能不能混在一起）。它曾经是
 *     「两种模式下都能按的一颗键」—— **那一版被他推翻了**。
 *   ② **不去重** —— 划词那边去重是因为他只是挪了下鼠标；
 *     而按一下快捷键是**他主动又问了一遍**，同一个词再问一次必须有反应。
 *   ③ 多一道闸：**他是不是真的指在那个词上**（见 `POINT_MAX_DIST`）。
 */
export interface PointHit extends GlanceHit {
  /** 那个点在不在这个词的框里 */
  readonly inside?: boolean
  /** 点到词框的距离（像素）。`-1` = 助手没量到几何 */
  readonly dist?: number
  /**
   * ★★ 这串字是**认出来的**，不是问系统要来的（I-177）。
   *
   * `true` 时卡上必须标「可能有误」—— D-395 是硬的：
   * 错的 term 会**静默污染知识库**，同步回来以后看起来和真的一模一样，
   * 没有任何一个环节会报错。所以标记不是提示，是防线。
   */
  readonly ocr?: boolean
}

/**
 * ★★ 离得多远就不算他指的那个词。
 *
 * 为什么需要这一道（**2026-09-14 在他机器上量到的**）：
 * Edge 的 `RangeFromPoint` 对空白处**不返回空**，而是吸附到最近的文字上。
 * 实测：指在行距里 dist=36；指到老远的空白处照样给了一个词，dist=407。
 * 不卡这一道的话，他在空白处按一下会弹出一个他根本没指的词。
 *
 * ★ 取 48 不是拍的：行高实测 37–38px，指在两行之间（dist≈36）应该算数——
 *   那确实是他在指那一行；而 400 多像素外的那一个不是。
 *   Android 用的是 60（手指比鼠标粗），同一个做法、同一个理由。
 */
export const POINT_MAX_DIST = 48

/**
 * 指到的那个词，要不要查。
 * ★ 和 `judge` 一样：**绝不抛**。
 */
export function judgePoint(
  hit: PointHit | null | undefined,
  rules: GlanceRules
): GlanceVerdict {
  try {
    /**
     * ★★ **只认 `point` 这一档**（使用者 2026-09-14 晚）。
     *   他的原话：「当用户开启 Point 时：Assist 当前只运行 Point，不运行 Glance。」
     *   反过来也一样 —— 开着 Glance 时这颗键根本不该注册，这里是第二道。
     */
    if (!rules || rules.mode !== 'point') return { take: false, why: 'Point 没开' }
    if (!hit || typeof hit.text !== 'string') return { take: false, why: '没有内容' }

    /**
     * ★★ 他真的指在那个词上吗。`inside` 为真就算；
     *   否则看距离 —— `dist` 是 `-1`（助手没量到几何）时放行，
     *   因为那时候我们什么都不知道，而他确实按了那一下。
     */
    if (hit.inside !== true) {
      const d = typeof hit.dist === 'number' ? hit.dist : -1
      if (d >= 0 && d > POINT_MAX_DIST) {
        return { take: false, why: '指针下面没有文字' }
      }
    }

    return commonGates(hit, rules)
  } catch {
    return { take: false, why: '判不了' }
  }
}

/**
 * ══ 拖选那一路：助手每变一次就吐一行 ★★（使用者 2026-09-14 第三批）══
 *
 * 他的原话：「Point 的真正目的：让原本无法选中的文字变得可以选中……
 * 使用体验应该尽量像普通网页。」
 *
 * 于是一次拖动不是一件事而是一串事：起手、拖着（一路变）、松手。
 * 屏上要跟着画选区，松手那一下才查词 —— 所以这里分三种事件。
 *
 * ★ 判据还是 `judgePoint`（不另写一份）：黑名单、密码框、长度、
 *   「是不是真指在字上」都和单词那一路完全同一套。
 *   各写一份的后果不是查不出词，是一段他没打算给 Nyx 的字
 *   从其中一条路溢出去了，而两边都不报错。
 */
export type SelectEvent =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'sel'
      readonly hit: PointHit
      /** 每行一个（折行的选区有好几个）。屏幕物理像素。 */
      readonly rects: readonly ScreenRect[]
      /** 松手了吗 —— 只有松手那一下才查词 */
      readonly done: boolean
    }
  /**
   * ★★ 认出来的那一路（I-177，使用者 2026-09-14 点头「可以兜底」）。
   *
   * 助手拿不到真文字时才有这一档，它报的是**量出来的东西**：
   * 一条带里 OCR 认出的每个词 + 它的框 + 这次拖动的两个端点。
   * **挑哪个词不在这里定**（见 `pickOcrRun`）—— 助手量、core 判，
   * 和真文字那一路同一个分工。
   */
  | {
      readonly kind: 'ocr'
      readonly words: readonly OcrWord[]
      /** 按下那一点、松手那一点。屏幕物理像素。 */
      readonly a: { readonly x: number; readonly y: number }
      readonly b: { readonly x: number; readonly y: number }
      readonly proc: string
      readonly done: boolean
    }

/**
 * OCR 认出来的一个词 + 它在屏幕上的框（物理像素）。
 * ★ 字段名短是因为它每次拖动都要整条走一遍 stdout，一条带十几个词。
 */
export interface OcrWord {
  readonly t: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 一个点到一个词框的距离。0 = 在框里。 */
function distToWord(w: OcrWord, x: number, y: number): number {
  const dx = x < w.x ? w.x - x : x > w.x + w.w ? x - (w.x + w.w) : 0
  const dy = y < w.y ? w.y - y : y > w.y + w.h ? y - (w.y + w.h) : 0
  return Math.sqrt(dx * dx + dy * dy)
}

/** 离一个点最近的那个词的下标；**超出容差就不给**（`-1`）。 */
function nearestWord(words: readonly OcrWord[], x: number, y: number): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < words.length; i++) {
    const d = distToWord(words[i] as OcrWord, x, y)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  /**
   * ★★ 同一个 `POINT_MAX_DIST`，**不另立一个数**。
   *
   * 派单上写的是 Android 的 60。这里没照抄，理由是它会自相矛盾：
   * 挑词用 60、而 `judgePoint` 紧接着用 48 再判一次 ——
   * 落在 48～60 那一圈的词会**先被挑中、再被判掉**，屏上什么都不发生，
   * 而两边的代码各自都"对"。一个数只能有一个主人。
   * （48 是在他这台机器上量的：行高 37–38px；OCR 词框实测高 31px，同量级。）
   */
  return bestD > POINT_MAX_DIST ? -1 : best
}

/**
 * 这一段拖动有没有**从这个词身上划过去**。
 *
 * ★★ 竖着的容差按**行高**算，横着的容差是 0 —— 这两件事不对称，而且必须不对称：
 *   · 竖着：他不会正好压着字的中线拖，差半行也该算他在划这一行。
 *   · 横着：线段要么穿过这个词，要么没穿过。给横向也放几十像素的话，
 *     一次竖直的拖动会把左右两边**没碰过**的词一起吸进来。
 * ★★ 上一版这里用的是**各向同性**的 `POINT_MAX_DIST`（48px 半径）。
 *   真原神那一帧上两行字相距 40px，于是一次**横着**的拖动在 y=512 处
 *   离下一行的框只有 28px —— 28 < 48，下一行整行被吸了进来：
 *   `4. glider Pay while attention your to air gliding traffic license conditions`
 *   48 那个数是给**一个点**校的（指在行距里也算指这一行），
 *   拿来扫一条线就等于扫出一条 96px 高的带子，跨行是必然的。
 */
function segCrossesWord(w: OcrWord, ax: number, ay: number, bx: number, by: number): boolean {
  /** 半行的余量，够他拖得歪一点，又不至于够到隔壁行 */
  const pad = Math.max(4, w.h * 0.35)
  const x1 = w.x
  const x2 = w.x + w.w
  const y1 = w.y - pad
  const y2 = w.y + w.h + pad
  /** 线段 vs 轴对齐矩形（slab 法）*/
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  const slab = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  return (
    slab(-dx, ax - x1) && slab(dx, x2 - ax) && slab(-dy, ay - y1) && slab(dy, y2 - ay)
  )
}

/**
 * ══ 这次拖动，在认出来的那些词里选中了哪一段 ★★★ ══════════════
 *
 * 规矩：**拖动线从哪些词身上划过去，就取哪些**。他划过的要，没划过的不要。
 *
 * ══ 上一版错在哪 ★★★（2026-09-15 他在真原神里撞出来的）══════
 *
 * 他装完之后报「原神里面都不能选中」。日志里只有两行：
 *   `[point] 这里没读到文字`
 *   `[point] 没取：太长了 —— 这不是查词，是复制`
 * 第二行才是要紧的：**OCR 明明读到了字，是我自己的判据把它扔了。**
 *
 * 上一版取的是「起点那个词」和「终点那个词」在**阅读顺序里的下标区间**，
 * 再把中间**所有**词一并切下来。我的合成用例里那条带只有一行字，怎么切都对；
 * 真游戏界面里那条带有好几行，于是一次普通的拖动就把**下一行**的字也切了进来
 * （实测：拖 500,512 → 900,554 切出 12 个词 69 字，后半截他压根没碰过）。
 * 屏幕再密一点就超过 `MAX_CHARS`，`judgePoint` 判「太长了」，
 * 于是他拖一次、拿到一张看不懂的卡，**一个词都选不到**。
 *
 * ☞ 两条教训都写在这儿：
 *   ① 合成用例里那条带**只有一行字**，这个 bug 在那种数据下**不可能红**。
 *   ② 「下标区间」是从**文本编辑器**借来的直觉（选中 = 起止之间全部），
 *     而这里没有"一段连续的文本"，只有一堆散落在屏幕上的词框。
 *
 * @returns 挑不出来给 `null` —— 那是"这里没读到文字"，**不是**错误。
 */
export function pickOcrRun(
  words: readonly OcrWord[],
  a: { x: number; y: number },
  b: { x: number; y: number }
): { text: string; rects: ScreenRect[]; dist: number; inside: boolean } | null {
  try {
    if (!Array.isArray(words) || !words.length) return null
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null
    /**
     * ★ 起手那一下必须落在某个词附近 —— 否则他没在指字，这一段到此为止。
     *   这一条和真文字那一路的 `dist` 闸是同一个意思，用的也是同一个数。
     */
    const ai = nearestWord(words, a.x, a.y)
    if (ai < 0) return null
    const anchor = words[ai] as OcrWord

    /**
     * ★ 起止同一点 = 他点了一下没拖 —— 就那一个词。
     *   （真实手势总是拖过 `DRAG_MIN` 的，这一档是给判据自己兜底用的。）
     */
    const still = a.x === b.x && a.y === b.y
    /**
     * ★★ 顺序**按阅读顺序**（助手吐进来时就是这个顺序），不按拖动方向。
     *   他从右往左拖的时候，读出来仍然得是正着的那一串。
     */
    const run = still ? [anchor] : words.filter((w) => w === anchor || segCrossesWord(w, a.x, a.y, b.x, b.y))
    if (!run.length) return null

    const text = run
      .map((w) => w.t)
      .join(' ')
      .trim()
    if (!text) return null
    const rects = run.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }))
    /**
     * ★ `dist` / `inside` 报的是**起手那一点**离它那个词有多远 ——
     *   和真文字那一路完全同一个含义（`select.ps1` 的 `$anchorD`），
     *   所以 `judgePoint` 那一道闸对两条路的判法一模一样。
     */
    const dist = Math.round(distToWord(anchor, a.x, a.y))
    return { text, rects, dist, inside: dist === 0 }
  } catch {
    return null
  }
}

/** 助手吐的一个 OCR 词。认不出来给 `undefined`，**绝不抛**。 */
function parseOcrWord(v: unknown): OcrWord | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o.t !== 'string' || o.t === '') return undefined
  const [x, y, w, h] = [o.x, o.y, o.w, o.h].map((n) =>
    typeof n === 'number' && Number.isFinite(n) ? n : NaN
  )
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return undefined
  if ((w as number) <= 0 || (h as number) <= 0) return undefined
  return { t: o.t, x: x as number, y: y as number, w: w as number, h: h as number }
}

/**
 * 拖选助手吐的一行 → 事件。认不出来给 `null`，**绝不抛**。
 * ★ `{"why":…}` 也返回 `null` —— 那是给日志看的，不是给屏幕看的。
 */
export function parseSelectLine(line: unknown): SelectEvent | null {
  if (typeof line !== 'string') return null
  const s = line.trim()
  if (!s.startsWith('{')) return null
  try {
    const o = JSON.parse(s) as Record<string, unknown>
    if (o.clear === true) return { kind: 'clear' }
    /**
     * ★★ 认出来的那一档（I-177）。**放在 `sel` 之前判**：
     *   这一行没有 `sel` 字段，走到下面那一句就被当成垃圾丢掉了 ——
     *   在原神里"划了什么都没发生"正是这么来的（第一段查明 Q-1）。
     */
    if (o.ocr === true) {
      const raw = Array.isArray(o.words) ? o.words : []
      const words = raw.map(parseOcrWord).filter((w): w is OcrWord => !!w)
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
      const [ax, ay, bx, by] = [o.ax, o.ay, o.bx, o.by].map(num)
      if (![ax, ay, bx, by].every((n) => Number.isFinite(n))) return null
      return {
        kind: 'ocr',
        words,
        a: { x: ax as number, y: ay as number },
        b: { x: bx as number, y: by as number },
        proc: typeof o.proc === 'string' ? o.proc.toLowerCase() : '',
        done: o.done === true
      }
    }
    if (typeof o.sel !== 'string' || o.sel === '') return null
    const rects = Array.isArray(o.rects)
      ? o.rects.map(parseRect).filter((r): r is ScreenRect => !!r)
      : []
    const d = typeof o.dist === 'number' ? o.dist : -1
    return {
      kind: 'sel',
      hit: {
        text: o.sel,
        proc: typeof o.proc === 'string' ? o.proc.toLowerCase() : '',
        password: o.password === true,
        /** ★ `inside` 不是助手另报的一栏，就是「距离为 0」—— 不让它们漂 */
        inside: d === 0,
        dist: d,
        rect: unionRect(rects)
      },
      rects,
      done: o.done === true
    }
  } catch {
    return null
  }
}

/**
 * 几个矩形的并集。卡要摆在**整段**下面，不是第一行下面。
 * ★ 一个都没有就给 `undefined`，调用方本来就要处理「没有位置」那一档。
 */
export function unionRect(rects: readonly ScreenRect[]): ScreenRect | undefined {
  if (!rects.length) return undefined
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    if (r.x < x1) x1 = r.x
    if (r.y < y1) y1 = r.y
    if (r.x + r.w > x2) x2 = r.x + r.w
    if (r.y + r.h > y2) y2 = r.y + r.h
  }
  if (!(x2 > x1) || !(y2 > y1)) return undefined
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Point 助手吐的一行 → `PointHit`。认不出来给 `null`，**绝不抛**。 */
export function parsePointHit(line: unknown): PointHit | null {
  if (typeof line !== 'string') return null
  const s = line.trim()
  if (!s.startsWith('{')) return null
  try {
    const o = JSON.parse(s) as Record<string, unknown>
    if (typeof o.text !== 'string' || o.text === '') return null
    return {
      text: o.text,
      proc: typeof o.proc === 'string' ? o.proc.toLowerCase() : '',
      password: o.password === true,
      inside: o.inside === true,
      dist: typeof o.dist === 'number' ? o.dist : -1,
      rect: parseRect(o.rect)
    }
  } catch {
    return null
  }
}

/** 助手进程吐的一行 → `GlanceHit`。认不出来给 `null`，**绝不抛**。 */
export function parseHit(line: unknown): GlanceHit | null {
  if (typeof line !== 'string') return null
  const s = line.trim()
  if (!s.startsWith('{')) return null
  try {
    const o = JSON.parse(s) as Record<string, unknown>
    if (typeof o.text !== 'string') return null
    return {
      text: o.text,
      proc: typeof o.proc === 'string' ? o.proc.toLowerCase() : '',
      password: o.password === true,
      rect: parseRect(o.rect)
    }
  } catch {
    return null
  }
}

/**
 * ══ 那张卡摆在哪 ★★★（I-182，2026-09-15）═══════════════════════
 *
 * 他定的规矩一个字没改：**卡出现在选中那段字的正下方**，
 * x 和那段字左边对齐（读的人视线就在那儿）。改的只有「放不下的时候怎么办」。
 *
 * ══ 上一版错在哪 ★★★（在他机器上看见的）═══════════════════════
 *
 * 老写法是「下面放不下 → 翻到上方 → 最后夹进可用区」。
 * 翻上去之后那个数可能是**负的**，于是被夹成 `y = 0` —— 一路贴到屏幕顶。
 * 2026-09-15 他真拖了两次，两张卡都是 `y = 0`（`@846,0`、`@1198,0`）。
 *
 * ★ 一开始我以为这是「卡跑到看不见的地方」，**算错了**：
 *   卡高 520、顶在 0，下沿就在 520，而触发这一档的选区正好在 461～538。
 *   所以真正的症状是 **卡盖住了他刚选的那段原文** ——
 *   而「翻到上方」这条规则存在的全部理由就是别盖住它。老写法把自己否定了。
 *
 * ══ 那一段死区是怎么来的（拿真数字算一遍）════════════════════
 *
 * 卡高 `H` = 520、间隙 `GAP` = 18、这台机器可用高 1019：
 *   · 放得下**下方**，要 `选区顶 + 选区高 ≤ 481`
 *   · 翻**上方**不出界，要 `选区顶 ≥ 538`
 * 中间 **482～537 那一段两条都不成立**，老写法就落到 `y = 0`。
 * 选中的行数越多（选区越高）这段越宽；带「可能有误」那条的卡高 576，更宽。
 *
 * ══ 现在怎么办 ═══════════════════════════════════════════
 *
 * 下方放得下 → 下方（他要的那个位置）
 * 放不下、上方放得下 → 上方（原来就有的翻面，理由不变：别盖住原文）
 * **两边都放不下 → 夹到下边界**，不许再落到顶上。
 *   ☞ 这一档屏幕上**确实没有**够 520 高又不碰选区的空位，数学上躲不掉重叠；
 *     能选的只有「压住它的哪一半」。夹下边界至少让卡的**上沿贴着选区**，
 *     他的视线从原文往下走就进卡里，和「正下方」那条要求是同一个方向；
 *     夹到顶边则是把整张卡倒扣在原文上，方向正好反着。
 *
 * @param anchor 那段字的矩形；助手拿不到几何时给 `null`
 * @param cursor 拿不到几何时的退路 —— 鼠标旁边
 * @param size   这张卡的真实尺寸（带标记的卡比常规的高一条，必须传真数）
 * @param area   这块屏的可用区（已经去掉任务栏）
 */
export function placeLookup(
  anchor: ScreenRect | null,
  cursor: { x: number; y: number },
  size: { w: number; h: number },
  area: ScreenRect,
  gap = 18
): { x: number; y: number } {
  const right = area.x + area.w - size.w
  const bottom = area.y + area.h - size.h
  let x: number
  let y: number
  if (anchor) {
    x = anchor.x
    const below = anchor.y + anchor.h + gap
    const above = anchor.y - size.h - gap
    if (below <= bottom) y = below
    else if (above >= area.y) y = above
    else y = bottom
  } else {
    x = cursor.x + gap
    y = cursor.y + gap
  }
  /**
   * ★ 最后夹进可用区。`bottom` 可能比 `area.y` 还小（卡比屏幕还高），
   *   那一档 `Math.max` 收尾，卡从屏幕顶开始 —— 除此之外 `y` 不会是顶。
   */
  return {
    x: Math.min(Math.max(x, area.x), Math.max(right, area.x)),
    y: Math.min(Math.max(y, area.y), Math.max(bottom, area.y))
  }
}
