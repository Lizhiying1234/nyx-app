/**
 * **唯一一处指向 core 的地方 —— 指的是 git submodule `nyx-core/`（锁定 commit SHA），不再是 Windows 工作树。**
 *
 * ★ T-1.3（2026-09-04）：此前这里写的是指向 Windows 仓库**主检出**的相对路径（往上两级再进那个仓），
 *   那边改一行，手机下一次构建就静默跟着变（审计 R-002）。
 *   现在 `nyx-core/` 是 nyx_project 仓库的 submodule，Android 仓 HEAD 记着它的 SHA：
 *     · 要让手机用上新 core：`git -C nyx-core checkout <sha>`（或 `git submodule update --remote nyx-core`），
 *       跑 `npm test`，再把指针一起提交。构建日志与 Settings › ABOUT 会打出正在用的 core SHA。
 *     · `tests/core-lock.test.ts` 钉着：工作树 = 指针、正文 = 锁定 commit、链里没有物理路径。
 *
 * ── 为什么是一个文件而不是到处 import ────────────────────────
 *
 * D-289：core 与 Windows **共享同一份源码，不建立第二份**。
 * 那么「那一份在哪」这件事就该只写一次 —— 将来换成 workspace 依赖、
 * 或者像探针那样构建时 vendor 进来，只改这个文件。
 *
 * ★ 这里**只 re-export，不加一行逻辑**。任何判据都不许在这一层出现。
 */

export { splitSql } from '../nyx-core/src/core/sql-split.ts'

export {
  PRESERVED_SYNC_KEYS,
  afterWipe,
  verifyAfterWipe,
  type SyncMetaSnapshot
} from '../nyx-core/src/core/sync-metadata.ts'

export {
  BUILTIN_TABLES,
  canonicalUid,
  isCanonicalUid,
  type BuiltinIdent
} from '../nyx-core/src/core/builtin-identity.ts'

export { SYNC_TABLES } from '../nyx-core/src/core/sync-tables.ts'

/* ══ 阶段 1（D-365）· 学习引擎 ════════════════════════════════
   「练习和 Win 版一模一样、判分也一样」在这里成为**机械保证** ——
   是同一个函数，不是实现得像。
   对照测试：tests/core-parity.test.ts —— 输入取自 Windows 的 core 测试
   用例，输出钉成字面量。**有一天它红了，说明 core 变了**，Android
   立刻知道，而不是悄悄跟着变。 */

// ── 基础类型：判分与排期的共同语言 ──────────────────────────
export {
  GRADE_NAMES,
  READING_GRADE_NAMES,
  PRODUCTION_STATE_NAMES,
  CONTEXT_DISTANCE_NAMES,
  type Grade,
  type ReadingGrade,
  type ProductionState,
  type QuestionType,
  type ContextDistance
} from '../nyx-core/src/core/types.ts'

// ── 判分：产出线状态机（★★★ 产品的心脏）─────────────────────
export {
  DEFAULT_GRADING,
  newItemProgress,
  applyGrade,
  explainDistance,
  type GradingConfig,
  type ItemProgress,
  type GradeOutcome
} from '../nyx-core/src/core/grading.ts'

// ── 排期：认读卡 SM-2 · 讲次 SM-2 · 难度递进 ─────────────────
export {
  DEFAULT_READING,
  newCardState,
  intervalFor,
  previewIntervals,
  applyReadingGrade,
  penalizeFromHint,
  type ReadingConfig,
  type CardState,
  type ReadingOutcome
} from '../nyx-core/src/core/sm2-item.ts'
export {
  DEFAULT_LECTURE,
  nextLectureInterval,
  dueAfter,
  overdueDays,
  type LectureConfig,
  type LectureIntervalResult
} from '../nyx-core/src/core/sm2-lecture.ts'
// ── 出题：12 种题型 · 出题计划 ──────────────────────────────
// ★ 2026-09-08 · D-478 取消档位机制：`progression.ts` 整个文件在 core 里没了，
//   `tierFor` / `Tier` / 两个 `typesInTier` 一起退场。转出口跟着裁 ——
//   链里留着一个 core 已经不导出的名字，Windows 的 check:android-imports 会红，
//   而它红的正是「手机以为自己还能用这个判据」。
export {
  QTYPES,
  ALL_QTYPE_IDS,
  qtypeById,
  type QTypeDef
} from '../nyx-core/src/core/qtypes.ts'
export {
  shuffle,
  cycle,
  rotate,
  planQuestions,
  isAllowedType,
  fitQuota,
  preferDifferent,
  pickedTypes,
  // ★ 一次给一条出几道：出厂值与夹取在 core 一处，两端同一份（D-478）
  DEFAULT_QUESTIONS_PER_ITEM,
  QUESTIONS_PER_ITEM_MIN,
  QUESTIONS_PER_ITEM_MAX,
  clampQuestionsPerItem,
  // ★ M-027「三连正确要跨题型」原来靠档位链隐含保证；档位没了，判据改成显式的这两个
  CROSS_TYPE_WINDOW,
  crossesEnoughTypes,
  type QTypeLite,
  type QSlot,
  type Rnd
} from '../nyx-core/src/core/qtype-plan.ts'

