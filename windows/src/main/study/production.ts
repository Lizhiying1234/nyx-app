/**
 * Study · 产出线：队列 · 出题 · 取题 · 判分与提示 · 进度 · 冷启动诊断 —— T-4.6 拆分（2026-09-06）
 *
 * 方法体从 `src/main/study.ts` 原样搬来：`this.<状态>` → `c.<状态>`，
 * `this.<公共方法>` → `c.self.<方法>`，私有方法整个搬进本文件、调用点也在本文件里。
 * ★ 模板字符串里的行一个空格都没动 —— 那里面是 SQL，缩进属于字符串内容。
 * ★ 判断规则一条都不在这里，全在 core/（D-238）：这一层只做
 *   「从库里取状态 → 交给 core 算 → 把结果写回去」。
 */

import { ITEM_NOT_FOUND } from '@shared/api.ts'
import { applyGrade, type ItemProgress } from '@core/grading.ts'
import { penalizeFromHint } from '@core/sm2-item.ts'
import { dueAfter } from '@core/sm2-lecture.ts'
import {
  productionApplies,
  shouldRetireReadingCard,
  SILENCE_FILTER_NAME
} from '@core/silence.ts'
import { PRODUCTION_APPLIES } from '../db/silence-sql.ts'
import {
  clampQuestionsPerItem,
  CROSS_TYPE_WINDOW,
  DEFAULT_QUESTIONS_PER_ITEM,
  fitQuota,
  isAllowedType,
  planQuestions,
  preferDifferent,
  type QSlot
} from '@core/qtype-plan.ts'
import {
  buildPracticeRules,
  CONTEXT_SPREAD_LINES,
  joinLines,
  practiceGlobalLines,
  practiceHintLines,
  practiceRulesOf,
  type PracticeRules
} from '@core/quiz-rules.ts'
import { effectiveQTypePrompt } from '@core/qtypes-store.ts'
import { planQuestionRefresh, onGenerateFailed } from '@core/question-refresh.ts'
import type { Grade } from '@core/types.ts'
import type { DiagnoseResult, GradeResult, HardRow, QuestionRow } from '@shared/api.ts'
import { deviceCol } from '../db/device.ts'
import { callAi, extractJson } from '../ai/client.ts'
import { resolveSlot } from '../ai/config.ts'
import { fill, loadPrompt } from '../ai/prompts.ts'
import { normalizeTerm } from '../db/repo.ts'
import { JOIN_CARD } from '../db/reading-card-sql.ts'
import type { StudyCtx } from './ctx.ts'
import { safeLabels, now, shuffled } from './util.ts'
import { cardOf } from './reading.ts'

/** 今天这一讲要练的条目：主动词汇、没静默、没在攻坚区。 */
/**
 * ★★★ I-198 · 「这道题还没做过」不能只看 `used_at is null`
 *
 * ══ 真事（2026-09-15，他真库里的一条）══════════════════════════
 * `answer#19` 指着 `question#334`（item 169 `rummaging`，写作层，产出队列第一条），
 * 而那道题的 `used_at` 是 **NULL**。于是：
 *   · 出题前的清理 `delete from questions where item_id=? and used_at is null`
 *     删到了这道**被 answer 引用着**的题 → `answers.question_id` 外键当场抛
 *     → 讲次页「产出练习」与 Today「开始产出练习」同一个错，**整条产出线全废**。
 *
 * ══ 它是怎么变成这样的（取证，不是猜）══════════════════════════
 * 逐份翻 `data/backups/`（20 份），坏行出现在 **5 秒之内**：
 *   · `nyx-20260915-224648-before-sync.db`（22:46:48）：
 *       无 `answer#19`；`question#334.used_at = 04:21:45`；`updated_at = 04:21:45`；坏行 **0**
 *   · `nyx-20260915-224653-before-sync.db`（22:46:53）：
 *       有 `answer#19`；`question#334.used_at = NULL`；`updated_at = **04:17:30**`；坏行 **1**
 *
 * 中间发生的是 22:46:42 那次同步，它自己报「**2 处两边都改过 —— 已按时间新的那版定**」。
 * ☞ **可是那一行的 `updated_at` 倒退了 4 分 15 秒**（04:21:45 → 04:17:30）——
 *   **更旧的一版覆盖了更新的一版**，顺手把「这道题做过了」抹掉，
 *   而对端同时把记录这次作答的 `answer` 送了进来。两行从此互相矛盾。
 *
 * ★ **根因在同步的合并口径，不在这里**（已报 I-198 的上游）。
 *   这里做的是：**让这一层不再因为那种行而崩，也不再把做过的题重新发给他**。
 *
 * ══ 为什么四处都要改，只挡删除不够 ═════════════════════════════
 * `used_at is null` 在这个文件里当「还没做过」用了四次：算过期、删过期、
 * 数还有没有、**以及真正取题发给他做的那一处**。
 * 只在删除那里加保护的话，这行会被**永久留下来**，然后一次次**再发给他做一遍**
 * —— 崩溃没了，换成了一个更安静的毛病。所以判据收成一处，四处共用。
 *
 * ★ 有 answer 的题按定义就是做过的；`used_at` 是不是 NULL 只是记账坏了。
 *   这里**不去改他的数据**（不擅自回填 `used_at`）—— 那是另一件事，要他点头。
 */
const NOT_DONE =
  `used_at is null and id not in (select question_id from answers where question_id is not null)`

export function productionQueue(c: StudyCtx, lectureId: number): { id: number; term: string; corrects: number }[] {
  return c.self.productionQueueMany([lectureId])
}

