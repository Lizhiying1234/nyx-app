import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { QTYPES } from './qtypes.ts'
import {
  buildReadingPrompt,
  DEFAULT_READING_RULES,
  FACTORY_READING_RULE_TEXTS,
  legacyReadingRulesOf,
  READING_FACES,
  READING_RULES_BEFORE_OPTIONS
} from './reading-face.ts'
import {
  buildPracticeRules,
  CONTEXT_SPREAD_LINES,
  FACE_PICK_LINES,
  FULL_SENTENCE_LINE,
  MATCH_REGISTER_LINE,
  NO_SOURCE_LINE,
  LAST_FACE_MAX,
  noteLastFace,
  orderFacesForPick,
  PARAGRAPH_QTYPE_IDS,
  parseLastFace,
  practiceGlobalLines,
  practiceHintLines,
  practiceRulesOf,
  PRACTICE_RULES_FACTORY,
  QUIZ_PREF_SPECS,
  QUIZ_RULE_KEYS,
  readingRuleLines,
  readingRulesOf,
  capReadingGrade,
  practiceFaceOf,
  readingQTypeOf,
  READING_CAP_GRADE,
  READING_HINT_LINES,
  READING_QTYPE_FACTORY,
  READING_RULES_FACTORY,
  PRACTICE_FACE_FACTORY,
  PRACTICE_FACE_SAYS,
  READING_QTYPE_SAYS,
  REGISTER_QTYPE_ID,
  SHIFT_CONTEXT_LINE,
  type PracticeRules,
  type ReadingRules
} from './quiz-rules.ts'
import { PREF_KEYS } from './prefs.ts'
import { effectiveQTypePrompt } from './qtypes-store.ts'
import { matchesTerm } from './reading-face.ts'

const LF = String.fromCharCode(10)

/**
 * 出题规则的七个选项 · 判据用例（D-482）
 *
 * 判据文件是 `docs/ui/确认单-2026-09-15-出题规则选项与首次引导.md`
 * （使用者 2026-09-15「全部按照推荐的来」）。这里每一条钉的都是
 * **「变了也不报错」**的地方：出厂值漂一格、某一句被顺手润色、
 * 硬约束在某一档下掉了 —— 全都只表现为「AI 出的题好像不太一样」。
 */
describe('出题规则 · 七个选项', () => {
  it('★★ 出厂值 = 确认单的「推荐」那一列（使用者裁的是这七个值）', () => {
    assert.deepEqual(READING_RULES_FACTORY, {
      facePick: 'quote-first',
      hintLevel: 'normal',
      shiftContext: true
    })
    assert.deepEqual(PRACTICE_RULES_FACTORY, {
      hintLevel: 'full',
      contextSpread: 'mixed',
      requireFullSentence: true,
      matchRegister: true
    })
  })

  it('★★ 这几个键都进了偏好白名单 —— 不在名单里就写不进去，而且是静默失败', () => {
    /** ★ D-482 七把 + D-486 两把（`practice.face` / `reading.qtype`）= 9 */
    assert.equal(QUIZ_PREF_SPECS.length, 9)
    for (const key of Object.values(QUIZ_RULE_KEYS)) {
      assert.ok(PREF_KEYS.includes(key), `「${key}」没进 PREF_SPECS —— checkPrefKey 会当场拒写`)
    }
  })

  it('★★ 值认不出来一律回出厂，不抛（老版本 / 别的设备写进来的值）', () => {
    const junk = (): string => '天知道是什么'
    assert.deepEqual(readingRulesOf(junk), READING_RULES_FACTORY)
    assert.deepEqual(practiceRulesOf(junk), PRACTICE_RULES_FACTORY)
    assert.deepEqual(readingRulesOf(() => null), READING_RULES_FACTORY)
  })

  it('★ 存下去的值读得回来（七个各一次）', () => {
    const store: Record<string, string> = {
      [QUIZ_RULE_KEYS.facePick]: 'rotate',
      [QUIZ_RULE_KEYS.readingHint]: 'less',
      [QUIZ_RULE_KEYS.shiftContext]: '0',
      [QUIZ_RULE_KEYS.practiceHint]: 'none',
      [QUIZ_RULE_KEYS.contextSpread]: 'far',
      [QUIZ_RULE_KEYS.requireFullSentence]: '0',
      [QUIZ_RULE_KEYS.matchRegister]: '0'
    }
    const read = (k: string): string | null => store[k] ?? null
    assert.deepEqual(readingRulesOf(read), {
      facePick: 'rotate',
      hintLevel: 'less',
      shiftContext: false
    })
    assert.deepEqual(practiceRulesOf(read), {
      hintLevel: 'none',
      contextSpread: 'far',
      requireFullSentence: false,
      matchRegister: false
    })
  })
})

