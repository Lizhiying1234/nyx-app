/**
 * Assist 查词对照（L-1 ～ L-4 · D-401 立，D-404 改）。钉：
 *   ① 展示层整理器：Markdown 标题/粗体行内标题/纯文本/列表噪音 → 稳定分节
 *     （模型管内容、UI 管呈现 —— 不管模型回什么形状，出来的都是同一种结构）
 *   ② dict 行为：库内释义如实标来源；两头都没有 → miss=true
 *   ③ ★ D-404④ 简明释义的整理：模型加的标题/围栏/引号都要剥掉，
 *     卡片第一行只能是释义本身，且最多两行
 * AI 两级（quick/full）走网络，属第③档真机验收，不在这里假装。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  FULL_LOOKUP_NOTE,
  QUICK_LOOKUP_NOTE,
  assistLookup,
  cleanQuick,
  lastFaceWhy,
  lookupUser,
  parseFace,
  readingFace,
  readingPromptFor,
  revealsAnswer,
  shapeOf
} from '../src/db/lookup.ts'
// ★ `parseAiSections` 2026-09-13 搬进 core（本地那份已删）。下面那几条断言
//   **一个字都没改** —— 它们全绿就是「纯搬家、没改行为」的证据；
//   哪天指针往前挪、core 改了分节行为，这里会先红。
import {
  AI_LOOKUP_NOTE,
  DEFAULT_READING_RULES,
  READING_FACES,
  parseAiSections,
  prefUid,
  serializeFacePrefs
} from '../src/core-link.ts'
import { prefRaw, prefSet } from '../src/db/prefs.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

/**
 * 往库里塞一行「他以前写的出题规则正文」。
 *
 * ★ 走裸 SQL 不走 `prefSet`：2026-09-15（D-482）起 `prompt.reading-card` 已经从
 *   `OVERRIDABLE_PROMPTS` 摘掉，`prefSet` 会当场抛。而**真库里那一行还在** ——
 *   老数据认账要验的正是这种库，所以夹具必须能造出它（照真机抄，不照现在的写入口抄）。
 */
