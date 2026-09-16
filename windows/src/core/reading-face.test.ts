import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { READING_RULES_FACTORY } from './quiz-rules.ts'
import {
  buildReadingPrompt,
  CUSTOM_PREFIX,
  DEFAULT_FACE_IDS,
  DEFAULT_READING_RULES,
  FACE_NAME_MAX,
  isCustomFaceId,
  migrateLegacyReadingPrompt,
  newFaceId,
  onFaceIds,
  onFaces,
  parseFace,
  parseFacePrefs,
  READING_FACES,
  readingFaceUser,
  resolveFace,
  revealsAnswer,
  serializeFacePrefs
} from './reading-face.ts'

/**
 * 认读牌面 · 判据用例
 *
 * 这些不是「覆盖率」用例，是**两端一致性的锚**：
 * 手机上那份跑了两天的实现（`Nyx-Android/src/db/lookup.ts`）在往这里合并，
 * 合并过程中最容易发生的事就是「行为悄悄变了一点」。
 * 下面每一条都钉的是那种「变了也不报错」的地方。
 */
describe('认读牌面 · 露答案红线（D-390）', () => {
  it('原样出现 = 露了', () => {
    assert.equal(revealsAnswer('She had to bear the brunt of it.', 'bear the brunt'), true)
  })

  it('★ 按整词查，不按子串 —— 否则短词永远判成露答案，这个功能等于没做', () => {
    // `go` 出现在 ago / good / government 里，但它们都不是 go
    assert.equal(revealsAnswer('A long time ago, the government was good.', 'go'), false)
    assert.equal(revealsAnswer('I have to go now.', 'go'), true)
  })

  it('常见变形也要拦 —— 只拦原形等于没拦', () => {
    for (const s of ['She bends the rules.', 'He bended it.', 'They are bending it.']) {
      assert.equal(revealsAnswer(s, 'bend'), true, s)
    }
    // 反过来：unbending 不是 bend，别误伤
    assert.equal(revealsAnswer('An unbending rule.', 'bend'), false)
  })

  it('空词条不算露答案（否则每一张都作废）', () => {
    assert.equal(revealsAnswer('anything at all', '   '), false)
  })
})

describe('认读牌面 · 两行格式', () => {
  it('正常两行', () => {
    const f = parseFace('形式：挖空\n题面：She had to ____ of the criticism.')
    assert.deepEqual(f, { form: '挖空', text: 'She had to ____ of the criticism.' })
  })

  it('AI 加了 markdown 修饰 / 代码围栏 —— 照样读得出来', () => {
    const f = parseFace('```\n- **形式**：场景补全\n- **题面**：Your team missed the deadline.\n```')
    assert.equal(f?.form, '场景补全')
    assert.equal(f?.text, 'Your team missed the deadline.')
  })

  it('题面折行 —— 接上，不截断', () => {
    const f = parseFace('形式：场景补全\n题面：第一行\n第二行')
    assert.equal(f?.text, '第一行 第二行')
  })

  it('★ 没有题面 = 这一版作废（返回 null，界面退回机械挖空）', () => {
    assert.equal(parseFace('形式：挖空'), null)
    assert.equal(parseFace('随便说了点什么，一行都不合格式'), null)
  })

  it('只给了题面没给形式 —— 补「挖空」，不空着', () => {
    assert.equal(parseFace('题面：She had to ____ it.')?.form, '挖空')
  })
})

const LF = String.fromCharCode(10)

/**
 * 比较用的归一化：把所有空白挤掉。
 *
 * ★ 为什么不逐字比：guide 的行前面带两个空格，粘进规则时缩进多半会变（或者被
 *   编辑器重排）。逐字比的话，**改一个空格就能绕过这道闸** —— 那种闸不如没有。
 */
const squeeze = (s: string): string => s.replace(/\s+/g, '')

/** 一面身上所有「给人 / 给 AI 的内容」行。太短的行不比（怕撞上规则里的常用短句） */
const faceLines = (f: { says: string; guide: string }): string[] =>
  [f.says, ...f.guide.split(LF)].map((x) => x.trim()).filter((x) => squeeze(x).length >= 8)

