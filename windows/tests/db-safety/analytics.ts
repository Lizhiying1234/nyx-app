/**
 * T-4.12 · Learning Evidence 层跑在**真库形状**上（2026-09-07）
 *
 * ── 为什么这一档非有不可 ────────────────────────────────────
 *
 * core 那几套用例喂的是手写的几行，证明的是判据本身对。
 * 这一档证明的是另一件事：**那些判据接到真的库上还成立** ——
 * 列名对不对、参数个数对不对、1,542 行 ops_log 里挑得出 1,142 行查词。
 * 取数层（`main/analytics.ts`）唯一一处「相信」就是 SQL 的 alias 与
 * `EvidenceInput` 的字段名一一对应，而守它的正是这一段。
 *
 * ── 夹具照真库的形状，不带真数据 ────────────────────────────
 *
 * Windows 副本 2026-09-07（只读三件套抽出来的形状）：
 *   items 344 · analysis_blocks 219 · review_logs 13（production 7 / reading 6）·
 *   answers 8（is_first 7）· questions 165 · sessions 25（device 13 / null 12）·
 *   state_events 13 · item_events 8 · lecture_logs 4 ·
 *   ops_log 1,542（lookup 1,142 · capture 321 · 其它 79）
 * 词面与内容全是合成的（`word-7` / `other-233`），一个真词都没有。
 */

import type Database from 'better-sqlite3'
import { openDatabase } from '../../src/main/db/open.ts'
import { Learning } from '../../src/main/analytics.ts'
import { EVIDENCE_TABLES } from '../../src/core/sql/analytics.ts'
import { check, assert, freshDir } from './harness.ts'

console.log('\nT-4.12 · Learning Evidence（真库形状）\n')

const DAY = 86_400_000
const HOUR = 3_600_000
/** 固定的「现在」—— 用 Date.now() 的话，跑在午夜前后结果会变 */
const NOW = new Date('2026-09-06T20:00:00').getTime()
const PHONE = '5d0580fd'

/** 真库的行数 —— 改这里之前先去看副本，别改成方便的数 */
const SHAPE = {
  items: 344,
  blocks: 219,
  reviews: 13,
  reviewsProduction: 7,
  reviewsReading: 6,
  answers: 8,
  answersFirst: 7,
  questions: 165,
  sessions: 25,
  sessionsWithDevice: 13,
  stateEvents: 13,
  itemEvents: 8,
  lectureLogs: 4,
  ops: 1542,
  lookups: 1142,
  captures: 321
}

/** 查词覆盖 200 个不同词面：前 120 个在库里，后 80 个从没收过 */
const LOOKUP_TERMS = 200
const CAPTURED_TERMS = 120

/** 第 i 行查词查的是哪个词面（一半大小写不同、三分之一带尾点 —— 归一化要吃得下） */
function lookupTitle(i: number): string {
  const k = i % LOOKUP_TERMS
  const base = k < CAPTURED_TERMS ? `word-${k}` : `spare-${k}`
  const cased = i % 2 === 1 ? base.toUpperCase() : base
  return i % 3 === 0 ? `${cased}.` : cased
}

