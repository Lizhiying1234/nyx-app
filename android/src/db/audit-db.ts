/**
 * **把 M1 真机验证钉下的三条硬约束变成机器检查**，而不是只写在注释里。
 *
 * ── 为什么值得单独一层 ★★★ ────────────────────────────────
 *
 * 这三条都有同一个性质：**违反了不会报错，只会在某台设备上、某次升级时
 * 悄悄坏掉。** 注释拦不住这种东西，下一个人改代码时也不会先去读注释。
 *
 *   ① `pragma foreign_keys = OFF` 写在 `BEGIN` **之后** →
 *      它是 no-op（M1-G 真机实测），外键照样约束着 →
 *      导回时报错，或者更糟：某些行被悄悄挡住
 *   ② `pragma user_version` 写在事务**之外** →
 *      回滚时它不跟着退 → 失败之后库标着新版本、内容还是旧的
 *   ③ 导回时把 `_keep_*` 的行读进 JS 再插回去 →
 *      小库上一切正常，几万行 `review_logs` 的真机上把 WebView 撑爆
 *
 * 所以这一层**包住 Db，录下每一句 SQL**，跑完之后问一句「守规矩了没有」。
 * 它只在测试里用 —— 生产路径不该为了自证而多一层。
 */
import type { Db, Row } from './types.ts'

export interface AuditEntry {
  op: 'exec' | 'run' | 'get' | 'all' | 'begin' | 'commit' | 'rollback'
  sql: string
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

export class AuditDb implements Db {
  readonly trace: AuditEntry[] = []
  private readonly inner: Db
  constructor(inner: Db) {
    this.inner = inner
  }

  private rec(op: AuditEntry['op'], sql: string): void {
    this.trace.push({ op, sql })
  }

  exec(sql: string): Promise<void> {
    this.rec('exec', sql)
    return this.inner.exec(sql)
  }
  run(sql: string, params?: readonly unknown[]): Promise<void> {
    this.rec('run', sql)
    return this.inner.run(sql, params)
  }
  get(sql: string, params?: readonly unknown[]): Promise<Row | undefined> {
    this.rec('get', sql)
    return this.inner.get(sql, params)
  }
  all(sql: string, params?: readonly unknown[]): Promise<Row[]> {
    this.rec('all', sql)
    return this.inner.all(sql, params)
  }
  begin(): Promise<void> {
    this.rec('begin', 'BEGIN')
    return this.inner.begin()
  }
  commit(): Promise<void> {
    this.rec('commit', 'COMMIT')
    return this.inner.commit()
  }
  rollback(): Promise<void> {
    this.rec('rollback', 'ROLLBACK')
    return this.inner.rollback()
  }

  // ── 三条约束，逐条问 ──────────────────────────────────────

  /** ① 关外键必须在第一次 BEGIN 之前 */
  checkForeignKeysBeforeBegin(): string | null {
    const fkOff = this.trace.findIndex((e) => /pragma\s+foreign_keys\s*=\s*off/i.test(e.sql))
    const begin = this.trace.findIndex((e) => e.op === 'begin')
    if (begin < 0) return null // 这一趟没开事务（noop），不适用
    if (fkOff < 0) return '① 整趟没有关过外键 —— 重建期间外键仍在约束'
    if (fkOff > begin) {
      return `① pragma foreign_keys = OFF 出现在 BEGIN 之后（第 ${fkOff} 步 vs 第 ${begin} 步）—— 事务内设它是 no-op`
    }
    return null
  }

  /**
   * ② user_version 必须在事务之内设置。
   *
   * ★★ 判据是「**BEGIN 与 COMMIT 之间**写过」，不是「整趟第一次写在哪」。
   *
   * 这个区别是 2026-08-25 真机跑 P-3 时暴露的：夹具建库时先写了一次
   * `pragma user_version`（那完全正常），旧版判据拿 `findIndex` 找到的
   * 是**它**，于是报「写在 BEGIN 之前」—— 一条假红。
   *
   * 事务之前写过多少次都无所谓，那些跟这次升级没关系。真正要拦的只有
   * 一种：**事务里没写**（回滚时版本号不跟着退，或者干脆没更新）。
   */
  checkUserVersionInTransaction(): string | null {
    const begin = this.trace.findIndex((e) => e.op === 'begin')
    if (begin < 0) return null
    const endRel = this.trace
      .slice(begin + 1)
      .findIndex((e) => e.op === 'commit' || e.op === 'rollback')
    const end = endRel < 0 ? this.trace.length : begin + 1 + endRel
    const inside = this.trace
      .slice(begin + 1, end)
      .some((e) => /pragma\s+user_version\s*=/i.test(e.sql))
    if (inside) return null
    const anywhere = this.trace.some((e) => /pragma\s+user_version\s*=/i.test(e.sql))
    return anywhere
      ? '② user_version 写在事务之外 —— 回滚时它不会跟着退'
      : '② 整趟没有在事务内写过 user_version'
  }

  /** ③ 导回必须 SQL-to-SQL：不许把 `_keep_*` 的行读进 JS */
  checkRestoreStaysInSql(keepPrefix = '_keep_'): string | null {
    const bad = this.trace.filter(
      (e) =>
        (e.op === 'all' || e.op === 'get') &&
        new RegExp(`from\\s+"?${keepPrefix}`, 'i').test(e.sql) &&
        !/^\s*pragma/i.test(e.sql)
    )
    if (bad.length === 0) return null
    return `③ 有 ${bad.length} 处把 ${keepPrefix}* 的行读进了 JS：${bad[0]!.sql.slice(0, 90)}`
  }

  /** 三条一起问。返回全部问题；空数组 = 守规矩 */
  violations(): string[] {
    return [
      this.checkForeignKeysBeforeBegin(),
      this.checkUserVersionInTransaction(),
      this.checkRestoreStaysInSql()
    ].filter((x): x is string => x !== null)
  }
}
