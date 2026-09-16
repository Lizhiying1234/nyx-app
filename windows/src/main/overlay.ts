import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { placeLookup } from '../core/glance'

/**
 * 浮窗 · 盖在**别的程序**上面的那一张卡（使用者 2026-09-13）
 *
 * ══ 为什么非得是一个真窗口 ═══════════════════════════════════
 * `DictCard.svelte` 头上写着一条规矩：「**不新开窗口** —— 项目里所有浮层都是
 * 渲染进程内的绝对定位元素；BrowserWindow 会带来焦点、DPI、多显示器一整套问题」。
 * 那条规矩**一个字没错**，但它管的是**应用内**的浮层。
 *
 * Glance 的前提是「他正在**别的程序**里看东西」——
 * 那时候 Nyx 在后面，画在 Nyx 窗口里的卡**他根本看不见**。
 * 而 `ASSIST_CONTRACT` §五 的六条硬约束里有两条正面卡住了所有替代方案：
 *   · **不接管** —— 不许把 Nyx 拉到前台（那才是最省事的做法，也正是被禁的那个）
 *   · 浮层升起时**原页面继续可见**
 * 两条一起，只剩「一个盖在上面的小窗口」这一条路。
 * ★ 所以这不是推翻那条规矩，是那条规矩的适用范围到此为止。
 *   规矩说的那三个代价（焦点 / DPI / 多显示器）这里逐个处理，见下面。
 *
 * ══ 三个代价怎么处理的 ═════════════════════════════════════
 * · **焦点**：`focusable: false` —— 它永远不抢键盘焦点，他还在原来那个程序里，
 *   打字照常进那边。鼠标点得动（Save、换词典要点），但点了**不夺走**前台。
 * · **DPI / 多显示器**：位置一律走 `screen.getDisplayNearestPoint(鼠标)` 的
 *   `workArea` 来夹，不用主屏的尺寸硬算 —— 副屏、缩放 150% 的屏都落在正确位置。
 * · **不进任务栏**：`skipTaskbar` —— 它是一张卡，不是一个「打开着的程序」。
 */

/** 卡的尺寸。和 `.dcw` 那张卡在样式表里的宽高对齐 */
const W = 420
const H = 520
/**
 * ★★ 带「可能有误」那条标记时，窗要**高出这么多**（I-177）。
 *
 * 标记和卡是竖着叠的（`.ovwrap`），窗不长高的话那条就是从卡身上切走的 ——
 * 认出来的词本来就更需要他自己核一眼原文，正文区反而更小说不过去。
 * ★ 这个数不必和标记的真实高度分毫不差：两块是 flex 分的，差几像素只是
 *   卡略高略矮，**不会留出吃鼠标的缝**。
 */
const OCR_BAR = 56
/**
 * ★★ 「这里没读到文字」那一张的窗高（I-177）。
 *
 * 它只有一行标题、两行说明、一颗按钮 —— 按查词卡那个 520 开，
 * 窗里会剩下一大片**透明但照样吃鼠标**的地方：他点那儿以为点的是
 * 底下那个程序，实际上点的是 Nyx 的窗。所以这一档的窗要矮下来，
 * 而 `.ovnone` 那边 `inset: 0` 把卡撑满这个高度 —— **两处是一对**。
 */
const EMPTY_H = 150
/** 贴着鼠标，但让开一点，别盖住他刚选中的那几个字 */
const GAP = 18

let overlay: BrowserWindow | null = null

function build(preload: string, devUrl: string | undefined, rendererFile: string): BrowserWindow {
  const w = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    /**
     * ★★ 能搬（使用者 2026-09-14 晚：「弹窗本身应该可以拖动、移动」）。
     *   搬它的是 `moveBy`，不是系统标题栏 —— 这个窗口没有标题栏。
     */
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    /** ★ 不抢焦点 —— 「不接管」那一条就靠它（ASSIST_CONTRACT §五）*/
    focusable: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  /**
   * ★ `screen-saver` 这一档才压得住别的「置顶」窗口（很多浏览器的全屏视频是）。
   *   压不住的话，他最需要它的那些场合正好看不见它。
   */
  w.setAlwaysOnTop(true, 'screen-saver')
  /** 跟着他切虚拟桌面走 —— 卡留在另一个桌面上等于没有 */
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (devUrl) w.loadURL(devUrl + '?overlay=1')
  else w.loadFile(rendererFile, { query: { overlay: '1' } })

  w.on('closed', () => {
    overlay = null
  })
  return w
}

