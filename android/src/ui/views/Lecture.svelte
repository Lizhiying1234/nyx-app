<script lang="ts">
  /**
   * 讲次屏 —— 材料（只读折叠）+ 知识点列表（阶段 2 · 读路径）。
   *
   * ══ 信息层次照 Windows `Workbench.svelte` 列表区抄，视觉按夜历（D-329）══
   *   行 = serif 词条 + 元数据行（层 · 状态 · 记号）+ 行下摘句（斜体截断）
   *   记号：共识=实心小星（D-044 both）· 重复收集 ≥2=描边星+数（D-026）·
   *        ✎ 嫌疑（只显示，处理在电脑 D-302）· 析出×N（D-148）
   *
   * ★ 练习（阶段 4）与 ⋮ 管理（阶段 5）已接真；「添加表达」在阶段 6 随 Save 管线。
   * ★ D-227：零样式；D-392：中文 400。
   */
  import { CANT_READ, DUP_COLLECT, deletedItems } from '../lib/copy.ts'
  import { untrack } from 'svelte'
  import Icon from '../lib/Icon.svelte'
  import Menu from '../lib/Menu.svelte'
  import SavePicker from '../lib/SavePicker.svelte'
  import Dialog from '../lib/Dialog.svelte'
  import ItemMenu from '../lib/ItemMenu.svelte'
  import { snacks } from '../lib/snack.svelte.ts'
  import type { MenuTarget } from '../lib/menu-types.ts'
  import DedupDialog from '../lib/DedupDialog.svelte'
  import { store } from '../lib/store.svelte.ts'
  import { practice } from '../lib/practice.svelte.ts'
  import { loadLecture, type LectureData } from '../../db/read-path.ts'
  import { rename, bulkSetLayer, bulkSilence, softDeleteItems, undoDeleteItems, moveItemsTo } from '../../db/manage.ts'
  import SelBar from '../lib/SelBar.svelte'
  import { selectAllState, toggleSelectAll,
  ROTATION_WORDS,
  SILENCE_ACTIONS,
  TRASH_KEEP_TEXT,
  TRASH_DAYS
} from '../../core-link.ts'
  import { longpress } from '../lib/press.ts'
  import { registerBack } from '../lib/backstack.svelte.ts'
  import type { Db } from '../../db/types.ts'
  import * as nodes from '../../db/manage-nodes.ts'
  import { dueCount } from '../../db/reading.ts'
  import {
    batchActions,
    cancelBatch,
    failureSummary,
    onBatch,
    resumeBatch,
    retryFailed,
    startBatch,
    type BatchState
  } from '../../db/analysis-runner.ts'
  import { syncBackgroundAnalysis } from '../lib/analysis-bg.ts'
  import { captureAt } from '../../db/capture.ts'
  import { startLearning } from '../../db/start-learning.ts'

  let {
    id,
    onback,
    onitem
  }: { id: number; onback: () => void; onitem: (itemId: number) => void } = $props()

  type View = { k: 'loading' } | { k: 'error'; m: string } | { k: 'ok'; d: LectureData }
  let view = $state<View>({ k: 'loading' })
  let mats = $state(false)
  let note = $state<string | null>(null)
  /** 删除确认（D-412 第一层） */
  let confirmDel = $state<(() => Promise<void>) | null>(null)
  /** 这一讲今天到期几张（状态·任务量，不是成绩）—— 认读 CTA 上的数 */
  let due = $state(0)
  /**
   * ★★ 多选（⑨ · 2026-09-01）—— 长按任一条进入，与 Vault 同一个手势（D-379）。
   * null = 不在多选态。空数组会自动退出（少一个「退出多选」的必按步骤）。
   */
  let sel = $state<number[] | null>(null)
  let selBusy = $state(false)
  /**
   * ★ T-5.18 · 全选三态（判据在 core `selection.ts`，T-9.15 起两端同一份；界面只按它说话）——
   *   这一屏列着的就是这一讲全部还活着的知识点，所以「全选」= 全选它们，
   *   「认读这 N 条」的队列也正是它们（`testCardsByIds`），所见即所练。
   */
  const allIds = $derived(view.k === 'ok' ? view.d.items.map((i) => i.id) : [])
  const selAll = $derived(selectAllState(sel, allIds))
  /** 「开始学」在场时，认读那一档降成 sec2 —— 一屏只该有一个主动作 */
  const quietCta = $derived(
    view.k === 'ok' && view.d.lecture.status === 'review' && view.d.items.length > 0
  )
  /** 批量移动的目标讲 —— 用已有的三段选择器（D-411/D-427 统一那一份），不另造。
      ★ 名字避开 `movePick`：那个是「把这一讲移到别的单元」，两件事。 */
  let moveSel = $state(false)

  /** 添加表达（第十一则指令 · 接通）：词 → 层 → captureAt 本讲（Windows addTo 同形） */
  let addDlg = $state(false)
  let addLayer = $state<'A' | 'B'>('A')
  /**
   * ★ 多选态要能用系统返回退出（同 VaultItems / 回收站）。
   *   不接这一条的后果：进了多选只能靠再点一遍取消每一条才出得来 ——
   *   D-411 数过的那 44 个「只为退出而存在」的元素，就是这么长出来的。
   */
  $effect(() => {
    if (sel === null) return
    return registerBack(() => ((sel = null), true))
  })

  function toggleSel(id: number): void {
    if (sel === null) return
    sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]
    if (sel.length === 0) sel = null
  }

  /** 批量动作共用的外壳：跑完一律重读这一页 + 全局计数，界面当场对上（⑨ 要求） */
  async function batch(run: (db: Db, ids: number[]) => Promise<string>): Promise<void> {
    if (store.db.k !== 'ok' || selBusy || !sel || sel.length === 0) return
    const ids = [...sel]
    selBusy = true
    try {
      const msg = await run(store.db.db, ids)
      sel = null
      await reloadHere()
      await store.reloadCounts()
      wrote(msg)
    } catch (e) {
      note = (e as Error)?.message ?? String(e)
    } finally {
      selBusy = false
    }
  }

  async function addExpression(term: string): Promise<void> {
    addDlg = false
    if (store.db.k !== 'ok' || !term.trim()) return
    try {
      const r = await captureAt(store.db.db, term, addLayer, id)
      await reloadHere()
      await store.reloadCounts()
      note = `收下了「${term.trim().slice(0, 20)}」→ ${addLayer === 'A' ? '理解层 A' : '写作层 B'}${r.duplicateOf !== null ? ' · 重复收集 ✦（这条以前收过）' : ''}`
    } catch (e) {
      note = `没收成：${(e as Error)?.message ?? e}`
    }
  }


  /**
   * ★★★ 「这批我看过了 · 开始学」（2026-09-01 · F-001）
   *
   * 在这之前手机上**没有**这个动作，于是手机自建的讲永远进不了轮转 ——
   * Atlas 说「今天没事做」、这一屏点认读说「今天没有到期的卡」。
   * 判据在 `core/start-learning.ts`（两端同一份），平台面在 `db/start-learning.ts`。
   *
   * ★ 拒绝也如实说（refused 四态各有各的下一步），不静默 —— D-409 真实性。
   */
  let starting = $state(false)
  async function doStart(): Promise<void> {
    if (store.db.k !== 'ok' || starting) return
    starting = true
    note = null
    try {
      const r = await startLearning(store.db.db, id)
      await reloadHere()
      await store.reload() // 树上的状态记号 + Atlas 的今日都要跟着变
      if (r.refused !== null) {
        note = r.reason
      } else {
        snacks.show(
          r.fresh > 0
            ? `${r.count} 条${ROTATION_WORDS.schedule} · ${r.fresh} 条新知识点现在就能认读`
            : `${r.count} 条${ROTATION_WORDS.schedule}`
        )
        note = r.reason // 排期为什么是这样 —— D-356 机制透明，原样透出
      }
    } catch (e) {
      note = `开始学没写成：${(e as Error)?.message ?? e}`
    } finally {
      starting = false
    }
  }

  /** 阶段 5 · 讲次菜单与词条 ⋮ 真接线 */
  let menu = $state<MenuTarget | null>(null)
  let itemMenu = $state<{ id: number; term: string; silent: boolean } | null>(null)
  let dlg = $state<{ id: number; name: string } | null>(null)
  /** 「移到…」的目标选择（讲次名，仅用于标题） */
  let movePick = $state<string | null>(null)
  /** T-9.13 · 查重对话框开着没有（它自己扫、自己并，这一屏只负责刷新） */
  let dedupOpen = $state(false)
  /** ★ Snackbar 已上收到全应用唯一的 `snacks`（第十九则指令） */
  const wrote = (msg: string, undo?: (() => Promise<void>) | null): void => snacks.show(msg, undo)
  async function reloadHere(): Promise<void> {
    if (store.db.k !== 'ok') return
    view = { k: 'ok', d: await loadLecture(store.db.db, id) }
    due = await dueCount(store.db.db, id)
  }
  async function onMenuAct(a: import('../lib/menu-types.ts').MenuAction): Promise<void> {
    if (a === 'move') {
      const nm = view.k === 'ok' ? view.d.lecture.name : ''
      menu = null
      movePick = nm
      return
    }
    const m = menu
    if (!m) return
    menu = null
    if (store.db.k !== 'ok') return
    const db = store.db.db
    try {
      if (a === 'rename') dlg = { id: m.id, name: m.name }
      else if (a === 'read') practice.open = { kind: 'reading', lectureId: id }
      else if (a === 'produce') practice.open = { kind: 'production', lectureIds: [id] }
      else if (a === 'analyse') void doAnalyse(db)
      else if (a === 'dedup') dedupOpen = true
    } catch (e) {
      note = `没写成：${(e as Error)?.message ?? e}`
    }
  }

  /**
   * ══ 讲次批量分析（T-5.13 · D-R22）══════════════════════════════
   *
   * ★ 执行器是**模块单例**（`db/analysis-runner.ts`），不挂在这一屏上 ——
   *   他切到 Atlas 再回来，组件重建，但批次还在跑。这一屏只是**订阅**它。
   * ★ 所以这里没有任何「跑到哪了」的本地状态：唯一权威是
   *   `settings['analysis.batch']`，runner 每写一条就 publish 一次。
   */
  let abatch = $state<BatchState | null>(null)
  $effect(() => onBatch((s) => (abatch = s)))

  /** 只显示这一讲的批次 —— 别的讲的进度不该出现在这一屏 */
  const myBatch = $derived(abatch && abatch.lectureId === id ? abatch : null)

  async function doAnalyse(db: import('../../db/types.ts').Db): Promise<void> {
    try {
      const s = await startBatch(db, id)
      if (s.queue.length === 0 && s.skipped > 0) note = `这个 Lecture 都分析过了 · ${s.skipped} 条`
      await reloadHere()
      await syncBackgroundAnalysis(db)
    } catch (e) {
      note = `分析没起来：${(e as Error)?.message ?? e}`
    }
  }

  /** 「继续」：他切回来时进度是停着的（前台那一段预算跑完了）—— 再跑一段 */
  async function doContinue(): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    await resumeBatch(db)
    await reloadHere()
    await syncBackgroundAnalysis(db)
  }

  async function doRetryFailed(): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    await retryFailed(db)
    await reloadHere()
  }

  /** 这一批现在能做哪几个动作 —— 判据在 analysis-runner（I-151） */
  const acts = $derived(
    myBatch ? batchActions(myBatch) : { cancel: false, continue: false, retry: false }
  )

  /** 状态行那一句 —— 措辞只说他关心的：跑到哪、跳过几条、几条没成 */
  const batchLine = (s: BatchState): string => {
    const bits: string[] = []
    if (s.status === 'cancelled') bits.push(`已停下 · ${s.cancelReason ?? '你取消了'}`)
    else if (s.status === 'done') bits.push('分析完了')
    else bits.push(`分析中 ${s.done}/${s.done + s.queue.length}`)
    if (s.skipped > 0) bits.push(`跳过 ${s.skipped} 条（本来就有解析）`)
    if (s.failed.length > 0) bits.push(`${s.failed.length} 条没成`)
    return bits.join(' · ')
  }
  async function doRename(v: string): Promise<void> {
    const d = dlg
    dlg = null
    if (!d || store.db.k !== 'ok') return
    try {
      await rename(store.db.db, 'lecture', d.id, v)
      await reloadHere()
      await store.reload()
    } catch (e) {
      note = `改名没写成：${(e as Error)?.message ?? e}`
    }
  }

  $effect(() => {
    untrack(() => {
      void (async () => {
        if (store.db.k !== 'ok') return
        try {
          view = { k: 'ok', d: await loadLecture(store.db.db, id) }
          due = await dueCount(store.db.db, id)
        } catch (e) {
          view = { k: 'error', m: (e as Error)?.message ?? String(e) }
        }
      })()
    })
  })