// ── 今日：半数规则 · 开始学习的排期 ──────────────────────────
export {
  matchToday,
  type DueLecture,
  type MatchResult
} from '../nyx-core/src/core/daily-match.ts'
export {
  scheduleOnStart,
  type StartLearningFacts,
  type StartLearningSchedule
} from '../nyx-core/src/core/start-learning.ts'

// ── 静默：productionApplies 的唯一定义 · 向上滚算 ────────────
export {
  productionApplies,
  isItemSilent,
  shouldRetireReadingCard,
  rollup,
  rollupLecture,
  rollupUnit,
  rollupProject,
  /**
   * ── 一个词底下是两件相反的事（D-485 · 2026-09-15）────────────
   *
   * 自动（连续 N 次高档正确 → 这套机制的终点）与手动（先不练了，可逆）
   * 仍落同一个库值 `production_state = 'silent'`（一个字不动），靠 `silenced_by` 区分。
   *
   * ★★★ **2026-09-15 晚 · 这两种不再上屏了**（D-489 · 使用者裁）：
   *   「已练成」这个说法退役，行上那枚分两半的小标也去掉了。
   *   于是 core 把 `silenceLabel()` **整个删掉**，这里跟着摘 —— 只藏控件不删函数
   *   会留一条哑路：名字还在、没人用、下一个人以为它还是活的。
   * ★ **判据一个字没动**：`silenceKind()` 还在，进度仍然只算练成的那一半（D-485）。
   *   去掉的只是「把这个区分写到他眼前」，不是「不再区分」。
   */
  silenceKind,
  SILENCE_ACTIONS,
  /**
   * ★ 屏上那两处字也收进 core 了（B，2026-09-15）：Vault 那一档的名字、
   *   以及「轮转」退役之后的两个说法。理由都是同一条 ——
   *   两端都要说的同一句话，各写一份必然漂，而漂了没有任何东西会报错。
   */
  SILENCE_FILTER_NAME,
  ROTATION_WORDS,
  type SilenceKind,
  type ItemLines,
  type ItemFacts,
  type SilenceRollup
} from '../nyx-core/src/core/silence.ts'

// ── 偏好：USER / DEVICE 判据 + 白名单 ────────────────────────
export {
  PREF_SPECS,
  PREF_KEYS,
  prefSpecOf,
  looksLikeSecret,
  checkPrefKey,
  prefUid,
  checkPrefValue,
  ARRAY_PREFS_MERGE_WHOLE,
  type PrefSpec,
  type PrefKeyCheck,
  type PrefValueCheck
} from '../nyx-core/src/core/prefs.ts'

// ── 材料：断句摘句 · 分段 · 切块（Capture 用得到，D-311 内用量小）──
export {
  sentences,
  findQuote,
  findQuoteIn
} from '../nyx-core/src/core/quote.ts'
export { paragraphs } from '../nyx-core/src/core/paragraphs.ts'
export {
  CHUNK_LIMIT,
  chunkCount,
  chunkText
} from '../nyx-core/src/core/chunk-text.ts'

// ── 阶段 3 · 同步引擎（两端同一份 —— main/sync/index.ts 只是它的 Windows 装配层）──
export {
  SyncEngine,
  type EngineRunResult,
  type EngineStatus
} from '../nyx-core/src/core/sync/engine.ts'
/** 他对一次冲突的裁决（'local' / 'remote'）—— 入口层要按原样往下传，不许自己再定义一个 */
export type { Resolution } from '../nyx-core/src/core/sync-merge.ts'
export type {
  AudioPort,
  EngineDb,
  EnginePorts,
  SchemaIdentity,
  SecretsPort
} from '../nyx-core/src/core/sync/ports.ts'
export {
  makeStore,
  type RemoteStore,
  type SyncConfig
} from '../nyx-core/src/core/sync/store.ts'
export type { SyncProblem } from '../nyx-core/src/core/sync/problems.ts'

/**
 * ★ T-2.10 · 压实触发点的**两把钥匙与那条线**（判据本体在 core，这里只转发）。
 *   Android 侧只在 `tests/sync-engine.test.ts` 的 S-7 里用它们做断言 ——
 *   接线本身（`sync-runner.ts` 末尾那两句）不需要认识任何一个键名。
 */
export {
  COMPACT_PACK_LIMIT,
  COMPACT_PENDING_KEY,
  COMPACT_TRIED_KEY
} from '../nyx-core/src/core/sync/compact-trigger.ts'

// ── 图标几何（D-410「两端一起重画」）────────────────────────
// ★ 只有这一份。改了一端不报错，只会让两台机器上的 Nyx 慢慢长得不一样
export {
  NYX_ICON_DEFS,
  NYX_ICON_IDS,
  type NyxIconId
} from '../nyx-core/src/core/icons.ts'

// ★ F-009 · 「这个库还是长在原来那台机器上吗」—— 换号与旧号退休的判据
export {
  planRebind,
  MAX_FORMER_DEVICES,
  type RebindFacts,
  type RebindAction
} from '../nyx-core/src/core/device-rebind.ts'

