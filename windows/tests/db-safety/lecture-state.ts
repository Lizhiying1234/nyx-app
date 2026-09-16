/**
 * F-2-① analyzing 退出 lectures.status · F-2-② 开始学的排期身份 · F-2-②-e 归档的讲挡在门外
 *
 * 原 tests/db-safety.ts 第 5872–7035 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { recoverAll, recoverStuckAnalyzing } from '../../src/main/db/recover.ts'
import { analyzeLecture } from '../../src/main/ai/analyze.ts'
import { MIGRATIONS } from '../../src/main/db/migrations.ts'
import { Study } from '../../src/main/study.ts'
import { dueAfter } from '../../src/core/sm2-lecture.ts'
import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from '../../src/core/silence.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, statusOf, cleanLecture, dbThatFailsOn, analyzeDeps, lecRow, simulateStartup, snapshotAll, auditIds, readyLecture, cardDues, studySources } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ F-2-① · 「分析中」不再是业务状态
//
// 病根：`analyze` 一开始就把 `lectures.status` 改成 `'analyzing'`。
// 那一格装的是这一讲的**真实业务状态**（training / review / empty），
// 写进去的那一刻它就没了 —— 收尾时只能靠一个内存变量 `before` 还回去。
//
// 于是同一份数据有两条命运：
//   · 正常异常退出（抛错、取消）→ finally 拿着 `before`，还得准
//   · 进程直接没了             → `before` 跟着没了，启动恢复只能**猜**
//
// 猜的依据是 `due_at` 和「有没有知识点」，而这两样推不出原状态。
// 举个他真会遇到的：一讲静默归档了（training + due_at=null + silent=1），
// 重新分析途中关掉软件 —— 重启后它变成 `review`，
// **他那一讲从「已归档」变回「等审阅」，而他什么都没做。**
//
// 这一整块的判据只有一条：
//
//   > 同一个起点，正常异常退出 和 直接崩溃重启，
//   > 必须落到**完全相同**的业务状态。
//
// ══════════════════════════════════════════════════════════════

console.log('\nF-2-① · analyzing 退出 lectures.status\n')

/**
 * 这一讲的**业务事实** —— 两条路必须落到同一份。
 *
 * 只比对他看得见 / 会影响他的东西：状态、排期、间隔、归档位、
 * 知识点数、答题与学习记录。不比 `updated_at`（两条路的时刻本来就不同），
 * 也不比 `lecture_logs`（崩溃那条本来就会多留一笔痕，那是有意的）。
 */
function bizState(db: Database.Database, id: number): string {
  const l = db
    .prepare(
      `select status, due_at as dueAt, interval_days as iv, silent from lectures where id = ?`
    )
    .get(id) as Record<string, unknown>
  const n = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...(args as [])) as { n: number }).n
  return JSON.stringify({
    ...l,
    items: n(
      `select count(*) n from item_lectures il join items i on i.id = il.item_id
        where il.lecture_id = ? and i.deleted_at is null`,
      id
    ),
    answers: n(`select count(*) n from answers`),
    reviewLogs: n(`select count(*) n from review_logs`),
    cards: JSON.stringify(
      db
        .prepare(
          `select i.id, rc.due_at cd, i.attempts a, i.streak s from items i join reading_cards rc on rc.item_id = i.id
            join item_lectures il on il.item_id = i.id
           where il.lecture_id = ? order by i.id`
        )
        .all(id)
    )
  })
}

/** F-2 矩阵的一个起点 */
interface F2Start {
  name: string
  status: string
  due: 'none' | 'future'
  iv?: number
  silent?: 0 | 1
  items: boolean
  /** 两条路都必须落到这个状态 */
  want: string
  why: string
}

/**
 * 造一讲：有待分析的材料 + 指定的起点。
 *
 * 注意顺序：**先挂知识点，再压状态**。`addChunks` 会顺手做 N-1 那条结算
 * （有内容就不该叫空），反过来写的话「empty + 有内容」这个起点根本造不出来 ——
 * 它会在造夹具的过程中自己变成 review，用例于是验了个不存在的东西。
 *
 * 排期用一个**固定**时刻算，不用 `Date.now()`：两条路各建一次夹具，
 * 中间隔着几百毫秒，用当前时刻的话 due_at 天生就不一样，
 * 逐字段比对当场红 —— 而红的是夹具，不是被验的东西。
 */
const F2_T = Date.now()

function f2Seed(r: ReturnType<typeof openDatabase>, s: F2Start): number {
  const t = F2_T
  r.db
    .prepare(
      `insert into lectures (id,unit_id,name,status,due_at,created_at,updated_at)
       values (9,1,'F2 的那一讲','empty',null,?,?)`
    )
    .run(t, t)
  const repo = new Repo(r.db)
  repo.addOriginal(9, '待分析的原文', 'They hold sway over the region.', 'paste')
  if (s.items) repo.addChunks(9, '我的收集', 'hold sway over')
  r.db
    .prepare(
      `update lectures set status=?, due_at=?, interval_days=?, silent=? where id=9`
    )
    .run(s.status, s.due === 'future' ? t + 7 * 86400000 : null, s.iv ?? 0, s.silent ?? 0)
  return 9
}

/**
 * 路径一 · **正常异常退出**：分析中途抛错，`finally` 有机会跑。
 *
 * 跑完之后**也重启一次**。不重启的话这把尺子是歪的 ——
 * 崩溃那条走了一遍启动自愈，正常这条没走，
 * 比出来的差别可能只是「有没有开过机」，而不是「分析毁没毁掉状态」。
 * 他真实的用法本来也是：失败了、关掉、第二天再打开。
 */
async function f2PathExit(s: F2Start): Promise<string> {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = f2Seed(r, s)
  try {
    await analyzeLecture(id, {
      ...analyzeDeps(r, dir),
      db: dbThatFailsOn(r.db, 'insert into analysis_jobs')
    })
  } catch {
    /* 意料之中 */
  }
  r.db.close()

  // ── 下一次启动 ──
  const again = simulateStartup(p, backups)
  const out = bizState(again.r.db, id)
  again.r.db.close()
  return out
}

