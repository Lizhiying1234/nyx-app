<script lang="ts">
  /**
   * Banner（常驻条）· 浮层家族里唯一「不能手动关」的那一型
   * —— NOTIFICATION_RULES §一 · NT-Q2 · B4
   *
   * ══ 它什么时候出现 ══════════════════════════════════════════
   * **只有一件事挡着他往下走**的时候。今天全应用只有一个用法：
   * 同步**连败 ≥3 次**。1–2 次不出现 —— 那由入口上那枚静态标记（Badge）说，
   * 因为单次失败大多是网络抖，不值得打断。
   *
   * ══ 三条形态规矩（照 §一 那张表）══════════════════════════
   *   位置：内容区顶部，**不盖内容**（所以它在流里，不是 fixed）
   *   停留：**直到条件消失** —— 同步成功了它自己就没了
   *   关闭：**不能手动关**（关了问题还在，那是把事实藏起来）
   *   动作：**一颗按钮去修**（去设置 › 数据），不是一句「知道了」
   *
   * ★ 文案说真话（D-412 / D-409）：说清「连了几次没成」和「后果是什么」，
   *   不说「出错了」这种没有信息的话。学习记录在同步成功前是孤本（D-249）。
   * ★ D-227：这个文件里一行样式都没有。
   */
  import { route } from './route.svelte.ts'
  import { store } from './store.svelte.ts'
  import { FAIL_AFTER } from '../../db/notify.ts'
</script>

{#if store.syncFail >= FAIL_AFTER}
  <div class="banner" role="status">
    <span class="bn-t zh">
      已经连续 {store.syncFail} 次没同步成功 —— 这段时间的学习记录只在这台手机上。
    </span>
    <button
      class="btn sm"
      onclick={() => {
        route.goTab('settings')
        route.push({ k: 'pg', pg: 'data' })
      }}
    >
      <span class="zh">去看看</span>
    </button>
  </div>
{/if}
