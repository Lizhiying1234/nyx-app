<script lang="ts">
  /**
   * 浮层菜单的**唯一外壳** —— 遮罩 + 居中窄卡 + 返回注册。
   *
   * ══ 为什么抽出来（D-411 交互审计）════════════════════════════
   * `Menu.svelte`（节点）与 `ItemMenu.svelte`（词条）各写了一遍
   * scrim / `.menu` / `registerBack` / `.mhead` —— **外壳重复，内容不同**。
   * 内容确实不该合并（两种目标的动作集本来就不一样，硬并成一个联合类型
   * 只会更糟），但外壳只该有一份。
   *
   * ★★ 形态是 D-393 使用者亲批的「**居中窄卡**」，不是贴底 Sheet。
   * ★★ 二级动作一律**换脸**，不叠第二层浮层（§10.2 一个面之内不许再出现
   *    第二个面）：手机屏窄，两层叠起来会把内容全挡住，返回也要按两次。
   *    **换内容只有一层，返回永远是一步。**
   * ★ D-227：这个文件里一行样式都没有。
   */
  import { registerBack } from './backstack.svelte.ts'

  let {
    title,
    onclose,
    onback,
    children
  }: {
    /** 标题槽 —— 换脸时由内容自己换（「移到哪个项目」这类） */
    title?: import('svelte').Snippet
    onclose: () => void
    /**
     * 换脸中的返回：返回 `true` = 我自己消费了（二级面退回主面）。
     * 返回 `false`/不传 = 关掉整个菜单。
     * ★ 这就是「换内容只有一层，返回永远是一步」的实现点。
     */
    onback?: () => boolean
    children: import('svelte').Snippet
  } = $props()

  $effect(() =>
    registerBack(() => {
      if (onback?.()) return true
      onclose()
      return true
    })
  )
</script>

<button class="scrim" aria-label="关闭" onclick={onclose}></button>
<div class="menu" role="menu" tabindex="-1">
  {#if title}
    <div class="mhead">{@render title()}</div>
  {/if}
  {@render children()}
</div>
