/**
 * 升级的**完整自检** —— D-297 第四节。
 *
 * ══ 它在事务里跑 ★★★ ════════════════════════════════════════
 *
 * 自检**必须在 COMMIT 之前**。任何一项不过就抛，外层 ROLLBACK，
 * 旧库原样 —— 这是 B′ 的硬保证之一。
 * 自检跑在 COMMIT 之后就只剩「报出来」，救不回来了。
 *
 * ══ 这里**不重新定义结构判据** ══════════════════════════════
 *
 * 「schema/vNN.sql 建出来的结构对不对」由 Gate 2 在真机上验（指纹握手），
 * 那是唯一一份判据。升级器的职责不同 —— 它要证明的是**另外两件事**：
 *
 *   ① 没留下垃圾（改名到一边的表、上一版的触发器/索引）
 *   ② 没丢数据（保全的行一行不少、一个字不差）
 *
 * 所以下面不会出现第二个「规范化结构再哈希一遍」。那会变成两份判据。
 */
import { verifyAfterWipe, type SyncMetaSnapshot } from '../core-link.ts'
import {
  ALL_PRESERVED_KEYS,
  DISCARDED_TABLES,
  KEEP_PREFIX,
  PRESERVED_DEVICE_KEYS,
  PRESERVED_SECRET_KEYS,
  PRESERVED_TABLES,
  SYNC_META_KEYS,
  digestDiff,
  digestOf,
  names,
  readSettings,
  type SettingsSnapshot,
  type TableDigest
} from './preserve.ts'
import type { Db } from './types.ts'

export interface SelfCheckInput {
  targetVersion: number
  /** 动手之前各表的汇总 */
  before: Record<string, TableDigest>
  /** 动手之前读到的 settings */
  settingsBefore: SettingsSnapshot
  /** 这一次升级的时刻（`afterWipe` 要用） */
  now: number
  /** 这一趟保全了哪些表。不传就是裁决的默认清单 */
  tables?: readonly string[]
}

/** 每一项都返回一句人话；空数组 = 全过 */
export async function selfCheck(db: Db, input: SelfCheckInput): Promise<string[]> {
  const bad: string[] = []
  const one = async (sql: string): Promise<Record<string, unknown> | undefined> => db.get(sql)

  // ── ① 版本 ────────────────────────────────────────────────
  const uv = Number((await one(`pragma user_version`))?.['user_version'] ?? -1)
  if (uv !== input.targetVersion) bad.push(`user_version 是 ${uv}，该是 ${input.targetVersion}`)

  // ── ② 库本身是好的 ────────────────────────────────────────
  const integrity = String((await one(`pragma integrity_check`))?.['integrity_check'] ?? '?')
  if (integrity !== 'ok') bad.push(`integrity_check = ${integrity}`)

  // ── ③ 没留下垃圾 ──────────────────────────────────────────
  const left = names(
    await db.all(
      `select name from sqlite_master where name like '${KEEP_PREFIX}%'`
    )
  )
  if (left.length > 0) bad.push(`改名到一边的表没清掉：${left.join('、')}`)

  // ── ④ 保全的表：一行不少、一个字不差 ──────────────────────
  for (const t of input.tables ?? PRESERVED_TABLES) {
    const now = await digestOf(db, t)
    const diff = digestDiff(input.before[t]!, now)
    if (diff.length > 0) bad.push(`${t} 对不上账 —— ${diff.join('；')}`)
  }

  // ── ⑤ 外键没有孤儿 ★ ──────────────────────────────────────
  //
  // 这一项抓的是「保全下来的行，它的父行还在不在」。
  // 父行没了的话那些行就成了孤儿 —— 而 SQLite 不会自己报，
  // 只有问 `foreign_key_check` 才说得出来。
  const orphans = await db.all(`pragma foreign_key_check`)
  if (orphans.length > 0) {
    const brief = orphans
      .slice(0, 3)
      .map((o) => `${String(o['table'])}→${String(o['parent'])}`)
      .join('、')
    bad.push(`外键有孤儿：${orphans.length} 处（${brief}${orphans.length > 3 ? ' …' : ''}）`)
  }

  // ── ⑥ 有意不保全的，确实是空的 ────────────────────────────
  for (const t of DISCARDED_TABLES) {
    const n = Number((await one(`select count(*) as n from "${t}"`))?.['n'] ?? -1)
    if (n !== 0) bad.push(`${t} 该是空的（V31 原则），实际 ${n} 行`)
  }

  // ── ⑦ settings：设备配置与密钥原样，同步元数据按 afterWipe ──
  const after = await readSettings(db)
  for (const k of [...PRESERVED_DEVICE_KEYS, ...PRESERVED_SECRET_KEYS]) {
    if (input.settingsBefore[k] !== after[k]) {
      bad.push(`${k} 变了：${String(input.settingsBefore[k])} → ${String(after[k])}`)
    }
  }
  const pick = (s: SettingsSnapshot): SyncMetaSnapshot =>
    Object.fromEntries(SYNC_META_KEYS.map((k) => [k, s[k] ?? null])) as SyncMetaSnapshot
  // ★ 判据不在这里写 —— 调 core 那一份
  const wipeProblem = verifyAfterWipe(pick(input.settingsBefore), pick(after), input.now)
  if (wipeProblem) bad.push(`同步元数据：${wipeProblem}`)

  // ── ⑧ 该在的键一个不少 ────────────────────────────────────
  for (const k of ALL_PRESERVED_KEYS) {
    // 动手之前就没有的，之后也可以没有（device 那一条 afterWipe 明说了）
    if (input.settingsBefore[k] !== null && after[k] === null) bad.push(`${k} 丢了`)
  }

  return bad
}
