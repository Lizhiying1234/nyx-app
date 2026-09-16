import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectAllState, toggleSelectAll } from './selection.ts'

/**
 * T-9.15 · 全选三态（判据搬自 Android T-5.18，见 `selection.ts` 头注）。
 *
 * ★ 这几条钉的都是「按钮会不会说错话」——错了不报错，只是屏幕上写着假话。
 */

describe('T-9.15 · selectAllState', () => {
  it('不在多选态 → none（按钮不出现，D-431②）', () => {
    assert.equal(selectAllState(null, [1, 2, 3]), 'none')
  })

  it('这一屏一条都没有 → none（哪怕手里还攥着选中）', () => {
    assert.equal(selectAllState([9], []), 'none')
  })

  it('空选中 → none —— 空数组本来就等于退出多选', () => {
    assert.equal(selectAllState([], [1, 2]), 'none')
  })

  it('选了一部分 → some', () => {
    assert.equal(selectAllState([1], [1, 2, 3]), 'some')
  })

  it('列表上每一条都在选中里 → all', () => {
    assert.equal(selectAllState([3, 1, 2], [1, 2, 3]), 'all')
  })

  it('★ 选中里混进了列表上没有的 id（别处删掉的那种）不影响判断', () => {
    assert.equal(selectAllState([1, 2, 3, 99], [1, 2, 3]), 'all', '★ 比的是「列表上的都选了没」，不是两个数组相等')
  })
})

describe('T-9.15 · toggleSelectAll', () => {
  it('没全选 → 全选，而且**按列表顺序**（顺序决定出题顺序，D-162）', () => {
    assert.deepEqual(toggleSelectAll([2], [3, 1, 2]), [3, 1, 2])
  })

  it('★ 已全选 → 退出多选（返回 null），不是留一个空选态', () => {
    assert.equal(toggleSelectAll([1, 2], [1, 2]), null)
  })

  it('列表是空的 → null（没有可全选的东西）', () => {
    assert.equal(toggleSelectAll([1], []), null)
  })

  it('★ 从 null 出发也能一键全选（他还没勾任何一条就点了「全选」）', () => {
    assert.deepEqual(toggleSelectAll(null, [1, 2]), [1, 2])
  })
})
