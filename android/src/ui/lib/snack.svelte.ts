/**
 * 全应用**唯一**的 Snackbar 状态。
 *
 * ══ 为什么要有它（第十九则指令 · 2026-09-01）════════════════
 * 清点之前，这个仓库里有 **七份** Snackbar：
 *   `Snack.svelte` 组件（Atlas / Lecture / Detail 各挂一份状态）
 *   + VaultItems / VaultHard / VaultTrash / VaultSilent 各自手写的一份
 *     `<div class="snack">` —— 连 6 秒计时器都各写各的。
 * 同一件事七份判据，正是本仓库最贵的事故形态。
 *
 * ★★ 更要紧的是它**修好了删除链路的最后一步**：
 *   详情页删掉一条之后必须退回上一级，而挂在详情页上的 Snackbar
 *   会跟着页面一起卸载 —— 「撤销」按钮连同它一起消失。
 *   状态提到应用层，页面走了话还在。
 *
 * ★ `undo` 先取后关：props/闭包读的是 getter，清空状态之后再读就是 null。
 */

interface SnackState {
  msg: string
  undo: (() => void | Promise<void>) | null
}

class Snacks {
  cur = $state<SnackState | null>(null)
  private timer: ReturnType<typeof setTimeout> | null = null

  /**
   * 说一句话；给了 undo 就带「撤销」。
   *
   * ★ 两档时长（NT-Q5 定案）：**普通 4 秒 · 带撤销 6 秒**。
   *   此前一律 6 秒。差别不是审美：带「撤销」的那一条是**要他做决定**的，
   *   4 秒不够看完再伸手；不带撤销的只是回执，6 秒白挡着底部内容那么久。
   */
  show(msg: string, undo?: (() => void | Promise<void>) | null): void {
    if (this.timer !== null) clearTimeout(this.timer)
    const u = undo ?? null
    this.cur = { msg, undo: u }
    this.timer = setTimeout(() => this.close(), u === null ? 4000 : 6000)
  }

  close(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.cur = null
  }
}

export const snacks = new Snacks()
