/**
 * 什么时候压实一次 · T-2.10（D-R18 已裁：方案 D）
 *
 * ── T-2.2 把「怎么压」做完了，剩下的是「什么时候压」──────────
 *
 * `compact.ts` 摆在那里，**没有任何东西会调它**（那一轮有意留白：
 * 会删云端存量的动作，触发策略要使用者点头）。2026-09-05 他裁了方案 D：
 *
 *   > 彻底删除记一个待压实标记，下一次同步末尾统一压一次；
 *   > 先同步一趟再压；加桶大小上限。
 *
 * 这个文件就是那三句话的判据本体。**两端只是调用**：
 * Windows 在 `main/index.ts` 的两个 `run()` 之后接一行，
 * Android 在 `sync-runner.ts` 自动档末尾接同一行。判据一份都不许再抄。
 *
 * ── 为什么「先同步一趟再压」是必须的，不是顺手 ★★★ ────────
 *
 * `compact.ts` 只折**本机已经吸收过的包**（见那边文件头那一整段：
 * 折别人推的、本机还没应用过的包 = 对本机丢数据）。
 * 而一趟 `run()` 刚刚好做完两件事：把桶里能收的包全收进 `applied`、
 * 把本机的新改动推上去。所以「run 成功之后紧接着压」这个时刻，
 * T-2.2 的资格闸**天然满足**，不需要为压实另开一条拉取。
 *
 * ── 两条触发线 ──────────────────────────────────────────────
 *
 * ① **彻底删除立过碑**（`settings['sync.compactPending']`）—— D-435 的正事。
 *    本地删干净了、碑也传出去了，可**历史包里那份原文谁都没动过**。
 *    标记由 `core/cascade.ts::hardDelete` 就地记（那是唯一的硬删入口，
 *    挂在调用点是靠记性的做法）。
 *
 * ② **桶里的包数到线**（`COMPACT_PACK_LIMIT`）—— 卫生，不是正确性。
 *    桶是追加式的，包只增不减：新设备从零重建要把历史上每一次推送都下一遍。
 *
 * ── 为什么标记「每尝试一次就清掉」，而不是压成功了才清 ★★ ────
 *
 * 标记是**一次触发的意图**，不是一笔待办的账。
 * 压成功才清的话，一台「云端根本删不掉东西」的机器会**每趟同步都重来一遍**；
 * 而「上限拒」那条路更贵 —— 每趟都要把整个桶读到上限才拒。
 * 真正的保底是 ②：桶里包一多就会再压一次，那时候删掉的内容照样会被折掉。
 *
 * ★ 同理，②那条路也要冷却（`COMPACT_RETRY_MS`）：包数不会因为压实失败而变少，
 *   没有冷却就是「每趟同步都把整个桶读一遍再拒」。
 *
 * ── 这个文件里没有网络、没有 SQL 判据 ──────────────────────
 *
 * 只有：两把钥匙、三个数、一个「该不该压」的纯函数、一个「读到这儿超没超」的
 * 纯函数，外加围着那两把钥匙的三行读写。可以单独证伪。
 */

/**
 * 本机待压实标记 —— `settings` 的键。
 *
 * ★★ `settings` **不在 `SYNC_TABLES` 里**（见 `core/sync-tables.ts` 头注：
 *    里面有 AI 配置，整张表不参与同步），所以这个键**永不上云**；
 *    也**不进 `PRESERVED_SYNC_KEYS`**（`core/sync-metadata.ts`）——
 *    本地清空之后没有任何东西需要被压实，留着它只会让清空后的第一趟同步
 *    白跑一次压实。两条都有用例钉着。
 */
export const COMPACT_PENDING_KEY = 'sync.compactPending'

/** 上一次**尝试**压实的时刻（成不成功都记）—— ② 那条路的冷却靠它 */
export const COMPACT_TRIED_KEY = 'sync.compactTriedAt'

