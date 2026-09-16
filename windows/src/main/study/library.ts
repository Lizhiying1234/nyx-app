/**
 * Study · 知识库视图与批量操作：矩阵 · 列表 · 批量删除 / 改层 / 静默 · 条目详情 —— T-4.6 拆分（2026-09-06）
 *
 * 方法体从 `src/main/study.ts` 原样搬来：`this.<状态>` → `c.<状态>`，
 * `this.<公共方法>` → `c.self.<方法>`，私有方法整个搬进本文件、调用点也在本文件里。
 * ★ 模板字符串里的行一个空格都没动 —— 那里面是 SQL，缩进属于字符串内容。
 * ★ 判断规则一条都不在这里，全在 core/（D-238）：这一层只做
 *   「从库里取状态 → 交给 core 算 → 把结果写回去」。
 */

import { ITEM_NOT_FOUND } from '@shared/api.ts'
import { SILENCE_ACTIONS } from '@core/silence.ts'
import { IS_SILENT } from '../db/silence-sql.ts'
import type { ItemDetail, LibraryFilter, LibraryItem, MatrixData } from '@shared/api.ts'
import { ALIVE, JOIN_CARD } from '../db/reading-card-sql.ts'
import { IN_PROJECT, IN_UNIT } from '@core/sql/item-lectures.ts'
import { libraryState } from '@core/library-state.ts'
import type { StudyCtx } from './ctx.ts'
import { now } from './util.ts'

/**
 * ★★ N-2 · 删知识点的**唯一入口**。工作台那个 ✕ 和勾选后的批量删除，
 * 走的是同一个函数、同一个事务、同一套语义。
 *
 * ── 以前是两套 ────────────────────────────────────────────
 *
 * `deleteItem` 只有一句 `update items set deleted_at`；
 * `bulkDelete` 还会往 `term_ledger` 记一笔 `deleted`。
 * 而账本正是「以后 AI 别再收它」这条长期意图的载体（4.1）——
 * 于是同一个动作产生了两种长期结果：
 *
 *   逐条 ✕ 删掉的 → 重新分析同一份材料，**全部回来**
 *   勾选批量删的 → 不回来
 *
 * 更糟的是那个 ✕ **只在 `status='review'` 时渲染** —— 也就是他正在
 * 审阅一批刚分析出来的结果、逐条剔掉不想要的。那正是最需要「拒绝」
 * 的场景，偏偏走的是不记账的那一条。
 *
 * ── 这个入口负责什么、不负责什么 ──────────────────────────
 *
 * 负责：`items.deleted_at` + `term_ledger` 的 `deleted` + `ops_log`，**一个事务**。
 * 不负责：删容器（`browse.deleteLecture` / `repo.softDelete`）——
 *   那是「这一讲我不要了」，不是「这个说法我不要了」，两种意图不同，
 *   不许为了「统一」让它们也写拒绝账（会把整讲的表达全部拉黑，
 *   而他完全看不出为什么 —— I-119 就是这个形状的事故）。
 */
export function deleteItems(c: StudyCtx, ids: number[]): number {
  if (ids.length === 0) return 0
  const t = now()
  const stmt = c.db.prepare(`update items set deleted_at = ?, updated_at = ? where id = ?`)
  c.db.transaction(() => {
    // 先取字面 —— 软删之后再取也取得到（软删不动 term），但顺序写清楚更不容易被将来改坏
    const terms = c.self.termsOf(ids).map((x) => x.term)
    for (const id of ids) stmt.run(t, t, id)
    /**
     * 4.1 · 删掉的表达进账本。
     * 他删掉一个说法，通常是「这个我不需要」——
     * 那么下次分析同一篇文章、或者别的文章里再出现，也不该再收进来。
     * 账记在**字面**上而不是 item 上：item 过了保留期会被彻底清掉，
     * 判断跟着没了，那条表达就又回来了。
     */
    c.ledger.noteMany(terms, 'deleted', { note: '在知识点列表里删除' })
    c.ledger.op('delete', 'item', null, terms.slice(0, 3).join('、'), { n: ids.length })
  })()
  return ids.length
}

/** 单条删除 —— 和批量删除是同一个业务动作，只是量不同 */
export function deleteItem(c: StudyCtx, itemId: number): void {
  c.self.deleteItems([itemId])
}

export function setLayer(c: StudyCtx, itemId: number, layer: 'A' | 'B'): void {
  const t = now()
  c.db.prepare(`update items set layer = ?, updated_at = ? where id = ?`).run(layer, t, itemId)
}

