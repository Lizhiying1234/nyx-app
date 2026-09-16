/**
 * 详情页**真的会显示出来**的解析区块名 · I-112
 *
 * 原来在 `src/shared/api.ts`（Windows 专属目录）。T-7.8 搬进 core：
 * Android 也要判「这一次解析有没有写出人看得见的东西」，判据必须是同一份名单，
 * 否则手机说"成功了"、电脑说"认不出来"，而两边都不报错。
 * `shared/api.ts` 现在只 re-export 它。
 *
 * ── 为什么要有这份名单 ────────────────────────────────────
 *
 * 写解析是「AI 返回什么键，就写什么区块」。模型只要把整份东西多包一层
 * （`{"analysis": {…}}`），或者换个键名，写进库的就是一个详情页根本不渲染的区块。
 * 于是：调用花掉了、写入条数不是 0、没有任何报错，**而屏幕上一个字没变**。
 * 使用者看到的就是「点了没反应」（I-112 的原话）。**成功的失败**，比报错难查十倍。
 *
 * 所以写完之后要数一数：这一批里有几块是详情页认得的。一块都没有，就当场说清楚。
 *
 * ★ 这份名单必须和 `ItemDetail.svelte` 里渲染的那几组对得上；
 *   加区块时两边一起加（`npm run check:blocks` 守着这一条，两个方向都比）。
 *
 * ── D-468（2026-09-07）· 这次名单动了三处 ────────────────────
 *
 *   · 使用者点名取消的两个区块**退出名单**（是哪两个见 D-468）。
 *     库里已经写过的那些行**留着不删**（D-436），只是详情页不再画、
 *     提示词也不再要 —— 名单认不认得，决定的只是「画不画」。
 *   · `meaning`（它在这句里做什么）与 `barriers`（会绊住你的地方）
 *     合并成**一个新键 `inSentence`**：新解析只产这一块。
 *   · 而 `meaning` / `barriers` **仍留在名单里** —— 这不是没删干净：
 *     库里已有的老行照旧要画（画进合并块那同一个区域），
 *     所以它们确实是「详情页会显示出来的区块」。
 *     从名单里拿掉它们，`planWrites` 会把老键算成「他看不见」，
 *     于是用旧提示词跑一条老词条就会当场报「详情页认不出来」——
 *     而那是假警报：那两块明明画在屏幕上。
 */
/**
 * ★★ T-4.22（使用者 2026-09-08）· `diagnosis`（攻坚诊断，D-097）**不在名单里了**。
 *
 * 详情页右边那一整栏取消，这一块随栏不再画。
 * ★ 库里已有的 `analysis_blocks` 行**一个都不删**（D-216 只增不删）：它只是不再被画出来。
 *   横向那句诊断仍在结算页，攻坚区那一页也照旧读它自己的账。
 * ★ 从名单里去掉的后果正是我们要的：`planWrites` 从此把它算成「详情页认不出来」——
 *   再让 AI 写它就是白写（软件会写库、shown 会加一，而屏幕上一个字都不会变，I-112）。
 */
export const RENDERED_BLOCKS = [
  'gloss',
  'glossZh',
  'inSentence',
  'meaning',
  'barriers',
  'chunks',
  'verbs',
  'pattern',
  'pragmatics',
  'variation',
  'type',
  'sense',
  'structure',
  'background',
  'family',
  'collocations',
  'slots',
  'register',
  'nuance',
  'rewrites',
  'examples',
  'proper',
  'suspect'
] as const

/** 这个区块名详情页认不认得 */
export const isRenderedBlock = (block: string): boolean =>
  (RENDERED_BLOCKS as readonly string[]).includes(block)
