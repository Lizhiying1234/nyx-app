<script lang="ts">
  /**
   * Atlas —— 工作台：今日 · 最近保存 · 项目树（D-372/D-388/D-391 收窄）。
   * 树 → 讲次 → 详情 的读路径栈也住在这里（Tab 内导航，详情从哪进回哪）。
   *
   * ★ 今日排期未接线（阶段 2 后半）—— 如实说（D-262），不摆假数。
   * ★ D-227 零样式 · D-392 中文 400。
   */
  import { CANT_READ, TRASH_TAIL } from '../lib/copy.ts'
  import Icon from '../lib/Icon.svelte'
  import Menu from '../lib/Menu.svelte'
  import CreateMenu from '../lib/CreateMenu.svelte'
  import SavePicker from '../lib/SavePicker.svelte'
  import Dialog from '../lib/Dialog.svelte'
  import Lecture from './Lecture.svelte'
  import Detail from './Detail.svelte'
  import type { MenuTarget } from '../lib/menu-types.ts'
  import { route } from '../lib/route.svelte.ts'
  import { practice } from '../lib/practice.svelte.ts'
  import { store } from '../lib/store.svelte.ts'
  import { rename, type RenameKind } from '../../db/manage.ts'
  import * as nodes from '../../db/manage-nodes.ts'
  import { drag, dragRow, setDropHandler } from '../lib/dragsort.svelte.ts'
  import { snacks } from '../lib/snack.svelte.ts'
  import { longpress } from '../lib/press.ts'
  import { DAILY_TARGET_MAX, DAILY_TARGET_MIN, setDailyTarget } from '../../db/today.ts'
  import { SILENCE_ACTIONS, TRASH_KEEP_TEXT, TRASH_DAYS } from '../../core-link.ts'

  /** Tab 内导航栈：树 → 讲次 → 详情（详情记得自己从哪来） */
  /**
   * ★ 导航状态已上收到全应用唯一的 Route（`lib/route.svelte.ts`）。
   *   此前是本组件的一个局部 `nav`，于是跨 Tab 导航结构上不可能（D-411）。
   *   栈为空 = Atlas 的 Root（树）。
   */
  const nav = $derived(route.stacks.atlas.at(-1) ?? null)

  const isDue = (dueAt: number | null): boolean => dueAt !== null && dueAt <= Date.now()

  let menu = $state<MenuTarget | null>(null)
  /** 统一居中 Dialog（D-393）：目前只有改名一件真事 */
  let dlg = $state<{ kind: RenameKind; id: number; name: string } | null>(null)
  let note = $state<string | null>(null)
  /** 删除确认（D-412 第一层）—— 确认之后才真的执行 */
  /** 统一 ＋ 的菜单（建什么 → 建在哪） */
  let createOpen = $state(false)
  /**
   * ★ 「移到…」改用**同一个节点选择器**（第二十则指令统一 Selector）：
   * 此前 Menu 自己长了一套逐级下钻，而 SavePicker 的注释写着那版被否过 ——
   * 同一件事两份判据。现在只剩一份：三段同时可见，移动时不给新建。
   */
  let movePick = $state<{ kind: 'unit' | 'lecture'; id: number; name: string } | null>(null)
  let confirmDel = $state<{ name: string; run: () => Promise<void> } | null>(null)

  /* ★ 返回不再由本组件注册 —— Route 落地后，「弹一层」是全应用同一份逻辑，
     由 App.svelte 的 backstack 兜底统一消费（横轴清栈 / 纵轴退一层）。
     这里删掉的正是审计里 44 个「只为退出而存在」的元素中的一份。 */

  async function doRename(v: string): Promise<void> {
    const d = dlg
    dlg = null
    if (!d || store.db.k !== 'ok') return
    try {
      await rename(store.db.db, d.kind, d.id, v)
      await store.reload()
    } catch (e) {
      note = `改名没写成：${(e as Error)?.message ?? e}`
    }
  }

  /**
   * ★ 「今天多少条」长按可改（2026-09-01 · X-Ray 审计 F-011）。
   *
   * 那个数由 `param.dailyTarget` 决定（半数规则的目标值），而 D-408 把
   * Settings 的「学习」区整组删了 —— 于是它成了**全屏最响却改不了**的东西。
   * 入口不放回 Settings，放在**它起作用的地方**：零新增设置项，
   * 完全符合 D-408 那句「只暴露真的需要主动改变的东西」。
   *
   * ★ 它是 USER 偏好 → 写进 user_preferences → **随同步走**（电脑上同一个值）。
   */
  let targetDlg = $state(false)
  async function saveTarget(v: string): Promise<void> {
    targetDlg = false
    if (store.db.k !== 'ok') return
    try {
      const n = await setDailyTarget(store.db.db, Number(v))
      await store.reloadCounts() // 今日排期跟着重算 —— 半数规则的停点会变
      snacks.show(`每日目标 ${n} 条`)
    } catch (e) {
      note = (e as Error)?.message ?? String(e)
    }
  }

  /** 阶段 5 · 管理动作真接线（判据在 manage-nodes.ts —— 这里只派活） */
  let newDlg = $state<
    | { kind: 'project' }
    | { kind: 'unit'; parent: number }
    | { kind: 'lecture'; parent: number }
    | null
  >(null)

  async function withDb(fn: (db: import('../../db/types.ts').Db) => Promise<void>): Promise<void> {
    if (store.db.k !== 'ok') return
    try {
      await fn(store.db.db)
      await store.reload()
    } catch (e) {
      note = `没写成：${(e as Error)?.message ?? e}`
    }
  }

  async function onMenuAct(a: import('../lib/menu-types.ts').MenuAction): Promise<void> {
    if (a === 'move') {
      const m = menu
      menu = null
      if (m && m.kind !== 'project') movePick = { kind: m.kind, id: m.id, name: m.name }
      return
    }
    const m = menu
    if (!m) return
    menu = null
    if (a === 'rename') {
      dlg = { kind: m.kind, id: m.id, name: m.name }
      return
    }
    if (a === 'newChild') {
      newDlg = m.kind === 'project' ? { kind: 'unit', parent: m.id } : { kind: 'lecture', parent: m.id }
      return
    }
    if (a === 'read' && m.kind === 'lecture') {
      practice.open = { kind: 'reading', lectureId: m.id }
      return
    }
    if (a === 'produce' && m.kind === 'lecture') {
      practice.open = { kind: 'production', lectureIds: [m.id] }
      return
    }
    if (a === 'pin' && m.kind === 'project') {
      await withDb(async (db) => {
        await nodes.setPinned(db, m.id, !m.pinned)
      })
      return
    }
    if (a === 'unread' && m.kind === 'lecture') {
      await withDb(async (db) => {
        await nodes.markUnread(db, m.id)
        snacks.show('已打回待审阅 —— 排期清零')
      })
      return
    }
    if (a === 'archive') {
      await withDb(async (db) => {
        await nodes.setSilentNode(db, m.kind, m.id, true)
        await store.reloadCounts()
        snacks.show(`「${m.name}」${SILENCE_ACTIONS.shelve}了 —— 不再排期，进度一个字不动`, async () => {
          await nodes.setSilentNode(db, m.kind, m.id, false)
          await store.reload()
          await store.reloadCounts()
        })
      })
      return
    }
    if (a === 'delete') {
      // ★ D-412：删除给确认。三层 = **确认框** → Snackbar 撤销 → 回收站（天数见 TRASH_DAYS）。
      //   此前只有后两层。确认文案必须说真话，绝不写「不可撤销」——因为它可撤销。
      confirmDel = {
        name: m.name,
        run: async () => {
          await withDb(async (db) => {
            if (m.kind === 'lecture') {
              const r = await nodes.deleteLecture(db, m.id)
              snacks.show(`已删除「${m.name}」· 独有知识点 ${r.items} 条随行 ${TRASH_TAIL}`, async () => {
                await nodes.restoreCascade(db, 'lecture', m.id)
                await store.reload()
                await store.reloadCounts()
              })
            } else {
              const r = await nodes.softDeleteContainer(db, m.kind, m.id)
              snacks.show(`已删除「${m.name}」· 连同 ${r.lectures} 个 Lecture ${TRASH_TAIL}`, async () => {
                await nodes.restoreCascade(db, m.kind, m.id)
                await store.reload()
                await store.reloadCounts()
              })
            }
            await store.reloadCounts()
          })
        }
      }
      return
    }
  }

  async function doMove(toId: number): Promise<void> {
    const m = movePick
    movePick = null
    if (!m) return
    const kind = m.kind // 收窄后再进闭包
    await withDb(async (db) => {
      await nodes.moveNode(db, kind, m.id, toId)
      snacks.show(`已移动「${m.name}」`)
    })
  }

  /** 拖动排序（D-361）：组 → 判据参数；跨父拒收兜底在 manage-nodes.reorder */
  $effect(() => {
    setDropHandler((group, ids) => {
      void withDb(async (db) => {
        if (group === 'p') await nodes.reorder(db, 'project', null, ids)
        else if (group.startsWith('u')) await nodes.reorder(db, 'unit', Number(group.slice(1)), ids)
        else await nodes.reorder(db, 'lecture', Number(group.slice(1)), ids)
        snacks.show('顺序记住了')
      })
    })
    return () => setDropHandler(null)
  })
  const dcls = (group: string, id: number): string => {
    const a = drag.active
    if (!a) return ''
    if (a.group !== group) return 'dragdim'
    if (a.id === id) return 'draglift'
    if (a.overId === id) return a.before ? 'dropb' : 'dropa'
    return ''
  }

  async function doCreate(v: string): Promise<void> {
    const d = newDlg
    newDlg = null
    if (!d) return
    await withDb(async (db) => {
      if (d.kind === 'project') await nodes.createProject(db, v || undefined)
      else if (d.kind === 'unit') await nodes.createUnit(db, d.parent, v || undefined)
      else await nodes.createLecture(db, d.parent, v || undefined)
      snacks.show('建好了')
    })
  }

  const tree = $derived(store.tree.k === 'ok' ? store.tree.data : [])

  /** 右上微型坐标 —— `ATL · 08.31`（N4 档：机器编的号，大写） */
  const coord = ((): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `ATL · ${p(d.getMonth() + 1)}.${p(d.getDate())}`
  })()

  const stamp = ((): string => {
    const d = new Date()
    const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()]
    const mo = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]
    return `${wd} · ${mo} ${d.getDate()}`
  })()
