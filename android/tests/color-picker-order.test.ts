/**
 * 钉住一个**排过一次的 bug**：拾色器的回调要**先写再关**（2026-09-13）
 *
 * ── 病长什么样 ──────────────────────────────────────────────
 * 使用者报：「我新建颜色，点击进去，我自己不能改配色」。
 * 拾色器开得出来、滑杆拖得动、预览跟着变、点「存」弹窗也关了 ——
 * **就是不写**。库里那一档的 `overrides` 永远是 `{}`。
 *
 * ── 根因 ────────────────────────────────────────────────────
 * 原来的回调是：
 *   onpick={(hex) => { picking = null; void setPartColor(pk.token, hex) }}
 * `picking = null` 会销毁 `{#if picking}` 那一整块，**后面那句就跑在已经
 * 销毁的作用域里**，于是静静地什么都没发生 —— 屏上、控制台、类型检查
 * 全都一声不吭。改成先写再关就通了。
 *
 * ── 为什么要一道闸 ──────────────────────────────────────────
 * 「关掉弹窗」写在前面看起来更顺手（先收场再干活），下一个人整理代码时
 * 极可能把它调回去，而且**调回去之后什么都不会红** ——
 * 类型对、用例绿、界面照常开合，只有那次修改悄悄丢了。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'src/ui/views/Settings.svelte'), 'utf8')

/**
 * 取一个回调的正文。
 * ★ 不做花括号配对 —— 注释里就有 `{#if picking}` 这种花括号，
 *   配对器会被它骗到（写这道闸时当场踩了一次）。改成按标记切片，
 *   再把注释剥掉，笨但不会错。
 */
function handlerOf(name: string): string {
  // ★ 先锚到 <ColorPicker —— 这一页还有别的 onpick=（SavePicker），
  //   不锚会切到那一个上去（写这道闸时当场踩了一次）。
  const anchor = SRC.indexOf('<ColorPicker')
  assert.ok(anchor >= 0, '★ 找不到 <ColorPicker')
  const block = SRC.slice(anchor, SRC.indexOf('/>', anchor))
  const at = block.indexOf(`${name}=`)
  assert.ok(at >= 0, `★ ColorPicker 上没有 ${name}`)
  let end = block.length
  for (const m of ['onpick=', 'onclear=', 'onclose=']) {
    const k = block.indexOf(m, at + name.length + 1)
    if (k >= 0 && k < end) end = k
  }
  // 注释里就有 `{#if picking}` 这种花括号，所以不做配对，切完把注释剥掉
  return block.slice(at, end).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

describe('COLORS · 拾色器的回调要先写再关（2026-09-13 排过的 bug）', () => {
  for (const [cb, call] of [
    ['onpick', 'setPartColor'],
    ['onclear', 'clearPartColor']
  ] as const) {
    it(`${cb}：${call}(…) 必须排在 picking = null 前面`, () => {
      const body = handlerOf(cb)
      const iCall = body.indexOf(call)
      const iClose = body.indexOf('picking = null')
      assert.ok(iCall >= 0, `★ ${cb} 里没有 ${call}`)
      assert.ok(iClose >= 0, `★ ${cb} 里没有关掉弹窗`)
      assert.ok(
        iCall < iClose,
        `★ ${cb} 又变成「先关再写」了 —— picking = null 会销毁 {#if picking} 那一块，\n` +
          `  后面那句 ${call} 就跑在已经销毁的作用域里，静静地什么都不发生。\n` +
          '  真机上的样子：弹窗开得出来、滑杆拖得动、点「存」也关了，就是不写。'
      )
    })
  }
})