// ★ F-015 · 回收站硬删的时钟护栏 + 留痕格式（两端同一份判据、同一个键）
export { purgeAllowed, PURGE_SKEW_LIMIT_MS } from '../nyx-core/src/core/purge-guard.ts'
export {
  decodeProblems,
  encodeProblems,
  SYNC_PROBLEM_KEY
} from '../nyx-core/src/core/sync/problems.ts'
export {
  FINGERPRINT_ALGO,
  normalizeSchema,
  readSyncSurface
} from '../nyx-core/src/core/schema-fingerprint.ts'

// ── 阶段 4 · AI 客户端（判分/生成 —— 三协议 D-202 · 四失败态 D-205，两端同一份）──
export {
  AiError,
  callAi,
  extractJson,
  type CallOptions,
  type Failure,
  type FailureKind,
  type SlotConfig
} from '../nyx-core/src/core/ai/client.ts'
export {
  detectProtocol,
  normalizeBaseUrl,
  PROVIDERS,
  SLOT_DESC,
  SLOT_NAMES,
  type Protocol,
  type Slot
} from '../nyx-core/src/core/ai/protocol.ts'

/**
 * ── T-5.14 · 手机改词条要用的两样判据（都在 core，这里只转发）────
 *
 * ★ `normalizeTerm` —— 「同一个说法」那把尺。改完之后判「是不是跟同讲次里
 *   另一条撞上了」用它，与合并（`core/dedup`）分组用的是**同一把**。
 *   ★ 2026-09-05：`src/db/capture.ts` 原来那份同源拷贝已经删掉，改成从这里引
 *     再原样导出（`db/lookup.ts` 按那个名字引它）—— **全仓只剩这一份**。
 * ★ `staleAfterEdit` —— 「这份解析是照着改之前的词条写的」。判定只有这一份，
 *   两端算出同一个答案（T-7.8 + T-5.14 的共同契约，指针 `ff41358`）。
 */
/**
 * ── 多选里的「全选」三态（T-9.15 起在 core）────────────────────
 *
 * ★ 判据原文本来长在这一端（`ui/lib/selection.ts`，T-5.18）。B 把它逐字搬进 core 之后
 *   这一端**把本地那份删了**，不留再导出的壳：`core-link.ts` 已经是这一端唯一的转出层，
 *   再套一层就是 D-238 说的「包装」。
 * ★ 它错的时候界面不报错，只会**说错话**（只选了 3 条却写着「已全选这 20 条」）——
 *   两端各写一份的结果就是同一个按钮在两台机器上说不同的话，而两边都说得通。
 */
export { selectAllState, toggleSelectAll } from '../nyx-core/src/core/selection.ts'
export type { SelectAllState } from '../nyx-core/src/core/selection.ts'

export { normalizeTerm } from '../nyx-core/src/core/normalize-term.ts'

/**
 * ── T-9.13 · Lecture 内查重与合并的**判据**（core 一份，两端共用）────
 *
 * `scanDuplicates` 回答「哪几条是同一个知识点、哪一条留下、这一组能不能自动合」，
 * `planMerge` 回答「被并那条的每张子表该怎么处理」。**判据里一行 SQL 都没有、
 * 一个自增 id 都不认**（只认 uid），所以 Windows 的 `main/db/merge.ts` 与这一端的
 * `db/merge.ts` 装的是同一份 —— 两端把库里的行读成同样的形状，就会得出同样的结果，
 * 而这正是 `tests/core-parity.test.ts::P-19` 逐字钉住的事。
 */
export { planMerge, scanDuplicates } from '../nyx-core/src/core/dedup/plan.ts'
export type {
  Bucket,
  DedupGroup,
  DedupItem,
  DedupScan,
  ItemRows,
  MergePlan,
  MergeStep
} from '../nyx-core/src/core/dedup/plan.ts'
export {
  countsAsTermChange,
  staleAfterEdit,
  STALE_EXEMPT_BLOCKS,
  type BlockStamp,
  type CorrectionEntry
} from '../nyx-core/src/core/analysis/stale.ts'
/**
 * ★ 改一条知识点正文的**判据**（D-478 ③ · T-9.14）：改哪几列 · 留痕那一笔长什么样 ·
 *   什么情况下拒绝。两端各写一份的后果是静默的 —— 留痕的 `field` 正是 `staleAfterEdit`
 *   认的键，形状差一个字，一端就永远判不出「这份解析写的是改之前的词条」。
 */
export {
  planItemEdit,
  ItemEditRefused,
  EDITABLE_COLUMNS,
  type EditableColumn,
  type ItemText,
  type ItemEditInput,
  type ItemEditPlan
} from '../nyx-core/src/core/analysis/edit.ts'

// ── 阶段 5 · 级联硬删（墓碑执行 —— 同步引擎与回收站清除走同一份）──
export { hardDelete } from '../nyx-core/src/core/cascade.ts'

// ── 提示词与题型（⑤ · 2026-09-01）───────────────────────────
// ★ 覆盖存 user_preferences（同步表）—— 两端读同一份，否则同一个 Nyx
//   在两台机器上出的题不一样、判分标准也不一样，而两边都不报错。
export {
  OVERRIDABLE_PROMPTS,
  promptPrefKey,
  type OverridablePrompt
} from '../nyx-core/src/core/prompt-overrides.ts'

