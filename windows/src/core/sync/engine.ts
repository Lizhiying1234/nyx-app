import {
  applyResolution,
  describeConflicts,
  planMerge,
  type MergePlan,
  type Resolution,
  type SyncRow
} from '../sync-merge.ts'
import { SYNC_TABLES } from '../sync-tables.ts'
import {
  needsTombstone,
  planParentBlocks,
  rowKey,
  tombKey,
  type Tombstone
} from '../tombstone.ts'
import { keptUpdatedAt, resolutionUid, type ResolutionFact } from '../resolution.ts'
import { hardDelete } from '../cascade.ts'
import { canonicalUid, isBuiltinTable, isCanonicalUid } from '../builtin-identity.ts'
import {
  checkRows,
  classifyChunk,
  SYNC_PROTOCOL_VERSION,
  type RejectCode
} from '../sync-protocol.ts'
import { checkAudioName } from '../audio-name.ts'
import { checkSplashName } from '../splash-name.ts'
import {
  decodeMeta,
  encodeMeta,
  isGone,
  isMetaEntry,
  remoteMetaSkew,
  metaKey,
  nameOfMeta,
  pickLabel,
  type SplashLabel
} from '../splash-names.ts'
import {
  apply as applyStep,
  auditCommit,
  auditTally,
  auditWatermark,
  auditWriteOrder,
  batchIsFull,
  /** ★ F-015 · 时钟偏移的观测与措辞 —— 写好很久了，这一轮才接上调用点 */
  clockSkewObservedMs,
  describeClockSkew,
  orderForWrite,
  /** ★ 起个别名：这个文件里 `plan` 已经被 `planMerge` 的结果占着了 */
  plan as planStep,
  planCommit,
  pushedUpTo,
  startSession,
  type CollectLimit
} from './session.ts'
import type { InvariantViolation } from './invariants.ts'
import type { Step } from './types.ts'
import {
  dynamicOf,
  relationsOf,
  syncColumnOf,
  toLocal,
  toSync,
  type Relation
} from '../fk-map.ts'
import {
  makeStore,
  probeDeletePermission,
  type RemoteStore,
  type SyncConfig
} from './store.ts'
import { compactBucket, type CompactResult } from './compact.ts'
import {
  needsTranslate,
  parseOverride,
  planRestore,
  type OverrideEntry
} from './restore.ts'
import {
  noteCompactTried,
  readCompactState,
  shouldCompact,
  type CompactLimits
} from './compact-trigger.ts'
import { decodeProblems, encodeProblems, SYNC_PROBLEM_KEY, type SyncProblem } from './problems.ts'
import type { EngineDb, EnginePorts, SchemaIdentity } from './ports.ts'

/**
 * 增量行级同步 · D-201（含修订）—— **两端同一份的引擎**
 *
 * ★★★ 2026-08-29 · 阶段 3（Android 同步接线）：本文件是
 * `main/sync/index.ts` 的整体搬迁 —— 「写第二份 = 把这个项目最擅长制造、
 * 也最难发现的那类 bug 复制到第二个平台」（sync/types.ts 头注）。
 * 判据一个字没动；唯一的形变是：
 *   · better-sqlite3 同步调用 → `EngineDb` 异步端口（D-275 同款：PC 包成异步）
 *   · `db.transaction(fn)()` → `inTx()`（BEGIN / SAVEPOINT 显式分层，
 *     语义与 better-sqlite3 的嵌套规则一致）
 *   · fs / safeStorage / 备份 / 哈希 → `EnginePorts`（ports.ts）
 * Windows 的 `main/sync/index.ts` 收窄成端口装配 + 转发；Android 经
 * core-link 直接 import 这一份。
 *
 * ── 协议（原文保留）──────────────────────────────────────────
 *
 * 原定「整库 JSON 快照全量传」，修订成**增量行级**：每台机器只往云端
 * **追加**自己的变更包，从不改别人的包。
 *
 *   nyx/chunks/<设备>-<时间戳>.json   ← 这台机器某次推上去的变更行
 *   nyx/devices/<设备>.json           ← 这台机器最后推到哪
 *
 * 拉的时候只下**别的设备**的、且自己还没应用过的包。第一次全量，之后每次几十 KB。
 * 追加式的好处：**没有任何一次写会覆盖别人的数据**，网络断在半路也只是少一个包。
 *
 * 不进同步的：API key（D-220）、本地词典（D-222）、迁移流水。见 SYNC_TABLES。
 * TTS 音频**进**同步（D-244），单独走文件，不塞进行数据里。
 */

/**
 * 一个变更包最多装多少行 · R-4-B。**体积闸**，不是数据库或 API 的限制。
 * 拉那一侧的 PULL_PACKS / PULL_ROWS 在 `session.ts`（R-4-C-a：数值与判据一处）。
 */
const PACK_ROWS = 5000

interface WriteResult {
  ok: number
  failed: { row: SyncRow; message: string }[]
  /**
   * ★ R-4-G · **有意跳过**的行 —— 和 `failed` 分开。
   * 失败要重试（R-4-A：这一包不进 `applied`），跳过不要 ——
   * 它是一个已经做完的决定，再来一百次结果一样。
   */
  skipped: { row: SyncRow; why: string }[]
}

/** ★ R-4-F-a · 按「用本地的」留下来的一行：它的时间戳被顶到了被拒版本之后 */
interface KeptRow {
  table: string
  uid: string
  updatedAt: number
}

/** 裁决事实在内存里的键 —— 和墓碑的 `tombKey` 同形（表 + 那一行的 uid） */
const resKey = (kind: string, targetUid: string): string => `${kind} ${targetUid}`

interface Collected {
  rows: SyncRow[]
  /** ★★ C-2 · 本地关系断了、翻译不出跨设备身份的行 */
  untranslatable: { table: string; uid: string; why: string; at: number }[]
  /** 这一次没收完的表，各还剩多少行、收到了哪一毫秒 */
  truncated: CollectLimit[]
  /** 这一次真正推到哪个时刻为止。`null` = 全推完了，水位可以走到 `startedAt` */
  upTo: number | null
}

/** 结构与 `@shared/api.ts::SyncStatus` 逐字段一致（结构化类型，适配层零转换） */
export interface EngineStatus {
  kind: SyncConfig['kind']
  url: string
  user: string
  hasSecret: boolean
  device: string
  lastAt: number
  lastNote: string
  auto: boolean
  pending: number
  problems: SyncProblem[]
  /** 连续失败了几次（成功清零）—— D-373 手机通知「同步连败」的判据 */
  failStreak: number
}

/**
 * ★ T-2.10 · 一趟同步末尾「压没压」的回执。
 *
 * **有意不并进 `EngineRunResult`**：压实不改变同步的结果，把它塞进那个对象
 * 就等于让调用方以为「同步成功」这件事包含了「压实成功」。
 */
export interface CompactAttempt {
  /** `compact()` 真的被调了吗 */
  ran: boolean
  /** 压了 / 没压的理由 —— 一句人话 */
  why: string
  /** 调了才有 */
  result?: CompactResult
}

/**
 * ★ T-2.5 · 「还原被盖掉的那一版」的回执。
 *
 * **拒绝不是异常**：行没了 / 在回收站 / 已经还原过 / 那一笔被截断了 ——
 * 每一种都是他该看懂的一句话，界面照原样显示。
 */
export type RestoreOutcome =
  | { ok: true; table: string; uid: string; columns: string[]; from: number }
  | { ok: false; why: string }

/** 结构与 `@shared/api.ts::SyncRun` 逐字段一致 */
export interface EngineRunResult extends EngineStatus {
  conflictNote?: string
  applied: number
  received: number
  skipped: number
  failed: number
  conflicted: number
  pushed: number
  leftOver?: number
  seen?: number
  chunks?: number
  wm?: number
  batches?: number
  maxBatchRows?: number
  rejected?: number
  rejections?: { chunk: string; code: string; reason: string }[]
  legacyChunks?: number
}

export class SyncEngine {
  /** ★ 不用「参数属性」写法 —— Android 侧 node 以 strip-only 跑 TS，不认它 */
  private ports: EnginePorts
  private db: EngineDb
  constructor(ports: EnginePorts) {
    this.ports = ports
    this.db = ports.db
  }

  // ── 事务 —— better-sqlite3 嵌套语义的显式版 ─────────────────
  /**
   * 外层 BEGIN / COMMIT，内层 SAVEPOINT / RELEASE —— 和 better-sqlite3
   * 对嵌套 `db.transaction` 的处理**同一语义**（writeRows 在 runOnce 的
   * 批事务里就是嵌套的那一层）。出任何事整层回滚再抛，绝不留半截。
   */
  private txDepth = 0
  private async inTx<T>(fn: () => Promise<T>): Promise<T> {
    const d = this.txDepth++
    const sp = `nyx_sp_${d}`
    if (d === 0) await this.db.begin()
    else await this.db.run(`savepoint ${sp}`)
    try {
      const out = await fn()
      if (d === 0) await this.db.commit()
      else await this.db.run(`release ${sp}`)
      return out
    } catch (e) {
      if (d === 0) await this.db.rollback().catch(() => {})
      else {
        await this.db.run(`rollback to ${sp}`).catch(() => {})
        await this.db.run(`release ${sp}`).catch(() => {})
      }
      throw e
    } finally {
      this.txDepth--
    }
  }

  private fkCache = new Map<string, Relation[]>()
  private colCache = new Map<string, Set<string>>()

  private async columnsOf(table: string): Promise<Set<string>> {
    const hit = this.colCache.get(table)
    if (hit) return hit
    const cols = new Set(
      ((await this.db.all(`pragma table_info("${table}")`)) as { name: string }[]).map(
        (c) => c.name
      )
    )
    this.colCache.set(table, cols)
    return cols
  }

  // ── 配置 ──────────────────────────────────────────────────────
  private async get(k: string, d = ''): Promise<string> {
    const r = (await this.db.get(`select value from settings where key = ?`, [`sync.${k}`])) as
      | { value: string }
      | undefined
    return r?.value ?? d
  }

