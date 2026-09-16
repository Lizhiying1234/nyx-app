import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  CANDIDATE_ORDER,
  DEFAULT_KEY_RULES,
  MAX_REDIRECT_HOPS,
  allRecords,
  candidates,
  detectRedirect,
  inflectionForms,
  keyRulesFromHeader,
  lookup,
  normalizeKey,
  resolveRedirects,
  strippedKey,
  type KeyRules,
  type LookupSource
} from './lookup.ts'
import { detectRedirect as detectFromDecode } from './decode/html-entry.ts'
import type { DictionaryRef } from './entry.ts'
import type { RawRecord } from './contract.ts'

/**
 * 查词语义 · D1 最后一项的验收
 *
 * ★ 这里的假词典**不是**为了让测试好写才捏的形状 —— 它就是 `LookupSource`，
 *   真实 adapter 满足的是同一个接口。所以这些用例验的是「查词语义」本身，
 *   不是「我写的那个 mock」。
 */

/** 一本假词典。值是正文；数组 = 同一个词目下的多条记录（同形异义） */
function book(
  name: string,
  entries: Readonly<Record<string, string | readonly string[]>>,
  rules: KeyRules = DEFAULT_KEY_RULES
): LookupSource {
  const ref: DictionaryRef = { uid: `uid-${name}`, id: 0, name }
  /** 归一键 → 真实词目。**索引按 `normalizeKey` 建**，和真 adapter 的要求一样 */
  const index = new Map<string, string[]>()
  for (const head of Object.keys(entries)) {
    const k = normalizeKey(head, rules)
    index.set(k, [...(index.get(k) ?? []), head])
  }
  return {
    book: ref,
    keyRules: rules,
    match: (key) => index.get(key) ?? [],
    raw: (headword, occurrence = 0): RawRecord | null => {
      const v = entries[headword]
      if (v === undefined) return null
      const bodies = typeof v === 'string' ? [v] : v
      const b = bodies[occurrence]
      return b === undefined ? null : { body: b, shape: 'html' }
    }
  }
}

describe('键的归一（KeyRules）', () => {
  it('大小写不敏感时折成小写，敏感时原样', () => {
    assert.equal(normalizeKey('  CD ', { caseSensitive: false, stripKey: true }), 'cd')
    assert.equal(normalizeKey('  CD ', { caseSensitive: true, stripKey: true }), 'CD')
  })

  /**
   * ★ 实测：OALD10 的键里本来就带着 1.5 万个空格、1.5 万个连字符、1890 个撇号。
   *   归一时抹掉它们，`re-cover` 和 `recover` 就并成一条了 —— 不可逆。
   */
  it('主键形绝不去标点', () => {
    const r = DEFAULT_KEY_RULES
    assert.equal(normalizeKey('re-cover', r), 're-cover')
    assert.notEqual(normalizeKey('re-cover', r), normalizeKey('recover', r))
    assert.equal(normalizeKey("we're", r), "we're")
    assert.equal(normalizeKey('per cent', r), 'per cent')
  })

  it('去标点形是另一档，不是主键形', () => {
    assert.equal(strippedKey('re-cover', DEFAULT_KEY_RULES), 'recover')
    assert.equal(strippedKey('per cent', DEFAULT_KEY_RULES), 'percent')
    assert.equal(strippedKey("don't", DEFAULT_KEY_RULES), 'dont')
  })

  it('头部属性 → 键规则（认 Yes/No，其余按默认）', () => {
    // 实测：他 21 本里只有 LCDT 是 KeyCaseSensitive=Yes
    assert.deepEqual(keyRulesFromHeader({ StripKey: 'Yes', KeyCaseSensitive: 'Yes' }), {
      caseSensitive: true,
      stripKey: true
    })
    // 实测：英语常用词疑难用法手册 StripKey=No
    assert.deepEqual(keyRulesFromHeader({ StripKey: 'No', KeyCaseSensitive: 'No' }), {
      caseSensitive: false,
      stripKey: false
    })
    // 实测：两本 1.2 版根本没写 StripKey
    assert.deepEqual(keyRulesFromHeader({ KeyCaseSensitive: 'No' }), DEFAULT_KEY_RULES)
    assert.deepEqual(keyRulesFromHeader({ StripKey: '真的' }), DEFAULT_KEY_RULES)
    assert.equal(keyRulesFromHeader({ StripKey: ' yes ' }).stripKey, true)
  })
})

