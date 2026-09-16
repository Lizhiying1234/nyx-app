/**
 * USER 偏好 · 读 + 写（写入面 2026-08-30 补齐，阶段 6 AI 设置要用）。
 *
 * ★★ 存放处是 **`user_preferences`**（同步表 —— 跟着使用者走），
 *   不是 `settings`（那张纯本机：sync.* / 设备面）。
 *   白名单与键说明在 core/prefs.ts::PREF_SPECS。
 * ★ 写入的三道关卡（键在不在白名单 · 值合不合法 · uid 怎么算）**判据全在 core**，
 *   这里只是把它们接起来 —— 与 Windows `main/db/prefs.ts::set` 逐字同源。
 */
import { checkPrefKey, checkPrefValue, prefUid } from '../core-link.ts'
import type { Db } from './types.ts'

export async function prefRaw(db: Db, key: string): Promise<string | null> {
  const r = await db.get(`select value from user_preferences where key = ?`, [key])
  return r?.['value'] != null ? String(r['value']) : null
}

/**
 * 一次把几把键读进内存，交出一个**同步**读函数。
 *
 * 为什么要这个桥：core 里那几个「从偏好算出配置」的判据
 * （`readingRulesOf` / `practiceRulesOf` / `readingQTypeOf` / `practiceFaceOf`）
 * 收的是 `(key) => string | null` —— **同步**的，因为 Windows 那侧 `better-sqlite3`
 * 本来就是同步的。手机这侧每次读库都是 `await`，接不上。
 *
 * ★★★ 解决的办法是**预读**，不是在 Android 再写一份异步版的判据。
 *   再写一份的话，「没设过该回哪个出厂值」「认不出的值怎么办」就有了两个答案，
 *   而两边都说得通、都不报错 —— 同一份偏好在电脑和手机上算出不同的考法。
 */
export async function prefReader(
  db: Db,
  keys: readonly string[]
): Promise<(key: string) => string | null> {
  if (keys.length === 0) return () => null
  const rows = (await db.all(
    `select key, value from user_preferences where key in (${keys.map(() => '?').join(',')})`,
    [...keys]
  )) as { key: string; value: unknown }[]
  const map = new Map(rows.map((r) => [String(r.key), r.value != null ? String(r.value) : null]))
  return (key: string) => map.get(key) ?? null
}

export async function prefNumber(db: Db, key: string, fallback: number): Promise<number> {
  const v = await prefRaw(db, key)
  if (v === null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 写一项偏好。键不在白名单、或值不合法 → 抛（不静默吞：偏好表里不许出现
 * 清单之外的键，那是自检会报的事）。
 */
export async function prefSet(db: Db, key: string, value: string): Promise<void> {
  const k = checkPrefKey(key)
  if (!k.ok) throw new Error(k.why)
  const v = checkPrefValue(key, value)
  if (!v.ok) throw new Error(v.why)
  const t = Date.now()
  await db.run(
    `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)
       on conflict(uid) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [prefUid(key), key, v.value, t, t]
  )
}
