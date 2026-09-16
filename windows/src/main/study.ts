/**
 * 学习流程的服务层 —— **入口**（T-4.6 拆分 · 2026-09-06）
 *
 * **判断规则一条都不在这里** —— 全在 core/（D-238）。这一层只做三件事：
 * 从库里取状态 → 交给 core 算 → 把结果写回去。
 *
 * ── 2,571 行拆成六个领域（T-4.6）────────────────────────
 * 类名与**公共方法名一个都没改**（`main/index.ts` 的 IPC 直接调它们，`check:ipc-guard` 守着），
 * 类里只剩构造与一行行委托；方法体按领域搬进了 `study/`：
 *   lecture · reading · production · library · analysis · prefs
 * 私有方法整个搬走、不再挂在类上 —— 它们的调用点全在各自那一份文件里（搬之前逐个数过）。
 * 依赖清单在 `study/ctx.ts`；三个模块级小工具在 `study/util.ts`。
 */

import type { Database } from 'better-sqlite3'
import { type ItemProgress } from '@core/grading.ts'
import { type QSlot } from '@core/qtype-plan.ts'
import { QTypes } from './db/qtypes.ts'
import { ParamStore } from './params.ts'
import type { Dicts } from './dict/index.ts'
import type { ReadingGrade } from '@core/types.ts'
import type { AnalyzeStage, CardRow, DiagnoseResult, GradeResult, HardRow, ItemDetail, LibraryFilter, LibraryItem, MatrixData, PracticeOrder, QuestionRow, ReadingResult, Settlement, StartLearningResult, TodayPlan } from '@shared/api.ts'
import { type AnalysisScope } from '@core/sql/analysis.ts'
import { type ReadingFace } from '@core/reading-face.ts'
import { practiceRulesOf } from '@core/quiz-rules.ts'
import { Prefs } from './db/prefs.ts'
import { Ledger } from './db/ledger.ts'
import type { StudyCtx } from './study/ctx.ts'
import * as lecture from './study/lecture.ts'
import * as reading from './study/reading.ts'
import * as production from './study/production.ts'
import * as library from './study/library.ts'
import * as analysis from './study/analysis.ts'
import * as prefs from './study/prefs.ts'

export class Study {
  private params: ParamStore
  /** 4.1 · 行为与状态账本。删除 / 静默 / 恢复都要在这儿留一笔 */
  private ledger: Ledger
  /** ★ Step 5A · 跟着人走的那些设置，唯一入口 */
  private prefs: Prefs

  constructor(
    private db: Database,
    private promptsDir: string,
    private level: () => string,
    /**
     * 词典是可选的 —— 使用者没放词典，软件照常用，例句退回 AI 生成并标明来源（D-150）。
     * 用取值函数而不是实例：词典会被重新扫描、重新装载，这里要拿到当下那一份。
     */
    private dicts?: () => Dicts | null
  ) {
    this.params = new ParamStore(db)
    this.ledger = new Ledger(db)
    this.prefs = new Prefs(db)
    this.qt = new QTypes(db)
    /**
     * ★ 各领域文件拿到的就是这一份依赖清单（T-4.6）。
     *   在构造函数最后组装 —— 上面那几样都已经就位。
     */
    this.ctx = {
      db: this.db,
      params: this.params,
      ledger: this.ledger,
      prefs: this.prefs,
      qt: this.qt,
      promptsDir: this.promptsDir,
      level: this.level,
      dicts: this.dicts,
      self: this
    }
  }

  /** 题型现在是一张表（V17），不再是写死的数组 —— 他可以自己增删改 */
  readonly qt: QTypes

