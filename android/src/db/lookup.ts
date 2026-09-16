/**
 * Assist 查词大脑（D-401 立，D-404 改）—— 三种行为，严格分开：
 *   quick · **选区落定就自动发起**的简明释义（AI，提示词来自 settings
 *           `assist.ai.quickPrompt`）。极短、给人一眼看的，不是文章。
 *   full  · 用户**主动点 AI Tab** 才生成的完整解释（AI，提示词来自
 *           settings `assist.ai.prompt`）。两个提示词都在调用那一刻读取。
 *   dict  · 用户**主动点 Dictionary** 才查的本地词典（D-404⑤）——
 *           返回词条**原始 HTML**，由界面按词典自己的结构渲染，
 *           不重新包装成我们的 AI 卡片格式。
 *
 * ★ D-404② 推翻 D-403③④：默认路径只有 AI，词典不再抢在前面自动跑。
 * ★ AI 绝不预生成：本文件只被 Assist 引擎的明确请求触发。
 * ★ 展示层整理（模型管内容、UI 管呈现）：full 走 parseAiSections 分节；
 *   quick 走 cleanQuick —— 它只该是一行字，任何标题/记号都是噪音。
 * ★ 失败态如实：AiError 的 title/detail 原样上抛（core/ai 的结构化失败）。
 */
import { promptPrefKey } from '../core-link.ts'
import { callAi } from '../core-link.ts'
/**
 * ★★ 认读牌面的判据搬去了 core（2026-09-04）——「牌面」这件事 Windows 也做了，
 *   各留一份的后果是同一张卡两端考法不一样，而两边都不报错。
 *   这里只 re-export，**不许在这一层再写一行逻辑**（同 core-link 的纪律）。
 */
import {
  AI_LOOKUP_NOTE,
  DEFAULT_READING_RULES,
  READING_FACES,
  buildReadingPrompt,
  cleanLine,
  legacyReadingRulesOf,
  migrateLegacyReadingPrompt,
  onFaces,
  parseAiSections,
  parseFace,
  parseFacePrefs,
  resolveFace,
  revealsAnswer,
  serializeFacePrefs,
  type ReadingFace,
  // ★ 出题规则三选项（D-482）—— 拼装判据全在 core，这里只把偏好读出来递进去
  QUIZ_RULE_KEYS,
  noteLastFace,
  parseLastFace,
  readingRulesOf,
  type FacePref
} from '../core-link.ts'
export { DEFAULT_READING_RULES, parseFace, revealsAnswer, type ReadingFace }
import { resolveSlot } from './ai.ts'
import { prefSet } from './prefs.ts'
import { normalizeTerm } from './capture.ts'
import { listDicts, lookupDicts } from './dict.ts'
import type { Db } from './types.ts'

/**
 * ★★ 用户选中的是**什么形态**的一段文字（2026-09-03）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * 使用者选中一整句 `I couldn't figure out what he was trying to say.`，
 * 卡片上回来的却是 `figure out` 或 `trying to say` 的释义 ——
 * 「我选的是一句话，它只讲了里面的一个词组」。
 *
 * 查下来**不是截断**：整句原样走完了原生 → 引擎 → `assistLookup`，
 * 一个字都没少。问题出在**怎么跟模型说这段话**：
 *
 *   · user 段写死成 `词：<整句>` —— 一上来就把一句话叫成「词」
 *   · 三份默认提示词都说「用户给你一个英语单词或短语」
 *
 * 于是模型照着指令办事：从这句话里挑一个**像词条的东西**讲。
 * 它没做错，是我们把输入说成了别的东西。
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * 先认出形态，再照形态说话。判据只有这一份，三条路（quick / full /
 * search）共用 —— 各写各的话术，早晚会有一条又退回「词」。
 *
 * ★ 只按**词数与句末标点**分，不做语言学分析：这里要的是
 *   「该当词条查，还是该当一段话讲」，不是句法树。
 */
export type SelShape = 'word' | 'phrase' | 'sentence' | 'passage'

