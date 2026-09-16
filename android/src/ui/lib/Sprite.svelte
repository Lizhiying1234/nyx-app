<script lang="ts">
  /**
   * 图标 sprite —— **只把 core 那一份几何铺出来，这里一条路径都不画。**
   *
   * ══ 几何在哪 ★★★ ═══════════════════════════════════════════
   *
   * `core/icons.ts`（经 `core-link.ts`）。D-410 使用者钦定
   * **「图标系统两端一起重画」（Android + Windows + Nyx 星）** ——
   * 「一起」不能靠纪律，所以几何只有一份，两端各自铺。
   *
   * ★ 2026-09-01 上提之前，这 32 枚只长在这个文件里，Windows 那边
   *   压根没有 sprite（用的是 `›` `×` `▾` `⋮` 这些**文字当图标**，93 处）。
   *   上提是逐字节搬的，Android 这一侧渲染结果一个像素都没变。
   *
   * ══ 三条硬规则（DS §4.2，改几何前先看）════════════════════
   *   ① 空心与实心**共用同一条核路径**（#nyx-core / #nyx-core-o）——
   *      「轮廓不变」是几何保证，不是眼力保证（D-357 真机结论）。
   *   ② **芒不与核相连。** 间隙是这个符号的全部识别点，任何情况下不许连上。
   *   ③ **16px 掉芒留核** —— 靠使用者记得一定会漏，所以给一枚显式的 `nyx-star-16`。
   *
   * ★ 真机走查已过（§4.4b · PJE110 · 32/24/18/16px 实尺）。
   * ★ 想看它们长什么样：Settings › ABOUT **连点五下构建指纹**（32 枚 × 四档实尺）。
   * ★ D-227：这个文件里一行样式都没有。
   */
  import { NYX_ICON_DEFS } from '../../core-link.ts'
</script>

<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- 内容是 core 里的常量，不是用户输入 -->
    {@html NYX_ICON_DEFS}
  </defs>
</svg>
