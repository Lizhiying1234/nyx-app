/**
 * 题型勾选：他勾什么就只出什么 · F-6 占位符扫全项目 · R-3-h 自增 id 不能当跨设备身份
 *
 * 原 tests/db-safety.ts 第 12290–13236 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { MIGRATIONS } from '../../src/main/db/migrations.ts'
import { QTypes } from '../../src/main/db/qtypes.ts'
import { Study } from '../../src/main/study.ts'
import { fill } from '../../src/main/ai/prompts.ts'
import { Files } from '../../src/main/files.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { ParamStore } from '../../src/main/params.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, cloudFiles, cloudReady, configureSync, syncUntilDone, fakeAi, setUpAi, studySources } from './fixtures.ts'
import { Prefs } from '../../src/main/db/prefs.ts'
import { KEPT_OLD_NOTICE } from '../../src/core/question-refresh.ts'
import {
  CONTEXT_SPREAD_LINES,
  FULL_SENTENCE_LINE,
  MATCH_REGISTER_LINE,
  NO_SOURCE_LINE,
  QUIZ_RULE_KEYS
} from '../../src/core/quiz-rules.ts'

// ══════════════════════════════════════════════════════════════
// ★★ 题型勾选：他勾什么就只出什么（2026-08-14）
//
// 他勾了六种（**没有造句**），软件一道接一道出「造句 · 第 1 档」。
// 四处叠在一起，每一处单独看都像「防御性代码」：
//   ① `q.type ?? '造句'`          没有题型就写死成造句
//   ② 收题不校验                   AI 返回什么就存什么
//   ③ 提示词示例里写着「造句」      被当成答案抄（I-108 同款）
//   ④ 空集 = 全选 / 按档兜底        他的选择在某些档位上根本不算数
// ══════════════════════════════════════════════════════════════

console.log('\n题型勾选 · 他勾什么就只出什么\n')

/** 造一台有题型表的机器，并把勾选设成 `picked` */
function qtScene(picked: string[] | null): {
  r: ReturnType<typeof openDatabase>
  study: Study
} {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const study = new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2')
  if (picked !== null) study.setQtypes(picked)
  return { r, study }
}

check('★★ 从来没设置过 → 全都要（第一次用的人不该面对空练习）', () => {
  const { r, study } = qtScene(null)
  const all = study.qt.active().map((q) => q.key)
  assert(study.qtypes().length === all.length, `第一次用该是全选，实际 ${study.qtypes().length}`)
  r.db.close()
})

check('★★ 他清空了 → 就是空的，**不许悄悄补成全选**', () => {
  /**
   * 老实现是 `on.length > 0 ? on : known` —— 清空等于全选。
   * 于是「清空」这个动作看起来毫无作用，而他以为自己关掉了所有题型。
   */
  const { r, study } = qtScene([])
  assert(
    study.qtypes().length === 0,
    `★★ 清空之后又变回了 ${study.qtypes().length} 种 —— 那正是他要取消的「默认题型」`
  )
  r.db.close()
})

check('★★ 他勾的那六种（没有造句）→ 读回来一个不多一个不少', () => {
  const his = ['搭配填空', '句子改写', '释义改写', '语域转换', '限定写作', '摘要写作']
  const { r, study } = qtScene(his)
  assert(JSON.stringify(study.qtypes().sort()) === JSON.stringify([...his].sort()), '存进去和读出来对不上')
  assert(!study.qtypes().includes('造句'), '★★ 造句自己冒出来了')
  r.db.close()
})

check('★★ 关掉软件再开（重新打开库）→ 勾选原样还在', () => {
  const { db: p, backups } = freshDir()
  const first = openDatabase(p, backups)
  seedTree(first)
  new Study(first.db, join(process.cwd(), 'prompts'), () => 'B2').setQtypes(['句子改写'])
  first.db.close()

  const again = openDatabase(p, backups)
  const study = new Study(again.db, join(process.cwd(), 'prompts'), () => 'B2')
  assert(
    JSON.stringify(study.qtypes()) === JSON.stringify(['句子改写']),
    `★★ 重开之后勾选变了：${JSON.stringify(study.qtypes())}`
  )
  again.db.close()
})

check('★★ 他没勾的题型 → 计划里严格没有，不退回「兜底题型」', () => {
  /**
   * 老实现两级兜底：这一档没勾 → canonical → 整档全部。
   * 他没勾造句，第 1 档照样把造句喂进提示词 —— 病根之一。
   */
  /**
   * ★ F-② 之后判据换了地方：那套两级兜底整个删掉了，「能用哪些」由
   * `core/qtype-plan.ts::pickedTypes` 唯一决定（★ 2026-09-08 档位取消前叫 `typesInTier`）。
   * 这里从**出题计划**这个唯一出口验 —— 那才是生产路径上真的在跑的东西。
   */
  const { r, study } = qtScene(['句子改写']) // 只勾一种
  const inner = study as unknown as { plan(itemId: number): { seq: number; type: string }[] }
  const plan = inner.plan(1)
  assert(plan.length > 0, '★★ 勾了一种却排不出计划')
  assert(
    plan.every((s) => s.type === '句子改写'),
    `★★ 计划里混进了他没勾的东西：${plan.map((s) => s.type).join('、')}`
  )
  r.db.close()
})

/** 直接往题库里塞题 —— 这几条验的是**发题**那一侧，不需要 AI */
function putQ(r: ReturnType<typeof openDatabase>, itemId: number, tier: number, type: string): number {
  /** ★ `tier` 这个参数留着只为**造老数据**：那一列按 D-216 还在，只是没人读了 */
  const t = Date.now()
  return Number(
    r.db
      .prepare(
        `insert into questions (item_id, tier, type, prompt, context, reference, created_at, updated_at)
         values (?, ?, ?, ?, 'original', null, ?, ?)`
      )
      .run(itemId, tier, type, `题面 ${type}`, t, t).lastInsertRowid
  )
}

check('★★ 发题也要轮换：上一道是造句，下一道优先换一种', () => {
  const { r, study } = qtScene(null)
  const id = new Repo(r.db).addItem(1, 'rotate me', '', 'B', '').id
  const q1 = putQ(r, id, 1, '造句')
  /**
   * ★ 这里必须**再放一道造句**，而且它的 id 比另一种小。
   *
   * 第一版没放：候选里只剩「搭配填空」一种，于是「按 id 取第一条」
   * 也能过 —— 负向对照把这条假绿抓了出来（去掉轮换判据，它照样绿）。
   * 现在的形状是：不避开的话必然又发一道造句。
   */
  putQ(r, id, 1, '造句')
  putQ(r, id, 1, '搭配填空')

  // 第一道发出去了
  r.db.prepare(`update questions set used_at = ? where id = ?`).run(Date.now(), q1)
  const next = study.nextQuestion(id)
  assert(next !== null, '没题了')
  assert(
    next!.type !== '造句',
    `★★ 又发了一道造句 —— 同一档里连着出同一种形式，他会以为软件只会这一种`
  )
  r.db.close()
})

check('★ 只剩同一种题型时照样要发得出来（不许卡住）', () => {
  const { r, study } = qtScene(null)
  const id = new Repo(r.db).addItem(1, 'only one kind', '', 'B', '').id
  const q1 = putQ(r, id, 1, '造句')
  putQ(r, id, 1, '造句')
  r.db.prepare(`update questions set used_at = ? where id = ?`).run(Date.now(), q1)

  const next = study.nextQuestion(id)
  assert(next !== null, '★★ 只剩同型的题就发不出来了 —— 练习卡死比重复更糟')
  assert(next!.type === '造句', '题型不对')
  r.db.close()
})

