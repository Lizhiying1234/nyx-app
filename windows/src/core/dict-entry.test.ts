import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEntry } from './dict-entry.ts'

/**
 * ★★ 下面这些**全部是从他自己那 22 本词典里真的读出来的**，不是编的。
 *
 * 编出来的理想文本只能证明解析器认得自己写的格式。他机器上那几本
 * （21 世纪大英汉、TLD、OALD10、朗文当代、同义词典）排版差得很远，
 * 而且 TLD 里夹着 `VERB60267282`、`TEM8GRE`、光秃秃的 `209` 这类词频编号 ——
 * 那才是解析器真正要面对的东西。
 */

/** 21 世纪大英汉词典 · unspool（他截图里那个词） */
const CENTURY_UNSPOOL = ["unspool", "[,ʌn'spu:l]", '', 'vt.', '[俚语]上演(电影)', '', '以上来源于：《21世纪大英汉词典》'].join('\n')

/** TLD · unspool —— 中间夹着 `VERB60267282` 这种编号 */
const TLD_UNSPOOL = ["unspool", "[,ʌn'spu:l]", '', 'VERB60267282', '', 'vt.[俚语]上演(电影)'].join('\n')

/** TLD · unspooling —— 词形还原式的条目，**没有音标** */
const TLD_UNSPOOLING = [
  'unspooling',
  '原型:unspooling 是 unspool 的现在分词',
  '(unspool 的现在分词) vt. [俚语]上演(电影)'
].join('\n')

/** TLD · brunt —— 噪声最多的一条：考试标签、编号、光秃秃的数字 */
const TLD_BRUNT = [
  'brunt', '[brʌnt]', '', 'TEM8GRE', '', 'n14157915', '209', '', '106', '', '196', '', '234', '', '170', '',
  'NOUN1817715952', '', 'Spoken:', '15824720', '正面的冲击(58%)，主要的压力(42%)', 'n.冲击；主要冲力',
  'n.(Brunt)人名；(英)布伦特'
].join('\n')

/** OALD10 · brunt —— 词性在音标前面，还有 Word Origin 那一段 */
const OALD_BRUNT = [
  'brunt',
  'noun /brʌnt/',
  '/brʌnt/',
  'Word Originlate Middle English (denoting a blow or an attack): of unknown origin.',
  'Idioms',
  'jump to other results'
].join('\n')

/** 朗文当代 · brunt —— 词头、音标、词性挤在同一行 */
const LDOCE_BRUNT = [
  'brunt',
  'brunt /brʌnt/ noun',
  'bear/take/suffer etc the brunt of something to receive the worst part of an attack, criticism, bad situation etc:',
  'an industry that bore the brunt of the recession'
].join('\n')

/** 同义词典 · brunt —— 整篇是列表，没有传统意义上的释义 */
const THES_BRUNT = [
  'brunt', '', 'nounbad end of a situation', 'Synonyms for brunt', 'noun bad end of a situation',
  'burden', 'force', 'impact', 'pressure'
].join('\n')

test('★★ 21 世纪大英汉 · unspool：音标、词性、释义都要抽对', () => {
  const p = parseEntry(CENTURY_UNSPOOL, 'unspool')
  assert.equal(p.phonetic, ",ʌn'spu:l")
  assert.ok(p.senses.length >= 1, '一条释义都没抽出来')
  assert.equal(p.senses[0]!.pos, 'vt.', '光秃秃自成一行的词性没接到释义上')
  assert.equal(p.senses[0]!.gloss, '[俚语]上演(电影)')
  assert.ok(!p.senses.some((s) => /以上来源于/.test(s.gloss)), '版权尾巴被当成释义了')
})

test('★★ TLD · unspool：`VERB60267282` 这种编号不许当释义', () => {
  const p = parseEntry(TLD_UNSPOOL, 'unspool')
  assert.equal(p.phonetic, ",ʌn'spu:l")
  assert.equal(p.senses[0]!.pos, 'vt.')
  assert.equal(p.senses[0]!.gloss, '[俚语]上演(电影)')
  assert.ok(
    !p.senses.some((s) => /\d{5,}/.test(s.gloss)),
    `编号混进释义了：${JSON.stringify(p.senses)}`
  )
})

