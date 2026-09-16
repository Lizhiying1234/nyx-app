/**
 * 把被盖掉的那一版找回来 · T-2.5（D-438 / D-R4 使用者 2026-09-05 裁「要」）
 *
 * ── 要解决什么 ──────────────────────────────────────────────
 *
 * D-438 定案：两边都改过时**一律按 `updated_at` 新的那版定，从不打扰他**。
 * 那条决议同时写死了另一半：「**改的只是「问不问」，没改「丢不丢」**」——
 * 被盖掉的那一版整行原样落进 `ops_log`（`op='sync-override'`）。
 *
 * 落是落了，可**从账本里回不去**。他能看见「旧的那版记在账本里」这句话，
 * 却只能看见一行标题；那一版的内容躺在 `detail` 的 JSON 里，谁也点不动。
 * D-R4 裁的就是这一条：给它一个入口。
 *
 * ── ★★★ 一个非做不可的发现：`lost` 有**两种形状** ─────────────
 *
 * `engine.ts::autoResolve` 里：
 *
 *   lost = takeRemote ? c.local : c.row
 *
 * · `kept === 'remote'`（云端那版赢了，**我这台**的那版被盖）
 *   → `lost` = `c.local` = `engine.localRow()` 的产物 = **本地原始行**：
 *     有 `id`、外键是**数字**（`lecture_id: 12`）。
 *
 * · `kept === 'local'`（本地那版赢了，**对面**那版被盖）
 *   → `lost` = `c.row` = 远端包里的 `SyncRow` = **同步形**：
 *     **没有 `id`**、外键列名被 `fk-map.ts::syncColumnOf` 改成了 `*_uid`，
 *     值是跨设备身份（`lecture_uid: "lectures-ab12…"`）。
 *
 * ★★ 后果：拿第二种「只填 lost 里有的列」直接写回本地表，`lecture_uid`
 *    这种列本机根本不存在 —— 静默丢掉的话，还原出来的是**一条从来没存在过的
 *    半拉行**（内容是旧版的、归属是新版的）。而他看到的只有「还原好了」。
 *
 * **不发明新规则**：第二种先过 `fk-map.ts::toLocal` —— 那正是引擎收远端行时
 * 用的同一份翻译（连「探针 → 补齐 → 重跑」的异步收敛也照抄）。翻译不成
 * （父行还没同步过来）就**拒**，并说人话。判据在这里只负责认形状与判能不能写。
 *
 * ── 这个文件里有什么 ────────────────────────────────────────
 *
 *   `parseOverride`  把 ops_log 那行的 detail 解出来（截断 / 坏了要说人话）
 *   `needsTranslate` 这一条要不要先过 toLocal（= 形状判定，只有一份）
 *   `planRestore`    该不该写、写哪几列、写什么值；或者一句拒绝的人话
 *
 * 全是纯函数，手机那半以后照用同一份。
 *
 * ── 写回之后会发生什么（这条必须写下来）────────────────────
 *
 * 写回带**新的 `updated_at`**，于是它变成「本机改过的一行」，
 * 下一趟 `run()` 照常推出去；另一端按 D-438 收（时间新的赢）——
 * 还原这件事**不需要同步协议改一个字**，它只是一次普通的本地编辑。
 */

import { SYNC_TABLES } from '../sync-tables.ts'
import { ALWAYS_DROP } from '../fk-map.ts'

/** 账本里那一行（`op='sync-override'`）—— 调用方从 `ops_log` 读出来原样给 */
export interface OverrideEntry {
  /** `ops_log.id`。「已经还原过」指回的就是它 */
  id: number
  /** `ops_log.target` = 表名 */
  table: string
  /** `ops_log.detail` 的原文 */
  detail: string
}

/** detail 解出来的东西 —— 字段名与 `engine.ts::noteOverrides` 写进去的一字不差 */
export interface LostVersion {
  uid: string
  kept: 'remote' | 'local'
  keptAt: number
  lostAt: number
  /** 被盖掉的那一版整行。形状看 `kept`，见文件头 */
  lost: Record<string, unknown>
}