</script>

{#if nav?.k === 'lec'}
  <Lecture
    id={nav.id}
    onback={() => route.pop()}
    onitem={(itemId) => route.push({ k: 'item', id: itemId })}
  />
{:else if nav?.k === 'item'}
  <Detail id={nav.id} onback={() => route.pop()} />
{:else}
  <div class="view">
    <!-- ★ 屏顶整块删掉（第十九则指令 §六/§七）：
         「今天」重复底部 Tab；那个 ＋ 与下面「书房」行的 ＋ 是同一个动作。
         今日块因此直接落在屏顶 —— 它本来就是这一屏的主角。 -->
    {#if note}<div class="note" role="status">{note}</div>{/if}

    {#if store.db.k === 'error'}
      <div class="empty">
        <div class="t zh2">库没打开</div>
        <div class="s">{store.db.message}</div>
      </div>
    {:else if store.tree.k === 'loading' || store.db.k === 'opening' || store.db.k === 'idle'}
      <div class="empty">
        <div class="t zh2">读取中…</div>
        <div class="mline">DB {store.db.k} · TREE {store.tree.k}</div>
      </div>
    {:else if store.tree.k === 'error'}
      <div class="empty">
        <div class="t zh2">{CANT_READ}</div>
        <div class="s">{store.tree.message}</div>
      </div>
    {:else if tree.length === 0}
      <div class="empty">
        <div class="dust">
          <svg class="d1" viewBox="0 0 24 24"><use href="#nyx-star" /></svg>
          <svg class="d2" viewBox="0 0 24 24"><use href="#nyx-star" /></svg>
          <svg class="d3" viewBox="0 0 24 24"><use href="#nyx-star" /></svg>
        </div>
        <div class="t">Nothing here yet.</div>
        <div class="s">连上云端，你在电脑里积累的<br />知识点、例句和进度，会在这里亮起来。</div>
        <!-- ★★ 2026-09-13 · 这颗按钮以前只会说「还没接上」—— **那是假话**：
             同步早就通了，配置就在 Settings › Data 里。一个能用的功能被一句
             「还没接上」挡在门外，比没有这颗按钮更糟（D-412）。
             现在直达那一页；`goto` 会把目标 Tab 的栈整条换掉，返回链是干净的。 -->
        <button class="btn center" onclick={() => route.goto('settings', { k: 'pg', pg: 'data' })}>
          <span class="zh">连接云端</span>
        </button>
        <div class="mline">或先直接用 · 待上传指示会看住你的记录</div>
      </div>
    {:else}
      <!-- ★★ 今日块（第三种方案定版）：**浅紫底 + 描边**，不是黑砖也不是裸排版。
           按钮**收进块里** —— 它是这一块的动作，不是页面的动作。
           D-356 机制透明：reason 原样透出，判据在 core/daily-match。 -->
      <!-- ★★★ 这一块**没有** `data-guide`（2026-09-15 使用者经主控裁「甲」）。
           B-1 那句是「贴一段英文进来，Nyx 会从里面挑出值得练的。」——
           **Android 上没有这个入口**：全 UI 里没有任何贴材料的地方（收材料走 Assist 划词、
           或从电脑同步过来），D-299「数据尽量共享，能力不必复制」、D-311 不做长材料。
           而这一块从头到尾讲的是今天练什么（条数 · reason · 开始 / 随时练习），
           指着它说「贴一段英文进来」= 指着一个东西说另一件事（D-412）。
           ★ 名单里仍有这条（两端同一份 core），所以「这一端不做」要写在闸里，
             不是靠这里没标记来表达 —— `check:guide-ids` 的 `NOT_ON_THIS_END`（D 的 V-8）。
             D 的 `47017c9` 已经把那张永久名单做好了 —— 名单里的 id 一旦在屏上又出现靶子，
             那道闸会当场红（「永久不做」和「做了」不可能同时是真的）。 -->
      <div class="today">
        <!-- DS §17.3 的 HUD 四件（2026-09-01 补上）：网格在 ::before，
             四角刻度 · 右上坐标 · 大数前导零在这里 -->
        <span class="cn a"></span><span class="cn b"></span>
        <span class="cn c"></span><span class="cn d"></span>
        <span class="coord">{coord}</span>
        <div class="k">Today</div>
        {#if store.today}
          {#if store.today.total > 0}
            {@const p3 = String(store.today.total).padStart(3, '0')}
            {@const zn = p3.length - String(store.today.total).length}
            <!-- ★ 长按这个数 = 改每日目标（F-011）。入口在**它起作用的地方**，
                 不新增设置项 —— 见 db/today.ts::setDailyTarget 的注释。
                 ★★ `today-recommend`（清单 15）的靶子就是这个数：那句说的是
                   「今天这个数是推荐，不是上限」—— 指的就是它，不是整块。
                   本页两条（`sidebar-tree` + 本条），CR-3 每页 ≤ 2。
                 ★ 数为 0 时这一块不渲染（DS v5 §2.6），那时也没有「这个数」可解释 ——
                   没有目标就没有引导，不是漏挂。 -->
            <div
              class="n"
              data-guide="today-recommend"
              use:longpress={() => (targetDlg = true)}
              title="长按可改每日目标"
              aria-label="今日 {store.today.total} 条待做 · 长按可改每日目标"
            ><b><span class="z">{p3.slice(0, zn)}</span>{p3.slice(zn)}</b><span class="zh">条待做</span>
              <!-- ★ 改每日目标的把手（F-011 · 使用者 2026-09-09 裁「数字旁一枚极轻的记号」）。
                   在这之前这件事**只有长按**，屏上没有任何痕迹，于是一屏最响的那个数
                   是「看得见、改不了」—— D-408 当初踩的正是这个坑。
                   ★ 零新增设置项（D-408 判掉的是「回到设置里去」，不是「让它可发现」）：
                     点它与长按那个数走**同一个对话框**，不是第二条路。
                   ★ 用调节那枚图形（几何仍是 core 里那一份，D-410），不是一个「去设置」的箭头。 -->
              <button
                class="tgoal"
                aria-label="改每日目标（现在 {store.today.target} 条）"
                onclick={(e) => {
                  e.stopPropagation()
                  targetDlg = true
                }}
              ><svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-settings" /></svg></button>
            </div>
            <div class="w zh">{store.today.reason}</div>
            {@const lecIds = store.today.lectures.map((l) => l.lectureId)}
            <div class="go">
              <button class="btn sm pri" onclick={() => (practice.open = { kind: 'production', lectureIds: lecIds })}>
                <span class="zh">开始</span>
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
              </button>
            </div>
          {:else}
            <!-- ★ DS v5 §2.6：数值为 0 时**不出大数** —— 否则全屏最响的元素
                 说的是「今天没事做」，正是审计里的病灶 C。 -->
            <!-- ★ 这一行也长按可改（F-011）：半数规则会因为「目标太小凑不够半个讲」
                 而停在 0 条，那时候能改目标正是他要的。reason 会把停点说清楚。 -->
            <div class="rest zh" use:longpress={() => (targetDlg = true)} title="长按可改每日目标">{store.today.reason}</div>
            <div class="go">
              <button class="btn sm sec2" onclick={() => (practice.open = { kind: 'production', lectureIds: [] })}>
                <span class="zh">随时练习</span>
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg>
              </button>
            </div>
          {/if}
        {:else}
          <div class="w zh">排期算不出来 —— 树那边若正常，重进这个 Tab 再试。</div>
        {/if}
      </div>

      <!-- ★ 项目 / 单元行上**没有展开记号**（使用者 2026-09-09 裁「真的删掉」）。
           我提过它的后果并且他确认了：那个 `›` 本来不是「点进去」而是「展开收起」
           （展开时转 90°），删掉之后屏上看不出这一行能展开，得点一下才知道。
           他要的是更干净的一屏，这是明码的取舍，不是漏掉。
           ★ 真正「点进去」的 lecture 行本来就没有箭头，所以两者不会再混。 -->
      <div class="sec" data-guide="sidebar-tree">
        Projects
        <span class="rt"><button class="sellink" onclick={() => (createOpen = true)}><svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="margin-right:4px"><use href="#nyx-plus" /></svg>新建</button></span>
      </div>

      {#each tree as p (p.id)}
        {@const pk = `p:${p.id}`}
        <!-- ★★ 项目 = 一张卡（第三种方案）：**白卡头 + 浅底单元行**，
             层级一眼可读。此前是一列扁平 .li，全靠缩进和底色区分。
             ★ 卡头是 --paper 压在 --surface 上 —— 严格说触到我写的 §10.2
             「一个面之内不许再出现第二个面」，但这是使用者亲批的原型形态；
             按 D-417「我的提案不自动生效」，亲批优先，规则记账。 -->
        <div class="pg" use:dragRow={{ group: 'p', id: p.id, siblings: () => tree.map((x) => x.id) }}>
          <div class="h {dcls('p', p.id)}">
            <button class="hit" onclick={() => store.toggle(pk)}>
              <span class="nm">{p.name}</span>
              {#if p.pinned}<span class="tag t-v">PIN</span>{/if}
              <span class="num" title="这个项目底下不重复的知识点条数（一条挂在两个 Lecture 下面也只算一条）"
                >{p.itemCount}</span>
            </button>
            <button class="ibtn sm" aria-label="{p.name} 的更多操作"
              onclick={() => (menu = { kind: 'project', id: p.id, name: p.name, pinned: p.pinned })}
            ><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
          </div>

          {#if store.isOpen(pk)}
            {#each p.units as u (u.id)}
              {@const uk = `u:${u.id}`}
              <div class="u {dcls(`u${p.id}`, u.id)}"
                use:dragRow={{ group: `u${p.id}`, id: u.id, siblings: () => p.units.map((x) => x.id) }}>
                <button class="hit" onclick={() => store.toggle(uk)}>
                  <span class="nm">{u.name}</span>
                  <span class="num" title="这个单元底下不重复的知识点条数（一条挂在两个 Lecture 下面也只算一条）"
                    >{u.itemCount}</span>
                </button>
                <button class="ibtn sm" aria-label="{u.name} 的更多操作"
                  onclick={() => (menu = { kind: 'unit', id: u.id, name: u.name })}
                ><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
              </div>

              {#if store.isOpen(uk)}
                {#each u.lectures as l (l.id)}
                  <div class="u lec {dcls(`l${u.id}`, l.id)}"
                    use:dragRow={{ group: `l${u.id}`, id: l.id, siblings: () => u.lectures.map((x) => x.id) }}>
                    <button class="hit" onclick={() => route.push({ k: 'lec', id: l.id })}>
                      <span class="nm">
                        {l.name}
                        {#if isDue(l.dueAt)}<span class="tag t-w gap">DUE</span>{/if}
                      </span>
                      <span class="num">{l.itemCount}</span>
                      <!-- ★ 行末 caret 已删（DS §10.2e①）：这一行右边紧挨着 ⋮，
                           两个尾控件并排看着像两个按钮，而 › 说的是整行本来就在说的事。
                           ★ 项目/单元行的 caret **不删** —— 那是开合指示，不是「点进去」。 -->
                    </button>
                    <button class="ibtn sm" aria-label="{l.name} 的更多操作"
                      onclick={() => (menu = { kind: 'lecture', id: l.id, name: l.name })}
                    ><svg class="ic" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-more" /></svg></button>
                  </div>
                {:else}
                  <div class="u lec"><span class="nm zh dim">（这个单元还没有 Lecture）</span></div>
                {/each}
              {/if}
            {:else}
              <div class="u"><span class="nm zh dim">（这个项目还没有单元）</span></div>
            {/each}
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{/if}

{#if menu}
  <Menu
    target={menu}
    {tree}
    onclose={() => (menu = null)}
    onact={(a) => void onMenuAct(a)}
  />
{/if}

{#if movePick}
  {@const mv = movePick}
  <SavePicker
    upto={mv.kind === 'unit' ? 'p' : 'u'}
    title={`把「${mv.name}」移到`}
    confirm="移过去"
    allowCreate={false}
    onpick={(toId) => void doMove(toId)}
    onclose={() => (movePick = null)}
  />
{/if}

{#if createOpen}
  <CreateMenu
    {tree}
    onclose={() => (createOpen = false)}
    onpick={(t) => {
      createOpen = false
      newDlg = t
    }}
  />
{/if}

{#if confirmDel}
  <Dialog
    title={`删除「${confirmDel.name}」？`}
    input={null}
    confirm="删除"
    danger
    onclose={() => (confirmDel = null)}
    onconfirm={() => {
      const run = confirmDel?.run
      confirmDel = null
      if (run) void run()
    }}
  >
    <!-- ★ 说真话：它**可以**撤销，就不许写成不可撤销 -->
    <p class="dlg-note">移到回收站，<b>{TRASH_KEEP_TEXT}</b>。</p>
  </Dialog>
{/if}

{#if dlg}
  <Dialog
    title={`改名 · ${dlg.name}`}
    input={dlg.name}
    confirm="就叫这个"
    onclose={() => (dlg = null)}
    onconfirm={doRename}
  />
{/if}

{#if targetDlg}
  <Dialog
    title="每天练多少条"
    input={String(store.today?.target ?? 35)}
    placeholder="{DAILY_TARGET_MIN} ～ {DAILY_TARGET_MAX}"
    confirm="就这么多"
    onclose={() => (targetDlg = false)}
    onconfirm={(v) => void saveTarget(v)}
  >
    <!-- 机制透明（D-356）：说清这个数怎么用的，以及它会跟着人走 -->
    <div class="dlg-note">
      Lecture <b>整取不截断</b>：凑到差不多就停，实际条数会高于或低于这个数。<br />
      这一项<b>跟着你走</b> —— 在电脑上也是同一个值。
    </div>
  </Dialog>
{/if}

{#if newDlg}
  <Dialog
    title={newDlg.kind === 'project' ? '新建项目' : newDlg.kind === 'unit' ? '新建单元' : '新建 Lecture'}
    input=""
    placeholder="留空用默认名"
    confirm="建"
    allowEmpty
    onclose={() => (newDlg = null)}
    onconfirm={doCreate}
  />
{/if}

