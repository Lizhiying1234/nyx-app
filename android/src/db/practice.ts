/**
 * 产出线（阶段 4 第二件）—— **判据只有一份**：
 *   四档推进/攻坚/静默 = core/grading.ts::applyGrade；档位 = core/progression.tierFor；
 *   出题计划/配额/换型 = core/qtype-plan；讲次排期 = core/sm2-lecture.nextLectureInterval；
 *   AI 客户端（三协议/四失败态）= core/ai/client。全部 direct import（D-365）。
 *
 * 这里逐字港 Windows `study.ts` 的平台面（行号为 2026-08-30 基线）：
 *   qtypes/order/qtypeSignature/plan/typesBrief（759-960）· ensureQuestions（985-1160）·
 *   nextQuestion（1221-1271）· submitAnswer（1279-1426）· usedHint（1428-1453）·
 *   productionQueueMany/queueByIds/orderItems（604-660）· startSession/rulesSnapshot
 *  （2701-2735）· settleLectures/settleInTx（2450-2600）· levelForPrompts（assess.ts 71-92）。
 *
 * ★ D-129：一次生成五档各 3 道，**只在进入测试时触发**；此后该条目完全离线可用。
 * ★ D-119/I-069：判分 temperature 0 —— 必须可复现。
 * ★ D-121/M-019：只有第一次提交推进进度；D-122：过关才给范文。
 * ★ D-349：answers/review_logs/sessions 带 device · duration_ms · rules 快照。
 * ★ sessions 的唯一创建者就是这里的 startSession（'production'）。
 * ★ P1-4 同类「第二份」（SQL 面），待上提 core。
 */
import {
  applyGrade,
  callAi,
  DEFAULT_GRADING,
  DEFAULT_LECTURE,
  DEFAULT_READING,
  dueAfter,
  extractJson,
  fitQuota,
  isAllowedType,
  nextLectureInterval,
  penalizeFromHint,
  planQuestions,
  preferDifferent,
  CROSS_TYPE_WINDOW,
  clampQuestionsPerItem,
  type Grade,
  type GradingConfig,
  type ItemProgress,
  type QSlot,
  // ★ 产出适用判据的 SQL 形态（F-017）—— 与 core/silence.ts::productionApplies 一一对应
  PRODUCTION_APPLIES
} from '../core-link.ts'
import { resolveSlot } from './ai.ts'
import * as ledger from './ledger.ts'
import { loadPromptFor } from './prompts.ts'
// ★ `fill` 在 core（判据一份）—— 不经 `prompts.ts` 转手，那就是 D-238 说的「包装」。
import { fill } from '../core-link.ts'
import { prefNumber, prefRaw } from './prefs.ts'
/**
 * 出题规则写作层那四个选项（D-482）。拼出来的英文句子逐字在 core ——
 * 本仓一个字都不许写第二份，写了就是「同一个 Nyx 在两台机器上出的题不一样」。
 */
import {
  CONTEXT_SPREAD_LINES,
  QUIZ_RULE_KEYS,
  buildPracticeRules,
  joinLines,
  practiceGlobalLines,
  practiceHintLines,
  practiceRulesOf,
  effectiveQTypePrompt,
  type PracticeRules
} from '../core-link.ts'
import { deviceCol, dueCount, readingConfig } from './reading.ts'
import type { Db } from './types.ts'

/** 事务包裹（manage.ts 同款；出任何事回滚再抛） */
async function inTx<T>(db: Db, body: () => Promise<T>): Promise<T> {
  await db.begin()
  try {
    const out = await body()
    await db.commit()
    return out
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }
}

// ── 题型与偏好 ────────────────────────────────────────────────

interface QTypeRow {
  uid: string
  key: string
  name: string
  brief: string
  guide: string
  prompt: string
  enabled: boolean
  /**
   * ★★★ I-187 补的这一列：**内置还是他自建的**。
   *
   * 它一直在 SQL 的 select 里，却在下面那个 `.map()` 里被**丢掉了** ——
   * 于是这一端的生成路**根本分不出内置和自建**，只能按「有 prompt 就用 prompt」办事。
   * 那 10 种内置题型带着错位的英文正文一直按错的提示词出题，
   * 而屏幕上、库里、用例里**没有任何东西会报错**。
   * ☞ 少读一列不会红，它只是让一整类判断**失去可表达性**。
   */
  builtin: boolean
}

/**
 * main/db/qtypes.ts::SEL + active 逐字（toRow 的布尔归一并入）。
 * ★ D-478：`tier` 列不再选、也不再拿它排序 —— 顺序就是**他自己排的** `sort`。
 *   列按 D-216 留在表上，只是没有人读它了。
 */
