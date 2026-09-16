import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEntry, detectRedirect, type DecodeResult } from './html-entry.ts'
import { bookCapabilities, type DictionaryCapability } from '../capability.ts'
import type { RichDictionaryEntry } from '../entry.ts'

/**
 * 三段式解码 · 对着**真词典的结构骨架**验
 *
 * ── 夹具是怎么来的 ★★ ────────────────────────────────────────
 *
 * `fixtures/*.html` 是从使用者真实的四本词典里**机器抽出来的骨架**：
 * 标签、class、属性、嵌套**原样保留**，文本内容换成占位
 *（同一段真实文本换成同一个占位 —— 否则「两处是同一个词」这个事实会消失）。
 *
 * 为什么不直接塞真词典进仓库：那是有版权的内容。
 * 为什么不手写夹具：**手写等于把我以为的结构写下来再验一遍我自己** ——
 * CLAUDE.md 第九节说的就是这个病。实测里 `<EXAMPLE>` 装的是中文、
 * `span.pos` 是栏目名「短语:」，这两条手写一百次也写不出来。
 *
 * 真词典本身的回归在 `scripts/dict-regression.mjs`（只在他机器上跑）。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FX = join(HERE, '..', 'fixtures')

const book = { uid: 'dictionaries-nat-test', id: 1, name: '测试词典' }

/** 带 mp3 + png 资源的那一类书（OALD / 朗文6 / LCDT） */
const RICH = bookCapabilities({ format: 'Html', resourceExtensions: ['mp3', 'png'], hasRedirects: true })
/** ★ LDOCE5：资源包里只有 `.spx`，浏览器放不了 → 书级就没有 `audio` */
const SPEEX_ONLY = bookCapabilities({ format: 'Html', resourceExtensions: ['spx', 'jpg'] })
/** 一张图一条音频都没有的（21 世纪） */
const TEXT_ONLY = bookCapabilities({ format: 'Html', resourceExtensions: [] })

function decode(id: string, word: string, caps: readonly DictionaryCapability[] = RICH): DecodeResult {
  const body = readFileSync(join(FX, `${id}.${word}.html`), 'utf8')
  return decodeEntry({ book, query: word, headword: word, record: { body, shape: 'html' }, bookCapabilities: caps })
}

function entryOf(r: DecodeResult): RichDictionaryEntry {
  assert.equal(r.kind, 'entry', '预期是词条，拿到的是跳转')
  return (r as Extract<DecodeResult, { kind: 'entry' }>).entry
}

const hasCjk = (s: string): boolean => /[一-鿿]/.test(s)
const hasLatin = (s: string): boolean => /[a-zA-Z]/.test(s)

// ══════════════════════════════════════════════════════════════

describe('R2 · @@@LINK 重定向', () => {
  /**
   * ★★ 实测：OALD10 有 77.3% 的词目、朗文6 有 80.4% 是重定向。
   *    今天卡片上原样显示 `@@@LINK=child`。
   */
  it('children 认成跳转，不是词条', () => {
    const r = decode('oald10', 'children')
    assert.equal(r.kind, 'redirect')
    assert.equal((r as { kind: 'redirect'; to: string }).to, 'child')
  })

  it('detectRedirect 认得各种写法，也认得「不是跳转」', () => {
    assert.equal(detectRedirect('@@@LINK=child'), 'child')
    assert.equal(detectRedirect('  @@@LINK= per cent\r\n'), 'per cent')
    assert.equal(detectRedirect('@@@LINK=child\0garbage'), 'child')
    assert.equal(detectRedirect('<div>@@@LINK=child</div>'), null, '正文里提到它不算')
    assert.equal(detectRedirect('@@@LINK='), null, '空目标不算跳转')
    assert.equal(detectRedirect(''), null)
  })

  /**
   * ★ 反向判据（CLAUDE.md 9.1）：判据必须是「**没有** @@@LINK 这个字符串」。
   *   用「卡片上有没有 child」当判据会永远绿 —— `@@@LINK=child` 里也含有 child。
   */
  it('任何一本词典的任何一条，text 里都不许出现 @@@LINK', () => {
    for (const id of ['oald10', 'ldoce5', 'ldoce6ec', 'c21']) {
      for (const w of ['brunt', 'sway', 'resilient', 'children', 'ran']) {
        let r: DecodeResult
        try {
          r = decode(id, w)
        } catch {
          continue // 这本没有这个词的夹具
        }
        if (r.kind === 'redirect') continue
        assert.ok(!r.entry.text.includes('@@@LINK'), `${id}/${w} 的 text 里有 @@@LINK`)
        for (const s of r.entry.senses) assert.ok(!s.gloss.includes('@@@LINK'))
      }
    }
  })
})

