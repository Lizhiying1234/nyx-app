/**
 * 产出线对照（P-1 ～ P-6）。
 *
 * 判据链：applyGrade/tierFor/qtype-plan/nextLectureInterval/AI 客户端全在
 * core（direct import）；这里钉 `db/practice.ts` 港来的平台面：
 *   ① 生成只在缺题时发生，入库带 qtype_sig，全部合法配额正中（D-129）
 *   ② nextQuestion 当前档优先 + 用过的题不再来
 *   ③ submitAnswer：answers 带 device/duration/is_first；只有第一次推进进度
 *     （D-121）；过关才回范文（D-122）④ 提示 = 认读失败（D-138）
 *   ⑤ 结算：讲次排期推进 + finished_at 幂等 ⑥ sessions 带 rules 快照（D-349）
 * AI = 本地 mock（OpenAI 形）：机制全真，脑子是假的 —— 判分质量不在 ② 层验。
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import {
  fill,
  CONTEXT_SPREAD_LINES,
  FULL_SENTENCE_LINE,
  MATCH_REGISTER_LINE,
  QUIZ_RULE_KEYS,
  practiceGlobalLines
} from '../src/core-link.ts'
import { prefSet } from '../src/db/prefs.ts'
import { __setKeyProviderForTests } from '../src/db/ai.ts'
import {
  ensureQuestions,
  nextQuestion,
  productionQueueMany,
  settleLectures,
  startSession,
  submitAnswer,
  usedHint
} from '../src/db/practice.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

__setKeyProviderForTests(async () => 'mock-key')

// ── 本地 mock AI（tools/dev-ai.mjs 同款判定，内嵌以免起子进程）──
let srv: Server | null = null
let port = 0
/**
 * ★★ 最后一次**真正发出去**的那份提示词（D 补，2026-09-15）。
 *
 * 直接调 core 的 `buildPracticeRules` 那种用例证明不了这一端把它接上了 ——
 * 接线拆掉之后 core 照样算得对，用例照样绿。要钉住接线，只能看发出去的那段字。
 */
