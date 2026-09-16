<script lang="ts">
  import type { AssembledPrompt, MaterialRow, PresetRow } from '@shared/api.ts'
  import Ic from './Ic.svelte'
  import { cleanMessage } from '@shared/api.ts'
  import { registerEsc } from './esc-stack.svelte.ts'

  let {
    lectureId,
    materials,
    onrun,
    onscope,
    onquotes,
    onclose
  }: {
    lectureId: number
    /** I-082 · 这一讲贴过的全部材料 —— 勾哪几份由使用者定 */
    materials: MaterialRow[]
    onrun: (extra: string, presetName: string | null, materialIds: number[] | undefined) => void
    /** I-104 · 按类别写完整解析 —— 和「整体分析」是两件事 */
    onscope: (scope: 'self' | 'active' | 'passive') => void
    /** 引文匹配 —— 整讲重配出处（使用者 2026-09-13）*/
    onquotes: () => void
    onclose: () => void
  } = $props()

  /**
   * ★ D-440（2026-09-02）· 他点名的「AI 分析结果」以前**没有 Esc** ——
   * 只能点遮罩或「取消」。现在和别的浮层走同一个 esc-stack，
   * 关的是和「取消」同一个 `onclose`（不新增语义）。
   */
  $effect(() => registerEsc(() => (onclose(), true)))

  /**
   * 分析分两种 · I-104
   *
   * 使用者：「点进去可以有下拉框选择分析『整体分析』『我的收集』『主动词汇』『被动词汇』。
   *          整体分析指的是先整体分析一遍，把知识点匹配、分析到我的收集、主动和被动里面，
   *          但是知识点的详细的分析…需要点击『我的收集』『主动词汇』『被动词汇』
   *          进行单独的详细分析。」
   *
   * 拆开还有一个实际好处：详细解析是**按条计费**的。混在一起时，
   * 「点一次分析」= 一笔说不清多大的账；分开之后，花多少钱由他一次一次决定。
   */
  type Mode = 'whole' | 'self' | 'active' | 'passive' | 'quotes'
  const MODES: [Mode, string][] = [
    ['whole', '整体分析 —— 提取知识点并分到三类'],
    ['self', '我的收集 · 写完整解析'],
    ['active', '写作层 · 写完整解析'],
    ['passive', '理解层 · 写完整解析'],
    /**
     * ★★ 引文匹配（使用者 2026-09-13）。它和上面三档**不是一回事**：
     *   上面三档调 AI 写解析（要时间、要钱、有进度条），
     *   这一档是**文本匹配**（瞬时、确定、不花钱），所以下面它有自己的提示与按钮。
     * ★ 范围写在名字里：整讲三类一起 —— 他特意说了「不是只处理某一个层」。
     */
    ['quotes', '引文匹配 —— 三类知识点一起重配原文出处']
  ]
  let mode = $state<Mode>('whole')

  /**
   * 每一类有多少条、其中多少条还没写过解析。
   *
   * ★★ H-4-1 · 三态，不是「有值 / null」两态。
   *
   * 以前是 `counts | null` + `.catch(() => {})`：取不到的时候 `counts` 留在 null，
   * 而 null 在界面上被解释成「正在数…」，那颗按钮则永久 disabled。
   * 于是**「取不到」被伪装成了「正在数」**，他只看到一颗永远点不动的按钮，
   * 没有任何解释、也没有重试的路 —— 这正是这一轮要消灭的那种失败。
   *
   * 现在「还在数」「取不到」「数出来了」是三个不同的状态，各说各的话。
   */
  type Counts = Record<'self' | 'active' | 'passive', { total: number; pending: number }>
  let counts = $state<{ k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; d: Counts }>({
    k: 'loading'
  })

  async function loadCounts(): Promise<void> {
    counts = { k: 'loading' }
    try {
      counts = { k: 'ok', d: await window.nyx.study.analysisCounts(lectureId) }
    } catch (e) {
      counts = { k: 'error', message: cleanMessage(e) }
    }
  }

  // 放进 $effect 而不是模块顶层：顶层只抓得住第一帧的 lectureId，
  // 弹窗虽然每次都是新挂载的，但依赖写清楚才不会在将来复用时踩坑
  $effect(() => {
    void lectureId
    void loadCounts()
  })

