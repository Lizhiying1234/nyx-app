/**
 * Assist 授权的三态说辞（AA-1 ～ AA-5 · T-6.7）
 *
 * ★★ 这一组盯的是**一句话说给谁听**，不是功能。
 *
 * 2026-09-06 在他机器上量出来的事实：`am force-stop` 之后
 * `enabled_accessibility_services` 变成 `null`（`am kill` 不会）——
 * 也就是说**系统会在他背后撤销无障碍授权**。代码层面没有合法的修法
 * （写那个设置要 `WRITE_SECURE_SETTINGS`，而他也明说了不要绕过系统授权），
 * 所以这一轮做的是「说清楚」。
 *
 * 而说清楚最容易犯的错只有一个：**把「系统撤销了」说成「你关了」**。
 * 两件事在界面上长得一模一样（Assist 都不工作），对他的意义却相反 ——
 * 一个是他自己的决定，一个是系统在他背后做的事。说错了他会以为是自己弄的。
 * 所以三态判定抽成纯函数，每一条用例都钉着「这句话是对谁说的」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assistSay, KEEP_ALIVE_HINT } from '../src/ui/lib/assist-auth.ts'

describe('AA · Assist 授权的三态说辞', () => {
  it('AA-1 · 他关了 → 只说关了会怎样，**一个字都不提授权**', () => {
    for (const granted of [true, false, null] as const) {
      const s = assistSay({ granted, wanted: false })
      assert.equal(s.showGrant, false, '他自己关的，不该劝他去放行')
      assert.equal(s.showKeepAlive, false)
      assert.equal(s.why, null)
      assert.ok(s.says.includes('关 ='), `granted=${granted} 时说的话不对：${s.says}`)
    }
  })

  it('AA-2 · 他要开、系统也放行 → 正常态，没有任何多余的话', () => {
    const s = assistSay({ granted: true, wanted: true })
    assert.equal(s.showGrant, false)
    assert.equal(s.showKeepAlive, false)
    assert.equal(s.why, null)
    assert.ok(s.says.includes('悬浮星'), s.says)
  })

  it('AA-3 ★ 他要开、系统撤了 → 说清原因与出路，**绝不说成「你关了」**', () => {
    const s = assistSay({ granted: false, wanted: true })
    assert.equal(s.showGrant, true, '要给「去系统里放行」')
    assert.equal(s.showKeepAlive, true, '要给「减少这种情况」')
    assert.ok(s.why, '★★ 必须说出为什么 —— 这一条红了就是又变回「只说没放行、不说为什么」')
    assert.ok(s.why!.includes('强制停止'), `原因里要点出是哪一类事件：${s.why}`)
    assert.ok(s.why!.includes('系统'), '要说清这是系统的规矩，不是 Nyx 忘了')
    // ★★★ 这一条是整组的重点
    assert.ok(!s.says.includes('你关'), `不许说成他关了：${s.says}`)
    assert.ok(!s.says.includes('还没放行'), '「还没放行」听起来像他没做 —— 事实是他做过、被撤了')
    assert.ok(s.says.includes('撤销'), `要点出是「被撤销」：${s.says}`)
  })

  it('AA-4 · 问不到（电脑上预览）→ 如实说查不到，不假装是任何一种', () => {
    const s = assistSay({ granted: null, wanted: true })
    assert.equal(s.showGrant, false, '查不到就别劝他去放行 —— 可能根本是放行着的')
    assert.equal(s.showKeepAlive, false)
    assert.equal(s.why, null)
    assert.ok(s.says.includes('查不到'), s.says)
  })

  it('AA-5 · 「减少这种情况」是建议不是承诺（措辞守卫）', () => {
    // 系统的清理策略不归我们管 —— 不许出现「就不会再掉了」这种话
    assert.ok(!KEEP_ALIVE_HINT.includes('不会再'), KEEP_ALIVE_HINT)
    assert.ok(KEEP_ALIVE_HINT.includes('少'), '说的是「少很多」，不是「不再」')
    const s = assistSay({ granted: false, wanted: true })
    assert.ok(!s.why!.includes('永远'), '不许承诺永久')
  })
})

describe('ASSIST · 授权被撤销那句话要说到点子上（2026-09-13 真机量的）', () => {
  /**
   * 使用者报「每次关闭 Nyx 再重新打开都要重新放行」。真机逐种关法量过
   * （PJE110 / ColorOS）：HOME 不掉 · am kill 不掉 ·
   * **最近任务里上滑划掉** 掉 · 一键清理 掉。
   * 也就是说他每天那个「关掉」动作，在这台 ROM 上就是强制停止。
   * 以前那句话只说「强制停止」—— 他不会把那四个字和自己的上滑联系起来。
   */
  it('① 要点出「最近任务里划掉」这个具体动作，不能只说「强制停止」', () => {
    const why = assistSay({ granted: false, wanted: true }).why ?? ''
    assert.match(why, /最近任务|划掉|清理/, '★ 又退回只说「强制停止」了 —— 他对不上自己的动作')
  })

  it('★ ② 不许暗示应用自己能修 —— 它真的不能', () => {
    const why = assistSay({ granted: false, wanted: true }).why ?? ''
    assert.match(why, /改不了|系统里再开|只能/, '★ 得说清这是系统的规矩、应用无能为力')
  })

  it('③ 「减少这种情况」要先说管用的那条（退出方式），再说有帮助的（白名单）', () => {
    const i = KEEP_ALIVE_HINT.indexOf('返回键')
    const j = KEEP_ALIVE_HINT.indexOf('白名单')
    assert.ok(i >= 0, '★ 没说退出方式 —— 那是唯一挡得住手动划掉的办法')
    assert.ok(j >= 0, '★ 白名单那条也别丢，它挡的是系统自动清理')
    assert.ok(i < j, '★ 顺序反了：白名单挡不住他自己划掉，不该排在前面')
  })
})

