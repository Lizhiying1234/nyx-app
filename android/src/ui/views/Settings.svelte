<script lang="ts">
  /**
   * Settings —— 信息架构重构版（2026-08-31 · 指令第十则 · D-408）。
   *
   * ══ 总原则（指令十三，逐字）══════════════════════════════
   *   「Settings 只应该暴露用户真的需要主动改变的东西。」
   *   需要主动决定 → 这里；可自动判断 → 后台；Windows 才需要 → 删；
   *   无真实价值 → 删；同一概念 → 合并。
   *
   * ══ 结构 ═══════════════════════════════════════════════
   *   首页只有五个一级入口（.l1 大层级），细节全在二级页（Tab 内导航栈，
   *   系统返回逐级退 —— backstack 注册）。D-408 清查台账已随结论入宪后删除。
   *
   * ══ 判据不在这里 ═══════════════════════════════════════
   *   保存位置 = capture.ts；词典 = dict.ts；同步 = core 引擎；
   *   AI 三槽 = db/ai.ts；朗读 = db/tts.ts。这里只是摆上屏。
   */
  import SyncPanel from '../lib/SyncPanel.svelte'
  import AiPanel from '../lib/AiPanel.svelte'
  import TtsPanel from '../lib/TtsPanel.svelte'
  import NotifyRow from '../lib/NotifyRow.svelte'
  import SavePicker from '../lib/SavePicker.svelte'
  import Dialog from '../lib/Dialog.svelte'
  import Kit from './Kit.svelte'

  import { untrack } from 'svelte'
  import { store } from '../lib/store.svelte.ts'
  import { FAIL_AFTER } from '../../db/notify.ts'
  import {
    getSplashChoice,
    setSplashChoice,
    getSplashNames,
    setSplashName,
    writeSplashUrlMirror,
    type SplashName
  } from '../../db/splash.ts'
  import { SILENCE_ACTIONS, encodeSplashChoice, shownChoice, type SplashChoice } from '../../core-link.ts'
  import { SPLASH_ART, SPLASH_ICON } from '../lib/splash-art.ts'
  import { listSplashFiles, splashFileUrl } from '../../db/splash-files.ts'
  import { COLOR_GROUPS } from '../lib/color-parts.ts'
  /**
   * ★ 默认名与名字上限都从 core 引（2026-09-13）——
   *   本仓**不留自己那一份**：两端算出来不一样的话，没起过名的图会显示不同名字，
   *   而那看起来就像同步坏了。
   */
  import { defaultLabel, MAX_LABEL } from '../../core-link.ts'
  import ColorPicker from '../lib/ColorPicker.svelte'
  import { applyColors, colorNow, shippedColors } from '../lib/theme.ts'
  import {
    activeOverrides,
    cleanModeName,
    DEFAULT_MODE_ID,
    DEFAULT_MODE_NAME,
    getActiveModeId,
    getColorModes,
    saveColorModes,
    setActiveModeId,
    writeMirror,
    type ColorMode
  } from '../../db/colors.ts'
  import { OVERRIDABLE_PROMPTS, promptPrefKey, type QTypeRow } from '../../core-link.ts'
  /**
   * 出题规则七个选项（D-482）。**屏上的字也从 core 拿**（`*_SAYS`）——
   * 两端一个说法（CR-7），各写各的必然漂而且不会有东西报错。
   */
  import {
    CONTEXT_SPREAD_SAYS,
    FACE_PICK_SAYS,
    PRACTICE_FACE_FACTORY,
    PRACTICE_FACE_SAYS,
    PRACTICE_HINT_SAYS,
    READING_QTYPE_FACTORY,
    READING_QTYPE_SAYS,
    isCustomFaceId,
    practiceFaceOf,
    readingQTypeOf,
    resolveFace,
    serializeFacePrefs,
    type FacePref,
    type PracticeFace,
    type ReadingQType,
    PRACTICE_RULES_FACTORY,
    QUIZ_RULE_KEYS,
    READING_HINT_SAYS,
    READING_RULES_FACTORY,
    onFaces,
    parseFacePrefs,
    practiceRulesOf,
    readingRulesOf,
    type ContextSpread,
    type FacePick,
    type PracticeHint,
    type ReadingHint
  } from '../../core-link.ts'
  import { legacyReadingRules } from '../../db/lookup.ts'
  import { builtinPromptText } from '../../db/prompts.ts'
  import { prefRaw, prefSet } from '../../db/prefs.ts'
  import { listQTypes, saveQTypeRow, deleteQType, toggleQType, restoreQTypes } from '../../db/qtypes.ts'
  import type { Db } from '../../db/types.ts'
  import { route, type SettingsNode, type SettingsPg } from '../lib/route.svelte.ts'
  import { onboard } from '../lib/onboarding.svelte.ts'
  import { guide } from '../lib/guide.svelte.ts'
  import { clearGuideSeen } from '../../db/guide.ts'
  import Toggle from '../lib/Toggle.svelte'

  /** ★ 构建指纹连点五下 = 样式一览（F-005）。离开 ABOUT 页就清零，不跨页累计 */
  let kitTaps = $state(0)
  import { assistGranted, openA11ySettings, openAppSettings, pushAssistConfig } from '../lib/assist.svelte.ts'
  import { assistSay, KEEP_ALIVE_HINT } from '../lib/assist-auth.ts'
  import { savePathLabel, saveTargetLabel } from '../../db/capture.ts'
  import { DEFAULT_AI_PROMPT, DEFAULT_QUICK_PROMPT } from '../../db/lookup.ts'
  import {
    defaultBook,
    dictSkipped,
    listDicts,
    listRetiredDicts,
    reorderDicts,
    scanDictFolder,
    setDictEnabled,
    type DefaultBookPick,
    type DictRow,
    type SkippedItem
  } from '../../db/dict.ts'
  import { drag, dragRow, setDropHandler } from '../lib/dragsort.svelte.ts'
  import { listDictFolder, pickDictFolder } from '../lib/dictfs.ts'
  import { snacks } from '../lib/snack.svelte.ts'

  /** 二级页导航栈：home → (assist | dict | speech | data | about)；assist → assist-ai */
  /**
   * ★ 页面状态已上收到全应用唯一的 Route（`lib/route.svelte.ts`，D-411）。
   *   栈为空 = Settings 的 Root（首页）；`assist-ai` 是压在 `assist` 上的第三级，
   *   所以「父页」不再需要一张 PARENT 表 —— **栈本身就是父子关系**。
   *   返回也不再由本组件注册，由 App.svelte 的 backstack 统一消费。
   */
  type Pg = 'home' | SettingsPg
  const pg = $derived<Pg>((route.stacks.settings.at(-1) as SettingsNode | undefined)?.pg ?? 'home')
  const go = (p: SettingsPg): void => {
    note = null
    route.push({ k: 'pg', pg: p })
    // ★ 进哪一页就读哪一页要的东西 —— 首页不预读，否则打开设置就跑一串查询
    if (p === 'prompts') void (loadPromptStates(), loadQuizRules())
    if (p === 'qtypes') void loadQuizRules()
    // ★ 每次进来重算一遍「现在会落到哪」：跟随模式下他刚在 ASSIST 页改了默认位置，
    //   这一行必须当场说新的那条路径，不能还挂着进设置那一刻的旧值。
    // ★ D-488：`lookup-search` 那份提示词的入口搬到了这一页，
    //   所以这一页现在也要 `promptState`（否则那一行的「改过 / 默认」永远显示默认）。
    if (p === 'lookup') void (refreshLkLabel(), loadPromptStates())
  }

  async function refreshLkLabel(): Promise<void> {
    if (store.db.k !== 'ok') return
    lkLabel = await saveTargetLabel(store.db.db, 'lookup')
  }

  /**
   * ══ 这一行 note 只放两种东西（使用者 2026-09-14 第五条）══════════
   *
   * 他的原话：「纯信息 / 成功反馈 → 自动消失；需要用户决策或确认 → 才使用需要点击的弹窗」。
   * 判据用房子自己那份（`docs/ui/NOTIFICATION_RULES.md` §二），不另发明：
   *
   *   一次性、不跟控件绑着  → **回执条**（`snacks.show`，4 秒自走）
   *   跟某个控件绑着        → Inline（就地一行）
   *   失败                  → **不自动消失**
   *
   * ★★ 为什么这一行**不是** Inline：它画在整个 Settings 视图的**顶部**（返回键下面），
   *   不在产生它的那个控件旁边。所以「一次性的成功」放进来既不就地、也不会自己走 ——
   *   两头不靠。2026-09-14 把 8 条搬去了回执条（配色 5 · 词典顺序 1 · 提示词 2）。
   *
   * ☞ **现在只剩两类，加东西之前先对一遍**：
   *   ① 跟 Assist 那个开关绑着的**状态**（还差一步 / 开了 / 已就绪）—— 它描述的是开关
   *     此刻的处境，不是「刚做成了一件事」，所以该留在原地直到状态变。
   *   ② **失败**（没改成 / 扫描没成 / 读不了）—— 「没看见就没了」对失败不可接受。
   *
   * ★ 闸：`tests/ui-notify.test.ts`（两个方向都钉：成功不许进 note、失败不许进回执条）。
   */
  let note = $state<string | null>(null)

  // ── ASSIST（Enable 闭环 + 保存位置 + AI）─────────────────────
  let enabled = $state(true)
  /** Assist 总开关的第三态：正在写状态 / 正在问系统授权（ST-Q6） */
  let assistBusy = $state(false)

  /**
   * ══ 资源 · 启动页用哪一张（2026-09-09）════════════════════════
   * ★ 这个值**不同步**（`settings`，设备本地）—— 使用者原话
   *   「win 和 android 可以有不同的启动页，**共享的是图片资源**」。
   * ★ 候选可以多个，**在用的只能一个**（他强调过两遍）：所以「在用」用两种记号说 ——
   *   卡上的「使用中」徽章 + 底下那一行「这台手机在用」；候选只是卡本身。
   *   两种记号不共用，屏上数得出「使用中」恰好一枚。
   * ★ 「传自己的图」那一档**还没接**：名字判据在 core，而两端的哈希算法还没对齐
   *   （Android 没有 WebCrypto，只有纯 JS sha256；core 现在写的是 sha1）。
   *   没对齐就先做一半 = 两端算出不同的名字，比晚做几天贵得多。
   */
  /**
   * 候选清单 —— 一屏**只放一张**（使用者 2026-09-09），左右滑着换。
   *
   * ★★ 2026-09-09 使用者裁「启动页只能保留一个」之后，第一档的意思变了：
   *   以前叫「系统默认」= **不画应用内那一帧**，落到系统那一帧（水獭）。
   *   现在系统那一帧不画图了（只剩一块纯色底），水獭挪进应用内那一帧 ——
   *   所以它不再是「系统的」那一张，名字必须跟着改成**默认图标**。
   *   ☞ 名字不改就是在屏上说假话（D-412）：那一档已经和系统无关了。
   * ★ 顺序：它仍是**第一张**（使用者 2026-09-09 指定）。
   * ★ 注意：第一张 ≠ 默认值。**没设过时默认仍是出厂插画**（回退链第二档，
   *   见 `splashNow`）—— 「排在最前」和「默认用哪张」是两件事，别混。
   *
   * ★ `fixed` = 不许改名（使用者 2026-09-09：「除了系统默认不能改，其他都可以改」）。
   *   内置图标是回退链的最后一档、永远在，它的名字是**判据的一部分**，不是称呼。
   * ★ `id` 用 `encodeSplashChoice` 的字面 —— 和库里存「用哪一张」的那个键同一套字面，
   *   改名表就不会和选择表对不上。「传自己的图」接上之后往后面加就是了，版式不用动。
   */
  interface SplashCand {
    c: SplashChoice
    /** 完整字面（`icon` / `shipped` / `user:<名>`）—— 比较与改名都用它 */
    id: string
    /** 出厂名（他没改过名时屏上显示的） */
    name: string
    /** 不许改名（内置图标是回退链的最后一档，名字是判据的一部分） */
    fixed: boolean
    /** 预览用什么地址；内置两档由渲染层自己决定，所以是 null */
    url: string | null
  }

  const SPLASH_BUILTIN: SplashCand[] = [
    { c: { kind: 'icon' }, id: 'icon', name: '默认图标', fixed: true, url: null },
    { c: { kind: 'shipped' }, id: 'shipped', name: '出厂插画', fixed: false, url: null }
  ]

  /**
   * 同步下来的图（使用者 2026-09-13：「图片要是电脑端同步进来的」）。
   * ★ 手机上**没有**上传入口 —— 那是他明确不要的。这一端只收不传。
   * ★ 名字是内容哈希，屏上没法看 —— 默认名取前 6 位当代号（`图 a1b2c3`），
   *   他可以改名（改名表在 `settings`，与选择同一档，不同步）。
   */
  let splashFiles = $state<string[]>([])
  let splashUrls = $state<Record<string, string>>({})

  const SPLASH_CANDS = $derived<SplashCand[]>([
    ...SPLASH_BUILTIN,
    ...splashFiles.map((n) => ({
      c: { kind: 'user' as const, name: n },
      id: `user:${n}`,
      name: defaultLabel(n),
      fixed: false,
      url: splashUrls[n] ?? null
    }))
  ])

  /** 现在滑到第几张（不是「在用哪张」——那是 splashNowId）*/
  let slide = $state(0)
  function onDeckScroll(e: Event): void {
    const el = e.currentTarget as HTMLElement
    if (el.clientWidth > 0) slide = Math.round(el.scrollLeft / el.clientWidth)
  }

  let splashChoice = $state<SplashChoice | null>(null)
  /** 这台机器给候选起的名字（`encodeSplashChoice` → 名字）。没起过就用出厂名。 */
  let splashNames = $state<Record<string, SplashName>>({})
  $effect(() => {
    const db = store.db
    if (db.k !== 'ok') return
    void (async () => {
      splashChoice = await getSplashChoice(db.db)
      splashNames = await getSplashNames(db.db)
      const files = await listSplashFiles()
      const urls: Record<string, string> = {}
      for (const n of files) {
        const u = await splashFileUrl(n)
        if (u !== null) urls[n] = u
      }
      splashFiles = files
      splashUrls = urls
      dbg.at = Date.now()
      dbg.files = files
      dbg.urls = Object.keys(urls).length
    })()
  })

  /**
   * ③ 档验收通道（同 `globalThis.nyxTts` / `nyxDb` / `nyxSpx` 的纪律：
   * 不看界面，看数）。启动页那一批候选是「同步下来几张」决定的 ——
   * 屏上只看得见结果，看不见「读到了没有、读到几张、地址取出来几条」。
   * ★ 只读不写，删掉它行为一模一样。
   */
  const dbg: { at: number; files: string[]; urls: number } = { at: 0, files: [], urls: 0 }
  ;(globalThis as Record<string, unknown>)['nyxSplashLib'] = dbg

  /**
   * 在用的是**哪一张**（完整字面，不是 kind）。
   * ★ 以前这里是 `splashChoice?.kind` —— 只有两档时够用，
   *   有多张「我的图」之后它们 kind 全是 `user`，会把它们认成同一张。
   */
  const splashNowId = $derived(splashChoice ? encodeSplashChoice(splashChoice) : 'shipped')

  /**
   * ══ 屏上认哪一张在用（**悬空时退回出厂插画**）★★ ═══════════════
   *
   * `splashNowId` 是**库里存着的**那个选择；它可能指向一张**已经不在本机的图** ——
   * 使用者 2026-09-14 裁「连桶一起删」之后，他在电脑上删掉一张，这一趟同步
   * 就会把手机这份也删掉，而 `splash.choice` 还写着 `user:<那张>`。
   *
   * ★ **库里那条故意不清掉**：它记着「他本来要哪一张」。哪天他把同一张图加回来
   *   （`gone:false` 压过旧碑），那一张回来的同时**他的选择也就自动复原了**。
   *   清成 `shipped` 的话，那份记忆就没了，他得重新挑一次。
   *
   * ★★ 但**屏上要说真话**：图不在了，启动那一帧会退回出厂插画
   *   （`index.html` 加载失败的兜底），所以这里也退回出厂插画 —— 两处一致。
   *   在这之前，卡上的「使用中」徽章比的是原始 id，**悬空时一枚都不亮**，
   *   而底下那句却说「在用：出厂插画」—— 屏上数得出的「使用中」是 **0 枚**，
   *   违反这个文件自己立的那条（「两种记号不共用，屏上数得出恰好一枚」）。
   *
   * ★★★ 退法本身**不在这里写**（B-1 · 2026-09-14）：core `shownChoice` 就是这条判据，
   *   Windows `73d57b5` 起在用。这里原来是自己写的一个三目 ——
   *   同一条回退链两端各写一份，正是 D-238 要挡的那种。
   *   ☞ 闸：`tests/splash-one-frame.test.ts::★★ 悬空要退回出厂插画`。
   */
  const splashShownNowId = $derived(
    encodeSplashChoice(
      shownChoice(
        splashChoice ?? { kind: 'shipped' },
        SPLASH_CANDS.map((x) => x.c)
      )
    )
  )
  /** 屏上叫什么：他起的名字优先，没起过用出厂名 */
  function splashLabel(cand: SplashCand): string {
    return splashNames[cand.id]?.label ?? cand.name
  }
  /** 现在滑到的那一张（越界时给 null，别让 `!` 满天飞） */
  const splashCand = $derived(SPLASH_CANDS[slide] ?? null)

  async function pickSplash(cand: SplashCand): Promise<void> {
    if (store.db.k !== 'ok') return
    await setSplashChoice(store.db.db, cand.c)
    splashChoice = cand.c
    /**
     * ★ 「我的图」还要把**地址**抄进镜像：启动那一帧在开库之前就要画，
     *   而 `user:<名>` 只是个文件名，换成地址是异步的，那一刻等不起。
     *   换回内置两档时必须清掉，否则启动会去加载一张不该用的图。
     */
    writeSplashUrlMirror(cand.c.kind === 'user' ? (splashUrls[cand.c.name] ?? null) : null)
    note =
      cand.c.kind === 'icon'
        ? '启动页：默认图标。下次打开就是那只水獭。'
        : `启动页：${splashLabel(cand)}。下次打开就能看见。`
  }

  /* ══ 资源 · 配色模式（使用者 2026-09-13 交办）══════════════
     一个模式 = 一整套颜色。点不同模式像 Tab 切换；每个模式下有「应用」。
     ★ 「出厂配色」不是一条存在库里的记录，是**一条覆盖都没有**那个状态 ——
       所以它永远在、永远等于这一版包里的出厂色，清了数据也回得去。
     ★ 不同步（使用者原话：两端分别管理自己的）。存 `settings`。 */
  let colorModes = $state<ColorMode[]>([])
  /** 在用哪一档（真的打在屏上的那一个） */
  let colorActive = $state(DEFAULT_MODE_ID)
  /** 正在看哪一档（Tab 选中的那一个）—— 和「在用」是两件事 */
  let colorSel = $state(DEFAULT_MODE_ID)
  /** 展开的是哪一组；null = 都收着 */
  let colorGrp = $state<string | null>(null)
  let renameColor = $state<{ id: string; now: string } | null>(null)
  /** 正在调哪一个部件；null = 没开拾色器 */
  let picking = $state<{ token: string; zh: string } | null>(null)

  $effect(() => {
    const db = store.db
    if (db.k !== 'ok') return
    void (async () => {
      colorModes = await getColorModes(db.db)
      colorActive = await getActiveModeId(db.db)
      colorSel = colorActive
    })()
  })

  /** 正在看的那一档的覆盖表（出厂档 = 空） */
  const selOverrides = $derived(
    colorSel === DEFAULT_MODE_ID
      ? {}
      : (colorModes.find((m) => m.id === colorSel)?.overrides ?? {})
  )
  const selName = $derived(
    colorSel === DEFAULT_MODE_ID
      ? DEFAULT_MODE_NAME
      : (colorModes.find((m) => m.id === colorSel)?.name ?? DEFAULT_MODE_NAME)
  )

  async function persistColors(modes: ColorMode[]): Promise<void> {
    if (store.db.k !== 'ok') return
    colorModes = modes
    await saveColorModes(store.db.db, modes)
  }

  /** 应用 = 把这一档打到屏上，并记成「在用」 */
  async function applyColorMode(id: string): Promise<void> {
    if (store.db.k !== 'ok') return
    await setActiveModeId(store.db.db, id)
    colorActive = id
    const o = await activeOverrides(store.db.db)
    applyColors(o)
    writeMirror(o)
    snacks.show(id === DEFAULT_MODE_ID ? '回到出厂配色了' : `换成「${selName}」了`)
  }

  /** 新建 —— **以正在看的这一档为底**（他多半是想在现有基础上改） */
  async function newColorMode(): Promise<void> {
    const id = `m${Date.now().toString(36)}`
    const base = { ...selOverrides }
    const name = cleanModeName(`配色 ${colorModes.length + 1}`) ?? '配色'
    await persistColors([...colorModes, { id, name, overrides: base }])
    colorSel = id
    snacks.show('建好了 —— 改完记得点「应用」')
  }

  async function doRenameColor(v: string): Promise<void> {
    const r = renameColor
    renameColor = null
    if (r === null) return
    const name = cleanModeName(v)
    if (name === null) return
    await persistColors(colorModes.map((m) => (m.id === r.id ? { ...m, name } : m)))
  }

  async function deleteColorMode(id: string): Promise<void> {
    await persistColors(colorModes.filter((m) => m.id !== id))
    colorSel = DEFAULT_MODE_ID
    // 删掉的正好是在用的那一档 —— 屏上得当场回到出厂色，不能留着一套不存在的配色
    if (colorActive === id) await applyColorMode(DEFAULT_MODE_ID)
    else snacks.show('删掉了')
  }

  /** 改一个部件的颜色。改的是**正在看**的那一档；它正好在用就立刻上屏。 */
  async function setPartColor(token: string, hex: string): Promise<void> {
    if (colorSel === DEFAULT_MODE_ID) return // 出厂档只读
    const modes = colorModes.map((m) =>
      m.id === colorSel ? { ...m, overrides: { ...m.overrides, [token]: hex } } : m
    )
    await persistColors(modes)
    // 这一档正在用 → 屏上当场就变了，不必再说一遍；没在用才要提醒他点「应用」
    if (colorActive !== colorSel) snacks.show('改好了 —— 记得点「应用」')
    if (colorActive === colorSel) {
      const o = modes.find((m) => m.id === colorSel)?.overrides ?? {}
      applyColors(o)
      writeMirror(o)
    }
  }

  /** 把一个部件改回出厂 —— 从覆盖表里**删掉**它，而不是写一个等于出厂值的数 */
  async function clearPartColor(token: string): Promise<void> {
    if (colorSel === DEFAULT_MODE_ID) return
    const modes = colorModes.map((m) => {
      if (m.id !== colorSel) return m
      const o = { ...m.overrides }
      delete o[token]
      return { ...m, overrides: o }
    })
    await persistColors(modes)
    if (colorActive === colorSel) {
      const o = modes.find((m) => m.id === colorSel)?.overrides ?? {}
      applyColors(o)
      writeMirror(o)
    }
  }

  /**
   * 改名（使用者 2026-09-09）—— 只改**这台机器上怎么称呼它**，图本身不动。
   * ★ 用统一 Dialog 原语，不另造弹窗（DS §10.8）。
   * ★ 清空 = 恢复出厂名，不是「叫空白」——所以 `allowEmpty`，
   *   并且在弹窗里把这句说出来，别让人试出来。
   */
  let renaming = $state<{ id: string; now: string; def: string } | null>(null)
  function openRename(cand: SplashCand): void {
    renaming = { id: cand.id, now: splashLabel(cand), def: cand.name }
  }
  async function doRename(v: string): Promise<void> {
    const r = renaming
    renaming = null
    if (r === null || store.db.k !== 'ok') return
    splashNames = await setSplashName(store.db.db, r.id, v)
    snacks.show('改好了')
  }
  let granted = $state<boolean | null>(null)
  /** Enable 时没授权 → 引导去系统页；回来（visibilitychange）自动收尾 */
  let pendingGrant = $state(false)
  /** ★ T-6.7 · 屏幕上说哪句话 —— 判定在纯函数里（有 ② 档用例钉着） */
  const say = $derived(assistSay({ granted, wanted: enabled }))
  let locLabel = $state<string | null>(null)
  let locOpen = $state(false)
  let aiPrompt = $state('')
  let quickPrompt = $state('')
  let promptDlg = $state<'quick' | 'full' | null>(null)

  // ── LOOKUP（T-5.9③ · D-R21 已裁 B）───────────────────────────
  /**
   * 默认保存位置两模式。★ 「跟随」不是把 Assist 的值抄一份过来 ——
   *   它是**解析时才读**（capture.ts::decideSaveTarget），所以他在 Assist 里
   *   改了默认位置，这里自然跟着变。抄一份就是第二份真相。
   */
  let lkMode = $state<'follow' | 'custom'>('follow')
  /** 现在**真的**会落到哪（解析过的三级路径）。只说不建 —— 见 saveTargetLabel */
  let lkLabel = $state<string | null>(null)
  let lkOpen = $state(false)

  // ── DICTIONARY ──────────────────────────────────────────────
  let dictFolder = $state<string | null>(null)
  let dictBooks = $state<DictRow[]>([])
  /** 上一次列夹子跳过了哪些（T-5.16）—— 进页面就读得到，不必为了看一眼重扫 */
  let dictSkip = $state<SkippedItem[]>([])
  let skipOpen = $state(false)
  /** 退役的行（I-159）—— 书目不列它们，但「它去哪了」要在这一页查得到 */
  let dictRetired = $state<DictRow[]>([])
  let retiredOpen = $state(false)
  let dictDefault = $state<DefaultBookPick | null>(null)
  let dictScanning = $state(false)

  let aLoaded = false
  $effect(() => {
    if (store.db.k !== 'ok' || aLoaded) return
    aLoaded = true
    const db = store.db.db
    untrack(() => {
      void (async () => {
        const g = async (k: string): Promise<string | null> => {
          const r = await db.get(`select value from settings where key = ?`, [k])
          return r?.['value'] != null ? String(r['value']) : null
        }
        enabled = (await g('assist.enabled')) !== '0'
        const lid = Number((await g('assist.save.lectureId')) ?? 0)
        locLabel = lid > 0 ? await savePathLabel(db, lid) : null
        lkMode = (await g('lookup.save.mode')) === 'custom' ? 'custom' : 'follow'
        lkLabel = await saveTargetLabel(db, 'lookup')
        aiPrompt = (await g('assist.ai.prompt')) ?? ''
        quickPrompt = (await g('assist.ai.quickPrompt')) ?? ''
        dictFolder = await g('dict.folderUri')
        dictBooks = await listDicts(db)
        dictSkip = await dictSkipped(db) // T-5.16 · 不必为了看一眼跳过项重扫一遍
        dictRetired = await listRetiredDicts(db) // I-159 · 退役的也不必重扫才看得见
        dictDefault = await defaultBook(db)
        granted = await assistGranted()
      })()
    })
  })

  async function setFlag(key: string, v: string): Promise<void> {
    if (store.db.k !== 'ok') return
    await store.db.db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [key, v, Date.now()]
    )
  }

  /**
   * Enable 闭环（指令十一）：开 = 状态 ON → 有授权则星立即出现；
   * 没授权则明确带去系统页，回来自动收尾（listener 在下面）——
   * 绝不出现「UI 显示 Enable 了，屏幕上什么都没发生」。
   * 悬浮星不再是独立开关（清查 #2 合并）：星跟随总开关。
   */
  /**
   * ★ 三态（ST-Q6 · B3）：写状态 + 问系统授权这一段是**要等的**，
   *   此前那段时间开关上什么都不发生。现在它停在「正在生效」，且期间点不动。
   * ★ 失败弹回：`finally` 保证不会卡在第三态；`catch` 把脸改回真实状态并说一句 ——
   *   开关说「开了」而其实没开，比点了没反应更糟。
   */
  async function toggleAssist(): Promise<void> {
    if (assistBusy) return
    const prev = enabled
    const next = !enabled
    assistBusy = true
    enabled = next
    try {
      await setFlag('assist.enabled', next ? '1' : '0')
      if (!next) {
        void pushAssistConfig(false)
        note = null
        return
      }
      granted = await assistGranted()
      if (granted === false) {
        pendingGrant = true
        note = '还差一步：在系统无障碍里打开「Nyx Assist」—— 现在带你去，开完回来星就会亮。'
        void openA11ySettings()
        return
      }
      void pushAssistConfig(true)
      note = granted === true ? 'Assist 开了 —— 星在第三方 App 里等你。' : null
    } catch (e) {
      enabled = prev
      note = `没改成：${(e as Error)?.message ?? String(e)} —— 开关弹回了，再试一次。`
    } finally {
      assistBusy = false
    }
  }

  /**
   * ★★ 回到前台就**重新问一次系统**（T-6.7）。
   *
   * 在这之前这里有一句 `|| !pendingGrant` 的早退 —— 也就是说**只有**他从
   * Enable 开关那条路去系统页、再回来，这一屏才刷新。而无障碍授权会被
   * 「强制停止」那一类事件在背后撤销（2026-09-06 在他机器上量的：
   * `am force-stop` 之后 `enabled_accessibility_services` 变成 `null`，
   * `am kill` 不会）—— 那时他并没有走开关那条路，于是这一屏会一直显示着
   * **过期的「已放行」**，而星其实早就没了。
   *
   * 现在：每次回到前台都现问一次。问一次的代价是一个 Settings.Secure 读，
   * 而它买到的是「屏幕上写的和系统此刻的状态一致」。
   */
  $effect(() => {
    const onBack = (): void => {
      if (document.visibilityState !== 'visible') return
      void (async () => {
        granted = await assistGranted()
        if (granted === true && pendingGrant) {
          pendingGrant = false
          void pushAssistConfig(enabled)
          note = 'Assist 已就绪 —— 星在第三方 App 里等你。'
        }
      })()
    }
    document.addEventListener('visibilitychange', onBack)
    return () => document.removeEventListener('visibilitychange', onBack)
  })

  async function pickLoc(lid: number): Promise<void> {
    await setFlag('assist.save.lectureId', String(lid))
    if (store.db.k === 'ok') locLabel = await savePathLabel(store.db.db, lid)
    locOpen = false
  }
  async function autoLoc(): Promise<void> {
    if (store.db.k === 'ok') {
      await store.db.db.run(`delete from settings where key = 'assist.save.lectureId'`)
    }
    locLabel = null
    locOpen = false
  }

  /** LOOKUP · 选了一个具体讲次 → custom（T-5.9②） */
  async function pickLkLoc(lid: number): Promise<void> {
    await setFlag('lookup.save.mode', 'custom')
    await setFlag('lookup.save.lectureId', String(lid))
    lkMode = 'custom'
    await refreshLkLabel()
    lkOpen = false
  }
  /**
   * LOOKUP · 回到「跟随 Assist」。
   * ★ 连 `lookup.save.lectureId` 一起删：留着一个不生效的 id，下次谁读到都会
   *   以为它还管事 —— 半个真相比没有真相贵。缺省就是 follow，所以 mode 也不必写。
   */
  async function followLkLoc(): Promise<void> {
    if (store.db.k === 'ok') {
      await store.db.db.run(
        `delete from settings where key in ('lookup.save.mode', 'lookup.save.lectureId')`
      )
    }
    lkMode = 'follow'
    await refreshLkLabel()
    lkOpen = false
  }
  async function savePrompt(v: string): Promise<void> {
    const which = promptDlg
    promptDlg = null
    if (!which) return
    const key = which === 'quick' ? 'assist.ai.quickPrompt' : 'assist.ai.prompt'
    if (which === 'quick') quickPrompt = v
    else aiPrompt = v
    if (v) await setFlag(key, v)
    else if (store.db.k === 'ok') {
      await store.db.db.run(`delete from settings where key = ?`, [key])
    }
  }

  function folderLabel(uri: string): string {
    try {
      const tail = decodeURIComponent(uri.split('/').pop() ?? uri)
      return tail.includes(':') ? tail.slice(tail.indexOf(':') + 1) || tail : tail
    } catch {
      return uri
    }
  }
  async function chooseDictFolder(): Promise<void> {
    const uri = await pickDictFolder()
    if (!uri) return
    dictFolder = uri
    await setFlag('dict.folderUri', uri)
    await rescanDicts()
  }
  async function rescanDicts(): Promise<void> {
    if (store.db.k !== 'ok' || !dictFolder || dictScanning) return
    dictScanning = true
    try {
      const listing = await listDictFolder(dictFolder)
      const r = await scanDictFolder(store.db.db, listing.files, listing.skipped)
      dictBooks = await listDicts(store.db.db)
      dictDefault = await defaultBook(store.db.db)
      dictSkip = listing.skipped
      dictRetired = await listRetiredDicts(store.db.db)
      note =
        `扫描完成：${r.ok} 本可用` +
        (r.failed ? ` · ${r.failed} 本读不了（行上有说法）` : '') +
        (r.missing ? ` · ${r.missing} 本不在夹里了` : '') +
        // ★ I-159 · 退役的也说出来：它不是失踪，是本来就不是词典
        (r.retired ? ` · ${r.retired} 项退役（本来就不是词典）` : '') +
        // ★ T-5.16 · 跳过的**说出来**：原来子目录与 config.ini 是被 Java 静默扔掉的
        (r.skipped ? ` · 跳过 ${r.skipped} 项（不是词典文件）` : '') +
        '。' +
        // ★ 没看全就直说，不许悄悄少看
        (listing.incomplete ? ' ' + listing.incomplete : '')
    } catch (e) {
      note = `扫描没写成：${(e as Error)?.message ?? e}`
    } finally {
      dictScanning = false
    }
  }
  async function toggleBook(b: DictRow): Promise<void> {
    if (store.db.k !== 'ok') return
    await setDictEnabled(store.db.db, b.id, !b.enabled)
    dictBooks = await listDicts(store.db.db)
  }

  $effect(() => {
    setDropHandler((group, ids) => {
      if (group !== 'dict' || store.db.k !== 'ok') return
      const db = store.db.db
      void (async () => {
        await reorderDicts(db, ids)
        dictBooks = await listDicts(db)
        dictDefault = await defaultBook(db)
        snacks.show('顺序记住了 —— 查词按这个先后逐本命中')
      })()
    })
    return () => setDropHandler(null)
  })
  const dcls = (id: number): string => {
    const a = drag.active
    if (!a) return ''
    if (a.group !== 'dict') return 'dragdim'
    if (a.id === id) return 'draglift'
    if (a.overId === id) return a.before ? 'dropb' : 'dropa'
    return ''
  }

  /** 一级入口（指令十四结构裁剪：无可调外观不设 APPEARANCE；学习参数删尽后朗读如实叫 SPEECH） */
  /** 一级纯英文（第十一则指令 §2：不给一级菜单塞解释文本） */
  // ── PROMPTS（⑤ · 2026-09-01）─────────────────────────────
  /** 哪一条正在编辑（null = 列表态）。名单来自 core，不在这里另列一份 */
  let editingPrompt = $state<string | null>(null)
  let promptText = $state('')
  let promptDirty = $state(false)
  /** 每条的状态：改过没有、现在多长 —— 列表上一眼看得出哪条被动过 */
  let promptState = $state<Record<string, { edited: boolean; chars: number }>>({})

  // ══ 出题规则（D-482）══════════════════════════════════════
  /** 理解层三个 · 写作层四个。值全走 core 的 `*RulesOf`，认不出的由 core 回出厂 */
  let qr = $state(READING_RULES_FACTORY)
  let qw = $state(PRACTICE_RULES_FACTORY)
  /** R-3「换个场合」只在勾了「场景补全」时有意义 —— 界面变灰并说明，**不隐藏** */
  let scenarioOn = $state(true)
  /** 他以前写的那段出题规则正文（只读展示；没改过就是 null，屏上不多那一行） */
  let legacyRules = $state<string | null>(null)
  /** 出题规则的弹窗 —— 两个模式各一个（三层里只有这一层是弹窗，一眼分得出不同实体） */
  let wOpen = $state(false)
  let rOpen = $state(false)
  /**
   * Prompt 页顶部那个模式开关（D-488）：一次只显示一个模式，
   * 于是「牌面 / 题型 / 出题规则」那三个段名不会同屏出现两遍。
   * ★ 只在这一页里活着，**不落库** —— 它是「我现在在看哪一半」，
   *   不是「我要怎么被考」。后者才进偏好（`core/prefs.ts` 开头那句问法）。
   */
  let pTab = $state<'reading' | 'practice'>('reading')

  // ══ D-486 · 三层补齐那两格 ════════════════════════════════
  /**
   * ★ 认读的牌面：**手机上第一次有勾选面**。core 早就有这条偏好（`reading.faces`）、
   *   一直跟着同步走、出题时真的按它出 —— 只是这一端从来没给过入口。
   * ★ 递的是**整条偏好**不是 id：他自建的那一面正文只在这条偏好里，
   *   丢了 id 之外的东西那一面就会被静静丢掉（`db/lookup.ts` 那条教训）。
   */
  let facePrefs = $state<FacePref[]>([])
  /** 要删的那一面（自建才有）—— D-412：删除给确认，文案说真话 */
  let delFace = $state<{ id: string; name: string } | null>(null)
  /** 产出的牌面（单选）· 认读的题型（单选）—— 两把新键，出厂值在 core */
  let pFace = $state<PracticeFace>(PRACTICE_FACE_FACTORY)
  let rQType = $state<ReadingQType>(READING_QTYPE_FACTORY)

  async function loadQuizRules(): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    const keys = Object.values(QUIZ_RULE_KEYS)
    const vals = await Promise.all(keys.map((k) => prefRaw(db, k)))
    const got = new Map(keys.map((k, i) => [k, vals[i] ?? null]))
    const read = (k: string): string | null => got.get(k as (typeof keys)[number]) ?? null
    qr = readingRulesOf(read)
    qw = practiceRulesOf(read)
    pFace = practiceFaceOf(read)
    rQType = readingQTypeOf(read)
    /**
     * ★ `parseFacePrefs` 的宽容读法就是判据：认不出的 id 丢掉、缺的按出厂补在后面。
     *   所以这里读出来的**永远是一份完整名单**，界面直接照它渲染，不在这一层补。
     */
    facePrefs = parseFacePrefs(await prefRaw(db, 'reading.faces'))
    scenarioOn = onFaces(facePrefs).some((f) => f.id === 'scenario')
    legacyRules = await legacyReadingRules(db)
  }

  /**
   * 勾 / 取消一张认读牌面。
   *
   * ★★ **一面都不留是允许的** —— 那是他明确取消掉的东西，不许替他勾回来
   *   （`buildReadingPrompt` 回 null，认读安静退回机械挖空，D-338）。
   *   但屏上要**当场说出后果**，否则他只会觉得认读突然变笨了。
   * ★ 整份写回（`serializeFacePrefs`）：这条偏好的值本来就是一整串有序 JSON，
   *   `ARRAY_PREFS_MERGE_WHOLE` 那一族同款。
   */
  /**
   * 删掉一张**自建**牌面。
   *
   * ★ 只删这一条偏好里的那一项 —— 自建牌面的正文本来就只活在这条偏好里
   *   （没有表可放），所以从名单里去掉就是删干净了。
   * ★ 内置那四面**删不掉也不给删**：`parseFacePrefs` 读的时候会把缺的按出厂补回来，
   *   给一颗按下去没用的键就是一句假话。
   * ★ 这一笔跟着同步走 —— 电脑那边也会少一张。删除是不可逆的，所以先确认（D-412）。
   */
  async function removeFace(id: string): Promise<void> {
    if (store.db.k !== 'ok') return
    await prefSet(store.db.db, 'reading.faces', serializeFacePrefs(facePrefs.filter((f) => f.id !== id)))
    delFace = null
    await loadQuizRules()
  }

  async function toggleFace(id: string): Promise<void> {
    if (store.db.k !== 'ok') return
    const next = facePrefs.map((f) => (f.id === id ? { ...f, on: !f.on } : f))
    await prefSet(store.db.db, 'reading.faces', serializeFacePrefs(next))
    await loadQuizRules()
  }

  /** 存一项并立刻回读 —— 回读是为了让屏上显示的永远是**库里那一份**，不是我以为的那一份 */
  async function setQuiz(key: string, value: string): Promise<void> {
    if (store.db.k !== 'ok') return
    await prefSet(store.db.db, key, value)
    await loadQuizRules()
  }

  async function loadPromptStates(): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    const out: Record<string, { edited: boolean; chars: number }> = {}
    for (const p of OVERRIDABLE_PROMPTS) {
      const over = (await prefRaw(db, promptPrefKey(p.name)))?.trim() ?? ''
      const base = await builtinPromptText(p.name)
      out[p.name] = { edited: !!over, chars: (over || base).length }
    }
    promptState = out
  }

  async function openPrompt(name: string): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    const over = (await prefRaw(db, promptPrefKey(name)))?.trim()
    promptText = over || (await builtinPromptText(name))
    promptDirty = false
    editingPrompt = name
    route.push({ k: 'pg', pg: 'prompt-edit' })
  }

  async function saveSharedPrompt(): Promise<void> {
    if (store.db.k !== 'ok' || !editingPrompt) return
    const name = editingPrompt
    try {
      // ★ 与内置原文一致就当作「没改过」—— 存一份一模一样的副本，
      //   下次改内置版本时他反而收不到（那份副本会一直盖着）。
      const base = await builtinPromptText(name)
      const v = promptText.trim() === base.trim() ? '' : promptText
      await prefSet(store.db.db, promptPrefKey(name), v)
      promptDirty = false
      await loadPromptStates()
      snacks.show(v ? '改好了 —— 下一题就用这一版，也会同步到电脑' : '和默认一样，按「没改过」记')
    } catch (e) {
      note = (e as Error)?.message ?? String(e)
    }
  }

  async function resetPrompt(): Promise<void> {
    if (store.db.k !== 'ok' || !editingPrompt) return
    await prefSet(store.db.db, promptPrefKey(editingPrompt), '')
    promptText = await builtinPromptText(editingPrompt)
    promptDirty = false
    await loadPromptStates()
    snacks.show('回到默认了')
  }

  // ── 题型（⑤）────────────────────────────────────────────
  let qtypes = $state<QTypeRow[]>([])
  let qtErr = $state<string | null>(null)
  let editQt = $state<(Partial<QTypeRow> & { name: string }) | null>(null)

  const dbOf = (): Db => {
    if (store.db.k !== 'ok') throw new Error('库还没打开，等一下再试。')
    return store.db.db
  }

  async function loadQTypes(): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      qtypes = await listQTypes(store.db.db)
      qtErr = null
    } catch (e) {
      qtErr = (e as Error)?.message ?? String(e)
    }
  }
  /** core 的两条护栏（不许删空一档 / 不许全停用一档）会抛错 —— 原样传上去，不吞 */
  async function qtAct(run: () => Promise<unknown>): Promise<void> {
    try {
      await run()
      qtErr = null
      await loadQTypes()
    } catch (e) {
      qtErr = (e as Error)?.message ?? String(e)
    }
  }

  const qtToggle = (q: QTypeRow): Promise<void> =>
    qtAct(() => toggleQType(dbOf(), q.uid, !q.enabled))
  const qtRestore = (): Promise<void> => qtAct(() => restoreQTypes(dbOf()))
  const qtSave = (): Promise<void> =>
    qtAct(async () => {
      const q = editQt
      if (!q) return
      if (!q.name.trim()) throw new Error('题型得有个名字 —— 练习弹窗里要靠它认。')
      if (!(q.guide ?? '').trim())
        throw new Error('写一句「这一题让他干什么」—— 出题时整段进提示词，空着 AI 只能瞎猜。')
      await saveQTypeRow(dbOf(), q as Partial<QTypeRow> & { name: string })
      editQt = null
    })
  const qtDelete = (): Promise<void> =>
    qtAct(async () => {
      const q = editQt
      if (!q?.uid) return
      await deleteQType(dbOf(), q.uid, q.name)
      editQt = null
    })

  const TOP: { pg: SettingsPg; en: string }[] = [
    { pg: 'assist', en: 'Assist' },
    // ★ T-5.9③（D-R21 已裁 B）：LOOKUP 与 ASSIST 并列 —— 两件事各自一页，
    //   「Lookup 在做什么、Assist 在做什么」一眼分得清。紧挨着 Assist 放，
    //   因为它们是同一族（两个入口 · 共享 Save 判据），中间不隔别的。
    { pg: 'lookup', en: 'Lookup' },
    // ★ ⑤：Prompt 与题型都是「AI 拿什么去干活」，放在 Assist 之后、词典之前
    { pg: 'prompts', en: 'Prompts' },
    { pg: 'dict', en: 'Dictionary' },
    { pg: 'speech', en: 'Speech' },
    // ★ 第九个一级（使用者 2026-09-13：「Connecting 不适合继续放在 Prompt 里面」）。
    //   放在 Speech 与 Data 之间：Speech / Connection 都是「接哪个外面的服务」，
    //   Data 是「你的东西在哪」—— 服务在前、数据在后。
    { pg: 'connection', en: 'Connection' },
    { pg: 'data', en: 'Data' },
    // ★ 第八个一级（使用者 2026-09-09 裁「就加第八个一级『资源』」）。
    //   放在 Data 与 About 之间：它是「你的东西长什么样」那一族，紧挨着 Data。
    { pg: 'resources', en: 'Resources' },
    { pg: 'about', en: 'About' }
  ]
