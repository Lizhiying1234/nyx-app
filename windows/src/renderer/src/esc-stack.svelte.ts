/**
 * 浮层关闭栈 —— **Esc 的唯一消费点**（D-440 · 2026-09-02）
 *
 * ══ 为什么要有它 ═══════════════════════════════════════════
 * D-440 第三条：「**一套返回逻辑不许两套**」。
 * 页面级返回这一半 09-02 已经收敛成来路栈（`App.svelte` 的 `go/enter/goBack`），
 * 但**关浮层**那一半当时没做 —— Esc 散在七个地方各管各的：
 *
 *   App.svelte（只管 menu / testDlg）· Reading · Search · DictCard
 *   ＋ PathPicker / Capture / Workbench 三处**元素级**（那三处是对的，见下）
 *
 * 后果是同一处挂载的两个浮层行为不一样：**认读（Reading）能 Esc 关，
 * 产出（Practice）不能**；他点名的 AI 分析结果（AnalyzePanel）也没有 Esc，
 * 只能点遮罩或「取消」。桌面端没有系统返回键，**Esc 就是它的等价物**。
 *
 * ══ 语义直接照搬 Android 的 `backstack.svelte.ts` ═══════════
 * 那一份是**验过的**（系统返回的唯一消费点）。这里是同一条规则换个触发源：
 *
 *   ① 从栈顶往下找第一个愿意消费的 —— **最上层的浮层先关**
 *   ② 消费了就停（返回 true）；一次 Esc 只关一层
 *   ③ 没人消费 = 什么都不做（Esc 在桌面端不承担导航，导航是来路栈的事）
 *
 * ★ 用法：挂载时 `registerEsc(fn)`，销毁时调用它返回的清理函数
 *   （`$effect` 的 teardown 正好）。**新加浮层不写这一句就没有 Esc**，
 *   而这正是我们要的：忘了会被 `smoke:esc` 当场抓到，不是静默地少一个行为。
 *
 * ★ **元素级的 Esc 不进这个栈**（PathPicker 的新建输入框 · Capture 的右键菜单 ·
 *   Workbench 的改名框）：它们只在自己拿到焦点时才响应，语义是「取消我这一次输入」，
 *   不是「关掉一层浮层」。混进来反而会让 Esc 关错东西。
 */
type EscHandler = () => boolean

const stack: EscHandler[] = []

export function registerEsc(fn: EscHandler): () => void {
  stack.push(fn)
  return () => {
    const i = stack.lastIndexOf(fn)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** Esc 到达 —— 从栈顶往下找第一个愿意消费的。返回是否被消费（给测试看） */
export function handleEsc(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!()) return true
  }
  return false
}

/** 只给测试用 —— 断言「没有谁忘了注销自己」 */
export function escDepth(): number {
  return stack.length
}