async function seedLegacyPrompt(db: Fixture['db'], text: string): Promise<void> {
  const t = Date.now()
  await db.run(
    `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)
       on conflict(uid) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [prefUid('prompt.reading-card'), 'prompt.reading-card', text, t, t]
  )
}

describe('L · Assist 查词', () => {
  it('L-1 · 整理器：四种模型输出形状 → 同一种分节结构', () => {
    // Markdown 独行标题
    const a = parseAiSections('## Meaning\nto bend\n\n### Example\n- I can flex.\n')
    assert.deepEqual(
      a.map((s) => s.label),
      ['释义', '例句'],
      '英文标题归一化成中文标签'
    )
    assert.equal(a[1]!.text, 'I can flex.', '列表记号剥掉')

    // 粗体行内标题 + 行内噪音
    const b = parseAiSections('**释义**：**弯曲**；灵活处理\n用法：常与 `on` 搭配')
    assert.deepEqual(
      b.map((s) => s.label),
      ['释义', '用法']
    )
    assert.equal(b[0]!.text, '弯曲；灵活处理', '粗体记号剥掉')
    assert.equal(b[1]!.text, '常与 on 搭配', '行内码剥掉')

    // 纯文本（认不出结构）→ 整体一节「释义」
    const c = parseAiSections('flex means to bend or adapt something.')
    assert.equal(c.length, 1)
    assert.equal(c[0]!.label, '释义')

    // 代码围栏整段包裹
    const d = parseAiSections('```\n释义\n弯曲\n```')
    assert.equal(d[0]!.text, '弯曲')
  })

  it('L-1b · ★ 自定小节名原样保留（⑤ 之后提示词是他能改的）', () => {
    /**
     * 2026-09-01 真机上抓到的：认读卡的「讲讲这个词」用的是自定小节名
     * （为什么这句里是这个意思 / 容易和什么混 / 怎么记住），
     * 而 LABEL_MAP 当时是**白名单** —— 三节全塌进「释义」，
     * 而且**标题那行的字被当成了正文**：
     * 屏幕上写着「释义」，底下第一句是「为什么这句里是这个意思」。
     *
     * ★ 这不是「多认几个词」的问题：需求 ⑤ 让提示词可改，
     *   而分节靠白名单 = 他一改小节名，「可改」就只做了一半。
     */
    const a = parseAiSections(
      '为什么这句里是这个意思\n她把事情藏在心里。\n\n容易和什么混\n和 keep in mind 不一样。\n\n怎么记住\n想象含着一颗糖。'
    )
    assert.deepEqual(
      a.map((s) => s.label),
      ['为什么这句里是这个意思', '容易和什么混', '怎么记住'],
      '表里没有的小节名要原样用他写的那个'
    )
    assert.equal(a[0]!.text, '她把事情藏在心里。', '标题那行不许混进正文')

    // 表里有的仍然归一 —— 这一条不能因为放开而失效
    const b = parseAiSections('Meaning\nto bend\n\n怎么记住\n想象一根弹簧。')
    assert.deepEqual(b.map((s) => s.label), ['释义', '怎么记住'])

    // 行内那一档**仍然只认表里的** —— 否则「她说：……」会被切成假小节
    const c = parseAiSections('她说：这件事不要外传。')
    assert.equal(c.length, 1)
    assert.equal(c[0]!.label, '释义', '行内冒号不许当小节名放开')
  })

  it('L-2 · dict：库内释义如实标来源（不冒充词典）', async () => {
    const f = builtDb()
    seed(f) // 种子 term-1 gloss='g'
    const r = await assistLookup(f.db, 'dict', ' Term-1! ', null)
    assert.equal(r.miss ?? false, false)
    assert.deepEqual(
      r.sections.map((s) => s.label),
      ['释义 · NYX 库'],
      '来源写在脸上；没有 gloss_zh 就不出中文节'
    )
    assert.equal(r.sections[0]!.text, 'g')
  })

  it('L-3 · dict：词典没装 + 库内没有 → miss=true（如实说明为什么）', async () => {
    const f = builtDb()
    seed(f)
    const r = await assistLookup(f.db, 'dict', 'serendipity', null)
    assert.equal(r.miss, true)
    assert.equal(r.sections.length, 0)
    assert.ok(r.note?.includes('词典'), '如实说明为什么 miss')
  })

  it('L-4 · 简明释义整理：标题/围栏/引号剥掉，最多两行', () => {
    assert.equal(cleanQuick('释义：灵活的；可变通的'), '灵活的；可变通的', '「释义：」前缀剥掉')
    assert.equal(cleanQuick('```\n**弯曲**；屈曲\n```'), '弯曲；屈曲', '围栏与粗体剥掉')
    assert.equal(cleanQuick('「灵活的」'), '灵活的', '引号剥掉')
    assert.equal(
      cleanQuick('- 灵活的\n- 可变通的\n- 第三行不要'),
      '灵活的\n可变通的',
      '列表记号剥掉；只留两行'
    )
  })
  /**
   * R · 认读卡的 AI 牌面（⑤ ·「AI 决定这张卡怎么考」）。
   * 钉两样：① 提示词约定的两行出来是可解析的 ② **露答案的牌面一定被拦下**。
   * ★ ② 是 D-390（提前露答案 = 违例）的判据本身。它哑了，闸门就是画上去的。
   */
  it('L-6 · ★★ 三句脚注都得带「可能有误」（D-395 诚实原则）', () => {
    // ★ 会出事的场景不是有人删掉整句，而是有人嫌它啰嗦、把「可能有误」四个字
    //   拿掉一句 —— 屏幕上少四个字，行为一点没变，没有任何别的闸会红。
    //   所以这里钉的是**那四个字**，不是整句的措辞。
    // ★ core 那边只钉得到它自己那句（`lookup-sections.test.ts`），
    //   另外两句只有这一端有（Assist 气泡的简明 / 完整档），两边各钉一条才拦得住。
    for (const note of [AI_LOOKUP_NOTE, QUICK_LOOKUP_NOTE, FULL_LOOKUP_NOTE]) {
      assert.ok(note.includes('可能有误'), `脚注「${note}」里没有「可能有误」`)
      assert.ok(note.includes('AI'), `脚注「${note}」里没说这是 AI 写的`)
    }
    // ★ 三句必须互不相同 —— 否则屏上分不出这行字是哪一档来的
    assert.equal(new Set([AI_LOOKUP_NOTE, QUICK_LOOKUP_NOTE, FULL_LOOKUP_NOTE]).size, 3)
  })

  it('R-1 · 牌面两行 → 形式 + 题面', () => {
    const f = parseFace(`形式：挖空
题面：She ____ the offer before dawn, saying nothing.`)!
    assert.equal(f.form, '挖空')
    assert.ok(f.text.startsWith('She ____'), '题面拿得到')
    // 模型爱加围栏/粗体/列表记号 —— 都得剥掉，剥不掉这张卡就废了
    const F = '`'.repeat(3)
    const NL = String.fromCharCode(10)
    const g = parseFace(
      [F, '- **形式**：场景补全', '- **题面**：朋友半夜找你诉苦，你想说「我一直在」。', F].join(NL)
    )!
    assert.equal(g.form, '场景补全')
    assert.ok(g.text.startsWith('朋友半夜'), '围栏与记号剥掉')
    // 一行都对不上 → null（调用方退回机械挖空，不是把噪音当题面）
    assert.equal(parseFace('好的，我来出一道题。'), null)
  })

  it('R-2 · 露答案闸：变形也算露，整词才算', () => {
    // 露了 —— 原样、过去式、进行时
    assert.equal(revealsAnswer('She declined the offer.', 'decline'), true)
    assert.equal(revealsAnswer('He is declining fast.', 'decline'), true)
    assert.equal(revealsAnswer('She ____ the offer.', 'decline'), false, '挖空句是干净的')

    // ★ 子串会误伤的那几个：短词最容易，也最要紧
    assert.equal(revealsAnswer('That was a long time ago.', 'go'), false, 'ago 里的 go 不算')
    assert.equal(revealsAnswer('The government is good.', 'go'), false, 'government/good 不算')
    assert.equal(revealsAnswer('I go there daily.', 'go'), true, '整词的 go 算')
    assert.equal(revealsAnswer('He was unbending.', 'bend'), false, 'unbending 不是露 bend')

    // 短语：整体查
    assert.equal(revealsAnswer('He kept ____ over backwards.', 'bend over backwards'), false)
    assert.equal(revealsAnswer('He kept bend over backwards.', 'bend over backwards'), true)

    // 中译回想型：牌面全中文，英文没露 → 放行
    assert.equal(revealsAnswer('她把这件事藏在心里，用英语怎么说？', 'keep to oneself'), false)
  })
})

