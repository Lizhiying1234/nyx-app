import type { Database } from 'better-sqlite3'

/**
 * 「空」这个状态只在没有内容时成立 · N-1
 *
 * ── 这条判据本来就存在，只是只在启动时跑 ──────────────────────
 *
 * `empty` 的语义在代码里是硬的：`analyze.ts / settleStatus` 里那句
 * `return items > 0 ? 'review' : 'empty'` —— **有效知识点数为 0，才叫空**。
 * 而 `recover.ts` 的启动自愈修的正是它的反面（`empty` 却有内容 → `review`）。
 *
 * 问题是：**产生知识点的路有四条，只有 AI 分析那一条会去结算状态。**
 *
 * | 产生知识点 | 结算状态 |
 * |---|---|
 * | `analyze.ts`（提取 + 析出） | ✅ `settleStatus` |
 * | `repo.addChunks`（我的收集） | ❌ |
 * | `repo.addItem`（工作台「＋」· 右键收进 · 词条详情新增） | ❌ |
 * | `sync.writeRows`（同步导入） | ❌（带的是对面那台机器的值） |
 *
 * 后果不只是「状态和事实对不上」。工作台上「这批我看过了 · 开始学」那颗按钮
 * **只在 `review` 时渲染**，而它是全项目唯一进入 `startLearning` 的路径 ——
 * 于是贴完「我的收集」，那一讲就是个**死胡同**：有内容、有列表、
 * 没有任何按钮能让它进轮转。重启一次，启动自愈把状态改对，按钮才出现。
 * （`review` 状态下条目行才有删除 ✕，所以卡住的时候连删都删不掉。）
 *
 * ── 为什么单独一个函数，而且**不带任何模式参数** ────────────
 *
 * 不复用 `settleAfterAnalyze`：它的第一条是 `if (anySuccess) → 'review'`，
 * 回答的是「**一次分析结束后**该收到哪」——用在写入路径上会把一条
 * 正在轮转的讲打回 `review`，而那会让下一次「开始学」把 `interval_days`
 * 重设成 1，**进度清零**。两者是不同的问题，硬合并会做成
 * 「一个函数三种模式」，下一次改动传错一个参数就是静默的数据事故。
 *
 * 这个函数只表达一条事实，所以它不需要知道调用者是谁、发生了什么：
 * **只有 `empty` 会被动，其它状态由构造保证一个字不改。**
 * `review` / `training` 都不满足 `status = 'empty'`，
 * 连分支都不用写 —— 这比「记得给每种状态写对分支」可靠。
 *
 * ★★ F-2-① · 以前这里有一整段讲「分析窗口内写 status 会被静默覆盖」——
 * 因为那时 `analyze` 把旧状态读进内存变量、结束时按它写回去。
 * 现在 `analyze` 全程不动 status，那个窗口不存在了：
 * **分析进行中调这个函数是安全的，写进去就算数。**
 */

export interface PromoteResult {
  /** 状态是不是真的被改了 */
  changed: boolean
  /** 这一讲当前的有效知识点数（软删的不算）—— 调用方要拿它写留痕 */
  items: number
}

/**
 * 有内容了就不该再叫「空」。
 *
 * **只写 `status` 和 `updated_at`。**
 * `due_at` / `interval_days` / `silent` / 学习记录 / 条目进度一律不碰 ——
 * 这条修复的全部内容就是「把状态改成与事实相符」。
 * 尤其不能走 `markUnread()`：那是业务操作，会清掉排期、把间隔归零。
 *
 * 调用方负责事务与留痕：
 *   · 写入路径（`addChunks` / `addItem`）在各自**已有的事务内**调用，
 *     所以「产生内容」和「状态变更」要么一起成功、要么一起回滚
 *   · 启动自愈（`recover.ts`）在它的事务里调用，并额外记一条 `recovered` 日志
 */
export function promoteOutOfEmpty(db: Database, lectureId: number): PromoteResult {
  const row = db
    .prepare(
      `select (select count(*) from item_lectures il join items i on i.id = il.item_id
                where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null) as items
         from lectures l
        where l.id = ? and l.status = 'empty' and l.deleted_at is null`
    )
    .get(lectureId) as { items: number } | undefined

  // 不是 empty（或者这一讲已经删了）→ 一个字都不动，连查都不用往下走
  if (!row) return { changed: false, items: 0 }
  if (row.items === 0) return { changed: false, items: 0 }

  db.prepare(`update lectures set status = 'review', updated_at = ? where id = ?`).run(
    Date.now(),
    lectureId
  )
  return { changed: true, items: row.items }
}
