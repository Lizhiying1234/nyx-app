<script lang="ts">
  /**
   * 知识点详情 —— 阶段 2 读路径（高保真 v4 ③帧为验收样）。
   *
   * ══ 信息层次照 Windows `ItemDetail.svelte` / `study.ts::itemDetail` ══
   *   词条 + EN 释义（衬线，顶格）
   *   ★ 中文默认收起（D-389 揭示件；浏览不降档 —— 降档只属认读卡 I-083）
   *   出处默认首处 + 「全部 N 处」展开（D-152/H2）
   *   解析三组：正文默认展开 · REGISTER & NUANCE / CLOSE READING 折叠（D-375/D-363）
   *   DERIVED（D-148）
   *   ★ 2026-09-07 · D-468：只剩一层正文（「BASICS / 基础层 / 进阶层」不再出现），
   *     历次作答整块删（`review_logs` / `answers` 一行没动，只是这一屏不读了）。
   *     合并块 `inSentence` 与老的 `meaning` / `barriers` 共用一个标签，
   *     `blocksToShow()` 让它们落在同一个区域里（老数据一个字不丢）。
   *
   * ★ 有意没有的（每一样都说得出被谁挡）：
   *   编辑入口/改层级 = D-302 · streak/attempts 计数器 = D-322 ·
   *   嫌疑处理 = D-302（✎ 只显示）· 解析生成 = D-333（缺了就说「电脑会补」）·
   *   词典命中 = 阶段 6（D-336）· 朗读 = 阶段 6（D-374）
   * ★ D-227 零样式 · D-392 中文 400。
   */
  import { CANT_READ, DUP_COLLECT } from '../lib/copy.ts'
  import { untrack } from 'svelte'
  import ItemMenu from '../lib/ItemMenu.svelte'
  import { snacks } from '../lib/snack.svelte.ts'
  import { store } from '../lib/store.svelte.ts'
  import { speak } from '../../db/tts.ts'
  import {
    BLOCK_GROUPS,
    blocksToShow,
    loadItemDetail,
    type ItemDetailData
  } from '../../db/read-path.ts'
  import { isAnalysisStale } from '../../db/edit-item.ts'

  let { id, onback }: { id: number; onback: () => void } = $props()

  type View = { k: 'loading' } | { k: 'error'; m: string } | { k: 'ok'; d: ItemDetailData }
  let view = $state<View>({ k: 'loading' })
  let zhOpen = $state(false)          // D-389：主动点开才看中文
  let allOcc = $state(false)          // D-152：默认只显首处
  let groupOpen = $state<Record<string, boolean>>({ body: true }) // D-375
  let derOpen = $state(false)
  let note = $state<string | null>(null)
  let itemMenu = $state(false)

  /**
   * ★ T-5.14 · 这份解析是照着**改之前的词条**写的吗。
   *   判定只有一份，在 core（`analysis/stale.ts::staleAfterEdit`）——
   *   Android 这一侧只负责把答案摆上屏，不在这里再写一遍规则。
   */
  let stale = $state(false)

  /** 重读这一屏 —— 首次进入 ·「分析完了」（T-5.12）·「改完了」（T-5.14）走同一条 */
  async function reload(): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      view = { k: 'ok', d: await loadItemDetail(store.db.db, id) }
      stale = await isAnalysisStale(store.db.db, id)
    } catch (e) {
      view = { k: 'error', m: (e as Error)?.message ?? String(e) }
    }
  }

  $effect(() => {
    untrack(() => void reload())
  })

  const blockOf = (d: ItemDetailData, key: string): string | null =>
    d.blocks.find((b) => b.block === key)?.content ?? null

  const groupCount = (d: ItemDetailData, blocks: [string, string][]): number =>
    blocks.filter(([k]) => blockOf(d, k) !== null).length

  /** 出处里把词条本体划出来（荧光笔 —— §10.5 三处之一） */
  function splitQuote(quote: string, term: string): { pre: string; hit: string; post: string } {
    const i = quote.toLowerCase().indexOf(term.toLowerCase())
    if (i < 0) return { pre: quote, hit: '', post: '' }
    return { pre: quote.slice(0, i), hit: quote.slice(i, i + term.length), post: quote.slice(i + term.length) }
  }

  const fmtDay = (at: number): string => {
    const d = new Date(at)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
</script>

<div class="view">
  {#if view.k === 'ok' && itemMenu}
  <ItemMenu
    {id}
    term={view.d.item.term}
    silent={view.d.item.productionState === 'silent' || view.d.item.cardSilent}
    onclose={() => (itemMenu = false)}
    onwrote={(msg, undo) => snacks.show(msg, undo)}
    onchanged={reload}
    ondeleted={onback}
  />
{/if}
{#if view.k === 'loading'}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
      <span class="dt">…</span>
    </div>
    <div class="empty"><div class="t zh2">读取中…</div></div>
  {:else if view.k === 'error'}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
      <span class="dt">返回</span>
    </div>
    <div class="empty"><div class="t zh2">{CANT_READ}</div><div class="s">{view.m}</div></div>
  {:else}
    {@const d = view.d}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
      <span class="dt">{d.item.lectureName ?? ''}</span>
      <button class="ibtn sm" aria-label="更多操作" onclick={() => (itemMenu = true)}><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
    </div>

    {#if note}<div class="note" role="status">{note}</div>{/if}

    <!-- ★ `item-analysis`（清单 13）的靶子：那句说「这一条的解析在下面，
         词和释义你随时可以自己改」——「这一条」就是这一行的词条本身，
         而解析三组正在它下面。这一行任何状态都在。 -->
    <div class="word" data-guide="item-analysis">
      <span style="flex:1;min-width:0">{d.item.term}</span>
      <button class="rb" aria-label="朗读"
        onclick={() => { if (store.db.k === 'ok') void speak(store.db.db, d.item.term).then((n) => { if (n) note = n }) }}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-speak" /></svg>
      </button>
    </div>
    <div class="wm">
      <span class="tag t-v">{d.item.layer}</span>
      <span class="tag" class:t-w={d.item.productionState === 'hard'} class:t-m={d.item.productionState !== 'hard'}
        >{d.item.productionState.toUpperCase()}</span>
      {#if d.item.source === 'both'}<span class="bg dict" style="margin-left:auto">{DUP_COLLECT}</span>{/if}
      {#if d.item.cardSilent}<span class="tag t-m">RC-SILENT</span>{/if}
    </div>
    {#if d.item.gloss}<div class="def">{d.item.gloss}</div>{/if}
    {#if d.item.glossZh}
      {#if zhOpen}
        <span class="zh-full">{d.item.glossZh}</span>
      {:else}
        <button class="txt" onclick={() => (zhOpen = true)}>中文释义
          <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
        </button>
      {/if}
    {/if}

    {#if d.occurrences.length > 0}
      {@const first = d.occurrences[0]!}
      {@const q = splitQuote(first.quote, d.item.term)}
      <div class="sec"><span class="zh">出处</span></div>
      <div class="quo">{q.pre}<em>{q.hit}</em>{q.post}</div>
      <div class="qs">
        <span class="zh">{first.material ?? first.lecture ?? '—'}</span> · {fmtDay(first.at)}
        {#if d.occurrences.length > 1}
          <button class="more" onclick={() => (allOcc = !allOcc)}>
            {allOcc ? '收起' : `全部 ${d.occurrences.length} 处 ›`}
          </button>
        {/if}
      </div>
      {#if allOcc}
        {#each d.occurrences.slice(1) as o (o.at)}
          <div class="quo">{o.quote}</div>
          <div class="qs"><span class="zh">{o.material ?? o.lecture ?? '—'}</span> · {fmtDay(o.at)}</div>
        {/each}
      {/if}
    {/if}

    <!-- ★ T-5.14 · 词条改过、而解析还在讲旧词（判定在 core `staleAfterEdit`）。
         只**说一句**，不自动删解析、不自动重跑 —— 解析很贵，而且他可能只改了个大小写
         （只改大小写 / 尾标点 / 释义都不算，那正是 core 那条判据在管的事）。
         ★ 重新分析的入口是 T-5.12 的，不在本条里；本条只负责显示。 -->
    {#if stale}
      <div class="m blk zh">这份解析写的是改之前的知识点 —— ⋮ 里可以重新分析。</div>
    {/if}

    {#if d.blocks.length === 0}
      <!-- H9/D-338：缺解析时的功能性一行 —— 不是装饰耳语 -->
      <!-- ★ T-5.12（D-R22）：这句原来写着「回家由电脑补上」—— 那是 D-333 时代的事实，
           手机现在自己就能做单条解析。措辞只说他能做什么，不露工程词。 -->
      <div class="m blk zh">这一条还没有完整解析 —— ⋮ 里可以分析。</div>
    {:else}
      {#each BLOCK_GROUPS as g (g.key)}
        {@const n = groupCount(d, g.blocks)}
        {#if n > 0}
          {#if groupOpen[g.key]}
            <!-- ★ 折叠契约（D-393）：头永远是双向开关 —— 开着也能点回去 -->
            <button class="fold" onclick={() => (groupOpen = { ...groupOpen, [g.key]: false })}>
              <span class="lab tight">{g.title}</span><span class="m"><svg class="ic arr" class:open={true} width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
            </button>
            <div class="bsec">
              {#each blocksToShow(g.blocks, (k) => blockOf(d, k)) as b (b.key)}
                {#if b.title !== null}<div class="bkey">{b.title}</div>{/if}
                <!-- ★ 一块可能是几条（数组块）—— 拆行的判据在 `blockLines`，这里只画 -->
                {#each b.lines as line, i (i)}<div class="bval">{line}</div>{/each}
              {/each}
            </div>
          {:else}
            <button class="fold" onclick={() => (groupOpen = { ...groupOpen, [g.key]: true })}>
              <span class="lab tight">{g.title}</span><span class="m">+{n} ›</span>
            </button>
          {/if}
        {/if}
      {/each}
    {/if}

    {#if d.derived.length > 0}
      <button class="fold" onclick={() => (derOpen = !derOpen)}>
        <span class="lab tight">DERIVED</span><span class="m">{d.derived.length} <svg class="ic arr" class:open={derOpen} width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
      </button>
      {#if derOpen}
        {#each d.derived as x (x.id)}
          <div class="li">
            <span class="g"><span class="term s15">{x.term}</span>
              <small><span class="tag t-v">{x.layer}</span> · {x.productionState.toUpperCase()}</small></span>
          </div>
        {/each}
      {/if}
    {/if}
  {/if}
</div>
