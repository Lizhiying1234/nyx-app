<script lang="ts">
  /**
   * Dropdown —— 浮层家族第四型（DS v5 §10.2b · 2026-09-01 补）。
   *
   * ══ 为什么要有它 ══════════════════════════════════════════
   * 交互层级审计（第二十则指令）查出来：DS 只定了三型
   * （Dialog 居中 · ⋮ 菜单居中窄卡 · Sheet 贴底），**没有 Dropdown**。
   * 于是 Vault 的「排序 ▾」「来源 ▾」只能借 ⋮ 菜单的壳 ——
   * **点一个下拉，弹出来的是屏幕正中一张卡**。这是形式用错，不是没做好看。
   *
   * ══ 与 Menu 的分界（唯一判据）══════════════════════════════
   *   改的是「这一屏在看什么」  → Dropdown（排序 / 来源 / 换本词典）
   *   对某个对象做一件事        → Menu（⋮ 里的静默 / 删除 / 改名）
   *
   * ══ 形态硬约束（§10.2b）════════════════════════════════════
   *   · 左边缘对齐触发控件，向下展开；下方不够就向上
   *   · 捕获层**透明** —— 它不打断视线，只是换个值（Menu 才压暗）
   *   · 面 = --paper + 发丝边 + 极轻的影；**触发控件保持 on 态**
   *   · 不嵌套：它已经是第二层面（§10.2 两层规则）
   *
   * ★ D-227：这个文件里**一行样式都没有**，全在 mobile.css。
   * ★ 定位用 getBoundingClientRect 现算 —— 触发控件在筛选行里会横向滚动，
   *   写死偏移量在滚动之后就对不上了。
   */
  import type { Snippet } from 'svelte'
  import { registerBack } from './backstack.svelte.ts'

  let {
    anchor,
    onclose,
    children
  }: {
    /** 触发它的那个控件 —— 位置与宽度都从它现算 */
    anchor: HTMLElement
    onclose: () => void
    children: Snippet
  } = $props()

  let el = $state<HTMLDivElement | null>(null)
  let box = $state<{ left: number; top: number; minW: number; up: boolean } | null>(null)

  /** 现算一次位置（打开时 + 尺寸定了之后各算一次） */
  function place(): void {
    const a = anchor.getBoundingClientRect()
    const h = el?.offsetHeight ?? 0
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 下面放不下就翻上去（留 12px 余量）
    const up = a.bottom + h + 12 > vh && a.top - h - 12 > 0
    // 左对齐触发控件，但不许顶出屏幕
    const w = Math.min(Math.max(a.width, el?.offsetWidth ?? 0), vw - 32)
    const left = Math.max(12, Math.min(a.left, vw - w - 12))
    box = { left, top: up ? a.top - h - 6 : a.bottom + 6, minW: a.width, up }
  }

  $effect(() => {
    place()
    // 尺寸测出来之后再摆一次（第一次 offsetHeight 还是 0）
    const r = requestAnimationFrame(place)
    return () => cancelAnimationFrame(r)
  })

  /** 返回键先关下拉（D-393 返回链：浮层永远排在页面栈前面） */
  $effect(() => registerBack(() => (onclose(), true)))
</script>

<!-- 透明捕获层：接住外面的点，但**不压暗背景** —— 它不打断，只是换个值 -->
<button class="dd-catch" aria-label="关闭" onclick={onclose}></button>
<div
  bind:this={el}
  class="dd"
  class:up={box?.up}
  role="menu"
  style:left="{box?.left ?? -9999}px"
  style:top="{box?.top ?? -9999}px"
  style:min-width="{box?.minW ?? 0}px"
>
  {@render children()}
</div>
