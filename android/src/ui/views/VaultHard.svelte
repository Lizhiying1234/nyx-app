<script lang="ts">
  /**
   * 攻坚区（①e 上半 · D-352 给）。
   * ★ 行 = 进攻坚次数与上次作答时间 —— 状态事实与行为计数（D-362）；
   *   **无诊断文本**（D-348 有意隐藏：Windows 的 diagnosis 列不取不显）。
   * ★ 「练攻坚」阶段 4 接（队列通道已定）；行 ⋮ 给静默/删除真动作。
   */
  import { CANT_READ, deletedItems } from '../lib/copy.ts'
  import { untrack } from 'svelte'
  import { store } from '../lib/store.svelte.ts'
  import { snacks } from '../lib/snack.svelte.ts'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import { loadHardList, type HardListRow } from '../../db/vault-lists.ts'
  import { bulkSilence, softDeleteItems, undoDeleteItems } from '../../db/manage.ts'
  import { SILENCE_ACTIONS, TRASH_DAYS } from '../../core-link.ts'

  let { onopen, onback }: { onopen: (id: number) => void; onback: () => void } = $props()

  let rows = $state<HardListRow[]>([])
  let stat = $state<'loading' | 'ok' | 'error'>('loading')
  let err = $state('')
  let note = $state<string | null>(null)
  let busy = $state(false)
  let menu = $state<HardListRow | null>(null)

  async function load(): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      rows = await loadHardList(store.db.db)
      stat = 'ok'
    } catch (e) {
      stat = 'error'
      err = (e as Error)?.message ?? String(e)
    }
  }
  $effect(() => {
    untrack(() => {
      void load()
    })
  })
  $effect(() => {
    if (menu === null) return
    return registerBack(() => ((menu = null), true))
  })

  function toast(msg: string, undo?: () => Promise<void>): void {
    snacks.show(msg, undo)
  }
  async function afterWrite(): Promise<void> {
    menu = null
    await load()
    await store.reloadCounts()
  }

  async function doSilence(id: number): Promise<void> {
    if (store.db.k !== 'ok' || busy) return
    const db = store.db.db
    busy = true
    try {
      await bulkSilence(db, [id], true)
      await afterWrite()
      toast(`已${SILENCE_ACTIONS.shelve} 1 条`, async () => {
        await bulkSilence(db, [id], false)
        await afterWrite()
      })
    } catch (e) {
      note = `没能${SILENCE_ACTIONS.shelve}：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }
  async function doDelete(id: number): Promise<void> {
    if (store.db.k !== 'ok' || busy) return
    const db = store.db.db
    busy = true
    try {
      await softDeleteItems(db, [id])
      await afterWrite()
      toast(deletedItems(1), async () => {
        await undoDeleteItems(db, [id])
        await afterWrite()
      })
    } catch (e) {
      note = `删除没写成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  const fmtDay = (at: number): string => {
    const d = new Date(at)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
</script>

<div class="view">
  <!-- ★ 子页屏顶（与 Lecture 同一形态）：back + 坐标，标题另起一行 -->
  <div class="top" style="gap:8px">
    <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
    </button>
  </div>

  {#if note}<div class="note" role="status">{note}</div>{/if}

  {#if rows.length > 0}<div class="vhead"><span class="tag t-w">{rows.length} 待练</span></div>{/if}

  {#if stat === 'error'}
    <div class="empty tight"><div class="t zh2">{CANT_READ}</div><div class="s">{err}</div></div>
  {:else if stat === 'ok' && rows.length === 0}
    <div class="empty tight">
      <div class="t zh2">攻坚区是空的</div>
      <div class="s">连错达到阈值的知识点会自己进来 —— 现在一条都没有。</div>
    </div>
  {:else}
    <button class="btn mt3" onclick={() => (note = '这颗还没接上 —— 攻坚还不能整批练。可以点开下面某一条单独练。')}>
      <span class="zh">练攻坚</span>
    </button>
    <div class="set">
      {#each rows as r (r.id)}
        <div class="li">
          <button class="hit" onclick={() => onopen(r.id)}>
            <span class="g">
              <span class="term">{r.term}</span>
              <small>第 {r.hardEntries} 次进攻坚{#if r.lastAt !== null}&nbsp;· 上次 {fmtDay(r.lastAt)}{/if}</small>
            </span>
          </button>
          <button class="ibtn sm" aria-label="这条的操作" onclick={() => (menu = r)}><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if menu !== null}
    {@const r = menu}
    <button class="scrim" aria-label="关闭" onclick={() => (menu = null)}></button>
    <div class="menu" role="menu">
      <div class="mhead"><span class="term">{r.term}</span></div>
      <button class="mi" onclick={() => void doSilence(r.id)}><span class="zh">{SILENCE_ACTIONS.shelve}这条</span></button>
      <button class="mi dg" onclick={() => void doDelete(r.id)}><span class="zh">删除这条</span></button>
    </div>
  {/if}

</div>
