import { SYNC_INCOMPLETE_TITLE } from '@core/sync/copy.ts'
import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from '@core/silence.ts'
import type { Database } from 'better-sqlite3'
import { PRODUCTION_APPLIES } from './silence-sql.ts'
import { ALIVE, JOIN_CARD } from './reading-card-sql.ts'
import { findQuoteIn } from '@core/quote.ts'
import { BUILTIN_IDENTITY_KEY, SYNC_TABLES } from './migrations.ts'
import { backfillQuotes, originalTextsOf } from './repo.ts'
import { lastHealProblems } from './startup-heal.ts'
import { lastSyncProblems } from '../sync/problems.ts'

/**
 * 数据体检 · 使用者 9.1 / 9.2
 *
 * 「全面检查所有数据之间的关联逻辑、算法、调度、统计计算。
 *   对整个项目做一次系统性大检查，指出不合理之处并修正。」
 *
 * ── 为什么做成代码而不是写一份报告 ──────────────────────────
 *
 * 一次性的人工检查只能证明「**那一刻**是对的」。这个库每天都在被写入，
 * 而这里绝大多数问题的性质是**静默的**：数据悄悄不一致，界面照常显示，
 * 等他发现时已经过去很久（22 本词典那次就是这个形状）。
 *
 * 所以写成可反复跑的不变量检查，并且**给他一个按钮自己跑** ——
 * 他零编程经验，能自己验证「它真的在工作」这件事本身就是价值（D-265）。
 *
 * ── 每条不变量都对应一种真实会发生的坏法 ────────────────────
 *
 * 不写「看着应该成立」的检查。每一条下面都注明**违反之后他会看到什么**，
 * 写不出这句话的检查就不该存在 —— 那种检查只会制造噪音，
 * 而噪音多了之后真正的告警就没人看了。
 */

export type Severity = 'error' | 'warn'

export interface Finding {
  id: string
  severity: Severity
  /** 一句话说清发现了什么 */
  title: string
  /** 违反之后他会看到什么 —— 没有这句就不该有这条检查 */
  impact: string
  count: number
  /** 几个例子，够他自己去核对 */
  samples: string[]
}

type Check = (db: Database) => Finding | null

const rows = <T>(db: Database, sql: string, ...args: unknown[]): T[] =>
  db.prepare(sql).all(...args) as T[]

/**
 * I-114 · 哪些出处是「等于词条、但原文里找得到更好的」。
 * 判据和 `repair()` 修的那一批**必须是同一个函数算出来的** ——
 * 报出来 N 条、修完还剩 N 条，是最伤信任的一种。
 */
