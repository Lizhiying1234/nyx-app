/**
 * 回收站要扫的那几张表 · 两端共用（F-017 · 2026-09-01）
 *
 * ── 为什么这个清单必须只有一份 ────────────────────────────
 *
 * 30 天到期清除会**写墓碑**，而墓碑一旦随同步推出去就不可撤销
 * （D-087 ·「打开即清」是契约行为）。
 *
 * 清单在两端各有一份的后果不是「少清一张表」这么轻 ——
 * 是**两台机器对「什么该被彻底删掉」的理解不同**：
 * 一端清了并推出墓碑，另一端根本不认为那张表归回收站管，
 * 于是它照单执行了一个自己永远不会主动发起的删除。
 *
 * 上提之前：Windows `main/browse.ts::purgeExpired` 一份、
 * Android `src/db/purge.ts` 一份（逐字抄的）。
 *
 * ★ 顺序有意义：先 `items` 后 `projects` —— 级联删除
 *   （`core/cascade.ts::hardDelete`）从叶子往根走，
 *   反过来会让上级先消失、下级变孤儿再被扫一遍。
 * ★ 表里没有 `deleted_at` 列的要跳过（老库升级中途可能缺列），
 *   调用方用 `pragma table_info` 自检 —— 这份清单只说「扫哪些」。
 */

/** 回收站扫描顺序：叶子 → 根 */
export const PURGE_TABLES = ['items', 'materials', 'lectures', 'units', 'projects', 'files'] as const

export type PurgeTable = (typeof PURGE_TABLES)[number]

/** 回收站保留天数 · D-087 */
export const TRASH_DAYS = 10

/**
 * 屏上那句「N 天内可以恢复」—— **只有这一个出处**。
 *
 * ★ 为什么把话也放进 core：2026-09-09 把保留期从 30 改成 10 的时候，
 *   全仓有 **20 处**界面文案把「30 天」写死在句子里。只改常量的话，
 *   常量说 10、屏上说 30 —— **同一件事两份判据**，而且错的那一份正对着他的眼睛。
 *   D-412 要的是「文案说真话」，让话从数推导出来才是真的守得住。
 * ★ 两端共用：Android 那边也从这里取（它提 `nyx-core` 指针就跟着变）。
 */
export const TRASH_KEEP_TEXT = `${TRASH_DAYS} 天内可以恢复`
/** 「N 天后彻底清除」—— 回收站页与列表行上的说法 */
export const TRASH_PURGE_TEXT = `${TRASH_DAYS} 天后彻底清除`
