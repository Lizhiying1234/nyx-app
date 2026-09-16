<script lang="ts">
  import { SILENCE_FILTER_NAME } from '@core/silence.ts'
  import Skel from './Skel.svelte'
  import { TRASH_DAYS, TRASH_PURGE_TEXT } from '@core/sql/trash.ts'
  import Dialog from './Dialog.svelte'
  import type { TrashBucket } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import Ic from './Ic.svelte'
  import { say } from './toast.svelte.ts'

  let { onchanged }: { onchanged?: () => void } = $props()

  type View = { k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; buckets: TrashBucket[] }
  let view = $state<View>({ k: 'loading' })

  /**
   * I-075 · 勾选与批量
   *
   * 使用者：「垃圾箱里应该可以勾选，然后一起恢复或者一起彻底删除。」
   * 键就是 `kind:id` —— 四类对象的 id 各自独立，光用 id 会撞。
   */
  let picked = $state<Set<string>>(new Set())
  const keyOf = (kind: string, id: number): string => `${kind}:${id}`
  const isPicked = (kind: string, id: number): boolean => picked.has(keyOf(kind, id))

  function toggle(kind: string, id: number): void {
    const k = keyOf(kind, id)
    const next = new Set(picked)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    picked = next
  }

  /** 全选 / 全不选：已经全勾上了就当作「取消」 */
  function toggleAll(): void {
    if (view.k !== 'ok') return
    const all = view.buckets.flatMap((b) => b.rows.map((r) => keyOf(b.kind, r.id)))
    picked = picked.size === all.length ? new Set() : new Set(all)
  }

  const picks = $derived(
    [...picked].map((k) => {
      const [kind, id] = k.split(':')
      return { kind: kind as TrashBucket['kind'], id: Number(id) }
    })
  )

  async function load(): Promise<void> {
    try {
      view = { k: 'ok', buckets: await window.nyx.browse.trash() }
      // 列表变了，勾选里可能有已经不存在的行 —— 清掉，别让计数骗人
      if (picked.size > 0) {
        const live = new Set(view.buckets.flatMap((b) => b.rows.map((r) => keyOf(b.kind, r.id))))
        picked = new Set([...picked].filter((k) => live.has(k)))
      }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }
  load()

  async function restore(kind: TrashBucket['kind'], id: number, title: string): Promise<void> {
    try {
      const n = await window.nyx.browse.restore(kind, id)
      // D-090 · 恢复 lecture 时跟着删掉的知识点一起回来。
      // 只恢复空壳而使用者以为东西回来了，比不恢复更糟 —— 所以要说清恢复了多少。
      say(
        kind === 'lecture' && n > 1
          ? `「${title}」回来了，跟它一起删掉的 ${n - 1} 条知识点也一并恢复了。`
          : `「${title}」回来了。`
      )
      await load()
      onchanged?.()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  let busy = $state(false)

  async function restorePicked(): Promise<void> {
    if (picks.length === 0) return
    busy = true
    try {
      const n = await window.nyx.browse.restoreMany(picks)
      say(
        n === picks.length
          ? `${n} 项回来了。`
          : `恢复了 ${n} 项，另外 ${picks.length - n} 项没能恢复（多半是已经过了 ${TRASH_DAYS} 天被清掉了）。`
      )
      picked = new Set()
      await load()
      onchanged?.()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    } finally {
      busy = false
    }
  }

  /**
   * 彻底删除要先问一句 —— 这一步没有后悔药。
   * 用应用内的确认块，不用系统 confirm（`confirm()` 在 Electron 里会卡住渲染进程）。
   */
  let confirming = $state(false)

  async function purgePicked(): Promise<void> {
    if (picks.length === 0) return
    busy = true
    try {
      const n = await window.nyx.browse.purgeMany(picks)
      say(`彻底删掉了 ${n} 项 —— 这些数据没了，也不会再被统计。`)
      picked = new Set()
      confirming = false
      await load()
      onchanged?.()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    } finally {
      busy = false
    }
  }

  /**
   * ★ I-202 · 这里原来写死 `30` —— 而真正执行清除的 `main/browse.ts` 用的是 `TRASH_DAYS`（10）。
   *   于是同一屏上：页头「10 天后彻底清除」、正文「保留 10 天」，**而每一行说「还有 21 天」**。
   *   那一行向他承诺了 20 天他其实没有的时间，而彻底删除是立碑永不同步那一档，没有后悔余地。
   * ★ 2026-09-09 把保留期 30 → 10 那次，把**句子**收进了 core（`TRASH_KEEP_TEXT` /
   *   `TRASH_PURGE_TEXT`），漏的正是这个**参与计算的数**。`scripts/check-trash-days.mjs` 从此钉着它。
   */
  const days = (t: number): number =>
    Math.max(0, TRASH_DAYS - Math.floor((Date.now() - t) / 86_400_000))
  const total = $derived(view.k === 'ok' ? view.buckets.reduce((s, b) => s + b.rows.length, 0) : 0)
</script>

<!-- ★ D-484 · 清单 10 的目标：页头（讲的是「这一页的三档删除各是什么」）-->
<div class="vh" data-guide="trash-tiers">
  <h1>回收站</h1>
  <span class="c">{TRASH_PURGE_TEXT}</span>
</div>

{#if view.k === 'error'}
  <div class="errbox" data-testid="trash-error">
    <div class="h">回收站打不开</div>
    <div>{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={load}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <div class="card blk"><Skel rows={3} testid="trash-skel" /></div>
{:else}
  {#if total === 0}
    <!-- D-184 第③类空状态：「空是正常的」，一句平静说明 -->
    <div class="empty" data-testid="trash-empty">
      <div class="i"><Ic n="delete" s={26} /></div>
      <h4>回收站是空的</h4>
      <p>删除的项目、lecture、文件和知识点会在这里保留 {TRASH_DAYS} 天。</p>
    </div>
    <div class="notice" style="margin-top:14px">
      <b>练成和删除是两回事。</b>练成是正向的终点 —— 练到不用再练，数据永久保留；
      删除是负向的清除。<span class="dim">要找不用再练的条目，去 Vault 的「{SILENCE_FILTER_NAME}」，不在这里。</span>
    </div>
  {:else}
    <!-- I-075 · 勾了才出现，和知识库里那条选择条是同一个 .selbar -->
    {#if picked.size > 0}
      <div class="selbar" data-testid="trash-selbar">
        <span>已选 <span class="n" data-testid="trash-selcount">{picked.size}</span> 项</span>
        <span class="sp"></span>
        <button data-testid="trash-selnone" onclick={() => (picked = new Set())}>取消选择</button>
        <button data-testid="trash-purge" disabled={busy} onclick={() => (confirming = true)}>
          彻底删除
        </button>
        <button class="go" data-testid="trash-restore-picked" disabled={busy} onclick={restorePicked}>
          恢复所选 ↩
        </button>
      </div>
    {/if}


    <div style="display:flex;justify-content:flex-end;margin:10px 0 2px">
      <button class="btn sm" data-testid="trash-selall" onclick={toggleAll}>
        {picked.size === total ? '全不选' : '全选'}
      </button>
    </div>

    {#each view.buckets as b (b.kind)}
      {#if b.rows.length > 0}
        <div class="ugrp">{b.label} · {b.rows.length}</div>
        {#each b.rows as r (r.id)}
          <div
            class="lrow"
            class:sel={isPicked(b.kind, r.id)}
            data-testid="trash-{b.kind}-{r.id}"
            role="button"
            tabindex="0"
            onclick={() => toggle(b.kind, r.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggle(b.kind, r.id)
              }
            }}
          >
            <span></span><span class="ck" data-testid="trash-ck-{b.kind}-{r.id}"><Ic n="check" s={10} /></span>
            <span class="lt">{r.title}</span>
            <span class="lg">还有 {days(r.deletedAt)} 天彻底清除</span>
            <span class="ln p">{b.label}</span>
            <button
              class="dt3 xbtn"
              title="恢复"
              aria-label="恢复 {r.title}"
              data-testid="restore-{b.kind}-{r.id}"
              onclick={(e) => {
                e.stopPropagation() // 单条恢复，不要顺手把这一行勾上
                restore(b.kind, r.id, r.title)
              }}>↩</button
            >
          </div>
        {/each}
      {/if}
    {/each}
    <div style="font-size:var(--fs-2);color:var(--muted);margin-top:14px">
      恢复 lecture 时，<b>跟它一起删掉的知识点会一并回来</b>—— 否则恢复回来的是个空壳。
    </div>
  {/if}
{/if}

<!--
  ★ B5 / X-09 · 彻底删除的二次确认也收进**同一种 Dialog**。
    在这之前它是拿 `.errbox` 拼出来的一块（错误框当确认框用）——
    那是 Windows 三种确认形态里的第三种。
  ★ 文案按 IX-13：**彻底删除必须当面说清云端那一份也会抹掉**（D-435 的代价条），
    今天两端一处都没说。这里说了。
-->
{#if confirming}
  <Dialog
    testid="trash-purge-dlg"
    title={`彻底删除这 ${picked.size} 项？`}
    body="这些会真的没了，恢复不回来，也不会再进任何统计。"
    detail={purgeDetail}
    confirmLabel="彻底删除"
    danger
    busy={busy}
    onconfirm={purgePicked}
    oncancel={() => (confirming = false)}
  />
{/if}

{#snippet purgeDetail()}
  <p class="ms" data-testid="trash-purge-cloud">
    云端那一份也会一起抹掉，而且**永不再同步**。别的设备如果还没同步过这几行，
    之后可能把它们（仍是已删状态）推回回收站，到期照样清掉。
  </p>
{/snippet}
