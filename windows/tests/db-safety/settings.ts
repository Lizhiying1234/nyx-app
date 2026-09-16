/**
 * 默认词典与悬浮卡片 · V-1 / V-2 设置真的进了生产 · V-3 / R-2 静默与产出资格各只有一份判据
 *
 * 原 tests/db-safety.ts 第 13237–14085 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { MIGRATIONS } from '../../src/main/db/migrations.ts'
import { Dicts } from '../../src/main/dict/index.ts'
import { ParamStore } from '../../src/main/params.ts'
import { Prefs } from '../../src/main/db/prefs.ts'
import { isItemSilent, productionApplies } from '../../src/core/silence.ts'
import { IS_SILENT, PRODUCTION_APPLIES } from '../../src/main/db/silence-sql.ts'
import { applyGrade } from '../../src/core/grading.ts'
import { writePlainDict } from '../make-dict.ts'
import { Study } from '../../src/main/study.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { check, assert, freshDir } from './harness.ts'
import { seedTree, startedLecture, studySources } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ 默认词典 · 悬浮词典卡片（2026-08-16）
//
// 三个状态分得很清（他的裁决）：
//   System Initial  从没设过 → sort_order 最靠前的那本可用的。**不写进设置**
//   User Default    settings['dict.default']，值是 dictionaries.id
//   Current         卡片内存里那本；他一切换就同时写回 Default
//
// 判据只有 `Dicts.defaultBook()` 一处 —— 界面不许自己算哪本是默认的。
// ══════════════════════════════════════════════════════════════

console.log('\n默认词典 · 悬浮卡片\n')

/** 造两本真词典文件（走真的 StarDict 解析，不是替身） */
function dictScene(): {
  r: ReturnType<typeof openDatabase>
  dicts: Dicts
  rows: { id: number; bookname: string }[]
} {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const dictsDir = join(dir, 'dicts')
  writePlainDict(dictsDir, 'aaa', [
    { word: 'brunt', body: "brunt\n[brʌnt]\n\nn.\n冲击；主要压力" },
    { word: 'spool', body: 'spool\n[spuːl]\n\nn.\n线轴' }
  ])
  writePlainDict(dictsDir, 'bbb', [{ word: 'brunt', body: 'brunt\nnoun /brʌnt/\nthe main force' }])
  const dicts = new Dicts(r.db, dictsDir)
  dicts.rescan()
  const rows = dicts.list().map((x) => ({ id: x.id, bookname: x.bookname }))
  return { r, dicts, rows }
}

const defOf = (d: Dicts): string | null => d.defaultBook().book?.bookname ?? null

/**
 * ★★ D2.1 起「他设的默认词典」存在**偏好表**里，值是 `dictUid`（跟着人走）。
 *
 * 在这之前存的是 `settings['dict.default']` = 本机 `dictionaries.id` ——
 * 那个数在另一台机器上指向另一本词典。他 2026-08-19 改的裁决就是冲这一点。
 * 这个 helper 一起读两处：偏好表是现在的真相，旧键只在「还没自愈」时才有值。
 */
const savedDefault = (r: ReturnType<typeof openDatabase>): string | null =>
  new Prefs(r.db).raw('dict.default') ??
  ((r.db.prepare(`select value from settings where key = 'dict.default'`).get() as
    | { value: string }
    | undefined)?.value ?? null)

/** 某一行词典的跨设备身份 —— 断言「存进去的是身份，不是 id」用 */
const uidOfDict = (d: Dicts, id: number): string | null =>
  d.registry.records().find((x) => x.id === id)?.uid ?? null

check('★★ 从没设过 → 用 sort_order 最靠前的那本，**并且不写进设置**', () => {
  const { r, dicts, rows } = dictScene()
  assert(rows.length === 2, `前提：该有两本，实际 ${rows.length}`)
  assert(defOf(dicts) === rows[0]!.bookname, `第一次该用第一本：${defOf(dicts)}`)
  assert(
    savedDefault(r) === null,
    '★★ 系统初始值被写进设置了 —— 那他就再也分不清「我没选过」和「我选了第一本」'
  )
  r.db.close()
})

check('★★ 他主动换一本 → 立刻成为默认，并且落库', () => {
  const { r, dicts, rows } = dictScene()
  dicts.setDefaultBook(rows[1]!.id)
  assert(defOf(dicts) === rows[1]!.bookname, `换了没生效：${defOf(dicts)}`)
  /** ★★ 存的是**身份**不是 id —— 存 id 的话换台设备就指到另一本书上去了 */
  assert(
    savedDefault(r) === uidOfDict(dicts, rows[1]!.id),
    `存的不是这本词典的身份：${savedDefault(r)}`
  )
  assert(savedDefault(r)?.startsWith('dictionaries-nat-') === true, '★★ 存成本机 id 了')
  r.db.close()
})

