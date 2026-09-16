<script lang="ts">
  /**
   * 项目 / 单元 / 讲次的 ⋮ 菜单 —— **照搬 Windows 的动作清单**
   *
   * ══ 为什么要照搬 ★★ ═══════════════════════════════════════
   *
   * 使用者：「原来的有什么现在的页尽量有」。
   * 所以这份清单不是我设计的，是从 `nyx_project/src/renderer/src/App.svelte`
   * 的树菜单里**逐条读出来的**：
   *
   *   改名 · 置顶（仅项目）· 归档 · 打回待审阅（仅讲次）·
   *   移到…（非项目）· ＋新建下一级 · 删除
   *   ★ 2026-08-30 按已批《上下文操作审计》收编：去掉 导出笔记 / 复制一份
   *   （审计清单没给它们）；讲次行补 认读 / 产出 快捷（核心不藏的重复入口）。
   *
   * ★★ 2026-09-15（D-485）：容器层那个动作以前界面上叫「**归档**」，
   *   而知识点那一层叫「静默」—— 同一个 `silent` 列，屏上两个词。
   *   现在两层统一成一套：动作「收起来」· 反向「放回去」· 状态「收起来了」
   *   （自动练成的那一半叫「已练成」，容器层没有那一档）。
   *   词从 core 拿（`SILENCE_ACTIONS`），两端一个说法。
   *   ★ `silenceLabel` 2026-09-15 随「已练成」退役一起从 core 删了（D-489）。
   *
   * ══ ★★★ 二级下拉：「移到…」════════════════════════════════
   *
   * 点「移到…」之后**菜单内容整个换成目标列表**，带「← 换个项目」「← 返回」。
   * 这是 Windows 的做法，也是使用者点名要的那个「二级下拉框」。
   *
   * 为什么不弹第二个浮层：手机屏窄，两层浮层叠起来会把内容全挡住，
   * 而且返回路径会变成两次「返回」。**换内容只有一层，返回永远是一步。**
   *
   * ══ 边界：这些动作**不是全给** ═══════════════════════════
   *
   * ★ D-302：**改层级（A/B）不给** —— 层级属「既有知识内容」，对同步下来的只读。
   * ★ D-359：删除**给**，但只给软删（进回收站，可恢复，天数见 TRASH_DAYS），**不给硬删**。
   * ★ D-361：拖动是**排序**，和「移到…」是两件事 —— 前者同类同父不跨级。
   *
   * ★ D-227：这个文件里一行样式都没有。
   */
  import type { TreeProject } from '../../db/tree.ts'
  import type { MenuAction, MenuTarget } from './menu-types.ts'
  import MenuShell from './MenuShell.svelte'
  import { ROTATION_WORDS, SILENCE_ACTIONS, TRASH_KEEP_TEXT } from '../../core-link.ts'

  let {
    target,
    tree,
    onclose,
    onact,
  }: {
    target: MenuTarget
    /** 「移到…」要用它列目标 */
    tree: TreeProject[]
    onclose: () => void
    /**
     * 动作交给上层做 —— 这个组件**不碰数据库**。
     * `moveTo` 带上目标 id；别的不带参数。
     */
    onact: (action: MenuAction, payload?: string) => void
  } = $props()

  /**
   * 菜单的三种面：主菜单 / 改名 / 移到（二级）。
   * ★ 「移到」选到哪个项目单独存 —— 塞进联合类型里，
   *   `$derived` 里读它就得先收窄，而收窄在 derived 表达式里做不干净。
   */

  /** 系统返回：二级面先退回主面（外壳负责「否则关掉整个菜单」） */

  const KIND_ZH = { project: 'Project', unit: 'Unit', lecture: 'Lecture' } as const
  /** 下一级叫什么 —— 讲次没有下一级 */
  const CHILD = { project: 'Unit', unit: 'Lecture', lecture: null } as const

  /** 移动的候选：单元挪到别的项目下；讲次挪到别的单元下 */
  const projects = $derived(tree)
</script>

<MenuShell {onclose}>
      <div class="mhead">{KIND_ZH[target.kind]} · {target.name}</div>

    <!-- 改名走统一居中 Dialog（D-393）—— 菜单不再自带输入面 -->
    <button class="mi" onclick={() => onact('rename')}>改名</button>

    {#if target.kind === 'project'}
      <button class="mi" class:ck={target.pinned} onclick={() => onact('pin')}>
        {target.pinned ? '取消置顶' : '置顶'}
      </button>
    {/if}

    <button class="mi" class:ck={target.archived} onclick={() => onact('archive')}>
      {target.archived ? SILENCE_ACTIONS.restore : SILENCE_ACTIONS.shelve}
    </button>

    {#if target.kind === 'lecture'}
      <!-- ★ T-5.13（D-R22）：整讲排队分析。已经有完整解析的条目不进队，
           所以点它不会重复花钱 —— 具体跳过几条，状态行上会说。 -->
      <button class="mi" onclick={() => onact('analyse')}>分析</button>
      <!-- ★ T-9.13（D-478②）：查重。点开**只扫描**，并不并由他在对话框里点；
           合并是软删（可恢复，天数见 TRASH_DAYS），但「他没看见就发生了」这件事不可逆。 -->
      <button class="mi" onclick={() => onact('dedup')}>查重</button>
      <button class="mi" onclick={() => onact('read')}>认读</button>
      <button class="mi" onclick={() => onact('produce')}>产出</button>
      <button class="mi" onclick={() => onact('unread')}>打回待审阅</button>
    {/if}

    {#if target.kind !== 'project'}
      <button class="mi" onclick={() => onact('move')}>移到…</button>
    {/if}

    <div class="msep"></div>

    {#if CHILD[target.kind]}
      <!-- I-071 · 新建挪进菜单，行内不再放「＋」——
           手机上更成立：一行里塞两个图标，名字一长就全乱 -->
      <button class="mi" onclick={() => onact('newChild')}>＋ 新建 {CHILD[target.kind]}</button>
    {/if}
    <!-- ★ 「测试…」已移除（DS §10.2e · 2026-09-01）：开发期的取卡口子，
         产品语义上使用者永远不需要「测试」，却占着菜单的一格。 -->

    <div class="msep"></div>
    <button class="mi dg" onclick={() => onact('delete')}>删除</button>

    <div class="mnote">
      <b>{SILENCE_ACTIONS.shelve}</b>＝不再{ROTATION_WORDS.schedule}，进度一个字不动。<br />
      <b>删除</b>进回收站，{TRASH_KEEP_TEXT}；这个 Lecture 独有的知识点跟着走。
    </div>
</MenuShell>
