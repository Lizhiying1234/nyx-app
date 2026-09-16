/**
 * 同步边界上的身份翻译 · ★★ Step 3 / C-2 / D-286（2026-08-18）
 *
 * ── 一句话 ──────────────────────────────────────────────────
 *
 *   本地库          id / item_id / lecture_id …      （自增，只在这台机器有意义）
 *      ↕ 边界翻译
 *   同步包          uid / item_uid / lecture_uid …   （跨设备身份）
 *
 * 业务层继续用数字 id（213 处 `where id = ?`、71 个 IPC、43 个契约字段一行不改）。
 * 变的只有**推出去和收进来的那一刻**。
 *
 * ── 为什么必须做 ────────────────────────────────────────────
 *
 * `writeRows` 原样保留 `id` 是 R-4-G 特意保住的性质 —— 那时的理由是
 * 「不保留的话每一条外键都指错，而且不报错」。但代价是：
 * 两台设备各自新建一行会分到同一个自增 id，`on conflict(uid)` 不接管，
 * 撞主键、永久失败（架构报告 §2.1 轴 ①）。
 *
 * C-1 消掉了「同一件事实两个身份」，剩下的正是这一条：**不同的事实抢同一个号**。
 * 翻译之后包里根本没有 id，收的那一侧自己分配 —— 抢不起来。
 *
 * ── 三类关系，来源不同 ──────────────────────────────────────
 *
 *   ① SQL 外键        `pragma foreign_key_list` 是权威，运行时问库，不手抄
 *   ② 代码里的关系    pragma 看不见，必须在这里**明写**（漏一条就是一个悄悄断掉的关系）
 *   ③ 动态关系        父表由同一行的另一列决定（`picks.scope`、`tombstones.kind`）
 *
 * 实测：27 条 SQL 外键、0 条复合外键、1 条自引用（`items.derived_from`）；
 * 第 ② 类两条、第 ③ 类两条。清单见下面。
 */

/**
 * 同步包里这一列叫什么。
 *
 * `item_id` → `item_uid`；不以 `_id` 结尾的（`derived_from`）直接加后缀。
 * 规则写成函数而不是逐条列举 —— 列举会漏，而漏掉的表现是
 * 「那个关系在另一台上断了」，不报错。
 */
export function syncColumnOf(column: string): string {
  return column.endsWith('_id') ? `${column.slice(0, -3)}_uid` : `${column}_uid`
}

/** 一条要翻译的关系 */
export interface Relation {
  /** 本地那一列（存的是数字 id） */
  column: string
  /** 指向哪张表 */
  parent: string
  /** 同步包里那一列的名字 */
  syncColumn: string
}

/**
 * ★ `pragma foreign_key_list` **看不见**的关系。
 *
 * 这一段是手写的，所以它必须是**穷举过的**：
 * `db-safety` 里有一条用例扫遍每张同步表里所有 `*_id` 列，
 * 凡是既不是 SQL 外键、又不在这份清单（或下面两份）里的，当场红。
 * 漏一条的后果是那个关系在另一台设备上断掉，而且不报错。
 */
export const EXTRA_RELATIONS: Readonly<Record<string, readonly Relation[]>> = {
  /**
   * 「这一讲上次用的分析预设」。它**没有** SQL 外键（V3 加列时没写），
   * 但 `prompt_presets` 是同步表、有 uid，关系是真的。
   */
  lectures: [{ column: 'preset_id', parent: 'prompt_presets', syncColumn: 'preset_uid' }]
}

/**
 * ★ 父表由同一行的另一列决定的关系。
 *
 * 这一类没法从任何一张静态表里推出来 —— 得先读那一行的判别列。
 */
export interface DynamicRelation {
  /**
   * 父级被**彻底删除**时，这些行要不要跟着删。
   * **默认 false** —— 新加的条目必须自己想清楚再打开（见 `tombstones` 那条的说明）。
   */
  cascade?: boolean
  /** 本地那一列 */
  column: string
  /** 决定父表是谁的那一列 */
  discriminator: string
  /** 判别列的值 → 父表名。认不出就返回 `null`（那就不是一条关系） */
  tableOf: (v: unknown) => string | null
  /**
   * 同步包里那一列的名字。
   * `null` = **不进包** —— 因为同一行里已经有别的列携带了同一个身份。
   */
  syncColumn: string | null
}

