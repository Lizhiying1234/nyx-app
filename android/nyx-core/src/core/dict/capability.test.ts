import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_CAPABILITIES,
  bookCapabilities,
  has,
  hasOnlyUnplayableAudio,
  intersect,
  isAudioExt,
  isImageExt,
  isPlayableAudioExt,
  normalizeCaps
} from './capability.ts'
import { diagnostics, isFatal, fromUnknownError, type DictionaryStatus } from './diagnostics.ts'
import { pickMdictEncoding } from './encoding.ts'

describe('能力：书级只算结构，不解正文', () => {
  it('Format=Html → html', () => {
    assert.ok(has(bookCapabilities({ format: 'Html' }), 'html'))
    assert.ok(!has(bookCapabilities({ format: 'Text' }), 'html'))
  })

  it('所有词典都至少有 text', () => {
    assert.ok(has(bookCapabilities({}), 'text'))
  })

  it('资源包里有 mp3 → audio；有 png → image', () => {
    const c = bookCapabilities({ resourceExtensions: ['mp3', 'png', 'css'] })
    assert.ok(has(c, 'audio'))
    assert.ok(has(c, 'image'))
  })

  /**
   * ★★ Speex 不算「有发音」。
   *    LDOCE5 的 18.4 万条发音全是 `.spx`，Chromium 解不了 ——
   *    算成有发音 = 界面画一个按下去没声音的喇叭。
   */
  it('只有 .spx 时不算有 audio', () => {
    const c = bookCapabilities({ resourceExtensions: ['spx', 'jpg'] })
    assert.ok(!has(c, 'audio'), 'Speex 不该算作可用发音')
    assert.ok(has(c, 'image'), '图片不受影响')
  })

  it('有 .spx 但没有可播格式 —— 说得出来，好挂诊断', () => {
    assert.ok(hasOnlyUnplayableAudio(['spx', 'jpg']))
    assert.ok(!hasOnlyUnplayableAudio(['spx', 'mp3']), '有一条能播就不算')
    assert.ok(!hasOnlyUnplayableAudio(['png']), '压根没音频不算')
  })

  it('内容能力算不出来 —— 那要解正文，会把 probe 的廉价毁掉', () => {
    const c = bookCapabilities({ format: 'Html', resourceExtensions: ['mp3'] })
    for (const k of ['phonetic', 'example', 'translation', 'idiom', 'etymology'] as const) {
      assert.ok(!has(c, k), `${k} 不该在书级算出来`)
    }
  })

  it('扩展名判据', () => {
    assert.ok(isPlayableAudioExt('MP3'), '大小写不敏感')
    assert.ok(!isPlayableAudioExt('spx'))
    assert.ok(isAudioExt('spx'), 'spx 是音频，只是放不了')
    assert.ok(isImageExt('SVG'))
    assert.ok(!isImageExt('mp3'))
  })
})

describe('能力集合的形状', () => {
  it('归一后是稳定顺序、无重复 —— 能直接比较、直接进库', () => {
    const a = normalizeCaps(['image', 'text', 'audio', 'text'])
    const b = normalizeCaps(['audio', 'image', 'text'])
    assert.deepEqual(a, b)
    assert.equal(new Set(a).size, a.length)
  })

  it('交集：书级没有的，条目级不许有', () => {
    assert.deepEqual(intersect(['text', 'html'], ['text', 'audio']), ['text'])
  })

  it('ALL_CAPABILITIES 覆盖全部取值 —— 漏一个归一就会静默丢掉它', () => {
    const sample = normalizeCaps([...ALL_CAPABILITIES])
    assert.equal(sample.length, ALL_CAPABILITIES.length)
  })
})

