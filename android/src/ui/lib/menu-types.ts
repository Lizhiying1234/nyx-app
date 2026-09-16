/**
 * ⋮ 菜单的类型 —— 单独放一个 `.ts`，不从 `.svelte` 里 `export type`。
 *
 * ★ 理由：Svelte 组件文件导出类型要靠 `<script module>`，
 *   而那一层的语义（模块级、只跑一次）和这里想表达的「一个纯类型」无关。
 *   放进普通模块，import 的人不用关心它来自组件还是别处。
 */
export type NodeKind = 'project' | 'unit' | 'lecture'

export interface MenuTarget {
  kind: NodeKind
  id: number
  name: string
  /** 只有项目有 */
  pinned?: boolean
  /** 界面上叫「归档」—— Windows 那边就是这么写的，别自作主张换成「静默」 */
  archived?: boolean
}

/** ⋮ 菜单能发出的动作。★ 改层级不在里面 —— 层级属既有知识内容，只读（D-302） */
export type MenuAction =
  | 'rename'
  | 'move'
  | 'pin'
  | 'archive'
  | 'unread'
  | 'read'
  | 'produce'
  /** 讲次批量分析（T-5.13 · D-R22）—— 只有讲次有 */
  | 'analyse'
  /** Lecture 内查重（T-9.13 · D-478②）—— 只有讲次有；点开先扫描，不改任何东西 */
  | 'dedup'
  | 'newChild'
  | 'delete'
