import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  accentOf,
  extensionOf,
  kindOf,
  makeMedia,
  mediaRef,
  mimeOf,
  normalizeResourceKey,
  parseMediaRef,
  usable
} from './media.ts'

const BOOK = 'dictionaries-nat-mdict|2.0|UTF-8|OALD|1|2|3'

describe('资源键归一：三种写法指向同一个文件', () => {
  /**
   * 实测（审计报告 §6）：
   *   HTML 里写 `sound://brunt__gb_1.mp3`，MDD 里存 `\brunt__gb_1.mp3`
   *   HTML 里写 `img/spkr_r.png`，        MDD 里存 `\img\spkr_r.png`
   */
  it('去 scheme、正斜杠换反斜杠、补前导反斜杠、转小写', () => {
    assert.equal(normalizeResourceKey('sound://brunt__gb_1.mp3'), '\\brunt__gb_1.mp3')
    assert.equal(normalizeResourceKey('img/spkr_r.png'), '\\img\\spkr_r.png')
    assert.equal(normalizeResourceKey('snd_uk.PNG'), '\\snd_uk.png')
    assert.equal(normalizeResourceKey('\\already\\ok.mp3'), '\\already\\ok.mp3')
  })

  it('同一个资源的几种写法归一到同一个键', () => {
    const want = '\\hwd\\bre\\b\\brunt.mp3'
    for (const raw of [
      'sound://hwd/bre/b/brunt.mp3',
      'sound:///hwd/bre/b/brunt.mp3',
      'hwd\\bre\\b\\brunt.mp3',
      '/hwd/bre/b/BRUNT.MP3'
    ]) {
      assert.equal(normalizeResourceKey(raw), want, `没归一：${raw}`)
    }
  })

  it('锚点与查询串不属于资源名', () => {
    assert.equal(normalizeResourceKey('a.png#x'), '\\a.png')
    assert.equal(normalizeResourceKey('a.png?v=2'), '\\a.png')
  })

  it('百分号编码解得开，解不开也不炸', () => {
    assert.equal(normalizeResourceKey('%E4%B8%AD.mp3'), '\\中.mp3')
    assert.doesNotThrow(() => normalizeResourceKey('%E4%B8.mp3'))
  })

  it('空的 / 只有 scheme 的返回空串 —— 不许造一个指不到东西的 media', () => {
    assert.equal(normalizeResourceKey(''), '')
    assert.equal(normalizeResourceKey('   '), '')
    assert.equal(normalizeResourceKey('sound://'), '')
  })
})

describe('ref：必须可逆', () => {
  /**
   * ★★ 审计报告里写的是 `sha1(key)`，**落地时发现那是错的**：
   *    hash 不可逆，主进程拿到 ref 之后没法知道要去 .mdd 里取哪个键,
   *    除非再维护一张装得下 110 万个键的反查表。
   */
  it('解得回 (bookUid, key)', () => {
    const ref = mediaRef(BOOK, '\\brunt__gb_1.mp3')
    assert.deepEqual(parseMediaRef(ref), { bookUid: BOOK, key: '\\brunt__gb_1.mp3' })
  })

  it('bookUid 里本来就有分隔符 —— 转义之后照样解得回来', () => {
    assert.ok(BOOK.includes('|'), '这个用例的前提是 uid 里真的有 |')
    const ref = mediaRef(BOOK, '\\a|b\\c.mp3')
    assert.deepEqual(parseMediaRef(ref), { bookUid: BOOK, key: '\\a|b\\c.mp3' })
  })

  it('两组不同的 (book, key) 绝不会产出同一个 ref', () => {
    assert.notEqual(mediaRef('a|b', 'c'), mediaRef('a', 'b|c'))
  })

  it('形状不对的 ref 一律不信', () => {
    assert.equal(parseMediaRef(''), null)
    assert.equal(parseMediaRef('只有一段'), null)
    assert.equal(parseMediaRef('a|b|c'), null)
  })
})

describe('类型与 mime', () => {
  it('扩展名 → 种类', () => {
    assert.equal(kindOf('\\a.mp3'), 'audio')
    assert.equal(kindOf('\\a.spx'), 'audio')
    assert.equal(kindOf('\\a.png'), 'image')
    assert.equal(kindOf('\\a.css'), 'style')
    assert.equal(kindOf('\\a.js'), 'script')
    assert.equal(kindOf('\\a.ttf'), 'font')
    assert.equal(kindOf('\\a.bin'), 'other')
    assert.equal(kindOf('\\a'), 'other')
  })

  it('mime', () => {
    assert.equal(mimeOf('\\a.mp3'), 'audio/mpeg')
    assert.equal(mimeOf('\\a.PNG'), 'image/png')
    assert.equal(mimeOf('\\a.unknown'), null)
    assert.equal(extensionOf('\\a.b.MP3'), 'mp3')
  })
})

describe('makeMedia：放不了的要当场说出来', () => {
  it('mp3 正常可用', () => {
    const m = makeMedia(BOOK, 'sound://brunt__gb_1.mp3', { label: 'uk' })!
    assert.equal(m.kind, 'audio')
    assert.equal(m.mime, 'audio/mpeg')
    assert.equal(m.label, 'uk')
    assert.ok(usable(m))
  })

  /** ★ LDOCE5 的 18.4 万条发音都是这个格式 */
  it('.spx 带上「为什么放不了」，而不是静悄悄没有按钮', () => {
    const m = makeMedia(BOOK, 'sound://GB_brunt0205.spx')!
    assert.ok(!usable(m))
    assert.equal(m.unavailable!.status, 'MEDIA_UNAVAILABLE')
    assert.ok(/Speex/.test(m.unavailable!.says))
    assert.ok(/别的词典.*不受影响/.test(m.unavailable!.says), '要说清这不是全局故障')
  })

  it('认不出的音频格式也给一句话', () => {
    const m = makeMedia(BOOK, 'sound://x.wma')!
    assert.ok(!usable(m))
    assert.ok(m.unavailable!.says.includes('wma'))
  })

  it('图片不做可播性判断', () => {
    assert.ok(usable(makeMedia(BOOK, 'x.png')!))
  })

  it('归一不出键就返回 null', () => {
    assert.equal(makeMedia(BOOK, ''), null)
    assert.equal(makeMedia(BOOK, 'sound://'), null)
  })
})

describe('口音判定', () => {
  it('OALD10 的命名（class 优先）', () => {
    assert.equal(accentOf('\\brunt__gb_1.mp3', ['sound', 'pron-uk']), 'uk')
    assert.equal(accentOf('\\brunt__us_1.mp3', ['sound', 'pron-us']), 'us')
  })

  /** ★ 例句朗读多一个前导下划线 + `s`：`_brunt__gbs_1.mp3` */
  it('例句朗读认得出来，不冒充词头发音', () => {
    assert.equal(accentOf('\\_brunt__gbs_1.mp3', ['sound', 'pron-uk']), 'sentence')
    assert.equal(accentOf('\\_brunt__uss_1.mp3', ['sound', 'pron-us']), 'sentence')
  })

  it('朗文6 的路径命名', () => {
    assert.equal(accentOf('\\hwd\\bre\\b\\brunt0205.mp3'), 'uk')
    assert.equal(accentOf('\\hwd\\ame\\a\\brunt.mp3'), 'us')
    assert.equal(accentOf('\\exa\\bre\\0\\p008-000908093.mp3'), 'sentence')
  })

  it('认不出来就是 undefined，不瞎猜', () => {
    assert.equal(accentOf('\\whatever.mp3'), undefined)
  })
})