describe('★★★ D-479 · 牌面与出题规则分开', () => {
  /**
   * ★★ 下面两条逐行判据都建立在这上面：**没有两面共用同一行**。
   *   真共用了的话，「没勾这一面，它的行却在提示词里」就会是假红 ——
   *   而假红的闸用不了几次就会被人放宽。所以先把这件事本身钉住。
   */
  it('★★ 四面之间没有一行是重复的（逐行判据的前提）', () => {
    const seen = new Map<string, string>()
    for (const f of READING_FACES) {
      for (const line of faceLines(f)) {
        const k = squeeze(line)
        const owner = seen.get(k)
        assert.equal(owner, undefined, `「${f.name}」和「${owner}」共用了这一行：${line}`)
        seen.set(k, f.name)
      }
    }
  })

  it('★ 出厂四个牌面：id 与名字都不重复，每一面都说得出「给他看什么」', () => {
    assert.equal(READING_FACES.length, 4, '牌面条数变了就要有人交代为什么')
    assert.equal(new Set(READING_FACES.map((f) => f.id)).size, 4, 'id 重了 —— 界面按它做 key')
    assert.equal(new Set(READING_FACES.map((f) => f.name)).size, 4, '名字重了')
    for (const f of READING_FACES) {
      assert.ok(f.says.trim().length > 0, `${f.id} 没说这一面给他看什么`)
      assert.ok(f.guide.trim().length > 0, `${f.id} 没有给 AI 的内容说明`)
    }
  })

  it('★★★ 规则里只有规则：一句牌面的内容说明都不许有（**逐行**比）', () => {
    /**
     * 这一条盯的是**这次重构的意义本身**。规则里一旦又粘进「这一面写什么」，
     * 就退回了老那五份整段提示词的样子：想多来一种就得再抄一遍规则，
     * 而抄错一个字，两份的红线就不一样了。
     *
     * ★★★ 2026-09-08 · 主控的对照打穿了第一版：它比的是 `includes(f.guide)`，
     *   也就是**整段**。往规则里粘「中译回想」guide 的**第一行**，21 条照样全绿 ——
     *   而那正是最可能真发生的形状（谁会一次抄三行？粘一句就够把两层粘回一层）。
     *   所以判据改成**逐行**：每一面的 `says` 加 `guide` 的每一行，
     *   任何一行落进规则里就红。
     */
    for (const f of READING_FACES) {
      for (const line of faceLines(f)) {
        assert.ok(
          !squeeze(DEFAULT_READING_RULES).includes(squeeze(line)),
          `★★★ 出厂规则里粘进了「${f.name}」的内容说明（这一行）：${line}${LF}` +
            '  —— 两层又变回一层了。内容归 READING_FACES，规则里一个字都不留。'
        )
      }
    }
  })

  it('★ 规则里必须留着那两行输出格式与那条红线（少了牌面一律解析不出来）', () => {
    assert.ok(DEFAULT_READING_RULES.includes('形式：'), '规则里没写「形式：」那一行')
    assert.ok(DEFAULT_READING_RULES.includes('题面：'), '规则里没写「题面：」那一行')
    assert.ok(
      DEFAULT_READING_RULES.includes('绝对不许出现这个表达本身'),
      '规则里少了「题面不许出现答案」那条红线（D-390）'
    )
  })

  it('★★★ 勾三面 → 提示词里恰好这三面，**逐行**（负向对照盯这一条）', () => {
    /**
     * ★★★ 这里原来也是 `system.includes(f.guide)` 整段比，和上面那条同一个毛病：
     *   勾了的面**只拼进去半段**（比如 guide 被截断、或者哪天改成「摘要一行」），
     *   `want=true` 那一侧当场变红没错 —— 但 `want=false` 那一侧会**放过**
     *   「没勾的面漏进来一行」。两侧都改成逐行。
     */
    const three = ['cloze', 'scenario', 'define']
    const out = buildReadingPrompt(READING_RULES_FACTORY, three, 'bear the brunt', '承受', '原句', null)
    assert.ok(out, '勾了三面却拼不出提示词')
    const sys = squeeze(out!.system)
    for (const f of READING_FACES) {
      const want = three.includes(f.id)
      for (const line of f.guide.split(LF)) {
        if (squeeze(line).length < 8) continue
        assert.equal(
          sys.includes(squeeze(line)),
          want,
          want
            ? `★★★ 勾了「${f.name}」，提示词里却少了这一行：${line.trim()}`
            : `★★★ 没勾「${f.name}」，这一行却混进了提示词：${line.trim()}`
        )
      }
    }
  })

  it('★★★ 一面都不勾 → 拼不出来（返回 null，调用方不许兜底）', () => {
    assert.equal(buildReadingPrompt(READING_RULES_FACTORY, [], 'x', null, null, null), null)
    assert.equal(
      buildReadingPrompt(READING_RULES_FACTORY, ['不存在的面'], 'x', null, null, null),
      null,
      '认不出的 id 不该被当成一面'
    )
  })

  /**
   * ★★★ 老那条「他改过的规则照用；规则空了才退回出厂」**2026-09-15 作废**（D-482）。
   *
   * 那条判据钉的是「正文参与拼装」，而这一轮他裁的正是**不再写正文、改点选项**。
   * 留着它就是在钉一个已经不存在的行为；换成下面这条 ——
   * 出厂选项拼出来的那一份，逐字等于 `DEFAULT_READING_RULES`。
   */
  it('★★ 出厂选项拼出来的 = DEFAULT_READING_RULES（两处不许各算各的）', () => {
    const built = buildReadingPrompt(READING_RULES_FACTORY, ['cloze'], 'x', null, null, null)
    assert.ok(built!.system.startsWith(DEFAULT_READING_RULES))
  })

  it('★★ 存下来的勾选读得回来；认不出的丢掉、缺的按出厂补在后面', () => {
    const mine = [
      { id: 'define', on: true },
      { id: 'cloze', on: false }
    ]
    const back = parseFacePrefs(serializeFacePrefs(mine))
    assert.deepEqual(back.slice(0, 2), mine, '★ 他排的顺序与开关变了')
    assert.equal(back.length, READING_FACES.length, '缺的没按出厂补上')
    assert.deepEqual(onFaceIds(back).slice(0, 1), ['define'])

    assert.deepEqual(parseFacePrefs(null).map((f) => f.id), [...DEFAULT_FACE_IDS], '没设过 → 出厂全开')
    assert.deepEqual(parseFacePrefs('{不是 json').map((f) => f.on), [true, true, true, true], '坏数据退化成全开，不抛')
    assert.ok(
      !parseFacePrefs(JSON.stringify([{ id: '不存在', on: true }])).some((f) => f.id === '不存在'),
      '认不出的 id 被当成一面了'
    )
  })

  it('★★★ 迁移：老那份「中译回想」→ 勾上对应牌面 + 规则回出厂', () => {
    const legacy = '你在给一个中文母语者出一张英语「认读卡」的题面。**用一种形式：中译回想。**'
    const got = migrateLegacyReadingPrompt(legacy)
    assert.deepEqual(got?.faceIds, ['zh-recall'])
    assert.equal(got?.rules, DEFAULT_READING_RULES)
  })

  it('★★★ 迁移认不出来就一个字都不动（他自己写的那份不许被猜掉）', () => {
    assert.equal(migrateLegacyReadingPrompt('我自己从头写的提示词，随便怎么出题'), null)
    assert.equal(migrateLegacyReadingPrompt(''), null)
    assert.equal(migrateLegacyReadingPrompt(null), null)
  })

  it('★ 迁移：老「综合」那份 → 四面全勾（它本来就是三种形式挑一种）', () => {
    const got = migrateLegacyReadingPrompt('三种形式，**按这个顺序挑**：')
    assert.deepEqual(got?.faceIds, [...DEFAULT_FACE_IDS])
  })
})

