/**
 * B′ 的完整测试矩阵 —— D-297 第六、七节。
 *
 * ★ 跑的是**与真机逐字相同**的那一份升级逻辑（`src/db/*`）。
 *   这里换掉的只有 adapter（`node:sqlite` 代替插件）。
 *   真机那一侧只验 adapter 与平台行为，不另写一套 upgrade logic。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { upgrade } from '../src/db/upgrade.ts'
import { UpgradeFailed } from '../src/db/types.ts'
import { AuditDb } from '../src/db/audit-db.ts'
import { NodeSqliteDb } from '../src/adapters/node-sqlite.ts'
import { ANDROID_WRITE_SURFACE, PRESERVED_TABLES } from '../src/db/preserve.ts'
import { splitSql } from '../src/core-link.ts'
import {
  FaultDb,
  REPO,
  SCHEMA_SQL,
  TARGET_VERSION,
  builtDb,
  cleanup,
  freshDb,
  pendingCount,
  seed,
  snapshot,
  type Fixture
} from './helpers.ts'

after(cleanup)

/**
 * 整套矩阵跑的就是**生效的那份保全清单**（`PRESERVED_TABLES` = 全部同步表）。
 * 不再有「测试用一份、生产用另一份」的分叉 —— 那种分叉本身就是隐患。
 */
const deps = (preserveTables: readonly string[] = PRESERVED_TABLES) => ({
  targetVersion: TARGET_VERSION,
  schemaSql: SCHEMA_SQL,
  now: Date.now(),
  preserveTables
})

/** 把一个已建好的库「降级」成上一版 —— 制造出「有数据的旧库」 */
function pretendOlder(f: Fixture): void {
  f.raw.exec(`pragma user_version = ${TARGET_VERSION - 1}`)
}

const rows = (f: Fixture, sql: string): Record<string, unknown>[] =>
  f.raw.prepare(sql).all() as Record<string, unknown>[]
const one = (f: Fixture, sql: string): Record<string, unknown> =>
  f.raw.prepare(sql).get() as Record<string, unknown>

// ══════════════════════════════════════════════════════════════
// U · 正向
// ══════════════════════════════════════════════════════════════