describe('R3 · 释义与中文对译必须是分开的字段', () => {
  /**
   * ★★★ 这是整个 D1 最重要的一条。
   *
   * 今天压平之后是这样一行（实测原文）：
   *   `to receive the main force of something unpleasant承受某事的主要压力；首当其冲Schools will…`
   * 英文释义 + 中文对译 + 英文例句 + 中文译文，四样粘成一条，**不可逆**。
   */
  it('OALD10：gloss 是英文、glossZh 是中文，两者不相互包含', () => {
    const e = entryOf(decode('oald10', 'brunt'))
    assert.ok(e.senses.length > 0, '应该抽得出释义')
    const s = e.senses[0]!
    assert.ok(hasLatin(s.gloss), 'gloss 应该是目标语')
    assert.ok(!hasCjk(s.gloss), `gloss 里混进了中文：${s.gloss}`)
    assert.ok(s.glossZh, '应该有中文对译')
    assert.ok(hasCjk(s.glossZh!), 'glossZh 应该是中文')
    assert.ok(!s.gloss.includes(s.glossZh!), 'gloss 里不该含着 glossZh')
  })

  it('OALD10：例句与它的译文也分开，且不粘在释义里', () => {
    const e = entryOf(decode('oald10', 'brunt'))
    const ex = e.senses.flatMap((s) => s.examples)
    assert.ok(ex.length > 0, '应该抽得出例句')
    for (const x of ex) {
      assert.ok(!hasCjk(x.text), `例句原文里混进了中文：${x.text}`)
      if (x.zh) assert.ok(hasCjk(x.zh), '译文应该是中文')
      assert.equal(x.from, 'dict')
    }
    for (const s of e.senses) {
      for (const x of s.examples) {
        assert.ok(!s.gloss.includes(x.text), '例句不该粘在释义里')
      }
    }
  })

  /** 朗文6 的摆法完全不同：中文在 `<TRAN>` / `<EXAMPLE>` **里面** */
  it('朗文6：<EN>/<TRAN> 与 <EXAEN>/<EXAMPLE> 各归各位', () => {
    const e = entryOf(decode('ldoce6ec', 'brunt'))
    const s = e.senses[0]!
    assert.ok(hasLatin(s.gloss) && !hasCjk(s.gloss), `gloss 不该有中文：${s.gloss}`)
    assert.ok(s.glossZh && hasCjk(s.glossZh), '应该从 <TRAN> 拿到中文')
    const ex = s.examples
    assert.ok(ex.length >= 2, '应该抽得出至少两条例句')
    for (const x of ex) {
      assert.ok(!hasCjk(x.text), `例句原文混进中文：${x.text}`)
      assert.ok(x.zh && hasCjk(x.zh), '★ <EXAMPLE> 装的是中文，要落进 zh')
    }
  })

  it('两本词典的中文摆法不同，但走的是同一条规则', () => {
    // OALD10 的中文是 def 的**兄弟**（<defT><chn>），朗文6 的在**里面**（<TRAN>）
    for (const id of ['oald10', 'ldoce6ec']) {
      const e = entryOf(decode(id, 'brunt'))
      assert.ok(e.senses.some((s) => s.glossZh), `${id} 应该拿得到中文对译`)
    }
  })
})

describe('噪声：不许把栏目名当成释义', () => {
  /**
   * ★ 实测：现行 `parseEntry` 抽出来的「核心释义」是
   *   `Word Origin` / `Idioms` / `VERB TABLE` / `EXAMPLES FROM THE CORPUS`。
   *   四本词典四个词，抽出的 12 条里没有一条是释义。
   */
  it('Word Origin 变成可折叠的框，不进 senses', () => {
    const e = entryOf(decode('oald10', 'brunt'))
    assert.ok(e.boxes.some((b) => b.kind === 'etymology'), '词源应该落进 boxes')
    for (const s of e.senses) {
      assert.ok(!/^word origin$/i.test(s.gloss), 'Word Origin 不是释义')
    }
  })

  it('jump to other results 不出现在任何地方', () => {
    for (const w of ['brunt', 'sway', 'resilient', 'ran']) {
      const e = entryOf(decode('oald10', w))
      assert.ok(!e.text.includes('jump to other results'), `${w} 的 text 里有它`)
      for (const s of e.senses) assert.ok(!s.gloss.includes('jump to other results'))
    }
  })

  it('光秃秃的词性不算释义', () => {
    for (const id of ['oald10', 'ldoce5', 'ldoce6ec', 'c21']) {
      for (const w of ['brunt', 'sway', 'resilient']) {
        const e = entryOf(decode(id, w, id === 'ldoce5' ? SPEEX_ONLY : RICH))
        for (const s of e.senses) {
          assert.ok(
            !/^(noun|verb|adjective|adverb|n\.|v\.|vt\.|vi\.|adj\.|adv\.)$/i.test(s.gloss.trim()),
            `${id}/${w} 把词性当成了释义：${JSON.stringify(s.gloss)}`
          )
        }
      }
    }
  })

  it('释义不会是词头本身', () => {
    for (const id of ['oald10', 'ldoce5', 'ldoce6ec']) {
      for (const w of ['brunt', 'sway', 'resilient']) {
        const e = entryOf(decode(id, w, id === 'ldoce5' ? SPEEX_ONLY : RICH))
        for (const s of e.senses) {
          assert.notEqual(s.gloss.trim().toLowerCase(), w, `${id}/${w} 把词头当成了释义`)
        }
      }
    }
  })
})

