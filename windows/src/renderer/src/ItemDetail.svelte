<script lang="ts">
  import Skel from './Skel.svelte'
  import type { Failure, ItemDetail } from '@shared/api.ts'
  import { SILENCE_ACTIONS, SILENCE_FILTER_NAME, isRowSilent } from '@core/silence.ts'
  import { cleanMessage, parseFailure } from '@shared/api.ts'
  import { speak } from './speak.ts'
  import Ic from './Ic.svelte'
  import { registerEsc } from './esc-stack.svelte.ts'
  import { staleAfterEdit, type CorrectionEntry } from '@core/analysis/stale.ts'
  import { say, sayBad } from './toast.svelte.ts'

  /**
   * ★ D-468（2026-09-07）· 这一页这次少了四样东西，都是使用者点名取消的：
   * 词典块（词典只从悬浮卡与 Lookup 页进）· 每一块旁边的「改」· 右栏的二维定位图 ·
   * 右栏的历次作答。删的是画面与取数，**库里的行一个字没动**：
   * `analysis_blocks.edited` 那一列留着不读，`review_logs` 是同步表更是一行不碰。
   */

  /** I-060 · 中文释义默认收起 —— 先让眼睛落在英文上 */
  let showZh = $state(false)

  /** I-060 · 朗读旁边直接换层，不用回列表 */
  async function moveLayer(to: 'A' | 'B'): Promise<void> {
    actErr = null
    try {
      await window.nyx.study.setLayer(itemId, to)
      // 改完重新读一次真值 —— 界面上显示的层就是库里的层，不做乐观更新
      view = { k: 'ok', d: await window.nyx.study.itemDetail(itemId) }
      say(`移到${to === 'B' ? '写作层' : '理解层'}了。`)
    } catch (err) {
      // 没改成就是没改成：不动界面上的层，说清楚为什么
      actErr = `没能换层：${cleanMessage(err)}`
    }
  }

  /**
   * I-045 · 拆出来的单位一键进当前 lecture 的主动 / 被动。
   * 带上**这条的原文出处**（M-012）—— 它就是在那句话里出现的，
   * 出处现成的，不带才奇怪。
   */
  /**
   * ══ 回执改走全局那一条（使用者 2026-09-14 第五条）══════════════
   * 他的原话：「操作已经完成 → 告诉用户结果，不需要用户做任何决定……
   * 应该改成：操作完成 → 显示短暂 Toast / 非阻塞提示 → 自动消失。」
   * 这几条都是**一次性的结果、不跟任何控件绑着**，正是判据里走回执条的那一格。
   * ★ 文案一个字没改；失败仍走 `sayBad`（**不自动消失**）。
   */
  /**
   * ★ H-4b · 失败单独一个位，不和 `promoted` 混。
   *
   * `promoted` 渲染成 `.notice ok`（绿的、成功的样子），以前失败也往它里塞 ——
   * 于是「没做成」和「做成了」长得一模一样。这里分开：成功走 promoted，
   * 失败走 actErr，渲染成 `.errbox`。同一个组件里只有这两个位，不新增第三套。
   */
  let actErr = $state<string | null>(null)
  async function promote(text: string, layer: 'A' | 'B'): Promise<void> {
    if (view.k !== 'ok') return
    const lec = view.d.item.lectureId
    if (!lec) {
      sayBad('这条还没归到某一讲，先把它放进一讲里再收。')
      return
    }
    try {
      const r = await window.nyx.data.addItem(
        lec,
        text,
        '',
        layer,
        view.d.occurrences[0]?.quote ?? ''
      )
      say(
        `「${text}」收进${layer === 'B' ? '写作层' : '理解层'}了。` +
          (r.duplicateOf ? '　这条以前收过 —— 说明上一次「学会」可能是假的（D-026）。' : '')
      )
    } catch (err) {
      sayBad(cleanMessage(err))
    }
  }

  /**
   * I-046 · 接受 / 忽略修正建议。
   * 「就按这个改」是原句**唯一**会被改动的入口，而且必须他亲手点 ——
   * D-006 保护的是「这是我当时真正记下来的东西」。
   */
  async function acceptSuspect(i: number): Promise<void> {
    try {
      await window.nyx.study.acceptSuspect(itemId, i)
      view = { k: 'ok', d: await window.nyx.study.itemDetail(itemId) }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  async function dismissSuspects(): Promise<void> {
    actErr = null
    try {
      await window.nyx.study.dismissSuspects(itemId)
      view = { k: 'ok', d: await window.nyx.study.itemDetail(itemId) }
    } catch (err) {
      actErr = `没能忽略这条建议：${cleanMessage(err)}`
    }
  }

  /** 朗读退回系统语音时会带一句原因，显示出来 —— 不静默降级（D-262）。 */
  let spoken = $state('')
  async function speakNote(text: string): Promise<void> {
    spoken = await speak(text)
  }

  let {
    itemId,
    onback,
    ongotoSettings,
    onreading,
    onpractice
  }: {
    itemId: number
    onback: () => void
    ongotoSettings?: () => void
    /**
     * ★ T-9.14 ⑥（使用者 2026-09-08「加一下吧」）· 就练这一条。
     *   浮层归外壳管（同 Library / HardZone 那两处），这里只把 id 交出去 ——
     *   判据（按 ids 练**只动卡、不动 Lecture 间隔**）在 core，一份。
     */
    onreading?: (ids: number[]) => void
    onpractice?: (ids: number[]) => void
  } = $props()

  type View = { k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; d: ItemDetail }

  let view = $state<View>({ k: 'loading' })
  let gen = $state<{ busy: boolean; failure: Failure | null; message: string } | null>(null)
  let showAllQuotes = $state(false)
  /** I-114 · 出处和词条一模一样 = 这条其实没有原文出处，界面上要说明白 */
  const sameAsTerm = (q: string): boolean => {
    const flat = (x: string): string => (x ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
    return view.k === 'ok' && flat(q) === flat(view.d.item.term)
  }
  /**
   * ★ D-468 · 正文**只有一层**，顺序按「先看懂 → 再会用」：
   *   这一句里（合并块）→ 动词吃什么结构 · 句型 · 这一句里值得单独学的单位
   *   → 语用功能 · 语域之间怎么变 · 改写练习
   * 原来那两个小标题和「写得出第 4 档要靠这一段」那句说明都不再出现（I-045 就此修订）。
   */
  const BODY_FIRST = [['inSentence', 'Sense']] as const

  /**
   * ★ 合并之前写下的老行 —— **画进同一个区域，一个字不丢**。
   *
   * 新解析只产 `inSentence` 一块；而他库里已经有的那些条目，写下的是分开的两块。
   * 不画它们的话，一条 2026-09-07 之前解析过的知识点，点开会发现正文第一段空了 ——
   * 而库里明明有内容、什么也不会报错。所以老行照旧画，排在合并块后面、
   * 标题上带同一个名字，让人看得出它们讲的是同一件事。
   */
  const BODY_LEGACY = [
    ['meaning', 'Sense · 它在这句里做什么'],
    ['barriers', 'Sense · 会绊住你的地方']
  ] as const

  const BODY_MID = [
    ['verbs', '动词吃什么结构'],
    ['pattern', '句型']
  ] as const

  const BODY_LAST = [
    ['pragmatics', '语用功能'],
    ['variation', '语域之间怎么变']
  ] as const

  /** 区块的显示顺序与标题 · D-141 砍到两大块，一页到底、小标题分区 */
  const CLOSE_READING = [
    ['type', 'Type of expression'],
    ['sense', 'Literal vs extended'],
    ['structure', 'Structure'],
    ['background', 'Background'],
    ['family', 'Word family'],
    ['collocations', 'Collocations'],
    ['slots', 'Slots']
  ] as const
  const REGISTER = [
    ['register', 'Register'],
    ['nuance', 'Register & Nuance']
  ] as const

  async function load(): Promise<void> {
    view = { k: 'loading' }
    try {
      const d = await window.nyx.study.itemDetail(itemId)
      view = { k: 'ok', d }
      /**
       * ★ I-110 · **打开详情页不再自动生成解析。**
       *
       * 使用者：「整体分析完成后，知识点列表会出现并已分好主动/被动，
       *          但详情页仍为空…用户必须主动触发对应类别的详细分析，才会填充详情。」
       *
       * 以前这里是「打开就顺手生成」（R-002 那条「打开就有内容」）。
       * 那条在**分析和详解还是一件事**的时候成立；现在两者拆开了（I-104），
       * 它就变成了一个绕过分流的后门：随手翻几条详情 = 悄悄花掉几次调用，
       * 而且和「按类别单独跑」的进度对不上（那边数「还剩几条」，这边偷偷做掉了）。
       *
       * 现在：没解析就显示空态 + 一个按钮，由他决定要不要花这一次。
       */
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  $effect(() => {
    void itemId
    load()
  })

  async function generate(force: boolean): Promise<void> {
    gen = { busy: true, failure: null, message: '' }
    try {
      await window.nyx.study.ensureAnalysis(itemId, force)
      gen = null
      view = { k: 'ok', d: await window.nyx.study.itemDetail(itemId) }
    } catch (err) {
      gen = { busy: false, failure: parseFailure(err), message: cleanMessage(err) }
    }
  }

  function blockOf(d: ItemDetail, name: string): ItemDetail['blocks'][number] | null {
    return d.blocks.find((b) => b.block === name) ?? null
  }

  /** 区块内容可能是字符串，也可能是 JSON 数组/对象 —— 存的时候没有拆开。 */
  function parse<T>(raw: string): T | null {
    if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  /**
   * ★★ T-9.14 · 改这条知识点的正文（term / gloss / gloss_zh）· D-478 ③
   *
   * 判据全在 `@core/analysis/edit.ts`（两端一份）：改哪几列 · 留痕 · 拒绝的两种。
   * 这里只做界面该做的三件事：把当前值填进去 · 保存 · 把失败**说出来**。
   *
   * ★ 解析块一个字不动（D-468 取消了「改」）—— 这里改的是词条正文。
   *   改完解析算不算过时，由下面那个 `stale` 在页顶说一句，不自动删也不自动重跑。
   */
  let editing = $state<{ term: string; gloss: string; glossZh: string } | null>(null)
  let editErr = $state<string | null>(null)
  let saving = $state(false)

  function openEdit(d: ItemDetail): void {
    editErr = null
    editing = { term: d.item.term, gloss: d.item.gloss, glossZh: d.item.glossZh }
  }

  async function saveEdit(): Promise<void> {
    if (!editing || saving) return
    saving = true
    editErr = null
    try {
      await window.nyx.study.editItem(itemId, {
        term: editing.term,
        gloss: editing.gloss,
        glossZh: editing.glossZh
      })
      editing = null
      await load()
      say('改好了。')
    } catch (err) {
      // ★ 拒绝的两种（词条空了 / 一个字没改）也走这里 —— 它们本来就是给他看的那句话
      editErr = cleanMessage(err)
    } finally {
      saving = false
    }
  }

  /**
   * ★★ 「这份解析是照着改之前的词条写的」· `core/analysis/stale.ts`（两端同一份判据）
   *
   * 判据：`corrections` 里最近一笔**算得上改了词**的时间，晚于**所有**解析块的
   * `updated_at`。只说一句，不自动删、不自动重跑 —— 解析很贵，而他可能只改了个大小写
   * （只改大小写 / 尾标点根本不算「改了词」，那也正是 `countsAsTermChange` 判的）。
   */
  const staleOf = (d: ItemDetail): boolean => {
    const raw = d.blocks.find((b) => b.block === 'corrections')?.content
    const log = raw ? (parse<CorrectionEntry[]>(raw) ?? []) : []
    return staleAfterEdit(log, d.blocks.map((b) => ({ block: b.block, updatedAt: b.updatedAt })))
  }

  /**
   * ★ H-4b · 静默 / 放回来。
   * 两颗按钮原来写成模板里的内联 async 箭头 —— 失败时既没提示，
   * 也不会重读，界面停在旧状态上，他会以为点了没用（其实是点了没成）。
   */
  async function restoreItem(): Promise<void> {
    actErr = null
    try {
      await window.nyx.study.restoreItem(itemId)
      await load()
    } catch (err) {
      actErr = `没能${SILENCE_ACTIONS.restore}：${cleanMessage(err)}`
    }
  }

  async function silenceItem(): Promise<void> {
    actErr = null
    try {
      await window.nyx.study.silenceItem(itemId)
      await load()
    } catch (err) {
      actErr = `没能${SILENCE_ACTIONS.shelve}这一条：${cleanMessage(err)}`
    }
  }

  /**
   * ★★ T-4.22 · 手动静默从右栏搬进标题旁的 ⋮（D-377：次级操作进次级菜单）。
   *
   * ── 为什么不跟着右栏一起删 ────────────────────────────────
   *
   * 右边那一整栏是使用者点名取消的（D-468 附记 / T-4.22），栏里的东西
   * **除了这一件都是展示**：层 / 状态 / 间隔、攻坚诊断、攻坚记录 —— 删掉只是少看几行。
   * 而手动静默是**功能**（D-022），而且静默 ≠ 遗忘（D-030）：它是他把一条
   * 「暂时不想练」的东西按下去的唯一入口。跟着栏一起删掉，就是把一个功能
   * 混在版面收窄里悄悄拿走了 —— 这是主控提的处置（D-413），他看了截图要改再改。
   *
   * ★ 菜单用的是全仓现成那一套（`.pm` + `.mi` + 遮罩 + Esc），不新发明第二套。
   */
  let menu = $state<{ x: number; y: number } | null>(null)

  function openMenu(e: MouseEvent): void {
    if (menu) {
      menu = null
      return
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const top = r.bottom + 4
    menu = {
      x: Math.min(r.left, window.innerWidth - 250),
      // 贴近窗口底部时往上翻，免得被切掉（和讲次页那一份同一条）
      y: top + 120 > window.innerHeight ? Math.max(8, top - 120) : top
    }
  }

  /**
   * Esc 的顺序（D-440：一次只退一层）：菜单在最上面，先关它；再关修改对话框。
   * ★ T-9.14 · 对话框必须进这个栈 —— D-440 那一轮真机扫描抓到的正是
   *   「详情页的弹窗按不掉 Esc」（那时是每块旁边的『改』，D-468 已删）。
   *   新开一个弹窗就要接进来，不然同一个病换个门又回来了。
   */
  $effect(() =>
    registerEsc(() => {
      if (menu) {
        menu = null
        return true
      }
      if (editing) {
        editing = null
        return true
      }
      return false
    })
  )

</script>

{#if view.k === 'error'}
  <div class="errbox" data-testid="detail-error">
    <div class="h">这条打不开</div>
    <div style="white-space:pre-wrap">{view.message}</div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn sm" onclick={load}>重试</button>
      <button class="btn sm" onclick={onback}>返回</button>
    </div>
  </div>
{:else if view.k === 'loading'}
  <!-- ★ B1 · 词条详情：词 → 释义 → 原文摘句 → 出处，骨架占的就是这四段 -->
  <div class="card blk" data-testid="detail-loading">
    <Skel rows={4} widths={['w45', 'w70', 'w100', 'w55']} testid="detail-skel" />
  </div>
{:else}
  {@const d = view.d}

  <!-- D-451 · 返回入口收归 App 统一出（它要说出「返回到哪」，那条信息只有外壳知道） -->

  <div class="cols">
    <!-- ══ 左栏 · 这个表达是什么（D-143）══ -->
    <div class="L">
      <div class="term" data-testid="detail-term">{d.item.term}</div>

      <!-- R-002 ★ 释义要立得住：独立位置、独立分量，不是标题的附属 -->
      <!-- ★ D-484 · 清单 13 的目标：释义那一块（「词和释义随时可以自己改」说的就是它）-->
      <div class="glossbox" data-testid="detail-gloss" data-guide="item-analysis">
        <div class="en">{d.item.gloss || '（还没有释义）'}</div>
        {#if d.item.glossZh}
          <!-- I-060 · 中文默认收起。先让眼睛落在英文上 —— 中文一摆出来，
               人会直接读中文，英文那一行就白写了 -->
          {#if showZh}
            <div class="zh" data-testid="gloss-zh">{d.item.glossZh}</div>
          {/if}
          <button
            class="btn sm"
            style="margin-top:6px"
            data-testid="gloss-zh-toggle"
            onclick={() => (showZh = !showZh)}>{showZh ? '收起中文' : '中文'}{#if !showZh}<Ic n="caret" s={12} r="dn" />{/if}</button
          >
        {/if}
      </div>

      <!--
        ★ D-5（2026-09-03 UI 审计）· 这一排原来把三类东西并排放着：
          状态（主动词汇 / chunk）· 来源（出自 L2）· 动作（朗读 / 移层）
        前两类只读、第三类能点，但**都带边框**，读成同一个家族。
        系统规则改成「有边框＝能点，无边框＝只是标签」（见 enhancements.css），
        这里再加一道竖分隔：**它们是两组，不是一串**。
      -->
      <div class="meta-row">
        <!-- ★ 两条线两个颜色：紫＝产出线 · 青＝认读线 -->
        <span class="tg {d.item.layer === 'B' ? 'a' : 'line-p'}"
          >{d.item.layer === 'B' ? '写作层' : '理解层'}</span
        >
        <span class="tg">{d.item.kind}</span>
        {#if d.item.lectureName}<span class="tg">出自 {d.item.lectureName}</span>{/if}
        {#if d.item.source === 'self'}<span class="tg">我收集的</span>{/if}
        {#if d.item.recollected > 0}<span class="tg">重复收集 ×{d.item.recollected}</span>{/if}
        <span class="gapper"></span>
        <!-- D-040 / D-094 · 详情页有朗读，列表行里没有 -->
        <button
          class="btn sm"
          data-testid="detail-speak"
          title="读一遍（口音和语速在设置 · 朗读里调）"
          onclick={() => speakNote(d.item.term)}><Ic n="speak" s={16} /> 朗读</button
        >
        <!-- I-060 ·「每个词条，在朗读旁边，可以有移动到主动词汇，或者移动到被动词汇」 -->
        <button
          class="btn sm"
          data-testid="move-layer"
          title={d.item.layer === 'B' ? '改成只求看懂，不出产出题' : '改成要练到能写出来'}
          onclick={() => moveLayer(d.item.layer === 'B' ? 'A' : 'B')}
          >→ 移到{d.item.layer === 'B' ? '理解层' : '写作层'}</button
        >
        <!-- ★ T-4.22 · 次级操作进 ⋮（D-377）。右栏取消后，手动静默搬到这里 -->
        <button
          class="btn sm"
          data-testid="detail-menu"
          aria-label="更多"
          title="更多"
          onclick={openMenu}><Ic n="more" s={18} /></button
        >
      </div>
      {#if spoken}
        <div class="s3" data-testid="speak-note" style="margin:-12px 0 14px">{spoken}</div>
      {/if}

      <!--
        ★★ T-9.14 · 「这份解析是照着改之前的词条写的」（判据在 core，两端同一句话）
          只说一句：不自动删解析、不自动重跑 —— 解析很贵，而他可能只是改了个大小写
          （只改大小写 / 尾标点根本不算「改了词」，`countsAsTermChange` 判的就是这个）。
      -->
      {#if staleOf(d)}
        <div class="notice warn" data-testid="stale-note" style="margin-bottom:14px">
          <b>这份解析是照着改之前那条知识点写的。</b>
          知识点改过之后解析没有重写 —— 下面这些内容讲的可能还是改之前那个说法。
          <span class="dim">要更新的话，点最下面的「重新生成解析」。</span>
        </div>
      {/if}

      <!-- 原文摘句 · M-012 不可丢失；D-152 多处保留、默认只显示首次 -->
      <div class="sec"><span class="en">原文摘句</span></div>
      {#if d.occurrences.length === 0}
        <div class="dim" style="font-size:var(--fs-2)">没有记录到原文出处。</div>
      {:else}
        {#each showAllQuotes ? d.occurrences : d.occurrences.slice(0, 1) as o, i (i)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="qb"
            data-testid="detail-quote"
            title="点一下读这句"
            onclick={() => speakNote(o.quote)}>
            "{o.quote}"
          </div>
          <div class="qs">
            <!--
              I-114 · 出处和词条一模一样时，如实说出来。
              这种「出处」是他收进来那一刻原文还没到、只能记下他打的那行留下的。
              原文一到会自动补回（repo.backfillQuotes），补不回的说明原文里确实没有这句 ——
              那就直说，别让它冒充原文出处：认读卡照着它挖空是挖不出来的。
            -->
            <span
              >{o.material ?? '—'}{o.para ? ` · 第 ${o.para} 段` : ''}{o.lecture
                ? ` · ${o.lecture}`
                : ''}{sameAsTerm(o.quote) ? ' · 原文里没找到这句，这是你收进来时记下的' : ''}</span>
          </div>
        {/each}
        {#if d.occurrences.length > 1}
          <div
            class="fold"
            role="button"
            tabindex="0"
            data-testid="more-quotes"
            onclick={() => (showAllQuotes = !showAllQuotes)}
            onkeydown={(e) => e.key === 'Enter' && (showAllQuotes = !showAllQuotes)}
          >
            {showAllQuotes ? '收起' : `另有 ${d.occurrences.length - 1} 处出现`}{#if !showAllQuotes}<Ic n="caret" s={12} r="dn" />{/if}
          </div>
        {/if}
      {/if}

      <!-- 解析生成的状态：失败要看得见，且给下一步 -->
      {#if gen?.busy}
        <div class="notice" data-testid="gen-busy">正在写解析…</div>
      {:else if gen}
        <div class="errbox" data-testid="gen-error">
          <div class="h">{gen.failure?.title ?? '解析没生成出来'}</div>
          <div style="white-space:pre-wrap">{gen.failure?.detail ?? gen.message}</div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn sm" onclick={() => generate(false)}>重试</button>
            <button class="btn sm" onclick={() => ongotoSettings?.()}>去设置</button>
          </div>
        </div>
      {/if}

      <!-- I-046 · 疑似打错的地方。**原句一个字都没动**，改不改你说了算 -->
      {#if blockOf(d, 'suspect')}
        {@const sus = parse<{ was: string; should: string; why?: string }[]>(
          blockOf(d, 'suspect')!.content
        )}
        {#if Array.isArray(sus) && sus.length > 0}
          <div class="notice warn" data-testid="suspect-box" style="margin-bottom:14px">
            <b>这句里有 {sus.length} 处看着像是打错或听岔了。</b>
            <span class="dim">原句一个字都没动 —— 你确认了才改。</span>
            {#each sus as x, i (i)}
              <div class="warn" style="margin-top:8px" data-testid="suspect-row">
                <div>
                  <span style="text-decoration:line-through;opacity:.6">{x.was}</span>
                  　→　<b>{x.should}</b>
                </div>
                {#if x.why}<div class="s3">{x.why}</div>{/if}
                <div style="margin-top:6px">
                  <button class="btn sm pri" data-testid="suspect-accept-{i}" onclick={() => acceptSuspect(i)}
                    >就按这个改</button
                  >
                </div>
              </div>
            {/each}
            <div style="margin-top:8px">
              <button class="btn sm" data-testid="suspect-dismiss" onclick={dismissSuspects}
                >都不用改</button
              >
            </div>
          </div>
        {/if}
      {/if}

      <!--
        ★ I-110 · 还没做详细分析时的空态。
        「整体分析」只负责把知识点捞出来并分到三类；详细解析要他自己触发（I-104）。
        所以这里不是「加载中」，也不是「出错了」—— 是**还没做**，说清楚并给入口。
      -->
      {#if !d.blocks.some((b) => b.block !== 'summary') && !gen?.busy}
        <!-- ★ D-3 · 它是**占位**不是通知 —— 虚线不填色，别比真内容还抢眼 -->
        <div class="notice placeholder" data-testid="not-analysed" style="margin:16px 0">
          <b>这一条还没做详细分析。</b>
          整体分析只把它捞出来并判了层；释义、原文摘录、例句、搭配
          要单独跑一次才会有。
          <div class="s3 dim" style="margin-top:6px">
            批量做更省事：回到这个 Lecture 点「分析」，选<b>我的收集 / 写作层 / 理解层</b>，
            整类一次跑完，已经做过的会自动跳过。
          </div>
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn sm pri" data-testid="analyse-one" onclick={() => generate(false)}
              >只分析这一条</button
            >
          </div>
        </div>
      {/if}
      {#if !d.blocks.some((b) => b.block !== 'summary') && gen?.busy}
        <div class="notice" data-testid="not-analysed-busy" style="margin:16px 0">
          <span class="spin"><i></i>正在写这一条的完整解析…</span>
        </div>
      {/if}

      <!--
        ══ 正文 · D-468 只有一层 ══════════════════════════════
        顺序：Sense（合并块，老行跟在后面）→ 动词 · 句型 → 值得单独学的单位
        → 语用功能 · 语域之间怎么变 → 改写练习。
        标题「How it works」由使用者定（2026-09-07，两端同一个名字）——
        原来分两层的那两个小标题与各自那句说明都不再出现（I-045 就此修订）。
      -->
      {#if [...BODY_FIRST, ...BODY_LEGACY, ...BODY_MID, ...BODY_LAST].some(([k]) => blockOf(d, k)) || blockOf(d, 'chunks') || blockOf(d, 'rewrites')}
        <div class="sec" data-testid="sec-body"><span class="en">How it works</span></div>
      {/if}
      {#each [...BODY_FIRST, ...BODY_LEGACY, ...BODY_MID] as [key, title] (key)}
        {@const b = blockOf(d, key)}
        {#if b}
          {@const list = parse<string[]>(b.content)}
          <div class="ib" style="margin-bottom:12px" data-testid="block-{key}">
            <div class="l">{title}</div>
            <div class="v">
              {#if Array.isArray(list)}
                {#each list as line, i (i)}<div style="margin-bottom:4px">· {line}</div>{/each}
              {:else}
                {b.content}
              {/if}
            </div>
          </div>
        {/if}
      {/each}

      <!-- I-045 · 拆出来的单位，点一下就能收进当前 lecture 的主动 / 被动 -->
      {#if blockOf(d, 'chunks')}
        {@const cs = parse<{ text: string; why?: string; example?: string }[]>(
          blockOf(d, 'chunks')!.content
        )}
        {#if Array.isArray(cs)}
          <div class="ib" style="margin-bottom:12px" data-testid="block-chunks">
            <div class="l">这一句里值得单独学的单位</div>
            <div class="v">
              {#each cs as c, i (i)}
                <div class="warn" style="margin-bottom:10px" data-testid="chunk-row">
                  <div><b>{c.text}</b></div>
                  {#if c.why}<div class="s3">{c.why}</div>{/if}
                  {#if c.example}<div class="s3" style="font-style:italic">{c.example}</div>{/if}
                  <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
                    <button
                      class="btn sm pri"
                      data-testid="promote-b-{i}"
                      onclick={() => promote(c.text, 'B')}>收进写作层</button
                    >
                    <button class="btn sm" data-testid="promote-a-{i}" onclick={() => promote(c.text, 'A')}
                      >收进理解层</button
                    >
                    <span class="s3 dim">进这个 Lecture，带上这句原文当出处</span>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
      {#if actErr}
        <div class="errbox" data-testid="item-act-error" style="margin-bottom:12px">
          <div class="h">没做成</div>
          <div style="white-space:pre-wrap">{actErr}</div>
        </div>
      {/if}

      <!-- 正文后半 · 会用它：语用功能 · 语域之间怎么变 -->
      {#each BODY_LAST as [key, title] (key)}
        {@const b = blockOf(d, key)}
        {#if b}
          <div class="ib" style="margin-bottom:12px" data-testid="block-{key}">
            <div class="l">{title}</div>
            <div class="v">{b.content}</div>
          </div>
        {/if}
      {/each}

      <!-- 改写练习：同一句话在不同语域下的样子。这是「分寸」最直观的教法 -->
      {#if blockOf(d, 'rewrites')}
        {@const rw = parse<{ register: string; text: string }[]>(blockOf(d, 'rewrites')!.content)}
        {#if Array.isArray(rw)}
          <div class="ib" style="margin-bottom:12px" data-testid="block-rewrites">
            <div class="l">同一句话，换个语域</div>
            <div class="v">
              {#each rw as r, i (i)}
                <div class="ex" data-testid="rewrite-row">
                  <div class="s">{r.text}</div>
                  <span class="f">{r.register}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

      <!-- 例句 · D-150 三种来源在界面上明确标注 —— 样板的可信度必须写在脸上 -->
      {#if blockOf(d, 'examples')}
        {@const ex = parse<{ text: string; source: string; note?: string }[]>(
          blockOf(d, 'examples')!.content
        )}
        {#if Array.isArray(ex)}
          <div class="sec"><span class="en">Examples</span></div>
          {#each ex as e, i (i)}
            <div class="ex" data-testid="example">
              <div class="s">{e.text}</div>
              <!-- D-150 · 三种来源明确标注。词典排在最前，因为它是出版过的真句子 -->
              <span class="f {e.source === 'ai' ? 'ai' : 'real'}" data-testid="ex-source">
                {#if e.source === 'dict'}词典{e.note ? ' · ' + e.note : ''}
                {:else if e.source === 'corpus'}真实语料{e.note ? ' · ' + e.note : ''}
                {:else}AI 补充{/if}
              </span>
            </div>
          {/each}
        {/if}
      {/if}

      <!--
        ══ Register & Nuance · D-145 / M-037 分寸辨析是软件的义务 ══
        ★ D-468 · 它现在排在 Close Reading **之前**：分寸是判分第 4 档要用的东西，
          比 Close Reading 那几块常用得多，不该压在下面。标题仍用英文（D-363）。
      -->
      {#if REGISTER.some(([k]) => blockOf(d, k))}
        <div class="sec"><span class="en">Register &amp; Nuance</span></div>
        {#each REGISTER as [key, title] (key)}
          {@const b = blockOf(d, key)}
          {#if b}
            {@const nu = key === 'nuance' ? parse<{ term: string; note: string; self?: boolean }[]>(b.content) : null}
            {#if Array.isArray(nu)}
              <div class="nu" data-testid="block-nuance">
                {#each nu as n, i (i)}
                  <div class="nr">
                    <span class="w" class:me={n.self}>{n.term}</span>
                    <span class="d">{n.note}</span>
                  </div>
                {/each}
              </div>
              <div class="dim" style="font-size:var(--fs-1);margin-top:6px">
                这一块服务于判分第 4 档「分寸到位」—— 软件要求你达到，就有义务先教你分寸在哪。
              </div>
            {:else}
              <div class="ib" style="margin-bottom:12px" data-testid="block-{key}">
                <div class="l">{title}</div>
                <div class="v">{b.content}</div>
              </div>
            {/if}
          {/if}
        {/each}
      {/if}

      <!-- ══ Close Reading · D-141 / D-173 内容区标题用英文 ══ -->
      {#if CLOSE_READING.some(([k]) => blockOf(d, k))}
        <div class="sec"><span class="en">Close Reading</span></div>
        {#each CLOSE_READING as [key, title] (key)}
          {@const b = blockOf(d, key)}
          {#if b}
            {@const list = parse<unknown[]>(b.content)}
            <div class="ib" style="margin-bottom:12px" data-testid="block-{key}">
              <div class="l">{title}</div>
              <div class="v">
                {#if Array.isArray(list)}
                  <div class="chips">
                    {#each list as c, i (i)}
                      <span class="c">{typeof c === 'string' ? c : JSON.stringify(c)}</span>
                    {/each}
                  </div>
                {:else}
                  {b.content}
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      {/if}

      <!-- 专有名词 · M-011 只做理解，不进产出训练 -->
      {#if blockOf(d, 'proper')}
        <div class="sec"><span class="en">专有名词</span></div>
        <div class="ib" style="margin-bottom:12px" data-testid="block-proper">
          <div class="v">{blockOf(d, 'proper')!.content}</div>
          <div class="s3" style="margin-top:6px">
            专有名词<b>只做理解</b>，不进产出训练 —— 所以这条没有改写。
          </div>
        </div>
      {/if}

      <!-- D-148 · 整句拆解：我收集的原句唯一能提供的独特价值 -->
      {#if d.derived.length > 0}
        <div class="sec"><span class="en">整句拆解</span></div>
        {#each d.derived as x (x.id)}
          <div class="lrow" data-testid="derived-{x.id}">
            <span></span><span class="ck"><Ic n="check" s={10} /></span>
            <span class="lt">{x.term}</span>
            <span class="lg"
              >{x.productionState === 'silent' ? SILENCE_FILTER_NAME : `连续 ${x.streak}`}</span
            >
            <span class="ln {x.layer === 'B' ? 'a' : 'p'}">{x.layer === 'B' ? '写作层' : '理解层'}</span>
            <span class="dt3"></span>
          </div>
        {/each}
      {/if}

      <!--
        ★ I-109 · 反馈必须出现在**手指落下的地方**。
        使用者：「点击重新生成解析后没有任何反应」。它其实一直有反应 ——
        「正在写解析…」和错误框渲染在这一页的**最上面**，而按钮在最下面。
        点完之后指示器出现在屏幕外，看起来就是死的。
        现在按钮自己进入忙态，旁边就是转圈 + 文字，错误也就近显示。
      -->
      <!--
        ★ D-4（2026-09-03 UI 审计）· 「重新生成解析」原来**无条件显示**，
          于是一条还没分析过的词条上会同时出现两颗按钮：
          框里的「只分析这一条」和底下的「重新生成解析」——
          而「重新**生成**」在什么都还没生成过的时候是没有意义的。

          两颗按钮按状态二选一：没解析过 → 只有「只分析这一条」；
          解析过了 → 只有「重新生成解析」。**同一时刻只提供一个动作。**
      -->
      {#if d.blocks.some((b) => b.block !== 'summary')}
      <div style="margin-top:22px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button
          class="btn sm"
          data-testid="regen"
          disabled={gen?.busy}
          onclick={() => generate(true)}>{gen?.busy ? '正在生成…' : '重新生成解析'}</button
        >
        {#if !gen?.busy && d.blocks.some((b) => b.regenCount >= 2)}
          <!--
            D-190 · 不设硬限制，第 3 次起提示。
            ★ D-468（2026-09-07）· 这句原来写的是「考虑直接手动改」—— 而「改」已经取消了，
              它指向的是一条不存在的路（D-471：功能变了名字与说法不许留着）。
              改成现在真正做得到的那一步：换模型。
          -->
          <span class="dim" style="font-size:var(--fs-2);align-self:center"
            >已重新生成过几次了 —— 再点一次多半还是这个样子，去设置换「重任务」那一组模型试试</span
          >
        {/if}
      </div>
      {/if}

      <!--
        3.2 · 加载反馈做成一整条，不是按钮边上一个小圈。
        使用者：「必须有明显的加载反馈…优先选择设计更大胆美观的方案。」
        不画百分比 —— 一次调用出全部区块，中间没有真实进度，
        编一个假的百分比是骗人。流动带说的是「在跑」，不假装知道还剩多久。
      -->
      {#if gen?.busy}
        <div class="regenbar" data-testid="regen-busy" aria-live="polite" role="status">
          <div class="rb-t">正在重写这一条的完整解析<em>通常十几秒</em></div>
          <div class="rb-s">旧的解析还在下面，写好了才替换 —— 中途关闭页面不会丢失。</div>
          <div class="rb-track"><i></i></div>
        </div>
      {/if}
      {#if gen && !gen.busy}
        <div class="errbox" data-testid="regen-error" style="margin-top:10px">
          <div class="h">{gen.failure?.title ?? '解析没生成出来'}</div>
          <div style="white-space:pre-wrap">{gen.failure?.detail ?? gen.message}</div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn sm" onclick={() => generate(true)}>重试</button>
            <button class="btn sm" onclick={() => ongotoSettings?.()}>去设置</button>
          </div>
        </div>
      {/if}
    </div>

  </div>

  <!--
    ★ T-4.22 · 收起来 / 放回去（D-022 · 改名见 D-485）—— 右栏取消后它搬到了 ⋮ 里。
      菜单本体挂在最外层：`.pm` 是 `position:fixed`，摆在栏里会被祖先的
      `overflow:hidden`（`.cols`）切掉一角。
      文案一个字没改：他认得的还是原来那两句。
  -->
  {#if menu}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      style="position:fixed;inset:0;z-index:499"
      data-testid="detail-menu-scrim"
      onclick={() => (menu = null)}
    ></div>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="pm on"
      role="menu"
      tabindex="-1"
      data-testid="detail-menu-open"
      style="left:{menu.x}px;top:{menu.y}px"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- ★ T-9.14 ③ · 改词条正文。解析块仍然不可改（D-468） -->
      <div
        class="mi"
        role="menuitem"
        tabindex="-1"
        data-testid="item-edit"
        onclick={() => {
          menu = null
          openEdit(d)
        }}
      >
        修改
      </div>
      <!--
        ★ T-9.14 ⑥（使用者 2026-09-08「加一下吧」）· 就练这一条。
          名字按术语表 TM-43（随时认读 / 随时练习）—— Android 那两项叫
          「认读这条 / 产出这条」，两端要一个名字（CP-01），改名归 D。
      -->
      <div
        class="mi"
        role="menuitem"
        tabindex="-1"
        data-testid="item-reading-one"
        onclick={() => {
          menu = null
          onreading?.([itemId])
        }}
      >
        随时认读这一条
      </div>
      <div
        class="mi"
        role="menuitem"
        tabindex="-1"
        data-testid="item-practice-one"
        onclick={() => {
          menu = null
          onpractice?.([itemId])
        }}
      >
        随时练习这一条
      </div>
      <div class="sep" style="margin:4px 6px"></div>
      <!-- ★ I-204 · 判据只有 core 那一份 -->
      {#if isRowSilent(d.item)}
        <div
          class="mi"
          role="menuitem"
          tabindex="-1"
          data-testid="restore-item"
          onclick={() => {
            menu = null
            void restoreItem()
          }}
        >
          {SILENCE_ACTIONS.restore}
        </div>
      {:else}
        <div
          class="mi"
          role="menuitem"
          tabindex="-1"
          data-testid="silence-item"
          onclick={() => {
            menu = null
            void silenceItem()
          }}
        >
          {SILENCE_ACTIONS.shelve}
        </div>
      {/if}
    </div>
  {/if}

  <!--
    ★★ T-9.14 ③ · 改词条正文的对话框（D-478，使用者「两端都保留改词头释义」）
      形状照抄这套界面已有的浮层（`.ov` + `.acard`），不新造第二套。
      ★ 三样能改：词条 · 释义 · 中文释义。**解析块不在这里**（D-468 取消了「改」）。
      ★ 拒绝的两种（词条空了 / 一个字没改）由 core 抛，原样显示 —— 它们本来就是人话。
  -->
  {#if editing}
    {@const e = editing}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="ov on" data-testid="edit-item-dialog" onclick={() => (editing = null)}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="acard" style="max-width:520px" onclick={(ev) => ev.stopPropagation()}>
        <div class="side">修改这条知识点</div>

        <div class="s3" style="margin-bottom:4px">知识点</div>
        <input class="tin2" style="width:100%" data-testid="edit-term" bind:value={e.term} />

        <div class="s3" style="margin:12px 0 4px">释义</div>
        <input class="tin2" style="width:100%" data-testid="edit-gloss" bind:value={e.gloss} />

        <div class="s3" style="margin:12px 0 4px">中文释义</div>
        <input class="tin2" style="width:100%" data-testid="edit-gloss-zh" bind:value={e.glossZh} />

        <div class="s3 dim" style="margin-top:10px">
          改知识点的时候，<b>原文出处里的那个词也跟着改</b>（认读卡照着出处挖空，不改就挖不中）。
          解析<b>不会自动重写</b> —— 改完这一页顶上会说一句，要不要重写你决定。
        </div>

        {#if editErr}
          <div class="errbox" data-testid="edit-item-error" style="margin-top:12px">
            <div class="h">没改成</div>
            <div style="white-space:pre-wrap">{editErr}</div>
          </div>
        {/if}

        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn pri" data-testid="edit-save" disabled={saving} onclick={saveEdit}
            >{saving ? '正在存…' : '存下'}</button
          >
          <button class="btn" data-testid="edit-cancel" onclick={() => (editing = null)}>取消</button>
        </div>
      </div>
    </div>
  {/if}

{/if}
