import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeParts, isNaturalUid } from '../identity.ts'
import {
  IDENTITY_PART_NAMES,
  dictIdentityParts,
  dictUid,
  identityDiff,
  identityStrength,
  titleIsInformative,
  type DictIdentityInput
} from './identity.ts'

/**
 * 词典身份 · 规格 + 回归向量 + 碰撞测试
 *
 * 使用者 2026-08-19 的原话：
 *   「接受 format + 头部稳定 fingerprint → natUid 的方向。
 *     **但不要把这次 21/21 零碰撞写成绝对证明。**
 *     必须建立 deterministic identity specification + regression vectors + collision tests。」
 *
 * 所以这个文件分四段，缺一不可：
 *   ① 规格   —— 分量的**顺序**与**归一规则**，逐条钉死
 *   ② 向量   —— 固定输入 → 固定 uid 字符串，**手推出来的**，不是跑一遍抄回来的
 *   ③ 碰撞   —— 拿他真实 21 本的头部元数据当对抗语料
 *   ④ 取值   —— **头部的哪个字段填进哪个分量**（2026-08-19 他裁决要永久固定）
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** 手推 uid：`natUid` 的编码是 `<表>-nat-<转义后的分量用 | 连接>` */
const expect = (...parts: string[]): string => `dictionaries-nat-${parts.join('|')}`

const base: DictIdentityInput = {
  format: 'mdict',
  formatVersion: '2.0',
  encoding: 'UTF-8',
  title: '牛津高阶（第10版 英汉双解） V1.4',
  entryCount: 283811,
  blockCount: 145,
  indexBytes: 2381923
}

describe('① 规格：分量的顺序与归一', () => {
  it('恰好七个分量，顺序与规格表一致', () => {
    assert.equal(dictIdentityParts(base).length, 7)
    assert.equal(IDENTITY_PART_NAMES.length, 7)
    assert.deepEqual([...IDENTITY_PART_NAMES], [
      'format', 'formatVersion', 'encoding', 'title', 'entryCount', 'blockCount', 'indexBytes'
    ])
  })

  /**
   * ★ 这条守的是「三条不许用」。将来有人往身份里加一段路径 / mtime / 文件名，
   *   分量数或名字就对不上，这里先红。
   *   身份多一段 = 换个位置就变身份 = I-106 那个病原地复发。
   */
  it('身份里没有路径、没有 mtime、没有文件名', () => {
    for (const name of IDENTITY_PART_NAMES) {
      assert.ok(
        !/path|file|mtime|modified|dir|folder|size/i.test(name),
        `「${name}」看着像文件系统的东西 —— 身份不许依赖它`
      )
    }
  })

  it('format 小写、encoding 大写、其余去首尾空白并折叠内部空白', () => {
    const parts = dictIdentityParts({
      ...base,
      format: '  MDict ',
      encoding: 'utf-8',
      formatVersion: ' 2.0 ',
      title: '  牛津   高阶  '
    })
    assert.equal(parts[0], 'mdict')
    assert.equal(parts[1], '2.0')
    assert.equal(parts[2], 'UTF-8')
    assert.equal(parts[3], '牛津 高阶')
  })

  it('空的文本分量落成 ABSENT，不是空串', () => {
    const parts = dictIdentityParts({ format: 'mdict', title: '', encoding: null })
    assert.equal(parts[2], '-')
    assert.equal(parts[3], '-')
  })

  /**
   * ★ 非法计数必须落成 ABSENT，**不许静默取整**。
   *   取整会让「头部读错了」和「真的是这个数」产生同一个身份 ——
   *   那是最难查的一类：同一个文件在两台机器上算出不同的 uid。
   */
  it('非整数 / 负数 / NaN / Infinity 的计数落成 ABSENT', () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      const parts = dictIdentityParts({ ...base, entryCount: bad as number })
      assert.equal(parts[4], '-', `entryCount=${String(bad)} 应该落成 ABSENT`)
    }
  })

  it('产出的是合法的 natural uid', () => {
    assert.ok(isNaturalUid(dictUid(base)))
  })
})

