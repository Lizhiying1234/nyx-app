<script lang="ts">
  /**
   * 产出题（屏 7 · ⑤/⑥/⑦ 帧为验收样）。
   *
   * ══ 机制（全在 db/practice.ts 港来的那条链上）═══════════════
   *   出题：ensureQuestions（D-129 缺了才生成，light 槽）→ nextQuestion
   *  （当前档优先 + 换个题型）；判分：score-answer 提示词 + heavy 槽 +
   *   temperature 0（I-069 可复现）；**只有第一次提交推进进度**（D-121）；
   *   过关才给范文（D-122）；批注落在你自己的句子上（D-120）；
   *   「提示」= 分类器：判分不受影响，但记一次认读失败（D-138）。
   *   结算：讲次 SM-2 推进 + finished_at（幂等）。
   *
   * ★ 判分文案 = core GRADE_NAMES（用错/可懂但不地道/准确得体/分寸到位）。
   * ★ ⑦ 结算只给状态与内容：每讲下次天数 + 机制原话 · 进攻坚/已静默的**词条本身**·
   *   认读出口 —— 正确率/分布**不上屏**（D-348；机制内部照算）。
   * ★ 练完自动上传（D-249）：开着就顺手 run 一次同步，结果如实回显。
   */
  import { untrack } from 'svelte'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import { store } from '../lib/store.svelte.ts'
  import { practice } from '../lib/practice.svelte.ts'
  import {
    GRADE_NAMES,
    PRACTICE_FACE_FACTORY,
    QUIZ_RULE_KEYS,
    SILENCE_FILTER_NAME,
    practiceFaceOf,
    type Failure,
    type PracticeFace
  } from '../../core-link.ts'
  import { prefReader } from '../../db/prefs.ts'
  import {
    ensureQuestions,
    nextQuestion,
    productionQueueMany,
    queueByIds,
    settleLectures,
    startSession,
    submitAnswer,
    usedHint,
    type GradeResult,
    type QueueItem,
    type QuestionRow,
    type Settlement
  } from '../../db/practice.ts'
  import { autoAfterPractice, runSyncAuto } from '../../db/sync.ts'
  import { checkDataSafety } from '../../db/notify.ts'

  let { lectureIds = null, ids = null }: { lectureIds?: number[] | null; ids?: number[] | null } =
    $props()

  type View =
    | { k: 'loading'; note: string }
    | { k: 'empty' }
    | { k: 'question' }
    | { k: 'settle'; s: Settlement; uploaded: string | null }
    | { k: 'error'; m: string; failure: Failure | null }
  let view = $state<View>({ k: 'loading', note: '正在准备题目…' })
  let queue = $state<QueueItem[]>([])
  let at = $state(0)
  let q = $state<QuestionRow | null>(null)
  let answer = $state('')
  let result = $state<GradeResult | null>(null)
  let isFirst = $state(true)
  let hinted = $state(false)
  let hintText = $state<string | null>(null)
  let refOpen = $state(false)
  /**
   * ══ D-486 · 产出牌面三档（`practice.face`）════════════════════
   *   `plain` 整块 —— 原样（题面一整块，答完从上往下看）
   *   `split` 分栏 —— 答完把他写的和参考答案**并排**
   *   `focus` 专注 —— 进题只留任务与输入框，答完再把其余推回来
   * ★ 三档只改**怎么摆**，不改判分、不改排期、不改出题，也**不给 AI 多说一个字**
   *   （确认单：牌面不加任何 AI 侧信息）。所以这一屏之外一处都不用动。
   * ★ 出厂 `plain`；读不到 / 认不出由 core 回出厂，这一层不兜。
   */
  let pface = $state<PracticeFace>(PRACTICE_FACE_FACTORY)
  let busy = $state(false)
  let sessionId = $state<number | null>(null)
  let shownAt = Date.now()

  const scopeLectures = lectureIds ?? []

  const close = (): void => {
    practice.open = null
  }
  $effect(() => registerBack(() => (close(), true)))

  function cleanMessage(e: unknown): string {
    return (e as Error)?.message ?? String(e)
  }
  function failureOf(e: unknown): Failure | null {
    const f = (e as { failure?: Failure })?.failure
    return f && typeof f === 'object' && 'kind' in f ? f : null
  }

  async function start(): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    try {
      queue = ids ? await queueByIds(db, ids) : await productionQueueMany(db, scopeLectures)
      if (queue.length === 0) {
        view = { k: 'empty' }
        return
      }
      // sessions 的唯一创建者（D-349 rules 快照随行）
      sessionId = await startSession(db, 'production', ids ? 'picked' : 'lecture', queue.length)
      at = 0
      await loadQuestion()
    } catch (e) {
      view = { k: 'error', m: cleanMessage(e), failure: failureOf(e) }
    }
  }
  $effect(() => {
    untrack(() => {
      void start()
    })
  })

  const cur = $derived(queue[at] ?? null)

  async function loadQuestion(): Promise<void> {
    const it = cur
    if (!it || store.db.k !== 'ok') return
    const db = store.db.db
    view = { k: 'loading', note: `正在给「${it.term}」准备题目…` }
    q = null // I-091：不清就整轮同一道题
    answer = ''
    result = null
    isFirst = true
    hinted = false
    hintText = null
    refOpen = false
    if (store.db.k === 'ok') {
      pface = practiceFaceOf(await prefReader(store.db.db, [QUIZ_RULE_KEYS.practiceFace]))
    }
    try {
      // D-129 · 缺了才生成；生成过就完全离线
      await ensureQuestions(db, it.id)
      q = await nextQuestion(db, it.id)
      if (!q) {
        // 题都用完了就跳过这一条，别让整轮卡死
        at += 1
        if (at >= queue.length) await settle()
        else await loadQuestion()
        return
      }
      shownAt = Date.now()
      view = { k: 'question' }
    } catch (e) {
      view = { k: 'error', m: cleanMessage(e), failure: failureOf(e) }
    }
  }

  async function submit(): Promise<void> {
    const it = cur
    if (!it || !q || store.db.k !== 'ok') return
    if (!answer.trim() || busy) return
    busy = true
    try {
      const r = await submitAnswer(
        store.db.db,
        sessionId,
        it.id,
        q.id,
        answer,
        isFirst,
        hinted,
        Date.now() - shownAt
      )
      result = r
      if (isFirst) isFirst = false
      view = { k: 'question' }
    } catch (e) {
      view = { k: 'error', m: cleanMessage(e), failure: failureOf(e) }
    } finally {
      busy = false
    }
  }

  async function hint(): Promise<void> {
    const it = cur
    if (!it || store.db.k !== 'ok' || hinted) return
    try {
      // D-138 · 提示 = 分类器：给释义，但记一次认读失败
      const r = await usedHint(store.db.db, it.id)
      hinted = true
      hintText = r.gloss
    } catch (e) {
      hintText = cleanMessage(e)
    }
  }

  async function next(): Promise<void> {
    if (busy) return
    busy = true
    try {
      at += 1
      if (at >= queue.length) await settle()
      else await loadQuestion()
    } finally {
      busy = false
    }
  }

  async function settle(): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    view = { k: 'loading', note: '正在结算…' }
    try {
      const s = await settleLectures(db, scopeLectures, sessionId)
      let uploaded: string | null = null
      // D-249 · 练完自动上传：开着就顺手同步；失败如实说，不拦结算
      if (await autoAfterPractice(db)) {
        try {
          // ★ T-2.1 · 与前台、后台同一个入口；另一处正在同步就跳过这一趟（不说假话，D-412）
          const r = await runSyncAuto(db, '练完自动上传')
          const d = new Date()
          uploaded = r.ran
            ? `✓ UPLOADED · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}（推 ${r.pushed} 行）`
            : `这一趟没传：${r.note} —— 记录都在本机，稍后可在设置里手动同步`
        } catch (e) {
          uploaded = `上传没写成：${cleanMessage(e)} —— 记录都在本机，稍后可在设置里手动同步`
        }
        void checkDataSafety(db) // D-373 · 连败攒够了就在这台手机上说话（判据在 db/notify.ts）
      }
      await store.reloadCounts()
      view = { k: 'settle', s, uploaded }
    } catch (e) {
      view = { k: 'error', m: cleanMessage(e), failure: failureOf(e) }
    }
  }

  /** 批注切片（D-120 · 标在你自己的句子上） */
  function marked(text: string, anns: GradeResult['annotations']): { t: string; bad: boolean }[] {
    let segs: { t: string; bad: boolean }[] = [{ t: text, bad: false }]
    for (const a of anns) {
      const nextSegs: typeof segs = []
      for (const s of segs) {
        if (s.bad) {
          nextSegs.push(s)
          continue
        }
        const i = s.t.indexOf(a.span)
        if (i < 0) {
          nextSegs.push(s)
          continue
        }
        if (i > 0) nextSegs.push({ t: s.t.slice(0, i), bad: false })
        nextSegs.push({ t: a.span, bad: true })
        if (i + a.span.length < s.t.length) nextSegs.push({ t: s.t.slice(i + a.span.length), bad: false })
      }
      segs = nextSegs
    }
    return segs
  }

  /** §五 判分编码：4 实心 · 3 半实心（空心+内嵌实心，同一条路径）· 1/2 空心+赭石 */
  const pipsOf = (grade: number): boolean[] => {
    const filled = [0, 1, 3, 4][grade - 1] ?? 0
    return [0, 1, 2, 3].map((i) => i < filled)
  }