describe('词形还原', () => {
  it('他点名的那几个都还原得出来', () => {
    assert.ok(inflectionForms('swayed').includes('sway'))
    assert.ok(inflectionForms('crises').includes('crisis'))
    assert.ok(inflectionForms('children').includes('child'))
  })

  it('常见规则', () => {
    assert.ok(inflectionForms('cities').includes('city'))
    assert.ok(inflectionForms('stopped').includes('stop'))
    assert.ok(inflectionForms('running').includes('run'))
    assert.ok(inflectionForms('moving').includes('move'))
    assert.ok(inflectionForms('knives').includes('knife'))
    assert.ok(inflectionForms('analyses').includes('analysis'))
    /**
     * ★ 同一档里顺序就是优先级。实测：`crises` 先给出 `cris` 的话，
     *   真有词典收了 `cris` 这个词目，查出来就是那一条。
     */
    const cri = inflectionForms('crises')
    assert.ok(cri.indexOf('crisis') < cri.indexOf('cris'), `crisis 必须排在 cris 前面：${cri}`)
    assert.ok(inflectionForms('boxes').includes('box'))
  })

  /** ★ 猜多了会把查词引到别的词上去，所以短词与 `ss` 结尾一律不动 */
  it('不该动的不动', () => {
    assert.deepEqual(inflectionForms('is'), [])
    assert.ok(!inflectionForms('glass').includes('glas'))
    assert.ok(!inflectionForms('sway').includes('swa'))
  })
})

describe('候选词', () => {
  it('优先级就是 CANDIDATE_ORDER，而且逐级不升', () => {
    const cs = candidates('bear the brunt of')
    const ranks = cs.map((c) => c.rank)
    assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, `候选词没有按优先级排：${JSON.stringify(cs)}`)
    for (const c of cs) assert.equal(c.rank, CANDIDATE_ORDER.indexOf(c.kind))
  })

  it('整条最优先，词形还原最靠后', () => {
    const cs = candidates('swayed')
    assert.equal(cs[0]!.text, 'swayed')
    assert.equal(cs[0]!.kind, 'verbatim')
    const sway = cs.find((c) => c.text === 'sway')
    assert.ok(sway, 'swayed 应该给出 sway 这个候选')
    assert.equal(sway.kind, 'inflection')
    assert.ok(cs.indexOf(sway) === cs.length - 1 || sway.rank >= cs[cs.length - 2]!.rank)
  })

  it('多词表达：掐掉首尾虚词成短语，再退到最实的那个词', () => {
    const cs = candidates('bear the brunt of')
    const phrase = cs.find((c) => c.kind === 'phrase')
    assert.equal(phrase?.text, 'bear the brunt', '中间那个 the 是词条的一部分，不该掐')
    const wordTexts = cs.filter((c) => c.kind === 'word').map((c) => c.text)
    assert.deepEqual(wordTexts, ['brunt', 'bear'], '长的排前面，虚词不要')
    assert.ok(!wordTexts.includes('the') && !wordTexts.includes('of'))
  })

  it('大小写敏感的词典：多给一档小写形（句首的词是大写的）', () => {
    const cs = candidates('Sway', { caseSensitive: true, stripKey: true })
    assert.deepEqual(cs.slice(0, 2).map((c) => c.text), ['Sway', 'sway'])
    assert.deepEqual(cs.slice(0, 2).map((c) => c.kind), ['verbatim', 'casefold'])
  })

  it('大小写不敏感时不给这一档 —— 归一后是同一个键', () => {
    const cs = candidates('CD')
    assert.deepEqual(cs.map((c) => c.text), ['CD'], `白查一次：${JSON.stringify(cs)}`)
    assert.ok(!cs.some((c) => c.kind === 'casefold'))
  })

  it('StripKey 关着就没有去标点那一档', () => {
    const off = candidates('per cent', { caseSensitive: false, stripKey: false })
    assert.ok(!off.some((c) => c.kind === 'stripped'))
    const on = candidates('per cent', { caseSensitive: false, stripKey: true })
    assert.equal(on.find((c) => c.kind === 'stripped')?.text, 'percent')
  })

  it('空串什么都不给', () => {
    assert.deepEqual(candidates('   '), [])
  })
})

