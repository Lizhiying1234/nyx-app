<script lang="ts">
  /**
   * Snackbar（D-379 P1 载体 · DS v4.4）—— 6s 自散；有 undo 就给「撤销」。
   *
   * ★ 状态在 `snack.svelte.ts`（全应用唯一），本组件**只负责画**。
   *   在 `App.svelte` 里挂一次就够了 —— 页面切换/卸载都不影响它，
   *   这正是「详情页删完退回上一级、撤销还在」能成立的原因。
   */
  import { snacks } from './snack.svelte.ts'
</script>

{#if snacks.cur}
  <div class="snack" role="status">
    <span class="zh">{snacks.cur.msg}</span>
    {#if snacks.cur.undo}
      <!-- ★ 先取后关（2026-08-30 真机修）：close() 之后再读 undo 就是读 null 的属性 -->
      {@const fn = snacks.cur.undo}
      <button
        class="u"
        onclick={() => {
          snacks.close()
          void Promise.resolve(fn()).catch((e) => {
            ;(globalThis as Record<string, unknown>)['__lastErr2'] = (e as Error)?.stack ?? String(e)
          })
        }}>撤销</button
      >
    {/if}
  </div>
{/if}
