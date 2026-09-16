/**
 * 墓碑 · 「这个东西被终结了」这条事实 · ★★ R-3
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * 软删是一次普通更新（`deleted_at` 有值），跨设备传得好好的。
 * **硬删不是** —— `delete from` 之后本地一丝痕迹都不剩，于是：
 *
 *   远端那一行到了 → 本地按 uid 查不到 → `!local` → 「这是对面新建的」→ 插进来
 *
 * 而「本地没有这一行」其实有两种成因：**对面新建的**，和**我这边彻底删掉的**。
 * 数据模型里没有任何东西能区分这两者，所以后一种一律被当成前一种。
 *
 * 复活不是假想，三条路都是必然会走到的：
 *   · `applied` 只留最后 500 个包名，溢出之后老包会被重新下载重放
 *   · 新设备 / 重装 / 导回备份 —— 从头拉全部包，包括早已删掉的行
 *   · 那台新设备还会把它们再推一遍，于是**原来那台也跟着复活**
 *
 * ── 药 ──────────────────────────────────────────────────────
 *
 * 和 `wipedAt` 同一个哲学（I-068 的教训）：**记一条本地事实，
 * 判断完全在本地做，不依赖任何网络操作成功。** 只是粒度从整库变成了每一行。
 *
 *   tombstone(target_uid, kind, purged_at)
 *     = 「这个跨设备实体，在本机于 purged_at 这一刻被终结了；
 *        任何 updated_at ≤ purged_at 的版本都是它的遗骸，不得据此重建。」
 *
 * 用「被终结」不用「不再存在」：前者是**发生过的事件**（只增不改，对应 D-216），
 * 后者是当下的状态断言，会诱人去问「那它现在还能不能存在」。
 *
 * ── 为什么墓碑永远不需要撤销 ────────────────────────────────
 *
 * 每张同步表的 uid 由 `after insert` 触发器生成随机值，
 * **全项目没有任何一处代码给新行指定 uid**（唯一例外是出厂内容的确定性 uid）。
 * 所以「他又建了一个看起来一模一样的东西」必然拿到一个**新的** uid ——
 * 旧墓碑挡的是旧身份，新对象跟它没关系。
 *
 * 身份和内容天然分开，这消掉了整整一类最容易写错的逻辑。
 */

export interface Tombstone {
  /** 被终结的那一行的 uid —— **跨设备身份**，判「这一行还能不能进来」用它 */
  targetUid: string
  /** 它原来在哪张表 */
  kind: string
  /** 什么时候被终结的 */
  purgedAt: number
  /**
   * ★★ R-3-g · 被终结的那一行**在库里的 id**。
   *
   * 为什么两个都要：派生子行是按 **id** 指向父亲的
   * （`review_logs.item_id = 1`），而碑上原来只记了 uid ——
   * 拿到一条子行根本没法问出「你爹是不是那块碑」，两边对不上号。
   *
   * id 在跨设备是一致的：`writeRows` 原样保留 id，那是 R-4-G 特意保住的性质。
   *
   * `null` = **V23 之前立的老碑**，或者收碑时那一行本机已经没了。
   *
   * ★★ C-2 之后它**不再参与父级拦截**（那一层改比 uid 了），
   * 所以「老碑没有 id」这个历史包袱自动消失。它现在只剩一个用处：
   * 本机自己删东西时留个号码，方便事后对账。**不进同步包**（见 `core/fk-map.ts`）。
   */
  targetId: number | null
}

import { SCOPE_TABLES, type Relation } from './fk-map.ts'

/**
 * 一条关系。★★ C-2 之后这里认的是**同步列**（`item_uid`），不是本地列（`item_id`）——
 * 包里根本没有本地 id 了。
 */
export type Fk = Relation

/**
 * 这一批同步里，哪些行因为**父实体已被终结**而应该跳过 · ★★ R-3-g
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * 父实体立了碑、本地那一行没了，可云端老包里还躺着一大堆它的派生行
 * （`answers` / `review_logs` / `occurrences` / `item_lectures` …）。
 * 实测下来两种下场，都不好：
 *
 *   · 有外键的 → INSERT 撞 `FOREIGN KEY constraint failed` → 算 `failed`
 *     → **那一包永远不进 `applied`，永远重试**，同步永远停在「没有完全成功」
 *   · 没外键的（只有 `picks`）→ **直接写进来**，成了查不到、看不见的孤儿
 *
 * ── 判据：碑是事实来源，不是「库里缺了那一行」★★ ────────────
 *
 * 这是本轮最重要的护栏。**绝不能写成「爹不在就跳过」**：
 * 子行先到、父行还在路上，是同步里再正常不过的时序，
 * 那时候必须**失败并重试**，等父亲到了自然就好。
 *
 *   父在（哪怕软删了）        → 正常应用
 *   父不在 · **有碑**         → 跳过（它爹被明确终结了）
 *   父不在 · 没碑             → 失败并重试（它可能还在路上）
 *
 * ── 为什么不给每条子行也立碑 ────────────────────────────────
 *
 * 删一讲会连带几百上千条派生行，碑会比数据还多。
 * 而它们的父亲只有一块碑 —— 顺着外键问一句就够了。
 */
