import { BrowserWindow, screen } from 'electron'
import type { Database } from 'better-sqlite3'

/**
 * Assist 的**桌面悬浮小图标**（使用者 2026-09-14 晚）
 *
 * ══ 他说了三次，我前两次都翻译错了 ★★★ ═══════════════════════
 * 09-13：「记得给 Assist 做一个独立的小图标，用于显示在 Windows 桌面上」
 *   → 我判断桌面上那种 `.lnk` 快捷方式改不了状态，**翻译成了托盘图标**，
 *     并当面说过「这是我替他做的一个翻译」。
 * 09-14 早：他重定了图标本身（一枚衍射星、两档），我照做 —— 仍然是托盘。
 * 09-14 晚：**「目前 Windows 端需要的 Assist 桌面悬浮小图标仍然没有看到。
 *   这个功能需要实际存在：在 Windows 桌面上显示 Assist 的悬浮小图标。
 *   图标应该悬浮在其他应用窗口之上。它不是普通 App Icon，而是作为 Assist 的
 *   桌面悬浮控制入口。」**
 *
 * ★ 所以这一版做的是**真的悬浮窗** —— 一个小的、置顶的、透明的 BrowserWindow，
 *   像手机上那颗气泡。我那个翻译到此为止。
 * ★ 托盘那一枚**留着**：它在通知区域，是 Windows 上「打开 / 退出」的老地方，
 *   而且他没说要去掉。两者管的是同一个开关，状态永远一致（都从 `glance.mode` 读）。
 *
 * ══ 为什么不抢焦点，却还要能点 ══════════════════════════════
 * `focusable: false` —— 他正在别的程序里打字，点一下这颗气泡不该把输入焦点抢走
 * （和查词浮窗同一条，`ASSIST_CONTRACT` §五「不接管」）。
 * ★ `focusable: false` 只关掉**键盘焦点与激活**，鼠标事件照样进得来 ——
 *   所以点得动、也拖得动。
 *
 * ══ 拖动为什么自己写，不用 `-webkit-app-region: drag` ★★ ═══════
 * 那个属性是给**整块区域**用的：一旦某块是 drag，它上面的点击就不再是点击了。
 * 而这颗气泡只有一个东西 —— 图标本身**既要能点也要能拖**。
 * 所以走手写的一套：按下记坐标 → 移动就搬窗口 → 松手时**位移小于阈值才算点击**。
 * 阈值 4px 是「手抖」和「真的拖」之间的界，写在渲染那一侧（`Bubble.svelte`）。
 */

/** 气泡多大。★ 和 `.asbub` 在样式表里的尺寸对齐 */
const SIZE = 46

/** 位置存哪 —— `settings`，跟着机器走（哪台电脑摆在哪个角落是这台机器的事） */
const KEY_POS = 'assist.bubblePos'
/** 显示不显示。★ 一个关不掉的置顶物件太霸道，所以给他一个开关（出厂开着） */
const KEY_ON = 'assist.bubbleOn'

let bubble: BrowserWindow | null = null

function read(db: Database | null, key: string): string {
  if (!db) return ''
  try {
    const r = db.prepare(`select value from settings where key = ?`).get(key) as
      | { value: string }
      | undefined
    return r?.value ?? ''
  } catch {
    return ''
  }
}

function put(db: Database, key: string, value: string): void {
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now())
}

/** 他要不要这颗气泡。**读不出来 = 要**（出厂开着，他没表过态就给他） */
export function wanted(db: Database | null): boolean {
  return read(db, KEY_ON) !== '0'
}

export function setWanted(db: Database, on: boolean): void {
  put(db, KEY_ON, on ? '1' : '0')
}

/**
 * 摆在哪。
 * ★ 存下来的坐标**每次都要按当前屏幕夹一遍**：他可能拔了副屏、或者改了缩放，
 *   而一个落在屏幕外的气泡等于没有 —— 而且他没法把它拖回来。
 */
function place(db: Database | null): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  /**
   * ★★★ **`Number('')` 是 `0`，不是 `NaN`**。
   *
   *   第一版这里直接 `Number.isFinite(Number(saved[0]))` 当判据 ——
   *   没存过位置时 `''.split(',')` 给 `['']`，`Number('')` 得到 **0**，
   *   `isFinite(0)` 为真，于是「没存过」被当成了「存的是 0」——
   *   气泡贴在屏幕**最左边**。
   *   ★ 更阴的是两半行为不一致：`saved[1]` 是 `undefined` → `NaN` →
   *     y 反而正确地退回了默认值。只有 x 跑偏，看着像「位置算错了」，
   *     而不像「默认值根本没生效」。量了才看出来。
   *   ★ 所以先看**存的是不是两个数**，再谈值。
   */
  const saved = read(db, KEY_POS).split(',')
  const has = saved.length === 2 && saved.every((t) => t.trim() !== '' && Number.isFinite(Number(t)))
  /** 没存过 → 右下角，离边留一点 —— 那是所有悬浮球的老地方 */
  const x = has ? Number(saved[0]) : area.x + area.width - SIZE - 24
  const y = has ? Number(saved[1]) : area.y + area.height - SIZE - 96
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - SIZE)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - SIZE))
  }
}