/**
 * 4×4 状态矩阵 · D-158
 *
 * 纵轴产出线 `静默 / 攻坚 / 训练中 / 未开始`，横轴认读线 `新卡 / 学习中 / 成熟 / 静默`
 * —— 与总原型的 RL / CL 一字不差。
 *
 * 「为什么不用散点图：两条线**本身就是离散四档**，散点的连续坐标是人为折算的。
 *  矩阵无重叠、给精确条数、数据量越大越准，**而且空格子本身有意义**
 *  （「认读新卡 × 产出静默」永远是 0，说明机制自洽）。」
 *
 * 橙框那片（认读成熟 × 产出还没毕业）就是这套方法论瞄准的**全部对象**。
 */
export function matrix(c: StudyCtx): MatrixData {
  const rows = c.db
    .prepare(
      `select i.production_state as ps, i.layer, rc.reps as reps,
                rc.interval_days as ivl, rc.silent as cs
           from items i ${JOIN_CARD('i')} where ${ALIVE('i')}`
    )
    .all() as { ps: string; layer: string; reps: number; ivl: number; cs: number }[]

  const cells: number[][] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]
  const R = { silent: 0, hard: 1, training: 2, new: 3 } as Record<string, number>

  for (const r of rows) {
    const row = R[r.ps] ?? 3
    const col = r.cs !== 0 ? 3 : r.reps === 0 ? 0 : r.ivl >= 21 ? 2 : 1
    cells[row]![col]! += 1
  }

  // 橙框：认读成熟（col 2）× 产出还没毕业（row 1–3）
  let zone = 0
  for (const row of [1, 2, 3]) zone += cells[row]![2]!
  const total = rows.length
  const max = Math.max(1, ...cells.flat())

  return { cells, zone, total, max }
}

/**
 * 库列表 · D-159 / D-160 / D-162 / D-019
 *
 * 「列表怎么排，测试就怎么出题」（D-162）—— 所以排序不是装饰，它决定出题顺序。
 * 静默条目**图里显示、列表里不显示**（D-158），除非明确要看静默库。
 */
/**
 * ★★ 2026-09-06 · T-4.10 在这里修了一个存在已久的 bug，值得单独说清楚。
 *
 * 下面这条查询的收尾一直写着 `hasSuspect: x.hasSuspect !== 0`，
 * 而 **SELECT 里从来没有 `hasSuspect` 这一列** —— 于是 `x.hasSuspect` 是 `undefined`，
 * 而 `undefined !== 0` **恒为 true**：综合知识库**每一行**都在画那个
 * 「这条可能打错或听岔了」的修正记号。
 *
 * 使用者 2026-09-06 报的「综合知识库几乎每个知识点旁边都有一个标记」，
 * 208 / 208 对得上的就是它（释义位那根占位横线是 202 / 208）。
 * 别处六个查询都写着同一句子查询（`db/repo.ts` · `study/reading.ts` ×3 ·
 * `study/analysis.ts` · `study/production.ts`），**只有这一处漏了**。
 * 不是 T-4.6 拆分弄丢的 —— 拆分前的 `study.ts` 里也没有（逐字搬过去的）。
 *
 * ★ 教训写在这里：`as X & { 某列: number }` 这种**断言**不检查列真的查出来了没有。
 *   缺列 → `undefined` → 任何 `!== 0` / `!= null` 的判断都倒过来，而且**不报错**。
 */
