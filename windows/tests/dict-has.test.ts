import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mdict } from '../src/main/dict/mdict.ts'
import { probeMdict } from '../src/main/dict/mdict-header.ts'
import { hasKey } from '../src/main/dict/mdict-has.ts'
import { writeMdx } from './make-mdx.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 第 ① 档 · D5.2 · 「这本收没收这个词」不建全量索引也要答对（2026-08-23）
 *
 * ══ 判据只有一句 ★★★ ═══════════════════════════════════════
 *
 *   `hasKey(w)` 必须和「装载全书之后 `lookup(w)` 命中与否」**逐字相同**。
 *
 * 差一个字的后果不是慢，是**某本词典从选择器里悄悄消失** ——
 * 而他只会以为「哦，这本没收这个词」，永远不会怀疑软件。
 *
 * ══ 下面这几本 fixture 是照着真词典里**真出过问题**的形状造的 ══
 *
 * 取证阶段（scratchpad/d52-feasible）拿他真的 21 本量过：光靠
 * 「二分定位到一块」会漏，而且漏得很有规律。三种形状各造一本：
 *
 *   · 词表最后一个词目带 BOM        —— `Longman Dictionary of Common Errors`
 *     的最后一条就是 `"﻿th"`。`trim()` 把 BOM 去掉之后，那一块的「尾」
 *     变成 `th`，于是 `thankful` 被判成「不在这本里」——它明明在。
 *   · 前导标点的词目            —— `-browed` / `'a` / `.22`。词典按去掉标点的
 *     形式排序，它们躺在 `brow` 附近，而归一比较会把它们送到第 0 块。
 *   · 首尾颠倒的一块            —— `英语常用词疑难用法手册` 只有一块，
 *     首 `" a. d."` 尾 `"﻿0说明"`，归一之后首比尾还大，抽样 300 词全漏。
 *
 * 所以实现里那条规矩是死的：**块区间只用来证「有」，永远不用来证「没有」。**
 * 这几条用例就是钉住它的。
 */

let dir = ''
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'nyx-has-'))
})
after(() => {
  keepOrClean(dir)
})

/** 拿全量索引当标准答案，逐词比对 */
function agrees(file: string, words: readonly string[]): void {
  const p = probeMdict(file)
  assert.equal(p.ok, true, 'probe 都不过')
  if (!p.ok) return
  const book = Mdict.open(file)
  try {
    for (const w of words) {
      const truth = book.lookup(w) !== null
      assert.equal(hasKey(file, p, w), truth, `「${w}」：hasKey 和全量索引不一致（应为 ${truth}）`)
    }
  } finally {
    book.close()
  }
}

