/**
 * 项目栏的三层树 —— **判据只有一份**。
 *
 * ══ 唯一真相：`core/sql/tree.ts` ★★★ ═══════════════════════
 *
 * 三句 SQL 是 direct import，不是抄的（F-017 · 2026-09-01 上提；
 * 此前 Windows `main/db/repo.ts::tree()` 一份、这里一份，逐字重复）。
 * 手机上要显示同一棵树，「哪些看得见、按什么排」就必须是同一套规则 ——
 * 这不是平台差异，是**业务规则**（D-238：Android 是 Nyx 的第二个端，
 * 不是另一个产品）。
 *
 * ★ 这个文件现在只剩**装配**：把 core 的 SQL 喂给 Android 的异步 `Db`，
 *   再把行拼成三层结构。一句判据都没有。
 *
 * ══ 一条最容易搞错的规则 ★★ ═══════════════════════════════
 *
 * **静默的三级不出现在这棵树里。**「整个项目从正常视图消失，
 * 只出现在静默知识库」。所以三层的 where 都带 `silent = 0`（在 core 那份里）。
 *
 * 但**藏起来必须有出口** —— 静默知识库是那个出口。只藏不放是陷阱，
 * 他会以为项目被删了。（Vault 的「静默」库就是那个出口。）
 */
import { TREE_LECTURES, TREE_PROJECTS, TREE_UNITS } from '../core-link.ts'
import type { Db } from './types.ts'

/** 讲次在树上显示的那几样 —— 与 Windows 的 `LectureBrief` 同形 */
export interface LectureBrief {
  id: number
  name: string
  /**
   * ★ 界面看的是 status，而静默存在 silent 列上 —— SQL 里用
   * `case when silent = 1 then 'silent' else status end` 合成，
   * 否则「已经静默了没有」在界面上根本读不出来（D-185）。判据见 core/sql/tree.ts。
   */
  status: string
  dueAt: number | null
  itemCount: number
}

export interface TreeUnit {
  id: number
  name: string
  /** ★ 这个单元底下有多少条**不重复**的知识点 —— 由 SQL 去重算出来，不是加出来的 */
  itemCount: number
  lectures: LectureBrief[]
}

export interface TreeProject {
  id: number
  name: string
  color: string
  pinned: boolean
  /** ★ 同上：**去重**之后的条数 */
  itemCount: number
  units: TreeUnit[]
}

/**
 * ★★ 计数为什么必须走 SQL 去重，而不是把下一层加起来（2026-09-03）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * 老写法是 `p.units.reduce(… + l.itemCount)` —— 把每一讲的条数**加总**。
 * 但 `item_lectures` 是**多对多**：同一条知识点可以同时挂在好几讲底下
 * （`ai/analyze.ts` 按 term 全局查 `prior`，同一个表达在第二讲再次出现时
 *   **复用同一行 item**，只多一条收录关系）。
 *
 * 于是「跨讲共享的那些条目，在项目 / 单元这一层被数了好几遍」：
 * 两讲各 2 条、其中 1 条是同一条 → 项目上显示 4，真值是 3。
 * 没有任何报错，数字看着也很合理 —— 正是这个项目最怕的那种失败。
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * 项目 / 单元的条数由 `count(distinct il.item_id)` 直接算。
 * 讲次那一层不需要去重（`item_lectures` 的主键就是 `(item_id, lecture_id)`，
 * 一条知识点在同一讲里只可能有一行）。
 *
 * ── 口径：数的是「这棵树上看得见的」★ ──────────────────────
 *
 * 三层的 where 都带 `silent = 0`（`core/sql/tree.ts` 的规则）——
 * 已静默的讲次根本不在树上。所以父级计数也**不能**把它们算进去，
 * 否则那个数在树上永远对不出来：展开到底也找不到那几条。
 * 已静默的条目本身照常计入（它还挂在那一讲下面，看得见）。
 *
 * ★ 结果是「项目数 ≤ 各讲之和」。这不是 bug，是多对多的事实：
 *   一条挂两讲的知识点，仍然只是**一条**知识点。
 */

/** 一讲有多少条 —— 主键 `(item_id, lecture_id)` 保证一讲之内不会重 */
const LECTURE_COUNTS = `select il.lecture_id as id, count(*) as n
    from item_lectures il join items i on i.id = il.item_id
   where il.deleted_at is null and i.deleted_at is null
   group by il.lecture_id`