function seed(db: Database.Database): void {
  const t0 = NOW - 25 * DAY
  db.transaction(() => {
    db.prepare(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`).run(t0, t0)
    db.prepare(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`).run(t0, t0)
    db.prepare(
      `insert into lectures (id,unit_id,name,status,due_at,created_at,updated_at)
       values (1,1,'L1','training',?,?,?)`
    ).run(NOW, t0, t0)

    const I = db.prepare(
      `insert into items (id,term,gloss,layer,kind,source,production_state,created_at,updated_at)
       values (?,?,'g',?,'chunk','self',?,?,?)`
    )
    for (let i = 1; i <= SHAPE.items; i++) {
      const term = i <= CAPTURED_TERMS ? `word-${i - 1}` : `other-${i}`
      // 静默那一小批要真存在 —— 「练过、最近没碰」那条规则要把它们排除掉
      const state = i > 330 ? 'silent' : i % 7 === 0 ? 'new' : 'training'
      I.run(i, term, i % 5 === 0 ? 'A' : 'B', state, t0 + i * 1000, t0 + i * 1000)
    }

    // analysis_blocks 219 = meaning 213 + corrections 6（改过的那几条也早就分析过）
    const B = db.prepare(
      `insert into analysis_blocks (item_id,block,content,created_at,updated_at) values (?,?,?,?,?)`
    )
    for (let i = 1; i <= SHAPE.blocks - 6; i++) B.run(i, 'meaning', 'm', t0, t0)
    for (let i = 1; i <= 6; i++) B.run(i, 'corrections', '[]', t0, t0)

    const Q = db.prepare(
      `insert into questions (id,item_id,tier,type,prompt,used_at,created_at,updated_at)
       values (?,?,?,?,'p',?,?,?)`
    )
    for (let i = 1; i <= SHAPE.questions; i++) {
      Q.run(i, (i % SHAPE.items) + 1, (i % 3) + 1, '造句', NOW - 8 * DAY, t0, t0)
    }

    const S = db.prepare(
      `insert into sessions (id,kind,scope,target,started_at,finished_at,device,created_at,updated_at)
       values (?,?,'',0,?,?,?,?,?)`
    )
    for (let i = 1; i <= SHAPE.sessions; i++) {
      const dev = i <= SHAPE.sessionsWithDevice ? PHONE : null
      const st = NOW - 7 * DAY + i * HOUR
      S.run(i, 'production', st, st + 300_000, dev, st, st)
    }

    // ★ 题与场次要在作答**之前**建：answers 的 session_id / question_id 是外键，
    //   顺序反了 seed 当场 FOREIGN KEY constraint failed（第一版就是这样）
    // answers 8：7 条第一次判定（items 1–7），第 8 条是 item 1 改到过关那次
    const A = db.prepare(
      `insert into answers (id,session_id,item_id,question_id,attempt_no,is_first,text,grade,
                            duration_ms,device,created_at,updated_at)
       values (?,?,?,?,?,?,'x',?,?,?,?,?)`
    )
    /**
     * 7 条第一次判定落在 6 条知识点上 —— **item 1 挂了两次**。
     * 真库里恰好没有这种条目（8 条作答摊在 8 条知识点上），但夹具必须有一条，
     * 否则「反复失败」那一栏与它对应的那句「为什么」永远走不到，
     * 而没走到的分支等于没写（榜是空的时候看不出判据是对是错）。
     */
    const answerOn = [1, 1, 2, 3, 4, 5, 6]
    const firstGrades = [2, 1, 3, 2, 4, 3, 1]
    for (let i = 1; i <= SHAPE.answersFirst; i++) {
      const it = answerOn[i - 1]!
      A.run(i, i, it, i, 1, 1, firstGrades[i - 1]!, 40_000, PHONE, NOW - 9 * DAY + i * HOUR, NOW)
    }
    // 第 8 条：item 1 改到过关那次（is_first = 0，不进任何正确率 · D-121）
    A.run(8, 1, 1, 1, 2, 0, 4, 40_000, PHONE, NOW - 9 * DAY + 8 * HOUR, NOW)

    // review_logs 13：7 条 production（与 answers 是同一次事件的两半）+ 6 条 reading
    const R = db.prepare(
      `insert into review_logs (id,item_id,line,grade,duration_ms,device,created_at,updated_at)
       values (?,?,?,?,?,?,?,?)`
    )
    for (let i = 1; i <= SHAPE.reviewsProduction; i++) {
      // 与上面那 7 条作答一一对应 —— 真实路径上它们是同一次事件写的两行
      R.run(i, answerOn[i - 1]!, 'production', firstGrades[i - 1]!, 40_000, PHONE, NOW - 9 * DAY + i * HOUR, NOW)
    }
    const readingGrades = [1, 3, 4, 2, 3, 1]
    for (let i = 1; i <= SHAPE.reviewsReading; i++) {
      // 真库 13 条里只有 10 条有时长 —— 后 3 条故意不给
      const ms = i <= 3 ? 20_000 : null
      R.run(7 + i, i, 'reading', readingGrades[i - 1]!, ms, PHONE, NOW - 4 * DAY + i * HOUR, NOW)
    }

    const E = db.prepare(
      `insert into state_events (id,item_id,line,from_state,to_state,created_at,updated_at)
       values (?,?, 'production',?,?,?,?)`
    )
    for (let i = 1; i <= 7; i++) E.run(i, i, 'new', 'training', NOW - 9 * DAY + i * HOUR, NOW)
    for (let i = 1; i <= 6; i++) E.run(7 + i, 330 + i, 'training', 'silent', NOW - 3 * DAY + i * HOUR, NOW)

    const V = db.prepare(
      `insert into item_events (id,item_id,kind,detail,created_at,updated_at) values (?,?,'analyzed',?,?,?)`
    )
    for (let i = 1; i <= SHAPE.itemEvents; i++) {
      V.run(i, i, JSON.stringify({ origin: 'android' }), NOW - 2 * DAY + i * HOUR, NOW)
    }

    const G = db.prepare(
      `insert into lecture_logs (id,lecture_id,event,detail,created_at,updated_at) values (?,1,'practiced',?,?,?)`
    )
    for (let i = 1; i <= SHAPE.lectureLogs; i++) G.run(i, `正确率 ${60 + i}%`, NOW - (6 - i) * DAY, NOW)

    // ops_log 1,542：查词 1,142（全是手机的）+ 收下 321 + 其它 79
    const O = db.prepare(
      `insert into ops_log (id,op,target,target_id,title,detail,created_at,updated_at)
       values (?,?,?,?,?,?,?,?)`
    )
    let id = 1
    // ★ 摊在近 20 天里：全挤在同一天的话，「最近 14 天查过 3 次以上」那条规则一次都走不到
    const gap = Math.floor((20 * DAY) / SHAPE.lookups)
    for (let i = 0; i < SHAPE.lookups; i++) {
      O.run(id++, 'lookup', 'term', null, lookupTitle(i), null, NOW - 20 * DAY + i * gap, NOW)
    }
    for (let i = 1; i <= SHAPE.captures; i++) {
      const term = i <= CAPTURED_TERMS ? `word-${i - 1}` : `other-${i}`
      O.run(id++, 'capture', 'item', i, term, JSON.stringify({ pkg: 'x' }), NOW - 19 * DAY + i * 60_000, NOW)
    }
    for (let i = 0; i < SHAPE.ops - SHAPE.lookups - SHAPE.captures; i++) {
      O.run(id++, i % 2 === 0 ? 'silence' : 'delete', 'item', 1, 'word-0', null, NOW - 15 * DAY + i * 60_000, NOW)
    }
  })()
}

