/**
 * 领域规则在查询层的**翻译** · V-3 / R-2（2026-08-16）
 *
 * ── 这个文件不拥有任何业务语义 ────────────────────────────
 *
 * 「什么叫产出适用」「什么叫静默」的定义在 `core/silence.ts`。
 * 这里只把那两句话翻译成 SQL，让查询层不必自己再判一遍。
 *
 * ```
 * Domain（core/silence.ts）      productionApplies() · isItemSilent()
 *         ↓ 翻译
 * SQL（本文件）                  PRODUCTION_APPLIES · IS_SILENT
 *         ↓ 引用
 * Windows: study.ts / browse.ts / report.ts / audit.ts
 * Android: practice.ts / today.ts（经 core-link）
 * ```
 *
 * ── 为什么必须只有这一份 ──────────────────────────────────
 *
 * 修这一轮之前，「静默」在 SQL 里是 `production_state='silent' or card_silent=1`
 * ——**任一线静默即视为静默**，而领域判据说的是「B 层只看产出线」。
 * 同一条知识点，在「静默知识库」里算静默、在业务判据里不算，
 * 而两边代码各自都说得通。四处 SQL 各写一遍，改一处永远改不干净。
 *
 * ★ `tests/db-safety.ts` 有一条**对拍**用例：把各种形状的条目塞进真库，
 *   让 TS 判据和这里的 SQL 逐格比对。翻译漂了当场红 ——
 *   否则这一层就会变成第二套业务规则，而且是没人看得见的那种。
 *
 * ── 2026-09-01 · 从 `main/db/silence-sql.ts` 上提到 core（F-017）─────
 *
 * 上提的理由和上面那段是**同一条**，只是尺度从「一个仓库里四处」
 * 变成了「两个仓库各一份」：Android 的 `practice.ts` 与 `today.ts` 曾各自
 * 抄了一份 `PRODUCTION_APPLIES`。把 `layer='B'` 改成别的，Windows 的
 * 「今日 39 条」和手机的「今日 39 条」就开始不一样，而**两端都不报错**。
 * `main/db/silence-sql.ts` 现在只是这一份的 re-export 壳。
 */

/**
 * 「这一条跑不跑产出线」的 SQL 形态。
 * 与 `core/silence.ts::productionApplies` 一一对应。
 *
 * @param t 表别名（`items` 那张表）
 */
export const PRODUCTION_APPLIES = (t = 'i'): string =>
  `(${t}.layer = 'B' and ${t}.kind <> 'sentence')`

/**
 * 「这一条整体算不算静默」的 SQL 形态。
 * 与 `core/silence.ts::isItemSilent` 一一对应：
 * 跑产出线的只看产出线，不跑的只看认读线。
 *
 * ★ D-296（V34）· 认读线那一半搬去了 `reading_cards`，所以要两个别名：
 *   `t` 是 `items`，`c` 是接上来的 `reading_cards`（见 `sql/reading-card.ts`）。
 *   用它的查询必须先 `JOIN_CARD`。
 */
export const IS_SILENT = (t = 'i', c = 'rc'): string =>
  `(case when ${PRODUCTION_APPLIES(t)} then ${t}.production_state = 'silent' else ${c}.silent = 1 end)`
