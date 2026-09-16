import { needsTombstone } from './tombstone.ts'
import { DYNAMIC_RELATIONS } from './fk-map.ts'
import { markCompactPending } from './sync/compact-trigger.ts'

/**
 * 彻底删除时的级联 · 使用者 4.3「垃圾箱中执行彻底删除时出现的异常」
 *
 * ★★ 2026-08-29 · 阶段 3（Android 同步接线）：从 `main/db/cascade.ts` 整体搬进
 *   core 并改成**异步端口**。级联的顺序与范围是判据（写错 = 复活入口 / 外键炸），
 *   同步引擎（applyTombstones）与垃圾箱清除两端都要走它 —— 只能有一份。
 *   语义逐字未动；唯一的形变是 `better-sqlite3` 同步调用 → `CascadeDb` 异步端口。
 *
 * **异常是什么**：`foreign_keys = ON`，而所有外键都没写 `on delete cascade`。
 * 于是 `delete from projects where id = ?` 在 units 还引用着它的时候
 * 直接抛 `FOREIGN KEY constraint failed` —— 界面上就是「彻底删除点了报错」。
 *
 * **为什么不去给外键加 cascade**：那要重建每一张表（SQLite 改不了约束），
 * 而重建表是这个项目里最危险的操作（D-216 · 数据静默丢失）。
 * 删除是低频动作，在删的时候自己按顺序删，代价小得多。
 *
 * **为什么不写死一张「先删这些表」的清单**：清单会烂。
 * 以后加一张引用 items 的新表，没人会想起来回来改这里 ——
 * 表现就是「彻底删除又开始报错了」，而且要查很久。
 * 所以直接问库：`pragma foreign_key_list` 就是权威答案，它不会过时。
 */

