import type { Database } from 'better-sqlite3'
// I-107 · 写原文出处只有这一个入口，四条路径共用同一套规则
import { recordOccurrence } from '../db/repo.ts'
import { promoteOutOfEmpty } from '../db/lecture-status.ts'
import { Ledger } from '../db/ledger.ts'
import { AiError, callAi, extractJson } from './client.ts'
import { resolveSlot } from './config.ts'
import { fill, loadPrompt } from './prompts.ts'
import { chunkText } from '@core/chunk-text.ts'
import { normalizeTerm } from '../db/repo.ts'
import { ALIVE, JOIN_CARD } from '../db/reading-card-sql.ts'
import type { AnalyzeResult, AnalyzeStage } from '@shared/api.ts'

/**
 * 材料分析 · D-072 / D-059 / D-063 修订 / D-225 / D-053
 *
 * **整套编排在主进程**（D-258）—— 界面只发一次 IPC、拿一个结果。
 * 上一版把这套写在了组件里（promptLoad + aiCall + 解析 JSON + 落库），
 * 出问题时分不清是哪一层的错。
 *
 * **每份材料独立分析，结果层面合并去重**（D-063 修订）：五份材料合起来十几万字是常态，
 * 一次喂进去会直接撑爆上下文，而且失败会卡在进度条第一步。
 */

interface RawItem {
  term?: string
  gloss?: string
  glossZh?: string
  layer?: string
  kind?: string
  hitBy?: string[]
  confidence?: number
  quote?: string
  para?: number
  why?: string
}

const KINDS = new Set(['word', 'chunk', 'frame', 'proper', 'grammar'])

/**
 * ★ I-115 · 这一份材料的回复被截断了 —— 但**已经拿到的照常收下**。
 *
 * 他撞到的原报错是两行英文：
 *   `Expected ',' or ']' after array element in JSON at position 23050`
 * 那是回复写到 `max_tokens` 被切断的形状。当时的处理是整份判失败，
 * **AI 已经干完的八成活跟着一起丢**，而他只看到「这份材料没能分析成功」。
 *
 * 现在：救回来的落库，然后如实说清三件事 ——
 * 断了、收了多少、下一步怎么办。**不报是不行的**：
 * 少收了一半而不说，他会以为这篇文章就这么点东西。
 */
function noteTruncated(result: AnalyzeResult, title: string, got: number): void {
  result.truncated ??= []
  result.truncated.push({ title, got })
}

/**
 * 分析收尾 · H-1 / N-2 / ★★ F-2-①
 *
 * ── F-2-① 之后，这一步简单了非常多 ──────────────────────
 *
 * 以前 `analyze` 一开始就把 `lectures.status` 改成 `'analyzing'` ——
 * **那一格原本装着这一讲的真实业务状态，写进去的那一刻它就被销毁了。**
 * 所以收尾时必须靠一个内存变量 `before` 把它还回去；而进程崩掉的时候
 * `before` 跟着没了，启动恢复只能拿 `due_at` 和「有没有知识点」去猜 ——
 * 于是同一份数据，**正常异常退出和崩溃重启会得到不同的状态**（F-2）。
 *
 * 现在 `status` 全程不动。分析中不再是一个业务状态（`analyzing` 已从
 * `LectureStatus` 里移除，界面本来就一次都没读过它）。于是：
 *
 *   · 失败 / 取消 → **什么都不用写**，状态本来就是对的
 *   · 崩溃       → 同上。启动恢复没有任何东西要还原，也就没得猜
 *   · 成功       → 按 F-03 停在 `review`，这是**业务决定**，与恢复无关
 *
 * ── 那个「本来是 empty、却已经有知识点」的情况 ──────────────
 *
 * 唯一还需要动 status 的失败分支：这一讲原本是 `empty`，而它已经有内容了。
 * 那正是 N-1 那条判据，直接调它的**唯一实现** `promoteOutOfEmpty`，
 * 不在这里再写一遍「有内容就该是 review」。
 */
function settleAfterAnalyze(db: Database, lectureId: number, anySuccess: boolean): void {
  if (anySuccess) {
    // D-053 / F-03 · 捞到东西了 → 整批停在待审阅，点了「开始学」才进轮转
    db.prepare(`update lectures set status = 'review', updated_at = ? where id = ?`).run(
      Date.now(),
      lectureId
    )
    return
  }
  /**
   * 一份材料都没做成（key 过期、断网、全部报错，或者他取消了）。
   * 状态从头到尾没被动过 —— 本来是 training 就还是 training，
   * 本来是 review 就还是 review。**一个字都不用写。**
   * 只补一件事：本来是 empty 而现在有内容（比如上一次分析捞到了东西、
   * 这一次全败），交给那条唯一的判据去处理。
   */
  promoteOutOfEmpty(db, lectureId)
}

