import { SILENCE_ACTIONS, SILENCE_FILTER_NAME } from './silence.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  GUIDE_SEEN_KEY,
  noteGuideSeen,
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  onboardingSteps,
  PAGE_GUIDES,
  parseGuideSeen,
  shouldOnboard,
  shouldShowGuide
} from './onboarding.ts'
import { DEFAULT_GRADING } from './grading.ts'

/**
 * 首次引导的判据（SC-25 · D-483）
 *
 * ★ 负向对照（做过）：把 `shouldOnboard` 改成恒 `false`（= 启动那条路永远不出引导）
 *   → 下面 ①②⑤ 三条红；改成恒 `true`（= 写了 doneAt 也照样出）→ ③④ 红。
 *   两个方向都验过，因为这条判据的两种坏法长得完全不一样：
 *   「永远不出」是功能没了，「永远出」是每次启动都被挡一次。
 */
describe('★★★ SC-25 · 要不要出首次引导', () => {
  it('★★★ ① 没设过（空串 —— `ui:get` 读不出来时给的就是它）→ 出', () => {
    assert.equal(shouldOnboard(''), true)
  })

  it('★★ ② null / undefined 也当没看过 → 出', () => {
    assert.equal(shouldOnboard(null), true)
    assert.equal(shouldOnboard(undefined), true)
  })

  it('★★★ ③ 有时间戳 → 不出（看完 / 跳过之后，再启动不许再来一遍）', () => {
    assert.equal(shouldOnboard(String(Date.now())), false)
    assert.equal(shouldOnboard(1789441200000), false)
  })

  it('★★ ④ 数字 0 和负数不是时间戳 —— 当没看过', () => {
    assert.equal(shouldOnboard('0'), true)
    assert.equal(shouldOnboard('-1'), true)
  })

  it('★★ ⑤ 读到一串看不懂的东西 → 宁可多出一次，也不要让他永远见不到', () => {
    assert.equal(shouldOnboard('昨天'), true)
    assert.equal(shouldOnboard('NaN'), true)
    assert.equal(shouldOnboard('  '), true)
  })

  it('★ ⑥ 键走 `ui.` 那条通道 —— 那条是 DEVICE，不进同步', () => {
    assert.ok(
      ONBOARDING_KEY.startsWith('ui.'),
      '★★ 前缀不是 `ui.` 的话，主进程那道 `uiKey` 闸会直接抛，而且这个值会变成要同步的学习数据'
    )
  })
})

describe('★★ SC-25 · 讲哪五件（确认单表 3 · 两端同一份）', () => {
  it('★★★ ① 五件，一件不多一件不少', () => {
    assert.equal(ONBOARDING_STEPS.length, 5)
    assert.deepEqual(
      ONBOARDING_STEPS.map((s) => s.id),
      ['G-1', 'G-2', 'G-3', 'G-4', 'G-5']
    )
  })

  it('★★★ ② 每一步的正文**最多两句**（COPY_RULES CR-3）', () => {
    for (const s of ONBOARDING_STEPS) {
      /** ★ 数的是句号 —— 中文句号、英文句点、问号、感叹号都算一句的结尾 */
      const sentences = s.body.split(/[。.!?！？]/).filter((x) => x.trim().length > 0).length
      assert.ok(
        sentences <= 2,
        `★★ ${s.id} 的正文有 ${sentences} 句：「${s.body}」—— CR-3 说 ≤ 2 句，多了他不会看`
      )
    }
  })

  it('★★ ③ 标题是一行，不是一句话', () => {
    for (const s of ONBOARDING_STEPS) {
      assert.ok(s.title.length > 0 && s.title.length <= 20, `★ ${s.id} 的标题太长：「${s.title}」`)
      assert.ok(!s.title.includes('\n'), `★ ${s.id} 的标题里有换行`)
    }
  })

  it('★★★ ④ 不讲设置 · 同步 · 词典 · AI · 报告 · 提醒（确认单砍掉的那几样）', () => {
    const banned = ['同步', '词典', 'AI', '报告', '提醒', '设置']
    for (const s of ONBOARDING_STEPS) {
      for (const b of banned) {
        const where = `${s.title}${s.body}`
        assert.ok(
          !where.includes(b),
          `★★ ${s.id} 里出现了「${b}」—— 那是「用到时才需要知道」的东西，不该占第一次那几屏`
        )
      }
    }
  })

  it('★★ ⑤ 不出现编号 · 键名 · 代码标识（COPY_RULES CR-2）', () => {
    for (const s of ONBOARDING_STEPS) {
      const where = `${s.title}${s.body}`
      assert.ok(!/[DIT]-\d/.test(where), `★ ${s.id} 里有编号`)
      assert.ok(!where.includes('_'), `★ ${s.id} 里有下划线（多半是键名）`)
      assert.ok(!where.includes('`'), `★ ${s.id} 里有反引号（多半是代码标识）`)
    }
  })
})