export function libraryItems(c: StudyCtx, f: LibraryFilter): LibraryItem[] {
  const where: string[] = ['i.deleted_at is null']
  const args: unknown[] = []

  if (f.layer) {
    where.push('i.layer = ?')
    args.push(f.layer)
  }
  if (f.source) {
    where.push('i.source = ?')
    args.push(f.source)
  }
  if (f.onlyRepeated) where.push('i.recollected_count > 0')

  /**
   * ★ 按项目 / 单元筛 —— 判据来自 core/sql/item-lectures.ts，
   *   和项目页矩阵数格子用的**是同一份**。各写各的就会出现
   *   「格子上写 40，点开列出 43」，而那种数差没人查得清。
   * ★ 两者互斥：单元比项目更具体，同时给就以单元为准。
   */
  if (f.unitId !== undefined) {
    where.push(IN_UNIT('i'))
    args.push(f.unitId)
  } else if (f.projectId !== undefined) {
    where.push(IN_PROJECT('i'))
    args.push(f.projectId)
  }

  if (f.scope === 'silent') {
    // V-3 · 判据在 core/silence.ts::isItemSilent，这里只是它的翻译
    where.push(IS_SILENT('i'))
  } else if (f.scope === 'upload') {
    where.push(`i.source = 'self' and i.derived_from is null`)
  } else {
    /**
     * 综合知识库：静默的不进列表（D-158）。
     *
     * ★★ 2026-09-02 · 这里以前写的是
     *   `i.production_state != 'silent' and rc.silent = 0`
     * —— **任一线静默就藏**，而 D-158 说的「静默」定义在
     * `core/silence.ts::isItemSilent`（B 层只看产出线）。两把尺子的后果：
     * 一条 B 层知识点，认读卡退役了（`gradeCard` 认读间隔超过 `silenceDays`
     * 就写 `rc.silent = 1`，`items` 一个字不动）而产出线还在跑 ——
     * **在「全部」里被藏起来，在「只看静默」里又不算静默，哪个列表都找不到它。**
     * 现在两处都用同一份翻译，`scope === 'silent'` 与这里恰好互补。
     */
    if (!f.includeSilent) where.push(`not ${IS_SILENT('i')}`)
  }

  /**
   * 一格 = 「产出线处在某个状态」×「认读线处在某个状态」。
   * ★ 抽成函数是为了 cell（单格）与 cells（多格）**用同一份判据** ——
   *   多格那条是给「读得懂 · 产不出」那一行用的，它是三格之和。
   */
  const cellSql = (c: { row: number; col: number }): string => {
    const ps = ['silent', 'hard', 'training', 'new'][c.row]
    args.push(ps)
    const read =
      c.col === 3
        ? 'rc.silent = 1'
        : c.col === 0
          ? 'rc.silent = 0 and rc.reps = 0'
          : c.col === 2
            ? 'rc.silent = 0 and rc.interval_days >= 21'
            : 'rc.silent = 0 and rc.reps > 0 and rc.interval_days < 21'
    return `(i.production_state = ? and ${read})`
  }

  if (f.cell) where.push(cellSql(f.cell))
  else if (f.cells?.length) where.push(`(${f.cells.map(cellSql).join(' or ')})`)

  const order =
    {
      random: 'random()',
      'accuracy-asc': 'cast(i.corrects as real) / max(i.attempts, 1) asc, i.id',
      'accuracy-desc': 'cast(i.corrects as real) / max(i.attempts, 1) desc, i.id',
      stalest: 'i.updated_at asc',
      streak: 'i.streak desc, i.id',
      recent: 'i.created_at desc'
    }[f.sort ?? 'stalest'] ?? 'i.updated_at asc'

  return c.db
    .prepare(
      `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer, i.kind, i.source,
                i.production_state as productionState, i.silenced_by as silencedBy,
                i.streak, i.attempts, i.corrects,
                i.recollected_count as recollected,
                (select content from analysis_blocks b where b.item_id = i.id and b.block = 'diagnosis') as diagnosis, rc.silent as cardSilent,
                i.derived_from as derivedFrom, i.created_at as createdAt,
                (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
                  where il.item_id = i.id and il.deleted_at is null and il.is_owner = 1 limit 1) as lectureName,
                -- 归属 Lecture：优先 owner，没有 owner 就取它所在的任意一个。
                -- 「拆出来的单位收回哪个 Lecture」要的是「我现在在看的那个」，
                -- 卡在 is_owner 上会让一部分条目收不了（I-045）
                (select il.lecture_id from item_lectures il
                  where il.item_id = i.id and il.deleted_at is null order by il.is_owner desc, il.lecture_id limit 1) as lectureId,
                (select count(*) from items d where d.derived_from = i.id and d.deleted_at is null) as derivedCount,
                -- ★★ T-4.10 补回来的一列，它以前根本没被查出来（见函数上面那段说明）
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.block = 'suspect') as hasSuspect,
                -- ★ T-4.10 · 「还没分析」要的两样事实；判据在 core/library-state.ts
                --   只有 summary 的不算有解析 —— 与待分析队列同一把尺（NO_FULL_ANALYSIS）
                (select count(*) from analysis_blocks b
                  where b.item_id = i.id and b.block <> 'summary') as analysisBlocks,
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.edited <> 0) as blockEdited
           from items i ${JOIN_CARD('i')}
          where ${where.join(' and ')}
          order by ${order}
          limit 500`
    )
    .all(...args)
    .map((r) => {
      const x = r as Omit<LibraryItem, 'cardSilent' | 'hasSuspect' | 'state'> & {
        cardSilent: number
        hasSuspect: number
        analysisBlocks: number
        blockEdited: number
      }
      /**
       * ★ T-4.10 · 状态由 `core/library-state.ts` 算，界面不再自己判 gloss 空不空。
       *   `analysisBlocks` / `blockEdited` 只是算它的原料，不进 `LibraryItem`
       *   —— 界面要的是结论，多给两个数只会让它又有机会自己判一遍。
       */
      const { analysisBlocks, blockEdited, ...rest } = x
      return {
        ...rest,
        cardSilent: boolCol(x.cardSilent, 'cardSilent'),
        hasSuspect: boolCol(x.hasSuspect, 'hasSuspect'),
        state: libraryState({
          gloss: x.gloss,
          derivedCount: x.derivedCount,
          analysisBlocks,
          edited: boolCol(blockEdited, 'blockEdited')
        })
      }
    })
}