/**
 * ── 提示词变量填充（在 core，这里只转发）────────────────────
 *
 * ★ core `prompt-fill.ts` 的文件头**早就预言了这件事**：「否则 Android 那边只能再抄一份。
 *   抄一份就会漂：少填一个变量时 Windows 停下来报错、手机把 `{{KIND}}` 原样发给 AI，
 *   两边都不崩，只是手机那边出来的解析一直是错的。」
 *   —— 结果 `db/prompts.ts` 里真的抄了一份（2026-09-13 清掉）。而且**已经漂了**：
 *   本地那份填不上时退回空串，core 那份退回 `{{VAR}}` 原样；报错文案也不同。
 * ★ 「没人填就抛」不是防御性编程，是踩过的坑：漏填的那一段会原样发给 AI，
 *   出来的结果一定是错的，而**一切看起来都成功了**。
 */
export { fill } from '../nyx-core/src/core/prompt-fill.ts'

/**
 * ── Lookup 的分节与那句脚注（在 core，这里只转发）──────────────
 *
 * ★ 判据原文长在**这一端**（`db/lookup.ts`，2026-09-01 那次「这张表是归一、
 *   不是白名单」的修）。Windows 也接上 AI 查词之后，同一件事就会有两份分节规则 ——
 *   同一段模型输出在两台机器上切成不同的小节，而两边都说得通、都不报错。
 *   搬进 core 之后这一端**把本地那份删了**，不留再导出的壳（D-238 的「包装」也不许，
 *   与 `ui/lib/selection.ts` 那次同一个处理）。
 * ★ `AI_LOOKUP_NOTE` = 「AI 搜索 · 可能有误」。那四个字是 D-395 的诚实原则本身。
 *   另外两句（`简明` / `完整`）留在 `db/lookup.ts` —— 那两档是 Assist 气泡的，
 *   **Windows 一档都没有**，收进共用层会被下一个人当成「两端都有」的证据。
 * ★★ `LookupSection` **不从这里引**：这一端那个接口多两样（`html` / `css`），
 *   词典分支要按词典自己的结构与样式渲染（D-404⑤），core 没有这一档。
 *   core 的两字段版是它的子集，`parseAiSections` 的返回值直接放得进去。
 */
export {
  AI_LOOKUP_NOTE,
  cleanLine,
  parseAiSections
} from '../nyx-core/src/core/lookup-sections.ts'

/**
 * ★★ 认读牌面：牌面模块 · 出题规则 · 一处拼装 · 两行解析 · 露答案红线
 *
 * 这几样**曾经只长在手机这边**（`db/lookup.ts` 里自带一份）。Windows 也接上
 * 认读牌面之后，同一件事就会有两份判据 —— 同一张卡在两台机器上考法不一样、
 * 红线松紧也不一样，而两边都说得通、都不报错。所以搬进 core，两端 import 同一份。
 *
 * ★★★ D-479（2026-09-08 · 使用者「牌面 = 可多选的内容模块，出题规则 = 一份统一 Prompt」）：
 *   老那套「五份整段提示词选一份」（`READING_PROMPT_PRESETS` / `DEFAULT_READING_PROMPT`）
 *   整套退役。现在提示词是**两件东西拼出来的** —— 规则（`prompt.reading-card`，键没变、
 *   含义改成规则正文）+ 他勾的那几面（`reading.faces`），拼装只有 `buildReadingPrompt`
 *   这一处，所以「同一份偏好在两台机器上算出同一份提示词」是**结构性**的。
 * ★ 手机**不做**牌面 / 规则的设置界面：两把键都进同步，跟着人走（TM-21 那类由电脑那侧管）。
 */
export {
  DEFAULT_READING_RULES,
  READING_FACES,
  buildReadingPrompt,
  faceById,
  /** 这一面是不是他自建的（内置四面删不掉 —— core 会把缺的补回来） */
  isCustomFaceId,
  /** `write`「先写再翻」的逐字比对判据（不调 AI，两端同一把尺） */
  matchesTerm,
  /**
   * 「他以前写过的那段出题规则正文」的判据 —— **每一版出厂都要认**。
   * ★ 只认今天那份的话，老用户库里躺着的是上一版出厂正文，会被判成「他改过」，
   *   然后收到一句他一个字都没写过的话。2026-09-15 真机上就是这么露馅的：
   *   本仓自己写了一份「和今天的出厂比」，装到手机上当场多出那一行。
   */
  legacyReadingRulesOf,
  migrateLegacyReadingPrompt,
  /** 上一版出厂正文（冻住的）—— 用例要拿它造「老用户那种库」 */
  READING_RULES_BEFORE_OPTIONS,
  onFaces,
  parseFace,
  parseFacePrefs,
  readingFaceUser,
  /**
   * ★ 模型回来的是**形式名**（「挖空」），而「轮着来」要记的是 id ——
   *   拿这次可用的那几面反查名字。认不出来就什么都不记（宁可这一次不计入轮转，
   *   也不要把猜出来的 id 写进去：写错的后果是某一面从此永远被跳过，而屏上不说话）。
   */
  resolveFace,
  revealsAnswer,
  serializeFacePrefs,
  type FacePref,
  type ReadingFace,
  type ReadingFaceDef
} from '../nyx-core/src/core/reading-face.ts'
export {
  allQTypes,
  activeQTypes,
  saveQType,
  removeQType,
  setQTypeEnabled,
  reorderQTypes,
  restoreBuiltinQTypes,
  /**
   * ★★★ I-187 · 「这一种题型到底按哪段话出题」的**唯一判据**（2026-09-15）。
   *   内置 → 只用 `guide`；自建 → `prompt || guide`。
   *   ★ 2026-09-15 夜**第二次加**：第一次（`82ccd1f`）被静默改名那一笔的合并盖掉了，
   *     五处一起没了，而**没有任何一道闸会红** —— 连盯着它的 P-0b 都被一起删了。
   */
  effectiveQTypePrompt,
  type QTypeRow
} from '../nyx-core/src/core/qtypes-store.ts'

