/**
 * B′ 的本体 —— **bootstrap + 重建 + 本地保全**（D-297）。
 *
 * ══ 核心原则 ★★★ ═══════════════════════════════════════════
 *
 *   升级安全性不能依赖联网。
 *   未同步的学习状态必须通过本地保全保证不丢。
 *
 * 这不是「为了网络方便」的方案 —— 它要否掉的正是「先联网传上去才准升级」
 * 那种形状。下面这段代码**一次网络都不碰**，这是有意的、也是它的全部意义。
 * pending-upload drain 不在这里出现：它是升级**之后**的告警，不是闸。
 *
 * ══ 形态 = M1（同库单事务重建）══════════════════════════════
 *
 * 2026-08-25 真机验证（`tools/db-probe/results-v34/M1-transaction.md`）证明：
 * 事务能撤销 DDL、`user_version` 参与事务、中途失败之后旧库逐项原样。
 * 所以**不需要任何文件级操作** —— 少一个依赖、少一处平台差异、
 * 少一类「文件替换到一半掉电」的失败形态。
 *
 * 那次验证同时钉下三条硬约束，代码里都有对应的机器检查（见 `audit-db.ts`）：
 *
 *   ① `pragma foreign_keys = OFF` 必须在 `BEGIN` **之前** —— 事务内设它是 no-op
 *   ② `pragma user_version` 在事务**之内**设置 —— 它参与回滚
 *   ③ 导回必须 **SQL-to-SQL**，不把整表数据搬进 JS 内存
 */
import { splitSql, afterWipe, type SyncMetaSnapshot } from '../core-link.ts'
import {
  ALL_PRESERVED_KEYS,
  PRESERVED_TABLES,
  SYNC_META_KEYS,
  digestOf,
  inRestoreOrder,
  keepName,
  names,
  readSettings,
  restoreTable,
  type SettingsSnapshot,
  type TableDigest
} from './preserve.ts'
import { selfCheck } from './selfcheck.ts'
import { UpgradeFailed, type Db, type UpgradeResult } from './types.ts'

export interface UpgradeDeps {
  /** 目标结构版本（= `schema/vNN.sql` 的 NN） */
  targetVersion: number
  /** 目标结构的原文。**一个字都不许在这里改** */
  schemaSql: string
  /** 这一次升级的时刻 */
  now: number
  /**
   * 保全哪些表。**默认 = D-297 裁决的 `PRESERVED_TABLES`。**
   *
   * 之所以是参数而不是写死：`review_logs` / `reading_cards` 的 `item_id`
   * 指向 `items` 的**本机自增 id**，只保这两张会留下外键孤儿（自检会拦）。
   * 把它做成参数，是为了让「改成全量保全」是一次裁决 + 一行配置，
   * 而不是一次重写。**判据本身仍然只有这一份**，平台层不许自己传别的。
   */
  preserveTables?: readonly string[]
}

const userVersion = async (db: Db): Promise<number> =>
  Number((await db.get(`pragma user_version`))?.['user_version'] ?? 0)

/** 库里有没有东西（`sqlite_%` 是 SQLite 自己的，不算） */
async function objectCount(db: Db): Promise<number> {
  const r = await db.get(
    `select count(*) as n from sqlite_master where name not like 'sqlite_%'`
  )
  return Number(r?.['n'] ?? 0)
}

/**
 * 建库 —— 把目标结构原样执行一遍。
 *
 * ★ 必须走 `core/sql-split.ts` 切好之后逐条 `run`，
 *   **不许把整份 SQL 交给插件的 `execute()`** —— A-1：
 *   它自带的切分器会把双语句触发器切碎，建库当场失败。
 */
