import Database from 'better-sqlite3'
import { existsSync, statSync } from 'node:fs'

/**
 * 「这是一份能用的 Nyx 数据库吗」· C-1
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 *
 * 「从备份导回」原来的写法是：备份当前库 → 关掉 → 删 `-wal/-shm` → 直接覆盖 → 重启。
 * 注释上写着「不是 Nyx 的库就别覆盖」，**而代码检查的是当前这个库还活不活着**，
 * 检查错了对象 —— 来源文件一个字节都没看过。
 *
 * 于是他在文件对话框里选错一个 `.db`（别的软件的、拷了一半的、坏掉的），
 * 当前那份好数据就被盖掉，重启之后 `openDatabase` 打不开，
 * 走 `fatal()` 弹框退出 —— **软件从此起不来**。他零编程经验，看到的只有「打不开了」。
 *
 * ── 判据分五层，从便宜到贵 ────────────────────────────────
 *
 * 顺序是有意的：先用最便宜的排掉最常见的错，别为了一个文本文件去跑完整性检查。
 *
 *   ① 文件在不在、是不是空的
 *   ② 有没有并排的 `-wal` —— 有就说明它是从**正在使用**的库直接拷出来的，
 *      单独这一个 `.db` 少了还没合并进去的内容，**是个不完整的复制品**
 *   ③ SQLite 打得开吗（不是 SQLite、被截断、头坏了，这一步就挡住）
 *   ④ `pragma quick_check` —— 页级损坏
 *   ⑤ 是不是 Nyx 的库：`user_version` 在支持范围内、该有的表都在
 *
 * 版本判据是**不能比当前软件新**：老备份可以，迁移会把它升上来；
 * 新备份不行 —— 往回降级没有脚本，也不该有（D-216 只增不删）。
 */

export interface VerifyResult {
  ok: boolean
  /** 库里记的结构版本。打不开时是 -1 */
  version: number
  /** 不 ok 时，一句他看得懂的话 */
  problem: string
}

/**
 * 一份 Nyx 库**任何版本都该有**的两张表。
 * V1 就建好了（`settings` / `migration_log`），此后每一版都在。
 * 用它们判「是不是 Nyx 的库」，不用业务表 —— 业务表是 V2 才有的，
 * 拿它们判会把极早期的备份误杀。
 */
const CORE_TABLES = ['settings', 'migration_log']

/** V2 起就该有的业务表。只在 `user_version >= 2` 时要求 */
const BUSINESS_TABLES = ['projects', 'units', 'lectures', 'items']

export function verifyNyxDb(path: string, targetVersion: number): VerifyResult {
  const bad = (problem: string, version = -1): VerifyResult => ({ ok: false, version, problem })

  // ① 在不在、空不空
  if (!existsSync(path)) return bad('这个文件不在了 —— 可能刚被移走或改名。')
  let size = 0
  try {
    size = statSync(path).size
  } catch (err) {
    return bad(`读不了这个文件：${err instanceof Error ? err.message : String(err)}`)
  }
  if (size === 0) return bad('这个文件是空的（0 字节），不是一份备份。')

  /**
   * ② 旁边有 `-wal` —— 它是从**正在运行**的数据库直接拷出来的。
   *
   * 那种拷贝**不完整**：最近的改动还在 `-wal` 里没合并进主文件。
   * 单拿这一个 `.db` 导回，会丢掉那部分，而且他不会知道丢了什么。
   * 软件自己做的备份走 `VACUUM INTO`，从来不带 `-wal`，所以这条不会误伤。
   */
  if (existsSync(path + '-wal')) {
    return bad(
      '这份文件旁边还有一个 `-wal` 文件 —— 说明它是从**正在使用**的数据库直接拷出来的，' +
        '最近的改动还没合并进去，导回会丢东西。\n' +
        '请用软件里「导出完整备份」做出来的那种，或者 data/backups 里的文件。'
    )
  }

  let db: Database.Database | null = null
  try {
    // ③ 打得开吗。readonly + fileMustExist：不许它顺手新建一个空库
    db = new Database(path, { readonly: true, fileMustExist: true })

    // ④ 页级损坏。quick_check 比 integrity_check 快得多，够挡住截断和坏页
    const qc = db.pragma('quick_check', { simple: true }) as string
    if (String(qc).toLowerCase() !== 'ok') {
      return bad(`这个数据库文件损坏了（${String(qc).slice(0, 120)}）。`)
    }

    // ⑤ 是不是 Nyx 的库
    const version = db.pragma('user_version', { simple: true }) as number
    const names = new Set(
      (
        db
          .prepare(`select name from sqlite_master where type='table'`)
          .all() as { name: string }[]
      ).map((x) => x.name)
    )

    const missingCore = CORE_TABLES.filter((t) => !names.has(t))
    if (missingCore.length > 0) {
      return bad(
        `这不是 Nyx 的数据库 —— 缺少 ${missingCore.join('、')} 表。` +
          `（它是个能打开的 SQLite 文件，但里面装的是别的东西。）`,
        version
      )
    }
    if (version >= 2) {
      const missing = BUSINESS_TABLES.filter((t) => !names.has(t))
      if (missing.length > 0) {
        return bad(`这份 Nyx 数据库不完整 —— 缺少 ${missing.join('、')} 表。`, version)
      }
    }
    if (version > targetVersion) {
      return bad(
        `这份备份来自更新版本的 Nyx（结构 v${version}，当前软件只到 v${targetVersion}）。\n` +
          `先把 Nyx 升级到那个版本，再导回。`,
        version
      )
    }

    /**
     * ★★ Step 7C · G2 · 业务数据与基状态必须来自**同一世代**。
     *
     * 放在这里而不是导回流程里：`restoreFrom` 会调它三次 ——
     * ① 验来源（当前库一个字节都没碰）· ④ 验拷出来的临时副本 ·
     * ⑥ 合并完不可逆事实之后再验一次。三道都过才换库，
     * 所以任何一半不一致都不可能进到正式库里。
     */
    const gen = checkGeneration(db)
    if (gen.length > 0) {
      const head = gen
        .slice(0, 3)
        .map((g) => `${g.table}/${g.uid}：${g.detail}`)
        .join('\n')
      return bad(
        `这份备份里「数据」和「同步记录」对不上（${gen.length} 处）——\n${head}\n` +
          `两者必须来自同一份库。已经取消，你的数据一个字都没改。`,
        version
      )
    }

    return { ok: true, version, problem: '' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // better-sqlite3 对「不是数据库」给的是 SQLITE_NOTADB，翻成人话
    if (/not a database|file is encrypted/i.test(msg)) {
      return bad('这不是一个数据库文件（也可能是加密过的）。')
    }
    return bad(`打不开这个文件：${msg}`)
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不上不影响判定结果 —— 这里只是读了一遍 */
    }
  }
}


