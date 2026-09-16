/**
 * Study · 解析线（判据在 @core/analysis，这一层只装配与落库）：批量 · 队列 · 单条 · 修正建议 · 手改区块 —— T-4.6 拆分（2026-09-06）
 *
 * 方法体从 `src/main/study.ts` 原样搬来：`this.<状态>` → `c.<状态>`，
 * `this.<公共方法>` → `c.self.<方法>`，私有方法整个搬进本文件、调用点也在本文件里。
 * ★ 模板字符串里的行一个空格都没动 —— 那里面是 SQL，缩进属于字符串内容。
 * ★ 判断规则一条都不在这里，全在 core/（D-238）：这一层只做
 *   「从库里取状态 → 交给 core 算 → 把结果写回去」。
 */

import { ITEM_NOT_FOUND } from '@shared/api.ts'
import type { AnalyzeStage } from '@shared/api.ts'
import { buildRequest } from '@core/analysis/request.ts'
import { planWrites, type ExistingBlock } from '@core/analysis/plan.ts'
import { planItemEdit, type ItemEditInput } from '@core/analysis/edit.ts'
import { ANALYSIS_TOTAL_SQL, PENDING_ANALYSIS_SQL, type AnalysisScope } from '@core/sql/analysis.ts'
import { callAi, extractJson } from '../ai/client.ts'
import { resolveSlot } from '../ai/config.ts'
import { loadPrompt } from '../ai/prompts.ts'
import type { StudyCtx } from './ctx.ts'
import { now } from './util.ts'

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
export async function analyseScope(c: StudyCtx, 
  lectureId: number,
  scope: 'self' | 'active' | 'passive',
  onStage: (s: AnalyzeStage) => void,
  signal?: AbortSignal
): Promise<{ total: number; done: number; failed: number; skipped: number }> {
  const pending = c.self.pendingAnalysis(lectureId, scope)
  const out = { total: pending.length, done: 0, failed: 0, skipped: 0 }

  for (const [i, it] of pending.entries()) {
    if (signal?.aborted) {
      out.skipped = pending.length - i
      break
    }
    onStage({
      name: 'extracting',
      materialIndex: i + 1,
      materialTotal: pending.length,
      title: it.term,
      note: `正在写解析 ${i + 1}/${pending.length}`
    })
    try {
      await c.self.ensureAnalysis(it.id, false, signal)
      out.done++
    } catch (err) {
      out.failed++
      console.error(`[analyseScope]「${it.term}」没做成：${String(err)}`)
    }
  }
  return out
}

/**
 * 这一类里**还没写过解析**的条目。
 * 界面拿它显示「待分析 N 条」，跑的时候拿它当队列 —— 同一个判据，不会对不上。
 */
export function pendingAnalysis(c: StudyCtx, lectureId: number, scope: AnalysisScope): { id: number; term: string }[] {
  // 判据在 @core/sql/analysis.ts —— 队列与「待分析 N 条」必须是同一句 SQL（T-7.8）
  return c.db.prepare(PENDING_ANALYSIS_SQL(scope)).all(lectureId) as {
    id: number
    term: string
  }[]
}

/** 每一类各有多少条、其中多少条还没写解析 —— 下拉框上要显示这个 */
export function analysisCounts(c: StudyCtx, 
  lectureId: number
): Record<'self' | 'active' | 'passive', { total: number; pending: number }> {
  const out = {} as Record<'self' | 'active' | 'passive', { total: number; pending: number }>
  for (const scope of ['self', 'active', 'passive'] as const) {
    const total = (c.db.prepare(ANALYSIS_TOTAL_SQL(scope)).get(lectureId) as { n: number }).n
    out[scope] = { total, pending: c.self.pendingAnalysis(lectureId, scope).length }
  }
  return out
}

/**
 * 生成完整解析 · D-142 / D-149 / D-190 / R-002
 *
 * **手动改过的区块不覆盖**（D-149）——「你自己写下的一句理解，比 AI 写的十句都管用；
 * 有些难点很个人，只有你自己知道。」这也是解析必须**逐区块**存的原因（D-257）：
 * 整块 JSON 存不下这个语义。
 */
