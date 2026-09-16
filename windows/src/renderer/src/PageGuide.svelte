<script lang="ts">
  /**
   * 页面内引导（第二层）· D-484 · DESIGN_SYSTEM §十五
   *
   * ══ 它是什么 ═══════════════════════════════════════════════
   *
   * 他**第一次碰到某个控件**时，站在那个控件旁边说一句话。
   * 规矩是使用者 2026-09-15 定的，一条都不许松：
   * **每页 ≤ 1 件 · 全应用 ≤ 8 条 · 每条一句话**（CR-3；今天是 7 条，B-8 两端都删）。
   *
   * ★★ **不是第五种浮层**：Popover ＋ 聚焦遮罩 ＋ 连接线的组合。
   *   Popover 的规矩继承**除了「点外关」以外的**：Esc 关（走 `esc-stack`，IX-04）· 关自己。
   *   ★★★ 「点外关」**2026-09-15 撤了**（T-6 / I-192，使用者裁，两端同规）——
   *     理由写在下面遮罩那一段；撤的原因不是审美，是真机上量到的一种静默数据损坏。
   * ★★ 说哪几条、每条说什么、看过没有，全在 core 一份（`core/onboarding.ts`）：
   *   两端指的必须是同一个东西，否则「他在一端看过，另一端再也不出」，而两边都不报错。
   * ★ 角色（那只兔子）**只在首次引导里出现**，这一层只有框与线（D-473 / D-340）。
   *
   * ══ 为什么每帧重算坐标 ★ ══════════════════════════════════
   *
   * 目标是页面里一个真实控件：侧栏会滚、窗口会变宽、折叠区会展开。
   * 算一次就钉死的话，他滚一下页面，洞和线就留在原地指着空白 ——
   * 而那比不画更糟（它在**指错地方**）。所以开着的时候一直按实时坐标跟。
   */
  import { onMount } from 'svelte'
  import { registerEsc } from './esc-stack.svelte.ts'
  import { guideById } from '@core/onboarding.ts'

  const {
    id,
    onclose,
    onmiss
  }: { id: string; onclose: () => void; onmiss: () => void } = $props()

  /**
   * ★ 跟着 `id` 走，不是开局抓一次：`activeGuide()` 现在一定是
   *   「X → null → Y」（`askGuide` 在 `active` 非空时直接返回），所以抓一次也对；
   *   但那条判据在**另一个文件**里，哪天它松了，这里的表现是
   *   「框还在，里面却是上一条的话」—— 一句错的话比没有话更糟。
   */
  const def = $derived(guideById(id))

  /** 目标的实时位置。`null` = 这一帧还没量到（目标不在屏上）*/
  let box = $state<{ x: number; y: number; w: number; h: number } | null>(null)

  /**
   * 目标一直量不到就**放弃这一条**，等他下次再碰到那个控件。
   *
   * ══ 为什么非要有这一条 ★★★ ═══════════════════════════════
   *
   * 接线的规矩是「同时只许出一条」：`active` 不为 null 时 `askGuide` 直接返回。
   * 于是「问了一条、而它的目标不在屏上」会变成**死局** ——
   * 屏上什么都没画（量不到就不画），他没有东西可点，`active` 就再也回不到 null，
   * **这一趟剩下的七条全部不出**，而且一声不响。
   * 页面上真会发生：目标要等数据回来才渲染 · 他在框出来之前就翻页走了 ·
   * 折叠区又被收起来了 —— 三种都不是错误，都只是「这会儿不在」。
   *
   * ★★ 放弃走的是 `onmiss`，**不是 `onclose`** —— 后者会记一笔「看过了」，
   *   而他根本没看见。那一记会让这条引导**永久**不再出现，
   *   这正是「静悄悄地少了一句话」那种最难发现的坏法。
   */
  const GIVE_UP_FRAMES = 90

  /**
   * ★★ 量不到目标就**什么都不画**，而不是画在屏幕中间。
   *   画在中间的话，他看到一个指着空白的框 —— 那比不出现更让人困惑。
   */
  onMount(() => {
    let raf = 0
    let blind = 0
    const tick = (): void => {
      const el = document.querySelector(`[data-guide="${id}"]`)
      if (el) {
        const r = el.getBoundingClientRect()
        box = r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
      } else {
        box = null
      }
      /** 量到一次就清零：中间闪一下（滚动 · 重排）不算数，连着量不到才算走了 */
      blind = box ? 0 : blind + 1
      if (blind >= GIVE_UP_FRAMES) return void onmiss()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  })

  /** ★ D-440 / IX-04 · Esc 和别的浮层同一条栈，不自己监听键盘 */
  $effect(() => registerEsc(() => (onclose(), true)))

  /** 洞：目标外扩 8（DS §十五）*/
  const PAD = 8
  const hole = $derived(
    box ? { x: box.x - PAD, y: box.y - PAD, w: box.w + PAD * 2, h: box.h + PAD * 2 } : null
  )

  const BOXW = 320
  const BOXH = 120
  /**
   * 框离目标多远。
   *
   * ★★ 原来是 14 —— **量出来那是错的**：折线总长正好 14px，而尾巴三角自己就有 10px 高，
   *   于是 DS §十五 要的那根连接线**一根都看不见**（实测 `getTotalLength() = 14`，
   *   路径四个点全挤在同一个 x 上）。样式规则还在、`check:css-dead` 照样认它「活着」，
   *   屏上却什么都没有 —— G-1 的「视觉家族」等于少交了一件。
   *   28 是让那根线真的露出一段、而框又不至于飘远的最小值。
   */
  const GAP = 28

  /**
   * ══ 框摆哪一边 ★★ ═════════════════════════════════════════
   *
   * ★★ 我第一版写的是「只做上下，因为这八个目标全是横向铺开的控件」。
   *   **拉起来量了一下，那句是错的**：侧栏那个目标是 249 宽 × 整块高，
   *   框摆在它下面**正好盖住他要看的那棵树**。
   *   所以判据改成按形状分：**又高又窄的目标（比目标自己宽、屏幕又放得下）摆到右边**，
   *   其余照旧上下。—— 这是量出来的，不是推的。
   */
  const side = $derived(
    !!hole && hole.h > 120 && hole.x + hole.w + GAP + BOXW < window.innerWidth
  )
  const below = $derived(!!hole && !side && hole.y + hole.h + GAP + BOXH < window.innerHeight)

  const boxLeft = $derived(
    !hole
      ? 0
      : side
        ? hole.x + hole.w + GAP
        : Math.max(16, Math.min(window.innerWidth - BOXW - 16, hole.x + hole.w / 2 - BOXW / 2))
  )
  const boxTop = $derived(
    !hole
      ? 0
      : side
        ? Math.max(16, Math.min(window.innerHeight - BOXH - 16, hole.y + hole.h / 2 - BOXH / 2))
        : below
          ? hole.y + hole.h + GAP
          : hole.y - GAP - BOXH
  )
  /** 尾巴沿边滑动，离角 ≥16（DS §十五）*/
  const tailLeft = $derived(
    hole ? Math.max(16, Math.min(BOXW - 32, hole.x + hole.w / 2 - boxLeft - 6)) : 16
  )
  const tailTop = $derived(
    hole ? Math.max(16, Math.min(BOXH - 32, hole.y + hole.h / 2 - boxTop - 6)) : 16
  )

  /** 连接线：两段直角折线，从洞边到尾巴根部 */
  const path = $derived.by(() => {
    if (!hole) return ''
    if (side) {
      const fromX = hole.x + hole.w
      const fromY = hole.y + hole.h / 2
      const toY = boxTop + tailTop + 6
      const midX = (fromX + boxLeft) / 2
      return `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${boxLeft} ${toY}`
    }
    const fromX = hole.x + hole.w / 2
    const fromY = below ? hole.y + hole.h : hole.y
    const toX = boxLeft + tailLeft + 6
    const toY = below ? boxTop : boxTop + BOXH
    const midY = (fromY + toY) / 2
    return `M ${fromX} ${fromY} L ${fromX} ${midY} L ${toX} ${midY} L ${toX} ${toY}`
  })
</script>

{#if def && hole}
  <!--
    ══ 点遮罩**不关、也不穿透** · T-6 / I-192 ════════════════════
    （C 在 Android 真机上量到，使用者裁甲，两端同规）

    ★★★ 这一处**不继承** Popover 的「点外关」。
      理由是真机上量到的事：引导刚弹出来时，他的手指已经在去点列表了 ——
      那一下落在遮罩上，于是**引导关了 · 页面没跳 · 记号却记了「看过」**，
      这句话从此再也不出现。他得到的是「闪了一下就没了」，而四门全绿。
      改成「进页面即出」之后只会更容易撞上。
    ★ 所以遮罩只做一件事：**把那一下吃掉**（不关框，也不让它穿到下面的页面）。
      出口只剩两个，都是明确的动作：「知道了」和 Esc。
    ★ 不加 `onclick` 也不加键盘处理 —— 它不是可交互元素，只是一块挡板；
      `pointer-events` 由 CSS 给（`.gd-scrim` 本来就实心铺满）。
  -->
  <div class="gd-scrim" data-testid="guide-scrim-{id}"></div>
  <div
    class="gd-hole"
    style="left:{hole.x}px;top:{hole.y}px;width:{hole.w}px;height:{hole.h}px"
    data-testid="guide-hole-{id}"
  ></div>
  <svg class="gd-line" aria-hidden="true"><path d={path} /></svg>

  <div
    class="gd-box"
    style="left:{boxLeft}px;top:{boxTop}px"
    role="dialog"
    aria-label="页面引导"
    data-testid="guide-{id}">
    {#if side}
      <span class="gd-tail left" style="top:{tailTop}px"></span>
    {:else}
      <span class="gd-tail {below ? 'up' : 'down'}" style="left:{tailLeft}px"></span>
    {/if}
    <!--
      ★ 标题那一行是**固定的**，不按条写（这是我拟的字，D-413）：
        确认单表 B 每条只给了**一句话**，给七条各编一个标题 =
        凭空多七句没人裁过的屏上字；而「这是什么」对七条都成立 ——
        它们回答的正是这一问。
      ★ 字体：界面字半粗（使用者 2026-09-15 裁，原来是 `--note` 手写体，
        中文上那条规则不成立 —— 理由写在 `.gd-t` 那条规则旁边）。
    -->
    <div class="gd-t">这是什么</div>
    <div class="gd-s">{def.says}</div>
    <div class="gd-ok">
      <button class="btn sm pri" data-testid="guide-ok-{id}" onclick={onclose}>知道了</button>
    </div>
  </div>
{/if}
