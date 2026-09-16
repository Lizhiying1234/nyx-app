<script lang="ts">
  /**
   * 桌面上那颗悬浮的 Assist 小球（使用者 2026-09-14 晚）
   *
   * 他的原话：「在 Windows 桌面上显示 Assist 的悬浮小图标。图标应该悬浮在其他
   * 应用窗口之上。它不是普通 App Icon，而是作为 Assist 的**桌面悬浮控制入口**。」
   * 「点击图标 → 开启；再次点击 → 关闭。」
   * 「桌面悬浮图标本身**不负责在 Point 和 Glance 之间切换**，
   *   只负责当前所选模式的开 / 关。」
   *
   * ══ 点击与拖动是同一只手 ★★ ═══════════════════════════════
   * 这颗球上只有一个东西，它**既要能点也要能拖**。
   * `-webkit-app-region: drag` 做不到：一旦某块是 drag，它上面的点击就不再是点击。
   * 所以手写：按下记坐标 → 移动就搬窗口 → **松手时位移小于阈值才算一次点击**。
   *
   * ★ 阈值 4px 是「手抖」和「真的拖」之间那条线。定得太小，他拖完松手会
   *   顺手把 Assist 也切了；定得太大，轻轻一点会被当成拖动、什么都不发生。
   * ★ 位置**拖完才存**（`bubble.rest()`）：一次拖动几十个事件，每一步写一次
   *   `settings` 等于把一次拖动变成几十次磁盘写。
   *
   * ══ 图标只有一份几何 ═══════════════════════════════════════
   * `Sprite` 把 `core/icons.ts` 那份铺进这一页（D-410：几何只有一处）。
   * ★ **这一页必须自己挂 `Sprite`** —— 它不是 `App.svelte` 的子树。
   *   不挂的话每个 `<Ic>` 都是一个空的 `<use>`，屏幕上什么都没有，而且**不报错**。
   *   （同一天在查词浮窗上踩过一次：那儿的 ✕ 和 ⌄ 一直是隐形的。）
   */
  import Ic from './Ic.svelte'
  import Sprite from './Sprite.svelte'

  /** Assist 现在开着吗 —— 主进程推过来的**真状态**，不是这一页猜的 */
  let on = $state(false)
  $effect(() => window.nyx.bubble.onState((v) => (on = v)))

  /** 按下那一刻的屏幕坐标；`null` = 没在拖 */
  let from: { x: number; y: number } | null = null
  /** 这一次按下总共挪了多远 —— 松手时拿它判「点击还是拖动」 */
  let moved = 0

  /** 小于它算点击。见上面那段：手抖和真的拖之间那条线 */
  const CLICK_SLOP = 4

  function down(e: MouseEvent): void {
    if (e.button !== 0) return
    from = { x: e.screenX, y: e.screenY }
    moved = 0
    firstStep = true
  }

  /**
   * ★★ 按下那一点**不挪**（`from` 不再逐帧重置）。
   *   以前每帧把 `from` 挪到当前位置、只送增量，主进程那边就得
   *   「读一下窗口现在在哪再加一点」—— 而那一读一写在 150% 缩放下
   *   会把位移抹成 0、把取整误差堆进尺寸（实测：拖 25 步 → 宽度涨 25）。
   *   现在送的是**从按下到现在的总位移**，主进程只需要按下时那个原点。
   */
  let firstStep = true

  function move(e: MouseEvent): void {
    if (!from) return
    const dx = e.screenX - from.x
    const dy = e.screenY - from.y
    if (dx === 0 && dy === 0) return
    moved = Math.abs(dx) + Math.abs(dy)
    window.nyx.bubble.moveBy(dx, dy, firstStep)
    firstStep = false
  }

  function up(): void {
    if (!from) return
    from = null
    if (moved < CLICK_SLOP) {
      /** 真的是点了一下 → 开 / 关**当前那一档**（图标不负责切模式）*/
      window.nyx.bubble.toggle()
    } else {
      /** 拖完了才存位置 —— 见上面那段 */
      window.nyx.bubble.rest()
    }
    moved = 0
  }
</script>

<Sprite />
<svelte:window onmousemove={move} onmouseup={up} />

<!--
  ★ 整颗球就是一个按钮。`title` 说清点一下会发生什么 ——
    16 像素的图说不了「开」还是「关」，字能。
  ★ 没有第二个控件：他明确说过这颗图标只管开 / 关，模式在设置里选。
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="asbub"
  class:on
  role="button"
  tabindex="-1"
  data-testid="assist-bubble"
  title={on ? 'Assist 开着 —— 点一下关掉（拖动可以挪位置）' : 'Assist 没开 —— 点一下开（拖动可以挪位置）'}
  onmousedown={down}>
  <Ic n={on ? 'star' : 'core-o'} s={26} />
</div>
