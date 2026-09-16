<script lang="ts">
  import type { TreeProject } from '@shared/api.ts'
  import { cleanMessage } from '@shared/api.ts'
  import Ic from './Ic.svelte'

  /**
   * 三段式路径选择器 · I-093
   *
   * 使用者原话：
   *   「项目___ 下拉箭头  单元_____ 下拉箭头  Lecture___ 下拉箭头
   *     横线可以直接新建（没有的项目、单元或者 lecture），下拉箭头可以选择已经有的东西。」
   *
   * 上一版我做成了「一级一级往下点的弹窗」—— 那是**逐级缩小范围**，
   * 和他要的不是一回事。区别在两点：
   *   · 三段**同时看得见**，任何一段都能随时改，不用退回上一级重走
   *   · 每一段的横线本身就是新建入口：打字打出一个不存在的名字，回车就建
   *
   * 结构上刻意贴着总原型的既有 class：输入框 `.tin2`、下拉 `.pm` / `.mi`，
   * 不引任何新样式概念（新增的只有一层布局壳，写在 enhancements.css）。
   */
  let {
    tree,
    /** 已经选好的那一讲；null = 还没选 */
    value = null,
    onpick,
    /** 用在弹窗里时给一句抬头 */
    label = '位置'
  }: {
    tree: TreeProject[]
    value?: number | null
    onpick: (lectureId: number) => void
    label?: string
  } = $props()

  type Level = 'p' | 'u' | 'l'

  /** 当前选中的三级 id。value 变了（外面换了一篇文章）要跟着回填 */
  let pid = $state<number | null>(null)
  let uid = $state<number | null>(null)
  let lid = $state<number | null>(null)

  /** 三个横线里正在打的字 */
  let draft = $state<Record<Level, string>>({ p: '', u: '', l: '' })
  /**
   * 哪一段的下拉是打开的，以及它该浮在屏幕的哪个位置。
   *
   * 位置必须**算出来、用 fixed 浮着**：这个选择器要放进弹窗（`.mbox` 是
   * `max-height:100%;overflow-y:auto`），而 `.pp-cell` 是 `position:relative` ——
   * 绝对定位的下拉会被弹窗的 overflow 直接裁掉，长列表根本看不全。
   */
  let open = $state<Level | null>(null)
  let at = $state<{ x: number; y: number; w: number; up: boolean }>({ x: 0, y: 0, w: 0, up: false })

  function place(lv: Level, el: HTMLElement): void {
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    // 下面塞不下就往上翻 —— 弹窗底部那几段永远是这种情况
    const up = below < 200 && r.top > below
    at = { x: r.left, y: up ? r.top - 4 : r.bottom + 4, w: r.width, up }
    open = lv
  }

  const toggle = (lv: Level, el: HTMLElement): void => {
    if (open === lv) open = null
    else place(lv, el)
  }
  let err = $state<string | null>(null)
  let busy = $state(false)

  /** 外面传进来的 lectureId → 回填三级。只在 value 真的变了的时候做 */
  let lastValue = $state<number | null | undefined>(undefined)
  $effect(() => {
    if (value === lastValue) return
    lastValue = value
    if (value == null) {
      pid = uid = lid = null
      draft = { p: '', u: '', l: '' }
      return
    }
    for (const p of tree) {
      for (const u of p.units) {
        const l = u.lectures.find((x) => x.id === value)
        if (l) {
          pid = p.id
          uid = u.id
          lid = l.id
          draft = { p: p.name, u: u.name, l: l.name }
          return
        }
      }
    }
  })

  const projects = $derived(tree)
  const units = $derived(tree.find((p) => p.id === pid)?.units ?? [])
  const lectures = $derived(units.find((u) => u.id === uid)?.lectures ?? [])

  const optionsOf = (lv: Level): { id: number; name: string }[] =>
    lv === 'p' ? projects : lv === 'u' ? units : lectures

  /** 上一级还没选，这一级就没得选也没得建 —— 说清楚，不要给一个点不动的框 */
  const blocked = (lv: Level): boolean => (lv === 'u' && !pid) || (lv === 'l' && !uid)

  const PLACE: Record<Level, string> = { p: '项目', u: '单元', l: 'Lecture' }

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
      onpick(o.id)
    }
  }

  /**
   * 横线上敲一个不存在的名字 → 就地新建。
   * 建完自动选中它，并把下面几级清空 —— 新建的项目底下当然还没有单元。
   */
  async function createFromDraft(lv: Level): Promise<void> {
    const name = draft[lv].trim()
    if (!name || blocked(lv) || busy) return
    // 名字撞上已有的，就当作「选中它」，不要建出两个同名的
    const hit = optionsOf(lv).find((o) => o.name === name)
    if (hit) {
      choose(lv, hit)
      return
    }
    busy = true
    err = null
    try {
      if (lv === 'p') {
        const id = await window.nyx.data.createProject(name)
        pid = id
        uid = lid = null
        draft = { p: name, u: '', l: '' }
      } else if (lv === 'u') {
        const id = await window.nyx.data.createUnit(pid!, name)
        uid = id
        lid = null
        draft = { ...draft, u: name, l: '' }
      } else {
        const id = await window.nyx.data.createLecture(uid!, name)
        lid = id
        draft = { ...draft, l: name }
        onpick(id)
      }
      open = null
    } catch (e) {
      err = cleanMessage(e)
    } finally {
      busy = false
    }
  }

  /** 横线里的字和已有的名字对不上时，下拉顶部给一条「＋ 新建」 */
  const canCreate = (lv: Level): boolean =>
    draft[lv].trim().length > 0 &&
    !blocked(lv) &&
    !optionsOf(lv).some((o) => o.name === draft[lv].trim())

  const filtered = (lv: Level): { id: number; name: string }[] => {
    const q = draft[lv].trim().toLowerCase()
    const all = optionsOf(lv)
    return q ? all.filter((o) => o.name.toLowerCase().includes(q)) : all
  }
