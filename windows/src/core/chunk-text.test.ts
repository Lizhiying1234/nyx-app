import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHUNK_LIMIT, chunkCount, chunkText } from './chunk-text.ts'

const para = (n: number, ch = 'a'): string => ch.repeat(n)

test('短的原样一段，不切', () => {
  assert.deepEqual(chunkText('hello world', 6000), ['hello world'])
})

test('空的返回空数组 —— 不许返回 [""]', () => {
  assert.deepEqual(chunkText('   \n\n  '), [])
})

test('★ 切完之后每一段都不超过上限', () => {
  const text = Array.from({ length: 20 }, (_, i) => `${para(900)}${i}.`).join('\n\n')
  const out = chunkText(text, 3000)
  assert.ok(out.length > 1, '这么长还没切开')
  for (const c of out) assert.ok(c.length <= 3000, `有一段 ${c.length} 字符，超了`)
})

test('★ 一个字都不能丢', () => {
  const text = Array.from({ length: 12 }, (_, i) => `段落 ${i} ${para(500)}`).join('\n\n')
  const out = chunkText(text, 2000)
  const back = out.join('').replace(/\s/g, '')
  assert.equal(back, text.replace(/\s/g, ''), '拼回去和原文对不上 —— 切的时候吃掉了内容')
})

test('优先在空行处切，不在句子中间', () => {
  const text = ['第一段。' + para(1200), '第二段。' + para(1200), '第三段。' + para(1200)].join('\n\n')
  const out = chunkText(text, 1400)
  for (const c of out) {
    assert.ok(/^第[一二三]段。/.test(c.trim()), `切在了段落中间：${c.slice(0, 30)}`)
  }
})

test('★ 单个段落自己就超长 → 在句末切', () => {
  const one = Array.from({ length: 30 }, (_, i) => `This is sentence ${i} with some words.`).join(' ')
  const out = chunkText(one, 400)
  assert.ok(out.length > 1)
  for (const c of out) assert.ok(c.length <= 400, `${c.length} 超了`)
  // 除了最后一段，其余都应该以句号收尾
  for (const c of out.slice(0, -1)) assert.match(c.trim(), /\.$/, `没切在句末：「${c.slice(-40)}」`)
})

test('★ 整篇一个句号都没有 → 硬切，不许卡住', () => {
  const out = chunkText(para(5000), 1000)
  assert.ok(out.length >= 5, `只切出 ${out.length} 段`)
  for (const c of out) assert.ok(c.length <= 1000)
})

test('小段会被并回去 —— 别切得比需要的更碎（段数越多越费钱）', () => {
  const text = Array.from({ length: 20 }, (_, i) => `短段 ${i}`).join('\n\n')
  const out = chunkText(text, 2000)
  assert.equal(out.length, 1, `本来一段装得下，却切成了 ${out.length} 段`)
})

test('★ D-266 · 不到上限不切，刚过上限就切', () => {
  assert.equal(chunkText(para(CHUNK_LIMIT)).length, 1, '正好 6000 不该切')
  assert.ok(chunkText(para(CHUNK_LIMIT + 1)).length > 1, '刚过 6000 却没切')
})

/**
 * ★ D-266 的两条判据，写成用例。
 * 「段数 = 下界，最多多两段」是**规则本身** —— 规则写在决议里，
 * 判据要在这儿，否则下一轮很容易被「优化」成别的样子而没人发现。
 */
test('★ D-266 · 段数落在下界，最多多两段；每段都不超上限', () => {
  for (const total of [7000, 12000, 24379, 28189, 60000]) {
    const k = Math.ceil(total / 240)
    const text = Array.from({ length: k }, (_, i) => `P${i}. ${para(230)}`).join('\n\n')
    const out = chunkText(text)
    const floor = chunkCount(text.length)
    assert.ok(
      out.length >= floor && out.length <= floor + 2,
      `${text.length} 字符切成 ${out.length} 段，下界 ${floor} —— 规则说最多多两段`
    )
    for (const c of out) assert.ok(c.length <= CHUNK_LIMIT, `有一段 ${c.length} 字符，超上限了`)
  }
})

test('★ D-266 · 段长要均匀，不许留几百字的尾巴（一段就是一次 AI 调用）', () => {
  const text = Array.from({ length: 120 }, (_, i) => `Paragraph ${i}. ${para(230)}`).join('\n\n')
  const out = chunkText(text)
  assert.ok(out.length > 1)
  const lens = out.map((c) => c.length)
  assert.ok(
    Math.min(...lens) > Math.max(...lens) * 0.5,
    `最短 ${Math.min(...lens)} / 最长 ${Math.max(...lens)} —— 差太多，说明退回成了「装满 + 一个短尾巴」`
  )
})