export function shapeOf(text: string): SelShape {
  const t = (text ?? '').trim()
  if (!t) return 'word'
  // 句末标点（含中文）出现在**中间**，或者干脆有换行 —— 不止一句
  if (/[.!?。！？][^\s]*\s+\S/.test(t) || t.includes(String.fromCharCode(10))) return 'passage'
  const words = t.split(/\s+/).filter(Boolean).length
  if (words <= 1) return 'word'
  // 有句末标点、或者长到不像搭配 —— 当整句处理
  if (/[.!?。！？…]$/.test(t) || words >= 6) return 'sentence'
  return 'phrase'
}

const SHAPE_SAYS: Readonly<Record<SelShape, string>> = {
  word: '一个词',
  phrase: '一个词组',
  sentence: '一整句话',
  passage: '一段连续的文字（不止一句）'
}

/**
 * ★ user 段 —— **原样把他选的那段给出去，并且说清那是什么形态**。
 *
 * 这一段刻意放在代码里而不是提示词里：使用者可以在设置里改提示词
 * （`assist.ai.prompt` / `assist.ai.quickPrompt` / `prompt.lookup-search`），
 * 而「输入是什么、不许缩」这件事**不能因为他改了提示词就失效**。
 */
export function lookupUser(text: string, sentence: string | null, shape = shapeOf(text)): string {
  const lf = String.fromCharCode(10)
  const head =
    shape === 'word' || shape === 'phrase'
      ? `用户选中的是${SHAPE_SAYS[shape]}，原文如下：`
      : `用户选中的是${SHAPE_SAYS[shape]}，原文如下。` +
        `**要讲的就是这一整段，不许只挑其中某一个词或词组来讲**：`
  const out = [head, text.trim()]
  const ctx = sentence?.trim()
  // 整句 / 整段本身就是上下文 —— 再贴一遍只会让模型以为那是另一段要讲的东西
  if (ctx && ctx !== text.trim() && (shape === 'word' || shape === 'phrase')) {
    out.push(`它出现在这句话里：${ctx}`)
  } else if (!ctx && (shape === 'word' || shape === 'phrase')) {
    out.push('（没有上下文句子）')
  }
  return out.join(lf)
}

/** 三份提示词共用的尾巴：**给什么讲什么**，别缩成一个词条 */
const SHAPE_RULE =
  '用户给的可能是一个词、一个词组、一整句话，也可能是一段连续文字。' +
  '**给你什么就处理什么**：是词或词组就按词条讲；' +
  '是整句或整段，就讲这一整段 —— 先说它整体在讲什么，' +
  '再点出里面真正难的那一两处（结构、搭配、语气），' +
  '**绝对不要只挑其中一个词讲，然后当作已经回答了**。'

/** D-401⑥ · 完整解释的默认提示词 —— 存进 settings 的才算数，这里只是没配时的兜底 */
export const DEFAULT_AI_PROMPT =
  '你是给中文母语者用的英语助手。' +
  SHAPE_RULE +
  '按这些小节组织：释义（中文；词/词组给它在句中的意思，整句整段给整体意思）、' +
  '用法（词性/常见搭配；整句整段就讲句子结构与关键搭配）、' +
  '例句（一句地道例句附中文翻译）、备注（易混点或语域，没有就省略）。' +
  '小节标题独占一行。直接给内容，不要寒暄。'

/**
 * D-404⑦ · 简明释义的默认提示词 —— 与完整解释**分开**的一条，
 * 使用者可在 Settings → Assist → AI 改。它要的是「一眼看懂」，不是解释。
 */
export const DEFAULT_QUICK_PROMPT =
  '你是给中文母语者用的英语助手。用户给你一段英文，可能是一个词、一个词组、一整句话或一段文字。' +
  '只回一条极简中文：' +
  '词或词组 —— 不超过 20 个字的释义，用「；」分隔 2-3 个最常见义项，' +
  '有上下文句子就把最贴合那句话的义项排在最前；' +
  '整句或整段 —— **不超过 40 个字，说这一整段的意思**，' +
  '不许只挑里面某一个词来解释。' +
  '不要标题、不要 Markdown、不要引号、不要例句、不要词性说明、不要重复英文原文、不要解释过程。' +
  '只输出那一行内容本身。'