/**
 * 把 SQLite 的 0 / 1 变成布尔 —— **而且拿不到那一列时当场抛**。
 *
 * ── 它是 2026-09-06 那个 bug 的解药，不是装饰 ────────────────
 *
 * 那天使用者报「综合知识库几乎每个知识点旁边都有一个标记」。病因是这里原来写
 * `hasSuspect: x.hasSuspect !== 0`，而上面的 SELECT **从来没有查出 `hasSuspect` 这一列**：
 * `undefined !== 0` **恒为 true**，于是每一行都画上了那枚「可能打错或听岔了」的记号
 * （真库副本实测：该出 0 条，实际 208 条）。
 *
 * ★ 为什么编译器拦不住：`r as Omit<…> & { hasSuspect: number }` 是**断言**，不是检查。
 *   TypeScript 只是相信你说的，它不会去看那一列到底在不在结果集里。
 *   于是 `undefined !== 0` 恒真、`undefined != null` 恒假 ——
 *   **任何一个这样的判断都会静静地倒过来，而编译、单测、运行全都不报错。**
 *
 * ★ 所以这一层不再自己写 `!== 0`：列不在就抛一句人话，让它**在开发期炸**，
 *   而不是在他屏幕上多画两百个记号。守的不是 `hasSuspect` 这一个名字，
 *   是「列没查出来会把判断倒过来」这件事本身 —— 下一次换成别的列也一样接得住。
 */
function boolCol(v: number | undefined, col: string): boolean {
  if (v === undefined) {
    throw new Error(
      `libraryItems 的 SELECT 里少了 ${col} 这一列 —— ` +
        `不补上的话它会被当成 undefined，而 undefined !== 0 恒为 true（2026-09-06 就是这么出的事）`
    )
  }
  return v !== 0
}

/** 批量操作 · D-048 保留批量删除、批量改层级（批量加入已取消，AI 自动归档） */
export function bulkDelete(c: StudyCtx, ids: number[]): number {
  // ★ N-2 · 和单条删除是同一个业务动作，走同一个入口
  return c.self.deleteItems(ids)
}

export function bulkSetLayer(c: StudyCtx, ids: number[], layer: 'A' | 'B'): number {
  const t = now()
  const stmt = c.db.prepare(`update items set layer = ?, updated_at = ? where id = ?`)
  const tx = c.db.transaction(() => {
    for (const id of ids) stmt.run(layer, t, id)
  })
  tx()
  return ids.length
}

/**
 * 批量静默 / 取消静默 · I-097
 *
 * 使用者要在勾选之后能「静默」。静默 = 通过全部检验、不再轮转（D-030），
 * 平时是**练出来**的；这里是手动指定 —— 有些条目他自己清楚已经会了，
 * 没必要陪着轮转三轮。
 *
 * 两条线各自有静默位（产出线 `items.production_state`，认读线 `reading_cards.silent`），
 * 所以「静默这一条」= 两条线一起静默，否则它还是会从认读那边冒出来。
 * 反向的「取消静默」同样要两条一起 —— 只放开一条，人会以为没生效。
 */
