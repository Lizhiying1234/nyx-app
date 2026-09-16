<script lang="ts">
  import { untrack } from 'svelte'
  import { cleanMessage, type RichCard } from '@shared/api.ts'
  import { has } from '@core/dict/capability.ts'
  import { AI_LOOKUP_NOTE, parseAiSections, type LookupSection } from '@core/lookup-sections.ts'
  import { speakSystem } from './speak.ts'
  import { usable as mediaUsable } from '@core/dict/media.ts'
  import DictHtml from './DictHtml.svelte'
  import { registerEsc } from './esc-stack.svelte.ts'
  import { askGuide } from './guide.svelte.ts'
  import Ic from './Ic.svelte'

  /**
   * 悬浮词典卡片 · D-151（2026-08-16）
   *
   * ── 它取代了什么 ──────────────────────────────────────────
   *
   * 以前右键「查词典」只弹一句 toast：`【TLD】` + 原文前 160 字。
   * 他截图给我看过那一幕：
   *   「【TLD】unspooling 原型:unspooling 是 unspool 的现在分词
   *    (unspool 的现在分词) vt. [俚语]上演(电影)」
   * 同一件事说三遍，而且只有一本、看不全、换不了。
   *
   * ── 三条硬规矩 ────────────────────────────────────────────
   *
   * ① **不新开窗口。** 项目里所有浮层都是渲染进程内的绝对定位元素
   *    （右键菜单、题型面板、退化页）。BrowserWindow 会带来焦点、DPI、
   *    多显示器一整套问题，而那些问题现在一个都不存在。
   * ② **查新词复用同一张卡**，不重建 —— 他连着查三个词是常事。
   * ③ **界面不决定用哪本词典。** 默认是哪本、退回哪本，全部由
   *    主进程的 `Dicts.defaultBook()` 说了算（判据只有一处）。
   */
  interface Props {
    /** 他选中的那串字。换了它就等于查一个新词 */
    word: string
    /** 卡片挂在屏幕的哪个点（被查的那个词附近） */
    at: { x: number; y: number }
    onclose: () => void
    /**
     * 收下的时候进哪一讲。`null` = 没设 → 那颗「收下」不给点，
     * 并说清去哪儿设（一颗按下去没反应的按钮比没有它更糟）。
     */
    lectureId?: number | null
    /**
     * ══ 这张卡是在 app **外面**弹的吗（使用者 2026-09-13 裁「可以」）══
     *
     * `true` = Glance / Frame 在别的程序上面弹的那张。
     * 差别**只有一条**：下面那一整段 AI **不自动跑**，是一颗按钮。
     * 层级、标签、默认停在 AI —— 一样，不做成两套。
     *
     * ★ 为什么只有外面这么干：外面是「顺手划中一段」，里面是「我要查这个词」——
     *   意图强度不一样，而每打开一次就是一次真金白银。
     * ★ 上面那两行简短释义**照样自动跑**：Glance 的全部意义就是
     *   「选中就有意思看」，而它 240 token 顶天。
     */
    outside?: boolean
  }
  const { word, at, onclose, lectureId = null, outside = false }: Props = $props()

  /**
   * ══ Nyx 里有没有它（使用者 2026-09-13「不要再让查词能力彼此割裂」）══
   *
   * `ASSIST_CONTRACT` §三.1 的原话：「『Nyx 里有没有它』和『一键收下』
   * **只用本地已同步的知识库**，离线可用、永不失败。这构成了 Assist 的**保底承诺**。」
   * 所以这一块**不等词典、不等 AI** —— 词典没装、网断了，它照样答得出来。
   */
  let known = $state<{ id: number; term: string; layer: 'A' | 'B' }[] | null>(null)
  let saving = $state(false)
  let saved = $state<string | null>(null)

  /**
   * D-484 · B-2 · **查词卡一出现就说一句**「收下会发生什么」（I-190 改的就是这里）。
   *
   * ★★ **只在 app 里面那张卡上**（`!outside`）：外面那张住在另一个窗口
   *   （`Overlay.svelte`，透明窗），而引导浮层挂在主窗口的 `App.svelte` 上 ——
   *   在外面那张上问，等于在一个没有浮层的窗口里把「同时只许出一条」的闸占住，
   *   屏上一个字都不会出现。（这条是量出来的：`<DictCard … outside />` 只有 Overlay 一处。）
   * ★ 原来的条件是「那颗『收下』真的渲染出来了」（要有默认 Lecture · 词不在库里）——
   *   三个条件同时成立的那一次很少，实测**从来没讲过**。
   *   现在只等 `known` 查完（卡上那一行有了确定的内容），指的是**那一整行**，
   *   而那一行三种状态下都在：能收 → 有按钮；已有 → 说已经有了；
   *   没设默认 Lecture → 说去哪儿设。三种都对得上「收下这件事」这句话。
   */
  $effect(() => {
    if (outside) return
    if (known === null) return
    void askGuide('lookup-save')
  })

  $effect(() => {
    const w = word.trim()
    known = null
    saved = null
    /** ★ 换了词就把上一个词的 AI 结果清掉 —— 留着的话他会以为那是新词的解释 */
    aiSecs = null
    aiErr = null
    deafBook = false
    brief = null
    briefErr = null
    zhOpen = false
    sayNote = ''
    /**
     * ★★ 两条 AI 调用在这里**自动发车**（他这一轮定的：AI 是默认那一档）。
     *   先发顶上那两行（240 token，一两秒就回），再发整段解释 ——
     *   顺序有意义：他第一眼看的是词条头，不是下面那一大段。
     */
    untrack(() => {
      void askBrief(w)
      /** ★ 外面那条路：下面那一整段等他点（上面那两行照样跑）*/
      if (!outside) void askAi(w)
    })
    if (!w) return
    let live = true
    window.nyx.browse
      .search(w)
      .then((r) => {
        if (!live) return
        /** ★ 只认**一模一样**的那一条 —— 搜索是模糊的，而这里问的是
         *   「我收过这个吗」。把近似的算进来，他会以为收过而其实没有。 */
        known = r.items.filter((i) => i.term.trim().toLowerCase() === w.toLowerCase())
      })
      .catch(() => {
        /* 查不出来就不说 —— 这一块是附加信息，不该顶掉词典正文 */
        if (live) known = []
      })
    return () => {
      live = false
    }
  })

  /**
   * ══ AI | Dictionary（使用者 2026-09-13 第二轮）════════════════
   *
   * 他的原话：「两者是并列关系，不是备用关系。AI 不是『词典查不到之后才调用』。
   * Dictionary 也不是 AI 的 fallback。它们都是完整独立的查词界面。默认：AI。」
   *
   * ★★ 所以 AI **自动跑**，不再是一颗按钮。
   *   上一版是「点了才跑」，理由是省钱；他这一轮把 AI 定成**默认进入的那一档**，
   *   而一个默认打开就空着、要再点一下才出东西的界面，等于没有默认。
   *   （省钱那条仍然成立的地方：**换一档不重跑** —— 结果留着。）
   */
  let tab = $state<'ai' | 'dict'>('ai')

  /**
   * ══ 词条顶上那两行简短释义 ═══════════════════════════════════
   * 「英文简短释义默认直接显示；中文简短释义默认收起，点了才展开。」
   * ★ 它们**不属于**下面任何一档 —— 切到 Dictionary 也照样在上面。
   */
  let brief = $state<{ en: string; zh: string } | null>(null)
  let briefErr = $state<string | null>(null)
  /** 中文那行默认收起 —— 他要的就是「主动点击后才展开」 */
  let zhOpen = $state(false)

  /** 朗读那颗喇叭说的话（读不出来时的原因）。**不许静默** */
  let sayNote = $state('')

  /** 顶上那颗喇叭 · 固定走系统语音（他这一轮点名的） */
  async function say(): Promise<void> {
    sayNote = await speakSystem(word.trim())
  }

  /**
   * ══ 这本的发音浏览器放不了（使用者 2026-09-14 第四条）★★ ══════════
   *
   * 实测他机器上：默认那本 **LDOCE5 的发音是 Speex**，Chromium 放不了；
   * 而正文里 `counter` 一条就有 14 个喇叭图标，每一个点了都**悄无声息**。
   * 他报的「语音没有正常显示」就是这个。
   *
   * ★ 两件事一起做，缺一不可：
   *   ① **说出来** —— 静默失败是这个仓最忌讳的那一种
   *   ② **退到系统语音** —— 他点那个喇叭是想听这个词，不是想听这本词典的录音师。
   *      只说不读等于把问题原样丢回给他。
   * ★ 只说一次：同一条词典正文里十几个喇叭，每点一个报一次就成了噪音。
   */
  let deafBook = $state(false)

  async function onDeafAudio(): Promise<void> {
    /** ① 先读 —— 他点那个喇叭是想听这个词，不是想看一段解释 */
    const problem = await speakSystem(word.trim())
    if (problem) {
      sayNote = problem
      return
    }
    /**
     * ② 再说一句为什么 —— **只说第一次**。
     *   同一条词典正文里十几个喇叭，每点一个报一次就成了噪音；
     *   而换一个词时 `deafBook` 会被重置（上面那个 `$effect`）——
     *   因为下一个词可能在另一本能放的词典里。
     */
    if (deafBook) return
    deafBook = true
    sayNote = '这本词典的发音是浏览器放不了的格式（Speex）—— 已经用系统语音读了这个词。'
  }


  /**
   * ══ AI 那一档的正文 ═══════════════════════════════════════════
   * ★ 提示词走名册里已有的 `lookup-search`（今天从「仅手机」改成「两端」），
   *   他在设置里改过就用他那份 —— 两端同一份，讲法不会不一样。
   * ★ 排版走 core 的 `parseAiSections`（D-401⑦「模型管内容、UI 管呈现」）：
   *   直接把模型那段 Markdown 摆上去的话，他看到的是满屏 `**` ——
   *   而手机上那一档两周前就是分好节的。同一段字两端摆法不同，
   *   看起来就像模型不稳定。
   */
  let aiSecs = $state<LookupSection[] | null>(null)
  let aiBusy = $state(false)
  let aiErr = $state<string | null>(null)

  /**
   * ★★ 词是**参数**，不是从 `word` 里读的。
   *   从 `word` 读的话，这个函数在 `$effect` 里被同步调用时会给 effect
   *   留下一条依赖；而这个函数里但凡再读一个 `$state`（比如 `aiBusy`），
   *   effect 就会被自己写的东西弹回来 —— 死循环，每转一圈真打一次模型。
   */
  async function askAi(w: string): Promise<void> {
    if (aiBusy) return
    if (!w) return
    aiBusy = true
    aiErr = null
    try {
      /** 成功就是正文，失败是 reject —— 和别的 AI 通道一个形状，失败走下面那个 catch */
      const out = (await window.nyx.ai.explain(w)).text
      /** ★ 跑的过程中他又查了别的词 —— 把旧答案贴上去比不贴更糟 */
      if (w !== word.trim()) return
      const secs = parseAiSections(out)
      /**
       * ★ 分完一节都没有 = 模型回了空。**当失败说出来**，
       *   而不是留一块空白 —— 空白他只会当成「点了没反应」。
       */
      if (secs.length === 0) aiErr = 'AI 没给出内容 —— 再试一次，或者换个说法'
      else aiSecs = secs
    } catch (e) {
      if (w === word.trim()) aiErr = cleanMessage(e)
    } finally {
      aiBusy = false
    }
  }

  /** 顶上那两行。★ 和 `askAi` 分开跑：它 240 token，那条 1200 —— 它先到 */
  async function askBrief(w: string): Promise<void> {
    if (!w) return
    briefErr = null
    try {
      const b = await window.nyx.ai.brief(w)
      if (w !== word.trim()) return
      brief = b
    } catch (e) {
      if (w === word.trim()) briefErr = cleanMessage(e)
    }
  }

  /** 收下。★ 层固定「理解层」，和文件学习里那颗 Save 同一条规矩（使用者 2026-09-13） */
  async function keep(): Promise<void> {
    if (!lectureId || saving) return
    saving = true
    try {
      const w = word.trim()
      await window.nyx.data.addItem(lectureId, w, '', 'A', w)
      saved = w
      /** 广播一声，正开着那一讲的页面自己去刷（和文件学习那条 4.3 同一条路） */
      window.dispatchEvent(new CustomEvent('nyx:item-added', { detail: { lectureId } }))
      known = [...(known ?? []), { id: -1, term: w, layer: 'A' }]
    } catch (e) {
      error = cleanMessage(e)
    } finally {
      saving = false
    }
  }

  let card = $state<RichCard | null>(null)
  let error = $state<string | null>(null)
  let picking = $state(false)
  /** 这本词典自带的样式表，一本拿一次（`oald10.css` 有 186 KB） */
  let css = $state('')
  /** ref → data: URI 的缓存。同一条发音他会点好几次 */
  const cache = new Map<string, string | null>()

  /** 结构化那一份 —— 能力判断全走它，不看「有没有这个字段」 */
  const entry = $derived(card?.entry ?? null)
  const caps = $derived(entry?.capabilities ?? [])
  /**
   * ★★ 发音按钮的判据是**能力 + 这一条真的有能放的资源**，
   *   不是 `if (entry.audio)`。LDOCE5 的 18.4 万条是 Speex，
   *   浏览器放不了 —— 那种情况下**一个按钮都不许出现**（他的 D4 第 7 条）。
   */
  const sounds = $derived.by(() => {
    if (!has(caps, 'audio')) return []
    /**
     * ★ 一个词条上同一个口音可能挂着好几条（`child` 在 OALD10 上
     *   单复数各一条发音）。**每个口音只留第一条** —— 卡片上并排两个
     *   一模一样的「英」按钮，他分不清点哪个。
     *  （第一版没去重，`{#each}` 的 key 撞了，整张卡片当场白屏：
     *   `each_key_duplicate`。真实屏幕那一档一跑就抓出来了。）
     */
    const out: { region: 'uk' | 'us'; ipa: string; ref: string }[] = []
    for (const p of entry?.phonetics ?? []) {
      if (p.region !== 'uk' && p.region !== 'us') continue
      if (!p.audio || !mediaUsable(p.audio)) continue
      if (out.some((x) => x.region === p.region)) continue
      out.push({ region: p.region, ipa: p.ipa, ref: p.audio.ref })
    }
    return out
  })
  /**
   * 这一条**本来有发音、但一条都放不了**吗。
   * ★ 判据是「有音频引用」和「能放的有几条」之差 —— 不是 `capabilities` 里
   *   有没有 `audio`：那一栏本身就是按「能不能放」算出来的（量过：
   *   LDOCE5 的 caps 里没有 audio，而 phonetics[0].audio 明明在），
   *   拿它当判据等于问了个同义反复。
   */
  const deafEntry = $derived(
    (entry?.phonetics ?? []).some((p) => p.audio) && sounds.length === 0
  )

  /** 每个口音的音标只显示一条 —— 同上，重复的那几条对他没有信息 */
  const shownPhonetics = $derived.by(() => {
    const out: { region: 'uk' | 'us'; ipa: string }[] = []
    for (const p of entry?.phonetics ?? []) {
      if (p.region !== 'uk' && p.region !== 'us') continue
      if (out.some((x) => x.region === p.region)) continue
      out.push({ region: p.region, ipa: p.ipa })
    }
    return out
  })
  /** 查得慢才显示「查着呢」—— 本地词典通常是瞬时的，闪一下比不显示更烦 */
  let slow = $state(false)

  /** 卡片自己的尺寸，用来做边界翻转 */
  const W = 380
  const MAXH = 460

  const pos = $derived({
    // 右边放不下就往左展开；上边放不下就往下（D-200 边界检测，和右键菜单同一套做法）
    left: Math.max(8, Math.min(at.x, window.innerWidth - W - 8)),
    top:
      at.y + MAXH + 16 < window.innerHeight
        ? at.y + 12
        : Math.max(8, at.y - Math.min(MAXH, 360) - 12)
  })

  /** 拿 ref 换字节。**点了才要** —— 一条词条上可能挂着二十几条发音 */
  async function fetchRef(ref: string): Promise<string | null> {
    if (cache.has(ref)) return cache.get(ref) ?? null
    try {
      const r = await window.nyx.dict.resource(ref)
      const url = r.ok ? r.dataUrl : null
      cache.set(ref, url)
      return url
    } catch {
      cache.set(ref, null)
      return null
    }
  }

  async function play(ref: string): Promise<void> {
    const url = await fetchRef(ref)
    if (!url) return
    try {
      await new Audio(url).play()
    } catch {
      /* 放不了不弹东西 —— 能力判断已经挡过一道 */
    }
  }

  async function load(w: string, bookId?: number): Promise<void> {
    error = null
    css = ''
    cache.clear()
    const timer = setTimeout(() => (slow = true), 150)
    try {
      card = await window.nyx.dict.rich(w, bookId)
      const key = card?.styleRef
      const id = card?.book?.id
      if (key && id !== undefined) css = await window.nyx.dict.style(id, key)
    } catch (err) {
      error = cleanMessage(err)
    } finally {
      clearTimeout(timer)
      slow = false
    }
  }

  /**
   * ★ 他主动换一本 = **同时更新默认词典**，不弹「要不要设为默认」。
   * 顺序是先落库再查，这样万一查出错，默认也已经是他要的那本了。
   */
  async function pick(id: number): Promise<void> {
    picking = false
    try {
      await window.nyx.dict.setDefaultBook(id)
    } catch (err) {
      error = cleanMessage(err)
      return
    }
    await load(word, id)
  }

  // 换一个词就重查 —— 卡片实例不变，只换内容
  $effect(() => {
    void load(word)
  })

  /**
   * ══ 拖卡（使用者 2026-09-14 晚：「弹窗本身应该可以拖动、移动」）══
   *
   * ★★ **只在 app 外面那张上**：里面那张是主窗口里的一个绝对定位元素，
   *   「拖它」该搬的是那个元素、不是窗口；而外面那张就是一整个窗口。
   *   两种拖法混在一个组件里只会出一种错：里面那张一拖把主窗口搬走了。
   *
   * ★ 不用 `-webkit-app-region: drag`：那个属性一旦贴在哪一块上，
   *   那一块上的**点击就不再是点击** —— 而卡头上坐着「♪ 读」和关闭两颗键。
   * ★ 按在**按钮上**不算拖（`closest('button,[role=button]')` 一句挡掉），
   *   否则他想点那颗喇叭、手抲一下，卡就跑了。
   */
  let dragFrom: { x: number; y: number } | null = null
  /**
   * ★★ 按下那一点**不挪**，送的是从按下算起的**累计**位移。
   *   逐帧送增量的话，主进程必须每步把窗口 bounds 读回来当基准，
   *   而那在 150% 缩放下会把 1 DIP 的位移抹成 0、把取整误差堆进尺寸 ——
   *   他报的「拖着拖着弹窗就变大」就是这个（见 `main/overlay.ts`）。
   */
  let dragFirst = true

  function dragDown(e: MouseEvent): void {
    if (!outside || e.button !== 0) return
    const t = e.target as HTMLElement | null
    if (t?.closest('button,[role="button"]')) return
    dragFrom = { x: e.screenX, y: e.screenY }
    dragFirst = true
  }

  function dragMove(e: MouseEvent): void {
    if (!dragFrom) return
    const dx = e.screenX - dragFrom.x
    const dy = e.screenY - dragFrom.y
    if (dx === 0 && dy === 0) return
    window.nyx.overlay.moveBy(dx, dy, dragFirst)
    dragFirst = false
  }

  const dragUp = (): void => {
    dragFrom = null
  }

  /** ★ D-440 · Esc 走 esc-stack —— 叠在别的浮层上时只关最上面这一层（就是它） */
  $effect(() => registerEsc(() => (onclose(), true)))
