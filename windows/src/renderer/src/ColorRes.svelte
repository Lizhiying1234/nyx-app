<script lang="ts">
  /**
   * ══ Settings → Resources → Colors（使用者 2026-09-13）════════════════
   *
   * 他的原话拆成六条，逐条落在下面：
   *   ① 一个**模式**就是一整套配色
   *   ② 点不同模式像 Tab 切换（Mode A → 显示 A 的完整颜色设置）
   *   ③ 每个模式下面有 **Apply / 应用**，点了立刻整套应用到当前软件
   *   ④ 可以：新建 · 命名 · 改名 · 改具体颜色 · 应用
   *   ⑤ **不能只设一个总颜色** —— 要能拆到具体 UI 部件逐项调
   *   ⑥ 一个全局的 **Reset to Default**
   *
   * ══ 两处我替他定的，理由写在这儿 ═══════════════════════════════════
   *
   * ★★ **选中一个模式就实时预览，Apply 才是「记住它」。**
   *   照字面做（点 Tab 只是切换表单、Apply 才上色）的话，他调颜色时屏上
   *   没有任何反馈 —— 一个调色页看不见自己调的结果，那是不能用的。
   *   所以：切到哪一套就涂哪一套，页面顶上明说「正在预览 · 还没应用」；
   *   **不按 Apply 就离开，一律恢复成原来在用的那一套**（不偷偷改他的软件）。
   *
   * ★★ **「默认」不是一套存下来的配色，是「没有覆盖」。**
   *   他说的是「把当前正在使用的方案存成默认模式，Reset 一键回去」。
   *   往库里存一份 hex 快照能做到这件事，但那份快照会和 `color-tokens.css`
   *   各说各话 —— **同一件事两份判据**，这个项目为这个付过最多学费。
   *   所以出厂那套的真相只留一份（样式表本身），
   *   **Reset to Default = 把覆盖层清空**，效果一模一样，而且永远不会漂。
   *   他要拿出厂那套当起点，用「照这一套新建」把值复制过去。
   *
   * ══ 涂到屏上的办法 ═════════════════════════════════════════════════
   * 往 `:root` 写行内样式（`colors.ts::paint`）—— 行内压过任何样式表，
   * 现有 CSS 一行不用改。全端颜色只有 `color-tokens.css` 一个 `:root` 出处，
   * 老名字（`--bg` / `--text-2` …）全是它的别名，所以改语义层会自己流下去。
   * 唯一涂不到的是开窗第一帧，那一处由主进程去库里问（`main/colors.ts`）。
   *
   * ★ 样式全在 enhancements.css 的 `.clr*`（D-227：组件里一行样式都不写）。
   */
  import type { ColorMode } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import { addMode, cleanName, editMode, isColorValue, removeMode } from '@core/design/colors.ts'
  import { allColorTokens, contrast, currentValue, groupTokens, paint, toHex } from './colors.ts'
  import Dialog from './Dialog.svelte'
  import Ic from './Ic.svelte'
  import { say, sayBad } from './toast.svelte.ts'

  /** 库里存着的那几套 ＋ 正在用的是哪一套 */
  let modes = $state<ColorMode[]>([])
  let appliedId = $state('')
  /** 这一页正在看 / 正在改的是哪一套。空串 = 「默认」那一栏 */
  let viewId = $state('')
  /** 正在改的那一套的草稿（token → 颜色）。`viewId` 一变就重新装 */
  let draft = $state<Record<string, string>>({})
  /** 出厂那套每一项**本来**是什么颜色 —— 开页时在「没有任何覆盖」的状态下量的 */
  let factory = $state<Record<string, string>>({})
  let sections = $state<{ id: string; en: string; zh: string; note: string; tokens: string[] }[]>([])
  let loading = $state(true)
  let dirty = $state(false)
  let openSection = $state<string | null>(null)
  let asking = $state<null | { kind: 'del'; id: string; name: string }>(null)
  let renaming = $state<null | { id: string; value: string }>(null)

  const viewed = $derived(modes.find((m) => m.id === viewId) ?? null)
  /** 正在预览、但还没按 Apply —— 顶上那句话说的就是它 */
  const previewing = $derived(viewId !== appliedId)

  async function load(): Promise<void> {
    try {
      const r = await window.nyx.res.colorModes()
      modes = r.modes
      appliedId = r.activeId
      viewId = r.activeId

      /**
       * ★ 出厂值必须在**没有覆盖**的状态下量 —— 先把覆盖层清空、读一遍、再涂回去。
       *   直接读的话，量到的是「他上次改成的那个颜色」，
       *   于是「已改」标记会全屏消失，而 Reset 之后才莫名其妙冒出来。
       */
      paint({})
      const names = allColorTokens()
      const snap: Record<string, string> = {}
      for (const n of names) snap[n] = currentValue(n)
      factory = snap
      sections = groupTokens(names).map((g) => ({
        id: g.section.id,
        en: g.section.en,
        zh: g.section.zh,
        note: g.section.note,
        tokens: [...g.tokens]
      }))
      openSection = sections[0]?.id ?? null
      paint(r.overrides)
      loadDraft()
    } catch (e) {
      sayBad('读不出配色：' + cleanMessage(e))
    } finally {
      loading = false
    }
  }

  function loadDraft(): void {
    const m = modes.find((x) => x.id === viewId)
    draft = m ? { ...m.tokens } : {}
    dirty = false
  }

  /** 切到某一套：装草稿 ＋ **实时涂上去**（预览） */
  function view(id: string): void {
    viewId = id
    loadDraft()
    paint(draft)
  }

  /** 改一项颜色 → 立刻看得见 */
  function setToken(name: string, raw: string): void {
    const v = raw.trim()
    if (!isColorValue(v)) return // 半截输入不报错也不涂，等他打完
    draft = { ...draft, [name]: v }
    dirty = true
    paint(draft)
  }

  /** 把某一项改回出厂 */
  function clearToken(name: string): void {
    const next = { ...draft }
    delete next[name]
    draft = next
    dirty = true
    paint(draft)
  }

  /**
   * 这一页**唯一**跟主进程说话的地方 —— 所以失败也由它自己交代。
   *
   * ★ 一开始 try/catch 写在各个调用方，`check:ipc-guard` 当场红了，而它是对的：
   *   扫描器看不过函数边界，**而它看不到的东西下一个人也看不到** ——
   *   哪天有人加一个新调用方忘了包 try，失败就会变成「点了没反应」。
   *   判据钉在这一层，就不存在「忘了包」这回事。
   * @returns 成没成。调用方只看这个布尔，不用自己接错。
   */
  async function persist(next: ColorMode[], nextApplied?: string): Promise<boolean> {
    try {
      /** ★ `$state.snapshot` ＋ 转成字符串：Svelte 5 的代理不能结构化克隆（2026-09-09 那次） */
      const saved = await window.nyx.res.saveColorModes(JSON.stringify($state.snapshot(next)))
      modes = saved
      if (nextApplied !== undefined) {
        const r = await window.nyx.res.applyColors(nextApplied)
        appliedId = r.activeId
        paint(r.overrides)
      }
      return true
    } catch (e) {
      sayBad('没存下来：' + cleanMessage(e))
      return false
    }
  }

  async function save(): Promise<void> {
    if (!viewed) return
    if (await persist(editMode(modes, viewed.id, { tokens: { ...draft } }, Date.now()))) {
      dirty = false
      say('存好了')
    }
  }

  /** Apply —— 他原话：「点了后立即将这一整套颜色方案应用到当前软件」 */
  async function apply(): Promise<void> {
    try {
      if (viewed && dirty) {
        if (!(await persist(editMode(modes, viewed.id, { tokens: { ...draft } }, Date.now()), viewId))) return
        dirty = false
      } else {
        const r = await window.nyx.res.applyColors(viewId)
        appliedId = r.activeId
        paint(r.overrides)
      }
      say(viewId === '' ? '回到默认配色了' : '应用了')
    } catch (e) {
      sayBad('没应用成：' + cleanMessage(e))
    }
  }

  /** Reset to Default —— 一键回到出厂那套（= 把覆盖层清空） */
  async function reset(): Promise<void> {
    try {
      const r = await window.nyx.res.applyColors('')
      appliedId = r.activeId
      viewId = ''
      loadDraft()
      paint(r.overrides)
      say('已经回到默认配色')
    } catch (e) {
      sayBad('没重置成：' + cleanMessage(e))
    }
  }

  /** 新建一套。`from` 传当前这一套的值 = 「照这一套改」 */
  async function create(from: Record<string, string>): Promise<void> {
    const name = cleanName('配色 ' + (modes.length + 1))
    const r = addMode(modes, name, from, Date.now())
    if (!r.ok) {
      sayBad(r.why)
      return
    }
    if (await persist(r.modes)) {
      view(r.id)
      renaming = { id: r.id, value: name }
    }
  }

  async function doRename(): Promise<void> {
    if (!renaming) return
    const { id, value } = renaming
    renaming = null
    if (!cleanName(value)) return
    await persist(editMode(modes, id, { name: value }, Date.now()))
  }

  async function doDelete(): Promise<void> {
    const target = asking
    asking = null
    if (!target) return
    const next = removeMode(modes, target.id)
    // 删掉的正好是正在用的那一套 → 退回默认（不让软件停在一个不存在的模式上）
    if (await persist(next, appliedId === target.id ? '' : undefined)) {
      if (viewId === target.id) {
        viewId = appliedId
        loadDraft()
      }
      say('删掉了')
    }
  }

  /** 这一项和出厂比，改了没有 */
  function changed(name: string): boolean {
    return draft[name] !== undefined
  }

  /** 屏上显示的那个值（改过的用草稿，没改的用出厂） */
  function shown(name: string): string {
    return draft[name] ?? factory[name] ?? ''
  }

  /**
   * 文字压在面上的对比度。**只说，不拦** ——
   * 他是这个软件的独裁人，但「不知道自己把字调到看不清了」和
   * 「知道，我就要这样」是两回事，只有说出来才分得开（D-412）。
   */
  const textContrast = $derived(contrast(shown('--color-text'), shown('--color-bg')))

  $effect(() => {
    load()
    return () => {
      /* 离开这一页：**不按 Apply 就不算数**，把屏幕恢复成真正在用的那一套 */
      window.nyx.res
        .colorModes()
        .then((r) => paint(r.overrides))
        .catch(() => paint({}))
    }
  })
