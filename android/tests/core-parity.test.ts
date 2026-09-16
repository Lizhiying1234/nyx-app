/**
 * P · core 对照（同输入 → 同输出）—— 阶段 1 的完成判据（BUILD_PLAN / D-365）。
 *
 * ★★ 这组测试**不验证实现对不对**（那是 Windows 仓库 core 单测的职责，
 *    第①层，Android 不重复跑）。它验证的是**另一件事**：
 *
 *      Android import 的是同一份 core，且这份 core 的行为
 *      与「写下这些字面量的那一天」一致。
 *
 *    所以它红了只有一个含义：**core 变了**（或链路断了）——
 *    Android 立刻知道，而不是悄悄跟着变。这就是「与 Win 版一模一样」
 *    从「靠实现得像」变成「机械保证」的那一步。
 *
 * ★ 输入取自 Windows 的 core 测试用例（逐条注明出处）；
 *   输出是 2026-08-29 用探针跑同一份函数得到的**实际值**，不是我算的。
 * ★ 全部走 `src/core-link.ts` 进 —— 顺带守住链路层只 re-export 这件事。
 * ★ 有随机的传定死的 rnd，有时间的传定死的 now —— 结果必须可复现。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assistStatus, captureAt } from '../src/db/capture.ts'
import { createLecture } from '../src/db/manage-nodes.ts'
import { dedupScan } from '../src/db/merge.ts'
import { readingPromptFor } from '../src/db/lookup.ts'
import { prefSet } from '../src/db/prefs.ts'
import { builtDb, cleanup, seed } from './helpers.ts'
import {
  // 判分
  DEFAULT_GRADING, newItemProgress, applyGrade, explainDistance,
  // 排期
  DEFAULT_READING, newCardState, applyReadingGrade, previewIntervals, penalizeFromHint,
  DEFAULT_LECTURE, nextLectureInterval, dueAfter, overdueDays,
  // 出题
  ALL_QTYPE_IDS, qtypeById,
  cycle, shuffle, pickedTypes, planQuestions, isAllowedType, fitQuota, preferDifferent,
  clampQuestionsPerItem, crossesEnoughTypes, CROSS_TYPE_WINDOW, DEFAULT_QUESTIONS_PER_ITEM,
  QUESTIONS_PER_ITEM_MIN, QUESTIONS_PER_ITEM_MAX,
  // 今日
  matchToday, scheduleOnStart,
  // 静默
  productionApplies, isItemSilent, shouldRetireReadingCard, rollupLecture, rollupProject,
  // 偏好
  PREF_KEYS, prefSpecOf, looksLikeSecret, checkPrefKey, checkPrefValue, prefUid,
  QUIZ_RULE_KEYS, READING_RULES_FACTORY,
  // 材料
  sentences, findQuote, findQuoteIn, paragraphs, CHUNK_LIMIT, chunkCount, chunkText,
  // 收录关系（移出 = 软删）
  moveItems,
  // 单条完整解析的写入计划（T-5.12）
  planWrites,
  // Lecture 内查重（T-9.13 · D-478②）—— 判据在 core，两端装同一份
  scanDuplicates,
  type DedupItem,
  // 认读牌面与出题规则（T-9.18 · D-479）—— 拼装只有 core 一处
  DEFAULT_READING_RULES,
  READING_FACES,
  buildReadingPrompt,
  serializeFacePrefs,
  type Grade, type ItemLines, type CardState
} from '../src/core-link.ts'

const J = <T>(v: T): unknown => JSON.parse(JSON.stringify(v))

after(cleanup)

describe('P · core 对照（同输入 → 同输出）', () => {
  it('P-1 · 判分：机制参数与新档案的形状（D-121 / D-226 / D-166 的值就钉在这）', () => {
    assert.deepEqual(J(DEFAULT_GRADING), { silenceStreak: 3, hardTrigger: 5, graceAttempts: 3 })
    assert.deepEqual(J(newItemProgress()), {
      state: 'new', streak: 0, attempts: 0, attemptsInStage: 0, corrects: 0, hardEntries: 0
    })
  })

  it('P-2 · 判分：3/4 档正确、1/2 档失败；建立期只豁免第 2 档（grading.test 18-45 行）', () => {
    assert.equal(applyGrade(newItemProgress(), 3).correct, true)
    assert.equal(applyGrade(newItemProgress(), 4).correct, true)
    assert.equal(applyGrade(newItemProgress(), 1).correct, false)
    assert.equal(applyGrade(newItemProgress(), 2).correct, false)

    const a = applyGrade(newItemProgress(), 3)
    assert.deepEqual(J(a), {
      progress: { state: 'training', streak: 1, attempts: 1, attemptsInStage: 1, corrects: 1, hardEntries: 0 },
      correct: true, silenced: false, enteredHard: false, leftHard: false, graced: false,
      reason: '第 3 档「准确得体」 · 连续正确 1/3'
    })
    // 建立期内：正确 → 第 2 档 —— 不推进也不清零（graced）
    const g2 = applyGrade(a.progress, 2)
    assert.equal(g2.graced, true)
    assert.equal(g2.progress.streak, 1)
    assert.equal(g2.reason, '第 2 档「可懂但不地道」 · 建立期第 2/3 次，不推进也不清零')
    // 建立期内的第 1 档照样清零
    const g1 = applyGrade(a.progress, 1)
    assert.equal(g1.graced, false)
    assert.equal(g1.progress.streak, 0)
  })

  it('P-3 · 判分：三连对 → 静默（D-133 的 3 次判据）+ explainDistance 的人话', () => {
    let p = newItemProgress()
    for (const g of [3, 3, 3] as const) p = applyGrade(p, g).progress
    assert.deepEqual(J(p), {
      state: 'silent', streak: 3, attempts: 3, attemptsInStage: 3, corrects: 3, hardEntries: 0
    })
    assert.equal(explainDistance(newItemProgress()), '还没练过 · 需要连续 3 次第 3 档以上')
    /**
     * ★★ 这一行的字面**是断言本身**，不是「本端写了第二份」——
     *   这一族的职责就是「同输入 → 同输出」，字面就是用来逮 core 漂移的。
     *   所以它红得对：2026-09-15 跟指针到 `057af66` 时它当场红，
     *   逮住的正是一句**随指针进来的屏上字改动**（D-489：'已练成' → '静默中 —— 不再出题'）。
     * ☞ 和 `SK-6` 里那些被摘掉的字面**不是一回事**：那条用例的标题写着
     *   「本端不写第二份」，字面与它自己的目的相抵；这一条的目的就是钉住字。
     */
    assert.equal(explainDistance(p), '静默中 —— 不再出题')
  })

  it('P-4 · 认读 SM-2：配置 + 新卡 + 间隔序列（sm2-item.test 24-51 行）', () => {
    assert.deepEqual(J(DEFAULT_READING), {
      initialEase: 2.5, minEase: 1.3, maxEase: 2.5, silenceDays: 180,
      newCard: { 1: 1, 2: 1, 3: 1, 4: 4 }
    })
    assert.deepEqual(J(newCardState()), { ease: 2.5, interval: 0, reps: 0, lapses: 0, silent: false })

    const run = (grades: readonly (1 | 2 | 3 | 4)[]): { ivs: number[]; card: CardState } => {
      let c = newCardState()
      const ivs: number[] = []
      for (const g of grades) {
        const o = applyReadingGrade(c, g)
        ivs.push(o.intervalDays)
        c = o.card
      }
      return { ivs, card: c }
    }
    // Windows 测试原场景：第 1 次「会」1 天 → 3 天 → 上次 × E
    assert.deepEqual(run([3, 3, 3]).ivs, [1, 3, 8])
    // 第 4 档走 newCard 表的 4 天起步，且 ×1.3 加速
    const r4 = run([4, 4, 4])
    assert.deepEqual(r4.ivs, [4, 13, 42])
    assert.deepEqual(J(r4.card), { ease: 2.5, interval: 42, reps: 3, lapses: 0, silent: false })
    // 「想了一下」×1.2 且 E−0.15；「忘了」打回 1 天但 reps 不清零（原型老毛病的回归）
    const two = applyReadingGrade(r4.card, 2)
    assert.equal(two.intervalDays, 50)
    assert.equal(Number(two.card.ease.toFixed(2)), 2.35)
    const one = applyReadingGrade(r4.card, 1)
    assert.deepEqual(
      { i: one.intervalDays, reps: one.card.reps, lapses: one.card.lapses },
      { i: 1, reps: 3, lapses: 1 }
    )
    // 预览四档 + 用了提示按最重罚
    assert.deepEqual(J(previewIntervals(r4.card)), { 1: 1, 2: 50, 3: 105, 4: 137 })
    assert.equal(penalizeFromHint(r4.card).intervalDays, 1)
  })

  it('P-5 · 讲次 SM-2：四档乘数与边界（sm2-lecture.test 6-31 行）', () => {
    assert.deepEqual(J(DEFAULT_LECTURE), { firstInterval: 1, minSample: 5, resetTo: 1 })
    const pick = (r: { interval: number; multiplier: number | null }): [number, number | null] =>
      [r.interval, r.multiplier]
    assert.deepEqual(pick(nextLectureInterval(10, 0.45, 30)), [1, null]) // <50% 打回
    assert.deepEqual(pick(nextLectureInterval(10, 0.5, 30)), [12, 1.2]) // 边界 50% 走 ×1.2
    assert.deepEqual(pick(nextLectureInterval(10, 0.6, 30)), [12, 1.2])
    assert.deepEqual(pick(nextLectureInterval(10, 0.9, 30)), [20, 2]) // 90% 含在 75-90
    assert.deepEqual(pick(nextLectureInterval(10, 0.95, 30)), [26, 2.6])
    assert.deepEqual(pick(nextLectureInterval(0, 1, 10)), [3, 2.6]) // 新讲从 1 天起算
    const T0 = 1700000000000
    assert.equal(dueAfter(3, T0) - T0, 200800000) // ★ 不是整 3×86400000 —— 对齐到本地日界
    assert.equal(overdueDays(T0, T0 + 2 * 86400000), 2)
  })

  it('P-6 · 一次出几道：出厂值与夹取（qtype-plan.test · D-478 档位取消后接替原「难度递进」）', () => {
    /**
     * ★ 原来这里验的是 `tierFor(corrects) → 1..5`（`core/progression.ts`）。
     *   2026-09-08 使用者裁「取消档位机制」（D-478），那个文件在 core 里整个删了 ——
     *   接替它的是「一次给一条出几道」这把尺：出厂 15（= 原来五档各 3 道，
     *   换机制不改他今天拿到的量），下限 3（少于 3 道就谈不上 M-027 的跨题型），上限 30。
     */
    assert.deepEqual(
      [DEFAULT_QUESTIONS_PER_ITEM, QUESTIONS_PER_ITEM_MIN, QUESTIONS_PER_ITEM_MAX],
      [15, 3, 30]
    )
    assert.deepEqual(
      [2, 3, 15, 30, 31, '7', 7.4].map((v) => clampQuestionsPerItem(v)),
      [3, 3, 15, 30, 30, 7, 7],
      '越界夹到边上；字符串按数读；小数四舍五入'
    )
    /**
     * ★★ 「没设过」要回**出厂值**，不是夹成下限 —— `Prefs.raw()` 没设过给的是
     *   `null`，而 `Number(null)` 是 0（不是 NaN）。少了这一条，他从没碰过这个设置
     *   就会被悄悄改成一次 3 道。core 的用例当场抓到过，这里跟着钉住。
     */
    assert.deepEqual(
      [null, undefined, '', '   ', NaN, 'abc'].map((v) => clampQuestionsPerItem(v)),
      [15, 15, 15, 15, 15, 15]
    )
  })

  it('P-7 · 题型：12 种 × 5 档的清单本身就是契约（qtypes.test）', () => {
    assert.deepEqual(J(ALL_QTYPE_IDS), [
      '造句', '搭配填空', '开放填空', '句子改写', '释义改写', '句子合并',
      '错误订正', '语域转换', '限定写作', '摘要写作', '情景任务', '论点应答'
    ])
    // ★ D-478：`typesInTier` 没了 —— 题型不再分档，勾了哪几种就按他排的顺序轮
    assert.equal(qtypeById('nope'), null)
  })

  it('P-8 · 出题计划：定死 rnd 之后全部可复现（qtype-plan.test）', () => {
    const rnd0 = (): number => 0
    assert.deepEqual(cycle(['a', 'b', 'c'], 5), ['a', 'b', 'c', 'a', 'b'])
    assert.deepEqual(cycle(['a', 'b', 'c'], 4, 2), ['c', 'a', 'b', 'c'])
    assert.deepEqual(shuffle(['a', 'b', 'c', 'd'], rnd0), ['b', 'c', 'd', 'a'])

    const LITE = [{ key: 'mcq' }, { key: 'cloze' }, { key: 'order' }, { key: 'write' }]
    // ★ 勾选过滤（原 typesInTier 那一半）：顺序以**他排的**为准，没勾的一次都不出现
    assert.deepEqual(pickedTypes(LITE, ['write', 'mcq']), ['mcq', 'write'])
    assert.deepEqual(pickedTypes(LITE, []), [])
    assert.deepEqual(
      [isAllowedType('mcq', ['mcq']), isAllowedType('zzz', ['mcq']), isAllowedType(3, ['mcq'])],
      [true, false, false]
    )
    // mode='seq'：照使用者排的顺序一路轮下去，一位都不许偏 —— 天然可复现
    assert.deepEqual(J(planQuestions(LITE, ['mcq', 'cloze', 'order'], 5, 'seq')), [
      { seq: 0, type: 'mcq' }, { seq: 1, type: 'cloze' }, { seq: 2, type: 'order' },
      { seq: 3, type: 'mcq' }, { seq: 4, type: 'cloze' }
    ])
    // ★ offset：不同知识点从他排的第几种起步不同，几条下来所有形式都轮得到
    assert.deepEqual(
      planQuestions(LITE, ['mcq', 'cloze', 'order'], 3, 'seq', Math.random, 2).map((s) => s.type),
      ['order', 'mcq', 'cloze']
    )
    // ★ M-027 原来靠档位链隐含保证，现在是显式判据：最近三道要跨到几种
    assert.equal(CROSS_TYPE_WINDOW, 3)
    assert.equal(crossesEnoughTypes(['a', 'b', 'c'], 6), true)
    assert.equal(crossesEnoughTypes(['a', 'a', 'b'], 6), false)
    assert.equal(crossesEnoughTypes(['a', 'b'], 6), true, '还没攒够一个窗口，谈不上违反')
    // ★ 「不兜底」的延续：他只勾了 2 种就跨不了 3 种 —— 那是他的选择，不是软件失职
    assert.equal(crossesEnoughTypes(['a', 'b', 'a'], 2), true)

    const ROWS = [{ type: 'mcq' }, { type: 'mcq' }, { type: 'mcq' }, { type: 'order' }]
    const q = fitQuota(ROWS, [
      { seq: 0, type: 'mcq' }, { seq: 1, type: 'mcq' }, { seq: 2, type: 'order' }
    ])
    assert.deepEqual({ kept: q.kept.length, dropped: q.dropped.length }, { kept: 3, dropped: 1 })
    // ★ D-478：收的是**最近这几道的题型**（新的在后），不再只看上一道 —— M-027 的显式判据
    assert.deepEqual(J(preferDifferent([{ type: 'x' }, { type: 'y' }], ['x'])), { type: 'y' })
    assert.deepEqual(J(preferDifferent([{ type: 'x' }, { type: 'y' }], ['y', 'x'])), { type: 'y' },
      '窗口里两种都出现过 → 退到「至少不等于上一道」（上一道是 x，所以给 y）')
    assert.deepEqual(J(preferDifferent([{ type: 'x' }], ['x'])), { type: 'x' },
      '他只勾了一种就只能是这一种 —— 不兜底、不偷偷补一种')
    assert.equal(preferDifferent([], ['x']), null)
  })

  it('P-10 · 今日半数规则：整取不截断 · 剩额 ≥ 一半才收 · 停就是停（daily-match.test 12-49 行 / D-027）', () => {
    const L = (lectureId: number, dueAt: number, pending: number) => ({ lectureId, dueAt, pending })
    const brief = (r: { picked: { lectureId: number }[]; total: number }) =>
      ({ ids: r.picked.map((p) => p.lectureId), total: r.total })
    // 20+19=39 超过目标 35 是预期行为（整取）
    assert.deepEqual(brief(matchToday(35, [L(1, 1, 20), L(2, 2, 19)])), { ids: [1, 2], total: 39 })
    // 剩余额度不到下一讲的一半 → 停
    assert.deepEqual(brief(matchToday(20, [L(1, 1, 20), L(2, 2, 30)])), { ids: [1], total: 20 })
    // 剩 15 = 30 的一半，判据是 ≥ → 收下
    assert.deepEqual(brief(matchToday(35, [L(1, 1, 20), L(2, 2, 30)])), { ids: [1, 2], total: 50 })
    // 停就是停，不跳过大的去凑后面小的（D-027 原文「否则停止」）
    assert.deepEqual(brief(matchToday(20, [L(1, 1, 10), L(2, 2, 30), L(3, 3, 4)])), { ids: [1], total: 10 })
    // 待练 0 条的讲次直接跳过（I-025）
    assert.deepEqual(brief(matchToday(20, [L(1, 1, 0), L(2, 2, 5)])), { ids: [2], total: 5 })
    // ★ reason 是要上屏的（D-356：todayPlan.reason 是机制透明）—— 钉一句
    assert.equal(
      matchToday(20, [L(1, 1, 20), L(2, 2, 30)]).reason,
      '凑到 20 条（目标 20）。下一个到期的还差 30 条，只剩 0 条额度、不到它的一半，所以停在这里 —— lecture 永远整取，不截断'
    )
  })

  it('P-11 · 开始学习的排期：重新分析不是一次测验（start-learning.test 21-52 行）', () => {
    const DAY = 86400000
    const NOW = 1700000000000
    const first = scheduleOnStart({ interval: 0, dueAt: null, fresh: 3, now: NOW })
    assert.deepEqual(
      { i: first.interval, due: first.dueAt, ft: first.firstTime },
      { i: 1, due: 1700028000000, ft: true } // ★ 明天 = 对齐日界，不是 NOW+86400000
    )
    // 12 天历史 + 原排期没到 → 一个字不动；就算新增 3 条也不动（F-2-② 的病）
    for (const fresh of [0, 3]) {
      const s = scheduleOnStart({ interval: 12, dueAt: NOW + 5 * DAY, fresh, now: NOW })
      assert.deepEqual({ i: s.interval, due: s.dueAt, ft: s.firstTime }, { i: 12, due: NOW + 5 * DAY, ft: false })
    }
    // ★ fresh 那条路真的走到了 —— 文案要说「3 条新知识点现在就能认读」而排期不动
    assert.equal(
      scheduleOnStart({ interval: 12, dueAt: NOW + 5 * DAY, fresh: 3, now: NOW }).reason,
      '3 条新知识点现在就能认读 —— 这个 Lecture 的间隔保持 12 天，产出练习仍按原排期'
    )
    // 原排期已过 → 不许推迟，今天就该练（排期保持在过去）
    const od = scheduleOnStart({ interval: 12, dueAt: NOW - 2 * DAY, fresh: 0, now: NOW })
    assert.deepEqual({ i: od.interval, due: od.dueAt }, { i: 12, due: NOW - 2 * DAY })
    assert.equal(od.reason, '没有新知识点进来 —— 间隔保持 12 天，这个 Lecture 已经到期，现在就能练')
  })

  it('P-12 · 静默：productionApplies 唯一定义 + 两线判据 + 向上滚算（silence.test 20-52 行）', () => {
    // layer=B 且 kind≠sentence 才有产出线（2026-08-16 裁决，全项目唯一定义）
    assert.deepEqual(
      [
        productionApplies({ layer: 'B', kind: 'chunk' }),
        productionApplies({ layer: 'A', kind: 'chunk' }),
        productionApplies({ layer: 'B', kind: 'sentence' })
      ],
      [true, false, false]
    )
    const item = (production: ItemLines['production'], readingSilent: boolean, pa: boolean): ItemLines =>
      ({ production, productionApplies: pa, readingSilent })
    // 主动词汇只看产出线；被动词汇只看认读线（D-023）
    assert.equal(isItemSilent(item('silent', false, true)), true)
    assert.equal(isItemSilent(item('training', true, true)), false)
    assert.equal(isItemSilent(item('new', true, false)), true)
    assert.equal(isItemSilent(item('new', false, false)), false)
    // 产出线静默 → 认读卡一并退役（D-135）
    assert.equal(shouldRetireReadingCard(item('silent', false, true)), true)
    assert.equal(shouldRetireReadingCard(item('training', false, true)), false)
    assert.equal(shouldRetireReadingCard(item('new', false, false)), false)
    /**
     * 滚算：全都不用再练才算完成，空容器不算。
     * ★ D-485：core 这三句的措辞跟着换了词（「静默」退役）——
     *   这里钉的是**逐字**，所以它当场红了一次，正是它该干的事。
     */
    assert.deepEqual(J(rollupLecture([true, true])), {
      silent: true, total: 2, silentCount: 2, ratio: 1, reason: '2 条都不用再练 —— lecture完成'
    })
    assert.equal(rollupLecture([true, false]).silent, false)
    assert.equal(rollupLecture([]).silent, false)
    assert.equal(rollupProject([true, true]).reason, '2 条都不用再练 —— 项目完成')
  })

  it('P-13 · 偏好：29 项白名单逐字（USER/DEVICE 边界的判据本体 · prefs.ts）', () => {
    /**
     * ★★ 这条用例 2026-09-01 抓到过一次真事：加 Prompt 覆盖时它当场红了 ——
     *   **动这份名单就是动 USER/DEVICE 边界**，本来就该有人拦一下。
     *
     * ★★★ **这条差点漏掉过一次，教训比改动本身值钱**：Android 用的 core 是
     *   `nyx-core` 指针**锁住的那一份**，不是 Windows 那边正在改的工作分支。
     *   所以 Windows 改完、指针还没提之前，**这里照样全绿** —— 绿的是旧 core。
     *   跨端改动要么等指针提上去再验，要么逐文件比对两份 core 的差异。
     *
     * ── 22 → **19**（D-466 · 2026-09-07 · core `c5cf2a2`）────────
     *
     * 语音那一段从八把收成四把：两把开关 + 口音 + 语速。
     * 退役（**只读不删**，D-216）：`tts.sources` · `tts.sourcesEditedAt` ·
     * `tts.sourcesMigratedAt` · `tts.provider.<id>.voice` 两把
     * （更早退役的 `tts.cloud` · `tts.model` · `tts.voice` 本来就不在名单里）。
     * 库里已有的那几行不动，`checkPrefKey` 从此拒写；**没有回填** ——
     * 旧值里没有任何一个字对得上新的两把开关。
     */
    assert.deepEqual(J(PREF_KEYS), [
      'qtypes', 'practice_order',
      'param.silenceStreak', 'param.hardTrigger', 'param.graceAttempts',
      'param.minSample', 'param.readingSilenceDays', 'param.dailyTarget', 'param.readingDailyCap',
      /**
       * ★★ 19 → **20**（D-478 · 2026-09-08 · core `7862ea3`）：档位取消之后，
       *   「一次给一条出几道」由他自己定（使用者原话：「一次性出几道可以自己设定，
       *   弄到设置里面自己设定」）。归 **USER** ——「我一次要练几道」是他想要的，
       *   不是这台机器怎么实现，换台设备该自动恢复。
       * ★ 手机没有练习设置页（TM-21），这个值**靠同步跟着电脑走**；
       *   出厂值与上下限在 core 一处（`qtype-plan.ts`），两端同一份。
       */
      'param.questionsPerItem',
      /**
       * ★★ 20 → 22 → **21**（D-479 · core `84007a0` 加两把 · core `bec53da` 退回一把）。
       *
       *   `reading.faces`  他勾了哪几面（有序 · 每面一个开关）—— **USER**
       *
       * ★ `reading.faces` 归 USER：「认读要考我哪几种」是他想要的东西，换台设备该自动恢复；
       *   而且**两端同一张卡必须考法一致**（D-474）—— 只存一端的话，
       *   同一张卡在电脑上考挖空、在手机上考中译，两边都说得通、都不报错。
       * ★ 出题规则那一份仍走既有的 `prompt.reading-card`（**键没变，含义是规则正文**）。
       *
       * ★★★ **`reading.facesMigratedAt` 2026-09-09 退出这张名单**，改成 DEVICE、进 `settings`、不同步。
       *   这里原来写着「记号也跟着人走，否则第二台会重迁、拿出厂规则盖掉他改过的正文」——
       *   **那条理由是错的**，core `bec53da` 记着为什么：
       *     「2026-09-08 它在这份白名单里待过一天，`smoke:sync` 的 S7 当场红：
       *      这一行是『第一次读认读状态就无条件写一次』，而偏好行的 uid 由键名算出来 ——
       *      两台机器算出同一个 uid、各写各的时间戳 = 必然冲突。」
       *   → 输掉那版按 D-438 进 `ops_log` → `sync.applied` 溢出后重放老包再判一次，
       *   而**重放改变了状态**。
       *   「各迁各的」之所以安全：迁移**认内容**，迁完之后正文不再像旧那份整段提示词，
       *   第二台跑一次就认不出来 → 一个字不动。
       *   ★ Android 侧同轮跟上（`db/lookup.ts`），并给旧值留了一次性接管
       *     —— 他真库里那一行早就写下了，不接管就会在真库上白跑一次迁移。
       */
      'reading.faces',
      /**
       * ★★ D-466 的两把开关（使用者 2026-09-07「语音设置简化」）。
       *
       * 为什么是 USER 而不是 DEVICE：「我要不要词典音 / 系统音」是**他想要的东西**，
       * 换一台设备该自动恢复；「这台机器上有没有词典层 / 系统 TTS 起没起」才是设备事实，
       * 那个在 core 里叫 `availability`，**压根不进偏好**。
       * ★ 顺序不在这里 —— D-466 之后顺序写死（词典 → 系统），库里只存「这一档要不要」。
       */
      'tts.dictionary', 'tts.system',
      'tts.accent', 'tts.rate',
      /**
       * ★★ 出题规则七把（D-482 · 2026-09-15）—— 理解层三 + 写作层四。
       *   进 USER 是使用者裁的：「出的题该跟着人走」，换台设备不该重设一遍。
       *   ★ 同一天**退**了一把：`prompt.reading-card` 从 `OVERRIDABLE_PROMPTS` 摘掉
       *     （退役的是输入方式，正文留在库里只读可看），所以 21 → 27 不是 21 + 7。
       */
      'reading.facePick', 'reading.hintLevel', 'reading.shiftContext',
      'practice.hintLevel', 'practice.contextSpread',
      'practice.requireFullSentence', 'practice.matchRegister',
      /**
       * ★★ 27 → **29**（D-486 · 2026-09-15 · 使用者「确认单按推荐」）：三层真补齐 ——
       *   产出多出「牌面」这一层、认读多出「题型」这一层。
       *   `practice.face`  整块 / 分栏 / 专注（出厂 plain）
       *   `reading.qtype`  翻卡自评 / 先写再翻 / 限时认读（出厂 flip）
       *
       * ★ 两把都归 USER：「我要怎么被考 / 题目怎么摆在我面前」是他想要的东西，
       *   换台设备该自动恢复 —— 和另外七把同一条判据（`core/prefs.ts` 开头那句问法）。
       * ★ 不需要迁移、不需要记号：没设过就读出厂值，认不出的值也回出厂（绝不抛）。
       * ★★ **数字以 `PREF_KEYS.length` 实跑为准，不许照抄文档**（C 合过来的那半）——
       *   上一张派单的「29」就是照抄来的，而那次真数是 27。
       */
      'practice.face', 'reading.qtype',
      'ai.split', 'dict.default',
      'prompt.generate-questions', 'prompt.score-answer',
      // ★ ⑥ · Lookup 的 AI 搜索。它**只有手机有**（Windows 没这个功能），
      //   但仍然进这张同步表 —— 他写的提示词该跟着人走，
      //   和 dict.default 是同一个道理（那本词典电脑上也可能没有）。
      'prompt.lookup-search'
    ],
      '★★ 偏好白名单对不上。**先看是不是指针的事**：Windows 那边改了 core、' +
      '而本仓 `nyx-core` 指针还停在旧的 SHA —— 那样这里读到的是旧名单，' +
      '提了指针就绿。★ 指针已经是新的还红，那才是真的动了 USER/DEVICE 边界，要有人交代为什么。')
    assert.deepEqual(J(prefSpecOf('param.dailyTarget')), {
      key: 'param.dailyTarget', kind: 'number', says: '今日练习默认条数'
    })
    // 密钥判据（D-220：key 永不上云的第一道闸）
    // ★ D-466 · 第三个换成今天活着的那把开关（`tts.provider.<id>.voice` 已退役）——
    //   钉的是同一件事：判据宽到会误伤，但**不许**把一把真 key 判成偏好
    assert.deepEqual(
      [
        looksLikeSecret('sync.secret'),
        looksLikeSecret('ai.key'),
        looksLikeSecret('tts.dictionary')
      ],
      [true, true, false]
    )
    assert.equal(checkPrefKey('param.dailyTarget').ok, true)
    assert.equal(checkPrefKey('sync.device').ok, false) // DEVICE 项不许混进 USER 偏好
    assert.equal(checkPrefKey(42).ok, false)
    assert.deepEqual(J(checkPrefValue('param.dailyTarget', 35)), { ok: true, value: '35' })
    assert.equal(checkPrefValue('param.dailyTarget', 'many').ok, false)
    assert.equal(prefUid('param.dailyTarget'), 'user_preferences-nat-param.dailyTarget')
  })

  it('P-14 · 材料：断句摘句 · 分段 · 切块（quote / paragraphs / chunk-text.test）', () => {
    const TEXT = 'Mr. Smith held sway over the town. He slept well! Nobody knew why.'
    // Mr. 不当句号（缩写保护）
    assert.deepEqual(sentences(TEXT), [
      'Mr. Smith held sway over the town.', 'He slept well!', 'Nobody knew why.'
    ])
    assert.equal(findQuote(TEXT, 'slept well'), 'He slept well!')
    // ★ 词形变了也找得到：hold sway over → held sway over
    assert.equal(findQuote(TEXT, 'hold sway over'), 'Mr. Smith held sway over the town.')
    // ★ 找不到返回 null —— 宁可没有出处，也不要一个错的
    assert.equal(findQuote(TEXT, 'take root'), null)
    assert.equal(findQuote('', 'x'), null)
    assert.equal(findQuoteIn(['no hit here.', TEXT], 'slept well'), 'He slept well!')
    assert.deepEqual(paragraphs('  first para\n\nsecond\n\n\n  third  '), ['first para', 'second', 'third'])
    assert.equal(CHUNK_LIMIT, 6000)
    assert.deepEqual([chunkCount(6000), chunkCount(6001)], [1, 2])
    assert.deepEqual(chunkText('hello world'), ['hello world'])
    assert.deepEqual(chunkText('   \n\n  '), [])
  })

  /**
   * ★ 这一条比上面几条多走一步：它要一个真库。
   *   放在这个文件里是因为钉的正是这个文件的题目 —— **同一件事只有一把尺**：
   *   「移出这一讲」的动作判据在 core（`move-items.ts`：软删，不删行），
   *   而「Nyx 里有没有它、挂在哪一讲」的读法判据在 `capture.ts::assistStatus`。
   *   两者一旦读法不一致，屏幕上就会出现「已经移走了却还写着那一讲」。
   *   T-6.1（R-004）之前，原生 Java 自己那句 SELECT 正是这么错的。
   */
  it('P-15 · 收录关系软删（V36 / D-436③）：移出一讲之后 L0 不再报那一讲（T-6.1 / R-004）', async () => {
    const f = builtDb()
    seed(f)
    const t = 1_756_000_000_000

    // 收进讲 1（is_owner = 1，认读卡由触发器建）—— 「在库，且挂在 L」的样子
    const cap = await captureAt(f.db, 'zephyr', 'A', 1, 'com.x')
    const before = await assistStatus(f.db, 'zephyr')
    assert.equal(before.known, true)
    assert.equal(before.lectureName, 'L', '收进来那一刻，L0 报得出讲次名')

    // 「从这一讲移出去」= core 的 moveItems：把 (知识点, 原讲) 那一行**软删**
    const to = await createLecture(f.db, 1, 'L2')
    assert.deepEqual(J(await moveItems(f.db, [cap.id], 1, to, t)), { moved: 1, merged: 0, reowned: 1 })
    assert.equal(
      (await f.db.get(`select deleted_at as d from item_lectures where item_id = ? and lecture_id = 1`, [
        cap.id
      ]))?.['d'],
      t,
      '软删，不是删行（删行不立墓碑，「移出」这一半到不了另一台 —— D-436③）'
    )

    // ★★ 判据只有这一份。移出之后：条目本身没删，但**不许再报那一讲**
    const moved = await assistStatus(f.db, 'zephyr')
    assert.equal(moved.known, true, 'items 没软删 —— 它还在 Atlas 里')
    assert.equal(moved.lectureName, null, '★ 已经不在 L 里了：讲次名必须消失')

    // 负向对照：漏掉 `il.deleted_at is null`（= T-6.1 之前原生那一句）会说什么 ——
    // 同一个库，它报的是**已经移出去的那一讲**。这就是被回收掉的那份判据。
    const stale = await f.db.get(
      `select (select l.name from item_lectures il join lectures l on l.id = il.lecture_id
                where il.item_id = i.id and il.is_owner = 1 limit 1) as lec
         from items i where i.id = ?`,
      [cap.id]
    )
    assert.equal(stale?.['lec'], 'L', '漏了软删过滤就会报旧讲次 —— 这条断言红了说明对照失效')
  })

  /**
   * ★ P-16 · 单条完整解析的**写入计划**（T-5.12 / D-R22）
   *
   * D-R22 之后手机也做单条解析。`planWrites` 里压着六条互相咬合的规矩，
   * 每一条写歪的后果都是**静默的** —— 他手改的段落被盖掉、例句里没了词典来源、
   * 或者两台机器对同一条知识点写出不一样的解析，而两边都不报错。
   * 所以这里给同一份「假 AI 输出」，把计划钉成字面量：
   * **它红了只有一个含义 —— core 的写入判据变了**，两端立刻知道。
   */
  it('P-16 · 解析写入计划：edited 跳过 · 例句先词典 · 释义回写 · 空块丢弃 · regen 累加（analysis/plan.ts）', () => {
    const ai = {
      gloss: '  to ease something  ',
      glossZh: '缓解',
      meaning: 'the meaning',
      chunks: ['a', 'b'],
      examples: [{ text: 'AI made this one.' }],
      empty: '   ',
      emptyArr: [],
      nothing: null,
      weird: 'not a rendered block'
    }
    const existing = [
      { block: 'meaning', edited: 1, regenCount: 2 }, // 他手改过 —— 一个字不动
      { block: 'chunks', edited: 0, regenCount: 3 }, // 重来一次 → 4
      { block: 'weird', edited: 0, regenCount: 0 }
    ]
    const dict = [{ text: 'A published sentence.', from: '朗文6' }]

    assert.deepEqual(J(planWrites(ai, existing, dict)), {
      blocks: [
        // ★ D-149 · meaning 不在这里 —— 手改过的跳过
        { block: 'chunks', content: '["a","b"]', regen: 4 },
        // ★ D-150 · 词典的排前面（出版过的真句子），AI 补的排后面
        {
          block: 'examples',
          content: JSON.stringify([
            { text: 'A published sentence.', source: 'dict', note: '朗文6' },
            { text: 'AI made this one.' }
          ]),
          regen: 0
        },
        // ★ 空的（'   ' / [] / null）一块都不写
        { block: 'weird', content: 'not a rendered block', regen: 1 }
      ],
      // ★ R-002 · 释义回写到条目上，且首尾空白已经剪掉
      gloss: [
        { column: 'gloss', value: 'to ease something' },
        { column: 'gloss_zh', value: '缓解' }
      ],
      written: 3,
      // ★ I-112 · 详情页认得的：chunks · examples · 两条释义 = 4（weird 不算）
      shown: 4,
      keys: ['gloss', 'glossZh', 'meaning', 'chunks', 'examples', 'empty', 'emptyArr', 'nothing', 'weird']
    })

    // 没有词典例句时不走合并那一支 —— 「没放词典也照常能用」（Android 今天就是这条）
    const noDict = planWrites({ examples: [{ text: 'only ai' }] }, [], [])
    assert.deepEqual(J(noDict.blocks), [
      { block: 'examples', content: JSON.stringify([{ text: 'only ai' }]), regen: 0 }
    ])
  })
  /**
   * ★★ P-19 · 查重：**同一份夹具，两端得出同一个判断**（T-9.13 · D-478②）
   *
   * 这一条钉的不是「合并写得对不对」（那在 `tests/merge.test.ts`），
   * 而是**这一端把库里的行读成判据要的形状时没有走样**：
   * 同样五条知识点，直接喂给 core 的 `scanDuplicates`、与经过
   * `db/merge.ts::dedupScan` 从真库里读出来再喂进去，**必须分出同样的组、
   * 同样的档、同样的主记录**。
   *
   * 走样的症状不是报错，是**两端各并各的**：电脑那边说「这两条能安全合」，
   * 手机这边说「需要你看」（或者反过来自动并掉了一条他想留的）。
   * 夹具里那三种情形分别对着判据的三条：同层无冲突 → Safe；跨层 → Review；
   * 被并那条有学习史 → Review。
   */
  it('P-19 · 查重：同一份夹具，core 直算与 dedupScan 从库里读出来的判断逐字相同', async () => {
    const f = builtDb()
    seed(f, { items: 0, logsPerItem: 0 })
    const t = 1_700_000_000_000
    const q = (sql: string, ...p: unknown[]): void => {
      f.raw.prepare(sql).run(...(p as never[]))
    }
    /** 五条：safe 一组（1,2）· 跨层一组（3,4）· 有学习史一组（5,6） */
    const rows: [number, string, string, string, number][] = [
      [1, 'bear the brunt', '', 'B', t],
      [2, 'Bear the Brunt.', '首当其冲', 'B', t + 1],
      [3, 'take a toll', '', 'A', t + 2],
      [4, 'take a toll', '', 'B', t + 3],
      [5, 'on the fence', '', 'B', t + 4],
      [6, 'on the fence', '', 'B', t + 5]
    ]
    for (const [id, term, gloss, layer, createdAt] of rows) {
      q(
        `insert into items (id,term,gloss,layer,kind,source,created_at,updated_at)
         values (?,?,?,?,'chunk','self',?,?)`,
        id, term, gloss, layer, createdAt, createdAt
      )
      q(`insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,1,?,?)`, id, t, t)
    }
    /**
     * ★ 「被并那条有学习史」这一档要**两条都有作答**才造得出来：
     *   选主取学习史最多者，所以史多的那条必然是 canonical；
     *   要让 loser 的史 > 0，就得让它也有，只是比 canonical 少。
     *   （5 两次、6 一次 → 主是 5，被并的 6 带着一次作答 → Review。）
     */
    const answer = (itemId: number, n: number): void => {
      for (let k = 0; k < n; k++) {
        q(
          `insert into answers (item_id,text,grade,created_at,updated_at) values (?,'我的作答',3,?,?)`,
          itemId, t + k, t + k
        )
      }
    }
    answer(5, 2)
    answer(6, 1)

    // ① 这一端从真库里读出来算的
    const mine = await dedupScan(f.db, 1)

    // ② core 直接算的（同样六条，形状照 `DedupItem` 手写 —— 不经过任何 SQL）
    const items: DedupItem[] = rows.map(([id, term, gloss, layer, createdAt]) => ({
      uid: `id:${id}`,
      term,
      gloss,
      layer,
      createdAt,
      answers: id === 5 ? 2 : id === 6 ? 1 : 0,
      reviewLogs: 0,
      blocks: []
    }))
    const theirs = scanDuplicates(items)

    assert.deepEqual(
      J(mine.groups.map((g) => ({ norm: g.norm, bucket: g.bucket, n: g.members.length }))),
      J(theirs.groups.map((g) => ({ norm: g.norm, bucket: g.bucket, n: 1 + g.losers.length }))),
      '★★ 分组 / 分档对不上 —— 这一端把库里的行读走样了，两端会各并各的'
    )
    assert.deepEqual(
      mine.groups.map((g) => g.canonicalId),
      theirs.groups.map((g) => Number(g.canonical.replace('id:', ''))),
      '★ 主记录也要是同一条：两台设备选出不同的主记录，合出来的东西就对不上'
    )
    assert.deepEqual(
      [mine.affected, mine.safe, mine.review],
      [theirs.affected, theirs.safe, theirs.review]
    )
    // 夹具本身要真的覆盖三种情形（不然这条用例可能在「三组全 safe」上绿着什么都没验）
    assert.deepEqual(
      mine.groups.map((g) => `${g.norm}:${g.bucket}`),
      ['bear the brunt:safe', 'on the fence:review', 'take a toll:review']
    )
  })
  /**
   * ★★ P-20 · 认读提示词：**同一份偏好，两端拼出同一段**（T-9.18 · D-479）
   *
   * D-479 之后提示词是两件东西拼出来的（规则 + 他勾的那几面）。
   * 拼装如果在两端各写一遍，症状不是报错，是**同一张卡在电脑上考挖空、
   * 在手机上考中译** —— 而两边都说得通、都不报错（D-474：功能与数据两端必须一致）。
   *
   * 所以这一条钉的是：这一端从库里读出偏好之后交出去的那两段，
   * 与 core 的 `buildReadingPrompt` 拿同样的输入算出来的**逐字相同**。
   * ★ 弄红它的办法只有一个：手机自己拼提示词（不走 core）。
   */
  it('P-20 · 认读提示词：同一份偏好 → 与 core 的 buildReadingPrompt 逐字相同', async () => {
    const f = builtDb()
    /**
     * ★★ 2026-09-15（D-482）起收的是**三个选项**，不再是 `prompt.reading-card` 那段正文
     *   （那把键已经从 `OVERRIDABLE_PROMPTS` 摘掉，写它会被 `prefSet` 当场拦下来）。
     */
    await prefSet(f.db, QUIZ_RULE_KEYS.facePick, 'random')
    await prefSet(f.db, QUIZ_RULE_KEYS.readingHint, 'less')
    await prefSet(f.db, QUIZ_RULE_KEYS.shiftContext, '1')
    // 只勾两面（挖空 + 英文释义）—— 勾选是有序的，顺序也要一致
    await prefSet(
      f.db,
      'reading.faces',
      serializeFacePrefs(READING_FACES.map((x) => ({ id: x.id, on: x.id === 'cloze' || x.id === 'define' })))
    )

    const mine = await readingPromptFor(f.db, 'bear the brunt', '首当其冲', 'She bore the brunt of it.', null)
    const theirs = buildReadingPrompt(
      { facePick: 'random', hintLevel: 'less', shiftContext: true },
      ['cloze', 'define'],
      'bear the brunt',
      '首当其冲',
      'She bore the brunt of it.',
      // ★ 第 6 参「上次用了哪一面」2026-09-15 起必填；用例里没有历史，给 null
      null
    )
    assert.deepEqual(mine, theirs, '★★ 这一端自己拼了提示词 —— 两端会各考各的')
    // 夹具要真的覆盖「三个选项 + 多面」，别在一个空壳上绿着
    assert.ok(mine!.system.includes('挖空 ——'), '勾了的那一面的内容说明要在里面')
    assert.ok(mine!.system.includes('英文释义 ——'), '勾了的第二面也要在')
    assert.ok(!mine!.system.includes('中译回想 ——'), '★ 没勾的那一面不许混进来')
    /**
     * ★ 选项真的换了句子 —— 否则上面那条 deepEqual 在「两边都没拼选项」时也绿。
     *   拿出厂那一档再算一次：同样的输入、只差三个选项，两段必须不一样。
     */
    const factory = buildReadingPrompt(
      READING_RULES_FACTORY,
      ['cloze', 'define'],
      'bear the brunt',
      '首当其冲',
      'She bore the brunt of it.',
      // ★ 第 6 参「上次用了哪一面」2026-09-15 起必填；用例里没有历史，给 null
      null
    )
    assert.notDeepEqual(mine, factory, '★★ 三个选项没进拼装 —— 改了等于没改')

    // 一把键都没设过 → 出厂三档（默认值也只有 core 那一份）
    const g = builtDb()
    const plain = await readingPromptFor(g.db, 'x', null, null, null)
    assert.deepEqual(
      plain,
      buildReadingPrompt(
        READING_RULES_FACTORY,
        ['cloze', 'scenario', 'zh-recall', 'define'],
        'x',
        null,
        null,
        null
      ),
      '★ 没设过就该按出厂三档 + 出厂四面拼'
    )
  })
})
