import type { ProductionState } from './types.ts'

/**
 * 静默判定与三级升级 · D-011 / D-080 / D-029 / D-135 / M-003 / M-029
 *
 * 静默 = **已通过全部检验、不再参与轮转**。它不是「忘记」，也不是「归档」，
 * 它是这套机制唯一的终点（项目页的进度条就是按静默比例算的 · D-176）。
 *
 * **实现方式是筛选，不是移动**（D-011）：数据原地不动、归属关系完整保留，仅默认过滤不显示。
 * 若真移动，条目与「出自 L1」的关系断裂，任何按来源的统计都会缺一块。
 */

export interface ItemLines {
  production: ProductionState
  /** 被动词汇只跑认读线，没有产出线 · D-023。**用 `productionApplies()` 算，别自己判** */
  productionApplies: boolean
  readingSilent: boolean
}

/** 判「这一条跑不跑产出线」需要知道的两件事 */
export interface ItemFacts {
  layer: string
  /** `sentence` = 整段贴进来的原句（`addChunks`）；`chunk` = 一个表达 */
  kind: string
}

/**
 * ★★ 产出线适用于谁 · **全项目唯一定义**（2026-08-16 裁决）
 *
 * ```
 * layer = 'B'  且  kind <> 'sentence'
 * ```
 *
 * ── 为什么要单独立一条规则 ────────────────────────────────
 *
 * 这句话以前在生产里有**三种口径**：
 *   · `layer = 'B'`                                   产出队列 / 今日练习 / 体检 / 报告
 *   · `layer = 'B' and not (self 根条目)`              知识库「主动词汇」那一档
 *   · `productionApplies`（布尔，由调用方自己填）        `core/silence.ts`
 * 于是同一条知识点，在「今日要练几条」里算数、在「主动词汇有几条」里不算数。
 * 他看到的是两个对不上的数字，而两边的代码各自都说得通。
 *
 * ── 为什么判据是 `kind`，不是 `source` ★★ ─────────────────
 *
 * 第一版写的是 `not (source='self' and derived_from is null)`，想排除的是
 * 「我自己整理的表达」整段贴进来的**原句** —— 拿一整句话去出产出题，
 * 考的不是一个表达。
 *
 * 但那个谓词排错了人。整段贴入（`addChunks`）写的是
 * **`layer='A'` + `kind='sentence'`**，`layer='B'` 那一半就已经把它挡住了；
 * 而真正被排除掉的是**右键「收成主动词汇 · 要练到能写出来」**收进来的条目
 * （`addItem` 写 `source='self'`、`derived_from` 为空、但 `kind='chunk'`）——
 * 那颗按钮上写着「要练到能写出来」，软件却不再给他出产出题。
 * 是 `errors.test.ts` 两条红把它顶出来的。
 *
 * 所以判据认 `kind`：**整句不练产出，表达才练**。
 * `source` 只说明「是他自己加的」，说明不了「是不是一整句话」。
 *
 * ★ 判据只有这一处。SQL 那一侧是它的**翻译**（`main/db/silence-sql.ts`），
 *   有一条对拍用例逐格比对两者，翻译漂了当场红。
 */
export function productionApplies(f: ItemFacts): boolean {
  return f.layer === 'B' && f.kind !== 'sentence'
}

/**
 * 一条知识点整体算不算静默。
 *
 * 主动词汇：**整条静默只看产出线**（M-003 / D-135）—— 写得出来自然认得出。
 * 被动词汇 / 专有名词 / 我的上传库：只跑认读线，看认读线。
 */
export function isItemSilent(item: ItemLines): boolean {
  return item.productionApplies ? item.production === 'silent' : item.readingSilent
}

/**
 * ★★★ I-204 · 界面层与主进程判「这一行算不算静默」的**唯一口子**
 *
 * 为什么要有它：`isItemSilent` 要的是 `ItemLines`（已经算好的 `productionApplies`），
 * 而全项目实际拿在手上的都是**一行原始字段**（`layer` / `kind` / `productionState` / `cardSilent`）。
 * 于是四处调用方各自把那三样拼成了一个表达式 —— 而且拼的是**「或」**：
 *   `productionState === 'silent' || cardSilent`
 * 「或」比条件式**严格更宽**，错的方向只有一个：**界面把条目藏了，引擎照样把它排进练习。**
 *
 * ★ `cardSilent` 就是 `reading_cards.silent`（全项目的 SQL 都这么取别名）——
 *   参数名跟着调用方写，**省掉每个调用点再手动映射一次**，那正是上一次漂开的起点。
 * ★ 守它的是 `scripts/check-silence-one-source.mjs`：除本文件与 `sql/silence.ts` 之外，
 *   任何一行都不许再把两条线自己组合成判断。
 */
