/**
 * 读路径查询 —— 讲次详情 + 知识点详情（阶段 2 · 一行数据都不写）。
 *
 * ══ 出处 ★★ ═══════════════════════════════════════════════════
 * 每一句 SQL 都是从 Windows 仓库**逐字搬来**的（改动只有：同步 API 化 +
 * 参数占位符风格不变）：
 *
 *   loadLecture     ← `main/db/repo.ts::lecture()` / `::items()`（179-235 行）
 *   loadItemDetail  ← `main/study.ts::itemDetail()`（1762-1867 行）
 *
 * 「哪些行算活的（deleted_at is null）、归属讲次怎么取（owner 优先）、
 *  嫌疑记号怎么算（存在 suspect 块）」全是**业务规则**。
 * ★ 2026-09-02：认读卡那两个宏**不再是本文件自己的第二份** —— 走 core-link
 *   取 `core/sql/reading-card.ts` 那一份（F-017 上一轮漏了这个文件）。
 *   其余查询仍是「逐字港自 Windows」，**漂了以原版为准**。
 * ★ 2026-09-07（D-468）：历次作答那段取数删了 —— 详情页不再画它。
 *   `answers` / `review_logs` 是同步表、是 SM2 的账，**一行没动**（D-436），
 *   只是这一条读路径不再去问它们。
 */
import { ALIVE, JOIN_CARD } from '../core-link.ts'
import type { Db } from './types.ts'

export interface LectureHead {
  id: number
  name: string
  status: string
  dueAt: number | null
  unitName: string
  projectName: string
  itemCount: number
}

export interface MaterialRow {
  id: number
  kind: string
  title: string
  origin: string
  charCount: number
  analyzedAt: number | null
}

export interface ItemRow {
  id: number
  term: string
  gloss: string
  glossZh: string
  layer: string
  kind: string
  source: string
  confidence: number
  recollected: number
  productionState: string
  streak: number
  attempts: number
  corrects: number
  cardSilent: boolean
  derivedFrom: number | null
  derivedCount: number
  quote: string | null
  hasSuspect: boolean
}

export interface LectureData {
  lecture: LectureHead
  materials: MaterialRow[]
  items: ItemRow[]
}

export async function loadLecture(db: Db, lectureId: number): Promise<LectureData> {
  const lecture = (await db.get(
    `select l.id, l.name,
            case when l.silent = 1 then 'silent' else l.status end as status,
            l.due_at as dueAt, u.name as unitName, p.name as projectName,
            (select count(*) from item_lectures il
               join items i on i.id = il.item_id and il.deleted_at is null
              where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null) as itemCount
       from lectures l join units u on u.id = l.unit_id join projects p on p.id = u.project_id
      where l.id = ?`,
    [lectureId]
  )) as unknown as LectureHead | undefined
  if (!lecture) throw new Error(`找不到这个 Lecture（id=${lectureId}）`)

  const materials = (await db.all(
    `select id, kind, title, origin, char_count as charCount, analyzed_at as analyzedAt
       from materials where lecture_id = ? and deleted_at is null order by id`,
    [lectureId]
  )) as unknown as MaterialRow[]

  const items = (
    await db.all(
      `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer, i.kind, i.source,
              i.confidence, i.recollected_count as recollected,
              i.production_state as productionState, i.streak, i.attempts, i.corrects,
              rc.silent as cardSilent, i.derived_from as derivedFrom,
              (select count(*) from items d
                where d.derived_from = i.id and d.deleted_at is null) as derivedCount,
              (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
              exists (select 1 from analysis_blocks b
                       where b.item_id = i.id and b.block = 'suspect') as hasSuspect
         from items i join item_lectures il on il.item_id = i.id and il.deleted_at is null ${JOIN_CARD('i')}
        where il.lecture_id = ? and ${ALIVE('i')}
        order by i.confidence asc, i.id asc`,
      [lectureId]
    )
  ).map((r) => ({
    ...(r as unknown as Omit<ItemRow, 'cardSilent' | 'hasSuspect'>),
    cardSilent: Number(r['cardSilent']) !== 0,
    hasSuspect: Number(r['hasSuspect']) !== 0
  }))

  return { lecture, materials, items }
}

export interface DetailItem {
  id: number
  term: string
  gloss: string
  glossZh: string
  layer: string
  kind: string
  source: string
  productionState: string
  cardReps: number
  cardInterval: number
  cardSilent: boolean
  cardDueAt: number | null
  derivedFrom: number | null
  lectureName: string | null
  lectureId: number | null
}

export interface Occurrence {
  quote: string
  para: number | null
  material: string | null
  lecture: string | null
  at: number
}

export interface Block {
  block: string
  content: string
  edited: boolean
  regenCount: number
}

export interface DerivedRow {
  id: number
  term: string
  layer: string
  productionState: string
  streak: number
}

export interface ItemDetailData {
  item: DetailItem
  occurrences: Occurrence[]
  blocks: Block[]
  derived: DerivedRow[]
}