/**
 * 跨多个 lecture 取队列 —— 今日练习会一次收好几讲（D-027）。
 *
 * ★ 第一层「知识点顺序」在这里生效（使用者「出题顺序控制」）：
 * `seq` = 按收进来的先后（`i.id`），`random` = 乱序。
 * 乱序用 Fisher–Yates，不用 `sort(() => Math.random() - 0.5)` —— 后者不均匀。
 */
export function productionQueueMany(c: StudyCtx, lectureIds: number[]): { id: number; term: string; corrects: number }[] {
  if (lectureIds.length === 0) return []
  const marks = lectureIds.map(() => '?').join(',')
  const rows = c.db
    .prepare(
      `select distinct i.id, i.term, i.corrects from items i
           join item_lectures il on il.item_id = i.id and il.deleted_at is null
          where il.lecture_id in (${marks}) and i.deleted_at is null
            and ${PRODUCTION_APPLIES('i')} and i.production_state in ('new','training')
          order by i.id`
    )
    .all(...lectureIds) as { id: number; term: string; corrects: number }[]
  return orderItems(c, rows)
}

/**
 * 按他设的「知识点顺序」排一遍。
 *
 * 单拎成一个方法，是因为队列有四个入口（本讲、跨讲、勾选的、攻坚区），
 * 上一版那种「每个入口各写一遍」的写法必然漏掉一两个 ——
 * 而漏掉的表现是「有的地方乱序有的地方不乱」，最像随机 bug。
 */
export function orderItems<T>(c: StudyCtx, rows: T[]): T[] {
  return c.self.order().items === 'random' ? shuffled(rows) : rows
}

/**
 * 指定一批条目来练 · D-012 筛选后统一测试
 * 静默的排除在外（D-024：除手动放出外不出现在任何测试中）。
 */
export function queueByIds(c: StudyCtx, ids: number[]): { id: number; term: string; corrects: number }[] {
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(',')
  const rows = c.db
    .prepare(
      `select id, term, corrects from items
          where id in (${marks}) and deleted_at is null
            and production_state in ('new','training','hard')
          order by id`
    )
    .all(...ids) as { id: number; term: string; corrects: number }[]
  return orderItems(c, rows)
}

/**
 * 攻坚区的队列 · D-025 / D-134
 *
 * 「先看诊断，再针对性出题；以**错误订正**为主，**题面用你自己上次写错的句子**。」
 * 一条练了 5 次还不过的知识点，再练第 6 次大概率还是不过 —— 因为重复的是同一个错误。
 */
export function hardQueue(c: StudyCtx): { id: number; term: string; corrects: number }[] {
  return c.db
    .prepare(
      `select id, term, corrects from items
          where deleted_at is null and production_state = 'hard' order by id`
    )
    .all() as { id: number; term: string; corrects: number }[]
}

/** 攻坚区列表：每条带上它历次写错的句子，那是 D-134 的题面素材。 */
export function hardList(c: StudyCtx): HardRow[] {
  const items = c.db
    .prepare(
      `select i.id, i.term, i.gloss, i.attempts, i.hard_entries as hardEntries,
                i.recollected_count as recollected,
                (select content from analysis_blocks b where b.item_id = i.id and b.block = 'diagnosis') as diagnosis,
                (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
                  where il.item_id = i.id and il.deleted_at is null and il.is_owner = 1 limit 1) as lectureName
           from items i
          where i.deleted_at is null and i.production_state = 'hard'
          order by i.attempts desc, i.id`
    )
    .all() as Omit<HardRow, 'history'>[]

  const q = c.db.prepare(
    `select text, grade, annotations, created_at as at from answers
        where item_id = ? and is_first = 1 and grade is not null
        order by id desc limit 5`
  )
  return items.map((it) => ({
    ...it,
    history: (q.all(it.id) as { text: string; grade: number; annotations: string; at: number }[])
      .reverse()
      .map((a) => ({
        text: a.text,
        grade: a.grade,
        at: a.at,
        labels: safeLabels(a.annotations)
      }))
  }))
}

/**
 * 当前勾选的指纹。题库是照着它出的，对不上就得重出。
 *
 * 把**题型顺序**也算进指纹：顺序变了，题库里那一批的排列就不是他要的了。
 * 题型内容（他改过的提示词）也算 —— 他改完提示词却发现出的还是老题，
 * 会以为编辑框是摆设。
 *
 * ★★ 2026-09-08（D-478）· 段里去掉了 `tier`，**并加进了「一次几道」** ——
 *   这两件都真的会改变「这一批题该长什么样」。代价说清楚：**老行的指纹一律对不上**，
 *   于是他下次练到那一条时，那条**未用过**的题会按既有机制删掉重出（下面那段 `stale`）。
 *   已经答过的题（`used_at` 非空）**一行不动** —— 历史与统计不受影响。
 */
export function qtypeSignature(c: StudyCtx): string {
  const on = new Set(c.self.qtypes())
  const parts = c.qt
    .active()
    .filter((q) => on.has(q.key))
    /** ★ I-187 · 指纹也要按**真正发出去的那一段**算，否则内置那 10 条的垃圾正文
     *    仍然在决定「这一批题该不该重出」—— 那是同一个病的第二张脸 */
    .map((q) => `${q.key}:${effectiveQTypePrompt(q).length}`)
    .sort()
  return `${c.self.order().qtypes}|${questionsPerItem(c)}|${parts.join('|')}`
}

/**
 * 这一次要出的那几道题，逐道定死用哪一种题型 · ★ 2026-08-14（档位 2026-09-08 取消）
 *
 * 以前这里只把「他勾了哪些」按档列给 AI，**选哪一种交给 AI 自己发挥** ——
 * 于是它照着输出示例抄了「造句」，而他根本没勾造句（I-108 同款）。
 * 现在计划在本地算好（`core/qtype-plan.ts`），提示词里逐道写死，
 * 回来之后再逐道校验：**判据只有一份，生成前后用的是同一份。**
 */