/**
 * 路径二 · **直接崩溃**：分析写到一半，进程就没了。
 *
 * 怎么在进程内忠实地模拟「断电」：在分析循环的第一句 SQL 上
 * **先把 lectures 那一行照原样抄下来**，再抛错。那一行就是断电瞬间
 * 库里的样子 —— 旧代码抄到的是 `analyzing`，新代码抄到的是原状态。
 * `analyzeLecture` 的 `finally` 之后照样会跑（在进程里拦不住它），
 * 所以跑完之后把那一行**按抄下来的样子写回去**：真的崩溃时，
 * finally 做的任何事都不曾发生。
 *
 * 这样这个模拟对两个版本都成立 —— 它不假设崩溃点上写了什么，
 * 它**去问**。负向对照才有意义。
 */
async function f2PathCrash(s: F2Start): Promise<string> {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = f2Seed(r, s)

  let atCrash: Record<string, unknown> | undefined
  const dying = new Proxy(r.db, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('insert into analysis_jobs')) {
            atCrash = target.prepare(`select * from lectures where id = ?`).get(id) as Record<
              string,
              unknown
            >
            throw new Error('模拟：进程在这一刻没了')
          }
          return target.prepare(sql)
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    }
  }) as Database.Database

  try {
    await analyzeLecture(id, { ...analyzeDeps(r, dir), db: dying })
  } catch {
    /* 意料之中 */
  }
  assert(atCrash, '★ 注入点没被走到 —— 这条用例什么都没验（假绿）')
  r.db
    .prepare(`update lectures set status=?, due_at=?, interval_days=?, silent=? where id=?`)
    .run(atCrash.status, atCrash.due_at, atCrash.interval_days, atCrash.silent, id)
  r.db.close()

  // ── 下一次启动 ──
  const again = simulateStartup(p, backups)
  const out = bizState(again.r.db, id)
  again.r.db.close()
  return out
}

const F2_MATRIX: F2Start[] = [
  {
    name: '① empty · 一条都没捞到',
    status: 'empty',
    due: 'none',
    items: false,
    want: 'empty',
    why: '跟没分析过一样'
  },
  {
    name: '⑥ empty · 已经捞到几条才失败',
    status: 'empty',
    due: 'none',
    items: true,
    want: 'review',
    why: '部分结果保住了，停在 F-03 那道门等他审阅（N-1）'
  },
  {
    name: '② review · 有内容',
    status: 'review',
    due: 'none',
    items: true,
    want: 'review',
    why: '本来就在等审阅，重新分析失败不改变这件事'
  },
  {
    name: '★ ⑦ review · 一条内容都没有',
    status: 'review',
    due: 'none',
    items: false,
    want: 'review',
    why: '★ 分歧点：旧代码崩溃后按「没内容没排期」猜成 empty，而正常退出会还原成 review'
  },
  {
    name: '③④ training · 在轮转中',
    status: 'training',
    due: 'future',
    iv: 12,
    items: true,
    want: 'training',
    why: '排期与 12 天的间隔都要原样在'
  },
  {
    name: '★ ⑧ training · 已归档（silent=1，本来就没排期）',
    status: 'training',
    due: 'none',
    iv: 12,
    silent: 1,
    items: true,
    want: 'training',
    why: '★ 分歧点：旧代码崩溃后把已归档的一讲变回 review —— 他什么都没做，归档没了'
  },
  {
    name: '★ training · 没排期也没归档（D-4 历史异常）',
    status: 'training',
    due: 'none',
    iv: 0,
    items: true,
    want: 'training',
    why: '★ 已知的历史异常。这一轮的要求是**不许替它编一个 due_at 出来**'
  }
]

for (const s of F2_MATRIX) {
  checkAsync(`★★ F-2-① · ${s.name} —— 正常异常退出 与 崩溃重启 必须一致`, async () => {
    const exit = await f2PathExit(s)
    const crash = await f2PathCrash(s)
    assert(
      exit === crash,
      `★ 同一份数据，两条路走出了两个结果 —— 这正是 F-2：\n` +
        `  正常异常退出：${exit}\n` +
        `  直接崩溃重启：${crash}\n` +
        `  （${s.why}）`
    )
    const got = JSON.parse(exit) as { status: string; dueAt: number | null; iv: number }
    assert(got.status === s.want, `该是 ${s.want}，实际 ${got.status} —— ${s.why}`)
    // ⑪ 排期与间隔不许被这次失败的分析动到
    assert(
      s.due === 'future' ? got.dueAt !== null : got.dueAt === null,
      `★ 排期被动了：${got.dueAt} —— 分析失败不该造出、也不该抹掉到期日`
    )
    assert(got.iv === (s.iv ?? 0), `★ 间隔被改了：${s.iv ?? 0} → ${got.iv}，进度会清零`)
  })
}

// ── ⑫ 正常路径：不留任何「分析中」的痕迹 ──────────────────────

checkAsync('★ F-2-① · ⑫ 分析全程都不写 status —— 连一个中间态都不该出现', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = f2Seed(r, {
    name: '',
    status: 'training',
    due: 'future',
    iv: 12,
    items: true,
    want: '',
    why: ''
  })

  /**
   * 一路盯着：分析期间任何一次对 lectures 的写，都把当时的状态记下来。
   *
   * 这比「跑完再看一眼」严得多 —— 旧代码跑完也会把状态还原回去，
   * 事后看是看不出它中途毁过一次的。而它中途毁掉的那一格，
   * 正是崩溃时唯一剩下的东西。
   */
  const seen: string[] = []
  const watched = new Proxy(r.db, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        return (sql: string) => {
          // 分析循环的第一句 —— 在这里断掉，免得真去打 AI 的接口（会卡住）。
          // 旧代码那句 `update lectures set status='analyzing'` 在它**之前**，
          // 所以该抓的东西一样抓得到。
          if (sql.includes('insert into analysis_jobs')) throw new Error('注入：到此为止')
          const st = target.prepare(sql)
          if (/update\s+lectures/i.test(sql)) {
            return new Proxy(st, {
              get(t2, p2, r2) {
                if (p2 === 'run') {
                  return (...args: unknown[]) => {
                    const out = (t2.run as (...a: unknown[]) => unknown)(...args)
                    seen.push(
                      (
                        target.prepare(`select status from lectures where id=?`).get(id) as {
                          status: string
                        }
                      ).status
                    )
                    return out
                  }
                }
                const v = Reflect.get(t2, p2, r2)
                return typeof v === 'function' ? v.bind(t2) : v
              }
            })
          }
          return st
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    }
  }) as Database.Database

  try {
    await analyzeLecture(id, { ...analyzeDeps(r, dir), db: watched })
  } catch {
    /* 意料之中 */
  }
  assert(
    !seen.includes('analyzing'),
    `★ 分析途中把 status 写成过 analyzing：${seen.join(' → ')} —— 那一刻真实状态就没了`
  )
  assert(
    statusOf(r.db, id) === 'training',
    `分析失败把轮转中的讲改成了 ${statusOf(r.db, id)}`
  )
  r.db.close()
})