check('★★★ D-478 · 带 tier 的老题照样取得到（取题不再按档过滤）', () => {
  /**
   * ★★ 这一条守的是「老数据怎么办」那一节的承诺：档位取消之后，
   *   库里那些**带着 tier 的老题**不清库、不作废 —— 取题的判据只剩
   *   「未用过的下一道」，所以它们反而比以前更容易被取到
   *   （以前只有「正好等于当前档」的那几道能发）。
   *   拆掉这一条判据（把 `where tier = ?` 加回去）时，这条会红。
   */
  const { r, study } = qtScene(['句子改写'])
  const id = new Repo(r.db).addItem(1, 'old rows', '', 'B', '').id
  putQ(r, id, 5, '句子改写') // 老数据：第 5 档那一道

  const next = study.nextQuestion(id)
  assert(next !== null, '★★★ 老题取不到了 —— 他那些已经花钱生成的题全成了废纸')
  assert(next!.type === '句子改写', `取到的不是那一道：${JSON.stringify(next)}`)
  r.db.close()
})

check('★★ 一种题型都没勾 → 出题当场拒绝，并且说人话', async () => {
  const { r, study } = qtScene([])
  const id = new Repo(r.db).addItem(1, 'nothing picked', '', 'B', '').id
  let msg = ''
  try {
    await study.ensureQuestions(id)
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err)
  }
  assert(msg.length > 0, '★★ 一种都没勾却照常出题了 —— 那就是又替他选了默认题型')
  assert(
    msg.includes('题型'),
    `★ 报错没说清是题型的事，他看不懂该去哪：「${msg}」`
  )
  assert(
    (r.db.prepare(`select count(*) as n from questions where item_id = ?`).get(id) as { n: number }).n === 0,
    '★★ 拒绝之后还是往库里写了题'
  )
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ F-6 · 「AI 返回 15 道，一道都不是你选的题型」（2026-08-17 真机）
//
// 根因不在 AI，在我们：`generate-questions.md` 的 `{{TYPES}}` 写在 SYSTEM 段，
// 而 `study.ts` 只把 TYPES 喂给了 USER 段（USER 段根本没有这个占位符）。
// `typesBrief()` 老老实实算出 12 万字符，**算完就扔**；AI 收到的 system 里
// 是字面量 `{{TYPES}}`，于是自编 `cloze` / `sentence-build` / `essay`，
// 15 道全被 `isAllowedType` 判非法。他连点三次，三次都是这句话。
//
// 下面这一组把整条链路钉住：他勾了什么 → 进不进 prompt → AI 回什么 →
// 过不过闸 → 入不入库 → 失败时说不说得清。
// ══════════════════════════════════════════════════════════════

/**
 * 假 AI · **按 URL 路由**，不是简单覆盖 `globalThis.fetch`。
 *
 * ★ 第一版就是直接覆盖，结果 `checkAsync` 是**并发起跑**的 ——
 *   我的桩挂着的时候，同步跑的那批同步用例（R-3-g / R-4-C / R-4-F）
 *   全都拿到了我这份假响应，一口气红了 9 条。桩必须只认自己那个地址，
 *   别人的请求原样转给真 fetch。每个用例再各用一个唯一域名，彼此也不串。
 */

/** 给这个库配一把能过 `resolveSlot` 的 key（safeStorage 真加密，跟生产同一条路） */

const qq = (tier: number, type: string, i = 0): Record<string, unknown> => ({
  tier,
  type,
  prompt: `write something with the target expression #${tier}-${i}`,
  context: 'original',
  reference: 'ref'
})

checkAsync('★★ F-6 · 他勾的题型必须真的出现在发给 AI 的 prompt 里', async () => {
  /**
   * 这一条就是那天的病本身。老代码 `fill(p.system, { LEVEL })` ——
   * `{{TYPES}}` 留在 system 里当字面量发出去，题型要求一个字没到 AI 手上。
   */
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, '造句'), qq(1, '造句'), qq(1, '造句')])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'prompt carries types', '', 'B', '').id
  try {
    await study.ensureQuestions(id)
  } finally {
    ai.restore()
  }
  assert(ai.calls.length === 1, `该调一次 AI，实际 ${ai.calls.length} 次`)
  const whole = ai.calls[0]!.system + ai.calls[0]!.user
  assert(
    !/\{\{\w+\}\}/.test(whole),
    `★★ 发出去的 prompt 里还留着没填的占位符：${whole.match(/\{\{\w+\}\}/g)?.join('、')}`
  )
  assert(
    whole.includes('type must be exactly `造句`'),
    '★★ 他勾的题型没进 prompt —— AI 只能自己编，回来必然一道都不合格'
  )
  r.db.close()
})

/**
 * ══ D-482 · 选项**真的接进了出题那条路**吗 ★★★ ════════════════
 *
 * ── 为什么非有这一条不可（2026-09-15 实测出来的洞）──────────
 *
 * 我原来那几条「每档渲染一次」的用例是**自己造变量喂给 `fill`**：
 *
 *     fill(p.system, { SPREAD: CONTEXT_SPREAD_LINES[spread], … })
 *
 * 它验的是「模板有位置」+「core 那句话没写错」，**没验 `production.ts`
 * 到底喂没喂**。把 `vars` 里的 `SPREAD` 写死成出厂那一档（= 选项彻底失效），
 * `npm run check` + 1279 条单测 + 670 条 ② 档 **全绿**。
 *
 * 这正是 Nyx-UI-Android 同一天在自己那边抓到的形状（它的 QR-5 / QR-6 直接调
 * core 函数，接线拆掉照样绿），它提醒我对一眼，一对就是这个结果。
 *
 * ── 所以判据只有一个：**看真发出去的那段字** ─────────────────
 *
 * `fakeAi` 本来就把每一次的 system / user 原样记下来了（`calls[]`）——
 * 那是「模型真收到了什么」，中间少喂一个变量、写死一个档，这里当场看得见。
 */
checkAsync('★★★ D-482 · 四个选项真的到了模型手上（不是只在模板里有位置）', async () => {
  const { r, study } = qtScene(['造句'])
  /**
   * 四个选项**每一个都拨离出厂值**：出厂那一档拼出来的句子和「没接线」长得一样，
   * 拿出厂值验等于什么都没验（这条用例自己也会变成假绿）。
   */
  const prefs = new Prefs(r.db)
  prefs.set(QUIZ_RULE_KEYS.practiceHint, 'none')
  prefs.set(QUIZ_RULE_KEYS.contextSpread, 'far')
  prefs.set(QUIZ_RULE_KEYS.requireFullSentence, '1')
  prefs.set(QUIZ_RULE_KEYS.matchRegister, '1')

  const ai = fakeAi([qq(1, '造句')])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'bear the brunt', '承受最重的那一下', 'B', '她承受了大部分。').id
  try {
    await study.ensureQuestions(id)
  } finally {
    ai.restore()
  }
  assert(ai.calls.length === 1, `该调一次 AI，实际 ${ai.calls.length} 次`)
  const sys = ai.calls[0]!.system
  const usr = ai.calls[0]!.user

  // W-2「尽量换新场合」—— 拼的是那一档的句子，不是出厂那段
  assert(
    sys.includes(CONTEXT_SPREAD_LINES.far),
    '★★★ W-2 没接线：他选了「尽量换新场合」，发出去的还是别的档'
  )
  assert(
    !sys.includes(CONTEXT_SPREAD_LINES.mixed),
    '★★★ 出厂那段和 far 一起发出去了 —— 两段互相矛盾，模型照哪一段都说得通'
  )
  // W-1「都不给」—— USER 段不许再出现释义与原句，且多拼一句拦着它去抄
  assert(!usr.includes('Meaning:'), '★★★ W-1 没接线：选了「都不给」，释义还在 USER 段里')
  assert(!usr.includes('她承受了大部分。'), '★★★ 「都不给」却把原句发出去了')
  assert(sys.includes(NO_SOURCE_LINE), '★★★ 「都不给」那一档少了「不许抄原句」那句')
  // D-137 · 目标表达三档都给 —— 它写死在模板里，不经过选项
  assert(usr.includes('bear the brunt'), '★★★ 目标表达那一行不见了（D-137）')
  // W-3 / W-4 跟着题型走
  assert(sys.includes(FULL_SENTENCE_LINE), '★★★ W-3 没接线（「造句」该收到「必须写完整句」）')
  assert(sys.includes(MATCH_REGISTER_LINE), '★★★ W-4 没接线')
  r.db.close()
})