/**
 * 一次给一条知识点出几道 —— **他自己在设置里定**（D-478）。
 * 数与夹取在 core 一处（`clampQuestionsPerItem`），这里只负责把他存的值递进去。
 */
export function questionsPerItem(c: StudyCtx): number {
  return clampQuestionsPerItem(c.params.get('questionsPerItem', DEFAULT_QUESTIONS_PER_ITEM))
}

export function planSlots(c: StudyCtx, itemId: number): QSlot[] {
  const all = c.qt.active().map((q) => ({ key: q.key }))
  /**
   * 「按顺序 / 乱序」是他的偏好，「不许出现没勾的题型」不是偏好 ——
   * 两件事都交给同一个计划器，但走的是两条明确的路径（`mode`）。
   *
   * ★ 这里**不能**用「洗牌但随机源恒为 0」来表达「不洗牌」：
   *   Fisher–Yates 里 j 恒为 0 是一个确定的置换（[A,B,C] → B,C,A），
   *   不是恒等变换。第一版就是这么写的，于是「按顺序」永远差一位。
   */
  return planQuestions(all, c.self.qtypes(), questionsPerItem(c), c.self.order().qtypes, Math.random, itemId)
}

/**
 * 拼给提示词的那一段：**逐道**写清该用哪种形式。
 *
 * ★ 每一种用**他自己写的提示词**（`prompt`）；没写才退回内置说明（`guide`）。
 * 这是「4. 生成题目时，使用对应题型的用户自定义提示词」的落点。
 *
 * 为什么不给每种题型单独发一次 AI 调用 —— D-129 已经算过这笔账：
 * 大头开销是喂上下文，生成 3 道和 15 道喂的是同一份，
 * 拆成每种一次就是十几倍成本，而产出是一样的。
 */
export function typesBrief(c: StudyCtx, plan: QSlot[], rules: PracticeRules): string {
  const NL = String.fromCharCode(10)
  const byKey = new Map(c.qt.active().map((q) => [q.key, q]))
  const lines: string[] = []

  /**
   * ★★ **每种形式的说明只写一遍**（2026-08-17）
   *
   * 老写法是逐**槽位**把那一种的完整提示词贴一次。他给每种题型写的是
   * 一整套导师提示词（一种 8000 字上下），15 个槽位里同一种会出现两三次 ——
   * 实测拼出来 **120984 字符**。一次出题光题型说明就 12 万字，
   * 既贵又慢，而且真正要紧的那句「type 必须原样等于 X」被埋在最底下。
   *
   * 说明写一遍、顺序单独列 —— 内容一个字没少，重复没有了。
   * 他勾 10 种时从 12 万降到 8 万，勾少的时候降得更多。
   *
   * （剩下那 8 万仍然偏大，因为他那些提示词本身就是整套导师人格。
   *   要不要截断是**他的内容**，我不替他decide —— 已记进待办。）
   */
  const kinds = new Set(plan.map((x) => x.type)).size
  lines.push(`Write exactly ${plan.length} questions, in this order:`)
  plan.forEach((s, i) => {
    lines.push(`${i + 1}. type must be exactly \`${s.type}\``)
  })
  /**
   * ★ B-lite · 把「这一批要覆盖几种形式」也说清楚。
   * 提示词只是提示 —— 真正的约束是回来之后的 `fitQuota`，
   * 但说清楚能让它少写废稿，他也少等一次重来。
   * ★ 2026-09-08 · 原来这一段是按五个档各说一遍的（D-478 取消档位）。
   */
  if (kinds > 1) {
    lines.push(
      `   (these must use ${kinds} different forms — writing them all in one form gets them thrown away)`
    )
  }
  lines.push('')

  /**
   * 每种形式**是什么**，写在后面，一种一遍。
   * 用他自己写的那份（`prompt`）；没写才退回内置说明（`guide`）——
   * 这是「生成题目时使用对应题型的用户自定义提示词」的落点。
   */
  const used = [...new Set(plan.map((s) => s.type))]
  if (used.length > 0) {
    lines.push('### What each `type` means')
    lines.push('')
    for (const key of used) {
      const q = byKey.get(key)
      /**
       * ★★ I-187 · 内置题型**只用 `guide`**，不读 `prompt`（判据在 core 一份）。
       *   老写法是「有 `prompt` 就用」—— 而他库里 10 种内置题型带着生成出来的、
       *   和题型名错位的长正文，于是「造句」一直在按别的题型出题。
       */
      const body = q ? effectiveQTypePrompt(q) : ''
      if (!body) continue
      lines.push(`#### \`${key}\``)
      lines.push('')
      lines.push(body)
      /**
       * ★★ W-3 / W-4 跟着**每一种**走，不在全局拼一次（D-482 · 确认单 §二 ①）。
       *   一次生成是一批多种题型（D-129）—— 全局拼的话，「必须写完整句」会同时
       *   落在「情景任务」头上，而那一题本来就要写 80–120 词。
       *   哪几种不拼由 core 判（`buildPracticeRules`），界面上不做特例、不加说明。
       */
      for (const extra of buildPracticeRules(rules, key)) lines.push(extra)
      lines.push('')
    }
  }
  return lines.join(NL)
}

/**
 * D-129 · 一次生成五档各 3 道，共 15 道，此后该条目完全离线可用。
 * 「大头开销是喂上下文，生成 3 道和 15 道喂的是同一份。分五次喂 = 五倍成本。」
 * **只在进入测试时触发**，其他任何地方都不调用生成。
 */
/**
 * I-207 · `ensureQuestions` 的回执。
 * `notice` 不为空 = **这次没生成成功，但他手上那批题一道没少**，界面要把这句话说出来。
 */