/**
 * ══ ★★★ 说的是不是真的（2026-09-15 补）════════════════════════
 *
 * 上面那一组验的全是**格式**：几句话 · 有没有废弃词 · 有没有编号。
 * 它们**一条都没红**，而那时候五句里有两句内容是错的 ——
 * G-5 把静默的因果写反了（写成「不练就会静默」，实际是「连对三次才静默」），
 * G-2 把入口写错了（写成「点星」，实际是词典卡上那颗「收下」）。
 * 两处都是使用者一句话问出来的，不是闸抓出来的。
 *
 * ☞ **格式对不等于说的是真的。** 下面这一条把能钉的那部分钉住：
 *   引导里那个「三次」必须和判分那边的 `silenceStreak` 是同一个数。
 * ★ 钉不住的部分（「静默是练成了不是荒废了」这种语义）说清楚：
 *   没有闸能替代「回源码核一遍」。写教术语的句子时，每一句都要回去核，
 *   核的是**我对这个词的理解**，不是「这个词在不在例外名单里」。
 */
describe('★★★ SC-25 · 引导说的数，必须和判据是同一个', () => {
  it('★★★ 「连着答对三次」里的三，就是 grading 的 silenceStreak', () => {
    const g5 = ONBOARDING_STEPS.find((s) => s.id === 'G-5')
    assert.ok(g5, '★ G-5 没了')
    const n = DEFAULT_GRADING.silenceStreak
    const zh = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九'][n] ?? String(n)
    assert.ok(
      g5.title.includes(zh) || g5.title.includes(String(n)) || g5.body.includes(zh) || g5.body.includes(String(n)),
      `★★ 判分那边 ${n} 次正确才静默，而 G-5 写的是「${g5.title}／${g5.body}」——` +
        ' 两处对不上。改了阈值就要改这句话，不然第一次用的人第一眼看到的就是假的'
    )
  })

  it('★★ G-5 不许再把因果说反（不练 → 静默）', () => {
    const g5 = ONBOARDING_STEPS.find((s) => s.id === 'G-5')!
    const where = `${g5.title}${g5.body}`
    for (const wrong of ['不练', '没练', '荒废', '长时间不']) {
      assert.ok(
        !where.includes(wrong),
        `★★★ 又写成「${wrong}…就静默」了。静默是**连对 ${DEFAULT_GRADING.silenceStreak} 次练成的**，` +
          '不是荒废出来的（`core/grading.ts`）。写反的话，他会以为「别去练它就自己静默」'
      )
    }
  })
})

/**
 * ══ 那个数跟着他的设置走（D-485 · E-1-e）══════════════════════
 *
 * 「练成所需连正确」是他能改的（`param.silenceStreak`）。写死的话他改成 2 之后，
 * 引导第一次打开就在说假话 —— 而**没有任何东西会红**：文案没有类型。
 * 这一组就是那个闸。
 *
 * ★ 负向对照（做过）：把 `onboardingSteps` 改成恒返回 `ONBOARDING_STEPS`
 *   （= 退回写死）→ 下面 ① 当场红。
 */
