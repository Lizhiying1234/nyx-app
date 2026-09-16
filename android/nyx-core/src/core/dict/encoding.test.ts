import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeGbk,
  keyTerminatorBytes,
  keyTextBytes,
  pickMdictEncoding,
  trimBodyTerminator
} from './encoding.ts'

/**
 * 第 ① 档 · D5.1b · GBK（2026-08-20）
 *
 * ★★ 期望值是**手写**的，不是拿解码器跑一遍抄回来的。
 *    这几串字节我在 GB2312 码表上一个一个对过（中 D6D0 · 国 B9FA · 汉 BABA …），
 *    所以这些用例验的是「解出来对不对」，而不是「解码器跟自己一致」。
 */

describe('D5.1b · 头部声明 → 用哪种编码', () => {
  it('GB 系全都是 GBK', () => {
    for (const s of ['GBK', 'gbk', 'GB2312', 'gb2312', 'GB-2312', 'GB18030', ' gbk ']) {
      assert.equal(pickMdictEncoding(s), 'gbk', s)
    }
  })

  it('UTF-16 还是 UTF-16，没声明就是 UTF-8', () => {
    assert.equal(pickMdictEncoding('UTF-16'), 'utf16le')
    assert.equal(pickMdictEncoding('UTF-16LE'), 'utf16le')
    assert.equal(pickMdictEncoding('UTF-8'), 'utf8')
    assert.equal(pickMdictEncoding(''), 'utf8')
    assert.equal(pickMdictEncoding(undefined), 'utf8')
    assert.equal(pickMdictEncoding(null), 'utf8')
  })

  it('资源包 .mdd 不看声明 —— 键一律 UTF-16LE', () => {
    assert.equal(pickMdictEncoding('GBK', { mdd: true }), 'utf16le')
    assert.equal(pickMdictEncoding('', { mdd: true }), 'utf16le')
  })
})

describe('D5.1b · GBK 解码', () => {
  it('手写码位：中国 · 汉字 · 词典', () => {
    assert.equal(decodeGbk(new Uint8Array([0xd6, 0xd0, 0xb9, 0xfa])), '中国')
    assert.equal(decodeGbk(new Uint8Array([0xba, 0xba, 0xd7, 0xd6])), '汉字')
    assert.equal(decodeGbk(new Uint8Array([0xb4, 0xca, 0xb5, 0xe4])), '词典')
    /** 标点也在表里（一屏中文里出现最多的就是这两个） */
    assert.equal(decodeGbk(new Uint8Array([0xa3, 0xac])), '，')
    assert.equal(decodeGbk(new Uint8Array([0xa1, 0xa3])), '。')
    /** GB2312 之外、GBK 才有的扩展区第一个码位 */
    assert.equal(decodeGbk(new Uint8Array([0x81, 0x40])), '丂')
  })

  it('★★★ 同一串字节按 UTF-8 解就是乱码 —— 不修这条一定出事', () => {
    const bytes = Buffer.from([0xd6, 0xd0, 0xb9, 0xfa])
    assert.equal(decodeGbk(bytes), '中国')
    assert.ok(bytes.toString('utf8').includes('\uFFFD'), '这串字节居然是合法 UTF-8？那这条用例就白写了')
  })

  it('ASCII 原样 —— 他手上那本 GBK 看不出任何差别，就是因为这个', () => {
    const s = 'brunt <b>n.</b> the main force'
    assert.equal(decodeGbk(new Uint8Array(Buffer.from(s, 'latin1'))), s)
  })

  it('坏字节不抛，换成替换符（一本词典里有几个坏字节不该让整本读不了）', () => {
    const got = decodeGbk(new Uint8Array([0xd6, 0xd0, 0xff, 0x41]))
    assert.match(got, /^中/)
    assert.match(got, /A$/)
  })
})