describe('D5.2 · hasKey 与全量索引逐字一致', () => {
  it('寻常英文词典：有的说有，没有的说没有', () => {
    const f = writeMdx(
      join(dir, 'plain.mdx'),
      [
        { word: 'brace', body: 'b1' },
        { word: 'brunt', body: 'b2' },
        { word: 'brute', body: 'b3' },
        { word: 'sway', body: 's1' },
        { word: 'zebra', body: 'z1' }
      ],
      { title: '寻常' }
    )
    agrees(f, ['brace', 'brunt', 'brute', 'sway', 'zebra', 'zzz', 'bru', '', 'brunts'])
  })

  it('大小写：查小写要找得到存成大写的那条', () => {
    const f = writeMdx(
      join(dir, 'case.mdx'),
      [
        { word: 'Brunt', body: 'b' },
        { word: 'ASIO', body: 'a' },
        { word: 'zebra', body: 'z' }
      ],
      { title: '大小写' }
    )
    agrees(f, ['brunt', 'Brunt', 'BRUNT', 'asio', 'ASIO', 'zebra'])
  })

  it('★★★ 最后一个词目带 BOM —— 二分会判「不在」，但它在', () => {
    /** `﻿` 被 `trim()` 当空白去掉，于是这一块的「尾」不再是最大值 */
    const f = writeMdx(
      join(dir, 'bom.mdx'),
      [
        { word: 'a', body: '1' },
        { word: 'thankful', body: '2' },
        { word: 'then', body: '3' },
        { word: '﻿th', body: '4' }
      ],
      { title: 'BOM', perBlock: 4 }
    )
    agrees(f, ['a', 'thankful', 'then', 'th', 'nope'])
  })

  it('★★★ 前导标点的词目：词典把它排在字母中间', () => {
    const f = writeMdx(
      join(dir, 'punct.mdx'),
      [
        { word: 'brow', body: '1' },
        { word: '-browed', body: '2' },
        { word: 'brown', body: '3' },
        { word: 'brunt', body: '4' },
        { word: "'a", body: '5' },
        { word: 'zebra', body: '6' }
      ],
      { title: '标点', perBlock: 2 }
    )
    agrees(f, ['brow', '-browed', 'brown', 'brunt', "'a", 'zebra', '-brow', 'a'])
  })

  it('★★★ 一块之内首比尾还大（归一之后）—— 整本都会被判成空', () => {
    const f = writeMdx(
      join(dir, 'inverted.mdx'),
      [
        { word: ' A. D.', body: '1' },
        { word: 'matter of fact', body: '2' },
        { word: 'once', body: '3' },
        { word: '﻿0说明', body: '4' }
      ],
      { title: '倒挂', perBlock: 8 }
    )
    agrees(f, ['a. d.', 'matter of fact', 'once', '0说明', 'nothing'])
  })

  it('GBK：中文词目也要判得对（非 ASCII 走解码那条路）', () => {
    const f = writeMdx(
      join(dir, 'gbk.mdx'),
      [
        { word: 'brunt', body: '<b>brunt</b> 冲击' },
        { word: '词典', body: '收词的书' },
        { word: '中国', body: '国家' }
      ],
      { encoding: 'GBK', title: 'GBK' }
    )
    agrees(f, ['brunt', '词典', '中国', '汉字', 'nope'])
  })

  it('UTF-16：结尾 NUL 是两个字节，切分不能按单字节来', () => {
    const f = writeMdx(
      join(dir, 'u16.mdx'),
      [
        { word: 'brunt', body: 'b' },
        { word: 'sway', body: 's' },
        { word: '斑马', body: 'z' }
      ],
      { encoding: 'UTF-16', title: 'U16' }
    )
    agrees(f, ['brunt', 'sway', '斑马', 'zebra'])
  })

  it('1.2 版（索引不压缩、位宽 4 字节、首尾词后面没有结尾符）', () => {
    const f = writeMdx(
      join(dir, 'v12.mdx'),
      [
        { word: 'brace', body: '1' },
        { word: 'brunt', body: '2' },
        { word: 'brute', body: '3' },
        { word: 'zebra', body: '4' }
      ],
      { version: '1.2', title: '1.2', perBlock: 2 }
    )
    agrees(f, ['brace', 'brunt', 'brute', 'zebra', 'nope'])
  })

  it('多块 + 跨块查找（一块装不下的时候不能只看一块）', () => {
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'.split(' ')
    const f = writeMdx(
      join(dir, 'multi.mdx'),
      words.map((w) => ({ word: w, body: w.toUpperCase() })),
      { perBlock: 2, title: '多块' }
    )
    agrees(f, [...words, 'kilo', 'alph', 'julietx'])
  })

  it('坏文件不抛异常，一律答「没有」（这一问不负责报错）', () => {
    const f = writeMdx(join(dir, 'ok.mdx'), [{ word: 'a', body: '1' }], { title: 'ok' })
    const p = probeMdict(f)
    assert.equal(p.ok, true)
    if (!p.ok) return
    assert.equal(hasKey(join(dir, '根本不存在.mdx'), p, 'a'), false)
  })
})
