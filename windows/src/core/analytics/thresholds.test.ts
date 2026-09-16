import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GRADING } from '../grading.ts'
import { DEFAULT_THRESHOLDS, OWN_CALL_MARK, THRESHOLD_SOURCES, type Thresholds } from './thresholds.ts'

/**
 * T-4.12 完成标准：「『为什么』的每条规则都写着阈值来源
 *（不是拍的数就标「主控定、可调」）」。
 *
 * 这一套把那句话变成机器判据。**新加一个阈值就必须在下面表态**，
 * 否则第一条当场红 —— 不表态的阈值就是下一个「谁也说不清哪来的数」。
 */

/** 我定的（D-413：我提的规则要标出来） */
const OWN: (keyof Thresholds)[] = ['weakFails']

/** 有出处的：值 = 出处里必须出现的字样 */
const CITED: Partial<Record<keyof Thresholds, string>> = {
  windowDays: '使用者',
  lookupRepeats: '原话',
  strongStreak: 'D-017',
  topN: '使用者'
}

describe('T-4.12 · 阈值的出处', () => {
  it('每个阈值都表过态 —— 要么有出处，要么标着「主控定、可调」', () => {
    assert.deepEqual(
      Object.keys(DEFAULT_THRESHOLDS).sort(),
      [...OWN, ...Object.keys(CITED)].sort(),
      '★ 新加的阈值没在这条用例里表态'
    )
  })

  it('每个阈值都写了来源，一句都不许空', () => {
    for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
      assert.ok((THRESHOLD_SOURCES[k] ?? '').trim().length > 10, `${k} 的来源写得太短或者没写`)
    }
  })

  it('★ 拍的数必须带「★ 主控定、可调」六个字', () => {
    for (const k of OWN) {
      assert.ok(
        THRESHOLD_SOURCES[k].includes(OWN_CALL_MARK),
        `★ ${k} 是我定的数，却没标出来 —— 他会把它当成有依据的判据`
      )
    }
  })

  it('有出处的那几个，出处里指得出是哪一条', () => {
    for (const [k, token] of Object.entries(CITED) as [keyof Thresholds, string][]) {
      assert.ok(THRESHOLD_SOURCES[k].includes(token), `${k} 的来源里找不到「${token}」`)
    }
  })

  it('★★ 「稳定通过」用的就是判分那个数，不另立一份', () => {
    assert.equal(
      DEFAULT_THRESHOLDS.strongStreak,
      DEFAULT_GRADING.silenceStreak,
      '★★ 报告里的「稳」和判分的「稳」分家了 —— 同一条知识点会有两种说法'
    )
  })

  it('★ 出处是印在报告页上的文字 —— 不许带 Markdown 记号（截图上会原样露出来）', () => {
    const TICK = String.fromCharCode(96)
    for (const [k, v] of Object.entries(THRESHOLD_SOURCES)) {
      assert.ok(!v.includes('**'), `${k} 的出处里有粗体记号，页面会把星号原样印出来`)
      assert.ok(!v.includes(TICK), `${k} 的出处里有反引号，页面会把它原样印出来`)
    }
  })

  it('阈值都是正整数（页面上要印出来）', () => {
    for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) {
      assert.ok(Number.isInteger(v) && v > 0, `${k} = ${v}`)
    }
  })
})
