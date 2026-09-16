import { ALWAYS_DROP, DROP_ON_SYNC } from '../src/core/fk-map.ts'
import { existsSync, readdirSync } from 'node:fs'

/**
 * ★★ Step 7A · 「两台设备真的收敛了」的判据 —— **系统级 Oracle**
 *
 * ── 这个文件是 Step 7 最重要的产物 ──────────────────────────
 *
 * 不是「18 个场景全绿」。是**一把能证明收敛的尺子**。
 * 场景可以慢慢加，尺子错了则所有场景一起变成安慰牌。
 *
 * 所以它自己必须先被证伪过：`db-safety.ts` 里有六条负向对照，
 * 分别人为破坏业务字段 / 制造孤儿状态 / 改墓碑 / 改音频 / 改裁决 /
 * 让第二轮继续变化，**六处都必须被这把尺子当场抓到**。
 *
 * ── 为什么不能只比业务表 ────────────────────────────────────
 *
 * 「两边行数一样、内容一样」远远不够。这套协议里下面每一样都可能
 * 两边不一致，而业务表看起来完全正常：
 *
 *   墓碑不一致      → 一边删掉的东西在另一边下次同步又活过来
 *   裁决不一致      → 他做过的决定在另一台上被推翻
 *   基状态有孤儿    → `row_sync_state` 指着已经不存在的行（G1）
 *   还有待推        → 界面说同步好了，其实还剩一批没上去
 *   外键有孤儿      → 子行挂在一个不存在的父上
 *   音频不一致      → 内容一致但听不了（D-244 音频进同步）
 *   不是不动点      → 再同步一次状态又变了，那根本不叫收敛
 *
 * ── 跨两层复用 ──────────────────────────────────────────────
 *
 * I 层（`db-safety`，真 Sync + 真 HTTP）用 `better-sqlite3`，
 * S 层（`sync.test.ts`，真 Electron ×2）用 `node:sqlite`。
 * 两者恰好都是 `db.prepare(sql).all(...)`，所以这里只要一个最小适配面，
 * 不必把 Oracle 复制两份 —— 复制两份就会漂，漂了就没人知道哪一份是对的。
 */

/** 两种驱动的最小公共面 */
export interface DbLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}

const all = (db: DbLike, sql: string, ...p: unknown[]): Record<string, unknown>[] =>
  db.prepare(sql).all(...p) as Record<string, unknown>[]

/**
 * 参与收敛判定的表。
 *
 * ★ 故意**不**从 `SYNC_TABLES` import：那份清单是生产代码的事实，
 *   Oracle 应该独立地说出「我要比哪些表」。两边都从同一处取的话，
 *   有人从同步里拿掉一张表时，Oracle 会跟着不看它 —— 尺子随被量物一起变。
 *   这里改成**从库里问**：所有带 `uid` 与 `updated_at` 的表都要比。
 */
function syncedTables(db: DbLike): string[] {
  const names = all(
    db,
    `select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`
  ).map((r) => String(r['name']))
  const out: string[] = []
  for (const t of names) {
    if (t === 'row_sync_state' || t === 'settings' || t === 'migration_log') continue
    const cols = all(db, `pragma table_info("${t}")`).map((c) => String(c['name']))
    if (cols.includes('uid') && cols.includes('updated_at')) out.push(t)
  }
  return out.sort()
}

/** 这张表的外键：哪一列指向哪张表 */
function fksOf(db: DbLike, table: string): { from: string; parent: string }[] {
  try {
    return all(db, `pragma foreign_key_list("${table}")`).map((r) => ({
      from: String(r['from']),
      parent: String(r['table'])
    }))
  } catch {
    return []
  }
}

/**
 * 把一行**归一成跨设备可比的字符串**。
 *
 * ★ 本地 `id` 去掉，数字外键**翻译成父行的 uid** —— 不是删掉。
 *   删掉的话「子行挂到了别的父上」这种错误 Oracle 就看不见了，
 *   而那正是场景 #6（父删 / 子增交叉）要抓的东西。
 */
