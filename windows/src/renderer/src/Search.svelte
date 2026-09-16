<script lang="ts">
  import type { SearchResults } from '@shared/api.ts'
  import { SILENCE_FILTER_NAME, isRowSilent } from '@core/silence.ts'
  import { cleanMessage } from '@shared/api.ts'
  import { registerEsc } from './esc-stack.svelte.ts'
  import Ic from './Ic.svelte'

  let {
    q = $bindable(''),
    onclose,
    onitem,
    onlecture,
    onplace,
    onfiles
  }: {
    /**
     * ★ D-440 · 搜索词住在**壳里**，不住在这个组件里。
     * 从搜索结果点进词条，浮层会被卸载 —— 词留在组件里就跟着没了，
     * 于是「返回」只能回到一个空搜索框。他要的是回到**刚才那次搜索**。
     */
    q?: string
    onclose: () => void
    onitem: (id: number) => void
    onlecture: (id: number) => void
    onplace: (kind: 'project' | 'unit', id: number) => void
    onfiles: () => void
  } = $props()

  /** ★ I-171 · 浮层挂载之后把焦点放进输入框（`autofocus` 对动态插入的元素不生效）*/
  let box = $state<HTMLInputElement | null>(null)
  $effect(() => {
    box?.focus()
  })

  let res = $state<SearchResults | null>(null)
  let error = $state<string | null>(null)
  let cursor = $state(0)

  /**
   * 结果**按类型分组**（D-106），但同时拍平成一条列表 —— 否则 ↑↓ 没法跨组走。
   * 所以每一项自带 group，渲染时遇到组名变化就插一个组头。
   */
  type Hit = { group: string; icon: string; label: string; sub: string; extra?: string; go: () => void }
  const hits = $derived.by((): Hit[] => {
    if (!res) return []
    return [
      ...res.items.map((i) => ({
        group: '知识点',
        icon: 'vault',
        label: i.term,
        sub: i.gloss,
        extra:
          /** ★ I-204 · 判据只有 core 那一份 */
          isRowSilent(i)
            ? SILENCE_FILTER_NAME
            : i.layer === 'B'
              ? '写作层'
              : '理解层',
        go: () => onitem(i.id)
      })),
      ...res.quotes.map((x) => ({
        group: '原文摘句',
        icon: '❝',
        label: x.quote,
        sub: x.term,
        extra: x.lecture ?? undefined,
        go: () => onitem(x.itemId)
      })),
      ...res.places.map((p) => ({
        group: p.kind === 'project' ? '项目' : p.kind === 'unit' ? '单元' : 'lecture',
        icon: p.kind === 'lecture' ? 'lecture' : 'project',
        label: p.name,
        sub: p.parent ?? '',
        /**
         * ★ D-469（2026-09-07）· 项目 / 单元不再是页面：点它们**在侧边栏里展开到它**，
         *   然后关掉搜索浮层。以前项目走 `onproject` 进项目页、单元干脆什么都不做
         *   （落到 `onclose()`）—— 后者本来就是个死结果。
         */
        go: (): void => {
          if (p.kind === 'lecture') {
            onlecture(p.id)
            return
          }
          if (p.kind === 'project' || p.kind === 'unit') onplace(p.kind, p.id)
          onclose()
        }
      })),
      ...res.files.map((f) => ({
        group: '文件',
        icon: 'lecture',
        label: f.title,
        sub: '',
        go: onfiles
      }))
    ]
  })

  async function run(): Promise<void> {
    error = null
    cursor = 0
    try {
      res = await window.nyx.browse.search(q)
    } catch (err) {
      error = cleanMessage(err)
    }
  }

  // ★ D-440 · 带着上次的词回来时立刻重跑一次 —— 否则框里有字、下面却是空的
  if (q.trim()) void run()

  /** ★ D-440 · Esc 走 esc-stack（一套逻辑），方向键与回车仍是本组件自己的事 */
  $effect(() => registerEsc(() => (onclose(), true)))

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      cursor = Math.min(hits.length - 1, cursor + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      cursor = Math.max(0, cursor - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      hits[cursor]?.go()
    }
  }

  /** 关键词高亮 · D-196。切成三段，中间那段套 <b>。 */
  function split(text: string, needle: string): [string, string, string] {
    const i = text.toLowerCase().indexOf(needle.toLowerCase())
    if (i < 0 || !needle) return [text, '', '']
    return [text.slice(0, i), text.slice(i, i + needle.length), text.slice(i + needle.length)]
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- D-196 · 搜索是**弹窗浮层**，不是独立视图 -->
<div
  class="so on"
  role="button"
  tabindex="-1"
  data-testid="search-overlay"
  onclick={(e) => e.target === e.currentTarget && onclose()}
  onkeydown={() => {}}
>
  <div class="sbox">
    <div class="sinp">
      <span><Ic n="search" s={16} /></span>
      <!--
        ★ I-171（U-004 / B13）· 这里原来只写 `autofocus`，而**它对动态插入的元素不生效** ——
          浮层出来之后焦点还留在侧栏那一行上，打字进不了框，得再点一下。
          `autofocus` 只在解析文档时生效一次；Svelte 是挂载时插进来的，早过了那一刻。
        ★ 改成挂载后自己 focus（见上面 `$effect`）。`autofocus` 一并去掉，
          留着会让下一个人以为它在起作用。
      -->
      <input
        bind:this={box}
        placeholder="搜知识点、项目、lecture、文件、原文摘句…"
        data-testid="search-input"
        bind:value={q}
        oninput={run}
      />
      <span class="esc">Esc</span>
    </div>

    <div class="sres" data-testid="search-results">
      {#if error}
        <div class="errbox" data-testid="search-error"><div class="h">搜不了</div><div>{error}</div></div>
      {:else if !q.trim()}
        <div class="dim" style="padding:14px;font-size:var(--fs-2)">打字开始搜。</div>
      {:else if hits.length === 0}
        <div class="dim" style="padding:14px;font-size:var(--fs-2)" data-testid="search-none">
          没有匹配的。<br />
          <span style="font-size:var(--fs-1)"
            >顺带一提：<b>不搜 AI 对话和解析正文</b> —— 那些机器生成的大段文字会把结果淹掉。</span
          >
        </div>
      {:else}
        {#each hits as h, i (i)}
          {@const [a, b, c] = split(h.label, q.trim())}
          <!-- 结构与总原型 srender() 一致：组头 .sgrp2 + 行 .sitem（.ic2 / .t / .g / .w） -->
          {#if i === 0 || hits[i - 1]!.group !== h.group}
            <div class="sgrp2">{h.group}</div>
          {/if}
          <div
            class="sitem"
            class:on={i === cursor}
            role="button"
            tabindex="0"
            data-testid="hit-{i}"
            onclick={h.go}
            onkeydown={(e) => e.key === 'Enter' && h.go()}
            onmouseenter={() => (cursor = i)}
          >
            <span class="ic2"><Ic n={h.icon} s={12} /></span>
            <span class="t">{a}<em>{b}</em>{c}</span>
            <span class="g">{h.sub}</span>
            {#if h.extra}<span class="w">{h.extra}</span>{/if}
          </div>
        {/each}
      {/if}
    </div>

    <div class="sfoot">
      <span>↑↓ 选择</span><span>↵ 打开</span><span>不搜 AI 对话与解析正文</span>
    </div>
  </div>
</div>
