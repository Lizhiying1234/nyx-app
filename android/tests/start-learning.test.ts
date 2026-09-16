/**
 * 「开始学」对照（SL-1 ～ SL-7）· 2026-09-01 · X-Ray 审计 F-001
 *
 * 判据链：排期算法 = `core/start-learning.ts::scheduleOnStart`（**直接 import**，
 * 两端同一份；`core-parity.test.ts` P-11 已经钉过它的输入输出）。
 * 这里钉的是**平台面**：
 *   ① 门槛（GATE）与 fresh 判据（FRESH_WHERE）读写共用，不各写一份
 *   ② 界面说的 fresh 数 == 真正被写 `due_at` 的行数（Windows 那句 `gave !== fresh` 断言的对应物）
 *   ③ 老条目的认读历史一个字不动（F-2-② 的正题）
 *   ④ 四种拒绝各自说对话
 *   ⑤ 留痕进 lecture_logs（同步表 —— 这一笔会走到电脑上）
 *
 * ★ 为什么这一套非有不可：在这个文件出现之前，Android **没有任何代码**
 *   把 `lectures.status` 写成 'training'，于是手机自建的讲永远进不了轮转。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { SILENCE_ACTIONS } from '../src/core-link.ts'
import { startLearning } from '../src/db/start-learning.ts'
import { loadTodayPlan } from '../src/db/today.ts'
import { dueCards } from '../src/db/reading.ts'
import { DEFAULT_LECTURE, dueAfter, scheduleOnStart } from '../src/core-link.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

/** seed 给每张卡都排过期了 —— 把它们打回「还没进轮转」的样子 */
const unarm = (f: Fixture): void => {
  f.raw.prepare(`update reading_cards set due_at = null, interval_days = 0, reps = 0`).run()
}

const lec = (f: Fixture): { status: string; interval_days: number; due_at: number | null } =>
  f.raw
    .prepare(`select status, interval_days, due_at from lectures where id = 1`)
    .get() as never

const cardDues = (f: Fixture): (number | null)[] =>
  (f.raw.prepare(`select due_at from reading_cards order by item_id`).all() as { due_at: number | null }[])
    .map((r) => r.due_at)