/**
 * 把一段字送到浮窗里去查，并让它出现在鼠标附近。
 *
 * ★ **第一次调用才建窗口**，之后一直留着（藏起来，不销毁）——
 *   他连着查三个词是常事，每次重建一个 BrowserWindow 要几百毫秒，
 *   而这条路的全部意义就是「当场」。
 */
export function showLookup(
  text: string,
  opts: {
    preload: string
    devUrl?: string
    rendererFile: string
    /**
     * ★★ 那段字在屏幕上的矩形（使用者 2026-09-14 晚）。
     *   给了就把卡摆在**它正下方**；没给（助手取不到几何）才退回鼠标位置。
     */
    anchor?: { x: number; y: number; w: number; h: number }
    /**
     * ★★ 这串字是**认出来的**（I-177）—— 卡上要标「可能有误」。
     *
     * D-395 的原话是「OCR 永远只是兜底……结果必须带『可能有误』标记」，
     * 而理由在 D-304 里：**错的 term 会静默污染知识库** ——
     * 同步回来以后它看起来和真的一模一样，没有任何一个环节会报错。
     * 所以这不是一句提示，是这条路唯一的防线。
     */
    ocr?: boolean
    /**
     * ★★ 这一下**什么都没读到**（I-177）。卡照样出来，说一句实话。
     *   在这之前这条路是哑的 —— 他拖一下，屏上什么都不发生。
     */
    empty?: boolean
    /**
     * ★★ 卡上那一句，**由判据给，不写死在界面里**。
     *   写死一句「这里没读到文字」的话，在黑名单程序里那一下就成了假话 ——
     *   字读到了，是我们不给。而假话比不说更糟。
     */
    note?: string
    /** 第二行（可选）。只有「这儿确实没字」那两档给得出有用的下一步 */
    hint?: string
  }
  /**
   * @returns 这张卡**最后摆在哪、多大**。调用方要拿它写日志（I-177 那条教训：
   *   成功路径一声不吭的话，「没触发」和「出了但他没看见」在日志里一模一样）。
   */
): { x: number; y: number; w: number; h: number } {
  if (!overlay || overlay.isDestroyed()) {
    overlay = build(opts.preload, opts.devUrl, opts.rendererFile)
  }
  const w = overlay

  /**
   * ══ 摆在哪 ★★（使用者 2026-09-14 晚重定）═══════════════════════
   *
   * 他的原话：「弹窗应该**正好出现在当前选中文字的下方**。弹窗位置要根据选中
   * 文字的位置进行定位，而不是固定出现在其他位置。」
   *
   * ── 以前是什么样 ─────────────────────────────────────────
   * 摆在**鼠标坐标**旁边。他刚拖完选区时两者很近，所以一开始看着是对的；
   * 但他用键盘选、或者选完把鼠标挪开，卡就落在一个和那段字毫无关系的地方。
   *
   * ── 现在 ────────────────────────────────────────────────
   * 助手把那段字的矩形一路带上来（`GetBoundingRectangles` 的并集）。
   *   x —— 和那段字**左边对齐**（读的人视线就在那儿）
   *   y —— 那段字的**下沿**再加一点空隙
   * ★ 下面放不下就翻到**上方**（和应用内右键菜单同一套边界检测，D-200），
   *   而不是硬塞在屏幕底边 —— 硬塞会正好盖住他刚选的那段字。
   */
  const pt = screen.getCursorScreenPoint()
  const a = opts.anchor
  /**
   * ★ 带标记那一档窗要高一截。**在这儿算**，不是算完位置再算 ——
   *   翻面与夹边界都得用真实高度，用 H 的话带标记的卡在屏幕底部会插出去一截。
   */
  const h = opts.empty === true ? EMPTY_H : H + (opts.ocr === true ? OCR_BAR : 0)
  const area = screen.getDisplayNearestPoint(a ? { x: a.x, y: a.y } : pt).workArea
  /**
   * ★★ 摆哪儿是**判断**，判断归 core（I-182，2026-09-15）——
   *   这儿只负责把这块屏的真实尺寸量给它。
   *   摆位规则连同「死区」那段算式写在 `placeLookup` 头上，
   *   用例在 `glance.test.ts`（`npm test` 就能跑，不用起 Electron）。
   */
  const { x, y } = placeLookup(
    a ? { x: a.x, y: a.y, w: a.w, h: a.h } : null,
    pt,
    { w: W, h },
    { x: area.x, y: area.y, w: area.width, h: area.height },
    GAP
  )
  /** ★ 新的一次查词 = 新的起点，上一次拖动的原点作废 */
  dragFrom = null
  /** ★ 记下**我们设下去的**高度 —— 拖动那一路只认这个数（见 `moveLookup`）*/
  shownH = h
  const put = { x: Math.round(x), y: Math.round(y), w: W, h }
  w.setBounds({ x: put.x, y: put.y, width: put.w, height: put.h })

  /**
   * ★★ `ocr` 标记 **2026-09-14 又活过来了**（I-177）。
   *
   * 它当天下午刚被删掉，理由写在那一版里：Frame 取消之后「Windows 上没有
   * 任何一条路是认出来的，那句话没有主语」。**当时那个理由是对的。**
   * 现在主语回来了 —— 原神那类自绘界面里 UIA 一个字都拿不到（两把锁：
   * SYSTEM 完整性 + 零文本节点），只剩认的这一条路。D-395 一个字没改过。
   * ☞ 谁看到这儿觉得「怎么又加回来了」：不是回潮，是这条路本身回来了。
   */
  const send = (): void =>
    w.webContents.send(
      'overlay:lookup',
      text,
      opts.ocr === true,
      opts.empty === true,
      opts.note ?? '',
      opts.hint ?? ''
    )
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()

  /** ★ `showInactive` 不是 `show` —— 显示但**不激活**，他还在原来那个程序里 */
  w.showInactive()
  /** ★ 把摆在哪回给调用方 —— 它要写进日志（见上面 `@returns`）*/
  return put
}

