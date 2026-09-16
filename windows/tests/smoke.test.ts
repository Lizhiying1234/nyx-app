import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLecture } from './tree.ts'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 「点一遍」验收 · D-262 / D-259
 *
 * 静态检查管版式，这个管功能。上一版三个 bug（I-001 分支不渲染、I-012 事件没人接、
 * I-013 字段名写错导致渲染抛异常）**静态检查一个都查不出来**，因为它们只有在
 * 真的跑起来、真的点下去的时候才会现形。
 *
 * 三条规矩：
 *   1. 渲染进程的 console.error 与未捕获异常**全部收集**，出现任何一条就判失败
 *   2. 每点一个按钮，**断言 DOM 上真的发生了变化**（不是「没报错就算过」）
 *   3. **主动把界面推进失败态**，断言错误文案真的看得见
 *
 * 跑在一个用完就扔的数据目录上，不碰你的真实数据。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-smoke-'))

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []
const pageErrors: string[] = []

before(async () => {
  await startFakeAi()
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  // 默认 30 秒太长：一旦哪里断了，后面每条断言都要白等 30 秒，
  // 5 条就是两分半纯等待，排查一次要跑好几分钟。本地应用响应是毫秒级的，
  // 5 秒足够宽松，坏了立刻现形。
  page.setDefaultTimeout(5000)
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
})

after(async () => {
  await app?.close()
  aiServer?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

describe('外壳', () => {
  it('窗口打开了，标题栏是软件自己画的那条（D-255）', async () => {
    assert.equal(await page.title(), 'Nyx')
    await page.waitForSelector('.titlebar .wb i', { timeout: 8000 })
  })

  it('窗口按钮点得动 —— 拖动区没把点击吞掉（D-255）', async () => {
    await page.click('[data-testid="win-max"]')
    await page.waitForTimeout(300)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => {
        /**
         * ★★ 不能写 `getAllWindows()[0]`（2026-09-14 实测）—— 它**不按创建顺序排**。
         *   桌面那颗悬浮球是 `alwaysOnTop`，排在了主窗前面；
         *   而它 `maximizable: false`，`isMaximized()` 永远是 false。
         *   于是这条用例会指着一个完全无辜的地方说「按钮没加 no-drag」。
         *   判据和 `tests/win.ts` 一致：渲染进程自己分流用的那把钥匙。
         */
        const w = BrowserWindow.getAllWindows().find((x) => {
          const u = x.webContents.getURL()
          return !u.includes('overlay=') && !u.includes('bubble=') && !u.includes('marker=')
        })
        return w?.isMaximized() ?? null
      }),
      true,
      '点了最大化没反应 —— 多半是按钮没加 no-drag'
    )
    await page.click('[data-testid="win-max"]')
    await page.waitForTimeout(300)
  })

  /**
   * ★ D-456（2026-09-03）· 覆盖面的守卫留着，词换了
   *
   * 使用者原话：「不要为了极简把导航大量砍掉」—— 这条用例正是防那个的，
   * 所以**一行不减**。D-457 那一版把三个词换成了 今天 / 我的知识 / 全部知识点。
   *
   * ★★ 2026-09-03 晚使用者又裁「侧边栏还是按照原来的软件的侧边栏来」，
   *   整块撤回到 D-457 之前那版（提交 f6335d4，Phase 1A 收进主线）——
   *   三个词跟着换回 首页 / 项目 / 知识点。**守卫本身一个字不动，七行仍是七行。**
   *   那次撤回没同步改这条用例，2026-09-04 跑全量 smoke 时它当场红了 ——
   *   用例断言的是**文字看得见**，不是 testid，换了名字它就该红。
   */
  it('侧边栏顶层七行都在（D-042）', async () => {
    const text = await page.locator('.side').innerText()
    // ★ D-476 术语落地（2026-09-08）：侧栏七个空间名按术语表
    for (const row of ['搜索', 'Today', '项目', 'Vault', '文件学习', 'Settings', '回收站']) {
      assert.ok(text.includes(row), `侧边栏缺了「${row}」`)
    }
  })

  it('空着的地方说得清为什么空、以及接下来干什么（C-004）', async () => {
    try {
      // 设置页七个子页现在全做完了，不再有「这一页还没做」。
      // C-004 要防的是**点进去一片死寂**——所以现在验的是：
      // 没放词典时那一页要说清「没有也照常用」，而不是一个空白框。
      await page.click('[data-testid="nav-settings"]')
      await page.click('[data-testid="set-tab-dict"]')
      assert.equal(
        await page.locator('[data-testid="settings-todo"]').count(),
        0,
        '还有没做完的占位页'
      )
      const note = page.locator('[data-testid="dict-empty"]')
      await note.waitFor()
      assert.match(await note.innerText(), /照常用/)
      // 而且得告诉他怎么办 —— 不能只说「没有」
      await page.locator('[data-testid="dict-folder"]').waitFor()
    } finally {
      // 不管断言过没过都回首页 —— 否则后面每一条都被卡在这一页上，
      // 一个断言失败会拖垮整个套件（上一轮就是这么白跑了两分半）。
      await page.click('[data-testid="nav-home"]')
    }
  })
})