export type ParseResult = { ok: true; v: LostVersion } | { ok: false; why: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 把 `detail` 解出来。
 *
 * ★ `noteOverrides` 写的时候 `.slice(0, 8000)` —— **超长的那些被截断了**，
 *   截断的 JSON 解不出来。这不是一个可以「尽力而为」的地方：
 *   半个 JSON 里能捞出几列是运气，而按运气还原会写出一条残缺的行。
 *   如实说「这一笔记得不完整」，一个字都不写。
 */
export function parseOverride(entry: OverrideEntry): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(entry.detail)
  } catch {
    return {
      ok: false,
      why: '账本里这一笔记得不完整（当时那一行太长，被截断了）—— 没法从这里还原它。'
    }
  }
  if (!isObj(raw)) return { ok: false, why: '账本里这一笔的格式认不出来 —— 没有还原。' }

  const uid = raw['uid']
  const kept = raw['kept']
  const lost = raw['lost']
  if (typeof uid !== 'string' || uid === '') {
    return { ok: false, why: '账本里这一笔没有记下是哪一条（缺 uid）—— 没有还原。' }
  }
  if (kept !== 'remote' && kept !== 'local') {
    return { ok: false, why: '账本里这一笔没有记下当时留的是哪一版 —— 没有还原。' }
  }
  if (!isObj(lost)) {
    return { ok: false, why: '账本里这一笔没有被盖掉的那一版内容 —— 没有还原。' }
  }
  return {
    ok: true,
    v: {
      uid,
      kept,
      keptAt: Number(raw['keptAt'] ?? 0) || 0,
      lostAt: Number(raw['lostAt'] ?? 0) || 0,
      lost
    }
  }
}

/**
 * ★★★ 这一条的 `lost` 是**同步形**吗（要先过 `toLocal`）。
 *
 * 形状判定只有这一份 —— 两端、用例、执行器都问它。
 * 判据是 `kept`，不是「看起来像什么」：`autoResolve` 里那一行
 * `lost = takeRemote ? c.local : c.row` 就是全部的依据。
 */
export function needsTranslate(v: LostVersion): boolean {
  return v.kept === 'local'
}

export interface RestorePlan {
  table: string
  uid: string
  /** 要写回去的列 → 值。已经含 `updated_at = now`，**不含** `id` / `uid` */
  set: Record<string, unknown>
  /** 写了哪几列 —— 账本里要能答「是哪些」（D-458） */
  columns: string[]
}

export interface RestoreInput {
  entry: OverrideEntry
  v: LostVersion
  /**
   * 被盖那一版的**本地形**数据。
   * `needsTranslate` 为真时由调用方先过 `fk-map.ts::toLocal`；否则原样就是它。
   */
  localData: Record<string, unknown>
  /** 那个 uid 现在库里的行。`null` = 已经不在了 */
  current: Record<string, unknown> | null
  /** 这张表现在**真实**的列（`pragma table_info`）*/
  columns: readonly string[]
  /** 已经有一条 `sync-restore` 指着 `entry.id` 了吗 */
  alreadyRestored: boolean
  now: number
}

export type RestoreVerdict = { ok: true; plan: RestorePlan } | { ok: false; why: string }

/**
 * 该不该写、写哪几列。
 *
 * ★ 拒绝的方向永远是**不动**：还原是他为了找回内容点的，
 *   而一次写错要他自己发现「这条记录变成了没见过的样子」—— 那种失败最贵。
 */
