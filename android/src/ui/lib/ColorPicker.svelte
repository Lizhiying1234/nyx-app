<script lang="ts">
  /**
   * 应用内的拾色器（2026-09-13）
   *
   * ══ 为什么不用 `<input type="color">` ★★ ═══════════════════
   * 真机上看过（PJE110 / ColorOS，2026-09-13）：它**能开**，开出来的是
   * Android WebView 自带的那个对话框 —— 八个纯红纯绿纯蓝的格子、
   * 一个被挤断行的「Cust om」、CANCEL / SET。
   * 对这套配色来说那八个饱和原色毫无用处，而唯一能自定义的入口小到点不中。
   * ★ 使用者报的正是这一条：「我新建颜色，点击进去，我自己不能改配色」。
   * ★ 我上一轮「验过」的是用 JS 给 input 赋值 —— 那验的是**管道**，不是交互。
   *   教训：要验「他能不能用」，就得真的用手指点一下。
   *
   * ══ 为什么是 HSL 三条杆 ════════════════════════════════════
   * 调色时人想的是「同一个色相再淡一点」—— 那在 HSL 里是动一根杆，
   * 在 RGB 里要同时动三根。HEX 框留着，方便他从别处抄一个色号进来。
   *
   * ══ 没动就不写 ★ ═══════════════════════════════════════════
   * HEX → HSL → HEX 往返有 ±1 的取整误差。要是一打开就按滑杆的值回写，
   * 他**只是看了一眼**也会凭空多出一条「改过」的记录，而且颜色还差一点点。
   * 所以 `touched` 之前，显示与回写的都是**原样那个值**。
   *
   * ★ 用统一 Dialog 原语，不另造弹窗（DS §10.8）。
   * ★ D-227：这个文件里一行样式都没有。
   */
  import Dialog from './Dialog.svelte'
  import { contrastText, hexToHsl, hslToHex, normalizeHex, type Hsl } from './theme.ts'

  let {
    token,
    zh,
    value,
    shipped,
    bg,
    ink,
    onclose,
    onpick,
    onclear
  }: {
    /** 令牌名（不带 --）—— 标题里要说清他在调哪一个 */
    token: string
    /** 屏上叫什么 */
    zh: string
    /** 现在是什么颜色（`#rrggbb`） */
    value: string
    /** 出厂是什么颜色 —— 「回到出厂」那一颗要用 */
    shipped: string
    /** 这一档现在的页面底 —— 算「这个色压在底上看得清吗」 */
    bg: string
    /** 这一档现在的正文色 —— 算「字压在这个色上看得清吗」 */
    ink: string
    onclose: () => void
    onpick: (hex: string) => void
    /**
     * 回到出厂 = **把这条覆盖删掉**，不是写一个等于出厂值的数。
     * 两者屏上一样，账上不一样：留着一条「等于出厂值」的覆盖，
     * 以后出厂配色升级时这一项就跟不上了（那正是「只存改过的」要避免的）。
     */
    onclear: () => void
  } = $props()

  let hsl = $state<Hsl>(hexToHsl(value))
  /** 他真的动过吗 —— 没动就不回写（见文件头「没动就不写」） */
  let touched = $state(false)
  const hex = $derived(touched ? hslToHex(hsl) : value)

  function fromText(raw: string): void {
    const h = normalizeHex(raw)
    if (h === null) return
    hsl = hexToHsl(h)
    touched = true
  }

  function useShipped(): void {
    onclear()
  }
</script>

<Dialog
  title={`${zh} · ${token}`}
  confirm="存"
  onclose={onclose}
  onconfirm={() => (touched ? onpick(hex) : onclose())}
>
  {#snippet children()}
    <div class="cpick">
      <!-- 大块预览：滑杆动一格就跟着变，不用眯着眼看 30px 的小方块 -->
      <div class="cpick-prev" style:background={hex}>
        <span class="cpick-hex">{hex}</span>
      </div>

      <label class="cpick-row">
        <span class="m">色相</span>
        <input type="range" min="0" max="360" step="1" value={hsl.h}
          oninput={(e) => ((hsl = { ...hsl, h: +(e.currentTarget as HTMLInputElement).value }), (touched = true))} />
        <span class="m cpick-n">{hsl.h}</span>
      </label>
      <label class="cpick-row">
        <span class="m">浓淡</span>
        <input type="range" min="0" max="100" step="1" value={hsl.s}
          oninput={(e) => ((hsl = { ...hsl, s: +(e.currentTarget as HTMLInputElement).value }), (touched = true))} />
        <span class="m cpick-n">{hsl.s}</span>
      </label>
      <label class="cpick-row">
        <span class="m">明暗</span>
        <input type="range" min="0" max="100" step="1" value={hsl.l}
          oninput={(e) => ((hsl = { ...hsl, l: +(e.currentTarget as HTMLInputElement).value }), (touched = true))} />
        <span class="m cpick-n">{hsl.l}</span>
      </label>

      <!-- ★★ 对比度当场读（2026-09-13）。出厂那套的比值是量过的，
           他一改色那份保证就不成立 —— 只写一句「保证不成立」是对的但不够：
           他改完看不清才发现，那时已经调了半天。
           ★ **只读数不拦**（他是独裁人）。4.5 是**给正文的**，
             图标 / 线 / 大字只要 3:1，所以要说清这个数是拿来比什么的。 -->
      <div class="cpick-cr">
        <span class="m">压页面底</span>
        <b class:warn={+contrastText(hex, bg) < 4.5}>{contrastText(hex, bg)}</b>
        <span class="m">正文压它</span>
        <b class:warn={+contrastText(ink, hex) < 4.5}>{contrastText(ink, hex)}</b>
      </div>
      <div class="m blk zh">
        正文要 <b>4.5</b> 才够看；图标、线、大字 <b>3</b> 就行 —— 低了只提醒，不拦你。
      </div>

      <div class="m blk zh">从别处抄一个色号进来：</div>
      <input class="dlg-in" placeholder="#rrggbb" value={hex}
        oninput={(e) => fromText((e.currentTarget as HTMLInputElement).value)} />

      <div class="pillrow">
        <button class="pill" onclick={useShipped}>
          <span class="zh">回到出厂</span>
          <span class="csw" style:background={shipped}></span>
        </button>
      </div>
    </div>
  {/snippet}
</Dialog>