export interface EnsureQuestionsResult {
  /** 这一次新插了几道 */
  added: number
  /** 要当面说的那一句；`null` = 没什么要说的 */
  notice: string | null
}

export async function ensureQuestions(
  c: StudyCtx,
  itemId: number,
  signal?: AbortSignal
): Promise<EnsureQuestionsResult> {
  /**
   * ★ 使用者 7 · 他改过勾选之后，**没做过的题要按新勾选重出**。
   *
   * 「用户多选后生成对应练习」—— 如果沿用上一次那 15 道，
   * 勾选就是个不起作用的开关，而他完全看不出为什么。
   * 已经答过的不动：那是历史，删了报告就断了。
   */
  /**
   * ★★ 一种题型都没勾 = **不出题**，并且说清为什么。
   *
   * 老实现在这里悄悄替他勾上全部（`on.length > 0 ? on : known`），
   * 于是「清空」这个动作看起来毫无效果 —— 他清完照样出题，而且出的是全部题型。
   * 现在明确报错：练习不开始，界面把这句话原样显示给他。
   */
  const picked = c.self.qtypes()
  if (picked.length === 0) {
    throw new Error('你还没有选题型 —— 点上面的「题型」挑几种，再开始练。')
  }

  const sig = qtypeSignature(c)
  const staleCount = (
    c.db
      .prepare(
        `select count(*) as n from questions
            where item_id = ? and ${NOT_DONE} and coalesce(qtype_sig, '') <> ?`
      )
      .get(itemId, sig) as { n: number }
  ).n
  const haveCount = (
    c.db.prepare(`select count(*) as n from questions where item_id = ? and ${NOT_DONE}`).get(itemId) as {
      n: number
    }
  ).n

  /**
   * ★★★ I-207 · **先生成成功、再替换** —— 判据在 `@core/question-refresh.ts`，两端调同一份。
   *
   *   这里数的两个数都是**删之前**的：手上一共有几道、其中几道的规则签名过期了。
   *   删旧题这件事**不在这里做** —— 它挪到了下面那个「拿到新题之后」的事务里。
   *   （老次序是先删再生成，生成一抛错他就两手空空；手机上真的发生过：14 道 → 0 道。）
   */
  const refresh = planQuestionRefresh({ staleCount, haveCount })
  if (!refresh.generate) return { added: 0, notice: null }

  const it = c.db
    .prepare(
      `select i.term, i.gloss,
                (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
                /* 6.2 · 分析判定「打错了 / 听岔了，需要修改」—— 列表上要有个记号。
                   改完之后 acceptSuspect 会把这一条从区块里去掉，
                   区块空了就整块删掉，于是记号自己消失，不需要另设一个「已处理」位。 */
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.block = 'suspect') as hasSuspect
           from items i where i.id = ?`
    )
    .get(itemId) as { term: string; gloss: string; quote: string | null } | undefined
  if (!it) throw new Error(ITEM_NOT_FOUND)

  const plan = planSlots(c, itemId)
  const p = loadPrompt(c.promptsDir, 'generate-questions')
  /**
   * ★★ **一份变量喂两段。**
   *
   * 老写法给 system 和 user 各拼一个变量表，于是「哪个占位符在哪一段」
   * 变成一件要靠记性维护的事 —— 而 `{{TYPES}}` 正是写在 SYSTEM 段、
   * 只喂给了 USER 段。题型说明算出来 12 万字符，一个字都没发出去，
   * AI 于是自己编题型，15 道全被判非法。
   *
   * 提示词是**他可以改的文件**（D-213）：他把一段挪到另一段是完全正常的事，
   * 挪一下就静默失效的设计本身就是错的。两段喂同一份，这个问题不存在。
   */
  /**
   * ★★ 出题规则那四个选项（D-482）。读一次，喂给四处：
   *   `TYPES`   每一种题型的说明后面跟着 W-3 / W-4（按题型豁免）
   *   `SPREAD`  W-2 语境跨度那一段
   *   `OPTIONS` 全局那几句（现在只有 W-1「都不给」那一档有一句）
   *   `HINTS`   W-1 决定 USER 段给不给释义 / 原句
   * ★ `Target expression:` 那一行三档都给（D-137），它写死在模板里，不经过选项。
   */
  const rules = practiceRulesOf((k) => c.prefs.raw(k))
  const vars = {
    TERM: it.term,
    GLOSS: it.gloss || it.term,
    QUOTE: it.quote ?? '',
    LEVEL: c.level(),
    TYPES: typesBrief(c, plan, rules),
    SPREAD: CONTEXT_SPREAD_LINES[rules.contextSpread],
    OPTIONS: joinLines(practiceGlobalLines(rules).map((x) => '- ' + x)),
    HINTS: joinLines(
      practiceHintLines(rules, { gloss: it.gloss || it.term, quote: it.quote ?? '' })
    )
  }
  /**
   * ★★★ I-207 · 生成**可能抛**（实测约一半：模型把额度全用在思考上）。
   *   抛了就走 `keepOldOrThrow` —— 手上还有旧题就照旧用，没有才把真实原因报出来。
   *   **这里往前一行都还没删过东西**，所以「抛了 = 什么都没发生」是真的。
   */
  let text: string
  try {
    text = await callAi(
      resolveSlot(c.db, 'light'), // D-202 · 量大、要求低，用便宜的那一组
      {
        system: fill(p.system, vars),
        user: fill(p.user, vars),
        json: true,
        maxTokens: 6000,
        signal
      },
      'light'
    )
  } catch (err) {
    return keepOldOrThrow(c, itemId, haveCount, err)
  }

  /**
   * ★ I-207 · 解析不出来也是**生成失败**（模型回了一段不是 JSON 的话）——
   *   和调用抛错走同一条路：旧题一道不动。
   */
  let all: QuestionRow[]
  try {
    all = extractJson<{ questions?: QuestionRow[] }>(text).questions ?? []
  } catch (err) {
    return keepOldOrThrow(c, itemId, haveCount, err)
  }

  /**
   * ★★ **收题硬闸**：不在他勾选范围内的，一道都不许进库。
   *
   * 这一条挡的是三件事，每一件都真的发生过：
   *   · AI 照抄提示词里的输出示例（示例写的是「造句」—— I-108 同款）
   *   · AI 自己发挥，出一种他停用过的形式
   *   · 老代码那句 `q.type ?? '造句'` —— 没有题型就写死成造句
   *
   * **丢掉，不改写。** AI 是照着某个形式写的题面，换个标签挂上去等于骗他：
   * 题目形式和标签对不上，而他只会以为是自己看错了。
   */
  const legal = all
    .filter((q) => isAllowedType((q as { type?: unknown }).type, picked))
    .map((q) => ({
      ...q,
      type: String(q.type).trim()
    }))

  /**
   * ★★ B-lite · 再按**这一档的配额**收一遍（`core/qtype-plan.ts::fitQuota`）。
   *
   * 上面那道闸只管「是不是他勾的」，管不了「一档三道全是同一种」——
   * 三道都在他勾的集合里，闸会全部放行，而他看到的是连着三道一样的形式，
   * 那正是他原话的后半句。配额就是计划的多重集，扣完即止。
   *
   * 配额**不是**「必须凑满」：只回来 1 道合规的就收 1 道（见 `fitQuota` 的注释）。
   */
  const { kept: qs, dropped } = fitQuota(legal, plan)

  /**
   * 一道都没剩 —— 不能把「出不了题」装成「出好了」。
   * 报一句人话让他知道发生了什么，那一包不落库，下次进练习会重来。
   */
  if (all.length > 0 && qs.length === 0) {
    /**
     * ★★ **失败要能被诊断，不能把账推给他**（2026-08-17）
     *
     * 老文案是「一道都不是你选的题型 …… 换一组题型，或者去设置里把题型的
     * 提示词写清楚一点」。那天真正的原因是 `{{TYPES}}` 根本没发出去 ——
     * **程序自己的 bug**，而他按提示去一个个改题型提示词，改到天亮也没用。
     *
     * 所以现在把**它到底回了什么**摆出来：他一眼能看出是「AI 不听话」
     * 还是「软件要的和 AI 给的根本对不上」。同一句话也是我下次排查的第一手证据。
     */
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
        : `${dropped.length} 道超出了这一批该有的形式配额。`
    return keepOldOrThrow(
      c,
      itemId,
      haveCount,
      new Error(
        `出的题没有一道能用（收到 ${all.length} 道）。${NL}${why}${NL}这一批已经全部丢掉，没有入库；已经答过的题一个字没动。`
      )
    )
  }
  /**
   * ★ I-207 · AI 干脆什么都没回（`all` 为空）也是**生成失败**，不是「成功出了 0 道」。
   *   不拦住的话，下面那个事务会把旧题删了、再插 0 道 —— 正是这一条要根除的局面。
   */
  if (qs.length === 0) {
    return keepOldOrThrow(c, itemId, haveCount, new Error('这一次一道题都没出来（模型没有回任何题）。'))
  }
  const t = now()
  /**
   * ★ `tier` 这一列按 D-216 留着（`not null`，删列会动同步指纹），但**没有含义了**：
   *   档位机制 2026-09-08 取消（D-478）。新行一律写 1，谁都不再读它。
   */
  const ins = c.db.prepare(
    `insert into questions (item_id, tier, type, prompt, context, reference, qtype_sig, created_at, updated_at)
       values (?, 1, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = c.db.transaction(() => {
    /**
     * ★★★ I-207 · **删旧只在这里**，而且和插新在同一个事务里。
     *   走到这一行说明新题已经拿到手了（`qs.length > 0`）。
     *   `refresh.dropOld` 为真 = 他改过勾选 / 规则，旧的那批按新规则重出（使用者 7）。
     */
    if (refresh.dropOld) {
      c.db.prepare(`delete from questions where item_id = ? and ${NOT_DONE}`).run(itemId)
      c.ledger.op('regen-questions', 'item', itemId, null, {
        reason: '题型勾选变了',
        sig,
        dropped: haveCount,
        added: qs.length
      })
    }
    for (const q of qs) {
      const broken = (q as { broken?: string | null }).broken
      // 错误订正的题面需要那个错句，否则题目不成立
      const prompt = broken ? `${q.prompt}\n\n"${broken}"` : q.prompt
      if (!prompt?.trim()) continue
      ins.run(
        itemId,
        // 走到这里的行都过了 `isAllowedType` + `fitQuota`，不需要、也**不许**再有兜底题型
        q.type,
        prompt,
        q.context ?? 'original',
        q.reference ?? null,
        sig,
        t,
        t
      )
    }
  })
  tx()
  return { added: qs.length, notice: null }
}

/**
 * I-207 · 生成失败之后怎么办 —— 判据在 core（`onGenerateFailed`），这里只做两件平台的事：
 * 把**模型到底说了什么**记进账本（那句话是排查的第一手证据，不摆到他面前），
 * 以及在「一道题都没有」时把真实错误原样抛出去。
 */
function keepOldOrThrow(
  c: StudyCtx,
  itemId: number,
  haveCount: number,
  err: unknown
): EnsureQuestionsResult {
  const why = err instanceof Error ? err.message : String(err)
  const verdict = onGenerateFailed({ haveCount })
  if (verdict.kind === 'report') throw err instanceof Error ? err : new Error(why)
  c.ledger.op('questions-kept', 'item', itemId, '这次没出成，旧题原样留着', { have: haveCount, why })
  return { added: 0, notice: verdict.notice }
}

/**
 * 攻坚区的题 · D-134
 *
 * 「先看诊断，再针对性出题；以**错误订正**为主，**题面用你自己上次写错的句子**。」
 *
 * 附注里那句是重点：「原型的错误订正题面是硬编码假句子，**攻坚区里有现成的、
 * 你自己写的错句** —— 这个题型终于有了真实素材来源。」
 * 所以这道题**不需要调 AI**：素材已经在库里了。
 */
export function hardQuestion(c: StudyCtx, itemId: number): QuestionRow | null {
  const wrong = c.db
    .prepare(
      `select text from answers
          where item_id = ? and is_first = 1 and grade is not null and grade <= 2
          order by id desc limit 1`
    )
    .get(itemId) as { text: string } | undefined
  if (!wrong) return null

  const it = c.db.prepare(`select term from items where id = ?`).get(itemId) as
    | { term: string }
    | undefined
  if (!it) return null

  const diag = c.db
    .prepare(`select content from analysis_blocks where item_id = ? and block = 'diagnosis'`)
    .get(itemId) as { content: string } | undefined
  let drill = ''
  try {
    drill = diag ? ((JSON.parse(diag.content) as { drill?: string }).drill ?? '') : ''
  } catch {
    /* 诊断格式坏了不该挡住出题 */
  }

  const t = now()
  const prompt =
    `You wrote this before, and it did not work:\n\n"${wrong.text}"\n\n` +
    `Fix the use of "${it.term}".` +
    (drill ? `\n\nThe thing to get right: ${drill}` : '')

  const id = Number(
    c.db
      .prepare(
        // ★ `tier` 列按 D-216 留着但没含义了（D-478），一律写 1
        `insert into questions (item_id, tier, type, prompt, context, reference, created_at, updated_at)
           values (?, 1, '错误订正', ?, 'original', null, ?, ?)`
      )
      .run(itemId, prompt, t, t).lastInsertRowid
  )
  return { id, type: '错误订正', prompt, context: 'original', reference: null }
}

/** 下一道题：取当前难度档里还没用过的（D-116 随进度递进）。 */
export function nextQuestion(c: StudyCtx, itemId: number): QuestionRow | null {
  const it = c.db.prepare(`select corrects from items where id = ?`).get(itemId) as
    | { corrects: number }
    | undefined
  if (!it) return null
  /**
   * ★★ 2026-09-08（D-478）· 这里原来是「按答对次数算出第几档 → 只在那一档里取题」。
   *   档位取消后判据只剩一句：**取未用过的下一道**，而挑哪一道由 M-027 说了算。
   */

  /**
   * ★★ 发题这一侧的 M-027：避开**最近两道**真的发给过他的题型。
   *
   * 生成那一侧已经按计划轮换了，但库里的题按 id 顺序发；老数据、或者他只勾了一两种时，
   * 他会连着看到同一种形式。只避开「上一道」不够 —— A B A 也满足「相邻不同」，
   * 而它只跨了两种，「连续 3 次正确必须横跨 3 种题型」还是没做到。
   * 判据在 `core/qtype-plan.ts::preferDifferent`，和计划那一侧同一个模块。
   */
  const recentRows = c.db
    .prepare(
      `select type from questions
          where item_id = ? and used_at is not null order by used_at desc, id desc limit ?`
    )
    .all(itemId, CROSS_TYPE_WINDOW - 1) as { type: string }[]
  /** 旧 → 新（`preferDifferent` 认最后一个是「上一道」） */
  const recent = recentRows.map((r) => r.type).reverse()

  const unused = c.db
    .prepare(
      `select id, type, prompt, context, reference from questions
          where item_id = ? and ${NOT_DONE} order by id`
    )
    .all(itemId) as QuestionRow[]

  return preferDifferent(unused, recent)
}

/**
 * 判一次作答 · D-119 / D-120 / D-121 / D-122
 *
 * `isFirst` 决定这一条算不算数：**只记第一次判定**（M-019）——
 * 第一次作答是唯一诚实的样本；改到过关练的是「照着反馈修改」，那是另一种能力。
 */
export async function submitAnswer(c: StudyCtx, 
  sessionId: number | null,
  itemId: number,
  questionId: number,
  text: string,
  isFirst: boolean,
  hinted: boolean,
  /**
   * ★ V35 / D-349 ② · 产出线的反应时间。
   * 认读线一直在记（`review_logs.duration_ms`），产出线以前**根本没有这一列** ——
   * 而「他想了 40 秒才写出来」在产出线上比在认读线上更有意义：
   * 产出是这套方法的核心（把「读得懂」变成「写得出」）。
   * ★ 可空：调用方没传就是没测到，**不要编一个**。
   */
  durationMs?: number,
  signal?: AbortSignal
): Promise<GradeResult> {
  const q = c.db
    .prepare(`select prompt, reference from questions where id = ?`)
    .get(questionId) as { prompt: string; reference: string | null } | undefined
  const it = c.db.prepare(`select term, gloss from items where id = ?`).get(itemId) as
    | { term: string; gloss: string }
    | undefined
  if (!q || !it) throw new Error('题目或知识点找不到了')

  const p = loadPrompt(c.promptsDir, 'score-answer')
  const raw = await callAi(
    resolveSlot(c.db, 'heavy'), // 判分质量决定整套机制是否成立，用最强的那一组
    {
      system: p.system,
      user: fill(p.user, {
        TERM: it.term,
        GLOSS: it.gloss || it.term,
        PROMPT: q.prompt,
        ANSWER: text,
        REFERENCE: q.reference ?? '(none)'
      }),
      json: true,
      // I-069 · 判分必须可复现（D-119 / D-237）。不定温度就会出现
      // 「同一句话第一次说不规范、第二次就规范了」
      temperature: 0,
      maxTokens: 1500,
      signal
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
  const t = now()

  /**
   * ★★ P-1 · 从这里开始的**全部写入是一个原子动作**。
   *
   * AI 那一次调用**刻意留在事务外**：它以秒计、可能失败、可能被取消，
   * 把它圈进事务等于长时间占着写锁。而它失败时库里一个字都还没写，
   * 本来就不需要回滚。
   *
   * 事务要保护的是它之后这一串：answers → questions.used_at →
   * 条目进度 → state_events → review_logs。以前它们各自独立提交，
   * 中途失败会留下「答案算进了正确率、条目进度却没动」——
   * 结算读的是 answers，所以那一题照样计入正确率，而 streak / 静默判定
   * 停在旧值上。**没有任何检查查得到这种偏差**（P-1 不变量 I-5）。
   */
  const written = c.db.transaction((): GradeResult['outcome'] => {
  c.db
    .prepare(
      // ★ V35 · device / duration_ms 见 db/device.ts 与 D-349
      `insert into answers (session_id, item_id, question_id, attempt_no, is_first, text,
                              grade, annotations, feedback, reference, hinted,
                              device, duration_ms, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
      deviceCol(c.db),
      durationMs ?? null,
      t,
      t
    )
  c.db.prepare(`update questions set used_at = ?, updated_at = ? where id = ?`).run(t, t, questionId)

  let out: GradeResult['outcome'] = null

  if (isFirst) {
    const prev = progressOf(c, itemId)
    const o = applyGrade(prev, grade, c.params.effective().grading)
    saveProgress(c, itemId, o.progress)
    // D-043 · 状态一变就记一笔 —— 报告的「知识流向」全靠它，不记就补不回来
    if (o.progress.state !== prev.state) {
      c.db
        .prepare(
          `insert into state_events (item_id, line, from_state, to_state, created_at, updated_at)
             values (?, 'production', ?, ?, ?, ?)`
        )
        .run(itemId, prev.state, o.progress.state, t, t)
    }
    c.db
      .prepare(
        `insert into review_logs (item_id, line, grade, duration_ms, device, created_at, updated_at)
           values (?, 'production', ?, ?, ?, ?, ?)`
      )
      .run(itemId, grade, durationMs ?? null, deviceCol(c.db), t, t)
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
    return out
  }).immediate()
  const outcome = written
  const passed = grade >= 3

  return {
    grade,
    passed,
    note: j.note ?? '',
    why: j.why ?? '',
    annotations,
    // D-122 · 第一次提交只给判定与标注，**不给范文**；改到过关才给
    reference: passed ? q.reference : null,
    outcome
  }
}