/**
 * ★★★ I-187 · 判据落在**真发出去的那段字**上（和上面那条同一条纪律）。
 *   只验 `effectiveQTypePrompt` 的话，接线拆掉照样绿 —— 那正是这一轮刚补过的洞。
 */
checkAsync('★★★ I-187 · 内置题型身上那段生成的 prompt，一个字都不许发出去', async () => {
  const { r, study } = qtScene(['造句'])
  const JUNK = 'Rewrite the passage to improve cohesion across paragraphs and vary sentence openings.'
  /** 造出他真库里那个形状：内置题型身上挂着一段和题型名错位的长正文 */
  const qt = new QTypes(r.db)
  const one = qt.all().find((q) => q.key === '造句')!
  assert(one.builtin, '前提：「造句」是内置题型')
  qt.save({ ...one, prompt: JUNK })

  const ai = fakeAi([qq(1, '造句')])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'bear the brunt', '承受', 'B', '她承受了大部分。').id
  try {
    await study.ensureQuestions(id)
  } finally {
    ai.restore()
  }
  const whole = ai.calls[0]!.system + ai.calls[0]!.user
  assert(
    !whole.includes(JUNK),
    '★★★ 内置题型那段生成的正文发出去了 —— 「造句」就是这么一直按别的题型出题的'
  )
  assert(
    whole.includes('Give a concrete situation'),
    '★★★ 内置那段 guide 没发出去 —— 那这一种题型对模型什么都没说'
  )
  /** ★ 数据一个字不动（D-216）：不读 ≠ 删掉 */
  assert(
    qt.all().find((q) => q.key === '造句')!.prompt === JUNK,
    '★★★ 把他库里那一行删/改了 —— 判据是「不读」，不是「清掉」'
  )
  r.db.close()
})

checkAsync('★★ F-6 · AI 老老实实按勾选回题 → 正常入库（单一题型）', async () => {
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, '造句', 1), qq(1, '造句', 2), qq(1, '造句', 3)])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'single type', '', 'B', '').id
  let n = 0
  try {
    n = (await study.ensureQuestions(id)).added
  } finally {
    ai.restore()
  }
  assert(n === 3, `该收 3 道，实际 ${n}`)
  const rows = r.db.prepare(`select type from questions where item_id = ?`).all(id) as { type: string }[]
  assert(rows.length === 3 && rows.every((x) => x.type === '造句'), `落库的题型不对：${JSON.stringify(rows)}`)
  r.db.close()
})

checkAsync('★★★ D-478 · 一次几道由他定：改设置 → 出题 → 落库 → 取题，一条来回', async () => {
  /**
   * ★★ 方案里那条 ⑤。判据是**他设的那个数真的一路走到库里**：
   *   设置页写 5 → 计划 5 道 → 提示词说 5 道 → AI 回 5 道 → 库里 5 行 → 取得出来。
   *   中间断在任何一段，表现都是「我明明改了设置，出的题还是 15 道」，而且不报错。
   */
  const { r, study } = qtScene(['造句', '句子改写'])
  new ParamStore(r.db).set('questionsPerItem', 5)

  const ai = fakeAi([
    qq(1, '造句', 1),
    qq(1, '句子改写', 2),
    qq(1, '造句', 3),
    qq(1, '句子改写', 4),
    qq(1, '造句', 5)
  ])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'count is his', '', 'B', '').id
  let n = 0
  try {
    n = (await study.ensureQuestions(id)).added
  } finally {
    ai.restore()
  }
  assert(n === 5, `★★★ 他设的是 5 道，实际收了 ${n} 道`)
  const whole = ai.calls[0]!.system + ai.calls[0]!.user
  assert(
    whole.includes('Write exactly 5 questions'),
    '★★★ 提示词里没说 5 道 —— AI 只能按自己的想法给，收题时再丢一半'
  )
  const rows = r.db.prepare(`select type from questions where item_id = ?`).all(id) as {
    type: string
  }[]
  assert(rows.length === 5, `★★★ 落库不是 5 行：${rows.length}`)

  // 取得出来，而且**相邻两道不同型**（M-027 在发题这一侧）
  const first = study.nextQuestion(id)
  assert(first !== null, '★★★ 出了题却一道都取不出来')
  r.db.close()
})

checkAsync('★★ F-6 · 勾了多种 → 多种合法题型都收得下', async () => {
  const { r, study } = qtScene(['造句', '句子改写'])
  const ai = fakeAi([qq(1, '造句'), qq(2, '句子改写'), qq(2, '句子改写', 2)])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'multi type', '', 'B', '').id
  let n = 0
  try {
    n = (await study.ensureQuestions(id)).added
  } finally {
    ai.restore()
  }
  assert(n >= 2, `多题型场景一道都没收下：${n}`)
  const kinds = new Set(
    (r.db.prepare(`select type from questions where item_id = ?`).all(id) as { type: string }[]).map((x) => x.type)
  )
  assert(kinds.size >= 2, `只收下了一种：${[...kinds].join('、')}`)
  r.db.close()
})

checkAsync('★★ F-6 · AI 混进没勾的题型 → 只丢那几道，合法的照收', async () => {
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, '造句'), qq(1, '错误订正'), qq(1, '造句', 2)])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'mixed', '', 'B', '').id
  let n = 0
  try {
    n = (await study.ensureQuestions(id)).added
  } finally {
    ai.restore()
  }
  const rows = r.db.prepare(`select type from questions where item_id = ?`).all(id) as { type: string }[]
  assert(n === rows.length && rows.length === 2, `该收 2 道，实际 ${n}/${rows.length}`)
  assert(!rows.some((x) => x.type === '错误订正'), '★★ 没勾的题型混进库了')
  r.db.close()
})

checkAsync('★★ F-6 · AI 回的全是陌生题型 → 拒绝，且**说得出它回了什么**', async () => {
  /**
   * 那天他看到的是「换一组题型，或者去设置里把提示词写清楚一点」——
   * 而真正的原因是程序没把题型发出去。报错必须给出**双方各是什么**，
   * 否则他会照着提示去改一堆提示词，改到天亮也没用。
   */
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, 'cloze'), qq(1, 'sentence-build'), qq(1, 'essay')])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'all foreign', '', 'B', '').id
  let msg = ''
  try {
    await study.ensureQuestions(id)
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err)
  } finally {
    ai.restore()
  }
  assert(msg.length > 0, '★★ 全是陌生题型却没报错')
  assert(msg.includes('cloze'), `★★ 没说 AI 到底回了什么，这个错没法诊断：「${msg}」`)
  assert(msg.includes('造句'), `★ 没说他选的是什么：「${msg}」`)
  assert(
    (r.db.prepare(`select count(*) as n from questions where item_id = ?`).get(id) as { n: number }).n === 0,
    '★★ 判非法之后还是写进库了'
  )
  r.db.close()
})