export interface LookupSection {
  label: string
  text: string
  /** dict 专用：词条原始 HTML（D-404⑤ 按词典自己的结构渲染） */
  html?: string
  /** dict 专用：词典自己的样式表（那份 HTML 的样子归它管） */
  css?: string
}

export interface LookupResult {
  /** dict 专用：词典与库内都没有 */
  miss?: boolean
  sections: LookupSection[]
  /** 来源/状态脚注（AI 内容必须带「可能有误」—— 例句来源徽章的诚实原则同族） */
  note?: string | null
}

/**
 * ★★ 脚注三句 —— 那四个字「可能有误」是 D-395 的诚实原则**本身**，不是措辞。
 *   少掉它，屏幕上就不再告诉他这行字是机器写的，而没有任何东西会报错。
 *   `tests/lookup.test.ts` 有一条闸把三句一起钉住（core 那边也钉了它自己那句）。
 *
 * ★ 为什么只有「搜索」那句在 core：`简明` / `完整` 是 Assist 气泡那两档，
 *   **Windows 一档都没有**。收进 core 就是往共用层里放只有一端会用的字符串，
 *   下一个人会把它当成「两端都有」的证据（三次法则：等第三种出现再抽象）。
 */
export const QUICK_LOOKUP_NOTE = 'AI · 简明 · 可能有误'
export const FULL_LOOKUP_NOTE = 'AI · 完整 · 可能有误'

export type LookupKind = 'quick' | 'full' | 'dict' | 'search'

/**
 * ⑥ · Lookup 的 AI 搜索（2026-09-01）
 *
 * 和 Assist 那两条**分开**，因为要的东西不一样：
 * 气泡的 full 是「解释屏幕上这个词，我知道它出现在哪句话里」；
 * 这里是「我主动去查一个词或短语，**没有上下文**」——
 * 没有上下文就不该硬猜义项，该把常见的几个都摆出来。
 *
 * ★ 覆盖存 user_preferences（键 prompt.lookup-search，见 core/prompt-overrides.ts）
 *   —— 他写的东西跟着人走。Windows 没有这个功能，那边不读它。
 */
export const DEFAULT_SEARCH_PROMPT =
  '你是给中文母语者用的英语助手。用户主动查一段英文，没有上下文。' +
  SHAPE_RULE +
  '按这些小节组织：释义（中文；词/词组把常见义项按使用频率排、各给一句话，' +
  '整句整段就说这一整段的意思）、' +
  '用法（词性 · 常见搭配 · 语域；整句整段讲结构与关键搭配）、' +
  '例句（两句地道例句，各附中文翻译）、' +
  '辨析（和哪些近义表达容易混，怎么分；没有就省略）。' +
  '小节标题独占一行。直接给内容，不要寒暄，不要重复用户输入的原文。'

