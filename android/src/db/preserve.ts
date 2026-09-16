/**
 * **保全范围 —— B′ 的判据，唯一一份。**
 *
 * D-297 第三节逐条列过。这里是它在代码里的样子，
 * 平台层不许再写一份，测试也从这里取。
 *
 * ══ 核心原则（这一条决定了下面每一行）★★★ ══════════════════
 *
 *   升级安全性不能依赖联网。
 *   未同步的学习状态必须通过本地保全保证不丢。
 *
 * 所以这里列的每一样，都必须能在**完全离线**的情况下从旧库读出来、
 * 再写回新库。任何需要「先传上去」的东西都不在这张表上。
 */
import { PRESERVED_SYNC_KEYS, SYNC_TABLES } from '../core-link.ts'
import type { Db, Row } from './types.ts'

/**
 * ★ Android 的**写入面**（D-298）—— 只有这两张表手机会自己写。
 *
 * `review_logs`   Android INSERT 的新行，云端可能一条都还没收到
 * `reading_cards` Android UPDATE 的排期，D-296 之后是独立一张表
 *
 * 它**不是**保全清单 —— 见下面 `PRESERVED_TABLES`。
 * 只保这两张会造成外键错链。
 */
export const ANDROID_WRITE_SURFACE = ['review_logs', 'reading_cards'] as const

/**
 * ★★★ 保全清单 = **全部同步表**。★★★
 *
 * ══ 为什么不是「只保手机自己写的那两张」════════════
 *
 * D-297 最初裁的是只保 `review_logs` + `reading_cards`。**实测跑不通**
 * （2026-08-25，PC U-0 与真机 P-5 同因复现，真机 28 处孤儿）：
 *
 *   这两张表的 `item_id` 存的是 `items` 的**本机自增 id**。
 *   `items` 不在清单里 → 重建后 items 空了 → 保全下来的行全成孤儿。
 *   等同步把 items 拉回来，它们拿到的是**新的本机 id** ——
 *   于是复习记录接到了别的知识点上，**而且不报任何错**。
 *
 * 「那就多保一张 items」补不上：`items` 自己还指向 `lectures` /
 * `materials` / `items`，要补就得补整张内容图。所以清单只有两种取法
 * 是自洽的 —— 全不保，或者全保。全不保等于「升级完手机是空的、
 * 必须联网才能用」，那正是 B′ 要否掉的形状。
 *
 * ══ 这条不违背 B′ 的核心原则，反而是它的落实 ★★ ═══════
 *
 *   升级安全性不能依赖联网。
 *   未同步的学习状态必须通过本地保全保证不丢。
 *
 * 全量保全之后，升级完手机上**内容还在、排期还在、没同步的记录也还在**，
 * 断网也能接着背。这比原方案更贴近那句原则。
 *
 * ══ 代价，已知并接受（P2，进 backlog 不阻塞）══════════
 *
 * 将来某一版如果需要**数据层面的转换**（不只是结构变化），
 * 全量保全会把旧数据原样搬过去而不转换，而 Gate 2 的指纹握手
 * **抓不到**这种漏 —— 它只比结构。那一版要单独处理。
 */
export const PRESERVED_TABLES: readonly string[] = SYNC_TABLES

/**
 * 把一组表按 `SYNC_TABLES` 的顺序排好 —— **父在子前**。
 *
 * 导回顺序不是随便的：子表带着指向父表的外键，父行不在位就插不进去。
 * `core/sync-tables.ts` 里那份顺序已经是拓扑序（Sync 的写入顺序靠它），
 * **这里直接用，不另排一份**。不在那份清单里的表排在最后。
 */