describe('理解层 · 拼出来的那几句', () => {
  const R = (over: Partial<ReadingRules> = {}): ReadingRules => ({ ...READING_RULES_FACTORY, ...over })

  it('★★★ 每一档拼出来的句子**逐字**等于确认单细目', () => {
    /** 逐字抄自 `确认单-2026-09-15` §一 细目。这里写死一份，就是为了它被改动时当场红 */
    assert.equal(
      FACE_PICK_LINES['quote-first'],
      'Pick the face to use in this order: if a usable source sentence exists, use the cloze face — ' +
        'that sentence is one the learner collected themselves and is worth more than an invented one. ' +
        'If it cannot be used (no quote / too short / the quote is the expression itself), build a scenario. ' +
        'If a scenario does not work either, use the Chinese-recall face. If only one face is available, use it. ' +
        'If none works, write 形式：无 and let the software fall back.'
    )
    assert.equal(
      FACE_PICK_LINES.rotate,
      'Pick the face the learner has least recently seen for this expression. ' +
        'Never use the same face twice in a row for the same expression. ' +
        'If only one face is available, use it. If none works, write 形式：无.'
    )
    assert.equal(
      FACE_PICK_LINES.random,
      'Pick any one of the available faces at random. If none works, write 形式：无.'
    )
    assert.equal(
      READING_HINT_LINES.more,
      'Make the card easy to enter: give the part of speech, and hint at the grammatical shape the answer takes. ' +
        'Never give the expression or any inflection of it.'
    )
    assert.equal(READING_HINT_LINES.normal, '', '「适中」是出厂行为 —— 一句都不该多拼')
    assert.equal(
      READING_HINT_LINES.less,
      'Keep the card minimal: no part of speech, no structural hint. One short line. ' +
        'Never give the expression or any inflection of it.'
    )
    assert.equal(
      SHIFT_CONTEXT_LINE,
      'When building a scenario, move it to a different setting from the source sentence. ' +
        'The learner should have to recognise the expression somewhere it has not been seen.'
    )
  })

  it('★★ R-2 三档**都**带着「绝不给这个表达本身」那句（D-390 不随档变）', () => {
    for (const level of ['more', 'normal', 'less'] as const) {
      const sys = buildReadingPrompt(R({ hintLevel: level }), ['cloze'], 'x', null, null, null)!.system
      assert.ok(
        sys.includes('绝对不许出现这个表达本身'),
        `★★ 「${level}」这一档少了硬约束尾段 —— D-390 是红线，不是选项`
      )
      assert.ok(sys.includes('形式：') && sys.includes('题面：'), `「${level}」这一档少了输出格式`)
    }
    /** `less` / `more` 自己还各带一句英文的「不许给」——两道，不是一道 */
    assert.match(READING_HINT_LINES.less, /Never give the expression/)
    assert.match(READING_HINT_LINES.more, /Never give the expression/)
  })

  it('★★ R-3 关掉就一句都不拼；开着才有（出厂是开）', () => {
    assert.ok(readingRuleLines(R({ shiftContext: true })).includes(SHIFT_CONTEXT_LINE))
    assert.ok(!readingRuleLines(R({ shiftContext: false })).includes(SHIFT_CONTEXT_LINE))
  })

  it('★★★ R-3 升上来了，「场景补全」牌面里那一句必须**删干净**（两处 = 两份判据）', () => {
    const scenario = READING_FACES.find((f) => f.id === 'scenario')!
    assert.ok(
      !scenario.guide.includes('不要抄原句'),
      '★★★ 牌面 guide 里还留着那一句 —— 他把 R-3 关掉之后它照样生效，而屏上写着「关着」'
    )
  })

  it('★ 出厂那一份 = 出厂选项拼出来的（`DEFAULT_READING_RULES` 不许自己另算一份）', () => {
    const sys = buildReadingPrompt(READING_RULES_FACTORY, ['cloze'], 'x', null, null, null)!.system
    assert.ok(sys.startsWith(DEFAULT_READING_RULES))
    assert.ok(DEFAULT_READING_RULES.includes(FACE_PICK_LINES['quote-first']))
  })
})

