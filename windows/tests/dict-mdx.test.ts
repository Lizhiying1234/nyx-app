import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mdict } from '../src/main/dict/mdict.ts'
import {
  decompressBlock,
  probeMdict,
  readKeys,
  readRecordIndex
} from '../src/main/dict/mdict-header.ts'
import { identityOf } from '../src/core/dict/mdx-header.ts'
import { writeMdx, encodeGbk } from './make-mdx.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 第 ② 档 · D5.1b · GBK 走完整条解析路（2026-08-20）
 *
 * ★★★ 为什么不能拿他那 22 本验：
 *   22 本里只有一本声明 GBK（朗文插图版），而那本正文 27.3 MB 里
 *   **一个 >= 0x80 的字节都没有**。GBK 解错解对，在他现有词典上完全看不出来。
 *   所以这一档必须自己造字节 —— 见 `make-mdx.ts` 开头。
 *
 * 判据不是「解出来有中文」，是**两本内容一样、编码不同的词典读出来一模一样**：
 * 编码这件事对上层应该是**透明**的。
 */

const ENTRIES = [
  { word: 'brunt', body: '<b>brunt</b> n. 冲击；主要的压力。' },
  { word: 'sway', body: '<b>sway</b> v. 摇摆，动摇；支配。' },
  { word: 'resilient', body: '<b>resilient</b> adj. 有韧性的，能恢复的。' },
  { word: '词典', body: '收词并解释词义的书，例如《朗文》。' },
  { word: 'zebra', body: '<b>zebra</b> n. 斑马（非洲的一种马科动物）。' }
]

let dir = ''
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'nyx-mdx-'))
})
after(() => {
  keepOrClean(dir)
})

describe('D5.1b · 自造的 GBK 词典', () => {
  it('★★★ 造出来的文件里是真的 GBK 字节 —— 按 UTF-8 解一定乱码', () => {
    const f = writeMdx(join(dir, 'gbk.mdx'), ENTRIES, { encoding: 'GBK', title: 'GBK 样本' })
    const bytes = readFileSync(f)
    /**
     * ★ 这一条守的是**这套测试本身**：
     *   fixture 要是不小心全是 ASCII（他那本真 GBK 就是这样），
     *   下面所有用例都会绿，而 GBK 那条路一次都没被走到。
     */
    assert.ok(bytes.some((b) => b >= 0x80), '★★★ fixture 里没有一个高位字节 —— 那它验不了 GBK')
    const cn = encodeGbk('冲击')
    assert.ok(cn.toString('utf8').includes('\uFFFD'), '★★★ 这串 GBK 字节居然是合法 UTF-8？换几个字')
  })

  for (const version of ['2.0', '1.2'] as const) {
    it(`v${version} · 英文词条读出来带中文释义`, () => {
      const f = writeMdx(join(dir, `gbk-${version}.mdx`), ENTRIES, { encoding: 'GBK', version })
      const d = Mdict.open(f)
      try {
        assert.match(d.rawOf('brunt') ?? '', /冲击/)
        assert.match(d.rawOf('sway') ?? '', /摇摆，动摇/)
        assert.match(d.rawOf('zebra') ?? '', /斑马（非洲的一种马科动物）。/)
        assert.equal((d.rawOf('brunt') ?? '').includes('\uFFFD'), false, '★★ 读出来带替换符 = 解错了')
      } finally {
        d.close()
      }
    })

    it(`v${version} · 中文词目本身也要能查到（词表那一段的解码）`, () => {
      const f = writeMdx(join(dir, `gbk-key-${version}.mdx`), ENTRIES, { encoding: 'GBK', version })
      const d = Mdict.open(f)
      try {
        assert.match(d.rawOf('词典') ?? '', /收词并解释词义的书/)
        assert.ok([...d.keys()].includes('词典'), `词表里没有「词典」：${[...d.keys()].join(' ')}`)
      } finally {
        d.close()
      }
    })

    it(`★★ v${version} · 同样的内容，GBK 那本和 UTF-8 那本读出来一模一样`, () => {
      const g = writeMdx(join(dir, `same-gbk-${version}.mdx`), ENTRIES, { encoding: 'GBK', version })
      const u = writeMdx(join(dir, `same-utf8-${version}.mdx`), ENTRIES, { encoding: 'UTF-8', version })
      assert.notEqual(readFileSync(g).length, 0)
      assert.notDeepEqual(readFileSync(g), readFileSync(u), '两个文件字节应该不同，否则没在验编码')
      const a = Mdict.open(g)
      const b = Mdict.open(u)
      try {
        for (const e of ENTRIES) {
          assert.equal(a.rawOf(e.word), b.rawOf(e.word), `「${e.word}」两本读出来不一样`)
          assert.equal(a.lookup(e.word), b.lookup(e.word), `「${e.word}」压平之后不一样`)
        }
        assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort())
      } finally {
        a.close()
        b.close()
      }
    })
  }
})