export async function assistLookup(
  db: Db,
  kind: LookupKind,
  term: string,
  sentence: string | null
): Promise<LookupResult> {
  if (kind === 'dict') return dictLookup(db, term)

  const quick = kind === 'quick'
  const search = kind === 'search'
  /**
   * 三条提示词各有各的岗位，来源也不一样：
   *   quick / full   Assist 自己的设置（settings，本机 · D-404⑦）
   *   search         Prompt 专区（user_preferences，跟着人走 · ⑥/⑤）
   */
  const sys = search
    ? ((await pref(db, promptPrefKey('lookup-search'))) ?? '').trim() || DEFAULT_SEARCH_PROMPT
    : ((await setting(db, quick ? 'assist.ai.quickPrompt' : 'assist.ai.prompt')) ?? '').trim() ||
      (quick ? DEFAULT_QUICK_PROMPT : DEFAULT_AI_PROMPT)
  /**
   * ★★ 输入原样送出，并且说清它是什么形态（2026-09-03）——
   *   老写法是 `词：<原文>`，把一整句叫成「词」，于是模型从里面挑一个词讲。
   *   判据在 `lookupUser` / `shapeOf`，三条路共用同一份。
   */
  const shape = shapeOf(term)
  const user = lookupUser(term, search ? null : sentence, shape)
  const long = shape === 'sentence' || shape === 'passage'
  const text = await callAi(
    await resolveSlot(db, 'light'), // D-202 · 量大要求低那一组（练习出题同槽）
    {
      system: sys,
      user,
      /**
       * ★ 简明那一条的额度按形态放宽：整句要说的是**整段意思**，
       *   卡在 120 token 上会被从中间切断，而切断的样子恰好像
       *   「它只讲了前半句」。
       *
       * ★★ 2026-09-13 抬高：这三个数是照**不做思考的模型**定的。
       *   使用者配的是 `deepseek-flash`（推理模型），它**先把思考写进
       *   `reasoning_content`、再写 `content`，两者共用同一个 `max_tokens`**。
       *   于是 120 个 token 连想都想不完：`content` 一个字都没有，
       *   core 报「模型返回了空内容」（真机原始响应核过）。
       *
       *   ☆ 抬高不是「用钱换正确」：**`max_tokens` 是上限不是目标** ——
       *     不做思考的模型写完就停，抬高对它们一分钱不多花；
       *     只有推理模型会真的用到，而那正是需要的。
       *   ☆ 超时跟着抬：额度大了模型写得也久，不抬就把「空内容」
       *     换成「超时」，那是我自己引入的新毛病，不是修好。
       *   ☆ core 那半（`pick()` 不认得 `reasoning_content`、报错话术把人往
       *     「模型名不对」上带）已报给 Windows 会话 —— 一份 core，不在这边改。
       */
      maxTokens: quick ? (long ? 1200 : 900) : 3000,
      timeoutMs: quick ? (long ? 45_000 : 35_000) : 60_000
    },
    'light'
  )
  if (quick) return { sections: [{ label: '', text: cleanQuick(text) }], note: QUICK_LOOKUP_NOTE }
  return {
    sections: parseAiSections(text),
    // ★ 如实标：是 AI 生成的、可能有误（D-395 同一条诚实原则）
    note: search ? AI_LOOKUP_NOTE : FULL_LOOKUP_NOTE
  }
}

/** 跟着人走的那一类（user_preferences）—— 与 settings 是两张表，别混 */
async function pref(db: Db, key: string): Promise<string | null> {
  const r = await db.get(`select value from user_preferences where key = ?`, [key])
  return r?.['value'] != null ? String(r['value']) : null
}

async function setting(db: Db, key: string): Promise<string | null> {
  const r = await db.get(`select value from settings where key = ?`, [key])
  return r?.['value'] != null ? String(r['value']) : null
}

/** 写一条 DEVICE 设置。`settings` 不进 `SYNC_TABLES` —— 这一条**不跟着人走** */
async function settingSet(db: Db, key: string, value: string): Promise<void> {
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()]
  )
}

/**
 * Dictionary 行为（D-404⑤ 起改为**主动调用**）：本地词典（MDX，core/dict/mdx
 * 同一份解析）→ 库内现成释义 → miss。词典命中按书名标节并带原始 HTML；
 * 库内释义如实标来源，不冒充词典。
 */
async function dictLookup(db: Db, term: string): Promise<LookupResult> {
  const sections: LookupSection[] = []
  let hadBooks = false
  try {
    hadBooks = (await listDicts(db)).some((d) => d.enabled && !d.missing && d.status === 'ok')
    for (const h of await lookupDicts(db, normalizeTerm(term) || term)) {
      sections.push({
        label: h.book,
        text: h.text,
        ...(h.html ? { html: h.html } : {}),
        ...(h.css ? { css: h.css } : {})
      })
    }
  } catch {
    // 词典层挂了不挡库内释义 —— miss 的话术会如实落到「没装/没命中」
  }
  const norm = normalizeTerm(term)
  if (norm) {
    const r = await db.get(
      `select gloss, gloss_zh as z from items
        where deleted_at is null and lower(trim(term)) = ? limit 1`,
      [norm]
    )
    if (r?.['gloss']) sections.push({ label: '释义 · NYX 库', text: String(r['gloss']) })
    if (r?.['z']) sections.push({ label: '中文 · NYX 库', text: String(r['z']) })
  }
  if (sections.length === 0) {
    return {
      miss: true,
      sections: [],
      note: hadBooks
        ? '词典没命中 · 库内也没有现成释义'
        : '本地词典还没装（D-336）· 库内也没有现成释义'
    }
  }
  return { sections, note: null }
}