check('★ F-2-① · analyzing 已经不是合法业务状态了（LectureStatus 里没有它）', () => {
  /**
   * 这条守的是「以后有人又把它加回去」。
   *
   * 类型是编译期的东西，运行期一点痕迹都没有 —— 所以只能查源码本身。
   * 查不到文件就当场判红：一条读不到源码的用例会**永远绿**，
   * 而报警器不响的时候没人会去怀疑报警器。
   */
  const api = join(process.cwd(), 'src', 'shared', 'api.ts')
  assert(existsSync(api), `读不到 ${api} —— 这条用例已经在验一个不存在的东西了（假绿）`)
  const src = readFileSync(api, 'utf8')
  const line = src.split(String.fromCharCode(10)).find((l) => l.includes('export type LectureStatus'))
  assert(line, '找不到 LectureStatus 的定义 —— 这条用例已经在验一个不存在的东西了')
  assert(
    !line.includes('analyzing'),
    `★ analyzing 又回到 LectureStatus 里了：${line.trim()}`
  )
})

// ── ⑨ 外来 / 导入的 analyzing ────────────────────────────────

check('★ F-2-① · ⑨ 同步或旧备份带进来的 analyzing：升级时就地落地（迁移 V19）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  new Repo(r.db).addChunks(2, '我的收集', 'a stone throw from')
  cleanLecture(r)
  // 三种事实各一条 —— 和兼容兜底用的是同一条规则，行为必须一致
  r.db.prepare(`update lectures set status='analyzing', due_at=? where id=1`).run(t + 86400000)
  r.db.prepare(`update lectures set status='analyzing', due_at=null where id=2`).run()
  r.db.prepare(`update lectures set status='analyzing', due_at=null where id=9`).run()

  const v19 = MIGRATIONS.find((m) => m.version === 19)
  assert(v19, '找不到 V19 —— 迁移编号被改动过')
  v19.up(r.db)

  assert(statusOf(r.db, 1) === 'training', `有排期的该是 training，实际 ${statusOf(r.db, 1)}`)
  assert(statusOf(r.db, 2) === 'review', `有内容的该是 review，实际 ${statusOf(r.db, 2)}`)
  assert(statusOf(r.db, 9) === 'empty', `什么都没有的该是 empty，实际 ${statusOf(r.db, 9)}`)
  const logs = (
    r.db
      .prepare(`select count(*) n from lecture_logs where event='recovered'`)
      .get() as { n: number }
  ).n
  assert(logs === 3, `★ 状态变了却没留痕：应该 3 条，实际 ${logs}`)

  // 迁移**不重复**：再跑一次是空转
  const snap = snapshotAll(r.db)
  v19.up(r.db)
  assert(snapshotAll(r.db) === snap, '★ V19 再跑一次动了数据 —— 迁移不幂等')
  r.db.close()
})

check('★ F-2-① · ⑨ 外来 analyzing 落在垃圾箱里的讲上：迁移也要收拾，否则恢复出来是个死状态', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  r.db
    .prepare(`update lectures set status='analyzing', deleted_at=? where id=1`)
    .run(Date.now())

  // 启动自愈**故意**不碰垃圾箱里的（那是运行期的规矩）
  assert(recoverStuckAnalyzing(r.db).fixed.length === 0, '启动自愈不该动垃圾箱里的讲')
  assert(statusOf(r.db, 1) === 'analyzing', '前提没成立')

  // 但升级迁移要 —— 不然他哪天把它捡回来，捡回来的是一个已经不存在的状态
  MIGRATIONS.find((m) => m.version === 19)!.up(r.db)
  assert(
    statusOf(r.db, 1) !== 'analyzing',
    '★ 垃圾箱里的 analyzing 没被迁移收拾 —— 恢复出来那一讲就废了'
  )
  r.db.close()
})

// ── ⑩⑪ 兼容兜底：幂等 + 只改 status ──────────────────────────

check('★ F-2-① · ⑪ 兼容兜底只改 status —— 排期 / 间隔 / 答题 / 学习记录 / 条目进度一个字不动', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  const study = new Study(r.db, join(backups, 'prompts'), () => 'B2')
  readyLecture(r, 1)
  study.startLearning(1) // training + due_at + 认读排期
  r.db.prepare(`update lectures set interval_days = 12 where id = 1`).run()
  // 真的留一点学习痕迹下来，否则「一个字不动」验的是几张空表
  r.db
    .prepare(
      `insert into review_logs (item_id, line, grade, interval_after, ease_after, created_at, updated_at)
       values (1, 'reading', 3, 2, 2.5, ?, ?)`
    )
    .run(t, t)
  const sid = Number(
    r.db
      .prepare(
        `insert into sessions (kind, scope, target, started_at, created_at, updated_at)
         values ('production','mixed',0,?,?,?)`
      )
      .run(t, t, t).lastInsertRowid
  )
  r.db
    .prepare(
      `insert into answers (session_id, item_id, question_id, attempt_no, is_first, text, grade,
                            hinted, created_at, updated_at)
       values (?, 1, null, 1, 1, 'x', 4, 0, ?, ?)`
    )
    .run(sid, t, t)
  r.db
    .prepare(`update items set attempts=4, corrects=3, streak=2 where id=1`)
    .run()
  r.db.prepare(`update reading_cards set interval_days=2 where item_id=1`).run()

  const before = snapshotAll(r.db)

  // 外来数据把它写成了 analyzing
  r.db.prepare(`update lectures set status='analyzing' where id=1`).run()
  const res = recoverStuckAnalyzing(r.db)
  assert(res.fixed.length === 1, `该收拾 1 讲，实际 ${res.fixed.length}`)
  assert(statusOf(r.db, 1) === 'training', `该回 training，实际 ${statusOf(r.db, 1)}`)

  // 这一步理应改的就两样：status（已经改回原值了）和一条留痕。把留痕撤掉，
  // 剩下的必须**逐表逐列**和动手之前一模一样。
  r.db.prepare(`delete from lecture_logs where event='recovered'`).run()
  assert(
    snapshotAll(r.db) === before,
    '★ 收拾 analyzing 的时候顺手改了别的东西 —— 他的排期或进度被动了'
  )
  r.db.close()
})

