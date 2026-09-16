import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { escDepth, handleEsc, registerEsc } from '../src/renderer/src/esc-stack.svelte.ts'

/**
 * D-440 · Esc 栈本身的规则（`tests/esc-close.test.ts` 管的是「接线接上了没有」）
 *
 * 这三条就是从 Android 那份验过的 `backstack.svelte.ts` 搬过来的语义：
 *   ① 从栈顶往下找第一个愿意消费的 —— **最上层的先关**
 *   ② 消费了就停 —— **一次 Esc 只关一层**
 *   ③ 没人消费 = 什么都不做（Esc 在桌面端不承担导航）
 *
 * ★ 负向对照：把 `handleEsc` 里的 `return true` 去掉（让它继续往下走）
 *   → 用例 ② 当场红。
 */
describe('D-440 · Esc 栈：一次只退一层', () => {
  it('① 最上层先关', () => {
    const hit: string[] = []
    const offA = registerEsc(() => (hit.push('底'), true))
    const offB = registerEsc(() => (hit.push('顶'), true))
    handleEsc()
    assert.deepEqual(hit, ['顶'], '该是最后注册的那层先被问到')
    offA()
    offB()
  })

  it('★★ ② 消费了就停 —— 底下那层不该跟着一起关', () => {
    let bottomClosed = false
    const offA = registerEsc(() => ((bottomClosed = true), true))
    const offB = registerEsc(() => true)
    handleEsc()
    assert.equal(bottomClosed, false, '★★ 一次 Esc 关了两层 —— 这正是改之前的毛病')
    offA()
    offB()
  })

  it('③ 不愿意消费的会被跳过；全都不消费就什么也不做', () => {
    const seen: string[] = []
    const offA = registerEsc(() => (seen.push('底'), true))
    const offB = registerEsc(() => (seen.push('顶-不接'), false))
    handleEsc()
    assert.deepEqual(seen, ['顶-不接', '底'], '不消费的要继续往下找')
    offA()
    offB()
    assert.equal(handleEsc(), false, '空栈时 Esc 什么都不做')
  })

  it('④ 注销之后不再被问到（组件卸载不能留下幽灵）', () => {
    let called = 0
    const off = registerEsc(() => (called++, true))
    off()
    handleEsc()
    assert.equal(called, 0, '已经卸载的浮层还在吃 Esc')
    assert.equal(escDepth(), 0, '栈没清干净 —— 会越积越多')
  })
})