export function isRowSilent(
  row: ItemFacts & { productionState: ProductionState; cardSilent: boolean }
): boolean {
  return isItemSilent({
    productionApplies: productionApplies(row),
    production: row.productionState,
    readingSilent: row.cardSilent
  })
}

/**
 * 产出线静默之后，认读卡要不要一并退役 · D-135
 * 「产出线静默后认读卡一并退役」—— 写得出来的东西没必要再翻卡。
 */
export function shouldRetireReadingCard(item: ItemLines): boolean {
  return item.productionApplies && item.production === 'silent'
}

export interface SilenceRollup {
  silent: boolean
  total: number
  silentCount: number
  /** 静默比例，供项目页 lecture 行的进度条使用 · D-176 */
  ratio: number
  reason: string
}

/**
 * 一个容器（lecture / 单元 / 项目）算不算静默 · D-080 / D-029
 *
 * 空容器**不算**静默 —— 一个还没放东西的 lecture 说「已完成」是荒谬的，
 * 而且会让上级跟着误升。
 */
export function rollup(children: boolean[], label = '容器'): SilenceRollup {
  const total = children.length
  const silentCount = children.filter(Boolean).length
  const ratio = total === 0 ? 0 : silentCount / total
  if (total === 0) {
    return { silent: false, total, silentCount, ratio, reason: `${label}是空的，不算练完` }
  }
  const silent = silentCount === total
  return {
    silent,
    total,
    silentCount,
    ratio,
    reason: silent
      ? `${total} 条都不用再练 —— ${label}完成`
      : `不用再练 ${silentCount}/${total}（${Math.round(ratio * 100)}%）`
  }
}

/** lecture 全部静默 → 单元静默 → 项目静默。轮转单位仍是 lecture（D-080）。 */
export function rollupLecture(itemsSilent: boolean[]): SilenceRollup {
  return rollup(itemsSilent, 'lecture')
}
export function rollupUnit(lecturesSilent: boolean[]): SilenceRollup {
  return rollup(lecturesSilent, '单元')
}
export function rollupProject(unitsSilent: boolean[]): SilenceRollup {
  return rollup(unitsSilent, '项目')
}

/* ══════════════════════════════════════════════════════════════════
   已练成 / 收起来 —— 一个状态，两件相反的事（D-485 · 2026-09-15）
   ══════════════════════════════════════════════════════════════════

   使用者原话（第七条）：「『静默』这个概念本身存在理解问题……如果这个名称
   确实容易造成误解，需要根据实际功能重新考虑表达方式，而不是强行保留一个
   用户看不懂的词。」

   ── 查出来的根 ────────────────────────────────────────────────
   「静默」底下是**两件相反的事**，而它们落在同一个 `production_state='silent'`：

     · **练成了**：连续 N 次第 3 档以上正确 → 不再轮转。上面那段头注说的
       「已通过全部检验……这套机制唯一的终点」，指的是**这一件**。
     · **收起来**：他自己点「收起来」（或整讲收起来）。术语表 TM-47 对它的
       定义是「先不练了（可逆）」—— 那是**搁置**，不是成就。

   于是「把不想练的收起来」会让进度看着变好。使用者 2026-09-15 裁：
   **分开显示，进度只算练成的那一半**（他明知道「现有数字会变小」还是点了头）。

   ── 怎么分辨（不加列、不改同步指纹）────────────────────────
   靠现成的 `silenced_by`：

     `'earned'`                      自动那条路写的（新增的唯一一个值）
     `'self'`                        他一条一条点的        → 收起来
     `'project' / 'unit' / 'lecture'` 被那一级带下去的      → 收起来
     `null`                          **老数据**            → 按练成算，不猜

   ★ 老数据按练成算，是使用者裁的方向（宁可把「收起来的」算成练成，
     也不要把他真练成的降级 —— 后者会让他的进度凭空缩水，而那是他的成绩）。
   ★ 库里那个状态值 `'silent'` **一个字不动**（同题型保留老 id 的规矩）：
     改的只是显示与统计，不是数据。
*/

/** 这一条是**练成的**还是**被收起来的** */
export type SilenceKind = 'earned' | 'shelved' | 'unknown'

/**
 * 从 `silenced_by` 认出是哪一种。
 * @param silencedBy `items.silenced_by` 那一列的值（没静默的不该问这个函数）
 */
