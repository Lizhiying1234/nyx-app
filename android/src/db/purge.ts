/**
 * 回收站 · 到期清除（D-087 ·「打开即清」是契约行为，两端同一规则）。
 * ★ 保留多少天**只有 core 一份**（`TRASH_DAYS`，使用者 2026-09-13 从 30 改成 10）——
 *   这里不复述那个数字，复述的那一刻它就开始漂。
 *
 * **判据只有一份**：扫哪些表 + 保留几天 = `core/sql/trash.ts` direct import
 * （F-017 · 2026-09-01 上提；此前 Windows `browse.ts::purgeExpired` 一份、
 * 这里一份）。级联怎么删 = `core/cascade.hardDelete`（同步引擎的墓碑执行
 * 也走它）。这个文件只剩装配。
 *
 * ★ 清单必须只有一份的理由比别处更硬：这一步会**写墓碑**，
 *   而墓碑随同步推出去不可撤销。两端清单不同 = 一端推出的删除，
 *   另一端根本不认为那张表归回收站管，却照单执行了。
 * 墓碑（tombstones 表）由 cascade 写 —— 清除会随同步走到另一端。
 * ★ 到期清除不进 term_ledger（Windows 同口径：'purged' 判决只属
 *   使用者亲手的「彻底删除」，那个动作手机不给 D-359）。
 * ★ 与 Windows 唯一差别：返回清了几行 —— 界面要如实说一句。
 *
 * ★★ F-015（2026-09-01）· **动手之前先问一句本机时钟对不对。**
 *   闸在 `core/purge-guard.ts`（两端同一份），参照是同步时见过的最大远端
 *   时间戳（`sync.maxRemoteSeen`，由引擎落盘）。时钟被调快的那一刻，
 *   这个函数会把**还没到期**的东西当场删掉、立碑、推出去，两端都没了。
 *   拒绝的后果只是「这次没清」—— 安全的方向是不删。
 */
import {
  decodeProblems,
  encodeProblems,
  hardDelete,
  purgeAllowed,
  purgeMany as corePurgeMany,
  PURGE_TABLES,
  SYNC_PROBLEM_KEY,
  TRASH_DAYS,
  type PurgeKind,
  type PurgeLedger
} from '../core-link.ts'
import * as ledger from './ledger.ts'
import type { Db } from './types.ts'

export { TRASH_DAYS }

export interface PurgeResult {
  /** 真清掉了几行（含级联） */
  purged: number
  /** 没清的话，为什么 —— 直接是给人看的一句话；清了就是 null */
  skipped: string | null
}

/** 时钟参照：同步引擎落盘的「见过的最大远端时间戳」 */
async function maxRemoteSeen(db: Db): Promise<number> {
  const r = await db.get(`select value from settings where key = 'sync.maxRemoteSeen'`)
  return Number(r?.['value'] ?? 0) || 0
}

/**
 * 留痕不弹窗（同 R-4-D）—— 合并进已有的那份，别把同步记的账冲掉。
 * 记不上账是小事，把「打开回收站」这个动作带崩是大事。
 */
async function noteProblem(db: Db, what: string, message: string): Promise<void> {
  try {
    const r = await db.get(`select value from settings where key = ?`, [SYNC_PROBLEM_KEY])
    const had = decodeProblems(String(r?.['value'] ?? '') || null)?.problems ?? []
    const value = encodeProblems([{ kind: 'row', what, message }, ...had])
    if (value === null) return
    await db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [SYNC_PROBLEM_KEY, value, Date.now()]
    )
  } catch {
    /* 见上 */
  }
}

export async function purgeExpired(
  db: Db,
  cutoff = Date.now() - TRASH_DAYS * 86_400_000
): Promise<PurgeResult> {
  const verdict = purgeAllowed({ now: Date.now(), maxRemoteSeen: await maxRemoteSeen(db) })
  if (!verdict.ok) {
    await noteProblem(db, '回收站清理', verdict.why!)
    return { purged: 0, skipped: verdict.why }
  }

  let purged = 0
  await db.begin()
  try {
    for (const t of PURGE_TABLES) {
      const cols = (await db.all(`pragma table_info("${t}")`)) as { name: string }[]
      if (!cols.some((c) => c.name === 'deleted_at')) continue
      const rows = await db.all(`select id from "${t}" where deleted_at is not null and deleted_at < ?`, [
        cutoff
      ])
      if (rows.length === 0) continue
      const counted = await hardDelete(
        db,
        t,
        rows.map((r) => Number(r['id']))
      )
      purged += Object.values(counted).reduce((a, b) => a + b, 0)
    }
    await db.commit()
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
  return { purged, skipped: null }
}

/**
 * 立刻彻底删除 —— **④（2026-09-01 使用者裁定）**
 *
 * 原话：「删除必须是真正删除，不能只是表面隐藏、软删除后仍然存在。」
 * 问过之后定的是**这一种**：「删除」仍是三层（确认框 → Snackbar 撤销 →
 * 进回收站等 `TRASH_DAYS` 天，D-412 / D-087 不动），但**进了回收站之后可以真正删干净**。
 *
 * ★★ 这修订了 D-359 的半条 —— 它原写「硬删仍不给（彻底删除只在电脑上）」。
 *    现在两端一样：手机也能在回收站里彻底删。**保护的那一半原样保留** ——
 *    正常的删除仍然可撤销，彻底删除只在回收站里、且要再确认一次。
 *
 * ★ 编排在 `core/purge.ts`（两端唯一一份，两条学费很贵的规矩写在那个文件头：
 *   D-091 只删它独占的 · I-119 材料与文件不牵连知识点）。
 *   这里只做三件平台的事：事务、ledger 适配、如实返回删了几项。
 *
 * ★ 同步上的老实话（同 Windows）：这一步**只删本机**。别的设备还没同步过这几行的话，
 *   之后可能把它们（仍是已删状态）再推回来，于是又出现在回收站里 ——
 *   到期照样会被清掉，不会回到正常库。
 */
export async function purgeNow(
  db: Db,
  picks: { kind: PurgeKind; id: number }[]
): Promise<number> {
  const led: PurgeLedger = {
    op: (name, target, id, note, counted) => ledger.op(db, name, target, id, note, counted),
    noteMany: (terms, verdict, meta) => ledger.noteMany(db, terms, verdict, { note: meta.note })
  }
  await db.begin()
  try {
    const n = await corePurgeMany(db, picks, led)
    await db.commit()
    return n
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
}
