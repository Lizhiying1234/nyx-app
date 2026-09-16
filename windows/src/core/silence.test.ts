import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PRODUCTION_STATE_NAMES } from './types.ts'
import {
  ROTATION_WORDS,
  SILENCE_ACTIONS,
  SILENCE_FILTER_NAME,
  rollupKinds,
  silenceKind,
  silenceScopeAction,
  isItemSilent,
  isRowSilent,
  rollupLecture,
  rollupProject,
  rollupUnit,
  shouldRetireReadingCard,
  type ItemLines
} from './silence.ts'

const active = (o: Partial<ItemLines> = {}): ItemLines => ({
  production: 'training',
  productionApplies: true,
  readingSilent: false,
  ...o
})

describe('整条静默看哪条线（M-003 / D-135）', () => {
  it('主动词汇：只看产出线 —— 写得出来自然认得出', () => {
    assert.equal(isItemSilent(active({ production: 'silent', readingSilent: false })), true)
    assert.equal(isItemSilent(active({ production: 'training', readingSilent: true })), false)
  })

  it('被动词汇：只跑认读线，看认读线（D-023）', () => {
    const passive = (readingSilent: boolean): ItemLines => ({
      production: 'new',
      productionApplies: false,
      readingSilent
    })
    assert.equal(isItemSilent(passive(true)), true)
    assert.equal(isItemSilent(passive(false)), false)
  })

  it('产出线静默后，认读卡一并退役（D-135）', () => {
    assert.equal(shouldRetireReadingCard(active({ production: 'silent' })), true)
    assert.equal(shouldRetireReadingCard(active({ production: 'training' })), false)
    assert.equal(
      shouldRetireReadingCard({ production: 'new', productionApplies: false, readingSilent: true }),
      false,
      '被动词汇没有产出线，不该走这条退役规则'
    )
  })
})