describe('★★★ SC-25 · 引导里那个次数跟着设置走', () => {
  it('★★★ ① 他把阈值改成 2 —— 引导就得说「两次」，不能还说「三次」', () => {
    const g5 = onboardingSteps(2).find((s) => s.id === 'G-5')!
    assert.match(g5.title, /两次/, `★★ 阈值是 2，引导却写着「${g5.title}」`)
    assert.ok(!g5.title.includes('三次'), '★★★ 还在说三次 —— 那是写死的老毛病')
  })

  it('★★ ② 出厂 3 时和静态那一份一模一样（换个取法不该换个说法）', () => {
    const a = onboardingSteps(3).find((s) => s.id === 'G-5')!
    const b = ONBOARDING_STEPS.find((s) => s.id === 'G-5')!
    assert.deepEqual(a, b)
  })

  it('★★ ③ 读到坏值（0 / 负数 / NaN）退回出厂 3，不要显示「零次」', () => {
    for (const bad of [0, -1, Number.NaN]) {
      assert.match(onboardingSteps(bad).find((s) => s.id === 'G-5')!.title, /三次/)
    }
  })

  it('★★★ ④ 五步里一个「静默」都不许再出现（D-485 换的就是这个词）', () => {
    for (const s of onboardingSteps(3)) {
      assert.ok(!`${s.title}${s.body}`.includes('静默'), `★★★ ${s.id} 里还留着「静默」`)
    }
  })
})

/**
 * ══ 第二层 · 页面内引导（D-484 · 确认单表 B / 表 D）════════════
 *
 * 这一层最容易坏的两件事，都不会报错：
 *   · 「看过」没记住 → 同一句话每次进页面都弹，而他只会觉得这软件很烦
 *   · 版本 +1 之后**整套重弹** → 他第一次看的时候是新鲜，第二次是打扰
 */