check('★ F-2-① · ⑩ 连开两次软件：第二次是空转', () => {
  const { db: p, backups } = freshDir()
  {
    const r = openDatabase(p, backups)
    seedTree(r)
    new Repo(r.db).addChunks(2, '我的收集', 'a stone throw from')
    r.db.prepare(`update lectures set status='analyzing', due_at=null where id=2`).run()
    r.db.close()
  }
  const s1 = simulateStartup(p, backups)
  assert(s1.recovered.fixed.length === 1, `第一次该收拾 1 讲，实际 ${s1.recovered.fixed.length}`)
  const snap = snapshotAll(s1.r.db)
  s1.r.db.close()

  const s2 = simulateStartup(p, backups)
  assert(
    s2.recovered.fixed.length === 0,
    `★ 第二次启动又改了：${JSON.stringify(s2.recovered.fixed)}`
  )
  assert(snapshotAll(s2.r.db) === snap, '★ 第二次启动动了数据 —— 兼容兜底不幂等')
  s2.r.db.close()
})

check('★ F-2-① · 正常跑起来的软件里，兼容兜底永远扫不到东西', () => {
  /**
   * 这条是给将来看的：哪天有人又让 analyze 去写 status，
   * 这里会先红 —— 而不是等到他崩溃一次、状态莫名其妙变了才发现。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const n = (
    r.db.prepare(`select count(*) n from lectures where status='analyzing'`).get() as { n: number }
  ).n
  assert(n === 0, `★ 正常路径产出了 ${n} 条 analyzing —— 它不该再被写进库里`)
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ F-2-② · 「开始学」不再把练出来的间隔打回 1 天
//
// 病灶：`startLearning` 里写死 `interval_days = 1, due_at = 明天`。
// 那两个数字的理由是**给新条目一个认读窗口**（docs/archive/study-flow.html 阶段④ / M-019）——
// 是 item 级的理由，却付了 lecture 级的代价：
// 一讲练到 12 天间隔，重新分析一次、再点「开始学」，进度归零。
// 而爬回 12 天，按 75–90% 那一档要再练 4 次、跨 15 天。
//
// 判据现在在 `core/start-learning.ts`（纯函数，两端共用 · D-238），
// 这里验的是**它真的落到库里了**，而且**只落该落的那几列**。
// ══════════════════════════════════════════════════════════════

console.log('\nF-2-② · 开始学的排期身份\n')

/** 这一讲的调度位 + 每条的认读排期 —— 断言「一个字没动」用 */
function f2bSnapshot(db: Database.Database, id: number): string {
  return JSON.stringify({
    lecture: db
      .prepare(`select status, due_at as d, interval_days as iv, silent from lectures where id = ?`)
      .get(id),
    items: db
      .prepare(
        `select i.id, rc.due_at cd, rc.interval_days ci, rc.ease ce, rc.reps cr,
                i.production_state ps, i.streak, i.attempts, i.corrects, i.attempts_in_stage ais,
                i.hard_entries he
           from items i join item_lectures il on il.item_id = i.id
                join reading_cards rc on rc.item_id = i.id
          where il.lecture_id = ? and i.deleted_at is null order by i.id`
      )
      .all(id)
  })
}

/**
 * 造一讲「已经练到 12 天间隔」的：review 状态、有条目、条目都已经有认读历史。
 *
 * 条目必须**已经有 `card_due_at`** —— 否则它们算「新条目」，
 * 那 B（没有新条目）这一格根本造不出来，用例会验一个不存在的东西。
 */
function trainedLecture(
  r: ReturnType<typeof openDatabase>,
  opts: { interval: number; dueIn: number | null }
): { id: number; due: number | null } {
  const id = 1
  new Repo(r.db).addChunks(id, '我的收集', ['alpha one', 'beta two', 'gamma three'].join(String.fromCharCode(10)))
  const t = Date.now()
  // 练过的痕迹：认读卡有自己的排期与容易度，产出线有连对次数
  r.db
    .prepare(
      `update items set production_state = 'training', streak = 2, attempts = 7, corrects = 5
        where id in (select item_id from item_lectures where lecture_id = ?)`
    )
    .run(id)
  r.db
    .prepare(
      `update reading_cards set due_at = ?, interval_days = 6, ease = 2.35, reps = 3
        where item_id in (select item_id from item_lectures where lecture_id = ?)`
    )
    .run(t + 6 * 86400000, id)
  const due = opts.dueIn === null ? null : dueAfter(opts.dueIn)
  r.db
    .prepare(`update lectures set status='review', interval_days = ?, due_at = ? where id = ?`)
    .run(opts.interval, due, id)
  return { id, due }
}

const f2bStudy = (r: ReturnType<typeof openDatabase>, backups: string): Study =>
  new Study(r.db, join(backups, 'prompts'), () => 'B2')

// ── ① 第一次开始学：行为完全不变 ──────────────────────────────

check('★ F-2-② · ① 第一次开始学：interval 0 → 1，明天到期（和以前一模一样）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  readyLecture(r, 1) // interval=0, due=null, 三条**没有认读卡**的新条目
  const out = f2bStudy(r, backups).startLearning(1)

  const l = lecRow(r.db, 1)
  assert(l.status === 'training', `该进轮转，实际 ${l.status}`)
  assert(l.interval === 1, `★ 第一次该是 1 天，实际 ${l.interval}`)
  assert(l.dueAt === dueAfter(1), `★ 第一次该排在明天，实际 ${l.dueAt} vs ${dueAfter(1)}`)
  assert(out.intervalDays === 1 && out.refused === null, `返回值不对：${JSON.stringify(out)}`)
  // 第一次开始学，这一讲**每一条**都是新的 —— 不写死数字，
  // 写死的话 seedTree 哪天多挂一条，红的是夹具而不是被验的东西
  assert(
    out.fresh === out.count && out.count > 0,
    `第一次开始学该是全部条目拿到首次认读：${out.fresh} / ${out.count}`
  )
  assert(!cardDues(r.db, 1).includes('"cd":null'), `★ 有条目没拿到认读排期：${cardDues(r.db, 1)}`)
  assert(auditIds(r.db).length === 0, `体检不干净：${auditIds(r.db).join('、')}`)
  r.db.close()
})

// ── ②③④ 有历史 + 没有新条目：一个字都不动 ────────────────────

check('★★ F-2-② · ② 12 天间隔 + 原排期 + 没有新条目 → interval 仍是 12', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { due } = trainedLecture(r, { interval: 12, dueIn: 25 })
  const out = f2bStudy(r, backups).startLearning(1)

  const l = lecRow(r.db, 1)
  assert(
    l.interval === 12,
    `★ 12 天的间隔被打回 ${l.interval} —— 那是练了 6 次才攒出来的，重新爬回来要 15 天`
  )
  assert(l.status === 'training', `该进轮转，实际 ${l.status}`)
  assert(out.intervalDays === 12, `返回值里的间隔不对：${out.intervalDays}`)
  // ③ 排期不许无意义地提前
  assert(
    l.dueAt === due,
    `★ 原排期被提前了：${new Date(due!).toLocaleDateString()} → ${new Date(l.dueAt!).toLocaleDateString()}` +
      ` —— 重新分析不是一次测验，它不产生任何「他记不记得」的证据`
  )
  assert(l.dueAt !== dueAfter(1), '★ 排期被改成了明天')
  assert(out.fresh === 0, `不该有新条目，实际 ${out.fresh}`)
  r.db.close()
})