check('T-4.12 · ① 取数：每一句都跑得动，行数与真库形状一致', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seed(r.db)

  const l = new Learning(r.db)
  const rows = l.load(NOW - 30 * DAY, NOW + DAY)
  assert(rows.items.length === SHAPE.items, `items ${rows.items.length}`)
  assert(rows.marks.length === SHAPE.items, `marks ${rows.marks.length}`)
  assert(rows.answers.length === SHAPE.answers, `answers ${rows.answers.length}`)
  assert(rows.reviews.length === SHAPE.reviews, `review_logs ${rows.reviews.length}`)
  assert(rows.questions.length === SHAPE.questions, `questions ${rows.questions.length}`)
  assert(rows.sessions.length === SHAPE.sessions, `sessions ${rows.sessions.length}`)
  assert(rows.stateEvents.length === SHAPE.stateEvents, `state_events ${rows.stateEvents.length}`)
  assert(rows.itemEvents.length === SHAPE.itemEvents, `item_events ${rows.itemEvents.length}`)
  assert(rows.lectureLogs.length === SHAPE.lectureLogs, `lecture_logs ${rows.lectureLogs.length}`)
  assert(rows.lookups.length === SHAPE.lookups, `ops_log 里的查词 ${rows.lookups.length}`)
  assert(rows.captures.length === SHAPE.captures, `ops_log 里的收下 ${rows.captures.length}`)

  // ★ alias 漂了这一条当场红：字段名对不上，取到的是 undefined
  const a = rows.answers[0]!
  assert(typeof a.itemId === 'number' && typeof a.at === 'number' && a.device === PHONE,
    `★★ answers 的 alias 与 EvidenceInput 对不上：${JSON.stringify(a)}`)
  const lk = rows.lookups[0]!
  assert(typeof lk.title === 'string' && typeof lk.at === 'number',
    `★★ ops_log 查词行的 alias 对不上：${JSON.stringify(lk)}`)
  assert(rows.marks.filter((m) => m.analysed === 1).length === SHAPE.blocks - 6,
    '★ 「已分析」的条数与解析块对不上')
  assert(rows.marks.filter((m) => m.edited > 0).length === 6, '★ 「已编辑」的条数与 corrections 块对不上')
  r.db.close()
})