</script>

<div class="view">
  {#if view.k === 'loading'}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
      <span class="dt">…</span>
    </div>
    <div class="empty"><div class="t zh2">读取中…</div></div>
  {:else if view.k === 'error'}
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
      <span class="dt">返回</span>
    </div>
    <div class="empty"><div class="t zh2">{CANT_READ}</div><div class="s">{view.m}</div></div>
  {:else}
    {@const d = view.d}
    <!-- ★ 屏顶（第三种方案）：back + 坐标 + ⋮，讲次名做衬线大标题，
         元数据单独一行 —— 此前三级路径全挤在一行 mono 面包屑里。 -->
    <div class="top" style="gap:8px">
      <button class="ibtn" style="margin-left:-8px" aria-label="返回" onclick={onback}>
        <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-back" /></svg>
      </button>
      <!-- ★ 只留最近的一级（2026-09-01）：两级会截断成「THE HOUSEMAID · THE MUSIC R…」，
           断在半个词上。上一级点返回就知道了。 -->
      <span class="dt">{d.lecture.unitName}</span>
      <button
        class="ibtn sm"
        aria-label="更多"
        onclick={() => (menu = { kind: 'lecture', id, name: d.lecture.name })}
      ><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
    </div>
    <div class="tt" style="margin-top:8px">{d.lecture.name}</div>
    <div class="num" style="margin-top:6px">
      {#if sel !== null}已选 {sel.length} / {d.items.length}{:else}{d.items.length} 条{#if due > 0} ·
          {due} 到期{/if}{/if}
    </div>

    {#if note}<div class="note" role="status">{note}</div>{/if}

    <!-- ★ T-5.13 · 批量分析状态行。用既有的 .note（D-227 零组件样式）——
         它本来就是「这一屏此刻在说的一句话」那个位置。
         两个小动作跟在同一行里：跑着的时候给「取消」，停下来有失败时给「重试失败的」。 -->
    {#if myBatch}
      <div class="note" role="status">{batchLine(myBatch)}</div>
      <!-- ★★ I-151（真机 2026-09-07）：这一行原来整个罩在 `status !== 'done'` 里，
           而「跑完了但有几条没成」恰恰是 done + failed 非空 —— 唯一想按「重试失败的」
           那一刻它正好不在。现在**能做哪几个动作由判据说**（analysis-runner::batchActions），
           模板只按它显示；样式仍只用既有的 .btnrow / .btn（D-227）。 -->
      {#if acts.cancel || acts.continue || acts.retry}
        <div class="btnrow">
          {#if acts.cancel}
            <button class="btn sm sec2" onclick={() => cancelBatch()}>取消</button>
          {/if}
          {#if acts.continue}
            <button class="btn sm sec2" onclick={() => void doContinue()}>继续分析</button>
          {/if}
          {#if acts.retry}
            <button class="btn sm sec2" onclick={() => void doRetryFailed()}>重试失败的</button>
            <!-- 「为什么」的去处：话术是 core 写进 failed[].why 的那一句，不重编 -->
            <button class="btn sm sec2" onclick={() => (note = failureSummary(myBatch.failed))}
              >为什么没成</button
            >
          {/if}
        </div>
      {/if}
    {/if}

    <!-- ★★★ 开始学（F-001 · 2026-09-01）：只在「待审阅且有内容」时出现。
         §10.2e②「数是 0 的入口不出现」的同一条精神 —— 已在轮转 / 空讲次
         点它只会得到一句拒绝，那就别让它出现。
         它是这一屏此刻**唯一要紧的那个动作**，所以独占一行、通栏。 -->
    {#if d.lecture.status === 'review' && d.items.length > 0}
      <div class="btnrow">
        <button class="btn pri full" disabled={starting} onclick={() => void doStart()}>
          <span class="zh">{starting ? '正在排期…' : '开始学'}</span>
        </button>
      </div>
    {/if}

    <div class="btnrow">
      <!-- ★★ T-5.18 / D-R28 · **排期是推荐，不是门禁。**
           到期那一档（`dueCards`，D-229 上限 40）现在明写「推荐」——
           它回答的是「今天建议先看这几张」，不是「只有这几张能看」。
           ★ 数是 0 就不出现（D-431②）：旁边的「随时认读」本来就进得去，
             再留一个写着「推荐 · 0」的按钮只是死胡同（此前那句「0 张也能进，
             空态自己会说」是在没有随时入口的年代写的）。
           ★ 「开始学」在场时降成 sec2：一屏只该有一个主动作，而且 review 状态下
             到期队列必然是空的（due_at 还没排）—— 那时它本来就不出现。 -->
      {#if due > 0}
        <button
          class="btn"
          class:sec2={quietCta}
          onclick={() => (practice.open = { kind: 'reading', lectureId: id })}
        >
          <span class="zh">推荐&nbsp;· {due}</span>
        </button>
      {/if}
      <!-- ★★ 随时认读（全讲）· D-R28：他想认读永远允许，不看到期日。
           走 **ids 那条既有入口**（`practice.open.ids` → `testCardsByIds`，
           与单条 ⋮「随时认读这一条」、Vault 勾选同一条路）—— 不新造取卡通道。
           ★ 队列就是这一屏列着的这些条（静默的也给：D-030「不再轮转」≠「不许碰」）。
           ★ 判分照写 review_logs、SM-2 照更新；**ids 那一场只动卡不动讲次间隔**
             （`settleLectures` 拿不到 lectureIds，讲次级结算不跑）—— 与 Windows T-4.13 同一条。 -->
      {#if d.items.length > 0}
        <button
          class="btn"
          class:sec2={quietCta || due > 0}
          onclick={() => (practice.open = { kind: 'reading', ids: allIds })}
        >
          <span class="zh">随时认读</span>
        </button>
      {/if}
      <button class="btn sec2" onclick={() => (practice.open = { kind: 'production', lectureIds: [id] })}>
        <span class="zh">产出</span>
      </button>
      <!-- ★ 「测试…」2026-09-01 移除（DS §10.2e）：那是开发期的取卡口子，
           产品语义上使用者永远不需要「测试」，却占着产品页的一级动作位。
           ★ 2026-09-07 · 上面的「随时认读」**不是它回来了**：删的是那个词与那个位置，
             这一个是 D-R28 裁下来的产品语义（想认读永远允许），走 ids 那条既有入口。 -->
    </div>

    <!-- ★ 数是 0 就不出现（DS §10.2e②）：一个点进去是空的入口，
         是 D-411 点名的死胡同。★ 不是隐藏功能 —— 有材料它就回来。 -->
    {#if d.materials.length > 0}
      <button class="fold" onclick={() => (mats = !mats)}>
        <span class="lab tight">MATERIALS</span>
        <span class="m">{d.materials.length} <svg class="ic arr" class:open={mats} width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></span>
      </button>
      {#if mats}
        <div class="set tight">
          {#each d.materials as m (m.id)}
            <div class="li ro matrow">
              <span class="g">
                <span class="zh">{m.title}</span>
                <small>{m.kind.toUpperCase()} · {m.origin} · {m.charCount} CHARS</small>
              </span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <!-- ★ `lecture-split`（清单 8）的靶子。指**这一行**而不是上面的材料块：
         这一行就是「原文」与「析出的知识点」的分界，而材料块在
         `{#if d.materials.length > 0}` 里（没材料的讲次就没有它），
         这一行在所有状态下都在。core 那句已改成不提方位 —— 手机上两块是上下叠的。 -->
    <div class="lab zh" data-guide="lecture-split">知识点</div>
    <!-- ★ T-5.18 · 全选 / 取消全选。沿用 Vault 那一枚 `.allsel`（不新造 selection 系统），
         差别只在这里**两个方向都点得动** —— Vault 那半份全选完只剩一句陈述。
         三态由 core `selection.ts::selectAllState` 说：部分 → 「全选这 N 条」·
         全选 → 「取消全选」（= 退出多选，与「空数组自动退出」同一条约定）。 -->
    {#if sel !== null && d.items.length > 0}
      <button class="allsel" onclick={() => (sel = toggleSelectAll(sel, allIds))}>
        {#if selAll === 'all'}
          <Icon name="check" size={11} /> 已全选这 {d.items.length} 条 · 取消全选
        {:else}
          全选这 {d.items.length} 条
        {/if}
      </button>
    {/if}
    <div class="set">
      {#each d.items as it (it.id)}
        <div class="li">
          {#if sel !== null}
            <!-- ★ 多选态（⑨）：整行就是那个 toggle，记号用 .selmk（⑪ 放大过的那一枚） -->
            <button class="hit" onclick={() => toggleSel(it.id)}>
              <span class="selmk" class:off={!sel.includes(it.id)}
                ><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"
                  ><use href={sel.includes(it.id) ? '#nyx-core' : '#nyx-core-o'} /></svg
                ></span
              >
              <span class="g">
                <span class="term">{it.term}</span>
                <small><span class="tag t-v">{it.layer}</span> · {it.productionState.toUpperCase()}</small>
              </span>
            </button>
          {:else}
          <button class="hit" use:longpress={() => (sel = [it.id])} onclick={() => onitem(it.id)}>
            <span class="g">
              <span class="term">
                {it.term}
                {#if it.hasSuspect}<span class="tag t-w gap" title="有嫌疑"><svg class="ic" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-fix" /></svg></span>{/if}
              </span>
              <small>
                <span class="tag t-v">{it.layer}</span>
                · {it.cardSilent && it.productionState !== 'silent'
                  ? 'RC-SILENT'
                  : it.productionState.toUpperCase()}
                {#if it.source === 'both'}· {DUP_COLLECT}{/if}
                {#if it.recollected >= 2}
                  · <span class="starn"><svg viewBox="0 0 24 24"><use href="#nyx-star-o" /></svg><b>{it.recollected}</b></span>
                {/if}
                {#if it.derivedCount > 0} · 析出×{it.derivedCount}{/if}
              </small>
              {#if it.quote}<span class="qline">“{it.quote}”</span>{/if}
            </span>
            <!-- ★ 行末的 caret 已删（DS §10.2e①）：整行本来就可点，
                 caret 在说一件行本身已经在说的事；而且它和 ⋮ 并排看着像两个按钮。
                 ⋮ 留着 —— 它是**另一件事**（对这一条做动作）。 -->
          </button>
          {/if}
          <button
            class="ibtn sm"
            aria-label="{it.term} 的更多操作"
            disabled={sel !== null}
            onclick={() =>
              (itemMenu = {
                id: it.id,
                term: it.term,
                silent: it.productionState === 'silent' || it.cardSilent
              })}
          ><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
        </div>
      {:else}
        <div class="li"><span class="m zh">（这个 Lecture 还没有知识点）</span></div>
      {/each}
      <button class="li addrow" onclick={() => ((addLayer = 'A'), (addDlg = true))}>
        <span class="g"><span class="tag t-v">＋ 添加知识点</span></span>
      </button>
    </div>
  {/if}
</div>

{#if dedupOpen}
  <DedupDialog
    lectureId={id}
    onclose={() => (dedupOpen = false)}
    ondone={(msg) => {
      wrote(msg)
      void reloadHere()
    }}
  />
{/if}

{#if menu}
  <Menu
    target={menu}
    tree={store.tree.k === 'ok' ? store.tree.data : []}
    onclose={() => (menu = null)}
    onact={(a) => void onMenuAct(a)}
  />
{/if}

<!-- ★★ 批量动作条（⑨ · 2026-09-01）。长按任一条进入多选。
     kind="manage" —— 这一页的主位两个按钮是**改层级**，不是「现在就练」：
     「转入认读」和「认读这 5 条」是两件事，标签不能含糊。
     ★ T-5.18 · 「现在就练」那一对（`onreadnow` / `onprodnow`）另起一行药丸，
       主位没动（⑨ 是既定决议，改它要先提 —— C-001）。走 ids 那条既有入口，
       判分与排期照常（D-R28 练了就算数）。 -->
{#if view.k === 'ok' && sel !== null && sel.length > 0}
  <SelBar
    n={sel.length}
    kind="manage"
    busy={selBusy}
    onread={() =>
      void batch(async (db, ids) => `已转入认读 ${await bulkSetLayer(db, ids, 'A')} 条`)}
    onprod={() =>
      void batch(async (db, ids) => `已转入练习 ${await bulkSetLayer(db, ids, 'B')} 条`)}
    onsilence={() => void batch(async (db, ids) => `已${SILENCE_ACTIONS.shelve} ${await bulkSilence(db, ids, true)} 条`)}
    onmove={() => (moveSel = true)}
    onreadnow={() => (practice.open = { kind: 'reading', ids: [...(sel ?? [])] })}
    onprodnow={() => (practice.open = { kind: 'production', ids: [...(sel ?? [])] })}
    ondelete={() =>
      void batch(async (db, ids) => {
        const n = await softDeleteItems(db, ids)
        // ★ D-412 第二层：删除给撤销（第一层的确认框只给容器级删除，
        //   词条批量删是可撤销的，Snackbar 就是那一层）
        setTimeout(
          () =>
            wrote(deletedItems(n), async () => {
              await undoDeleteItems(db, ids)
              await reloadHere()
              await store.reloadCounts()
            }),
          0
        )
        return deletedItems(n)
      })}
  />
{/if}

<!-- ★ 批量移动的目标 —— **同一个节点选择器**，挑到 'l'（讲）那一级。
     方法在 core/move-items.ts（D-354 两端同款一起定）。 -->
{#if moveSel && sel !== null}
  <SavePicker
    upto="l"
    title={`把这 ${sel.length} 条移到`}
    confirm="移过去"
    allowCreate={false}
    onpick={async (toId) => {
      moveSel = false
      await batch(async (db, ids) => {
        const r = await moveItemsTo(db, ids, id, toId)
        return r.merged > 0
          ? `已移动 ${r.moved} 条 · ${r.merged} 条目标 Lecture 里本来就有`
          : `已移动 ${r.moved} 条`
      })
    }}
    onclose={() => (moveSel = false)}
  />
{/if}

<!-- ★ 「移到…」用**同一个节点选择器**（第二十则指令统一 Selector）：
     讲次移到某个单元 → 挑到 'u' 那一级为止；移动不给新建。 -->
{#if movePick}
  <SavePicker
    upto="u"
    title={`把「${movePick}」移到`}
    confirm="移过去"
    allowCreate={false}
    onpick={async (toId) => {
      movePick = null
      if (store.db.k !== 'ok') return
      await nodes.moveNode(store.db.db, 'lecture', id, toId)
      await store.reload()
      wrote('已移动')
    }}
    onclose={() => (movePick = null)}
  />
{/if}

{#if itemMenu}
  <ItemMenu
    id={itemMenu.id}
    term={itemMenu.term}
    silent={itemMenu.silent}
    onclose={() => (itemMenu = null)}
    onwrote={(msg, undo) => {
      wrote(msg, undo)
      void reloadHere()
    }}
  />
{/if}

{#if dlg}
{#if confirmDel}
  <Dialog
    title="删除这个 Lecture？"
    input={null}
    confirm="删除"
    danger
    onclose={() => (confirmDel = null)}
    onconfirm={() => {
      const run = confirmDel
      confirmDel = null
      if (run) void run()
    }}
  >
    <p class="dlg-note">移到回收站，<b>{TRASH_KEEP_TEXT}</b>；这个 Lecture 独有的知识点跟着走。</p>
  </Dialog>
{/if}

  <Dialog
    title={`改名 · ${dlg.name}`}
    input={dlg.name}
    confirm="就叫这个"
    onclose={() => (dlg = null)}
    onconfirm={doRename}
  />
{/if}

{#if addDlg}
  <Dialog
    title="添加知识点到这个 Lecture"
    input=""
    confirm={addLayer === 'A' ? '收成理解层 A' : '收成写作层 B'}
    onclose={() => (addDlg = false)}
    onconfirm={(v) => void addExpression(v)}
  >
    <div class="seg" style="margin:2px 0 10px">
      <button class:sel={addLayer === 'A'} onclick={() => (addLayer = 'A')}>理解层 A · 看懂</button>
      <button class:sel={addLayer === 'B'} onclick={() => (addLayer = 'B')}>写作层 B · 会写</button>
    </div>
  </Dialog>
{/if}