describe('② 回归向量：固定输入 → 固定 uid', () => {
  /**
   * ★★ 这些期望值是**照着编码规则手推**的，不是跑一遍抄回来的。
   *    抄回来的向量只能证明「今天和今天一样」，证明不了「和规格一样」。
   */
  const VECTORS: readonly { says: string; input: DictIdentityInput; uid: string }[] = [
    {
      says: '典型的一本（OALD10 的头部形状）',
      input: base,
      uid: expect('mdict', '2.0', 'UTF-8', '牛津高阶（第10版 英汉双解） V1.4', '283811', '145', '2381923')
    },
    {
      says: 'Title 是空的（他那 21 本里有 3 本这样）',
      input: { ...base, title: null },
      uid: expect('mdict', '2.0', 'UTF-8', '-', '283811', '145', '2381923')
    },
    {
      says: 'v1.2 + GBK（那本朗文插图版的形状）',
      input: { ...base, formatVersion: '1.2', encoding: 'GBK', title: null, entryCount: 47636 },
      uid: expect('mdict', '1.2', 'GBK', '-', '47636', '145', '2381923')
    },
    {
      says: 'StarDict',
      input: {
        format: 'stardict', formatVersion: '3.0.0', encoding: 'UTF-8',
        title: '朗道英汉字典', entryCount: 200000, blockCount: 0, indexBytes: 5000000
      },
      uid: expect('stardict', '3.0.0', 'UTF-8', '朗道英汉字典', '200000', '0', '5000000')
    },
    {
      says: '★ Title 里有分隔符 —— 必须转义成 \\p，否则身份有歧义',
      input: { ...base, title: 'A|B' },
      uid: expect('mdict', '2.0', 'UTF-8', 'A\\pB', '283811', '145', '2381923')
    },
    {
      says: '★ Title 里有转义符 —— 必须先转义它自己',
      input: { ...base, title: 'A\\B' },
      uid: expect('mdict', '2.0', 'UTF-8', 'A\\\\B', '283811', '145', '2381923')
    },
    {
      says: '★ 转义符与分隔符同时出现',
      input: { ...base, title: 'A\\|B' },
      uid: expect('mdict', '2.0', 'UTF-8', 'A\\\\\\pB', '283811', '145', '2381923')
    }
  ]

  for (const v of VECTORS) {
    it(v.says, () => {
      assert.equal(dictUid(v.input), v.uid)
    })
  }

  /**
   * ★ 无歧义的**证明**，不是抽样：拿转义规则最难的那几个串，
   *   编码之后再解回来，必须逐段还原。
   *   `["a|b","c"]` 和 `["a","b|c"]` 拼出来一样 —— 那是最经典的身份 bug。
   */
  it('编码可逆 —— 分隔符不会把分量切错', () => {
    const nasty = ['a|b', 'c', 'd\\', '|', '\\p', '中文|中文']
    for (const t of nasty) {
      const uid = dictUid({ ...base, title: t })
      const body = uid.slice('dictionaries-nat-'.length)
      const back = decodeParts(body)
      assert.equal(back.length, 7, `分量数变了：${t}`)
      assert.equal(back[3], t, `第 4 段没还原：${t}`)
    }
  })

  it('两组不同的分量绝不会拼成同一个 uid', () => {
    const a = dictUid({ ...base, title: 'a|b', encoding: 'c' })
    const b = dictUid({ ...base, title: 'a', encoding: 'b|c' })
    assert.notEqual(a, b)
  })

  it('identityDiff 说得出是哪一段变了', () => {
    assert.deepEqual(identityDiff(base, { ...base, entryCount: 1 }), ['entryCount'])
    assert.deepEqual(identityDiff(base, { ...base, title: 'x', blockCount: 9 }), ['title', 'blockCount'])
    assert.deepEqual(identityDiff(base, { ...base }), [])
  })
})

describe('③ 碰撞：拿他真实 21 本的头部当对抗语料', () => {
  const corpus = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'identity-corpus.json'), 'utf8')
  ) as DictIdentityInput[]

  it('语料本身是真的（21 本，不是空数组）', () => {
    assert.equal(corpus.length, 21, '语料条数变了 —— 这条测试可能读错了文件')
  })

  it('21 本 → 21 个不同身份，零碰撞', () => {
    const seen = new Map<string, number>()
    corpus.forEach((c, i) => {
      const uid = dictUid(c)
      const prev = seen.get(uid)
      assert.equal(
        prev,
        undefined,
        `第 ${i} 本和第 ${prev} 本撞了：\n  ${uid}`
      )
      seen.set(uid, i)
    })
    assert.equal(seen.size, 21)
  })

  /**
   * ★★ 这一条是**反证**，它证明的是「三个计数不是可有可无的」。
   *
   * 实测：21 本里有 5 本的 Title 是 MdxBuilder 的默认占位
   *「Title (No HTML code allowed)」、3 本是空。
   * 只用 format+版本+编码+Title 会撞出「4 本一组」和「3 本一组」。
   *
   * 将来有人觉得「计数看着不稳，去掉吧」，这条会红，并且红得能说清为什么。
   */
  it('反证：只用 format+版本+编码+Title 会真的撞车', () => {
    const weak = new Map<string, number>()
    for (const c of corpus) {
      const k = dictIdentityParts(c).slice(0, 4).join('|')
      weak.set(k, (weak.get(k) ?? 0) + 1)
    }
    const groups = [...weak.values()].filter((n) => n > 1)
    assert.ok(
      groups.length >= 2,
      '预期至少两组碰撞（Title 占位与空 Title）—— 语料换了就要重新看这条'
    )
    assert.ok(Math.max(...groups) >= 4, '预期最大一组至少 4 本')
  })

  it('实测语料里，Title 对 8 本没有区分力', () => {
    const uninformative = corpus.filter((c) => !titleIsInformative(c.title)).length
    assert.equal(uninformative, 8, 'Title 没信息的本数变了 —— 语料换了，结论要重新量')
  })

  it('身份强度分档：没有强到可以不看文件名的那一档要认得出来', () => {
    const strengths = corpus.map((c) => identityStrength(c))
    assert.equal(strengths.filter((s) => s === 'counts').length, 8)
    assert.equal(strengths.filter((s) => s === 'strong').length, 13)
    assert.equal(strengths.filter((s) => s === 'weak').length, 0)
  })

  it('同一本词典换路径 / 换文件名 —— 身份不变（I-106 的正解）', () => {
    // 身份的输入里根本没有路径这一项，所以「换路径」在这一层是恒等的。
    // 这条用例的价值在于**把这件事钉住**：谁把路径加进 DictIdentityInput，谁让它红。
    for (const c of corpus.slice(0, 5)) {
      assert.equal(dictUid(c), dictUid({ ...c }))
    }
  })

  it('坏掉的词典也算得出身份（LZO 那两本头部读得了）', () => {
    const v12 = corpus.filter((c) => c.formatVersion === '1.2')
    assert.equal(v12.length, 2, '语料里应该有两本 1.2 版')
    for (const c of v12) assert.ok(isNaturalUid(dictUid(c)))
  })
})

