import { isBlocked, type Tombstone } from './tombstone.ts'
import { isMonotoneRow, isResolutionBlocking, type ResolutionFact } from './resolution.ts'
import { onlyMachineDiffs } from './sync-columns.ts'

/**
 * 同步的合并规则 · D-201
 *
 * 「**发现两边都改过时不静默覆盖**，弹一句让使用者选
 *  （「云端是 3 小时前的，本地是刚才的，用哪个？」）」
 *
 * 为什么这一段是纯逻辑（D-238）：**这是全项目第二处出错会静默丢数据的代码**
 * （第一处是数据库迁移）。它必须能脱离网络、脱离数据库、脱离界面单独测 ——
 * 「两边都改过」这种情形在真实同步里很难复现，在这里三行就能造出来。
 *
 * 核心概念只有一个：**上次同步水位**（watermark）。
 *   本地某行 updated_at > 水位  →  这一侧改过
 *   远端某行 updated_at > 水位  →  那一侧改过
 *   两边都改过                  →  冲突，交给使用者，绝不自己决定
 */

export interface SyncRow {
  /** 跨设备的行身份。**不能用自增 id** —— 两台机器各自新建会撞号 */
  uid: string
  table: string
  updatedAt: number
  /** 列名 → 值。null 表示这一行被删了（软删仍是一次更新） */
  data: Record<string, unknown> | null
}

export type RowDecision =
  /** ★★ R-3 · 这一行在本机被彻底删过 —— 云端那份是遗骸，不许据此重建 */
  | { kind: 'blocked'; reason: string; postPurge: boolean }
  | { kind: 'take-remote'; reason: string }
  | { kind: 'keep-local'; reason: string }
  | { kind: 'conflict'; reason: string; localAt: number; remoteAt: number }
  | { kind: 'same'; reason: string }

/**
 * 一行该怎么办。
 *
 * @param local     本地这一行（没有就是 undefined）
 * @param remote    远端这一行
 * @param base      共同基版本 —— 我最近一次确认与远端同步到的那一版（`undefined` = 从没确认过）
 */