describe('认读牌面 · user 段', () => {
  it('三样都给：表达 / 意思 / 原句', () => {
    const u = readingFaceUser('bear the brunt', 'to take the worst part', 'Coastal towns bear it.')
    assert.match(u, /bear the brunt/)
    assert.match(u, /to take the worst part/)
    assert.match(u, /Coastal towns bear it\./)
  })

  it('★ 缺的那一样要**说出来**，不能留空 —— 留空 AI 会自己编一个原句', () => {
    const u = readingFaceUser('bear the brunt', null, '   ')
    assert.match(u, /没有释义/)
    assert.match(u, /没有原句/)
  })
})


/**
 * ══ 自建牌面（使用者 2026-09-14 第一条）═══════════════════════════
 *
 * 他要的是「在这里直接创建新的认读测试牌面」。正文没有表可放 ——
 * 它跟着 `reading.faces` 这条**同步偏好**走（理由写在 reading-face.ts 里）。
 *
 * ★ 这一组钉的全是「**会无声丢数据 / 无声失效**」的那几处：
 *   一处写漏，屏幕上只表现为「我建的那一面怎么不见了」或者
 *   「勾上了却从来没出过这种题」—— 两样都不报错。
 */
describe('★★★ 自建牌面 · 正文跟着偏好走，一处写漏就无声没了', () => {
  const mine = {
    id: CUSTOM_PREFIX + 'abc',
    on: true,
    custom: { name: '造句', says: '给一个处境，自己造一句', guide: '造句 —— 给一个需要用到它的处境。' }
  }

  it('★★★ 存一次再读回来，正文一个字不少（序列化写漏 = 建完就没）', () => {
    const back = parseFacePrefs(serializeFacePrefs([mine]))
    const got = back.find((f) => f.id === mine.id)
    assert.ok(got, '自建那一面读不回来了')
    assert.deepEqual(got.custom, mine.custom)
  })

  it('★★ 出厂那四面照样在，而且缺的按出厂补在后面', () => {
    const back = parseFacePrefs(serializeFacePrefs([mine]))
    for (const f of READING_FACES) assert.ok(back.some((x) => x.id === f.id), `${f.name} 掉了`)
    assert.equal(back[0]?.id, mine.id, '他排的顺序没保住')
  })

  it('★★★ 没有「给 AI 的说明」的那一面**整条丢掉** —— 勾上它等于勾了个什么都不说的面', () => {
    const empty = { id: CUSTOM_PREFIX + 'x', on: true, custom: { name: '空', says: '', guide: '   ' } }
    assert.equal(resolveFace(empty), null)
    assert.equal(parseFacePrefs(serializeFacePrefs([empty])).some((f) => f.id === empty.id), false)
  })

  it('★★ 没名字的也丢掉 —— 屏上那一档会是空的', () => {
    const noname = { id: CUSTOM_PREFIX + 'y', on: true, custom: { name: ' ', says: '', guide: '写点什么' } }
    assert.equal(resolveFace(noname), null)
  })

  it('★★ 只有 id、没带正文的自建条目也丢掉（另一台设备上删了它）', () => {
    assert.equal(resolveFace({ id: CUSTOM_PREFIX + 'z', on: true }), null)
  })

  it('★★ 名字读回来时截到上限 —— 长过了出题那一行会被 parseFace 截断', () => {
    const long = {
      id: CUSTOM_PREFIX + 'w',
      on: true,
      custom: { name: '一二三四五六七八', says: '', guide: 'g' }
    }
    const got = parseFacePrefs(serializeFacePrefs([long])).find((f) => f.id === long.id)
    assert.equal(got?.custom?.name.length, FACE_NAME_MAX)
  })

  it('★★★ 拼提示词时自建那一面真的进去了（只传 id 的话它会被静静丢掉）', () => {
    const built = buildReadingPrompt(READING_RULES_FACTORY, onFaces([mine]), 'counter', null, null, null)
    assert.ok(built, '一面都没拼出来')
    assert.match(built.system, /造句 —— 给一个需要用到它的处境。/)
  })

  it('★★★ 只传 id 的老写法**拼不出**自建那一面 —— 这正是 onFaces 存在的理由', () => {
    const built = buildReadingPrompt(READING_RULES_FACTORY, onFaceIds([mine]), 'counter', null, null, null)
    assert.equal(built, null, '只给 id 却拼出来了？那 resolveFace 那一路是假的')
  })

  it('★★ 出厂那四个 id 永远不算自建 —— 撞上了就会被当成可删可改的', () => {
    for (const f of READING_FACES) assert.equal(isCustomFaceId(f.id), false, f.id)
    assert.equal(isCustomFaceId(CUSTOM_PREFIX + '1'), true)
  })

  it('★★ 新 id 不和已有的撞（同一毫秒连建两面）', () => {
    const a = newFaceId(1700000000000, [])
    const b = newFaceId(1700000000000, [a])
    assert.notEqual(a, b)
    assert.ok(isCustomFaceId(a) && isCustomFaceId(b))
  })

  it('★★ 一样什么垃圾都不抛', () => {
    for (const bad of ['[{"id":"u:1"}]', '[{"id":"u:1","custom":5}]', '[{"id":"u:1","custom":{}}]']) {
      assert.doesNotThrow(() => parseFacePrefs(bad))
      assert.equal(parseFacePrefs(bad).some((f) => isCustomFaceId(f.id)), false, bad)
    }
  })
})
