/**
 * 改一条知识点的**正文** —— term / gloss / gloss_zh（T-5.14 · D-R23 已裁「可以」）
 *
 * ══ 它是什么，不是什么 ═══════════════════════════════════════
 *
 * 是：把**写错了的东西**改对。手机采集是这个库里 105 条的全部来源，
 *     采集时看错一个字母，以前只能等回电脑上改 —— D-R23 裁了「手机可以改」。
 * 不是：改归类 / 归属（D-354 未定）· 删除 / 合并 · 重跑解析（那是 T-5.12 的入口）。
 *
 * ══ 三条硬约束（每条都有出处，拆掉哪条都会静默坏掉）═══════════
 *
 * ① **uid 不变、不新建条目。** `items.uid` 是同步身份（触发器随机铸一次），
 *    换 uid = 对面看见「删了一条、又来了一条新的」，学习史与归属全断。
 *    所以这里只有 `update`，一个 `insert into items` 都没有。
 * ② **出处摘句跟着改**（M-012）。词条从 `tangle up` 改成 `tangle with`，
 *    而 `occurrences.quote` 还写着旧的 —— 详情页把词条从摘句里划出来那一下
 *    （`Detail.svelte::splitQuote`）就再也划不中，出处看起来像是别的词的。
 *    做法与 Windows `study.ts::acceptSuspect` 逐字同款：`replace(quote, was, should)`，
 *    只动**真的含有旧串**的那几行（`quote like '%was%'`）。
 * ③ **每改一列留一笔痕**（`analysis_blocks` 的 `corrections` 区块，JSON 数组）。
 *    留痕带 `field / was / should / why / at`：**`field` 是 core 失效判定认的键**
 *    （`core/analysis/stale.ts::countsAsTermChange`）——
 *    改释义不该让解析失效，只改大小写 / 尾标点也不该。没有 `field`，
 *    改一次中文释义就会把整份解析报成「写的是改之前的词条」。
 *
 * ══ 判据不在这里 ═══════════════════════════════════════════
 *
 * 「算不算改了词」「解析是不是过时了」全在 `core/analysis/stale.ts`；
 * 「是不是同一个说法」在 `core/normalize-term.ts`。这个文件只做三件事：
 * 校验输入 · 一个事务里把该改的改掉 · 把 core 的答案取回来。
 *
 * ══ 有意**不做**的两件 ═══════════════════════════════════════
 *
 * · **不自动删解析、不自动重跑**：解析很贵（一次 AI 调用），而且他可能只是
 *   改了个大小写。失效只**说一句**，重跑由他点（入口是 T-5.12 的）。
 * · **改成与同讲次另一条重名不拦**：合并按 `normalizeTerm` 分组（T-2.11），
 *   改完自然落进新组，讲次页查重看得见。拦下来等于替他决定「这两条是一条」，
 *   而那正是 T-2.11 特意交给他确认的事。这里只回一句话让 UI 提醒。
 */
import {
  normalizeTerm,
  planItemEdit,
  ItemEditRefused,
  staleAfterEdit,
  type CorrectionEntry
} from '../core-link.ts'
/**
 * ★ 注入点与它那对类型三处共用一份（T-5.15 当时是「借分析那条的」）。
 *   T-5.15 在这里留过一句话：「这两个类型其实是**同步**的词汇，更该住在
 *   `db/sync.ts` 那一侧」—— I-163 把它们搬到了 `db/sync-first.ts`（零依赖），
 *   真实现进 `db/sync-first-native.ts`。这里因此不再顺着 `analyse.ts` 走。
 */
import { syncFirstFor, type SyncFirst, type SyncNote } from './sync-first.ts'
import type { Db } from './types.ts'

/** 能改的三列。★ 别的列一列都不许进来 —— 归属 / 层 / 学习史各有各的入口 */
export type EditableField = 'term' | 'gloss' | 'gloss_zh'

/**
 * ══ 改之前先同步一趟（T-5.15）════════════════════════════════
 *
 * ★ 为什么要有这一趟：改词条**读的是本机那一版**（算「改了哪几列」、算留痕里的
 *   `was`、算出处里要替换掉的旧串，全都用它）。如果电脑刚把这一条改过而手机还没拉，
 *   他就是在一份过时的正文上做修改 —— 留痕会记下一个**从来没存在过的 `was`**，
 *   而合并之后两边谁也说不清中间发生了什么。
 *
 * ★★ 所以它**必须排在读旧值之前**，不是「顺手在前面加一句」。这一条与
 *    `analyse.ts` 里那一趟同源（D-R22 给分析加的），形状与注入点类型都一样。
 *
 * ★ 缩的是**窗口**，不是消除窗口：同步与写库之间对面仍然可能再改一次。
 *   真撞上仍然归 D-438（新的定 + 落账 + 还原入口），本条一个字都没动那套。
 *
 * ★ 跳过 / 失败 **绝不阻塞保存**：他人在那儿、字已经敲完了，
 *   因为「同步没跑成」而拒绝保存是最坏的选择。账带回 `EditItemResult.sync`，
 *   由 UI 决定说不说那一句。
 */