export function decideRow(
  local: SyncRow | undefined,
  remote: SyncRow,
  /**
   * ★★ Step 6C · **共同基版本** —— 我最近一次确认与远端同步到的那一版。
   *
   * `undefined` = 这一行从没被确认同步过（`row_sync_state` 里没有它）。
   * 它是本机私事，**不进任何同步包**。
   */
  recordedBase: number | undefined,
  /** ★★ R-3 · 这一行的墓碑（没有就是 undefined）。判据在 `core/tombstone.ts` */
  tomb?: Tombstone,
  /** ★★ R-4-F-a · 他对这一行的裁决（没有就是 undefined）。判据在 `core/resolution.ts` */
  res?: ResolutionFact,
): RowDecision {
  /**
   * ★★ R-3 · **先问墓碑，再看别的。**
   *
   * ── 它挡的是哪个洞 ──────────────────────────────────────
   *
   * 「本地没有这一行」有两种成因：对面新建的，和**我这边彻底删掉的**。
   * 以前下面那个 `!local` 分支无条件当成前者，于是任何一个装着老行的包
   * （`applied` 溢出重下 / 新设备从头拉 / 导回备份）都能让删掉的东西复活 ——
   * 而且它连水位都不看，时间戳再老的包照收。
   *
   * ── 为什么放在最前面，而不是塞进 `!local` 里 ────────────
   *
   * 因为墓碑和那一行的老版本**完全可能同一批到达**：
   * A 删掉 X 推上去，B 这一次同时收到「X 的墓碑」和「别的设备推的 X」。
   * 那一刻 B 本地的 X 还在（马上就会被墓碑执行掉），
   * 判断要是写在 `!local` 里就漏过去了 —— 那一行会被正常合并进来，
   * 而「删后修改」这种要报给他看的情况也就跟着丢了。
   *
   * **碑说了算**：有碑就不收，本地还有没有那一份都一样。
   * 判据不写在这里，走 `isBlocked` 那唯一一份。
   */
  const v = isBlocked(tomb, remote.updatedAt)
  if (v.blocked) return { kind: 'blocked', reason: v.reason, postPurge: v.postPurge }

  /**
   * ★★ R-4-F-a · 这一版他已经明确拒绝过了 —— 不要再问第二遍，也不许悄悄收下。
   *
   * ── 为什么排在 `!local` **前面**（这一条是实测改过来的）★★ ──
   *
   * 一开始排在后面，理由是「裁决的意思是『这一版不要，**另一版**才对』，
   * 得先留得下另一版」。**真跑一遍就红了**：新设备一批里同时收到
   * 「被拒的那版」和「留下的那版」时，两行的 `local` 都还是空的
   * （合并的判断发生在落库之前），于是双双 take-remote，
   * **谁赢取决于哪个包先到** —— 那不是他的决定，是推送时间。
   *
   * 排在前面之所以安全，靠的是 D5 那条不变式：
   *
   *   **留下的那一版永远晚于 `rejected_up_to`**（`keptUpdatedAt`）
   *
   * 所以挡掉的只可能是他真的拒绝过的那些版本，留下的那一版一定进得来。
   * 换句话说：能不能排在这里，完全取决于 D5 有没有做。
   * D5 一旦被拿掉，这里就会把那个对象整个挡没 —— `resolution.test.ts`
   * 里有一条用例专门守着这个不变式。
   *
   * ── 为什么排在 conflict 前面 ───────────────────────────
   *
   * 不然每次老包重放都会再问他一遍同一个问题，而他早就答过了。
   *
   * 归 `keep-local` 而不是 `blocked`：`blocked` 是墓碑那一档，
   * 会进 `plan.blocked`、参与「删后修改」的诊断；这里没什么可诊断的，
   * 他做过决定，安静照办就是。两者都算进 `skipped`（R-4-F 的桶不变）。
   */
  if (isResolutionBlocking(res, remote.updatedAt)) {
    return { kind: 'keep-local', reason: '这一版你已经选过不要了' }
  }

  if (!local) {
    return { kind: 'take-remote', reason: '本地没有这一行 —— 是另一台机器新增的' }
  }
  if (local.updatedAt === remote.updatedAt) {
    return { kind: 'same', reason: '两边时间戳一样，没动过' }
  }

  /**
   * ★★ Step 6C · 因果判断改成**和共同基版本比相等**，不再比大小。
   *
   * ── 为什么必须换掉 `> watermark` ────────────────────────────
   *
   * 那是一句**跨时钟比较**：左边对面的钟，右边我的钟。已经证明，
   * 不存在任何只由「本机状态 + `remote.updatedAt`」算出的标量判据，
   * 能区分这两种情形 ——
   *
   *   E1 回声：对面重推一个我早就收下、并在其上改过的旧版本 → 该 keep-local
   *   E2 慢钟：对面刚做的新编辑，只是它的钟慢          → 该 conflict
   *
   * 因为可以构造二者使本机状态与到达行的 `(uid, table, updatedAt)`
   * 完全相同。所以判据只能来自**行级**的「这一版我见过没有」。
   *
   * ── 换成什么 ────────────────────────────────────────────────
   *
   *   base = 我最近一次确认与远端同步到的那一版（`row_sync_state`）
   *
   *   local == base && remote != base  → 收下对面的
   *   local != base && remote == base  → 留本地的
   *   local != base && remote != base  → 冲突：两边都动过同一个基版本
   *   local == base && remote == base  → 什么都不用做
   *
   * **四条全是相等比较，一次大小比较都没有。** 时钟快慢从此不参与因果判断，
   * 慢钟设备刚做的编辑不会再被判成「对面没改过」然后被无声吃掉。
   *
   * ── NULL（没有基版本）怎么算 ────────────────────────────────
   *
   * 没有基版本 = **没有被确认同步过**，于是两侧都算「动过」。
   * 不拿 `updated_at` 去猜、不当成 0、不当成现在 —— 猜错的那一半是
   * 「把没推过的行标成已同步」，那会永久漏数据。
   * 宁可多问一次，也不能悄悄替他决定。
   *
   * ★ 注意这一档排在 `local.updatedAt === remote.updatedAt → same` **之后**：
   *   两边本来就一模一样时没有任何可争的，不该因为基版本缺失去打扰他。
   */
  /**
   * ★★ F-1 · **确定性身份的行：两台各自产生的是同一件事实，不是两个版本。**
   *
   * ── 病 ────────────────────────────────────────────────────
   *
   * 两台离线各自删掉同一个对象（很正常）。墓碑的 uid 由
   * `(kind, target_uid)` 决定，所以两边长出**同一个 uid**、
   * 而 `purged_at` 是各自的删除时刻，天然不同。
   *
   * 后同步的那一台在合并这块碑时，自己那块**还没推过**（`collect`
   * 排在 `write` 之前，R-4-C-a），于是共同基是 `undefined`：
   *
   *     localChanged  = t2 ≠ undefined → true
   *     remoteChanged = t1 ≠ undefined → true   → 冲突
   *
   * 冲突行按 R-4-F-a ⑩ 的规则只顶 `pushed`、不顶 `synced`，
   * 于是那一行的 `synced_updated_at` **永远停在 NULL** ——
   * 它再也不算对过账，将来对面正常改它会被判成冲突。
   * 实测追踪：`purged_at` 两轮就一致了，卡住的是基状态。
   *
   * ── 判据 ──────────────────────────────────────────────────
   *
   * 一块碑说的话只有一句：「这个对象被删了」。它是**幂等的事实**，
   * 不是一个有内容的版本 —— 两块碑之间没有「用哪边」的问题。
   * 所以合并规则是与到达顺序无关的 **`min(purged_at)`**：
   * 宁可更早挡住历史版本，也不能让删掉的东西复活。
   *
   * ── ★ 为什么不能写成「内容碰巧一样就算同一版」 ──────────────
   *
   * 那会让**普通随机 uid 的业务行**也走进来：两台各自写了一模一样的
   * 一句话，就被当成「同一版本」而不再是冲突 —— 他的一次编辑被静默吞掉。
   * 进这条路的必要条件是**身份本身是确定性的**（uid 由业务键算出来），
   * 而不是内容相等。这里只认 `tombstones` 这一张表：
   * 它的 uid 由 `(kind, target_uid)` 决定，且整行除了「删了」不表达别的东西。
   * `resolutions` 走 `isMonotoneRow` 那条既有的路，出厂内容走 PRISTINE 那条。
   * **不要因为「看起来也差不多」就往这里加表。**
   */
  if (local && remote.table === 'tombstones') {
    const lp = Number((local.data as Record<string, unknown> | undefined)?.['purged_at'] ?? 0)
    const rp = Number((remote.data as Record<string, unknown> | undefined)?.['purged_at'] ?? 0)
    return rp < lp
      ? { kind: 'take-remote', reason: '两台各自删过它 —— 取更早的那一刻（碑只会更严，不会复活）' }
      : { kind: 'same', reason: '两台各自删过它 —— 本机这块碑已经是更早的那一刻' }
  }

  /**
   * ★★ PRISTINE · 出厂内容天生就有共同基版本，值是 0。
   *
   * `updated_at = 0` 是既有的协议语义（`db/builtins.ts` 的 `PRISTINE`）：
   * 「这一行和出厂时一模一样，没有任何需要跨设备传播的本地变更」。
   * 两台机器各自播种的是**同一份**出厂内容，所以 0 本身就是一个
   * **被证明了的共同基版本** —— 不需要谁推给谁才算数。
   *
   * 不写这一句的话：出厂行永远不进待推（那是对的，它不是本地变更），
   * 于是永远不会有记录在案的基版本；对面第一次改动出厂内容时，
   * 本机就判成「两边都动过」→ 冲突。而他一条都没碰过 ——
   * `builtins.ts` 里记着实测数字：那会是 22 处莫名其妙的冲突。
   *
   * ★ 这不是特例，是把待推那一侧已经在用的同一条语义用到判定这一侧：
   *   两处都认「`updated_at = 0` = 没有本地变更」。
   */
  const base = recordedBase ?? (local.updatedAt === 0 ? 0 : undefined)
  const localChanged = local.updatedAt !== base
  const remoteChanged = remote.updatedAt !== base

  // ★ D-201 的正题：两边都在上次同步之后改过 —— 谁覆盖谁都是丢数据
  if (localChanged && remoteChanged) {
    /**
     * ★★ R-4-F-a · **裁决行自己不进冲突。**
     *
     * `resolutions` 的合并规则是 `max`，由数据库触发器守着（V25）——
     * 两台机器同一个同步窗口里各自裁决了同一个对象，谁先谁后结果都一样。
     * 把它拿去问使用者「用哪边」是没有意义的：他会看到一条自己根本不认识的
     * 内部记录，而且不管选哪边，落库之后都是同一个值。
     *
     * 拿 take-remote 是安全的 —— 触发器不会让 `rejected_up_to` 变小。
     */
    if (isMonotoneRow(remote.table)) {
      return { kind: 'take-remote', reason: '这张表两边合并到一起就行，没有「用哪边」的问题' }
    }
    /**
     * ★★ D-437 · **不一样的全是机器的账 → 时间新的赢，不问。**
     *
     * `lectures.due_at`、`reading_cards.reps` 这些列两端都会在他正常用的时候
     * 顺手改（手机练完顶一次、电脑分析完顶一次）。拿这个去问他「哪边算数」，
     * 问的是他从来没写过的东西 —— 实测一次同步 16 条讲次全卡在这上面。
     *
     * ★ 名单在 `core/sync-columns.ts`，**只要有一列是他写的东西就照旧问**（D-201 不让）。
     */
    if (onlyMachineDiffs(remote.table, local.data, remote.data)) {
      return remote.updatedAt > local.updatedAt
        ? { kind: 'take-remote', reason: '不一样的全是机器算的账 —— 取新的那份，不打扰他' }
        : { kind: 'keep-local', reason: '不一样的全是机器算的账 —— 本地那份更新，留着' }
    }
    /**
     * ★★ D-201 的正题**留在这里没动** —— 「两边都改过」仍然要被如实判出来。
     *   D-438 要的「不问他」不在这一层做：**判据管认，引擎管处置**。
     *   （第一版我把这一格直接改成了「按时间定」，等于把整套冲突判据连同
     *     它 30 多条用例一起废掉 —— `npm run test:db` 当场 35 条红。返工记在 D-438。）
     */
    return {
      kind: 'conflict',
      reason: '上次同步之后，这一行两边都改过',
      localAt: local.updatedAt,
      remoteAt: remote.updatedAt
    }
  }

  if (remoteChanged) {
    return { kind: 'take-remote', reason: '只有云端改过' }
  }
  if (localChanged) {
    return { kind: 'keep-local', reason: '只有本地改过，等着推上去' }
  }

  // 两边都没在水位之后改过，却时间戳不同 —— 说明上次同步没把某一边落全。
  // 这种情况取新的那个，并且**说出来**，不当作正常路径。
  return remote.updatedAt > local.updatedAt
    ? { kind: 'take-remote', reason: '两边都没新改动，但云端那份更新 —— 上次同步没落全' }
    : { kind: 'keep-local', reason: '两边都没新改动，但本地那份更新 —— 上次同步没落全' }
}