/**
 * 桶里到了这么多个包就压一次。
 *
 * ── 为什么是 100，不是 10 也不是 1000 ──────────────────────
 *
 * · 一个包 = 一次「真有东西要推」的同步。Windows 30 分钟一趟（D-347）、
 *   手机练完就传（D-249），正常使用一天大概几个到十几个包 —— 100 个大约是**一两周**。
 * · **往小了调的代价是实打实的**：每压一次，快照就是**整个数据集**，
 *   另一台设备下一趟必须把它整个下一遍（每一行都会判成 `same`，
 *   一个字都不会改，但字节要走）。手机上那是流量。
 * · 往大了调的代价是新设备从零重建要一个一个 `get` 过去；
 *   100 次 GET 还在「等得起」的范围里。
 * · 100 也让这条线明显是**兜底**：主触发是 ① 彻底删除那条（D-435 的正事），
 *   ② 只是不让桶无限长下去。
 */
export const COMPACT_PACK_LIMIT = 100

/** ② 那条路的冷却：包数不会因为压实失败而变少，没有冷却就是每趟都白读一遍整个桶 */
export const COMPACT_RETRY_MS = 24 * 60 * 60 * 1000

/**
 * 一次压实最多能吃进多少 —— T-2.2「还差的验证 ③」那条（**触发策略定了一起定**）。
 *
 * 压实要把整个桶读进内存才能算快照，此前**一点上限保护都没有**。
 *
 * · `maxRows` —— 累计**留在内存里等着折**的行数。一行是一个带 `data` 对象的 JS 对象，
 *   实测量级在 1 KB 上下，20 万行就是几百 MB。
 * · `maxChars` —— 累计**读进来**的包正文长度（UTF-16 字符数）。
 *   ★ 有意不量 UTF-8 字节：那要 `TextEncoder` 再复制一份整个正文，
 *     而我们防的正是那份内存。JSON 正文绝大多数是 ASCII，字符数就是最好的代理量。
 *
 * ★ 超了就**拒**，不做「折一半」。折一半在协议上其实是安全的（快照是被删那些包的
 *   超集就够），但那是一件新的事，要单独提出来让他点头 —— 这一轮按裁决只做「拒」。
 */
export interface CompactLimits {
  maxRows: number
  maxChars: number
}

export const COMPACT_LIMITS: CompactLimits = {
  maxRows: 200_000,
  maxChars: 24 * 1024 * 1024
}

// ══════════════════════════════════════════════════════════════
// 纯判据
// ══════════════════════════════════════════════════════════════

export interface CompactTriggerInput {
  /** 配了同步吗。没配就没有云端可压 */
  configured: boolean
  /** `settings['sync.compactPending']`。0 = 没有立过碑 */
  pendingAt: number
  /** `settings['sync.compactTriedAt']`。0 = 从没试过 */
  triedAt: number
  /**
   * 上一趟 `run()` 列桶时看见了几个包。
   * ★ `-1` = **不知道**（这个实例还没跑过一趟同步）—— 不知道就不按包数压。
   */
  bucketPacks: number
  now: number
}

/** `why` 两条路都要给：压了要写进账本，没压要能在用例里指着看 */
export interface CompactTriggerVerdict {
  go: boolean
  why: string
}

/** 这一趟同步末尾，该不该压实一次 */
export function shouldCompact(i: CompactTriggerInput): CompactTriggerVerdict {
  if (!i.configured) return { go: false, why: '还没配同步 —— 没有云端可以压实' }

  // ① 彻底删除那条：不看包数、不看冷却。他刚删掉的东西还整整齐齐躺在云端（D-435）
  if (i.pendingAt > 0) {
    return { go: true, why: '这台机器彻底删过东西 —— 云端的历史包里可能还留着它的原文（D-435）' }
  }

  if (i.bucketPacks < 0) return { go: false, why: '这一趟没有列过桶，不知道里面有几个包' }
  if (i.bucketPacks < COMPACT_PACK_LIMIT) {
    return { go: false, why: `云端有 ${i.bucketPacks} 个变更包，还没到 ${COMPACT_PACK_LIMIT} 这条线` }
  }

  /**
   * ★ 冷却。`since < 0` 是时钟往回走了 —— 那时候**放行**：
   *   拿一个未来的时刻去挡，会挡到天荒地老（同 `sync.wipedAt` 那条的方向）。
   */
  const since = i.now - i.triedAt
  if (i.triedAt > 0 && since >= 0 && since < COMPACT_RETRY_MS) {
    const h = Math.round(since / 3600000)
    return {
      go: false,
      why: `云端有 ${i.bucketPacks} 个变更包（到线了），但 ${h} 小时前刚压过一次 —— 隔一天再来`
    }
  }
  return { go: true, why: `云端有 ${i.bucketPacks} 个变更包，到了 ${COMPACT_PACK_LIMIT} 这条线` }
}