// 真实现在 `db/sync-first-native.ts`，只有 App 入口装它 —— 理由与
// `analyse.ts::defaultSyncFirst` 同一条（I-163：`db/sync.ts` 顶层拉 Capacitor
// 插件，从前那句 `await import('./sync.ts')` 把它一路打进了无桥的引擎包）。
const defaultSyncFirst: SyncFirst = syncFirstFor('修改前同步')

export interface EditItemOptions {
  /** 注入点：② 层测试用假的；**默认那条不许绕过**（负向对照盯着它） */
  syncFirst?: SyncFirst
}

/** 只传要改的那几个；没传的一列都不动 */
export interface EditItemInput {
  term?: string
  gloss?: string
  glossZh?: string
}

export interface EditItemResult {
  id: number
  /** 真的改了哪几列（按 `items` 的列名） */
  changed: EditableField[]
  /** 改完之后的词条 */
  term: string
  /** 有几条出处的摘句跟着换了（词条没改、或者摘句里本来就没有旧串 → 0） */
  quotesTouched: number
  /**
   * 归一之后与**同讲次里**另一条撞上了 —— **不拦**，只让 UI 提一句。
   * 判据与合并分组同一把尺（`core/normalize-term.ts`）。
   */
  duplicateOf: { id: number; term: string } | null
  /** 这一次改完，现有解析算不算「写的是改之前的词条」（判定在 core） */
  stale: boolean
  /** 保存**之前**那一趟同步的账（跳过 / 失败都不阻塞保存，但要说得出来） */
  sync: SyncNote
}

const COLUMN: Record<'term' | 'gloss' | 'glossZh', EditableField> = {
  term: 'term',
  gloss: 'gloss',
  glossZh: 'gloss_zh'
}

interface Current {
  term: string
  gloss: string
  gloss_zh: string
}

/**
 * 现有解析算不算「写的是改之前的词条」。
 *
 * ★ 判定一行都不在这里 —— `staleAfterEdit` 是 core 的，两端算出同一个答案。
 *   这里只负责把它要的两样取出来：`corrections` 那一块解出来的数组、
 *   以及每一块的 `updated_at`。
 * ★ 留痕坏掉（不是合法 JSON / 不是数组）当**没有留痕**处理：一句提示而已，
 *   不值得为它把详情页整屏带崩。
 */
export async function isAnalysisStale(db: Db, itemId: number): Promise<boolean> {
  const rows = await db.all(
    `select block, content, updated_at as updatedAt from analysis_blocks where item_id = ?`,
    [itemId]
  )
  return staleAfterEdit(correctionsOf(rows), rows.map((r) => ({
    block: String(r['block']),
    updatedAt: Number(r['updatedAt'] ?? 0)
  })))
}

function correctionsOf(rows: readonly Record<string, unknown>[]): CorrectionEntry[] {
  const row = rows.find((r) => String(r['block']) === 'corrections')
  if (!row) return []
  try {
    const parsed: unknown = JSON.parse(String(row['content'] ?? ''))
    return Array.isArray(parsed) ? (parsed as CorrectionEntry[]) : []
  } catch {
    return [] // 见 isAnalysisStale 头注
  }
}

/**
 * 改正文。**一个事务**：三列 + 出处 + 留痕，要么全成要么全不成。
 *
 * 拒绝（抛一句人话，库里零改动）：
 *   · 这条不在了（删了 / id 不对）
 *   · 词条改成空的或只剩空白 —— 词条**就是**这条知识点本身，不能没有
 *   · 三列都和原来一样 —— 没有改动就不该写一笔留痕、不该动 `updated_at`
 *     （动了就等于凭空推一行上云，还让解析白白失效）
 *
 * ★ 释义 / 中文释义**可以清空**（它们的默认值本来就是空串）：写错的中文释义
 *   得能删掉。只有词条不许空。
 */
