<script lang="ts">
  /**
   * 首次引导 · SC-25（D-483 · 使用者 2026-09-15）· 形态重做 G-2（D-484 角色乙）
   *
   * ══ 它解决的问题（使用者原话）═══════════════════════════════
   * 「有些内容与其一直放在界面里解释，我认为更适合放进首次进入软件时的指导。」
   * 「这个引导不是完整的使用手册，也不要做成长篇教程。」
   *
   * ══ 这一版换的是**形态**，内容一个字没动 ════════════════════
   *
   * 旧版是五张朴素卡片（标题 + 两行字 + 下一步）。使用者要的是
   * 「精致 · 有趣 · 漫画感 · 视觉引导性，**不是功能说明 PPT**」（D-484）。
   * 所以每一步现在是 **一格画面 + 兔子说一句**，分镜逐格照确认单表 A-2。
   *
   * ★★ **角色乙**（D-484，使用者推翻了我推荐的甲）：启动页那只兔子作为
   *   「说话的人」出现在**首次引导这一处**；页面内引导与功能界面**仍然没有角色**
   *   （D-340 不动，D-473 就地修订）。所以这只兔子只在这个文件里出现。
   * ★★ **不另画**：用的就是启动页那张（`assets/brand/android/ic_launcher_foreground-xxxhdpi.png`，
   *   与 `Splash.svelte` 同一张）—— 派生自 `master-source-bunny-2026-09-14.png`。
   *   新画一张的代价不是画，是**从此有两只兔子**，而它们会各自漂。
   *
   * ══ 分镜为什么直接写在这个文件里 ★ ═════════════════════════
   *
   * · 不进 `core/icons.ts`（D-410 「图标几何只有一份」）：那条管的是**图标** ——
   *   会在几十处复用、必须处处一致的东西。这五格是**一次性插画**，
   *   一个软件的一生里只出现一次，进图标表只会让那张表变成杂物抽屉。
   * · 不进 core：形式各端自己定（D-474）；CR-7 管的是**说法**，不管画法。
   *   Android 那边是四屏左右滑（表 A-3），画同样的东西但不是同一份几何。
   *
   * ══ 硬规矩 ═══════════════════════════════════════════════
   * · **样式一行都不在这儿**（D-227）—— 全在 `enhancements.css` 的 `.onb*`。
   *   SVG 里只有**几何**（`d` / 坐标），颜色与线宽一律走类名。
   * · 壳沿用现成的 `.mo` / `.mbox`，不新造一套遮罩（总原型已经有了）。
   * · **一屏一个 Primary**（BUTTON_SYSTEM）：右边那颗「下一步 / 开始使用」是
   *   唯一的 Primary，「跳过」是 Ghost，**全程可见**。
   * · **动效 ≤ 一处 / 步**（表 A-2）：只有第一步那一笔「描实」有（200ms）。
   *   其余四格一动不动 —— 减弱动效由 `global.css` 那条 `prefers-reduced-motion` 统一关掉。
   * · Esc 走 `esc-stack`（IX-04 唯一消费点），**不自己装 window 监听**。
   *   Esc = 跳过 —— 他按 Esc 就是「别挡着我」，再弹一次是不尊重这个动作。
   * · **点遮罩不关**。Dialog 那边点遮罩 = 取消，是因为那是他自己打开的东西；
   *   这一层是**没请自来**的，一次误点就永远错过了那五句话（看完 / 跳过都只发生一次）。
   * · 不做深色（D-339）。
   */
  import { registerEsc } from './esc-stack.svelte.ts'
  import { ONBOARDING_STEPS, onboardingSteps } from '@core/onboarding.ts'
  import bunny from '../../../assets/brand/android/ic_launcher_foreground-xxxhdpi.png'

  let { ondone }: { ondone: () => void } = $props()

  /**
   * ★ 「答对几次」跟着他的设置走（D-485）。读不到就用出厂那一份 ——
   *   引导不该因为一次读参数失败就打不开。
   */
  let steps = $state(ONBOARDING_STEPS)
  window.nyx.params
    .list()
    .then((ps) => {
      const n = ps.find((p) => p.key === 'silenceStreak')?.value
      if (typeof n === 'number') steps = onboardingSteps(n)
    })
    .catch(() => {})

  let i = $state(0)
  const step = $derived(steps[i])
  const last = $derived(i === steps.length - 1)

  /** 首个可按的东西拿焦点 —— 键盘进来的人不用先 Tab 一圈 */
  let nextBtn = $state<HTMLButtonElement | null>(null)
  $effect(() => {
    nextBtn?.focus()
  })

  $effect(() => {
    const off = registerEsc(() => {
      ondone()
      return true
    })
    return off
  })

  const advance = (): void => {
    if (last) ondone()
    else i += 1
  }
