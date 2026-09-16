import { SILENCE_ACTIONS, SILENCE_FILTER_NAME, silenceScopeAction } from '../src/core/silence.ts'
import { after, before, describe, it } from 'node:test'
import { TRASH_DAYS } from '../src/core/sql/trash.ts'
import { openLecture } from './tree.ts'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright-core'
/** ★ 徽章该说什么**从注册表推** —— 用例里不写死哪一家今天是什么状态 */
import { writePlainDict } from './make-dict.ts'
import { writeMdx } from './make-mdx.ts'
import { mainWindow } from './win.ts'
import { captureApp, keepOrClean } from './keep-on-fail.ts'

/**
 * 主干后半段的验收：审阅 → 首轮认读 → 产出判分 → 结算。
 *
 * **为什么单独一个文件、单独一个应用实例。**
 * 上一版把这些接在 smoke.test.ts 那条 40 多项的长链后面，结果连挂四次，
 * 每次症状都不一样（假服务器被上一节的钩子关掉、lecture 被上个测试打成 empty、
 * 面板被上一步留成开着……），**但病因是同一个：每一项都依赖前一项留下的状态。**
 * 修症状修了四轮没修到病。
 *
 * 所以这里：自己的临时数据目录、自己的假 AI、自己在 before 里把状态铺到位。
 * 这一段坏了，不会再拖垮别的；别的坏了，也影响不到这一段。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-study-'))

type Mode =
  | 'items'
  | 'questions'
  | 'score2'
  | 'score3'
  | 'analysis'
  | 'tutor'
  | 'diagnose'
  | 'score1'
  | 'hardItem'
  | 'questionsWrongType'

/** 假导师会把它**看到的文章**回声出来 —— 这样才能证明右栏真的读到了左栏（R-004）。 */
let lastDocSeen = ''
/**
 * 假 AI 的响应延迟（毫秒）。
 * 默认 0 —— 测试要快。
 * 只有验收**过程态**（进度条、转圈、暂停按钮）时才调大：
 * 假服务器秒回的话，「正在跑」那一帧根本来不及出现，
 * 断言就会变成「碰运气」—— 那种测试比没有更糟，它会时绿时红，然后被当成噪声关掉。
 */
let replyDelay = 0
let mode: Mode = 'items'
let server: Server
let port = 0

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []
const pageErrors: string[] = []

/** 三条全新的主动词汇，够跑完审阅 → 认读 → 产出一整轮 */
const TERMS = ['bear the brunt of', 'at the mercy of', 'a far cry from']

/** 贴进去的那段原文。出处断言要拿它逐字比对，所以只能有这一份。 */
const SOURCE_TEXT =
  'Coastal towns bear the brunt of the winter storms. ' +
  'Their harbours are at the mercy of the winter storms, and the repair bills never stop. ' +
  'What is left is a far cry from the fishing economy of thirty years ago.'

const FAKE = {
  items: {
    items: TERMS.map((term, i) => ({
      term,
      gloss: `meaning of ${term}`,
      glossZh: '中文提示',
      layer: 'B',
      kind: 'chunk',
      hitBy: ['writing'],
      confidence: 0.4 + i * 0.2,
      quote: `Coastal towns ${term} the winter storms.`,
      para: 1,
      why: 'A learner would write something flatter.'
    }))
  },
  questions: {
    questions: [1, 2, 3, 4, 5].flatMap((tier) =>
      [0, 1, 2].map((k) => ({
        tier,
        type: ['造句', '句子改写', '错误订正', '限定写作', '情景任务'][tier - 1],
        prompt: `Write one sentence about topic ${tier}-${k} using the target expression.`,
        context: tier === 1 ? 'original' : 'unseen',
        broken: null,
        reference: 'Coastal towns bear the brunt of the winter storms.'
      }))
    )
  },
  score2: {
    grade: 2,
    note: 'Stiff collocation.',
    why: 'Holds together and the meaning lands, but a native writer would not put it this way.',
    annotations: [
      {
        span: 'on this debate',
        label: 'collocation',
        problem: 'This expression does not take "on".',
        fix: 'over this debate'
      }
    ]
  },
  score3: { grade: 3, note: 'Fine.', why: 'Correct and the register fits.', annotations: [] },
  /**
   * ★ AI 照抄提示词里的输出示例（I-108 同款）：全部标成「造句」。
   * 他勾的题型里没有造句 —— 软件必须一道都不收。
   */
  questionsWrongType: {
    questions: [1, 2, 3].map((k) => ({
      tier: 1,
      type: '造句',
      prompt: `Write one sentence about topic ${k} using the target expression.`,
      context: 'original',
      broken: null,
      reference: 'Coastal towns bear the brunt of the winter storms.'
    }))
  },
  /** 专供攻坚那一段用的全新条目 —— 不跟前面的测试抢状态 */
  hardItem: {
    items: [
      {
        term: 'weigh on',
        gloss: 'to press down on someone as a worry',
        glossZh: '压在心头',
        layer: 'B',
        kind: 'chunk',
        hitBy: ['writing'],
        confidence: 0.6,
        quote: 'The debt weighed on every decision they made.',
        para: 1,
        why: 'A learner would write "made them worried".'
      }
    ]
  },
  score1: {
    grade: 1,
    note: 'Wrong preposition.',
    why: 'The collocation does not hold.',
    annotations: []
  },
  diagnose: {
    summary: 'You used **on** instead of **of** four times today, all with the same verb family.',
    diagnoses: [
      {
        // 必须对上真正卡住的那条 —— 诊断是按词条名回填的
        term: 'weigh on',
        pattern: 'Both attempts used **at** instead of **on** — a fixed habit, not a slip.',
        drill: 'on'
      }
    ]
  },
  tutor: {
    say: 'Look at paragraph 2 — the author never defends the causal step.',
    task: { title: 'Task 1', body: 'Rewrite that claim making the causal step explicit.', para: 2 }
  },
  analysis: {
    gloss: 'to take the worst of something',
    // D-468 · 正文一层：它在这句里做什么 + 哪里会绊住人，合成一块
    inSentence:
      'Says the towns did not merely suffer — they took the share nobody chose for them. ' +
      'brunt 单独看没有对应的中文词，bear 也不是「熊」或「忍受痛苦」。',
    chunks: [
      { text: 'bear the brunt of', why: 'Carries the whole power relation', example: 'Junior staff bore the brunt of the cuts.' },
      { text: 'these storms', why: 'Deixis — points back at something already named', example: 'These delays cost us the contract.' }
    ],
    verbs: 'bear 在这里是「承受」，直接跟抽象名词 brunt，再用 of 引出来源。不能说 bear the brunt from。',
    pattern: '[主语] + bear the brunt of + [来源] —— 常用来指出代价落在谁头上。',
    pragmatics: '把责任摆出来但不点名施动者 —— 换成 suffer 就没有「不公平地多担了」这层。',
    variation: '书面为主，新闻评论里最常见；口语里会说 get hit hardest。',
    rewrites: [
      { register: 'more formal', text: 'Coastal settlements absorb the greatest share of these storms.' },
      { register: 'more casual', text: 'Coastal towns get hit hardest by these storms.' },
      { register: 'more neutral', text: 'These storms affect coastal towns most.' }
    ],
    glossZh: '首当其冲',
    type: 'Verb + noun collocation; takes **of** for its object',
    collocations: ['bear the brunt of', 'took the brunt of'],
    register: 'Written; news and commentary.',
    nuance: [
      { term: 'bear the brunt of', note: 'Takes the worst share, usually unfairly', self: true },
      { term: 'suffer from', note: 'Neutral, no sense of an unfair share' }
    ],
    examples: [
      { text: 'Coastal towns bear the brunt of these storms.', source: 'corpus', note: 'news' },
      { text: 'Junior staff bore the brunt of the cuts.', source: 'ai' }
    ]
  }
}

before(async () => {
  server = createServer((req, res) => {
    // D-068 · 抓取用的假网页。带脚本、导航、页脚 —— 正文提取得把这些甩掉
    if (req.url?.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
<html><head><title>Storms and coastal towns</title>
<script>var junk = "navigation menu";</script></head>
<body><nav>navigation menu</nav>
<article>
<p>${'Coastal towns bear the brunt of these storms, and the damage compounds each year. '.repeat(6)}</p>
<p>${'Local councils are left to foot the bill long after the news crews have gone. '.repeat(6)}</p>
</article>
<footer>navigation menu</footer></body></html>`)
      return
    }
    if (req.url?.startsWith('/thin')) {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><p>hi</p></body></html>')
      return
    }

    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (mode === 'tutor') lastDocSeen = body

      /**
       * 按**提示词内容**分辨要什么，而不是只看 mode。
       *
       * I-043 之后，一次「分析」会连着发好几种请求：先提材料里的条目，
       * 再逐条写完整解析。只看 mode 的话，逐条解析那几发会拿到 items 那份 JSON，
       * 于是每条都被写进一堆垃圾区块 —— 真实的服务商当然是按提示词回应的，
       * 假服务器也该这样。
       */
      // analyse-item.md 的 SYSTEM 头一句，别的提示词里没有
      const wantsItemAnalysis = body.includes('You write the full entry for')
      const content = body.includes('NYX_OK')
        ? 'NYX_OK'
        : wantsItemAnalysis && mode !== 'analysis'
          ? JSON.stringify(FAKE.analysis)
          : JSON.stringify(FAKE[mode])
      const send = (): void => {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content } }] }))
      }
      if (replyDelay > 0) setTimeout(send, replyDelay)
      else send()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port

  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  captureApp(app)
  page.setDefaultTimeout(6000)
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')


  // ── 铺状态：配 AI → 建 lecture → 贴一份原文 → 分析 ──────────
  await page.click('[data-testid="nav-settings"]')
  await page.waitForSelector('[data-testid="slot-heavy"]')
  await page.fill('[data-testid="baseurl-heavy"]', `http://127.0.0.1:${port}/v1`)
  await page.fill('[data-testid="model-heavy"]', 'fake')
  await page.fill('[data-testid="key-heavy"]', 'sk-fake')
  await page.click('[data-testid="save-ai"]')
  await page.waitForSelector('[data-testid="save-ok"]')

  await page.click('[data-testid="nav-home"]')
  await page.click('[data-testid="home-start-btn"]')
  await page.waitForSelector('[data-testid="drop-original"]')
  await page.click('[data-testid="drop-original"] button')
  await page.fill('[data-testid="compose-title"]', '测试材料')
  /**
   * ★ 这段原文里**真的含有**那三个表达。
   *
   * 以前贴的是「A passage about coastal towns and storms.」—— 一句概括，
   * 三个表达一个都不在里面，可假 AI 照样返回了「原文摘录」，软件照样存了下来。
   * 那正是使用者第三次提的那个病：**详情页显示的出处，在原文里找不到。**
   * I-107 之后摘录只从原文定位，所以 fixture 必须像真材料一样是真的。
   */
  await page.fill('[data-testid="compose-text"]', SOURCE_TEXT)
  await page.click('[data-testid="compose-submit"]')
  await page.waitForSelector('[data-testid="matbar"]')

  mode = 'items'
  await page.click('[data-testid="analyze"]')
  await page.click('[data-testid="run-analyze"]')
  await page.waitForSelector('[data-testid="review-banner"]', { timeout: 25000 })
})

after(async () => {
  await app?.close()
  server?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

describe('F-03 · 审阅这一批', () => {
  it('分析完停在「待审阅」，横幅说清这一步是干嘛的', async () => {
    const t = await page.locator('[data-testid="review-banner"]').innerText()
    assert.match(t, /置信度/, '没说清为什么这么排')
    assert.match(t, /什么都不删也行/, '没说清这一步可以跳过')
  })

  it('三条都进来了，而且是主动词汇', async () => {
    await page.click('[data-testid="tab-active"]')
    assert.equal(await page.locator('[data-testid="item-rows"] .lrow').count(), 3)
  })

  it('审阅时行尾是「删掉」，删了就真没了', async () => {
    await page.locator('[data-testid="item-rows"] .xbtn').last().click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="item-rows"] .lrow').length === 2
    )
  })

  it('★「这批我看过了 · 开始学」是门 —— 点了才进入轮转', async () => {
    await page.click('[data-testid="start-learning"]')
    await page.waitForSelector('[data-testid="started-banner"]', { timeout: 10000 })
    assert.match(await page.locator('[data-testid="started-banner"]').innerText(), /明天开始产出练习/)
    assert.equal(await page.locator('[data-testid="review-banner"]').count(), 0, '门没关上')
    await page.waitForSelector('[data-testid="go-reading"]')
    await page.waitForSelector('[data-testid="go-practice"]')
  })
})

describe('阶段④ · 首轮认读（D-093 / D-136）', () => {
  /**
   * ══ D-486 · 认读题型**真的换了这一屏的动作**吗 ★★★ ═══════════
   *
   * ── 为什么非有这一条不可（2026-09-15 量出来的洞）──────────
   *
   * 设置页那三行单选、core 那两个键的读法，都各自有用例。但**把两屏的
   * 「读偏好」那一句拆成写死出厂值**（= 他选了也没用），`smoke:ui` 47/0
   * **一条都不红** —— 判据验到了两头，中间那根线没人验。
   *
   * ★ 设偏好走**它自己的 IPC**，不走设置页：这一段里屏上盖着认读那层浮层，
   *   点导航会 6 秒超时，而那种红看着像「这几条自己坏了」，和要验的事无关。
   *   写入照样过真 IPC → 主进程 → 库，端到端一点没少。
   */
  it('★★★ D-486 · 选了「先写再翻」→ 认读屏真的多出那个输入框', async () => {
    await page.evaluate(async () => {
      await window.nyx.prompts.saveReadingQType('write')
    })
    await page.click('[data-testid="go-reading"]')
    await page.waitForSelector('[data-testid="card-front"]', { timeout: 10000 })
    await page.waitForSelector('[data-testid="write-input"]', { timeout: 5000 })

    /** 写一个明显不对的 → 翻开只说「对不上」，**不降档、不说错在哪** */
    await page.fill('[data-testid="write-input"]', 'zzz not the word')
    await page.click('[data-testid="flip"]')
    await page.waitForSelector('[data-testid="write-verdict"]')
    assert.match(
      await page.innerText('[data-testid="write-verdict"]'),
      /对不上/,
      '★ 写错了却说对上了'
    )
    assert.equal(
      await page.locator('[data-testid="grade-3"].presel').count(),
      0,
      '★★★ 写错了还替他预选「会」—— 那这一档就不是他点的了'
    )

    /** 还原成出厂那一种，并退出这一屏 —— 后面几条从头点 `go-reading` */
    await page.evaluate(async () => {
      await window.nyx.prompts.saveReadingQType('flip')
    })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="go-reading"]', { timeout: 5000 })
  })

  it('正面是挖空的原句 + 三行提示，反面翻卡前不许出现', async () => {
    await page.click('[data-testid="go-reading"]')
    await page.waitForSelector('[data-testid="card-front"]', { timeout: 10000 })
    const hints = await page.locator('.hints').innerText()
    assert.match(hints, /释义/)
    // 大小写不敏感：.hints .k 带 text-transform:uppercase，innerText 拿到的是 NUANCE
    assert.match(hints, /nuance/i)
    assert.equal(await page.locator('[data-testid="card-back"]').count(), 0, '还没翻就露答案了')
    assert.equal(await page.locator('.gap').count(), 1, '原句没挖空')
  })

  it('★ I-083 · 中文默认盖住 —— 它是答案，不是线索', async () => {
    const hints = await page.locator('.hints').innerText()
    assert.match(hints, /看中文/, '中文直接摆在正面了 —— 那这张卡就白练了')
    assert.equal(await page.locator('[data-testid="peek-note"]').count(), 0)

    await page.click('[data-testid="peek-zh"]')
    await page.waitForSelector('[data-testid="peek-note"]')
    // 看了就降档，而且当场说出来 —— 不偷偷扣
    assert.match(await page.innerText('[data-testid="peek-note"]'), /最高按「想了一下」算/)
  })

  it('翻卡之后四档按钮上各自标着下次间隔（D-136）', async () => {
    await page.click('[data-testid="flip"]')
    await page.waitForSelector('[data-testid="card-back"]')
    const g = await page.locator('[data-testid="grades"]').innerText()
    for (const n of ['忘了', '想了一下', '会', '太简单']) assert.match(g, new RegExp(n))
    assert.match(g, /\d+ 天/, '按钮上没标间隔 —— 自评就不带代价了')
  })

  it('评分之后翻卡状态重置，不会带着上一张的答案进下一张', async () => {
    await page.click('[data-testid="grade-3"]')
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="card-back"]') === null ||
        document.querySelector('[data-testid="reading-done"]') !== null
    )
  })

  it('练完给一行字就收，不做结算页（D-136）', async () => {
    for (let i = 0; i < 10; i++) {
      if ((await page.locator('[data-testid="reading-done"]').count()) > 0) break
      if ((await page.locator('[data-testid="flip"]').count()) > 0) {
        await page.click('[data-testid="flip"]')
        await page.click('[data-testid="grade-3"]')
      }
      await page.waitForTimeout(80)
    }
    await page.waitForSelector('[data-testid="reading-done"]')
    await page.click('[data-testid="reading-close"]')
    await page.waitForSelector('[data-testid="go-practice"]')
  })
})

