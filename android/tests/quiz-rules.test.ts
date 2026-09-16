/**
 * ══ Q · 出题规则七个选项（D-482 · 2026-09-15）★ ═══════════════
 *
 * 判据全在 core（`quiz-rules.ts`）—— 拼出来的英文句子、出厂值、豁免规则，
 * 本端一个字都不许再写一遍。所以这一组盯的是**本端接线**，四件事各有一种安静的坏法：
 *
 *   ① 键面存取来回 —— 存下去读不回来，屏上显示的就永远是出厂档，
 *      而他每次改完看着都像生效了（[[key-surface-needs-roundtrip-test]]）。
 *   ② `reading.lastFace` 写对了表没有 —— 写进同步表就得加列，结构指纹一变
 *      两端就得协调升库（主控 2026-09-15 改判的正是这件事）。
 *   ③ 退役那把键还能不能写 —— 还能写就等于「两个真相」又活了。
 *   ④ 老数据认账 —— 他以前写的正文被动了，就是把他的东西弄丢了。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripSource } from '../tools/lib/strip-comments.mjs'
import {
  PRACTICE_RULES_FACTORY,
  QUIZ_RULE_KEYS,
  READING_RULES_BEFORE_OPTIONS,
  READING_RULES_FACTORY,
  READING_FACES,
  parseLastFace,
  practiceRulesOf,
  serializeFacePrefs,
  prefUid,
  readingRulesOf
} from '../src/core-link.ts'
import { prefRaw, prefSet } from '../src/db/prefs.ts'
import { legacyReadingRules, readingPromptFor } from '../src/db/lookup.ts'
import { builtDb, cleanup, type Fixture } from './helpers.ts'

after(cleanup)

/** 把七把键读成 core 要的那个同步闭包（本端偏好是异步表，接线就在这一步） */
async function rulesOf(f: Fixture): Promise<{
  r: ReturnType<typeof readingRulesOf>
  w: ReturnType<typeof practiceRulesOf>
}> {
  const keys = Object.values(QUIZ_RULE_KEYS)
  const vals = await Promise.all(keys.map((k) => prefRaw(f.db, k)))
  const got = new Map(keys.map((k, i) => [k as string, vals[i] ?? null]))
  const read = (k: string): string | null => got.get(k) ?? null
  return { r: readingRulesOf(read), w: practiceRulesOf(read) }
}