async function qtActive(db: Db): Promise<QTypeRow[]> {
  const rows = await db.all(
    `select uid, key, name, brief, guide, prompt, enabled, canonical, builtin, sort
       from qtypes where deleted_at is null order by sort, uid`
  )
  return rows
    .map((r) => ({
      uid: String(r['uid'] ?? ''),
      key: String(r['key'] ?? ''),
      name: String(r['name'] ?? ''),
      brief: String(r['brief'] ?? ''),
      guide: String(r['guide'] ?? ''),
      prompt: String(r['prompt'] ?? ''),
      enabled: Number(r['enabled'] ?? 0) !== 0,
      builtin: Number(r['builtin'] ?? 0) !== 0
    }))
    .filter((q) => q.enabled)
}

export interface PracticeOrder {
  items: 'seq' | 'random'
  qtypes: 'seq' | 'random'
}

export async function order(db: Db): Promise<PracticeOrder> {
  const raw = await prefRaw(db, 'practice_order')
  const def: PracticeOrder = { items: 'seq', qtypes: 'seq' }
  if (raw === null) return def
  try {
    const v = JSON.parse(raw) as Partial<PracticeOrder>
    return {
      items: v.items === 'random' ? 'random' : 'seq',
      qtypes: v.qtypes === 'random' ? 'random' : 'seq'
    }
  } catch {
    return def
  }
}

/** 他勾了哪些题型；从来没设置过 = 全都要（和「清空了」是两回事） */
export async function qtypesPicked(db: Db): Promise<string[]> {
  const known = (await qtActive(db)).map((q) => q.key)
  const raw = await prefRaw(db, 'qtypes')
  if (raw === null) return known
  try {
    const v = JSON.parse(raw) as unknown
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return list.filter((x) => known.includes(x))
  } catch {
    return known
  }
}

async function qtypeSignature(db: Db): Promise<string> {
  const on = new Set(await qtypesPicked(db))
  const parts = (await qtActive(db))
    .filter((q) => on.has(q.key))
    /**
     * ★★★ I-187 的**第二张脸**（派单只点了 `typesBrief`）。
     *   这个指纹决定「要不要把没做的题删掉重出」。按 `prompt || guide` 算的话，
     *   那 10 段错位的英文垃圾仍在参与这个判断 —— 病治了一半。
     * ★ 换成 core 那一份之后长度会变 → **未做的题会全量重出一次**，那是对的。
     */
    .map((q) => `${q.key}:${effectiveQTypePrompt(q).length}`)
    .sort()
  return `${(await order(db)).qtypes}|${parts.join('|')}`
}

/**
 * 这一条这次出哪几道题。
 *
 * ★ 2026-09-08 · D-478：原来是「五档 × 每档 3 道」（`perTier = 3`，D-129 定死）。
 *   档没了之后，**一次出几道由他自己定** —— `param.questionsPerItem`，归 USER
 *   （他想要练几道，换台设备该跟着走）。手机没有练习设置页（TM-21），
 *   这个值**靠同步跟着电脑上的设置走**；没设过就是出厂 15（= 原来五档各 3 道，
 *   换机制不改他今天拿到的量）。出厂值与夹取在 core 一处，两端同一份。
 */
async function planFor(db: Db, itemId: number): Promise<QSlot[]> {
  const all = (await qtActive(db)).map((q) => ({ key: q.key }))
  const count = clampQuestionsPerItem(await prefRaw(db, 'param.questionsPerItem'))
  return planQuestions(all, await qtypesPicked(db), count, (await order(db)).qtypes, Math.random, itemId)
}

/**
 * 提示词里「这一批写哪几道」的那段英文。
 *
 * ★ 2026-09-08 · D-478：原来按五档分成五段（`**Tier n**`），每段说这一档写几道。
 *   档没了 —— 现在是**一张单子**，第几道该是哪一种，逐条写死。
 *   AI 照着这张单子写，回来之后 `fitQuota` 再逐条比对（判据在 core，不在这里）。
 */
