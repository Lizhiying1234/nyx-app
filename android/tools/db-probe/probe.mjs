/**
 * Android 数据库准入探针 · 纯逻辑（D-270 第 6 条）
 *
 * ══ 它回答什么 ═══════════════════════════════════════════════
 *
 *   把 Windows 的 `schema/vNN.sql` 拿到**真 Android 设备**上建库，
 *   得到的同步表面与 Windows 基线是不是同一个？
 *
 * 不是，手机第一次同步就会被整包拒绝（D-269 的设计如此）——
 * 而那是在他装好、配好、练了一周之后才会发现的事。
 *
 * ══ 为什么依赖是注入的 ★★ ════════════════════════════════════
 *
 * 这个文件**不 import 任何东西**。判据（`SYNC_TABLES` / `normalizeSchema`）
 * 由调用方从 **Windows 仓库的 `src/core/`** 传进来 ——
 * 探针自己带一份 = 第二份真相 = 这个项目的头号事故形态。
 *
 * 驱动也是注入的：只要给得出 `query(sql, params?) -> rows[]` 就能跑。
 * `node:sqlite` / `@capacitor-community/sqlite` / Android 原生，都满足。
 */

/** 允许两端不同的 pragma —— 平台差异，不参与判定 */
export const MAY_DIFFER = [
  'sqlite_version',
  'page_size',
  'encoding',
  'auto_vacuum',
  'temp_store',
  'locking_mode',
  'busy_timeout',
  'journal_mode',
  'cache_size',
  'synchronous'
]

/** 必须一致或必须是某个值 —— 不一致就是 FAIL */
export const MUST_MATCH = ['user_version', 'syncTableCount', 'syncTables', 'fingerprint']
export const MUST_BE = { foreign_keys: 1, integrity_check: 'ok' }

/**
 * 跑一次探测。
 *
 * @param query  (sql, params?) => rows[]   —— 唯一需要平台提供的东西
 * @param deps   { SYNC_TABLES, normalizeSchema, readSyncSurface, sha256 }
 *               全部来自 Windows 仓库的 core（sha256 除外，那是平台的）
 */
export async function probe(query, deps) {
  const { SYNC_TABLES, normalizeSchema, readSyncSurface, sha256 } = deps
  const one = (sql) => {
    try {
      const r = query(sql)
      return r && r.length ? Object.values(r[0])[0] : null
    } catch (e) {
      return `ERR:${String(e && e.message).slice(0, 60)}`
    }
  }

  // ── 平台信息（只报告，多数不参与判定）──────────────────────
  const platform = {}
  // ★ sqlite_version 不是 pragma，是函数 —— 这一处踩过，留个记号
  platform.sqlite_version = one(`select sqlite_version()`)
  for (const p of MAY_DIFFER) {
    if (p === "sqlite_version") continue
    platform[p] = one(`pragma ${p}`)
  }
  for (const p of Object.keys(MUST_BE)) platform[p] = one(`pragma ${p}`)

  // ── 同步表面 ──────────────────────────────────────────────
  // readSyncSurface 只要一个可等待的 `all(sql, params)`（core 2026-08-29 起的读器接口），这里包一层适配
  // ★ 2026-09-04 T-1.3 顺手修：此前包的是 `prepare(sql).all()` 的旧形状，探针从 v33 之后没再跑过，早就脱节了
  const db = { all: (sql, params) => query(sql, params) }
  const tables = await readSyncSurface(db)
  const normalized = normalizeSchema(tables)

  const present = tables.map((t) => t.name).sort()
  const missing = SYNC_TABLES.filter((t) => !present.includes(t))

  return {
    platform,
    userVersion: Number(one('pragma user_version')),
    syncTableCount: tables.length,
    syncTables: present,
    missingTables: missing,
    normalized,
    normalizedBytes: normalized.length,
    fingerprint: sha256(normalized).slice(0, 16),
    triggerCount: tables.reduce((n, t) => n + t.triggers.length, 0),
    columnCount: tables.reduce((n, t) => n + t.columns.length, 0),
    fkCount: tables.reduce((n, t) => n + t.fks.length, 0)
  }
}

/**
 * 与 Windows 基线比对，给出 PASS / FAIL 与逐条差异。
 *
 * ★ 判据的分层是 D-269 定的：**只比同步表面**。
 *   SQLite 版本、journal 模式、页大小这些是平台的事，不比。
 */
export function compare(got, baseline) {
  const problems = []
  const notes = []

  if (got.userVersion !== baseline.userVersion) {
    problems.push(`user_version：Windows ${baseline.userVersion}，这台 ${got.userVersion}`)
  }
  if (got.missingTables.length) {
    problems.push(`少了 ${got.missingTables.length} 张同步表：${got.missingTables.join(' ')}`)
  }
  if (got.syncTableCount !== baseline.syncTableCount) {
    problems.push(`同步表数：Windows ${baseline.syncTableCount}，这台 ${got.syncTableCount}`)
  }
  if (got.fingerprint !== baseline.fingerprint) {
    problems.push(`★★★ 指纹不一致：Windows ${baseline.fingerprint}，这台 ${got.fingerprint}`)
    // 逐行找出差在哪 —— 只有这样才知道是「少一条触发器」还是「类型写法不同」
    const a = baseline.normalized.split('\n')
    const b = got.normalized.split('\n')
    for (let i = 0, shown = 0; i < Math.max(a.length, b.length) && shown < 12; i++) {
      if (a[i] !== b[i]) {
        problems.push(`    Windows │ ${a[i] ?? '（没有这一行）'}`)
        problems.push(`    这  台 │ ${b[i] ?? '（没有这一行）'}`)
        shown++
      }
    }
  }
  if (got.platform.foreign_keys !== 1) {
    problems.push(`foreign_keys 不是 1（是 ${got.platform.foreign_keys}）—— 外键没启用，关系不会被约束`)
  }
  if (got.platform.integrity_check !== 'ok') {
    problems.push(`integrity_check = ${got.platform.integrity_check}`)
  }

  for (const k of MAY_DIFFER) {
    if (baseline.platform && baseline.platform[k] !== got.platform[k]) {
      notes.push(`${k}：Windows ${baseline.platform[k]} · 这台 ${got.platform[k]}（允许不同）`)
    }
  }

  return { pass: problems.length === 0, problems, notes }
}
