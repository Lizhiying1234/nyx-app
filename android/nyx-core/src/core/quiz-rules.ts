/**
 * 出题规则 · 点选项代替写正文 —— **两端唯一一份**（D-482，使用者 2026-09-15）
 *
 * 判据 = `docs/ui/确认单-2026-09-15-出题规则选项与首次引导.md`
 * （使用者原话「全部按照推荐的来」）。下面每一句**英文原句都逐字抄自那份确认单**，
 * 因为那才是他裁过的东西；改一个字要先回报，不能顺手润色。
 *
 * ══ 这一轮改的是「输入方式」，不是判据 ★★★ ════════════════
 *
 * 以前：认读那份出题规则是**一整段正文**，他要自己写；产出那边每个题型
 * 也各有一个正文框。于是「怎么考」这件事的真相藏在一段自由文本里 ——
 * 软件读不懂它，也没法告诉他「你现在选的是哪一种考法」。
 *
 * 现在：七个选项。**选项决定往模板里拼哪几句**（提示词仍然是文件，D-213）。
 * 正文那两处（`prompt.reading-card` 与 `qtypes.prompt`）**一行都不删**（D-216），
 * 只是设置页不再给编辑框 —— 老数据怎么认账在 `main/reading-faces.ts` 那一段。
 *
 * ══ 为什么七个键都是 USER ══════════════════════════════════
 *
 * 按 `core/prefs.ts` 开头那句判据问：「换一台设备，这一项应该自动恢复吗？」
 * 「我要怎么被考」**应该** —— 它是他想要的东西，不是这台机器怎么实现。
 * 所以七个都进 `PREF_SPECS`、跟着人走。★ 手机**也有**产出练习的设置页
 * （Settings › PROMPTS ›「题型」→「全部题型」→ 编辑；Nyx-UI-Android 2026-09-15 核出来的，
 * 在那之前这几处都写着「手机没有」——**错了四个月没人发现，因为注释不会红**）。
 * 所以那四个键在两端都有人改，靠同步收敛，不是「一端设、另一端跟」。
 *
 * ══ 为什么能做成选项的只有七个 ═════════════════════════════
 *
 * 确认单 §零 查出来的事：认读那份出厂正文三段里，**只有第 2 段是规则**
 * （第 1 段交代身份、第 3 段是 D-390 / D-338 的硬约束，两段都永远拼进去）。
 * 而「考什么」早就由牌面管了（D-479），所以选项只能管「怎么考」。
 * 没凑数 —— 使用者原话「不要为了增加选项而增加没有实际价值的规则」。
 */

/** 换行。和 `reading-face.ts` 同一个写法：转义少一层就少一处出错 */
const LF = String.fromCharCode(10)

// ══════════════════════════════════════════════════════════════
// 一、七个选项的形状与出厂值
// ══════════════════════════════════════════════════════════════

/** R-1 · 同一条知识点，每次用哪张牌面来问 */
export type FacePick = 'quote-first' | 'rotate' | 'random'
/** R-2 · 认读题面给多少线索 */
export type ReadingHint = 'more' | 'normal' | 'less'
/** W-1 · 产出题给多少辅助材料。★ 目标表达那一行三档都给（D-137） */
export type PracticeHint = 'full' | 'gloss-only' | 'none'
/** W-2 · 题目场景离他收它的那篇材料有多远 */
export type ContextSpread = 'near' | 'mixed' | 'far'