describe('21 世纪：词性不能取错，义项不能翻倍', () => {
  /** ★ `span.pos` 装的是栏目名「短语:」，真正的词性在 `span.pos-list-list` */
  it('词性是 n.，不是「短语:」', () => {
    const e = entryOf(decode('c21', 'brunt', TEXT_ONLY))
    const poses = new Set(e.senses.map((s) => s.pos).filter(Boolean))
    assert.ok(poses.has('n.'), `没取到词性：${[...poses].join(',')}`)
    for (const p of poses) assert.ok(!/[:：]$/.test(p!), `栏目名被当成了词性：${p}`)
  })

  /**
   * ★★ 嵌套的义项容器会让释义收两遍。
   *    21 世纪那本用 `li.wordGroup` 同时表示义项和短语，短语套在义项里 ——
   *    实测未去重时 4 条释义变成 8 条，而且**内容一模一样，看不出哪四条是多的**。
   */
  it('义项不重复', () => {
    for (const w of ['brunt', 'sway', 'resilient']) {
      const e = entryOf(decode('c21', w, TEXT_ONLY))
      const glosses = e.senses.map((s) => s.gloss)
      assert.equal(
        new Set(glosses).size,
        glosses.length,
        `${w} 有重复释义：${glosses.filter((g, i) => glosses.indexOf(g) !== i).join(' / ')}`
      )
    }
  })
})

describe('媒体与能力', () => {
  it('OALD10：英音 / 美音各自成对，例句朗读不冒充词头发音', () => {
    const e = entryOf(decode('oald10', 'brunt'))
    const labels = e.media.filter((m) => m.kind === 'audio').map((m) => m.label)
    assert.ok(labels.includes('uk'), '要有英音')
    assert.ok(labels.includes('us'), '要有美音')
    // ★ `_brunt__gbs_1.mp3` 里含有 `__gb`，先判 `__gb` 就会把例句朗读当成词头发音
    assert.equal(labels.filter((l) => l === 'uk').length, 1, '英音只该有一条')
    assert.equal(labels.filter((l) => l === 'us').length, 1, '美音只该有一条')
  })

  it('音标带上各自的发音', () => {
    const e = entryOf(decode('oald10', 'brunt'))
    assert.equal(e.phonetics.length, 2)
    assert.deepEqual(e.phonetics.map((p) => p.region), ['uk', 'us'])
    for (const p of e.phonetics) {
      assert.ok(p.ipa && !p.ipa.includes('/'), `音标不该带斜杠：${p.ipa}`)
      assert.ok(p.audio, '音标该配一条发音')
    }
  })

  /**
   * ★★ LDOCE5 的 18.4 万条发音是 `.spx`，Chromium 解不了。
   *    出现一个按下去没声音的喇叭，比没有喇叭糟得多 —— 他会以为软件坏了。
   */
  it('LDOCE5：.spx 标成不可用，且不声称有 audio 能力', () => {
    const e = entryOf(decode('ldoce5', 'brunt', SPEEX_ONLY))
    const audio = e.media.filter((m) => m.kind === 'audio')
    assert.ok(audio.length > 0, '正文里确实引用了发音')
    for (const a of audio) {
      assert.ok(a.unavailable, '.spx 必须带上「为什么放不了」')
      assert.equal(a.unavailable!.status, 'MEDIA_UNAVAILABLE')
      assert.ok(a.unavailable!.says.length > 10, '要有一句人话')
    }
    assert.ok(!e.capabilities.includes('audio'), '★ 不许声称有发音')
  })

  it('书级没有的结构能力，条目级不许声称', () => {
    // 正文里引用了 mp3，但这本书的资源包不在 → 不许说有发音
    const e = entryOf(decode('oald10', 'brunt', TEXT_ONLY))
    assert.ok(!e.capabilities.includes('audio'))
    assert.ok(!e.capabilities.includes('image'))
    // 内容能力不受影响 —— 它们算不出书级，只由这一条决定
    assert.ok(e.capabilities.includes('phonetic'))
    assert.ok(e.capabilities.includes('translation'))
  })

  it('喇叭图标不算词条配图', () => {
    const e = entryOf(decode('ldoce5', 'brunt', SPEEX_ONLY))
    for (const m of e.media) {
      assert.ok(!/snd_uk|snd_us|snd_sfx/.test(m.key), `喇叭图标混进了媒体：${m.key}`)
    }
  })
})