describe('★★★ I-204 · 一行原始字段判静默：只许走 `isRowSilent`，不许自己写「或」', () => {
  /**
   * ══ 真事 ═══════════════════════════════════════════════
   * 四处调用方（`main/db/repo.ts` · `Workbench.svelte` · `Search.svelte` · `ItemDetail.svelte`）
   * 各自把 `productionState` 和 `cardSilent` 拼成了 **`a === 'silent' || b`**。
   * 那是**上一轮已经退役的口径**（`core/sql/silence.ts` 头注：修这一轮之前 SQL 里就是
   * `production_state='silent' or card_silent=1`，而领域判据说的是「B 层只看产出线」）。
   *
   * 「或」比条件式**严格更宽**，所以错的方向只有一个，而且总是同一个：
   * **界面把条目藏起来了，而引擎照样把它排进练习。**
   *
   * ★ 他真库上当时对拍是 0 分歧（两条静默位永远一起设），但**同步能造出分叉** ——
   *   `items` 与 `reading_cards` 是两张表、两个包、到达有先后。
   *
   * ══ 下面第一条就是那个分叉 ═══════════════════════════════
   */
  const row = (o: Partial<Parameters<typeof isRowSilent>[0]>): Parameters<typeof isRowSilent>[0] => ({
    layer: 'B',
    kind: 'chunk',
    productionState: 'training',
    cardSilent: false,
    ...o
  })

  it('★★★ B 层 · 认读卡静默了、产出线还在训练 → **不算静默**（「或」会答成算）', () => {
    const r = row({ layer: 'B', kind: 'chunk', productionState: 'training', cardSilent: true })
    assert.equal(
      isRowSilent(r),
      false,
      '★★★ 跑产出线的只看产出线。答成 true 就是旧的「或」—— ' +
        '界面会把它藏起来，而产出练习照样发它'
    )
    // 旧写法在这一格上会答错，这条用例的全部意义就在这里
    assert.equal(r.productionState === 'silent' || r.cardSilent, true, '（旧「或」写法在这一格答 true）')
  })

  it('★★ B 层 · 产出线静默 → 算静默（不管认读卡）', () => {
    assert.equal(isRowSilent(row({ productionState: 'silent', cardSilent: false })), true)
    assert.equal(isRowSilent(row({ productionState: 'silent', cardSilent: true })), true)
  })

  it('★★★ A 层 · 产出线那一格再怎么写都不算数，只看认读卡', () => {
    assert.equal(
      isRowSilent(row({ layer: 'A', productionState: 'silent', cardSilent: false })),
      false,
      '★★★ 被动词汇不跑产出线（D-023），它的 production_state 是**没有意义的历史值**；' +
        '「或」会因为这一格把它判成静默并藏起来'
    )
    assert.equal(isRowSilent(row({ layer: 'A', productionState: 'training', cardSilent: true })), true)
  })

  it('★★ 整句（`kind: sentence`）和 A 层同款 —— 只看认读卡', () => {
    assert.equal(isRowSilent(row({ layer: 'B', kind: 'sentence', productionState: 'silent', cardSilent: false })), false)
    assert.equal(isRowSilent(row({ layer: 'B', kind: 'sentence', productionState: 'training', cardSilent: true })), true)
  })

  it('★★ 和 `isItemSilent` 逐格同答 —— 它只是同一份判据的取字段外壳', () => {
    for (const layer of ['A', 'B']) {
      for (const kind of ['chunk', 'sentence']) {
        for (const productionState of ['new', 'training', 'hard', 'silent'] as const) {
          for (const cardSilent of [true, false]) {
            const r = row({ layer, kind, productionState, cardSilent })
            const viaLines: ItemLines = {
              productionApplies: layer === 'B' && kind !== 'sentence',
              production: productionState,
              readingSilent: cardSilent
            }
            assert.equal(
              isRowSilent(r),
              isItemSilent(viaLines),
              `★★ 两者在 ${layer}/${kind}/${productionState}/${cardSilent} 上答得不一样 —— ` +
                '那说明 isRowSilent 自己又长出了一份判据'
            )
          }
        }
      }
    }
  })
})

describe('三级升级（D-080 / D-029）', () => {
  it('lecture 内条目全部静默 → lecture 静默', () => {
    assert.equal(rollupLecture([true, true, true]).silent, true)
    assert.equal(rollupLecture([true, true, false]).silent, false)
  })

  it('往上滚：lecture → 单元 → 项目', () => {
    assert.equal(rollupUnit([true, true]).silent, true)
    assert.equal(rollupProject([true, false]).silent, false)
  })

  it('★ 空容器不算静默 —— 一个还没放东西的 lecture 说「已完成」是荒谬的', () => {
    const r = rollupLecture([])
    assert.equal(r.silent, false)
    assert.match(r.reason, /空的/)
    assert.equal(rollupUnit([]).silent, false)
  })
})

describe('静默比例 · 项目页进度条（D-176）', () => {
  it('给得出比例和人话', () => {
    const r = rollupLecture([true, true, true, false, false])
    assert.equal(r.silentCount, 3)
    assert.equal(r.total, 5)
    assert.equal(r.ratio, 0.6)
    assert.match(r.reason, /不用再练 3\/5（60%）/)
  })

  it('空容器的比例是 0，不是 NaN', () => {
    assert.equal(rollupLecture([]).ratio, 0)
  })
})

/**
 * ══ 已练成 / 收起来（D-485 · 2026-09-15）═══════════════════════
 *
 * 使用者说「静默」这个概念本身有理解问题 —— 查下来他是对的：
 * 一个词底下是两件相反的事（练成了 / 先不练了），而且它们落在同一个状态，
 * 于是**把不想练的收起来会让进度变好看**。这一组钉的就是那条分界。
 *
 * ★ 负向对照（做过）：`rollupKinds` 里把 `'shelved'` 也算进 `earned` →
 *   下面「收起来的不算进度」当场红。
 */