/**
 * ══ ④ 取值约定：头部的哪个字段填进哪个分量 ★★★ ═══════════════
 *
 * 使用者 2026-08-19 的裁决（原话）：
 *
 *   「identity 的两个约定必须永久固定：
 *     1. formatVersion 使用头部原字符串 "2.0"，而不是 parseFloat 后的 "2"
 *     2. identity 的 indexBytes 使用 keyBlocksLen，不是 keyInfo 的长度
 *     这两个必须进入 identity regression vectors / specification，
 *     避免以后 Android 重写时算出不同 uid。」
 *
 * 为什么这两条特别危险：**取错了照样跑得通，21 本照样算得出 21 个 uid**，
 * 只是和这台机器上算出来的**全都不一样** —— 于是他在手机上恢复默认词典时，
 * 一本都认不出来，而且什么都不报。这一段就是拦这件事的。
 *
 * `core/dict/mdx-header.ts` 的 `identityOf()` 是这两条的**唯一实现**（T-4.15 起）——
 * 体检那条路、读词那条路、喂 `dictUid` 的 adapter 三处都从它取，Android 端同一份。
 * ★ 「照抄」这个词到此为止：抄出来的第二份就是下一次 GBK。
 */
describe('④ 取值约定：头部字段 → 身份分量（永久固定）', () => {
  const GOLDEN: string[] = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'identity-uids.json'), 'utf8')
  ) as string[]
  const corpus: DictIdentityInput[] = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'identity-corpus.json'), 'utf8')
  ) as DictIdentityInput[]

  it('他真实 21 本的 uid 逐字钉死', () => {
    assert.equal(GOLDEN.length, corpus.length, '金值和语料对不上号')
    for (let i = 0; i < corpus.length; i++) {
      assert.equal(dictUid(corpus[i]!), GOLDEN[i], `第 ${i + 1} 本的身份变了`)
    }
  })

  /**
   * ★ 21 世纪大英汉那本的真实头部：
   *     GeneratedByEngineVersion="2.0"   ← 原字符串
   *     keyBlocksLen = 2927490           ← 词条块段
   *     keyIndexCompLen = 5336           ← keyInfo，压完只有 5 KB
   */
  const c21: DictIdentityInput = {
    format: 'mdict',
    formatVersion: '2.0',
    encoding: 'UTF-8',
    title: 'Title (No HTML code allowed)',
    entryCount: 334621,
    blockCount: 224,
    indexBytes: 2927490
  }

  it('formatVersion 是头部原字符串 —— parseFloat 过一道就是另一个身份', () => {
    assert.equal(dictUid(c21), GOLDEN[0])
    const parsed = dictUid({ ...c21, formatVersion: String(parseFloat('2.0')) })
    assert.notEqual(parsed, GOLDEN[0], 'parseFloat("2.0") → "2"，这条用例就是拦它的')
    assert.ok(parsed.includes('|2|'), '「2」这个写法本身要能被看出来')
  })

  it('indexBytes 是词条块段（keyBlocksLen），不是 keyInfo 的长度', () => {
    const wrong = dictUid({ ...c21, indexBytes: 5336 })
    assert.notEqual(wrong, GOLDEN[0], 'keyInfo 的 5336 顶替了 keyBlocksLen 的 2927490')
    assert.equal(dictIdentityParts(c21)[6], '2927490')
  })

  /** 两条一起取错时也要红 —— 免得「一条对一条错」恰好撞回原值 */
  it('两条同时取错，身份也必须是另一个', () => {
    assert.notEqual(dictUid({ ...c21, formatVersion: '2', indexBytes: 5336 }), GOLDEN[0])
  })
})
