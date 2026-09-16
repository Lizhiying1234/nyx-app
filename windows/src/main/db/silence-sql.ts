/**
 * 领域规则在查询层的翻译 —— **判据已上提 `core/sql/silence.ts`**（F-017 · 2026-09-01）
 *
 * 这里只剩一层 re-export 壳，理由和 core 那份文件头写的是同一条：
 * Android 的 `practice.ts` / `today.ts` 曾各抄一份 `PRODUCTION_APPLIES`，
 * 改一处两台机器就开始算出不同的「今日多少条」，而两端都不报错。
 *
 * ★ 壳留着不是为了兼容 —— `main/` 这一侧的十几个引用点写的是
 *   「查询层的翻译在 db/ 目录里」，那个位置本身是对的（`identity.ts`
 *   与 `reading-card-sql.ts` 是同一个形状）。真相在 core，位置在这里。
 */
export { IS_SILENT, PRODUCTION_APPLIES } from '@core/sql/silence.ts'