// ── 移动知识点（⑨ · 2026-09-01）─────────────────────────────
// ★ D-354 明写「移动的方法**两端同款一起定**」。在这之前两端都没有 ——
//   所以方法一次性定在 core，Windows 将来接 UI 时用同一份。
export { moveItems, type MoveResult } from '../nyx-core/src/core/move-items.ts'

// ── 「彻底删除」的编排（④ · 2026-09-01）────────────────────────
// ★ 整个应用里最不可逆的一步：真删行 + 写墓碑，而墓碑随同步走到另一台机器
//   让它照着删。**两端必须是同一份判据**，否则两台机器对「什么该被永久删掉」
//   的理解会不一样，而且不报错。规矩写在 core/purge.ts 的文件头。
export {
  purgeMany,
  termsUnder,
  itemIdsUnder,
  type PurgeKind,
  type PurgeLedger
} from '../nyx-core/src/core/purge.ts'

// ── D-401 词典批 · MDict 解析（core/dict/mdx.ts —— I/O 与 inflate 注入，
//    Windows 注 fs+zlib，这边注内存缓冲+fflate；D-238「换掉的只有 io」兑现）──
export { Mdx, toText as mdxToText } from '../nyx-core/src/core/dict/mdx.ts'
export type {
  DictionaryIO,
  FileHandle,
  Inflate
} from '../nyx-core/src/core/dict/contract.ts'
/**
 * ★ T-5.10 · 词典失败的**话术只有一份**（`core/dict/diagnostics.ts` 文件头原话：
 *   「话术只有这一处出处，renderer 一个字都不许自己拼」）。
 *   `toDiagnostic` 是 core 自己的「任何异常 → 一条诊断」的兜底分类器；
 *   `DictionaryOpenError` 用来分辨「core 认出来的」与「还没认出来的」。
 *   在这之前 Android 侧把 `err.message` 直接落库、或者干脆吞掉（`hitOf`）——
 *   前者正是 D-262 骂过的「设置页上写着 V8 的英文报错」，后者更糟：什么都不说。
 */
export {
  DictionaryOpenError,
  toDiagnostic
} from '../nyx-core/src/core/dict/contract.ts'
export type {
  DictionaryDiagnostic,
  DictionaryStatus
} from '../nyx-core/src/core/dict/diagnostics.ts'
// ★ 变体重定向（`@@@LINK=`）—— 朗文6 有 80.4% 的词目是这种指路条（core 实测数）。
//   不跟随的话，查 deprecated 只会看到「@@@LINK=deprecate」。判据与跳数上限同一份。
export {
  detectRedirect,
  MAX_REDIRECT_HOPS
} from '../nyx-core/src/core/dict/lookup.ts'
// ★ D-404 资源批 · 词条引用的资源名 → .mdd 里的键（`sound://x.mp3` → `\x.mp3`）。
//   大小写、正反斜杠、%XX、scheme 的那把尺只有这一把。
export {
  extensionOf as dictExtensionOf,
  normalizeResourceKey,
  mimeOf as dictMimeOf
} from '../nyx-core/src/core/dict/media.ts'
/**
 * ★★ I-165 · **浏览器放不放得响**只有这一把尺（`core/dict/capability.ts`）。
 *
 * LDOCE5 的词头音是 `.spx`（Speex），Chromium 早就没有这个解码器 ——
 * 不挡的后果不是「没声音」，是**账本说假话**：词典那一步报 hit、日志写
 * 「词典语音出的声」，而实际上 `play()` 抛了、他听到的是系统音。
 * 词典层早就有这把尺（`makeMedia` 挂 `diagnostics.speex` 用的就是它），
 * 语音这条路以前绕过了它 —— 这里接回去，**不在平台层另列一张扩展名表**。
 */
export { isPlayableAudioExt } from '../nyx-core/src/core/dict/capability.ts'
/** 有音、但一条都放不响时说的那句话（两端同一句 —— 账本与 `nyx.log` 直接用它） */
export { unplayableDictSays } from '../nyx-core/src/core/voice/providers/dict-audio.ts'