describe('D5.1b · 词表的框架：GBK 和 UTF-8 一模一样', () => {
  it('结尾 NUL：只有 UTF-16 是两个字节', () => {
    assert.equal(keyTerminatorBytes('utf8'), 1)
    assert.equal(keyTerminatorBytes('gbk'), 1)
    assert.equal(keyTerminatorBytes('utf16le'), 2)
  })

  it('索引里首尾词占的字节数：UTF-16 要乘 2，GBK 不用', () => {
    // 2.0 版：长度之外还有一个结尾符（pad = 1）
    assert.equal(keyTextBytes(5, 'utf8', 1), 6)
    assert.equal(keyTextBytes(5, 'gbk', 1), 6)
    assert.equal(keyTextBytes(5, 'utf16le', 1), 12)
    // 1.2 版：没有结尾符（pad = 0）
    assert.equal(keyTextBytes(5, 'gbk', 0), 5)
    assert.equal(keyTextBytes(5, 'utf16le', 0), 10)
  })
})

/**
 * 第 ① 档 · D5.1c · UTF-16 的正文到哪儿结束（2026-08-20）
 *
 * ★★★ 这一段挡的是一个**不报错**的病：
 *   按 UTF-8 那套「找第一个 0 字节」去切 UTF-16 的正文，
 *   `brunt` 在第 2 个字节就没了 —— 屏幕上只剩一个字母，
 *   看起来像「这本词典这条写得少」，而不是像出错。
 */
describe('D5.1c · 正文的结尾 NUL', () => {
  it('UTF-8 / GBK：第一个 0 字节就是结尾', () => {
    const u = Buffer.from('abc\u0000def', 'latin1')
    assert.equal(Buffer.from(trimBodyTerminator(u, 'utf8')).toString('utf8'), 'abc')
    const g = Buffer.concat([Buffer.from([0xd6, 0xd0]), Buffer.from([0]), Buffer.from([0x41])])
    assert.equal(decodeGbk(trimBodyTerminator(g, 'gbk')), '中')
  })

  it('★★★ UTF-16：一个 0 字节不算结尾 —— 每个 ASCII 字符都自带一个', () => {
    const body = Buffer.concat([
      Buffer.from('brunt n. 冲击', 'utf16le'),
      Buffer.from([0, 0]),
      Buffer.from('下一条', 'utf16le')
    ])
    const cut = trimBodyTerminator(body, 'utf16le')
    assert.equal(Buffer.from(cut).toString('utf16le'), 'brunt n. 冲击')

    /**
     * 老那条规则会把它切成什么样 —— 写出来，免得以后有人"顺手统一一下"。
     * 第一个 0 字节是 `b`（`62 00`）的高位，切完只剩 1 个字节，
     * 连一个完整的 UTF-16 码元都不够 —— **解出来是空字符串**。
     * 也就是说他会看到「这个词这本词典没有内容」，而不是任何一句错误提示。
     */
    const naive = body.subarray(0, body.indexOf(0))
    assert.equal(naive.length, 1)
    assert.equal(naive.toString('utf16le'), '', '★ 这一行要是变了，说明 UTF-16 的字节布局我理解错了')
  })

  it('★★★ 只在偶数位上找 —— 两个字符的腰上也会出现两个 0', () => {
    /** `A` = 41 00，`Ā` = 00 01 —— 中间那两个 0 是腰，不是结尾 */
    const body = Buffer.from('AĀ', 'utf16le')
    assert.deepEqual([...body], [0x41, 0x00, 0x00, 0x01])
    assert.equal(Buffer.from(trimBodyTerminator(body, 'utf16le')).toString('utf16le'), 'AĀ')
  })

  it('没有结尾 NUL 就整段都要（最后一条正文常常没有）', () => {
    const b = Buffer.from('末尾', 'utf16le')
    assert.equal(Buffer.from(trimBodyTerminator(b, 'utf16le')).toString('utf16le'), '末尾')
    const a = Buffer.from('tail', 'utf8')
    assert.equal(Buffer.from(trimBodyTerminator(a, 'utf8')).toString('utf8'), 'tail')
  })
})
