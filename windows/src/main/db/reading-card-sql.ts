/**
 * 认读卡在查询层的统一入口 —— **判据已上提 `core/sql/reading-card.ts`**
 * （F-017 · 2026-09-01）
 *
 * 这里只剩一层 re-export 壳。Android 的 `src/db/reading.ts` 曾在文件头
 * 逐字复制这五个宏；「26 个读取点各写各的，早晚有一处会漏」在两个端上
 * 就是「两份宏，早晚有一份漏」，而漏掉 join 那半句的后果是
 * **软删掉的知识点重新进认读队列**，且不报错。
 *
 * ★ 位置留在 `db/` 是有意的（见 `silence-sql.ts` 同款说明）。
 */
export { ALIVE, CARD_ACTIVE, CARD_DUE, CARD_FIELDS, JOIN_CARD, RC } from '@core/sql/reading-card.ts'