function canonicalRows(db: DbLike, table: string): Map<string, string> {
  const cols = all(db, `pragma table_info("${table}")`).map((c) => String(c['name']))
  const fks = fksOf(db, table)
  const parentUid = new Map<string, Map<number, string>>()
  for (const fk of fks) {
    if (parentUid.has(fk.parent)) continue
    const m = new Map<number, string>()
    try {
      for (const r of all(db, `select id, uid from "${fk.parent}"`)) {
        m.set(Number(r['id']), String(r['uid']))
      }
    } catch {
      /* 父表没有 id/uid 就不翻译 */
    }
    parentUid.set(fk.parent, m)
  }

  const out = new Map<string, string>()
  for (const row of all(db, `select * from "${table}"`)) {
    /**
     * ★★ PRISTINE 行的 `created_at` **两台天然不同**，这不是分歧。
     *
     * `db/builtins.ts` 写得很清楚：出厂内容的 `updated_at` 写 0（不是本地变更），
     * 而 `created_at` 仍写真实时间 —— 它是「这一行什么时候进的库」，与同步无关。
     * 两台各自播种，进库时刻当然不一样。
     *
     * ★ 豁免**只针对出厂行**：同步进来的行，`created_at` 是随包传过来的，
     *   两边必须一致，那一列照比不误。
     */
    const pristine = Number(row['updated_at'] ?? -1) === 0
    const parts: string[] = []
    for (const c of cols.slice().sort()) {
      /**
       * ★★ 跨设备**不可比**的列，三类，一类都不能拿来判分歧：
       *
       *   `id`                本地自增主键（`ALWAYS_DROP`）
       *   `DROP_ON_SYNC`      协议**根本不发**的列。目前只有
       *                       `ops_log.target_id` —— 它是展示用的面包屑，
       *                       不是关系；带着另一台的号码过去只会指到
       *                       一行毫不相干的数据上（`core/fk-map.ts` 有原文）
       *   `tombstones.target_id`  它**会**传过去，但收的那一侧会用
       *                       **本机**那一行的号码覆盖它（R-3-g：子行按 id
       *                       指向父亲，光有 uid 认不出孩子）。所以两台
       *                       天然不同，而且必须不同
       *
       * ★ 前两类直接用 `core/fk-map.ts` 里那份**权威清单**，不另起一份 ——
       *   另起一份就会漂，漂了以后 Oracle 会开始比协议根本不传的东西
       *   （这条就是这么被 S 层揪出来的：ops_log.target_id 两台不同，
       *   而它压根没上过网）。
       */
      if (c === ALWAYS_DROP) continue
      if ((DROP_ON_SYNC[table] ?? []).includes(c)) continue
      if (table === 'tombstones' && c === 'target_id') continue
      if (pristine && c === 'created_at') continue
      const fk = fks.find((f) => f.from === c)
      if (fk) {
        const v = row[c]
        const uid = v === null || v === undefined ? null : (parentUid.get(fk.parent)?.get(Number(v)) ?? `?${String(v)}`)
        parts.push(`${c}=→${fk.parent}:${uid}`)
      } else {
        parts.push(`${c}=${JSON.stringify(row[c] ?? null)}`)
      }
    }
    out.set(String(row['uid']), parts.join('\x01'))
  }
  return out
}

export interface DeviceSnapshot {
  name: string
  /** `表|uid` → 归一后的整行 */
  business: Map<string, string>
  /** `kind|target_uid` → `purged_at` */
  tombstones: Map<string, string>
  /** `kind|target_uid` → `rejected_up_to` */
  resolutions: Map<string, string>
  /** 音频文件名（内容哈希命名，名字相同即内容相同） */
  audio: string[]
  /** ★ 本机自己的事，**不跨设备比** —— 两台的基状态天然不同 */
  local: {
    /** `row_sync_state` 指着已经不存在的业务行（G1） */
    orphanState: string[]
    /** 还有没推上去的行 */
    pending: string[]
    /** 还没对过账的行 */
    unsynced: string[]
    /** 外键指向不存在的父 */
    fkBroken: number
  }
  /** 不动点判定用：业务 + 墓碑 + 裁决 + 音频 + 本机基状态值 */
  digest: string
}