describe('交叉引用', () => {
  it('entry://run_2 → run，义项序号不算词的一部分', () => {
    const e = entryOf(decode('oald10', 'ran'))
    assert.ok(e.crossRefs.some((x) => x.headword === 'run'), `没认出 run：${JSON.stringify(e.crossRefs)}`)
    for (const x of e.crossRefs) assert.ok(!/_\d+$/.test(x.headword), `序号没去掉：${x.headword}`)
    assert.ok(e.capabilities.includes('crossReference'))
  })
})

describe('分档与形状', () => {
  it('画像认得且抽得出释义 = 第 ① 档', () => {
    for (const id of ['oald10', 'ldoce6ec', 'c21']) {
      const r = decode(id, 'brunt', id === 'c21' ? TEXT_ONLY : RICH)
      assert.equal(r.kind, 'entry')
      const rr = r as Extract<DecodeResult, { kind: 'entry' }>
      assert.equal(rr.tier, 1, `${id} 应该是第 ① 档`)
      assert.equal(rr.profileId, id)
    }
  })

  /** LDOCE5 一个 class 都没有：例句认得出，释义认不出 → 第 ② 档 */
  it('画像只认得例句 = 第 ② 档，不是第 ① 档', () => {
    const r = decode('ldoce5', 'brunt', SPEEX_ONLY) as Extract<DecodeResult, { kind: 'entry' }>
    assert.equal(r.tier, 2)
    assert.equal(r.profileId, 'ldoce5')
    assert.ok(r.entry.examples.length > 0, '例句该认得出来')
  })

  it('认不出的词典也产出合法结果（保底档）', () => {
    const r = decodeEntry({
      book, query: 'x', headword: 'x',
      record: { body: '<div>some unknown dictionary markup</div>', shape: 'html' },
      bookCapabilities: RICH
    }) as Extract<DecodeResult, { kind: 'entry' }>
    assert.equal(r.profileId, null)
    assert.ok(r.entry.text.length > 0, '至少要有降级文本')
    assert.ok(r.entry.capabilities.includes('text'))
  })

  it('纯文本正文（StarDict）直接进保底档', () => {
    const r = decodeEntry({
      book, query: 'x', headword: 'x',
      record: { body: '  纯文本释义  ', shape: 'text' },
      bookCapabilities: RICH
    }) as Extract<DecodeResult, { kind: 'entry' }>
    assert.equal(r.tier, 3)
    assert.equal(r.entry.text, '纯文本释义')
    assert.equal(r.entry.html, null)
  })

  it('html 原文一个字不删地留着（D4 要放进 Shadow DOM）', () => {
    const body = readFileSync(join(FX, 'oald10.brunt.html'), 'utf8')
    const e = entryOf(decodeEntry({
      book, query: 'brunt', headword: 'brunt',
      record: { body, shape: 'html' }, bookCapabilities: RICH
    }))
    assert.equal(e.html, body)
  })

  it('形状契约：数组字段永远不是 undefined', () => {
    for (const id of ['oald10', 'ldoce5', 'ldoce6ec', 'c21']) {
      const e = entryOf(decode(id, 'sway', id === 'ldoce5' ? SPEEX_ONLY : RICH))
      for (const k of ['redirectedFrom', 'phonetics', 'senses', 'examples', 'crossRefs', 'boxes', 'media', 'capabilities'] as const) {
        assert.ok(Array.isArray(e[k]), `${id} 的 ${k} 不是数组`)
      }
      assert.equal(typeof e.text, 'string')
      for (const s of e.senses) {
        assert.ok(Array.isArray(s.labels) && Array.isArray(s.examples) && Array.isArray(s.media))
      }
    }
  })
})

describe('绝不抛异常', () => {
  it('畸形 / 空 / 超长输入都能产出结果', () => {
    const bad = [
      '', '   ', '<', '</>', '<div', '<a href="', '<<<>>>',
      '@@@LINK=', '<script>', '&#x;', 'x'.repeat(200_000),
      '<div class="oald"><span class="def"></span></div>'
    ]
    for (const body of bad) {
      assert.doesNotThrow(() => {
        decodeEntry({ book, query: 'x', headword: 'x', record: { body, shape: 'html' }, bookCapabilities: RICH })
      }, `炸在：${JSON.stringify(body.slice(0, 40))}`)
    }
  })
})
