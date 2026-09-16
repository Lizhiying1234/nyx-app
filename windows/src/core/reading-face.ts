/**
 * 认读测试的牌面 · 判据与提示词 —— **两端唯一一份**（2026-09-03）
 *
 * ══ 这个文件为什么在 core ★★★ ═══════════════════════════════
 *
 * 「AI 决定这张认读卡怎么考」这件事，手机上 2026-09-01 就做完了
 * （`Nyx-Android/src/db/lookup.ts`）。现在使用者要求 Windows 也有，
 * 而且提示词要**能看、能改、能管**。
 *
 * 如果 Windows 自己再写一份 `parseFace` / `revealsAnswer` / 默认提示词，
 * 结果就是**同一张认读卡在两台机器上考法不一样、红线松紧也不一样，
 * 而两边都说得通、都不报错** —— 这正是本项目付过好几次学费的
 * 「两份判据」。所以这几样东西搬到 core，两端各自 import 同一份。
 *
 * ══ 一条不能破的红线 ★★★ ═════════════════════════════════
 *
 * **牌面不许出现答案**（D-390：提前露答案 = 违例）。
 * AI 会犯这个错 —— 它很容易把词原样写进句子里。
 * 所以生成完要**自己查一遍**（`revealsAnswer`），露了就整版作废、
 * 退回机械挖空。★ 不是「在提示词里叮嘱 AI 别这么做」就完事 ——
 * 那是祈祷，不是判据。
 *
 * ══ 失败一律退回，不阻断 ═════════════════════════════════
 *
 * 没配 AI / 超时 / 格式不对 / 露了答案 —— 统统安静退回机械牌面（D-338）。
 * 认读是每天都要跑的事，**它不能因为 AI 不在就跑不起来**。
 */

import {
  orderFacesForPick,
  readingRuleLines,
  READING_RULES_FACTORY,
  type ReadingRules
} from './quiz-rules.ts'

/** 换行。写成 `String.fromCharCode(10)` 是照 Android 那份的写法，转义少一层就少一处出错 */
const LF = String.fromCharCode(10)

export interface ReadingFace {
  /** 形式（挖空 / 中译回想 / 场景补全 …）—— 屏幕上如实标一下 */
  form: string
  /** 题面正文 */
  text: string
}

/** 词本身的几种常见形态 —— 查「露答案」时都要拦（不只是原样出现） */
function answerShapes(t: string): string[] {
  const out = new Set<string>([t])
  out.add(t + 's').add(t + 'es').add(t + 'ed').add(t + 'ing')
  if (t.endsWith('e')) out.add(t.slice(0, -1) + 'ing').add(t + 'd')
  if (t.endsWith('y')) out.add(t.slice(0, -1) + 'ies').add(t.slice(0, -1) + 'ied')
  return [...out]
}

/** 一个字符算不算「词的一部分」 */
function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

/** 整词出现（不做正则，省得给词条里的 . ? ' - 转义 —— 转义错了这道闸就是哑的） */
function hasWord(hay: string, needle: string): boolean {
  for (let from = 0; ; ) {
    const i = hay.indexOf(needle, from)
    if (i < 0) return false
    const before = i === 0 ? '' : hay[i - 1]!
    const after = hay[i + needle.length] ?? ''
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = i + 1
  }
}

/**
 * ══ 「先写再翻」写对了没有 · D-486 ★★★ ═══════════════════════
 *
 * 判据（确认单 §二 R-2 细目）：**逐字比对** —— 大小写 / 首尾空白 / 标点不计；
 * **词形变化算对**。对了就在四档上**预选「会」**；不对**不预选、也不降档**。
 *
 * ★★★ **只做逐字比对：不调 AI、不判地不地道、不产生标注、不写 `answers`。**
 *   这条边界不是洁癖 —— 越过它的那一刻理解层和写作层就合成了一条线，
 *   而 D-014 把两条线分开，正是因为**两者的差距才是最有价值的指标**。
 *   （下一轮很容易「顺手让 AI 看一眼他写的对不对」，所以这句写在判据头上。）
 * ★★ 写错**不降档**：拼写错 ≠ 没认出来。认读线考的是认出来 ——
 *   把拼写错当认读失败，是拿写作层的尺子量理解层。
 * ★ 他写的那串**不入库**：入库就是第二条作答账本，报告 / 攻坚区从此两个真相。
 */