export interface MergePlan {
  /**
   * ★★ Step 6C · 判成 `same` 的那些行 —— **两边一模一样，共同基版本就是它。**
   *
   * 它们不写库（没什么可写的），但「我手上这一版和远端一模一样」
   * 是一件**被证明了的一致**，正是共同基版本的定义。不记的话，
   * 他裁决过的那些行会一直停在旧基版本上，对面每改一次就再问他一次。
   */
  agreed: SyncRow[]
  apply: SyncRow[]
  conflicts: { row: SyncRow; local: SyncRow; localAt: number; remoteAt: number }[]
  /**
   * 有意没应用的行数 —— 判「不用动」的、留本地的、**以及被墓碑挡下的**。
   * R-4-G-e 的那条恒等式靠它：`received = applied + skipped + failed`。
   */
  skipped: number
  /**
   * ★★ R-3 · 被墓碑挡下的那些。**已经计进 `skipped` 了**，
   * 这里另存一份只是为了记账给他看（尤其是 `postPurge` 那种）。
   */
  blocked: { row: SyncRow; reason: string; postPurge: boolean }[]
}

/** 把一批远端行分成「直接应用」和「要问使用者」两堆。 */
export function planMerge(
  remoteRows: SyncRow[],
  localOf: (table: string, uid: string) => SyncRow | undefined,
  /** ★★ R-3 · 查这一行有没有墓碑。不传 = 没有墓碑机制（老测试照旧能跑） */
  tombOf?: (table: string, uid: string) => Tombstone | undefined,
  /**
   * ★★ R-3-g · 这一行的**父实体**被终结了吗（返回一句人话＝挡，`undefined`＝不挡）。
   *
   * 整批的判定由 `planParentBlocks` 事先算好（要处理两跳，边走边判不够），
   * 这里只是查一下结果。
   */
  parentBlockedOf?: (r: SyncRow) => string | undefined,
  /** ★★ R-4-F-a · 查他对这一行的裁决。不传 = 没有裁决机制（老测试照旧能跑） */
  resOf?: (table: string, uid: string) => ResolutionFact | undefined
,
  /**
   * ★★ Step 6C · 这一行的**共同基版本**（`row_sync_state`）。
   * 不传 / 返回 undefined = 没被确认同步过，两侧都算动过。
   */
  baseOf?: (table: string, uid: string) => number | undefined
): MergePlan {
  const apply: SyncRow[] = []
  const agreed: SyncRow[] = []
  const conflicts: MergePlan['conflicts'] = []
  const blocked: MergePlan['blocked'] = []
  let skipped = 0

  for (const r of remoteRows) {
    const local = localOf(r.table, r.uid)
    const d = decideRow(
      local,
      r,
      baseOf?.(r.table, r.uid),
      tombOf?.(r.table, r.uid),
      resOf?.(r.table, r.uid)
    )
    /**
     * ★★ R-3-g · 自己没被碑挡住，还要再问一句「它爹呢」。
     *
     * 顺序是先自己后父亲：自己那块碑能分出「遗骸 / 删后修改」，
     * 诊断更细；父级只有一种情况。
     */
    if (d.kind !== 'blocked') {
      const pb = parentBlockedOf?.(r)
      if (pb) {
        blocked.push({ row: r, reason: pb, postPurge: false })
        skipped += 1
        continue
      }
    }
    if (d.kind === 'take-remote') apply.push(r)
    else if (d.kind === 'same') {
      // ★ Step 6C · 两边一样 = 已经一致，记下来当共同基版本
      agreed.push(r)
      skipped += 1
    }
    else if (d.kind === 'conflict' && local) {
      conflicts.push({ row: r, local, localAt: d.localAt, remoteAt: d.remoteAt })
    } else {
      if (d.kind === 'blocked') blocked.push({ row: r, reason: d.reason, postPurge: d.postPurge })
      skipped += 1
    }
  }

  return { apply, conflicts, skipped, blocked, agreed }
}

/**
 * 使用者对一批冲突的裁决。
 * **只有这两个选项**，没有「自动合并」——
 * 逐字段合并一条解析或一次作答是没有意义的，合出来的东西两边都不认。
 */
export type Resolution = 'remote' | 'local'

export function applyResolution(plan: MergePlan, choice: Resolution): SyncRow[] {
  return choice === 'remote' ? [...plan.apply, ...plan.conflicts.map((c) => c.row)] : plan.apply
}

/** 一句人话，直接摆给使用者看（D-201 举的就是这个例子）。 */
export function describeConflicts(plan: MergePlan, now: number): string {
  if (plan.conflicts.length === 0) return ''
  const newestRemote = Math.max(...plan.conflicts.map((c) => c.remoteAt))
  const newestLocal = Math.max(...plan.conflicts.map((c) => c.localAt))
  return (
    `有 ${plan.conflicts.length} 处两边都改过：` +
    `云端是${ago(newestRemote, now)}改的，本地是${ago(newestLocal, now)}改的。用哪边？`
  )
}

function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60000))
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}
