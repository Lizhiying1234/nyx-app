<script lang="ts">
  /**
   * 一枚 Nyx 图标 · D-410（2026-09-01）
   *
   * 几何在 `@core/icons.ts`（两端唯一一份），由 `Sprite.svelte` 铺成隐藏 `<defs>`；
   * 这里只是个 `<use>` 的壳，**没有几何、没有颜色**。
   *
   * ★ 名字不带 `nyx-` 前缀：`<Ic n="caret" />`。
   * ★ 颜色走 `currentColor` —— 跟着放它的地方走。想变色就改父元素的 `color`。
   * ★ 显示尺寸 · DS-Q8 定案（2026-09-07）：**行内 / 侧栏 16 · caret 12 · 图标钮里 18**。
   *   默认 `s` 就是行内那一档 16 —— 不写 `s` 也是对的。
   *   （在这之前默认 13 / caret 9，是全软件最容易被说「看不清」的一处。）
   * ★ `r` = 转向：`dn` 向下（原来的 `▾`）· `up` 向上（原来的 `▴`）。
   *   **同一枚 caret 转 90°，不另画一枚**（与折叠头同一个转法，DS §4.4 家族语法）。
   * ★ D-227 那条在 Windows 也照办：样式在 `global.css` 的 `.nic`，这里不写。
   */
  let {
    n,
    s = 16,
    r
  }: { n: string; s?: number; r?: 'dn' | 'up' } = $props()
</script>

<svg class="nic {r ?? ''}" width={s} height={s} viewBox="0 0 24 24" aria-hidden="true"
  ><use href="#nyx-{n}" /></svg
>