export async function loadItemDetail(db: Db, itemId: number): Promise<ItemDetailData> {
  const it = (await db.get(
    `select i.id, i.term, i.gloss, i.gloss_zh as glossZh, i.layer, i.kind, i.source,
            i.production_state as productionState,
            rc.reps as cardReps, rc.interval_days as cardInterval,
            rc.silent as cardSilent, rc.due_at as cardDueAt,
            i.derived_from as derivedFrom,
            (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
              where il.item_id = i.id and il.deleted_at is null and il.is_owner = 1 limit 1) as lectureName,
            (select il.lecture_id from item_lectures il
              where il.item_id = i.id and il.deleted_at is null order by il.is_owner desc, il.lecture_id limit 1) as lectureId
       from items i ${JOIN_CARD('i')} where i.id = ? and ${ALIVE('i')}`,
    [itemId]
  )) as Record<string, unknown> | undefined
  if (!it) throw new Error(`找不到这条知识点（id=${itemId}）`)

  const occurrences = (await db.all(
    `select o.quote, o.para, m.title as material, l.name as lecture, o.created_at as at
       from occurrences o
       left join materials m on m.id = o.material_id
       left join lectures l on l.id = o.lecture_id
      where o.item_id = ? order by o.id`,
    [itemId]
  )) as unknown as Occurrence[]

  const blocks = (
    await db.all(
      `select block, content, edited, regen_count as regenCount from analysis_blocks
        where item_id = ? order by id`,
      [itemId]
    )
  ).map((r) => ({ ...(r as unknown as Block), edited: Number(r['edited']) !== 0 }))

  const derived = (await db.all(
    `select id, term, layer, production_state as productionState, streak
       from items where derived_from = ? and deleted_at is null order by id`,
    [itemId]
  )) as unknown as DerivedRow[]

  return {
    item: {
      ...(it as unknown as Omit<DetailItem, 'cardSilent'>),
      cardSilent: Number(it['cardSilent']) !== 0
    },
    occurrences,
    blocks,
    derived
  }
}

/**
 * 解析块的分组与英文标签（手机版 · D-363 内容区标题用英文）。
 *
 * ★ 2026-09-07 · D-468 收窄：详情页**只剩一层正文**，顺序按「先看懂 → 再会用」。
 *   「BASICS / 基础层 / 进阶层」三个名字都不再出现（层没了，名字不许留着，D-471）。
 *   顺序：一层正文 → REGISTER & NUANCE → CLOSE READING ——
 *   分寸辨析比 Close Reading 的七块更常用（M-037），所以它排在前面。
 *   去掉的两块：`pitfalls`（COMMON SLIPS）· `zhTrap`（ZH TRAP）。
 *   ★ 库里已经写过的那些行**不删**（D-436），只是这一屏不再画它们。
 *
 * ★★ 合并块：`meaning` + `barriers` 在 core 里合成了一个新键 `inSentence`
 *   （`core/analysis/blocks.ts`，指针 `7c6a920`）。新解析只产 `inSentence`；
 *   而**老词条库里那两块照旧要画**，所以三个键都在这一组里，而且用**同一个标签** ——
 *   `blocksToShow()` 会把连着的同名标签只画一次，于是老数据的两块落在同一个区域里，
 *   一个字都不丢，屏幕上也不会冒出两个小标题（D-468「不是上下拼接」）。
 *
 * ★ 键与顺序仍与 Windows `ItemDetail.svelte` 同源；Windows 的中文小标题在手机上
 *   换成英文微标签 —— 这是 D-363 的适用，不是内容改动。
 *   合并块的可见名是使用者定的 **Sense**（手机上按 DS 写成 SENSE）。
 *   ★ 键名仍是 `inSentence` —— Close Reading 里已经有一个 `sense` 键（LITERAL VS
 *   EXTENDED），键撞了就没法分辨库里那一行是谁写的。
 */
export const BLOCK_GROUPS: { key: string; title: string; blocks: [string, string][] }[] = [
  {
    // ★ 正文这一层只有一个，头本身就是折叠开关（D-393），所以它必须有名字。
    //   「HOW IT WORKS」是使用者 2026-09-07 定的（原来叫 BASICS，层没了名字也不留）。
    key: 'body',
    title: 'HOW IT WORKS',
    blocks: [
      // ── 先看懂 ──（三个键一个区域：新解析写 `inSentence`，老词条留着 `meaning` / `barriers`）
      ['inSentence', 'SENSE'],
      ['meaning', 'SENSE'],
      ['barriers', 'SENSE'],
      ['verbs', 'VERBS'],
      ['pattern', 'PATTERN'],
      // ── 再会用 ──（原「进阶层」的两块，不再单独成层）
      ['pragmatics', 'PRAGMATICS'],
      ['variation', 'VARIATION']
    ]
  },
  {
    key: 'register',
    title: 'REGISTER & NUANCE',
    blocks: [
      ['register', 'REGISTER'],
      ['nuance', 'NUANCE']
    ]
  },
  {
    key: 'close',
    title: 'CLOSE READING',
    blocks: [
      ['type', 'TYPE'],
      ['sense', 'LITERAL VS EXTENDED'],
      ['structure', 'STRUCTURE'],
      ['background', 'BACKGROUND'],
      ['family', 'WORD FAMILY'],
      ['collocations', 'COLLOCATIONS'],
      ['slots', 'SLOTS']
    ]
  }
]