/** 一个单元有多少条**不重复**的 —— 只算树上看得见的那些讲 */
const UNIT_COUNTS = `select l.unit_id as id, count(distinct il.item_id) as n
    from item_lectures il
    join items i on i.id = il.item_id
    join lectures l on l.id = il.lecture_id
   where il.deleted_at is null and i.deleted_at is null
     and l.deleted_at is null and l.silent = 0
   group by l.unit_id`

/** 一个项目有多少条**不重复**的 —— 只算树上看得见的那些单元与讲 */
const PROJECT_COUNTS = `select u.project_id as id, count(distinct il.item_id) as n
    from item_lectures il
    join items i on i.id = il.item_id
    join lectures l on l.id = il.lecture_id
    join units u on u.id = l.unit_id
   where il.deleted_at is null and i.deleted_at is null
     and l.deleted_at is null and l.silent = 0
     and u.deleted_at is null and u.silent = 0
   group by u.project_id`

/** 三层的条数，一次查出来 */
export interface TreeCounts {
  projects: Map<number, number>
  units: Map<number, number>
  lectures: Map<number, number>
}

const toMap = (rows: { [k: string]: unknown }[]): Map<number, number> => {
  const m = new Map<number, number>()
  for (const r of rows) m.set(Number(r['id']), Number(r['n']))
  return m
}

export async function loadTreeCounts(db: Db): Promise<TreeCounts> {
  return {
    projects: toMap(await db.all(PROJECT_COUNTS)),
    units: toMap(await db.all(UNIT_COUNTS)),
    lectures: toMap(await db.all(LECTURE_COUNTS))
  }
}

/**
 * ★★ 把最新的条数**盖回一棵已经在屏幕上的树**（2026-09-03）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * 树是 `store.reload()` 装的，而删词条 / 加词条走的绝大多数路径只调
 * `store.reloadCounts()`（它刷的是 Vault 计数和今日排期，**不碰树**）——
 * `ItemMenu` 的删除、Vault 的批量删、讲次页的「加一个表达」都是这样。
 * 于是 Atlas 上那个数停在上一次装树的时刻，「有时候对不上」就是这么来的：
 * 对不对，取决于这中间有没有碰巧发生过一次整树重装。
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * 条数是**派生显示**（D-185：库是唯一真相，派生显示自动同步）。
 * 所以不去每个调用点补一句 `reload()` —— 那种「记得加」的做法这个项目
 * 已经翻过好几次车。改成：`reloadCounts()` 顺手把条数盖一遍，
 * 结构不动、不闪、三条 group by 而已，**以后新长出来的调用点自动是对的**。
 */
export function applyCounts(tree: TreeProject[], c: TreeCounts): void {
  for (const p of tree) {
    p.itemCount = c.projects.get(p.id) ?? 0
    for (const u of p.units) {
      u.itemCount = c.units.get(u.id) ?? 0
      for (const l of u.lectures) l.itemCount = c.lectures.get(l.id) ?? 0
    }
  }
}

const num = (v: unknown): number => Number(v)
const str = (v: unknown): string => String(v)

export async function loadTree(db: Db): Promise<TreeProject[]> {
  const projects = await db.all(TREE_PROJECTS)
  const counts = await loadTreeCounts(db)
  const out: TreeProject[] = []

  for (const p of projects) {
    const pid = num(p['id'])
    const units: TreeUnit[] = []

    for (const u of await db.all(TREE_UNITS, [pid])) {
      const uid = num(u['id'])
      const lectures = (await db.all(TREE_LECTURES, [uid])).map((l) => ({
        id: num(l['id']),
        name: str(l['name']),
        status: str(l['status']),
        dueAt: l['dueAt'] === null || l['dueAt'] === undefined ? null : num(l['dueAt']),
        itemCount: num(l['itemCount'])
      }))
      units.push({ id: uid, name: str(u['name']), itemCount: counts.units.get(uid) ?? 0, lectures })
    }

    out.push({
      id: pid,
      name: str(p['name']),
      color: str(p['color']),
      pinned: num(p['pinned']) === 1,
      itemCount: counts.projects.get(pid) ?? 0,
      units
    })
  }

  return out
}

/**
 * ★ `projectItemCount` / `unitItemCount` 这两个「把下一层加起来」的函数已经删掉
 *   （2026-09-03）。它们正是重复计数的来源，留着就会有人再用一次。
 *   现在条数是节点自己的字段（`p.itemCount` / `u.itemCount`），由上面的 SQL 算。
 */