let lastSent = ''
before(async () => {
  await new Promise<void>((resolve) => {
    srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += String(c)))
      req.on('end', () => {
        const j = JSON.parse(body || '{}') as { messages?: { content: string }[] }
        const user = (j.messages ?? []).map((m) => m.content).join('\n')
        lastSent = user
        let out: unknown
        if (user.includes('Their answer:')) {
          const term = (user.match(/Target expression: \*\*(.+?)\*\*/) ?? [])[1] ?? ''
          const answer = (user.match(/Their answer:\n([\s\S]*?)\n\nA reference answer/) ?? [])[1] ?? ''
          const hasTerm = term && answer.toLowerCase().includes(term.toLowerCase())
          const grade = hasTerm ? (answer.includes('perfectly') ? 4 : 3) : 2
          const firstWord = answer.trim().split(/\s+/)[0] ?? ''
          out = {
            grade,
            note: 'n',
            why: 'w',
            annotations:
              grade >= 3 || !firstWord
                ? []
                : [{ span: firstWord, label: 'target-missing', problem: 'p', fix: term }]
          }
        } else {
          // ★ D-478 档位取消：提示词不再分 `**Tier n**` 段，而是**一张单子**
          //   （`Write exactly N questions, in this order:`）。照单子逐条应答。
          const questions: unknown[] = []
          for (const line of user.split('\n')) {
            const m = line.match(/type must be exactly `([^`]+)`/)
            if (m) {
              questions.push({
                type: m[1],
                prompt: `[MOCK] q${questions.length + 1}`,
                context: 'original',
                reference: `ref${questions.length + 1}`
              })
            }
          }
          out = { questions }
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }] }))
      })
    })
    srv.listen(0, '127.0.0.1', () => {
      port = (srv!.address() as { port: number }).port
      resolve()
    })
  })
})
after(() => srv?.close())

function armed(f: Fixture): void {
  const t = Date.now()
  const set = f.raw.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  for (const slot of ['light', 'heavy']) {
    set.run(`ai.${slot}.baseUrl`, `http://127.0.0.1:${port}/v1`, t)
    set.run(`ai.${slot}.model`, 'mock', t)
    set.run(`ai.${slot}.protocol`, 'openai', t)
  }
  set.run('sync.device', 'ph-p', t)
  // 两个启用题型（builtin 播种不在夹具里 —— 手插两行就够）
  const qt = f.raw.prepare(
    `insert into qtypes (uid, key, name, tier, brief, guide, prompt, enabled, canonical, builtin, sort, created_at, updated_at)
     values (?, ?, ?, ?, '', 'guide', '', 1, 1, 1, 0, ?, ?)`
  )
  qt.run('qt-a', '造句', '造句', 1, t, t)
  qt.run('qt-b', '情景', '情景', 2, t, t)
}

describe('P-fill · 提示词变量填充（判据在 core，手机不许有第二份）', () => {
  // ★ 这条闸 2026-09-13 补：`db/prompts.ts` 里原来抄着一份 `fill`，而且**已经漂了** ——
  //   本地那份填不上时退回空串，core 那份退回 `{{VAR}}` 原样。
  //   core `prompt-fill.ts` 的文件头早就写明这件事会怎么坏：
  //   「少填一个变量时 Windows 停下来报错、手机把 `{{KIND}}` 原样发给 AI，
  //     两边都不崩，只是手机那边出来的解析一直是错的」。
  it('漏填变量 → 当场抛，绝不把半截提示词发出去', () => {
    assert.throws(
      () => fill('题型要求：{{TYPES}}，水平：{{LEVEL}}', { LEVEL: 'B1' }),
      /TYPES/,
      '★ 漏的那个变量名必须出现在报错里 —— 否则他只知道「失败了」，不知道少了什么'
    )
  })

  it('变量都给齐了 → 一个 {{ }} 都不剩', () => {
    const out = fill('{{A}} 和 {{B}}，再来一次 {{A}}', { A: '甲', B: '乙' })
    assert.equal(out, '甲 和 乙，再来一次 甲', '同一个变量出现多次要全替换')
    assert.ok(!out.includes('{{'), '不许有漏网的占位符')
  })

  it('★ 空字符串是**填了**，不是没填', () => {
    // 会出事的场景：上下文句子为空。那是合法的「就是没有上下文」，
    // 不是「忘了填」—— 当成没填会把一次正常的出题变成报错。
    assert.equal(fill('上下文：{{CTX}}。', { CTX: '' }), '上下文：。')
  })

  it('★★ 全仓只有一份 fill —— `src/` 里不许再出现它的函数体', () => {
    // ★ 剥掉注释再扫：记账本来就该待在注释里（这一课我在 splash-label-keys 上踩过）。
    const src = readFileSync(new URL('../src/db/prompts.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      !/export function fill\b/.test(src),
      '★ `db/prompts.ts` 又长出了一份 fill —— 判据在 core，这里只该引'
    )
  })
})

describe('P · 产出线', () => {
  /**
   * ══ P-0 · 四个产出选项**真的拼进了发出去的那份提示词**（D 补，2026-09-15）══
   *
   * ── 为什么非有这条闸不可 ────────────────────────────────
   * 「选项算得对」和「选项被用上了」是两件事。`typesBrief` 里少调一次
   * `buildPracticeRules`、`vars` 里少填一个 `SPREAD`，core 的单测照样全绿，
   * 这一端别的用例也照样全绿 —— 只有**发出去的那段字**里少了几句，
   * 而那几句正是他在设置里点出来的东西。
   *
   * ☞ 主控 2026-09-15 派 D 核过：把 `buildPracticeRules` 那一行拆掉跑**全量**，
   *   一条都不红。
   *
   * ★ 所以断言看的是 `lastSent`（mock 收到的原文），不是任何中间变量。
   */
  it('★★ P-0 · 四个选项拼进真发出去的提示词（拆掉接线这条就红）', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    // 四个全挑**非出厂**档：全用出厂的话，「没读到偏好」和「读到了」长得一样
    await prefSet(f.db, QUIZ_RULE_KEYS.practiceHint, 'none')
    await prefSet(f.db, QUIZ_RULE_KEYS.contextSpread, 'far')
    await prefSet(f.db, QUIZ_RULE_KEYS.requireFullSentence, '1')
    await prefSet(f.db, QUIZ_RULE_KEYS.matchRegister, '1')

    lastSent = ''
    await ensureQuestions(f.db, 1)
    assert.ok(lastSent, '★ 压根没发出去 —— 下面几条全是空转')

    // W-2：选的那一档在，别的档不许在
    assert.ok(lastSent.includes(CONTEXT_SPREAD_LINES.far), '★★ SPREAD 没填进去')
    assert.ok(!lastSent.includes(CONTEXT_SPREAD_LINES.near), '★★ 没选的那一档也拼进去了')
    // W-1「都不给」那一档的全局句
    assert.ok(
      practiceGlobalLines({
        hintLevel: 'none',
        contextSpread: 'far',
        requireFullSentence: true,
        matchRegister: true
      }).every((l) => lastSent.includes(l)),
      '★★ OPTIONS 没填进去'
    )
    // W-3 / W-4 跟着每一种题型走（夹具那两种都不是成段题型，两句都该在）
    assert.ok(lastSent.includes(FULL_SENTENCE_LINE), '★★ W-3 没跟着题型拼进去')
    assert.ok(lastSent.includes(MATCH_REGISTER_LINE), '★★ W-4 没跟着题型拼进去')
  })

  /**
   * ══ P-0b · I-187：内置题型**不读 `prompt`**，两处生成路都得守 ══════
   *
   * ★★★ **这条闸被删过一次**（2026-09-15 夜，静默改名那一笔的合并把 I-187 五处
   *   连同这条用例一起盖掉了）。删掉之后 master 上 I-187 **原样复发，而四门全绿** ——
   *   这正是这条闸存在的理由：病本身不会喊疼，只有它会。
   *
   * ── 病 ────────────────────────────────────────────────
   * 他真库里 12 种内置题型有 10 种带着 5～10 千字的英文 `prompt`，而且**与题型名错位**
   * （「造句」那条写的是 cohesion reconstruction）。生成路曾是「有 prompt 就用」——
   * **「造句」一直在按别的题型出题，而屏幕上一切正常**。
   * 使用者 2026-09-15 答：那些正文**是生成的，不是他写的**。
   *
   * ── 钉两件事，缺一不可 ────────────────────────────────
   * ① `typesBrief` —— 发出去的那段里，内置用 `guide` 不是 `prompt`
   * ② `qtypeSignature` —— **第二张脸**：指纹也曾按 `prompt || guide` 算，
   *    不改的话那 10 段垃圾仍在决定「这一批题该不该删掉重出」。
   */
  it('★★ P-0b · I-187：内置只按 guide 出题，两处生成路都不读 prompt', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    const t = Date.now()
    // 给**内置**那条塞一段错位正文（= 他真库里的样子），自建那条塞它自己的
    f.raw
      .prepare(`update qtypes set prompt = ? where uid = ?`)
      .run('INTERNAL-GARBAGE-cohesion-reconstruction', 'qt-a')
    f.raw
      .prepare(
        `insert into qtypes (uid, key, name, tier, brief, guide, prompt, enabled, canonical, builtin, sort, created_at, updated_at)
         values ('qt-mine', '我自己的', '我自己的', 1, '', 'MY-GUIDE', 'MY-OWN-PROMPT', 1, 0, 0, 9, ?, ?)`
      )
      .run(t, t)

    lastSent = ''
    await ensureQuestions(f.db, 1)
    assert.ok(lastSent, '★ 压根没发出去 —— 下面全是空转')

    // ① 内置：用 guide，**那段错位正文一个字都不许出现**
    assert.ok(
      !lastSent.includes('INTERNAL-GARBAGE-cohesion-reconstruction'),
      '★★★ 内置题型还在按那段错位的英文正文出题（I-187 的病本体）'
    )
    // 自建：仍然用它自己的 prompt（这一半不许连坐）
    assert.ok(lastSent.includes('MY-OWN-PROMPT'), '★★ 自建题型的出题要求被一起关掉了')

    // ② 第二张脸：内置那段正文变长，**指纹必须不变**
    const sigOf = (): string =>
      (
        f.raw.prepare(`select qtype_sig from questions where item_id = 1 limit 1`).get() as {
          qtype_sig: string
        }
      ).qtype_sig
    const before = sigOf()
    f.raw
      .prepare(`update qtypes set prompt = ? where uid = ?`)
      .run('INTERNAL-GARBAGE'.repeat(400), 'qt-a')
    await ensureQuestions(f.db, 1) // 指纹没变 → 不重出
    assert.equal(
      sigOf(),
      before,
      '★★★ 出题指纹还在读内置的 prompt —— 那 10 段垃圾仍在决定「要不要把没做的题删掉重出」'
    )
  })


  it('★★★ P-I198 · answer 指着的未做题不许被删（外键会抛，产出线整条进不去）', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    await ensureQuestions(f.db, 1)

    const q = f.raw
      .prepare(`select id from questions where item_id = 1 and used_at is null order by id limit 1`)
      .get() as { id: number }
    assert.ok(q, '★ 前提就不对：一道未做的题都没有')

    /**
     * ★★ 造出 I-198 那一行：**有 answer 指着、却仍然 `used_at is null`**。
     *   他真库里就有这么一条（E 在 Windows 侧定位）。本端 2026-09-15 真机量到 0 条，
     *   但 `answers` 是同步表 —— **它随时会过来**，所以这是预防性的用例。
     */
    const t = Date.now()
    f.raw
      .prepare(
        `insert into answers (item_id, question_id, text, created_at, updated_at)
         values (1, ?, 'x', ?, ?)`
      )
      .run(q.id, t, t)

    /**
     * 让「签名不符」成立。
     * ★ 第一版我改的是 `qtypes.prompt` —— **那是哑的**：夹具里两个题型都是 builtin，
     *   而 I-187 之后**内置的 prompt 根本不进签名**（旁边那条用例正钉着这件事），
     *   于是 `stale = 0`，删除压根没跑，**负向对照绿着过去了**。
     * ☞ 改成直接把已有题的 `qtype_sig` 置成旧值 —— 那正是代码分支判的条件本身，
     *   不依赖「签名怎么算」这件会变的事。
     */
    f.raw.prepare(`update questions set qtype_sig = 'OLD-SIG' where item_id = 1`).run()

    /**
     * ★★★ 改之前这一句会抛 `FOREIGN KEY constraint failed` ——
     *   因为原来是 `delete from questions where item_id = ? and used_at is null`，
     *   把被 answer 指着的那一行也删了。**产出练习从任何入口都进不去。**
     */
    await ensureQuestions(f.db, 1)

    const still = f.raw.prepare(`select id from questions where id = ?`).get(q.id) as
      | { id: number }
      | undefined
    assert.ok(still, '★★★ 被 answer 指着的那道题被删了 —— 外键会抛，产出线整条废掉')
  })

  it('P-1 · 生成只在缺题时发生；入库带 qtype_sig；再进不再生成', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    const n = await ensureQuestions(f.db, 1)
    /**
     * ★ D-478（2026-09-08）：原来是「两档 × 各 3 道 = 6」。档位取消之后，
     *   一次出几道由 `param.questionsPerItem` 定 —— 夹具没设过，就是 core 的出厂 15
     *   （= 原来五档各 3 道，换机制不改他今天拿到的量）。
     */
    assert.equal(n, 15, '没设过 param.questionsPerItem → core 的出厂值 15')
    const rows = f.raw
      .prepare(`select type, qtype_sig from questions where item_id = 1 order by id`)
      .all() as { type: string; qtype_sig: string }[]
    assert.equal(rows.length, 15)
    assert.ok(rows.every((r) => r.qtype_sig && ['造句', '情景'].includes(r.type)))
    /**
     * ★ 按他排的顺序轮着来，不再按档分段。
     *   起点不是第一种：`planFor` 把**知识点 id 当 offset** 传给 core —— 每条都从
     *   第一种起步的话，排在后面的题型永远轮不到（他勾了却见不到）。
     *   这里 item 1 于是从第二种（情景）起步，之后严格按顺序往下轮。
     */
    assert.deepEqual(rows.slice(0, 4).map((r) => r.type), ['情景', '造句', '情景', '造句'])
    assert.equal(await ensureQuestions(f.db, 1), 0, '有题就不再生成（D-129）')
  })

  it('P-2 · nextQuestion：按出题顺序取 · 用过的不再来 · 连着两道不同型（M-027）', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    await ensureQuestions(f.db, 1)
    /**
     * ★ D-478：原来验的是「corrects=0 → 先给第 1 档」。档没了 —— 现在只有一条队列
     *   （出题时排的顺序），判据换成两条：用过的不再来、连着的不重复题型。
     *   后一条就是 M-027：它原来靠档位链隐含保证，现在是 core 里显式的 `preferDifferent`。
     */
    const q1 = await nextQuestion(f.db, 1)
    assert.equal(q1?.type, '情景', '队头就是计划里的第一道（item 1 的起点，见 P-1）')
    f.raw.prepare(`update questions set used_at = ? where id = ?`).run(Date.now(), q1!.id)
    const q2 = await nextQuestion(f.db, 1)
    assert.notEqual(q2?.id, q1?.id, '用过的不再来')
    assert.notEqual(q2?.type, q1?.type, '★ 连着两道不许同一种题型')
  })

  it('P-3 · submitAnswer：采集齐 · 只有第一次推进 · 过关才回范文', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    await ensureQuestions(f.db, 1)
    const sid = await startSession(f.db, 'production', 'lecture', 1)
    const q = (await nextQuestion(f.db, 1))!

    const before = f.raw.prepare(`select corrects, attempts from items where id = 1`).get() as {
      corrects: number
      attempts: number
    }
    const r1 = await submitAnswer(f.db, sid, 1, q.id, 'I used term-1 here.', true, false, 2100)
    assert.equal(r1.grade, 3)
    assert.equal(r1.passed, true)
    assert.equal(r1.reference, 'ref1', 'D-122 · 过关给范文')
    assert.ok(r1.outcome, 'D-121 · 第一次有 outcome')

    const a = f.raw
      .prepare(
        `select is_first, attempt_no, device, duration_ms, grade from answers order by id desc limit 1`
      )
      .get() as Record<string, unknown>
    assert.deepEqual(
      { ...a },
      { is_first: 1, attempt_no: 1, device: 'ph-p', duration_ms: 2100, grade: 3 },
      'D-349 · 采集三样齐'
    )
    const after1 = f.raw.prepare(`select corrects, attempts from items where id = 1`).get() as {
      corrects: number
      attempts: number
    }
    assert.equal(after1.corrects, before.corrects + 1)
    assert.equal(after1.attempts, before.attempts + 1)
    const used = f.raw.prepare(`select used_at from questions where id = ?`).get(q.id) as {
      used_at: number | null
    }
    assert.ok(used.used_at !== null, '答过的题标已用')

    // 第二次：不推进、不给 outcome；没过关也不回范文
    const r2 = await submitAnswer(f.db, sid, 1, q.id, 'nothing relevant', false, false, 900)
    assert.equal(r2.passed, false)
    assert.equal(r2.reference, null, 'D-122 · 没过关不给范文')
    assert.equal(r2.outcome, null, 'D-121 · 第二次不推进')
    const after2 = f.raw.prepare(`select corrects, attempts from items where id = 1`).get() as {
      corrects: number
    }
    assert.equal(after2.corrects, after1.corrects)
    assert.equal(r2.annotations.length, 1, '批注落在他自己的句子上（D-120）')
  })

  it('P-4 · 提示 = 分类器：判分不动，认读卡挨一刀（D-138）', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    f.raw
      .prepare(`update reading_cards set silent = 0, interval_days = 6, lapses = 0, ease = 2.5 where item_id = 1`)
      .run()
    const r = await usedHint(f.db, 1)
    assert.equal(r.gloss, 'g')
    const rc = f.raw
      .prepare(`select interval_days as d, lapses from reading_cards where item_id = 1`)
      .get() as { d: number; lapses: number }
    assert.equal(rc.d, 1, '间隔打回 1 天')
    assert.equal(rc.lapses, 1)
    const log = f.raw
      .prepare(`select line, grade from review_logs order by id desc limit 1`)
      .get() as { line: string; grade: number }
    assert.deepEqual({ ...log }, { line: 'reading', grade: 1 }, '记的是一次认读失败')
  })

  it('P-5 · 结算：讲次排期推进 + finished_at 幂等（第二次结算不再动）', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    await ensureQuestions(f.db, 1)
    const sid = await startSession(f.db, 'production', 'lecture', 1)
    const q = (await nextQuestion(f.db, 1))!
    await submitAnswer(f.db, sid, 1, q.id, 'term-1 works.', true, false, 500)

    const s1 = await settleLectures(f.db, [1], sid)
    assert.equal(s1.perLecture.length, 1)
    assert.ok(s1.perLecture[0]!.reason.length > 0, '机制原话在（D-356 同款透明）')
    const fin = f.raw.prepare(`select finished_at from sessions where id = ?`).get(sid) as {
      finished_at: number | null
    }
    assert.ok(fin.finished_at !== null, '收尾时间写了')

    const s2 = await settleLectures(f.db, [1], sid)
    assert.ok(s2.perLecture[0]!.reason.includes('已经结算过了'), '结算幂等')
  })

  it('P-6 · queueMany 口径 + sessions rules 快照（D-349 第三样）', async () => {
    const f = builtDb()
    seed(f, { settings: {} })
    armed(f)
    f.raw.prepare(`update items set layer = 'A' where id = 3`).run()
    const qmany = await productionQueueMany(f.db, [1])
    assert.deepEqual(qmany.map((x) => x.id), [1, 2], 'A 层不进产出队列')

    const sid = await startSession(f.db, 'production', 'lecture', 2)
    const row = f.raw.prepare(`select device, rules from sessions where id = ?`).get(sid) as {
      device: string
      rules: string
    }
    assert.equal(row.device, 'ph-p')
    const rules = JSON.parse(row.rules) as { v: number; params: { dailyTarget: number } }
    assert.equal(rules.v, 1)
    assert.equal(rules.params.dailyTarget, 35, '快照里有生效参数')
  })
})