describe('阶段⑤ · 产出练习与四档判分', () => {
  it('题面只有题干和输入框 —— 不给释义、不给参考答案（D-137 / M-022）', async () => {
    mode = 'questions'
    await page.click('[data-testid="go-practice"]')
    try {
      await page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 })
    } catch (e) {
      const ids = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'))
      )
      const overlay = await page
        .locator('.ov')
        .innerText()
        .catch(() => '(没有浮层)')
      throw new Error(
        `产出练习没出题。\ntestid：${ids.join(', ')}\n浮层内容：\n${overlay.slice(0, 600)}\n控制台：${consoleErrors.join(' | ').slice(0, 400)}\n${String(e).slice(0, 120)}`
      )
    }
    assert.match(await page.locator('[data-testid="question-prompt"]').innerText(), /Write one sentence/i)
    assert.equal(await page.locator('[data-testid="reference"]').count(), 0, '还没答就给了参考答案')
  })

  /**
   * ★ 使用者 7 · 题型多选的**面板真的点得开、勾得动**。
   *
   * 他 2026-08-10 的原话：「你自己再整体检查一遍，是不是我让你加的功能
   * 实际上根本没用」。他是对的 —— 拖拽那条就是「后端全绿、界面拖不动」。
   * 所以这一条不查设置有没有存进库（那是 db-safety 的事），
   * 只查**他能不能点开、勾了以后界面有没有回话**。
   */
  it('★ 7 · 题型面板点得开、勾得动，并说清什么时候生效', async () => {
    await page.click('[data-testid="qtypes-open"]')
    await page.waitForSelector('[data-testid="qtypes-panel"]')

    /**
     * ★★ 整段包 try / finally，只为**失败时把面板关掉** ——
     *   它是浮层：一条断在里面没关，后面每一条 `click qtypes-open` 都被遮住，
     *   于是十几条一起卡在 6 s 超时。2026-09-08 真发生过（1 红变 124 红，
     *   首症淹在后面的超时里）。判据一个字没放宽，只是不让一张脸变成一百张。
     */
    try {
      const boxes = page.locator('[data-testid^="qtype-"] input[type="checkbox"]')
      const n = await boxes.count()
      assert.ok(n >= 12, `题型只列出了 ${n} 种 —— 他要的是「覆盖各种测试形式」`)

      const text = await page.innerText('[data-testid="qtypes-panel"]')

      /**
       * ★★★ D-478（使用者 2026-09-08「取消档位机制」）· 这里原来反过来钉着
       *   「第 1～5 档都要列出来」。档位删了，判据跟着**掉个头**：
       *   面板上再出现「第 N 档」就是它悄悄爬回来了。
       */
      assert.doesNotMatch(
        text,
        /第 \d+ 档/,
        '★★★ 题型面板上又出现「第 N 档」—— 档位机制已被 D-478 取消'
      )

      // 一次出几道不在这里选，在设置里 —— 面板必须**说清它在哪**，
      // 否则他会在这一屏找一个不存在的控件
      assert.match(text, /一次出几道/, '没说「一次出几道」去哪儿定')

      // 勾了几种 / 一共几种：这个计数得和真的勾上的框对得上
      const checked = await page
        .locator('[data-testid^="qtype-"] input[type="checkbox"]:checked')
        .count()
      assert.match(
        text,
        new RegExp(`${checked}\\s*/\\s*${n}`),
        `★ 面板上的计数和真的勾上的对不上：勾了 ${checked} 种、一共 ${n} 种`
      )

      // 不许出现选择题这类（CLAUDE.md 的绝对约束）
      assert.doesNotMatch(text, /选择题|连线/, '出现了选项式题型')

      // 勾一下：界面必须回话，而且要说清「什么时候生效」——
      // 不说的话他会盯着当前这道题等它变，然后认为开关是坏的
      const first = page.locator('[data-testid^="qtype-"]').first()
      await first.click()
      await page.waitForSelector('[data-testid="qtypes-note"]', { timeout: 8000 })
      assert.match(await page.innerText('[data-testid="qtypes-note"]'), /下一条|生效|记下了/)

      await first.click() // 勾回去，别影响后面的用例
    } finally {
      await page.click('[data-testid="qtypes-close"]').catch(() => {})
    }
  })

  /**
   * ★★ 2026-08-14 · 他勾的题型里**没有造句**，软件却一道接一道出造句。
   *
   * 这一条走的就是他手指那条路：打开题型胶囊 → 清空 → 只勾一种 →
   * 让假 AI **照旧返回造句**（真实世界里 AI 就是照抄提示词示例的 I-108 同款）→
   * 看他会不会看到造句。
   *
   * 判据是**他屏幕上那行字**，不是库里存了什么 —— 库里那一层 db-safety 管。
   */
  /**
   * ★★ 2026-08-14 · 他勾的题型里**没有造句**，软件却一道接一道出造句。
   *
   * 这一条走的就是他手指那条路：打开题型胶囊 → 清空 → 只勾一种 →
   * 让假 AI **照旧返回造句**（真实世界里它就是照抄提示词里的输出示例，I-108 同款）
   * → 退出练习再进一次（那才是重新出题那条路）→ 看他会不会看到造句。
   *
   * 判据是**他屏幕上那行字**，不是库里存了什么 —— 库里那一层由 db-safety 管。
   */
  it('★★ 没勾造句 → 屏幕上绝不出现造句（AI 硬要给也不行）', async () => {
    // ── ① 清空：清空之后不许自己变回全选 ──────────────────
    await page.click('[data-testid="qtypes-open"]')
    await page.waitForSelector('[data-testid="qtypes-panel"]')
    await page.click('[data-testid="qtypes-none"]')
    await page.waitForFunction(() =>
      (document.querySelector('[data-testid="qtypes-sum"]')?.textContent ?? '').includes('一种都没选')
    )
    await page.click('[data-testid="qtypes-close"]')
    await page.click('[data-testid="qtypes-open"]')
    await page.waitForSelector('[data-testid="qtypes-panel"]')
    assert.equal(
      await page.locator('[data-testid^="qtype-"] input[type="checkbox"]:checked').count(),
      0,
      '★★ 清空之后又自己勾回来了 —— 那正是他要取消的「默认题型」'
    )
    // 一种都没勾 = 出不了题。不兜底，就要在这一屏当场说出来
    assert.match(
      await page.innerText('[data-testid="qtypes-panel"]'),
      /练习出不了题/,
      '★★ 一种都没勾，面板却没说会发生什么 —— 他只会以为清空这个按钮没用'
    )

    // ── ② 只勾「搭配填空」一种 ────────────────────────────
    await page.click('[data-testid="qtype-搭配填空"]')
    await page.click('[data-testid="qtypes-close"]')
    assert.match(
      await page.innerText('[data-testid="qtypes-open"]'),
      /已选 1 种/,
      '★ 胶囊上的数字和他刚才勾的对不上'
    )

    // ── ③ 假 AI 照旧返回「造句」，然后退出练习再进一次 ─────
    /**
     * ★ 不能指望**当前这道题**当场变：面板上那句话写得很清楚
     * 「已经出好的题不变，下一条进练习时按新的来」。
     * 拿当前这道题做判据的话，红的是我对产品语义的理解，不是软件。
     */
    mode = 'questionsWrongType'
    await page.click('[data-testid="practice-quit"]')
    await page.waitForTimeout(500)
    await page.click('[data-testid="go-practice"]')
    await Promise.race([
      page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 }).catch(() => null),
      page.waitForSelector('[data-testid="practice-error"]', { timeout: 25000 }).catch(() => null)
    ])
    await page.waitForTimeout(400)

    // ── ④ 他要么看到搭配填空，要么看到一句解释，绝不是造句 ──
    const label = await page
      .locator('[data-testid="practice-overlay"] .qt')
      .innerText()
      .catch(() => '')
    const err = await page
      .locator('[data-testid="practice-error"]')
      .innerText()
      .catch(() => '')

    assert.ok(
      !label.includes('造句'),
      `★★ 他没勾造句，屏幕上还是出了造句：「${label}」—— 这正是他截图里那一幕`
    )
    assert.ok(
      label.includes('搭配填空') || err.length > 0,
      `★ 既没出他勾的题型、也没给一句解释：标签「${label}」/ 报错「${err}」`
    )
    if (err) {
      assert.match(err, /题型/, `★ 报错没说清是题型的事，他不知道该去哪：${err}`)
      assert.doesNotMatch(err, /undefined|null|Error:/, `★ 报错里漏出了内部信息：${err}`)
    }

    // ── ⑤ 收尾：恢复全选 + 正常的假 AI，并让下一条用例拿到一道真题 ──
    // 勾选面板挂在练习浮层里，出错态下点不到 —— 这一步用 IPC 铺回去（它是夹具，不是被验的东西）
    await page.evaluate(async () => {
      const all = (await window.nyx.study.qtypes()).all.map((q) => q.key)
      await window.nyx.study.setQtypes(all)
    })
    mode = 'questions'
    if (err) await page.click('[data-testid="practice-retry"]')
    await page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 })
  })
  /**
   * ★★ G-4 · 改了题型设置，**当前这道题一个字都不变**。
   *
   * 面板上写着「已经出好的题不变，下一条进练习时按新的来」——
   * 这句话以前只有文案，没有任何东西钉住它。而它一旦破了，表现是
   * 他改个设置，手上正在写的这道题**当场换掉**，写了一半的答案跟着没了。
   *
   * ★ 这条用例必须先证明**设置真的存进去了**，否则「当前题没变」会变成
   * 一条假绿：设置根本没保存时它也是绿的，而那才是更糟的病。
   */
  it('★★ G-4 · 改题型设置：当前这道题不变，设置确实已生效', async () => {
    const el = page.locator('[data-testid="question-prompt"]')
    await el.waitFor({ timeout: 25000 })
    const qid0 = await el.getAttribute('data-qid')
    const item0 = await el.getAttribute('data-item')
    const text0 = await el.innerText()
    const label0 = await page.locator('[data-testid="practice-overlay"] .qt').innerText()
    assert.ok(qid0, '前提：屏幕上得有一道题')

    // ── 改设置：清空 → 只勾一种（和当前这道多半不是同一种）──
    await page.click('[data-testid="qtypes-open"]')
    await page.waitForSelector('[data-testid="qtypes-panel"]')
    await page.click('[data-testid="qtypes-none"]')
    await page.click('[data-testid="qtype-限定写作"]')
    await page.click('[data-testid="qtypes-close"]')
    await page.waitForTimeout(1000)

    // ── ① 当前这道题：题号、题面、题型标签，一个字都不许变 ──
    assert.equal(
      await el.getAttribute('data-qid'),
      qid0,
      '★★ 当前这道题被偷偷重生成了 —— 他写到一半的答案会跟着没'
    )
    assert.equal(await el.getAttribute('data-item'), item0, '★★ 连知识点都换了')
    assert.equal(await el.innerText(), text0, '★★ 题面变了')
    assert.equal(
      await page.locator('[data-testid="practice-overlay"] .qt').innerText(),
      label0,
      '★★ 题型标签变了 —— 标签和题面对不上，他只会以为自己看错了'
    )

    /**
     * ★★ 光比 DOM 是**不够**的 —— 那一层本来就不会自己刷新。
     *
     * 负向对照证明了这一点：我把「改设置就删掉所有没用过的题」注进去，
     * 屏幕上那道题照样一个字没变，用例还是绿的。
     * 「有没有被偷偷重生成」是**库里的事实**，只能查库。
     */
    {
      const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
      const row = db.prepare(`select id, type, prompt from questions where id = ?`).get(Number(qid0)) as
        | { id: number; type: string; prompt: string }
        | undefined
      db.close()
      assert.ok(
        row,
        '★★ 当前这道题在库里已经没了 —— 改个设置就把他正在写的那道重生成了'
      )
      assert.ok(
        text0.includes(row!.prompt.slice(0, 20)),
        `★★ 库里那一行的题面变了：「${row!.prompt.slice(0, 40)}」`
      )
    }

    // ── ② 但设置**确实**存进去了（不然上面那条是假绿）──
    await page.click('[data-testid="qtypes-open"]')
    await page.waitForSelector('[data-testid="qtypes-panel"]')
    const checked = await page
      .locator('[data-testid^="qtype-"] input[type="checkbox"]:checked')
      .count()
    assert.equal(
      checked,
      1,
      `★★ 设置根本没保存（勾着 ${checked} 种）—— 那上面那条验的是「没生效」，不是「不影响当前题」`
    )
    await page.click('[data-testid="qtypes-close"]')

    // ── ③ 关掉重进（= 下一条进练习那条路）→ 用的是新配置 ──
    await page.click('[data-testid="practice-quit"]')
    await page.waitForTimeout(500)
    await page.click('[data-testid="go-practice"]')
    await Promise.race([
      page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 }).catch(() => null),
      page.waitForSelector('[data-testid="practice-error"]', { timeout: 25000 }).catch(() => null)
    ])
    await page.waitForTimeout(400)

    const label1 = await page
      .locator('[data-testid="practice-overlay"] .qt')
      .innerText()
      .catch(() => '')
    const err1 = await page
      .locator('[data-testid="practice-error"]')
      .innerText()
      .catch(() => '')
    /**
     * 新配置只勾了「限定写作」这一种（D-478 之后没有档位了，勾了什么就只出什么）。
     * 假 AI 返回的限定写作题会被收下，别的题型一律不收。
     * 所以他要么看到限定写作，要么看到一句解释 —— **不会看到别的题型**。
     */
    if (label1) {
      assert.ok(
        label1.includes('限定写作'),
        `★★ 重进之后用的还是老配置：「${label1}」`
      )
    } else {
      assert.ok(err1.length > 0, '★ 既没题也没给解释')
    }

    // ── 收尾：恢复全选，让后面的用例拿到一道正常的题 ──
    await page.evaluate(async () => {
      const all = (await window.nyx.study.qtypes()).all.map((q) => q.key)
      await window.nyx.study.setQtypes(all)
    })
    if (err1) await page.click('[data-testid="practice-retry"]')
    else {
      await page.click('[data-testid="practice-quit"]')
      await page.waitForTimeout(400)
      await page.click('[data-testid="go-practice"]')
    }
    await page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 })
  })

  /**
   * ★ I-091 · 使用者：「产出练习依旧是同样一道题重复出，
   * 应该出 11 道不同的题的地方，重复的 11 道都是一样的题。」
   *
   * 根因在渲染层：`q` 是组件级状态，换条目时别的字段都清了、唯独漏了它，
   * 而取题那句写的是 `if (!q) { 取新题 }` —— 第 2 条起那个 if 永远进不去。
   *
   * 判据用**题号**不用题面：题面文字可能碰巧一样，题号不会。
   */
  it('★ I-091 · 换一条就换一道题 —— 不是整轮重复同一题', async () => {
    const read = async (): Promise<{ qid: string; item: string }> => {
      const el = page.locator('[data-testid="question-prompt"]')
      await el.waitFor({ timeout: 25000 })
      return {
        qid: (await el.getAttribute('data-qid')) ?? '',
        item: (await el.getAttribute('data-item')) ?? ''
      }
    }
    const first = await read()

    // 跳过这一条（不作答），看下一条给的是不是另一道题
    mode = 'score3'
    await page.fill('[data-testid="answer"]', 'Coastal towns bear the brunt of the storms.')
    await page.click('[data-testid="submit"]')
    await page.waitForSelector('[data-testid="next-question"]', { timeout: 25000 })
    // 下一条要现出题 —— 假服务器得先切回出题那一档，不然它会拿判分的回应去解析题目
    mode = 'questions'
    await page.click('[data-testid="next-question"]')

    const second = await read()
    assert.notEqual(second.item, first.item, '还停在同一个知识点上')
    assert.notEqual(
      second.qid,
      first.qid,
      `第 2 条拿到的还是第 1 条那道题（题号都是 ${first.qid}）—— ` +
        '这样连判分都会记到错误的题目上'
    )
    mode = 'questions'
  })

  it('★ 第 2 档算失败 —— 只给判定与标注，不给范文（D-122 / D-133）', async () => {
    mode = 'score2'
    await page.fill('[data-testid="answer"]', 'Big tech holds sway on this debate.')
    await page.click('[data-testid="submit"]')
    await page.waitForSelector('[data-testid="scale"]', { timeout: 25000 })

    const hit = page.locator('[data-testid="scale"] .sg.hit')
    assert.equal(await hit.count(), 1)
    assert.match(await hit.innerText(), /可懂但不地道/)
    assert.equal(await page.locator('[data-testid="reference"]').count(), 0, '第一次就给了范文')
    await page.waitForSelector('[data-testid="resubmit"]')
  })

  it('标注标在你自己写的句子上（D-120 / M-020）', async () => {
    const marked = page.locator('[data-testid="marked"]')
    assert.match(await marked.innerText(), /Big tech holds sway/)
    assert.equal(await marked.locator('.bad').count(), 1, '错处没被标出来')
    assert.equal(await marked.locator('.bad').innerText(), 'on this debate')
  })

  it('第一次判定推进了进度，而且说得出为什么', async () => {
    const o = page.locator('[data-testid="outcome"]')
    await o.waitFor()
    assert.match(await o.innerText(), /第 2 档/)
  })

  it('改到过关才给范文，且不再推进进度（D-121 / M-019）', async () => {
    mode = 'score3'
    await page.fill('[data-testid="answer"]', 'Big tech holds sway over this debate.')
    await page.click('[data-testid="resubmit"]')
    await page.waitForSelector('[data-testid="reference"]', { timeout: 25000 })
    assert.equal(
      await page.locator('[data-testid="outcome"]').count(),
      0,
      '改到过关不该再推进进度 —— 那不是诚实的样本'
    )
    await page.waitForSelector('[data-testid="next-question"]')
  })
})

describe('阶段⑥ · 结算与出口（D-127 / F-05）', () => {
  it('答完剩下的，落到结算页', async () => {
    for (let i = 0; i < 20; i++) {
      if ((await page.locator('[data-testid="settlement"]').count()) > 0) break
      if ((await page.locator('[data-testid="next-question"]').count()) > 0) {
        await page.click('[data-testid="next-question"]')
      } else if ((await page.locator('[data-testid="submit"]').count()) > 0) {
        await page.fill('[data-testid="answer"]', 'Coastal towns bear the brunt of the storms.')
        await page.click('[data-testid="submit"]')
      } else if ((await page.locator('[data-testid="resubmit"]').count()) > 0) {
        await page.click('[data-testid="resubmit"]')
      }
      await page.waitForTimeout(150)
    }
    await page.waitForSelector('[data-testid="settlement"]', { timeout: 25000 })
  })

  it('四档分布 · 正确率 · 静默 · 攻坚 · 下次这批，都给得出', async () => {
    const t = await page.locator('[data-testid="settlement"]').innerText()
    assert.match(t, /产出正确率/)
    assert.match(t, /练成了/)
    assert.match(t, /进了攻坚区/)
    assert.match(t, /下次这批/)
  })

  it('★ 练完必须有出口，不能只给统计（F-05 / R-008 断点 5）', async () => {
    assert.ok(
      (await page.locator('[data-testid="settle-exits"] button').count()) > 0,
      '结算页没有任何下一步 —— 练完像没发生过'
    )
    await page.click('[data-testid="settle-close"]')
    await page.waitForSelector('[data-testid="go-practice"]')
  })
})

describe('首页 · 今日练习与攻坚区（D-008 / D-027 / D-042）', () => {
  it('状态行如实显示欠账，不催不弹窗（D-028）', async () => {
    await page.click('[data-testid="nav-home"]')
    const stat = page.locator('[data-testid="home-stat"]')
    await stat.waitFor({ timeout: 10000 })
    const t = (await stat.innerText()).replace(/\s+/g, ' ')
    assert.match(t, /个 Lecture 在练/)
    assert.match(t, /认读到期/)
    assert.doesNotMatch(t, /[！!]/, '状态行不该有感叹号 —— 它是信息，不是催促')
  })

  it('今日练习卡说得出「为什么是这个数」（D-027 半数规则）', async () => {
    const reason = page.locator('[data-testid="today-reason"]')
    await reason.waitFor()
    assert.ok((await reason.innerText()).trim().length > 0, '没给出凑数的理由')
  })

  it('条数可加可减，改完计划跟着变（D-027 无上下限）', async () => {
    const before = await page.inputValue('[data-testid="qty"]')
    await page.click('[data-testid="qty-plus"]')
    await page.waitForFunction(
      (b) => (document.querySelector('[data-testid="qty"]') as HTMLInputElement)?.value !== b,
      before
    )
    assert.equal(Number(await page.inputValue('[data-testid="qty"]')), Number(before) + 5)
  })

  it('攻坚区上首页（D-042：它是待办，不是资料库）', async () => {
    await page.waitForSelector('[data-testid="hard-card"]')
    assert.match(await page.locator('[data-testid="hard-card"]').innerText(), /攻坚区/)
  })
})

describe('攻坚区（D-025 / D-097 / D-166）', () => {
  it('侧边栏进得去，空的时候说「空是好事」（D-184 第②类）', async () => {
    await page.click('[data-testid="nav-hard"]')
    await page.waitForSelector('[data-testid="hard-empty"], [data-testid="hard-rows"]', {
      timeout: 8000
    })
    if ((await page.locator('[data-testid="hard-empty"]').count()) > 0) {
      const t = await page.locator('[data-testid="hard-empty"]').innerText()
      assert.match(t, /这是好事/, '空状态说得不对 —— 攻坚区空了是好事，不该给压力')
    }
  })

  it('从攻坚区发起练习时，空了也不会卡死', async () => {
    if ((await page.locator('[data-testid="hard-practice"]').count()) === 0) return
    await page.click('[data-testid="hard-practice"]')
    await page.waitForSelector(
      '[data-testid="question-prompt"], [data-testid="practice-empty"]',
      { timeout: 25000 }
    )
    if ((await page.locator('[data-testid="practice-empty"]').count()) > 0) {
      await page.click('.focus button')
    } else {
      await page.click('[data-testid="practice-quit"]')
    }
  })
})

describe('R-002 · 词条详情页', () => {
  it('从列表点一行就能进去（D-039 列表行可点）', async () => {
    mode = 'analysis'
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    /**
     * 点**这一条**，不是「第一行」。
     * I-107 之后出处只从原文里定位，析出项（delve into 之类）在这份原文里找不到 ——
     * 于是它没有出处，而下面几条断言正是要看出处。挑一条真的出自这份原文的。
     */
    await page
      .locator('[data-testid="item-rows"] .lrow', { hasText: 'bear the brunt' })
      .first()
      .click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })
  })

  it('★ 释义立得住 —— 独立位置、中英双解，不是标题的附属', async () => {
    const g = page.locator('[data-testid="detail-gloss"]')
    await g.waitFor()
    const t = await g.innerText()
    assert.ok(t.trim().length > 0)
    assert.doesNotMatch(t, /还没有释义/, '释义是空的 —— 使用者说「它连释义都没有」就是这个')
  })

  /**
   * ★ I-110 · **R-002「打开就有内容」被使用者否掉了**（2026-08-09）。
   *
   * 他的原话：「整体分析完成后，知识点列表会出现并已分好主动/被动，但详情页仍为空…
   * 用户必须主动触发对应类别的详细分析，才会填充详情。」
   *
   * R-002 那条成立于「分析和详解还是一件事」的时候。两者拆开之后（I-104），
   * 「打开就顺手生成」变成了绕过分流的后门：随手翻几条 = 悄悄花掉几次调用，
   * 而且和「按类别单独跑」的进度对不上 —— 那边数「还剩几条」，这边偷偷做掉了。
   */
  it('★ I-110 · 没做详细分析时，详情页是空的，并说清怎么做', async () => {
    await page.waitForSelector('[data-testid="not-analysed"]', { timeout: 8000 })
    const t = await page.innerText('[data-testid="not-analysed"]')
    assert.match(t, /还没做详细分析/)
    assert.match(t, /我的收集|写作层|理解层/, '没告诉他批量怎么做')
    // 严禁占位：空态里不能出现任何词条内容
    assert.equal(await page.locator('[data-testid="block-inSentence"]').count(), 0)
  })

  it('★ 主动触发之后才填充详情', async () => {
    await page.click('[data-testid="analyse-one"]')
    await page.waitForSelector('[data-testid="block-inSentence"]', { timeout: 25000 })
    assert.match(await page.locator('[data-testid="block-inSentence"]').innerText(), /brunt/)
    assert.equal(await page.locator('[data-testid="not-analysed"]').count(), 0)
  })

  it('分寸辨析摆出来了 —— 软件要求你达到第 4 档，就得先教你分寸在哪（M-037）', async () => {
    const nu = page.locator('[data-testid="block-nuance"]')
    await nu.waitFor()
    const t = await nu.innerText()
    assert.match(t, /bear the brunt of/)
    assert.match(t, /suffer from/, '没有近义对比，第 4 档就无从谈起')
  })

  it('例句标明来源 —— 样板的可信度必须写在脸上（D-150）', async () => {
    const ex = await page.locator('[data-testid="example"]').allInnerTexts()
    assert.ok(ex.length >= 2)
    assert.ok(
      ex.some((e) => e.includes('真实语料')) && ex.some((e) => e.includes('AI 补充')),
      `例句来源没标出来：${JSON.stringify(ex)}`
    )
  })

  it('原文出处看得见 —— 不记就永远补不回来（M-012）', async () => {
    const q = page.locator('[data-testid="detail-quote"]').first()
    await q.waitFor({ timeout: 8000 })
    const t = (await q.innerText()).replace(/^[「"'\s]+|[」"'\s]+$/g, '')

    /**
     * ★ I-107 · 这不是「有没有出处」，是「出处**是不是真的**」。
     *
     * 使用者提了三次同一件事：详情页的原文摘录，在他上传的文件里找不到。
     * 所以这里比的是**逐字**：摘录必须是那段原文的一个子串。
     * 只断言 /Coastal towns/ 是不够的 —— AI 把原句顺一遍也能过。
     */
    assert(
      SOURCE_TEXT.replace(/\s+/g, ' ').includes(t.replace(/\s+/g, ' ')),
      `出处在原文里找不到：
  摘录：${t}
  原文：${SOURCE_TEXT}`
    )
    // 出处不能退化成词条本身 —— 那样认读卡挖不出空，等于没有出处
    assert.notEqual(
      t.toLowerCase(),
      (await page.innerText('[data-testid="detail-term"]')).trim().toLowerCase(),
      '出处退化成了词条本身'
    )
  })

  /**
   * ★★★ T-4.22（使用者 2026-09-08）· 右边那一整栏取消了。
   *
   * 这一条盯的**不是「少了几个 div」**，而是那一栏里唯一的**功能**没被顺手带走：
   * 手动静默（D-022；静默 ≠ 遗忘，D-030）搬进了标题旁的 ⋮（D-377）。
   * 展示删掉只是少看几行；功能删掉他就再也没有入口把一条按下去了 ——
   * 而这种「跟着版面收窄一起悄悄没了」的功能，事后没有人会发现。
   *
   * ★ 负向对照盯的就是这一条：把 ⋮ 里那一项拆掉 → 这里当场红。
   */
  it('★★★ T-4.22 · 那一整栏没了，手动静默搬进 ⋮ 而且点了真的落库', async () => {
    for (const gone of [
      'detail-status',
      'detail-diag',
      'hard-note',
      'two-lines',
      'two-lines-cap',
      'one-line',
      'history-head',
      'detail-history'
    ]) {
      assert.equal(
        await page.locator(`[data-testid="${gone}"]`).count(),
        0,
        `「${gone}」该随 T-4.22 一起没了，它还画在页面上`
      )
    }
    // 正文占满整页宽：两栏那个容器只剩左栏一个孩子
    assert.equal(await page.locator('.cols > .R').count(), 0, '右栏容器还在')

    // ⋮ 打得开，里面有那一项
    await page.click('[data-testid="detail-menu"]')
    await page.waitForSelector('[data-testid="detail-menu-open"]')
    const silence = page.locator('[data-testid="silence-item"]')
    assert.equal(await silence.count(), 1, '★★★ ⋮ 里没有手动静默 —— 这个功能没有别的入口了')
    await silence.click()

    /**
     * ★★ 判据是**库里变了**，不是「按钮点得动」：
     *   离开这一页再回来（重新问主进程要），⋮ 里应该变成「从静默里放出来」。
     */
    await page.waitForTimeout(400)
    await page.click('[data-testid="detail-menu"]')
    await page.waitForSelector('[data-testid="detail-menu-open"]')
    assert.equal(
      await page.locator('[data-testid="restore-item"]').count(),
      1,
      '★★★ 静默了却没落库 —— 菜单里还是「手动静默」'
    )
    // 放回去，别影响后面的用例
    await page.click('[data-testid="restore-item"]')
    await page.waitForTimeout(400)
  })

  it('★ D-468 · 页面上一个「改」都没有（弹层与「交还给 AI」整条链都删了）', async () => {
    assert.equal(await page.locator('[data-testid^="edit-"]').count(), 0, '还有「改」按钮')
    assert.equal(await page.locator('[data-testid="edit-dialog"]').count(), 0)
    assert.equal(
      await page.getByRole('button', { name: '改', exact: true }).count(),
      0,
      '还有一颗写着「改」的按钮'
    )
  })

  /**
   * ★★ D-149 仍然成立，只是**没有新的手改了**。
   *
   * 他 2026-09-07 之前手改过的块，`analysis_blocks.edited` 那一列还留着（D-216），
   * 重新生成时必须照旧跳过。删掉「改」这个入口以后，这条判据最容易被顺手删掉 ——
   * 界面上再也造不出 edited 的块，谁都不会发现它失效。所以这里直接往库里种一块
   * `edited = 1`（这一套自己的临时库），再点重新生成，看它有没有被盖掉。
   */
  it('★★ D-149 · 他以前手改过的块，重新生成照旧一个字不动', async () => {
    const term = (await page.innerText('[data-testid="detail-term"]')).trim()
    const seed = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
    seed.exec('pragma busy_timeout = 5000')
    const row = seed.prepare(`select id from items where term = ?`).get(term) as
      | { id: number }
      | undefined
    assert.ok(row, `库里找不到「${term}」—— 种不下去就别假装验过`)
    const at = Date.now()
    seed
      .prepare(
        `insert into analysis_blocks (item_id, block, content, edited, created_at, updated_at)
           values (?, 'register', ?, 1, ?, ?)
         on conflict(item_id, block) do update set
           content = excluded.content, edited = 1, updated_at = excluded.updated_at`
      )
      .run(row.id, '我自己写的：这词只在书面评论里出现。', at, at)
    seed.close()

    // 重新生成一次 —— 生成完会重读详情，手改过的那一块必须原样还在
    mode = 'analysis'
    await page.click('[data-testid="regen"]')
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="block-register"]')?.textContent ?? '').includes(
          '我自己写的'
        ),
      { timeout: 25000 }
    )
    assert.match(
      await page.locator('[data-testid="block-register"]').innerText(),
      /我自己写的/,
      '重新生成把他手改过的区块覆盖了 —— D-149 的整个用意就是不许这样'
    )
  })

  it('返回回到上一个位置，不是写死回首页（D-071）', async () => {
    await page.click('[data-testid="global-back"]')
    // 回到的是**那一讲**，不是首页。（Tab 会重置成「我的收集」，那个 Tab 在这一讲是空的，
    // 所以不能拿 item-rows 当判据 —— 要看页面本身。）
    await page.waitForSelector('[data-testid="lecture-path"]')
    assert.equal(await page.locator('[data-testid="today-card"]').count(), 0, '返回跑到首页去了')
  })
})