async function typesBrief(db: Db, plan: QSlot[], rules: PracticeRules): Promise<string> {
  const NL = String.fromCharCode(10)
  const byKey = new Map((await qtActive(db)).map((q) => [q.key, q]))
  const lines: string[] = []
  if (plan.length > 0) {
    const kinds = new Set(plan.map((x) => x.type)).size
    lines.push(`Write exactly ${plan.length} questions, in this order:`)
    plan.forEach((s, i) => {
      lines.push(`${i + 1}. type must be exactly \`${s.type}\``)
    })
    if (kinds > 1) {
      lines.push(
        `   (this batch must use ${kinds} different forms — writing all ${plan.length} in one form gets them thrown away)`
      )
    }
    lines.push('')
  }
  const used = [...new Set(plan.map((s) => s.type))]
  if (used.length > 0) {
    lines.push('### What each `type` means')
    lines.push('')
    for (const key of used) {
      const q = byKey.get(key)
      /**
       * ★★★ I-187（使用者 2026-09-15 答「那些正文是生成的，不是我写的」）：
       *   内置题型**只用 `guide`**，`prompt` 一个字不读；自建仍是 `prompt || guide`。
       * ★ 判据在 core 一份 —— 两端各写一份的话，同一个题型在电脑上按 guide 出、
       *   在手机上按那段垃圾出，而**两边都不报错**。
       */
      const body = q ? effectiveQTypePrompt(q) : ''
      if (!body) continue
      lines.push(`#### \`${key}\``)
      lines.push('')
      lines.push(body)
      /**
       * ★ W-3「必须写完整句」/ W-4「贴着原文语域」**跟着每一种题型走**，不全局拼一次：
       *   全局拼的话「必须写完整句」会落在本来就要写 80–120 词的成段题型头上。
       *   哪几种不拼由 core 判（`buildPracticeRules`），界面上不做特例、不加说明。
       */
      for (const extra of buildPracticeRules(rules, key)) lines.push(extra)
      lines.push('')
    }
  }
  return lines.join(NL)
}

/**
 * assess.ts::levelForPrompts 逐字（含静默词校准 —— ≥50 条才附）。
 *
 * ★ T-5.12 起 `db/analyse.ts` 也要它：Windows 那侧 `ensureAnalysis` 里的
 *   `this.level()` 就是同一个函数（`main/index.ts` 把它接到 `assess.levelForPrompts()`）。
 *   所以这里导出，**不在解析那边再抄一份** —— 抄一份的后果是同一条知识点
 *   在出题和解析里被当成两种水平的人学的，而两边都说得通。
 */
const FALLBACK_LEVEL = 'upper-intermediate (B2)'
export async function levelForPrompts(db: Db): Promise<string> {
  const a = (await db.get(
    `select reading_level as reading, production_level as production
       from assessments order by id desc limit 1`
  )) as { reading: string; production: string } | undefined
  const base = a ? `reading ${a.reading} / production ${a.production}` : FALLBACK_LEVEL
  const silenced = (
    await db.all(
      `select term from items
        where deleted_at is null and production_state = 'silent' order by updated_at desc limit ?`,
      [60]
    )
  ).map((r) => String(r['term']))
  if (silenced.length < 50) return base
  return (
    `${base}. Calibrate against what this learner已经 reliably produces — ` +
    `these are expressions they have used correctly three separate times:\n` +
    silenced.slice(0, 40).join(' · ')
  )
}

// ── 生效参数（rules 快照与判分都用它）──────────────────────────

export interface EffectiveParams {
  grading: GradingConfig
  lecture: typeof DEFAULT_LECTURE
  reading: typeof DEFAULT_READING
  dailyTarget: number
  readingDailyCap: number
}

/** main/params.ts::effective 同口径（默认值：main DEFAULTS —— dailyTarget 35 / cap 100） */
export async function effectiveParams(db: Db): Promise<EffectiveParams> {
  return {
    grading: {
      silenceStreak: await prefNumber(db, 'param.silenceStreak', DEFAULT_GRADING.silenceStreak),
      hardTrigger: await prefNumber(db, 'param.hardTrigger', DEFAULT_GRADING.hardTrigger),
      graceAttempts: await prefNumber(db, 'param.graceAttempts', DEFAULT_GRADING.graceAttempts)
    },
    lecture: {
      ...DEFAULT_LECTURE,
      minSample: await prefNumber(db, 'param.minSample', DEFAULT_LECTURE.minSample)
    },
    reading: await readingConfig(db),
    dailyTarget: await prefNumber(db, 'param.dailyTarget', 35),
    readingDailyCap: await prefNumber(db, 'param.readingDailyCap', 100)
  }
}

// ── 队列 ──────────────────────────────────────────────────────

export interface QueueItem {
  id: number
  term: string
  corrects: number
}