  /** 领域文件要的那份依赖清单 —— 见 study/ctx.ts */
  private readonly ctx: StudyCtx
  /**
   * 「这批我看过了 · 开始学」——**这一讲才进入轮转**。
   *
   * 它不是仪式，是门：D-053 说 AI 后台自动归档、不做批量审批，那反对的是**逐条**打勾；
   * 这里是整批一个动作，什么都不点也能走。顺带回答了「首次到期日落在哪一天」——
   * 审阅之后的第二天，好让阶段④首轮认读有地方站（见 docs/archive/study-flow.html）。
   */
  /**
   * ★★ P-1 · 这一步现在是**一个原子动作**，而且**只能从 review 进入**。
   *
   * ── 以前有两个洞 ────────────────────────────────────────
   *
   * ① **三条写入没有事务。** `update lectures` 成了、`update items` 炸了，
   *    结果是「这一讲进了轮转，可它的条目一张认读卡都没排期」——
   *    他点完「开始学」，认读队列是空的，而界面上一切正常。没有人查得到。
   *
   * ② **没有前置条件。** SQL 里只有 `where id = ?`，所以对一条**已经在轮转**的讲
   *    再调一次，会把 `interval_days` 打回 1、`due_at` 推到明天 ——
   *    **进度清零**。界面上那颗按钮只在 `review` 时渲染，挡住了正常路径；
   *    但「靠界面挡」不是保证，IPC 通道本身是敞开的（P-1 不变量 I-2）。
   *
   * ── 现在的语义 ────────────────────────────────────────
   *
   *   `status='review' ∧ silent=0 ∧ 没删` → 进入轮转，三条写入同生共死
   *   其它任何形状                        → **一个字都不写**，`refused` 说清是哪一种
   *
   * 判据放在 UPDATE 的 `where` 里而不是先 SELECT 再判断：
   * 「先查后改」中间有窗口，而 `where` 子句的判断和写入是同一次原子操作。
   *
   * ── ★★ F-2-②-e · 归档的讲也要挡住 ──────────────────────
   *
   * 门槛以前只有 `status='review'`。而 `silent=1 ∧ status='review'` 是一种
   * **合法**的形状（归档时只翻 silent 位、清 due_at，status 保持原样），
   * 于是绕过界面直接调这条 IPC，就会给一个已归档的讲写上 `due_at=明天` ——
   * 正好撞上体检里 `silent-but-due` 那条 error 级不变量。
   *
   * 和 P-1 是同一个形状：界面确实挡住了（归档的讲不在项目栏里，
   * 那颗按钮也只在 `status==='review'` 时渲染），但**靠界面挡不是保证**。
   *
   * ── 拒绝的理由不许糊在一起 ──────────────────────────────
   *
   * 以前只有一个 `alreadyRunning: true`，于是「已归档」会被说成
   * 「这一讲已经在轮转中」—— 他照着这句话去找轮转里的它，永远找不到。
   * 现在分四种，每一种给一句他能照着做下一步的话。
   */
  startLearning(lectureId: number): StartLearningResult {
    return lecture.startLearning(this.ctx, lectureId)
  }

  /**
   * ★★ N-2 · 删知识点的**唯一入口**。工作台那个 ✕ 和勾选后的批量删除，
   * 走的是同一个函数、同一个事务、同一套语义。
   *
   * ── 以前是两套 ────────────────────────────────────────────
   *
   * `deleteItem` 只有一句 `update items set deleted_at`；
   * `bulkDelete` 还会往 `term_ledger` 记一笔 `deleted`。
   * 而账本正是「以后 AI 别再收它」这条长期意图的载体（4.1）——
   * 于是同一个动作产生了两种长期结果：
   *
   *   逐条 ✕ 删掉的 → 重新分析同一份材料，**全部回来**
   *   勾选批量删的 → 不回来
   *
   * 更糟的是那个 ✕ **只在 `status='review'` 时渲染** —— 也就是他正在
   * 审阅一批刚分析出来的结果、逐条剔掉不想要的。那正是最需要「拒绝」
   * 的场景，偏偏走的是不记账的那一条。
   *
   * ── 这个入口负责什么、不负责什么 ──────────────────────────
   *
   * 负责：`items.deleted_at` + `term_ledger` 的 `deleted` + `ops_log`，**一个事务**。
   * 不负责：删容器（`browse.deleteLecture` / `repo.softDelete`）——
   *   那是「这一讲我不要了」，不是「这个说法我不要了」，两种意图不同，
   *   不许为了「统一」让它们也写拒绝账（会把整讲的表达全部拉黑，
   *   而他完全看不出为什么 —— I-119 就是这个形状的事故）。
   */
  deleteItems(ids: number[]): number {
    return library.deleteItems(this.ctx, ids)
  }

