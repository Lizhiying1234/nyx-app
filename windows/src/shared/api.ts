/** 主进程与界面层之间的契约。界面层能做的事，全部在这里登记（D-258 / D-264）。 */

import type { VoiceTrace } from '../core/voice/types.ts'
import { SILENCE_FILTER_NAME } from '../core/silence.ts'

/**
 * ★★ 「找不到这条知识点」—— **七处各写一遍**，收成一份（R-07，2026-09-15）。
 *
 * ★ 顺带去掉了后面那个 `（id=123）`：那是**数据库主键**，
 *   对他没有任何用处，而且是内部编号露到屏上。要定位那一条，
 *   日志里有；屏上这句话只需要说清「这一条没了」。
 */
export const ITEM_NOT_FOUND = '找不到这条知识点'

export interface SelfTest {
  ok: boolean
  /**
   * 这一份软件是从哪个提交、什么时候打出来的。
   *
   * 来历：我说「拖拽修好了」，他说「拖拽的不行」—— 两句都对，
   * 因为他手上是 03:58 的包、修复是 04:17 写的。
   * 「我改的那份」和「他运行的那份」之间必须有一条看得见的连线。
   */
  build: { commit: string; subject: string; builtAt: string; dirty: boolean }
  sqliteVersion: string
  schemaVersion: number
  targetVersion: number
  journalMode: string
  electron: string
  node: string
  chrome: string
  counts: Record<string, number>
  paths: {
    root: string
    data: string
    backups: string
    logs: string
    prompts: string
    resources: string
    db: string
  }
}

/**
 * ★★ F-2-① · `analyzing` **不在这里面**。
 *
 * 「正在分析」是运行事实，不是这一讲的业务状态。它以前占着 `status` 那一格，
 * 写进去就把真实状态销毁了 —— 崩溃之后只能靠 `due_at` 猜回来（F-2）。
 * 界面从来没读过它（渲染层零处引用，进度条走组件自己的状态）。
 *
 * `silent` 不是库里的值，是 `repo` 合成的显示值（`silent=1` 时覆盖 status）。
 */
export type LectureStatus = 'empty' | 'review' | 'training' | 'silent'

export interface LectureBrief {
  id: number
  name: string
  status: LectureStatus
  dueAt: number | null
  itemCount: number
  unitName?: string
  projectName?: string
}

export interface TreeProject {
  id: number
  name: string
  color: string
  pinned: boolean
  units: { id: number; name: string; lectures: LectureBrief[] }[]
}

export interface MaterialRow {
  id: number
  /** original = 交给 AI 扫描的原文；chunk = 我自己整理好的表达（R-001） */
  kind: 'original' | 'chunk'
  title: string
  origin: string
  charCount: number
  analyzedAt: number | null
}

export interface ItemRow {
  id: number
  term: string
  gloss: string
  glossZh: string
  /** A = 被动词汇（只走认读线）· B = 主动词汇（两条线都走） */
  layer: 'A' | 'B'
  kind: string
  /** ai / self / both（双方共识 · D-044） */
  source: 'ai' | 'self' | 'both'
  confidence: number
  recollected: number
  productionState: 'new' | 'training' | 'hard' | 'silent'
  /**
   * 「因为什么而不再轮转」（D-485）。`'earned'` = 练成的；
   * `'self' / 'lecture' / 'unit' / 'project'` = 他收起来的；`null` = 老数据。
   * ★ 界面**不要自己判**这几个值 —— 过 `core/silence.ts` 的 `silenceKind()`。
   */
  silencedBy: string | null
  streak: number
  attempts: number
  corrects: number
  cardSilent: boolean
  /** 原文出处 · M-012 不可丢失 */
  quote: string | null
  /**
   * 6.2 · 分析判定这条「打错了 / 听岔了，需要修改」。
   * 列表上显示一个小记号；他改完（或忽略）之后记号自己消失 ——
   * 不另设「已处理」位，因为两个位一定会有对不上的时候。
   */
  hasSuspect?: boolean
  /**
   * 析出项指回它的母句 · D-056 / D-148。
   * null = 它自己就是一条独立条目（AI 从原文提取的，或者我收集的整句）。
   */
  derivedFrom: number | null
  /** 这条整句被析出了几个成分 —— 只对我收集的原句有意义（D-148 整句拆解） */
  derivedCount: number
}

export interface LectureDetail {
  lecture: LectureBrief
  materials: MaterialRow[]
  items: ItemRow[]
}

export interface ChunkResult {
  materialId: number
  added: { id: number; term: string }[]
  /** D-026 · 重复收集即攻坚。手动收集一条已在库中的表达 = 上一次「学会」是假的 */
  repeats: {
    term: string
    priorItemId: number
    wasSilent: boolean
    times: number
    note: string
  }[]
}

// ── AI ──────────────────────────────────────────────────────────

export type Slot = 'heavy' | 'light' | 'long'
export type Protocol = 'openai' | 'anthropic' | 'gemini'

/** D-205 · 统一四种失败态（另加 format：拿到了 200 但内容不对） */
export type FailureKind = 'offline' | 'auth' | 'quota' | 'server' | 'format'

export interface Failure {
  kind: FailureKind
  title: string
  detail: string
  actions: ('retry' | 'settings' | 'switchSlot' | 'removeMaterial')[]
  consecutive: number
}

export interface SlotSettings {
  baseUrl: string
  model: string
  protocol: Protocol | 'auto'
  /** 界面永远拿不到 key 本身，只知道配没配（D-220） */
  hasKey: boolean
}

export interface AiSettings {
  split: boolean
  slots: Record<Slot, SlotSettings>
}

export interface SaveAiInput {
  split: boolean
  slots: Record<
    Slot,
    { baseUrl: string; model: string; protocol: Protocol | 'auto'; apiKey?: string }
  >
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  protocol: Protocol
  models: string[]
  note?: string
}

export interface AnalyzeStage {
  name: 'reading' | 'extracting' | 'merging' | 'done'
  materialIndex: number
  materialTotal: number
  title: string
  note: string
}

export interface AnalyzeResult {
  lectureId: number
  total: number
  done: number
  added: number
  /** 从「我自己收集的句子」里析出的成分 · D-016 / D-056 */
  derived: number
  upgraded: number
  repeats: {
    term: string
    priorItemId: number
    wasSilent: boolean
    fromOtherLecture?: boolean
    note: string
  }[]
  failures: { materialId: number; title: string; failure: Failure }[]
  /**
   * 4.1 · 因为「以前删过 / 静默过」而**没有收进来**的表达。
   * 必须报出来：少收了几条而不说，他会以为分析漏了东西，
   * 而这恰恰是他自己以前的决定在起作用。
   */
  skipped: { term: string; verdict: string }[]
  /**
   * ★ I-115 · 哪几份材料的回复**被截断**了，以及从里面救回了多少条。
   *
   * 截断 = AI 写到输出上限被切断。以前这会让整份材料判失败、
   * 已拿到的几十条一起丢；现在照常收下，但**必须报出来** ——
   * 少收了一半而不说，他会以为这篇文章就这么点东西。
   */
  truncated?: { title: string; got: number }[]
  /** I-046 · 挑出几处疑似打错 / 听岔。原句一个字没改 */
  suspects?: number
  /** I-043 · 分析时顺手写好了几条完整解析、几条没写成 */
  analysed?: number
  analyseFailed?: number
  /**
   * 这次用的提示词是哪一层来的（`main/ai/prompts.ts::Prompt.source`，I-157 起有三种）。
   * ★ 今天 `analyze-material` 不在可覆盖名单里，所以实际取不到 `override` ——
   *   类型仍然跟着 `Prompt['source']` 走：**不在这里另立一份窄的**，
   *   否则哪天它进了名单，编译过、显示错。
   */
  promptSource: 'override' | 'file' | 'builtin'
  /** 这次用的是哪个预设 —— 结果不一样时要能回溯是不是因为换了指令 */
  presetName: string | null
}

/**
 * 分析预设 · 按材料给临时指令
 *
 * 分工：`prompts/*.md` 是**基线**（记事本可改，管全局，D-213）；
 * 预设的 `extra` 是在基线之后**追加**的一段话，管这一次分析。
 */
export interface PresetRow {
  id: number
  name: string
  target: string
  extra: string
  /** 内置的三个起手预设。可以改、可以删 —— 它们是例子，不是规定 */
  builtin: boolean
}

/** 组装后的完整提示词，只读展示 —— 让你知道到底发出去了什么 */
export interface AssembledPrompt {
  system: string
  userTemplate: string
  /**
   * 与 `main/ai/prompts.ts::Prompt.source` **同一个字段、同一份取值**（I-157 起三种）。
   * ★ 这里窄一格的代价很具体：`AnalyzePanel` 那行诊断照着它写二分，
   *   覆盖命中就会被显示成「内置副本」—— 而它其实是他自己改的那份。
   */
  source: 'override' | 'file' | 'builtin'
  /** `override` 时是偏好键 `prompt.<name>`，另外两种是磁盘路径 */
  path: string
}

// ── 学习流程 ────────────────────────────────────────────────────

/** 认读卡 · D-093：正面 = 挖空原句 + 三行提示，反面 = 目标表达 */
export interface CardRow {
  id: number
  term: string
  gloss: string
  glossZh: string
  layer: 'A' | 'B'
  quote: string | null
  nuance: string | null
  /** 四档各自的下次间隔 · D-136 —— 让自评带上代价 */
  intervals: Record<number, number>
}

/**
 * ★★ 认读测试的设置面 · D-479（使用者 2026-09-08）：**牌面（多选）+ 出题规则（一份）**
 *
 * 上一版是一张「五份整段提示词选一份」的名单（`ReadingPromptState`）。
 * 两件正交的事粘成一串：想「挖空 + 英文释义都要」就得再写第六份整段提示词，
 * 而那第六份会把规则再抄一遍 —— 抄错一个字，两份的红线就不一样了。
 */
