import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../src/main/db/open.ts'

/**
 * 编一套半年的假数据 —— 只为把**报告**这类「攒够数据才有东西看」的东西验出来。
 *
 * **它写进哪儿**：`NYX_DATA_ROOT` 指定的目录。`npm run demo` 会指到 `.demo/`，
 * 那是个用完就能整个删掉的文件夹，**碰不到真实数据**。
 *
 * 数据是编的，但**编的方式是真的**：所有状态迁移都按 core/ 的规则走
 * （连续 3 次正确才静默、5 次未达标才进攻坚），所以报告上看到的形状
 * 和真实使用长出来的形状是同一类，不是随便画的曲线。
 */

const DAY = 86_400_000
const DAYS = 180
const now = Date.now()
const start = now - DAYS * DAY

/** 可复现的伪随机 —— 每次跑出来一样，图形变了就是代码变了 */
let seed = 20260803
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!

const TERMS = [
  ['hold sway', 'to have dominant influence over'],
  ['a far cry from', 'very different from'],
  ['at the mercy of', 'powerless against'],
  ['bear the brunt of', 'to take the worst of'],
  ['grasp the gravity of', 'to fully realize the seriousness of'],
  ['weigh on', 'to press down on someone as a worry'],
  ['do the quiet work', 'to act without being noticed'],
  ['swallowed up by', 'absorbed or negated by'],
  ['have the upper hand', 'to hold the advantage'],
  ['call the shots', 'to make the decisions'],
  ['a case in point', 'a clear example of the thing being discussed'],
  ['by no means', 'not at all'],
  ['run counter to', 'to conflict with'],
  ['give way to', 'to be replaced by'],
  ['on the back of', 'as a result of'],
  ['demographic sink', 'a place that loses population'],
  ['subsistence', 'bare survival level'],
  ['Malthusian Trap', 'population growth outpacing output gains'],
  ['pre-industrial equilibrium', 'the steady state before industrialisation'],
  ['the Great Divergence', 'the split in living standards between regions']
]

const root = process.env['NYX_DATA_ROOT'] ?? join(app.getAppPath(), '.demo')
mkdirSync(join(root, 'data', 'backups'), { recursive: true })
const { db } = openDatabase(join(root, 'data', 'nyx.db'), join(root, 'data', 'backups'))

const ins = (sql: string, ...a: unknown[]): number =>
  Number(db.prepare(sql).run(...a).lastInsertRowid)