</script>

<!--
  点卡片外关掉。遮罩透明、不吃滚动 —— 他还要能看着原文。
  ★★ 外面那张（Glance / Frame）**不铺遮罩**（使用者 2026-09-14 第三条）：
    那张卡自己就占满了浮窗，遮罩只能盖到**浮窗这 420×520 之内**——
    它既接不到屏幕其他地方的点击（那些点击根本不经过 Nyx），
    又会把卡四周那圈透明区变成吃鼠标的死区。
    「点别处关掉」在外面走另一条路：选中一清空，主进程就收起它
    （`main/glance.ts` 的 `cleared`）—— 因为他点别处的那一下，正好就是在清选中。
-->
{#if !outside}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="dcw-mask" data-testid="dict-mask" onclick={onclose}></div>
{/if}

<!-- ★ 拖动时鼠标会跑到卡外面，所以听的是窗口不是那个 div -->
<svelte:window onmousemove={dragMove} onmouseup={dragUp} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="dcw"
  class:fill={outside}
  data-testid="dict-card"
  style={outside ? '' : `left:${pos.left}px;top:${pos.top}px;width:${W}px;max-height:${MAXH}px`}
  onclick={(e) => e.stopPropagation()}>
  <!-- ── 顶部：固定 ─────────────────────────────────────── -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dcw-hd" class:grab={outside} onmousedown={dragDown}>
    <div class="dcw-w">
      <b data-testid="dict-word">{entry?.headword || word}</b>
      <!--
        ★★ 音标与发音按钮**按能力出**，不是「有没有这个字段」。
        LDOCE5 的发音是 Speex，浏览器放不了 —— 那本上一个按钮都不该出现，
        按下去没声音比没有按钮糟得多（他会以为软件坏了）。
      -->
      {#each shownPhonetics as p, pi (pi)}
        <span class="dcw-ph" data-testid="dict-phonetic-{p.region}">
          {p.region === 'uk' ? '英' : '美'} /{p.ipa}/
        </span>
      {/each}
      <!--
        ══ 音频 · 系统语音（使用者 2026-09-13 第二轮点名的）══════════
        他的原话：「这个查词界面的音频按钮对应的是：系统语音。」
        ★ 词典自己那几段真人录音（♪英 / ♪美）**挪进 Dictionary 那一档**了 ——
          它们是「词典语音」，属于那本词典，不属于词条层。
          两种音一起摆在词条头上，他分不出点哪个会听到什么。
      -->
      <button class="dcw-say" data-testid="dict-say" title="读一遍（系统语音）" onclick={say}
        >♪ 读</button>
    </div>
    <span
      class="dcw-x"
      role="button"
      tabindex="0"
      title="关闭"
      aria-label="关闭词典卡"
      data-testid="dict-close"
      onclick={onclose}
      onkeydown={(e) => e.key === 'Enter' && onclose()}><Ic n="close" s={18} /></span>
  </div>
  <!--
    ══ Nyx 里有没有它 ＋ 收下（保底那一档，离线也成立）══
    ★ 摆在词典正文**之前**：他问的第一个问题是「我收过这个吗」，
      不是「词典怎么说」—— 后者他自己也能查，前者只有 Nyx 答得出。
  -->
  <!--
    ★ D-484 · B-2 的目标就是这一整行（I-190）：原来挂在那颗「收下」上，
      而那颗按钮**三种状态里只有一种**会出现。这一行永远在。
  -->
  <div class="dcw-nyx" data-testid="dict-nyx" data-guide={outside ? undefined : 'lookup-save'}>
    {#if known === null}
      <span class="dcw-dim">看看 Nyx 里有没有…</span>
    {:else if known.length > 0}
      <span data-testid="dict-have"
        >Nyx 里<b>已经有它</b>（{known.some((k) => k.layer === 'B') ? '写作层' : '理解层'}）</span
      >
    {:else if saved}
      <span data-testid="dict-saved">收下了 · 进了理解层</span>
    {:else if lectureId}
      <span class="dcw-dim">Nyx 里还没有它</span>
      <button class="btn sm pri" disabled={saving} data-testid="dict-keep" onclick={keep}
        >{saving ? '收…' : '收下'}</button
      >
    {:else}
      <span class="dcw-dim"
        >Nyx 里还没有它 —— 想在这儿直接收下，先去 <b>Settings → Assist</b> 设一个默认 Lecture</span
      >
    {/if}
  </div>

  <!-- 读不出来的原因（系统语音关着之类）—— **不许静默** -->
  {#if sayNote}
    <div class="dcw-sub" data-testid="dict-say-note">{sayNote}</div>
  {/if}

  <!--
    ══ 词条本身的两行简短释义（使用者 2026-09-13 第二轮）════════════
    「英文简短释义 —— 默认直接显示。中文简短释义 —— 默认收起，点了才展开。」
    ★ 摆在 AI | Dictionary **上面**：它们是词条的信息，
      不属于下面任何一档 —— 切到 Dictionary 也照样在这儿。
  -->
  <div class="dcw-brief" data-testid="dict-brief">
    {#if brief?.en}
      <div class="en" data-testid="dict-brief-en">{brief.en}</div>
    {:else if briefErr}
      <!--
        ★★ 取不到就**什么都不摆**（2026-09-13 · 浮窗那一套第一次跑就抓到）。
          原来这儿摆一条两行的错，而它在**不滚的头部**里 ——
          没配 AI 的时候正文区只剩 77px，主角被挤没了。
        ★ 这不是静默失败：原因就在下面一行 —— AI 那一档会原原本本说出来
          （「还没有配置 API」＋一颗「再试一次」）。
          同一件事说两遍，第二遍是噪音，而这一遍的代价是把正文挤掉。
      -->
    {:else}
      <div class="dcw-dim" data-testid="dict-brief-wait">看一眼这是什么意思…</div>
    {/if}

    {#if brief?.zh}
      <!-- 中文那行默认收起 —— 他要的是「用户主动点击后才展开」 -->
      <button
        class="zhtoggle"
        data-testid="dict-brief-zh-toggle"
        aria-expanded={zhOpen}
        onclick={() => (zhOpen = !zhOpen)}>{zhOpen ? '收起中文' : '中文释义'}</button>
      {#if zhOpen}
        <div class="zh" data-testid="dict-brief-zh">{brief.zh}</div>
      {/if}
    {/if}
    <!--
      ★★ 全卡**只此一条**「可能有误」（D-395 同族的诚实原则）。
        原来上面这一块和下面 AI 那一档各标一条，相隔六十来个像素 —— 像 bug。
      ★ 留这一条的好处：它在滚区**外面**，他把 AI 那一大段滚到哪儿，它都还在。
      ★ 显示条件管住两种情形：
        · AI 档 —— 永远标（整档都是 AI 编的，哪怕上面两行没取到）
        · Dictionary 档 —— 只有上面那两行真有内容时才标；
          不然就成了一句「AI 可能有误」顶在**词典正文**上面，那是给词典栽赃。
    -->
    {#if brief?.en || brief?.zh || (tab === 'ai' && aiSecs)}
      <div class="note" data-testid="dict-brief-note">{AI_LOOKUP_NOTE}</div>
    {/if}
  </div>

  <!--
    ══ AI | Dictionary ══════════════════════════════════════════
    他的原话：「两者是并列关系，不是备用关系……它们都是完整独立的查词界面。默认：AI。」
    ★ 所以这里是**两个平级的标签**，不是「查不到再说」的回退链。
  -->
  <div class="dcw-tabs" role="tablist" data-testid="dict-tabs">
    <button
      role="tab"
      class:sel={tab === 'ai'}
      aria-selected={tab === 'ai'}
      data-testid="dict-tab-ai"
      onclick={() => (tab = 'ai')}>AI</button>
    <button
      role="tab"
      class:sel={tab === 'dict'}
      aria-selected={tab === 'dict'}
      data-testid="dict-tab-dict"
      onclick={() => (tab = 'dict')}>Dictionary</button>
  </div>

  <!--
    ══ Dictionary 档专属的那一条（标签栏下面、正文区**上面**）══
    ★★ 为什么不摆进正文区：那一套用例钉着
      「`dict-body` 的直接子元素只能是词典原文，别的什么都不许有」——
      出处是他 2026-08-20 的话「取消释义，只保留原文这样子就行了」。
      那条判据一个字都不该动，它挡的正是「往正文里再塞一块」这件事。
    ★ 顺带还更好：词典录音那一行不会跟着正文滚走。
  -->
  {#if tab === 'dict'}
    {#if entry?.headword && entry.headword.toLowerCase() !== word.trim().toLowerCase()}
      <!-- 他选中的和词典真正查的不是同一个东西 —— 是词典做了词形还原，说一句 -->
      <div class="dcw-sub" data-testid="dict-asked">
        查的是 <b>{entry.headword}</b>（你选的是「{word.length > 24
          ? word.slice(0, 24) + '…'
          : word}」）
      </div>
    {/if}
    <!--
      ══ 这本有发音、但一条都放不了（使用者 2026-09-14 第四条）══════════
      ★ 不说的话他只会觉得「这软件没有语音」。说清楚是哪一本、为什么、以及
        **现在就能用的那条路**（词条头上那颗「♪ 读」是系统语音，永远能用）。
      ★ 摆在录音那一行的位置上 —— 那正是他期待看到喇叭的地方。
    -->
    {#if deafEntry && !sounds.length}
      <div class="dcw-sub" data-testid="dict-deaf">
        《{card?.book?.name}》这一条<b>有真人发音，但格式是 Speex</b>，浏览器放不了 ——
        用上面那颗「<b>♪ 读</b>」（系统语音），或者换一本（下面那个选择器里
        <b>oald10</b> 和<b>朗文6英汉双解</b>是 mp3）。
      </div>
    {/if}
    {#if sounds.length}
      <!--
        词典自己那几段真人录音 —— 从词条头挪到这一档来了。
        它们是「词典语音」，属于**这本词典**；词条头上那颗喇叭是「系统语音」。
        ★ 音标**留在词条头**，没挪：那是这个词的身份信息，他在 AI 档也该看得见。
      -->
      <div class="dcw-dsay" data-testid="dict-dsay">
        {#each sounds as s, si (si)}
          <button
            class="dcw-say"
            data-testid="dict-play-{s.region}"
            title="{s.region === 'uk' ? '英式' : '美式'}发音（词典录音）"
            onclick={() => play(s.ref)}>♪ {s.region === 'uk' ? '英' : '美'}</button>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- ── 中间：只有这里滚动 ─────────────────────────────── -->
  <div class="dcw-bd" data-testid="dict-body">
    <!-- ══ AI 那一档 ══ -->
    {#if tab === 'ai'}
      {#if aiSecs}
        <div class="dcw-ans" data-testid="dict-ai-out">
          <!-- 「可能有误」在标签栏上面那一条，不在这儿重复一遍（见那儿的注释）-->
          {#each aiSecs as s, i (i)}
            {#if s.label}<div class="sec">{s.label}</div>{/if}
            <p>{s.text}</p>
          {/each}
        </div>
      {:else if aiErr}
        <div class="dcw-err" data-testid="dict-ai-err">{aiErr}</div>
        <button class="btn sm" data-testid="dict-ai-retry" onclick={() => askAi(word.trim())}
          >再试一次</button>
      {:else if outside && !aiBusy}
        <!--
          ★ app 外面：这一档点了才跑（他 2026-09-13 裁的）。
            一颗明明白白的按钮 —— 不是「正在看…」，因为它并没有在看。
        -->
        <button class="btn sm" data-testid="dict-ai-go" onclick={() => askAi(word.trim())}
          >问 AI</button>
        <span class="dcw-dim">整段解释点了才跑 —— 上面那两行已经给你了</span>
      {:else}
        <!-- 等待要有形：说清在等什么，别留一块空白（空白他会当成点了没反应）-->
        <div class="dcw-dim" data-testid="dict-ai-wait">AI 正在看这个词…</div>
      {/if}

    <!-- ══ Dictionary 那一档 ══ -->
    {:else if error}
      <div class="dcw-err" data-testid="dict-error">{error}</div>
    {:else if !card}
      {#if slow}<div class="dcw-dim">查着呢…</div>{/if}
    {:else if !card.book}
      <div class="dcw-dim" data-testid="dict-none">
        还没有可用的词典。把词典文件放进「设置 → 词典」里说的那个文件夹，再回来查。
      </div>
    {:else if card.diagnostic}
      <!--
        ★ D3 · 词目就在那儿，是它指向的地方坏了（转圈 / 跳太多 / 指向不存在的词目）。
        这时候说「里没有这个词」是假话 —— 他会去怀疑软件，而不是那本词典。
      -->
      <div class="dcw-dim" data-testid="dict-diagnostic">{card.diagnostic.says}</div>
    {:else if !entry}
      <div class="dcw-dim" data-testid="dict-empty">《{card.book.name}》里没有这个词。</div>
    {:else if card.html}
      <!--
        ★★★ 词典原文 —— 这就是最终展示结果（2026-08-20 定的产品原则）。
        「Nyx 不重新解释词典，只安全地呈现词典自己提供的内容。」
        没有「释义 / 原文」两档，也不会因为某本抽不出结构就自己拼一个释义界面。

        ★★ 关在 Shadow DOM 里：词典自己的 CSS 在里面生效、出不去。
        `oald10.css` 186 KB 全是 `body{…}` `a{…}` 这种全局选择器，
        注进主文档等于整个 Nyx 被改版。
        消毒（script / on* / 外链 / @import）在主进程就做完了。
      -->
      <DictHtml
        html={card.html}
        {css}
        {fetchRef}
        plain={card.plain}
        onUnplayable={() => void onDeafAudio()} />
    {:else}
      <!-- 这一条词典是真的什么都没给 —— 说实话，别拿别处拼的东西填上 -->
      <div class="dcw-dim" data-testid="dict-nostruct">
        《{card.book.name}》在这一条上没给内容。换一本试试（下面那个选择器）。
      </div>
    {/if}
  </div>

  <!--
    ── 底部：固定，词典选择器 ───────────────────────────
    ★ 只在 Dictionary 那一档出现 —— 在 AI 档摆一个「换一本词典」，
      等于说 AI 那一档也是某本词典给的，而它不是。
  -->
  <div class="dcw-ft" class:hide={tab !== 'dict'}>
    {#if card?.fellBackFrom}
      <span class="dcw-fell" data-testid="dict-fellback">
        默认的《{card.fellBackFrom}》现在用不了，暂时用这本
      </span>
    {/if}
    {#if card?.book}
      <!--
        ★★ 这颗键重做了一次（使用者 2026-09-14 第三条）。

        他的原话：「现在词典模式似乎只能使用一本字典。」
        ★ 量过了，**功能是好的**：在他库的副本上拿 `counter` 跑一遍，
          选择器里真的摆着 12 本、没被切、点得动。坏的是**它长得不像一颗键** ——
          一条淡色、满宽、右对齐的书名，读起来是「以上内容来自某本」这种落款，
          而不是「点我换一本」。名字又长得把那枚 caret 顶到了边上。
        ★ 所以改的是**可供性**，不是逻辑：前面挂一个固定的「词典」字样
          （告诉他这一栏管的是什么）、书名超长就截断（让 caret 永远在场）、
          开着的时候 caret 翻过来（和折叠头同一个转法，DS §4.4）。
        ★ 另一本都没有时**不给点** —— 一颗按下去只会说「只有这一本」的键，
          比没有它更像坏了。同时把还有几本写在键上，他不用点开就知道值不值得点。
      -->
      <button
        class="dcw-pick"
        data-testid="dict-book"
        disabled={card.others.length === 0}
        aria-expanded={picking}
        title={card.others.length === 0
          ? '只有这一本收了这个词'
          : `换一本 —— 还有 ${card.others.length} 本收了它`}
        onclick={() => (picking = !picking)}
        ><span class="lab">词典</span><span class="nm">{card.book.name}</span>{#if card.others.length > 0}<span
            class="n">+{card.others.length}</span
          >{/if}<Ic n="caret" s={12} r={picking ? 'up' : 'dn'} /></button>
    {/if}
    {#if picking && card}
      <div class="dcw-menu" data-testid="dict-book-menu">
        <div class="dcw-mi on" data-testid="dict-book-current"><Ic n="check" s={16} /> {card.book?.name}</div>
        {#each card.others as o (o.id)}
          <div
            class="dcw-mi"
            role="button"
            tabindex="0"
            data-testid="dict-book-{o.id}"
            onclick={() => pick(o.id)}
            onkeydown={(e) => e.key === 'Enter' && pick(o.id)}>{o.name}</div>
        {/each}
        {#if card.others.length === 0}
          <div class="dcw-mi dim">只有这一本收了这个词</div>
        {/if}
      </div>
    {/if}
  </div>
</div>