function build(preload: string, devUrl: string | undefined, rendererFile: string): BrowserWindow {
  const w = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    /** ★ 要能搬 —— 搬它的是下面那个 `moveBy`，不是系统的标题栏 */
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    /** ★ 不抢焦点：他正在别的程序里打字（契约 §五「不接管」）*/
    focusable: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  /** `screen-saver` 那一档才压得住别的置顶窗口（很多播放器的全屏是）*/
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (devUrl) w.loadURL(devUrl + '?bubble=1')
  else w.loadFile(rendererFile, { query: { bubble: '1' } })

  w.on('closed', () => {
    bubble = null
  })
  return w
}

/**
 * 按当前状态把气泡摆好 / 收掉。**幂等**：状态一变就叫它。
 *
 * @param on Assist 现在开着吗 —— 决定画哪一档（亮 / 暗）
 */
export function syncBubble(
  db: Database | null,
  opts: { preload: string; devUrl?: string; rendererFile: string },
  on: boolean
): void {
  if (!wanted(db)) {
    destroyBubble()
    return
  }
  if (!bubble || bubble.isDestroyed()) {
    bubble = build(opts.preload, opts.devUrl, opts.rendererFile)
    const p = place(db)
    bubble.setBounds({ x: p.x, y: p.y, width: SIZE, height: SIZE })
  }
  const w = bubble
  const send = (): void => w.webContents.send('bubble:state', on)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
  /** ★ `showInactive` 不是 `show` —— 显示但不激活，他还在原来那个程序里 */
  if (!w.isVisible()) w.showInactive()
}

/**
 * ══ 搬窗口为什么不能「读一下再加一点」★★（2026-09-14 实测）══
 *
 * 他报的是**查词卡**：「当我拖着弹窗移动时，弹窗会莫名其妙变大。
 * 移动弹窗 ≠ 改变弹窗大小。」这颗球是**同一份写法**，所以同病，
 * 只是它才 46px、又是圆的，肿一点不容易看出来 —— 一并改了。
 *
 * 一开始我以为是 `setBounds` 带了尺寸回去，换成 `setPosition` 就好。
 * **不是。** 拿一个和悬浮球一样的窗口量了一次（他这台 150% 缩放）：
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
 * 把那颗球搬到「按下时的位置 + 累计位移」。
 *
 * @param dx 从**按下那一刻**算起的累计位移（不是上一帧的增量）
 * @param first 这是按下后的第一步 —— 在这一刻把原点记下来
 */
export function moveBy(dx: number, dy: number, first = false): void {
  const w = bubble
  if (!w || w.isDestroyed()) return
  if (first || !dragFrom) dragFrom = w.getBounds()
  const o = dragFrom
  const area = screen.getDisplayNearestPoint({ x: o.x, y: o.y }).workArea
  const x = Math.min(Math.max(o.x + Math.round(dx), area.x), area.x + area.width - SIZE)
  const y = Math.min(Math.max(o.y + Math.round(dy), area.y), area.y + area.height - SIZE)
  /**
   * ★★ 尺寸用**建窗时那个常数**，不用 `getBounds()` 读回来的那份。
   *   读回来的是「物理像素 ÷ 1.5 向上取整」后的数，再传回去就又乘一遍 ——
   *   实测：传读回值的话第一步就肿 1（421 → 422），传常数则一直是那么大。
   *   他的要求是「移动 ≠ 改变大小」，那就一像素都不能变。
   */
  w.setBounds({ x, y, width: SIZE, height: SIZE })
}

/** 拖完了，把位置记下来。★ 存不进去不抛：下次开软件回默认角落，不是灾难 */
export function remember(db: Database | null): void {
  const w = bubble
  if (!w || w.isDestroyed() || !db) return
  try {
    const b = w.getBounds()
    put(db, KEY_POS, `${b.x},${b.y}`)
  } catch {
    /* 见上 */
  }
}

export function destroyBubble(): void {
  if (bubble && !bubble.isDestroyed()) bubble.destroy()
  bubble = null
}

/** 验收要看得到「现在有没有这颗气泡」 */
export function running(): boolean {
  return bubble !== null && !bubble.isDestroyed()
}
