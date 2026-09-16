/**
 * 全应用**唯一**的导航状态 —— 四个 Tab，每个 Tab 一条页面栈。
 *
 * ══ 为什么要有它（D-411 交互审计 · 2026-08-31）══════════════════
 * 审计清点了 190 个可点元素，其中 **44 个（23.2%）只为「退出」而存在**；
 * 更要紧的是：`tab` 曾经是 `App.svelte` 的一个局部 `$state`，
 * 三个视图各自持有自己的 `nav` —— 于是**跨 Tab 导航在结构上不可能**，
 * 「从词条跳到它在 Vault 里的位置」这种事永远写不出来。
 *
 * ══ 两条轴，不要混（使用者第二轮需求 §六）══════════════════════
 *   **横轴 · 底部 Tab = 换入口。** 点任何 Tab（**含当前这个**）→
 *   把那个 Tab 的栈**清到 Root** 再显示。不恢复深层，不记忆位置。
 *   —— 「底部导航栏不是返回按钮，它代表一级导航入口。」
 *
 *   **纵轴 · 返回手势 = 退一层。** 浮层 → 当前 Tab 的页面栈 →
 *   非 Atlas 回 Atlas → 只有 Atlas Root 才退出 App。
 *
 * 两条轴互不干涉：**横轴永远清栈，纵轴永远退一层。**
 *
 * ★ 返回的消费顺序仍然由 `backstack.svelte.ts` 统一编排，
 *   这里只提供「弹一层」的能力，不监听按键。
 * ★ 每个 Tab 的节点形状由各 Tab 自己定义 —— Route 只管栈，
 *   不管节点长什么样。栈为空 = 该 Tab 的 Root。
 */

import type { LibraryFilter } from '../../db/vault-lists.ts'

export type Tab = 'atlas' | 'lookup' | 'vault' | 'settings'
export const TABS: readonly Tab[] = ['atlas', 'lookup', 'vault', 'settings'] as const

/** Atlas：树 →（讲次）→ 词条详情 */
export type AtlasNode = { k: 'lec'; id: number } | { k: 'item'; id: number }

/**
 * Vault：首页 → 子库 → 词条详情
 * ★ preset 直接用 `LibraryFilter` —— **不在这里另造一份形状**，
 *   那正是这个仓库最贵的事故形态（同一件事两份判据）。
 */
export type VaultNode =
  | { k: 'items'; preset?: LibraryFilter; title?: string; showTotal?: boolean }
  | { k: 'hard' }
  | { k: 'silent' }
  | { k: 'trash' }
  /** 馆藏搜索（F-013 · 2026-09-01）—— 手机没有常驻树，找东西只能靠它 */
  | { k: 'search' }
  | { k: 'lec'; id: number }
  | { k: 'item'; id: number }

/**
  * ★ `kit` 是**样式一览**，不在 ABOUT 页上露面 —— 入口是连点五下构建指纹（F-005）。
  *   它不是产品功能，是「改了令牌之后一眼看出有没有弄坏别处」的对照表。
  */
