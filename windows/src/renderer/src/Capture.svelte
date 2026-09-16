<script lang="ts">
  import type { TreeProject } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import DictCard from './DictCard.svelte'
  import { speak } from './speak.ts'
  import PathPicker from './PathPicker.svelte'
  import Ic from './Ic.svelte'
  import { registerEsc } from './esc-stack.svelte.ts'
  import { say, sayBad } from './toast.svelte.ts'

  let {
    tree,
    /** 当前正开着的那一讲 —— 「收进本 lecture」要用它（I-062） */
    currentLecture = null
  }: { tree: TreeProject[]; currentLecture?: number | null } = $props()

  /**
   * 全局右键 · R-003 / D-039 / D-048 / D-200
   *
   * D-039 原本限定「右键只出现在解析正文」，理由是「菜单内容应由你选中的是什么决定，
   * 共用一个菜单会出现大量灰掉的选项」。**理由成立，但结论下反了** ——
   * 正确的做法不是缩小范围，是**让菜单内容随上下文变**。（阅读回执里提过，你说按我说的来。）
   *
   * 所以：凡是能选中文字的地方都能右键，菜单按选中的东西给不同的项。
   * 用**一个组件 + 事件委托**（D-200），不逐处写事件 —— 动态渲染出来的行自动就有。
   */
  let menu = $state<{ x: number; y: number; text: string; kind: Kind } | null>(null)
  /** 悬浮词典卡片。**只有一张** —— 查下一个词换的是它的内容，不是再开一张 */
  let dict = $state<{ word: string; at: { x: number; y: number } } | null>(null)
  /**
   * 卡上那颗「收下」进哪一讲：**当前这一讲优先**，没有才用 Settings 里设的默认。
   * ★ 顺序不能反 —— 他正开着某一讲的时候，收进那一讲才是他的意思。
   */
  let fallbackLecture = $state<number | null>(null)
  window.nyx.glance
    .get()
    .then((a) => (fallbackLecture = a.lecture))
    .catch(() => {
      /* 没有默认讲次只是少一颗「收下」，不影响查词 */
    })
  /**
   * I-093 · 选位置改成三段并排（项目___▾ 单元___▾ Lecture___▾）。
   * 以前是把**所有 lecture 平铺**成一长串塞进右键菜单 —— lecture 一多就没法看，
   * 而且没法新建。使用者要的是「三段下拉 + 横线能直接建 + 选完看得见、能重选」。
   */
  let picking = $state(false)
  /** 选中的那一讲。显示在弹窗里，点「重新选择」可以改 */
  let picked = $state<number | null>(null)
  /**
   * I-062 · 先选层，再选去处。
   *
   * 使用者：「我也希望可以弹窗选择收进主动还是被动词汇，这个可以先选，
   *          然后再选收进本 lecture，还是选择位置。」
   *
   * 顺序是有道理的：**判层是关于这条本身的**（我要不要练到能写出来），
   * 去哪一讲只是归档。先定性质，再定位置。
   * null = 还没选，菜单停在第一步。
   */
  let layer = $state<'A' | 'B' | null>(null)
  /**
   * ★ 这一条**留在原地**：它只在「收进哪个 Lecture」那个弹窗里显示，
   *   跟着那颗「收进来」按钮走 —— 就是判据里说的「跟某个控件绑着 → Inline」。
   *   把它扒成回执条反而更差：错误会飘到屏幕另一头，而他正看着这个弹窗。
   */
  let error = $state<string | null>(null)
  /**
   * ══ 回执走全局那一条，这里不再自己长一个 ★★（使用者 2026-09-14 第五条）══
   *
   * 他的原话：「收进理解层了：「Design」然后还需要手动点击『好』才能让提示消失。
   * 我不希望这种纯信息反馈还要求用户额外点击。」**他点的就是这一处。**
   *
   * ── 这儿以前是什么 ─────────────────────────────────────────
   * 一个手搓的 `.toast` + 一颗「好」。它比全局那条 `Toast` 早，
   * 而全局那条（`toast.svelte.ts`，NT-Q1/NT-Q5/BTN-Q5 定案）**本来就有**
   * 这一页要的全部东西：4 秒自走 · 同一时刻只有一条 · 失败那种不自动消失。
   * 于是软件里同时活着两套回执，而只有其中一套听他的话。
   *
   * ★ 删掉的是**载体**，不是那句话：文案一个字没改，失败仍然要他看见
   *   （`sayBad` 不自动消失 —— 「没看见就没了」对失败不可接受）。
   */

  /**
   * ★ T-4.14 · 上一次查词在账本里的那一行（id + 当时查的是哪个词面）。
   *
   * 只留**最近一次**：他连着查三个词是常事，而「查了之后收下了」
   * 说的永远是刚才那一个。收下的时候会拿词面再核一次，核不上就不回填 ——
   * 查了 A 转头收了 B，那是两件事，不该被拼成一条学习路径。
   * ★ 不用 `$state`：界面上一个字都不显示它，它只是两次动作之间的一根线。
   */
  let lastLookup: { id: number; term: string } | null = null

  /** 选中的是什么，决定菜单里有什么 */
  type Kind = 'passage' | 'item' | 'ui' | 'doc'

  const lectures = $derived(
    tree.flatMap((p) =>
      p.units.flatMap((u) => u.lectures.map((l) => ({ ...l, path: `${p.name} › ${u.name}` })))
    )
  )

  function classify(node: Node | null): Kind {
    let el = node instanceof Element ? node : node?.parentElement
    while (el) {
      // 已入库条目：行尾有 •••，不该再出现「加入」
      if (el.matches?.('.lrow, .srow, .fd, .evo, .ev')) return 'item'
      /**
       * ★ 文件学习那篇正文（使用者 2026-09-13 · 4.2）
       *
       * 他的原话：「当我选中内容准备收进去时，原来其他无关的选项不要保留，
       * 只留下 Save……不要再让我在写作 / 理解之间进行选择。默认直接收进理解层。」
       *
       * 所以这一处**单独成一档**：收进去那条路从「选层 → 选去处」两步
       * 收成**一颗 Save**，直接进本篇设的那一讲、层固定 'A'。
       * ★ `.doc` 全仓只有 FileStudy 用（grep 过），所以这一档不会波及别的屏 ——
       *   别处右键仍然是原来那两步（他说的是「在文件学习中」）。
       * ★ 朗读 / 查词 / 复制**留着**：它们不是「收进去」的选项，
       *   而在一篇正在读的文章上，查词恰恰是最要紧的那个（D-456 同一条精神：
       *   覆盖面一条不减，减的是**步骤**）。
       */
      if (el.matches?.('.doc')) return 'doc'
      // 解析正文 / 原文摘句 / 对话 / 文档：这些是「可捞」的地方
      if (el.matches?.('.doc, .qb, .msg, .ib, .nu, .ex, .quo, .promptbox, .task')) return 'passage'
      el = el.parentElement
    }
    return 'ui'
  }

  function onContext(e: MouseEvent): void {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (!text) {
      menu = null
      return
    }
    e.preventDefault()
    error = null
    picking = false
    layer = null
    menu = {
      // 靠边自动翻转（D-200 边界检测）
      x: Math.min(e.clientX, window.innerWidth - 240),
      y: Math.min(e.clientY, window.innerHeight - 220),
      text: text.length > 300 ? text.slice(0, 300) + '…' : text,
      kind: classify(sel?.anchorNode ?? null)
    }
  }

  /**
   * 5.2 · 复制之后**不再弹提示**。
   *
   * 使用者：「复制、朗读等操作后，不再弹出『题型』类确认反馈
   *          （如『复制-好』『读出来了-好』等）。」
   *
   * 他是对的：复制成功是**默认结果**，剪贴板里有没有他自己一试就知道。
   * 为一个必然成功的动作弹一句「好」，是在替软件表功。
   * 失败才值得说 —— 所以下面只在真出错时出声。
   */
  async function copy(): Promise<void> {
    const t = menu?.text
    menu = null
    if (!t) return
    try {
      await navigator.clipboard.writeText(t)
    } catch (err) {
      /** ★ 失败走 `sayBad` —— 它**不自动消失**，要么他关掉要么被下一条替掉 */
      sayBad(cleanMessage(err))
    }
  }

  /**
   * M-012 · 加入时**必须带上原文出处** —— 这是不可丢失的字段。
   * I-062 · 走 `addItem` 而不是 `addChunks`：前者能带上使用者自己选的层，
   * 后者一律按「我收集的整句」入库（layer='A'，不出产出题）——
   * 而他明确要能选主动。原文出处就是选中的这段话本身。
   */
  async function addTo(lectureId: number, forceLayer?: 'A' | 'B'): Promise<void> {
    /** ★ 4.2 · 文件学习那一档不选层，直接按理解层收 —— 所以允许把层传进来 */
    const use = forceLayer ?? layer
    if (!menu || !use) return
    const text = menu.text
    try {
      const r = await window.nyx.data.addItem(lectureId, text, '', use, text)
      /**
       * ★★ 4.3 · 使用者原话：「Save 成功 → Findings 立即更新并显示」，
       *   不许「Save → 看不到 → 去别的页面再回来才出现」。
       *   右键菜单是**全局**组件，它不知道谁在听 —— 所以广播一声，
       *   正开着那一讲的页面自己去刷。
       * ★ 只在**真的写进去之后**才发：发早了他会看到一条并不存在的 Finding。
       */
      window.dispatchEvent(
        new CustomEvent('nyx:item-added', { detail: { lectureId, itemId: r.id } })
      )
      menu = null
      picking = false
      say(
        `收进${use === 'B' ? '写作层' : '理解层'}了：「${text.slice(0, 20)}${text.length > 20 ? '…' : ''}」` +
          (r.duplicateOf ? '　这条以前收过 —— 上一次「学会」可能是假的（D-026）。' : '')
      )
      layer = null
      /**
       * ★ T-4.14 · 「查了 → 收下了」回填到刚才那次查词那一行上。
       *
       * 单独一个 try：**收进来已经成了**，账本这一层再出什么事
       * 都不许翻成一句「没收成」摆到他脸上（这正是记账最容易造的假故障）。
       */
      try {
        if (lastLookup && lastLookup.term === text) {
          await window.nyx.ledger.lookupSaved(lastLookup.id, r.id)
          lastLookup = null
        }
      } catch {
        /* 记不上就算了 —— 少一条学习证据，不是一次失败的收藏 */
      }
    } catch (err) {
      /**
       * ★★ 没收成的话，话要**落在他正看着的地方**：
       *   · 选位置那个弹窗还开着 → 就地一行（跟那颗「收进来」绑着）
       *   · 右键菜单那条路 → 菜单已经没了，就地没地方住 → 回执条（不自动消失）
       */
      const msg = cleanMessage(err)
      if (picking) error = msg
      else sayBad(msg)
    }
  }

  /**
   * I-062 · 顺手朗读选中的这段 —— 右键菜单里最自然的一项。
   * 5.2 · 读得出来就不说话（声音本身就是反馈）；**读不出来才出声**。
   */
  async function readAloud(): Promise<void> {
    if (!menu) return
    const t = menu.text
    menu = null
    const problem = await speak(t)
    /** 5.2 · 读得出来就不说话；读不出来是**没做成**，走不自动消失的那一种 */
    if (problem) sayBad(problem)
  }

  /**
   * I-062 · 顺手**查词** → 统一的查词面板（2026-08-16 起是悬浮卡片）
   *
   * ★★ 2026-09-13 使用者改名并扩权：「将『查字典』改名为『查词』。同时这个功能
   *   不要再只是单纯调用词典……不要再让『查字典』和其他查词能力成为彼此割裂的功能。」
   *   所以这里打开的**不再只是一本词典**，是那个统一面板：
   *   词典正文 · 音标与发音 · **Nyx 里有没有它** · 收下 ·（AI 那一档随后）。
   *   app 外面那两种触发方式（Glance 选中就查 / Frame 框选取词）
   *   打开的是**同一个面板** —— 它们是三个入口，不是三个功能。
   *
   * 以前这里写的是一句 toast：`【TLD】` + 原文前 160 字。他截图给我看过那一幕 ——
   * 同一件事说三遍、只有一本、看不全、换不了。现在交给 `DictCard`：
   * 贴着那个词、内部滚动、底下能换词典。
   *
   * **这里不查词、也不决定用哪本** —— 卡片自己去问主进程，
   * 而哪本是默认的只有 `Dicts.defaultBook()` 说了算。
   */
  /**
   * ★ 三个入口共用的那一步 —— 右键「查词」· Glance（选中就查）·（之后的 Frame）。
   *   抽出来是因为使用者 2026-09-13 明说「不要再让查词能力彼此割裂」：
   *   入口可以有三个，**打开的必须是同一张卡、记同一笔账**。
   */
  function openLookup(text: string, at: { x: number; y: number }): void {
    dict = { word: text, at }
    menu = null
    /**
     * ★ T-4.14 · 记一行「他查了这个词」。顺序是**先开卡再记账** ——
     *   查词是本体，记账是附加价值，账本慢一拍不许拖住他眼前那张卡。
     */
    window.nyx.ledger
      .lookup(text, 'dict')
      .then((id) => (lastLookup = id ? { id, term: text } : null))
      .catch(() => {
        /* 账本失败不出声：他要的是那张卡，不是一条「记账没成」的提示 */
        lastLookup = null
      })
  }

  /**
   * ══ Glance · 选中就查（使用者 2026-09-13）════════════════════
   * 主进程那边的助手进程盯着「当前选中了什么」，过完 `core/glance.ts`
   * 那几道闸之后把字送过来。**这里不再判断**，只负责开卡。
   * ★ 卡开在**鼠标最后待的地方** —— 他刚用鼠标选完，那就是他眼睛在的地方。
   * ★ 助手进程死了要说出来：以为开着其实早停了，比关着更糟。
   */
  let pointer = { x: 200, y: 200 }
  $effect(() => {
    const offHit = window.nyx.glance.onHit((text) =>
      openLookup(text, {
        x: Math.min(pointer.x, window.innerWidth - 240),
        y: Math.min(pointer.y, window.innerHeight - 220)
      })
    )
    const offDead = window.nyx.glance.onDead((why) => {
      /**
       * ★ 这一条**不跟任何控件绑**（他可能正在任何一页），而且是一条失败：
       *   走 `sayBad` —— 它**不自动消失**。「以为开着其实早停了」比关着更糟，
       *   这句话不许「没看见就没了」。
       */
      sayBad('「选中就查」停了：' + why + '　去 Settings → Assist 再开一次。')
    })
    return () => {
      offHit()
      offDead()
    }
  })

  /** 右键「查词」—— 三个入口之一，走的是同一个 `openLookup` */
  function lookUp(): void {
    if (!menu) return
    // 卡片挂在右键那个点上（就是他点的那个词），不是屏幕中央
    openLookup(menu.text, { x: menu.x, y: menu.y })
  }

  /**
   * ★ D-440 · P-6（2026-09-02 · WINDOWS_INVENTORY.md §5.6）
   *
   * 「选位置」弹窗（`picking`）以前只能点遮罩关，没有 Esc。补上，同 ItemDetail/
   * Practice 那两处题型面板一样的写法——**注册是一次性的，消不消费看内部状态**。
   *
   * ★ 右键菜单（`menu`）**不进这个栈**，这是刻意的：esc-stack.svelte.ts 文件头
   * 已经写明它和 PathPicker 的新建输入框、Workbench 的改名框是一类——「元素级」
   * 取消，不是「关掉一层浮层」。悬浮词典卡（`DictCard`）也不用在这里另接一次，
   * 它自己就注册了（见 `DictCard.svelte` 第 161 行），谁渲染它都一样。
   */
  $effect(() =>
    registerEsc(() => {
      if (!picking) return false
      picking = false
      return true
    })
  )
