/**
 * 收录关系（`item_lectures`）在查询层的判据 —— **只有一份**（D-436③ / V36）。
 *
 * V36 给这张表加了 `deleted_at`：「把一条知识点从这一讲移出去」从此是**软删**，
 * 不是删行。理由见 V36 迁移的注释（一句话：删行不立墓碑，删除传不到另一台）。
 *
 * 于是**凡是问「这一讲里有哪些知识点」「这一条挂在哪几讲」的地方，
 * 都要把软删的那些排掉**。写在这里而不是各写各的，理由和 `silence.ts`
 * `reading-card.ts` 一样：两端各写一份，改一边不报错，只会让两台算出不同的数。
 *
 * ★★ **有三类地方绝对不许加这个过滤**，加了就是 bug：
 *   ① **级联与彻底删除**（`cascade.ts` / `purge.ts` 的删除本身）——
 *      它要删的是**所有**行，包括已经软删的，否则会留下垃圾。
 *   ② **同步层**（`collectSince` / `toSync`）—— 软删行**本来就要推给另一台**，
 *      那正是这次改动的全部目的。
 *   ③ **身份推导**（`identity.ts`）—— uid 和这一行活没活着无关。
 */

/** 活着的收录关系。`a` 是这条 SQL 里给 `item_lectures` 起的别名 */
export const ilAlive = (a = 'il'): string => `${a}.deleted_at is null`

/** 不带别名的版本 —— 给 `select … from item_lectures where …` 这种直接查 */
export const IL_ALIVE = 'deleted_at is null'

/**
 * 「这个项目 / 这个单元里有哪些知识点」—— 判据只有一份（2026-09-03）
 *
 * ★★ 立这两条是因为核出一个真 bug：`browse.ts` 的项目级 / 单元级 4×4 矩阵
 * （D-169）用的子查询是
 *
 *     select il.item_id from item_lectures il
 *       join lectures l on l.id = il.lecture_id
 *      where l.unit_id = ?
 *
 * —— **没有 `il.deleted_at is null`**。而 V36 之后「把一条知识点从这一讲移出去」
 * 是软删，行还在。于是**移出去的条目照样被算进矩阵**。
 *
 * ★ 更难查的是：**同一页上面那份讲次列表是排掉了的**（`browse.ts` 602 / 652 行
 * 都写着 `and il.deleted_at is null`）。同一屏两个数，两把尺子 ——
 * 数对不上的时候没人会想到是「其中一处漏了半句 where」。
 *
 * 全仓 33 处 `item_lectures il` 有 28 处排了软删，漏的正是这两处。
 * 现在收成一份，谁再要「按项目/单元筛条目」都用它。
 */
export const IN_UNIT = (i = 'i'): string =>
  `${i}.id in (select il.item_id from item_lectures il
     join lectures l on l.id = il.lecture_id and l.deleted_at is null
    where ${ilAlive()} and l.unit_id = ?)`

export const IN_PROJECT = (i = 'i'): string =>
  `${i}.id in (select il.item_id from item_lectures il
     join lectures l on l.id = il.lecture_id and l.deleted_at is null
     join units u on u.id = l.unit_id and u.deleted_at is null
    where ${ilAlive()} and u.project_id = ?)`