check('★★ 关掉软件再开（重新打开库）→ 默认还是他选的那本', () => {
  const { db: p, backups, dir } = freshDir()
  const dictsDir = join(dir, 'dicts')
  writePlainDict(dictsDir, 'aaa', [{ word: 'brunt', body: 'brunt\n[brʌnt]\nn.\n冲击' }])
  writePlainDict(dictsDir, 'bbb', [{ word: 'brunt', body: 'brunt\nnoun\nforce' }])

  const first = openDatabase(p, backups)
  const d1 = new Dicts(first.db, dictsDir)
  d1.rescan()
  const second = d1.list()[1]!
  d1.setDefaultBook(second.id)
  first.db.close()

  const again = openDatabase(p, backups)
  const d2 = new Dicts(again.db, dictsDir)
  d2.rescan()
  assert(
    d2.defaultBook().book?.id === second.id,
    `★★ 重开之后默认词典变了：${d2.defaultBook().book?.bookname}`
  )
  again.db.close()
})

check('★★ 默认那本被停用 → 临时换一本，**设置一个字都不改**', () => {
  const { r, dicts, rows } = dictScene()
  dicts.setDefaultBook(rows[1]!.id)
  dicts.setEnabled(rows[1]!.id, false)

  const d = dicts.defaultBook()
  assert(d.book?.id === rows[0]!.id, `没退到可用的那本：${d.book?.bookname}`)
  assert(d.fellBack, '★ 退了却没说自己退了 —— 卡片上就没法告诉他')
  assert(d.wanted?.id === rows[1]!.id, '★ 忘了他原本要哪本')
  assert(
    savedDefault(r) === uidOfDict(dicts, rows[1]!.id),
    '★★ 临时退回却把他的设置改了 —— 他重新启用之后就回不去了'
  )

  // 重新启用 → 自己回到他选的那本
  dicts.setEnabled(rows[1]!.id, true)
  assert(dicts.defaultBook().book?.id === rows[1]!.id, '★★ 恢复可用之后没自己回去')
  assert(dicts.defaultBook().fellBack === false, '★ 还在说自己退过')
  r.db.close()
})

check('★★ 默认那本文件不在了（missing）→ 同样只是临时退，不改设置', () => {
  const { r, dicts, rows } = dictScene()
  dicts.setDefaultBook(rows[1]!.id)
  // 把文件挪走 = 拔了移动硬盘
  const gone = dicts.list().find((x) => x.id === rows[1]!.id)!
  for (const ext of ['.ifo', '.idx', '.dict']) {
    const f = gone.ifoPath.replace(/\.ifo$/, ext)
    if (existsSync(f)) rmSync(f)
  }
  dicts.rescan()

  const d = dicts.defaultBook()
  assert(d.book?.id === rows[0]!.id, `文件没了却没退：${d.book?.bookname}`)
  assert(d.fellBack, '★ 退了没说')
  assert(savedDefault(r) !== null && savedDefault(r) !== '', '★★ 拔个硬盘就把他的设置抹了')
  assert(savedDefault(r)?.startsWith('dictionaries-nat-') === true, '★ 存的不是身份')
  r.db.close()
})

check('★ 认不出的 id 不许写进设置', () => {
  const { r, dicts } = dictScene()
  dicts.setDefaultBook(99999)
  assert(savedDefault(r) === null, '★ 存了一个指不到任何东西的默认词典')
  r.db.close()
})

check('★★ 卡片：单本、带词目、带解析、带「还有哪几本有」', () => {
  const { r, dicts, rows } = dictScene()
  const card = dicts.lookupCard('brunt')
  assert(card.book?.id === rows[0]!.id, `没用默认那本：${card.book?.name}`)
  assert(card.headword === 'brunt', `词目不对：${card.headword}`)
  assert(card.phonetic === 'brʌnt', `音标没抽出来：${card.phonetic}`)
  assert(card.senses.length >= 1, '释义没抽出来')
  assert(card.raw.includes('冲击'), 'raw 丢了')
  assert(
    card.others.length === 1 && card.others[0]!.id === rows[1]!.id,
    `★ 「还有哪几本有」不对：${JSON.stringify(card.others)}`
  )
  r.db.close()
})

check('★★ 卡片：指定另一本 → 换的是内容，**不动默认**', () => {
  const { r, dicts, rows } = dictScene()
  const card = dicts.lookupCard('brunt', rows[1]!.id)
  assert(card.book?.id === rows[1]!.id, '没按指定的那本查')
  assert(card.raw.includes('the main force'), `拿到的还是上一本的内容：${card.raw.slice(0, 40)}`)
  assert(
    savedDefault(r) === null,
    '★★ 只是看一眼别的词典就把默认改了 —— 改默认必须是他点选择器那个动作'
  )
  r.db.close()
})