function backfillable(db: Database): string[] {
  const flat = (x: string): string => (x ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const out: string[] = []
  for (const l of rows<{ id: number }>(db, `select id from lectures where deleted_at is null`)) {
    const texts = originalTextsOf(db, l.id)
    if (!texts.some((x) => x?.trim())) continue
    for (const r of rows<{ quote: string; term: string }>(
      db,
      `select o.quote, i.term from occurrences o join items i on i.id = o.item_id
        where o.lecture_id = ? and i.deleted_at is null`,
      l.id
    )) {
      if (flat(r.quote) !== flat(r.term)) continue
      const q = findQuoteIn(texts, r.term)
      if (q && flat(q) !== flat(r.term)) out.push(r.term)
    }
  }
  return out
}

function finding(
  id: string,
  severity: Severity,
  title: string,
  impact: string,
  list: { label: string }[]
): Finding | null {
  if (list.length === 0) return null
  return {
    id,
    severity,
    title,
    impact,
    count: list.length,
    samples: list.slice(0, 5).map((x) => x.label)
  }
}

const CHECKS: Check[] = [
  // ── 关联：孤儿与断链 ────────────────────────────────────────
  (db) =>
    finding(
      'item-no-lecture',
      'error',
      '有知识点不属于任何 lecture',
      '它在任何列表里都出不来，也不进任何测试 —— 等于花钱分析完就丢了',
      rows<{ label: string }>(
        db,
        `select i.id || ' · ' || i.term as label from items i
          where i.deleted_at is null
            and not exists (select 1 from item_lectures il where il.item_id = i.id and il.deleted_at is null)`
      )
    ),
  (db) =>
    finding(
      'live-child-dead-parent',
      'error',
      '有活着的 lecture 挂在已删除的单元/项目下',
      '项目栏里看不见它，但它照样进今日队列 —— 「哪来的题」查不出来源',
      rows<{ label: string }>(
        db,
        `select l.id || ' · ' || l.name as label from lectures l
           join units u on u.id = l.unit_id
           join projects p on p.id = u.project_id
          where l.deleted_at is null and (u.deleted_at is not null or p.deleted_at is not null)`
      )
    ),
  (db) =>
    finding(
      'live-unit-dead-project',
      'error',
      '有活着的单元挂在已删除的项目下',
      '同上：路径断在上游，恢复出来的东西看不见',
      rows<{ label: string }>(
        db,
        `select u.id || ' · ' || u.name as label from units u
           join projects p on p.id = u.project_id
          where u.deleted_at is null and p.deleted_at is not null`
      )
    ),

  // ── 出处 · M-012 / I-107 ───────────────────────────────────
  (db) =>
    finding(
      'quote-equals-term',
      'warn',
      '有**析出/提取**的条目，原文出处等于它自己',
      '认读卡照它挖空会挖出一个空题面；笔记导出里也看不出上下文（M-012）',
      /**
       * ★ 只查析出和提取来的条目。
       *
       * 「我的收集」那些整句（`kind='sentence'` 且 `source='self'`）
       * **本来就是句子本身** —— 出处等于词条是它的正常形态，
       * 没有比它更好的东西可指。第一版没排除它们，
       * 结果每收一句就报一条 —— 那种噪音会让整个体检失去意义。
       */
      rows<{ label: string }>(
        db,
        `select i.term as label from occurrences o join items i on i.id = o.item_id
          where i.deleted_at is null
            and not (i.kind = 'sentence' and i.source = 'self')
            and lower(trim(o.quote)) = lower(trim(i.term))`
      )
    ),

  /**
   * ★ I-114 · 出处等于词条，**而原文里明明找得到那一整句**。
   *
   * 上面那条把「我的收集」整句排除掉了，理由是「它本来就是句子本身，
   * 没有比它更好的东西可指」。在他真实的库上，这个理由不成立 ——
   * 他打进去的是自己顺过的说法（`The power of disposal of modern nation states`），
   * 原文里躺着的是 `You compare that to the powers at the disposal of
   * modern nation-states, and you can see the contrast.`
   * 他 108 条「出处 = 词条」里，**89 条回原文里一找就有**。
   *
   * 所以判据不该是「它是什么来路」，而是**原文里到底有没有更好的**。
   * 有，就是欠着；没有，那才是它的正常形态。
   * 这条能自动修（`repair()` 里调 `backfillQuotes`），因为方向是唯一的：
   * 用原文里真实的那一句替掉一个复述，只会更接近 M-012。
   */
  (db) =>
    finding(
      'quote-backfillable',
      'warn',
      '有条目的出处等于它自己，而原文里找得到那一整句',
      '认读卡挖不出空、导出的笔记没有上下文；点「修掉能修的」就会补回来',
      backfillable(db).map((label) => ({ label }))
    ),

  // ── 两条线的状态自洽 · D-014 / D-017 ───────────────────────
  (db) =>
    finding(
      'silent-but-due',
      'error',
      '有条目已经不用再练，认读卡却还排着到期日',
      '练成是封闭的（D-024）—— 排着期就会从认读那边冒出来，「明明练成了还在考我」',
      rows<{ label: string }>(
        db,
        `select i.id || ' · ' || i.term as label from items i ${JOIN_CARD('i')}
          where ${ALIVE('i')} and rc.silent = 1 and rc.due_at is not null`
      )
    ),
  (db) =>
    finding(
      'streak-over-three',
      'warn',
      '有条目连续正确已达 3 次，却还没算练成',
      '「3 连正确即练成」是这套方法的核心检验（D-017）—— 不生效的话它会一直排下去',
      rows<{ label: string }>(
        db,
        `select id || ' · ' || term as label from items
          where deleted_at is null and streak >= 3 and production_state <> 'silent'
            and ${PRODUCTION_APPLIES('items')}`
      )
    ),
  (db) =>
    finding(
      'silenced-by-orphan',
      'warn',
      `有条目标着「因上级${SILENCE_ACTIONS.shelve}」，但上级其实没有`,
      `上级${SILENCE_ACTIONS.restore}时它出不来 —— 会永远留在「${SILENCE_FILTER_NAME}」里（4.2）`,
      rows<{ label: string }>(
        db,
        `select i.id || ' · ' || i.term as label from items i
          where i.deleted_at is null and i.silenced_by in ('project', 'unit', 'lecture')
            and not exists (
              select 1 from item_lectures il
                join lectures l on l.id = il.lecture_id
                join units u on u.id = l.unit_id
                join projects p on p.id = u.project_id
               where il.item_id = i.id and il.deleted_at is null
                 and (l.silent = 1 or u.silent = 1 or p.silent = 1))`
      )
    ),

  // ── 调度 · D-017 / D-028 ───────────────────────────────────
  (db) =>
    finding(
      'silent-lecture-due',
      'error',
      `有 lecture 已${SILENCE_FILTER_NAME}，却还排着到期日`,
      `${SILENCE_FILTER_NAME}了还在催他练 —— 他会觉得「${SILENCE_ACTIONS.shelve}」这个按钮没用`,
      rows<{ label: string }>(
        db,
        `select id || ' · ' || name as label from lectures
          where deleted_at is null and silent = 1 and due_at is not null`
      )
    ),
  (db) =>
    finding(
      /**
       * ★★ D-4 · 这条检查以前是**死的**。
       *
       * 原来查的是 `status = 'ready'` —— 而这个状态值根本不存在
       * （当时合法的是 empty / analyzing / review / training；F-2-① 之后 analyzing 也退出了）。
       * 所以它永远不会红。
       * 更糟的是 `repo.setSilent` 里恢复 due_at 的判据用的是同一个错名字，
       * 于是「取消静默不恢复排期」这个 bug 和「抓它的检查」**一起瞎了**：
       * bug 一直在，而体检永远报「都通过」。
       *
       * 报警器不响的时候没人会去怀疑报警器 —— 所以这条现在有一条
       * 「故意造坏数据 → 它必须红」的用例守着（见 tests/db-safety.ts）。
       *
       * 不变量本身也收窄了一层：**必须带上 `silent = 0`**。
       * 静默的讲 due_at 本来就该是 null（那是「归档不排期」的正常形态），
       * 只写 `status = 'training' ⇒ due_at ≠ null` 会把它们全部误报。
       */
      'training-without-due',
      'warn',
      '有 lecture 在练，却没有到期日',
      '它永远不会出现在「今日」里 —— 今日队列要求 status=training 且 due_at 不为空',
      rows<{ label: string }>(
        db,
        `select id || ' · ' || name as label from lectures
          where deleted_at is null and silent = 0 and status = 'training' and due_at is null`
      )
    ),

  /**
   * ★ N-2 的存量：状态说「空」，可它有知识点。
   *
   * 启动自愈会把能确定方向的那些改掉（`recover.ts`），所以正常情况下
   * 这条不该有东西。留着是为了**万一自愈没跑到**（比如他从旧备份导回之后
   * 还没重启），体检里仍然看得见。
   */
  (db) =>
    finding(
      'empty-with-items',
      'warn',
      '有 lecture 状态是「空」，实际却有知识点',
      '工作台会显示「贴一份材料」的空态，而它其实有内容；下次启动会自动改回待审阅',
      rows<{ label: string }>(
        db,
        `select l.id || ' · ' || l.name || '（' ||
                (select count(*) from item_lectures il join items i on i.id = il.item_id
                  where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null) || ' 条）' as label
           from lectures l
          where l.deleted_at is null and l.status = 'empty'
            and exists (select 1 from item_lectures il join items i on i.id = il.item_id
                         where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null)`
      )
    ),

  // ── 出题与判分 · D-116 / D-119 ─────────────────────────────
  (db) =>
    finding(
      'tier-out-of-range',
      'error',
      '有题目的难度档不在 1–5 之间',
      '取题按档匹配，越界的题永远取不到 —— 花钱生成了却一次也用不上',
      rows<{ label: string }>(
        db,
        `select 'q#' || id || ' tier=' || tier as label from questions where tier < 1 or tier > 5`
      )
    ),
  (db) =>
    finding(
      'grade-out-of-range',
      'error',
      '有判分不在 1–4 档之间',
      '四档是 D-119 的刻度，越界之后统计、二维图、练成判定全部算错',
      rows<{ label: string }>(
        db,
        `select 'a#' || id || ' grade=' || grade as label from answers
          where grade is not null and (grade < 1 or grade > 4)`
      )
    ),
  (db) =>
    finding(
      'answer-without-question',
      'error',
      '有作答记录找不到对应的题目',
      '报告里「这题当时问的是什么」永远打不开 —— 回顾自己写过什么是这软件的价值之一',
      rows<{ label: string }>(
        db,
        `select 'a#' || a.id as label from answers a
          where a.question_id is not null
            and not exists (select 1 from questions q where q.id = a.question_id)`
      )
    ),

  // ── 统计口径 · D-176 / D-084 ───────────────────────────────
  (db) =>
    finding(
      'corrects-over-attempts',
      'error',
      '有条目「答对次数」比「作答次数」还多',
      '正确率算出来超过 100%，二维图上这条会画到框外（D-096）',
      rows<{ label: string }>(
        db,
        `select id || ' · ' || term as label from items
          where deleted_at is null and corrects > attempts`
      )
    ),
  (db) =>
    finding(
      'state-unknown',
      'error',
      '有条目的状态位不是四档之一',
      'statusOf() 认不出来，列表和矩阵里它会凭空消失（D-084）',
      rows<{ label: string }>(
        db,
        `select id || ' · ' || term || ' → ' || production_state as label from items
          where deleted_at is null
            and production_state not in ('new', 'training', 'hard', 'silent')`
      )
    ),

  // ── 同步的两个前提 · D-201 ─────────────────────────────────
  (db) => {
    const bad: { label: string }[] = []
    for (const t of SYNC_TABLES) {
      const cols = (db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map(
        (c) => c.name
      )
      if (cols.length === 0) continue
      if (!cols.includes('updated_at')) bad.push({ label: `${t} 没有 updated_at` })
      if (!cols.includes('uid')) bad.push({ label: `${t} 没有 uid` })
    }
    return finding(
      'sync-columns',
      'error',
      '有同步表缺了 uid 或 updated_at',
      '增量同步靠这两列。缺了的话那张表要么同步不出去、要么被对面整表盖掉，而且不报错（D-201）',
      bad
    )
  },
  (db) => {
    const bad: { label: string }[] = []
    for (const t of SYNC_TABLES) {
      const cols = (db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map(
        (c) => c.name
      )
      if (!cols.includes('uid')) continue
      const n = (
        db.prepare(`select count(*) as n from "${t}" where uid is null or trim(uid) = ''`).get() as {
          n: number
        }
      ).n
      if (n > 0) bad.push({ label: `${t} 有 ${n} 行没有 uid` })
    }
    return finding(
      'sync-uid-missing',
      'error',
      '有行没有同步身份（uid）',
      '这些行永远同步不出去，而且**不报错** —— 换台设备就发现少了一截',
      bad
    )
  },

  /**
   * ★ P-1-a · 题全答完了、却没有结算的那几场练习。
   *
   * ── 为什么不能拿「finished_at 是 null」当判据 ────────────────
   *
   * `sessions` 只有一个创建者：产出练习开场时的 `startSession`。
   * 而**中途关掉练习不会结算** —— 那一场就永远停在 `finished_at = null`。
   * 那是正常用法（D-136：练完给一行字就收，没练完就是没练完），
   * 不是数据损坏。照「null 就报」写，他每中断一次练习就多一条告警，
   * 噪音一多，真正的告警就没人看了。
   *
   * ── 判据：`target` 就是那个区分器 ──────────────────────────
   *
   * `sessions.target` 记的是**开场时队列有多长**。所以：
   *   · 首答数 < target  → 他中途走开了。合法，不报
   *   · 首答数 ≥ target  → 题全答完了，却没有结算记录
   *     —— 这正是「结算跑到一半进程没了」留下的形状
   *
   * ── 24 小时这个门槛是干什么用的 ───────────────────────────
   *
   * 答完最后一题之后，界面停在结果页，要点「下一题 →」才触发结算。
   * 他完全可能答完就走开、软件开着过夜 —— 那一整段时间里
   * 「全答完 + 未结算」是**正常的**。24 小时比这种停留长得多，
   * 又短到当天就能被发现。不是拍脑袋的数，是照这条路径量出来的。
   *
   * ── 只报，不修 ────────────────────────────────────────────
   *
   * 没有恢复动作：那一场确实没结算过，**重新练一轮就会正常结算**
   * （幂等保护判的是 `finished_at`，它是 null，所以不会被挡）。
   * 自动补一次结算反而是在编一个没发生过的事实。
   */
  (db) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const rows_ = rows<{ id: number; startedAt: number; target: number; answered: number }>(
      db,
      `select s.id, s.started_at as startedAt, s.target,
              (select count(*) from answers a
                where a.session_id = s.id and a.is_first = 1 and a.grade is not null) as answered
         from sessions s
        where s.finished_at is null and s.target > 0 and s.started_at < ?
        order by s.started_at`,
      cutoff
    ).filter((r) => r.answered >= r.target)
    return finding(
      'session-never-settled',
      'warn',
      '有练习答完了却没有结算',
      '那几个 Lecture 的排期没有因为这几场更新过 —— 重新练一轮就会正常结算，数据没有丢',
      rows_.map((r) => ({
        label: `第 ${r.id} 场 · ${new Date(r.startedAt).toLocaleString('zh-CN')} · ${r.answered}/${r.target} 题`
      }))
    )
  },

  /**
   * ★ R-1 · 上一次启动，自愈有没有哪一步没做成。
   *
   * 分级之后，「这一步自己的毛病」不再挡启动 —— 但**不能因此变成没人知道**。
   * 他不看日志（也不知道日志在哪），所以状态落在 settings 里，由这条检查端上来。
   * 这是「不吞掉错误」和「不让软件打不开」之间唯一诚实的接法。
   */
  (db) =>
    finding(
      'startup-heal-failed',
      'error',
      '上次启动时，有自愈步骤没有做成',
      '该收拾的遗留问题还在，而且软件不会再提第二次 —— 把下面这段连同日志发给 Claude Code',
      lastHealProblems(db).map((p) => ({
        label: `${p.step}：${p.message}${p.code ? `（${p.code}）` : ''}`
      }))
    ),

  /**
   * ★★ R-4-D · 上一次同步有没有哪一行没写进去 / 整次没跑成。
   *
   * 同步是这个项目里**唯一一处「别人的数据写进我的库」**的地方，
   * 而它的失败以前只有一句 `console.error` —— 打包之后无处可看。
   * 两台设备从此永久差一行，没有任何人会发现。
   *
   * 落在这里的都是**可重试**的：出问题的那个变更包没有进 `applied`，
   * 下一次同步会再来一遍。所以判 `warn` 不判 `error` ——
   * 它不是「数据坏了」，是「还没同步完，而你该知道」。
   */
  (db) =>
    finding(
      'sync-incomplete',
      'warn',
      SYNC_INCOMPLETE_TITLE,
      '出问题的那几行所在的变更包没有标成已应用 —— 再点一次「现在同步」就会重试；一直不好就把这段发给 Claude Code',
      (lastSyncProblems(db)?.problems ?? []).map((p) => ({
        label:
          `${p.kind === 'run' ? '整次同步' : '写不进去'} · ${p.what}：${p.message}` +
          (p.chunk ? `（变更包 ${p.chunk}）` : '')
      }))
    ),

  /**
   * ★★ R-4-G · 升级时有出厂内容没能归一到跨设备身份。
   *
   * 正常路径上这条永远是空的（序位逐个递增、`qtypes.key` 有唯一索引）。
   * 会亮的只有一种情况：库被手工改过、或者导回过一份怪备份，
   * 于是同一个身份被两行抢。V20 的选择是**保留原样、记一笔** ——
   * 为了让升级看起来干净而擅自删掉一行，是拿他的数据换我的体面。
   *
   * 后果：那几行仍然是老的随机 uid，同步到另一台设备时会继续撞主键，
   * 而 R-4 会把那次失败如实报出来。所以这条判 `warn` 并说清下一步。
   */
  (db) =>
    finding(
      'builtin-identity-dup',
      'warn',
      '有出厂内容没能归一到跨设备身份',
      '这几条在另一台设备上会同步失败 —— 多半是同一个出厂项在库里有两份。把下面这段发给 Claude Code',
      (() => {
        try {
          const r = db
            .prepare(`select value from settings where key = ?`)
            .get(BUILTIN_IDENTITY_KEY) as { value: string } | undefined
          if (!r) return []
          const p = JSON.parse(r.value) as {
            problems: { table: string; id: number; want: string; why: string }[]
          }
          return (p.problems ?? []).map((x) => ({
            label: `${x.table} 第 ${x.id} 行 → ${x.want || '（算不出）'}：${x.why}`
          }))
        } catch {
          return []
        }
      })()
    ),

  /**
   * ★★ R-3-g · V23 之前立的老碑没记父实体的 id。
   *
   * 后果不是数据错，是**同步永远好不了**：那些父实体的旧子行
   * （`answers` / `review_logs` / `occurrences` …）会一直撞外键、
   * 一直算失败、那一包一直不进 `applied` —— 「没有完全成功」永远挂在那里。
   *
   * 补不出来（父行早就没了），也**绝不猜**：猜一个 id 出来可能挡掉别人的孩子。
   * 所以报出来，让它别变成一种没人管的常态。
   *
   * 正常升级路径（v18 → v23 一次跑完）**产生不出**这种碑，
   * 所以这条平时永远是空的。
   */
  (db) =>
    finding(
      'tombstone-legacy',
      'warn',
      '有几块墓碑是老格式的（认不出它的下级）',
      '它们对应的旧数据在同步时会一直失败重试。把这段发给 Claude Code',
      (() => {
        try {
          return (
            db
              .prepare(
                `select kind, target_uid as uid from tombstones where target_id is null limit 50`
              )
              .all() as { kind: string; uid: string }[]
          ).map((x) => ({ label: `${x.kind} / ${x.uid}` }))
        } catch {
          return []
        }
      })()
    ),

  // ── 外键实际完整性 ─────────────────────────────────────────
  (db) => {
    const bad = db.pragma('foreign_key_check') as { table: string; rowid: number; parent: string }[]
    return finding(
      'foreign-key-check',
      'error',
      '有外键指向不存在的行',
      '删除、导出、同步都可能在这些行上炸掉，而炸的位置和真正的原因隔得很远',
      bad.map((b) => ({ label: `${b.table}#${b.rowid} → ${b.parent}` }))
    )
  }
]

export interface AuditReport {
  at: number
  findings: Finding[]
  /** 跑了几条检查 —— 一条都没跑却报「没问题」是最坏的结果 */
  checked: number
}

export function audit(db: Database): AuditReport {
  const findings: Finding[] = []
  for (const c of CHECKS) {
    const f = c(db)
    if (f) findings.push(f)
  }
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return { at: Date.now(), findings, checked: CHECKS.length }
}

/**
 * 能自动修的就修掉，修不了的照实报回去。
 *
 * **只修「一定是错的」那几种**：状态位互相矛盾、缺 uid 这类没有歧义的。
 * 缺 lecture 归属、外键断链这些**不自动动** ——
 * 修它们要替他决定东西该归到哪儿，而猜错的代价是数据搬错地方。
 */
export function repair(db: Database): { fixed: Record<string, number> } {
  const fixed: Record<string, number> = {}
  const t = Date.now()
  db.transaction(() => {
    // 静默了就不该排期（D-024）
    let n = db
      .prepare(
        `update reading_cards set due_at = null, updated_at = ?
          where silent = 1 and due_at is not null
            and item_id in (select id from items where deleted_at is null)`
      )
      .run(t).changes
    if (n) fixed['silent-but-due'] = n

    n = db
      .prepare(
        `update lectures set due_at = null, updated_at = ?
          where deleted_at is null and silent = 1 and due_at is not null`
      )
      .run(t).changes
    if (n) fixed['silent-lecture-due'] = n

    // 答对次数不可能多于作答次数
    n = db
      .prepare(
        `update items set corrects = attempts, updated_at = ?
          where deleted_at is null and corrects > attempts`
      )
      .run(t).changes
    if (n) fixed['corrects-over-attempts'] = n

    /**
     * ★ I-114 · 把欠着的原文出处补上。
     * 走的是和平时同一个 `backfillQuotes` —— 检查、修复、正常写入三处同一份判据，
     * 不再各写一遍（`recordOccurrence` 抽成唯一入口就是为了这个）。
     */
    n = 0
    for (const l of rows<{ id: number }>(db, `select id from lectures where deleted_at is null`)) {
      n += backfillQuotes(db, l.id)
    }
    if (n) fixed['quote-backfillable'] = n

    // 上级其实没静默 —— 把这个标记清掉，它才放得出来
    n = db
      .prepare(
        `update items set silenced_by = null, updated_at = ?
          where deleted_at is null and silenced_by in ('project', 'unit', 'lecture')
            and not exists (
              select 1 from item_lectures il
                join lectures l on l.id = il.lecture_id
                join units u on u.id = l.unit_id
                join projects p on p.id = u.project_id
               where il.item_id = items.id
                 and (l.silent = 1 or u.silent = 1 or p.silent = 1))`
      )
      .run(t).changes
    if (n) fixed['silenced-by-orphan'] = n

    /**
     * ★ 活着的 lecture 挂在已删除的上级下面 —— 把**上级路径放回来**。
     *
     * 这是 4.3 那个 bug 的残留：以前从垃圾箱恢复 lecture 只放它自己出来，
     * 上级还躺在垃圾箱里。于是这一讲在项目栏里看不见，却照常进今日队列。
     *
     * 为什么这一条可以自动修、而别的关联问题不行：
     * **方向是唯一的。** lecture 是活的，说明他要它；让它可见是恢复，
     * 而把它一起删掉是销毁 —— 两者代价差着一个量级。
     * 何况「恢复 lecture 要连上级路径一起恢复」正是他自己定的规则。
     */
    n = db
      .prepare(
        `update units set deleted_at = null, updated_at = ?
          where deleted_at is not null
            and exists (select 1 from lectures l where l.unit_id = units.id and l.deleted_at is null)`
      )
      .run(t).changes
    if (n) fixed['live-child-dead-parent:units'] = n
    n = db
      .prepare(
        `update projects set deleted_at = null, updated_at = ?
          where deleted_at is not null
            and exists (select 1 from units u where u.project_id = projects.id and u.deleted_at is null)`
      )
      .run(t).changes
    if (n) fixed['live-child-dead-parent:projects'] = n

    // 补 uid —— 缺了就永远同步不出去
    for (const tb of SYNC_TABLES) {
      const cols = (db.prepare(`pragma table_info("${tb}")`).all() as { name: string }[]).map(
        (c) => c.name
      )
      if (!cols.includes('uid')) continue
      const m = db
        .prepare(
          `update "${tb}" set uid = '${tb}-' || lower(hex(randomblob(8)))
            where uid is null or trim(uid) = ''`
        )
        .run().changes
      if (m) fixed[`uid:${tb}`] = (fixed[`uid:${tb}`] ?? 0) + m
    }
  })()
  return { fixed }
}