export interface AnalyzeDeps {
  db: Database
  promptsDir: string
  level: string
  /** 这一次分析的临时指令（预设的 extra，或使用者当场敲的） —— 追加在基线之后 */
  extra?: string
  presetName?: string
  /**
   * 只分析这几份材料 · I-082
   *
   * 使用者：「分析的范围应该可以自己勾，不要一按就全跑。」
   * 不给（undefined）＝ 老行为：这一讲所有**还没分析过**的材料。
   * 给了就**严格按这份名单**来 —— 包括已经分析过的（那就是「重新分析这一份」）。
   */
  materialIds?: number[]
  onStage: (s: AnalyzeStage) => void
  signal?: AbortSignal
  /**
   * I-043 · 分析时就把每条的完整解析做完。
   *
   * D-142 原本把完整解析做成**按需生成**，理由是「一次分析要为几十条全部买单」。
   * 使用者明确要「点进去就有」，并接受这笔钱 —— 所以现在分析完直接补齐。
   * 传进来而不是在这里实现：解析归 Study 管（它掌握 D-149 手改保护和词典例句），
   * 这一层只负责**什么时候调**。
   */
}

/**
 * 把临时指令挂到基线之后。
 *
 * 位置是刻意的：**放在 SYSTEM 的最后**，而不是混进 USER 那段。
 * USER 段里是 JSON 契约和材料正文，往里塞自由文本容易把契约挤糊；
 * 放在 SYSTEM 末尾，它是「附加的判断偏好」，压不掉前面的硬规则。
 */
function withExtra(system: string, extra?: string): string {
  const e = extra?.trim()
  if (!e) return system
  return `${system}\n\n### This material specifically\n\n${e}`
}