</script>

<!--
  ★ `aria-modal` + `role="dialog"`：它确实盖住了整个主窗，读屏要知道这件事。
  ★ 遮罩上**没有** onclick（见上面那条规矩）。
-->
<div class="mo on onb-mask" data-testid="onboarding-scrim">
  <div
    class="mbox onb"
    role="dialog"
    aria-modal="true"
    aria-label="第一次使用"
    data-testid="onboarding"
  >
    <!-- ★ 进度先说清「五步里的第几步」—— 不写他不知道还要点几次 -->
    <div class="onb-dots" data-testid="onboarding-dots" aria-hidden="true">
      {#each steps as s, n (s.id)}
        <i class:on={n === i} class:done={n < i}></i>
      {/each}
    </div>

    <!--
      ══ 一格画面（表 A-2 逐格）════════════════════════════════
      ★ `aria-hidden`：画面不承载任何读屏要念的信息 —— 那五句话在下面的对话框里，
        画只是把那句话画出来。念一遍 SVG 里的装饰词只会打断他。
      ★ 每一格最后那条**虚线**从画面里的物垂到画框底边，接上对话框的尖角 ——
        「对话框指向画面里的物」（表 A-2 的「字在哪」那一列）就是靠它。
        画在 SVG 里而不是拿 CSS 另摆一条：五格指的物各不相同，
        用 CSS 摆就得为每一步写一套坐标，那正是 D-227 想避免的东西。
    -->
    <div class="onb-scene" data-testid="onboarding-scene">
      <svg class="onb-art" viewBox="0 0 360 132" aria-hidden="true">
        {#if step.id === 'G-1'}
          <!-- 读得懂 ≠ 写得出：左边一团歪斜的笔记碎片，右边一支笔把其中一个描实 -->
          <g class="onb-faint">
            <text x="22" y="34" transform="rotate(-7 22 34)">reluctant</text>
            <text x="34" y="66" transform="rotate(4 34 66)">brunt</text>
            <text x="18" y="96" transform="rotate(-3 18 96)">hold sway</text>
          </g>
          <!-- 被描实的那一个（动效唯一的一处） -->
          <text class="onb-solid" x="218" y="62">rummage</text>
          <path class="onb-ink" d="M214 72 H316" />
          <!-- 笔：一支斜着的笔杆 + 笔尖 -->
          <g class="onb-ln">
            <path d="M322 34 L300 66" />
            <path d="M300 66 L296 78 L306 72 Z" />
          </g>
          <path class="onb-dash" d="M264 84 V130" />
        {:else if step.id === 'G-2'}
          <!-- 划一下就查：别的程序的窗框剪影，里面一行英文被一道手绘下划线划过 -->
          <g class="onb-ln">
            <rect x="46" y="20" width="268" height="86" rx="8" />
            <path d="M46 40 H314" />
            <circle cx="60" cy="30" r="3" />
            <circle cx="72" cy="30" r="3" />
            <circle cx="84" cy="30" r="3" />
          </g>
          <g class="onb-faint">
            <text x="64" y="64">She bore the brunt of it.</text>
          </g>
          <!-- 手绘下划线：不是直线，两头轻中间重 -->
          <path class="onb-ink" d="M126 71 Q160 78 196 70" />
          <path class="onb-dash" d="M160 78 V130" />
        {:else if step.id === 'G-3'}
          <!-- Lecture：一张纸，底下垂着三四个小挂牌 -->
          <g class="onb-ln">
            <path d="M120 16 H240 L240 66 H120 Z" />
            <path d="M136 32 H224" />
            <path d="M136 44 H210" />
            <path d="M136 56 H228" />
          </g>
          <g class="onb-ln">
            <path d="M146 66 V82" />
            <path d="M180 66 V90" />
            <path d="M214 66 V82" />
          </g>
          <g class="onb-tag">
            <rect x="130" y="82" width="32" height="16" rx="4" />
            <rect x="164" y="90" width="32" height="16" rx="4" />
            <rect x="198" y="82" width="32" height="16" rx="4" />
          </g>
          <path class="onb-dash" d="M180 106 V130" />
        {:else if step.id === 'G-4'}
          <!-- 两条线：左右两条手绘轨道，同一个挂牌在两条上各走一段 -->
          <g class="onb-ln">
            <path d="M40 96 Q92 86 144 96" />
            <path d="M216 96 Q268 86 320 96" />
          </g>
          <g class="onb-faint">
            <text class="onb-mid" x="92" y="30">认读</text>
            <text class="onb-mid" x="268" y="30">产出</text>
          </g>
          <g class="onb-tag">
            <rect x="62" y="70" width="32" height="16" rx="4" />
            <rect x="262" y="70" width="32" height="16" rx="4" />
          </g>
          <path class="onb-dash" d="M92 100 V130" />
          <path class="onb-dash" d="M278 100 V130" />
        {:else}
          <!-- 练成了：挂牌走到轨道尽头，被轻轻放进一个**敞口**的盒子 -->
          <g class="onb-ln">
            <path d="M40 60 Q106 50 172 60" />
          </g>
          <g class="onb-tag">
            <rect x="60" y="34" width="32" height="16" rx="4" />
          </g>
          <!--
            ★★ 盒子**故意不关盖**（表 A-2 的原话）：这一格要同时说清
              「练成了」和「没有消失」。关了盖就变成「归档 / 收起来」，
              而那正是 `silence.ts` 明确否掉的两个词（D-485）。
              所以只画三条边 —— 上面那条线不存在。
          -->
          <g class="onb-ln">
            <path d="M212 56 V104 H316 V56" />
            <path d="M212 104 H316" />
          </g>
          <g class="onb-tag">
            <rect x="246" y="66" width="36" height="18" rx="4" />
          </g>
          <path class="onb-dash" d="M264 106 V130" />
        {/if}
      </svg>
    </div>

    <!--
      ══ 兔子说这一句（角色乙）════════════════════════════════
      ★ `alt=""`：它是**装饰**。念「兔子」对读屏用户没有任何帮助，
        而它旁边那句话本身就是全部内容。
    -->
    <div class="onb-say">
      <img class="onb-bun" src={bunny} alt="" />
      <div class="onb-bub">
        <h3 class="onb-h" data-testid="onboarding-title">{step.title}</h3>
        <p class="onb-b" data-testid="onboarding-body">{step.body}</p>
      </div>
    </div>

    <div class="onb-acts">
      <!-- ★ 跳过在左、全程可见（派单）。它**也算看过** —— 不会再来第二次 -->
      <button class="btn ghost sm" data-testid="onboarding-skip" onclick={ondone}>跳过</button>
      <span class="onb-n" data-testid="onboarding-step">{i + 1} / {steps.length}</span>
      <button
        class="btn pri"
        bind:this={nextBtn}
        data-testid="onboarding-next"
        onclick={advance}>{last ? '开始使用' : '下一步'}</button
      >
    </div>
  </div>
</div>
