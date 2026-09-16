/**
 * 认读卡在查询层的**统一入口** · D-296（V34）
 *
 * ── 为什么要有这一份 ──────────────────────────────────────
 *
 * V34 之前，认读卡是 `items` 上的 6 个 `card_*` 列，「这张卡能不能练」
 * 只要一句单表条件就写完了：
 *
 *   where deleted_at is null and card_silent = 0 and card_due_at <= ?
 *
 * 拆表之后 `deleted_at` 在 `items`、`silent` / `due_at` 在 `reading_cards`，
 * 同一句话变成「join + 两张表各出一半条件」。
 *
 * **漏掉 join 里那半句的后果是：软删掉的知识点重新进认读队列。**
 * 而且不报错 —— `check:sql` 只验列名存不存在，验不出少了一个条件。
 * 26 个读取点各写各的，早晚有一处会漏。
 *
 * 所以这里是唯一入口：谁要读认读卡，就用下面这几个片段拼，
 * 不自己写 `join reading_cards`。
 *
 * ── 它不拥有任何业务语义 ──────────────────────────────────
 *
 * 和 `sql/silence.ts` 一样，这是**翻译层**。
 * 「什么叫静默」在 `core/silence.ts`，「间隔怎么走」在 `core/sm2-item.ts`。
 *
 * ── 2026-09-01 · 从 `main/db/reading-card-sql.ts` 上提到 core（F-017）──
 *
 * 「26 个读取点各写各的，早晚有一处会漏」这句话，在两个端上就是
 * 「两份宏，早晚有一份漏」。Android 的 `reading.ts` 曾在文件头
 * **逐字复制**了下面五个函数。`main/db/reading-card-sql.ts` 现在只是
 * 这一份的 re-export 壳。
 */

/** 约定的认读卡表别名 —— 各处保持一致，读起来不用回头找 */
export const RC = 'rc'

/**
 * 把认读卡接到 `items` 的某个别名上。
 *
 * ★ 用 `join` 不用 `left join`：V34 之后**每条知识点必有一张卡**
 * （迁移全量搬运 + `trg_items_reading_card` 管住所有插入路径）。
 * 写成 `left join` 会把「卡不见了」这种真故障变成「那一行静悄悄没了」，
 * 而这正是本项目最贵的失败形态。真缺了就该少一行、被用例抓到。
 */
export const JOIN_CARD = (i = 'i', c: string = RC): string =>
  `join reading_cards ${c} on ${c}.item_id = ${i}.id`

/**
 * 「这条知识点还在」—— 软删过滤。
 *
 * 单独列出来是因为它住在 `items` 那一侧，而人很容易在写完
 * `rc.silent = 0` 之后就以为条件齐了。
 */
export const ALIVE = (i = 'i'): string => `${i}.deleted_at is null`

/**
 * 「这张卡还在轮转」= 知识点没删 ∧ 卡没静默。
 * **认读队列的准入条件只有这一句，不要再各写一遍。**
 */
export const CARD_ACTIVE = (i = 'i', c: string = RC): string => `${ALIVE(i)} and ${c}.silent = 0`

/**
 * 「这张卡到期了」—— 配合 `CARD_ACTIVE` 用。
 * `due_at is null` 表示还没拿到首次认读资格，不算到期。
 */
export const CARD_DUE = (c: string = RC, param = '?'): string =>
  `${c}.due_at is not null and ${c}.due_at <= ${param}`

/**
 * SM-2 要的那一组字段，按 `core/sm2-item.ts` 的入参命名取别名。
 * 各处 select 同一份，省得每处自己拼、拼歪了还不报错。
 */
export const CARD_FIELDS = (c: string = RC): string =>
  `${c}.ease as ease, ${c}.interval_days as interval, ${c}.reps as reps, ` +
  `${c}.lapses as lapses, ${c}.silent as silent`