</script>

<svelte:window
  oncontextmenu={onContext}
  onclick={() => (menu = null)}
  onmousemove={(e) => (pointer = { x: e.clientX, y: e.clientY })}
/>

{#if dict}
  <!-- ★ 同一张卡片：`word` 一换就重查，组件实例不重建（他连着查几个词是常事） -->
  <DictCard
    word={dict.word}
    at={dict.at}
    lectureId={currentLecture ?? fallbackLecture}
    onclose={() => (dict = null)}
  />
{/if}

{#if menu}
  <!-- D-200 · 通用浮动菜单：一个组件，不是每处写一遍 -->
  <div
    class="pm on"
    style="left:{menu.x}px;top:{menu.y}px"
    role="menu"
    tabindex="-1"
    data-testid="ctx-menu"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.key === 'Escape' && (menu = null)}
  >
    <div class="cp" data-testid="ctx-sel">「{menu.text.slice(0, 40)}{menu.text.length > 40 ? '…' : ''}」</div>

    {#if menu.kind === 'passage'}
      {#if layer}
        <!-- 第一步已选层 · 现在决定去处 -->
        <div class="cp">收成{layer === 'B' ? '写作层' : '理解层'} —— 放哪儿？</div>
        {#if currentLecture}
          <button class="mi" data-testid="ctx-here" onclick={() => addTo(currentLecture)}
            >收进本 Lecture</button
          >
        {/if}
        <button
          class="mi"
          data-testid="ctx-elsewhere"
          onclick={() => {
            picking = true
            menu = { ...menu!, x: menu!.x, y: menu!.y }
          }}>收进…（选位置）</button
        >
        <div class="sep" style="margin:4px 6px"></div>
        <button class="mi" data-testid="ctx-back" onclick={() => (layer = null)}><Ic n="back" s={16} /> 重选层</button>
      {:else}
        <!-- I-062 第一步 · 先定性质：我要不要练到能写出来 -->
        <button class="mi" data-testid="ctx-layer-b" onclick={() => (layer = 'B')}
          >收成<b>写作层</b> · 要练到能写出来</button
        >
        <button class="mi" data-testid="ctx-layer-a" onclick={() => (layer = 'A')}
          >收成<b>理解层</b> · 只求看懂</button
        >
        <div class="sep" style="margin:4px 6px"></div>
        <button class="mi" data-testid="ctx-speak" onclick={readAloud}>朗读</button>
        <button class="mi" data-testid="ctx-dict" onclick={lookUp}>查词</button>
        <button class="mi" data-testid="ctx-copy" onclick={copy}>复制</button>
      {/if}
    {:else if menu.kind === 'doc'}
      <!--
        ★ 4.2 · 文件学习：收进去只剩一颗 **Save**（使用者 2026-09-13）。
          层固定「理解层」，去处固定「本篇设的那一讲」—— 两个问题都不再问他。
        ★ 还没设路径时不画这颗按钮，而是说清为什么 —— 一颗按下去没反应的
          Save 比没有它更糟（D-456：能点的和不能点的必须一眼分得出）。
      -->
      {#if currentLecture}
        <button class="mi" data-testid="ctx-save" onclick={() => addTo(currentLecture, 'A')}
          ><b>Save</b></button
        >
      {:else}
        <div class="cp">这篇还没设路径 —— 先在左上角「选个位置…」，才知道收到哪儿</div>
      {/if}
      <div class="sep" style="margin:4px 6px"></div>
      <button class="mi" data-testid="ctx-speak" onclick={readAloud}>朗读</button>
      <button class="mi" data-testid="ctx-dict" onclick={lookUp}>查词</button>
      <button class="mi" data-testid="ctx-copy" onclick={copy}>复制</button>
    {:else if menu.kind === 'item'}
      <!-- 已入库的条目不出现「加入」—— 它已经在库里了（D-039 的原意） -->
      <button class="mi" data-testid="ctx-speak" onclick={readAloud}>朗读</button>
      <button class="mi" data-testid="ctx-dict" onclick={lookUp}>查词</button>
      <button class="mi" data-testid="ctx-copy" onclick={copy}>复制</button>
      <div class="cp">这条已经在库里了 · 管理动作在行尾的 ⋮</div>
    {:else}
      <button class="mi" data-testid="ctx-copy" onclick={copy}>复制</button>
    {/if}
  </div>
{/if}

<!-- I-093 / I-020 · 选位置的弹窗：三段并排，横线能直接新建。
     使用者：「可以项目下拉箭头 单元下拉箭头 Lecture 下拉箭头，
     选择的文件可以显示在横线上面或者哪里，然后可以点击重新选择。」
     所以选完**不立刻入库**，先把选中的路径显示出来，确认了才收。 -->
{#if picking && menu}
  {@const m = menu}
  {@const chosen = picked ? lectures.find((l) => l.id === picked) : null}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="ov on" data-testid="ctx-path-dialog" onclick={() => (picking = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="mbox" onclick={(e) => e.stopPropagation()}>
      <h3>收进哪个 Lecture</h3>
      <div class="ms">
        收成<b>{layer === 'B' ? '写作层' : '理解层'}</b>：「{m.text.slice(0, 40)}{m.text.length > 40
          ? '…'
          : ''}」
      </div>

      <PathPicker {tree} value={picked} label="" onpick={(id) => (picked = id)} />

      {#if chosen}
        <div class="notice ok" style="margin-top:12px" data-testid="ctx-path-chosen">
          收进 <b>{chosen.path} › {chosen.name}</b>
          <button
            class="btn sm"
            style="margin-left:8px"
            data-testid="ctx-path-reset"
            onclick={() => (picked = null)}>重新选择</button
          >
        </div>
      {/if}

      {#if error}
        <div class="errbox" data-testid="ctx-path-error" style="margin-top:10px"><div>{error}</div></div>
      {/if}

      <div class="mact">
        <button class="btn" data-testid="ctx-path-cancel" onclick={() => (picking = false)}>取消</button>
        <button
          class="btn pri"
          disabled={!picked}
          data-testid="ctx-path-go"
          onclick={() => {
            const id = picked
            if (id) {
              picking = false
              picked = null
              addTo(id)
            }
          }}>收进来</button
        >
      </div>
    </div>
  </div>
{/if}