/**
 * 一句 SQL 是不是在建触发器。
 *
 * ★★ 为什么要分出来 ★★★（2026-08-25 实测，不是推理）
 *
 * 目标结构里有**会自己写数据**的触发器 —— 比如 V34 的
 * `trg_items_reading_card`：往 `items` 插一行，它就顺手建一张认读卡。
 *
 * 导回的时候这就致命了：先导 `items`，触发器给每条知识点新建一张卡，
 * 再导 `reading_cards` 时一头撞上 —— `UNIQUE constraint failed:
 * reading_cards.id`。整趟升级在 `restore` 那一步失败。
 *
 * 所以顺序必须是：**建表建索引 → 导回 → 最后才建触发器。**
 * 导回搬的是旧库里已经成型的数据，它不需要、也不该被触发器再加工一遍。
 */
const isTriggerStmt = (s: string): boolean =>
  /^\s*create\s+(temp\s+|temporary\s+)?trigger\s/i.test(s)

async function applySchema(
  db: Db,
  sql: string,
  which: 'all' | 'no-triggers' | 'triggers-only' = 'all'
): Promise<number> {
  const stmts = splitSql(sql).filter((s) =>
    which === 'all' ? true : which === 'triggers-only' ? isTriggerStmt(s) : !isTriggerStmt(s)
  )
  for (const [i, s] of stmts.entries()) {
    try {
      await db.exec(s)
    } catch (e) {
      throw new Error(
        `建库第 ${i + 1}/${stmts.length} 条失败：${(e as Error)?.message ?? e}\n${s.slice(0, 200)}`
      )
    }
  }
  return stmts.length
}

/**
 * 空库 → 直接按目标结构建起来（D-297 第一节）。
 *
 * 不重放历史 migration。Gate 2 已在真机上证明这条路成立。
 */
async function bootstrap(db: Db, deps: UpgradeDeps): Promise<UpgradeResult> {
  const n = await objectCount(db)
  if (n > 0) {
    // 探针那次的教训：在残留上建库，会死在第 2 条 CREATE TABLE 上，
    // 报一句看不出根因的 "already exists"
    throw new UpgradeFailed(`拒绝在残留上建库：库里还有 ${n} 个对象`, 'bootstrap', true)
  }
  await db.exec(`pragma foreign_keys = OFF`) // ★ 约束①：在 BEGIN 之前
  try {
    await db.begin()
    const stmts = await applySchema(db, deps.schemaSql)
    await db.exec(`pragma user_version = ${deps.targetVersion}`) // ★ 约束②：在事务内
    await db.commit()
    await db.exec(`pragma foreign_keys = ON`)
    return {
      action: 'bootstrap',
      fromVersion: 0,
      toVersion: deps.targetVersion,
      preserved: { rows: {}, settings: 0 },
      builtinsPending: true,
      notes: [`建库 ${stmts} 条`]
    }
  } catch (e) {
    await db.rollback().catch(() => {})
    await db.exec(`pragma foreign_keys = ON`).catch(() => {})
    throw new UpgradeFailed(`建库失败：${(e as Error)?.message ?? e}`, 'bootstrap', true)
  }
}

/**
 * 有数据的旧库 → 保全 + 重建 + 导回。
 *
 * 七步的顺序不是随手排的，每一步都在下一步的前提里：
 *
 *   ① 前置检查   已经是目标版本就什么都不做
 *   ② 本地保全   读 settings + 各表汇总（**只读汇总，不读行**）
 *   ③ 关外键     ★ 必须在 BEGIN 之前
 *   ④ BEGIN
 *   ⑤ 重建       删对象 → 保全表改名 → 其余全删 → 执行目标结构
 *                → SQL-to-SQL 导回 → 丢弃 _keep_ → 恢复 settings
 *                → 写 user_version
 *   ⑥ 自检       ★ 在 COMMIT 之前。不过就抛
 *   ⑦ COMMIT / 出任何事 ROLLBACK，旧库原样
 */