/** 读到这儿为止吃进来的量 */
export interface CompactRead {
  rows: number
  chars: number
}

const mb = (chars: number): string => (chars / 1024 / 1024).toFixed(1)

/**
 * 超上限了吗。返回 `null` = 还装得下；返回一句人话 = 超了，**一个字都别动**。
 *
 * ★ 在读包的循环里每读一个查一次 —— 峰值内存因此被钉在「上限 + 一个包」，
 *   而不是「整个桶」。事后再查等于没查。
 */
export function overBudget(read: CompactRead, limits: CompactLimits = COMPACT_LIMITS): string | null {
  if (read.rows > limits.maxRows) {
    return (
      `云端的变更包太大了：已经读进来 ${read.rows} 行，超过一次压实的上限（${limits.maxRows} 行）。` +
      `压实一次要把它们全读进内存，所以这一次没有压 —— 「云端一个字都没动」。`
    )
  }
  if (read.chars > limits.maxChars) {
    return (
      `云端的变更包太大了：已经读进来约 ${mb(read.chars)} MB，超过一次压实的上限（${mb(limits.maxChars)} MB）。` +
      `压实一次要把它们全读进内存，所以这一次没有压 —— 「云端一个字都没动」。`
    )
  }
  return null
}

// ══════════════════════════════════════════════════════════════
// 那两把钥匙的读写 —— 判据的键名只有这一份
// ══════════════════════════════════════════════════════════════

/** 记这两把钥匙要的最小库面。`CascadeDb` 与 `EngineDb` 都是它的超集 */
export interface CompactStateDb {
  run(sql: string, params?: readonly unknown[]): Promise<void>
  get(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown> | undefined>
}

const SET_SQL =
  `insert into settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`

const numOf = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

async function readKey(db: CompactStateDb, key: string): Promise<number> {
  try {
    const r = (await db.get(`select value from settings where key = ?`, [key])) as
      | { value?: unknown }
      | undefined
    return numOf(r?.value)
  } catch {
    return 0
  }
}

export interface CompactState {
  pendingAt: number
  triedAt: number
}

export async function readCompactState(db: CompactStateDb): Promise<CompactState> {
  return {
    pendingAt: await readKey(db, COMPACT_PENDING_KEY),
    triedAt: await readKey(db, COMPACT_TRIED_KEY)
  }
}

/**
 * 彻底删掉东西之后记一笔「云端可能还留着它的原文」。
 *
 * ★ 由 `core/cascade.ts::hardDelete` 在**它自己的事务里**调 —— 删除回滚了，
 *   这个标记跟着回滚，不会留下一个没有对应删除的待压实。
 * ★ 记不上**不许**让彻底删除失败：代价只是「云端那份存量晚一点清」
 *   （包数那条线兜着），而让他当场看见一个「彻底删除报错了」要坏得多。
 *   同 `cascade.ts::forgetSyncState` 的口径。
 */
export async function markCompactPending(db: CompactStateDb, at: number): Promise<void> {
  try {
    await db.run(SET_SQL, [COMPACT_PENDING_KEY, String(at), at])
  } catch {
    /* 见方法头 */
  }
}

/**
 * 试过了。**清掉标记 + 记下时刻**，而且是在真的动手**之前**调 ——
 * 压实中途崩了也不会变成「每次启动都重来一遍」。理由见文件头那一段。
 */
export async function noteCompactTried(db: CompactStateDb, at: number): Promise<void> {
  await db.run(`delete from settings where key = ?`, [COMPACT_PENDING_KEY])
  await db.run(SET_SQL, [COMPACT_TRIED_KEY, String(at), at])
}
