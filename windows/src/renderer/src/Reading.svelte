<script lang="ts">
  import { READING_GRADE_NAMES } from '@core/types.ts'
  import type { CardRow } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import { speak } from './speak.ts'
  import { registerEsc } from './esc-stack.svelte.ts'
  import { untrack } from 'svelte'
  /** D-486 · 认读题型的判据与屏上字只有 core 一份（两端同一份）*/
  import {
    capReadingGrade,
    READING_CAP_GRADE,
    READING_QTYPE_FACTORY,
    type ReadingQType
  } from '@core/quiz-rules.ts'
  import { matchesTerm } from '@core/reading-face.ts'
  import Ic from './Ic.svelte'

  let {
    lectureId,
    onclose,
    /** I-061 · 随时测：给了这个就不看到期日，按范围全取，可乱序 */
    test = null
  }: {
    lectureId: number | null
    onclose: () => void
    /** I-097 · `itemIds` = 知识库里勾中的那几条；两者给其一 */
    test?: { lectureIds?: number[]; itemIds?: number[]; shuffle: boolean } | null
  } = $props()

  type View =
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | { k: 'empty' }
    | { k: 'card' }
    | { k: 'done' }

  let view = $state<View>({ k: 'loading' })
  let queue = $state<CardRow[]>([])
  let at = $state(0)
  let flipped = $state(false)
  let graded = $state(0)
  let silencedTerms = $state<string[]>([])
  let shownAt = Date.now()

  /**
   * 中文默认盖住 · I-083
   *
   * 使用者：「认读卡上的中文应该是隐藏的，点开可以看，但是看了熟练度要降低。」
   * 道理很硬：中文直接把答案念出来了，摆在正面等于这张卡白练。
   * 英文释义 / nuance 是**线索**（D-093），留着；中文是**答案**，盖上。
   *
   * 看了就降档：**评分封顶到「想了一下」**。不是偷偷扣，是当场写在按钮上 ——
   * 「看了中文」和「没看中文」是两次不同质量的回忆，SM-2 的间隔理应不同。
   */
  let peeked = $state(false)

  /**
   * ══ 认读的**题型** · D-486（三层补齐）★★★ ═══════════════════
   *
   * 他在 设置 › 认读测试 › 题型 里选的那一种，决定**他拿到这张牌面之后要做什么动作**：
   *
   *   `flip`   翻卡自评 —— 今天的样子，一个字不变
   *   `write`  先写再翻 —— 多一个输入框，翻开时逐字比一下，对了预选「会」
   *   `timed`  限时认读 —— 倒计时到点自动翻开，这一次封顶「想了一下」
   *
   * ★★ 三种**都不改 AI 那一侧**：四张牌面出的题面，三种题型都答得了。
   * ★★ `write` **只逐字比对**：不调 AI、不判地不地道、不产生标注、不写 `answers`
   *   —— 越过这条线的那一刻理解层和写作层就合成了一条（判据与理由在
   *   `core/reading-face.ts::matchesTerm` 头上）。
   */
  let qtype = $state<ReadingQType>(READING_QTYPE_FACTORY)
  /** 他这一张写了什么。**用完即弃，不入库** */
  let typed = $state('')
  /** 这一张超时了没有 —— 和「看过中文」同一条封顶判据（core 一份） */
  let timedOut = $state(false)
  /** 倒计时还剩几秒；`null` = 这一张不计时 */
  let left = $state<number | null>(null)

  /**
   * ★ 秒数**写死在 core 一处**，第一版不做成设置项（确认单 §二 细目）——
   *   一上来就多一个没人调的旋钮，比少一个选项糟。
   *   他真觉得快了慢了再升成选项，那时有 `review_logs.duration_ms` 的真分布可看。
   */
  const TIMED_SECONDS = 20

  /** 进这一屏时读一次他选的题型。读不出来就按出厂（翻卡自评）—— 绝不因此打断认读 */
  async function loadQType(): Promise<void> {
    try {
      qtype = (await window.nyx.prompts.readingFaces()).qtype
    } catch {
      /* 读不到就按出厂那一种，和今天完全一样 */
    }
  }
  void loadQType()

  /**
   * ★ 同 R-02：认读自评四档也只有 `core/types.ts` 那一份。
   *   这一处不在文案审查表里 —— 是做 R-02 时撞见的**同一个毛病的第三处**，
   *   一并收了（表上那两处改了、这一处留着抄，等于把坑挪了个地方）。
   */
  const GRADES = [
    READING_GRADE_NAMES[1],
    READING_GRADE_NAMES[2],
    READING_GRADE_NAMES[3],
    READING_GRADE_NAMES[4]
  ]
  /**
   * ★ B3 / ST-Q7 · **判分不许只靠颜色**（D-341）。四条非颜色通道里，
   *   Windows 一直只有两条（文案 · 颜色），形状这一条 Android 早就上屏了。
   *   验收判据是那句老话：**把颜色全部关掉，仍然读得懂**。
   *
   *   忘了     虚线空心（`grade-again`）—— 虚线本来就读作「没接上」
   *   想了一下 空心 + 内嵌小实心（`grade-near`）—— 有一点，但没满
   *   会了     实心，**无芒**（`core`）
   *   太简单   实心 **+ 四芒**（`grade-ok` = 那颗星）—— 芒 = 光 = 会了，还多一层
   *
   * ★ 四枚全是 `core/icons.ts` 里现成的几何，**一枚都不用新画**
   *   （派单 B3 说「三枚 + 太简单实心带芒」，实际是「会了」用无芒的 core，四枚都在）。
   */
  const GRADE_MARKS = ['grade-again', 'grade-near', 'core', 'grade-ok']

  /**
   * ★ 「**按下那一刻就出现**」：`grade()` 要等一次 IPC 才换卡，
   *   在那之前屏幕上不能什么都不发生（I-076 那一课）。按下就先把记号点亮。
   */
  let pressed = $state(0)

  async function load(): Promise<void> {
    view = { k: 'loading' }
    try {
      queue = test
        ? // I-061 · 不看到期日、不看状态 —— 想测就能测
          test.itemIds
          ? // `[...]` 不能省：`test` 来自上层的 $state，里面的数组是 Proxy，
            // 而 Proxy 过不了 contextBridge（报的是「An object could not be cloned」）。
            // preload 里的 plain() 帮不上忙 —— 桥在参数进 preload **之前**就克隆了
            await window.nyx.study.testCardsByIds([...test.itemIds], test.shuffle)
          : await window.nyx.study.testCards([...(test.lectureIds ?? [])], test.shuffle)
        : // D-229 · 每日软上限，超出自动顺延 —— 纯 SM-2 的欠债堆积是它最劝退的地方
          await window.nyx.study.dueCards(lectureId, 40)
      at = 0
      flipped = false
      peeked = false
      shownAt = Date.now()
      view = queue.length === 0 ? { k: 'empty' } : { k: 'card' }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }
  load()

  const cur = $derived(queue[at] ?? null)

  /**
   * 正面 = **挖空的原句** + 三行提示（D-093）。
   * 三行提示让它成为「有线索的回忆」而不是裸产出，所以被动词汇用同一种卡也不冲突（D-095）。
   */
  function cloze(c: CardRow): { before: string; after: string } | null {
    if (!c.quote) return null
    const i = c.quote.toLowerCase().indexOf(c.term.toLowerCase())
    if (i < 0) return null
    const before = c.quote.slice(0, i)
    const after = c.quote.slice(i + c.term.length)
    // D-409②：term≈quote 的整句条目挖空后两头只剩标点 → 正面等于空白。
    // 退化成「无挖空」形态，由 frontNote 如实说明（Android 同判据同轮修）。
    if (!/[A-Za-z0-9一-鿿]/.test(before + after)) return null
    return { before, after }
  }

  /**
   * ★★ AI 牌面 · 使用者 2026-09-03「认读测试也应该拥有自己的 Prompt」
   *
   * 提示词 = `prompt.reading-card`（设置里可看可改可换），管的是**题面本身**，
   * 不是翻开之后的解释。手机上跑的是同一个键、同一份默认、同一套判据
   * （`core/reading-face.ts`）—— 各写一份的话，同一张卡两台机器考法不一样。
   *
   * ★ 它永远不许挡路（D-338）：机械挖空先摆上去，AI 回来了才换。
   *   **提前一张预取** —— 看这张的时候下一张已经在路上，所以实际看不到「换」。
   * ★ 没配 AI / 超时 / 格式不对 / 露了答案（D-390）—— 安静退回机械挖空，不报错。
   * ★ 牌面上如实标「AI · 形式」：这句话是机器编的，不是他自己的原文。
   */
  let faces = $state<Record<number, { form: string; text: string } | null>>({})

  async function fetchFace(c: CardRow | undefined): Promise<void> {
    if (!c) return
    if (c.id in faces) return // 要过了就不再要（失败的那张也算要过，别死循环）
    faces[c.id] = null
    try {
      const f = await window.nyx.study.readingFace(c.id)
      if (f) faces[c.id] = f
    } catch {
      /* 牌面出不来就用机械挖空 —— D-338，认读不因为 AI 不在就跑不起来 */
    }
  }

  const face = $derived(cur ? (faces[cur.id] ?? null) : null)
  /**
   * 「中译回想」这一型，牌面本身就是中文 —— 那是**题**不是偷看，所以不封顶
   * （I-083 封的是「答不上来去翻中文」那一下）。但下面那颗「看中文」按钮要收起来：
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

  /** 正面无挖空时的如实话术：分「没摘句」与「整句条目」两种，不混为一谈 */
  function frontNote(c: CardRow): string {
    if (!c.quote) return '（这条没有原文摘句）'
    return '（这条收的是整句 —— 凭下面的线索回忆它，翻开对照）'
  }

  async function grade(g: number): Promise<void> {
    const c = cur
    if (!c) return
    pressed = g // 先点亮，再去等那一次 IPC
    try {
      /**
       * 看过中文 / 超时就封顶 —— 在这里统一处理，键盘 1234 和点按钮走同一条路。
       * ★ 判据在 core 一份（`capReadingGrade`）：两处各写一个 2 的话，
       *   改一处另一处不动，而两处都说得通、都不报错。
       */
      const eff = capReadingGrade(g, { peeked, timedOut })
      const r = await window.nyx.study.gradeCard(c.id, eff, Date.now() - shownAt)
      if (r.silenced) silencedTerms = [...silencedTerms, c.term]
      graded += 1
      flipped = false
      peeked = false
      typed = ''
      timedOut = false
      shownAt = Date.now()
      if (at + 1 >= queue.length) view = { k: 'done' }
      else at += 1
      pressed = 0
    } catch (err) {
      pressed = 0
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (view.k !== 'card') return
    // D-108 · 只加练习类快捷键：空格翻卡、1234 评分
    if (e.code === 'Space') {
      e.preventDefault()
      flipped = true
    } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault()
      grade(Number(e.key))
    }
    // ★ Esc 不在这里 —— 它走 esc-stack（D-440：一套逻辑，见下面的 registerEsc）
  }

  /**
   * ══ 限时认读的倒计时 · D-486 ★★ ══════════════════
   *
   * 到点**自动翻开**并把这一次封顶在第 2 档 —— 屏上当场说清（I-083：
   * 诚实降档，不偷偷扣）。只有选了「限时认读」才起，别的两种一秒都不计。
   * ★ 翻开之后就停 —— 翻开后还在跑的话，他慢慢选四档也会被判成超时。
   */
  $effect(() => {
    if (view.k !== 'card' || qtype !== 'timed' || flipped) {
      left = null
      return
    }
    void cur?.id // 换卡重新起一轮
    left = TIMED_SECONDS
    const t = setInterval(() => {
      left = (left ?? 1) - 1
      if ((left ?? 0) <= 0) {
        clearInterval(t)
        left = null
        untrack(() => {
          timedOut = true
          flipped = true
        })
      }
    }, 1000)
    return () => clearInterval(t)
  })

  /** ★ D-440 · 关这一层浮层的唯一入口，和 ✕ 调的是同一个 `onclose` */
  $effect(() => registerEsc(() => (onclose(), true)))
</script>

<svelte:window onkeydown={onKey} />

<div class="ov on" data-testid="reading-overlay">
  <div class="acard">
    {#if view.k === 'error'}
      <div class="errbox" data-testid="reading-error">
        <div class="h">认读练习出问题了</div>
        <div>{view.message}</div>
        <!-- ★ 这两颗要有 testid（2026-09-07）：出错时**只有它们能关掉这一层**，
             而用例点不到没有 testid 的按钮 —— 于是浮层留在屏幕上，
             把后面几十条用例一起拖红，红的位置还全在别处。真踩过一次。 -->
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn sm" data-testid="reading-error-retry" onclick={load}>重试</button>
          <button class="btn sm" data-testid="reading-error-close" onclick={onclose}>关掉</button>
        </div>
      </div>
    {:else if view.k === 'loading'}
      <div class="side">认读练习</div>
      <div class="s2">正在取到期的卡…</div>
    {:else if view.k === 'empty'}
      <!-- D-184 第③类空状态：「空是正常的」，一句平静说明，不给按钮压力 -->
      <div class="side">认读练习</div>
      <div class="empty" data-testid="reading-empty">
        <div class="i"><Ic n="vault" s={26} /></div>
        <h4>今天没有到期的卡</h4>
        <p>间隔重复的效果几乎全部来自「在快忘掉时复习」—— 提前练反而会削弱它。</p>
      </div>
      <div style="text-align:center"><button class="btn" onclick={onclose}>知道了</button></div>
    {:else if view.k === 'done'}
      <div class="side">练完了</div>
      <div class="empty" data-testid="reading-done">
        <div class="i">✦</div>
        <h4>{graded} 张</h4>
        {#if silencedTerms.length}
          <p>其中 <b>{silencedTerms.length}</b> 条认读线练成了：{silencedTerms.join(' · ')}</p>
        {:else}
          <p>都记下来了。下次到期时它们会自己回来。</p>
        {/if}
      </div>
      <div style="text-align:center;display:flex;gap:8px;justify-content:center">
        <button class="btn pri" data-testid="reading-close" onclick={onclose}>回工作台</button>
        <button class="btn" onclick={load}>再看看有没有到期的</button>
      </div>
    {:else if cur}
      {@const cz = cloze(cur)}
      <div class="side">正面 · 认读练习　<span class="dim">{at + 1} / {queue.length}</span></div>

      <div class="cloze" data-testid="card-front">
        {#if face}
          {face.text}
        {:else if cz}
          {cz.before}<span class="gap"></span>{cz.after}
        {:else}
          <span class="dim">{frontNote(cur)}</span><span class="gap"></span>
        {/if}
      </div>
      {#if face}
        <!-- 诚实：这句话是机器编的，不是他自己的原文 -->
        <div class="s3 dim" data-testid="card-face-form">AI · {face.form}</div>
      {/if}

      <!-- 三行提示 · D-093 -->
      <div class="hints">
        <div class="hr2"><span class="k">释义</span><span class="v">{cur.gloss || '—'}</span></div>
        <!-- I-083 · 中文是答案，不是线索。盖住，点了才看，看了就封顶 -->
        <div class="hr2">
          <span class="k">中文</span>
          <span class="v">
            {#if faceZh}
              <span class="dim" data-testid="peek-in-face">题面就是中文 —— 这张不用再翻</span>
            {:else if peeked}
              {cur.glossZh || '—'}
              <span class="dim" style="margin-left:8px" data-testid="peek-note">
                看过中文，这张最高按「{GRADES[READING_CAP_GRADE - 1]}」算
              </span>
            {:else}
              <button class="btn sm" data-testid="peek-zh" onclick={() => (peeked = true)}>
                看中文（会降一档）
              </button>
            {/if}
          </span>
        </div>
        <div class="hr2">
          <span class="k">nuance</span><span class="v"><em>{cur.nuance || '—'}</em></span>
        </div>
      </div>

      {#if flipped}
        <!-- D-094 · 卡片上有朗读。放在**翻卡之后** —— 翻卡前读出来等于把答案念了 -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="aw" data-testid="card-back" title="点一下读这条" onclick={() => speak(cur.term)}>
          {cur.term}
        </div>
        <div class="ag">{cur.gloss}</div>
        {#if qtype === 'write' && typed.trim()}
          <!--
            ★ 只说「对上了 / 没对上」，**不判地不地道**（那是写作层的事）。
              没对上时一个字都不说他错在哪 —— 那会变成一次微型判分。
          -->
          <div class="s3" data-testid="write-verdict">
            {#if matchesTerm(typed, cur.term)}
              你写的对上了<span class="dim">　已经替你选好「会」，不同意就点别的</span>
            {:else}
              你写的和这条对不上<span class="dim">　拼写错不降档，这一档还是你自己点</span>
            {/if}
          </div>
        {/if}
        {#if timedOut}
          <div class="s3" data-testid="timed-note">
            超时了 —— 这一次最高记到「{GRADES[READING_CAP_GRADE - 1]}」
          </div>
        {/if}
        <!-- D-136 · 按钮上直接标出各自的下次间隔，让自评带上代价 -->
        <div class="grades" data-testid="grades">
          {#each [1, 2, 3, 4] as g (g)}
            {@const eff = capReadingGrade(g, { peeked, timedOut })}
            <!--
              ★★ D-486 · 「先写再翻」写对了就**预选**「会」（第 3 档）。
                预选不是替他点 —— **最终哪一档还是他自己点**，
                所以用一圈描边（`presel`）而不是按下态（`hit`）：
                两种状态要一眼分得开，否则他会以为已经评完了。
            -->
            <button
              class="gd g{g}"
              class:hit={pressed === g}
              class:presel={g === 3 && qtype === 'write' && !!typed.trim() && matchesTerm(typed, cur.term)}
              data-testid="grade-{g}"
              onclick={() => grade(g)}>
              <!-- ★ B3 · 形状这一条通道（D-341）。颜色走 --g1…g4，但**关掉颜色也读得懂** -->
              <span class="mk"><Ic n={GRADE_MARKS[g - 1]} s={18} /></span>
              <div class="g">{GRADES[g - 1]}</div>
              <!-- 封顶之后间隔也跟着变 —— 按钮上写的必须是真会发生的那个数 -->
              <div class="iv">{cur.intervals[eff]} 天</div>
              <div class="kb">{g}</div>
            </button>
          {/each}
        </div>
      {:else}
        <div style="text-align:center;margin-top:22px">
          {#if qtype === 'write'}
            <!--
              ★★ 「先写再翻」：写出你想到的那个词，翻开时逐字比一下。
                · 不给补全 / 建议 —— 那等于把答案提前摆出来（D-390 同一条道理）
                · 写错**不降档**：拼写错 ≠ 没认出来，认读线考的是认出来
                · 空着直接翻 = 和今天完全一样
            -->
            <input
              class="tin2"
              data-testid="write-input"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="写出你想到的那个词（可以空着）"
              bind:value={typed}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  flipped = true
                }
              }} />
          {/if}
          {#if left !== null && !flipped}
            <div class="s3 dim" data-testid="timed-left">还剩 {left} 秒 —— 到点自动翻开</div>
          {/if}
          <button class="btn pri" data-testid="flip" onclick={() => (flipped = true)}
            >翻卡 · 空格</button
          >
        </div>
      {/if}

      <div style="text-align:center;font-size:var(--fs-2);color:var(--text-3);margin-top:15px">
        已练 {graded} 张
        <span
          style="margin-left:14px;cursor:pointer;color:var(--accent-2)"
          role="button"
          tabindex="0"
          data-testid="reading-quit"
          onclick={onclose}
          onkeydown={(e) => e.key === 'Enter' && onclose()}>结束</span
        >
      </div>
    {/if}
  </div>
</div>