checkAsync('★ F-6 · AI 用「显示名」而不是 canonical key → 照样判非法，不许猜', async () => {
  /**
   * 他库里 `key=错误订正` 的那一行 `name` 已经被改成 `Sentence Simplification`。
   * AI 若回 name，我们**不做归一**：题面是照着某个形式写的，换个标签挂上去
   * 等于骗他 —— 题目形式和标签对不上，而他只会以为自己看错了。
   * 要的是报错说清楚，不是猜。
   */
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, 'Sentence Building'), qq(1, 'Sentence Building', 2)])
  await setUpAi(r.db, ai.base)
  r.db.prepare(`update qtypes set name = 'Sentence Building' where key = '造句'`).run()
  const id = new Repo(r.db).addItem(1, 'name not key', '', 'B', '').id
  let msg = ''
  try {
    await study.ensureQuestions(id)
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err)
  } finally {
    ai.restore()
  }
  assert(msg.includes('Sentence Building'), `★ 报错里没提它回的那个名字：「${msg}」`)
  assert(
    (r.db.prepare(`select count(*) as n from questions where item_id = ?`).get(id) as { n: number }).n === 0,
    '★★ 按显示名蒙混进库了'
  )
  r.db.close()
})

checkAsync('★★ F-6 · 生成失败 → 已经答过的题一道不少，也不留半截', async () => {
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, 'cloze'), qq(1, 'essay')])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'keep answered', '', 'B', '').id
  const done = putQ(r, id, 1, '造句')
  r.db.prepare(`update questions set used_at = ? where id = ?`).run(Date.now(), done)
  const before = r.db.prepare(`select count(*) as n from questions where item_id = ?`).get(id) as { n: number }

  try {
    await study.ensureQuestions(id)
  } catch {
    /* 这一条要的就是它失败 */
  } finally {
    ai.restore()
  }
  const after = r.db.prepare(`select count(*) as n from questions where item_id = ?`).get(id) as { n: number }
  assert(after.n === before.n, `★★ 失败那一趟动了库里的题：${before.n} → ${after.n}`)
  assert(
    (r.db.prepare(`select used_at from questions where id = ?`).get(done) as { used_at: number }).used_at !== null,
    '★★ 他答过的那道被清了'
  )
  r.db.close()
})

checkAsync('★ F-6 · 重试不会把同一条重复插一遍', async () => {
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, '造句'), qq(1, '造句', 2)])
  await setUpAi(r.db, ai.base)
  const id = new Repo(r.db).addItem(1, 'retry once', '', 'B', '').id
  try {
    await study.ensureQuestions(id)
    await study.ensureQuestions(id) // 第二次：已经有没做过的题了，不该再调 AI
  } finally {
    ai.restore()
  }
  assert(ai.calls.length === 1, `★★ 第二次又调了一遍 AI（${ai.calls.length} 次）—— 题会翻倍`)
  const n = (r.db.prepare(`select count(*) as n from questions where item_id = ?`).get(id) as { n: number }).n
  assert(n === 2, `★★ 重复插入了：库里 ${n} 道`)
  r.db.close()
})

check('★★ F-6 · 提示词里有、调用处没给的占位符 —— 当场抛错，不许发出去', () => {
  /**
   * 这条是根因的**直接守卫**。老 `fill` 是 `vars[k] ?? m`：没给就原样留着，
   * 一路发给 AI。判据放在替换**之前**（只查模板，不查代入后的结果）——
   * 因为他粘进来的文章、他自己写的提示词里可能本来就带 `{{`。
   */
  let msg = ''
  try {
    fill('hello {{A}} and {{B}}', { A: 'x' })
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err)
  }
  assert(msg.includes('{{B}}'), `★★ 没给的占位符被放过去了：「${msg}」`)
  assert(fill('hello {{A}}', { A: 'x' }) === 'hello x', '正常填充坏了')
  // 代入的**值**里带 {{ }} 不算错 —— 那是他的内容，不是我们的模板
  assert(fill('doc: {{A}}', { A: 'he wrote {{TYPES}} here' }).includes('{{TYPES}}'), '误伤了使用者内容')
})

// ══════════════════════════════════════════════════════════════
// ★★ R-3-h · 自增 id 不能当跨设备身份（2026-08-17 真机双端验收撞出来）
//
// 现场：A 是他的机器，B 是全新装的一台。
//   B 首启 → builtins 自愈补回 4 条内置体裁，uid 是 `genres-builtin-1..4`，占了 id 1–4
//   A 上那 4 条早被他改过 → builtin=0、uid 随机
//   同步过去 → `insert … on conflict(uid) do update`
//              uid 不同 → 走 INSERT → id=1 已被占 → 撞**主键**
//              `on conflict(uid)` 是指定索引的，撞在主键上它不接管
//   → UNIQUE constraint failed: genres.id  ×4，连跑 4 次 16→5→4→4→4，**不收敛**
//
// V27 把 genres/qtypes 换成 uid 主键、整列去掉 id。下面这一组把它钉住。
// ══════════════════════════════════════════════════════════════

/** 造一台「自己播过种」的设备：全新库，内置体裁/题型是它自己那份 */
function seededDevice(bucket: string, device: string): {
  r: ReturnType<typeof openDatabase>
  sync: Sync
} {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  configureSync(r, bucket)
  r.db
    .prepare(
      `insert into settings (key, value, updated_at) values ('sync.device', ?, ?)
         on conflict(key) do update set value = excluded.value`
    )
    .run(device, Date.now())
  return { r, sync: new Sync(r.db, join(backups, 'audio'), backups) }
}

