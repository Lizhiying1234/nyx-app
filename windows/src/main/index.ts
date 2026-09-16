import { AUTO_SYNC_ON_BOOT } from '@core/sync/copy.ts'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import BUILD_INFO from './build-info.json' with { type: 'json' }
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { ensureWritable, migrateUserDirs, resolvePaths, type NyxPaths } from './paths.ts'
import {
  activeChoice,
  setActiveChoice,
  shippedArt,
  splashArt,
  labels as splashLabels,
  markSplashBack,
  deleteUserSplash,
  setLabel as setSplashLabel
} from './splash.ts'
import {
  ensureSplashDir,
  importSplash,
  listSplash,
  readSplash,
  splashDir
} from './resources.ts'
import { checkSplashName, decodeSplashChoice, encodeSplashChoice } from '../core/splash-name.ts'
import {
  DEFAULT_BRIEF_PROMPT,
  DEFAULT_LOOKUP_PROMPT,
  lookupUserMessage,
  parseBrief
} from '../core/lookup-prompt.ts'
import { activeId, listModes, overrides, saveModes, setActive, windowBg } from './colors.ts'
import * as glance from './glance.ts'
import {
  destroyOverlay,
  hideLookup,
  moveLookup,
  rendererTargets,
  showLookup
} from './overlay.ts'
import * as bubble from './bubble.ts'
import { destroyMarker, hideMarks, showMarks } from './marker.ts'
import * as select from './select.ts'
import { destroyTray, syncTray } from './tray.ts'
import { DEFAULT_BLOCKED, judgePoint, type GlanceMode } from '../core/glance.ts'
import { decodeModes, type ColorMode } from '../core/design/colors.ts'
import { MigrationFailed, openDatabase } from './db/open.ts'
import { Ledger, type LookupFace } from './db/ledger.ts'
import { Merge } from './db/merge.ts'
import type { AssistState, DedupPick } from '@shared/api.ts'
import { audit as auditDb, repair as repairDb } from './db/audit.ts'
import { syncPrompts, type PromptSyncResult } from './prompt-sync.ts'
import { TARGET_VERSION } from './db/migrations.ts'
import { Repo, matchQuotes } from './db/repo.ts'
import { Prefs } from './db/prefs.ts'
import { setPromptOverrides } from './ai/prompts.ts'
import { promptPrefKey, SHARED_PROMPTS } from '@core/prompt-overrides.ts'
import { LEVEL_BASELINE } from '@core/level-baseline.ts'
import {
  readingState,
  deleteCustomFace,
  saveCustomFace,
  saveReadingFaces,
  saveReadingOption,
  saveReadingQType
} from './reading-faces.ts'
import { practiceFace, practiceOptions, savePracticeFace, savePracticeOption } from './practice-rules.ts'
import type { PracticeFace, PracticeRules, ReadingQType, ReadingRules } from '@core/quiz-rules.ts'
import { AiError, callAi, setAiLog } from './ai/client.ts'
import { isConfigured, readSettings, resolveSlot, saveSettings } from './ai/config.ts'
import { PROVIDERS, type Slot } from './ai/protocol.ts'
import { analyzeLecture } from './ai/analyze.ts'
import { loadPrompt } from './ai/prompts.ts'
import { Study } from './study.ts'
import { Files } from './files.ts'
import { Browse } from './browse.ts'
import { ParamStore } from './params.ts'
import { Learning } from './analytics.ts'
import { Report } from './report.ts'
import { Tts } from './tts.ts'
import { Exporter, RestoreAborted } from './export.ts'
import { readDocument } from './readdoc.ts'
import { Dicts } from './dict/index.ts'
import { bookStyle, buildRichCard, toDataUrl } from './dict/rich.ts'
import { kindOf, mimeOf, parseMediaRef } from '@core/dict/media.ts'
import { Sync } from './sync/index.ts'
import { installClock, makeClock } from './clock.ts'
import type { SyncConfig } from './sync/store.ts'
import { makeBackup, pruneBackups } from './db/backup.ts'
import { dictsInfo, factoryReset } from './factory-reset.ts'
import { startupHeal, UnsafeDatabase } from './db/startup-heal.ts'

/**
 * 判层与出题用的那一行水平 · D-467（2026-09-07）
 *
 * ★ 原来它现取「最近一次 AI 评估」（D-177），评估那一层已经取消 ——
 *   现在是一个**固定基线**，两端同一份（`@core/level-baseline.ts`，那里写了为什么）。
 *   保留这个函数而不是到处填常量：`{{LEVEL}}` 的来源仍然只有一处，
 *   将来真要按数据校准时改这一个地方。
 */
const level = (): string => LEVEL_BASELINE
let study: Study | null = null
let files: Files | null = null
let browse: Browse | null = null
let tts: Tts | null = null
let dicts: Dicts | null = null
let sync: Sync | null = null
import type {
  LibraryFilter,
  SaveAiInput,
  TtsSettings,
  TutorRow,
  GenreRow,
  QTypeRow,
  PracticeOrder,
  TrashKind
} from '@shared/api.ts'

/** 拼多行文案用。写成常量是因为工具链上反复丢转义层 */
const NL = String.fromCharCode(10)

let win: BrowserWindow | null = null
/** I-113 · 这次启动对提示词做了什么 —— 界面上要能看见（换掉了哪份、存到哪儿） */
let promptSync: PromptSyncResult | null = null
let db: Database | null = null
let repo: Repo | null = null
let paths: NyxPaths = resolvePaths()

