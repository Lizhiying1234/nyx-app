import type { Database } from 'better-sqlite3'
import { promoteOutOfEmpty } from './lecture-status.ts'

/**
 * 启动自愈 · H-1 / N-2 / D-4
 *
 * 三条互不相干的「状态和事实对不上」，都在软件启动那一刻收拾一次。
 * 各自的判据与边界写在各自函数头上；三条共同遵守的原则只有一条：
 *
 * > **只自动修方向唯一的。** 方向不唯一（同一份事实能推出两种结果）
 * > 就保留数据 + 记一笔，交给数据体检显示。为了让库看起来干净
 * > 而编一个新事实出来，比留着那条异常更糟 —— 他零编程经验，
 * > 编出来的那个数他分辨不出真假。
 *
 * ★ F-2-① 之后，`recoverStuckAnalyzing` 已经不是主力了（原因见它自己的注释）。
 */

export interface RecoverResult {
  /** 收拾了哪几讲，各恢复成什么 */
  fixed: { lectureId: number; name: string; to: string }[]
  /**
   * ★ **看出问题、但不敢自动改**的那些。
   *
   * 只报不改，交给他在数据体检里看见。这条边界是明写的原则：
   * **只自动修「方向唯一」的异常**。方向不唯一时保留数据 + 记一笔，
   * 绝不为了让库看起来干净而编一个新事实出来。
   */
  reported?: { lectureId: number; name: string; problem: string }[]
}

/**
 * ★ N-2 的存量 · A：`status='empty'` 却有知识点 → `review`
 *
 * 方向是唯一的：`empty` 的语义是「当前这一讲没有任何有效内容」，
 * 而它有几十上百条 —— 状态和事实对不上，事实这一侧是硬的。
 * `review` 正是「有内容、停在 F-03 那道门等他审阅」，
 * 而且它**不会凭空造出排期**（review 本来就没有 due_at）。
 *
 * **只改 status 一个字段。** due_at / interval_days / 学习记录 /
 * answers / review_logs / items / analysis_blocks / materials / 同步元数据
 * 一律不碰 —— 这条修复的全部内容就是「把状态改成与事实相符」。
 *
 * 注意不要用 `markUnread()`：那是业务操作，会把 due_at 清空、interval_days 归零。
 * 拿业务操作去修数据，会顺手改掉不该改的东西。
 */
function healEmptyWithItems(db: Database): RecoverResult['fixed'] {
  const rows = db
    .prepare(`select id, name from lectures where status = 'empty' and deleted_at is null`)
    .all() as { id: number; name: string }[]
  if (rows.length === 0) return []

  const t = Date.now()
  const logIt = db.prepare(
    `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
     values (?, 'recovered', ?, ?, ?)`
  )
  const out: RecoverResult['fixed'] = []
  db.transaction(() => {
    for (const l of rows) {
      /**
       * ★ N-1 · 判据不再写在这里，和写入路径共用同一个函数。
       *
       * 以前这里自己带一份「有内容就不该叫空」的 SQL，`addChunks` / `addItem`
       * 那边一份都没有 —— 于是**正常操作持续生产异常数据，启动时再兜回来**。
       * 现在写入那一刻就结算，这里只剩兜底的职责：同步导入、旧备份导回、
       * 旧版本产生的库，都可能带着 `empty + 有内容` 进来，而它们不经过写入路径。
       */
      const r = promoteOutOfEmpty(db, l.id)
      if (!r.changed) continue
      logIt.run(l.id, `状态是「空」却有 ${r.items} 条知识点，已改为「待审阅」`, t, t)
      out.push({ lectureId: l.id, name: l.name, to: 'review' })
    }
  })()
  return out
}

/**
 * ★ D-4 的存量 · B：`silent=0 ∧ status='training' ∧ due_at=null`
 *
 * 这一讲在轮转中却没有到期日 —— 今日队列要求两者同时成立，
 * 所以它**永远不会再出现在「今日」**里。
 *
 * ── 什么时候敢自动修，什么时候不敢 ────────────────────────
 *
 * 敢：`interval_days > 0`。那是**库里已有的事实** —— 只有结算过的讲才有间隔，
 *     说明它确实练过。恢复 `due_at = 现在`（立刻可练），
 *     和「取消静默」走同一套语义；`interval_days` 一个字不动，
 *     下一次结算从它继续扩张。
 *
 * 不敢：`interval_days = 0`。这时没有任何事实能推出它该在哪天到期 ——
 *     随便给一个日期就是**制造新的错误数据**。保留原样，只记一笔报给他。
 */
function healTrainingWithoutDue(db: Database): {
  fixed: RecoverResult['fixed']
  reported: NonNullable<RecoverResult['reported']>
} {
  const rows = db
    .prepare(
      `select id, name, interval_days as interval from lectures
        where deleted_at is null and silent = 0 and status = 'training' and due_at is null`
    )
    .all() as { id: number; name: string; interval: number }[]

  const fixed: RecoverResult['fixed'] = []
  const reported: NonNullable<RecoverResult['reported']> = []
  if (rows.length === 0) return { fixed, reported }

  const t = Date.now()
  const up = db.prepare(`update lectures set due_at = ?, updated_at = ? where id = ?`)
  const logIt = db.prepare(
    `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
     values (?, 'recovered', ?, ?, ?)`
  )
  db.transaction(() => {
    for (const l of rows) {
      if (l.interval > 0) {
        up.run(t, t, l.id)
        logIt.run(l.id, `在练却没有到期日，已恢复为「立刻可练」（间隔 ${l.interval} 天保留）`, t, t)
        fixed.push({ lectureId: l.id, name: l.name, to: 'training · 立刻可练' })
      } else {
        reported.push({
          lectureId: l.id,
          name: l.name,
          problem: '在练却没有到期日，而且没有间隔可依据 —— 没有自动改，请在数据体检里处理'
        })
      }
    }
  })()
  return { fixed, reported }
}

