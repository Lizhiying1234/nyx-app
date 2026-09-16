<script lang="ts">
  /**
   * 统一 Dialog —— 全应用唯一的居中弹窗原语（2026-08-29 质量审计根因 ②）。
   *
   * ══ 规范（随 D-393 冻结进 DS §10.8）══════════════════════════
   *   位置：**屏幕视觉中心**（55% 高度轴上偏一点，比几何中心自然）
   *   面：paper · 圆角 = --r-sheet(14) · 影 = --e-menu · 宽 = min(320, 屏-48)
   *   构成：标题（钉住）→ 内容区（**可滚，上限 60vh**）→ 动作行（钉住）
   *   系统返回 = 取消（registerBack）；点遮罩 = 取消。
   *
   * ══ 两种形态（INTERACTION_RULES §一 末 · 总控 2026-09-08 裁）══
   *   **双动作**（默认）：「取消」+ 确认。
   *   **单动作**（`single`）：只有一个出路的（告知 · 空态 · 「知道了」）——
   *     **只给一颗 Ghost「关闭」**。此前查重那个弹窗传 `confirm="关闭"`，
   *     于是屏上并排出现「取消」和「关闭」两颗同义键 —— TM-58 说
   *     「Ghost 一律『关闭』，对话框否定键一律『取消』」，两颗并排就是把它违反了一次。
   *   ★ 两种形态都住在这一个原语里，不许各屏自己拼。
   *
   * ══ 高度上限是全局的 ══
   *   内容区 `max-height: 60vh`（手机档；桌面 70vh 是 Windows 的事），
   *   头与动作栏钉住、只有内容区滚。此前查重那一屏自己加了 `.dlg-scroll`（46vh），
   *   那是局部临时件，已随本轮删掉。
   *
   * ★ 浮层家族三型自此定形：Dialog 居中 · ⋮ 菜单居中窄卡 · Sheet 贴底。
   * ★ D-227：零样式。
   */
  import { registerBack } from './backstack.svelte.ts'

  let {
    title,
    input = null,
    placeholder = '',
    confirm = '好',
    danger = false,
    onclose,
    onconfirm,
    allowEmpty = false,
    multiline = false,
    single = false,
    children = undefined
  }: {
    title: string
    /** 传字符串 = 带输入框的对话框，值为初始文本；null = 纯确认 */
    input?: string | null
    placeholder?: string
    confirm?: string
    danger?: boolean
    onclose: () => void
    onconfirm: (value: string) => void
    /** 空值也放行（新建走默认名规则时用） */
    allowEmpty?: boolean
    /** 多行文本（AI Prompt 这类段落值）—— Enter 换行，提交走按钮 */
    multiline?: boolean
    /** 单动作形态：只有一个出路时只给一颗 Ghost「关闭」（见文件头） */
    single?: boolean
    /** 输入框上方的自定内容（层选择这类小控件）—— 仍是同一原语，不另造弹窗 */
    children?: import('svelte').Snippet
  } = $props()

  let value = $state(input ?? '')

  // 系统返回先关我（消费顺序 ①）
  $effect(() => registerBack(() => (onclose(), true)))

  function commit(): void {
    const v = value.trim()
    if (input !== null && !v && !allowEmpty) return
    onconfirm(v)
  }
</script>

<div
  class="scrim"
  role="button"
  tabindex="-1"
  aria-label="关掉"
  onclick={onclose}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
></div>

<div class="dialog" role="dialog" aria-modal="true" aria-label={title}>
  <div class="dlg-t zh">{title}</div>
  <!-- 内容区 = 唯一会滚的那一块；标题与动作行钉在外面 -->
  <div class="dlg-body">
  {#if children}{@render children()}{/if}
  {#if input !== null}
    {#if multiline}
      <!-- svelte-ignore a11y_autofocus -->
      <textarea class="dlg-in ta" bind:value {placeholder} autofocus rows="5"></textarea>
    {:else}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="dlg-in"
        bind:value
        {placeholder}
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    {/if}
  {/if}
  </div>
  <div class="dlg-acts">
    {#if single}
      <button class="btn sm gh" onclick={onclose}>关闭</button>
    {:else}
      <button class="pill" onclick={onclose}>取消</button>
      <button class="pill" class:v={!danger} class:w={danger} onclick={commit}>{confirm}</button>
    {/if}
  </div>
</div>
