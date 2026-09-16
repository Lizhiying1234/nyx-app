import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleOnStart } from './start-learning.ts'
import { dueAfter } from './sm2-lecture.ts'

/**
 * ★★ F-2-② ·「开始学」按下去之后排期该变成什么
 *
 * 这一套只验判据本身。它跑得快、没有数据库、没有界面 ——
 * 所以每一条分支都能写成一句话，看得出规则长什么样。
 * 「真的落库了没有」是第 ② 档的事（tests/db-safety.ts），
 * 「他屏幕上看到的是不是这个数」是第 ③ 档的事（tests/start-learning.test.ts）。
 */

/** 固定一个「现在」—— 用 Date.now() 的话跨零点跑会莫名其妙红一次 */
const NOW = new Date('2026-08-12T10:00:00').getTime()
const TOMORROW = dueAfter(1, NOW)
const day = (n: number): number => dueAfter(n, NOW)

describe('★★ F-2-② · 开始学的排期规则', () => {
  it('A · 第一次开始学：0 → 1 天，明天到期', () => {
    const s = scheduleOnStart({ interval: 0, dueAt: null, fresh: 85, now: NOW })
    assert.equal(s.interval, 1)
    assert.equal(s.dueAt, TOMORROW)
    assert.equal(s.firstTime, true)
    assert.match(s.reason, /第一次/)
  })

  it('★★ B · 有 12 天历史、原排期还没到、这次没新条目 → 一个字都不动', () => {
    const d37 = day(25)
    const s = scheduleOnStart({ interval: 12, dueAt: d37, fresh: 0, now: NOW })
    assert.equal(s.interval, 12, '★ 12 天的间隔被打回去了 —— 那是练了 6 次才攒出来的')
    assert.equal(s.dueAt, d37, '★ 原排期被改了 —— 重新分析不是一次测验，它不该动排期')
    assert.equal(s.firstTime, false)
  })

  it('★★ C · 同上但新增了 3 条 → 间隔和排期照样不动（新条目今天就能认读）', () => {
    const d37 = day(25)
    const s = scheduleOnStart({ interval: 12, dueAt: d37, fresh: 3, now: NOW })
    assert.equal(s.interval, 12)
    assert.equal(s.dueAt, d37, '★ 为了 3 条新知识点把整个 Lecture 提前到明天 —— 那正是 F-2-② 的病')
    /**
     * ★ B-7（2026-09-14）· 这一句跟着 `reason` 的退役词一起改：「表达」→「知识点」（TM-31）。
     *   它顺带证明了那次改动**真的落在这条路上** —— 改完这条用例当场红，
     *   actual 是新那句、expected 是旧那句。
     */
    assert.match(s.reason, /3 条新知识点/)
  })

  it("★ C′ · 原排期已经过了 + 有新条目 → 推到明天（「明天」这条规则唯一适用的场合）", () => {
    const s = scheduleOnStart({ interval: 12, dueAt: day(-8), fresh: 3, now: NOW })
    assert.equal(s.interval, 12, '推迟一天不该连间隔一起丢掉')
    assert.equal(s.dueAt, TOMORROW)
    assert.match(s.reason, /先认一遍/)
  })

  it('★ 原排期已经过了 + 没有新条目 → **不许推迟**，今天就该练', () => {
    const overdue = day(-8)
    const s = scheduleOnStart({ interval: 12, dueAt: overdue, fresh: 0, now: NOW })
    assert.equal(s.dueAt, overdue, '★ 「重新分析一下」变成了把作业往后拖一天的按钮')
  })

  it('原排期正好是今天 + 有新条目 → 算到期，推到明天', () => {
    const s = scheduleOnStart({ interval: 12, dueAt: day(0), fresh: 2, now: NOW })
    assert.equal(s.dueAt, TOMORROW)
  })

  it('原排期正好是明天 + 有新条目 → 还没到，不动它（本来就是明天）', () => {
    const s = scheduleOnStart({ interval: 12, dueAt: day(1), fresh: 2, now: NOW })
    assert.equal(s.dueAt, day(1))
  })

  it('有间隔但没排期（归档时被清掉了）→ 保住间隔，明天开始', () => {
    const s = scheduleOnStart({ interval: 12, dueAt: null, fresh: 0, now: NOW })
    assert.equal(s.interval, 12)
    assert.equal(s.dueAt, TOMORROW)
    assert.equal(s.firstTime, false)
  })

  it('间隔是负数（库被外力改坏了）→ 当成没练过，不拿负数去乘', () => {
    const s = scheduleOnStart({ interval: -3, dueAt: null, fresh: 1, now: NOW })
    assert.equal(s.interval, 1)
    assert.equal(s.firstTime, true)
  })

  it('起步间隔跟着配置走（D-179 高级区能调）', () => {
    const s = scheduleOnStart(
      { interval: 0, dueAt: null, fresh: 1, now: NOW },
      { firstInterval: 2, minSample: 5, resetTo: 1 }
    )
    assert.equal(s.interval, 2)
  })

  it('★ 每一条分支都说得出为什么 —— 界面要把它原样显示给他看', () => {
    const cases = [
      { interval: 0, dueAt: null, fresh: 3, now: NOW },
      { interval: 12, dueAt: day(25), fresh: 0, now: NOW },
      { interval: 12, dueAt: day(25), fresh: 3, now: NOW },
      { interval: 12, dueAt: day(-8), fresh: 3, now: NOW },
      { interval: 12, dueAt: day(-8), fresh: 0, now: NOW },
      { interval: 12, dueAt: null, fresh: 0, now: NOW }
    ]
    for (const c of cases) {
      const r = scheduleOnStart(c)
      assert.ok(r.reason.length > 8, `这一条没话说：${JSON.stringify(c)}`)
      assert.ok(r.dueAt > 0, `算出了一个不是日子的日子：${JSON.stringify(c)} → ${r.dueAt}`)
    }
  })

  it('★ 纯函数：调一百次结果一样，也不改传进去的东西', () => {
    const input = { interval: 12, dueAt: day(25), fresh: 3, now: NOW }
    const snapshot = JSON.stringify(input)
    const first = JSON.stringify(scheduleOnStart(input))
    for (let i = 0; i < 100; i++) {
      assert.equal(JSON.stringify(scheduleOnStart(input)), first)
    }
    assert.equal(JSON.stringify(input), snapshot, '★ 它改了调用方的数据')
  })
})