export const inRestoreOrder = (tables: readonly string[]): string[] => {
  const rank = (t: string): number => {
    /**
     * ★ `SYNC_TABLES` 是 `as const`，`indexOf` 的形参因此被收窄成那 31 个字面量，
     *   而这里传进来的是任意表名（可能是 `_keep_*`、也可能是将来新增还没进清单的）。
     *   **「不在清单里」正是这个函数要处理的情况**，不是类型错误 ——
     *   放宽成 `readonly string[]` 再查，语义一个字没变。
     */
    const i = (SYNC_TABLES as readonly string[]).indexOf(t)
    return i < 0 ? SYNC_TABLES.length : i
  }
  return [...tables].sort((a, b) => rank(a) - rank(b))
}

/** 改名到一边时用的前缀。重建期间它们暂时住在这儿 */
export const KEEP_PREFIX = '_keep_'
export const keepName = (t: string): string => `${KEEP_PREFIX}${t}`

/**
 * ★ 必须保全的设备设置（DEVICE）—— 丢了就要重新扫码配置一遍。
 * 是体验问题，不是数据问题，但一样会挨骂。
 */
export const PRESERVED_DEVICE_KEYS = ['sync.kind', 'sync.url', 'sync.user', 'sync.auto'] as const

/**
 * ★ 必须保全的密钥（SECRET）—— 丢了连不上云端。
 *
 * ★★ 2026-09-01 回审（X-Ray 审计 F-012）：**Keystore 已经落地**
 * （`sync-ports.ts` 走 `@aparajita/capacitor-secure-storage`；
 * `core/sync/engine.ts::saveConfig` 只往 `secrets` 端口写）——
 * 新库的 `settings` 表里**根本没有 `sync.secret`**，所以这一项在新库上是空转。
 *
 * 留着的唯一理由：**老库残留**。Keystore 之前的版本确实把它写在 `settings` 里，
 * 那种库升级时还是要把它带过去（带过去也不会被读，但删掉它就真没了）。
 *
 * ★★ **2026-09-02 复核完毕 —— 结论是「留着」，不是「等着删」**（D-220 那笔旧账销账）。
 *   真机实测：他那台的 `settings` 里**一个明文密钥都没有**（33 个键，密钥类 0 个），
 *   所以这一项在**现役库上确实是空转**。
 *   但还是不删，因为两边的代价根本不对称：
 *     · 留着的代价 = 一个字符串，重建时多循环一次找不到的键。**零风险。**
 *     · 删掉的代价 = 万一哪天从 Keystore 之前的备份恢复，这把 key **静默地没了** ——
 *       正是 D-404⑫ 抹掉他真 key 那次的形状（那次也是「看起来该没用了」）。
 *   这个仓库的一贯口径是**宁可安全**（硬删的时钟闸、先立碑再删都是同一条），
 *   一个字符串换掉那条尾巴风险，划算。
 */
export const PRESERVED_SECRET_KEYS = ['sync.secret'] as const

/**
 * ★ 同步元数据**不在这里定义怎么恢复**。
 *
 * 「本地清空之后这几个键该是什么」已经有唯一一份判据：
 * `core/sync-metadata.ts::afterWipe()`（D-273 / F-05）——
 * `sync.device` 不许变 · `wipedAt` 与 `watermark` 只增不减 · `applied` 清空。
 *
 * 重建就是「本地清空 + 恢复」的形状，所以直接调它。**不许在这里重写。**
 */
export const SYNC_META_KEYS = PRESERVED_SYNC_KEYS

/** 读出来要带走的全部 settings 键 */
export const ALL_PRESERVED_KEYS: readonly string[] = [
  ...PRESERVED_DEVICE_KEYS,
  ...PRESERVED_SECRET_KEYS,
  ...SYNC_META_KEYS
]

/**
 * ★ **有意不保全** —— 写下来是为了让下一个人知道这是决定，不是遗漏。
 *
 * `row_sync_state` 整表丢弃（V31 的原则）。丢弃之后，保全下来的业务行
 * **全部回到「待推」**，下次同步自然推上去。
 * **宁可重推（幂等、可恢复），不可错标成已同步（可能永久漏数据）。**
 */
export const DISCARDED_TABLES = ['row_sync_state'] as const