/**
 * `picks` 挂在哪一级 —— 它用 `(scope, scope_id)` 指，**没有任何约束**。
 *
 * ★ 「AI 精选材料」这个功能已经删掉了（2026-09-03），但表和老数据还在
 *   （理由见 `core/sync-tables.ts` 那一行）。所以这份映射照旧要对 ——
 *   老行还要跟着父级级联、还要跨设备走。
 *
 * 这份表以前藏在 `core/tombstone.ts` 里，只有父级拦截用得到。
 * 现在它是边界翻译的一部分，搬到这里，两处共用同一份
 * （`tombstone.ts` 从这里 import，不再自己写一份）。
 */
export const SCOPE_TABLES: Readonly<Record<string, string>> = {
  lecture: 'lectures',
  project: 'projects'
}

export const DYNAMIC_RELATIONS: Readonly<Record<string, readonly DynamicRelation[]>> = {
  picks: [
    {
      column: 'scope_id',
      discriminator: 'scope',
      tableOf: (v) => SCOPE_TABLES[String(v ?? '')] ?? null,
      syncColumn: 'scope_uid',
      /**
       * ★★ 父级被彻底删掉时，这些行跟着走（2026-09-02）。
       *
       * 实证：他把 Gone Girl 彻底删了，那条选读推荐还活着、还指着
       * `projects` 第 20 行 —— 于是**每次同步都推不出去、报一条问题**，
       * 而那条建议本身早就没有意义了。
       * 按 D-435「被删除的就当死了」，它本来就该一起死。
       *
       * SQL 外键管不到这一层（`picks` 用 `(scope, scope_id)` 指，没有约束），
       * 所以级联要**照这份清单**补一刀。
       */
      cascade: true
    }
  ],
  tombstones: [
    /**
     * ★ `target_id` **不进包**。
     *
     * 同一行的 `target_uid` 已经是那个被终结实体的跨设备身份 ——
     * `target_id` 只是它在**本机**的号码。收的那一侧自己按 `target_uid`
     * 反查一次就有了（那一行多半还在，正等着被这块碑删掉）；
     * 查不到就是 `null`，而 V23 之前的老碑本来就是 `null`，
     * 那条路（不参与父级拦截 + 体检报出来）一直都在。
     *
     * 顺带把 R-3-g 那个「老碑没有 target_id 所以拦不住它的孩子」的问题
     * 从根上去掉了：C-2 之后父级拦截比的是 **uid**，不再需要 id。
     */
    {
      column: 'target_id',
      discriminator: 'kind',
      tableOf: (v) => (typeof v === 'string' && v !== '' ? v : null),
      syncColumn: null,
      /**
       * ★★★ **绝对不许跟着级联删。**
       *   墓碑指着的正是刚被删掉的那个实体 —— 跟着删等于**把刚立的碑自己铲了**，
       *   删除从此传不到另一台，而且不报错。
       *   `cascade` 默认就是 false，这里写出来是**立此存照**：
       *   将来有人给这份清单加新条目时，得先想清楚这一栏。
       */
      cascade: false
    }
  ]
}

/**
 * ★ 送出去之前要**删掉**的列 —— 它们在另一台机器上没有意义，
 *   而带过去只会让人以为它有意义。
 */