/**
 * ★★ Step 7C · G2 · 业务数据与基状态必须**来自同一世代**
 *
 * ── 为什么要在导回这一步查 ──────────────────────────────────
 *
 * `row_sync_state` 记的是「这一行我和远端对账到哪一版」。它和业务行是
 * **配对的事实**：拆开任何一半，剩下那一半就开始说谎。
 *
 * 导回是唯一一个能把两半拆开的入口 —— 备份是整个库文件，正常情况下
 * 两半一起走；但一份**被人手工拼过**的库（拿旧备份的业务表配当前的
 * 基状态，或者反过来）在结构上完全合法、`quick_check` 也过。
 * 收下之后合并会拿一个早就不成立的共同基去判「谁改过」，
 * 而它判错时**不报错**，只静默选错边。
 *
 * ── 查什么、不查什么 ────────────────────────────────────────
 *
 * ✔ **孤儿基状态**：`row_sync_state` 里有、业务表里没有那一行。
 *   这一条是硬的 —— 基状态的主语没了，它就没有任何意义。
 *
 * ✔ **跨世代**：基状态记的版本**比业务行现在的版本还新**。
 *   一台机器只可能推出去 / 对账到**已经存在过**的版本，
 *   所以 `pushed > updated_at` 或 `synced > updated_at` 在同一世代里
 *   不可能出现。出现了就说明这两半来自不同的库。
 *
 * ✘ **不查**「业务行没有基状态」。那是**正常状态**，不是错误：
 *     · 出厂内容（`updated_at = 0`）从来不进这张表
 *     · 上次同步之后新建的行，还没推过，本来就没有基状态
 *   把它当错误会让**每一份**正常备份都导不回来。
 *
 * ── 发现不一致时怎么办 ──────────────────────────────────────
 *
 * **拒绝导回，一个字都不改。** 不自动补、不自动删孤儿、不清空、不猜。
 * 猜错的那一半是「把没推过的行标成已同步」，那会永久漏数据 ——
 * 而他会以为自己刚刚成功恢复了备份。
 */
export interface GenerationProblem {
  kind: 'orphan-state' | 'state-newer-than-row'
  table: string
  uid: string
  detail: string
}

/** 同一世代吗。返回空数组 = 是。 */
export function checkGeneration(db: Database.Database): GenerationProblem[] {
  const out: GenerationProblem[] = []
  let rows: { table_name: string; uid: string; synced: number | null; pushed: number | null }[]
  try {
    rows = db
      .prepare(
        `select table_name, uid, synced_updated_at as synced, pushed_updated_at as pushed
           from row_sync_state`
      )
      .all() as typeof rows
  } catch {
    // V31 之前的库没有这张表 —— 那就没有可拆开的两半
    return out
  }

  /** 一张表一次查询，别按行去问库 */
  const known = new Map<string, Map<string, number>>()
  const versionsOf = (table: string): Map<string, number> => {
    const hit = known.get(table)
    if (hit) return hit
    const m = new Map<string, number>()
    try {
      for (const r of db.prepare(`select uid, updated_at from "${table}"`).all() as {
        uid: string
        updated_at: number
      }[]) {
        m.set(r.uid, Number(r.updated_at))
      }
    } catch {
      /* 表不存在 —— 下面按「找不到那一行」处理 */
    }
    known.set(table, m)
    return m
  }

  for (const s of rows) {
    const here = versionsOf(s.table_name).get(s.uid)
    if (here === undefined) {
      out.push({
        kind: 'orphan-state',
        table: s.table_name,
        uid: s.uid,
        detail: '基状态指着一行已经不存在的数据'
      })
      continue
    }
    /**
     * ★ 只查「基状态比业务行还新」这一个方向。
     *   反过来（基状态落后于业务行）是**完全正常**的：
     *   他改过之后还没来得及推，或者他按过「用本地的」。
     *   工作单 §三说得很清楚：不许要求两者相等。
     */
    for (const [what, v] of [
      ['已推出版本', s.pushed],
      ['已对账版本', s.synced]
    ] as const) {
      if (v !== null && v > here) {
        out.push({
          kind: 'state-newer-than-row',
          table: s.table_name,
          uid: s.uid,
          detail: `${what} ${v} 比这一行现在的版本 ${here} 还新 —— 两半不是同一个库里出来的`
        })
      }
    }
  }
  return out
}