async function rebuild(db: Db, deps: UpgradeDeps, from: number): Promise<UpgradeResult> {
  // ★ 排成父在子前 —— 导回顺序在这里定死，平台层不许自己排
  const keepAll: readonly string[] = inRestoreOrder(deps.preserveTables ?? PRESERVED_TABLES)

  let settingsBefore: SettingsSnapshot = {}
  const before: Record<string, TableDigest> = {}

  let step = 'preserve'
  try {
    /**
     * ── ①.5 清单里的表，**源库**里未必都有 ★★（2026-08-29 真机实测）──
     *
     * 把使用者真库（v33）的副本推进手机：升级在 preserve 第一步就炸 ——
     * `digestOf("reading_cards")`，而 v33 里**根本没有这张表**（V34 才拆出来）。
     *
     * ★ 这不只是「推旧库副本」的开发路径：**将来任何一版新增同步表，
     *   手机端的升级都会走到这里**（清单 = 全部同步表，永远比旧库新）。
     *
     * 处理：源库里没有的表按**零行**保全 —— 新结构把它建出来、里面是空的，
     * 内容之后由同步带来。★ 若某一版的新表需要从旧数据**算出来**（backfill），
     * 那属「数据层面的转换」，按 P2-1 的既有立场由那一版单独处理，这里不猜。
     */
    const present = new Set(
      names(
        await db.all(
          `select name from sqlite_master where type='table' and name not like 'sqlite_%'`
        )
      )
    )
    const keep: readonly string[] = keepAll.filter((t) => present.has(t))
    const absent: readonly string[] = keepAll.filter((t) => !present.has(t))

    // ── ② 本地保全（全程不碰网络）──────────────────────────
    settingsBefore = await readSettings(db)
    for (const t of keep) before[t] = await digestOf(db, t)

    // ── ③ 关外键 · ★ 必须在 BEGIN 之前（M1-G 真机实测：事务内是 no-op）──
    await db.exec(`pragma foreign_keys = OFF`)

    step = 'begin'
    await db.begin()

    // ── ⑤-1 删掉全部触发器与索引 ──────────────────────────
    // 不删的话，执行目标结构时会撞同名对象
    step = 'drop-objects'
    const objs = await db.all(
      `select type, name from sqlite_master
        where type in ('trigger','index') and name not like 'sqlite_%'`
    )
    for (const o of objs) {
      await db.exec(`drop ${String(o['type'])} if exists "${String(o['name'])}"`)
    }

    // ── ⑤-2 要保全的表改名到一边（数据从不离开 SQLite）★约束③ ──
    step = 'rename-aside'
    for (const t of keep) {
      await db.exec(`alter table "${t}" rename to "${keepName(t)}"`)
    }

    // ── ⑤-3 其余表全删 ────────────────────────────────────
    step = 'drop-tables'
    const rest = names(
      await db.all(
        `select name from sqlite_master where type='table'
          and name not like 'sqlite_%' and name not like '${keepName('')}%'`
      )
    )
    for (const t of rest) await db.exec(`drop table if exists "${t}"`)

    // ── ⑤-4 执行目标结构（原样，一个字不改）★ 但先不建触发器 ──
    //
    // 见 `isTriggerStmt` 的注释：触发器会在导回时自己写数据，
    // 把导回撞成 UNIQUE 冲突。它们留到导完再建。
    step = 'apply-schema'
    const stmtsA = await applySchema(db, deps.schemaSql, 'no-triggers')

    // ── ⑤-5 SQL-to-SQL 导回 ★约束③ ────────────────────────
    //
    // 顺序 = `SYNC_TABLES` 的顺序（core 那一份，父在子前），
    // 这样导子表时父行已经在位，外键与唯一约束都成立。
    step = 'restore'
    for (const t of keep) await restoreTable(db, t)

    // ── ⑤-5b 数据到位之后再建触发器 ────────────────────────
    step = 'apply-triggers'
    const stmtsB = await applySchema(db, deps.schemaSql, 'triggers-only')
    const stmts = stmtsA + stmtsB

    // ── ⑤-6 丢弃 _keep_ ───────────────────────────────────
    step = 'drop-keep'
    for (const t of keep) await db.exec(`drop table "${keepName(t)}"`)

    // ── ⑤-7 恢复 settings ─────────────────────────────────
    //
    // 设备配置与密钥：原样写回
    // 同步元数据：**判据不在这里** —— 调 core/sync-metadata.ts::afterWipe()
    step = 'restore-settings'
    const meta = afterWipe(
      Object.fromEntries(
        SYNC_META_KEYS.map((k) => [k, settingsBefore[k] ?? null])
      ) as SyncMetaSnapshot,
      deps.now
    )
    let wrote = 0
    for (const k of ALL_PRESERVED_KEYS) {
      const isMeta = (SYNC_META_KEYS as readonly string[]).includes(k)
      const v = isMeta ? meta[k as keyof typeof meta] : settingsBefore[k]
      if (v === null || v === undefined) continue
      // `afterWipe` 明说：device 读不到时返回空串 —— 空串就**不要写**，
      // 让同步层照常去生成一个新编号（那台机器本来就还没同步过）。
      // ★★ 但这条只适用于**同步元数据**。设备配置与密钥要**逐字**恢复，
      //    空串也是值 —— 2026-08-29 真机实测：使用者真库里 `sync.user`
      //    就是 ''，一刀切跳过会让自检报「sync.user 丢了」，整趟回滚。
      if (isMeta && v === '') continue
      await db.run(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [k, String(v), deps.now]
      )
      wrote++
    }

    // ── ⑤-8 写版本 · ★约束②：在事务之内 ──────────────────
    step = 'user-version'
    await db.exec(`pragma user_version = ${deps.targetVersion}`)

    // ── ⑥ 自检 · ★ 在 COMMIT 之前 ─────────────────────────
    step = 'selfcheck'
    const bad = await selfCheck(db, {
      targetVersion: deps.targetVersion,
      before,
      settingsBefore,
      now: deps.now,
      tables: keep
    })
    if (bad.length > 0) throw new Error(bad.join('\n  · '))

    // ── ⑦ 成功 ────────────────────────────────────────────
    await db.commit()
    await db.exec(`pragma foreign_keys = ON`)

    return {
      action: 'rebuild',
      fromVersion: from,
      toVersion: deps.targetVersion,
      preserved: {
        rows: Object.fromEntries(keep.map((t) => [t, before[t]!.n])),
        settings: wrote
      },
      builtinsPending: true,
      notes: [
        `建库 ${stmts} 条`,
        `保全 ${keep.map((t) => `${t} ${before[t]!.n} 行`).join(' · ')}`,
        // ★ 缺表要说出来，不许静默 —— 「悄悄少了一类数据」正是最难发现的坏法
        ...(absent.length > 0
          ? [`源库（v${from}）里还没有：${absent.join('、')} —— 已按空表建出，内容等同步补`]
          : []),
        '同步状态表有意留空 —— 保全下来的行全部回到待推（V31：宁可重推，不可错标已同步）'
      ]
    }
  } catch (e) {
    // ── ⑦ 失败 → 旧库原样 ─────────────────────────────────
    await db.rollback().catch(() => {})
    await db.exec(`pragma foreign_keys = ON`).catch(() => {})
    throw new UpgradeFailed(
      `升级失败（${step}）：${(e as Error)?.message ?? e}`,
      step,
      /* oldDbIntact */ true
    )
  }
}

/**
 * 入口。空库走 bootstrap，有数据走 rebuild，已经是目标版本就什么都不做。
 *
 * **全程不需要网络。云端可不可达与这里无关。**
 */
export async function upgrade(db: Db, deps: UpgradeDeps): Promise<UpgradeResult> {
  const from = await userVersion(db)
  if (from === deps.targetVersion) {
    return {
      action: 'noop',
      fromVersion: from,
      toVersion: from,
      preserved: { rows: {}, settings: 0 },
      builtinsPending: false,
      notes: ['已经是目标版本']
    }
  }
  const objs = await objectCount(db)
  return objs === 0 ? bootstrap(db, deps) : rebuild(db, deps, from)
}
