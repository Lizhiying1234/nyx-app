/**
 * 云端压实 · T-2.2（审计 R-008 · D-435）
 *
 * ── 要解决什么 ──────────────────────────────────────────────
 *
 * 桶是**追加式**的：`nyx/chunks/<设备>-<时间戳>.json`，谁也不改谁的包。
 * 那是这套协议最好的性质（没有任何一次写会覆盖别人的数据），
 * 也带来两个后果：
 *
 *   ① 包只增不减 —— 新设备从零重建要把历史上每一次推送都下一遍
 *   ② **删掉的东西，云端还整整齐齐留着一份**
 *
 * ② 才是这一轮的正事。D-435 写死了：「彻底删除 = 死了，云端也不许再留着它的内容」。
 * 本地立了碑、墓碑也传到了对面，可**历史包里那份原文**谁都没动过 ——
 * F-002 那次是**手工**清的（`RemoteStore` 当时连 `delete` 都没有）。
 *
 * ── 做法：写一份快照，核对，再删老包 ────────────────────────
 *
 *   ① list  —— 云端现在有哪些包
 *   ② 读齐、按 `(表, uid)` 只留**最新的一版**
 *   ③ 立过碑的、父级被终结的，**不进快照**（判据借 `core/tombstone.ts`，不另造）
 *   ④ 写快照 —— **它就是一个普通的变更包**，包头一个字段都不多
 *   ⑤ 读回来**逐行核对**（行数 + 每行内容）
 *   ⑥ 全对才删老包；对不上一行就一个都不删
 *
 * ── 三条绝不能省的护栏 ──────────────────────────────────────
 *
 * · **只剩一份时拒删** —— 那时候压实一点收益都没有，风险却是全部。
 * · **没有删除权限时拒跑** —— 先探一次（`probeDeletePermission`）。
 *   不探的话结局是：快照写上去了、老包一个也删不掉 → 云端凭空多一个大包。
 * · **只删「每一行都核对过」的那些包** —— 读不懂的包（老包、坏包、另一套结构）
 *   既不折进快照也不删，原样留着并报出来。**不理解的东西不许删。**
 * · ★★★ **只折本机已经吸收过的包。** 见下面那一段 —— 这条不守会丢数据。
 * · **桶太大就拒**（T-2.10）—— 压实要把整个桶读进内存，读一个包查一次上限，
 *   超了整趟不做、云端一个字不动。两个数与那句话在 `compact-trigger.ts`。
 *
 * ★ **什么时候压实**不在这个文件里，在 `compact-trigger.ts`（T-2.10 / D-R18 方案 D）：
 *   彻底删除记一个本机标记 · 下一趟 `run()` 成功之后压一次 · 或者桶里包数到线。
 *
 * ── ★★★ 为什么「只折本机已经吸收过的包」 ────────────────────
 *
 * 快照写成 `<本机>-<at>.json`，而 `session.ts::planTodo` 的第一道过滤是
 * **「自己推的不下」**：名字以本机编号（或任一旧号）开头的包，本机永远不读。
 *
 * 于是把**别的设备推的、本机还没应用过的**包折进快照再删掉，后果是：
 * 那些行只剩在快照里，而快照本机永远跳过 —— **对本机就丢了**，
 * 而对面还以为已经送到（它的水位早就走过去了）。
 *
 * 「还没应用过」不是罕见情况，至少三条常路：
 *   · 手动触发压实时，上一趟拉取之后对面又推了一个包
 *   · 某包因父行未到（外键）而失败重试，按 R-4-A **不进 `applied`**
 *   · 某包还有未裁决冲突，按 R-4-F 也不进 `applied`
 *
 * 所以资格判据**借 `run()` 自己的账**，不另造：
 *
 *   折得了 = 本机推的（`device` + `formerDevices` 前缀，和 `planTodo` 的 `mine` 同一份算法）
 *          ∪ 本机 `applied` 里有名字的
 *
 * 其余一律 untouched。★ `applied` 只留最后 500 个名字，滚出去的老包会在下一趟
 * `run()` 里被重读一遍再回到 `applied` —— 所以压实多跑几趟自然收敛，
 * 不需要另想办法，只是一趟压不完。
 *
 * ── 中途断在哪儿都还能读 ────────────────────────────────────
 *
 * 顺序是「先加后减」，所以任何时刻云端都是**内容的超集**：
 *
 *   写快照前断  → 什么都没变
 *   写完没核对完 → 快照 + 全部老包（内容重了一份，判成 `same`，不改任何东西）
 *   删到一半断  → 快照 + 剩下的老包（同上）。再跑一次接着删
 *
 * 唯一一种「另一端这一轮少收一点」的时序，写在 `compactBucket` 的注释里。
 */