describe('R-1「轮着来」· 上次用了哪一面', () => {
  const faces = [{ id: 'cloze' }, { id: 'scenario' }, { id: 'zh-recall' }, { id: 'define' }]
  const rot: ReadingRules = { ...READING_RULES_FACTORY, facePick: 'rotate' }

  it('★★★ 上次那一面之后的排到前面，它自己落到最后', () => {
    assert.deepEqual(
      orderFacesForPick(faces, rot, 'scenario').map((f) => f.id),
      ['zh-recall', 'define', 'cloze', 'scenario'],
      '★★★ 上次是「场景补全」，下一次该从它后面那一面开始，它自己排最后'
    )
  })

  it('★★ 连着轮一圈：四次不重样，第五次才回到第一面', () => {
    let last: string | null = null
    const got: string[] = []
    for (let i = 0; i < 5; i++) {
      const pick: string = orderFacesForPick(faces, rot, last)[0]!.id
      got.push(pick)
      last = pick
    }
    assert.deepEqual(got, ['cloze', 'scenario', 'zh-recall', 'define', 'cloze'])
    for (let i = 1; i < got.length; i++) {
      assert.notEqual(got[i], got[i - 1], '★★ 连着两次挑了同一面')
    }
  })

  it('★ 没记过（新知识点 / 记号被挤掉）→ 原序不动，从第一面开始轮', () => {
    assert.deepEqual(
      orderFacesForPick(faces, rot, null).map((f) => f.id),
      faces.map((f) => f.id)
    )
    assert.deepEqual(
      orderFacesForPick(faces, rot, '早就删掉的那一面').map((f) => f.id),
      faces.map((f) => f.id),
      '认不出的 id 不许把顺序搅乱'
    )
  })

  it('★★ 别的两档**原序不动** —— 顺序有含义只对「轮着来」成立', () => {
    for (const pick of ['quote-first', 'random'] as const) {
      assert.deepEqual(
        orderFacesForPick(faces, { ...READING_RULES_FACTORY, facePick: pick }, 'cloze').map(
          (f) => f.id
        ),
        faces.map((f) => f.id)
      )
    }
  })

  it('★★ 记号读得回来；不是合法 JSON 就当没记过（不许抛 —— 抛了整张卡就没了）', () => {
    assert.deepEqual(parseLastFace(noteLastFace(null, 'items-1', 'cloze')), { 'items-1': 'cloze' })
    assert.deepEqual(parseLastFace('{坏掉的'), {})
    assert.deepEqual(parseLastFace('[1,2]'), {})
    assert.deepEqual(parseLastFace(null), {})
    assert.deepEqual(parseLastFace('{"items-1":7}'), {}, '值不是字符串就当没记过')
  })

  it('★★★ 那张 map 有界 —— 它按知识点存，不封顶就会随库一起长而没人看得见', () => {
    let raw: string | null = null
    for (let i = 0; i < LAST_FACE_MAX + 25; i++) raw = noteLastFace(raw, `items-${i}`, 'cloze', LAST_FACE_MAX)
    const map = parseLastFace(raw)
    assert.equal(Object.keys(map).length, LAST_FACE_MAX, '★★★ 超了上限还在长')
    assert.ok(!map['items-0'], '丢的该是最旧的那几条')
    assert.equal(map[`items-${LAST_FACE_MAX + 24}`], 'cloze', '最新那条必须在')
  })

  it('★★ 同一条再出现要挪到队尾 —— 不然它会一直占着「最旧」被挤掉', () => {
    let raw = noteLastFace(null, 'items-old', 'cloze', 3)
    raw = noteLastFace(raw, 'items-b', 'define', 3)
    raw = noteLastFace(raw, 'items-old', 'scenario', 3)
    raw = noteLastFace(raw, 'items-c', 'cloze', 3)
    const map = parseLastFace(raw)
    assert.equal(map['items-old'], 'scenario', '★★ 天天在练的那一条被挤掉了')
    assert.equal(Object.keys(map).length, 3)
  })

  it('★★ 选了「轮着来」时提示词里要说清顺序有含义（模型看不到历史）', () => {
    const sys = buildReadingPrompt(rot, ['cloze', 'define'], 'x', null, null, null)!.system
    assert.match(sys, /least recently seen/)
    assert.match(sys, /The faces below are listed in that order/)
  })
})