describe('SL · 开始学', () => {
  it('SL-1 · review + 有内容 → 进轮转，fresh 卡当场到期', async () => {
    const f = builtDb()
    seed(f, { items: 3 })
    unarm(f)

    const before = await loadTodayPlan(f.db)
    assert.equal(before.total, 0, '开始学之前，今日必然是 0（status 还是 review）')

    const r = await startLearning(f.db, 1)

    assert.equal(r.refused, null)
    assert.equal(r.count, 3)
    assert.equal(r.fresh, 3)
    assert.equal(lec(f).status, 'training')
    assert.deepEqual(
      cardDues(f).filter((d) => d === null),
      [],
      '★ 说好给 3 条排认读，一条都不该剩 due_at is null'
    )

    // 排期与 core 算的逐字一致（不在这里重算规则，直接问同一个函数）
    const plan = scheduleOnStart({ interval: 0, dueAt: null, fresh: 3, now: Date.now() }, DEFAULT_LECTURE)
    assert.equal(r.intervalDays, plan.interval)
    assert.equal(r.dueAt, plan.dueAt)
    assert.equal(r.reason, plan.reason)
  })

  it('SL-2 · 第一次开始学：间隔取 firstInterval，排期是明天', async () => {
    const f = builtDb()
    seed(f, { items: 2 })
    unarm(f)

    const r = await startLearning(f.db, 1)
    const L = lec(f)

    assert.equal(L.interval_days, DEFAULT_LECTURE.firstInterval)
    assert.equal(L.due_at, dueAfter(1))
    assert.equal(r.reason, '第一次开始学 —— 先过一遍认读卡，明天开始产出练习')
  })

  it('SL-3 · ★ F-2-② 正题：练出来的间隔与未到的排期，一个字都不动', async () => {
    const f = builtDb()
    seed(f, { items: 2 })
    unarm(f)
    const future = dueAfter(9)
    f.raw.prepare(`update lectures set interval_days = 12, due_at = ? where id = 1`).run(future)

    const r = await startLearning(f.db, 1)
    const L = lec(f)

    assert.equal(L.interval_days, 12, '重新收一批内容不产生任何「他记不记得」的证据')
    assert.equal(L.due_at, future, '原排期还没到 → 一个字都不动')
    assert.equal(r.intervalDays, 12)
    assert.match(r.reason, /间隔保持 12 天/)
    // 新条目并不吃亏：它们的认读到期日现在就给了
    assert.deepEqual(cardDues(f).filter((d) => d === null), [])
  })

  it('SL-4 · 老条目的认读历史不动 —— fresh 只数 due_at is null 的那些', async () => {
    const f = builtDb()
    seed(f, { items: 3 })
    unarm(f)
    // item 1 已经练过：给它一段自己的认读历史
    const old = dueAfter(5)
    f.raw
      .prepare(`update reading_cards set due_at = ?, interval_days = 5, reps = 4 where item_id = 1`)
      .run(old)

    const r = await startLearning(f.db, 1)

    assert.equal(r.fresh, 2, '★ 只有 2 条是新的')
    const rc1 = f.raw
      .prepare(`select due_at, interval_days, reps from reading_cards where item_id = 1`)
      .get() as { due_at: number; interval_days: number; reps: number }
    assert.equal(rc1.due_at, old, '老条目的到期日没被顶掉')
    assert.equal(rc1.interval_days, 5)
    assert.equal(rc1.reps, 4)
  })

  it('SL-5 · 四种拒绝各说各的话，并且什么都不写', async () => {
    // ① 已经在练了
    {
      const f = builtDb()
      seed(f, { items: 1 })
      f.raw.prepare(`update lectures set status = 'training', interval_days = 7 where id = 1`).run()
      const r = await startLearning(f.db, 1)
      assert.equal(r.refused, 'alreadyRunning')
      assert.equal(lec(f).interval_days, 7, '拒绝了就不许动任何东西')
    }
    // ② 已经收起来了
    {
      const f = builtDb()
      seed(f, { items: 1 })
      f.raw.prepare(`update lectures set silent = 1 where id = 1`).run()
      const r = await startLearning(f.db, 1)
      assert.equal(r.refused, 'archived')
      /**
       * ★★★ 这一行原来钉的是**字面**「收起来」（再上一版钉的是「已经静默了」）——
       *   同一个词**两轮里改了两回**，而这条断言两回都是「**别人改对了才红**」。
       *   2026-09-15 晚 D-489 把它改成「静默」时，它第三次这么红了。
       * ☞ 改成钉常量：屏上说什么由 core 定，这里只管「那句话真的用了那个词」。
       *   （B 在 Windows 侧的 `smoke:study` 上做了同一个修法。）
       */
      assert.match(r.reason, new RegExp(SILENCE_ACTIONS.shelve))
      assert.equal(lec(f).status, 'review')
    }
    // ③ 还不是待审阅
    {
      const f = builtDb()
      seed(f, { items: 1 })
      f.raw.prepare(`update lectures set status = 'empty' where id = 1`).run()
      const r = await startLearning(f.db, 1)
      assert.equal(r.refused, 'notReviewed')
      assert.equal(lec(f).status, 'empty')
    }
    // ④ 找不到 / 在回收站
    {
      const f = builtDb()
      seed(f, { items: 1 })
      f.raw.prepare(`update lectures set deleted_at = ? where id = 1`).run(Date.now())
      const r = await startLearning(f.db, 1)
      assert.equal(r.refused, 'missing')
      assert.match(r.reason, /回收站/)
    }
    // ★ 收起来优先于「已在练」—— 一条收起来过、原本在练的讲，
    //   对他有用的那句是「先放回去」，不是「已经在练了」
    {
      const f = builtDb()
      seed(f, { items: 1 })
      f.raw.prepare(`update lectures set status = 'training', silent = 1 where id = 1`).run()
      const r = await startLearning(f.db, 1)
      assert.equal(r.refused, 'archived')
    }
  })

  it('SL-6 · 留痕进 lecture_logs（同步表 —— 这一笔会走到电脑上）', async () => {
    const f = builtDb()
    seed(f, { items: 2 })
    unarm(f)
    await startLearning(f.db, 1)
    const rows = f.raw
      .prepare(`select event, detail from lecture_logs where lecture_id = 1`)
      .all() as { event: string; detail: string }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.event, 'reviewed')
    assert.match(rows[0]!.detail, /2 条排进练习/)
    // uid 触发器给它铸了跨设备身份，所以它进得了同步包
    const uid = f.raw.prepare(`select uid from lecture_logs where lecture_id = 1`).get() as {
      uid: string | null
    }
    assert.ok(uid.uid, 'lecture_logs 必须拿到 uid，否则永远同步不出去')
  })

  it('SL-7 · ★ 闭环①：开始学之后，认读队列立刻有卡（产出要等明天，这是规则不是 bug）', async () => {
    const f = builtDb()
    seed(f, { items: 4 })
    unarm(f)

    assert.equal((await dueCards(f.db, 1)).length, 0, '开始学之前 due_at 全空 —— 这就是 F-001 的表征')
    assert.equal((await loadTodayPlan(f.db)).total, 0)

    await startLearning(f.db, 1)

    assert.equal((await dueCards(f.db, 1)).length, 4, '★ 开始学之后认读队列立刻有卡')

    /**
     * ★★ 今日**还是 0**，而且这是**对的**：第一次开始学的排期是「明天」
     * （`core/start-learning.ts` 第①档；理由写在 nyx_project/docs/archive/study-flow.html 阶段④ / M-019 ——
     * 今天就考几条他连见都没见过的表达，测出来的是运气，不是产出能力）。
     * 钉住它，免得将来有人把这一格当成 bug 去「修」。
     */
    const today = await loadTodayPlan(f.db)
    assert.equal(today.lectures.length, 0, '★ 第一次开始学 = 明天才练产出，今日仍是 0（有意的）')
    assert.equal(lec(f).due_at, dueAfter(1))
  })

  it('SL-8 · ★ 闭环②：已到期 + 没有新表达 → 开始学之后今日立刻就有它', async () => {
    const f = builtDb()
    seed(f, { items: 3 })
    // 卡都练过（不 unarm）→ fresh = 0；讲次有历史且已逾期
    const past = dueAfter(-2)
    f.raw.prepare(`update lectures set interval_days = 12, due_at = ? where id = 1`).run(past)

    const r = await startLearning(f.db, 1)

    assert.equal(r.fresh, 0)
    assert.equal(lec(f).due_at, past, '逾期就是逾期，不许被「重新收一批」推后')
    assert.match(r.reason, /现在就能练/)

    const today = await loadTodayPlan(f.db)
    assert.equal(today.lectures.length, 1, '★ 这一讲现在进得了今日')
    assert.equal(today.total, 3)
  })
})