check('★★ F-2-② · ④ 没有新条目时：除了 status，整讲的学习数据一个字不许动', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  trainedLecture(r, { interval: 12, dueIn: 25 })
  const before = f2bSnapshot(r.db, 1)

  f2bStudy(r, backups).startLearning(1)

  // 唯一该变的就是 status —— 把它还原回去，剩下的必须逐列一致
  r.db.prepare(`update lectures set status='review' where id=1`).run()
  assert(
    f2bSnapshot(r.db, 1) === before,
    `★ 开始学顺手改了别的东西：\n  前：${before}\n  后：${f2bSnapshot(r.db, 1)}`
  )
  r.db.close()
})

// ── ⑤ 有新条目：新旧各走各的 ──────────────────────────────────

check('★★ F-2-② · ⑤ 新增 3 条 → 新条目拿到认读、老条目一个字不动、间隔与排期不变', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { due } = trainedLecture(r, { interval: 12, dueIn: 25 })
  const oldIds = (
    r.db
      .prepare(
        `select i.id from items i join item_lectures il on il.item_id = i.id
          where il.lecture_id = 1 and i.deleted_at is null order by i.id`
      )
      .all() as { id: number }[]
  ).map((x) => x.id)
  const oldBefore = JSON.stringify(
    r.db
      .prepare(
        `select i.id, rc.due_at cd, rc.interval_days ci, rc.ease ce, rc.reps cr,
                i.production_state ps, i.streak, i.attempts, i.corrects
           from items i join reading_cards rc on rc.item_id = i.id
          where i.id in (${oldIds.join(',')}) order by i.id`
      )
      .all()
  )

  // 重新分析捞到 3 条新的（这里直接走写入路径，AI 那一段不是这条用例要验的）
  new Repo(r.db).addChunks(1, '我的收集', ['delta four', 'epsilon five', 'zeta six'].join(String.fromCharCode(10)))
  r.db.prepare(`update lectures set status='review' where id=1`).run()

  const out = f2bStudy(r, backups).startLearning(1)

  assert(out.fresh === 3, `★ 说好 3 条新表达拿到首次认读，实际 ${out.fresh}`)
  const l = lecRow(r.db, 1)
  assert(l.interval === 12, `★ 新增了几条就把间隔打回 ${l.interval} —— 那是 item 级的理由付 lecture 级的代价`)
  assert(
    l.dueAt === due,
    `★ 排期因为新增条目被重置了：${l.dueAt} vs ${due} —— 新条目今天就在认读队列里，到原排期还有 25 天`
  )
  // 老条目：一个字都不许动
  const oldAfter = JSON.stringify(
    r.db
      .prepare(
        `select i.id, rc.due_at cd, rc.interval_days ci, rc.ease ce, rc.reps cr,
                i.production_state ps, i.streak, i.attempts, i.corrects
           from items i join reading_cards rc on rc.item_id = i.id
          where i.id in (${oldIds.join(',')}) order by i.id`
      )
      .all()
  )
  assert(oldAfter === oldBefore, `★ 老条目的学习历史被动了：\n  前：${oldBefore}\n  后：${oldAfter}`)
  // 新条目：真的拿到了认读排期
  const stillNull = (
    r.db
      .prepare(
        `select count(*) as n from items i join item_lectures il on il.item_id = i.id
              join reading_cards rc on rc.item_id = i.id
          where il.lecture_id = 1 and i.deleted_at is null and rc.due_at is null`
      )
      .get() as { n: number }
  ).n
  assert(stillNull === 0, `★ 还有 ${stillNull} 条新表达没拿到认读排期 —— 它们永远不会出现在认读队列里`)
  r.db.close()
})

check('★ F-2-② · 界面说的「几条新表达」必须就是真被排上认读的行数', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  trainedLecture(r, { interval: 12, dueIn: 25 })
  new Repo(r.db).addChunks(1, '我的收集', ['delta four', 'epsilon five'].join(String.fromCharCode(10)))
  // 其中一条已经在认读线上静默了 —— 它不该被算成「新表达」，也不该被排期
  r.db
    .prepare(
      `update reading_cards set silent = 1
        where item_id in (select id from items where term = 'epsilon five')`
    )
    .run()
  r.db.prepare(`update lectures set status='review' where id=1`).run()

  const out = f2bStudy(r, backups).startLearning(1)
  assert(out.fresh === 1, `★ 静默的那条被算进「新表达」了：${out.fresh}`)
  const silentCd = (
    r.db.prepare(`select rc.due_at as cd from items i join reading_cards rc on rc.item_id = i.id
                   where i.term = 'epsilon five'`).get() as {
      cd: number | null
    }
  ).cd
  assert(silentCd === null, '★ 给一条已经静默的认读卡排了期')
  r.db.close()
})