/**
 * ══ 三层补齐那两格 · D-486（确认单-2026-09-15-三层补齐）★★★ ══════
 *
 * 使用者 2026-09-15 第二 / 三 / 六条要「认读与产出各自都看得见牌面 · 题型 · 出题规则」。
 * 今天缺的正好是**对角的两格**：
 *
 *   产出 → 牌面   `practice.face`  一道产出题**在屏幕上摆成什么样**
 *   认读 → 题型   `reading.qtype`  拿到这张牌面之后**要做出什么动作**才算「认出了」
 *
 * ★★ 两格都**只动这一侧**：
 *   `practice.face` 只动渲染 —— **不新增任何 AI 侧的信息**。
 *     （确认单 §零 ④：把释义 / 原句常驻卡面 = 一个免费的提示，会安静抹掉 D-138 的价格
 *       ——「需要提示」那颗按下去要记一次认读失败并打回间隔，而屏幕上什么都不会说。）
 *   `reading.qtype` 只动这一侧的交互 —— AI 那一侧一个字不改，四张牌面出的题面三种都答得了。
 *
 * ★★ 两格都**不可自建**（确认单 §零 ②）：老的两格（自建牌面 / 自建题型）装的是
 *   **一段给 AI 的字**，写完拼进提示词就生效；这两格装的是**交互与排版**，
 *   那是代码 —— 没法用一段文字描述出一个输入框或一种版式。
 *
 * ★ 没有迁移、没有记号：这两个概念今天不存在，库里没有任何一行是它们的前身。
 *   缺键 → 回出厂 → **行为一字不变**（确认单 §四 ①）。
 */

/** 产出的牌面：整块 / 分栏 / 专注。出厂 `plain` = 今天唯一的样子 */
export type PracticeFace = 'plain' | 'split' | 'focus'

/** 认读的题型：翻卡自评 / 先写再翻 / 限时认读。出厂 `flip` = 今天唯一的形态 */
export type ReadingQType = 'flip' | 'write' | 'timed'

/** 理解层三个选项 */
export interface ReadingRules {
  facePick: FacePick
  hintLevel: ReadingHint
  /** R-3 · 编场景时换个场合。★ 只对「场景补全」那一面有意义 */
  shiftContext: boolean
}

/** 写作层四个选项 —— **全局，不按题型**（确认单 §二 ①） */
export interface PracticeRules {
  hintLevel: PracticeHint
  contextSpread: ContextSpread
  requireFullSentence: boolean
  matchRegister: boolean
}

export const PRACTICE_FACE_FACTORY: PracticeFace = 'plain'
export const READING_QTYPE_FACTORY: ReadingQType = 'flip'

/** 出厂值 = 确认单的「推荐」那一列（使用者「全部按照推荐的来」） */
export const READING_RULES_FACTORY: ReadingRules = {
  facePick: 'quote-first',
  hintLevel: 'normal',
  shiftContext: true
}

export const PRACTICE_RULES_FACTORY: PracticeRules = {
  hintLevel: 'full',
  contextSpread: 'mixed',
  requireFullSentence: true,
  matchRegister: true
}

/** 七个键名。**只在这里写一次** —— 偏好白名单、设置页、迁移都从这里取 */
export const QUIZ_RULE_KEYS = {
  facePick: 'reading.facePick',
  readingHint: 'reading.hintLevel',
  shiftContext: 'reading.shiftContext',
  practiceHint: 'practice.hintLevel',
  contextSpread: 'practice.contextSpread',
  requireFullSentence: 'practice.requireFullSentence',
  matchRegister: 'practice.matchRegister',
  /** ★ D-486 · 三层补齐那两格 */
  practiceFace: 'practice.face',
  readingQType: 'reading.qtype'
} as const

/**
 * 进 `core/prefs.ts::PREF_SPECS` 的那七条。
 *
 * ★ 三个枚举键的 `kind` 是 `text` 而不是新造一种「枚举」：
 *   值的宽容读法在下面 `readingRulesOf` / `practiceRulesOf` 里（认不出就回出厂），
 *   和别的偏好同一条规矩。在写入那一层卡死枚举的话，将来加一档值
 *   会让**老版本拒绝写新值**，而那一端什么都不会说。
 */