/**
 * ══ 搬窗口为什么不能「读一下再加一点」★★（2026-09-14 实测）══
 *
 * 使用者报：「当我拖着弹窗移动时，弹窗会莫名其妙变大。
 * 移动弹窗 ≠ 改变弹窗大小。」
 *
 * 一开始我以为是 `setBounds` 带了尺寸回去，换成 `setPosition` 就好。
 * **不是。** 拿一个和查词卡一样的窗口量了一次（他这台 150% 缩放）：
 *
 *   setPosition(getBounds().x + 1, y) × 25  →  x 一步没动，**宽度涨了 25**
 *   自己算位置、不读回 × 20            →  x 真的走了 20，尺寸纹丝不动
 *
 * 原因：1 DIP = 1.5 物理像素。挪 1 DIP 取整之后位移被抹成 0，
 * 而那一点取整误差全被**尺寸**吃了；下一步再把长大了的 bounds 读回来当基准，
 * 于是一次拖动几百个事件就肿成了肉眼可见的一块。
 *
 * ★ 所以坐标系不在这儿修 —— 只要**不把自己的 bounds 读回来当基准**就行：
 *   按下那一刻记一次原点，后面每一步都是「原点 + 从按下到现在的累计位移」。
 *   误差不再叠，尺寸也没人碰。
 */
let dragFrom: { x: number; y: number; width: number; height: number } | null = null

/**
 * 这张卡**摆出来时设下去的高度**（不是读回来的）。见 `moveLookup` 里那段。
 * ★ 出厂值就是 `H`：还没摆过卡就没人会去拖它。
 */
let shownH = H

/**
 * 把卡搬到「按下时的位置 + 累计位移」。
 *
 * @param dx 从**按下那一刻**算起的累计位移（不是上一帧的增量）
 * @param first 这是按下后的第一步 —— 在这一刻把原点记下来
 *
 * ★ 每一步都按**当前这块屏**的可用区夹 —— 拖出屏幕的卡他拖不回来。
 * ★ 拖过之后下一个词还是摆回那个词下面：他挪是为了看清底下那段字，
 *   而下一个词在别的地方，「他挪过一次」不该变成「以后都别管位置了」。
 */
