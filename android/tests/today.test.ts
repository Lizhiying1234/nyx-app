/**
 * 今日排期对照（T-1 ～ T-3）。
 *
 * 判据链：`db/today.ts` 喂数 SQL 逐字同源 `study.ts::todayPlan`；
 * 半数规则/整取/reason 直接 import core/daily-match（同一份，不是抄的）。
 * 钉三条口径：① 无到期讲次的空分支 ② pending 只数产出线
 * （B 层非句子 · new/training —— A 层/句子/silent/软删都不进）
 * ③ 目标读 user_preferences['param.dailyTarget']（缺省 35）+ 半数规则停点。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { dailyTarget, loadTodayPlan, setDailyTarget } from '../src/db/today.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

const arm = (f: Fixture, lectureId: number, dueAt: number): void => {
  f.raw
    .prepare(`update lectures set status = 'training', due_at = ? where id = ?`)
    .run(dueAt, lectureId)
}

describe('T · 今日排期', () => {
  it('T-1 · 没有到期讲次：0 条 + core 的原话', async () => {
    const f = builtDb()
    seed(f) // 讲次 status='review'，due_at 空
    const p = await loadTodayPlan(f.db)
    assert.equal(p.total, 0)
    assert.equal(p.lectures.length, 0)
    assert.equal(p.reason, '今天没有到期的 lecture')
    assert.equal(p.target, 35, '没设置过 = 默认 35（main/params DEFAULTS）')
  })

  it('T-2 · pending 只数产出线：A 层/句子/silent/软删都不进', async () => {
    const f = builtDb()
    seed(f) // 3 条 B/chunk，production_state 默认 'new'
    const t = Date.now()
    arm(f, 1, t - 1000)
    // 四个不该数的：A 层 · B 句子 · 静默 · 软删
    f.raw.prepare(`update items set layer = 'A' where id = 1`).run()
    const mk = (id: number, kind: string): void => {
      f.raw
        .prepare(
          `insert into items (id, term, gloss, layer, kind, source, created_at, updated_at)
           values (?, ?, 'g', 'B', ?, 'self', ?, ?)`
        )
        .run(id, `x-${id}`, kind, t, t)
      f.raw
        .prepare(`insert into item_lectures (item_id, lecture_id, created_at, updated_at) values (?, 1, ?, ?)`)
        .run(id, t, t)
    }
    mk(11, 'sentence')
    mk(12, 'chunk')
    f.raw.prepare(`update items set production_state = 'silent' where id = 12`).run()
    mk(13, 'chunk')
    f.raw.prepare(`update items set deleted_at = ? where id = 13`).run(t)

    const p = await loadTodayPlan(f.db)
    // 剩下能数的：item2 · item3（B/chunk/new）
    assert.equal(p.lectures.length, 1)
    assert.equal(p.lectures[0]!.pending, 2, 'A 层/句子/静默/软删全排除')
    assert.equal(p.total, 2)
  })

  it('T-3 · 目标键 + 半数规则停点（判据是 core 那份，不是抄的）', async () => {
    const f = builtDb()
    seed(f)
    const t = Date.now()
    // ★ 更正：USER 偏好在 user_preferences（同步表）；uid 是主键，测试给个占位
    f.raw
      .prepare(`insert into user_preferences (uid, key, value, created_at, updated_at) values ('t-daily', 'param.dailyTarget', '4', ?, ?)`)
      .run(t, t)
    assert.equal(await dailyTarget(f.db), 4)

    // 讲 1：3 条 pending（seed 的 B/chunk/new）；讲 2：3 条，晚到期
    arm(f, 1, t - 2000)
    f.raw
      .prepare(`insert into lectures (id, unit_id, name, status, due_at, created_at, updated_at)
                values (2, 1, 'L2', 'training', ?, ?, ?)`)
      .run(t - 1000, t, t)
    for (let id = 21; id <= 23; id++) {
      f.raw
        .prepare(`insert into items (id, term, gloss, layer, kind, source, created_at, updated_at)
                  values (?, ?, 'g', 'B', 'chunk', 'self', ?, ?)`)
        .run(id, `y-${id}`, t, t)
      f.raw
        .prepare(`insert into item_lectures (item_id, lecture_id, created_at, updated_at) values (?, 2, ?, ?)`)
        .run(id, t, t)
    }

    // 目标 4：收讲 1（剩 4 ≥ 3/2）→ 累计 3；讲 2 还差 3，只剩 1 < 1.5 → 停
    const p = await loadTodayPlan(f.db)
    assert.equal(p.lectures.length, 1)
    assert.equal(p.total, 3)
    assert.ok(p.reason.includes('停在这里'), 'reason 是 core 的原话（机制透明）')
    assert.ok(p.reason.includes('不截断'))
  })
})

/**
 * T-4 ～ T-6 · 改「今天多少条」（2026-09-01 · X-Ray 审计 F-011）
 *
 * ★ 它是 USER 偏好（`core/prefs.ts::PREF_SPECS` 白名单）→ 写进 `user_preferences`
 *   → **随同步走**。所以这一套顺带钉住「写的是那张表，不是 settings」。
 */