export function bulkSilence(c: StudyCtx, ids: number[], on: boolean): number {
  const t = now()
  /**
   * ★★ D-296（V34）· 两条线的静默位现在分居两张表，所以这里是**两条语句**。
   *   两条都跑在下面那个 `db.transaction` 里 —— 少了事务就会出现
   *   「产出线静默了、认读卡还在轮转」的中间态，正是本方法注释开头说的那个病。
   */
  const stmt = c.db.prepare(
    `update items
          set production_state = ?, updated_at = ?
        where id = ? and deleted_at is null`
  )
  const cardStmt = c.db.prepare(
    `update reading_cards set silent = ?, updated_at = ?
        where item_id = ? and item_id in (select id from items where deleted_at is null)`
  )
  const ev = c.db.prepare(
    `insert into state_events (item_id, line, from_state, to_state, created_at, updated_at)
       values (?, 'production', ?, ?, ?, ?)`
  )
  const by = c.db.prepare(`update items set silenced_by = ? where id = ?`)
  const tx = c.db.transaction(() => {
    for (const id of ids) {
      const prev = c.db.prepare(`select production_state as s from items where id = ?`).get(id) as
        | { s: string }
        | undefined
      stmt.run(on ? 'silent' : 'training', t, id)
      cardStmt.run(on ? 1 : 0, t, id)
      // 'self' = 他一条一条点过的。取消上级静默时不该把这些一起放出来（4.2）
      by.run(on ? 'self' : null, id)
      // D-043 · 状态一变就记一笔，报告的「知识流向」全靠它
      if (prev && prev.s !== (on ? 'silent' : 'training')) {
        ev.run(id, prev.s, on ? 'silent' : 'training', t, t)
      }
    }
    const terms = c.self.termsOf(ids).map((x) => x.term)
    if (on) c.ledger.noteMany(terms, 'silenced', { note: `手动${SILENCE_ACTIONS.shelve}` })
    else c.ledger.forgetMany(terms, 'silenced')
    c.ledger.op(on ? 'silence' : 'unsilence', 'item', null, terms.slice(0, 3).join('、'), {
      n: ids.length
    })
  })
  tx()
  return ids.length
}

/**
 * 一串 id → 词条与释义 · I-098
 * 「复制」用的。让界面自己从当前列表里凑，会因为分页 / 筛选而少几条；
 * 从库里取才是「我勾了什么就复制什么」。
 */
export function termsOf(c: StudyCtx, ids: number[]): { id: number; term: string; gloss: string | null }[] {
  if (ids.length === 0) return []
  return c.db
    .prepare(
      `select id, term, gloss from items
          where deleted_at is null and id in (${ids.map(() => '?').join(',')}) order by id`
    )
    .all(...ids) as { id: number; term: string; gloss: string | null }[]
}

/** 静默库的统计 · D-030 游戏框上那三个数 */
export function silentStats(c: StudyCtx): { items: number; lectures: number; projects: number } {
  const n = (sql: string): number =>
    (c.db.prepare(sql).get() as { n: number }).n
  return {
    items: n(
      `select count(*) as n from items i ${JOIN_CARD('i')}
          where ${ALIVE('i')} and ${IS_SILENT('i')}`
    ),
    lectures: n(`select count(*) as n from lectures where deleted_at is null and silent = 1`),
    projects: n(`select count(*) as n from projects where deleted_at is null and silent = 1`)
  }
}