// ── 展示层整理器（D-401⑦：模型自由生成，UI 负责整理成稳定分节）────

/**
 * D-404④ · 简明释义的整理：模型偶尔仍会加标题/围栏/引号 ——
 * 卡片第一行只该是释义本身，所以这里**只留内容**：剥围栏与行内记号，
 * 丢掉「释义：」这类前缀，最多留两行。不改字，只做减法。
 */
export function cleanQuick(raw: string): string {
  const t = raw
    .trim()
    .replace(/^```[a-z]*\r?\n?/i, '')
    .replace(/\r?\n?```$/, '')
  const lines: string[] = []
  for (const line0 of t.split(/\r?\n/)) {
    let line = cleanLine(line0.trim())
    if (!line) continue
    line = line.replace(/^(?:释义|意思|含义|解释|meaning|definition)\s*[:：]\s*/i, '')
    line = line.replace(/^[「"'“]+|[」"'”]+$/g, '').trim()
    if (line) lines.push(line)
    if (lines.length === 2) break
  }
  return lines.join('\n')
}


/**
 * ══ 认读牌面（D-479 · 2026-09-08）════════════════════════════
 *
 * 提示词是**两件东西拼出来的**，拼装只有 core 一处（`buildReadingPrompt`）：
 *   出题规则   `user_preferences['prompt.reading-card']`（键没变，含义改成规则正文）
 *   勾了哪几面 `user_preferences['reading.faces']`
 * 两把都是同步表、跟着人走，所以「同一份偏好在两台机器上算出同一份提示词」
 * 是**结构性**的 —— 各拼各的话，两边都说得通、都不报错。
 *
 * ★ 手机**不做**牌面 / 规则的设置界面（T-9.18）：读同步来的值就是了。
 */
const FACES_KEY = 'reading.faces'
/**
 * ★★ 这个记号是 **DEVICE**，存 `settings`，**不进偏好白名单**（core `bec53da`）。
 *
 * 原来它归 USER。core 那边写着为什么改：
 *   「2026-09-08 它在白名单里待过一天，`smoke:sync` 的 S7 当场红：
 *    这一行是『第一次读认读状态就无条件写一次』，而偏好行的 uid 由键名算出来 ——
 *    两台机器算出同一个 uid、各写各的时间戳 = 必然冲突。」
 *
 * 本仓原来担心的是「第二台会重迁、拿出厂规则盖掉他改过的正文」——
 * core 的答复：迁移靠**判**（`migrateLegacyReadingPrompt` 认不出来就一个字不动），
 * 所以记号不必跟着人走。新机器自己判一次就行。
 *
 * ★ 白名单的判据在 core（`prefs.ts` 的 22 项），本文件只负责「往哪张表写」。
 */
const FACES_MIGRATED_KEY = 'reading.facesMigratedAt'

/**
 * ★★ 上一次牌面为什么没出来 —— ③ 档验收通道（不看界面，看变量）。
 *
 * 为什么要记：D-338 说失败一律安静退回机械挖空，于是**所有失败长得一模一样**。
 * 「他一面都没勾」和「AI 超时了」在屏幕上都是一张机械挖空卡，而处置完全不同。
 * 账在这里，屏幕上照旧不打扰。
 */
export type ReadingFaceWhy = 'ok' | 'no-faces' | 'ai-failed' | 'unparsed' | 'revealed'
export let lastFaceWhy: ReadingFaceWhy = 'ok'

/**
 * ★★★ 老数据一次性迁移：从「五份整段提示词选一份」到「牌面 + 规则」。
 *
 * 判据在 core（`migrateLegacyReadingPrompt`）：认出那一份是哪种考法 → 勾上对应牌面、
 * 规则回出厂；**认不出（他自己写过的）→ 一个字都不动**，那段正文原地变成他的「规则」。
 *
 * ★ 幂等靠记号（`reading.facesMigratedAt`），不靠比对形状 —— `tts.sources` 那次
 *   （I-156 三张脸）的教训：形状每一版都在变，记号不会。
 * ★★ 记号是 **DEVICE**（`settings`，不同步）—— 2026-09-09 跟 core 改的，
 *   原因见 `FACES_MIGRATED_KEY` 上面那一段（S7：同一个 uid 两边各写，重放会改状态）。
 * ★ 手机上没有牌面设置界面，所以这一步**挂在发牌面这条路上**：一次多读一个记号，
 *   而它是每天都会走到的那条路 —— 挂在别处等于「他不去开那一页就永远不迁」。
 */
async function migrateReadingFacesOnce(db: Db): Promise<void> {
  if ((await setting(db, FACES_MIGRATED_KEY)) !== null) return
  /**
   * ★ 一次性接旧值：这台机器在搬家之前已经把记号写进过 `user_preferences`
   *   （T-9.18 之后的每一版都在写）。搬家当天如果直接当「没迁过」，
   *   就会在**他的真库上**再跑一次迁移 —— 虽然按上面那条「认内容」的理由
   *   它多半什么都不动，但「多半」不是判据。读到旧值就直接认账并落到新位置。
   * ★ 旧那一行**不删**：同步表上不许裸 delete（D-436）。它从此没人读，
   *   而且已经不在 core 的白名单里了。
   */
  const legacy = await pref(db, FACES_MIGRATED_KEY)
  if (legacy !== null) {
    await settingSet(db, FACES_MIGRATED_KEY, legacy)
    return
  }
  const got = migrateLegacyReadingPrompt(await pref(db, promptPrefKey('reading-card')))
  if (got) {
    await prefSet(
      db,
      FACES_KEY,
      serializeFacePrefs(READING_FACES.map((f) => ({ id: f.id, on: got.faceIds.includes(f.id) })))
    )
    /**
     * ★★ 2026-09-15（D-482）起**不再回写规则正文**。
     *   那把键已经从 `OVERRIDABLE_PROMPTS` 摘掉，`prefSet` 会当场抛 ——
     *   而就算不抛也不该写：规则现在由三个选项决定，正文不参与拼装。
     *   他那段正文**原样留在库里**（同步表上不许裸 delete，D-436），
     *   认读设置页只读展示（`legacyReadingRules`）。
     * ★ 牌面那一半照迁：勾哪几面和选项是两件事，D-479 那条判据没变。
     */
  }
  await settingSet(db, FACES_MIGRATED_KEY, String(Date.now()))
}

/**
 * ★★ 这一次真正要发给 AI 的两段（规则 + 他勾的那几面）。
 *
 * 抽出来是为了它**能被用例盯住**：`readingFace` 底下要真发一次 AI 请求，
 * 而「两端算出同一份提示词」这件事必须在**不发请求**的情况下验得了 ——
 * 否则那条对照只能靠人读代码比对，而那正是两份判据长出来的方式。
 * （`tests/core-parity.test.ts::P-20` 拿它与 core 的 `buildReadingPrompt` 逐字对。）
 *
 * ★ 拼装本身一个字都不在这里：这里只负责「把偏好读出来」。
 * ★ 一面都没勾 → core 回 `null`，**不兜底**（不偷偷按全开出题）：
 *   那是他明确取消掉的东西，替他勾回来就是「我的选择不算数」。
 */
export async function readingPromptFor(
  db: Db,
  term: string,
  gloss: string | null,
  quote: string | null,
  /**
   * ★★★ 哪一条知识点。R-1「轮着来」要它去查「这一条上次用了哪一面」。
   *
   * **必填**（没有对象就显式传 `null`），主控 2026-09-15 定 —— 它原来是
   * `itemId: number | null = null`，而那个默认值把一整类错误变成了静默的：
   * 漏传照样编译、照样返回一个对象、照样不报错，只是「轮着来」退化成
   * 按原序，而他在电脑上明明选了轮转。**屏幕上什么都不会说。**
   *
   * ★ 本文件下面 `onFaces` / `onFaceIds` 那一段记的是同一个形状的事故
   *   （签名向后兼容 → 挪指针那趟 svelte-check 0 errors，错的那一行没人拦）。
   *   去掉默认值之后，「将来多一处调用点忘了传」从**潜在**变成**编译期红**。
   */
  itemId: number | null
): Promise<{ system: string; user: string } | null> {
  return (await readingBuild(db, term, gloss, quote, itemId)).built
}

/** 这一条上次用了哪一面 —— **DEVICE**（`settings`，不进同步表；主控 2026-09-15 改判） */
const LAST_FACE_KEY = 'reading.lastFace'

/**
 * ★ 按 **uid** 存不按本机 id：`settings` 不同步，但库会被还原 / 导回，
 *   本机 id 在那之后可能指向另一条知识点，uid 不会。
 */
async function itemUidOf(db: Db, itemId: number): Promise<string | null> {
  const r = await db.get(`select uid from items where id = ?`, [itemId])
  return r?.['uid'] != null ? String(r['uid']) : null
}

/**
 * 拼一次要的全部材料。`readingFace` 也要用里面的 `faces` 去反查「刚才用了哪一面」，
 * 所以读一次、两处共用 —— 分开读两次的话，中间他改了偏好，记下的就不是真用的那一面。
 */
async function readingBuild(
  db: Db,
  term: string,
  gloss: string | null,
  quote: string | null,
  itemId: number | null
): Promise<{ built: { system: string; user: string } | null; faces: FacePref[]; uid: string | null }> {
  await migrateReadingFacesOnce(db)
  /**
   * ★★ 2026-09-15（D-482）起收的是**三个选项**，不再是 `prompt.reading-card` 那段正文。
   *   他以前写的那段还躺在库里、设置页只读可看，**但不再参与拼装** ——
   *   core 那句话是判据：「两个真相里只能留一个，而他裁的是『点选项』那一个」。
   * ★ `readingRulesOf` 是**同步**的（偏好读出来是字符串），而本端的偏好是异步表，
   *   所以先把三把键读成一张 map 再递同步闭包进去。认不出的值由 core 回出厂，不在这里兜。
   */
  const keys = [
    QUIZ_RULE_KEYS.facePick,
    QUIZ_RULE_KEYS.readingHint,
    QUIZ_RULE_KEYS.shiftContext
  ] as const
  const vals = await Promise.all(keys.map((k) => pref(db, k)))
  const got = new Map(keys.map((k, i) => [k as string, vals[i] ?? null]))
  const rules = readingRulesOf((k) => got.get(k) ?? null)

  const uid = itemId == null ? null : await itemUidOf(db, itemId)
  const lastFaceId =
    uid == null ? null : (parseLastFace(await setting(db, LAST_FACE_KEY))[uid] ?? null)
  /**
   * ★★★ 这里必须是 `onFaces`（整条偏好），**不是 `onFaceIds`（只有 id）**。
   *
   * 自建那一面（使用者 2026-09-14「新建牌面」）的正文 —— 名字 / 给他看什么 /
   * 给 AI 的那段 —— **没有表可放**，它跟着 `reading.faces` 这条偏好走。
   * 只递 id 的话，拼装那一步 `faceById(id)` 查不回来，那一面会被**静静丢掉**：
   * 他在电脑上建了一面、勾上了，手机出题时当它不存在，而屏上什么都不会说。
   *
   * ★★ 而 `buildReadingPrompt` 的签名是**向后兼容**的（`(string | FacePref)[]`），
   *   所以写成 `onFaceIds` **照样编译、照样返回一个对象、照样不报错** ——
   *   2026-09-14 挪指针那一趟 `svelte-check` 就是 0 errors。
   *   这一行只能靠 `tests/lookup.test.ts::R-5` 那道闸守着。
   */
  const faces = onFaces(parseFacePrefs(await pref(db, FACES_KEY)))
  return { built: buildReadingPrompt(rules, faces, term, gloss, quote, lastFaceId), faces, uid }
}

/**
 * 记下「这一条刚用了哪一面」（R-1「轮着来」要的那个数）。
 *
 * ★ 认不出形式名就**什么都不记** —— 见 core-link 里 `resolveFace` 那段注释。
 * ★ 写 `settings`：本机那张表，不带 uid、不进 `SYNC_TABLES`，这一笔不会推上云。
 */
async function markLastFace(
  db: Db,
  uid: string | null,
  faces: readonly FacePref[],
  form: string
): Promise<void> {
  if (!uid) return
  const name = form.trim()
  if (!name) return
  const hit = faces.find((p) => resolveFace(p)?.name === name)
  if (!hit) return
  const id = resolveFace(hit)?.id
  if (!id) return
  await settingSet(db, LAST_FACE_KEY, noteLastFace(await setting(db, LAST_FACE_KEY), uid, id))
}

/**
 * 生成一张牌面。失败一律返回 null —— 调用方退回机械牌面（D-338）。
 * ★ 用 light 槽（D-202：量大要求低的那一组，和练习出题同槽）。
 */
export async function readingFace(
  db: Db,
  term: string,
  gloss: string | null,
  quote: string | null,
  /**
   * R-1「轮着来」要按知识点记「上次用了哪一面」。
   * ★ **必填** —— 理由与 `readingPromptFor` 那一处同一条（主控 2026-09-15 定）。
   */
  itemId: number | null
): Promise<ReadingFace | null> {
  try {
    /**
     * ★ 一面都没勾时**不叫 AI**，直接退回机械牌面。
     * ★ 手机上没有「去把某一面勾回来」的入口（设置界面在电脑那侧），所以这里
     *   **不在屏幕上说那句话** —— 照 `BOTH_OFF_SAYS` 那次的教训：话里指的入口
     *   这一端根本没有，他会去找一个不存在的开关。理由记在账上（`lastFaceWhy`）。
     */
    const { built, faces, uid } = await readingBuild(db, term, gloss, quote, itemId)
    if (!built) {
      lastFaceWhy = 'no-faces'
      return null
    }
    const text = await callAi(
      await resolveSlot(db, 'light'),
      // ★ 同上（2026-09-13）：200 是照不做思考的模型定的，推理模型光思考就超了。
      //   上限不是目标 —— 写完就停的模型不会因为这一改多花一分钱。
      { system: built.system, user: built.user, maxTokens: 1000, timeoutMs: 35_000 },
      'light'
    )
    const f = parseFace(text)
    if (!f) {
      lastFaceWhy = 'unparsed'
      return null
    }
    // ★★ 红线自查：露了答案就作废（D-390，判据在 core，两端同一份）
    if (revealsAnswer(f.text, term)) {
      lastFaceWhy = 'revealed'
      return null
    }
    lastFaceWhy = 'ok'
    // ★ 只有真的出成了一张牌面才记 —— 作废掉的那几条（没解析出来 / 露了答案）不算用过
    await markLastFace(db, uid, faces, f.form)
    return f
  } catch {
    // D-338 · AI 不在不许阻断认读
    lastFaceWhy = 'ai-failed'
    return null
  }
}

;(globalThis as Record<string, unknown>)['nyxRead'] = {
  readingFace,
  parseFace,
  revealsAnswer,
  /** ★ 上一次牌面为什么没出来（D-338 让所有失败长得一样，账得有地方看） */
  why: () => lastFaceWhy
}


/**
 * 他以前写的那段出题规则正文（只读展示用 · A-5 老数据认账）。
 *
 * ★ 只**读**不写：这把键 2026-09-15 起已经不在偏好白名单里（退役的是输入方式），
 *   `prefSet` 会拦下任何写入。旧行原样留着，认读设置页照它决定要不要出那一行
 *   「你以前写的出题规则已经收起来了，在这儿可以看到」。
 * ★★ 判据在 core（`legacyReadingRulesOf`）：**每一版出厂正文都要认**，不是只认今天这份。
 *   本仓 2026-09-15 先写了一份「和今天的出厂比」，装到真机上当场露馅 ——
 *   他库里躺着的是**上一版**出厂正文，于是被判成「他改过」，屏上多出一行
 *   「你以前写的出题规则已经收起来了」，而他一个字都没写过。
 */
export async function legacyReadingRules(db: Db): Promise<string | null> {
  return legacyReadingRulesOf(await pref(db, promptPrefKey('reading-card')))
}
