import '../styles/fonts.css'
import '../styles/tokens.css'
import '../styles/global.css'
import '../styles/enhancements.css'
import '../styles/kit.css'

import { mount } from 'svelte'
import App from './App.svelte'
import Overlay from './Overlay.svelte'
import Bubble from './Bubble.svelte'
import Marker from './Marker.svelte'
import { installGlobalErrorHandlers, renderFatalPage } from './errors.ts'
import { paint } from './colors.ts'

/**
 * 把传给主进程的参数统一「拍平」。
 *
 * **背景（栽过两次）**：Svelte 5 的 `$state` 是 Proxy，而 **contextBridge 跨隔离世界时
 * 会结构化克隆参数** —— Proxy 克隆不了，抛 `An object could not be cloned.`。
 * 两个特别坑的地方：
 *   ① 这个错**不带 IPC 通道名**，因为它压根没走到 IPC，光看报错定位不了；
 *   ② 在 preload 里转换**没用**，值根本到不了那儿。
 *
 * 靠「每个调用点记得展开」是守不住的：只要有一处忘了就复发，
 * 而且下次复发时又要从头查一遍。所以在**唯一的入口**上包一层。
 */
function plain<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function harden(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') {
      const fn = v as (...a: unknown[]) => unknown
      out[k] = (...args: unknown[]) => fn(...args.map(plain))
    } else if (v && typeof v === 'object') {
      out[k] = harden(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

try {
  Object.defineProperty(window, 'nyx', {
    value: harden(window.nyx as unknown as Record<string, unknown>),
    configurable: true,
    writable: false
  })
} catch {
  // 定义不了就算了 —— 各调用点仍然自己展开过一遍，这一层是保险，不是唯一防线
}

/**
 * ★ H-4a · 兜底要在 `mount()` **之前**装上。
 *
 * 首屏渲染本身就可能抛 —— 装晚了，恰恰是最该被接住的那一次漏掉。
 */
installGlobalErrorHandlers()

/**
 * ★★ 配色要在 `mount()` **之前**涂上去（使用者 2026-09-13 的颜色模式）。
 *
 * 晚一帧的代价是他每次开软件都看到出厂色**闪一下**再变成自己那套 ——
 * 时间很短，但那正是「这软件没做完」的观感来源。
 * 窗口那一帧的底色由主进程自己去库里问（`main/colors.ts::windowBg`），
 * 这一句管的是**界面**这一层。
 *
 * ★ 读不出来就按出厂那套走：**配色是可选的，界面不是** ——
 *   这一句绝不许拦住首屏。
 */
try {
  const c = await window.nyx.res.colorModes()
  paint(c.overrides)
} catch {
  /* 读不到 = 出厂那套。不打断首屏 */
}

/**
 * ★ H-4a · `mount()` 外面必须有一层。
 *
 * 以前这里是裸的一行。首屏一抛异常，`#app` 就是空的 —— **白屏**，
 * 没有一句话、没有下一步，他唯一能做的是关掉重开，而重开还是白屏。
 * 现在退化成一页人话：说清出了什么事、构建号是多少、日志在哪儿。
 */
const target = document.getElementById('app')

/**
 * ★★ 置顶浮窗那一页（使用者 2026-09-13 · Glance / Frame）。
 *
 * 同一个包、同一份样式，靠 `?overlay=1` 分流到另一个根组件。
 * **为什么不另做一个入口文件**：那样字体、令牌、样式表就有了第二份装配顺序，
 * 而颜色模式、字号这些东西全靠那个顺序 —— 两份迟早会漂。
 * 分流一行就够，剩下的一模一样。
 */
const q = new URLSearchParams(location.search)

/**
 * ★★★ 透明窗口那两个：body **不能上底色**（使用者 2026-09-14 第三条）。
 *
 * 浮窗与框选面都是 `transparent: true` 的 BrowserWindow，而它们
 * **用的是同一份 `index.html` 与同一堆样式表** —— 分流只在下面换了个根组件。
 * `global.css` 第 9 行给 body 铺的 `--color-bg` 于是把两个窗口都浇成了实心的：
 *   浮窗   → 420×520 一块实心方块，卡坐在里面 = 「大弹窗里套了个小弹窗」
 *   框选面 → 整块屏幕被不透明地盖住 = 「什么都看不见」
 * 两句抱怨是同一个病根。规则在 `enhancements.css` 的 `body.bare`。
 *
 * ★ 必须在 `mount()` **之前**加 —— 和上面那句涂配色同一个道理：
 *   晚一帧就是在别人的屏幕上闪一块灰方块。
 */
const bare = q.get('overlay') === '1' || q.get('bubble') === '1' || q.get('marker') === '1'
if (bare) document.body.classList.add('bare')

if (target && q.get('marker') === '1') {
  /**
   * Point 的选区高亮层（使用者 2026-09-14 第三批）。
   * ★ 全屏、穿透、只画方块 —— 它不可能遮住他，也不可能吃掉他一次点击。
   */
  try {
    mount(Marker, { target })
  } catch (err) {
    renderFatalPage(target, err, '选区高亮层首次渲染')
  }
} else if (target && q.get('bubble') === '1') {
  /**
   * 桌面上那颗悬浮的 Assist 小球（使用者 2026-09-14 晚）。
   * 和浮窗同一个道理：同一个包、同一份样式表，换个根组件。
   */
  try {
    mount(Bubble, { target })
  } catch (err) {
    renderFatalPage(target, err, '悬浮图标首次渲染')
  }
} else if (target && q.get('overlay') === '1') {
  try {
    mount(Overlay, { target })
  } catch (err) {
    renderFatalPage(target, err, '浮窗首次渲染')
  }
} else if (target) {
  /**
   * ★ H-4-3 · 验收用的注入点。主进程只在**没打包**且 `NYX_FAULT_MOUNT=1` 时
   * 才会带上这个 query（见 index.ts），所以打包产物里它永远不成立。
   * 给 `mount` 一个不存在的挂载点，让它**真的抛**，而不是我们自己 throw 一个假的。
   */
  const faultMount = new URLSearchParams(location.search).get('faultMount') === '1'
  try {
    mount(App, { target: faultMount ? (null as unknown as HTMLElement) : target })
  } catch (err) {
    renderFatalPage(target, err, '界面首次渲染')
  }
}