export async function ensureAnalysis(c: StudyCtx, itemId: number, force = false, signal?: AbortSignal): Promise<number> {
  const have = c.db
    .prepare(`select block, edited, regen_count as regenCount from analysis_blocks where item_id = ?`)
    .all(itemId) as ExistingBlock[]
  // 只有摘要那一块的，不算「有完整解析」
  const full = have.filter((b) => b.block !== 'summary')
  if (full.length > 0 && !force) return 0

  const it = c.db
    .prepare(
      `select i.term, i.kind, i.layer,
                (select quote from occurrences o where o.item_id = i.id order by o.id limit 1) as quote,
                /* 6.2 · 分析判定「打错了 / 听岔了，需要修改」—— 列表上要有个记号。
                   改完之后 acceptSuspect 会把这一条从区块里去掉，
                   区块空了就整块删掉，于是记号自己消失，不需要另设一个「已处理」位。 */
                exists (select 1 from analysis_blocks b
                         where b.item_id = i.id and b.block = 'suspect') as hasSuspect
           from items i where i.id = ?`
    )
    .get(itemId) as { term: string; kind: string; layer: string; quote: string | null } | undefined
  if (!it) throw new Error(ITEM_NOT_FOUND)

  // 请求装配的判据在 @core/analysis/request.ts（T-7.8）—— 手机用的是同一份
  const p = loadPrompt(c.promptsDir, 'analyse-item')
  const req = buildRequest(it, p, c.level())
  const cfg = resolveSlot(c.db, 'light') // D-202 · 解析属轻任务，量大要求低
  const text = await callAi(cfg, { ...req, signal }, 'light')

  const j = extractJson<Record<string, unknown>>(text)
  const t = now()

  /**
   * D-150 · 例句来源优先级：**本地词典 → AI 生成**，且来源要标在脸上。
   * 词典的排在前面，因为它是**出版过的真句子**；AI 补的排后面，标明是补的。
   * 例句是使用者要去模仿的样板，样板的可信度必须写在脸上。
   * （联网搜索那一档 D-150 说默认关闭，这里先不接 —— 接了就得再配一个服务商。）
   */
  const fromDict = (c.dicts?.() ?? null)?.examples(it.term) ?? []

  /**
   * ★ 判据全在 `@core/analysis/plan.ts`（T-7.8）：edited 跳过（D-149）· 例句合并（D-150）·
   *   释义回写（R-002）· 空块丢弃 · regen 累加 · 数「详情页认得几块」（I-112）。
   *   这一层只**执行**这份计划，一条规矩都不再在这里判 —— 手机那边执行同一份计划。
   */
  const plan = planWrites(j, have, fromDict)
  const { written, shown } = plan

  const tx = c.db.transaction(() => {
    for (const b of plan.blocks) {
      c.db
        .prepare(
          `insert into analysis_blocks (item_id, block, content, regen_count, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?)
             on conflict(item_id, block) do update set
               content = excluded.content,
               regen_count = excluded.regen_count,
               updated_at = excluded.updated_at`
        )
        .run(itemId, b.block, b.content, b.regen, t, t)
    }
    for (const g of plan.gloss) {
      c.db
        .prepare(`update items set ${g.column} = ?, updated_at = ? where id = ?`)
        .run(g.value, t, itemId)
    }
    /**
     * ★ 来源记录 · 两端同款（T-7.8 · 需求归档 §9）
     *
     * D-R22 之后手机也会写解析块。`analysis_blocks` 本身是自然身份、照常同步，
     * 但同步过来的行**说不出是谁写的** —— 电脑上看到一块新的 meaning，
     * 分不清是自己上次生成的还是手机刚做的。
     * 记在 `item_events` 上：那张表已经在 `SYNC_TABLES` 里、已经挂在条目上，
     * **不扩表、不加列**。手机那边写同一种事件，两边读同一份账。
     *
     * ★ `provider` 记的是协议族（openai / anthropic / …），`model` 记具体模型。
     *   **不记 baseUrl、更不记 key** —— 这张表会同步到他的云端桶和手机上（D-220）。
     */
    c.db
      .prepare(
        `insert into item_events (item_id, kind, detail, created_at, updated_at)
           values (?, 'analyzed', ?, ?, ?)`
      )
      .run(
        itemId,
        JSON.stringify({
          origin: 'windows',
          provider: cfg.protocol,
          model: cfg.model,
          slot: 'light',
          /** 这一次是不是「重新生成」（他亲手点的那种） */
          regen: force
        }),
        t,
        t
      )
  })
  tx()

  /**
   * ★ I-112 · 「点了没反应」的真相。
   *
   * 使用者报的是 `tangle up` 那一条：点「重新生成解析」，等一会儿，**页面一模一样**。
   * 我一开始以为是按钮没反馈（I-109 加了转圈），但那只治了「不知道它在跑」，
   * 治不了这个 —— 它**真的跑完了**。
   *
   * 病在这里：上面是「模型返回什么键，就写什么区块」。模型只要把整份东西
   * 多包一层（`{"analysis": {…}}`），或者用了别的键名，写进库的就是一个
   * 详情页根本不渲染的区块。于是：调用花掉了、`written` 不是 0、没有任何报错，
   * 而屏幕上一个字没变。**成功的失败**，比报错难查十倍。
   *
   * 现在数「详情页认得几块」。一块都没有，就当场说清楚。
   * 只在 force（他亲手点重新生成）时抛 —— 批量跑那边一条不成不该炸掉整批，
   * 那边靠 `failed` 计数和详情页的单独重试。
   */
  if (shown === 0) {
    const got = plan.keys.slice(0, 8).join('、') || '（空）'
    const msg = [
      'AI 返回的东西详情页认不出来 —— 所以点了之后页面看着没变化。',
      `这次返回的字段是：${got}。`,
      '期望的是 inSentence / chunks / examples 这些字段平铺在最外层，不要再包一层。',
      '多半是这个模型不够听话 —— 换「重任务」那一组，或者重试一次，多数情况下即可恢复。'
    ].join(String.fromCharCode(10))
    if (force) throw new Error(msg)
    console.error(`[ensureAnalysis] item=${itemId} ${msg}`)
  }
  return written
}

