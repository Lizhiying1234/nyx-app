<script lang="ts">
  /**
   * 首次引导 —— 四屏整屏左右滑（SC-25 · D-483 · 使用者 2026-09-15）。
   *
   * ══ 讲什么不归这个文件管 ═══════════════════════════════════
   * 五件事与每件的说法在 core（`onboardingSteps()`），两端一字不差（CR-7）。
   * 这里只负责**形态**：分几屏、怎么翻、什么时候收（D-474 两端各自形态）。
   * 分屏判据在 `onboarding.ts`（能被用例盯住 —— core 加一步而没人排屏，
   * 是一种不会报错的坏法）。
   *
   * ══ 时机 ═══════════════════════════════════════════════════
   * 系统那一帧 → `index.html` 的插画帧（`#nyx-splash`，z-index 90）→ 这一屏 → Atlas。
   * ★ **不动启动页**（U-007）：这一层的 z-index 压在 90 以下，
   *   启动页收掉之前它就在底下等着，顺序是靠层序保证的，不靠互相喊话。
   *
   * ══ 三条形态规矩 ═══════════════════════════════════════════
   *   翻页 = 原生横向 scroll-snap（不手写手势：抛掷、回弹、无障碍焦点都是白送的）
   *   底部圆点只报位置，**点不动** —— 它不是控件（DS §11.1：不能点的没有紫也没有 ›）
   *   一屏一个 Primary：末屏「开始使用」；「跳过」是 Ghost，全程在右上角
   *
   * ★ 返回键：不在第一屏就退一屏，在第一屏才等于「跳过」（D-393 栈里注册）。
   *   统一成「按一下就消失」更省事，但那会让他翻到第三屏按一下返回、
   *   整个引导直接不见了 —— 而且**再也不会自己出现**（看完和跳过写同一个记号）。
   * ══ 形态「乙」：兔子说话（H-2 · 使用者 2026-09-15 第一条）════
   * 「更精致 · 更有趣 · 更有漫画感 · 不要做成产品功能说明 PPT」——
   * 于是每一屏变成：**说话的兔子 + 漫画框里的一句**，框的尾巴指向兔子。
   * ★ 兔子用的就是启动页那一张（`SPLASH_ICON`，同一张母图派生，**不另画**）。
   * ★★ D-340「不做吉祥物」**没有被推翻**：D-484 只放开**首次引导这一处**。
   *   别的屏上不许出现它 —— 那是一次点名的例外，不是新的视觉元素。
   * ★ D-227：这个文件里一行样式都没有（`.onb*` 在 mobile.css）。
   */
  import { DEFAULT_GRADING, onboardingSteps } from '../../core-link.ts'
  import { prefNumber } from '../../db/prefs.ts'
  import { SPLASH_ICON } from './splash-art.ts'
  import { pagesOf } from './onboarding.ts'
  import { onboard } from './onboarding.svelte.ts'
  import { registerBack } from './backstack.svelte.ts'
  import { store } from './store.svelte.ts'

  /**
   * ★★ G-5 标题里「连着答对几次」那个数**跟着他的设置走**（D-485 · E-1-e）。
   *   写死的话，他改成 2 之后引导第一次打开就在说假话，而**没有任何东西会红**。
   * ★ 还没读到设置之前先按出厂档渲染 —— 引导不许为了一个数字等库。
   */
  let streak = $state(DEFAULT_GRADING.silenceStreak)
  const PAGES = $derived(pagesOf(onboardingSteps(streak)))

  $effect(() => {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    void prefNumber(db, 'param.silenceStreak', DEFAULT_GRADING.silenceStreak).then((n) => {
      streak = n
    })
  })

  /** 现在在第几屏（从滚动位置读回来，不是自己记的 —— 手指滑的那次没人通知我们） */
  let at = $state(0)
  let rail = $state<HTMLDivElement | null>(null)

  /** 看完 / 跳过 **同一条路**：都算看过 */
  function close(): void {
    if (store.db.k !== 'ok') return
    void onboard.finish(store.db.db)
  }

  function goTo(i: number): void {
    rail?.scrollTo({ left: i * (rail?.clientWidth ?? 0), behavior: 'smooth' })
  }

  function onScroll(): void {
    const el = rail
    if (!el || el.clientWidth === 0) return
    at = Math.min(PAGES.length - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth)))
  }

  $effect(() => {
    if (!onboard.open) return
    return registerBack(() => {
      if (at > 0) goTo(at - 1)
      else close()
      return true
    })
  })
</script>

{#if onboard.open}
  <div class="onb" role="dialog" aria-modal="true" aria-label="新手引导">
    <div class="onb-top">
      <button class="btn gh sm" onclick={close}><span class="zh">跳过</span></button>
    </div>

    <div class="onb-rail" bind:this={rail} onscroll={onScroll}>
      {#each PAGES as page, i (i)}
        <section class="onb-pg" aria-label="第 {i + 1} 屏，共 {PAGES.length} 屏">
          <!-- ★ 一屏一只兔子：它是「说话的人」，不是装饰 —— 所以框的尾巴指着它。
               并屏那一屏（G-4 + G-5）有两句话，兔子仍然只有一只（说两句的是同一个人）。 -->
          <img class="onb-bun" src={SPLASH_ICON} alt="" aria-hidden="true" />
          {#each page as step (step.id)}
            <div class="onb-blk">
              <span class="onb-tail" aria-hidden="true"></span>
              <h2 class="onb-t zh">{step.title}</h2>
              <p class="onb-b zh">{step.body}</p>
            </div>
          {/each}
        </section>
      {/each}
    </div>

    <div class="onb-foot">
      <div class="onb-dots" aria-hidden="true">
        {#each PAGES as _, i (i)}
          <span class="onb-dot" class:on={i === at}></span>
        {/each}
      </div>
      <!-- ★ 这一格**永远占着位**：只在末屏放按钮的话，翻到末屏时圆点会被顶上去 -->
      <div class="onb-act">
        {#if at === PAGES.length - 1}
          <button class="btn pri" onclick={close}><span class="zh">开始使用</span></button>
        {/if}
      </div>
    </div>
  </div>
{/if}
