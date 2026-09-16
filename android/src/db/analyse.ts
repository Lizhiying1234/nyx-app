/**
 * ══ 单条完整解析 · Android 执行器（T-5.12 · D-R22）════════════════
 *
 * 「手机也可以做单条解析」是使用者 2026-09-05 亲口要的（D-R22 已裁）。
 * 这里是**执行器**，不是第二份判据：
 *
 *   请求怎么装配   `core/analysis/request.ts::buildRequest`
 *   响应怎么落库   `core/analysis/plan.ts::planWrites`
 *   「有没有完整解析」`core/sql/analysis.ts::NO_FULL_ANALYSIS`
 *   详情页认得几块  `core/analysis/blocks.ts::RENDERED_BLOCKS`
 *   提示词         `nyx-core/prompts/analyse-item.md`（**同一个文件**，Vite `?raw`）
 *   水平           `db/practice.ts::levelForPrompts`（= Windows 的 `this.level()`）
 *
 * 这一层只做 Windows `main/study.ts::ensureAnalysis` 里那个事务的对应物：
 * 块 upsert · gloss 回写 · `item_events` 记一笔。**一条规矩都不在这里判。**
 *
 * ── 为什么「重新分析」不许自己发明规则 ★★★ ────────────────────
 *
 * `planWrites` 里压着六条互相咬合的规矩，每一条都是使用者的原话
 * （D-149 手改过的一个字不动 · D-150 例句先词典后 AI · R-002 释义回写 ·
 * 空块丢弃 · regen 累加 · I-112 数详情页认得几块）。
 * 在这里另写 append / 覆盖 / 留版本，后果**全是静默的**：
 * 他手写的那段被盖掉、或者两台机器对同一条知识点写出不一样的解析，
 * 而两边都不报错、都说得通。所以：**计划由 core 给，这里照单执行。**
 *
 * ── 分析前先同步一趟 ──────────────────────────────────────────
 *
 * 缩小「两端同时改同一块」的窗口。跳过 / 失败都**不阻塞分析** ——
 * 没网也该能分析；但要把这一趟的账带回去（报告与 Snackbar 用得上）。
 * 真撞上了同时改，处置归 D-438（`autoResolve` 按 `updated_at`），不在这里发明。
 *
 * ── 词典例句 ────────────────────────────────────────────────
 *
 * Windows 传 `dicts.examples(term)`（本地词典的出版例句，D-150 排在 AI 前面）。
 * Android 的 `db/dict.ts` **没有** `examples()` 这条通道（只有查词条与发音音频），
 * 所以这里传 `[]` —— `planWrites` 里那一支只在真有例句时才走，
 * 没有词典例句时 AI 给什么写什么，与「没放词典也照常能用」同一条。
 * 将来 Android 接上例句通道，改的是这一个参数，不是判据。
 */
import { extractJson, AiError, buildRequest, callAi, planWrites, NO_FULL_ANALYSIS } from '../core-link.ts'
import { resolveSlot } from './ai.ts'
import { levelForPrompts } from './practice.ts'
import { loadPrompt } from './prompts.ts'
import { syncFirstFor, type SyncFirst, type SyncNote } from './sync-first.ts'
import type { Db } from './types.ts'
import type { ExistingBlock } from '../core-link.ts'

/**
 * 分析前那一趟同步的账与注入点。★ 定义搬去了零依赖的 `db/sync-first.ts`
 * （I-163），这里原样再导出一次 —— 老的 import 路径一个字都不用改。
 */
export type { SyncNote, SyncFirst }

/**
 * 默认那一条。★ **真实现不在这个文件里**：它要 import `db/sync.ts`，
 * 而那一份顶层拉 `sync-ports.ts`（`@capacitor/filesystem` + secure-storage）。
 * 留在这里就会顺着 `engine/main.ts → db/analysis-runner.ts → 这里` 把整个
 * Capacitor 打进 `assist-engine.js`，而那个 WebView 没有桥（I-163 · D-404）。
 *
 * ★ 从前这里写成 `await import('./sync.ts')`，理由是「② 层测试跑在 node，
 *   静态 import 会让整个模块装不起来」。那条理由**是真的、今天也还成立** ——
 *   但它只挡住了**测试**那一半：单文件 IIFE 会把动态 import 内联，
 *   打包那一半它一点忙都帮不上（实测两次，一字未减）。两半都要，靠的是文件边界。
 *
 * 装配点只有 App 入口一处（`installAppSyncFirst()`）；没装就抛，
 * 账上写的是「没装口子」而不是「跳过了」。
 */
