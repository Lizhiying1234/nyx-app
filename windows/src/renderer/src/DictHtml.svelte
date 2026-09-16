<script lang="ts">
  /**
   * 词典原文 · 关在 Shadow DOM 里 · D4.4（2026-08-20）
   *
   * ══ 为什么必须是 Shadow DOM ★★★ ═══════════════════════════
   *
   * 词典自带的 CSS 是**别人写的、给整页用的**：`oald10.css` 186 KB 里
   * 全是 `body{…}` `a{…}` `div{…}` 这种全局选择器。注进主文档 = 整个 Nyx 被改版，
   * 而 CLAUDE.md 第七节那条铁律（样式零重写、总原型就是软件的 CSS）当场作废。
   *
   * Shadow DOM 是**唯一**能让词典 CSS 生效、又出不去的办法：
   *   · 里面的选择器匹配不到外面的元素
   *   · 外面的样式也进不来（除了继承来的字号颜色，那正是我们要的）
   *
   * ══ 这里不做消毒 ★★ ═══════════════════════════════════════
   *
   * HTML 与 CSS 在**主进程**就消毒完了（`core/dict/html/sanitize.ts`）：
   * `<script>`、`on*`、`javascript:`、外链、`@import` 一个不留，
   * 资源引用换成了 `data-nyx-img` / `data-nyx-audio`。
   *
   * 判据放在 core 是有意的：那边是纯函数，能被单元测试逐条钉死；
   * 放在组件里就只能靠「记得」，而这个项目已经为「靠记得」翻过四次车。
   */
  interface Props {
    /** 已经消毒过的词典 HTML */
    html: string
    /** 已经消毒过的词典 CSS（可能是空的 —— LDOCE5 就没有） */
    css: string
    /** 拿 ref 换一条资源。取不到返回 null */
    fetchRef: (ref: string) => Promise<string | null>
    /**
     * ★★ 正文里那个喇叭点下去，而**浏览器放不了这条**（使用者 2026-09-14 第四条）。
     *
     * 实测（他机器上，2026-09-14）：默认那本 LDOCE5 的发音是 **Speex**
     * （`data:audio/ogg; codecs=speex`），Chromium 放不了。而 `counter` 这一条
     * 正文里有 **14 个** `data-nyx-audio` 的喇叭图标 —— 每一个都点得动、
     * 点了**悄无声息**：`new Audio(url).play()` 抛出去被 catch 吞掉了。
     * 他报的「语音没有正常显示 / 使用」就是这个。
     *
     * ★ 这一层**不做判断也不做补救**，只把「这条放不了」报上去 ——
     *   放不了之后该怎么办（退到系统语音？说一句？）是卡那一层的事。
     */
    onUnplayable?: (mime: string) => void
    /**
     * 这本给的是纯文本（不是 HTML）。
     * ★ 那就要保住它自己的换行 —— HTML 默认会把换行折成空格，
     *   一本排得整整齐齐的纯文本词典会被揉成一大段。
     */
    plain?: boolean
  }
  const { html, css, fetchRef, plain = false, onUnplayable }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)
  let shadow: ShadowRoot | null = null

  /**
   * ★ 每次内容变了都重建里面的东西，但 **ShadowRoot 只 attach 一次** ——
   *   同一个元素上 attach 第二次会抛。
   */
  $effect(() => {
    if (!host) return
    shadow ??= host.attachShadow({ mode: 'open' })
    const root = shadow
    root.innerHTML = ''

    const style = document.createElement('style')
    /**
     * 先给一层**兜底**：词典没有自带样式时（LDOCE5），
     * 至少别让 `<font>` 那种老标签把字撑得没法看。
     * 然后才是词典自己的 CSS —— 后写的赢。
     */
    style.textContent =
      ':host{all:initial;display:block;font-family:var(--font);font-size:var(--fz-body-ui);line-height:1.6;color:var(--color-text)}' +
      'img{max-width:100%;height:auto}a{text-decoration:none;color:inherit}' +
      '[data-nyx-audio]{cursor:pointer}' +
      (plain ? '.nyx-plain{white-space:pre-wrap}' : '') +
      css
    root.appendChild(style)

    const box = document.createElement('div')
    if (plain) box.className = 'nyx-plain'
    box.innerHTML = html
    root.appendChild(box)

    /**
     * ★★ 图片是**按需**取的：卡片显示出来之后才去要字节。
     *   `data-nyx-img` 里是 ref，不是路径 —— 渲染层从头到尾不知道文件在哪。
     */
    for (const el of Array.from(box.querySelectorAll('[data-nyx-img]'))) {
      const ref = el.getAttribute('data-nyx-img')
      if (!ref) continue
      void fetchRef(ref).then((url) => {
        if (url && el instanceof HTMLImageElement) el.src = url
      })
    }

    /** 点一下就放 —— 同样是点了才去取字节 */
    box.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement | null)?.closest?.('[data-nyx-audio]')
      const ref = t?.getAttribute('data-nyx-audio')
      if (!ref) return
      e.preventDefault()
      void fetchRef(ref).then((url) => {
        if (!url) return
        /**
         * ★★ **先问浏览器放不放得了，再放**（使用者 2026-09-14 第四条）。
         *   `canPlayType` 是浏览器自己的答案 —— 这是一个运行期能力问题，
         *   不是产品判断，所以判据就该问它，不该我们自己列一张格式白名单
         *   （列了就是第二份判据，而两份必然漂）。
         * ★ 空串 = 放不了。`'maybe'` / `'probably'` 都算能放。
         */
        const mime = url.slice(5, url.indexOf(';base64,'))
        const audio = new Audio()
        if (mime && audio.canPlayType(mime) === '') {
          onUnplayable?.(mime)
          return
        }
        audio.src = url
        void audio.play().catch(() => {
          /** ★ 真放的时候还是可能失败（编码坏了）—— 一样报上去，别静默 */
          onUnplayable?.(mime)
        })
      })
    })
  })
</script>

<div class="dcw-html" data-testid="dict-shadow" bind:this={host}></div>