describe('F-01 · 先贴，贴完再问归属', () => {
  it('空状态给的是「贴一段英文开始」，不是「请先建项目」', async () => {
    const start = page.locator('[data-testid="home-start"]')
    await start.waitFor({ timeout: 5000 })
    assert.match(await start.innerText(), /贴一段英文开始/)
  })

  it('点一下就进了工作台 —— 不用先想好三层的名字', async () => {
    await page.click('[data-testid="home-start-btn"]')
    await page.waitForSelector('[data-testid="drop-original"]', { timeout: 8000 })
    const path = await page.locator('[data-testid="lecture-path"]').innerText()
    assert.match(path, /未命名项目/)
    assert.match(path, /第一单元/)
  })
})

describe('R-001 · 两个落区', () => {
  it('原文 和 我自己整理的表达，是两个入口', async () => {
    const a = await page.locator('[data-testid="drop-original"]').innerText()
    const b = await page.locator('[data-testid="drop-chunk"]').innerText()
    assert.match(a, /原文材料/)
    assert.match(a, /交给 AI 拆/)
    assert.match(b, /我的收集/)
    assert.match(b, /原样入库/)
  })
})

describe('chunk 这条路 · 整条不需要 AI（D-006 / M-015）', () => {
  const three = 'hold sway over\na far cry from\ngrasp the gravity of'

  it('贴三行 → 收下三条', async () => {
    await page.click('[data-testid="drop-chunk"] button')
    await page.fill('[data-testid="compose-title"]', '7月读到的表达')
    await page.fill('[data-testid="compose-text"]', three)
    assert.match(await page.locator('[data-testid="compose-count"]').innerText(), /3 句/)
    await page.click('[data-testid="compose-submit"]')

    const receipt = page.locator('[data-testid="chunk-receipt"]')
    await receipt.waitFor({ timeout: 8000 })
    assert.match(await receipt.innerText(), /收下 3 句/)
    assert.match(await receipt.innerText(), /不出产出题/)
  })

  it('三条真的落进了「我的收集」，而且看得见 —— 不是加完看不见（I-002）', async () => {
    await page.click('[data-testid="tab-self"]')
    const rows = page.locator('[data-testid="item-rows"] .lrow')
    assert.equal(await rows.count(), 3)
    const text = await page.locator('[data-testid="item-rows"]').innerText()
    assert.match(text, /hold sway over/)
    assert.match(text, /a far cry from/)
    assert.match(text, /grasp the gravity of/)
  })

  it('自己收集的整句标成被动词汇 —— 只做理解与朗读，不进产出训练', async () => {
    const first = page.locator('[data-testid="item-rows"] .lrow').first()
    assert.match(await first.locator('.ln').innerText(), /理解层/)
  })

  it('数据真的进了库 —— 刷新界面之后还在', async () => {
    await page.reload()
    // 直接回 lecture 里数条目，比数首页那行字更实：它验的是数据，不是文案
    await openLecture(page, 1)
    await page.click('[data-testid="tab-self"]')
    await page.waitForSelector('[data-testid="item-rows"] .lrow')
    assert.equal(await page.locator('[data-testid="item-rows"] .lrow').count(), 3)
    await page.click('[data-testid="nav-home"]')
  })
})