export function matchesTerm(typed: string, term: string): boolean {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .join(' ')
  const a = norm(typed)
  const b = norm(term)
  if (!a || !b) return false
  if (a === b) return true
  /**
   * ★ 两个方向都要试：他写 `bears` 而词头是 `bear`，和他写 `bear` 而词头是 `bears`，
   *   都该算认出来了。只试一边的话，一半的词形变化会被判成写错。
   */
  return answerShapes(a).includes(b) || answerShapes(b).includes(a)
}

/**
 * 题面里露没露答案（D-390 的**判据**，不是对 AI 的祈祷）。
 *
 * ★ 按**整词**查，不是按子串。子串会两头都错：
 *   - 词是 `go` → 「ago / good / government」全都算露答案 → 永远退回机械挖空，
 *     这个功能等于没做；
 *   - 反过来，整词查也不会把 `unbending` 当成 `bend` 露了答案 —— 它确实没露。
 *   短语（带空格的）没有词形变化，整体查一次就够。
 */
export function revealsAnswer(text: string, term: string): boolean {
  const t = term.trim().toLowerCase()
  if (!t) return false
  const low = text.toLowerCase()
  if (t.includes(' ')) return hasWord(low, t)
  return answerShapes(t).some((x) => hasWord(low, x))
}

/**
 * 牌面自己解析自己的两行。
 *
 * ★ 格式是提示词里定死的两行（`形式：` / `题面：`），所以**每一份预设提示词
 *   都必须照这两行输出** —— 换了格式，这里解析不出来，牌面一律作废退回机械挖空。
 *   这条约束写在下面每一份预设的末尾，不许省。
 */