export interface ParentBlockInput {
  rows: readonly { uid: string; table: string; data: Record<string, unknown> | null }[]
  /**
   * 立碑类 → 被终结的父实体**跨设备身份**。
   *
   * ★★ C-2 之前这里是本地 id 的集合，因为那时包里带着 id、而 id 跨设备一致。
   * 现在包里只有 uid，所以判据也换成 uid —— 顺带把 R-3-g 那个
   * 「V23 之前的老碑没有 target_id，拦不住它的孩子」的问题从根上去掉了：
   * **每一块碑都有 `target_uid`**，一条都不用排除在外。
   */
  terminated: ReadonlyMap<string, ReadonlySet<string>>
  /** 某张表的关系。由调用方从 `pragma foreign_key_list` + `core/fk-map.ts` 取 */
  fksOf: (table: string) => readonly Fk[]
}

/** `${table} ${uid}` —— 查这一行被挡了没有 */
export function rowKey(table: string, uid: string): string {
  return `${table} ${uid}`
}

/**
 * `picks` 是唯一一张**没有外键、却逻辑上挂在实体下**的表。
 *
 * 它用 `(scope, scope_id)` 指向一讲（`scope='lecture'`），没有任何约束 ——
 * 所以父讲被终结之后，那条精选材料会**照常写进来**，成为孤儿：
 * 查不到、界面上看不见、只占地方。实测确认过。
 *
 * 不给它加外键：那要重建表，而重建表是这个项目里最危险的操作（D-216）。
 * 单独写一条规则，并且**只在有碑时**生效 —— 没碑照旧失败重试，
 * 和别的表同一条护栏。
 */
/** ★ C-2 · 这份表搬去了 `core/fk-map.ts` —— 边界翻译和父级拦截共用同一份 */

/**
 * 扫一遍整批，算出哪些行该因为「爹被终结了」而跳过。
 *
 * ── 为什么要先扫全批，而不是边走边判 ──────────────────────
 *
 * 两跳：`drafts → questions → items`。`drafts` 的外键只够到 `questions`，
 * 而 `questions` 才是被父碑挡下的那一层。
 * 边走边判就得指望「`questions` 排在 `drafts` 前面」——
 * 那是 `SYNC_TABLES` 的顺序，**能成立但不是保证**。
 *
 * 所以跑到不动为止（fixpoint）：每一轮把新挡下的行的 id 记进集合，
 * 下一轮指向它们的行也跟着挡。**不查库、不递归、不留任何长期状态**，
 * 只在这一批里传递。轮数设上限只是防御 —— 外键真成环时宁可停下。
 */
export function planParentBlocks(input: ParentBlockInput): Map<string, string> {
  const blocked = new Map<string, string>()
  /**
   * 这一批里已经被挡下的行：表 → **uid** 集合。给两跳用。
   *
   * ★★ C-2 之前用的是 `data.id`，而那一列现在根本不进包了。
   * 换成行自己的 `uid` 反而更稳：每一行都有 uid，不像 id 那样可能为空。
   */
  const blockedUids = new Map<string, Set<string>>()

  const uid = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

  for (let round = 0; round < 8; round++) {
    let changed = false

    for (const r of input.rows) {
      if (!r.data || blocked.has(rowKey(r.table, r.uid))) continue

      let why: string | null = null

      // ① picks 那条特例 —— 它没有外键，只能认 (scope, scope_uid)
      if (r.table === 'picks') {
        const kind = SCOPE_TABLES[String(r.data['scope'] ?? '')]
        const u = uid(r.data['scope_uid'])
        if (kind && u !== null && input.terminated.get(kind)?.has(u)) {
          why = `它挂着的那一项已经被彻底删除了 —— 这条精选材料没有归属，没有收`
        }
      }

      // ② 顺着关系问一句：爹被终结了吗
      if (!why) {
        for (const fk of input.fksOf(r.table)) {
          const u = uid(r.data[fk.syncColumn])
          if (u === null) continue // 可空关系没填，跳过
          if (input.terminated.get(fk.parent)?.has(u)) {
            why = `它的上级（${fk.parent}）已经被彻底删除了 —— 这一条没有归属，没有收`
            break
          }
          // ③ 两跳：爹本身就是这一批里被挡下的
          if (blockedUids.get(fk.parent)?.has(u)) {
            why = `它的上级（${fk.parent}）这一批也被挡下了 —— 跟着一起没收`
            break
          }
        }
      }

      if (!why) continue
      blocked.set(rowKey(r.table, r.uid), why)
      changed = true
      const set = blockedUids.get(r.table) ?? new Set<string>()
      set.add(r.uid)
      blockedUids.set(r.table, set)
    }

    if (!changed) break
  }

  return blocked
}