describe('D-026 · 重复收集要当场说出来（M-030）', () => {
  it('再贴一次同一条 → 界面上明确提示，并说清这意味着什么', async () => {
    await openLecture(page, 1)
    await page.waitForSelector('[data-testid="add-chunk"]', { timeout: 8000 })
    await page.click('[data-testid="add-chunk"]')
    await page.fill('[data-testid="compose-text"]', 'hold sway over')
    await page.click('[data-testid="compose-submit"]')

    const warn = page.locator('[data-testid="repeat-warning"]')
    await warn.waitFor({ timeout: 8000 })

    // I-055 · 摘要里先给数量和后果 —— 58 条时一条一个框会把整页淹掉
    const summary = await warn.innerText()
    assert.match(summary, /1 条以前收过/)
    assert.match(summary, /攻坚区/, '没说清后果 —— 重复收集是比测试成绩更硬的证据')

    // 具体是哪几条，展开就看得到
    await page.click('[data-testid="repeat-toggle"]')
    await page.waitForSelector('[data-testid="repeat-row"]')
    assert.match(await warn.innerText(), /hold sway over/)
  })
})

describe('原文这条路', () => {
  it('贴一份原文 → 材料条上出现它，并标着 原文 / 5', async () => {
    await page.click('[data-testid="add-original"]')
    await page.fill('[data-testid="compose-title"]', 'Ch1-Malthus')
    await page.fill(
      '[data-testid="compose-text"]',
      'The forces that hold sway over long-run growth are demographic, not technological.'
    )
    await page.click('[data-testid="compose-submit"]')
    await page.waitForSelector('[data-testid="matbar"]', { timeout: 8000 })
    const bar = await page.locator('[data-testid="matbar"]').innerText()
    assert.match(bar, /Ch1-Malthus/)
    assert.match(bar, /原文 1 \/ 5/)
  })
})

// ══════════════════════════════════════════════════════════════
// AI 链路 · 用本地假服务器验证，不需要任何真实 API key
// ══════════════════════════════════════════════════════════════

type Mode =
  | 'ok'
  | 'auth'
  | 'quota'
  | 'server'
  | 'garbage'
  | 'derived'
  | 'question'
  | 'score2'
  | 'score3'
  | 'fresh'
let mode: Mode = 'ok'
let aiPort = 0
let aiServer: import('node:http').Server

const FAKE_ITEMS = {
  items: [
    {
      term: 'hold sway',
      gloss: 'to have dominant influence over something',
      glossZh: '说了算',
      layer: 'B',
      kind: 'chunk',
      hitBy: ['comprehension', 'writing'],
      confidence: 0.4,
      quote: 'the forces that hold sway over long-run growth are demographic',
      para: 1,
      why: "A learner would write 'have a big influence on'."
    },
    {
      term: 'Malthusian Trap',
      gloss: 'the idea that population growth outpaces output gains',
      glossZh: '马尔萨斯陷阱',
      layer: 'B',
      kind: 'proper',
      hitBy: ['comprehension'],
      confidence: 0.9,
      quote: 'escaping the Malthusian Trap took two centuries',
      para: 1,
      why: 'Background concept.'
    }
  ]
}

const FAKE_DERIVED = {
  sentences: [
    {
      index: 1,
      derived: [
        {
          term: 'delve into',
          gloss: 'to examine something in depth',
          glossZh: '深入探究',
          layer: 'B',
          kind: 'chunk',
          confidence: 0.8,
          why: "A learner would write 'look at more deeply'."
        }
      ]
    }
  ]
}

/** 全新的条目，供审阅→认读→产出那一段用（前面的分析已经把老词都入过库了） */
const FAKE_FRESH = {
  items: ['bear the brunt of', 'a far cry from', 'at the mercy of'].map((term, i) => ({
    term,
    gloss: `to be the one that suffers most (${i})`,
    glossZh: '首当其冲',
    layer: 'B',
    kind: 'chunk',
    hitBy: ['writing'],
    confidence: 0.5 + i * 0.1,
    quote: `Coastal towns ${term} the storms each winter.`,
    para: 1,
    why: 'A learner would write something flatter.'
  }))
}

const FAKE_QUESTIONS = {
  questions: [1, 2, 3, 4, 5].flatMap((tier) =>
    [0, 1, 2].map((k) => ({
      tier,
      type: ['造句', '句子改写', '错误订正', '限定写作', '情景任务'][tier - 1],
      prompt: `Write one sentence about topic ${tier}-${k} using "hold sway".`,
      context: tier === 1 ? 'original' : 'unseen',
      broken: null,
      reference: 'Tradition still holds sway over village life.'
    }))
  )
}

