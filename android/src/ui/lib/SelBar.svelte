<script lang="ts">
  import { SILENCE_ACTIONS } from '../../core-link.ts'
  /**
   * 多选栏（①d 定稿 · D-391 第二层）。
   * ★★★ 数字写在脸上：N 永远是**当前已选**，绝不是全库。
   * ★ 零确认（D-379 P1）—— 动作直接执行，撤销交给 Snackbar。
   *   例外是删除：D-412 给确认，那一层在调用方（ItemMenu / 回收站）里。
   *
   * ══ 两种脸（⑨ · 2026-09-01）══════════════════════════════
   *
   * 同一条栏在两处出现，要做的事**不一样**，所以主位那两个按钮由调用方给：
   *
   *   Vault（`kind="practice"`）：认读这 N 条 / 产出这 N 条 —— **现在就练**
   *   讲次页（`kind="manage"`）：转入认读 / 转入练习 —— **改这 N 条的层级**
   *
   * ★ 不合并成一个含糊的标签：「认读这 5 条」和「把这 5 条转入认读」
   *   是两件完全不同的事，写成同一句话是在制造误会。
   *
   * ══ 讲次页还多一对「现在就练」（T-5.18 · D-R28）══════════════
   *
   * 讲次页两样都要：改层级（主位那两个，⑨ 定的，**没动** —— 改既定决议先提，C-001）
   * 和「把选中的这 N 条现在就练一遍」。所以新的一对不挤进主位，自己一行药丸，
   * 只有给了 `onreadnow` / `onprodnow` 的调用方才长出来。
   * 标签仍把 N 写在脸上（D-391 数字随身），并且与 Vault 那两个用**同一句话**
   * （「认读这 N 条」）—— 同一件事在两屏说法不一样，就是下一个误会的开头。
   *
   * ★ D-227：这个文件里一行样式都没有。
   */
  let {
    n,
    kind = 'practice',
    busy = false,
    onread,
    onprod,
    onsilence,
    ondelete,
    onmove,
    onreadnow,
    onprodnow
  }: {
    n: number
    /** practice = 现在就练（Vault）· manage = 改层级（讲次页）*/
    kind?: 'practice' | 'manage'
    busy?: boolean
    onread: () => void
    onprod: () => void
    onsilence: () => void
    ondelete: () => void
    /** 给了才出现 —— 只有「在某一讲里」才谈得上把它移走（⑨）*/
    onmove?: () => void
    /** 给了才出现（T-5.18）—— 现在就认读 / 练习选中的这 N 条，**不改它们的层级** */
    onreadnow?: () => void
    onprodnow?: () => void
  } = $props()
</script>

<div class="selbar">
  <button class="btn pri" disabled={busy} onclick={onread}>
    <span class="zh">{kind === 'manage' ? `转入认读 ${n} 条` : `认读这 ${n} 条`}</span>
  </button>
  <button class="btn sec2" disabled={busy} onclick={onprod}>
    <span class="zh">{kind === 'manage' ? `转入练习 ${n} 条` : `产出这 ${n} 条`}</span>
  </button>
  {#if onreadnow && onprodnow}
    <!-- ★ T-5.18 · 「现在就练」走 ids 那条既有入口（testCardsByIds / queueByIds）：
         判分照写 review_logs / answers / sessions、SM-2 照更新 —— 练了就算数（D-R28）。 -->
    <div class="pillrow">
      <button class="pill" disabled={busy} onclick={onreadnow}>认读这 {n} 条</button>
      <button class="pill" disabled={busy} onclick={onprodnow}>练习这 {n} 条</button>
    </div>
  {/if}
  <div class="pillrow">
    <button class="pill" disabled={busy} onclick={onsilence}>{SILENCE_ACTIONS.shelve}</button>
    {#if onmove}
      <!-- ★ 「移动」回来了（⑨）。它当初被拿掉是因为**方法未定**（D-354
           「两端同款方法一起定」）——「只会道歉的按钮没有价值」。
           现在方法定在 core/move-items.ts，两端同一份，所以按钮可以出现了。 -->
      <button class="pill" disabled={busy} onclick={onmove}>移动</button>
    {/if}
    <span class="sp"></span>
    <button class="pill w" disabled={busy} onclick={ondelete}>删除</button>
  </div>
</div>