describe('写作层 · 拼出来的那几句', () => {
  const W = (over: Partial<PracticeRules> = {}): PracticeRules => ({ ...PRACTICE_RULES_FACTORY, ...over })

  it('★★★ 每一档拼出来的句子**逐字**等于确认单细目', () => {
    assert.equal(
      NO_SOURCE_LINE,
      'Do not quote or paraphrase the sentence where the learner met this expression.'
    )
    assert.equal(
      CONTEXT_SPREAD_LINES.near,
      'Keep every question in the original context or one adjacent to it. ' +
        'Use context values "original" and "near" only.'
    )
    assert.equal(
      CONTEXT_SPREAD_LINES.far,
      'Spread the batch towards unfamiliar ground: at most one question in the original context, ' +
        'and at least half in "far" or "unseen" settings.'
    )
    assert.equal(
      FULL_SENTENCE_LINE,
      'The learner must answer in a complete sentence. A bare phrase is not an acceptable answer; ' +
        'say so in the prompt.'
    )
    assert.equal(
      MATCH_REGISTER_LINE,
      'Keep the register of each question consistent with the source sentence — ' +
        'if the learner met the expression in speech, do not set the task in formal writing.'
    )
  })

  it('★★ W-2「混着来」那一段是**出厂原文**（确认单：不改）', () => {
    assert.match(CONTEXT_SPREAD_LINES.mixed, /Do not put every question in the same setting/)
    assert.match(CONTEXT_SPREAD_LINES.mixed, /completely unfamiliar setting/)
  })

  it('★★★ W-1 三档给的材料：目标表达永远给（D-137），释义与原句按档', () => {
    const material = { gloss: 'to take the worst of it', quote: 'She bore the brunt.' }
    assert.deepEqual(practiceHintLines(W({ hintLevel: 'full' }), material), [
      'Meaning: to take the worst of it',
      'Where the learner met it: "She bore the brunt."'
    ])
    assert.deepEqual(practiceHintLines(W({ hintLevel: 'gloss-only' }), material), [
      'Meaning: to take the worst of it'
    ])
    assert.deepEqual(practiceHintLines(W({ hintLevel: 'none' }), material), [])
    /** ★ 「都不给」那一档还要多拼一句，不然模型会自己把原句抄进题面 */
    assert.deepEqual(practiceGlobalLines(W({ hintLevel: 'none' })), [NO_SOURCE_LINE])
    assert.deepEqual(practiceGlobalLines(W({ hintLevel: 'full' })), [])
  })

  it('★★★ W-3 对本来就要求成段的四种题型**不拼**（对它们说「写完整句」是废话）', () => {
    for (const id of PARAGRAPH_QTYPE_IDS) {
      assert.ok(
        !buildPracticeRules(W(), id).includes(FULL_SENTENCE_LINE),
        `★★★ 「${id}」本来就要写成段，却收到了「必须写完整句」`
      )
    }
    assert.ok(buildPracticeRules(W(), '造句').includes(FULL_SENTENCE_LINE))
    assert.ok(!buildPracticeRules(W({ requireFullSentence: false }), '造句').includes(FULL_SENTENCE_LINE))
  })

  it('★★★ W-4 对「语域转换」**不拼**（那一题的全部内容就是换语域）', () => {
    assert.ok(
      !buildPracticeRules(W(), REGISTER_QTYPE_ID).includes(MATCH_REGISTER_LINE),
      '★★★ 「语域转换」收到了「语域要和原句一致」—— 题目自相矛盾'
    )
    assert.ok(buildPracticeRules(W(), '造句').includes(MATCH_REGISTER_LINE))
    assert.ok(!buildPracticeRules(W({ matchRegister: false }), '造句').includes(MATCH_REGISTER_LINE))
  })

  it('★★ 那五个 id 都真的在 `QTYPES` 里 —— 打错一个字，豁免就静静失效了', () => {
    const ids = new Set(QTYPES.map((q) => q.id))
    for (const id of [...PARAGRAPH_QTYPE_IDS, REGISTER_QTYPE_ID]) {
      assert.ok(ids.has(id), `「${id}」不是任何一种题型的 id —— 这条豁免永远不会命中`)
    }
  })
})