const FAKE_SCORE_2 = {
  grade: 2,
  note: 'It takes "over", never "on".',
  why: 'Holds together and the meaning lands, but the preposition is wrong.',
  annotations: [
    {
      span: 'on this debate',
      label: 'collocation',
      problem: '"hold sway" takes "over", never "on".',
      fix: 'over this debate'
    }
  ]
}

const FAKE_SCORE_3 = { grade: 3, note: 'Fine.', why: 'Correct and the register fits.', annotations: [] }

/**
 * 假 API 服务器。
 * **生命周期挂在最外层**，不挂在某个 describe 上 —— 挂在 describe 上的话，
 * 那一节跑完 after 就把服务器关了，后面每一个用到 AI 的测试都会失败在「连不上网」，
 * 而真正的原因跟被测代码毫无关系。（踩过一次。）
 */
export async function startFakeAi(): Promise<void> {
  const { createServer } = await import('node:http')
  aiServer = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (mode === 'auth') return res.writeHead(401).end('{"error":"invalid api key"}')
      if (mode === 'quota') return res.writeHead(429).end('{"error":"quota exceeded"}')
      if (mode === 'server') return res.writeHead(500).end('{"error":"boom"}')
      if (mode === 'garbage') return res.writeHead(200).end('<html>not an api</html>')

      const probe = body.includes('NYX_OK')
      // 出题和判分是两种不同的调用，靠 mode 切换假回复
      const content = probe
        ? 'NYX_OK'
        : mode === 'derived'
          ? JSON.stringify(FAKE_DERIVED)
          : mode === 'fresh'
            ? JSON.stringify(FAKE_FRESH)
            : mode === 'question'
              ? JSON.stringify(FAKE_QUESTIONS)
              : mode === 'score2'
                ? JSON.stringify(FAKE_SCORE_2)
                : mode === 'score3'
                  ? JSON.stringify(FAKE_SCORE_3)
                  : JSON.stringify(FAKE_ITEMS)
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  await new Promise<void>((r) => aiServer.listen(0, '127.0.0.1', r))
  aiPort = (aiServer.address() as { port: number }).port
}