/** D-138 ·「提示」按钮当分类器：判分不受影响，但记一次认读失败、该卡间隔打回。 */
export function usedHint(c: StudyCtx, itemId: number): { gloss: string; reason: string } {
  const it = c.db.prepare(`select gloss, term from items where id = ?`).get(itemId) as
    | { gloss: string; term: string }
    | undefined
  if (!it) throw new Error(ITEM_NOT_FOUND)
  const card = cardOf(c, itemId)
  if (card.silent)
    return { gloss: it.gloss, reason: `这张认读卡已${SILENCE_FILTER_NAME}，不再调整排期` }

  const out = penalizeFromHint(card, c.params.effective().reading)
  const t = now()
  c.db
    .prepare(
      `update reading_cards
            set ease = ?, interval_days = ?, lapses = ?, due_at = ?, updated_at = ?
          where item_id = ?`
    )
    .run(out.card.ease, out.card.interval, out.card.lapses, dueAfter(out.card.interval), t, itemId)
  c.db
    .prepare(
      `insert into review_logs (item_id, line, grade, interval_after, ease_after, device, created_at, updated_at)
         values (?, 'reading', 1, ?, ?, ?, ?, ?)`
    )
    .run(itemId, out.card.interval, out.card.ease, deviceCol(c.db), t, t)
  return { gloss: it.gloss, reason: out.reason }
}

