<script lang="ts">
  /**
   * Assist 浮层（⑪/⑫ 帧为验收样 · ASSIST_CONTRACT 离线半场）。
   *
   *   L0 认出：本地库直查 —— 「在 Atlas · TRAINING · 讲次名」或「不在 Atlas」；
   *           账本判决如实提一句（R-027：你删过/静默过它）
   *   L2a 释义：本地词典下一件 —— 现在**静默留白**（D-338：词典没命中不摆话）
   *   L1 收下：D-376 默认 A + seg 可翻可记忆（assist.lastLayer，本机）；
   *           收下 → ⑫ 确认条（INTO 路径 · LINE seg · 尾声句）
   *   MORE（深一点·需网 = L2c 直连 AI）与 spk：后续小件，todo 如实说
   * ★ D-334 零输入：这屏没有输入框。★ D-227 零样式。
   */
  import { DUP_COLLECT } from '../lib/copy.ts'
  import { untrack } from 'svelte'
  import { SILENCE_ACTIONS } from '../../core-link.ts'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import { store } from '../lib/store.svelte.ts'
  import { speak } from '../../db/tts.ts'
  import { assist } from '../lib/assist.svelte.ts'
  import {
    assistCapture,
    assistStatus,
    ledgerVerdicts,
    type AssistStatus,
    type CaptureResult
  } from '../../db/capture.ts'

  let {
    text,
    pkg,
    quote = null
  }: { text: string; pkg: string | null; quote?: string | null } = $props()

  const t0 = text
  const p0 = pkg
  const q0 = quote

  let status = $state<AssistStatus | null>(null)
  let verdicts = $state<string[]>([])
  let layer = $state<'A' | 'B'>('A')
  let saved = $state<CaptureResult | null>(null)
  let busy = $state(false)
  let note = $state<string | null>(null)

  const close = (): void => {
    assist.open = null
  }
  $effect(() => registerBack(() => (close(), true)))

  /** ★ 冷启动时机（2026-08-30 真机修）：分享把 app 拉起时库还在开 ——
   *  依赖 store.db.k，ok 那一刻跑一次；不然 L0 状态永远停在「…」 */
  let loaded = false
  $effect(() => {
    if (store.db.k !== 'ok' || loaded) return
    loaded = true
    const db = store.db.db
    untrack(() => {
      void (async () => {
        status = await assistStatus(db, t0)
        verdicts = await ledgerVerdicts(db, t0)
        // ★★ ⑩（2026-09-01 使用者）：**所有新收下的知识点默认认读 A**。
        //   「只有用户之后主动重新设置，才可以变成练习」——
        //   所以这里**不再读 assist.lastLayer 当默认值**（D-376「翻过就记住」
        //   那半条被这一条修订：记忆会让下一次收下悄悄落进 B）。
        //   ★ lastLayer 这个键仍然写（pickLayer 里），只是不再决定默认档；
        //     留着是因为它记录的是「他上一次的选择」这个事实，不是默认策略。
      })()
    })
  })

  async function pickLayer(l: 'A' | 'B'): Promise<void> {
    layer = l
    if (store.db.k !== 'ok') return
    const db = store.db.db
    await db.run(
      `insert into settings (key, value, updated_at) values ('assist.lastLayer', ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [l, Date.now()]
    )
    // D-376 · 确认条上翻层 = 当场改**刚收下那条**（自己刚建的内容，不是 D-302 管的既有内容）
    if (saved) {
      await db.run(`update items set layer = ?, updated_at = ? where id = ?`, [l, Date.now(), saved.id])
      saved = { ...saved, layer: l }
    }
  }

  async function save(): Promise<void> {
    if (store.db.k !== 'ok' || busy) return
    busy = true
    try {
      // ★ T-5.9② · `'assist'` = 这一条是气泡收的（Lookup 那侧传 'lookup'）
      saved = await assistCapture(store.db.db, t0, layer, p0, 'assist', null, q0)
      await store.reloadCounts()
      await store.reload()
    } catch (e) {
      note = `没收成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  const stateLine = (s: AssistStatus): string => {
    if (!s.known) return '不在 Atlas'
    const st = s.cardSilent && s.productionState !== 'silent' ? 'RC-SILENT' : (s.productionState ?? '').toUpperCase()
    return `在 Atlas · ${st}${s.lectureName ? ` · ${s.lectureName}` : ''}`
  }
  const VERDICT_ZH: Record<string, string> = {
    deleted: '你删过它 —— 收下会把「以后别再收」那笔撤掉',
    silenced: `你把它${SILENCE_ACTIONS.shelve}过（我会了）`,
    purged: '你彻底删过它'
  }
</script>

<div class="assist-wrap">
  <button class="scrim" aria-label="关掉" onclick={close} style:z-index="-1"></button>

  {#if !saved}
    <!-- ⑪ 气泡：L0 状态 + 收下（零输入 D-334） -->
    <div class="bubble">
      <div class="bt">
        <span class="bterm">{t0}</span>
        <span class="sp"></span>
        <button class="spk dim" aria-label="朗读"
          onclick={() => { if (store.db.k === 'ok') void speak(store.db.db, t0).then((n) => { if (n) note = n }) }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><use href="#nyx-speak" /></svg>
        </button>
      </div>
      <div class="bstat">
        NYX · <span class="zh" style:letter-spacing="0">{status ? stateLine(status) : '…'}</span>
        {#if status?.known && (status.recollected ?? 0) > 0}&nbsp;· ×{status.recollected}{/if}
      </div>
      {#each verdicts as v (v)}
        <div class="note" style:margin="4px 0">{VERDICT_ZH[v] ?? v}</div>
      {/each}
      <!-- L2a 词义：本地词典下一件 —— 没命中就静默留白（D-338），不摆「加载中」 -->
      {#if note}<div class="note" style:margin="4px 0">{note}</div>{/if}
      <button class="fold" style:padding="8px 0 4px"
        onclick={() => (note = '「深一点」走直连 AI（D-337）—— 配好 AI 后开，下一批接。')}>
        <span class="lab tight">MORE</span><span class="m">深一点 · 需网 ›</span>
      </button>
      <div class="brow">
        <button class="btn pri" disabled={busy} onclick={() => void save()}>
          <span class="zh">收下</span>
        </button>
        <button class="tag t-m" onclick={close}>关掉</button>
      </div>
    </div>
  {:else}
    <!-- ⑫ 已收下确认条：INTO 路径 · LINE seg（D-376 可翻可记忆） -->
    <div class="asheet">
      <div class="handle"></div>
      <div class="hd">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--violet)"><use href="#nyx-star" /></svg>
        <span class="zh">已收下</span>
        {#if saved.duplicateOf !== null}<span class="tag t-c gap">{DUP_COLLECT}</span>{/if}
        <span class="sp"></span>
        <button class="ibtn sm" aria-label="关掉" onclick={close}><svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-close" /></svg></button>
      </div>
      <div class="li" style:min-height="44px">
        <span class="g"><span class="m">INTO</span>&nbsp;<span class="zh s12">{saved.pathLabel}</span></span>
        <button class="tag t-v" onclick={() => (note = '默认保存位置在 Settings → Assist → Save 里配（可精确到 Lecture，D-400②）；这条上的临时改目标在后半接。')}>改目标 ›</button>
      </div>
      <div class="li" style:min-height="44px" style:border-bottom="none">
        <span class="g m">LINE</span>
        <span class="seg">
          <button class:sel={layer === 'A'} onclick={() => void pickLayer('A')}>理解层 A</button>
          <button class:sel={layer === 'B'} onclick={() => void pickLayer('B')}>写作层 B</button>
        </span>
      </div>
      {#if note}<div class="note" role="status">{note}</div>{/if}
      <div class="m blk zh">深解析回家由电脑补上</div>
    </div>
  {/if}
</div>