// ── C′ 逾期那两格 ─────────────────────────────────────────────

check('★ F-2-② · 原排期已经过了 + 有新条目 → 推到明天，间隔不丢', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  trainedLecture(r, { interval: 12, dueIn: -8 })
  new Repo(r.db).addChunks(1, '我的收集', 'delta four')
  r.db.prepare(`update lectures set status='review' where id=1`).run()

  f2bStudy(r, backups).startLearning(1)
  const l = lecRow(r.db, 1)
  assert(l.dueAt === dueAfter(1), `逾期 + 有新条目该推到明天，实际 ${l.dueAt}`)
  assert(l.interval === 12, `★ 推迟一天不该把间隔一起丢掉：${l.interval}`)
  r.db.close()
})

check('★ F-2-② · 原排期已经过了 + 没有新条目 → 不许推迟', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { due } = trainedLecture(r, { interval: 12, dueIn: -8 })
  f2bStudy(r, backups).startLearning(1)
  const l = lecRow(r.db, 1)
  assert(
    l.dueAt === due,
    `★ 「重新分析一下」变成了把作业往后拖一天的按钮：${l.dueAt} vs ${due}`
  )
  r.db.close()
})

// ── ⑥⑦⑧⑨ 前后左右都没被改坏 ──────────────────────────────────

checkAsync('★ F-2-② · ⑥ 重新分析成功 → 仍然停在 review，间隔与排期原样等着', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { due } = trainedLecture(r, { interval: 12, dueIn: 25 })
  r.db.prepare(`update lectures set status='training' where id=1`).run()
  new Repo(r.db).addOriginal(1, '待分析的原文', 'They hold sway over the region.', 'paste')

  // 分析失败也好成功也好，这条用例只要它别动排期
  try {
    await analyzeLecture(1, {
      ...analyzeDeps(r, dir),
      db: dbThatFailsOn(r.db, 'insert into analysis_jobs')
    })
  } catch {
    /* 意料之中 */
  }
  const l = lecRow(r.db, 1)
  assert(l.interval === 12 && l.dueAt === due, `★ 分析动了排期：${JSON.stringify(l)}`)
  r.db.close()
})

check('★ F-2-② · ⑧ review-only 的后端前置条件还在（P-1 不变量 I-2）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const { due } = trainedLecture(r, { interval: 12, dueIn: 25 })
  r.db.prepare(`update lectures set status='training' where id=1`).run()
  const before = f2bSnapshot(r.db, 1)

  const out = f2bStudy(r, backups).startLearning(1)
  assert(out.refused === 'alreadyRunning', `★ 已经在轮转的讲：${out.refused}`)
  assert(out.intervalDays === 12, `拒绝时也要如实报当前间隔：${out.intervalDays}`)
  assert(out.dueAt === due, '拒绝时报的排期不对')
  assert(f2bSnapshot(r.db, 1) === before, '★ 被拒绝了却还是写了东西')
  r.db.close()
})

check('★★ F-2-② · ⑨ 认读排期那一句失败 → 整个事务回滚，间隔和状态都不许留下', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  trainedLecture(r, { interval: 12, dueIn: 25 })
  new Repo(r.db).addChunks(1, '我的收集', 'delta four')
  r.db.prepare(`update lectures set status='review' where id=1`).run()
  const before = f2bSnapshot(r.db, 1)

  // 只让「给新条目排认读」那一句炸 —— 它在同一个事务的后半段
  const boom = dbThatFailsOn(r.db, 'set due_at = ?, updated_at = ?')
  let threw = false
  try {
    new Study(boom, join(backups, 'prompts'), () => 'B2').startLearning(1)
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没有冒出来')
  assert(
    f2bSnapshot(r.db, 1) === before,
    `★ 出现了「进了轮转、可是新条目一张认读卡都没有」：\n  前：${before}\n  后：${f2bSnapshot(r.db, 1)}`
  )
  r.db.close()
})

check('★ F-2-② · review 带着 due_at 是合法的 —— 体检不许把它当异常', () => {
  /**
   * 这是方案 3 的承重墙：`review ∧ due_at ≠ null` 表达的是
   * **「这一讲的排期身份还在，只是暂时退出队列等他审阅」**。
   * 原计划里那条 audit 不变量已经撤掉（会把正常状态判成异常），
   * 这条用例守着它不被谁再加回来。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  trainedLecture(r, { interval: 12, dueIn: 25 })
  const found = auditIds(r.db)
  assert(found.length === 0, `★ 体检把「待审阅 + 有排期」判成了异常：${found.join('、')}`)

  // 启动自愈也不许动它
  const snap = f2bSnapshot(r.db, 1)
  recoverAll(r.db)
  assert(f2bSnapshot(r.db, 1) === snap, '★ 启动自愈动了一条合法的「待审阅 + 有排期」')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ F-2-②-e · 归档的讲不许被「开始学」拉进轮转
//
// `silent = 1 ∧ status = 'review'` 是一种**合法**形状：归档时只翻 silent 位、
// 清掉 due_at，status 保持原样。而进轮转的门槛以前只有 `status='review'` ——
// 绕过界面直接调这条 IPC，就会给一个已归档的讲写上 `due_at = 明天`，
// 正好造出体检里 `silent-but-due` 那条 error 级异常。
//
// 界面确实挡住了（归档的讲不在项目栏里，那颗按钮也只在 review 时渲染），
// 但**靠界面挡不是保证** —— 和 P-1 不变量 I-2 一个形状。
// ══════════════════════════════════════════════════════════════

console.log('\nF-2-②-e · 归档的讲挡在门外\n')

/** 造一讲「归档了、但 status 还停在 review」的 —— 归档不动 status，这是真实形状 */
function archivedReview(r: ReturnType<typeof openDatabase>): number {
  const id = 1
  readyLecture(r, id) // review · interval 0 · due null · 三条没有认读卡的条目
  new Repo(r.db).setSilent('lecture', id, true)
  return id
}

check('★ F-2-②-e · 前提本身是真的：归档之后 status 仍然是 review', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  archivedReview(r)
  const l = r.db
    .prepare(`select status, silent, due_at as d from lectures where id = 1`)
    .get() as { status: string; silent: number; d: number | null }
  assert(
    l.status === 'review' && l.silent === 1,
    `★ 夹具不真实 —— 归档改了 status：${JSON.stringify(l)}。` +
      `那样的话这一整块验的是一个不存在的形状`
  )
  assert(l.d === null, '归档该把排期清掉')
  r.db.close()
})

check('★★ F-2-②-e · ② 归档的讲调 startLearning → 库里一个字都不许变', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  archivedReview(r)
  const before = snapshotAll(r.db)

  const out = f2bStudy(r, backups).startLearning(1)

  assert(out.refused === 'archived', `★ 拒绝的理由不对：${out.refused}`)
  assert(
    snapshotAll(r.db) === before,
    '★ 归档的讲被开始学了 —— 整库逐列比对发现有东西变了'
  )
  r.db.close()
})