check('★★ 查不到不是错误：空结果 + raw 为空，不抛异常', () => {
  const { r, dicts } = dictScene()
  const card = dicts.lookupCard('zzzznotaword')
  assert(card.book !== null, '连词典都没有了')
  assert(card.senses.length === 0 && card.raw === '', '查不到却拿回了内容')
  assert(card.headword === '', '查不到却报了一个词目')
  r.db.close()
})

check('★★ 他选中一整段 → 卡片查的是里面最实的那个词，并且说出来', () => {
  const { r, dicts } = dictScene()
  const card = dicts.lookupCard('bear the brunt of the storm')
  assert(card.headword === 'brunt', `★★ 拿整段去查了：headword = ${card.headword}`)
  assert(card.word === 'bear the brunt of the storm', '他选的那串字要留着，卡片上要对照显示')
  r.db.close()
})

check('★ 一本可用的都没有 → 卡片说得出来，不崩', () => {
  const { r, dicts, rows } = dictScene()
  for (const x of rows) dicts.setEnabled(x.id, false)
  const card = dicts.lookupCard('brunt')
  assert(card.book === null, '全停用了却还说有词典')
  assert(card.senses.length === 0 && card.others.length === 0, '全停用了却查出了东西')
  r.db.close()
})

check('★★ 多词典查询（词条详情页那条路）一个字没变', () => {
  /**
   * 卡片是**单本**，`lookup()` 是**多本并列** —— 两种用法各走各的。
   * 这一条守的是：加卡片没有把老路改窄。ItemDetail 的「N 本查到」、
   * D-150 从词典捞例句，靠的都是它。
   */
  const { r, dicts } = dictScene()
  const hits = dicts.lookup('brunt')
  assert(hits.length === 2, `★★ 多词典查询被改窄了：${hits.length} 本`)
  assert(hits.every((h) => h.text.length > 0), '有一本查到了却是空的')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ V-1 / V-2 · Runtime Audit 收口第一轮（2026-08-16）
//
// 两条都是同一种病的两张脸：**判据写好了，生产没用它**。
//   V-1  首页写 `daily.target`，生产读 `param.dailyTarget` —— 两个键从不相交
//   V-2  `shouldRetireReadingCard` 有实现、有测试、**生产调用者 0**
// ══════════════════════════════════════════════════════════════

console.log('\nV-1 / V-2 · 设置真的进了生产\n')

check('★★ V-1 · 首页设成 20 → 重开软件还是 20', () => {
  /**
   * 老实现在这里断掉：`setDailyTarget` 写 `settings['daily.target']`，
   * 而 `dailyTarget()` 读的是 `param.dailyTarget`。当时那一屏是对的
   * （数字被当参数传给了 `todayPlan`），**重开就回到 35** ——
   * 而 35 正是内置默认值，他多半会以为自己没点上。
   */
  const { db: p, backups } = freshDir()
  const first = openDatabase(p, backups)
  seedTree(first)
  new Study(first.db, join(process.cwd(), 'prompts'), () => 'B2').setDailyTarget(20)
  first.db.close()

  const again = openDatabase(p, backups)
  const study = new Study(again.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(
    study.dailyTarget() === 20,
    `★★ 重开之后每日条数变了：${study.dailyTarget()}（他设的是 20）`
  )
  // 生产那一端也要真的用它：不带参数的 todayPlan 走的就是这个数
  assert(study.todayPlan().target === 20, `★★ 今日练习没按他设的条数算：${study.todayPlan().target}`)
  again.db.close()
})

check('★★ V-1 · 首页和设置页写的是同一个键', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')

  study.setDailyTarget(20) // 首页那条路
  const viaParams = new ParamStore(r.db).list().find((x) => x.key === 'dailyTarget')
  assert(viaParams?.value === 20, `★★ 设置页读不到首页写的值：${viaParams?.value}`)
  assert(viaParams?.changed === true, '★ 设置页不认为这项被改过 —— 那个「已改」标记会骗他')

  new ParamStore(r.db).set('dailyTarget', 44) // 设置页那条路
  assert(study.dailyTarget() === 44, `★★ 首页读不到设置页写的值：${study.dailyTarget()}`)

  // 业务上不该再有第二个键
  const stray = r.db.prepare(`select count(*) as n from settings where key = 'daily.target'`).get() as {
    n: number
  }
  assert(stray.n === 0, '★★ 又写了一个没人读的 `daily.target`')
  r.db.close()
})

// ── V-1 补课：升级时把他**已经设过**的那个值搬过来（V26）────────────
//
// V-1 只修好了「以后」。他机器上那一行 `daily.target = 95` 是修复**之前**
// 首页写的，新键从来没被创建过 —— 升级后读到的仍是默认 35。
// 2026-08-17 真机验收第 3 项就是撞在这里：全库只有 `daily.target = 95`。
//
// 下面五条是这条迁移的**回归闸**。造旧库的办法：只跑到 V25 为止
// （`MIGRATIONS.slice(0, 25)` → `user_version = 25`），插进 legacy 键，
// 再用完整 MIGRATIONS 打开一次，V26 才会跑。

/** 造一个「V-1 修复之前的」库：停在 v25，settings 里只有 legacy 键 */
function preV1Db(legacyValue: string | null, canonicalValue?: string) {
  const { db: p, backups } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.slice(0, 25))
  assert(
    (old.db.pragma('user_version', { simple: true }) as number) === 25,
    '夹具没停在 v25 —— 那样 V26 会跟着一起跑，这条用例就测不到升级'
  )
  const t = Date.now()
  const put = (k: string, v: string): void => {
    old.db
      .prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)`)
      .run(k, v, t)
  }
  if (legacyValue !== null) put('daily.target', legacyValue)
  if (canonicalValue !== undefined) put('param.dailyTarget', canonicalValue)
  old.db.close()
  return { p, backups }
}

check('★★ V26 · 他设过的 95 升级后还是 95（真机第 3 项）', () => {
  const { p, backups } = preV1Db('95')
  const r = openDatabase(p, backups)
  assert(r.migrated === true, 'V26 没跑')

  // ① 生产那一端真的读到了 —— 不是只在 settings 里躺着
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(study.dailyTarget() === 95, `★★ 他设的 95 丢了：${study.dailyTarget()}`)
  assert(
    new ParamStore(r.db).list().find((x) => x.key === 'dailyTarget')?.value === 95,
    '★★ 设置页也读不到'
  )

  // ② legacy 行删掉了 —— 不许留第二个「看起来像真相」的东西
  const stray = r.db
    .prepare(`select count(*) as n from settings where key = 'daily.target'`)
    .get() as { n: number }
  assert(stray.n === 0, '★★ legacy 键还在，长期看会长出第二个真相')
  r.db.close()
})

check('★★ V26 · canonical 已经有值 → legacy 不许盖掉它', () => {
  /**
   * 他升级后又自己设过一次，那次才是他现在的意思。
   * 拿旧值盖回去就是**第二次**静默丢失，比第一次更难发现。
   */
  const { p, backups } = preV1Db('95', '20')
  const r = openDatabase(p, backups)
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(study.dailyTarget() === 20, `★★ 旧值把新值盖掉了：${study.dailyTarget()}`)
  r.db.close()
})

check('★ V26 · legacy 超出范围 → 按 ParamStore 的规矩钳住，不另写一份', () => {
  for (const [raw, want] of [
    ['99999', 500],
    ['0', 1],
    ['-7', 1],
    ['35.6', 36]
  ] as const) {
    const { p, backups } = preV1Db(raw)
    const r = openDatabase(p, backups)
    const got = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2').dailyTarget()
    assert(got === want, `legacy=${raw} 应当成为 ${want}，实际 ${got}`)
    r.db.close()
  }
})

check('★ V26 · legacy 不是个数 → 不搬，回落默认，也不写进一行 NaN', () => {
  for (const raw of ['abc', '', 'null']) {
    const { p, backups } = preV1Db(raw)
    const r = openDatabase(p, backups)
    const got = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2').dailyTarget()
    assert(got === 35, `legacy=${JSON.stringify(raw)} 时应回落默认 35，实际 ${got}`)
    const junk = r.db
      .prepare(`select count(*) as n from settings where key = 'param.dailyTarget'`)
      .get() as { n: number }
    assert(junk.n === 0, `★★ 写进了一行读不回来的脏数据（legacy=${JSON.stringify(raw)}）`)
    r.db.close()
  }
})

check('★ V26 · 压根没有 legacy → 一切照旧，默认 35', () => {
  const { p, backups } = preV1Db(null)
  const r = openDatabase(p, backups)
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(study.dailyTarget() === 35, `没有 legacy 时不该变：${study.dailyTarget()}`)
  study.setDailyTarget(42)
  assert(study.dailyTarget() === 42, '迁移之后正常的写读路径坏了')
  r.db.close()
})

check('★ V-1 · 上下限钳位跟着 ParamStore 走（首页也不例外）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  study.setDailyTarget(0)
  assert(study.dailyTarget() === 1, `下限没钳住：${study.dailyTarget()}`)
  study.setDailyTarget(99999)
  assert(study.dailyTarget() === 500, `上限没钳住：${study.dailyTarget()}`)
  r.db.close()
})

/**
 * ★★ V-2 · 走**真实作答路径**把一条练到产出静默，然后看认读卡还在不在。
 *
 * 判据全部查库，不看返回值 —— 返回值说 `silenced: true` 是一回事，
 * 认读队列里还有没有它是另一回事，而他遇到的正是后者。
 */
function silenceByAnswering(r: ReturnType<typeof openDatabase>, itemId: number): Study {
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  const inner = study as unknown as {
    progressOf(id: number): unknown
    saveProgress(id: number, p: unknown): void
    params: ParamStore
  }
  const need = inner.params.effective().grading.silenceStreak
  // 连续答对 N 次 —— 走的是 submitAnswer 内部那条 applyGrade → saveProgress
  for (let i = 0; i < need; i++) {
    const prev = inner.progressOf(itemId) as Parameters<typeof applyGrade>[0]
    const out = applyGrade(prev, 4, inner.params.effective().grading)
    inner.saveProgress(itemId, out.progress)
  }
  return study
}

/** AI 提取的那种条目：跑产出线（R-2 的正式规则）。挂在第 1 讲上 */
function aiItem(r: ReturnType<typeof openDatabase>, term: string, layer: 'A' | 'B' = 'B'): number {
  const t = Date.now()
  const id = Number(
    r.db
      .prepare(
        `insert into items (term, gloss, layer, kind, source, owner_lecture_id, confidence,
                            created_at, updated_at)
         values (?, '', ?, 'chunk', 'ai', 1, 0.9, ?, ?)`
      )
      .run(term, layer, t, t).lastInsertRowid
  )
  r.db
    .prepare(
      `insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
       values (?, 1, 1, ?, ?)`
    )
    .run(id, t, t)
  return id
}

check('★★ V-2 · 产出线练到静默 → 那张认读卡不再进 dueCards', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  /**
   * ★ 用 AI 提取的那种条目（`source='ai'`）。
   *
   * 原来这里用 `addItem`，它建出来的是 `source='self'` 且 `derived_from is null`——
   * 按 R-2 的正式裁决那是「我的上传库」的**根条目**，**不跑产出线**，
   * 于是产出静默对它不适用、认读卡自然也不该退役。
   * 夹具是在旧规则下写的，规则变了要跟着换 —— 断言一个字没动。
   */
  const id = aiItem(r, 'retire me')
  // 让它现在就到期，否则「不在队列里」可能只是因为还没到日子
  r.db.prepare(`update reading_cards set due_at = ? where item_id = ?`).run(Date.now() - 1000, id)

  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(
    study.dueCards(1, 50).some((c) => c.id === id),
    '前提没成立：练之前它本来就不在认读队列里'
  )

  silenceByAnswering(r, id)

  const row = r.db
    .prepare(`select i.production_state as st, rc.silent as cs, rc.due_at as due
                from items i join reading_cards rc on rc.item_id = i.id where i.id = ?`)
    .get(id) as { st: string; cs: number; due: number | null }
  assert(row.st === 'silent', `前提没成立：产出线没到静默 —— ${row.st}`)
  assert(row.cs === 1, '★★ 产出静默了，认读卡却没退役 —— 他已经不再轮转的条目会天天来找他（D-135）')
  assert(row.due === null, '★ 退役了却留着到期时间 —— 取消静默那天它会带着一屁股过期债冒出来')
  assert(
    !study.dueCards(1, 50).some((c) => c.id === id),
    '★★ 它还在认读队列里'
  )
  r.db.close()
})

check('★★ R-2 × V-2 · 整段原句：产出静默不适用，认读卡也不退役', () => {
  /**
   * 整段贴进来的原句不跑产出线（R-2 冻结规则：`kind = 'sentence'`），
   * 所以「产出静默 → 认读卡退役」这条规则对它不成立 ——
   * 它的静默一直由认读线自己决定。这一条守的是**接线没接错人**。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const id = shapedItem(r, { layer: 'B', kind: 'sentence', source: 'self' })
  r.db
    .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
              values (?, 1, 1, ?, ?)`)
    .run(id, Date.now(), Date.now())
  const shape = r.db.prepare(`select kind from items where id = ?`).get(id) as { kind: string }
  assert(shape.kind === 'sentence', `前提：该是整段原句 —— ${JSON.stringify(shape)}`)

  silenceByAnswering(r, id)
  const row = r.db
    .prepare(`select i.production_state as st, rc.silent as cs from items i join reading_cards rc on rc.item_id = i.id where i.id = ?`)
    .get(id) as { st: string; cs: number }
  assert(row.cs === 0, `★★ 不跑产出线的条目被产出静默退役了认读卡：${JSON.stringify(row)}`)
  r.db.close()
})