export async function analyzeLecture(
  lectureId: number,
  deps: AnalyzeDeps
): Promise<AnalyzeResult> {
  const { db, onStage } = deps

  // D-016 · 一份上传两类产物。原文和「我自己整理的 chunk」**都要分析**，但方式不同：
  //   原文  → AI 全权扫描，提取知识点
  //   chunk → 原句已经原样入库了，AI 只负责**从里面析出成分**（D-056 析出项），
  //           析出项正常进主动/被动 Tab（D-075），原句身份不可变动（M-015）
  // I-082 · 勾了就只跑勾中的那几份；没勾还是「所有没跑过的」
  const pick = deps.materialIds?.filter((n) => Number.isInteger(n)) ?? null
  const materials = (
    pick && pick.length > 0
      ? db
          .prepare(
            `select id, kind, title, content from materials
              where lecture_id = ? and deleted_at is null
                and id in (${pick.map(() => '?').join(',')})
              order by id`
          )
          .all(lectureId, ...pick)
      : db
          .prepare(
            `select id, kind, title, content from materials
              where lecture_id = ? and deleted_at is null and analyzed_at is null
              order by id`
          )
          .all(lectureId)
  ) as { id: number; kind: 'original' | 'chunk'; title: string; content: string }[]

  if (materials.length === 0) {
    throw new Error(
      pick && pick.length > 0
        ? '勾中的材料都不在了 —— 可能刚被删掉。刷新一下再试。'
        : '这个 Lecture 没有待分析的材料 —— 贴过的都已经分析过了。'
    )
  }

  /** 正常路径已经结算过了吗 —— finally 不该重复走一遍 */
  let settled = false

  /**
   * ★★ F-2-① · 这里**不再动 `lectures.status`**。
   *
   * 原来是 `update lectures set status = 'analyzing'` —— 而那一格装的是
   * 这一讲的真实业务状态（training / review / empty），写进去就销毁了。
   * 「分析中」是**运行事实**，不是业务状态：界面从来没读过它
   * （渲染层里 `status === 'analyzing'` 零处引用，进度条走的是组件自己的 `$state`），
   * 它唯一的用处就是给崩溃恢复留个记号 —— 而记号的代价是毁掉真正的事实。
   *
   * 不写它之后：失败、取消、崩溃三条路上 status 都保持原样，
   * **没有任何东西需要还原，也就没有什么可猜**。
   */

  try {
  const cfg = resolveSlot(db, 'heavy')
  const pMaterial = loadPrompt(deps.promptsDir, 'analyze-material')
  const pDerived = loadPrompt(deps.promptsDir, 'extract-derived')

  const result: AnalyzeResult = {
    lectureId,
    total: materials.length,
    done: 0,
    added: 0,
    skipped: [],
    derived: 0,
    upgraded: 0,
    repeats: [],
    failures: [],
    promptSource: pMaterial.source,
    presetName: deps.presetName ?? null
  }

  for (const [i, m] of materials.entries()) {
    if (deps.signal?.aborted) break // D-225 · 可取消，已完成的部分保留

    const jobId = Number(
      db
        .prepare(
          `insert into analysis_jobs (lecture_id, material_id, stage, status, preset_name, created_at, updated_at)
           values (?, ?, 'reading', 'running', ?, ?, ?)`
        )
        .run(lectureId, m.id, deps.presetName ?? null, Date.now(), Date.now()).lastInsertRowid
    )

    const stage = (name: AnalyzeStage['name'], note = ''): void => {
      db.prepare(`update analysis_jobs set stage = ?, updated_at = ? where id = ?`).run(
        name,
        Date.now(),
        jobId
      )
      onStage({ name, materialIndex: i + 1, materialTotal: materials.length, title: m.title, note })
    }

    let found = 0
    try {
      stage('reading')

      if (m.kind === 'chunk') {
        // ── 我自己收集的句子：只析出成分，原句一个字不动 ──────────
        /**
         * ★ I-111 · 母句按 `source_material_id` 反查。
         *
         * 以前这里 join 的是 `occurrences` —— 也就是说「**有没有原文出处**」
         * 决定了这条句子还认不认它的来源材料。两件事被绑在一起，
         * 于是 I-107 收紧出处规则之后，这一步静默查不到母句，整个析出被跳过，
         * 界面只说「一条都没提取到」。出处是证据，可以没有；来源是事实，一直都在。
         */
        const parents = db
          .prepare(
            `select id, term from items
              where source_material_id = ? and deleted_at is null and derived_from is null
              order by id`
          )
          .all(m.id) as { id: number; term: string }[]

        if (parents.length === 0) {
          db.prepare(`update materials set analyzed_at = ?, updated_at = ? where id = ?`).run(
            Date.now(),
            Date.now(),
            m.id
          )
          result.done += 1
          continue
        }

        const listed = parents.map((p, k) => `${k + 1}. ${p.term}`).join('\n')
        const meta: { truncated?: boolean } = {}
        const text = await callAi(
          cfg,
          {
            system: withExtra(fill(pDerived.system, { LEVEL: deps.level }), deps.extra),
            user: fill(pDerived.user, { SENTENCES: listed, LEVEL: deps.level }),
            json: true,
            maxTokens: 6000,
            signal: deps.signal,
            meta
          },
          'heavy'
        )

        stage('extracting')
        const jm: { repaired?: boolean; dropped?: number } = {}
        const parsed = extractJson<{ sentences?: { index?: number; derived?: RawItem[] }[] }>(
          text,
          jm
        )
        const groups = parsed.sentences ?? []
        if (meta.truncated || jm.repaired) {
          noteTruncated(result, m.title, groups.reduce((n, g) => n + (g.derived?.length ?? 0), 0))
        }

        stage('merging', `${groups.reduce((s, g) => s + (g.derived?.length ?? 0), 0)} 个析出项`)
        const w = writeDerived(db, lectureId, m.id, parents, groups)
        result.derived += w.added
        result.suspects = (result.suspects ?? 0) + w.suspects
        result.upgraded += w.upgraded
        result.repeats.push(...w.repeats)
        // 4.1 · 被账本挡掉的要说出来，否则「AI 提到了它、怎么没进来」查不出原因
        result.skipped.push(...w.skipped)
        found = w.added
      } else {
        /**
         * ★ I-115 · 长材料分几段分析。
         *
         * 他两份材料是 24379 / 28189 字符。一次喂进去，模型要为整篇列出所有
         * 值得学的表达 —— 输出超过 `max_tokens`，回复在半路被切断，
         * 界面上只剩一句他看不懂的 `Expected ',' or ']' … at position 23050`。
         *
         * 光把截断的救回来不够：**重试还会断在同一处**，后半篇他永远拿不到。
         * 所以从源头改，按段落边界切开分次喂 —— 和 D-063 修订
         * 「每份材料独立分析、结果层面合并去重」是同一个道理，只是刻度更小。
         */
        const parts = chunkText(m.content)
        const raw: RawItem[] = []
        for (let ci = 0; ci < parts.length; ci++) {
          /**
           * ★ 每一段之前都看一眼「他是不是按了暂停」。
           *
           * 原来只在**每份材料**之前查一次（D-225）。切段之后一份材料可能是 5 次调用，
           * 于是他按下暂停之后还要等最多 5 次 AI 才停 —— 界面上是「点了没反应」，
           * 而这正是 I-001 那一类。已经跑完的段照常收下，不作废。
           */
          if (deps.signal?.aborted) break
          if (parts.length > 1) {
            stage('reading', `第 ${ci + 1}/${parts.length} 段`)
          }
          const meta: { truncated?: boolean } = {}
          const text = await callAi(
            cfg,
            {
              system: withExtra(fill(pMaterial.system, { LEVEL: deps.level }), deps.extra),
              user: fill(pMaterial.user, { MATERIAL: parts[ci]!, LEVEL: deps.level }),
              json: true,
              maxTokens: 8000,
              signal: deps.signal,
              meta
            },
            'heavy'
          )

          stage('extracting')
          const jm: { repaired?: boolean; dropped?: number } = {}
          const parsed = extractJson<{ items?: RawItem[] }>(text, jm)
          const got = Array.isArray(parsed) ? (parsed as RawItem[]) : (parsed.items ?? [])
          if (!Array.isArray(got)) throw new Error('模型返回的 items 不是数组')
          raw.push(...got)
          // 切过之后还断，说明这一段依然太满 —— 照样收下，但要说出来
          if (meta.truncated || jm.repaired) noteTruncated(result, m.title, got.length)
        }

        stage('merging', `${raw.length} 条候选`)
        const w = writeItems(db, lectureId, m.id, raw, m.content)
        result.added += w.added
        result.upgraded += w.upgraded
        result.repeats.push(...w.repeats)
        // 4.1 · 被账本挡掉的要说出来，否则「AI 提到了它、怎么没进来」查不出原因
        result.skipped.push(...w.skipped)
        found = w.added
      }

      db.prepare(`update materials set analyzed_at = ?, updated_at = ? where id = ?`).run(
        Date.now(),
        Date.now(),
        m.id
      )
      db.prepare(
        `update analysis_jobs set stage='done', status='ok', found = ?, updated_at = ? where id = ?`
      ).run(found, Date.now(), jobId)
      result.done += 1
    } catch (err) {
      // D-072 · 失败必须指明**是哪一份材料**，已成功的部分保留不作废
      const failure =
        err instanceof AiError
          ? err.failure
          : {
              kind: 'format' as const,
              title: '这份材料没能分析成功',
              detail: err instanceof Error ? err.message : String(err),
              actions: ['retry' as const, 'removeMaterial' as const],
              consecutive: 1
            }
      db.prepare(
        `update analysis_jobs set status='failed', error_kind=?, error_msg=?, updated_at=? where id=?`
      ).run(failure.kind, failure.detail.slice(0, 2000), Date.now(), jobId)
      result.failures.push({ materialId: m.id, title: m.title, failure })
    }
  }

  /**
   * ★ I-104 · 完整解析**不在这里做了**。
   *
   * 使用者：「整体分析指的是先整体分析一遍，把知识点匹配、分析到我的收集、
   *          主动和被动里面，但是知识点的详细分析…需要点击分析里面的
   *          『我的收集』『主动词汇』『被动词汇』进行单独的详细分析。」
   *
   * 拆开的理由不只是他要：这一步是**按条计费**的，一份材料捞出五十条就是五十次调用。
   * 混在提取里，等于「点一次分析」= 一笔说不清多大的账，而且中途想停也停不干净。
   * 拆开之后：提取是一次性的、便宜的；详解是按类别、可暂停、断点续跑的（见 study.analyseScope）。
   */
  // D-053 · AI 后台自动归档，不做批量审批。
  // 但按 F-03 停在「待审阅」—— 整批一个确认动作，点了才进轮转。
  const anySuccess = result.added > 0 || result.done > 0
  settleAfterAnalyze(db, lectureId, anySuccess)
  settled = true
  db.prepare(
    `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
     values (?, 'analyzed', ?, ?, ?)`
  ).run(
    lectureId,
    `分析 ${result.done}/${result.total} 份 → 新增 ${result.added} 条` +
      (result.failures.length ? ` · ${result.failures.length} 份失败` : ''),
    Date.now(),
    Date.now()
  )

  return result
  } finally {
    /**
     * ★★ F-2-① · 异常路径的收尾：**几乎什么都不做，这正是要的**。
     *
     * `settled` 为真说明正常路径已经按 F-03 结算过了 —— 那是有意的语义，不覆盖。
     * 只有异常路径（抛错、rejection、取消）才走到这里，而 `status` 从头到尾
     * 没被动过 —— 他这一讲本来在轮转就还在轮转，本来待审阅就还待审阅，
     * **没有任何东西需要"放回去"**。
     *
     * 唯一还要判一次的是 N-1 那条：本来是 `empty`，但这次已经捞到了几条
     * 才失败的 —— 部分结果保住了，就不该继续叫「空」。那条判据不在这里写，
     * 走 `promoteOutOfEmpty` 的唯一实现（见 `settleAfterAnalyze`）。
     *
     * 这里不吞异常 —— 只收拾状态，错照样往上抛，界面该报还是报。
     */
    if (!settled) {
      try {
        // 异常路径：这次一份都没做成 → anySuccess = false。
        // status 从头到尾没被动过，这里通常什么都不写（见 settleAfterAnalyze）
        settleAfterAnalyze(db, lectureId, false)
      } catch {
        /* 收状态本身再失败就只能算了 —— 启动自愈那一层还会再兜一次 */
      }
    }
  }
}