export function silenceKind(silencedBy: string | null | undefined): SilenceKind {
  if (silencedBy === 'earned') return 'earned'
  if (silencedBy === null || silencedBy === undefined || silencedBy === '') return 'unknown'
  /** `self` · `project` · `unit` · `lecture` —— 都是他自己（或他对某一级）做的决定 */
  return 'shelved'
}

/**
 * ══ `silenceLabel()` 删于 2026-09-15（D-489 · 使用者裁）═══════════
 *
 * 它是「这一条是练成的还是他自己放一边的」在**屏上**的名字。
 * 使用者这一轮裁：**静默档里不再标是哪一种**（原话那一条是「已练成」这个说法
 * 「口语化、生硬、俗套」，而且他不要小标把一档分成两半）。
 *
 * ★ **判据没删，只删了屏上那一层**：`silenceKind()` 还在、用例还在、
 *   `rollupKinds()` 照旧只把练成的算进进度（D-485 那条分界一个字没动）——
 *   变的只是「不再把这个区分写到他眼前」。
 * ★ **从生成名单里摘掉，不是把控件藏起来**：留一个没人读的 `silenceLabel()`，
 *   下一个人会以为屏上还有这个说法，照着它写新文案，而「已练成」已经退役了。
 */

/**
 * Vault 那一档的名字 —— **使用者 2026-09-15 裁「改成静默吧，这个名字太差了」**。
 *
 * ══ 这一栏被改过两次，两次都是他裁的，别再来回翻 ═════════════
 *   ① 原来叫「静默」→ 他说看不懂 → 改成「不再出题的」（D-485）；
 *   ② 用下来他又说「这个名字太差了」→ **改回「静默」**，并追一句
 *      「最多之后给它加一个引导解释（双端）」。
 * ★ 所以这一轮的解法**不是再换一个更长的名字**，是 **短名字 ＋ 一句解释**：
 *   解释住在页内引导 `vault-learned` 那一条（core 一份，两端同一句）。
 *   —— 用长名字去代替解释，代价是每一处引用它的地方都得念一遍那句话。
 *
 * ★ 档名仍然**中性**：档里混着两件相反的事（练成的 · 他自己收起来的），
 *   档名不站边，由每一行用 `silenceLabel()` 说清是哪一种。「静默」正好不站边。
 * ★ **概念那一半一个字没动**（D-485）：库里那一列仍然是 `silent`，
 *   `silenceKind()` / `silenceLabel()` / 进度只算自动那一半 —— 全照旧。
 *   改的只是屏上那个档的名字。
 */
export const SILENCE_FILTER_NAME = '静默'  // copy:term-def 档名常量（D-485 附记 ⑤）—— 屏上这两个字只许从这儿来

/**
 * 「轮转」屏上退役之后说什么（D-485 补裁 · 主控 2026-09-15）。
 *
 * 「轮转」是**机制词**：它描述的是排期算法怎么转，不是他在做的事。
 *
 * ★★ **为什么这三个字放在 core**（C 提的，对）：它们是**两端都要说的同一句话**。
 *   各端各写一遍字面量的话，一端改了另一端**不会有任何东西报错** ——
 *   和 `ONBOARDING_STEPS` 进 core 是同一条理由（COPY_RULES CR-7）。
 * ★ **两端都引它**（2026-09-15 核实，改正下面这段原来写错的话）：
 *   Windows 也有两处真的在渲染它 —— `Home.svelte`「N 个 Lecture {inPractice}」与
 *   `Workbench.svelte`「N 条{schedule}了。」。屏上别处出现的「在练」「排进练习」
 *   是**普通话里的那几个字**（「继续在练」「过目之后才会排进练习」），不是这个标签。
 *
 * ★★ 原来这里写着「Windows 那几句由 `silence.test.ts` 那条用例钉着不许漂」——
 *   **那句话是假的**：那份用例只钉了「这两个词里不许有退役词」和「不是空串」，
 *   没有任何东西把它和屏上那两处连起来。典型的「闸的说明不是闸的行为」。
 *   现在真补上了（`silence.test.ts` 里那条「两处真的在引它」），见那边的头注。
 *
 * ★ 为什么**不**把别处那些句子也抠成插值：`check:copy` 会剥掉 `${…}`，
 *   抠一句就等于让那一句从文案闸底下消失。只有真正当**标签**用的地方才值得引常量。
 */
export const ROTATION_WORDS = {
  /** 状态：它还排在练习里 */
  inPractice: '在练',
  /** 动作：把它排进练习 */
  schedule: '排进练习'
} as const