/**
   * 「这一类有多少条」只有那三档有 —— `whole` 和 `quotes` 都不按类计数：
   * 前者是整体分析，后者是整讲一起重配出处（他特意说了「不是只处理某一个层」）。
   */
  const cur = $derived(
    mode === 'whole' || mode === 'quotes' || counts.k !== 'ok' ? null : counts.d[mode]
  )

  /**
   * 分析范围 · I-082
   *
   * 使用者：「分析的范围应该可以自己勾选。」
   * 默认勾上**还没分析过的那些** —— 和以前的行为一致，所以什么都不动直接点
   * 「开始分析」得到的结果不变；想重跑某一份，就自己把它勾上。
   */
  /**
   * `null` = 还没动过，用默认（所有没跑过的）。
   * 不在初始化里直接读 `materials` —— 那样只抓得住第一帧的值，
   * 材料列表在弹窗开着的时候变了（比如另一台设备同步过来），默认就跟着错。
   */
  let touched = $state<Set<number> | null>(null)
  const scope = $derived(
    touched ?? new Set(materials.filter((m) => !m.analyzedAt).map((m) => m.id))
  )

  function toggleScope(id: number): void {
    const next = new Set(scope)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    touched = next
  }

  const allPicked = $derived(scope.size === materials.length && materials.length > 0)

  type View =
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | { k: 'ok'; presets: PresetRow[] }

  let view = $state<View>({ k: 'loading' })
  let picked = $state<number | null>(null)
  let extra = $state('')
  let saveName = $state('')
  let busy = $state(false)
  let err = $state<string | null>(null)
  let full = $state<AssembledPrompt | null>(null)

  /**
   * ★ I-157 · 三层各说各的。
   *
   * 这里原来是**二分**：`source === 'file' ? path : '内置副本…'` —— 而那时候覆盖命中
   * 报的也是 `file`，于是这行显示的是一个**没被用到的磁盘路径**（他会照着去改那个文件）。
   * 加了第三种取值之后如果还留着二分，覆盖会被说成「内置副本」，比原来那句更离谱。
   *
   * 所以写成**穷尽映射**而不是三层三元：`Record<AssembledPrompt['source'], …>` ——
   * 哪天再多一种来源，忘了给它一句话，`check:types` 当场红；三元只会安静地走 else。
   */
  const SOURCE_SAYS: Record<AssembledPrompt['source'], (path: string) => string> = {
    override: (p) => `你改过的那份（偏好 ${p}）`,
    file: (p) => p,
    builtin: () => '内置副本（文件没找到或读不出来）'
  }
  const sourceSays = (p: AssembledPrompt): string => SOURCE_SAYS[p.source](p.path)

  async function load(): Promise<void> {
    try {
      const [presets, mine] = await Promise.all([
        window.nyx.prompts.presets(),
        window.nyx.prompts.lecturePreset(lectureId)
      ])
      // 一个 lecture 通常就是一类材料 —— 上次选的那个默认接着用
      if (mine) {
        picked = mine.id
        extra = mine.extra
      }
      view = { k: 'ok', presets }
    } catch (e) {
      view = { k: 'error', message: cleanMessage(e) }
    }
  }
  load()

  function pick(p: PresetRow | null): void {
    picked = p?.id ?? null
    extra = p?.extra ?? ''
    full = null
  }

  async function run(): Promise<void> {
    busy = true
    err = null
    try {
      await window.nyx.prompts.setLecturePreset(lectureId, picked)
      const name =
        view.k === 'ok' ? (view.presets.find((p) => p.id === picked)?.name ?? null) : null
      onrun(extra, extra.trim() ? (name ?? '（临时指令）') : null, [...scope])
    } catch (e) {
      err = cleanMessage(e)
      busy = false
    }
  }

  async function saveAsPreset(): Promise<void> {
    err = null
    try {
      const id = await window.nyx.prompts.savePreset({ name: saveName, extra })
      saveName = ''
      await load()
      picked = id
    } catch (e) {
      err = cleanMessage(e)
    }
  }

  async function removePreset(p: PresetRow): Promise<void> {
    err = null
    try {
      await window.nyx.prompts.deletePreset(p.id)
      if (picked === p.id) pick(null)
      await load()
    } catch (e) {
      err = cleanMessage(e)
    }
  }

  async function showFull(): Promise<void> {
    err = null
    try {
      full = full ? null : await window.nyx.prompts.assembled('analyze-material', extra)
    } catch (e) {
      err = cleanMessage(e)
    }
  }