describe('同形异义', () => {
  it('一个词目下的多条记录全部取得到，不止第一条', () => {
    const b = book('多义', { bank: ['<div>河岸</div>', '<div>银行</div>', '<div>倾斜</div>'] })
    const recs = allRecords(b, 'bank')
    assert.equal(recs.length, 3)
    assert.deepEqual(recs.map((r) => r.body.includes('银行')), [false, true, false])
  })

  it('取到 null 就到头，不会无限取', () => {
    assert.equal(allRecords(book('单义', { a: 'x' }), 'a').length, 1)
    assert.equal(allRecords(book('空', {}), 'a').length, 0)
  })

  it('上限管用 —— 索引坏掉时不会转死', () => {
    const endless: LookupSource = {
      book: { uid: 'u', id: 0, name: '坏索引' },
      keyRules: DEFAULT_KEY_RULES,
      match: () => ['x'],
      raw: () => ({ body: '<p>永远有下一条</p>', shape: 'html' })
    }
    assert.equal(allRecords(endless, 'x', 5).length, 5)
  })
})

describe('@@@LINK 跟随', () => {
  it('认得跳转，也认得「不是跳转」', () => {
    assert.equal(detectRedirect('@@@LINK=child'), 'child')
    assert.equal(detectRedirect('  @@@LINK= per cent\r\n'), 'per cent')
    assert.equal(detectRedirect('<div>@@@LINK=child</div>'), null, '正文里提到它不算')
    assert.equal(detectRedirect('@@@LINK='), null)
  })

  /** ★ 守「唯一出处」：解码那边是 re-export，不是另写一份 */
  it('解码模块用的是同一个函数', () => {
    assert.equal(detectFromDecode, detectRedirect)
  })

  it('跟一跳：拿到目标的正文，并记下从哪儿跳来的', () => {
    const b = book('OALD', { children: '@@@LINK=child', child: '<div>a young human</div>' })
    const r = resolveRedirects(b, 'children')
    assert.equal(r.headword, 'child')
    assert.match(r.record?.body ?? '', /young human/)
    assert.deepEqual(r.redirectedFrom, ['children'])
    assert.equal(r.diagnostic, undefined)
  })

  it('跟一条链：路径按顺序全记下来', () => {
    const b = book('链', { a: '@@@LINK=b', b: '@@@LINK=c', c: '<div>到底了</div>' })
    const r = resolveRedirects(b, 'a')
    assert.equal(r.headword, 'c')
    assert.deepEqual(r.redirectedFrom, ['a', 'b'])
  })

  /** ★★ 没有这一条，两个互指的词条会把整个进程转死 —— 他看到的是「软件卡住」 */
  it('A → B → A 转圈：停下来，给出诊断，不是无限递归', () => {
    const b = book('转圈', { a: '@@@LINK=b', b: '@@@LINK=a' })
    const r = resolveRedirects(b, 'a')
    assert.equal(r.record, null)
    assert.equal(r.diagnostic?.status, 'REDIRECT_BROKEN')
    assert.match(r.diagnostic?.detail ?? '', /cycle/)
    assert.match(r.diagnostic?.says ?? '', /圈/)
  })

  it('自己指自己也算圈', () => {
    const b = book('自指', { a: '@@@LINK=a' })
    const r = resolveRedirects(b, 'a')
    assert.equal(r.record, null)
    assert.equal(r.diagnostic?.status, 'REDIRECT_BROKEN')
  })

  it('长链超过上限：停下来，说清跳了几次', () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < MAX_REDIRECT_HOPS + 5; i++) entries[`w${i}`] = `@@@LINK=w${i + 1}`
    entries[`w${MAX_REDIRECT_HOPS + 5}`] = '<div>终点</div>'
    const r = resolveRedirects(book('长链', entries), 'w0')
    assert.equal(r.record, null)
    assert.equal(r.diagnostic?.status, 'REDIRECT_BROKEN')
    assert.match(r.diagnostic?.detail ?? '', /too deep/)
    assert.equal(r.redirectedFrom.length, MAX_REDIRECT_HOPS)
  })

  it('上限之内的长链照样跟到底', () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < MAX_REDIRECT_HOPS - 1; i++) entries[`w${i}`] = `@@@LINK=w${i + 1}`
    entries[`w${MAX_REDIRECT_HOPS - 1}`] = '<div>终点</div>'
    const r = resolveRedirects(book('刚好', entries), 'w0')
    assert.match(r.record?.body ?? '', /终点/)
  })

  it('断链：目标词目不在这本里 —— 要说清指向了谁', () => {
    const b = book('断链', { a: '@@@LINK=nowhere' })
    const r = resolveRedirects(b, 'a')
    assert.equal(r.record, null)
    assert.equal(r.diagnostic?.status, 'REDIRECT_BROKEN')
    assert.match(r.diagnostic?.says ?? '', /nowhere/)
  })

  /** 查不到是常态，不是错误（D-262 说的是「失败要看得见」，没收这个词不算失败） */
  it('这本压根没这个词：不给诊断', () => {
    const r = resolveRedirects(book('空', {}), 'ghost')
    assert.equal(r.record, null)
    assert.equal(r.diagnostic, undefined)
  })

  it('adapter 自己说了 redirectTo 就不用再看正文', () => {
    const src: LookupSource = {
      book: { uid: 'u', id: 0, name: 'x' },
      keyRules: DEFAULT_KEY_RULES,
      match: (k) => (k === 'child' ? ['child'] : []),
      raw: (h) =>
        h === 'children'
          ? { body: '随便什么', shape: 'html', redirectTo: 'child' }
          : h === 'child'
            ? { body: '<div>正文</div>', shape: 'html' }
            : null
    }
    const r = resolveRedirects(src, 'children')
    assert.equal(r.headword, 'child')
    assert.deepEqual(r.redirectedFrom, ['children'])
  })
})

