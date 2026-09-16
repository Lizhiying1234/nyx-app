<script lang="ts">
  /**
   * 星粒子 —— **品牌能量，不是图标**（DS §9.2 · DS-Q12 定案）
   *
   * 参考图里它是**散落的光点**。规格是死的，照抄：
   *   尺寸    **只有两级**：主星 12 · 粒星 7。第三种尺寸不许出现
   *   颜色    主色或粉，**透明度 30–45%** —— 第二眼才看见
   *   位置    白名单五处：① 大标题旁 ② 卡的一个角（只一个角）③ 空态 ④ 页脚 ⑤ 启动页
   *   密度    **一屏 ≤3 粒**（Assist 星不计）
   *   不许    不放按钮上 · 不放行里 · **不动**（不闪不转）· **不遮字**（D-409 的教训）
   *
   * ★ 一个组件出两粒（12 + 7）就是一处「散落」。同一屏最多再放一处。
   * ★ 样式在 `enhancements.css` 的 `.stars`（D-227）。
   */
  import Ic from './Ic.svelte'

  let { tone = 'primary' }: { tone?: 'primary' | 'accent' } = $props()
</script>

<span class="stars" class:accent={tone === 'accent'} aria-hidden="true" data-testid="stars">
  <i class="s1"><Ic n="star-16" s={12} /></i>
  <i class="s2"><Ic n="star-16" s={7} /></i>
</span>
