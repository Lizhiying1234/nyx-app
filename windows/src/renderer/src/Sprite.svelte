<script lang="ts">
  /**
   * 图标 sprite —— **只把 core 那一份几何铺出来，这里一条路径都不画。**
   *
   * ══ 为什么 Windows 也要有它 ★★★ ══════════════════════════
   *
   * D-410 使用者钦定：**「图标系统两端一起重画」（Android + Windows + Nyx 星）**。
   * 在这之前 Windows 根本没有图标系统 —— 用的是**文字当图标**：
   * `›` `‹` `✕` `▾` `⋮` `＋` `✓`，79 处。那些字符
   *
   *   · 每个字体里长得都不一样（`▾` 在 Segoe UI 与 PingFang 下不是一个形状）
   *   · 粗细跟着文字走，压根不受设计控制
   *   · 与 Android 那 32 枚**毫无关系** —— 同一个产品的两个端各说各的
   *
   * ══ 几何在哪 ════════════════════════════════════════════
   *
   * `@core/icons.ts` —— **两端唯一的一份**。Android 经 `core-link.ts` 取同一份。
   * 改几何要先改 DS §四（D-326），不许在这一层动。
   *
   * ★ 这个文件挂在 `App.svelte` 顶层一次即可：它渲染一个 0×0 的隐藏 `<svg>`，
   *   页面各处用 `<svg><use href="#nyx-xxx" /></svg>` 引。
   * ★ 用 `currentColor`：颜色跟着上下文的 `color` 走，不在这里定死。
   */
  import { NYX_ICON_DEFS } from '@core/icons.ts'
</script>

<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- 内容是 core 里的常量，不是用户输入 -->
    {@html NYX_ICON_DEFS}
  </defs>
</svg>