export function planRestore(i: RestoreInput): RestoreVerdict {
  const { entry, v } = i

  if (!(SYNC_TABLES as readonly string[]).includes(entry.table)) {
    return {
      ok: false,
      why: `账本里这一笔挂在「${entry.table}」上，而那张表不参与同步 —— 对不上任何东西，没有还原。`
    }
  }

  if (i.alreadyRestored) {
    return { ok: false, why: '这一条已经还原过了 —— 没有再写一遍。' }
  }

  /**
   * ★★ 行不在了 = 后来被彻底删除（或从来没到过这台机器）。
   *   **不 insert**：立过碑的东西不许复活（R-3 / D-435），
   *   而「凭一条账本记录把一行凭空建出来」本身也是在猜。
   */
  if (i.current === null) {
    return {
      ok: false,
      why: '这一条现在已经不在库里了（多半是后来被彻底删除）—— 还原它等于让它复活，没有做。'
    }
  }

  /**
   * ★ 回收站里的不还原。
   *   「还原被盖掉的那一版」和「把这一条从回收站捡回来」是两件事；
   *   一个按钮做两件、而且第二件他没预期 —— 这个项目为这种形状付过账。
   */
  if (i.current['deleted_at'] !== null && i.current['deleted_at'] !== undefined) {
    return {
      ok: false,
      why: '这一条现在在回收站里。先把它恢复出来，再还原被盖掉的那一版。'
    }
  }

  /**
   * ★ 反方向同理：被盖那一版本身是「已删除」，还原它等于替他重新删一次。
   *   没有 `deleted_at` 这一列的表读出来是 `undefined`，自然不进这一条。
   */
  const lostDeleted = i.localData['deleted_at']
  if (lostDeleted !== null && lostDeleted !== undefined) {
    return {
      ok: false,
      why: '被盖掉的那一版当时是「已删除」状态 —— 还原它等于把这一条重新扔进回收站，没有做。要删请到列表里删。'
    }
  }

  /**
   * ★★ 列以本机为准，**但对不上就拒，不静默丢**（和 `writeRows` 里那条同一个理由：
   *   只还原一半会得到一条从来没存在过的记录）。
   *   `id` 与 `uid` 是有意丢的：`id` 从不跨设备（`fk-map.ts::ALWAYS_DROP`），
   *   `uid` 是这一行的身份，还原内容不许换身份。
   */
  const known = new Set(i.columns)
  const set: Record<string, unknown> = {}
  const unknown: string[] = []
  for (const [k, val] of Object.entries(i.localData)) {
    if (k === ALWAYS_DROP || k === 'uid') continue
    if (!known.has(k)) {
      unknown.push(k)
      continue
    }
    set[k] = val
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      why:
        `被盖掉的那一版带着本机没有的列（${unknown.slice(0, 5).join('、')}）—— ` +
        `没有还原。只写一半会得到一条从来没存在过的记录。`
    }
  }

  const columns = Object.keys(set)
  if (columns.length === 0) {
    return { ok: false, why: '账本里这一笔没有可以还原的内容 —— 没有还原。' }
  }

  /**
   * ★★★ **顶一个新的 `updated_at`**，这是整条链的关键一步：
   *   不顶的话它带着**旧**时间戳躺在库里 —— `collectSince` 的判据是
   *   「当前版本 ≠ 确认同步过的那一版」，写回去确实会被推出去一次，
   *   可另一端拿到的是一个比它手上那版**更旧**的时间戳，
   *   按 D-438「时间新的赢」当场又被盖回去 —— 还原在他那台看不见。
   *
   * ★★★ 为什么不是光取 `now`，而是 `max(now, keptAt + 1)`：
   *   **盖住它的那一版可能带着一个未来的时间戳**。那不是假想 ——
   *   D-438 挑赢家用的正是各自的时钟，而时钟偏差这件事在同一轮里
   *   （T-2.5 的另一半）才刚给他提示过。对面的钟快三个小时时，
   *   `now` 比 `keptAt` 还小 → 还原写回去，同步出去，**当场又被盖回来**，
   *   而他看到的是「还原好了」然后什么都没变 —— 这个项目最怕的那种失败。
   *   往前挪一毫秒是**够用的最小值**：它只保证「比盖住我的那一版新」，
   *   不多要一分一秒（同 `compact.ts` 里包名撞车时 `at += 1` 的口径）。
   */
  set['updated_at'] = Math.max(i.now, i.v.keptAt + 1)
  if (!columns.includes('updated_at')) columns.push('updated_at')

  return { ok: true, plan: { table: entry.table, uid: v.uid, set, columns: columns.sort() } }
}
