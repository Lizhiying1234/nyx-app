<script lang="ts">
  /**
   * 馆藏搜索（2026-09-01 · X-Ray 审计 F-013）。
   *
   * ★ 在这之前 Vault 首页那条「在馆藏里找…」点了只会说「还没接上」——
   *   而手机**没有常驻树**，找东西只能靠它。
   *
   * ★ 判据在 `db/search.ts`（逐字港 Windows `browse.ts::search`，范围照 D-106：
   *   知识点 + 节点名 + 原文摘句，**不搜对话与解析正文**）。这里只摆上屏。
   *
   * ★ 三组结果各是一种「找到了什么」，所以分区（§10.2c 的三种行里，
   *   这一屏全是**动作行** —— 每一行都点得进去）。
   * ★ 空结果不造假：如实说「没找到」，并把搜过的词回显出来。
   * ★ D-227：零样式。
   */
  import { store } from '../lib/store.svelte.ts'
  import { route } from '../lib/route.svelte.ts'
  import { search, type SearchResults } from '../../db/search.ts'

  let { onopen, onback }: { onopen: (id: number) => void; onback: () => void } = $props()

  let q = $state('')
  let res = $state<SearchResults | null>(null)
  let busy = $state(false)
  let err = $state<string | null>(null)

  /** 输入停 250ms 才查 —— 每敲一个字母查一次，30 条 LIKE × 5 张表，手机上会卡 */
  let timer: ReturnType<typeof setTimeout> | null = null
  function onInput(v: string): void {
    q = v
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void run(), 250)
  }

  async function run(): Promise<void> {
    if (store.db.k !== 'ok') return
    const term = q.trim()
    if (!term) {
      res = null
      err = null
      return
    }
    busy = true
    err = null
    try {
      res = await search(store.db.db, term)
    } catch (e) {
      err = (e as Error)?.message ?? String(e)
      res = null
    } finally {
      busy = false
    }
  }

  $effect(() => () => {
    if (timer) clearTimeout(timer)
  })

  /** 进那一讲 —— 跨栈直达（Route 的 push，返回链干净） */
  const openLecture = (id: number): void => route.push({ k: 'lec', id })

  const KIND_ZH: Record<string, string> = { project: '项目', unit: '单元', lecture: '讲' }
  const cut = (s: string, n = 60): string => (s.length > n ? s.slice(0, n) + '…' : s)

  const total = $derived(res === null ? 0 : res.items.length + res.quotes.length + res.places.length)
</script>

<div class="view">
  <!-- ★ 子页屏顶：只剩返回箭头（D-418/D-419） -->
  <div class="top" style="gap:8px">
    <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
    </button>
  </div>

  <!-- ★ 底线式输入 —— 复用 SavePicker 那一族（`.ppr` + `.dlg-in`），零新增样式（D-227） -->
  <div class="ppr">
    <svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-search" /></svg>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="dlg-in"
      type="search"
      autofocus
      inputmode="search"
      placeholder="知识点 · 释义 · 原文 · Project/Unit/Lecture"
      value={q}
      oninput={(e) => onInput(e.currentTarget.value)}
      onkeydown={(e) => e.key === 'Enter' && void run()}
    />
  </div>

  {#if err}
    <div class="empty tight"><div class="t zh2">搜不动</div><div class="s">{err}</div></div>
  {:else if q.trim() === ''}
    <div class="m blk zh">搜知识点、释义、原文摘句，以及项目 / 单元 / 讲的名字。</div>
    <div class="m blk zh">★ 不搜解析正文与 AI 对话 —— 那些是机器写的长文本，会把结果淹掉（D-106）。</div>
  {:else if busy && res === null}
    <div class="m blk zh">找…</div>
  {:else if res !== null && total === 0}
    <div class="empty tight">
      <div class="t zh2">没找到「{cut(res.query, 20)}」</div>
      <div class="s">换个说法试试 —— 知识点和释义都在搜索范围里。</div>
    </div>
  {:else if res !== null}
    {#if res.items.length > 0}
      <div class="sec zh">知识点</div>
      <div class="set" style:border-top="none">
        {#each res.items as it (it.id)}
          <div class="li">
            <button class="hit" onclick={() => onopen(it.id)}>
              <span class="g">
                <span class="term" class:ink2={it.cardSilent || it.productionState === 'silent'}>{it.term}</span>
                <small>
                  <span class="tag t-v">{it.layer}</span>
                  {#if it.productionState === 'hard'}· <span class="tag t-w zh">攻坚</span>
                  {:else if it.productionState === 'silent' || it.cardSilent}· <span class="tag t-m">SILENT</span>
                  {:else}· TRAINING{/if}
                  {#if it.gloss}· {cut(it.gloss, 34)}{/if}
                </small>
              </span>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    {#if res.quotes.length > 0}
      <div class="sec">IN CONTEXT</div>
      <div class="set" style:border-top="none">
        {#each res.quotes as qt, i (`${qt.itemId}-${i}`)}
          <div class="li">
            <button class="hit" onclick={() => onopen(qt.itemId)}>
              <span class="g">
                <span class="term s14">{qt.term}</span>
                <small class="qline">{cut(qt.quote, 80)}</small>
                {#if qt.lecture}<small>{qt.lecture}</small>{/if}
              </span>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    {#if res.places.length > 0}
      <div class="sec">PLACES</div>
      <div class="set" style:border-top="none">
        {#each res.places as p (`${p.kind}-${p.id}`)}
          {#if p.kind === 'lecture'}
            <!-- 动作行：点得进去，所以有 caret（§10.2c） -->
            <div class="li">
              <button class="hit" onclick={() => openLecture(p.id)}>
                <span class="g">
                  <span class="zh s14 ink2">{KIND_ZH[p.kind]} · {p.name}</span>
                  {#if p.parent}<small>{p.parent}</small>{/if}
                </span>
                <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
              </button>
            </div>
          {:else}
            <!-- ★ 只读行：项目 / 单元在手机上没有独立页面（矩阵 A6 未接），
                 所以**没有 caret，按下去也没有反应**（§10.2c 的第一种行）。
                 不造一个点进去是空的入口 —— 那是 D-411 点名的死胡同。
                 它仍然值得显示：告诉他「这个名字存在，在哪个项目下」。 -->
            <div class="li ro">
              <span class="g">
                <span class="zh s14 ink2">{KIND_ZH[p.kind]} · {p.name}</span>
                {#if p.parent}<small>{p.parent}</small>{/if}
              </span>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
</div>