import { classifyChunk, type LocalIdentity } from '../sync-protocol.ts'
import type { SyncRow } from '../sync-merge.ts'
import { planParentBlocks, rowKey, type Fk } from '../tombstone.ts'
import { COMPACT_LIMITS, overBudget, type CompactLimits } from './compact-trigger.ts'
import { probeDeletePermission, type RemoteStore } from './store.ts'

/** 变更包都在这个前缀下 —— 和 `engine.run()` 用的是同一个字面量 */
const CHUNKS = 'nyx/chunks'

export interface CompactOptions {
  store: RemoteStore
  /** 这台机器的编号。快照挂在它名下 —— 和这台机器平时推的包一模一样 */
  device: string
  /**
   * ★ F-009 · 这台机器用过的**旧**编号。和 `planTodo` 一样要算进「自己推的」——
   * 从备份恢复到新机器会重新铸号，旧号推的包也是自己推的。
   */
  formerDevices: readonly string[]
  /**
   * ★★★ 本机 `applied` 里的包名 —— 「这个包我已经吸收过了」。
   * 判折的资格要它，理由见文件头。**直接用 `run()` 记的那一份账，不另算。**
   */
  applied: readonly string[]
  /** 包头里那三样身份，原样照抄 `run()` 推包时用的那一份 */
  identity: LocalIdentity
  /** 现在几点。快照的包名与包头 `at` 都用它 */
  now: number
  /**
   * 立过碑的：表 → 那些 uid。
   * ★ 直接用 `engine.terminatedIndex()` 的产物 —— 判据只有那一份。
   */
  terminated: ReadonlyMap<string, ReadonlySet<string>>
  /** 某张表的关系。用 `engine.fksOf()` 的产物 */
  fksOf: (table: string) => readonly Fk[]
  /**
   * ★ T-2.10 · 一次压实最多吃进多少（行数 / 字符数）。默认 `COMPACT_LIMITS`。
   *
   * 可注入是**有意的**：这条上限要能用真 store 证伪，而「造一个 24 MB 的桶」
   * 不是一条跑得起来的用例。判据与默认值都在 `compact-trigger.ts`，这里只用。
   */
  limits?: CompactLimits
}

export interface CompactResult {
  /** 真的压实了吗（快照写成、核对全过、老包全删掉） */
  ok: boolean
  /** `ok: false` 时给他看的一句人话 */
  why?: string
  /** 快照的包名 —— 只要写成并核对过就有值，哪怕后面删老包出了岔子 */
  snapshot?: string
  /** 压实之前云端有几个包 */
  before: number
  /** 折进快照的老包有几个 */
  folded: number
  /**
   * ★ T-2.10 · 折进快照的是**哪几个包**（D-458：凡是给出一个数，都要能答「是哪些」）。
   * 成功那一趟里，被删掉的老包就是这一份名单，一个不多一个不少 —— 账本里记的正是它。
   */
  foldedNames: string[]
  /** 没动的包有几个（读不懂 / 老包 / 另一套结构）—— 既没折也没删 */
  untouched: { name: string; why: string }[]
  /** 快照里有几行 */
  rows: number
  /** 因为立过碑、或父级被终结而**没进**快照的行数 */
  dropped: number
  /** 真的删掉了几个老包 */
  deleted: number
}

// ══════════════════════════════════════════════════════════════
// 纯判据 —— 不碰网络，可以单独证伪
// ══════════════════════════════════════════════════════════════

/** 一个能折的包：包头过了 `classifyChunk`，行也长得对 */
export interface FoldablePack {
  name: string
  rows: readonly SyncRow[]
}