describe('三个知识库 · 共用一套列表（D-126）', () => {
  it('综合知识库：4×4 矩阵在，橙框标出「读得懂 · 产不出」（D-158）', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="matrix"]', { timeout: 8000 })
    // 纵轴产出、横轴认读，四档标签与总原型一字不差
    const mx = await page.locator('[data-testid="matrix"]').innerText()
    /**
     * ★ 变过名的那一档钉常量（D-489 之后终点叫「静默」），其余三档照旧写字面。
     * ☆ 不从 `src/shared/api.ts` 取 `MATRIX_ROWS` —— 那份文件里有 `@core/*` 路径别名，
     *   `node --test` 解不开，整份 smoke 会在导入那一步就炸（试过，1 tests / 1 fail）。
     */
    for (const l of ['攻坚', '训练中', '未开始', '新卡', '学习中', '成熟', SILENCE_FILTER_NAME]) {
      assert.ok(mx.includes(l), `矩阵缺了「${l}」这一档`)
    }
    // 橙框：认读成熟 × 产出还没毕业
    assert.equal(await page.locator('[data-testid="matrix"] .c.zone').count(), 3)
  })

  it('点格子把那批筛出来，而且筛选条件看得见、可撤（D-160）', async () => {
    await page.click('[data-testid="cell-3-0"]') // 未开始 × 新卡
    try {
      await page.waitForSelector('[data-testid="tag-cell"]')
    } catch (e) {
      const err = await page.locator('[data-testid="lib-error"]').allInnerTexts()
      throw new Error(`点格子没筛出来。库报错：${JSON.stringify(err)}\n${String(e).slice(0, 150)}`)
    }
    assert.match(await page.locator('[data-testid="tag-cell"]').innerText(), /未开始 × 新卡/)
    await page.click('[data-testid="tag-cell"] .x')
    await page.waitForSelector('[data-testid="tag-cell"]', { state: 'detached' })
  })

  it('★ 静默的只在图里出现，不进列表（D-158）', async () => {
    const rows = await page.locator('[data-testid="lib-rows"] .lrow').count()
    const silentInList = await page
      .locator('[data-testid="lib-rows"] .lrow', { hasText: SILENCE_FILTER_NAME })
      .count()
    assert.equal(silentInList, 0, '静默条目跑进综合库的列表里了')
    assert.ok(rows >= 0)
  })

  it('勾选后出现批量操作条，矩阵与列表是同一个选择集（D-163）', async () => {
    const first = page.locator('[data-testid="lib-rows"] .lrow').first()
    if ((await first.count()) === 0) return
    await first.locator('.ck').click()
    await page.waitForSelector('[data-testid="selbar"]')
    assert.match(await page.locator('[data-testid="selbar"]').innerText(), /已选\s*1\s*条/)
    await first.locator('.ck').click()
    await page.waitForSelector('[data-testid="selbar"]', { state: 'detached' })
  })

  it('六种排序都能选（D-019 / D-162 列表排序即出题顺序）', async () => {
    const opts = await page.locator('[data-testid="lib-sort"] option').count()
    assert.equal(opts, 6)
    await page.selectOption('[data-testid="lib-sort"]', 'accuracy-asc')
    await page.waitForTimeout(300)
  })

  it('我的上传库：说清它装的是什么、为什么不出产出题（D-015 / M-015）', async () => {
    await page.click('[data-testid="nav-lib-upload"]')
    await page.waitForSelector('[data-testid="upload-note"]', { timeout: 8000 })
    const t = await page.locator('[data-testid="upload-note"]').innerText()
    assert.match(t, /原样保留/)
    assert.match(t, /不出产出题/)
    assert.equal(await page.locator('[data-testid="matrix"]').count(), 0, '上传库不该有矩阵')
  })

  /**
   * ★★★ 这条用例 2026-09-15 **反过来钉了一次**，记在这儿当教训
   *
   * 它原来写的是 `assert.match(t, /不再出题/)` —— 钉的是**当时屏上那个字面**。
   * 于是使用者把档名裁回「静默」之后，它变成了一条**反向闸**：
   * 大字没改 → 绿；谁把大字改对 → 红。整轮改名跑完全绿，而屏幕正中央还是旧名字。
   *
   * ☞ 现在钉的是「**这块大字和 core 那个常量逐字相同**」。
   * ★ 这不算「拿被测对象当判据」：常量是这个名字**唯一**的出处，屏上不许另存一份。
   *   「旧名字彻底消失」那一半由 `check:copy` 的退役词表静态地管（那是独立的一份判据），
   *   两条合起来才完整 —— 一条管「屏上念的是那一份」，一条管「旧的那份不许再冒出来」。
   */
  it('「静默」那一档：游戏框 + 三个数（D-030）', async () => {
    await page.click('[data-testid="nav-lib-silent"]')
    await page.waitForSelector('[data-testid="silent-frame"]', { timeout: 8000 })
    const t = await page.locator('[data-testid="silent-frame"]').innerText()
    assert.equal(
      (await page.locator('[data-testid="silent-title"]').innerText()).trim(),
      SILENCE_FILTER_NAME,
      '★★★ 框上那行大字和 `SILENCE_FILTER_NAME` 不是同一个字 —— ' +
        '屏上又出现了第二份手写的档名，他会看到左边一个名字、正中间另一个'
    )
    /**
     * ★ 框上那句副标 2026-09-15 重写（D-489）：不再分「练成的 / 你收起来的」两种，
     *   动作词由 `SILENCE_ACTIONS.restore` 拼 —— 所以这里钉的是那个常量，不是字面。
     */
    assert.match(t, /不再出题/)
    assert.ok(
      t.includes(SILENCE_ACTIONS.restore),
      `★ 副标没告诉他怎么拿回来（「${SILENCE_ACTIONS.restore}」）：${t}`
    )
    assert.match(t, /知识点/)
  })

  it('三个库用的是同一套列表 —— 行结构一致（D-126）', async () => {
    // 静默库空的时候给一句平静说明，不给按钮压力（D-184 第③类）
    if ((await page.locator('[data-testid="lib-empty"]').count()) > 0) {
      assert.match(await page.locator('[data-testid="lib-empty"]').innerText(), /急不来|还没有/)
    }
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"], [data-testid="lib-empty"]')
  })

  /**
   * ★★ D-477（SC-06 · 2026-09-09）· **列表 ‖ 详情**：点一条 = 右栏就地出详情。
   *
   * 这一条原来叫「从库里点一条能进详情」，走的是「点 → 看 → global-back 回来」。
   * D-477 定案之后那条链本身就是要改掉的东西：看三条要按三次返回。
   * 现在钉三件事，**每一件都是判据里的一句**：
   *   ① 列表不走（LT-T1 列表 ‖ 详情，不是「跳走一页」）
   *   ② **选中不压栈**（NAV-02）—— 没有返回入口，因为他并没有去别处
   *   ③ Esc 关得掉（IX-04 单一消费点）
   * ★ 负向对照就打在这里：把 `onopen` 改回 `go({ k: 'item', id })` → ① ② 当场红。
   */
  it('★★ D-477 · 点一条 = 右栏就地出详情（列表不走 · 返回栈不长 · Esc 关得掉）', async () => {
    const first = page.locator('[data-testid="lib-rows"] .lrow').first()
    if ((await first.count()) === 0) return
    await first.click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })
    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '★★ 点一条把列表切走了 —— 那正是 D-477 要改掉的「跳走一次看一条」'
    )
    assert.equal(
      await page.locator('[data-testid="global-back"]').count(),
      0,
      '★★ 选中压栈了（NAV-02）—— 看三条就得按三次返回'
    )
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="vault-aside"]', { state: 'detached' })
    assert.equal(await page.locator('[data-testid="lib-rows"]').count(), 1, '关掉右栏把列表也带走了')
    await page.waitForSelector('[data-testid="matrix"]')
  })
})

describe('R-005 · 多导师（可建、可选、可切换）', () => {
  it('设置页有 AI 导师那一 tab，预置三个模板', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-tutor"]')
    // ★ D-488′：导师是侧树「文件学习」组下的一片叶子
    await page.click('[data-testid="ptab-tutor"]')
    await page.waitForSelector('[data-testid="tutor-chips"]')
    const t = await page.locator('[data-testid="tutor-chips"]').innerText()
    for (const n of ['严谨学术型', '苏格拉底式', '轻松陪练型']) {
      assert.ok(t.includes(n), `预置导师少了「${n}」`)
    }
    assert.match(t, /默认/, '没有一个是默认导师')
  })

  it('★ 建一个新导师，四个可调项都能改（D-098）', async () => {
    await page.click('[data-testid="tutor-new"]')
    await page.waitForSelector('[data-testid="tutor-form"]')
    await page.fill('[data-testid="tutor-name"]', '毒舌编辑')
    await page.fill('[data-testid="tutor-persona"]', 'A ruthless copy editor.')
    await page.fill('[data-testid="tutor-strict"]', '10')
    await page.selectOption('[data-testid="tutor-timing"]', 'hint')
    await page.click('[data-testid="tutor-save"]')
    await page.waitForSelector('[data-testid="tutor-chips"] >> text=毒舌编辑')
  })

  it('导师不影响判分 —— 这一点写在界面上（D-018 / D-119）', async () => {
    assert.match(
      // 用 testid 定位，不用 `.shs` 的第几个 ——
      // 5.2 在导师下面加了「体裁」那一块，`.last()` 当场指错了地方
      await page.innerText('[data-testid="tutor-note"]'),
      /不影响判分/,
      '没说清换导师不会改判分标准 —— 那会让进度变成随机数'
    )
  })

  it('删得掉，但不会让你删到一个都不剩', async () => {
    await page.click('[data-testid="tutor-chips"] >> text=毒舌编辑')
    await page.waitForSelector('[data-testid="tutor-del"]')
    await page.click('[data-testid="tutor-del"]')
    await page.waitForSelector('[data-testid="tutor-chips"] >> text=毒舌编辑', { state: 'detached' })
  })
})

describe('R-004 ★ 文件学习：右栏必须读到左栏的文章', () => {
  const DOC = [
    'For most of human history, the city was a demographic sink.',
    'Yet the forces that hold sway over long-run growth are not the ones we usually name.',
    'This is a far cry from the story most of us learned.'
  ].join('\n\n')

  it('贴一篇文章进来', async () => {
    await page.click('[data-testid="nav-files"]')
    await page.waitForSelector('[data-testid="fs-add"]', { timeout: 8000 })
    await page.click('[data-testid="fs-add"]')
    await page.fill('[data-testid="fs-title"]', 'Why Cities Win')
    await page.fill('[data-testid="fs-text"]', DOC)
    await page.click('[data-testid="fs-save"]')
    await page.waitForSelector('[data-testid="fs-doc"]', { timeout: 8000 })
    assert.match(await page.locator('[data-testid="fs-doc"]').innerText(), /demographic sink/)
  })

  it('没设路径时先要求设路径 —— 捞到的条目得有地方去（D-198）', async () => {
    await page.waitForSelector('[data-testid="fs-nopath"]')
    assert.match(await page.locator('[data-testid="fs-nopath"]').innerText(), /得有地方去/)

    // I-093 · 三段并排：项目___▾ 单元___▾ Lecture___▾
    await page.click('[data-testid="fs-pick-path"]')
    await page.waitForSelector('[data-testid="path-dialog"]')
    await page.click('[data-testid="pp-car-p"]')
    await page.locator('[data-testid^="pp-opt-p-"]').first().click()
    await page.click('[data-testid="pp-car-u"]')
    await page.locator('[data-testid^="pp-opt-u-"]').first().click()
    await page.click('[data-testid="pp-car-l"]')
    await page.locator('[data-testid^="pp-opt-l-"]').first().click()
    await page.waitForSelector('[data-testid="fs-nopath"]', { state: 'detached' })
  })

  it('★★ 问它问题时，**整篇文章真的进了上下文** —— 不用自己贴', async () => {
    mode = 'tutor'
    lastDocSeen = ''
    await page.fill('[data-testid="fs-input"]', 'What is wrong with the second paragraph?')
    await page.click('[data-testid="fs-send"]')
    await page.waitForSelector('[data-testid="fs-chat"] .msg.ai', { timeout: 20000 })

    // 这是这条需求的正题：使用者说「问它什么也不知道，还要我自己贴」
    assert.match(
      lastDocSeen,
      /demographic sink/,
      '发给 AI 的请求里没有左栏的文章 —— 那它当然什么都不知道'
    )
    assert.match(lastDocSeen, /hold sway over long-run growth/)
    assert.match(
      await page.locator('[data-testid="fs-chat"]').innerText(),
      /paragraph 2/,
      '导师没回应'
    )
  })

  /**
   * ★ 5.2 · Enlighten（理解）只讲不考。
   * 取代原来的「只答疑」—— 名字变了，但守的是同一件事，
   * 而且这一次更硬：Enlighten 下 `task` 必须是 null，这一层再兜一道。
   */
  it('★ 5.2 · Enlighten 模式下一道题都不出 —— 使用者说了算', async () => {
    mode = 'tutor' // 假 AI 这个模式**总是**带着 task 回来
    const before = await page.locator('.task').count()
    // 数量必须在**点击之前**取。取在后面的话，回复要是已经到了，
    // 条件一开始就不可能成立 —— 这条验收第一次就是这么假失败的
    const msgsBefore = await page
      .locator('[data-testid="fs-chat"] .msg.ai:not([data-testid="fs-hint"])')
      .count()

    await page.click('[data-testid="fs-mode-enlighten"]')
    await page.fill('[data-testid="fs-input"]', '就回答我：这个词为什么用 over？')
    await page.click('[data-testid="fs-send"]')
    await page.waitForFunction(
      (n) => document.querySelectorAll(
          '[data-testid="fs-chat"] .msg.ai:not([data-testid="fs-hint"])'
        ).length > n,
      msgsBefore,
      { timeout: 20000 }
    )
    assert.equal(
      await page.locator('.task').count(),
      before,
      '模型照样给了任务，而这一层没兜住 —— 他说别出题就是别出题'
    )
    // 而且请求里确实告诉了模型是哪个模式
    assert.match(lastDocSeen, /ENLIGHTEN/, '模式没传给模型')
  })

  /**
   * ★ 5.2 · 两个模式互斥，而且**当前模式在输入框边上看得见**。
   * 他打字时眼睛在输入框上 —— 模式只写在上面那两张卡上是不够的。
   */
  it('★ 5.2 · Enlighten / Quest 互斥，当前模式就在输入框旁边', async () => {
    assert.match(await page.innerText('[data-testid="fs-modetag"]'), /Enlighten/)

    await page.click('[data-testid="fs-mode-quest"]')
    const tag = await page.innerText('[data-testid="fs-modetag"]')
    assert.match(tag, /Quest/, `切到 Quest 之后徽标没跟着变：${tag}`)
    // 互斥：Quest 开着，Enlighten 那张卡就不能还是选中态
    assert.equal(
      await page.locator('[data-testid="fs-mode-enlighten"].on').count(),
      0,
      '两个模式同时亮着 —— 它们是互斥的'
    )
    // Quest 选体裁、Enlighten 选导师，同时只出现一个
    assert.equal(await page.locator('[data-testid="fs-genre"]').count(), 1, 'Quest 下没有体裁可选')
    assert.equal(await page.locator('[data-testid="fs-tutor"]').count(), 0, 'Quest 下还摆着导师下拉')

    await page.click('[data-testid="fs-mode-enlighten"]')
    assert.equal(await page.locator('[data-testid="fs-tutor"]').count(), 1)
    assert.equal(await page.locator('[data-testid="fs-genre"]').count(), 0)
  })

  it('★ 5.2 · Quest 按体裁出题，体裁的提示词真的进了请求', async () => {
    mode = 'tutor'
    await page.click('[data-testid="fs-mode-quest"]')
    const msgsBefore = await page
      .locator('[data-testid="fs-chat"] .msg.ai:not([data-testid="fs-hint"])')
      .count()
    await page.fill('[data-testid="fs-input"]', '开始')
    await page.click('[data-testid="fs-send"]')
    await page.waitForFunction(
      (n) => document.querySelectorAll(
          '[data-testid="fs-chat"] .msg.ai:not([data-testid="fs-hint"])'
        ).length > n,
      msgsBefore,
      { timeout: 20000 }
    )
    assert.match(lastDocSeen, /QUEST/, 'Quest 模式没传给模型')
    assert.match(lastDocSeen, /论说文|体裁/, '体裁的提示词没进请求 —— 那这个下拉框就是摆设')
    await page.click('[data-testid="fs-mode-enlighten"]')
  })

  /**
   * 问题卡能跳到它指的那一段（D-174）。
   *
   * ★「做完了 / 跳过」和状态角标已撤（使用者 2026-08-10：「看起来没什么意义」），
   *   **这一条盖过 D-081 的任务卡状态**。这里把「它们真的不在了」也钉住 ——
   *   撤掉一个东西和加一个东西一样需要验收，否则下一轮很容易被顺手加回来。
   */
  it('问题卡能跳到它指的那一段；自评按钮已撤（D-174 / 覆盖 D-081）', async () => {
    // 问题卡属于 Quest 那条流 —— 两个模式的聊天框是分开的，
    // 在 Enlighten 里当然看不见它。自己切过去，不靠上一条用例的收尾。
    await page.click('[data-testid="fs-mode-quest"]')
    const task = page.locator('[class="task"], .task').first()
    await task.waitFor()
    const text = await task.innerText()
    assert.match(text, /跳到第 2 段/)
    assert.doesNotMatch(text, /做完了|跳过|未完成|已完成/, `自评那套还在卡上：${text}`)
    await page.locator('[data-testid^="fs-goto-"]').first().click()
    await page.waitForSelector('.doc p.hl')
  })

  it('Findings 是第二个 Tab，内部按主动/被动分（D-168 / D-170）', async () => {
    await page.click('[data-testid="fs-tab-fnd"]')
    await page.waitForSelector('[data-testid="fs-findings"]')
    // Tab 名不带中文副标（D-170）
    const tabs = await page.locator('.rt2').innerText()
    assert.match(tabs, /Tutorial/)
    assert.match(tabs, /Findings/)
  })

  it('导师能在这一页临时切换（R-005）', async () => {
    await page.click('[data-testid="fs-tab-tut"]')
    // 导师下拉只在 Enlighten 下出现 —— 自己切过去，别指望上一条用例的收尾。
    // 上一条挂掉时这条会跟着红，那种连锁失败会盖住真正的病因。
    await page.click('[data-testid="fs-mode-enlighten"]')
    const opts = await page.locator('[data-testid="fs-tutor"] option').count()
    assert.ok(opts >= 3, `导师下拉里只有 ${opts} 个`)
  })

  it('标记读完之后回列表，它落到「读完」那一组（D-167）', async () => {
    await page.click('[data-testid="fs-mark-done"]')
    await page.waitForTimeout(300)
    await page.click('[data-testid="fs-back"]')
    await page.waitForSelector('[data-testid="fs-group-done"]')
    assert.match(await page.locator('.ugrp').last().innerText(), /读完/)
  })

  it('★ I-095 · 除「在读」外的分组默认收起，点一下才展开', async () => {
    // 「读完」那一组刚刚才有内容 —— 它应该是收着的
    assert.equal(
      await page.locator('[data-testid="fs-card-1"]').count(),
      0,
      '「读完」那一组一进来就摊开了 —— 使用者要的是只有「在读」默认展开'
    )
    await page.click('[data-testid="fs-group-done"]')
    await page.waitForSelector('[data-testid="fs-card-1"]', { timeout: 5000 })
  })

  /**
   * ★ 5.1 · 「转为 Lecture」已取消（使用者 2026-08-09）。
   *
   * D-172 那条就此作废。它解决的是「这篇想当正式材料学」，
   * 而文件学习本来就能就地分析、捞到的条目直接进设好的那一讲；
   * 多一条把正文复制进 lecture 的路，结果是同一篇正文在库里有两份，
   * **原文出处该指哪一份说不清** —— 而出处是 M-012 说不可丢失的字段。
   *
   * 这条守的是「入口确实不在了」。功能取消最容易留下半截：
   * 按钮删了、后端还在、某个角落还调得到。
   */
  it('★ 5.1 · 「转为 lecture」的入口确实撤掉了', async () => {
    await page.click('[data-testid="fs-card-1"]')
    await page.waitForSelector('[data-testid="fs-doc"]', { timeout: 8000 })
    assert.equal(await page.locator('[data-testid="fs-convert"]').count(), 0)
    assert.equal(
      await page.evaluate(() => 'convert' in (window.nyx.files as Record<string, unknown>)),
      false,
      'preload 里还留着 convert —— 功能取消要连接口一起撤，否则下一个人又会把它接回界面'
    )
    await page.click('[data-testid="fs-back"]')
  })

  it('★ I-095 · 四种状态随时能改，不是只能单向「标记读完」', async () => {
    await page.click('[data-testid="fs-card-1"]')
    await page.waitForSelector('[data-testid="fs-status"]')
    for (const st of ['reading', 'unread', 'shelved', 'done']) {
      assert.equal(await page.locator(`[data-testid="fs-mark-${st}"]`).count(), 1, `少了 ${st}`)
    }
    // 搁置：读了一半先放下 —— 没有这个去处，「在读」那一组迟早失真
    await page.click('[data-testid="fs-mark-shelved"]')
    await page.waitForTimeout(300)
    await page.click('[data-testid="fs-back"]')
    await page.waitForSelector('[data-testid="fs-group-shelved"]')

    // 放回「在读」—— 后面的用例还要点开这一篇，而收起来的分组是点不到的
    await page.click('[data-testid="fs-group-shelved"]')
    await page.click('[data-testid="fs-card-1"]')
    await page.waitForSelector('[data-testid="fs-status"]')
    await page.click('[data-testid="fs-mark-reading"]')
    await page.waitForTimeout(300)
    await page.click('[data-testid="fs-back"]')
    await page.waitForSelector('[data-testid="fs-card-1"]')
  })
})

describe('搜索 · 垃圾箱 · 项目页', () => {
  it('搜索是浮层，不是独立视图（D-196）', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="nav-search"]')
    await page.waitForSelector('[data-testid="search-overlay"]')
    // 浮层盖在当前页上 —— 底下的东西还在
    assert.ok((await page.locator('.side').count()) > 0)
  })

  it('搜得到知识点，也搜得到原文摘句（D-106 / M-012）', async () => {
    await page.fill('[data-testid="search-input"]', 'brunt')
    await page.waitForSelector('[data-testid="hit-0"]', { timeout: 5000 })
    const t = await page.locator('[data-testid="search-results"]').innerText()
    assert.match(t, /bear the brunt of/)
    assert.match(t, /知识点/, '结果没有按类型分组')
  })

  it('关键词高亮，↵ 打开', async () => {
    assert.ok((await page.locator('[data-testid="search-results"] em').count()) > 0, '没有高亮')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 8000 })
  })

  it('Esc 关掉浮层', async () => {
    await page.click('[data-testid="nav-search"]')
    await page.waitForSelector('[data-testid="search-overlay"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="search-overlay"]', { state: 'detached' })
  })

  it('垃圾箱：空的时候说清静默和删除是两回事（D-087）', async () => {
    await page.click('[data-testid="nav-trash"]')
    await page.waitForSelector('[data-testid="trash-empty"], .lrow', { timeout: 8000 })
    const t = await page.locator('.view.on').innerText()
    // ★ 从常量推 —— 保留期改了这条不该跟着改（使用者 2026-09-09 把 30 改成了 10）
    assert.match(t, new RegExp(TRASH_DAYS + ' 天'))
  })

  it('★ 删掉的条目进垃圾箱，能恢复回来（D-087 / D-090）', async () => {
    // 先从库里删一条
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"] .lrow')
    const before = await page.locator('[data-testid="lib-rows"] .lrow').count()
    const term = await page.locator('[data-testid="lib-rows"] .lrow .lt').first().innerText()
    await page.locator('[data-testid="lib-rows"] .lrow .ck').first().click()
    await page.click('[data-testid="bulk-del"]')
    // ★ B5（2026-09-08）· 删除一律先弹确认框（BTN-Q4），所以这里多一步「确认」
    await page.waitForSelector('[data-testid="bulk-del-dlg"]')
    await page.click('[data-testid="bulk-del-dlg-confirm"]')
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="lib-rows"] .lrow').length === n - 1,
      before
    )

    // 垃圾箱里找得到它，而且恢复得回来
    await page.click('[data-testid="nav-trash"]')
    await page.waitForSelector('.lrow', { timeout: 8000 })
    assert.match(await page.locator('.view.on').innerText(), new RegExp(term.slice(0, 8)))
    await page.locator('[data-testid^="restore-item-"]').first().click()
    await page.waitForSelector('[data-testid="toast-text"]')

    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"] .lrow')
    assert.equal(await page.locator('[data-testid="lib-rows"] .lrow').count(), before, '没恢复回来')
  })

  /**
   * ★★ D-469（2026-09-07）· 项目主页 / 单元主页取消。
   *
   * 这里原来三条：点项目名进项目页 · lecture 行的进度条是真数据 · 项目页下半的知识分布。
   * 那一页整个没了 —— 讲次是唯一的内容页，动作进了树节点的右键菜单（`smoke:nav` 里钉）。
   * 静默进度这件事本身没丢：判据（`IS_SILENT` + `rollupLecture`）在别处照旧用着；
   * 知识分布矩阵综合知识库里那张还在，而且点得进去。
   * ★ D-475（2026-09-08）· 原来这里写着「总览那一屏读的是同一份判据」——
   *   那一屏 2026-09-08 也删了（使用者裁 D-R7 = 3），说法跟着改。
   *
   * ★ 所以这里只留一条：**点项目名不许再把人带到别的页面去**。
   */
  it('★★ D-469 · 点项目名只展开它，人还站在原地', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    assert.equal(
      await page.locator('[data-testid="nav-project-1"]').count(),
      0,
      '「📊 项目总览」那一行还在'
    )
    await page.click('[data-testid="nav-toggle-project-1"]')
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('[data-testid="project-name"]').count(),
      0,
      '★★ 项目页又回来了 —— D-469 说树上的节点不是页面'
    )
    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '★★ 点项目把页面切走了'
    )
  })
})

describe('D-179 · 机制参数真的接进算法（不是装饰）', () => {
  it('练习页有常用项和高级区，改过标「已偏离默认值」', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-practice"]')
    await page.waitForSelector('[data-testid="param-dailyTarget"]')

    /**
     * ★★ D-478（使用者 2026-09-08）· 档位取消之后，「一次出几道」由他自己定 ——
     *   它必须在**常用项**里（不用展开高级区就看得见），而且出厂是 15 道。
     *   题型面板上那句「一次出几道在设置里自己定」指的就是这个控件：
     *   控件没了 = 那句话把他支到一个不存在的地方去。
     */
    assert.equal(
      await page.locator('[data-testid="param-questionsPerItem"]').count(),
      1,
      '★★ 设置 › 练习里没有「一次给一条知识点出几道题」'
    )
    assert.equal(
      await page.inputValue('[data-testid="param-input-questionsPerItem"]'),
      '15',
      '★ 出厂不是 15 道'
    )

    await page.click('[data-testid="param-advanced"]')
    await page.waitForSelector('[data-testid="param-silenceStreak"]')
    assert.match(
      await page.locator('[data-testid="param-adv-note"]').innerText(),
      /互相咬合/,
      '没提示这些参数互相咬合'
    )
  })

  it('★ 改了「静默所需连正确」，判分真的按新值走 —— 否则设置页就是装饰', async () => {
    // 改成 1：连对 1 次就该静默
    await page.fill('[data-testid="param-input-silenceStreak"]', '1')
    await page.locator('[data-testid="param-input-silenceStreak"]').blur()
    await page.waitForSelector('[data-testid="param-silenceStreak"] .dev', { timeout: 5000 })

    // 拿一条还在训练中的条目，答对一次，看它是不是立刻静默
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"] .lrow')
    const before = await page.locator('[data-testid="lib-rows"] .lrow').count()
    await page.locator('[data-testid="lib-rows"] .lrow .ck').first().click()
    await page.click('[data-testid="bulk-practice"]')

    mode = 'questions'
    await page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 })
    mode = 'score3'
    await page.fill('[data-testid="answer"]', 'Coastal towns bear the brunt of the storms.')
    await page.click('[data-testid="submit"]')
    await page.waitForSelector('[data-testid="outcome"]', { timeout: 25000 })
    assert.match(
      await page.locator('[data-testid="outcome"]').innerText(),
      /练成/,
      '把「练成所需连正确」改成 1 之后答对一次没练成 —— 参数没接进算法'
    )
    await page.click('[data-testid="practice-quit"]')

    // 还原，别影响后面的测试
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-practice"]')
    await page.click('[data-testid="param-reset"]')
    await page.waitForSelector('[data-testid="param-reset"]', { state: 'detached' })
    assert.ok(before > 0)
  })
})

