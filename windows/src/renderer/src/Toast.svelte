<script lang="ts">
  /**
   * 回执条的壳 —— 全 App 挂**一个**（App.svelte 里，浮层之上）。
   *
   * ★ 它不夺焦点（INTERACTION_RULES §一 Toast 行）：他正在打字的时候
   *   蹦出来一条回执，焦点被抢走会让下一个字打丢。
   * ★ 它**不消费 Esc**：它会自己走，Esc 该留给真的浮层（IX-04 一次只关一层）。
   * ★ 样式全在 `enhancements.css` 的 `.toast`（D-227）。
   */
  import { toast, dismiss, runUndo } from './toast.svelte.ts'
  import Ic from './Ic.svelte'
</script>

{#if toast.cur}
  {#key toast.cur.id}
    <div
      class="toast"
      class:bad={toast.cur.kind === 'bad'}
      role="status"
      aria-live="polite"
      data-testid="toast"
    >
      <span class="tx" data-testid="toast-text">{toast.cur.text}</span>
      {#if toast.cur.undo}
        <button class="undo" data-testid="toast-undo" onclick={runUndo}>撤销</button>
      {/if}
      <button class="x" title="关掉" aria-label="关掉这条回执" data-testid="toast-close" onclick={dismiss}>
        <Ic n="close" s={18} />
      </button>
    </div>
  {/key}
{/if}