</script>

<div class="clr" data-testid="color-res">
  <div class="sh">Colors</div>
  <div class="shs">
    一个<b>模式</b>就是一整套配色。<b>这一套只管这台电脑</b> —— 颜色模式不跟手机同步，
    两端各管各的（和启动页里「图片共享、选哪张各端自己定」是同一条分界）。
  </div>

  {#if loading}
    <div class="dim" data-testid="clr-loading">读取中…</div>
  {:else}
    <!-- ══ 模式条 · 他说的「点不同模式，类似 Tab 切换」══ -->
    <div class="clrtabs" data-testid="clr-tabs">
      <button class:on={viewId === ''} data-testid="clr-tab-default" onclick={() => view('')}>
        Default{#if appliedId === ''}<span class="inuse" data-testid="clr-inuse">使用中</span>{/if}
      </button>
      {#each modes as m (m.id)}
        <button class:on={viewId === m.id} data-testid="clr-tab-{m.id}" onclick={() => view(m.id)}>
          {m.name}{#if appliedId === m.id}<span class="inuse" data-testid="clr-inuse">使用中</span>{/if}
        </button>
      {/each}
      <button class="add" data-testid="clr-new" onclick={() => create({ ...draft })}>
        <Ic n="plus" s={16} /> 新建
      </button>
    </div>

    <!-- ══ 这一套的抬头：名字 · 状态 · 动作 ══ -->
    <div class="clrhead" data-testid="clr-head">
      <div class="t">
        {#if renaming && viewed && renaming.id === viewed.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="in"
            autofocus
            data-testid="clr-rename"
            bind:value={renaming.value}
            onblur={doRename}
            onkeydown={(e) => e.key === 'Enter' && doRename()}
          />
        {:else}
          <span class="nm">{viewed ? viewed.name : 'Default · 出厂配色'}</span>
          {#if viewed}
            <button
              class="lnk"
              data-testid="clr-rename-go"
              onclick={() => (renaming = { id: viewed.id, value: viewed.name })}>改名</button
            >
          {/if}
        {/if}
      </div>
      <div class="s">
        {#if previewing}
          <span class="warn" data-testid="clr-previewing">正在预览 · 还没应用</span>
        {:else if dirty}
          <span class="warn" data-testid="clr-dirty">改了还没存</span>
        {/if}
      </div>
      <div class="a">
        {#if viewed}
          <button class="btn sm" disabled={!dirty} data-testid="clr-save" onclick={save}>保存</button>
          <button
            class="btn sm"
            data-testid="clr-del"
            onclick={() => (asking = { kind: 'del', id: viewed.id, name: viewed.name })}>删除</button
          >
        {/if}
        <button class="btn sm pri" data-testid="clr-apply" onclick={apply}>Apply · 应用</button>
      </div>
    </div>

    {#if !viewed}
      <div class="notice" data-testid="clr-default-note">
        <b>Default 是「没有任何覆盖」</b>，不是一份存下来的配色 ——
        所以它永远等于这一版软件出厂的样子，不会跟着任何改动漂。
        想以它为起点，点上面的<b>「新建」</b>，出厂的每一项都会复制过去。
      </div>
    {/if}

    {#if textContrast !== null}
      <!-- 只提示不拦：改了配色之后，U-014 / U-015 量过的比值就不成立了 -->
      <div class="clrcon" class:bad={textContrast < 4.5} data-testid="clr-contrast">
        正文压在页面底色上的对比度 <b>{textContrast.toFixed(2)}</b>
        {#if textContrast < 4.5}
          —— 低于 4.5，小字会开始吃力。<b>不拦你</b>，只是说一声。
        {:else}
          · 够用（≥4.5）
        {/if}
      </div>
    {/if}

    <!-- ══ 逐个 UI 部件 · 他点名的「不能只设一个总颜色」══ -->
    {#each sections as sec (sec.id)}
      <div class="clrsec" data-testid="clr-sec-{sec.id}">
        <button
          class="h"
          data-testid="clr-sec-head-{sec.id}"
          onclick={() => (openSection = openSection === sec.id ? null : sec.id)}
        >
          <span class="en">{sec.en}</span><span class="zh">{sec.zh}</span>
          <span class="n">{sec.tokens.length}</span>
          <span class="car" class:open={openSection === sec.id}>›</span>
        </button>
        {#if openSection === sec.id}
          <div class="note">{sec.note}</div>
          <div class="rows">
            {#each sec.tokens as name (name)}
              <div class="r" class:on={changed(name)} data-testid="clr-row-{name}">
                <span class="sw" style="background:{shown(name)}"></span>
                <span class="k">{name}</span>
                <input
                  class="pick"
                  type="color"
                  disabled={!viewed}
                  value={toHex(shown(name))}
                  data-testid="clr-pick-{name}"
                  oninput={(e) => setToken(name, e.currentTarget.value)}
                />
                <input
                  class="hex"
                  disabled={!viewed}
                  value={shown(name)}
                  data-testid="clr-hex-{name}"
                  onchange={(e) => setToken(name, e.currentTarget.value)}
                />
                {#if changed(name)}
                  <button class="lnk" data-testid="clr-reset-{name}" onclick={() => clearToken(name)}
                    >改回出厂</button
                  >
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}

    <div class="clrfoot">
      <button class="btn sm" data-testid="clr-reset-all" onclick={reset}>Reset to Default · 重置为默认</button>
      <span class="dim">把覆盖层清空，回到这一版软件出厂的配色。你存下的模式一套都不会丢。</span>
    </div>
  {/if}
</div>

{#if asking}
  <Dialog
    title="删掉「{asking.name}」？"
    body="这一套配色会没掉，别的模式不受影响。正在用的话会退回默认配色。"
    confirmLabel="删掉"
    danger
    testid="clr-del-dialog"
    onconfirm={doDelete}
    oncancel={() => (asking = null)}
  />
{/if}
