<script lang="ts">
  /**
   * 节点选择器 —— **全应用唯一的「挑一个树上的位置」**。
   * 默认保存位置用它，`⋮ → 移到…` 也用它（2026-09-01 统一）。
   *
   * ══ 为什么统一（第二十则指令 · 交互层级审计）══════════════
   * 审计查出来：同一个动作长成了两个样 ——
   *   本组件：三段**同时可见**，任何一段随时改
   *   Menu 的「移到…」：**逐级下钻**（选项目 → 换脸 → 选单元 → 「← 换个项目」）
   * 而本组件的注释里白纸黑字写着「不是逐级下钻 —— **那版被否过**」。
   * 同一件事两份判据，是这个仓库最贵的事故形态。使用者裁决：统一成这一版。
   *
   * ══ Windows 原逻辑（PathPicker.svelte · I-093）═══════════════
   *   「项目___▾ 单元___▾ Lecture___▾ —— 横线可以直接新建，下拉选已有的。」
   *   · 三段**同时看得见**，任何一段随时改（不是逐级下钻 —— 那版被否过）
   *   · 横线敲一个不存在的名字 = 就地新建；撞名 = 选中它，不建重名
   *   · 上一级没选，下一级 blocked（说清楚，不给点不动的框）
   *   · 选完**不立刻入库**：路径先显示出来，确认了才存
   * ══ Android 适配 ═══════════════════════════════════════════
   *   弹窗承载（Dialog 同族面：scrim + .dialog）；三段竖排（窄屏）；
   *   下拉 = 行下内联展开（不做 fixed 浮层）。新建走 manage-nodes
   *   的同一份判据（阶段 5 已接线的 createProject/Unit/Lecture）。
   *
   * ★ 存的是**本机** settings（assist.save.lectureId）：fk-map 会跨端重编号，
   *   id 绝不许进 USER prefs（DATA_CONTRACT）。★ D-227 零样式。
   */
  import { untrack } from 'svelte'
  import { store } from './store.svelte.ts'
  import { registerBack } from './backstack.svelte.ts'
  import { createLecture, createProject, createUnit } from '../../db/manage-nodes.ts'

  type Level = 'p' | 'u' | 'l'

  let {
    onpick,
    onauto,
    onclose,
    /** 挑到哪一级为止：'l' = 讲次（存位置）· 'u' = 单元（移讲次）· 'p' = 项目（移单元） */
    upto = 'l',
    title = '默认保存位置',
    confirm = '就存这里',
    /**
     * 「不指定」那一档叫什么。★ 两侧的「不指定」**不是同一件事**（T-5.9②）：
     *   Assist 不指定 = 自动落 `Inbox › 宿主App › Saved`；
     *   Lookup 不指定 = **跟随 Assist**（Assist 也没配才落 `Inbox › Lookup › Saved`）。
     * 同一个按钮写同一句「用自动」会把这两件事说成一件，所以名字由调用方给。
     */
    autoLabel = '用自动',
    /** 移动时**不给新建** —— 移动是安置已有的东西，不是造新的 */
    allowCreate = true
  }: {
    onpick: (id: number) => void
    /** 只有「默认保存位置」有「不指定」这一档 */
    onauto?: () => void
    onclose: () => void
    upto?: Level
    title?: string
    confirm?: string
    autoLabel?: string
    allowCreate?: boolean
  } = $props()

  /** 这一次要显示的段（永远从项目开始，到 upto 为止） */
  const LEVELS = $derived((['p', 'u', 'l'] as const).slice(0, { p: 1, u: 2, l: 3 }[upto]))

  interface Lec {
    id: number
    name: string
  }
  interface Unit {
    id: number
    name: string
    lectures: Lec[]
  }
  interface Proj {
    id: number
    name: string
    units: Unit[]
  }

  const PLACE: Record<Level, string> = { p: 'Project', u: 'Unit', l: 'Lecture' }

  let tree = $state<Proj[]>([])
  let pid = $state<number | null>(null)
  let uid = $state<number | null>(null)
  let lid = $state<number | null>(null)
  let draft = $state<Record<Level, string>>({ p: '', u: '', l: '' })
  let open = $state<Level | null>(null)
  let err = $state<string | null>(null)
  let busy = $state(false)

  /** 确认按钮看的是**最后一段**选没选 */
  const pickedId = $derived(upto === 'p' ? pid : upto === 'u' ? uid : lid)

  $effect(() => registerBack(() => (onclose(), true)))

  async function loadTree(): Promise<void> {
    if (store.db.k !== 'ok') return
    const db = store.db.db
    const ps = await db.all(
      `select id, name from projects where deleted_at is null order by pinned desc, sort, name`
    )
    const out: Proj[] = []
    for (const p of ps) {
      const us = await db.all(
        `select id, name from units where project_id = ? and deleted_at is null order by sort, name`,
        [Number(p['id'])]
      )
      const units: Unit[] = []
      for (const u of us) {
        const ls = await db.all(
          `select id, name from lectures where unit_id = ? and deleted_at is null order by sort, name`,
          [Number(u['id'])]
        )
        units.push({
          id: Number(u['id']),
          name: String(u['name']),
          lectures: ls.map((l) => ({ id: Number(l['id']), name: String(l['name']) }))
        })
      }
      out.push({ id: Number(p['id']), name: String(p['name']), units })
    }
    tree = out
  }
  $effect(() => {
    untrack(() => void loadTree())
  })

  const units = $derived(tree.find((p) => p.id === pid)?.units ?? [])
  const lectures = $derived(units.find((u) => u.id === uid)?.lectures ?? [])
  const optionsOf = (lv: Level): { id: number; name: string }[] =>
    lv === 'p' ? tree : lv === 'u' ? units : lectures
  const blocked = (lv: Level): boolean => (lv === 'u' && pid === null) || (lv === 'l' && uid === null)

  /** 选中的路径 —— 只显示到 `upto` 那一级（移单元时不该出现讲次） */
  const chosen = $derived.by(() => {
    const p = tree.find((x) => x.id === pid)
    if (!p) return null
    if (upto === 'p') return p.name
    const u = p.units.find((x) => x.id === uid)
    if (!u) return null
    if (upto === 'u') return `${p.name} › ${u.name}`
    const l = u.lectures.find((x) => x.id === lid)
    return l ? `${p.name} › ${u.name} › ${l.name}` : null
  })

  function choose(lv: Level, o: { id: number; name: string }): void {
    err = null
    open = null
    if (lv === 'p') {
      pid = o.id
      uid = lid = null
      draft = { p: o.name, u: '', l: '' }
    } else if (lv === 'u') {
      uid = o.id
      lid = null
      draft = { ...draft, u: o.name, l: '' }
    } else {
      lid = o.id
      draft = { ...draft, l: o.name }
    }
  }

  /** 横线上敲不存在的名字 → 就地建（撞名=选中，不建重名）—— Windows 同款 */
  async function createFromDraft(lv: Level): Promise<void> {
    const name = draft[lv].trim()
    if (!name || blocked(lv) || busy || store.db.k !== 'ok') return
    const hit = optionsOf(lv).find((o) => o.name === name)
    if (hit) {
      choose(lv, hit)
      return
    }
    busy = true
    err = null
    try {
      const db = store.db.db
      if (lv === 'p') {
        const id = await createProject(db, name)
        await loadTree()
        pid = id
        uid = lid = null
        draft = { p: name, u: '', l: '' }
      } else if (lv === 'u') {
        const id = await createUnit(db, pid!, name)
        await loadTree()
        uid = id
        lid = null
        draft = { ...draft, u: name, l: '' }
      } else {
        const id = await createLecture(db, uid!, name)
        await loadTree()
        lid = id
        draft = { ...draft, l: name }
      }
      open = null
      await store.reload()
    } catch (e) {
      err = (e as Error)?.message ?? String(e)
    } finally {
      busy = false
    }
  }

  const canCreate = (lv: Level): boolean =>
    draft[lv].trim().length > 0 &&
    !blocked(lv) &&
    !optionsOf(lv).some((o) => o.name === draft[lv].trim())

  const filtered = (lv: Level): { id: number; name: string }[] => {
    const q = draft[lv].trim().toLowerCase()
    const all = optionsOf(lv)
    return q && open === lv ? all.filter((o) => o.name.toLowerCase().includes(q)) : all
  }