/**
 * 接受一条修正建议 · I-046
 *
 * **这是原句唯一会被改动的入口，而且必须由使用者亲手点。**
 * D-006 / M-015 说「整句原样入库，禁止改写」—— 那条规矩保护的是
 * 「这是我当时真正记下来的东西」。AI 可以指出疑似写错的地方，
 * 但**改不改由他决定**，而且改了要留痕。
 */
export function acceptSuspect(c: StudyCtx, itemId: number, index: number): string {
  const b = c.db
    .prepare(`select content from analysis_blocks where item_id = ? and block = 'suspect'`)
    .get(itemId) as { content: string } | undefined
  if (!b) throw new Error('这一条没有待确认的修正建议。')

  const list = JSON.parse(b.content) as { was: string; should: string; why?: string }[]
  const s = list[index]
  if (!s) throw new Error('找不到这一条建议。')

  const it = c.db.prepare(`select term from items where id = ?`).get(itemId) as
    | { term: string }
    | undefined
  if (!it) throw new Error(ITEM_NOT_FOUND)
  if (!it.term.includes(s.was)) {
    throw new Error(`原句里已经没有「${s.was}」了 —— 可能之前改过。`)
  }

  const t = now()
  const next = it.term.replace(s.was, s.should)
  c.db.prepare(`update items set term = ?, updated_at = ? where id = ?`).run(next, t, itemId)
  // 出处也跟着改 —— 否则原文摘句和条目对不上（M-012）
  c.db
    .prepare(
      `update occurrences set quote = replace(quote, ?, ?), updated_at = ?
          where item_id = ? and quote like ?`
    )
    .run(s.was, s.should, t, itemId, `%${s.was}%`)

  /**
   * 改过什么要留痕 —— 以后回头看「这句我当时到底是怎么记的」还查得到。
   * 存成条目自己的一个区块：跟着条目走、跟着同步走、详情页看得见，
   * 而且不用为一条审计记录再加一张表。
   */
  const prevLog = c.db
    .prepare(`select content from analysis_blocks where item_id = ? and block = 'corrections'`)
    .get(itemId) as { content: string } | undefined
  const log = prevLog ? (JSON.parse(prevLog.content) as unknown[]) : []
  log.push({ was: s.was, should: s.should, why: s.why ?? '', at: t })
  c.db
    .prepare(
      `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
         values (?, 'corrections', ?, ?, ?)
         on conflict(item_id, block) do update set content = excluded.content, updated_at = excluded.updated_at`
    )
    .run(itemId, JSON.stringify(log), t, t)

  const rest = list.filter((_, i) => i !== index)
  if (rest.length === 0) c.self.dismissSuspects(itemId)
  else {
    c.db
      .prepare(
        `update analysis_blocks set content = ?, updated_at = ? where item_id = ? and block = 'suspect'`
      )
      .run(JSON.stringify(rest), t, itemId)
  }
  return next
}