/** 错误日志 · D-219 —— 崩了之后使用者唯一能贴给 AI 的线索。 */
function log(level: 'info' | 'error', where: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] [${where}] ${msg}\n`
  try {
    appendFileSync(join(paths.logs, 'nyx.log'), line, 'utf8')
  } catch {
    /* 日志写不出来也不能因此崩掉 */
  }
  if (level === 'error') console.error(line.trim())
}

/**
 * ★ 把这支笔交给 core 的 AI 客户端（D-496 W-4）。
 *
 * core 里没有日志出口 —— 打包后 `console.*` 无处可看。而它有一件事需要留痕：
 * 「关闭思考」那个字段被服务商拒了、我们去掉它重试了一次（那一次的思考没关掉）。
 * 这是**我们这边**的兼容问题，不该弹窗打断他，但事后要查得到。
 * 交在这里而不是每个调用点传参：调用点 11 个，传参会漏，而漏了不会报错。
 */
setAiLog(log)

/** 启动阶段的致命错误：弹一个人话对话框，而不是闪退。 */
function fatal(title: string, detail: string): never {
  log('error', 'startup', `${title} :: ${detail}`)
  dialog.showErrorBox(title, detail)
  app.exit(1)
  throw new Error(detail)
}

// ── 单实例锁 · D-218 ──────────────────────────────────────────────
// 它要防的是「两个实例同时写**同一个数据库**」—— 那会直接损坏。
// 所以作用域是**数据库**，不是「这个软件」：显式指了另一个数据目录时，
// 两个实例写的是两个库，本来就不该互斥（否则开着软件就没法跑验收）。
const customRoot = !!process.env['NYX_DATA_ROOT']?.trim()
if (!customRoot && !app.requestSingleInstanceLock()) {
  // 已经有一个实例开着同一个库了：把它叫到前面来，自己退掉。
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(start).catch((err) => {
    fatal('Nyx 启动失败', err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err))
  })
}

function start(): void {
  paths = resolvePaths()

  // ── 便携目录必须可写 · D-263 ──────────────────────────────────
  const notWritable = ensureWritable(paths)
  if (notWritable) fatal('Nyx 无法启动', notWritable)

  /**
   * I-106 · 使用者自己的东西一律搬进 `data/`（词典、提示词）。
   * 只搬一次，搬不动也不挡启动 —— 见 paths.migrateUserDirs。
   */
  for (const note of migrateUserDirs(paths)) log('info', 'paths', note)

  // ── 打开数据库并升级结构 · D-216 / D-217 / D-236 ──────────────
  try {
    const r = openDatabase(paths.db, paths.backups)
    db = r.db

    /**
     * ★ I-113 · 提示词的升级要在这里做，不能在 migrateUserDirs 里 ——
     * 判断「他动过没有」靠的是存在 settings 里的内容指纹，那要先有库。
     *
     * 为什么必须做：`data/prompts` 是**一次性播种**的，之后升级一个字不动。
     * 装完新版一查，他那份 analyse-item.md 还带着 12 处 hold sway（I-108 的污染源），
     * generate-questions.md 里没有 {{TYPES}} —— 题型复选框会点、会存，就是不生效。
     * 整整几轮的提示词工作对他全部落空，**而且不报错**。
     */
    {
      const store = {
        get: (f: string): string | null =>
          ((db!.prepare(`select value from settings where key = ?`).get(`prompt.seed.${f}`) as
            | { value: string }
            | undefined)?.value ?? null),
        set: (f: string, hash: string): void => {
          const t = Date.now()
          db!
            .prepare(
              // settings 只有 key / value / updated_at 三列 —— 没有 created_at。
              // 写错列名类型检查是看不见的（SQL 是字符串），只有跑起来才炸
              `insert into settings (key, value, updated_at) values (?, ?, ?)
               on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
            )
            .run(`prompt.seed.${f}`, hash, t)
        }
      }
      const sync = syncPrompts(paths.shippedPrompts, paths.prompts, store)
      for (const n of sync.notes) log('info', 'prompts', n)
      promptSync = sync
    }

    /**
     * ── 启动自愈两步 ──────────────────────────────────────────
     *
     * ★ I-118 · 出厂内容自愈。导师 / 体裁 / 题型 / 分析预设是**迁移里播种的**，
     * 而迁移只跑一次。清空过之后重启，这四张表就永远空着 —— 其中三个是**静默降级**：
     * Quest 拿到假体裁照常出题、出题提示词的题型段整段是空的。
     * 判据是「表空了」，不是「谁清空的」—— 后者每加一条清空路径就要记得补一次。
     *
     * ★ H-1 → ★★ F-2-① · 收拾残留的「分析中」，现在只是**兼容兜底**。
     * 分析不再写 `lectures.status` 了（分析中是运行事实，不是业务状态），
     * 所以崩溃之后没有东西需要还原 —— 正常情况下这一步扫不到任何行。
     * 留着它是为了同步来的、或旧备份导回的 `analyzing`（见 recoverStuckAnalyzing）。
     *
     * ★★ R-1 · 这两步现在合成一次**带分级**的调用。
     *
     * 以前这两步直接裸写在这个 try 里 —— 抛出来就一路走到下面的 `throw err`，
     * 结果是**一条自愈 SQL 写错，整个软件打不开**。而它们做的都是收拾遗留问题，
     * 收拾不动最坏也只是遗留问题还在，不该把他所有正常数据一起挡在门外。
     *
     * 但也不能一律 catch：库损坏 / 盘写不进去 / 事务回滚没完成时继续跑，
     * 是在未知状态上继续写，**而且不报错** —— 那比打不开严重得多。
     * 分级判据见 `startup-heal.ts`；不安全的抛 `UnsafeDatabase`，在下面单独接。
     */
    const heal = startupHeal(db)
    for (const [t2, n] of Object.entries(heal.builtins.filled)) {
      log('info', 'builtins', `${t2} 是空的，补回了 ${n} 条出厂内容`)
    }

    for (const f of heal.recovered.fixed) {
      log('info', 'recover', `《${f.name}》状态与实际数据对不上，已恢复为 ${f.to}`)
    }
    // 方向不唯一的**不自动改** —— 只记一笔，他在数据体检里看得见
    for (const p2 of heal.recovered.reported ?? []) {
      log('error', 'recover', `《${p2.name}》${p2.problem}`)
    }
    /**
     * 没做成、但不影响继续用的那些。**日志之外还要落进数据体检** ——
     * 他不看日志，也不知道日志在哪；只写日志等于没人知道（`startupHeal` 已落库）。
     */
    for (const pb of heal.problems) {
      log('error', 'heal', `${pb.step} 没做成：${pb.message}${pb.code ? `（${pb.code}）` : ''}`)
    }

    repo = new Repo(db)
    /**
     * ★★ 提示词覆盖的单点钩子（⑤ · 2026-09-01）
     *
     * 手机上能改提示词了，而 `generate-questions` / `score-answer` 两端共用。
     * 覆盖存 `user_preferences`（同步表），这里接一次，
     * `loadPrompt` 的优先级就变成：改过的 → 磁盘 md → 内置副本。
     * ★ 接在 Study 之前 —— 它构造时就可能读提示词。
     */
    {
      const prefs = new Prefs(db)
      /**
       * ★ 只认**两端共用**的那几条（`SHARED_PROMPTS`）。
       *   手机独有的那些（比如 Lookup 的 AI 搜索）也存在同一张同步表里，
       *   但 Windows 没有对应功能 —— 让它们也能覆盖这边的同名提示词，
       *   就是给一条以后必然踩的路：**名字撞上了，覆盖就悄悄串过来了**。
       *   把 scope 这件事做成闸，而不是靠「反正没人会这么命名」。
       */
      const shared = new Set<string>(SHARED_PROMPTS.map((p) => p.name))
      setPromptOverrides((name) =>
        shared.has(name) ? prefs.get(promptPrefKey(name), '') || null : null
      )
    }
    study = new Study(db, paths.prompts, level, () => dicts)
    files = new Files(db, paths.prompts)
    browse = new Browse(db)
    /**
     * 语音 · D-466（两个开关：词典语音 · 系统语音）。
     * ★ 不再要 `paths.audio`：云端合成与永久缓存随 D-466 一起撤了，
     *   词典音是直接从 .mdd 里取的字节，落不落盘都不经过它。
     *   `data/audio/` 目录本身留着 —— 同步引擎那条 `nyx/audio` 通道不动
     *   （协议锁 · ARCHITECTURE LOCKED ③），它从此同步 0 个文件。
     * ★ 把写日志那支笔交给它 —— 每次朗读落一行账（D-219）
     */
    tts = new Tts(db, log)
    // D-151 · 词典纯本地，放进这个目录就自动识别。
    // 放在 data/ **外面**（D-222 · 资源文件与数据分离）—— 词典可能几 GB，
    // 不能混进数据目录；但仍在便携文件夹里，「整个文件夹拷走」照样带着走（D-224）。
    dicts = new Dicts(db, paths.dicts)
    /**
     * ★★ T-7.6 · 把词典层接给朗读 —— **接线在这里，不在 `Tts` 里面**。
     *   `Tts` 只要两件事（这个词的富词条 · 一条资源的字节），
     *   词典怎么扫、怎么解压、哪本优先 —— 那些是词典层自己的事。
     *   事后交进去而不是构造参数：`Dicts` 比 `Tts` 晚一步建。
     */
    tts.useDictionaries({
      /**
       * ★★ T-7.13（I-166）· `others: false` —— 朗读**不做**「别的哪几本也有它」那段普查。
       *   那一段对其余每一本各调一次 `match()`，而 `match()` 会把书开起来：
       *   一次朗读把 22 本全开了，A 在他真库上量到 14637 ms（第二次 11 ms）。
       *   朗读只问默认那一本有没有这个词的音，普查是卡片要的东西。
       */
      card: (w) => buildRichCard(need(dicts).registry, w, undefined, { others: false }),
      resource: (uid, key) => need(dicts).registry.resource(uid, key),
      // ★ 那本没开好就当 miss，不在他等着听的那条路上同步开书
      ready: () => need(dicts).voiceReady()
    })
    dicts.rescan()
    /**
     * ★★ T-7.13 · 预热：把发音会先问的那一本提前开好，**在他点朗读之前**。
     *
     * ★ 摆在启动最后、而且延后一拍：开书是同步的，摆在关键路径上等于把启动拖慢；
     *   放到空闲片刻去花，他那一次点击就只花「查一个词」的钱（实测 11 ms）。
     * ★ 预热没成不影响任何事 —— 朗读那一步问的是 `voiceReady()`，
     *   没好就走系统音。所以这里只写一行账（D-219：他能贴给我看）。
     */
    setTimeout(() => {
      void need(dicts)
        .prewarmVoice()
        .then((w) => {
          if (!w) return
          log(
            'info',
            'dict',
            `预热 ${w.book} opened=${w.opened} ${w.ms}ms${w.err ? ` · ${w.err}` : ''}`
          )
        })
        // 预热失败不影响任何事 —— 但也不许变成一个没人接的 rejection
        .catch((e: unknown) => log('info', 'dict', `预热没成：${e instanceof Error ? e.message : String(e)}`))
    }, 1500)
    sync = new Sync(db, paths.audio, paths.backups, undefined, splashDir(paths))
    log(
      'info',
      'db',
      r.migrated
        ? `数据库已从 v${r.fromVersion} 升级到 v${r.toVersion}，升级前备份：${r.backupPath}`
        : `数据库 v${r.toVersion}，启动备份：${r.backupPath ?? '（这次没做成）'}`
    )
  } catch (err) {
    /**
     * ★ R-1 · 数据库已经不能信任 —— 这一档**故意不继续**。
     *
     * 「宁可打不开，也不带着未知状态继续写」：打不开他会来问，
     * 静默写坏他发现不了，等发现时备份也轮转掉了（22 本词典那次就是这个形状）。
     * 关键是这条路上**一个字都没往库里写**，他的数据原封不动。
     */
    if (err instanceof UnsafeDatabase) {
      fatal(
        'Nyx 无法启动 · 数据库状态不安全',
        [
          `启动自愈在这一步停下了：${err.step}`,
          err.reason,
          '',
          '为了不把问题写进你的数据，软件**没有继续启动**，数据库保持原样、一个字都没改。',
          '',
          `备份都在：${paths.backups}`,
          `日志在：${join(paths.logs, 'nyx.log')}`,
          '',
          '把上面这段连同日志发给 Claude Code，它能看出问题在哪。'
        ].join(NL)
      )
    }
    if (err instanceof MigrationFailed) {
      fatal(
        'Nyx 无法启动 · 数据库升级失败',
        [
          err.message,
          '',
          err.restoredFrom
            ? `已经把数据库恢复成升级前的样子：\n${err.restoredFrom}\n你的数据没有丢。`
            : `没有找到可用的备份，数据库保持原样、没有被改动。`,
          '',
          `备份都在：${paths.backups}`,
          `日志在：${join(paths.logs, 'nyx.log')}`,
          '',
          '把上面这段连同日志发给 Claude Code，它能看出问题在哪。'
        ].join('\n')
      )
    }
    throw err
  }

  const bootGlance = registerIpc()
  createWindow()
  /**
   * ══ 为什么这一句非要排在 `createWindow()` **后面** ★★（2026-09-14）═══
   *
   * 它会把桌面那颗悬浮球建出来（球关着的时候也在，否则他没地方开 Assist）。
   * 原来它跟在 `registerIpc()` 里，也就是在主窗之前 —— 后果有两层：
   *
   *   ① 冷启动时那颗球会**先于软件窗口**蹦到桌面上，闪一下才见到 Nyx；
   *   ② 更要命的是，Playwright 的 `app.firstWindow()` 认的是「谁先开」，
   *      于是 20 套 Electron 验收全都拿到了那颗 46px 的球、在里面找侧边栏 ——
   *      一次全量跑出 **64 红 + 289 取消**，而报出来的话是「侧边栏七行不全」
   *      这种完全指错方向的症状。
   *
   * 测试那一头也修了（`tests/win.ts` 改成按渲染进程自己那把钥匙认主窗，
   * 不再靠开窗顺序）。两头都改是故意的：那边是「别再被顺序骗」，
   * 这边是「顺序本来就该是主窗先出来」—— 各自独立成立，不互为前提。
   */
  bootGlance()

  /**
   * ══ 两条**按钟走**的自动同步，验收时可以关掉 · B-14（2026-09-14）★★ ══
   *
   * ── 关掉的是什么、为什么只关这两条 ──────────────────────────
   *
   * `NYX_NO_SYNC_TIMERS=1` 只掐掉下面这**两条按墙上时钟走**的触发。
   * `autoSyncNow` 本身一个字没动，**「练完自动上传」（D-249）照常跑** ——
   * 那一条是他自己的动作引起的，时刻是确定的，不会飘到别人头上。
   * 会飘的只有「几秒之后自己响一次」这种。
   *
   * ── 它治的是哪一次红（Nyx-Point 查出来的根因）★★★ ────────────
   *
   * `tests/sync.test.ts` 在 `before()` 里一口气起 A / B 两台，而 D-438 那条用例
   * 正好落在 **T+3.5～5 秒**，压着下面这个 **4000 ms**。于是开机自动同步插在
   * `setLayer(pa)` 和显式 `runSync(pa)` **中间**，把那一行先推走了 ——
   * 显式那一次于是报「推上去 0 行」，而且 `pending` 已经是 0。
   * **跑得快就撞上，跑得慢就错开**，于是它看起来像随机抖动。
   * ☞ 这类红最坏的地方是**报出来的话指错方向**：它说的是「没推出去」，
   *   而真相是「已经被另一趟推出去了」。
   *
   * ── 为什么开关做在这里，而不是在用例里加等待 ──────────────
   *
   * 加等待是在赌「4 秒之内一定跑完」——赌赢了也只是这一次，机器一忙又输。
   * 而且它会把**同一个坑**留给下一条落在这个窗口里的用例。
   * 关掉钟表触发之后，那两台机器在这一套里**只在用例点「现在同步」时才同步**，
   * 时序不再由墙上的时钟决定。
   *
   * ── 产品行为一点没变（D-347 / I-042 照旧）★ ─────────────────
   *
   * 不设这个环境变量就是原样：开机 4 秒同一次、之后 30 分钟一趟。
   * 只有**测试自己起的那个实例**会带上它（`tests/*.ts` 的 `env`），
   * 他手上那份 `D:\Nyx` 永远读不到这个变量。
   * ★ 而且**只关自动的那一半**：设置页那颗「现在同步」在任何情况下都照常能用 ——
   *   一个「连手动同步都能被环境变量关掉」的开关，才是真的危险。
   */
  const syncTimersOff = process.env['NYX_NO_SYNC_TIMERS'] === '1'
  if (syncTimersOff) {
    /** ★ 说一句 —— 一个悄悄改变行为的开关，日志里必须看得见它开着 */
    log('info', 'sync', '按钟走的自动同步这一趟关着（NYX_NO_SYNC_TIMERS=1，验收用）')
  } else {
    /**
     * I-042 · 一键同步的「零键」那一半：开着自动同步就在启动时自己同一次。
     * 延后几秒 —— 让界面先起来，别让同步把首屏挡住。
     * 有冲突时**不自己选边**，只把状态留在设置页等他处理（D-201）。
     */
    setTimeout(() => void autoSyncNow(AUTO_SYNC_ON_BOOT), 4000)

    /**
     * ★★ D-347 · 周期自动同步（Windows 先行的那一半）。
     * 以前只有开机 4 秒那一次 —— 电脑一开一整天，云端就一整天没新东西，
     * 手机侧的 Assist L0「在不在 Atlas」答的全是早上的旧账。
     * 30 分钟一趟：单用户两台设备，比这密没收益，比这疏又回到「一天一次」。
     * 冲突照旧不自己选边（D-201）——留在设置页等他。
     */
    setInterval(() => void autoSyncNow('定时自动同步'), 30 * 60 * 1000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

/** 自动触发共用的那一次 run —— 带在飞标记，绝不叠着跑两趟 */
let autoSyncBusy = false
export function autoSyncNow(what: string): void {
  if (!sync || autoSyncBusy) return
  autoSyncBusy = true
  void (async () => {
    if (!(await sync!.auto())) return
    if ((await sync!.status()).kind === 'off') return // 还没配 —— 自动触发就当没这回事
    const out = await sync!.run(undefined, what)
    /**
     * ★★ T-2.10（D-R18 方案 D）· 一趟同步**成功之后**看一眼要不要压实云端。
     *
     * 判据在 `core/sync/compact-trigger.ts`，这里只接线。放在 `run()` 之后而不是里面，
     * 有两个理由：① `compact.ts` 只折**本机吸收过的**包，而刚跑完的这一趟正好把桶
     * 收进了 `applied`，资格闸天然满足；② 压实坏了绝不许改变同步的结果 ——
     * `out` 这时候已经算完了，`compactIfNeeded` 自己不抛，问题落进 `sync.problems`。
     */
    await sync!.compactIfNeeded()
    return out
  })()
    .then((r) => {
      if (!r) return
      if (r.applied > 0) win?.webContents.send('data:changed', { from: 'sync', rows: r.applied })
      log('info', 'sync', `${what}：${r.lastNote}`)
    })
    .catch((err) => {
        /**
         * ★★ R-4-D · 以前这里只写一行日志 —— 而他不看日志，也不知道日志在哪。
         * 「同步好像不工作了」于是永远查不出原因。
         * 落进 `sync.problems`：设置页的同步区直接显示，数据体检也报得出来。
         * 不弹窗 —— 一次网络抖动不值得打断他，但也绝不许它悄无声息。
         *
         * ★ R-4-D-a（2026-08-25）·**记账已经搬进 `Sync.run()` 自己了** ——
         *   挂在调用方是靠记性的做法，而调用方马上要变多（D-347 / D-249 /
         *   Android 后台同步）。这里只剩一行日志，不再重复记一次。
         */
        log('error', 'sync', `自动同步（${what}）失败：${String(err)}`)
    })
    .finally(() => {
      autoSyncBusy = false
    })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false, // D-255 · 只留总原型自己画的那条标题栏，不要 Windows 再给一条
    /**
     * 窗口首帧的底色。这一帧在渲染进程跑起来**之前**就画出去了，
     * 那时候 CSS 令牌还不存在 —— 所以主进程必须自己知道一个颜色。
     *
     * ★ 出厂值仍然写死在这里（= `--color-bg`，`core/design/color-tokens.css`
     *   的 --neutral-100）。COLOR_SYSTEM §四 把它列在「允许写死的」里：
     *   改令牌要同改这一行，对不上就会在开窗那一瞬间闪一下别的颜色。
     * ★★ 2026-09-13 起它多了一层：使用者能自己换配色了（Settings → Resources
     *   → Colors）。他把底色改深之后，写死的浅色会在开窗那一瞬间**闪一下白** ——
     *   时间很短，但那正是「这软件没做完」的观感来源。
     *   所以先问他选的那套要 `--color-bg`，问不到才用出厂值。
     * ★ 顺序是安全的：`start()` 里 `db = r.db` 在 `createWindow()` 之前。
     */
    backgroundColor: windowBg(db, '#F4F8F7'),
    /**
     * ★ 这里原来有一行 `icon: join(app.getAppPath(), 'build', 'icon.ico')`，
     *   **打包之后它指向一个不存在的路径**：`getAppPath()` 是 `resources/app.asar`，
     *   而 `electron-builder.yml` 的 `files:` 只打 `out/**` 与 `package.json` ——
     *   `build/` 根本不进 asar（开着装好的那份 asar 核对过，顶层只有
     *   `node_modules · out · package.json`）。
     *
     *   它一直看着没问题，是因为 Windows 上窗口/任务栏图标会**退回用 exe 内嵌的那枚**，
     *   而那一枚正是 electron-builder 按 `win.icon` 从同一个 `build/icon.ico` 嵌进去的。
     *   所以这一行在打包态是空转，删掉屏幕上一个像素都不变。
     *
     *   ★ 别再加回来。真要在这里指一枚图标，得先把它 `extraResources` 出去，
     *     再按 `process.resourcesPath` 找 —— 那等于在他的绿色文件夹里多放一份
     *     和 exe 里一模一样的图标，为的是一个看不出差别的效果。
     *   ☞ 代价：开发模式（`electron-vite dev`）的窗口从此用 Electron 默认图标，
     *     因为那时候没有一个嵌了 Nyx 星的 exe。只影响开发，不影响他手上那份。
     */
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  // 渲染进程的报错接到主进程来 · D-262 / D-219
  // 上一版三个 bug 里有两个是「界面抛异常但没人看见」。
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log('error', 'renderer', `${e.message} (${e.sourceId}:${e.lineNumber})`)
  })
  win.webContents.on('render-process-gone', (_e, d) =>
    log('error', 'renderer', `渲染进程没了：${d.reason}`)
  )
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  /**
   * ★ H-4-3 · 让首屏渲染真的抛一次 —— **只给验收用，打包之后按不动**。
   *
   * `NYX_FAULT` 那个开关只能让 IPC 通道炸，够不着 `mount()`。
   * 而「首屏挂不起来会不会白屏」恰恰只有真的挂不起来才验得了。
   * 和 `FAULT_CHANNELS` 同一道锁：`app.isPackaged` 为真时读成空，
   * 打包产物里这个 query 永远不会被带上。
   */
  const faultMount = !app.isPackaged && process.env['NYX_FAULT_MOUNT'] === '1'
  if (faultMount) log('info', 'fault', '首屏渲染故障注入已开启（仅开发/测试环境）')
  if (devUrl) win.loadURL(faultMount ? `${devUrl}?faultMount=1` : devUrl)
  else
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: faultMount ? { faultMount: '1' } : undefined
    })
}