describe('多本词典查词', () => {
  const brief = book('简明', { brunt: '<div>the main force</div>' })
  const idiom = book('习语', {
    'bear the brunt of': '<div>to receive the main force</div>',
    brunt: '<div>也收了单词</div>'
  })

  /** ★★ 整条命中优先于词目命中 —— 所以候选词在外层、词典顺序在内层 */
  it('整条命中的那本赢，哪怕它排在后面', () => {
    const r = lookup([brief, idiom], 'bear the brunt of')
    assert.equal(r.hits.length, 1)
    assert.equal(r.hits[0]!.book.name, '习语')
    assert.equal(r.hits[0]!.headword, 'bear the brunt of')
    assert.equal(r.hits[0]!.candidate.kind, 'verbatim')
  })

  it('同一档里，词典顺序说了算', () => {
    const r = lookup([brief, idiom], 'brunt')
    assert.deepEqual(r.hits.map((h) => h.book.name), ['简明', '习语'])
    assert.equal(r.hits[0]!.candidate.kind, 'verbatim')
  })

  it('maxBooks 管住出几本', () => {
    const third = book('第三本', { brunt: '<div>三</div>' })
    assert.equal(lookup([brief, idiom, third], 'brunt', { maxBooks: 2 }).hits.length, 2)
  })

  it('退到词目命中时，界面拿得到「实际查的是哪个词」', () => {
    const r = lookup([brief], 'bear the brunt of')
    assert.equal(r.hits[0]!.headword, 'brunt')
    assert.equal(r.hits[0]!.candidate.kind, 'word')
    assert.equal(r.hits[0]!.candidate.text, 'brunt')
  })

  it('词形还原那一档也能命中，而且标着 inflection', () => {
    const r = lookup([book('原形', { sway: '<div>to move slowly</div>' })], 'swayed')
    assert.equal(r.hits[0]!.headword, 'sway')
    assert.equal(r.hits[0]!.candidate.kind, 'inflection')
  })

  /** ★ 一档命中就收手：不然 `swayed` 会同时摆出 swayed 和 sway 两条 */
  it('高一档命中之后不再往下试', () => {
    const b = book('两条都有', { swayed: '<div>原形式</div>', sway: '<div>原形</div>' })
    const r = lookup([b], 'swayed')
    assert.equal(r.hits.length, 1)
    assert.equal(r.hits[0]!.headword, 'swayed')
  })

  it('同形异义：三条记录出三个 hit，homographs 都是 3', () => {
    const b = book('多义', { bank: ['<div>河岸</div>', '<div>银行</div>', '<div>倾斜</div>'] })
    const r = lookup([b], 'bank')
    assert.equal(r.hits.length, 3, '同形异义被吞掉了')
    assert.deepEqual(r.hits.map((h) => h.occurrence), [0, 1, 2])
    for (const h of r.hits) assert.equal(h.homographs, 3)
  })

  /** 实测：LCDT 是他 21 本里唯一 KeyCaseSensitive=Yes 的 */
  it('大小写敏感的词典：CD 查得到，cd 查不到', () => {
    const rules: KeyRules = { caseSensitive: true, stripKey: true }
    const lcdt = book('LCDT', { CD: '<div>compact disc</div>' }, rules)
    assert.equal(lookup([lcdt], 'CD').hits.length, 1)
    assert.equal(lookup([lcdt], 'cd').hits.length, 0)
  })

  it('大小写不敏感的词典：cd 也查得到', () => {
    const other = book('普通', { CD: '<div>compact disc</div>' })
    assert.equal(lookup([other], 'cd').hits.length, 1)
  })

  /** ★★ 这是 D3 之前就要成立的语义：查词的产物里不许留着 @@@LINK */
  it('跳转跟到底，结果里不含 @@@LINK，并带着 redirectedFrom', () => {
    const b = book('OALD', { children: '@@@LINK=child', child: '<div>a young human</div>' })
    const r = lookup([b], 'children')
    assert.equal(r.hits.length, 1)
    assert.ok(!r.hits[0]!.record.body.includes('@@@LINK'), '@@@LINK 漏进结果了')
    assert.deepEqual(r.hits[0]!.redirectedFrom, ['children'])
    assert.equal(r.hits[0]!.headword, 'child')
  })

  it('跳转坏了的那本被跳过，但坏在哪儿要记下来', () => {
    const broken = book('坏的', { a: '@@@LINK=b', b: '@@@LINK=a' })
    const good = book('好的', { a: '<div>正文</div>' })
    const r = lookup([broken, good], 'a')
    assert.deepEqual(r.hits.map((h) => h.book.name), ['好的'])
    assert.equal(r.diagnostics.length, 1)
    assert.equal(r.diagnostics[0]!.status, 'REDIRECT_BROKEN')
  })

  it('一本都没收：空结果，不是异常，也不给诊断', () => {
    const r = lookup([brief, idiom], 'zzzznotaword')
    assert.deepEqual(r.hits, [])
    assert.deepEqual(r.diagnostics, [])
  })

  /** ★ D3 接线用它把改动限制在 redirect 这一件事上 —— 见 `LookupOptions.kinds` */
  it('kinds：只开指定的那几档候选，顺序仍由 CANDIDATE_ORDER 定', () => {
    const b = book('两条都有', { swayed: '<div>原形式</div>', sway: '<div>原形</div>' })
    // 全开：verbatim 先命中
    assert.equal(lookup([b], 'swayed').hits[0]!.headword, 'swayed')
    /**
     * ★ 单词查询里 `word` 档是空的 —— 去重按**归一后的键**走，
     *   `swayed` 已经被 `verbatim` 占了。所以单开 `word` 什么都查不到，
     *   这不是 bug，是去重的必然结果（多词表达才轮得到 `word` 档）。
     */
    assert.deepEqual(lookup([b], 'swayed', { kinds: ['word'] }).hits, [])
    assert.equal(lookup([b], 'swayed', { kinds: ['verbatim', 'word'] }).hits[0]!.headword, 'swayed')
    // 多词表达时 `word` 档才真的出场
    const brunt = book('简明', { brunt: '<div>the main force</div>' })
    assert.equal(lookup([brunt], 'bear the brunt of', { kinds: ['word'] }).hits[0]!.headword, 'brunt')
    // 关掉 inflection：查 'swayed' 时，只收了 sway 的那本就该查不到
    const onlySway = book('只有原形', { sway: '<div>原形</div>' })
    assert.equal(lookup([onlySway], 'swayed').hits[0]!.headword, 'sway', '全开时该靠词形还原命中')
    assert.deepEqual(
      lookup([onlySway], 'swayed', { kinds: ['verbatim', 'word'] }).hits,
      [],
      '★ 关掉 inflection 之后不该再命中 —— D3 就是靠这个把漂移挡在 redirect 之外'
    )
    // 关掉 stripped：`per cent` 不再退到 `percent`
    const pc = book('百分号', { percent: '<div>%</div>' })
    assert.equal(lookup([pc], 'per cent').hits[0]!.headword, 'percent')
    assert.deepEqual(lookup([pc], 'per cent', { kinds: ['verbatim', 'word'] }).hits, [])
  })

  it('kinds 不影响跳转跟随 —— redirect 是记录里的事，不是候选词的事', () => {
    const b = book('OALD', { children: '@@@LINK=child', child: '<div>a young human</div>' })
    const r = lookup([b], 'children', { kinds: ['verbatim', 'word'] })
    assert.equal(r.hits[0]!.headword, 'child')
    assert.deepEqual(r.hits[0]!.redirectedFrom, ['children'])
  })

  it('空查询 / 没有词典：不炸', () => {
    assert.deepEqual(lookup([brief], '   ').hits, [])
    assert.deepEqual(lookup([], 'brunt').hits, [])
  })
})