/**
 * ★★★ 这个包本机吸收过吗 —— 折的**资格**。理由见文件头那一整段。
 *
 * `mine` 的算法和 `session.ts::planTodo` 一字不差（连「空号不算」那条也一样：
 * `-` 开头的前缀会把别人的包全误伤成自己的）。两处必须同一份，
 * 因为这里判的正是「`planTodo` 会不会再读它」的补集。
 */
export function absorbed(
  name: string,
  device: string,
  formerDevices: readonly string[],
  applied: ReadonlySet<string>
): boolean {
  const mine = [device, ...formerDevices]
    .filter((d) => d.trim() !== '')
    .map((d) => `${d}-`)
  return mine.some((p) => name.startsWith(p)) || applied.has(name)
}

/**
 * 快照里应该有哪些行。
 *
 * ① 按 `(表, uid)` 去重，留 `updatedAt` **最大**的那一版。
 *    重放 [v1, v2, v3] 和只重放 [v3] 的**最终状态一样** —— 中间那些版本
 *    只是让对面多算几次，改不了结果（`decideRow` 认的是 `updatedAt` 与共同基）。
 *    同一个 `updatedAt` 撞上时，**后出现的赢**。
 *    ★ 这件事确定，靠的是调用方**先按包名排过序**（`compactBucket` 里的 `.sort()`）——
 *      `store.list()` 自己不保证顺序（WebDAV 的 PROPFIND 给的是服务端的顺序）。
 *
 * ② 立过碑的那一行本身：`terminated` 里有它 → 扔掉。
 *    ★ 两种碑（遗骸 / 删后修改）`isBlocked` 都判 blocked，所以这里只看
 *      「有没有碑」就够，不必再比 `purged_at` —— 判据没变，只是用不到那一半。
 *
 * ③ 父实体被终结的派生行（`answers` / `analysis_blocks` / `picks` …）：
 *    `planParentBlocks` 说了算。它们没有自己的碑，可它们**是内容** ——
 *    不清掉的话 D-435 只做了一半。
 *
 * ★ `tombstones` 自己那些行**永远留着**：碑正是防复活的那个机制，
 *   清掉碑等于把 R-3 整条护栏从云端拆了。
 *   （`terminated` 的键是被终结实体的表名，永远不会是 `tombstones`；
 *   而 `tombstones` 表在库里一条外键都没有，`planParentBlocks` 也够不着它。）
 */
export function planSnapshot(
  packs: readonly FoldablePack[],
  terminated: ReadonlyMap<string, ReadonlySet<string>>,
  fksOf: (table: string) => readonly Fk[]
): { rows: SyncRow[]; dropped: number } {
  // ① 去重，留最新
  const newest = new Map<string, SyncRow>()
  for (const p of packs) {
    for (const r of p.rows) {
      const k = `${r.table}#${r.uid}`
      const had = newest.get(k)
      if (had && had.updatedAt > r.updatedAt) continue
      newest.set(k, r)
    }
  }
  const all = [...newest.values()]

  // ③ 父级被终结的派生行 —— 先算，下面和 ② 一起过滤
  const blocked = planParentBlocks({ rows: all, terminated, fksOf })

  const rows: SyncRow[] = []
  let dropped = 0
  for (const r of all) {
    // ② 它自己立过碑
    if (terminated.get(r.table)?.has(r.uid)) {
      dropped += 1
      continue
    }
    if (blocked.has(rowKey(r.table, r.uid))) {
      dropped += 1
      continue
    }
    rows.push(r)
  }
  return { rows, dropped }
}