describe('第二层 · 页面内引导', () => {
  it('★★ 十七条，一条不多一条不少（每页 ≤ 1 件；上限那条使用者已放开）', () => {
    /**
     * ★ 7 不是 8：B-8「项目进度条」两端都删了（使用者 2026-09-15）——
     *   Windows 上那根条随 D-469 没了，Android 本来就不做统计（D-348）。
     *   ★★ 这一行写死数字是**故意的**：名单少一条 = 某一页从此不再解释自己，
     *     而那是一种**静悄悄的**退化 —— 屏上少一句话，没有任何别的闸会红。
     */
    assert.equal(PAGE_GUIDES.length, 17)
    /**
     * ★★ 原来这儿还钉着「≤ 8」。**使用者 2026-09-15 自己放开了**：
     *   「按标准列一份之后**都做**，引导是一次性的，**不怕多**」。
     *   所以上限那一句撤掉 —— 留着它就是拿一条他已经改掉的规矩挡住他要的东西。
     * ★ 真正的闸不在数量上，在**判准**（重要功能 · 第一次容易不理解 · Nyx 特有）
     *   和「每页 ≤ 1 件」上；哪些**不该有**写在覆盖面清单 §三。
     */
    assert.equal(
      PAGE_GUIDES.find((g) => g.id === 'project-progress'),
      undefined,
      '★ B-8 又回来了 —— 它在两端都没有目标，会永远量不到'
    )
    assert.equal(new Set(PAGE_GUIDES.map((g) => g.id)).size, PAGE_GUIDES.length, 'id 撞了')
    for (const g of PAGE_GUIDES) {
      assert.ok(g.says.trim().length > 0, `${g.id} 没有屏上字`)
      /** CR-3：一句话。句号只许有一个（结尾那个） */
      assert.equal(
        g.says.split('。').filter(Boolean).length,
        1,
        `★ ${g.id} 不止一句 —— 规矩是每条一句话`
      )
    }
  })

  /**
   * ★★★ 改了那句话，就必须把 `version` +1（2026-09-15，S-6 要的那道闸）
   *
   * ══ 不钉会怎样 ════════════════════════════════
   * `shouldShowGuide` 判的是 `seen[id] < version`。换句话说：**已经看过旧那句的人，
   * 只有在 version 变大时才会再看到新的**。改了字不改 version —— 老用户永远停在旧那句，
   * 而屏上、闸上、日志里**没有任何东西会说一句话**。他以为改好了，老用户看到的还是旧的。
   *
   * ══ 为什么记指纹而不是记原文 ══════════════════════
   * 记原文就是把同一句话抄两遍，两份迟早不一致；而且那七句加起来会让这条用例变成一篇文案。
   * 指纹只回答一个问题：**这句话跟上次登记时是不是同一句**。
   *
   * ══ 怎么用 ══════════════════════════════════
   * 改了某条的 `says` → 这条红 → 把那条的 `version` +1，**并把下面这张表里的两个值一起更新**。
   * ★ 一次动作要改三处（文案 · version · 这张表），是**故意的**：
   *   它让「我改了一句屏上的话」变成一件要签字的事，而不是顺手改掉。
   */
  /**
   * ★★★ 那句解释**说的是不是真话** —— 内容闸，不是格式闸（D 2026-09-15 提，采纳）
   *
   * ══ 为什么非要这一条 ══════════════════════════
   * 这份文件在 `PAGE_GUIDES` 上原本**只钉格式**（非空 · 一句话）。而 `vault-learned`
   * 这一条是**教术语**的：它要告诉他「静默」是什么。格式对、内容错，格式闸一条都不会红 ——
   * 这份文件自己的头注就记着上一次栽的正是这个：五句里两句内容是错的，闸全绿。
   *
   * ══ 钉法：把句子**接在 core 常量上**，不让它当自由文本 ════════
   *   ① 句子里必须出现档名本身（它解释的就是这个名字）；
   *   ② 必须出现「放回去」那个动作词 —— 而且是 `SILENCE_ACTIONS.restore` 那一份，不是抄的；
   *   ③ 两种来源都得提到（练成的 · 他自己收起来的），而这两个词**由 `silenceLabel()` 反过来钉住**：
   *      哪天标签改了名，③ 的后半会红，逼人回来重看这句话。
   * ★ ③ 那一步是这条闸的关键：只断言句子里有「练成」两个字，是**拿被测对象自己当判据**；
   *   同时断言 `silenceLabel('earned')` 里也有「练成」，这两句才连成一条链。
   */
  it('★★★ 那句解释接在 core 常量上（格式对不等于说的是真的）', () => {
    const g = PAGE_GUIDES.find((x) => x.id === 'vault-learned')
    assert.ok(g, '★ `vault-learned` 不见了 —— 那一档从此没人解释')
    const says = g.says

    assert.ok(
      says.includes(SILENCE_FILTER_NAME),
      `★★ 这句话没提档名「${SILENCE_FILTER_NAME}」—— 它解释的就是这个名字，` +
        '而且屏上的这两个字只许从常量来'
    )
    assert.ok(
      says.includes(SILENCE_ACTIONS.restore),
      `★★ 没告诉他怎么拿回来（「${SILENCE_ACTIONS.restore}」）——` +
        ' 只说「这儿放的是什么」而不说「怎么办」，他看完还是不敢点'
    )

    /**
     * ③ **不再分两种**（2026-09-15 · D-489 改了这一条）。
     *   原来这里钉的是「两种来源的标签逐字出现在句子里」（`silenceLabel()` 那一份）。
     *   使用者裁：行上不再标是练成的还是他自己放一边的，那两个词也整族退役 ——
     *   所以这句解释**不许再提那个区分**，提了就是在说一个屏上已经没有的东西。
     */
    for (const bad of ['归档', '轮转', '已练成', '收起来', '放回去']) {
      assert.ok(
        !says.includes(bad),
        `★★ 解释里出现了退役词「${bad}」—— 解释术语的句子自己用错词，` +
          '他会照着它去找一个屏上不存在的东西'
      )
    }

    /**
     * ══ ★ 钉不住的那一半，写在明处 ═══════════════════════
     * 上面钉住的是**用词**：档名 · 两个标签 · 那个动作，都必须和屏上是同一份。
     * **钉不住的是语气与意思**：「静默是练成了、不是被丢掉了」这一层 ——
     * 一句用词全对的话照样可以把它说反（比如写成「不再考它了，放着吧」）。
     * ★ 那一半只有人读得出来，所以**每次改这句话都要有人重读一遍**，
     *   别以为这条用例绿了就等于这句话说得对。
     *   这份文件的头注记着上一次栽的正是这个：格式全绿，五句里两句意思是错的。
     */
  })

  /**
   * ★★★ 引导句里**不许用「」点名按钮**（2026-09-15 · D-489 ④，C 量到的）
   *
   * ══ 真出过的事 ═══════════════════════════════════════════
   * `lookup-save` 原来写的是「点「收下」，这个词就进了你的 Vault……」。
   * 而两端那颗按钮**不叫同一个名字** —— Android 那颗是「收进 Atlas ›」。
   * 于是同一句 core 文案在手机上指着一个屏上不存在的按钮，
   * **而两端的闸都是绿的**：闸比的是「两端说同一句话」，它们确实说了同一句，
   * 只是那句话在一端是假的。
   *
   * ══ 为什么钉「不许点名」而不是「两端按钮改成同名」 ═════════
   * 按钮名归那一屏管（Android 那颗要说清收到哪儿去，Windows 这颗不必），
   * 强行统一是拿文案去迁就闸。**引导句说「做完这一下会怎样」就够了** ——
   * 按钮改名时它不会说假话，这才是它该有的性质。
   *
   * ★ 连带把「」整个禁掉，不只禁按钮名：一句 ≤ 30 字的引导里加一对引号，
   *   十有八九就是在点名屏上的某个控件。真要引用别的东西，改用别的说法。
   */
  it('★★★ 引导句里不许用「」点名按钮（按钮改名不该让它说假话）', () => {
    for (const g of PAGE_GUIDES) {
      const at = g.says.indexOf('\u300c')
      assert.equal(
        at,
        -1,
        `★★★ 「${g.id}」那句话里用「」点了名：${g.says}\n` +
          '  引导句只说「做完这一下会怎样」—— 按钮叫什么由那一屏自己负责，' +
          '两端的按钮本来就不同名（Android 那颗是「收进 Atlas ›」）'
      )
    }
  })

  it('★★★ 改了引导那句话就必须 version +1（不然老用户永远看不到新的）', async () => {
    const { createHash } = await import('node:crypto')
    /** 上次登记时：这条是第几版 · 那句话的指纹 */
    const REGISTERED: { id: string; version: number; says: string }[] = [
    { id: 'today-paste', version: 1, says: '249a4682' },
    { id: 'lookup-save', version: 2, says: '28024e3a' },
    { id: 'assist-lecture', version: 1, says: '2dc29db3' },
    { id: 'sidebar-tree', version: 1, says: '319c417b' },
    { id: 'practice-settle', version: 1, says: 'a06d9285' },
    { id: 'vault-learned', version: 4, says: 'd9f6f7bf' },
    { id: 'vault-hard', version: 1, says: '60e7207f' },
    /** ── 覆盖面清单 §二 的八条（T-2，2026-09-15 登记）────────── */
    { id: 'lecture-split', version: 2, says: 'eb6d6a53' },
    { id: 'filestudy-modes', version: 1, says: 'abac1bd0' },
    { id: 'trash-tiers', version: 1, says: '3f92f72b' },
    { id: 'report-layers', version: 1, says: '2cde7652' },
    { id: 'prompt-area', version: 1, says: '98d4d753' },
    { id: 'item-analysis', version: 1, says: '738c09ca' },
    { id: 'capture-entry', version: 2, says: '360395c9' },
    { id: 'today-recommend', version: 1, says: '2c5e3515' },
    /** ── 主控 2026-09-15 追加的两条 ────────────────────────── */
    { id: 'practice-hint-cost', version: 1, says: 'df53728a' },
    { id: 'assist-star', version: 1, says: 'af099617' }
    ]
    const digest = (s: string): string =>
      createHash('sha256').update(s).digest('hex').slice(0, 8)

    assert.equal(
      REGISTERED.length,
      PAGE_GUIDES.length,
      '★ 名单长度和这张表对不上 —— 新增 / 删掉一条都要在这儿登记一次'
    )
    for (const g of PAGE_GUIDES) {
      const was = REGISTERED.find((r) => r.id === g.id)
      assert.ok(was, `★ 「${g.id}」没在这张表里登记过 —— 新加一条引导要同时登记`)
      const now = digest(g.says)
      if (now === was.says) {
        assert.equal(
          g.version,
          was.version,
          `★ 「${g.id}」那句话一个字没改，version 却动了（${was.version} → ${g.version}）——` +
            ' 白白让所有人重看一遍；真要重弹就改一下那句话'
        )
        continue
      }
      assert.ok(
        g.version > was.version,
        `★★★ 「${g.id}」那句话改了，可 version 还是 ${g.version} ——` +
          ' **看过旧那句的人再也不会看到新的**，而且没有任何东西会报错。' +
          ' 把 version +1，并把这条用例里那张表的两个值一起更新'
      )
      assert.fail(
        `★ 「${g.id}」改过了（version ${was.version} → ${g.version}），` +
          `请把这张表里它那一行更新成 version: ${g.version}, says: '${now}'`
      )
    }
  })

  it('★★★ 没看过 → 出；看过 → 不出', () => {
    assert.equal(shouldShowGuide({}, 'today-paste'), true)
    assert.equal(shouldShowGuide({ 'today-paste': 1 }, 'today-paste'), false)
  })

  it('★★★ 版本 +1 → **只有这一条**重出（不是整套重来）', () => {
    const seen = { 'today-paste': 1, 'lookup-save': 1 }
    assert.equal(shouldShowGuide(seen, 'today-paste', 2), true, '内容变了该重出这一条')
    assert.equal(shouldShowGuide(seen, 'lookup-save', 1), false, '★★★ 别的那几条被一起重弹了')
  })

  it('★★ 认不出的 id 一律不出 —— 那是代码写错了，不该表现成屏上多一句没人认领的话', () => {
    assert.equal(shouldShowGuide({}, 'no-such-guide'), false)
  })

  it('★★ 看过表读得回来；坏值当没看过（绝不抛 —— 抛了整页打不开）', () => {
    assert.deepEqual(parseGuideSeen(noteGuideSeen(null, 'today-paste', 1)), { 'today-paste': 1 })
    assert.deepEqual(parseGuideSeen('{坏掉的'), {})
    assert.deepEqual(parseGuideSeen('[1,2]'), {})
    assert.deepEqual(parseGuideSeen(null), {})
    assert.deepEqual(parseGuideSeen('{"B-1":"不是数"}'), {})
  })

  it('★★★ 不设上界、不丢最旧 —— 全部记住（挤掉一条 = 同一句话再弹一次）', () => {
    let raw: string | null = null
    for (const g of PAGE_GUIDES) raw = noteGuideSeen(raw, g.id, g.version)
    const seen = parseGuideSeen(raw)
    assert.equal(Object.keys(seen).length, PAGE_GUIDES.length)
    for (const g of PAGE_GUIDES) assert.equal(shouldShowGuide(seen, g.id), false, g.id)
  })

  it('★ 第一层那个键原样留着，两张表互不相干', () => {
    assert.equal(ONBOARDING_KEY, 'ui.onboarding.doneAt')
    assert.equal(GUIDE_SEEN_KEY, 'ui.guide.seen')
    assert.notEqual(ONBOARDING_KEY, GUIDE_SEEN_KEY)
  })
})