const defaultSyncFirst = syncFirstFor('分析前同步')

export interface AnalyseOptions {
  /** 他亲手点的「重新分析」—— 已有完整解析也照做，且 `shown === 0` 时抛 */
  force?: boolean
  /** 注入点：② 层测试用假的；**默认那条不许绕过**（负向对照盯着它） */
  syncFirst?: SyncFirst
}

export interface AnalyseResult {
  /** 写进 analysis_blocks 的块数 */
  written: number
  /** 其中详情页认得的（含回写的释义）—— I-112 */
  shown: number
  /** 回写了几条释义 */
  gloss: number
  /** 分析前那一趟同步的账 */
  sync: SyncNote
  /** 已经有完整解析、又不是 force —— 什么都没做 */
  skipped: boolean
}

interface ItemRow {
  term: string
  kind: string
  layer: string
  quote: string | null
}

/**
 * 一条知识点的完整解析。
 *
 * @throws AiError（core 的四失败态）· Error（找不到条目 / `shown === 0` 且 force）
 *         抛之前**一个字都没写进库**：写库在一个事务里，AI 那一步在事务之外。
 */
export async function analyseItem(
  db: Db,
  itemId: number,
  o: AnalyseOptions = {}
): Promise<AnalyseResult> {
  const force = o.force === true

  // ── ① 先同步一趟（跳过 / 失败都不阻塞）───────────────────────
  let sync: SyncNote
  try {
    sync = await (o.syncFirst ?? defaultSyncFirst)(db)
  } catch (e) {
    sync = { ran: false, note: `分析前同步没跑成：${(e as Error)?.message ?? e}`, why: 'error' }
  }

  // ── ② 已经有完整解析？判据是 core 那一句，不在这里写第二遍 ────
  const noFull = await db.get(
    `select i.id from items i where i.id = ? and i.deleted_at is null and ${NO_FULL_ANALYSIS('i')}`,
    [itemId]
  )
  const have = (
    await db.all(
      `select block, edited, regen_count as regenCount from analysis_blocks where item_id = ?`,
      [itemId]
    )
  ).map((r) => ({
    block: String(r['block']),
    edited: Number(r['edited'] ?? 0),
    regenCount: Number(r['regenCount'] ?? 0)
  })) satisfies ExistingBlock[]

  if (!noFull && !force) {
    return { written: 0, shown: 0, gloss: 0, sync, skipped: true }
  }

  // ── ③ 条目事实（与 Windows 同一组：就这四样）──────────────────
  const it = (await db.get(
    `select i.term, i.kind, i.layer,
            (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote
       from items i where i.id = ? and i.deleted_at is null`,
    [itemId]
  )) as ItemRow | undefined
  if (!it) throw new Error(`找不到这条知识点（id=${itemId}）`)

  // ── ④ 装配 → 调 AI → 解 JSON（全部在事务之外）────────────────
  const prompt = await loadPrompt('analyse-item')
  const req = buildRequest(
    { term: it.term, kind: it.kind, layer: it.layer, quote: it.quote ?? null },
    prompt,
    await levelForPrompts(db)
  )
  const cfg = await resolveSlot(db, 'light') // D-202 · 解析属轻任务，量大要求低
  const text = await callAi(cfg, req, 'light')
  const j = extractJson<Record<string, unknown>>(text)

  // ── ⑤ 计划由 core 给（见文件头：这里一条规矩都不判）───────────
  const plan = planWrites(j, have, [])
  const t = Date.now()

  // ── ⑥ 一个事务：块 · 释义 · 事件（不写半截）──────────────────
  await db.begin()
  try {
    for (const b of plan.blocks) {
      /** ★ uid 不写 —— `trg_analysis_blocks_uid` 按自然身份生成（两端同一份 identity） */
      await db.run(
        `insert into analysis_blocks (item_id, block, content, regen_count, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
             on conflict(item_id, block) do update set
               content = excluded.content,
               regen_count = excluded.regen_count,
               updated_at = excluded.updated_at`,
        [itemId, b.block, b.content, b.regen, t, t]
      )
    }
    for (const g of plan.gloss) {
      // ★ 只动 gloss / gloss_zh 两列（column 由 core 给，不是这里拼的字符串）
      await db.run(`update items set ${g.column} = ?, updated_at = ? where id = ?`, [
        g.value,
        t,
        itemId
      ])
    }
    /**
     * ★ 来源记录 · 两端同款（T-7.8 · 需求归档 §9）
     * `analysis_blocks` 照常同步，但同步过来的行**说不出是谁写的** ——
     * 电脑上看到一块新的 meaning，分不清是自己上次生成的还是手机刚做的。
     * ★ `provider` 只记协议族、`model` 记模型；**不记 baseUrl、更不记 key**
     *   —— 这张表会同步到他的云端桶（D-220）。
     */
    await db.run(
      `insert into item_events (item_id, kind, detail, created_at, updated_at)
       values (?, 'analyzed', ?, ?, ?)`,
      [
        itemId,
        JSON.stringify({
          origin: 'android',
          provider: cfg.protocol,
          model: cfg.model,
          slot: 'light',
          regen: force
        }),
        t,
        t
      ]
    )
    await db.commit()
  } catch (e) {
    await db.rollback().catch(() => {})
    throw e
  }

  /**
   * ★ I-112 · 「点了没反应」的真相：模型只要把整份东西多包一层
   * （`{"analysis": {…}}`）或换个键名，写进库的就是详情页根本不渲染的区块 ——
   * 调用花掉了、写入条数不是 0、没有任何报错，**而屏幕上一个字没变**。
   * 所以数的是「详情页认得几块」，不是「写了几块」。
   * 只在 force（他亲手点的）时抛：将来批量跑（T-5.13）一条不成不该炸掉整批。
   */
  if (plan.shown === 0) {
    const got = plan.keys.slice(0, 8).join('、') || '（空）'
    const msg = [
      'AI 返回的东西详情页认不出来 —— 所以点了之后页面看着没变化。',
      `这次返回的字段是：${got}。`,
      '期望的是 meaning / chunks / verbs 这些字段平铺在最外层，不要再包一层。',
      '多半是这个模型不够听话 —— 换「重任务」那一组，或者再点一次，通常就好。'
    ].join(String.fromCharCode(10))
    if (force) throw new Error(msg)
  }

  return { written: plan.written, shown: plan.shown, gloss: plan.gloss.length, sync, skipped: false }
}

