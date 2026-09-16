/**
 * 项目栏三层树的取数 SQL · 两端共用（F-017 · 2026-09-01）
 *
 * ── 为什么这是业务规则而不是显示细节 ──────────────────────
 *
 * 「哪些看得见、按什么排」决定了使用者在两台机器上**看到的不是同一棵树**。
 * 手机上少一句 `silent = 0`，那台机器就会把已静默的项目当正常项目显示，
 * 而两端都不会报错 —— D-238：Android 是 Nyx 的第二个端，不是另一个产品。
 *
 * 上提之前这份 SQL 是两份（`main/db/repo.ts::tree()` 一份、
 * Android `src/db/tree.ts` 一份，逐字抄的）。
 *
 * ── 一条最容易搞错的规则 ★★ ───────────────────────────────
 *
 * **静默的三级不出现在这棵树里。**「整个项目从正常视图消失，
 * 只出现在静默知识库」。所以三层的 where 都带 `silent = 0`。
 * 但**藏起来必须有出口** —— 静默知识库是那个出口。只藏不放是陷阱，
 * 他会以为项目被删了。
 */

/**
 * ★ 排序也是业务规则，不是显示细节。
 *   置顶的在前，然后按 sort，最后按创建时间倒序。
 */
export const TREE_PROJECTS = `select id, name, color, pinned from projects
  where deleted_at is null and silent = 0
  order by pinned desc, sort, created_at desc`

/** 一个项目底下的单元 —— 参数：project_id */
export const TREE_UNITS = `select id, name from units
  where project_id = ? and deleted_at is null and silent = 0
  order by sort, id`

/**
 * 一个单元底下的讲次 —— 参数：unit_id
 *
 * ★★ `case when silent = 1 then 'silent' else status end`
 *
 * 静默存在 `silent` 列上，但界面看的是 `status`。这里合成，
 * 否则「已经静默了没有」在界面上**根本读不出来**（D-185：一份数据，处处一致）。
 *
 * 注意 where 里已经排掉了 silent=1 的讲次，所以这个 case 在树上永远走 else。
 * 照搬是有意的 —— 同一句 SQL 在静默知识库那边要用到，两处不该长得不一样。
 */
export const TREE_LECTURES = `select id, name,
    case when silent = 1 then 'silent' else status end as status,
    due_at as dueAt,
    (select count(*) from item_lectures il
       join items i on i.id = il.item_id and il.deleted_at is null
      where il.lecture_id = lectures.id and il.deleted_at is null and i.deleted_at is null) as itemCount
  from lectures where unit_id = ? and deleted_at is null and silent = 0
  order by sort, id`