export function parseFace(raw: string): ReadingFace | null {
  let form = ''
  let text = ''
  for (const row of raw.replace(/```[a-z]*/gi, '').split(LF)) {
    const line = row.trim().replace(/^[-*]\s+/, '').replace(/\*\*/g, '')
    const m = /^(形式|题面)\s*[:：]\s*(.*)$/.exec(line)
    if (m) {
      if (m[1] === '形式') form = m[2]!.trim()
      else text = m[2]!.trim()
      continue
    }
    // 题面折行了 —— 接上（形式只可能是一个词，不会折）
    if (text && line) text += ' ' + line
  }
  if (!text) return null
  return { form: (form || '挖空').slice(0, 6), text }
}

/** 每一份预设都要以这两条收尾 —— 红线和输出格式，一处写，五处用 */
const TAIL = [
  '严格按这两行输出，不要别的：',
  '形式：<一个词>',
  '题面：<一到两句>',
  '★ 题面里**绝对不许出现这个表达本身，也不许出现它的变形**（那等于直接给答案）。',  // copy:prompt
  '★ 不要写「答案是……」「这个词是……」这类话。直接给题面。'
]

/**
 * ══ 牌面与出题规则，分成两层 · D-479（使用者 2026-09-08）═══════
 *
 * 他的原话：**牌面是可以多选的内容模块，出题规则是一份统一的 Prompt**，
 * 「以后想加一个牌面，就只是加一个模块」。
 *
 * ── 之前是什么样，为什么不行 ──────────────────────────────
 *
 * 上一版是**五份整段提示词**（综合 / 只挖原句 / 场景补全 / 中译回想 / 英文释义），
 * 一次只能用一份。于是两件本来正交的事被粘成了一串：
 *   · 「这张卡给他看什么」（内容）
 *   · 「怎么围绕知识点出题、什么顺序、不许露答案」（规则）
 * 想要「挖空 + 英文释义两种都来」就只能再写第六份整段提示词，
 * 而那第六份里会把规则**再抄一遍** —— 抄错一个字，两份的红线就不一样了。
 *
 * ── 现在 ──────────────────────────────────────────────────
 *
 *   `READING_FACES`          牌面模块表：id · 名字 · 给他看什么 · 给 AI 的一小段内容说明
 *   `DEFAULT_READING_RULES`  一份统一规则（出厂正文，他可以整份改）
 *   `buildReadingPrompt()`   **一处拼装**：规则 + 他勾的那几面 → 最终提示词
 *
 * ★ 红线仍然只有一份：`TAIL` 那两条（严格两行输出 · 不许露答案）在规则里，
 *   而真正的判据是 `revealsAnswer` / `parseFace` —— 它们一个字没动（D-390 / D-338）。
 * ★ 加一个牌面 = 往 `READING_FACES` 里加一条。`parseFace` 不认名单
 *   （形式名只取前 6 个字原样显示），所以不用改解析、不用改任何白名单。
 */
export interface ReadingFaceDef {
  /** 稳定标识 —— 存进偏好的是它。改名字不影响他已经勾好的那几面 */
  id: string
  /** 界面上显示的名字（也是 AI 该写进「形式：」那一行的词） */
  name: string
  /** 一句话：这一面给他看什么。**给他看的** */
  says: string
  /** 给 AI 的那一小段：这一面的内容怎么写。**只讲内容，不讲规则** */
  guide: string
}

/**
 * 出厂的四个牌面 —— 从原来那五份预设里抽出「内容」那一半。
 *
 * ★ 为什么是 4 个不是 5 个：第五份「综合」根本不是一种内容，它说的是
 *   **优先级**（有原句就挖原句 → 没有再编场景 → 最后才用中文）——
 *   那是规则，整份进了 `DEFAULT_READING_RULES`。
 */
export const READING_FACES: readonly ReadingFaceDef[] = [
  {
    id: 'cloze',
    name: '挖空',
    says: '他自己收下这条知识点时的那句原文，知识点处换成 ____',
    guide: [
      '挖空 —— 原样抄下他收这个表达时的那句原句，把这个表达换成 ____，别的一个字都不要改。',  // copy:prompt
      '  那句话是他在真实语境里读到的，你新编的句子替不了它。',
      '  原句太短、或者整句就是这个表达本身（挖完什么都不剩）时，这一面出不了，换别的面。'  // copy:prompt
    ].join(LF)
  },
  {
    id: 'scenario',
    name: '场景补全',
    says: '一个具体场景（谁 · 在哪 · 正要说什么），让他补出该用的知识点',
    guide: [
      '场景补全 —— 用英文描述一个具体场景（谁、在哪、正要说什么），让他补出这里该用的表达。',  // copy:prompt
      '  场景要贴着这个表达真正的用法和语域走 —— 换个场合就不该用它的话，那个场合别写。'  // copy:prompt
      /**
       * ★ 第 3 句（「有原句的话从原句里取语境，但不要抄原句」）**2026-09-15 删了** ——
       *   它升成了选项 R-3（`core/quiz-rules.ts::SHIFT_CONTEXT_LINE`，D-482）。
       *   两处说同一件事就是两份判据：他把那个开关关掉之后，这一句还会
       *   继续生效，而屏幕上显示的是「关着」。
       */
    ].join(LF)
  },
  {
    id: 'zh-recall',
    name: '中译回想',
    says: '中文说出意思与「什么时候会想这么说」，让他回想英文',
    guide: [
      '中译回想 —— 用中文说出这个表达的意思和用它的场合，让他回想英文原文怎么说。',  // copy:prompt
      '  中文要说到位：不是查词典式的对译，而是「什么情况下中国人会想表达这个意思」。',  // copy:prompt
      '  ★ 这一面的题面里不许出现任何英文单词 —— 一出现就等于给了线索。'
    ].join(LF)
  },
  {
    id: 'define',
    name: '英文释义',
    says: '用简单英文解释它的意思，外加一句它常出现在什么语域 / 搭配里',
    guide: [
      '英文释义 —— 用简单英文解释这个表达的意思，外加一句它常出现在什么语域 / 搭配里。',  // copy:prompt
      '  用词要比它本身简单 —— 用更难的词去解释，等于换了一道更难的题。',
      '  ★ 这一面的题面里不许出现中文。'
    ].join(LF)
  }
]

/** 出厂勾着哪几面 —— 全开：他没表态之前，四种都轮得到才看得出自己想要哪种 */
export const DEFAULT_FACE_IDS: readonly string[] = READING_FACES.map((f) => f.id)

export const faceById = (id: string): ReadingFaceDef | null =>
  READING_FACES.find((f) => f.id === id) ?? null

/**
 * ★★ 出题规则 —— **2026-09-15 起由选项拼出来**（D-482）。
 *
 * 这一份管的是「怎么围绕知识点出题 · 勾了多面时按什么顺序挑 · 输出格式 · 红线」。
 * **一个字的内容说明都不在这里** —— 内容在 `READING_FACES` 里，他勾哪几面就拼哪几段进来。
 *
 * ── 这一轮变了什么 ────────────────────────────────────────
 *
 * 老的「按顺序挑」那一段（有原句就挖原句 → 编场景 → 中文）不再是写死的正文，
 * 它变成了 R-1 的出厂档 `quote-first`（`core/quiz-rules.ts::FACE_PICK_LINES`）。
 * 他从此**点选项**，不再写正文 —— 编辑框收起，老正文一个字不删（D-216），
 * 认账办法在 `main/reading-faces.ts`。
 */
const READING_IDENTITY =
  '你在给一个中文母语者出一张英语「认读卡」的题面。他要靠题面回想起这个表达。'  // copy:prompt

/**
 * ★★★ **一处拼装**：身份段 + 选项拼出来的那几句 + 硬约束尾段。
 *
 * 三段各有各的归属，这一点是判据不是排版：
 *   身份段  永远有，不做成选项（确认单 §零 ①）
 *   中间段  **全部由选项决定**（R-1 / R-2 / R-3）—— 这一轮改的就是它
 *   尾段    `TAIL`，D-390 / D-338 的硬约束，**永远拼，不随任何选项变**
 */
export function readingRulesText(rules: ReadingRules): string {
  return [READING_IDENTITY, '', ...readingRuleLines(rules), '', ...TAIL].join(LF)
}

/** 出厂那一份（= 出厂选项拼出来的样子）。界面上的「改回默认」和用例都认它 */
export const DEFAULT_READING_RULES: string = readingRulesText(READING_RULES_FACTORY)

/**
 * ★★ **冻住的上一版出厂正文**（2026-09-08 ～ 2026-09-15 那一版）。
 *
 * 只有一个用途：老数据认账时判「这段正文是出厂的，还是他自己写的」
 * （`main/reading-faces.ts::migrateReadingOptionsOnce`，确认单 §四）。
 * 没改过的人库里躺着的正是这一串，而 `DEFAULT_READING_RULES` 今天已经变了 ——
 * 拿今天这份去比，**每一个老用户都会被判成「改过」**，
 * 然后收到一句「你以前写的出题规则已经收起来了」，而他一个字都没写过。
 *
 * ★ 所以它像历史迁移里那份冻住的键单一样：**从此一个字都不许改**（D-216 的精神）。
 */
export const READING_RULES_BEFORE_OPTIONS: string = [
  '你在给一个中文母语者出一张英语「认读卡」的题面。他要靠题面回想起这个表达。',  // copy:prompt
  '',
  '**从下面「这次可以用的牌面」里挑一种**来出这一张。挑的顺序：',
  '  有原句可挖就先挖原句 —— 那句话是他自己收下来的，比新编的句子更值钱；',
  '  挖不成（没有原句 / 原句太短 / 整句就是这个表达）就编场景；',  // copy:prompt
  '  场景也不好编，再用中文那一面。',
  '  只有一面可用时就用那一面；哪一面都出不了，把形式写成「无」，由软件退回机械牌面。',
  '',
  ...TAIL
].join(LF)

/**
 * ══ 「他以前写过出题规则没有」—— **判据在这里，两端同一份** ★★★ ══
 *
 * 2026-09-15 这条判据一开始只长在 Windows 的 `main/reading-faces.ts` 里，
 * Nyx-UI-Android 要照抄时提出来搬上来。**理由成立，原话记下**：
 *
 *   它决定的是「要不要对他说『你以前写的出题规则已经收起来了』」。
 *   将来出厂正文再改一版，Windows 往名单里加一条、Android 没加 ——
 *   那时候**手机上每一个老用户都会看到这句话，而他一个字都没写过**，
 *   电脑上却不会。两边都说得通、都不报错。
 *
 * 这正是 `READING_RULES_BEFORE_OPTIONS` 头上那段说的事故形态，只是换成了跨端。
 *
 * ★ 两端各自负责的只有「把 `prompt.reading-card` 那一行的原值读出来」——
 *   那是平台的事（Windows 走 `Prefs.raw`，Android 走它自己那一层）。
 */
export const FACTORY_READING_RULE_TEXTS: readonly string[] = [
  READING_RULES_BEFORE_OPTIONS,
  DEFAULT_READING_RULES
]

/**
 * 他以前写过的那段出题规则正文；**出厂原样（或压根没设过）就是 `null`**。
 *
 * ★★ 比的时候**每一版出厂都要认**，不是只认今天这份 ——
 *   只比今天这份的话，老用户库里躺着的是上一版出厂正文，会被判成「他改过」，
 *   然后收到一句他一个字都没写过的话。加新出厂正文时**往这张名单里加，别替换**。
 * ★ 两头空白不算差别（存的时候 trim 过，读回来可能带换行）。
 */
export function legacyReadingRulesOf(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  return FACTORY_READING_RULE_TEXTS.some((f) => f.trim() === text) ? null : text
}

/**
 * ★★★ **一处拼装**：规则 + 他勾的那几面 → 这一次真正发给 AI 的 system 段。
 *
 * 两端都调它（Windows `main/study/reading.ts` · Android `db/lookup.ts`），
 * 所以「同一份偏好在两台机器上算出同一份提示词」是**结构性**的，不靠两边各自小心。
 *
 * ★ 一面都没勾 → 返回 `null`。调用方**不许兜底**（不许偷偷按全开来出题）：
 *   那是他明确取消掉的东西，替他勾回来就是「我的选择不算数」。
 */
export function buildReadingPrompt(
  /**
   * ★★ 2026-09-15 起收的是**三个选项**，不再是一整段正文（D-482）。
   *   他以前写的那段正文留在库里、界面上只读可看，但**不再参与拼装** ——
   *   两个真相里只能留一个，而他裁的是「点选项」那一个。
   */
  rules: ReadingRules,
  /**
   * 他勾着的那几面。
   * ★★ 可以是 id（出厂那四个），也可以是整条偏好 —— 自建那一面的正文
   *   不在任何一张表里，只在偏好里，所以调用方得能把整条递进来
   *   （使用者 2026-09-14 第一条）。
   */
  selectedFaceIds: readonly (string | FacePref)[],
  term: string,
  gloss: string | null,
  quote: string | null,
  /**
   * R-1「轮着来」要的那个数：**这一条上次用了哪一面**
   * （`settings['reading.lastFace']`，DEVICE，主控 2026-09-15 改判）。
   *
   * ★★ **必填，没有默认值**（Nyx-UI-Android 2026-09-15 提，主控裁）。
   *   它原来是 `= null`：漏传照样编译、照样返回一份看着正常的提示词，
   *   只是「轮着来」**静静退化成原序** —— 他选了那一档，出题和以前一模一样，
   *   屏幕上什么都不会说。这一轮已经在同一个形状上栽过一次
   *   （`ROTATE_ORDER_LINE` 那句：排好序不告诉模型，那一档就是装饰）。
   *   没有那个数就**显式传 `null`** —— 让「我知道这里没有」写在调用点上。
   */
  lastFaceId: string | null
): { system: string; user: string } | null {
  const faces = selectedFaceIds
    .map((x) => (typeof x === 'string' ? faceById(x) : resolveFace(x)))
    .filter((f): f is ReadingFaceDef => !!f)
  if (faces.length === 0) return null
  /**
   * ★ 顺序由 core 算（`orderFacesForPick`）：「轮着来」那一档按「最久没见」排，
   *   别的两档原序不动。模型看不到历史，**这个判据只能在这一侧**。
   */
  const ordered = orderFacesForPick(faces, rules, lastFaceId)
  const system = [
    readingRulesText(rules),
    '',
    '── 这次可以用的牌面 ──',
    ...ordered.map((f) => f.guide)
  ].join(LF)
  return { system, user: readingFaceUser(term, gloss, quote) }
}

/**
 * 他勾了哪几面 —— 存进偏好的那串 JSON（有序 id + 开关）。
 *
 * ★ 读的时候必须宽容（和别的偏好同一条规矩）：认不出的 id 丢掉、
 *   缺的按出厂补在后面、重复的只认第一次。少了这一条，将来加一个牌面
 *   会让老用户的选择**无声无息地**变回默认。
 */
export interface FacePref {
  id: string
  on: boolean
  /**
   * ★★ 他自己建的那一面，正文就存在这儿（使用者 2026-09-14 第一条）。
   *
   * 出厂那四面在 `READING_FACES` 里，靠 `id` 就能查回来；自建的没有那张表，
   * 所以**名字与正文跟着这一条偏好走**。built-in 的条目没有这个字段。
   */
  custom?: { name: string; says: string; guide: string }
}

/**
 * ══ 自建牌面 · 为什么存在这份偏好里，而不是新开一张表 ★★★ ══════
 *
 * 使用者 2026-09-14 第一条：「增加『新建牌面』功能。用户应该能够在这里直接
 * 创建新的认读测试牌面。」
 *
 * ── 它必须同步 ────────────────────────────────────────────
 * 牌面是**两端共用的判据**（这个文件在 `core/`，Android 的 `db/lookup.ts`
 * 也调 `buildReadingPrompt`）。他在电脑上新建一面，手机上出题时必须认得 ——
 * 否则同一张认读卡在两台机器上考法不一样，而两边都不报错。
 * 这正是这个文件头上那段「两份判据」说的事。
 *
 * ── 为什么不是新开一张同步表 ─────────────────────────────
 * `reading.faces` **本来就是 USER 偏好、本来就在 `user_preferences` 里、
 * 本来就进 `SYNC_TABLES`**（见 `core/prefs.ts` 那一条）。把自建那几面放进去，
 * 同步这条路一行代码都不用动。新开一张表要：迁移 + `schema/vNN.sql` 重生成
 * （D-461）+ `SYNC_TABLES` + `fk-map` + Android 那边跟着改 —— 四处，
 * 换来的是同一个能力。**最小的那个改法**。
 *
 * ── 代价，说在前面 ────────────────────────────────────────
 * 偏好是一整根字符串，冲突时按行（整条偏好）定胜负，不做逐面合并。
 * 也就是说：两台机器同时各加一面，会有一面输掉。
 * 这一条和 `qtypes`（勾了哪几种题型）是同一个形状，不是这一轮新引入的代价。
 */

/** 自建那一面的 id 前缀 —— 和出厂那四个（cloze / scenario / …）永不相撞 */
export const CUSTOM_PREFIX = 'u:'

export const isCustomFaceId = (id: string): boolean => id.startsWith(CUSTOM_PREFIX)

/**
 * 名字最多几个字。
 *
 * ★★ 6 不是拍的：`parseFace` 解析模型回来的「形式：X」那一行时写着
 *   `form.slice(0, 6)`。名字长过 6 个字的话，**屏幕上那一档会被截断**，
 *   而他在这儿输入的时候看不出来。所以在入口就卡住，并且当面说清为什么。
 */
export const FACE_NAME_MAX = 6

/**
 * 建一个自建面的 id。**只要求不撞**，不要求好看 —— 它不出现在界面上。
 * ★ 收 `now` 做参数、不自己叫 `Date.now()`：core 里不许有隐藏的时间源
 *   （注入时间源那条纪律），否则用例没法钉。
 */
export function newFaceId(now: number, taken: readonly string[] = []): string {
  let n = Math.max(0, Math.floor(now))
  for (;;) {
    const id = CUSTOM_PREFIX + n.toString(36)
    if (!taken.includes(id)) return id
    n += 1
  }
}

/** 一条偏好 → 真正能用的那一面。认不出来给 `null`，**绝不抛** */
export function resolveFace(pref: FacePref): ReadingFaceDef | null {
  if (isCustomFaceId(pref.id)) {
    const c = pref.custom
    if (!c) return null
    const name = String(c.name ?? '').trim()
    const guide = String(c.guide ?? '').trim()
    /**
     * ★ 名字和「给 AI 的那段」缺一不可：
     *   名字没了屏上那一档是空的；`guide` 没了这一面对模型**什么都没说**，
     *   等于勾了一个不存在的考法 —— 那比少一面糟。
     */
    if (!name || !guide) return null
    return { id: pref.id, name, says: String(c.says ?? '').trim(), guide }
  }
  return faceById(pref.id)
}

export function parseFacePrefs(raw: string | null | undefined): FacePref[] {
  const out: FacePref[] = []
  const seen = new Set<string>()
  if (typeof raw === 'string' && raw.trim() !== '') {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* 不是合法 JSON —— 当成没设过 */
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const id = (item as { id?: unknown }).id
        if (typeof id !== 'string' || seen.has(id)) continue
        const on = (item as { on?: unknown }).on !== false
        /**
         * ★★ 自建那一面（`u:` 开头）**正文跟着这一条走**（使用者 2026-09-14 第一条）。
         *   校不过（没名字 / 没给 AI 那段）就整条丢掉 —— 和认不出的 built-in id
         *   同一个待遇：宁可少一面，也不留一个勾得上却什么都不说的空面。
         */
        if (isCustomFaceId(id)) {
          const raw = (item as { custom?: unknown }).custom
          const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
          const cand: FacePref = c
            ? {
                id,
                on,
                custom: {
                  name: typeof c.name === 'string' ? c.name.trim().slice(0, FACE_NAME_MAX) : '',
                  says: typeof c.says === 'string' ? c.says.trim() : '',
                  guide: typeof c.guide === 'string' ? c.guide.trim() : ''
                }
              }
            : { id, on }
          if (!resolveFace(cand)) continue
          seen.add(id)
          out.push(cand)
          continue
        }
        if (!faceById(id)) continue
        seen.add(id)
        out.push({ id, on })
      }
    }
  }
  for (const f of READING_FACES) {
    if (!seen.has(f.id)) out.push({ id: f.id, on: true })
  }
  return out
}

/**
 * ★ 自建那一面的正文**必须一起写出去**，不然存一次就没了
 *   （这一段是这一轮最容易写漏的地方：上一版这里只挑 `id` / `on` 两个字段）。
 */
export const serializeFacePrefs = (list: readonly FacePref[]): string =>
  JSON.stringify(
    list.map((f) => (f.custom ? { id: f.id, on: f.on, custom: f.custom } : { id: f.id, on: f.on }))
  )

/** 他勾着的那几面的 id（按他排的顺序）。★ 自建面走下面那个，别用这个 */
export const onFaceIds = (list: readonly FacePref[]): string[] =>
  list.filter((f) => f.on).map((f) => f.id)

/**
 * ★★ 他勾着的那几面，**整条**（按他排的顺序）—— `buildReadingPrompt` 现在收它。
 *   只传 id 的话，自建那一面到了拼装那一步查不回正文，会被静静丢掉：
 *   他建了一面、勾上了，出题时却当它不存在 —— 而屏幕上什么都不会说。
 */
export const onFaces = (list: readonly FacePref[]): FacePref[] => list.filter((f) => f.on)

/**
 * ★★ 老数据一次性迁移 —— 从「五份整段提示词选一份」到「牌面 + 规则」。
 *
 * 他机器上现在存着的是 `prompt.reading-card` = 某一份整段提示词。
 * 迁移只做一件事：**认出那一份是哪种考法，把对应的牌面勾上**，规则回出厂。
 *
 * ★ 判据是正文里那句「用一种形式：X」/「三种形式」，不是 id ——
 *   id 存在名单里（`settings`，本机），而正文才是跟着人走、真的在决定行为的那份。
 * ★ 认不出来（他自己改过 / 自己写的）→ 返回 `null`，**一个字都不动**：
 *   宁可让他自己去勾一次，也不能拿一个猜出来的配置替换掉他写过的东西。
 */
export function migrateLegacyReadingPrompt(
  legacyText: string | null | undefined
): { faceIds: string[]; rules: string } | null {
  const t = (legacyText ?? '').trim()
  if (!t) return null
  if (t.includes('三种形式')) return { faceIds: [...DEFAULT_FACE_IDS], rules: DEFAULT_READING_RULES }
  for (const f of READING_FACES) {
    if (t.includes(`用一种形式：${f.name}`) || t.includes(`只用一种形式：${f.name}`)) {
      return { faceIds: [f.id], rules: DEFAULT_READING_RULES }
    }
  }
  // 「只挖原句」那一份写的是「只用一种形式：挖空，而且只挖他自己那句原文」
  if (t.includes('只用一种形式：挖空')) return { faceIds: ['cloze'], rules: DEFAULT_READING_RULES }
  return null
}

/** 认读牌面那一次 AI 调用的 user 段 —— 两端同一份，省得一边多给一边少给 */
export function readingFaceUser(
  term: string,
  gloss: string | null,
  quote: string | null
): string {
  return (
    `表达：${term}${LF}` +  // copy:prompt
    `意思：${gloss?.trim() || '（没有释义）'}${LF}` +
    `他收下它时的原句：${quote?.trim() || '（没有原句）'}`
  )
}