</script>

<!-- I-082 · 从「推开正文的一块面板」改成弹窗。
     使用者：「分析应该是弹窗。」正文位置不再被顶来顶去。 -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="ov on" data-testid="analyze-panel" onclick={onclose}>
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="mbox" style="width:min(620px,100%)" onclick={(e) => e.stopPropagation()}>
  <h3>这一批怎么分析</h3>

  {#if view.k === 'error'}
    <div class="errbox"><div class="h">预设读不出来</div><div>{view.message}</div></div>
  {:else if view.k === 'loading'}
    <div class="s2">正在读预设…</div>
  {:else}
    {#if err}
      <div class="errbox" data-testid="panel-error"><div class="h">出问题了</div><div>{err}</div></div>
    {/if}

    <!-- I-082 · 范围。默认勾没跑过的，勾了才算数 -->
    <!-- I-104 · 先选做哪一种分析 -->
    <div class="s2" style="margin-top:12px">分析什么</div>
    <select
      class="tin2"
      style="margin:0 0 10px"
      data-testid="analyze-mode"
      bind:value={mode}
    >
      {#each MODES as [m, label] (m)}
        <option value={m}>{label}</option>
      {/each}
    </select>

    <!--
      ══ 引文匹配 ══
      ★ 不复用下面那句「开始写解析（N 条）」：它根本不写解析，
        按钮上写着「写解析」就是假话（D-412）。
    -->
    {#if mode === 'quotes'}
      <div class="notice" data-testid="quotes-note">
        {#if materials.length === 0}
          <b>这个 Lecture 还没有原文</b> —— 引文匹配是拿原文去找句子的，先加一份原文。
        {:else}
          拿这个 Lecture 的<b>原文</b>给<b>我的收集 · 写作层 · 理解层</b>里的每一条重新找出处。
          <span class="dim"
            >同一条在原文里出现好几次，取<b>第一次</b>那一句；原文里找不到的<b
              >保留现在的出处</b
            >，不会清空。</span
          >
        {/if}
      </div>
      <div class="mact">
        <button class="btn" data-testid="panel-cancel-q" onclick={onclose}>取消</button>
        <button
          class="btn pri"
          disabled={materials.length === 0}
          data-testid="run-quotes"
          onclick={() => onquotes()}>开始匹配</button
        >
      </div>
    {:else if mode !== 'whole'}
      <div class="notice" data-testid="scope-note">
        {#if counts.k === 'loading'}
          正在数…
        {:else if counts.k === 'error'}
          <!-- ★ H-4-1 · 取不到就说取不到，不许装成「这一类没有内容」 -->
          <b>分析范围暂时取不到</b>　<span class="dim">{counts.message}</span>
          <button
            class="btn sm"
            style="margin-left:8px"
            data-testid="scope-retry"
            onclick={() => void loadCounts()}>重试</button
          >
        {:else if cur === null}
          正在数…
        {:else if cur.total === 0}
          这一类下面还没有知识点。先做一次<b>整体分析</b>。
        {:else if cur.pending === 0}
          这一类 {cur.total} 条<b>全部写过解析了</b> —— 没有要跑的。
        {:else}
          共 {cur.total} 条，其中 <b>{cur.pending} 条</b>还没写解析。
          <span class="dim">已经写过的会自动跳过；中途暂停，下次接着这里跑。</span>
        {/if}
      </div>
      <div class="mact">
        <button class="btn" data-testid="panel-cancel" onclick={onclose}>取消</button>
        <button
          class="btn pri"
          disabled={!cur || cur.pending === 0}
          data-testid="run-scope"
          onclick={() => onscope(mode as 'self' | 'active' | 'passive')}
          >开始写解析（{cur?.pending ?? 0} 条）</button
        >
      </div>
    {:else}
    <div class="s2">
      <b>prompts 文件夹里的 .md 是基线</b>，管全局，记事本改完存盘就生效。
      下面那段临时指令<b>只对这一次生效</b> —— 不同材料该抓的东西不一样。
    </div>
    <div class="s2" style="margin-top:12px">
      分析哪几份
      <button
        class="btn sm"
        style="margin-left:8px"
        data-testid="scope-all"
        onclick={() =>
          (touched = allPicked ? new Set() : new Set(materials.map((m) => m.id)))}
      >
        {allPicked ? '全不选' : '全选'}
      </button>
    </div>
    {#if materials.length === 0}
      <div class="s3 dim">这个 Lecture 还没有材料。</div>
    {:else}
      <div data-testid="scope-list">
        {#each materials as m (m.id)}
          <div
            class="lrow"
            class:sel={scope.has(m.id)}
            role="button"
            tabindex="0"
            data-testid="scope-{m.id}"
            onclick={() => toggleScope(m.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleScope(m.id)
              }
            }}
          >
            <span></span><span class="ck"><Ic n="check" s={10} /></span>
            <span class="lt">{m.title}</span>
            <span class="lg">{m.kind === 'original' ? '原文材料' : '我的收集'} · {m.charCount} 字</span>
            <span class="ln p">{m.analyzedAt ? '已分析过' : '没跑过'}</span>
            <span></span>
          </div>
        {/each}
      </div>
      <div class="s3 dim" style="margin-top:6px">
        勾上<b>已分析过</b>的那份＝重新分析它。重跑会再花一次钱，之前捞到的条目不会消失。
      </div>
    {/if}

    <div class="s2" style="margin-top:12px">预设</div>
    <div class="chips" data-testid="preset-chips">
      <button class="c" class:on={picked === null} onclick={() => pick(null)} data-testid="preset-none"
        >不加补充</button
      >
      {#each view.presets as p (p.id)}
        <button class="c" class:on={picked === p.id} onclick={() => pick(p)} data-testid="preset-{p.id}"
          >{p.name}</button
        >
      {/each}
    </div>

    <textarea
      class="pastebox"
      style="min-height:110px"
      data-testid="extra-text"
      placeholder={'例如：这篇是访谈实录，口语说法优先，学术腔的短语一律判被动。\n或者：只挑动词搭配，名词性的都别要。'}
      bind:value={extra}
    ></textarea>

    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
      <button
        class="btn pri"
        disabled={busy || scope.size === 0}
        data-testid="run-analyze"
        onclick={run}>{busy ? '开始了…' : `开始分析（${scope.size} 份）`}</button
      >
      <button class="btn" data-testid="panel-cancel" onclick={onclose}>取消</button>
      <span style="flex:1"></span>
      <button class="btn sm" data-testid="show-full" onclick={showFull}
        >{full ? '收起' : '看完整提示词'}</button
      >
      <button class="btn sm" data-testid="open-prompts" onclick={() => window.nyx.prompts.openFolder()}
        >打开 prompts 文件夹</button
      >
    </div>

    {#if extra.trim()}
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <input
          class="tin2"
          style="margin-top:0;flex:1"
          placeholder="把这段存成预设，下次直接选，例如「访谈实录」"
          data-testid="preset-name"
          bind:value={saveName}
        />
        <button class="btn sm" disabled={!saveName.trim()} data-testid="save-preset" onclick={saveAsPreset}
          >存成预设</button
        >
      </div>
    {/if}

    {#if picked !== null}
      {@const cur = view.presets.find((p) => p.id === picked)}
      {#if cur}
        <div class="s2 dim" style="margin-top:8px">
          正在用「{cur.name}」{#if extra !== cur.extra}（已改动，这次按改后的来，没存回预设）{/if}
          <button class="btn sm" style="margin-left:8px" data-testid="del-preset" onclick={() => removePreset(cur)}
            >删掉这个预设</button
          >
        </div>
      {/if}
    {/if}

    {/if}

    {#if full && mode === 'whole'}
      <div class="s2" style="margin-top:14px">
        完整提示词 · 基线来自 <b data-testid="prompt-source">{sourceSays(full)}</b>
      </div>
      <pre class="promptbox" data-testid="full-prompt">{full.system}

── 以下是每次都会拼上的输出格式与材料 ──

{full.userTemplate}</pre>
    {/if}
  {/if}
</div>
</div>