check('★★ V-2 · 被动词汇（A 层）不受影响：它本来就只跑认读线', () => {
  /**
   * D-023：被动词汇没有产出线。它的静默一直由认读线自己决定，
   * 这一次接线不许顺手把它也退役掉。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const id = aiItem(r, 'passive one', 'A')
  r.db.prepare(`update reading_cards set due_at = ? where item_id = ?`).run(Date.now() - 1000, id)

  silenceByAnswering(r, id)

  const row = r.db
    .prepare(`select i.production_state as st, rc.silent as cs from items i join reading_cards rc on rc.item_id = i.id where i.id = ?`)
    .get(id) as { st: string; cs: number }
  assert(row.cs === 0, `★★ 被动词汇的认读卡被产出线退役了（它压根没有产出线）：${JSON.stringify(row)}`)
  r.db.close()
})

check('★ V-2 · 只静默一次：已经退役的不再重复写事件', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const id = aiItem(r, 'once only')
  silenceByAnswering(r, id)
  const n1 = (
    r.db
      .prepare(`select count(*) as n from state_events where item_id = ? and line = 'reading'`)
      .get(id) as { n: number }
  ).n
  /**
   * ★ 不能再调 `applyGrade` —— 静默条目本来就拒绝判分（D-024：只能先手动召回），
   *   那会红在夹具上。直接把同一份进度再存一次：模拟别的路径又写了一遍。
   */
  const inner = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2') as unknown as {
    progressOf(id: number): unknown
    saveProgress(id: number, p: unknown): void
  }
  inner.saveProgress(id, inner.progressOf(id))
  const n2 = (
    r.db
      .prepare(`select count(*) as n from state_events where item_id = ? and line = 'reading'`)
      .get(id) as { n: number }
  ).n
  assert(n1 === 1, `退役该记一次，实际 ${n1}`)
  assert(n2 === 1, `★ 每答一次就多记一条退役事件：${n2}`)
  r.db.close()
})