export function itemDetail(c: StudyCtx, itemId: number): ItemDetail {
  const it = c.db
    .prepare(
      /**
       * ★ T-4.22 · 这里少了四样：`streak` · `hard_entries` · `reps` · `interval_days`。
       *   它们**只有右边那一整栏读**，而那一栏使用者点名取消了 ——
       *   留着查就是每打开一条词条白取一次没人看的数（和 D-468 删历次作答同一条理由）。
       *   ★ 列一个都没删（D-216）：攻坚区、结算页、SM2 照旧读它们自己的那份。
       *   ★ `production_state` / `silent` 留着 —— ⋮ 里那颗「手动静默 / 放出来」按它决定显示哪一句。
       */
      `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer, i.kind, i.source,
                i.production_state as productionState, i.attempts, i.corrects,
                i.recollected_count as recollected,
                rc.silent as cardSilent, rc.due_at as cardDueAt,
                i.derived_from as derivedFrom,
                (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
                  where il.item_id = i.id and il.deleted_at is null and il.is_owner = 1 limit 1) as lectureName,
                -- 归属 Lecture：优先 owner，没有 owner 就取它所在的任意一个。
                -- 「拆出来的单位收回哪个 Lecture」要的是它现在待的那个，
                -- 卡在 is_owner 上会让一部分条目根本收不了（I-045）
                (select il.lecture_id from item_lectures il
                  where il.item_id = i.id and il.deleted_at is null order by il.is_owner desc, il.lecture_id limit 1) as lectureId
           from items i ${JOIN_CARD('i')} where i.id = ? and ${ALIVE('i')}`
    )
    .get(itemId) as (Omit<ItemDetail['item'], 'cardSilent'> & { cardSilent: number }) | undefined
  if (!it) throw new Error(ITEM_NOT_FOUND)

  // D-152 · 一个表达在多篇材料里出现时**全部摘句保存**，界面默认只显示首次、可展开
  const occurrences = c.db
    .prepare(
      `select o.quote, o.para, m.title as material, l.name as lecture, o.created_at as at
           from occurrences o
           left join materials m on m.id = o.material_id
           left join lectures l on l.id = o.lecture_id
          where o.item_id = ? order by o.id`
    )
    .all(itemId) as ItemDetail['occurrences']

  const blocks = c.db
    .prepare(
      `select block, content, edited, regen_count as regenCount, updated_at as updatedAt
           from analysis_blocks where item_id = ? order by id`
    )
    .all(itemId)
    .map((r) => {
      const b = r as {
        block: string
        content: string
        edited: number
        regenCount: number
        updatedAt: number
      }
      return { ...b, edited: b.edited !== 0 }
    })

  /**
   * ★ D-468（2026-09-07）· 这里原来还查一遍历次作答（D-140「历史档案」）。
   * 使用者点名取消了详情页那一块，所以**这段取数一起删** ——
   * 留着查、界面上不画，就是每打开一条词条白跑一遍连表查询。
   * `answers` / `review_logs` 里的行一个字没动（同步表、SM2 的账，D-436）：
   * 攻坚区那一页仍旧读它们（`production.ts::hardRows`）。
   */

  // D-148 · 整句拆解：我收集的原句唯一能提供的独特价值，就是列出它拆出了什么
  const derived = c.db
    .prepare(
      `select id, term, layer, production_state as productionState, silenced_by as silencedBy, streak
           from items where derived_from = ? and deleted_at is null order by id`
    )
    .all(itemId) as ItemDetail['derived']

  return {
    item: { ...it, cardSilent: it.cardSilent !== 0 },
    occurrences,
    blocks,
    derived
  }
}

/**
 * 一句原句析出了哪些成分 · I-088
 *
 * 我的上传库里点开一句就展开它的析出项（总原型的 `.ur` + `.deriv`）。
 * 单独开一个口子而不是复用 `itemDetail`：那个要把解析区块、出处、
 * 析出项全查一遍，为了展开三行字不值得。
 */
export function derivedOf(c: StudyCtx, itemId: number): ItemDetail['derived'] {
  return c.db
    .prepare(
      `select id, term, layer, production_state as productionState, silenced_by as silencedBy, streak
           from items where derived_from = ? and deleted_at is null order by id`
    )
    .all(itemId) as ItemDetail['derived']
}

/** D-022 · 手动静默。位置不显眼，但要有。 */
export function silenceItem(c: StudyCtx, itemId: number): void {
  c.self.bulkSilence([itemId], true)
}

/** 从静默里放出来。D-024 说静默是封闭的，除**手动放出**外不出现在任何测试中。 */
export function restoreItem(c: StudyCtx, itemId: number): void {
  const t = now()
  /**
   * ★★ D-296（V34）· 产出线与认读线分居两张表 → 两条语句，包在同一个事务里。
   *   少了事务会出现「产出线放出来了、认读卡还静默着」的中间态 ——
   *   他点了「取消静默」，卡却还是不冒出来，而且什么都不报。
   */
  c.db.transaction(() => {
    c.db
      .prepare(
        `update items set production_state = 'training', streak = 0,
                            attempts_in_stage = 0, silenced_by = null, updated_at = ?
            where id = ?`
      )
      .run(t, itemId)
    c.db
      .prepare(
        `update reading_cards set silent = 0, due_at = ?, updated_at = ? where item_id = ?`
      )
      .run(t, t, itemId)
  })()
  const r = c.db.prepare(`select term from items where id = ?`).get(itemId) as
    | { term: string }
    | undefined
  if (r) c.ledger.forget(r.term, 'silenced')
  c.ledger.op('unsilence', 'item', itemId, r?.term ?? null)
}
