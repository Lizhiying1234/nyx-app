import { cleanMessage } from '@shared/api.ts'

/**
 * 渲染层的错误兜底 · H-4a
 *
 * ── 病是什么（实测，不是推断）──────────────────────────────
 *
 * 扫描前测过一次真实的 IPC 拒绝：
 *
 *   全局 handler：onerror=null · onunhandledrejection=null
 *   一次 IPC 拒绝之后：页面文字长度 451 → 451（差 0）
 *   界面上有没有 errbox：0 个
 *   控制台收到 1 条：pageerror: 找不到这个 lecture（id=999999）
 *
 * **屏幕上零变化。** 唯一的痕迹落在 `nyx.log` 里 —— 而他不看日志，
 * 也不知道日志在哪。这就是「按钮点下去什么都没发生」的全部真相。
 *
 * ── 这一层要做的和不做的 ──────────────────────────────────
 *
 * 做：**任何漏网的错误，从「什么都看不到」变成「屏幕上有一句话」**。
 * 不做：替各个 handler 把错误处理好 —— 那是 H-4b 的事，
 * 而且它得由 H-4c 那道闸驱动，逐处收口。这一层是最后一道网，不是替代品。
 *
 * ── 为什么不用 `.svelte.ts` 里的 `$state` ─────────────────
 *
 * 这个模块要被 `main.ts` 在 `mount()` **之前**装上（首屏渲染就可能炸），
 * 那时候还没有任何组件。所以状态放在普通模块里，用订阅把它送进组件 ——
 * 组件挂上了就显示，没挂上也照样收得住，不依赖 Svelte 活着。
 */

export interface AppError {
  id: number
  /** 哪儿出的事，用他看得懂的说法 */
  where: string
  /** 人话（已过 cleanMessage） */
  message: string
  at: number
}

type Listener = (list: AppError[]) => void

let seq = 0
let list: AppError[] = []
const listeners = new Set<Listener>()

/** 屏幕上最多同时挂几条 —— 再多也没人看，只会盖住内容 */
const MAX = 3

function emit(): void {
  for (const l of listeners) l(list)
}

/**
 * 订阅错误列表。返回退订函数。
 * 组件挂载时订阅、卸载时退订；模块自己不认识 Svelte。
 */
export function onErrors(cb: Listener): () => void {
  listeners.add(cb)
  cb(list)
  return () => listeners.delete(cb)
}

/**
 * 报一个错。
 *
 * **同一条不重复堆**：同样的位置 + 同样的话，只留最新那一条并把时间刷新 ——
 * 否则一个循环里的失败会瞬间铺满屏幕，反而看不见真正的第一条。
 */
export function reportError(err: unknown, where: string): AppError {
  const message = cleanMessage(err)
  const at = Date.now()
  const same = list.find((e) => e.where === where && e.message === message)
  if (same) {
    list = [...list.filter((e) => e !== same), { ...same, at }]
  } else {
    list = [...list, { id: ++seq, where, message, at }]
  }
  if (list.length > MAX) list = list.slice(list.length - MAX)
  emit()
  // 日志那一路照旧：主进程的 console-message 钩子会把它记进 nyx.log（D-219）
  console.error(`[nyx] ${where}：${message}`)
  return list[list.length - 1]!
}

export function dismissError(id: number): void {
  list = list.filter((e) => e.id !== id)
  emit()
}

export function clearErrors(): void {
  if (list.length === 0) return
  list = []
  emit()
}

/** 只给测试用：读当前列表，不订阅 */
export function currentErrors(): AppError[] {
  return list
}

/**
 * 装上两个全局钩子。
 *
 * 在 `mount()` **之前**调用 —— 首屏渲染就可能抛，装晚了那一次就漏了。
 *
 * `unhandledrejection` 是这一轮的主角：那 20 处没有 try 的 IPC 调用，
 * 失败之后走的就是这条路。以前这条路的终点是控制台，现在是屏幕。
 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('unhandledrejection', (e) => {
    reportError(e.reason, '有一步没做成')
  })
  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script）也会走 error 事件，但它没有 error 对象
    if (!e.error) return
    reportError(e.error, '界面出错了')
  })
}

/**
 * 首屏挂不起来时的最后一页 · **纯 DOM，不用 Svelte**。
 *
 * `mount()` 失败意味着 Svelte 这条路已经走不通了，
 * 所以这一页只能手搓节点。它必须回答两件事：
 *   ① 他现在能做什么 —— 打开日志文件夹、重开软件
 *   ② 我怎么知道他跑的是哪一份 —— 构建号（「我改的那份 vs 他运行的那份」，第九节 9.3）
 *
 * 样式全部复用 `enhancements.css` 里已有的 `.errbox` / `.btn`，
 * 只多一个 `.nyx-fatal` 做居中容器（写在 enhancements.css，用令牌，不改已有规则）。
 */
export function renderFatalPage(root: HTMLElement, err: unknown, where: string): void {
  const box = document.createElement('div')
  box.className = 'nyx-fatal'
  box.setAttribute('data-testid', 'fatal-page')

  const card = document.createElement('div')
  card.className = 'errbox'

  const h = document.createElement('div')
  h.className = 'h'
  h.textContent = 'Nyx 界面没能启动'
  card.appendChild(h)

  const msg = document.createElement('div')
  msg.textContent = `${where}：${cleanMessage(err)}`
  card.appendChild(msg)

  const hint = document.createElement('div')
  hint.style.marginTop = '10px'
  hint.textContent = '你的数据没有动。把下面这段连同日志发给 Claude Code，它能看出问题在哪。'
  card.appendChild(hint)

  const build = document.createElement('div')
  build.className = 'dim'
  build.style.marginTop = '10px'
  build.setAttribute('data-testid', 'fatal-build')
  build.textContent = '构建号：读取中…'
  card.appendChild(build)

  const bar = document.createElement('div')
  bar.style.marginTop = '14px'
  bar.style.display = 'flex'
  bar.style.gap = '8px'

  const logs = document.createElement('button')
  logs.className = 'btn sm'
  logs.setAttribute('data-testid', 'fatal-logs')
  logs.textContent = '打开日志文件夹'
  logs.onclick = () => {
    // 这一颗自己也可能失败（比如 preload 没起来）—— 失败就把话写在按钮旁边，
    // 不能再抛一次，否则错误页自己又炸了
    try {
      void window.nyx?.store?.openFolder('logs')
    } catch {
      logs.textContent = '打不开 —— 日志在数据文件夹的 logs 里'
    }
  }
  bar.appendChild(logs)

  const again = document.createElement('button')
  again.className = 'btn sm'
  again.setAttribute('data-testid', 'fatal-reload')
  again.textContent = '重新加载'
  again.onclick = () => location.reload()
  bar.appendChild(again)

  card.appendChild(bar)
  box.appendChild(card)
  root.innerHTML = ''
  root.appendChild(box)

  // 构建号异步补上 —— 取不到也不影响这一页显示（它不能依赖任何东西活着）
  void (async () => {
    try {
      const b = await window.nyx.app.buildInfo()
      build.textContent = `构建号：${b.commit}${b.dirty ? '+改动未提交' : ''} · ${b.builtAt}`
    } catch {
      build.textContent = '构建号：取不到（设置 → 数据 → 自检里也看得到）'
    }
  })()
}
