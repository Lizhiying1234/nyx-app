<script lang="ts">
  /**
   * 页面内功能引导的那一层（第二层 · 使用者 2026-09-15 第三条点名的三样）：
   *   ① 聚焦    整页遮罩 + 目标**挖洞**（外扩 8 · 圆角 14 · 1px 描边）
   *   ② 连接    1px 虚线（`4 4`）**只走直角**，从洞连到框
   *   ③ 漫画框  圆角 14 + 阴影 + 三角尾巴，尾巴贴最近边、离角 ≥16
   *
   * ★ 这三样的度量按 G-1 写死在 `mobile.css`（D-227：这个文件一行样式都没有）。
   *   两端**各自度量、语义相同**（D-474）—— 手机上不照抄电脑的像素。
   *
   * ══ 为什么挖洞用 box-shadow 而不是 SVG mask ══════════════════
   * 一个定位在目标上的空 div + `box-shadow: 0 0 0 9999px 遮罩色`，
   * 洞就是它自己那块。比 mask 少一层合成，滚动时也不会和目标错位 ——
   * 因为它和目标读的是同一个 `getBoundingClientRect`。
   *
   * ★★★ 收掉只有**两条**路：点「知道了」· 返回键（D-393 栈里注册）。两条都走 `guide.close()`。
   *   **点遮罩不关**（I-192，使用者 2026-09-15 裁「甲」，两端同规）。
   *
   *   为什么改：真机上量到的 —— 清表进 Vault，第一条对着「攻坚区」弹出来，
   *   我随手往上一行「全部」点了一下，结果是**引导没了、页面也没跳**（那一下被遮罩吃掉），
   *   而库里 `ui.guide.seen` 已经记成看过 —— **一次打偏的点 = 这条在这台机上永远不再出现**，
   *   他连那句话写的什么都没看见。引导是「进页面即出」，出现的时刻正压在
   *   手指已经在往别处去的那一拍上，所以这不是小概率。
   *
   *   ★ 「吃掉那一下」这件事本来就成立、也要留着：`.gd-wrap` 铺满视口，
   *     `.gd-hole` / `.gd-line` 都是 `pointer-events:none`，事件落回 wrap 自己。
   *     现在 wrap 身上没有任何处理器 —— **吃掉，但什么都不做**（不关、不穿透）。
   *     他会看见「点了没反应」，于是抬眼看那个框；比「闪一下没了」强。
   * ★ 「看过」那一笔仍在**摆上去的同一拍**记，不改（见下）。
   * ★ 「看过」那一笔**不在这里写** —— 在 `guide.svelte.ts` 摆上去的同一拍就写了。
   *   放在关闭时写的话，他划走 / 杀后台那一次就没记上，下次再弹一遍。
   */
  import { guide } from './guide.svelte.ts'
  import { registerBack } from './backstack.svelte.ts'

  /** 洞比目标外扩多少（G-1 定的 8） */
  const PAD = 8
  /** 框与洞之间留多少 */
  const GAP = 14
  /** 尾巴离框角至少多远（G-1 定的 16） */
  const TAIL_EDGE = 16

  let boxH = $state(0)
  let vw = $state(0)
  let vh = $state(0)

  const shown = $derived(guide.open)

  /** 洞（视口坐标） */
  const hole = $derived(
    shown
      ? {
          x: shown.rect.x - PAD,
          y: shown.rect.y - PAD,
          w: shown.rect.w + PAD * 2,
          h: shown.rect.h + PAD * 2
        }
      : null
  )

  /**
   * 框放洞的上面还是下面：下面放得下就放下面（视线往下更自然），
   * 放不下才翻到上面。两边都放不下时**仍然放下面并让它顶着安全区** ——
   * 宁可挤一点，也不要把框画到屏幕外面去。
   */
  const below = $derived(!!hole && hole.y + hole.h + GAP + boxH + 16 <= vh)
  const boxTop = $derived(
    !hole ? 0 : below ? hole.y + hole.h + GAP : Math.max(8, hole.y - GAP - boxH)
  )

  /** 尾巴的横坐标：对准目标中心，但离框角至少 TAIL_EDGE */
  const tailX = $derived(
    !hole ? 0 : Math.min(Math.max(hole.x + hole.w / 2, 16 + TAIL_EDGE), vw - 16 - TAIL_EDGE)
  )

  /**
   * 虚线：从洞的最近边出发，**只走直角**。
   * 竖一段到框边，必要时再横一段对到尾巴 —— 两段封顶（G-1）。
   */
  const line = $derived.by(() => {
    if (!hole) return ''
    const cx = hole.x + hole.w / 2
    const fromY = below ? hole.y + hole.h : hole.y
    const toY = below ? boxTop : boxTop + boxH
    const mid = (fromY + toY) / 2
    return `M ${cx} ${fromY} L ${cx} ${mid} L ${tailX} ${mid} L ${tailX} ${toY}`
  })

  $effect(() => {
    if (!guide.open) return
    return registerBack(() => (guide.close(), true))
  })
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if shown && hole}
  <!-- 整页遮罩 + 挖洞：洞就是这块 div 自己，四周那圈是它的 box-shadow。
       ★★ 这一层**故意没有 onclick**（I-192 · 裁「甲」）：点它吃掉那一下，但不关也不穿透。
          别顺手把「点外关」加回来 —— `guide.test.ts` 的 GD-11 会红。 -->
  <div class="gd-wrap" role="dialog" aria-modal="true" aria-label="功能说明">
    <div
      class="gd-hole"
      style:left="{hole.x}px"
      style:top="{hole.y}px"
      style:width="{hole.w}px"
      style:height="{hole.h}px"
    ></div>

    <!-- 连接线：1px 虚线、只走直角（G-1） -->
    <svg class="gd-line" viewBox="0 0 {vw} {vh}" aria-hidden="true">
      <path d={line} />
    </svg>

    <!-- 漫画框：尾巴贴最近边、对准目标中心 -->
    <div
      class="gd-box"
      class:up={!below}
      bind:clientHeight={boxH}
      style:top="{boxTop}px"
    >
      <span class="gd-tail" style:left="{tailX - 16}px"></span>
      <p class="gd-says zh">{shown.says}</p>
      <div class="gd-act">
        <button class="btn pri sm" onclick={() => guide.close()}><span class="zh">知道了</span></button>
      </div>
    </div>
  </div>
{/if}
