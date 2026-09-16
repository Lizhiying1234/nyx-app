<script lang="ts">
  /**
   * Dialog —— **全 App 唯一那一种打断层**（INTERACTION_RULES §一 · BTN-Q4 · X-09）
   *
   * ══ 它替掉了什么 ═══════════════════════════════════════════
   * Windows 在这之前有**三种删除确认形态**：
   *   ① 不确认（讲次页右键删、库里批量删）
   *   ② 系统 `confirm()`（Workbench 删材料 · FileStudy 删文件）
   *      —— 它长得不是这个软件的脸，而且 Electron 里它会**卡住渲染进程**
   *   ③ 应用内 errbox 拼出来的确认块（Trash 彻底删除）
   * BTN-Q4 定案「Windows 删除也一律先弹确认框，同时把三种收成一种」。就是这一个。
   *
   * ══ 两种形态（总控 2026-09-08 补裁）═══════════════════════════
   *   · **双动作**：`取消` + 一颗确认（破坏性的走 `danger`，Ghost + 粉字不填色）
   *   · **单动作**：只有一颗 Ghost「关闭」（告知 · 空态 · 「知道了」）——
   *     **不再同时出现「取消」**：两颗同义键并排就是把 TM-58 违反了一次
   *
   * ══ 硬规矩 ═══════════════════════════════════════════════
   * · **默认焦点在「取消」**（BUTTON §五 · 交互宪法 §8.2）—— 破坏性动作不该
   *   一个回车就发生。单动作形态没有取消，焦点落在「关闭」上。
   * · Esc / 点遮罩 = 取消（IX-03：点遮罩与点 ✕ 是同一个出口的两种手势）。
   *   Esc 走 `esc-stack`（IX-04 唯一消费点），**不自己装 window 监听**。
   * · 内容区 `max-height: 70vh`（桌面档），头与动作栏钉住、只有内容滚 —— 全局的，
   *   不许各屏自己再加一个局部的 `.dlg-scroll`。
   * · **焦点有来有回**（IX-05）：关掉之后焦点回到打开它的那个元素。
   * · 文案说真话（NOTIFICATION §四）：**软删的确认框不许写「不可撤销」「永久删除」**——
   *   那是假的，而且在吓唬人。要说的是「移到回收站，N 天内可以恢复」——
   *   那句话从 `TRASH_KEEP_TEXT` 来，别在这儿写死天数。
   *
   * ★ 样式全在 `enhancements.css` 的 `.dlg*`（D-227，组件里一行样式都不写）。
   */
  import { registerEsc } from './esc-stack.svelte.ts'
  import type { Snippet } from 'svelte'

  let {
    title,
    body,
    detail,
    confirmLabel = '确定',
    danger = false,
    single = false,
    busy = false,
    testid = 'dialog',
    onconfirm,
    oncancel
  }: {
    /** 标题给**对象名**，不是泛指：「删除『proofrock』？」不是「确认删除？」 */
    title: string
    /** 正文说**真正会发生什么**。一句话，别写两段。 */
    body: string
    /** 可选的第二段（例如「这 12 条会一起进去」）；也可以给一段 snippet 画列表 */
    detail?: Snippet
    confirmLabel?: string
    /** 破坏性 = 确认键走 Ghost + 粉字不填色（BTN-Q3，不填色是为了不羞辱 D-322）*/
    danger?: boolean
    /** 单动作形态：只有一颗 Ghost「关闭」*/
    single?: boolean
    /** 确认键在忙（钉宽换文案由调用方给，这里只负责禁用两颗键）*/
    busy?: boolean
    testid?: string
    onconfirm?: () => void
    oncancel: () => void
  } = $props()

  /** 打开它的那个元素 —— 关掉之后焦点要回去（IX-05）*/
  const opener = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  let cancelBtn = $state<HTMLButtonElement | null>(null)

  $effect(() => {
    cancelBtn?.focus()
    const off = registerEsc(() => {
      oncancel()
      return true
    })
    return () => {
      off()
      // 关掉之后把焦点还回去；元素可能已经随着删除消失了，那就不勉强
      if (opener?.isConnected) opener.focus()
    }
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="mo on"
  data-testid="{testid}-scrim"
  onclick={(e) => {
    if (e.target === e.currentTarget && !busy) oncancel()
  }}
>
  <div class="mbox dlg" role="dialog" aria-modal="true" aria-label={title} data-testid={testid}>
    <h3 class="dlg-h" data-testid="{testid}-title">{title}</h3>
    <div class="dlg-body">
      <p class="ms" data-testid="{testid}-body">{body}</p>
      {#if detail}{@render detail()}{/if}
    </div>
    <div class="mact dlg-acts">
      {#if single}
        <button class="btn ghost" bind:this={cancelBtn} data-testid="{testid}-close" onclick={oncancel}
          >关闭</button
        >
      {:else}
        <button
          class="btn ghost"
          bind:this={cancelBtn}
          disabled={busy}
          data-testid="{testid}-cancel"
          onclick={oncancel}>取消</button
        >
        <button
          class="btn"
          class:dgr={danger}
          class:pri={!danger}
          disabled={busy}
          data-testid="{testid}-confirm"
          onclick={() => onconfirm?.()}>{confirmLabel}</button
        >
      {/if}
    </div>
  </div>
</div>