export interface ReadingFacesState {
  /**
   * 牌面：他排的顺序 + 勾没勾。`says` 是「这一面给他看什么」，界面直接显示。
   * ★ `custom` = 他自己建的那一面（使用者 2026-09-14 第一条）——
   *   界面靠它决定给不给「改 / 删」；出厂那四面不给删（它们是底线）。
   * ★ `guide` 只有自建那几面带回来：出厂四面的正文在 core 里，界面不该也不需要看见。
   */
  faces: { id: string; name: string; says: string; on: boolean; custom: boolean; guide?: string }[]
  /**
   * ★★ 出题规则的三个选项（D-482，2026-09-15 起）。
   *   以前这里是一整段正文，他要自己写；现在是点选项，正文那条路退役。
   */
  options: ReadingRules
  /**
   * ★★ D-486 · 认读的**题型**：他拿到这张牌面之后要做出什么动作（翻卡自评 / 先写再翻 / 限时认读）。
   *   **单独一个字段，不塞进 `options`** —— `options` 是拼提示词用的，
   *   而这一项一个字都不进提示词（它只动这一侧的交互，AI 那边一个字不改）。
   */
  qtype: ReadingQType
  /**
   * ★ 他**以前写过**的那段出题规则正文；出厂原样（或没设过）就是 `null`。
   *   只读展示用 —— 它不再参与出题（两个真相里只能留一个）。
   *   库里那一行一个字没删（D-216）。
   */
  legacy: string | null
}

export interface ReadingResult {
  intervalDays: number
  silenced: boolean
  reason: string
}

export interface QuestionRow {
  id: number
  type: string
  prompt: string
  context: string
  reference: string | null
}