  /** 单条删除 —— 和批量删除是同一个业务动作，只是量不同 */
  deleteItem(itemId: number): void {
    return library.deleteItem(this.ctx, itemId)
  }

  setLayer(itemId: number, layer: 'A' | 'B'): void {
    return library.setLayer(this.ctx, itemId, layer)
  }

  /** 到期的认读卡。不传 lectureId 就是跨 lecture 的混合队列（D-021）。 */
  /**
   * ★ 认读测试的牌面由 AI 出 · 使用者 2026-09-03「认读测试也应该拥有自己的 Prompt」
   *
   * ── 提示词在哪 ────────────────────────────────────────────
   *
   * `user_preferences['prompt.reading-card']`（**同步表**，跟着人走），
   * 没改过就用 `core/reading-face.ts` 的出厂默认。
   * 手机上读的是**同一个键、同一份默认**（`core/prompt-overrides.ts` 的名单），
   * 所以同一张卡在两台机器上考法一样 —— 各存一份的话，两边都说得通、都不报错。
   *
   * ── 失败一律返回 null ─────────────────────────────────────
   *
   * 没配 AI / 超时 / 格式不对 / 露了答案，统统安静返回 null，
   * 界面退回机械挖空（D-338 · AI 不在不许阻断认读）。
   * 认读是每天都要跑的事，它不能因为 AI 不在就跑不起来。
   */
  async readingFace(itemId: number, signal?: AbortSignal): Promise<ReadingFace | null> {
    return reading.readingFace(this.ctx, itemId, signal)
  }

  dueCards(lectureId: number | null, limit?: number): CardRow[] {
    return reading.dueCards(this.ctx, lectureId, limit)
  }

  /**
   * 随时测 · I-061
   *
   * 使用者：「项目、单元和 lecture 中的测试，无论是认读还是其他测试，
   *          **不遵循间隔重复**，只要想测都能测试。」
   *
   * 和 `dueCards` 的区别只有一条：**不看到期日**。
   * 其余照旧 —— 判分仍然走同一套 SM-2（练了就算数，不能白练），
   * 但**要不要练由你决定，不由日程决定**。
   *
   * 静默的也一并给出来：D-030 说静默是「通过全部检验、不再轮转」，
   * 不是「不许再碰」——他主动要测，那就给他。
   */
  testCards(lectureIds: number[], shuffle = false): CardRow[] {
    return reading.testCards(this.ctx, lectureIds, shuffle)
  }

  /**
   * 随时测 · 认读线，**按勾中的条目**（I-097）
   *
   * 和按 lecture 取是同一套规则（不看到期日、静默的也给），只是范围换成一串 id。
   * 复用 `testCards` 的查询会更省事，但那要先反查这些条目属于哪些讲 ——
   * 那样会把没勾中的兄弟条目一起拖进来，正好违背「我勾了哪几条就测哪几条」。
   */
  testCardsByIds(ids: number[], shuffle = false): CardRow[] {
    return reading.testCardsByIds(this.ctx, ids, shuffle)
  }

  /**
   * 随时测 · 产出线。同样不看到期日、不看状态。
   * 攻坚区里的也给 —— 他要测就是要测。
   */
  testQueue(lectureIds: number[], shuffle = false): { id: number; term: string; corrects: number }[] {
    return reading.testQueue(this.ctx, lectureIds, shuffle)
  }

  gradeCard(itemId: number, grade: ReadingGrade, durationMs?: number): ReadingResult {
    return reading.gradeCard(this.ctx, itemId, grade, durationMs)
  }

  /** 今天这一讲要练的条目：主动词汇、没静默、没在攻坚区。 */
  productionQueue(lectureId: number): { id: number; term: string; corrects: number }[] {
    return production.productionQueue(this.ctx, lectureId)
  }

  /**
   * 跨多个 lecture 取队列 —— 今日练习会一次收好几讲（D-027）。
   *
   * ★ 第一层「知识点顺序」在这里生效（使用者「出题顺序控制」）：
   * `seq` = 按收进来的先后（`i.id`），`random` = 乱序。
   * 乱序用 Fisher–Yates，不用 `sort(() => Math.random() - 0.5)` —— 后者不均匀。
   */
  productionQueueMany(lectureIds: number[]): { id: number; term: string; corrects: number }[] {
    return production.productionQueueMany(this.ctx, lectureIds)
  }