describe('★★★ D-485 · 练成的和收起来的分得开', () => {
  it('★★★ ① 自动那条路标 earned', () => {
    assert.equal(silenceKind('earned'), 'earned')
  })

  it('★★★ ② 他自己点的、和被上级带下去的，都是「收起来」', () => {
    for (const by of ['self', 'lecture', 'unit', 'project']) {
      assert.equal(silenceKind(by), 'shelved', `★ ${by} 该算收起来`)
    }
  })

  it('★★ ③ 老数据（没标过的）= unknown', () => {
    assert.equal(silenceKind(null), 'unknown')
    assert.equal(silenceKind(undefined), 'unknown')
    assert.equal(silenceKind(''), 'unknown')
  })

  /**
   * ★★★ ④ **同一件事只许有一个名字**（2026-09-15 · D-489 换掉了原来那条）
   *
   * 原来这一条钉的是 `silenceLabel()`：「练成的叫『已练成』，收起来的叫『收起来了』」。
   * 使用者这一轮把那两个说法整族退役了，`silenceLabel()` 也跟着删（从生成名单摘，
   * 不是把控件藏起来）。换上来的是这一条 —— 它钉的是**这一轮真正要守住的东西**：
   *
   *   产出线的终点（`PRODUCTION_STATE_NAMES.silent`）· Vault 那个预设（`SILENCE_FILTER_NAME`）
   *   · 4×4 矩阵两条轴的终点 —— **说的是同一件事，所以必须是同一个字**。
   *
   * ★ 这三处以前各写各的字面量。谁改了其中一处，屏上就会出现两个名字指同一件事，
   *   而**没有任何东西会报错** —— 他只会觉得「这个软件前后不一致」，说不出哪里不对。
   */
  it('★★★ ④ 终点那一档、Vault 那个预设、矩阵两条轴 —— 同一个字', () => {
    assert.equal(
      PRODUCTION_STATE_NAMES.silent,
      SILENCE_FILTER_NAME,
      '★★★ 产出线终点和 Vault 那个预设不是同一个字 —— 同一件事在屏上有了两个名字'
    )
  })

  it('★★ ⑤ 动作只有「静默 / 恢复」两个，全部层同一对（D-489）', () => {
    assert.equal(SILENCE_ACTIONS.shelve, '静默')
    assert.equal(SILENCE_ACTIONS.restore, '恢复')
    /**
     * ★ 容器层那一句由动作词拼出来，**不另写字面** ——
     *   「条目层一个词、容器层另一个词」正是这一轮要消掉的毛病
     *   （`Workbench.svelte` 那句手写的「收起这个 Lecture」就是它分叉的地方）。
     */
    assert.equal(silenceScopeAction(false, 'Lecture'), '静默这个 Lecture')
    assert.equal(silenceScopeAction(true, 'Lecture'), '恢复这个 Lecture')
    assert.equal(silenceScopeAction(false, '项目'), '静默这个项目')
  })

  it('★★★ ⑥ 进度只算练成的 —— **收起来的不算**（D-485，使用者明知数字会变小）', () => {
    const r = rollupKinds(['earned', 'earned', 'shelved', null, null])
    assert.equal(r.silentCount, 2, '★★ 收起来的那条被算进进度了')
    assert.equal(r.total, 5)
    assert.equal(r.ratio, 0.4, '★★★ 2/5 才对；把 shelved 算进去会变成 3/5')
  })

  it('★★★ ⑦ 老数据按练成算，不猜', () => {
    const r = rollupKinds(['unknown', 'unknown', null, null])
    assert.equal(r.silentCount, 2)
    assert.equal(r.ratio, 0.5)
  })

  it('★★★ ⑧ 「没东西要练」和「练成了多少」是两件事', () => {
    /** 全被收起来 —— 确实没东西可练（排期看这个），但一条都没练成（进度看那个）*/
    const r = rollupKinds(['shelved', 'shelved'])
    assert.equal(r.silent, true, '★ 全收起来了，这个容器确实没东西要练')
    assert.equal(r.ratio, 0, '★★★ 但一条都没练成，进度必须是 0')
  })

  it('★★ ⑨ 有收起来的时候，那句话要把两个数都说出来', () => {
    const r = rollupKinds(['earned', 'shelved', null])
    assert.match(r.reason, /练成 1\/3/)
    assert.match(
      r.reason,
      new RegExp(`1 条由你${SILENCE_ACTIONS.shelve}`),
      '★ 不说的话他会以为那一条凭空不见了'
    )
  })

  it('★★ ⑩ 空容器：比例 0，不是 NaN，也不算练完', () => {
    const r = rollupKinds([])
    assert.equal(r.ratio, 0)
    assert.equal(r.silent, false)
  })

  /**
   * ★★★ ⑪ **这一条 2026-09-15 整个反过来了**（D-489），记在这儿免得下次又翻回去。
   *
   * 它原来钉的是「屏上不许再出现『静默』这两个字」（D-485：他嫌看不懂）。
   * 使用者用下来又裁**全部层都改回「静默 / 恢复」**，所以那条断言现在是错的 ——
   * 留着它，这一轮的改动会被自己仓里的用例判红，而红的那一句说的是上一轮的裁决。
   *
   * ☞ 现在钉的是**这一轮退役的那几个**：「已练成 / 收起来 / 放回去 / 收起这个」。
   * ★ 为什么不干脆删掉这一条：一个被换掉的词**必须有人盯着**，否则它会慢慢漂回来 ——
   *   这一栏三个月里翻了三次，每一次都是「上一次退役的词没人管了」。
   */
  it('★★★ ⑪ 屏上不许再出现「已练成 / 收起来 / 放回去」（D-489）', () => {
    const shown = [
      SILENCE_FILTER_NAME,
      SILENCE_ACTIONS.shelve,
      SILENCE_ACTIONS.restore,
      silenceScopeAction(false, 'Lecture'),
      silenceScopeAction(true, 'Lecture'),
      rollupKinds(['earned', 'shelved', null]).reason,
      rollupKinds(['earned', 'earned']).reason,
      rollupKinds([]).reason
    ]
    for (const s of shown) {
      for (const bad of ['已练成', '收起来', '放回去', '收起这个']) {
        assert.ok(!s.includes(bad), `★★★ 「${s}」里还留着退役词「${bad}」（D-489）`)
      }
    }
  })
})