export const DROP_ON_SYNC: Readonly<Record<string, readonly string[]>> = {
  /**
   * 行为流水里的 `target_id` 是一条**展示用的面包屑**，不是关系：
   * 它可能指向一个早就被彻底删掉的东西，`target` 那一列存的也可能是
   * `settings` 这种根本没有 uid 的东西。
   * 带着另一台机器的号码过去，只会指到一行毫不相干的数据上。
   * 那一行真正的意思在 `title` / `detail` 里，它们照常同步。
   */
  ops_log: ['target_id'],
  /**
   * ★★ D-296 · V34 把认读卡搬去了 `reading_cards`，这 6 列**冻结在迁移那一刻**。
   *
   * ── 为什么光「保留但不写」不够 ────────────────────────────
   *
   * 留在表上就仍然在同步表面里、仍然随 `items` 行进包。
   * 两台设备**迁移前若已同步**，冻结值相同，无害；
   * 但只要迁移前有过分歧（一台上有还没推上去的练习），
   * 冻结值就不同 → `items` 行仍然不同 → **照样判冲突**。
   *
   * 那就等于：把 `card_*` 搬出去消除假冲突，冻结的副本却把假冲突
   * 原样留在了 `items` 上。D-296 白拆了。
   *
   * ── 所以不发 ──────────────────────────────────────────────
   *
   * 列还在（回滚要用），但**不进包、不参与合并**；
   * `tests/convergence.ts` 的收敛 Oracle 也跳过 `DROP_ON_SYNC` 的列，
   * 所以不会被误报成两台分歧。
   * 结构指纹**照算**（`schema-fingerprint.ts` 不看这份表）—— 结构就是结构。
   */
  items: ['card_ease', 'card_interval', 'card_reps', 'card_lapses', 'card_due_at', 'card_silent']
}

/** 每一行都必须删掉的列：本地自增主键 */
export const ALWAYS_DROP = 'id'

/**
 * 这张表在同步包里该有哪些「关系列」。
 *
 * @param declared 由调用方从 `pragma foreign_key_list` 取来 —— 纯函数不查库
 */
export function relationsOf(table: string, declared: readonly Relation[]): Relation[] {
  const extra = EXTRA_RELATIONS[table] ?? []
  const seen = new Set<string>()
  const out: Relation[] = []
  for (const r of [...declared, ...extra]) {
    if (seen.has(r.column)) continue
    seen.add(r.column)
    out.push(r)
  }
  return out
}

export const dynamicOf = (table: string): readonly DynamicRelation[] => DYNAMIC_RELATIONS[table] ?? []
export const droppedOf = (table: string): readonly string[] => DROP_ON_SYNC[table] ?? []

// ══════════════════════════════════════════════════════════════
// 翻译本身 —— 纯函数，查库的部分由调用方用回调喂进来
// ══════════════════════════════════════════════════════════════

/** 本地库里读出来的一行，原样 */
export type LocalData = Record<string, unknown>
/** 同步包里的一行 —— **不含本地 id，关系全是 uid** */
export type SyncData = Record<string, unknown>

export type ToSyncResult =
  | { ok: true; data: SyncData }
  | { ok: false; why: string }

/**
 * 本地行 → 同步行。
 *
 * @param uidOf 拿本地 id 换 uid。查不到返回 `null`
 *
 * ★ **父行的 uid 查不到就整行不发**（使用者 §4.2）。
 *   发一个 `parent_uid: null` 出去，对面会得到一条没有归属的行 ——
 *   而它看起来完全正常，没有任何东西会报错。
 */
export function toSync(
  table: string,
  row: LocalData,
  rels: readonly Relation[],
  dyn: readonly DynamicRelation[],
  uidOf: (parentTable: string, id: number) => string | null
): ToSyncResult {
  const out: SyncData = {}
  const drop = new Set<string>([ALWAYS_DROP, ...droppedOf(table)])
  const relByCol = new Map(rels.map((r) => [r.column, r]))
  const dynByCol = new Map(dyn.map((d) => [d.column, d]))

  for (const [k, v] of Object.entries(row)) {
    if (drop.has(k)) continue

    const rel = relByCol.get(k)
    if (rel) {
      if (v === null || v === undefined) {
        out[rel.syncColumn] = null
        continue
      }
      const n = Number(v)
      if (!Number.isFinite(n)) return { ok: false, why: `${table}.${k} 不是一个 id：${String(v)}` }
      const uid = uidOf(rel.parent, n)
      if (!uid) {
        return {
          ok: false,
          why: `${table}.${k} 指向 ${rel.parent} 第 ${n} 行，可那一行不在（或者它还没有跨设备身份）`
        }
      }
      out[rel.syncColumn] = uid
      continue
    }

    const d = dynByCol.get(k)
    if (d) {
      if (d.syncColumn === null) continue // 不进包（身份由同一行的别的列携带）
      if (v === null || v === undefined) {
        out[d.syncColumn] = null
        continue
      }
      const parent = d.tableOf(row[d.discriminator])
      if (!parent) {
        // 判别列认不出来 —— 这一行的这个指针本来就不是一条关系，原样留着数字没有意义
        out[d.syncColumn] = null
        continue
      }
      const n = Number(v)
      if (!Number.isFinite(n)) return { ok: false, why: `${table}.${k} 不是一个 id：${String(v)}` }
      const uid = uidOf(parent, n)
      if (!uid) {
        return { ok: false, why: `${table}.${k} 指向 ${parent} 第 ${n} 行，可那一行不在` }
      }
      out[d.syncColumn] = uid
      continue
    }

    out[k] = v
  }
  return { ok: true, data: out }
}