describe('T · 每日目标可改（F-011）', () => {
  it('T-4 · 写进 user_preferences（同步表），不是 settings', async () => {
    const f = builtDb()
    seed(f)
    const n = await setDailyTarget(f.db, 50)
    assert.equal(n, 50)
    assert.equal(await dailyTarget(f.db), 50)

    const pref = f.raw
      .prepare(`select value, uid from user_preferences where key = 'param.dailyTarget'`)
      .get() as { value: string; uid: string } | undefined
    assert.equal(pref?.value, '50')
    assert.ok(pref?.uid, '★ 必须有 uid，否则永远同步不出去')

    const st = f.raw.prepare(`select value from settings where key = 'param.dailyTarget'`).get()
    assert.equal(st, undefined, '★ 不许写进 settings —— 那张表不同步（D-290 USER/DEVICE 分家）')
  })

  it('T-5 · 越界与非数拒绝，且什么都不写', async () => {
    const f = builtDb()
    seed(f)
    for (const bad of [0, 4, 301, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(() => setDailyTarget(f.db, bad as number), /目标条数要在/)
    }
    assert.equal(await dailyTarget(f.db), 35, '拒绝之后还是默认值')
  })

  it('T-6 · 改完之后半数规则用的就是新目标', async () => {
    const f = builtDb()
    seed(f) // 3 条 B/chunk 在 lecture 1
    const t = Date.now()
    arm(f, 1, t - 1000)

    await setDailyTarget(f.db, 5)
    const p = await loadTodayPlan(f.db)
    assert.equal(p.target, 5)
    assert.equal(p.total, 3, '3 条 ≤ 5，收得下')

    // 目标压到 5 以下不合法；改成 5 但把 pending 撑大到 11 → 5 < 11/2 → 收不下
    for (let i = 20; i < 28; i++) {
      f.raw
        .prepare(
          `insert into items (id, term, gloss, layer, kind, source, created_at, updated_at)
           values (?, ?, 'g', 'B', 'chunk', 'self', ?, ?)`
        )
        .run(i, `w-${i}`, t, t)
      f.raw
        .prepare(`insert into item_lectures (item_id, lecture_id, created_at, updated_at) values (?, 1, ?, ?)`)
        .run(i, t, t)
    }
    const p2 = await loadTodayPlan(f.db)
    assert.equal(p2.total, 0, '5 < 11/2 —— 半数规则停在这里，一条都不收')
    assert.match(p2.reason, /只剩 5 条额度/)

    await setDailyTarget(f.db, 30)
    const p3 = await loadTodayPlan(f.db)
    assert.equal(p3.total, 11, '★ 改了目标，同一批数据就收得下了')
  })
})
