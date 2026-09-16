<script lang="ts">
  import { SILENCE_FILTER_NAME } from '@core/silence.ts'
  import Skel from './Skel.svelte'
  import { slide } from 'svelte/transition'
  import { fold } from './motion'
  import type { ReportData } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import { deviceName, type AnalyticsView, type PerformanceCell } from '@core/analytics/index.ts'
  import Ic from './Ic.svelte'

  /**
   * ★★ D-467（2026-09-07）· 这一页收成**三层**，使用者原话：
   * 「核心结论优先 → 高价值信息 → 必要时再深入」，「减少默认展开」。
   *
   *   ① 核心结论 —— 默认展开，最多五行，全部来自已经算好的东西（不新算指标）
   *   ② 详细数据 —— 默认展开：反复失败与稳定通过 · 产出正确率趋势 · 攻坚区
   *      （名字由使用者 2026-09-08 定；我原来写的是「值得一看」）
   *   ③ 深入     —— 默认**收起**，一次点开一块
   *
   * 「我的水平」整块（事实表单 + AI 评估 + 冷启动诊断 + 历史）取消，
   * `MyLevel.svelte` / `main/assess.ts` / 六条 `level:*` 一起删；
   * lecture 轮转 · 练习密度 · 报告页那张「两条线」也删（与别的块讲同一件事）。
   */

  type View = { k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; d: ReportData }
  let view = $state<View>({ k: 'loading' })
  /**
   * 证据层（T-4.12）单独一条通道、单独一个状态。
   *
   * ★ 故意不和上面那份合成一次调用：报告那三块与证据层是**两套判据**，
   *   合成一条的话其中一边算不出来会把另一边也拖黑 —— 而他看到的会是整页空白，
   *   连「哪一半坏了」都看不出来。
   */
  type Ev = { k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; v: AnalyticsView }
  let ev = $state<Ev>({ k: 'loading' })
  let days = $state(30)
  /** 「为什么」里点开的是哪一条（点开能看到具体事件行） */
  let openWhy = $state<string | null>(null)

  /**
   * ★ 第三层：**一次只开一块**（D-467）。
   * 不是每块各记一个开关 —— 那样点着点着又会变成「一打开就一大片」，
   * 而那正是他这次要改掉的东西。
   */
  let openDeep = $state<string | null>(null)
  const toggleDeep = (k: string): void => {
    openDeep = openDeep === k ? null : k
  }

  /** 两条通道各自的成品；没算出来就是 null，块自己说自己的状态 */
  const d = $derived(view.k === 'ok' ? view.d : null)
  const v = $derived(ev.k === 'ok' ? ev.v : null)

  async function load(): Promise<void> {
    try {
      view = { k: 'ok', d: await window.nyx.report.build(days) }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }
  async function loadEv(): Promise<void> {
    try {
      ev = { k: 'ok', v: await window.nyx.report.evidence(days) }
    } catch (err) {
      ev = { k: 'error', message: cleanMessage(err) }
    }
  }
  $effect(() => {
    void days
    load()
    loadEv()
  })

  const md = (t: number): string => {
    const d0 = new Date(t)
    return `${d0.getMonth() + 1}/${d0.getDate()}`
  }
  const pct = (r: number): number => Math.round(r * 100)
  /** 日期 + 时刻 —— 「点开能看到」那一栏要能对上库里那一行 */
  const mdhm = (t: number): string => {
    const d0 = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d0.getMonth() + 1}/${d0.getDate()} ${p(d0.getHours())}:${p(d0.getMinutes())}`
  }
  /** 层级的说法只有一套（CLAUDE.md §二 术语）：A = 理解层 / 被动词汇，B = 写作层 / 主动词汇 */
  const layerName = (k: string): string =>
    k === 'A' ? '理解层 · 理解层' : k === 'B' ? '写作层 · 写作层' : '对不上层级'

  /**
   * 「表现」那一块的四张小表。
   *
   * ★ 这里**不做任何判断** —— core 已经把四份算好了（`performance()`），
   *   这一段只决定「哪一份摆在前面、那一格叫什么」。判据留在 core 的理由同
   *   D-238：将来手机要显示同样的东西时，搬走的是判据，不是这段摆法。
   */
  type PerfTab = {
    title: string
    kind: 'layer' | 'type'
    pick: (p: AnalyticsView['performance']) => PerformanceCell[]
  }
  const PERF_TABS: PerfTab[] = [
    { title: '产出 · 按层级', kind: 'layer', pick: (p) => p.production.byLayer },
    { title: '产出 · 按题型', kind: 'type', pick: (p) => p.production.byType },
    { title: '认读 · 按层级', kind: 'layer', pick: (p) => p.reading.byLayer }
  ]
  /** 一格叫什么。`unknown` 是「对不上」，不是一种题型 —— 说清楚，别让它看起来像个真名字 */
  const cellName = (kind: PerfTab['kind'], key: string): string =>
    kind === 'layer' ? layerName(key) : key === 'unknown' ? '没对上题的' : key
  const rateText = (c: PerformanceCell): string =>
    c.rate === null ? '没样本' : `${pct(c.rate)}% · ${c.attempts} 次`
  /** 带正负号的差值 —— 0 就是 0，不写 +0 */
  const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))

  /** 堆叠面积图：把四态按天堆起来，转成一组 SVG path。 */
  function stack(flow: ReportData['flow'], w: number, h: number): { d: string; fill: string; label: string }[] {
    if (flow.length === 0) return []
    const max = Math.max(1, ...flow.map((f) => f.new + f.training + f.hard + f.silent))
    const x = (i: number): number => (i / Math.max(1, flow.length - 1)) * w
    const y = (val: number): number => h - (val / max) * h

    // 顺序 = 从上到下：新增 → 训练中 → 攻坚 → 静默（下方深色带越厚，沉到静默的越多）
    const keys = [
      // ★ 颜色走图表阶梯令牌（CL-Q7 定案：同一条水色四档 + 一个 attention）。
      // SVG 的 fill **属性**读不到 var()，所以下面画的时候写成 style="fill:…"（A1）。
      { k: 'new' as const, fill: 'var(--chart-1)', label: '新增未练' },
      { k: 'training' as const, fill: 'var(--chart-2)', label: '训练中' },
      { k: 'hard' as const, fill: 'var(--chart-attention)', label: '攻坚区' },
      { k: 'silent' as const, fill: 'var(--chart-4)', label: SILENCE_FILTER_NAME }
    ]

    const out: { d: string; fill: string; label: string }[] = []
    const base = flow.map(() => 0)
    for (const { k, fill, label } of [...keys].reverse()) {
      const top = flow.map((f, i) => base[i]! + f[k])
      const up = top.map((val, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(val).toFixed(1)}`)
      const down = base
        .map((val, i) => `L${x(i).toFixed(1)},${y(val).toFixed(1)}`)
        .reverse()
      out.unshift({ d: `${up.join('')}${down.join('')}Z`, fill, label })
      for (let i = 0; i < base.length; i++) base[i] = top[i]!
    }
    return out
  }

  /** 折线图：正确率趋势 */
  function line(points: ReportData['accuracy']['points'], w: number, h: number): string {
    if (points.length === 0) return ''
    const x = (i: number): number => (i / Math.max(1, points.length - 1)) * w
    return points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${(h - p.rate * h).toFixed(1)}`)
      .join('')
  }

  /**
   * ★★ ① 核心结论的三句话 —— **一个新指标都不算**（D-467）。
   *
   * 全部取自已经算好的 `trend` / `weak` / `strong` / `why`。
   * 这里只做一件事：把它们排成「做了多少 · 卡在哪几条 · 下一步做什么」。
   * 算不出来就说算不出来 —— 编一个数出来比不说更糟。
   */
  function didLine(a: AnalyticsView): string {
    const t = a.trend
    const prac = t.current.answers + t.current.reviews
    const dPrac = t.delta.answers + t.delta.reviews
    const rate = t.current.firstTry.rate === null ? '没样本' : `${pct(t.current.firstTry.rate)}%`
    const dRate = t.delta.firstTryRate === null ? '' : `（${signed(pct(t.delta.firstTryRate))} pt）`
    return (
      `近 ${t.days} 天练习 ${prac} 次（${signed(dPrac)}）· 查词 ${t.current.lookups} 次` +
      `（${signed(t.delta.lookups)}）· 第一次判定正确率 ${rate}${dRate}` +
      (t.partial ? ' · ★ 上一窗没取全，别把差值当结论' : '')
    )
  }
  const stuckLine = (a: AnalyticsView): string =>
    a.weak.length === 0
      ? '这段时间没有反复挂的条目。'
      : `反复挂 ${a.weak.length} 条：${a.weak.slice(0, 3).map((e) => e.term).join(' · ')}` +
        (a.weak.length > 3 ? ` 等` : '')
  const steadyLine = (a: AnalyticsView): string =>
    a.strong.length === 0 ? '' : `稳下来的 ${a.strong.length} 条：${a.strong.slice(0, 3).map((e) => e.term).join(' · ')}`
</script>

<!--
  ★★ T-4.11 / D-R29（使用者 2026-09-07：「Windows 端的分析报告拥有一个独立、明确的界面」）
     这一页现在有自己的路由（`k: 'report'`）与侧边栏入口，所以标题回到页内 ——
     D-448 §5.8 当初去掉标题的理由是「标题由首页那根条给出」，那个前提没有了。
-->
<!-- ★ D-484 · 清单 11 的目标：页头（讲的是「先看上面、要细节再往下」）-->
<div class="vh" data-guide="report-layers">
  <h1 data-testid="report-title">分析报告</h1>
  <span class="c" data-testid="report-range">
    {d ? `${md(d.from)} – ${md(d.to - 1)}` : ''}
  </span>
  <div class="sp"></div>
  <div class="segs">
    <button class:on={days === 7} data-testid="range-7" onclick={() => (days = 7)}>本周</button>
    <button class:on={days === 30} data-testid="range-30" onclick={() => (days = 30)}>本月</button>
    <button class:on={days === 180} data-testid="range-180" onclick={() => (days = 180)}>半年</button>
  </div>
</div>

{#if view.k === 'error'}
  <div class="errbox" data-testid="report-error">
    <div class="h">报告打不开</div>
    <div style="white-space:pre-wrap">{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={load}>重试</button></div>
  </div>
{/if}
{#if ev.k === 'error'}
  <div class="errbox" data-testid="evidence-error">
    <div class="h">证据层没算出来</div>
    <div style="white-space:pre-wrap">{ev.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={loadEv}>重试</button></div>
  </div>
{/if}

{#if d && d.accuracy.sample === 0}
  {@const last0 = d.flow[d.flow.length - 1]}
  {#if (last0 ? last0.new + last0.training + last0.hard + last0.silent : 0) === 0}
    <!--
      I-040 · 没数据也要能看见页面。
      以前这里直接把整页换成一句「还没有东西可看」—— 使用者连报告长什么样都不知道，
      也就无从判断值不值得为它攒数据。现在改成**顶上一条说明 + 照常渲染各块**。
    -->
    <div class="notice" data-testid="report-empty" style="margin-bottom:14px">
      <b>还没有数据，下面是报告的样子。</b>
      报告要攒一两个月才有形状 —— 先看看它会告诉你什么，练几轮之后再回来。
    </div>
  {/if}
{/if}

<!-- ══ ① 核心结论 · 默认展开，最多五行 ══════════════════════ -->
<div class="sec" data-testid="sec-core"><span class="en">核心结论</span></div>
<div class="card rc full" data-testid="report-core">
  {#if !v}
    <div class="dim ev0">{ev.k === 'error' ? '证据层没算出来 —— 上面那条说了为什么。' : '正在算…'}</div>
  {:else}
    <div class="cap2">
      三句话：这段时间做了多少 · 卡在哪几条 · 下一步做什么。<b>都是下面已经算出来的东西</b>，
      这里不另算一个数。
    </div>
    <div class="hit" data-testid="core-did"><span class="t">做了多少</span><span class="w">{didLine(v)}</span></div>
    <div class="hit" data-testid="core-stuck"><span class="t">卡在哪几条</span><span class="w">{stuckLine(v)}</span></div>
    {#if steadyLine(v)}
      <div class="hit" data-testid="core-steady"><span class="t">稳下来的</span><span class="w">{steadyLine(v)}</span></div>
    {/if}
    <!--
      ★ 「下一步」必须是**一个动作**，不是把上面那句换个说法再说一遍。
        第一版写的是 `why[0].text`，而那句话讲的正是「卡在哪几条」——
        两行说同一件事，这一层就白设了（截图上一眼看出来的）。
        所以这里按已有的数排一个优先级：先攻坚区（最贵）→ 再反复挂的
        → 再练得少了 → 都没有就直说没有。**一个新指标都没算。**
    -->
    <div class="hit" data-testid="core-next">
      <span class="t">下一步</span>
      <span class="w">
        {#if d && d.hardFlow.staying > 0}
          先清攻坚区那 {d.hardFlow.staying} 条：进了攻坚区就说明它已经挂过好几次，
          比新收的更该占今天的时间。{#if v.weak.length > 0}其次是上面反复挂的那几条。{/if}
        {:else if v.weak.length > 0}
          先单独练反复挂的那几条（{v.weak.slice(0, 3).map((e) => e.term).join(' · ')}）——
          反复失败比进攻坚区更早，现在处理还来得及。
        {:else if v.trend.delta.answers + v.trend.delta.reviews < 0}
          最近练得比上一窗少了 {Math.abs(v.trend.delta.answers + v.trend.delta.reviews)} 次 ——
          没有卡住的条目，缺的是量。
        {:else}
          没有卡住的条目，练习量也没掉 —— 照常练就行。
        {/if}
      </span>
    </div>
  {/if}
</div>

<!-- ══ ② 详细数据 · 默认展开（名字使用者 2026-09-08 定）══════ -->
<div class="sec" data-testid="sec-high"><span class="en">详细数据</span></div>
<div class="rg">
  <!-- 反复失败与稳定通过 —— 「反复失败」是比攻坚区更早的信号 -->
  <div class="card rc" data-testid="report-weak">
    <h3>反复失败与稳定通过</h3>
    <div class="cap2">
      「反复失败」是<b>比攻坚区更早的信号</b>；两条线各自数，不加成一个数。
    </div>
    <details class="mxfold src"><summary>数据源</summary>
      answers（产出第一次判定挂了几次）· review_logs 的 line='reading' 且 grade=1（认读忘了几次）。
      用的阈值与它的出处，见「深入」里的「为什么」。
    </details>
    {#if !v}
      <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
    {:else}
      <div class="evh">反复挂的</div>
      {#if v.weak.length === 0}
        <div class="dim ev0">这段时间没有反复挂的条目。</div>
      {:else}
        {#each v.weak as e (e.itemId)}
          <div class="hit">
            <span class="t">{e.term}</span>
            <span class="w"
              >产出挂 {e.fails} · 认读忘 {e.lapses}{e.daysSince === null ? '' : ` · ${e.daysSince} 天前`}</span
            >
          </div>
        {/each}
      {/if}
      <div class="evh">稳下来的</div>
      {#if v.strong.length === 0}
        <div class="dim ev0">这段时间还没有连续过关的条目。</div>
      {:else}
        {#each v.strong as e (e.itemId)}
          <div class="hit">
            <span class="t">{e.term}</span>
            <span class="w"
              >连续 {e.tailPasses} 次一次过{e.lapses > 0 ? ` · 认读还忘过 ${e.lapses} 次` : ''}</span
            >
          </div>
        {/each}
      {/if}
    {/if}
  </div>

  <!-- 产出正确率趋势 -->
  <div class="card rc" data-testid="report-accuracy">
    <h3>产出正确率趋势</h3>
    <div class="cap2">
      只算<b>第一次判定</b>—— 改到过关的那些不是诚实样本，混进来趋势就假了。
    </div>
    {#if !d}
      <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
    {:else}
      <div class="bigl">
        <span class="n">{pct(d.accuracy.overall)}%</span>
        {#if d.accuracy.sample >= 10}
          <span class="delta"
            >{d.accuracy.secondHalf >= d.accuracy.firstHalf ? '▲' : '▼'}
            {Math.abs(pct(d.accuracy.secondHalf) - pct(d.accuracy.firstHalf))} pt</span
          >
        {/if}
      </div>
      <div style="font-size:var(--fs-1);color:var(--text-3);margin-bottom:12px">
        {#if d.accuracy.sample >= 10}
          前半程 {pct(d.accuracy.firstHalf)}% → 后半程 {pct(d.accuracy.secondHalf)}% ·
        {/if}
        共 {d.accuracy.sample} 次第一判定
      </div>
      <svg viewBox="0 0 340 100" style="width:100%;height:auto">
        <line x1="0" y1="92" x2="340" y2="92" style="stroke:var(--chart-grid)" />
        {#if d.accuracy.points.length > 1}
          <path d={line(d.accuracy.points, 340, 92)} fill="none" style="stroke:var(--color-primary)" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round" />
        {:else}
          <text x="170" y="50" font-size="11" style="fill:var(--color-text-3)" text-anchor="middle">数据还太少</text>
        {/if}
      </svg>
    {/if}
  </div>

  <!-- 攻坚区 · 看净值 -->
  <div class="card rc full" data-testid="report-hard">
    <h3>攻坚区</h3>
    <div class="cap2">
      <b>净值比总量更说明问题</b>：进得多出得少，说明判层太松（O-204）。
    </div>
    {#if !d}
      <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
    {:else}
      <div class="flow">
        <div class="bx in">
          <div class="n" style="color:var(--amber)">+{d.hardFlow.entered}</div>
          <div class="l">这段时间进入</div>
        </div>
        <span class="ar">→</span>
        <div class="bx stay"><div class="n">{d.hardFlow.staying}</div><div class="l">当前滞留</div></div>
        <span class="ar">→</span>
        <div class="bx out">
          <div class="n" style="color:var(--green)">−{d.hardFlow.left}</div>
          <div class="l">攻出去了</div>
        </div>
      </div>
      <div style="font-size:var(--fs-2);color:var(--text-2);margin-top:12px;padding-top:11px;border-top:1px solid var(--line)">
        净{d.hardFlow.net >= 0 ? '减' : '增'}
        <b style="font-family:var(--mono);color:var({d.hardFlow.net >= 0 ? '--green' : '--amber'})"
          >{Math.abs(d.hardFlow.net)}</b
        > 条
        {#if d.hardFlow.byRepeat > 0}
          · 其中 <b>{d.hardFlow.byRepeat}</b> 条因「重复收集」进来
        {/if}
      </div>
    {/if}
  </div>
</div>

<!--
  ══ ③ 深入 · 默认收起，一次点开一块 ═══════════════════════════

  ★ 每一块的**数据源写在块头注里**（`.src` 那一行）—— 页面上每一个数字
    都要能指回一张事件表 + 一段 SQL（`core/sql/analytics.ts`）。
    不凭空造指标：算不出来的东西宁可不显示，也不放一个来路不明的数。
-->
<div class="sec" data-testid="sec-deep">
  <span class="en">深入</span><span class="dim"> · 需要时点开，一次一块</span>
</div>
<div class="rg">
  <!-- 知识流向 -->
  <div class="card rc full" data-testid="report-flow">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="sec fold-head" data-testid="deep-head-flow" onclick={() => toggleDeep('flow')}>
      <span class="en">知识流向</span>
      <span class="dim">我的知识在往哪流 —— 不是「我做了多少题」</span>
      <span class="fold-car" class:open={openDeep === 'flow'}><Ic n="caret" s={12} /></span>
    </div>
    {#if openDeep === 'flow'}
      <div class="foldbody" transition:slide={fold()}>
      {#if !d}
        <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
      {:else}
        {@const last = d.flow[d.flow.length - 1]}
        <div class="cap2">
          每一天你的写作层分布在哪个阶段。<b>下方深色带越厚，说明练成的越多。</b>
          这一张回答的是「我的知识在往哪流」——<b>不是「我做了多少题」</b>。
        </div>
        <svg viewBox="0 0 720 200" style="width:100%;height:auto">
          <line x1="0" y1="170" x2="720" y2="170" style="stroke:var(--chart-grid)" />
          {#each stack(d.flow, 720, 170) as band, i (i)}
            <path d={band.d} style="fill:{band.fill}" />
          {/each}
          <text x="4" y="190" font-size="10" style="fill:var(--color-text-3)" font-family="ui-monospace,monospace">{md(d.from)}</text>
          <text x="686" y="190" font-size="10" style="fill:var(--color-text-3)" font-family="ui-monospace,monospace" text-anchor="end"
            >{md(d.to - 1)}</text
          >
        </svg>
        <div class="rlg">
          <span><i class="c1"></i>新增未练 {last?.new ?? 0}</span>
          <span><i class="c2"></i>训练中 {last?.training ?? 0}</span>
          <span><i class="catt"></i>攻坚区 {last?.hard ?? 0}</span>
          <span><i class="c4"></i>{SILENCE_FILTER_NAME} {last?.silent ?? 0}</span>
        </div>
      {/if}
      </div>
    {/if}
  </div>

  <!-- 认读 / 产出表现 -->
  <div class="card rc full" data-testid="report-performance">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="sec fold-head" data-testid="deep-head-performance" onclick={() => toggleDeep('performance')}>
      <span class="en">认读 / 产出表现</span>
      <span class="dim">两条线各出各的</span>
      <span class="fold-car" class:open={openDeep === 'performance'}><Ic n="caret" s={12} /></span>
    </div>
    {#if openDeep === 'performance'}
      <div class="foldbody" transition:slide={fold()}>
      <div class="cap2">
        <b>两条线各出各的</b>（D-014 / D-085）—— 产出的「对」是「我写出来了」，认读的「对」是「我想起来了」。
      </div>
      <details class="mxfold src"><summary>数据源</summary>
        产出 = answers 里 is_first=1 的判定（D-121），按题型 / 档位来自 questions；
        认读 = review_logs 的 line='reading'。★ 认读卡不出题，所以认读没有「按题型」那一张。
      </details>
      {#if !v}
        <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
      {:else}
        {#each PERF_TABS as tab (tab.title)}
          {@const cells = tab.pick(v.performance)}
          <div class="evh">{tab.title}</div>
          {#if cells.length === 0}
            <div class="dim ev0">这段时间没有样本。</div>
          {:else}
            {#each cells as c (c.key)}
              <div class="evr">
                <span class="k">{cellName(tab.kind, c.key)}</span>
                <span class="bar"><i style="width:{c.rate === null ? 0 : pct(c.rate)}%"></i></span>
                <span class="v">{rateText(c)}</span>
              </div>
            {/each}
          {/if}
        {/each}
      {/if}
      </div>
    {/if}
  </div>

  <!-- 学习时间线与时段密度 -->
  <div class="card rc full" data-testid="report-activity">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="sec fold-head" data-testid="deep-head-activity" onclick={() => toggleDeep('activity')}>
      <span class="en">学习时间线与时段密度</span>
      <span class="dim">哪几天在学、几点在学</span>
      <span class="fold-car" class:open={openDeep === 'activity'}><Ic n="caret" s={12} /></span>
    </div>
    {#if openDeep === 'activity'}
      <div class="foldbody" transition:slide={fold()}>
      <div class="cap2">
        哪几天在学、几点在学、在哪台机器上学。<b>只数动作，不评价</b>（D-362）。
      </div>
      <details class="mxfold src"><summary>数据源</summary>
        answers（作答）· review_logs 的 line='reading'（认读判分）·
        ops_log 的 op='lookup'（查词）· sessions（场次）。
        ★ review_logs 里 line='production' 那些行不再数一遍 —— 它与 answers 是同一次事件的两半。
      </details>
      {#if !v}
        <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
      {:else}
        {@const act = v.activity}
        {@const maxDay = Math.max(1, ...act.byDay.map((x) => x.answers + x.reviews + x.lookups))}
        {@const maxHour = Math.max(1, ...act.byHour.map((x) => x.answers + x.reviews + x.lookups))}
        {@const acts = act.totals.answers + act.totals.reviews + act.totals.lookups}
        <svg viewBox="0 0 720 110" style="width:100%;height:auto">
          <line x1="0" y1="100" x2="720" y2="100" style="stroke:var(--chart-grid)" />
          {#each act.byDay as x, i (x.at)}
            {@const w = 720 / Math.max(1, act.byDay.length)}
            {@const prac = ((x.answers + x.reviews) / maxDay) * 92}
            {@const look = (x.lookups / maxDay) * 92}
            <rect x={i * w + 0.5} y={100 - prac} width={Math.max(1.2, w - 1.4)} height={prac} style="fill:var(--chart-4)" />
            <rect x={i * w + 0.5} y={100 - prac - look} width={Math.max(1.2, w - 1.4)} height={look} style="fill:var(--chart-2)" />
          {/each}
        </svg>
        <div class="rlg">
          <span><i class="c4"></i>练习 {act.totals.answers + act.totals.reviews} 次</span>
          <span><i class="c2"></i>查词 {act.totals.lookups} 次</span>
          <span>作答 {act.totals.answers} · 认读判分 {act.totals.reviews} · 场次 {act.totals.sessions}</span>
          <span>有计时的 {act.totals.timed} 行合计 {act.totals.minutes} 分钟</span>
        </div>

        <div class="evh">按小时（本机时区）</div>
        <div class="hrs" data-testid="report-hours">
          {#each act.byHour as x (x.hour)}
            {@const n = x.answers + x.reviews + x.lookups}
            <i class="l{n === 0 ? 0 : Math.min(4, Math.ceil((n / maxHour) * 4))}" title="{x.hour} 点 · {n} 次"></i>
          {/each}
        </div>
        <div class="hrx"><span>0</span><span>6</span><span>12</span><span>18</span></div>

        <div class="evh">按设备（没有 device 的旧行不猜，单列一行）</div>
        {#if act.byDevice.length === 0}
          <div class="dim ev0">这段时间没有动作。</div>
        {:else}
          {#each act.byDevice as x (x.device)}
            <div class="evr">
              <span class="k">{deviceName(x.device)}</span>
              <span class="bar"
                ><i style="width:{Math.round(((x.answers + x.reviews + x.lookups) / Math.max(1, acts)) * 100)}%"></i></span
              >
              <span class="v">作答 {x.answers} · 认读 {x.reviews} · 查 {x.lookups} · 场 {x.sessions}</span>
            </div>
          {/each}
        {/if}

        <div class="src evt" data-testid="report-trend">
          周对周（近 {v.trend.days} 天 vs 前 {v.trend.days} 天）：练习
          {v.trend.current.answers + v.trend.current.reviews} 次（{signed(
            v.trend.delta.answers + v.trend.delta.reviews
          )}）· 查词 {v.trend.current.lookups} 次（{signed(v.trend.delta.lookups)}）· 第一次判定正确率
          {v.trend.current.firstTry.rate === null ? '没样本' : pct(v.trend.current.firstTry.rate) + '%'}
          {#if v.trend.delta.firstTryRate !== null}（{signed(pct(v.trend.delta.firstTryRate))} pt）{/if}
          {#if v.trend.partial}· ★ 上一窗没取全，别把这个差值当结论{/if}
        </div>
      {/if}
      </div>
    {/if}
  </div>

  <!-- 查词行为 -->
  <div class="card rc full" data-testid="report-lookups">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="sec fold-head" data-testid="deep-head-lookups" onclick={() => toggleDeep('lookups')}>
      <span class="en">查词行为</span>
      <span class="dim">查 → 收 → 练 → 过 / 挂</span>
      <span class="fold-car" class:open={openDeep === 'lookups'}><Ic n="caret" s={12} /></span>
    </div>
    {#if openDeep === 'lookups'}
      <div class="foldbody" transition:slide={fold()}>
      <div class="cap2">
        查 → 收 → 练 → 过 / 挂。<b>「反复查同一个词」「查了没收」「收了没练」是最便宜也最真的信号</b>。
      </div>
      <details class="mxfold src"><summary>数据源</summary>
        ops_log 的 op='lookup'（词面在 title）与 op='capture'（target_id = 知识点）·
        answers / review_logs（练没练、过没过）。查与收按 normalizeTerm 连 ——
        大小写 / 多余空白 / 尾标点不算两个词。
      </details>
      {#if !v}
        <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
      {:else}
        <div class="flow">
          <div class="bx">
            <div class="n">{v.funnel.looked}</div>
            <div class="l">查过的词（{v.funnel.lookups} 次）</div>
          </div>
          <span class="ar">→</span>
          <div class="bx"><div class="n">{v.funnel.captured}</div><div class="l">收进来了</div></div>
          <span class="ar">→</span>
          <div class="bx"><div class="n">{v.funnel.practiced}</div><div class="l">练过</div></div>
          <span class="ar">→</span>
          <div class="bx out">
            <div class="n" style="color:var(--green)">{v.funnel.passed}</div>
            <div class="l">最后一次过了</div>
          </div>
          <div class="bx in">
            <div class="n" style="color:var(--amber)">{v.funnel.failed}</div>
            <div class="l">最后一次挂了</div>
          </div>
        </div>
        {#if v.funnel.capturedGone > 0}
          <div class="src evt">
            另有 {v.funnel.capturedGone} 个词收过、后来被删掉了 —— 那是他的决定，不算进「查了没收」（D-435）。
          </div>
        {/if}
        <div class="rg evg">
          <div>
            <div class="evh">查得最多的</div>
            {#if v.topLookups.length === 0}
              <div class="dim ev0">这段时间没有查词记录。</div>
            {:else}
              {#each v.topLookups as t (t.term)}
                <div class="hit"><span class="t">{t.term}</span><span class="w">{t.n} 次 · {md(t.lastAt)}</span></div>
              {/each}
            {/if}
          </div>
          <div>
            <div class="evh" data-testid="lookups-uncaptured">查了没收（{v.funnel.lookedNotCaptured.length}）</div>
            {#if v.funnel.lookedNotCaptured.length === 0}
              <div class="dim ev0">查过的词都收进来了。</div>
            {:else}
              {#each v.funnel.lookedNotCaptured.slice(0, 8) as t (t.term)}
                <div class="hit"><span class="t">{t.term}</span><span class="w">{t.n} 次 · {md(t.lastAt)}</span></div>
              {/each}
            {/if}
            <div class="evh">收了没练（{v.funnel.capturedNotPracticed.length}）</div>
            {#if v.funnel.capturedNotPracticed.length === 0}
              <div class="dim ev0">收进来的都练过了。</div>
            {:else}
              {#each v.funnel.capturedNotPracticed.slice(0, 8) as it (it.itemId)}
                <div class="hit">
                  <span class="t">{it.term}</span>
                  <span class="w">查过 {it.lookups} 次{it.capturedAt === null ? '' : ` · ${md(it.capturedAt)} 收下`}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {/if}
      </div>
    {/if}
  </div>

  <!-- 知识点变化 -->
  <div class="card rc full" data-testid="report-changes">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="sec fold-head" data-testid="deep-head-changes" onclick={() => toggleDeep('changes')}>
      <span class="en">知识点变化</span>
      <span class="dim">这段时间库里发生了什么</span>
      <span class="fold-car" class:open={openDeep === 'changes'}><Ic n="caret" s={12} /></span>
    </div>
    {#if openDeep === 'changes'}
      <div class="foldbody" transition:slide={fold()}>
      <div class="cap2">
        这段时间库里<b>发生了什么</b>。★ 与「知识流向」那张图不是一回事：那张画的是每天的存量，这里数的是动作。
      </div>
      <details class="mxfold src"><summary>数据源</summary>
        state_events（产出线状态跳变）· item_events 的 kind='analyzed'（分析发生过几次、来自哪）·
        lecture_logs 的 event='practiced'（Lecture 结算）。
      </details>
      {#if !v}
        <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
      {:else}
        {#if v.changes.transitions.length === 0}
          <div class="dim ev0">这段时间没有状态变化。</div>
        {:else}
          {@const maxT = Math.max(1, ...v.changes.transitions.map((x) => x.n))}
          {#each v.changes.transitions as t (t.from + t.to)}
            <div class="evr">
              <span class="k">{t.from} → {t.to}</span>
              <span class="bar"><i style="width:{Math.round((t.n / maxT) * 100)}%"></i></span>
              <span class="v">{t.n} 次</span>
            </div>
          {/each}
        {/if}
        <div class="src evt">
          分析发生 {v.changes.analysed.total} 次{#if v.changes.analysed.byOrigin.length > 0}（{v.changes.analysed.byOrigin
              .map((o) => `${o.origin} ${o.n}`)
              .join(' · ')}）{/if} · Lecture 结算 {v.changes.lectureRuns.n} 次
        </div>
      {/if}
      </div>
    {/if}
  </div>

  <!-- 为什么 -->
  <div class="card rc full" data-testid="report-why">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="sec fold-head" data-testid="deep-head-why" onclick={() => toggleDeep('why')}>
      <span class="en">为什么</span>
      <span class="dim">规则化的一句话，不是 AI 写的</span>
      <span class="fold-car" class:open={openDeep === 'why'}><Ic n="caret" s={12} /></span>
    </div>
    {#if openDeep === 'why'}
      <div class="foldbody" transition:slide={fold()}>
      <div class="cap2">
        规则化的一句话，<b>不是 AI 写的</b>。每句都写着用的哪个阈值、那个数谁定的；
        点开能看到它指的是哪几行事件。
      </div>
      <details class="mxfold src"><summary>数据源</summary>上面各块算出来的证据。规则与阈值在 core/analytics/why.ts 与 thresholds.ts。</details>
      {#if !v}
        <Skel rows={3} widths={['w85', 'w100', 'w55']} testid="report-skel" />
      {:else if v.why.length === 0}
        <div class="dim ev0">没有事实就不出话 —— 这段时间没有够得上任何一条规则的事。</div>
      {:else}
        <div class="whyl">
          {#each v.why as w (w.rule)}
            <div class="whyi" data-testid="why-{w.rule}">
              <div class="tx">{w.text}</div>
              <div class="mt">阈值 {w.threshold} · 出处 {w.source}</div>
              <div class="evt">
                <button
                  class="btn sm"
                  data-testid="why-open-{w.rule}"
                  onclick={() => (openWhy = openWhy === w.rule ? null : w.rule)}
                  >{openWhy === w.rule ? '收起' : `凭什么这么说（${w.refs.length} 行）`}</button
                >
              </div>
              {#if openWhy === w.rule}
                <div class="refs" data-testid="why-refs-{w.rule}">
                  {#each w.refs.slice(0, 60) as r, i (r.table + r.id + i)}
                    <div>{r.table} #{r.id} · {mdhm(r.at)}</div>
                  {/each}
                  {#if w.refs.length > 60}<div>…共 {w.refs.length} 行</div>{/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      </div>
    {/if}
  </div>
</div>
