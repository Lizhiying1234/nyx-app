<script lang="ts">
  import { CONTEXT_DISTANCE_NAMES, GRADE_NAMES } from '@core/types.ts'
  import { SILENCE_FILTER_NAME } from '@core/silence.ts'
  import type {
    Failure,
    GradeResult,
    OrderMode,
    PracticeOrder,
    PracticeScope,
    QTypeRow,
    QuestionRow,
    Settlement
  } from '@shared/api.ts'
  import { cleanMessage, parseFailure } from '@shared/api.ts'
  import Ic from './Ic.svelte'
  import { registerEsc } from './esc-stack.svelte.ts'
  /** D-486 之外：AI 写的那几段字怎么显示，判据两端一份 */
  import { emphasisParts } from '@core/ai-text.ts'
  /** D-484 · 第二层引导：页面只说「我这儿碰到了」，出不出不归页面判 */
  import { askGuide } from './guide.svelte.ts'
  /** D-486 · 产出牌面的出厂值与屏上字只有 core 一份（两端同一份）*/
  import { PRACTICE_FACE_FACTORY, type PracticeFace } from '@core/quiz-rules.ts'

  let {
    scope,
    onclose,
    ongotoSettings,
    ongotoReading
  }: {
    scope: PracticeScope
    onclose: () => void
    ongotoSettings?: () => void
    ongotoReading?: () => void
  } = $props()

  /**
   * ★ 展开成**普通数组**再往下传，不能直接传 `scope.lectureIds`。
   *
   * Svelte 5 的 `$state` 是 Proxy，而 **contextBridge 在跨隔离世界时会结构化克隆参数**，
   * Proxy 克隆不了 —— 抛 `An object could not be cloned.`，而且这个错**不带 IPC 通道名**，
   * 因为它压根没走到 IPC。类型检查全过、界面看着好好的，一点按钮整块报错。
   *
   * 注意：在 preload 里做转换是**没用的**，值根本到不了那儿。必须在这一侧。
   */
  const lectureIds = $derived(
    scope.kind === 'hard' || scope.kind === 'items' ? [] : [...scope.lectureIds]
  )
  const scopeLabel = $derived(
    scope.kind === 'hard'
      ? '攻坚区'
      : scope.kind === 'today'
        ? '今日练习'
        : scope.kind === 'items'
          ? '筛选出来的这批'
          : scope.kind === 'test'
            ? `随时测${scope.shuffle ? ' · 乱序' : ''}`
            : '本 Lecture'
  )

  type View =
    | { k: 'loading'; note: string }
    | { k: 'error'; failure: Failure | null; message: string }
    | { k: 'empty' }
    | { k: 'question' }
    | { k: 'settle'; s: Settlement }

  let view = $state<View>({ k: 'loading', note: '正在准备题目…' })

  /**
   * D-484 · 清单 16 · 题面一出来就说一句「要提示是有代价的」（T-2 追加）。
   *
   * ★ 跟着**题面这一屏**走，不跟路由走：那颗「要提示」只在 `k === 'question'`
   *   且还没判分时才在屏上（`{#if !result}`）—— 早一步问，浮层量不到它。
   * ★ 和结算屏那条（`practice-settle`）在同一轮练习里先后出现，
   *   而「一次只出一条」会让后到的那条下次再出，不会两个框一起糊上来。
   */
  $effect(() => {
    if (view.k !== 'question') return
    void askGuide('practice-hint-cost')
  })
  let queue = $state<{ id: number; term: string; corrects: number }[]>([])
  let at = $state(0)
  let sessionId = $state<number | null>(null)
  let q = $state<QuestionRow | null>(null)
  let answer = $state('')
  let result = $state<GradeResult | null>(null)
  /** 只有第一次提交计入进度（D-121 / M-019）。改到过关是门槛，不是成绩。 */
  let isFirst = $state(true)
  let retries = $state(0)
  let hinted = $state(false)

  // ── 题型多选 + 出题顺序 ───────────────────────────────────
  //
  // 使用者：「选择题型时弹出好看的弹窗（不要直接一排按钮挤在一起）。
  //          弹窗内用复选框多选题型。视觉要精致（卡片式、清晰分组、选中状态明显）。」
  //          「流程：先定知识点范围/顺序 → 再定题型及题型顺序。」
  //
  // 所以弹窗自上而下就是这个流程：① 知识点顺序 → ② 题型顺序 → ③ 勾题型。
  let qtOpen = $state(false)

  /**
   * ★★ D-440（2026-09-02）· 产出练习**以前按不了 Esc**，而同一处挂载的认读能按 ——
   * 同一件事两套行为。现在两边都走 esc-stack。
   * ★ **只退一层**：题型面板开着就先关它，再按一次才关整个练习。
   * ★ 关练习走的是和屏顶那颗 ✕ **同一个 `onclose`** —— 不新增语义：
   *   ✕ 本来就是不问一句直接关的（答到一半按 ✕ 也是这样），Esc 只是键盘上的同一颗按钮。
   */
  $effect(() =>
    registerEsc(() => {
      if (qtOpen) {
        qtOpen = false
        return true
      }
      onclose()
      return true
    })
  )
  let qtAll = $state<QTypeRow[]>([])
  let qtOn = $state<string[]>([])
  let qtNote = $state<string | null>(null)
  let ord = $state<PracticeOrder>({ items: 'seq', qtypes: 'seq' })

  async function loadQtypes(): Promise<void> {
    try {
      const r = await window.nyx.study.qtypes()
      // 管理页停用的不该出现在这里 —— 停用的意思就是「别再给我出这种」
      qtAll = r.all.filter((x) => x.enabled)
      qtOn = r.on
      ord = await window.nyx.study.order()
    } catch {
      /* 拿不到就先不显示这个面板，不影响做题 */
    }
  }
  void loadQtypes()

  /**
   * 说清**什么时候生效**。
   * 已经出好的题不会当场变 —— 那些题是上一套设置生成的，
   * 下一条知识点进练习时才按新的重出。
   * 不说的话他会盯着当前这道题等它变，然后认为开关坏了。
   */
  const WHEN = '记下了。已经出好的题不变，下一条进练习时按新的来。'

  async function toggleQtype(key: string): Promise<void> {
    const next = qtOn.includes(key) ? qtOn.filter((x) => x !== key) : [...qtOn, key]
    qtOn = next
    try {
      await window.nyx.study.setQtypes(next)
      qtNote = WHEN
    } catch (err) {
      qtNote = cleanMessage(err)
    }
  }

  /** 全选 / 清空。**清空之后不许自己补回来** —— 那是他这次要取消的「默认题型」 */
  async function saveQtypes(next: string[]): Promise<void> {
    qtOn = next
    try {
      await window.nyx.study.setQtypes(next)
      qtNote = next.length === 0 ? '清空了。一种都没选就不会出题 —— 挑几种再开始。' : WHEN
    } catch (err) {
      qtNote = cleanMessage(err)
    }
  }
  const pickAllQtypes = (): Promise<void> => saveQtypes(qtAll.map((x) => x.key))
  const clearQtypes = (): Promise<void> => saveQtypes([])

  async function setOrder(part: 'items' | 'qtypes', mode: OrderMode): Promise<void> {
    ord = { ...ord, [part]: mode }
    try {
      await window.nyx.study.setOrder(ord)
      qtNote = part === 'items' ? '记下了。下一轮取队列时按这个顺序。' : WHEN
    } catch (err) {
      qtNote = cleanMessage(err)
    }
  }

  /** 勾了几种 —— 面板头上要显示，他才看得出自己是不是勾空了（D-478 之后不再分档） */
  const onCount = $derived(qtAll.filter((x) => qtOn.includes(x.key)).length)
  let hintText = $state<string | null>(null)
  /**
   * I-207 · 「这次没出成，还是上一批题。」
   * 生成失败但他手上那批题一道没少时，主进程把这句话交上来 —— 要当面说，
   * 而不是把模型那句「额度用在思考上」摆给他看（那句进账本）。
   */
  let genNotice = $state<string | null>(null)
  let busy = $state(false)

  /**
   * ══ 产出的**牌面** · D-486（三层补齐）★★★ ═══════════════════
   *
   * 他在 设置 › 产出练习 › 牌面 里选的那一张，决定**这道题在屏幕上摆成什么样**：
   *
   *   `plain` 整块 —— 今天的样子，一个字不变
   *   `split` 分栏 —— 答完之后「你写的」和「参考答案」左右并排（标注仍挂在你写的那一侧）
   *   `focus` 专注 —— 进题只留任务和输入框，答完才把其余信息推回来
   *
   * ★★★ **牌面只动排版，一个新信息都不加。**
   *   把释义 / 原句常驻卡面 = 一个免费的提示，会安静抹掉 D-138 的价格
   *   （「需要提示」那颗按下去要记一次认读失败、把那张卡的间隔打回，而屏幕上会说这句话）。
   * ★ `split` 这一轮只做**答完之后的并排回看**（零新数据）；
   *   题面拆「任务 / 材料」要往 `questions` 加一列 → 结构指纹变 → 两端协调升库 →
   *   那一轮必须装机，所以排进下一次装机那一批（确认单 §五 2）。
   */
  let face = $state<PracticeFace>(PRACTICE_FACE_FACTORY)

  async function loadFace(): Promise<void> {
    try {
      face = (await window.nyx.study.qtypes()).face
    } catch {
      /* 读不到就按出厂那一张，和今天完全一样 —— 绝不因此打断练习 */
    }
  }
  void loadFace()

  /**
   * ★ 屏上按 0 起数，core 那份按档位 1–4 记 —— 这里只转位置，**不再抄一遍字**（R-02）。
   *   以前这一行是 `['用错', '可懂但不地道', …]`，和 `core/types.ts` 各写一份；
   *   改档位名的时候必漏一处，而且没有任何东西会报错。
   */
  const GRADES = [GRADE_NAMES[1], GRADE_NAMES[2], GRADE_NAMES[3], GRADE_NAMES[4]]

  async function start(): Promise<void> {
    view = { k: 'loading', note: '正在取要练的条目…' }
    try {
      queue =
        scope.kind === 'hard'
          ? await window.nyx.study.hardQueue()
          : scope.kind === 'items'
            ? // D-012 筛选后统一测试。D-164：计入条目进度，但**不改 lecture 间隔**——
              // 所以 lectureIds 是空的，结算时不会给任何一讲重新排期。
              await window.nyx.study.queueByIds([...scope.itemIds])
            : scope.kind === 'test'
              ? // I-061 · 随时测：不看到期日、不看状态，可乱序
                await window.nyx.study.testQueue([...scope.lectureIds], scope.shuffle)
              : await window.nyx.study.productionQueueMany([...lectureIds])
      if (queue.length === 0) {
        view = { k: 'empty' }
        return
      }
      sessionId = await window.nyx.study.startSession('production', scope.kind, queue.length)
      at = 0
      await loadQuestion()
    } catch (err) {
      view = { k: 'error', failure: parseFailure(err), message: cleanMessage(err) }
    }
  }
  start()

  const cur = $derived(queue[at] ?? null)

  async function loadQuestion(): Promise<void> {
    const it = queue[at]
    if (!it) {
      await settle()
      return
    }
    view = { k: 'loading', note: `正在给「${it.term}」准备题目…` }
    /**
     * ★ I-091 · 换条目之前必须先把上一题清掉。
     *
     * 使用者：「产出练习依旧是同样一道题重复出，11 道题全是一样的。」
     * 根因就在这一行：`q` 是组件级状态，下面写的是 `if (!q) { 取新题 }` ——
     * 第 2 条开始 `q` 里还装着上一条的题，那个 if **永远进不去**，
     * 于是整轮 11 条全在做第 1 条的那道题。
     *
     * 更糟的是判分：`submitAnswer(itemId, questionId, …)` 收到的是
     * 「这一条的 id + 上一条的题 id」，答案就记到了错误的题目上。
     *
     * 别的字段（answer / result / retries…）当初都记得清，唯独漏了 `q`。
     */
    q = null // ← 这一行就是 I-091 的修复；删掉它整轮又会变成同一道题
    answer = ''
    result = null
    isFirst = true
    retries = 0
    hinted = false
    hintText = null
    genNotice = null
    try {
      if (scope.kind === 'hard') {
        // D-134 · 攻坚区**以错误订正为主，题面用你自己上次写错的句子**。
        // 这道题不需要调 AI —— 素材已经在库里了。
        q = await window.nyx.study.hardQuestion(it.id)
      }
      if (!q) {
        // D-129 · 一次生成五档各 3 道，此后该条目完全离线可用。
        // **只在进入测试时触发**，其他任何地方都不调用生成。
        const gen = await window.nyx.study.ensureQuestions(it.id)
        // I-207 · 没出成但旧题还在 —— 练习照常，只把这句话说出来
        genNotice = gen.notice
        q = await window.nyx.study.nextQuestion(it.id)
      }
      if (!q) {
        // 题都用完了就跳过这一条，别让整轮卡死
        at += 1
        await loadQuestion()
        return
      }
      view = { k: 'question' }
    } catch (err) {
      view = { k: 'error', failure: parseFailure(err), message: cleanMessage(err) }
    }
  }

  async function submit(): Promise<void> {
    const it = cur
    if (!it || !q) return
    if (!answer.trim()) return
    busy = true
    try {
      const r = await window.nyx.study.submitAnswer(
        sessionId,
        it.id,
        q.id,
        answer,
        isFirst,
        hinted
      )
      result = r
      /** ★ D-484 · 头一次看到结算时说一句「第 3 档以上才算正确」——
   *    不讲的话他不知道为什么答完了却没进度（确认单表 B 举的证）*/
      void askGuide('practice-settle')
      if (isFirst) isFirst = false
      else retries += 1
      view = { k: 'question' }
    } catch (err) {
      view = { k: 'error', failure: parseFailure(err), message: cleanMessage(err) }
    } finally {
      busy = false
    }
  }

  async function next(): Promise<void> {
    // ★ P-1 · 最后一题上快速双击会让 settle() 跑两次。后端已经幂等（一场只结算一次），
    // 这里再挡一道 —— 两层都要有：前端挡住多余的往返，后端保证结果只有一份
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

  /**
   * ★ P-1 · 「重试」要按**当时的处境**走。
   *
   * 以前一律 `onclick={loadQuestion}`。而 `loadQuestion` 开头是
   * `const it = queue[at]; if (!it) { await settle(); return }` ——
   * 结算失败时 `at` 必定已经越过队尾，所以那颗按钮的**实际行为就是「再结算一次」**，
   * 和它字面写的「重试出题」不是一回事。
   * 现在写明白：在队尾就重试结算，否则重试出题。
   *
   * ★ 一件必须说清的事：**这一改没有可观测的行为差异。**
   * 因为 `loadQuestion` 在队尾也会落进 `settle()` —— 两条路做的是同一件事。
   * 所以它的负向对照打不红（试过了），它是**意图澄清**，不是行为修复。
   * 真正防住「重复结算」的是后端的幂等保护（`sessions.finished_at`），
   * 那一条的负向对照是红的。这两件事不要混为一谈。
   */
  async function retry(): Promise<void> {
    if (at >= queue.length) await settle()
    else await loadQuestion()
  }

  async function settle(): Promise<void> {
    view = { k: 'loading', note: '正在结算…' }
    try {
      const s = await window.nyx.study.settleLectures([...lectureIds], sessionId)
      view = { k: 'settle', s }
      // D-165 · 诊断在结算时顺便更新 —— 总评那次调用已读完全部作答，零额外成本。
      // 它失败了不该把结算页也拖掉：统计已经算好了，总评只是锦上添花。
      try {
        const d = await window.nyx.study.diagnose(sessionId)
        if (view.k === 'settle') view = { k: 'settle', s: { ...s, summary: d.summary } }
      } catch {
        if (view.k === 'settle') view = { k: 'settle', s: { ...s, summary: undefined } }
      }
    } catch (err) {
      view = { k: 'error', failure: parseFailure(err), message: cleanMessage(err) }
    }
  }

  /** D-138 ·「提示」当分类器：判分不受影响，但记一次认读失败、该卡间隔打回。 */
  async function hint(): Promise<void> {
    const it = cur
    if (!it) return
    try {
      const r = await window.nyx.study.usedHint(it.id)
      hinted = true
      hintText = r.gloss || '（这条还没有释义）'
    } catch (err) {
      view = { k: 'error', failure: parseFailure(err), message: cleanMessage(err) }
    }
  }

  /** 把标注套在使用者自己写的句子上 · D-120 / M-020 */
  function marked(text: string, spans: GradeResult['annotations']): { t: string; bad: boolean }[] {
    if (spans.length === 0) return [{ t: text, bad: false }]
    const out: { t: string; bad: boolean }[] = []
    let rest = text
    for (const a of spans) {
      const i = rest.indexOf(a.span)
      if (i < 0) continue
      if (i > 0) out.push({ t: rest.slice(0, i), bad: false })
      out.push({ t: a.span, bad: true })
      rest = rest.slice(i + a.span.length)
    }
    if (rest) out.push({ t: rest, bad: false })
    return out
  }
</script>

<div class="ov on" data-testid="practice-overlay">
  <div class="focus">
    {#if view.k === 'error'}
      <div class="fbody">
        <div class="errbox" data-testid="practice-error">
          <div class="h">{view.failure?.title ?? '产出练习出问题了'}</div>
          <div style="white-space:pre-wrap">{view.failure?.detail ?? view.message}</div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn sm" data-testid="practice-retry" onclick={retry}>重试</button>
            <button class="btn sm" onclick={() => ongotoSettings?.()}>去设置</button>
            <button class="btn sm" onclick={onclose}>关掉</button>
          </div>
          <div class="dim" style="margin-top:10px;font-size:var(--fs-2)">
            已经答过的都存下来了，不会白写。
          </div>
        </div>
      </div>
    {:else if view.k === 'loading'}
      <div class="fbody"><div class="s2" data-testid="practice-loading">{view.note}</div></div>
    {:else if view.k === 'empty'}
      <div class="fbody">
        <div class="empty" data-testid="practice-empty">
          <div class="i">✦</div>
          {#if scope.kind === 'hard'}
            <!-- D-184 第②类空状态：「空是好事」，说一句肯定的话，不给按钮 -->
            <h4>攻坚区是空的</h4>
            <p>没有卡住的知识点。这是好事。</p>
          {:else}
            <h4>没有要练的写作层</h4>
            <p>可能都练成了，或者这里只有理解层 —— 那些走认读线。</p>
          {/if}
        </div>
        <div style="text-align:center"><button class="btn" onclick={onclose}>回工作台</button></div>
      </div>
    {:else if view.k === 'settle'}
      {@const s = view.s}
      <div class="fbody">
        <div class="sum" data-testid="settlement">
          <div style="display:flex;align-items:baseline;gap:11px;margin-bottom:20px">
            <h2 style="margin:0;font-size:var(--fs-7);font-weight:700">练完了</h2>
            <span style="font-size:var(--fz-body-ui);color:var(--text-3)">{s.sample} 题</span>
          </div>

          {#if s.sample > 0}
            <div class="bars">
              {#each [1, 2, 3, 4] as g (g)}
                {@const n = s.distribution[g] ?? 0}
                {#if n > 0}
                  <div style="width:{(n / s.sample) * 100}%;background:var(--g{g})">{n}</div>
                {/if}
              {/each}
            </div>
            <div class="blg">
              {#each [1, 2, 3, 4] as g (g)}
                <span><i style="background:var(--g{g})"></i>{GRADES[g - 1]} {s.distribution[g] ?? 0}</span>
              {/each}
              <span style="margin-left:auto;color:var(--text-3)"
                >产出正确率 <b style="font-family:var(--mono);color:var(--text)"
                  >{Math.round(s.accuracy * 100)}%</b
                ></span
              >
            </div>
          {/if}

          <div class="sgd">
            <div class="sbx">
              <div class="h">练成了</div>
              {#if s.silenced.length}
                {#each s.silenced as t (t)}
                  <div class="li"><span class="t">{t}</span><span class="r" style="color:var(--green)">★ {SILENCE_FILTER_NAME}</span></div>
                {/each}
              {:else}
                <div class="li dim">这一轮还没有</div>
              {/if}
            </div>
            <div class="sbx">
              <div class="h">进了攻坚区</div>
              {#if s.hard.length}
                {#each s.hard as t (t)}
                  <div class="li"><span class="t">{t}</span><span class="r" style="color:var(--amber)">5 次未达 3 连</span></div>
                {/each}
              {:else}
                <div class="li dim">没有 —— 空是好事</div>
              {/if}
              <div class="h" style="margin-top:12px">下次这批</div>
              {#if s.perLecture.length === 0}
                <div class="li dim">
                  这一轮不改 Lecture 排期 —— 条目进度与 Lecture 排期解耦
                </div>
              {:else}
                {#each s.perLecture as p (p.lectureId)}
                  <div class="li">
                    <span class="t">{p.name}</span>
                    <span class="r" style="font-size:var(--fs-2);color:var(--text-2)">{p.reason}</span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>

          <!-- D-127 · 一句 AI 总评，**横向看这一轮**（纵向看单条的在词条详情里） -->
          {#if s.summary}
            <div class="aic" data-testid="settle-summary">
              <div class="h">这一轮的总评</div>
              <p>{s.summary}</p>
            </div>
          {/if}

          <!-- F-05 · 出口最多两个。第二个是把两条线接上的位置（R-008 断点 3） -->
          <div class="frow" data-testid="settle-exits">
            {#if s.hard.length > 0}
              <button class="btn pri" onclick={onclose}>去看这 {s.hard.length} 条 ›</button>
            {/if}
            {#if s.dueReadingCount > 0}
              <button class="btn" data-testid="settle-goto-reading" onclick={() => ongotoReading?.()}
                >接着练 {s.dueReadingCount} 张认读卡 ›</button
              >
            {/if}
            <button class="btn" data-testid="settle-close" onclick={onclose}>回工作台</button>
          </div>
        </div>
      </div>
    {:else if q && cur}
      <div class="ftop">
        <span class="lb">产出练习 · {scopeLabel} · {cur.term}</span>
        <div class="fpr"><i style="width:{((at + 1) / queue.length) * 100}%"></i></div>
        <span class="n">{at + 1} / {queue.length}</span>
        <span
          class="x"
          role="button"
          tabindex="0"
          title="退出练习"
          aria-label="退出练习"
          data-testid="practice-quit"
          onclick={onclose}
          onkeydown={(e) => e.key === 'Enter' && onclose()}><Ic n="close" s={18} /></span
        >
      </div>
      <!--
        ★ 使用者 7 · 题型多选。
        「在产出练习时，提供复选框让用户选择题型。」

        放在题面上方而不是设置页里 —— 他要改的时候正好在练，
        跑去设置里翻一遍再回来，中间那条路就足以让人放弃。

        **勾选只挑形式，改不了难度档**：递进（D-116）和「3 次正确必须跨题型」
        （M-027）是这套方法的核心检验，不能被口味改掉。
        面板上把这句话写出来，免得他以为勾了简单的就能更快静默。
      -->
      <div class="fbody">
        <div class="qtbar">
          <span class="qt">{q.type}</span>
<!--
            题型入口做成一枚**设置胶囊**：左边是它管什么，右边是当前状态。
            以前那颗「题型 · 已选 N 种 ▾」看着像一个普通按钮，
            他不知道点了会展开什么。
          -->
          <button
            class="qtcap"
            class:zero={qtOn.length === 0}
            data-testid="qtypes-open"
            onclick={() => (qtOpen = !qtOpen)}>
            <span class="qtcap-k">题型</span>
            <span class="qtcap-v">{qtOn.length === 0 ? '未选' : `已选 ${qtOn.length} 种`}</span>
            <span class="qtcap-a"><Ic n="caret" s={12} /></span>
          </button>
        </div>
        {#if qtOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="qtm-mask" data-testid="qtypes-panel" onclick={() => (qtOpen = false)}>
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="qtm-box" onclick={(e) => e.stopPropagation()}>
              <div class="qtm-hd">
                <div>
                  <div class="qtm-t">这一轮怎么练</div>
                  <div class="qtm-s">先定知识点顺序，再定题型和它们的顺序</div>
                </div>
                <span
                  class="qtm-x"
                  role="button"
                  tabindex="0"
                  title="收起"
                  aria-label="收起题型面板"
                  data-testid="qtypes-close"
                  onclick={() => (qtOpen = false)}
                  onkeydown={(e) => e.key === 'Enter' && (qtOpen = false)}><Ic n="close" s={18} /></span>
              </div>

              <div class="qtm-bd">
                <div class="qtm-step">
                  <div class="qtm-n">1</div>
                  <div class="qtm-c">
                    <div class="qtm-h">知识点顺序</div>
                    <div class="qtm-seg" data-testid="order-items">
                      <button
                        class:on={ord.items === 'seq'}
                        data-testid="order-items-seq"
                        onclick={() => setOrder('items', 'seq')}>按顺序</button>
                      <button
                        class:on={ord.items === 'random'}
                        data-testid="order-items-random"
                        onclick={() => setOrder('items', 'random')}>乱序</button>
                    </div>
                    <div class="qtm-d">按顺序 = 照收进来的先后练；乱序每轮重新洗。</div>
                  </div>
                </div>

                <div class="qtm-step">
                  <div class="qtm-n">2</div>
                  <div class="qtm-c">
                    <div class="qtm-h">题型顺序</div>
                    <div class="qtm-seg" data-testid="order-qtypes">
                      <button
                        class:on={ord.qtypes === 'seq'}
                        data-testid="order-qtypes-seq"
                        onclick={() => setOrder('qtypes', 'seq')}>按顺序</button>
                      <button
                        class:on={ord.qtypes === 'random'}
                        data-testid="order-qtypes-random"
                        onclick={() => setOrder('qtypes', 'random')}>乱序</button>
                    </div>
                    <!-- ★ D-478 · 原文是「同一档里，先用哪种形式考」——「档」已随档位机制取消 -->
                    <div class="qtm-d">勾了的题型里，先用哪种形式考。顺序在设置里可以拖着改。</div>
                  </div>
                </div>

                <div class="qtm-step">
                  <div class="qtm-n">3</div>
                  <div class="qtm-c">
                    <div class="qtm-h">要哪些题型</div>
                    <!--
                      ★ 2026-09-08（D-478）· 这里原来写「勾选只挑形式，改不了难度档」，
                        并按五个档分组。档位机制取消了 —— 现在就是一张平列表，
                        勾了的按你排的顺序轮着出；「连续 3 次正确必须跨 3 种形式」
                        （M-027）改由出题与发题两侧的判据显式保证（`core/qtype-plan.ts`）。
                    -->
                    <div class="qtm-d">
                      勾了的会<b>按你排的顺序轮着出</b>，一次出几道在「设置 › 练习」里自己定。
                      连续 3 次正确仍然必须跨 3 种形式 —— 勾得太少就跨不了那么多。
                    </div>
                    <div class="qtm-grp">
                      <div class="qtm-gh">
                        <span>题型</span>
                        <span class="qtm-cnt" class:zero={onCount === 0}
                          >{onCount} / {qtAll.length}</span>
                      </div>
                      <div class="qtm-cards">
                        {#each qtAll as t (t.key)}
                          <label
                            class="qtm-card"
                            class:on={qtOn.includes(t.key)}
                            data-testid="qtype-{t.key}">
                            <input
                              type="checkbox"
                              checked={qtOn.includes(t.key)}
                              onchange={() => toggleQtype(t.key)} />
                            <span class="qtm-ck"></span>
                            <span class="qtm-tx">
                              <b>{t.name}</b>
                              <span>{t.brief}</span>
                            </span>
                          </label>
                        {/each}
                      </div>
                      {#if onCount === 0}
                        <!-- 不兜底：一种都没勾就是不出题，如实说会发生什么 -->
                        <div class="qtm-warn">
                          一种都没勾 —— <b>练习出不了题</b>。先勾一种。
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              </div>

              <div class="qtm-ft">
                <!--
                  ★「清空」之后**不许**自己恢复成全选。
                  一种都没勾就是不出题，并且在这里当场说清楚 ——
                  以前清空等于全选，于是这个按钮看起来毫无作用。
                -->
                <span class="qtm-sum" data-testid="qtypes-sum">
                  {#if qtOn.length === 0}
                    <b>一种都没选 —— 现在不会出题</b>
                  {:else}
                    已选择 {qtOn.length} 种
                  {/if}
                </span>
                <button class="hb" data-testid="qtypes-all" onclick={pickAllQtypes}>全选</button>
                <button class="hb" data-testid="qtypes-none" onclick={clearQtypes}>清空</button>
                {#if qtNote}<span class="qtm-note" data-testid="qtypes-note">{qtNote}</span>{/if}
                <button class="btn sm pri" onclick={() => (qtOpen = false)}>好了</button>
              </div>
            </div>
          </div>
        {/if}
        <!-- D-137 · 题面只有题干和输入框，不给释义、不给 nuance —— 那是认读线的活 -->
        <!-- data-qid 是给验收用的：题面文字可能碰巧一样，题号不会。
             I-091 那个 bug（整轮 11 条都在做第 1 条的题）光看文字是抓不住的 -->
        <!--
          ★★ 题面是 **AI 写的字**，而它会写 markdown ——
            使用者 2026-09-15 在真机上点名：屏上原样印着 `**rummaging**`。
            拆成段画（判据在 core 一份），**不用 `{@html}`**：
            回 HTML 就得在两端各自保证转义，而漏一处就是注入。
        -->
        <div class="qx" data-testid="question-prompt" data-qid={q.id} data-item={cur.id}
          >{#each emphasisParts(q.prompt) as p, i (i)}{#if p.bold}<b>{p.text}</b>{:else}{p.text}{/if}{/each}</div>
        <!--
          ★ 「专注」：进题只留任务和输入框，语境标与「需要提示」等答完再推回来
            （对 80–120 词那两种题型差别最大）。**收起不等于没有** ——
            答完那一刻它们原样回来，一个都不少。
        -->
        {#if !(face === 'focus' && !result)}
          <div class="qm">
            <!--
              ★ 「原语境」「完全陌生的场景」两个词从 core 来（R-02）——
                中间那两档（near / far）这一屏**有意合成一句**「离原语境远一些」，
                所以那一句仍写在这儿：它是这一屏自己的说法，core 里没有对应的那一份。
            -->
            <span
              >{q.context === 'original'
                ? CONTEXT_DISTANCE_NAMES.original
                : q.context === 'unseen'
                  ? CONTEXT_DISTANCE_NAMES.unseen
                  : '离原语境远一些'}</span
            >
            {#if !result}
              <!--
                ★ D-484 · 清单 16 的目标：那颗「要提示」本身。
                  它治的是一个**看不见的代价** —— 按下去要记一次没答上来、
                  把这一条的间隔打回（D-138），而屏上原本没有任何地方说这件事。
              -->
              <button
                class="hb"
                data-testid="hint"
                data-guide="practice-hint-cost"
                onclick={hint}
                disabled={hinted}>
                {hinted ? '已用提示' : '需要提示'}
              </button>
            {/if}
          </div>
        {/if}
        {#if genNotice}
          <div class="notice warn" data-testid="gen-notice">{genNotice}</div>
        {/if}
        {#if hintText}
          <div class="notice warn" data-testid="hint-text">
            {hintText}
            <br /><span class="dim"
              >判分不受影响，但记了一次<b>认读</b>失败 —— 写产出题时想不起意思，是这张卡排期错了的硬证据。</span
            >
          </div>
        {/if}

        <textarea
          class="ans"
          data-testid="answer"
          placeholder="Write in English…"
          bind:value={answer}
          readonly={!!result && result.passed}
        ></textarea>

        {#if result}
          <!-- 四档刻度，命中的那一档高亮 -->
          <!-- ★ D-484 · B-5「答案按四档评，第 3 档以上才算正确」：首次看到结算时说一句 -->
          <div class="scale" data-testid="scale" data-guide="practice-settle">
            {#each [1, 2, 3, 4] as g (g)}
              <div class="sg {result.grade === g ? `hit h${g}` : ''}">
                <span class="nm">{g}</span>{GRADES[g - 1]}
              </div>
            {/each}
          </div>

          <!--
            D-120 / M-020 · 标在你自己的句子上，不只给范文。
            ★ 「分栏」把它和参考答案左右并排（`.splitwrap`）—— 只是换个摆法，
              标注仍然挂在**你写的**那一侧，判分与 D-122「过关才给范文」一个字没动。
          -->
          <div class="splitwrap" class:on={face === 'split'} data-testid="answer-pair">
            <div class="yours" data-testid="marked">
              {#each marked(answer, result.annotations) as seg, i (i)}
                {#if seg.bad}<span class="bad">{seg.t}</span>{:else}{seg.t}{/if}
              {/each}
            </div>
            {#if face === 'split' && result.passed && result.reference}
              <div class="an" data-testid="reference-side">
                <span class="tg2">参考</span><div>{result.reference}</div>
              </div>
            {/if}
          </div>

          {#if result.why}
            <div class="an"><span class="tg2">判定</span><div>{result.why}</div></div>
          {/if}
          {#each result.annotations as a (a.span)}
            <div class="an">
              <span class="tg2">{a.label}</span>
              <div>{a.problem}{#if a.fix} → <b>{a.fix}</b>{/if}</div>
            </div>
          {/each}

          {#if result.outcome}
            <div class="notice" data-testid="outcome">{result.outcome.reason}</div>
          {/if}

          {#if result.passed}
            <!-- D-122 · 改到过关才给范文 -->
            <!-- ★ 分栏那一张已经把它摆在右边了，这里不再重复一遍 -->
            {#if result.reference && face !== 'split'}
              <div class="an" data-testid="reference">
                <span class="tg2">参考</span><div>{result.reference}</div>
              </div>
            {/if}
            <div class="frow">
              <button class="btn pri" disabled={busy} data-testid="next-question" onclick={next}
                >下一题 ›</button
              >
            </div>
          {:else}
            <div class="frow">
              <button class="btn pri" disabled={busy} data-testid="resubmit" onclick={submit}
                >{busy ? '判分中…' : '改好了，再提交'}</button
              >
              {#if retries >= 2}
                <button class="btn" disabled={busy} data-testid="give-up" onclick={next}>跳过这一题</button>
                <span class="gv">改两次仍不过可以跳过 · 已记为失败</span>
              {:else}
                <span class="gv">成绩只记第一次那次判定 · 改到过关是门槛，不是分数</span>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="frow">
            <button
              class="btn pri"
              disabled={busy || !answer.trim()}
              data-testid="submit"
              onclick={submit}>{busy ? '判分中…' : '提交'}</button
            >
            <span class="gv">写完才判 · 参考答案要过关之后才给</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