/**
 * ══ 「他以前写过没有」· 判据在 core（Nyx-UI-Android 2026-09-15 提的）══
 *
 * 这一条决定的是**要不要对他说一句话**：「你以前写的出题规则已经收起来了」。
 * 判错的后果很具体 —— 一个一个字都没写过的人被告知他写过，而且只在一端发生。
 */
describe('老数据认账 · 他以前写过出题规则没有', () => {
  it('★★★ 每一版出厂正文都要认得出来（只认今天那份 = 老用户集体被判成「改过」）', () => {
    for (const factory of FACTORY_READING_RULE_TEXTS) {
      assert.equal(
        legacyReadingRulesOf(factory),
        null,
        '★★★ 出厂原样被判成「他改过」了 —— 他会收到一句自己没写过的话'
      )
    }
    /** 名单里必须有那两版：冻住的上一版 + 今天这版 */
    assert.ok(FACTORY_READING_RULE_TEXTS.includes(READING_RULES_BEFORE_OPTIONS))
    assert.ok(FACTORY_READING_RULE_TEXTS.includes(DEFAULT_READING_RULES))
  })

  it('★★ 没设过 / 空白 → null；他自己写的 → 原样还回去', () => {
    assert.equal(legacyReadingRulesOf(null), null)
    assert.equal(legacyReadingRulesOf(undefined), null)
    assert.equal(legacyReadingRulesOf('   '), null)
    assert.equal(legacyReadingRulesOf('我自己写的：每次都用中文问。'), '我自己写的：每次都用中文问。')
  })

  it('★ 两头的空白不算差别（存进去 trim 过，读回来可能带换行）', () => {
    assert.equal(legacyReadingRulesOf(`${LF}${DEFAULT_READING_RULES}  ${LF}`), null)
  })
})

/**
 * ══ I-187 · 这一种题型真正发出去的是哪一段 ════════════════════
 *
 * 他真库里 12 种内置题型有 **10 种**带着生成出来的、和题型名错位的长正文
 * （「造句」那条写的是 cohesion reconstruction），而老优先级是「有 prompt 就用」——
 * **于是「造句」一直在按别的题型出题，屏幕上一切正常。**
 * 使用者 2026-09-15 答：那些是生成的，不是他写的。
 */
describe('I-187 · 内置题型只用 guide', () => {
  const G = 'Give a concrete situation and ask for one sentence.'
  const JUNK = 'Rewrite the passage to improve cohesion across paragraphs…'

  it('★★★ 内置题型带着 prompt 也只用 guide（那 10 段是生成的，不是他写的）', () => {
    assert.equal(effectiveQTypePrompt({ builtin: true, guide: G, prompt: JUNK }), G)
  })

  it('★★ 自建题型仍然 prompt 压过 guide —— 那是他自己造的一种，prompt 就是它的形状', () => {
    assert.equal(effectiveQTypePrompt({ builtin: false, guide: G, prompt: JUNK }), JUNK)
    assert.equal(effectiveQTypePrompt({ builtin: false, guide: G, prompt: '   ' }), G)
  })

  it('★ 两边都空 → 空串（调用方据此整条跳过，不发一个什么都没说的题型）', () => {
    assert.equal(effectiveQTypePrompt({ builtin: true, guide: '', prompt: JUNK }), '')
    assert.equal(effectiveQTypePrompt({ builtin: false, guide: '', prompt: '' }), '')
  })
})

/**
 * ══ D-486 · 三层补齐那两格（确认单-2026-09-15-三层补齐）════════
 *
 * 产出 → 牌面（`practice.face`）· 认读 → 题型（`reading.qtype`）。
 * 这里钉的还是那句老话：**变了也不报错**的地方 ——
 * 出厂值漂一格、认不出的值抛出去、封顶那个数被改、比对松一格或紧一格。
 */
