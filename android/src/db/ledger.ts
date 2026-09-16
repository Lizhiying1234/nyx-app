/**
 * 行为账本（手机侧最小面）—— **逐字港自 Windows `main/db/ledger.ts`**。
 *
 * 只搬手机写动作用得到的四件：`note / noteMany / forget / forgetMany / op`。
 * 判决语义（R-3-e：撤销是记一笔不是删一行 · 账记在字面 norm 上）原样保留；
 * `term_ledger` 与 `ops_log` 都在 SYNC_TABLES —— 记了自然会走到电脑上。
 * ★ 名单管理界面（list/drop）是 PC ONLY（矩阵 v3），这里只有写入面。
 * ★ 与 tree/read-path 同类的「第二份」，P1-4 名下待上提 core。
 */
import { shapeOf, type SelShape } from './lookup.ts'
import type { Db } from './types.ts'

export type Verdict = 'deleted' | 'purged' | 'silenced'

/** Windows 同名函数逐字 */
export function normTerm(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase()
}

export async function note(
  db: Db,
  term: string,
  verdict: Verdict,
  opts: { lectureId?: number | null; note?: string | null } = {}
): Promise<void> {
  const norm = normTerm(term)
  if (!norm) return
  const t = Date.now()
  await db.run(
    `insert into term_ledger (norm, term, verdict, scope, lecture_id, note, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(norm, verdict, coalesce(lecture_id, 0)) do update set
       term = excluded.term,
       note = excluded.note,
       revoked_at = null,
       updated_at = excluded.updated_at`,
    [norm, term.trim(), verdict, opts.lectureId ? 'lecture' : 'global', opts.lectureId ?? null, opts.note ?? null, t, t]
  )
}

export async function noteMany(
  db: Db,
  terms: string[],
  verdict: Verdict,
  opts: { lectureId?: number | null; note?: string | null } = {}
): Promise<void> {
  for (const term of terms) await note(db, term, verdict, opts)
}

/** 撤销 = 记一笔（幂等，撤过的不再抬 updated_at） */
export async function forget(db: Db, term: string, verdict: Verdict): Promise<void> {
  const norm = normTerm(term)
  if (!norm) return
  const t = Date.now()
  await db.run(
    `update term_ledger set revoked_at = ?, updated_at = ?
      where norm = ? and verdict = ? and revoked_at is null`,
    [t, t, norm, verdict]
  )
}

export async function forgetMany(db: Db, terms: string[], verdict: Verdict): Promise<void> {
  for (const term of terms) await forget(db, term, verdict)
}