/**
 * ══ 屏上那几个字只有一份（D-485 补裁 · C 提，主控准）══════════
 *
 * 档名与那两个动词**两端都要说**。各端各写一遍字面量的话，
 * **一端改了另一端不会有任何东西报错** —— 和 `ONBOARDING_STEPS` 进 core 同一条理由。
 *
 * ★ 这一组**不是**「断言常量等于它自己」那种摆设：它钉的是
 *   **这三个字不许再含退役词**，以及形状（有这几个键、都不是空串）。
 *   真正让 Windows 跟着走的是**那几处真的 import 了它**（`App` / `Library` /
 *   `Search` 用档名，`Home` / `Workbench` 用那两个动词）——
 *   改了常量，屏上当场跟着变，不需要闸来提醒。
 */
describe('★★ D-485 · 屏上那几个字在 core 一份', () => {
  /**
   * ★★ 2026-09-15 这条**收窄了一处，没有整条放宽**，说清楚差别：
   *   使用者把档名裁回「静默」，所以**档名**这一栏不再拦「静默」。
   *   但「归档 / 轮转」对档名仍然拦；「静默 / 归档 / 轮转」对那两个动词**全都还拦**。
   * ★ 为什么不干脆把「静默」从这条里整个去掉：那样 `ROTATION_WORDS` 哪天被写成
   *   「静默」也没人拦 —— 而那才是真的退回去。**解禁要解在他裁的那一格上，不是整片。**
   */
  it('★★★ 退役词：动词三个都拦；档名拦「归档 / 轮转」（「静默」已由他裁回）', () => {
    for (const w of [ROTATION_WORDS.inPractice, ROTATION_WORDS.schedule]) {
      for (const bad of ['静默', '归档', '轮转']) {
        assert.ok(!w.includes(bad), `★★★ 动词「${w}」里还留着退役词「${bad}」`)
      }
    }
    for (const bad of ['归档', '轮转']) {
      assert.ok(
        !SILENCE_FILTER_NAME.includes(bad),
        `★★★ 档名「${SILENCE_FILTER_NAME}」里还留着退役词「${bad}」`
      )
    }
  })

  /**
   * ★★ 档名**中性**这条还在，理由换了一层（D-489）。
   *   原来的理由是「档里混着两件相反的事，每一行自己说是哪一种」。
   *   使用者这一轮裁**不再标是哪一种**，行上那枚小标去掉了 ——
   *   于是档名更得中性：它现在是屏上关于这一档的**唯一**一句话。
   */
  it('★★ 档名是**中性**的 —— 不许站边说成「练成」或「收起」', () => {
    assert.ok(
      !SILENCE_FILTER_NAME.includes('练成') && !SILENCE_FILTER_NAME.includes('收起'),
      `★★ 档名「${SILENCE_FILTER_NAME}」站了一边 —— 这一档里既有练成的也有你自己放一边的，` +
        '而行上已经不标是哪一种了，名字再站边就等于对着一半内容说谎'
    )
  })

  /**
   * ★★★ 这两个词**真的有屏在引它**（2026-09-15 补；原来只有一句假的注释说有）
   *
   * ══ 为什么需要这一条 ══════════════════════════════════════
   * `ROTATION_WORDS` 进 core 的理由是「两端说同一个词」。可是只要没人引它，
   * 它就只是一个**没人读的常量**：屏上照样各写各的字面，而闸全绿。
   * `silence.ts` 原来的注释声称「Windows 那几句由这份用例钉着」—— 查下来
   * 这份用例只钉了「不含退役词」和「非空」，**和屏没有任何连接**。
   *
   * ══ 钉法 ═════════════════════════════════════════════════
   * 按名点住那两处**真的在渲染它**的屏，断言源码里出现的是 `ROTATION_WORDS.x`
   * 而不是字面。谁把它改回字面量，这条当场红。
   * ★ 不去扫「屏上有没有『在练』两个字」—— 那会把「继续在练」这种普通话也算进来，
   *   而一个会误报的闸第一次误报之后就会被加白名单然后失效。
   */
  it('★★★ 这两个词真的有屏在引它（不是一个没人读的常量）', () => {
    const HERE2 = dirname(fileURLToPath(import.meta.url))
    const R = (rel: string): string =>
      readFileSync(join(HERE2, '..', 'renderer', 'src', rel), 'utf8')
    for (const [file, key] of [
      ['Home.svelte', 'ROTATION_WORDS.inPractice'],
      ['Workbench.svelte', 'ROTATION_WORDS.schedule']
    ] as const) {
      assert.ok(
        R(file).includes(key),
        `★★★ ${file} 不再引 \`${key}\` —— 要么那一屏改写成字面量了（两端从此各漂各的），` +
          ' 要么那一处真的没了。没了就把这一行从名单里拿掉，并说清屏上现在说什么'
      )
    }
  })

  it('★ 形状：三个字都在、都不是空串', () => {
    assert.ok(SILENCE_FILTER_NAME.length > 0)
    assert.ok(ROTATION_WORDS.inPractice.length > 0)
    assert.ok(ROTATION_WORDS.schedule.length > 0)
  })
})
