/**
 * 「彻底删除」的编排 —— **两端唯一的一份**（2026-09-01 上提 core）
 *
 * ── 为什么这一段特别不能有两份 ★★★ ─────────────────────────
 *
 * 这是整个应用里**最不可逆**的操作：真删行 + 写墓碑，而墓碑会随同步走到
 * 另一台机器上，让它照着删。两端各写一份的后果不是「样式不一致」，
 * 是**两台机器对『什么该被永久删掉』的理解不同** ——
 * 一端删了并推出墓碑，另一端照单执行了一个自己永远不会主动发起的删除。
 *
 * 级联判据（`cascade.ts::hardDelete`）本来就在 core；这里上提的是**编排**：
 * 先抄名单 → 记下涉及的知识点 → 级联删 → 收孤儿 → 记账。
 * 那几步里有两条学费很贵的规矩，见下。
 *
 * ── 两条不能忘的规矩 ─────────────────────────────────────
 *
 * ① **D-091 只删它独占的**。知识点不是 lecture 的子表（多对多挂在
 *    `item_lectures` 上），所以级联删 lecture 只会删掉连接行，
 *    **知识点本身留成孤儿**：库里查不到、界面上看不见、备份里还占着地方。
 *    所以删完要回头看一眼，谁一条连接都不剩了，谁才真的没人要了。
 *
 * ② **I-119 材料和文件不牵连知识点**。删一份贴错的原文，不该把已经从别处
 *    学到的东西一起带走 —— 材料是来源，知识点是他学到的东西，两件事。
 *    ★ 漏掉 `material` 的后果不是「少记一笔」，是**记错人**：
 *    它会掉进最后一档 `l.id = ?`，于是**拿材料的 id 当 lecture 的 id** 去查表达，
 *    把那个 lecture 里所有表达写进「不再收录」名单，
 *    从此分析到它们全部自动跳过，**而他完全看不出为什么**。
 */
import { hardDelete, type CascadeDb } from './cascade.ts'
import { IL_ALIVE } from './sql/item-lectures.ts'

export type PurgeKind = 'project' | 'unit' | 'lecture' | 'item' | 'file' | 'material'

const TABLE: Record<PurgeKind, string> = {
  project: 'projects',
  unit: 'units',
  lecture: 'lectures',
  item: 'items',
  file: 'files',
  material: 'materials'
}

/** 记账面 —— 两端各自的 ledger 适配进来，core 不认识平台 */
export interface PurgeLedger {
  /** 一次操作留痕（`purge`） */
  op(name: string, target: string, id: number | null, note: string | null, counted: Record<string, number>): Promise<void>
  /** 给一批表达下判决（`purged` = 以后分析到同一个说法自动跳过） */
  noteMany(terms: string[], verdict: 'purged', meta: { note: string }): Promise<void>
}

/** 这个对象下面涉及哪些知识点（②：文件与材料返回空） */
export async function itemIdsUnder(db: CascadeDb, kind: PurgeKind, id: number): Promise<number[]> {
  if (kind === 'file' || kind === 'material') return []
  if (kind === 'item') return [id]
  const where = kind === 'project' ? 'u.project_id = ?' : kind === 'unit' ? 'u.id = ?' : 'l.id = ?'
  const rows = await db.all(
    `select distinct i.id from items i
       join item_lectures il on il.item_id = i.id
       join lectures l on l.id = il.lecture_id
       join units u on u.id = l.unit_id
      where ${where} and il.deleted_at is null`,
    [id]
  )
  return rows.map((r) => Number(r['id']))
}

/** 这个对象下面涉及哪些表达 —— 记账和撤账都要用同一份名单（②：同上） */
export async function termsUnder(db: CascadeDb, kind: PurgeKind, id: number): Promise<string[]> {
  if (kind === 'file' || kind === 'material') return []
  if (kind === 'item') {
    const r = await db.get(`select term from items where id = ?`, [id])
    return r ? [String(r['term'])] : []
  }
  const where = kind === 'project' ? 'u.project_id = ?' : kind === 'unit' ? 'u.id = ?' : 'l.id = ?'
  const rows = await db.all(
    `select distinct i.term from items i
       join item_lectures il on il.item_id = i.id
       join lectures l on l.id = il.lecture_id
       join units u on u.id = l.unit_id
      where ${where} and il.deleted_at is null`,
    [id]
  )
  return rows.map((r) => String(r['term']))
}

/**
 * 立刻彻底删除（I-075）。**调用方负责事务** —— 两端的事务写法不一样。
 *
 * **同步上的老实话**：这一步只删本机。别的设备如果还没同步过这几行，
 * 之后可能把它们（仍是已删状态）再推回来，于是又出现在回收站里 ——
 * 到 30 天照样会被清掉，不会回到正常库。
 *
 * @returns 他勾选的那几项**各自删掉了几项**的合计（不含连带清掉的孤儿 ——
 *          把孤儿算进去，界面上会说出一个他看不懂的数字）
 */
export async function purgeMany(
  db: CascadeDb,
  picks: { kind: PurgeKind; id: number }[],
  ledger: PurgeLedger
): Promise<number> {
  let n = 0

  // 先把要删的表达抄下来 —— 删完就查不到了
  const terms: string[] = []
  for (const p of picks) terms.push(...(await termsUnder(db, p.kind, p.id)))

  // 先把树下面涉及哪些知识点记下来 —— 级联删完就查不到了（规矩①）
  const touched = new Set<number>()
  for (const p of picks) for (const id of await itemIdsUnder(db, p.kind, p.id)) touched.add(id)

  for (const p of picks) {
    const t = TABLE[p.kind]
    const exists = await db.get(`select 1 as x from "${t}" where id = ? and deleted_at is not null`, [p.id])
    if (!exists) continue
    const counted = await hardDelete(db, t, [p.id])
    n += counted[t] ?? 0
    await ledger.op('purge', p.kind, p.id, null, counted)
  }

  /**
   * 规矩① · 删完之后一条连接都不剩的知识点 —— 没有任何 lecture 还用得着它。
   *
   * ★ **要先确认它还在**（2026-09-01 真机抓到的）：
   *   直接彻底删一条知识点时，它自己既是 pick 也在 `touched` 里。
   *   级联已经把它删掉了，可它的 `item_lectures` 当然也一条不剩 ——
   *   于是又被判成「孤儿」，再删一次（无害的空操作），
   *   但账本上会留下一句 **「1 条无人引用的知识点」**，而那说的就是刚删的那一条。
   *   界面和账本上出现一个他看不懂、也对不上的数字，比少记一笔更坏。
   */
  const orphans: number[] = []
  for (const id of touched) {
    const alive = await db.get(`select 1 as x from items where id = ?`, [id])
    if (!alive) continue
    /**
     * V36 · **软删的收录关系不算数**。
     *   一条知识点被移出 L1（L1 那行软删）之后又赶上 L2 被彻底删掉，
     *   它手里就只剩一条软删的链接 —— 不过滤的话它不算孤儿，会活下来，
     *   但**任何一个讲次里都看不见它**。那是条僵尸，比删掉更糟。
     */
    const r = await db.get(
      `select count(*) as n from item_lectures where item_id = ? and ${IL_ALIVE}`,
      [id]
    )
    if (Number(r?.['n'] ?? 0) === 0) orphans.push(id)
  }
  if (orphans.length > 0) {
    const counted = await hardDelete(db, 'items', orphans)
    await ledger.op('purge', 'item', null, `${orphans.length} 条无人引用的知识点`, counted)
  }

  if (terms.length > 0) await ledger.noteMany(terms, 'purged', { note: '在回收站里彻底删除' })
  return n
}