</script>

<div class="view stage">
  <!-- ★ 练习是全屏浮层（压过 Tab）：屏顶只留**坐标 + 出口**，
       不给标题 —— 这一屏的主角是卡片本身。 -->
  <div class="top">
    <span class="dt">{#if view.k === 'settle'}SESSION DONE · {view.s.sample}{:else}PRODUCTION{#if view.k === 'question' && q}&nbsp;· {at + 1}/{queue.length} · {q.type}{/if}{/if}</span>
    <button class="ibtn sm" aria-label="退出练习" onclick={close}>
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-close" /></svg>
    </button>
  </div>

  {#if view.k === 'loading'}
    <!-- ★ Loading 统一形态（2026-09-01）：此前整屏只有一句话孤零零挂在上方，
         没有任何「正在发生」的迹象。骨架说的是**「东西会长在这里」**，
         而且它占的正是内容将要占的位置 —— 出现的那一刻不跳版。 -->
    <div class="pstage">
      <div class="pcard breathe">
        <div class="sk w90"></div><div class="sk w70"></div><div class="sk w45"></div>
      </div>
      <div class="loadline">{view.note}</div>
    </div>
  {:else if view.k === 'empty'}
    <div class="empty tight">
      <div class="t zh2">这批里没有可练的条目</div>
      <div class="s">产出练写作层（B）里还在训练中的 —— {SILENCE_FILTER_NAME}的和句子不进这条线。</div>
      <button class="btn center" onclick={close}><span class="zh">回去</span></button>
    </div>
  {:else if view.k === 'error'}
    <div class="empty tight">
      <div class="t zh2">{view.failure?.title ?? '练习出问题了'}</div>
      <div class="s" style:white-space="pre-line">{view.failure?.detail ?? view.m}</div>
      <div class="pillrow" style:justify-content="center" style:margin-top="12px">
        <button class="pill" onclick={() => void loadQuestion()}>重试</button>
        <button class="pill" onclick={close}>先退出</button>
      </div>
    </div>
  {:else if view.k === 'settle'}
    {@const s = view.s}
    <div class="set mt3" style:border-top="none">
      {#each s.perLecture as l (l.lectureId)}
        <div class="li">
          <span class="g">
            <span class="zh s14">{l.name}</span>
            <small class="zh">下次产出 {l.nextDays} 天后 —— {l.reason}</small>
          </span>
        </div>
      {/each}
    </div>
    {#if s.hard.length > 0}
      <div class="m blk zh">进攻坚：{s.hard.join('、')}</div>
    {/if}
    {#if s.silenced.length > 0}
      <div class="m blk zh">通过全部检验，进了{SILENCE_FILTER_NAME}：{s.silenced.join('、')}</div>
    {/if}
    {#if s.dueReadingCount > 0}
      <!-- F-05 · 两条线的接口 -->
      <button
        class="li sunkli"
        style:width="100%"
        onclick={() => (practice.open = { kind: 'reading' })}
      >
        <span class="g"><span class="zh s12">还有 {s.dueReadingCount} 张认读卡今天到期</span></span>
        <span class="tag t-v">去认读 ›</span>
      </button>
    {/if}
    {#if view.uploaded}
      <div class="m blk zh">{view.uploaded}</div>
    {/if}
    <button class="btn" style:margin-top="14px" onclick={close}>
      <span class="zh">回工作台</span>
    </button>
  {:else if cur && q}
    <div class="pwrap" class:pfocus={pface === 'focus' && !result}>
    <!-- ★ 题面与作答区进同一张卡（§10.2 两层往亮走）：
         此前两者直接躺在页面背景上，题目与你写的字之间没有边界。 -->
    <!-- ★★ `focus`：答题时把其余推走，答完再回来。
         ★★★ 这个 class 必须挂在**外层**，不是 `.pcard` 上 —— `.pcard` 里本来就
           只有「任务 + 输入框」，往它身上挂等于什么都不推。**上机才看出来的**：
           CSS 写好了、class 也挂了，屏上却一点变化都没有，因为要推走的那几块
           全在这张卡**外面**。 -->
    <div class="pcard">
      <div class="pquote">{q.prompt}</div>
      <textarea
        class="paper-ta"
        bind:value={answer}
        readonly={!!result && result.passed}
        placeholder=""
      ></textarea>
    </div>

    {#if hintText}
      <div class="note" role="status">提示 · {hintText}{#if hinted}（已记一次认读失败）{/if}</div>
    {/if}

    {#if !result}
      <div class="prow">
        <!-- D-138 · 代价写在脸上
             ★ `fadeaway`：`focus` 那一档答题时把它推走 —— 它是「其余」那一类。
               ★★ 但「提交」**不推**：推走出口等于让他出不去。 -->
        <!-- ★ `practice-hint-cost`（清单 16）的靶子就是这颗键本身：它讲的是**按下去的代价**
             （记一次没答上来、间隔打回，D-138）。挂在别处就成了指着一个东西说另一件事。
             ★ 它在 `{#if !result}` 里 = 只在作答时在 —— 而那正是这句话唯一有意义的时刻；
               结算屏那一半由 `practice-settle` 管（本页两条，CR-3 每页 ≤ 2）。 -->
        <button class="hintbtn zh fadeaway" data-guide="practice-hint-cost" onclick={() => void hint()}>提示 · 记一次认读失败</button>
        <button class="pill v" disabled={busy || !answer.trim()} onclick={() => void submit()}>
          {busy ? '判分中…' : '提交'}
        </button>
      </div>
    {:else}
      {@const r = result}
      <!-- ★★ B-5 · 页面引导第二层的锚点（`data-guide`）。
           id 与 C 约定：`practice-settle`，**跟代码那条路走**（结算在
           `db/practice.ts::settleLectures`），不跟屏上的词走 —— 词会改，路不会。
           ★ 这一块在 `{#if !result}{:else}` 里，答完一题才挂载，而每出一道新题
             都会 `result = null` 卸载重挂（一次练习 15 道 = 15 次）。
             引导那侧按「元素挂载」触发并同一拍写 `seen`，否则第 2 题会再弹一次。 -->
      <div class="verdict" data-guide="practice-settle">
        <span class="vstar" class:again={r.grade <= 2}>
          {#if r.grade === 4}
            <!-- ★ 判分三枚终于落地（此前是拿 nyx-star 现调 stroke 拼的）：
                 会了=核实心+四芒全亮 · 差一点=空心核+45% 内实心**无芒** ·
                 再想想=虚线空心**无芒**。四条非颜色通道原样（D-341）。 -->
            <svg width="44" height="44" viewBox="0 0 24 24" style="color:var(--violet)"><use href="#nyx-grade-ok" /></svg>
          {:else if r.grade === 3}
            <svg width="44" height="44" viewBox="0 0 24 24" style="color:var(--violet)"><use href="#nyx-grade-near" /></svg>
          {:else}
            <svg width="44" height="44" viewBox="0 0 24 24" style="color:var(--warn)"><use href="#nyx-grade-again" /></svg>
          {/if}
        </span>
        <div class="vzh zh" class:w={!r.passed}>{GRADE_NAMES[r.grade as 1 | 2 | 3 | 4]}</div>
        <div class="m" style:margin-top="3px">
          GRADE {r.grade} ·
          <span class="pips">
            {#each pipsOf(r.grade) as on, i (i)}<span class="pip" class:off={!on}></span>{/each}
          </span>
        </div>
        {#if r.why}<div class="vwhy zh">{r.why}</div>{/if}
      </div>

      {#if r.annotations.length > 0}
        <div class="yours">
          <div class="txt">
            {#each marked(answer, r.annotations) as seg, i (i)}
              {#if seg.bad}<span class="wavy">{seg.t}</span>{:else}{seg.t}{/if}
            {/each}
          </div>
          {#each r.annotations as a (a.span)}
            <div class="annot zh">「{a.span}」—— {a.problem}{#if a.fix}；更贴：{a.fix}{/if}</div>
          {/each}
        </div>
      {/if}

      <!-- ★ `split` 分栏：过关且有参考答案时，把**他写的**和**参考答案**并排放。
           ★★ 这一轮是**零数据**的并排回看 —— 不新增任何列，只把已经有的两段
             摆成两栏（确认单：`given` 列排下次装机批）。窄屏（<360）自动退回一栏。 -->
      {#if pface === 'split' && r.passed && r.reference}
        <div class="psplit" style:margin-top="8px">
          <div>
            <span class="lab tight">YOURS</span>
            <div class="clue-v" style:margin-top="6px">{answer}</div>
          </div>
          <div>
            <span class="lab tight">REFERENCE</span>
            <div class="clue-v" style:margin-top="6px">{r.reference}</div>
          </div>
        </div>
        <button class="btn pri" style:margin-top="8px" onclick={() => void next()}>
          <span class="zh">下一题</span>
        </button>
      {:else if r.passed}
        {#if r.reference}
          <button class="fold" onclick={() => (refOpen = !refOpen)}>
            <span class="lab tight">REFERENCE</span><span class="m">已过关 · {refOpen ? '' : '展开 '}<svg class="ic arr" class:open={refOpen} width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
          </button>
          {#if refOpen}
            <div class="clue-v" style:margin-top="6px">{r.reference}</div>
          {/if}
        {/if}
        <button class="btn pri" style:margin-top="8px" onclick={() => void next()}>
          <span class="zh">下一题</span>
        </button>
      {:else}
        <!-- 没过关：改一改再交（第二次起不计进度 D-121；范文不给 D-122） -->
        <div class="prow">
          <span class="m zh">改一改再交 —— 这次起不计进度</span>
          <button class="pill v" disabled={busy || !answer.trim()} onclick={() => void submit()}>
            {busy ? '判分中…' : '再交一次'}
          </button>
        </div>
        <button class="btn sec2" style:margin-top="8px" onclick={() => void next()}>
          <span class="zh">先跳过这题</span>
        </button>
      {/if}
    {/if}
  </div>
  {/if}
</div>