/**
 * 改一条知识点的正文 · T-9.14（D-478 ③ · 使用者「两端都保留改词头释义」）
 *
 * ── 判据不在这里 ──────────────────────────────────────────
 *
 * 「改哪几列 · 留痕写什么 · 能不能改」全在 `@core/analysis/edit.ts::planItemEdit`
 * （两端同一份，见那个文件的头注）。这一层只做三件事：把旧值读出来、
 * 把计划**在一个事务里**执行掉、把新词条交回去。
 *
 * ── 三条硬约束，与 Android `db/edit-item.ts` 逐字同款 ──────
 *
 * ① **uid 不变、不新建条目**：`items.uid` 是同步身份。换 uid = 对面看见
 *    「删了一条、又来了一条新的」，学习史与归属全断。所以这里只有 `update`。
 * ② **出处摘句跟着改**（M-012）：词条从 `tangle up` 改成 `tangle with`，
 *    而 `occurrences.quote` 还写着旧的 —— 认读卡照着它挖空就挖不中了。
 *    做法与 `acceptSuspect` 逐字同款（那是本仓改词条的另一个入口）。
 * ③ **每改一列留一笔痕**（`corrections` 区块）：`field` 是失效判定认的键。
 *
 * ★ 解析块**一个字不动**（D-468 取消了「改」）：改的是词条正文，不是解析。
 *   改完解析算不算过时，由 `stale.ts::staleAfterEdit` 在详情页上说一句，
 *   **不自动删、不自动重跑** —— 解析很贵，而他可能只是改了个大小写。
 */
export function editItem(c: StudyCtx, itemId: number, input: ItemEditInput): string {
  const cur = c.db
    .prepare(
      `select term, gloss, gloss_zh as glossZh from items where id = ? and deleted_at is null`
    )
    .get(itemId) as { term: string; gloss: string; glossZh: string } | undefined
  if (!cur) throw new Error('这条知识点不在了 —— 可能已经被删掉。')

  const t = now()
  // 拒绝的两种（词条空了 / 一个字没改）由 core 抛，抛出来的就是给他看的那句话
  const plan = planItemEdit(cur, input, t)

  const prevLog = c.db
    .prepare(`select content from analysis_blocks where item_id = ? and block = 'corrections'`)
    .get(itemId) as { content: string } | undefined
  const log = [...(prevLog ? (JSON.parse(prevLog.content) as unknown[]) : []), ...plan.log]

  c.db.transaction(() => {
    // ★ 列名来自 core 的白名单，不来自输入（`EDITABLE_COLUMNS`）
    const sets = plan.columns.map((x) => `${x.column} = ?`).join(', ')
    c.db
      .prepare(`update items set ${sets}, updated_at = ? where id = ?`)
      .run(...plan.columns.map((x) => x.value), t, itemId)

    if (plan.termChanged) {
      c.db
        .prepare(
          `update occurrences set quote = replace(quote, ?, ?), updated_at = ?
              where item_id = ? and quote like ?`
        )
        .run(plan.termWas, plan.termNow, t, itemId, `%${plan.termWas}%`)
    }

    c.db
      .prepare(
        `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
           values (?, 'corrections', ?, ?, ?)
           on conflict(item_id, block) do update set
             content = excluded.content, updated_at = excluded.updated_at`
      )
      .run(itemId, JSON.stringify(log), t, t)
  })()

  return plan.termNow
}

/** 忽略全部建议。原句本来就没动过，这里只是把这一块收起来。 */
export function dismissSuspects(c: StudyCtx, itemId: number): void {
  c.db
    .prepare(`delete from analysis_blocks where item_id = ? and block = 'suspect'`)
    .run(itemId)
}

/**
 * ★ D-468（2026-09-07）· 手动编辑一个区块（D-149）与「交还给 AI」两条写入路径删了。
 *
 * 使用者取消了详情页每一块旁边的「改」，这两个函数就此没有调用方。
 * **`analysis_blocks.edited` 那一列留着不读**（D-216 只增不删）：
 * 他以前手改过的块，`planWrites` 照旧认那个标记、重新生成时照旧跳过 ——
 * 只是从今往后没有新的手改产生。
 */