export const QUIZ_PREF_SPECS = [
  { key: QUIZ_RULE_KEYS.facePick, kind: 'text' as const, says: '认读：同一条每次用哪张牌面' },
  { key: QUIZ_RULE_KEYS.readingHint, kind: 'text' as const, says: '认读：题面给多少线索' },
  { key: QUIZ_RULE_KEYS.shiftContext, kind: 'bool' as const, says: '认读：编场景时换个场合' },
  { key: QUIZ_RULE_KEYS.practiceHint, kind: 'text' as const, says: '练习：出题给多少辅助材料' },
  { key: QUIZ_RULE_KEYS.contextSpread, kind: 'text' as const, says: '练习：题目场景离原文多远' },
  { key: QUIZ_RULE_KEYS.requireFullSentence, kind: 'bool' as const, says: '练习：必须写完整句' },
  { key: QUIZ_RULE_KEYS.matchRegister, kind: 'bool' as const, says: '练习：贴着原文的语域' },
  /**
   * ★★ D-486 · 两端**一起**进白名单，顺序不能反（确认单 §四 ②）：
   *   一端加了、另一端没加时，没升级的那一端 `checkPrefKey` **拒写这一行，
   *   而且什么都不会说** —— 他在电脑上选了「先写再翻」，手机上一直是翻卡自评，
   *   两边都不报错。落地顺序写死：core 一次加两个 → 两端各自跟上 → 再放出界面。
   */
  { key: QUIZ_RULE_KEYS.practiceFace, kind: 'text' as const, says: '产出的牌面（卡摆成什么样）' },
  { key: QUIZ_RULE_KEYS.readingQType, kind: 'text' as const, says: '认读的题型（他要做什么动作）' }
]

/**
 * ══ 每一档的**屏上字** —— 两端同一份（COPY_RULES CR-7）════════
 *
 * 为什么在 core 而不是各端各写一份：CR-7 要的是「同一件事两端一个说法」。
 * 各写一份的话，电脑上叫「轮着来」、手机上叫「换着出」，**两边都说得通、都不报错**，
 * 而他只会以为那是两个不同的设置。`READING_FACES[].says` 早就是这么办的。
 *
 * ★ 逐字抄自确认单那两张表的「选项名 / 说明」两列 —— 那是使用者看过的字。
 */
export const FACE_PICK_SAYS: Record<FacePick, string> = {
  'quote-first': '先用原文',
  rotate: '轮着来',
  random: '随机'
}

export const READING_HINT_SAYS: Record<ReadingHint, string> = {
  more: '多给',
  normal: '适中',
  less: '少给'
}

export const PRACTICE_HINT_SAYS: Record<PracticeHint, string> = {
  full: '释义和原句都给',
  'gloss-only': '只给释义',
  none: '都不给'
}

export const CONTEXT_SPREAD_SAYS: Record<ContextSpread, string> = {
  near: '贴着原文',
  mixed: '混着来',
  far: '尽量换新场合'
}

/** D-486 · 产出牌面三张的屏上字（名字 + 一句「怎么摆」） */
export const PRACTICE_FACE_SAYS: Record<PracticeFace, { name: string; says: string }> = {
  plain: { name: '整块', says: '题面一整块，答完从上往下看' },
  split: { name: '分栏', says: '答完把你写的和参考答案并排放' },
  focus: { name: '专注', says: '进题只留任务和输入框，答完再把其余推回来' }
}

/** D-486 · 认读题型三行的屏上字（名字 + 一句说明） */
export const READING_QTYPE_SAYS: Record<ReadingQType, { name: string; says: string }> = {
  flip: { name: '翻卡自评', says: '看题面想一想，翻开自己判四档' },
  write: { name: '先写再翻', says: '先写出你想到的那个词，翻开时对一下' },
  timed: { name: '限时认读', says: '倒计时到点自动翻开，这一次最高记到「想了一下」' }
}

/** 偏好读出来是字符串。认不出的一律回出厂值，**绝不抛**（和别的偏好同一条规矩） */
type Read = (key: string) => string | null | undefined

const pickOne = <T extends string>(raw: string | null | undefined, ok: readonly T[], fallback: T): T =>
  ok.includes((raw ?? '').trim() as T) ? ((raw ?? '').trim() as T) : fallback

/** `'1'` / `'0'` —— `checkPrefValue` 那边只收这两个值 */
const pickBool = (raw: string | null | undefined, fallback: boolean): boolean =>
  raw === '1' ? true : raw === '0' ? false : fallback