/**
 * ★★ Step 7D · 时间源 —— 和 `NYX_FAULT` **同一道锁**。
 *
 *   ① `app.isPackaged` 为真时环境变量根本不看 —— 打包产物里这条路恒不成立
 *   ② 没设或设错时 `makeClock` 返回真实时间，行为与今天逐字相同
 *
 * 它只服务四件事：`startedAt` · 包名与包头 `at` · 本地写入的 `updated_at`。
 * **不往业务层扩散** —— 扩散到哪里，哪里就多一个「测试和生产行为不同」的口子。
 *
 * 用法（只在开发/测试环境）：
 *   `NYX_TEST_CLOCK=offset:+1200000`  这台机器的钟快 20 分钟
 *   `NYX_TEST_CLOCK=fixed:1700000000000`  钉死在这一刻
 */
installClock(
  makeClock({
    packaged: app.isPackaged,
    spec: process.env['NYX_TEST_CLOCK'] ?? null
  })
)
/**
 * ★ H-4a · 故障注入开关 —— **只给验收用，打包之后按不动**。
 *
 * ── 为什么非要有它 ────────────────────────────────────────
 *
 * 这一轮要治的病是「IPC 失败时他什么都看不到」。而「他看得到什么」
 * 只有第 ③ 档（真软件、他的操作路径）验得了。没有这个开关，
 * 就只能验「代码里有 try」—— 那正是第九节说的、验错了层的那种验法。
 *
 * ── 生产环境按不动，靠的是两道锁 ──────────────────────────
 *
 *   ① `app.isPackaged` 为真时直接读成空字符串 —— 打包产物里这个分支恒不成立
 *   ② 空字符串时**连包装都不装**，`ipcMain.handle` 还是原来那一个，
 *      也就是说打包后的调用路径与今天**逐字相同**，不是「装了但不触发」
 *
 * 用法（只在开发/测试环境）：`NYX_FAULT=data:lecture npm run smoke:ui`
 * 支持逗号分隔多个通道名，`*` 结尾算前缀匹配。
 */
const FAULT_CHANNELS = (app.isPackaged ? '' : (process.env['NYX_FAULT'] ?? ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function installFaultInjection(): void {
  if (FAULT_CHANNELS.length === 0) return
  log('info', 'fault', `故障注入已开启：${FAULT_CHANNELS.join('、')}（仅开发/测试环境）`)
  const hit = (ch: string): boolean =>
    FAULT_CHANNELS.some((f) => (f.endsWith('*') ? ch.startsWith(f.slice(0, -1)) : ch === f))
  const raw = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...a: never[]) => unknown) =>
    raw(channel, (async (...args: never[]) => {
      if (hit(channel)) throw new Error(`注入的故障：${channel}`)
      return listener(...args)
    }) as never)) as typeof ipcMain.handle
}

/**
 * ★★ 返回值不是可有可无的（2026-09-14 修）：
 *   把「开机按库里的状态把 Assist 恢复起来」这一步**交出来**，
 *   由 `start()` 在**主窗建好之后**再叫 —— 理由见 `start()` 里那段。
 */
/**
 * ══ 谁把 Assist 开 / 关的 ★★（I-183，2026-09-15）═══════════════
 *
 * 2026-09-15 使用者那边 25 分钟里 Point 被关掉**四次**（21:28:16 · 21:47:28 ·
 * 21:49:58 · 21:51:00），最短一次只隔 5 秒。四次都是实打实的一次 `save(…,'off',…)`，
 * 不是崩溃（`onDead` 只记日志不改模式，而日志里那行从没出现过）。
 *
 * 当时**查不下去**：写这一下的有三个地方（设置页开关 · 托盘菜单 · 悬浮球），
 * 而库里只留下「模式变成了 off」和一个时间戳，看不出是哪一个。
 * 我先后怀疑过设置页那条 `onchange` 和「设置页没订阅 assist:changed」，
 * **两条都查证为错**（前者在 `{#if assist}` 里、`assist` 不可能为空；
 * 后者是我 grep 了原始事件名，而它被 preload 包成了 `onChanged`）。
 *
 * ☞ 所以不再猜，改成让它自己说：**每一次写模式都记下是谁写的。**
 *   下次再发生，日志直接点名，不用再让他复现一遍。
 */
const sayWho = (who: string, next: string): void =>
  log('info', 'assist', `${who}把 Assist 切到「${next === 'off' ? '关' : next}」`)

