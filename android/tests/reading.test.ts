/**
 * 认读线对照（RD-1 ～ RD-5）。
 *
 * 判据链：SM-2 四档 = core/sm2-item（direct import，Windows 65 项单测钉着）；
 * 这里钉的是 `db/reading.ts` 港来的 SQL 口径与两笔写：
 *   ① dueCards 只给到期且未静默的，按 due_at 排，limit 生效（D-229 顺延）
 *   ② testCardsByIds 静默的也给（D-030 随时测），软删不给
 *   ③ gradeCard：唯一 UPDATE 写入面只碰 reading_cards + review_logs 带
 *      device/duration（D-349/D-017）④ 静默阈值自动触发 ⑤ 忘了 = lapses+1
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { dueCards, dueCount, gradeCard, testCardsByIds } from '../src/db/reading.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

const t0 = Date.now()

/** 三张卡：1 到期 · 2 到期更早 · 3 明天才到 */
function arm(f: Fixture): void {
  const set = f.raw.prepare(
    `update reading_cards set due_at = ?, silent = 0, ease = ?, interval_days = ?, reps = ?, updated_at = ? where item_id = ?`
  )
  set.run(t0 - 1000, 2.5, 2, 1, t0, 1)
  set.run(t0 - 5000, 2.5, 4, 2, t0, 2)
  set.run(t0 + 86400000, 2.5, 1, 1, t0, 3)
}

describe('RD · 认读线', () => {
  it('RD-1 · dueCards：只给到期未静默，按 due_at 排，limit 生效', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    arm(f)
    const q = await dueCards(f.db, null, 40)
    assert.deepEqual(q.map((c) => c.id), [2, 1], '到期早的在前，明天的不来')
    assert.equal(await dueCount(f.db, null), 2)
    // 每张卡带四档预览（D-136：自评带上代价）—— 数来自 core，不在这里重算
    assert.equal(typeof q[0]!.intervals[1], 'number')

    const one = await dueCards(f.db, null, 1)
    assert.equal(one.length, 1, 'D-229 软上限：装不下的顺延，不丢')

    f.raw.prepare(`update reading_cards set silent = 1 where item_id = 2`).run()
    assert.equal(await dueCount(f.db, null), 1, '静默的不进轮转（D-024）')
  })

  it('RD-2 · testCardsByIds：静默的也给（D-030），软删不给', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    arm(f)
    f.raw.prepare(`update reading_cards set silent = 1 where item_id = 1`).run()
    f.raw.prepare(`update items set deleted_at = ? where id = 3`).run(t0)
    const q = await testCardsByIds(f.db, [1, 2, 3])
    assert.deepEqual(q.map((c) => c.id), [1, 2], '静默给、软删不给')
  })

  it('RD-3 · gradeCard：只碰 reading_cards + review_logs 带 device/duration', async () => {
    const f = builtDb()
    seed(f, { settings: { 'sync.device': 'ph-test1' } })
    arm(f)
    const itemBefore = f.raw.prepare(`select updated_at from items where id = 1`).get() as {
      updated_at: number
    }

    const r = await gradeCard(f.db, 1, 3, 1234)
    // 核心数学在 core：reps1 · grade3 → 3 天（sm2-item.intervalFor 的口径）
    assert.equal(r.intervalDays, 3)

    const card = f.raw
      .prepare(`select interval_days as d, reps, due_at from reading_cards where item_id = 1`)
      .get() as { d: number; reps: number; due_at: number }
    assert.equal(card.d, 3)
    assert.equal(card.reps, 2)
    // dueAfter 落在第 3 日**午夜**（sm2-lecture 口径）—— 下午练时距离会短于 2.5 天
    assert.ok(card.due_at > t0 + 2 * 86400000, 'due_at 真排到第 3 日')

    const log = f.raw
      .prepare(
        `select line, grade, interval_before, interval_after, duration_ms, device
           from review_logs order by id desc limit 1`
      )
      .get() as Record<string, unknown>
    assert.deepEqual(
      { ...log },
      {
        line: 'reading',
        grade: 3,
        interval_before: 2,
        interval_after: 3,
        duration_ms: 1234,
        device: 'ph-test1'
      },
      'D-017/D-349：完整记录 + device + duration'
    )

    const itemAfter = f.raw.prepare(`select updated_at from items where id = 1`).get() as {
      updated_at: number
    }
    assert.equal(itemAfter.updated_at, itemBefore.updated_at, 'D-296/D-298：items 一个字没动')
  })

  it('RD-4 · 静默阈值：间隔迈过 silenceDays → 卡自动静默', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    f.raw
      .prepare(
        `update reading_cards set due_at = ?, silent = 0, ease = 2.5, interval_days = 150, reps = 5, updated_at = ? where item_id = 1`
      )
      .run(t0 - 1000, t0)
    const r = await gradeCard(f.db, 1, 4) // 150 × 2.5 × 1.3 ≈ 488 ≥ 180
    assert.equal(r.silenced, true, r.reason)
    const rc = f.raw.prepare(`select silent from reading_cards where item_id = 1`).get() as {
      silent: number
    }
    assert.equal(rc.silent, 1)
  })

  it('RD-5 · 忘了：打回 1 天 · lapses+1 · ease 降 · reps 不清零（D-017）', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    arm(f)
    await gradeCard(f.db, 2, 1, 800)
    const rc = f.raw
      .prepare(`select interval_days as d, lapses, ease, reps from reading_cards where item_id = 2`)
      .get() as { d: number; lapses: number; ease: number; reps: number }
    assert.equal(rc.d, 1)
    assert.equal(rc.lapses, 1)
    assert.ok(rc.ease < 2.5)
    assert.equal(rc.reps, 2, '已累计的正确次数不清零')
  })
})