export function readingRulesOf(read: Read): ReadingRules {
  return {
    facePick: pickOne(
      read(QUIZ_RULE_KEYS.facePick),
      ['quote-first', 'rotate', 'random'] as const,
      READING_RULES_FACTORY.facePick
    ),
    hintLevel: pickOne(
      read(QUIZ_RULE_KEYS.readingHint),
      ['more', 'normal', 'less'] as const,
      READING_RULES_FACTORY.hintLevel
    ),
    shiftContext: pickBool(read(QUIZ_RULE_KEYS.shiftContext), READING_RULES_FACTORY.shiftContext)
  }
}

/** 产出的牌面现值。认不出回出厂，绝不抛（和别的偏好同一条规矩） */
export const practiceFaceOf = (read: Read): PracticeFace =>
  pickOne(read(QUIZ_RULE_KEYS.practiceFace), ['plain', 'split', 'focus'] as const, PRACTICE_FACE_FACTORY)

/** 认读的题型现值。同上 */
export const readingQTypeOf = (read: Read): ReadingQType =>
  pickOne(read(QUIZ_RULE_KEYS.readingQType), ['flip', 'write', 'timed'] as const, READING_QTYPE_FACTORY)

/**
 * ══ 限时认读到点了：这一次最高记到哪一档 · D-486 ★★★ ════════════
 *
 * **封顶第 2 档**（「想了一下」），沿 peek 那条先例（I-083：**诚实降档，不偷偷扣**）——
 * 屏幕上当场说清「超时了 —— 这一次最高记到『想了一下』」，不是算完之后他才发现间隔不对。
 *
 * ★★ 这一处同时收掉了 `Reading.svelte` 里那个 `PEEK_CAP = 2` ——
 *   「看过中文」和「超时」是**同一条判据的两个触发**：提前拿到了帮助，这一次就不算数到第 3 档。
 *   两处各写一个 2 的话，哪天改一处另一处不动，而**两处都说得通、都不报错**。
 *
 * ★ 只封顶、**不降档**：他点「忘了」就是 1，封顶不会把它抬上来。
 */
export const READING_CAP_GRADE = 2

export function capReadingGrade(
  grade: number,
  helped: { peeked?: boolean; timedOut?: boolean }
): number {
  return helped.peeked || helped.timedOut ? Math.min(grade, READING_CAP_GRADE) : grade
}

export function practiceRulesOf(read: Read): PracticeRules {
  return {
    hintLevel: pickOne(
      read(QUIZ_RULE_KEYS.practiceHint),
      ['full', 'gloss-only', 'none'] as const,
      PRACTICE_RULES_FACTORY.hintLevel
    ),
    contextSpread: pickOne(
      read(QUIZ_RULE_KEYS.contextSpread),
      ['near', 'mixed', 'far'] as const,
      PRACTICE_RULES_FACTORY.contextSpread
    ),
    requireFullSentence: pickBool(
      read(QUIZ_RULE_KEYS.requireFullSentence),
      PRACTICE_RULES_FACTORY.requireFullSentence
    ),
    matchRegister: pickBool(read(QUIZ_RULE_KEYS.matchRegister), PRACTICE_RULES_FACTORY.matchRegister)
  }
}

// ══════════════════════════════════════════════════════════════
// 二、理解层：选项拼出来的那几句（确认单 §一 细目，逐字）
// ══════════════════════════════════════════════════════════════

/**
 * R-1 · 挑哪种考法。
 *
 * ★ `quote-first` 这一段就是老 `DEFAULT_READING_RULES` 第 2 段说的同一件事
 *   （有原句就挖原句 → 编场景 → 中文那一面），确认单把它译成了英文并定为出厂档。
 */
export const FACE_PICK_LINES: Record<FacePick, string> = {
  'quote-first':
    'Pick the face to use in this order: if a usable source sentence exists, use the cloze face — ' +
    'that sentence is one the learner collected themselves and is worth more than an invented one. ' +
    'If it cannot be used (no quote / too short / the quote is the expression itself), build a scenario. ' +
    'If a scenario does not work either, use the Chinese-recall face. If only one face is available, use it. ' +
    'If none works, write 形式：无 and let the software fall back.',
  rotate:
    'Pick the face the learner has least recently seen for this expression. ' +
    'Never use the same face twice in a row for the same expression. ' +
    'If only one face is available, use it. If none works, write 形式：无.',
  random: 'Pick any one of the available faces at random. If none works, write 形式：无.'
}

