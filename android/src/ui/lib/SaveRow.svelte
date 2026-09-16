<script lang="ts">
  /**
   * 「收进 Atlas」操作行 —— **Lookup 两种模式共用的同一条行**（T-5.9①）。
   *
   * ══ 为什么它得是个组件 ═══════════════════════════════════
   *
   * 在这之前，「收进 Atlas」只长在**词典模式**的分支里：切到 AI 搜索，
   * 整条行连同状态、确认条一起消失 —— 也就是说 AI 搜索**根本收不了词**。
   * 而「收进 Atlas」是 Lookup 的核心共同能力，不是词典模式的附属功能。
   *
   * 现在这条行由父层渲染**一次**，摆在结果之上、两种模式之外 ——
   * 所以「两种模式看到的是同一条行」不是靠两处写得一样来保证的，
   * 是**结构上只有一条**。这比「两份代码保持同步」强一个数量级。
   *
   * ══ 这里没有判据 ═══════════════════════════════════════
   *
   * 收下走 `capture.ts::assistCapture`（与气泡同一条路，写入 `captureAt`
   * 一个字没动）；状态来自 `assistStatus`；落点由 `resolveSaveTarget(origin)`
   * 判（T-5.9②）。本组件只负责摆上屏，回调全部交回父层。
   *
   * ★ D-227 · 零组件样式：`.lk-act` / `.lk-into` / `.lk-save` 都在全局样式表里，
   *   这里一条 `<style>` 都没有。
   */
  import { DUP_COLLECT } from './copy.ts'
  import type { AssistStatus, CaptureResult } from '../../db/capture.ts'

  let {
    status,
    saved,
    layer,
    busy = false,
    onsave,
    onlayer,
    onspeak
  }: {
    /** L0 直查结果；`null` = 还没查出来（换词的那一瞬） */
    status: AssistStatus | null
    /** 收下之后的回执；`null` = 还没收 */
    saved: CaptureResult | null
    layer: 'A' | 'B'
    busy?: boolean
    onsave: () => void
    onlayer: (l: 'A' | 'B') => void
    onspeak: () => void
  } = $props()

  function stateLine(s: AssistStatus): string {
    if (!s.known) return '不在 Atlas'
    return `在 Atlas${s.productionState ? ` · ${s.productionState.toUpperCase()}` : ''}${s.lectureName ? ` · ${s.lectureName}` : ''}`
  }
</script>

{#if saved === null}
  <!-- ★★ B-2 的靶子挂在**这条行**上，不在「收进 Atlas」那颗按钮上（U-1，同 Windows T-1）。
       按钮是**双重设门**的：`saved === null` 之外还要 `!status?.known` ——
       也就是查一个**已经收过的词**时它根本不在，靶子跟着没有，这一条就永远不出。
       而这条行在收下之前的三态都在（还没查出来 · 不在 Atlas · 已在 Atlas），
       两种模式（词典 / AI 搜索）也共用它。
       ★ 记一笔：已在 Atlas 那一态里，这颗键不在屏上，而框上那句仍在讲「收下之后会怎样」。
         这是 T-1「三态都在」明码换来的，不是漏掉；两端同一个取舍。
       ★ core 那句 2026-09-15 已改成**不点名按钮**（D-489 ④，`GD-11` 钉着）——
         所以这颗键后来从「收进 Atlas ›」改名成「收下 ›」时，那句话不用跟着改。
         这正是「不点名」换来的东西。 -->
  <div class="li lk-act" data-guide="lookup-save">
    <button class="spk dim" aria-label="朗读" onclick={onspeak}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><use href="#nyx-speak" /></svg>
    </button>
    {#if status}<span class="g m">{stateLine(status)}{#if status.known && (status.recollected ?? 0) > 0} ×{status.recollected}{/if}</span>
    {:else}<span class="g"></span>{/if}
    {#if !status?.known}
      <button class="m lk-save" disabled={busy} onclick={onsave}>收下 ›</button>
    {/if}
  </div>
{:else}
  <!-- 已收下确认条（D-376 同 Assist ⑫：INTO 路径 · 可翻可记忆） -->
  <div class="li lk-into">
    <span class="g"><span class="m">INTO</span>&nbsp;<span class="zh s12">{saved.pathLabel}</span>
      {#if saved.duplicateOf !== null}<span class="tag t-c gap">{DUP_COLLECT}</span>{/if}</span>
  </div>
  <div class="li lk-act">
    <!-- ★★ 收下之后喰叭不能消失（使用者 2026-09-09）。
         以前这条分支只有 LINE + A/B：一收进 Atlas，朗读就没了 ——
         而那正是最想听一遍的时候（刚把一个词收进来）。
         ★ 位置和未收下那条完全一致（行首第一个）——
           收下前后它待在**同一列**，手不用重新找。 -->
    <button class="spk dim" aria-label="朗读" onclick={onspeak}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><use href="#nyx-speak" /></svg>
    </button>
    <span class="g m">LINE</span>
    <span class="seg">
      <button class:sel={layer === 'A'} onclick={() => onlayer('A')}>理解层 A</button>
      <button class:sel={layer === 'B'} onclick={() => onlayer('B')}>写作层 B</button>
    </span>
  </div>
{/if}