// ── 朗读（D-466 · 两档：词典语音 · 系统语音）───────────────────
//
// ★ `ttsText` 是「读之前怎么把这段话洗干净」那一份判据（两端同一条）。
//   缓存文件名那一套（`ttsKeyMaterial` / `ttsFileName`）随缓存那一档一起退了 ——
//   同步引擎自己还在用 `core/tts-key.ts`，所以那个文件留着，只是这一端不再引它。
export { ttsText } from '../nyx-core/src/core/tts-key.ts'

/* ══ 朗读顺序（D-466）· 判据进 core，执行留平台 ══════════════════
   「用谁读 · 谁不行换谁」由 `resolve()` 一份排出来，**预算的执行也在 core**
   （`runVoicePlan` 里那句 `Promise.race` 就是「词典慢查不许阻塞系统音」的判据本体）。
   这一端只剩两个执行器：`db/tts.ts`（App）与 `engine/main.ts`（Assist 引擎），
   它们只回答「这一步具体怎么做」；两把开关与写死的先后在 `db/voice.ts`。

   ★ 来源顺序那一整套（`voice/sources.ts` · `providers/*` 注册表与两家云端协议）
     在 core 里已经**没有了**（T-7.10 合回，core `c5cf2a2`）：D-466 撤掉了
     「顺序」这个概念本身 —— 顺序写死成词典 → 系统，库里只存「这一档要不要」。 */
export {
  BOTH_OFF_SAYS,
  DICTIONARY_BUDGET_MS,
  inferVoiceKind,
  resolve as resolveVoice
} from '../nyx-core/src/core/voice/resolve.ts'
export { explain as explainVoice, runVoicePlan } from '../nyx-core/src/core/voice/run.ts'
export type { VoiceRunResult, VoiceStep } from '../nyx-core/src/core/voice/run.ts'
/**
 * ★ 两档的**默认值**与**人看的名字**都从 core 转出来，平台不另写一份：
 *   `DEFAULT_SWITCHES` = 出厂两个都开（使用者原话）；
 *   `SOURCE_LABEL` = 「词典语音」「系统语音」—— 设置页那两行、诊断那一行、
 *   两端的日志读的是同一份字符串，两处各拼一遍迟早会漂成两个说法。
 */
export { DEFAULT_SWITCHES, SOURCE_LABEL } from '../nyx-core/src/core/voice/types.ts'
export type {
  SourceId,
  VoiceAvailability,
  VoiceKind,
  VoiceOrigin,
  VoicePlan,
  VoiceRequest,
  VoiceSwitches,
  VoiceTrace
} from '../nyx-core/src/core/voice/types.ts'

// ── 词典跨设备身份（D2.1 · dict.default 存的就是它）────────────
export { dictUid } from '../nyx-core/src/core/dict/identity.ts'

/* ══ 查询层的翻译（F-017 · 2026-09-01 上提）════════════════════
   这四组**纯字符串常量**此前在两端各有一份，全是逐字抄的。

   ★ 它们不带业务语义，但**决定两台机器算出的数一不一样** ——
     改一边不报错，只会让 Windows 的「今日 39 条」和手机的
     「今日 39 条」开始不同，或者让软删掉的知识点重新进认读队列。
     这正是本项目最贵的事故形态（同一件事有两份判据）的第三例，
     前两例（同步编排、schema）都已经收进 core。 */

// ── 静默与产出适用 · 对应 core/silence.ts 的两个判据函数 ────────
export { PRODUCTION_APPLIES, IS_SILENT } from '../nyx-core/src/core/sql/silence.ts'

// ── 认读卡宏 · 漏掉 JOIN 那半句 = 软删的知识点重进队列，且不报错 ──
export {
  RC,
  JOIN_CARD,
  ALIVE,
  CARD_ACTIVE,
  CARD_DUE,
  CARD_FIELDS
} from '../nyx-core/src/core/sql/reading-card.ts'

// ── 项目栏三层树 · 「哪些看得见、按什么排」是业务规则不是显示细节 ──
export {
  TREE_PROJECTS,
  TREE_UNITS,
  TREE_LECTURES
} from '../nyx-core/src/core/sql/tree.ts'

// ── 回收站扫哪些表 · 这一步会写墓碑，推出去不可撤销 ──────────────
/**
 * ★★ 启动页图片的名字 —— 判据全在 core（2026-09-13 换指针 b54c5da 带进来）。
 *
 * 使用者裁「名字两端同步、以最后一次修改为准、同端多次改名也按这条」之后，
 * 这几样**必须两端逐字一样**，否则：
 *   · `defaultLabel` 不一样 → 没起过名的图两端显示不同名字，**看起来像同步坏了**
 *   · `cleanLabel` 的上限不一样 → 长名字在一端被截短，再同步回去**字就少了**
 * 所以本仓**不留自己那一份**（此前有 `cleanSplashName` / `SPLASH_NAME_MAX` / 自己算的
 * 默认名，2026-09-13 全删）。
 * ★ `pickLabel`（谁赢）**故意不 re-export**：那是引擎内部的判据，
 *   端口这边再调一次就是同一件事两份。
 */