/**
 * 残留的 `analyzing` · H-1 → ★★ F-2-① 之后降级为**兼容兜底**
 *
 * ── 它以前是主力，现在不是了 ──────────────────────────────
 *
 * F-2-① 之前，`analyze` 一开始就把 `status` 改成 `'analyzing'`，
 * 于是崩溃后必须由这里把状态**猜**回去 —— 而它猜不到原来是什么，
 * 只能拿 `due_at` 和「有没有知识点」推。同一份数据，
 * 正常异常退出（拿得到 `before`）和崩溃重启（拿不到）会得到不同结果，
 * 那就是 F-2 的根因。
 *
 * 现在 `analyze` **全程不动 `status`**：失败、取消、崩溃三条路上它都保持原样，
 * 没有任何东西要还原。所以正常运行里这个函数**永远扫不到东西**。
 *
 * ── 那为什么还留着 ────────────────────────────────────────
 *
 * 三条路仍然可能把 `analyzing` 送进这个库，而它们都不经过本机的 analyze：
 *   · 同步：另一台还没升级的设备把它推过来（`lectures` 在 SYNC_TABLES 里）
 *   · 导回：一份升级前做的备份
 *   · 手工改库
 * 这三种情况下**本来就没有 `before` 可依**，只能按事实推 ——
 * 判据和迁移 V19 用的是同一条，行为一致。
 *
 * 留着它的代价是零（正常情况下扫不到），去掉的代价是那三条路上的讲会废掉。
 */
export function recoverStuckAnalyzing(db: Database): RecoverResult {
  const stuck = db
    .prepare(
      `select l.id, l.name, l.due_at as dueAt,
              (select count(*) from item_lectures il join items i on i.id = il.item_id
                where il.lecture_id = l.id and il.deleted_at is null and i.deleted_at is null) as items
         from lectures l
        where l.status = 'analyzing' and l.deleted_at is null`
    )
    .all() as { id: number; name: string; dueAt: number | null; items: number }[]

  if (stuck.length === 0) return { fixed: [] }

  const t = Date.now()
  const fixed: RecoverResult['fixed'] = []
  const up = db.prepare(`update lectures set status = ?, updated_at = ? where id = ?`)
  const logIt = db.prepare(
    `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at)
     values (?, 'recovered', ?, ?, ?)`
  )

  db.transaction(() => {
    for (const l of stuck) {
      const to = l.dueAt !== null ? 'training' : l.items > 0 ? 'review' : 'empty'
      up.run(to, t, l.id)
      // 留痕：他在这一讲的日志里看得见「上次分析没跑完」，而不是莫名其妙换了状态
      logIt.run(l.id, `上次分析没有正常结束，状态从「分析中」恢复为「${to}」`, t, t)
      fixed.push({ lectureId: l.id, name: l.name, to })
    }
  })()

  return { fixed }
}

/**
 * 启动时把三类「状态和事实对不上」收拾掉 · H-1 / N-2 / D-4
 *
 * 三条都遵循同一个原则：**只自动修方向唯一的**。
 * 方向不唯一（比如「在轮转中但没有间隔可依据」）就保留数据、只记一笔 ——
 * 为了让库看起来干净而编一个新事实出来，比留着那条异常更糟。
 */
export function recoverAll(
  db: Database,
  onError?: (step: string, err: unknown) => void
): RecoverResult {
  /**
   * ★ R-1 · 三步各自包一层。
   *
   * 三条互不依赖：残留 analyzing、状态说空却有内容、在轮转却没排期。
   * 其中一条炸了就把另外两条也放弃，是**拿一个小毛病换掉两个能修好的问题**。
   * 每一步内部本来就是独立事务，失败只回滚它自己 —— 所以往下走是安全的。
   *
   * `onError` 不传就照旧往外抛（单元测试要看得见）。传了就是启动路径：
   * 由调用方分级 —— 「这一步自己的毛病」还是「库已经不可信」。
   */
  const step = <T>(name: string, fn: () => T, empty: T): T => {
    try {
      return fn()
    } catch (err) {
      if (!onError) throw err
      onError(name, err)
      return empty
    }
  }

  const a = step('残留的分析中', () => recoverStuckAnalyzing(db), { fixed: [] } as RecoverResult)
  const b = step('状态说空却有知识点', () => healEmptyWithItems(db), [] as RecoverResult['fixed'])
  const c = step(
    '在练却没有到期日',
    () => healTrainingWithoutDue(db),
    { fixed: [], reported: [] } as { fixed: RecoverResult['fixed']; reported: NonNullable<RecoverResult['reported']> }
  )
  return {
    fixed: [...a.fixed, ...b, ...c.fixed],
    reported: c.reported
  }
}