/**
 * 析出项落库 · D-016 / D-056 / D-075 / M-015
 *
 * 「一份上传两类产物：**整条原句** → 我的上传库，永不拆、不去重、不出产出题；
 *  **AI 拆出的析出项** → 进写作层扫描，与 AI 从原文提取的合并去重。」
 *
 * 关键约束：**原句一个字不动**。这里只新建析出项，并用 `derived_from` 指回它的母句
 * （D-148 整句拆解要靠这个字段列出各成分及其当前状态）。
 * 析出项带 source='self'（D-075 蓝色标记），正常进主动/被动 Tab。
 */
function writeDerived(
  db: Database,
  lectureId: number,
  materialId: number,
  parents: { id: number; term: string }[],
  groups: {
    index?: number
    derived?: RawItem[]
    /** I-046 · 疑似打错 / 听岔的地方。**原句一个字不改**，只是摆出来给他看 */
    suspect?: { was?: string; should?: string; why?: string }[]
  }[]
): {
  added: number
  upgraded: number
  repeats: AnalyzeResult['repeats']
  suspects: number
  skipped: { term: string; verdict: string }[]
} {
  const t = Date.now()
  let added = 0
  let upgraded = 0
  let suspects = 0
  const repeats: AnalyzeResult['repeats'] = []
  const skipped: { term: string; verdict: string }[] = []
  const ledger = new Ledger(db)

  const tx = db.transaction(() => {
    for (const g of groups) {
      const parent = parents[(g.index ?? 0) - 1]
      if (!parent) continue

      /**
       * I-046 · 疑似写错的地方存成母句上的一个区块。
       * **原句一个字都没动** —— D-006 保护的是「这是我当时真正记下来的东西」。
       * 界面上摆出来，由使用者一键接受或忽略。
       */
      const sus = (g.suspect ?? []).filter((x) => x.was?.trim() && x.should?.trim())
      if (sus.length > 0) {
        db.prepare(
          `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
           values (?, 'suspect', ?, ?, ?)
           on conflict(item_id, block) do update set content = excluded.content, updated_at = excluded.updated_at`
        ).run(parent.id, JSON.stringify(sus), t, t)
        suspects += sus.length
      }

      for (const r of g.derived ?? []) {
        const term = (r.term ?? '').trim()
        if (!term) continue
        // 析出项不该等于母句本身 —— 那条已经在库里了
        if (normalizeTerm(term) === normalizeTerm(parent.term)) continue
        // 4.1 · 他以前删过 / 静默过的说法，析出这边也不再收
        const verdict = ledger.verdictOf(term, lectureId)
        if (verdict) {
          skipped.push({ term, verdict })
          continue
        }

        const kind = KINDS.has(r.kind ?? '') ? r.kind! : 'chunk'
        /**
         * ★★ ⑩（2026-09-01 使用者）：**新知识点一律先进认读 A**。
         *
         * 原话：「所有刚刚新增进入 Nyx 的知识点，默认都必须是『认读』状态……
         * 只有用户之后主动重新设置，知识点才可以变成『练习』等其他状态。」
         * 并且逐条点名了「Windows 分析文件产生的知识点 → 默认认读」。
         *
         * 这里原来是 `r.layer === 'B' ? 'B' : 'A'` —— **由 AI 决定进不进产出线**
         * （M-011）。⑩ 把这个决定权收回给使用者：AI 只负责挑出词条，
         * 「要不要练它」由他事后自己定。
         */
        const layer = 'A'

        const prior = db
          .prepare(
            `select i.id, i.layer, i.production_state as st, rc.silent as cs
               from items i ${JOIN_CARD('i')}
              where ${ALIVE('i')} and lower(trim(i.term)) = ? limit 1`
          )
          .get(normalizeTerm(term)) as
          | { id: number; layer: string; st: string; cs: number }
          | undefined

        let itemId: number
        if (prior) {
          itemId = prior.id
          /**
           * ★★ ⑩：**不再自动把 A 升成 B**。
           * 原先重新分析同一篇材料时，AI 若判它是 B 就当场把库里那条从
           * 认读升成产出 —— 那正是「知识点自己变成练习」的那条路。
           * 现在 layer 恒为 'A'，这段升格逻辑没有触发条件，整段删掉，
           * 免得留一段永远走不到的代码让人以为它还在起作用。
           * ★ `upgraded` 计数保留（对外契约），恒为 0。
           */
          // 6.3 · 同一讲里再次出现不算重复收集（多半是重传了同一份材料）
          const crossLecture = isNewLectureFor(db, prior.id, lectureId)
          if (crossLecture) {
            db.prepare(
              `update items set recollected_count = recollected_count + 1, updated_at = ? where id = ?`
            ).run(t, prior.id)
          }
          const wasSilent = prior.st === 'silent' || prior.cs !== 0
          repeats.push({
            term,
            priorItemId: prior.id,
            wasSilent,
            note: wasSilent
              ? '这条已经算练成了，你却又把它所在的句子收了下来 —— 当初可能判早了'
              : '库里已经有这条了'
          })
        } else {
          itemId = Number(
            db
              .prepare(
                `insert into items (term, gloss, gloss_zh, layer, kind, source, owner_lecture_id,
                                    confidence, derived_from, created_at, updated_at)
                 values (?, ?, ?, ?, ?, 'self', ?, ?, ?, ?, ?)`
              )
              .run(
                term,
                (r.gloss ?? '').trim(),
                (r.glossZh ?? '').trim(),
                layer,
                kind,
                lectureId,
                typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
                parent.id,
                t,
                t
              ).lastInsertRowid
          )
          added += 1
        }

        db.prepare(
          `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
           values (?, ?, ?, ?, ?)
           on conflict(item_id, lecture_id) do update set
             deleted_at = null, updated_at = excluded.updated_at
           where item_lectures.deleted_at is not null`
        ).run(itemId, lectureId, prior ? 0 : 1, t, t)

        /**
         * M-012 · 析出项的原文出处。走唯一入口（I-107）。
         * 使用者：「从我的收集中析出来的知识点，也按照原文文件里面的内容进行原文摘录」。
         * 母句只当**候选**用 —— 它是他自己摘的那一行，往往比原文短，
         * 甚至只剩这个表达本身；`recordOccurrence` 会校验它是不是真在原文里。
         */
        recordOccurrence(db, itemId, lectureId, term, {
          fallback: parent.term,
          materialId
        })

        if (r.why?.trim()) {
          db.prepare(
            `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
               values (?, 'summary', ?, ?, ?)
               on conflict(item_id, block) do nothing`
          ).run(itemId, r.why.trim(), t, t)
        }
      }
    }
  })

  tx()
  return { added, upgraded, repeats, suspects, skipped }
}