  private async set(k: string, v: string): Promise<void> {
    await this.db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [`sync.${k}`, v, Date.now()]
    )
  }

  async config(): Promise<SyncConfig> {
    return {
      kind: ((await this.get('kind', 'off')) || 'off') as SyncConfig['kind'],
      url: await this.get('url'),
      user: await this.get('user'),
      // ★★ Step 5B · 密钥只从密钥面拿 —— 这一层之外没人碰 safeStorage / Keystore
      secret: await this.ports.secrets.getSyncSecret()
    }
  }

  async auto(): Promise<boolean> {
    // ★ D-347 · 默认**开**（《指导》§17「同步必须默认自动」；2026-08-30 翻的）。
    //   没配同步时自动触发自己会闭嘴，所以默认开不会对着空配置报错。
    //   他亲手关过（存了 '0'）就还是关 —— 只翻「没表过态」的那一档。
    return (await this.get('auto', '1')) === '1'
  }

  async setAuto(on: boolean): Promise<void> {
    await this.set('auto', on ? '1' : '0')
  }

  async saveConfig(c: SyncConfig): Promise<void> {
    await this.set('kind', c.kind)
    await this.set('url', c.url.trim())
    await this.set('user', c.user.trim())
    if (c.secret) await this.ports.secrets.setSyncSecret(c.secret)
  }

  /** 设备编号 · 语义照 `main/db/device.ts`：settings['sync.device']，没有就造一个 */
  private async deviceId(): Promise<string> {
    try {
      const has = (await this.get('device')).trim()
      if (has) return has
      const id = this.ports.uuid().slice(0, 8)
      await this.set('device', id)
      return id
    } catch {
      /** 库还没 ready 时宁可空着 —— 空串在 `deviceCol` 那层统一成 null */
      return ''
    }
  }

  /**
   * ★★ F-009 · 这台机器用过的**旧**编号。
   *
   * 从备份恢复到新机器时会重新铸号（判据在平台侧：新机器的硬件标识不一样），
   * 旧号存进 `sync.formerDevices`。旧号推上去的那些包**也是自己推的** ——
   * 不跳过的话，恢复之后第一次同步会把自己过去所有的包重下一遍
   * （只会判成 `same`，纯浪费，还会把 applied 的 500 个名额撑满）。
   *
   * ★ 脏数据一律当没有：这个键坏了只该退化成「多下一些包」，不该让同步整趟炸。
   */
  private async formerDevices(): Promise<readonly string[]> {
    try {
      const raw = (await this.get('formerDevices', '')).trim()
      if (!raw) return []
      const v: unknown = JSON.parse(raw)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
    } catch {
      return []
    }
  }

  private async watermark(): Promise<number> {
    return Number(await this.get('watermark', '0')) || 0
  }

  private async wipedAt(): Promise<number> {
    return Number(await this.get('wipedAt', '0')) || 0
  }

  async markWiped(at = Date.now()): Promise<void> {
    await this.set('wipedAt', String(at))
    await this.set('watermark', String(at))
    await this.set('applied', '[]')
  }

  async status(): Promise<EngineStatus> {
    const c = await this.config()
    return {
      kind: c.kind,
      url: c.url,
      user: c.user,
      hasSecret: await this.ports.secrets.hasSyncSecret(),
      device: await this.get('device'),
      lastAt: Number(await this.get('lastAt', '0')) || 0,
      lastNote: await this.get('lastNote'),
      auto: await this.auto(),
      pending: await this.countPending(),
      // ★ R-4-D · 设置页的同步区直接看得见，不用他去翻日志
      problems: (await this.lastProblems())?.problems ?? [],
      failStreak: Number(await this.get('failStreak', '0')) || 0
    }
  }

  private async countPending(): Promise<number> {
    // ★ Step 6C · 判据是「当前版本 ≠ 确认同步过的那一版」，和水位无关
    let n = 0
    for (const t of SYNC_TABLES) {
      try {
        n += Number(
          (
            (await this.db.get(
              `select count(*) as n from "${t}" t
                 left join row_sync_state s
                   on s.table_name = ? and s.uid = t.uid
                where t.updated_at <> 0
                  and (s.pushed_updated_at is null or s.pushed_updated_at <> t.updated_at)`,
              [t]
            )) as { n: number } | undefined
          )?.n ?? 0
        )
      } catch {
        /* 老库缺表就跳过 —— 和原实现同款容错 */
      }
    }
    return n
  }

  async markAllApplied(): Promise<number> {
    if ((await this.config()).kind === 'off') return 0
    const names = await makeStore(await this.config()).list('nyx/chunks')
    await this.set('applied', JSON.stringify(names.slice(-500)))
    await this.set('watermark', String(Date.now()))
    return names.length
  }

  /**
   * 工厂重置那条链用：把云端的存量清掉。
   *
   * ★★ T-2.2 · **现在真的删**（`RemoteStore.delete`）。
   *
   * 以前这里只能「用空包覆盖」，因为传输层根本没有删除原语 ——
   * 注释原话是「追加式存储没有删除，只有覆盖」。那句话说的是**当时的实现**，
   * 不是存储的性质：WebDAV 有 DELETE，Supabase Storage 也有。
   *
   * 覆盖成空包和删掉的差别不只是好看：
   *   · 覆盖留下的空包**还占着那个名字**，另一端每一轮都要把它下载一遍、判成空包
   *   · 桶的用量一个字节都没少
   *   · D-435 说的是「云端不许再留着它的内容」—— 一个写着 `{"rows":[]}` 的
   *     文件确实没有内容了，但「彻底清掉」和「把内容擦空」不是一回事
   *
   * ★ **没有删除权限时退回原来那条路**（空包覆盖），不是报错停下：
   *   工厂重置是他已经按下去的动作，本地那一半照样要做完；
   *   云端能擦到什么程度就擦到什么程度，比什么都不做强。
   *   探测一次要一发 put + 一发 delete + 一发 get，只探这一次，不是每个文件探一次。
   */
  async wipeRemote(): Promise<number> {
    if ((await this.config()).kind === 'off') return 0
    const store = makeStore(await this.config())
    const probe = await probeDeletePermission(store)
    let n = 0
    /**
     * ★ 2026-09-09 加了 `nyx/splash`。**必须加** —— 不加的话「清除云端」之后
     *   启动页图还躺在桶里，而他按那个键的意思是「桶里我的东西都没了」。
     * ★★ 跨版本要说清楚：**跑着旧版本的那一端，它的 `wipeRemote` 不认识这个前缀**，
     *   于是从旧端做工厂重置会把 `nyx/splash/*` 留下。
     *   后果只是**桶里剩下几个孤儿文件**（不是数据损坏、不是复活）：
     *   列目录按前缀取，谁也不会去解析别人的前缀。两端都升上来就没有了。
     */
    for (const prefix of ['nyx/chunks', 'nyx/devices', 'nyx/audio', 'nyx/splash']) {
      for (const name of await store.list(prefix)) {
        if (probe.ok) await store.delete(`${prefix}/${name}`)
        else await store.put(`${prefix}/${name}`, JSON.stringify({ rows: [] }))
        n += 1
      }
    }
    await this.set('applied', '[]')
    await this.set('watermark', String(Date.now()))
    return n
  }

  /**
   * ★★ T-2.2 · 云端压实 —— 写快照、逐行核对、再删老包。判据全在 `compact.ts`。
   *
   * ★ T-2.10（D-R18 已裁 D）：**什么时候**调它现在有答案了 —— `compactIfNeeded()`。
   *   这个方法本身仍然是「叫我我就压」，不问理由：手动入口、用例、以后的诊断都要它。
   *
   * 这里只做一件 `compact.ts` 做不了的事：把它要的四样事实备齐。
   * ★ `fksOf` 必须是**同步**的（`planParentBlocks` 是纯函数），
   *   所以先把 30 张同步表的关系问齐再进去 —— `pragma` 不便宜，但压实本来就很重、很少跑。
   */
  async compact(now = Date.now(), limits?: CompactLimits): Promise<CompactResult> {
    /**
     * ★★ 走**和 `run()` 同一条排队闸**：压实读的是 `applied` 与桶里的包名，
     * 而一趟 `run()` 会推新包、改 `applied`。两者交错的话，压实会拿着
     * 已经过期的账去决定删哪些包 —— 那正是这条闸存在的理由。
     */
    const mine = this.queue.catch(() => undefined).then(() => this.compactOnce(now, limits))
    this.queue = mine.then(
      () => undefined,
      () => undefined
    )
    return mine
  }

  /**
   * ★★ T-2.10 · 压实的**触发点** —— 一趟 `run()` 成功之后调它一次（D-R18 方案 D）。
   *
   * 判据一行都不在这里：该不该压由 `compact-trigger.ts::shouldCompact` 说了算，
   * 两端调的是同一个方法（Windows 在 `main/index.ts` 的两个 `run()` 之后，
   * Android 在 `sync-runner.ts` 自动档末尾）。
   *
   * ── 三条铁律 ──────────────────────────────────────────────
   *
   * ① **绝不抛。** 压实是同步之后的一件独立的事，它坏了不许改变这一趟同步的结果 ——
   *   `run()` 的返回值这时候已经算完了，问题落进 `sync.problems` 那条既有通道
   *   （设置页的同步区直接显示、数据体检也报得出来），不弹窗。
   * ② **先记账，后动手**（`noteCompactTried` 在 `compact()` 之前）：中途崩了也不会
   *   变成「每次启动都重来一遍」。理由见 `compact-trigger.ts` 文件头。
   * ③ **成了才写账本**（`ops_log` 的 `compact` 一行）：账本记的是「做过什么」，
   *   没做成的那些是「问题」，两条通道各归各的。
   */
  async compactIfNeeded(now = Date.now(), limits?: CompactLimits): Promise<CompactAttempt> {
    let ran = false
    try {
      const st = await readCompactState(this.db)
      const verdict = shouldCompact({
        configured: (await this.config()).kind !== 'off',
        pendingAt: st.pendingAt,
        triedAt: st.triedAt,
        bucketPacks: this.lastBucketPacks,
        now
      })
      if (!verdict.go) return { ran: false, why: verdict.why }

      await noteCompactTried(this.db, now)
      ran = true
      const result = await this.compact(now, limits)
      if (result.ok) await this.noteCompact(result, verdict.why, now)
      else {
        await this.addProblem({
          kind: 'run',
          what: '云端压实',
          message: result.why ?? '压实没有做成，但没有说明原因'
        })
      }
      return { ran: true, why: verdict.why, result }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.addProblem({ kind: 'run', what: '云端压实', message })
      return { ran, why: `压实这一步自己出错了（这一趟同步的结果不受影响）：${message}` }
    }
  }

  /**
   * ★★ D-458 · 压实动了云端，账本上要有一行，而且**给出的每个数都要能答「是哪些」**：
   * 折了哪几个包、快照叫什么、没敢动的是哪几个（各自为什么）。
   *
   * ★ 记不下来不许把这一趟带崩 —— 同 `noteOverrides` 的口径。
   */
  private async noteCompact(r: CompactResult, why: string, at: number): Promise<void> {
    try {
      const title =
        `折了 ${r.folded} 个变更包 → 1 份快照（${r.rows} 行）` +
        (r.dropped > 0 ? `，清掉 ${r.dropped} 行已经彻底删除的内容` : '') +
        (r.untouched.length > 0 ? `，${r.untouched.length} 个包没敢动` : '')
      await this.db.run(
        `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
           values ('compact', 'sync', null, ?, ?, ?, ?)`,
        [
          title,
          JSON.stringify({
            why,
            snapshot: r.snapshot,
            before: r.before,
            folded: r.foldedNames,
            deleted: r.deleted,
            rows: r.rows,
            dropped: r.dropped,
            untouched: r.untouched.slice(0, 50)
          }).slice(0, 8000),
          at,
          at
        ]
      )
    } catch {
      /* 见方法头：记不下账也不能因此让同步失败 */
    }
  }

  /**
   * 往 `sync.problems` 里**添**一条（不是覆盖）。
   *
   * ★ `recordProblems` 是「这一趟的问题清单就是这些」，压实发生在 `run()` 之后 ——
   *   直接调它会把刚写好的那一趟的问题整个抹掉。同 `main/browse.ts::noteProblem`。
   */
  private async addProblem(p: SyncProblem): Promise<void> {
    try {
      const had = (await this.lastProblems())?.problems ?? []
      await this.recordProblems([p, ...had])
    } catch {
      /* 记不上账是小事，把同步之后的收尾带崩是大事 */
    }
  }

  /**
   * ★ `applied` 读法与 `runOnce()` 里那一处同义（脏数据一律当没有）。
   * 没有去改 `runOnce()` 共用一份 —— 那要动 `run()` 的编排，不在本轮范围里。
   */
  private async appliedNames(): Promise<string[]> {
    try {
      const raw = await this.get('applied', '')
      const v: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  private async compactOnce(now: number, limits?: CompactLimits): Promise<CompactResult> {
    const cfg = await this.config()
    if (cfg.kind === 'off') {
      return {
        ok: false,
        why: '还没配同步 —— 没有云端可以压实。设置 →「同步」里选一种。',
        before: 0,
        folded: 0,
        foldedNames: [],
        untouched: [],
        rows: 0,
        dropped: 0,
        deleted: 0
      }
    }
    const fks = new Map<string, Relation[]>()
    for (const t of SYNC_TABLES) fks.set(t, await this.fksOf(t))
    return compactBucket({
      store: makeStore(cfg),
      device: await this.deviceId(),
      formerDevices: await this.formerDevices(),
      applied: await this.appliedNames(),
      identity: await this.identity9(),
      now,
      terminated: await this.terminatedIndex(new Map()),
      fksOf: (t) => fks.get(t) ?? [],
      limits
    })
  }

  /** 「测试连接」按钮 —— 连不上要给一句人话（store 里管） */
  async test(): Promise<void> {
    await makeStore(await this.config()).check()
  }

  private async identity9(): Promise<SchemaIdentity & { protocolVersion: number }> {
    return { ...(await this.ports.identity()), protocolVersion: SYNC_PROTOCOL_VERSION }
  }

  /** 验收与诊断用：设置页「自检」要能把这三样贴出来 */
  async schemaInfo(): Promise<{
    schemaVersion: number
    schemaFingerprint: string
    protocolVersion: number
    algo: string
  }> {
    const id = await this.identity9()
    return {
      schemaVersion: id.schemaVersion,
      schemaFingerprint: id.schemaFingerprint,
      protocolVersion: id.protocolVersion,
      algo: id.algo
    }
  }

  // ── 问题留痕（格式在 core/sync/problems.ts，只有一份）────────
  private async recordProblems(problems: SyncProblem[]): Promise<void> {
    try {
      const t = Date.now()
      const value = encodeProblems(problems, t)
      if (value === null) {
        await this.db.run(`delete from settings where key = ?`, [SYNC_PROBLEM_KEY])
        return
      }
      await this.db.run(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [SYNC_PROBLEM_KEY, value, t]
      )
    } catch {
      /* 记不下来也不能因此让同步失败 */
    }
  }

  private async lastProblems(): Promise<ReturnType<typeof decodeProblems>> {
    try {
      const r = (await this.db.get(`select value from settings where key = ?`, [
        SYNC_PROBLEM_KEY
      ])) as { value: string } | undefined
      return decodeProblems(r?.value)
    } catch {
      return null
    }
  }

  /**
   * ★★ R-4-D · 整次同步失败也要留个痕。
   * 开机自动同步炸了以前只写一行 `nyx.log` —— 他不看日志，
   * 于是「同步好像不工作了」永远查不出原因。
   */
  async noteRunFailure(what: string, err: unknown): Promise<void> {
    await this.recordProblems([
      { kind: 'run', what, message: err instanceof Error ? err.message : String(err) }
    ])
    // D-373 · 连败计数与留痕同层 —— 每个调用方自动都有，忘不掉
    try {
      const n = Number(await this.get('failStreak', '0')) || 0
      await this.set('failStreak', String(n + 1))
    } catch {
      /* 记不下来也不能因此让失败更失败 */
    }
  }

  /** 同步的排队闸 —— 见 `run()` 头上那段 */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * ★★ D-438 · 两边都改过、已经按时间新的自动定了 —— **把被盖掉的那一版落账**。
   *
   * 使用者要的是「别问我」，不是「悄悄弄丢我写的字」。所以不打扰他，
   * 但整行原样写进 `ops_log`（`op='sync-override'`），他随时查得回来。
   *
   * ★ 落账失败绝不许把同步带崩 —— 那样代价是「这次没留痕」，
   *   比「同步断了」轻得多，和 `writeState` 同一条口径。
   */
  private async noteOverrides(
    rows: readonly { row: SyncRow; local: SyncRow; kept: 'remote' | 'local'; lost: SyncRow }[]
  ): Promise<void> {
    for (const o of rows) {
      try {
        const d = (o.lost.data ?? {}) as Record<string, unknown>
        const label = String(d['name'] ?? d['term'] ?? d['title'] ?? o.lost.uid).slice(0, 60)
        const now = this.ports.clock.now()
        await this.db.run(
          `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
             values ('sync-override', ?, null, ?, ?, ?, ?)`,
          [
            o.lost.table,
            label,
            JSON.stringify({
              uid: o.lost.uid,
              kept: o.kept,
              keptAt: o.kept === 'remote' ? o.row.updatedAt : o.local.updatedAt,
              lostAt: o.lost.updatedAt,
              lost: d
            }).slice(0, 8000),
            now,
            now
          ]
        )
      } catch {
        /* 见方法头：留不下痕也不能因此让同步失败 */
      }
    }
  }

  /**
   * ★★★ T-2.5 · 把被盖掉的那一版**从账本里还原回来**（D-438 / D-R4 已裁「要」）。
   *
   * 判据在 `core/sync/restore.ts`（纯函数，手机那半照用同一份）；
   * 这里只做三件判据做不了的事：读库、翻译关系列、一个事务写回去。
   *
   * ── 为什么落在引擎里而不是 Windows 主进程 ──────────────────
   *
   * `kept === 'local'` 那一半的 `lost` 是**同步形**（外键是 `*_uid`，没有 `id`）——
   * 写回本地表之前必须过 `fk-map.ts::toLocal`，而那需要 uid → 本地 id 的查表，
   * 连同「探针 → 补齐 → 重跑」那套异步收敛。这些**引擎里已经有了一份**
   * （`writeRows` 用的就是它）。放到平台层等于抄第二份翻译 ——
   * 这个项目为「两份判据」付过太多次账。两端调同一个方法。
   *
   * ── 为什么不走 `run()` 的排队闸 ────────────────────────────
   *
   * 还原就是一次**普通的本地编辑**（改个名字、静默一条，都不排队）。
   * 排进去的话，他点一下要等一趟正在跑的同步 —— 而没有任何东西因此更安全：
   * 写回带新 `updated_at`，这一趟没收走，下一趟自然收走（待推的判据是
   * 「当前版本 ≠ 确认同步过的那一版」，与时钟、与水位都无关）。
   *
   * ★ 绝不抛：拒绝是常态（行没了 / 在回收站 / 已经还原过 / 那一笔被截断了），
   *   每一种都要变成他看得懂的一句话，不是一个红色的异常。
   */
  async restoreOverride(opsLogId: number, now = Date.now()): Promise<RestoreOutcome> {
    try {
      const row = (await this.db.get(
        `select id, op, target, title, detail from ops_log where id = ?`,
        [opsLogId]
      )) as { id: number; op: string; target: string; title: string | null; detail: string } | undefined

      if (!row) return { ok: false, why: '账本里找不到这一笔了 —— 没有还原。' }
      if (row.op !== 'sync-override') {
        return { ok: false, why: '账本里这一笔不是「同步时被盖掉的那一版」，没有可以还原的东西。' }
      }

      const entry: OverrideEntry = { id: row.id, table: row.target, detail: row.detail ?? '' }
      const parsed = parseOverride(entry)
      if (!parsed.ok) return { ok: false, why: parsed.why }
      const v = parsed.v

      /**
       * ★★★ 形状：`kept === 'local'` 那一半是同步形，先过 `toLocal`。
       * 「探针 → 补齐 → 重跑」与 `writeRows` 一字不差 —— `toLocal` 是纯函数，
       * 最后那一遍与逐问逐答完全等价。
       */
      let localData: Record<string, unknown> = v.lost
      if (needsTranslate(v)) {
        const fks = await this.fksOf(entry.table)
        const answers = new Map<string, number | null>()
        let conv: ReturnType<typeof toLocal> | null = null
        for (let round = 0; round <= 8; round++) {
          const misses: [string, string][] = []
          const attempt = toLocal(entry.table, v.lost, fks, dynamicOf(entry.table), (parent, uid) => {
            const k = `${parent}#${uid}`
            if (answers.has(k)) return answers.get(k)!
            misses.push([parent, uid])
            return null
          })
          if (misses.length === 0) {
            conv = attempt
            break
          }
          for (const [parent, uid] of misses) {
            answers.set(`${parent}#${uid}`, await this.idOfUid(parent, uid))
          }
        }
        if (conv === null) {
          return { ok: false, why: '这一版里的关系翻译没有收敛（引擎自查）—— 没有还原。' }
        }
        if (!conv.ok) {
          return { ok: false, why: `这一版还原不了：${conv.why}` }
        }
        localData = conv.data
      }

      const current =
        ((await this.db.get(`select * from "${entry.table}" where uid = ?`, [v.uid])) as
          | Record<string, unknown>
          | undefined) ?? null
      const columns = [...(await this.columnsOf(entry.table))]
      const already = await this.restoredAlready(opsLogId)

      const verdict = planRestore({ entry, v, localData, current, columns, alreadyRestored: already, now })
      if (!verdict.ok) return { ok: false, why: verdict.why }
      const plan = verdict.plan

      /**
       * ★ `update … where uid = ?`，**不是 upsert**：行必须已经在
       * （`planRestore` 刚判过），而 upsert 会在行恰好消失时把它建回来 ——
       * 那正是 R-3 明令不许的复活。
       */
      const cols = plan.columns
      const sets = cols.map((c) => `"${c}" = ?`).join(', ')
      let changed = 0
      await this.inTx(async () => {
        await this.db.run(
          `update "${plan.table}" set ${sets} where uid = ?`,
          [...cols.map((c) => plan.set[c]), plan.uid]
        )
        const r = (await this.db.get(`select changes() as n`)) as { n?: number } | undefined
        changed = Number(r?.['n'] ?? 0)
        if (changed === 0) throw new Error('那一行在写的这一刻不在了')
        /**
         * ★ D-458 · 账本记一笔，而且「写了几列」要能答「是哪些」。
         *   `from` 指回被还原的那一笔 —— 「已经还原过」就是靠它判的。
         */
        await this.db.run(
          `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
             values ('sync-restore', ?, null, ?, ?, ?, ?)`,
          [
            plan.table,
            row.title,
            JSON.stringify({
              from: opsLogId,
              uid: plan.uid,
              kept: v.kept,
              lostAt: v.lostAt,
              columns: cols
            }).slice(0, 8000),
            now,
            now
          ]
        )
      })

      return { ok: true, table: plan.table, uid: plan.uid, columns: cols, from: opsLogId }
    } catch (err) {
      return {
        ok: false,
        why: `还原没有做成：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  /** 已经有一条 `sync-restore` 指着这一笔了吗 —— 「再点一次」的判据 */
  private async restoredAlready(opsLogId: number): Promise<boolean> {
    try {
      const rows = (await this.db.all(
        `select detail from ops_log where op = 'sync-restore'`
      )) as { detail: string }[]
      return rows.some((r) => {
        try {
          return (JSON.parse(r.detail) as { from?: number }).from === opsLogId
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  }

  /**
   * ★★ D-438 · 把「等他决定」的那些行当场按时间新的定掉。
   *
   * 返回一个**没有冲突**的 plan —— 后面的一切（写库、记账、`applied`、
   * 四个桶的恒等式）都像他已经逐条裁过一样，一处都不用改。
   * 被盖掉的那一版塞进 `lost`，由调用方落账。
   *
   * ★★ `on` 从 `settings['sync.autoResolve']` 来，**默认开**，界面上不出现。
   *   留这个开关不是为了让他选，是为了**让整套冲突裁决机制仍然可被验证** ——
   *   关掉它，冲突照旧报出来等裁决，`db-safety` 那三十多条不变式用例
   *   （检测 / 记账 / 收敛 / 重放安全）一条不少地继续跑。
   *   开着的那条路另有用例专门验（自动定 + 落账 + 收敛）。
   *   **两条路都有覆盖，而他那边永远是开着的那条。**
   */
  private autoResolve(
    plan: MergePlan,
    lost: { row: SyncRow; local: SyncRow; kept: 'remote' | 'local'; lost: SyncRow }[],
    on: boolean
  ): MergePlan {
    if (!on || plan.conflicts.length === 0) return plan
    const apply = [...plan.apply]
    let skipped = plan.skipped
    for (const c of plan.conflicts) {
      const takeRemote = c.remoteAt > c.localAt
      if (takeRemote) apply.push(c.row)
      else skipped += 1
      lost.push({
        row: c.row,
        local: c.local,
        kept: takeRemote ? 'remote' : 'local',
        lost: takeRemote ? c.local : c.row
      })
    }
    return { ...plan, apply, conflicts: [], skipped }
  }

  // ── 同步 ──────────────────────────────────────────────────────

  /**
   * 跑一次同步。`resolve` 是使用者对冲突的裁决：没传就**先不动**，
   * 把冲突报回去让他选（D-201 不静默覆盖）。`what` 是出事时报给他看的那句。
   *
   * ★★ R-4-D-a · 留痕在这一层，不在调用方 —— 每一个调用方自动都有，忘不掉。
   * 手机上这条会被放大：后台同步失败时没人看着屏幕，而手机上练完的记录
   * 在同步成功前**是孤本**（D-249）。
   * ★ 「还没配同步」不记 —— 他根本没开始用，不该在数据体检里亮红。
   */
  async run(resolve?: Resolution, what = '同步'): Promise<EngineRunResult> {
    if ((await this.config()).kind === 'off') {
      throw new Error('还没配同步。设置 →「同步」里选一种。')
    }
    /**
     * ★★ **同一时刻只许跑一趟 —— 后来的排队，不并发。**（2026-09-02）
     *
     * 实证：桶里同一批 927 行**一秒一个连着躺了三份**，另一批 643 行躺了两份 ——
     * 桶里 57% 是重复内容。根因就是这里没有闸：连点几下同步（或者手点撞上
     * 自动同步），几趟同时开跑，各自 `collectSince` 都拿到**同一批还没标记的行**
     * （标记是在 `put` 成功之后才写的），于是各自上传一个一模一样的包。
     *
     * ★ 为什么是**排队**不是「已经在跑就直接返回」：`run(resolve)` 带着他对冲突的
     *   裁决。直接把正在跑的那趟的结果还给他，等于**把他刚做的决定丢掉**。
     *   排队之后第二趟照常带着裁决跑，而那时该推的行已经标记过了 ——
     *   `mine.length === 0` → 连包都不会产生（见 push 那段的 `if`）。
     *
     * ★ 这只挡得住同一个引擎实例内的并发（两端各自一个单例，够用）。
     *   跨进程还是要靠云端那边的幂等 —— 那是另一件事。
     */
    const mine = this.queue
      .catch(() => undefined)
      .then(async () => {
        try {
          return await this.runOnce(resolve)
        } catch (err) {
          await this.noteRunFailure(what, err)
          throw err
        }
      })
    this.queue = mine.then(
      () => undefined,
      () => undefined
    )
    return mine
  }

  private async runOnce(resolve?: Resolution): Promise<EngineRunResult> {
    const cfg = await this.config()
    const store = makeStore(cfg)
    // ★★ C-2 · 边界缓存只在一次 run 之内有效 —— 跨 run 会拿着已经删掉的行继续用
    this.clearBoundaryCaches()
    const me = await this.deviceId()
    const wm = await this.watermark()
    /**
     * ★ Step 7D · 这一趟的开始时刻走时间源 —— 包名 `<设备>-<startedAt>.json`、
     *   包头的 `at`、以及水位全推完时走到的那个值，都由它来。
     */
    const startedAt = this.ports.clock.now()

    /**
     * ★★ Step 6C · 判别基准（decisionCutoff）**没有接进来** —— 等使用者裁决。
     * 判据函数留在 `core/sync/session.ts`（带单测），接线等新公式定下来再做。
     * （详情与两条实测结论见 Windows 侧历史：钳到 startedAt 修不好时钟回拨，
     * 而且会误伤合法落在未来的水位。）
     */

    /**
     * ★★ Step 6C · 上一次同步开始的时刻 —— 场景 B 的**证据来源**。
     * 一个我从没处理过的包自称推送于我上次同步之前 —— 不许把它判成
     * 「对面没改过」。时钟正常时这个条件恒为假。
     */
    const lastAt = Number(await this.get('lastAt', '0')) || 0
    /**
     * 本趟见过的最大远端时间戳 —— 量时钟偏移用。
     * ★ F-015（2026-09-01）：它**不再只是诊断**。落盘成 sync.maxRemoteSeen 之后，
     *   回收站的到期硬删会先问它一句（core/purge-guard.ts）——
     *   系统里唯一的外部时钟参照就是别的设备写下的时间戳。
     */
    let maxRemoteAt = 0

    // ── 拉：只下别的设备的、自己还没应用过的包 ────────────────
    const appliedRaw = await this.get('applied', '')
    const applied = new Set((appliedRaw ? (JSON.parse(appliedRaw) as string[]) : []) as string[])

    /**
     * ★★ Step 6B · 从这里开始，**下一步该干什么由 core 说了算**。
     * `plan(state)` 给一个 `Step`，这个方法照着执行、把结果交回 `apply()`。
     * 顺序本身就是判据，而且是最容易被第二个平台写错的那一条。
     */
    /** ★ 这一趟要推的行。先声明：`expect` 的闭包在 `collect` 之前就会被调用 */
    let mine: SyncRow[] = []

    let st = startSession({
      startedAt,
      watermark: wm,
      wipedAt: await this.wipedAt(),
      device: me,
      formerDevices: await this.formerDevices(),
      identity: await this.identity9(),
      applied: [...applied],
      resolve
    })

    /**
     * 执行器的自查：**真的做了这一步吗**。
     * 光让 core 算出 Step 是不够的 —— 平台层完全可以算完之后不照做，
     * 而那正好是「Core 只是装饰」的样子。对不上直接抛。
     */
    const expect = <K extends Step['kind']>(kind: K): Extract<Step, { kind: K }> => {
      const step = planStep(st, { outgoing: mine })
      if (step.kind !== kind) {
        throw new Error(`同步编排走岔了：core 说下一步是 ${step.kind}，执行器却在做 ${kind}`)
      }
      return step as Extract<Step, { kind: K }>
    }

    // ① list —— 云端有哪些包
    expect('list')
    const names = await store.list('nyx/chunks')
    /** ★ T-2.10 · 顺手记下桶有多大 —— 触发点要它，不再单独去列一次。观察器，不参与编排 */
    this.lastBucketPacks = names.length
    st = applyStep(st, { step: 'list', packages: names })
    const todo = st.todo

    /**
     * ② collect —— **先把要推的收好，再往本地写。**
     * 反过来的话，刚拉下来的行会立刻被算成「我这边的新改动」原样弹回云端。
     * ★ R-4-C-a · 它必须在**第一批写入之前**跑完。
     * ★★ 这条顺序由 `plan()` 的状态机保证 —— `listed` 只通向 `collect`。
     */
    const since = expect('collect').since
    const collected = await this.collectSince(since)
    mine = collected.rows
    st = applyStep(st, {
      step: 'collect',
      rows: mine,
      upTo: collected.upTo,
      untranslatable: collected.untranslatable.length
    })

    /** 这一次要报给他看的问题（失败的行 · 删后修改 · 墓碑执行不了的） */
    const problems: SyncProblem[] = []
    /**
     * ★★ Step 6B · core 判据自己复核出来的违规 —— **验收用的观察器**。
     * 不塞进他看得见的问题清单：`17-pull-only` 那种合法的水位倒退会变成
     * 用他看不懂的话说的假警报，误判多了这道闸就会被绕过去。
     */
    const violations: InvariantViolation[] = []

    /** ★★ Step 1A · 本机的结构与协议身份。整趟算一次。 */
    const me9 = await this.identity9()
    /** D-438 · 冲突自动按时间定 —— 默认开；整趟算一次 */
    const autoResolveOn = (await this.get('autoResolve', '1')) === '1'
    /** 整包被拒的（结构或协议对不上）—— 不进 `applied`，两端一致之后自动重来 */
    const rejections: { chunk: string; code: RejectCode; reason: string }[] = []
    /** ★ 走 legacy 路径的行。D-268：老包可以继续收，但不许假装自己是新包 */
    const legacyRows = new Set<SyncRow>()
    let legacyChunks = 0

    /**
     * ★★ R-4-C-a · **一批一批地拉。** 至多 PULL_PACKS 个包或 PULL_ROWS 行，
     * 一个包永远不拆开。跨批只有 `incoming`（墓碑）与 `incomingRes`（裁决）
     * 活着 —— 后一批的父墓碑要挡得住前面已经出现过的子行判定。
     * `applied` 每批落一次盘：第 N+1 批炸了，前 N 批的成果算数。
     */
    const incoming = new Map<string, Tombstone>()
    /** ★★ R-4-F-a · 本趟收到的裁决事实，和墓碑一样跨批累积 */
    const incomingRes = new Map<string, ResolutionFact>()
    /** ★★ R-4-F-a · 这一趟按「用本地的」留下来的行 —— 要带着新时间戳推出去 */
    const kept: KeptRow[] = []
    const conflicts: (MergePlan['conflicts'][number] & { chunk?: string })[] = []
    /** ★★ D-438 · 按时间自动定了的行 —— 被盖掉的那一版要落账 */
    const overridden: { row: SyncRow; local: SyncRow; kept: 'remote' | 'local'; lost: SyncRow }[] = []
    const blocked: (MergePlan['blocked'][number] & { chunk?: string })[] = []
    /** 合并阶段判「不用动」的行数 —— 聚合 `MergePlan` 还要用它 */
    let planSkipped = 0
    const failedRows: { row: SyncRow; message: string; chunk?: string }[] = []
    let purged = 0
    let backedUp = false
    /** 验收用：这一趟单批最多装过多少行 —— 分批有没有真的生效看它 */
    let maxBatchRows = 0

    let cursor = 0
    /** 验收用：这一趟分了几批 */
    let batches = 0

    /**
     * ★★ Step 6B · 批循环的**边界也由 core 说**：还有没处理的包时
     * `plan()` 给的是 `fetch`，处理完了给的是 `push`。
     */
    while (planStep(st, { outgoing: mine }).kind === 'fetch') {
      const batch: string[] = []
      /**
       * ★★ R-4-A · 记住每一行**来自哪个包** —— 「哪个包没应用干净」是
       * 重试机制的全部内容。用对象身份做键；每批一张、批末就丢。
       */
      const origin = new Map<SyncRow, string>()
      /** ★★ R-4-A · 本批「没处理完」的三份名单 —— 只收集事实，不下判断 */
      const rejectedHere = new Set<string>()
      /** ★★ Step 6C · 包头自称早于我上轮同步 —— 纯诊断，不参与任何判定 */
      const backdatedHere = new Set<string>()
      const remoteRows: SyncRow[] = []
      /** 行数上限只能边下边判 —— 当前这个包装不下就留给下一批，绝不拆开 */
      while (cursor < todo.length) {
        // ★★ R-4-C-a · 「装到这一批为止了吗」由 core 判（`batchIsFull`）
        if (batchIsFull(batch.length, remoteRows.length)) break
        const n = todo[cursor++]!
        batch.push(n)
        const body = await store.get(`nyx/chunks/${n}`)
        if (!body) continue

        /**
         * ★★ Step 1A · 开包之前先过三道：能不能解析 → 版本对不对 → 行长得对不对。
         * 任何一道不过就**整包拒绝**，绝不逐行去挑能收的（D-268：
         * 结构对不上时逐行收正是「悄悄丢字段」的来源）。
         */
        const reject = (code: RejectCode, reason: string): void => {
          rejections.push({ chunk: n, code, reason })
          rejectedHere.add(n)
        }

        let pack: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(body)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject('malformed', '这个变更包不是一份记录，没有收。')
            continue
          }
          pack = parsed as Record<string, unknown>
        } catch {
          // 以前这里是静默 continue，坏包会被当成空包标成已处理 —— 那是永不重试
          reject('malformed', '这个变更包读不出来（不是合法的 JSON），没有收。')
          continue
        }

        const verdict = classifyChunk(pack, me9)
        if (verdict.kind === 'reject') {
          reject(verdict.code, verdict.reason)
          continue
        }

        const checked = checkRows(pack['rows'], SYNC_TABLES as readonly string[])
        if (!checked.ok) {
          reject(checked.code, checked.reason)
          continue
        }

        if (verdict.kind === 'legacy') legacyChunks += 1
        const pushedAt = Number(pack['at'] ?? 0)
        if (lastAt > 0 && pushedAt > 0 && pushedAt < lastAt) backdatedHere.add(n)
        for (const row of checked.rows) {
          origin.set(row, n)
          if (verdict.kind === 'legacy') legacyRows.add(row)
          remoteRows.push(row)
          if (row.updatedAt > maxRemoteAt) maxRemoteAt = row.updatedAt
        }
      }
      batches++
      maxBatchRows = Math.max(maxBatchRows, remoteRows.length)
      /** ★ 这一批真的拿了哪几个包 —— 交回 core，游标由它走 */
      expect('fetch')
      st = applyStep(st, {
        step: 'fetch',
        packages: batch.map((name) => ({ name, header: null, rows: [] }))
      })

      /**
       * ★★ R-3 · 墓碑要在**普通实体行之前**生效。
       * 判据不能只查本地那张表 —— 还要把**本批带来的墓碑**先收进来。
       * ★ R-4-C-a · `incoming` 跨批累积。
       */
      const fresh: Tombstone[] = []
      for (const r of remoteRows) {
        if (r.table !== 'tombstones' || !r.data) continue
        const kind = String(r.data['kind'] ?? '')
        const target = String(r.data['target_uid'] ?? '')
        if (!kind || !target) continue
        const rawId = Number(r.data['target_id'] ?? NaN)
        const t: Tombstone = {
          targetUid: target,
          kind,
          purgedAt: Number(r.data['purged_at'] ?? 0),
          targetId: Number.isFinite(rawId) ? rawId : null
        }
        const prev = incoming.get(tombKey(kind, target))
        // 同一批里有两块碑，取**早的那一块** —— 挡得更严，宁可漏收不可复活
        if (!prev || t.purgedAt < prev.purgedAt) {
          incoming.set(tombKey(kind, target), t)
          fresh.push(t)
        }
      }

      const tombOfAsync = async (table: string, uid: string): Promise<Tombstone | undefined> =>
        incoming.get(tombKey(table, uid)) ?? (await this.localTomb(table, uid))

      /**
       * ★★ R-4-F-a · 本批带来的裁决，也要在**本批的行**判定之前就生效。
       * 两边都有时取**较大的** `rejected_up_to`：和 V25 那条触发器同一个方向。
       */
      for (const r of remoteRows) {
        if (r.table !== 'resolutions' || !r.data) continue
        const target = String(r.data['target_uid'] ?? '')
        const kind = String(r.data['kind'] ?? '')
        if (!target || !kind) continue
        const fact: ResolutionFact = {
          targetUid: target,
          kind,
          rejectedUpTo: Number(r.data['rejected_up_to'] ?? 0)
        }
        const prev = incomingRes.get(resKey(kind, target))
        if (!prev || fact.rejectedUpTo > prev.rejectedUpTo) {
          incomingRes.set(resKey(kind, target), fact)
        }
      }

      const resOfAsync = async (
        table: string,
        uid: string
      ): Promise<ResolutionFact | undefined> => {
        const here = incomingRes.get(resKey(table, uid))
        const mineRes = await this.localRes(table, uid)
        if (!here) return mineRes
        if (!mineRes) return here
        return here.rejectedUpTo >= mineRes.rejectedUpTo ? here : mineRes
      }

      /**
       * ★★ R-3-g · 父实体被终结的，它那些旧子行也一并挡掉。
       * 判据在 `core/tombstone.ts`，这里只负责把事实喂给它。
       */
      const terminated = await this.terminatedIndex(incoming)
      const fksCache = new Map<string, Relation[]>()
      for (const r of remoteRows) {
        if (!fksCache.has(r.table)) fksCache.set(r.table, await this.fksOf(r.table))
      }
      const parentBlocks = planParentBlocks({
        rows: remoteRows,
        terminated,
        fksOf: (t) => fksCache.get(t) ?? []
      })

      /**
       * ★ `planMerge` 的回调是同步的（core 纯函数）—— 把这一批要问的
       *   本地事实**先取齐**再喂进去，语义与逐行现查完全一致
       *   （原实现的每个回调也只按 (表, uid) 查一行，无顺序耦合）。
       */
      const localRowMap = new Map<string, SyncRow | undefined>()
      const tombMap = new Map<string, Tombstone | undefined>()
      const resMap = new Map<string, ResolutionFact | undefined>()
      const syncedMap = new Map<string, number | undefined>()
      for (const r of remoteRows) {
        const k = `${r.table}#${r.uid}`
        if (!localRowMap.has(k)) localRowMap.set(k, await this.localRow(r.table, r.uid))
        if (!tombMap.has(k)) tombMap.set(k, await tombOfAsync(r.table, r.uid))
        if (!resMap.has(k)) resMap.set(k, await resOfAsync(r.table, r.uid))
        if (!syncedMap.has(k)) syncedMap.set(k, await this.syncedOf(r.table, r.uid))
      }

      const raw = planMerge(
        remoteRows,
        (t, uid) => localRowMap.get(`${t}#${uid}`),
        (t, uid) => tombMap.get(`${t}#${uid}`),
        (r) => parentBlocks.get(rowKey(r.table, r.uid)),
        (t, uid) => resMap.get(`${t}#${uid}`),
        // ★★ Step 6C · 共同基版本 —— 因果判断的唯一依据
        (t, uid) => syncedMap.get(`${t}#${uid}`)
      )
      /**
       * ★★★ D-438 · **判据管认，引擎管处置。**
       *
       * `decideRow` 照旧把「两边都改过」如实判出来 —— D-201 的检测一个字没动，
       * 它那三十多条不变式用例也照旧在跑。变的只是**处置**：
       * 到了这里当场按 `updated_at` 新的那份定掉，**不再问他**
       * （他 2026-09-02 的原话：「我写的东西也按照时间线来弄，不然太麻烦了」）。
       *
       * ★ 第一版我把这一条做在了 `decideRow` 里 —— 那等于把冲突判据本身废掉，
       *   `npm run test:db` 当场 35 条红。**「不问他」是策略，不是判据。**
       *
       * ★ 被盖掉的那一版由 `noteOverrides` 落进 `ops_log` 留痕：
       *   不打扰他是他要的，悄悄弄丢他写的字不是。
       */
      const plan = this.autoResolve(raw, overridden, autoResolveOn)

      /**
       * ★★ R-4-F · **一个冲突只挡它自己，不挡整条流水线。**
       * D-201 要求的是「不许静默覆盖」+「问一句」，没有一个字要求整次同步停止。
       * 没裁决时 `applyResolution(plan, 'local')` 天然把冲突行排除在外。
       */
      const rows = applyResolution(plan, resolve ?? 'local')

      // 动库之前先备份 —— 同步是唯一一处「远端的东西写进本地库」的地方。整趟只备一次
      if (rows.length > 0 && !backedUp) {
        await this.ports.backup('before-sync')
        backedUp = true
      }
      /**
       * ★★ R-3 · 写入顺序**由 core 定**（`orderForWrite`）：碑在前，同类保持原序。
       * 顺序是跨平台不变量，写错是静默的（中途失败留下「东西进来了、碑还没有」）。
       */
      const ordered = orderForWrite(rows)

      /**
       * ★★ R-4-F-a · **裁决和它的后果，一起成功或者一起没发生。**
       * 同一个事务里：留下的行顶时间戳 + `resolutions` 记账 + 本批普通行。
       * `writeRows` 内部那层事务变成 SAVEPOINT，正常嵌套（inTx 分层）。
       */
      let written: WriteResult = { ok: 0, failed: [], skipped: [] }
      this.lastWriteOrder = ordered.map((x) => x.table) // ★ 只记一笔，见 writeOrder()
      // ★ 排完立刻自查：判据（checkWriteOrdering）和实现分开，一处错另一处会报
      violations.push(...auditWriteOrder(this.lastWriteOrder))
      await this.inTx(async () => {
        written = await this.writeRows(ordered, (r) => legacyRows.has(r))
        if (resolve === 'local' && plan.conflicts.length > 0) {
          for (const k of await this.keepLocal(plan.conflicts)) kept.push(k)
        }
      })

      /**
       * ★★ R-4-A · **没有完全应用干净的包，不许进 `applied`。**
       * 反过来也要成立：成功的包必须进去，否则每次同步都重下一遍。
       */
      const failedHere = new Set<string>()
      for (const f of written.failed) {
        const from = origin.get(f.row)
        if (from) failedHere.add(from)
      }
      /** ★★ R-4-F · 还有未裁决冲突的包也不许进 `applied` —— 下次重读是允许而且必要的 */
      const conflictedHere = new Set<string>()
      if (!resolve) {
        for (const c of plan.conflicts) {
          const from = origin.get(c.row)
          if (from) conflictedHere.add(from)
        }
      }

      /**
       * ★★ R-4-G-e · 这一批写完了 —— **原料一次交清，记账在 core**。
       * 平台层交上去的每一项都是可观察的事实，没有一个是判断。
       */
      expect('write')
      st = applyStep(st, {
        step: 'write',
        received: remoteRows.length,
        planSkipped: plan.skipped,
        applied: written.ok,
        skipped: written.skipped.length,
        failed: written.failed.map((f) => ({ chunk: origin.get(f.row), message: f.message })),
        conflicted: plan.conflicts.length,
        conflictChunks: [...conflictedHere],
        rejected: [...rejectedHere]
      })

      /**
       * ★★ R-3 · **收到墓碑，就把本地那一份也删掉。**
       * 走 `hardDelete` 那条唯一入口，级联、外键顺序照旧。幂等。
       * ★ R-4-C-a · 只执行**本批新到的**那些。
       */
      expect('purge')
      /**
       * ★★ Step 6C · 判成 `same` 的行：两边一模一样 = 被证明了的一致，
       * 共同基版本就是它。不记的话对面每正常改一次就要再问他一次。
       */
      for (const r of plan.agreed) await this.markAgreed(r.table, r.uid, r.updatedAt)

      purged += await this.applyTombstones(fresh, problems)
      st = applyStep(st, { step: 'purge', purged })

      /**
       * ★★ R-4-C-a · `applied` **每批落一次盘**。
       * ★★ R-4-A / R-4-F · 「哪几个包算处理完了」**由 core 给名单**——
       * 这里一个 `if` 都没有：拿到名单照着记。
       */
      const commit = expect('commitApplied').packages
      for (const n of commit) applied.add(n)
      await this.set('applied', JSON.stringify([...applied].slice(-500)))
      st = applyStep(st, { step: 'commitApplied', packages: commit })
      // ★ 落盘之后立刻反查一遍：该进的进了没有、该重试的还留着没有
      violations.push(
        ...auditCommit(
          planCommit({
            names: batch,
            rejected: [...rejectedHere],
            withFailedRows: [...failedHere],
            withUnresolvedConflicts: [...conflictedHere]
          }),
          [...applied]
        )
      )

      planSkipped += plan.skipped
      for (const f of written.failed) failedRows.push({ ...f, chunk: origin.get(f.row) })
      for (const c of plan.conflicts) conflicts.push({ ...c, chunk: origin.get(c.row) })
      for (const b of plan.blocked) blocked.push({ ...b, chunk: origin.get(b.row) })
      /**
       * ★ 选「用本地」时被丢掉的冲突行不在这里加进 `skipped` ——
       * 四个桶只在一处算（R-4-G-e），两边都加就是重复计数。
       */
      // `origin` / `remoteRows` 到这里就没人引用了，交给 GC
    }

    /**
     * ★★ R-4-F · 「还有几处冲突没裁决」从会话状态里取，不在这里再算一遍。
     * ★★ R-4-G-e · 四个桶从会话状态里取 —— 整趟只有 `apply()` 一处在算。
     */
    const unresolved = st.unresolved
    const t4 = st.tally
    /** 记账和报数只认这一个聚合后的 plan —— 四个桶的定义一个字没变 */
    const plan: MergePlan = { apply: [], conflicts, skipped: planSkipped, blocked, agreed: [] }

    // ★★ D-438 · 自动定了的，被盖掉的那一版必须留痕
    await this.noteOverrides(overridden)

    /**
     * ★★ R-4-F-a · 裁决产生的两样东西，**这一趟就要推出去**。
     * 补的只是「我自己刚刚改的这几行」，不是把拉下来的行重新收一遍。
     */
    for (const k of kept) {
      const had = mine.find((m) => m.table === k.table && m.uid === k.uid)
      if (had) {
        had.updatedAt = k.updatedAt
        if (had.data) had.data = { ...had.data, updated_at: k.updatedAt }
      } else {
        // 本趟收集被 PACK_ROWS 截断时会走到这里 —— 单独把这一行捞回来
        const row = await this.pushRow(k.table, k.uid)
        if (row) mine.push(row)
      }
      const res = await this.pushRow('resolutions', resolutionUid(k.uid))
      if (res && !mine.some((m) => m.table === 'resolutions' && m.uid === res.uid)) mine.push(res)
    }

    // ── 推：自己这边水位之后改过的行（上面已经收好了）──────────
    /** ★ 到这里 `plan()` 必须已经给出 `push` —— 它要是还在给 `fetch`，说明批循环提前退出了 */
    expect('push')
    if (mine.length > 0) {
      /** ★★ Step 1A · 包头带三样身份。老版本读到多出来的字段会直接忽略，推出去是安全的 */
      await store.put(
        `nyx/chunks/${me}-${startedAt}.json`,
        JSON.stringify({
          device: me,
          at: startedAt,
          schemaVersion: me9.schemaVersion,
          schemaFingerprint: me9.schemaFingerprint,
          protocolVersion: me9.protocolVersion,
          rows: mine
        })
      )
      /**
       * ★★ Step 6C · **推成功之后，才记「这一版确认同步过了」。**
       * 记的是 `mine` 这份**快照**里的版本（push race：他中途的编辑改的是
       * 数据库，改不到这个数组）。`put` 抛异常就整趟结束，一行都不记（幂等）。
       *
       * ★★ 判据：**推送只在「我不知道有任何分歧」时才建立共同基版本。**
       * 本趟出过冲突的行（不管他裁没裁决）只顶 `pushed`，绝不碰 `synced` ——
       * 顶了基版本就是替他答问题 / 静默盖掉他刚做的决定（R-4-F-a ⑩）。
       */
      const contested = new Set(conflicts.map((c) => `${c.row.table}#${c.row.uid}`))
      /**
       * ★★ F-3 · 回写之前先确认**这一行现在还在**。
       * 批循环里可能收到父级墓碑把它连基状态一起删了 —— 这里照旧快照回写
       * 就是「清理之后又被重建」。已被终结 = 合法的最终状态：什么都不记。
       */
      const stillHere = async (table: string, uid: string): Promise<boolean> => {
        try {
          return (
            (await this.db.get(`select 1 as x from "${table}" where uid = ?`, [uid])) !== undefined
          )
        } catch {
          return false
        }
      }
      for (const row of mine) {
        if (!(await stillHere(row.table, row.uid))) continue
        const k = `${row.table}#${row.uid}`
        if (contested.has(k)) await this.markPushed(row.table, row.uid, row.updatedAt)
        else await this.markAgreed(row.table, row.uid, row.updatedAt)
      }
    }
    await store.put(
      `nyx/devices/${me}.json`,
      JSON.stringify({ device: me, at: startedAt, pushed: mine.length })
    )

    // D-244 · 音频进同步。单独走文件 —— 内容哈希命名，天生幂等
    const audio = await this.syncAudio(store, problems)

    /**
     * 启动页图片进同步（使用者 2026-09-09：「win 和 android 可以有不同的启动页，
     * **共享的是图片资源**」）。和音频同一条道理：内容哈希命名，天生幂等，不会冲突。
     * ★ 没接端口的那一端整条不跑（`splash` 是可选的）。
     */
    const splash = this.ports.splash ? await this.syncSplash(store, problems) : 0

    /**
     * ★★ R-4-B + R-4-F · 水位推到哪里 —— **整个决定在 core**（`nextWatermark`），
     * 这里只负责落盘；水位是从 `plan()` 给的 `advanceWatermark` 那一步里拿的。
     */
    st = applyStep(st, { step: 'push', rows: mine.length })
    const nextWm = expect('advanceWatermark').to
    await this.set('watermark', String(nextWm))
    st = applyStep(st, { step: 'advanceWatermark', to: nextWm })
    // ★ 落盘之后自查：单调 + 冲突冻结。两条都不该报，报了就是编排坏了
    violations.push(...auditWatermark(wm, nextWm, unresolved))
    await this.set('lastAt', String(startedAt))
    await this.set('failStreak', '0') // 这一趟走到头了 —— 连败清零（D-373）

    /**
     * ★★ F-015 · 把见过的最大远端时间戳存下来（单调不回退）。
     *
     * 这是本机之外**唯一**的时钟参照 —— store 是哑的 blob 存储，没有服务端时钟。
     * 回收站的到期硬删会拿它跟本机时钟比一比再决定删不删
     * （硬删立墓碑、墓碑推出去不可撤销，见 core/purge-guard.ts）。
     *
     * ★ 单调是有意的：某一趟没拉到任何行（maxRemoteAt = 0）不能把参照清零，
     *   否则「不常同步」等于把这道闸关掉。
     */
    if (maxRemoteAt > 0) {
      const prevSeen = Number(await this.get('maxRemoteSeen', '0')) || 0
      if (maxRemoteAt > prevSeen) await this.set('maxRemoteSeen', String(maxRemoteAt))
    }

    /**
     * ★★ R-4-D / R-4-E · 报的数必须是**真的落库了几行**（不是尝试数）。
     * ★★ R-4-G-e · 界面上那句话和返回值**用的是同一份数**；四个桶自己对账，
     * 对不上**不抛** —— 变成他在数据体检里看得见的问题。
     */
    const leftOver = collected.truncated.reduce((n, x) => n + x.left, 0)
    violations.push(...auditTally(t4))
    this.lastViolations = violations
    /**
     * ★★ F-015 / T-2.5 · 时钟偏移的那句话。
     *
     * 它此前只落进 `sync.problems`（数据体检 + 设置页同步区那条通道）——
     * 而**同步结果这一行才是他每次都会看到的地方**：偏移影响的正是
     * 「两边都改过时谁赢」（D-438），那件事就发生在这一趟里，
     * 说在别处等于让他事后自己去把两件事对起来。
     * ★ 落 problems 的照旧，两处都要 —— 一处是当场看见，一处是查得回来。
     */
    const skewNote = describeClockSkew(clockSkewObservedMs(maxRemoteAt, Date.now()))
    const note =
      `推上去 ${mine.length} 行，收到 ${t4.received} 行 —— ` +
      `应用 ${t4.applied} 条，跳过 ${t4.skipped} 条` +
      (t4.conflicted > 0 ? `，「${t4.conflicted} 条两边都改过、等你决定」` : '') +
      /**
       * ★★ D-438 · 自动定了的要**说一句**。不打扰他 ≠ 不告诉他 ——
       * 被盖掉的那一版就在账本里（`ops_log` 的 `sync-override`），
       * 这句话是他唯一会看到的入口。
       */
      (overridden.length > 0
        ? `，「${overridden.length} 处两边都改过 —— 已按时间新的那版定，旧的那版记在账本里」`
        : '') +
      (t4.failed > 0 ? `，「失败 ${t4.failed} 条（下次同步会自动重来）」` : '') +
      `（云端新包 ${todo.length} 个，水位 ${wm}）` +
      (leftOver > 0 ? `。还有 ${leftOver} 行这一次没装下，再点一次「现在同步」接着推` : '') +
      (purged > 0 ? `，另一台删掉的 ${purged} 项这边也清掉了` : '') +
      (audio > 0 ? `，音频 ${audio} 个` : '') +
      (splash > 0 ? `，启动页图 ${splash} 张` : '') +
      (resolve && plan.conflicts.length > 0
        ? `，冲突 ${plan.conflicts.length} 处按「${resolve === 'remote' ? '云端' : '本地'}」处理`
        : '') +
      /** ★★ Step 1A · 整包被拒要说在最前面能看到的地方 —— 那不是「失败几条」，是根本没打开 */
      (rejections.length > 0
        ? `。「${rejections.length} 个变更包整包没有收」：${rejections[0]!.reason.split('\n')[0]}`
        : '') +
      (legacyChunks > 0 ? `（其中 ${legacyChunks} 个是老版本推的包，按兼容路径收的）` : '') +
      /** ★ T-2.5 · 时钟偏移放在最后 —— 它是这一趟的旁注，不是这一趟的结果 */
      (skewNote ? `。「${skewNote}」` : '')
    await this.set('lastNote', note)

    /**
     * ★★ R-3 / C-2 / Step 1A / R-4-F · 四类问题都落进他点得开的地方
     * （体检 + 设置页）。普通的墓碑拦截不记，只记 `postPurge` 那种。
     */
    /**
     * ★★ F-015 · 时钟偏移那句话是**纯诊断**：合并照收照用，只是把观测到的事实
     * 告诉他 ——「时钟错」和「数据真在未来」在协议层分不清，也不该替他猜。
     * ★ T-2.5 · 它现在同时进同步结果那一行（上面 `note` 的末尾），这里照旧再落一次问题。
     */
    await this.recordProblems([
      ...problems,
      ...(skewNote ? [{ kind: 'row' as const, what: '设备时钟', message: skewNote }] : []),
      ...collected.untranslatable.slice(0, 20).map((u) => ({
        kind: 'row' as const,
        what: `${u.table}/${u.uid}`,
        message: `这一行推不出去：${u.why}。去「设置 → 数据 → 数据体检」看看那条关系。`
      })),
      ...rejections.slice(0, 20).map((r) => ({
        kind: 'row' as const,
        what: `变更包 ${r.chunk}`,
        message: r.reason,
        chunk: r.chunk
      })),
      ...failedRows.slice(0, 50).map((f) => ({
        kind: 'row' as const,
        what: `${f.row.table}/${f.row.uid}`,
        message: f.message,
        chunk: f.chunk
      })),
      ...blocked
        .filter((b) => b.postPurge)
        .slice(0, 50)
        .map((b) => ({
          kind: 'row' as const,
          what: `${b.row.table}/${b.row.uid}`,
          message: b.reason,
          chunk: b.chunk
        })),
      ...(resolve
        ? []
        : conflicts.slice(0, 50).map((c) => ({
            kind: 'row' as const,
            what: `${c.row.table}/${c.row.uid}`,
            message:
              '两边都改过这一条 —— 去「设置 → 同步」选一边，冲突之外的内容已经正常同步了',
            chunk: c.chunk
          })))
    ])

    return {
      ...(await this.status()),
      ...t4,
      /** ★★ R-4-F · 有没裁决的冲突就把那句话带回去 —— 但这一趟已经写过、也推过了 */
      conflictNote: unresolved > 0 ? describeConflicts(plan, startedAt) : undefined,
      pushed: mine.length,
      leftOver,
      seen: t4.received,
      chunks: todo.length,
      wm,
      /** ★ R-4-C-a · 分批有没有真的生效，看这两个数 */
      batches,
      maxBatchRows,
      // ★★ Step 1A · 整包被拒的与走 legacy 路径的，分开报
      rejected: rejections.length,
      rejections: rejections.map((r) => ({ chunk: r.chunk, code: r.code, reason: r.reason })),
      legacyChunks
    }
  }

  /**
   * ★★ R-3 · 把收到的墓碑真的执行掉：本地还在的那一份，删。
   * 一块碑执行不了不该把整次同步带崩 —— 但也绝不许咽掉：记一笔，
   * 他在数据体检里看得见，下次同步还会再来一次（墓碑是同步表，它一直在）。
   */
  private async applyTombstones(tombs: Tombstone[], problems: SyncProblem[]): Promise<number> {
    let n = 0
    for (const t of tombs) {
      if (!needsTombstone(t.kind)) continue
      try {
        const row = (await this.db.get(`select id from "${t.kind}" where uid = ?`, [
          t.targetUid
        ])) as { id: number } | undefined
        if (!row) continue
        /**
         * ★★ F-2 · **不立碑**：这块碑已经在 `writeRows` 那一步落库了。
         * ★★ R-3-g · 碑上的 `target_id` 必须是**本机**那一行的号码 ——
         *   只补这一列，绝不碰 `purged_at` / `updated_at`（那是跨设备事实）。
         */
        await this.inTx(async () => {
          await this.db.run(`update tombstones set target_id = ? where target_uid = ? and kind = ?`, [
            row.id,
            t.targetUid,
            t.kind
          ])
          await hardDelete(this.db, t.kind, [row.id], undefined, 0, false)
        })
        n += 1
      } catch (err) {
        problems.push({
          kind: 'row',
          what: `${t.kind}/${t.targetUid}`,
          message: `另一台设备删掉了它，这边删不掉：${err instanceof Error ? err.message : String(err)}`
        })
      }
    }
    return n
  }

  /**
   * ★★ R-3-g · 被终结的父实体，按表分组。本地的碑 + 这一批带来的碑，两边都要。
   * ★★ C-2 · 收的是 **`target_uid`** —— 包里已经没有本地 id 了。
   */
  private async terminatedIndex(incoming: Map<string, Tombstone>): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>()
    const add = (kind: string, uid: string | null | undefined): void => {
      if (typeof uid !== 'string' || uid === '') return
      const set = out.get(kind) ?? new Set<string>()
      set.add(uid)
      out.set(kind, set)
    }
    try {
      const rows = (await this.db.all(`select kind, target_uid as targetUid from tombstones`)) as {
        kind: string
        targetUid: string
      }[]
      for (const r of rows) add(r.kind, r.targetUid)
    } catch {
      /* 这张表还没建出来（老库）—— 就是「没有任何终结」 */
    }
    for (const t of incoming.values()) add(t.kind, t.targetUid)
    return out
  }

  /**
   * 某张表要翻译的关系 · ★★ C-2 —— `pragma foreign_key_list` + `core/fk-map.ts`
   * 的明写清单合起来。一次同步里问一遍就够，`pragma` 不便宜。
   */
  private async fksOf(table: string): Promise<Relation[]> {
    const had = this.fkCache.get(table)
    if (had) return had
    let declared: Relation[] = []
    try {
      declared = (
        (await this.db.all(`pragma foreign_key_list("${table}")`)) as unknown as {
          table: string
          from: string
        }[]
      ).map((f) => ({ column: f.from, parent: f.table, syncColumn: syncColumnOf(f.from) }))
    } catch {
      /* 表不存在就是没有关系 */
    }
    const out = relationsOf(table, declared)
    this.fkCache.set(table, out)
    return out
  }

  /**
   * ★★ C-2 · 本地 id ↔ uid 的两张缓存。只在**一次 run 之内**有效。
   * `boundaryLookups` 量的是它有没有退化成按行查询（5000 行同一讲 → 1 次）。
   */
  private uidCache = new Map<string, string | null>()
  private idCache = new Map<string, number | null>()
  private lastWriteOrder: string[] = []
  private lastViolations: InvariantViolation[] = []
  /**
   * ★ T-2.10 · 上一趟 `run()` 列桶时**看见了几个包**（观察器，和上面那几个同层）。
   *
   * 「桶里包数到线就压」要一个数，而这个数 `run()` 自己已经列过一次了 ——
   * 为它再发一次 PROPFIND 是纯浪费（手机上还是流量）。
   * ★ `-1` = 这个实例还没跑过同步，**不知道**；不知道就不按包数压
   *   （`shouldCompact` 里那一条）。触发点永远紧跟在 `run()` 之后，所以不会读到隔夜的数。
   */
  private lastBucketPacks = -1
  private stateLookups = 0
  private pendingQueries = 0
  private lookups = 0

  /** ★★ Step 6B · 上一趟 core 判据查出来的违规。只读，验收用 —— 不空 = 编排坏了 */
  violations(): readonly InvariantViolation[] {
    return this.lastViolations
  }

  writeOrder(): readonly string[] {
    return this.lastWriteOrder
  }

  /** ★★ Step 7E · #18 · 基状态查了几次库 —— 和 `boundaryLookups` 分开计 */
  stateLookupCount(): number {
    return this.stateLookups
  }

  /** ★ 待推查询跑了几条 SQL —— 必须是**每表一条**，不许按行 */
  pendingQueryCount(): number {
    return this.pendingQueries
  }

  boundaryLookups(): number {
    return this.lookups
  }

  private async uidOfId(table: string, id: number): Promise<string | null> {
    const k = `${table}#${id}`
    if (this.uidCache.has(k)) return this.uidCache.get(k) ?? null
    this.lookups += 1
    let uid: string | null = null
    try {
      const r = (await this.db.get(`select uid from "${table}" where id = ?`, [id])) as
        | { uid: string | null }
        | undefined
      uid = r?.uid ?? null
    } catch {
      uid = null
    }
    this.uidCache.set(k, uid)
    return uid
  }

  private async idOfUid(table: string, uid: string): Promise<number | null> {
    const k = `${table}#${uid}`
    if (this.idCache.has(k)) return this.idCache.get(k) ?? null
    this.lookups += 1
    let id: number | null = null
    try {
      const r = (await this.db.get(`select id from "${table}" where uid = ?`, [uid])) as
        | { id: number }
        | undefined
      id = r?.id ?? null
    } catch {
      id = null
    }
    this.idCache.set(k, id)
    return id
  }

  /**
   * ★★ Step 6C · 行级同步基状态 —— **本地专有，一个字节都不上线。**
   *   `syncedOf`  我已经处理/对账到的那个**远端**版本 → merge 的共同基版本
   *   `pushed`    我已经成功交给远端存储的那个**本地**版本 → 只管待推
   * ★ 两个都是**版本标记**，判据是「等不等于当前版本」，不是谁大谁小。
   */
  private syncedCache = new Map<string, number | undefined>()

  private async syncedOf(table: string, uid: string): Promise<number | undefined> {
    const k = `${table}#${uid}`
    if (this.syncedCache.has(k)) return this.syncedCache.get(k)
    let v: number | undefined
    try {
      const r = (await this.db.get(
        `select synced_updated_at as v from row_sync_state where table_name = ? and uid = ?`,
        [table, uid]
      )) as { v: number | null } | undefined
      v = r?.v ?? undefined
    } catch {
      v = undefined
    }
    this.stateLookups += 1
    this.syncedCache.set(k, v)
    return v
  }

  /**
   * ★★ 收下了一个远端版本 —— **两个都顶。**（这一版本来就来自云端，
   * 不顶 `pushed` 它会被当成本地改动弹回云端 —— R-4-C-a。）
   * ★ 只在**写进去了**之后调。写失败那条路一个字都不许记。
   */
  private async markAgreed(table: string, uid: string, version: number): Promise<void> {
    await this.writeState(table, uid, version, version)
    this.syncedCache.set(`${table}#${uid}`, version)
  }

  /**
   * ★★ F-4 · 他按了「用本地的」—— **那也是一次处理**。基版本顶到被拒的那一版：
   * 老包重放不再问第二遍；对面出 V4 → 再次冲突（对）。只动 `synced`。
   */
  private async markReconciled(table: string, uid: string, remoteVersion: number): Promise<void> {
    await this.writeState(table, uid, remoteVersion, undefined)
    this.syncedCache.set(`${table}#${uid}`, remoteVersion)
  }

  /**
   * ★★ 本地版本推成功了 —— **只顶 `pushed`，绝不碰 `synced`。**
   * 推送成功证明的是投递，不是对账 —— store 是哑存储，没有 ack。
   */
  private async markPushed(table: string, uid: string, version: number): Promise<void> {
    await this.writeState(table, uid, undefined, version)
  }

  /** 两个字段各自可选地前进；`undefined` = 这一次不碰它 */
  private async writeState(
    table: string,
    uid: string,
    synced: number | undefined,
    pushed: number | undefined
  ): Promise<void> {
    const now = Date.now()
    try {
      await this.db.run(
        `insert into row_sync_state (table_name, uid, synced_updated_at, pushed_updated_at, updated_at)
           values (?, ?, ?, ?, ?)
         on conflict(table_name, uid) do update set
           synced_updated_at = coalesce(excluded.synced_updated_at, row_sync_state.synced_updated_at),
           pushed_updated_at = coalesce(excluded.pushed_updated_at, row_sync_state.pushed_updated_at),
           updated_at        = excluded.updated_at`,
        [table, uid, synced ?? null, pushed ?? null, now]
      )
    } catch {
      /**
       * ★ 记不上基状态**绝不许把同步带崩**。后果只是这一行下次被当成
       * 「没确认过」再走一遍 —— 幂等。和漏数据不对称。
       */
    }
  }

  private clearBoundaryCaches(): void {
    this.syncedCache.clear()
    this.uidCache.clear()
    this.idCache.clear()
    this.lookups = 0
    this.stateLookups = 0
    this.pendingQueries = 0
  }

  /** ★★ R-3 · 本地那块碑。判据在 `core/tombstone.ts`，这里只把事实取出来 */
  private async localTomb(table: string, uid: string): Promise<Tombstone | undefined> {
    try {
      return (await this.db.get(
        `select target_uid as targetUid, kind, purged_at as purgedAt
           from tombstones where kind = ? and target_uid = ?`,
        [table, uid]
      )) as Tombstone | undefined
    } catch {
      // 这张表还没建出来（老库）就是「没有墓碑」，不该让整次同步炸掉
      return undefined
    }
  }

  /** ★★ R-4-F-a · 本地那条裁决。判据走 `core/resolution.ts`，全项目一份 */
  private async localRes(table: string, uid: string): Promise<ResolutionFact | undefined> {
    try {
      return (await this.db.get(
        `select target_uid as targetUid, kind, rejected_up_to as rejectedUpTo
           from resolutions where kind = ? and target_uid = ?`,
        [table, uid]
      )) as ResolutionFact | undefined
    } catch {
      return undefined
    }
  }

  /**
   * ★★ R-4-F-a · 他按下「用本地的」那一刻，落库的两件事（调用方包在事务里）：
   *   ① 留下的那一行时间戳顶到被拒版本之后 ② `resolutions` 记 `rejected_up_to`。
   * 同一行好几版取最大；`resolutions` 只 insert 不写 on conflict ——
   * V25 那条触发器就地 `max` 合并再 `raise(ignore)`，判据只有那一处。
   * ★ 除了 `updated_at` 什么都不动 —— 他按的是「用本地的」，不是「改这一行」。
   */
  private async keepLocal(conflicts: MergePlan['conflicts']): Promise<KeptRow[]> {
    const now = Date.now()
    /** 同一行的好几版：只留最晚的那个时间戳 */
    const worst = new Map<string, { table: string; uid: string; upTo: number }>()
    for (const c of conflicts) {
      const k = `${c.row.table} ${c.row.uid}`
      const had = worst.get(k)
      if (!had || c.remoteAt > had.upTo) {
        worst.set(k, { table: c.row.table, uid: c.row.uid, upTo: c.remoteAt })
      }
    }

    const out: KeptRow[] = []
    for (const w of worst.values()) {
      const at = keptUpdatedAt(now, w.upTo)
      await this.db.run(`update "${w.table}" set updated_at = ? where uid = ?`, [at, w.uid])
      await this.db.run(
        `insert into resolutions (uid, target_uid, kind, rejected_up_to, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        [resolutionUid(w.uid), w.uid, w.table, w.upTo, now, now]
      )
      /** ★★ F-4 · 他处理完 `w.upTo` 那一版了 —— 基版本跟着顶上去 */
      await this.markReconciled(w.table, w.uid, w.upTo)
      out.push({ table: w.table, uid: w.uid, updatedAt: at })
    }
    return out
  }

  /** 把库里的某一行取成可推送的样子（裁决之后要补推的那几行用） */
  private async pushRow(table: string, uid: string): Promise<SyncRow | undefined> {
    try {
      const r = (await this.db.get(`select * from "${table}" where uid = ?`, [uid])) as
        | Record<string, unknown>
        | undefined
      if (!r) return undefined
      return { uid, table, updatedAt: Number(r['updated_at'] ?? 0), data: r }
    } catch {
      return undefined
    }
  }

  private async localRow(table: string, uid: string): Promise<SyncRow | undefined> {
    try {
      const r = (await this.db.get(`select * from "${table}" where uid = ?`, [uid])) as
        | Record<string, unknown>
        | undefined
      if (!r) return undefined
      return { uid, table, updatedAt: Number(r['updated_at'] ?? 0), data: r }
    } catch {
      return undefined
    }
  }

  /**
   * 收集要推的行 · ★★ R-4-B ——「一次装不下」不再等于「悄悄丢掉」。
   * PACK_ROWS 是**一个变更包的体积闸**；超出就只把水位推到真正推完的位置，
   * 水位本身就是游标。边界那一毫秒的行**整组带上**（切在同一毫秒中间会
   * 永远跳过同伴或原地打转）。
   *
   * ★★ Step 6C · 待推的判据是**逻辑的**，不再问时钟：
   *   待推 ⟺ 这一行的当前版本 ≠ 我确认同步过的那一版
   * 完备性可证（与时钟无关）；进展靠推成功后基版本前进保证。
   *
   * ★★ C-2 · **推之前把本地 id 翻成 uid** —— 包里从此没有 id。
   * 父行的 uid 查不到就**整行不推**、记一笔、卡住水位（绝不发 null 出去）。
   */
  private async collectSince(_wm: number): Promise<Collected> {
    const out: SyncRow[] = []
    const truncated: Collected['truncated'] = []
    const untranslatable: Collected['untranslatable'] = []

    const push = async (t: string, r: Record<string, unknown>): Promise<void> => {
      const uid = String(r['uid'] ?? '')
      if (!uid) return // 没 uid 的行不推 —— 推上去对面认不出是谁
      const fks = await this.fksOf(t)
      /**
       * ★ `toSync` 的翻译回调是同步的（core 纯函数），而查库是异步的 ——
       *   用「探针 → 补齐 → 重跑」收敛：先跑一遍记下它真正要问的
       *   (父表, id) 对（含 dynamicOf 的动态关系 —— picks.scope_id 就走那条），
       *   把答案取齐再跑一遍。toSync 是纯函数，最后那遍与逐问逐答完全等价。
       *   一行的关系列有限，轮数有上界；缓存照旧兜住 N+1。
       */
      const answers = new Map<string, string | null>()
      for (let round = 0; ; round++) {
        if (round > 8) {
          untranslatable.push({ table: t, uid, why: '关系翻译没有收敛（引擎自查）', at: Number(r['updated_at'] ?? 0) })
          return
        }
        const misses: [string, number][] = []
        const conv = toSync(t, r, fks, dynamicOf(t), (parent, id) => {
          const k = `${parent}#${id}`
          if (answers.has(k)) return answers.get(k)!
          misses.push([parent, id])
          return null
        })
        if (misses.length > 0) {
          for (const [parent, id] of misses) {
            answers.set(`${parent}#${id}`, await this.uidOfId(parent, id))
          }
          continue
        }
        if (!conv.ok) {
          untranslatable.push({ table: t, uid, why: conv.why, at: Number(r['updated_at'] ?? 0) })
          return
        }
        out.push({ uid, table: t, updatedAt: Number(r['updated_at'] ?? 0), data: conv.data })
        return
      }
    }

    for (const t of SYNC_TABLES) {
      let rows: Record<string, unknown>[]
      try {
        this.pendingQueries += 1
        rows = await this.db.all(
          `select t.* from "${t}" t
             left join row_sync_state s
               on s.table_name = ? and s.uid = t.uid
            where t.updated_at <> 0
              and (s.pushed_updated_at is null
                   or s.pushed_updated_at <> t.updated_at)
            order by t.updated_at
            limit ?`,
          [t, PACK_ROWS + 1]
        )
      } catch {
        continue
      }

      if (rows.length <= PACK_ROWS) {
        for (const r of rows) await push(t, r)
        continue
      }

      const take = rows.slice(0, PACK_ROWS)
      const edge = Number(take[take.length - 1]!['updated_at'] ?? 0)
      for (const r of take) await push(t, r)
      /** 边界那一毫秒的同伴全带上；★ Step 6C · 只带**还没推过**的 */
      const same = await this.db.all(
        `select t.* from "${t}" t
           left join row_sync_state s
             on s.table_name = ? and s.uid = t.uid
          where t.updated_at <> 0
            and (s.pushed_updated_at is null or s.pushed_updated_at <> t.updated_at)
            and t.updated_at = ?`,
        [t, edge]
      )
      const got = new Set(take.map((r) => String(r['uid'] ?? '')))
      for (const r of same) if (!got.has(String(r['uid'] ?? ''))) await push(t, r)

      const left = Number(
        (
          (await this.db.get(
            `select count(*) as n from "${t}" t
               left join row_sync_state s
                 on s.table_name = ? and s.uid = t.uid
              where t.updated_at <> 0
                and (s.pushed_updated_at is null or s.pushed_updated_at <> t.updated_at)
                and t.updated_at > ?`,
            [t, edge]
          )) as { n: number } | undefined
        )?.n ?? 0
      )
      if (left > 0) truncated.push({ table: t, left, edge })
    }

    /** ★★ 「这一趟真正推到哪个时刻」**由 core 折叠**（`pushedUpTo`）—— SQL 在这里，取哪个数不在 */
    return {
      rows: out,
      truncated,
      upTo: pushedUpTo({ truncated, untranslatable }),
      untranslatable
    }
  }

  /**
   * 按 uid 覆盖写入，**结果是返回值，不是异常，也不是 console** · ★★ R-4-A / R-4-E
   * 「成了几行、哪几行没成」原样交出去，由 `run()` 决定哪些包不许进 `applied`。
   * 重放安全：已落库的行被 `planMerge` 判成 `same` 跳过；upsert 冲突目标是 uid。
   */
  private async writeRows(
    rows: SyncRow[],
    isLegacy: (r: SyncRow) => boolean = () => true
  ): Promise<WriteResult> {
    const out: WriteResult = { ok: 0, failed: [], skipped: [] }
    if (rows.length === 0) return out
    await this.inTx(async () => {
      for (const r of rows) {
        if (!r.data) {
          /** ★ R-4-G-e · 没有数据的行也要**落进一个桶** —— 恒等式从 continue 那里漏 */
          out.skipped.push({ row: r, why: '这一行没有数据 —— 不是本软件推上来的包' })
          continue
        }
        /**
         * ★ 归一只改**要写下去的那份数据**，不改 `r` 本身 —— `r` 是对象身份，
         * `origin` 那张 Map 拿它当键反查「是哪个包」。换新对象 = 坏包被当好包
         * 标 applied、从此不再重试（R-4-A 三条用例当场抓过）。
         */
        let data: Record<string, unknown> = r.data

        /**
         * ★★ R-4-G · 出厂内容：**不相信远端包里那个 uid，自己重算一遍。**
         * 题型能可靠重算（key 就是身份）；另外三张认出厂序位，一行数据里
         * 推不出来 → 非 canonical 就明确跳过，不猜（猜错 = 甲导师盖成乙导师）。
         */
        if (isBuiltinTable(r.table) && Number(data['builtin'] ?? 0) === 1) {
          const want = canonicalUid(r.table, {
            builtin: 1,
            key: (data['key'] as string | undefined) ?? null
          })
          if (want) {
            data = { ...data, uid: want }
          } else if (!isCanonicalUid(String(data['uid'] ?? ''))) {
            out.skipped.push({
              row: r,
              why: '这是升级前推上去的出厂内容，认不出是哪一条 —— 没有猜，跳过了'
            })
            continue
          }
        }

        /**
         * **`id` 照原样写进去**，不能丢 —— 让本地自增会把每一条外键指错
         * （不报错，只是知识点忽然挂到别的讲上）。撞 id 是主键冲突，会抛、会计入失败。
         *
         * ★★ C-2 · **收之前把 uid 翻回本地 id。** 父行还没到就整行失败 ——
         * 不猜 id、不自动建父行。失败让那一包不进 `applied`，下次父行到了自然成。
         */
        const fks = await this.fksOf(r.table)
        /** ★ 与 collect 同款「探针 → 补齐 → 重跑」—— 动态关系也要翻（见那边注释） */
        const answers = new Map<string, number | null>()
        let conv: ReturnType<typeof toLocal> | null = null
        for (let round = 0; round <= 8; round++) {
          const misses: [string, string][] = []
          const attempt = toLocal(r.table, data, fks, dynamicOf(r.table), (parent, uid) => {
            const k = `${parent}#${uid}`
            if (answers.has(k)) return answers.get(k)!
            misses.push([parent, uid])
            return null
          })
          if (misses.length === 0) {
            conv = attempt
            break
          }
          for (const [parent, uid] of misses) {
            answers.set(`${parent}#${uid}`, await this.idOfUid(parent, uid))
          }
        }
        if (conv === null) {
          out.failed.push({ row: r, message: '关系翻译没有收敛（引擎自查）' })
          continue
        }
        if (!conv.ok) {
          out.failed.push({ row: r, message: conv.why })
          continue
        }
        data = conv.data

        /**
         * ★★ **列以本机为准**（R-3-h 真机撞出来的：历史包带着本机已不存在的列）。
         * ★★ Step 1A · 「丢掉不认识的列」只有 legacy 那条路能走（D-268）——
         * 新包指纹相等还冒出未知列 = 指纹算错或包被改过，当场算失败。
         * ★ 一列都不认识 → 照旧报失败（那是包坏了，悄悄跳过才是把问题咽掉）。
         */
        const known = await this.columnsOf(r.table)
        const cols = Object.keys(data).filter((c) => known.has(c))
        const unknown = Object.keys(data).filter((c) => !known.has(c))

        if (unknown.length > 0 && !isLegacy(r)) {
          out.failed.push({
            row: r,
            message:
              `这一行带着本机没有的列（${unknown.slice(0, 5).join('、')}）—— ` +
              `两端的数据库结构编号说是一样的，实际却对不上，没有写。`
          })
          continue
        }

        if (cols.length === 0) {
          if (Object.keys(data).length > 0) {
            out.failed.push({
              row: r,
              message: `这一行的列本机一个都不认识（${Object.keys(data).slice(0, 5).join('、')}）`
            })
          }
          continue
        }
        const marks = cols.map(() => '?').join(',')
        const sets = cols.map((c) => `"${c}" = excluded."${c}"`).join(', ')
        try {
          // 单条语句失败只回滚它自己（SQLite 语句级原子性），批事务继续 —— 原语义
          await this.db.run(
            `insert into "${r.table}" (${cols.map((c) => `"${c}"`).join(',')}) values (${marks})
               on conflict(uid) do update set ${sets}`,
            cols.map((c) => data[c])
          )
          out.ok += 1
          /** ★★ Step 6C · **写进去了才算确认同步到这一版。** 失败那条路一个字都不记 */
          await this.markAgreed(r.table, r.uid, r.updatedAt)
        } catch (err) {
          // 一行写不进去（外键指向的东西还没同步过来、主键撞车之类）
          // 不该让整批失败 —— 但**必须被数出来**
          out.failed.push({ row: r, message: err instanceof Error ? err.message : String(err) })
        }
      }
    })
    return out
  }

  /**
   * D-244 ·「TTS 音频**进同步**、不进备份」。
   * 文件名是内容哈希，两边比一下文件名就够了 —— 不需要时间戳，也不会冲突。
   * ★★ Step 1D · F-08 · **名字是远端给的，落盘之前先验**（`core/audio-name.ts`
   * 白名单）。拒绝只影响这一个文件：记一笔、跳过、继续传别的。
   */
  private async syncAudio(store: RemoteStore, problems: SyncProblem[]): Promise<number> {
    const local = new Set((await this.ports.audio.list()).filter((f) => f.endsWith('.mp3')))
    let moved = 0

    const remote = new Set((await store.list('nyx/audio')).map((n) => n.replace(/\.json$/, '')))
    for (const f of local) {
      if (remote.has(f)) continue
      const b = await this.ports.audio.read(f)
      if (b === null) continue
      await store.put(`nyx/audio/${f}.json`, JSON.stringify({ name: f, b64: b }))
      moved += 1
      if (moved >= 50) break // 一次别传太多，下次接着传
    }
    for (const f of remote) {
      if (local.has(f)) continue
      const verdict = checkAudioName(f)
      if (!verdict.ok) {
        problems.push({
          kind: 'row',
          what: `nyx/audio/${f}`,
          message: `云端有一个名字不合规的音频文件，没有下载（${verdict.why}）。`
        })
        continue
      }
      const body = await store.get(`nyx/audio/${f}.json`)
      if (!body) continue
      try {
        const { b64 } = JSON.parse(body) as { b64: string }
        await this.ports.audio.write(f, b64)
        moved += 1
      } catch {
        /* 坏包跳过 */
      }
      if (moved >= 100) break
    }
    return moved
  }

  /**
   * 启动页图片进同步（使用者 2026-09-09「共享的是图片资源」）。
   *
   * ★ 和 `syncAudio` 逐行同形，**有意的** —— 两条流的失败模式一样，
   *   读代码的人只需要理解一次。差别只有三处，每处都有原因：
   *     ① 名字判据是 `checkSplashName`（四种图片扩展名，不是 `.mp3`）
   *     ② 上传上限 20（图比音频大得多；音频那条是 50）
   *     ③ 报出来的话说「启动页图」，不说「音频」
   *
   * ★★ F-08 那条在这里同样成立、而且**更要紧**：名字是远端给的，
   *   落盘之前先过白名单。这是全仓第二处「外部名字拼本地路径」。
   *   拒绝只影响这一个文件：记一笔、跳过、继续传别的。
   *   ☞ 负向对照钉在 `splash-sync.test.ts`：把这道闸拆掉，那一条当场红。
   *
   * ★ 单张大小在**收进来那一刻**挡（`main/resources.ts`）。这里不再挡一次 ——
   *   桶里出现超大文件只可能是别的端写的，那是那一端的闸该管的事；
   *   这里挡会变成第二份判据，而两份判据必然漂。
   *
   * ★★★ **必须逐个 `await`，绝不许改成 `Promise.all`。**
   *
   *   这是这条流在**手机上**唯一致命的地方，而在桌面上**完全测不出来**：
   *   逐个跑的时候，每张的 `b64` 出了那一圈就没人引用了，峰值是**一张**。
   *   改成并发，峰值就变成**一批** —— Android 会话给的实数（它那半边我看不见）：
   *     8MB 的图 → base64 约 10.7MB 字符串 → JS 里是 UTF-16 约 21MB
   *     → `JSON.stringify` 再复制一整份（还要转义）→ 单张瞬时 ~43MB
   *     → 再加 Capacitor 桥那一份和原生侧那一份 → **单张大约 60–80MB**
   *   一批 20 张并发 = 直接 OOM。桌面上内存宽裕，跑一万遍也不会红。
   *   ☞ 谁要为了「快一点」动这个循环，先读这一段。
   */
  private async syncSplash(store: RemoteStore, problems: SyncProblem[]): Promise<number> {
    const port = this.ports.splash
    if (!port) return 0
    let moved = 0

    /**
     * ══ ★★★ 顺序是这一条的命门：**先服从删除，再推，再拉**（2026-09-14）══
     *
     * 使用者裁「选 a：连桶一起删」。墓碑是 `<name>.meta.json` 里的 `gone`。
     * 三步的顺序不能换，换了就变成「删了又回来」：
     *
     *   ① 先把名字 / 墓碑这一趟合完，并且**当场执行删除**
     *      （本机文件删掉 ＋ 桶里那个对象删掉）。
     *   ② 再推：这时候还留在本地的文件，**一定不是「还没同步到的旧拷贝」** ——
     *      墓碑刚刚已经把那些删干净了。所以剩下的只能是他**又加回来的**。
     *      （这正是「不许复活」和「重新上传同一张图」两条能同时成立的原因。）
     *   ③ 最后拉：带着墓碑的那些不拉，否则刚删完又下回来。
     *
     * ★ 反过来（先推后删）会出事：本地那份还在的那一端会把图重新推上桶，
     *   把对面刚立的墓碑盖成「它还活着」—— 而屏上什么都不会说。
     */
    const meta = await this.syncSplashNames(store, problems)

    /** ①-b 执行：赢家说 `gone` 的那些，本机和桶里都清掉 */
    for (const [name, v] of Object.entries(meta)) {
      if (!isGone(v)) continue
      if (!checkSplashName(name).ok) continue
      /** ★ 两处都要清。只清一处的话，另一处下一趟又把它带回来 */
      await port.delete(name)
      try {
        await store.delete(`nyx/splash/${name}.json`)
      } catch (e) {
        /**
         * ★ 桶里删不掉**要说出来**：本机那份已经没了，而桶里还留着 ——
         *   换一台机器同步下来还会看到它。静默的话他只会觉得「删了又回来」，
         *   而那正是这一整条要治的毛病。
         */
        problems.push({
          kind: 'row',
          what: `nyx/splash/${name}`,
          message:
            `本机那张启动页图删掉了，但「云端那份没删成」（${String(e)}）。` +
            `换一台机器同步下来可能还会看到它 —— 下一趟同步会再试一次。`
        })
      }
    }

    /** ★ 名单要在①之后重新读：刚刚可能删掉了几张 */
    const local = new Set((await port.list()).filter((f) => checkSplashName(f).ok))

    /**
     * ★★ **`.meta.json` 不能被当成图片。**
     *   `store.list('nyx/splash')` 会把名字那一份一起列出来；不排掉的话
     *   下面那个循环会把 `<sha>.webp.meta` 当成一张「名字不合规的图」，
     *   于是**每同步一次就往体检里塞一条假问题** —— 而假问题会让真问题没人看。
     */
    const listed = await store.list('nyx/splash')
    const remote = new Set(
      listed.filter((n) => !isMetaEntry(n)).map((n) => n.replace(/\.json$/, ''))
    )
    for (const f of local) {
      if (remote.has(f)) continue
      /**
       * ★★ 带着墓碑的不推（「不许复活」，2026-09-14）。
       *   走到这里还留在本地、而墓碑又赢着 —— 只可能是上面①那一步没删成
       *   （文件被占用之类）。那种时候**宁可这一轮不推**：推上去等于
       *   一台还没删干净的机器把对面刚删的图又塞回桶里。
       * ★ 他**真的又加回来**那一张时，`main/resources.ts` 的导入那一步
       *   会写一份 `gone: false` ＋ 新的 `at`，墓碑就翻过来了 —— 那时这里放行。
       */
      if (isGone(meta[f])) continue
      const b = await port.read(f)
      if (b === null) continue
      await store.put(`nyx/splash/${f}.json`, JSON.stringify({ name: f, b64: b }))
      moved += 1
      if (moved >= 20) break // 图比音频大，一次少传几张，下次接着传
    }
    for (const f of remote) {
      if (local.has(f)) continue
      /** ★ 墓碑赢着的不拉 —— 刚删完又下回来是这一整条要治的那个毛病 */
      if (isGone(meta[f])) continue
      const verdict = checkSplashName(f)
      if (!verdict.ok) {
        problems.push({
          kind: 'row',
          what: `nyx/splash/${f}`,
          message: `云端有一个名字不合规的启动页图，没有下载（${verdict.why}）。`
        })
        continue
      }
      const body = await store.get(`nyx/splash/${f}.json`)
      if (!body) continue
      try {
        const { b64 } = JSON.parse(body) as { b64: string }
        await port.write(f, b64)
        moved += 1
      } catch {
        /* 坏包跳过 */
      }
      if (moved >= 40) break
    }

    return moved
  }

  /**
   * 启动页图片的**名字** · 两端同步，最后一次修改为准（使用者 2026-09-13）
   *
   * 他的原话：「同一张图片在两端都存在，名称保持一致。任意一端修改了名称，同步到
   * 另一端。两端在不同时间分别修改了同一张图片的名称：**以最后一次修改的名称为准**。」
   *
   * ══ 为什么名字跟着资源走、而「选了哪张」不跟 ═══════════════
   * D-480 定的是「资源共享 · 选了哪张各端自管」。名字**不是**「本机选了哪张」，
   * 它是资源本身的属性 —— 同一张图在两端理应同名。**只有名字这一半被推翻。**
   *
   * ══ 放在桶里、和图并排，不塞进图自己那个 json ═══════════════
   * 塞进去的话，**改一个名字就要重传整张图的 base64**（2MB 的图为了改几个字
   * 整个重上传），还会把上面那个 `moved >= 20` 的配额吃掉。
   * 走同步表也不行：图的数量无上限，`PREF_KEYS` 白名单撑不住。
   * （三条路都是 Nyx-UI-Android 列的，理由采纳。）
   *
   * ══ 谁赢：`core/splash-names.ts::pickLabel`，全仓唯一一处 ═══
   * 两端各写一份必然在某个边角上不一致，而不一致的表现是**两台机器轮流
   * 把名字改回自己那一份** —— 最难查的那种抖动。
   *
   * ══ ★★ 时钟偏移 ═══════════════════════════════════════════
   * 「最后一次为准」需要一个可信的钟，而两端的钟会偏。某一端快一天，
   * 它改的名字就**永久赢**，对面怎么改都翻不过来，**而且屏上什么都不报**。
   * 所以超前太多时记一条体检问题 —— **不钳制、不改值**：
   * 钳了的话他的改名会莫名其妙失效，那比钟偏更难解释。
   */
  private async syncSplashNames(
    store: RemoteStore,
    problems: SyncProblem[]
  ): Promise<Record<string, SplashLabel>> {
    const port = this.ports.splashLabels
    /**
     * ★ 没接名字端口的那一端**拿不到墓碑**，于是删除同步不了 —— 这是
     *   有意的、也是可见的：那一端本来就没有「名字」这个概念。
     *   回一张空表，上面那三步就都当「没人表过态」处理。
     */
    if (!port) return {}

    const seen = Number(await this.get('maxRemoteSeen', '0')) || 0
    /**
     * ★★ I-178 · **本机是谁**。和同步包里那个设备号同一个来源，不另铸一份 ——
     *   两份编号迟早会在某个边角上不一致，而不一致的表现是「本机认不出自己写的 meta」，
     *   也就是这条 bug 原样复发。
     */
    const me = await this.deviceId()
    const local = await port.read()
    const next: Record<string, SplashLabel> = { ...local }

    /* ── 拉：远端的名字和本地比一比 ── */
    for (const entry of await store.list('nyx/splash')) {
      if (!isMetaEntry(entry)) continue
      const name = nameOfMeta(entry)
      if (!checkSplashName(name).ok) continue
      const remote = decodeMeta(await store.get(`nyx/splash/${entry}`))
      if (!remote) continue
      const ahead = remoteMetaSkew(remote, me, seen)
      if (ahead > 0) {
        problems.push({
          kind: 'row',
          what: `nyx/splash/${name}`,
          /**
           * ★★ K-5（I-178 收尾）· 和回收站那条闸同一口径（I-188）：
           *   **一个条件两种成因，都说，一个都不判定。**
           *   `ahead = meta.at − maxRemoteSeen`，而 `maxRemoteSeen` 是**别的设备最后一次
           *   改数据**的时间戳 —— 所以差得大既可能是它的钟快了，也可能只是它这段时间
           *   没改过数据。原来那句直接断言「那一端的时钟可能不准」，是替他下了一个证不出的结论。
           * ★ 方向那个字（「还晚了」）留着：判定只在远端更晚时才 > 0，文案必须同向（X-1）。
           */
          message:
            `另一端给这张启动页图改名时标的时刻，比这边见过的最新那次远端数据改动还晚了 ` +
            `${Math.round(ahead / 3_600_000)} 小时以上 —— 可能是那一端这段时间没改过数据，` +
            `也可能是它的时钟快了。` +
            `「最后改名的为准」这条规则会一直偏向它，你在这边改的名字可能翻不过来。`
        })
      }
      const win = pickLabel(local[name] ?? null, remote)
      if (win) next[name] = win
    }

    /* ── 推：本地更新的推上去 ── */
    for (const [name, mine] of Object.entries(next)) {
      if (!checkSplashName(name).ok) continue
      const there = decodeMeta(await store.get(metaKey(name)))
      if (there && pickLabel(there, mine) === there) continue
      await store.put(metaKey(name), encodeMeta(mine, me))
    }

    /**
     * ★★ **没变就不回写**（Nyx-UI-Android 2026-09-13 提的，采纳）。
     *
     *   原来这里是无条件 `write`。对面那半拿 `settings` 那一行的 `updated_at`
     *   **当「这个名字是什么时候改的」的证据**，而每趟同步白写一次就会把它刷新掉 ——
     *   于是「最后一次修改为准」判到的是**同步的时间**，不是他改名的时间。
     *   那种错不会报，只会让某一次改名莫名其妙输掉。
     *
     * ★ 闸放在引擎、不放在端口：「这一趟有没有改动」只有引擎知道
     *   （`local` 和 `next` 都在它手里）。让每个端各自比一遍 =
     *   同一个判据两份，而两份迟早不一样。
     */
    if (!sameLabels(local, next)) await port.write(next)
    return next
  }
}

/**
 * 两张名字表一样吗。**只比内容**，不比键的顺序 ——
 * `Object.keys` 的顺序取决于插入次序，拿它当判据的话
 * 「同一份内容」在两台机器上可能一个说变了、一个说没变。
 */
function sameLabels(
  a: Readonly<Record<string, SplashLabel>>,
  b: Readonly<Record<string, SplashLabel>>
): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const x = a[k]
    const y = b[k]
    if (!y || !x || x.label !== y.label || x.at !== y.at) return false
  }
  return true
}