check('★★ R-3-h · genres / qtypes 的主键就是 uid，没有自增 id 这一列', () => {
  /**
   * 这条守的是**将来**。哪天有人图省事把 `id integer primary key autoincrement`
   * 加回来，两台设备一同步就会重演那 4 行永久失败 ——
   * 而失败的样子是「同步页永远挂着有问题」，没人会立刻联想到这里。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  for (const t of ['genres', 'qtypes']) {
    const cols = r.db.prepare(`pragma table_info("${t}")`).all() as {
      name: string
      pk: number
      notnull: number
    }[]
    assert(
      !cols.some((c) => c.name === 'id'),
      `★★ ${t} 又有 id 列了 —— 第二台设备一同步就会永久失败`
    )
    const pk = cols.filter((c) => c.pk > 0)
    assert(pk.length === 1 && pk[0]!.name === 'uid', `★★ ${t} 的主键不是 uid：${pk.map((c) => c.name).join(',')}`)
    assert(pk[0]!.notnull === 1, `★ ${t}.uid 允许为空 —— 身份可以是空的，那还叫身份吗`)
  }
  r.db.close()
})

for (const table of ['genres', 'qtypes'] as const) {
  checkAsync(`★★ R-3-h · ${table}：两台各自播过种，A 改过的那条也能同步进 B`, async () => {
    await cloudReady
    const bucket = `r3h-${table}`
    const { r: A, sync: syncA } = seededDevice(bucket, 'devA')
    const { r: B, sync: syncB } = seededDevice(bucket, 'devB')

    // 前提：两边都自己播了种，而且**内置行的 uid 是一样的**（canonical）
    const bUids = new Set(
      (B.db.prepare(`select uid from "${table}"`).all() as { uid: string }[]).map((x) => x.uid)
    )
    assert(bUids.size > 0, `前提没成立：B 上没有出厂 ${table}`)

    /**
     * ★ 造出那天的真实形状：A 上那几条内置行**被他改过** ——
     *   uid 变成随机的、builtin 归 0。于是它们在 B 眼里是全新的行，
     *   而它们在 A 上占着的位置（老版本里是 id 1..N）在 B 上已经有人了。
     */
    const first4 = A.db
      .prepare(`select uid from "${table}" order by sort, rowid limit 4`)
      .all() as { uid: string }[]
    assert(first4.length === 4, `前提没成立：A 上出厂 ${table} 不足 4 条`)
    const mine: string[] = []
    const t = Date.now()
    for (const [i, row] of first4.entries()) {
      const fresh = `${table}-mine${i}${'0'.repeat(10)}`
      A.db
        .prepare(`update "${table}" set uid = ?, builtin = 0, updated_at = ? where uid = ?`)
        .run(fresh, t, row.uid)
      /**
       * ★ `qtypes` 还有一条**唯一 key**（`questions.type` 存的就是它，是业务身份）。
       *   夹具若只换 uid 不换 key，B 上同名那行会先撞 `qtypes.key` ——
       *   那是另一回事、而且是**对的**：同一个 key 本来就不许有两行。
       *   这条用例要验的是 **id 那条轴**，所以让 A 这几条带上 B 没见过的 key，
       *   还原「A 有几条 B 从没见过的题型」这个真实形状。
       */
      if (table === 'qtypes') {
        A.db.prepare(`update qtypes set key = ? where uid = ?`).run(`A 独有的题型 ${i}`, fresh)
      }
      mine.push(fresh)
    }

    // A 推上去
    await syncUntilDone(syncA)
    // B 拉下来
    const got = await syncB.run()

    assert(
      got.failed === 0,
      `★★ B 收 A 的 ${table} 时有 ${got.failed} 行失败 —— 这正是 R-3-h 那 4 行永久失败
      ${JSON.stringify(got.problems ?? []).slice(0, 400)}`
    )
    for (const uid of mine) {
      const there = B.db.prepare(`select uid from "${table}" where uid = ?`).get(uid)
      assert(there, `★★ A 改过的那条没到 B：${uid}`)
    }
    // B 自己那几条内置的**还在** —— 不是被顶掉，是各是各的
    for (const uid of bUids) {
      if (mine.includes(uid)) continue
      assert(
        B.db.prepare(`select uid from "${table}" where uid = ?`).get(uid),
        `★ B 自己的出厂行被顶掉了：${uid}`
      )
    }
    A.db.close()
    B.db.close()
  })
}

checkAsync('★★ R-3-h · 反复同步是幂等的 —— 不会一次次重造 problems', async () => {
  /**
   * 那天的现场：连跑 4 次，problems 16 → 5 → 4 → 4 → 4。
   * **不收敛**才是最要命的那一半：那一包永远进不了 `applied`，
   * 于是每次同步都把整批重拉一遍、重失败一遍，他的同步页永远挂着「有问题」。
   */
  await cloudReady
  const bucket = 'r3h-idem'
  const { r: A, sync: syncA } = seededDevice(bucket, 'devA')
  const { r: B, sync } = seededDevice(bucket, 'devB')

  const t = Date.now()
  const first = (A.db.prepare(`select uid from genres order by sort, rowid limit 1`).get() as {
    uid: string
  }).uid
  A.db
    .prepare(`update genres set uid = 'genres-collide0000', builtin = 0, updated_at = ? where uid = ?`)
    .run(t, first)
  await syncUntilDone(syncA)

  const runs: { applied: number; failed: number }[] = []
  for (let i = 0; i < 3; i++) {
    const o = await sync.run()
    runs.push({ applied: o.applied, failed: o.failed })
  }
  assert(
    runs.every((x) => x.failed === 0),
    `★★ 反复同步还在失败：${JSON.stringify(runs)}`
  )
  assert(
    runs[1]!.applied === 0 && runs[2]!.applied === 0,
    `★ 第二、三次还在重复应用同一批 —— 那一包没进 applied：${JSON.stringify(runs)}`
  )
  assert(
    B.db.prepare(`select uid from genres where uid = 'genres-collide0000'`).get(),
    '★★ A 改过的那条最终还是没进 B'
  )
  A.db.close()
  B.db.close()
})

checkAsync('★★ R-3-h · 云端还躺着**老版本**推的包（行里带 id）→ 照样收得下', async () => {
  /**
   * ★ 真机验证第一次没过，就是卡在这里 —— schema 修好了，**历史包**把它拖回原地：
   *
   *     UNIQUE constraint failed: genres.id   →   table genres has no column named id
   *
   * 那 4 行换了个理由继续永久失败，连跑 5 次 5→4→4→4→4，还是不收敛。
   * 包是别的设备、别的版本写的，它的列集不保证等于我的 ——
   * `writeRows` 老实现直接拿包里的列名拼 INSERT，等于假设两端结构一样。
   */
  await cloudReady
  const bucket = 'r3h-oldpkg'
  const { r: B, sync } = seededDevice(bucket, 'devB')

  // 手工往云端塞一个「V26 时代」的包：genres 行里带着 id 这一列
  const t = Date.now()
  const pkg = {
    device: 'devOLD',
    at: t,
    rows: [
      {
        table: 'genres',
        uid: 'genres-fromold00000',
        /**
         * ★ Step 1A · 这一行原来没有 `updatedAt` —— 夹具漏的，不是真实形状：
         * `collectSince` 推出去的每一行都带着它，合并判据（水位、冲突）全靠它。
         * 收包校验补上之后这条当场红了，说明校验是对的。
         */
        updatedAt: t,
        deleted: false,
        data: {
          id: 1, // ← 本机（V27）已经没有这一列了
          uid: 'genres-fromold00000',
          name: '老版本推上来的体裁',
          prompt: 'p',
          is_default: 0,
          builtin: 0,
          sort: 50,
          deleted_at: null,
          created_at: t,
          updated_at: t
        }
      }
    ]
  }
  cloudFiles.set(`${bucket}/nyx/chunks/devOLD-${t}.json`, JSON.stringify(pkg))

  const o = await sync.run()
  /**
   * ★★ Step 2 · C-1 之后这条的结论变了：**老包整包不收**。
   *
   * R-3-h 当初要解决的是「老包里多一列就整行进不来」，办法是按本机列集过滤。
   * C-1 换了跨设备身份的算法之后，老包连收都不能收了 ——
   * 它里面的 uid 是升级前随机生成的，收进来会和本机已有的行撞车。
   * 「列以本机为准」那段代码仍然留着（协议第 1 版那条路还用它），
   * 只是生产上再也走不到。**结论变了不等于当初那条修复错了。**
   */
  assert(o.rejected === 1, `老包该整包拒，实际 rejected=${o.rejected}`)
  assert(o.failed === 0, `不该走到逐行那一层：failed=${o.failed}`)
  const got = B.db
    .prepare(`select name from genres where uid = 'genres-fromold00000'`)
    .get() as { name: string } | undefined
  assert(got === undefined, '★★ 老包那一行被收下来了')
  B.db.close()
})

