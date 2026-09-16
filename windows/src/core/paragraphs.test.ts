import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { paragraphs } from './paragraphs.ts'

const SENT = 'Coastal towns bear the brunt of the winter storms and the repair bills never stop. '

describe('正文自动分段 · 5.1', () => {
  it('有空行就照作者自己的分段来 —— 那是最准的信号', () => {
    const out = paragraphs('第一段。\n\n第二段。\n\n第三段。')
    assert.deepEqual(out, ['第一段。', '第二段。', '第三段。'])
  })

  it('只有单换行（PDF / 字幕粘出来的）也要分开', () => {
    const out = paragraphs('第一行\n第二行\n第三行')
    assert.equal(out.length, 3)
  })

  it('★ 一整堵墙也要分开 —— 这是使用者点名的那种', () => {
    const wall = SENT.repeat(12).trim() // 一个换行都没有
    const out = paragraphs(wall)
    assert(out.length >= 2, `没分开：只有 ${out.length} 段`)
    for (const p of out) assert(p.length <= 700, `有一段还是太长：${p.length} 字`)
  })

  /**
   * ★ 这一条是**截图之后**补的。
   * 原来阈值一律 700，于是一段 640 字、一个换行都没有的正文照样是一整块 ——
   * 界面上就是他说的那堵墙。断言写成 500 是因为再长就已经难读了。
   */
  it('★ 没有任何分段的正文，600 字左右也要拆开', () => {
    const wall = SENT.repeat(8).trim() // ≈ 620 字，一个换行都没有
    const out = paragraphs(wall)
    assert(out.length >= 2, `没分开：${out.length} 段 / ${wall.length} 字`)
    for (const p of out) assert(p.length <= 500, `还是太长：${p.length} 字`)
  })

  it('★ 但作者自己分好的段不许乱动 —— 那是最可信的信号', () => {
    const NL = String.fromCharCode(10)
    const authored = [SENT.repeat(7).trim(), SENT.repeat(7).trim()].join(NL + NL)
    assert.equal(paragraphs(authored).length, 2, '把作者写的两段拆碎了')
  })

  it('★ 一个字都不许改 —— 原文出处要能逐字找回来（M-012）', () => {
    const wall = SENT.repeat(12).trim()
    const rejoined = paragraphs(wall).join(' ')
    assert.equal(
      rejoined.replace(/\s+/g, ' '),
      wall.replace(/\s+/g, ' '),
      '分段过程中动了正文'
    )
  })

  it('断在句子边界上，不许把句子劈成两半', () => {
    for (const p of paragraphs(SENT.repeat(12).trim())) {
      assert(/[.!?。！？]$/.test(p.trim()), `这一段没断在句末：…${p.slice(-40)}`)
    }
  })

  it('缩写和小数点不算句末', () => {
    const t = ('Dr. Smith paid 3.5 million for it and never explained why he did so. ').repeat(14)
    for (const p of paragraphs(t.trim())) {
      assert(!/Dr\.$/.test(p.trim()), `断在了缩写后面：…${p.slice(-30)}`)
      assert(!/\d\.$/.test(p.trim()), `断在了小数点后面：…${p.slice(-30)}`)
    }
  })

  it('空的、只有空白的，返回空数组（不抛）', () => {
    assert.deepEqual(paragraphs(''), [])
    assert.deepEqual(paragraphs('   \n  \n '), [])
  })
})