export function moveLookup(dx: number, dy: number, first = false): void {
  const w = overlay
  if (!w || w.isDestroyed()) return
  if (first || !dragFrom) dragFrom = w.getBounds()
  const o = dragFrom
  const area = screen.getDisplayNearestPoint({ x: o.x, y: o.y }).workArea
  /**
   * ══ 高度用**上一次摆出来时设的那个数** ★★（2026-09-15 修）════════
   *
   * 三个要求同时成立，少一个都不行：
   *   ① 不能写死 `H` —— 带「可能有误」标记的卡比 `H` 高一条（`OCR_BAR`，I-177），
   *      写死的话他一拖这张卡，卡**当场矮一截**，正文被切掉。
   *   ② 不能用 `getBounds()` **读回来**的那份（`dragFrom.height`，上一版就是它）。
   *   ③ 每一步都得用同一个基准，误差不许叠。
   *
   * ── ② 错在哪（实测，别再改回去）──────────────────────────
   * 读回来的数在分数缩放下是**涨过的**：这台机器 150%，
   * 520 的窗 `getBounds().height` 读回来是 **521**（2026-09-15 量的）。
   * 把 521 再 `setBounds` 回去，窗就真的从 520 变成了 521 ——
   * 他的原话是「移动弹窗 ≠ 改变弹窗大小」，那就一像素都不该动。
   * ★ 它**只涨这一次、不累积**（同样是量出来的：521 设回去读回来还是 521）。
   *   所以这不是「拖着拖着越来越大」那条，那条是宽度，早修好了。
   * 真正会咬人的是另一张脸：下边界夹的是 `工作区底 − 高`，
   * 高多算 1 像素，天花板就低 1 像素 ——
   * **卡贴着屏幕下沿时，只送横向位移它也会被往上顶。**
   * 这正是宽度那条注释早就写过的坑（「读回来的是物理像素 ÷ 1.5 向上取整」），
   * 只是 I-177 把高度从常数换成变量时，顺手把基准也换成了读回值。
   *
   * ── 现在 ──────────────────────────────────────────────
   * `shownH` = `showLookup` 摆这张卡时**自己算出来并设下去**的那个高度。
   * 和宽度用常数 `W` 是同一个道理：**送出去的数只能来自我们自己，
   * 不能来自读回来的窗**。
   *
   * ── ★★★ 这一条**没有用例看着**，别以为有 ────────────────────
   * `smoke:overlay` ⑦ 拿不住它，我试过并且**做了反向对照**：
   * 把这一行换回 `o.height`，那一套照样 7/7 全绿。原因是 ⑦ 只能读
   * `getBounds()`，而这 1 像素的差**恰恰就藏在 `getBounds()` 的取整里**
   * （真窗 520 读回 521；把 521 设回去，读回来还是 521 —— 也就是说
   * 它不累积，屏上那点差别隔着这层读数根本看不见）。
   * 要真钉住它得走 `GetWindowRect` 拿物理像素，那是另起一套 PowerShell 的事，
   * 这一轮不做。
   * ☞ 所以这一行靠的是**道理**不是**闸**：它和上面宽度那条是同一句话。
   *   谁要改它，别拿「用例还是绿的」当证据 —— 那句话在这儿恒成立。
   */
  const hh = shownH
  const x = Math.min(Math.max(o.x + Math.round(dx), area.x), area.x + area.width - W)
  const y = Math.min(Math.max(o.y + Math.round(dy), area.y), area.y + area.height - hh)
  /**
   * ★★ 宽度用**建窗时那个常数**，不用 `getBounds()` 每一帧读回来的那份。
   *   读回来的是「物理像素 ÷ 1.5 向上取整」后的数，再传回去就又乘一遍 ——
   *   实测：传读回值的话第一步就肿 1（421 → 422），传常数则一直是那么大。
   *   他的要求是「移动 ≠ 改变大小」，那就一像素都不能变。
   *   ★ 高度同理，只是基准是按下那一刻那一个数，不是常数（见上）。
   */
  w.setBounds({ x, y, width: W, height: hh })
}

/** 收起来。★ 幂等，没开也能叫。 */
export function hideLookup(): void {
  if (overlay && !overlay.isDestroyed()) overlay.hide()
}

export function destroyOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
}

/** 开发时渲染进程的地址；打包后是那个 html 文件 */
export function rendererTargets(dirname: string): { devUrl?: string; rendererFile: string } {
  return {
    devUrl: process.env['ELECTRON_RENDERER_URL'],
    rendererFile: join(dirname, '../renderer/index.html')
  }
}