</script>

<div class="view">
  <!-- ★ 屏顶标识整块删（D-418/D-419）：首页的「设置」重复底部 Tab；
       二级页的面包屑（SETTINGS › ASSIST）两截都删 —— 前截是导航说过的，
       后截按使用者裁决「我是谁也一起删」。
       ★ 2026-09-01 补：**二级页留返回箭头**。标识可以删，返回不能只剩系统手势 ——
       Vault 四个子页一直有 ←，Settings 没有，这个不一致由使用者点名补齐。
       箭头只做一件事：退一层（判据仍在 Route，这里不自己管栈）。 -->
  {#if pg !== 'home'}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={() => route.pop()}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
    </div>
  {/if}
  {#if note}<div class="note" role="status">{note}</div>{/if}

  {#if pg === 'home'}
    <!-- ══ 首页：只有五个一级入口，没有别的（指令八「非常干净」）══ -->
    <div>
      {#each TOP as t (t.pg)}
        <button class="l1" onclick={() => go(t.pg)}>
          <span class="en">{t.en}</span>
          <!-- ★ 静态标记（B4 · NT-Q2）：同步失败 1–2 次只在入口上留一枚记号，
               **不打断**。第 3 次起改由内容区顶部的 Banner 说，这里就交棒 ——
               一件事同时两处说话，等于说了两遍还互相削弱。
               ★ 它是「数出来的事实」那一档：条件消失（同步成功）它自己就没了。 -->
          {#if t.pg === 'data' && store.syncFail >= 1 && store.syncFail < FAIL_AFTER}
            <span class="tag t-w zh">{store.syncFail} 次没同步成功</span>
          {/if}
          <span class="arr2"><svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
        </button>
      {/each}
    </div>
  {:else if pg === 'assist'}
    <!-- ══ ASSIST：Enable（闭环）· 默认保存位置 · AI › ══ -->
    <div class="set">
      <!-- ★ 开关归开关，授权归授权（§十一 可交互元素分类）：
           此前整行可点既管开关又管去系统页，两件事挤在一个热区里。
           现在 Toggle 只管开/关；没授权时另给一条**文字动作**。 -->
      <!-- ★ T-6.7 · 说哪句话由纯函数定（assist-auth.ts::assistSay）——
           最容易犯的错是把「系统撤销了」说成「你关了」：两件事界面上长得一样，
           对他的意义完全相反。所以三态判定抽出去，有 ② 档用例钉着。 -->
      <!-- ★★ `capture-entry`（清单 14）的靶子挂在**总开关这一行**，不挂在划词浮层上。
           那句话是「在其他应用里选中英文，就能收进 Nyx。」—— 它要在他**还没用过**的时候
           说才有用；等浮层弹出来时他已经划过词了，那时再说等于复述他刚做过的事。
           这一行是这个能力在 App 内唯一的常驻入口。
           ★ 本页因此有两条（`assist-lecture` + 本条）—— CR-3 每页 ≤ 2（使用者 2026-09-15 裁），
             且「一次页面停留只出一条」照旧，两条会分两次进这一页时各出一次。 -->
      <div class="li" data-guide="capture-entry">
        <span class="g">
          <span class="zh s14">Enable Assist</span>
          <small>{say.says}</small>
        </span>
        <Toggle on={enabled} busy={assistBusy} label="Assist 总开关" onchange={() => void toggleAssist()} />
      </div>
      {#if say.why}
        <!-- 为什么又要开一次 —— 这一句是事实，不是道歉，也不猜是谁干的 -->
        <div class="li"><span class="g"><small class="zh">{say.why}</small></span></div>
      {/if}
      {#if say.showGrant}
        <div class="li" style:min-height="44px">
          <button class="txt" onclick={() => void openA11ySettings()}>
            去系统里放行 Nyx
            <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
          </button>
        </div>
      {/if}
      {#if say.showKeepAlive}
        <div class="li" style:min-height="44px">
          <span class="g"><small class="zh">{KEEP_ALIVE_HINT}</small></span>
          <button class="txt" onclick={() => void openAppSettings()}>
            减少这种情况
            <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
          </button>
        </div>
      {/if}
      <!-- ★ `assist-lecture` 那条引导指的是**这一行**（气泡收的词落哪），
           不是下面 LOOKUP 那一行（Lookup 收的词落哪）—— 两行同族不同事，
           而那句话说的是「划词才收得下来」。指错行等于屏上说假话。 -->
      <button class="li hit" data-guide="assist-lecture" onclick={() => (locOpen = !locOpen)}>
        <span class="g">
          <span class="zh s12">默认保存位置</span>
          <small>{locLabel ?? '自动 · Inbox › 来源 App › Saved'}</small>
        </span>
        <span class="tag" class:t-v={locLabel !== null} class:t-m={locLabel === null}>{locLabel ? '指定' : '自动'}</span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
      {#if locOpen}
        <SavePicker onpick={(lid) => void pickLoc(lid)} onauto={() => void autoLoc()} onclose={() => (locOpen = false)} />
      {/if}
      <button class="li hit" onclick={() => go('assist-ai')}>
        <span class="g"><span class="zh s12">AI</span><small>释义的两条 Prompt</small></span>
        <span class="arr"><svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
      </button>
    </div>
  {:else if pg === 'assist-ai'}
    <!-- ══ ASSIST › AI：Prompt ×2 + 连接（AiPanel）══ -->
    <div class="set">
      <button class="li hit" onclick={() => (promptDlg = 'quick')}>
        <span class="g">
          <span class="zh s12">简明释义 Prompt</span>
          <small>{quickPrompt ? quickPrompt.slice(0, 22) + (quickPrompt.length > 22 ? '…' : '') : '默认 · 选中词就用它 · 一行中文'}</small>
        </span>
        <span class="tag" class:t-v={!!quickPrompt} class:t-m={!quickPrompt}>{quickPrompt ? '自定义' : '默认'}</span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
      <button class="li hit" onclick={() => (promptDlg = 'full')}>
        <span class="g">
          <span class="zh s12">完整解释 Prompt</span>
          <small>{aiPrompt ? aiPrompt.slice(0, 22) + (aiPrompt.length > 22 ? '…' : '') : '默认 · 点 AI 才用它 · 释义/用法/例句'}</small>
        </span>
        <span class="tag" class:t-v={!!aiPrompt} class:t-m={!aiPrompt}>{aiPrompt ? '自定义' : '默认'}</span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
    </div>
  {:else if pg === 'connection'}
    <!-- ══ CONNECTION：AI 服务连到哪（2026-09-13 从 ASSIST › AI 搬出来）══
         搬的理由写在 `route.svelte.ts` 的类型注释里：这份配置被四个模块读，
         它是全局的，和 Prompt 只是「同一页」而已。 -->
    <AiPanel />
    <div class="m blk zh">
      这里定的是<b>谁替你想</b> —— 释义、出题、批量解析都走这一份连接。
      改了对<b>全部</b> AI 功能生效，不只是 Assist。
    </div>
  {:else if pg === 'lookup'}
    <!-- ══ LOOKUP：默认保存位置（两模式）══════════════════════
         T-5.9③ · D-R21 已裁 B。这一页只有真的需要他主动决定的东西（D-408①）——
         现在就一行：**在 Lookup 里收下的词，默认去哪。**
         ★ 与 ASSIST 页那一行是**同族但不同事**：那边管气泡收的词，这边管
           Lookup 收的词。所以两行分开摆，不合并成一个「保存位置」总开关。 -->
    <div class="set">
      <button class="li hit" onclick={() => (lkOpen = !lkOpen)}>
        <span class="g">
          <span class="zh s12">默认保存位置</span>
          <!-- ★ 不管哪种模式，这里说的都是**现在真的会落到的那条路径**
               （saveTargetLabel 只解析不建）—— 他该在按下去之前就知道东西会去哪。 -->
          <small>{lkMode === 'follow' ? `跟随 Assist · ${lkLabel ?? '…'}` : (lkLabel ?? '…')}</small>
        </span>
        <span class="tag" class:t-v={lkMode === 'custom'} class:t-m={lkMode === 'follow'}>{lkMode === 'custom' ? '自定' : '跟随'}</span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
      {#if lkOpen}
        <!-- ★ 复用 SavePicker（全应用唯一的「挑一个树上的位置」）；
             只把「不指定」那一档改叫「跟随 Assist」—— 在这一侧它不是「自动」。 -->
        <SavePicker
          title="Lookup 默认保存位置"
          autoLabel="跟随 Assist"
          onpick={(lid) => void pickLkLoc(lid)}
          onauto={() => void followLkLoc()}
          onclose={() => (lkOpen = false)}
        />
      {/if}
      <!-- ★★ `Lookup 的 AI 搜索` 那份提示词搬到这儿了（D-488）。
           它此前在 Prompt 页一个叫「共用提示词」的块里，而**它两条学习线都不属于**
           （不是认读、不是产出）。主控裁：不发明第三类 —— 按它真正服务的功能归位。
           ☞ 判据没变一个字：同一个键、同一份 `OVERRIDABLE_PROMPTS`、
             同一个编辑页（`prompt-edit`），只是入口挪到它管的那一屏上。 -->
      <button class="li hit" onclick={() => void openPrompt('lookup-search')}>
        <span class="g">
          <span class="zh s12">AI 搜索的提示词</span>
          <small class="mono">lookup-search</small>
        </span>
        <span class="m">{promptState['lookup-search']?.edited ? '改过' : '默认'}</span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
      <div class="m blk zh">这一份<b>两端共用</b>：在这里改完，电脑上也跟着变（随同步走）。</div>
    </div>
  {:else if pg === 'prompts'}
    <!-- ══ PROMPTS · 两条学习线各配各的（D-488 · 使用者 2026-09-15）══════
         他给的树是：Prompt ├ 文件学习（体裁 ↔ AI 导师）└ 练习（认读 ↔ 产出）。
         ★★★ **手机上只做后一枝**（主控裁「走甲」）：`体裁` / `AI 导师` 属于
           **文件学习线，而那条线整条不进手机**（D-311，`db/search.ts` 里那句
           「文件学习线整条不进手机」是同一条）。真做出「文件学习 ‖ 练习」这一级，
           「文件学习」那边点进去**什么都没有** —— 而「空层级」正是他这一单点名禁的。
           ☞ 少这一级不是偏离他的树，是这一端**真实的形状**（D-474 共用语义、度量各端）。

         ★★ 为什么改成 Tab 而不是继续一页滚到底：
           `牌面` / `题型` / `出题规则` 这三个段名**两个模式各有一套**（D-486 要的
           「结构对应」，段名不许改）。一页滚到底时**同屏看得见两个「牌面」** ——
           那就是他说的「重复标题」。一次只显示一个模式，重复自然消失。
         ★ 控件用已有的 `.seg`（和 Lookup 顶部那个模式开关同一个，不新造）。 -->
    <!-- ★ `prompt-area`（清单 12）的靶子：这一页的入口就是这两个模式，
         而这句话讲的正是「这儿管 AI 按什么来」。它在这一页恒在。 -->
    <div class="lk-mode" data-guide="prompt-area">
      <div class="seg">
        <button class:sel={pTab === 'reading'} onclick={() => (pTab = 'reading')}>认读</button>
        <button class:sel={pTab === 'practice'} onclick={() => (pTab = 'practice')}>产出</button>
      </div>
    </div>

    <!-- ══════════════════════════════════════════════════════════════
         三层配置 · 两个模式同一张骨架（D-486 · 使用者 2026-09-15「确认单按推荐」）

         使用者六条里的三条在这里落地：
           ① 两个模式视觉语言一致，但**一眼看得出在配哪一个** → `.mode` 模式标识
           ② 牌面 / 题型 / 出题规则**在屏上明显不是同一种东西** →
              牌面 = 小卡预览（看长什么样）· 题型 = 单选行（选做什么）·
              出题规则 = 一行入口 → 弹窗（条件配置）
           ③ 两边**结构对应**：段序都是 牌面 → 题型 → 出题规则，段名两端一致
         ★ 屏上的字（牌面名 / 题型名 / 选项名）全来自 core 的 `*_SAYS` —— 两端一个说法（CR-7）。
    ══════════════════════════════════════════════════════════════ -->

    <!-- ── 认读 Tab ─────────────────────────────────────────
         ★ `.mode` 那条标识**撤了**：顶部的 Tab 已经说清在配哪一个，
           再放一条「认读 READING」就是同一件事说两遍（他这一单点名的「重复标题」
           同族）。段序仍是 牌面 → 题型 → 出题规则，两端一致（D-486）。 -->
    {#if pTab === 'reading'}

    <!-- 牌面（多选）★ 手机上第一次有这个面：core 一直有这条偏好、一直在生效，
         只是这一端从来没给过入口。D-486 之前那格写的是「在电脑上设」。 -->
    <div class="sec">牌面</div>
    <div class="seclead zh">这张卡给你看什么 · 可以多选，出题时轮着来</div>
    <div class="faces">
      {#each facePrefs as f (f.id)}
        {@const def = resolveFace(f)}
        {#if def}
          <!-- ★ `multi`：认读的牌面**可多选**，所以除了描边再给一枚勾角标。
               只靠描边的话多选和单选长得一样，他不点第二张就不知道能多选。
               ★★ 外层是 `div` 不是 `button` —— 自建那几张要多一颗「删掉」，
                 按钮不能套按钮。勾选那一下仍然是整卡可点（内层那颗铺满）。 -->
          <div class="facecard multi" class:on={f.on}>
            <button class="fhit" onclick={() => void toggleFace(f.id)}
              aria-pressed={f.on} aria-label={def.name}>
              <!-- 缩略的真实卡面：三条横线示意题面排布（不是装饰，是「它长这样」） -->
              <span class="fprev"><i style="width:82%"></i><i style="width:60%"></i><i style="width:38%"></i></span>
              <span class="fname">{def.name}</span>
              <span class="fsays">{def.says}</span>
            </button>
            <!-- ★ 只有**自建**的给删除：内置那四面删了也会被 core 补回来
                 （`parseFacePrefs` 缺的按出厂补），给一颗删不掉的键是假话。 -->
            {#if isCustomFaceId(f.id)}
              <button class="fdel" aria-label={`删掉牌面「${def.name}」`}
                onclick={() => (delFace = { id: f.id, name: def.name })}>删掉</button>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
    <!-- ★★ 一面都没勾**是允许的**（那是他取消掉的东西，不许替他勾回来），
         但后果要当场说 —— 否则他只会觉得认读突然变笨了（D-338 让失败全长一个样）。 -->
    {#if !facePrefs.some((f) => f.on)}
      <div class="m blk zh">一面都没勾 —— 认读会退回<b>机械挖空</b>（把原句里那个词挖掉）。</div>
    {/if}

    <!-- 题型（单选）★ D-486 新格：此前认读只有「翻卡自评」一种做法，没得选 -->
    <div class="sec">题型</div>
    <div class="seclead zh">你要做出什么动作才算认出来 · 只能选一种</div>
    <div class="picks">
      {#each Object.keys(READING_QTYPE_SAYS) as k (k)}
        {@const v = k as ReadingQType}
        <button class="pick" class:on={rQType === v} aria-pressed={rQType === v}
          onclick={() => void setQuiz(QUIZ_RULE_KEYS.readingQType, v)}>
          <span class="pdot"></span>
          <span class="g">
            <span class="pname">{READING_QTYPE_SAYS[v].name}</span>
            <span class="psays">{READING_QTYPE_SAYS[v].says}</span>
          </span>
        </button>
      {/each}
    </div>

    <!-- 出题规则（弹窗）★ 第三种形态：它是**条件配置**，不该和上面两层平铺
         （使用者第 4 条原话：出题规则统一改成弹窗）。 -->
    <div class="sec">出题规则</div>
    <div class="seclead zh">系统按什么条件出这道题</div>
    <button class="li hit" onclick={() => (rOpen = true)}>
      <span class="g"><span class="zh s12">认读怎么出题</span>
        <small class="zh">{FACE_PICK_SAYS[qr.facePick]} · 提示{READING_HINT_SAYS[qr.hintLevel]}</small></span>
      <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
    </button>

    {:else}
    <!-- ── 产出 Tab ───────────────────────────────────────── -->

    <!-- 牌面（单选）★ D-486 新格：此前产出没有「呈现」这一层 -->
    <div class="sec">牌面</div>
    <div class="seclead zh">这道题在屏幕上摆成什么样 · 只能选一种</div>
    <div class="faces">
      {#each Object.keys(PRACTICE_FACE_SAYS) as k (k)}
        {@const v = k as PracticeFace}
        <button class="facecard" class:on={pFace === v} aria-pressed={pFace === v}
          onclick={() => void setQuiz(QUIZ_RULE_KEYS.practiceFace, v)}
          aria-label={PRACTICE_FACE_SAYS[v].name}>
          <!-- 三张各画各的排布：整块一栏 · 分栏两列 · 专注只剩一条 -->
          <span class="fprev">
            {#if v === 'plain'}<i style="width:88%"></i><i style="width:70%"></i><i style="width:52%"></i>
            {:else if v === 'split'}<i style="width:42%"></i><i style="width:42%"></i><i style="width:88%"></i>
            {:else}<i style="width:64%"></i>{/if}
          </span>
          <span class="fname">{PRACTICE_FACE_SAYS[v].name}</span>
          <span class="fsays">{PRACTICE_FACE_SAYS[v].says}</span>
        </button>
      {/each}
    </div>

    <!-- 题型 ★ 产出这一格本来就有（12 种），所以它是**进一页**不是三行单选 ——
         数量差一个量级，硬做成同一种控件反而看不清（D-474：共用语义，度量各端）。
         段名与段序仍与认读一致，这是「结构对应」要的那一半。 -->
    <div class="sec">题型</div>
    <div class="seclead zh">你要做什么题 · 可以多选，出题时轮着来</div>
    <button class="li hit" onclick={() => (route.push({ k: 'pg', pg: 'qtypes' }), void loadQTypes())}>
      <span class="g"><span class="zh s12">全部题型</span>
        <small class="zh">启用 / 停用 · 排序 · 新建</small></span>
      <span class="m">{qtypes.length || ''}</span>
      <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
    </button>
    <div class="m blk zh">一种都不勾就不出题 —— 勾了几种，就按你排的顺序轮着来。</div>

    <!-- 出题规则（弹窗）—— 与认读同位、同形态 -->
    <div class="sec">出题规则</div>
    <div class="seclead zh">系统按什么条件生成这批题</div>
    <button class="li hit" onclick={() => (wOpen = true)}>
      <span class="g"><span class="zh s12">产出怎么出题</span>
        <small class="zh">{PRACTICE_HINT_SAYS[qw.hintLevel]} · {CONTEXT_SPREAD_SAYS[qw.contextSpread]}</small></span>
      <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
    </button>

      <!-- ★★ 这两份是**产出练习底下的原始提示词**（`generate-questions` /
           `score-answer`）。D-488 之前它们在页顶一个叫「共用提示词」的块里 ——
           而那两行的名字**本来就叫「产出练习出题 / 判分」**，却摆在产出这一块
           的外面、上面。归属和屏上的字对不上，正是他说的「归类不清」。
           ★ 摆成**从属行**（`sunkli`）压在「出题规则」底下：三段是他配的东西，
             这两份是那三段底下真正发出去的原文 —— 不是第四段，是同一件事更深一层。
           ★ `Lookup 的 AI 搜索` 不在这里：它两条学习线都不属于，
             按主控裁的归去 Settings › Lookup（不发明第三类）。 -->
      {#each OVERRIDABLE_PROMPTS.filter((x) => x.name !== 'lookup-search') as p (p.name)}
        <button class="li hit sunkli" onclick={() => void openPrompt(p.name)}>
          <span class="g">
            <span class="zh s12">{p.says}</span>
            <small class="mono">{p.name}</small>
          </span>
          <span class="m">{promptState[p.name]?.edited ? '改过' : '默认'}</span>
          <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
        </button>
      {/each}
      <div class="m blk zh">这两份<b>两端共用</b>：在这里改完，电脑上也跟着变（随同步走）。</div>
    {/if}

  {:else if pg === 'prompt-edit'}
    <!-- ══ 改一条提示词（三级：内容型，用整页而不是弹窗 —— 它是一大段文本）══ -->
    {#if editingPrompt}
      <div class="sec">{OVERRIDABLE_PROMPTS.find((x) => x.name === editingPrompt)?.says ?? editingPrompt}</div>
      <textarea class="dlg-in ta" rows="18" bind:value={promptText} oninput={() => (promptDirty = true)}></textarea>
      <div class="pillrow">
        <button class="pill v" disabled={!promptDirty} onclick={() => void saveSharedPrompt()}>存</button>
        <button class="pill" onclick={() => void resetPrompt()}>恢复默认</button>
      </div>
      <!-- ★ 说清楚格式，否则改坏了只会在出题时炸 -->
      <div class="m blk zh">
        用 <b>## SYSTEM</b> 和 <b>## USER</b> 分两段；<b>{'{{'}变量{'}}'}</b> 必须原样留着 ——
        少一个，出题时当场报错，不会发半截提示词出去。
      </div>
    {/if}

  {:else if pg === 'qtypes'}
    <!-- ══ 题型管理（三级）══════════════════════════════════ -->
    {#if qtErr}<div class="note" role="status">{qtErr}</div>{/if}
    <!-- ★ D-486：「出题规则」那颗入口**搬到上一层去了**（配置页的产出那一块，
         与认读同位）。这里不再重复一颗 —— 同一件事两个入口，他改完回到上一层
         会以为没生效，而两处都说得通、都不报错。 -->
    <div class="sec">全部题型</div>
    {#each qtypes as q (q.uid)}
      <div class="li">
        <button class="hit" onclick={() => (editQt = { ...q })}>
          <span class="g">
            <span class="zh s12" style={q.enabled ? '' : 'opacity:.45'}>{q.name}</span>
            <!-- ★ 只说不一样的那两件事：改过提示词 · 停用了。都没有就不占一行字
                 （原来这里是 T? 档位标签，D-478 之后档没了）。 -->
            <!-- ★ D-482：「自定提示词」改成说人话的那句 —— 那个编辑框已经收起来了，
                 再用「自定提示词」这种说法他会去找一个不存在的入口。 -->
            <!-- ★★★ I-187：**只对自建题型说**。内置那 10 段正文是生成的（使用者 2026-09-15 答），
                   对着它们说「你以前写的」是假话；而且内置从此根本不读 prompt，
                   这一行等于在报告一件**已经不生效**的事。 -->
            <small>{[q.prompt && !q.builtin ? '自建题型（用它自己的出题要求）' : null, q.enabled ? null : '已停用'].filter(Boolean).join(' · ')}</small>
          </span>
        </button>
        <button class="ibtn sm" aria-label="启用或停用" onclick={() => void qtToggle(q)}>
          <svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href={q.enabled ? '#nyx-core' : '#nyx-core-o'} /></svg>
        </button>
      </div>
    {/each}
    <div class="pillrow">
      <button class="pill v" onclick={() => (editQt = { name: '', brief: '', guide: '', prompt: '', enabled: true })}>新建题型</button>
      <button class="pill" onclick={() => void qtRestore()}>恢复出厂</button>
    </div>
    <div class="m blk zh">恢复出厂<b>只补不删</b>：你自己加的一条都不动，内置那些改回原样。</div>

  {:else if pg === 'dict'}
    <!-- ══ DICTIONARY：默认词典 · 文件夹 · 扫描 · 书目 ══ -->
    <div class="set">
      <div class="li">
        <span class="g"><span class="zh s12">默认词典</span>
          <small class="zh">{dictDefault?.fellBackFrom
            ? `默认的「${dictDefault.fellBackFrom}」用不上 —— 临时用「${dictDefault.book?.bookname ?? '—'}」，设置不动`
            : 'Lookup 里换本 = 设默认 · 跨设备认书不认路径'}</small></span>
        <span class="m">{dictDefault?.book?.bookname ?? '—'}</span>
      </div>
      <button class="li hit" onclick={() => void chooseDictFolder()}>
        <span class="g">
          <span class="zh s12">词典文件夹</span>
          <small>{dictFolder ? folderLabel(dictFolder) : '还没选 —— 把 .mdx 放进一个文件夹，在这里选它'}</small>
        </span>
        <span class="tag" class:t-v={!!dictFolder} class:t-m={!dictFolder}>{dictFolder ? '已选' : '选 ›'}</span>
      </button>
      {#if dictFolder}
        <button class="li hit sunkli" onclick={() => void rescanDicts()}>
          <span class="g"><span class="zh s12">重新扫描</span><small>夹里的 .mdx 变了就点一下</small></span>
          <span class="m">{dictScanning ? '扫描中…' : ''}</span>
          <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
        </button>
      {/if}
      <!-- ★ T-5.16 · 跳过的**说出来**（原来子目录与 config.ini 是被 Java 静默扔掉的）。
           数是 0 就整行不出现（D-431③）；点开是从属行，用已有的 sunkli/p1，不新增样式 -->
      {#if dictFolder && dictSkip.length > 0}
        <button class="li hit sunkli" onclick={() => (skipOpen = !skipOpen)}>
          <span class="g">
            <span class="zh s12">跳过 {dictSkip.length} 项</span>
            <small>不是词典文件 —— 点开看是哪些</small>
          </span>
          <span class="m">{skipOpen ? '收起' : '展开'}</span>
        </button>
        {#if skipOpen}
          {#each dictSkip as sk (sk.dir + sk.name)}
            <div class="li ro sunkli p1">
              <span class="g">
                <span class="zh s12">{sk.dir}{sk.name}</span>
                <small>{sk.why}</small>
              </span>
            </div>
          {/each}
        {/if}
      {/if}
      <!-- ★ I-159 · 退役的行：书目里不再列它们（它们本来就不是词典），
           但「那一行去哪了」要查得到 —— 同一种从属行，数是 0 就不出现（D-431③）。 -->
      {#if dictRetired.length > 0}
        <button class="li hit sunkli" onclick={() => (retiredOpen = !retiredOpen)}>
          <span class="g">
            <span class="zh s12">退役 {dictRetired.length} 项</span>
            <small>本来就不是词典 —— 点开看是哪些</small>
          </span>
          <span class="m">{retiredOpen ? '收起' : '展开'}</span>
        </button>
        {#if retiredOpen}
          {#each dictRetired as b (b.id)}
            <div class="li ro sunkli p1">
              <span class="g">
                <span class="zh s12">{b.bookname}</span>
                <small>{b.diagnostic ?? '文件名不像词典'}</small>
              </span>
            </div>
          {/each}
        {/if}
      {/if}
      {#if dictBooks.length > 1}
        <div class="li" style:min-height="34px">
          <span class="g"><small class="zh">按住一本拖 = 排序 —— 查词按这个先后逐本命中</small></span>
        </div>
      {/if}
      {#each dictBooks as b (b.id)}
        <button
          class="li hit sunkli {dcls(b.id)}"
          use:dragRow={{ group: 'dict', id: b.id, siblings: () => dictBooks.map((x) => x.id) }}
          onclick={() =>
            b.status === 'error'
              ? (note = `「${b.bookname}」读不了：${b.diagnostic ?? '原因不明'}`)
              : void toggleBook(b)}
        >
          <span class="g">
            <span class="zh s12" class:dim={b.missing || b.status === 'error'}>{b.bookname}</span>
            <small>{b.missing ? '不在夹里了 —— 重新扫描或放回去' : b.status === 'error' ? '读不了 · 点看原因' : `${b.wordCount} 词`}</small>
          </span>
          {#if b.missing}<span class="tag t-w">失踪</span>
          {:else if b.status === 'error'}<span class="tag t-w">坏</span>
          {:else}<Toggle on={b.enabled} label="{b.bookname} 启用" onchange={() => void toggleBook(b)} />{/if}
        </button>
      {/each}
    </div>
  {:else if pg === 'speech'}
    <!-- ══ SPEECH：口音 · 语速 · 试听（TtsPanel 精简版）══ -->
    <div class="set"><TtsPanel /></div>
  {:else if pg === 'data'}
    <!-- ══ DATA：同步 + 数据安全通知 ══ -->
    <div class="set">
      <SyncPanel />
      <NotifyRow />
    </div>
  {:else if pg === 'kit'}
    <!-- ══ 样式一览（连点构建指纹五下）—— 不是产品功能 ══ -->
    <Kit />
  {:else if pg === 'about'}
    <!-- ══ ABOUT：构建指纹 + 隐私一句 ══ -->
    <div class="set">
      <!-- ★ 只读行：机器的事实，按下去没有反应（§10.2c） -->
      <!-- ★ 连点五下进样式一览（F-005 · 2026-09-01）。
           为什么藏起来：它不是产品功能，是改令牌之后的对照表；
           露在 ABOUT 上会让使用者以为那是个设置。
           为什么还是只读行的样子：它**就是**只读行 —— 连点是彩蛋，
           不是这一行承诺的动作（§10.2c：行长什么样说的是它承诺什么）。 -->
      <div
        class="li ro kv"
        role="presentation"
        onclick={() => {
          if (++kitTaps >= 5) {
            kitTaps = 0
            go('kit')
          }
        }}
      >
        <span class="g"><span class="zh s12">构建</span>
          <small class="zh">我改的那份 = 你跑的那份</small></span>
        <span class="m">{__NYX_BUILD__}</span>
      </div>
      <!-- ★ 这份 build 用的是哪一个 core（T-1.3 · 2026-09-04）：submodule 锁定的 SHA · schema 版本 · 同步表面指纹。
           它回答「手机跑的判据是哪一版」—— 和上一行一样是机器的事实，只读（§10.2c）。 -->
      <div class="li ro kv" role="presentation">
        <span class="g"><span class="zh s12">core</span>
          <small class="zh">手机跑的判据是哪一版（submodule 锁定）</small></span>
        <span class="m">{__NYX_CORE__}</span>
      </div>
      <!-- ★ 再看一次新手引导（SC-25 · D-483）—— **是动作，不是设置**：
           点了立刻打开引导，没有开关、没有状态。所以是动作行（§10.2c）而不是只读行。
           为什么在 ABOUT：它不属于任何一区功能，是「这软件是什么」那一类的东西
           （Windows 那边没有 ABOUT，落在 Data 页 —— 两端各按自己的页放，D-474）。 -->
      <button
        class="li hit"
        onclick={() => {
          if (store.db.k !== 'ok') return
          void onboard.again(store.db.db)
        }}
      >
        <span class="g"><span class="zh s12">再看一次新手引导</span>
          <small class="zh">第一次进来那四屏</small></span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
      <!-- ★ 第二层那一套单独一行：它和第一层是两件事（一个讲「Nyx 是什么」，
           一个讲「这一页这个东西怎么用」），合成一行的话点下去清掉哪一套说不清。 -->
      <button
        class="li hit"
        onclick={() => {
          if (store.db.k !== 'ok') return
          const db = store.db.db
          void (async () => {
            await clearGuideSeen(db)
            guide.forget()
            snacks.show('页面引导都打开了 —— 走到那几处会再说一次')
          })()
        }}
      >
        <span class="g"><span class="zh s12">把页面引导重新打开</span>
          <small class="zh">走到某个功能时冒出来的那种说明</small></span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
      <div class="li ro" style:border-bottom="none">
        <span class="g"><span class="zh s12">隐私</span>
          <small class="zh">不在后台常驻、不在后台读屏 —— 只看你明确交给它的文字；API key 存在本机 Keystore，永不上云；数据只进你自己的云端。</small></span>
      </div>
    </div>

  {:else if pg === 'resources'}
    <!-- ══ RESOURCES · 枢纽（2026-09-13）══════════════════════════
         使用者交办配色时说的位置是「Settings → Resources → Colors」——
         Colors 在 Resources **下面**，那 Resources 就得是个能往下走的层。
         于是原来直接摆在这一页的启动页内容搬进 `resources-splash`。 -->
    <div class="set">
      <button class="li hit" onclick={() => go('resources-splash')}>
        <span class="g"><span class="zh s12">启动页</span><small class="zh">这台手机用哪一张</small></span>
        <span class="arr"><svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
      </button>
      <button class="li hit" onclick={() => go('colors')}>
        <span class="g"><span class="zh s12">配色</span><small class="zh">一个模式 = 一整套颜色</small></span>
        <span class="tag" class:t-v={colorActive !== DEFAULT_MODE_ID} class:t-m={colorActive === DEFAULT_MODE_ID}>
          {colorActive === DEFAULT_MODE_ID ? DEFAULT_MODE_NAME : (colorModes.find((m) => m.id === colorActive)?.name ?? DEFAULT_MODE_NAME)}
        </span>
        <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
      </button>
    </div>
    <div class="m blk zh">
      这两项都<b>不跟着同步走</b> —— 电脑和手机各用各的。
    </div>

  {:else if pg === 'colors'}
    <!-- ══ RESOURCES › COLORS（使用者 2026-09-13 交办）════════════
         一个模式 = 一整套颜色；点不同模式像 Tab 切换；每个模式下有「应用」。
         ★ 「出厂配色」不是一条记录，是**一条覆盖都没有**那个状态 ——
           所以它永远在、永远等于这一版包里的出厂色，清了数据也回得去。
           它是只读的：要改就以它为底新建一个（下面那颗「＋ 以这套为底新建」）。 -->
    <div class="cmodes">
      <button class="cmode" class:on={colorSel === DEFAULT_MODE_ID} onclick={() => (colorSel = DEFAULT_MODE_ID)}>
        <span class="zh">{DEFAULT_MODE_NAME}</span>
        {#if colorActive === DEFAULT_MODE_ID}<span class="cdot"></span>{/if}
      </button>
      {#each colorModes as m (m.id)}
        <button class="cmode" class:on={colorSel === m.id} onclick={() => (colorSel = m.id)}>
          <span class="zh">{m.name}</span>
          {#if colorActive === m.id}<span class="cdot"></span>{/if}
        </button>
      {/each}
      <button class="cmode add" onclick={() => void newColorMode()}><span class="zh">＋ 新建</span></button>
    </div>

    <!-- 这一档的名字 + 动作行。★ 圆点 = 在用；「应用」= 把它打到屏上 -->
    <div class="splashnow">
      <div class="splashname zh">{selName}</div>
      <div class="splashrow">
        {#if colorActive === colorSel}
          <span class="tag t-v">使用中</span>
        {:else}
          <button class="btn sm" onclick={() => void applyColorMode(colorSel)}><span class="zh">应用</span></button>
        {/if}
        {#if colorSel !== DEFAULT_MODE_ID}
          <button class="pill" onclick={() => (renameColor = { id: colorSel, now: selName })}><span class="zh">改名</span></button>
          <button class="pill w" onclick={() => void deleteColorMode(colorSel)}><span class="zh">删掉</span></button>
        {/if}
      </div>
    </div>

    {#if colorSel === DEFAULT_MODE_ID}
      <div class="m blk zh">
        出厂配色<b>不能改</b> —— 它是「重置」时回得去的那个底。
        想改就以它为底新建一个：上面那颗<b>＋ 新建</b>。
      </div>
    {/if}

    <!-- 分组：一组一折。★ 一次只展开一组 —— 66 个部件全摊开没人读得下去 -->
    {#each COLOR_GROUPS as g (g.zh)}
      {@const open = colorGrp === g.zh}
      <div class="set">
        <button class="li hit" onclick={() => (colorGrp = open ? null : g.zh)}>
          <span class="g"><span class="zh s12">{g.zh}</span>{#if g.hint}<small class="zh">{g.hint}</small>{/if}</span>
          <span class="cprev">
            {#each g.parts.slice(0, 5) as [t] (t)}
              <span class="csw" style:background={colorNow(t, selOverrides)}></span>
            {/each}
          </span>
          <svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--mute)"><use href="#nyx-caret" /></svg>
        </button>
        {#if open}
          {#each g.parts as [t, zh] (t)}
            {@const mine = selOverrides[t] !== undefined}
            <!-- ★★ **整行**可点（2026-09-13）。原来只有那个 30×30 的小方块能点 ——
                 远低于这仓自己定的 44 触摸线，使用者报「点击进去我自己不能改配色」
                 多半就是没点中它。「还原」也挪进拾色器里了：行里嵌按钮既不合法
                 也让可点区更碎。 -->
            <button
              class="li cpart hit"
              disabled={colorSel === DEFAULT_MODE_ID}
              onclick={() => (picking = { token: t, zh })}
            >
              <span class="g"><span class="zh s12">{zh}</span><small>{t}</small></span>
              {#if mine}<span class="tag t-v">改过</span>{/if}
              <span class="csw big" style:background={colorNow(t, selOverrides)}></span>
            </button>
          {/each}
        {/if}
      </div>
    {/each}

    <div class="splashnow">
      <button class="btn sm sec2" onclick={() => void applyColorMode(DEFAULT_MODE_ID)}>
        <span class="zh">重置为默认</span>
      </button>
    </div>
    <div class="m blk zh">
      「重置为默认」= 换回<b>出厂配色</b>那一档，<b>不会删掉你建的模式</b>。
    </div>
    <div class="m blk zh">
      ★ 出厂那套的对比度是量过的（正文压页面底 AA 4.5 以上）。
      <b>你改了之后这个保证就不成立了</b> —— 我不会拦着你，但得先说。
    </div>

  {:else if pg === 'resources-splash'}
    <!-- ══ RESOURCES · 启动页（使用者 2026-09-09 交办）══════════════
         ★ 预览按**真启动页**的比例摆：素色底 · 中间一块画面 ·
           没有字、没有标语、没有水光（U-007 / DS §12.0b）。
           预览比真页面好看等于在骗他，所以这里一个字都不往画面里加。 -->
    <div class="sec">启动页<span class="zh">这台手机用哪一张</span></div>

    <div class="splashdeck" onscroll={onDeckScroll}>
      {#each SPLASH_CANDS as cand (cand.id)}
        {@const isNow = splashShownNowId === cand.id}
        <div class="splashslide">
          <!-- ★ 预览画的是**启动时眼睛看到什么**，不是「应用内画不画」。
               2026-09-09 使用者问「为什么系统默认预览图上面没有标志的小熊，
               而是一篇空白」—— 我当时按后者画了一块空底，那是错的：
               那一档启动时看到的就是水獭。预览和真页面不一样就是在骗他。
               ★ 两档各走各的一组数：
                 图标 → 画布 80%（= 288px 压在 360dp 屏上），正中不上移
                 插画 → 高 ≤60% · 宽 ≤88% · 上移 3%
               **都没有字**（U-007）。 -->
          <div class="splashprev" class:on={isNow}>
            {#if cand.c.kind === 'icon'}
              <img class="splashic" src={SPLASH_ICON} alt="" />
            {:else if cand.c.kind === 'user'}
              <!-- 同步下来的那一张。地址拿不到（文件刚删 / 目录读不了）就空着 —— 不拼假地址 -->
              {#if cand.url}<img class="splashart" src={cand.url} alt="" />{/if}
            {:else if SPLASH_ART}
              <img class="splashart" src={SPLASH_ART} alt="" />
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- 滑到第几张：一个点一张。★ 它只说「位置」，不说「在用哪张」——
         那两件事分开说，否则一个记号要表达两个意思，两个都读不准。 -->
    <div class="splashdots">
      {#each SPLASH_CANDS as cand, i (cand.id)}
        <span class="splashdot" class:on={slide === i}></span>
      {/each}
    </div>

    <!-- 名字 + 这一张是不是在用的那一张 + 启用 / 改名（都居中在图下方） -->
    {#if splashCand}
      {@const cand = splashCand}
      <div class="splashnow">
        <div class="splashname zh">{splashLabel(cand)}</div>
        <div class="splashrow">
          {#if splashShownNowId === cand.id}
            <span class="tag t-v">使用中</span>
          {:else}
            <button class="btn sm" onclick={() => void pickSplash(cand)}>
              <span class="zh">启用</span>
            </button>
          {/if}
          <!-- ★ 内置那一档没有改名键 —— **不出现**，不是置灰：
               点不动的键占着位置只会让人反复试（使用者 2026-09-09：
               「除了系统默认不能改，其他都可以改」）。 -->
          {#if !cand.fixed}
            <button class="pill" onclick={() => openRename(cand)}>
              <span class="zh">改名</span>
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <div class="m blk zh">
      这台手机在用：<b>{splashLabel(SPLASH_CANDS.find((x) => x.id === splashShownNowId) ?? SPLASH_BUILTIN[1]!)}</b>。
    </div>
    <!--
      ══ 他选的那张已经不在了 ★★（B-2 · 2026-09-14 改成单独一行）══════════
      ★ **两句，缺一不可**：
        ① 发生了什么 —— 不说的话他只会觉得启动页莫名其妙换了（D-412）
        ② **他不用重新挑** —— 库里那条选择是故意留着的，不说出来他会以为得重挑一次，
           那正好把「留着它」的全部价值抵消掉
      ★ **单独一行**，不塞进上面那句（两端同一个做法，Windows `SplashRes.svelte::splgone`）：
        上面那句回答「现在是哪一张」，这句回答「为什么不是你选的那张」——
        两个问题挤一行，两个都答不清。
      ★ **不上警告色**：这不是出错。他在另一台机器上删了一张图，这台照办而已，
        用和旁边说明同一档的说明文字（`.m`）。
    -->
    {#if splashShownNowId !== splashNowId}
      <div class="m blk zh">
        <b>你之前选的那张已经不在了</b>（在别的设备上删掉了，这台跟着删）——
        它要是被加回来，这台手机会自动用回它，<b>不用重新挑</b>。
      </div>
    {/if}
    <div class="m blk zh">
      <b>选了哪一张</b>不跟着同步走 —— 电脑和手机可以各用各的启动页。<b>名字会同步</b>：两边都能改，以最后改的那次为准。
    </div>
    <div class="m blk zh">
      启动<b>只出现一张图</b>（2026-09-09 改）—— 就是上面选中的那张。
      在这之前是两张：系统先画一张图标，应用里再画一张插画。现在系统那一帧只剩一块底色，
      图标挪进来当了第一张候选。
    </div>
    <div class="m blk zh">
      <b>图片从电脑那边同步过来</b>（使用者 2026-09-13 定的唯一入口）——
      在电脑上放进去，手机同步完这里就会多出一张。
      手机上<b>没有</b>从相册选图这个入口。
    </div>
    <div class="m blk zh">
      要删一张图，<b>在电脑上删</b> —— 这里会跟着消失（使用者 2026-09-14 裁「连云端一起删」）。
      手机上不另给一颗删除按钮：图从电脑同步进来，删也在同一处，你不用记哪个动作在哪边。
    </div>
  {/if}
</div>

{#if picking}
  {@const pk = picking}
  <ColorPicker
    token={pk.token}
    zh={pk.zh}
    value={colorNow(pk.token, selOverrides)}
    shipped={shippedColors()[pk.token] ?? '#000000'}
    bg={colorNow('color-bg', selOverrides)}
    ink={colorNow('color-text', selOverrides)}
    onclose={() => (picking = null)}
    onpick={(picked) => {
      /* ★★ 先写再关（2026-09-13 排过的 bug）：`picking = null` 会销毁
         上面那个 if 块，写在它后面等于跑在已经销毁的作用域里 ——
         弹窗开得出来、滑杆拖得动、点「存」也关了，**就是不写**。
         tests/color-picker-order.test.ts 钉着这个顺序。 */
      void setPartColor(pk.token, picked)
      picking = null
    }}
    onclear={() => {
      void clearPartColor(pk.token)
      picking = null
    }}
  />
{/if}

{#if renameColor}
  {@const r = renameColor}
  <Dialog
    title="给这套配色起个名字（最多 16 个字）"
    input={r.now}
    confirm="存"
    onclose={() => (renameColor = null)}
    onconfirm={(v) => void doRenameColor(v)}
  />
{/if}

<!-- ══ 改名（使用者 2026-09-09）—— 同一个 Dialog 原语，不另造弹窗（DS §10.8）══
     ★ allowEmpty：清空 = 恢复出厂名。这句话写在标题里，别让人试出来。 -->
{#if renaming}
  {@const r = renaming}
  <Dialog
    title={`给「${r.def}」起个名字（清空就恢复原名，最多 ${MAX_LABEL} 个字）`}
    input={r.now === r.def ? '' : r.now}
    placeholder={r.def}
    confirm="存"
    allowEmpty
    onclose={() => (renaming = null)}
    onconfirm={(v) => void doRename(v)}
  />
{/if}

{#if promptDlg}
  {@const quick = promptDlg === 'quick'}
  {@const def = quick ? DEFAULT_QUICK_PROMPT : DEFAULT_AI_PROMPT}
  <Dialog
    title={quick ? '简明释义 Prompt（选中词就用它）' : '完整解释 Prompt（点 AI 才用它）'}
    input={(quick ? quickPrompt : aiPrompt) || def}
    multiline
    allowEmpty
    confirm="存"
    onclose={() => (promptDlg = null)}
    onconfirm={(v) => void savePrompt(v === def ? '' : v)}
  />
{/if}

<!-- ══ 认读出题规则（D-482 三个选项）· D-486 起改成弹窗 ══════════
     ★ 原来这三段是**平铺**在配置页上的。D-486 之后三层要在屏上分得出来 ——
       出题规则是「条件配置」那一档，统一收进弹窗（使用者第 4 条原话）。
     ★ 没有「存」：点一下就写库并回读（`setQuiz`），每一格都是独立一项。 -->
<!-- ★ 删自建牌面：D-412「删除给确认，文案说真话」——
     说清它会跟着同步走（电脑上也会少一张），不说他会以为只删了手机上这一份。 -->
{#if delFace}
  {@const d = delFace}
  <Dialog
    title={`删掉牌面「${d.name}」？`}
    confirm="删掉"
    danger
    onclose={() => (delFace = null)}
    onconfirm={() => void removeFace(d.id)}
  >
    {#snippet children()}
      <div class="m blk zh">
        这是你自己建的牌面。删掉之后<b>电脑上也会少一张</b>（跟着同步走），
        以前用它出过的卡不受影响。
      </div>
    {/snippet}
  </Dialog>
{/if}

{#if rOpen}
  <!-- ★★ `single`：这个弹窗**只有一个出路**。每点一格就已经写库了（`setQuiz`），
       所以「取消」是一句假话 —— 它什么也取消不了，而他会以为点它能反悔。
       TM-58：只有一个出路的对话框只给一颗 Ghost「关闭」。
       ☞ 真机第一张弹窗截图上并排出现「取消 / 好」才看见这件事。 -->
  <Dialog title="认读怎么出题" confirm="关闭" single onclose={() => (rOpen = false)} onconfirm={() => (rOpen = false)}>
    {#snippet children()}
      <div class="qrow">
        <span class="qlab zh">挑哪种考法</span>
        <div class="seg">
          {#each Object.keys(FACE_PICK_SAYS) as k (k)}
            <button class:sel={qr.facePick === k}
              onclick={() => void setQuiz(QUIZ_RULE_KEYS.facePick, k)}
            >{FACE_PICK_SAYS[k as FacePick]}</button>
          {/each}
        </div>
      </div>
      <div class="qrow">
        <span class="qlab zh">题面给多少提示</span>
        <div class="seg">
          {#each Object.keys(READING_HINT_SAYS) as k (k)}
            <button class:sel={qr.hintLevel === k}
              onclick={() => void setQuiz(QUIZ_RULE_KEYS.readingHint, k)}
            >{READING_HINT_SAYS[k as ReadingHint]}</button>
          {/each}
        </div>
      </div>
      <!-- ★ R-3 只在勾了「场景补全」时有意义：变灰 + 说清为什么，**不隐藏**。
           ★★ D-486 起牌面勾选面**就在这一页上**了，所以这句话不再说「在电脑上勾」——
              说错入口和不说一样糟（BOTH_OFF_SAYS 那条教训的反面）。 -->
      <div class="qrow" class:off={!scenarioOn}>
        <span class="qlab zh">编场景时换个场合</span>
        {#if !scenarioOn}<span class="qwhy zh">上一层勾中「场景补全」这张牌面之后可用</span>{/if}
        <div class="seg">
          <button class:sel={!qr.shiftContext} onclick={() => void setQuiz(QUIZ_RULE_KEYS.shiftContext, '0')}>不换</button>
          <button class:sel={qr.shiftContext} onclick={() => void setQuiz(QUIZ_RULE_KEYS.shiftContext, '1')}>换一个</button>
        </div>
      </div>
      <!-- ★ 老数据认账：他以前写过正文才出现。只读 —— 它已经不参与出题了 -->
      {#if legacyRules}
        <div class="m blk zh">
          你以前写的出题规则已经{SILENCE_ACTIONS.shelve}了，在这儿可以看到。<span class="zh">现在出题按上面三个选项来。</span>
        </div>
        <textarea class="dlg-in ta" rows="6" readonly value={legacyRules}></textarea>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<!-- ══ 写作层四个选项（D-482）—— 与 Windows 同位、同键、同出厂 ══════
     ★ 屏上的字（选项名）全来自 core 的 `*_SAYS`：两端一个说法（CR-7）。
     ★ 没有「存」：点一下就写库并回读（`setQuiz`），因为每一格都是独立的一项 ——
       攒一批再存反而要回答「没点存就退出算不算数」。 -->
{#if wOpen}
  <!-- ★ 同上：点一下就存，只给一颗「关闭」 -->
  <Dialog title="产出怎么出题" confirm="关闭" single onclose={() => (wOpen = false)} onconfirm={() => (wOpen = false)}>
    {#snippet children()}
      <div class="qrow">
        <span class="qlab zh">题目里给他多少材料</span>
        <div class="seg">
          {#each Object.keys(PRACTICE_HINT_SAYS) as k (k)}
            <button
              class:sel={qw.hintLevel === k}
              onclick={() => void setQuiz(QUIZ_RULE_KEYS.practiceHint, k)}
            >{PRACTICE_HINT_SAYS[k as PracticeHint]}</button>
          {/each}
        </div>
      </div>
      <div class="qrow">
        <span class="qlab zh">语境离原文多远</span>
        <div class="seg">
          {#each Object.keys(CONTEXT_SPREAD_SAYS) as k (k)}
            <button
              class:sel={qw.contextSpread === k}
              onclick={() => void setQuiz(QUIZ_RULE_KEYS.contextSpread, k)}
            >{CONTEXT_SPREAD_SAYS[k as ContextSpread]}</button>
          {/each}
        </div>
      </div>
      <div class="qrow">
        <span class="qlab zh">要求写完整句</span>
        <div class="seg">
          <button class:sel={!qw.requireFullSentence} onclick={() => void setQuiz(QUIZ_RULE_KEYS.requireFullSentence, '0')}>不要求</button>
          <button class:sel={qw.requireFullSentence} onclick={() => void setQuiz(QUIZ_RULE_KEYS.requireFullSentence, '1')}>要求</button>
        </div>
      </div>
      <div class="qrow">
        <span class="qlab zh">贴着原文的语气</span>
        <div class="seg">
          <button class:sel={!qw.matchRegister} onclick={() => void setQuiz(QUIZ_RULE_KEYS.matchRegister, '0')}>不要求</button>
          <button class:sel={qw.matchRegister} onclick={() => void setQuiz(QUIZ_RULE_KEYS.matchRegister, '1')}>要求</button>
        </div>
      </div>
      <!-- ★ 说真话：这两条对某些题型本来就不拼（core 判），界面不做特例但要说一句，
           否则他会以为「要求写完整句」连成段题也管（D-412）。 -->
      <div class="m blk zh">
        本来就要写成段的题型不加「完整句」这条；「语域转换」不加「贴着原文语气」那条。
      </div>
    {/snippet}
  </Dialog>
{/if}

<!-- ══ 题型编辑（⑤）—— 用统一 Dialog 原语，不另造弹窗（DS §10.8）══
     ★ children 插槽放那几个字段；Dialog 自己那个 input 用来收「名字」。 -->
{#if editQt}
  {@const q = editQt}
  <Dialog
    title={q.uid ? '改题型' : '新建题型'}
    input={q.name}
    placeholder="题型名字"
    confirm="存"
    onclose={() => (editQt = null)}
    onconfirm={(v) => {
      const cur = editQt
      if (!cur) return
      cur.name = v
      void qtSave()
    }}
  >
    {#snippet children()}
      <!-- ★ 2026-09-08 · D-478 使用者裁「取消档位机制」：这里原来有五颗 T1–T5，
           把每个题型钉在一个难度档上，出题按档走。档没了 —— 题型只按他排的顺序轮，
           一次出几道由他在电脑那边的设置里定（`param.questionsPerItem`，靠同步过来）。
           `qtypes.tier` 列按 D-216 留着不读，所以这里连读都不读了。 -->
      <!-- ★ D-482：`guide` **内置题型只读、自建的仍可编**（主控裁，两端同规则）——
           没有它自建题型就不成立（那是它唯一的形状）；内置那 12 种的说明是判据的一部分。 -->
      <div class="m blk zh">
        这一题让他干什么{q.builtin ? '（内置题型，只能看）' : '（整段进提示词，空着 AI 只能瞎猜）'}
      </div>
      <textarea class="dlg-in ta" rows="3" readonly={q.builtin} bind:value={q.guide}></textarea>
      <!-- ★ 「自己写一段提示词」这个**输入方式**退役了（D-482）：编辑框收起，
           列不删、他写过的原样留着照旧生效（D-216）。点「改回默认」才清空。 -->
      <!-- ★★★ I-187：这句话与「改回默认」**只给自建题型**。对内置说「你以前写的」
             是一句假话，而且是**他会照着做决定**的那种（以为是自己的东西，不敢动）。 -->
      {#if q.prompt && !q.builtin}
        <div class="m blk zh">自建题型（用它自己的出题要求）—— 出题时照旧按它来。</div>
        <div class="pillrow">
          <button class="pill" onclick={() => (q.prompt = '')}>改回默认</button>
        </div>
      {/if}
      {#if q.uid}
        <div class="pillrow">
          <button class="pill w" onclick={() => void qtDelete()}>删掉这个题型</button>
        </div>
      {/if}
    {/snippet}
  </Dialog>
{/if}
