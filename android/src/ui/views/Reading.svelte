<script lang="ts">
  /**
   * 认读卡（屏 7 · ④/④b 帧为验收样）—— D-390 四条 Windows 逻辑必守：
   *   ① 正面只有挖空句 + 英文线索（GLOSS/NUANCE）——没有 term、没有中文、
   *      没有喇叭（提前露答案 = 违例）
   *   ② 中文 = 答案不是线索（I-083）：warn 揭示件、代价写在件上，点开当场封顶
   *      「想了一下」，判分表的天数跟着改按封顶档显示（按钮上必须是真数 D-136）
   *   ③ 喇叭只在背面（D-094：翻卡前读 = 念答案）
   *   ④ 日上限 40（D-229 软上限，超出自动顺延 —— 队列自然只装 40）
   * 判分 = core sm2-item（同一份）；作答时长静默采集（D-349）。
   * 键盘 1234 不做 —— 手机没有键盘，四格就是四键。
   */
  import { untrack } from 'svelte'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import { store } from '../lib/store.svelte.ts'
  import { speak } from '../../db/tts.ts'
  import { practice } from '../lib/practice.svelte.ts'
  import {
    READING_GRADE_NAMES,
    READING_CAP_GRADE,
    READING_QTYPE_FACTORY,
    QUIZ_RULE_KEYS,
    SILENCE_FILTER_NAME,
    capReadingGrade,
    matchesTerm,
    readingQTypeOf,
    type ReadingGrade,
    type ReadingQType
  } from '../../core-link.ts'
  import { prefReader } from '../../db/prefs.ts'
  import { dueCards, gradeCard, testCardsByIds, type CardRow } from '../../db/reading.ts'
  import { readingFace, type ReadingFace } from '../../db/lookup.ts'

  let { lectureId = null, ids = null }: { lectureId?: number | null; ids?: number[] | null } =
    $props()

  type View = { k: 'loading' } | { k: 'empty' } | { k: 'card' } | { k: 'done' } | { k: 'error'; m: string }
  let view = $state<View>({ k: 'loading' })
  let queue = $state<CardRow[]>([])
  let at = $state(0)
  let flipped = $state(false)
  /** 看过中文之后，最高只能给到第 2 档（想了一下）· I-083 */
  let peeked = $state(false)
  /**
   * ★★★ 那个封顶档**不再写在这里**（D-486）。
   *   原来是 `const PEEK_CAP: ReadingGrade = 2`，而 core 那边为「限时到点」
   *   又写了一个 2 —— 两处各写一个，哪天改一处另一处不动，
   *   **而两处都说得通、都不报错**。现在只有 `core/quiz-rules.ts` 那一份：
   *   `capReadingGrade(grade, { peeked, timedOut })` · `READING_CAP_GRADE`。
   *   「看过中文」和「超时」是同一条判据的两个触发：提前拿到了帮助，这一次不算到第 3 档。
   */

  // ══ D-486 · 认读题型三档（`reading.qtype`）════════════════════
  /** 出厂 `flip`（翻卡自评）。读不到 / 认不出由 core 回出厂，这一层不兜 */
  let qtype = $state<ReadingQType>(READING_QTYPE_FACTORY)
  /** `write`「先写再翻」：他先写出想到的那个词，翻开时逐字对一下 */
  let typed = $state('')
  /** `timed`「限时认读」：到点自动翻开，并且这一次封顶第 2 档 */
  let timedOut = $state(false)
  let leftMs = $state(0)
  let timer: ReturnType<typeof setInterval> | null = null
  /** 倒计时长度。★ 出厂 20 秒是我提的（D-413），不是他定的判据 —— 待他看过再说 */
  const TIMED_MS = 20_000
  let graded = $state(0)
  let silencedTerms = $state<string[]>([])
  let note = $state<string | null>(null)
  let shownAt = Date.now()

  const testMode = ids !== null

  async function load(): Promise<void> {
    if (store.db.k !== 'ok') return
    view = { k: 'loading' }
    try {
      queue = testMode
        ? await testCardsByIds(store.db.db, ids ?? [])
        : // D-229 · 每日软上限 40，超出自动顺延
          await dueCards(store.db.db, lectureId, 40)
      at = 0
      flipped = false
      peeked = false
      qtype = readingQTypeOf(await prefReader(store.db.db, [QUIZ_RULE_KEYS.readingQType]))
      resetPerCard()
      shownAt = Date.now()
      view = queue.length === 0 ? { k: 'empty' } : { k: 'card' }
    } catch (e) {
      view = { k: 'error', m: (e as Error)?.message ?? String(e) }
    }
  }
  $effect(() => {
    untrack(() => {
      void load()
    })
  })

  /**
   * 每翻到新的一张要清掉的那几样。
   * ★ 抽出来是因为它有**三个调用点**（进队列 / 判完下一张 / 重新加载），
   *   散写三份的话早晚有一处漏掉 `timedOut`，那一张就会被上一张的超时连累封顶，
   *   而屏幕上什么都不会说。
   */
  function resetPerCard(): void {
    typed = ''
    timedOut = false
    stopTimer()
    if (qtype === 'timed') startTimer()
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer)
    timer = null
    leftMs = 0
  }

  /**
   * ★★ 到点**自动翻开并封顶第 2 档**，而且**当场说清**（D-486 · 沿 I-083 那条先例：
   *   诚实降档，不偷偷扣）。不说的话他会在结算时才发现间隔不对，
   *   然后以为是排期算错了。
   */
  function startTimer(): void {
    const end = Date.now() + TIMED_MS
    leftMs = TIMED_MS
    timer = setInterval(() => {
      leftMs = Math.max(0, end - Date.now())
      if (leftMs === 0) {
        stopTimer()
        timedOut = true
        flipped = true
      }
    }, 100)
  }

  const close = (): void => {
    stopTimer()
    practice.open = null
  }
  // 返回 = 退出练习（判过的都已逐张落库，没有半截事务）
  $effect(() => registerBack(() => (close(), true)))

  const cur = $derived(queue[at] ?? null)

  /**
   * ★★ AI 牌面（⑤/使用者「我说的就是牌面的 ai」）——「AI 决定这张卡怎么考」。
   *
   * 提示词 = `prompt.reading-card`（Settings › Prompt 可改），管的是**题面本身**，
   * 不是翻开之后的解释。三种形式：挖空 / 中译回想 / 场景补全。
   *
   * ★ 它永远不许挡路（D-338）：先把机械挖空摆上去，AI 回来了才换。
   *   **提前一张预取** —— 看这张的时候下一张已经在路上，所以实际上看不到「换」。
   * ★ 没配 AI / 超时 / 露了答案（D-390）—— 一律安静退回机械挖空，不报错不提示。
   * ★ 牌面上如实标「AI · 形式」：这句话是机器编的，不是他自己的原文（诚实原则）。
   */
  let faces = $state<Record<number, ReadingFace | null>>({})

  async function fetchFace(c: CardRow | undefined): Promise<void> {
    if (!c || store.db.k !== 'ok') return
    if (c.id in faces) return // 要过了就不再要（失败的那张也算要过，别死循环）
    faces[c.id] = null
    // ★ 末位 `c.id`：R-1「轮着来」按知识点记「上次用了哪一面」（D-482），不给就不轮转
    const f = await readingFace(store.db.db, c.term, c.glossZh || c.gloss, c.quote, c.id)
    if (f) faces[c.id] = f
  }

  const face = $derived(cur ? (faces[cur.id] ?? null) : null)
  /**
   * 「中译回想」这一型，牌面本身就是中文 —— 那是**题**不是偷看，所以不封顶（I-083
   * 封的是「答不上来去翻中文」那一下）。但下面那颗「中文」按钮要收起来：
   * 中文已经在屏幕上了还请他再点一次，那是句假话。
   */
  const faceZh = $derived(!!face && /[一-鿿]/.test(face.text))

  // 预取：当前 + 下一张
  $effect(() => {
    const a = at
    const q = queue
    untrack(() => {
      void fetchFace(q[a])
      void fetchFace(q[a + 1])
    })
  })

  /**
   * 挖空：摘句里把词条本体挖掉。
   * ★ 第十一则指令（认读卡空白的根因）：**整句收进来的词条 term ≈ quote**，
   *   挖掉后 before/after 全空 —— 正面只剩一条空横线，看起来就是空卡。
   *   Windows Reading.svelte 是同款缺陷（已记档待同修）。
   *   退化判定：挖完两头都没有实义字符 → 按「整句条目」形态走（正面不露
   *   答案，如实说这条收的是整句，凭线索回忆 —— 不发明新判分机制）。
   */
  function cloze(c: CardRow): { before: string; after: string } | null {
    if (!c.quote) return null
    const i = c.quote.toLowerCase().indexOf(c.term.toLowerCase())
    if (i < 0) return null
    const before = c.quote.slice(0, i)
    const after = c.quote.slice(i + c.term.length)
    if (!/[A-Za-z0-9一-鿿]/.test(before + after)) return null // 整句条目 → 退化
    return { before, after }
  }
  /** 正面无挖空时的如实话术：分「没摘句」与「整句条目」两种，不混为一谈 */
  function frontNote(c: CardRow): string {
    if (!c.quote) return '（这条没有原文摘句）'
    return '（这条收的是整句 —— 凭下面的线索回忆它，翻开对照）'
  }
  /** 背面：原句回填高亮，闭环确认 */
  function mark(c: CardRow): { pre: string; hit: string; post: string } | null {
    if (!c.quote) return null
    const i = c.quote.toLowerCase().indexOf(c.term.toLowerCase())
    if (i < 0) return null
    return { pre: c.quote.slice(0, i), hit: c.quote.slice(i, i + c.term.length), post: c.quote.slice(i + c.term.length) }
  }

  async function grade(g: ReadingGrade): Promise<void> {
    const c = cur
    if (!c || store.db.k !== 'ok') return
    try {
      // 看过中文就封顶 —— 四格同一条路（I-083）
      // ★ 封顶判据只有 core 那一份（看过中文 / 超时，同一条）
      const eff = capReadingGrade(g, { peeked, timedOut }) as ReadingGrade
      const r = await gradeCard(store.db.db, c.id, eff, Date.now() - shownAt)
      if (r.silenced) silencedTerms = [...silencedTerms, c.term]
      graded += 1
      flipped = false
      peeked = false
      resetPerCard()
      shownAt = Date.now()
      if (at + 1 < queue.length) at += 1
      else {
        view = { k: 'done' }
        await store.reloadCounts()
      }
    } catch (e) {
      note = `这一张没记上：${(e as Error)?.message ?? e}`
    }
  }

  /** I-083 · 封顶时四格显示的天数：高档格写的是封顶档真会发生的数 */
  /** I-083 · 封顶时四格显示的天数：高档格写的是封顶档**真会发生**的数（D-136） */
  const shownDays = (c: CardRow, g: ReadingGrade): number =>
    c.intervals[capReadingGrade(g, { peeked, timedOut }) as ReadingGrade]
  /** 这一格现在会不会被封顶 —— 四格的记号与天数都按它显示 */
  const cappedNow = (g: ReadingGrade): boolean =>
    capReadingGrade(g, { peeked, timedOut }) !== g

  const crumbTag = testMode ? 'TEST' : lectureId ? `L${lectureId}` : 'DUE'
  const GRADES: ReadingGrade[] = [1, 2, 3, 4]