/**
 * ★ `updated_at = 0` 是出厂内容（PRISTINE）：它不是本地待推变更，
 *   也不进 `row_sync_state`。判 pending / unsynced 时必须豁免，
 *   否则每台机器都会永远「有几十条待推」。
 */
const NOT_PRISTINE = `t.updated_at <> 0`

export function snapshot(name: string, db: DbLike, audioDir?: string): DeviceSnapshot {
  const tables = syncedTables(db)
  const business = new Map<string, string>()
  const orphanState: string[] = []
  const pending: string[] = []
  const unsynced: string[] = []

  for (const t of tables) {
    if (t === 'tombstones' || t === 'resolutions') continue
    for (const [uid, row] of canonicalRows(db, t)) business.set(`${t}|${uid}`, row)
  }

  const tombstones = new Map<string, string>()
  try {
    for (const r of all(db, `select kind, target_uid, purged_at from tombstones`)) {
      tombstones.set(`${String(r['kind'])}|${String(r['target_uid'])}`, String(r['purged_at']))
    }
  } catch {
    /* 没有墓碑表 */
  }

  const resolutions = new Map<string, string>()
  try {
    for (const r of all(db, `select kind, target_uid, rejected_up_to from resolutions`)) {
      resolutions.set(`${String(r['kind'])}|${String(r['target_uid'])}`, String(r['rejected_up_to']))
    }
  } catch {
    /* 没有裁决表 */
  }

  /** 本机基状态自洽 —— 三条，各自查各自的 */
  const stateVals: string[] = []
  try {
    for (const t of tables) {
      for (const r of all(
        db,
        `select t.uid as uid from "${t}" t
           left join row_sync_state s on s.table_name = ? and s.uid = t.uid
          where ${NOT_PRISTINE}
            and (s.pushed_updated_at is null or s.pushed_updated_at <> t.updated_at)`,
        t
      )) {
        pending.push(`${t}|${String(r['uid'])}`)
      }
      /**
       * ★★ 「这一行对过账了吗」的判据有**两种成立方式**：
       *
       *   ① `synced == updated_at` —— 我手上这一版就是我处理过的那一版
       *   ② 他对这一行做过决定，而 `synced` 正是他拒掉的那一版 ——
       *      也就是说远端那一版**已经被处理过**（他说了不要），
       *      本地版本因此比它新。这是 keep-local 之后的**正常状态**，
       *      不是「还没对账」。
       *
       * 只认 ① 的话，每一次「用本地的」都会在 Oracle 里留下一条永久残留，
       * 而那一行其实什么都不缺（F-4 就是这么被误报成缺陷的）。
       */
      for (const r of all(
        db,
        `select t.uid as uid from "${t}" t
           left join row_sync_state s on s.table_name = ? and s.uid = t.uid
           left join resolutions x on x.target_uid = t.uid and x.kind = ?
          where ${NOT_PRISTINE}
            and (s.synced_updated_at is null or s.synced_updated_at <> t.updated_at)
            and (x.rejected_up_to is null or x.rejected_up_to <> s.synced_updated_at)`,
        t,
        t
      )) {
        unsynced.push(`${t}|${String(r['uid'])}`)
      }
    }
    /**
     * ★★ G1 · 孤儿基状态：`row_sync_state` 里有，业务表里没有。
     *
     * 基状态本该跟着实体的生命周期走。留着的话 ① 这张表只增不减；
     * ② 同一个 uid 再出现（导回旧备份、把删掉的东西重建回来）时，
     * 拿到的是**上一世代**的基版本 —— 合并会拿一个早就不成立的共同基
     * 去判「谁改过」，而它判错时不报错，只静默选错边。
     */
    for (const r of all(
      db,
      `select table_name, uid, synced_updated_at, pushed_updated_at from row_sync_state`
    )) {
      const t = String(r['table_name'])
      const uid = String(r['uid'])
      stateVals.push(`${t}|${uid}|${String(r['synced_updated_at'])}|${String(r['pushed_updated_at'])}`)
      if (!business.has(`${t}|${uid}`) && !tombstones.has(`${t}|${uid}`)) {
        const stillThere =
          t === 'tombstones' || t === 'resolutions'
            ? all(db, `select 1 as x from "${t}" where uid = ?`, uid).length > 0
            : false
        if (!stillThere) orphanState.push(`${t}|${uid}`)
      }
    }
  } catch {
    /* 还没建 row_sync_state 的老库 */
  }

  let fkBroken = 0
  try {
    fkBroken = all(db, `pragma foreign_key_check`).length
  } catch {
    /* 忽略 */
  }

  const audio =
    audioDir && existsSync(audioDir)
      ? readdirSync(audioDir)
          .filter((f) => f.endsWith('.mp3'))
          .sort()
      : []

  /**
   * ★ 摘要**不含任何记账时刻**（`row_sync_state.updated_at` 那类）。
   *   含了的话「什么都没变、只是又记了一笔」也会让不动点判定永远不成立。
   */
  const digest = [
    ...[...business.entries()].sort().map(([k, v]) => `B ${k} ${v}`),
    ...[...tombstones.entries()].sort().map(([k, v]) => `T ${k} ${v}`),
    ...[...resolutions.entries()].sort().map(([k, v]) => `R ${k} ${v}`),
    ...stateVals.sort().map((s) => `S ${s}`),
    ...audio.map((a) => `A ${a}`)
  ].join('\n')

  return {
    name,
    business,
    tombstones,
    resolutions,
    audio,
    local: { orphanState, pending, unsynced, fkBroken },
    digest
  }
}

