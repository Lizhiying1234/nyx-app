/**
 * TL · 三层补齐的接线闸（D-486 · 2026-09-15）
 *
 * ★★ 判据不在这里 —— `practiceFaceOf` / `readingQTypeOf` / `capReadingGrade` /
 *    `matchesTerm` 全在 core，对不对是 core 单测的事。
 *    这一组只钉一件：**这一端真的把它们接上了**，而且接的是 core 那一份。
 *
 * ★★★ 为什么必须有这一组：这四样接错的症状**全是安静的** ——
 *    键名写错 → 静静回出厂档；`capReadingGrade` 各写一个 2 → 改一处另一处不动；
 *    `matchesTerm` 自己写一份 → 同一个答案在两台机器上一个算对一个算错。
 *    屏幕上、库里、别的用例里都不会报错。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripSource } from '../tools/lib/strip-comments.mjs'
import { builtDb, cleanup } from './helpers.ts'
import { prefReader, prefSet } from '../src/db/prefs.ts'
import {
  PRACTICE_FACE_FACTORY,
  PRACTICE_FACE_SAYS,
  QUIZ_RULE_KEYS,
  READING_CAP_GRADE,
  READING_QTYPE_FACTORY,
  READING_QTYPE_SAYS,
  capReadingGrade,
  matchesTerm,
  practiceFaceOf,
  readingQTypeOf
} from '../src/core-link.ts'

after(cleanup)

const srcOf = (rel: string): string =>
  /**
   * ★★ ZA-1（2026-09-15）改成共用那一份。原来手写两条，**漏剥 HTML 注释** ——
   *   而这个函数扫的正是 `.svelte`：markup 那半的注释是 `<!-- -->`，一条没剥。
   *   TL-5 那条「牌面名不许写死在界面里」是**反向**断言，
   *   于是任何一条提到「整块 / 分栏 / 专注」的 markup 注释都会让它假红。
   */
  stripSource(readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8'), rel)

describe('TL · 三层补齐的接线（D-486）', () => {
  it('TL-1 · 两把新键：存得进、读得回；没设过回出厂', async () => {
    const f = builtDb()
    // 出厂
    const empty = await prefReader(f.db, Object.values(QUIZ_RULE_KEYS))
    assert.equal(practiceFaceOf(empty), PRACTICE_FACE_FACTORY)
    assert.equal(readingQTypeOf(empty), READING_QTYPE_FACTORY)
    // 拨到**非出厂**那一档 —— 全用出厂值的话「没读到」和「读到了」长得一样
    await prefSet(f.db, QUIZ_RULE_KEYS.practiceFace, 'split')
    await prefSet(f.db, QUIZ_RULE_KEYS.readingQType, 'timed')
    const got = await prefReader(f.db, Object.values(QUIZ_RULE_KEYS))
    assert.equal(practiceFaceOf(got), 'split')
    assert.equal(readingQTypeOf(got), 'timed')
    assert.notEqual(practiceFaceOf(got), PRACTICE_FACE_FACTORY)
    assert.notEqual(readingQTypeOf(got), READING_QTYPE_FACTORY)
  })

  it('TL-2 · 认不出的值回出厂，绝不抛（宽容读法是判据的一部分）', async () => {
    const f = builtDb()
    // 裸插一个非法值（`prefSet` 会拦，真库里可能来自别的版本 / 同步）
    const t = Date.now()
    for (const [k, v] of [
      [QUIZ_RULE_KEYS.practiceFace, 'no-such-face'],
      [QUIZ_RULE_KEYS.readingQType, 'no-such-qtype']
    ] as const) {
      await f.db.run(
        `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)`,
        [`uid-${k}`, k, v, t, t]
      )
    }
    const read = await prefReader(f.db, Object.values(QUIZ_RULE_KEYS))
    assert.equal(practiceFaceOf(read), PRACTICE_FACE_FACTORY)
    assert.equal(readingQTypeOf(read), READING_QTYPE_FACTORY)
  })

  /**
   * ★★★ TL-3 · 那个封顶档**只有 core 一份**。
   *
   * `Reading.svelte` 里原来写着 `const PEEK_CAP: ReadingGrade = 2`，而 core 为
   * 「限时到点」又写了一个 2。两处各写一个，哪天改一处另一处不动，
   * **而两处都说得通、都不报错** —— 看过中文封到第 2 档、超时封到第 3 档，
   * 屏上四格显示的天数还是对的（它照自己那一份算），只有排期悄悄变了。
   */
  it('★★ TL-3 · Reading.svelte 不许再自带封顶档，只许调 core 的 capReadingGrade', () => {
    const src = srcOf('ui/views/Reading.svelte')
    assert.ok(
      !/PEEK_CAP/.test(src),
      '★★★ 又长出了一份本地封顶档 —— 判据只许有 core 那一个（READING_CAP_GRADE）'
    )
    assert.ok(src.includes('capReadingGrade('), '★ 没在调 core 那一份')
    // 判据本身（core 的事，这里只确认接的是同一把尺）
    assert.equal(capReadingGrade(4, { peeked: true }), READING_CAP_GRADE)
    assert.equal(capReadingGrade(4, { timedOut: true }), READING_CAP_GRADE)
    assert.equal(capReadingGrade(4, {}), 4, '没拿帮助就不该封顶')
    assert.equal(capReadingGrade(1, { peeked: true }), 1, '★ 只封顶、不抬档')
  })

  it('★★ TL-4 · 「先写再翻」的比对只许用 core 的 matchesTerm，不许自己写一把尺', () => {
    const src = srcOf('ui/views/Reading.svelte')
    assert.ok(src.includes('matchesTerm('), '★ 没在调 core 那一份')
    assert.ok(
      !/toLowerCase\(\)\s*===/.test(src),
      '★★ 自己搓了一把比对尺 —— 同一个答案会在两台机器上一个算对一个算错'
    )
    // 确认接的是那把宽容尺（大小写 / 标点 / 词形，core 判）
    assert.equal(matchesTerm('  Bear  the   Brunt! ', 'bear the brunt'), true)
    assert.equal(matchesTerm('bears', 'bear'), true)
    assert.equal(matchesTerm('something else', 'bear'), false)
  })

  /**
   * ★★ TL-5 · 屏上的字全部来自 core（CR-7：同一件事两端一个说法）。
   *   各写一份的话，电脑上叫「整块」、手机上叫「一整块」，两边都说得通、都不报错，
   *   而他只会以为那是两个不同的设置。
   */
  it('★★ TL-5 · 牌面名 / 题型名不许在这一端写死', () => {
    const src = srcOf('ui/views/Settings.svelte')
    for (const v of Object.values(PRACTICE_FACE_SAYS)) {
      assert.ok(
        !src.includes(`>${v.name}<`),
        `★ 「${v.name}」被写死在界面里了 —— 要从 core 的 PRACTICE_FACE_SAYS 取`
      )
    }
    for (const v of Object.values(READING_QTYPE_SAYS)) {
      assert.ok(
        !src.includes(`>${v.name}<`),
        `★ 「${v.name}」被写死在界面里了 —— 要从 core 的 READING_QTYPE_SAYS 取`
      )
    }
    assert.ok(src.includes('PRACTICE_FACE_SAYS['), '★ 没从 core 取产出牌面的字')
    assert.ok(src.includes('READING_QTYPE_SAYS['), '★ 没从 core 取认读题型的字')
  })

  /**
   * ★ TL-6 · B-5 那个引导锚点（与 C 约定的 id）。
   *   写错 id 的后果：引导永远不出，或者「看过」记不上每次都出 ——
   *   `check` 不红、用例不红、屏幕上也不会说什么。
   */
  it('TL-6 · B-5 的 data-guide 锚点在结算块上，id 是约定那个', () => {
    const src = srcOf('ui/views/Practice.svelte')
    assert.ok(
      /class="verdict" data-guide="practice-settle"/.test(src),
      '★ B-5 的锚点不在 .verdict 上、或者 id 不是与 C 约定的 practice-settle'
    )
  })
  /**
   * ★★★ TL-7 · 六个段名与段说明**与 Windows 逐字同**（CR-7 · D-2）
   *
   * 三层 × 两个模式 = 六段。它们是「结构对应」这件事在屏上唯一看得见的表达 ——
   * 段名漂了，两个模式就不再是同一张骨架，而**两边都说得通、都不报错**。
   *
   * ★ 为什么钉在这一端而不是 core：这六句是**段落说明**不是选项名，
   *   Windows 那份写在它的 `Settings.svelte` 里（`lh-n` / `lh-s`），core 没有它们。
   *   钉不住「两端一致」，至少钉住「这一端没被随手改掉」——
   *   ☞ **未定性**：真正的两端一致要一道跨仓的闸（本仓读不到 Windows 源码），
   *     那是主控那一层的事，我在交付里点名了。
   */
  it('★★ TL-7 · 六段的名与说明逐字钉住（CR-7 · 与 Windows 同一份措辞）', () => {
    const src = srcOf('ui/views/Settings.svelte')
    const six = [
      ['牌面', '这张卡给你看什么 · 可以多选，出题时轮着来'],
      ['题型', '你要做出什么动作才算认出来 · 只能选一种'],
      ['出题规则', '系统按什么条件出这道题'],
      ['牌面', '这道题在屏幕上摆成什么样 · 只能选一种'],
      ['题型', '你要做什么题 · 可以多选，出题时轮着来'],
      ['出题规则', '系统按什么条件生成这批题']
    ]
    for (const [name, says] of six) {
      assert.ok(
        src.includes(`<div class="sec">${name}</div>`) && src.includes(`<div class="seclead zh">${says}</div>`),
        `★ 这一段的措辞和 Windows 对不上了：「${name} · ${says}」`
      )
    }
    /**
     * ★ 负向对照就在这条里：**两个模式的六句必须各不相同**。
     *   六句里有重复 = 某一段被复制粘贴过去忘了改，而屏上看起来一切正常。
     */
    const saysList = six.map(([, t]) => t)
    assert.equal(new Set(saysList).size, 6, '★★ 六段说明里有重复 —— 多半是复制过去忘了改')
  })
  /**
   * ★★★ TL-8 · `focus` 那一档**真的推得走东西**（上机抓到的）
   *
   * 第一版：CSS 写了 `.pfocus .fadeaway{display:none}`、`class:pfocus` 也挂了，
   * 屏上却**一点变化都没有** —— 因为 class 挂在 `.pcard` 上，而 `.pcard` 里本来
   * 就只有「任务 + 输入框」，要推走的那几块全在它**外面**。
   * `check` 0 · 全量绿 · 没有任何东西会说话，**只有真机看得见**。
   *
   * 所以这条钉两件：① 有元素真的带 `fadeaway`；② 那个 class 不挂在 `.pcard` 上。
   */
  it('★★ TL-8 · focus：有东西被标成可推走，且 class 不挂在 .pcard 上', () => {
    const src = srcOf('ui/views/Practice.svelte')
    assert.ok(
      /class="[^"]*fadeaway[ "]/.test(src),
      '★★★ 没有任何元素带 `fadeaway` —— `focus` 这一档点了不会有任何变化'
    )
    assert.ok(
      !/class="pcard"[^>]*class:pfocus/.test(src),
      '★★ `pfocus` 挂回 `.pcard` 了 —— 卡里只有任务和输入框，挂它等于什么都不推'
    )
    assert.ok(/class="pwrap"[^>]*class:pfocus/.test(src), '★ `pfocus` 要挂在外层 `.pwrap` 上')
  })
})