function registerIpc(): () => void {
  installFaultInjection()
  // 窗口按钮 · D-255（.titlebar 有 -webkit-app-region:drag，按钮必须 no-drag，否则点不动）
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:toggleMaximize', () =>
    win?.isMaximized() ? win.unmaximize() : win?.maximize()
  )
  ipcMain.handle('win:close', () => win?.close())

  /**
   * ★ B8 · 启动页那一块画面（U-007 · DESIGN_SYSTEM §12）。
   *   读不出来返回 `null`，界面画「没图版」；**这一路一句都不抛**（不许白屏）。
   *
   * ★ 2026-09-09 起它**要读库**（`settings['splash.active']` —— 他选了哪一张）。
   *   老注释写着「不碰数据库，它要在库开好之前就能回答」，那句话现在只对一半：
   *   **顺序是安全的** —— `start()` 里 `db = r.db`（:141）在 `createWindow()`（:351）
   *   之前，界面问过来的时候库早开好了。库开不出来时 `db` 是 null，
   *   `splashArt` 退回出厂那张（**不是白屏，也不抛**），而那种情况下他看到的
   *   本来就是故障页。这是「时刻对不对」那一问的答案，写在这里免得下次又靠猜。
   */
  ipcMain.handle('app:splashArt', () => splashArt(paths, db))

  /**
   * ══ 资源 · 启动页（使用者 2026-09-09「Settings → 资源 → 启动页」）══════
   *
   * ★ 分工在 `core/splash-name.ts` 那段注释里：
   *     图片本体 → `data/resources/splash/`，两端**共享**（跟着同步走）
   *     选了哪张 → `settings`（**不进 `SYNC_TABLES`**），各端自己的事
   *   —— 使用者 2026-09-09 改的需求：「win 和 android 可以有不同的启动页，
   *      共享的是图片资源」。现成的分界正好就是他要的分界。
   */
  ipcMain.handle('res:listSplash', () => listSplash(paths))
  /* 出厂那张 —— 和「当前用哪张」无关，设置页要它才画得出那张固定的卡 */
  ipcMain.handle('res:shippedSplash', () => shippedArt(paths.resources))
  ipcMain.handle('res:readSplash', (_e, name: unknown) => readSplash(paths, String(name ?? '')))
  ipcMain.handle('res:activeSplash', () => activeChoice(need(db)))
  ipcMain.handle('res:setActiveSplash', (_e, c: unknown) => {
    /* 界面传进来的东西不认就当没设过 —— 但**这一处要抛**：他刚按了「启用」 */
    const parsed = decodeSplashChoice(
      typeof c === 'string' ? c : encodeSplashChoice(c as never)
    )
    if (!parsed) throw new Error('这不是一张认得出来的启动页资源')
    setActiveChoice(need(db), parsed)
    return parsed
  })
  ipcMain.handle('res:pickSplash', async () => {
    const r = await dialog.showOpenDialog({
      title: '选一张图当启动页',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['webp', 'png', 'jpg', 'jpeg'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    const added = importSplash(paths, r.filePaths[0])
    /**
     * ★★ 重新导入同一张图 = **翻掉自己以前那块碑**（使用者 2026-09-14）。
     *   资源名是内容 sha256，所以「删了又传同一张」一定会撞上自己那块碑；
     *   不翻的话文件在本地却永远推不上桶，下一趟同步还会把它再删一次。
     *   没删过的那些这一句什么都不做。
     */
    markSplashBack(need(db), added.name, Date.now())
    return added
  })
  /**
   * 图片的名字（使用者 2026-09-13）。
   * ★ 改名**要抛** —— 他刚改完，存不进去必须当面说。
   * ★ `at` 在主进程取一次 `Date.now()`：同步那边靠它定「最后一次为准」，
   *   让界面传时刻的话，界面的钟和库的钟就成了两份。
   */
  ipcMain.handle('res:splashLabels', () => splashLabels(db))
  ipcMain.handle('res:renameSplash', (_e, name: unknown, label: unknown) => {
    const n = String(name ?? '')
    if (!checkSplashName(n).ok) throw new Error('这不是一张资源库里的图')
    setSplashLabel(need(db), n, String(label ?? ''), Date.now())
    return splashLabels(db)
  })

  ipcMain.handle('res:removeSplash', (_e, name: unknown) => {
    const name_ = String(name ?? '')
    if (!checkSplashName(name_).ok) throw new Error('这不是一张资源库里的图')
    /**
     * ★ 删文件 · 立碑，两件一起；**不动他选了哪一张**。
     *   为什么不动写在 `splash.ts::deleteUserSplash` 头上 ——
     *   简说：库里那一条记的是「他本来要哪一张」，图加回来它就该复原；
     *   而同步过来的删除本来就不碰库，只在这儿清的话两端行为会分叉。
     */
    deleteUserSplash(paths, need(db), name_, Date.now())
  })
  /**
   * ══ 资源 · 颜色模式（使用者 2026-09-13）════════════════════════
   * 一个模式 = 一整套配色。新建 · 命名 · 改名 · 逐项改 · 应用 · 重置。
   * ★ **两端不互相同步** —— 存 `settings`，不在 `SYNC_TABLES` 里。
   *   和启动页（D-480）同一条现成的分界，同步契约一个字没动。
   * ★ 判据全在 `core/design/colors.ts`（颜色值那道闸 · 形状 · 增删改），
   *   这里只负责存取；**坏值在 core 那一层就被拦掉了**，不会落进 CSS。
   */
  /**
   * ══ 界面偏好 · `ui.*`（2026-09-13）════════════════════════════
   * 只装**这台机器上这块屏怎么显示**的那种小事（第一个是文件学习的字号）。
   *
   * ★ 存 `settings`（**不进 `SYNC_TABLES`**）：字号是他坐在这台电脑前的习惯，
   *   不是学习数据。跟着同步走的话，手机上调一次电脑就跟着变，那是添乱。
   * ★ 键**必须** `ui.` 开头 —— 这是一条**规则**，不是一份要维护的名单。
   *   写成名单的话，每加一个偏好都要记得去改它，而忘了改的那次会静默失败。
   * ★ 值一律当字符串存。读不出来给空串，由界面决定默认值 ——
   *   默认值属于界面，不属于库（库里没有「默认字号」这个事实）。
   */
  const uiKey = (k: unknown): string => {
    const s = String(k ?? '')
    if (!s.startsWith('ui.') || s.length > 64) throw new Error(`不是界面偏好的键：${s}`)
    return s
  }
  /**
   * ══ Glance · 选中就查（使用者 2026-09-13）════════════════════════
   * 他要的是「正常选中文字后**直接自动查词**，不需要任何按键」。
   *
   * ★★ **默认关，而且读不出设置也当关着**（`glance.mode()` 里那一条）——
   *   一个「读不出设置就开始监听」的功能不该存在。
   * ★ 判断抓不抓在 `core/glance.ts`（15 条用例），这里只管进程和消息。
   * ★ 存 `settings`，**不进 SYNC_TABLES**：在哪台机器上开着监听，
   *   是这台机器的事，绝不该跟着同步跑到另一端去。
   */
  /** ★ 形状只有一份，在 `shared/api.ts`（`AssistState`）—— 这里不再拄一遍 */
  const glanceState = (): AssistState => ({
    mode: glance.mode(db),
    /**
     * ★★ 选的是哪一种（使用者 2026-09-14 晚）。开着时就是 mode，
     *   关着时是他上一次选的那一种 —— 桌面那枚悬浮图标靠它
     *   决定「点一下开哪个」（它不负责在两者之间切换）。
     */
    kind: glance.lastMode(db),
    bubbleOn: bubble.wanted(db),
    blocked: (() => {
      try {
        const r = need(db).prepare(`select value from settings where key = ?`).get('glance.blocked') as
          | { value: string }
          | undefined
        return r?.value ?? ''
      } catch {
        return ''
      }
    })(),
    defaults: [...DEFAULT_BLOCKED],
    running: glance.running(),
    /**
     * ★ Point 那个旁观鼠标的助手真起来了吗。
     *   以前这一栏是那颗快捷键（`pointKey`）—— Point 不再靠按键了
     *   （使用者 2026-09-14 第三批），那一栏跟着键一起退了。
     *   报真状态的理由没变：**以为开着其实没开，比关着更糟**。
     */
    pointReady: select.running(),
    /** 收下的东西默认进哪一讲（`null` = 还没设，界面上那颗「收下」就不给点）*/
    lecture: glance.lecture(db)
  })

  /** 开 / 关。★ 起不来要**当面说** —— 以为开着其实没开，比关着更糟 */
  const applyGlance = (): void => {
    if (glance.mode(db) === 'glance') {
      glance.start(
        paths.resources,
        () => glance.rules(db),
        (text, rect) => {
          /**
           * ★★ 抓到的词画在**置顶浮窗**里，不是主窗口。
           *   第一版送进主窗口 `glance:hit`，而 Glance 的前提正是
           *   「他在别的程序里看东西」—— 那时候 Nyx 在后面，
           *   画在主窗口里的卡**他根本看不见**。
           *   把 Nyx 拉到前台是最省事的补救，也正是 ASSIST_CONTRACT §五
           *   明令禁止的那一个（「不接管」）。
           */
          showLookup(text, {
            preload: join(__dirname, '../preload/index.js'),
            ...rendererTargets(__dirname),
            /** ★ 摆在那段字下方（使用者 2026-09-14 晚）。取不到就退回鼠标 */
            anchor: rect
          })
        },
        (why) => {
          log('error', 'glance', why)
          win?.webContents.send('glance:dead', why)
        },
        !app.isPackaged,
        /**
         * ★★ 选中清空了 → 把卡收起来（使用者 2026-09-14 第三条）。
         *
         * 他的原话：「当我点击其他地方时，弹窗仍然不会正常消失。」
         * ★ `hide` 不是 `destroy`：他连着查三个词是常事，每次重建一个
         *   BrowserWindow 要几百毫秒，而这条路的全部意义就是「当场」。
         */
        () => hideLookup()
      )
      /**
       * ★★ 开着划词就**不盯鼠标**（使用者 2026-09-14 晚）。
       *   他的原话：「当用户开启 Glance 时……不运行 Point。」
               */
      applyPoint(false)
    } else if (glance.mode(db) === 'point') {
      /**
       * ★★ Point 那一档：**不起那个盯选中的助手进程**。
       *   这不是省资源，是他说的「两种功能不能同时混在一起」——
       *   而且盯选中是整个 Assist 里代价最大的那一条（任何窗口里的
       *   任何选中都要经过一次判断）。选了 Point 就不该再付那份代价。
       */
      glance.stop()
      applyPoint(true)
    } else {
      glance.stop()
      applyPoint(false)
      /**
       * ★ 关掉的时候把浮窗**销毁**，不只是藏起来。
       *   留一个看不见的置顶窗口在那儿，是「关了却还在」的第二种形态 ——
       *   这一页刚刚才承诺过「没在盯」。
       */
      destroyOverlay()
    }
    /**
     * ★★ 桌面上那颗悬浮球跟着变（使用者 2026-09-14 晚）。
     *   ★ 它**关着的时候也在** —— 否则他根本没地方把 Assist 打开。
     *     亮 / 暗两档说的就是现在开没开。
     */
    bubble.syncBubble(
      db,
      { preload: join(__dirname, '../preload/index.js'), ...rendererTargets(__dirname) },
      glance.mode(db) !== 'off'
    )
    /**
     * ★ 每次开关都同步那一枚托盘图标（使用者 2026-09-13）。
     *   `running` 取的是**真状态**，不是我们想要的状态 ——
     *   助手没起来的话图标就该是「没开」，否则那枚图标本身在说假话。
     */
    syncTray(
      paths.resources,
      {
        on: glance.mode(db) !== 'off',
        running: glance.running()
      },
      {
        /**
         * ★★ 点一下 = 开 / 关（使用者 2026-09-14 第四条）。
         *
         * ★ 2026-09-14 晚：方式只剩一种了（Frame 取消），所以这里不再有
         *   「开成哪一种」的问题 —— 开就是开。
         * ★ 把他自己加的「不抓名单」**原样带回去**：传空串的话，
         *   从托盘点一下就把那份名单悄悄清了，而他下次发现时
         *   根本联想不到是这里干的。
         */
        toggle: () => {
          try {
            /** ★ 开回**他选的那一档** —— 图标不负责切换模式（使用者 2026-09-14 晚）*/
            const next = glance.mode(db) === 'off' ? glance.lastMode(db) : 'off'
            sayWho('托盘菜单', next)
            glance.save(need(db), next, glanceState().blocked)
            applyGlance()
            win?.webContents.send('assist:changed')
          } catch (e) {
            log('error', 'tray', '从托盘开关 Assist 没成：' + String(e))
          }
        },
        open: () => {
          if (win) {
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
          }
        },
        quit: () => {
          bubble.destroyBubble()
          destroyTray()
          app.quit()
        }
      }
    )
  }

  /**
   * ══ Point：进了模式就直接能选字 ★★（使用者 2026-09-14 第三批）══
   *
   * 他的原话：
   *   「Point 不应该依赖快捷键来触发。我进入 Point 模式以后，Point
   *     本身就应该处于工作状态。点击图标打开 → 立即可以使用。」
   *   「Point 的真正目的：让原本无法选中的文字变得可以选中。」
   *
   * ── 上一版是什么，为什么整块换掉 ──────────────────
   * 一颗全局快捷键（Ctrl+Alt+D）：按一下，查鼠标下面那个词。
   * 他推翻了形态，而且那颗键**本身还查错了词** —— 它把 Electron 的
   * DIP 坐标直接喂给了说物理像素的 UI Automation（他这台 150% 缩放，
   * 差 1.5 倍）。他报的「查到的并不是鼠标位置下面的词」就是这一条。
   * 他还点名要求「避免留下错误逻辑」，所以快捷键、`main/point.ts`、
   * `resources/glance/point.ps1` 一并撤除，不在旧路上打补丁。
   * （坐标那道缝现在由 `dpi.ts` 守着，新路一开始就走它。）
   *
   * ── 现在 ────────────────────────────────
   * 开着就有一个助手旁观真鼠标（`select.ts` / `select.ps1`）：
   * 他按住拖过一段选不中的字 → 屏上跟着亮出选区 → 松手那一下查词。
   * ★ 判据用的还是 `judgePoint`（core，有用例）—— 不另写一份。
   */
  /**
   * ══ 收掉这一次选中 · **只有这一个出口** ★★★（2026-09-15）═══════════
   *
   * 选区（高亮）和卡是**同一件事的两半**。屏上只许有两种形态：
   * **两半都在**，或者**两半都没**。中间那个「卡还在、高亮没了」不许存在 ——
   * 它一出现，屏上就多了一个他收不走的东西。
   *
   * ★ 这不是洁癖，是刚踩过的：✕ 那条路原来只 `hideLookup()`，卡没了、
   *   高亮还留在屏幕上，而那时候已经没有任何东西能收走它了。
   *   关 Point 那条路反过来：高亮销毁了、**卡还挂在屏上**。
   *   两个都是「只收了一半」，长得还不一样，所以各修各的就会漏。
   * ★ Nyx-UI-Android 逐行读完 Android 那一端之后建议的也是这条：
   *   他们的 ✕ / 点选区外 / Save 后 1.6s **走的是同一个 `clearSelection()`**，
   *   所以那一端根本不存在「卡留着、高亮没了」这个态。照做。
   * ☞ 以后再加结束方式（新手势、新按钮），**叫这一个函数**，别再各写一份。
   */
  const clearPointSelection = (): void => {
    hideLookup()
    hideMarks()
  }

  const applyPoint = (on: boolean): void => {
    if (!on) {
      select.stop()
      /**
       * ★ 关掉 Point 也要把这一次选中收干净 —— 他刚查的那张卡不该
       *   在功能已经关掉之后还挂在屏幕上。
       */
      hideLookup()
      /**
       * ★ 销毁，不是藏。留一个看不见的、铺满整块屏幕的置顶窗口在那儿，
       *   是「关了却还在」里最难排查的那一种。
       */
      destroyMarker()
      return
    }
    select.start(
      paths.resources,
      {
        onMarks: (rects) => {
          if (!rects.length) hideMarks()
          else
            showMarks(rects, {
              preload: join(__dirname, '../preload/index.js'),
              ...rendererTargets(__dirname)
            })
        },
        onPick: (text, rect, ocr) => {
          const put = showLookup(text, {
            preload: join(__dirname, '../preload/index.js'),
            ...rendererTargets(__dirname),
            /** ★ 卡摆在**整段选区**下面，不是第一行下面 */
            anchor: rect,
            /** ★ 认出来的就得标「可能有误」（D-395）—— 见 `overlay.ts` 那段 */
            ocr
          })
          /**
           * ══ 成功也要留一行 ★★★（2026-09-15，I-177 最贵的那条教训）══
           *
           * 这条路原来**只在失败时说话**（`onNote` / `onDead`），成功一声不吭。
           * 于是使用者报「拖了没反应」时，日志里这三件事长得一模一样：
           *   ① 助手压根没看见这一拖
           *   ② 看见了，但判据把词扔了
           *   ③ 取到了、卡也出来了，只是他没看见（比如卡盖在原文上，I-182）
           * 2026-09-15 查这一件事花了整晚，最后是靠**数窗口**
           * （枚举我们自己的可见窗、按尺寸认出高亮层和卡）才把三者分开的。
           * ☞ 有了这一行，下次一眼就能分：没有这行 = ①或②（往上看 `onNote`），
           *   有这行而他说没看见 = ③，直接去看它报的坐标。
           * ★ 不记**取到的词本身** —— 那是他在别的程序里选的内容，
           *   日志会被同步、会被我读，没有理由留在那儿。只记数量。
           */
          const words = text.split(/\s+/).filter((w) => w.length > 0).length
          log(
            'info',
            'point',
            `取到 ${words} 个词 / ${text.length} 字（${ocr === true ? '认出来的' : '真文字'}）` +
              ` → 卡 ${put.w}×${put.h} 摆在 ${put.x},${put.y}`
          )
        },
        /**
         * ★ 不弹东西，但**要留一行**：他拖了一下什么都没发生的时候，
         *   日志里得说得出为什么（多半是「指针下面没有文字」）。
         */
        onNote: (why) => log('info', 'point', why),
        /**
         * ★★ 什么都没读到 —— **弹一张说实话的卡**（I-177）。
         *
         * 这一档以前只有上面那行日志，而日志他看不见。他报的
         * 「Point 点不了原神里的词」，在代码里的样子就是屏上一片安静：
         * 功能确实没坏，是**坏了不说**。现在它必须说。
         */
        /**
         * ★★ 新的一次拖动开始了 → 把上一张卡收走（使用者 2026-09-14 第三条
         *   「当我点击其他地方时，弹窗仍然不会正常消失」）。
         *   划词那一路早就这么做了，**指词这一路一直没接** —— 这次一并接上。
         * ★ 认出来那一档还多一条理由：它是照着屏幕读的，
         *   而这张卡是不透明的窗，不收走会被当成宿主的字读回来。
         */
        onCleared: () => clearPointSelection(),
        onEmpty: (at, note, hint) => {
          showLookup('', {
            preload: join(__dirname, '../preload/index.js'),
            ...rendererTargets(__dirname),
            anchor: at,
            empty: true,
            /** ★ 那一句是判据给的，不是界面编的 —— 见 `select.ts` 的 `onEmpty` */
            note,
            hint
          })
        },
        accept: (hit) => judgePoint(hit, glance.rules(db))
      },
      (why) => {
        log('error', 'point', why)
        win?.webContents.send('glance:dead', why)
      },
      /** ★ 验收注入点的锁 —— 打包产物里这一条恒为 false（见 `select.ts` 末尾）*/
      !app.isPackaged
    )
  }

  /**
   * ══ 桌面上那颗悬浮球（使用者 2026-09-14 晚）══════════════
   * ★ 点一下 = 开 / 关**当前那一档**。它不切模式 —— 他明确说过
   *   「桌面悬浮图标本身不负责在 Point 和 Glance 之间切换」。
   */
  ipcMain.on('bubble:toggle', () => {
    try {
      const next = glance.mode(db) === 'off' ? glance.lastMode(db) : 'off'
      sayWho('桌面悬浮球', next)
      glance.save(need(db), next, glanceState().blocked)
      applyGlance()
      win?.webContents.send('assist:changed')
    } catch (e) {
      log('error', 'bubble', '从悬浮图标开关 Assist 没成：' + String(e))
    }
  })
  ipcMain.on('bubble:moveBy', (_e, dx: unknown, dy: unknown, first: unknown) => {
    /** ★ `dx/dy` 是**从按下算起的累计位移**，不是上一帧的增量（见 bubble.ts）*/
    bubble.moveBy(Number(dx) || 0, Number(dy) || 0, first === true)
  })
  ipcMain.on('bubble:rest', () => bubble.remember(db))

  /** ★ 拖卡（使用者 2026-09-14 晚：「弹窗本身应该可以拖动、移动」）*/
  ipcMain.on('overlay:moveBy', (_e, dx: unknown, dy: unknown, first: unknown) => {
    /** ★ 累计位移，不是增量（见 overlay.ts 那段）*/
    moveLookup(Number(dx) || 0, Number(dy) || 0, first === true)
  })
  /**
   * ★★ 卡上那颗 ✕ —— **连高亮一起收**（使用者 2026-09-15）。
   *
   * 这儿原来只 `hideLookup()`：卡没了，他刚选中那几个词的高亮**还留在屏幕上**，
   * 而那时候屏上已经没有任何东西能收走它了（卡都关了）。
   * 选区与卡是同一件事的两半，✕ 是他说「这件事结束了」的那一下，两半一起走。
   */
  ipcMain.on('overlay:close', () => clearPointSelection())
  ipcMain.handle('glance:setLecture', (_e, id: unknown) => {
    const n = Number(id)
    glance.setLecture(need(db), Number.isInteger(n) && n > 0 ? n : null)
    return glanceState()
  })
  ipcMain.handle('glance:get', () => glanceState())
  /** 桌面悬浮图标显不显示。★ 要抛 —— 他刚推了开关，存不进去必须当面说 */
  ipcMain.handle('glance:setBubble', (_e, on: unknown) => {
    bubble.setWanted(need(db), on === true)
    applyGlance()
    return glanceState()
  })
  ipcMain.handle('glance:set', (_e, m: unknown, extra: unknown) => {
    /**
     * ★ 只认 `'glance'` / `'point'`，别的一律当关。
     *   老客户端 / 老设置里的 `'frame'` 走到这里也是关 —— 和
     *   `glance.mode()` 读库那一侧同一条规矩，不许两处不一样。
     */
    const next: GlanceMode = m === 'glance' || m === 'point' ? m : 'off'
    sayWho('设置页', next)
    glance.save(need(db), next, String(extra ?? ''))
    applyGlance()
    return glanceState()
  })

  /**
   * ★★ 开机就按库里存的那一档恢复（使用者 2026-09-13）。
   *
   * 少了这一句的后果很隐蔽：他开了 Glance、关掉 Nyx、再打开 ——
   * 设置页仍然显示「开着」（那是库里的值），**而助手根本没起来**。
   * 「以为开着其实没开」比关着更糟，这一条这一批里已经说过三次了。
   * 顺带这也是托盘图标第一次出现的时机。
   *
   * ★★ 但**不在这里叫** —— 这一句会建出桌面那颗悬浮球，而 `registerIpc()`
   *   跑在 `createWindow()` 前面，于是那颗球成了第一个 BrowserWindow。
   *   交给 `start()` 在主窗之后叫（理由见那里）。
   */

  ipcMain.handle('ui:get', (_e, k: unknown) => {
    try {
      const r = need(db).prepare(`select value from settings where key = ?`).get(uiKey(k)) as
        | { value: string }
        | undefined
      return r?.value ?? ''
    } catch {
      // 读不出来 = 用默认值，不该把一块屏带崩
      return ''
    }
  })
  ipcMain.handle('ui:set', (_e, k: unknown, v: unknown) => {
    need(db)
      .prepare(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(uiKey(k), String(v ?? ''), Date.now())
  })

  ipcMain.handle('res:colorModes', () => ({
    modes: listModes(db),
    activeId: activeId(db),
    overrides: overrides(db)
  }))
  /**
   * 整份存回去。★ **要抛** —— 他刚按了保存，存不进去必须当面说。
   * ★ 先过一遍 `decodeModes`：界面传上来的东西同样不可信
   *   （Svelte 的 $state 代理、手改过的库、上一版写的形状）。
   */
  ipcMain.handle('res:saveColorModes', (_e, raw: unknown) => {
    const modes: ColorMode[] = decodeModes(typeof raw === 'string' ? raw : JSON.stringify(raw))
    saveModes(need(db), modes)
    return modes
  })
  /** 应用某一套；传空串 = Reset to Default（回到出厂那套，不存快照）*/
  ipcMain.handle('res:applyColors', (_e, id: unknown) => {
    setActive(need(db), typeof id === 'string' ? id : '')
    return { activeId: activeId(db), overrides: overrides(db) }
  })

  ipcMain.handle('res:openSplashFolder', () => {
    return shell.openPath(ensureSplashDir(paths))
  })

  /**
   * 自检 —— D-265 第 1 件的验收接口。
   * 它真的往库里写一行、再读回来，证明 better-sqlite3 在 Electron 运行时里是活的，
   * 而不只是「编译通过」。
   */
  /**
   * ★ H-4a · 构建号，**不碰数据库**。
   *
   * `app:selfTest` 也带构建号，但它要写一次 settings —— 界面已经炸了的时候
   * 拿它去取构建号，等于让错误页依赖一条可能同样坏掉的路。
   * 而构建号恰恰是那一页最要紧的一行（第九节 9.3：他跑的是哪一份）。
   */
  ipcMain.handle('app:buildInfo', () => BUILD_INFO)

  ipcMain.handle('app:selfTest', () => {
    if (!db) throw new Error('数据库没打开')
    const now = Date.now()
    db.prepare(
      `insert into settings (key, value, updated_at) values ('last_launch', ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    ).run(String(now), now)
    const row = db.prepare(`select value, updated_at from settings where key = 'last_launch'`).get() as
      | { value: string; updated_at: number }
      | undefined
    const sqlite = db.prepare('select sqlite_version() as v').get() as { v: string }

    return {
      ok: row?.value === String(now),
      build: BUILD_INFO,
      sqliteVersion: sqlite.v,
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
      targetVersion: TARGET_VERSION,
      journalMode: db.pragma('journal_mode', { simple: true }) as string,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      counts: need(repo).countAll(),
      paths
    }
  })


  // ── 数据 · 界面只发 IPC，一律不碰数据库（D-258）──────────────

  ipcMain.handle('data:tree', () => need(repo).tree())
  ipcMain.handle('data:ensurePath', (_e, p?: string, u?: string, l?: string) =>
    treeChanged(need(repo).ensurePath(p, u, l))
  )
  ipcMain.handle('data:lecture', (_e, id: number) => need(repo).lecture(id))
  ipcMain.handle('data:addOriginal', (_e, id: number, title: string, content: string) =>
    need(repo).addOriginal(id, title, content)
  )
  ipcMain.handle('data:createProject', (_e, name?: string) =>
    treeChanged(need(repo).createProject(name))
  )
  ipcMain.handle('data:createUnit', (_e, pid: number, name?: string) =>
    treeChanged(need(repo).createUnit(pid, name))
  )
  ipcMain.handle('data:createLecture', (_e, uid: number, name?: string) =>
    treeChanged(need(repo).createLecture(uid, name))
  )
  ipcMain.handle('data:rename', (_e, kind: 'project' | 'unit' | 'lecture', id: number, name: string) =>
    treeChanged(
      need(repo).rename(
        kind === 'project' ? 'projects' : kind === 'unit' ? 'units' : 'lectures',
        id,
        name
      )
    )
  )
  ipcMain.handle('data:softDelete', (_e, kind: 'project' | 'unit', id: number) =>
    treeChanged(need(repo).softDelete(kind, id))
  )
  /**
   * ★★ R-2 · 工作台的「静默这一讲」和项目栏右键的「静默」是**同一个动作**。
   *
   * 以前这条通道走 `repo.silenceLecture()` —— 另一份实现，只翻 silent 位、
   * 不联动条目、取消时不恢复排期，而且不通知项目栏刷新。
   * 那份已经删掉，这里转调唯一的实现。通道名保留是因为渲染层在用它。
   */
  ipcMain.handle('data:silenceLecture', (_e, id: number, on: boolean) =>
    treeChanged(need(repo).setSilent('lecture', id, on))
  )
  // ── I-047 · 三级菜单 ────────────────────────────────────────
  ipcMain.handle('data:setPinned', (_e, id: number, on: boolean) =>
    treeChanged(need(repo).setPinned(id, on))
  )
  /**
   * 9.1 / 9.2 · 数据体检。
   * 做成他自己能点的按钮 —— 只有我跑得到的检查，对他没有用（D-265）。
   */
  ipcMain.handle('app:audit', () => auditDb(need(db)))
  ipcMain.handle('app:repair', () => {
    const r = repairDb(need(db))
    new Ledger(need(db)).op('repair', 'db', null, null, r.fixed)
    return { ...r, after: auditDb(need(db)) }
  })

  // 4.1 · 行为账本：看得见、撤得掉。看不见的黑名单不许存在
  ipcMain.handle('ledger:list', () => new Ledger(need(db)).list())
  ipcMain.handle('ledger:drop', (_e, id: number) => new Ledger(need(db)).drop(id))
  ipcMain.handle('ledger:ops', () => new Ledger(need(db)).ops())
  /**
   * T-4.14 · 查词记账。界面只说「查了什么、哪一面」，
   * `source: 'windows'` 由 `Ledger.lookup` 自己写死 —— 传不了就传不错。
   */
  ipcMain.handle('ledger:lookup', (_e, term: string, face: LookupFace) =>
    new Ledger(need(db)).lookup(term, face)
  )
  ipcMain.handle('ledger:lookupSaved', (_e, opId: number, itemId: number) =>
    new Ledger(need(db)).lookupSaved(opId, itemId)
  )
  /**
   * ★★ T-2.5 · 账本里那一行「同步时被盖掉的那一版」——把它写回去（D-R4 已裁「要」）。
   *
   * 判据与执行都在 core（`sync/restore.ts` + 引擎，要用同一份关系翻译），
   * 这里只做两件平台的事：把结果转给界面、写成功了广播一次 ——
   * D-231：数据在**没有任何界面参与**的情况下变了，不广播他就看不到。
   * ★ 拒绝不是异常，原样返回那句人话；界面显示它。
   */
  ipcMain.handle('ledger:restore', async (_e, id: number) => {
    const out = await need(sync).restoreOverride(id)
    if (out.ok) win?.webContents.send('data:changed', { from: 'ledger-restore', rows: 1 })
    return out
  })

  /**
   * T-2.11 / T-4.8 · 讲次内一键去重。
   * ★ `scan` 只读、`merge` 一个事务；「Review 组不自动处理」的策略在 `Merge` 里，
   *   不在界面 —— 界面绕过去也并不掉需要他看的那些组。
   */
  ipcMain.handle('dedup:scan', (_e, lectureId: number) => new Merge(need(db)).scan(lectureId))
  ipcMain.handle('dedup:merge', (_e, lectureId: number, pick: DedupPick) =>
    new Merge(need(db)).merge(lectureId, pick)
  )

  // 6.1 · 拖拽排序。范围约束在 repo 里也守一道，不只靠界面
  ipcMain.handle(
    'data:reorder',
    (_e, kind: 'project' | 'unit' | 'lecture', parentId: number | null, ids: number[]) =>
      treeChanged(need(repo).reorder(kind, parentId, ids))
  )
  ipcMain.handle(
    'data:silentTree',
    () => need(repo).silentTree()
  )
  ipcMain.handle(
    'data:setSilent',
    (_e, kind: 'project' | 'unit' | 'lecture', id: number, on: boolean) =>
      treeChanged(need(repo).setSilent(kind, id, on))
  )
  ipcMain.handle('data:markUnread', (_e, id: number) => need(repo).markUnread(id))
  ipcMain.handle('data:move', (_e, kind: 'unit' | 'lecture', id: number, p2: number) =>
    treeChanged(need(repo).move(kind, id, p2))
  )
  ipcMain.handle('data:forkLecture', (_e, id: number) => need(repo).forkLecture(id))
  ipcMain.handle('data:lecturesUnder', (_e, kind: 'project' | 'unit' | 'lecture', id: number) =>
    need(repo).lecturesUnder(kind, id)
  )
  ipcMain.handle(
    'data:exportNotes',
    async (_e, kind: 'project' | 'unit' | 'lecture', id: number, name: string) => {
      const r = await dialog.showSaveDialog({
        title: `导出「${name}」的笔记`,
        defaultPath: join(paths.root, `${name.replace(/[\/:*?"<>|]/g, '_')}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (r.canceled || !r.filePath) return ''
      // 范围内的 lecture → 它们的条目。导出走同一个 Exporter（D-102 一份实现）
      return new Exporter(need(db)).writeScopedNotes(
        r.filePath,
        name,
        need(repo).lecturesUnder(kind, id)
      ).path
    }
  )
  ipcMain.handle(
    'data:addItem',
    (_e, lectureId: number, term: string, gloss: string, layer: 'A' | 'B', quote?: string) =>
      need(repo).addItem(lectureId, term, gloss, layer, quote)
  )
  ipcMain.handle('browse:renameLecture', (_e, id: number, name: string) =>
    treeChanged(need(repo).renameLecture(id, name))
  )
  ipcMain.handle('data:addChunks', (_e, id: number, title: string, content: string) =>
    need(repo).addChunks(id, title, content)
  )

  registerAiIpc()

  /** ★ 交给 `start()` 在主窗之后叫（理由见 `start()` 里那段）*/
  return applyGlance
}

/** 数据库没打开就调数据接口 —— 直接炸，不返回空数组假装一切正常。 */
/**
 * 树结构变了就喊一声 · I-080
 *
 * D-185：「界面层不持有数据副本，改一处全部派生显示自动同步。」
 * 跨进程时这**不会自己发生** —— 得有人广播。以前只有同步和清库广播，
 * 于是在文件学习页里就地新建的项目 / 单元 / lecture，侧边栏要重启才看得见
 * （使用者：「新建的路径在左边树里没有出现」）。
 *
 * 包一层：凡是动了树的 handler 都从这里过，返回值原样透出。
 */
const treeChanged = <T>(v: T): T => {
  win?.webContents.send('data:changed', { from: 'tree', rows: 0 })
  return v
}

function need<T>(x: T | null): T {
  if (x === null) throw new Error('数据库还没打开')
  return x
}

/**
 * IPC 只能把错误的 message 传回渲染进程，结构会丢。
 * 所以把 D-205 的四种失败态序列化进 message —— 界面靠它决定给「重试」还是「去设置」。
 * 不这样做，界面就只剩一句干巴巴的错误文字，给不出下一步。
 */
async function wrapAi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AiError) {
      const f = err.failure
      log('error', 'ai', `${f.kind} · ${f.title} · ${f.detail.slice(0, 300)}`)
      throw new Error(`${f.title}__NYX_FAILURE__${JSON.stringify(f)}__END__`)
    }
    log('error', 'ai', err instanceof Error ? err.message : String(err))
    throw err
  }
}

const running = new Map<number, AbortController>()

function registerAiIpc(): void {
  ipcMain.handle('ai:settings', () => readSettings(need(db)))
  ipcMain.handle('ai:save', (_e, input: SaveAiInput) => saveSettings(need(db), input))
  ipcMain.handle('ai:providers', () => PROVIDERS)
  /**
   * ★ D-207 · 首页那条配置引导用它（使用者 2026-09-03「可以加配置引导」）。
   * ★ 这个通道同日早些时候当「零调用死接口」删过一次 —— 现在它有真正的调用方了。
   *   **「没人调」不等于「该删」**：那一轮的教训记在台账 §5.12。
   */
  ipcMain.handle('ai:isConfigured', () => isConfigured(need(db)))

  /**
   * 引文匹配（使用者 2026-09-13）· 整讲重配原文出处。
   * ★ 同步、确定性、不花钱 —— 所以不走 `wrapAi`，也没有进度条：它是瞬时的。
   */
  ipcMain.handle('data:matchQuotes', (_e, lectureId: unknown) =>
    matchQuotes(need(db), Number(lectureId))
  )

  /**
   * ══ 查词 → 问 AI（使用者 2026-09-13）════════════════════════════
   * 他要的是「查词进去之后统一提供：词典 · AI · 语音」。
   *
   * ★ 走的是名册里**已有**的 `lookup-search`（今天从「仅手机」改成「两端」）——
   *   不新起一条：新起的话同一件事两份提示词，他在设置里改了一份，
   *   另一端不跟着变，而**两边都说得通、都不报错**。
   * ★ 走 `light` 槽：和认读牌面同一档「量大要求低」（D-202）。
   * ★ **不自动跑** —— 界面上是一颗按钮。自动跑等于他每查一个词就花一次钱，
   *   而契约里 AI 那一档本来就排在「永不失败的保底」之后。
   */
  /**
   * ══ 词条顶部那两行简短释义（使用者 2026-09-13 第二轮）════════════
   * 他的层级图里，这两行**不属于** AI 那一档，也不属于 Dictionary 那一档 ——
   * 它们是词条本身的信息，两个界面都在它们下面。
   *
   * ★ 和 `ai:explain` **分开一条**：那一条要跑五到八秒，而这两行是
   *   「默认直接显示」的东西 —— 等它跑完的话，卡打开后好几秒是空的。
   * ★ 额度按「一眼看懂」给：240 token 顶天（`explain` 是 1200）。
   * ★ 这一条的提示词**暂时不进 Prompt 专区**：专区里每多一条，
   *   他就多一个要维护的旋钮，而这两行现在还没跑过真实使用。
   *   真要改的时候再进，那时候名字和契约一起加。
   */
  ipcMain.handle('ai:brief', (_e, text: unknown) =>
    wrapAi(async () => {
      const t = String(text ?? '').trim()
      if (!t) throw new Error('没有要查的内容')
      const out = await callAi(
        resolveSlot(need(db), 'light'),
        {
          system: DEFAULT_BRIEF_PROMPT,
          user: lookupUserMessage(t),
          maxTokens: 240,
          timeoutMs: 20_000
        },
        'light'
      )
      return parseBrief(out)
    })
  )

  ipcMain.handle('ai:explain', (_e, text: unknown) =>
    wrapAi(async () => {
      const t = String(text ?? '').trim()
      if (!t) throw new Error('没有要查的内容')
      /**
       * 他自己改过的那一份优先；没改过就用 core 里那份默认（两端同一份）。
       * ★ 这里现建一个 `Prefs` —— 上面那个是在 `start()` 里的局部量，
       *   拿不到；而 `Prefs` 就是一层薄包装，建一次不值一提。
       */
      const custom = (new Prefs(need(db)).get(promptPrefKey('lookup-search'), '') ?? '').trim()
      const out = await callAi(
        resolveSlot(need(db), 'light'),
        {
          system: custom || DEFAULT_LOOKUP_PROMPT,
          user: lookupUserMessage(t),
          maxTokens: 1200,
          timeoutMs: 30_000
        },
        'light'
      )
      return { text: out }
    })
  )

  // D-202 ·「测试连接」。没有它，使用者填完 key 只能靠去点分析来验证，
  // 而分析失败的原因有十几种 —— 那正是上一版「点了没反应」的温床。
  ipcMain.handle('ai:test', (_e, slot: Slot) =>
    wrapAi(async () => {
      const started = Date.now()
      const reply = await callAi(
        resolveSlot(need(db), slot),
        {
          system: 'You are a connectivity probe. Reply with exactly: NYX_OK',
          user: 'Reply with exactly: NYX_OK',
          /**
           * ★★ 2026-09-13 · 从 20 抬到 1024。**这一处比查词更要紧。**
           *
           * 推理模型（DeepSeek 的 reasoning_content · Anthropic 的 thinking ·
           * Qwen-QwQ 这一类）先写思考、再写正文，两者共用同一个上限。
           * 20 个 token 连想都想不完 —— 于是「测试连接」对一个配置完全正确的
           * 推理模型**必然**失败，而这一屏正是他在确认「我的配置对不对」的地方。
           * 失败那句话以前还会说「可能是模型名不对」，把他往改一个本来就对的
           * 模型名上带（core/ai/client.ts 那句假话，同轮修了）。
           *
           * ★ 为什么抬上去不花钱：**max_tokens 是上限不是目标**。
           *   不做思考的模型写完 NYX_OK 就停，1024 和 20 对它们是同一笔账；
           *   只有推理模型会真的用到，而那正是需要它的时候。
           * ★ 而且这是他**手点一次**的探针，不是量大的调用。
           */
          maxTokens: 1024,
          timeoutMs: 30_000
        },
        slot
      )
      return { ok: true as const, reply: reply.slice(0, 200), ms: Date.now() - started }
    })
  )

  ipcMain.handle(
    'ai:analyze',
    (_e, lectureId: number, extra?: string, presetName?: string, materialIds?: number[]) =>
      wrapAi(async () => {
        const ac = new AbortController()
        running.set(lectureId, ac)
        try {
          return await analyzeLecture(lectureId, {
            db: need(db),
            promptsDir: paths.prompts,
            level: level(),
            extra,
            presetName,
            materialIds, // I-082 · 勾选的范围
            signal: ac.signal,
            onStage: (s) => win?.webContents.send('ai:stage', s)
          })
        } finally {
          running.delete(lectureId)
        }
      })
  )

  // ── 提示词：基线在文件里，临时指令在这里 ────────────────────
  ipcMain.handle('prompts:presets', () => need(repo).presets())
  ipcMain.handle('prompts:savePreset', (_e, p: { id?: number; name: string; extra: string }) =>
    need(repo).savePreset(p)
  )
  ipcMain.handle('prompts:deletePreset', (_e, id: number) => need(repo).deletePreset(id))
  ipcMain.handle('prompts:lecturePreset', (_e, id: number) => need(repo).lecturePreset(id))
  ipcMain.handle('prompts:setLecturePreset', (_e, l: number, p: number | null) =>
    need(repo).setLecturePreset(l, p)
  )
  ipcMain.handle('prompts:assembled', (_e, name: string, extra?: string) => {
    const p = loadPrompt(paths.prompts, name)
    const e = extra?.trim()
    return {
      system: e ? `${p.system}\n\n### This material specifically\n\n${e}` : p.system,
      userTemplate: p.user,
      source: p.source,
      path: p.path
    }
  })
  ipcMain.handle('prompts:openFolder', () => shell.openPath(paths.prompts)) // D-213

  /**
   * ★★ 认读测试：**牌面（多选）+ 出题规则（一份）** · D-479（使用者 2026-09-08）
   *
   * 上一版是一张「提示词名单」（五份整段提示词选一份）+ 五口 IPC。
   * 他要的是把两件正交的事分开，所以这里收成两件、四口。
   *
   * ★ 判据（迁移 · 至少留一面 · 拼装）全在 `main/reading-faces.ts` 与
   *   `core/reading-face.ts` —— 这里只管派活。写在这个闭包里的话 `test:db` 够不着，
   *   而那两条正是最容易悄悄坏掉的地方。
   */
  ipcMain.handle('reading:faces', () => readingState(need(db)))
  ipcMain.handle('reading:saveFaces', (_e, list: { id: string; on: boolean }[]) =>
    saveReadingFaces(need(db), list)
  )
  /**
   * ★★ 新建 / 改 / 删一个**自建**牌面（使用者 2026-09-14 第一条）。
   *   校验与「出厂四面改不得」那两条同样在 `main/reading-faces.ts`，
   *   不写在这个闭包里 —— 理由和上面那段一模一样：`test:db` 够不着。
   */
  ipcMain.handle(
    'reading:saveCustomFace',
    (_e, face: { id?: string; name: string; says: string; guide: string }) =>
      saveCustomFace(need(db), face)
  )
  ipcMain.handle('reading:deleteCustomFace', (_e, id: string) => deleteCustomFace(need(db), id))
  /**
   * ★★ D-482 · 「整段正文编辑」那两条（`reading:saveRules` / `reading:restoreRules`）
   *   跟着编辑框一起撤了，换成这一条按选项存。留着老那两条 = 第二条能改出题规则的路，
   *   而那条路写出来的正文从此不参与拼装：点了保存说存好了，出题一个字不变。
   */
  ipcMain.handle('reading:saveOptions', (_e, patch: Partial<ReadingRules>) =>
    saveReadingOption(need(db), patch)
  )
  /** ★★ D-486 · 认读的题型（三选一）。和出题规则分开 —— 它不进提示词 */
  ipcMain.handle('reading:saveQType', (_e, v: ReadingQType) => saveReadingQType(need(db), v))

  /**
   * I-113 · 这次启动对提示词做了什么。
   * 「换掉了你改过的一份」这种事**必须让他看见** —— 悄悄换掉是最坏的做法，
   * 哪怕原件另存了，他不知道也等于没存。
   */
  ipcMain.handle('prompts:syncReport', () => promptSync)

  // ── 语音 · D-466（两个开关：词典语音 · 系统语音）────────────
  ipcMain.handle('tts:settings', () => need(tts).settings())
  ipcMain.handle('tts:save', (_e, s: TtsSettings) => need(tts).save(s))
  ipcMain.handle('tts:speak', (_e, text: string) => need(tts).speak(text))
  /** 上一次朗读走了谁、为什么 —— 设置页那一行诊断读它（D-219：他能贴给我看） */
  ipcMain.handle('tts:lastTrace', () => need(tts).lastVoiceTrace())

  // ── 云同步 · D-201 ──────────────────────────────────────────
  ipcMain.handle('sync:status', () => need(sync).status())
  ipcMain.handle('sync:save', async (_e, c: SyncConfig) => {
    await need(sync).saveConfig(c)
    return need(sync).status()
  })
  ipcMain.handle('sync:test', () => need(sync).test())
  ipcMain.handle('sync:setAuto', async (_e, on: boolean) => {
    await need(sync).setAuto(on)
    return need(sync).status()
  })
  ipcMain.handle('sync:run', async (_e, resolve?: 'remote' | 'local') => {
    /**
     * ★ R-4-D-a · 第二个参数是出事时报给他看的「哪一次同步」。
     * 失败留痕由 `Sync.run()` 自己负责（见那里的注释），这里不再包一层 catch。
     */
    const r = await need(sync).run(resolve, '手动同步')
    /**
     * ★★ T-2.10 · 同上那条触发点 —— 手点的这一趟也算「同步末尾」。
     * `r` 已经算完了，压实不会改动它一个字段（`compactIfNeeded` 不抛）。
     */
    await need(sync).compactIfNeeded()
    /**
     * D-231 ·「数据库在主进程、界面在渲染进程，**「自动同步」不是自动的**。
     *          主进程在数据变更后广播，界面收到即重取。」
     *
     * 同步正是这条决议存在的理由：数据在**没有任何界面参与**的情况下变了。
     * 不广播的话，拉下来一整批新东西，界面上还是原样 —— 而使用者会以为同步没成。
     */
    if (r.applied > 0) win?.webContents.send('data:changed', { from: 'sync', rows: r.applied })
    return r
  })

  // ── 本地词典 · D-150 / D-151 / D-234 ────────────────────────
  ipcMain.handle('dict:list', () => need(dicts).list())
  ipcMain.handle('dict:rescan', () => need(dicts).rescan())
  ipcMain.handle('dict:setEnabled', (_e, id: number, on: boolean) => {
    need(dicts).setEnabled(id, on)
    return need(dicts).list()
  })
  ipcMain.handle('dict:reorder', (_e, ids: number[]) => {
    need(dicts).reorder(ids)
    return need(dicts).list()
  })
  /**
   * ★ D-470（2026-09-07）· `dict:lookup` 这条 IPC 没了：详情页的词典块（D-468）与
   * 设置页的试查词是它仅有的两个调用方，都取消了。`Dicts.lookup()` 这个**方法留着** ——
   * 例句还从它取（D-150），只是不再有从界面直连的那条口子。`dict:lookupCard` 不动。
   */
  /**
   * 悬浮词典卡片（2026-08-16）。和 `dict:lookup` 并存：
   * 那个是**多本并列**（词条详情页「N 本查到」、D-150 捞例句），这个是**单本**。
   */
  ipcMain.handle('dict:lookupCard', (_e, word: string, bookId?: number) =>
    need(dicts).lookupCard(word, bookId)
  )
  ipcMain.handle('dict:setDefaultBook', (_e, id: number) => {
    need(dicts).setDefaultBook(id)
  })

  /**
   * ══ 富词条 · D4 ══════════════════════════════════════════
   *
   * 三条路各管一件事，**分开是有理由的**：
   *
   *   `dict:rich`      查一次词 → 结构化词条 + 消毒过的 HTML + 资源**引用**
   *   `dict:resource`  拿着 ref 换一条资源的字节（`data:` URI）。**按需**
   *   `dict:style`     这本词典自带的样式表（`oald10.css` 186 KB，一本拿一次）
   *
   * 合成一条会让每次查词都拖着几百 KB 的样式表和几十条音频 ——
   * 而他真正会点开的通常只有一两条。
   */
  ipcMain.handle('dict:rich', (_e, word: string, bookId?: number) =>
    buildRichCard(need(dicts).registry, word, bookId)
  )

  /**
   * ★★ 渲染层给的是 `ref`（`bookUid|key`），**永远不是路径**。
   *   这里解开它、按 uid 找本机那一行、按需开 `.mdd` 取字节。
   *   解不开 / 找不到 → 老实说，不猜、不回退到别的书。
   */
  ipcMain.handle('dict:resource', async (_e, ref: string) => {
    const parsed = parseMediaRef(String(ref ?? ''))
    if (!parsed) return { ok: false as const, why: 'ref 的形状不对' }
    const bytes = await need(dicts).registry.resource(parsed.bookUid, parsed.key)
    if (!bytes) return { ok: false as const, why: '这本词典里没有这个资源' }
    const kind = kindOf(parsed.key)
    const shape = kind === 'audio' || kind === 'image' ? kind : 'other'
    const made = toDataUrl(bytes, mimeOf(parsed.key), shape)
    if ('tooBig' in made) {
      return { ok: false as const, why: `这个资源太大了（${Math.round(made.tooBig / 1024)} KB），没有加载` }
    }
    return { ok: true as const, kind, mime: mimeOf(parsed.key), dataUrl: made.dataUrl }
  })

  ipcMain.handle('dict:style', async (_e, bookId: number, key: string) => {
    const r = await bookStyle(need(dicts).registry, bookId, String(key ?? ''))
    return r?.css ?? ''
  })
  ipcMain.handle('dict:openFolder', () => shell.openPath(need(dicts).dir))

  // ── 链接抓取 · D-068 ────────────────────────────────────────
  ipcMain.handle('ingest:pickFile', async () => {
    const r = await dialog.showOpenDialog({
      title: '选一份材料',
      properties: ['openFile'],
      filters: [
        { name: '能读的格式', extensions: ['txt', 'md', 'markdown', 'docx', 'srt', 'vtt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (r.canceled || !r.filePaths[0]) return null
    return readDocument(r.filePaths[0])
  })

  // ── 导出与导回 · D-102 / D-232 ──────────────────────────────
  ipcMain.handle('exp:backup', async () => {
    const r = await dialog.showSaveDialog({
      title: '完整备份（可原样导回）',
      defaultPath: join(paths.root, `nyx-备份-${new Date().toISOString().slice(0, 10)}.db`),
      filters: [{ name: 'Nyx 备份', extensions: ['db'] }]
    })
    if (r.canceled || !r.filePath) return ''
    return new Exporter(need(db)).backupTo(r.filePath)
  })

  ipcMain.handle('exp:notes', async () => {
    const r = await dialog.showSaveDialog({
      title: '可读笔记（Markdown）',
      defaultPath: join(paths.root, `nyx-笔记-${new Date().toISOString().slice(0, 10)}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (r.canceled || !r.filePath) return { path: '', bytes: 0 }
    return new Exporter(need(db)).writeNotes(r.filePath)
  })

  /**
   * ★ 清除全部数据 · 恢复出厂（使用者 2026-08-10）
   *
   * 和上面那个「清空全部学习数据」不是同一件事：那个是「重来一遍」（留设置），
   * 这个是「像没装过」。两个都留着 —— 他多数时候要的是前者。
   *
   * 界面上已经做了两阶段确认（弹窗 + 打字输入 DELETE），
   * 这里**再拦一道**：主进程独立判断确认词，不信界面传来的「我确认过了」。
   * 不可逆的操作不能只有一层闸，而界面那层是可以被别的代码路径绕过的。
   */
  ipcMain.handle('exp:factoryReset', async (_e, word: string, alsoRemote?: boolean) => {
    if (String(word).trim() !== 'DELETE') {
      throw new Error('确认文字不正确 —— 需要完整输入 DELETE。什么都没有删。')
    }
    const syncOn = (await need(sync).config()).kind !== 'off'
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '清除全部数据'],
      defaultId: 0,
      cancelId: 0,
      title: '清除全部数据',
      message: '把这个软件恢复到从没用过的状态？',
      detail: [
        '学习记录、进度、历史、你创建的全部内容、个人设置（含 AI key）都会清掉。',
        '',
        '不会动的：你自己放进 data/dicts 的词典、data/backups 里的备份、软件本身。',
        '动手前会先做一份完整备份。',
        syncOn && alsoRemote ? '★ 云端那份副本也会一起清掉。' : ''
      ]
        .filter(Boolean)
        .join(NL)
    })
    if (r.response !== 1) return null

    const result = await factoryReset({
      db: need(db),
      paths,
      clearSession: async () => {
        await session.defaultSession.clearStorageData()
        await session.defaultSession.clearCache()
      },
      markWiped: () => need(sync).markWiped(),
      wipeRemote: alsoRemote && syncOn ? async () => void (await need(sync).wipeRemote()) : undefined
    })
    for (const st of result.steps) {
      log(st.ok ? 'info' : 'error', 'reset', `${st.name}：${st.detail}`)
    }
    return result
  })

  /** 清除完成后重启 —— 让首启初始化原样再跑一遍，不另写一套「重置状态」的逻辑 */
  ipcMain.handle('exp:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  /** 词典占多大 —— 界面要明说「这些不删」，得给出量 */
  ipcMain.handle('exp:dictsInfo', () => dictsInfo(paths))

  /**
   * I-051 · 清空全部学习数据（**留设置**）。这是「重来一遍」，
   * 不是上面那个「像没装过」—— 两个都留着，他多数时候要的是这一个。
   */
  ipcMain.handle('exp:wipe', async (_e, alsoRemote?: boolean, alsoSettings?: boolean) => {
    const syncOn = (await need(sync).config()).kind !== 'off'
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
      title: '清空全部学习数据',
      message: '把全部项目、材料、知识点、练习记录清空？',
      detail:
        [
          '设置一律不动 —— AI key、同步、词典、朗读、机制参数都留着。',
          '清空之前会自动做一份完整备份，随时能从「从备份导回…」找回来。',
          syncOn
            ? alsoRemote
              ? '\n★ 云端那份副本也会一起清掉。这一步不可逆。'
              : '\n⚠ 云端还留着一份副本。默认会把它们标成「已应用」，不会再被拉回来。'
            : ''
        ].join('\n')
    })
    if (r.response !== 1) return null

    /**
     * I-068 · 顺序要紧：**先挂墓碑，再清数据**。
     * 墓碑记的是「这个时间点之前的云端包一律不认」——
     * 它不依赖任何网络操作成功，所以云端删不删得掉都不影响正确性。
     * 上一版只靠「去云端删包」，列举一失败就静默什么都没做，
     * 下次同步照样把清掉的东西拉回来（使用者遇到的就是这个）。
     */
    await need(sync).markWiped()

    /**
     * ★ I-101 · 云端要在**清本地之前**擦。
     *
     * 原来的顺序是「先清本地、再处理云端」，理由写的是「反过来中途失败会留下
     * 云端清了、本地还在」。但 `alsoSettings` 会把同步配置一起清掉 ——
     * 等轮到 `wipeRemote()` 的时候，**地址和密钥已经没了**，云端根本擦不动。
     * 使用者要的「连云端一起清干净」于是永远做不到，而且一声不吭。
     *
     * 换成先擦云端是安全的：墓碑在最前面已经挂上了，correctness 不依赖这一步 ——
     * 就算擦到一半断网，比墓碑旧的包也一律不认。
     */
    let remote = 0
    if (syncOn && alsoRemote) {
      try {
        remote = await need(sync).wipeRemote()
      } catch (err) {
        log('error', 'sync', `清空云端失败（墓碑已挂，旧包不会再被拉回来）：${String(err)}`)
      }
    }
    const out = new Exporter(need(db)).wipeStudyData(paths.backups, alsoSettings)
    log('info', 'db', `清空学习数据，清空前备份：${out.backup}，云端处理 ${remote} 个包`)
    win?.webContents.send('data:changed', { from: 'wipe', rows: 0 })
    return { ...out, remote, alsoRemote: !!alsoRemote }
  })

  ipcMain.handle('exp:restore', async () => {
    const r = await dialog.showOpenDialog({
      title: '选一个 Nyx 备份导回',
      properties: ['openFile'],
      filters: [{ name: 'Nyx 备份', extensions: ['db'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null

    // D-232 · 导回是**覆盖**不是合并，所以先备份当前库 —— 给使用者一次反悔机会
    let out: { safetyBackup: string }
    try {
      out = await new Exporter(need(db)).restoreFrom(
        r.filePaths[0],
        paths.db,
        paths.backups,
        TARGET_VERSION
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'db', `导回没做成：${msg}`)
      /**
       * ★ C-1 · 失败分两种，处理不一样。
       *
       * · 验证阶段失败（选错文件、文件坏了）：库**还开着**，什么都没动 ——
       *   说清楚为什么，让他重选，软件照常用。
       * · `RestoreAborted`：已经关了库、但没换成 —— 数据同样没动，
       *   但主进程手里那个连接是关的，**必须重启**，否则之后每一步都报错。
       */
      const mustRestart = err instanceof RestoreAborted
      dialog.showMessageBoxSync({
        type: 'error',
        title: '导回没有执行',
        message: '你的数据没有被改动。',
        detail: mustRestart ? `${msg}${NL}${NL}点确定后 Nyx 会重启。` : msg
      })
      if (mustRestart) {
        app.relaunch()
        app.exit(0)
      }
      return null
    }

    log('info', 'db', `导回 ${r.filePaths[0]}，导回前备份：${out.safetyBackup}`)
    // 库已经被换掉了，必须重启才能带着新数据跑
    dialog.showMessageBoxSync({
      type: 'info',
      title: '导回完成',
      message: '数据已经换成备份里的那一份。',
      detail: `导回**之前**的数据备份在：${NL}${out.safetyBackup}${NL}${NL}点确定后 Nyx 会重启。`
    })
    app.relaunch()
    app.exit(0)
    return out
  })

  /**
   * ★ D-467（2026-09-07）· 六条 `level:*` 没了：使用者取消了「我的水平」整块
   * （事实表单 + AI 评估 + 冷启动诊断题 + 历史）。`assessments` / `profile_facts`
   * 两张表**留着不读**（D-216 只增不删，两张表仍在同步名单里）。
   * 判层与出题用的那一行水平改成固定基线，见上面的 `level()`。
   */

  ipcMain.handle('report:build', (_e, days: number) => new Report(need(db)).build(days))
  /** T-4.12 · 证据层。判据在 core，这里只取数（`main/analytics.ts`） */
  ipcMain.handle('report:evidence', (_e, days: number) => new Learning(need(db)).build(days))

  // ── 机制参数 · D-179 ────────────────────────────────────────
  ipcMain.handle('params:list', () => new ParamStore(need(db)).list())
  ipcMain.handle('params:set', (_e, k: string, v: number) => new ParamStore(need(db)).set(k, v))
  ipcMain.handle('params:reset', (_e, k?: string) => new ParamStore(need(db)).reset(k))

  // ── 数据位置可见 · D-206 / D-217 / D-219 ────────────────────
  // 「使用者零编程经验，出问题时要能自己找到并抢救数据。」
  ipcMain.handle('store:info', () => {
    const stat = (p: string): number => {
      try {
        return statSync(p).size
      } catch {
        return 0
      }
    }
    let backups: { name: string; bytes: number; at: number }[] = []
    try {
      backups = readdirSync(paths.backups)
        .filter((f) => f.endsWith('.db'))
        .map((name) => {
          const s = statSync(join(paths.backups, name))
          return { name, bytes: s.size, at: s.mtimeMs }
        })
        .sort((a, b) => b.at - a.at)
    } catch {
      /* 备份目录还没建也不该让这一页打不开 */
    }
    return { paths, dbBytes: stat(paths.db), backups }
  })
  ipcMain.handle('store:backupNow', () => {
    const p = makeBackup(need(db), paths.backups, 'manual')
    pruneBackups(paths.backups, 10)
    log('info', 'db', `手动备份：${p}`)
    return p
  })
  ipcMain.handle('store:openFolder', (_e, which: 'data' | 'logs' | 'backups') =>
    shell.openPath(paths[which])
  )

  // ── 搜索 / 垃圾箱 / 项目页 · D-196 / D-087 / D-113 ──────────
  ipcMain.handle('browse:search', (_e, q: string) => need(browse).search(q))
  ipcMain.handle('browse:trash', () => need(browse).trash())
  /** ★ 项目总览（D-462 / D-464）—— 整棵树摊开看全貌 */
  /**
   * ★ D-475（2026-09-08）· 给「项目」总览那一屏取数的那条 IPC 没了：
   * 使用者裁掉了整屏（D-R7 = 3；D-462 ～ D-465 一并作废）。
   * 跨父搬家仍走树节点右键「移到…」（`data.move`）。
   */
  ipcMain.handle(
    'browse:restoreMany',
    (_e, picks: { kind: TrashKind; id: number }[]) =>
      need(browse).restoreMany(picks)
  )
  ipcMain.handle(
    'browse:purgeMany',
    (_e, picks: { kind: TrashKind; id: number }[]) =>
      need(browse).purgeMany(picks)
  )
  ipcMain.handle('browse:restore', (_e, k: TrashKind, id: number) =>
    need(browse).restore(k, id)
  )
  ipcMain.handle('browse:deleteLecture', (_e, id: number) =>
    treeChanged(need(browse).deleteLecture(id))
  )
  /**
   * ★ D-469（2026-09-07）· `browse:project` / `browse:unit` 没了：
   * 项目主页与单元主页取消，树上的节点只展开、不导航。
   * 它们算的那张 4×4 矩阵与钻取列表一并删（同一张矩阵综合知识库里还有）。
   */

  // ── 文件学习 + AI 导师 · D-115 / D-098 / R-004 / R-005 ────────
  ipcMain.handle('files:list', () => need(files).list())
  ipcMain.handle('files:add', (_e, t: string, c: string, l: number | null) =>
    need(files).add(t, c, l)
  )
  ipcMain.handle('files:detail', (_e, id: number) => need(files).detail(id))
  ipcMain.handle('files:setPath', (_e, id: number, l: number) => need(files).setPath(id, l))
  ipcMain.handle('files:setStatus', (_e, id: number, s: 'unread' | 'reading' | 'shelved' | 'done') =>
    need(files).setStatus(id, s)
  )
  ipcMain.handle(
    'files:chat',
    (
      _e,
      id: number,
      text: string,
      tutorId: number | null,
      mode?: 'enlighten' | 'quest',
      genreUid?: string | null,
      questNext?: boolean
    ) =>
      wrapAi(() =>
        need(files).chat(id, text, tutorId, mode ?? 'enlighten', genreUid ?? null, questNext ?? false)
      )
  )
  /**
   * I-039 · 就地分析这一篇文章。
   * 把它挂成一份材料，然后走**原来那条**分析管线 —— 一条管线，规则不分叉。
   */
  ipcMain.handle('files:analyse', (_e, id: number) =>
    wrapAi(async () => {
      // I-104 · 这一步是**整体分析**：只提取并分层，不写每条的详细解析。
      // 详细解析在那一讲里按类别单独跑（使用者明确要求的分法）。
      const { lectureId } = need(files).stageForAnalysis(id)
      return analyzeLecture(lectureId, {
        db: need(db),
        promptsDir: paths.prompts,
        level: level(),
        onStage: (s) => win?.webContents.send('ai:stage', s)
      })
    })
  )
  ipcMain.handle('files:tutors', () => need(files).tutors())
  ipcMain.handle('files:saveTutor', (_e, t: TutorRow) => need(files).saveTutor(t))
  // 5.2 · 体裁。和导师同一套增删改
  ipcMain.handle('files:genres', () => need(files).genres())
  ipcMain.handle('files:saveGenre', (_e, g: GenreRow) => need(files).saveGenre(g))
  ipcMain.handle('files:deleteGenre', (_e, uid: string) => need(files).deleteGenre(uid))
  ipcMain.handle('files:deleteTutor', (_e, id: number) => need(files).deleteTutor(id))
  ipcMain.handle('files:setDefaultTutor', (_e, id: number) => need(files).setDefaultTutor(id))

  // ── 学习流程 · 判断规则全在 core/，这里只转手（D-238）──────────
  ipcMain.handle('study:startLearning', (_e, id: number) => need(study).startLearning(id))
  ipcMain.handle('study:deleteItem', (_e, id: number) => need(study).deleteItem(id))
  // 使用者 2026-08-10 · 材料和文章都要删得掉（小 ×）。两者都进垃圾箱，不是真删
  ipcMain.handle('data:deleteMaterial', (_e, id: number) => need(repo).deleteMaterial(id))
  ipcMain.handle('files:remove', (_e, id: number) => need(files).remove(id))
  ipcMain.handle('study:setLayer', (_e, id: number, l: 'A' | 'B') => need(study).setLayer(id, l))
  ipcMain.handle('study:testCards', (_e, ids: number[], shuffle?: boolean) =>
    need(study).testCards(ids, shuffle)
  )
  ipcMain.handle('study:testQueue', (_e, ids: number[], shuffle?: boolean) =>
    need(study).testQueue(ids, shuffle)
  )
  ipcMain.handle('study:dueCards', (_e, id: number | null, limit?: number) =>
    need(study).dueCards(id, limit)
  )
  // ★ 认读牌面：失败一律 null，界面退回机械挖空（D-338）
  ipcMain.handle('study:readingFace', (_e, itemId: number) => need(study).readingFace(itemId))
  ipcMain.handle('study:gradeCard', (_e, id: number, g: 1 | 2 | 3 | 4, ms?: number) =>
    need(study).gradeCard(id, g, ms)
  )
  ipcMain.handle('study:productionQueueMany', (_e, ids: number[]) =>
    need(study).productionQueueMany(ids)
  )
  ipcMain.handle('study:hardQueue', () => need(study).hardQueue())
  ipcMain.handle('study:hardQuestion', (_e, id: number) => need(study).hardQuestion(id))
  ipcMain.handle('study:diagnose', (_e, s: number | null) => wrapAi(() => need(study).diagnose(s)))
  ipcMain.handle('study:queueByIds', (_e, ids: number[]) => need(study).queueByIds(ids))
  ipcMain.handle('study:hardList', () => need(study).hardList())
  ipcMain.handle('study:todayPlan', (_e, target?: number) => need(study).todayPlan(target))
  ipcMain.handle('study:dailyTarget', () => need(study).dailyTarget())
  ipcMain.handle('study:setDailyTarget', (_e, n: number) => need(study).setDailyTarget(n))
  ipcMain.handle('study:settleLectures', async (_e, ids: number[], s: number | null) => {
    const r = await need(study).settleLectures(ids, s)
    autoSyncNow('练完自动上传') // D-249 的 Windows 半条 —— 失败走 R-4-D 留痕，不打断结算
    return r
  })
  // 7 · 题型勾选 + 题型管理（V17 起题型是一张表，他可以自己增删改）
  ipcMain.handle('study:qtypes', () => ({
    all: need(study).qt.all(),
    on: need(study).qtypes(),
    /**
     * ★★ D-482 · 写作层那四个出题规则选项跟着这一份状态一起回去 ——
     *   题型表和它们在同一块屏上，分两次请求只会让界面出现「选项还没到」的一瞬。
     */
    rules: practiceOptions(need(db)),
    /** ★★ D-486 · 产出的牌面（卡摆成什么样）。只动渲染，不进提示词 */
    face: practiceFace(need(db))
  }))
  ipcMain.handle('study:savePracticeFace', (_e, v: PracticeFace) => savePracticeFace(need(db), v))
  /** ★★ 存一个写作层选项。只递改动的那一项（理由同认读那边） */
  ipcMain.handle('study:savePracticeRules', (_e, patch: Partial<PracticeRules>) =>
    savePracticeOption(need(db), patch)
  )
  /**
   * ★★ 「改回默认」—— 把这一种题型上他以前写的那段出题要求清掉（确认单 §四）。
   *   **点了才清**：自动清空 = 悄悄改掉他调过的出题方式，而他不会联想到是这次改动干的。
   */
  ipcMain.handle('study:clearQtypePrompt', (_e, uid: string) => {
    const q = need(study).qt.all().find((x) => x.uid === uid)
    if (!q) throw new Error('这个题型已经不在了 —— 可能在另一台设备上删掉了。')
    need(study).qt.save({ ...q, prompt: '' })
    return need(study).qt.all()
  })
  ipcMain.handle('study:setQtypes', (_e, ids: string[]) => need(study).setQtypes(ids))
  ipcMain.handle('study:saveQtype', (_e, q: QTypeRow) => {
    need(study).qt.save(q)
    return need(study).qt.all()
  })
  ipcMain.handle('study:deleteQtype', (_e, uid: string) => {
    need(study).qt.remove(uid)
    return need(study).qt.all()
  })
  ipcMain.handle('study:setQtypeEnabled', (_e, uid: string, on: boolean) => {
    need(study).qt.setEnabled(uid, on)
    return need(study).qt.all()
  })
  ipcMain.handle('study:restoreQtypes', () => {
    need(study).qt.restoreBuiltin()
    return need(study).qt.all()
  })
  ipcMain.handle('study:order', () => need(study).order())
  ipcMain.handle('study:setOrder', (_e, o: PracticeOrder) => need(study).setOrder(o))
  ipcMain.handle('study:ensureQuestions', (_e, id: number) =>
    wrapAi(() => need(study).ensureQuestions(id))
  )
  ipcMain.handle('study:nextQuestion', (_e, id: number) => need(study).nextQuestion(id))
  ipcMain.handle(
    'study:submitAnswer',
    (
      _e,
      s: number | null,
      i: number,
      q: number,
      text: string,
      first: boolean,
      hinted: boolean,
      // ★ V35 / D-349 ② · 产出线的反应时间，界面传进来
      durationMs?: number
    ) => wrapAi(() => need(study).submitAnswer(s, i, q, text, first, hinted, durationMs))
  )
  ipcMain.handle('study:usedHint', (_e, id: number) => need(study).usedHint(id))
  ipcMain.handle('study:matrix', () => need(study).matrix())
  ipcMain.handle('study:libraryItems', (_e, f: LibraryFilter) => need(study).libraryItems(f))
  ipcMain.handle('study:bulkDelete', (_e, ids: number[]) => need(study).bulkDelete(ids))
  ipcMain.handle('study:bulkSetLayer', (_e, ids: number[], l: 'A' | 'B') =>
    need(study).bulkSetLayer(ids, l)
  )
  ipcMain.handle('study:silentStats', () => need(study).silentStats())
  ipcMain.handle('study:itemDetail', (_e, id: number) => need(study).itemDetail(id))
  ipcMain.handle('study:ensureAnalysis', (_e, id: number, force?: boolean) =>
    wrapAi(() => need(study).ensureAnalysis(id, force))
  )
  /** T-9.14 · 改词条正文（term / gloss / gloss_zh）。判据在 core，写入在一个事务里 */
  ipcMain.handle(
    'study:editItem',
    (_e, id: number, input: { term?: string; gloss?: string; glossZh?: string }) =>
      need(study).editItem(id, input)
  )
  ipcMain.handle('study:acceptSuspect', (_e, id: number, i: number) =>
    need(study).acceptSuspect(id, i)
  )
  ipcMain.handle('study:dismissSuspects', (_e, id: number) => need(study).dismissSuspects(id))
  ipcMain.handle('study:silenceItem', (_e, id: number) => need(study).silenceItem(id))
  ipcMain.handle('study:restoreItem', (_e, id: number) => need(study).restoreItem(id))
  ipcMain.handle('study:derivedOf', (_e, id: number) => need(study).derivedOf(id))
  ipcMain.handle('study:termsOf', (_e, ids: number[]) => need(study).termsOf(ids))
  ipcMain.handle('study:analysisCounts', (_e, lectureId: number) =>
    need(study).analysisCounts(lectureId)
  )
  /**
   * I-104 · 按类别写完整解析。可暂停、可续跑（续跑靠「库里有没有解析块」判断，不另记进度）。
   * 和提取共用同一个取消登记表 `running`，所以「暂停分析」那个按钮两边都管用。
   */
  ipcMain.handle(
    'study:analyseScope',
    (_e, lectureId: number, scope: 'self' | 'active' | 'passive') =>
      wrapAi(async () => {
        const ac = new AbortController()
        running.set(lectureId, ac)
        try {
          return await need(study).analyseScope(
            lectureId,
            scope,
            (s) => win?.webContents.send('ai:stage', s),
            ac.signal
          )
        } finally {
          running.delete(lectureId)
        }
      })
  )
  ipcMain.handle('study:bulkSilence', (_e, ids: number[], on: boolean) =>
    need(study).bulkSilence(ids, on)
  )
  ipcMain.handle('study:testCardsByIds', (_e, ids: number[], sh: boolean) =>
    need(study).testCardsByIds(ids, sh)
  )
  ipcMain.handle('exp:notesForItems', async (_e, ids: number[], name: string) => {
    const r = await dialog.showSaveDialog({
      title: `导出勾中的 ${ids.length} 条`,
      defaultPath: join(paths.root, `${name.replace(/[\/:*?"<>|]/g, '_')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (r.canceled || !r.filePath) return ''
    return new Exporter(need(db)).writeItemNotes(r.filePath, name, ids).path
  })
  ipcMain.handle('study:startSession', (_e, k: string, s: string, t: number) =>
    need(study).startSession(k, s, t)
  )
  ipcMain.handle('study:settle', async (_e, l: number, s: number | null) => {
    const r = await need(study).settle(l, s)
    autoSyncNow('练完自动上传') // D-249 · 同上
    return r
  })
  ipcMain.handle('study:overview', () => need(study).overview())

  // D-225 · 可中途取消，已完成的部分保留。已经花钱跑出来的结果不作废。
  ipcMain.handle('ai:cancelAnalyze', (_e, lectureId: number) => {
    running.get(lectureId)?.abort()
  })
}

app.on('window-all-closed', () => {
  db?.close()
  db = null
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (err) => log('error', 'main', `${err.message}\n${err.stack ?? ''}`))
process.on('unhandledRejection', (r) => log('error', 'main', `未处理的 promise 拒绝：${String(r)}`))