check('★★ V-2 · 判据只有一份：study.ts 不许自己写「state === silent」那一套', () => {
  /**
   * 这条守的是**将来**。`if (p.state === 'silent') card_silent = 1` 写起来只要一行，
   * 而它一旦出现，D-135 的判据就有了第二处 —— 那种分家的表现是
   * 「有的条目退役了、有的没有」，谁都查不出规律。
   */
  const src = studySources()
  const from = src.indexOf('function saveProgress')
  const whole = src.slice(from, src.indexOf('\n}', src.indexOf('state_events', from)) + 2)
  const body = whole.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*/g, '$1')
  assert(body.includes('shouldRetireReadingCard'), '★★ 退役判据不再接在生产路径上了')
  assert(
    !/state\s*===\s*'silent'/.test(body) && !/p\.state\s*==/.test(body),
    '★★ study.ts 里又自己写了一套静默判断'
  )
})

// ══════════════════════════════════════════════════════════════
// ★★ V-3 / R-2 · 「静默」和「跑不跑产出线」各只有一份判据（2026-08-16）
//
// 修之前查询层自己定义了一套更宽的语义：
//   静默知识库  `production_state='silent' or card_silent=1`   任一线静默即算
//   领域判据    `isItemSilent`                                  B 层只看产出线
// 于是同一条知识点，在静默知识库里算静默、在业务判据里不算，而两边都说得通。
//
// 「跑不跑产出线」更热闹，生产里有三种口径：
//   `layer='B'`                                   产出队列 / 今日练习 / 体检 / 报告
//   `layer='B' and not (self 根条目)`              知识库「主动词汇」那一档
//   `productionApplies`（布尔，调用方自己填）        core/silence.ts
// ══════════════════════════════════════════════════════════════