export interface GradeResult {
  /** 四档语用刻度 · D-119 */
  grade: number
  /** 第 3、4 档算正确；第 2 档算失败 · D-133 */
  passed: boolean
  note: string
  why: string
  /** 标在使用者自己的句子上 · D-120 / M-020 */
  annotations: { span: string; label: string; problem: string; fix?: string }[]
  /** D-122 · 第一次不给范文，改到过关才给 */
  reference: string | null
  /** 只有第一次判定才推进进度 · D-121 / M-019 */
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

export interface Settlement {
  lectureIds: number[]
  sample: number
  distribution: Record<number, number>
  accuracy: number
  silenced: string[]
  hard: string[]
  /** 每讲各算各的间隔 · D-139 —— 今日练习会跨好几讲 */
  perLecture: { lectureId: number; name: string; reason: string; nextDays: number }[]
  /** F-05 · 还有几张认读卡到期 —— 把两条线接上的位置 */
  dueReadingCount: number
  /** D-127 · 一句 AI 总评，横向看这一轮 */
  summary?: string | null
}

/** 今日练习的匹配结果 · D-027 半数规则 */
/**
 * 「开始学」为什么没放行 · ★★ F-2-②-e
 *
 * 进轮转的门槛是 `status='review' ∧ silent=0 ∧ 没删`。
 * 四种不满足各有各的下一步，不能糊成一句话。
 */
export type StartLearningRefusal =
  /** 已经在轮转中 —— 间隔和排期一个字都没动 */
  | 'alreadyRunning'
  /** 已归档（silent=1）—— 归档的讲不排期，先去静默知识库取消归档 */
  | 'archived'
  /** 还不是待审阅（empty 之类）—— 先分析出内容 */
  | 'notReviewed'
  /** 找不到，或者在垃圾箱里 */
  | 'missing'

/**
 * 「这批我看过了 · 开始学」的结果 · F-03 / ★★ F-2-②
 *
 * 界面要拿它说清楚**这一讲接下来会怎样** —— 排期变了要说，
 * 没变更要说（「重新分析不会把你练出来的进度清零」是他最需要知道的一句）。
 */
export interface StartLearningResult {
  /** 下一次产出练习的日子 */
  dueAt: number
  /** 这一讲的间隔（天）。★ F-2-② 之后：有历史就是原值，不再无条件打回 1 */
  intervalDays: number
  /** 这一讲一共几条知识点 */
  count: number
  /** 这一次拿到首次认读资格的条目数（老条目不算 —— 它们有自己的认读历史） */
  fresh: number
  /**
   * ★★ F-2-②-e · 没放行的话，是**哪一种**没放行。`null` = 真的开始了。
   *
   * 以前这里是一个 `alreadyRunning: boolean`，于是「已归档」也会被说成
   * 「这一讲已经在轮转中」—— 他照着那句话去轮转里找它，永远找不到。
   * 拒绝的理由必须和真实原因对得上，否则他下一步一定走错。
   */
  refused: StartLearningRefusal | null
  /** 排期为什么是这样 —— 直接显示给他看 */
  reason: string
}

export interface TodayPlan {
  target: number
  total: number
  /** 为什么停在这个数 —— 界面要答得出「为什么今天是 39 条不是 35 条」 */
  reason: string
  lectures: { lectureId: number; dueAt: number; pending: number; name?: string }[]
}

/**
 * 产出练习的范围。
 *   lecture —— 从工作台进，练这一讲
 *   today   —— 从首页进，按半数规则凑了好几讲（D-027）
 *   hard    —— 从攻坚区进，练卡住的那些（D-025 / D-134）
 */
export type PracticeScope =
  | { kind: 'lecture'; lectureIds: number[] }
  | { kind: 'today'; lectureIds: number[] }
  | { kind: 'hard' }
  /**
   * 从知识库筛选后测试（D-012）。
   * **计入条目正确次数，但不改 lecture 间隔**（D-164）—— 条目进度与讲次排期解耦。
   */
  | { kind: 'items'; itemIds: number[] }
  /**
   * I-061 · 随时测。**不看到期日、不看状态**，可乱序。
   * 判分照常走 SM-2（练了就算数），但要不要练由使用者决定。
   */
  | { kind: 'test'; lectureIds: number[]; shuffle: boolean }

/** 机制参数 · D-179 —— 改过的标「已偏离默认值」，可一键还原 */
export interface ParamRow {
  key: string
  label: string
  unit: string
  value: number
  def: number
  min: number
  max: number
  /** true = 常用项放在上面，false = 收进「高级」折叠区 */
  common: boolean
  note: string
  ref: string
  changed: boolean
}

export interface DataInfo {
  paths: { root: string; data: string; backups: string; logs: string; prompts: string; db: string }
  dbBytes: number
  backups: { name: string; bytes: number; at: number }[]
}

/**
 * 语音 · D-466（使用者 2026-09-07「语音设置简化」）—— **两个开关 + 口音 + 语速**
 *
 * 「读什么、用谁读」以前有一整页：来源顺序、提供者清单、地址、密钥、模型、音色、
 * 缓存计数。D-466 把那条线整条撤了 —— 词典有原生语音就用词典，没有就用系统语音，
 * 系统语音是通用兜底，两个开关默认都开。
 */
export interface TtsSettings {
  /** 词典自带的原生发音（真人录的，已经在他硬盘上）。出厂开着 */
  dictionary: boolean
  /** 设备 / 系统自带的 TTS。出厂开着，它是通用兜底 */
  system: boolean
  accent: 'en-GB' | 'en-US'
  /** D-040 · 0.7×–1.3× */
  rate: number
}

export interface TtsResult {
  /**
   * 谁读的。★ 界面**不该按它分支** —— 有 `data` 就播字节，没有就用系统语音
   * （见 `renderer/speak.ts`）。唯一的例外是 `none`：那一次点击**不出声**，
   * 只把 `note` 说出来（D-466：两个开关都关时不许静默）。
   */
  engine: 'system' | 'dictionary' | 'none'
  /** base64 的音频。界面在 http:// 源下加载不了 file://，所以字节直接带回来 */
  data?: string
  /**
   * ★★ T-7.12 · `data` 那段字节**真实的 MIME**（`core/dict/media.ts::mimeOf`）。
   *
   * 以前渲染层写死 `data:audio/mpeg` —— `.ogg` / `.wav` / `.m4a` 这些放得响的
   * 也会被浏览器拒掉，而拒掉的样子和「这个词没有发音」一模一样（I-165）。
   */
  mime?: string
  accent: string
  rate: number
  /** 用的不是词典音时说清为什么 —— 不静默降级 */
  note?: string
  /** 这一趟的**运行账本**。设置页拿它显示「上次朗读走了谁、为什么」 */
  trace?: VoiceTrace
}

/** 云同步 · D-201 —— API key 不参与同步，词典不参与同步 */
export interface SyncStatus {
  kind: 'off' | 'webdav' | 'supabase'
  url: string
  user: string
  /** 界面永远拿不到密码本身，只知道配没配 */
  hasSecret: boolean
  device: string
  lastAt: number
  lastNote: string
  /** I-042 · 开机自动同步 */
  auto: boolean
  /** 还有多少行没推上去 */
  pending: number
  /** 连续失败了几次（成功清零）—— D-373 数据安全通知的判据 */
  failStreak: number
  /**
   * ★★ R-4-D · 上一次同步没做成的那些。空 = 上一次全好了。
   *
   * 它是**状态**，不是一次调用的返回值 —— 开机自动同步失败之后，
   * 他下次打开设置页要看得见，而那时候早就没有那次调用了。
   */
  problems: SyncProblem[]
}

/** ★★ R-4-D · 同步没做成的一件事 */
export interface SyncProblem {
  /** `row` = 某一行写不进去（那个包不会进 applied，下次重来）· `run` = 整次同步失败 */
  kind: 'row' | 'run'
  what: string
  message: string
  chunk?: string
}

export interface SyncRun extends SyncStatus {
  /** 有冲突时停在这里，什么都没写 —— 等使用者选（D-201 不静默覆盖） */
  conflictNote?: string
  /**
   * ★★ R-4-E · 四个数各说各的，不再糊成一个。
   *
   * 以前 `applied` 报的是 `rows.length`（**尝试数**）——
   * 一行写不进去，界面照样说成功，两台设备从此永久差一行。
   */
  /** 真正落库的行数 */
  applied: number
  /** 云端包里一共读到几行 */
  received: number
  /** 判成不用动的（两边一样、或本地更新） */
  skipped: number
  /** 写不进去的。**它们所在的包没进 applied，下次会重来** */
  failed: number
  /**
   * ★★ R-4-F · 两边都改过、**在等他裁决**的行数。
   *
   * 它既不是 `skipped`（那是「有意没写、没什么可试的」），也不是 `failed`
   * （那是技术上写不进去）。冲突行不写 = 不静默覆盖（D-201），
   * 但**别的行照常同步** —— 一个冲突只挡它自己。
   */
  conflicted: number
  /** 这一次推上去几行 */
  pushed: number
  /** ★ R-4-B · 这一次没装下、留给下一次的行数 */
  leftOver?: number
  /** 诊断用：这次看了几个变更包、里面共几行、用的是哪个水位 */
  seen?: number
  chunks?: number
  wm?: number
  /**
   * ★★ R-4-C-a · 拉这一侧分了几批、单批最多装过多少行。
   *
   * 内存不直接量（CI 的 RSS 受 GC 时机影响，量出来是噪声）——
   * 量的是它的直接因：**任何一批都不许超过当批的行上限**。
   * 只作诊断与验收用，界面不显示。
   */
  batches?: number
  maxBatchRows?: number
  /**
   * ★★ Step 1A · 这一次有几个变更包**整包被拒**（结构或协议版本对不上）。
   *
   * 它和 `failed` 是两回事：`failed` 是「想写、写不进去」，
   * 这一栏是「**根本没打开**」—— 结构对不上时逐行去收会悄悄丢字段（D-268）。
   * 被拒的包**不进 `applied`**，两端版本一致之后会自动重来。
   */
  rejected?: number
  /** 被拒的包各自的原因，给设置页和体检用 */
  rejections?: { chunk: string; code: string; reason: string }[]
  /** 这一次按 legacy 路径处理了几个老包（没有版本头的） */
  legacyChunks?: number
}

/** 本地词典 · D-151 / D-234 */
export interface DictRow {
  id: number
  bookname: string
  ifoPath: string
  folder: string
  wordCount: number
  enabled: number
  sortOrder: number
  /** 文件不在了（移动硬盘拔了之类）。**不删记录**，等它回来 */
  missing: number
  /** 装不起来的原因（LZO 压缩、文件不完整、加密…）。能用就是 null */
  problem?: string | null
}

import type { SplashChoice } from '@core/splash-name.ts'
import type { ColorMode, ColorTokens } from '@core/design/colors.ts'
import type { RichDictionaryEntry } from '@core/dict/entry.ts'
import type { LibraryState } from '@core/library-state.ts'
import type { PracticeFace, PracticeRules, ReadingQType, ReadingRules } from '@core/quiz-rules.ts'
import type { AnalyticsView } from '@core/analytics/index.ts'

export interface DictEntry {
  bookname: string
  /** 实际命中的词目。bear the brunt of 查不到时会退到 brunt，界面要说清查的是哪个 */
  headword: string
  text: string
  /**
   * 跳过来的路径 · D3（2026-08-19）。`['children']` = 从 children 跳到了这里。
   *
   * ★ MDict 用 `@@@LINK=` 做变体重定向（实测 OALD10 抽样 79%、朗文6 81% 的词目是跳转）。
   *   D3 之前这条跳转记录被当成正文交出去了 —— 他真的会在屏幕上看到 `@@@LINK=child`。
   *   现在跟到底，并把跳过的路记下来。
   */
  redirectedFrom?: string[]
}

/**
 * 悬浮词典卡片要的那一份 · 2026-08-16
 *
 * 和 `DictEntry`（多本并列，词条详情页在用）分开：卡片一次只显示**一本**。
 * 两种用法各走各的，谁都不用迁就谁。
 */
export interface DictCard {
  /** 他选中的那串字 */
  word: string
  /** 真正查的那个词目 —— 选中一整段时，卡片上要显示的是它 */
  headword: string
  /** 当前这本。一本可用的都没有时是 null */
  book: { id: number; name: string } | null
  /** 还有哪几本也收了这个词（给选择器用，让他一眼看出换哪本有内容） */
  others: { id: number; name: string }[]
  phonetic?: string
  /** 抽得出来的前几条释义。抽不出就是空的 —— 那时界面直接显示 raw */
  senses: { pos?: string; gloss: string }[]
  /** 词典原文，一个字不删。滚动区显示它 */
  raw: string
  /** 跳过来的路径 · D3。`['children']` = 从 children 跳到了这里 */
  redirectedFrom?: string[]
  /**
   * 这个词查坏了的原因 · D3。**只在查不到正文、而且原因不是「没收这个词」时才有。**
   *
   * ★ 实际会出现的就一种：这本词典里的跳转坏了（转圈 / 跳太多 / 指向不存在的词目）。
   *   不说的话界面只会显示「里没有这个词」—— 而那是假话：词目就在那儿，
   *   是它指向的地方出了问题。他会去怀疑软件，而不是那本词典。
   */
  diagnostic?: { status: string; says: string } | null
  /**
   * 他设的默认词典现在用不了（停用 / 拔了硬盘），临时换了一本 ——
   * 这里放**他原本要的那本**的名字，卡片上说一句。**设置没有被改**。
   */
  fellBackFrom: string | null
}

/**
 * 富词条卡片要的那一份 · D4（2026-08-20）
 *
 * ★ `entry` 是 `RichDictionaryEntry`（`@core/dict/entry.ts`）——
 *   界面层可以直接用 core 里的纯类型（D-238：那边不碰数据库、不碰 AI）。
 * ★ `html` 是**消毒过**的词典原文，只能进 Shadow DOM。
 * ★ `refs` 里全是**引用**，不是路径 —— 渲染层从头到尾不知道文件在哪。
 */
export interface RichCard {
  word: string
  book: { id: number; name: string; uid: string | null } | null
  others: { id: number; name: string }[]
  fellBackFrom: string | null
  entry: RichDictionaryEntry | null
  html: string
  refs: { audio: string[]; image: string[] }
  styleRef: string | null
  /** 结构一条都抽不出来时的退路：老那条路抽的释义 */
  plain: boolean
  diagnostic: { status: string; says: string } | null
  /** 命中的画像（没有就是 null）—— 「这份结构可信到什么程度」 */
  profileId: string | null
}

/** 一条资源换回来的东西。取不到就老实说为什么 —— 不许静悄悄给个空的 */
export type DictResource =
  | { ok: true; kind: string; mime: string | null; dataUrl: string }
  | { ok: false; why: string }

/** I-037 · 从文件里读正文。PDF 是尽力而为，读完一定先给使用者过目 */
export interface ReadDoc {
  title: string
  text: string
  kind: 'text' | 'markdown' | 'docx' | 'subtitle'
  chars: number
  note?: string
}

/**
 * ★ `FetchedPage` 删了（I-180，使用者 2026-09-14 裁）—— D-068「链接抓取」整条没了。
 *   它只被 `main/ingest.ts` 用过，而那个模块**没有任何人 import、界面上也没有入口**：
 *   实现还在、路却早就断了。留着一个没有实现的类型，下一个人会以为这功能还在。
 *   ★ 别和下面 `ingest.pickFile` 弄混：那是**文件选择器**（I-037），同名不同物，还活着。
 */

/**
 * ★ D-467（2026-09-07）· `Assessment` / `ProfileFacts` / `DiagnosticQuestion`
 * 三个类型删了 —— 使用者取消了「我的水平」整块（事实表单 + AI 评估 +
 * 冷启动诊断题 + 历史）。`assessments` / `profile_facts` 两张表**留着不读**
 * （D-216 只增不删；它们仍在同步名单里，手机本来就不显示，D-348）。
 * 判层与出题用的那一行水平改成固定基线 `@core/level-baseline.ts`。
 */

/**
 * 分析报告 · D-043 / D-467
 *
 * ★ D-467（2026-09-07）· 原来的六块收成三块：④ lecture 轮转 · ⑤ 练习密度 ·
 *   ⑥ 两条线的量级对照**删了**（前两块与证据层的「学习时间线与时段密度」重复，
 *   两条线与「认读 / 产出表现」重复）。`main/report.ts` 里给它们算的三个函数
 *   一起删 —— 留着算而界面不画，就是每开一次报告白跑三趟查询。
 */
export interface ReportData {
  from: number
  to: number
  days: number
  /** ① 知识流向：每天每条主动词汇处在哪一态 */
  flow: { at: number; new: number; training: number; hard: number; silent: number }[]
  /** ② 产出正确率趋势。只算第一次判定（D-121） */
  accuracy: {
    points: { at: number; rate: number; sample: number }[]
    overall: number
    firstHalf: number
    secondHalf: number
    sample: number
  }
  /** ③ 攻坚区进出 —— 看净值（O-204：入口快过出口就会越积越多） */
  hardFlow: { entered: number; left: number; staying: number; net: number; byRepeat: number }
}

// ── 搜索 / 垃圾箱 / 项目页 ──────────────────────────────────────

/** D-106 · 覆盖知识点 + 名称 + 原文摘句，**不搜 AI 对话与解析正文** */
export interface SearchResults {
  query: string
  items: {
    id: number
    term: string
    gloss: string
    layer: 'A' | 'B'
    /** ★ I-204 · 判静默要用它（`isRowSilent` 里的 `productionApplies`），不是装饰 */
    kind: string
    productionState: 'new' | 'training' | 'hard' | 'silent'
    cardSilent: boolean
  }[]
  quotes: { itemId: number; term: string; quote: string; lecture: string | null }[]
  places: { id: number; name: string; kind: 'project' | 'unit' | 'lecture'; parent: string | null }[]
  files: { id: number; title: string }[]
}

/** 垃圾箱里的五类对象 · 4.3 加了「单元」 */
export type TrashKind = 'project' | 'unit' | 'lecture' | 'item' | 'file' | 'material'

/** 9.1 · 数据体检的一条发现 */
export interface AuditFinding {
  id: string
  severity: 'error' | 'warn'
  title: string
  /** 违反之后他会看到什么。没有这句就不该有这条检查 */
  impact: string
  count: number
  samples: string[]
}

export interface AuditReport {
  at: number
  findings: AuditFinding[]
  /** 跑了几条检查 —— 一条都没跑却报「没问题」是最坏的结果 */
  checked: number
}

export interface TrashBucket {
  kind: TrashKind
  label: string
  rows: { id: number; title: string; deletedAt: number }[]
}

/**
 * ★ D-475（2026-09-08）· 「项目」总览那一屏整个删了（使用者裁 D-R7 = 3；
 * D-462 ～ D-465 一并作废）。给它用的那四个数据类型（整棵树 / 项目 / 单元 / 讲次
 * 各一个，都带 total / silent / due）跟着删 —— 它们只有那一屏在用。
 * 「一眼看全貌」这件事现在没有专门的屏；跨父搬家走树节点右键「移到…」。
 */

/**
 * ★ D-469（2026-09-07）· `ProjectPage` 删了 —— 项目主页与单元主页取消。
 * 树上的节点只展开 / 收起，**讲次是唯一的内容页**；那两页上的动作
 * （随时认读 / 练习 · 导出笔记）搬进了树节点的右键菜单（D-377），
 * 知识分布矩阵与钻取列表删掉（同一张矩阵综合知识库里还有，`MatrixData` 因此留着）。
 */

// ── 文件学习 · D-115 第二条阅读路径 ────────────────────────────

export interface FileRow {
  id: number
  title: string
  /** D-167 · 未读 / 在读 / 读完，「读完」由使用者手动标记 */
  status: 'unread' | 'reading' | 'shelved' | 'done'
  progress: number
  lectureId: number | null
  lectureName: string | null
  convertedLectureId: number | null
  chars: number
  messages: number
  createdAt: number
}

export interface ChatMessage {
  id: number
  role: 'user' | 'ai'
  content: string
  /** message = 普通对话 · task = 任务卡（D-081） */
  kind: 'message' | 'task'
  /**
   * 历史字段。问题卡的「做完了 / 跳过」已撤（使用者：「看起来没什么意义」）——
   * 界面不再写它，新卡一律停在 'open'。列留着（D-216 只增不删），
   * 以前的数据一个字没动。
   */
  taskState: 'open' | 'done' | 'skipped' | null
  /** D-174 · 任务指向的段落，点了左栏滚过去并高亮 */
  para: number | null
  tutorName: string | null
  at: number
  /** 这条属于哪一边 —— 两个模式的聊天框完全分开（使用者「Enlighten / Quest 交互重构」） */
  mode: 'enlighten' | 'quest'
  /** Quest 里属于第几张问题卡；Enlighten 恒为 null */
  questNo: number | null
}

export interface FileDetail {
  file: {
    id: number
    title: string
    content: string
    status: 'unread' | 'reading' | 'shelved' | 'done'
    progress: number
    lectureId: number | null
    lectureName: string | null
    convertedLectureId: number | null
  }
  messages: ChatMessage[]
  /** D-168 · Findings Tab：从这篇文章捞到的条目 */
  findings: { id: number; term: string; gloss: string; layer: 'A' | 'B' }[]
}

/**
 * AI 导师 · D-098 + R-005
 *
 * 可调项是主体，自由提示词是补充，两者一起组装 ——
 * 「『严谨学术导师』这五个字 AI 会怎么理解谁也不知道，而且每次可能不一样；
 *  『纠错严厉度 8、写完才给答案』是确定的、可复现的。」
 *
 * **导师不影响判分**（D-018 / D-119）：判分必须可复现，换个导师就换个标准
 * 会让进度变成随机数。导师只管对话、任务、讲解的口吻与深度。
 */
/**
 * 体裁 · 5.2 · Quest 按体裁出问题。
 * 结构照着 TutorRow 来 —— 同样能新增、编辑、写提示词。
 */
export interface GenreRow {
  /** ★ 稳定身份 · R-3-h / V27。**不是**自增 id —— 那玩意在两台设备上会撞主键 */
  uid: string
  name: string
  /** 这一体裁该怎么提问。整段进系统提示词 */
  prompt: string
  isDefault: boolean
  builtin: boolean
  sort: number
}

/**
 * 一种产出题型 · 使用者「产出练习题型系统」
 *
 * ★ 2026-09-08（D-478）· **`tier` 没了**：档位机制整个取消。题型现在只有
 * 「有哪几种、他勾了哪几种、按什么顺序」，一次出几道由 `param.questionsPerItem` 定。
 * 库里 `qtypes.tier` 那一列按 D-216 留着（不再读写），所以同步指纹不变。
 * ★ M-027「3 连正确必须跨题型」以前是档位的副产品，现在由
 * `core/qtype-plan.ts::preferDifferent` / `crossesEnoughTypes` 显式保证。
 */
export interface QTypeRow {
  /** ★ 稳定身份 · R-3-h / V27。业务上的身份是 `key`，跨设备的身份是 `uid` */
  uid: string
  /** 稳定标识，落进 `questions.type`。生成之后不再变，改名字不影响历史题目 */
  key: string
  name: string
  /** 一句话：这一题让他干什么。给他看的 */
  brief: string
  /** 内置的英文说明，拼进提示词。他写了 prompt 就用 prompt */
  guide: string
  /** ★ 他自己写的提示词。空 = 用 guide */
  prompt: string
  enabled: boolean
  /** 这一档的兜底：他把这一档全取消勾选时用它 */
  canonical: boolean
  builtin: boolean
  sort: number
}

/** 出题顺序 · 两层（使用者「出题顺序控制」） */
export type OrderMode = 'seq' | 'random'
export interface PracticeOrder {
  /** 第一层：知识点顺序 */
  items: OrderMode
  /** 第二层：题型顺序 */
  qtypes: OrderMode
}

export interface TutorRow {
  id: number
  name: string
  persona: string
  /** 纠错严厉度 0–10 */
  strictness: number
  /** 任务密度 0–10 */
  taskDensity: number
  /** direct 直接给 · after 你写完才给 · hint 只给方向 */
  answerTiming: 'direct' | 'after' | 'hint'
  freePrompt: string
  isDefault: boolean
  builtin: boolean
}

/** 4×4 状态矩阵 · D-158。纵轴产出、横轴认读，与总原型的 RL / CL 一字不差。 */
export interface MatrixData {
  /** [产出档][认读档]，产出 0=静默 1=攻坚 2=训练中 3=未开始；认读 0=新卡 1=学习中 2=成熟 3=静默 */
  cells: number[][]
  /** 橙框那片：认读成熟 × 产出还没毕业 —— 这套方法论瞄准的全部对象 */
  zone: number
  total: number
  max: number
}

/** ★ 两条轴的终点都叫 `SILENCE_FILTER_NAME`（D-489）—— 见 `PRODUCTION_STATE_NAMES` 的理由 */
export const MATRIX_ROWS = [SILENCE_FILTER_NAME, '攻坚', '训练中', '未开始'] as const
export const MATRIX_COLS = ['新卡', '学习中', '成熟', SILENCE_FILTER_NAME] as const

export type LibrarySort =
  | 'random'
  | 'accuracy-asc'
  | 'accuracy-desc'
  | 'stalest'
  | 'streak'
  | 'recent'

export interface LibraryFilter {
  /** all = 综合知识库 · upload = 我的上传库 · silent = 静默知识库 */
  scope?: 'all' | 'upload' | 'silent'
  layer?: 'A' | 'B'
  source?: string
  onlyRepeated?: boolean
  includeSilent?: boolean
  cell?: { row: number; col: number }
  /**
   * ★ 一次筛多格（2026-09-03）—— 为「读得懂 · 产不出」那一行而加。
   * 它不是一个格子，是右侧那一竖列三格之和；而它恰恰是**最该点得动**的那个数：
   * 项目页上白纸黑字写着「读得懂 · 产不出 —— 40 条」，
   * 下一步必然是「哪 40 条」。
   */
  cells?: { row: number; col: number }[]
  /**
   * ★ 按项目 / 单元筛（2026-09-03）
   *
   * 为「点矩阵格子 → 那批到底是哪些条目」而加。项目页和单元页上原来
   * **只有数字，点不动** —— 图告诉你「读得懂产不出 40 条」，
   * 而下一步必然是「哪 40 条」。看得见却点不进去 = 只是装饰。
   *
   * ★ 判据不新写：走 core/sql/item-lectures.ts 的 IN_PROJECT / IN_UNIT，
   *   和矩阵自己数格子用的是同一份 —— 否则格子上写 40、点开列出 43。
   */
  projectId?: number
  unitId?: number
  sort?: LibrarySort
}

export interface LibraryItem {
  id: number
  term: string
  gloss: string
  glossZh: string
  layer: 'A' | 'B'
  kind: string
  source: string
  productionState: string
  /** 见 `ItemRow.silencedBy` —— 过 `silenceKind()` 再用，别自己判这几个字面量 */
  silencedBy: string | null
  streak: number
  attempts: number
  corrects: number
  recollected: number
  cardSilent: boolean
  derivedFrom: number | null
  derivedCount: number
  createdAt: number
  lectureName: string | null
  /** 归属讲次（优先 owner，没有 owner 就取它所在的任意一讲）—— 状态片点下去要用 */
  lectureId: number | null
  /** 6.2 · 需要修改的记号（见 ItemRow.hasSuspect） */
  hasSuspect?: boolean
  /**
   * ★ T-4.10（D-R24）· 这一行的释义位处在哪个状态。
   *   判据在 `@core/library-state.ts` —— **界面不再自己判 gloss 空不空**。
   */
  state: LibraryState
}

/** 词条详情 · D-143 左栏「这个表达是什么」· 右栏「我掌握得怎样」 */
export interface ItemDetail {
  item: {
    id: number
    term: string
    gloss: string
    glossZh: string
    layer: 'A' | 'B'
    kind: string
    source: string
    productionState: 'new' | 'training' | 'hard' | 'silent'
    attempts: number
    corrects: number
    recollected: number
    /** ★ 静默中吗 —— ⋮ 里那颗按钮按它决定是「手动静默」还是「从静默里放出来」 */
    cardSilent: boolean
    cardDueAt: number | null
    derivedFrom: number | null
    lectureName: string | null
    /** 它归属的那一讲 —— 拆出来的单位要收回同一讲（I-045） */
    lectureId: number | null
  }
  /** D-152 · 多处出现全部保留，默认只显示首次 */
  occurrences: { quote: string; para: number | null; material: string | null; lecture: string | null; at: number }[]
  /**
   * D-257 · 逐区块存，edited 的重新生成时跳过。
   * ★ T-9.14 · 多带一个 `updatedAt`：详情页要拿它和 `corrections` 里最近一笔比，
   *   算「这份解析是不是照着改之前的词条写的」（`core/analysis/stale.ts`，两端同一份判据）。
   */
  blocks: { block: string; content: string; edited: boolean; regenCount: number; updatedAt: number }[]
  /** D-148 · 整句拆解（只有我收集的原句才有） */
  derived: {
    id: number
    term: string
    layer: string
    productionState: string
    /** 见 `ItemRow.silencedBy` —— 过 `silenceKind()` 再用 */
    silencedBy: string | null
    streak: number
  }[]
}

/** D-097 / D-127 · 一次调用同时拿到「横向看这一轮」和「纵向看每一条」 */
export interface DiagnoseResult {
  summary: string | null
  diagnosed: number
}

/** 攻坚区一行 · D-097 —— 列表 + 历次作答，那是 D-134 的题面素材 */
export interface HardRow {
  id: number
  term: string
  gloss: string
  attempts: number
  hardEntries: number
  recollected: number
  lectureName: string | null
  /** D-097 · AI 指出的重复错误模式，JSON: {pattern, drill} */
  diagnosis: string | null
  history: { text: string; grade: number; at: number; labels: string[] }[]
}

/**
 * 讲次内重复知识点 —— 扫描结果（T-2.11 / T-4.8）
 *
 * 判据在 `@core/dedup/plan.ts`，这里只是它加上界面要显示的那几列。
 * `bucket === 'review'` 的组**不会**被「一键处理」碰到（策略在主进程，不在界面）。
 */
export interface DedupMember {
  id: number
  term: string
  gloss: string
  layer: string
  createdAt: number
  answers: number
  reviewLogs: number
  /** 分析块的区块名 —— Review 组里给他看差异用 */
  blocks: string[]
}

export interface DedupGroupView {
  /** 归一之后的字面 */
  norm: string
  bucket: 'safe' | 'review'
  /** 进 Review 的理由，一条一句人话；Safe 时为空 */
  reasons: string[]
  /** 判据算出来的主记录；Review 组里他可以另选 */
  canonicalId: number
  /** 第一个是主记录，其余是会被并掉的 */
  members: DedupMember[]
}

export interface DedupReport {
  lectureId: number
  groups: DedupGroupView[]
  /** 受影响的条数（所有组的成员总数，含主记录） */
  affected: number
  safe: number
  review: number
}

/** 要并哪些：`safe` = 判据说安全的全部；`one` = 他在某个 Review 组里自己挑的 */
export type DedupPick =
  | { kind: 'safe' }
  | { kind: 'one'; canonicalId: number; loserIds: number[] }

export interface DedupMergeResult {
  /** 处理了几组 */
  groups: number
  /** 被并掉（软删进回收站）的条数 */
  merged: number
  /** 每张表迁了多少行 —— D-458：给出一个数就要能答是哪些 */
  moved: Record<string, number>
}

export type { SplashChoice } from '@core/splash-name.ts'
export type { ColorMode, ColorTokens } from '@core/design/colors.ts'

/** 一张启动页图片资源。名字 = 内容 sha1 + 扩展名（判据在 core/splash-name.ts）*/
export interface SplashRes {
  name: string
  bytes: number
  /** 文件的 mtime —— 新传的排前面 */
  addedAt: number
}

/**
 * Assist 这一页的全部状态 —— **一份，三处用**。
 *
 * ★ 2026-09-14 之前这个形状在 `get` / `set` / `setLecture` 下面
 *   **各写了一遍**，而且已经漂了：只有 `get` 那份带注释，另两份是裸字段。
 *   这一轮要给它多一个 `kind`，三处都要改 —— 而「三处都要改」正是
 *   下一次只改两处的理由。收成一份。
 */
export interface AssistState {
  /** 现在是哪一档。`off` 也是一档 */
  mode: 'glance' | 'point' | 'off'
  /**
   * ★★ **选的是哪一种**（使用者 2026-09-14 晚：「Point 和 Glance 是两种独立的
   * 功能，不能同时混在一起」）。开着时就是 `mode`；关着时是他上一次选的那一种。
   *
   * 桌面那枚悬浮图标靠它决定「点一下开哪个」—— 他明确说过图标
   * **不负责在两者之间切换**，只负责当前所选模式的开 / 关。
   */
  kind: 'glance' | 'point'
  /** 他自己补的「这些程序里不抓」，逗号分隔 */
  blocked: string
  /** 出厂就拦着的那几个（密码管理器一类），只读 */
  defaults: string[]
  /** 助手进程此刻**真的**在跑吗 —— 屏上那句「正在监听」说的就是它 */
  running: boolean
  /**
   * ★★ Point 那一档的快捷键。**空串 = 没注册上**（被别的软件占了）。
   *
   * ★ 只有 `mode === 'point'` 时它才注册 —— 使用者 2026-09-14 晚：
   *   「当用户开启 Glance 时……不运行 Point。」两种功能不许混在一起。
   * 取词走 UI Automation 的 `RangeFromPoint`（和 Android Assist 的无障碍树同一条路）。
   */
  pointReady: boolean
  /** 桌面上那颗悬浮图标要不要显示（出厂**要**）。关不掉的置顶物件太霸道 */
  bubbleOn: boolean
  /**
   * 收下的东西默认进哪一讲。`null` = 还没设。
   * ★ 契约 §五 第一条「零配置：不问保存到哪」—— 设一次，以后不问。
   * ★ 不同步：讲次 id 是本机库里的行号，同步过去会指到不相干的讲次上。
   */
  lecture: number | null
}

export interface NyxApi {
  win: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
  }
  app: {
    selfTest(): Promise<SelfTest>
    /** H-4a · 只要构建号，不碰数据库 —— 界面炸了的时候这条路必须还能走 */
    buildInfo(): Promise<SelfTest['build']>
    /**
     * B8 · 启动页那张画面的字节（`data:` URI）。
     * **读不出来给 `null`** —— 那时界面画「没图版」（去底的兔子 168px）。
     * 「文件不在 / 读不动 / 格式不认」在界面上是同一件事：回退，绝不白屏。
     */
    splashArt(): Promise<string | null>
  }
  /**
   * ══ 资源 · 启动页（使用者 2026-09-09）════════════════════════════
   * 图片本体两端**共享**（`data/resources/splash/`，跟着同步走）；
   * **选了哪一张各端自己定**（`settings`，不进 `SYNC_TABLES`）——
   * 他 2026-09-09 原话：「win 和 android 可以有不同的启动页，共享的是图片资源」。
   */
  res: {
    /** 资源库里有哪几张。目录不在就是空数组，不报错 */
    listSplash(): Promise<SplashRes[]>
    /**
     * 出厂那张插画的字节 —— **和「当前用哪张」无关**。
     * 设置页要它才画得出那张固定的卡；拿 `app.splashArt()` 代替会让它时有时无。
     */
    shippedSplash(): Promise<string | null>
    /** 一张图的字节（`data:` URI）。读不出来给 `null` */
    readSplash(name: string): Promise<string | null>
    /** 这台机器现在用哪一张 */
    activeSplash(): Promise<SplashChoice>
    /** 换一张。★ 换不成会抛 —— 他刚按了「启用」，不能装作成功了 */
    setActiveSplash(c: SplashChoice): Promise<SplashChoice>
    /** 弹文件框收一张进来。取消 → `null`；格式 / 大小不对会抛 */
    pickSplash(): Promise<SplashRes | null>
    /**
     * 每张图现在叫什么（使用者 2026-09-13）。
     * ★ 名字是**资源的属性**，两端一致；和「选了哪张」正好相反（那是各端自管的）。
     */
    splashLabels(): Promise<Record<string, { label: string; at: number }>>
    /** 起 / 改名字。**传空串 = 去掉名字**，回到默认那句。存不进去会抛 */
    renameSplash(name: string, label: string): Promise<Record<string, { label: string; at: number }>>
    /** 从库里删一张（**彻底删**，界面要先问一句）。删的正好是当前那张就退回出厂 */
    removeSplash(name: string): Promise<void>
    /** 在资源管理器里打开资源目录 —— 他要能自己拖文件进去（D-213 同一条精神）*/
    openSplashFolder(): Promise<string>

    /**
     * ══ 资源 · 颜色模式（使用者 2026-09-13）══════════════════════
     * 一个模式 = 一整套配色。**两端不互相同步**（存 `settings`，不进
     * `SYNC_TABLES`）—— 他原话：「Windows 和 Android 的颜色模式不互相同步，
     * 两端分别管理自己的，配色也不需要完全一样」。
     */
    colorModes(): Promise<{ modes: ColorMode[]; activeId: string; overrides: ColorTokens }>
    /**
     * 整份存回去，返回**真正存下的那一份**（坏值在 core 那道闸上被丢掉了，
     * 界面要按返回值重画，否则屏上显示的和库里存的会不是一回事）。
     * ★ 参数是 JSON 字符串 —— Svelte 5 的 $state 代理不能结构化克隆。
     * ★ 存不进去会抛：他刚按了保存，不能装作成功了。
     */
    saveColorModes(json: string): Promise<ColorMode[]>
    /** 应用某一套；**传空串 = Reset to Default**（回到出厂那套，不存快照）*/
    applyColors(id: string): Promise<{ activeId: string; overrides: ColorTokens }>
  }
  /**
   * ══ 界面偏好（2026-09-13）══════════════════════════════════════
   * 「这台机器上这块屏怎么显示」的小事（第一个是文件学习的字号）。
   * 存 `settings`，**不进 `SYNC_TABLES`** —— 字号是他坐在这台电脑前的习惯，
   * 不是学习数据。键必须 `ui.` 开头（主进程拦着）。
   */
  /**
   * ══ Glance · 选中就查（使用者 2026-09-13）══════════════════════
   * 「正常选中文字后直接自动查词，不需要任何按键。」
   *
   * ★★ **默认关**，而且主进程读不出设置时也当关着 ——
   *   一个「读不出设置就开始监听」的功能不该存在。
   * ★ 抓不抓的判断在 `core/glance.ts`（密码框 · 黑名单 · 长短 · 去重）。
   * ★ 存 `settings`，**不进 `SYNC_TABLES`**：在哪台机器上开着监听是这台机器的事。
   */
  /**
   * ══ 置顶浮窗（使用者 2026-09-13）══════════════════════════════
   * 划词 / 指词 抓到的词画在**这个盖在别的程序上面的小窗口**里 ——
   * 画在主窗口里他根本看不见（那时候 Nyx 在后面），
   * 而把 Nyx 拉到前台会破 `ASSIST_CONTRACT` §五 的「不接管」。
   * ★ 卡本身还是 `DictCard`，换的只是它住在哪个窗口里。
   */
  /**
   * 桌面上那颗悬浮的 Assist 小球（使用者 2026-09-14 晚）。
   * ★ 它只负责**当前所选模式**的开 / 关 —— 不在 Point 和 Glance 之间切换。
   */
  bubble: {
    onState(fn: (on: boolean) => void): () => void
    toggle(): void
    /**
     * 搬一段。★ `dx/dy` 是**从按下算起的累计位移**，`first` 标出按下后的第一步。
     *   为什么不能送增量：见 `main/bubble.ts` 那段 —— 150% 缩放下
     *   「读回 bounds 再加一点」会把位移抹成 0、把误差堆进尺寸里。
     */
    moveBy(dx: number, dy: number, first: boolean): void
    /** 拖完了，记住位置。★ 拖动途中不叫它 —— 那会把一次拖动变成几十次磁盘写 */
    rest(): void
  }
  /**
   * Point 的选区高亮层（使用者 2026-09-14 第三批）。
   * ★ 只有一个方法，而且是订阅 —— 这一层什么都不做，只画。
   */
  marker: {
    onRects(fn: (rects: { x: number; y: number; w: number; h: number }[]) => void): () => void
  }
  overlay: {
    /**
     * @param ocr   这串字是**认出来的**（I-177）—— 卡上要标「可能有误」（D-395）
     * @param empty 这一下什么都没读到 —— 卡照样出来说一句实话，**不许无声**
     * @param note  那一句**由判据给**：黑名单挡掉时说的是「在不抓的名单里」，
     *              不是「没读到文字」—— 后者在那一档是假话
     * @param hint  第二行（可能是空串）
     */
    onLookup(
      fn: (text: string, ocr: boolean, empty: boolean, note: string, hint: string) => void
    ): () => void
    /** 拖卡：搬一段（使用者 2026-09-14 晚）。★ 累计位移，同上 */
    moveBy(dx: number, dy: number, first: boolean): void
    close(): void
  }
  glance: {
    get(): Promise<AssistState>
    set(mode: 'glance' | 'point' | 'off', blocked: string): Promise<AssistState>
    /** 设「收下的东西默认进哪一讲」。传 `null` = 清掉 */
    setLecture(id: number | null): Promise<AssistState>
    /** 桌面上那颗悬浮图标显不显示 */
    setBubble(on: boolean): Promise<AssistState>
    /** 托盘那边改了模式 —— 设置页要跟着重读，否则屏上那一档是旧的 */
    onChanged(fn: () => void): () => void
    /** 抓到一段 —— 已经过完 core 那几道闸了 */
    onHit(fn: (text: string) => void): () => void
    /** 助手进程意外没了。**必须让他知道**：以为开着其实早停了，比关着更糟 */
    onDead(fn: (why: string) => void): () => void
  }
  ui: {
    /** 读不出来给空串 —— **默认值属于界面**，库里没有「默认字号」这个事实 */
    get(key: string): Promise<string>
    /** 存不进去会抛（键不合法 / 库写不动）*/
    set(key: string, value: string): Promise<void>
  }
  data: {
    tree(): Promise<TreeProject[]>
    ensurePath(p?: string, u?: string, l?: string): Promise<number>
    lecture(id: number): Promise<LectureDetail>
    /** 删一份材料 —— 进垃圾箱，不动从它里面提出来的知识点 */
    deleteMaterial(id: number): Promise<void>
    addOriginal(
      lectureId: number,
      title: string,
      content: string
    ): Promise<{ materialId: number; count: number }>
    /** 三层的增改删 · I-032 / I-033 / I-034。数量不设上限（I-041） */
    createProject(name?: string): Promise<number>
    createUnit(projectId: number, name?: string): Promise<number>
    createLecture(unitId: number, name?: string): Promise<number>
    rename(kind: 'project' | 'unit' | 'lecture', id: number, name: string): Promise<void>
    softDelete(kind: 'project' | 'unit', id: number): Promise<{ lectures: number }>
    /** I-034 · 静默这一讲：不再轮转，条目进度一个字不动 */
    silenceLecture(lectureId: number, on: boolean): Promise<void>
    /** I-047 · 三级菜单 */
    setPinned(id: number, on: boolean): Promise<void>
    setSilent(kind: 'project' | 'unit' | 'lecture', id: number, on: boolean): Promise<void>
    /**
     * 6.1 · 拖拽排序。传的是**整个父级下的完整顺序**。
     * 「把 A 挪到第 3 位」那种写法要在两边各算一次，算不一致时
     * 表现为「松手之后跳回去」—— 界面看到什么就存什么最稳。
     */
    reorder(
      kind: 'project' | 'unit' | 'lecture',
      parentId: number | null,
      ids: number[]
    ): Promise<void>
    /** 4.2 · 静默知识库里的「结构」那一半：被静默的项目 / 单元 / lecture */
    silentTree(): Promise<
      { kind: 'project' | 'unit' | 'lecture'; id: number; name: string; path: string }[]
    >
    markUnread(lectureId: number): Promise<void>
    move(kind: 'unit' | 'lecture', id: number, newParentId: number): Promise<void>
    forkLecture(lectureId: number): Promise<number>
    /** 这一支下面全部 lecture —— 测试和导出都按这个范围走 */
    lecturesUnder(kind: 'project' | 'unit' | 'lecture', id: number): Promise<number[]>
    /** 导出这一支的可读笔记（Markdown）。取消返回空路径 */
    exportNotes(kind: 'project' | 'unit' | 'lecture', id: number, name: string): Promise<string>
    /**
     * ★★ 引文匹配（使用者 2026-09-13）· 整讲重配原文出处。
     *
     * 「先收集知识点、当时还没有原文；之后把原文加进来，让每个知识点重新去
     *   匹配原文中正确的句子。」范围是**整讲**（我的收集 / 写作层 / 理解层一起）。
     *
     * ★ 同步、确定性、**不花钱** —— 判据是 `core/quote.ts::findQuoteIn`，
     *   和加原文时自动跑的那条（`backfillQuotes`）是同一条。
     * ★ 找不到**不清空**旧出处；`noText` = 这一讲压根没有原文。
     */
    matchQuotes(lectureId: number): Promise<{
      total: number
      changed: number
      same: number
      missed: number
      noText: boolean
    }>
    /** D-064 第三个入口 · 逐条手动输入。出处可填不可假装 —— M-012 */
    addItem(
      lectureId: number,
      term: string,
      gloss: string,
      layer: 'A' | 'B',
      quote?: string
    ): Promise<{ id: number; layer: 'A' | 'B'; duplicateOf: number | null }>
    addChunks(lectureId: number, title: string, content: string): Promise<ChunkResult>
  }
  ai: {
    /**
     * 查词卡上那颗「问 AI」（使用者 2026-09-13「统一提供：词典 · AI · 语音」）。
     * ★ 用的是名册里已有的 `lookup-search` 提示词（今天改成两端共用）。
     * ★ **不自动跑** —— 自动跑等于他每查一个词就花一次钱。
     */
    /**
     * 查词卡上那颗「问 AI」。**成功就给正文，失败是 reject** ——
     * 和这一档所有 AI 通道同一个形状（主进程那边统一过了 `wrapAi`）。
     *
     * ★ 别在这儿写成 `{ ok, failure }` 那种联合体：主进程根本不返回那个形状，
     *   而这份声明**没人拿主进程校对** —— 写错了 `check:types` 照样绿，
     *   于是成功的那一路被当成失败、把答案丢掉。2026-09-13 真踩过一次。
     * ★ 失败照老规矩接：`catch (e) => cleanMessage(e)`。
     */
    explain(text: string): Promise<{ text: string }>
    /**
     * 词条顶部那两行简短释义（英文默认显示 · 中文默认收起）。
     * 形状同上：成功给内容，失败是 reject。
     * ★ 认不出来的那一半是空串，**不是报错** —— 这两行是附加信息，
     *   缺一行只该那一行不显示，不该把整张卡变成一个错误页。
     */
    brief(text: string): Promise<{ en: string; zh: string }>
    settings(): Promise<AiSettings>
    save(input: SaveAiInput): Promise<AiSettings>
    providers(): Promise<ProviderPreset[]>
    /** 「测试连接」· D-202。成功返回模型原样回声，失败抛出带四种失败态的错误 */
    /** D-207 · 有没有配好到能跑的程度 —— 首页那条配置引导用它 */
    isConfigured(): Promise<boolean>
    testConnection(slot: Slot): Promise<{ ok: true; reply: string; ms: number }>
    analyze(
      lectureId: number,
      extra?: string,
      presetName?: string,
      /** I-082 · 只分析勾中的这几份；不给＝所有没跑过的 */
      materialIds?: number[]
    ): Promise<AnalyzeResult>
    cancelAnalyze(lectureId: number): Promise<void>
    onStage(cb: (s: AnalyzeStage) => void): () => void
  }
  prompts: {
    presets(): Promise<PresetRow[]>
    savePreset(p: { id?: number; name: string; extra: string }): Promise<number>
    deletePreset(id: number): Promise<void>
    lecturePreset(lectureId: number): Promise<{ id: number; name: string; extra: string } | null>
    setLecturePreset(lectureId: number, presetId: number | null): Promise<void>
    /** 看组装后的完整提示词 —— 基线 + 这次的临时指令 */
    assembled(name: string, extra?: string): Promise<AssembledPrompt>
    /** ★ 认读测试的牌面提示词名单（使用者 2026-09-04 · 增删改用都在这一套里） */
    /** ★ D-479 · 认读测试：牌面（多选）+ 出题规则（一份） */
    readingFaces(): Promise<ReadingFacesState>
    /** 存勾选。★ 至少留一面 —— 一面都不勾会被当场拒绝（不兜底、不静默改回全开） */
    saveReadingFaces(list: { id: string; on: boolean }[]): Promise<ReadingFacesState>
    /**
     * ★★ 新建 / 改一个自建牌面（使用者 2026-09-14 第一条）。
     * `id` 空 = 新建；给了就是改那一面。**只能改自建的** —— 出厂四面是两端共用的判据。
     */
    saveCustomFace(face: {
      id?: string
      name: string
      says: string
      guide: string
    }): Promise<ReadingFacesState>
    /** 删一个自建牌面。★ 出厂那四面删不得，传进来会被当场拒绝 */
    deleteCustomFace(id: string): Promise<ReadingFacesState>
    /**
     * ★★ 存一个出题规则选项（D-482）。只递改动的那一项，不递整份 ——
     *   递整份的话，两处同时开着时后存的那次会把前一次的改动写回去。
     */
    saveReadingOptions(patch: Partial<ReadingRules>): Promise<ReadingFacesState>
    /** ★★ D-486 · 存认读的题型（三选一）。和出题规则分开存 —— 它不进提示词 */
    saveReadingQType(v: ReadingQType): Promise<ReadingFacesState>
    /**
     * I-113 · 这次启动对提示词做了什么。
     * `replaced` 是「你改过的那份缺了新功能要用的占位符，已另存并换新」——
     * 这种事必须让他看见，悄悄换掉比不换更糟。
     */
    syncReport(): Promise<{
      updated: string[]
      kept: string[]
      replaced: { file: string; savedTo: string }[]
      /** 他目录里有、这一版不再带的（功能退役留下的）—— 只报不删 */
      retired: string[]
      notes: string[]
    } | null>
    /** 打开 prompts 文件夹，去改基线（D-213） */
    openFolder(): Promise<string>
  }
  params: {
    list(): Promise<ParamRow[]>
    set(key: string, value: number): Promise<void>
    reset(key?: string): Promise<void>
  }
  store: {
    info(): Promise<DataInfo>
    backupNow(): Promise<string>
    openFolder(which: 'data' | 'logs' | 'backups'): Promise<string>
  }
  tts: {
    settings(): Promise<TtsSettings>
    save(s: TtsSettings): Promise<void>
    speak(text: string): Promise<TtsResult>
    /** 上一次朗读走了谁、为什么 —— 设置页那一行诊断读它 */
    lastTrace(): Promise<VoiceTrace | null>
  }
  /** D-231 · 数据在界面之外变了（同步拉下来一批），主进程广播，界面重取 */
  onDataChanged(fn: (info: { from: string; rows: number }) => void): () => void
  sync: {
    status(): Promise<SyncStatus>
    save(c: { kind: 'off' | 'webdav' | 'supabase'; url: string; user: string; secret: string }): Promise<SyncStatus>
    test(): Promise<void>
    setAuto(on: boolean): Promise<SyncStatus>
    run(resolve?: 'remote' | 'local'): Promise<SyncRun>
  }
  dict: {
    list(): Promise<DictRow[]>
    rescan(): Promise<DictRow[]>
    setEnabled(id: number, on: boolean): Promise<DictRow[]>
    reorder(ids: number[]): Promise<DictRow[]>
    /** 悬浮卡片要的那一份：**单本**。不传 bookId 就是当前默认那本 */
    lookupCard(word: string, bookId?: number): Promise<DictCard>
    /** 他在卡片里主动换了一本 —— 主动切换就等于设为默认 */
    setDefaultBook(id: number): Promise<void>
    openFolder(): Promise<void>
    /**
     * ══ 富词条 · D4 ════════════════════════════════════════
     *
     * `lookupCard` **一个字没动**，两条并存：出问题随时能退回去。
     *
     *   `rich`      结构化词条 + 消毒过的 HTML + 资源**引用**（不含字节）
     *   `resource`  拿着 ref 换字节（`data:` URI）。**按需**，点了才要
     *   `style`     这本词典自带的样式表，一本拿一次
     */
    rich(word: string, bookId?: number): Promise<RichCard>
    resource(ref: string): Promise<DictResource>
    style(bookId: number, key: string): Promise<string>
  }
  /**
   * ★ 这个 `ingest` 是**文件选择器**，不是 D-068 那条「链接抓取」——
   *   后者连同 `main/ingest.ts` 已随 I-180 删掉（使用者 2026-09-14 裁）。
   *   名字撞上了，但这一条 `FileStudy.svelte` / `Workbench.svelte` 天天在用。
   */
  ingest: {
    /** I-037 · 弹文件选择框，读出正文。取消返回 null */
    pickFile(): Promise<ReadDoc | null>
  }
  exp: {
    backup(): Promise<string>
    notes(): Promise<{ path: string; bytes: number }>
    restore(): Promise<{ safetyBackup: string } | null>
    /** I-097 · 只导勾中的这几条，返回落盘路径（取消返回空串） */
    notesForItems(ids: number[], name: string): Promise<string>
    /** I-051 · 清空全部学习数据（设置不动）。清之前自动备份 */
    /** I-051 / I-054 · 清空。alsoRemote = 连云端那份副本一起清（不可逆） */
    /**
     * ★ 清除全部数据 · 恢复出厂。
     *
     * 和 `wipe`（清空学习数据、留设置）不是同一件事：这个要的是「像没装过」。
     * `word` 必须完整等于 `DELETE`（只去首尾空白）——**主进程会自己再判一次**，
     * 不信界面传来的「我确认过了」：不可逆的操作不能只有一层闸。
     *
     * 返回 `null` = 他在主进程那道确认里点了取消。
     */
    factoryReset(word: string, alsoRemote?: boolean): Promise<{
      steps: { name: string; ok: boolean; detail: string }[]
      backup: string
      ok: boolean
    } | null>
    /** 清完重启 —— 让首启初始化原样再跑一遍 */
    relaunch(): Promise<void>
    /** 词典占多大。界面要明说「这些不删」，得给出量 */
    dictsInfo(): Promise<{ files: number; bytes: number; dir: string }>
    wipe(alsoRemote?: boolean, alsoSettings?: boolean): Promise<{
      backup: string
      cleared: Record<string, number>
      remote: number
      alsoRemote: boolean
    } | null>
  }
  report: {
    build(days: number): Promise<ReportData>
    /**
     * Learning Evidence · T-4.12 —— 「人做过的事」，从八张既有事件表算出来。
     * 判据全在 `@core/analytics`，主进程只是取数（`main/analytics.ts`）。
     * ★ 与 `build` 分开两条通道：六块（D-043）与证据层是两套判据，
     *   合成一条的话，其中一边算不出来会把另一边也拖黑。
     */
    evidence(days: number): Promise<AnalyticsView>
  }
  /**
   * 9.1 / 9.2 · 数据体检。
   * `audit` 只看不改；`repair` 修掉**一定是错的**那几种，
   * 需要替他做判断的（东西该归到哪儿）一律不动 —— 猜错的代价是数据搬错地方。
   */
  health: {
    audit(): Promise<AuditReport>
    repair(): Promise<{ fixed: Record<string, number>; after: AuditReport }>
  }
  /**
   * 4.1 · 行为与状态账本。
   * `list` 是那份「以后不再收录」的名单 —— 必须能看见、能撤销。
   * 一个看不见的黑名单会让他觉得软件在漏东西，而且永远查不出为什么。
   */
  ledger: {
    list(): Promise<
      {
        id: number
        term: string
        verdict: 'deleted' | 'purged' | 'silenced'
        scope: string
        lectureId: number | null
        lectureName: string | null
        at: number
        /**
         * ★ R-3-e · 撤销过的行**还留着** —— 它是「我改主意了」这条事实
         * 传到另一台设备的载体。有值就是已撤销，分析时不再据它跳过。
         */
        revokedAt: number | null
      }[]
    >
    /** 撤一条。**不删行**，只在那一行上记一笔撤销（R-3-e） */
    drop(id: number): Promise<number>
    ops(): Promise<
      { id: number; op: string; target: string; targetId: number | null; title: string | null; at: number }[]
    >
    /**
     * ★ T-2.5 / D-R4 · 把 `sync-override` 那一行被盖掉的版本写回去。
     *
     * 写回带**新的 `updated_at`** —— 于是它会再同步出去，另一端按 D-438 收。
     * ★ **拒绝不是异常**：行没了 / 在回收站 / 已经还原过 / 那一笔当时被截断了，
     *   都返回 `{ ok: false, why }`，界面原样显示那句人话。
     */
    restore(id: number): Promise<
      | { ok: true; table: string; uid: string; columns: string[]; from: number }
      | { ok: false; why: string }
    >
    /**
     * ★ T-4.14 · 查一次词记一行（`op = 'lookup'`，`detail` 带来源 / 面 / 后续）。
     *
     * 返回那一行的 id；**0 = 没记上**（记账失败不抛，见 `main/db/ledger.ts::lookup`）。
     * `source` 不在参数里 —— 它由主进程写死 `'windows'`。
     * Windows 今天只传 `'dict'`；`'ai'` 是给 AI 搜索留的位。
     */
    lookup(term: string, face: 'quick' | 'dict' | 'ai'): Promise<number>
    /** 那次查词之后他把这条收下了 —— 回填 `detail.saved`。返回改了几行（0 = 没改） */
    lookupSaved(opId: number, itemId: number): Promise<number>
  }
  /**
   * T-2.11 / T-4.8 · 讲次内一键去重。
   * `scan` 只读；`merge` 写库（一个事务）。
   * ★ 「Review 组不自动处理」这条策略在**主进程**，不在这里 ——
   *   界面只是把 `{ kind: 'safe' }` 递过去，具体哪几组算安全由判据说了算。
   */
  dedup: {
    scan(lectureId: number): Promise<DedupReport>
    merge(lectureId: number, pick: DedupPick): Promise<DedupMergeResult>
  }
  browse: {
    search(q: string): Promise<SearchResults>
    trash(): Promise<TrashBucket[]>
    restore(kind: TrashKind, id: number): Promise<number>
    /** I-075 · 勾选之后一起恢复 */
    restoreMany(picks: { kind: TrashKind; id: number }[]): Promise<number>
    /** I-075 · 勾选之后立刻彻底删除（不等保留期） */
    purgeMany(picks: { kind: TrashKind; id: number }[]): Promise<number>
    deleteLecture(lectureId: number): Promise<{ items: number; moved: number }>
    renameLecture(lectureId: number, name: string): Promise<void>
  }
  files: {
    list(): Promise<FileRow[]>
    add(title: string, content: string, lectureId: number | null): Promise<number>
    detail(fileId: number): Promise<FileDetail>
    setPath(fileId: number, lectureId: number): Promise<void>
    /** 删一篇文章 —— 进垃圾箱，聊天记录跟着走 */
    remove(fileId: number): Promise<void>
    setStatus(fileId: number, status: 'unread' | 'reading' | 'shelved' | 'done'): Promise<void>
    /**
     * R-004 · 每一轮都把整篇文章送进上下文。
     *
     * 5.2 · 两个互斥模式：
     *   · `enlighten` 选导师，只做理解引导，**一道题都不出**
     *   · `quest`     选体裁，按体裁出问题让他回答
     */
    chat(
      id: number,
      text: string,
      tutorId: number | null,
      mode?: 'enlighten' | 'quest',
      genreUid?: string | null,
      /**
       * 他点了「下一个问题」。
       * false = 就当前这张卡追问 —— Quest 停在当前问题，是靠这个参数分开的，
       * 不是靠模型自觉（见 files.chat 的 askNew）。
       */
      questNext?: boolean
    ): Promise<ChatMessage[]>
    /** I-039 · 就地分析这一篇，范围仅限它 */
    analyse(id: number): Promise<AnalyzeResult>
    /** I-039 · 就地分析这一篇，范围仅限它 */
    analyse(fileId: number): Promise<AnalyzeResult>
    tutors(): Promise<TutorRow[]>
    saveTutor(t: Partial<TutorRow> & { name: string }): Promise<number>
    deleteTutor(id: number): Promise<void>
    setDefaultTutor(id: number): Promise<void>
    /** 5.2 · 体裁：和导师同一套增删改 */
    genres(): Promise<GenreRow[]>
    saveGenre(g: Partial<GenreRow> & { name: string }): Promise<string>
    deleteGenre(uid: string): Promise<void>
  }
  study: {
    /** F-03 ·「这批我看过了 · 开始学」—— 这一讲才进入轮转 */
    /**
     * ★ P-1 / ★★ F-2-②-e · 门槛是 `status='review' ∧ silent=0 ∧ 没删`。
     * 不满足就**一个字都不写**，`refused` 说清是哪一种 ——
     * 不许因为重复调用把 interval_days 打回 1、把进度清零，
     * 也不许给一个已归档的讲写上到期日（那会撞上 `silent-but-due`）。
     */
    startLearning(lectureId: number): Promise<StartLearningResult>
    deleteItem(itemId: number): Promise<void>
    setLayer(itemId: number, layer: 'A' | 'B'): Promise<void>

    dueCards(lectureId: number | null, limit?: number): Promise<CardRow[]>
    /**
     * ★ 认读牌面由 AI 出（使用者 2026-09-03）。
     * 返回 `null` = 这次没出成（没配 AI / 超时 / 格式不对 / 露了答案），
     * 界面**退回机械挖空**，不弹错 —— D-338：AI 不在不许阻断认读。
     */
    readingFace(itemId: number): Promise<{ form: string; text: string } | null>
    /** I-061 · 随时测：不看到期日、不看状态。要不要练由你决定，不由日程决定 */
    testCards(lectureIds: number[], shuffle?: boolean): Promise<CardRow[]>
    testQueue(
      lectureIds: number[],
      shuffle?: boolean
    ): Promise<{ id: number; term: string; corrects: number }[]>
    gradeCard(itemId: number, grade: number, durationMs?: number): Promise<ReadingResult>

    productionQueueMany(
      lectureIds: number[]
    ): Promise<{ id: number; term: string; corrects: number }[]>
    hardQueue(): Promise<{ id: number; term: string; corrects: number }[]>
    hardQuestion(itemId: number): Promise<QuestionRow | null>
    diagnose(sessionId: number | null): Promise<DiagnoseResult>
    queueByIds(ids: number[]): Promise<{ id: number; term: string; corrects: number }[]>
    hardList(): Promise<HardRow[]>
    todayPlan(target?: number): Promise<TodayPlan>
    dailyTarget(): Promise<number>
    setDailyTarget(n: number): Promise<void>
    settleLectures(lectureIds: number[], sessionId: number | null): Promise<Settlement>
    /**
     * I-207 · 回执里的 `notice` 不为空 = **这次没生成成功，但他手上那批题一道没少**，
     * 界面要把这句话当面说出来（模型到底报了什么进账本，不摆到他面前）。
     */
    ensureQuestions(itemId: number): Promise<{ added: number; notice: string | null }>
    /**
     * 7 · 产出练习的题型多选。
     * `all` 是系统整理好的全部形式（按难度档分组），`on` 是他勾了的。
     * 勾选**只挑形式，改不了难度档** —— 递进是机制，形式才是口味。
     */
    qtypes(): Promise<{ all: QTypeRow[]; on: string[]; rules: PracticeRules; face: PracticeFace }>
    setQtypes(ids: string[]): Promise<void>
    /** 增删改题型（设置 → AI 导师）。返回改完之后的整份清单 */
    saveQtype(q: Partial<QTypeRow> & { name: string }): Promise<QTypeRow[]>
    deleteQtype(uid: string): Promise<QTypeRow[]>
    setQtypeEnabled(uid: string, on: boolean): Promise<QTypeRow[]>
    restoreQtypes(): Promise<QTypeRow[]>
    /** ★★ 存一个写作层出题规则选项（D-482）。只递改动的那一项 */
    savePracticeRules(patch: Partial<PracticeRules>): Promise<PracticeRules>
    /** ★★ D-486 · 存产出的牌面（三选一）。它只动渲染，不进提示词 */
    savePracticeFace(v: PracticeFace): Promise<PracticeFace>
    /**
     * ★★ 把这一种题型上他以前写的那段出题要求清掉（「改回默认」，确认单 §四）。
     *   **只有他点了才清** —— 自动清空等于悄悄改掉他调过的出题方式。
     */
    clearQtypePrompt(uid: string): Promise<QTypeRow[]>
    /** 出题顺序 · 两层 */
    order(): Promise<PracticeOrder>
    setOrder(o: PracticeOrder): Promise<void>
    nextQuestion(itemId: number): Promise<QuestionRow | null>
    submitAnswer(
      sessionId: number | null,
      itemId: number,
      questionId: number,
      text: string,
      isFirst: boolean,
      hinted: boolean,
      /** ★ V35 · 从出题到提交花了多久。认读线一直在记，产出线 V35 才补上（D-349 ②） */
      durationMs?: number
    ): Promise<GradeResult>
    /** D-138 · 点提示：判分不受影响，但记一次认读失败 */
    usedHint(itemId: number): Promise<{ gloss: string; reason: string }>

    matrix(): Promise<MatrixData>
    libraryItems(filter: LibraryFilter): Promise<LibraryItem[]>
    bulkDelete(ids: number[]): Promise<number>
    bulkSetLayer(ids: number[], layer: 'A' | 'B'): Promise<number>
    silentStats(): Promise<{ items: number; lectures: number; projects: number }>

    itemDetail(itemId: number): Promise<ItemDetail>
    ensureAnalysis(itemId: number, force?: boolean): Promise<number>
    /**
     * T-9.14 · 改这条知识点的**正文**：term / gloss / gloss_zh。
     * 没给的键 = 那一列不动（不是清空）；返回改完的词条。
     * ★ 判据在 `@core/analysis/edit.ts`（两端一份）：改哪几列 · 留痕 · 拒绝的两种。
     * ★ 解析块一个字不动（D-468）—— 改完是不是「照旧词条写的」由详情页说一句。
     */
    editItem(
      itemId: number,
      input: { term?: string; gloss?: string; glossZh?: string }
    ): Promise<string>
    /** I-046 · 接受某一条修正建议 —— 到这一步才会真的改字 */
    acceptSuspect(itemId: number, index: number): Promise<string>
    /** I-046 · 忽略全部建议，把这一块收起来 */
    dismissSuspects(itemId: number): Promise<void>
    silenceItem(itemId: number): Promise<void>
    restoreItem(itemId: number): Promise<void>
    /** I-088 · 上传库里展开一句，看它析出了哪些成分 */
    derivedOf(itemId: number): Promise<ItemDetail['derived']>
    /** I-097 · 批量静默 / 取消静默（两条线一起，否则会从另一条冒出来） */
    bulkSilence(ids: number[], on: boolean): Promise<number>
    /** I-098 · 一串 id 的词条与释义 —— 「复制」用 */
    termsOf(ids: number[]): Promise<{ id: number; term: string; gloss: string | null }[]>
    /** I-104 · 每一类各有多少条、其中多少条还没写解析 */
    analysisCounts(
      lectureId: number
    ): Promise<Record<'self' | 'active' | 'passive', { total: number; pending: number }>>
    /** I-104 · 按类别写完整解析。跳过已经写过的；可暂停，下次接着跑 */
    analyseScope(
      lectureId: number,
      scope: 'self' | 'active' | 'passive'
    ): Promise<{ total: number; done: number; failed: number; skipped: number }>
    /** I-097 · 只测勾中的这几条 · 认读线 */
    testCardsByIds(ids: number[], shuffle: boolean): Promise<CardRow[]>

    startSession(kind: string, scope: string, target: number): Promise<number>
    settle(lectureId: number, sessionId: number | null): Promise<Settlement>
    overview(): Promise<{
      lectures: number
      dueLectures: number
      worstOverdue: number
      dueCards: number
      /**
       * ★ SC-02 / ST-Q3 · 分析完了停在「待审阅」的讲次数 —— 首页那条 **partial** 提示用它。
       *   它是这条链上最容易断的一环：AI 跑完了、人没去过目，于是既不在轮转里也没人提醒。
       */
      reviewLectures: number
    }>
  }
}