</script>

<div class="pp" data-testid="pathpicker">
  <span class="pp-lb">{label}</span>
  {#each ['p', 'u', 'l'] as const as lv (lv)}
    <div class="pp-cell" data-testid="pp-{lv}">
      <input
        class="tin2 pp-in"
        data-testid="pp-in-{lv}"
        placeholder={blocked(lv) ? `先选${lv === 'u' ? '项目' : '单元'}` : PLACE[lv]}
        disabled={blocked(lv)}
        bind:value={draft[lv]}
        onfocus={(e) => place(lv, (e.currentTarget as HTMLElement).parentElement!)}
        onkeydown={(e) => {
          if (e.key === 'Enter') createFromDraft(lv)
          if (e.key === 'Escape') open = null
        }}
      />
      <button
        class="pp-car"
        data-testid="pp-car-{lv}"
        disabled={blocked(lv)}
        aria-label="{PLACE[lv]}下拉"
        onclick={(e) => toggle(lv, (e.currentTarget as HTMLElement).parentElement!)}><Ic n="caret" s={12} r="dn" /></button
      >

      {#if open === lv}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          style="position:fixed;inset:0;z-index:600"
          data-testid="pp-scrim"
          onclick={() => (open = null)}
        ></div>
        <div
          class="pm on pp-menu"
          role="menu"
          tabindex="-1"
          data-testid="pp-menu-{lv}"
          style="left:{at.x}px;{at.up ? `bottom:${window.innerHeight - at.y}px` : `top:${at.y}px`};min-width:{at.w}px"
        >
          {#if canCreate(lv)}
            <div
              class="mi"
              role="menuitem"
              tabindex="-1"
              data-testid="pp-new-{lv}"
              onclick={() => createFromDraft(lv)}
              onkeydown={(e) => e.key === 'Enter' && createFromDraft(lv)}
            >
              <Ic n="plus" s={16} /> 新建「{draft[lv].trim()}」
            </div>
            <div class="sp2"></div>
          {/if}
          {#each filtered(lv) as o (o.id)}
            <div
              class="mi"
              class:ck2={(lv === 'p' ? pid : lv === 'u' ? uid : lid) === o.id}
              role="menuitem"
              tabindex="-1"
              data-testid="pp-opt-{lv}-{o.id}"
              onclick={() => choose(lv, o)}
              onkeydown={(e) => e.key === 'Enter' && choose(lv, o)}
            >
              <span class="mck"><Ic n="check" s={12} /></span>{o.name}
            </div>
          {/each}
          {#if filtered(lv).length === 0 && !canCreate(lv)}
            <div class="cp" style="text-transform:none;letter-spacing:0">
              还没有{PLACE[lv]} —— 在横线上打个名字就能建。
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

{#if err}
  <div class="errbox" data-testid="pp-error" style="margin-top:8px"><div>{err}</div></div>
{/if}
