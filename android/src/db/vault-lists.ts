/**
 * Vault 列表查询（阶段 2 · 只读）—— **逐字港自 Windows**：
 *   loadLibraryItems ← `main/study.ts::libraryItems`（1583-1656）
 *   loadHardList     ← `main/study.ts::hardList`（674-686，行选取口径；history 手机不显）
 *   loadTrash        ← 按 `browse.ts::trash()` 的四类口径列行（★ 打开即清 `TRASH_DAYS` 天
 *                      的契约行为在阶段 5 随恢复一起接 —— 清除是写）
 * ★ 2026-09-02：静默与认读卡这三个宏**不再是本文件自己的第二份** ——
 *   走 core-link 取 `core/sql/{silence,reading-card}.ts` 那一份
 *   （F-017 上一轮漏了这个文件）。`IS_SILENT` 尤其不能有第二份：
 *   它一漂，Windows 的「今日 39 条」和手机的「今日 39 条」就不一样，**两端都不报错**。
 */
import { IS_SILENT, JOIN_CARD, PRODUCTION_APPLIES } from '../core-link.ts'
import type { Db } from './types.ts'

export type LibrarySort =
  | 'random'
  | 'accuracy-asc'
  | 'accuracy-desc'
  | 'stalest'
  | 'streak'
  | 'recent'

export interface LibraryFilter {
  scope?: 'all' | 'upload' | 'silent'
  layer?: 'A' | 'B'
  source?: string
  onlyRepeated?: boolean
  /** D-400③ · Assist 统一收集视图：ops_log 的 capture 流水就是来源标记 ——
   *  同一批知识点的**过滤视图**，不是第二套数据（无论落进哪个 P/U/L 都能在这找到） */
  assistOnly?: boolean
  includeSilent?: boolean
  sort?: LibrarySort
}

export interface VaultItem {
  id: number
  term: string
  gloss: string
  glossZh: string
  layer: string
  kind: string
  source: string
  productionState: string
  recollected: number
  cardSilent: boolean
  derivedFrom: number | null
  createdAt: number
  updatedAt: number
  lectureName: string | null
  lectureId: number | null
  derivedCount: number
}

export async function loadLibraryItems(db: Db, f: LibraryFilter): Promise<VaultItem[]> {
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
  if (f.assistOnly) {
    where.push(
      `exists (select 1 from ops_log o where o.op = 'capture' and o.target = 'item' and o.target_id = i.id)`
    )
  }

  if (f.scope === 'silent') {
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
     * ★ Windows `study.ts::libraryItems` 同一处同一改法（两端同一句话）。
     */
    if (!f.includeSilent) where.push(`not ${IS_SILENT('i')}`)
  }
  // ★ 矩阵格筛选（f.cell）有意不港 —— 4×4 矩阵不进手机（D-348）

  const order =
    {
      random: 'random()',
      'accuracy-asc': 'cast(i.corrects as real) / max(i.attempts, 1) asc, i.id',
      'accuracy-desc': 'cast(i.corrects as real) / max(i.attempts, 1) desc, i.id',
      stalest: 'i.updated_at asc',
      streak: 'i.streak desc, i.id',
      recent: 'i.created_at desc'
    }[f.sort ?? 'stalest'] ?? 'i.updated_at asc'

  return (
    await db.all(
      `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer, i.kind, i.source,
              i.production_state as productionState,
              i.recollected_count as recollected, rc.silent as cardSilent,
              i.derived_from as derivedFrom, i.created_at as createdAt, i.updated_at as updatedAt,
              (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
                where il.item_id = i.id and il.deleted_at is null and il.is_owner = 1 limit 1) as lectureName,
              (select il.lecture_id from item_lectures il
                where il.item_id = i.id and il.deleted_at is null order by il.is_owner desc, il.lecture_id limit 1) as lectureId,
              (select count(*) from items d where d.derived_from = i.id and d.deleted_at is null) as derivedCount
         from items i ${JOIN_CARD('i')}
        where ${where.join(' and ')}
        order by ${order}
        limit 500`,
      args
    )
  ).map((r) => ({
    ...(r as unknown as Omit<VaultItem, 'cardSilent'>),
    cardSilent: Number(r['cardSilent']) !== 0
  }))
}

export interface HardListRow {
  id: number
  term: string
  gloss: string
  hardEntries: number
  lastAt: number | null
}

export async function loadHardList(db: Db): Promise<HardListRow[]> {
  return (await db.all(
    `select i.id, i.term, i.gloss, i.hard_entries as hardEntries,
            (select max(created_at) from answers a where a.item_id = i.id) as lastAt
       from items i
      where i.deleted_at is null and i.production_state = 'hard'
      order by i.attempts desc, i.id`
  )) as unknown as HardListRow[]
}

export interface TrashRow {
  kind: 'project' | 'unit' | 'lecture' | 'item'
  id: number
  title: string
  deletedAt: number
}

export async function loadTrash(db: Db): Promise<TrashRow[]> {
  const out: TrashRow[] = []
  const grab = async (kind: TrashRow['kind'], table: string, col: string): Promise<void> => {
    for (const r of await db.all(
      `select id, ${col} as title, deleted_at as deletedAt from "${table}"
        where deleted_at is not null order by deleted_at desc`
    )) {
      out.push({ kind, id: Number(r['id']), title: String(r['title']), deletedAt: Number(r['deletedAt']) })
    }
  }
  await grab('item', 'items', 'term')
  await grab('lecture', 'lectures', 'name')
  await grab('unit', 'units', 'name')
  await grab('project', 'projects', 'name')
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}