</script>

<div class="view stage">
  <!-- ★ 练习是全屏浮层（压过 Tab）：屏顶只留**坐标 + 出口**，
       不给标题 —— 这一屏的主角是卡片本身。 -->
  <div class="top">
    <span class="dt">READING{#if view.k === 'card'}&nbsp;· {at + 1}/{queue.length}{/if}&nbsp;· {crumbTag}</span>
    <button class="ibtn sm" aria-label="退出练习" onclick={close}>
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-close" /></svg>
    </button>
  </div>

  {#if note}<div class="note" role="status">{note}</div>{/if}

  {#if view.k === 'loading'}
    <!-- ★ Loading 统一形态（2026-09-01）：卡的骨架先在，占的正是内容将要占的位置，
         出现的那一刻不跳版。转圈说「等着」，骨架说「东西会长在这里」。 -->
    <div class="pstage">
      <div class="pcard breathe">
        <div class="sk w90"></div><div class="sk w70"></div><div class="sk w45"></div>
      </div>
      <div class="loadline">正在取到期的卡</div>
    </div>
  {:else if view.k === 'error'}
    <div class="empty tight"><div class="t zh2">认读出问题了</div><div class="s">{view.m}</div></div>
  {:else if view.k === 'empty'}
    <div class="empty tight">
      <div class="t zh2">{testMode ? '这批里没有可测的卡' : '今天没有到期的卡'}</div>
      {#if !testMode}<div class="s">到期的都练完了 —— 排期会把明天的送来。</div>{/if}
      <button class="btn center" onclick={close}><span class="zh">回去</span></button>
    </div>
  {:else if view.k === 'done'}
    <div class="empty tight">
      <div class="t zh2">练完了 · {graded} 张</div>
      {#if silencedTerms.length > 0}
        <div class="s">这几条通过了全部检验，进了{SILENCE_FILTER_NAME}：<br />{silencedTerms.join('、')}</div>
      {/if}
      <button class="btn center" onclick={close}><span class="zh">回去</span></button>
      {#if !testMode}
        <button class="pill" style:margin-top="10px" onclick={() => void load()}>再看看有没有到期的</button>
      {/if}
    </div>
  {:else if cur}
    {@const c = cur}
    <!-- ★★ 卡本体（2026-09-01）：此前内容直接躺在页面背景上，全挤在上三分之一，
         下面三分之二整片空白。现在是**页面 --bg → 卡 --paper**（§10.2 两层往亮走），
         .pstage 用 flex 把它顶到视觉重心。 -->
    <div class="pstage">
      {#if !flipped}
        <!-- ④ 正面：挖空句 + 英文线索。没有 term、没有中文、没有喇叭（D-390） -->
        <div class="pcard">
          <div class="rquote">
            {#if face}
              {face.text}
            {:else if cloze(c)}
              {@const cz = cloze(c)!}
              “{cz.before}<span class="blank"></span>{cz.after}”
            {:else}
              <span class="dim">{frontNote(c)}</span><span class="blank"></span>
            {/if}
          </div>

          <!-- ★ 线索整块只在**真有线索**时出现（DS §10.2e②：数是 0 的入口不出现）。
               此前 GLOSS 是「—」时照样占三行，说的是「没有线索」。
               没有线索的卡本来就该只有一句挖空句。 -->
          {#if face}
            <!-- 诚实：这句话是机器编的，不是他自己的原文 -->
            <div class="fform">AI · {face.form}</div>
          {/if}

          {#if c.gloss || c.nuance || c.glossZh}
            <div class="clues">
              {#if c.gloss}
                <div class="clue-k">GLOSS</div>
                <div class="clue-v">{c.gloss}</div>
              {/if}
              {#if c.nuance}
                <div class="clue-k">NUANCE</div>
                <div class="clue-v nu">{c.nuance}</div>
              {/if}
              {#if c.glossZh && !faceZh}
                {#if peeked}
                  <span class="zh-full">{c.glossZh}</span>
                {:else}
                  <!-- I-083 · 中文=答案：代价写在件上，点开当场封顶 -->
                  <button class="zh-reveal warn" onclick={() => (peeked = true)}>
                    中文 · 看了这张最高按「想了一下」算
                    <svg class="ic" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
                  </button>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <!-- ④b 背面：词条 + 喇叭（D-094 只在这面）+ 原句 -->
        <div class="pcard">
          <div class="rcenter">
            <div class="rterm">{c.term}</div>
            <!-- ★ 喇叭独占一行：此前跟在词条最后一个词旁边，换行后像词的一部分 -->
            <div class="rspk">
              <button class="rb" aria-label="朗读"
                onclick={() => { if (store.db.k === 'ok') void speak(store.db.db, c.term).then((n) => { if (n) note = n }) }}>
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-speak" /></svg>
              </button>
            </div>
            {#if c.gloss}<div class="clue-v" style:margin="9px 0 0">{c.gloss}</div>{/if}
            {#if c.glossZh}
              {#if peeked}
                <span class="zh-full">{c.glossZh}</span>
              {:else}
                <!-- 已经翻卡了 —— 这里点开不再降档（与详情同一揭示件） -->
                <button class="zh-reveal" onclick={() => (peeked = true)}>中文
                  <svg class="ic" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
                </button>
              {/if}
            {/if}
          </div>
          {#if mark(c)}
            {@const m = mark(c)!}
            <div class="rquote small" style:border-top="1px solid var(--line)" style:padding-top="12px" style:margin-top="14px">
              “{m.pre}<span class="mk">{m.hit}</span>{m.post}”
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if !flipped}
      <!-- ══ D-486 · 题型三档在这一屏的差别 ══════════════════════
           `flip`  原样（看题面想一想 → 翻开）
           `write` 翻开前先写出想到的那个词 —— **不调 AI**，翻开时逐字对
           `timed` 倒计时，到点自动翻开并封顶第 2 档
           ★ 三档共用同一套判分与排期，差的只是「他在翻开之前做什么」。 -->
      {#if qtype === 'write'}
        <!-- ★ 不自动聚焦：手机上弹键盘会把题面顶出视野，而他要先看题面 -->
        <input class="wbox zh" bind:value={typed} placeholder="先写出你想到的那个词" />
      {/if}
      {#if qtype === 'timed'}
        <!-- ★ 说清代价：到点会发生什么、这一次最高记到哪一档，都写在脸上（D-136 同族） -->
        <div class="tleft">
          <span class="tnum">{Math.ceil(leftMs / 1000)}</span>
          <span class="zh">秒后自动翻开 —— 这一次最高记到「{READING_GRADE_NAMES[READING_CAP_GRADE as ReadingGrade]}」</span>
        </div>
      {/if}
      <div class="pact">
        <button class="btn pri" onclick={() => (stopTimer(), (flipped = true))}><span class="zh">翻开</span></button>
      </div>
    {:else}
      <!-- ★ `write` 翻开之后把他写的那句和答案对一下。**判据在 core**（`matchesTerm`）：
           大小写 / 标点 / 多余空格不算错，词形变化两个方向都认。
           ★★ 这里**只说对没对，不改判分** —— 判分仍然是他自己点那四格（D-486：
             `write` 不调 AI、不写 answers、错了不降档）。多写一句「对了」是给他一个对照，
             不是替他打分；替他打分就等于凭一个逐字比对改了排期。 -->
      {#if qtype === 'write' && typed.trim()}
        <div class="wcmp" class:ok={matchesTerm(typed, c.term)}>
          <span class="zh">你写的：{typed.trim()}</span>
          <span class="zh">{matchesTerm(typed, c.term) ? '对上了' : '和答案不一样 —— 自己判这一次算哪一档'}</span>
        </div>
      {/if}
      {#if timedOut}
        <div class="wcmp"><span class="zh">超时了 —— 这一次最高记到「{READING_GRADE_NAMES[READING_CAP_GRADE as ReadingGrade]}」</span></div>
      {/if}
      <!-- ★★ 判分四格补上那三枚记号（D-341 · 2026-09-01）：
           四条非颜色通道里的「形」此前**只在结果页出现，选的时候看不到** ——
           按下去的那一刻只剩三条。记号本身早就画好了，这里是把它们
           放到该被看见的那一刻。 -->
      <div class="gtab">
        {#each GRADES as g (g)}
          <button class:capped={cappedNow(g)} onclick={() => void grade(g)}>
            <svg class="gm" viewBox="0 0 24 24" aria-hidden="true">
              <use href={g === 4 ? '#nyx-grade-ok' : g === 3 ? '#nyx-grade-near' : '#nyx-grade-again-s'} />
            </svg>
            <b>{READING_GRADE_NAMES[g]}</b>
            <span class="d">{shownDays(c, g)} D</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