console.log('\nV-3 / R-2 · 静默与产出资格各只有一份判据\n')

/** 造一条指定形状的条目，直接写库 —— 这几条验的是判据，不是入库流程 */
function shapedItem(
  r: ReturnType<typeof openDatabase>,
  o: {
    layer: 'A' | 'B'
    /** `sentence` = 整段贴进来的原句；`chunk` = 一个表达 */
    kind?: string
    source?: string
    production?: string
    cardSilent?: 0 | 1
  }
): number {
  const t = Date.now()
  const id = Number(
    r.db
      .prepare(
        `insert into items (term, gloss, layer, kind, source, owner_lecture_id,
                            production_state, confidence, created_at, updated_at)
         values (?, '', ?, ?, ?, 1, ?, 0.9, ?, ?)`
      )
      .run(
        `shape-${Math.random().toString(36).slice(2, 9)}`,
        o.layer,
        o.kind ?? 'chunk',
        o.source ?? 'ai',
        o.production ?? 'new',
        t,
        t
      ).lastInsertRowid
  )
  /** D-296 (V34): the reading-line silence bit now lives in `reading_cards` */
  r.db
    .prepare(`update reading_cards set silent = ? where item_id = ?`)
    .run(o.cardSilent ?? 0, id)
  return id
}

/** 这一条在不在「静默知识库」里 —— 走真实的库查询，不是自己再算一遍 */
function inSilentLibrary(r: ReturnType<typeof openDatabase>, id: number): boolean {
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  return study.libraryItems({ scope: 'silent' }).some((x: { id: number }) => x.id === id)
}

