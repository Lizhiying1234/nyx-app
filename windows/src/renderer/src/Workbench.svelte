<script lang="ts">
  import { CONSECUTIVE_FAIL_AT, CONSECUTIVE_FAIL_HINT } from '@core/ai/client.ts'
  import Stars from './Stars.svelte'
  import { ROTATION_WORDS, SILENCE_ACTIONS, isRowSilent, silenceScopeAction } from '@core/silence.ts'
  import { TRASH_KEEP_TEXT } from '@core/sql/trash.ts'
  import Dialog from './Dialog.svelte'
  import { say, sayBad, sayUndo } from './toast.svelte.ts'
  import type {
    AnalyzeResult,
    AnalyzeStage,
    ChunkResult,
    DedupPick,
    DedupReport,
    Failure,
    ItemRow,
    LectureDetail,
    StartLearningResult
  } from '@shared/api.ts'
  import { untrack } from 'svelte'
  import { cleanMessage, parseFailure } from '@shared/api.ts'
  import { reportError } from './errors.ts'
  import AnalyzePanel from './AnalyzePanel.svelte'
  import SelBar from './SelBar.svelte'
  import Ic from './Ic.svelte'
  import { registerEsc } from './esc-stack.svelte.ts'
  import SrcBadge from './SrcBadge.svelte'

  let {
    lectureId,
    onchanged,
    ongotoSettings,
    onstudy,
    ontest,
    /** I-098 · 勾选之后的两个测试入口 */
    ontestItems,
    onpracticeItems,
    onopenitem,
    ongotopath
  }: {
    lectureId: number
    onchanged?: () => void
    ongotoSettings?: () => void
    onstudy?: (kind: 'reading' | 'practice') => void
    /**
     * I-061 · 随时练：只交范围，乱不乱序由弹窗问。
     * ★ T-4.13 · `line` = 他点的是「随时认读」还是「随时练习」（弹窗还是那一个）。
     */
    ontest?: (lectureIds: number[], line?: 'reading' | 'practice') => void
    ontestItems?: (ids: number[]) => void
    onpracticeItems?: (ids: number[]) => void
    onopenitem?: (id: number) => void
    /** ★ H-3 · 面包屑能点。id 由外壳从树里解析 —— `LectureBrief` 只带名字不带 id */
    ongotopath?: (kind: 'project' | 'unit') => void
  } = $props()

  /** 失败态、加载态、成功态在类型上就是三个状态 —— 不可能再出现「出错了却显示空态」（I-001）。 */
  type View =
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | { k: 'ok'; data: LectureDetail }

  let view = $state<View>({ k: 'loading' })
  /**
   * ★★ 三个 Tab，**默认落在第一个非空的那个**（2026-09-03 · UI 审计 A-1）
   *
   * 原来写死 `'self'`。而「我的收集」是三个里**最常为空**的一个 ——
   * 它只装「本讲我自己上传的原句」（D-075），绝大多数讲次一条都没有。
   * 于是一个有 15 条知识点的讲次，打开之后正中央写着「**这个 Tab 是空的**」。
   * **一个有内容的页面，不该给人看空白** —— 他会以为这一讲什么都没有。
   *
   * ★ `picked === null` 的意思是「**他还没自己选过**」。
   *   自动落位只负责「第一眼」，**不负责替他做决定** ——
   *   他一旦点过某个 Tab，就一直以他点的为准，哪怕那个是空的。
   */
  type Tab = 'self' | 'active' | 'passive'
  let picked = $state<Tab | null>(null)

  /** 正在贴东西的落区。null = 没在贴。 */
  let compose = $state<{
    kind: 'original' | 'chunk'
    title: string
    text: string
    busy: boolean
    error: string | null
  } | null>(null)

  /** 刚收下 chunk 之后的回执，含 D-026 的重复提示 */
  let receipt = $state<ChunkResult | null>(null)
  /** I-055 · 重复清单默认收起 —— 58 条一条一个框会把整页淹掉 */
  let showRepeats = $state(false)

  /**
   * I-073 · 链接抓取入口已删除。
   * 使用者：「网络链接和 pdf 依旧不能读取…把链接和 pdf 这两个接口删除吧。」
   * 留下的是「从文件读」（.txt/.md/.docx/.srt/.vtt，这几种是真的能读）。
   * 读完仍然先填进框里过目，不直接入库。
   */
  let fetchNote = $state<string | null>(null)

  // ── D-064 第三个入口 · 逐条手动输入 ─────────────────────────
  let adding = $state(false)
  // ★★ ⑩（2026-09-01）：手动添加的默认档从 B 改成 **A（认读）** ——
  //    「所有刚刚新增进入 Nyx 的知识点，默认都必须是『认读』状态」。
  //    A/B 那两个按钮**留着**：默认是 A，他当场想改仍然改得了。
  let draft = $state({ term: '', gloss: '', quote: '', layer: 'A' as 'A' | 'B' })
  let addError = $state<string | null>(null)
  /**
   * ★ 这一条**留在原地**（使用者 2026-09-14 第五条的另一半）：它装的是
   *   「笔记写在：<一条完整路径>」。回执条 4 秒就走，而一条路径他多半要
   *   看一眼、甚至复制出来 —— 4 秒读不完的东西不该用会自己跑掉的载体。
   *   同样理由留在原地的还有 Settings 里的备份 / 导出路径。
   */
  let addNote = $state<string | null>(null)

  async function submitItem(): Promise<void> {
    addError = null
    addNote = null
    try {
      const r = await window.nyx.data.addItem(
        lectureId,
        draft.term,
        draft.gloss,
        draft.layer,
        draft.quote
      )
      // I-002 · 加完自动切到它所在的 Tab —— 不然「看起来没反应」，
      // 因为新条目落进了另一个 Tab，而使用者正看着这一个
      picked = r.layer === 'B' ? 'active' : 'passive'
      /**
       * ★ 一次性结果 → 回执条（使用者 2026-09-14 第五条）。
       * ★ 那对 `**` 删了：这根字符串是**当文本画上去**的，
       *   Markdown 记号会原样显在屏幕上。同一天在 Assist 那一页刚抳出一处一模一样的。
       */
      say(
        `「${draft.term.trim()}」加进${r.layer === 'B' ? '写作层' : '理解层'}了。` +
          // D-026 · 重复收集是有意义的信号，当场说
          (r.duplicateOf ? '　这条以前收过，说明上一次「学会」可能是假的。' : '')
      )
      draft = { term: '', gloss: '', quote: '', layer: draft.layer }
      adding = false
      await load()
      onchanged?.()
    } catch (err) {
      addError = cleanMessage(err)
    }
  }

  // ── 这一讲的 ••• 菜单 ───────────────────────────────────────
  /**
   * I-077 · 这里以前点开是一整块**推开正文**的卡片。
   * 使用者：「lecture 的 ⋮ 应该是下拉菜单」——
   * 和侧边栏那三级用同一套 `.pm`：浮在上面、贴着按钮下沿、点别处就关。
   */
  /** I-098 · 工作台的 .ck 一直是死的占位符 —— 现在真的能勾 */
  let selected = $state<number[]>([])
  const toggleSel = (id: number): void => {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
  }

  let lmenu = $state<{ x: number; y: number } | null>(null)

  /**
   * ★ D-440 · 讲次页这两层以前都按不掉 Esc（2026-09-03 真机扫描）。
   * 菜单在最上面，所以先关菜单，再关添加弹窗 —— 一次只退一层。
   * ★ 改名那个输入框不进栈：它是**元素级**取消（`esc-stack.svelte.ts` 文件头的既有规则）。
   */
  $effect(() =>
    registerEsc(() => {
      if (lmenu) { lmenu = null; return true }
      if (dedup) { dedup = null; return true }
      if (adding) { adding = false; return true }
      return false
    })
  )

  // ── T-4.8 · 一键去重 ────────────────────────────────────────

  /**
   * 讲次内查重。null = 没打开。
   *
   * ★ 先扫描、再让他决定 —— 按钮按下去**不会**直接改任何东西。
   *   合并是软删（保留期内可反悔，`TRASH_DAYS`），但「他没看见就发生了」这件事不可逆。
   * ★ Review 组这里只负责**显示差异**：并不并、以哪条为主，由他点。
   *   「不自动处理 Review」那条策略在主进程（`db/merge.ts`），不在这里 ——
   *   界面上的判断挡不住别的调用点。
   */
  let dedup = $state<{
    busy: boolean
    error: string | null
    report: DedupReport | null
    /** 刚刚做完的那一次的回执，做完就显示在顶部 */
    done: string | null
  } | null>(null)

  async function openDedup(): Promise<void> {
    dedup = { busy: true, error: null, report: null, done: null }
    try {
      const report = await window.nyx.dedup.scan(lectureId)
      dedup = { busy: false, error: null, report, done: null }
    } catch (err) {
      dedup = { busy: false, error: cleanMessage(err), report: null, done: null }
    }
  }

  async function runDedup(pick: DedupPick): Promise<void> {
    if (!dedup) return
    dedup = { ...dedup, busy: true, error: null }
    try {
      const out = await window.nyx.dedup.merge(lectureId, pick)
      const report = await window.nyx.dedup.scan(lectureId)
      dedup = {
        busy: false,
        error: null,
        report,
        done: `并掉 ${out.merged} 条，进了回收站（${TRASH_KEEP_TEXT}）`
      }
      await load()
      onchanged?.()
    } catch (err) {
      dedup = { ...dedup, busy: false, error: cleanMessage(err) }
    }
  }
  /** 改名是二级动作，点了才出输入框，不占主菜单的位置（和侧边栏一致） */
  let lrenaming = $state(false)
  let newName = $state('')

  function openLmenu(e: MouseEvent): void {
    if (lmenu) {
      lmenu = null
      return
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const top = r.bottom + 4
    lmenu = {
      x: Math.min(r.left, window.innerWidth - 250),
      // 贴近窗口底部时往上翻，免得被切掉
      y: top + 240 > window.innerHeight ? Math.max(8, top - 240) : top
    }
    lrenaming = false
  }

  async function rename(): Promise<void> {
    try {
      await window.nyx.browse.renameLecture(lectureId, newName)
      lmenu = null
      lrenaming = false
      await load()
      onchanged?.()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  /** I-034 · 静默这一讲：不再轮转，进度保留，可随时取消。 */
  async function toggleSilence(): Promise<void> {
    if (view.k !== 'ok') return
    const on = view.data.lecture.status !== 'silent'
    try {
      await window.nyx.data.silenceLecture(lectureId, on)
      /** ★ 一次性结果 → 回执条（使用者 2026-09-14 第五条）*/
      say(
        on
          ? `${SILENCE_ACTIONS.shelve}：不再排进今日练习，条目进度原样保留。`
          : `${SILENCE_ACTIONS.restore}：重新排进练习。`
      )
      lmenu = null
      await load()
      onchanged?.()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  /**
   * 删一份材料（使用者 2026-08-10：「上传的文件可以删除，用小 × 表示」）。
   *
   * 先问一句再删 —— 材料是他打字或上传进来的，误点一下就没了很难受。
   * 但**问的时候要说清后果**：进回收站、保留期内可恢复、
   * **已经提出来的知识点不受影响**。不说清楚他不敢点，等于没这个功能。
   */
  /**
   * ★ B5 / X-09（2026-09-08）· 这里原来用的是**系统 `confirm()`** ——
   *   它长得不是这个软件的脸，而且在 Electron 里会**卡住渲染进程**
   *   （Trash.svelte 早就写下过这一条，那一轮只改了它自己那一处）。
   *   现在走全 App 唯一那种应用内 Dialog（BTN-Q4：三种确认形态收成一种）。
   * ★ 删完给**带撤销的回执**（BTN-Q5）：确认框防误点 · 撤销条防手快 ·
   *   回收站保留期防隔日反悔 —— 三层保护缺的一直是中间那层。
   */
  let delMat = $state<{ id: number; title: string } | null>(null)

  async function delMaterial(id: number, title: string): Promise<void> {
    delMat = null
    try {
      await window.nyx.data.deleteMaterial(id)
      await load()
      onchanged?.()
      sayUndo(
        `删掉了《${title}》，${TRASH_KEEP_TEXT}`,
        async () => {
          await window.nyx.browse.restore('material', id).catch((e) => {
            throw new Error(`没能恢复：${cleanMessage(e)}`)
          })
          await load()
          onchanged?.()
        },
        `《${title}》已从回收站恢复`
      )
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  async function exportLecture(): Promise<void> {
    if (view.k !== 'ok') return
    addError = null
    try {
      const p = await window.nyx.data.exportNotes('lecture', lectureId, view.data.lecture.name)
      // `null` = 他自己在保存对话框里取消了，不是失败
      if (p) addNote = `笔记写在：${p}`
    } catch (err) {
      addError = `笔记没导出成：${cleanMessage(err)}`
    }
  }

  async function removeLecture(): Promise<void> {
    try {
      const r = await window.nyx.browse.deleteLecture(lectureId)
      say(`删掉了，${r.items} 条跟着进了回收站${r.moved > 0 ? `，${r.moved} 条留给了别的 Lecture` : ''}。${TRASH_KEEP_TEXT}。`)
      lmenu = null
      onchanged?.()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  /**
   * I-037 · 从文件读正文。
   * 和链接抓取一样：读完**填进框里让使用者过目**，不直接入库 ——
   * PDF 尤其如此，它的提取是尽力而为，串行缺字都可能。
   */
  async function pickFile(): Promise<void> {
    if (!compose) return
    fetchNote = null
    compose.error = null
    try {
      const d = await window.nyx.ingest.pickFile()
      if (!d) return
      if (!compose.title.trim()) compose.title = d.title.slice(0, 60)
      compose.text = d.text
      const what =
        d.kind === 'docx'
          ? 'Word 文档'
          : d.kind === 'subtitle'
            ? '字幕（已去掉时间轴）'
            : d.kind === 'markdown'
              ? 'Markdown'
              : '纯文本'
      fetchNote = `读到 ${d.chars} 字 · ${what}。${d.note ?? '先扫一眼，不对直接在框里改。'}`
    } catch (err) {
      compose.error = cleanMessage(err)
    }
  }

  /**
   * 分析的状态。**失败态是一个独立的分支，不是「结果为空」**——
   * 上一版就是把失败混进了空态，报错整个被吞掉（I-001）。
   */
  type Analysis =
    | { k: 'idle' }
    | { k: 'running'; stage: AnalyzeStage | null }
    | { k: 'failed'; failure: Failure | null; message: string }
    | { k: 'done'; result: AnalyzeResult }

  let analysis = $state<Analysis>({ k: 'idle' })
  /**
   * 上一个 lecture —— 切走时要拿它去取消，不能用已经变了的 lectureId。
   * 从 0 起：第一次进来没有「上一个」，也没有在跑的分析。
   */
  let prevLecture = 0
  let stopStage: (() => void) | null = null
  /** 分析前的那个面板开着没 —— 按材料给临时指令 */
  let panel = $state(false)

  const STAGE_TEXT: Record<AnalyzeStage['name'], string> = {
    reading: '读取材料',
    extracting: '提取知识点',
    merging: '判层与去重',
    done: '完成'
  }

  /** 上一次用的指令，重试时沿用，不用重新敲一遍 */
  let lastExtra = $state<{ extra: string; presetName: string | null }>({
    extra: '',
    presetName: null
  })

  /**
   * I-082 · 上一次分析的范围。重试时要按原样再来一遍 ——
   * 勾了两份、失败了、点重试却把五份全跑了，那是白花钱。
   */
  let lastScope = $state<number[] | undefined>(undefined)

  async function analyze(
    extra?: string,
    presetName?: string | null,
    materialIds?: number[]
  ): Promise<void> {
    if (extra !== undefined) {
      lastExtra = { extra, presetName: presetName ?? null }
      // 存成普通数组 —— $state 会把它包成 Proxy，直接扔给 IPC 会「could not be cloned」
      lastScope = materialIds ? [...materialIds] : undefined
    }
    panel = false
    analysis = { k: 'running', stage: null }
    stopStage?.()
    /**
     * ★ H-4b · 订阅挂不上，进度条会永远停在第一格 —— 而分析其实在跑。
     * 那种「看着卡死」最容易让他去关软件，正好把分析也一起杀掉。
     * 所以挂不上就说一句，分析照常继续（少的只是进度显示）。
     */
    try {
      stopStage = window.nyx.ai.onStage((s) => {
        if (analysis.k === 'running') analysis = { k: 'running', stage: s }
      })
    } catch (err) {
      stopStage = null
      reportError(err, '分析进度显示没挂上（分析本身照常在跑）')
    }
    try {
      const result = await window.nyx.ai.analyze(
        lectureId,
        lastExtra.extra,
        lastExtra.presetName ?? undefined,
        lastScope ? [...lastScope] : undefined
      )
      analysis = { k: 'done', result }
      await load()
      onchanged?.()
    } catch (err) {
      analysis = { k: 'failed', failure: parseFailure(err), message: cleanMessage(err) }
    } finally {
      stopStage?.()
      stopStage = null
    }
  }

  /**
   * I-104 · 按类别写完整解析。
   * 和整体分析共用同一套 `analysis` 状态与「暂停分析」按钮 ——
   * 对使用者来说都是「正在分析」，没必要多一套说法。
   */
  const SCOPE_NAME = { self: '我的收集', active: '写作层', passive: '理解层' } as const

  /**
   * ══ 引文匹配（使用者 2026-09-13）══════════════════════════════
   * 跑完给一句话。**不进 `analysis` 那个状态机** —— 那套是给「调 AI、要时间、
   * 可能失败」准备的；这一条瞬时、确定、不花钱，套进去只会多一个假的进度条。
   */
  /**
   * ★ 拆成两样（使用者 2026-09-14 第五条）：
   *   `quoteBusy` —— **进行中**，留在原地。进度不是回执：它飘走了他就不知道还在跑。
   *   跑完 / 没跑成 —— 走回执条（`say` / `sayBad`）：一次性的结果，不跟任何控件绑着。
   */
  let quoteBusy = $state(false)

  async function runQuoteMatch(): Promise<void> {
    panel = false
    quoteBusy = true
    try {
      const r = await window.nyx.data.matchQuotes(lectureId)
      if (r.noText) {
        sayBad('这一讲还没有原文 —— 引文匹配是拿原文去找句子的，先加一份原文。')
      } else if (r.total === 0) {
        sayBad('这一讲还没有知识点。')
      } else if (r.changed === 0) {
        /** ★ 一条都没换也要说 —— 沉默会让他以为按钮没生效 */
        /**
         * ★ 不要写 `**粗体**` —— 这根字符串是**当文本画上去**的，
         *   Markdown 记号会原样显在屏幕上（同一天在查词卡上刚踩过一次）。
         */
        say(
          `跑完了：${r.total} 条里没有需要改的` +
            (r.missed > 0 ? `（其中 ${r.missed} 条在原文里没找到，旧出处留着）` : '（本来就都对上了）')
        )
      } else {
        say(
          `跑完了：换了 ${r.changed} 条出处` +
            `，${r.same} 条本来就对` +
            (r.missed > 0 ? `，${r.missed} 条在原文里没找到（旧出处留着，没清空）` : '')
        )
      }
      await load()
    } catch (e) {
      sayBad('引文匹配没跑成：' + cleanMessage(e))
    } finally {
      quoteBusy = false
    }
  }

  async function analyseScope(scope: 'self' | 'active' | 'passive'): Promise<void> {
    panel = false
    analysis = { k: 'running', stage: null }
    stopStage?.()
    /**
     * ★ H-4b · 订阅挂不上，进度条会永远停在第一格 —— 而分析其实在跑。
     * 那种「看着卡死」最容易让他去关软件，正好把分析也一起杀掉。
     * 所以挂不上就说一句，分析照常继续（少的只是进度显示）。
     */
    try {
      stopStage = window.nyx.ai.onStage((s) => {
        if (analysis.k === 'running') analysis = { k: 'running', stage: s }
      })
    } catch (err) {
      stopStage = null
      reportError(err, '分析进度显示没挂上（分析本身照常在跑）')
    }
    try {
      const r = await window.nyx.study.analyseScope(lectureId, scope)
      say(
        `${SCOPE_NAME[scope]}：写好了 ${r.done} 条` +
          (r.failed ? `，${r.failed} 条没做成（详情页里能单独重试）` : '') +
          (r.skipped ? `，暂停时还剩 ${r.skipped} 条 —— 再点一次接着跑` : '') +
          '。'
      )
      analysis = { k: 'idle' }
      await load()
      onchanged?.()
    } catch (err) {
      analysis = { k: 'failed', failure: parseFailure(err), message: cleanMessage(err) }
    } finally {
      stopStage?.()
      stopStage = null
    }
  }

  async function cancelAnalyze(): Promise<void> {
    try {
      await window.nyx.ai.cancelAnalyze(lectureId)
    } catch (err) {
      // 取消没成，分析还在跑 —— 必须说，否则他会一直点那颗按钮
      reportError(err, '没能取消这次分析（它还在后台跑）')
    }
  }

  async function load(): Promise<void> {
    view = { k: 'loading' }
    try {
      const data = await window.nyx.data.lecture(lectureId)
      view = { k: 'ok', data }
      if (!newName) newName = data.lecture.name
    } catch (err) {
      view = { k: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  $effect(() => {
    void lectureId
    /**
     * I-059 · 切走就暂停分析。
     * 分析在主进程跑，一份材料跑完标一份（`materials.analyzed_at`）——
     * 所以「暂停」= 取消当前这一份，已经跑完的都留着；
     * 回来点「继续分析」就从没跑的那一份接着来，不会重跑、不会重复花钱。
     */
    // untrack 是必须的：读 `analysis` 会把它变成这个 effect 的依赖，
    // 于是分析一进入 running 就触发 effect，当场把自己取消掉。
    untrack(() => {
      if (prevLecture !== 0 && prevLecture !== lectureId && analysis.k === 'running') {
        // 切走时顺手取消上一讲的分析。失败＝那一讲还在后台跑（还在花钱），要说
        window.nyx.ai
          .cancelAnalyze(prevLecture)
          .catch((err: unknown) => reportError(err, '上一讲的分析没能暂停（它还在后台跑）'))
        analysis = { k: 'idle' }
      }
      prevLecture = lectureId
    })
    /**
     * I-055 · 换一讲就把回执清掉。
     * 它说的是「**刚才那一次**收下发生了什么」，不是这一讲的属性 ——
     * 不清的话，新建一讲进去还挂着上一讲的 58 条重复提示。
     */
    receipt = null
    showRepeats = false
    addNote = null
    load()
  })

  function open(kind: 'original' | 'chunk'): void {
    receipt = null
    compose = { kind, title: '', text: '', busy: false, error: null }
  }

  async function submit(): Promise<void> {
    if (!compose) return
    const c = compose
    if (!c.text.trim()) {
      c.error = c.kind === 'original' ? '还没有内容 —— 把文章正文贴进来。' : '还没有内容 —— 每行一条。'
      return
    }
    c.busy = true
    c.error = null
    try {
      if (c.kind === 'original') {
        await window.nyx.data.addOriginal(lectureId, c.title, c.text)
        receipt = null
      } else {
        receipt = await window.nyx.data.addChunks(lectureId, c.title, c.text)
      }
      compose = null
      await load()
      onchanged?.()
    } catch (err) {
      c.error = err instanceof Error ? err.message : String(err)
      c.busy = false
    }
  }

  /**
   * 「我的收集」Tab = **本讲我上传的原句**（D-075），只读、可朗读、不参与产出训练。
   *
   * 关键分界：**析出项不算原句**。D-016 说一份上传有两类产物 ——
   * 整条原句进这个 Tab，而 AI 从里面拆出的成分（析出项）**正常进主动/被动 Tab**，
   * 带 source='self' 的蓝色标记。所以判据是「有没有母句」，不是「来源是不是自己」。
   *
   * 第三个判据 `kind === 'sentence'`：**手动加的那一条也不是原句**。
   * 它是我自己打进来、自己判了层的知识点，该去主动/被动 Tab。
   * 少了这一条就是 I-002 复发 —— 加完看起来毫无反应，
   * 因为它落进了这个 Tab，而使用者正看着另一个。
   */
  const isOwnSentence = (i: ItemRow): boolean =>
    i.source === 'self' && i.derivedFrom === null && i.kind === 'sentence'

  /**
   * ★ I-099 · 静默的条目要从这一讲的默认视图里消失
   *
   * 使用者：「为什么我静默了某条知识之后，它不从 lecture 里面的知识里面消失呢？」
   * `decisions.md`：「达标条目转为静默，**从原库与 lecture 的默认视图消失**。」
   * 综合知识库那边早就这么做了（D-158），**唯独这一讲的列表一直照单全收** ——
   * 于是「静默」在这里看起来毫无效果。
   *
   * 判定跟静默库用同一条：两条线里任何一条静默，就算静默。
   * 两处用不同定义的话，同一条会「在这里没了、在那里也找不到」。
   *
   * 「默认」两个字也照做：给一个开关能翻出来看，不是让它彻底消失 ——
   * 静默是正向的终点，不是删除（D-087 / D-186）。
   */
  /** ★ I-204 · 判据只有 core 那一份；这里不许再写「或」（`check:silence-one-source` 钉着） */
  const isSilent = (i: ItemRow): boolean => isRowSilent(i)
  let showSilent = $state(false)

  function shown(items: ItemRow[]): ItemRow[] {
    const live = showSilent ? items : items.filter((i) => !isSilent(i))
    if (tab === 'self') return live.filter(isOwnSentence)
    if (tab === 'active') return live.filter((i) => !isOwnSentence(i) && i.layer === 'B')
    return live.filter((i) => !isOwnSentence(i) && i.layer === 'A')
  }

  // ── 审阅这一批 · F-03 ──────────────────────────────────────
  let starting = $state(false)
  let startedInfo = $state<StartLearningResult | null>(null)

  async function startLearning(): Promise<void> {
    starting = true
    try {
      // ★ P-1 · 后端拒绝了（这一讲已经在轮转中）—— 说清楚，别显示成「刚刚进入轮转」
      // ★ F-2-② · 排期是后端算的，这里**一个数都不自己推**。以前这段写死了
      //   「明天开始产出练习」，而现在有历史的讲根本不排在明天 —— 写死就是骗他
      startedInfo = await window.nyx.study.startLearning(lectureId)
      await load()
      onchanged?.()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    } finally {
      starting = false
    }
  }

  async function dropItem(id: number): Promise<void> {
    try {
      await window.nyx.study.deleteItem(id)
      await load()
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  /** 还有几份材料没分析 —— 「继续分析」上那个数字要是真的 */
  const pendingCount = (d: LectureDetail): number =>
    d.materials.filter((m) => !m.analyzedAt).length

  const counts = (items: ItemRow[]) => {
    // Tab 上的数字也要跟着走 —— 数字算进去、列表却看不见，比不改还糟
    const live = showSilent ? items : items.filter((i) => !isSilent(i))
    return {
      self: live.filter(isOwnSentence).length,
      active: live.filter((i) => !isOwnSentence(i) && i.layer === 'B').length,
      passive: live.filter((i) => !isOwnSentence(i) && i.layer === 'A').length
    }
  }

  /**
   * 当前 Tab ＝ **他选过的那个**，没选过就落在第一个非空的（A-1，见上面 `picked`）。
   *
   * ★ 找的顺序是 主动 → 被动 → 我的收集，不是 Tab 在屏幕上的顺序。
   *   理由：主动词汇是「打算拿来写的」，是这一讲的产出主线（D-023）；
   *   「我的收集」只做理解与朗读、不出产出题（D-075），最不该抢第一眼。
   * ★ 三个都空的时候落在主动词汇 —— 那时空态说的是「还没有知识点」，
   *   落在哪个都一样，选一个语义上最像「这一讲将来长东西的地方」的。
   * ★ 跟着 `showSilent` 走：`counts` 本来就按它过滤，
   *   所以「整讲都静默了」的时候不会被算成有内容。
   */
  const tab = $derived.by((): Tab => {
    if (picked !== null) return picked
    if (view.k !== 'ok') return 'active'
    const n = counts(view.data.items)
    if (n.active > 0) return 'active'
    if (n.passive > 0) return 'passive'
    if (n.self > 0) return 'self'
    return 'active'
  })
</script>

{#if view.k === 'error'}
  <div class="errbox" data-testid="lecture-error">
    <div class="h">这个 Lecture 打不开</div>
    <div>{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={load}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <div class="card blk" data-testid="lecture-loading">正在打开…</div>
{:else}
  {@const d = view.data}
  {@const n = counts(d.items)}

  <div class="lh">
    <!-- I-070 · 编号跟着**名字**走，不是建立次序。
         改名成「第 5 讲」就显示 5；名字里没有数字就不显示这个方块 ——
         摆一个和名字对不上的数字，比不摆更糟。 -->
    {#if d.lecture.name.match(/\d+/)}
      <div class="lnum">{d.lecture.name.match(/\d+/)![0]}</div>
    {/if}
    <div class="lname">{d.lecture.name}</div>
    <!-- D-064 第三个入口 · 逐条手动输入。这两个按钮以前是死的（I-002 / C-004） -->
    <button class="pill" data-testid="add-item" onclick={() => (adding = !adding)}
      ><Ic n="plus" s={16} /> 添加知识点</button
    >
    <!-- T-4.8 · 一键去重。功能性入口，只加一个按钮，既有版式不动（D-441 只禁版式重设计） -->
    <button class="pill" data-testid="dedup-open" onclick={openDedup}>查重</button>
    <button class="pill" title="这个 Lecture 的更多动作" aria-label="这个 Lecture 的更多动作" data-testid="lecture-menu" onclick={openLmenu}><Ic n="more" s={18} /></button>
  </div>

  <!-- T-4.8 · 查重对话框 —— 先看结果，再决定动不动手 -->
  {#if dedup}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="ddscrim" data-testid="dedup-scrim" onclick={() => (dedup = null)}></div>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="ddbox" role="dialog" aria-modal="true" data-testid="dedup-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="ddhead">
        <b>这个 Lecture 里的重复</b>
        <button class="btn sm" data-testid="dedup-close" onclick={() => (dedup = null)}>关闭</button>
      </div>

      {#if dedup.busy}
        <div class="ddnote" data-testid="dedup-busy">正在看…</div>
      {:else if dedup.error}
        <div class="ddnote err" data-testid="dedup-error">{dedup.error}</div>
      {:else if dedup.report}
        {@const r = dedup.report}
        {#if dedup.done}
          <div class="ddnote" data-testid="dedup-done">{dedup.done}</div>
        {/if}
        {#if r.groups.length === 0}
          <div class="ddnote" data-testid="dedup-empty">没有重复。</div>
        {:else}
          <div class="ddsum" data-testid="dedup-summary">
            {r.groups.length} 组 · {r.affected} 条受影响 · {r.safe} 组可安全合并 · {r.review} 组需要你看
          </div>
          <div class="ddact">
            <button
              class="btn sm pri"
              data-testid="dedup-merge-safe"
              disabled={r.safe === 0}
              onclick={() => runDedup({ kind: 'safe' })}
              >{r.safe === 0 ? '没有可以安全合并的' : `合并那 ${r.safe} 组`}</button
            >
            <span class="ddhint">合并 = 信息并到一条，另一条进回收站，{TRASH_KEEP_TEXT}。</span>
          </div>

          {#each r.groups as g (g.norm)}
            <div class="ddg" class:rev={g.bucket === 'review'} data-testid="dedup-group-{g.bucket}">
              <div class="ddgt">
                <span class="ddterm">{g.norm}</span>
                <span class="ddtag">{g.bucket === 'safe' ? '可安全合并' : '需要你看'}</span>
              </div>
              {#if g.reasons.length > 0}
                <ul class="ddwhy">
                  {#each g.reasons as why (why)}<li>{why}</li>{/each}
                </ul>
              {/if}
              {#each g.members as m (m.id)}
                <div class="ddm">
                  <span class="ddml">{m.layer}</span>
                  <span class="ddmg">{m.gloss || '（没有释义）'}</span>
                  <span class="ddmh">作答 {m.answers} · 复习 {m.reviewLogs}{m.blocks.length > 0 ? ` · 分析块 ${m.blocks.join('、')}` : ''}</span>
                  {#if g.bucket === 'review'}
                    <button
                      class="btn sm"
                      data-testid="dedup-pick-{m.id}"
                      onclick={() =>
                        runDedup({
                          kind: 'one',
                          canonicalId: m.id,
                          loserIds: g.members.filter((x) => x.id !== m.id).map((x) => x.id)
                        })}>以这条为主</button
                    >
                  {:else if m.id === g.canonicalId}
                    <span class="ddmh">留下这条</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      {/if}
    </div>
  {/if}

  <!-- I-077 · 下拉菜单，不再把正文推开 -->
  {#if lmenu}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      style="position:fixed;inset:0;z-index:499"
      data-testid="lecture-menu-scrim"
      oncontextmenu={(e) => {
        e.preventDefault()
        lmenu = null
      }}
      onclick={() => (lmenu = null)}
    ></div>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="pm on"
      role="menu"
      tabindex="-1"
      data-testid="lecture-menu-open"
      style="left:{lmenu.x}px;top:{lmenu.y}px"
      onclick={(e) => e.stopPropagation()}
    >
      {#if lrenaming}
        <div style="padding:6px 8px 8px;display:flex;gap:6px;align-items:center">
          <input
            class="tin2"
            style="margin:0;min-width:150px"
            data-testid="rename-input"
            bind:value={newName}
            onkeydown={(e) => {
              if (e.key === 'Enter') rename()
              if (e.key === 'Escape') lrenaming = false
            }}
          />
          <button class="btn sm pri" data-testid="rename-go" onclick={rename}>改名</button>
        </div>
      {:else}
        <div
          class="mi"
          role="menuitem"
          tabindex="-1"
          data-testid="lecture-rename"
          onclick={() => (lrenaming = true)}
        >
          改名…
        </div>
        <div
          class="mi"
          role="menuitem"
          tabindex="-1"
          data-testid="lecture-silence"
          onclick={toggleSilence}
        >
          {silenceScopeAction(d.lecture.status === 'silent', 'Lecture')}
        </div>
        <div class="sp2"></div>
        <div
          class="mi dg"
          role="menuitem"
          tabindex="-1"
          data-testid="lecture-delete"
          onclick={removeLecture}
        >
          删除这个 Lecture（{TRASH_KEEP_TEXT}）
        </div>
        <div
          class="cp"
          style="text-transform:none;letter-spacing:0;white-space:normal;max-width:210px;line-height:1.5"
        >
          <!-- I-034 · 以前这个菜单里什么都没有 -->
          {SILENCE_ACTIONS.shelve}：不再排进练习，进度一个字不动。<br />
          删除：进回收站，这个 Lecture 独有的知识点跟着走。
        </div>
      {/if}
    </div>
  {/if}

  <!-- I-077 ·「添加知识点」改成弹窗。
       以前是一块推开正文的卡片 —— 使用者：「添加知识点应该是弹窗形式」。
       盖住的时候正文位置一动不动，关掉就回到原样。 -->
  {#if adding}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="ov on" data-testid="add-item-form" onclick={() => (adding = false)}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="mbox" onclick={(e) => e.stopPropagation()}>
        <h3>手动加一条</h3>
        <div class="ms">
          自己判层：<b>打算拿来写的选写作层</b>，只求看懂的选理解层。
        </div>
        {#if addError}
          <div class="errbox" data-testid="add-item-error"><div>{addError}</div></div>
        {/if}
        <input
          class="tin2"
          data-testid="ai-term"
          placeholder="知识点，例如 hold sway over"
          bind:value={draft.term}
        />
        <input
          class="tin2"
          data-testid="ai-gloss"
          placeholder="释义（可留空，之后 AI 会补）"
          bind:value={draft.gloss}
        />
        <input
          class="tin2"
          data-testid="ai-quote"
          placeholder="你在哪句话里见到它的？（可留空）"
          bind:value={draft.quote}
        />
        <div class="s3" style="margin-top:6px">
          <!-- M-012 · 出处是知识点身份的一半。手打的没有出处很正常，但不能假装有 -->
          {draft.quote.trim() ? '有出处，认读卡就能挖空这句。' : '没有出处的条目，认读卡只能光秃秃地问你这个词。'}
        </div>
        <div class="mfield" style="margin-top:14px">
          <div class="fl">归到哪一层</div>
          <div class="fv">
            <button class:on={draft.layer === 'B'} data-testid="ai-layer-b" onclick={() => (draft.layer = 'B')}
              >写作层</button
            >
            <button class:on={draft.layer === 'A'} data-testid="ai-layer-a" onclick={() => (draft.layer = 'A')}
              >理解层</button
            >
          </div>
        </div>
        <div class="mact">
          <button class="btn" data-testid="ai-cancel" onclick={() => (adding = false)}>取消</button>
          <button class="btn pri" data-testid="ai-submit" onclick={submitItem}>加进来</button>
        </div>
      </div>
    </div>
  {/if}
  {#if addNote}
    <div class="notice ok" data-testid="add-item-note">{addNote}</div>
  {/if}
  <!--
    ★ H-3（2026-09-03 UI 审计）· 这一行原来和顶上那条返回入口**堆成两行路径**，
      看着像把同一件事写了两遍。

      两者其实职责不同：返回入口说的是「**你从哪来**」（D-451，来路可变），
      这一行说的是「**你在哪**」（归属，固定）。所以不该删掉任何一条 ——
      该做的是让这一行**从标签变成控件**。

    ★ D-469（2026-09-07）· 项目页 / 单元页取消之后，这两下点击的去处变了：
      不再跳页，改成**在侧边栏里展开到那一层**（`App.svelte::revealPath`）——
      「我在哪」这件事现在唯一的去处就是那棵树。
      提示语跟着改，别再说「去那一页」。
  -->
  <div class="hint crumb" data-testid="lecture-path">
    <span
      role="button"
      tabindex="0"
      data-testid="crumb-project"
      title="在侧边栏里展开到这个项目"
      onclick={() => ongotopath?.('project')}
      onkeydown={(e) => e.key === 'Enter' && ongotopath?.('project')}>{d.lecture.projectName}</span
    >
    <span class="sep">›</span>
    <span
      role="button"
      tabindex="0"
      data-testid="crumb-unit"
      title="在侧边栏里展开到这个单元"
      onclick={() => ongotopath?.('unit')}
      onkeydown={(e) => e.key === 'Enter' && ongotopath?.('unit')}>{d.lecture.unitName}</span
    >
  </div>

  <!-- ══ 收下之后的回执：重复收集必须当场说（D-026 / M-030）══ -->
  {#if receipt}
    <div class="notice ok" data-testid="chunk-receipt">
      <b>收下 {receipt.added.length} 句。</b>
      它们进了「我的收集」——<b>原样保留，不拆不改写，也不出产出题</b>，只做理解与朗读。
    </div>
    {#if receipt.repeats.length > 0}
      <!-- I-055 · 重复收集是重要信号（D-026），但**一条一个框**在 58 句时是灾难。
           压成一条摘要 + 可展开的清单：信号还在，屏幕不再被淹掉 -->
      <div class="notice warn" data-testid="repeat-warning">
        <b>★ 其中 {receipt.repeats.length} 条以前收过。</b>
        在真实阅读里又没认出来，比任何测试分数都硬 —— 它们会被送进攻坚区。
        <div style="margin-top:8px">
          <button
            class="btn sm"
            data-testid="repeat-toggle"
            onclick={() => (showRepeats = !showRepeats)}
            >{showRepeats ? '收起' : `看看是哪 ${receipt.repeats.length} 条`}{#if !showRepeats}<Ic n="caret" s={12} r="dn" />{/if}</button
          >
        </div>
        {#if showRepeats}
          <div style="margin-top:8px;max-height:40vh;overflow:auto">
            {#each receipt.repeats as r (r.priorItemId)}
              <div class="s3" data-testid="repeat-row" style="padding:3px 0">
                <b>{r.term}</b>　<span class="dim">第 {r.times} 次</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- ══ 正在贴 ══ -->
  {#if compose}
    {@const isOrig = compose.kind === 'original'}
    <div class="card blk" data-testid="compose">
      <h3>{isOrig ? '贴原文材料' : '贴我的收集'}</h3>
      <div class="s2">
        {#if isOrig}
          整篇交给 AI 拆：判层、去重、写解析、预生成题库。适合教材、论文、你打算系统学完的东西。
        {:else}
          你已经挑好的知识点。<b>原样入库，不拆、不去重、不改写</b>，也不出产出题。<b
            >每行一条</b
          >，空行会跳过。
        {/if}
      </div>

      {#if compose.error}
        <div class="errbox" data-testid="compose-error">
          <div class="h">没能收下</div>
          <div>{compose.error}</div>
        </div>
      {/if}

      <!-- I-037 · 从文件读。两个落区都能用 —— chunk 也可能是一份整理好的清单 -->
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
        <button class="btn sm" data-testid="pick-file" onclick={pickFile}>从文件读…</button>
        <span class="s3 dim">.txt · .md · .docx · .srt · .vtt</span>
      </div>
      {#if fetchNote}
        <div class="notice ok" style="margin-top:8px" data-testid="fetch-note">{fetchNote}</div>
      {/if}

      <input
        class="tin2"
        data-testid="compose-title"
        placeholder={isOrig ? '材料标题，例如 Ch1-Malthus' : '这批的名字，例如 7月读到的知识点'}
        bind:value={compose.title}
      />
      <textarea
        class="pastebox"
        data-testid="compose-text"
        placeholder={isOrig
          ? '把英文原文贴在这里…'
          : 'hold sway over\na far cry from\ngrasp the gravity of'}
        bind:value={compose.text}
      ></textarea>
      <div class="s2" data-testid="compose-count">
        {#if isOrig}
          {compose.text.length} 字
        {:else}
          {compose.text.split(/\r?\n/).filter((s) => s.trim()).length} 句
        {/if}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button
          class="btn pri"
          data-testid="compose-submit"
          disabled={compose.busy}
          onclick={submit}>{compose.busy ? '收下中…' : '收下'}</button
        >
        <button class="btn" data-testid="compose-cancel" onclick={() => (compose = null)}>取消</button
        >
      </div>
    </div>
  {/if}

  <!-- ══ 两个落区 · R-001 ══ -->
  {#if !compose && d.materials.length === 0}
    <!-- D-073 · 空状态是这个页面唯一任务变得极其明确的时刻，落区放大占满 -->
    <div class="drops">
      <div class="drop" data-testid="drop-original">
        <div class="i"><Ic n="lecture" s={26} /></div>
        <h3>原文材料</h3>
        <p>整篇交给 AI 拆 —— 判层、去重、写解析、出题</p>
        <div class="bs">
          <button class="btn pri" data-testid="drop-paste" onclick={() => open('original')}>粘贴文本</button>
          <button
            class="btn"
            data-testid="drop-file"
            onclick={() => {
              // I-073 · 原来这格是「从链接抓取」。抓取撤掉了，位置留给真能读的那条路。
              open('original')
              void pickFile()
            }}>从文件读入</button
          >
        </div>
        <div class="me"><span>教材 · 论文 · 长文</span><span>最多 5 份</span></div>
      </div>
      <div class="drop" data-testid="drop-chunk">
        <div class="i"><Ic n="fix" s={26} /></div>
        <h3>我的收集</h3>
        <p>你已经挑好的 —— 原样入库，不拆不改写</p>
        <div class="bs">
          <button class="btn" onclick={() => open('chunk')}>整段粘贴 · 每行一条</button>
        </div>
        <div class="me"><span>只做理解与朗读</span><span>不出产出题</span></div>
      </div>
    </div>
  {:else if !compose}
    <div class="matbar" data-testid="matbar">
      {#each d.materials as m (m.id)}
        <span class="mchip">
          <Ic n={m.kind === 'original' ? 'lecture' : 'fix'} s={11} />
          {m.title}
          <span class="dim">{m.kind === 'original' ? '原文' : '我的收集'}</span>
          <!--
            使用者 2026-08-10：「上传的文件可以删除（用小 × 表示）」。
            进垃圾箱，不是真删；而且**不动从它里面提出来的知识点** ——
            材料是来源，知识点是他学到的东西，删掉贴错的一份不该把学到的一起带走。
          -->
          <button
            class="mdel"
            title="删掉这份材料（进回收站，本 Lecture 的知识点不受影响）"
            aria-label="删掉这份材料"
            data-testid="del-material-{m.id}"
            onclick={() => (delMat = { id: m.id, title: m.title })}><Ic n="close" s={18} /></button>
        </span>
      {/each}
      <span class="mleft">
        原文 {d.materials.filter((m) => m.kind === 'original').length} / 5
      </span>
      <button class="btn sm" data-testid="add-original" onclick={() => open('original')}><Ic n="plus" s={16} /> 原文</button>
      <button class="btn sm" data-testid="add-chunk" onclick={() => open('chunk')}><Ic n="plus" s={16} /> 我的收集</button>
      {#if analysis.k === 'running'}
        <button class="btn sm" data-testid="analyze-cancel" onclick={cancelAnalyze}>暂停分析</button>
      {:else if pendingCount(d) > 0 && d.materials.some((m) => m.analyzedAt)}
        <!-- I-059 · 有跑完的、也有没跑的 = 上次中断了。直接给「继续」，
             不用再进一次指令面板 —— 那会让人以为要从头重来 -->
        <button class="btn sm pri" data-testid="analyze-resume" onclick={() => analyze()}
          >继续分析（还剩 {pendingCount(d)} 份）</button
        >
        <button class="btn sm" data-testid="analyze" onclick={() => (panel = !panel)}>分析 <Ic n="caret" s={12} r="dn" /></button>
      {:else}
        <button class="btn sm pri" data-testid="analyze" onclick={() => (panel = !panel)}>分析 <Ic n="caret" s={12} r="dn" /></button>
      {/if}
    </div>
  {/if}

  <!-- ★ 只剩「正在跑」留在原地 —— 跑完那句话去了回执条，4 秒自走，不用他点 -->
  {#if quoteBusy}
    <div class="notice" data-testid="quote-busy">正在给这个 Lecture 的知识点重新找出处…</div>
  {/if}

  {#if panel}
    <AnalyzePanel
      {lectureId}
      materials={d.materials}
      onrun={(extra, presetName, ids) => analyze(extra, presetName, ids)}
      onscope={(sc) => analyseScope(sc)}
      onquotes={() => void runQuoteMatch()}
      onclose={() => (panel = false)}
    />
  {/if}

  <!-- ══ 分析：进行中 / 失败 / 完成 ══════════════════════════════
       失败态排在最前面，永远优先于「空」和「进行中」（对着 I-001）。 -->
  {#if analysis.k === 'failed'}
    <div class="errbox" data-testid="analyze-error">
      <div class="h">{analysis.failure?.title ?? '分析失败了'}</div>
      <div style="white-space:pre-wrap">{analysis.failure?.detail ?? analysis.message}</div>
      {#if (analysis.failure?.consecutive ?? 0) >= CONSECUTIVE_FAIL_AT}
        <div style="margin-top:8px"><b>{CONSECUTIVE_FAIL_HINT}</b></div>
      {/if}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" data-testid="analyze-retry" onclick={() => analyze()}>重试</button>
        {#if analysis.failure?.actions.includes('settings') ?? true}
          <button class="btn sm" data-testid="analyze-settings" onclick={() => ongotoSettings?.()}
            >去设置</button
          >
        {/if}
      </div>
    </div>
  {:else if analysis.k === 'running'}
    <div class="card blk" data-testid="analyze-running">
      <h3>正在分析…</h3>
      <!-- I-104 · 进度条。一条一条写解析时，光有文字看不出「还要多久」 -->
      {#if analysis.stage && analysis.stage.materialTotal > 0}
        {@const pct = Math.round(
          (analysis.stage.materialIndex / analysis.stage.materialTotal) * 100
        )}
        <div class="apr" data-testid="analyze-progress" data-pct={pct}>
          <i style="width:{pct}%"></i>
        </div>
      {/if}
      <div class="s2">
        {#if analysis.stage}
          {analysis.stage.materialIndex} / {analysis.stage.materialTotal} ·
          <b>{STAGE_TEXT[analysis.stage.name]}</b>
          {#if analysis.stage.note}· {analysis.stage.note}{/if}
          <br /><span class="dim">《{analysis.stage.title}》</span>
        {:else}
          正在准备…
        {/if}
      </div>
      <div class="s2 dim" style="margin-top:8px">
        中途暂停不会作废已经跑出来的部分 —— 下次接着没做的那一条继续。
      </div>
    </div>
  {:else if analysis.k === 'done'}
    {@const r = analysis.result}
    {#if r.presetName}
      <!-- 一条都没提取到时**最**需要看见这行：是不是我把指令写太严了？
           所以它独立于结果好坏，只要给过指令就显示。 -->
      <div class="s2 dim" data-testid="analyze-preset" style="margin-bottom:8px">
        这次用的指令：<b>{r.presetName}</b>
      </div>
    {/if}
    {#if r.suspects}
      <!-- I-046 · 原句一个字没改，只是标出来 -->
      <div class="notice warn" data-testid="analyze-suspects" style="margin-bottom:8px">
        有 <b>{r.suspects}</b> 处看着像是打错或听岔了，已经标在对应条目上。
        <span class="dim">原句一个字都没动 —— 点进去确认了才改。</span>
      </div>
    {/if}
    {#if r.analysed || r.analyseFailed}
      <!-- I-043 · 分析时就把每条的完整解析写好了，点进去直接有 -->
      <div class="s2" data-testid="analyze-analysed" style="margin-bottom:8px">
        同时写好了 <b>{r.analysed ?? 0}</b> 条解析 —— 点进任何一条都是现成的。
        {#if r.analyseFailed}
          <span class="dim">有 {r.analyseFailed} 条没写成，进详情页点「重新生成解析」可以补。</span>
        {/if}
      </div>
    {/if}
    {#if r.added > 0 || r.derived > 0 || r.upgraded > 0}
      <div class="notice ok" data-testid="analyze-done">
        <b>新增 {r.added} 条</b>{#if r.derived > 0}，
          另从你收集的句子里<b>析出 {r.derived} 个成分</b>（原句一个字没动，析出项进了主动/被动）{/if}{#if r.upgraded > 0}，
          还有 {r.upgraded} 条从被动升为主动（两次扫描都命中）{/if}。
        分析了 {r.done}/{r.total} 份材料。
        {#if r.promptSource === 'builtin'}
          <br /><span class="dim">用的是内置提示词 —— prompts/analyze-material.md 没找到或读不出来。</span>
        {/if}
      </div>
    {:else if r.failures.length === 0}
      <div class="notice" data-testid="analyze-empty">
        <b>一条都没提取到。</b>
        材料可能太短，或者里面的知识点你已经全都在库里了 —— 不是出错，但也确实没有新东西。
      </div>
    {/if}
    {#each r.failures as f (f.materialId)}
      <div class="errbox" data-testid="analyze-partial-fail">
        <div class="h">《{f.title}》没分析成功 —— {f.failure.title}</div>
        <div style="white-space:pre-wrap">{f.failure.detail}</div>
        <div class="dim" style="margin-top:8px">其余 {r.done} 份的结果已经保留，没有作废。</div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn sm" onclick={() => analyze()}>重试这一份</button>
          <button class="btn sm" onclick={() => ongotoSettings?.()}>去设置</button>
        </div>
      </div>
    {/each}
    {#each r.repeats as rp (rp.priorItemId)}
      <div class="notice warn" data-testid="analyze-repeat">
        <b>★ 「{rp.term}」</b>{rp.note}。
      </div>
    {/each}

    <!--
      ★ I-115 · AI 的回复写到上限被切断了。

      以前这会让整份材料判失败，界面上是一行他看不懂的英文
      （`Expected ',' or ']' after array element in JSON at position 23050`），
      而 AI 其实已经干完了八成的活 —— 那些也跟着一起丢了。

      现在：救回来的照常收下，但**必须说出来**。
      少收了一半却不说，他会以为这篇文章就这么点东西。
    -->
    {#if r.truncated && r.truncated.length > 0}
      <div class="notice warn" data-testid="analyze-truncated">
        <b>有 {r.truncated.length} 处 AI 写到一半被截断了</b>
        <div class="s2" style="margin-top:6px">
          {#each r.truncated as t (t.title + t.got)}
            <span>{t.title}<span class="dim"> · 这一段收到 {t.got} 条</span></span>
          {/each}
        </div>
        <div class="s2 dim" style="margin-top:6px">
          截断之前的都已经收进来了，没有作废。长材料现在会自动分几段分析；
          还是断的话，把这份材料拆成两份再传，或者在设置里换一个输出更长的模型。
        </div>
      </div>
    {/if}

    <!--
      ★ 4.1 · 因为「以前删过 / 静默过」而没收进来的。
      少收几条却不说，他会以为分析漏了东西 ——
      而这恰恰是他自己以前的决定在起作用。所以要指名道姓，并说清在哪儿能改回来。
    -->
    {#if r.skipped.length > 0}
      <div class="notice" data-testid="analyze-skipped">
        <b>有 {r.skipped.length} 条按你以前的处理跳过了</b>
        <div class="s2" style="margin-top:6px">
          {#each r.skipped.slice(0, 12) as sk (sk.term)}
            <span
              >{sk.term}<span class="dim"
                > · {sk.verdict === 'silenced' ? '你收起过' : '你删过'}</span
              ></span
            >
          {/each}
          {#if r.skipped.length > 12}<span class="dim"> 还有 {r.skipped.length - 12} 条</span>{/if}
        </div>
        <div class="s2 dim" style="margin-top:6px">
          想让它们重新进来：设置 → 数据 → 「不再收录的知识点」里撤掉那一条。
        </div>
      </div>
    {/if}
  {/if}

  <!-- ══ 审阅这一批 · F-03 ══════════════════════════════════════
       它不是仪式，是门：点了这一讲才进入轮转，首次到期日 = 明天。
       不点也不催（D-028 / D-100），首页「接着上次」指回这里。 -->
  {#if d.lecture.status === 'review'}
    <div class="notice ok" data-testid="review-banner">
      <b>AI 提取了 {n.active + n.passive} 条，按置信度排好了 —— 最前面几条它自己也不确定。</b><br />
      看一遍，删掉不要的。<span class="dim">什么都不删也行，这一步只是让你过一眼。</span>
    </div>
  {/if}
  {#if startedInfo}
    <!-- ★★ F-2-②-e · 拒绝也是一种结果，而且要说对是哪一种：
         「已归档」被说成「已经在轮转中」，他会去轮转里找一个不在那儿的东西 -->
    <div
      class="notice {startedInfo.refused ? 'warn' : 'ok'}"
      data-testid="started-banner"
    >
      {#if startedInfo.refused}
        <span data-testid="started-refused">{startedInfo.reason}</span>
      {:else}
      <b>{startedInfo.count} 条{ROTATION_WORDS.schedule}了。</b>
      {startedInfo.reason}。
      <br />
      下一次产出练习：<b data-testid="started-due">{new Date(startedInfo.dueAt).toLocaleDateString('zh-CN')}</b>
      <span class="dim" data-testid="started-interval">· 间隔 {startedInfo.intervalDays} 天</span>
      {#if startedInfo.fresh > 0}
        <br /><span class="dim"
          >没见过就直接要求写出来，第一次作答测的是运气，不是产出能力 —— 那 {startedInfo.fresh}
          条现在就能在认读练习里过一遍。</span
        >
      {/if}
      {/if}
    </div>
  {/if}

  <!-- ══ 本讲知识点 ══ -->
  {@const silentCount = d.items.filter(isSilent).length}
  <div class="sec">
    <span class="en">本 Lecture 的知识点</span>
    <span style="font-family:var(--mono);letter-spacing:0;text-transform:none;font-weight:400"
      >{d.items.length - (showSilent ? 0 : silentCount)} 条</span
    >
    <!-- I-099 · 静默的默认不显示，但要能翻出来看 —— 它是终点，不是删除 -->
    {#if silentCount > 0}
      <button
        class="btn sm"
        style="margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400"
        data-testid="toggle-silent"
        onclick={() => (showSilent = !showSilent)}
        >{showSilent ? `隐藏不用再练的 ${silentCount} 条` : `另有 ${silentCount} 条不用再练 · 显示`}</button
      >
    {/if}
  </div>

  <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
    <div class="tabs">
      <button class:on={tab === 'self'} onclick={() => (picked = 'self')} data-testid="tab-self"
        >我的收集<span class="n">{n.self}</span></button
      >
      <button class:on={tab === 'active'} onclick={() => (picked = 'active')} data-testid="tab-active"
        >写作层<span class="n">{n.active}</span></button
      >
      <button
        class:on={tab === 'passive'}
        onclick={() => (picked = 'passive')}
        data-testid="tab-passive">理解层<span class="n">{n.passive}</span></button
      >
    </div>
  </div>

  {#if shown(d.items).length === 0}
    <div class="empty" data-testid="items-empty">
      <!-- ★ B10 · 空态是白名单里的第三处。星是**第二眼才看见**的东西，不解释功能 -->
      <Stars />
      <div class="i"><Ic n="vault" s={26} /></div>
      {#if d.items.length === 0}
        <h4>还没有知识点</h4>
        <p>贴一份材料，或者把你的收集贴进来。</p>
      {:else if !showSilent && d.items.filter((i) => !isSilent(i)).length === 0}
        <!-- 整讲都静默了 —— 这是好事，别让它看起来像空的 -->
        <h4>这个 Lecture 全部练完了</h4>
        <p>{d.items.length} 条都通过了全部检验，不再排进练习。上面那个按钮可以翻出来看。</p>
      {:else}
        <h4>这个 Tab 是空的</h4>
        <p>本 Lecture 有 {d.items.length - (showSilent ? 0 : silentCount)} 条，都在别的 Tab 里。</p>
      {/if}
    </div>
  {:else}

    <!-- 翻出已静默的那些时，SelBar 给的该是「打回轮转」——
         再点一次「静默」等于什么都没发生 -->
    <SelBar
      ids={selected}
      allIds={shown(d.items).map((x) => x.id)}
      onselectall={(next) => (selected = next ?? [])}
      silentScope={showSilent}
      onclear={() => (selected = [])}
      onchanged={async (note) => {
        say(note)
        selected = []
        await load()
      }}
      onreading={ontestItems}
      onpractice={onpracticeItems}
    />

    <!-- ★ D-484 · 清单 8 的目标：析出的知识点那一栏（讲次工作台的右半） -->
    <div data-testid="item-rows" data-guide="lecture-split">
      {#each shown(d.items) as it (it.id)}
        <!-- 结构与总原型 lrender() 逐层一致：标记 · 勾选框 · 词条 · 释义 · 层级 · ••• -->
        <div
          class="lrow"
          class:sel={selected.includes(it.id)}
          role="button"
          tabindex="0"
          data-testid="row-{it.id}"
          onclick={() => onopenitem?.(it.id)}
          onkeydown={(e) => e.key === 'Enter' && onopenitem?.(it.id)}
        >
          <span>
            {#if it.recollected > 0}
              <SrcBadge kind="recollected" count={it.recollected} />
            {:else if it.source === 'both'}
              <SrcBadge kind="both" />
            {/if}
          </span>
          <!-- I-098 ·「所有词条都有复选框可以点击」。这个 .ck 一直是死的占位符 -->
          <span
            class="ck"
            role="checkbox"
            aria-checked={selected.includes(it.id)}
            tabindex="0"
            aria-label="选中 {it.term}"
                  data-testid="ck-{it.id}"
            onclick={(e) => {
              e.stopPropagation()
              toggleSel(it.id)
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                toggleSel(it.id)
              }
            }}
          ><Ic n="check" s={10} /></span>
          <!--
            ★★ A-3（2026-09-03 UI 审计）· 这个记号原来是 `.lrow` 的**独立子元素**，
            而 `.lrow` 是 **6 列网格**。它一出现就多出第 7 个子元素 ——
            整排右移一格：**释义被挤进 74px 那一列**（截断成「very differe…」），
            **末尾的箭头被挤到第二行**（行高 32 → 56）。139 条**全部**中招。

            ★★★ 第一版我把记号塞进了 `.lt` 里面 —— **那是错的**：
            右键取词时 `.lt` 的文本被图标污染，「这条已经在库里」判不出来，
            于是「加入」又冒出来了（`study.test.ts` 当场抓到）。
            **`.lt` 必须只有词条本身。** 所以外面套一层 `.lt-cell` 占那一格。
          -->
          <span class="lt-cell">
            <span class="lt">{it.term}</span>
            {#if it.hasSuspect}
              <span
                class="fixmark"
                title="这条可能打错或听岔了 —— 点进去看建议"
                data-testid="fixmark-{it.id}"><Ic n="fix" s={16} /></span
              >
            {/if}
          </span>
          <!--
            ★ 6.2 · 「打错了 / 听岔了，需要修改」的记号。
            使用者：「分析后若系统判定该知识点为打错或听岔了、需要修改，
                     则在知识点上显示一个小图标。用户修改完成后，图标自动消失。」
            记号直接由「还有没有 suspect 区块」决定 —— 改完最后一条，
            区块整块删掉，记号自己就没了。不另设「已处理」位：
            两个位一定会有对不上的那天，而对不上的时候人只会看见一个假记号。
          -->
          <span class="lg">
            {#if it.derivedCount > 0}
              <!-- D-148 · 整句拆解：原句唯一能提供的独特价值，就是列出它拆出了什么 -->
              已析出 {it.derivedCount} 个成分
            {:else}{it.gloss || '—'}{/if}
          </span>
          <span class="ln {it.layer === 'B' ? 'a' : 'p'}">{it.layer === 'B' ? '写作层' : '理解层'}</span>
          {#if d.lecture.status === 'review'}
            <button
              class="dt3 xbtn"
              title="删掉这条"
              aria-label="删掉 {it.term}"
              data-testid="drop-{it.id}"
              onclick={(e) => {
                e.stopPropagation() // 整行现在可点进详情，删除按钮不能跟着一起触发
                dropItem(it.id)
              }}><Ic n="close" s={18} /></button
            >
          {:else}
            <span class="dt3"><Ic n="more" s={18} /></span>
          {/if}
        </div>
        {#if it.quote && it.quote !== it.term}
          <!-- M-012 · 原文出处是不可丢失的字段，那就让它看得见 -->
          <div class="quo">{it.quote}</div>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- ══ 出口 ══ -->
  {#if d.lecture.status === 'review'}
    <div style="margin-top:18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn pri" disabled={starting} data-testid="start-learning" onclick={startLearning}
        >{starting ? '正在开始…' : '这批我看过了 · 开始学'}</button
      >
      <span class="dim" style="font-size:var(--fs-2)">点了才排进练习 · 不点也不会催你</span>
    </div>
  {:else if d.lecture.status === 'training'}
    <div style="margin-top:18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <!--
        ★★ T-4.13 / D-R28（使用者 2026-09-07）· 一排四个入口，分成**两种**：

        前两个按日程走（认读取的是**到期卡**，所以标「推荐」）；
        后两个不看到期日（I-061 那条路，以前只在树的右键菜单里，讲次页够不着）。
        判分与排期更新两边**一模一样** —— 练了就算数，区别只在「谁挑的题」。
      -->
      <button class="btn pri" data-testid="go-reading" onclick={() => onstudy?.('reading')}
        >认读练习 · 推荐</button
      >
      <button class="btn" data-testid="go-practice" onclick={() => onstudy?.('practice')}
        >产出练习</button
      >
      <button
        class="btn sm"
        data-testid="lecture-test"
        onclick={() => ontest?.([lectureId], 'reading')}>随时认读…</button
      >
      <button
        class="btn sm"
        data-testid="lecture-test-practice"
        onclick={() => ontest?.([lectureId], 'practice')}>随时练习…</button
      >
      <!-- I-053 · 导出不只在下拉框里 -->
      <button class="btn sm" data-testid="lecture-export" onclick={exportLecture}>导出笔记</button>
      {#if d.lecture.dueAt}
        <span class="dim" style="font-size:var(--fs-2)"
          >下次到期：{new Date(d.lecture.dueAt).toLocaleDateString('zh-CN')}</span
        >
      {/if}
    </div>
    <!-- ★ T-4.13 · 「推荐」和「可练」当面分清楚：这一句就是那条产品规则本身 -->
    <div class="dim" style="font-size:var(--fs-1);margin-top:6px" data-testid="anytime-note">
      「推荐」＝ 今天到期的那些。<b>不到期也能练</b> —— 点「随时认读 / 随时练习」，
      判分照样算数，排期跟着更新。
    </div>
  {/if}
{/if}

<!-- ★ B5 · 删材料的确认框。标题给对象名，正文说**真正会发生什么**；
     不写「不可撤销」「永久删除」—— 那是假的（软删进回收站，保留期内可恢复）。 -->
{#if delMat}
  <Dialog
    testid="del-material-dlg"
    title={`删除《${delMat.title}》？`}
    body={`移到回收站，${TRASH_KEEP_TEXT}。已经从它里面提出来的知识点不受影响。`}
    confirmLabel="删除"
    danger
    onconfirm={() => delMaterial(delMat!.id, delMat!.title)}
    oncancel={() => (delMat = null)}
  />
{/if}