describe('D-206 · 数据位置可见（零编程经验时的自救入口）', () => {
  it('说清数据在哪、多大、备份在哪', async () => {
    await page.click('[data-testid="set-tab-data"]')
    await page.waitForSelector('[data-testid="backup-now"]')
    const t = await page.locator('.sblk').last().innerText()
    assert.match(t, /nyx\.db/)
    assert.match(t, /整个文件夹拷走就是完整迁移/)
    assert.match(t, /nyx\.log/, '没告诉使用者崩了之后去哪找日志')
  })

  /**
   * 备份**列表**已从界面撤掉（使用者 2026-08-10），所以不能再靠「列表多一行」验收。
   * 但「点了到底有没有生成」这件事必须还验得了 —— 改成看它回报的那句话，
   * 里面带着刚写出来的文件名。撤掉显示不等于可以不验。
   */
  it('「立即备份」真的生成一份（列表已撤，看它回报的文件名）', async () => {
    await page.click('[data-testid="backup-now"]')
    await page.waitForSelector('[data-testid="backup-note"]', { timeout: 8000 })
    const note = await page.innerText('[data-testid="backup-note"]')
    assert.match(note, /nyx-\d{8}-\d{6}/, `没说出生成了哪一份：${note}`)
  })
})

describe('R-003 · 全局右键（菜单内容随选中的东西变）', () => {
  it('★ 在正文里选一段右键 → 能收进知识点库', async () => {
    await page.click('[data-testid="nav-files"]')
    await page.waitForSelector('[data-testid="fs-card-1"]', { timeout: 8000 })
    await page.click('[data-testid="fs-card-1"]')
    await page.waitForSelector('[data-testid="fs-doc"] p')

    /**
     * ★★ 2026-09-13 · 取字处从**左栏正文**换成了**右栏那条提示**（`fs-hint`）。
     *
     *   为什么换：他第 4.2 条把**文件学习正文**的右键改成了 Save 一条道
     *   （`Capture.svelte` 里 `.doc` 单独成一档，不再问「写作 / 理解」）。
     *   而这条用例要钉的是**「选层 → 选去处」那条路本身**，那条路还在，
     *   只是文件学习正文那一屏不走它了。
     *   `fs-hint` 是 `.msg`，仍然是 passage 档 —— 同一屏、同一条路，一条覆盖都没少。
     *   ★ 文件学习正文那一档由下面新加的那条用例专门钉。
     */
    // 右栏对话里的一条（`.msg`）—— 实测这一屏有四条
    await page.waitForSelector('.msg', { timeout: 8000 })
    await page.evaluate(() => {
      const p = document.querySelector('.msg')!
      const r = document.createRange()
      r.selectNodeContents(p)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    })
    await page.locator('.msg').first().click({ button: 'right' })
    await page.waitForSelector('[data-testid="ctx-menu"]')

    // I-062 · 第一步只问「主动还是被动」——
    // 判层是关于这条本身的（我要不要练到能写出来），去哪一讲只是归档。
    for (const b of ['ctx-layer-b', 'ctx-layer-a', 'ctx-speak', 'ctx-dict', 'ctx-copy']) {
      assert.equal(await page.locator(`[data-testid="${b}"]`).count(), 1, `右键菜单缺了 ${b}`)
    }
    assert.equal(
      await page.locator('[data-testid="ctx-here"]').count(),
      0,
      '还没选层就先问位置了 —— 顺序反了'
    )

    // 第二步才出现去处
    await page.click('[data-testid="ctx-layer-b"]')
    await page.waitForSelector('[data-testid="ctx-elsewhere"]')
    assert.match(await page.innerText('[data-testid="ctx-menu"]'), /写作层/)

    // I-093 · 选位置也是三段并排，而且**选完先显示出来、可以重选**，确认了才收
    await page.click('[data-testid="ctx-elsewhere"]')
    await page.waitForSelector('[data-testid="ctx-path-dialog"]')
    assert.equal(
      await page.locator('[data-testid="ctx-path-go"]').isDisabled(),
      true,
      '还没选位置，「收进来」就已经能按了'
    )
    await page.click('[data-testid="pp-car-p"]')
    await page.locator('[data-testid^="pp-opt-p-"]').first().click()
    await page.click('[data-testid="pp-car-u"]')
    await page.locator('[data-testid^="pp-opt-u-"]').first().click()
    await page.click('[data-testid="pp-car-l"]')
    await page.locator('[data-testid^="pp-opt-l-"]').first().click()

    // 选中的路径要显示出来，并且有「重新选择」
    await page.waitForSelector('[data-testid="ctx-path-chosen"]')
    assert.equal(await page.locator('[data-testid="ctx-path-reset"]').count(), 1)

    await page.click('[data-testid="ctx-path-go"]')
    await page.waitForSelector('[data-testid="toast-text"]', { timeout: 8000 })
    assert.match(
      await page.locator('[data-testid="toast-text"]').innerText(),
      /收进写作层了/
    )
  })

  /**
   * ★★ 4.2 · 文件学习正文里的右键 = **Save 一条道**（使用者 2026-09-13）
   *
   * 他的原话：「当我选中内容准备收进去时，原来其他无关的选项不要保留，只留下 Save……
   * 不要再让我在写作 / 理解之间进行选择。默认直接收进理解层。」
   *
   * ★ 成对钉：**该在的在**（Save · 朗读 · 查词 · 复制）、**该没的没**
   *   （选层那两颗 · 选去处那颗）。只钉前一半的话，选层那步被人加回来它照样绿。
   */
  it('★★ 4.2 · 文件学习正文右键：只有 Save，没有「选层」那一步', async () => {
    await page.click('[data-testid="nav-files"]')
    /**
     * ★ 这时**可能已经在文章里**了（列表根本没渲染，实测 `fs-card-*` 一个都没有）——
     *   所以先看一眼在哪儿：已经在正文里就直接用，还在列表就进去。
     *   写死「先点卡片」的话，这条用例的红说的是「列表没出来」，
     *   而它要钉的其实是右键菜单。
     */
    if (!(await page.locator('[data-testid="fs-doc"]').count())) {
      if (!(await page.locator('[data-testid="fs-card-1"]').isVisible().catch(() => false))) {
        await page.click('[data-testid="fs-group-unread"]').catch(() => {})
        await page.waitForTimeout(250)
      }
      await page.click('[data-testid="fs-card-1"]')
    }
    await page.waitForSelector('[data-testid="fs-doc"] p')

    await page.evaluate(() => {
      const p = document.querySelector('[data-testid="fs-doc"] p')!
      const r = document.createRange()
      r.selectNodeContents(p)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    })
    await page.locator('[data-testid="fs-doc"] p').first().click({ button: 'right' })
    await page.waitForSelector('[data-testid="ctx-menu"]')

    for (const b of ['ctx-save', 'ctx-speak', 'ctx-dict', 'ctx-copy']) {
      assert.equal(await page.locator(`[data-testid="${b}"]`).count(), 1, `右键菜单缺了 ${b}`)
    }
    for (const gone of ['ctx-layer-b', 'ctx-layer-a', 'ctx-here', 'ctx-elsewhere']) {
      assert.equal(
        await page.locator(`[data-testid="${gone}"]`).count(),
        0,
        `★ ${gone} 又回来了 —— Save 一条道被人加回了选层 / 选去处那一步`
      )
    }

    // 一颗按下去就收进理解层 —— 两个问题都不再问他
    await page.click('[data-testid="ctx-save"]')
    await page.waitForSelector('[data-testid="toast-text"]', { timeout: 8000 })
    assert.match(
      await page.locator('[data-testid="toast-text"]').innerText(),
      /理解层/,
      '★ Save 之后没说收进了哪一层'
    )
  })

  it('已入库的条目上右键 —— 不出现「加入」，它已经在库里了（D-039 的原意）', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"] .lrow')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="lib-rows"] .lrow .lt')!
      const r = document.createRange()
      r.selectNodeContents(el)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    })
    await page.locator('[data-testid="lib-rows"] .lrow .lt').first().click({ button: 'right' })
    await page.waitForSelector('[data-testid="ctx-menu"]')
    assert.equal(
      await page.locator('[data-testid="ctx-add"]').count(),
      0,
      '已入库条目上还出现了「加入」—— 那是个必然灰掉的选项'
    )
    await page.keyboard.press('Escape')
  })
})

describe('D-097 / D-134 · 攻坚诊断与针对性出题', () => {
  /** 自己铺一条全新的：不跟前面的测试抢条目，也不吃它们留下的状态 */
  it('铺状态：新建一讲，分析出一条全新条目，进入轮转', async () => {
    // 把「攻坚触发次数」调到 2，两次答错就进 —— 顺带再验一次参数真的生效
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-practice"]')
    await page.click('[data-testid="param-advanced"]')
    await page.fill('[data-testid="param-input-hardTrigger"]', '2')
    await page.locator('[data-testid="param-input-hardTrigger"]').blur()
    await page.waitForSelector('[data-testid="param-hardTrigger"] .dev')

    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="home-new"]')
    await page.waitForSelector('[data-testid="drop-original"]', { timeout: 8000 })
    await page.click('[data-testid="drop-original"] button')
    await page.fill('[data-testid="compose-title"]', '攻坚用材料')
    await page.fill('[data-testid="compose-text"]', 'The debt weighed on every decision.')
    await page.click('[data-testid="compose-submit"]')

    mode = 'hardItem'
    await page.click('[data-testid="analyze"]')
    await page.click('[data-testid="run-analyze"]')
    await page.waitForSelector('[data-testid="review-banner"]', { timeout: 25000 })
    await page.click('[data-testid="start-learning"]')
    await page.waitForSelector('[data-testid="go-practice"]', { timeout: 10000 })
  })

  /**
   * 一轮 = 一次作答。**只记第一次判定**（D-121），所以一个条目要练两次
   * 就得两轮 —— 这正是 lecture 级轮转「自动为每个条目撑开时间跨度」的意思（M-024）。
   */
  async function wrongRound(text: string): Promise<void> {
    mode = 'questions'
    await page.click('[data-testid="go-practice"]')
    await page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 })

    mode = 'score1'
    await page.fill('[data-testid="answer"]', text)
    await page.click('[data-testid="submit"]')
    await page.waitForSelector('[data-testid="scale"]', { timeout: 25000 })

    // 「跳过」只在改过两次之后才出现（D-121：改两次仍不过可以跳过，记为失败）
    await page.click('[data-testid="resubmit"]')
    await page.waitForTimeout(250)
    await page.click('[data-testid="resubmit"]')
    await page.waitForSelector('[data-testid="give-up"]', { timeout: 25000 })

    mode = 'diagnose' // D-165 · 结算时顺便出诊断，零额外成本
    await page.click('[data-testid="give-up"]')
    await page.waitForSelector('[data-testid="settlement"]', { timeout: 25000 })
  }

  it('答错两轮 → 进攻坚区（触发次数已调成 2）', async () => {
    await wrongRound('The debt weighed at every decision.')
    await page.click('[data-testid="settle-close"]')
    await page.waitForSelector('[data-testid="go-practice"]')
    await wrongRound('The debt weighed at their choices.')
  })

  it('★ 结算页给一句总评，横向看这一轮（D-127）', async () => {
    const s = page.locator('[data-testid="settle-summary"]')
    await s.waitFor({ timeout: 15000 })
    assert.match(await s.innerText(), /instead of/, '总评没出来')
  })

  it('★ 攻坚区给出「这一条为什么反复错」（M-032 / D-097）', async () => {
    await page.click('[data-testid="settle-close"]')
    await page.click('[data-testid="nav-hard"]')
    await page.waitForSelector('[data-testid="hard-rows"]', { timeout: 8000 })
    await page.locator('[data-testid="hard-rows"] .lrow').first().click()
    const diag = page.locator('[data-testid^="hard-diag-"]')
    await diag.waitFor({ timeout: 5000 })
    assert.match(await diag.innerText(), /为什么反复错/)
    assert.match(await diag.innerText(), /下次要做对的/, '没给出「下次要做对的那一件事」')
  })

  it('★ 攻坚区的题面用的是**你自己写错的那句**（D-134）', async () => {
    await page.click('[data-testid="hard-practice"]')
    await page.waitForSelector('[data-testid="question-prompt"]', { timeout: 25000 })
    const prompt = await page.locator('[data-testid="question-prompt"]').innerText()
    assert.match(
      prompt,
      /You wrote this before/,
      '攻坚区出的题跟普通练习一样 —— D-134 要求用你自己写错的句子当题面'
    )
    assert.match(prompt, /weighed at/, '题面里没有你写过的那个错句')
    await page.click('[data-testid="practice-quit"]')

    // 还原参数，别影响后面
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-practice"]')
    await page.click('[data-testid="param-reset"]')
  })
})

/**
 * ★★ D-467（2026-09-07）· 水平评估整块取消（使用者：分析报告里的「个人档案」删掉）。
 *
 * 原来这里有五条：保守基线的说明 · 客观事实存得下 · 评出两个等级 ·
 * 冷启动五道诊断题 · 答完能交上去评。那些界面与后端（`assess.ts` · 六条 `level:*` ·
 * 两份提示词）全删了，用例跟着删 —— 留着测一个不存在的东西没有意义。
 *
 * **但有一条必须留下来并改写**：原来那条「★ 评估结果真的喂进了判层 —— 否则又是装饰」。
 * 判层与出题的提示词里那个 `{{LEVEL}}` **还在**（M-006 表达差距法要它）；
 * 评估没了之后它填的是固定基线（`@core/level-baseline.ts`）。
 * 这条链一旦断掉，症状是**静默的**：`fill` 只在变量没人填时才抛，
 * 而填成一个空串 / `undefined` 照样发得出去，AI 照样返回东西 ——
 * 只是它按一个不存在的水平在判层。所以这里仍旧钉「发出去的请求里带的是什么」。
 */
describe('D-467 · 判层用固定基线（「我的水平」整块取消）', () => {
  it('★ 报告页上「我的水平」一点痕迹都没有', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="home-report"]')
    await page.waitForSelector('[data-testid="report-title"]', { timeout: 15000 })
    for (const gone of [
      'mylevel', 'level-none', 'level-current', 'level-history-row',
      'run-assess', 'start-cold', 'fact-exams', 'fact-goal', 'save-facts'
    ]) {
      assert.equal(
        await page.locator(`[data-testid="${gone}"]`).count(),
        0,
        `★ 「${gone}」还在报告页上 —— D-467 是整块取消，不是隐藏`
      )
    }
  })

  it('★★ 固定基线真的填进了发给 AI 的请求 —— 断了就是在按一个不存在的水平判层', async () => {
    lastDocSeen = ''
    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="home-new"]')
    await page.waitForSelector('[data-testid="drop-original"]', { timeout: 8000 })
    await page.click('[data-testid="drop-original"] button')
    await page.fill('[data-testid="compose-title"]', '验基线的材料')
    await page.fill('[data-testid="compose-text"]', 'A short passage to check the level wiring.')
    await page.click('[data-testid="compose-submit"]')

    mode = 'tutor' // 这个模式会把收到的请求原样记下来
    await page.click('[data-testid="analyze"]')
    await page.click('[data-testid="run-analyze"]')
    await page.waitForTimeout(1500)
    assert.match(
      lastDocSeen,
      /upper-intermediate \(B2\)/,
      '★★ 分析请求里没有那行固定基线 —— {{LEVEL}} 这条链断了，而它不会报错'
    )
    mode = 'items'
  })
})

describe('D-040 / D-094 · 朗读（D-466 · 两个开关）', () => {
  /**
   * ★ 这一整块原来有五条：来源拖动排序、八家提供者的徽章、云端没配 key 时
   *   退回系统音、缓存占用与清空。D-466（使用者 2026-09-07「语音设置简化」）
   *   把那条线整条撤了 —— 现在这一页只剩两个开关 + 口音 / 语速 + 试听 + 诊断行。
   *   **两个开关自己的行为归 `smoke:voice`**（那一套专门盯它），这里只留
   *   「口音语速存得住」与「D-094 详情页有、列表行没有」这两条页面级的。
   *
   * ★ 每次进这一页先等 `voice-switches` —— 页面**读到数据才画控件**
   *   （否则点一下会把整包默认值写回去）。等一个确定的标记，比靠 `click`
   *   自己的隐式等待稳。
   */
  it('口音、语速存得住，重开设置页还在', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-tts"]')
    await page.waitForSelector('[data-testid="voice-switches"]')
    await page.click('[data-testid="tts-us"]')
    await page.locator('[data-testid="tts-rate"]').fill('0.8')
    await page.locator('[data-testid="tts-rate"]').dispatchEvent('input')
    await page.waitForTimeout(300)

    // 离开再回来 —— 存的是数据库，不是组件里的一个变量
    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-tts"]')
    await page.waitForSelector('[data-testid="voice-switches"]')
    await page.waitForSelector('[data-testid="tts-us"].on')
    assert.equal(await page.locator('[data-testid="tts-rate"]').inputValue(), '0.8')
  })

  it('★★ 两个开关画出来了，出厂都是开的（细账归 smoke:voice）', async () => {
    const on = await page.evaluate(() =>
      ['dictionary', 'system'].map(
        (id) =>
          document.querySelector(`[data-testid="voice-on-${id}"]`)?.getAttribute('aria-checked') ??
          '缺'
      )
    )
    assert.deepEqual(on, ['true', 'true'], `★★ 出厂该是两个都开：${on.join(' · ')}`)
  })

  it('语速夹在 0.7–1.3 之间（D-040 就是这个范围）', async () => {
    const min = await page.locator('[data-testid="tts-rate"]').getAttribute('min')
    const max = await page.locator('[data-testid="tts-rate"]').getAttribute('max')
    assert.deepEqual([min, max], ['0.7', '1.3'])
  })

  it('★★ 诊断行说得出「上次朗读走了谁」', async () => {
    await page.click('[data-testid="tts-try"]')
    await page.waitForSelector('[data-testid="tts-note"]')
    await page.waitForTimeout(300)
    const trace = await page.innerText('[data-testid="voice-trace"]')
    assert.match(
      trace,
      /出的声|一个都没成/,
      `★★ 读完了，诊断行还是空的 —— 他没地方看「为什么不是词典音」：${trace.slice(0, 120)}`
    )
    assert.ok(
      /系统语音|词典语音/.test(trace),
      `★★ 诊断行里没有任何一档的名字：${trace.slice(0, 120)}`
    )
  })

  it('D-094 · 详情页有朗读，列表行里没有', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    assert.equal(
      await page.locator('[data-testid="lib-rows"] [data-testid="detail-speak"]').count(),
      0,
      '列表行里冒出了喇叭 —— D-094 明确说列表行里没有'
    )

    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    await page.locator('[data-testid="item-rows"] .lrow').first().click()
    await page.waitForSelector('[data-testid="detail-speak"]', { timeout: 10000 })
  })
})

/**
 * D-068 · 链接抓取入口已删除（I-073）。
 * 使用者的原话：「网络链接和 pdf 依旧不能读取…把链接和 pdf 这两个接口删除吧。」
 * 抓取在真实网页上的成功率撑不住这个入口，与其留一个大概率失败的按钮，
 * 不如当场说清不支持 —— 所以这里改成守住「入口确实不在了」。
 */
describe('I-073 · 链接与 PDF 入口已撤掉', () => {
  it('落区里没有「链接」这一格', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="home-new"]')
    await page.waitForSelector('[data-testid="drop-original"]', { timeout: 8000 })
    assert.equal(await page.locator('[data-testid="drop-link"]').count(), 0)
    assert.equal(await page.locator('[data-testid="fetch-url"]').count(), 0)
    await page.click('[data-testid="drop-paste"]')
    assert.equal(await page.locator('[data-testid="fetch-url"]').count(), 0)
    await page.click('[data-testid="compose-cancel"]')
  })

  it('文件学习页里也没有链接框', async () => {
    await page.click('[data-testid="nav-files"]')
    await page.waitForSelector('[data-testid="fs-add"], [data-testid="fs-add-empty"]', {
      timeout: 8000
    })
    await page
      .locator('[data-testid="fs-add"], [data-testid="fs-add-empty"]')
      .first()
      .click()
    await page.waitForSelector('[data-testid="fs-compose"]')
    assert.equal(await page.locator('[data-testid="fs-url"]').count(), 0)
    assert.equal(await page.locator('[data-testid="fs-grab"]').count(), 0)
    // I-094 · 它现在是弹窗了 —— 不关掉会把后面所有用例挡住
    await page.click('[data-testid="fs-cancel"]')
    await page.waitForSelector('[data-testid="fs-compose"]', { state: 'detached' })
  })
})

describe('D-064 / I-002 · 手动加一条（工作台上那两个按钮不能是死的）', () => {
  it('★ 加完自动切到它所在的 Tab —— 否则「看起来没反应」', async () => {
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-self"]') // 故意停在另一个 Tab
    await page.click('[data-testid="add-item"]')
    await page.waitForSelector('[data-testid="add-item-form"]')

    await page.fill('[data-testid="ai-term"]', 'take root')
    await page.fill('[data-testid="ai-gloss"]', 'to become established')
    await page.fill('[data-testid="ai-quote"]', 'The idea took root in the 1970s.')
    await page.click('[data-testid="ai-layer-b"]')
    await page.click('[data-testid="ai-submit"]')

    await page.waitForSelector('[data-testid="toast-text"]')
    // I-002 的正题：新条目落进主动词汇 Tab，界面必须跟着切过去
    await page.waitForSelector('[data-testid="tab-active"].on')
    assert.match(await page.innerText('[data-testid="item-rows"]'), /take root/)
  })

  it('M-012 · 出处填了就存下来，没填也不假装有', async () => {
    await page.locator('[data-testid="item-rows"] .lrow', { hasText: 'take root' }).click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })
    assert.match(await page.innerText('[data-testid="detail-quote"]'), /took root in the 1970s/)
    await page.click('[data-testid="global-back"]')
  })

  it('空的表达不让加，而且说清为什么', async () => {
    await page.click('[data-testid="add-item"]')
    await page.click('[data-testid="ai-submit"]')
    await page.waitForSelector('[data-testid="add-item-error"]')
    await page.click('[data-testid="ai-cancel"]')
  })

  it('••• 里能改名，改完到处都跟着变（D-185）', async () => {
    await page.click('[data-testid="lecture-menu"]')
    await page.waitForSelector('[data-testid="lecture-menu-open"]')
    // I-077 · 改名是二级动作，先点「改名…」才出输入框
    await page.click('[data-testid="lecture-rename"]')
    await page.fill('[data-testid="rename-input"]', '改过名字的一讲')
    await page.click('[data-testid="rename-go"]')
    await page.waitForFunction(() =>
      (document.querySelector('.lname')?.textContent ?? '').includes('改过名字的一讲')
    )
    // 侧边栏那份是另一处派生显示，也得跟着变
    await page.click('[data-testid="nav-home"]')
    await page.waitForFunction(() =>
      (document.querySelector('[data-testid="nav-lecture-1"]')?.textContent ?? '').includes(
        '改过名字的一讲'
      )
    )
  })
})

