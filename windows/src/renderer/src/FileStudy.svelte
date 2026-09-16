<script lang="ts">
  import Skel from './Skel.svelte'
  import { askGuide } from './guide.svelte.ts'
  import { TRASH_KEEP_TEXT } from '@core/sql/trash.ts'
  import Dialog from './Dialog.svelte'
  import { sayBad, sayUndo } from './toast.svelte.ts'
  import type {
    ChatMessage,
    Failure,
    FileDetail,
    FileRow,
    GenreRow,
    TreeProject,
    TutorRow
  } from '@shared/api.ts'
  import { cleanMessage, parseFailure } from '@shared/api.ts'
  import { reportError } from './errors.ts'
  import PathPicker from './PathPicker.svelte'
  // 这里已经有一个叫 paragraphs 的本地函数（渲染 AI 回答用），所以改个名
  import { paragraphs as docParagraphs } from '@core/paragraphs.ts'
  import { markSaved } from '@core/mark-saved.ts'
  import Ic from './Ic.svelte'
  import { registerEsc } from './esc-stack.svelte.ts'

  let {
    tree,
    ongotoSettings,
    /**
     * I-064 · 把「这篇文章归到哪一讲」报上去。
     * 右键菜单的「收进本 lecture」要用它 —— 在文件学习页里，
     * 「本 lecture」指的是这篇文章设的那个路径，不是侧边栏选中的东西。
     */
    oncurrent,
    /**
     * I-081 · Findings 里的每一条都能点进详情页。
     * 使用者：「捞出来的知识点应该能点，点了看到它的完整解析。」
     * 以前这里只是一行死文字 —— 捞出来之后就断了，只能去知识库里再搜一遍。
     */
    onopen
  }: {
    tree: TreeProject[]
    ongotoSettings?: () => void
    oncurrent?: (lectureId: number | null) => void
    onopen?: (itemId: number) => void
  } = $props()

  type View =
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | { k: 'list'; files: FileRow[] }
    | { k: 'read'; d: FileDetail }

  let view = $state<View>({ k: 'loading' })
  let tutors = $state<TutorRow[]>([])
  let tutorId = $state<number | null>(null)
  let tab = $state<'tut' | 'fnd'>('tut')

  /**
   * D-484 · 清单 9 · 两种读法的切换那一块**真出现在屏上**时才问（T-2）。
   *
   * ★★ 为什么不在 `App.svelte` 按路由问：走查量到那一条**每次都放弃** ——
   *   进「文件学习」时还没打开任何文件，那两个 Tab 根本没渲染，
   *   浮层量不到目标就静默放弃了。（是 T-3 那行 warn 把它抓出来的，
   *   屏上一声不响，`check:guide-ids` 也绿 —— 它只证明两头都在，不证明碰得上。）
   * ★ 所以触发跟着**那一块自己的渲染条件**走：`tab === 'tut'` 时它就在屏上。
   *   「进页面即出」的本意是「那个块出现在屏上就出」，不是「路由一变就问」。
   */
  $effect(() => {
    if (tab !== 'tut') return
    void askGuide('filestudy-modes')
  })
  let draft = $state('')
  let sending = $state(false)
  let chatError = $state<{ failure: Failure | null; message: string } | null>(null)
  /** I-094 ·「贴一篇」改成弹窗（使用者要的）。顺带在弹窗里就能把路径定好 —— 
      以前是收下之后再被一条黄条催着去设，多绕一步 */
  let compose = $state<{ title: string; text: string; lectureId: number | null } | null>(null)
  let addError = $state<string | null>(null)
  let highlight = $state<number | null>(null)

  // ── I-093 · 三段式路径（项目___▾ 单元___▾ Lecture___▾）───────
  let picking = $state(false)

  /**
   * ★ D-440 · 这两个弹窗以前**按 Esc 关不掉**（2026-09-03 真机扫描扫出来的）。
   *
   * 后果比「少一个快捷键」大：`.ov` 是整屏遮罩，弹窗开着时侧边栏点不动 ——
   * 不知道要点遮罩的人，看到的就是「软件不动了」。那次扫描里 34 个「点不动」
   * 全是这一个弹窗挡出来的。
   *
   * 顺序：选位置压在贴文章之上，所以**先关上面那层**，一次只退一层。
   */
  $effect(() =>
    registerEsc(() => {
      if (picking) { picking = false; return true }
      if (compose) { compose = null; return true }
      return false
    })
  )

  async function loadList(): Promise<void> {
    oncurrent?.(null) // 回到列表就没有「本 lecture」了
    try {
      const [files, ts, gs] = await Promise.all([
        window.nyx.files.list(),
        window.nyx.files.tutors(),
        window.nyx.files.genres()
      ])
      tutors = ts
      tutorId ??= ts.find((t) => t.isDefault)?.id ?? ts[0]?.id ?? null
      genres = gs
      genreUid ??= gs.find((g) => g.isDefault)?.uid ?? gs[0]?.uid ?? null
      view = { k: 'list', files }
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }
  loadList()

  async function open(id: number): Promise<void> {
    try {
      const d = await window.nyx.files.detail(id)
      view = { k: 'read', d }
      // I-064 · 在这一页里，「本 lecture」= 这篇文章设的路径
      oncurrent?.(d.file.lectureId ?? null)
      tab = 'tut'
      chatError = null
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  async function addFile(): Promise<void> {
    if (!compose) return
    if (!compose.text.trim()) {
      addError = '还没有内容 —— 把文章正文贴进来。'
      return
    }
    try {
      const id = await window.nyx.files.add(compose.title, compose.text, compose.lectureId)
      compose = null
      addError = null
      await loadList()
      await open(id)
    } catch (err) {
      addError = cleanMessage(err)
    }
  }

  // ── I-039 · 这一块的四处缺口 ──────────────────────────────
  /** 「无论问它什么它都给我布置任务」—— 现在使用者说了算 */
  /**
   * ★ 5.2 · 两个互斥的模式，取代原来的「带练 / 只答疑」。
   *   · Enlighten（理解）—— 选导师，只讲不考
   *   · Quest（思考）   —— 选体裁，只考不讲
   * 互斥不是 UI 上的限制，是这两件事本身互斥：同时做等于两件都做不专。
   */
  let chatMode = $state<'enlighten' | 'quest'>('enlighten')
  let genreUid = $state<string | null>(null)
  let genres = $state<GenreRow[]>([])

  /**
   * ★ Quest 的「回顾之前的问题卡片」。
   *
   * `null` = 停在最新那一张（正常状态）。
   * 点了上面某个「第 N 题」就把它设成 N —— 这时候只显示那一张卡和它的线程，
   * **输入框收起来**：往回翻的时候还能打字，打出来的话会挂到那张老卡上，
   * 而他以为是在问当前这题。回顾就是回顾，要退回来才能继续问。
   */
  let reviewNo = $state<number | null>(null)

  /** 当前模式那条流。两边完全分开 —— 切过去看见的是另一条对话 */
  const modeMsgs = $derived(
    view.k === 'read' ? view.d.messages.filter((m) => m.mode === chatMode) : []
  )
  /** Quest 里已经出过的题号 */
  const cards = $derived([
    ...new Set(
      modeMsgs.filter((m) => m.kind === 'task' && m.questNo !== null).map((m) => m.questNo as number)
    )
  ])
  /** 当前停在第几题。0 = 还没出过题 */
  const curNo = $derived(cards.length > 0 ? Math.max(...cards) : 0)
  /**
   * 屏幕上该显示哪些消息。
   * Enlighten：整条流。
   * Quest：回顾某一题时只显示那一题的线程；否则显示全部（他要看得见来龙去脉）。
   */
  const shown = $derived(
    chatMode === 'quest' && reviewNo !== null
      ? modeMsgs.filter((m) => m.questNo === reviewNo)
      : modeMsgs
  )

  /**
   * I-073 · 只留「从文件读」。链接抓取入口已删除 ——
   * 真实网页的正文提取不可靠，与其留一个大概率失败的按钮，不如说清不支持。
   */
  let importNote = $state<string | null>(null)

  async function pickFile(): Promise<void> {
    if (!compose) return
    importNote = null
    addError = null
    try {
      const d = await window.nyx.ingest.pickFile()
      if (!d) return
      if (!compose.title.trim()) compose.title = d.title.slice(0, 60)
      compose.text = d.text
      importNote = `读到 ${d.chars} 字。${d.note ?? '先扫一眼，不对直接在框里改。'}`
    } catch (err) {
      addError = cleanMessage(err)
    }
  }

  /** 就地分析这一篇，范围仅限它 */
  let analysing = $state(false)
  let analyseNote = $state<string | null>(null)
  let analyseErr = $state<string | null>(null)

  async function analyseFile(): Promise<void> {
    if (view.k !== 'read') return
    const fileId = view.d.file.id
    analysing = true
    analyseNote = null
    analyseErr = null
    try {
      const r = await window.nyx.files.analyse(fileId)
      analyseNote =
        `捞到 ${r.added} 条` +
        (r.analysed ? `，同时写好了 ${r.analysed} 条解析` : '') +
        (r.failures.length ? `，${r.failures.length} 处失败` : '') +
        '。'
      view = { k: 'read', d: await window.nyx.files.detail(fileId) }
    } catch (err) {
      analyseErr = cleanMessage(err)
    } finally {
      analysing = false
    }
  }

  /**
   * I-064 · 把 AI 的一坨回答切成段。
   *
   * 只做三件事，**不引 Markdown 库**：按空行断段、`**粗** / \`码\`` 就地渲染、
   * 列表行标出来给悬挂缩进。多了就会开始跟总原型的排版打架。
   *
   * 转义在前、加标签在后 —— 顺序反了就是 XSS。AI 的输出同样是不可信输入。
   */
  function paragraphs(raw: string): { html: string; bullet: boolean }[] {
    const esc = (t: string): string =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return raw
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((block) =>
        block.split('\n').map((line) => {
          const bullet = /^\s*([-*•]|\d+[.)])\s+/.test(line)
          const body = line.replace(/^\s*([-*•]|\d+[.)])\s+/, '')
          const html = esc(body)
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
          return { html, bullet }
        })
      )
  }

  async function send(questNext = false): Promise<void> {
    if (view.k !== 'read') return
    // 点「下一个问题」时他没打字 —— 那一路不要求 draft 有内容
    if (!questNext && !draft.trim()) return
    const id = view.d.file.id
    const text = questNext ? '' : draft
    sending = true
    chatError = null
    if (!questNext) draft = ''
    try {
      const messages = await window.nyx.files.chat(id, text, tutorId, chatMode, genreUid, questNext)
      if (view.k === 'read') view = { k: 'read', d: { ...view.d, messages } }
      // 出了新卡就跳到它 —— 他点「下一个问题」就是要看那一张
      if (questNext) reviewNo = null
    } catch (err) {
      chatError = { failure: parseFailure(err), message: cleanMessage(err) }
      // D-205 · 失败不吞数据。他写的那句已经落库了，界面上也要能看见（刷新一下拿回来）
      try {
        view = { k: 'read', d: await window.nyx.files.detail(id) }
      } catch {
        /* 拿不回来就算了，至少错误是看得见的 */
      }
    } finally {
      sending = false
    }
  }

  /**
   * 删一篇文章（使用者 2026-08-10）。
   * 先问一句，并说清后果 —— 不说清楚他不敢点，等于没这个功能。
   */
  /** ★ B5 / X-09 · 系统 `confirm()` 换成应用内 Dialog（它在 Electron 里会卡住渲染进程）*/
  let delFileAsk = $state<{ id: number; title: string } | null>(null)

  async function delFile(id: number, title: string): Promise<void> {
    delFileAsk = null
    try {
      await window.nyx.files.remove(id)
      await loadList()
      sayUndo(
        `删掉了《${title}》，${TRASH_KEEP_TEXT}`,
        async () => {
          await window.nyx.browse.restore('file', id).catch((e) => {
            throw new Error(`没能恢复：${cleanMessage(e)}`)
          })
          await loadList()
        },
        `《${title}》已从回收站恢复`
      )
    } catch (err) {
      view = { k: 'error', message: cleanMessage(err) }
    }
  }

  async function setPath(lectureId: number): Promise<void> {
    picking = false
    if (view.k !== 'read') return
    try {
      await window.nyx.files.setPath(view.d.file.id, lectureId)
      // 改完重读 —— 界面上显示的归属就是库里的归属，不做乐观更新
      await open(view.d.file.id)
    } catch (err) {
      // 归属没改成，页面本身还好好的：不把整页打成错误态，走统一错误条
      reportError(err, '这篇文章的归属没改成')
    }
  }

  /**
   * 「转为 lecture」已按使用者 5.2 取消（2026-08-09）。
   *
   * 它解决的是「这篇文章想当正式材料学」——但文件学习本来就能就地分析、
   * 捞到的条目直接进设好的那一讲。多一条把正文再复制一份进 lecture 的路，
   * 结果是同一篇正文在库里有两份，原文出处到底该指哪一份说不清。
   * D-172 那条就此作废，`convertedLectureId` 只留作老数据的展示。
   */

  async function mark(status: 'unread' | 'reading' | 'shelved' | 'done'): Promise<void> {
    if (view.k !== 'read') return
    try {
      await window.nyx.files.setStatus(view.d.file.id, status)
      await open(view.d.file.id)
    } catch (err) {
      reportError(err, '这篇文章的阅读状态没改成')
    }
  }

  /**
   * 5.1 · 「上传内容必须自动分段，禁止整段文字粘连在一起。」
   *
   * 逻辑在 `core/paragraphs.ts`（纯逻辑、有测试）。以前这里只按空行切 ——
   * 从 PDF / 网页 / 字幕粘来的正文常常**一个空行都没有**，
   * 于是整篇渲染成一堵墙，而且「跳到第 3 段」这类定位全部失效
   * （任务卡的 para 就靠它）。
   */
  const paras = docParagraphs

  /**
   * ══ 4.1 · 字号（使用者 2026-09-13）════════════════════════════
   * 「增加字号调整功能，用户应该可以根据自己的需要调整文件学习页面中的文字大小。」
   *
   * ★ 存这台机器（`ui.fileStudy.fontScale` → `settings`，不同步）：
   *   他在这台电脑上看着舒服的字号，没道理跟着同步跑到手机上去。
   * ★ 只动**这一篇正文**（`.doc` 上的一个 CSS 变量），不动整个软件 ——
   *   他说的是「文件学习页面中的文字大小」，不是全局缩放。
   */
  const SCALES = [0.9, 1, 1.15, 1.3, 1.5, 1.75]
  let scaleAt = $state(1)
  const scale = $derived(SCALES[scaleAt] ?? 1)

  window.nyx.ui
    .get('ui.fileStudy.fontScale')
    .then((v) => {
      const i = SCALES.indexOf(Number(v))
      if (i >= 0) scaleAt = i
    })
    .catch(() => {
      /* 读不出来就用默认那一档 —— 字号读不到不该影响读文章 */
    })

  function bumpScale(d: number): void {
    const next = Math.max(0, Math.min(SCALES.length - 1, scaleAt + d))
    if (next === scaleAt) return
    scaleAt = next
    // ★ 存不上不出声：他眼前那一档已经变了，为一次存档失败弹一句话是替软件表功
    window.nyx.ui.set('ui.fileStudy.fontScale', String(SCALES[next])).catch(() => {})
  }

  /**
   * ══ 4.4 · 已经收进 Nyx 的，在原文里要看得出来 ══════════════════
   * 切块判据在 `core/mark-saved.ts`（纯逻辑、有用例）——
   * 标错了他会以为某个词收过了、于是不收，那是数据层面的误导，不是难看。
   * ★ `$derived`：只在**这篇文章或 Findings 变了**的时候重算，
   *   不是每次重绘都把整篇扫一遍。
   */
  const savedTerms = $derived(
    view.k === 'read' ? view.d.findings.map((f) => f.term).filter((t) => !!t) : []
  )
  const marked = $derived(
    view.k === 'read' ? paras(view.d.file.content).map((p) => markSaved(p, savedTerms)) : []
  )

  /**
   * ══ 4.3 · Save 成功 → Findings 立即更新 ═══════════════════════
   * 他的原话：不许「Save → 当前页面看不到 → 刷新 / 去别的页面 → 再回来才出现」。
   *
   * 右键菜单（`Capture.svelte`）是全局组件，落库之后广播一声 `nyx:item-added`，
   * 这里听见就重新拉一次详情。
   * ★ **只换 `d`，不碰 `tab`** —— 走 `open()` 会把他从 Findings 页拽回 Tutorial，
   *   而他刚收完东西，正要看的就是 Findings。
   * ★ 不是本篇那一讲的就不管：别的屏收东西，不该让他这一页闪一下。
   */
  $effect(() => {
    const h = (e: Event): void => {
      if (view.k !== 'read') return
      const to = (e as CustomEvent<{ lectureId?: number }>).detail?.lectureId
      if (to !== undefined && to !== view.d.file.lectureId) return
      const id = view.d.file.id
      window.nyx.files
        .detail(id)
        .then((d) => {
          if (view.k === 'read' && view.d.file.id === id) view = { k: 'read', d }
        })
        .catch(() => {
          /**
           * ★ 这一处**不许静默**。刷不出来的话，他刚 Save 的那条就是看不见 ——
           *   而「Save 了却看不见」正是 4.3 这条需求要治的症状本身。
           *   什么都不说，屏幕上和这个 bug 没修一模一样。
           * ★ 话要说全两件事：**东西收进去了**（别让他再 Save 一遍）、
           *   **怎么才能看到**（切走再回来）。
           */
          sayBad('收进去了，只是这一页没刷新出来 —— 切走再回来就能看到')
        })
    }
    window.addEventListener('nyx:item-added', h)
    return () => window.removeEventListener('nyx:item-added', h)
  })

  /**
   * 文章的状态 · I-095
   *
   * 使用者：「应该出现不同状态的吧，比如在读以及读完还有什么呢。」
   * 加了「搁置」。理由不是凑数：读了一半不读了这件事一定会发生，
   * 没有这个去处的话，那些文章会一直挂在「在读」里 ——
   * 「在读」这一组一旦失真，它就没有任何用了。
   *
   * 没有再加更多：「已捞完」这类看着合理，但它是**析出条数**的派生结果，
   * 卡片上直接显示数字就够了，不必让人再手动维护一个状态。
   */
  const STATUS = { reading: '在读', unread: '未读', shelved: '搁置', done: '读完' } as const
  type St = keyof typeof STATUS
  const ORDER: St[] = ['reading', 'unread', 'shelved', 'done']
  /** 5.1 · 状态按钮重做：各自一个记号 + 一句说明，层次才出得来 */
  const STATUS_ICON = { reading: '▶', unread: '○', shelved: '⏸', done: '✓' } as const
  const STATUS_HINT = {
    reading: '正在读它 —— 列表里默认展开的就是这一组',
    unread: '还没开始',
    shelved: '先放一放，不催',
    done: '读完了，进档案'
  } as const

  /**
   * 只有「在读」默认展开（使用者明确要的）。
   * 那一组才是今天要动的东西；未读是待办、搁置和读完是档案，
   * 一进来全摊开等于什么都没突出。
   */
  let openGroups = $state<St[]>(['reading'])
  const toggleGroup = (st: St): void => {
    openGroups = openGroups.includes(st) ? openGroups.filter((x) => x !== st) : [...openGroups, st]
  }
  const taskTitle = (m: ChatMessage): string => m.content.split('\n')[0] ?? '任务'
  const taskBody = (m: ChatMessage): string => m.content.split('\n').slice(1).join('\n')
</script>

{#if view.k === 'error'}
  <div class="errbox" data-testid="fs-error">
    <div class="h">文件学习打不开</div>
    <div style="white-space:pre-wrap">{view.message}</div>
    <div style="margin-top:12px"><button class="btn sm" onclick={loadList}>重试</button></div>
  </div>
{:else if view.k === 'loading'}
  <div class="card blk"><Skel rows={4} widths={['w70', 'w100', 'w85', 'w55']} testid="files-skel" /></div>
{:else if view.k === 'list'}
  <div class="vh">
    <h1>文件学习</h1>
    <span class="c">{view.files.length} 份</span>
    <div class="sp"></div>
    <button class="btn sm" data-testid="fs-add" onclick={() => (compose = { title: '', text: '', lectureId: null })}
      ><Ic n="plus" s={16} /> 贴一篇</button
    >
  </div>

  <div class="notice" data-testid="fs-note">
    <b>这条路是「你自己读，边读边捞」。</b>
    右边的导师能看到整篇文章 —— 直接问它，不用把原文贴给它。<br />
    <span class="dim"
      >另一条路是 lecture 的「原文材料」：整篇交给 AI 拆。两条终点相同，前期用途不同。</span
    >
  </div>

  <!-- I-094 ·「贴一篇」是弹窗，不再把列表整块往下推 -->
  {#if compose}
    {@const c = compose}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="ov on" data-testid="fs-compose" onclick={() => (compose = null)}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="mbox" style="width:min(680px,100%)" onclick={(e) => e.stopPropagation()}>
        <h3>贴一篇文章</h3>
        <div class="ms">读的时候边读边捞。整篇交给 AI 拆是另一条路（lecture 的「原文材料」）。</div>
        {#if addError}
          <div class="errbox" data-testid="fs-add-error"><div class="h">没能收下</div><div>{addError}</div></div>
        {/if}
        <!-- I-073 · 只留「从文件读」。链接抓取入口已删除 -->
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
          <button class="btn sm" data-testid="fs-pick-file" onclick={pickFile}>从文件读…</button>
          <span class="s3 dim">.txt · .md · .docx · .srt · .vtt</span>
        </div>
        {#if importNote}
          <div class="notice ok" style="margin-bottom:8px" data-testid="fs-import-note">{importNote}</div>
        {/if}

        <input class="tin2" placeholder="标题" data-testid="fs-title" bind:value={c.title} />
        <textarea
          class="pastebox"
          data-testid="fs-text"
          placeholder="把文章正文贴在这里…"
          bind:value={c.text}
        ></textarea>

        <!-- I-093 · 路径在这里就能定，不用收下之后再被催一次 -->
        <div style="margin-top:14px">
          <PathPicker {tree} value={c.lectureId} label="归到" onpick={(id) => (c.lectureId = id)} />
          <div class="s3 dim" style="margin-top:6px">
            可以先留空 —— 但捞到的知识点需要有地方去，之后还是要设。
          </div>
        </div>

        <div class="mact">
          <button class="btn" data-testid="fs-cancel" onclick={() => (compose = null)}>取消</button>
          <button class="btn pri" data-testid="fs-save" onclick={addFile}>收下</button>
        </div>
      </div>
    </div>
  {/if}

  {#if view.files.length === 0 && !compose}
    <!--
      I-039 ·「进入的时候没有界面，让我选择路径和粘贴文件」——
      空态要给一个直接能按的入口，不要只说一句「还没有文章」。**这条不动。**

      ★ F-1（2026-09-03 UI 审计）改的是**位置**：那颗大按钮原来浮在空态框
        **外面上方**，于是屏幕上出现两颗互不相干的「贴一篇」——
        页头一颗、半空中一颗。挪进空态框里，它就成了那句话的下一步，
        和页头那颗是「常驻动作」与「此刻该做的事」的关系，不再是重复。
    -->
    <div class="empty" data-testid="fs-empty">
      <div class="i"><Ic n="lecture" s={26} /></div>
      <h4>还没有文章</h4>
      <p>适合长文、书，或者你只想要其中几段的东西。</p>
      <div style="margin-top:16px">
        <button class="btn pri" data-testid="fs-add-empty" onclick={() => (compose = { title: '', text: '', lectureId: null })}
          >贴一篇文章 · 或从文件 / 链接导入</button
        >
      </div>
    </div>
  {:else}
    {#each ORDER as st (st)}
      {@const group = view.files.filter((f) => f.status === st)}
      {#if group.length > 0}
        <!-- D-167 · 按状态分组。I-095 · 除「在读」外默认收起 -->
        <div
          class="ugrp fold-head"
          role="button"
          tabindex="0"
          data-testid="fs-group-{st}"
          onclick={() => toggleGroup(st)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleGroup(st)
            }
          }}
        >
          {STATUS[st]} · {group.length}
          <span class="fold-car" class:open={openGroups.includes(st)}><Ic n="caret" s={12} /></span>
        </div>
        {#each openGroups.includes(st) ? group : [] as f (f.id)}
          <div
            class="fcard"
            role="button"
            tabindex="0"
            data-testid="fs-card-{f.id}"
            onclick={() => open(f.id)}
            onkeydown={(e) => e.key === 'Enter' && open(f.id)}
          >
            <span class="ic">📄</span>
            <div>
              <div class="nm">{f.title}</div>
              <div class="pa" style={f.lectureId ? '' : 'color:var(--amber)'}>
                {#if f.convertedLectureId}已转为 lecture ·{/if}
                {f.lectureName ?? '⚠ 未设路径'}
              </div>
            </div>
            <span class="pr">{f.messages > 0 ? `${f.messages} 轮` : '—'}</span>
            <!--
              使用者 2026-08-10：「上传的文件可以删除（用小 × 表示）」。
              进回收站、{TRASH_KEEP_TEXT}；聊天记录跟着这篇走，恢复时一起回来。
              `stopPropagation` 是必须的 —— 外面那层点了会打开这篇文章。
            -->
            <button
              class="fdel"
              title={`删掉这篇（进回收站，${TRASH_KEEP_TEXT}）`}
              aria-label="删掉这篇"
              data-testid="del-file-{f.id}"
              onclick={(e) => {
                e.stopPropagation()
                delFileAsk = { id: f.id, title: f.title }
              }}><Ic n="close" s={18} /></button>
            <span class="dt3"><Ic n="caret" s={12} /></span>
          </div>
        {/each}
      {/if}
    {/each}
  {/if}
{:else}
  {@const d = view.d}
  <span
    class="bk"
    role="button"
    tabindex="0"
    data-testid="fs-back"
    onclick={loadList}
    onkeydown={(e) => e.key === 'Enter' && loadList()}><Ic n="back" s={16} /> 返回文件学习</span
  >
  <div class="vh" style="margin-top:10px">
    <h1 style="font-size:var(--fs-6)">{d.file.title}</h1>
    <span class="c">{STATUS[d.file.status]}</span>
    <div class="sp"></div>
    <!--
      ★ 5.1 · 四个状态按钮重做。
      原来是四个等宽的灰按钮挤在一起，四个都长一样 ——
      「现在是哪个状态」和「点哪个会变成什么」这两件事一眼都看不出来。
      现在：当前状态用主色实心，其余三个是弱化的可点项，各自带一个记号。
    -->
    <div class="statusbar" data-testid="fs-status">
      {#each ORDER as st (st)}
        <button
          class="stbtn"
          class:on={d.file.status === st}
          data-testid="fs-mark-{st}"
          title={STATUS_HINT[st]}
          onclick={() => mark(st)}><i>{STATUS_ICON[st]}</i>{STATUS[st]}</button
        >
      {/each}
    </div>
  </div>

  <!-- D-198 · 没路径的话，这篇文章捞到的条目无处可去 —— 所以先要求设路径。
       ★ M-5（2026-09-02 · WINDOWS_INVENTORY.md §5.6）：以前这里还有一个按钮，
       和下面页头那颗「选个位置…」点的是同一个弹窗——未设路径这一态下两个按钮
       同时可见，是真重复。现在横幅只留文字，入口只留页头那一颗。 -->
  {#if !d.file.lectureId}
    <div class="notice warn" data-testid="fs-nopath">
      <b>还没设路径。</b>这篇文章捞到的知识点得有地方去 —— 下面「选个位置…」设一下。
    </div>
  {/if}

  <div class="two">
    <!-- ══ 左栏 · 文章 ══ -->
    <div class="doc" data-testid="fs-doc" style="--doc-scale:{scale}">
      <!-- I-090 · 路径设好之后也要能改。
           以前这里只是一行死字 —— 选错了、或者后来想换一讲，一个入口都没有，
           只能新建一篇重贴。设路径的弹窗本来就在，缺的只是这个按钮。 -->
      <h4 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span>路径：{d.file.lectureName ?? '未设置'}</span>
        <button
          class="btn sm"
          data-testid="fs-pick-path"
          onclick={() => (picking = true)}
          >{d.file.lectureId ? '换个位置…' : '选个位置…'}</button
        >
        <!--
          ══ 字号 · 重做（使用者 2026-09-14 第六条）══════════════════
          他的原话：「目前用于调整字号的标志 / 控件设计过于普通和粗糙……
          视觉上过于普通。与整体 Nyx UI 的设计质量不匹配。」

          ── 为什么它看着像没做完 ★ ────────────────────────────
          上一版写着「步进走和『今日目标』同一套 Icon 钮，不自造控件」，
          用的类名是 `.st`。**但那条样式是 `.qty .st`** —— 只在那个容器里生效。
          这里没有 `.qty`，于是两颗键**一条样式都没吃到**，落到浏览器默认按钮上：
          灰底、方角、系统字。不是审美问题，是一条**没接上的样式**。
          （所以这不是「重新美化」，是先把它接上，再按这一页的质量做完。）

          ── 现在的形状 ───────────────────────────────────────
          一枚整体的分段控件：`A−` │ `115%` │ `A＋`，一圈描边、两道发丝分隔线。
          ★ 两边用**大小两个 A** 而不是 −／＋：这一条调的是字，
            而 −／＋ 在这一页里可以是任何东西（条数、页码、缩放）。
          ★ 数字用等宽 + tabular-nums：从 90% 跳到 115% 时控件不许抖。
          ★ 到头了就不给点（不是点了没反应）—— 到顶 / 到底他按一下就知道。
        -->
        <span class="fsz" data-testid="fs-font" role="group" aria-label="正文字号">
          <button
            class="st sm"
            data-testid="fs-font-minus"
            aria-label="字小一点"
            title="字小一点"
            disabled={scaleAt === 0}
            onclick={() => bumpScale(-1)}>A</button
          ><span class="v" data-testid="fs-font-val" aria-live="polite"
            >{Math.round(scale * 100)}%</span
          ><button
            class="st lg"
            data-testid="fs-font-plus"
            aria-label="字大一点"
            title="字大一点"
            disabled={scaleAt === SCALES.length - 1}
            onclick={() => bumpScale(1)}>A</button
          >
        </span>
      </h4>
      {#each marked as segs, i (i)}
        <p class:hl={highlight === i + 1} id="para-{i + 1}">
          <!--
            4.4 · 已经收进 Nyx 的那几段：带色波浪线。
            ★ 用 <mark> 不是 <span>：它在无障碍树里本来就是「标出来的一段」，
              读屏软件会念出来 —— 换个 span 的话，这个标记只对看得见的人存在。
          -->
          {#each segs as s (s)}{#if s.saved}<mark
                class="kept"
                title="这段已经收进 Nyx 了">{s.text}</mark
              >{:else}{s.text}{/if}{/each}
        </p>
      {/each}
    </div>

    <!-- ══ 右栏 · Tutorial / Findings（D-168 / D-170）══ -->
    <div class="rp">
      <div class="rt2">
        <button class:on={tab === 'tut'} data-testid="fs-tab-tut" onclick={() => (tab = 'tut')}
          >Tutorial</button
        >
        <button class:on={tab === 'fnd'} data-testid="fs-tab-fnd" onclick={() => (tab = 'fnd')}
          >Findings<span class="n">{d.findings.length}</span></button
        >
      </div>

      {#if tab === 'tut'}
        <div class="rb" data-testid="fs-chat">
          <!--
            ★ 使用者「Enlighten / Quest 交互重构」：
            「Enlighten 和 Quest 完全分开。点击后像 Tab 切换一样切换聊天框
              （而不是互斥开关挤在一起）。当前模式在聊天框顶部清晰显示。」

            所以这里是 **Tab**，不是两张选择卡：Tab 的语义就是「下面这一整块换了」，
            而两个开关的语义是「这两项各自开着或关着」—— 后者正是他说的「挤在一起」。
            两边的消息也是分开存的（chat_messages.mode），切过去看见的是另一条流。
          -->
          <!-- ★ D-484 · 清单 9 的目标：两种读法的切换本身 -->
          <div class="fs-tabs" data-testid="fs-modes" data-guide="filestudy-modes">
            <button
              class="fs-tab"
              class:on={chatMode === 'enlighten'}
              data-testid="fs-mode-enlighten"
              onclick={() => ((chatMode = 'enlighten'), (reviewNo = null))}>
              <b>Enlighten</b><span>理解 · 讲开，不出题</span>
            </button>
            <button
              class="fs-tab"
              class:on={chatMode === 'quest'}
              data-testid="fs-mode-quest"
              onclick={() => ((chatMode = 'quest'), (reviewNo = null))}>
              <b>Quest</b><span>思考 · 出问题，你来答</span>
            </button>
          </div>

          <!-- 当前模式就在聊天框顶部，跟着一句「它现在在做什么」 -->
          <div class="fs-now" class:quest={chatMode === 'quest'} data-testid="fs-modetag">
            <span class="fs-now-b"
              >{chatMode === 'quest'
                ? 'Quest · ' + (genres.find((g) => g.uid === genreUid)?.name ?? '')
                : 'Enlighten'}</span>
            <span>{chatMode === 'quest' ? '它出问题，你来答' : '它只讲，不出题'}</span>
          </div>

          <!-- R-005 · 可临时换导师。人设与四个可调项由设置页管（D-098） -->
          <!-- 5.2 · 选什么跟着模式走：Enlighten 选导师，Quest 选体裁。
               两个都摆出来会让人以为它们同时起作用 -->
          <div class="s2" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            {#if chatMode === 'enlighten'}
              <span class="dim">导师</span>
              <select class="srt" style="margin-left:0" data-testid="fs-tutor" bind:value={tutorId}>
                {#each tutors as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
              </select>
              <span class="dim" style="font-size:var(--fs-1)">换导师只影响口吻，不影响判分</span>
            {:else}
              <span class="dim">体裁</span>
              <select class="srt" style="margin-left:0" data-testid="fs-genre" bind:value={genreUid}>
                {#each genres as g (g.uid)}<option value={g.uid}>{g.name}</option>{/each}
              </select>
              <span class="dim" style="font-size:var(--fs-1)">体裁决定它按什么读法提问</span>
            {/if}
          </div>

          {#if shown.length === 0}
            <!-- 起手提示跟着模式走 —— 两个模式该怎么用是不一样的 -->
            <div class="msg ai" data-testid="fs-hint">
              {#if chatMode === 'enlighten'}
                这篇文章我已经读过了 —— 直接问，不用贴给我。<br />
                试试：<b>这一段的论证有什么问题？</b>／ <b>作者为什么用这个词而不是那个？</b>
              {:else}
                按<b>{genres.find((g) => g.uid === genreUid)?.name ?? '所选体裁'}</b>的读法，我来提问、你来答。<br />
                点下面的<b>「出第一题」</b>开始。一题答完了再点「下一个问题」——
                在那之前我们就待在这一题上。
              {/if}
            </div>
          {/if}

          {#if chatMode === 'quest' && cards.length > 0}
            <!--
              ★「支持回顾之前的问题卡片。」
              一排题号，点一下只看那一题的线程。当前那一题始终在最右边、且高亮。
            -->
            <div class="fs-nos" data-testid="fs-quest-nos">
              {#each cards as n (n)}
                <button
                  class="fs-no"
                  class:on={(reviewNo ?? curNo) === n}
                  data-testid="fs-quest-no-{n}"
                  onclick={() => (reviewNo = n === curNo ? null : n)}>第 {n} 题</button>
              {/each}
              {#if reviewNo !== null}
                <button class="fs-no back" data-testid="fs-quest-back" onclick={() => (reviewNo = null)}
                  >回到第 {curNo} 题</button>
              {/if}
            </div>
          {/if}

          {#each shown as m (m.id)}
            {#if m.kind === 'task'}
              <!--
                Quest 里它就是**问题卡**：带题号，当前那一张高亮 ——
                「问题以卡片形式出现在聊天框中」说的就是这个。

                ★ 「做完了 / 跳过」和状态角标已撤（使用者 2026-08-10：
                   「看起来没什么意义」）。**这一条盖过 D-081 的任务卡状态。**

                他是对的，而且理由比「没意义」更硬：这两个按钮要他**自己判断**
                这一题算不算过 —— 而 Quest 的全部意义就是他答、AI 判。
                自评一个「做完了」既不进判分、也不影响出下一题，
                纯粹是让他多点一下。真正推进这一题的动作只有两个，
                都在输入框那一行：**继续说**，和**下一个问题**。

                `task_state` 那一列留着（D-216 只增不删），历史数据一个字不动。
              -->
              <div
                class="task"
                class:fs-cur={m.questNo !== null && m.questNo === (reviewNo ?? curNo)}
                data-testid="fs-task-{m.id}">
                <div class="th">
                  {#if m.questNo}<span class="fs-qn">第 {m.questNo} 题</span>{/if}
                  {taskTitle(m)}
                </div>
                <div class="tb">
                  {taskBody(m)}
                  {#if m.para}
                    <br /><button
                      class="btn sm"
                      style="margin-top:6px"
                      data-testid="fs-goto-{m.id}"
                      onclick={() => {
                        highlight = m.para
                        document.getElementById(`para-${m.para}`)?.scrollIntoView({ block: 'center' })
                      }}>跳到第 {m.para} 段</button
                    >
                  {/if}
                </div>
              </div>
            {:else}
              <!-- I-064 · AI 回答分段。一大坨读不下去 —— 按空行断段，
                   `**粗体**` 与 `` `代码` `` 就地渲染，列表行给悬挂缩进 -->
              <div class="msg {m.role === 'user' ? 'me' : 'ai'}">
                {#each paragraphs(m.content) as para, pi (pi)}
                  <p class="msg-p" class:msg-li={para.bullet}>{@html para.html}</p>
                {/each}
              </div>
            {/if}
          {/each}

          {#if sending}
            <div class="msg ai" data-testid="fs-sending">正在想…</div>
          {/if}
          {#if chatError}
            <div class="errbox" data-testid="fs-chat-error">
              <div class="h">{chatError.failure?.title ?? '导师没能回应'}</div>
              <div style="white-space:pre-wrap">{chatError.failure?.detail ?? chatError.message}</div>
              <div class="dim" style="margin-top:8px">你刚才那句已经存下来了，不会白写。</div>
              <div style="margin-top:10px;display:flex;gap:8px">
                <button class="btn sm" onclick={() => ongotoSettings?.()}>去设置</button>
              </div>
            </div>
          {/if}
        </div>

        {#if reviewNo !== null}
          <!--
            在回顾旧题。**不给输入框** —— 这时候打的字会挂到那张老卡上，
            而他以为自己在问当前这题。回顾就是回顾，退回来才能继续问。
          -->
          <div class="inp" data-testid="fs-reviewing">
            <span class="dim" style="flex:1;font-size:var(--fs-2)"
              >在回顾第 {reviewNo} 题。要继续答题，先回到第 {curNo} 题。</span>
            <button class="btn sm" onclick={() => (reviewNo = null)}>回到第 {curNo} 题</button>
          </div>
        {:else}
          <!--
            ★「用户没有点击『下一个问题』之前，一直停留在当前问题卡片，
               可以持续与 AI 讨论、理解、追问这一个问题。」

            所以这一行有两个动作，而且**分得很开**：
              · 发送   —— 就这一题继续说（追问 / 作答 / 要提示）
              · 下一题 —— 才翻页。它单独一颗，不会顺手点到
            后端也不靠自觉：追问回合明确禁止出新卡（files.chat 的 askNew）。
          -->
          <div class="inp">
            <input
              placeholder={chatMode === 'quest'
                ? curNo === 0
                  ? '先点右边「出第一题」'
                  : `就第 ${curNo} 题说 —— 作答、追问、或者要个提示`
                : '问它点什么 —— 它已经读过这篇了'}
              data-testid="fs-input"
              bind:value={draft}
              onkeydown={(e) => e.key === 'Enter' && !sending && send()} />
            <button
              class="btn sm pri"
              disabled={sending || !draft.trim()}
              data-testid="fs-send"
              onclick={() => send()}>发送</button>
            {#if chatMode === 'quest'}
              <button
                class="btn sm pri"
                disabled={sending}
                data-testid="fs-quest-next"
                title={curNo === 0 ? '让它出第一题' : '这一题聊够了，换下一题'}
                onclick={() => send(true)}>{curNo === 0 ? '出第一题' : '下一个问题'}</button>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="rb" data-testid="fs-findings">
          <!-- I-039 ·「Findings 里没有分析的选项，甚至根本没有分析」 -->
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
            <button class="btn sm pri" data-testid="fs-analyse" disabled={analysing} onclick={analyseFile}>
              {analysing ? '正在分析…' : d.findings.length ? '重新分析这篇' : '分析这篇文章'}
            </button>
            <span class="dim" style="font-size:var(--fs-1)">范围仅限这一篇</span>
          </div>
          {#if analyseNote}
            <div class="notice ok" style="margin-bottom:10px" data-testid="fs-analyse-note">{analyseNote}</div>
          {/if}
          {#if analyseErr}
            <div class="errbox" data-testid="fs-analyse-error">
              <div class="h">这篇没能分析</div>
              <div style="white-space:pre-wrap">{analyseErr}</div>
            </div>
          {/if}

          {#if d.findings.length === 0}
            <div class="dim" style="font-size:var(--fs-2)">
              这篇还没捞到知识点 —— 设好上面的路径，然后点「分析这篇文章」。
            </div>
          {:else}
            <!-- D-168 · Findings 内部再分主动 / 被动，与讲次工作台的列表同构 -->
            {#each ['B', 'A'] as layer (layer)}
              {@const group = d.findings.filter((f) => f.layer === layer)}
              {#if group.length > 0}
                <div class="ugrp">{layer === 'B' ? '写作层' : '理解层'} · {group.length}</div>
                {#each group as f (f.id)}
                  <div
                    class="fd"
                    role="button"
                    tabindex="0"
                    data-testid="fs-finding-{f.id}"
                    onclick={() => onopen?.(f.id)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onopen?.(f.id)
                      }
                    }}
                  >
                    <span class="t">{f.term}</span><span class="o">{f.gloss}</span>
                  </div>
                {/each}
              {/if}
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- I-093 · 路径改成三段并排：项目___▾ 单元___▾ Lecture___▾
     使用者原话：「横线可以直接新建（没有的项目、单元或者 lecture），
     下拉箭头可以选择已经有的东西。」
     上一版做的是「一级一级往下点」的弹窗 —— 那是逐级缩小范围，不是他要的东西。
     三段同时看得见、任何一段随时能改，才叫「可以点击重新选择」。 -->
{#if picking}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="ov on" data-testid="path-dialog" onclick={() => (picking = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="mbox" onclick={(e) => e.stopPropagation()}>
      <h3>这篇文章归到哪个 Lecture</h3>
      <div class="ms">
        横线上直接打名字就能<b>新建</b>，▾ 是选<b>已经有的</b>。选到 Lecture 那一段就算设好了。
      </div>
      <PathPicker
        {tree}
        value={view.k === 'read' ? view.d.file.lectureId : null}
        label=""
        onpick={(id) => setPath(id)}
      />
      <div class="mact">
        <button class="btn" data-testid="path-cancel" onclick={() => (picking = false)}>取消</button>
      </div>
    </div>
  </div>
{/if}

<!-- ★ B5 · 删文章的确认框（原来是系统 confirm()）。 -->
{#if delFileAsk}
  <Dialog
    testid="del-file-dlg"
    title={`删除《${delFileAsk.title}》？`}
    body={`移到回收站，${TRASH_KEEP_TEXT}。和它的对话记录一起走，恢复时一起回来。`}
    confirmLabel="删除"
    danger
    onconfirm={() => delFile(delFileAsk!.id, delFileAsk!.title)}
    oncancel={() => (delFileAsk = null)}
  />
{/if}
