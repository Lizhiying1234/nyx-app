<script lang="ts">
  /**
   * ══ Today（SC-02）· 屏级重做 · 2026-09-09 ═══════════════════════════
   *
   * ★ 五问（守「别把功能弄丢」）由派单答过：**八条能力一条不删**。
   *   下面是六问（问「这一屏到底该长什么样」）的答案 —— 判断标准不是「像不像原来」，
   *   而是「操作是否更自然 · 层级是否更清晰」（使用者：功能保守，表现激进）。
   *
   * 1 · 这一页解决什么问题？
   *     打开软件那一刻**唯一**的问题：「我现在该做什么」。它不是仪表盘。
   *
   * 2 · 最重要的任务？
   *     按一下开始今天的产出练习。第二位是认读。**其余全是参考。**
   *
   * 3 · 哪些信息最重要？
   *     **今天实际会练多少条**，以及那是哪几讲。
   *     ★ 这一条改掉了旧版最大的一个错位：旧版把 30px 的大数字给了**目标**（那是个设置），
   *       而真正的答案「今日实际 5 条」缩在列表底下一行小字里。**主角站错了位置。**
   *       现在大数字是「今天 N 条」，目标降成它下面一行可调的小控件。
   *
   * 4 · 哪些操作最容易被发现？
   *     「开始产出练习」——**一屏唯一的 Primary**（IX-16 的判定问句：「他只点一下就走，
   *     应该点哪个」只能有一个答案）。旧版有**三颗**实心主色按钮（开始 · 去设置 · 回到这里），
   *     那等于没有主角。另外两颗按这条降档成 Banner 动作与 Navigation。
   *
   * 5 · 哪些该降权重 / 折叠？
   *     **说明文字**。旧版主角上面压着三段共六行解释（「你定条数…」「这是今天的推荐…」），
   *     全屏字最多的地方在解释软件自己（使用者原话：「整个界面在不停地跟你解释它自己」）。
   *     现在：**一句留在明面**（那句是使用者点名要的，T-4.13「排期是推荐不是门禁」），
   *     其余折叠（D-445「能合并先合并，然后展开 / 收起」）。
   *     副列两张卡的**外框**也去掉 —— S1「不要把整个 UI 做成 Card」。
   *
   * 6 · 哪些结构是历史遗留？
   *     `.tgrid` 1.85fr / 0.85fr 的比例 · 四个数排成一行硬挤 · 卡片外框 ·
   *     `.qty` 自造的方块步进 · 「打开 ›」这种按钮式导航 · AI 引导那一整块填色。
   *
   * ★ **新加的一样**（ST-Q3 定案，UI_STATE_MATRIX §四 点名的缺口）：**partial 提示**。
   *   分析完了停在「待审阅」的讲次，是这条链上最容易断的一环 ——
   *   AI 跑完了、人没去过目，于是它既不在轮转里也没人提醒。现在首页说这件事。
   *   ☞ 派单要求「点进去要有一个能一次处理的地方」—— **那个地方今天不存在**，
   *     造它属于加功能（已冻结）。所以这一版点进去落到**第一条待审阅的讲次**
   *     （复用现成能力），并把这件事记进派单 §六 回报总控。
   */
  import Stars from './Stars.svelte'
  import { ROTATION_WORDS } from '@core/silence.ts'
  import Skel from './Skel.svelte'
  import type { HardRow, LectureBrief, TodayPlan } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import Ic from './Ic.svelte'

  let {
    lectures,
    onopen,
    onstart,
    onpractice,
    onreading,
    onhard,
    ongotoSettings,
    ongotoReport
  }: {
    lectures: LectureBrief[]
    onopen: (id: number) => void
    onstart: () => void
    onpractice: (lectureIds: number[]) => void
    onreading: () => void
    onhard: () => void
    ongotoSettings: () => void
    ongotoReport: () => void
  } = $props()

  /**
   * D-207 · 没配 AI 的时候给一条引导（使用者 2026-09-03「可以加配置引导」）。
   *
   * ★ 这不是催他（D-100）也不是数落他（D-322）：**配好之后它永远不再出现**，
   *   而且不挡任何路 —— 没配 AI 照样能贴材料、能认读、能手动加知识点。
   *   它只回答「第一次打开时该先干什么」这一个问题。
   * ★ 判据走 `ai.isConfigured`（heavy 槽三样齐全才算数），不自己再数一遍设置 ——
   *   那会长出第二份判据。
   * ★ 先当 true：读出来之前不要闪一下引导再消失。
   */
  let aiReady = $state(true)
  void (async () => {
    try {
      aiReady = await window.nyx.ai.isConfigured()
    } catch {
      /* 读不出来就不显示 —— 引导自己出错，不该反过来打扰他 */
    }
  })()

  // D-448 §5.8 · 报告不再是独立一级空间（使用者 2026-09-02 裁：不留，并进首页）。
  // 点击才展开，收起时不拉数据——报告本来就是「攒够了才有形状」的东西，不必常驻算一次。

  type View =
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | {
        k: 'ok'
        plan: TodayPlan
        hard: HardRow[]
        overview: {
          lectures: number
          dueLectures: number
          worstOverdue: number
          dueCards: number
          reviewLectures: number
        }
      }

  let view = $state<View>({ k: 'loading' })
  let target = $state(35)

  async function load(): Promise<void> {
    try {
      const [overview, plan, hard] = await Promise.all([
        window.nyx.study.overview(),
        window.nyx.study.todayPlan(),
        window.nyx.study.hardList()
      ])
      target = plan.target
      view = { k: 'ok', plan, hard, overview }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }
  load()

  /** D-027 · 每日条数由使用者自设、随时可改，无上下限。 */
  async function bump(d: number): Promise<void> {
    target = Math.max(1, target + d)
    try {
      await window.nyx.study.setDailyTarget(target)
      const plan = await window.nyx.study.todayPlan(target)
      if (view.k === 'ok') view = { ...view, plan }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  const resume = $derived(lectures.find((l) => l.status === 'review') ?? lectures[0] ?? null)

  /**
   * ★ D-456 · 今天是启动落点，它得先说出「这是哪一天」。
   * 原来这一屏第一行直接就是数字，没有身份 —— 一个叫「今天」的落点
   * 却不说今天是几号，那是缺一句话，不是极简。
   */
  const today = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date())
</script>
{#if view.k === 'error'}
  <div class="errbox" data-testid="home-error">
    <div class="h">Today 读不出来</div>
    <div>{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={load}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <!-- ★ B1 · 今天：一行大标题 + 一段说明 + 那颗数字 + 两条讲次行 -->
  <div class="card blk"><Skel rows={5} widths={['w45', 'w100', 'w85', 'w70', 'w70']} testid="home-skel" /></div>
{:else}
  <!--
    ★ D-456 · 这一层是为了让报告横条落到**底边**。
    没有它，主区内容一结束页面就断了，下面一整片空 ——
    而那正是我自己定的判据反对的：**留白要落在主角周围，
    不是落在页面的尾巴上**。
  -->
  <div class="today">
  <!--
    ★★★ D-456 · 一个主角 ＋ 一条副列（WINDOWS_STRUCTURE.md §三.3）

    原来是「状态行 ＋ 横跨全宽的 hero ＋ 两列 duo ＋ 横条」自上而下平铺，
    **主次是反的**：「接着上次」占了整幅宽度和最大字号，可它是**参考**；
    真正的主角「今日练习」缩在左下角。而 1600px 下右下那一整片空白
    不是留白，是没排到那儿（审计 S-1 / S-2）。

    ★ 判据：**留白要落在主角周围，不是落在页面的尾巴上。**
    ★ 五块**一块没删**，只是重新分了主次。
  -->
  <header class="thead">
    <!-- ★ TM-01 · 侧栏与页标题**同一个名字**（I-172 在这里闭掉）-->
    <h1>Today<Stars /></h1>
    <div class="tdate">{today}</div>
  </header>

  <!-- D-028 · 一行朴素事实：如实显示欠账。**不催、不弹窗、不加感叹号。** -->
  <div class="stat" data-testid="home-stat">
    <b>{view.overview.lectures}</b> 个 Lecture {ROTATION_WORDS.inPractice} <span>·</span>
    <b>{view.overview.dueLectures}</b> 个已到期
    {#if view.overview.worstOverdue > 0}
      <span>·</span>
      <span>最久的欠了 <b>{view.overview.worstOverdue}</b> 天</span>
    {/if}
    <span>·</span> 认读到期 <b>{view.overview.dueCards}</b> 张
  </div>

  <div class="tnotes">
    {#if !aiReady}
      <!-- D-207 · 没配 AI 时的一条引导，配好就永不再现。
           ★ Banner 形态（NOTIFICATION §一）：一句话 + 一颗按钮去修，**不是 Primary** -->
      <div class="banner" data-testid="ai-setup-hint">
        <span><b>还没配 AI。</b>贴材料、认读、手动加知识点都不受影响；分析和出题要配了才能跑。</span>
        <span class="sp"></span>
        <button class="btn sm" data-testid="ai-setup-go" onclick={ongotoSettings}>去设置</button>
      </div>
    {/if}

    {#if view.overview.reviewLectures > 0 && resume}
      <!-- ★ ST-Q3 · partial：有一部分做完了、其余停在半路。**说出来**，但不催（D-028）-->
      <div class="banner quiet" data-testid="home-partial">
        <span
          ><b>{view.overview.reviewLectures}</b> 个 Lecture 分析完了还没过目 —— 过目之后才会排进练习。</span
        >
        <span class="sp"></span>
        <button class="lnk" data-testid="home-partial-go" onclick={() => onopen(resume.id)}
          >去看第一个 ›</button
        >
      </div>
    {/if}
  </div>

  <div class="tgrid">
    <!-- ══ 主角 · 今日练习（D-008 / D-027）══ -->
    <section class="tmain" data-testid="today-card">
      <!--
        ★ 主角是**今天实际会练多少条**，不是目标。
          目标是一个设置；实际那个数才回答「我现在该做什么」。
      -->
      <!--
        ★ 2026-09-09 使用者裁：「Today 界面排版重新设计 —— 功能区之间缺乏区分度、
          功能区和页面底色几乎一样、没有明显边界、缺少颜色样式区分，看起来混在一起」。
          `.thero` 是**为这条新加的唯一一层 DOM**：主角面板顶上那条淡色带，
          把「今天练多少 · 目标 · 为什么是这个数」这三行圈成一个答案区，
          和下面的讲次清单分开。没有它，三行和清单只能靠间距分，
          而「靠间距分」正是他说看不出来的那一种。
      -->
      <div class="thero">
      <div class="tbig">
        <b class="n" data-testid="today-total">{view.plan.total}</b>
        <span class="u">条 · 今天的产出练习</span>
      </div>

      <!-- 目标降成一行可调的小控件（步进走 Icon 钮，与设置页同一条写入路径）-->
      <div class="qty" data-testid="today-goal">
        <span class="gl">目标</span>
        <button class="st" data-testid="qty-minus" aria-label="少 5 条" onclick={() => bump(-5)}>−</button>
        <input value={target} readonly data-testid="qty" aria-label="每日目标条数" />
        <button class="st" data-testid="qty-plus" aria-label="多 5 条" onclick={() => bump(5)}>
          <Ic n="plus" s={16} />
        </button>
        <span class="u">条</span>
      </div>

      <!-- D-356 机制透明：「为什么今天是这个数」要答得出。它是说明**不是成绩**（D-348）-->
      <div class="treason" data-testid="today-reason">{view.plan.reason}</div>
      </div><!-- /.thero -->

      <div id="mt" class="tplan">
        {#each view.plan.lectures as l (l.lectureId)}
          <div class="row-read li">
            <span class="t">{l.name ?? `L${l.lectureId}`}</span><span class="r">{l.pending} 条</span>
          </div>
        {/each}
        {#if view.plan.lectures.length === 0}
          <!-- ★ T-4.13 · 「没有推荐」不等于「不能练」—— 空的时候尤其要说清楚 -->
          <div class="dim tempty" data-testid="today-empty">
            <b>今天没有到期的 Lecture。</b>想练随时可以：进 Lecture 页，
            或右键项目 / 单元。
          </div>
        {/if}
      </div>

      <div class="tgo">
        <button
          class="btn pri"
          disabled={view.plan.total === 0}
          data-testid="start-today"
          onclick={() =>
            onpractice(view.k === 'ok' ? view.plan.lectures.map((l) => l.lectureId) : [])}
          >开始产出练习</button
        >
        <button class="btn" data-testid="start-reading" onclick={onreading}
          >认读练习 · 推荐 {view.overview.dueCards}</button
        >
      </div>

      <!--
        ★★ T-4.13 / D-R28 · **排期是推荐，不是门禁。** 这句话是使用者点名要的
           （他把「今日练习 · 到期 N」读成了「今天只能练这些」），所以**留在明面**；
           细节折叠 —— 主角上面不该压着六行解释（D-445）。
      -->
      <!--
        ★ D-484 · 清单 15 的目标：就是这句「今天的推荐，不是限制」。
          ★★ 它和清单 2（`today-paste`）**同屏但不是一回事**：那条教「怎么把材料弄进来」
            （空库时才有意义），这条治的是「他以为练满这个数就到头了」——
            对**有材料的人**才成立，正好补上那条够不着的那半（清单 §二 ★）。
          一次只出一条，另一条下次进来再出。
      -->
      <details class="tnote" data-testid="today-recommend" data-guide="today-recommend">
        <!--
          ★ 明面这一句里**必须**说得出「随时」那两个入口在哪（T-4.13 量的是他读到的字）。
            我第一版把它折进去了 —— 折叠的判据（D-445）管的是**机制说明**，
            不管「另一条路在哪」。后者是出路，出路不许藏。
        -->
        <summary
          >这是<b>今天的推荐</b>，不是限制 —— Lecture 页上、或侧边栏右键任意项目 / 单元，
          都能<b>随时认读</b>、<b>随时练习</b></summary
        >
        <p>
          你定条数，系统按到期次序凑 Lecture。<b>Lecture 永远整取</b>，实际条数会有出入。
          不到期也能练，练了照样算数。
        </p>
      </details>
    </section>

    <!-- ══ 副列 · 参考，不是指令（S1：不做成一排卡片）══ -->
    <aside class="tside">
      {#if resume}
        <div class="tblk" data-testid="home-hero">
          <div class="secthead">
            <span class="en">Resume</span><span class="zh">接着上次</span>
          </div>
          <div class="rn">{resume.name}</div>
          <div class="mt">
            {#if resume.status === 'review'}
              <b>还停在待审阅</b> —— 看一眼、删掉不要的，然后就能开始学
            {:else}
              {resume.itemCount} 条知识点
            {/if}
          </div>
          <div class="hrow">
            <button class="lnk" data-testid="home-resume" onclick={() => onopen(resume.id)}
              >回到这里 ›</button
            >
            <!--
              ★ D-484 · B-1 的目标之二（I-190）：库**非空**时，Today 上的贴入口是这颗。
                空库时是首屏那颗「开始」（`home-start-btn`，在 App.svelte）——
                两颗同时只会有一颗在屏上，所以两颗都打标记，哪颗在就指哪颗。
            -->
            <button class="btn sm" data-testid="home-new" data-guide="today-paste" onclick={onstart}
              >贴一段新的</button
            >
          </div>
        </div>
      {/if}

      <!-- 攻坚区上首页 · D-042：它是待办不是资料库。I-058 · 整块可点 -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="tblk hard"
        data-testid="hard-card"
        role="button"
        tabindex="0"
        onclick={onhard}
        onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onhard()}
      >
        <div class="secthead">
          <span class="en">Hard</span><span class="zh">攻坚区</span>
          {#if view.hard.length > 0}<span class="n">{view.hard.length}</span>{/if}
        </div>
        <div class="s2">练了 5 次仍没做到 3 连正确，已从原 Lecture 移出。</div>
        {#if view.hard.length === 0}
          <div class="dim tempty">空的。这是好事 —— 没有卡住的知识点。</div>
        {:else}
          {#each view.hard.slice(0, 3) as h (h.id)}
            <div class="row-read hit"><span class="t">{h.term}</span><span class="w">{h.attempts} 次</span></div>
          {/each}
          <div class="hrow">
            <button class="lnk" data-testid="goto-hard" onclick={onhard}
              >全部 {view.hard.length} 条 ›</button
            >
          </div>
        {/if}
      </div>
    </aside>
  </div>

  <!-- D-008 / U-002 · 报告的**唯一**入口（侧栏那一条已撤）。
       D-456：它回答「我整体怎么样」—— 最不紧急的那个问题，位置就在最下。
       ★ Navigation 形态（文字 + `›`），不是按钮里再套一颗按钮。 -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="rbar"
    role="button"
    tabindex="0"
    data-testid="home-report"
    onclick={ongotoReport}
    onkeydown={(e) => e.key === 'Enter' && ongotoReport()}
  >
    <div>
      <div class="tt">分析报告</div>
      <div class="ss">核心结论 → 详细数据 → 需要时再深入</div>
    </div>
    <span class="car">›</span>
  </div>
  </div>
{/if}