check('★★ F-2-②-e · ③④⑤⑥ 排期 / 间隔 / 认读卡 / 学习记录逐项确认没动', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  archivedReview(r)
  // 给它一段真实的学习历史，免得「没动」验的是几张空表
  r.db.prepare(`update lectures set interval_days = 12 where id = 1`).run()
  const cards = cardDues(r.db, 1)
  const logs = (
    r.db.prepare(`select count(*) as n from lecture_logs`).get() as { n: number }
  ).n

  f2bStudy(r, backups).startLearning(1)

  const l = lecRow(r.db, 1)
  assert(l.dueAt === null, `★ ③ 给归档的讲写了到期日：${l.dueAt}`)
  assert(l.interval === 12, `★ ④ 间隔被动了：${l.interval}`)
  assert(l.status === 'review', `★ 状态被改成了 ${l.status}`)
  assert(cardDues(r.db, 1) === cards, '★ ⑤ 认读卡的排期被动了')
  assert(
    (r.db.prepare(`select count(*) as n from lecture_logs`).get() as { n: number }).n === logs,
    '★ ⑥ 被拒绝了却还是记了一笔「审阅完成」'
  )
  r.db.close()
})

check('★★ F-2-②-e · ⑦ 调完之后体检里不许冒出 silent-but-due', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  archivedReview(r)
  assert(auditIds(r.db).length === 0, `动手之前体检就不干净：${auditIds(r.db).join('、')}`)

  f2bStudy(r, backups).startLearning(1)

  const found = auditIds(r.db)
  assert(
    !found.includes('silent-but-due'),
    `★ 「开始学」自己造出了一条 error 级异常：${found.join('、')}`
  )
  assert(found.length === 0, `体检不干净：${found.join('、')}`)
  r.db.close()
})

check('★ F-2-②-e · ① 正常的 review + silent=0 一点没受影响', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  readyLecture(r, 1)
  const out = f2bStudy(r, backups).startLearning(1)
  assert(out.refused === null, `★ 正常路径被这道新门槛挡住了：${out.refused}`)
  assert(lecRow(r.db, 1).status === 'training', '正常路径没进轮转')
  assert(!cardDues(r.db, 1).includes('"cd":null'), '正常路径没给认读卡排期')
  r.db.close()
})

check('★★ F-2-②-e · 拒绝的理由必须和真实原因对得上（四种各说各的）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const study = f2bStudy(r, backups)

  // 静默 —— 哪怕它同时还在轮转中，要说的也是「去哪儿、做什么才能把它拿回来」（D-489）
  readyLecture(r, 1)
  new Repo(r.db).setSilent('lecture', 1, true)
  r.db.prepare(`update lectures set status='training' where id=1`).run()
  const arch = study.startLearning(1)
  assert(arch.refused === 'archived', `★ 静默 + 轮转中：${arch.refused}`)
  /**
   * ★★ 2026-09-15 · 改判据的**形态**，不放宽（D-489 两端文案整理）
   *
   * 原来这一句钉的是屏上那三个字「放回去」。那三个字已经不在了 ——
   * 动作词现在统一从 `SILENCE_ACTIONS.restore` 来，句子说的是「把它恢复」。
   *
   * 但「那三个字没了就把断言删掉」等于把这道闸放宽成零。它要守的从来不是
   * 某三个字，而是**这句拒绝话有没有把下一步说全**。所以钉两样东西，
   * 而且两样都从常量取（谁改词，这里跟着变，不会各漂各的）：
   *   ① 那个筛子叫什么（`SILENCE_FILTER_NAME`）—— 他得知道去哪儿找
   *   ② 到了那儿做什么（`SILENCE_ACTIONS.restore`）—— 他得知道按哪个动作
   *
   * ★ 比原来严：原来只要句子里出现「放回去」就算过 —— 去哪儿找、那个动作
   *   叫什么名字，一概没人管。现在屏上那两个词改了而这句话忘了跟，当场红。
   */
  assert(
    arch.reason.includes(SILENCE_FILTER_NAME) && arch.reason.includes(SILENCE_ACTIONS.restore),
    `★ 没告诉他下一步该干什么 —— 要说清去「${SILENCE_FILTER_NAME}」里${SILENCE_ACTIONS.restore}：${arch.reason}`
  )

  // 已经在轮转（没归档）
  readyLecture(r, 2)
  r.db.prepare(`update lectures set status='training', due_at=?, interval_days=7 where id=2`).run(Date.now())
  const run = study.startLearning(2)
  assert(run.refused === 'alreadyRunning', `★ 轮转中：${run.refused}`)
  assert(run.intervalDays === 7, `拒绝时也要如实报当前间隔：${run.intervalDays}`)

  // 还不是待审阅
  r.db.prepare(`update lectures set status='empty' where id=3`).run()
  const raw = study.startLearning(3)
  assert(raw.refused === 'notReviewed', `★ empty：${raw.refused}`)

  // 在垃圾箱里
  readyLecture(r, 2)
  r.db.prepare(`update lectures set status='review', deleted_at=? where id=2`).run(Date.now())
  const gone = study.startLearning(2)
  assert(gone.refused === 'missing', `★ 已删：${gone.refused}`)

  // 根本不存在的 id 也走同一条路，不许抛
  assert(study.startLearning(9999).refused === 'missing', '★ 不存在的 id 没被当成 missing')
  r.db.close()
})

