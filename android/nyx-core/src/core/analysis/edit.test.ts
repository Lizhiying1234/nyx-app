import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planItemEdit, ItemEditRefused, EDITABLE_COLUMNS } from './edit.ts'
import { staleAfterEdit } from './stale.ts'

/**
 * T-9.14 · 改词条的写入计划（见 `edit.ts` 头注）。
 *
 * ★ 这里钉的每一条，坏掉的样子都是**静默的**：
 *   留痕少一个 `field` → 改一次中文释义就把整份解析报成「过期」；
 *   「一个字没改也照写」→ 凭空推一行上云、还让解析白白失效。
 */

const CUR = { term: 'tangle up', gloss: 'to become twisted', glossZh: '缠住' }
const AT = 1_700_000_000_000

describe('T-9.14 · planItemEdit · 改了哪几列', () => {
  it('只改词条：只有 term 一列，留痕一笔', () => {
    const p = planItemEdit(CUR, { term: 'tangle with' }, AT)
    assert.deepEqual(p.columns, [{ column: 'term', value: 'tangle with' }])
    assert.equal(p.log.length, 1)
    assert.deepEqual(p.log[0], {
      field: 'term',
      was: 'tangle up',
      should: 'tangle with',
      why: '手动修改',
      at: AT
    })
    assert.equal(p.termChanged, true)
    assert.equal(p.termWas, 'tangle up')
    assert.equal(p.termNow, 'tangle with')
  })

  it('三列一起改：三笔留痕，顺序固定 term → gloss → gloss_zh', () => {
    const p = planItemEdit(CUR, { term: 'A', gloss: 'B', glossZh: 'C' }, AT)
    assert.deepEqual(
      p.columns.map((c) => c.column),
      ['term', 'gloss', 'gloss_zh']
    )
    assert.deepEqual(
      p.log.map((l) => l.field),
      ['term', 'gloss', 'gloss_zh']
    )
  })

  it('没给的键 = 这一列不动（不是清空）', () => {
    const p = planItemEdit(CUR, { gloss: 'only this' }, AT)
    assert.deepEqual(p.columns, [{ column: 'gloss', value: 'only this' }])
    assert.equal(p.termChanged, false)
  })

  it('★ 释义可以清空 —— 写错的中文释义得能删掉', () => {
    const p = planItemEdit(CUR, { glossZh: '  ' }, AT)
    assert.deepEqual(p.columns, [{ column: 'gloss_zh', value: '' }])
    assert.equal(p.log[0]!.should, '')
  })

  it('前后空白不算改动（他多打了个空格不该写一笔留痕）', () => {
    assert.throws(() => planItemEdit(CUR, { term: '  tangle up  ' }, AT), ItemEditRefused)
  })
})

describe('T-9.14 · planItemEdit · 拒绝的两种', () => {
  /**
   * ★ 用 try/catch 而不是 `assert.throws(fn)` 的返回值 ——
   *   node 的 `assert.throws` **不返回**抛出来的那个错误（返回 undefined），
   *   写成 `const e = assert.throws(...)` 会拿到 undefined，
   *   于是下面两句断言必然失败（第一版就是这样，两条红）。
   */
  const refusedBy = (fn: () => unknown): ItemEditRefused => {
    try {
      fn()
    } catch (e) {
      assert.ok(e instanceof ItemEditRefused, `抛的不是 ItemEditRefused：${String(e)}`)
      return e
    }
    assert.fail('该拒绝的没拒绝')
  }

  it('★ 词条不许空 —— 那一行字就是这条知识点本身', () => {
    const e = refusedBy(() => planItemEdit(CUR, { term: '   ' }, AT))
    assert.equal(e.why, 'empty-term')
    assert.match(e.message, /不能空/)
  })

  it('★ 一个字都没改就拒绝（否则凭空推一行上云，还让解析白白失效）', () => {
    const e = refusedBy(() =>
      planItemEdit(CUR, { term: CUR.term, gloss: CUR.gloss, glossZh: CUR.glossZh }, AT)
    )
    assert.equal(e.why, 'no-change')
  })
})

describe('T-9.14 · 留痕要接得住失效判定（两个文件之间的那条缝）', () => {
  /** 解析块都比这一笔留痕早 —— 也就是「解析写在改词之前」 */
  const blocksBefore = [
    { block: 'inSentence', updatedAt: AT - 1000 },
    { block: 'examples', updatedAt: AT - 500 }
  ]

  it('★★ 改词条 → 解析算过期（`field: term` 这个键就是为它写的）', () => {
    const p = planItemEdit(CUR, { term: 'tangle with' }, AT)
    assert.equal(staleAfterEdit(p.log, blocksBefore), true)
  })

  it('★★ 只改中文释义 → 解析**不算**过期（解析讲的仍是同一个词）', () => {
    const p = planItemEdit(CUR, { glossZh: '缠在一起' }, AT)
    assert.equal(staleAfterEdit(p.log, blocksBefore), false)
  })

  it('★★ 只改大小写 / 尾标点 → 不算过期，但**照样写下去**（他看见的要是他打的样子）', () => {
    const p = planItemEdit(CUR, { term: 'Tangle Up.' }, AT)
    assert.equal(p.columns.length, 1, '还是要写')
    assert.equal(p.termSameAfterNormalize, true, '归一之后是同一个说法')
    assert.equal(staleAfterEdit(p.log, blocksBefore), false, '★ 只改大小写不该把整份解析报成过期')
  })

  it('改完之后重写过解析 → 不再报过期（别去烦他）', () => {
    const p = planItemEdit(CUR, { term: 'tangle with' }, AT)
    assert.equal(staleAfterEdit(p.log, [{ block: 'inSentence', updatedAt: AT + 1 }]), false)
  })
})

describe('T-9.14 · 列白名单', () => {
  it('★ 只有这三列 —— 归属 / 层 / 学习史各有各的入口，不许从这里进来', () => {
    assert.deepEqual([...EDITABLE_COLUMNS], ['term', 'gloss', 'gloss_zh'])
  })

  it('★ 计划里的列名只可能来自白名单（列名绝不来自输入）', () => {
    const p = planItemEdit(CUR, { term: 'x', gloss: 'y', glossZh: 'z' }, AT)
    for (const c of p.columns) {
      assert.ok(
        (EDITABLE_COLUMNS as readonly string[]).includes(c.column),
        `列名跑出白名单了：${c.column}`
      )
    }
  })
})
