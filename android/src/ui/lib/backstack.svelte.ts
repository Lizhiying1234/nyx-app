/**
 * 全局返回栈 —— Android 系统返回（侧滑/返回键）的**唯一**消费点。
 *
 * ══ 为什么要有它（2026-08-29 质量审计的根因 ①）══════════════
 * 之前导航状态散在各组件里（Atlas 自持栈、菜单自持开关），系统返回
 * 没人接 —— 侧滑一下直接回桌面。修单页没用：**返回是横切关注点**，
 * 必须一个栈说了算。
 *
 * ══ 消费顺序（Android 直觉）════════════════════════════════
 *   ① 最上层的浮层（Dialog / 菜单）先关
 *   ② 页面栈逐级弹（详情 → 讲次 → 树）
 *   ③ 不在 Atlas 的 Tab → 回 Atlas
 *   ④ Atlas 根 → 退出应用
 *
 * 用法：任何「返回应该先关我」的东西，在挂载时 `registerBack(fn)`，
 * 销毁时调用返回的清理函数（$effect 的 teardown 正好）。
 * fn 返回 true = 消费了这次返回。
 */
type BackHandler = () => boolean

const stack: BackHandler[] = []

/** 兜底（③④）：由 App.svelte 注入 —— Tab 逻辑住在壳里，这里不认识 Tab */
let fallback: () => void = () => {}

export function registerBack(fn: BackHandler): () => void {
  stack.push(fn)
  return () => {
    const i = stack.lastIndexOf(fn)
    if (i >= 0) stack.splice(i, 1)
  }
}

export function setBackFallback(fn: () => void): void {
  fallback = fn
}

/** 系统返回到达 —— 从栈顶往下找第一个愿意消费的 */
export function handleBack(): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!()) return
  }
  fallback()
}