describe('D-486 · 三层补齐的两个新键', () => {
  it('★★ 出厂值 = 今天唯一的那一种（缺键时行为必须一字不变）', () => {
    assert.equal(PRACTICE_FACE_FACTORY, 'plain')
    assert.equal(READING_QTYPE_FACTORY, 'flip')
    assert.equal(practiceFaceOf(() => null), 'plain')
    assert.equal(readingQTypeOf(() => null), 'flip')
  })

  it('★★ 两个键都进了白名单 —— 不在名单里就写不进去，而且是静默失败', () => {
    for (const key of [QUIZ_RULE_KEYS.practiceFace, QUIZ_RULE_KEYS.readingQType]) {
      assert.ok(PREF_KEYS.includes(key), `「${key}」没进 PREF_SPECS —— checkPrefKey 会当场拒写`)
    }
    assert.equal(PREF_KEYS.length, 29, '★★ 白名单该是 29 项（27 + 这两把）')
  })

  it('★★ 认不出的值回出厂，不抛（老版本 / 别的设备写进来的）', () => {
    assert.equal(practiceFaceOf(() => '第四张牌面'), 'plain')
    assert.equal(readingQTypeOf(() => '听音认词'), 'flip')
  })

  it('★ 存下去的值读得回来', () => {
    assert.equal(practiceFaceOf(() => 'split'), 'split')
    assert.equal(readingQTypeOf(() => 'timed'), 'timed')
  })

  it('★ 三张 / 三行各有屏上字（两端同一份，CR-7）', () => {
    for (const v of ['plain', 'split', 'focus'] as const) {
      assert.ok(PRACTICE_FACE_SAYS[v].name && PRACTICE_FACE_SAYS[v].says, v)
    }
    for (const v of ['flip', 'write', 'timed'] as const) {
      assert.ok(READING_QTYPE_SAYS[v].name && READING_QTYPE_SAYS[v].says, v)
    }
  })
})

describe('D-486 · 限时认读封顶第 2 档', () => {
  it('★★★ 超时 / 看过中文 → 最高「想了一下」（I-083 诚实降档）', () => {
    assert.equal(READING_CAP_GRADE, 2)
    for (const g of [1, 2, 3, 4]) {
      assert.equal(capReadingGrade(g, { timedOut: true }), Math.min(g, 2), `超时那一档：${g}`)
      assert.equal(capReadingGrade(g, { peeked: true }), Math.min(g, 2), `看过中文那一档：${g}`)
    }
  })

  it('★★ 没超时也没看过 → 一个字不动（封顶不许把别的路也压下去）', () => {
    for (const g of [1, 2, 3, 4]) {
      assert.equal(capReadingGrade(g, {}), g)
      assert.equal(capReadingGrade(g, { peeked: false, timedOut: false }), g)
    }
  })

  it('★★ 只封顶、**不抬档** —— 他点「忘了」就是 1', () => {
    assert.equal(capReadingGrade(1, { timedOut: true }), 1)
  })
})

describe('D-486 · 先写再翻的逐字比对', () => {
  it('★★★ 大小写 / 首尾空白 / 标点不计', () => {
    assert.ok(matchesTerm('  Bear the Brunt  ', 'bear the brunt'))
    assert.ok(matchesTerm('bear the brunt.', 'bear the brunt'))
    assert.ok(matchesTerm('BEAR   THE    BRUNT', 'bear the brunt'))
  })

  it('★★★ 词形变化算对（两个方向都要认）', () => {
    assert.ok(matchesTerm('bears', 'bear'), '他写 bears、词头是 bear')
    assert.ok(matchesTerm('bear', 'bears'), '他写 bear、词头是 bears')
    assert.ok(matchesTerm('carried', 'carry'))
  })

  it('★★★ 写的是别的词 → 不算对（松一格就等于白问一次）', () => {
    assert.ok(!matchesTerm('bear the cost', 'bear the brunt'))
    assert.ok(!matchesTerm('brunt', 'bear the brunt'))
    assert.ok(!matchesTerm('', 'bear the brunt'), '空着 = 直接翻，不算写对')
    assert.ok(!matchesTerm('   ', 'bear the brunt'))
  })
})