/** 落库 + 合并去重 · D-041 / D-089 / D-026 / M-012 */
/**
 * 从原文里把**这条表达所在的那一整句**摘出来 · I-044 / M-012
 *
 * 以前直接用 AI 在提取时顺手给的 `quote` —— 它可能被截断、被改写，
 * 甚至是模型自己造的句子。而 M-012 说「知识点入库必须携带原文出处」，
 * 出处的意义就在于**它是原文里真实存在的那一句**。
 *
 * 所以改成：在材料正文里定位这条表达，向两边扩到句子边界。
 * 找得到就用真的那一句（AI 给的一律不要）；实在找不到（表达被改写过、
 * 或者跨句）才退回 AI 那条，并且**在界面上是同一个字段**，
 * 不需要额外解释 —— 找不到的情况本来就少。
 *
 * 句子边界只认 `. ! ?` 后面跟空白，且前面不是常见缩写（Mr. / e.g. / U.S. …），
 * 否则 "Dr. Smith said" 会被切成两句。
 */
/**
 * ★★ 2026-09-14 · 这里原来是 `/<退格>(?:mr|…)/` —— `\b` 在某次生成里被吃成了
 *   一个**字面的退格字符**（`\x08`），于是这条判据**永远不匹配**：
 *   `Dr. Smith said` 一直被切成两句，而这一段正是用来给知识点找出处的。
 *   源码里看不出来（它是不可见字符），`check` 也不会红 —— 只有拿
 *   `grep -P "[\x00-\x08…]"` 扫控制字符才找得到。（同侪 Nyx-UI-Android 提示的扫法。）
 *
 * ★ 同一条判据在 `core/quote.ts::sentences` 里还有一份，**那一份是对的**。
 *   两份缩写表的内容也不完全一样（core 那份多 `cf`）。
 *   没在这一笔里合并：合并要动分句行为，得单独一笔、单独验。
 *   先把哑掉的这一份修活 —— 它现在是错的，而不只是重复的。
 */