/**
 * ★★ **这一句不在确认单里，是我加的**（D-413 要求标出来）。
 *
 * 为什么非加不可：`rotate` 那句说「挑他最久没见过的那一面」，
 * 而模型**看不到任何历史** —— 这个数在库里（`reading_cards.face_log`）。
 * 判据按派单留在 core：`orderFacesForPick` 把牌面按「最久没见」排好再拼进去。
 * 但排好了不说一声，模型不会知道顺序有含义 —— 那一档就成了装饰，
 * 而且**装饰是安静的**：选了「轮着来」，出题和以前一模一样，屏幕上什么都不会说。
 */
export const ROTATE_ORDER_LINE =
  'The faces below are listed in that order: the first one is the face they have least recently seen.'

/** R-2 · 提示强度。★ 三档**都**带着「绝不给出这个表达本身」那句（D-390 不随档变） */
export const READING_HINT_LINES: Record<ReadingHint, string> = {
  more:
    'Make the card easy to enter: give the part of speech, and hint at the grammatical shape the answer takes. ' +
    'Never give the expression or any inflection of it.',
  /** 出厂行为：一句都不拼 */
  normal: '',
  less:
    'Keep the card minimal: no part of speech, no structural hint. One short line. ' +
    'Never give the expression or any inflection of it.'
}

/**
 * R-3 · 换个场合再考（仅当开）。
 * ★ 这一句是从「场景补全」牌面 `guide` 的第 3 句**升上来的** ——
 *   那一句同时被删掉了，两处说同一件事就是两份判据。
 */
export const SHIFT_CONTEXT_LINE =
  'When building a scenario, move it to a different setting from the source sentence. ' +
  'The learner should have to recognise the expression somewhere it has not been seen.'

/**
 * 理解层：三个选项拼出来的那几句，按 R-1 → R-2 → R-3 的顺序。
 * `normal` 档与关着的 R-3 一句都不出 —— 出厂行为就是「什么都不多说」。
 */
export function readingRuleLines(r: ReadingRules): string[] {
  const out = [FACE_PICK_LINES[r.facePick]]
  if (r.facePick === 'rotate') out.push(ROTATE_ORDER_LINE)
  const hint = READING_HINT_LINES[r.hintLevel]
  if (hint) out.push(hint)
  if (r.shiftContext) out.push(SHIFT_CONTEXT_LINE)
  return out
}

// ══════════════════════════════════════════════════════════════
// 三、R-1「轮着来」要的那个数 —— 这一条上次用了哪张牌面
// ══════════════════════════════════════════════════════════════

/**
 * ★★★ **这个数存在哪，主控 2026-09-15 改判过一次，理由要留着。**
 *
 * 第一版（我写的）：往同步表 `reading_cards` 加一列 `face_log`，每一面记一个时间戳。
 * 改判：**存 DEVICE（`settings` 里一张有界 map），不进同步表、不加列不加表。**
 *
 *   为什么：加列会改**结构表面指纹**（`cadb369e…`）。指纹一变，没升上来的那一端
 *   会被握手整包挡住 —— 那是对的行为，但它要求两端**协调升级**，
 *   而 Android 那边要真走一次升库 + 上机验，和这一轮「不装机」直接冲突。
 *   换来的只是「轮着来」这一档的一点精度：**不值**。
 *
 *   为什么 DEVICE 说得通：它本来就是「**这台设备**上次给我看的是哪一张」。
 *   按 `core/prefs.ts` 那句判据问「换一台设备，这一项应该自动恢复吗」——
 *   不该：新设备从头轮一遍，一张牌面都不会少，最坏只是某一条第一次重复一次。
 *
 * ★ 代价说在前面：只记「上次是哪一面」，所以「最久没见」是**按他排的顺序轮**
 *   算出来的，不是逐面真时间戳。轮转仍然稳定、仍然不连着两次一样；
 *   差别只在「他中途改了勾选」那一瞬，下一次可能跳一格。
 */