const diffMaps = (
  what: string,
  a: Map<string, string>,
  b: Map<string, string>,
  an: string,
  bn: string
): string[] => {
  const out: string[] = []
  for (const [k, v] of a) {
    if (!b.has(k)) out.push(`${what} ${k}：只有 ${an} 有`)
    else if (b.get(k) !== v) {
      /** ★ 说清**哪一列**不同 —— 只说「内容不同」的报错，排查时等于没说 */
      const bv = b.get(k) ?? ''
      const mine = v.split('\x01')
      const theirs = bv.split('\x01')
      const cols = mine.filter((x, i) => theirs[i] !== x).slice(0, 3).join(' ')
      out.push(`${what} ${k}：两边内容不同（${cols || '结构不同'}）`)
    }
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`${what} ${k}：只有 ${bn} 有`)
  return out
}

/** 一台机器自己是否自洽（不跨设备） */
export function selfProblems(s: DeviceSnapshot): string[] {
  const out: string[] = []
  if (s.local.orphanState.length > 0) {
    out.push(
      `${s.name}：${s.local.orphanState.length} 条孤儿基状态（${s.local.orphanState.slice(0, 3).join('、')}）—— row_sync_state 没跟着实体生命周期走`
    )
  }
  if (s.local.pending.length > 0) {
    out.push(
      `${s.name}：还有 ${s.local.pending.length} 行没推上去（${s.local.pending.slice(0, 3).join('、')}）`
    )
  }
  if (s.local.unsynced.length > 0) {
    out.push(
      `${s.name}：还有 ${s.local.unsynced.length} 行没对过账（${s.local.unsynced.slice(0, 3).join('、')}）`
    )
  }
  if (s.local.fkBroken > 0) out.push(`${s.name}：${s.local.fkBroken} 处外键指向不存在的父（孤儿）`)
  return out
}

/**
 * ★★ 两台收敛了吗。返回**空数组**才算收敛。
 *
 * 注意 `row_sync_state` **不跨设备比相等** —— 它是本地专有的事实，
 * 两台天然不同（谁推的、谁收的）。它的正确性由 `selfProblems` 各自验。
 */