/** 保全下来的 settings：键 → 值 */
export type SettingsSnapshot = Record<string, string | null>

/** 把要保全的 settings 读出来。读不到的键值为 `null` */
export async function readSettings(db: Db): Promise<SettingsSnapshot> {
  const out: SettingsSnapshot = {}
  for (const k of ALL_PRESERVED_KEYS) {
    const r = await db.get(`select value from settings where key = ?`, [k])
    out[k] = r ? String(r['value']) : null
  }
  return out
}

/**
 * 一张表的**指纹式汇总** —— 用它对账「导回之后一行不少、一个字不差」。
 *
 * ★★ 为什么是 SQL 侧聚合而不是把行读出来比 ★★★
 *
 * D-297 与 M1 真机验证都定了同一条硬约束：
 * **导回必须 SQL-to-SQL，不把整表数据搬进 JS 内存。**
 * 几万行 `review_logs` 搬进 WebView 会把它撑爆，而那种坏法在小库上测不出来。
 *
 * 所以对账也必须遵守同一条 —— 这里每一个数都由 SQLite 算好再回来，
 * 回来的永远只有一行几个数字。
 *
 * 这几个数能抓到的：
 *   少一行 / 多一行        → `n`
 *   uid 被改 / 丢          → `uids` `uidLen`
 *   updated_at 被顶到当下  → `updSum` `updMin` `updMax`
 */
export interface TableDigest {
  n: number
  uids: number
  uidLen: number
  updSum: number
  updMin: number
  updMax: number
}

export async function digestOf(db: Db, table: string): Promise<TableDigest> {
  const r = await db.get(
    `select count(*)                        as n,
            count(distinct uid)             as uids,
            coalesce(sum(length(uid)), 0)   as uidLen,
            coalesce(sum(updated_at), 0)    as updSum,
            coalesce(min(updated_at), 0)    as updMin,
            coalesce(max(updated_at), 0)    as updMax
       from "${table}"`
  )
  const num = (k: string): number => Number(r?.[k] ?? 0)
  return {
    n: num('n'),
    uids: num('uids'),
    uidLen: num('uidLen'),
    updSum: num('updSum'),
    updMin: num('updMin'),
    updMax: num('updMax')
  }
}

/** 两个汇总对不对得上 —— 对不上就说清是哪一项 */
export function digestDiff(a: TableDigest, b: TableDigest): string[] {
  const out: string[] = []
  for (const k of ['n', 'uids', 'uidLen', 'updSum', 'updMin', 'updMax'] as const) {
    if (a[k] !== b[k]) out.push(`${k}: 保全前 ${a[k]} → 导回后 ${b[k]}`)
  }
  return out
}

/**
 * 新表与 `_keep_` 表**都有**的列 —— 导回只搬这些。
 *
 * 新增的列拿默认值；被删掉的列自然消失。
 * 列名从库里问出来，**不写死** —— 写死就会跟 schema 漂。
 */
export async function sharedColumns(db: Db, table: string, keep: string): Promise<string[]> {
  const cols = async (t: string): Promise<string[]> =>
    (await db.all(`pragma table_info("${t}")`)).map((c) => String(c['name']))
  const a = await cols(table)
  const b = new Set(await cols(keep))
  return a.filter((c) => b.has(c))
}

/** 一行都不许漏：把 `_keep_` 里的数据搬回新表。**SQL-to-SQL** */
export async function restoreTable(db: Db, table: string): Promise<void> {
  const keep = keepName(table)
  const cols = await sharedColumns(db, table, keep)
  if (cols.length === 0) throw new Error(`${table}：新旧两张表没有一个共同列，拒绝导回`)
  const list = cols.map((c) => `"${c}"`).join(', ')
  await db.exec(`insert into "${table}" (${list}) select ${list} from "${keep}"`)
}

/** 把 `Row[]` 变成表名数组 —— 到处要用 */
export const names = (rows: Row[], key = 'name'): string[] => rows.map((r) => String(r[key]))