export type SettingsPg =
  | 'assist'
  | 'assist-ai'
  // ★ T-5.9③（D-R21 已裁 B）：LOOKUP 与 ASSIST 并列成一级 ——
  //   「Lookup 在做什么、Assist 在做什么」一眼分得清，各自一页
  | 'lookup'
  | 'dict'
  | 'speech'
  | 'data'
  | 'about'
  | 'kit'
  // ★ ⑤（2026-09-01）：Prompt 专区 —— 一级入口 + 两个二级页
  | 'prompts'
  | 'prompt-edit'
  | 'qtypes'
  /**
   * ★ 「资源」（2026-09-09 · 使用者交办的新功能）—— 启动页用哪一张。
   *   与 Windows 同名同层级（他那边也是一级）。
   *   ★ 使用者知道这让一级从 7 变 8：那一轮减到 7 是他定的，这一次加回一个也是他定的。
   */
  | 'resources'
  /**
   * ★★ 「连接」（2026-09-13 · 使用者交办）—— AI 服务连到哪。
   *
   * 在这之前它叫 Connection，压在 `assist-ai` 里、和两条 Prompt 并排。
   * 使用者原话：「Connecting 不适合继续放在 Prompt 里面 …… 我更倾向于
   * 把它视为：连接 / 设备 / 同步 / 服务连接相关的系统设置」。
   *
   * ★ 它挂在 Assist 底下本身就是错的：`AiPanel` 那份配置被
   *   `db/ai.ts` · `db/analyse.ts` · `db/lookup.ts` · `db/practice.ts`
   *   **四个模块**读 —— 它是全局的，不是 Assist 的附属。
   *   和两条 Prompt 的关系只是「同一页」，没有任何概念关联。
   * ★ 为什么不并进 Data：Data 的身份是**你的数据**（同步 + 数据安全通知）。
   *   AI 服务连接不是数据，只是「谁替你想」。同步页里那个 Connection 分区
   *   是同步自己的故事的一部分，不是一份独立的服务配置 —— 两者不同族。
   * ★ 一级从 8 变 9。判据用使用者 2026-09-09 定的那条（不是数量上限）：
   *   「之前是因为功能重合或者我决定有些可以合并，但这一次它是独立的特殊的功能，所以加」。
   */
  | 'connection'
  /**
   * ★ 「资源」下的两页（2026-09-13 · 使用者交办配色模式）。
   *   Resources 本身从「一页装着启动页」改成**枢纽**：启动页 · 配色 各一页。
   *   出处是他的原话：「位置：Settings → Resources → Colors」—— Colors 在
   *   Resources **下面**，那 Resources 就得是个能往下走的层。
   */
  | 'resources-splash'
  | 'colors'
/** Settings：首页 → 分类 → 子设置 */
export type SettingsNode = { k: 'pg'; pg: SettingsPg }

export type Node = AtlasNode | VaultNode | SettingsNode

class Route {
  tab = $state<Tab>('atlas')
  /** 四条栈。**空 = Root**（所以不需要一个 'home' 节点来表示首页） */
  stacks = $state<Record<Tab, Node[]>>({ atlas: [], lookup: [], vault: [], settings: [] })

  /** 当前 Tab 的栈顶；null = 正在 Root */
  get top(): Node | null {
    return this.stacks[this.tab].at(-1) ?? null
  }

  /** 当前 Tab 的深度（0 = Root） */
  get depth(): number {
    return this.stacks[this.tab].length
  }

  /**
   * ★★ 横轴：点底部 Tab。**含当前 Tab** —— 点自己也要清栈回 Root。
   * 这一条就是使用者要的「无论在哪个深层页面，点当前 Tab 都回首页」。
   */
  goTab(t: Tab): void {
    this.stacks = { ...this.stacks, [t]: [] }
    this.tab = t
  }

  /** 往当前 Tab 的栈里推一层 */
  push(n: Node): void {
    this.stacks = { ...this.stacks, [this.tab]: [...this.stacks[this.tab], n] }
  }

  /** ★ 纵轴：退一层。返回 true = 真的退了一层（被 backstack 当作「消费了」） */
  pop(): boolean {
    const s = this.stacks[this.tab]
    if (s.length === 0) return false
    this.stacks = { ...this.stacks, [this.tab]: s.slice(0, -1) }
    return true
  }

  /** 回到当前 Tab 的 Root（不换 Tab） */
  toRoot(): void {
    if (this.depth > 0) this.stacks = { ...this.stacks, [this.tab]: [] }
  }

  /**
   * ★ 跨 Tab 直达 —— D-411 要的那个 `goto`。
   * 例：`route.goto('vault', { k: 'items' }, { k: 'item', id })`
   * 把目标 Tab 的栈**整条换掉**再切过去，于是返回链是干净的。
   */
  goto(t: Tab, ...nodes: Node[]): void {
    this.stacks = { ...this.stacks, [t]: nodes }
    this.tab = t
  }
}

export const route = new Route()