describe('D5.1b · 体检那条路（设置页上的话是它说的）', () => {
  it('声明 GBK → 认出来是 gbk，而且词表解得对', () => {
    const f = writeMdx(join(dir, 'probe.mdx'), ENTRIES, { encoding: 'GBK', title: '样本' })
    const p = probeMdict(f)
    assert.equal(p.ok, true)
    if (!p.ok) return
    assert.equal(p.declaredEncoding, 'GBK')
    assert.equal(p.encoding, 'gbk')
    assert.equal(p.numEntries, ENTRIES.length)
    const words: string[] = []
    const r = readKeys(f, p, (w) => {
      words.push(w)
    })
    assert.equal(r.ok, true)
    assert.deepEqual(words.sort(), ENTRIES.map((e) => e.word).sort())
  })

  it('★★ 读词那条路和体检那条路对同一本书的编码判断必须一致', () => {
    /**
     * D5.1b 之前这两条**给的答案不一样**：设置页说 GBK，读词按 UTF-8 解。
     * 两句话都是软件自己说的，互相打架，而且谁都不报错。
     */
    const f = writeMdx(join(dir, 'agree.mdx'), ENTRIES, { encoding: 'GBK' })
    const p = probeMdict(f)
    assert.equal(p.ok && p.encoding, 'gbk')
    const d = Mdict.open(f)
    try {
      // 读词那条路的编码是私有的 —— 用**结果**证明它也走了 gbk
      assert.match(d.rawOf('brunt') ?? '', /冲击/)
    } finally {
      d.close()
    }
  })
})

/**
 * ★★★ T-4.15 第一段（2026-09-07）· 两条路读的是同一份头
 *
 * ── 它挡的是什么 ──────────────────────────────────────────
 *
 * 同一段头有两条路要读：体检那条（`probeMdict`，廉价、不建索引）与读词那条
 * （`Mdx`，建索引取正文）。分工是有意的，**但「头里哪几个字节是什么」原来各写一遍**，
 * 同源只写在注释里（`mdx.ts` 那句「取法逐项同源」）。
 *
 * 上一次它漂的时候是这样的：GBK 补上之前，设置页说「这本是 GBK」而正文按 UTF-8 解 ——
 * 两句话都是软件自己说的，互相打架，谁都不报错（D5.1b 两处各修一次）。
 * 那次之后只有**编码判断**收进了 `encoding.ts`；身份原料那一半到 T-4.15 才收。
 *
 * ── 为什么钉的是「身份原料」而不是「查得出词」 ★★ ─────────
 *
 * 身份取错的症状不是查不出词，是**换一台机器算出来的 uid 对不上**：
 * 同一本词典在两台机器上成了两本，排序、默认本、启用状态全跟着分叉，
 * 而两边都跑得通、都不报错。所以这里逐项比 `DictIdentityInput` 的七个分量，
 * 不是比「能不能查到 brunt」。
 */
