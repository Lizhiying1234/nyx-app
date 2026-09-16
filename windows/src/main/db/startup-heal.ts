import type { Database } from 'better-sqlite3'
import { ensureBuiltins, type BuiltinResult } from './builtins.ts'
import { recoverAll, type RecoverResult } from './recover.ts'

/**
 * 启动自愈的错误分级 · R-1
 *
 * ── 病是什么 ────────────────────────────────────────────────
 *
 * `ensureBuiltins` 和 `recoverAll` 原来直接写在 `index.ts` 那个大 try 里，
 * 抛出来会一路走到 `throw err` → 启动失败对话框 → 退出。
 * 也就是说：**一条自愈 SQL 写错，整个软件打不开。**
 * 而这两步做的都是「收拾遗留问题」—— 收拾不动，最坏也只是遗留问题还在，
 * 不该连带把他所有能正常用的数据一起挡在门外。
 *
 * ── 但不能反过来，一律 catch 掉 ──────────────────────────────
 *
 * 「启动继续」和「数据安全」在有些错误上是冲突的：
 * 库已经损坏、盘写不进去、事务回滚没完成 —— 这时候继续跑，
 * 后面每一次写入都是**在未知状态上再加东西**，而且不报错。
 * 那比打不开严重得多：打不开他会来问，静默写坏他发现不了。
 *
 * 所以判据分两档：
 *
 * | | 判据 | 怎么办 |
 * |---|---|---|
 * | **这一步自己的毛病** | 约束冲突、列名写错、逻辑错…… 事务已回滚，库还是好的 | 记日志 + 落进体检 + **继续启动** |
 * | **库已经不可信** | 损坏 / 不是数据库 / 盘 IO / 只读 / 满 / 连接已关 / **回滚没完成** / 被别的进程锁着 | **停下**，人话对话框，库保持原样 |
 *
 * 「回滚没完成」那一条是靠 `db.inTransaction` 判的 —— 它为真说明
 * better-sqlite3 的事务边界已经不成立了，此刻库处于**半改状态**，
 * 这是唯一一种「看起来只是普通报错、实际上库已经脏了」的情况。
 */

/** SQLite 报出这些码，就不是「这一步没做成」，是**这个库现在不能信** */
const UNSAFE_PREFIXES = [
  'SQLITE_CORRUPT', // 库损坏
  'SQLITE_NOTADB', // 根本不是数据库（或加密/截断）
  'SQLITE_IOERR', // 盘读写不了
  'SQLITE_CANTOPEN', // 打不开（文件被移走、权限没了）
  'SQLITE_READONLY', // 写不进去 —— 自愈本身就是写操作
  'SQLITE_FULL', // 盘满
  'SQLITE_NOMEM',
  'SQLITE_PROTOCOL', // 锁协议乱了
  'SQLITE_BUSY', // 启动时还有别人在写同一个库（单实例锁本该挡住）
  'SQLITE_LOCKED'
]

/** 连接本身已经废了 —— 后面每一步都会失败，继续没有意义 */
const DEAD_HANDLE = /database (connection is not open|is closed)|not open/i

export function isUnsafeDbError(err: unknown, db?: Database): boolean {
  // 回滚没走完 = 库处于半改状态。这一条优先，跟错误码无关
  if (db?.inTransaction) return true
  if (!(err instanceof Error)) return false
  const code = String((err as { code?: unknown }).code ?? '')
  if (UNSAFE_PREFIXES.some((p) => code.startsWith(p))) return true
  return DEAD_HANDLE.test(err.message)
}

/** 数据库已经不可信 —— 宁可不启动，也不带着未知状态继续写 */
export class UnsafeDatabase extends Error {
  constructor(
    readonly step: string,
    readonly reason: string
  ) {
    super(`${step}：${reason}`)
    this.name = 'UnsafeDatabase'
  }
}

export interface HealProblem {
  /** 哪一步 —— 用他看得懂的说法，不是函数名 */
  step: string
  message: string
  /** SQLite 的错误码，有就带上（贴给 AI 时它认得） */
  code: string | null
}

export interface HealResult {
  builtins: BuiltinResult
  recovered: RecoverResult
  /** 没做成、但不影响继续启动的那些。会落进数据体检，他自己看得见 */
  problems: HealProblem[]
}

/** 体检要读的那把钥匙 —— 上一次启动自愈有没有没做成的 */
export const HEAL_PROBLEM_KEY = 'startup.heal.problems'

const describe = (err: unknown): { message: string; code: string | null } => ({
  message: err instanceof Error ? err.message : String(err),
  code: err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : null
})

/**
 * 把这一次自愈的结果记在库里 —— 体检那一页要看得见。
 *
 * 为什么非要落库：他**不看日志**（零编程经验，也不知道日志在哪）。
 * 自愈悄悄失败、日志里写了一行、界面上什么都没有 ——
 * 那和没做过是一样的。所以状态要落到他点得开的地方。
 *
 * 这一步自己失败也不能挡启动：库要是连 settings 都写不进去，
 * 上面的分级早就把它判成不安全了。
 */
function record(db: Database, problems: HealProblem[]): void {
  try {
    const t = Date.now()
    if (problems.length === 0) {
      db.prepare(`delete from settings where key = ?`).run(HEAL_PROBLEM_KEY)
      return
    }
    db.prepare(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    ).run(HEAL_PROBLEM_KEY, JSON.stringify({ at: t, problems }), t)
  } catch {
    /* 记不下来也不能因此不让他用软件 —— 真正不安全的情况上面已经拦掉了 */
  }
}

/**
 * 启动时的两步自愈，带分级。
 *
 * 顺序和以前一样：**出厂内容自愈 → 状态自愈**，都在迁移之后。
 * 不同的是每一步都被包住了：可恢复的记一笔往下走，不可信的当场停。
 *
 * @throws {UnsafeDatabase} 库已经不能信任时
 */
export function startupHeal(db: Database): HealResult {
  const problems: HealProblem[] = []

  const onError = (stepName: string) => (detail: string, err: unknown): void => {
    if (isUnsafeDbError(err, db)) {
      const d = describe(err)
      throw new UnsafeDatabase(`${stepName} · ${detail}`, `${d.message}${d.code ? `（${d.code}）` : ''}`)
    }
    problems.push({ step: `${stepName} · ${detail}`, ...describe(err) })
  }

  const builtins = ensureBuiltins(db, onError('补出厂内容'))
  const recovered = recoverAll(db, onError('收拾状态'))

  record(db, problems)
  return { builtins, recovered, problems }
}

/** 体检读它：上一次启动有没有自愈没做成 */
export function lastHealProblems(db: Database): HealProblem[] {
  try {
    const row = db.prepare(`select value from settings where key = ?`).get(HEAL_PROBLEM_KEY) as
      | { value: string }
      | undefined
    if (!row) return []
    const parsed = JSON.parse(row.value) as { problems?: HealProblem[] }
    return Array.isArray(parsed.problems) ? parsed.problems : []
  } catch {
    return []
  }
}
