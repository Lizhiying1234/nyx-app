<script lang="ts">
  /**
   * 全部知识点（①c/①d · D-391）—— Filter 是第一层范围，Select 是第二层选择。
   *
   * ══ 已裁定的语义 ═══════════════════════════════════════════
   * ★★★ 全选 = 全选**当前筛选结果**（绝不指全库）：分母「筛出 N 条」右置紫字
   *     常驻；全选按钮与练习 CTA 都把 N 写在脸上（「认读这 N 条」）。
   * ★ 筛选维度全部真实（libraryItems 的参数，一个虚构的都没有）：
   *     层 A/B · 来源（值从库里取）· 只看重复收集 · 含静默 + 六种排序
   *     （中文措辞逐字沿 Windows Library.svelte）。矩阵格筛选有意不进（D-348）。
   * ★ 长按 = 进入多选（D-379 P4）；静默/删除 = 真写 + Snackbar 撤销
   *     （D-379 P1 零确认）；练习 CTA 阶段 4 接（通道已定 I-097），如实说。
   * ★ 行上的「N 天没练」是单对象直读（状态事实）；×N 是行为计数（D-362）。
   * ★ D-227 零样式 · D-392 中文 400。
   */
  import { CANT_READ, DUP_COLLECT, deletedItems } from '../lib/copy.ts'
  import { untrack } from 'svelte'
  import Dropdown from '../lib/Dropdown.svelte'
  import ItemMenu from '../lib/ItemMenu.svelte'
  import { store } from '../lib/store.svelte.ts'
  import { snacks } from '../lib/snack.svelte.ts'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import { longpress } from '../lib/press.ts'
  import SelBar from '../lib/SelBar.svelte'
  import { practice } from '../lib/practice.svelte.ts'
  import {
    loadLibraryItems,
    type LibraryFilter,
    type LibrarySort,
    type VaultItem
  } from '../../db/vault-lists.ts'
  import { bulkSilence, softDeleteItems, undoDeleteItems } from '../../db/manage.ts'
  import Icon from '../lib/Icon.svelte'
  import { SILENCE_ACTIONS, SILENCE_FILTER_NAME, TRASH_DAYS } from '../../core-link.ts'

  let {
    preset = {},
    title = '全部知识点',
    showTotal = true,
    onopen,
    onback
  }: {
    preset?: LibraryFilter
    title?: string
    /** 标题旁的大分母 = 馆藏规模 —— 只在「全部知识点」有意义 */
    showTotal?: boolean
    onopen: (id: number) => void
    onback: () => void
  } = $props()

  /** Windows Library.svelte 的排序措辞，逐字 */
  const SORTS: [LibrarySort, string][] = [
    ['stalest', '距上次练习最久'],
    ['accuracy-asc', '正确率低→高'],
    ['accuracy-desc', '正确率高→低'],
    ['streak', '连续正确最多'],
    ['recent', '最近加入'],
    ['random', '随机']
  ]
  const sortLabel = (s: LibrarySort): string => SORTS.find(([v]) => v === s)?.[1] ?? s

  let filter = $state<LibraryFilter>({ sort: 'stalest', ...preset })

  /**
   * ★ 他自己拧过筛选没有（B2 · ST-Q4）——「三种空要分清」里靠它分前两种。
   *   `preset` 是入口本身带来的范围（「已静默」「重复收集」…），**不算他拧的**；
   *   只有这一屏上那四个 chip 才算。分不清这两者，就会对着一个空的
   *   「已静默」库说「换一组筛选试试」—— 那是答非所问。
   */
  const filtered = $derived(
    filter.layer !== preset.layer ||
      filter.source !== preset.source ||
      (filter.onlyRepeated ?? false) !== (preset.onlyRepeated ?? false) ||
      (filter.includeSilent ?? false) !== (preset.includeSilent ?? false)
  )

  /** 清掉他拧的那几个，回到这个入口本来的范围（排序是他的偏好，留着） */
  function clearFilters(): void {
    filter = { sort: filter.sort, ...preset }
  }
  let rows = $state<VaultItem[]>([])
  let sources = $state<string[]>([])
  let stat = $state<'loading' | 'ok' | 'error'>('loading')
  let err = $state('')
  let note = $state<string | null>(null)
  let busy = $state(false)

  /** 第二层：null = 不在多选；数组 = 已选 id */
  let sel = $state<number[] | null>(null)
  /** ⋮ 行菜单（对某个对象做事）—— 居中窄卡，D-393 */
  let menu = $state<{ row: VaultItem } | null>(null)
  /**
   * ★ 排序 / 来源改用 **Dropdown**（DS §10.2b · 2026-09-01）。
   * 它们改的是「这一屏在看什么」，不是对某个对象做事 —— 按新分界该贴着控件展开，
   * 此前借 ⋮ 菜单的壳，点一个下拉弹出屏幕正中一张卡，是形式用错。
   */
  let dd = $state<{ kind: 'sort' | 'source'; el: HTMLElement } | null>(null)
  let sortBtn = $state<HTMLElement | null>(null)
  let srcBtn = $state<HTMLElement | null>(null)

  const allSelected = $derived(sel !== null && rows.length > 0 && sel.length === rows.length)

  /** IS_SILENT 宏的行内对应物（判据同 silence-sql.ts，只为显示与撤销口径） */
  const isSilent = (r: VaultItem): boolean =>
    r.layer === 'B' && r.kind !== 'sentence' ? r.productionState === 'silent' : r.cardSilent

  async function load(f: LibraryFilter): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      rows = await loadLibraryItems(store.db.db, f)
      sources = (
        await store.db.db.all(`select distinct source from items where deleted_at is null order by source`)
      ).map((r) => String(r['source']))
      stat = 'ok'
    } catch (e) {
      stat = 'error'
      err = (e as Error)?.message ?? String(e)
    }
  }

  $effect(() => {
    const f = { ...filter } // 读全字段建立依赖
    untrack(() => {
      void load(f)
    })
  })

  // 返回链（D-393）：菜单 → 多选 → 页面（页面那层在 Vault 容器上）
  $effect(() => {
    if (sel === null) return
    return registerBack(() => ((sel = null), true))
  })
  $effect(() => {
    if (menu === null) return
    return registerBack(() => ((menu = null), true))
  })

  function toast(msg: string, undo?: () => Promise<void>): void {
    snacks.show(msg, undo)
  }

  async function afterWrite(): Promise<void> {
    sel = null
    menu = null
    await load(filter)
    await store.reloadCounts()
  }

  async function doSilence(ids: number[]): Promise<void> {
    if (store.db.k !== 'ok' || busy) return
    const db = store.db.db
    // 只静默还没静默的 —— 撤销才是这次动作的精确逆
    const targets = ids.filter((id) => {
      const r = rows.find((x) => x.id === id)
      return r ? !isSilent(r) : false
    })
    if (targets.length === 0) {
      note = `选中的都已经${SILENCE_ACTIONS.shelve}了。`
      return
    }
    busy = true
    try {
      await bulkSilence(db, targets, true)
      await afterWrite()
      toast(`已${SILENCE_ACTIONS.shelve} ${targets.length} 条`, async () => {
        await bulkSilence(db, targets, false)
        await afterWrite()
      })
    } catch (e) {
      note = `没能${SILENCE_ACTIONS.shelve}：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }


  async function doDelete(ids: number[]): Promise<void> {
    if (store.db.k !== 'ok' || busy) return
    const db = store.db.db
    busy = true
    try {
      const n = await softDeleteItems(db, ids)
      await afterWrite()
      toast(deletedItems(n), async () => {
        await undoDeleteItems(db, ids)
        await afterWrite()
      })
    } catch (e) {
      note = `删除没写成：${(e as Error)?.message ?? e}`
    } finally {
      busy = false
    }
  }

  function toggleSel(id: number): void {
    if (sel === null) return
    sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]
    if (sel.length === 0) sel = null
  }

  const cycleLayer = (): void => {
    const next = filter.layer === undefined ? 'A' : filter.layer === 'A' ? 'B' : undefined
    filter = { ...filter, layer: next }
  }

  const stale = (at: number): string => {
    const d = Math.floor((Date.now() - at) / 86400000)
    return d <= 0 ? '今天动过' : `${d} 天没练`
  }
  const fmtDay = (at: number): string => {
    const d = new Date(at)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
</script>

<div class="view">
  {#if sel === null}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
      </div>
  {:else}
    <!-- 多选态：屏顶换成计数（这时候「返回」由多选栏的「取消」管） -->
    <div class="top">
      <span class="dt">已选 {sel.length} / {rows.length} · 筛选结果</span>
      <span class="sp"></span>
      <button class="ibtn sm" aria-label="退出多选" onclick={() => (sel = null)}><svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-close" /></svg></button>
    </div>
  {/if}

  {#if note}<div class="note" role="status">{note}</div>{/if}

  <!-- ★ 页面标题已删（第十九则指令 §八 · 使用者裁决「我从哪来」「我是谁」都删）。
       馆藏总数留着 —— 它不是标识，是这一屏在回答的那个数（D-348 允许的规模）。 -->
  {#if showTotal && store.vault}<div class="vhead"><span class="m">{store.vault.total}</span></div>{/if}

  <div class="fchips">
    <button class="fchip" class:on={filter.layer !== undefined} onclick={cycleLayer}>
      层{filter.layer ? ` ${filter.layer}` : ''}
    </button>
    <button
      class="fchip"
      class:on={filter.source !== undefined}
      class:open={dd?.kind === 'source'}
      bind:this={srcBtn}
      onclick={() => (dd = srcBtn ? { kind: 'source', el: srcBtn } : null)}
    >
      来源{filter.source ? ` ${filter.source}` : ''}
      <svg class="ic arr" class:open={dd?.kind === 'source'} width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
    </button>
    <button
      class="fchip"
      class:on={filter.onlyRepeated === true}
      onclick={() => (filter = { ...filter, onlyRepeated: !filter.onlyRepeated })}
    >{DUP_COLLECT}</button>
    <button
      class="fchip"
      class:on={filter.includeSilent === true}
      onclick={() => (filter = { ...filter, includeSilent: !filter.includeSilent })}
    >含{SILENCE_FILTER_NAME}</button>
  </div>

  <div class="sortrow">
    {#if sel === null}
      <button
        class="m"
        class:open={dd?.kind === 'sort'}
        bind:this={sortBtn}
        onclick={() => (dd = sortBtn ? { kind: 'sort', el: sortBtn } : null)}
      >SORT · <span class="zh">{sortLabel(filter.sort ?? 'stalest')}</span>
        <svg class="ic arr" class:open={dd?.kind === 'sort'} width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
      </button>
      <span class="m hits">筛出 {rows.length} 条</span>
    {:else}
      <span class="m hits">筛出 {rows.length} 条</span>
      {#if allSelected}
        <span class="allsel" style:width="auto"><Icon name="check" size={11} /> 已全选这 {rows.length} 条</span>
      {:else}
        <button class="allsel" style:width="auto" onclick={() => (sel = rows.map((r) => r.id))}>
          全选这 {rows.length} 条
        </button>
      {/if}
    {/if}
  </div>

  {#if stat === 'error'}
    <div class="empty tight"><div class="t zh2">{CANT_READ}</div><div class="s">{err}</div></div>
  {:else if stat === 'ok' && rows.length === 0}
    <!-- ★★ 空态分三种（ST-Q4 · UI_STATE_MATRIX §2.1）：
         **从来没有**（引导：告诉他怎么开始）· **筛完没有**（出路：清掉筛选）·
         **做完了**（回执）。这一屏只可能是前两种 —— 「做完了」属于练习那条线。
         此前两种共用一句「这组筛选下没有条目。」：库真的空的时候，
         那句话在让他去清一个他根本没设过的筛选。 -->
    {#if filtered}
      <div class="empty tight">
        <div class="t zh2">这组筛选下没有知识点</div>
        <div class="s">换一组，或者清掉筛选看这个入口的全部。</div>
        <button class="btn sm center mt3" onclick={clearFilters}>
          <span class="zh">清掉筛选</span>
        </button>
      </div>
    {:else}
      <div class="empty tight">
        <div class="t zh2">这里还没有知识点</div>
        <div class="s">
          在别的 App 里选中一个词、点悬浮星收进来；<br />
          或者在电脑上分析完，同步过来。
        </div>
      </div>
    {/if}
  {:else}
    <div class="set" style:border-top="none">
      {#each rows as r (r.id)}
        <div class="li">
          {#if sel !== null}
            <button class="hit" onclick={() => toggleSel(r.id)}>
              <!-- ★ 选中记号 = 实心核 / 空心核，同一条路径（DS §4.5）——
                   此前是 ◆/◇ 两个系统字符，形状跟 Nyx 的笔画对不上 -->
              <span class="selmk" class:off={!sel.includes(r.id)}><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href={sel.includes(r.id) ? '#nyx-core' : '#nyx-core-o'} /></svg></span>
              <span class="g">
                <span class="term" class:ink2={isSilent(r)}>{r.term}</span>
                <small>
                  <span class="tag t-v">{r.layer}</span>
                  {#if r.productionState === 'hard'}· <span class="tag t-w zh">攻坚</span>{:else if isSilent(r)}· <span class="tag t-m">SILENT</span>{:else}· TRAINING{/if}
                  · {stale(r.updatedAt)}
                </small>
              </span>
            </button>
          {:else}
            <button class="hit" use:longpress={() => (sel = [r.id])} onclick={() => onopen(r.id)}>
              <span class="g">
                <span class="term" class:ink2={isSilent(r)}>{r.term}</span>
                <small>
                  <span class="tag t-v">{r.layer}</span>
                  {#if r.productionState === 'hard'}· <span class="tag t-w zh">攻坚</span>{:else if isSilent(r)}· <span class="tag t-m">SILENT</span>{:else}· TRAINING{/if}
                  · {stale(r.updatedAt)}
                  {#if r.recollected > 0}· ×{r.recollected}{/if}
                </small>
              </span>
            </button>
            <button class="ibtn sm" aria-label="这条的操作" onclick={() => (menu = { row: r })}><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
          {/if}
        </div>
      {/each}
    </div>
    {#if sel === null && rows.length > 0}
      <div class="m blk zh">长按任意行开始多选</div>
    {/if}
  {/if}

  {#if sel !== null}
    <SelBar
      n={sel.length}
      {busy}
      onread={() => (practice.open = { kind: 'reading', ids: [...(sel ?? [])] })}
      onprod={() => (practice.open = { kind: 'production', ids: [...(sel ?? [])] })}
      onsilence={() => void doSilence(sel ?? [])}
      ondelete={() => void doDelete(sel ?? [])}
    />
  {/if}

  <!-- ★ 排序 / 来源 = Dropdown（贴控件、不压暗、不打断视线） -->
  {#if dd !== null}
    {@const cur = dd}
    <Dropdown anchor={cur.el} onclose={() => (dd = null)}>
      {#if cur.kind === 'sort'}
        <div class="mhead">SORT</div>
        {#each SORTS as [v, label] (v)}
          <button class="mi" onclick={() => ((filter = { ...filter, sort: v }), (dd = null))}>
            <span class="zh">{label}</span>
            {#if (filter.sort ?? 'stalest') === v}<span class="min"><Icon name="check" size={11} /></span>{/if}
          </button>
        {/each}
      {:else}
        <div class="mhead">来源</div>
        <button class="mi" onclick={() => ((filter = { ...filter, source: undefined }), (dd = null))}>
          <span class="zh">全部</span>
          {#if filter.source === undefined}<span class="min"><Icon name="check" size={11} /></span>{/if}
        </button>
        {#each sources as s (s)}
          <button class="mi" onclick={() => ((filter = { ...filter, source: s }), (dd = null))}>
            <span>{s}</span>
            {#if filter.source === s}<span class="min"><Icon name="check" size={11} /></span>{/if}
          </button>
        {/each}
      {/if}
    </Dropdown>
  {/if}

  <!-- ★★ 行菜单换成**同一个** ItemMenu（2026-09-01）。
       此前这里是手写的第二套：同一个词条，在这里 ⋮ 只有三项
       （静默 / 移动… / 删除），在讲次页和详情页 ⋮ 有五项
       （认读 / 产出 / 静默 / 复制词条 / 删除）。
       更要紧的是它**还留着「移动…」** —— 点了只会弹一句「阶段 5 接」，
       正是上一轮从 ItemMenu 里删掉的那个「只会道歉的菜单项」，在这里活着。
       同一个对象的同一组动作，不许有第二份判据。 -->
  {#if menu !== null}
    {@const r = menu.row}
    <ItemMenu
      id={r.id}
      term={r.term}
      silent={isSilent(r)}
      onclose={() => (menu = null)}
      onwrote={(msg, undo) => {
        toast(msg, undo ?? undefined)
        void afterWrite()
      }}
    />
  {/if}

</div>
