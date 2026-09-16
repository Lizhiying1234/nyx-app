<script lang="ts">
  /**
   * 选区高亮层（使用者 2026-09-14 第三批）
   *
   * 他的原话：「原本不能被选中的文字，应该变得可以直接选中……使用体验应该
   * 尽量像普通网页 / 普通文本界面一样。」
   *
   * 「像普通网页」里最要紧的一半不是查得准，是**他拖的时候看得见自己拖到哪了**。
   * 这一页就是那个「看得见」——主进程把真实的选区几何推过来，这里把它画成
   * 几块半透明的方块，位置来自 UI Automation 的 `GetBoundingRectangles`，
   * 所以它盖的就是那几个字本身，不是一个大概的框。
   *
   * ══ 这一页什么都不做，只画 ★★ ═════════════════════════════
   * 没有按钮、没有事件、不往回说一句话。整个窗口在主进程那边
   * `setIgnoreMouseEvents(true)` 从建出来就开着 —— 它**不可能**吃掉他的点击。
   * 这一条不是性能考虑：一块全屏的置顶窗口只要吃掉一次点击，屏幕就等于锁住了。
   *
   * ★ 折行的选区有好几个方块（实测：拖过两行 → 两个），所以是一个数组，
   *   不是一个框。画成一个大框会把两行之间的空白也涂上，那不是他选的东西。
   */
  type Rect = { x: number; y: number; w: number; h: number }

  let rects = $state<Rect[]>([])
  $effect(() => window.nyx.marker.onRects((v) => (rects = Array.isArray(v) ? v : [])))
</script>

<div class="mkr" data-testid="marker">
  {#each rects as r, i (i)}
    <div
      class="mkr-b"
      style="left:{r.x}px;top:{r.y}px;width:{r.w}px;height:{r.h}px"
      data-testid="marker-box"></div>
  {/each}
</div>