describe('U · B′ 正向', () => {
  it('U-0 · 保全清单必须是全量 —— 只保写入面会静默错链（回归）', async () => {
    /**
     * ★★ 这条钉住的是一个**实测出来的 P0**，不是理论洁癖。
     *
     * D-297 最初只保 `review_logs` + `reading_cards`。这两张表的
     * `item_id` 是指向 `items` 的**本机自增 id**，而 items 不在清单里 ——
     * 重建后全是孤儿；等同步把 items 拉回来，它们拿到新的本机 id，
     * **复习记录就接到别的知识点上了，而且不报错。**
     *
     * 2026-08-25 实测：PC 24 处、真机 28 处孤儿。现在清单是全量，
     * 这条守着两件事：① 生效清单确实是全量 ② 退回旧清单会当场红。
     */
    assert.ok(
      PRESERVED_TABLES.includes('items'),
      '★ 保全清单必须含 items —— 不含它，review_logs / reading_cards 的 item_id 会错链'
    )
    assert.ok(PRESERVED_TABLES.length > ANDROID_WRITE_SURFACE.length)

    // 退回旧清单 → 自检必须拦下、必须回滚、旧库必须原样
    const f = builtDb()
    seed(f)
    pretendOlder(f)
    const before = snapshot(f)
    let err: UpgradeFailed | null = null
    try {
      await upgrade(f.db, deps(ANDROID_WRITE_SURFACE))
    } catch (e) {
      err = e as UpgradeFailed
    }
    assert.ok(err instanceof UpgradeFailed, '★ 只保写入面居然过了 —— 那是静默错链')
    assert.match(err.message, /外键有孤儿/)
    assert.equal(err.step, 'selfcheck', '必须在 COMMIT 之前拦下')
    assert.equal(err.oldDbIntact, true)
    assert.equal(snapshot(f), before, '★ 失败之后旧库必须逐字原样')
  })

  it('U-1 · 全新安装：空库直接按目标结构建起来', async () => {
    const f = freshDb()
    const r = await upgrade(f.db, deps())
    assert.equal(r.action, 'bootstrap')
    assert.equal(Number(one(f, `pragma user_version`)['user_version']), TARGET_VERSION)
    assert.equal(String(one(f, `pragma integrity_check`)['integrity_check']), 'ok')
    // 同步表都建出来了
    const n = Number(
      one(f, `select count(*) as n from sqlite_master where type='table' and name='reading_cards'`)['n']
    )
    assert.equal(n, 1, 'reading_cards 该建出来')
    assert.equal(r.builtinsPending, true, '出厂内容要由应用启动时幂等播种，升级器不代劳')
  })

  it('U-2 · 全程离线也能升级 —— 升级路径一次网络都不碰', async () => {
    /**
     * ★ 这是 B′ 的正题。两条一起验：
     *   ① 结构上：`src/db/*` 里不许出现任何网络能力
     *   ② 行为上：库里配着一个**根本连不上**的云端地址，升级照样完成
     */
    const src = ['types', 'preserve', 'selfcheck', 'upgrade', 'audit-db']
      .map((m) => readFileSync(join(process.cwd(), 'src', 'db', `${m}.ts`), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1')
    for (const bad of ['fetch(', 'XMLHttpRequest', 'node:http', 'node:https', 'WebSocket']) {
      assert.ok(!src.includes(bad), `★ 升级路径里出现了网络能力：${bad}`)
    }

    const f = builtDb()
    seed(f, { settings: { 'sync.url': 'https://definitely.unreachable.invalid/nyx' } })
    pretendOlder(f)
    const r = await upgrade(f.db, deps())
    assert.equal(r.action, 'rebuild')
    assert.equal(Number(one(f, `pragma user_version`)['user_version']), TARGET_VERSION)
  })

  it('U-3 · 未同步的 review_logs 一条不丢', async () => {
    const f = builtDb()
    seed(f, { items: 3, logsPerItem: 7, unsynced: 21 })
    const before = Number(one(f, `select count(*) as n from review_logs`)['n'])
    assert.equal(before, 21)
    pretendOlder(f)
    await upgrade(f.db, deps())
    assert.equal(Number(one(f, `select count(*) as n from review_logs`)['n']), before)
  })

  it('U-4 · reading_cards 六个字段逐字保全', async () => {
    const f = builtDb()
    seed(f)
    const key = `select item_id, ease, interval_days, reps, lapses, due_at, silent from reading_cards order by item_id`
    const before = JSON.stringify(rows(f, key))
    pretendOlder(f)
    await upgrade(f.db, deps())
    assert.equal(JSON.stringify(rows(f, key)), before)
  })

  it('U-5 · 云端不可达不阻塞升级', async () => {
    const f = builtDb()
    seed(f, {
      settings: {
        'sync.kind': 'webdav',
        'sync.url': 'http://127.0.0.1:1/nope',
        'sync.user': 'me',
        'sync.auto': '1',
        'sync.secret': 'S'
      }
    })
    pretendOlder(f)
    const r = await upgrade(f.db, deps())
    assert.equal(r.action, 'rebuild')
  })

  it('U-6 · 设备设置与密钥不丢', async () => {
    const f = builtDb()
    seed(f)
    const before = one(f, `select value from settings where key='sync.secret'`)
    pretendOlder(f)
    await upgrade(f.db, deps())
    for (const k of ['sync.kind', 'sync.url', 'sync.user', 'sync.auto', 'sync.secret']) {
      const v = f.raw.prepare(`select value from settings where key=?`).get(k) as
        | { value: string }
        | undefined
      assert.ok(v, `${k} 丢了`)
    }
    assert.equal(
      String((one(f, `select value from settings where key='sync.secret'`) ?? {})['value']),
      String(before['value']),
      '密钥被改了'
    )
  })

  it('U-7 · uid 与 updated_at 原样保留', async () => {
    const f = builtDb()
    seed(f)
    const key = (t: string) => `select uid, updated_at from "${t}" order by uid`
    const before = PRESERVED_TABLES.map((t) => JSON.stringify(rows(f, key(t))))
    pretendOlder(f)
    await upgrade(f.db, deps())
    PRESERVED_TABLES.forEach((t, i) => {
      assert.equal(JSON.stringify(rows(f, key(t))), before[i], `${t} 的 uid/updated_at 被动了`)
    })
  })

  it('U-8 · row_sync_state 不保全，保全下来的行全部回到待推', async () => {
    const f = builtDb()
    seed(f, { items: 2, logsPerItem: 5, unsynced: 4 })
    const total = Number(one(f, `select count(*) as n from review_logs`)['n'])
    assert.ok(
      pendingCount(f, 'review_logs') < total,
      '前提没成立：升级前该有一部分行是「已推过」的'
    )
    pretendOlder(f)
    await upgrade(f.db, deps())
    assert.equal(Number(one(f, `select count(*) as n from row_sync_state`)['n']), 0)
    assert.equal(
      pendingCount(f, 'review_logs'),
      total,
      '★ 保全下来的行该全部回到待推（V31：宁可重推，不可错标已同步）'
    )
  })

  it('U-9 · 中途失败 → 旧库逐项一致', async () => {
    const f = builtDb()
    seed(f)
    pretendOlder(f)
    const before = snapshot(f)
    // 在「导回」那一步炸掉
    const faulty = new AuditDb(
      new FaultDb(new NodeSqliteDb(f.raw), (sql) =>
        /^insert into "review_logs"/i.test(sql.trim()) ? `insert into no_such_table (x) values (1)` : sql
      )
    )
    await assert.rejects(() => upgrade(faulty, deps()), UpgradeFailed)
    assert.equal(snapshot(f), before, '★ 旧库没有保持原样')
  })

  it('U-10 · 自检不过 → 不提交，旧库保留', async () => {
    const f = builtDb()
    seed(f)
    pretendOlder(f)
    const before = snapshot(f)
    // 导回时少搬一行 —— 结构上成功，但自检必须抓到
    const faulty = new AuditDb(
      new FaultDb(new NodeSqliteDb(f.raw), (sql) =>
        /^insert into "review_logs"/i.test(sql.trim()) ? `${sql} where rowid > 1` : sql
      )
    )
    const err = await assert.rejects(() => upgrade(faulty, deps()), UpgradeFailed)
    assert.equal(snapshot(f), before, '★ 自检失败之后旧库被动了')
  })

  it('U-11 · foreign_keys 必须在 BEGIN 之前关（机器验，不是注释）', async () => {
    const f = builtDb()
    seed(f)
    pretendOlder(f)
    await upgrade(f.db, deps())
    assert.equal(f.db.checkForeignKeysBeforeBegin(), null)
    assert.deepEqual(f.db.violations(), [], '三条硬约束有违反')
  })

  it('U-12 · user_version 在事务内设置，回滚会跟着退', async () => {
    const f = builtDb()
    seed(f)
    pretendOlder(f)
    const uvBefore = Number(one(f, `pragma user_version`)['user_version'])

    // 先验「成功路径上它写在事务里」
    const ok = builtDb()
    seed(ok)
    pretendOlder(ok)
    await upgrade(ok.db, deps())
    assert.equal(ok.db.checkUserVersionInTransaction(), null)

    // 再验「失败之后它退回去了」
    const faulty = new AuditDb(
      new FaultDb(new NodeSqliteDb(f.raw), (sql) =>
        /^insert into "reading_cards"/i.test(sql.trim()) ? `insert into nope (x) values (1)` : sql
      )
    )
    await assert.rejects(() => upgrade(faulty, deps()), UpgradeFailed)
    assert.equal(
      Number(one(f, `pragma user_version`)['user_version']),
      uvBefore,
      '★ 失败之后 user_version 没退回去'
    )
  })

  it('U-14 · 升级之后 App 能正常继续运行（内容 / 排期 / 记录都在）★核心', async () => {
    /**
     * ★ 最低安全标准的**正面表述** —— 不是「没报错」，是「还能背」。
     *
     * 三件事同时成立才算数：
     *   ① 内容还在（有项目 / 讲次 / 知识点）
     *   ② 排期还在，且每条知识点都挂着自己那张卡（没错链）
     *   ③ 没同步的复习记录还在，且各自指向原来那条知识点
     */
    const f = builtDb()
    seed(f, { items: 5, logsPerItem: 4 })
    // 升级前：每条 review_log 挂在哪个 term 上
    const key = `select rl.uid as u, i.term as t from review_logs rl join items i on i.id = rl.item_id order by rl.uid`
    const linkBefore = JSON.stringify(rows(f, key))
    const cardBefore = JSON.stringify(
      rows(f, `select i.term as t, rc.interval_days as d, rc.due_at as due
                 from reading_cards rc join items i on i.id = rc.item_id order by i.term`)
    )
    pretendOlder(f)

    const r = await upgrade(f.db, deps())
    assert.equal(r.action, 'rebuild')

    // ① 内容还在
    assert.ok(Number(one(f, `select count(*) as n from items`)['n']) > 0, '知识点没了')
    assert.ok(Number(one(f, `select count(*) as n from lectures`)['n']) > 0, '讲次没了')
    // ② / ③ 挂载关系逐条相同 —— 这才是「没错链」
    assert.equal(JSON.stringify(rows(f, key)), linkBefore, '★ 复习记录接到别的知识点上了')
    assert.equal(
      JSON.stringify(
        rows(f, `select i.term as t, rc.interval_days as d, rc.due_at as due
                   from reading_cards rc join items i on i.id = rc.item_id order by i.term`)
      ),
      cardBefore,
      '★ 排期接到别的知识点上了'
    )
    assert.equal(rows(f, `pragma foreign_key_check`).length, 0)
  })

  it('U-13 · 已经是目标版本 → 什么都不做', async () => {
    const f = builtDb()
    seed(f)
    const before = snapshot(f)
    const r = await upgrade(f.db, deps())
    assert.equal(r.action, 'noop')
    assert.equal(snapshot(f), before)
  })

  it('U-15 · 真旧库（v33）：清单里源库还没有的表按空表处理（真机回归）', async () => {
    /**
     * ★★ 2026-08-29 真机实测抓到的 P0：把使用者真库（v33）的副本推进手机，
     *    升级在 preserve 第一步就炸 —— `digestOf("reading_cards")`，
     *    而 v33 里根本没有这张表（V34 才拆出来）。
     *
     *    整套矩阵此前的「旧库」全是 `pretendOlder`（v35 结构假降级），
     *    **从来没用过真正的旧结构** —— 这条测试补上这个起点。
     *    ★ 通用性：将来任何一版新增同步表，手机升级都会再走这条路。
     */
    const f = freshDb()
    const v33 = readFileSync(join(REPO, 'schema', 'v33.sql'), 'utf8')
    for (const s of splitSql(v33)) f.raw.exec(s)
    f.raw.exec(`pragma user_version = 33`)
    const t = Date.now()
    const q = (sql: string, ...p: unknown[]): void => {
      f.raw.prepare(sql).run(...(p as never[]))
    }
    q(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`, t, t)
    q(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`, t, t)
    q(
      `insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','review',?,?)`,
      t,
      t
    )
    for (let i = 1; i <= 3; i++) {
      q(`insert into items (id,term,gloss,created_at,updated_at) values (?,?,'g',?,?)`, i, `t-${i}`, t, t)
    }
    // ★ 真库实测（2026-08-29）：`sync.user` 是**空串** —— 设备配置要逐字恢复，
    //   空串也是值。此前「空串不写」一刀切，自检报「sync.user 丢了」整趟回滚。
    q(`insert into settings (key,value,updated_at) values ('sync.user','',?)`, t)

    const r = await upgrade(f.db, deps())
    assert.equal(r.action, 'rebuild')
    assert.equal(r.fromVersion, 33)
    assert.equal(Number(one(f, `pragma user_version`)['user_version']), TARGET_VERSION)
    // 数据一行不少
    assert.equal(Number(one(f, `select count(*) as n from items`)['n']), 3)
    assert.equal(Number(one(f, `select count(*) as n from projects`)['n']), 1)
    assert.equal(Number(one(f, `select count(*) as n from lectures`)['n']), 1)
    // 源库缺的表建出来了、是空的（内容等同步补）
    assert.equal(Number(one(f, `select count(*) as n from reading_cards`)['n']), 0)
    // ★ 缺表必须写进 notes，不许静默
    assert.ok(
      r.notes.some((s) => s.includes('reading_cards')),
      '缺表要写进 notes —— 「悄悄少一类数据」是最难发现的坏法'
    )
    // 三条硬约束照旧
    assert.deepEqual(f.db.violations(), [])
  })
})

// ══════════════════════════════════════════════════════════════
// N · 负向对照 —— 拿掉修复必须变红
// ══════════════════════════════════════════════════════════════

describe('N · 负向对照', () => {
  const faulted = async (
    rewrite: (sql: string) => string
  ): Promise<{ f: Fixture; before: string; err: unknown }> => {
    const f = builtDb()
    seed(f)
    pretendOlder(f)
    const before = snapshot(f)
    const faulty = new AuditDb(new FaultDb(new NodeSqliteDb(f.raw), rewrite))
    let err: unknown = null
    try {
      await upgrade(faulty, deps())
    } catch (e) {
      err = e
    }
    return { f, before, err }
  }

  it('N-1 · 导回少一行 → 必须失败并回滚', async () => {
    const { f, before, err } = await faulted((sql) =>
      /^insert into "review_logs"/i.test(sql.trim()) ? `${sql} where rowid > 1` : sql
    )
    assert.ok(err instanceof UpgradeFailed, '★ 少一行居然过了 —— 自检没在验它以为在验的东西')
    assert.match(String((err as Error).message), /review_logs 对不上账/)
    assert.equal(snapshot(f), before)
  })

  /**
   * 只改导回语句 **select 那一半**的表达式。
   *
   * ★ 为什么要这么小心：连着列名清单一起改，SQL 直接语法错，
   *   升级当然也会失败 —— 但那证明的是「坏 SQL 跑不通」，
   *   不是「自检抓得住数据被改」。负向对照要是靠语法错通过的，
   *   它就是一条假绿。
   */
  const bendSelect = (table: string, col: string, expr: string) => (sql: string): string => {
    if (!new RegExp(`^insert into "${table}"`, 'i').test(sql.trim())) return sql
    const cut = sql.toLowerCase().lastIndexOf(' select ')
    if (cut < 0) return sql
    const head = sql.slice(0, cut)
    const tail = sql.slice(cut).replace(new RegExp(`"${col}"`, 'g'), expr)
    return head + tail
  }

  it('N-2 · 导回时改写 updated_at → 必须失败', async () => {
    const { f, before, err } = await faulted(
      bendSelect('reading_cards', 'updated_at', '(updated_at + 1)')
    )
    assert.ok(err instanceof UpgradeFailed, '★ updated_at 被顶到别处居然过了')
    assert.match(String((err as Error).message), /reading_cards 对不上账/)
    assert.match(String((err as Error).message), /updSum/, '该说清是哪一项对不上')
    assert.equal((err as UpgradeFailed).step, 'selfcheck', '★ 必须是自检抓到的，不是 SQL 报错')
    assert.equal(snapshot(f), before)
  })

  it('N-3 · 导回时把 uid 弄错 → 必须失败', async () => {
    const { f, before, err } = await faulted(
      bendSelect('review_logs', 'uid', `('x' || uid)`)
    )
    assert.ok(err instanceof UpgradeFailed, '★ uid 被改居然过了')
    assert.match(String((err as Error).message), /review_logs 对不上账/)
    assert.equal((err as UpgradeFailed).step, 'selfcheck', '★ 必须是自检抓到的，不是 SQL 报错')
    assert.equal(snapshot(f), before)
  })

  it('N-4 · 排空闸不许成为升级的阻塞条件（源码扫描）', async () => {
    /**
     * ★★ 这一条直接钉住 B′ 的核心原则：
     *    **升级安全性不能依赖联网。**
     *
     * 将来谁想把「先把待推行传上去才准升级」加回来，这条会当场红。
     */
    const src = readFileSync(join(process.cwd(), 'src', 'db', 'upgrade.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1')
    // 认「真的把它当闸用」，不认散文里提到名字 ——
    // 判据要精确，不然下一个人写句注释就把它弄红了
    const gates: [RegExp, string][] = [
      [/pushed_updated_at/, '待推判据'],
      [/(^|[^a-z])drain([^a-z]|$)/i, '排空'],
      [/(from|join|into|update|delete\s+from)\s+"?row_sync_state/i, '查询 row_sync_state'],
      [/pendingCount|hasPending|pendingRows/i, '待推计数']
    ]
    for (const [re, what] of gates) {
      assert.ok(!re.test(src), `★ 升级路径出现了${what} —— 排空闸不许成为升级的前置条件`)
    }
  })

  it('N-5 · foreign_keys 写在 BEGIN 之后 → 机器检查必须报', async () => {
    const f = builtDb()
    const audit = new AuditDb(new NodeSqliteDb(f.raw))
    await audit.begin()
    await audit.exec(`pragma foreign_keys = OFF`)
    await audit.exec(`pragma user_version = ${TARGET_VERSION}`)
    await audit.commit()
    assert.match(String(audit.checkForeignKeysBeforeBegin()), /BEGIN 之后/)
  })

  it('N-6 · user_version 写在事务之外 → 机器检查必须报', async () => {
    const f = builtDb()
    const audit = new AuditDb(new NodeSqliteDb(f.raw))
    await audit.exec(`pragma foreign_keys = OFF`)
    await audit.exec(`pragma user_version = ${TARGET_VERSION}`)
    await audit.begin()
    await audit.commit()
    assert.match(String(audit.checkUserVersionInTransaction()), /事务之外/)
  })

  it('N-6b · 事务之前写过 user_version 不算违规（真机假红回归）', async () => {
    /**
     * ★ 2026-08-25 真机 P-3 报过一次假红：夹具建库时写了一次
     *   `pragma user_version`，旧判据拿「整趟第一次」去比，就误判成
     *   「写在 BEGIN 之前」。判据现在只看**事务内写没写**。
     */
    const f = builtDb()
    const audit = new AuditDb(new NodeSqliteDb(f.raw))
    await audit.exec(`pragma user_version = ${TARGET_VERSION - 1}`) // 夹具，正常
    await audit.exec(`pragma foreign_keys = OFF`)
    await audit.begin()
    await audit.exec(`pragma user_version = ${TARGET_VERSION}`) // 升级器写的那一次
    await audit.commit()
    assert.equal(audit.checkUserVersionInTransaction(), null, '★ 这不该报')
    assert.deepEqual(audit.violations(), [])
  })

  it('N-7 · 把 _keep_ 的行读进 JS → 机器检查必须报', async () => {
    const f = builtDb()
    const audit = new AuditDb(new NodeSqliteDb(f.raw))
    await audit.exec(`create table _keep_x (a integer)`)
    await audit.all(`select * from _keep_x`)
    assert.match(String(audit.checkRestoreStaysInSql()), /读进了 JS/)
  })

  it('N-8 · 在残留上建库 → 必须拒绝', async () => {
    const f = freshDb()
    f.raw.exec(`create table leftover (x integer)`)
    await assert.rejects(() => upgrade(f.db, deps()), UpgradeFailed)
  })

  it('N-9 · 保全 settings 时漏掉 sync.device → 自检必须报', async () => {
    const f = builtDb()
    seed(f)
    pretendOlder(f)
    const before = snapshot(f)
    // 恢复 settings 那一句里，把 device 那一行吞掉
    const faulty = new AuditDb(
      new FaultDb(new NodeSqliteDb(f.raw), (sql) => sql)
    )
    // 直接改库：让 device 在恢复之前就被抹掉是做不到的（它是从快照写回的），
    // 所以换个等价的坏法 —— 把写回语句变成 no-op
    const faulty2 = new AuditDb(
      new FaultDb(new NodeSqliteDb(f.raw), (sql) =>
        /^insert into settings/i.test(sql.trim()) ? `select 1` : sql
      )
    )
    void faulty
    const err = await faulted2(faulty2)
    assert.ok(err instanceof UpgradeFailed, '★ settings 一个都没写回，自检居然过了')
    assert.equal(snapshot(f), before)

    async function faulted2(db: AuditDb): Promise<unknown> {
      try {
        await upgrade(db, deps())
        return null
      } catch (e) {
        return e
      }
    }
  })
})