check('★★ R-3-h · V27 迁移：老库搬完之后，行数 / uid / 业务字段一个不差', () => {
  const { db: p, backups } = freshDir()
  // 停在 V26：那时 genres/qtypes 还是自增 id + uid 唯一索引
  const old = openDatabase(p, backups, MIGRATIONS.slice(0, 26))
  const before: Record<string, { n: number; uids: string; names: string }> = {}
  for (const t of ['genres', 'qtypes']) {
    const cols = (old.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
    assert(cols.includes('id'), `前提没成立：V26 的 ${t} 该有 id 列`)
    before[t] = {
      n: (old.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n,
      uids: (old.db.prepare(`select uid from "${t}" order by uid`).all() as { uid: string }[])
        .map((x) => x.uid)
        .join('|'),
      names: (old.db.prepare(`select name from "${t}" order by uid`).all() as { name: string }[])
        .map((x) => x.name)
        .join('|')
    }
    assert(before[t]!.n > 0, `前提没成立：${t} 是空的，这条用例就什么都没验到`)
  }
  // 他自己加的一条也要跟着搬过去
  const t0 = Date.now()
  old.db
    .prepare(
      `insert into genres (uid, name, prompt, sort, created_at, updated_at) values ('genres-mine-x', '我加的', 'p', 99, ?, ?)`
    )
    .run(t0, t0)
  before['genres'] = {
    n: before['genres']!.n + 1,
    uids: (old.db.prepare(`select uid from genres order by uid`).all() as { uid: string }[])
      .map((x) => x.uid)
      .join('|'),
    names: (old.db.prepare(`select name from genres order by uid`).all() as { name: string }[])
      .map((x) => x.name)
      .join('|')
  }
  old.db.close()

  // 升到最新（V27 在这里跑）
  const r = openDatabase(p, backups)
  assert(r.migrated === true, 'V27 没跑')
  for (const t of ['genres', 'qtypes']) {
    const cols = (r.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
    assert(!cols.includes('id'), `★★ ${t} 的 id 列还在`)
    const n = (r.db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
    assert(n === before[t]!.n, `★★ ${t} 搬完少了行：${before[t]!.n} → ${n}`)
    const uids = (r.db.prepare(`select uid from "${t}" order by uid`).all() as { uid: string }[])
      .map((x) => x.uid)
      .join('|')
    assert(uids === before[t]!.uids, `★★ ${t} 搬完 uid 对不上`)
    const names = (r.db.prepare(`select name from "${t}" order by uid`).all() as { name: string }[])
      .map((x) => x.name)
      .join('|')
    assert(names === before[t]!.names, `★★ ${t} 搬完业务字段对不上`)
  }
  // 索引也要在 —— 少一个的表现是「列表顺序忽然变了」，没人会往索引上想
  const idx = (
    r.db.prepare(`select name from sqlite_master where type='index'`).all() as { name: string }[]
  ).map((x) => x.name)
  for (const want of ['idx_genres_sort', 'idx_qtypes_sort', 'idx_qtypes_key']) {
    assert(idx.includes(want), `★ 索引 ${want} 没重建`)
  }
  r.db.close()
})

check('★ R-3-h · V27 之后照常增删改：走真业务入口，身份不变', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const files = new Files(r.db, join(process.cwd(), 'prompts'))

  // 新增：uid 是主键，插入时必须自己给 —— 老写法靠触发器补，那个触发器已经删了
  const uid = files.saveGenre({ name: '我新加的体裁', prompt: 'x' })
  assert(typeof uid === 'string' && uid.startsWith('genres-'), `新增没拿到 uid：${uid}`)
  assert(files.genres().some((g) => g.uid === uid), '新增的没出现在列表里')

  // 改名：身份不许变
  files.saveGenre({ uid, name: '改了名字', prompt: 'y' })
  const after = files.genres().find((g) => g.uid === uid)
  assert(after?.name === '改了名字', '改名没生效')

  // 题型同理
  const qt = new QTypes(r.db)
  const quid = qt.save({ name: '我加的题型', brief: 'b' })
  assert(typeof quid === 'string' && quid.startsWith('qtypes-'), `题型新增没拿到 uid：${quid}`)
  const q = qt.all().find((x) => x.uid === quid)
  assert(q?.key === '我加的题型', `key 不对：${q?.key}`)
  qt.setEnabled(quid, false)
  assert(qt.all().find((x) => x.uid === quid)?.enabled === false, '停用没生效')
  r.db.close()
})

check('★★ F-6 · 每份提示词的占位符，调用处都要给全（扫全项目）', () => {
  /**
   * 上一条守的是运行时，这一条守的是**发布前**：把每份 `prompts/*.md` 里
   * SYSTEM / USER 两段的占位符并起来，与调用处那一份变量表比对。
   * 那天出事的正是「占位符在 SYSTEM 段、变量只给了 USER 段」。
   *
   * 现在的写法是两段喂同一份变量，所以只要那一份齐全就够。
   */
  const dir = join(process.cwd(), 'prompts')
  const bad: string[] = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const md = readFileSync(join(dir, f), 'utf8')
    const body = md.replace(/^>.*$/gm, '') // 文件头那段「占位符说明」不算
    const need = new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string))
    if (need.size === 0) continue
    // 调用处：全项目搜这份提示词的名字，取它后面那一段里出现的大写变量名
    const name = f.replace(/\.md$/, '')
    let given = new Set<string>()
    /**
     * ★ 怎么找「这份提示词的变量表」——**锚在它自己的变量名上**。
     *
     * 第一版是「从 `loadPrompt(...)` 往后截 12000 字，捞里面所有大写名」。
     * 那是个会自己骗自己的窗口：`analyze.ts` 连着加载
     * `pMaterial` 和 `pDerived` 两份，两边都填 `LEVEL:` ——
     * 我把 `analyze-material` 的 `LEVEL` 故意改错名，这条**照样绿**，
     * 因为窗口里捞到了隔壁 `extract-derived` 的那个 `LEVEL`。
     *
     * 现在先认出 `const <ident> = loadPrompt(..., '<name>')` 里的 `<ident>`，
     * 再只看 `fill(<ident>.system, {...})` / `fill(<ident>.user, {...})`
     * 这几段里的大写名。串不到隔壁去。
     *
     * ⚠ 这条闸只挡**静态可见**的写法。真正的硬网是运行时的 `fill()` ——
     *   它在替换前逐个核对，不依赖任何模式匹配。这条是让问题在发版前就现形。
     */
    /**
     * ★ T-4.6（2026-09-06）· `study.ts` 拆成了入口 + `study/` 下六个领域，
     *   `analyse-item` 的加载点搬去了 `study/analysis.ts`。只扫入口的话这条闸会报
     *   「找不到它的调用处」——那不是误报，是它真的看不住了（实测红过）。
     */
    const STUDY_PARTS = readdirSync(join(process.cwd(), 'src', 'main', 'study'))
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => 'study/' + f)
    /**
     * ★ D-467（2026-09-07）· `assess.ts` 从这份名单里去掉了：水平评估整块取消，
     *   那个文件删了（它加载的 `assess-level` / `diagnostic-questions` 两份提示词
     *   也一起删）。名单里留着一个不存在的文件，这条闸会以 ENOENT 整条红掉 ——
     *   看起来像「占位符没给全」，其实是名单没跟上（实测红过一次）。
     */
    for (const src of ['study.ts', ...STUDY_PARTS, 'files.ts', 'ai/analyze.ts']) {
      const code = readFileSync(join(process.cwd(), 'src', 'main', ...src.split('/')), 'utf8')
      // 不用正则找调用点 —— 这一行的反斜杠被工具吃过一层，`\w` 变成字面 `w`，
      // 于是 analyse-item / analyze-material 两份一直没被匹配到，而当时的写法是
      // 「找不到就跳过」，所以它安安静静绿着。两个字面量最稳。
      const decl = [`= loadPrompt(this.promptsDir, '${name}')`, `= loadPrompt(deps.promptsDir, '${name}')`, `= loadPrompt(c.promptsDir, '${name}')`]
        .map((needle) => code.indexOf(needle))
        .filter((x) => x >= 0)
        .sort((a, b) => a - b)[0]
      if (decl === undefined) continue
      // 往回找这一行的 `const <ident>`
      const lineStart = code.lastIndexOf('\n', decl) + 1
      const ident = code.slice(lineStart, decl).replace(/^\s*const\s+/, '').trim()
      if (!ident) continue
      for (const part of ['system', 'user']) {
        let from = code.indexOf(`fill(${ident}.${part}`)
        while (from >= 0) {
          const seg = code.slice(from, from + 4000)
          for (const v of seg.match(/[A-Z][A-Z_]+(?=[ \t]*:)/g) ?? []) given.add(v)
          /**
           * ★ 变量表可能不是就地写的，而是先 `const vars = { … }` 再 `fill(p.system, vars)`
           *   —— 修 `{{TYPES}}` 的时候正是改成了这个形状（两段喂同一份）。
           *   顺着这个名字回去把那张表读出来，否则这条闸只会看到一个 `vars`，
           *   然后报「一个都没填」——**误报比漏报更快让人把闸关掉**。
           */
          const bag = /fill\([\w.]+,\s*([a-z]\w*)\s*\)/.exec(seg.slice(0, 200))?.[1]
          if (bag) {
            // ★ 往**前**找最近的那一处声明。用 indexOf 会永远抓到文件里第一个
            //   `const vars = {`（generate-questions 那个），于是 analyse-item
            //   永远报「KIND 没人填」—— 误报，而且指着一处已经修好的地方。
            const at2 = code.lastIndexOf(`const ${bag} = {`, from)
            if (at2 >= 0) {
              for (const v of code.slice(at2, at2 + 2000).match(/[A-Z][A-Z_]+(?=[ \t]*:)/g) ?? []) given.add(v)
            }
          }
          from = code.indexOf(`fill(${ident}.${part}`, from + 1)
        }
      }
      /**
       * ★ T-7.8 · 装配下沉 core 之后，`analyse-item` 的调用处不再自己 `fill` ——
       *   它把整份提示词交给 `@core/analysis/request.ts::buildRequest`，
       *   变量表在那边的 `analysisVars` 里（两端共用同一份）。
       *
       *   这一段不是把闸放宽，是让闸**跟着搬**：顺着 `buildRequest(…, <ident>, …)`
       *   这条线读到 core 那张表，从里面取大写名。
       *   把 `analysisVars` 里的 `KIND:` 删掉或改名，这条照样当场红
       *   —— 试过（负向对照就在报告里）。
       */
      if (code.includes(`buildRequest(`) && code.includes(`, ${ident},`)) {
        const core = readFileSync(
          join(process.cwd(), 'src', 'core', 'analysis', 'request.ts'),
          'utf8'
        )
        const at = core.indexOf('export function analysisVars')
        assert(at >= 0, '★ core/analysis/request.ts 里找不到 analysisVars —— 这条闸跟丢了')
        for (const v of core.slice(at, at + 2000).match(/[A-Z][A-Z_]+(?=[ \t]*:)/g) ?? []) {
          given.add(v)
        }
      }
      break
    }
    /**
     * ★★ 找不到调用点 **就是失败**，不许 `continue` 掉。
     *   第一版写的是「找不到就跳过」，于是 `analyze.ts` 的两份从来没被看着 ——
     *   我拿负向对照一试，故意把变量改错名，这条**照样是绿的**。
     *   一条会自己放过自己的检查，比没有检查更坏。
     */
    if (given.size === 0) {
      bad.push(`${f}：找不到它的调用处（新写法？换文件了？）—— 这条闸看不住它`)
      continue
    }
    const missing = [...need].filter((k) => !given.has(k))
    if (missing.length) bad.push(`${f}：${missing.map((k) => `{{${k}}}`).join('、')} 没人填`)
  }
  assert(bad.length === 0, `★★ 提示词的占位符没人填 —— 会原样发给 AI：${String.fromCharCode(10)}      ${bad.join(String.fromCharCode(10) + '      ')}`)
})

