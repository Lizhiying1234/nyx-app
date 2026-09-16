import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLoose } from './json-repair.ts'

/**
 * I-115 · 被截断的 JSON 要能救回前面那部分。
 *
 * 这些用例的形状全部来自**他真实撞上的那两条报错**：
 *   Expected ',' or ']' after array element   → 数组里断掉
 *   Expected ',' or '}' after property value  → 属性值后断掉
 */

test('好好的 JSON 原样过，不声称修过', () => {
  const r = parseLoose<{ a: number[] }>('{"a":[1,2,3]}')
  assert.deepEqual(r.value, { a: [1, 2, 3] })
  assert.equal(r.repaired, false)
  assert.equal(r.dropped, 0)
})

test('★ 数组在某个元素之后断掉 —— 前面的全部救回来', () => {
  const raw = '{"items":[{"term":"a"},{"term":"b"},{"term":"c"'
  const r = parseLoose<{ items: { term: string }[] }>(raw)
  assert.deepEqual(
    r.value.items.map((x) => x.term),
    ['a', 'b'],
    '写了一半的那个应该被切掉，前面两个必须还在'
  )
  assert.equal(r.repaired, true)
})

test('★ 属性值之后断掉', () => {
  const r = parseLoose<{ items: { term: string; gloss?: string }[] }>(
    '{"items":[{"term":"a","gloss":"x"},{"term":"b","gloss":"y"'
  )
  assert.equal(r.value.items.length, 1)
  assert.equal(r.value.items[0]!.term, 'a')
})

test('★ 断在字符串正中间 —— 那一条整个不要，不许截出半句话', () => {
  const r = parseLoose<{ items: { term: string }[] }>(
    '{"items":[{"term":"hold sway"},{"term":"in the wa'
  )
  assert.deepEqual(r.value.items.map((x) => x.term), ['hold sway'])
})

test('字符串里的括号和引号不能被当成结构', () => {
  const r = parseLoose<{ items: { q: string }[] }>(
    '{"items":[{"q":"he said \\"a}b]c\\" there"},{"q":"x'
  )
  assert.equal(r.value.items.length, 1)
  assert.equal(r.value.items[0]!.q, 'he said "a}b]c" there')
})

test('数字结尾的截断也能切干净', () => {
  const r = parseLoose<{ items: { n: number }[] }>('{"items":[{"n":1},{"n":2},{"n":3')
  assert.deepEqual(r.value.items.map((x) => x.n), [1, 2])
})

test('顶层就是数组的写法', () => {
  const r = parseLoose<{ t: string }[]>('[{"t":"a"},{"t":"b"},{"t"')
  assert.deepEqual(r.value.map((x) => x.t), ['a', 'b'])
})

test('嵌套两层，断在内层', () => {
  const r = parseLoose<{ groups: { derived: { term: string }[] }[] }>(
    '{"groups":[{"derived":[{"term":"a"},{"term":"b"}]},{"derived":[{"term":"c"'
  )
  assert.equal(r.value.groups.length, 1)
  assert.deepEqual(r.value.groups[0]!.derived.map((x) => x.term), ['a', 'b'])
})

test('切完悬着的逗号要去掉', () => {
  const r = parseLoose<{ items: { t: string }[] }>('{"items":[{"t":"a"},')
  assert.deepEqual(r.value.items.map((x) => x.t), ['a'])
})

test('dropped 报的是真的丢了多少字符', () => {
  const raw = '{"items":[{"t":"a"},{"t":"bbbb'
  const r = parseLoose<{ items: unknown[] }>(raw)
  assert.ok(r.dropped > 0 && r.dropped < raw.length, `dropped=${r.dropped}`)
})

test('★ 根本不是 JSON 就老实抛错 —— 不许硬凑出一个空结果', () => {
  assert.throws(() => parseLoose('对不起，我不能回答这个问题。'))
  assert.throws(() => parseLoose(''))
})

test('键名后面断掉（还没轮到值）—— 那一条不要', () => {
  const r = parseLoose<{ items: { t: string }[] }>('{"items":[{"t":"a"},{"t":')
  assert.deepEqual(r.value.items.map((x) => x.t), ['a'])
})
