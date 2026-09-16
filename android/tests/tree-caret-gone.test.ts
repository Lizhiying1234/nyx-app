/**
 * 钉住一条**使用者的裁决**：树上没有折叠符号，但收得起来（2026-09-09）
 *
 * ── 为什么需要一道闸 ────────────────────────────────────────
 * 这不是一个 bug 修复，是一个**取舍**：项目行 / 单元行上那个箭头本来是
 * 「展开 / 收起」的记号（展开时转 90°），我动手前提过后果 ——
 * 删掉之后屏上看不出这一行能展开，得点一下才知道 —— 使用者答「真的删掉」。
 *
 * 取舍最容易被下一个会话当成 bug 补回去：他看到「一个能展开的行却没有折叠记号」，
 * 顺手就加一个箭头，而且**看起来还像是在修东西**。
 * DESIGN_SYSTEM §17.1 第 06 条「折叠状态要看得见」正好会给他背书。
 * 所以把裁决钉在这里：要改，先来改这道闸，改的时候就会看见这段话。
 *
 * ── 同一条在 Windows 那边也钉了 ──────────────────────────────
 * Windows 会话（claude/nyx-windows-ui-standard-314cd4 · d301c9c）用
 * `[data-testid^="car-"]` 计数必须为 0 钉的同一件事，并建议两端都加。
 * 两端各钉各的实现，钉的是同一个裁决。
 *
 * ── 这道闸**不**保证什么 ────────────────────────────────────
 * 它不保证「展开还能用」——那是 `store.toggle` 的事，由别处的用例与真机管。
 * 这里只保证**两件同时成立**：符号没了 · 切换还在。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ATLAS = readFileSync(join(ROOT, 'src/ui/views/Atlas.svelte'), 'utf8')
const CSS = readFileSync(join(ROOT, 'src/ui/styles/mobile.css'), 'utf8')

/** 注释里提这件事是应该的（那正是记录裁决的地方），扫之前剥掉 */
function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

describe('TREE · 树上没有折叠符号，但收得起来（使用者 2026-09-09 裁）', () => {
  const body = stripComments(ATLAS)

  it('TREE-1 · 项目 / 单元行上没有折叠记号', () => {
    assert.equal(
      (body.match(/\bcar2\b/g) ?? []).length,
      0,
      '树上又出现了折叠记号 —— 这是使用者 2026-09-09 明确删掉的（他提过后果之后仍要删）。\n' +
        '    要加回去先来改这道闸，并且请他重新裁一次。'
    )
  })

  it('TREE-2 · 折叠**功能**必须还在（删的是记号，不是能力）', () => {
    assert.match(body, /store\.toggle\(pk\)/, '项目行的展开 / 收起没了 —— 删记号不许把功能一起删')
    assert.match(body, /store\.toggle\(uk\)/, '单元行的展开 / 收起没了 —— 同上')
    assert.match(body, /store\.isOpen\(pk\)/, '展开状态没人读了')
  })

  it('TREE-3 · 死样式不许留（类名没人用了，规则也该走）', () => {
    assert.equal(
      (stripComments(CSS).match(/\.car2\b/g) ?? []).length,
      0,
      'mobile.css 里还留着 .car2 的规则，而没有任何调用点 —— 死样式'
    )
  })
})