check('★★ F-2-②-e · ⑩ 事务原子性：认读那一句失败 → 状态、间隔、排期全部回滚', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  readyLecture(r, 1)
  const before = snapshotAll(r.db)

  const boom = dbThatFailsOn(r.db, 'set due_at = ?, updated_at = ?')
  let threw = false
  try {
    new Study(boom, join(backups, 'prompts'), () => 'B2').startLearning(1)
  } catch {
    threw = true
  }
  assert(threw, '注入的故障没有冒出来')
  assert(snapshotAll(r.db) === before, '★ 出现了「进了轮转、认读卡却没排期」的半成品')
  r.db.close()
})

check('★ F-2-②-e · 门槛只有一份：SELECT 和 UPDATE 用的是同一个字符串', () => {
  /**
   * 这条守的是**将来**：两处各写各的话，某天有人只在其中一处加条件，
   * 另一处就会为一行根本写不进去的讲算出一份排期 ——
   * 那种错不报警，表现只是「点了没反应」。
   */
  const src = studySources()
  assert(src.includes('const GATE ='), '★ 门槛不再是一个共用常量了')
  // 从 GATE 那一行**之后**开始扫 —— 它自己当然写着 status='review'，
  // 把它算进去的话这条用例永远红，而红的是它自己
  const gateAt = src.indexOf('const GATE =')
  const body = src.slice(src.indexOf('\n', gateAt), src.indexOf('function refuseStart'))
  const inlined = body.match(/status\s*=\s*'review'/g) ?? []
  assert(
    inlined.length === 0,
    `★ startLearning 里又出现了 ${inlined.length} 处写死的 status='review' —— 门槛分家了`
  )
  assert((body.match(/\$\{GATE\}/g) ?? []).length === 2, '★ GATE 不再是被 SELECT 与 UPDATE 共用')
})

check('★★ D-296 · v34 之后生产代码不许再碰 items.card_* —— reading_cards 是唯一真相', () => {
  /**
   * ★★ 这一条守的是「双状态源」。
   *
   * V34 把认读卡搬进了 `reading_cards`，但按 D-216「只增不删」，
   * `items` 上那 6 个 `card_*` **原样留着**（冻结在迁移那一刻，作回滚来源）。
   * 于是就有了一个只会静默出错的形状：
   *
   *   **有人从 `items.card_*` 读到了冻结的旧值，而一切看起来都正常。**
   *
   * ── 为什么禁读比禁写更要紧 ────────────────────────────────
   *
   * 写错了还有救：写进冻结列，界面上那张卡就不动，人会发现。
   * **读错了没救**：读到的是迁移那一刻的旧排期，队列照常出题、
   * 数字照常显示，只是全都错了 —— 而 `check:sql` 看不出来
   * （那几个列名是真的存在的），体检也不会亮。
   *
   * 所以直接禁掉这 6 个标识符在 `src/main` 里出现，读写一起管。
   * 例外只有 `db/migrations.ts` —— 迁移就是干这个的。
   */
  const FROZEN = ['card_ease', 'card_interval', 'card_reps', 'card_lapses', 'card_due_at', 'card_silent']
  const root = join(process.cwd(), 'src', 'main')
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    .map((f) => join(root, f as string))
  const hits: string[] = []
  for (const f of files) {
    if (f.includes('migrations.ts')) continue
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1')
    for (const c of FROZEN) {
      if (new RegExp(`\b${c}\b`).test(src)) hits.push(`${f.split('src')[1]} : ${c}`)
    }
  }
  assert(
    hits.length === 0,
    `★★ 生产代码还在碰冻结的 items.card_*（v34 之后它们不再是真相）：\n  ${hits.join('\n  ')}`
  )
})

checkAsync('★★ D-296 · 每条未删除的知识点恰好有一张认读卡', async () => {
  /**
   * 拆表之前，「每条 item 都有认读状态」是**表结构**保证的
   * （`card_*` 是 `items` 上的 NOT NULL 列，行在卡就在）。
   * 拆完之后这条保证换成了两条触发器 + V34 的全量搬运。
   *
   * 少一张卡的后果是那条知识点**永远不进认读队列** —— 而且不报错
   * （查询用的是 inner join，它只是不出现）。所以要有一条会变红的用例。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const t = Date.now()
  // 本机新建那条路：insert 时没有 uid，靠 trg_items_uid 补上
  r.db
    .prepare(
      `insert into items (term, gloss, layer, kind, source, owner_lecture_id, created_at, updated_at)
       values ('a stone throw from', '', 'B', 'chunk', 'self', 1, ?, ?)`
    )
    .run(t, t)
  // 同步收下那条路：insert 时自带 uid
  r.db
    .prepare(
      `insert into items (term, gloss, layer, kind, source, owner_lecture_id, uid, created_at, updated_at)
       values ('from the remote side', '', 'A', 'chunk', 'ai', 1, 'items-remote0001', ?, ?)`
    )
    .run(t, t)

  const missing = (
    r.db
      .prepare(
        `select count(*) as n from items i
           left join reading_cards rc on rc.item_id = i.id
          where i.deleted_at is null and rc.id is null`
      )
      .get() as { n: number }
  ).n
  assert(missing === 0, `★★ 有 ${missing} 条知识点没有认读卡 —— 它们永远不会进认读队列`)

  const dup = (
    r.db
      .prepare(
        `select count(*) as n from (select item_id from reading_cards group by item_id having count(*) > 1)`
      )
      .get() as { n: number }
  ).n
  assert(dup === 0, `★★ 有 ${dup} 条知识点长出了不止一张卡`)

  const noUid = (
    r.db.prepare(`select count(*) as n from reading_cards where uid is null or uid = ''`).get() as {
      n: number
    }
  ).n
  assert(noUid === 0, `★★ 有 ${noUid} 张卡没有 uid —— 空 uid 的行永远同步不出去，而且不报错`)
  r.db.close()
})


