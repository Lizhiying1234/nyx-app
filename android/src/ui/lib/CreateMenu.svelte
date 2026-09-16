<script lang="ts">
  /**
   * 统一的「＋」入口 —— D-411 治法之一。
   *
   * ══ 此前是什么样 ══════════════════════════════════════════
   * 屏顶的 `＋` **只能建项目**；要建单元/讲次得先找到父节点、点它的 ⋮、
   * 再点「＋新建下一级」。同一件事两条路，而且显眼的那条只能做三分之一。
   *
   * ══ 现在 ══════════════════════════════════════════════════
   *   ＋ → 建什么（项目 / 单元 / 讲次）→〔换脸选父节点〕→ 起名 → 建
   *
   * ★ 选父节点**换脸**，不叠第二层浮层 —— 与「移到…」同一套语言（§10.2）。
   * ★ 建的动作本身不在这里：这个组件只负责**问清楚建什么、建在哪**，
   *   拿到答案交给宿主（宿主已有 `doCreate`，判据在 manage-nodes.ts）。
   * ★ D-227：这个文件里一行样式都没有。
   */
  import type { TreeProject } from '../../db/tree.ts'
  import MenuShell from './MenuShell.svelte'

  export type CreateTarget =
    | { kind: 'project' }
    | { kind: 'unit'; parent: number }
    | { kind: 'lecture'; parent: number }

  let {
    tree,
    onclose,
    onpick
  }: {
    tree: TreeProject[]
    onclose: () => void
    onpick: (t: CreateTarget) => void
  } = $props()

  /** main = 建什么；pickP = 选项目；pickU = 选单元（只有建讲次会走到） */
  type Face = 'main' | 'pickP' | 'pickU'
  let face = $state<Face>('main')
  /** 走到 pickU 时，已经选好的项目 */
  let proj = $state<number | null>(null)

  const backFace = (): boolean => {
    if (face === 'main') return false
    if (face === 'pickU') {
      face = 'pickP'
      proj = null
    } else face = 'main'
    return true
  }

  /** 建单元 or 建讲次 —— 决定选完项目之后是收工还是继续选单元 */
  let want = $state<'unit' | 'lecture'>('unit')

  const units = $derived(proj === null ? [] : (tree.find((p) => p.id === proj)?.units ?? []))
  /** 没有项目就建不了单元；没有单元就建不了讲次 —— 如实说，不给死按钮 */
  const anyProject = $derived(tree.length > 0)
  const anyUnit = $derived(tree.some((p) => p.units.length > 0))

  function chooseProject(id: number): void {
    if (want === 'unit') {
      onpick({ kind: 'unit', parent: id })
      return
    }
    proj = id
    face = 'pickU'
  }
</script>

<MenuShell {onclose} onback={backFace}>
  {#snippet title()}
    {#if face === 'main'}新建
    {:else if face === 'pickP'}建在哪个项目
    {:else}建在哪个单元{/if}
  {/snippet}

  {#if face === 'main'}
    <button class="mi" onclick={() => onpick({ kind: 'project' })}>
      Project
    </button>
    {#if anyProject}
      <button class="mi" onclick={() => ((want = 'unit'), (face = 'pickP'))}>
        Unit
      </button>
    {/if}
    {#if anyUnit}
      <button class="mi" onclick={() => ((want = 'lecture'), (face = 'pickP'))}>
        Lecture
      </button>
    {/if}
    {#if !anyProject}
      <div class="mnote">还没有 Project —— <b>先建一个 Project</b>，Unit 和 Lecture 才有地方放。</div>
    {:else if !anyUnit}
      <div class="mnote">还没有 Unit —— <b>先建一个 Unit</b>，Lecture 才有地方放。</div>
    {/if}
  {:else if face === 'pickP'}
    {#each tree as p (p.id)}
      {@const n = want === 'lecture' ? p.units.length : 0}
      {#if want === 'unit' || n > 0}
        <button class="mi go" onclick={() => chooseProject(p.id)}>
          <span class="zh">{p.name}</span>
          {#if want === 'lecture'}<span class="min">{n} 单元</span>{/if}
        </button>
      {/if}
    {/each}
    <div class="msep"></div>
    <button class="mi back" onclick={() => (face = 'main')}>← 返回</button>
  {:else}
    {#each units as u (u.id)}
      <button class="mi go" onclick={() => onpick({ kind: 'lecture', parent: u.id })}>
        <span class="zh">{u.name}</span>
        <span class="min">{u.lectures.length} 讲</span>
      </button>
    {/each}
    <div class="msep"></div>
    <button class="mi back" onclick={() => ((face = 'pickP'), (proj = null))}>← 换个项目</button>
  {/if}
</MenuShell>