describe('I-064 · 文件学习：逐级选路径 · AI 回答分段', () => {
  it('★ 路径不再平铺 —— 弹窗按 项目 › 单元 › lecture 一级级缩小', async () => {
    await page.click('[data-testid="nav-files"]')
    await page.waitForSelector('[data-testid="fs-add"]', { timeout: 8000 })
    await page.click('[data-testid="fs-add"]')
    await page.fill('[data-testid="fs-title"]', '路径选择验收')
    await page.fill('[data-testid="fs-text"]', 'A short passage for the path picker.')
    await page.click('[data-testid="fs-save"]')

    await page.waitForSelector('[data-testid="fs-pick-path"]', { timeout: 8000 })
    await page.click('[data-testid="fs-pick-path"]')
    await page.waitForSelector('[data-testid="path-dialog"]')

    // I-093 · 三段**同时**在屏幕上，不是一级一级往下点
    assert.equal(await page.locator('[data-testid="pp-in-p"]').count(), 1)
    assert.equal(await page.locator('[data-testid="pp-in-u"]').count(), 1)
    assert.equal(await page.locator('[data-testid="pp-in-l"]').count(), 1)
    // 上一级没选之前，下面两段是关着的 —— 不给点不动的框
    assert.equal(await page.locator('[data-testid="pp-in-u"]').isDisabled(), true)

    await page.click('[data-testid="pp-car-p"]')
    await page.locator('[data-testid^="pp-opt-p-"]').first().click()
    await page.click('[data-testid="pp-car-u"]')
    await page.locator('[data-testid^="pp-opt-u-"]').first().click()
    await page.click('[data-testid="pp-car-l"]')
    await page.locator('[data-testid^="pp-opt-l-"]').first().click()

    await page.waitForSelector('[data-testid="path-dialog"]', { state: 'detached' })
    assert.equal(await page.locator('[data-testid="fs-nopath"]').count(), 0, '路径没设上')
  })

  it('★ I-093 · 横线上打一个不存在的名字，回车就建出来', async () => {
    await page.click('[data-testid="fs-pick-path"]')
    await page.waitForSelector('[data-testid="path-dialog"]')

    await page.fill('[data-testid="pp-in-p"]', '横线建的项目')
    // 下拉顶上要给「＋ 新建」，而不是一片空白
    await page.waitForSelector('[data-testid="pp-new-p"]')
    await page.press('[data-testid="pp-in-p"]', 'Enter')

    // 建完自动选中它，下一段跟着开
    await page.waitForFunction(
      () => !(document.querySelector('[data-testid="pp-in-u"]') as HTMLInputElement)?.disabled,
      undefined,
      { timeout: 8000 }
    )
    await page.fill('[data-testid="pp-in-u"]', '横线建的单元')
    await page.press('[data-testid="pp-in-u"]', 'Enter')
    await page.waitForFunction(
      () => !(document.querySelector('[data-testid="pp-in-l"]') as HTMLInputElement)?.disabled,
      undefined,
      { timeout: 8000 }
    )
    await page.fill('[data-testid="pp-in-l"]', '横线建的一讲')
    await page.press('[data-testid="pp-in-l"]', 'Enter')

    // 选到 lecture 就算设好，弹窗自己收
    await page.waitForSelector('[data-testid="path-dialog"]', { state: 'detached', timeout: 8000 })
    assert.match(await page.locator('[data-testid="fs-doc"]').innerText(), /横线建的一讲/)
  })

  it('★ I-080 · 就地新建的项目，侧边栏立刻看得见（不用重启）', async () => {
    // 使用者报的是「新建的路径在左边树里没有出现」。根因不在这一页：
    // 主进程只在同步和清库时广播 data:changed，界面上建的东西一声不吭，
    // 侧边栏那份树就一直是旧的（D-185 说「改一处，全部派生显示自动同步」）。
    const before = await page.locator('[data-testid^="nav-toggle-project-"]').count()

    // I-090 · 路径设好之后也要能改 —— 以前那一行只是死字，没有入口
    await page.click('[data-testid="fs-pick-path"]')
    await page.waitForSelector('[data-testid="path-dialog"]')
    await page.fill('[data-testid="pp-in-p"]', '就地建的项目')
    await page.waitForSelector('[data-testid="pp-new-p"]')
    await page.click('[data-testid="pp-new-p"]')

    // 建完停在「选单元」那一级；关键是**这时候侧边栏就该有它了**，不等刷新
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid^="nav-toggle-project-"]').length > n,
      before,
      { timeout: 8000 }
    )
    assert.match(
      await page.locator('[data-testid="project-area"]').innerText(),
      /就地建的项目/,
      '新建的项目没出现在侧边栏 —— 树没跟着变'
    )
    await page.click('[data-testid="path-dialog"]', { position: { x: 5, y: 5 } })
  })

  it('★ AI 的回答按段落渲染，不是一大坨', async () => {
    mode = 'tutor'
    await page.fill('[data-testid="fs-input"]', '这一段的论证有什么问题？')
    await page.click('[data-testid="fs-send"]')
    await page.waitForSelector('.msg.ai .msg-p', { timeout: 25000 })
    assert.ok(
      (await page.locator('.msg.ai .msg-p').count()) >= 1,
      'AI 回答没有分段 —— 还是一整块'
    )
    mode = 'items'
  })
})

describe('I-061 / T-4.13 · 随时认读 · 随时练习（排期是推荐，不是门禁）', () => {
  /**
   * ★★★ T-4.13 / D-R28（使用者 2026-09-07 第四批 二 · 八 · 九）
   *
   * 「排期是一种推荐机制，而不是练习权限控制。」
   *
   * 判据（`testCards` 不看到期日）从 I-061 起就是对的，**病在够不着和说不清**：
   * 那条路只在树的右键菜单里，讲次页面上没有；而页面上写着的
   * 「今日练习 · 认读 N」读起来就是「今天只能练这些」。
   * 所以这一段验的是**他在屏幕上看得见的东西**：
   *   ① 入口在页面上，不用右键；
   *   ② 「推荐」和「可练」分得开（文案）；
   *   ③ 不到期照样练得成，而且**练了算数**（review_logs 多一行 · 卡的日期往后动）；
   *   ④ 一次随时认读**不给整讲重新定期**（T-4.13 头注那条边界）。
   *
   * ★ 负向对照：把 `Workbench.svelte` 那两颗「随时认读 / 随时练习」删掉 → ① 当场红。
   */
  it('★★ T-4.13 · 讲次页上直接就有「随时认读」「随时练习」，不用去右键菜单', async () => {
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.waitForSelector('[data-testid="lecture-test"]', { timeout: 8000 })
    for (const [id, word] of [
      ['lecture-test', '随时认读'],
      ['lecture-test-practice', '随时练习']
    ] as const) {
      const b = page.locator(`[data-testid="${id}"]`)
      assert.equal(await b.count(), 1, `★★ 讲次页上没有 ${id} —— 随时练又退回右键菜单里了`)
      assert.ok(await b.isVisible(), `★★ ${id} 在页面上看不见`)
      assert.match(await b.innerText(), new RegExp(word), `★ ${id} 的字不是「${word}」`)
    }
  })

  it('★ 弹窗能选乱序和两条线，而且进来时那一条已经选好了', async () => {
    await page.click('[data-testid="lecture-test"]')
    await page.waitForSelector('[data-testid="test-dialog"]')
    for (const b of ['test-shuffle', 'test-reading', 'test-practice']) {
      assert.equal(await page.locator(`[data-testid="${b}"]`).count(), 1, `弹窗缺了 ${b}`)
    }
    assert.match(await page.innerText('[data-testid="test-dialog"]'), /不看到期日/)
    // ★ T-4.13 · 从「随时认读」进来 → 认读那颗是主按钮，练习那颗**仍然在**（改主意不用退出去）
    assert.match(await page.innerText('[data-testid="test-dialog-title"]'), /随时认读/)
    const cls = async (id: string): Promise<string> =>
      (await page.locator(`[data-testid="${id}"]`).getAttribute('class')) ?? ''
    const isPri = async (id: string): Promise<boolean> => (await cls(id)).split(' ').includes('pri')
    assert.ok(await isPri('test-reading'), '★ 从「随时认读」进来，认读那颗却不是主按钮')
    assert.equal(await isPri('test-practice'), false, '★ 两颗都是主按钮 = 等于没预选')
  })

  it('★ 不看到期日 —— 今天没有到期的卡，认读测试照样有题', async () => {
    // 这一讲的卡刚练过，按日程今天不该出现；随时测必须照样给
    await page.click('[data-testid="test-shuffle"]')
    await page.click('[data-testid="test-reading"]')
    await page.waitForSelector('[data-testid="reading-overlay"]', { timeout: 8000 })
    assert.equal(
      await page.locator('[data-testid="reading-empty"]').count(),
      0,
      '随时测还是被到期日挡住了 —— 那它就不是「想测就能测」'
    )
    await page.waitForSelector('[data-testid="card-front"]', { timeout: 8000 })
    await page.click('[data-testid="reading-quit"]')
  })

  /**
   * ★★★ T-4.13 · **练了就算数** —— 不到期的那一场，事件照写、卡的日期照动。
   *
   * 「可以随时练习」不意味着排期系统失效（使用者原话 二·5）：
   * 判分仍然走同一套 SM-2，`review_logs` 仍然多一行 —— 否则这条路练完
   * 什么都没留下，报告里看不见，下次推荐也不认账，等于白练。
   *
   * ★ 同时守住另一头：**一次随时认读不给整讲重新定期**
   *   （`main/study/lecture.ts::settleLectures` 头上那条边界，两端同一条）。
   *   认读线本来就不做讲次结算 —— 这一条钉的是「将来别长出来」。
   */
  it('★★★ 不到期照样练得成，而且练了算数：review_logs 多一行 · 卡的日期动 · 讲次间隔不动', async () => {
    /**
     * ★ 这一条**自己造一讲**，不蹭第 1 讲。
     *
     *   第 1 讲的卡被前面十几条用例练过、静默过 —— 而随时认读**会把静默的卡也给出来**
     *   （`reading.ts::testCards` 头注：静默是「不再轮转」不是「不许再碰」）。
     *   于是抽到哪一张全看运气：抽到没静默的就绿，抽到静默的就红在
     *   `applyReadingGrade` 那句「这张卡已经静默了，不该再排期（D-024 / D-135）」上。
     *   **那是一条真的产品缝**（已单独报给主控），但不该由这一条用例来碰运气验它。
     *   这里要验的是「不到期也练得成、练了算数」，所以造一张干净的、
     *   已经被推到明天的卡，结论只跟被验的那件事有关。
     */
    const probe = await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('T-4.13 · 随时练')
      const u = await window.nyx.data.createUnit(p, 'U')
      const l = await window.nyx.data.createLecture(u, '不到期的一讲')
      const it = await window.nyx.data.addItem(
        l,
        'anytime probe',
        'a probe for T-4.13',
        'B',
        'This is an anytime probe.'
      )
      await window.nyx.study.startLearning(l)
      // 先按日程练一次 —— 把这张卡推到明天，于是它「今天不到期」（前提，不是被验的东西）
      await window.nyx.study.gradeCard(it.id, 3)
      return { lecture: l, item: it.id }
    })

    type Snap = { logs: number; cards: Map<number, number>; lecIv: number; lecDue: number | null }
    const snap = (): Snap => {
      const d = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
      const logs = (
        d.prepare(`select count(*) as n from review_logs where line = 'reading'`).get() as {
          n: number
        }
      ).n
      const rows = d
        .prepare(`select item_id as id, due_at as due from reading_cards`)
        .all() as { id: number; due: number }[]
      const lec = d
        .prepare(`select interval_days as iv, due_at as due from lectures where id = ?`)
        .get(probe.lecture) as { iv: number; due: number | null }
      d.close()
      return { logs, cards: new Map(rows.map((r) => [r.id, r.due])), lecIv: lec.iv, lecDue: lec.due }
    }

    // 前提要成立：这张卡今天**不到期**（不然「不看到期日」根本没被验到）
    const due = await page.evaluate(async () => {
      const cards = await window.nyx.study.dueCards(null, 999)
      return cards.map((c) => c.term)
    })
    assert.ok(
      !due.includes('anytime probe'),
      '前提没成立：这张卡今天还到期着 —— 那这一条验的就不是「不到期也能练」'
    )

    const before = snap()
    // 走**页面上那个入口**（不是右键菜单、也不是直接调 IPC）—— 验的就是他点得到的那条路
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, probe.lecture)
    await page.waitForSelector('[data-testid="lecture-test"]', { timeout: 8000 })
    await page.click('[data-testid="lecture-test"]')
    await page.waitForSelector('[data-testid="test-dialog"]')
    await page.click('[data-testid="test-reading"]')
    await page.waitForSelector('[data-testid="card-front"]', { timeout: 8000 })
    await page.click('[data-testid="flip"]')
    await page.waitForSelector('[data-testid="card-back"]')
    // 「太简单」——间隔一定往上走，`due_at` 必然换一天（`dueAfter` 按整天取）
    await page.click('[data-testid="grade-4"]')

    /**
     * ★ 等的是**判分真的落库**，不是「睡 800 毫秒」。
     *   第一版睡了 800ms 就往下走：单跑绿，进了 `verify`（机器忙）就红，
     *   而红的位置在关浮层那一步 —— 真正的原因（判分慢了 / 没成）反而被盖住了。
     */
    let after = snap()
    for (let i = 0; i < 24 && after.logs === before.logs; i++) {
      await page.waitForTimeout(250)
      after = snap()
    }

    /**
     * ★★ 先关浮层，再断言。
     *
     *   判分之后可能停在三种分支上：下一张卡（有「结束」）· 练完了（有「回工作台」）·
     *   **出错了**（`reading-error`，那两颗按钮没有 testid）。前两种能点，第三种点不到 ——
     *   于是浮层留在屏幕上，把后面三十多条一起拖红（verify 里真发生过）。
     *   Esc 走 `esc-stack`（`Reading.svelte` 自己注册的那一条），**三种分支都关得掉**。
     * ★ 断言放在关掉之后：这一条自己红是对的，但绝不该顺手弄红别人。
     */
    const saidBefore = await page.innerText('[data-testid="reading-overlay"]').catch(() => '')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="reading-overlay"]', {
      state: 'detached',
      timeout: 8000
    })

    assert.equal(
      after.logs,
      before.logs + 1,
      `★★★ 随时认读判了一次分，review_logs 却没多一行 —— 这一场白练了。当时那一屏：${saidBefore
        .replace(/[\s]+/g, ' ')
        .slice(0, 200)}`
    )
    const moved = [...after.cards].filter(([id, due]) => before.cards.get(id) !== due)
    assert.equal(
      moved.length,
      1,
      `★★★ 判分该把那张卡的下次日期往后推 —— 实际动了 ${moved.length} 张：${JSON.stringify(moved)}`
    )
    assert.equal(
      after.lecIv,
      before.lecIv,
      '★★ 一次随时认读把整讲的间隔改了 —— 那几条代表不了这一讲（T-4.13 头注）'
    )
    assert.equal(after.lecDue, before.lecDue, '★★ 一次随时认读把整讲的到期日改了')
  })

  /**
   * ★★ T-4.13 ·「推荐」和「可练」得在同一屏上分得开。
   * 这一条量的是**他读到的字**：数字旁边写着「推荐」，随时那两个入口不写。
   * 负向对照：把 `Home.svelte` 的 `today-recommend` 删掉、或把「· 推荐」从
   * `start-reading` 上拿掉 → 这一条当场红。
   */
  it('★★ T-4.13 · 「推荐」与「可练」在屏幕上分得开（讲次页 · 首页 · 项目页）', async () => {
    // ── 讲次页 ────────────────────────────────────────────
    assert.match(
      await page.innerText('[data-testid="go-reading"]'),
      /推荐/,
      '★★ 到期那个入口没标「推荐」—— 它读起来就成了「只有这些能练」'
    )
    assert.doesNotMatch(
      await page.innerText('[data-testid="lecture-test"]'),
      /推荐/,
      '★ 随时入口不该顶着「推荐」两个字'
    )
    const note = await page.innerText('[data-testid="anytime-note"]')
    assert.match(note, /推荐/)
    assert.match(note, /不到期也能练/, `★★ 讲次页没说清不到期也能练：${note}`)

    // ── 首页 ──────────────────────────────────────────────
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="today-recommend"]', { timeout: 8000 })
    const home = await page.innerText('[data-testid="today-recommend"]')
    assert.match(home, /推荐/, '★★ 首页「今日」没写明这是推荐')
    assert.match(home, /随时认读|随时练习/, '★★ 首页没说随时能练的入口在哪')
    assert.match(
      await page.innerText('[data-testid="start-reading"]'),
      /推荐\s*\d+/,
      '★★ 首页那个到期数字没标「推荐」'
    )

    // ── 树节点的右键菜单（D-469 之后「随时认读 / 练习」住在这里）────
    await page.click('[data-testid^="nav-toggle-project-"]', { button: 'right' })
    await page.waitForSelector('[data-testid="tree-menu"]', { timeout: 8000 })
    assert.match(await page.innerText('[data-testid="tree-test"]'), /随时认读|随时练习/)
    await page.click('[data-testid="tree-test"]')
    await page.waitForSelector('[data-testid="test-dialog"]', { timeout: 8000 })
    // 弹窗里两条线都在，而且把「不看到期日」当面说清（T-4.13 / D-R28）
    assert.equal(await page.locator('[data-testid="test-reading"]').count(), 1)
    assert.equal(
      await page.locator('[data-testid="test-practice"]').count(),
      1,
      '★★ 弹窗里没有「随时练习」'
    )
    assert.match(await page.innerText('[data-testid="test-dialog"]'), /不看到期日/)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // 回到讲次页 —— 下一条用例从这里接着走
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.waitForSelector('[data-testid="lecture-test"]', { timeout: 8000 })
  })

  it('产出那一侧也不看状态', async () => {
    await page.click('[data-testid="lecture-test"]')
    await page.waitForSelector('[data-testid="test-dialog"]')
    await page.click('[data-testid="test-practice"]')
    await page.waitForSelector('[data-testid="practice-overlay"], [data-testid="question-prompt"]', {
      timeout: 20000
    })
    assert.match(await page.innerText('body'), /随时测/)
    // 用真的关闭入口 —— Escape 这个浮层不接，浮层不关会挡住后面全部验收
    await page.click('[data-testid="practice-quit"]')
    await page.waitForSelector('[data-testid="practice-overlay"]', { state: 'detached' })
  })
})

describe('D-265 · 自检（使用者能自己验证「它真的在工作」）', () => {
  it('点一下就报出结构版本、SQLite 版本和各表条数', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-data"]')
    await page.click('[data-testid="self-test"]')
    await page.waitForSelector('[data-testid="self-test-out"]')
    const t = await page.innerText('[data-testid="self-test-out"]')
    assert.match(t, /一切正常/)
    assert.match(t, /知识点 \d+/, '没报出条数 —— 那这个自检等于没说话')
    // occurrences 没有 deleted_at，写死 `where deleted_at is null` 会在这里当场炸
    assert.match(t, /原文出处 \d+/)
  })
})