/** 这一条上次用了哪一面：`{ 知识点 uid: 牌面 id }`。存 `settings['reading.lastFace']` */
export type LastFaceMap = Record<string, string>

/**
 * 有界 —— 超过就丢最旧的那几条。
 *
 * ★ 为什么必须有界：它按知识点存，而知识点只会越来越多。
 *   不设上限的话，这一行会随库一起长，而**没有任何人会看见它变大**
 *   （`settings` 里一行字符串，没人体检它）。
 * ★ 200 是我提的（D-413）：认读每日软上限出厂 60，200 覆盖三天以上的滚动窗口；
 *   再旧的条目下一次本来就该从头轮。
 */
export const LAST_FACE_MAX = 200

export function parseLastFace(raw: string | null | undefined): LastFaceMap {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* 不是合法 JSON —— 当成没记过。轮转退回「按他排的顺序」，不影响出题 */
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: LastFaceMap = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' && v) out[k] = v
  }
  return out
}

/**
 * 记一笔「这一条刚用了这一面」，并保持有界。
 *
 * ★ 插入顺序就是新旧顺序（JS 的字符串键对象按插入序遍历），所以丢最旧 = 丢最前面几条。
 *   先删再写：同一条再次出现时要挪到队尾，否则它会一直占着「最旧」的位置被挤掉。
 */
export function noteLastFace(
  raw: string | null | undefined,
  itemUid: string,
  faceId: string,
  max: number = LAST_FACE_MAX
): string {
  const map = parseLastFace(raw)
  delete map[itemUid]
  map[itemUid] = faceId
  const keys = Object.keys(map)
  const out: LastFaceMap = {}
  for (const k of keys.slice(Math.max(0, keys.length - max))) out[k] = map[k]!
  return JSON.stringify(out)
}

/**
 * ★★ R-1 的**判据**：按选项把牌面排好。
 *
 * `rotate` —— 把**上次用过的那一面之后的**那些排到前面，上次那一面自己落到最后。
 *   于是第一个就是「他最久没见过的」（在一轮一轮轮下来的意义上），
 *   而「不许连着两次一样」不需要另写一条规则 —— 它是排序的直接结果。
 *   没记过（新知识点 / 记号被挤掉了）→ 原序不动，从第一面开始轮。
 * `quote-first` / `random` —— 原序不动：前者的顺序由那段话定，后者由模型随机挑。
 *
 * ★ 不在这里**删掉**上次那一面：删了之后「只剩一面而那一面这次出不了」
 *   就变成整张卡退回机械挖空 —— 为一个偏好换来一次看得见的损失，不值。
 */
export function orderFacesForPick<T extends { id: string }>(
  faces: readonly T[],
  rules: ReadingRules,
  lastFaceId: string | null | undefined
): T[] {
  if (rules.facePick !== 'rotate') return [...faces]
  const at = faces.findIndex((f) => f.id === lastFaceId)
  if (at < 0) return [...faces]
  return [...faces.slice(at + 1), ...faces.slice(0, at + 1)]
}

// ══════════════════════════════════════════════════════════════
// 四、写作层：选项拼出来的那几句（确认单 §二 细目，逐字）
// ══════════════════════════════════════════════════════════════

/**
 * W-3 对**本来就要求成段**的题型不拼 —— 对它们说「必须写完整句」是废话，
 * 而废话会挤掉真正的要求。名字是 `core/qtypes.ts` 里那四种的 `id`。
 * ★ 界面上不做特例、不加说明（确认单 §二 ④：他不需要知道内部怎么分派）。
 */
export const PARAGRAPH_QTYPE_IDS: readonly string[] = ['限定写作', '摘要写作', '情景任务', '论点应答']

/** W-4 对「语域转换」不拼 —— 那一题的全部内容就是换语域，拼进去自相矛盾 */
export const REGISTER_QTYPE_ID = '语域转换'