/**
 * 动作名 —— **全部层用同一对词**（使用者 2026-09-15 三裁之一，D-489）。
 *
 * ══ 这一栏为什么又变了 ═══════════════════════════════════════
 *   ① 原来叫「静默 / 打回轮转」→ 他说看不懂 → D-485 改成「收起来 / 放回去」；
 *   ② 用下来他说「收起这个 Lecture」应该叫「静默这个 Lecture」，并裁
 *      **项目 · 单元 · Lecture · 知识点全部层都用「静默 / 恢复」**。
 * ★ 所以这一对词现在**没有层级差别**：以前那种「条目层一个词、容器层另一个词」
 *   正是 D-485 当初想消掉的毛病，绕了一圈又长回来过一次（`Workbench.svelte`
 *   那两处手写字面就是证据）。这一版把它收进常量，屏上不许再写字面。
 * ★ 「练成」仍然**不是他能点的动作** —— 那是练出来的结果，所以这里只有两个词。
 */
export const SILENCE_ACTIONS = {
  /** 让它不再出题（一条、或整支） */
  shelve: '静默', // copy:term-def 动作常量（D-489）—— 屏上这两个字只许从这儿来
  /** 从静默里拿回来，重新排进练习 */
  restore: '恢复'
} as const

/**
 * 容器层 ⋮ 上那一句：动作 + 说清是哪一级 ——「静默这个 Lecture」/「恢复这个 Lecture」。
 *
 * ★ 为什么不把整句写成四个常量（项目 / 单元 / Lecture 各两句）：
 *   那样动作词就有了八份拷贝，改一次要改八处，而漏改的那处**不会有任何东西报错**。
 *   拼出来的话，动作词永远只有上面那一个出处。
 * ★ `scope` 由调用方给（「项目」「单元」「Lecture」）—— 层级名是那一屏自己的事，
 *   不该由这份判据来列举。
 */
export const silenceScopeAction = (silenced: boolean, scope: string): string => {
  const act = silenced ? SILENCE_ACTIONS.restore : SILENCE_ACTIONS.shelve
  /**
   * ★ 中文接拉丁词中间留一个空格 ——「静默这个 Lecture」。
   *   全仓文案都这么排（`Lecture` 是首字母大写的专名，D-471），
   *   贴着写出来是「静默这个Lecture」，一眼就看得出是拼接出来的。
   * ★ 「项目」「单元」这种中文层级名不加 —— 中文之间加空格反而怪。
   */
  return `${act}这个${/^[A-Za-z]/.test(scope) ? ' ' : ''}${scope}`
}

/**
 * 算一个容器的两件事 —— **它们不是同一件事，所以分开数**：
 *
 *   `silent`  这个容器**还有没有东西要练**（练成的、收起来的都不用练）
 *             → 排期与显示用它；全是收起来的，那也确实没东西可练。
 *   `ratio`   他**练成了多少**（只算 earned + unknown）
 *             → 进度用它；把不想练的收起来不该让进度变好看（D-485）。
 *
 * @param children 每个孩子：`null` = 还在练；否则是它的种类
 */
export function rollupKinds(
  children: readonly (SilenceKind | null)[],
  label = '容器'
): SilenceRollup {
  const total = children.length
  const done = children.filter((k) => k !== null).length
  const earned = children.filter((k) => k === 'earned' || k === 'unknown').length
  const ratio = total === 0 ? 0 : earned / total
  if (total === 0) {
    return { silent: false, total, silentCount: earned, ratio, reason: `${label}是空的，不算完成` }
  }
  const silent = done === total
  const shelved = done - earned
  return {
    silent,
    silentCount: earned,
    total,
    ratio,
    /**
     * ★ 「已练成 / 收起来了」两个词 2026-09-15 退役（D-489），这句话跟着改。
     *   **区分没去掉**：进度只算练成的那一半（D-485 的分界），所以他必须看得见
     *   「另外那几条不是没练，是被你静默了」—— 不说的话他会以为那几条凭空不见了。
     *   去掉的只是那两个退役说法，动作词从 `SILENCE_ACTIONS` 来。
     */
    reason:
      shelved > 0
        ? `练成 ${earned}/${total}（${Math.round(ratio * 100)}%）· 另有 ${shelved} 条由你${SILENCE_ACTIONS.shelve}`
        : silent
          ? `${total} 条全部练成 —— ${label}练完了`
          : `练成 ${earned}/${total}（${Math.round(ratio * 100)}%）`
  }
}