describe('D-151 / D-234 · 本地词典（放进目录就认）', () => {
  it('放一本进去 → 点重新扫描 → 列表里出现，并且真能查到词', async () => {
    // D-151 ·「使用者把文件放进指定目录，软件自动识别」—— 就照这个流程走一遍
    // I-106 · 词典目录挪到了 `data/dicts` —— 使用者自己的东西一律在 data/ 里面，
    // 这样更新软件时清空程序目录不会再删到它（我删过他 22 本）
    writePlainDict(join(dataRoot, 'data', 'dicts', '测试词典'), '测试词典', [
      { word: 'brunt', body: 'n. 冲击\nCoastal towns bear the brunt of these storms.' }
    ])

    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-dict"]')
    await page.click('[data-testid="dict-rescan"]')
    await page.waitForSelector('[data-testid="dict-row"]')
    assert.match(await page.innerText('[data-testid="dict-row"]'), /测试词典/)

    /**
     * ★ D-470（2026-09-07）· 设置页那个「随便查一个词试试」取消了。
     *   「真能查到词」这一半改由**他真的用到词典的地方**回答 —— 下面 D-150 那条
     *   （例句里出现词典给的句子并标着来源）与悬浮卡片那几条钉的就是它。
     *   这里只验设置页该管的：放进去 → 扫一次 → 列表里出现，并说出扫到几本。
     */
    await page.waitForSelector('[data-testid="dict-note"]', { timeout: 8000 })
    assert.match(await page.innerText('[data-testid="dict-note"]'), /扫到 \d+ 本/)
  })

  /**
   * ★★ D-470（2026-09-07）· 词典这一页只剩五样东西
   *
   * 使用者点名取消「随便查一个词试试」。这一条钉的是**取消之后这一页还剩什么**：
   * 打开文件夹 · 重新扫描 · 顺序（↑↓）· 启用 / 停用 · 每本的问题说明。
   * 探针不许回来 —— 它一回来，「词典接上没有」就又有了两个说法
   * （设置页一个、真正查词的地方一个），而那两个迟早会不一致。
   *
   * ★ 负向对照：把探针那两个控件塞回 Settings.svelte → 这一条当场红。
   */
  it('★★ D-470 · 词典页只剩五样东西，没有「随便查一个词试试」', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-dict"]')
    await page.waitForSelector('[data-testid="dict-row"]', { timeout: 8000 })
    for (const gone of ['dict-probe', 'dict-probe-go', 'dict-probe-out']) {
      assert.equal(
        await page.locator(`[data-testid="${gone}"]`).count(),
        0,
        `★★ 「${gone}」还在词典页上 —— D-470 是取消，不是隐藏`
      )
    }
    const body = await page.innerText('.view')
    assert.ok(!body.includes('随便查一个词试试'), '★★ 那句占位文字还在屏幕上')
    // 该留的五样一样不少
    for (const keep of ['dict-folder', 'dict-rescan']) {
      assert.equal(await page.locator(`[data-testid="${keep}"]`).count(), 1, `★ 词典页少了 ${keep}`)
    }
    assert.ok(
      (await page.locator('[data-testid^="dict-toggle-"]').count()) > 0,
      '★ 启用 / 停用没了'
    )
    assert.ok((await page.locator('[data-testid^="dict-up-"]').count()) > 0, '★ 顺序没了')
  })

  it('D-234 · 停用一本，查词就不走它了', async () => {
    const id = await page
      .locator('[data-testid^="dict-toggle-"]')
      .first()
      .getAttribute('data-testid')
    /**
     * ★ D-470 之后没有探针了 —— 改问**悬浮卡片走的那条通道**（`dict:lookupCard`）：
     *   停用之后，同一个词的书目里不许再有它。验的仍是「停用真的生效」，
     *   只是问的地方从一个已经不存在的输入框换成了一直在用的那条路。
     */
    const cardBooks = async (): Promise<string> =>
      await page.evaluate(async () => {
        const c = await window.nyx.dict.lookupCard('brunt')
        return `${c.book?.name ?? ''} ${c.others.map((b) => b.name).join(' ')}`
      })
    assert.match(await cardBooks(), /测试词典/, '前置没成立：启用时本该查得到它')
    await page.click(`[data-testid="${id}"]`)
    await page.waitForTimeout(400)
    assert.doesNotMatch(
      await cardBooks(),
      /测试词典/,
      '★ 停用之后查词还在走这本 —— D-234 的停用等于没生效'
    )
    await page.click(`[data-testid="${id}"]`) // 打开，后面还要用
    await page.waitForTimeout(300)
  })

  it('★ D-150 · 例句先用词典的，并且标明是词典给的', async () => {
    // 重新生成一次解析 —— 这时词典已经在了，例句应该被词典的顶到前面
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    // I-099 · 练到 3 连正确的条目已经静默、默认不显示了 —— 先翻出来。
    // 而且必须点**这一条**：词典里只有它，随便挑一条就测不到 D-150
    await page.click('[data-testid="toggle-silent"]').catch(() => {})
    await page.waitForTimeout(300)
    await page
      .locator('[data-testid="item-rows"] .lrow', { hasText: 'bear the brunt' })
      .first()
      .click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })

    mode = 'analysis'
    await page.click('[data-testid="regen"]')
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="ex-source"]')?.textContent ?? '').includes('词典'),
      { timeout: 25000 }
    )
    const first = await page.locator('[data-testid="example"]').first().innerText()
    assert.match(first, /Coastal towns bear the brunt/, '词典例句没排在最前')
    assert.match(first, /词典 · 测试词典/, 'D-150 说来源要标在脸上，这里没标')

    /**
     * ★ D-468 · 详情页的词典块整段删了（词典只从悬浮卡与 Lookup 页进）。
     * 例句里的**词典来源**不受影响 —— 上面那两句钉的就是它。
     */
    assert.equal(await page.locator('[data-testid="dict-head"]').count(), 0, '详情页还有词典块')
    assert.equal(await page.locator('[data-testid="dict-hit"]').count(), 0)
  })

  /**
   * 卡片上**他真的看得见**的那些字。
   *
   * ★★★ 词典原文关在 Shadow DOM 里，`innerText` / `textContent` 一个字都取不到。
   *   2026-08-20 卡片只剩原文这一块之后，还照老样子只读 `innerText` 的断言
   *   会**假绿**（读到的是空串，什么都没在验）。
   */
  const dictText = async (): Promise<string> => {
    const t = await page.locator('[data-testid="dict-card"]').evaluate((card) => {
      const parts = [(card as HTMLElement).innerText]
      for (const host of Array.from(card.querySelectorAll('*'))) {
        const root = (host as HTMLElement).shadowRoot
        if (root) parts.push(root.textContent ?? '')
      }
      return parts.join(' ')
    })
    return t.replace(/\s+/g, ' ')
  }

  /**
   * ★★ 悬浮词典卡片（2026-08-16）—— 走他手指那条路。
   *
   * 以前右键「查词典」只弹一句 toast：`【TLD】` + 原文前 160 字。
   * 现在是一张贴着那个词的卡片：第一屏是词 + 音标 + 核心释义，
   * 中间滚动，底下能换词典，换了就成为默认。
   */
  it('★★ 右键查词 → 卡片贴着那个词出现，第一屏有词典原文', async () => {
    // 再放一本，好验「换词典」和「还有哪几本有」
    writePlainDict(join(dataRoot, 'data', 'dicts', '第二本'), '第二本', [
      { word: 'brunt', body: 'brunt\n[brʌnt]\n\nn.\n第二本给的释义' }
    ])
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-dict"]')
    await page.click('[data-testid="dict-rescan"]')
    await page.waitForSelector('[data-testid="dict-row"]')

    // 回到有正文的地方：词条详情页里有可选中的文字
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    await page.click('[data-testid="toggle-silent"]').catch(() => {})
    await page.waitForTimeout(300)
    await page
      .locator('[data-testid="item-rows"] .lrow', { hasText: 'bear the brunt' })
      .first()
      .click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })

    /**
     * 选中 + 右键 —— 用真的 Selection API 选一段文字，再派一个真的
     * contextmenu 事件。`Capture.svelte` 监听的是 window 上的 contextmenu，
     * 走的是他右键时**一模一样**那条路。
     */
    // 他右键的是**他看得见**的那个词 —— 先滚到眼前，再选中
    await page.locator('[data-testid="example"]').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    const at = await page.evaluate(() => {
      /**
       * ★ 必须选在**正文类**的元素里（`.ex` / `.quo` / `.qb` …）——
       * `Capture.classify()` 就是靠这些 class 判断「这地方能不能捞」，
       * 选在标题上右键菜单里只有「复制」。这条用例第一版就栽在这儿。
       */
      const el = document.querySelector('[data-testid="example"]')!
      const r = document.createRange()
      r.selectNodeContents(el)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
      const box = el.getBoundingClientRect()
      const x = Math.round(box.left + 10)
      const y = Math.round(box.top + 5)
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }))
      return { x, y }
    })
    await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 8000 })
    await page.click('[data-testid="ctx-dict"]')

    // ── 卡片出来了，而且贴着那个词 ──────────────────────
    await page.waitForSelector('[data-testid="dict-card"]', { timeout: 8000 })
    /**
     * ★ 卡片默认停在 AI 那一档（使用者 2026-09-13 第二轮）——
     *   下面要看的是**词典**那一档的东西（词典原文 · 「查的是别的词目」），
     *   所以先切过去。
     */
    await page.click('[data-testid="dict-tab-dict"]')
    await page.waitForSelector('[data-testid="dict-tab-dict"][aria-selected="true"]')
    const box = await page.locator('[data-testid="dict-card"]').boundingBox()
    assert.ok(box, '卡片没有尺寸')
    const vp = page.viewportSize() ?? { width: 1280, height: 800 }
    assert.ok(
      Math.abs(box!.x - at.x) < 420 && Math.abs(box!.y - at.y) < 560,
      `★ 卡片没出现在那个词附近：词在 (${at.x},${at.y})，卡片在 (${box!.x},${box!.y})`
    )
    // 边界翻转：不许跑出屏幕（D-200 那套判据，和右键菜单同一条纪律）
    assert.ok(box!.x >= 0 && box!.x + box!.width <= vp.width + 1, `★ 卡片横着跑出屏幕了：${box!.x}+${box!.width} / ${vp.width}`)
    assert.ok(box!.y >= 0, `★ 卡片跑到屏幕上面去了：${box!.y}`)
    assert.ok(box!.width <= 420, `★ 卡片太大了：${box!.width}px —— 它该是"快速查一下"，不是一个页面`)

    // ── 第一屏：词 + 原文 ──────────────────────────────
    // ★ 2026-08-20 起卡片上只有**词典原文**（他要「查词典就看那本词典自己的排版」）
    assert.match(await page.innerText('[data-testid="dict-word"]'), /brunt/i)
    assert.match(await dictText(), /冲击/, '★★ 第一屏什么内容都没有')
    /**
     * ★★★ 这本是**纯文本**词典（StarDict）。原样呈现 = 连它自己的换行一起 ——
     *   HTML 默认会把换行折成空格，一本排得整整齐齐的纯文本词典会被揉成一大段。
     *   判据是**渲染出来真的分了行**（两段文字的 y 不一样），不是去查 CSS 写了什么。
     */
    const rows = await page.locator('[data-testid="dict-shadow"]').evaluate((host) => {
      const root = (host as HTMLElement).shadowRoot
      const box = root?.querySelector('div')
      if (!box) return { lines: 0, text: '' }
      const r = new Range()
      r.selectNodeContents(box)
      const ys = new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)))
      return { lines: ys.size, text: box.textContent ?? '' }
    })
    assert.ok(rows.lines >= 2, `★★★ 纯文本词典被揉成了一行：${JSON.stringify(rows)}`)
    // 他选中的是整条 `bear the brunt of`，真正查的是 brunt —— 要说出来
    assert.match(await page.innerText('[data-testid="dict-asked"]'), /查的是/)

    // ── 中间可以滚，头尾不动 ──────────────────────────
    const scrollable = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="dict-body"]') as HTMLElement
      return getComputedStyle(b).overflowY
    })
    assert.equal(scrollable, 'auto', '★ 内容区不滚 —— 长词条会把卡片撑破')
  })

  it('★★ 换一本词典：内容变、卡片不重建、默认跟着变', async () => {
    // 卡片还开着。记下它的 DOM 身份
    await page.evaluate(() => {
      ;(document.querySelector('[data-testid="dict-card"]') as HTMLElement).dataset['mark'] = 'same'
    })
    const before = await dictText()

    await page.click('[data-testid="dict-book"]')
    await page.waitForSelector('[data-testid="dict-book-menu"]')
    /**
     * ★ 别用 `[data-testid^="dict-book-"]` —— 它连**菜单容器本身**
     * （`dict-book-menu`）一起匹配，`.first()` 拿到的是容器，点了什么都不会发生，
     * 而用例会以为"点过了"。第一版就是这么假绿的。
     */
    const other = page
      .locator('[data-testid="dict-book-menu"] .dcw-mi:not(.on):not(.dim)')
      .filter({ hasText: '第二本' })
      .first()
    assert.ok(await other.count(), '★ 选择器里没列出另一本 —— 「还有哪几本有」没算对')
    await other.click()

    await page.waitForFunction(
      (old) => {
        const b = document.querySelector('[data-testid="dict-body"]')
        if (!b) return false
        // ★ 词典原文关在 Shadow DOM 里，`textContent` 一个字都看不到 —— 得自己下去取
        const deep = Array.from(b.querySelectorAll('*'))
          .map((e) => (e as HTMLElement).shadowRoot?.textContent ?? '')
          .join(' ')
        return ((b.textContent ?? '') + deep).replace(/\s+/g, ' ') !== old
      },
      before,
      { timeout: 8000 }
    )
    assert.match(await dictText(), /第二本给的释义/)
    assert.match(await page.innerText('[data-testid="dict-book"]'), /第二本/)

    // ★ 同一张卡片 —— 不是关掉再开一张
    assert.equal(
      await page.getAttribute('[data-testid="dict-card"]', 'data-mark'),
      'same',
      '★★ 换词典把卡片重建了 —— 他的滚动位置、他看到哪儿全没了'
    )

    // ★ 主动切换 = 设为默认（不弹"要不要设为默认"）
    const def = await page.evaluate(async () => {
      const card = await window.nyx.dict.lookupCard('brunt')
      return card.book?.name
    })
    assert.equal(def, '第二本', '★★ 切换之后默认词典没跟着变')
  })

  it('★★ 卡片开着时查另一个词：复用同一张卡，不新开一张', async () => {
    /**
     * ★ 这一条必须在**卡片还开着**的时候查第二个词。
     *
     * 先 Esc 再查是另一回事（那本来就会新建一张），拿它当判据的话，
     * 「每次都重建」也照样绿 —— 负向对照抓到过这个假绿。
     */
    await page.evaluate(() => {
      ;(document.querySelector('[data-testid="dict-card"]') as HTMLElement).dataset['keep'] = 'yes'
    })
    /**
     * ★ 第二个词必须和第一个**不一样**，否则 props 没变，
     * 「每次都重建」的实现也能过（负向对照就是这么抓出来的）。
     * 所以这里只选那句话的前 15 个字符。
     */
    await page.evaluate(() => {
      const el = document.querySelectorAll('[data-testid="example"]')[0]!
      // 走到真正的文本节点上再切 —— `.ex` 里可能包着 <span>，
      // 对元素节点 setEnd(15) 会当成"第 15 个子节点"而越界
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && (node.textContent ?? '').trim().length < 16) node = walker.nextNode()
      if (!node) throw new Error('这一段里没有够长的文本节点')
      const r = document.createRange()
      r.setStart(node, 0)
      r.setEnd(node, 15)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 240 }))
    })
    await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 8000 })
    await page.click('[data-testid="ctx-dict"]')
    await page.waitForTimeout(500)
    assert.equal(
      await page.getAttribute('[data-testid="dict-card"]', 'data-keep'),
      'yes',
      '★★ 查第二个词把卡片重建了 —— 他连着查几个词是常事，重建会丢掉滚动位置'
    )
  })

  it('★★ Esc 关掉；再查一个词，词典还是他选的那本', async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="dict-card"]', { state: 'detached', timeout: 5000 })

    // 再查一个词：走同一条路
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="example"]')!
      const r = document.createRange()
      r.selectNodeContents(el)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }))
    })
    await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 8000 })
    await page.click('[data-testid="ctx-dict"]')
    await page.waitForSelector('[data-testid="dict-card"]', { timeout: 8000 })
    /** ★ 卡片默认停在 AI 档（使用者 2026-09-13 第二轮）—— 词典那一档的东西要先切过去 */
    await page.click('[data-testid="dict-tab-dict"]')
    await page.waitForSelector('[data-testid="dict-tab-dict"][aria-selected="true"]')

    // 默认还是他上一步选的那本 —— 查新词不重置词典
    assert.match(
      await page.innerText('[data-testid="dict-book"]'),
      /第二本/,
      '★★ 查个新词就把他选的词典重置了'
    )

    // 点卡片外关掉
    await page.click('[data-testid="dict-mask"]')
    await page.waitForSelector('[data-testid="dict-card"]', { state: 'detached', timeout: 5000 })
  })

  /**
   * 右键查词 → 卡片 → 在选择器里换成某一本 → 返回**屏幕上看得见的文字**。
   *
   * ★ GBK（D5.1b）和 UTF-16（D5.1c）两条第③档走的是同一段操作，
   *   抽成一条免得改了一处忘了另一处。两条各自的反向对照都验过：
   *   删掉各自的修复，它们**分别**变红（33～38 号）。
   */
  const cardTextFromBook = async (book: string, needle: string): Promise<string> => {
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    await page.click('[data-testid="toggle-silent"]').catch(() => {})
    await page.waitForTimeout(300)
    await page
      .locator('[data-testid="item-rows"] .lrow', { hasText: 'bear the brunt' })
      .first()
      .click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })
    await page.locator('[data-testid="example"]').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="example"]')!
      const r = document.createRange()
      r.selectNodeContents(el)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 240 }))
    })
    await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 8000 })
    await page.click('[data-testid="ctx-dict"]')
    await page.waitForSelector('[data-testid="dict-card"]', { timeout: 8000 })
    /** ★ 卡片默认停在 AI 档（使用者 2026-09-13 第二轮）—— 词典那一档的东西要先切过去 */
    await page.click('[data-testid="dict-tab-dict"]')
    await page.waitForSelector('[data-testid="dict-tab-dict"][aria-selected="true"]')

    await page.click('[data-testid="dict-book"]')
    await page.waitForSelector('[data-testid="dict-book-menu"]')
    const pick = page
      .locator('[data-testid="dict-book-menu"] .dcw-mi:not(.on):not(.dim)')
      .filter({ hasText: book })
      .first()
    assert.ok(await pick.count(), `★★ 选择器里没有《${book}》—— 它没被当成"这个词它也有"`)
    await pick.click()

    await page.waitForFunction(
      (n) => {
        const b = document.querySelector('[data-testid="dict-body"]')
        if (!b) return false
        const deep = Array.from(b.querySelectorAll('*'))
          .map((e) => (e as HTMLElement).shadowRoot?.textContent ?? '')
          .join(' ')
        return deep.includes(n) || deep.includes('\uFFFD')
      },
      needle,
      { timeout: 10000 }
    )
    const text = await dictText()
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="dict-card"]', { state: 'detached', timeout: 5000 })
    return text
  }

  /**
   * ★★★ 第 ③ 档 · D5.1b · GBK 词典在**屏幕上**是中文（2026-08-20）
   *
   * 他手上 22 本里只有一本声明 GBK（朗文插图版），而那本正文 27.3 MB
   * **一个 >= 0x80 的字节都没有** —— 拿真词典跑一万遍也验不到这条路。
   * 所以这里当场造一本**真的 GBK** 放进他的词典目录，走他的两条路各看一眼：
   *   · 设置 → 词典 → 试查一个词（他自己会用的自检）
   *   · 右键查词 → 卡片里换成这一本（他平时那条路）
   *
   * 判据是**屏幕上有中文、且没有替换符 U+FFFD** ——
   * 解码错了的样子正是「一屏 ��」，不是报错。
   */
  it('★★★ D5.1b · GBK 词典放进去：屏幕上是中文，不是一屏问号', async () => {
    writeMdx(
      join(dataRoot, 'data', 'dicts', 'GBK 样本.mdx'),
      [
        { word: 'brunt', body: '<b>brunt</b> n. 首当其冲的那一下。' },
        { word: 'zebra', body: '<b>zebra</b> n. 斑马；黑白条纹的东西。' }
      ],
      { encoding: 'GBK', version: '1.2', title: 'GBK 样本' }
    )

    // ── 他的自检那条路 ────────────────────────────────
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-dict"]')
    await page.click('[data-testid="dict-rescan"]')
    await page.waitForFunction(() => document.body.innerText.includes('GBK 样本'), undefined, {
      timeout: 20000
    })
    /**
     * ★ D-470（2026-09-07）· 原来这里还走一遍设置页的「随便查一个词试试」。
     *   那个探针取消了，所以只剩他平时真会走的那条路：右键查词 → 卡片 → 换成这一本。
     *   判据一个字没改：**屏幕上是中文、且没有 U+FFFD**。
     */
    // ── 他平时那条路：右键 → 卡片 → 换成这一本 ────────
    const shown = await cardTextFromBook('GBK 样本', '首当其冲')
    assert.match(shown, /首当其冲/, `★★★ 卡片上不是这本 GBK 的中文：${shown.slice(0, 160)}`)
    assert.equal(shown.includes('\uFFFD'), false, `★★★ 卡片上是乱码：${shown.slice(0, 160)}`)
  })

  /**
   * ★★★ 第 ③ 档 · D5.1c · UTF-16 词典在**屏幕上**是整条正文（2026-08-20）
   *
   * 他那 22 本里**一本 UTF-16 都没有**，所以这条也只能当场造一本。
   *
   * 这次挡的病**不长成「出错」的样子**：正文按「第一个 0 字节」切，
   * zebra 编成 UTF-16 是 `7a 00 65 00 …`，第一个 0 字节在第 2 个字节 ——
   * 一切就只剩一个不完整的码元，解出来是**空字符串**。
   * 他看到的是「这个词这本词典没有内容」，一句错误提示都没有。
   *
   * 所以判据是**整条正文都在**，特别是**最后那几个字** ——
   * 只断言「含有 zebra」，照样会被切断的那一版骗过去。
   */
  it('★★★ D5.1c · UTF-16 词典放进去：屏幕上是整条正文，不是空白', async () => {
    writeMdx(
      join(dataRoot, 'data', 'dicts', 'UTF16 样本.mdx'),
      [
        { word: 'brunt', body: '<b>brunt</b> n. 首当其冲那一下，到最后一个字都要在。' },
        { word: 'zebra', body: '<b>zebra</b> n. 斑马；结尾这几个字最容易被切掉。' }
      ],
      { encoding: 'UTF-16', version: '1.2', title: 'UTF16 样本' }
    )

    // ── 他的自检那条路 ────────────────────────────────
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-dict"]')
    await page.click('[data-testid="dict-rescan"]')
    await page.waitForFunction(() => document.body.innerText.includes('UTF16 样本'), undefined, {
      timeout: 20000
    })
    /**
     * ★ D-470 · 同上：设置页的探针取消了，只走他平时那条路。
     *   判据一个字没改 —— **整条正文都在**，尤其是最后那几个字。
     */
    // ── 他平时那条路：右键 → 卡片 → 换成这一本 ────────
    const shown = await cardTextFromBook('UTF16 样本', '首当其冲那一下')
    assert.match(shown, /首当其冲那一下/, `★★★ 卡片上不是这本的正文：${shown.slice(0, 160)}`)
    assert.match(shown, /到最后一个字都要在。/, `★★★ 卡片上的正文被切断了：${shown.slice(0, 160)}`)
    assert.equal(shown.includes('\uFFFD'), false, `★★★ 卡片上是乱码：${shown.slice(0, 160)}`)
  })
})

describe('D-102 / D-232 · 导出与导回', () => {
  // 系统的「另存为」对话框自动化点不动。所以**在主进程里把它换掉**，
  // 让它直接返回一个固定路径 —— 走的还是那条真的 IPC、真的 Exporter，
  // 生产代码里不留任何测试开关。
  const stubSave = async (filePath: string): Promise<void> => {
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
    }, filePath)
  }

  it('可读笔记带着原文出处和两条线的状态', async () => {
    const dest = join(dataRoot, 'notes.md')
    await stubSave(dest)
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-data"]')
    await page.click('[data-testid="exp-notes"]')
    await page.waitForSelector('[data-testid="exp-note"]')

    const md = readFileSync(dest, 'utf8')
    assert.match(md, /# Nyx 笔记/)
    assert.match(md, /bear the brunt of/, '词条没进笔记')
    assert.match(md, /Coastal towns bear the brunt/, 'M-012 原文出处没进笔记')
    assert.match(md, /写作层|理解层/, '判层没进笔记')
  })

  it('完整备份是一个真的 SQLite 文件，不是空壳', async () => {
    const dest = join(dataRoot, 'full.db')
    await stubSave(dest)
    await page.click('[data-testid="exp-backup"]')
    await page.waitForSelector('[data-testid="exp-note"]')
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="exp-note"]')?.textContent ?? '').includes('.db')
    )

    const buf = readFileSync(dest)
    assert.equal(buf.subarray(0, 15).toString('latin1'), 'SQLite format 3', '导出的不是 SQLite 库')
    assert.ok(buf.length > 20000, `备份只有 ${buf.length} 字节，八成是个空壳`)
    // 里面确实有词条 —— 字符串在 SQLite 页里是明文存的，直接搜得到
    assert.ok(buf.includes(Buffer.from('bear the brunt of')), '备份里没有词条')
  })
})

describe('D-468 · 详情页一层正文 + 拆出的单位一键入库', () => {
  before(async () => {
    mode = 'analysis'
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    await page.locator('[data-testid="item-rows"] .lrow').first().click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })
    /**
     * ★ D-4（2026-09-03 UI 审计）之后，这两颗按钮**按状态二选一**：
     *   没解析过 → 只有「只分析这一条」（`analyse-one`）
     *   解析过了 → 只有「重新生成解析」（`regen`）
     * 原来这里写死点 `regen`，而这条词条从来没解析过 —— 那颗按钮已经不出现，
     * 于是整套 `before` 装不起来，**3 条用例被 cancelled**（不是失败，是没跑）。
     * ★ 这一套要的只是「让它有解析」，点哪颗无所谓，所以按状态点。
     */
    const one = page.locator('[data-testid="analyse-one"]')
    await ((await one.count()) > 0 ? one : page.locator('[data-testid="regen"]')).click()
    await page.waitForSelector('[data-testid="block-inSentence"]', { timeout: 25000 })
  })

  /**
   * ★★ D-468 · 正文只有一层，而且**顺序**是「先看懂 → 再会用」。
   * 只数「块在不在」不够：两块拆回去、或者语用跑到合并块前面，页面照样有这几个块。
   * 所以这里比的是它们在页面上的先后。
   */
  it('★★ 一层正文：合并块 → 动词 · 句型 · 单位 → 语用 · 语域变化 · 改写，按这个顺序', async () => {
    const want = ['inSentence', 'verbs', 'pattern', 'chunks', 'pragmatics', 'variation', 'rewrites']
    for (const b of want) {
      assert.equal(await page.locator(`[data-testid="block-${b}"]`).count(), 1, `正文缺了 ${b}`)
    }
    const order = await page.evaluate((keys: string[]) => {
      const tops = keys.map(
        (k) => document.querySelector(`[data-testid="block-${k}"]`)!.getBoundingClientRect().top
      )
      return tops
    }, want)
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        order[i]! > order[i - 1]!,
        `${want[i]} 跑到了 ${want[i - 1]} 前面 —— 正文顺序不是「先看懂 → 再会用」`
      )
    }
    assert.equal(await page.locator('[data-testid="rewrite-row"]').count(), 3)
    // 合并之后这一块要同时说清两件事：它在做什么 · 哪里会绊住人
    assert.match(await page.innerText('[data-testid="block-inSentence"]'), /brunt/)
  })

  it('★ 两个层名不再出现在页面上（层没了，名字不许留着）', async () => {
    const body = await page.innerText('.view')
    for (const gone of ['基础层', '进阶层', '写得出第 4 档要靠这一段']) {
      assert.ok(!body.includes(gone), `页面上还写着「${gone}」`)
    }
  })

  it('★★ Register & Nuance 排在 Close Reading 之前（D-468）', async () => {
    const y = await page.evaluate(() => {
      const sec = (t: string): number => {
        for (const el of Array.from(document.querySelectorAll('.view .sec'))) {
          if ((el as HTMLElement).innerText.trim().startsWith(t)) {
            return el.getBoundingClientRect().top
          }
        }
        return NaN
      }
      return { reg: sec('Register'), close: sec('Close Reading') }
    })
    assert.ok(Number.isFinite(y.reg), 'Register & Nuance 这一节不见了')
    assert.ok(Number.isFinite(y.close), 'Close Reading 这一节不见了')
    assert.ok(y.reg < y.close, 'Register & Nuance 还压在 Close Reading 下面')
  })

  /**
   * ★★ 2026-09-07 之前解析过的条目，写下的是**分开的两块**。
   * 合并之后不画它们的话，他点开一条老词条会发现正文第一段空了 ——
   * 库里明明有内容，屏幕上什么都没有，也不报错。这一条钉的就是「老行不丢」。
   */
  it('★★ 合并之前写下的老行照旧画得出来（画进同一个区域）', async () => {
    const term = (await page.innerText('[data-testid="detail-term"]')).trim()
    const seed = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
    seed.exec('pragma busy_timeout = 5000')
    const row = seed.prepare(`select id from items where term = ?`).get(term) as
      | { id: number }
      | undefined
    assert.ok(row, `库里找不到「${term}」`)
    const at = Date.now()
    const put = seed.prepare(
      `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
         values (?, ?, ?, ?, ?)
       on conflict(item_id, block) do update set
         content = excluded.content, updated_at = excluded.updated_at`
    )
    put.run(row.id, 'meaning', '这是合并之前写下的老的一块', at, at)
    put.run(row.id, 'barriers', '["这是老的会绊住你的地方"]', at, at)
    seed.close()

    // 回到讲次再点回来 —— 让详情页重新读一次库
    await page.click('[data-testid="global-back"]')
    await page.click('[data-testid="tab-active"]')
    await page.locator('[data-testid="item-rows"] .lrow').first().click()
    await page.waitForSelector('[data-testid="block-meaning"]', { timeout: 8000 })
    assert.match(await page.innerText('[data-testid="block-meaning"]'), /老的一块/)
    assert.match(await page.innerText('[data-testid="block-barriers"]'), /老的会绊住你的地方/)

    const y = await page.evaluate(() =>
      ['inSentence', 'meaning', 'barriers', 'verbs'].map((k) => {
        const el = document.querySelector(`[data-testid="block-${k}"]`)
        return el ? el.getBoundingClientRect().top : NaN
      })
    )
    assert.ok(y[0]! < y[1]! && y[1]! < y[2]! && y[2]! < y[3]!, '老行没有画进合并块那同一个区域')
  })

  it('★ 拆出来的单位，点一下就进当前 lecture 的主动词汇（带着原文出处）', async () => {
    await page.waitForSelector('[data-testid="chunk-row"]')
    await page.click('[data-testid="promote-b-1"]') // 第二个 chunk，避免和自己重名
    await page.waitForSelector('[data-testid="toast-text"]')
    assert.match(await page.innerText('[data-testid="toast-text"]'), /写作层/)

    await page.click('[data-testid="global-back"]')
    await page.click('[data-testid="tab-active"]')
    await page.waitForFunction(() =>
      (document.querySelector('[data-testid="item-rows"]')?.textContent ?? '').includes('these storms')
    )
  })
})