export function progressOf(c: StudyCtx, itemId: number): ItemProgress {
  const r = c.db
    .prepare(
      `select production_state as state, streak, attempts,
                attempts_in_stage as attemptsInStage, corrects, hard_entries as hardEntries
           from items where id = ?`
    )
    .get(itemId) as ItemProgress | undefined
  if (!r) throw new Error(ITEM_NOT_FOUND)
  return r
}

export function saveProgress(c: StudyCtx, itemId: number, p: ItemProgress): void {
  const t = now()
  c.db
    .prepare(
      /**
       * ★★ `silenced_by` 跟着一起写（D-485 · 2026-09-15）。
       *
       * 它现在还要回答一个新问题：**这一条是练成的，还是被收起来的。**
       * 走到这儿的都是**判分**判出来的，所以进静默就是 `'earned'`（练成）——
       * 手动那条路在 `library.ts::bulkSilence`，写的是 `'self'`。
       * ★ 不是静默就清空：不清的话，一条被「放回去」重新练的条目
       *   会带着上一次的标记，下次再练成时看着没错、但中间那段时间它说的是假话。
       * ★ 加一列是不必要的：`silenced_by` 本来就是「因为什么而静默」，
       *   「因为练成了」正是它的一种。**不加列 = 同步指纹一个字不动**（D-461）。
       */
      `update items set production_state = ?, streak = ?, attempts = ?, attempts_in_stage = ?,
                          corrects = ?, hard_entries = ?, updated_at = ?,
                          silenced_by = case when ? = 'silent' then 'earned' else null end
          where id = ?`
    )
    .run(
      p.state,
      p.streak,
      p.attempts,
      p.attemptsInStage,
      p.corrects,
      p.hardEntries,
      t,
      p.state,
      itemId
    )

  /**
   * ★★ V-2 · 产出线静默了，认读卡跟着退役 · D-135（2026-08-16 接上）
   *
   * ── 病 ────────────────────────────────────────────────
   *
   * `core/silence.ts::shouldRetireReadingCard` 写着、测着（`silence.test.ts`
   * 那条「产出线静默后，认读卡一并退役（D-135）」是绿的），
   * **而生产调用者是 0**。自动静默这条唯一的落库路径只写 `production_state`，
   * 从不碰认读线的静默位，于是 `dueCards` 的 `rc.silent = 0` 照样放行 ——
   * 他已经练到「不再轮转」的条目，认读卡还在天天找他。
   *
   * 手动静默那条路（`bulkSilence`）的注释早就把规则写清楚了：
   * 「两条线各自有静默位……**否则它还是会从认读那边冒出来**」。
   * 手动路知道，自动路没做。和 `progression.ts` 是同一张脸。
   *
   * ── 接法 ──────────────────────────────────────────────
   *
   * **判据不在这里** —— 这里只把事实喂给 `shouldRetireReadingCard`，
   * 绝不在 study.ts 里再写一句 `if (state === 'silent')`。
   * `productionApplies` 用 layer：只有主动词汇跑产出线（D-023），
   * 被动词汇的静默一直就由认读线自己决定。
   */
  const row = c.db
    .prepare(
      `select i.layer, i.kind, rc.silent as cs
           from items i ${JOIN_CARD('i')} where i.id = ?`
    )
    .get(itemId) as { layer: string; kind: string; cs: number } | undefined
  if (!row) return
  const retire = shouldRetireReadingCard({
    production: p.state,
    // R-2 · 「跑不跑产出线」只有 `productionApplies` 一处说了算
    productionApplies: productionApplies(row),
    readingSilent: row.cs === 1
  })
  if (!retire || row.cs === 1) return

  /**
   * 到期时间一起清空：留着的话，他哪天取消静默，
   * 那张卡会带着一个**早就过期**的日子立刻冒出来，像是欠了一屁股债。
   * 取消静默那条路（`bulkSilence(false)`）本来就会重新排期。
   */
  c.db
    .prepare(
      `update reading_cards set silent = 1, due_at = null, updated_at = ? where item_id = ?`
    )
    .run(t, itemId)
  c.db
    .prepare(
      `insert into state_events (item_id, line, from_state, to_state, created_at, updated_at)
         values (?, 'reading', 'active', 'silent', ?, ?)`
    )
    .run(itemId, t, t)
}