export type TombstoneVerdict =
  | { blocked: false }
  | {
      blocked: true
      /**
       * ★ 远端那个版本**比墓碑还新** —— 有人在我终结它之后还改过它。
       *
       * 一样拒绝，只是要记一笔让他看得见。理由见下。
       */
      postPurge: boolean
      reason: string
    }

/**
 * 这一行还能不能进来。
 *
 * ── 两种情况都拒绝，这一点很要紧 ────────────────────────────
 *
 * | 远端版本 | 判定 |
 * |---|---|
 * | `updated_at ≤ purged_at` | 遗骸 —— 就是我删掉的那个东西，拒绝 |
 * | `updated_at > purged_at` | 另一台在我删掉之后又改过它，**仍然拒绝** + 记一笔 |
 *
 * 第二格是唯一需要判断力的地方。三条理由：
 *
 * ① **删除是他明确按下去的**（垃圾箱里点「彻底删除」，还要二次确认）；
 *    对面那次编辑很可能只是**离线时还没收到删除消息**，不是一个反对意见。
 * ② **代价不对称**：错误地复活 = 他删掉的东西又冒出来，而他不知道为什么、
 *    也不知道再删一次会不会又回来（I-068 抱怨的正是这种体验）；
 *    错误地拒绝 = 丢掉一次编辑，但原内容在对面的库里还在，而且体检会说。
 * ③ **它极其罕见**：要「A 删了 + B 在删之后改了 + 中间没同步过」三件事同时发生。
 *
 * ── 而且这样一来，删除安全性**不依赖时钟** ──────────────────
 *
 * 判「遗骸 vs 删后修改」比较的是两台机器的墙钟（R-3-c 未解决）。
 * 但两格的结论都是拒绝，所以时钟偏差**只影响那条诊断准不准，
 * 不影响「删掉的东西会不会回来」**。这是第二格也拒绝的第四条理由。
 */
export function isBlocked(
  tomb: Tombstone | undefined,
  remoteUpdatedAt: number
): TombstoneVerdict {
  if (!tomb) return { blocked: false }

  if (remoteUpdatedAt > tomb.purgedAt) {
    return {
      blocked: true,
      postPurge: true,
      reason:
        `这一条在本机已经被彻底删除，而另一台设备在那之后还改过它 —— ` +
        `没有让它回来。要是还想要，在那台设备上重新建一条。`
    }
  }

  return {
    blocked: true,
    postPurge: false,
    reason: '这一条在本机已经被彻底删除 —— 云端那份是删除之前的旧版本，没有收。'
  }
}

/** 墓碑在库里的键。`kind` 一起进 —— 不同表的 uid 天生不撞，但明写更省事 */
export function tombKey(kind: string, targetUid: string): string {
  return `${kind}\0${targetUid}`
}

/**
 * 会立墓碑的六类。**只有他自己看得见、会说「我删了这个」的东西。**
 *
 * 派生行（`item_lectures` / `occurrences` / `answers` / `questions` /
 * `review_logs` / `analysis_blocks` / `state_events` / `item_events`）
 * **一律不立**，两条理由：
 *
 *   · 数量：删一讲会连带几百到几千条，墓碑比数据还多
 *   · 收益为零：它们的外键指向的父实体已经被父墓碑挡住了
 *
 * 派生行在同步里的实际表现留给 R-3-g 单独处理 —— 用真双机用例打出来再定，
 * 不要现在就猜。
 */
export const TOMBSTONE_KINDS = [
  'projects',
  'units',
  'lectures',
  'items',
  'materials',
  'files'
] as const
export type TombstoneKind = (typeof TOMBSTONE_KINDS)[number]

export function needsTombstone(table: string): table is TombstoneKind {
  return (TOMBSTONE_KINDS as readonly string[]).includes(table)
}