describe('AI 链路（本地假服务器）', () => {
  it('设置页有 AI 那一 tab，且服务商快填是真能点的（C-004）', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.waitForSelector('[data-testid="slot-heavy"]', { timeout: 8000 })
    await page.click('[data-testid="prov-deepseek"]')
    assert.equal(
      await page.inputValue('[data-testid="baseurl-heavy"]'),
      'https://api.deepseek.com/v1',
      '点了服务商但 Base URL 没填上 —— 按钮没接事件'
    )
  })

  it('默认三组共用一套，打开开关才分开（D-254）', async () => {
    assert.equal(await page.locator('[data-testid="slot-light"]').count(), 0)
    await page.click('[data-testid="split-toggle"]')
    await page.waitForSelector('[data-testid="slot-light"]', { timeout: 3000 })
    assert.equal(await page.locator('[data-testid="slot-long"]').count(), 1)
    await page.click('[data-testid="split-toggle"]')
    await page.waitForTimeout(150)
    assert.equal(await page.locator('[data-testid="slot-light"]').count(), 0)
  })

  it('填上假服务器，保存 —— key 存进去了但界面拿不到它（D-220）', async () => {
    await page.fill('[data-testid="baseurl-heavy"]', `http://127.0.0.1:${aiPort}/v1`)
    await page.fill('[data-testid="model-heavy"]', 'fake-model')
    await page.fill('[data-testid="key-heavy"]', 'sk-test-not-a-real-key')
    await page.click('[data-testid="save-ai"]')
    await page.waitForSelector('[data-testid="save-ok"]', { timeout: 8000 })

    // 保存后输入框被清空，且占位符改成「已保存一把 key」——界面永远拿不到 key 本身
    assert.equal(await page.inputValue('[data-testid="key-heavy"]'), '')
    const ph = await page.getAttribute('[data-testid="key-heavy"]', 'placeholder')
    assert.match(ph ?? '', /已保存/)
  })

  it('「测试连接」连得上就说连上了，还给往返毫秒数', async () => {
    mode = 'ok'
    await page.click('[data-testid="test-heavy"]')
    await page.waitForSelector('[data-testid="test-ok"]', { timeout: 10000 })
    assert.match(await page.locator('[data-testid="test-ok"]').innerText(), /连上了/)
  })

  it('★ 四种失败态各说各的话，不是一句「出错了」（D-205）', async () => {
    const cases: [Mode, RegExp][] = [
      ['auth', /key 或 Base URL 有误/],
      ['quota', /额度用尽|限速/],
      ['server', /服务端出错/],
      ['garbage', /不是 JSON/]
    ]
    for (const [m, expect] of cases) {
      mode = m
      await page.click('[data-testid="test-heavy"]')
      await page.waitForSelector('[data-testid="test-fail"]', { timeout: 10000 })
      const t = await page.locator('[data-testid="test-fail"]').innerText()
      assert.match(t, expect, `${m} 这一档的文案不对：\n${t}`)
      await page.waitForTimeout(80)
    }
  })

  it('服务器整个不在时，说的是「连不上网」，不是「key 不对」', async () => {
    await new Promise<void>((r) => aiServer.close(() => r()))
    await page.click('[data-testid="test-heavy"]')
    await page.waitForSelector('[data-testid="test-fail"]', { timeout: 15000 })
    assert.match(await page.locator('[data-testid="test-fail"]').innerText(), /连不上/)
    // 把服务器起回来给后面的分析用
    await new Promise<void>((r) => aiServer.listen(aiPort, '127.0.0.1', r))
  })

  it('★ 点「分析」→ 真的提取出知识点并落库', async () => {
    mode = 'ok'
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)
    await page.waitForSelector('[data-testid="analyze"]', { timeout: 8000 })
    await page.click('[data-testid="analyze"]')
    await page.click('[data-testid="run-analyze"]')

    const done = page.locator('[data-testid="analyze-done"]')
    await done.waitFor({ timeout: 20000 })
    assert.match(await done.innerText(), /新增 2 条/)

    await page.click('[data-testid="tab-active"]')
    const active = await page.locator('[data-testid="item-rows"]').innerText()
    assert.match(active, /hold sway/, '写作层 Tab 里没有 hold sway')
  })

  /**
   * ★★★ A-1（2026-09-03 UI 审计）· 打开一讲，**不许给他看空白**
   *
   * 原来三个 Tab 的默认值写死 `'self'`（我的收集）。而「我的收集」只装
   * 「本讲我自己上传的原句」，**绝大多数讲次一条都没有** ——
   * 于是一个刚分析出 2 条知识点的讲次，打开之后正中央写着
   * 「**这个 Tab 是空的**」。他会以为这一讲什么都没有。
   *
   * ★ 这一条验的不是「默认值等于 active」（那是内部状态），
   *   是**他眼睛看得见的东西**：进来那一眼，屏幕上有没有内容。
   */
  it('专有名词被压回被动 —— 专名只做理解，绝不进产出训练（M-011）', async () => {
    await page.click('[data-testid="tab-passive"]')
    const passive = await page.locator('[data-testid="item-rows"]').innerText()
    assert.match(
      passive,
      /Malthusian Trap/,
      '模型把专名标成了 B，软件应该压回 A —— 专名不进产出训练'
    )
  })

  it('原文出处跟着进来了 —— 不记就永远补不回来（M-012）', async () => {
    await page.click('[data-testid="tab-active"]')
    const quotes = await page.locator('.quo').allInnerTexts()
    assert.ok(
      quotes.some((q) => q.includes('hold sway over long-run growth')),
      `原文摘句没存下来，实际：${JSON.stringify(quotes)}`
    )
  })

  it('★ 我收集的句子也要被析出成分 —— 一份上传两类产物（D-016 / D-056 / D-075）', async () => {
    // 这条是使用者实际用出来的缺口：分析只捞了原文材料，
    // 「我的收集」那三句从没进过 AI，所以析出项一条都没有。
    mode = 'derived'
    await page.click('[data-testid="add-chunk"]')
    await page.fill(
      '[data-testid="compose-text"]',
      'Delving more into what we mean by the tradition and the modern'
    )
    await page.click('[data-testid="compose-submit"]')
    await page.waitForSelector('[data-testid="analyze"]')
    await page.click('[data-testid="analyze"]')
    await page.click('[data-testid="run-analyze"]')

    const done = page.locator('[data-testid="analyze-done"]')
    await done.waitFor({ timeout: 15000 })
    assert.match(await done.innerText(), /析出 1 个成分/)

    /**
     * ★★ 2026-09-01 · 需求 ⑩ 改了这一条的**落点**（不是它的存在）。
     *
     * 使用者原话：「所有刚刚新增进入 Nyx 的知识点，默认都必须是『认读』状态……
     * **无论来源是什么**……只有用户之后主动重新设置，才可以变成『练习』。」
     *
     * 所以析出项现在落在**被动（认读 A）**，不再是主动（产出 B）。
     * D-016 / D-056 / D-075 那三条要的「一份上传出两类产物」原样成立 ——
     * 原句留在「我的收集」、成分单独成条 —— 变的只是成分进哪一线。
     * ★ 这一条如果他觉得析出该是例外（自己写出来的句子里拆出来的东西，
     *   本来就是「已经会用」的证据），改回来就是 analyze.ts 里那一行。
     */
    await page.click('[data-testid="tab-passive"]')
    assert.match(
      await page.locator('[data-testid="item-rows"]').innerText(),
      /delve into/,
      '析出项没进被动词汇 Tab（⑩：新知识点一律先进认读）'
    )
    await page.click('[data-testid="tab-self"]')
    const self = await page.locator('[data-testid="item-rows"]').innerText()
    assert.match(self, /Delving more into/, '原句不见了 —— 它必须原样留着（M-015）')
    assert.match(self, /已析出 1 个成分/, '原句行上没显示拆出了什么（D-148）')
    mode = 'ok'
  })

  it('★ 分析前能按材料给临时指令，而且看得到到底发出去了什么', async () => {
    await page.click('[data-testid="analyze"]')
    await page.waitForSelector('[data-testid="analyze-panel"]')

    // 三个起手预设都在，而且点了真的填进去
    await page.click('[data-testid="preset-chips"] >> text=时评随笔')
    const filled = await page.inputValue('[data-testid="extra-text"]')
    assert.match(filled, /commentary/i, '点了预设但补充指令没填上 —— 按钮没接事件')

    // 自己敲一段，并断言它真的进了组装后的提示词
    await page.fill('[data-testid="extra-text"]', '这篇是访谈实录，口语表达优先。')
    await page.click('[data-testid="show-full"]')
    const full = page.locator('[data-testid="full-prompt"]')
    await full.waitFor()
    const text = await full.innerText()
    assert.match(text, /访谈实录/, '临时指令没出现在完整提示词里')
    assert.match(text, /This material specifically/, '临时指令没挂在基线之后')
    assert.match(text, /"items"/, '输出契约被挤掉了 —— 那会让分析成功但一条都提不出来')

    /**
     * ★ I-157 · 「基线来自」那一行说的得是**真的那一层**。
     *   这台机器上 `analyze-material` 走的是磁盘那份（它不在可覆盖名单里），
     *   所以这里该印文件路径 —— 既不能说「内置副本」（那是兜底那层），
     *   也不能说「你改过的那份」（他根本没改过）。
     *   覆盖那一层的账在 ② 档 P-10 上钉（Playwright 这一层造不出那个状态）。
     */
    const src = await page.locator('[data-testid="prompt-source"]').innerText()
    assert.match(src, /analyze-material\.md/, `基线那一行没说清读的是哪份：${src}`)
    assert.ok(!src.includes('内置副本') && !src.includes('你改过的'), `基线那一行说错了层：${src}`)

    await page.click('[data-testid="panel-cancel"]')
  })

  it('临时指令能存成预设，存完能选、能删', async () => {
    await page.click('[data-testid="analyze"]')
    await page.waitForSelector('[data-testid="analyze-panel"]')
    await page.fill('[data-testid="extra-text"]', '只挑动词搭配，名词性的都别要。')
    await page.fill('[data-testid="preset-name"]', '只要动词搭配')
    await page.click('[data-testid="save-preset"]')

    const chip = '[data-testid="preset-chips"] >> text=只要动词搭配'
    try {
      await page.waitForSelector(chip)
    } catch (e) {
      const panelErr = await page.locator('[data-testid="panel-error"]').allInnerTexts()
      const chips = await page.locator('[data-testid="preset-chips"]').innerText()
      throw new Error(
        `预设没存上。面板报错：${JSON.stringify(panelErr)}\n当前 chips：${chips}\n原始：${String(e).slice(0, 200)}`
      )
    }
    await page.click('[data-testid="del-preset"]')
    // 等它真的从 DOM 里消失，而不是睡一觉再数 —— 睡固定时长既慢又不可靠
    try {
      await page.waitForSelector(chip, { state: 'detached' })
    } catch (e) {
      const panelErr = await page.locator('[data-testid="panel-error"]').allInnerTexts()
      throw new Error(
        `删了但还在。面板报错：${JSON.stringify(panelErr)}\n${String(e).slice(0, 160)}`
      )
    }
    await page.click('[data-testid="panel-cancel"]')
  })

  it('分析结果上标着这次用的是哪条指令 —— 结果不一样时能回溯', async () => {
    mode = 'ok'
    await page.click('[data-testid="add-original"]')
    await page.fill('[data-testid="compose-title"]', '带指令的材料')
    await page.fill('[data-testid="compose-text"]', 'A short passage for the preset test.')
    await page.click('[data-testid="compose-submit"]')

    await page.click('[data-testid="analyze"]')
    await page.click('[data-testid="preset-chips"] >> text=学术论文')
    await page.click('[data-testid="run-analyze"]')

    // 这一份材料里的表达前面已经入过库，所以「新增」会是 0 ——
    // 而这恰恰是最该看见「用的哪条指令」的时候。
    const used = page.locator('[data-testid="analyze-preset"]')
    await used.waitFor({ timeout: 15000 })
    assert.match(await used.innerText(), /学术论文/)
  })

  it('分析失败时说清是哪一份材料失败的，并给下一步（D-072 / D-205）', async () => {
    mode = 'auth'
    await page.click('[data-testid="add-original"]')
    await page.fill('[data-testid="compose-title"]', '第二份材料')
    await page.fill('[data-testid="compose-text"]', 'Another passage about cities and density.')
    await page.click('[data-testid="compose-submit"]')
    await page.waitForSelector('[data-testid="analyze"]', { timeout: 8000 })
    await page.click('[data-testid="analyze"]')
    await page.click('[data-testid="run-analyze"]')

    // 多份材料一起失败时每份各占一条 —— 这里只验最新那一份的措辞
    const fails = page.locator('[data-testid="analyze-partial-fail"]')
    await fails.first().waitFor({ timeout: 20000 })
    const t = (await fails.allInnerTexts()).join('\n')
    assert.match(t, /第二份材料/, '没说清是哪一份失败的')
    assert.match(t, /key 或 Base URL 有误/)
    assert.match(t, /没有作废/, '没告诉使用者已成功的部分保留了')
    mode = 'ok'
  })
})

