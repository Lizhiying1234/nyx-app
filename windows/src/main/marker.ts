import { BrowserWindow, screen } from 'electron'

/**
 * ══ 选区高亮层 · 主进程这一半（使用者 2026-09-14 第三批）★★ ══════
 *
 * 他要的是：「原本不能被选中的文字，应该变得可以直接选中……使用体验应该
 * 尽量像普通网页 / 普通文本界面一样。」
 *
 * 「像普通网页」里最要紧的一半不是查得准，是**他拖的时候看得见自己拖到哪了**。
 * 助手那边已经能把真实的选区几何报上来（`select.ps1`），这一层负责把它画出来。
 *
 * ══ 这块层最要命的一条：它**永远不吃鼠标** ════════════════════
 *
 * `setIgnoreMouseEvents(true)` 从建出来就开着，一次都不关。
 * 理由不是性能，是**这个功能的前提**：他正在别的程序上拖动，那一下必须原样
 * 落到那个程序里。一块全屏的置顶窗口只要吃掉一次点击，屏幕就等于被锁住了 ——
 * 这正是 2026-09-14 白天 Frame 那张全屏遮罩挨骂的地方
 * （「一打开就出现一张全屏不透明的遮罩，屏幕被完全遮住」）。
 * 那次是**不透明**，这次连**可点**都不许有。
 *
 * ★ Android 那边反过来：无障碍浮层天生吃触摸，所以它得把不属于自己的手势
 *   用 `GestureDescription` 重放回宿主（D-402）。Windows 不需要那一半 ——
 *   我们压根没接管输入，`select.ps1` 只是旁观。
 *
 * ★ 没东西画的时候**窗口是收起来的**（`hide`），不是画一块透明的留在那儿。
 *   「关了却还在」是这一批已经栽过的那种错。
 */

let marker: BrowserWindow | null = null

function build(preload: string, devUrl: string | undefined, rendererFile: string): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    /** ★ 不抢焦点：他正在别的程序里拖 —— 抢一下那个程序就掉焦点了 */
    focusable: false,
    /** ★ 全屏尺寸的窗口不能进任务切换、也不能被误当成一个「应用」*/
    fullscreenable: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  /**
   * ★★ 从这一刻起到销毁为止，它都是穿透的。
   *   `forward: false` —— 连 `mousemove` 都不要：这一层不需要知道鼠标在哪，
   *   它只负责把主进程给的几个方块画出来。少订一样就少一样可能出错的东西。
   */
  w.setIgnoreMouseEvents(true)

  if (devUrl) w.loadURL(devUrl + '?marker=1')
  else w.loadFile(rendererFile, { query: { marker: '1' } })

  w.on('closed', () => {
    marker = null
  })
  return w
}

/** 那一串矩形（DIP，屏幕坐标）。空数组 = 把层收起来。 */
export function showMarks(
  rects: readonly { x: number; y: number; w: number; h: number }[],
  opts: { preload: string; devUrl?: string; rendererFile: string }
): void {
  if (!rects.length) {
    hideMarks()
    return
  }
  if (!marker || marker.isDestroyed()) {
    marker = build(opts.preload, opts.devUrl, opts.rendererFile)
  }
  const w = marker

  /**
   * ★ 层只铺**选区所在的那一块屏**，不是所有屏的并集。
   *   多屏并集会做出一个横跨两台显示器的窗口，Windows 对这种窗口的
   *   透明与置顶处理各家驱动都不一样，而我们一块屏就够用了。
   * ★ 用 `bounds` 不是 `workArea`：选中的字可能就在任务栏上方那一条里。
   */
  const first = rects[0] as { x: number; y: number; w: number; h: number }
  const d = screen.getDisplayNearestPoint({ x: Math.round(first.x), y: Math.round(first.y) })
  const b = d.bounds
  w.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })

  /** 屏幕坐标 → 层内坐标。渲染层只认「相对这块层左上角」。 */
  const local = rects.map((r) => ({
    x: Math.round(r.x - b.x),
    y: Math.round(r.y - b.y),
    w: Math.round(r.w),
    h: Math.round(r.h)
  }))

  const send = (): void => {
    if (!w.isDestroyed()) w.webContents.send('marker:rects', local)
  }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()

  /** ★ `showInactive`：显示但**不激活** —— 他还在原来那个程序里拖着 */
  if (!w.isVisible()) w.showInactive()
}

/** 收起来。★ 幂等，没开也能叫。 */
export function hideMarks(): void {
  if (marker && !marker.isDestroyed()) {
    /** 先清空再藏 —— 下次亮起来的那一帧不会闪出上一次的选区 */
    marker.webContents.send('marker:rects', [])
    marker.hide()
  }
}

/** 彻底销毁。★ Point 关掉时叫它：留一个看不见的置顶窗口＝「关了却还在」。 */
export function destroyMarker(): void {
  if (marker && !marker.isDestroyed()) marker.destroy()
  marker = null
}