describe('诊断：每一条都要说清「为什么」和「能做什么」', () => {
  const ALL = [
    diagnostics.ready(),
    // `partial` 的话术是调用方给的 —— 这里放一句真实形状的，别拿桩去验桩
    diagnostics.partial('查词、释义、例句都正常，发音放不了。', ['text', 'example']),
    diagnostics.lzo(),
    diagnostics.encrypted(),
    diagnostics.unknownCompression(7),
    diagnostics.encoding('Big5'),
    diagnostics.corrupted(),
    diagnostics.indexError(),
    diagnostics.notADictionary('这是 macOS 压缩包带出来的附属文件'),
    diagnostics.resourceMissing(['oald10.mdd'], ['text']),
    diagnostics.speex(['text', 'image']),
    diagnostics.redirectCycle(['children', 'child', 'children']),
    diagnostics.redirectTooDeep(['a', 'b', 'c'], 8),
    diagnostics.redirectDangling('a', 'nowhere'),
    fromUnknownError(new Error('boom'))
  ]

  it('每一条都有中文的 says，且不是一句空话', () => {
    for (const d of ALL) {
      assert.ok(d.says.length >= 8, `话术太短：${d.status}`)
      assert.ok(/[一-鿿]/.test(d.says), `话术不是中文：${d.status} → ${d.says}`)
    }
  })

  /** ★ 使用者零编程经验。V8 的报错对他等于没有 */
  it('话术里不出现英文技术术语原文', () => {
    for (const d of ALL) {
      assert.ok(
        !/Attempt to access memory|undefined is not|TypeError|RangeError|ENOENT/i.test(d.says),
        `话术里漏了技术报错：${d.says}`
      )
    }
  })

  it('原始异常进 detail，不进 says', () => {
    const d = fromUnknownError(new Error('Attempt to access memory outside buffer bounds'))
    assert.ok(!d.says.includes('Attempt to access memory'))
    assert.equal(d.detail, 'Attempt to access memory outside buffer bounds')
  })

  it('认不出来就说认不出来，绝不猜', () => {
    const d = fromUnknownError('某种没见过的错')
    assert.ok(/还没认出来/.test(d.says), '猜错的诊断比没有诊断更糟')
  })

  /** `PARTIAL` / `MEDIA_UNAVAILABLE` 说了「部分可用」就必须说「哪部分」 */
  it('降级的诊断必须带 degradedTo', () => {
    for (const d of ALL) {
      if (d.status === 'PARTIAL' || d.status === 'MEDIA_UNAVAILABLE' || d.status === 'RESOURCE_MISSING') {
        assert.ok(Array.isArray(d.degradedTo), `${d.status} 没说还剩哪些能力`)
      }
    }
  })

  it('致命与不致命分得清', () => {
    const fatal: DictionaryStatus[] = [
      'UNSUPPORTED_FORMAT', 'CORRUPTED', 'INDEX_ERROR', 'ENCODING_ERROR', 'NOT_A_DICTIONARY'
    ]
    /**
     * ★ `REDIRECT_BROKEN` 是**条目级**的：这个词的跳转坏了，
     *   这本词典别的词照样查得到。判成致命会把整本排除在查词之外。
     */
    const fine: DictionaryStatus[] = [
      'READY', 'PARTIAL', 'RESOURCE_MISSING', 'MEDIA_UNAVAILABLE', 'REDIRECT_BROKEN'
    ]
    for (const s of fatal) assert.ok(isFatal(s), `${s} 应该算致命`)
    for (const s of fine) assert.ok(!isFatal(s), `${s} 不该算致命 —— 这本还能查`)
  })

  it('GBK 那本现在读得了（压缩 D5.1a · 编码 D5.1b）—— 这条诊断留给别的编码', () => {
    /**
     * ★ 以前这里写的是「修好压缩之后还有编码这一关」。两关都过了之后
     *   那句话就成了假的 —— 用例照样绿，但它记录的事实是错的。
     */
    assert.equal(pickMdictEncoding('GBK'), 'gbk', '★ GBK 又变回读不了了？')
    const d = diagnostics.encoding('Big5')
    assert.ok(d.says.includes('Big5'))
    assert.ok(d.says.includes('GBK'), '★ 话术里要写清现在认得哪几种，别让他猜')
  })

  it('不是词典的那个文件，给的是「可以删掉」', () => {
    const d = diagnostics.notADictionary('macOS 压缩包带出来的附属文件')
    assert.equal(d.status, 'NOT_A_DICTIONARY')
    assert.equal(d.action?.kind, 'delete-file')
  })

  it('可序列化 —— 诊断要能直接落库（惰性装载的前提）', () => {
    for (const d of ALL) {
      assert.deepEqual(JSON.parse(JSON.stringify(d)), d, `${d.status} 序列化后变了样`)
    }
  })
})