describe('I-032 / I-033 / I-034 · 三层都能建、能改名、能删、能静默', () => {
  /**
   * 只动**自己新建的那个项目**。
   * 一开始用 `.last()` 挑目标，结果挑中了主线用的那个项目、把它删了 ——
   * 后面每一条都挂在莫名其妙的地方。新建的项目排在列表最前面，不是最后。
   */
  const mine = (): Locator => page.locator('.nv', { hasText: '我建的项目' })

  it('★ 侧边栏的「＋」真的建出一个项目（以前点了没反应）', async () => {
    const before = await page.locator('[data-testid^="nav-toggle-project-"]').count()
    await page.click('[data-testid="add-project"]')
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid^="nav-toggle-project-"]').length > n,
      before,
      { timeout: 8000 }
    )
    // 立刻改个名，后面全靠它认人
    const id = (await page
      .locator('[data-testid^="menu-project-"]')
      .first()
      .getAttribute('data-testid'))!.replace('menu-project-', '')
    await page.click(`[data-testid="menu-project-${id}"]`)
    // I-048 · 菜单是下拉框，改名是二级动作 —— 先点「改名」才出输入框
    await page.click('[data-testid="tree-rename"]')
    await page.fill('[data-testid="tree-rename-input"]', '我建的项目')
    await page.click('[data-testid="tree-rename-go"]')
    await mine().waitFor({ timeout: 8000 })
  })

  it('项目下能建单元，单元下能建 lecture —— 每一级都有入口', async () => {
    // I-071 · 行内的 ＋ 去掉了，新建挪进右键菜单（名字一长，一行塞两个图标就乱）
    await mine().locator('[data-testid^="menu-project-"]').click()
    await page.waitForSelector('[data-testid="tree-menu"]')
    await page.click('[data-testid="tree-new"]') // ＋ 新建单元
    await page.waitForSelector('[data-testid="tree-note"]')

    // 单元上再右键 → ＋ 新建 lecture。
    // **必须在「我建的项目」这一支里面找** —— 全局 `.last()` 会挑到别的项目下面、
    // 而且多半还是折叠着的那个单元，点不到（折叠分组是 visibility:hidden）。
    const myGroup = mine().locator('xpath=following-sibling::div[contains(@class,"grp")][1]')
    await myGroup.locator('[data-testid^="menu-unit-"]').last().click()
    await page.waitForSelector('[data-testid="tree-menu"]')
    await page.click('[data-testid="tree-new"]')
    // 建完直接进工作台，省一次点击
    await page.waitForSelector('[data-testid="drop-original"]', { timeout: 8000 })
  })

  it('改名改的是同一份数据，侧边栏跟着变（D-185）', async () => {
    await mine().locator('[data-testid^="menu-project-"]').click()
    await page.waitForSelector('[data-testid="tree-menu"]')
    await page.click('[data-testid="tree-rename"]')
    await page.fill('[data-testid="tree-rename-input"]', '我建的项目 · 改过名')
    await page.click('[data-testid="tree-rename-go"]')
    await page.waitForFunction(() =>
      (document.querySelector('[data-testid="project-area"]')?.textContent ?? '').includes('改过名')
    )
  })

  /**
   * ★ I-092 · 使用者：「右键出来的下拉框，随便点击其他地方它不消失。」
   * 根因：那层遮罩写的是 `class="ovl on"`，而 `.ovl` 在总原型的 CSS 里**根本不存在** ——
   * 没有尺寸，盖不住任何东西。光看组件代码是看不出来的，得连着 CSS 一起看。
   */
  it('★ I-092 · 点别处 / 按 Esc 都能关掉右键菜单', async () => {
    await mine().locator('[data-testid^="menu-project-"]').click()
    await page.waitForSelector('[data-testid="tree-menu"]')

    // 点正文区域的空白处
    await page.mouse.click(900, 700)
    await page.waitForSelector('[data-testid="tree-menu"]', { state: 'detached', timeout: 5000 })

    await mine().locator('[data-testid^="menu-project-"]').click()
    await page.waitForSelector('[data-testid="tree-menu"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="tree-menu"]', { state: 'detached', timeout: 5000 })
  })

  it('★ I-047 · 项目菜单有置顶 / 归档 / 导出 / 两种测试', async () => {
    await mine().locator('[data-testid^="menu-project-"]').click()
    await page.waitForSelector('[data-testid="tree-menu"]')
    for (const b of ['tree-pin', 'tree-archive', 'tree-export', 'tree-test']) {
      assert.equal(await page.locator(`[data-testid="${b}"]`).count(), 1, `项目菜单缺了 ${b}`)
    }
    // 项目没有父级，所以不该有「移到…」
    assert.equal(await page.locator('[data-testid="tree-move"]').count(), 0)

    /** ★ 置顶之前行上不该有记号 —— 不然下面那条断言等于没验 */
    assert.equal(await page.locator('[data-testid^="pin-"]').count(), 0, '还没置顶就有记号了')

    await page.click('[data-testid="tree-pin"]')
    await page.waitForSelector('[data-testid="tree-note"]')
    assert.match(await page.innerText('[data-testid="tree-note"]'), /置顶/)

    /**
     * ★★ 置顶了**要看得出来**（使用者 2026-09-04）。
     *   在这之前只有顺序变了，而顺序过一会儿就说明不了什么 ——
     *   他分不出哪个是自己钉上去的、哪个只是刚建的。
     *   记号本身来自总原型 v2（`.pin` 的样式一直躺在 global.css 里，没人渲染它）。
     */
    await page.waitForSelector('[data-testid^="pin-"]', { timeout: 5000 })
    assert.equal(
      await page.locator('[data-testid^="pin-"]').count(),
      1,
      '★ 置顶了，行上却没有记号 —— 那他只能靠顺序猜'
    )

    // 取消置顶 → 记号跟着没
    await mine().locator('[data-testid^="menu-project-"]').click()
    await page.waitForSelector('[data-testid="tree-menu"]')
    await page.click('[data-testid="tree-pin"]')
    await page.waitForSelector('[data-testid^="pin-"]', { state: 'detached', timeout: 5000 })
  })

  it('★ I-047 · lecture 菜单多出「打回待审阅 / 复制一份 / 移到…」', async () => {
    await page.click('[data-testid="menu-lecture-1"]')
    await page.waitForSelector('[data-testid="tree-menu"]')
    for (const b of ['tree-unread', 'tree-fork', 'tree-move', 'tree-archive', 'tree-export']) {
      assert.equal(await page.locator(`[data-testid="${b}"]`).count(), 1, `lecture 菜单缺了 ${b}`)
    }
  })

  it('复制一份只复制材料 —— 条目是全局的，复制了两边练会打架', async () => {
    const before = await page.locator('[data-testid^="nav-lecture-"]').count()
    await page.click('[data-testid="tree-fork"]')
    await page.waitForSelector('[data-testid="tree-note"]')
    assert.match(await page.innerText('[data-testid="tree-note"]'), /只复制了材料/)
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid^="nav-lecture-"]').length > n,
      before,
      { timeout: 8000 }
    )
  })

  it('「移到…」列出别的单元，搬过去侧边栏跟着变', async () => {
    await page.click('[data-testid="menu-lecture-1"]')
    await page.click('[data-testid="tree-move"]')
    // I-085 · 去处也是一级一级选：① 先选项目 ② 再选它下面的单元。
    // 以前是把全部单元平铺成一长串，项目一多就没法用了。
    await page.waitForSelector('[data-testid^="move-to-"]')
    // ① 项目 —— 明确挑主线那个「未命名项目」：
    //   · 不能挑「我建的项目」：下一条测试要把它删掉，搬进去的 lecture 1 会跟着进垃圾箱
    //   · 也不能随便挑一个：别的用例会建出**没有单元**的项目，选进去第二级是空的
    await page.locator('[data-testid^="move-to-"]').filter({ hasText: '未命名项目' }).first().click()
    await page.waitForSelector('[data-testid^="move-to-"]')
    assert.ok(
      (await page.locator('[data-testid^="move-to-"]').count()) >= 1,
      '选完项目之后，一个可搬去的单元都没列出来'
    )
    await page.locator('[data-testid^="move-to-"]').first().click() // ② 单元
    await page.waitForFunction(() =>
      (document.querySelector('[data-testid="tree-note"]')?.textContent ?? '').includes('搬过去了')
    )
  })

  it('删除进回收站，到期前可恢复 —— 不是真删', async () => {
    await page
      .locator('.nv', { hasText: '我建的项目 · 改过名' })
      .locator('[data-testid^="menu-project-"]')
      .click()
    await page.click('[data-testid="tree-delete"]')
    // ★ B5 · 先问一句（在这之前点了就没了）；标题给对象名
    await page.waitForSelector('[data-testid="tree-del-dlg"]')
    assert.match(
      await page.innerText('[data-testid="tree-del-dlg-title"]'),
      /我建的项目/,
      '★ 确认框标题里没有对象名 —— 泛指的「确认删除？」正是 BTN-Q4 要改掉的那种'
    )
    await page.click('[data-testid="tree-del-dlg-confirm"]')
    // ★ B4 · 回执从行内那一句换成底部回执条，而且带撤销
    await page.waitForSelector('[data-testid="toast"]')
    assert.match(await page.innerText('[data-testid="toast"]'), /回收站|恢复|撤销/)

    await page.click('[data-testid="nav-trash"]')
    await page.waitForSelector('[data-testid^="trash-project-"]', { timeout: 8000 })
  })

  it('★ I-034 · lecture 的 ••• 里有静默 —— 以前什么都没有', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="nav-lecture-1"]', { state: 'attached', timeout: 8000 })
    await openLecture(page, 1)
    await page.waitForSelector('[data-testid="lecture-menu"]', { timeout: 8000 })
    await page.click('[data-testid="lecture-menu"]')
    await page.click('[data-testid="lecture-silence"]')
    await page.waitForSelector('[data-testid="toast-text"]')
    assert.ok(
      (await page.innerText('[data-testid="toast-text"]')).includes(SILENCE_ACTIONS.shelve)
    )

    // 静默只是不再排期，条目进度一个字不动 —— 所以能原样取消
    await page.click('[data-testid="lecture-menu"]')
    await page.click('[data-testid="lecture-silence"]')
    await page.waitForFunction(
      (w) => (document.querySelector('[data-testid="toast-text"]')?.textContent ?? '').includes(w),
      SILENCE_ACTIONS.restore
    )
  })

  it('I-041 · 建东西不设数量上限', async () => {
    /**
     * ★ 2026-09-03 · 点击之间要隔开一下。
     *
     * 这条守的是「**不设数量上限**」—— 想建多少建多少。
     * 它守的**不是**「6 下连点必须变成 6 个」：Q-1 之后那颗 `＋` 有 400ms 去抖
     * （使用者选的 B），专门挡手误双击。连点 6 下现在会被折叠成 1 个，
     * 那是**去抖在正常工作**，不是数量上限。
     * 所以这里把点击隔开 —— 每一下都是「他看见结果之后」的那种点击，
     * 用例的原意一个字没变。
     */
    const before = await page.locator('[data-testid^="nav-toggle-project-"]').count()
    for (let i = 0; i < 6; i++) {
      await page.click('[data-testid="add-project"]')
      await page.waitForTimeout(450)
    }
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid^="nav-toggle-project-"]').length >= n + 6,
      before,
      { timeout: 10000 }
    )
  })
})

/**
 * ★★ D-469（2026-09-07）· 单元主页也取消了（I-035 就此修订）。
 *
 * 原来这条验的是「点单元进得去，有讲次列表、知识分布、两种测试和导出」。
 * 现在点单元 = 展开 / 收起，讲次列表本来就在树上；两种测试与导出进了右键菜单
 * （`smoke:nav` 里逐项钉着）。这里改成验**它确实不再是一个页面**，
 * 顺带把「展开之后讲次那一行真的出现」钉住 —— 那是他现在找讲次的唯一路径。
 */
describe('D-469 · 单元不再是页面，点它 = 展开 / 收起', () => {
  it('★ 点单元只展开，出不来任何「单元页」', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    const unit = page.locator('[data-testid^="nav-toggle-unit-"]:visible').first()
    if ((await unit.count()) === 0) {
      await page.locator('[data-testid^="nav-toggle-project-"]').first().click()
      await page.waitForTimeout(300)
    }
    await page.locator('[data-testid^="nav-toggle-unit-"]:visible').first().click()
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('[data-testid="project-name"]').count(),
      0,
      '★★ 单元页又回来了'
    )
    assert.equal(await page.locator('[data-testid="lib-rows"]').count(), 1, '★★ 点单元把页面切走了')
    assert.ok(
      (await page.locator('[data-testid^="nav-lecture-"]:visible').count()) > 0,
      '★ 展开之后一条讲次都看不见 —— 那他就再也找不到讲次了'
    )
  })
})

describe('I-040 · 没数据也要能看见报告长什么样', () => {
  it('空数据时顶上说明 + 三层结构照常渲染', async () => {
    // 报告从首页那张卡片进（侧边栏没有单独一行 —— D-042 顶层只有七行）
    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="home-report"]')
    await page.waitForSelector('[data-testid="report-core"]', { timeout: 10000 })
    /**
     * ★ D-467 · 收成三层之后，「没数据也看得见」验的是**三层的骨架都在**：
     *   第一层那三句话 · 第二层那三块 · 第三层那六个折叠头。
     *   数字全是 0 没关系，结构不能塌 —— 他要凭这个判断值不值得为它攒数据。
     */
    await page.waitForSelector('[data-testid="core-did"]', { timeout: 10000 })
    for (const m of ['weak', 'accuracy', 'hard']) {
      assert.equal(
        await page.locator(`[data-testid="report-${m}"]`).count(),
        1,
        `第二层缺了 ${m} 这一块`
      )
    }
    for (const k of ['flow', 'performance', 'activity', 'lookups', 'changes', 'why']) {
      assert.equal(
        await page.locator(`[data-testid="deep-head-${k}"]`).count(),
        1,
        `第三层缺了 ${k} 那一块的折叠头`
      )
    }
  })
})


describe('I-039 · Findings 里就地分析这一篇', () => {
  // 放在链条**末尾**：这一条会往 lecture 1 里加条目和材料，
  // 插在中间会把后面十几条依赖状态的验收全部带偏（上一批已经栽过一次）。
  it('★ 分析范围仅限这一篇，捞到的条目出现在 Findings 里', async () => {
    await page.click('[data-testid="nav-files"]')
    await page.waitForSelector('[data-testid="fs-card-1"]', { timeout: 8000 })
    await page.click('[data-testid="fs-card-1"]')
    await page.click('[data-testid="fs-tab-fnd"]')
    await page.waitForSelector('[data-testid="fs-analyse"]')

    mode = 'items'
    await page.click('[data-testid="fs-analyse"]')
    await page.waitForSelector('[data-testid="fs-analyse-note"]', { timeout: 40000 })
    assert.match(await page.innerText('[data-testid="fs-analyse-note"]'), /捞到 \d+ 条/)

    // 捞到的条目就出现在 Findings 里 —— 同一份数据的另一个视图
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="fs-findings"]')?.textContent ?? '').includes('bear the brunt of'),
      undefined,
      { timeout: 8000 }
    )
    await page.click('[data-testid="fs-tab-tut"]')
  })

  it('★ I-081 · Findings 里每一条都能点进详情页', async () => {
    await page.click('[data-testid="fs-tab-fnd"]')
    const first = page.locator('[data-testid^="fs-finding-"]').first()
    await first.waitFor({ timeout: 8000 })
    const term = await first.locator('.t').innerText()
    await first.click()
    // 进的是词条详情页，而且就是刚才点的那一条
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 8000 })
    assert.match(await page.innerText('[data-testid="detail-term"]'), new RegExp(term.slice(0, 8)))
  })
})

/**
 * 这一轮使用者报的问题 · I-072 ～ I-087
 * 全部是「用起来发现的」，所以验收方式也照着他的用法写：点得到、看得见、有反馈。
 */
describe('I-075 · 垃圾箱能勾选、能批量处理', () => {
  before(async () => {
    await page.click('[data-testid="nav-home"]')
    await page.evaluate(async () => {
      for (let i = 1; i <= 3; i++) {
        const id = await window.nyx.data.createProject(`待清理 ${i}`)
        await window.nyx.data.softDelete('project', id)
      }
    })
  })

  it('勾一条就出现选择条，勾选数是真的', async () => {
    await page.click('[data-testid="nav-trash"]')
    await page.waitForSelector('[data-testid^="trash-project-"]', { timeout: 8000 })
    assert.equal(await page.locator('[data-testid="trash-selbar"]').count(), 0, '没勾就冒出选择条')

    const rows = page.locator('[data-testid^="trash-project-"]')
    await rows.nth(0).click()
    await rows.nth(1).click()
    await page.waitForSelector('[data-testid="trash-selbar"]')
    assert.equal(await page.innerText('[data-testid="trash-selcount"]'), '2')
  })

  it('★ 批量恢复：勾中的一起回来', async () => {
    const before = await page.locator('[data-testid^="trash-project-"]').count()
    await page.click('[data-testid="trash-restore-picked"]')
    await page.waitForSelector('[data-testid="toast-text"]')
    assert.match(await page.innerText('[data-testid="toast-text"]'), /2 项/)
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid^="trash-project-"]').length === n - 2,
      before,
      { timeout: 8000 }
    )
  })

  it('★ 彻底删除要先问一句 —— 这一步没有后悔药', async () => {
    const rows = page.locator('[data-testid^="trash-project-"]')
    await rows.first().click()
    await page.click('[data-testid="trash-purge"]')
    await page.waitForSelector('[data-testid="trash-purge-dlg"]')
    // ★ IX-13（D-435 的代价条）：彻底删除必须**当面说清云端那一份也会抹掉** ——
    //   在这之前两端一处都没说。
    assert.match(
      await page.innerText('[data-testid="trash-purge-dlg"]'),
      /云端/,
      '★ 彻底删除的确认框没说云端也会抹掉'
    )

    const before = await rows.count()
    await page.click('[data-testid="trash-purge-dlg-confirm"]')
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid^="trash-project-"]').length === n - 1,
      before,
      { timeout: 8000 }
    )
    // 真删了 —— 刷新之后也不该再回来
    await page.reload()
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(400)
    assert.equal(await page.locator('[data-testid^="trash-project-"]').count(), before - 1)
  })
})


/**
 * 放在最末尾：这一条会往库里加句子，插在中间会把后面按条数断言的验收全部带偏。
 */
/**
 * ★ I-097 · 使用者：「所有词条都有复选框可以点击，点击某几个之后，
 * 在下方可以出现测试（2 个）、导出、删除、静默等等功能。」
 */
describe('I-097 · 勾选之后那一条操作栏', () => {
  before(async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"] .lrow', { timeout: 8000 })
  })

  it('★ 勾中之后，该有的动作都在', async () => {
    await page.locator('[data-testid="lib-rows"] .lrow .ck').first().click()
    await page.waitForSelector('[data-testid="selbar"]')
    for (const b of [
      'bulk-reading', // 认读测试
      'bulk-practice', // 产出练习
      'bulk-export', // 导出
      'bulk-copy', // 复制
      'bulk-b', // 改为主动
      'bulk-a', // 改为被动
      'bulk-silence', // 静默
      'bulk-del', // 删除
      'bulk-none' // 取消选择
    ]) {
      assert.equal(await page.locator(`[data-testid="${b}"]`).count(), 1, `操作栏缺了 ${b}`)
    }
    // 收干净再走 —— 勾选是有状态的，留着会让下一条把它反选掉
    await page.click('[data-testid="bulk-none"]')
    await page.waitForSelector('[data-testid="selbar"]', { state: 'detached' })
  })

  it('★ 静默：不再排进轮转，但数据还在（不是删除）', async () => {
    const term = await page.locator('[data-testid="lib-rows"] .lrow .lt').first().innerText()
    await page.locator('[data-testid="lib-rows"] .lrow .ck').first().click()
    await page.click('[data-testid="bulk-silence"]')
    await page.waitForSelector('[data-testid="toast-text"]')
    assert.ok(
      (await page.innerText('[data-testid="toast-text"]')).includes(SILENCE_ACTIONS.shelve)
    )

    // 它应该出现在静默库里 —— 静默是终点，不是清除（D-030 / D-087）
    await page.click('[data-testid="nav-lib-silent"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    assert.match(await page.locator('[data-testid="lib-rows"]').innerText(), new RegExp(term.slice(0, 8)))

    // 静默库里给的是「恢复」，不是再静默一次
    await page.locator('[data-testid="lib-rows"] .lrow .ck').first().click()
    await page.waitForSelector('[data-testid="bulk-unsilence"]')
    assert.equal(await page.locator('[data-testid="bulk-silence"]').count(), 0)
    await page.click('[data-testid="bulk-unsilence"]')
    await page.waitForSelector('[data-testid="toast-text"]')
    assert.ok(
      (await page.innerText('[data-testid="toast-text"]')).includes(SILENCE_ACTIONS.restore)
    )
  })

  it('★ I-098 · 四个地方的复选框都是活的（以前只有知识库那份）', async () => {
    // 讲次工作台
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    // 工作台分三个 Tab，默认那个不一定有条目 —— 挑一个有的
    for (const tab of ['tab-active', 'tab-passive', 'tab-self']) {
      await page.click(`[data-testid="${tab}"]`).catch(() => {})
      await page.waitForTimeout(250)
      if ((await page.locator('[data-testid="item-rows"] .lrow').count()) > 0) break
    }
    await page.waitForSelector('[data-testid="item-rows"] .lrow', { timeout: 8000 })
    await page.locator('[data-testid="item-rows"] .lrow .ck').first().click()
    await page.waitForSelector('[data-testid="selbar"]', { timeout: 5000 })
    await page.click('[data-testid="bulk-none"]')

    // 我的上传库 —— 它的行是 .ur（整句），总原型里本来没有勾选格
    await page.click('[data-testid="nav-lib-upload"]')
    await page.waitForSelector('[data-testid="lib-rows"] .ur', { timeout: 8000 })
    await page.locator('[data-testid="lib-rows"] .ur .ck').first().click()
    await page.waitForSelector('[data-testid="selbar"]', { timeout: 5000 })
    // 整句不出产出题（D-006）—— 那一栏不该给「产出练习」
    assert.equal(await page.locator('[data-testid="bulk-practice"]').count(), 0)
    await page.click('[data-testid="bulk-none"]')
  })

  /**
   * ★ I-099 · 使用者：「为什么我静默了某条知识之后，
   * 它不从 lecture 里面的知识里面消失呢？」
   * decisions.md：「达标条目转为静默，**从原库与 lecture 的默认视图消失**。」
   * 综合知识库那边早就这么做了（D-158），唯独这一讲的列表一直照单全收。
   */
  it('★ I-099 · 静默之后从这一讲的默认视图消失，但能翻出来看', async () => {
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    for (const tab of ['tab-active', 'tab-passive', 'tab-self']) {
      await page.click(`[data-testid="${tab}"]`).catch(() => {})
      await page.waitForTimeout(200)
      if ((await page.locator('[data-testid="item-rows"] .lrow').count()) > 0) break
    }
    const before = await page.locator('[data-testid="item-rows"] .lrow').count()
    const term = await page.locator('[data-testid="item-rows"] .lrow .lt').first().innerText()

    await page.locator('[data-testid="item-rows"] .lrow .ck').first().click()
    await page.click('[data-testid="bulk-silence"]')
    await page.waitForSelector('[data-testid="toast-text"]')

    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="item-rows"] .lrow').length === n - 1,
      before,
      { timeout: 8000 }
    )
    // 只看**词条那一列**：I-103 之后行里会显示真正的原文摘句，
    // 那句话里可能正好含着别的条目的词 —— 拿整行文字比会误判
    const terms = async (): Promise<string[]> =>
      page.locator('[data-testid="item-rows"] .lrow .lt').allInnerTexts()
    assert.ok(
      !(await terms()).includes(term),
      `静默之后还留在这一讲的列表里：${(await terms()).join(' / ')}`
    )

    // 但它没被删掉 —— 翻得出来（静默是终点，不是删除 D-087 / D-186）
    await page.click('[data-testid="toggle-silent"]')
    // 等**这一条**回来。不能等「行数回到原值」—— 翻出来的是**所有**静默条目，
    // 前面几条用例也静默过东西，数量只会更多
    await page.waitForFunction(
      (t) =>
        [...document.querySelectorAll('[data-testid="item-rows"] .lrow .lt')].some(
          (e) => e.textContent?.trim() === t
        ),
      term,
      { timeout: 8000 }
    )

    // 翻出不用再练的条目时，给的必须是「恢复」—— 再点一次「静默」等于什么都没发生
    await page.locator('[data-testid="item-rows"] .lrow .ck').first().click()
    await page.waitForSelector('[data-testid="bulk-unsilence"]')
    assert.equal(await page.locator('[data-testid="bulk-silence"]').count(), 0)

    // 收拾干净：恢复，后面的用例还要用这一条
    await page.click('[data-testid="bulk-unsilence"]')
    await page.waitForFunction(
      (w) => (document.querySelector('[data-testid="toast-text"]')?.textContent ?? '').includes(w),
      SILENCE_ACTIONS.restore,
      { timeout: 8000 }
    )
  })

  it('★ 认读测试只测勾中的这几条', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"] .lrow', { timeout: 8000 })
    await page.locator('[data-testid="lib-rows"] .lrow .ck').first().click()
    await page.locator('[data-testid="lib-rows"] .lrow .ck').nth(1).click()
    await page.click('[data-testid="bulk-reading"]')
    await page.waitForSelector('[data-testid="reading-overlay"]', { timeout: 8000 })
    await page.waitForSelector('[data-testid="card-front"]', { timeout: 8000 })
    // 队列长度就是勾中的条数 —— 不该把同一讲的兄弟条目一起拖进来
    assert.match(await page.locator('.side').first().innerText().catch(() => ''), /.*/)
    await page.click('[data-testid="reading-quit"]')
  })
})

/**
 * ★★★ T-9.15 · Lecture 页勾选 → 全选三态 → 随时认读 / 随时练习选中的（D-478 ⑦）
 *
 * 使用者「电脑也要」（Android T-5.18 已有）。三件事各钉一条：
 *   ① 全选那颗按钮的**字面**由 core 判据决定（`@core/selection.ts`，两端一份）——
 *      它错的时候界面不报错，只会说错话：明明选了 3 条，按钮写着「已全选这 20 条」
 *   ② 「取消全选」= 退出多选（不是留一个空选态）
 *   ③ ★★ **按 ids 练只动卡、不动 Lecture 间隔**（`study/lecture.ts::settleLectures` 头注）——
 *      他勾的那几条不能代表整个 Lecture，拿它们的正确率给整支重定期就是拿样本冒充总体
 *
 * ★ 负向对照写在 PLAN 里：把「按 ids 练不动 Lecture 间隔」拆掉 → ③ 当场红。
 */