/** W-1 「都不给」那一档额外拼的一句（全局，不按题型）*/
export const NO_SOURCE_LINE =
  'Do not quote or paraphrase the sentence where the learner met this expression.'

/**
 * W-2 · 语境跨度。`mixed` 那一段**是出厂原文**（确认单：不改）——
 * 它原来长在 `prompts/generate-questions.md` 的
 * `### Vary the context across the batch` 那一节里，这一轮整段搬进来。
 *
 * ★ 为什么搬：三档是**同一段的三个版本**。一档留在文件里、两档写在代码里的话，
 *   那一节就有两个真相，改哪一份都只改对了三分之一。
 *   文件里仍然留着这一节的标题、`{{SPREAD}}` 和「把用的那一种报回来」那句 ——
 *   模板还是文件（D-213），只是这一段由选项决定。
 */
export const CONTEXT_SPREAD_LINES: Record<ContextSpread, string> = {
  near:
    'Keep every question in the original context or one adjacent to it. ' +
    'Use context values "original" and "near" only.',
  mixed:
    'Do not put every question in the same setting. Spread them: some in the **original context** ' +
    '(same topic as the source sentence), some in an adjacent topic, some in a different field, and ' +
    'some in a **completely unfamiliar setting** — "can use it somewhere it has never been seen" is ' +
    'the real test.',
  far:
    'Spread the batch towards unfamiliar ground: at most one question in the original context, ' +
    'and at least half in "far" or "unseen" settings.'
}

/** W-3 开着时拼的那一句 */
export const FULL_SENTENCE_LINE =
  'The learner must answer in a complete sentence. A bare phrase is not an acceptable answer; ' +
  'say so in the prompt.'

/** W-4 开着时拼的那一句 */
export const MATCH_REGISTER_LINE =
  'Keep the register of each question consistent with the source sentence — ' +
  'if the learner met the expression in speech, do not set the task in formal writing.'

/**
 * ★★ **按题型**拼的那几句（W-3 / W-4）。
 *
 * 为什么按题型而不是全局拼一次：一次生成是**一批多种题型**（D-129），
 * 全局拼的话，「必须写完整句」会同时落在「情景任务」头上 ——
 * 而那一题本来就要写 80–120 词。所以这两句跟着 `{{TYPES}}` 里
 * 每一种的说明走（`main/study/production.ts::typesBrief`）。
 *
 * 全局那两件事（W-1 的额外句 · W-2 整段）不在这里，见 `practiceGlobalLines`。
 */
export function buildPracticeRules(rules: PracticeRules, qtypeId: string): string[] {
  const out: string[] = []
  if (rules.requireFullSentence && !PARAGRAPH_QTYPE_IDS.includes(qtypeId)) out.push(FULL_SENTENCE_LINE)
  if (rules.matchRegister && qtypeId !== REGISTER_QTYPE_ID) out.push(MATCH_REGISTER_LINE)
  return out
}

/** 全局那几句（现在只有 W-1 的「都不给」那一档有一句）→ 模板里的 `{{OPTIONS}}` */
export function practiceGlobalLines(rules: PracticeRules): string[] {
  return rules.hintLevel === 'none' ? [NO_SOURCE_LINE] : []
}

/**
 * W-1 · USER 段给他多少辅助材料 → 模板里的 `{{HINTS}}`。
 *
 * ★★ `Target expression:` 那一行**不在这里**：三档都给，它由模板自己写死（D-137
 *   「产出题的题面永远直接写出目标表达」——「产出这条线从不考你想不想得起这个词」）。
 *   放进这个函数就意味着它有可能不给，而那是要动 D-137 的事。
 */
export function practiceHintLines(
  rules: PracticeRules,
  material: { gloss: string; quote: string }
): string[] {
  if (rules.hintLevel === 'none') return []
  const out = [`Meaning: ${material.gloss}`]
  if (rules.hintLevel === 'full') out.push(`Where the learner met it: "${material.quote}"`)
  return out
}

/** 拼成一段 —— 空的时候给空串（模板里那一行会是空行，不会留下 `{{…}}`）*/
export const joinLines = (lines: readonly string[]): string => lines.join(LF)