export async function op(
  db: Db,
  opName: string,
  target: string,
  targetId: number | null,
  title?: string | null,
  detail?: unknown
): Promise<void> {
  try {
    const t = Date.now()
    await db.run(
      `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [opName, target, targetId, title ?? null, detail === undefined ? null : JSON.stringify(detail), t, t]
    )
  } catch {
    /* 流水挂了不该挡业务动作 —— 原版同款容错 */
  }
}

// ── 查词记账（T-4.14 · 归档 d §三 G / 判断五）───────────────────
/**
 * 一次查词记一行 `ops_log`（op='lookup' · title = 词面），detail 三个字段：
 *
 *   `source` 从哪查的 —— `assist` 第三方 App 里的气泡（引擎那条路）·
 *                        `app` 应用内 Lookup 页
 *   `face`   看的是哪一面 —— `quick` 简明释义 · `dict` 本地词典 · `ai` AI 搜索
 *   `saved`  这一次查完收没收下（`items.id`）—— 没收就是 `null`，
 *            收了由 `markLookupSaved` 回填
 *
 * ★ **不加表不加列**：`detail` 本来就是自由 JSON，结构指纹不动（D-461 两端
 *   不用协调升级）；`ops_log` 已在 W+A 同步合约里 —— 记了自然走到电脑上。
 * 以及 **I-144 的形态判据**（同一件事的另一半，所以在同一个函数里）：
 *   词 / 词组  → `target='term'`，`title` 就是那个词（照旧）
 *   整句 / 整段 → `target` 记形态，**`title` 留空**（理由见 `recentLookups` 头注：
 *                那是第三方 App 屏幕上的正文，流水要的是「他查了一次」这个事实）
 *
 * ★ 形状只有这一份：两个入口（`engine/main.ts` 的气泡 · `Lookup.svelte` 的
 *   搜索）都调它。判据写在这里而不是入口里还有一层原因（I-144 搬过来时写的）：
 *   `engine/main.ts` 在 node 里 import 不进来（顶层要 `nyxHost`），
 *   判据留在那儿**测不到** —— 用例只能照抄一份长得一样的，抄件绿不代表真件对。
 *   要加字段就加在这里，不许哪个入口自己拼一个对象 —— 那就是第二份形状。
 * ★ 只记「查了什么」这一个动作，不做点击流（归档 d §三 判断五）。
 *   一次查询一行：换本重看、追加面都是同一次，不重记（判据在各自入口）。
 */
export type LookupSource = 'assist' | 'app'
export type LookupFace = 'quick' | 'dict' | 'ai'

export interface LookupDetail {
  source: LookupSource
  face: LookupFace
  /** 收下的 `items.id`；还没收 / 没收就是 null */
  saved: number | null
}

export async function noteLookup(
  db: Db,
  term: string,
  at: { source: LookupSource; face: LookupFace }
): Promise<void> {
  const shape = shapeOf(term)
  const asWord = shape === 'word' || shape === 'phrase'
  const detail: LookupDetail = { source: at.source, face: at.face, saved: null }
  await op(db, 'lookup', asWord ? 'term' : shape, null, asWord ? term : null, detail)
}

/** 读回一行的 detail —— 认不出形状（本条改动之前的老行、或别的 op）就是 null */
export function asLookupDetail(raw: unknown): LookupDetail | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const o = JSON.parse(raw) as Partial<LookupDetail> | null
    if (o === null || typeof o !== 'object') return null
    if (o.source !== 'assist' && o.source !== 'app') return null
    if (o.face !== 'quick' && o.face !== 'dict' && o.face !== 'ai') return null
    return { source: o.source, face: o.face, saved: typeof o.saved === 'number' ? o.saved : null }
  } catch {
    return null
  }
}

/**
 * Save 之后回填 `saved` ——「查了收没收」是最便宜也最真的信号（归档 d §三 判断五）。
 *
 * 判据：**同一个词最近的那一行 lookup**，且它还没回填过。
 *   · 收之前必有一次同词查询（气泡的 quick 那一笔 · Lookup 页搜索那一笔），
 *     所以「最近一行」就是这一次 —— 不设时间窗，也就没有拍出来的阈值
 *   · 已经回填过的不再动：同一个词第二次收，改的不该是上一次那一行
 *   · 老行（detail 为空）**不碰**：不知道 source / face 就不许编一个出来
 *     （D-412 文案说真话的同一条精神）
 * ★ 抬 `updated_at`：这一行要再走一次同步，电脑上才看得到 saved（D-438 只比 updated_at）。
 * ★ 回填失败只是账少一格，绝不让 Save 失败（与 `op` 同款容错）。
 */
export async function markLookupSaved(db: Db, term: string, itemId: number): Promise<boolean> {
  const norm = normTerm(term)
  if (!norm || !(itemId > 0)) return false
  try {
    // 词面匹配与收词查重同一个写法（`capture.ts` 的 `lower(trim(...))`）
    const r = await db.get(
      `select id, detail from ops_log
        where op = 'lookup' and title is not null and lower(trim(title)) = ?
        order by created_at desc, id desc limit 1`,
      [norm]
    )
    if (!r) return false
    const d = asLookupDetail(r['detail'])
    if (!d || d.saved !== null) return false
    const t = Date.now()
    await db.run(`update ops_log set detail = ?, updated_at = ? where id = ?`, [
      JSON.stringify({ ...d, saved: itemId } satisfies LookupDetail),
      t,
      Number(r['id'])
    ])
    return true
  } catch {
    return false
  }
}

// ── 行为计数（D-362 · F2 页底那一行）─────────────────────────────
// 「数你做了什么，可以；说你做得怎么样，不行」—— 只数动作，不评水平。
// 查询流水 = ops_log op='lookup'（title=词面；本表 W+A 合约允许，随同步回电脑）。

export interface LookupWeek {
  looked: number
  saved: number
  top: { word: string; n: number } | null
}

/** 本周（周一 00:00 起）的查/收/查最多 —— 状态直读，不聚合成评价 */
export async function lookupWeek(db: Db): Promise<LookupWeek> {
  const now = new Date()
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const ws = monday.getTime()
  const looked = Number(
    (await db.get(`select count(*) as n from ops_log where op = 'lookup' and created_at >= ?`, [ws]))?.['n'] ?? 0
  )
  const saved = Number(
    (await db.get(
      `select count(*) as n from ops_log where op = 'capture' and target = 'item' and created_at >= ?`,
      [ws]
    ))?.['n'] ?? 0
  )
  const top = (await db.get(
    `select title as w, count(*) as n from ops_log
      where op = 'lookup' and created_at >= ? and title is not null
      group by title order by n desc, w limit 1`,
    [ws]
  )) as { w?: string; n?: number } | undefined
  return {
    looked,
    saved,
    top: top?.['w'] ? { word: String(top['w']), n: Number(top['n']) } : null
  }
}

export interface RecentLookup {
  word: string
  /** 最后一次查它的时间 */
  at: number
  /** 一共查过几次 */
  n: number
}

/**
/**
 * 最近查过的几个词 —— Lookup 首页「搜索」与「统计」之间那一层内容。
 * 同一张 ops_log、同一类判据（D-362 数动作，不评水平）：
 * 它回答「我刚才在查什么」，不回答「我查得怎么样」。
 *
 * ★★ I-144（真机 2026-09-07）· **这里只列词与短语。**
 *
 * 真机上出现了 159 / 281 字符的**整段**（Reddit 的一段正文）躺在「最近查过」里 ——
 * 气泡那侧把每一次 lookup 都以 `a.term` 记账、不看形态（成因与修法见
 * `engine/main.ts` 的 `lookup` 那一段）。写入侧修好之后，**库里那几行还在**。
 *
 * ★ 为什么**不去删**那几行：`ops_log` 在 `SYNC_TABLES` 里 —— 删它要走删除三档
 *   （D-435）、不许裸 `delete`（D-436），而且会传到电脑那边。而这些行记的是
 *   **他真的做过的动作**（他确实选中了那一段），删掉是在改他的流水。
 *   「最近查过」承诺的是「词」，那就**在读的时候只给词** —— 既有脏行当场不再出现，
 *   一行同步数据都不用动。
 *
 * ★ 多取一些再筛：形态判据是 `shapeOf`（JS），SQL 里没有。取 `limit` 的十倍
 *   （至少 50 行）再挑，够真机那个量级；真被整段淹没时最坏是少列几个，不出错。
 */
export async function recentLookups(db: Db, limit = 3): Promise<RecentLookup[]> {
  const rows = await db.all(
    `select title as w, max(created_at) as at, count(*) as n from ops_log
      where op = 'lookup' and title is not null and title <> ''
      group by title order by at desc limit ?`,
    [Math.max(limit * 10, 50)]
  )
  return rows
    .map((r) => ({ word: String(r['w']), at: Number(r['at']), n: Number(r['n']) }))
    .filter((r) => RECENT_SHAPES.includes(shapeOf(r.word)))
    .slice(0, limit)
}

/** 「最近查过」认哪几种形态 —— 整句 / 整段不是「查过的词」 */
const RECENT_SHAPES: readonly SelShape[] = ['word', 'phrase']

export interface LookupDay {
  /** 当天 0 点（本地时区）时间戳 */
  day: number
  looked: number
  saved: number
}

/**
 * 近 n 天逐日行为计数（第十一则指令 · Lookup 数据区）——
 * 真数据：ops_log 的 lookup（Tab 搜索 + 气泡选词都记）与 capture。
 * D-362 判据不变：数动作，不评水平。
 */
export async function lookupDays(db: Db, n = 7): Promise<LookupDay[]> {
  const t0 = new Date()
  t0.setHours(0, 0, 0, 0)
  const start = t0.getTime() - (n - 1) * 86_400_000
  const rows = await db.all(
    `select op, created_at from ops_log where op in ('lookup','capture') and created_at >= ?`,
    [start]
  )
  const days: LookupDay[] = Array.from({ length: n }, (_, i) => ({
    day: start + i * 86_400_000,
    looked: 0,
    saved: 0
  }))
  for (const r of rows) {
    const i = Math.floor((Number(r['created_at']) - start) / 86_400_000)
    if (i < 0 || i >= n) continue
    if (String(r['op']) === 'lookup') days[i]!.looked++
    else days[i]!.saved++
  }
  return days
}
