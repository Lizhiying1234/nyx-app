/**
 * 参与同步的表 —— **协议事实，不是平台事实** · D-201
 *
 * ══ 为什么它在 core ★★★（2026-08-23 搬过来的）════════════
 *
 * 它原来住在 `src/main/db/migrations.ts`。那是 Electron 侧：
 * 那个模块会连带拖进 `db/secrets.ts`（Electron 的 `safeStorage`），
 * 于是**任何非 Electron 的运行时都拿不到这份清单** ——
 * 做 Android 最小前置验证时当场撞上：探针只好去解析源码字符串。
 *
 * 而「哪些表参与同步」是**两端必须完全一致**的东西：
 * 少一张 = 那张表的数据在手机上永远同步不过去，而且不报错；
 * 多一张 = 收包时对不上结构指纹，整包被拒。
 * 这种东西一旦变成两份，就是这个项目已经付过好几次学费的「两份判据」。
 *
 * 所以清单在这里定义**唯一一份**，`main/db/migrations.ts` 原样 re-export ——
 * 老的 `import { SYNC_TABLES } from './migrations.ts'` 一处都不用改。
 *
 * ── 判据 ────────────────────────────────────────────────────
 *
 * 「**全部数据参与同步**（使用者明确要求）」，但有四类东西不进去：
 *   settings       —— 里面有 AI 配置。**API key 不参与同步**（D-201 / D-220）
 *   dictionaries   —— 词典是**本地资源**，路径在每台机器上都不一样（D-222）
 *   migration_log  —— 这台机器自己的升级流水，同步过去没有意义
 *   analysis_jobs  —— 跑到一半的任务，换台机器接不上
 */
export const SYNC_TABLES = [
  'projects',
  'units',
  'lectures',
  'materials',
  'items',
  /**
   * ★★ D-296 · 认读卡从 `items` 拆出来（V34）。
   *
   * 排在 `items` **之后**：收包时按这个顺序写，父行先落地，
   * 常见情况一轮就过。但这只是**优化不是保证** ——
   * `core/sync/session.ts::orderForWrite` 只把墓碑挑到前面，其余原序不动，
   * 真正的保证来自「父行没到就整行失败、下一轮重试」（C-2 Case B/F）。
   */
  'reading_cards',
  'item_lectures',
  'occurrences',
  'analysis_blocks',
  'questions',
  'answers',
  'drafts',
  'review_logs',
  'sessions',
  'lecture_logs',
  'state_events',
  'item_events',
  'files',
  'tutors',
  'chat_messages',
  'prompt_presets',
  'assessments',
  'profile_facts',
  /**
   * ★★ 退役功能留下的表 —— 「AI 精选材料」（原 D-077 / D-171）
   *    已按使用者要求整个删除（2026-09-03）。**表和这一行都留着**，两条理由：
   *
   *      · 库只增不删（D-216）。他机器上那些推荐还在库里，
   *        丢掉这一行 = 那些行从此不再跨设备走，而且**不报错**。
   *      · 这份清单是结构指纹的量尺（`core/schema-fingerprint.ts`）。
   *        少一张表，两端算出的指纹当场对不上，**整包被拒**。
   *
   *    没有任何代码再往这张表写东西了，它只是把老数据原样带着走。
   */
  'picks',
  /**
   * 行为账本也同步（V12）。
   * 理由：他在电脑上删掉 / 静默过的表达，换台设备再分析同一篇文章，
   * 不该又被捞回来一遍 —— 判断依据必须跟着人走，不是跟着机器。
   */
  'term_ledger',
  'ops_log',
  /**
   * ★★ F-07 · 跟着**人**走的那些设置（Step 5A）。
   * 只有 USER 那一类在这里 —— 设备配置、API key、协议游标全都留在 `settings`，
   * 判据见 `core/prefs.ts::PREF_SPECS`。
   */
  'user_preferences',
  'genres',
  /** V17 · 他自己写的题型和提示词，换台机器当然要跟着走 */
  'qtypes',
  /**
   * ★★ R-3 · 墓碑自己也是同步表 —— 这样 B 才知道 A 删了什么，
   * 而不必等 B 自己也删一遍。它有自己的 `uid` 和 `updated_at`，
   * 走的是和别的行完全一样的路，不需要任何特殊照顾。
   */
  'tombstones',
  /**
   * ★★ R-4-F-a · 「这一版我不要」也是一条要跨设备生效的事实。
   *
   * 只存本机的话，新设备第一次同步、或者 `applied` 溢出之后重读老包时，
   * 云端那一版会重新出现 —— 而那时他的决定在这台机器上根本不存在，
   * 于是**他从没做过的覆盖被替他做了**。见 `core/resolution.ts`。
   */
  'resolutions'
] as const

/** 这张表参不参与同步 */
export function isSyncTable(name: string): boolean {
  return (SYNC_TABLES as readonly string[]).includes(name)
}