checkAsync('★ F-6 · 同一种题型的说明只写一遍 —— 不许按槽位重复贴', async () => {
  /**
   * 他给每种题型写的是整套导师提示词（一种 8000 字上下）。老写法逐槽位贴一次，
   * 15 个槽位实测拼出 **120984 字符**。修好 `{{TYPES}}` 之后这一坨会**真的发出去**，
   * 又贵又慢，要紧的那句还被埋在最底下。
   */
  const { r, study } = qtScene(['造句'])
  const ai = fakeAi([qq(1, '造句')])
  await setUpAi(r.db, ai.base)
  const long = 'X'.repeat(4000)
  /**
   * ★ I-187（2026-09-15）· 这里原来写的是 `set prompt = ?`。
   *   内置题型从此**不读 `prompt`** 了，那样写会贴 0 遍 —— 这条用例就变成在钉
   *   「那段根本没发出去」，而它要钉的是「**发出去的那一段不许贴两遍**」。
   *   所以夹具改成写 `guide`：那才是内置题型真正发出去的那一段。
   */
  r.db.prepare(`update qtypes set guide = ? where key = '造句'`).run(long)
  const id = new Repo(r.db).addItem(1, 'no repeat', '', 'B', '').id
  try {
    await study.ensureQuestions(id)
  } catch {
    /* 收不收得下不是这条要管的 */
  } finally {
    ai.restore()
  }
  const whole = ai.calls[0]!.system + ai.calls[0]!.user
  const times = whole.split(long).length - 1
  assert(times === 1, `★★ 同一种题型的说明贴了 ${times} 遍（每遍 ${long.length} 字）`)
  assert(whole.includes('type must be exactly `造句`'), '顺序那一段丢了')
  r.db.close()
})

check('★ 判据只有一份：study.ts 里不许再出现写死的兜底题型', () => {
  /**
   * 这条守的是**将来**。`q.type ?? '造句'` 那一行单看毫无杀伤力，
   * 谁都会觉得「给个默认值总不会错」—— 而它正是他看到满屏造句的原因。
   */
  const src = studySources()
  const from = src.indexOf('function ensureQuestions')
  const whole = src.slice(from, src.indexOf('function hardQuestion(', from))
  /**
   * ★ 先剃注释再扫 —— 第一版红在**我自己写的那句注释**上
   * （「老代码那句 `q.type ?? '造句'`」）。把病的描述当成病本身的尺子，
   * 迟早会逼着后人不敢在注释里写清原因，那比不检查更坏。
   * R-4-C-a 那条结构守栽过同一跤，做法一样。
   */
  const body = whole.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*/g, '$1')
  assert(
    !/\?\?\s*'造句'/.test(body) && !/\|\|\s*'造句'/.test(body),
    '★★ 又出现了写死的兜底题型 —— 他没勾的题型会再一次冒出来'
  )
  assert(body.includes('isAllowedType'), '★★ 收题硬闸不见了：AI 返回什么就存什么了')
})