/** 老数据：他以前写的那段正文。走裸 SQL —— 这把键已经不在白名单里，`prefSet` 会抛 */
async function seedLegacy(f: Fixture, text: string): Promise<void> {
  const t = Date.now()
  await f.db.run(
    `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [prefUid('prompt.reading-card'), 'prompt.reading-card', text, t, t]
  )
}

describe('Q · 出题规则七个选项（接线）', () => {
  it('Q-1 · 一把都没设过 → 七项全是 core 的出厂档', async () => {
    const f = builtDb()
    const { r, w } = await rulesOf(f)
    assert.deepEqual(r, READING_RULES_FACTORY, '★ 理解层三项没回出厂')
    assert.deepEqual(w, PRACTICE_RULES_FACTORY, '★ 写作层四项没回出厂')
  })

  it('Q-2 · 七项存下去都读得回来（键面存取来回）', async () => {
    const f = builtDb()
    await prefSet(f.db, QUIZ_RULE_KEYS.facePick, 'rotate')
    await prefSet(f.db, QUIZ_RULE_KEYS.readingHint, 'more')
    await prefSet(f.db, QUIZ_RULE_KEYS.shiftContext, '1')
    await prefSet(f.db, QUIZ_RULE_KEYS.practiceHint, 'none')
    await prefSet(f.db, QUIZ_RULE_KEYS.contextSpread, 'far')
    await prefSet(f.db, QUIZ_RULE_KEYS.requireFullSentence, '1')
    await prefSet(f.db, QUIZ_RULE_KEYS.matchRegister, '1')

    const { r, w } = await rulesOf(f)
    assert.deepEqual(
      r,
      { facePick: 'rotate', hintLevel: 'more', shiftContext: true },
      '★★ 理解层存了读不回来 —— 屏上会一直显示出厂档，而他每次改完都像生效了'
    )
    assert.deepEqual(w, {
      hintLevel: 'none',
      contextSpread: 'far',
      requireFullSentence: true,
      matchRegister: true
    })
    // ★ 真的换了一份，不是恰好等于出厂
    assert.notDeepEqual(r, READING_RULES_FACTORY)
    assert.notDeepEqual(w, PRACTICE_RULES_FACTORY)
  })

  it('Q-3 · 七项都进 USER 同步表（出的题跟着人走）', async () => {
    const f = builtDb()
    for (const k of Object.values(QUIZ_RULE_KEYS)) {
      await prefSet(f.db, k, k.startsWith('reading.shift') || k.startsWith('practice.require') || k.startsWith('practice.match') ? '1' : await legalValue(k))
      assert.ok(
        await prefRaw(f.db, k),
        `★ ${k} 没落在 user_preferences 里 —— 换台设备他得把七项重设一遍`
      )
    }
  })

  it('Q-4 · 退役那把键写不进去了（两个真相只留一个）', async () => {
    const f = builtDb()
    await assert.rejects(
      () => prefSet(f.db, 'prompt.reading-card', '我又想自己写一段'),
      /不在偏好清单里/,
      '★★ 还能写 —— 那就又有两份出题规则了，而屏上只显示其中一份'
    )
  })

  it('Q-5 · 老数据认账：他以前写的正文原样留着，只读拿得到', async () => {
    // ① 没改过（库里一行都没有）→ 屏上不该多那一行
    const a = builtDb()
    assert.equal(await legacyReadingRules(a.db), null, '★ 没写过就别凭空多一行')

    /**
     * ★★ ①b · **上一版出厂正文**也算「没改过」—— 这条是 2026-09-15 真机上露馅的那一条。
     *   本仓先写了「和**今天**的出厂比」，装到他手机上当场多出一行
     *   「你以前写的出题规则已经收起来了」，而他一个字都没写过 ——
     *   因为他库里躺着的是**上一版**出厂正文（这一轮 core 刚把出厂正文改成选项拼的）。
     *   判据现在在 core（`legacyReadingRulesOf` + `FACTORY_READING_RULE_TEXTS`，每一版都认）。
     */
    const old = builtDb()
    await seedLegacy(old, READING_RULES_BEFORE_OPTIONS)
    assert.equal(
      await legacyReadingRules(old.db),
      null,
      '★★ 老用户被判成「他改过」了 —— 屏上会对他说一句他一个字都没写过的话'
    )

    // ② 改过 → 正文原样留着，读得回来
    const b = builtDb()
    await seedLegacy(b, '我以前自己写的一整段出题规则。')
    await readingPromptFor(b.db, 'x', null, null, null) // 走一次发牌面那条路（迁移挂在它上面）
    assert.equal(
      await prefRaw(b.db, 'prompt.reading-card'),
      '我以前自己写的一整段出题规则。',
      '★★ 他那段被动过了 —— 退役的是输入方式，不是他写的东西'
    )
    assert.equal(await legacyReadingRules(b.db), '我以前自己写的一整段出题规则。')

    // ③ 出题**不再用它**：正文里那句话不许出现在拼出来的提示词里
    const built = await readingPromptFor(b.db, 'x', null, null, null)
    assert.ok(
      !built!.system.includes('我以前自己写的一整段出题规则'),
      '★★ 正文还在参与拼装 —— 那就等于选项没生效'
    )
  })

  it('Q-6 · 「上次用了哪一面」走 settings，不进同步表（指纹不变的前提）', async () => {
    const f = builtDb()
    const t = Date.now()
    await f.db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)`,
      ['reading.lastFace', JSON.stringify({ 'items-nat-x': 'cloze' }), t]
    )
    assert.deepEqual(parseLastFace(String((await f.db.get(
      `select value from settings where key = ?`,
      ['reading.lastFace']
    ))?.['value'])), { 'items-nat-x': 'cloze' })

    const synced = await f.db.all(`select key from user_preferences where key like ?`, ['%lastFace%'])
    assert.deepEqual(
      synced,
      [],
      '★★ 它进了同步表 —— 加列就得改结构指纹，两端 v36 / v38 不协调升级的前提就没了'
    )
  })

  /**
   * ★★ Q-6b · 上面那条**看不见真正的写入口**。
   *
   * 2026-09-15 跑负向对照当场撞到：把「settings 照写、另外往同步表也写一份」打进
   * `markLastFace`，Q-6 **照样绿** —— 因为它自己往 settings 塞了一行，从没让产品代码写过。
   * 真正的写入口挂在 `readingFace` 上（要叫 AI），node 用例进不去。
   *
   * 所以这一条盯**源码形状**：`reading.lastFace` 这把键只许经 `settingSet` 落库，
   * 同一个文件里不许出现把它写进 `user_preferences` 的语句。
   * 「闸说的不是真话，是它只看了一半」—— 这一条补的就是那另一半。
   */
  it('Q-6b · 真正的写入口只写 settings（上一条看不见它，所以钉源码）', () => {
    /**
     * ★★ 先剥注释再扫（ZA-1）。这一条**两个方向都能被注释骗**：
     *   `fn.includes('settingSet(')` 是正向 —— 注释里写一句就当它有了（**假绿**）；
     *   `!/user_preferences/` 是反向 —— 注释里提一句就红（**假红**）。
     */
    const src = stripSource(
      readFileSync(new URL('../src/db/lookup.ts', import.meta.url), 'utf8'),
      'lookup.ts'
    )
    const body = src.slice(src.indexOf('async function markLastFace'))
    const fn = body.slice(0, body.indexOf(String.fromCharCode(10) + '}') + 2)
    assert.ok(fn.includes('settingSet('), '★ 写入口不再走 settingSet')
    assert.ok(
      !/user_preferences/.test(fn),
      '★★ 写入口碰了同步表 —— 加列就得改结构指纹，两端不协调升级的前提没了'
    )
  })
  /**
   * ══ Q-6c · 「轮着来」**真的读到了那个记号**（D 补，2026-09-15）══════
   *
   * ── 为什么 Q-6 / Q-6b 都挡不住这件事 ──────────────────────
   * Q-6 验的是「记号写对了表」（自己写一行、自己读回来 —— **存储的来回**），
   * Q-6b 验的是「写入口只写 settings」（**源码**）。两条都没碰**读出来之后有没有用上**。
   *
   * `readingPromptFor` 少递 `lastFaceId`（`buildReadingPrompt` 的第 6 个参数，
   * **有默认值 `null`**）之后：编译过、返回一个对象、Q-1～Q-6b 全绿 ——
   * 只有「轮着来」在手机上静静退化成按原序，而他在电脑上明明选了轮转。
   *
   * ☞ 主控 2026-09-15 派 D 核过：把那个参数拆掉跑**全量**，一条都不红。
   *
   * ★ 所以这条走**真库**：插一条有 uid 的知识点、把记号写进 `settings`，
   *   再看拼出来的 system 段里牌面的**先后顺序**真的换了。
   */
  it('★★ Q-6c · rotate：记号在 settings 里 → 上次那一面排到最后（少递 lastFaceId 这条就红）', async () => {
    const f = builtDb()
    const t = Date.now()
    await f.db.run(
      `insert into items (id, uid, term, gloss, layer, created_at, updated_at)
         values (1, 'item-uid-rot', 'flex', 'g', 'A', ?, ?)`,
      [t, t]
    )
    await prefSet(f.db, QUIZ_RULE_KEYS.facePick, 'rotate')
    await prefSet(
      f.db,
      'reading.faces',
      serializeFacePrefs(READING_FACES.map((x) => ({ id: x.id, on: true })))
    )
    // 上次用的是第一面（挖空）—— 轮转该把它排到最后
    await f.db.run(`insert into settings (key, value, updated_at) values (?, ?, ?)`, [
      'reading.lastFace',
      JSON.stringify({ 'item-uid-rot': 'cloze' }),
      t
    ])

    const cloze = READING_FACES.find((x) => x.id === 'cloze')!
    const scenario = READING_FACES.find((x) => x.id === 'scenario')!

    const a = await readingPromptFor(f.db, 'flex', null, null, 1)
    assert.ok(a, '四面全勾着，不该回 null')
    assert.ok(
      a!.system.indexOf(scenario.guide) < a!.system.indexOf(cloze.guide),
      '★★ 上次那一面没排到后面 —— 多半是 lastFaceId 没递进去，或者记号查错了表'
    )

    /**
     * ★ 负向对照（同一条里）：**同一个库**，只把选项换成 `quote-first` ——
     *   顺序该原样不动。少了这一半，上面那条在「永远重排」时也会绿。
     */
    await prefSet(f.db, QUIZ_RULE_KEYS.facePick, 'quote-first')
    const b = await readingPromptFor(f.db, 'flex', null, null, 1)
    assert.ok(
      b!.system.indexOf(cloze.guide) < b!.system.indexOf(scenario.guide),
      '★★ 不是 rotate 的档也在重排 —— 那这个选项等于没有'
    )
  })
})

/** 每把键的一个合法值（`checkPrefValue` 只收这些） */
async function legalValue(key: string): Promise<string> {
  if (key === QUIZ_RULE_KEYS.facePick) return 'random'
  if (key === QUIZ_RULE_KEYS.readingHint) return 'less'
  if (key === QUIZ_RULE_KEYS.practiceHint) return 'gloss-only'
  if (key === QUIZ_RULE_KEYS.contextSpread) return 'mixed'
  return '1'
}