db.transaction(() => {
  // ── 三层结构 ────────────────────────────────────────────────
  /**
   * ★ 讲次名要**像真的**（2026-09-03）
   *
   * 原来是拿项目名前六个字拼一个 L1/L2/L3 —— 一律 11 个字符，
   * 于是**拿这套数据截图永远看不出名字会不会挤**：
   * 1600px 宽下什么都放得下，可他真库里的名字是「第三讲 · 工业革命为什么先发生在英国」。
   * 截图是现在唯一的版式验收手段（CLAUDE.md §七），
   * **喂给它的数据不真，它就只会告诉你「一切都好」。**
   */
  const LECTURE_NAMES: Record<string, string[][]> = {
    'The Modern World': [
      ['第一讲 · 前工业世界的人口与土地', '第二讲 · 马尔萨斯陷阱', '第三讲 · 工业革命为什么先发生在英国'],
      ['第四讲 · 大分流：欧洲与东亚', '第五讲 · 煤、殖民地与偶然性', '第六讲 · 增长的制度解释']
    ],
    'The Atlantic · 时评精读': [
      ['09-01 · On the Politics of Attention', '09-08 · The Quiet Cost of Convenience', '09-15 · Why Institutions Decay'],
      ['09-22 · The Return of Industrial Policy', '09-29 · Reading the Demographic Tea Leaves', '10-06 · What Cities Owe Their Poor']
    ]
  }


  const projects = [
    ['The Modern World', '#6d5efc'],
    ['The Atlantic · 时评精读', '#2f9e57']
  ]
  const lectureIds: number[] = []

  for (const [pname, color] of projects) {
    const pid = ins(
      `insert into projects (name, color, created_at, updated_at) values (?,?,?,?)`,
      pname,
      color,
      start,
      now
    )
    for (const [ui, uname] of ['第一部分 · 前工业世界', '第二部分 · 大分流'].entries()) {
      const uid = ins(
        `insert into units (project_id, name, created_at, updated_at) values (?,?,?,?)`,
        pid,
        uname,
        start,
        now
      )
      for (let i = 1; i <= 3; i++) {
        const born = start + Math.floor(rnd() * 60) * DAY
        lectureIds.push(
          ins(
            `insert into lectures (unit_id, name, number, status, interval_days, due_at, created_at, updated_at)
             values (?,?,?,'training',?,?,?,?)`,
            uid,
            LECTURE_NAMES[pname][ui][i - 1],
            i,
            [1, 3, 7, 16][Math.floor(rnd() * 4)],
            now + Math.floor(rnd() * 10 - 3) * DAY,
            born,
            now
          )
        )
      }
    }
  }

  // ── 条目 + 半年的作答 ────────────────────────────────────────
  const evt = db.prepare(
    `insert into state_events (item_id, line, from_state, to_state, created_at, updated_at)
     values (?, 'production', ?, ?, ?, ?)`
  )
  const ansIns = db.prepare(
    `insert into answers (session_id, item_id, question_id, attempt_no, is_first, text, grade,
                          annotations, feedback, created_at, updated_at)
     values (null, ?, null, 1, 1, ?, ?, '[]', '', ?, ?)`
  )
  const logIns = db.prepare(
    `insert into review_logs (item_id, line, grade, created_at, updated_at) values (?,?,?,?,?)`
  )

  let n = 0
  for (let round = 0; round < 9; round++) {
    for (const [term, gloss] of TERMS) {
      n += 1
      const isProper = term === 'Malthusian Trap' || term === 'the Great Divergence'
      // M-011 · 专名只做理解；M-007 · 只在一个领域用得上的判 A
      const layer = isProper || term.includes('equilibrium') ? 'A' : rnd() > 0.28 ? 'B' : 'A'
      const born = start + Math.floor(rnd() * (DAYS - 40)) * DAY
      const lec = pick(lectureIds)

      const itemId = ins(
        `insert into items (term, gloss, gloss_zh, layer, kind, source, owner_lecture_id,
                            confidence, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?)`,
        `${term}${round > 0 ? ` ${round}` : ''}`,
        gloss,
        '中文提示',
        layer,
        isProper ? 'proper' : 'chunk',
        rnd() > 0.85 ? 'both' : 'ai',
        lec,
        Math.round(rnd() * 100) / 100,
        born,
        now
      )
      ins(
        `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at) values (?,?,1,?,?)`,
        itemId,
        lec,
        born,
        now
      )
      ins(
        `insert into occurrences (item_id, lecture_id, quote, para, created_at, updated_at) values (?,?,?,?,?,?)`,
        itemId,
        lec,
        `The forces that ${term} over long-run growth are demographic.`,
        1 + Math.floor(rnd() * 4),
        born,
        now
      )
      evt.run(itemId, null, 'new', born, now)

      // ── 按 core/ 的真规则推演产出线 ──────────────────────────
      let state = 'new'
      let streak = 0
      let attempts = 0
      let inStage = 0
      let corrects = 0
      let hardEntries = 0
      let t = born + (2 + Math.floor(rnd() * 5)) * DAY

      // 能力随时间上升：越靠后越容易判到 3、4 档（正确率趋势才会向上）
      while (t < now && state !== 'silent' && layer === 'B') {
        const progress = (t - start) / (now - start)
        const r = rnd() + progress * 0.35
        const grade = r > 1.05 ? 4 : r > 0.72 ? 3 : r > 0.38 ? 2 : 1
        attempts += 1
        inStage += 1

        ansIns.run(
          itemId,
          grade >= 3
            ? `Tradition still ${term} over village life.`
            : `Big tech ${term} on this debate.`,
          grade,
          t,
          now
        )
        logIns.run(itemId, 'production', grade, t, now)

        if (grade >= 3) {
          streak += 1
          corrects += 1
        } else if (!(grade === 2 && attempts <= 3)) {
          streak = 0
        }

        const prev = state
        if (state === 'new') state = 'training'
        if (state === 'hard') {
          if (streak >= 3) {
            state = 'training'
            streak = 0
            inStage = 0
          }
        } else if (streak >= 3) {
          state = 'silent'
        } else if (inStage >= 5) {
          state = 'hard'
          streak = 0
          inStage = 0
          hardEntries += 1
        }
        if (state !== prev) evt.run(itemId, prev, state, t, now)

        t += (3 + Math.floor(rnd() * 12)) * DAY
      }

      // ── 认读线 ──────────────────────────────────────────────
      const reps = Math.floor(rnd() * 9)
      let ivl = 0
      let ct = born + DAY
      for (let i = 0; i < reps && ct < now; i++) {
        const g = rnd() > 0.22 ? 3 : rnd() > 0.5 ? 2 : 1
        ivl = g === 1 ? 1 : ivl === 0 ? 1 : Math.round(ivl * (g === 2 ? 1.2 : 2.4))
        logIns.run(itemId, 'reading', g, ct, now)
        ct += ivl * DAY
      }
      const cardSilent = ivl > 180 ? 1 : 0

      /**
       * ★ D-296（V34）· 认读线搬去了 `reading_cards`，所以这里是两条语句。
       *   写进 `items` 那 6 个冻结列的话，演示库看起来有数据，
       *   实际认读队列和知识库列表**一条都查不出来** —— 而且不报错。
       */
      db.prepare(
        `update items set production_state=?, streak=?, attempts=?, attempts_in_stage=?,
                          corrects=?, hard_entries=?, recollected_count=?, updated_at=?
          where id=?`
      ).run(
        state,
        streak,
        attempts,
        inStage,
        corrects,
        hardEntries,
        rnd() > 0.9 ? 1 + Math.floor(rnd() * 2) : 0,
        now,
        itemId
      )
      db.prepare(
        `update reading_cards set reps=?, interval_days=?, due_at=?, silent=?, updated_at=?
          where item_id=?`
      ).run(reps, ivl, ct, cardSilent, now, itemId)
    }
  }

  // ── lecture 轮转日志（报告④ 要用）──────────────────────────
  const lg = db.prepare(
    `insert into lecture_logs (lecture_id, event, detail, created_at, updated_at) values (?,'practiced',?,?,?)`
  )
  for (const lid of lectureIds) {
    let t = start + Math.floor(rnd() * 20) * DAY
    while (t < now) {
      const rate = Math.min(95, 40 + Math.floor(((t - start) / (now - start)) * 45 + rnd() * 20))
      lg.run(lid, `${5 + Math.floor(rnd() * 25)} 题 · 正确率 ${rate}% · 间隔 ×2.0`, t, now)
      t += (7 + Math.floor(rnd() * 20)) * DAY
    }
  }

  console.log(`灌好了：${n} 条知识点 · ${lectureIds.length} 个 lecture · ${DAYS} 天`)
})()

db.close()
app.exit(0)