/** IPC 传回来的错误里夹带的结构化失败态 —— 界面靠它给出「下一步」。 */
export function parseFailure(err: unknown): Failure | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/__NYX_FAILURE__(\{[\s\S]*?\})__END__/)
  if (!m) return null
  try {
    return JSON.parse(m[1]!) as Failure
  } catch {
    return null
  }
}

/**
 * 把 IPC 错误里的内部标记剥掉，剩下给人看的部分。
 *
 * **通道名要留着。** 一开始我把 `Error invoking remote method 'study:xxx'` 整段删了，
 * 觉得那是给程序员看的噪音 —— 结果真出错时，界面上只剩一句
 * 「An object could not be cloned.」，**连是哪个调用炸的都不知道**，
 * 排查时只能靠猜。这跟「点了没反应」是同一种病：错误可见了，但不足以定位。
 * 所以保留成一个不打扰阅读的后缀。
 */
export function cleanMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const channel = msg.match(/^Error invoking remote method '([^']*)':/)?.[1]
  const body = msg
    .replace(/__NYX_FAILURE__[\s\S]*?__END__/, '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  return channel ? `${body}\n（出错的调用：${channel}）` : body
}

declare global {
  interface Window {
    nyx: NyxApi
  }
}

/**
 * 详情页**真的会显示出来**的解析区块名 · I-112
 *
 * **判据已上提 `@core/analysis/blocks.ts`**（T-7.8 · 2026-09-05），这里只剩一层 re-export 壳。
 * 理由和 `db/silence-sql.ts` 那层壳是同一条：Android 也要判「这一次解析有没有写出
 * 人看得见的东西」（D-R22），名单各存一份就会漂 —— 手机说"成功了"、电脑说"认不出来"，
 * 而两边都不报错。真相在 core，位置留在这里（`ItemDetail.svelte` 与 `study.ts` 的引用点不用改）。
 */
export { RENDERED_BLOCKS } from '@core/analysis/blocks.ts'