describe('★★★ T-9.15 · Lecture 页：全选三态 + 随时认读 / 练习选中的', () => {
  it('★ 勾一条 → 多选条出现，全选按钮写「全选这 N 条」', async () => {
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    await page.waitForSelector('[data-testid="item-rows"] .lrow', { timeout: 8000 })
    const n = await page.locator('[data-testid="item-rows"] .lrow').count()
    assert.ok(n >= 2, `这一屏只有 ${n} 条，验不了三态`)

    await page.locator('[data-testid="item-rows"] .lrow .ck').first().click()
    await page.waitForSelector('[data-testid="selbar"]')
    assert.equal(
      await page.innerText('[data-testid="bulk-all"]'),
      `全选这 ${n} 条`,
      '★ 全选按钮的字面不对 —— 它说的是这一屏有多少条'
    )
  })

  it('★★ 点全选 → 字面变「取消全选」，且**每一行都勾上了**', async () => {
    await page.click('[data-testid="bulk-all"]')
    await page.waitForTimeout(300)
    assert.equal(await page.innerText('[data-testid="bulk-all"]'), '取消全选')
    const rows = await page.locator('[data-testid="item-rows"] .lrow').count()
    const checked = await page.locator('[data-testid="item-rows"] .lrow.sel').count()
    assert.equal(checked, rows, `★ 说是全选了，实际只勾上 ${checked} / ${rows}`)
    /**
     * ★ 不用正则：这个仓库里带反斜杠的查找串反复被吃掉一层（D-460）——
     *   我在这一条上又踩了一次，`\s` 落到文件里变成字面 `s`，
     *   于是正则成了 /已选s*5s*条/，永远匹配不上。改成读数字，绕开反斜杠。
     */
    const bar = (await page.innerText('[data-testid="selbar"]')).replace(/\s+/g, '')
    assert.ok(bar.includes(`已选${rows}条`), `★ 多选条上的数不对：${bar.slice(0, 40)}`)
  })

  it('★★ 再点一次 = 退出多选（多选条整个消失，不是留一个空的）', async () => {
    await page.click('[data-testid="bulk-all"]')
    await page.waitForSelector('[data-testid="selbar"]', { state: 'detached', timeout: 5000 })
  })

  it('★ 多选条那两颗按钮按术语表：随时认读 / 随时练习', async () => {
    await page.locator('[data-testid="item-rows"] .lrow .ck').first().click()
    await page.waitForSelector('[data-testid="selbar"]')
    assert.equal(await page.innerText('[data-testid="bulk-reading"]'), '随时认读')
    assert.match(await page.innerText('[data-testid="bulk-practice"]'), /随时练习/)
    const bar = await page.innerText('[data-testid="selbar"]')
    assert.ok(!bar.includes('认读测试'), '★ 「测试」这个说法 TM-42 已经退役')
  })

  it('★ 勾两条 → 随时认读，开起来的是只有这两条的一场', async () => {
    await page.locator('[data-testid="item-rows"] .lrow .ck').nth(1).click()
    const picked = await page.locator('[data-testid="item-rows"] .lrow.sel').count()
    assert.equal(picked, 2, '前置没成立：该勾中两条')

    await page.click('[data-testid="bulk-reading"]')
    await page.waitForSelector('[data-testid="reading-overlay"]', { timeout: 10000 })
    await page.waitForSelector('[data-testid="card-front"]', { timeout: 10000 })
    await page.click('[data-testid="reading-quit"]')
    await page.waitForSelector('[data-testid="reading-overlay"]', { state: 'detached', timeout: 8000 })
  })

  /**
   * ★★★ 按 ids 练的那一场，**结算时不动 Lecture 的排期**（`settleLectures` 头注那条）
   *
   * ── 为什么这一条必须自己造一场结算 ────────────────────────
   *
   * 第一版我写的是「勾两条 → 开认读 → 退出 → 排期没变」——**那是假绿**：
   * 根本没结算过，排期本来就不会变，把判据拆掉它照样绿。
   * 判据真正生效的地方是 `settleLectures(lectureIds, sessionId)`：
   * ids 场传的 `lectureIds` 是**空数组**，于是那个重定期的循环一次都不进。
   *
   * 所以这里走**他点按钮时同一条链**（`window.nyx.*` 到主进程），把两路都跑一遍：
   *   · ids 场（`[]`）  → 排期必须一个字不动
   *   · 整支场（`[1]`）→ 排期**会**动（这一半是对照：证明这条链真的能改排期，
   *     否则上一半的「没动」可能只是因为结算压根没生效）
   */
  it('★★★ ids 场结算不动 Lecture 排期，而整支场会动（两路一起验才算数）', async () => {
    const r = await page.evaluate(async () => {
      const before = (await window.nyx.data.lecture(1)).lecture
      // ① ids 场：lectureIds 是空的 —— 这正是勾选那条路传的
      const sid1 = await window.nyx.study.startSession('production', 'items', 0)
      const idsSettle = await window.nyx.study.settleLectures([], sid1)
      const afterIds = (await window.nyx.data.lecture(1)).lecture
      // ② 整支场：带 lectureIds —— 它**应该**给这一支算一份新排期
      const sid2 = await window.nyx.study.startSession('production', 'lecture', 1)
      const whole = await window.nyx.study.settleLectures([1], sid2)
      return {
        before: { due: before.dueAt, status: before.status },
        afterIds: { due: afterIds.dueAt, status: afterIds.status },
        idsPerLecture: idsSettle.perLecture.length,
        wholePerLecture: whole.perLecture.length
      }
    })

    assert.deepEqual(
      r.afterIds,
      r.before,
      '★★★ 按 ids 练的那一场把 Lecture 的排期改了 —— 他勾的那几条代表不了整支，' +
        '拿它们的正确率给整支重定期就是拿样本冒充总体（settleLectures 头注）'
    )
    /**
     * ★ 对照这一半**不看日期变没变** —— 那要求这一支正好在轮转中且这一场真有作答，
     *   条件一变用例就跟着漂（第一版就是这么红的：待审阅 + 零作答，整支场也没动）。
     *   改看结算结果自己说的那句：**「我给哪几支重定了期」**（`perLecture`）。
     *   ids 场必须是 0 支，整支场必须至少 1 支 —— 这与库里是什么状态无关。
     */
    assert.equal(
      r.idsPerLecture,
      0,
      '★★★ 按 ids 练的那一场给某一支重定了期 —— 他勾的那几条代表不了整支'
    )
    assert.ok(
      r.wholePerLecture >= 1,
      '★★ 整支场一支都没重定期 —— 那上面那句「ids 场没动」就说明不了任何事（这一条是对照）'
    )
  })
})

/**
 * ★ I-104 · 分析拆成两步（使用者 2026-08-05 傍晚）/**
 * ★ I-104 · 分析拆成两步（使用者 2026-08-05 傍晚）
 *   整体分析 = 提取知识点 + 分到三类，**不写详细解析**
 *   详细解析 = 按「我的收集 / 主动词汇 / 被动词汇」单独跑，可暂停、续跑跳过已写的
 */
describe('I-104 · 分析分两步：整体分析 / 按类别写解析', () => {
  it('★ 分析弹窗里有五选一的下拉框', async () => {
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="analyze"]')
    await page.waitForSelector('[data-testid="analyze-mode"]')
    const opts = await page.locator('[data-testid="analyze-mode"] option').allInnerTexts()
    /**
     * ★ 4 → **5**（2026-09-13）：使用者加了「引文匹配」。
     *   名单照旧写死 —— 这条用例的价值就在于
     *   「谁往这个下拉框里加了一项，都得来这儿交代一次」。
     * ★ 引文匹配和上面四项**不是一回事**：那四项调 AI 写解析，
     *   它是文本匹配（瞬时、确定、不花钱），所以面板上它有自己的说明与按钮。
     */
    assert.equal(opts.length, 5, `下拉框里有 ${opts.length} 项：${opts.join(' / ')}`)
    assert.match(opts.join(' '), /整体分析/)
    assert.match(opts.join(' '), /我的收集/)
    assert.match(opts.join(' '), /写作层/)
    assert.match(opts.join(' '), /理解层/)
    assert.match(opts.join(' '), /引文匹配/)
  })

  it('★ 选了类别之后，说清「还有几条没写解析」', async () => {
    await page.selectOption('[data-testid="analyze-mode"]', 'active')
    await page.waitForSelector('[data-testid="scope-note"]')
    const note = await page.innerText('[data-testid="scope-note"]')
    assert.match(note, /条|还没有知识点/, `范围说明看不出数量：${note}`)
    // 已经写过的自动跳过 —— 这句话必须在界面上，否则「续跑」只是我知道
    if (/还没写解析/.test(note)) assert.match(note, /自动跳过|接着/)
  })

  it('★ 整体分析**不写**每条的详细解析（详解是单独一步）', async () => {
    await page.selectOption('[data-testid="analyze-mode"]', 'whole')
    await page.waitForSelector('[data-testid="run-analyze"]')
    assert.equal(await page.locator('[data-testid="run-scope"]').count(), 0)
    await page.click('[data-testid="panel-cancel"]')
  })

  /**
   * 上面三条只验了「界面长对了」。使用者要的是**跑得起来**：
   * 有进度条、能中途停、停了下次接着跑。所以这一条真的跑一轮。
   */
  it('★ 真跑一轮：进度条和「暂停分析」同时在屏幕上', async () => {
    /**
     * ★ N-2 · 这一条要的前提是「主动词汇里**有还没写解析的**」。
     *
     * 以前这个前提是**那个 bug 自己造出来的**：前面有一条用例用 ✕ 删掉了一个条目，
     * 而单条删除当时不写 `term_ledger`，于是后面重新分析又把它捞了回来 ——
     * 回来的是一条**新建的、没有解析的** item，正好满足这里的前提。
     * N-2 修好之后（删掉的表达不再被重新收回来），前提就没了，
     * 这一条报的是「这一类 2 条全部写过解析了」。
     *
     * 所以前提要自己建，而不是靠上一个 bug 顺手留下。
     */
    await page.evaluate(async () => {
      await window.nyx.data.addItem(
        1,
        'weather the storm',
        'get through a hard time',
        'B',
        'weather the storm'
      )
    })
    /**
     * 跑的是「我的收集」这一类，不是「主动词汇」。
     * `analysisCounts` 的分类判据是 `source='self' and derived_from is null` → self，
     * **和 kind / layer 无关** —— 所以手动加进来的这一条必然落在「我的收集」。
     * 这三条用例验的是「按类别跑：有进度条、能暂停、续跑跳过已写的」，
     * 哪一类都成立，选一个前提**自己建得出来**的。
     */
    replyDelay = 250 // 让「正在跑」那一帧稳定存在，见 replyDelay 的注释
    try {
      await page.click('[data-testid="analyze"]')
      await page.waitForSelector('[data-testid="analyze-mode"]')
      await page.selectOption('[data-testid="analyze-mode"]', 'self')
      await page.waitForSelector('[data-testid="scope-note"]')
      assert.match(
        await page.innerText('[data-testid="scope-note"]'),
        /还没写解析/,
        '这一讲的「我的收集」没有待办，下面就白跑了'
      )
      await page.click('[data-testid="run-scope"]')

      await page.waitForSelector('[data-testid="analyze-running"]', { timeout: 8000 })
      const bar = page.locator('[data-testid="analyze-progress"]')
      await bar.waitFor({ timeout: 8000 })
      // 进度条得**是**进度条：读得出百分比，而且不是一直 0
      const pct = Number(await bar.getAttribute('data-pct'))
      assert(Number.isFinite(pct) && pct > 0, `进度条没有真实百分比：${pct}`)
      assert.equal(
        await page.locator('[data-testid="analyze-cancel"]').count(),
        1,
        '正在跑，却没有「暂停分析」—— 中途想停就只能等'
      )

      await page.waitForSelector('[data-testid="analyze-running"]', {
        state: 'detached',
        timeout: 60000
      })
    } finally {
      replyDelay = 0
    }
  })

  it('★ 跑完再进来，这一类自动跳过 —— 按钮点不动，并说清为什么', async () => {
    await page.click('[data-testid="analyze"]')
    await page.waitForSelector('[data-testid="analyze-mode"]')
    // 和上一条同一类 —— 上一条刚把它跑完，这一条验「再进来会自动跳过」
    await page.selectOption('[data-testid="analyze-mode"]', 'self')
    await page.waitForFunction(
      () =>
        !/正在数/.test(document.querySelector('[data-testid="scope-note"]')?.textContent ?? '正在数'),
      undefined,
      { timeout: 8000 }
    )
    const note = await page.innerText('[data-testid="scope-note"]')
    assert.match(note, /全部写过解析了/, `跑完了还说有待办：${note}`)
    assert.equal(await page.locator('[data-testid="run-scope"]').isDisabled(), true)
    await page.click('[data-testid="panel-cancel"]')
  })
})

describe('I-088 · 我的上传库按总原型的 .ur / .deriv 做', () => {
  before(async () => {
    // 这一支要有整句才看得出问题 —— 六列表格塞不下一句话
    await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('上传库对齐')
      const u = await window.nyx.data.createUnit(p, 'U')
      const l = await window.nyx.data.createLecture(u, 'L1')
      await window.nyx.data.addChunks(
        l,
        '我整理的表达',
        [
          'Delving more into what we mean by the tradition and the modern, we find the two categories collapse under scrutiny.',
          'The reversal matters because it changes what we should look for.'
        ].join(String.fromCharCode(10))
      )
    })
    await page.reload()
    await page.waitForSelector('[data-testid="nav-lib-upload"]', { timeout: 8000 })
  })

  it('★ 整句整行显示，不是六列表格', async () => {
    await page.click('[data-testid="nav-lib-upload"]')
    await page.waitForSelector('[data-testid^="lib-row-"]', { timeout: 8000 })
    assert.equal(
      await page.locator('[data-testid="lib-rows"] .lrow').count(),
      0,
      '上传库还在用六列表格 —— 1fr 那一格放不下一句话，长句必然截断'
    )
    assert.ok((await page.locator('[data-testid="lib-rows"] .ur').count()) > 0, '没有 .ur 行')
  })

  it('★ D-148 · 点原句展开它析出了什么（默认收起）', async () => {
    const id = (await page
      .locator('[data-testid^="lib-row-"]')
      .first()
      .getAttribute('data-testid'))!.replace('lib-row-', '')
    const deriv = page.locator(`[data-testid="deriv-${id}"]`)
    assert.equal(
      await deriv.evaluate((e) => e.classList.contains('show')),
      false,
      '一进来就全展开了'
    )

    await page.click(`[data-testid="lib-row-${id}"]`)
    await page.waitForFunction(
      (i) => document.querySelector(`[data-testid="deriv-${i}"]`)?.classList.contains('show'),
      id,
      { timeout: 8000 }
    )
    // 没析出成分也要说清，不能给一个空框让人以为「一条都没有」
    assert.match(await deriv.innerText(), /析出|正在取|还没/)
  })
})

/**
 * ★★★ D-471 / T-4.21 · 界面上统一说 **Lecture**，不说「讲次 / 这一讲 / 本讲」
 *
 * 使用者 2026-09-08 定：界面用 lecture（与 CLAUDE.md 术语表一致）。
 *
 * ── 为什么必须有这一条 ────────────────────────────────────
 * 改文案是**最容易悄悄退回去**的一类改动：谁写新界面时顺手打一句「这一讲」，
 * 类型检查、单测、别的 smoke 全都不会红 —— T-4.21 改完那一轮，
 * 20 多处文案换掉之后**所有套件照样全绿**，那正说明没有一条闸在钉它。
 *
 * ★ 判据分两半，缺一不可：
 *   ① 旧说法在这几屏上一个字都不许有（防退回）
 *   ② 新说法真的在场（防「把旧词删了、什么也没写」）
 * ★ 只钉**短语**（「讲次」「这一讲」「本讲」「哪一讲」），不钉单个「讲」字 ——
 *   使用者的 Lecture 名字里就可能带「讲」（测试数据里就有「横线建的一讲」），
 *   拿单字去判会把他自己的命名当成 bug。
 */
/**
 * ★★★ T-9.14 · 词条 ⋮ 的三样新东西（D-478 ③ ⑥）
 *
 * ③ 改正文（term / gloss / gloss_zh）：判据在 `core/analysis/edit.ts`，两端一份。
 *   这里验的是**他看得见 / 库里落下**的四件事：
 *     · 词条真的改了（页面上、库里都变）
 *     · **uid 不变** —— 换 uid = 对面看见「删了一条又来一条新的」，学习史全断
 *     · `corrections` 留下一笔，带 `field: term`（失效判定认这个键）
 *     · 页顶出现「这份解析是照着改之前的词条写的」
 * ⑥ 「随时认读这一条 / 随时练习这一条」（使用者 2026-09-08「加一下吧」）。
 *
 * ★ 负向对照打在 core（`npm test`）：拆掉留痕那一段 → `edit.test.ts` 里
 *   「改词条 → 解析算过期」当场红。这里是第 ③ 档，钉的是屏幕上的事。
 */
describe('★★★ T-9.14 · 词条 ⋮：修改正文 · 随时认读 / 练习这一条', () => {
  /** 走到一条**有解析**的词条详情页 —— stale 那一句要有解析块才谈得上 */
  const openAnalysed = async (): Promise<void> => {
    mode = 'analysis'
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.click('[data-testid="tab-active"]')
    await page.click('[data-testid="toggle-silent"]').catch(() => {})
    await page.waitForTimeout(300)
    await page
      .locator('[data-testid="item-rows"] .lrow', { hasText: 'bear the brunt' })
      .first()
      .click()
    await page.waitForSelector('[data-testid="detail-term"]', { timeout: 10000 })
  }

  const uidOf = (term: string): string | null => {
    const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
    db.exec('pragma busy_timeout = 5000')
    const row = db.prepare(`select uid from items where term = ?`).get(term) as
      | { uid: string }
      | undefined
    db.close()
    return row?.uid ?? null
  }

  it('★ ⋮ 里有「修改」和两项「随时…这一条」', async () => {
    await openAnalysed()
    await page.click('[data-testid="detail-menu"]')
    await page.waitForSelector('[data-testid="detail-menu-open"]')
    for (const id of ['item-edit', 'item-reading-one', 'item-practice-one']) {
      assert.equal(await page.locator(`[data-testid="${id}"]`).count(), 1, `⋮ 里少了 ${id}`)
    }
    // 名字按术语表 TM-43（随时认读 / 随时练习），不是 Android 那个旧说法
    assert.equal(await page.innerText('[data-testid="item-reading-one"]'), '随时认读这一条')
    assert.equal(await page.innerText('[data-testid="item-practice-one"]'), '随时练习这一条')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  })

  it('★★ 改词条：页面上变了 · uid 不变 · 留痕一笔 · 出处跟着改', async () => {
    await openAnalysed()
    const before = uidOf('bear the brunt of')
    assert.ok(before, '前置没成立：库里找不到这条')

    await page.click('[data-testid="detail-menu"]')
    await page.click('[data-testid="item-edit"]')
    await page.waitForSelector('[data-testid="edit-item-dialog"]')
    await page.fill('[data-testid="edit-term"]', 'bear the brunt for')
    await page.click('[data-testid="edit-save"]')
    await page.waitForSelector('[data-testid="edit-item-dialog"]', { state: 'detached', timeout: 8000 })

    assert.match(
      await page.innerText('[data-testid="detail-term"]'),
      /bear the brunt for/,
      '★ 页面上没变'
    )
    assert.equal(
      uidOf('bear the brunt for'),
      before,
      '★★ uid 变了 —— 那对面看见的就是「删了一条、又来了一条新的」，学习史全断'
    )

    const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
    db.exec('pragma busy_timeout = 5000')
    const row = db
      .prepare(
        `select b.content as c from analysis_blocks b join items i on i.id = b.item_id
          where i.term = ? and b.block = 'corrections'`
      )
      .get('bear the brunt for') as { c: string } | undefined
    const quote = db
      .prepare(`select quote from occurrences o join items i on i.id = o.item_id where i.term = ?`)
      .get('bear the brunt for') as { quote: string } | undefined
    db.close()

    assert.ok(row, '★★ 没留痕 —— 以后回头看「这句我当时怎么记的」就查不到了')
    const log = JSON.parse(row.c) as { field?: string; was?: string; should?: string }[]
    const last = log[log.length - 1]!
    assert.equal(last.field, 'term', '★★ 留痕少了 field —— 失效判定认的就是这个键')
    assert.equal(last.was, 'bear the brunt of')
    assert.equal(last.should, 'bear the brunt for')
    assert.ok(
      (quote?.quote ?? '').includes('bear the brunt for'),
      `★★ 出处摘句没跟着改（M-012）：${quote?.quote ?? '（没有出处）'}`
    )
  })

  it('★★ 改完页顶说一句「这份解析是照着改之前的词条写的」', async () => {
    await page.waitForSelector('[data-testid="stale-note"]', { timeout: 8000 })
    assert.match(await page.innerText('[data-testid="stale-note"]'), /改之前那条知识点/)
  })

  it('★ 拒绝的两种都说人话，而且库里零改动', async () => {
    await page.click('[data-testid="detail-menu"]')
    await page.click('[data-testid="item-edit"]')
    await page.waitForSelector('[data-testid="edit-item-dialog"]')

    // ① 词条清空
    await page.fill('[data-testid="edit-term"]', '   ')
    await page.click('[data-testid="edit-save"]')
    await page.waitForSelector('[data-testid="edit-item-error"]', { timeout: 8000 })
    assert.match(await page.innerText('[data-testid="edit-item-error"]'), /不能空/)

    // ② 一个字都没改
    await page.fill('[data-testid="edit-term"]', 'bear the brunt for')
    await page.click('[data-testid="edit-save"]')
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="edit-item-error"]')?.textContent ?? '').includes(
          '没有改动'
        ),
      undefined,
      { timeout: 8000 }
    )
    // 对话框还开着（没成就不该关），Esc 关得掉（D-440 · 新弹窗要进 esc 栈）
    assert.equal(await page.locator('[data-testid="edit-item-dialog"]').count(), 1)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="edit-item-dialog"]', { state: 'detached', timeout: 5000 })
  })

  it('★ 「随时认读这一条」真的开起一场只有这一条的认读', async () => {
    await page.click('[data-testid="detail-menu"]')
    await page.click('[data-testid="item-reading-one"]')
    await page.waitForSelector('[data-testid="reading-overlay"], [data-testid="reading-card"]', {
      timeout: 15000
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  })
})

describe('★★★ D-471 · 界面上统一说 Lecture（使用者 2026-09-08 定）', () => {
  /**
   * ★★ **这里只查「讲次」改名那四个变体，不是整张废弃词表**（2026-09-14 改名）。
   *
   * 原来这一条叫「五屏都没有旧说法」—— 名字听起来盖住了废弃词表全部，
   * 而它实际只查下面这四个词。双端对账时这个名字真的骗到了人：
   * 设置 › 练习 里一直写着「**首页**也能直接改」（该叫 Today），
   * 而这一条一直是绿的 —— 因为它既不查「首页」，也从没点开过练习 tab。
   *
   * ★ **整张表由 `check:copy` 守**（`scripts/check-copy.mjs`，14 个词，
   *   扫组件 ＋ 主进程里那几个文案文件）。那是静态闸，便宜、全覆盖。
   *   这一条守的是另一件事：**真渲染出来的屏幕上**没有讲次那几个词。
   *   两者不重复：静态闸看不见拼出来的字串，这一条看不全所有屏。
   *   ★ **别把整张表搬进来** —— 那就成了两份判据，而两份必然漂。
   */
  const OLD = ['讲次', '这一讲', '本讲', '哪一讲']

  /** 那一屏的正文里有没有旧说法 —— 返回撞上的那几个词 */
  const oldWordsOn = async (): Promise<string[]> => {
    const t = await page.locator('.view.on').innerText()
    return OLD.filter((w) => t.includes(w))
  }

  it('★★ ① 五个视图上没有「讲次」那四个变体（整张废弃词表由 check:copy 守）', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(400)
    assert.deepEqual(await oldWordsOn(), [], '首页上还有旧说法')

    await openLecture(page, 1)
    await page.waitForSelector('[data-testid="add-item"]', { timeout: 8000 })
    assert.deepEqual(await oldWordsOn(), [], 'Lecture 页上还有旧说法')

    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    assert.deepEqual(await oldWordsOn(), [], '知识点库上还有旧说法')

    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-dict"]')
    await page.waitForTimeout(400)
    assert.deepEqual(await oldWordsOn(), [], '设置 · 词典上还有旧说法')

    // 2026-09-09 · 报告的入口只剩首页那条横条（使用者裁），从那儿进
    await page.click('[data-testid="nav-home"]')
    await page.click('[data-testid="home-report"]')
    await page.waitForSelector('[data-testid="core-did"]', { timeout: 15000 })
    assert.deepEqual(await oldWordsOn(), [], '分析报告上还有旧说法')
  })

  it('★★ ② 新说法真的在场（不是把旧词删了就完）', async () => {
    await openLecture(page, 1)
    await page.waitForSelector('[data-testid="add-item"]', { timeout: 8000 })
    const t = await page.locator('.view.on').innerText()
    assert.ok(
      t.includes('本 Lecture 的知识点'),
      `★ Lecture 页那块标题不是「本 Lecture 的知识点」：${t.slice(0, 200)}`
    )
    // ••• 菜单里那两句（静默 / 删除）也要说 lecture
    await page.click('[data-testid="lecture-menu"]')
    await page.waitForTimeout(400)
    const menu = await page.innerText('body')
    assert.ok(
      menu.includes(silenceScopeAction(false, 'Lecture')) ||
        menu.includes(silenceScopeAction(true, 'Lecture')),
      '★ ••• 菜单里那句静默没说 Lecture'
    )
    assert.ok(menu.includes('删除这个 Lecture'), '★ ••• 菜单里那句删除没说 Lecture')
    for (const w of OLD) {
      assert.ok(!menu.includes(w), `★ ••• 菜单里还写着「${w}」`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  })
})

/**
 * ★ 欠着的一条（写在这儿免得下一个人以为没人想过）：
 *   **`practice-settle` 的「进结算屏即出」没有 ③ 档用例。**
 *
 *   要验它得在这一套的**最后**再开一轮产出练习（`reload` → 回讲次页 → 取题 → 答题），
 *   而跑到这儿时这一讲的题已经被前面几十条用例消耗过，重开那一轮取不到题 ——
 *   卡在等 `answer` 上 25 秒超时，和引导本身无关。
 *   （夹在中间又会把后面 7 条弄红：它们接着用**这一轮**的题号与答题状态。）
 *
 *   今天钉着它的是 `check:guide-ids`（触发与 `data-guide` 目标成对）＋ core 名单那条。
 *   要补的话得给这一套一个**独立的第二讲**（只给这条用），那是另一笔活。
 */

describe('控制台', () => {
  it('渲染进程没有任何 console.error 或未捕获异常', () => {
    assert.deepEqual(
      { consoleErrors, pageErrors },
      { consoleErrors: [], pageErrors: [] },
      `渲染进程报错了：\n${[...consoleErrors, ...pageErrors].join('\n')}`
    )
  })
})
