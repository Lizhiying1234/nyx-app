<script lang="ts">
  /**
   * Nyx Toggle —— DS v5 §16.2「轨道点亮，星醒过来」。
   *
   * ★ 为什么不是系统 Switch（使用者第十三则 §十二「Toggle 不用默认 Switch」）：
   *   系统开关是 Material 的脸（D-327 禁）。这一个的两个状态用的是
   *   **Nyx 自己的星**：OFF 空心核 / ON 实心核 —— 与屏幕上的 Assist 星
   *   做着完全一样的事，于是「开关」与「星醒了」在视觉上是同一句话，不需要教。
   *
   * ★ 为什么 ON 的轨道是荧光不是紫（§16.2）：
   *   荧光在 v5 里的语义就是「醒着」，而且它**只做底不做字**
   *   （当字压浅底 1.25:1 不合格）。一个开关的轨道正好是个底 ——
   *   语义与技术限制在这里刚好对上。
   *
   * ★ D-227：这个文件里一行样式都没有。
   */
  let {
    on,
    label,
    busy = false,
    onchange
  }: {
    on: boolean
    /** 无障碍名 —— 开关本身没有可见文字，读屏要靠它 */
    label: string
    /**
     * ★ 第三态「正在生效」（ST-Q6 定案）：改这个设置要等一下的时候
     * （打开同步要连一次 · 开 Assist 要写状态再问系统授权）。
     * 此前只有开 / 关两态，于是那一段等待期**点了没反应** ——
     * 人会再点一次，或者以为坏了。
     * ★ 不转圈（全应用不用 spinner）：旋钮停在半路 + 呼吸，
     *   「它正在从这边走到那边」本身就是那句话。
     */
    busy?: boolean
    onchange: () => void
  } = $props()
</script>

<button
  class="tg"
  role="switch"
  aria-checked={on}
  aria-busy={busy ? 'true' : undefined}
  aria-label={label}
  disabled={busy}
  onclick={onchange}
>
  <span class="kn">
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <use href={on ? '#nyx-star-16' : '#nyx-core-o'} />
    </svg>
  </span>
</button>
