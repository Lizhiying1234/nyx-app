<script lang="ts">
  /**
   * 画一个 Nyx 图标 —— 几何来自 **`core/icons.ts`（两端唯一一份）**，
   * 经 `Sprite.svelte` 铺成 `<defs>`；这里**一条路径都不画**（DS §4.3）。
   *
   * ★ DS §4.5：active / inactive = sparkle 实心 / 空心，**轮廓完全不变**。
   *   所以这里不是换图标，是换后缀 `-o`。
   *
   * ★ D-227：这个文件里**一行样式都没有**。
   */
  let {
    name,
    on = true,
    size = 22,
    cls = ''
  }: {
    /** `study` / `lookup` / `settings` / `caret` / `more` / `speak` … */
    name: string
    /** 有 `-o` 那一版的图标才吃这个（Tab 的 active / inactive） */
    on?: boolean
    size?: number
    cls?: string
  } = $props()

  /** 有空心版的（Tab 用）—— 别的传 `on` 也没用，直接用实心 */
  const HAS_OUTLINE = new Set(['study', 'lookup', 'settings', 'star', 'vault'])
  const href = $derived(`#nyx-${name}${!on && HAS_OUTLINE.has(name) ? '-o' : ''}`)
</script>

<svg
  class="ic {cls}"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
>
  <use href={href} />
</svg>