/** 一组里真的要画的那几行；`title` 为 null = 跟上一行同一个区域，不再重复小标题 */
export interface ShownBlock {
  key: string
  title: string | null
  /** 已经拆成人话的正文行（`blockLines`）—— 组件直接一行一行画，不再自己解析 */
  lines: string[]
}

/**
 * 一块解析的正文拆成几行 —— **这是在修一个显示 bug**（2026-09-07 主控裁 ②）。
 *
 * `analysis_blocks.content` 是文本列，非字符串的块按 `JSON.stringify` 存
 * （`core/analysis/plan.ts`）。手机详情页此前把它**原样打在屏幕上**，于是
 * `barriers` / `nuance` / `family` / `collocations` 这几块在屏幕上是一串
 * 带方括号和引号的 JSON —— 不是排版难看，是**显示错**。
 *
 * 解析只写在这一处（组件里一行 JSON 都不许再解）：
 *   · 字符串数组            → 一条一行
 *   · `{term, note}` 数组   → 每条「term —— note」（`nuance`）
 *   · `{slot, fills}` 数组  → 每条「slot —— fills」（`slots`）
 *   · 其余（含坏 JSON）      → 原样一行，**绝不抛**
 *     （坏 JSON 宁可露出原文，也不能因为一块解析炸掉整屏 —— D-338 的同一条道理）
 */
export function blockLines(content: string): string[] {
  let v: unknown
  try {
    v = JSON.parse(content)
  } catch {
    return [content]
  }
  if (!Array.isArray(v) || v.length === 0) return [content]
  if (v.every((x) => typeof x === 'string')) return v as string[]
  /**
   * 提示词里定死的两种「左边一个词、右边一句话」的形状。
   * ★ 只认这两对键名 —— 认不出来的形状宁可把原文露出去，也不猜着拼
   *   （猜错了屏幕上会出现一句**看着像解析、其实是我编的**的话）。
   */
  const pairs: [string, string][] = [
    ['term', 'note'], // nuance
    ['slot', 'fills'] // slots
  ]
  for (const [a, b] of pairs) {
    const has = (x: unknown): x is Record<string, string> =>
      typeof x === 'object' && x !== null &&
      typeof (x as Record<string, unknown>)[a] === 'string' &&
      typeof (x as Record<string, unknown>)[b] === 'string'
    if (v.every(has)) return v.map((x) => `${x[a]} —— ${x[b]}`)
  }
  return [content]
}

/**
 * 这一组在这条知识点上画成什么样。
 *
 * ★ 抽成函数（而不是写在组件里）是为了能被用例钉住：
 *   合并块那三个键共用一个标签，**连着的同名标签只画第一次** ——
 *   老词条的 `meaning` / `barriers` 于是落进同一个区域，两段正文都在，
 *   而屏幕上只有一个小标题。断在中间的同名（真出现的话）会重新画标题，
 *   因为那时它们中间隔着别的块，不再是一个区域。
 */
export function blocksToShow(
  blocks: [string, string][],
  contentOf: (key: string) => string | null
): ShownBlock[] {
  const out: ShownBlock[] = []
  let last: string | null = null
  for (const [key, title] of blocks) {
    const content = contentOf(key)
    if (content === null) continue
    out.push({ key, title: title === last ? null : title, lines: blockLines(content) })
    last = title
  }
  return out
}

/**
 * core 的 `RENDERED_BLOCKS` 里有、而手机详情页**有意不画**的块 —— 每条都说得出被谁挡。
 *
 * 为什么要有这张表：`RENDERED_BLOCKS` 是「详情页认得几块」的判据（I-112，
 * `analyse.ts` 靠它判断这次解析有没有写出人看得见的东西）。手机比 Windows 少画几块，
 * 差集要是没人登记，两种事故长得一模一样：**有意不画** 和 **加了新块忘了铺** ——
 * 都是「AI 写进去了、屏幕上没有」。所以差集必须一条条写下来，用例守着（R-5）。
 */
export const BLOCKS_NOT_SHOWN: Record<string, string> = {
  gloss: '不是块 —— 写在 items 列上，画在知识点头（R-002）',
  glossZh: '同上 —— 中文揭示件那一行（D-389）',
  chunks: '拆出来的单位要「收进写作层 / 理解层」才有意义，那是 Windows 的动作',
  rewrites: '改写练习属练习流，不在详情页',
  examples: '例句归词典与认读卡（D-336）',
  proper: '专名标记只影响出题，不给人看',
  suspect: '嫌疑记号画在列表行的 ✎ 上（D-302 只显示、不处理）'
}
