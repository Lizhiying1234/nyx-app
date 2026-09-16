/**
 * 回执条 —— **Windows 一直缺的那一个载体**（NT-Q1 / NT-Q5 / BTN-Q5，2026-09-07 定案）
 *
 * ══ 它管什么 ═══════════════════════════════════════════════
 * NOTIFICATION_RULES §二 的分级判据走到最后一格：
 * 「一次性 · 不跟某个控件绑着」→ **回执条**。
 * 也就是「做成了一件事，他不需要为此做什么」。
 *
 * 它**不**管：
 *   · 跟某个控件绑着的话  → Inline（就地一行，改对了自己消失）
 *   · 一直存在直到他处理  → Banner / Badge
 *   · 不看就会做错事      → Dialog
 *
 * ══ 三条硬规矩（都在判据里） ═════════════════════════════════
 * ① **4 秒；带撤销 6 秒**（NT-Q5）。太短来不及撤销，太长挡住底部内容。
 * ② **同一时刻只有一个**（IX-02）：第二个来了**替换**，不排队堆叠。
 * ③ **失败的那种不自动消失**（UI_STATE_MATRIX §三 Toast 行）——
 *    它要么被他关掉，要么被下一条替换。「没看见就没了」对失败是不可接受的。
 *
 * ══ 文案 ═══════════════════════════════════════════════════
 * **说真实结果，不说「成功」**（D-400 / NOTIFICATION §四）：
 *   ✗「保存成功」   ✓「存到 计划 › Unit 3 › Lecture 04」
 *   ✗「删除成功」   ✓「删掉了『proofrock』，N 天内可以恢复」（N 从 `TRASH_KEEP_TEXT` 来）
 *
 * ══ 撤销 ═══════════════════════════════════════════════════
 * 删除三层保护里的第二层（D-359 / D-412）：确认框防误点 · **撤销条防手快** ·
 * 回收站保留期防隔日反悔。撤销点下去要**当场把东西拿回来**，
 * 不是「记下来待会儿再说」—— 所以 `undo` 是个真的异步动作，失败要说话。
 *
 * ★ 不做通知中心（NOTIFICATION §五）：攒消息的收件箱等于催促的仓库。
 */

export type ToastKind = 'ok' | 'bad'

export interface ToastView {
  /** 每次都换一个，界面靠它知道「这是新的一条」（重播同样的文字也要重新计时）*/
  id: number
  text: string
  kind: ToastKind
  /** 有它就多两秒，并且长出一颗「撤销」*/
  undo?: () => void | Promise<void>
  /** 撤销做完之后说的那句话（不给就用默认）*/
  undoneText?: string
}

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** 当前这一条 —— 全 App 只有一条（IX-02）*/
export const toast = $state<{ cur: ToastView | null }>({ cur: null })

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** 关掉当前这条（点 ✕、撤销完、或者被下一条替换）*/
export function dismiss(): void {
  clearTimer()
  toast.cur = null
}

function show(v: Omit<ToastView, 'id'>, ms: number): void {
  clearTimer()
  toast.cur = { ...v, id: ++seq }
  if (ms > 0) {
    const mine = toast.cur.id
    timer = setTimeout(() => {
      // 只关自己 —— 中途被替换过就别把新的那条误伤了
      if (toast.cur?.id === mine) dismiss()
    }, ms)
  }
}

/** 做成了一件事。**说真实结果**，别说「成功」。4 秒。 */
export function say(text: string): void {
  show({ text, kind: 'ok' }, 4000)
}

/**
 * 做成了一件事，而且**还能反悔**。6 秒（NT-Q5）。
 * `undo` 要真的把东西放回去；它自己抛错的话这里会改说那一句失败的话。
 */
export function sayUndo(text: string, undo: () => void | Promise<void>, undoneText?: string): void {
  show({ text, kind: 'ok', undo, undoneText }, 6000)
}

/** 没做成。**不自动消失** —— 失败不能「没看见就没了」。 */
export function sayBad(text: string): void {
  show({ text, kind: 'bad' }, 0)
}

/** 界面点了「撤销」之后走这里：做事 → 换一句回执 → 失败就说人话 */
export async function runUndo(): Promise<void> {
  const cur = toast.cur
  if (!cur?.undo) return
  /**
   * ★ 撤销的默认回执。原来写的是「放回去了」—— 那是**静默那一路的动作词**
   *   （D-489 已退役），而这里是**所有撤销**的兜底：撤销一次删除、一次改名，
   *   屏上都会冒出一句「放回去了」，说的不是这件事。
   * ☞ 换成与动作无关的一句；真要说具体做了什么，调用方给 `undoneText`。
   */
  const done = cur.undoneText ?? '已撤销'
  try {
    await cur.undo()
    say(done)
  } catch (err) {
    sayBad(`撤销没成：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 只给测试用 —— 断言「现在屏幕上是哪一条」 */
export function peek(): ToastView | null {
  return toast.cur
}
