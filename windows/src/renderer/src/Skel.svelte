<script lang="ts">
  /**
   * 骨架 —— **全应用不转圈**（ST-Q1 定案 · UI_STATE_MATRIX §2.2）
   *
   * ══ 为什么不是转圈 ═══════════════════════════════════════════
   * 转圈说的是「**等着**」，骨架说的是「**东西会长在这里**」。
   * 后者多给了两件事：位置（好了就地填入，版面不跳）与形状（几行、多宽）。
   *
   * ══ 三条判据 ═════════════════════════════════════════════════
   * ① 骨架占的正是内容**将要**占的位置 —— 所以行数与宽度由调用方按那一屏给。
   * ② 原地轻呼吸（1.6s），**不滚动、不闪、不转**。
   * ③ **< 200ms 的等待什么都不显示** —— 闪一下的骨架比没有更糟。
   *    所以这里自己压 200ms 再现身；库开得快的时候屏幕上是干净的。
   *
   * ★ 说明文字（「正在给『…』准备题目」）不是没有位置，是**退到骨架下方** ——
   *   它是信息不是主角（§2.2 最后一条）。调用方用 `note` 给。
   *
   * ★ 样式全在 `enhancements.css` 的 `.skel*`（D-227）。
   */
  let {
    /** 画几行。列表给 3–5，详情页给内容真正有的那几段 */
    rows = 3,
    /**
     * 每行的宽度档 —— **只有五档**（`w100 / w85 / w70 / w55 / w45`），
     * 因为宽度是**视觉值**，视觉值只能住在样式表里（D-227：组件里一行样式都不写）。
     * 想要别的宽度就去 `enhancements.css` 加一档，不要在这里写 `style=`。
     */
    widths = ['w70', 'w100', 'w45'],
    /** 骨架下方那一行说明；不给就不占位 */
    note,
    testid = 'skel'
  }: { rows?: number; widths?: string[]; note?: string; testid?: string } = $props()

  /** ★ <200ms 什么都不显示（§2.2）—— 闪一下的骨架比没有更糟 */
  let show = $state(false)
  $effect(() => {
    const t = setTimeout(() => (show = true), 200)
    return () => clearTimeout(t)
  })
</script>

{#if show}
  <div class="skel" data-testid={testid} aria-busy="true" aria-live="polite">
    {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
      <i class={widths[i % widths.length]}></i>
    {/each}
    {#if note}<div class="skel-note" data-testid="{testid}-note">{note}</div>{/if}
  </div>
{/if}