  /**
   * 指定一批条目来练 · D-012 筛选后统一测试
   * 静默的排除在外（D-024：除手动放出外不出现在任何测试中）。
   */
  queueByIds(ids: number[]): { id: number; term: string; corrects: number }[] {
    return production.queueByIds(this.ctx, ids)
  }

  /**
   * 攻坚区的队列 · D-025 / D-134
   *
   * 「先看诊断，再针对性出题；以**错误订正**为主，**题面用你自己上次写错的句子**。」
   * 一条练了 5 次还不过的知识点，再练第 6 次大概率还是不过 —— 因为重复的是同一个错误。
   */
  hardQueue(): { id: number; term: string; corrects: number }[] {
    return production.hardQueue(this.ctx)
  }

  /** 攻坚区列表：每条带上它历次写错的句子，那是 D-134 的题面素材。 */
  hardList(): HardRow[] {
    return production.hardList(this.ctx)
  }

  /**
   * 今日练习的匹配 · D-027 / D-228 / D-139
   * 判断规则在 core/daily-match.ts，这里只负责把数据喂给它。
   */
  todayPlan(target?: number): TodayPlan {
    return prefs.todayPlan(this.ctx, target)
  }

  dailyTarget(): number {
    return prefs.dailyTarget(this.ctx)
  }

  /**
   * ★★ V-1 · 走 `ParamStore`，**不再自己写一个键**（2026-08-16）。
   *
   * 以前这里写的是 `settings['daily.target']`，而读的那一侧
   * （`dailyTarget()` → `params.effective()`）读的是 `settings['param.dailyTarget']`——
   * **两个键从不相交**。表现是：他在首页点 +/−，当场那一屏是对的
   * （因为 `todayPlan(target)` 把数字当参数传了），**重开软件就回到 35**，
   * 因为 `load()` 调的是不带参数的 `todayPlan()`。
   *
   * 写了、存了、有人读、但读的是另一个键 —— 全项目 `grep daily.target`
   * 只有那一句 INSERT，零读取。现在首页和设置页共用同一条写入路径，
   * 顺带拿到 `ParamStore` 的上下限钳位。
   */
  setDailyTarget(n: number): void {
    return prefs.setDailyTarget(this.ctx, n)
  }

  /**
   * 他勾了哪些题型。没设置过 = 全都要。
   *
   * 存成一行设置而不是一张表：它是**一个偏好**，不是数据。
   * 存成表的话还得管排序、管软删、管同步冲突，为一个复选框列表不值得。
   */
  qtypes(): string[] {
    return prefs.qtypes(this.ctx)
  }

  setQtypes(ids: string[]): void {
    return prefs.setQtypes(this.ctx, ids)
  }

  /**
   * 出题顺序 · 两层（使用者「出题顺序控制」）
   *
   * 第一层是知识点的先后，第二层是同一条知识点内部题型的先后。
   * 两层分开存，因为它们回答的是两个不同的问题：
   * 「今天先练哪几条」和「这一条先用哪种形式考」。
   */
  order(): PracticeOrder {
    return prefs.order(this.ctx)
  }

  setOrder(o: PracticeOrder): void {
    return prefs.setOrder(this.ctx, o)
  }