check('★★ V-3 正向 · 真正静默的（B 层产出线静默）→ 在静默知识库里', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = shapedItem(r, { layer: 'B', production: 'silent' })
  assert(inSilentLibrary(r, id), '★★ 产出线已经静默的条目没出现在静默知识库')
  r.db.close()
})

check('★★ V-3 反向 · B 层只有认读线静默、产出线还在训练 → **不算静默**', () => {
  /**
   * 这一条是本轮的正题。老 SQL 的 `or card_silent = 1` 会把它算进去，
   * 而 `isItemSilent` 说 B 层只看产出线 —— 他打开静默知识库会看到还在练的东西。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = shapedItem(r, { layer: 'B', production: 'training', cardSilent: 1 })
  assert(
    !inSilentLibrary(r, id),
    '★★ 认读线静默、产出线还在训练的 B 层条目被算成静默了 —— 查询层又自己定义了一套更宽的语义'
  )
  r.db.close()
})

check('★★★ V-3 互补 · 不算静默的，就必须出现在综合知识库里（2026-09-02）', () => {
  /**
   * 上一条证明了「B 层认读线静默、产出线还在训练」**不算静默**。
   * 那它就必须在「全部」里看得到 —— 否则它哪个列表都不在。
   *
   * ★ 这曾经是真的：综合知识库那一句写的是
   *   `production_state != 'silent' and rc.silent = 0`（**任一线静默就藏**），
   *   而静默知识库用的是分层的 `IS_SILENT`。两把尺子中间漏出一条缝，
   *   而 `gradeCard` 会把练得好的 B 层条目**自然**送进那条缝里
   *   （认读间隔超过 silenceDays 就写 rc.silent = 1，items 一个字不动）。
   *   现在两处都用同一份翻译，D-158 的「静默不进列表」才真正成立。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = shapedItem(r, { layer: 'B', production: 'training', cardSilent: 1 })
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  const inMain = study.libraryItems({}).some((x: { id: number }) => x.id === id)
  assert(!inSilentLibrary(r, id), '前提：它不算静默')
  assert(
    inMain,
    '★★★ 它既不在静默知识库、也不在综合知识库 —— 一条还在练的知识点哪儿都找不到了'
  )
  r.db.close()
})

check('★★ V-3 · A 层只看认读线：认读静默 → 算静默', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const id = shapedItem(r, { layer: 'A', production: 'new', cardSilent: 1 })
  assert(inSilentLibrary(r, id), '★★ 被动词汇的认读线静默了却不算静默（它只有这一条线）')
  r.db.close()
})

check('★★ V-3 · 自动静默之后仍然成立（和 V-2 接上）', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const id = shapedItem(r, { layer: 'B', production: 'training' })
  r.db
    .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
              values (?, 1, 1, ?, ?)`)
    .run(id, Date.now(), Date.now())

  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  const inner = study as unknown as {
    progressOf(id: number): Parameters<typeof applyGrade>[0]
    saveProgress(id: number, p: unknown): void
    params: ParamStore
  }
  const need = inner.params.effective().grading.silenceStreak
  for (let i = 0; i < need; i++) {
    inner.saveProgress(id, applyGrade(inner.progressOf(id), 4, inner.params.effective().grading).progress)
  }
  const row = r.db
    .prepare(`select i.production_state as st, rc.silent as cs from items i join reading_cards rc on rc.item_id = i.id where i.id = ?`)
    .get(id) as { st: string; cs: number }
  assert(row.st === 'silent' && row.cs === 1, `前提：该两条线都静默了 —— ${JSON.stringify(row)}`)
  assert(inSilentLibrary(r, id), '★★ 练到静默的条目反而不在静默知识库里了')
  r.db.close()
})

check('★★ R-2 · 整段贴进来的原句（kind=sentence）不进产出线', () => {
  /**
   * ★ 判据认的是 `kind`，不是 `source`（2026-08-17 冻结）。
   *
   * 第一版写成 `not (source='self' and derived_from is null)`，想排除整段原句，
   * 实际排掉的却是**右键「收成主动词汇 · 要练到能写出来」**收进来的条目 ——
   * 那颗按钮的承诺当场作废。整段贴入本来就是 layer='A'，layer='B' 已经挡住了。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const t = Date.now()
  const sentence = shapedItem(r, { layer: 'B', kind: 'sentence', source: 'self' })
  r.db
    .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
              values (?, 1, 1, ?, ?)`)
    .run(sentence, t, t)

  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(
    !study.productionQueue(1).some((x) => x.id === sentence),
    '★★ 整段原句进了产出队列 —— 那是拿一整句话去当一个表达考'
  )
  assert(!productionApplies({ layer: 'B', kind: 'sentence' }), '判据本身就该说不适用')
  r.db.close()
})

check('★★ R-2 对照 · 右键「收成主动词汇」收的条目**照常**进产出线', () => {
  /**
   * ★ 这一条就是把 `errors.test.ts` 顶红的那个形状：
   * `source='self'` + `derived_from is null`，但 `kind='chunk'`。
   * 按钮上写着「要练到能写出来」，它就必须能练。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const t = Date.now()
  const sentence = shapedItem(r, { layer: 'B', kind: 'sentence', source: 'self' })
  r.db
    .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
              values (?, 1, 0, ?, ?)`)
    .run(sentence, t, t)
  const picked = new Repo(r.db).addItem(1, 'picked by right click', '', 'B', 'a quote here').id

  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  const q = study.productionQueue(1).map((x) => x.id)
  assert(
    q.includes(picked),
    '★★ 右键「收成主动词汇」收的条目进不了产出队列 —— 那颗按钮上写着「要练到能写出来」'
  )
  assert(!q.includes(sentence), '★ 整段原句又混进来了')
  r.db.close()
})

check('★ R-2 · 普通 B 层条目（AI 提取的）正常进产出线', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  startedLecture(r)
  const t = Date.now()
  const id = shapedItem(r, { layer: 'B' })
  r.db
    .prepare(`insert into item_lectures (item_id, lecture_id, is_owner, created_at, updated_at)
              values (?, 1, 1, ?, ?)`)
    .run(id, t, t)
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(study.productionQueue(1).some((x) => x.id === id), '★★ 普通主动词汇进不了产出队列')
  assert(productionApplies({ layer: 'B', kind: 'chunk' }), '判据说它不适用')
  r.db.close()
})

check('★★ 对拍 · SQL 只是翻译：全部形状逐格比对 TS 判据', () => {
  /**
   * ★ 这一条守的是**这一轮的全部意义**。
   *
   * 判据在 `core/silence.ts`，SQL 在 `main/db/silence-sql.ts` ——
   * 两份东西写的是同一句话，但它们**可以各自漂走**，而且漂了没人看得见：
   * 界面照常出数，只是数不对。所以拿真库逐格对拍。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)

  const shapes: { layer: 'A' | 'B'; kind: string; production: string; cardSilent: 0 | 1 }[] = []
  for (const layer of ['A', 'B'] as const) {
    for (const kind of ['chunk', 'sentence']) {
      for (const [production, cardSilent] of [
        ['training', 0],
        ['training', 1],
        ['silent', 0],
        ['silent', 1]
      ] as [string, 0 | 1][]) {
        shapes.push({ layer, kind, production, cardSilent })
      }
    }
  }

  for (const sh of shapes) {
    const id = shapedItem(r, sh)
    const sql = r.db
      .prepare(
        `select ${PRODUCTION_APPLIES('i')} as pa, ${IS_SILENT('i')} as sil
           from items i join reading_cards rc on rc.item_id = i.id where i.id = ?`
      )
      .get(id) as { pa: number; sil: number }

    const ts = {
      pa: productionApplies({ layer: sh.layer, kind: sh.kind }),
      sil: isItemSilent({
        production: sh.production as 'new' | 'training' | 'hard' | 'silent',
        productionApplies: productionApplies({ layer: sh.layer, kind: sh.kind }),
        readingSilent: sh.cardSilent === 1
      })
    }
    assert(
      (sql.pa === 1) === ts.pa,
      `★★ 产出资格：SQL 说 ${sql.pa}，判据说 ${ts.pa} —— ${JSON.stringify(sh)}`
    )
    assert(
      (sql.sil === 1) === ts.sil,
      `★★ 静默：SQL 说 ${sql.sil}，判据说 ${ts.sil} —— ${JSON.stringify(sh)}`
    )
  }
  r.db.close()
})

check('★ 判据只有一处：生产代码里不许再出现旧谓词', () => {
  /**
   * 这条守的是将来。`layer = 'B'` 写起来太顺手了，而它一旦重新出现，
   * 「产出线适用于谁」就又有了第二个定义 —— 表现是两个界面的数字对不上，
   * 而两边代码各自都说得通，谁都查不出是哪一边错了。
   */
  const files = ['study.ts', 'browse.ts', 'report.ts', 'db/audit.ts']
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), 'src', 'main', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1')
    assert(
      !/production_state\s*=\s*'silent'\s*or/.test(src),
      `★★ ${f} 里又出现了「任一线静默即算静默」`
    )
    assert(!/i\.layer\s*=\s*'B'/.test(src), `★★ ${f} 里又出现了裸的 layer = 'B' 产出资格判定`)
  }
})