/**
 * 诊断与总评 · D-097 / D-127 / D-165 / M-032 / M-033
 *
 * 「在**结算页顺便更新**（总评那次调用已读完全部作答，零额外成本）。」
 * 所以两段结果一次调用一起要 —— 纵向看一条，横向看一轮。
 */
export async function diagnose(c: StudyCtx, sessionId: number | null, signal?: AbortSignal): Promise<DiagnoseResult> {
  const answers = (
    sessionId
      ? c.db
          .prepare(
            `select i.term, a.text, a.grade from answers a join items i on i.id = a.item_id
                where a.session_id = ? and a.is_first = 1 and a.grade is not null order by a.id`
          )
          .all(sessionId)
      : []
  ) as { term: string; text: string; grade: number }[]

  // 卡住的：在攻坚区，或者练了很多次还没 3 连
  const stuck = c.db
    .prepare(
      `select id, term, attempts from items
          where deleted_at is null and production_state = 'hard' order by attempts desc limit 8`
    )
    .all() as { id: number; term: string; attempts: number }[]

  if (answers.length === 0 && stuck.length === 0) {
    return { summary: null, diagnosed: 0 }
  }

  const hist = c.db.prepare(
    `select text, grade from answers where item_id = ? and is_first = 1 and grade is not null
        order by id desc limit 6`
  )
  const stuckText = stuck
    .map((s) => {
      const rows = (hist.all(s.id) as { text: string; grade: number }[]).reverse()
      return `## ${s.term}（练了 ${s.attempts} 次）\n${rows.map((r) => `- [第 ${r.grade} 档] ${r.text}`).join('\n')}`
    })
    .join('\n\n')

  const p = loadPrompt(c.promptsDir, 'diagnose')
  const raw = await callAi(
    resolveSlot(c.db, 'heavy'), // 诊断质量决定攻坚区有没有用，走重任务那组
    {
      system: p.system,
      user: fill(p.user, {
        ROUND:
          answers.map((a) => `- [第 ${a.grade} 档] ${a.term} → ${a.text}`).join('\n') || '（这一轮没有作答）',
        STUCK: stuckText || '（没有卡住的条目）'
      }),
      json: true,
      maxTokens: 2000,
      signal
    },
    'heavy'
  )

  const j = extractJson<{
    summary?: string
    diagnoses?: { term: string; pattern: string; drill?: string }[]
  }>(raw)

  const t = now()
  let diagnosed = 0
  const tx = c.db.transaction(() => {
    for (const d of j.diagnoses ?? []) {
      const it = c.db
        .prepare(`select id from items where deleted_at is null and lower(trim(term)) = ? limit 1`)
        .get(normalizeTerm(d.term)) as { id: number } | undefined
      if (!it || !d.pattern?.trim()) continue
      c.db
        .prepare(
          `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
             values (?, 'diagnosis', ?, ?, ?)
             on conflict(item_id, block) do update set
               content = excluded.content, updated_at = excluded.updated_at`
        )
        .run(it.id, JSON.stringify({ pattern: d.pattern.trim(), drill: d.drill ?? '' }), t, t)
      diagnosed += 1
    }
  })
  tx()

  return { summary: j.summary?.trim() || null, diagnosed }
}
