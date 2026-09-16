/**
 * 本地清空之后，同步元数据该是什么样 · ★★ Step 1C / D-273 / D-279 · F-05
 *
 * ── 先说清楚这几个键各自是什么，再说怎么处理 ──────────────────
 *
 * | 键 | 它是什么 | 清空时 |
 * |---|---|---|
 * | `sync.device`    | **这台机器的身份**。包名是 `<device>-<时间戳>.json`，<br>拉的时候靠 `!name.startsWith(device + '-')` 跳过自己推的包 | **原样保留** |
 * | `sync.wipedAt`   | **一条已经发生过的事**：「比这个时刻旧的云端包一律不认」 | **`max(旧值, 现在)`** |
 * | `sync.watermark` | 游标：我推到哪了 / 这一行在上次同步之后改过没有 | **`max(旧值, 现在)`** |
 * | `sync.applied`   | 处理过的包名清单，是**缓存**不是事实 | **清空** |
 *
 * ── 为什么 device 不能换 ────────────────────────────────────
 *
 * 换了新编号，这台机器就不再认得自己以前推的包 —— 它会把**自己删掉的东西
 * 从云端拉回来**。`wipedAt` 也能挡住（按包名里的时间戳），但那是第二道；
 * 让身份保持稳定是第一道，而且它还让云端的历史包仍然归属得清楚。
 *
 * ── 为什么 wipedAt 只增不减 ────────────────────────────────
 *
 * 它记的是「发生过什么」，不是「现在是什么样」（`core/tombstone.ts` 头上那段
 * 讲过同一个道理）。倒退一次，那一段时间里删掉的东西就全回来了 ——
 * 而使用者根本不会知道为什么。时钟回拨、导回一份老备份、重置，
 * 任何一条路都不许让它变小。
 *
 * ── 为什么这条判据必须只有一份 ★ ────────────────────────────
 *
 * 现在有**两条**本地清空路径：`factory-reset.ts`（恢复出厂）和
 * `export.ts::wipeStudyData`（清空学习数据）。它们对同一件事的处理**本来就不一样**：
 * 后者写了 `where key != 'sync.wipedAt'` 记得留碑，前者**整张 settings 全清**，
 * 把自己上一步刚挂的碑一起抹掉了（审计 F-05）。
 *
 * 一条规则写在两个地方，就会长成两个样子。所以判据搬到这里，两条路都调它。
 */

/** 这几个键在本地清空时**必须活下来**（值按 `survive()` 算） */
export const PRESERVED_SYNC_KEYS = [
  'sync.device',
  'sync.wipedAt',
  'sync.watermark',
  'sync.applied'
] as const

export type PreservedSyncKey = (typeof PRESERVED_SYNC_KEYS)[number]

/** 清空之前读到的那几个值。读不到就是 `null` */
export type SyncMetaSnapshot = Partial<Record<PreservedSyncKey, string | null>>

/** 清空之后应该写回去的那几个值。**只有这里面的键会被写回** */
export type SyncMetaAfterWipe = Record<PreservedSyncKey, string>

const num = (v: string | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 「墓碑不许倒退」这条规则本身。单独导出是因为导回备份那一路也要用
 * （`core/restore-merge.ts::mergeWipedAt` 是同一个方向，两处将来可以合并）。
 */
export const monotone = (prev: string | null | undefined, now: number): number =>
  Math.max(num(prev), now)

/**
 * 本地清空之后，这四个键该写成什么。
 *
 * @param before 清空**之前**读到的值
 * @param now    这一次清空的时刻
 *
 * ★ `device` 读不到时返回空串 —— 调用方看到空串就**不要写**，
 *   让 `Sync.deviceId()` 照常去生成一个新的（那台机器本来就还没同步过）。
 */
export function afterWipe(before: SyncMetaSnapshot, now: number): SyncMetaAfterWipe {
  const wipedAt = monotone(before['sync.wipedAt'], now)
  return {
    'sync.device': (before['sync.device'] ?? '').trim(),
    'sync.wipedAt': String(wipedAt),
    // 游标不能落在墓碑之前 —— 落在前面等于宣布「碑之后的包我还没看过」，
    // 而本地已经空了，那些包一进来就是凭空长出来的数据
    'sync.watermark': String(Math.max(monotone(before['sync.watermark'], now), wipedAt)),
    // 名单是缓存：老包由 wipedAt 按名字挡掉，留着它只会越积越大
    'sync.applied': '[]'
  }
}

/**
 * 清空之后自检用：这四个键是不是都还在、而且没有倒退。
 * 返回一句人话表示有问题，`null` 表示没问题。
 *
 * 「清空」是他看不见过程的操作，只能看见一句话 ——
 * 真出问题时表现恰好是「说清空了，下次同步全回来了」。所以要当场验一遍。
 */
export function verifyAfterWipe(
  before: SyncMetaSnapshot,
  after: SyncMetaSnapshot,
  now: number
): string | null {
  const bad: string[] = []
  const hadDevice = (before['sync.device'] ?? '').trim() !== ''
  if (hadDevice && (after['sync.device'] ?? '').trim() !== (before['sync.device'] ?? '').trim()) {
    bad.push('这台机器的同步编号被换掉了 —— 它会把自己删掉的东西再拉回来')
  }
  if (num(after['sync.wipedAt']) < Math.max(num(before['sync.wipedAt']), now)) {
    bad.push('同步墓碑倒退了 —— 云端的老数据会被重新拉回来')
  }
  if (num(after['sync.watermark']) < num(after['sync.wipedAt'])) {
    bad.push('同步位置落在删除记录之前 —— 会把它之后的包当成没看过的新数据')
  }
  return bad.length ? bad.join('；') : null
}