/** 级联要用的最小库面 —— 「能查、能删」，读不出平台 */
export interface CascadeDb {
  run(sql: string, params?: readonly unknown[]): Promise<void>
  get(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown> | undefined>
  all(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>
}

interface Ref {
  /** 引用别人的那张表 */
  child: string
  /** 子表里指向父表的那一列 */
  column: string
  /** 被引用的父表 */
  parent: string
}

export async function allRefs(db: CascadeDb): Promise<Ref[]> {
  const tables = (await db.all(
    `select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`
  )) as { name: string }[]
  const out: Ref[] = []
  for (const t of tables) {
    const fks = (await db.all(`pragma foreign_key_list("${t.name}")`)) as unknown as {
      table: string
      from: string
    }[]
    for (const fk of fks) out.push({ child: t.name, column: fk.from, parent: fk.table })
  }
  return out
}

/**
 * 给这一批要删的行立碑 —— ★★ R-3 的**唯一写入口**。
 *
 * 拿的是行**现在**的 uid：删完就查不到了，所以必须在删之前抄下来。
 * 没有 uid 的行（老库里可能有）立不了碑，也没必要 ——
 * 没有 uid 就从来没同步出去过，不存在被复活的问题。
 */
async function writeTombstones(db: CascadeDb, table: string, idList: string): Promise<void> {
  if (!needsTombstone(table)) return
  const t = Date.now()
  /**
   * ★★ R-3-g · `target_id` 也要记。
   *
   * 子行是按 **id** 指向父亲的，光有 uid 认不出它的孩子。
   * 这个数字此刻就在手里（我们正是按 id 在删），不记下来就永远没了。
   */
  await db.run(
    `insert into tombstones (target_uid, kind, target_id, purged_at, created_at, updated_at)
       select uid, ?, id, ?, ?, ? from "${table}" where id in (${idList}) and uid is not null
     on conflict(target_uid, kind) do update set
       target_id  = excluded.target_id,
       purged_at  = excluded.purged_at,
       updated_at = excluded.updated_at`,
    [table, t, t, t]
  )
}

/**
 * ★★ Step 7B · G1 · 基状态跟着实体一起走 —— **删行就忘掉它的基版本**。
 *
 * `row_sync_state` 记的是「这一行我和远端对账到哪一版」。行都没了，
 * 那句话就没有主语了。留着它：① 表只增不减 ② 同一个 uid 再出现
 * （导回旧备份 / 重建）时拿到**上一世代**的基版本 → 合并静默选错边。
 * ② 才是要命的，定期清理挡不住（清理前的窗口里判据就是脏的）——
 * 所以只能跟着实体生命周期同步处理：谁删的行，谁同一个事务里带走基状态。
 *
 * ★ 放在 `hardDelete` 里而不是各个调用点：这里是**唯一的硬删入口**。
 */
async function forgetSyncState(db: CascadeDb, table: string, uids: string[]): Promise<void> {
  if (uids.length === 0) return
  try {
    const marks = uids.map(() => '?').join(',')
    await db.run(`delete from row_sync_state where table_name = ? and uid in (${marks})`, [
      table,
      ...uids
    ])
  } catch {
    /* ★ V31 之前的库没有这张表。忘不掉基状态**不该让删除失败**。 */
  }
}

/** 这张表有 `uid` 列吗（派生子表不一定有） */
async function hasUid(db: CascadeDb, table: string): Promise<boolean> {
  try {
    return ((await db.all(`pragma table_info("${table}")`)) as { name: string }[]).some(
      (c) => c.name === 'uid'
    )
  } catch {
    return false
  }
}

/** 删之前先把这些行的 uid 取出来 —— 删完就问不到了 */
async function uidsWhere(
  db: CascadeDb,
  table: string,
  where: string,
  args: unknown[] = []
): Promise<string[]> {
  if (!(await hasUid(db, table))) return []
  try {
    return ((await db.all(`select uid from "${table}" where ${where}`, args)) as { uid: string }[])
      .map((r) => r.uid)
      .filter((u) => typeof u === 'string')
  } catch {
    return []
  }
}

/** delete 语句跑完删了几行 —— 端口没有 changes 返回值，用 changes() 自查 */
async function deleteCounted(db: CascadeDb, sql: string, args: unknown[] = []): Promise<number> {
  await db.run(sql, args)
  const r = await db.get(`select changes() as n`)
  return Number(r?.['n'] ?? 0)
}

/**
 * 真删一批行，连同所有引用它们的行。
 *
 * 返回每张表删了多少 —— 界面上要能说清「一起删掉了什么」，
 * 因为彻底删除不可撤销，事后再问就晚了。
 *
 * 自引用（`items.derived_from → items`）单独处理：同一张表里的子行先删。
 * 深度设上限只是防御 —— 真出现环，宁可停下报错，也不要在事务里转到天荒地老。
 *
 * ★★ F-2 · `writeTomb` —— 要不要顺手立碑。**应用远端墓碑时必须传 false**：
 *   远端那块碑已经作为普通同步行落库，再立一次会把 `purged_at`/`updated_at`
 *   盖成本机当前时间，刚对完账的碑立刻变成「本地又改过」被推回去。
 */
export async function hardDelete(
  db: CascadeDb,
  table: string,
  ids: number[],
  refs?: Ref[],
  depth = 0,
  writeTomb = true
): Promise<Record<string, number>> {
  const counted: Record<string, number> = {}
  if (ids.length === 0) return counted
  if (depth > 12) throw new Error(`级联删除层数过深（${table}）—— 外键里可能有环，停下来了`)
  const allR = refs ?? (await allRefs(db))

  const list = ids.join(',')

  /**
   * ★★ R-3 · **删之前先立碑，同一个事务。**
   * 删完再立，中间抛错会留下「东西没了、碑也没有」—— 复活的入口。
   * 先立碑再删，墓碑写不进去时实体根本不会被删（整体回滚）。
   * 调用点本来就各自包在事务里，这里不再开一层。
   * **只给六类实体立**（`needsTombstone`）—— 派生子表递归进来一块碑都不写。
   */
  if (writeTomb) await writeTombstones(db, table, list)

  for (const r of allR.filter((x) => x.parent === table)) {
    if (r.child === table) {
      // 自引用：先把指向这些行的同表子行整支删掉
      const kids = (await db.all(`select id from "${table}" where "${r.column}" in (${list})`)) as {
        id: number
      }[]
      const kidIds = kids.map((k) => k.id).filter((k) => !ids.includes(k))
      if (kidIds.length > 0) {
        for (const [t, n] of Object.entries(
          await hardDelete(db, table, kidIds, allR, depth + 1, writeTomb)
        )) {
          counted[t] = (counted[t] ?? 0) + n
        }
      }
      continue
    }
    // 子表自己有没有 id 列？有就递归（它下面可能还挂着东西），没有就直接删
    const cols = (await db.all(`pragma table_info("${r.child}")`)) as { name: string }[]
    if (cols.some((c) => c.name === 'id')) {
      const kids = (await db.all(
        `select id from "${r.child}" where "${r.column}" in (${list})`
      )) as { id: number }[]
      for (const [t, n] of Object.entries(
        await hardDelete(db, r.child, kids.map((k) => k.id), allR, depth + 1, writeTomb)
      )) {
        counted[t] = (counted[t] ?? 0) + n
      }
    } else {
      // ★★ G1 · 先记下要删的 uid，删完就问不到了
      const gone = await uidsWhere(db, r.child, `"${r.column}" in (${list})`)
      const n = await deleteCounted(db, `delete from "${r.child}" where "${r.column}" in (${list})`)
      await forgetSyncState(db, r.child, gone)
      if (n > 0) counted[r.child] = (counted[r.child] ?? 0) + n
    }
  }

  /**
   * ★★ **动态关系也要跟着删**（2026-09-02）。
   *
   * SQL 外键管不到 `picks` 这种「靠同一行的 `scope` 列决定父表」的挂法，
   * 于是彻底删掉一个项目之后，它的选读推荐还活着、还指着那个不存在的项目 ——
   * **每次同步都推不出去、报一条问题**，而那条建议早就没有意义了。
   * 按 D-435「被删除的就当死了」，它本来就该一起走。
   *
   * ★ 只删清单里**明写 `cascade: true`** 的（`DYNAMIC_RELATIONS`）。
   *   `tombstones` 那条是 `false` —— 它指着的正是刚被删的实体，
   *   跟着删等于把刚立的碑自己铲了，删除从此传不出去而且不报错。
   * ★ 判别列的取值不写死：现查一遍再用 `tableOf` 问「它指的是不是这张表」。
   */
  for (const [child, rels] of Object.entries(DYNAMIC_RELATIONS)) {
    for (const rel of rels) {
      if (rel.cascade !== true) continue
      let kinds: { d: unknown }[]
      try {
        kinds = (await db.all(
          `select distinct "${rel.discriminator}" as d from "${child}" where "${rel.column}" in (${list})`
        )) as { d: unknown }[]
      } catch {
        continue // 老库上可能还没这张表
      }
      for (const k of kinds) {
        if (rel.tableOf(k.d) !== table) continue
        const where = `"${rel.column}" in (${list}) and "${rel.discriminator}" = ?`
        const gone = await uidsWhere(db, child, where, [k.d])
        const n = await deleteCounted(db, `delete from "${child}" where ${where}`, [k.d])
        await forgetSyncState(db, child, gone)
        if (n > 0) counted[child] = (counted[child] ?? 0) + n
      }
    }
  }

  // ★★ G1 · 同上：uid 要在删之前取
  const goneHere = await uidsWhere(db, table, `id in (${list})`)
  const n = await deleteCounted(db, `delete from "${table}" where id in (${list})`)
  await forgetSyncState(db, table, goneHere)
  if (n > 0) counted[table] = (counted[table] ?? 0) + n

  /**
   * ★★ T-2.10 · 本机彻底删过东西 —— **记一笔待压实**（D-435 / D-R18 方案 D）。
   *
   * 本地删干净了、碑也会随下一趟同步传出去，可**云端历史包里那份原文谁都没动过**
   * —— 那正是 F-002 的事故形态。下一趟 `run()` 成功之后由触发点（`sync/compact-trigger.ts`）
   * 看见这个标记，压实一次把它折掉。
   *
   * ★ 放在 `hardDelete` 里而不是各个调用点：**这里是唯一的硬删入口**（同 `forgetSyncState`）。
   *   垃圾箱到期清理、界面上的彻底删除、以后新长出来的入口，自动都有，忘不掉。
   * ★ `depth === 0` —— 级联下去的子表是同一个动作的一部分，记一次就够。
   * ★ `writeTomb` —— **应用远端墓碑时是 false**，那是「对面删了、我跟着删」，
   *   不是本机彻底删除：云端那份存量该由**下命令的那台**去清（它自己也记了这一笔）。
   *   两台都记的话，一次删除会换来两份全量快照，另一端要把它们都下一遍。
   * ★ 有东西真被删掉才记：给了一批 id 但一行都没匹配上，云端也就没有对应的存量。
   */
  if (depth === 0 && writeTomb && Object.keys(counted).length > 0) {
    await markCompactPending(db, Date.now())
  }
  return counted
}