check('T-4.12 · ②★★ 同一次产出判分不数两遍（真库 13 条 review_logs 里 7 条是这种）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seed(r.db)
  const v = new Learning(r.db).build(30, NOW)

  assert(v.activity.totals.answers === SHAPE.answers, `作答 ${v.activity.totals.answers}`)
  assert(
    v.activity.totals.reviews === SHAPE.reviewsReading,
    `★★ 认读判分数成了 ${v.activity.totals.reviews} —— 把 production 那 7 行也数进去了，他练了多少会当场翻倍`
  )
  assert(v.activity.totals.lookups === SHAPE.lookups, `查词 ${v.activity.totals.lookups}`)
  assert(v.activity.totals.sessions === SHAPE.sessions, `场次 ${v.activity.totals.sessions}`)
  // 13 条 review_logs 里有时长的只有 3 条 reading + 8 条 answers = 11
  assert(v.activity.totals.timed === 11, `有计时的行 ${v.activity.totals.timed}`)
  r.db.close()
})

check('T-4.12 · ③★★ 设备归属照抄：练习全在手机，没有 device 的老场次落 unknown', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seed(r.db)
  const v = new Learning(r.db).build(30, NOW)

  const phone = v.activity.byDevice.find((d) => d.device === PHONE)
  const unknown = v.activity.byDevice.find((d) => d.device === 'unknown')
  assert(phone !== undefined, '★★ 手机那台没出现')
  assert(phone!.answers === SHAPE.answers && phone!.reviews === SHAPE.reviewsReading,
    `★★ 手机的账：作答 ${phone!.answers} · 认读 ${phone!.reviews}`)
  assert(phone!.sessions === SHAPE.sessionsWithDevice, `手机的场次 ${phone!.sessions}`)
  assert(unknown !== undefined && unknown.sessions === SHAPE.sessions - SHAPE.sessionsWithDevice,
    '★★ 没有 device 的老场次被归给某台真设备了')
  assert(unknown!.answers === 0 && unknown!.reviews === 0, '★★ unknown 桶里混进了练习事件')

  const w = v.why.find((x) => x.rule === 'device-origin')
  assert(w !== undefined && w.text.includes(PHONE.slice(0, 8)),
    `★ 「为什么」没说清这些事发生在哪台机器上：${w?.text}`)
  r.db.close()
})

check('T-4.12 · ④ 漏斗：1,142 行查词 → 200 个词 → 收了 120 → 练了 6 → 过 3 挂 3', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seed(r.db)
  const f = new Learning(r.db).build(30, NOW).funnel

  assert(f.lookups === SHAPE.lookups, `查词行 ${f.lookups}`)
  assert(f.looked === LOOKUP_TERMS, `★★ 不同词面 ${f.looked} —— 归一化没吃下大小写 / 尾点`)
  assert(f.captured === CAPTURED_TERMS, `★★ 对上库里条目的词面 ${f.captured}`)
  assert(f.capturedGone === 0, `收过又删的 ${f.capturedGone}`)
  assert(f.lookedNotCaptured.length === LOOKUP_TERMS - CAPTURED_TERMS,
    `查了没收 ${f.lookedNotCaptured.length}`)
  assert(f.practiced === 6, `练过的词面 ${f.practiced}`)
  assert(f.passed === 3 && f.failed === 3, `过 ${f.passed} 挂 ${f.failed}`)
  // 挂得最多的排最前（item 1 产出挂 2 次 + 认读忘 1 次）
  assert(f.practicedFailing.map((i) => i.itemId).join(',') === '1,6,4',
    `练了还挂的是 ${f.practicedFailing.map((i) => i.itemId).join(',')}`)
  assert(f.capturedNotPracticed.length === CAPTURED_TERMS - 6,
    `收了没练 ${f.capturedNotPracticed.length}`)
  r.db.close()
})

