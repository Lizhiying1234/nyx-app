/**
 * RT · **回执绝不许是空串**（I-142 · 真机 2026-09-07）
 *
 * ══ 这一条查到哪一步 ═══════════════════════════════════════
 *
 * 真机报「单条重新分析做完、改词条保存成功都没有回执」。回执那条链**逐跳查过是通的**：
 *   `ItemMenu.runAnalyse` → `onwrote(msg)` → 三个宿主（详情 / 讲次 / 馆藏）
 *   各自的 Snackbar → `snacks.show(msg)`；`EditItemDialog.save` → `ondone(msg)`
 *   → `ItemMenu` 转 `onwrote` → 同上。三个宿主一个不漏，成功那句也拼不出空串。
 *
 * ★ **唯一能让「有回执」看起来像「没回执」的空档在 `analyseErrorText`**：
 *   它在两种情形下回空串（`Error` 的 `message` 是空 · `AiError` 的 `title` 是空），
 *   而 `snacks.show('')` 就是一条**空横幅** —— 屏幕上什么都没有，
 *   和「压根没回执」长得一模一样，而且没有任何东西会报。
 *
 * ★ 主链路查不出别的毛病这件事**如实写在报告里**了，没有为了交差编一个成因。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyseErrorText } from '../src/db/analyse.ts'
import { AiError } from '../src/core-link.ts'

/** 界面上的横幅只要拿到空串就是「什么都没显示」 */
const shows = (s: string): boolean => s.trim() !== ''

describe('RT · 回执文案（I-142）', () => {
  it('RT-1 · ★★ message 是空的 Error → 仍然有一句话', () => {
    const said = analyseErrorText(new Error(''))
    assert.ok(shows(said), '★★ 空串交给 Snackbar 就是一条空横幅 —— 与「没回执」无法分辨')
    assert.equal(said, '这一条没分析成 —— 原因没认出来')
  })

  it('RT-2 · 认得出原因时照旧说原因（别把这条修成「永远说兜底那句」）', () => {
    assert.equal(analyseErrorText(new Error('额度用完了')), '额度用完了')
  })

  it('RT-3 · AiError：标题在就用标题，带详情就接上', () => {
    const withDetail = new AiError({
      kind: 'offline',
      title: '连不上网',
      detail: '检查一下网络',
      actions: ['retry'],
      consecutive: 1
    })
    assert.equal(analyseErrorText(withDetail), '连不上网 —— 检查一下网络')

    const bare = new AiError({ kind: 'server', title: '服务出错了', detail: '', actions: [], consecutive: 1 })
    assert.equal(analyseErrorText(bare), '服务出错了')
  })

  it('RT-4 · ★ AiError 的标题也空了 → 还是有一句话，不落回空串', () => {
    const empty = new AiError({ kind: 'server', title: '', detail: '', actions: [], consecutive: 1 })
    assert.ok(shows(analyseErrorText(empty)), '两个字段都空也不许交出空串')
  })

  it('RT-5 · 连 Error 都不是（原生桥扔个字符串过来）→ 也有一句话', () => {
    assert.ok(shows(analyseErrorText(undefined)))
    assert.ok(shows(analyseErrorText('')))
    assert.equal(analyseErrorText('读不了'), '读不了')
  })
})