export async function editItem(
  db: Db,
  id: number,
  input: EditItemInput,
  o: EditItemOptions = {}
): Promise<EditItemResult> {
  /**
   * ★★ 这一趟**必须在下面那句读旧值之前**（见 `defaultSyncFirst` 头注）：
   *   `cur` 是整条命令的地基 —— 「改了哪几列」「留痕里的 `was`」「出处里要换掉的旧串」
   *   全从它来。在过时的 `cur` 上算出来的留痕，记的是一个从来没存在过的历史。
   * ★ 它自己不许把保存带崩：抛了就当「没同步上」，照常往下走。
   */
  let sync: SyncNote
  try {
    sync = await (o.syncFirst ?? defaultSyncFirst)(db)
  } catch (e) {
    sync = { ran: false, note: `修改前同步没跑成：${(e as Error)?.message ?? e}`, why: 'error' }
  }

  const cur = (await db.get(
    `select term, gloss, gloss_zh from items where id = ? and deleted_at is null`,
    [id]
  )) as unknown as Current | undefined
  if (!cur) throw new Error('这条知识点不在了 —— 可能已经被删掉。')

  /**
   * ★★ 2026-09-08 · D-478 ③：**改哪几列 · 留痕长什么样 · 什么情况下拒绝**
   *   这三处判断搬进了 core（`analysis/edit.ts::planItemEdit`），两端从此一份。
   *   本文件从这里往下只剩「执行」：按计划写库、出处跟改、留痕落盘。
   *
   *   为什么非搬不可：留痕那一笔的 `field` 正是 core 失效判定认的键
   *   （`stale.ts::countsAsTermChange`）。两端各写一份的话，形状差一个键，
   *   `staleAfterEdit` 在一端会**永远返回 false** —— 不报错、不崩，只是那句
   *   「这份解析写的是改之前的词条」再也不出现。
   *
   * ★ 拒绝那两种（词条空 · 一个字没改）core 抛的是 `ItemEditRefused`，
   *   这里翻成普通 `Error` —— 界面上游只认「抛了就把那句话显示出来」，
   *   而那两句人话本来就是 core 给的（一字未改）。
   */
  const t = Date.now()
  let plan
  try {
    plan = planItemEdit(
      { term: cur.term, gloss: cur.gloss, glossZh: cur.gloss_zh },
      { term: input.term, gloss: input.gloss, glossZh: input.glossZh },
      t
    )
  } catch (e) {
    if (e instanceof ItemEditRefused) throw new Error(e.message)
    throw e
  }

  const changed: EditableField[] = plan.columns.map((c) => c.column)
  const next: Partial<Record<EditableField, string>> = Object.fromEntries(
    plan.columns.map((c) => [c.column, c.value])
  )
  const { termWas, termNow, termChanged } = plan

  // 出处里**真的**含有旧词条的有几条 —— 先数，因为 run() 不回受影响行数
  const quotesTouched = termChanged
    ? Number(
        (
          await db.get(`select count(*) as n from occurrences where item_id = ? and quote like ?`, [
            id,
            `%${termWas}%`
          ])
        )?.['n'] ?? 0
      )
    : 0

  // 留痕：每改一列一笔，追加在既有数组后面（老的一笔都不动）
  const before = await db.all(
    `select block, content, updated_at as updatedAt from analysis_blocks where item_id = ?`,
    [id]
  )
  // ★ 每改一列一笔，追加在既有数组后面（老的一笔都不动）——**那几笔的形状由 core 给**
  const log: CorrectionEntry[] = [...correctionsOf(before), ...plan.log]

  await db.begin()
  try {
    // ★ 只写真的改了的那几列（`COLUMN` 是白名单，列名不来自输入）
    const sets = changed.map((c) => `${c} = ?`).join(', ')
    await db.run(`update items set ${sets}, updated_at = ? where id = ?`, [
      ...changed.map((c) => next[c] ?? ''),
      t,
      id
    ])

    // ② 出处跟着改（M-012）—— Windows acceptSuspect 逐字同款
    if (termChanged) {
      await db.run(
        `update occurrences set quote = replace(quote, ?, ?), updated_at = ?
          where item_id = ? and quote like ?`,
        [termWas, termNow, t, id, `%${termWas}%`]
      )
    }

    // ③ 留痕（`analysis_blocks` 上 (item_id, block) 唯一，所以是 upsert）
    await db.run(
      `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
       values (?, 'corrections', ?, ?, ?)
           on conflict(item_id, block) do update set
             content = excluded.content, updated_at = excluded.updated_at`,
      [id, JSON.stringify(log), t, t]
    )
    await db.commit()
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }

  return {
    id,
    changed,
    term: termNow,
    quotesTouched,
    duplicateOf: termChanged ? await sameSayingInLectures(db, id, termNow) : null,
    stale: await isAnalysisStale(db, id),
    sync
  }
}

/**
 * 同讲次里还有没有别的条目**是同一个说法**。
 *
 * ★ 在 JS 里比，不在 SQL 里比：`normalizeTerm` 会去掉行尾标点，
 *   SQLite 没有同款函数，写一份近似的就是第二把尺。同讲次的条目很少，取回来比。
 */
async function sameSayingInLectures(
  db: Db,
  id: number,
  term: string
): Promise<{ id: number; term: string } | null> {
  const norm = normalizeTerm(term)
  if (!norm) return null
  const rows = await db.all(
    `select distinct i.id as id, i.term as term
       from items i
       join item_lectures il on il.item_id = i.id and il.deleted_at is null
      where i.deleted_at is null and i.id <> ?
        and il.lecture_id in (
          select lecture_id from item_lectures where item_id = ? and deleted_at is null
        )`,
    [id, id]
  )
  for (const r of rows) {
    if (normalizeTerm(String(r['term'])) === norm) {
      return { id: Number(r['id']), term: String(r['term']) }
    }
  }
  return null
}
