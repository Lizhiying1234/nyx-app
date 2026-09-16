<script lang="ts">
  import Splash from './Splash.svelte'
  import { SILENCE_ACTIONS, SILENCE_FILTER_NAME, silenceScopeAction } from '@core/silence.ts'
import Onboarding from './Onboarding.svelte'
  import PageGuide from './PageGuide.svelte'
  /** D-484 · 第二层引导的总闸（出不出 · 记看过 · 与第一层互斥）全在这儿 */
  import { activeGuide, askGuide, closeGuide, dropGuide } from './guide.svelte.ts'
import { ONBOARDING_KEY, shouldOnboard } from '@core/onboarding.ts'
  import { TRASH_KEEP_TEXT } from '@core/sql/trash.ts'
  import Skel from './Skel.svelte'
  import Dialog from './Dialog.svelte'
  import { sayUndo } from './toast.svelte.ts'
  import Toast from './Toast.svelte'
  import { cleanMessage, type PracticeScope, type TreeProject } from '@shared/api.ts'
  import Workbench from './Workbench.svelte'
  import Report from './Report.svelte'
  import Settings from './Settings.svelte'
  import Reading from './Reading.svelte'
  import Practice from './Practice.svelte'
  import Home from './Home.svelte'
  import HardZone from './HardZone.svelte'
  import ItemDetail from './ItemDetail.svelte'
  import Library from './Library.svelte'
  import FileStudy from './FileStudy.svelte'
  import Search from './Search.svelte'
  import Trash from './Trash.svelte'
  import Capture from './Capture.svelte'
  import { clearErrors, dismissError, onErrors, reportError, type AppError } from './errors.ts'
  import Sprite from './Sprite.svelte'
  import Ic from './Ic.svelte'
  import { handleEsc, registerEsc } from './esc-stack.svelte.ts'

  type Nav =
    | { k: 'home' }
    | { k: 'lecture'; id: number }
    | { k: 'item'; id: number }
    | { k: 'hard' }
    /**
     * ★ D-477 / NAV-02（SC-06 · 2026-09-09）· `sel` 是**选中的那一条**，不是「去了别处」。
     *
     * 它住在 nav 里而不是 Library 组件里，因为两件事要它：
     *   ① 右栏由外壳渲染（详情要用到外壳才有的东西：练习浮层 · 去设置）；
     *   ② 换库（三个预设之间跳）要**自动清掉**它 —— 那是 `enter()` 造一个新 nav 的副作用，
     *      不用额外写一行。
     * ★ **不压栈**：选一条是「在这一页里换看的对象」，不是下钻一层。
     *   压了栈的话，看完三条要按三次返回才回得到列表 —— 那正是 D-477 要改掉的。
     */
    | { k: 'lib'; scope: 'all' | 'upload' | 'silent'; sel?: number }
    | { k: 'files' }
    | { k: 'trash' }
    /**
     * ★ D-469（2026-09-07）· `project` / `unit` 两档没了：使用者取消了项目主页与单元主页。
     *   侧边栏点它们只做展开 / 收起，**讲次是唯一的内容页**。
     *   于是「返回 · 来处」（D-451）能出现的来处也少了两种。
     */
    | { k: 'settings' }
    /** 分析报告独立页 · T-4.11（D-R29：D-441「UI 现在不动」的单项例外，使用者 2026-09-07 原话） */
    | { k: 'report' }
  type Tree = { k: 'loading' } | { k: 'error'; message: string } | { k: 'ok'; data: TreeProject[] }

  let tree = $state<Tree>({ k: 'loading' })
  let nav = $state<Nav>({ k: 'home' })

  /**
   * ★ T-4.9（D-R19）· 侧边栏的两个项目区 —— **同一棵树按 `pinned` 分开，排序不动。**
   *
   * 后端已经按 `pinned desc, name` 给了顺序（`browse.tree()`），这里只做拆分：
   * 拆分不排序，否则「谁在前面」就有了两个说法，而其中一个迟早会漂。
   *
   * 置顶这件事本来就有：`projects.pinned` 列 · ⋮ 菜单的「置顶」· 行上的 📌。
   * T-4.9 只是给它们一块地方，**没有新造任何入口**。
   */
  const projects = $derived(tree.k === 'ok' ? tree.data : [])
  const pinnedProjects = $derived(projects.filter((p) => p.pinned))
  const plainProjects = $derived(projects.filter((p) => !p.pinned))

  /**
   * ★★★ 来路栈 · D-440（2026-09-02）
   *
   * 在这之前 Windows **没有导航栈**：`Nav` 是 11 档扁平联合，
   * 只有 `item` 那一档自己带了个 `from`，其余每个「返回」各写各的 ——
   * 于是 lecture 页的返回写死回首页、从搜索点进的词条 `from` 写死 `{k:'home'}`。
   * 表现就是他报的两句：「点返回直接回主界面」「详情返回丢了刚才的搜索」。
   *
   * 现在只有一套判据，**和 Android 的 `route.svelte.ts` 同一条规则**（两条轴）：
   *   横轴 · 侧边栏一级入口（首页/攻坚/馆藏/文件/设置/回收站）= 换入口 → **清栈**
   *          「侧边栏不是返回按钮」
   *   纵轴 · 页面内部下钻（项目→单元→讲次→词条、搜索→词条）= **push**
   *   返回 · 永远只退一层，回**真正的来源页**（栈空才回首页）
   *
   * ★ 帧上带 `search`：搜索是浮层，从搜索结果点进词条时它会被卸载 ——
   *   返回时要把**那次搜索**原样端回来，而不是回到一个空搜索框。
   */
  type Frame = { nav: Nav; search?: string }
  let backStack = $state<Frame[]>([])
  /** 搜索词住在壳里（见 Search.svelte 的 `q` 注释）—— 浮层关掉再开仍是刚才那次 */
  let searchQ = $state('')

  /** 纵轴 · 下钻一层 */
  function go(n: Nav): void {
    backStack = [...backStack, { nav, search: searching ? searchQ : undefined }]
    searching = false
    railOpen = false /* 窄档铺开的侧栏：走到新位置就收回，不留在那儿挡着内容 */
    nav = n
  }

  /**
   * ★ D-477 · Vault 里选中一条 —— **不压栈**（NAV-02）。
   *   再点一条就是换对象；关掉就是 `sel` 消失。返回栈一根都不长。
   */
  function selectItem(id: number): void {
    if (nav.k !== 'lib') return
    nav = { ...nav, sel: id }
  }
  function closeItem(): void {
    if (nav.k !== 'lib' || nav.sel === undefined) return
    nav = { k: 'lib', scope: nav.scope }
  }

  /** 横轴 · 一级入口。清栈 —— 同 Android `route.goTab` */
  function enter(n: Nav): void {
    backStack = []
    searching = false
    railOpen = false
    nav = n
  }

  /**
   * I-062 · 右键「收进本 lecture」的目标讲次。
   * 正看着讲次就是它；正看着词条就看**来路**那一层（原来读的是 `item.from`，
   * 现在来路统一住在栈里 —— 语义一个字没变）。
   */
  const navLecture = $derived.by((): number | null => {
    if (nav.k === 'lecture') return nav.id
    if (nav.k === 'item') {
      const f = backStack.at(-1)?.nav
      if (f?.k === 'lecture') return f.id
    }
    return null
  })

  /** 返回 · 退一层，连同那一层当时开着的搜索浮层 */
  function goBack(): void {
    const f = backStack.at(-1)
    backStack = backStack.slice(0, -1)
    nav = f?.nav ?? { k: 'home' }
    if (f?.search) {
      searchQ = f.search
      searching = true
    }
  }

  /**
   * ★★★ P-1 · 全局返回手势（2026-09-02 · WINDOWS_INVENTORY.md §四）
   *
   * 「栈是对的，出口没修」——`backStack` 里确实压了一层，
   * 但压栈能进的 5 种页面（讲次/词条/项目/单元/文件学习）里，
   * 只有讲次和词条屏上有返回入口，其余 3 种用户没有办法弹栈，
   * 只能点侧边栏（那会 `enter()` 清栈，不是退一层）。
   *
   * 修法是 A（Windows 用户的肌肉记忆）：`Alt+←` 与鼠标侧键（XButton1）
   * 不动任何页面版式，覆盖全部 5 种页面，一次到位。
   *
   * ★★ 护栏踩过一个坑，记下来：**不能用 `escDepth() === 0` 判断「有没有东西开着」**。
   * `escDepth()` 数的是「注册了多少个 handler」，不是「有多少个真开着」——
   * `ItemDetail` 的 `dqOpen` 面板、`Practice` 的 `qtOpen` 面板、`Capture` 的
   * 「选位置」弹窗都是**挂载时就无条件注册**，`registerEsc` 内部再按自己的状态
   * 决定要不要消费（`if (!dqOpen) return false`）。讲次页只要挂着 `Capture`
   * （它一直挂着），`escDepth()` 就 ≥1 —— 按旧护栏，Alt+← 在整个讲次页
   * 永远失效，这不是「浮层挡住了」，是判据本身量错了东西。
   *
   * 正确做法：**直接问 `handleEsc()` 本身**——它是唯一知道「按下去真正会不会
   * 关掉什么」的地方（走一遍栈，返回是否真被消费）。所以 Alt+← 先尝试
   * `handleEsc()`：真关掉了什么就到此为止（和按 Esc 是同一件事，只是键位不同，
   * 不再顺带翻页，同 D-440「一次只退一层」）；没关掉任何东西才轮到 `goBack()`。
   */
  function tryGlobalBack(): void {
    /**
     * ★★ 顺序改过一次（2026-09-08，I-171 带出来的真回归，`smoke:nav` 当场抓到）
     *
     * 原来是「**先**看焦点在不在输入框 → 在就什么都不做 → **再** handleEsc()」。
     * 那条输入框保护是对的：Alt+← 在文本框里是「把光标移到上一个词」，不该被我们抢走。
     * 但 I-171 让搜索浮层一打开焦点就落进输入框（那正是它该做的），
     * 于是 **Alt+← 再也关不掉搜索浮层了** —— 保护把「关浮层」一起挡掉了。
     *
     * 正确的先后是：**关浮层不动光标**，所以它不受那条保护的限制。
     *   ① 先问 handleEsc()：栈顶有浮层就关它，到此为止（和 Esc 同一件事，D-440 一次只退一层）
     *   ② 没关掉任何东西，才轮到翻页 —— 这时候才需要那条输入框保护
     */
    if (handleEsc()) return
    if (backStack.length === 0) return
    const el = document.activeElement
    const tag = el?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement | null)?.isContentEditable) {
      return
    }
    goBack()
  }
  /**
   * 展开着的分组 · I-079
   *
   * **键必须带上是哪一级**。以前存的是裸 id —— 项目 id 和单元 id 各自从 1 开始，
   * 于是「项目 1」和「单元 1」共用一个开关：展开一个项目，某个毫不相干的单元
   * 跟着展开。表现是「折叠状态自己乱跳」，查起来完全想不到是 id 撞了。
   */
  let openIds = $state<string[]>([])
  /**
   * ★ H-4a · 漏网错误的显示位。
   *
   * 列表本身住在 `errors.ts`（普通模块，不依赖 Svelte 活着）——
   * 那一层在 `mount()` 之前就装好了，这里只是把它接到界面上。
   * 没有错误时**一个节点都不渲染**，正常状态下的 DOM 与总原型逐层一致（D-251）。
   */
  let errs = $state<AppError[]>([])
  $effect(() => onErrors((l) => (errs = l)))

  let starting = $state(false)
  let startError = $state<string | null>(null)
  /** D-196 · 搜索是浮层，不是独立视图 */
  let searching = $state(false)
  /** 全屏浮层：认读 / 产出。null = 没开 */
  let overlay = $state<
    | {
        kind: 'reading'
        lectureId: number | null
        test?: { lectureIds?: number[]; itemIds?: number[]; shuffle: boolean }
      }
    | { kind: 'practice'; scope: PracticeScope }
    | null
  >(null)

  async function loadTree(): Promise<void> {
    try {
      const data = await window.nyx.data.tree()
      tree = { k: 'ok', data }
      // I-072 · 只展开第一个项目，**单元一律折叠**。
      // 使用者：「单元默认应该是折叠的」—— 十几个单元全展开，侧边栏第一眼就是一堵墙。
      if (openIds.length === 0 && data[0]) openIds = [`p${data[0].id}`]
    } catch (err) {
      tree = { k: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
  loadTree()

  /**
   * ══ 首次引导 · SC-25（D-483 · 使用者 2026-09-15）════════════════
   *
   * 「用户第一次进入软件时：显示简短引导 → 用户了解核心操作 → 完成后结束 →
   *   以后不再反复出现。」
   *
   * ★ 判据在 core（`shouldOnboard`），这儿只负责取值和摆位置 ——
   *   两端共用同一条判据，Android 那半场拿的是同一个函数。
   * ★ 读的是 `ui.` 那条 DEVICE 通道：换了台电脑该重看一遍，这不是学习数据。
   * ★ **读不出来就当没看过**（`ui:get` 失败给空串，`shouldOnboard('')` 为真）——
   *   宁可多出一次引导，也不要因为一次读失败让他永远见不到它。
   * ★ **取值**不等 `loadTree()`：引导一张业务表都不查，第一次进来必然是空库，
   *   等它反而会在最该出现的那一刻多一种死法。
   *   （**摆出来**要等启动页收掉 —— 那是另一回事，见下面渲染那一处。）
   */
  let onboarding = $state(false)
  window.nyx.ui
    .get(ONBOARDING_KEY)
    .then((v) => (onboarding = shouldOnboard(v)))
    .catch(() => (onboarding = true))

  /** 看完 / 跳过都算看过 —— 写下时间戳，这台设备以后不再出 */
  function finishOnboarding(): void {
    onboarding = false
    window.nyx.ui.set(ONBOARDING_KEY, String(Date.now())).catch(() => {})
  }

  // D-231 · 数据在界面之外变了（比如同步拉下来一批），收到广播就重取。
  // 「改一处，全部派生显示自动更新」（D-185）在跨进程时不会自己发生 —— 得有人喊一声。
  /**
   * ★ H-4b · 订阅失败会让界面**再也不会自动刷新**，而且完全无感 ——
   * 他会看到「别的地方改了，这里没变」，永远猜不到是订阅没挂上。
   * 挂不上就当场说一句，别让它悄悄没了。
   */
  try {
    window.nyx.onDataChanged(() => void loadTree())
  } catch (err) {
    reportError(err, '数据变化的自动刷新没挂上（别处改了这里可能不会自己更新）')
  }

  const isOpen = (k: string) => openIds.includes(k)
  const toggle = (k: string) => (openIds = isOpen(k) ? openIds.filter((x) => x !== k) : [...openIds, k])
  /**
   * ★★ I-1（2026-09-03 UI 审计）· 「确保展开」——**只开不关**。
   *
   * 8.1 定的是「点项目 = 展开它**并且**进它的页面」，那条没错，问题出在
   * 它用的是**无条件翻转**的 `toggle`：于是点你**已经在**的那个项目，
   * 会把它的子树**收起来** —— 你想看它，它却把内容藏了。
   *
   * ★ 收起是另一件事，交给行末那个小箭头（原来是纯装饰，现在能点了）。
   */
  const ensureOpen = (k: string): void => {
    if (!isOpen(k)) openIds = [...openIds, k]
  }

  /**
   * F-01 · 先贴，贴完再问归属。
   * 不许「先建项目 → 单元 → lecture 三层才能贴东西」——就地建好默认路径，事后随时改名。
   */
  async function startPasting(): Promise<void> {
    starting = true
    startError = null
    try {
      const id = await window.nyx.data.ensurePath()
      await loadTree()
      go({ k: 'lecture', id })
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err)
    } finally {
      starting = false
    }
  }

  const key = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') fn()
  }

  // ── I-032 / I-033 / I-034 · 三层的增删改 ────────────────────
  // 侧边栏上每一级都要能建、能改名、能删。以前只有贴材料时顺手建的那一条路。
  /** 三点菜单。带坐标 —— 它是浮在上面的下拉框，不是把侧边栏撑开一块（I-048） */
  let menu = $state<{
    kind: 'project' | 'unit' | 'lecture'
    id: number
    name: string
    x: number
    y: number
  } | null>(null)
  /** 改名是二级动作：点了「改名」才出输入框，不占主菜单的位置 */
  let renaming = $state(false)

  /**
   * 打开三级菜单 · I-048 / I-056
   *
   * 两个入口走同一个函数：点 `⋮`，或者**在整行上右键**。
   * 右键这条尤其要紧 —— 名字长的时候行尾那两个图标会被挤没（I-056），
   * 右键是永远不会被挤掉的那个入口。
   */
  function openMenu(e: MouseEvent, kind: 'project' | 'unit' | 'lecture', id: number, name: string): void {
    e.preventDefault() // 右键时挡掉系统菜单
    e.stopPropagation()
    if (menu?.id === id && menu.kind === kind) {
      menu = null
      return
    }
    // 右键就落在鼠标位置；点 ⋮ 就贴着那个图标下沿
    const isContext = e.type === 'contextmenu'
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const left = isContext ? e.clientX : r.left
    const top = isContext ? e.clientY : r.bottom + 4
    // 靠近窗口底部时往上翻，免得被切掉
    const y = top + 300 > window.innerHeight ? Math.max(8, top - 300) : top
    menu = { kind, id, name, x: Math.min(left, window.innerWidth - 210), y }
    renaming = false
    moving = null
  }
  let treeNote = $state<string | null>(null)
  /**
   * ★ D-469 · 「随时认读 / 练习」「导出笔记」这两个动作从项目页搬进了这棵树的右键菜单。
   *   项目页上它们失败时进的是一个 `.errbox`（H-4：失败要看得见，且说清是哪一步）；
   *   而 `treeNote` 渲染成绿色的成功样子 —— 直接塞进去，「没做成」和「做成了」
   *   会长得一模一样。所以失败单独一个位。
   */
  let treeErr = $state<string | null>(null)
  /** I-064 · 文件学习页里当前那篇文章归到哪一讲 —— 右键「收进本 lecture」要用 */
  let fileLecture = $state<number | null>(null)

  /**
   * ★ Q-1 · 手误双击不许建出两个（使用者 2026-09-03 选 B「按时间去抖」）
   *
   * 实测：对着侧边栏那颗 `＋` 真 `dblclick` 一次 → **建出两个项目**，
   * 第二个是空的、默认名，他得自己发现、自己删，而且没有撤销。
   *
   * ★★ **为什么是「按时间」而不是「上一次没建完就不受理」**：
   * 我先试过后者，加完再测还是 2 个 —— 建一个项目本地不到 100ms，
   * 两下点击之间上一次早就完成了，**根本不存在「飞行中的重复」**。
   * 那道闸挡不住任何东西，注释却说得头头是道，比没有更糟，已撤回。
   *
   * ★ 去抖**按目标分别记**（`kind:parentId`）：在 A 项目下建单元
   * 不该被刚才在别处的一次新建挡掉。
   * ★ 只挡 400ms 内的第二下（那种他还没看见结果）；**有意的连续新建照旧**。
   */
  const DOUBLE_CLICK_MS = 400
  const lastMake = new Map<string, number>()

  async function make(kind: 'project' | 'unit' | 'lecture', parentId: number): Promise<void> {
    const slot = `${kind}:${parentId}`
    const now = Date.now()
    if (now - (lastMake.get(slot) ?? 0) < DOUBLE_CLICK_MS) return
    lastMake.set(slot, now)
    treeNote = null
    treeErr = null
    // I-087 · 菜单点完就收。
    // 「＋ 新建单元」挪进右键菜单之后忘了这一句 —— 建完菜单还浮在那里，
    // 挡着刚建出来的那一行，看上去像「点了没反应」。
    menu = null
    renaming = false
    moving = null
    try {
      if (kind === 'project') {
        const id = await window.nyx.data.createProject()
        await loadTree()
        // ★ D-469 · 项目没有自己的页面了，建完就把它**展开**（人得看得见它在哪）
        openIds = [...openIds, `p${id}`]
        treeNote = '建好了 —— 右键或点 ⋮ 改个名字。'
      } else if (kind === 'unit') {
        const id = await window.nyx.data.createUnit(parentId)
        await loadTree()
        openIds = [...new Set([...openIds, `p${parentId}`, `u${id}`])]
        treeNote = '单元建好了。'
      } else {
        const id = await window.nyx.data.createLecture(parentId)
        await loadTree()
        openIds = [...new Set([...openIds, `u${parentId}`])]
        go({ k: 'lecture', id }) // 建完直接进去，省一次点击
      }
    } catch (err) {
      tree = { k: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  async function renameNode(): Promise<void> {
    if (!menu) return
    try {
      await window.nyx.data.rename(menu.kind, menu.id, menu.name)
      menu = null
      await loadTree()
    } catch (err) {
      treeErr = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * ★ B5 · 侧栏树的删除**在这之前一句都不问**（点了菜单里那一行，东西就没了）——
   *   这是 Windows「三种确认形态」里的第一种：没有。BTN-Q4 定案要一律先弹确认框。
   *   `askDel` 存的是**菜单关掉之前**的那一份，因为确认框一开菜单就收了（I-087 的教训：
   *   先收菜单再做事，否则遮罩会挡死后面的错误框）。
   */
  let askDel = $state<{ kind: 'project' | 'unit' | 'lecture'; id: number; name: string } | null>(null)

  async function deleteNode(): Promise<void> {
    if (!askDel) return
    const m = askDel
    askDel = null
    treeErr = null
    treeNote = null
    try {
      // lecture 走 deleteLecture —— 它还要处理 D-091 的条目归属转移，
      // 项目 / 单元只是把下面整支标成已删
      const n =
        m.kind === 'lecture'
          ? (await window.nyx.browse.deleteLecture(m.id)).items
          : (await window.nyx.data.softDelete(m.kind, m.id)).lectures
      await loadTree()
      // ★ BTN-Q5 · 6 秒撤销。回执**说真实结果**：跟着走了多少东西，不说「删除成功」
      sayUndo(
        m.kind === 'lecture'
          ? `删掉了「${m.name}」，${n} 条知识点跟着进了回收站`
          : `删掉了「${m.name}」，${n} 个 Lecture 跟着进了回收站`,
        async () => {
          await window.nyx.browse.restore(m.kind, m.id).catch((e) => {
            // 失败路径写在调用点上：换成一句人话再抛，`runUndo` 会把它变成回执
            throw new Error(`没能恢复：${cleanMessage(e)}`)
          })
          await loadTree()
        },
        `「${m.name}」已从回收站恢复`
      )
      /**
       * 正看着的东西被删了就回首页 —— 否则停在一个已经不存在的页面上。
       * ★ D-469 之后只剩讲次这一种：项目 / 单元不再是页面，删掉它们只影响那棵树。
       */
      const cur = nav
      const gone = cur.k === 'lecture' && !allLectures.some((l) => l.id === cur.id)
      // ★ D-440 · 连来路栈一起清：栈里可能还压着刚被删掉的那几页
      if (gone) enter({ k: 'home' })
    } catch (err) {
      treeErr = err instanceof Error ? err.message : String(err)
    }
  }

  const allLectures = $derived(
    tree.k === 'ok' ? tree.data.flatMap((p) => p.units.flatMap((u) => u.lectures)) : []
  )

  /**
   * D-484 · B-1 / B-4 · 进 Today 就说那两句（I-190 改的就是这里）。
   *
   * ══ 原来错在哪 ★★★ ═══════════════════════════════════════
   *
   * 第一版这两条绑的是**窄交互**：`today-paste` 要「库为空」、
   * `sidebar-tree` 要「点一下展开」。于是使用者装上真用时**一条都没出现** ——
   * 他库里有几百条、侧栏本来就是展开的。
   * 而 `smoke:guide` 11 条全绿，因为**用例自己把局面摆成满足条件的样子**。
   * ☞ 判据换成他的状态：**进了这一页 + 那个块在屏上** 就出。
   *
   * ★ 仍然要等 `tree.k === 'ok'`：`loading` 那一瞬目标还没渲染出来，
   *   那时候问，浮层量不到东西，只会白占一次「同时只许出一条」。
   * ★ 两条都在这一页上，而一次只出一条 —— 后到的那条**下次进来再出**
   *   （被挡下的是推迟不是吃掉，`smoke:guide` 第 ⑤ 条钉着这件事）。
   */
  $effect(() => {
    if (nav.k !== 'home') return
    if (tree.k !== 'ok') return
    void askGuide('today-paste')
    void askGuide('sidebar-tree')
    /** ★ 清单 15：和上面那条同屏但治的是另一件事（「这个数是上限吗」）—— 一次只出一条 */
    void askGuide('today-recommend')
  })

  /**
   * D-484 · 覆盖面清单 §二 那几条**长在路由上**的（T-2）。
   *
   * ★ 全都写成「进了这一页就问」—— I-190 的教训：绑在某个动作 / 某种数据状态上，
   *   等于绑在一个他多半不满足的局面上，而屏上一声不响。
   * ★ 目标在不在由 `PageGuide` 自己判：量不到就放弃（`onmiss`，会 warn 一行），
   *   **不记「看过」**，下次进来还会问。所以这里不预判「那一页有没有内容」。
   */
  $effect(() => {
    if (nav.k === 'lecture') void askGuide('lecture-split')
    else if (nav.k === 'trash') void askGuide('trash-tiers')
    else if (nav.k === 'report') void askGuide('report-layers')
    else if (nav.k === 'item') void askGuide('item-analysis')
  })

  /*
   * ★ D-467 · 到期徽章（D-456 加的）跟着侧边栏一起撤了。
   *   它唯一的消费者是「今天」那一行，而那一行已经变回「首页」。
   *   ★ 状态和刷新一并删掉 —— 留着一个没人读的 $state ＋ 每 N 秒一次的查询，
   *     就是「看不见的耗电」，而且下一个人会以为它还在用。
   */

  // ── I-042 · 一键同步 ────────────────────────────────────────
  // 配过同步才显示这一行 —— 没配的人不该看见一个永远点不动的按钮。
  let syncOn = $state(false)
  let syncPending = $state(0)
  let syncing = $state(false)
  let syncMsg = $state<string | null>(null)
  /**
   * ★ B6 / NT-Q2 · **同步失败要分级**：
   *   第 1–2 次 → 入口旁一枚**静态标记**（单次失败多半是网络抖，不值得打断）
   *   连续 ≥3 次 → 内容区顶部一条 **Banner**，**不能手动关**（关了问题还在），带「去设置」
   *   成功 → 计数清零，**不报喜**（NOTIFICATION §一：synced 只把「待推 N」变成不显示）
   *
   * ★ 这个数**只活在这一次开着的软件里**（刷新就归零）：库里今天没有这一列，
   *   而桌面软件「开着就看得见」——真要跨次记账得先加数据层，那是另一件事。
   *   已记进派单 §六「回报总控」。
   */
  let syncFails = $state(0)

  /**
   * ★ D-457 · Today 那一行的到期 Badge。
   *
   * 数只从 `study.overview()` 来 —— 渲染层照着 lectures 自己数一遍，
   * 就是这个项目最贵的那类账：**同一件事两份判据**（D-185）。
   * 读不出来当 0（= 不显示），不在侧栏上画一个自己算的数。
   */
  let dueLectures = $state(0)
  async function refreshDue(): Promise<void> {
    try {
      dueLectures = (await window.nyx.study.overview()).dueLectures
    } catch {
      dueLectures = 0 /* 读不出来就不显示 —— 侧栏不猜 */
    }
  }

  async function refreshSync(): Promise<void> {
    try {
      const st = await window.nyx.sync.status()
      syncOn = st.kind !== 'off'
      syncPending = st.pending
    } catch {
      syncOn = false
    }
  }
  refreshSync()
  refreshDue()

  /**
   * ★★ 这个数字必须是**现在**的数字（D-185 · 界面层不持有数据副本）
   *
   * 原来 `refreshSync()` 全程只在启动时跑过这一次。于是开机之后不管收了多少词、
   * 练了多少条、在设置页里同步过几趟，侧边栏那个数字一直停在开机那一刻。
   *
   * **它错的方向恰好是危险的那一边。** 徽章只在 `> 0` 时才显示：
   * 开机时是 0 就不显示，此后学一整天、攒下几百行没推上去 —— 侧边栏依然干干净净，
   * 他有充分理由以为「都推上去了」。这不是显示不准，是**在数据安全上给了假承诺**。
   *
   * 两条一起补，各管一种情形：
   *   ① 换页时立刻重读 —— 他一走动就是对的（在设置里同步完再走开，也当场对上）
   *   ② 静坐时按心跳重读 —— 他要是就待在采集页收一下午词，也不会被瞒着
   * 心跳只在配过同步时才跑，没配的人一次查询都不会发生。
   */
  $effect(() => {
    void nav.k
    void refreshSync()
    void refreshDue()
  })

  /**
   * ★★★ D-451 · 有来路，就把来路显示出来（P-1 的 B 方案 · 阶段⑧）
   *
   * D-451 定的是：**「一级」是入口的属性，不是页面的属性。**
   * 同一个项目页，从侧边栏进就是根，从搜索结果点进去就是下钻的一层 ——
   * 页面处在第几层由**你怎么来的**决定。
   *
   * 于是有一件事页面自己永远答不出来：**「我现在是根，还是被人钻进来的一层？」**
   * 答案不在页面里，在来路里。那就别让页面猜 —— 把来路直接显示出来。
   *
   * ★ 这不是加一个返回按钮（Alt+← 和鼠标侧键早就能返回了，D-450）。
   *   它加的是**「你是从哪来的」这条信息** —— 所以它说的是「返回 · 搜索」
   *   而不是光一个「返回」。看见它，就知道自己站在第二层；
   *   看不见它，就知道自己站在根上。这才是 D-451 真正扎人的那一半。
   *
   * ★ 收成一个：讲次页和词条页原来各有一个自己的返回入口，现在都由这里出。
   *   同一件事只有一个出口，也就不会再出现「这一屏有、那一屏没有」。
   */
  const nameOfNav = (n: Nav): string => {
    switch (n.k) {
      case 'home':
        return 'Today'
      case 'hard':
        return '攻坚区'
      case 'files':
        return '文件学习'
      case 'trash':
        return '回收站'
      case 'settings':
        return '设置'
      case 'report':
        return '分析报告'
      case 'item':
        return '这条知识点'
      case 'lib':
        return n.scope === 'silent' ? SILENCE_FILTER_NAME : n.scope === 'upload' ? '我的收集' : '全部'
      case 'lecture':
        return allLectures.find((l) => l.id === n.id)?.name ?? '这个 Lecture'
    }
  }

  /** 上一层是什么 —— 栈空就是 null，那时他站在根上，不该有返回入口 */
  const backTo = $derived.by((): string | null => {
    const fr = backStack.at(-1)
    if (!fr) return null
    // 那一层当时开着搜索，返回就该回到**那次搜索**（D-440），说清楚
    return fr.search !== undefined ? '搜索' : nameOfNav(fr.nav)
  })

  const SYNC_BEAT_MS = 20_000
  $effect(() => {
    /**
     * ★ 两个徽章的心跳要分开（D-456）
     *
     * 原来整条心跳被 `if (!syncOn) return` 挡着 —— 那对同步徽章是对的
     * （没配同步的人不该有一次查询发生），但到期徽章跟它没关系：
     * **没配同步的人照样会欠账**，挡掉就等于他坐着不动时那个数永远不更新。
     */
    const t = setInterval(() => {
      if (syncOn) void refreshSync()
      void refreshDue() /* ★ 不受 syncOn 挡 —— 没配同步的人照样会欠账 */
    }, SYNC_BEAT_MS)
    return () => clearInterval(t)
  })

  async function quickSync(): Promise<void> {
    syncing = true
    syncMsg = null
    try {
      const r = await window.nyx.sync.run()
      // 有冲突就不在侧边栏自作主张 —— 指到设置页去选（D-201）
      syncMsg = r.conflictNote ? `${r.conflictNote}（去设置 · 同步里选）` : r.lastNote
      syncPending = r.pending
      syncFails = 0 // 成功就清零，但**不报喜**
      await loadTree()
    } catch (err) {
      syncFails += 1
      syncMsg = err instanceof Error ? err.message : String(err)
    } finally {
      syncing = false
    }
  }

  // ── I-047 · 三级菜单的其余动作 ──────────────────────────────
  /**
   * 「移到…」逐级选 · I-085
   *
   * 使用者：「右键选去处也要和文件学习页那个一样，一级一级选。」
   * 以前是把**全部单元**平铺成 `项目 › 单元` 一长串 —— 项目一多就是几十行，
   * 和 I-064 之前那版路径选择犯的是同一个错。
   *
   * `null` = 没在选；`{ p: null }` = 正在选项目；`{ p: 3 }` = 项目选好了，正在选单元。
   * 搬单元只有第一级（目标就是项目），搬 lecture 走满两级。
   */
  let moving = $state<{ p: number | null } | null>(null)

  type Node = { kind: 'project' | 'unit' | 'lecture'; id: number; name: string }

  const pinnedOf = (id: number): boolean =>
    tree.k === 'ok' ? (tree.data.find((p) => p.id === id)?.pinned ?? false) : false

  /**
   * 侧边栏拖拽排序 · 使用者 6.1
   *
   * 「项目：只能在项目栏内拖动排序。单元：只能在本项目内。
   *   Lecture：只能在本单元内。**不允许跨级拖动。**」
   *
   * 判据就一条：**同一类 + 同一个父级**。不满足就不接受这次放下 ——
   * 而且要让他**在拖的过程中就看出来**（`dragover` 不 preventDefault，
   * 鼠标会显示「禁止」），不能等松手之后才弹一句「不能这么拖」。
   * 那种反馈来得太晚，人已经做完动作了。
   *
   * 落库传的是整个父级下的完整顺序，见 repo.reorder 的注释。
   */
  type DragRef = { kind: 'project' | 'unit' | 'lecture'; id: number; parent: number | null }
  let dragging = $state<DragRef | null>(null)
  let dropOn = $state<string | null>(null)

  const dragKey = (r: DragRef): string => `${r.kind}:${r.id}`

  /**
   * 8.1 · 点项目 = 展开它 **并且** 进它的页面。
   *
   * 以前展开和进页面是两件事，进页面要点里面那一行「📊 项目总览」——
   * 那一行的存在只是因为外面这一行被 toggle 占住了。
   * 现在一次点击两件事都做：收起的时候也一样进页面，
   * 因为「我点了这个项目」表达的是「我要看它」，不是「我要折叠它」。
   */
  /**
   * ★ H-3 · 讲次页面包屑点上去要能跳。
   * `LectureBrief` 只带 `projectName` / `unitName`，**不带 id** ——
   * 但外壳手上有整棵树，自己解析就行，不必为这一下改后端契约。
   */
  /**
   * ★ D-469 · 面包屑点上去**不再跳页**（项目页 / 单元页取消了），
   *   改成「在侧边栏里把它找出来」：展开到那一层，人一眼看得见自己在哪一支。
   *
   *   这不是把控件留着装样子 —— 面包屑回答的是「我在哪」（归属），
   *   而「在哪」这件事现在唯一的去处就是那棵树。点了什么都不发生才是死控件。
   */
  function revealPath(lectureId: number, kind: 'project' | 'unit'): void {
    if (tree.k !== 'ok') return
    for (const p of tree.data)
      for (const u of p.units)
        if (u.lectures.some((l) => l.id === lectureId)) {
          ensureOpen(`p${p.id}`)
          if (kind === 'unit') ensureOpen(`u${u.id}`)
          return
        }
  }

  /**
   * 搜索结果 / 总览里点到项目或单元时：**展开到它**，不跳页（D-469）。
   * 找不到就什么都不做 —— 树还没加载完时不该乱跳。
   */
  function revealNode(kind: 'project' | 'unit', id: number): void {
    if (tree.k !== 'ok') return
    if (kind === 'project') {
      ensureOpen(`p${id}`)
      return
    }
    for (const p of tree.data)
      if (p.units.some((u) => u.id === id)) {
        ensureOpen(`p${p.id}`)
        ensureOpen(`u${id}`)
        return
      }
  }

  function canDrop(target: DragRef): boolean {
    return (
      dragging !== null &&
      dragging.kind === target.kind &&
      dragging.parent === target.parent &&
      dragging.id !== target.id
    )
  }

  function onDragStart(e: DragEvent, r: DragRef): void {
    dragging = r
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      // 有些平台上不 setData 就不触发 drop
      e.dataTransfer.setData('text/plain', dragKey(r))
    }
  }

  function onDragOver(e: DragEvent, target: DragRef): void {
    if (!canDrop(target)) {
      dropOn = null
      return // 不 preventDefault → 鼠标显示「禁止」，他当场就知道不行
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropOn = dragKey(target)
  }

  /** 当前这一层的完整顺序，把拖动的那一条挪到目标位置 */
  function siblingIds(r: DragRef): number[] {
    if (tree.k !== 'ok') return []
    if (r.kind === 'project') return tree.data.map((p) => p.id)
    if (r.kind === 'unit') {
      return tree.data.find((p) => p.id === r.parent)?.units.map((u) => u.id) ?? []
    }
    for (const p of tree.data) {
      const u = p.units.find((x) => x.id === r.parent)
      if (u) return u.lectures.map((l) => l.id)
    }
    return []
  }

  async function onDrop(e: DragEvent, target: DragRef): Promise<void> {
    e.preventDefault()

    /**
     * ★ 判定必须在**清状态之前**做。
     *
     * 第一版是先 `dragging = null` 再 `canDrop(target)` —— 而 `canDrop` 读的正是
     * `dragging`，于是**每一次放下都被判成「不能放」**，静静地什么都不做：
     * 不报错、鼠标反馈也正常，只是松手之后顺序没变。
     * 使用者的原话是「这个没做好」——他拖了，什么都没发生。
     *
     * 后端的 `reorder()` 单元测试当时是全绿的。**后端对了不等于拖得动。**
     */
    const src = dragging
    const ok = src !== null && canDrop(target)
    dragging = null
    dropOn = null
    if (!src || !ok) return

    const ids = siblingIds(target)
    const from = ids.indexOf(src.id)
    const to = ids.indexOf(target.id)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    try {
      await window.nyx.data.reorder(src.kind, src.parent, ids)
      await loadTree()
    } catch (err) {
      tree = { k: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 归档状态。lecture 的静默已经合成进 status 了（见 repo.tree）。 */
  const silentOf = (m: Node): boolean =>
    m.kind === 'lecture' ? allLectures.find((l) => l.id === m.id)?.status === 'silent' : false

  /** 第一级：所有项目 */
  const moveProjects = $derived(
    tree.k === 'ok' ? tree.data.map((p) => ({ id: p.id, label: p.name })) : []
  )
  /** 第二级：选中项目下面的单元（搬 lecture 用） */
  const moveUnits = (pid: number): { id: number; label: string }[] =>
    tree.k === 'ok'
      ? (tree.data.find((p) => p.id === pid)?.units.map((u) => ({ id: u.id, label: u.name })) ?? [])
      : []

  const act = async (fn: () => Promise<unknown>, note: string): Promise<void> => {
    try {
      await fn()
      menu = null
      moving = null
      treeNote = note
      await loadTree()
    } catch (err) {
      treeErr = err instanceof Error ? err.message : String(err)
    }
  }

  const pinNode = (id: number): Promise<void> =>
    act(() => window.nyx.data.setPinned(id, !pinnedOf(id)), pinnedOf(id) ? '取消置顶了。' : '置顶了。')

  const archiveNode = (m: Node): Promise<void> =>
    act(
      () => window.nyx.data.setSilent(m.kind, m.id, !silentOf(m)),
      silentOf(m)
        ? `${SILENCE_ACTIONS.restore}：重新排进练习。`
        : `${SILENCE_ACTIONS.shelve}：不再排期，进度原样保留。`
    )

  const unreadNode = (id: number): Promise<void> =>
    act(() => window.nyx.data.markUnread(id), '打回待审阅了 —— 重新过一遍这一批，进度没动。')

  const forkNode = (id: number): Promise<void> =>
    act(
      () => window.nyx.data.forkLecture(id),
      '复制好了（只复制了材料）—— 换套分析指令重新拆一遍试试。'
    )

  const moveNode = (m: Node, to: number): Promise<void> =>
    act(() => window.nyx.data.move(m.kind as 'unit' | 'lecture', m.id, to), '搬过去了。')

  async function exportNode(m: Node): Promise<void> {
    treeErr = null
    treeNote = null
    // ★ 同上：菜单先收，否则失败时那张遮罩会把错误框挡死
    menu = null
    moving = null
    try {
      const p = await window.nyx.data.exportNotes(m.kind, m.id, m.name)
      treeNote = p ? `笔记写在：${p}` : null
    } catch (err) {
      treeErr = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * I-061 · 开测之前先问清楚：测哪条线、要不要乱序。
   * 「不遵循间隔重复，只要想测都能测」—— 所以这里**不看到期日**。
   *
   * ★ T-4.13（D-R28「排期是推荐，不是门禁」）· `line` = 他从哪个入口进来的。
   *   讲次页上现在有明写的「随时认读」「随时练习」两个入口（★ D-469 之后
   *   项目 / 单元 那两页没了，它们的同一对入口在树节点的右键菜单里），
   *   点进来时把那条线**先选好**（那一颗是主按钮，另一条仍然在，改主意不用退出去）。
   *   树菜单的「测试…」不带 `line` —— 它问的就是「测哪条线」，保持原样。
   *   **弹窗只有这一个**：入口多了，问法不该跟着长出第二份（不新造 I-061）。
   */
  let testDlg = $state<{ name: string; ids: number[]; line?: 'reading' | 'practice' } | null>(null)
  let testShuffle = $state(false)

  /**
   * ★ LT-B1（<1100）· 侧栏收成 **56 图标条**（使用者 2026-09-09：「按你的推荐来」）。
   *
   * 推荐的是哪一条、为什么：树在 56 宽里**没法看** —— 一列没有名字的圆点等于把它删了，
   * 而 U-001 是「覆盖面一个不减」。所以不是「窄档就没有树」，而是
   * **点一下把侧栏临时铺开盖在内容上，选完自己收回**：
   *   · 覆盖面一条不减（树 · 一级入口 · 右键菜单全在）
   *   · 窄窗口里内容区多出 194px，而那正是窄档唯一真正缺的东西
   *   · 不新造一套导航模型 —— 铺开的就是同一条侧栏，一行代码都不用抄第二份
   *
   * ★ 宽档它**根本不存在**（CSS `display:none`）：不占位置，也不多一个能按的东西。
   * ★ Esc 关它，走到任何一个新位置也自动收 —— 覆盖层不许留在原地挡着内容。
   */
  let railOpen = $state(false)

  /**
   * ★ D-440 · 壳自己那两层浮层进同一个栈（顺序 = 先关菜单，再关测试弹窗）。
   * 以前这段判断写在 window 监听里，于是「谁能被 Esc 关」这件事分散在两个层次上。
   */
  /* ★ Vault 的右栏（D-477）也进 Esc 栈：<1280 时它是**覆盖式**的，盖着内容就得能关。
     排在最前 = 最后被问到；菜单 / 弹窗 / 铺开的侧栏都开在它之上，先关那几层。 */
  $effect(() =>
    registerEsc(() => {
      if (nav.k !== 'lib' || nav.sel === undefined) return false
      closeItem()
      return true
    })
  )
  /* ★ 铺开的侧栏是**盖在内容上**的，所以它进 Esc 栈（IX-04：Esc 只有一个消费点）。
     排在菜单与测试弹窗**后面** —— 菜单开在铺开的侧栏之上，先关里面那层。 */
  $effect(() =>
    registerEsc(() => {
      if (!railOpen) return false
      railOpen = false
      return true
    })
  )
  $effect(() =>
    registerEsc(() => {
      if (!menu) return false
      menu = null
      moving = null
      renaming = false
      return true
    })
  )
  $effect(() =>
    registerEsc(() => {
      if (!testDlg) return false
      testDlg = null
      return true
    })
  )

  /** 三级菜单里点「测试」→ 先算出范围，再弹窗让他选 */
  async function openTest(m: Node): Promise<void> {
    treeErr = null
    treeNote = null
    /**
     * ★ 菜单**先收**，再去做事（同 `make()`，I-087）。
     *   原来是等 IPC 回来才收 —— 而失败那一支根本走不到那一行：
     *   菜单连同它那张全屏遮罩留在屏幕上，把下面刚显示出来的错误框整个挡住，
     *   点哪儿都点不动。这条是搬进树菜单之后当场撞出来的（smoke:errors 红）。
     */
    menu = null
    moving = null
    try {
      const ids = await window.nyx.data.lecturesUnder(m.kind, m.id)
      if (ids.length === 0) {
        treeNote = '这一支下面还没有 Lecture，没得练。'
        return
      }
      testDlg = { name: m.name, ids }
    } catch (err) {
      treeErr = err instanceof Error ? err.message : String(err)
    }
  }

  function runTest(kind: 'reading' | 'practice'): void {
    if (!testDlg) return
    const ids = testDlg.ids
    testDlg = null
    overlay =
      kind === 'reading'
        ? { kind: 'reading', lectureId: null, test: { lectureIds: ids, shuffle: testShuffle } }
        : { kind: 'practice', scope: { kind: 'test', lectureIds: ids, shuffle: testShuffle } }
  }

</script>

<!-- I-092 · Esc 关掉浮层。总原型的脚本里就有这一条（`if(e.key==='Escape')cl()`），
     搬组件的时候漏了。菜单开着时按 Esc 是所有人的肌肉记忆。
     ★ D-440（2026-09-02）· 这里现在是**全 App 唯一的 Esc 消费点**：
       它只负责把键送进 `esc-stack`，由栈顶那一层决定关谁。
       各浮层自己 `registerEsc`，不再各装一个 window 监听
       （以前 Reading / Search / DictCard 各有一个，于是叠着开时一次 Esc 全关掉；
        而 Practice / AnalyzePanel 一个都没有，压根按不了 Esc）。 -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') { handleEsc(); return }
    /**
     * ★ I-170（U-004 / B13）· 侧栏那一行**写着 `Ctrl K`，而键盘上按它什么也不发生** ——
     *   整个渲染层没有一处 `k` 键处理器，提示是假的。这里补上。
     *   · 不清栈也不压栈：搜索是**命令不是空间**（D-455），它只是把浮层打开；
     *     关掉之后他还站在原来那一页上，返回链一个字不动。
     *   · 浮层已经开着时再按一次不做事（不叠浮层，NOTIFICATION §一）。
     *   · 在输入框里按 Ctrl+K 照样开 —— 那正是命令面板该有的样子。
     */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      if (!searching) searching = true
      return
    }
    // P-1 · Alt+← 全局返回（不动版式，覆盖全部压栈页面，见 tryGlobalBack 注释）
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault()
      tryGlobalBack()
    }
  }}
  onmouseup={(e) => {
    // P-1 · 鼠标侧键（XButton1 / 浏览器「后退」键，button === 3）
    if (e.button === 3) {
      e.preventDefault()
      tryGlobalBack()
    }
  }}
/>

<!-- ★ H-4a · 渲染层的最后一道网。
     它接的是**组件渲染/effect 里抛出来的**错误 —— 那一类以前会把整棵树带走，
     表现就是白屏。现在退化成一页人话，而且「回首页」能让他自己走出来。
     boundary 本身不产生任何 DOM，所以 check:dom 的逐层对齐不受影响。 -->
<svelte:boundary onerror={(e) => reportError(e, '界面出错了')}>

<!-- ★ 图标几何（D-410 两端一起重画）—— 0×0 隐藏 svg，挂一次，各处 <use> 引 -->
<Sprite />

<!-- ★ B8 · 启动页：只在冷启动出现，**库开好就走**（300–800ms，DS-Q15）。
     `done` 就是「树读出来了」—— 那一刻主区已经有东西可看，再盖着就是白等。 -->
<Splash done={tree.k !== 'loading'} />

<!--
  ★ SC-25 · 首次引导：**启动页之后**、Today 之前（派单 §时机）。

  ★ `tree.k !== 'loading'` 就是 `<Splash>` 自己那个 `done` —— 同一个条件，
     不另造一个判断。不加这一条的话，引导会在启动页还亮着的时候就挂上去。

  ★★ **它挡不住全部重叠，这一点要说清楚**：启动页有一个 `MIN_MS = 1200` 的
     最短展示时间，所以它比「树读完」还晚走。真正让这件事不出问题的是**层序**：
     `.splash` 是 `z-index: 900`，引导那层是 500 —— 启动页盖在上面，
     他看到的顺序就是「启动页 → 引导」，和派单 §时机 一致。
     要做到「一像素都不重叠」得让启动页在收掉时喊一声，而**派单写明不动启动页**
     （U-007），所以到此为止。
     ☞ 2026-09-15 我第一次截图截在那 1.2 秒里，拍到的是启动页；
       那是**截早了**，不是这一层出了问题。层序是量过的，不是推的。
  ★ 树读失败（`k === 'error'`）时这条也成立 —— 引导该出还是要出：
     它一张业务表都不查，读不出树不是它的事。
-->
{#if onboarding && tree.k !== 'loading'}
  <Onboarding ondone={finishOnboarding} />
{/if}

<!--
  ══ 第二层 · 页面内引导（D-484）· 全 App **一个**宿主 ════════════
  ★ 七条引导长在六个组件里，但**同时只许出一条**，而且第一层没看完一条都不出 ——
    那两条判据写在 `guide.svelte.ts` 一处。页面只说「我这儿碰到 X 了」，
    出不出不归页面判（各判各的话，漏一处的表现是屏上同时弹两个框）。
-->
{#if activeGuide()}
  <PageGuide
    id={activeGuide()!}
    onclose={() => void closeGuide()}
    onmiss={() => dropGuide(activeGuide() ?? undefined)}
  />
{/if}

<!-- ★ B4 · 回执条：全 App **一个**（IX-02 同一类同时只有一个）。
     它浮在所有内容之上、不夺焦点、不消费 Esc（它会自己走）。 -->
<Toast />

<!-- ★ B5 · 侧栏树删除的确认框。标题给**对象名**，正文说真正会发生什么。 -->
{#if askDel}
  <Dialog
    testid="tree-del-dlg"
    title={`删除「${askDel.name}」？`}
    body={askDel.kind === 'lecture'
      ? `移到回收站，${TRASH_KEEP_TEXT}。它里面的知识点跟着一起走。`
      : `移到回收站，${TRASH_KEEP_TEXT}。它下面的 Lecture 与知识点跟着一起走。`}
    confirmLabel="删除"
    danger
    onconfirm={deleteNode}
    oncancel={() => (askDel = null)}
  />
{/if}

<div class="win">
  <div class="titlebar">
    <span class="nm">Nyx</span>
    <span class="wb">
      <i
        role="button"
        tabindex="0"
        title="最小化"
        data-testid="win-min"
        onclick={() => window.nyx.win.minimize()}
        onkeydown={key(() => window.nyx.win.minimize())}>─</i
      >
      <i
        role="button"
        tabindex="0"
        title="最大化"
        data-testid="win-max"
        onclick={() => window.nyx.win.toggleMaximize()}
        onkeydown={key(() => window.nyx.win.toggleMaximize())}>▢</i
      >
      <i
        class="cl"
        role="button"
        tabindex="0"
        title="关闭"
        data-testid="win-close"
        onclick={() => window.nyx.win.close()}
        onkeydown={key(() => window.nyx.win.close())}><Ic n="close" s={18} /></i
      >
    </span>
  </div>

  <div class="body">
    <!-- ══ 侧边栏 · 顶层七行（D-042）══ -->
    <!--
      ★★★ D-467（使用者 2026-09-03）· **侧边栏整块撤回 UI 阶段之前那一版**

      他的原话：「侧边栏还是按照原来的软件的侧边栏来，每个侧边栏点开的还是
      原来的那个项目的页面，我只需要精修一下」，随后补一句
      「我是说，原来的、在这个会话没有进行到 UI 阶段的那个原来的软件」，
      并且**直接给了两张他正在用的那一版的截图**说「我要留的，是这个」。

      → 判据不是我的方案文档，是**他屏幕上那一版**。
        这一块是从 37809bc^（D-457 导航落地之前）**原样取回来的**，不是照着截图重写的
        —— 照着重写就等于又做了一次翻译，而翻译正是这个项目最贵的事故形态。

      ★ 因此被撤掉的（都是我在 D-457 那一轮做的）：
        · 「首页」→「今天」＋到期徽章       · 四个分组名（我的知识 / 全部知识点 / 工具 / 系统）
        · ⌘K 提示与待同步计数分槽（.hint/.badge）· 「知识点」组头降为分区标题
        · 核心入口钉底（.side-gap 那一套）
      ★ 一并撤掉的还有本轮的「置顶 / 其余」分段。

      ══ D-R19（使用者 2026-09-05 裁定）取代了上面哪一半 ══════════

      ★★ **只取代「分段 / 钉底」那一半**，也就是最后两条：
        · 「置顶 / 其余」分段        → 现在是 ② 置顶区 + ③ 普通项目区（T-4.9）
        · 核心入口钉底              → 现在是 ① 顶部固定区 + ④ 底部固定区（T-4.9）

      ★★ **另外那一半仍然作数，一个字都没动**：
        · 「首页」还是「首页」，没有改成「今天」，没有到期徽章
        · **没有加任何新的分组名**（我的知识 / 全部知识点 / 工具 / 系统 一个都没回来）
          —— 唯一新增的标题是「置顶」，那是 D-R19 点名的那一区，不是分组名回潮
        · 没有 .hint / .badge 分槽；「知识点」仍是原来那一行 `.nv open`，没降级成分区标题
        · 字号 / 颜色 / 图标 / 行的写法一律不动（D-R19 的范围锁死在**空间组织**）

      ★ D-457 留的判据是「撤销过的东西再加回来之前，先找出当初为什么撤」。
        当初撤的理由是他要「原来那版、只精修」—— **不是分段本身有问题**；
        2026-09-05 他重新提了空间组织这条需求，是新的产品意图，已由 D-R19 单裁。

      ★★ **不撤的**：I-1b 那颗单元收起箭头（它是 bug 修复，不是版式；
        而且它就在 37809bc^ 里 —— D-456 比 D-457 早）。

      ★★★ 一件必须说出来的后果：**「项目总览」这一页失去了入口**
        （D-462～D-465 做的那一屏，他自己命名的）。页面代码原样留着，
        入口等他定放哪儿 —— 我不替他在这块刚撤回的侧边栏上再加一行。
    -->
    <!--
      ══ 侧栏整条（SC-23）· 屏级重做 · 2026-09-09 ═══════════════════════

      ★ 五问（守「别把功能弄丢」）由派单答过：**八条能力 ＋ 10 个一级入口一条不减**。
        下面是六问（问「这一条侧栏到底该长什么样」）的答案。
        ★★ 上面 D-467 那一大段仍然作数 —— 它锁的是**覆盖面与空间组织**，
           而这一轮改的全是**形态**（行高 · 选中态 · 分区怎么分 · 图标 · 槽位）。
           唯一动到那一段点名清单的是「到期徽章」和「.hint / .badge 分槽」两件，
           而这两件正是 **D-457 明文要求恢复**的（见下 4 / 5），不是分组名回潮。

      1 · 这一页解决什么问题？
          「我的东西长什么样，我现在在哪一层」。D-475 删掉版图之后，
          **全 Windows 没有第二处**回答得了这个问题。

      2 · 最重要的任务？
          **点开一讲**。其余（改名 / 移动 / 归档 / 新建）都是它路上的动作。

      3 · 哪些信息最重要？
          ① 树的**层级关系**（谁在谁底下、展开到哪一层）；
          ② **到期数**——「今天有没有欠账」；③ **待推数**——「数据推上去了没有」。
          ★ ②③ 都是 Badge：数出来的事实，0 的时候不显示（NOTIFICATION §一）。

      4 · 哪些操作最容易被发现？
          **侧栏一颗 Primary 都不放**（IX-16）：它整条是 Navigation ＋ Icon。
          最该被发现的是「展开」和「⋮」——
          ★ 展开箭头搬到了**行首**（NAV-03「行名只导航 · 行首 ▸/▾ 只折叠」）。
            它原来在行尾，紧挨着 ⋮ —— 那正是 LT §七 第 4 条禁的「`›` 与 `⋮` 并排」。
          ★ ⋮ 从「6px 宽的两个字符」变成真正的 Icon Button：28 的命中区、
            hover 有面、`aria-label`「更多」（TM-67）。**常驻可见只是淡**这一条不动
            —— 看不见的入口等于没有入口（I-071 / D-457）。

      5 · 哪些该降权重 / 折叠？
          ★ **快捷键提示**（Ctrl K）降成 hover 才出的 `.hint`；
            **计数**升成常驻的 `.badge`。D-456 N-1 原话：
            「计数是状态，快捷键是提示」—— 它们原来共用 `.kb` 一个槽，长得一模一样。
          ★ 两个 Badge 的**心跳分开**（D-457）：待推那个被 `syncOn` 挡着，
            到期那个**不挡** —— 没配同步的人照样会欠账。

      6 · 哪些结构是历史遗留？
          · **三条 `.sep` 分隔线** —— DS §10.2「分区 = 双语头 ＋ 上方 ≥24 留白，
            **不画分隔线**」。线一去，四个区反而更清楚了：它们本来就是靠留白分的。
          · **两种分区头**：Vault 是双语头，「项目」「置顶」却是 10px 大写小标签。
            同一条侧栏上没有理由有两种。现在都是双语头（Projects / 我的项目 ·
            Pinned / 置顶），TM-03 / TM-49。
          · **整行铺底色的选中态** → DS-Q17：把细线图标放进一个淡水色圆角方块，
            它同时解决「选中」和「命中区」两件事。
          · **行高**：一级入口 6px 内边距（≈26 高）→ 导航行 **48**；
            树里的行 → 数据行 **36**（LT §三 度量 · DS-Q22）。
          · **18px 的 ⋮ / 9px 的 caret** → 侧栏图标 **16** · caret **12**（DS-Q8）。

      ★ 本轮**没做**的两件，都写进了派单 §六：
        ① LT-B1 极窄档（<1100）收成 56 图标条 —— `.side.rail` 那条媒体查询今天
           **没有人给 `.side` 加过 `rail` 类**，是死规则。让它活起来只差一行，
           但「56 宽的时候这棵树怎么办」是产品设计，不是我该替他定的（U-001 覆盖面不减）。
        ② 📌 还是 emoji。换成图形要往 `core/icons.ts` 加一枚几何，
           而几何是**两端一起画**的（D-410）—— 那是另一张派单。
    -->
    <aside class="side" class:railopen={railOpen}>
      <!--
        ★ LT-B1 那颗开关 —— **只在 <1100 存在**（CSS display:none）。
          它是 Icon Button（BUTTON §六③ 允许的三种之一），有 aria-label ＋ tooltip。
      -->
      <button
        class="railtoggle"
        data-testid="rail-toggle"
        aria-label={railOpen ? '收起侧栏' : '展开侧栏'}
        title={railOpen ? '收起侧栏' : '展开侧栏'}
        onclick={() => (railOpen = !railOpen)}
      >
        <Ic n={railOpen ? 'back' : 'project'} s={16} />
      </button>
      <div class="scroll">
        <!--
          ★ T-4.9 · 项目行只写一份。置顶区与普通项目区渲染的是同一段 ——
            抄第二份就等于以后每改一次行为都要记得改两处，那是这个项目最贵的那类账。
        -->
        <!--
          ★★ **树上没有折叠箭头，这是有意的**（使用者 2026-09-09 直接裁：
             「把项目行 / 单元行上那个折叠符号删掉，折叠功能保留」）。

          · 点这一行照旧展开 / 收起 —— **功能一点没少**，少的是那个符号。
          · Android 侧先做的（Atlas 项目树），他看过真机截图后确认；两端同一件事。

          ★ **代价他已经知道并接受**：屏上没有任何记号告诉他「这一行可以展开」，
            得点一下才知道。Nyx-UI-Android 会话动手前当面提过，他的回答是「真的删掉」。
            **这是明码的取舍，不是遗漏 —— 别当 bug 补回去。**
          ★ 连带：`DESIGN_SYSTEM` §17.1 第 06 条「折叠状态要看得见」在这两种行上不再成立，
            NAV-03 的「行首 ▸/▾ 只折叠」也随之作废（D-469 之后这两种行本来就不导航，
            「导航与展开分开」在它们身上没有可分的东西）。
          ★ `class:open` **留着**：它不再画任何东西，但 `scripts/ui-walk.mjs` 的
            `ensureOpen` 靠读这个类判断「已经开着就别再点」。删了它走查会从第 2 屏开始全倒。
        -->
        {#snippet projectRow(p: TreeProject)}
          <div
            class="nv"
            class:open={isOpen(`p${p.id}`)}
            class:dragover={dropOn === `project:${p.id}`}
            role="button"
            tabindex="0"
            draggable="true"
            data-testid="nav-toggle-project-{p.id}"
            ondragstart={(e) => onDragStart(e, { kind: 'project', id: p.id, parent: null })}
            ondragover={(e) => onDragOver(e, { kind: 'project', id: p.id, parent: null })}
            ondragleave={() => (dropOn = null)}
            ondragend={() => ((dragging = null), (dropOn = null))}
            ondrop={(e) => onDrop(e, { kind: 'project', id: p.id, parent: null })}
            oncontextmenu={(e) => openMenu(e, 'project', p.id, p.name)}
            onclick={() => toggle(`p${p.id}`)}
            onkeydown={key(() => toggle(`p${p.id}`))}
          >
            <!--
              ══ 项目标识 · 重做（使用者 2026-09-14 第七条）════════════
              他的原话：「Project 旁边目前使用的紫色小方块需要重新设计……
              和 Nyx 整体的视觉基调不太搭配……旁边置顶的小标识也重新设计一下」

              ── 先量了一下，两枚记号各自坏在哪 ──────────────
              ① 紫方块（.pdot，7×7，background 取的是 p.color）——
                 他库里**每一个项目的 color 都是 #6d5efc**，那是迁移 v01 里写死的
                 schema 默认值，而软件里**从来没有改颜色的入口**。
                 于是这枚记号既不区分项目（每行一模一样），颜色又不在令牌盘里
                 （Nyx 主色是 aqua #38A8B4）—— 一块**不带信息的异色**。
              ② 那枚图钉 emoji 是全彩的，是整条侧边栏里唯一一处非调色板的饱和色；
                 而它所在的行本就在「Pinned / 置顶」那一区里（T-4.9 后加的）——
                 同一件事说了两遍，其中一遍还是用别人家的语言说的。
              ★ 2026-09-04 加它的理由（D-457：加回之前先找出当初为什么）是
                「置顶之后行上没有任何记号」—— 那个需求**仍然成立**，
                只是现在由本来那枚记号自己换一档来满足，不再多摆一枚图。

              ── 现在是一枚记号的两档 ───────────────────────
              普通项目 = **星核**（nyx-core）· 置顶的 = **星亮起来**（nyx-star，核 + 四芒）。
              ★ 这不是新发明的语法：DS §4.3 对这枚星本来就定了这两档
                （core/icons.ts 原话：「ON = 核实心 + 四芒亮起　OFF = 只有核、空心」），
                同一天重做的托盘图标用的也是它 —— 一套语法，两处用。
              ★ 小圆点留给单元 / 讲次（.sb .d），项目用星 —— 层级一眼分得出。
              ★ p.color **没删**，只是不再拿它上色：哪天真有了选颜色的入口，
                把这里换成 style 上个 color 就活了。库里那一列一个字没动（D-216）。
              ★ 它**不接点击**：置顶 / 取消置顶只有 ⋮ 菜单一个入口（一件事一个入口）。
            -->
            <span
              class="pmark"
              class:on={p.pinned}
              data-testid={p.pinned ? 'pin-' + p.id : undefined}
              title={p.pinned ? '已置顶 —— 在 ⋮ 菜单里可以取消' : undefined}
              ><Ic n={p.pinned ? 'star' : 'core'} s={13} /></span
            ><span class="nm-t">{p.name}</span>
            <!-- I-033 · 每一级都要有「＋」和「•••」，而且不止一个入口 -->
            <span
              class="add"
              role="button"
              tabindex="0"
              title="更多"
              aria-label="更多"
              data-testid="menu-project-{p.id}"
              onclick={(e) => openMenu(e, 'project', p.id, p.name)}
              onkeydown={key(() => {})}><Ic n="more" s={16} /></span
            >
          </div>

          <div class="grp" class:show={isOpen(`p${p.id}`)}>
            <!--
              ★ 8.1 · 「📊 项目总览」这一行去掉了（使用者 2026-08-10）。
              「点击项目直接进入项目内容界面。」
              多一行只为了进同一个页面 —— 而点项目名本来就该进去。
              入口在 `onDragStart` 上面那个 nv 的 onclick 里：
              展开 / 收起之外，**同时**把 nav 切到这个项目。
            -->
            {#each p.units as u (u.id)}
              <div
                class="sb"
                class:open={isOpen(`u${u.id}`)}
                class:dragover={dropOn === `unit:${u.id}`}
                role="button"
                tabindex="0"
                draggable="true"
                data-testid="nav-toggle-unit-{u.id}"
                ondragstart={(e) => onDragStart(e, { kind: 'unit', id: u.id, parent: p.id })}
                ondragover={(e) => onDragOver(e, { kind: 'unit', id: u.id, parent: p.id })}
                ondragleave={() => (dropOn = null)}
                ondragend={() => ((dragging = null), (dropOn = null))}
                ondrop={(e) => onDrop(e, { kind: 'unit', id: u.id, parent: p.id })}
                oncontextmenu={(e) => openMenu(e, 'unit', u.id, u.name)}
                onclick={() => toggle(`u${u.id}`)}
                onkeydown={key(() => toggle(`u${u.id}`))}
              >
                <span class="d"></span><span class="nm-t">{u.name}</span>
                <span
                  class="add"
                  role="button"
                  tabindex="0"
                  title="更多"
                  aria-label="更多"
                  data-testid="menu-unit-{u.id}"
                  onclick={(e) => openMenu(e, 'unit', u.id, u.name)}
                  onkeydown={key(() => {})}><Ic n="more" s={16} /></span
                >
              </div>
              <div class="grp" class:show={isOpen(`u${u.id}`)}>
                {#each u.lectures as l (l.id)}
                  <div
                    class="sb sb2"
                    class:on={nav.k === 'lecture' && nav.id === l.id}
                    class:dragover={dropOn === `lecture:${l.id}`}
                    role="button"
                    tabindex="0"
                    draggable="true"
                    data-testid="nav-lecture-{l.id}"
                    ondragstart={(e) => onDragStart(e, { kind: 'lecture', id: l.id, parent: u.id })}
                    ondragover={(e) => onDragOver(e, { kind: 'lecture', id: l.id, parent: u.id })}
                    ondragleave={() => (dropOn = null)}
                    ondragend={() => ((dragging = null), (dropOn = null))}
                    ondrop={(e) => onDrop(e, { kind: 'lecture', id: l.id, parent: u.id })}
                    oncontextmenu={(e) => openMenu(e, 'lecture', l.id, l.name)}
                    onclick={() => go({ k: 'lecture', id: l.id })}
                    onkeydown={key(() => go({ k: 'lecture', id: l.id }))}
                  >
                    <span class="d"></span><span class="nm-t">{l.name}</span>
                    {#if l.status === 'review'}<span class="due">待审阅</span>{/if}
                    {#if l.status === 'silent'}<span class="due">{SILENCE_FILTER_NAME}</span>{/if}
                    <span
                      class="add"
                      role="button"
                      tabindex="0"
                      title="更多"
                      aria-label="更多"
                      data-testid="menu-lecture-{l.id}"
                      onclick={(e) => openMenu(e, 'lecture', l.id, l.name)}
                      onkeydown={key(() => {})}><Ic n="more" s={16} /></span
                    >
                  </div>
                {/each}
                {#if u.lectures.length === 0}
                  <div class="sb sb2 dim" style="font-size:var(--fz-body-ui)">
                    <span class="d"></span>还没有 Lecture · 右键新建
                  </div>
                {/if}
              </div>
            {/each}
            {#if p.units.length === 0}
              <div class="sb dim" style="font-size:var(--fz-body-ui)">
                <span class="d"></span>还没有单元 · 右键新建
              </div>
            {/if}
          </div>
        {/snippet}

        <!-- ══ ① 顶部固定区 · Nyx 核心入口（D-R19）══
             项目再多也不下移。条目一个不减，只是从底部搬上来。 -->
        <div class="side-fixed" data-testid="nav-zone-top">
        <div
          class="nv"
          role="button"
          tabindex="0"
          data-testid="nav-search"
          onclick={() => (searching = true)}
          onkeydown={key(() => (searching = true))}
        >
          <!-- ★ I-170 同批：这台是 Windows，写 `⌘K` 是抄来的 Mac 说法。
               改成 `Ctrl K` —— 提示必须说这台机器上真的能按的那个键。 -->
          <span class="ic"><Ic n="search" s={16} /></span><span class="nm-t">搜索</span><span class="hint">Ctrl K</span>
        </div>
        <div
          class="nv"
          class:on={nav.k === 'home'}
          role="button"
          tabindex="0"
          data-testid="nav-home"
          onclick={() => enter({ k: 'home' })}
          onkeydown={key(() => enter({ k: 'home' }))}
        >
          <span class="ic"><Ic n="study" s={16} /></span><span class="nm-t">Today</span>
          <!-- Badge = 数出来的事实；**0 时不显示**（NOTIFICATION §一），不是显示 0 -->
          {#if dueLectures > 0}
            <span class="badge" data-testid="due-badge" title="{dueLectures} 个 Lecture 已到期"
              >{dueLectures}</span
            >
          {/if}
        </div>

        <div
          class="nv"
          role="button"
          tabindex="0"
          class:on={nav.k === 'files'}
          data-testid="nav-files"
          onclick={() => enter({ k: 'files' })}
          onkeydown={key(() => enter({ k: 'files' }))}
        >
          <span class="ic"><Ic n="lecture" s={16} /></span><span class="nm-t">文件学习</span>
        </div>

        <!--
          ★ 「分析报告」这一行**撤了**（使用者 2026-09-09 原话：「删，分析报告入口只在首页显示」）。

          它是 T-4.11 / D-R29 加的（「Windows 端的分析报告拥有一个独立、明确的界面」），
          而 U-002 又裁「报告归首页、侧栏不留一级入口」—— 两条并存了一阵子，
          `NAVIGATION_IA` §1.1 那一行早就标着 `✂ 撤掉`，只是源码没跟上。现在跟上了。

          ★ 页面**一点没删**：路由 `nav.k === 'report'` 还在，入口是 Today 底下那条横条
            （`home-report`），而且按 NAV-04 改成**压栈**进去 —— 于是报告页上有一条
            「‹ 返回 Today」。撤掉侧栏那一行之后，这条返回就是他唯一走得回来的路，
            所以它比以前更要紧。
        -->
        </div><!-- /① 顶部固定 -->

        {#if tree.k === 'error'}
          <div class="sb" style="color:var(--red)">侧边栏加载失败</div>
        {:else if tree.k === 'ok'}
          <!-- ══ ② 置顶区（D-R19）══
               `projects.pinned` 与 ⋮ 菜单的「置顶」都是现成的，这里只是给它们一块地方。
               一个都没置顶时整块不出现 —— 空的分区头是噪音。 -->
          {#if pinnedProjects.length > 0}
            <div class="side-fixed" data-testid="nav-zone-pinned">
              <div class="secthead" data-testid="nav-pinned-head">
                <span class="en">Pinned</span><span class="zh">置顶</span>
              </div>
              <div class="pinned" data-testid="pinned-area">
                {#each pinnedProjects as p (p.id)}{@render projectRow(p)}{/each}
              </div>
            </div>
          {/if}

          <!-- ══ ③ 项目区 ══ 标题固定，列表是**唯一**独立滚动的那一块 -->
          <div class="side-fixed" data-testid="nav-zone-projects">
        <!-- I-032 · 这个「＋」以前是死的 -->
        <!-- I-086 · 分区标题上的 ＋ 必须留着。
             I-071 去掉的是**每一行**上的 ＋（名字一长就和 ⋮ 挤成一团），
             但项目没有上级可以右键 —— 一并去掉之后，新建项目这条路整个没了。
             标题上这个 ＋ 不跟任何名字抢位置，留着没有副作用。 -->
        <div class="secthead" data-testid="nav-projects-head">
          <span class="en">Projects</span><span class="zh">我的项目</span>
          <span
            class="add"
            role="button"
            tabindex="0"
            title="新建项目"
            aria-label="新建项目"
            data-testid="add-project"
            onclick={() => make('project', 0)}
            onkeydown={key(() => make('project', 0))}><Ic n="plus" s={16} /></span
          >
        </div>
        {#if treeNote}
          <div class="sb" data-testid="tree-note" style="display:block;color:var(--green)">
            {treeNote}
          </div>
        {/if}
        <!--
          ★ D-469 · 「没做成」单独一个位（H-4）。
            这两个动作（随时认读 / 练习 · 导出笔记）原来长在项目页上，
            失败时那一页给的是一个错误框；搬进这棵树之后要是塞回上面那条绿字，
            他会把「导出失败」看成「导出好了」。
        -->
        {#if treeErr}
          <div class="errbox" data-testid="tree-error" style="margin:6px 8px">
            <div class="h">没做成</div>
            <div style="white-space:pre-wrap">{treeErr}</div>
            <div style="margin-top:8px">
              <button class="btn sm" data-testid="tree-error-ok" onclick={() => (treeErr = null)}>知道了</button>
            </div>
          </div>
        {/if}
          </div>
          <!-- I-035 · 项目单独一块可滚动区域，项目多了不挤占下面的固定入口 -->
          <!--
            ★ D-484 · B-4「材料按三层放」。标记挂在**这棵树上**，不是上面那个分区标题 ——
              第一版挂错了，拍出来一看：洞挖在「Projects」那一行上，
              而他要看的三层结构在下面，正好被框盖住。
          -->
          <div class="projects" data-testid="project-area" data-guide="sidebar-tree">
            {#each plainProjects as p (p.id)}{@render projectRow(p)}{/each}
            {#if projects.length === 0}
              <div class="sb dim" style="font-size:var(--fz-body-ui)">
                <span class="d"></span>还没有项目 · 点上面的 ＋
              </div>
            {/if}
          </div>
        {/if}

        <!--
          ══ Vault 那一组 · 2026-09-09 从顶部固定区搬到这里 ══════════════
          使用者当面裁的三条：「文件学习移到 Today 的下面」「Projects 往上移动，
          适当扩大 Projects 区域」「导航栏间距统一」。把 Vault 整块搬下来一次答两条 ——
          **量到的（本人的 .demo，1600×1000）**：树的起点 y≈400 → **221**（上面只剩三行），
          高 **476px**；四个组间距全部 16；外层没跟着滑（946 = 946）。
          树是那块 flex:1 吃掉剩余高度的区，起点上去了、可视行数就上去了。
          ★ 为什么是 Vault 下去、不是 Projects 上来：Vault 这四行**是固定的四项、
            永远不会长**；项目树是这条侧栏上**唯一会长的东西**。
            会长的放中间，等于把唯一会长的那块夹在两堆不会长的中间。
          ★ 动的是**顺序**，覆盖面一条没减（D-456 / U-001）；
            四个区的 testid 一个没改，这是**第五个**区。
        -->
        <div class="side-fixed" data-testid="nav-zone-vault">
        <!--
          ★ I-173（U-004 / B13）· 这一行**长得像能点，其实点不动**：
            它有 `.nv` 的 hover 底色、有一枚 caret，却没有 role / tabindex / onclick ——
            caret 纯装饰。DS §7.1 S4：「能点的和不能点的必须一眼分得出」。
          ★ 改法不是给它接上点击（三个库本来就一直展开，没有「收起」这回事），
            而是**降级成分区标题**：去掉 caret、去掉 hover、去掉图标位，
            按 TM-05 用双语头（英文在主位，中文副题，DS §10.1 / UX-Q2）。
        -->
        <div class="secthead" data-testid="nav-vault-head">
          <span class="en">Vault</span><span class="zh">全部知识点</span>
        </div>
        <div class="grp show">
          <div
            class="sb"
            class:on={nav.k === 'hard'}
            role="button"
            tabindex="0"
            data-testid="nav-hard"
            onclick={() => enter({ k: 'hard' })}
            onkeydown={key(() => enter({ k: 'hard' }))}
          >
            <span class="d" style="background:var(--amber)"></span>攻坚区
          </div>
          {#each [['all', '全部'], ['upload', '我的收集'], ['silent', SILENCE_FILTER_NAME]] as [s, label] (s)}
            <div
              class="sb"
              class:on={nav.k === 'lib' && nav.scope === s}
              role="button"
              tabindex="0"
              data-testid="nav-lib-{s}"
              onclick={() => enter({ k: 'lib', scope: s as 'all' | 'upload' | 'silent' })}
              onkeydown={key(() => enter({ k: 'lib', scope: s as 'all' | 'upload' | 'silent' }))}
            >
              <span class="d"></span>{label}
            </div>
          {/each}
        </div>
        </div>

        <!-- ══ ④ 底部固定区 · 系统级（D-R19）══
             同步 · 垃圾箱 · 设置：都不产生学习内容，是数据管道 / 后悔药 / 配置。
             「文件学习」不在这里 —— 它会产生内容，归 ① 的工具位（见报告里的功能审计）。 -->
      </div><!-- /.scroll -->

      <!--
        ★★ ④ 底部固定 —— **在 `.scroll` 外面**（2026-09-13）。
        原来它在滚动区**里面**，而那个盒子是 `overflow:hidden`：
        项目区把余量吃到 0 之后，任何多出来的一行都从底部剪掉 ——
        窗口矮一点 Settings 就没了，一点同步连回收站也没了（使用者报的第 2 / 4 条）。
        挪出来之后它压根不在会被剪的那个盒子里：项目再多、窗口再矮、
        同步再多几行，都动不到它。原来那句「不会挤出去」这才是真的。
      -->
      <div class="side-fixed side-bottom" data-testid="nav-zone-bottom">
        <!-- I-042 · 一键同步：常驻一个按钮，不用翻进设置页 -->
        {#if syncOn}
          <div
            class="nv"
            role="button"
            tabindex="0"
            data-testid="nav-sync"
            title="同步一次"
            onclick={quickSync}
            onkeydown={key(quickSync)}
          >
            <span class="ic"><Ic n="sync" s={16} /></span><span class="nm-t">{syncing ? '同步中…' : '同步'}</span>
            <!-- ★ B6 · 第 1–2 次失败只在入口旁留一枚**静态标记**（不动、不闪、不催）-->
            {#if syncFails > 0 && syncFails < 3}
              <span class="failmark" data-testid="sync-failmark" title="上一次没同步成 —— 多半是网络抖了一下"
                >!</span
              >
            {/if}
            {#if syncPending > 0}<span class="badge" data-testid="sync-badge">{syncPending}</span>{/if}
          </div>
          {#if syncMsg}
            <div class="sb" data-testid="nav-sync-note" style="display:block">{syncMsg}</div>
          {/if}
        {/if}

        <div
          class="nv"
          role="button"
          tabindex="0"
          data-testid="nav-trash"
          class:on={nav.k === 'trash'}
          onclick={() => enter({ k: 'trash' })}
          onkeydown={key(() => enter({ k: 'trash' }))}
        >
          <span class="ic"><Ic n="delete" s={16} /></span><span class="nm-t">回收站</span>
        </div>
        <div
          class="nv"
          class:on={nav.k === 'settings'}
          role="button"
          tabindex="0"
          data-testid="nav-settings"
          onclick={() => enter({ k: 'settings' })}
          onkeydown={key(() => enter({ k: 'settings' }))}
        >
          <span class="ic"><Ic n="settings" s={16} /></span><span class="nm-t">Settings</span>
        </div>
        </div><!-- /④ 底部固定：项目再多也不会把这几行挤出去 -->
    </aside>

    <!-- ══ 主区 ══ -->
    <main class="main">
      <!--
        ★ B6 / NT-Q2 · 连续失败 ≥3 次才升级成 Banner。
          Banner 的规矩（NOTIFICATION §一）：在内容区顶部、**不盖内容**、
          **不能手动关**（关了问题还在）、带一颗按钮去修。条件消失它自己走。
      -->
      {#if syncFails >= 3}
        <div class="banner" data-testid="sync-banner">
          <span>同步已经连续失败 {syncFails} 次 —— 这不像网络抖动了。</span>
          <span class="sp"></span>
          <button class="btn sm" data-testid="sync-banner-go" onclick={() => enter({ k: 'settings' })}
            >去设置</button
          >
        </div>
      {/if}
      <section class="view on">
        {#if backTo !== null}
          <!-- D-451 · 有来路才有它。看得见 = 你在第二层；看不见 = 你在根上 -->
          <span
            class="bk"
            role="button"
            tabindex="0"
            data-testid="global-back"
            title="返回上一层（也可以按 Alt+← 或鼠标侧键）"
            onclick={goBack}
            onkeydown={key(goBack)}><Ic n="back" s={16} /> 返回 · {backTo}</span
          >
        {/if}
        {#if nav.k === 'home'}
          {#if tree.k === 'error'}
            <div class="errbox" data-testid="tree-error">
              <div class="h">读不出你的项目</div>
              <div>{tree.message}</div>
              <div style="margin-top:12px"><button class="btn sm" onclick={loadTree}>重试</button></div>
            </div>
          {:else if tree.k === 'loading'}
            <div class="card blk"><Skel rows={3} testid="tree-skel" /></div>
          {:else if allLectures.length === 0}
            <!-- D-184 第①类空状态：给方向和按钮 -->
            <div class="vh"><h1>还没开始</h1></div>
            {#if startError}
              <div class="errbox" data-testid="start-error">
                <div class="h">没能建起来</div>
                <div>{startError}</div>
              </div>
            {/if}
            <div class="drop" data-testid="home-start">
              <div class="i"><Ic n="fix" s={26} /></div>
              <h3>贴一段英文开始</h3>
              <p>先贴，贴完再问它归到哪个项目 —— 不用先想好名字</p>
              <div class="bs">
                <button
                  class="btn pri"
                  disabled={starting}
                  data-testid="home-start-btn"
                  data-guide="today-paste"
                  onclick={startPasting}
                  >{starting ? '正在准备…' : '开始'}</button
                >
              </div>
              <div class="me"><span>项目 › 单元 › lecture 会先用默认名，随时可改</span></div>
            </div>

          {:else}
            <Home
              lectures={allLectures}
              onopen={(id) => go({ k: 'lecture', id })}
              onstart={startPasting}
              onpractice={(ids) =>
                (overlay = { kind: 'practice', scope: { kind: 'today', lectureIds: ids } })}
              onreading={() => (overlay = { kind: 'reading', lectureId: null })}
              onhard={() => enter({ k: 'hard' })}
              ongotoSettings={() => enter({ k: 'settings' })}
              ongotoReport={() => {
                /* ★ NAV-04 · 压栈不清栈：报告现在只有这一个入口，
                   进去了要走得回来（报告页上那条「‹ 返回 Today」就是这么来的）。 */
                go({ k: 'report' })
              }}
            />
            <!-- I-057 · 「全部 lecture」整块取消。
                 侧边栏的项目树已经把同样的东西列了一遍，而且分了层；
                 首页再平铺一次，反而把「今天该做什么」推到了屏幕外。 -->
                      {/if}
        {:else if nav.k === 'item'}
          <!-- D-071 ·「‹ 返回」回**上一个位置**，不是写死回首页 -->
          <ItemDetail
            itemId={nav.id}
            onback={goBack}
            ongotoSettings={() => enter({ k: 'settings' })}
            onreading={(ids) =>
              (overlay = {
                kind: 'reading',
                lectureId: null,
                test: { itemIds: ids, shuffle: false }
              })}
            onpractice={(ids) =>
              (overlay = { kind: 'practice', scope: { kind: 'items', itemIds: ids } })}
          />
        {:else if nav.k === 'trash'}
          <Trash onchanged={loadTree} />
        {:else if nav.k === 'files'}
          <FileStudy
            oncurrent={(id) => (fileLecture = id)}
            onopen={(id) => go({ k: 'item', id })}
            tree={tree.k === 'ok' ? tree.data : []}
            ongotoSettings={() => enter({ k: 'settings' })}
          />
        {:else if nav.k === 'lib'}
          <!--
            ══ SC-06 · 列表 ‖ 详情（D-477 · LT-T1）══════════════════════════

            ★★ 这一屏最大的一处：**词条详情从「跳走的一页」变成右栏**。
              以前看三条是「点 → 返回 → 点 → 返回 → 点 → 返回」六下，
              现在是**点三下** —— 列表一直在，选中的那一行亮着。
            ★ 选中**不压栈**（NAV-02）：它是「换看的对象」，不是下钻一层。
            ★ `nav.k === 'item'` 那一支**一个字没删** —— 搜索 · Lecture · 攻坚区 ·
              文件学习四处还从那儿进；它们各有各的屏号，不在本屏。
            ★ 断点（LT-B）在样式里：≥1440 右栏 360 就地推开 · 1280–1439 是 320 ·
              <1280 改成**覆盖式**（Esc 关，见上面的 registerEsc）。
          -->
          <div class="lt-list" class:has-aside={nav.sel !== undefined} data-testid="vault-split">
            <div class="lt-main">
              <!-- T-4.10 · onlecture：「还没分析」的状态片与表头计数点下去，进它所在的那一讲 -->
              <Library
                scope={nav.scope}
                selectedId={nav.sel}
                onopen={selectItem}
                onlecture={(id) => go({ k: 'lecture', id })}
                onpractice={(ids) =>
                  (overlay = { kind: 'practice', scope: { kind: 'items', itemIds: ids } })}
                onreading={(ids) =>
                  (overlay = {
                    kind: 'reading',
                    lectureId: null,
                    test: { itemIds: ids, shuffle: false }
                  })}
              />
            </div>
            {#if nav.sel !== undefined}
              <aside class="lt-aside" data-testid="vault-aside">
                <!-- 关掉右栏 · Icon Button（BUTTON §六③）。Esc 也关得掉。 -->
                <button
                  class="aclose"
                  data-testid="aside-close"
                  aria-label="关掉这一条"
                  title="关掉这一条（Esc）"
                  onclick={closeItem}><Ic n="close" s={16} /></button
                >
                <ItemDetail
                  itemId={nav.sel}
                  onback={closeItem}
                  ongotoSettings={() => enter({ k: 'settings' })}
                  onreading={(ids) =>
                    (overlay = {
                      kind: 'reading',
                      lectureId: null,
                      test: { itemIds: ids, shuffle: false }
                    })}
                  onpractice={(ids) =>
                    (overlay = { kind: 'practice', scope: { kind: 'items', itemIds: ids } })}
                />
              </aside>
            {/if}
          </div>
        {:else if nav.k === 'hard'}
          <HardZone
            onopen={(id) => go({ k: 'item', id })}
            onpractice={() => (overlay = { kind: 'practice', scope: { kind: 'hard' } })}
            onpracticeItems={(ids) =>
              (overlay = { kind: 'practice', scope: { kind: 'items', itemIds: ids } })}
            onreading={(ids) =>
              (overlay = {
                kind: 'reading',
                lectureId: null,
                test: { itemIds: ids, shuffle: false }
              })}
          />
        {:else if nav.k === 'lecture'}
          <Workbench
            lectureId={nav.id}
            ontest={(ids, line) => (testDlg = { name: '这个 Lecture', ids, line })}
            ontestItems={(ids) =>
              (overlay = {
                kind: 'reading',
                lectureId: null,
                test: { itemIds: ids, shuffle: false }
              })}
            onpracticeItems={(ids) =>
              (overlay = { kind: 'practice', scope: { kind: 'items', itemIds: ids } })}
            onchanged={loadTree}
            ongotoSettings={() => enter({ k: 'settings' })}
            onopenitem={(id) =>
              go({ k: 'item', id })}
            ongotopath={(kind) => revealPath(nav.k === 'lecture' ? nav.id : 0, kind)}
            onstudy={(kind) => {
              const id = nav.k === 'lecture' ? nav.id : 0
              overlay =
                kind === 'reading'
                  ? { kind: 'reading', lectureId: id }
                  : { kind: 'practice', scope: { kind: 'lecture', lectureIds: [id] } }
            }}
          />
        {:else if nav.k === 'report'}
          <Report />
        {:else if nav.k === 'settings'}
          <Settings
            onreplayOnboarding={() => {
              /**
               * ★ 先清记号再开 —— 顺序反过来的话，他看完这一遍点「开始使用」，
               *   `finishOnboarding` 又把记号写回去，看着没问题；
               *   但中途关掉软件就会留下「记号已清、引导没看完」，下次启动又弹一次。
               *   清在前面，结束在后面，两条路都收敛到同一个状态。
               */
              window.nyx.ui.set(ONBOARDING_KEY, '').catch(() => {})
              onboarding = true
            }}
          />
        {/if}
      </section>
    </main>
  </div>

  <!-- R-003 · 全局右键。一个组件 + 事件委托，不逐处写（D-200） -->
  <!-- I-062 · 把当前这一讲交给右键菜单，好让它有「收进本 lecture」这一项 -->
  <Capture
    tree={tree.k === 'ok' ? tree.data : []}
    currentLecture={fileLecture ?? navLecture}
  />

  {#if searching}
    <Search
      bind:q={searchQ}
      onclose={() => (searching = false)}
      onitem={(id) => go({ k: 'item', id })}
      onlecture={(id) => go({ k: 'lecture', id })}
      onplace={(kind, id) => revealNode(kind, id)}
      onfiles={() => go({ k: 'files' })}
    />
  {/if}

  <!-- ══ 全屏浮层 · 练习 ══
       放在 .win 里面：总原型的 .ov 是 position:absolute，靠 .win 做定位参照。
       挪到外面会脱离参照，浮层就不盖在窗口上了。 -->
  {#if overlay?.kind === 'reading'}
    <Reading
      lectureId={overlay.lectureId}
      test={overlay.test ?? null}
      onclose={() => (overlay = null)}
    />
  {:else if overlay?.kind === 'practice'}
    <Practice
      scope={overlay.scope}
      onclose={() => (overlay = null)}
      ongotoSettings={() => {
        overlay = null
        enter({ k: 'settings' })
      }}
      ongotoReading={() => (overlay = { kind: 'reading', lectureId: null })}
    />
  {/if}
</div>

<!-- I-048 · 三点菜单是**浮在上面的下拉框**，用总原型自带的 .pm，
     不再把侧边栏撑开一整块 -->
{#if menu}
  {@const m = menu}
  <!-- ★ I-092 · 点别处要能关掉。
       以前这层遮罩写的是 `class="ovl on"` —— **`.ovl` 这个 class 在总原型的 CSS 里
       根本不存在**，于是它没有尺寸、盖不住任何东西，点哪儿菜单都不走
       （使用者：「右键出来的下拉框，随便点击其他地方它不消失」）。
       改成和讲次工作台那个菜单同一套：写死的 fixed 全屏遮罩，右键和 Esc 也都收。 -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    style="position:fixed;inset:0;z-index:499;background:transparent"
    data-testid="tree-menu-scrim"
    oncontextmenu={(e) => {
      e.preventDefault()
      menu = null
      moving = null
    }}
    onclick={() => ((menu = null), (moving = null))}
  ></div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="pm on"
    style="left:{m.x}px;top:{m.y}px"
    role="menu"
    tabindex="-1"
    data-testid="tree-menu"
    onclick={(e) => e.stopPropagation()}
  >
    {#if renaming}
      <input class="tin2" style="margin:4px 6px;width:calc(100% - 12px)" data-testid="tree-rename-input" bind:value={menu.name} />
      <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-rename-go" onclick={renameNode}><Ic n="check" s={16} /> 就叫这个</div>
      <div class="mi" role="menuitem" tabindex="-1" onclick={() => (renaming = false)}>← 返回</div>
    {:else if moving && m.kind !== 'project'}
      <!-- I-085 · 一级一级选，和文件学习页那个路径弹窗同一套走法 -->
      <div class="cap" style="padding:4px 11px">
        {#if m.kind === 'unit'}移到哪个项目{:else if !moving.p}① 先选项目{:else}② 选单元{/if}
      </div>
      {#if m.kind === 'unit' || !moving.p}
        {#each moveProjects as t (t.id)}
          <div
            class="mi"
            role="menuitem"
            tabindex="-1"
            data-testid="move-to-{t.id}"
            onclick={() => (m.kind === 'unit' ? moveNode(m, t.id) : (moving = { p: t.id }))}
          >
            {t.label}
          </div>
        {/each}
      {:else}
        {@const units = moveUnits(moving.p)}
        {#if units.length === 0}
          <div class="cp" style="text-transform:none;letter-spacing:0;white-space:normal;max-width:200px">
            这个项目下面还没有单元 —— 先在它上面右键建一个。
          </div>
        {:else}
          {#each units as t (t.id)}
            <div
              class="mi"
              role="menuitem"
              tabindex="-1"
              data-testid="move-to-{t.id}"
              onclick={() => moveNode(m, t.id)}
            >
              {t.label}
            </div>
          {/each}
        {/if}
        <div class="mi" role="menuitem" tabindex="-1" onclick={() => (moving = { p: null })}>← 换个项目</div>
      {/if}
      <div class="mi" role="menuitem" tabindex="-1" onclick={() => (moving = null)}>← 返回</div>
    {:else}
      <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-rename" onclick={() => (renaming = true)}>改名</div>
      {#if m.kind === 'project'}
        <div class="mi" role="menuitem" tabindex="-1" class:ck2={pinnedOf(m.id)} data-testid="tree-pin" onclick={() => pinNode(m.id)}>
          <span class="mck"><Ic n="check" s={12} /></span>{pinnedOf(m.id) ? '取消置顶' : '置顶'}
        </div>
      {/if}
      <div class="mi" role="menuitem" tabindex="-1" class:ck2={silentOf(m)} data-testid="tree-archive" onclick={() => archiveNode(m)}>
        <span class="mck"><Ic n="check" s={12} /></span>{silenceScopeAction(
          silentOf(m),
          m.kind === 'project' ? '项目' : m.kind === 'unit' ? '单元' : 'Lecture'
        )}
      </div>
      {#if m.kind === 'lecture'}
        <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-unread" onclick={() => unreadNode(m.id)}>打回待审阅</div>
        <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-fork" onclick={() => forkNode(m.id)}>复制一份（只复制材料）</div>
      {/if}
      {#if m.kind !== 'project'}
        <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-move" onclick={() => (moving = { p: null })}>移到…</div>
      {/if}
      <div class="sep" style="margin:4px 6px"></div>
      <!-- I-071 · 新建挪进菜单，行内的 ＋ 去掉了 —— 一行里塞两个图标，
           名字一长就全乱。右键或 ⋮ 是永远在的入口 -->
      {#if m.kind === 'project'}
        <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-new" onclick={() => make('unit', m.id)}
          ><Ic n="plus" s={16} /> 新建单元</div
        >
      {:else if m.kind === 'unit'}
        <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-new" onclick={() => make('lecture', m.id)}
          ><Ic n="plus" s={16} /> 新建 Lecture</div
        >
      {/if}
      <!-- ★ T-4.13 · 全项目的说法统一成「随时」：这里不预选线（它问的就是测哪条线） -->
      <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-test" onclick={() => openTest(m)}>随时认读 / 练习…</div>
      <div class="mi" role="menuitem" tabindex="-1" data-testid="tree-export" onclick={() => exportNode(m)}>导出笔记</div>
      <div class="sep" style="margin:4px 6px"></div>
      <div
        class="mi dg"
        role="menuitem"
        tabindex="-1"
        data-testid="tree-delete"
        onclick={() => {
          // 先收菜单再问（I-087：菜单不收，遮罩会挡死后面的东西）
          askDel = { kind: m.kind, id: m.id, name: m.name }
          menu = null
        }}>删除…</div>
    {/if}
  </div>
{/if}

<!-- I-061 · 测试弹窗。**不看到期日** —— 想测就能测，可选乱序 -->
{#if testDlg}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="ov on" data-testid="test-dialog" onclick={() => (testDlg = null)}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="acard" style="max-width:440px" onclick={(e) => e.stopPropagation()}>
      <div class="side" data-testid="test-dialog-title">
        {testDlg.line === 'reading'
          ? '随时认读'
          : testDlg.line === 'practice'
            ? '随时练习'
            : '随时认读 / 练习'}
        · {testDlg.name}
      </div>
      <!-- ★ T-4.13 · 把「推荐」和「可练」当面分开说：
           到期日只决定**今天推荐什么**，不决定他能不能练（D-R28）。 -->
      <div class="s2" style="margin-bottom:14px">
        <b>不看到期日</b> —— 这一支下面 {testDlg.ids.length} 个 Lecture 的条目全部可练。
        到期日只用来<b>推荐</b>今天练哪些；判分照常算数（练了就是练了），
        <b>要不要练由你决定，不由日程决定</b>。
      </div>

      <div class="sr">
        <div class="l">
          <div class="t3">乱序</div>
          <div class="s3">打乱顺序，免得靠位置记住</div>
        </div>
        <div class="r">
          <!-- I-074 · 滑动开关（总原型 .sw），不是标签 -->
          <div
            class="sw"
            class:on={testShuffle}
            role="switch"
            aria-checked={testShuffle}
            aria-label="乱序"
            tabindex="0"
            data-testid="test-shuffle"
            onclick={() => (testShuffle = !testShuffle)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                testShuffle = !testShuffle
              }
            }}
          ></div>
        </div>
      </div>

      <!-- ★ T-4.13 · 带 `line` 进来时那一条是主按钮，另一条**仍然在** ——
           他在这一步改主意，不该被赶回上一页重点一次。 -->
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button
          class="btn"
          class:pri={testDlg.line !== 'practice'}
          style="flex:1"
          data-testid="test-reading"
          onclick={() => runTest('reading')}>随时认读</button
        >
        <button
          class="btn"
          class:pri={testDlg.line !== 'reading'}
          style="flex:1"
          data-testid="test-practice"
          onclick={() => runTest('practice')}>随时练习</button
        >
        <button class="btn" onclick={() => (testDlg = null)}>取消</button>
      </div>
      <div class="s3" style="margin-top:10px">
        认读＝看挖空的原句想出这个知识点；产出＝按题目写一句，AI 按四档判。
      </div>
    </div>
  </div>
{/if}

  <!-- ★ H-4a · 漏网的错误条。有错才渲染 —— 正常状态下这里一个节点都没有 -->
  {#if errs.length > 0}
    <div class="nyx-errbar" data-testid="errbar">
      {#each errs as e (e.id)}
        <div class="errbox" data-testid="errbar-item">
          <div class="h">{e.where}</div>
          <div style="white-space:pre-wrap">{e.message}</div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn sm" data-testid="errbar-dismiss" onclick={() => dismissError(e.id)}
              >知道了</button
            >
            <button class="btn sm" data-testid="errbar-logs" onclick={() => window.nyx.store.openFolder('logs')}
              >打开日志文件夹</button
            >
          </div>
        </div>
      {/each}
      {#if errs.length > 1}
        <button class="btn sm" data-testid="errbar-clear" onclick={clearErrors}>全部收起</button>
      {/if}
    </div>
  {/if}

  {#snippet failed(error, reset)}
    <div class="nyx-fatal" data-testid="boundary-page">
      <div class="errbox">
        <div class="h">这一页出错了</div>
        <div style="white-space:pre-wrap">{cleanMessage(error)}</div>
        <div style="margin-top:10px">
          <b>你的数据没有动。</b><br />
          回 Today 可以继续使用；反复出现请把这段和日志一起发出。
        </div>
        <div class="dim" style="margin-top:10px" data-testid="boundary-build">
          {#await window.nyx.app.buildInfo()}
            构建号：读取中…
          {:then b}
            构建号：{b.commit}{b.dirty ? '+改动未提交' : ''} · {b.builtAt}
          {:catch}
            构建号：取不到（设置 → 数据 → 自检里也看得到）
          {/await}
        </div>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button
            class="btn sm pri"
            data-testid="boundary-home"
            onclick={() => {
              enter({ k: 'home' })
              overlay = null
              menu = null
              testDlg = null
              reset()
            }}>回 Today</button
          >
          <button class="btn sm" data-testid="boundary-logs" onclick={() => window.nyx.store.openFolder('logs')}
            >打开日志文件夹</button
          >
        </div>
      </div>
    </div>
  {/snippet}
</svelte:boundary>