export function convergenceProblems(a: DeviceSnapshot, b: DeviceSnapshot): string[] {
  return [
    ...diffMaps('业务行', a.business, b.business, a.name, b.name),
    ...diffMaps('墓碑', a.tombstones, b.tombstones, a.name, b.name),
    ...diffMaps('裁决', a.resolutions, b.resolutions, a.name, b.name),
    ...(a.audio.join(',') === b.audio.join(',')
      ? []
      : [`音频文件集合不同：${a.name} ${a.audio.length} 个 / ${b.name} ${b.audio.length} 个`]),
    ...selfProblems(a),
    ...selfProblems(b)
  ]
}

// ══════════════════════════════════════════════════════════════
// 多轮同步驱动
// ══════════════════════════════════════════════════════════════

export interface ConvergenceDevice {
  name: string
  /** 跑一次同步（真按钮 / 真 Sync 都行） */
  sync: () => Promise<unknown>
  /** 现在这台机器长什么样 */
  snapshot: () => DeviceSnapshot
}

export interface FixedPointResult {
  /** 达到不动点用了几轮 */
  rounds: number
  /** 空数组 = 收敛了 */
  problems: string[]
  /** 每一轮的摘要，出问题时拿来看是哪一轮开始震荡的 */
  trace: string[]
}

/**
 * ★★ 一直同步到**不动点**，带硬上界。
 *
 * ── 为什么必须有硬上界 ──────────────────────────────────────
 *
 * 没有上界的收敛测试会把**震荡**伪装成「慢慢就好了」：
 * 两台互相把对方的版本再推回去，跑一百轮也「还没收敛」，
 * 而测试只是一直在等。上界一设，震荡当场变成失败。
 *
 * ── 判据不是「跑够 N 轮」，是「再跑一轮什么都不变」 ──────────
 *
 * 每轮让每台各同步一次，然后比全部摘要。连续两轮完全相同才叫到达。
 * 到达之后**再额外同步一次**，摘要仍须不变 —— 防的是
 * 「刚好这一轮没事，下一轮又开始动」。
 */
export async function runUntilFixedPoint(
  devices: ConvergenceDevice[],
  opts: { maxRounds?: number } = {}
): Promise<FixedPointResult> {
  const maxRounds = opts.maxRounds ?? 8
  const trace: string[] = []
  let prev: string[] | null = null
  let rounds = 0

  for (let i = 1; i <= maxRounds; i++) {
    rounds = i
    for (const d of devices) await d.sync()
    const now = devices.map((d) => d.snapshot().digest)
    trace.push(`第 ${i} 轮：${now.map((h, k) => `${devices[k]!.name}=${short(h)}`).join(' ')}`)
    if (prev && prev.every((h, k) => h === now[k])) break
    prev = now
    if (i === maxRounds) {
      return {
        rounds,
        problems: [`★★ 跑满 ${maxRounds} 轮仍未到达不动点 —— 两台在互相推翻对方（震荡）`],
        trace
      }
    }
  }

  // ★ 到达之后再跑一次：摘要还必须一样
  const before = devices.map((d) => d.snapshot().digest)
  for (const d of devices) await d.sync()
  const after = devices.map((d) => d.snapshot().digest)
  const moved = devices
    .map((d, k) => (before[k] === after[k] ? null : d.name))
    .filter((x): x is string => x !== null)
  if (moved.length > 0) {
    return {
      rounds,
      problems: [`★★ 已经「收敛」之后又同步一次，${moved.join('、')} 的状态还在变 —— 那不叫收敛`],
      trace
    }
  }

  const snaps = devices.map((d) => d.snapshot())
  const problems: string[] = []
  for (let i = 0; i < snaps.length; i++) {
    for (let j = i + 1; j < snaps.length; j++) {
      problems.push(...convergenceProblems(snaps[i]!, snaps[j]!))
    }
  }
  return { rounds, problems, trace }
}

const short = (h: string): string => {
  let x = 0
  for (let i = 0; i < h.length; i++) x = (x * 31 + h.charCodeAt(i)) >>> 0
  return x.toString(16).padStart(8, '0')
}
