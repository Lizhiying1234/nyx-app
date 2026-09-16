<script lang="ts">
  import { CONSECUTIVE_FAIL_AT, CONSECUTIVE_FAIL_HINT } from '@core/ai/client.ts'
  import { AUTO_SYNC_ON_BOOT, SYNC_INCOMPLETE_TITLE } from '@core/sync/copy.ts'
  import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from '@core/silence.ts'
  import Skel from './Skel.svelte'
  import SplashRes from './SplashRes.svelte'
  import ColorRes from './ColorRes.svelte'
  import { say, sayBad } from './toast.svelte.ts'
  import PathPicker from './PathPicker.svelte'
  import type { TreeProject } from '@shared/api.ts'

  /**
   * Assist（使用者 2026-09-13）。★ **默认关** —— 这里不给任何乐观默认值：
   * 没读到就什么都不显示，而不是先画一个「关着」让他以为读到了。
   */
  type Assist = Awaited<ReturnType<typeof window.nyx.glance.get>>
  let assist = $state<Assist | null>(null)
  window.nyx.glance
    .get()
    .then((a) => (assist = a))
    .catch((e) => sayBad('读不出 Assist 的设置：' + cleanMessage(e)))

  /** 托盘那边改了模式 → 这一页跟着重读（否则他从托盘切完回来看到的是旧的） */
  $effect(() =>
    window.nyx.glance.onChanged(() => {
      window.nyx.glance
        .get()
        .then((a) => (assist = a))
        .catch(() => {
          /* 读不回来就保持原样：下次他点任何一档都会刷新 */
        })
    })
  )

  /** 路径选择器要一棵树 —— 只在 Assist 这一页要，进来才读 */
  let assistTree = $state<TreeProject[]>([])
  window.nyx.data
    .tree()
    .then((t) => (assistTree = t))
    .catch(() => {
      /* 读不出来就只是选不了位置，不影响这一页别的东西 */
    })

  async function setLecture(id: number): Promise<void> {
    try {
      assist = await window.nyx.glance.setLecture(id)
      say('以后收下的东西就进这个 Lecture')
    } catch (e) {
      sayBad('没设成：' + cleanMessage(e))
    }
  }

  /**
   * ══ 开 / 关（使用者 2026-09-14 第二条）══════════════════
   *
   * 他的原话：「开关不明显……用户不容易理解当前 Assist 是否开启，
   * 以及当前使用的是哪一种模式。」
   *
   * ★ 开 → **他选的那一档**（`assist.kind`）。使用者 2026-09-14 晚把
   *   Point 和 Glance 定成两个互斥的模式，所以「开成哪一种」这个问题又回来了。
   *   不写死 `glance`：他把 Point 选成常用的那一档时，开关一推却给他开了划词，
   *   那是软件替他改了设置。和桌面那枚悬浮图标同一条规矩。
   */
  const setOn = (on: boolean): Promise<void> => setAssist(on ? (assist?.kind ?? 'glance') : 'off')

  /**
   * ★★ 选模式。**关着的时候也能选**，选完不会自己打开。
   *
   * 使用者 2026-09-14 晚：「Point / Glance 的具体模式选择仍然在 Assist 设置中进行。
   * 桌面悬浮图标本身不负责在 Point 和 Glance 之间切换。」
   * ★ 关着时选一种，库里只改 `glance.lastMode`（走 `setAssist('off')` 存不了它）——
   *   所以这里先本地记下，真正落库在他推开关那一下。
   */
  async function setKind(k: 'glance' | 'point'): Promise<void> {
    if (!assist) return
    if (assist.mode !== 'off') return void (await setAssist(k))
    assist = { ...assist, kind: k }
  }

  /** 桌面上那颗悬浮球显不显示。★ 一个关不掉的置顶物件太霸道，所以给一个开关 */
  async function setBubble(on: boolean): Promise<void> {
    try {
      assist = await window.nyx.glance.setBubble(on)
    } catch (e) {
      sayBad('没改成：' + cleanMessage(e))
    }
  }

  async function setAssist(mode: Assist['mode'], blocked?: string): Promise<void> {
    try {
      assist = await window.nyx.glance.set(mode, blocked ?? assist?.blocked ?? '')
      /**
       * ★ 起没起来要**照实说**。`running` 是主进程回来的真状态，不是我们想要的状态 ——
       *   以为开着其实没开，比关着更糟：他会以为选中没反应是软件坏了。
       */
      if (mode === 'glance' && !assist.running) {
        sayBad('开关存下了，但没盯起来 —— 看一眼日志（Settings → Data → 打开日志文件夹）')
      }
    } catch (e) {
      sayBad('没改成：' + cleanMessage(e))
    }
  }
  import { slide } from 'svelte/transition'
  import { fold } from './motion'
  import type {
    AiSettings,
    DataInfo,
    DictRow,
    Failure,
    ParamRow,
    ProviderPreset,
    ReadingFacesState,
    SelfTest,
    Slot,
    SyncStatus,
    TtsSettings,
    TutorRow,
    GenreRow,
    QTypeRow,
    AuditReport
  } from '@shared/api.ts'
  import { cleanMessage, parseFailure } from '@shared/api.ts'
  import { registerEsc } from './esc-stack.svelte.ts'
  /** D-484 · 页面引导：这一页问一条（B-3）· 数据那格能把「看过」表清掉 */
  import { askGuide, resetGuides } from './guide.svelte.ts'
  import { speak } from './speak.ts'
  import Ic from './Ic.svelte'
  import Kit from './Kit.svelte'
  // D-466 · 两档的名字只有 core 一份（界面、日志、账本共用）
  import { SOURCE_LABEL } from '@core/voice/types.ts'
  import type { VoiceTrace } from '@core/voice/types.ts'
  /**
   * D-482 · 出题规则那七个选项的屏上字也只有 core 一份
   * （COPY_RULES CR-7：同一件事两端一个说法）。
   */
  import {
    CONTEXT_SPREAD_SAYS,
    FACE_PICK_SAYS,
    PRACTICE_FACE_SAYS,
    PRACTICE_HINT_SAYS,
    READING_HINT_SAYS,
    READING_QTYPE_SAYS,
    type PracticeFace,
    type PracticeRules,
    type ReadingQType,
    type ReadingRules
  } from '@core/quiz-rules.ts'

  let {
    onsaved,
    onreplayOnboarding
  }: {
    onsaved?: () => void
    /**
     * 「再看一次新手引导」（SC-25 · D-483）。
     * ★ 引导那一层挂在 `App.svelte` 上，不在这一页里 —— 它要盖住**整个主窗**，
     *   而设置页只是主区里的一块。所以这儿只喊一声，由外壳去开。
     */
    onreplayOnboarding?: () => void
  } = $props()

  type View =
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | { k: 'ok'; s: AiSettings; providers: ProviderPreset[] }

  let view = $state<View>({ k: 'loading' })
  let tab =
    $state<'ai' | 'tutor' | 'practice' | 'tts' | 'sync' | 'dict' | 'data' | 'res' | 'assist'>('ai')

  /**
   * D-484 · B-3 · **进了 Settings › Assist 这一页就讲一句**（I-190 / T-1f）。
   *
   * ══ 这一条的触发和确认单表 B 写的不是同一件事 ★★（这是我判的，D-413）══
   *
   * 表 B 的触发列写的是「首次遇到那个**禁用态**」，而那个禁用态在**查词卡**上；
   * 表 B 的位置列写的却是 **Settings › Assist 的那一项**。两件事在**两块屏**上 ——
   * 在查词卡上问的话，浮层要量的目标在另一页，屏上一个字都画不出来。
   * 所以讲的地方是这一页。
   *
   * ★ 原来还多一道门：`assist.lecture` 已经设过就不讲。**去掉了**（I-190）——
   *   这一层讲的是「这一项是干什么的」，那件事**设过的人一样需要知道**；
   *   而且「设过就不讲」意味着：先设好再点进来的人，永远听不到这句话。
   */
  $effect(() => {
    if (tab !== 'assist') return
    if (!assist) return
    /**
     * ★ 这一页两条（CR-3 放宽后的上限）：先问「这个能力是什么」，
     *   再问「收下来放哪儿」—— 顺序就是他第一次读这一页的顺序。
     *   一次只出一条，后到的那条下次进来再出。
     */
    void askGuide('capture-entry')
    void askGuide('assist-lecture')
  })

  /** D-484 · 清单 12 · 进 Prompt 那一区就说一句「这儿管 AI 按什么来」（T-2） */
  $effect(() => {
    if (tab !== 'tutor') return
    void askGuide('prompt-area')
  })

  /**
   * ★ 「资源」下面的二级（使用者 2026-09-09：「资源下面再有对应的下级功能，
   *   目前先加入：资源 → 启动页」）。
   *   今天只有一项 —— 但**二级这一层现在就搭出来**，因为他明说了后面还会加；
   *   等有第二项时再补一层，那时候要动的就是每一处引用了。
   */
  let resPage = $state<'splash' | 'colors'>('splash')

  /**
   * ★★ D-488（使用者 2026-09-15）· Prompt 这一页的**两级**。他给的树就是判据：
   *
   *     Prompt ├─ 文件学习（体裁 ↔ AI 导师）└─ 练习（认读测试 ↔ 产出练习）
   *
   * 两级都是**平级切换**，不是父子折叠。原来这一页是四块平铺，而且
   * 「体裁 / 产出练习」是折叠、「认读测试」是常开 —— 两个本该平级的东西
   * 长得完全不一样，正是他点名的「看起来像父子关系、实际上是平级功能的布局」。
   *
   * ★★ 一个变量就够（2026-09-15 使用者「你可以设计一下」之后改的）：
   *   第一版是两级 Tab，得记「在哪个区」+「每个区各停在哪个 Tab」三个变量。
   *   改成左侧树之后**一次点击就能到任何一片叶子**，跨区不用先切区 ——
   *   于是「每个区各记一个」那套复杂度**是上一个形态自己造出来的**，跟着形态一起删掉。
   *   ★ 这也是判断新形态好不好的一条硬证据：连用例里的导航都从两下点击变成一下。
   * ★ 只是这一页的**视图状态**，不落库、不进键面（D-488 边界：键面一字不改）。
   */
  let pTab = $state<'genre' | 'tutor' | 'reading' | 'produce'>('genre')
  /**
   * ★ 一级（文件学习 / 练习）**从 `pTab` 推出来**，不另存一个变量：
   *   两个变量就有「它俩说的不是同一件事」的那一天，而那天屏上会是空白。
   */
  const pArea = $derived(pTab === 'genre' || pTab === 'tutor' ? 'study' : 'drill')

  /** 编辑中的表单。key 单独放 —— 界面永远拿不到已存的 key，留空表示不动它。 */
  let form = $state<Record<Slot, { baseUrl: string; model: string; apiKey: string }>>({
    heavy: { baseUrl: '', model: '', apiKey: '' },
    light: { baseUrl: '', model: '', apiKey: '' },
    long: { baseUrl: '', model: '', apiKey: '' }
  })
  let split = $state(false)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let saved = $state(false)
  let testing = $state<Slot | null>(null)
  let testOk = $state<{ slot: Slot; ms: number } | null>(null)
  let testFail = $state<{ slot: Slot; failure: Failure | null; message: string } | null>(null)

  const SLOT_LABEL: Record<Slot, string> = { heavy: '重任务', light: '轻任务', long: '长上下文' }
  const SLOT_DESC: Record<Slot, string> = {
    heavy: '材料分析 · 四档判分 · 逐处标注 · 攻坚诊断 · 结算总评。质量决定整套机制成不成立，值得用最强的',
    light: '摘要解析 · 分寸辨析 · 例句补充 · 题目生成。量大、要求低，用便宜的',
    long: '深挖对话 · 任务链 · 文件 Tutorial。需要长窗口'
  }

  async function load(): Promise<void> {
    try {
      const [s, providers] = await Promise.all([
        window.nyx.ai.settings(),
        window.nyx.ai.providers()
      ])
      split = s.split
      for (const k of ['heavy', 'light', 'long'] as Slot[]) {
        form[k] = { baseUrl: s.slots[k].baseUrl, model: s.slots[k].model, apiKey: '' }
      }
      view = { k: 'ok', s, providers }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }
  load()

  function applyProvider(slot: Slot, p: ProviderPreset): void {
    form[slot].baseUrl = p.baseUrl
    if (!form[slot].model) form[slot].model = p.models[0] ?? ''
  }

  async function save(): Promise<void> {
    saving = true
    saveError = null
    saved = false
    try {
      const s = await window.nyx.ai.save({
        split,
        slots: {
          heavy: { ...form.heavy, protocol: 'auto' },
          light: { ...form.light, protocol: 'auto' },
          long: { ...form.long, protocol: 'auto' }
        }
      })
      if (view.k === 'ok') view = { ...view, s }
      for (const k of ['heavy', 'light', 'long'] as Slot[]) form[k].apiKey = ''
      saved = true
      onsaved?.()
    } catch (err) {
      saveError = cleanMessage(err)
    } finally {
      saving = false
    }
  }

  async function test(slot: Slot): Promise<void> {
    testing = slot
    testOk = null
    testFail = null
    try {
      const r = await window.nyx.ai.testConnection(slot)
      testOk = { slot, ms: r.ms }
    } catch (err) {
      testFail = { slot, failure: parseFailure(err), message: cleanMessage(err) }
    } finally {
      testing = null
    }
  }

  const shownSlots = $derived<Slot[]>(split ? ['heavy', 'light', 'long'] : ['heavy'])

  // ── D-179 机制参数 · D-206 数据 ─────────────────────────────
  let params = $state<ParamRow[]>([])
  let advanced = $state(false)

  /**
   * ★ M-3（2026-09-03 · 使用者「可以」）· **全页共用一套折叠**
   *
   * 审计（`WINDOWS_SETTINGS_AUDIT.md`）的结论是：Windows 的病不是功能多余，
   * 是**该分层的地方没分层** —— 8 个 Tab 平铺、约 80 个控件同一个视觉平面。
   * 而 §一·六 量到的病根是「17 个各写各的展开开关、0 个共享组件」。
   *
   * 所以这里**只加一份状态**，标记谁是收起的；标记走已经存在的 `.fold-head`
   * （词条详情 / 文件学习 / 项目页早就在用），**不新发明第四套**。
   *
   * ★ 默认收起的判据：**低频 + 配好就不用再看**。
   *   导师那一块默认展开（它是这个 Tab 的主体），体裁/题型收起；危险操作收起。
   *
   * ★ T-7.7 · `ttsProvider` 退了：「声音」页的提供者清单现在是**一份表**
   *   （按注册表渲染，每家一行状态 / 协议），收起来等于把「这台电脑上
   *   哪一家能用」藏起来 —— 而那正是他一进这一页要看的东西。
   */
  /**
   * ★ D-488 起这里只剩 `danger` 一个：「体裁 / 产出练习」两个折叠被二级 Tab 取代了。
   *   名单跟着控件一起摘 —— 留着的话它就是一条哑路：读得到、写得进、屏上没有任何东西用它。
   */
  let folded = $state<Record<string, boolean>>({ danger: true })
  const isFolded = (k: string): boolean => folded[k] === true
  const toggleFold = (k: string): void => {
    folded = { ...folded, [k]: !folded[k] }
  }
  let dataInfo = $state<DataInfo | null>(null)
  let backupNote = $state<string | null>(null)

  const val = (k: string): number => params.find((p) => p.key === k)?.value ?? 0
  const mb = (b: number): string =>
    b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`

  async function loadParams(): Promise<void> {
    try {
      params = await window.nyx.params.list()
      dataInfo = await window.nyx.store.info()
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }
  loadParams()

  async function setParam(key: string, value: number): Promise<void> {
    try {
      await window.nyx.params.set(key, value)
      await loadParams()
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }

  async function resetParams(): Promise<void> {
    saveError = null
    try {
      await window.nyx.params.reset()
      await loadParams()
    } catch (err) {
      // 没还原成就是没还原成：参数保持原样，说清楚为什么
      saveError = `参数没能还原成默认值：${cleanMessage(err)}`
    }
  }

  /**
   * ★ 动作账本（`ops_log`）· 2026-09-03 补上查看入口
   *
   * **这是在补一条断链，不是新功能。** 同步完成后界面会对他说一句
   * 「**旧的那版记在账本里**」（`core/sync/engine.ts`，D-438），
   * 引擎注释里还写着「他随时查得回来」—— 而在这之前**没有任何地方能查**：
   * `ledger.ops` 这个口零调用方。软件承诺了一件它做不到的事。
   *
   * ★ D-438 那条安全网（不打扰他，但绝不悄悄弄丢他写的字）**就靠这本账**，
   *   所以修法是把入口补上，不是把那句话收回。
   * ★ 默认收起、点开才拉：这是「出事之后来翻」的东西，不是每天要看的。
   */
  let opsOpen = $state(false)
  /** 样式一览（设置 › 数据）—— 开发与设计确认用的实物页，默认收起 */
  let kitOpen = $state(false)
  let ops = $state<{ id: number; op: string; target: string; title: string | null; at: number }[]>([])
  let opsError = $state<string | null>(null)
  let opsLoaded = $state(false)

  async function loadOps(): Promise<void> {
    opsError = null
    try {
      ops = await window.nyx.ledger.ops()
      opsLoaded = true
    } catch (err) {
      opsError = cleanMessage(err)
    }
  }

  function toggleOps(): void {
    opsOpen = !opsOpen
    if (opsOpen && !opsLoaded) void loadOps()
  }

  /**
   * ★ T-2.5 / D-R4 · 还原账本里被盖掉的那一版。
   *
   * 判据与写回都在主进程（core 判据 + 引擎的关系翻译）；这里只做三件事：
   * 记住哪一行正在还原、把结果那句话放在**那一行自己下面**、成功了重取列表。
   * ★ 拒绝不是异常 —— `{ ok:false, why }` 原样显示，不当错误弹。
   */
  let opRestoring = $state<number | null>(null)
  let opSaid = $state<{ id: number; ok: boolean; text: string } | null>(null)

  async function restoreOp(id: number): Promise<void> {
    opRestoring = id
    opSaid = null
    try {
      const out = await window.nyx.ledger.restore(id)
      if (out.ok) {
        opSaid = { id, ok: true, text: '还原好了 —— 它会在下一次同步时传给另一台设备。' }
        await loadOps()
      } else {
        opSaid = { id, ok: false, text: out.why }
      }
    } catch (err) {
      opSaid = { id, ok: false, text: cleanMessage(err) }
    } finally {
      opRestoring = null
    }
  }

  /** 账本里那些内部动作名，给他看的时候换成人话 */
  const OP_SAYS: Record<string, string> = {
    'sync-override': '同步时两边都改过 —— 按时间新的那版定了，这是被盖掉的那版',
    'sync-restore': '还原了同步时被盖掉的那一版',
    compact: '整理云端 —— 把历史记录合并成一份存档，彻底删掉的内容不再留在云端',
    purged: '彻底删除',
    // ★ 少了这一行，账本页上就摆着一个内部名 `lookup`（H 抓到，2026-09-07 补）
    lookup: '查了这个词',
    drop: '不再收录这个知识点',
    restore: '从回收站恢复',
    silence: SILENCE_ACTIONS.shelve,
    unsilence: SILENCE_ACTIONS.restore
  }

  // ── 语音 · D-466（两个开关：词典语音 · 系统语音）──────────────
  /**
   * ★★★ 一开始是 `null` —— **读到之前，界面上没有任何值可以被送出去。**
   *
   * ── 这里原来是一份编出来的初值，它真的伤过人 ────────────────
   *
   * 原来写的是 `{ cloud:false · baseUrl:'' · model:'tts-1' · voice:'alloy' }`，
   * 而 `loadTts()` 是 async、**没人等它**。这一页是**整包写回**的：
   * 在它回来之前点任何一个控件（哪怕只是切个口音），送上去的就是这份假初值 ——
   * 他填的地址、音色、模型被一次点击清成默认（会话 B 查出，2026-09-07）。
   *
   * ★ 修法不是「点之前先判断一下」，而是**让那份假数据根本不存在**：
   *   类型上就是 `TtsSettings | null`，没读到就渲染不出控件、`saveTts` 也进不去。
   * ★ D-466 之后这一页只剩四个值，但这条纪律照留：两个开关一样是「整包写回」，
   *   拿假初值覆盖 = 他关掉的词典音会自己变回开着。
   */
  let tts = $state<TtsSettings | null>(null)
  let ttsNote = $state<string | null>(null)
  /** 上次朗读走了谁、为什么不是别人（D-219 的那一行账） */
  let voiceTrace = $state<VoiceTrace | null>(null)

  async function loadTts(): Promise<void> {
    try {
      tts = await window.nyx.tts.settings()
      await loadTrace()
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }
  loadTts()

  async function loadTrace(): Promise<void> {
    try {
      voiceTrace = await window.nyx.tts.lastTrace()
    } catch {
      // 账本取不到不算错 —— 它是诊断用的，不该把整页拖红
      voiceTrace = null
    }
  }

  /** 两档的名字 —— 从 core 那一份来，界面不自己起名（D-238） */
  const srcLabel = (id: string): string => SOURCE_LABEL[id as keyof typeof SOURCE_LABEL] ?? id

  const KIND_SAYS: Record<string, string> = {
    word: '一个词',
    phrase: '一个短语',
    sentence: '一句话',
    passage: '一整段'
  }
  const clock = (at: number): string =>
    new Date(at).toLocaleTimeString('sv', { hour: '2-digit', minute: '2-digit' })

  /**
   * ★★★ 还没读到就**什么都不送**。
   *
   * 控件在 `tts === null` 时压根不渲染，所以正常路径走不到这里；
   * 这一句是兜底 —— 真走到了说明有人在数据到位之前就画了控件，
   * 那时候「送出去」= 拿编出来的默认值覆盖他真正的设置。
   * 宁可这一下点了没反应，也不能把他关掉的开关自己打开。
   *
   * ★★ **逐个字段列出来，不用 `{ ...tts }`**：`tts` 是 Svelte 的 `$state`，
   *   将来往 `TtsSettings` 上加了数组字段，Proxy 过不了 contextBridge，
   *   报的是「An object could not be cloned」，于是**口音、语速点了都存不进去**
   *   （2026-09-07 就这么弄坏过一次，smoke 当场抓到）。
   */
  /**
   * ★ B7 / ST-Q6 · **开关有三态**：开 · 关 · **正在生效**。
   *   在这之前这里是「点了先把界面改掉，然后去存」——
   *   存的那一下要等一次 IPC，而屏幕上**什么都没有**；存失败了界面还停在新位置上，
   *   于是「我明明关掉了它怎么还开着」这种事只能等下次进设置才发现。
   *   现在：切的过程中开关进 `busy`（滑块居中、按不动），失败**弹回原位**并说一句。
   */
  let swBusy = $state<string | null>(null)

  async function saveTts(patch: Partial<TtsSettings>, which = 'tts'): Promise<void> {
    if (!tts) return
    const before = tts
    const now = { ...tts, ...patch }
    tts = now
    swBusy = which
    saveError = null
    try {
      await window.nyx.tts.save({
        dictionary: now.dictionary,
        system: now.system,
        accent: now.accent,
        rate: now.rate
      })
      /**
       * ★ 一律回读 —— 界面显示的必须是**真的存进去的那份**，
       *   而不是**我发出去的那份**（I-156 那一类事故的形状）。
       */
      tts = await window.nyx.tts.settings()
    } catch (err) {
      tts = before // ★ 弹回原位：界面上的开关必须和库里那一份一致
      saveError = `没改成：${cleanMessage(err)}`
    } finally {
      swBusy = null
    }
  }

  async function tryTts(): Promise<void> {
    saveError = null
    try {
      // 试听用的句子刻意带连读和弱读 —— 系统语音和词典音的差别在这种句子上才听得出来
      ttsNote = (await speak('The gap between what you can read and what you can write is the whole point.')) || '读出来了。'
      // 读完就把账刷出来 —— 试听的意义就在于「看它这一趟走了谁」
      await loadTrace()
    } catch (err) {
      saveError = `试听没成：${cleanMessage(err)}`
    }
  }

  // ── D-150 / D-151 / D-234 · 本地词典 ────────────────────────
  let dictRows = $state<DictRow[]>([])
  /**
   * ★ D-470（2026-09-07）· 「随便查一个词试试」那个探针取消了（使用者点名）。
   *   这里只剩「重新扫描」的回执 —— 原来它和探针结果共用一个位（`probeResult`），
   *   探针没了之后单独一个名字，免得下一个人以为这里还会显示查词结果。
   *   「词典真的接上了没」由 Lookup 页与悬浮卡本身回答。
   */
  let dictNote = $state<string | null>(null)

  async function loadDicts(): Promise<void> {
    try {
      dictRows = await window.nyx.dict.list()
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }
  loadDicts()

  async function rescanDicts(): Promise<void> {
    try {
      dictRows = await window.nyx.dict.rescan()
      dictNote = `扫到 ${dictRows.filter((d) => !d.missing).length} 本。`
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }

  async function toggleDict(id: number, on: boolean): Promise<void> {
    saveError = null
    try {
      // `dictRows` 只从返回值赋 —— 失败时列表原样不动，不会出现「界面开着、库里关着」
      dictRows = await window.nyx.dict.setEnabled(id, on)
    } catch (err) {
      saveError = `词典的${on ? '启用' : '停用'}没改成：${cleanMessage(err)}`
    }
  }

  async function moveDict(i: number, delta: number): Promise<void> {
    saveError = null
    const ids = dictRows.map((d) => d.id)
    const j = i + delta
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    try {
      // 换的是本地这份 `ids` 副本，`dictRows` 只从返回值赋 —— 没存成，界面上的顺序就不会动
      dictRows = await window.nyx.dict.reorder([...ids])
    } catch (err) {
      saveError = `词典顺序没存成：${cleanMessage(err)}`
    }
  }

  // ── D-201 · 云同步 ──────────────────────────────────────────
  let syncS = $state<SyncStatus | null>(null)
  let syncForm = $state({ kind: 'off' as SyncStatus['kind'], url: '', user: '', secret: '' })
  let syncBusy = $state(false)
  let syncNote = $state<string | null>(null)
  /** 有冲突时停在这里等使用者选 —— D-201 不静默覆盖 */
  let syncConflict = $state<string | null>(null)
  /** ★ R-4-F · 这一趟的真实四个数 —— 冲突提示里那两个数字不许写死 */
  let syncLast = $state<{ applied: number; conflicted: number } | null>(null)
  /** 跑完几次了。验收要能确定「这一次」结束了，而不是看见上一次留下的字 */
  let syncRuns = $state(0)

  async function loadSync(): Promise<void> {
    try {
      syncS = await window.nyx.sync.status()
      syncForm = { kind: syncS.kind, url: syncS.url, user: syncS.user, secret: '' }
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }
  loadSync()

  async function saveSync(): Promise<void> {
    try {
      syncS = await window.nyx.sync.save({ ...syncForm })
      syncForm.secret = ''
      syncNote = '存好了。点「测试连接」确认能通。'
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }

  /** I-042 · 一键同步的「零键」那一半 */
  async function toggleAuto(): Promise<void> {
    if (swBusy) return
    swBusy = 'auto'
    saveError = null
    try {
      syncS = await window.nyx.sync.setAuto(!syncS?.auto)
      syncNote = syncS.auto ? '开了 —— 以后每次开软件自己同一次。' : '关了，改成手动点。'
    } catch (err) {
      // ★ B7 · 这里本来就没有乐观更新，所以「弹回原位」= 什么都不改；要说的是那一句
      saveError = `没改成：${cleanMessage(err)}`
    } finally {
      swBusy = null
    }
  }

  async function testSync(): Promise<void> {
    syncBusy = true
    syncNote = null
    try {
      await window.nyx.sync.test()
      syncNote = '连得上。'
    } catch (err) {
      syncNote = null
      saveError = cleanMessage(err)
    } finally {
      syncBusy = false
    }
  }

  async function runSync(resolve?: 'remote' | 'local'): Promise<void> {
    syncBusy = true
    syncNote = null
    syncConflict = null
    try {
      const r = await window.nyx.sync.run(resolve)
      syncS = r
      syncLast = { applied: r.applied, conflicted: r.conflicted }
      /**
       * ★★ R-4-F · 冲突和结果**同时**显示 ——
       * 这一趟没冲突的那些是真的写进去、真的推上去了，
       * 所以那句话必须照常给他看，不能被冲突提示顶掉。
       */
      syncNote = r.lastNote
      syncConflict = r.conflictNote ?? null
    } catch (err) {
      saveError = cleanMessage(err)
    } finally {
      syncBusy = false
      syncRuns += 1
    }
  }

  // ── D-102 / D-232 · 导出与导回 ──────────────────────────────
  let expNote = $state<string | null>(null)

  async function doBackupFile(): Promise<void> {
    expNote = null
    try {
      const p = await window.nyx.exp.backup()
      expNote = p ? `完整备份写在：${p}　这个文件可以原样导回。` : null
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }

  async function doNotes(): Promise<void> {
    expNote = null
    try {
      const r = await window.nyx.exp.notes()
      expNote = r.path ? `笔记写在：${r.path}（${mb(r.bytes)}）　这是给人看的，不能导回。` : null
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }

  // ── I-051 · 清空全部学习数据 ────────────────────────────────

  /** I-113 · 这次启动对提示词做了什么 */
  let psync = $state<Awaited<ReturnType<typeof window.nyx.prompts.syncReport>>>(null)
  $effect(() => {
    void window.nyx.prompts
      .syncReport()
      .then((r) => (psync = r))
      .catch(() => (psync = null))
  })

  // ── 9.1 / 9.2 · 数据体检 ──────────────────────────────────
  /** 这几条 repair() 会自动修 —— 只有它们出现时才显示「修掉能修的」 */
  const FIXABLE = [
    'silent-but-due',
    'silent-lecture-due',
    'corrects-over-attempts',
    'silenced-by-orphan',
    'sync-uid-missing',
    'live-child-dead-parent',
    'quote-backfillable'
  ]
  let report = $state<AuditReport | null>(null)
  let auditing = $state(false)
  let auditErr = $state<string | null>(null)

  async function runAudit(): Promise<void> {
    auditing = true
    auditErr = null
    try {
      report = await window.nyx.health.audit()
    } catch (err) {
      auditErr = cleanMessage(err)
    } finally {
      auditing = false
    }
  }

  async function runRepair(): Promise<void> {
    auditErr = null
    try {
      const r = await window.nyx.health.repair()
      report = r.after
    } catch (err) {
      auditErr = cleanMessage(err)
    }
  }

  /**
   * 4.1 ·「不再收录的表达」名单已从这一页撤掉（使用者 2026-08-10）。
   *
   * 取数和撤销的代码一并去掉 —— 留一段没人调用的读取只会让人以为它还在工作。
   * 账本本身照常记（`term_ledger`），分析照常跳过，
   * 而且每次分析结束会明说「这几条以前删过 / 静默过，没收进来」。
   * `window.nyx.ledger.list / drop` 仍在契约里：要把这一块放回来，
   * 照着 git 历史里这一段还原即可。
   */

  /**
   * ── 危险操作 · 清除数据（★★ Q-3 · 2026-09-03 使用者裁「合并」）──────
   *
   * 这里原来是**两条各自独立的不可逆流程**：
   *
   *   「清空全部学习数据」  数据页按钮 · 展开一个框 + 一个勾选项 + 打「清空」
   *   「清除全部数据」      危险区 · 两阶段 + 手打 DELETE
   *
   * 重叠就重叠在那个勾选项上：勾了「连设置一起清」，第一条就约等于第二条，
   * **而确认的严格程度差一大截**。同样是「连 AI key 一起没」，
   * 走这条要手打 DELETE，走那条只要点一下勾选框 —— 这是个会出事的落差。
   *
   * 合并之后只有一条路、一个入口，改成**先选清到什么程度**：
   *
   *   learning  只清学习数据（设置留着）        确认词「清空」
   *   all       全部清掉（含 AI key 与全部设置）确认词  DELETE
   *
   * ★ 判据就是使用者那句：**凡是包含设置，就必须手打 DELETE。**
   * ★ 默认停在轻的那一档 —— 不可逆操作的默认值该是伤害最小的那个。
   *
   * ── 为什么中间那一档从界面上消失了 ──────────────────────────
   *
   * 原来 `wipe(remote, true)` 是「清学习数据 + 设置，但留着 TTS 音频 / 日志 /
   * 你改过的提示词」。而 `factoryReset` 连这些一起清（它要的是「像没装过」）。
   * 这个差别细到没有人会为它做选择，却正是「两条流程说不清区别」的来源。
   * 所以界面只留两档；`exp.wipe` 的第二个参数**仍在契约里**（不删能力，
   * 见 §二一「不允许因为可能没用了就直接删除」），只是不再有界面走它。
   *
   * ── 两阶段一个字没动（使用者 2026-08-10 点名要的）──────────
   *   ① 点按钮 → 弹确认（取消 / 继续），默认焦点在「取消」
   *   ② 点「继续」→ 要求手打确认词，完整匹配才允许执行
   * **主进程还会各自再判一次** —— 不可逆的操作不能只有一层闸。
   */
  type ResetLevel = 'learning' | 'all'
  let resetLevel = $state<ResetLevel>('learning')

  type ResetStage = 'idle' | 'confirm' | 'type'
  let resetStage = $state<ResetStage>('idle')
  let resetWord = $state('')
  let resetErr = $state<string | null>(null)
  let resetBusy = $state(false)
  let resetResult = $state<Awaited<ReturnType<typeof window.nyx.exp.factoryReset>>>(null)
  let resetRemote = $state(false)
  let dicts = $state<{ files: number; bytes: number; dir: string } | null>(null)

  /** 要打的确认词 —— **含设置就是 DELETE**（使用者定的判据） */
  const resetNeedWord = $derived(resetLevel === 'all' ? 'DELETE' : '清空')
  /** 只去首尾空白，其余完整匹配 —— 大小写、中间的空格都不放过 */
  const resetReady = $derived(resetWord.trim() === resetNeedWord)

  /**
   * ★ 换档就把已经打进去的字清掉。
   * 不然：在轻档打好「清空」→ 切到重档 → 确认词已经变成 DELETE，
   * 而输入框里还留着「清空」，按钮灰掉，他会以为是软件坏了。
   * 更糟的反向：任何一档要是把另一档的词当数，就等于确认闸漏了。
   */
  function setResetLevel(l: ResetLevel): void {
    resetLevel = l
    resetWord = ''
    resetErr = null
  }

  async function openReset(): Promise<void> {
    resetErr = null
    resetResult = null
    resetWord = ''
    resetLevel = 'learning'
    resetStage = 'confirm'
    try {
      dicts = await window.nyx.exp.dictsInfo()
    } catch {
      dicts = null
    }
  }

  function cancelReset(): void {
    resetStage = 'idle'
    resetWord = ''
    resetErr = null
  }

  async function doReset(): Promise<void> {
    resetErr = null
    if (!resetReady) {
      // 他点了但字没打对 —— 明确说出来，而且**什么都不做**
      resetErr = `确认文字不正确 —— 需要完整输入 ${resetNeedWord}（大小写要一致）。什么都没有删。`
      return
    }

    // ── 轻档：只清学习数据，设置留着。清完停在原地，不重启 ──
    if (resetLevel === 'learning') {
      resetBusy = true
      try {
        const r = await window.nyx.exp.wipe(resetRemote, false)
        if (!r) {
          resetBusy = false
          return // 主进程那道确认里点了取消
        }
        const n = Object.values(r.cleared).reduce((a, b) => a + b, 0)
        expNote = `清空了 ${n} 行学习数据（设置没动）。清空前的备份在：${r.backup}　—— 后悔了用「从备份导回…」。`
        resetStage = 'idle'
        resetWord = ''
        await loadParams()
      } catch (err) {
        resetErr = cleanMessage(err)
      } finally {
        resetBusy = false
      }
      return
    }

    // ── 重档：恢复出厂。做完自动重启 ──
    resetBusy = true
    try {
      const r = await window.nyx.exp.factoryReset(resetWord, resetRemote)
      if (!r) {
        // 主进程那道确认里点了取消
        resetBusy = false
        return
      }
      resetResult = r
      resetStage = 'idle'
      /**
       * 全部成功才自动重启 —— 重启会把这一页连同结果一起冲掉，
       * 而**失败的那几步他必须看得见**。所以有失败时停在这儿等他看完。
       */
      if (r.ok) {
        /**
         * ★ H-4b · 这一句在 `setTimeout` 里 —— 外面那层 try **接不到它**
         * （真抛的时候那个 try 早就出栈了）。重启没成而他以为成了，
         * 下次打开看到的还是旧数据，会以为重置失败。所以自己接。
         */
        setTimeout(() => {
          window.nyx.exp.relaunch().catch((err: unknown) => {
            resetErr = `重置做完了，但自动重启没成：${cleanMessage(err)}。请手动关掉再打开一次。`
          })
        }, 1800)
      }
    } catch (err) {
      resetErr = cleanMessage(err)
    } finally {
      resetBusy = false
    }
  }

  // ★ Q-3 合并：`doWipe` 与它专属的 `wipeRemote` / `wipeSettings` 已并进 `doReset`
  //   （轻档走 `exp.wipe`，重档走 `exp.factoryReset`）。连云端一起清那个开关两档共用
  //   `resetRemote` —— 它问的是同一件事，本来就不该有两个。

  async function doRestore(): Promise<void> {
    expNote = null
    try {
      // 成功的话主进程会直接重启，这里的返回值多半看不到
      const r = await window.nyx.exp.restore()
      if (r) expNote = `导回完成，导回前的数据备份在：${r.safetyBackup}`
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }

  // D-265 · 自检。使用者零编程经验，「我说做好了」不如「他自己点一下看得见」
  let selfTest = $state<SelfTest | null>(null)
  const COUNT_ZH: Record<string, string> = {
    projects: '项目',
    units: '单元',
    lectures: 'Lecture',
    materials: '材料',
    items: '知识点',
    occurrences: '原文出处'
  }

  async function runSelfTest(): Promise<void> {
    selfTest = null
    try {
      selfTest = await window.nyx.app.selfTest()
    } catch (err) {
      saveError = cleanMessage(err)
    }
  }

  async function backupNow(): Promise<void> {
    backupNote = null
    try {
      const p = await window.nyx.store.backupNow()
      backupNote = `备好了：${p}`
      await loadParams()
    } catch (err) {
      backupNote = null
      saveError = cleanMessage(err)
    }
  }

  // ── R-005 · 多导师 ──────────────────────────────────────────
  let tutors = $state<TutorRow[]>([])
  let editTutor = $state<(Partial<TutorRow> & { name: string }) | null>(null)
  let tutorError = $state<string | null>(null)

  const NEW_TUTOR = (): Partial<TutorRow> & { name: string } => ({
    name: '',
    persona: '',
    strictness: 7,
    taskDensity: 5,
    answerTiming: 'after',
    freePrompt: ''
  })

  async function loadTutors(): Promise<void> {
    try {
      tutors = await window.nyx.files.tutors()
    } catch (err) {
      tutorError = cleanMessage(err)
    }
  }
  loadTutors()

  // ── 5.2 · 体裁。和导师同一套增删改 ────────────────────────
  //
  // 分工：**导师决定口吻**（Enlighten 用），**体裁决定出什么问题**（Quest 用）。
  let genres = $state<GenreRow[]>([])
  let editGenre = $state<(Partial<GenreRow> & { name: string }) | null>(null)
  let genreError = $state<string | null>(null)

  async function loadGenres(): Promise<void> {
    try {
      genres = await window.nyx.files.genres()
    } catch (err) {
      genreError = cleanMessage(err)
    }
  }
  loadGenres()

  function newGenre(): void {
    editGenre = { name: '', prompt: '' }
  }

  async function saveGenre(): Promise<void> {
    if (!editGenre) return
    genreError = null
    if (!editGenre.name.trim()) {
      genreError = '体裁得有个名字 —— 下拉框里要靠它认。'
      return
    }
    try {
      await window.nyx.files.saveGenre({ ...editGenre })
      editGenre = null
      await loadGenres()
    } catch (err) {
      genreError = cleanMessage(err)
    }
  }

  async function delGenre(): Promise<void> {
    if (!editGenre?.uid) return
    genreError = null
    try {
      await window.nyx.files.deleteGenre(editGenre.uid)
      editGenre = null
      await loadGenres()
    } catch (err) {
      genreError = cleanMessage(err)
    }
  }

  /**
   * ── 认读测试：**牌面 + 出题规则** · D-479（使用者 2026-09-08）───────
   *
   * 09-03 立：「认读测试也应该拥有自己的 Prompt。」
   * 09-04 改形：「作为一个普通的设置项，点击之后弹出一个专门的弹窗。」
   * ★ 09-08 再改：**牌面是可以多选的内容模块，出题规则是一份统一的 Prompt** ——
   *   「以后想加一个牌面，就只是加一个模块」。
   *
   * 所以这一页从「一份名单（五份选一份）」变成**两颗入口**：
   *   「牌面」   勾选面：每行一个牌面，多选，至少留一个
   *   「出题规则」弹窗编辑整份规则，可改回出厂
   * 判据与拼装全在 `core/reading-face.ts`，这一层只管派活和显示。
   */
  let readState = $state<ReadingFacesState | null>(null)
  let facesOpen = $state(false)

  /**
   * ══ 新建 / 改 / 删一个自建牌面（使用者 2026-09-14 第一条）══════════
   *
   * 他的原话：「认读测试的牌面目前没有明显的『新建牌面』入口。请检查这里的
   * 功能是否缺失，并补上：增加『新建牌面』功能。用户应该能够在这里直接创建
   * 新的认读测试牌面。」
   *
   * ★ 查过了，**确实缺**（不是藏起来了）：`READING_FACES` 是 core 里一张写死的
   *   四条表，界面上只能勾 / 不勾。「加一个牌面」一直是**改代码**才能做的事 ——
   *   而那张表头上的注释自己写着「加一个牌面 = 往 READING_FACES 里加一条」，
   *   说的正是我改代码，不是他。
   * ★ 出厂那四面**改不了也删不了**：它们是两端共用的判据（同一份 core，
   *   Android 也在用）。改一面就等于让同一张认读卡在两台机器上考法不一样。
   *   不想用就把它关掉 —— 那是本来就有的动作。
   */
  let faceEdit = $state<{ id?: string; name: string; says: string; guide: string } | null>(null)
  let faceBusy = $state(false)

  const newFace = (): void => {
    readError = null
    faceEdit = { name: '', says: '', guide: '' }
  }

  const editFace = (f: { id: string; name: string; says: string; guide?: string }): void => {
    readError = null
    faceEdit = { id: f.id, name: f.name, says: f.says, guide: f.guide ?? '' }
  }

  async function submitFace(): Promise<void> {
    if (!faceEdit || faceBusy) return
    faceBusy = true
    readError = null
    try {
      readState = await window.nyx.prompts.saveCustomFace($state.snapshot(faceEdit))
      faceEdit = null
      say('存好了 —— 下一张认读卡就可能用到它')
    } catch (e) {
      /** ★ 校验的话（名字太长 / 没写给 AI 那段）就地说，别飘走：他正对着这个表单 */
      readError = cleanMessage(e)
    } finally {
      faceBusy = false
    }
  }

  async function removeFace(id: string): Promise<void> {
    readError = null
    try {
      readState = await window.nyx.prompts.deleteCustomFace(id)
      say('删掉了')
    } catch (e) {
      readError = cleanMessage(e)
    }
  }
  let rulesOpen = $state(false)
  /**
   * ★★ D-482（使用者 2026-09-15）· 出题规则从**写正文**改成**点选项**。
   *   正文那条路退役：`prompt.reading-card` 一行不删，他以前写的那段在弹窗里
   *   只读可看（`readState.legacy`），但不再参与出题 —— 两个真相里只能留一个。
   *   出厂值、每一档拼哪句、哪一档什么都不拼，全在 `core/quiz-rules.ts`。
   */
  const setReadOption = (patch: Partial<ReadingRules>): void => {
    void readAct(() => window.nyx.prompts.saveReadingOptions(patch), '存好了。下一张认读卡就按新规则出。')
  }
  /** 勾没勾「场景补全」—— R-3 只对那一面有意义，没勾就变灰（不隐藏） */
  const scenarioOn = $derived(!!readState?.faces.find((f) => f.id === 'scenario')?.on)

  /**
   * ══ D-486 · 三层 × 两模式（使用者 2026-09-15 第二 / 三 / 六条）★★★ ══
   *
   * 他的原话：三层「不能在 UI 中看起来像同一种东西」，而且两个模式**结构对应**。
   * 所以这一页从此是**两块 × 三段**，段序 · 段名 · 每一段的界面形态两边完全一致：
   *
   *     牌面     预览卡（看得见这张卡最后长什么样）
   *     题型     任务行（一行一个动作）
   *     出题规则 弹窗（点进去配，配完关掉）
   *
   * 唯一不一样的是**选择方式**，而它在控件上一眼看得出（确认单 §三）：
   *   认读牌面多选（勾选角标）· 产出牌面单选（选中描边）
   *   认读题型单选（单选圆点）· 产出题型多选（勾选框）
   * ★ 那不是随便定的：**内容多来几种是复习，交互与排版多来几种是找不着北。**
   */
  const setReadQType = (v: ReadingQType): void => {
    void readAct(() => window.nyx.prompts.saveReadingQType(v), '存好了。下一张认读卡就按这个来。')
  }

  /** 产出的牌面（D-486）。和那四个出题规则分开存 —— 它不进提示词 */
  let pFace = $state<PracticeFace | null>(null)

  async function setPracticeFace(v: PracticeFace): Promise<void> {
    qtypeError = null
    qtypeNote = null
    try {
      pFace = await window.nyx.study.savePracticeFace(v)
      qtypeNote = '存好了。下一道产出题就按这个摆。'
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }
  let readError = $state<string | null>(null)
  let readNote = $state<string | null>(null)

  /** 勾着几面 —— 入口那一行要显示，他才看得出自己现在用几种考法 */
  const facesOn = $derived(readState?.faces.filter((f) => f.on) ?? [])

  async function loadReadState(): Promise<void> {
    try {
      readState = await window.nyx.prompts.readingFaces()
    } catch (err) {
      readError = cleanMessage(err)
    }
  }
  void loadReadState()

  /**
   * 每个动作都长一个样：清掉上一次的话 → 派活 → 拿新状态回来 → 说一句。
   * ★ 失败一律显示在**弹窗内部**（H-4c：每个按钮自己该说什么话，各自写）。
   */
  async function readAct(run: () => Promise<ReadingFacesState>, ok: string): Promise<void> {
    readError = null
    readNote = null
    try {
      readState = await run()
      readNote = ok
    } catch (err) {
      readError = cleanMessage(err)
    }
  }

  /**
   * 勾 / 取消一面。★ **主进程那边会拒绝「一面都不勾」** —— 这里不自己拦：
   *   判据只有一处（`reading:saveFaces`），界面再判一遍就是第二份判据。
   *   被拒了就把那句人话显示出来。
   */
  function toggleFace(id: string): void {
    const next = (readState?.faces ?? []).map((f) => ({ id: f.id, on: f.id === id ? !f.on : f.on }))
    void readAct(() => window.nyx.prompts.saveReadingFaces(next), '存好了。下一张认读卡就按这几面出。')
  }

  function openFaces(): void {
    readError = null
    readNote = null
    facesOpen = true
    void loadReadState()
  }

  function openRules(): void {
    readError = null
    readNote = null
    rulesOpen = true
  }

  const closeReading = (): void => {
    facesOpen = false
    faceEdit = null
    rulesOpen = false
  }

  /** ★ D-440 · 弹窗归 Esc 栈管，和别的浮层同一条路 */
  $effect(() => (facesOpen || rulesOpen ? registerEsc(() => (closeReading(), true)) : undefined))

  // ── 题型管理 · 使用者「产出练习题型系统」 ──────────────────
  //
  // 「像现有的 Lumen（导师）和体裁一样，支持题型的增 / 删 / 改。
  //   每个题型都有自己的提示词（用户可自己写）。支持启用/禁用。」
  //
  // 三者摆在同一页，因为它们分工不同但都是「AI 按什么来」：
  //   导师 = 口吻（Enlighten）· 体裁 = 问什么（Quest）· 题型 = 怎么考（产出练习）
  /** 题型表（D-478 之后身上没有档位了；顺序就是出题轮转的顺序） */
  let qtypes = $state<QTypeRow[]>([])
  let editQtype = $state<(Partial<QTypeRow> & { name: string }) | null>(null)
  let qtypeError = $state<string | null>(null)
  let qtypeNote = $state<string | null>(null)

  /**
   * ★★ 写作层的四个出题规则选项（D-482）。和题型表在同一块屏上，
   *   所以跟着同一次请求回来 —— 分两次只会让屏上出现「选项还没到」的一瞬。
   * ★ 出厂值**不在这里写第二份**：拿不到就先不画那一块（判据只有 core 一处）。
   */
  let pRules = $state<PracticeRules | null>(null)
  /**
   * ★★ 使用者 2026-09-15 第四条：**出题规则统一用弹窗**，不要和牌面、题型平铺在一起
   *   （原话 `docs/指令-2026-09-15-认读与产出·UI与出题配置重新设计.md`）。
   *   认读那边本来就是弹窗，这里跟上 —— 两个模式的这一步从此长一个样。
   */
  let pRulesOpen = $state(false)
  const openPracticeRules = (): void => {
    qtypeError = null
    qtypeNote = null
    pRulesOpen = true
  }
  /** ★ D-440 · 弹窗归 Esc 栈管，和别的浮层同一条路 */
  $effect(() => (pRulesOpen ? registerEsc(() => ((pRulesOpen = false), true)) : undefined))

  async function loadQtypes(): Promise<void> {
    try {
      const got = await window.nyx.study.qtypes()
      qtypes = got.all
      pRules = got.rules
      pFace = got.face
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }

  async function setPracticeRule(patch: Partial<PracticeRules>): Promise<void> {
    qtypeError = null
    qtypeNote = null
    try {
      pRules = await window.nyx.study.savePracticeRules(patch)
      qtypeNote = '存好了。已经出好的题不变，下一条进练习时按新的来。'
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }

  /**
   * ★★ 「改回默认」—— 把这一种题型上他以前写的那段出题要求清掉（确认单 §四）。
   *   **点了才清**：自动清空等于悄悄改掉他调过的出题方式，而他不会联想到是这次改动干的。
   */
  async function clearQtypePrompt(uid: string): Promise<void> {
    qtypeError = null
    qtypeNote = null
    try {
      qtypes = await window.nyx.study.clearQtypePrompt(uid)
      qtypeNote = '改回默认了。这个题型从此按内置的形状出题。'
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }
  loadQtypes()

  function newQtype(): void {
    /**
     * ★ D-478（使用者 2026-09-08「取消档位机制」）· 这里再没有 `tier` 要填了。
     *   库里那一列还在、写死 1（D-216 只增不删），但**没有任何判据读它** ——
     *   出题按他勾了哪几种、排成什么顺序轮转（`core/qtype-plan.ts::planQuestions`）。
     */
    editQtype = { name: '', brief: '', guide: '', prompt: '', enabled: true }
  }

  async function saveQtype(): Promise<void> {
    if (!editQtype) return
    qtypeError = null
    qtypeNote = null
    if (!editQtype.name.trim()) {
      qtypeError = '题型得有个名字 —— 练习弹窗里要靠它认。'
      return
    }
    if (!editQtype.prompt?.trim() && !editQtype.guide?.trim() && !editQtype.uid) {
      qtypeError = '写一句「这一题让他干什么」—— 出题时整段进提示词，空着的话 AI 无从下手。'
      return
    }
    try {
      qtypes = await window.nyx.study.saveQtype({ ...editQtype })
      editQtype = null
      qtypeNote = '存好了。已经出好的题不变，下一条进练习时按新的来。'
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }

  async function delQtype(): Promise<void> {
    if (!editQtype?.uid) return
    qtypeError = null
    try {
      qtypes = await window.nyx.study.deleteQtype(editQtype.uid)
      editQtype = null
      qtypeNote = '删了。以前用这个题型出过的题还在，报告不受影响。'
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }

  async function toggleQtypeEnabled(q: QTypeRow): Promise<void> {
    qtypeError = null
    try {
      qtypes = await window.nyx.study.setQtypeEnabled(q.uid, !q.enabled)
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }

  async function restoreQtypes(): Promise<void> {
    qtypeError = null
    try {
      qtypes = await window.nyx.study.restoreQtypes()
      qtypeNote = '内置那 12 种改回出厂的样子了。你自己加的一个都没动。'
    } catch (err) {
      qtypeError = cleanMessage(err)
    }
  }

  async function saveTutor(): Promise<void> {
    if (!editTutor) return
    tutorError = null
    try {
      await window.nyx.files.saveTutor({ ...editTutor })
      editTutor = null
      await loadTutors()
    } catch (err) {
      tutorError = cleanMessage(err)
    }
  }

  async function removeTutor(id: number): Promise<void> {
    tutorError = null
    try {
      await window.nyx.files.deleteTutor(id)
      editTutor = null
      await loadTutors()
    } catch (err) {
      tutorError = cleanMessage(err)
    }
  }

  async function makeDefault(id: number): Promise<void> {
    tutorError = null
    try {
      await window.nyx.files.setDefaultTutor(id)
      await loadTutors()
    } catch (err) {
      tutorError = cleanMessage(err)
    }
  }
</script>

<div class="vh"><h1>设置</h1></div>

{#if view.k === 'error'}
  <div class="errbox" data-testid="settings-error">
    <div class="h">设置打不开</div>
    <div>{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={load}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <div class="card blk"><Skel rows={4} widths={['w45', 'w100', 'w85', 'w70']} testid="settings-skel" /></div>
{:else}
  <!-- D-253 · 5 个 tab，用总原型已有的 .tabs2 下划线样式，没有新增 CSS -->
  <div class="tabs2">
    <button class:on={tab === 'ai'} onclick={() => (tab = 'ai')} data-testid="set-tab-ai">AI</button>
    <button class:on={tab === 'tutor'} onclick={() => (tab = 'tutor')} data-testid="set-tab-tutor">Prompts</button>
    <button class:on={tab === 'practice'} onclick={() => (tab = 'practice')} data-testid="set-tab-practice">Practice</button>
    <!-- T-7.7 · 一级从「朗读」改叫「声音」：这一页现在管的是「用谁的声音」整件事，
         不只是「读不读」。testid 不动 —— 换名字不该让别处的用例跟着红 -->
    <button class:on={tab === 'tts'} onclick={() => (tab = 'tts')} data-testid="set-tab-tts">Speech</button>
    <button class:on={tab === 'sync'} onclick={() => (tab = 'sync')} data-testid="set-tab-sync">Sync</button>
    <button class:on={tab === 'dict'} onclick={() => (tab = 'dict')} data-testid="set-tab-dict">Dictionary</button>
    <!--
      ★ 第九个一级（使用者 2026-09-13）。依据是他自己的契约 D-397
        「Assist 是独立设置模块」，加上他 2026-09-09 那句
        「M-3 砍的是重合的、可合并的，不是一级不许超过 7 —— 数字从来不是判据」。
    -->
    <button class:on={tab === 'assist'} onclick={() => (tab = 'assist')} data-testid="set-tab-assist"
      >Assist</button
    >
    <button class:on={tab === 'data'} onclick={() => (tab = 'data')} data-testid="set-tab-data">Data</button>
    <!-- ★ 使用者 2026-09-09：「在 Settings 中增加一个与『数据』等同级的『资源』Tab」 -->
    <button class:on={tab === 'res'} onclick={() => (tab = 'res')} data-testid="set-tab-res"
      >Resources</button
    >
  </div>

  <!-- ★ H-4b · 失败提示放在分页**外面**。
       以前它写在「AI」那一页里，而 `saveError` 是整个设置页共用的一个位 ——
       于是在「练习」「词典」「朗读」页出的错，状态里设了、屏幕上看不见。
       这个 bug 是 H-4b 的第 ③ 档用例当场抓出来的：我以为已经修好了。 -->
  {#if saveError}
    <div class="errbox" data-testid="save-error" style="margin:0 0 14px">
      <div class="h">没做成</div>
      <div style="white-space:pre-wrap">{saveError}</div>
    </div>
  {/if}

  {#if tab === 'ai'}
    <div class="sblk">
      <div class="sh">AI 配置</div>
      <div class="shs">
        贴上任何 key 都能接 —— 协议自动判断（<b>sk-ant-</b> 走 Claude、<b>AIza</b> 走 Gemini，
        其余按 OpenAI 兼容）。<b>key 只存在这台机器上，加密保存，不参与云同步。</b>
      </div>


      {#if saved}
        <div class="notice ok" data-testid="save-ok">已保存。建议点一下「测试连接」确认能通。</div>
      {/if}

      {#each shownSlots as slot (slot)}
        <div class="card blk" data-testid="slot-{slot}">
          <h3>{SLOT_LABEL[slot]}{#if !split}<span class="dim"> · 三组共用这一套</span>{/if}</h3>
          <div class="s2">{SLOT_DESC[slot]}</div>

          <div class="s2" style="margin-top:10px">服务商快填</div>
          <div class="chips" data-testid="providers-{slot}">
            {#each view.providers as p (p.id)}
              <button class="c" onclick={() => applyProvider(slot, p)} data-testid="prov-{p.id}"
                >{p.name}</button
              >
            {/each}
          </div>

          <input
            class="tin2"
            placeholder="Base URL，例如 https://api.deepseek.com/v1"
            data-testid="baseurl-{slot}"
            bind:value={form[slot].baseUrl}
          />
          <input
            class="tin2"
            placeholder="模型名，例如 deepseek-chat"
            data-testid="model-{slot}"
            bind:value={form[slot].model}
          />
          <input
            class="tin2"
            type="password"
            autocomplete="off"
            placeholder={view.s.slots[slot].hasKey ? '已保存一把 key —— 留空就不动它' : 'API key'}
            data-testid="key-{slot}"
            bind:value={form[slot].apiKey}
          />

          <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
            <button
              class="btn sm"
              disabled={testing === slot}
              data-testid="test-{slot}"
              onclick={() => test(slot)}>{testing === slot ? '正在连…' : '测试连接'}</button
            >
            {#if view.s.slots[slot].hasKey}
              <span class="dim" style="font-size:var(--fs-2)">已存了一把 key</span>
            {:else}
              <span class="dim" style="font-size:var(--fs-2)">还没配 key</span>
            {/if}
          </div>

          {#if testOk?.slot === slot}
            <div class="notice ok" data-testid="test-ok" style="margin-top:10px">
              <b>连上了</b> · 往返 {testOk.ms} ms。分析、判分、出题现在都能跑了。
            </div>
          {/if}
          {#if testFail?.slot === slot}
            <div class="errbox" data-testid="test-fail" style="margin-top:10px">
              <div class="h">{testFail.failure?.title ?? '连不上'}</div>
              <div style="white-space:pre-wrap">{testFail.failure?.detail ?? testFail.message}</div>
              {#if (testFail.failure?.consecutive ?? 0) >= CONSECUTIVE_FAIL_AT}
                <div style="margin-top:8px"><b>{CONSECUTIVE_FAIL_HINT}</b></div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      <!-- D-254 · 分组能力完整保留，只是默认不展开 -->
      <div class="sr">
        <div class="l">
          <div class="t3">为轻任务与长上下文单独配一套</div>
          <div class="s3">
            打开才分开配。关着的时候三组共用重任务这一套 —— 省钱机制（轻任务用便宜模型）不受影响。
          </div>
        </div>
        <div
          class="sw"
          class:on={split}
          role="switch"
          aria-checked={split}
          tabindex="0"
          data-testid="split-toggle"
          onclick={() => (split = !split)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') split = !split
          }}
        ></div>
      </div>

      <div style="margin-top:16px">
        <button class="btn pri" disabled={saving} data-testid="save-ai" onclick={save}
          >{saving ? '保存中…' : '保存'}</button
        >
      </div>
    </div>

  {:else if tab === 'tutor'}
    <!--
      ══ D-488′ · **他画的那棵树，直接就是这一页的布局**（2026-09-15）══════
        设置 └─ Prompt ├─ 文件学习（体裁 / AI 导师）└─ 练习（认读测试 / 产出练习）

      ── 第一版是两级下划线 Tab，为什么改 ──────────────────
      设置页自己那一行 `.tabs2` ＋ 一级 ＋ 二级 = **三行「长得像 Tab 的东西」叠在一起**，
      只能靠字号分层；而右边大片空白没用上，那句「这个 Tab 在配什么」被挤成 12px 灰字。
      使用者 2026-09-15「你可以设计一下」之后重做成这一版。

      ── 为什么树比 Tab 更诚实 ────────────────────────
      ★ **组名不可点**（`.pnav-g` 是 `div` 不是按钮）：它是分类，不是第三个可选项。
        做成可点的一层就又造出「点了没内容」的空层级 —— 他点名删掉的正是那个。
      ★ **四片叶子长得一模一样**，谁也不缩进得比谁深：体裁 ↔ AI 导师 平级，
        认读 ↔ 产出 平级。他要的「不许看起来像父子、实际是平级」，在这里是**看得见的**。
      ★ **一次点击到任何一片**（原来跨区要先点区再点 Tab）。连用例里的导航都短了一半。
      ★ 选中态**照抄侧栏 `.nv.on` 的语言**（不填底色 ＋ 主色 ＋ 半粗），只多一条左侧主色竖线
        —— 侧栏靠图标底色标选中，这里没有图标，得有个东西承担那个活。不新造一套。
    -->
    <!--
      ══ 使用者 2026-09-15 第二轮：**横向 Tab → 内容区**，不要侧边展开 ══════
      他的原话：「平级内容采用横向切换」「不要从侧面展开」。
      ★ 侧树那一版是他看图点头收的，真用之后改主意 —— **真用赢截图**，这一版照他说的改。
      ★ 但这不是简单回退：他同时点了另一个毛病 —— **三级比二级还显眼**。
        那个毛病在最早那版横向 Tab 里**同样存在**，回退会把它一起带回来。
        所以层级是这一版真正的活（见 `.plv1` / `.plv2` 与三级那几条的头注）。
    -->
    <div class="tabs2 plv1" data-testid="prompt-area">
      <button
        class:on={pArea === 'study'}
        data-testid="parea-study"
        onclick={() => { if (pArea !== 'study') pTab = 'genre' }}>文件学习</button
      >
      <button
        class:on={pArea === 'drill'}
        data-testid="parea-drill"
        onclick={() => { if (pArea !== 'drill') pTab = 'reading' }}>练习</button
      >
    </div>
    <!-- ★ D-484 · 清单 12 的目标：Prompt 那一区的导航本身 -->
    <div class="tabs2 plv2" data-testid="prompt-nav" data-guide="prompt-area">
      {#if pArea === 'study'}
        <button class:on={pTab === 'genre'} data-testid="ptab-genre"
          onclick={() => (pTab = 'genre')}>体裁</button
        >
        <button class:on={pTab === 'tutor'} data-testid="ptab-tutor"
          onclick={() => (pTab = 'tutor')}>AI 导师</button
        >
      {:else}
        <button class:on={pTab === 'reading'} data-testid="ptab-reading"
          onclick={() => (pTab = 'reading')}>认读测试</button
        >
        <button class:on={pTab === 'produce'} data-testid="ptab-produce"
          onclick={() => (pTab = 'produce')}>产出练习</button
        >
      {/if}
    </div>
    <div class="ppane" data-testid="prompt-pane">

    {#if pTab === 'tutor'}
    <!-- R-005 · 多导师：可建、可选、可切换。D-098 的四个可调项是主体 -->
    <div class="sblk">
      <div class="shs" data-testid="tutor-note">
        可调项决定行为，自由提示词作为补充，两者一起组装 ——
        「严谨学术导师」这五个字 AI 会怎么理解谁也不知道，而且每次可能不一样；
        <b>「纠错严厉度 8、写完才给答案」是确定的、可复现的</b>。<br />
        <b>换导师不影响判分</b>：判分必须可复现，换个导师就换个标准会让进度变成随机数。
        导师只管对话、任务、讲解的口吻与深度。
      </div>

      {#if tutorError}
        <div class="errbox" data-testid="tutor-error"><div class="h">出问题了</div><div>{tutorError}</div></div>
      {/if}

      <div class="chips" data-testid="tutor-chips">
        {#each tutors as t (t.id)}
          <button class="c" class:on={editTutor?.id === t.id} data-testid="tutor-{t.id}" onclick={() => (editTutor = { ...t })}
            >{t.name}{#if t.isDefault} ·默认{/if}</button
          >
        {/each}
        <button class="c" data-testid="tutor-new" onclick={() => (editTutor = NEW_TUTOR())}><Ic n="plus" s={16} /> 新建导师</button>
      </div>

      {#if editTutor}
        {@const e = editTutor}
        <div class="card blk" data-testid="tutor-form">
          <input class="tin2" style="margin-top:0" placeholder="名字" data-testid="tutor-name" bind:value={e.name} />
          <textarea
            class="pastebox"
            style="min-height:80px"
            placeholder="人设：这个导师是什么样的人？例如「研讨课传统里的导师：精确、追问证据、从不奉承」"
            data-testid="tutor-persona"
            bind:value={e.persona}
          ></textarea>

          <div class="sr">
            <div class="l"><div class="t3">纠错严厉度</div><div class="s3">放过小错 ↔ 逐字挑</div></div>
            <input type="range" min="0" max="10" data-testid="tutor-strict" bind:value={e.strictness} />
            <span style="font-family:var(--mono);color:var(--accent-2);margin-left:8px">{e.strictness}/10</span>
          </div>
          <div class="sr">
            <div class="l"><div class="t3">任务密度</div><div class="s3">聊够了才布置 ↔ 每轮都布置</div></div>
            <input type="range" min="0" max="10" data-testid="tutor-density" bind:value={e.taskDensity} />
            <span style="font-family:var(--mono);color:var(--accent-2);margin-left:8px">{e.taskDensity}/10</span>
          </div>
          <div class="sr">
            <div class="l"><div class="t3">给答案的时机</div><div class="s3">直接给 ↔ 你写完才给 ↔ 只给方向</div></div>
            <select class="srt" data-testid="tutor-timing" bind:value={e.answerTiming}>
              <option value="direct">直接给</option>
              <option value="after">你写完才给</option>
              <option value="hint">只给方向</option>
            </select>
          </div>

          <textarea
            class="pastebox"
            style="min-height:70px"
            placeholder="自由提示词（可留空）—— 与上面的可调项并列，一起组装进最终提示"
            data-testid="tutor-free"
            bind:value={e.freePrompt}
          ></textarea>

          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
            <button class="btn pri" data-testid="tutor-save" onclick={saveTutor}>保存</button>
            <button class="btn" onclick={() => (editTutor = null)}>取消</button>
            {#if e.id}
              <button class="btn sm" data-testid="tutor-default" onclick={() => makeDefault(e.id!)}>设为默认</button>
              <button class="btn sm" data-testid="tutor-copy" onclick={() => (editTutor = { ...e, id: undefined, name: `${e.name} 副本`, isDefault: false })}
                >复制一份</button
              >
              <button class="btn sm" data-testid="tutor-del" onclick={() => removeTutor(e.id!)}>删掉</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
    {/if}

    {#if pTab === 'genre'}
    <!--
      ★ 5.2 · 体裁。使用者：「设置 → AI 导师 中新增『体裁』管理功能。
      体裁可像导师一样：新增、编辑、设置提示词。」

      放在导师下面同一页，因为两者是一对：
      **导师决定口吻**（Enlighten 用），**体裁决定出什么问题**（Quest 用）。
      分到两个 Tab 里会让人以为它们各管各的。
    -->
    <div class="sblk" data-testid="mode-genre">
      <div class="shs">
        文件学习里切到 <b>Quest（思考）</b>时，它按你选的体裁出问题 ——
        论说文该问论证，叙事该问视角，问法本来就不一样。
        <span class="dim">提示词整段进系统提示，写得越具体，问题越贴。</span>
      </div>

      {#if genreError}
        <div class="errbox" data-testid="genre-error"><div class="h">出问题了</div><div>{genreError}</div></div>
      {/if}

      <div class="chips" data-testid="genre-chips">
        {#each genres as g (g.uid)}
          <button
            class="c"
            class:on={editGenre?.uid === g.uid}
            data-testid="genre-{g.uid}"
            onclick={() => (editGenre = { ...g })}>{g.name}{#if g.isDefault} ·默认{/if}</button
          >
        {/each}
        <button class="c" data-testid="genre-new" onclick={newGenre}><Ic n="plus" s={16} /> 新体裁</button>
      </div>

      {#if editGenre}
        <div class="card blk" data-testid="genre-edit" style="margin-top:10px">
          <div class="s2">名称</div>
          <input class="tin2" data-testid="genre-name" bind:value={editGenre.name} />
          <div class="s2" style="margin-top:10px">这一体裁该怎么提问</div>
          <textarea
            class="tin2"
            rows="5"
            data-testid="genre-prompt"
            placeholder="例：按论说文的读法提问 —— 论点是什么、靠什么支撑、哪一步推得最勉强……"
            bind:value={editGenre.prompt}
          ></textarea>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn sm pri" data-testid="genre-save" onclick={saveGenre}>保存</button>
            <button class="btn sm" data-testid="genre-cancel" onclick={() => (editGenre = null)}>取消</button>
            {#if editGenre.uid && !editGenre.builtin}
              <button class="btn sm" data-testid="genre-del" onclick={delGenre}>删掉这个体裁</button>
            {/if}
            {#if editGenre.builtin}
              <span class="dim" style="font-size:var(--fs-2);align-self:center"
                >内置体裁删不掉；内容可以改，改完就是你的</span
              >
            {/if}
          </div>
        </div>
      {/if}
    </div>
    {/if}

    {#if pTab === 'produce'}
    <!--
      ★ 题型管理。使用者：「像现有的 Lumen（导师）和体裁一样，支持题型的增/删/改。
      每个题型都有自己的提示词。题型列表可管理，支持启用/禁用。」

      和导师、体裁并列放在这一页 —— 三者都是「AI 按什么来」：
      导师 = 口吻（Enlighten）· 体裁 = 问什么（Quest）· 题型 = 怎么考（产出练习）。

      ★ 2026-09-03 · 使用者要求：这一页**不再出现「档位」**，直接管理具体题型。
      所以下面是一张平列表，编辑卡里也没有难度档选择器。

      ★ 2026-09-08（D-478）· 档位**机制本身**也取消了，不只是这一页不显示它。
      「3 连正确必须跨题型」（M-027）改由出题引擎显式保证
      （`core/qtype-plan.ts::preferDifferent` / `crossesEnoughTypes`），
      不再是「按档取题」的副产品。库里 `qtypes.tier` 那一列留着写死 1（D-216）。
    -->
    <div class="sblk">
      <!--
        ══ 产出练习 · 三层（D-486）══════════════════════════════════
        段序与段名和上面的认读块**逐字一致**。不一样的只有选择方式，
        而它在控件上一眼看得出：牌面这边是**单选描边**（认读那边是勾选角标），
        题型这边是**勾选框**（认读那边是单选圆点）。
        ★ 为什么反着：内容多来几种是复习，交互与排版多来几种是找不着北。
      -->
      <!--
        ★★ D-488 他点名的第一条：这里原来是一个「模式标题块」，写着「产出练习」——
        而它**上面那个折叠头也写着「产出练习」**，一个同名的空层，没有任何配置作用。
        名字现在归二级 Tab，这里只留那句说明。**别再把名字加回来。**
        ★ 这段话**故意不写那个类名**：`check:css-dead` 扫源码时不剥注释，
          注释里提到一个类名就算它「还活着」—— 于是一条早已没人用的规则
          会靠这段说明一直躲过闸。实测过：注释里带着名字它报 3 条，换掉就报 4 条。
          （闸本身那个洞已记给主控，属 I-179 那一族，不在本单边界内。）
      -->
      <div class="shs" data-testid="mode-practice">写得出才算 —— 用这条知识点把话说出来</div>

      <!-- 第一层 · 牌面：预览卡，**单选**（排版轮着换没有学习收益，只会让他重新找输入框）-->
      <div class="lyr">
        <div class="lyrh">
          <span class="lh-n">牌面</span>
          <span class="lh-s">这道题在屏幕上摆成什么样 · 只能选一种</span>
        </div>
        {#if pFace}
          <div class="pvgrid" data-testid="practice-faces">
            {#each ['plain', 'split', 'focus'] as const as v (v)}
              <button
                class="pvcard"
                class:on={pFace === v}
                data-testid="pface-{v}"
                onclick={() => void setPracticeFace(v)}>
                <span class="pvmini">
                  {#if v === 'plain'}
                    <i class="w70"></i><i></i><i class="tall"></i>
                  {:else if v === 'split'}
                    <i class="w70"></i><span class="pvrow"><i></i><i></i></span>
                  {:else}
                    <i class="w45"></i><i class="tall"></i>
                  {/if}
                </span>
                <span class="pv-n">{PRACTICE_FACE_SAYS[v].name}</span>
                <span class="pv-s">{PRACTICE_FACE_SAYS[v].says}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="lyr">
        <div class="lyrh">
          <span class="lh-n">题型</span>
          <span class="lh-s">你要做什么题 · 可以多选，出题时轮着来</span>
        </div>
        <div class="shs" style="margin-top:0">
          <span class="dim">停用的不会出现在练习的题型弹窗里；删掉不影响以前出过的题。</span>
        </div>
      </div>


      <div class="qtm-grp" data-testid="qtype-list">
        <div class="qtm-gh">
          <span>全部题型</span>
          <span class="qtm-cnt" class:zero={qtypes.filter((x) => x.enabled).length === 0}
            >{qtypes.filter((x) => x.enabled).length} / {qtypes.length} 种启用</span>
        </div>
        <div class="chips">
          {#each qtypes as q (q.uid)}
            <!-- 名字和开关拼成一颗，归属才一眼看得清（两个并排 chip 时那颗 ● 像是另一个题型） -->
            <span class="qtm-pill" class:on={editQtype?.uid === q.uid} class:off={!q.enabled}>
              <button
                class="qtm-nm"
                data-testid="qtype-chip-{q.uid}"
                onclick={() => (editQtype = { ...q })}>{q.name}</button>
              <button
                class="qtm-sw"
                data-testid="qtype-toggle-{q.uid}"
                title={q.enabled ? '停用它 —— 练习的题型弹窗里就不出现了' : '启用它'}
                onclick={() => toggleQtypeEnabled(q)}>{q.enabled ? '●' : '○'}</button>
            </span>
          {/each}
          <button class="c" data-testid="qtype-new" onclick={newQtype}
            ><Ic n="plus" s={16} /> 加一种</button>
        </div>
      </div>

      <div style="margin-top:10px">
        <button class="btn sm" data-testid="qtype-restore" onclick={restoreQtypes}
          >把内置那 12 种改回出厂</button>
      </div>

      <!--
        ★★ 出题规则 = **一颗入口 + 一个弹窗**（使用者 2026-09-15 第四条）。
          认读那边本来就是这个形状，这里跟上 —— 「出题规则」从视觉上和牌面、题型分开：
          那两个是「题目长什么样 / 用户做什么」，这一个是「题目怎么生成」。
      -->
      <div class="lyr">
        <div class="lyrh">
          <span class="lh-n">出题规则</span>
          <span class="lh-s">系统按什么条件生成这批题</span>
        </div>
      <div class="chips" data-testid="practice-rules-entry">
        <button class="c" data-testid="prules-open" onclick={openPracticeRules}>
          出题规则{#if pRules}<span class="dim">　{PRACTICE_HINT_SAYS[pRules.hintLevel]} ·
              {CONTEXT_SPREAD_SAYS[pRules.contextSpread]}</span
            >{/if}
        </button>
      </div>
      </div>

      {#if editQtype}
        <div class="card blk" data-testid="qtype-edit" style="margin-top:10px">
          <div class="s2">名称</div>
          <input class="tin2" data-testid="qtype-name" bind:value={editQtype.name} />

          <div class="s2" style="margin-top:10px">一句话说明（练习弹窗里显示给你自己看）</div>
          <input
            class="tin2"
            data-testid="qtype-brief"
            placeholder="例：给一个场景，用这个知识点写一句"
            bind:value={editQtype.brief} />

          <!--
            ══ 「自己写出题提示词」退役为一种输入方式 · D-482 ══════════════
            ★★ 出厂那 12 种**不再给编辑框**：它们的形状由内置说明（`guide`）定，
              而「怎么考」由出题规则那四个选项定。两处都能改同一件事 = 两份判据。
              库里 `qtypes.prompt` 那一列一个字不删（D-216），他以前写过的那几种
              继续用他写的 —— 下面那行小字和「改回默认」说的就是这件事。
            ★★ 他**自己加的**那种改的是 `guide`（这一题的形状），不是 `prompt`：
              `prompt` 是「盖掉出厂形状」那条输入方式，整条退役了；
              而自建题型**没有出厂形状可盖** —— 没有这一格，加一种 =
              加了一个对模型什么都没说的题型（`typesBrief` 会直接跳过它）。
          -->
          {#if !editQtype.builtin}
            <div class="s2" style="margin-top:10px">这一题让 AI 怎么出</div>
            <textarea
              class="tin2"
              rows="5"
              data-testid="qtype-guide"
              placeholder="例：Give a concrete situation and ask for one sentence using the target expression."
              bind:value={editQtype.guide}></textarea>
            <div class="qtm-d">
              用英文写 —— 它是拼进 system 提示词的。
              <b>不要出选择题、连线题、选项式完形填空</b>：那些测的是认得出，不是写得出，
              而这个软件存在的全部理由就是把「读得懂但写不出」变成「写得出」。
            </div>
            <!--
              ★ 自建题型身上那段 `prompt`**仍然压过 `guide`**（它就是这一种的形状）。
                所以只对它说这句、也只给它「改回默认」—— 内置那边没有「默认」可回，
                它本来就只按 `guide` 出。
            -->
            {#if editQtype.prompt?.trim()}
              <div class="qtm-d" data-testid="qtype-mine">
                自建题型（用它自己的出题要求）—— 上面那段现在不生效。
                <button
                  class="btn sm"
                  style="margin-left:8px"
                  data-testid="qtype-restore-one"
                  onclick={() => void clearQtypePrompt(editQtype!.uid!)}>改回默认</button>
              </div>
            {/if}
          {:else}
            <!--
              ★★ 内置那 12 种：`guide` **只读**（主控 2026-09-15 裁）。
                不给编辑框，但也**不藏起来** —— 藏起来他就看不出这一种到底会出什么样的题，
                而那正是他挑题型时唯一的依据。
            -->
            <div class="s2" style="margin-top:10px">
              这一题让 AI 怎么出<span class="dim">　内置题型的形状，只读</span>
            </div>
            <textarea class="tin2" rows="4" readonly data-testid="qtype-guide-ro"
              >{editQtype.guide ?? ''}</textarea>
            <!--
              ★★★ I-187（使用者 2026-09-15 答「那些英文提示词是生成的」）：
                内置题型这里**再没有那句话了**。老版本写的是「这个题型用的是你以前写的
                出题要求」—— 而他一个字都没写过：那 10 段 5～10 千字、和题型名错位的
                英文是**生成出来的**。对着他没写过的东西说「你以前写的」，
                和这一轮治过的那几处是同一个形状。
                内置题型从此只按上面那段 `guide` 出题（判据 `effectiveQTypePrompt` 在 core）。
            -->
          {/if}

          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn sm pri" data-testid="qtype-save" onclick={saveQtype}>保存</button>
            <button class="btn sm" data-testid="qtype-cancel" onclick={() => (editQtype = null)}
              >取消</button>
            {#if editQtype.uid && !editQtype.builtin}
              <button class="btn sm" data-testid="qtype-del" onclick={delQtype}>删掉这个题型</button>
            {/if}
            {#if editQtype.builtin}
              <span class="dim" style="font-size:var(--fs-2);align-self:center"
                >内置题型删不掉，出题的那段也改不了；名字和说明可以改，改完就是你的</span>
            {/if}
          </div>
        </div>
      {/if}
    </div>
    {/if}

    {#if pTab === 'reading'}
    <!--
      ★ 认读测试的提示词 · 使用者 2026-09-03 立、2026-09-04 改形

      立的时候：「增加认读测试 Prompt 设置 · 提供几个合理的默认 Prompt ·
        用户之后可以查看、修改和管理这些 Prompt」。
      改形：「UI 不要做成占据很大空间的展开式区域……参考体裁、题型的设计：
        认读测试作为一个普通的设置项，点击之后弹出一个专门的 Prompt 设置弹窗。」

      ★ 所以这一块**只有一行入口**。上一版把五份预设和一个十四行的正文框
        直接铺在页面上 —— 它比导师 / 体裁 / 题型三块加起来还高，
        而这四件事在层级上是**并列的**，凭什么它占那么多地方。
        增删改用全部搬进弹窗（见下面的 `.ov`）。

      和上面三块并列：导师 = 口吻 · 体裁 = 问什么 · 题型 = 产出怎么考 ·
      **认读牌面 = 认读怎么考**。
    -->
    <!--
      ══ 认读测试 · 三层（D-486）══════════════════════════════════
      段序与段名和下面的产出块**逐字一致** —— 两块并排看过去三段一一对齐，
      这正是使用者第六条要的效果。
    -->
    <div class="sblk" data-testid="mode-reading">
      <!-- ★ 名字归二级 Tab（D-488），这里只留那句说明 —— 和产出那块逐字同形 -->
      <div class="shs">认出来就行 —— 看题面想起这个词</div>

      {#if readError && !facesOpen && !rulesOpen}
        <div class="errbox" data-testid="readp-error">
          <div class="h">出问题了</div>
          <div>{readError}</div>
        </div>
      {/if}

      <!-- 第一层 · 牌面：预览卡，**多选**（换个角度问同一条，变化本身就是复习） -->
      <div class="lyr">
        <div class="lyrh">
          <span class="lh-n">牌面</span>
          <span class="lh-s">这张卡给你看什么 · 可以多选，出题时轮着来</span>
        </div>
        {#if readState}
          <div class="pvgrid" data-testid="reading-faces">
            {#each readState.faces as f (f.id)}
              <button
                class="pvcard"
                class:on={f.on}
                data-testid="face-card-{f.id}"
                onclick={() => toggleFace(f.id)}>
                {#if f.on}<span class="pv-tick">✓</span>{/if}
                <span class="pvmini">
                  {#if f.id === 'cloze'}
                    <i class="w70"></i><i></i><i class="w45"></i>
                  {:else if f.id === 'scenario'}
                    <i></i><i></i><i class="w70"></i>
                  {:else if f.id === 'zh-recall'}
                    <i class="tall w70"></i><i class="w45"></i>
                  {:else}
                    <i class="w45"></i><i></i><i class="w70"></i>
                  {/if}
                </span>
                <span class="pv-n">{f.name}</span>
                <span class="pv-s">{f.says}</span>
              </button>
            {/each}
          </div>
          {#if facesOn.length === 0}
            <div class="errbox" data-testid="faces-none-inline">
              <div class="h">现在一面都没勾</div>
              <div>认读卡会退回原来的机械挖空 —— 勾上任意一面就恢复。</div>
            </div>
          {/if}
          <div class="chips" style="margin-top:8px">
            <button class="c" data-testid="faces-open" onclick={openFaces}
              >管理牌面<span class="dim">　新建 · 改 · 删自建的那几面</span></button>
          </div>
        {/if}
      </div>

      <!-- 第二层 · 题型：任务行，**单选**（任务再跟着变，他每张卡都要先猜要干什么）-->
      <div class="lyr">
        <div class="lyrh">
          <span class="lh-n">题型</span>
          <span class="lh-s">你要做出什么动作才算认出来 · 只能选一种</span>
        </div>
        {#if readState}
          <div data-testid="reading-qtypes">
            {#each ['flip', 'write', 'timed'] as const as v (v)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div
                class="taskrow"
                class:on={readState.qtype === v}
                role="radio"
                aria-checked={readState.qtype === v}
                tabindex="0"
                data-testid="rqtype-{v}"
                onclick={() => setReadQType(v)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setReadQType(v)
                  }
                }}>
                <span class="tr-dot"></span>
                <span>
                  <span class="tr-n">{READING_QTYPE_SAYS[v].name}</span>
                  <span class="tr-s">{READING_QTYPE_SAYS[v].says}</span>
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- 第三层 · 出题规则：弹窗（和上面两层视觉上明显不是同一种实体）-->
      <div class="lyr">
        <div class="lyrh">
          <span class="lh-n">出题规则</span>
          <span class="lh-s">系统按什么条件出这道题</span>
        </div>
        <div class="chips" data-testid="reading-entry">
          <button class="c" data-testid="rules-open" onclick={openRules}>
            出题规则{#if readState}<span class="dim"
                >　{FACE_PICK_SAYS[readState.options.facePick]}</span>{/if}
          </button>
        </div>
      </div>
    </div>
    {/if}
    </div>
  {:else if tab === 'practice'}
    <!-- D-179 · 常用项在上，机制参数收进「高级」折叠区并标明影响 -->
    <div class="sblk">
      <div class="sh">复习调度</div>
      <div class="shs">
        常用项在上，机制参数在下方的高级区。<b>这几个参数互相咬合</b> ——
        把「练成所需连正确」从 3 改成 1，整套判定的意义就变了。随时可一键还原。
      </div>

      {#each params.filter((p) => p.common) as p (p.key)}
        <div class="sr" data-testid="param-{p.key}">
          <div class="l">
            <div class="t3">
              {p.label}{#if p.changed}<span class="dev">已偏离默认值</span>{/if}
            </div>
            <div class="s3">{p.note}</div>
          </div>
          <input
            type="number"
            class="tin2"
            style="margin-top:0;width:88px"
            min={p.min}
            max={p.max}
            value={p.value}
            data-testid="param-input-{p.key}"
            onchange={(e) => setParam(p.key, Number(e.currentTarget.value))}
          />
        </div>
      {/each}

      <div class="sr">
        <div class="l">
          <div class="t3">
            高级 · 机制参数{#if params.some((p) => !p.common && p.changed)}<span class="dev">已偏离默认值</span>{/if}
          </div>
          <div class="s3">
            练成所需连正确 <b>{val('silenceStreak')}</b> · 攻坚触发
            <b>{val('hardTrigger')}</b> 次 · 认读练成阈值
            <b>{val('readingSilenceDays')}</b> 天
          </div>
        </div>
        <button class="btn sm" data-testid="param-advanced" onclick={() => (advanced = !advanced)}
          >{advanced ? '收起' : '展开'}<Ic n="caret" s={12} r={advanced ? 'up' : 'dn'} /></button
        >
      </div>

      {#if advanced}
        <div class="adv" data-testid="param-adv-note">
          <b>这几个参数互相咬合。</b>它们是设计时定的、<b>未经真实使用验证</b>（O-201）——
          留调节余地是对的，但改之前先看清每一条底下写的影响。
        </div>
        {#each params.filter((p) => !p.common) as p (p.key)}
          <div class="sr" data-testid="param-{p.key}">
            <div class="l">
              <div class="t3">
                {p.label}{#if p.changed}<span class="dev">已偏离默认值</span>{/if}
                <span class="dim" style="font-size:var(--fs-1);margin-left:6px">{p.ref}</span>
              </div>
              <div class="s3">{p.note}</div>
            </div>
            <input
              type="number"
              class="tin2"
              style="margin-top:0;width:88px"
              min={p.min}
              max={p.max}
              value={p.value}
              data-testid="param-input-{p.key}"
              onchange={(e) => setParam(p.key, Number(e.currentTarget.value))}
            />
          </div>
        {/each}
      {/if}

      {#if params.some((p) => p.changed)}
        <div style="margin-top:14px">
          <button class="btn sm" data-testid="param-reset" onclick={() => resetParams()}
            >全部还原成默认值</button
          >
        </div>
      {/if}
    </div>
  {:else if tab === 'assist'}
    <!--
      ══ Assist（使用者 2026-09-13）══════════════════════════════════
      他要的是把 Android 的 Assist 核心能力移到 Windows。
      ★★ 2026-09-14 晚定型成**两个互斥的模式**，都不用框、都不认图：
        · Glance（划词就查）—— 选中文字后直接自动查词，不用任何按键；代价是它要一直盯着
        · Point（指到就查）—— 鼠标停在词上按一颗键；按了才读，不盯任何东西
      ★ 他明确要求两者**不能同时混在一起**：开一个就不跑另一个。
      ★ 原来那一档 Frame（框选 + OCR）**取消了**（他：「我不太喜欢框选这个东西」），
        代码、窗口、快捷键、OCR 脚本全部真删 —— 不是藏起来。

      ★★ 这一页最要紧的不是开关，是**把代价说清楚**。
        零按键意味着他在**任何地方**选中的任何东西都会经过 Nyx 的判断。
        `ASSIST_CONTRACT` 的原则原话是「Nyx 只看用户明确交给它的东西」——
        零按键把「明确交给」变模糊了，所以补偿必须摆在明面上：
        默认关 · 开着时屏上一直有标记 · 密码框永不读 · 能按程序排除。
    -->
    <div class="sblk">
      <div class="sh">Assist</div>
      <div class="shs">
        在<b>别的程序里</b>看到看不懂的英文，不用切回 Nyx 就能查、能收下。
        <b>这一页只管这台电脑</b> —— 开没开是本机的事，不跟手机同步。
      </div>

      <div class="notice" data-testid="assist-cost">
        <b>先说代价。</b>「选中就查」要一直盯着你当前选中了什么 ——
        也就是说，你在任何窗口里选中的文字都会经过 Nyx 一次判断。
        所以：<b>默认关着</b>；开着时这一页上会有一个看得见的「正在盯着」；
        <b>密码框永远不读</b>（在那一步之前就跳过了，连文字都不取）；
        下面还能按程序排除。
      </div>

      {#if assist}
        <!--
          ══ 重做过一次（使用者 2026-09-14 第二条）══════════════
          他的原话：「关闭 / Glance / Frame 这一块的交互和视觉表现很不明显……
          开关不明显。缺少明确的按钮或交互方式。用户不容易理解当前 Assist
          是否开启，以及当前使用的是哪一种模式。」

          ── 旧的是什么形状，为什么不行 ─────────────────
          一排三格分段控件：「关 | Glance·选中就查 | Frame·框选取词」。
          它把**两件正交的事挤进了一根轴**：「开不开」和「用哪一种」。
          于是两头都读不出来：关着时看不出「再开会是哪一种」（这个信息被
          `off` 擦掉了），开着时也看不出「三格里哪一格是开关」。
          ★ 他自己第四条把这两件事明确拆开了（桌面图标只管开关，模式在设置里选）。
            这一块跟着拆 —— 两处形状一致，他不用在两个地方学两遍。

          ── 现在的形状 ──────────────────────────────
            ① 一根**开关**（这一页其他地方用的同一颗 `.sw`），旁边一个大字状态
            ② 两张**模式卡**，哪张选中一眼看得出；关着也能选（选了不会自己打开）
            ③ 一行**现在**：说的是那一档真实的状态，不是三档共用一句话
        -->
        <!--
          ★ D-484 · 清单 14（`capture-entry`）的目标：**Assist 那个总开关这一行**。
            ★★ 为什么是它而不是「用哪一种」那两张卡：这一条讲的是
              「**在别的软件里选中英文就能收进来**」这件事**存在**，
              而让它存在 / 不存在的就是这一行；模式（Glance / Point）是
              「用哪一种方式」，那是下一个问题。
            ★★ 这一页现在有两条（还有「收下的东西放哪儿」那条 `assist-lecture`）——
              使用者 2026-09-15 把 CR-3 放宽到**每页最多两条、必须是两件不同的事**。
              这两条确实是两件事：一件是「这个能力是什么」，一件是「收下来放哪儿」。
              一次页面停留仍然只出一条，第二条下次进来再出。
        -->
        <div class="asw" data-testid="assist-switch-row" data-guide="capture-entry">
          <div class="l">
            <div class="t3">Assist</div>
            <div class="s3">
              开着的时候，在别的程序里看到看不懂的英文可以当场查、当场收下。
            </div>
          </div>
          <!-- ★ 先写字再摆开关：两个字比一根 36px 的滑块好认得多 -->
          <b class="state" class:on={assist.mode !== 'off'} data-testid="assist-state"
            >{assist.mode === 'off' ? '关着' : '开着'}</b>
          <div
            class="sw"
            class:on={assist.mode !== 'off'}
            role="switch"
            tabindex="0"
            aria-checked={assist.mode !== 'off'}
            aria-label="开关 Assist"
            data-testid="assist-toggle"
            onclick={() => void setOn(assist?.mode === 'off')}
            onkeydown={(e) =>
              (e.key === 'Enter' || e.key === ' ') &&
              (e.preventDefault(), void setOn(assist?.mode === 'off'))}>
          </div>
        </div>

        <!--
          ══ 用哪一种（使用者 2026-09-14 晚）══════════════════════════
          他的原话：「Point 和 Glance 是两种独立的功能，**不能同时混在一起**……
          当用户开启 Point 时：Assist 当前只运行 Point，不运行 Glance。」

          ★ 所以这是一次**真正的二选一**，不是两个可以叠加的开关：
            选 Glance → 不注册 Point 那颗键；选 Point → 不起那个盯选中的助手进程。
          ★ 这一块下午还是「一颗两种模式下都能按的键」（那一版被他推翻了），
            更早还是「Glance / Frame」。写在这儿免得下一轮把它当回潮。
        -->
        <div class="shs" style="margin-top:16px"><b>用哪一种</b></div>
        <div class="amodes" data-testid="assist-mode" role="radiogroup" aria-label="Assist 模式">
          <button
            class="amode"
            class:sel={assist.kind === 'glance'}
            role="radio"
            aria-checked={assist.kind === 'glance'}
            data-testid="assist-glance"
            onclick={() => void setKind('glance')}>
            <span class="h">Glance<span class="z">划词就查</span></span>
            <span class="d">
              在任何程序里用鼠标选中一段英文，<b>不用按任何键</b>，Nyx 直接弹出查词面板。
              <br /><span class="dim"
                >代价最大的那一档 —— 它要一直盯着你当前选中了什么（见上面那条）。</span>
            </span>
          </button>
          <button
            class="amode"
            class:sel={assist.kind === 'point'}
            role="radio"
            aria-checked={assist.kind === 'point'}
            data-testid="assist-point"
            onclick={() => void setKind('point')}>
            <span class="h">Point<span class="z">选不中的字也能选</span></span>
            <span class="d">
              开着的时候，<b>直接用鼠标拖过那几个字</b> ——
              拖到哪里就亮到哪里，松手即查，选不中的字也能划。
              <b>不用按任何键。</b>
              <br /><span class="dim"
                >它不接管你的鼠标：只在旁边看着，你的点击照常落给那个程序。
                和手机上的 Assist 同一个做法：问系统「这一块地方是哪几个字」，
                而不是去认屏幕上的像素。</span>
            </span>
          </button>
        </div>

        <!--
          ══ 桌面上那颗悬浮球（使用者 2026-09-14 晚）════════════
          他的原话：「在 Windows 桌面上显示 Assist 的悬浮小图标。图标应该
          悬浮在其他应用窗口之上。它不是普通 App Icon，而是作为 Assist 的
          桌面悬浮控制入口。」
          ★ 这一条他说了三次，前两次我把它翻译成了**托盘**图标（并当面说过
            那是我的翻译）。现在做的是真的悬浮窗；托盘那一枚留着（他没说要去掉）。
          ★ 给开关的理由：一个关不掉的置顶物件太霸道。出厂开着。
        -->
        <div class="sr" style="margin-top:14px">
          <div class="l">
            <div class="t3">桌面上显示悬浮图标</div>
            <div class="s3">
              一颗小球，浮在所有窗口之上。<b>点一下开 / 关当前这一档</b>，拖得动。
              <span class="dim">它不切模式 —— 模式在上面选。</span>
            </div>
          </div>
          <div
            class="sw"
            class:on={assist.bubbleOn}
            role="switch"
            tabindex="0"
            aria-checked={assist.bubbleOn}
            aria-label="桌面上显示悬浮图标"
            data-testid="assist-bubble-toggle"
            onclick={() => void setBubble(!assist?.bubbleOn)}
            onkeydown={(e) =>
              (e.key === 'Enter' || e.key === ' ') &&
              (e.preventDefault(), void setBubble(!assist?.bubbleOn))}>
          </div>
        </div>

        <div class="row-kv" style="margin-top:14px">
          <span class="k">现在</span>
          <span class="v" data-testid="assist-running">
            <!--
              ★ 每一档说的是**那一档真实的状态**，不是共用一句话。
                第一版三档共用「正在盯 / 没在盯」，于是 Frame 开着时屏上写的是
                「没在盯」—— 字面没错（Frame 确实不盯选中），但他读到的是
                「Assist 关着」。**看着像真话的假话最难查。**
            -->
            {#if assist.mode === 'glance' && assist.running}
              <b style="color:var(--color-text-accent)">● 正在盯着你选中了什么</b>
            {:else if assist.mode === 'glance'}
              <b style="color:var(--color-attention)">开着，但助手没起来</b>
            {:else if assist.mode === 'point' && assist.pointReady}
              <b style="color:var(--color-text-accent)" data-testid="assist-point-live"
                >● 开着 · 拖过一段字就查它</b>
              <span class="dim">　（不盯选中，也不接管点击）</span>
            {:else if assist.mode === 'point'}
              <b style="color:var(--color-attention)">开着，但助手没起来</b>
            {:else}
              没开 —— Nyx 不会读任何窗口里的任何东西
            {/if}
          </span>
        </div>

        <!--
          ★ 契约 §五 第一条：「**零配置**：不问保存到哪，默认目标由 Settings 定」。
            设一次，以后查到词直接收，不再问 —— Glance / Frame 是在**别的程序里**
            触发的，那时候弹一个三级路径选择器等于把「两次点击」变成五次。
        -->
        <div class="shs" style="margin-top:16px"><b>收下的东西放哪儿</b></div>
        <!--
          ★ D-484 · B-3 的目标（I-190 / T-1f）。**字面写在这儿**，不再经
            PathPicker 的 `guide` prop 传下去：那条路是活的（我按使用者的状态
            走过一遍，框真出来了），但**按字面 grep 看不见** ——
            主控与 B 都据此判成「有触发没目标」，而 B 正在加的
            `check:guide-ids`「触发与目标成对」也要认得出它。
            一个只有作者知道怎么读的标记，等于没有标记。
          ★ 挂在这一行而不是选择器上：这一行三种状态下都在（设了 / 没设都在），
            而它紧挨着选择器 —— 框指过来，他一眼能看到下面那三格。
        -->
        <div class="shs" data-guide="assist-lecture">
          在查词卡上按「收下」时，进这个 Lecture。
          {#if assist.lecture}
            <b data-testid="assist-lecture-set">已经设好了</b>
          {:else}
            <b style="color:var(--color-attention)" data-testid="assist-lecture-unset"
              >还没设 —— 没设的话卡上那颗「收下」不出现</b
            >
          {/if}
        </div>
        <PathPicker
          tree={assistTree}
          value={assist.lecture}
          label=""
          onpick={(id) => void setLecture(id)}
        />

        <div class="shs" style="margin-top:16px"><b>这些程序里不抓</b></div>
        <div class="shs">
          出厂就拦着的（密码管理器一类，改不了）：<code>{assist.defaults.join('、')}</code>
        </div>
        <div class="shs">
          再补几个的话，写进程名、用逗号隔开（比如 <code>outlook, telegram</code>）。
        </div>
        <input
          class="tin2"
          data-testid="assist-blocked"
          placeholder="进程名，逗号隔开"
          value={assist.blocked}
          onchange={(e) => setAssist(assist?.mode ?? 'off', e.currentTarget.value)}
        />
      {:else}
        <div class="dim" data-testid="assist-loading">读取中…</div>
      {/if}
    </div>
  {:else if tab === 'res'}
    <!--
      ★ 二级：资源 → 启动页 · Colors。
        2026-09-13 之前这里只有一项，注释写着「第二项进来的时候它自然就是
        一列可选对象」—— 第二项就是今天这个 Colors（使用者当天点名
        「Settings → Resources → Colors」）。现在它是一排真的 tab 了。
    -->
    <div class="segs resnav" data-testid="res-nav">
      <button
        class:on={resPage === 'splash'}
        data-testid="res-nav-splash"
        onclick={() => (resPage = 'splash')}>启动页</button
      ><button
        class:on={resPage === 'colors'}
        data-testid="res-nav-colors"
        onclick={() => (resPage = 'colors')}>Colors</button
      >
    </div>
    {#if resPage === 'splash'}
      <SplashRes />
    {:else if resPage === 'colors'}
      <ColorRes />
    {/if}
  {:else if tab === 'data'}
    <!--
      ★ 新手引导 · SC-25（D-483 · 使用者 2026-09-15）
        确认单原话把它放在「Settings › 关于」，**而这个软件没有「关于」这一页**
        （九个一级：AI · Prompts · Practice · Speech · Sync · Dictionary ·
        Assist · Data · Resources）。那是我写确认单时没核就写下的落点。
        落在「数据」这一页的理由：这一页已经全是**动作**（打开数据目录 · 打开日志 ·
        立即备份 · 自检 · 体检）并且显示着构建信息 —— 它事实上就是这个软件的
        「关于 / 维护」页。放这儿不用新开一个一级，也不和别人正在改的那几块撞。
        ☞ 主控要是想另开「关于」，把这一块整段搬过去即可，它不依赖这一页的任何东西。
    -->
    <div class="sblk">
      <div class="sh">新手引导</div>
      <div class="shs">第一次打开软件时的那几句话。</div>
      <button class="btn sm" data-testid="replay-onboarding" onclick={() => onreplayOnboarding?.()}
        >再看一次新手引导</button
      >
      <!--
        ★ D-484 · 第二层有八条，**一条条恢复没意义**（确认单表 D），所以是整张表清掉。
          和上面那颗分开：一个是「把那五步再放一遍」，一个是「让页面上那几句话重新出现」——
          合成一颗的话，他想再看五步就会连带把八条也放回来。
      -->
      <button
        class="btn sm"
        style="margin-left:8px"
        data-testid="reset-guides"
        onclick={() =>
          void resetGuides().then((ok) =>
            say(ok ? '页面提示已重新打开。' : '没保存成功，请重试。')
          )}
        >把页面引导重新打开</button>
    </div>

    <!-- D-206 ·「使用者零编程经验，出问题时要能自己找到并抢救数据。」 -->
    <div class="sblk">
      <div class="sh">数据</div>
      <div class="shs">
        <b>绿色便携</b>：数据就在软件文件夹里，<b>整个文件夹拷走就是完整迁移，备份就是复制文件夹</b>。
      </div>

      {#if dataInfo}
        <div class="row-kv">
          <span class="k">数据库</span><span class="v">{dataInfo.paths.db}</span>
          <span class="k">大小</span><span class="v">{mb(dataInfo.dbBytes)}</span>
          <span class="k">备份</span><span class="v">{dataInfo.paths.backups}</span>
          <span class="k">日志</span><span class="v">{dataInfo.paths.logs}</span>
          <span class="k">提示词</span><span class="v">{dataInfo.paths.prompts}</span>
        </div>

        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn sm" data-testid="open-data" onclick={() => window.nyx.store.openFolder('data')}
            >打开数据文件夹</button
          >
          <button class="btn sm" data-testid="open-logs" onclick={() => window.nyx.store.openFolder('logs')}
            >打开日志文件夹</button
          >
          <button class="btn sm pri" data-testid="backup-now" onclick={backupNow}>立即备份</button>
          <button class="btn sm" data-testid="self-test" onclick={runSelfTest}>自检</button>
        </div>
        {#if selfTest}
          <!-- D-265 · 「能自己验证」比「我说做好了」有用得多 -->
          <div class="notice ok" data-testid="self-test-out" style="margin-top:10px">
            <b>{selfTest.ok ? '一切正常。' : '有问题。'}</b>
            数据库结构 v{selfTest.schemaVersion}／目标 v{selfTest.targetVersion} ·
            SQLite {selfTest.sqliteVersion} · {selfTest.journalMode} ·
            Electron {selfTest.electron}
            <div class="s3" style="margin-top:6px">
              {Object.entries(selfTest.counts)
                .map(([k, v]) => `${COUNT_ZH[k] ?? k} ${v}`)
                .join(' · ')}
            </div>
            <div class="s3">
              刚才真的往数据库写了一行再读回来 —— 读回来的和写进去的一致，
              说明这条链路是活的，不只是「编译通过」。
            </div>
            <!--
              ★ 这一份是哪一份。
              来历：我说「拖拽修好了」，他说「拖拽的不行」—— 两句话都对，
              因为他手上是 03:58 打的包、修复是 04:17 写的。
              「我改的那份」和「他运行的那份」之间必须有一条看得见的连线，
              否则这种对不上的账没人查得清。
            -->
            <div class="s3" data-testid="self-test-build" style="margin-top:6px">
              这一份软件：<code>{selfTest.build.commit}</code>
              {selfTest.build.dirty ? '（打包时有未提交改动）' : ''} ·
              {String(selfTest.build.builtAt).slice(0, 16).replace('T', ' ')} 构建
              {#if selfTest.build.subject}<br />{selfTest.build.subject}{/if}
            </div>
          </div>
        {/if}
        {#if backupNote}
          <div class="notice ok" data-testid="backup-note" style="margin-top:10px">{backupNote}</div>
        {/if}

        <!--
          备份**列表**已从界面撤掉（使用者 2026-08-10：
          「备份…和不再收录的表达都在界面上面消失，然后可以在后台文件夹中显示，
            但是不要在前台显示」）。

          撤的是**显示**，不是机制：D-217 照旧 —— 每次启动备份一次、
          升级数据库结构前先备份、自动保留最近 10 份。文件就在上面那一行
          写着的 `data/backups`，他要看就去文件夹里看。

          为什么撤得掉：那一列文件名对他没有可操作性 —— 看见十行
          `nyx-20260810-090837-pre-v18.db` 既不能点、也不能恢复
          （恢复走的是「从备份导回…」，选文件在那儿）。
        -->

        <!--
          ★ I-113 · 升级时对提示词做了什么。
          「你改过的那份缺了新功能要用的占位符，已另存并换新」——
          **这种事必须让他看见**。原件另存了，但他不知道也等于没存。
        -->
        {#if psync && (psync.replaced.length > 0 || psync.kept.length > 0 || psync.retired.length > 0)}
          <div class="s2" style="margin-top:20px">提示词的升级</div>
          {#each psync.replaced as r (r.file)}
            <div class="errbox" data-testid="psync-replaced" style="margin-bottom:8px">
              <div class="h">{r.file} 换成了新版</div>
              <div>
                你改过的那一份缺了新功能要用的占位符，留着的话那个功能会<b>悄悄失效</b>。
                <br />你原来那份<b>一个字没删</b>，存在：<code>{r.savedTo}</code>
              </div>
            </div>
          {/each}
          {#if psync.kept.length > 0}
            <div class="notice" data-testid="psync-kept">
              这些是你改过的，<b>没动</b>：{psync.kept.join('、')}
              <span class="dim">（出厂有新版，想换就自己对照着改）</span>
            </div>
          {/if}
          <!--
            ★ 退役的提示词（2026-09-03）。
            一个功能删掉之后，它的提示词从仓库里删了，但**他 data/prompts 里
            那份是一次性播种的，谁都不会去动它** —— 留在那儿看着像还有用。
            ★★★ 只报不删：他可能在里面写过自己的东西，
              而「反正没用了」不是我替他删文件的理由（同 prompt-sync 顶上那条）。
          -->
          {#if psync.retired.length > 0}
            <div class="notice" data-testid="psync-retired">
              这几份<b>已经用不上了</b>（对应的功能已经取消）：{psync.retired.join('、')}
              <span class="dim"
                >—— <b>没有帮你删</b>，你自己看着处理；里面要是写过你的东西，先留着</span
              >
            </div>
          {/if}
        {/if}

        <!--
          ★ 9.1 / 9.2 · 数据体检。
          做成他自己能点的按钮 —— 只有我跑得到的检查，对他没有用（D-265）。
          这里的每一条都写清「违反之后你会看到什么」，
          否则一串他看不懂的编号只会让人更慌。
        -->
        <div class="s2" style="margin-top:20px">数据体检</div>
        <div class="s3" style="margin-bottom:8px">
          检查数据之间的关联、两条线的状态、调度和统计口径有没有对不上的地方。
          <span class="dim">只看不改；发现能自动修的，会单独给一个按钮。</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" data-testid="audit-run" disabled={auditing} onclick={runAudit}
            >{auditing ? '检查中…' : '开始体检'}</button
          >
          {#if report && report.findings.some((f) => FIXABLE.includes(f.id))}
            <button class="btn sm pri" data-testid="audit-repair" onclick={runRepair}>修掉能修的</button>
          {/if}
        </div>
        {#if auditErr}
          <div class="errbox" data-testid="audit-error" style="margin-top:10px">
            <div class="h">体检没跑起来</div>
            <div>{auditErr}</div>
          </div>
        {/if}
        {#if report}
          {#if report.findings.length === 0}
            <div class="notice ok" data-testid="audit-clean" style="margin-top:10px">
              <b>{report.checked} 项检查全部通过</b> —— 关联、状态、调度、统计口径都对得上。
            </div>
          {:else}
            <div data-testid="audit-findings" style="margin-top:10px">
              {#each report.findings as f (f.id)}
                <div class="errbox" style="margin-bottom:8px" data-testid="audit-{f.id}">
                  <div class="h">{f.severity === 'error' ? '✕' : '!'} {f.title} · {f.count} 处</div>
                  <div>{f.impact}</div>
                  <div class="dim" style="margin-top:6px;font-size:var(--fs-2)">
                    例如：{f.samples.join(' / ')}
                  </div>
                </div>
              {/each}
              <div class="s3 dim">跑了 {report.checked} 项检查。</div>
            </div>
          {/if}
        {/if}

        <!--
          「不再收录的表达」这一块已从界面撤掉（使用者 2026-08-10）。

          撤的是**显示**，不是机制：4.1 的账本照常记、分析照常跳过。
          而且他不会因此变成瞎的 —— 每次分析结束都会明说
          「这几条因为你以前删过 / 静默过，没有收进来」（AnalyzeResult.skipped），
          判断依据是在**它起作用的那一刻**报的，比设置页里一份静态名单更贴。

          ★ 代价说清楚：撤掉之后**没有地方能把某一条从名单里撤销**了。
             一条删过的表达从此永远跳过。写入口 `ledger.drop` 还在
             （preload 也留着），要恢复这个能力，把这一段放回来就行。
        -->

        <!-- ★ 动作账本 · 2026-09-03（补断链，见脚本里那段注释）-->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="s2" style="margin-top:20px;cursor:pointer" data-testid="ops-head" onclick={toggleOps}>
          动作账本 <Ic n="caret" s={12} r={opsOpen ? 'up' : 'dn'} />
        </div>
        <div class="s3" style="margin-bottom:8px">
          删除 · 彻底删除 · 同步时被盖掉的那一版 —— 都在这儿留着一笔。
          <b>同步说「旧的那版记在账本里」，指的就是这里。</b>
        </div>
        {#if opsOpen}
          {#if opsError}
            <div class="errbox" data-testid="ops-error"><div>{opsError}</div></div>
          {:else if !opsLoaded}
            <div class="s3" data-testid="ops-loading">正在读…</div>
          {:else if ops.length === 0}
            <div class="s3 dim" data-testid="ops-empty">还没有记录。</div>
          {:else}
            <div data-testid="ops-list">
              {#each ops as o (o.id)}
                <div class="sr" data-testid="ops-row">
                  <div class="l">
                    <div class="t3">{OP_SAYS[o.op] ?? o.op}{#if o.title} · <b>{o.title}</b>{/if}</div>
                    <div class="s3 dim">{new Date(o.at).toLocaleString()} · {o.target}</div>
                    <!-- ★ T-2.5 · 结果那句话放在**这一行自己下面** —— 账本可能很长，
                         放页脚等于让他自己去猜刚才点的是哪一条 -->
                    {#if opSaid && opSaid.id === o.id}
                      <div class="s3" class:dim={!opSaid.ok} data-testid="ops-said">{opSaid.text}</div>
                    {/if}
                  </div>
                  <!-- ★ T-2.5 / D-R4 · 只有「被盖掉的那一版」有得还原 -->
                  {#if o.op === 'sync-override'}
                    <button
                      class="btn sm"
                      data-testid="ops-restore"
                      disabled={opRestoring !== null}
                      onclick={() => void restoreOp(o.id)}
                    >{opRestoring === o.id ? '还原中…' : '还原'}</button>
                  {/if}
                </div>
              {/each}
            </div>
            <div class="s3 dim" style="margin-top:6px">最近 {ops.length} 条。</div>
          {/if}
        {/if}

        <!-- D-102 · 只做两种：可原样导回的完整备份，与给人看的可读笔记。不做 .apkg（D-103） -->
        <div class="s2" style="margin-top:20px">导出与导回</div>
        <div class="s3" style="margin-bottom:8px">
          <b>完整备份</b>含两条线进度、原文出处、攻坚记录、{SILENCE_FILTER_NAME}状态，<b>可原样导回</b>；
          <b>可读笔记</b>是给人看的 Markdown，导不回来。
          <span class="dim">不做 Anki .apkg —— 一张 Anki 卡装不下原文出处和主动/被动，两边都练进度还会分叉。</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" data-testid="exp-backup" onclick={doBackupFile}>导出完整备份</button>
          <button class="btn sm" data-testid="exp-notes" onclick={doNotes}>导出可读笔记</button>
          <button class="btn sm" data-testid="exp-restore" onclick={doRestore}>从备份导回…</button>
          <!-- ★ Q-3 · 「清空全部学习数据…」并进下面的危险操作区了：
               它和「清除全部数据」都是不可逆的，本来就该在同一个地方、同一套确认。 -->
        </div>

        <div class="s3" style="margin-top:8px">
          <b>导回是覆盖，不是合并。</b>导回前会自动把当前这份备份下来，反悔得回去。导回后软件会重启。
        </div>
        {#if expNote}
          <div class="notice ok" style="margin-top:10px" data-testid="exp-note">{expNote}</div>
        {/if}

        <div class="notice" style="margin-top:16px">
          <b>崩了怎么办：</b>点「打开日志文件夹」，把 <b>nyx.log</b> 里最后几十行发给 Claude Code。
          <span class="dim">没有日志的话，谁也不知道发生了什么。</span>
        </div>

        <!--
          ★ 危险操作 · 清除全部数据（使用者 2026-08-10）

          放在整页最下面、单独一块红框里 —— 危险操作不该和常规按钮混在一排。
          两阶段确认是他点名要的：先弹一次（默认焦点在「取消」），
          再要求手打 DELETE。**主进程还会各自再判一次**，
          不可逆的操作不能只有一层闸。
        -->
        <!--
          ★ 样式一览（2026-09-07 · Nyx-DS「总标准」会话）

          开发与设计确认用的实物页：按钮五档 × 状态 · 五种反馈载体 ·
          空 / 加载 / 错误 · 进度 · 标签 · 输入 · 表面层级 · 判分，
          全部用 src/core/design/color-tokens.css 的令牌画，一行 HEX 都没有。

          为什么在这儿：它不是产品功能，不该进主导航；
          Android 那边的对应物同样藏在 Settings 深处（ABOUT 连点五下）。
          判据文件是 docs/ui/DESIGN_SYSTEM.md · BUTTON_SYSTEM.md ·
          UI_STATE_MATRIX.md · NOTIFICATION_RULES.md，那几份末尾的
          「等使用者确认」清单，就是靠这一页看实物。
        -->
        <div class="s2 sec-gap">样式一览</div>
        <div class="s3 sec-gap-b">
          按钮 · 反馈 · 状态 · 进度 · 标签 · 输入的实物页，用的是新的颜色令牌。
          <span class="dim">开发与设计确认用，不进主导航。</span>
        </div>
        <button class="btn sm" data-testid="kit-toggle" onclick={() => (kitOpen = !kitOpen)}
          >{kitOpen ? '收起样式一览' : '打开样式一览'}</button
        >
        {#if kitOpen}
          <Kit />
        {/if}

        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="s2 fold-head" style="margin-top:20px" data-testid="fold-danger"
             onclick={() => toggleFold('danger')}>
          危险操作
          <span class="fold-car" class:open={!isFolded('danger')}><Ic n="caret" s={12} /></span>
        </div>
        {#if !isFolded('danger')}
          <div class="foldbody" transition:slide={fold()}>
        <div class="dz" data-testid="danger-zone">
          <div class="dz-h">危险操作</div>
          <div class="dz-t">清除数据</div>
          <div class="dz-d">
            两种程度，<b>点进去再选</b>：只清学习数据是「重来一遍」（设置留着），
            全部清掉是「像没装过」（连 AI key 一起）。<b>两种都不可恢复。</b>
            <div style="margin-top:6px">
              动手前都会自动做一份完整备份 —— 后悔了从「从备份导回…」回来。
            </div>
          </div>

          {#if resetStage === 'idle'}
            <button class="btn sm dz-btn" data-testid="reset-open" onclick={openReset}
              >清除数据…</button>
          {/if}

          <!-- 第一阶段：说清后果，默认焦点在「取消」 -->
          {#if resetStage === 'confirm'}
            <div class="dz-box" data-testid="reset-confirm">
              <div class="dz-t">要清到什么程度？</div>

              <!--
                ★★ Q-3（使用者 2026-09-03 裁「合并」）· 先选程度，再确认。
                默认停在轻的那一档 —— 不可逆操作的默认值该是伤害最小的那个。
              -->
              <div class="dz-lv" data-testid="reset-levels">
                <button
                  class="btn sm"
                  class:on={resetLevel === 'learning'}
                  data-testid="reset-lv-learning"
                  onclick={() => setResetLevel('learning')}
                  >{resetLevel === 'learning' ? '◉' : '○'} 只清学习数据</button>
                <button
                  class="btn sm"
                  class:on={resetLevel === 'all'}
                  data-testid="reset-lv-all"
                  onclick={() => setResetLevel('all')}
                  >{resetLevel === 'all' ? '◉' : '○'} 全部清掉</button>
              </div>

              <div class="dz-d" data-testid="reset-scope">
                {#if resetLevel === 'learning'}
                  全部项目、Lecture、知识点、练习记录都会没有。<b>设置不动</b> ——
                  AI key、同步、词典、朗读、机制参数都留着，是「重来一遍」。
                  <b>此操作不可撤销。</b>
                {:else}
                  把这个软件恢复到<b>从没用过</b>的状态：学习记录、进度、历史、
                  你创建的全部内容、<b>个人设置（含 AI key）</b>、朗读缓存、日志、
                  你改过的提示词，全部清掉。<b>此操作不可撤销，删除后无法恢复。</b>
                {/if}
              </div>
              <!--
                ★ 明说什么**不删**。
                词典是他自己放进来的几 GB 资源 —— 我用一条「删掉除 data 以外的全部」
                删过他 22 本，回收站里都没有。这块字必须在他眼前。
              -->
              <div class="dz-keep">
                <b>不会动的：</b>
                你自己放进 <code>data/dicts</code> 的词典{#if dicts && dicts.files > 0}（{dicts.files}
                  个文件 · {mb(dicts.bytes)}）{/if}、<code>data/backups</code> 里的备份、软件本身。
                <br />动手前还会再做一份完整备份，后悔了从「从备份导回…」回来。
              </div>
              {#if syncS && syncS.kind !== 'off'}
                <div style="margin-top:8px">
                  <button
                    class="btn sm"
                    class:on={resetRemote}
                    data-testid="reset-remote"
                    onclick={() => (resetRemote = !resetRemote)}
                    >{resetRemote ? '☑' : '☐'} 连云端那份副本一起清</button>
                </div>
              {/if}
              <div class="dz-acts">
                <!-- 默认焦点在「取消」——「继续」不许拿到自动焦点 -->
                <!-- svelte-ignore a11y_autofocus -->
                <button class="btn sm" data-testid="reset-cancel" autofocus onclick={cancelReset}
                  >取消</button>
                <button
                  class="btn sm dz-btn"
                  data-testid="reset-continue"
                  onclick={() => (resetStage = 'type')}>继续</button>
              </div>
            </div>
          {/if}

          <!-- 第二阶段：手打 DELETE，完整匹配才放行 -->
          {#if resetStage === 'type'}
            <div class="dz-box" data-testid="reset-type">
              <div class="dz-t">最终确认</div>
              <div class="dz-d">
                {resetLevel === 'all' ? '清除全部数据' : '清空学习数据'}是不可逆操作。
                如果你确定要继续，请在下方输入：
                <code class="dz-word">{resetNeedWord}</code>
              </div>
              <input
                class="tin2"
                data-testid="reset-input"
                placeholder="在这里输入 {resetNeedWord}"
                bind:value={resetWord} />
              {#if resetErr}
                <div class="dz-err" data-testid="reset-error">{resetErr}</div>
              {/if}
              <div class="dz-acts">
                <button class="btn sm" data-testid="reset-cancel2" onclick={cancelReset}>取消</button>
                <!--
                  输入不对就 disabled —— 但 `doReset` 里**还会再判一次**：
                  disabled 只是拦手，不是判据。判据要在动手的那一步上。
                -->
                <button
                  class="btn sm dz-btn"
                  data-testid="reset-go"
                  disabled={!resetReady || resetBusy}
                  onclick={doReset}
                  >{resetBusy
                    ? '正在清除…'
                    : resetLevel === 'all'
                      ? '清除全部数据'
                      : '清空学习数据'}</button>
              </div>
            </div>
          {/if}

          <!-- 结果：一步一行，成败分开写。不许用一句「已清除」盖过去 -->
          {#if resetResult}
            <div
              class="dz-box"
              class:ok={resetResult.ok}
              data-testid={resetResult.ok ? 'reset-done' : 'reset-partial'}>
              <div class="dz-t">
                {resetResult.ok ? '数据已全部清除' : '有几步没做成 —— 下面逐条列出来'}
              </div>
              <div class="dz-d">
                {#each resetResult.steps as st (st.name)}
                  <div>{st.ok ? '✓' : '✗'} {st.name} —— {st.detail}</div>
                {/each}
              </div>
              <div class="dz-keep">
                动手前的完整备份：<code>{resetResult.backup}</code>
              </div>
              {#if resetResult.ok}
                <div class="dz-d"><b>软件马上会自己重启</b>，重启之后就是全新的样子。</div>
              {:else}
                <div class="dz-d">
                  <b>没有全部清干净，所以没有自动重启。</b>
                  上面打 ✗ 的那几步请连同这段发给 Claude Code。
                </div>
              {/if}
            </div>
          {/if}
        </div>
          </div>
        {/if}
      {:else}
        <div class="s2">正在读…</div>
      {/if}
    </div>
  {:else if tab === 'tts'}
    <!-- D-040 · 点击英文即读，口音英/美可切，语速 0.7–1.3×。D-094 · 详情页与卡片上有，列表行里没有
         ★★ D-466（使用者 2026-09-07「语音设置简化」）· 这一页只剩四件事：
            ① 两个开关（词典语音 · 系统语音，默认都开）② 口音 / 语速 ③ 试听 ④ 上次朗读走了谁。
            来源拖动排序 · 八家提供者的清单与徽章 · 地址 / 密钥 / 模型 / 音色 · 测试按钮 ·
            缓存计数与「清空音频缓存」**全部撤掉** —— 那条多厂商的线整条不做了。 -->
    <div class="sblk">
      <div class="sh">声音</div>
      <div class="shs">
        <b>详情页和练习卡片</b>上点英文就读。列表行里<b>不放</b>喇叭 ——
        扫列表时满屏图标反而看不清内容。
      </div>

      <!-- ★★★ 读到了才画控件。**没读到之前一个控件都不许出现** ——
           这一页的控件按下去会把整包设置写回库，而「整包」在数据到位之前
           只能是编出来的默认值：他关掉的开关会被一次点击打开
           （B 2026-09-07 查出来的真 bug，也是「关一次开一次就变了」最省事的解释）。
           判据交给类型：`tts` 是 `TtsSettings | null`，narrow 之后才渲染。 -->
      {#if !tts}
        <div class="s2" data-testid="voice-loading">正在读你的设置…</div>
      {:else}

      <!-- ① 两个开关 —— 顺序是写死的，不是他排的：词典有音就用词典，没有就用系统 -->
      <div class="vsec">用什么读</div>
      <div class="s3" data-testid="voice-order-says">
        <b>词典有原生发音就用词典的，没有就用系统语音</b>。系统语音是通用备用。
        两个都关掉就不出声了 —— 那一下点击会告诉你为什么。
      </div>
      <div class="sr" data-testid="voice-switches">
        <div class="l">
          <div class="t3">{srcLabel('dictionary')}</div>
          <div class="s3">词典自己带的原生音频，多半是真人录的，不走网络</div>
        </div>
        <!-- I-074 · `.sw` 是滑动开关（`.tg` 是标签样式，不是开关） -->
        <div
          class="sw"
          class:on={tts.dictionary}
          class:busy={swBusy === 'tts-dict'}
          role="switch"
          aria-checked={tts.dictionary}
          aria-label="{srcLabel('dictionary')} 用不用"
          tabindex="0"
          data-testid="voice-on-dictionary"
          onclick={() => saveTts({ dictionary: !tts?.dictionary }, 'tts-dict')}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              saveTts({ dictionary: !tts?.dictionary }, 'tts-dict')
            }
          }}
        ></div>
      </div>

      <div class="sr">
        <div class="l">
          <div class="t3">{srcLabel('system')}</div>
          <div class="s3">这台电脑自带的语音引擎，零配置、什么词都读得出来</div>
        </div>
        <div
          class="sw"
          class:on={tts.system}
          class:busy={swBusy === 'tts-sys'}
          role="switch"
          aria-checked={tts.system}
          aria-label="{srcLabel('system')} 用不用"
          tabindex="0"
          data-testid="voice-on-system"
          onclick={() => saveTts({ system: !tts?.system }, 'tts-sys')}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              saveTts({ system: !tts?.system }, 'tts-sys')
            }
          }}
        ></div>
      </div>

      <!-- ② 口音 / 语速 —— 哪一档读都适用 -->
      <div class="vsec">怎么读</div>
      <div class="sr">
        <div class="l">
          <div class="t3">口音</div>
          <div class="s3">影响连读、弱读和元音，跟着你要考的方向选</div>
        </div>
        <div class="r">
          <div class="segs">
            <button class:on={tts.accent === 'en-GB'} data-testid="tts-gb" onclick={() => saveTts({ accent: 'en-GB' })}>英音</button>
            <button class:on={tts.accent === 'en-US'} data-testid="tts-us" onclick={() => saveTts({ accent: 'en-US' })}>美音</button>
          </div>
        </div>
      </div>

      <div class="sr">
        <div class="l">
          <div class="t3">语速 · <b>{tts.rate.toFixed(1)}×</b></div>
          <div class="s3">0.7× 听清每个音，1.3× 逼近真实语速</div>
        </div>
        <div class="r">
          <input
            type="range"
            min="0.7"
            max="1.3"
            step="0.1"
            data-testid="tts-rate"
            value={tts.rate}
            oninput={(e) => saveTts({ rate: Number(e.currentTarget.value) })}
          />
        </div>
      </div>

      <!-- ③ 试听 -->
      <div class="vsec">试听</div>
      <div class="vrow">
        <button class="btn sm pri" data-testid="tts-try" onclick={tryTts}>试听一句</button>
      </div>
      {#if ttsNote}
        <div class="notice vgap" data-testid="tts-note">{ttsNote}</div>
      {/if}

      <!-- ④ 诊断行 —— 「上次朗读走了谁、为什么不是另一个」（D-219：他能贴给我看）
           ★ 这里**一句判断都不做**：每一步的 `reason` 是 core 写好的人话，
             界面只是把它摆出来。再写一份「怎么解释」就是第二份判据（D-238）。 -->
      <div class="vsec">
        上次朗读
        <button class="btn sm vsec-btn" data-testid="voice-trace-refresh" onclick={loadTrace}
          >刷新</button
        >
      </div>
      <div class="vtrace" data-testid="voice-trace">
        {#if voiceTrace}
          <div class="vtrace-head">
            {clock(voiceTrace.at)} · 读了{KIND_SAYS[voiceTrace.kind] ?? voiceTrace.kind} ·
            {#if voiceTrace.spoke}
              <b>{srcLabel(voiceTrace.spoke)}</b> 出的声
            {:else}
              <b>一个都没成</b>
            {/if}
            · <span>{voiceTrace.ms}</span>ms
          </div>
          <ol class="vtrace-steps">
            {#each voiceTrace.steps as st, i (String(i) + st.source)}
              <li class:hit={st.outcome === 'hit'} class:skip={st.outcome === 'skipped'}>
                <b>{srcLabel(st.source)}</b> ——
                <!-- ★ 「为什么」单独包一层，**为的是它能被单独读到**。
                     原来它和后面的毫秒挤在同一个 `li` 里，用例只能按 `——` 切一刀，
                     切出来的那半截里还带着「4ms」—— 于是「原因是空的」也能凑够长度，
                     对照照样绿（主控 2026-09-07 用两条对照抓出来的）。
                     判据读得到的东西必须**只有判据本身**。 -->
                <span data-testid="vtrace-reason" data-source={st.source}>{st.reason}</span>
                {#if st.ms > 0}<span class="dim"> {st.ms}ms</span>{/if}
              </li>
            {/each}
          </ol>
        {:else}
          <div class="s3">
            这一趟还没读过东西。去详情页或练习卡片上点一下英文（或者按上面的「试听一句」），
            这里就会写清楚<b>谁读的、另一个为什么没轮上</b>。
          </div>
        {/if}
      </div>
      {/if}
    </div>
  {:else if tab === 'sync'}
    <!-- D-201 · Supabase 默认 + WebDAV 备选，增量行级，冲突不静默覆盖 -->
    <div class="sblk">
      <div class="sh">同步</div>
      <div class="shs">
        换台机器接着学。<b>只传变过的行</b>，第一次全量，之后每次几十 KB。
        <b>API key 不参与同步</b>，词典也不传（它是本地资源，几个 GB）。
      </div>

      <div class="sr">
        <div class="l">
          <div class="t3">用哪种</div>
          <div class="s3">
            WebDAV 最省事 —— 坚果云、Nextcloud、群晖都行，填个地址加应用密码就完了。
            Supabase 要先在后台建一个存储桶。
          </div>
        </div>
        <div class="r">
          <div class="segs">
            <button class:on={syncForm.kind === 'off'} data-testid="sync-off" onclick={() => (syncForm.kind = 'off')}>关</button>
            <button class:on={syncForm.kind === 'webdav'} data-testid="sync-webdav" onclick={() => (syncForm.kind = 'webdav')}>WebDAV</button>
            <button class:on={syncForm.kind === 'supabase'} data-testid="sync-supabase" onclick={() => (syncForm.kind = 'supabase')}>Supabase</button>
          </div>
        </div>
      </div>

      {#if syncForm.kind !== 'off'}
        {@const dav = syncForm.kind === 'webdav'}
        <div class="s2" style="margin-top:12px">{dav ? '目录地址' : '项目 URL'}</div>
        <input
          class="tin2"
          data-testid="sync-url"
          placeholder={dav ? 'https://dav.jianguoyun.com/dav/我的坚果云' : 'https://xxxx.supabase.co'}
          bind:value={syncForm.url}
        />
        <div class="s2" style="margin-top:10px">{dav ? '账号' : '桶名'}</div>
        <input
          class="tin2"
          data-testid="sync-user"
          placeholder={dav ? '你的邮箱' : 'nyx'}
          bind:value={syncForm.user}
        />
        <div class="s2" style="margin-top:10px">
          {dav ? '应用密码' : 'anon key'}
          {#if syncS?.hasSecret}<span class="dim"> · 已存，留空表示不动它</span>{/if}
        </div>
        <input
          class="tin2"
          type="password"
          data-testid="sync-secret"
          placeholder={dav ? '不是登录密码 —— 在坚果云「安全选项」里生成' : 'eyJ…'}
          bind:value={syncForm.secret}
        />

        <div class="sr" style="margin-top:12px">
          <div class="l">
            <div class="t3">{AUTO_SYNC_ON_BOOT}</div>
            <div class="s3">
              打开之后<b>什么都不用点</b> —— 每次开软件自己同一次。
              有冲突时不会自己选边，会留在这一页等你处理。
            </div>
          </div>
          <div class="r">
            <!-- I-074 · 同上，滑动开关 -->
            <div
              class="sw"
              class:on={syncS?.auto}
              class:busy={swBusy === 'auto'}
              role="switch"
              aria-checked={syncS?.auto ?? false}
              aria-label={AUTO_SYNC_ON_BOOT}
              tabindex="0"
              data-testid="sync-auto"
              onclick={toggleAuto}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleAuto()
                }
              }}
            ></div>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn sm pri" data-testid="sync-save" onclick={saveSync}>保存</button>
          <button class="btn sm" data-testid="sync-test" disabled={syncBusy} onclick={testSync}>测试连接</button>
          <button class="btn sm pri" data-testid="sync-run" data-runs={syncRuns} disabled={syncBusy} onclick={() => runSync()}>
            {syncBusy ? '同步中…' : '现在同步'}
          </button>
        </div>
      {:else}
        <div style="margin-top:14px">
          <button class="btn sm pri" data-testid="sync-save" onclick={saveSync}>保存</button>
        </div>
      {/if}

      {#if syncConflict}
        <!-- ★ D-201 的正题：两边都改过时**停下来问**，这一步什么都还没写进库 -->
        <div class="errbox" data-testid="sync-conflict">
          <div class="h">两边都改过，先看一眼</div>
          <div>{syncConflict}</div>
          <div class="s3" style="margin-top:8px">
            <!-- ★★ R-4-F · 这里以前写着「现在库里一个字都还没动」—— 那句话现在不再是真的，
                 而且当时也只有后半句是真的：冲突会把没冲突的那些一起挡住。
                 现在用真实的数字说话，不写死。 -->
            {#if syncLast}
              <b>这一趟已经同步了 {syncLast.applied} 条</b>，另有
              <b>{syncLast.conflicted} 条</b>两边都改过，等你决定。
            {/if}
            冲突之外的内容已经正常同步了 —— 你不选也不会耽误别的东西。
          </div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn sm" data-testid="sync-take-remote" data-runs={syncRuns} onclick={() => runSync('remote')}>用云端的</button>
            <!-- data-runs：验收要能确定「这一次」跑完了，而不是看见上一次留下的字。
                 「用云端的」那颗一直有，这颗以前没有 —— R-4-F-a 的双机用例要点它 -->
            <button class="btn sm" data-testid="sync-keep-local" data-runs={syncRuns} onclick={() => runSync('local')}>用本地的</button>
          </div>
        </div>
      {/if}

      <!-- ★★ R-4-D · 上一次同步没做成的那些。
           它是**状态**不是一次调用的回执 —— 开机自动同步失败之后，
           他下次打开这一页要看得见，而那时候早就没有那次调用了。 -->
      {#if syncS && syncS.problems.length > 0}
        <div class="errbox" style="margin-top:12px" data-testid="sync-problems">
          <div class="h">{SYNC_INCOMPLETE_TITLE}</div>
          <div>
            有 <b>{syncS.problems.length}</b> 处没做成。出问题的那几行所在的变更包<b
              >没有标成已应用</b
            > —— 点上面的「现在同步」就会重试。
          </div>
          <div class="s3" style="margin-top:8px">
            {#each syncS.problems.slice(0, 5) as p (p.what)}
              <div>· {p.kind === 'run' ? '整次同步' : '写不进去'} {p.what}：{p.message}</div>
            {/each}
            {#if syncS.problems.length > 5}<div>· 还有 {syncS.problems.length - 5} 处</div>{/if}
          </div>
        </div>
      {/if}

      {#if syncNote}
        <div class="notice ok" style="margin-top:12px" data-testid="sync-note">{syncNote}</div>
      {/if}

      {#if syncS}
        <div class="row-kv" style="margin-top:16px">
          <!-- ★ 设备编号已删（Nyx Android 第十九则指令 §十：两端一起）：
               它是同步游标不是用户信息。判据留在 settings['sync.device']。 -->
          <span class="k">上次同步</span>
          <span class="v">{syncS.lastAt ? new Date(syncS.lastAt).toLocaleString('zh-CN') : '从来没有'}</span>
          <span class="k">待推送</span><span class="v" data-testid="sync-pending">{syncS.pending} 行</span>
        </div>
      {/if}

      <div class="notice" style="margin-top:14px">
        同步<b>只追加</b>，从不改别人推上去的东西 —— 网络断在半路，最多少一个包，
        不会损坏已经同步好的数据。而且<b>每次往本地库写之前都先备份一次</b>。
      </div>
    </div>
  {:else if tab === 'dict'}
    <div class="sblk">
      <div class="sh">词典</div>
      <div class="shs">
        词典<b>纯本地</b>，你把文件放进目录，软件自动识别。
        例句来源优先级是<b>本地词典 → AI 生成</b>，知识点详情里会标明每条例句是谁给的
        —— <span class="dim">例句是模仿的样板，样板的可信度必须写在脸上。</span>
        <!--
          ★ D-470（2026-09-07）· 这一句是探针取消之后补的。
            原来「这本词典到底接上没有」由这一页底下那个「随便查一个词试试」回答；
            取消之后如果什么都不说，他就只剩「看着扫到了，但不知道真查不查得出东西」。
            所以这里直接指路 —— 指的是他平时本来就在走的那条路。
        -->
        <div style="margin-top:6px">
          想确认某一本真的查得出东西：<b>在正文里选中一个词右键查词</b>，
          卡片右上角能换书，换到它看看有没有正文。
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn sm" data-testid="dict-folder" onclick={() => window.nyx.dict.openFolder()}
          >打开词典文件夹</button
        >
        <button class="btn sm pri" data-testid="dict-rescan" onclick={rescanDicts}>重新扫描</button>
      </div>

      <div class="notice" style="margin-bottom:12px">
        <b>怎么放：</b>把词典文件拷进上面的目录，然后点「重新扫描」。
        <b>.mdx</b>（MDict）和 StarDict 那一组（<b>.ifo</b> ·
        <b>.idx</b> · <b>.dict</b>）都认。
        <span class="dim">
          用 LZO 压缩的、或者需要注册码的 .mdx 读不了 —— 那种会在下面直接标出来，
          不会让你以为放进去了却查不到。
        </span>
      </div>

      {#if dictRows.length === 0}
        <div class="s2" data-testid="dict-empty">
          还没有识别到词典。<b>没有词典软件照常用</b> —— 例句改由 AI 生成，并标明来源。
        </div>
      {:else}
        <!-- D-234 · 可排序定优先级、可停用某一本 -->
        {#each dictRows as d, i (d.id)}
          <div class="sr" data-testid="dict-row">
            <div class="l">
              <div class="t3">
                <span>{i + 1}.</span>
                {d.bookname}
                {#if !d.enabled}<span class="tg" data-testid="dict-off">已停用</span>{/if}
                {#if d.missing}<span class="tg" data-testid="dict-missing">文件不见了</span>{/if}
              </div>
              <div class="s3">{d.wordCount} 词 · <span class="dim">{d.folder}</span></div>
              {#if d.problem}
                <!-- 装不起来必须说出原因，否则它只是「在列表里但查不到」（D-262） -->
                <div class="s3" data-testid="dict-problem" style="color:var(--bad)">
                  这本用不了：{d.problem.split('\n')[0]}
                </div>
              {/if}
            </div>
            <div class="r" style="display:flex;gap:6px;align-items:center">
              <button
                class="btn sm"
                data-testid="dict-up-{d.id}"
                disabled={i === 0}
                onclick={() => moveDict(i, -1)}>↑</button
              >
              <button
                class="btn sm"
                data-testid="dict-down-{d.id}"
                disabled={i === dictRows.length - 1}
                onclick={() => moveDict(i, 1)}>↓</button
              >
              <!-- I-050 · 原来只有一个没有文字的小开关，看不出是干什么的 -->
              <button
                class="btn sm"
                class:pri={!d.enabled}
                data-testid="dict-toggle-{d.id}"
                onclick={() => toggleDict(d.id, !d.enabled)}
                >{d.enabled ? '停用' : '启用'}</button
              >
            </div>
          </div>
        {/each}
        <div class="s3" style="margin-top:8px">
          查词按这个顺序走，第一本查到就用它。关掉的那本不参与。
        </div>
      {/if}

      <!--
        ★ D-470（2026-09-07）· 「随便查一个词试试」取消（使用者点名）。
          「词典到底接上没有」由**他真的用到词典的地方**回答：查词浮层与悬浮卡片。
          设置这一页只回答「软件该怎么运转」：放哪儿 · 扫一次 · 顺序 · 开关 · 哪本有问题。
      -->
      {#if dictNote}
        <div class="notice" style="margin-top:12px" data-testid="dict-note">{dictNote}</div>
      {/if}
    </div>
  {/if}
{/if}

<!--
  ══ 认读测试 · 两个弹窗（D-479）══════════════════════════════

  ① 牌面：每行一个，勾 / 不勾。**多选** —— 他要「挖空 + 英文释义都来」时不再需要
     另写一份整段提示词（那正是这次要治的病）。
  ② 出题规则：一份正文，改完对**所有牌面**生效。

  形状用这套界面里已有的：浮层 `.ov` + `.acard`，行用 `.sr` + 滑动开关 `.sw`
  （和「声音」页那两个开关同一套，不新发明第二套）。
-->
{#if facesOpen && readState}
  <div class="ov on" data-testid="faces-modal">
    <div class="acard" style="width:min(680px,100%)">
      <div class="sh">认读测试 · 牌面</div>
      <div class="s2" style="margin-bottom:8px;margin-top:4px">
        勾上的都会被用到 —— 出每一张卡时按规则从里面挑一种。
        <span class="dim">至少留一面：一面都不勾，认读就退回原来的机械挖空了。</span>
      </div>

      {#if readError}
        <div class="errbox" data-testid="faces-error">
          <div class="h">没存成</div>
          <div>{readError}</div>
        </div>
      {/if}
      {#if readNote}<div class="notice ok" data-testid="faces-note">{readNote}</div>{/if}

      <!--
        ★ 主控 2026-09-08 点名：一面都没勾要**说一句人话**。
          正常路径上他勾不到零面（存的时候主进程当场拒绝），但这个状态**同步得过来**
          （另一台设备 / 老版本写下的偏好）。那时认读会安静退回机械挖空 ——
          屏幕上不说一句，他只会觉得「AI 牌面怎么不见了」。
      -->
      {#if facesOn.length === 0}
        <div class="errbox" data-testid="faces-none">
          <div class="h">现在一面都没勾</div>
          <div>认读卡会退回原来的机械挖空 —— 勾上任意一面就恢复。</div>
        </div>
      {/if}

      {#each readState.faces as f (f.id)}
        <div class="sr" data-testid="face-{f.id}">
          <div class="l">
            <div class="t3">
              {f.name}
              <!-- ★ 哪几面是他自己建的，要一眼看得出：出厂那四面改不了、删不了 -->
              {#if f.custom}<span class="facemine" data-testid="face-mine-{f.id}">自建</span>{/if}
            </div>
            <div class="s3">{f.says}</div>
          </div>
          {#if f.custom}
            <button class="btn sm" data-testid="face-edit-{f.id}" onclick={() => editFace(f)}
              >改</button>
            <button class="btn sm" data-testid="face-del-{f.id}" onclick={() => void removeFace(f.id)}
              >删</button>
          {/if}
          <!-- I-074 · `.sw` 是滑动开关（`.tg` 是标签样式，不是开关） -->
          <div
            class="sw"
            class:on={f.on}
            role="switch"
            aria-checked={f.on}
            aria-label="{f.name} 用不用"
            tabindex="0"
            data-testid="face-on-{f.id}"
            onclick={() => toggleFace(f.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleFace(f.id)
              }
            }}
          ></div>
        </div>
      {/each}

      <!--
        ══ 新建牌面（使用者 2026-09-14 第一条）══════════════════════
        ★ 三样都要填，而且说清每一样是给谁看的：
            名字     —— 屏上那一档写什么，也是模型该写进「形式：」那一行的词
            给你看   —— 只给人读，AI 看不到
            给 AI 看 —— **真正发出去的那一段**，空着这一面就什么都没说
          最后一条是这个表单里唯一一个「填错了不报错、但功能等于没有」的地方，
          所以它的标签上直接写着这句话，不指望他自己推。
      -->
      {#if faceEdit}
        <div class="facenew" data-testid="face-form">
          <div class="ttl">{faceEdit.id ? '改这一面' : '新建一个牌面'}</div>

          <label class="fl" for="face-name">名字<span class="dim">　最多 6 个字，屏幕上显示的就是它</span></label>
          <input
            id="face-name"
            class="tin2"
            maxlength="6"
            placeholder="比如：造句"
            data-testid="face-name"
            bind:value={faceEdit.name} />

          <label class="fl" for="face-says">这一面给你看什么<span class="dim">　只给人读，AI 看不到</span></label>
          <input
            id="face-says"
            class="tin2"
            placeholder="一句话说清这一面会考成什么样"
            data-testid="face-says"
            bind:value={faceEdit.says} />

          <label class="fl" for="face-guide"
            >给 AI 的说明<span class="dim">　真正发出去的就是这一段。空着的话这一面出不了题</span></label>
          <textarea
            id="face-guide"
            class="tin2"
            rows="5"
            placeholder={'造句 —— 给一个需要用到这条知识点的处境，让他自己造一句。\n  别把它写进题面，也别给近义词。'}
            data-testid="face-guide"
            bind:value={faceEdit.guide}></textarea>

          <div class="s2" style="margin-top:8px">
            不许露答案、必须按两行输出 —— 这两条在<b>出题规则</b>那一份里，对所有牌面一起生效，
            <span class="dim">所以这里不用再写一遍。</span>
          </div>

          <div style="display:flex;gap:8px;margin-top:12px">
            <button
              class="btn sm pri"
              disabled={faceBusy}
              data-testid="face-save"
              onclick={() => void submitFace()}>{faceBusy ? '存…' : '存下来'}</button>
            <button class="btn sm" data-testid="face-cancel" onclick={() => (faceEdit = null)}
              >取消</button>
          </div>
        </div>
      {/if}

      <div style="display:flex;gap:8px;margin-top:12px">
        {#if !faceEdit}
          <button class="btn sm" data-testid="face-new" onclick={newFace}
            ><Ic n="plus" s={16} /> 新建牌面</button>
        {/if}
        <button class="btn sm" data-testid="faces-close" onclick={closeReading}>关掉</button>
      </div>
    </div>
  </div>
{/if}

{#if rulesOpen && readState}
  <div class="ov on" data-testid="rules-modal">
    <div class="acard" style="width:min(680px,100%)">
      <div class="sh">认读测试 · 出题规则</div>
      <div class="s2" style="margin-bottom:8px;margin-top:4px">
        这一份管的是<b>怎么出</b>：挑哪张牌面、题面给多少线索。
        <span class="dim">每一面<b>写什么</b>在「牌面」那边，不在这里。</span>
      </div>

      {#if readError}
        <div class="errbox" data-testid="rules-error">
          <div class="h">没存成</div>
          <div>{readError}</div>
        </div>
      {/if}
      {#if readNote}<div class="notice ok" data-testid="rules-note">{readNote}</div>{/if}

      <!--
        ★ 三段控件用这套界面里本来就有的 `.segs`（BUTTON_SYSTEM §四 Segmented：
          选中 = 主色字 + 底线，不做填充胶囊堆），开关用 `.sw` —— 一个新样式都没加。
      -->
      <div class="sr" data-testid="opt-facepick">
        <div class="l">
          <div class="t3">挑哪种考法</div>
          <div class="s3">同一条知识点，每次用哪张牌面来问</div>
        </div>
        <div class="r">
          <div class="segs">
            <button
              class:on={readState.options.facePick === 'quote-first'}
              data-testid="facepick-quote"
              onclick={() => setReadOption({ facePick: 'quote-first' })}>{FACE_PICK_SAYS['quote-first']}</button>
            <button
              class:on={readState.options.facePick === 'rotate'}
              data-testid="facepick-rotate"
              onclick={() => setReadOption({ facePick: 'rotate' })}>{FACE_PICK_SAYS.rotate}</button>
            <button
              class:on={readState.options.facePick === 'random'}
              data-testid="facepick-random"
              onclick={() => setReadOption({ facePick: 'random' })}>{FACE_PICK_SAYS.random}</button>
          </div>
        </div>
      </div>

      <div class="sr" data-testid="opt-hint">
        <div class="l">
          <div class="t3">提示强度</div>
          <div class="s3">题面给多少线索</div>
        </div>
        <div class="r">
          <div class="segs">
            <button
              class:on={readState.options.hintLevel === 'more'}
              data-testid="rhint-more"
              onclick={() => setReadOption({ hintLevel: 'more' })}>{READING_HINT_SAYS.more}</button>
            <button
              class:on={readState.options.hintLevel === 'normal'}
              data-testid="rhint-normal"
              onclick={() => setReadOption({ hintLevel: 'normal' })}>{READING_HINT_SAYS.normal}</button>
            <button
              class:on={readState.options.hintLevel === 'less'}
              data-testid="rhint-less"
              onclick={() => setReadOption({ hintLevel: 'less' })}>{READING_HINT_SAYS.less}</button>
          </div>
        </div>
      </div>

      <!--
        ★★ 没勾「场景补全」时这一条**变灰并说明原因**，不隐藏 ——
          隐藏会让他以为功能没了（确认单 §一 R-3）。
      -->
      <div class="sr" data-testid="opt-shift">
        <div class="l">
          <div class="t3">换个场合再考</div>
          <div class="s3">
            {scenarioOn ? '编场景时不要重复原文里的话题' : '勾上「场景补全」后可用'}
          </div>
        </div>
        <div
          class="sw"
          class:on={readState.options.shiftContext}
          class:nope={!scenarioOn}
          role="switch"
          aria-checked={readState.options.shiftContext}
          aria-disabled={!scenarioOn}
          aria-label="换个场合再考"
          tabindex="0"
          data-testid="opt-shift-sw"
          onclick={() => setReadOption({ shiftContext: !readState!.options.shiftContext })}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setReadOption({ shiftContext: !readState!.options.shiftContext })
            }
          }}
        ></div>
      </div>

      <!--
        ★★ 他以前写过的那段出题规则（确认单 §四）：**一个字不动地留着**，只读给他看。
          不去猜那段话对应哪几个选项 —— 猜错了就是悄悄改掉他定的考法。
      -->
      {#if readState.legacy}
        <div class="s2" style="margin-top:12px">
          你以前写的出题规则已经停用，在这儿可以看到。
          <span class="dim">现在出题按上面三个选项来。</span>
        </div>
        <textarea
          class="tin2"
          rows="8"
          readonly
          data-testid="rules-legacy"
          value={readState.legacy}></textarea>
      {/if}

      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn sm" data-testid="rules-close" onclick={closeReading}>关掉</button>
      </div>
    </div>
  </div>
{/if}

{#if pRulesOpen && pRules}
  <div class="ov on" data-testid="prules-modal">
    <div class="acard" style="width:min(680px,100%)">
      <div class="sh">产出练习 · 出题规则</div>
      <div class="s2" style="margin-bottom:8px;margin-top:4px">
        这一份管的是<b>怎么出</b>：给你多少材料、题目摆在哪、答案要多完整。
        <span class="dim">对勾上的所有题型一起生效；题型那边管的是<b>做什么题</b>。</span>
      </div>

      {#if qtypeError}
        <div class="errbox" data-testid="prules-error">
          <div class="h">没存成</div>
          <div>{qtypeError}</div>
        </div>
      {/if}
      {#if qtypeNote}<div class="notice ok" data-testid="prules-note">{qtypeNote}</div>{/if}

        <div class="sr" data-testid="opt-phint">
          <div class="l">
            <div class="t3">提示程度</div>
            <div class="s3">出题时给你多少辅助材料</div>
          </div>
          <div class="r">
            <div class="segs">
              <button
                class:on={pRules.hintLevel === 'full'}
                data-testid="phint-full"
                onclick={() => setPracticeRule({ hintLevel: 'full' })}>{PRACTICE_HINT_SAYS.full}</button>
              <button
                class:on={pRules.hintLevel === 'gloss-only'}
                data-testid="phint-gloss"
                onclick={() => setPracticeRule({ hintLevel: 'gloss-only' })}>{PRACTICE_HINT_SAYS['gloss-only']}</button>
              <button
                class:on={pRules.hintLevel === 'none'}
                data-testid="phint-none"
                onclick={() => setPracticeRule({ hintLevel: 'none' })}>{PRACTICE_HINT_SAYS.none}</button>
            </div>
          </div>
        </div>

        <div class="sr" data-testid="opt-spread">
          <div class="l">
            <div class="t3">语境跨度</div>
            <div class="s3">题目场景离你收它的那篇材料有多远</div>
          </div>
          <div class="r">
            <div class="segs">
              <button
                class:on={pRules.contextSpread === 'near'}
                data-testid="spread-near"
                onclick={() => setPracticeRule({ contextSpread: 'near' })}>{CONTEXT_SPREAD_SAYS.near}</button>
              <button
                class:on={pRules.contextSpread === 'mixed'}
                data-testid="spread-mixed"
                onclick={() => setPracticeRule({ contextSpread: 'mixed' })}>{CONTEXT_SPREAD_SAYS.mixed}</button>
              <button
                class:on={pRules.contextSpread === 'far'}
                data-testid="spread-far"
                onclick={() => setPracticeRule({ contextSpread: 'far' })}>{CONTEXT_SPREAD_SAYS.far}</button>
            </div>
          </div>
        </div>

        <div class="sr" data-testid="opt-fullsent">
          <div class="l">
            <div class="t3">必须写完整句</div>
            <div class="s3">只写一个词组算不算过</div>
          </div>
          <div
            class="sw"
            class:on={pRules.requireFullSentence}
            role="switch"
            aria-checked={pRules.requireFullSentence}
            aria-label="必须写完整句"
            tabindex="0"
            data-testid="opt-fullsent-sw"
            onclick={() => setPracticeRule({ requireFullSentence: !pRules!.requireFullSentence })}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setPracticeRule({ requireFullSentence: !pRules!.requireFullSentence })
              }
            }}
          ></div>
        </div>

        <div class="sr" data-testid="opt-register">
          <div class="l">
            <div class="t3">贴着原文的语域</div>
            <div class="s3">正式 / 口语要和你收它的那句一致</div>
          </div>
          <div
            class="sw"
            class:on={pRules.matchRegister}
            role="switch"
            aria-checked={pRules.matchRegister}
            aria-label="贴着原文的语域"
            tabindex="0"
            data-testid="opt-register-sw"
            onclick={() => setPracticeRule({ matchRegister: !pRules!.matchRegister })}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setPracticeRule({ matchRegister: !pRules!.matchRegister })
              }
            }}
          ></div>
        </div>

      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn sm" data-testid="prules-close" onclick={() => (pRulesOpen = false)}
          >关掉</button>
      </div>
    </div>
  </div>
{/if}