</script>

<div class="scrim" role="button" tabindex="-1" aria-label="关掉" onclick={onclose} onkeydown={(e) => e.key === 'Escape' && onclose()}></div>

<div class="dialog" role="dialog" aria-modal="true" aria-label={title}>
  <div class="dlg-t zh">{title}</div>

  {#each LEVELS as lv (lv)}
    <div class="ppr">
      <input
        class="dlg-in"
        placeholder={blocked(lv) ? `先选 ${lv === 'u' ? 'Project' : 'Unit'}` : PLACE[lv]}
        disabled={blocked(lv)}
        bind:value={draft[lv]}
        onfocus={() => (open = lv)}
        onkeydown={(e) => {
          if (e.key === 'Enter') void createFromDraft(lv)
        }}
      />
      <button class="ppcar" disabled={blocked(lv)} aria-label="{PLACE[lv]} 下拉"
        onclick={() => (open = open === lv ? null : lv)}><svg class="ic arr" class:open={open === lv} width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><use href="#nyx-caret" /></svg></button>
    </div>
    {#if open === lv}
      <div class="pplist">
        {#if allowCreate && canCreate(lv)}
          <button class="ppo new zh" onclick={() => void createFromDraft(lv)}>＋ 新建「{draft[lv].trim()}」</button>
        {/if}
        {#each filtered(lv) as o (o.id)}
          <button
            class="ppo"
            class:on={(lv === 'p' ? pid : lv === 'u' ? uid : lid) === o.id}
            onclick={() => choose(lv, o)}>{o.name}</button>
        {/each}
        {#if filtered(lv).length === 0 && !(allowCreate && canCreate(lv))}
          <div class="ppo dim zh">
            {allowCreate ? `还没有 ${PLACE[lv]} —— 在横线上打个名字就能建。` : `还没有 ${PLACE[lv]}。`}
          </div>
        {/if}
      </div>
    {/if}
  {/each}

  {#if chosen}
    <div class="m blk zh" style="margin:10px 0 0">{upto === 'l' ? '存到' : '移到'}：{chosen}</div>
  {/if}
  {#if err}<div class="note" role="alert">{err}</div>{/if}

  <div class="dlg-acts">
    {#if onauto}<button class="pill" onclick={onauto}>{autoLabel}</button>{/if}
    <button class="pill" onclick={onclose}>取消</button>
    <button class="pill v" disabled={pickedId === null}
      onclick={() => pickedId !== null && onpick(pickedId)}>{confirm}</button>
  </div>
</div>
