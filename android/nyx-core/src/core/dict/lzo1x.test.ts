import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LzoError, lzo1xDecompress } from './lzo1x.ts'

/**
 * LZO1X 解压 · 逐个分支钉死
 *
 * ══ 夹具是**手工编出来的字节流**，不是从他词典里抠的 ★★ ═══════
 *
 * 两个理由：
 *   ① 词典是别人的作品，夹具里不放任何一段原文（D1 定的规矩）
 *   ② 手编的流能**指定走哪个分支** —— 真词典里哪条指令什么时候出现，
 *      我说了不算，测不出「这一档没写对」
 *
 * 真词典那一档由 `tests/dict-behavior.ts` 与第③档负责：
 * 他那两本 1.2 版的书能不能打开、词数对不对、查得出东西 —— 那是最终的裁判。
 *
 * ══ 怎么读这些字节 ═════════════════════════════════════════
 *
 *   首字节 > 17            开头先来一串原文，长度 = 首字节 - 17
 *   指令 < 16              一串原文，长度 = 指令 + 3（指令为 0 时用 0x00 续长）
 *   指令 ≥ 64              往回引用：长度 (t>>5)+1，距离由 t 与下一字节算
 *   `0x11 0x00 0x00`       结尾
 */

const bytes = (...xs: number[]): Uint8Array => new Uint8Array(xs)
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
const text = (u: Uint8Array): string => Buffer.from(u).toString('utf8')
/** 结尾标记 */
const EOF = [0x11, 0x00, 0x00]

describe('LZO1X · 原文', () => {
  it('开头那一串原文（首字节 > 17）', () => {
    const src = bytes(17 + 5, ...ascii('hello'), ...EOF)
    assert.equal(text(lzo1xDecompress(src)), 'hello')
  })

  it('普通的一串原文（指令 < 16，长度 = 指令 + 3）', () => {
    const src = bytes(3, ...ascii('abcdef'), ...EOF)
    assert.equal(text(lzo1xDecompress(src)), 'abcdef')
  })

  it('★ 长原文要续长：指令 0 之后用 0x00 逐个加 255', () => {
    // t = 0 → 续长：base 15 + 下一字节 10 = 25，再 +3 = 28 个原文
    const body = 'x'.repeat(28)
    const src = bytes(0, 10, ...ascii(body), ...EOF)
    assert.equal(text(lzo1xDecompress(src)), body)
  })

  it('★★ 续长里连着的 0x00 每个加 255', () => {
    /**
     * t = 0 → 两个 0x00 各加 255 = 510，再 + 15 + 1 = 526，最后 +3 = 529。
     * ★ 续长的那个尾字节**不能是 0** —— 0 会被前面那个「while 是 0 就加 255」
     *   的循环吃掉。真正的压缩器也从不这么写，这里跟着它的写法。
     */
    const body = 'y'.repeat(529)
    const src = bytes(0, 0, 0, 1, ...ascii(body), ...EOF)
    assert.equal(text(lzo1xDecompress(src)).length, 529)
  })
})

describe('LZO1X · 往回引用', () => {
  /**
   * ★★★ 距离 1 的重叠引用 —— 这是最容易写错的一处。
   *
   * 「从前面 1 个字节处拷 3 个」在 LZO 里是合法的，意思是**重复填充**。
   * 用整段搬（`copyWithin`、`set`）会得到「拷的是拷之前的内容」，
   * 结果只在**某些**词条上乱掉 —— 而且乱得很像编码问题，极难查。
   */
  it('★★★ 距离 1 的重叠：等于重复最后一个字节', () => {
    // 原文 abcd（4 字节）→ 指令 0x40：长度 (0x40>>5)+1 = 3，距离 1
    const src = bytes(17 + 4, ...ascii('abcd'), 0x40, 0x00, ...EOF)
    assert.equal(text(lzo1xDecompress(src)), 'abcdddd')
  })

  it('往回引用一段（距离 4，长度 4）', () => {
    // 距离 = 1 + ((t>>2)&7) + (next<<3)；取 t=0x60 → 长度 (0x60>>5)+1 = 4
    // (0x60>>2)&7 = 0b11000 & 7 = 0 → 距离 1；要距离 4 得 ((t>>2)&7)=3 → t=0x6C
    const src = bytes(17 + 4, ...ascii('abcd'), 0x6c, 0x00, ...EOF)
    assert.equal(text(lzo1xDecompress(src)), 'abcdabcd')
  })

  it('引用之后顺带跟着的 1~3 个原文（指令低两位）', () => {
    // 指令 0x41：低两位 = 1 → 引用之后再搬 1 个原文字节
    const src = bytes(17 + 4, ...ascii('abcd'), 0x41, 0x00, ...ascii('Z'), ...EOF)
    assert.equal(text(lzo1xDecompress(src)), 'abcddddZ')
  })
})

describe('LZO1X · 坏数据一律抛，不许静悄悄给半截', () => {
  it('★★ 截断的流：抛 LzoError，不返回半截结果', () => {
    assert.throws(() => lzo1xDecompress(bytes(17 + 5, ...ascii('hel'))), LzoError)
  })

  it('★ 往回引用越过开头 → 抛，不去读缓冲区外面的东西', () => {
    // 一上来就引用（还没有任何输出）
    assert.throws(() => lzo1xDecompress(bytes(0x40, 0x00, ...EOF)), LzoError)
  })

  it('★★ 解出来比声明的长 → 抛。声明值是块头写的，对不上就是数据坏了', () => {
    const src = bytes(17 + 5, ...ascii('hello'), ...EOF)
    assert.equal(text(lzo1xDecompress(src, 5)), 'hello')
    assert.throws(() => lzo1xDecompress(src, 3), LzoError)
  })

  it('空输入不炸', () => {
    assert.equal(lzo1xDecompress(bytes()).length, 0)
  })
})

describe('LZO1X · 声明长度', () => {
  it('给了声明长度就一次分配到位，结果一模一样', () => {
    const src = bytes(3, ...ascii('abcdef'), ...EOF)
    assert.equal(text(lzo1xDecompress(src, 6)), text(lzo1xDecompress(src)))
  })
})