export {
  defaultLabel,
  cleanLabel,
  MAX_LABEL,
  encodeLabels,
  decodeLabels,
  /**
   * ★ `encodeMeta` / `metaKey` —— 桶里那条记录的**线上格式**。
   *   **App 自己不产出它**（产出的是引擎），这里转出来是给用例用的：
   *   `tests/sync-engine.test.ts::S-9` 要往假桶里塞一块真形状的墓碑。
   *   ☞ 不转的话只能在用例里手写 JSON —— 那等于把 core 的线上格式抄一份，
   *     core 改了字段用例还绿着，而它正是这条闸要防的那种漂移。
   */
  encodeMeta,
  metaKey,
  type SplashLabel
} from '../nyx-core/src/core/splash-names.ts'

export {
  PURGE_TABLES,
  TRASH_DAYS,
  /**
   * ★ 屏上那句话也从 core 来（2026-09-13 换指针带进来的）。
   *   在这之前 Android 有 12 处把「30 天」写死在句子里 ——
   *   常量改成 10 之后它们**全部变成假话**（D-412）。
   *   句子跟着常量走，这类漂移就不会再发生。
   */
  TRASH_KEEP_TEXT,
  TRASH_PURGE_TEXT,
  type PurgeTable
} from '../nyx-core/src/core/sql/trash.ts'

/* ══ 单条完整解析（T-7.8 的 core · T-5.12 的 Android 执行器）═══════
   D-R22 之后手机也做单条解析。判据一条都不许在平台层重写：
     · `buildRequest`  把条目事实装配成一次请求（LAYER 的中文全称之类）
     · `planWrites`    AI 响应 → 写入计划（edited 跳过 D-149 · 例句合并 D-150 ·
                       释义回写 R-002 · 空块丢弃 · regen 累加 · 数详情页认得几块 I-112）
     · `NO_FULL_ANALYSIS` 「这一条还没写过完整解析」——「只有 summary 不算」这句话
                       只有这一份翻译，队列与单条判定共用它
   这六条里任何一条在手机上写歪，后果都是**静默的**：他手改的那段被盖掉、
   例句里没了词典来源、或者两台机器对同一条知识点写出不一样的解析。 */
export {
  RENDERED_BLOCKS,
  isRenderedBlock
} from '../nyx-core/src/core/analysis/blocks.ts'
export {
  ANALYSIS_MAX_TOKENS,
  buildRequest,
  type AnalysisRequest,
  // ★ 改名再导出：`core/silence.ts` 里已经有一个不相干的 `ItemFacts`
  //   （静默判定要的那组事实）。同名两份会让调用方引到错的那个而类型还对得上。
  type ItemFacts as AnalysisItemFacts,
  type PromptText
} from '../nyx-core/src/core/analysis/request.ts'
export {
  planWrites,
  type BlockWrite,
  type DictExample,
  type ExistingBlock,
  type GlossWrite,
  type WritePlan
} from '../nyx-core/src/core/analysis/plan.ts'
export {
  ANALYSIS_SCOPE_COND,
  NO_FULL_ANALYSIS,
  type AnalysisScope
} from '../nyx-core/src/core/sql/analysis.ts'

/**
 * 启动页资源：名字规则 + 「选了哪张」的编解码（2026-09-09 · 两端共用一份）。
 * ★ `SplashChoice` 的 `'icon'` 那一档**字面共用、意思按端解释**（CP-14 的正确的不同）：
 *   Windows 画一帧去瓷砖的水獭；Android **不画应用内帧**，落到系统 Splash 那一帧。
 *   出处在 DESIGN_SYSTEM §12.0b，core 的注释里记着行号。
 */
/**
 * 同步音频的文件名判据（D-279 · F-08）—— 端口碰文件系统之前的最后一道。
 * ★ 两端同一份：名字来自云端清单，拼进本地路径之前只认「40 位小写十六进制 + .mp3」。
 */
export { checkAudioName, type AudioNameVerdict } from '../nyx-core/src/core/audio-name.ts'

export {
  SPLASH_EXTS,
  checkSplashName,
  encodeSplashChoice,
  decodeSplashChoice,
  /**
   * ★★ 「他选的那张不在了，屏上该给哪一档画『使用中』」的退法。
   *   本仓 2026-09-14 自己写过一份（`Settings.svelte` 里那个三目），
   *   Windows `73d57b5` 起 core 有了同一件事的判据 —— **本地那份已删，只引这个**（D-238）。
   *   ★ 两份不是一模一样：本地那份无条件退到 `shipped`，core 那份要求
   *     `shipped` **真的在候选里**，否则退到 `icon`。手机上内置两档永远都在，
   *     所以今天两份行为一致；但少了那个条件的是本地那份，不是 core。
   */
  shownChoice,
  type SplashChoice,
  type SplashNameVerdict
} from '../nyx-core/src/core/splash-name.ts'

/**
 * 首次引导（SC-25 · D-483 · 2026-09-15）—— 判据与五步文案**两端一份**。
 *
 * ★★ 为什么连文案都从 core 拿：COPY_RULES CR-7「同一件事两端一个说法」。
 *   写在各端界面文件里必然漂，而**漂了不会有任何东西报错** ——
 *   只会有一天他在手机上看到另一套说法。
 * ★ 形式不同是各端自己的事（D-474）：Windows 五步居中卡、Android 四屏左右滑、
 *   G-5 并进第四屏。**并屏是形式，一个字不改**。
 * ★ `ONBOARDING_KEY` 也从这儿拿：两端同键（`ui.` 前缀是 DEVICE 通道的规则），
 *   手写第二份就等于给「换台设备该不该重看」留了两个答案。
 */