test('★★ TLD · brunt：一堆词频编号里要挑得出那句释义', () => {
  const p = parseEntry(TLD_BRUNT, 'brunt')
  assert.equal(p.phonetic, 'brʌnt')
  assert.ok(p.senses.length >= 1)
  const all = p.senses.map((s) => s.gloss).join(' | ')
  assert.ok(/冲击/.test(all), `没抽到真正的释义：${all}`)
  assert.ok(!/^\d+$/.test(p.senses[0]!.gloss), '光秃秃的数字被当成释义')
  assert.ok(!/NOUN18|TEM8|Spoken/.test(all), `噪声混进释义了：${all}`)
})

test('★ TLD · unspooling：没有音标就是没有，不许硬凑', () => {
  const p = parseEntry(TLD_UNSPOOLING, 'unspooling')
  assert.equal(p.phonetic, undefined, `把「(unspool 的现在分词)」当成音标了：${p.phonetic}`)
  assert.ok(p.senses.length >= 1, '这条什么都没抽出来')
  assert.ok(/现在分词|上演/.test(p.senses.map((s) => s.gloss).join(' ')))
})

test('★ OALD · brunt：音标抽得到，Word Origin 不当释义', () => {
  const p = parseEntry(OALD_BRUNT, 'brunt')
  assert.equal(p.phonetic, 'brʌnt')
  assert.ok(
    !p.senses.some((s) => /Word Origin|jump to other/i.test(s.gloss)),
    `把版式文案当释义了：${JSON.stringify(p.senses)}`
  )
})

test('★ 朗文当代 · brunt：词头/音标/词性挤在一行也要抽得出音标', () => {
  const p = parseEntry(LDOCE_BRUNT, 'brunt')
  assert.equal(p.phonetic, 'brʌnt')
  assert.ok(p.senses.length >= 1)
  assert.ok(/receive the worst part/.test(p.senses.map((s) => s.gloss).join(' ')))
})

test('★★ 同义词典：抽不出规整释义也不许崩，raw 一个字不少', () => {
  const p = parseEntry(THES_BRUNT, 'brunt')
  assert.equal(p.raw, THES_BRUNT, '★★ raw 被改动了 —— 滚动区就看不到完整词条了')
  // 抽到什么算什么；关键是不许把 `Synonyms for brunt` 这种栏目名冒充释义之外的东西
  for (const s of p.senses) assert.ok(s.gloss.length >= 2)
})

test('★★ 兜底：解析不出来时 raw 必须原样保留', () => {
  const weird = '§§§ \0 <span class="x">???</span>'
  const p = parseEntry(weird, 'x')
  assert.equal(p.raw, weird)
  assert.equal(p.phonetic, undefined)
})

test('★ 空输入 / 空白输入不崩', () => {
  for (const v of ['', '   ', '\n\n']) {
    const p = parseEntry(v, 'x')
    assert.deepEqual(p.senses, [])
    assert.equal(p.phonetic, undefined)
  }
})

test('★ 纯中文条目：不许把中文括号当音标', () => {
  const p = parseEntry('承受\n[chéng shòu]\n忍受；担当', '承受')
  assert.equal(p.phonetic, undefined, '拼音不是国际音标，认它会把卡片弄脏')
  assert.ok(p.senses.length >= 1)
})

test('★ HTML 残留不影响兜底（第一版不做 HTML 解析）', () => {
  const html = 'word\n<div class="pos">n.</div>\n<b>意思</b>'
  const p = parseEntry(html, 'word')
  assert.equal(p.raw, html, 'raw 必须原样')
})

test('★ 超长条目：只取前三条释义，不把整本书搬到第一屏', () => {
  const long = ['word', '[wɜːd]', ...Array.from({ length: 50 }, (_, i) => `n.释义第 ${i} 条`)].join('\n')
  const p = parseEntry(long, 'word')
  assert.ok(p.senses.length <= 3, `抽了 ${p.senses.length} 条`)
  assert.equal(p.raw.split('\n').length, 52, 'raw 不许被截断 —— 滚动区要看得到全部')
})

test('★★ 判据只有一份：解析器不认识业务语义', () => {
  /**
   * 这条守的是**边界**。解析器一旦开始判断「哪本词典是默认的」
   * 「查不到要退给谁」，业务判据就有了第二处 —— 而那种分家
   * 表现为「有时候用这本、有时候用那本」，谁都查不出规律。
   */
  const src = parseEntry.toString()
  assert.ok(!/default|dictionaries|settings|enabled|sort_order/i.test(src), '解析器里出现了业务概念')
})