/**
 * L-5 · 选中什么就处理什么（2026-09-03 使用者报「选一整句，只讲里面一个词组」）
 *
 * 查下来不是截断 —— 整句一个字没少地走到了 `assistLookup`。
 * 病在**怎么跟模型说这段话**：user 段写死成 `词：<整句>`，
 * 三份默认提示词又都说「用户给你一个单词或短语」。
 * 所以这一组钉的是：形态认得对、原文一个字不改地送出去、话说清楚。
 */
describe('L-5 · 选中内容的形态', () => {
  it('一个词 / 一个词组 / 一整句 / 一整段，分得开', () => {
    assert.equal(shapeOf('brunt'), 'word')
    assert.equal(shapeOf('  bear the brunt  '), 'phrase')
    assert.equal(shapeOf('figure out'), 'phrase')
    assert.equal(
      shapeOf("I couldn't figure out what he was trying to say."),
      'sentence',
      '★ 使用者原话里的那一句 —— 判成词组就又会只讲 figure out'
    )
    assert.equal(shapeOf('He left. She stayed.'), 'passage')
    assert.equal(shapeOf('第一行\n第二行'), 'passage')
  })

  it('空串不炸', () => {
    assert.equal(shapeOf(''), 'word')
    assert.equal(shapeOf('   '), 'word')
  })

  it('★★ 原文一个字都不许改 —— user 段里必须出现完整的那一句', () => {
    const s = "I couldn't figure out what he was trying to say."
    const u = lookupUser(s, null)
    assert.ok(u.includes(s), `原文被动过了：${u}`)
    assert.match(u, /一整句话/, '没告诉模型这是一整句')
    assert.match(u, /不许只挑其中某一个词或词组/, '没拦住「挑一个词讲」')
  })

  it('★ 词 / 词组照旧带上下文句子，整句整段不再重复贴一遍', () => {
    const ctx = 'Coastal towns bear the brunt of these storms.'
    assert.match(lookupUser('bear the brunt', ctx), /它出现在这句话里：/)
    // 整句本身就是上下文 —— 再贴一遍会被当成另一段要讲的东西
    assert.doesNotMatch(lookupUser(ctx, ctx), /它出现在这句话里：/)
  })

  it('★ 词没有上下文时如实说「没有」—— 空着模型会自己编一句', () => {
    assert.match(lookupUser('brunt', null), /没有上下文句子/)
  })

  it('★★ 三份默认提示词都不许再说「给你一个单词或短语」', async () => {
    const m = await import('../src/db/lookup.ts')
    for (const [name, text] of [
      ['DEFAULT_AI_PROMPT', m.DEFAULT_AI_PROMPT],
      ['DEFAULT_QUICK_PROMPT', m.DEFAULT_QUICK_PROMPT],
      ['DEFAULT_SEARCH_PROMPT', m.DEFAULT_SEARCH_PROMPT]
    ] as [string, string][]) {
      assert.doesNotMatch(text, /给你一个英语单词或短语/, `${name} 还在把输入说成一个词`)
      assert.match(text, /整句|整段/, `${name} 没交代整句整段怎么处理`)
    }
  })
  /**
   * ★★ R-3 · **一面都没勾 → 不叫 AI，退回机械挖空**（D-479）
   *
   * 「不兜底」是这一条的全部意思：他把四面全取消，机器不许偷偷按全开出题 ——
   * 那是「我的选择不算数」。而 D-338 又要求失败一律安静退回，
   * 于是这件事在屏幕上和「AI 超时了」长得一模一样 —— 账得有地方看，就是 `why`。
   */
  it('R-3 · 一面都没勾：不叫 AI、退回机械挖空，账上写着 no-faces', async () => {
    const f = builtDb()
    await prefSet(
      f.db,
      'reading.faces',
      serializeFacePrefs(READING_FACES.map((x) => ({ id: x.id, on: false })))
    )
    assert.equal(
      await readingPromptFor(f.db, 'bear the brunt', null, null, null),
      null,
      '★ core 回 null；这一端不许自己兜一份全开的出来'
    )
    // 这台机器上没配 AI —— 但这条路**根本走不到那一步**，所以 why 必须是 no-faces
    assert.equal(await readingFace(f.db, 'bear the brunt', null, null, null), null)
    assert.equal(
      lastFaceWhy,
      'no-faces',
      '★★ 记成 ai-failed 就等于把「他取消了牌面」说成「AI 坏了」'
    )
  })

  /**
   * ★★★ R-5 · 自建牌面必须真的拼进提示词（使用者 2026-09-14 第一条「新建牌面」）
   *
   * ── 为什么非有这条闸不可 ────────────────────────────────
   * `buildReadingPrompt` 的签名是**向后兼容**的：`(string | FacePref)[]`。
   * 所以 `readingPromptFor` 里写 `onFaceIds`（只递 id）**照样编译、照样返回一个
   * 对象、照样不报错** —— 2026-09-14 挪 core 指针那一趟 `svelte-check` 就是
   * **0 errors**，而那时候调用点还是老写法。
   *
   * 症状全在屏幕之外：自建那一面的正文（名字 / 给他看什么 / 给 AI 那段）**没有表可放**，
   * 只在 `reading.faces` 这条偏好里。只递 id 的话，拼装那一步 `faceById(id)` 查不回来，
   * 那一面被**静默丢掉** —— 他在电脑上建了一面、勾上了，手机出题时当它不存在。
   *
   * ☞ 也就是说：**这一行只有这条闸守得住。** 类型不管、编译不管、别的用例也不管。
   *
   * ★ 挪指针那天我先证过这个 bug 是真的（拿新 core 并排跑两种写法）：
   *   `onFaceIds` → 自建那面的 guide 不在 system 里；`onFaces` → 在。两者都不抛。
   */
  it('R-5 · 自建那一面的正文要出现在 system 里（只递 id 的老写法会静静丢掉它）', async () => {
    const f = builtDb()
    const GUIDE = '★这一面：拿中文问英文，只许写一个词'
    await prefSet(
      f.db,
      'reading.faces',
      serializeFacePrefs([
        { id: 'zh-recall', on: true },
        { id: 'u:1', on: true, custom: { name: '我自己建的', says: '给他看中文', guide: GUIDE } }
      ])
    )
    const p = await readingPromptFor(f.db, 'flex', null, null, null)
    assert.ok(p, '★ 勾着两面，不该回 null')
    assert.ok(
      p!.system.includes(GUIDE),
      '★★ 自建那一面没进提示词 —— 多半是调用点退回了 `onFaceIds`（只递 id）'
    )
    // ★ 出厂那一面照旧在，别为了接自建面把内置的挤掉
    const zh = READING_FACES.find((x) => x.id === 'zh-recall')!
    assert.ok(p!.system.includes(zh.guide), '★ 出厂面丢了')
  })

  it('★ R-5b · 自建面缺正文 → 那一面不算数，但不许连累别的面', async () => {
    // ★ core 的 `resolveFace`：名字或 guide 缺一个就回 null（勾了一个对模型什么都没说的
    //   考法，比少一面糟）。这一端要确认那种「半条」不会把整次拼装拖垮。
    const f = builtDb()
    await prefSet(
      f.db,
      'reading.faces',
      serializeFacePrefs([
        { id: 'zh-recall', on: true },
        { id: 'u:2', on: true, custom: { name: '只有名字', says: '', guide: '' } }
      ])
    )
    const p = await readingPromptFor(f.db, 'flex', null, null, null)
    assert.ok(p, '★ 还有一面是好的，不该整个回 null')
    const zh = READING_FACES.find((x) => x.id === 'zh-recall')!
    assert.ok(p!.system.includes(zh.guide), '★ 好的那一面被半条坏的连累了')
  })

  /**
   * ★★ R-4 · 老那份整段提示词的一次性迁移（D-479 · 判据在 core，这一端只调它）
   *
   * 迁移做错的症状全是安静的：认错考法 = 他的卡换了考法；不幂等 = 第二次迁移
   * 拿出厂规则盖掉他改过的正文；不迁 = 他的老提示词永远躺着没人读。
   */
  it('R-4 · 迁移：认出考法 → 勾上那一面；正文原样留着；记号幂等；认不出一个字不动', async () => {
    const f = builtDb()
    // 老那份「只用一种形式：中译回想」的整段提示词躺在 prompt.reading-card 里
    await seedLegacyPrompt(f.db, '……只用一种形式：中译回想，别的都不要。')
    await readingPromptFor(f.db, 'x', null, null, null)

    const faces = JSON.parse(String(await prefRaw(f.db, 'reading.faces'))) as { id: string; on: boolean }[]
    assert.deepEqual(
      faces.filter((x) => x.on).map((x) => x.id),
      ['zh-recall'],
      '★ 认出是哪种考法，就只勾那一面'
    )
    /**
     * ★★ 2026-09-15（D-482）改判：**不再回写规则正文**。
     *   规则现在由三个选项决定，正文不参与拼装；他那段原样留在库里，
     *   认读设置页只读展示（`legacyReadingRules`）。
     *   原来这里钉的是「规则回出厂」—— 那条连同回写一起退役了。
     */
    assert.equal(
      await prefRaw(f.db, 'prompt.reading-card'),
      '……只用一种形式：中译回想，别的都不要。',
      '★★ 他那段正文被动过了 —— 退役的是输入方式，不是他写的东西'
    )
    /**
     * ★ 记号是 DEVICE（`settings`，不同步）—— 2026-09-09 跟 core 搬的家（`bec53da`），
     *   所以这里查的是 settings 表，不是偏好表（查错表会永远绿）。
     * ★★ 下面那条反向断言不是凑数：**只查 settings 的话，谁把它挪回偏好这条照样绿。**
     */
    const mark = await f.db.get(`select value from settings where key = ?`, [
      'reading.facesMigratedAt'
    ])
    assert.ok(mark?.['value'], '记号落下来了（在 settings 里）')
    assert.equal(
      await prefRaw(f.db, 'reading.facesMigratedAt'),
      null,
      '★★ 记号跑进偏好里了 —— 它会跟着同步走，两台机器算出同一个 uid 必然撞车（S7）'
    )

    // ★ 幂等：记号在，第二次就该整个跳过（连牌面都不该再动）
    await prefSet(
      f.db,
      'reading.faces',
      serializeFacePrefs(READING_FACES.map((x) => ({ id: x.id, on: x.id === 'cloze' })))
    )
    await readingPromptFor(f.db, 'x', null, null, null)
    const again = JSON.parse(String(await prefRaw(f.db, 'reading.faces'))) as { id: string; on: boolean }[]
    assert.deepEqual(
      again.filter((x) => x.on).map((x) => x.id),
      ['cloze'],
      '★★ 记号在就不该再迁一次 —— 迁两次会把他后来勾的那几面盖掉'
    )

    // ★ 认不出来的（他自己写的）→ 一个字都不动
    const g = builtDb()
    await seedLegacyPrompt(g.db, '我自己写的一段，不像任何一份老预设。')
    await readingPromptFor(g.db, 'x', null, null, null)
    assert.equal(await prefRaw(g.db, 'prompt.reading-card'), '我自己写的一段，不像任何一份老预设。')
    assert.equal(await prefRaw(g.db, 'reading.faces'), null, '★ 认不出就别替他勾任何一面')
  })

  /**
   * ★★ R-4b · 搬家之前写下的那一行旧记号（2026-09-14 合 master 时钉的）
   *
   * 记号 2026-09-09 从偏好搬进 `settings`。他手机上的真库里**早就有**
   * `user_preferences['reading.facesMigratedAt']` —— T-9.18 之后每一版都在写。
   * 搬家那天如果只看 `settings`，这台机器会被当成「没迁过」，于是在**他的真库上**
   * 再跑一次迁移。按「认内容」那条它多半什么都不动，**但「多半」不是判据**。
   *
   * ★ 这条钉的是「认账」而不是「重迁完再盖个新戳」：断言要的是**旧那个时间戳本身**，
   *   落个 `Date.now()` 一样能让「settings 里有值」绿，却已经白迁过一次了。
   * ★ 旧那一行不删 —— 同步表上不许裸 delete（D-436）。
   */
  it('R-4b · 旧记号在偏好里 → 认账落到 settings，不在他的真库上再迁一次', async () => {
    const f = builtDb()
    // 他后来自己改过的规则正文：迁移再跑一次的话，会把他勾的牌面盖掉
    await seedLegacyPrompt(f.db, '我自己写的一段，不像任何一份老预设。')
    // 搬家之前那一版写下的记号：直接落偏好表（那时它在白名单里，prefSet 现在会抛）
    const t = Date.now() - 86_400_000
    await f.db.run(
      `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      [prefUid('reading.facesMigratedAt'), 'reading.facesMigratedAt', String(t), t, t]
    )

    await readingPromptFor(f.db, 'x', null, null, null)

    const mark = await f.db.get(`select value from settings where key = ?`, [
      'reading.facesMigratedAt'
    ])
    assert.equal(
      mark?.value == null ? null : String(mark.value),
      String(t),
      '★★ 旧记号没被认账 —— 这台机器被当成「没迁过」，会在他的真库上白跑一次迁移'
    )
    assert.equal(await prefRaw(f.db, 'reading.faces'), null, '★ 接旧值那一趟不许顺手替他勾面')
  })
})