describe('★★ T-4.15 · 体检那条路与读词那条路读的是同一份头', () => {
  for (const version of ['1.2', '2.0'] as const) {
    for (const encoding of ['UTF-8', 'GBK', 'UTF-16'] as const) {
      it(`${version} · ${encoding}：身份原料七个分量逐项相同`, () => {
        const f = writeMdx(join(dir, `head-${version}-${encoding}.mdx`), ENTRIES, {
          encoding,
          version,
          title: '对拍样本'
        })
        const p = probeMdict(f)
        assert.equal(p.ok, true, '体检那条路没读出来')
        if (!p.ok) return
        const d = Mdict.open(f)
        try {
          assert.deepEqual(
            identityOf(p),
            d.identity,
            '★★ 两条路对同一本书的身份原料不一样 —— 换台机器 uid 就对不上，而且什么都不报'
          )
          // 编码那一半（D5.1b 收的）也一起钉住：两条路必须说同一句话
          assert.equal(p.encoding, encoding === 'UTF-8' ? 'utf8' : encoding === 'GBK' ? 'gbk' : 'utf16le')
        } finally {
          d.close()
        }
      })
    }
  }

  it('★ 身份的七个分量一个都不许少（规格表变了这条会红）', () => {
    const f = writeMdx(join(dir, 'head-parts.mdx'), ENTRIES, { encoding: 'UTF-8', title: '分量' })
    const p = probeMdict(f)
    assert.equal(p.ok, true)
    if (!p.ok) return
    assert.deepEqual(Object.keys(identityOf(p)).sort(), [
      'blockCount', 'encoding', 'entryCount', 'format', 'formatVersion', 'indexBytes', 'title'
    ])
  })

  it('★★ formatVersion 是头里的**原字符串**，不是 parseFloat 之后的数', () => {
    const f = writeMdx(join(dir, 'head-ver.mdx'), ENTRIES, { encoding: 'UTF-8', version: '2.0' })
    const p = probeMdict(f)
    assert.equal(p.ok, true)
    if (!p.ok) return
    assert.equal(
      identityOf(p).formatVersion,
      '2.0',
      '★★ 取成 "2" 照样跑得通、照样算得出 uid —— 只是和另一台机器上算的对不上'
    )
  })

  it('★★ indexBytes 取的是词条块段（keyBlocksLen），不是 keyInfo 的长度', () => {
    const f = writeMdx(join(dir, 'head-idx.mdx'), ENTRIES, { encoding: 'UTF-8' })
    const p = probeMdict(f)
    assert.equal(p.ok, true)
    if (!p.ok) return
    assert.equal(identityOf(p).indexBytes, p.keyBlocksLen)
    assert.notEqual(identityOf(p).indexBytes, p.keyIndexCompLen)
  })
})

/**
 * 第 ② 档 · D5.1c · UTF-16（2026-08-20）
 *
 * 他那 22 本里**一本 UTF-16 都没有**（全部 UTF-8，只有一本 GBK）——
 * 和 GBK 一样，这一条只能靠自造 fixture 验。
 *
 * ★★★ 这次挡的两个病都**不报错**：
 *   · 正文按「第一个 0 字节」切 → `brunt` 只剩一个不完整的码元，解出来是空串。
 *     屏幕上是「这个词这本没有内容」，不是任何一句错误提示。
 *   · 1.2 版的索引 pad 写死 1 → 从第二块起偏移全飞，
 *     报出来是 `offset is out of range` —— 报错报的不是真原因。
 */