/** Fisher–Yates（Windows shuffled 同款） */
function shuffled<T>(rows: T[]): T[] {
  const out = [...rows]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

async function orderItems<T>(db: Db, rows: T[]): Promise<T[]> {
  return (await order(db)).items === 'random' ? shuffled(rows) : rows
}

export async function productionQueueMany(db: Db, lectureIds: number[]): Promise<QueueItem[]> {
  if (lectureIds.length === 0) return []
  const marks = lectureIds.map(() => '?').join(',')
  const rows = (await db.all(
    `select distinct i.id, i.term, i.corrects from items i
       join item_lectures il on il.item_id = i.id and il.deleted_at is null
      where il.lecture_id in (${marks}) and i.deleted_at is null
        and ${PRODUCTION_APPLIES('i')} and i.production_state in ('new','training')
      order by i.id`,
    lectureIds
  )) as unknown as QueueItem[]
  return orderItems(db, rows)
}

/** 指定一批条目来练 · D-012（静默的排除 —— D-024） */
export async function queueByIds(db: Db, ids: number[]): Promise<QueueItem[]> {
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(',')
  const rows = (await db.all(
    `select id, term, corrects from items
      where id in (${marks}) and deleted_at is null
        and production_state in ('new','training','hard')
      order by id`,
    ids
  )) as unknown as QueueItem[]
  return orderItems(db, rows)
}

// ── 出题 ──────────────────────────────────────────────────────

export interface QuestionRow {
  id: number
  type: string
  prompt: string
  context: string
  reference: string | null
}

/**
 * D-129 · 没有可用题就现场生成（五档各 3 道，light 槽），此后完全离线。
 * 题型勾选变过 → 未用的旧题整批作废重生成（qtype_sig 对不上）。
 */
export async function ensureQuestions(db: Db, itemId: number): Promise<number> {
  const picked = await qtypesPicked(db)
  if (picked.length === 0) {
    throw new Error('你还没有选题型 —— 去设置挑几种，再开始练。')
  }

  const sig = await qtypeSignature(db)
  const stale = Number(
    (
      await db.get(
        `select count(*) as n from questions
          where item_id = ? and used_at is null and coalesce(qtype_sig, '') <> ?`,
        [itemId, sig]
      )
    )?.['n'] ?? 0
  )
  if (stale > 0) {
    /**
     * ★★★ I-198（2026-09-15 · E 在 Windows 侧定位，本端同形）：
     *   这里原来是 `delete from questions where item_id = ? and used_at is null` ——
     *   **把「没做过的题」整批删掉**。但 `answers.question_id references questions(id)`，
     *   而库里可能存在**「有 answer 指着、却仍然 used_at is null」**的行
     *   （他真库里就有 1 条；本端 2026-09-15 23:24 量到 0 条，**但那是同步还没把它带过来**）。
     *   删到那一行 → 外键抛 → **产出练习从任何入口都进不去**。
     *
     * ☞ 改法：**只删没有 answer 指着的那些**；被指着的留下。
     *   留下来的那几道下一次仍然不匹配签名，但它们**已经被答过**，
     *   本来就不该算「未用的旧题」—— `used_at` 没写上才是另一件事（见下）。
     *
     * ★ 本端此刻没有坏行，所以这是**预防性**的修 —— 但那条坏行在 `answers` 里，
     *   而 `answers` 是同步表：**它随时会过来**。不能等它过来再修。
     */
    await db.run(
      `delete from questions
        where item_id = ? and used_at is null
          and id not in (select question_id from answers where question_id is not null)`,
      [itemId]
    )
    await ledger.op(db, 'regen-questions', 'item', itemId, null, { reason: '题型勾选变了', sig })
  }

  const have = Number(
    (await db.get(`select count(*) as n from questions where item_id = ? and used_at is null`, [itemId]))?.[
      'n'
    ] ?? 0
  )
  if (have > 0) return 0

  const it = (await db.get(
    `select i.term, i.gloss,
            (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote
       from items i where i.id = ?`,
    [itemId]
  )) as { term: string; gloss: string; quote: string | null } | undefined
  if (!it) throw new Error(`找不到这条知识点（id=${itemId}）`)

  const plan = await planFor(db, itemId)
  const p = await loadPromptFor(db, 'generate-questions')
  /**
   * ★★ 出题规则那四个选项（D-482）。读一次，喂给四处：
   *   `TYPES`   每一种题型的说明后面跟着 W-3 / W-4（按题型豁免，core 判）
   *   `SPREAD`  W-2 语境跨度那一段
   *   `OPTIONS` 全局那几句（现在只有 W-1「都不给」那一档有一句）
   *   `HINTS`   W-1 决定 USER 段给不给释义 / 原句
   * ★ `Target expression:` 那一行三档都给（D-137「产出这条线从不考你想不想得起这个词」），
   *   它写死在模板里，不经过选项。
   * ★ 和认读那三把同一个形状：偏好是异步表，`practiceRulesOf` 是同步的 ——
   *   先读成一张 map 再递同步闭包。认不出的值由 core 回出厂，不在这里兜。
   */
  const rKeys = [
    QUIZ_RULE_KEYS.practiceHint,
    QUIZ_RULE_KEYS.contextSpread,
    QUIZ_RULE_KEYS.requireFullSentence,
    QUIZ_RULE_KEYS.matchRegister
  ] as const
  const rVals = await Promise.all(rKeys.map((k) => prefRaw(db, k)))
  const rGot = new Map(rKeys.map((k, i) => [k as string, rVals[i] ?? null]))
  const rules = practiceRulesOf((k) => rGot.get(k) ?? null)
  const vars = {
    TERM: it.term,
    GLOSS: it.gloss || it.term,
    QUOTE: it.quote ?? '',
    LEVEL: await levelForPrompts(db),
    TYPES: await typesBrief(db, plan, rules),
    SPREAD: CONTEXT_SPREAD_LINES[rules.contextSpread],
    OPTIONS: joinLines(practiceGlobalLines(rules).map((x) => '- ' + x)),
    HINTS: joinLines(practiceHintLines(rules, { gloss: it.gloss || it.term, quote: it.quote ?? '' }))
  }
  const text = await callAi(
    await resolveSlot(db, 'light'), // D-202 · 量大、要求低，用便宜的那一组
    { system: fill(p.system, vars), user: fill(p.user, vars), json: true, maxTokens: 6000 },
    'light'
  )

  const parsed = extractJson<{ questions?: (QuestionRow & { broken?: string | null })[] }>(text)
  const all = parsed.questions ?? []

  const legal = all
    .filter((q) => isAllowedType((q as { type?: unknown }).type, picked))
    .map((q) => ({
      ...q,
      type: String(q.type).trim()
    }))

  const { kept: qs, dropped } = fitQuota(legal, plan)

  if (all.length > 0 && qs.length === 0) {
    const NL = String.fromCharCode(10)
    const got = [...new Set(all.map((q) => String((q as { type?: unknown }).type ?? '（没有 type 字段）')))]
    const why =
      legal.length === 0
        ? [
            `一道都不是你选的题型。`,
            `  它回的是：${got.join('、')}`,
            `  你选的是：${picked.join('、')}`,
            got.some((g) => picked.includes(g))
              ? ''
              : `  两边没有一个对得上 —— 这更像软件把题型要求发漏了，不是你的提示词写得不好。`
          ]
            .filter(Boolean)
            .join(NL)
        : `${dropped.length} 道超出了这一档该有的形式配额。`
    throw new Error(
      `出的题没有一道能用（收到 ${all.length} 道）。${NL}${why}${NL}这一批已经全部丢掉，没有入库；已经答过的题一个字没动。`
    )
  }

  const t = Date.now()
  let n = 0
  await inTx(db, async () => {
    for (const q of qs) {
      const broken = (q as { broken?: string | null }).broken
      /**
       * ★★ 这里的 `q.prompt` 是 **`questions.prompt`（题面正文）**，
       *   和 `qtypes.prompt`（题型的出题要求）**同名不同物**，
       *   **不走 `effectiveQTypePrompt`**。按「凡是 `.prompt` 都改」扫一遍的话，
       *   入库的题面会变成题型说明，而且不报错。同形的还有判分那处。
       */
      // 错误订正的题面需要那个错句，否则题目不成立
      const prompt = broken ? `${q.prompt}\n\n"${broken}"` : q.prompt
      if (!prompt?.trim()) continue
      // ★ tier 兜底写 1：历史列，无含义（D-216 留列，D-478 ① 退役）。
      //   schema 上是 not null 才必须写；Windows 半场取题也已不按 tier 挑，两端都不读它。
      await db.run(
        `insert into questions (item_id, tier, type, prompt, context, reference, qtype_sig, created_at, updated_at)
         values (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, q.type, prompt, q.context ?? 'original', q.reference ?? null, sig, t, t]
      )
      n++
    }
  })
  return n
}

/**
 * 下一道题 —— **换个题型**（`preferDifferent` 在 core）。
 *
 * ★ 2026-09-08 · D-478 档位取消：原来先在「当前档」里挑、挑不着再退到别档
 *   （`tierFor(corrects)` 决定当前档）。档位机制整个没了，core 的 `progression.ts`
 *   也删了，所以现在只有一条队列：**按出题时排的顺序**（`id` 就是那个顺序，
 *   `planQuestions` 一次写一批）往下取，只避开「和刚做过的那道同一种题型」。
 * ★ `questions.tier` 列还在（schema 是 not null），但**没有人再读它**——
 *   D-216 退役列只读不删，所以这里连排序都不带它了。
 */
export async function nextQuestion(db: Db, itemId: number): Promise<QuestionRow | null> {
  /**
   * ★★ M-027「连续正确的这几道要跨题型」原来是**档位链隐含**保证的：换档就换一批题型。
   *   档没了，判据必须显式写出来 —— core 的 `preferDifferent` 现在收的是
   *   **最近这几道的题型**（不是只有上一道），窗口宽度也在 core（`CROSS_TYPE_WINDOW`）。
   *   所以这里要把最近用过的那几种按「新的在后」的顺序交给它。
   */
  const recent = (
    (await db.all(
      `select type from questions
        where item_id = ? and used_at is not null order by used_at desc, id desc limit ?`,
      [itemId, CROSS_TYPE_WINDOW]
    )) as unknown as { type: string }[]
  )
    .map((r) => r.type)
    .reverse()

  const queue = (await db.all(
    `select id, type, prompt, context, reference from questions
      where item_id = ? and used_at is null order by id`,
    [itemId]
  )) as unknown as QuestionRow[]

  return preferDifferent(queue, recent)
}

// ── 会话（sessions 的唯一创建者）───────────────────────────────

async function rulesSnapshot(db: Db): Promise<string | null> {
  try {
    return JSON.stringify({
      v: 1,
      qtypes: JSON.parse((await prefRaw(db, 'qtypes')) ?? '[]') as unknown,
      practiceOrder: JSON.parse((await prefRaw(db, 'practice_order')) ?? 'null') as unknown,
      params: await effectiveParams(db)
    })
  } catch {
    // 拍不下来就留空 ——「不知道」是事实，不要编一个
    return null
  }
}

export async function startSession(db: Db, kind: string, scope: string, target: number): Promise<number> {
  const t = Date.now()
  await db.run(
    `insert into sessions (kind, scope, target, started_at, device, rules, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, scope, target, t, await deviceCol(db), await rulesSnapshot(db), t, t]
  )
  const r = await db.get(`select last_insert_rowid() as id`)
  return Number(r?.['id'] ?? 0)
}

// ── 判分 ──────────────────────────────────────────────────────

export interface GradeResult {
  grade: number
  passed: boolean
  note: string
  why: string
  annotations: { span: string; label: string; problem: string; fix?: string }[]
  /** D-122 · 第一次不给范文，改到过关才给 */
  reference: string | null
  /** 只有第一次判定才推进进度 · D-121 */
  outcome: {
    correct: boolean
    silenced: boolean
    enteredHard: boolean
    leftHard: boolean
    graced: boolean
    reason: string
    streak: number
    state: string
  } | null
}

async function progressOf(db: Db, itemId: number): Promise<ItemProgress> {
  const r = (await db.get(
    `select production_state as state, streak, attempts,
            attempts_in_stage as attemptsInStage, corrects, hard_entries as hardEntries
       from items where id = ?`,
    [itemId]
  )) as ItemProgress | undefined
  if (!r) throw new Error(`找不到这条知识点（id=${itemId}）`)
  return r
}

async function saveProgress(db: Db, itemId: number, p: ItemProgress): Promise<void> {
  const t = Date.now()
  /**
   * ★★ D-485 · 自动那条路要标 `silenced_by = 'earned'`（**已练成**），
   *   手动那条（`bulkSilence` / `setSilentNode`）写的是 `self` / 容器名 = **收起来了**。
   *   不标的话两件相反的事在库里长得一模一样，屏上只能二选一地瞎说。
   *
   * ★ 为什么非静默一律写 `null` 是安全的：`applyGrade` 对已静默的条目**直接抛**
   *   （D-024「静默条目除手动放出外不出现在任何测试中」），所以走到这里的 `prev`
   *   必然不是静默态 —— 不存在「他手动收起来的那条被判分改标成已练成」。
   */
  await db.run(
    `update items set production_state = ?, silenced_by = ?, streak = ?, attempts = ?,
                      attempts_in_stage = ?, corrects = ?, hard_entries = ?, updated_at = ?
      where id = ?`,
    [
      p.state,
      p.state === 'silent' ? 'earned' : null,
      p.streak,
      p.attempts,
      p.attemptsInStage,
      p.corrects,
      p.hardEntries,
      t,
      itemId
    ]
  )
}

export async function submitAnswer(
  db: Db,
  sessionId: number | null,
  itemId: number,
  questionId: number,
  text: string,
  isFirst: boolean,
  hinted: boolean,
  durationMs?: number
): Promise<GradeResult> {
  const q = (await db.get(`select prompt, reference from questions where id = ?`, [questionId])) as
    | { prompt: string; reference: string | null }
    | undefined
  const it = (await db.get(`select term, gloss from items where id = ?`, [itemId])) as
    | { term: string; gloss: string }
    | undefined
  if (!q || !it) throw new Error('题目或知识点找不到了')

  const p = await loadPromptFor(db, 'score-answer')
  const raw = await callAi(
    await resolveSlot(db, 'heavy'), // 判分质量决定整套机制是否成立，用最强的那一组
    {
      system: p.system,
      user: fill(p.user, {
        TERM: it.term,
        GLOSS: it.gloss || it.term,
        // ★★ 同上：这是 `questions.prompt`（题面），不是题型的出题要求 ——
        //    误改的话判分会拿题型说明去判他写的那句话，**分数照样出、评语照样有模有样**。
        PROMPT: q.prompt,
        ANSWER: text,
        REFERENCE: q.reference ?? '(none)'
      }),
      json: true,
      // I-069 · 判分必须可复现（D-119/D-237）——不定温度就会「同一句话两次判两样」
      temperature: 0,
      maxTokens: 1500
    },
    'heavy'
  )

  const j = extractJson<{
    grade?: number
    note?: string
    why?: string
    annotations?: { span: string; label: string; problem: string; fix?: string }[]
  }>(raw)

  const grade = Math.max(1, Math.min(4, Number(j.grade) || 1)) as Grade
  const annotations = (j.annotations ?? []).filter((a) => a.span && text.includes(a.span))
  const t = Date.now()

  let out: GradeResult['outcome'] = null
  await inTx(db, async () => {
    await db.run(
      // ★ V35 · device / duration_ms 见 D-349
      `insert into answers (session_id, item_id, question_id, attempt_no, is_first, text,
                            grade, annotations, feedback, reference, hinted,
                            device, duration_ms, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        itemId,
        questionId,
        isFirst ? 1 : 2,
        isFirst ? 1 : 0,
        text,
        grade,
        JSON.stringify(annotations),
        j.why ?? j.note ?? '',
        q.reference,
        hinted ? 1 : 0,
        await deviceCol(db),
        durationMs ?? null,
        t,
        t
      ]
    )
    await db.run(`update questions set used_at = ?, updated_at = ? where id = ?`, [t, t, questionId])

    if (isFirst) {
      const prev = await progressOf(db, itemId)
      const o = applyGrade(prev, grade, (await effectiveParams(db)).grading)
      await saveProgress(db, itemId, o.progress)
      // D-043 · 状态一变就记一笔
      if (o.progress.state !== prev.state) {
        await db.run(
          `insert into state_events (item_id, line, from_state, to_state, created_at, updated_at)
           values (?, 'production', ?, ?, ?, ?)`,
          [itemId, prev.state, o.progress.state, t, t]
        )
      }
      await db.run(
        `insert into review_logs (item_id, line, grade, duration_ms, device, created_at, updated_at)
         values (?, 'production', ?, ?, ?, ?, ?)`,
        [itemId, grade, durationMs ?? null, await deviceCol(db), t, t]
      )
      out = {
        correct: o.correct,
        silenced: o.silenced,
        enteredHard: o.enteredHard,
        leftHard: o.leftHard,
        graced: o.graced,
        reason: o.reason,
        streak: o.progress.streak,
        state: o.progress.state
      }
    }
  })

  const passed = grade >= 3
  return {
    grade,
    passed,
    note: j.note ?? '',
    why: j.why ?? '',
    annotations,
    // D-122 · 第一次提交只给判定与标注，不给范文；改到过关才给
    reference: passed ? q.reference : null,
    outcome: out
  }
}

/** D-138 ·「提示」按钮当分类器：判分不受影响，但记一次认读失败、该卡间隔打回 */
export async function usedHint(db: Db, itemId: number): Promise<{ gloss: string; reason: string }> {
  const it = (await db.get(`select gloss, term from items where id = ?`, [itemId])) as
    | { gloss: string; term: string }
    | undefined
  if (!it) throw new Error('找不到这条知识点')
  const cardRow = (await db.get(
    `select ease, interval_days as interval, reps, lapses, silent from reading_cards where item_id = ?`,
    [itemId]
  )) as { ease: number; interval: number; reps: number; lapses: number; silent: number } | undefined
  if (!cardRow) throw new Error('找不到这条知识点')
  if (cardRow.silent !== 0) return { gloss: it.gloss, reason: '这张认读卡不再出题了，不再调整排期' }

  const out = penalizeFromHint({ ...cardRow, silent: false }, await readingConfig(db))
  const t = Date.now()
  await db.run(
    `update reading_cards
        set ease = ?, interval_days = ?, lapses = ?, due_at = ?, updated_at = ?
      where item_id = ?`,
    [out.card.ease, out.card.interval, out.card.lapses, dueAfter(out.card.interval), t, itemId]
  )
  await db.run(
    `insert into review_logs (item_id, line, grade, interval_after, ease_after, device, created_at, updated_at)
     values (?, 'reading', 1, ?, ?, ?, ?, ?)`,
    [itemId, out.card.interval, out.card.ease, await deviceCol(db), t, t]
  )
  return { gloss: it.gloss, reason: out.reason }
}

// ── 结算 ──────────────────────────────────────────────────────

export interface Settlement {
  lectureIds: number[]
  sample: number
  distribution: Record<number, number>
  accuracy: number
  silenced: string[]
  hard: string[]
  perLecture: { lectureId: number; name: string; reason: string; nextDays: number }[]
  dueReadingCount: number
}

export async function settleLectures(
  db: Db,
  lectureIds: number[],
  sessionId: number | null
): Promise<Settlement> {
  return inTx(db, async () => {
    const t = Date.now()
    const marks = lectureIds.map(() => '?').join(',')

    const answers = (
      sessionId
        ? await db.all(
            `select a.item_id as itemId, a.grade from answers a
              where a.is_first = 1 and a.grade is not null and a.session_id = ? order by a.id`,
            [sessionId]
          )
        : await db.all(
            `select a.item_id as itemId, a.grade from answers a
              where a.is_first = 1 and a.grade is not null
                and a.item_id in (select item_id from item_lectures where lecture_id in (${marks}) and deleted_at is null)
              order by a.id`,
            lectureIds
          )
    ) as unknown as { itemId: number; grade: number }[]

    const dist = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>
    for (const a of answers) dist[a.grade] = (dist[a.grade] ?? 0) + 1
    const sample = answers.length
    const accuracy = sample === 0 ? 0 : ((dist[3] ?? 0) + (dist[4] ?? 0)) / sample

    const settledAt = sessionId
      ? (((await db.get(`select finished_at as f from sessions where id = ?`, [sessionId])) as
          | { f: number | null }
          | undefined)?.f ?? null)
      : null

    const perLecture: Settlement['perLecture'] = []
    const lecCfg = (await effectiveParams(db)).lecture
    for (const id of lectureIds) {
      const own = (await db.get(
        `select count(*) as n,
                sum(case when a.grade >= 3 then 1 else 0 end) as ok
           from answers a
          where a.is_first = 1 and a.grade is not null
            ${sessionId ? 'and a.session_id = ?' : ''}
            and a.item_id in (select item_id from item_lectures where lecture_id = ? and deleted_at is null)`,
        sessionId ? [sessionId, id] : [id]
      )) as { n: number; ok: number | null } | undefined
      const lec = (await db.get(
        `select name, interval_days as interval from lectures where id = ?`,
        [id]
      )) as { name: string; interval: number } | undefined
      if (!lec || !own) continue

      const acc = own.n === 0 ? 0 : (own.ok ?? 0) / own.n

      if (settledAt !== null) {
        perLecture.push({
          lectureId: id,
          name: lec.name,
          reason: `这一场已经结算过了 —— 间隔保持 ${lec.interval} 天，没有再动`,
          nextDays: lec.interval
        })
        continue
      }

      const next = nextLectureInterval(lec.interval, acc, own.n, lecCfg)
      if (next.changed) {
        await db.run(`update lectures set interval_days = ?, due_at = ?, updated_at = ? where id = ?`, [
          next.interval,
          dueAfter(next.interval),
          t,
          id
        ])
      }
      // D-256 · lecture 级事件写 lecture_logs，不塞进条目级的 review_logs
      await db.run(
        `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
         values (?, 'practiced', ?, ?, ?)`,
        [id, `${own.n} 题 · 正确率 ${Math.round(acc * 100)}% · ${next.reason}`, t, t]
      )
      perLecture.push({ lectureId: id, name: lec.name, reason: next.reason, nextDays: next.interval })
    }

    // 收尾时间只在第一次结算时写 —— 它就是「这一场结算过了」这条事实本身
    if (sessionId && settledAt === null) {
      await db.run(`update sessions set finished_at = ?, updated_at = ? where id = ?`, [t, t, sessionId])
    }

    const answered = [...new Set(answers.map((a) => a.itemId))]
    const termsIn = async (state: string): Promise<string[]> => {
      if (answered.length === 0) return []
      const m = answered.map(() => '?').join(',')
      return (
        await db.all(
          `select term from items where id in (${m}) and production_state = ? and deleted_at is null`,
          [...answered, state]
        )
      ).map((r) => String(r['term']))
    }

    return {
      lectureIds,
      sample,
      distribution: dist,
      accuracy,
      silenced: await termsIn('silent'),
      hard: await termsIn('hard'),
      perLecture,
      // F-05 · 出口：这批里有认读卡也到期了 → 把两条线接上的位置
      dueReadingCount: await dueCount(db, null)
    }
  })
}