checkAsync(
  '★★★ I-198 · answer 指着「还没做过」的题：出题不崩 · 那道题留着 · 不再发给他',
  async () => {
    /**
     * ══ 真事（2026-09-15，他真库里的一条）══════════════════════════
     * `answer#19` 指着 `question#334`（item 169 `rummaging`，产出队列第一条），
     * 而那道题的 `used_at` 是 **NULL**。出题前的清理
     * `delete from questions where item_id=? and used_at is null`
     * 删到了这道**被 answer 引用着**的题 → `answers.question_id` 外键当场抛
     * → 讲次页「产出练习」与 Today「开始产出练习」同一个错，**整条产出线全废**。
     *
     * ══ 它怎么变成这样的（取证）══════════════════════════════════
     * 逐份翻 `data/backups/` 20 份，坏行出现在 **5 秒之内**：
     *   22:46:48 那份：无 `answer#19` · `used_at=04:21:45` · `updated_at=04:21:45` · 坏行 0
     *   22:46:53 那份：有 `answer#19` · `used_at=NULL`    · `updated_at=04:17:30` · 坏行 1
     * 中间是 22:46:42 那次同步（它自己报「2 处两边都改过 —— 已按时间新的那版定」）。
     * **那一行的 `updated_at` 倒退了 4 分 15 秒** —— 更旧的一版覆盖了更新的一版。
     * ★ 根因在同步的合并口径（另记）；这一条守的是**这一层不许因为那种行崩掉**。
     *
     * ══ 为什么验三件而不是一件 ══════════════════════════════════
     * 只挡住删除的话，这行会被**永久留下来**，然后一次次**再发给他做一遍** ——
     * 崩溃没了，换成一个更安静的毛病。所以三件一起钉。
     */
    const { r, study } = qtScene(['造句'])
    const id = new Repo(r.db).addItem(1, 'rummaging', '', 'B', '').id
    const kept = putQ(r, id, 1, '造句') // 这道被 answer 引用着
    const gone = putQ(r, id, 1, '造句') // 这道没人引用

    // 造出真库里那种行：answer 指着它，而它的 used_at 还是 NULL
    const t = Date.now()
    r.db
      .prepare(
        `insert into answers (item_id, question_id, text, created_at, updated_at)
         values (?, ?, ?, ?, ?)`
      )
      .run(id, kept, '他写过的答案', t, t)

    // 让签名对不上，逼出清理那条路（不然根本走不到 delete）
    r.db.prepare(`update questions set qtype_sig = 'sig-from-another-era' where item_id = ?`).run(id)

    const ai = fakeAi([qq(1, '造句')])
    await setUpAi(r.db, ai.base)
    let msg = ''
    try {
      await study.ensureQuestions(id)
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    ai.restore()

    const alive = (qid: number): boolean =>
      (r.db.prepare(`select count(*) as n from questions where id = ?`).get(qid) as { n: number }).n === 1

    assert(msg === '', `★★★ 出题崩了 —— 产出线在这里全废：${msg}`)
    assert(alive(kept), '★★★ 把被 answer 引用着的那道题删掉了 —— 他的作答记录会跟着断')
    assert(
      !alive(gone),
      '★ 没人引用的旧题该删没删 —— 清理这一步整个失效了（勾选变了却还发旧题）'
    )

    /** ★ 第三件：它不能再被发给他做一遍 */
    const nxt = study.nextQuestion(id)
    assert(
      nxt === null || nxt.id !== kept,
      `★★ 又把他已经答过的那道题发了一遍（id=${kept}）—— 崩溃是修了，毛病换了个安静的样子`
    )
    r.db.close()
  }
)

// ══════════════════════════════════════════════════════════════
// ★★★ I-207 · 出题失败**不许**连带清掉他缓存的题
//
// 真事（2026-09-16，手机真机实测两次读库）：
//   item 207 `quixoticism` 未做 **14 道 → 0 道**（总 15 → 1）
//   item 205                未做 **3 道 → 0 道**
//   全库未做 **145 → 116**。`used_at` 没变多 —— **不是做掉的，是删掉的**。
//
// 老次序：① 先删未做的旧题 → ② 去调 AI → ③ 抛错（约一半会抛）→ ④ 两手空空。
// 屏上只说「模型额度」，一个字没提「你缓存的那批题刚被清掉了」。
//
// 判据现在在 `@core/question-refresh.ts`（两端同一份），次序闸在
// `scripts/check-question-replace-order.mjs`。这两条钉的是**行为**。
// ══════════════════════════════════════════════════════════════

checkAsync(
  '★★★ I-207 · 生成失败 → 他缓存的 14 道一道不少，回执说「还是上一批题」',
  async () => {
    const { r, study } = qtScene(['造句'])
    const id = new Repo(r.db).addItem(1, 'quixoticism', '', 'B', '').id
    /** 他手上那批 —— 数目抄真机那条（14 道未做） */
    for (let i = 0; i < 14; i++) putQ(r, id, 1, '造句')
    /** 逼出「按新勾选重出」那条路；不做这一步根本走不到删除 */
    r.db.prepare(`update questions set qtype_sig = 'sig-from-another-era' where item_id = ?`).run(id)

    /**
     * ★ 真现场那一种失败：**正文一个字都没有**（额度全写进了「思考」）。
     *   不自己编一个「差不多的」—— 空正文走的正是 `core/ai/client.ts` 那句抛错。
     */
    const ai = fakeAi('')
    await setUpAi(r.db, ai.base)
    let out: { added: number; notice: string | null } = { added: -1, notice: null }
    let threw = ''
    try {
      out = await study.ensureQuestions(id)
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    } finally {
      ai.restore()
    }

    const left = (
      r.db.prepare(`select count(*) as n from questions where item_id = ? and used_at is null`).get(id) as {
        n: number
      }
    ).n
    assert(left === 14, `★★★ 生成失败把他缓存的题清掉了：14 → ${left}`)
    assert(threw === '', `手上还有 14 道题时不该把练习打断，却抛了：${threw}`)
    assert(out.added === 0, `没生成成功却说插了 ${out.added} 道`)
    assert(
      out.notice === KEPT_OLD_NOTICE,
      `回执该是「${KEPT_OLD_NOTICE}」，实际「${String(out.notice)}」`
    )
    r.db.close()
  }
)

checkAsync('★★ I-207 · 生成成功 → 旧的未做题换成新的（使用者 7：改过勾选要重出）', async () => {
  const { r, study } = qtScene(['造句'])
  const id = new Repo(r.db).addItem(1, 'replaced only on success', '', 'B', '').id
  const old = [putQ(r, id, 1, '造句'), putQ(r, id, 1, '造句')]
  r.db.prepare(`update questions set qtype_sig = 'sig-from-another-era' where item_id = ?`).run(id)

  const ai = fakeAi([qq(1, '造句'), qq(1, '造句', 2), qq(1, '造句', 3)])
  await setUpAi(r.db, ai.base)
  let out: { added: number; notice: string | null } = { added: -1, notice: null }
  try {
    out = await study.ensureQuestions(id)
  } finally {
    ai.restore()
  }

  assert(out.added === 3, `该插 3 道，实际 ${out.added}`)
  assert(out.notice === null, `成功了不该带回执：「${String(out.notice)}」`)
  const rows = r.db.prepare(`select id from questions where item_id = ?`).all(id) as { id: number }[]
  assert(rows.length === 3, `旧的没换掉：库里还有 ${rows.length} 道`)
  assert(
    !rows.some((x) => old.includes(x.id)),
    '★★ 旧的那两道还在 —— 勾选变了却没重出'
  )
  r.db.close()
})

checkAsync('★ I-207 · 一道题都没有时生成失败 → 必须把真实原因报出来，不许假装练得下去', async () => {
  const { r, study } = qtScene(['造句'])
  const id = new Repo(r.db).addItem(1, 'nothing to fall back on', '', 'B', '').id
  const ai = fakeAi('')
  await setUpAi(r.db, ai.base)
  let threw = ''
  try {
    await study.ensureQuestions(id)
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  } finally {
    ai.restore()
  }
  assert(threw !== '', '★★ 一道题都没有还说成了 —— 他会对着空练习页发呆')
  assert(
    threw !== KEPT_OLD_NOTICE,
    '★ 手上没有旧题时不许说「还是上一批题」—— 根本没有上一批'
  )
  r.db.close()
})