  /**
   * 这一次要出的 15 道题，逐道定死是哪一档、哪一种题型 · ★ 2026-08-14
   *
   * 以前这里只把「他勾了哪些」按档列给 AI，**选哪一种交给 AI 自己发挥** ——
   * 于是它照着输出示例抄了「造句」，而他根本没勾造句（I-108 同款）。
   * 现在计划在本地算好（`core/qtype-plan.ts`），提示词里逐道写死，
   * 回来之后再逐道校验：**判据只有一份，生成前后用的是同一份。**
   */
  plan(itemId: number): QSlot[] {
    return production.planSlots(this.ctx, itemId)
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
  typesBrief(plan: QSlot[]): string {
    return production.typesBrief(this.ctx, plan, practiceRulesOf((k) => this.ctx.prefs.raw(k)))
  }

  /**
   * D-129 · 一次生成五档各 3 道，共 15 道，此后该条目完全离线可用。
   * 「大头开销是喂上下文，生成 3 道和 15 道喂的是同一份。分五次喂 = 五倍成本。」
   * **只在进入测试时触发**，其他任何地方都不调用生成。
   */
  async ensureQuestions(
    itemId: number,
    signal?: AbortSignal
  ): Promise<production.EnsureQuestionsResult> {
    return production.ensureQuestions(this.ctx, itemId, signal)
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
  hardQuestion(itemId: number): QuestionRow | null {
    return production.hardQuestion(this.ctx, itemId)
  }

  /** 下一道题：取当前难度档里还没用过的（D-116 随进度递进）。 */
  nextQuestion(itemId: number): QuestionRow | null {
    return production.nextQuestion(this.ctx, itemId)
  }

  /**
   * 判一次作答 · D-119 / D-120 / D-121 / D-122
   *
   * `isFirst` 决定这一条算不算数：**只记第一次判定**（M-019）——
   * 第一次作答是唯一诚实的样本；改到过关练的是「照着反馈修改」，那是另一种能力。
   */
  async submitAnswer(
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
    return production.submitAnswer(this.ctx, sessionId, itemId, questionId, text, isFirst, hinted, durationMs, signal)
  }

  /** D-138 ·「提示」按钮当分类器：判分不受影响，但记一次认读失败、该卡间隔打回。 */
  usedHint(itemId: number): { gloss: string; reason: string } {
    return production.usedHint(this.ctx, itemId)
  }

  progressOf(itemId: number): ItemProgress {
    return production.progressOf(this.ctx, itemId)
  }

  saveProgress(itemId: number, p: ItemProgress): void {
    return production.saveProgress(this.ctx, itemId, p)
  }

  /**
   * 4×4 状态矩阵 · D-158
   *
   * 纵轴产出线 `静默 / 攻坚 / 训练中 / 未开始`，横轴认读线 `新卡 / 学习中 / 成熟 / 静默`
   * —— 与总原型的 RL / CL 一字不差。
   *
   * 「为什么不用散点图：两条线**本身就是离散四档**，散点的连续坐标是人为折算的。
   *  矩阵无重叠、给精确条数、数据量越大越准，**而且空格子本身有意义**
   *  （「认读新卡 × 产出静默」永远是 0，说明机制自洽）。」
   *
   * 橙框那片（认读成熟 × 产出还没毕业）就是这套方法论瞄准的**全部对象**。
   */
  matrix(): MatrixData {
    return library.matrix(this.ctx)
  }

  /**
   * 库列表 · D-159 / D-160 / D-162 / D-019
   *
   * 「列表怎么排，测试就怎么出题」（D-162）—— 所以排序不是装饰，它决定出题顺序。
   * 静默条目**图里显示、列表里不显示**（D-158），除非明确要看静默库。
   */
  libraryItems(f: LibraryFilter): LibraryItem[] {
    return library.libraryItems(this.ctx, f)
  }

  /** 批量操作 · D-048 保留批量删除、批量改层级（批量加入已取消，AI 自动归档） */
  bulkDelete(ids: number[]): number {
    return library.bulkDelete(this.ctx, ids)
  }

  bulkSetLayer(ids: number[], layer: 'A' | 'B'): number {
    return library.bulkSetLayer(this.ctx, ids, layer)
  }

  /**
   * 批量静默 / 取消静默 · I-097
   *
   * 使用者要在勾选之后能「静默」。静默 = 通过全部检验、不再轮转（D-030），
   * 平时是**练出来**的；这里是手动指定 —— 有些条目他自己清楚已经会了，
   * 没必要陪着轮转三轮。
   *
   * 两条线各自有静默位（产出线 `items.production_state`，认读线 `reading_cards.silent`），
   * 所以「静默这一条」= 两条线一起静默，否则它还是会从认读那边冒出来。
   * 反向的「取消静默」同样要两条一起 —— 只放开一条，人会以为没生效。
   */
  bulkSilence(ids: number[], on: boolean): number {
    return library.bulkSilence(this.ctx, ids, on)
  }

  /**
   * 一串 id → 词条与释义 · I-098
   * 「复制」用的。让界面自己从当前列表里凑，会因为分页 / 筛选而少几条；
   * 从库里取才是「我勾了什么就复制什么」。
   */
  termsOf(ids: number[]): { id: number; term: string; gloss: string | null }[] {
    return library.termsOf(this.ctx, ids)
  }

  /** 静默库的统计 · D-030 游戏框上那三个数 */
  silentStats(): { items: number; lectures: number; projects: number } {
    return library.silentStats(this.ctx)
  }

  itemDetail(itemId: number): ItemDetail {
    return library.itemDetail(this.ctx, itemId)
  }

  /**
   * 按类别写完整解析 · I-104
   *
   * 使用者：「点进去可以有下拉框选择分析『整体分析』『我的收集』『主动词汇』『被动词汇』，
   *          可以每次单独分析，并且分析的时候还可以加上进度条。如果中途暂停了，
   *          回来继续分析上一次分析的内容之后，直接跳过已经分析的部分。」
   *
   * 三件事都在这一个方法里：
   *   · **只挑没写过解析的**（`not exists analysis_blocks`）—— 这就是「跳过已分析的」，
   *     不需要额外记进度：库里有没有解析块本身就是进度
   *   · 每写完一条报一次进度（`onStage`），界面画进度条
   *   · `signal` 一断就停在当前这一条 —— 已经写好的都留着，下次接着跑
   *
   * 一条失败不作废整批：它仍然可以在详情页里单独重试（和提取那边同一个处置）。
   */
  async analyseScope(
    lectureId: number,
    scope: 'self' | 'active' | 'passive',
    onStage: (s: AnalyzeStage) => void,
    signal?: AbortSignal
  ): Promise<{ total: number; done: number; failed: number; skipped: number }> {
    return analysis.analyseScope(this.ctx, lectureId, scope, onStage)
  }

  /**
   * 这一类里**还没写过解析**的条目。
   * 界面拿它显示「待分析 N 条」，跑的时候拿它当队列 —— 同一个判据，不会对不上。
   */
  pendingAnalysis(lectureId: number, scope: AnalysisScope): { id: number; term: string }[] {
    return analysis.pendingAnalysis(this.ctx, lectureId, scope)
  }

  /** 每一类各有多少条、其中多少条还没写解析 —— 下拉框上要显示这个 */
  analysisCounts(
    lectureId: number
  ): Record<'self' | 'active' | 'passive', { total: number; pending: number }> {
    return analysis.analysisCounts(this.ctx, lectureId)
  }

  /**
   * 生成完整解析 · D-142 / D-149 / D-190 / R-002
   *
   * **手动改过的区块不覆盖**（D-149）——「你自己写下的一句理解，比 AI 写的十句都管用；
   * 有些难点很个人，只有你自己知道。」这也是解析必须**逐区块**存的原因（D-257）：
   * 整块 JSON 存不下这个语义。
   */
  async ensureAnalysis(itemId: number, force = false, signal?: AbortSignal): Promise<number> {
    return analysis.ensureAnalysis(this.ctx, itemId, force, signal)
  }

  /**
   * 接受一条修正建议 · I-046
   *
   * **这是原句唯一会被改动的入口，而且必须由使用者亲手点。**
   * D-006 / M-015 说「整句原样入库，禁止改写」—— 那条规矩保护的是
   * 「这是我当时真正记下来的东西」。AI 可以指出疑似写错的地方，
   * 但**改不改由他决定**，而且改了要留痕。
   */
  acceptSuspect(itemId: number, index: number): string {
    return analysis.acceptSuspect(this.ctx, itemId, index)
  }

  /** 忽略全部建议。原句本来就没动过，这里只是把这一块收起来。 */
  /** T-9.14 · 改词条正文（term / gloss / gloss_zh）。判据在 core，见 `analysis.editItem` */
  editItem(itemId: number, input: { term?: string; gloss?: string; glossZh?: string }): string {
    return analysis.editItem(this.ctx, itemId, input)
  }

  dismissSuspects(itemId: number): void {
    return analysis.dismissSuspects(this.ctx, itemId)
  }

  /**
   * 一句原句析出了哪些成分 · I-088
   *
   * 我的上传库里点开一句就展开它的析出项（总原型的 `.ur` + `.deriv`）。
   * 单独开一个口子而不是复用 `itemDetail`：那个要把解析区块、出处、
   * 析出项全查一遍，为了展开三行字不值得。
   */
  derivedOf(itemId: number): ItemDetail['derived'] {
    return library.derivedOf(this.ctx, itemId)
  }

  /** D-022 · 手动静默。位置不显眼，但要有。 */
  silenceItem(itemId: number): void {
    return library.silenceItem(this.ctx, itemId)
  }

  /** 从静默里放出来。D-024 说静默是封闭的，除**手动放出**外不出现在任何测试中。 */
  restoreItem(itemId: number): void {
    return library.restoreItem(this.ctx, itemId)
  }

  settle(lectureId: number, sessionId: number | null): Settlement {
    return lecture.settle(this.ctx, lectureId, sessionId)
  }

  /**
   * 结算 · D-127 / D-139
   *
   * **每个 lecture 各算各的间隔**（D-139）—— 今日练习会跨好几讲，
   * 用整场的正确率去决定每一讲的排期，等于拿别的讲次的表现给这一讲定期。
   */
  /**
   * ★★ P-1 · 整场结算是**一个原子动作**，而且**一生只做一次**。
   *
   * 它是「一场 session」的业务动作，不是「一讲」的 —— 所以三讲里第二讲失败时，
   * 正确的结果是**三讲全部保持结算前的样子**，而不是第一讲已经扩张、第二讲没动。
   * 以前逐讲循环没有事务，那种半结算状态既没人恢复、`audit` 22 项也没有一条查得到：
   * 两讲的 status / due_at 都合法，只是数字错了。
   *
   * 同属这一个原子操作的：`lectures.interval_days` · `lectures.due_at` ·
   * `lecture_logs` 的 practiced 记录 · `sessions.finished_at`。
   * **不属于**它的：`answers` 与 `review_logs` —— 那些在答题那一刻就已经各自
   * 原子地落库了（见 `submitAnswer`），结算只读不写。
   */
  settleLectures(lectureIds: number[], sessionId: number | null): Settlement {
    return lecture.settleLectures(this.ctx, lectureIds, sessionId)
  }

  /**
   * 诊断与总评 · D-097 / D-127 / D-165 / M-032 / M-033
   *
   * 「在**结算页顺便更新**（总评那次调用已读完全部作答，零额外成本）。」
   * 所以两段结果一次调用一起要 —— 纵向看一条，横向看一轮。
   */
  async diagnose(sessionId: number | null, signal?: AbortSignal): Promise<DiagnoseResult> {
    return production.diagnose(this.ctx, sessionId, signal)
  }

  /**
   * ★★ V35 / D-350 · 开一次会话，**并把当时生效的规则整块拍下来**。
   *
   * ══ 为什么要快照 ══════════════════════════════════════════
   *
   * 《总体开发指导》§14：「当前 session 使用**开始时锁定的规则**，
   * 新规则从下一 session 开始生效。」
   * 场景是真实的：手机开始练 → 电脑上改了题型 / 每日条数 → 规则同步下来了
   * → **这一轮不该中途换规则**。
   *
   * ══ 为什么落库而不是只放内存 ★★ ═══════════════════════════
   *
   *   ① 手机上练到一半被系统杀掉**是常态**。内存快照一死，
   *      恢复之后**悄悄换成了新规则** —— 而 §14 要防的正是这个。
   *   ② ★ `sessions` **已经在 `SYNC_TABLES` 里**，这一列自动同步到电脑。
   *      否则规则一改，历史数据的可比性**无声地断掉**：
   *      「这一批答案是在哪套题型下产生的」事后说不清（D-349）。
   *
   * ★ 整块存 JSON，**不拆成多列** —— 与 `core/prefs.ts::ARRAY_PREFS_MERGE_WHOLE`
   *   同一条理由：拆开之后跨设备合并会合出**两边都不认**的结果。
   * ★ 拍不下来**不许把开会话带崩** —— 少一列元数据是小事，练不了是大事。
   */
  startSession(kind: string, scope: string, target: number): number {
    return lecture.startSession(this.ctx, kind, scope, target)
  }

  /** 首页状态行 · D-028 —— 如实显示欠账，不催、不弹窗。 */
  overview(): { lectures: number; dueLectures: number; worstOverdue: number; dueCards: number } {
    return lecture.overview(this.ctx)
  }
}