/**
 * 稳定序列化 —— 「每行内容一样吗」不该受键序影响。
 *
 * JSON 往返本来会保住键序，但那是实现细节；核对是这一整套的最后一道闸，
 * 它不该建立在实现细节上。
 */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`
}

/** 一行长得对吗 —— 认不出的行让整个包变成「不敢动」 */
function looksLikeRow(v: unknown): v is SyncRow {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  if (typeof r['uid'] !== 'string' || r['uid'] === '') return false
  if (typeof r['table'] !== 'string' || r['table'] === '') return false
  if (typeof r['updatedAt'] !== 'number' || !Number.isFinite(r['updatedAt'])) return false
  const d = r['data']
  if (d !== null && (typeof d !== 'object' || Array.isArray(d))) return false
  return true
}

/**
 * 一个包能不能折进快照。
 *
 * 判「新包 / 老包 / 拒收」**借 `classifyChunk`** —— 和 `run()` 收包时同一份判据。
 * 只有 `accept` 才折：`legacy` 的行 uid 是升级前那套算法算的，把它们折进一个
 * 带 v3 包头的快照 = 把**本来会被拒收的内容洗成会被收的内容**。那是改协议，不是压实。
 */
export function classifyForFold(
  body: string,
  identity: LocalIdentity
): { fold: true; rows: SyncRow[] } | { fold: false; why: string } {
  let pack: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { fold: false, why: '这个包不是一份记录' }
    }
    pack = parsed as Record<string, unknown>
  } catch {
    return { fold: false, why: '这个包读不出来（不是合法的 JSON）' }
  }

  const verdict = classifyChunk(pack, identity)
  if (verdict.kind === 'legacy') {
    return { fold: false, why: '这是升级之前推的老包（没有版本头），不折也不删' }
  }
  if (verdict.kind === 'reject') {
    return { fold: false, why: `本机收不了这个包（${verdict.code}），不折也不删` }
  }

  const raw = pack['rows']
  if (!Array.isArray(raw)) return { fold: false, why: '这个包里没有 rows' }
  const rows: SyncRow[] = []
  for (const r of raw) {
    if (!looksLikeRow(r)) return { fold: false, why: '这个包里有一行认不出来' }
    rows.push(r)
  }
  return { fold: true, rows }
}

// ══════════════════════════════════════════════════════════════
// 执行 —— 网络那一半
// ══════════════════════════════════════════════════════════════

/**
 * 压实一次。
 *
 * ── 另一端在压实中途读桶会看到什么 ──────────────────────────
 *
 * 三种时序，都不丢东西：
 *
 * · **它 list 在快照写好之后** → 看见快照 + 还没删完的老包。
 *   同一行来两遍，第二遍判成 `same`（或按共同基判成 `keep-local`），库里一个字不变。
 *
 * · **它 list 在快照写好之前** → 名单里没有快照。它接着去 `get` 那些老包时，
 *   有些可能已经被删掉了 → `get` 返回 null → 引擎 `continue`（老路径，没改）。
 *   ★ 那一轮它确实**少收了那几个包的内容**。但快照就在桶里、它还没 applied 过，
 *   **下一轮就会收到**，而且快照是那些内容的超集。所以是「晚一轮」，不是「丢了」。
 *
 * · **它正在 push** → 它的新包名不在我们这一趟的名单里，永远不会被删。
 *
 * ── 老包被删之后，另一端 `applied` 里的旧名字为什么无害 ──────
 *
 * `applied` 只被当成「这些包名我处理过，别再处理了」用：
 * 每一轮先 `list()` 拿到**现在还在的**包名，再拿 `applied` 去减。
 * 名字对应的对象没了，那个名字就永远不会再出现在 `list()` 里 ——
 * 它只是一个再也匹配不上的字符串，不会让任何包被跳过。
 * （`applied` 只留最后 500 个，这些死名字迟早自己滚出去。）
 */
export async function compactBucket(o: CompactOptions): Promise<CompactResult> {
  /**
   * ★ 排序不是为了好看：去重时「同一个 `updatedAt` 后出现的赢」这条规则
   * 只有在顺序确定时才是一条规则。`store.list()` 不保证顺序 ——
   * WebDAV 的 PROPFIND 给的是服务端的顺序。`planTodo` 也是这么排的。
   */
  const names = [...(await o.store.list(CHUNKS))].sort()
  const base = {
    before: names.length,
    folded: 0,
    foldedNames: [] as string[],
    untouched: [] as { name: string; why: string }[],
    rows: 0,
    dropped: 0,
    deleted: 0
  }

  /**
   * ★ 只剩一份（或一份都没有）时拒绝。
   * 压实一个包 = 把它抄一遍再删掉原件：收益为零，而「抄错」的风险照旧。
   */
  if (names.length <= 1) {
    return {
      ok: false,
      why: `云端只有 ${names.length} 个变更包，没有什么可以压实的 —— 没有动它。`,
      ...base
    }
  }

  /**
   * ★ 先探删除权限，**在写任何东西之前**。
   * 顺序反过来的话：快照写上去了、老包一个都删不掉 → 云端凭空多一个大包，
   * 而他什么都没得到。
   */
  const probe = await probeDeletePermission(o.store)
  if (!probe.ok) {
    return {
      ok: false,
      why: `这个云端配置删不掉东西，压实没有做。\n${probe.why}`,
      ...base
    }
  }

  // ── 读齐老包 ────────────────────────────────────────────────
  const foldable: FoldablePack[] = []
  const untouched: { name: string; why: string }[] = []
  const appliedSet = new Set(o.applied)
  /**
   * ★★ T-2.10 · 桶大小上限（T-2.2「还差的验证 ③」）。
   *
   * 压实要把整个桶读进内存才算得出快照，在这之前**一点保护都没有**。
   * 判据（两个数与那句话）在 `compact-trigger.ts`；这里只做一件事：
   * **每读一个包查一次**。事后再查等于没查 —— 峰值内存要被钉在
   * 「上限 + 一个包」，而不是「整个桶」。
   *
   * ★ 超了就整趟拒，**桶一个字都没动**（这时候连快照都还没开始写）。
   */
  const limits = o.limits ?? COMPACT_LIMITS
  const read = { rows: 0, chars: 0 }
  for (const n of names) {
    /**
     * ★★★ 资格闸，放在**读之前** —— 没吸收过的包连读都不用读：
     * 它的行不进快照，它自己也不许删。理由见文件头。
     */
    if (!absorbed(n, o.device, o.formerDevices, appliedSet)) {
      untouched.push({ name: n, why: '本机还没应用过这个包 —— 先同步一次再压' })
      continue
    }
    const body = await o.store.get(`${CHUNKS}/${n}`)
    if (body === null) {
      // 列完到读之间被别人删了 —— 没什么可折的，也没什么可删的
      untouched.push({ name: n, why: '列出来之后就不在了' })
      continue
    }
    /**
     * ★ 正文一律计数，折不折得了都算：一个 30 MB 的坏包照样把内存吃光。
     *   行数只算**留下来等着折的**那些 —— 认不出的包读完就扔了。
     */
    read.chars += body.length
    const v = classifyForFold(body, o.identity)
    if (v.fold) read.rows += v.rows.length
    const over = overBudget(read, limits)
    if (over) return { ok: false, why: over, ...base, untouched }

    if (!v.fold) {
      untouched.push({ name: n, why: v.why })
      continue
    }
    foldable.push({ name: n, rows: v.rows })
  }

  if (foldable.length <= 1) {
    return {
      ok: false,
      why:
        `能折的包只有 ${foldable.length} 个（另外 ${untouched.length} 个读不懂或是老包，` +
        `按规矩没有动它们）—— 压实没有做。`,
      ...base,
      untouched
    }
  }

  // ── 算快照 ──────────────────────────────────────────────────
  const { rows, dropped } = planSnapshot(foldable, o.terminated, o.fksOf)

  /**
   * ★ 包名不许撞。同一毫秒里这台机器刚推过一个包时会撞上 ——
   * 撞了就是**覆盖**，那一包的内容会没有。往后挪一毫秒，不去猜。
   */
  const taken = new Set(names)
  let at = o.now
  while (taken.has(`${o.device}-${at}.json`)) at += 1
  const snapshot = `${CHUNKS}/${o.device}-${at}.json`

  /**
   * ★★ 快照**就是一个普通的变更包** —— 字段顺序和 `run()` 推包那一处一字不差。
   * 另一端（哪怕是旧版本的 core）读它时不需要知道「压实」这回事存在。
   */
  const body = JSON.stringify({
    device: o.device,
    at,
    schemaVersion: o.identity.schemaVersion,
    schemaFingerprint: o.identity.schemaFingerprint,
    protocolVersion: o.identity.protocolVersion,
    rows
  })
  await o.store.put(snapshot, body)

  // ── 读回来逐行核对 ──────────────────────────────────────────
  const mismatch = await verifySnapshot(o.store, snapshot, o.identity, o.device, at, rows)
  if (mismatch) {
    /**
     * ★★ 核对不上就**一个老包都不删**。
     * 云端此刻 = 快照 + 全部老包，内容一份不少，只是多了一份重复。
     * 留着那个对不上的快照是有意的：删它要再发一次删除请求，
     * 而我们刚刚才证明「写上去的东西读回来不一样」—— 这时候最不该做的就是再信它一次。
     */
    return {
      ok: false,
      why:
        `快照写上去了，但读回来跟写出去的对不上，所以「一个老包都没有删」。\n` +
        `${mismatch}\n` +
        `云端现在是安全的：内容一份不少，只是多了一份重复（${snapshot}）。`,
      snapshot,
      ...base,
      folded: foldable.length,
      foldedNames: foldable.map((p) => p.name),
      untouched,
      rows: rows.length,
      dropped
    }
  }

  // ── 全对了，才删老包 ────────────────────────────────────────
  let deleted = 0
  const failed: { name: string; why: string }[] = []
  for (const p of foldable) {
    try {
      await o.store.delete(`${CHUNKS}/${p.name}`)
      deleted += 1
    } catch (e) {
      failed.push({ name: p.name, why: e instanceof Error ? e.message : String(e) })
    }
  }

  if (failed.length > 0) {
    return {
      ok: false,
      why:
        `快照写好并核对过了（${snapshot}），但有 ${failed.length} 个老包删不掉：\n` +
        failed.map((f) => `  · ${f.name} —— ${f.why}`).join('\n') +
        `\n云端现在是安全的（内容一份不少，只是多了几份重复）。再压实一次会接着删。`,
      snapshot,
      before: names.length,
      folded: foldable.length,
      foldedNames: foldable.map((p) => p.name),
      untouched,
      rows: rows.length,
      dropped,
      deleted
    }
  }

  return {
    ok: true,
    snapshot,
    before: names.length,
    folded: foldable.length,
    foldedNames: foldable.map((p) => p.name),
    untouched,
    rows: rows.length,
    dropped,
    deleted
  }
}

/**
 * 读回来核对 —— **行数与每行内容**。
 *
 * 返回 `null` 表示全对；返回一句话表示哪儿对不上。
 * 包头也一起比：快照要是被谁改了包头，另一端就会整包拒收，
 * 而那时候老包已经删了 —— 所以包头和行一样重要。
 */
async function verifySnapshot(
  store: RemoteStore,
  path: string,
  identity: LocalIdentity,
  device: string,
  at: number,
  expected: readonly SyncRow[]
): Promise<string | null> {
  let body: string | null
  try {
    body = await store.get(path)
  } catch (e) {
    return `读不回来：${e instanceof Error ? e.message : String(e)}`
  }
  if (body === null) return '读回来是空的 —— 那一份根本没写上去'

  let pack: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '读回来的不是一份记录'
    }
    pack = parsed as Record<string, unknown>
  } catch {
    return '读回来的不是合法的 JSON'
  }

  if (pack['device'] !== device) return `包头的 device 对不上：${String(pack['device'])}`
  if (pack['at'] !== at) return `包头的 at 对不上：${String(pack['at'])}`
  if (pack['schemaVersion'] !== identity.schemaVersion) {
    return `包头的 schemaVersion 对不上：${String(pack['schemaVersion'])}`
  }
  if (pack['schemaFingerprint'] !== identity.schemaFingerprint) {
    return `包头的 schemaFingerprint 对不上：${String(pack['schemaFingerprint'])}`
  }
  if (pack['protocolVersion'] !== identity.protocolVersion) {
    return `包头的 protocolVersion 对不上：${String(pack['protocolVersion'])}`
  }

  const got = pack['rows']
  if (!Array.isArray(got)) return '读回来的包里没有 rows'
  if (got.length !== expected.length) {
    return `行数对不上：写出去 ${expected.length} 行，读回来 ${got.length} 行`
  }
  for (let i = 0; i < expected.length; i++) {
    const a = canon(expected[i])
    const b = canon(got[i])
    if (a !== b) {
      const who = expected[i]!
      return `第 ${i + 1} 行内容对不上（${who.table} ${who.uid}）`
    }
  }
  return null
}
