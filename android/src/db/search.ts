/**
 * 馆藏搜索 · Android 侧（2026-09-01 · X-Ray 审计 F-013）
 *
 * ══ 为什么手机比电脑更需要它 ★ ═════════════════════════════
 *
 * 桌面上找一个词可以在常驻侧栏的树里翻；**手机没有常驻树**（竖屏放不下，
 * 树收在 Atlas 里要一层层点开）。所以「我记得收过 stairwell，它在哪」
 * 这件事在手机上**只能**靠搜索。
 *
 * ══ 判据逐字港自 Windows `main/browse.ts::search`（59-120）══
 *
 * D-106 的范围原话：
 *   「覆盖知识点（含静默库、攻坚区）+ 项目/单元/lecture/文件的名称 + 原文摘句。
 *    **不搜 AI 对话与解析正文** —— 机器生成的大量文本会淹没结果。」
 *
 * 这一条克制得有道理：解析正文每条几百字，搜「the」会把整个库倒出来。
 *
 * ── 两处 Android 形变（都是产品边界，不是判据分叉）★ ────────
 *
 * ① **不搜 `files`**：文件学习线整条不进手机（D-311），搜出来点不开，
 *    是 D-411 点名的那种死胡同。表里的数据还在，只是这一端不给入口。
 * ② `LIKE` 的转义与排序逐字照搬 —— **`escape '\'` 那一句不能省**：
 *    使用者搜 `100%` 或 `a_b` 时，不转义的 `%`/`_` 是通配符，
 *    结果会突然变成「整个库」，而且不报错。
 */
import type { Db } from './types.ts'

export interface SearchItem {
  id: number
  term: string
  gloss: string
  layer: string
  productionState: string
  /** 认读卡静默了吗（D-296 之后它在 reading_cards 上） */
  cardSilent: boolean
}

export interface SearchQuote {
  itemId: number
  term: string
  quote: string
  /** 这条出处挂在哪一讲（可能为空 —— Capture 那条路不带 material 但带 lecture） */
  lecture: string | null
}

export interface SearchPlace {
  id: number
  name: string
  kind: 'project' | 'unit' | 'lecture'
  /** 上一级的名字，用来消歧（两个项目下可能有同名单元） */
  parent: string | null
}

export interface SearchResults {
  query: string
  items: SearchItem[]
  quotes: SearchQuote[]
  places: SearchPlace[]
}

const EMPTY = (q: string): SearchResults => ({ query: q, items: [], quotes: [], places: [] })

export async function search(db: Db, qRaw: string): Promise<SearchResults> {
  const q = qRaw.trim()
  if (!q) return EMPTY(q)
  // ★ 先把 LIKE 的两个通配符转义掉 —— 见文件头 ②
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`

  /**
   * 知识点。★ `join reading_cards`（不是 left join）—— V34 之后每条知识点必有一张卡；
   * 写成 left join 会把「卡不见了」这种真故障变成「那一行静悄悄没了」。
   * ★ 排序：字面命中的排前面（他搜 `run` 时想先看到 `run`，不是 `outrun` 的释义）。
   */
  const items = (await db.all(
    `select i.id, i.term, i.gloss, i.layer, i.production_state as productionState,
            rc.silent as cardSilent
       from items i join reading_cards rc on rc.item_id = i.id
      where i.deleted_at is null
        and (i.term like ? escape '\\' or i.gloss like ? escape '\\')
      order by case when i.term like ? escape '\\' then 0 else 1 end, i.id
      limit 30`,
    [like, like, like]
  )) as unknown as (Omit<SearchItem, 'cardSilent'> & { cardSilent: number })[]

  // M-012 · 原文摘句是知识点身份的一半，当然要能搜
  const quotes = (await db.all(
    `select o.item_id as itemId, i.term, o.quote, l.name as lecture
       from occurrences o join items i on i.id = o.item_id
       left join lectures l on l.id = o.lecture_id
      where i.deleted_at is null and o.quote like ? escape '\\'
      limit 20`,
    [like]
  )) as unknown as SearchQuote[]

  const places: SearchPlace[] = [
    ...((await db.all(
      `select id, name, 'project' as kind, null as parent from projects
        where deleted_at is null and name like ? escape '\\' limit 10`,
      [like]
    )) as unknown as SearchPlace[]),
    ...((await db.all(
      `select u.id, u.name, 'unit' as kind, p.name as parent from units u
         join projects p on p.id = u.project_id
        where u.deleted_at is null and u.name like ? escape '\\' limit 10`,
      [like]
    )) as unknown as SearchPlace[]),
    ...((await db.all(
      `select l.id, l.name, 'lecture' as kind, u.name as parent from lectures l
         join units u on u.id = l.unit_id
        where l.deleted_at is null and l.name like ? escape '\\' limit 15`,
      [like]
    )) as unknown as SearchPlace[])
  ]

  return {
    query: q,
    items: items.map((x) => ({ ...x, cardSilent: Number(x.cardSilent) !== 0 })),
    quotes,
    places
  }
}