export type ToLocalResult =
  | { ok: true; data: LocalData }
  | { ok: false; why: string }

/**
 * 同步行 → 本地行。
 *
 * @param idOf 拿 uid 换本地 id。查不到返回 `null`（父行还没到）
 *
 * ★ 父行还没到就**整行失败**（使用者 §5）——
 *   不猜 id、不按字符串截、不自动建父行、不拿 0 / null 顶。
 *   失败会让那一包不进 `applied`，下一次同步父行到了自然就成了。
 */
export function toLocal(
  table: string,
  data: SyncData,
  rels: readonly Relation[],
  dyn: readonly DynamicRelation[],
  idOf: (parentTable: string, uid: string) => number | null
): ToLocalResult {
  const out: LocalData = {}
  const bySync = new Map(rels.map((r) => [r.syncColumn, r]))
  const dynBySync = new Map(dyn.filter((d) => d.syncColumn).map((d) => [d.syncColumn as string, d]))

  for (const [k, v] of Object.entries(data)) {
    const rel = bySync.get(k)
    if (rel) {
      if (v === null || v === undefined) {
        out[rel.column] = null
        continue
      }
      if (typeof v !== 'string' || v === '') {
        return { ok: false, why: `${table}.${k} 不是一个跨设备身份：${String(v)}` }
      }
      const id = idOf(rel.parent, v)
      if (id === null) {
        return { ok: false, why: `它的上级（${rel.parent} / ${v}）还没同步过来` }
      }
      out[rel.column] = id
      continue
    }

    const d = dynBySync.get(k)
    if (d) {
      if (v === null || v === undefined) {
        out[d.column] = null
        continue
      }
      const parent = d.tableOf(data[d.discriminator])
      if (!parent) {
        out[d.column] = null
        continue
      }
      if (typeof v !== 'string' || v === '') {
        return { ok: false, why: `${table}.${k} 不是一个跨设备身份：${String(v)}` }
      }
      const id = idOf(parent, v)
      if (id === null) {
        return { ok: false, why: `它挂着的那一项（${parent} / ${v}）还没同步过来` }
      }
      out[d.column] = id
      continue
    }

    out[k] = v
  }

  /**
   * ★★ 不进包的那几个（`tombstones.target_id`）**这里不补** —— 留给它唯一的写入方。
   *
   * 一开始我在这里按 `target_uid` 反查了一次本地号码，看着挺合理。
   * 负向对照当场打脸：把这段删掉，**一条用例都不红**。
   * 原因是 `applyTombstones` 执行这块碑时会走 `hardDelete` →
   * `cascade.writeTombstones` 就地把 `target_id` 按本机的号码写好了 ——
   * 也就是说这段代码从来没承过重，只是多了一份写同一个字段的路。
   *
   * 那就删掉：**`target_id` 只有一个写入方**（`writeTombstones`）。
   * 那一行本机已经没了的情况留 `null`，而那本来就是合法状态
   * （V23 之前的老碑一直是 `null`，C-2 之后它也不再影响任何判定）。
   */

  return { ok: true, data: out }
}

/**
 * 一行同步数据里**不该出现**的东西 —— 给测试和收包时的自检用。
 *
 * 判据：本地自增主键、以及任何一条关系的**本地列名**。
 * 出现了就说明有一条路没走翻译，而那条路会在另一台设备上悄悄断掉关系。
 */
export function localOnlyKeys(
  data: SyncData,
  rels: readonly Relation[],
  dyn: readonly DynamicRelation[]
): string[] {
  const bad = new Set<string>([ALWAYS_DROP, ...rels.map((r) => r.column), ...dyn.map((d) => d.column)])
  return Object.keys(data).filter((k) => bad.has(k))
}
