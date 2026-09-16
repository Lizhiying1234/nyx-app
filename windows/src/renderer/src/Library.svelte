<script lang="ts">
  import Stars from './Stars.svelte'
  import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from '@core/silence.ts'
  import Skel from './Skel.svelte'
  import type { LibraryFilter, LibraryItem, LibrarySort, MatrixData } from '@shared/api.ts'
  import { cleanMessage, MATRIX_COLS, MATRIX_ROWS } from '@shared/api.ts'
  import SelBar from './SelBar.svelte'
  import Ic from './Ic.svelte'
  import { registerEsc } from './esc-stack.svelte.ts'
  import { askGuide } from './guide.svelte.ts'
  import SrcBadge from './SrcBadge.svelte'
  import { say } from './toast.svelte.ts'
  import { countUnanalysed, UNANALYSED_LABEL } from '@core/library-state.ts'

  /**
   * 四个库共用同一套列表 · D-126
   *
   * 「列表本身是**同一个组件**（同样的行结构、•••、筛选、多选批量），
   *  **特色区在列表上方**（矩阵 / 分组 / 诊断 / 游戏框）。」
   * 收益：只需学一次列表怎么用；四个库其实是一个视图配四种头部。
   */
  let {
    scope,
    selectedId,
    onopen,
    onpractice,
    onreading,
    onlecture
  }: {
    scope: 'all' | 'upload' | 'silent'
    /** ★ D-477 · 右栏正看着哪一条 —— 那一行要亮着（UI_STATE_MATRIX §一 selected）*/
    selectedId?: number
    onopen: (id: number) => void
    onpractice?: (ids: number[]) => void
    /** I-097 · 两条线各一个测试入口 —— 认读那条以前只能从讲次页进 */
    onreading?: (ids: number[]) => void
    /**
     * ★ T-4.10 · 「还没分析」的状态片点下去要去它所在的那一讲（现有分析入口在那里）。
     *   没接这个回调时状态片只是一枚静态的片 —— 不装一个点不动的假按钮。
     */
    onlecture?: (lectureId: number) => void
  } = $props()

  type View =
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | { k: 'ok'; items: LibraryItem[]; matrix: MatrixData | null; stats: { items: number; lectures: number; projects: number } | null }

  let view = $state<View>({ k: 'loading' })
  let sort = $state<LibrarySort>('stalest')
  let layer = $state<'A' | 'B' | null>(null)
  let onlyRepeated = $state(false)
  let cell = $state<{ row: number; col: number } | null>(null)

  /** ★ D-440 · 这两个浮层以前只能点 ✕；现在进同一个 esc-stack，一次 Esc 关一层 */
  $effect(() =>
    registerEsc(() => {
      if (cell) {
        cell = null
        return true
      }
      if (layer) {
        layer = null
        return true
      }
      return false
    })
  )
  /** D-163 · 矩阵选中与列表勾选是**同一个选择集** */
  let selected = $state<number[]>([])

  /**
   * ★ T-4.10 · 表头那句「n 条还没分析」要的三样：多少条 · 散在几讲 · 同一讲时是哪一讲。
   *   数的是**当前列出来的这些行**（和左边那个「N 条」同一批），不是全库统计 ——
   *   两个数出自同一份数据，才不会出现「上面写 202、点进去只有 40」。
   *
   * ★ 写成普通函数、在模板里用 `{@const}` 取值，**不用 `$derived`**：
   *   这个组件里已经有一个叫 `derived`（析出成分）的变量，而 Svelte 5 里 `$名字`
   *   是 store 订阅语法 —— `$derived.by(...)` 会被当成「订阅 derived 这个 store」，
   *   svelte-check 当场两条错。名字撞车而已，换个写法就绕开了。
   */
  const unanSummary = (
    items: LibraryItem[]
  ): { n: number; lectures: number; lectureId: number | null } => {
    const ids = [
      ...new Set(
        items
          .filter((x) => x.state === 'unanalysed')
          .map((x) => x.lectureId)
          .filter((x): x is number => x !== null)
      )
    ]
    return {
      n: countUnanalysed(items.map((x) => x.state)),
      lectures: ids.length,
      lectureId: ids.length === 1 ? ids[0]! : null
    }
  }

  // ★ B14 / D-476 · 三个都是 Vault 里的**预设**，不再叫「库」（TM-06 / TM-07b / TM-08）
  const TITLE = { all: '全部', upload: '我的收集', silent: SILENCE_FILTER_NAME }

  /**
   * I-088 · 我的上传库按总原型的 `.ur` / `.deriv` 做
   *
   * 这一支以前和另外两个库共用 `.lrow`（六列网格）。共用列表是 D-126 的收益，
   * 但**上传库装的是整句**：1fr 那一格放不下一句话，长句必然截断，
   * 而 `.ur .s` 是整行 serif、会换行 —— 总原型对这一页是分开画的，画得有道理。
   *
   * 更要紧的是 `.deriv`：点原句展开它析出了哪些成分。
   * 那正是这一页唯一能提供的独特价值（D-148）—— 以前只显示「已析出 3 个成分」，
   * 想看是哪三个得离开这一页。
   *
   * 顺带：`.ur` / `.ur .s` / `.ur .m` / `.deriv` / `.deriv.show` / `.dv` / `.dv .t` /
   * `.dv .st` 这一整组规则原先一次都没用上（check:dom 顶出来的）。
   */
  let openRows = $state<number[]>([])
  let derived = $state<Record<number, { id: number; term: string; layer: string; productionState: string; streak: number }[]>>({})
  let derivedErr = $state<Record<number, string>>({})

  async function toggleRow(id: number): Promise<void> {
    if (openRows.includes(id)) {
      openRows = openRows.filter((x) => x !== id)
      return
    }
    openRows = [...openRows, id]
    if (derived[id]) return
    try {
      derived = { ...derived, [id]: await window.nyx.study.derivedOf(id) }
    } catch (err) {
      // D-205 · 拿不到就说出来，不要展开一个空框让人以为「一条都没析出」
      derivedErr = { ...derivedErr, [id]: cleanMessage(err) }
    }
  }

  /** 上传库按上传日期分组 —— 总原型的 `.ugrp`。同一天贴进来的本来就是一批 */
  const byDay = (items: LibraryItem[]): { day: string; rows: LibraryItem[] }[] => {
    const m = new Map<string, LibraryItem[]>()
    for (const it of items) {
      const d = new Date(it.createdAt)
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(it)
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, rows]) => ({ day, rows }))
  }

  /** 4.2 · 整支被静默的项目 / 单元 / lecture。只在静默知识库这一页用 */
  let silentTree = $state<
    { kind: 'project' | 'unit' | 'lecture'; id: number; name: string; path: string }[]
  >([])

  async function unsilence(
    kind: 'project' | 'unit' | 'lecture',
    id: number,
    path: string
  ): Promise<void> {
    try {
      await window.nyx.data.setSilent(kind, id, false)
      say(`「${path}」${SILENCE_ACTIONS.restore}了 —— 它和底下的知识点重新排进练习。`)
      await load()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  async function load(): Promise<void> {
    try {
      const filter: LibraryFilter = {
        scope,
        layer: layer ?? undefined,
        onlyRepeated: onlyRepeated || undefined,
        // 把 row/col 抄出来 —— cell 是 $state 代理，直接传过不了 contextBridge
        cell: cell ? { row: cell.row, col: cell.col } : undefined,
        sort
      }
      const [items, matrix, stats, nodes] = await Promise.all([
        window.nyx.study.libraryItems(filter),
        scope === 'all' ? window.nyx.study.matrix() : Promise.resolve(null),
        scope === 'silent' ? window.nyx.study.silentStats() : Promise.resolve(null),
        scope === 'silent' ? window.nyx.data.silentTree() : Promise.resolve([])
      ])
      silentTree = nodes
      view = { k: 'ok', items, matrix, stats }
      /**
       * D-484 · B-6 · 头一次点进「静默」这一档时讲一句**这个档是什么**
       * ——「练成不再考的、和你自己收起来的，都在这儿」。
       * ★ 使用者 2026-09-15 把档名裁回了短的「静默」，并追「最多之后给它加一个
       *   引导解释」：所以这一句不是装饰，**档名说不清的那一半由它接着**
       *   （`src/core/onboarding.ts` 的 `vault-learned`，两端同一句）。
       *
       * ★ 放在**读完之后**，不放在点击那一下：那块框（`silent-frame`）
       *   要等 `silentStats()` 回来才渲染，点击那一刻它还不在屏上 ——
       *   那时候问，浮层量不到目标，只会白白占住「同时只许出一条」的闸。
       * ★ `stats` 为空也不问：那说明这一档这次没读出统计，框根本不画。
       */
      if (scope === 'silent' && stats) void askGuide('vault-learned')
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  $effect(() => {
    void scope
    void sort
    void layer
    void onlyRepeated
    void cell
    load()
  })

  const toggleSel = (id: number): void => {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
  }

  /** 点格子把那批加入选择集（D-158） */
  function pickCell(row: number, col: number): void {
    cell = cell?.row === row && cell?.col === col ? null : { row, col }
    selected = []
  }

  /**
   * 配色分档 · R-006 / I-009
   *
   * 总原型的 lv() 是**绝对阈值**（<8 / <25 / <80），那是按「几百上千条」的库定的。
   * 刚开始用时每格只有几条，全部落在最浅两档，整张表没有层次 —— 使用者说的
   * 「颜色不对」就是这个。
   *
   * 改成**按当前最大格子归一化**。代价是「同一个颜色在不同时间代表不同的量」，
   * 但每格里**始终印着精确条数** —— 数字承担真相，颜色只承担形状。
   */
  function q(n: number, max: number): string {
    if (n === 0) return 'q0'
    const r = n / Math.max(1, max)
    return r > 0.66 ? 'q4' : r > 0.4 ? 'q3' : r > 0.15 ? 'q2' : 'q1'
  }

  /** 批量操作的回执 —— 动作本身在共用的 SelBar 里（I-098） */

  const SORTS: [LibrarySort, string][] = [
    ['stalest', '距上次练习最久'],
    ['accuracy-asc', '正确率低→高'],
    ['accuracy-desc', '正确率高→低'],
    ['streak', '连续正确最多'],
    ['recent', '最近加入'],
    ['random', '随机']
  ]
</script>

<div class="vh">
  <h1>{TITLE[scope]}</h1>
  <span class="c" data-testid="lib-count">
    {view.k === 'ok' ? `${view.items.length} 条` : ''}
    {#if view.k === 'ok' && view.matrix}· 含不用再练的 {view.matrix.cells[0]!.reduce((a, b) => a + b, 0)}{/if}
    <!--
      ★ T-4.10（D-R24 A）· 「n 条还没分析」的计数与入口。
        只有 n > 0 时才出现 —— 全都分析过的库不该多一句废话。

      ★★ 点得动 / 点不动是**如实**的：这 n 条落在同一讲时才给入口（点下去进那一讲）；
        散在多讲时没有「它所在的那一讲」，于是只是一个数字 + 一句说明，
        不装一个点了会去错地方的按钮（D-447：可点元素全部重新考虑过）。
    -->
    {#if view.k === 'ok'}
      {@const unan = unanSummary(view.items)}
      {#if unan.n > 0}
        <span
          class="unan-sum"
          role={unan.lectureId !== null && onlecture ? 'button' : undefined}
          tabindex={unan.lectureId !== null && onlecture ? 0 : undefined}
          title={unan.lectureId !== null && onlecture
            ? '点这里进它们所在的 Lecture 分析'
            : `分布在 ${unan.lectures} 个 Lecture —— 点某一行的「${UNANALYSED_LABEL}」进它那个 Lecture`}
          data-testid="lib-unanalysed"
          onclick={() => unan.lectureId !== null && onlecture && onlecture(unan.lectureId)}
          onkeydown={(e) =>
            e.key === 'Enter' && unan.lectureId !== null && onlecture && onlecture(unan.lectureId)}
          >· {unan.n} 条{UNANALYSED_LABEL}</span
        >
      {/if}
    {/if}
  </span>
</div>

{#if view.k === 'error'}
  <div class="errbox" data-testid="lib-error">
    <div class="h">这个库打不开</div>
    <div style="white-space:pre-wrap">{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={load}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <!-- ★ B1 · 库：列表 5 行（§2.2「列表行 骨架 3–5 行」）-->
  <div class="card blk"><Skel rows={5} widths={['w100', 'w85', 'w100', 'w70', 'w85']} testid="lib-skel" /></div>
{:else}
  <!-- ══ 特色区 · 每个库不一样的那部分 ══ -->
  {#if view.matrix}
    {@const m = view.matrix}
    <div class="mxw">
      <div class="mx" data-testid="matrix">
        <div></div>
        {#each MATRIX_COLS as c (c)}<div class="h">{c}</div>{/each}
        {#each m.cells as row, r (r)}
          <div class="rh">{MATRIX_ROWS[r]}</div>
          {#each row as v, c (c)}
            <button
              class="c {q(v, m.max)}"
              class:zone={r >= 1 && c === 2}
              class:on={cell?.row === r && cell?.col === c}
              data-testid="cell-{r}-{c}"
              onclick={() => pickCell(r, c)}>{v}</button
            >
          {/each}
        {/each}
      </div>
      <div class="mxs">
        <div class="zl"><i></i>读得懂 · 产不出 —— <b style="font-family:var(--mono)">{m.zone}</b> 条</div>
        <!--
          ★ H-4 · 这三段解释比矩阵本身还长，而且全在解释软件自己（使用者原话：
            「整个界面在不停地跟你解释它自己」）。**图留着，解释折叠** ——
            明面留的是上面那一行「读得懂 · 产不出 N 条」，它才是这张图的结论。
          ★ 没把矩阵一起收起来：D-126「特色区在列表上方」—— 矩阵就是 Vault 的特色区，
            收了这一屏就没有脸了；4×4 十六个数字本来也一眼扫得完。
        -->
        <details class="mxfold" data-testid="matrix-note">
          <summary>这张图怎么读</summary>
          <p>纵轴产出线，横轴认读线。<b>右下框出的那片就是这套方法论瞄准的全部对象。</b></p>
          <p>
            点格子把那批筛出来。不用再练的那一行<b style="color:var(--text-2)">只在图里出现</b
            >，不进下面的列表。
          </p>
          <p class="dim">
            颜色按当前最大的格子分档 —— <b>数字是真相，颜色只表示形状</b>。库还小的时候
            绝对阈值会让整张表一片浅色，看不出差别。
          </p>
        </details>
      </div>
    </div>
  {/if}

  {#if view.stats}
    <!-- D-030 · 中度游戏框：四角构件 + 内描边。框只套页头，条目本身保持朴素 ——
         这个库会长到上千条，逐条装饰会毁掉可扫读性。 -->
    <div class="frame" data-testid="silent-frame" data-guide="vault-learned">
      <span class="cn tl"></span><span class="cn tr"></span>
      <span class="cn bl"></span><span class="cn br"></span>
      <div class="sh2">
        <div class="rune">✦ ◈ ✦</div>
        <!-- 档名只有 `SILENCE_FILTER_NAME` 一处说了算（2026-09-15）——
             这儿原来是手写的旧名字「不再出题」，S-3 改档名时**没跟着改**：
             侧栏和标题走的是常量（`TITLE`），只有这块大字是另抄的一份。
             后果是他点进去，页面正中央那行大字和左边那一栏**说的不是同一个名字**。
             ☞ 屏上凡是要念这个档的名字，一律引常量；`data-testid` 是给闸逐字比对用的。 -->
        <h2 data-testid="silent-title">{SILENCE_FILTER_NAME}</h2>
        <p>不再出题；想再练，随时{SILENCE_ACTIONS.restore}。</p>
        <div class="sstat">
          <div><div class="n">{view.stats.items}</div><div class="l">知识点</div></div>
          <div><div class="n">{view.stats.lectures}</div><div class="l">lecture</div></div>
          <div><div class="n">{view.stats.projects}</div><div class="l">项目</div></div>
        </div>
      </div>
    </div>
  {/if}


  <!--
    ★ 4.2 · 被整支静默掉的项目 / 单元 / lecture。

    它们已经从项目栏里消失了（使用者：「整个项目从正常视图消失，只出现在静默知识库」）。
    **必须在这里看得见，而且能放回来** —— 只藏不放是个陷阱，
    他会以为项目被删掉了，而垃圾箱里又找不到。
  -->
  {#if scope === 'silent' && silentTree.length > 0}
    <div class="notice" data-testid="silent-structure">
      <div style="margin-bottom:8px">
        <b>这些整支不再出题</b> —— 它们不在项目栏里显示，也不进任何测试与统计。
      </div>
      {#each silentTree as n (n.kind + ':' + n.id)}
        <div class="lrow" data-testid="silent-node-{n.kind}-{n.id}">
          <span class="lt">{n.path}</span>
          <span class="dim" style="font-size:var(--fs-2)"
            >{n.kind === 'project' ? '项目' : n.kind === 'unit' ? '单元' : 'lecture'}</span
          >
          <button
            class="btn sm"
            data-testid="unsilence-{n.kind}-{n.id}"
            onclick={() => unsilence(n.kind, n.id, n.path)}>{SILENCE_ACTIONS.restore}</button
          >
        </div>
      {/each}
    </div>
  {/if}

  {#if scope === 'upload'}
    <div class="notice" data-testid="upload-note">
      这里装的是<b>你自己收集的整句</b> —— 原样保留，不拆、不去重、不改写，<b>不出产出题</b>，
      只做理解与朗读。AI 从里面析出的成分另行入库，走主动/被动那两条线。
    </div>
  {/if}

  <!-- ══ 选中操作条 · D-163 / I-098 四处共用同一个组件 ══ -->
  <SelBar
    ids={selected}
    allIds={view.k === 'ok' ? view.items.map((x) => x.id) : []}
    onselectall={(next) => (selected = next ?? [])}
    silentScope={scope === 'silent'}
    allowPractice={scope !== 'upload'}
    onclear={() => (selected = [])}
    onchanged={async (note) => {
      say(note)
      selected = []
      await load()
    }}
    {onreading}
    {onpractice}
  />

  <!-- ══ 筛选与排序 · D-160 / D-019 ══ -->
  <div class="fbar" style="margin-top:18px">
    {#if layer}
      <span class="ftag" data-testid="tag-layer"
        >{layer === 'B' ? '写作层' : '理解层'}
        <span
          class="x"
          role="button"
          tabindex="0"
          onclick={() => (layer = null)}
          onkeydown={(e) => e.key === 'Enter' && (layer = null)}><Ic n="close" s={18} /></span
        ></span
      >
    {/if}
    {#if cell}
      <span class="ftag" data-testid="tag-cell"
        >{MATRIX_ROWS[cell.row]} × {MATRIX_COLS[cell.col]}
        <span
          class="x"
          role="button"
          tabindex="0"
          onclick={() => (cell = null)}
          onkeydown={(e) => e.key === 'Enter' && (cell = null)}><Ic n="close" s={18} /></span
        ></span
      >
    {/if}
    {#if onlyRepeated}
      <span class="ftag"
        >被重复收集过
        <span
          class="x"
          role="button"
          tabindex="0"
          onclick={() => (onlyRepeated = false)}
          onkeydown={(e) => e.key === 'Enter' && (onlyRepeated = false)}><Ic n="close" s={18} /></span
        ></span
      >
    {/if}
    {#if !layer}
      <button class="fadd" data-testid="filter-b" onclick={() => (layer = 'B')}><Ic n="plus" s={16} /> 只看主动</button>
      <button class="fadd" data-testid="filter-a" onclick={() => (layer = 'A')}><Ic n="plus" s={16} /> 只看被动</button>
    {/if}
    {#if !onlyRepeated}
      <button class="fadd" onclick={() => (onlyRepeated = true)}><Ic n="plus" s={16} /> 只看重复收集</button>
    {/if}
    <select class="srt" bind:value={sort} data-testid="lib-sort">
      {#each SORTS as [v, label] (v)}<option value={v}>排序 · {label}</option>{/each}
    </select>
  </div>

  <!-- ══ 列表 · D-159 精简五样，四个库同一套 ══ -->
  {#if view.items.length === 0}
    <div class="empty" data-testid="lib-empty">
      <!-- ★ B10 · 空态是白名单里的第三处。星是**第二眼才看见**的东西，不解释功能 -->
      <Stars />
      <div class="i"><Ic n="vault" s={26} /></div>
      {#if scope === 'silent'}
        <!-- D-184 第③类：「空是正常的」，一句平静说明 -->
        <h4>还没有练成的知识点</h4>
        <p>一条要连续 3 次判到第 3 档以上才会到这里。</p>
      {:else if scope === 'upload'}
        <h4>还没有收集过句子</h4>
        <p>在 lecture 里用「我的收集」那个落区贴进来。</p>
      {:else if cell || layer || onlyRepeated}
        <h4>这个条件下没有条目</h4>
        <p>把上面的筛选条件去掉一个再看看。</p>
      {:else}
        <h4>库还是空的</h4>
        <p>贴一段英文、分析一次，知识点就会出现在这里。</p>
      {/if}
    </div>
  {:else if scope === 'upload'}
    <!-- I-088 · 上传库单独一套：原句整行显示，点开看它析出了什么（总原型 .ur / .deriv） -->
    <div data-testid="lib-rows">
      {#each byDay(view.items) as g (g.day)}
        <div class="ugrp">{g.day} 上传 · {g.rows.length} 句</div>
        {#each g.rows as it (it.id)}
          <div>
            <div
              class="ur"
              class:sel={selected.includes(it.id)}
              class:cur={selectedId === it.id}
              role="button"
              tabindex="0"
              data-testid="lib-row-{it.id}"
              onclick={() => toggleRow(it.id)}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleRow(it.id)
                }
              }}
            >
              <div class="s">
                <!-- I-098 ·「所有词条都有复选框」。总原型的 .ur 里没有勾选格，
                     但这一栏也是词条，一样要能批量处理 —— 放在句首，不占行尾 -->
                <span
                  class="ck"
                  role="checkbox"
                  aria-checked={selected.includes(it.id)}
                  tabindex="0"
                  aria-label="选中 {it.term}"
                  data-testid="ck-{it.id}"
                  onclick={(e) => {
                    e.stopPropagation()
                    toggleSel(it.id)
                  }}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      toggleSel(it.id)
                    }
                  }}
                ><Ic n="check" s={10} /></span>{it.term}
              </div>
              <div class="m">
                <span>{new Date(it.createdAt).toLocaleDateString('zh-CN')}</span>
                {#if it.lectureName}<span>{it.lectureName}</span>{/if}
                <span class="e" data-testid="ur-count-{it.id}">
                  {it.derivedCount > 0 ? `析出 ${it.derivedCount} 项` : '还没析出成分'}
                  <Ic n="caret" s={12} r={openRows.includes(it.id) ? 'up' : 'dn'} />
                </span>
                <span
                  class="dt3"
                  style="margin-left:auto"
                  role="button"
                  tabindex="0"
                  data-testid="lib-open-{it.id}"
                  onclick={(e) => {
                    e.stopPropagation()
                    onopen(it.id)
                  }}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation()
                      onopen(it.id)
                    }
                  }}>打开 <Ic n="caret" s={12} /></span
                >
              </div>
            </div>
            <div class="deriv" class:show={openRows.includes(it.id)} data-testid="deriv-{it.id}">
              {#if derivedErr[it.id]}
                <div class="dv"><span class="t">读不出来</span><span class="st">{derivedErr[it.id]}</span></div>
              {:else if !derived[it.id]}
                <div class="dv"><span class="st">正在取…</span></div>
              {:else if derived[it.id].length === 0}
                <div class="dv">
                  <span class="st">这句还没被析出过成分 —— 在它所在的 lecture 里点一次分析。</span>
                </div>
              {:else}
                {#each derived[it.id] as d (d.id)}
                  <div
                    class="dv"
                    role="button"
                    tabindex="0"
                    data-testid="dv-{d.id}"
                    onclick={() => onopen(d.id)}
                    onkeydown={(e) => e.key === 'Enter' && onopen(d.id)}
                  >
                    <span class="t">{d.term}</span>
                    <span class="ln {d.layer === 'B' ? 'a' : 'p'}">{d.layer === 'B' ? '写作层' : '理解层'}</span>
                    <span class="st">{d.productionState}{d.streak > 0 ? ` ${d.streak}/3` : ''}</span>
                    <span class="go">打开 <Ic n="caret" s={12} /></span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      {/each}
    </div>
  {:else}
    <div data-testid="lib-rows">
      {#each view.items as it (it.id)}
        <div
          class="lrow"
          class:sel={selected.includes(it.id)}
          class:cur={selectedId === it.id}
          role="button"
          tabindex="0"
          data-testid="lib-row-{it.id}"
          onclick={() => onopen(it.id)}
          onkeydown={(e) => e.key === 'Enter' && onopen(it.id)}
        >
          <span>
            {#if it.recollected > 0}
              <SrcBadge kind="recollected" count={it.recollected} />
            {:else if it.source === 'both'}
              <SrcBadge kind="both" />
            {/if}
          </span>
          <!-- D-163 · 勾选框悬停时显现（占位常驻，不跳动） -->
          <span
            class="ck"
            role="checkbox"
            aria-checked={selected.includes(it.id)}
            tabindex="0"
            aria-label="选中 {it.term}"
                  data-testid="ck-{it.id}"
            onclick={(e) => {
              e.stopPropagation()
              toggleSel(it.id)
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                toggleSel(it.id)
              }
            }}
          ><Ic n="check" s={10} /></span>
          <!--
            ★★ A-3（2026-09-03 UI 审计）· 这个记号原来是 `.lrow` 的**独立子元素**，
            而 `.lrow` 是 **6 列网格**。它一出现就多出第 7 个子元素 ——
            整排右移一格：**释义被挤进 74px 那一列**（截断成「very differe…」），
            **末尾的箭头被挤到第二行**（行高 32 → 56）。139 条**全部**中招。

            ★★★ 第一版我把记号塞进了 `.lt` 里面 —— **那是错的**：
            右键取词时 `.lt` 的文本被图标污染，「这条已经在库里」判不出来，
            于是「加入」又冒出来了（`study.test.ts` 当场抓到）。
            **`.lt` 必须只有词条本身。** 所以外面套一层 `.lt-cell` 占那一格。
          -->
          <span class="lt-cell">
            <span class="lt">{it.term}</span>
            <!--
              ★★★ **行上那枚小标 2026-09-15 去掉了**（D-489 · 使用者裁）。
                它标的是「这一条是练成的还是你自己放一边的」。使用者这一轮裁
                「已练成」这个说法退役，并且**不要小标把这一档分成两半**。
              ★ 判据没删：`silenceKind()` 还在，进度仍然只算练成的那一半（D-485）——
                去掉的只是「把这个区分写到他眼前」。
              ★ `.kindtag` 那条 CSS 一起删了（只藏控件会留一条哑路，`check:css-dead` 也会红）。
            -->
            {#if it.hasSuspect}
              <span
                class="fixmark"
                title="这条可能打错或听岔了 —— 点进去看建议"
                data-testid="fixmark-{it.id}"><Ic n="fix" s={16} /></span
              >
            {/if}
          </span>
          <!--
            ★ 6.2 · 「打错了 / 听岔了，需要修改」的记号。
            使用者：「分析后若系统判定该知识点为打错或听岔了、需要修改，
                     则在知识点上显示一个小图标。用户修改完成后，图标自动消失。」
            记号直接由「还有没有 suspect 区块」决定 —— 改完最后一条，
            区块整块删掉，记号自己就没了。不另设「已处理」位：
            两个位一定会有对不上的那天，而对不上的时候人只会看见一个假记号。
          -->
          <!--
            ★ T-4.10（D-R24 ✅ A · 2026-09-06）· 释义位不再自己判 gloss 空不空。
              状态由 `@core/library-state.ts` 算好放在 `it.state` 里，这里只管画。

              为什么值得改：他的库 208 条里 202 条没释义（全部手机采集、从没分析），
              原来一律打一根 `—`。那根横线不说明任何事，而「还没分析」是个**有意义
              且可行动**的状态 —— 点一下就进那一讲去分析。
              ★ 中性状态片，不是警告色、不是图标（D-R24 A 明写的）；不引新图标（D-410）。
          -->
          <span class="lg">
            {#if it.state === 'derived'}已析出 {it.derivedCount} 个成分
            {:else if it.state === 'glossed'}{it.gloss}
            {:else if it.state === 'unanalysed'}
              <span
                class="unan"
                role={it.lectureId !== null && onlecture ? 'button' : undefined}
                tabindex={it.lectureId !== null && onlecture ? 0 : undefined}
                title={it.lectureId !== null && onlecture
                  ? '还没分析过 —— 点这里进它所在的 Lecture 分析'
                  : '还没分析过'}
                data-testid="unan-{it.id}"
                onclick={(e) => {
                  if (it.lectureId === null || !onlecture) return
                  e.stopPropagation()
                  onlecture(it.lectureId)
                }}
                onkeydown={(e) => {
                  if (e.key !== 'Enter' || it.lectureId === null || !onlecture) return
                  e.stopPropagation()
                  onlecture(it.lectureId)
                }}>{UNANALYSED_LABEL}</span
              >
            {/if}
            <!-- state === 'analysed'：分析过但没写出释义 —— 留空。
                 不说「还没分析」（再点一次未必有用），也不打横线（那根横线正是这次要去掉的） -->
          </span>
          <span class="ln {it.layer === 'B' ? 'a' : 'p'}">{it.layer === 'B' ? '写作层' : '理解层'}</span>
          <span class="dt3"><Ic n="caret" s={12} /></span>
        </div>
      {/each}
    </div>
    {#if scope === 'all'}
      <div style="font-size:var(--fs-2);color:var(--muted);margin-top:12px">
        列表怎么排，测试就按什么顺序出题 —— 你花力气排成想要的样子，它不会白排。
      </div>
    {/if}
  {/if}
{/if}