describe('失败态 · 界面上必须看得见原因（对着 I-001）', () => {
  it('贴了个空的 → 当场说为什么，不是「点了没反应」', async () => {
    await page.click('[data-testid="add-original"]')
    await page.fill('[data-testid="compose-text"]', '   ')
    await page.click('[data-testid="compose-submit"]')
    const err = page.locator('[data-testid="compose-error"]')
    await err.waitFor({ timeout: 3000 })
    assert.match(await err.innerText(), /还没有内容/)
  })

  it('主进程抛错时，错误一路传到界面上，还给得出重试', async () => {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('data:lecture')
      ipcMain.handle('data:lecture', () => {
        throw new Error('故意让它失败 · 冒烟测试')
      })
    })
    await page.click('[data-testid="compose-cancel"]')
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, 1)

    const err = page.locator('[data-testid="lecture-error"]')
    await err.waitFor({ timeout: 5000 })
    assert.match(await err.innerText(), /故意让它失败/, '错误被吞了 —— 这正是 I-001')
    // 关键：失败时不能退回去显示空态或加载态
    assert.equal(await page.locator('[data-testid="drop-original"]').count(), 0)
    assert.equal(await page.locator('[data-testid="lecture-loading"]').count(), 0)
  })
})

describe('控制台', () => {
  it('渲染进程没有任何 console.error 或未捕获异常', () => {
    assert.deepEqual(
      { consoleErrors, pageErrors },
      { consoleErrors: [], pageErrors: [] },
      `渲染进程报错了：\n${[...consoleErrors, ...pageErrors].join('\n')}`
    )
  })
})