/** 这一条现在有没有完整解析 —— 菜单靠它决定说「分析」还是「重新分析」 */
export async function hasFullAnalysis(db: Db, itemId: number): Promise<boolean> {
  const r = await db.get(
    `select i.id from items i where i.id = ? and ${NO_FULL_ANALYSIS('i')}`,
    [itemId]
  )
  return r === undefined
}

/**
 * 分析失败时给他看的那一句。
 *
 * ★★ I-142（真机 2026-09-07）· **它绝不许是空串。**
 *
 * 真机上报「单条重新分析做完没有回执」。回执那条链逐跳查过是通的
 * （`ItemMenu.runAnalyse` → `onwrote` → 三个宿主各自的 Snackbar → `snacks.show`），
 * 三个宿主一个不漏。**唯一能让「有回执」看起来像「没回执」的空档就在这里**：
 * 这个函数在两种情形下会回空串 ——
 *   · `e` 是 `Error` 而 `message` 是空（`new Error()`，或某些原生桥抛的那种）
 *   · `AiError` 的 `failure.title` 是空
 * 空串交给 `snacks.show('')` 就是一条**空的横幅**：屏幕上什么都没有，
 * 和「压根没回执」长得一模一样，而且没有任何东西会报。
 *
 * ★ 兜底那句只说**真的知道的事**：这一条没成、原因没认出来。
 *   不编一个原因，也不把异常原文丢给他（D-262）。
 */
export function analyseErrorText(e: unknown): string {
  const said = ((): string => {
    if (e instanceof AiError) {
      const t = e.failure.title?.trim() ?? ''
      const d = e.failure.detail?.trim()
      if (t) return d ? `${t} —— ${d}` : t
      return d ?? ''
    }
    return ((e as Error)?.message ?? String(e)).trim()
  })()
  return said || '这一条没分析成 —— 原因没认出来'
}