check('T-4.12 · ⑤ 逐条证据：两条线各自数，查词按归一化词面对上', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seed(r.db)
  const v = new Learning(r.db).build(30, NOW)

  assert(v.evidence.length === SHAPE.items, `逐条 ${v.evidence.length}`)
  const one = v.evidence.find((e) => e.itemId === 1)!
  assert(one.attempts === 2, `第一次判定 ${one.attempts}（改到过关那次不算）`)
  assert(one.passes === 0 && one.fails === 2, `过 ${one.passes} 挂 ${one.fails}`)
  assert(one.reviews === 1 && one.lapses === 1, `认读 ${one.reviews} 次、忘了 ${one.lapses} 次`)
  // word-0 在 1,142 行里被查到的次数 = ceil(1142 / 200)
  assert(one.lookups === Math.ceil(SHAPE.lookups / LOOKUP_TERMS),
    `★★ word-0 查了 ${one.lookups} 次 —— 大小写 / 尾点没归一化`)
  assert(one.analysed && one.edited, '这一条既分析过也改过，两个记号都该是真')
  assert(one.devices.length === 1 && one.devices[0] === PHONE, `设备 ${one.devices.join('/')}`)

  const weak = v.weak.map((e) => e.itemId)
  assert(weak.join(',') === '1', `★ 反复失败榜该只有 item 1（挂了两次），实际：${weak.join(',')}`)
  assert(v.strong.length === 0, `★ 没有条目连续过 3 次，强项榜该是空的，实际 ${v.strong.length} 条`)
  r.db.close()
})

check('T-4.12 · ⑥★ 「为什么」的每一句都指得回真实存在的事件行', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seed(r.db)
  const v = new Learning(r.db).build(30, NOW)

  assert(v.why.length >= 4, `「为什么」只出了 ${v.why.length} 句`)
  for (const w of v.why) {
    assert(w.threshold.length > 0 && w.source.length > 0, `${w.rule} 没写阈值或来源`)
    assert(w.refs.length > 0, `★ ${w.rule} 指不回任何一行`)
    for (const ref of w.refs.slice(0, 3)) {
      assert(
        (EVIDENCE_TABLES as readonly string[]).includes(ref.table),
        `★★ ${w.rule} 指向了证据表之外的 ${ref.table}`
      )
      const n = (
        r.db.prepare(`select count(*) as n from ${ref.table} where id = ?`).get(ref.id) as { n: number }
      ).n
      assert(n === 1, `★★ ${w.rule} 指的 ${ref.table}#${ref.id} 在库里根本不存在`)
    }
  }
  const stale = v.why.find((w) => w.rule === 'stale')
  if (stale) {
    const silent = r.db
      .prepare(`select count(*) as n from items where production_state = 'silent' and id in (${stale.itemIds.join(',') || '-1'})`)
      .get() as { n: number }
    assert(silent.n === 0, '★★ 静默的条目被说成「练过、最近没碰」—— 那是冤枉他（D-030）')
  }
  r.db.close()
})

check('T-4.12 · ⑦ 空库不炸：一个数都没有，也不许抛', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const v = new Learning(r.db).build(30, NOW)
  assert(v.evidence.length === 0, '空库不该有逐条证据')
  assert(v.activity.totals.answers === 0 && v.activity.totals.reviews === 0, '空库的活动不是 0')
  assert(v.activity.byDay.length === 30, `空库也要有每一天：${v.activity.byDay.length}`)
  assert(v.why.length === 0, '★ 没有事实就不许出话')
  assert(v.funnel.looked === 0 && v.funnel.captured === 0, '空库的漏斗不是 0')
  assert(v.trend.current.firstTry.rate === null, '★ 没样本时正确率要是 null，不是 0')
  r.db.close()
})
