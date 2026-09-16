<script lang="ts">
  /**
   * 数据安全通知的开关行（D-373）—— 只有两类（积压/连败），可整体关。
   * 判据在 db/notify.ts；这里只有开关 + 权限如实显示。
   */
  import Toggle from './Toggle.svelte'
  import { store } from './store.svelte.ts'
  import { notifyEnabled, notifyPermission, setNotifyEnabled } from '../../db/notify.ts'

  let on = $state<boolean | null>(null)
  let granted = $state<boolean | null>(null)

  let loaded = false
  $effect(() => {
    if (store.db.k !== 'ok' || loaded) return
    loaded = true
    const db = store.db.db
    void (async () => {
      on = await notifyEnabled(db)
      try {
        granted = (await notifyPermission.state()).granted
      } catch {
        granted = null // 浏览器台上没有原生面 —— 行上如实显示「？」
      }
    })()
  })

  async function toggle(): Promise<void> {
    if (store.db.k !== 'ok' || on === null) return
    const next = !on
    await setNotifyEnabled(store.db.db, next)
    on = next
    if (next) {
      // 开的这一刻顺手把系统权限要了 —— 不然开了也发不出去
      try {
        granted = (await notifyPermission.ensure()).granted
      } catch {
        granted = null
      }
    }
  }
</script>

<!-- ★ 开关行（DS §10.2c）：行本身不可点，Toggle 就是它的脸。
     去掉满幅灰底 —— 一级行一律无底色（§10.2d）。 -->
<div class="li">
  <span class="g"><span class="zh s12">数据安全通知</span>
    <small class="zh">只有待上传积压与同步连败 —— 不发学习提醒</small></span>
  {#if on === null}
    <span class="tag t-m">…</span>
  {:else}
    <Toggle {on} label="数据安全通知" onchange={() => void toggle()} />
  {/if}
</div>
{#if on && granted === false}
  <!-- ★ 二级从属行：灰底在这里才有意义 -->
  <div class="li sunkli p1">
    <span class="g"><span class="zh s12">系统没给通知权限</span>
      <small class="zh">开关开着但发不出去 —— 去系统设置 → 应用 → Nyx → 通知里放行</small></span>
    <span class="tag t-w">要放行</span>
  </div>
{/if}