describe('D5.1c · 自造的 UTF-16 词典', () => {
  it('★★★ 造出来的确实是 UTF-16 字节（不然下面全是假绿）', () => {
    const f = writeMdx(join(dir, 'u16-check.mdx'), ENTRIES, { encoding: 'UTF-16' })
    const p = probeMdict(f)
    assert.equal(p.ok, true)
    if (!p.ok) return
    assert.equal(p.declaredEncoding, 'UTF-16')
    assert.equal(p.encoding, 'utf16le')

    /**
     * ★ 直接把第一块正文解出来看**原始字节** ——
     *   `b` 必须是 `62 00`。只看「读出来对不对」证明不了文件是 UTF-16 的：
     *   万一写成了 UTF-8，读也按 UTF-8 读，一样全绿。
     */
    const blocks = readRecordIndex(f, p)!
    const fd = openSync(f, 'r')
    const raw = Buffer.alloc(blocks[0]!.compLen)
    readSync(fd, raw, 0, raw.length, blocks[0]!.fileAt)
    closeSync(fd)
    const plain = decompressBlock(raw, blocks[0]!.end - blocks[0]!.start)
    assert.ok(
      plain.includes(Buffer.from('brunt', 'utf16le')),
      '★★★ 正文里找不到 UTF-16 的 brunt —— fixture 没造成 UTF-16'
    )
    assert.equal(plain.includes(Buffer.from('brunt', 'utf8')), false, '★★★ 正文里是单字节的 brunt')
  })

  for (const version of ['2.0', '1.2'] as const) {
    it(`★★★ v${version} · 整条正文都在 —— 不是只剩第一个字母`, () => {
      const f = writeMdx(join(dir, `u16-${version}.mdx`), ENTRIES, { encoding: 'UTF-16', version })
      const d = Mdict.open(f)
      try {
        /** 判据是**逐字相等**，不是「包含」—— 被切断的样子正是「前面对、后面没了」 */
        for (const e of ENTRIES) {
          assert.equal(d.rawOf(e.word), e.body, `「${e.word}」正文对不上`)
        }
      } finally {
        d.close()
      }
    })

    it(`★★ v${version} · 同样的内容，UTF-16 那本和 UTF-8 那本读出来一模一样`, () => {
      const a = writeMdx(join(dir, `same-u16-${version}.mdx`), ENTRIES, {
        encoding: 'UTF-16',
        version
      })
      const b = writeMdx(join(dir, `same-u8-${version}.mdx`), ENTRIES, {
        encoding: 'UTF-8',
        version
      })
      assert.notDeepEqual(readFileSync(a), readFileSync(b), '两个文件字节应该不同，否则没在验编码')
      const x = Mdict.open(a)
      const y = Mdict.open(b)
      try {
        for (const e of ENTRIES) {
          assert.equal(x.rawOf(e.word), y.rawOf(e.word), `「${e.word}」两本读出来不一样`)
          assert.equal(x.lookup(e.word), y.lookup(e.word), `「${e.word}」压平之后不一样`)
        }
        assert.deepEqual([...x.keys()].sort(), [...y.keys()].sort())
      } finally {
        x.close()
        y.close()
      }
    })

    it(`v${version} · 体检那条路也要认得（设置页上的话是它说的）`, () => {
      const f = writeMdx(join(dir, `u16-probe-${version}.mdx`), ENTRIES, {
        encoding: 'UTF-16',
        version
      })
      const p = probeMdict(f)
      assert.equal(p.ok, true)
      if (!p.ok) return
      assert.equal(p.encoding, 'utf16le')
      const words: string[] = []
      const r = readKeys(f, p, (w) => {
        words.push(w)
      })
      assert.equal(r.ok, true, `词表读不出来：${JSON.stringify(r)}`)
      assert.deepEqual(
        words.sort(),
        ENTRIES.map((e) => e.word).sort()
      )
    })
  }

  it('★★ 三种编码放在一起：同样的内容，读出来必须完全一致', () => {
    const files = (['UTF-8', 'GBK', 'UTF-16'] as const).map((e) =>
      writeMdx(join(dir, `all-${e}.mdx`), ENTRIES, { encoding: e })
    )
    const ds = files.map((f) => Mdict.open(f))
    try {
      for (const e of ENTRIES) {
        const got = ds.map((d) => d.rawOf(e.word))
        assert.equal(got[0], e.body, `「${e.word}」UTF-8 那本就不对`)
        assert.equal(got[1], got[0], `「${e.word}」GBK 那本对不上`)
        assert.equal(got[2], got[0], `「${e.word}」UTF-16 那本对不上`)
      }
    } finally {
      ds.forEach((d) => d.close())
    }
  })
})

describe('D2.1 · Mdx.identity —— 身份原料从头里原样留（Android 扫描算 uid 靠它）', () => {
  it('字段与喂给 writeMdx 的原始值逐项相等，uid 是自然身份形状', async () => {
    const { Mdx } = await import('../src/core/dict/mdx.ts')
    const { dictUid } = await import('../src/core/dict/identity.ts')
    const { isNaturalUid } = await import('../src/core/identity.ts')
    const { inflateSync } = await import('node:zlib')
    const dir2 = mkdtempSync(join(tmpdir(), 'nyx-idn-'))
    try {
      const p = join(dir2, 'idn.mdx')
      writeMdx(p, [{ word: 'aa', body: 'aa!' }], {
        title: '身份样本', version: '2.0', encoding: 'UTF-8'
      })
      const bytes = readFileSync(p)
      const io = {
        open: () => ({ size: bytes.length }),
        read: (_h: unknown, at: number, len: number) =>
          new Uint8Array(bytes.subarray(at, Math.min(at + len, bytes.length))),
        close: () => {}
      }
      const m = await Mdx.open('idn.mdx', io as never, ((b: Uint8Array) =>
        new Uint8Array(inflateSync(b))) as never)
      assert.equal(m.identity.format, 'mdict')
      assert.equal(m.identity.formatVersion, '2.0')
      assert.equal(m.identity.encoding, 'UTF-8')
      assert.equal(m.identity.title, '身份样本')
      assert.equal(m.identity.entryCount, 1)
      assert.ok((m.identity.blockCount ?? 0) >= 1)
      assert.ok((m.identity.indexBytes ?? 0) > 0)
      assert.ok(isNaturalUid(dictUid(m.identity)))
      m.close()
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})
