<script lang="ts">
  /**
   * 启动页 —— **两版 · 无字**（U-007 定稿 · DESIGN_SYSTEM §12.0b · D-473）
   *
   * ══ 屏幕上有什么 ═══════════════════════════════════════════
   * **没有字**：不放字标「Nyx」· 不放标语 · 不加水光（使用者 2026-09-07 夜当面裁）。
   * 底是 `--color-bg` 素色，中间就**一块画面**：
   *   有图版 → `resources/splash/illustration.webp`（高 ≤62% · 宽 ≤70%）
   *   没图版 → **兔子 168px**，直接落在底上
   * 两版**共用同一套版式**（底 · 位置 · 时长），只换中间那一块 ——
   * 换图不该引起版式重排。位置：居中，但**整块上移 3%**（视觉中心比几何中心高）。
   * 标语只在关于页（DS-Q13 修订）。
   *
   * ══ 判定写在启动那一处，不写在样式里 ═══════════════════════
   * 「文件在且能解码 → 有图版；否则图标版」。主进程那一句读字节（`main/splash.ts`），
   * 这里再过一道 `onerror` —— 字节读到了但**解不出来**也要回退。
   * ★ 换图途中软件绝不能白屏或崩：三种失败在这里是同一种结果。
   *
   * ══ 时长 ═══════════════════════════════════════════════════
   * **300–800ms**（DS-Q15）：300 是下限（闪一下就没比没有还难受），
   * 800 是硬顶 —— **库开好就走，开得快就早走，绝不为了看够而等**。
   *
   * ★ 只在**冷启动**出现（组件挂载一次）；不做点击跳过（它本来就不该久到需要跳过）。
   * ★ 样式全在 `enhancements.css` 的 `.splash*`（D-227）。
   */
  import brandMark from '../../../assets/brand/android/ic_launcher_foreground-xxxhdpi.png'

  let { done }: { done: boolean } = $props()

  /**
   * ★★ 2026-09-09 使用者裁：**「停留时间太短，还没来得及看清就进去了 —— 适当延长，
   *    让用户至少完整看一眼」**。300 / 800 改成 **1200 / 2200**。
   *
   * ★ 这一改**推翻了 DS-Q15 的定案**（「300–800ms，800 是硬顶 —— 库开好就走，
   *   开得快就早走，**绝不为了看够而等**」）。那条判据背后的价值是「不耽误他」，
   *   而他现在明说：**耽误这一下是他要的**。人高于判据，所以改；
   *   ☞ DESIGN_SYSTEM.md §12 那两个数因此过时了 —— 判据文件归总控，
   *     本会话不改，已记进回报。
   *
   * ★ **下限与上限的意思没变，只是数变了**：
   *   下限 = 「至少让他看完这一眼」；上限 = 「库再慢也不许一直等下去」。
   *   两条都还在，所以启动仍然不会被它拖住 —— 库开得慢时最多多等到 2.2 秒。
   * ★ 嫌长嫌短就改这两个常量，别去动下面那套判定。
   */
  const MIN_MS = 1200
  const MAX_MS = 2200

  let art = $state<string | null>(null)
  /** 图解不出来就退回没图版 —— 和「文件不在」是同一种结果 */
  let broken = $state(false)
  let minPassed = $state(false)
  let capped = $state(false)

  $effect(() => {
    const t1 = setTimeout(() => (minPassed = true), MIN_MS)
    const t2 = setTimeout(() => (capped = true), MAX_MS)
    void window.nyx.app
      .splashArt()
      .then((d) => (art = d))
      .catch(() => {
        // 取不到就画没图版 —— 启动页不许因为一张图挡住软件
        art = null
      })
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  })

  /** 走的条件：**库开好了且满了 300ms**，或者到了 800ms 硬顶 */
  const gone = $derived((done && minPassed) || capped)
</script>

{#if !gone}
  <div class="splash" data-testid="splash" aria-hidden="true">
    <div class="splash-art">
      {#if art && !broken}
        <img class="art" src={art} alt="" data-testid="splash-illustration" onerror={() => (broken = true)} />
      {:else}
        <img class="mark" src={brandMark} alt="" data-testid="splash-mark" />
      {/if}
    </div>
  </div>
{/if}