const ABBR = /\b(?:mr|mrs|ms|dr|prof|st|jr|sr|vs|etc|e\.g|i\.e|approx|fig|no|vol|u\.s|u\.k)\.$/i

function sentenceAround(text: string, term: string): string | null {
  if (!text || !term) return null
  const hay = text.toLowerCase()
  const needle = term.toLowerCase().trim()
  let at = hay.indexOf(needle)
  if (at < 0) {
    // 表达在原文里可能有变形（时态、单复数）。退一步：用最长的那个词定位
    const word = [...needle.split(/[^a-z'-]+/)].filter((w) => w.length > 3).sort((a, b) => b.length - a.length)[0]
    if (!word) return null
    at = hay.indexOf(word)
    if (at < 0) return null
  }

  // 往前找句首
  let start = 0
  for (let i = at; i > 0; i--) {
    const ch = text[i - 1]
    if ((ch === '.' || ch === '!' || ch === '?' || ch === '\n') && /\s/.test(text[i] ?? ' ')) {
      if (ch !== '\n' && ABBR.test(text.slice(Math.max(0, i - 8), i))) continue
      start = i
      break
    }
  }
  // 往后找句尾
  let end = text.length
  for (let i = at + needle.length; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') {
      end = i
      break
    }
    if ((ch === '.' || ch === '!' || ch === '?') && /\s|$/.test(text[i + 1] ?? ' ')) {
      if (ABBR.test(text.slice(Math.max(0, i - 7), i + 1))) continue
      end = i + 1
      break
    }
  }

  const out = text.slice(start, end).replace(/\s+/g, ' ').trim()
  // 太短说明没切对；太长说明这段根本没有句号，都不如不给
  if (out.length < 12 || out.length > 600) return null
  return out
}

/**
 * 重复收集的判据 · 使用者 6.3
 *
 * 「**算**重复收集：不同 Lecture 中再次出现完全相同的知识点。
 *   **不算**：同一 Lecture 因误操作重新上传了相同材料。」
 *
 * 以前的判据是「库里已经有这条 → 计数 +1」，于是把同一讲重传一次材料
 * 也算成了「又遇到一次」。那不是学习信号，那是操作失误 ——
 * 而 D-026 的「重复收集」是要**提示这条表达在你的阅读里反复出现**，
 * 计数被误操作污染之后，这个提示就不再可信。
 */
function isNewLectureFor(db: Database, itemId: number, lectureId: number): boolean {
  const r = db
    .prepare(`select 1 as x from item_lectures where item_id = ? and lecture_id = ? and deleted_at is null`)
    .get(itemId, lectureId)
  return !r
}

function writeItems(
  db: Database,
  lectureId: number,
  materialId: number,
  raw: RawItem[],
  /** 材料正文 —— 用来把出处摘成**原文里真实的那一整句**（I-044 / M-012） */
  source: string
): {
  added: number
  upgraded: number
  repeats: AnalyzeResult['repeats']
  skipped: { term: string; verdict: string }[]
} {
  const t = Date.now()
  let added = 0
  let upgraded = 0
  const repeats: AnalyzeResult['repeats'] = []
  /** 因为账本而没收进来的 —— 界面上要说清，不能悄悄少几条 */
  const skipped: { term: string; verdict: string }[] = []

  const ledger = new Ledger(db)
  const tx = db.transaction(() => {
    for (const r of raw) {
      const term = (r.term ?? '').trim()
      if (!term) continue

      /**
       * ★ 4.1 · 账本先过一道。
       *
       * 使用者：「后续遇到相同表达时，自动判断是否已删除/静默，
       *          不再重复分析进知识库或 Lecture。」
       *
       * 他删掉一个说法通常意味着「这个我不需要」；静默意味着「这个我已经会了」。
       * 两种情况下再把它捞回来，都是在浪费他的注意力 —— 而注意力是这软件里最贵的东西。
       *
       * 跳过要**记一笔**（skipped），否则「AI 明明提到了它，怎么没进来」
       * 会变成一个查不出来的谜。
       */
      const verdict = ledger.verdictOf(term, lectureId)
      if (verdict) {
        skipped.push({ term, verdict })
        continue
      }

      // M-010 / D-041 · 两次扫描都命中 → 层级升为 B
      const hitBoth = Array.isArray(r.hitBy) && r.hitBy.length >= 2
      const kind = KINDS.has(r.kind ?? '') ? r.kind! : 'chunk'
      // M-011 · 专有名词只做理解，永远不进产出训练
      const layer = kind === 'proper' ? 'A' : hitBoth || r.layer === 'B' ? 'B' : 'A'
      // I-044 · 先从这一份材料里摘整句 —— 它最贴题（知识点就是从这份里捞出来的）
      const quote = sentenceAround(source, term)

      const prior = db
        .prepare(
          `select i.id, i.layer, i.production_state as st, rc.silent as cs,
                  i.owner_lecture_id as owner
             from items i ${JOIN_CARD('i')}
            where ${ALIVE('i')} and lower(trim(i.term)) = ? limit 1`
        )
        .get(normalizeTerm(term)) as
        | { id: number; layer: string; st: string; cs: number; owner: number | null }
        | undefined

      let itemId: number

      if (prior) {
        itemId = prior.id
        // D-041 · A 升 B（只升不降 —— 既需读懂又值得会用的，按更高标准训练）
        if (prior.layer === 'A' && layer === 'B') {
          db.prepare(`update items set layer='B', source='both', updated_at=? where id=?`).run(
            t,
            prior.id
          )
          upgraded += 1
        }
        // D-026 · 与库中已有重合 → 特殊标记。6.3 · 只有**跨 lecture** 才算
        if (isNewLectureFor(db, prior.id, lectureId)) {
          db.prepare(
            `update items set recollected_count = recollected_count + 1, updated_at = ? where id = ?`
          ).run(t, prior.id)
        }

        const wasSilent = prior.st === 'silent' || prior.cs !== 0
        repeats.push({
          term,
          priorItemId: prior.id,
          wasSilent,
          fromOtherLecture: prior.owner !== null && prior.owner !== lectureId,
          note: wasSilent
            ? '这条已经算练成了，现在又在材料里出现 —— 当初可能判早了'
            : '库里已经有这条了'
        })
      } else {
        itemId = Number(
          db
            .prepare(
              `insert into items (term, gloss, gloss_zh, layer, kind, source, owner_lecture_id,
                                  confidence, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              term,
              (r.gloss ?? '').trim(),
              (r.glossZh ?? '').trim(),
              layer,
              kind,
              hitBoth ? 'both' : 'ai',
              lectureId,
              typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
              t,
              t
            ).lastInsertRowid
        )
        added += 1
      }

      // D-089 · 条目全局唯一，但后续 lecture 的列表仍显示它
      db.prepare(
        `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
         values (?, ?, ?, ?, ?)
           on conflict(item_id, lecture_id) do update set
             deleted_at = null, updated_at = excluded.updated_at
           where item_lectures.deleted_at is not null`
      ).run(itemId, lectureId, prior ? 0 : 1, t, t)

      /**
       * M-012 ★ 原文出处是不可丢失的字段。D-152：多处出现全部保留。
       *
       * ★ I-107 · 走唯一入口。以前这里是「摘不到就无条件用 AI 给的 quote」——
       * 而 AI 经常把原句顺一遍再返回，看着像原文、一个词都对不上。
       * 现在 AI 给的那一段只是**候选**，必须能在原文里找到才采用。
       */
      /**
       * ★★ Step 2 · C-1 · 这里原来自己拼一句 INSERT，绕过了 I-107 定的唯一入口。
       * 绕过去的代价现在看得见了：确定性身份、`on conflict do nothing`、
       * 「重新分析不长第二条」这三样它一样都没有。
       * 改成走同一个入口 —— `exact` 表示「这一段已经验过是原文里的，直接用」。
       */
      recordOccurrence(db, itemId, lectureId, term, {
        exact: quote ?? null,
        fallback: (r.quote ?? '').trim() || null,
        materialId,
        para: r.para ?? null
      })

      // 摘要级解析 · D-142 前半：分析时给每条写两三句，供列表用
      if (r.why?.trim()) {
        db.prepare(
          `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
             values (?, 'summary', ?, ?, ?)
             on conflict(item_id, block) do nothing`
        ).run(itemId, r.why.trim(), t, t)
      }
    }
  })

  tx()
  return { added, upgraded, repeats, skipped }
}