export {
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  /**
   * ★★ 界面要用**这个**，不是上面那份写死的（core 注释原话）：
   *   G-5 标题里「连着答对几次」的那个数**跟着 `param.silenceStreak` 走**。
   *   写死的话，他把出厂 3 改成 2 之后，引导第一次打开就在说假话 ——
   *   而没有任何东西会红：文案没有类型，也没有闸去比这两个数。
   */
  onboardingSteps,
  shouldOnboard,
  type OnboardStep,
  /**
   * ── 第二层：页面内功能引导（使用者 2026-09-15 第二～六条）────
   *
   * ★★ **id 名单只在 core 一份**（`PAGE_GUIDES`）。两端各写各的时，
   *   一端传 `practice-settle`、另一端只认 `B-5` —— `shouldShowGuide` 直接返 false，
   *   **那一端的引导永远不出，而且不报错**。core 注释里点名说这一条
   *   「Nyx-UI-Android 已经把 practice-settle 写进真机了，差点真发生」。
   * ★ 「看过」表 `ui.guide.seen = { id: version }`，走 `ui.` 那条 DEVICE 通道
   *   （存 `settings`、不进 `SYNC_TABLES`），和第一层同一条规矩。
   * ★ `version` 只在**这一条的内容真变**时 +1，+1 之后只重弹这一条 ——
   *   那正是使用者第六条要的「新增功能再引导一次，不是整套重来」。
   */
  GUIDE_SEEN_KEY,
  PAGE_GUIDES,
  guideById,
  noteGuideSeen,
  parseGuideSeen,
  shouldShowGuide,
  type GuideDef,
  type GuideSeen
} from '../nyx-core/src/core/onboarding.ts'

/**
 * 出题规则的七个选项（D-482 · 2026-09-15）—— 理解层三个 · 写作层四个。
 *
 * ★★ 退役的是**输入方式**，不是那段正文：他以前写在 `prompt.reading-card` 里的
 *   整段规则还躺在库里、界面上只读可看，但**不再参与拼装**（core `reading-face.ts:286`
 *   原话「两个真相里只能留一个，而他裁的是『点选项』那一个」）。
 * ★ 拼出来的英文句子逐字在 core：本仓一个字都不许写第二份 —— 写了就是
 *   「同一个 Nyx 在两台机器上出的题不一样，而两边都不报错」。
 * ★ `reading.lastFace`（R-1「轮着来」要的那个数）走 **DEVICE `settings`**
 *   （主控 2026-09-15 改判，理由：进同步表就得加列，结构指纹一变两端就得协调升库）。
 */
export {
  QUIZ_RULE_KEYS,
  READING_RULES_FACTORY,
  PRACTICE_RULES_FACTORY,
  readingRulesOf,
  practiceRulesOf,
  FACE_PICK_SAYS,
  READING_HINT_SAYS,
  PRACTICE_HINT_SAYS,
  CONTEXT_SPREAD_SAYS,
  CONTEXT_SPREAD_LINES,
  /**
   * ★★★ D-486 · 三层真补齐那两格（2026-09-15 使用者「确认单按推荐」）：
   *   产出多出「牌面」（`practice.face` 整块 / 分栏 / 专注）
   *   认读多出「题型」（`reading.qtype` 翻卡自评 / 先写再翻 / 限时认读）
   * 名字、说明、出厂值、宽容读法全在 core 一份 —— 屏上字也在（CR-7：两端一个说法）。
   *
   * ★ `matchesTerm`：`write` 那一档「先写再翻」的逐字比对判据。**不调 AI**，
   *   两端同一把尺；各写一份的话同一个答案在两台机器上一个算对一个算错。
   * ★ `capReadingGrade`：「提前拿到了帮助（看过中文 / 超时）→ 这一次最高第 2 档」。
   *   它同时收掉了 `Reading.svelte` 里那个写死的 `PEEK_CAP = 2` ——
   *   两处各写一个 2，哪天改一处另一处不动，而两处都说得通、都不报错。
   */
  PRACTICE_FACE_FACTORY,
  PRACTICE_FACE_SAYS,
  READING_CAP_GRADE,
  READING_QTYPE_FACTORY,
  READING_QTYPE_SAYS,
  capReadingGrade,
  practiceFaceOf,
  readingQTypeOf,
  type PracticeFace,
  type ReadingQType,
  // ★ D 补（2026-09-15）：P-0 要拿这两句逐字比「真发出去的那段字」
  FULL_SENTENCE_LINE,
  MATCH_REGISTER_LINE,
  buildPracticeRules,
  practiceGlobalLines,
  practiceHintLines,
  joinLines,
  parseLastFace,
  noteLastFace,
  LAST_FACE_MAX,
  type ReadingRules,
  type PracticeRules,
  type FacePick,
  type ReadingHint,
  type PracticeHint,
  type ContextSpread
} from '../nyx-core/src/core/quiz-rules.ts'
