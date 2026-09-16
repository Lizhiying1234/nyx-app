import { SILENCE_FILTER_NAME } from '../src/core/silence.ts'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 报告的验收 · D-043
 *
 * 报告是「攒够一两个月才有东西看」的东西，所以**先编一套半年的假数据**再验。
 * 数据是编的，但**编的方式是真的** —— seed-demo.ts 里所有状态迁移都按 core/ 的规则走
 * （连续 3 次正确才静默、5 次未达标才进攻坚），所以这里断言的形状和真实使用长出来的
 * 是同一类。
 *
 * 跑在自己的临时目录上，用完即删。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-report-'))

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []
const pageErrors: string[] = []

before(async () => {
  // 灌数据：跑在 Electron 主进程里（better-sqlite3 是按 Electron 的 ABI 编译的）
  const seeded = spawnSync(
    join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [join(root, 'out', 'main', 'seed-demo.js')],
    { cwd: root, env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }, encoding: 'utf8' }
  )
  assert.equal(seeded.status, 0, `灌数据失败：${seeded.stderr ?? ''}`)

  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  /**
   * ★ T-4.11：首页这根条从「就地展开」改成了**入口** —— 点它现在是跳页
   *   （`k: 'report'`）。这一行没改，但它验的事已经变了：
   *   点完之后必须**在报告页上**，而不是在首页里多出一块。
   */
  await page.click('[data-testid="home-report"]')
  /**
   * ★ D-467 · 页面收成三层之后，「算完了没有」的锚点也换了：
   *   `report-flow` 现在在第三层里、默认收着（壳在、内容不在），
   *   所以等的是**第一层那三句话**（证据层算完才有）。
   */
  await page.waitForSelector('[data-testid="report-core"]', { timeout: 15000 })
  await page.waitForSelector('[data-testid="core-did"]', { timeout: 15000 })
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

/** 第三层是收着的 —— 要看内容得先点开那一块（一次只开一块） */
async function openDeep(page: Page, key: string): Promise<void> {
  await page.click(`[data-testid="deep-head-${key}"]`)
  await page.waitForSelector(`[data-testid="report-${key}"] .cap2`, { timeout: 8000 })
  /**
   * ★ B9（2026-09-08）· 折叠现在有 **180ms 对称**的展开 / 收起动画（DS §五：
   *   进出同曲线同时长，对称让人相信这件事可逆）。于是点开第二块的**那一瞬间**，
   *   第一块还在做退出动画 —— DOM 里当然还在。
   *   判据是「前一块**收起了**」，不是「立刻从 DOM 消失」。
   * ★ 不睡一个固定的数：机器忙的时候动画会拖过那个数，红的就成了「机器慢」而不是产品坏。
   *   直接等到**只剩一块**为止 —— 这正是「一次一块」本身。
   */
  await page.waitForFunction(() => document.querySelectorAll('.foldbody').length === 1, undefined, {
    timeout: 4000
  })
}

describe('★★ D-467 · 三层：核心结论 → 详细数据 → 深入', () => {
  it('★★ ① 核心结论默认展开，三句话都不是空的，也不是纯数字', async () => {
    const box = page.locator('[data-testid="report-core"]')
    await box.waitFor()
    for (const id of ['core-did', 'core-stuck', 'core-next']) {
      const t = (await page.locator(`[data-testid="${id}"]`).innerText()).trim()
      assert.ok(t.length > 0, `核心结论少了「${id}」`)
      /**
       * ★ 「不是纯数字」这一条不是挑剔：这一层的全部意思是**说出结论**。
       *   退化成一排数字就等于把「高价值」那一层又抄了一遍。
       */
      assert.ok(/[一-龥]/.test(t), `「${id}」里一个汉字都没有，只有数：${t}`)
    }
    // 「做了多少」要带上真的次数与正确率（来自 trend，不是新算的）
    assert.match(await page.innerText('[data-testid="core-did"]'), /练习 \d+ 次/)
    assert.match(await page.innerText('[data-testid="core-did"]'), /正确率/)
  })

  it('★★ ② 第二层默认展开，标题是「详细数据」（使用者 2026-09-08 定）', async () => {
    const heads = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.view .sec')).map((e) => e.textContent.trim())
    )
    assert.ok(
      heads.some((h) => h.startsWith('详细数据')),
      `★ 第二层的标题不是「详细数据」：${JSON.stringify(heads)}`
    )
    assert.ok(!heads.some((h) => h.includes('值得一看')), '★ 旧名字「值得一看」还在屏幕上')
    for (const id of ['report-weak', 'report-accuracy', 'report-hard']) {
      assert.equal(await page.locator(`[data-testid="${id}"]`).count(), 1, `第二层少了 ${id}`)
      // 展开 = 内容真的画出来了（.cap2 只在块体里）
      assert.equal(
        await page.locator(`[data-testid="${id}"] .cap2`).count(),
        1,
        `★ ${id} 是收着的 —— 第二层必须默认展开`
      )
    }
    const acc = await page.locator('[data-testid="report-accuracy"]').innerText()
    assert.match(acc, /第一次判定/)
    assert.match(acc, /\d+%/)
    const hard = await page.locator('[data-testid="report-hard"]').innerText()
    assert.match(hard, /净[减增]/)
    assert.match(hard, /当前滞留/)
  })

  it('★★★ ③ 第三层六块**默认全部收起** —— 这一条就是 D-467 的全部要点', async () => {
    for (const key of ['flow', 'performance', 'activity', 'lookups', 'changes', 'why']) {
      assert.equal(
        await page.locator(`[data-testid="deep-head-${key}"]`).count(),
        1,
        `第三层少了「${key}」那一块的折叠头`
      )
      assert.equal(
        await page.locator(`[data-testid="report-${key}"] .cap2`).count(),
        0,
        `★★ 「${key}」一打开就摊着 —— 使用者要的是「必要时再深入」`
      )
    }
    // 收起时也不许偷偷把图画出来
    assert.equal(await page.locator('[data-testid="report-flow"] svg path').count(), 0)
  })

  it('★★ ③ 续 · 点开一块看得见内容，再点开另一块，前一块自己收起（一次一块）', async () => {
    await openDeep(page, 'flow')
    assert.equal(
      await page.locator('[data-testid="report-flow"] svg path').count(),
      4,
      '知识流向点开了却没有四条带（四态）'
    )
    const legend = await page.locator('[data-testid="report-flow"] .rlg').innerText()
    /** ★ 终点那一档的名字从 core 来（D-489 之后是「静默」）*/
    for (const s0 of ['新增未练', '训练中', '攻坚区', SILENCE_FILTER_NAME]) {
      assert.ok(legend.includes(s0), `图例缺了「${s0}」`)
    }

    await openDeep(page, 'why')
    /**
     * ★ 红的时候要说得出**是什么状态**，不是只丢一个 `1 !== 0`。
     *   折叠有 180ms 的收起动画（B9），所以这里可能红在三件不同的事上：
     *   前一块真没收起 · 收起还没做完 · 后一块压根没开。把三件事一次报出来。
     */
    const deep = await page.evaluate(() => ({
      folds: document.querySelectorAll('.foldbody').length,
      flowCap: document.querySelectorAll('[data-testid="report-flow"] .cap2').length,
      whyCap: document.querySelectorAll('[data-testid="report-why"] .cap2').length,
      openHeads: [...document.querySelectorAll('.fold-car.open')].map(
        (e) => e.closest('[data-testid]')?.getAttribute('data-testid') ?? '?'
      )
    }))
    assert.equal(
      deep.flowCap,
      0,
      `★ 开第二块时第一块没收起 —— 又变成「一打开就一大片」。实际：${JSON.stringify(deep)}`
    )
    // 再点一次自己收起 —— 同样等它**收完**（B9 的 180ms），不是点完立刻看
    await page.click('[data-testid="deep-head-why"]')
    await page.waitForFunction(() => document.querySelectorAll('.foldbody').length === 0, undefined, {
      timeout: 4000
    })
    assert.equal(await page.locator('[data-testid="report-why"] .cap2').count(), 0)
  })

  it('★★ 删掉的三块一个都不许剩：lecture 轮转 · 练习密度 · 报告页的「两条线」', async () => {
    for (const gone of ['report-beats', 'report-density', 'report-lines']) {
      assert.equal(await page.locator(`[data-testid="${gone}"]`).count(), 0, `${gone} 还在页面上`)
    }
    const body = await page.locator('.view').innerText()
    for (const word of ['lecture 轮转', '练习密度', '学习证据']) {
      assert.ok(!body.includes(word), `页面上还写着「${word}」`)
    }
  })

  it('★ 「我的水平」整块没了（D-467）', async () => {
    for (const gone of ['mylevel', 'level-current', 'level-none', 'run-assess', 'fact-exams']) {
      assert.equal(await page.locator(`[data-testid="${gone}"]`).count(), 0, `${gone} 还在报告页上`)
    }
  })

  it('换时间范围，数据跟着变（本周 / 本月 / 半年）', async () => {
    const month = await page.locator('[data-testid="report-range"]').innerText()
    await page.click('[data-testid="range-180"]')
    await page.waitForFunction(
      (m) => document.querySelector('[data-testid="report-range"]')?.textContent?.trim() !== m,
      month.trim()
    )
    // 半年的样本一定比一个月多
    const half = await page.locator('[data-testid="report-accuracy"]').innerText()
    assert.match(half, /共 \d+ 次第一判定/)
    await page.click('[data-testid="range-30"]')
    await page.waitForSelector('[data-testid="core-did"]')
  })
})

/**
 * ★★★ D-460（2026-09-03）· 建了还没练的知识点，必须出现在知识流向里
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `state_events` 只在**状态变化**时写（判分 / 静默 / 批量改），
 * **建条目那一刻一条都不写**。而知识流向图是**回放事件**算出来的 ——
 * 于是一条刚析出、还没练过的知识点，`production_state = 'new'`，
 * 却**一条产出事件都没有**，在图上**根本不存在**。
 *
 * ★ 「新增未练」这一档恰恰就是这批人：**该最厚的那条带子是空的。**
 *
 * ★★ 这不是推的，是实测出来的：真软件里 `data.addItem` 建一条 →
 *   `items` 有行、`production_state='new'`、`state_events` **空表**。
 *
 * ★★ V5 迁移一次性补过出生事件，注释白纸黑字写着「否则它们在流向图上
 *   凭空出现」—— **作者知道，但只补了那一次，后续新建的从来没接上。**
 *   ★ 教训同 I-1b：**一次性补数据不等于把路接上。**
 *
 * ── 这条用例怎么验 ──────────────────────────────────────────
 * demo 数据每条都带事件（seeder 自己写的），所以**它验不出这个病** ——
 * 必须**当场新建一条并且不练它**。★ 这又是「喂给它的数据不真，
 * 它就只会告诉你一切都好」（D-458 同一个教训的第二个面）。
 *
 * ★ 负向对照：把 report.ts 里 `births` 那段去掉 → ② 当场红。
 */
/**
 * 图例长这样（.rlg 的 innerText，每档一行）：
 *
 *   新增未练 71
 *   训练中 21
 *   ...
 *
 * ★ 不用正则：这个仓库里带反斜杠的查找串反复被 shell / 模板串吃掉一层
 *   （`\s` 变成 `s`，而 `s*` 恰好也能匹配，于是**静默匹配错**）。
 *   规矩已经写进 CLAUDE.md：**凡带反斜杠的一律绕开写。**
 */
function legendOf(text: string, label: string): number {
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith(label)) continue
    return Number(s.slice(label.length).trim())
  }
  return -1
}

describe('★★★ D-460 · 建了没练的条目也要进知识流向', () => {
  let before = 0

  it('① 先记下现在「新增未练」是多少', async () => {
    // ★ D-467 · 知识流向进了第三层、默认收着 —— 先点开它再读图例
    await openDeep(page, 'flow')
    const t = await page.locator('[data-testid="report-flow"] .rlg').innerText()
    before = legendOf(t, '新增未练')
    assert.ok(before >= 0, `读不出「新增未练」那个数：${t}`)
  })

  it('★★★ ② 新建一条、不练它 —— 那个数必须 +1', async () => {
    const added = await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('D-460 探针')
      const u = await window.nyx.data.createUnit(p, '探针单元')
      const l = await window.nyx.data.createLecture(u, '探针讲次')
      await window.nyx.data.addItem(l, 'a probe phrase for d460', 'a test gloss', 'B')
      return true
    })
    assert.ok(added)

    // 重新取一次报告（换范围再换回来，逼它重算）
    await page.click('[data-testid="range-7"]')
    await page.waitForTimeout(500)
    await page.click('[data-testid="range-30"]')
    await page.waitForTimeout(900)

    // 换范围不会把展开状态收掉，但它是组件状态 —— 不假设，点开确认
    if ((await page.locator('[data-testid="report-flow"] .rlg').count()) === 0) {
      await openDeep(page, 'flow')
    }
    const t = await page.locator('[data-testid="report-flow"] .rlg').innerText()
    const after = legendOf(t, '新增未练')
    assert.equal(
      after,
      before + 1,
      `★★ 建了一条没练的知识点，「新增未练」从 ${before} 变成 ${after} ——` +
        ' 它在知识流向图上不存在（回放事件算的，而建条目不写事件）'
    )
  })
})


/**
 * ★★ T-4.11 · 分析报告独立页（D-R29 · 使用者 2026-09-07 原话）
 *
 * 这一段验三件事，每一件都对着一种「看起来做了、其实没做」：
 *   ① **够得着** —— 有路由、有侧边栏入口、有页标题（「独立、明确」首先意味着够得着）
 *   ② **每一块都说得出数据源** —— 新块的头注里写着它读的是哪张事件表
 *   ③ **每句「为什么」点得开** —— 点开看到的是具体哪几行事件，不是一句听起来像结论的话
 *
 * ★ 负向对照打在①：把 `{:else if nav.k === 'report'}` 那一支拆掉 → 「进得去」当场红。
 *
 * ★ 2026-09-09（使用者裁：「删，分析报告入口只在首页显示」）——
 *   侧栏那一行撤了，入口只剩 Today 底下那条横条。**这条用例守的东西一个字没变**
 *   （「报告有独立、明确的界面，而且够得着」），改的只是「从哪儿进」；
 *   另外多守一件事：**侧栏不许再长出这个入口**（U-002）。
 */
describe('★★ T-4.11 · 分析报告有独立、明确的界面', () => {
  it('① 首页那条横条进得去，点进去就是报告页（有标题、有第一层）', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="home-report"]')
    // 首页上不该再内嵌整份报告 —— 它现在是一个入口
    assert.equal(
      await page.locator('[data-testid="report-core"]').count(),
      0,
      '★ 首页还在就地展开报告 —— 那正是 D-R29 要改掉的样子'
    )

    await page.click('[data-testid="home-report"]')
    await page.waitForSelector('[data-testid="report-title"]', { timeout: 15000 })
    assert.equal(await page.locator('[data-testid="report-title"]').innerText(), '分析报告')
    await page.waitForSelector('[data-testid="core-did"]', { timeout: 15000 })
    // ★ U-002 · 侧栏不许再有这个入口（使用者 2026-09-09：「入口只在首页显示」）
    assert.equal(
      await page.locator('[data-testid="nav-report"]').count(),
      0,
      '★ 侧边栏又长出了「分析报告」那一行'
    )
    // ★ NAV-04 · 横条是压栈进来的 —— 进得去还要走得回来（撤掉侧栏那一行之后这是唯一的路）
    assert.equal(
      await page.locator('[data-testid="global-back"]').count(),
      1,
      '★★ 报告页上没有返回入口 —— 现在它只有首页横条一个入口，回不去就是死路'
    )
  })

  it('② 三层各自的块都在，各有自己的 testid（D-467 收窄之后的名单）', async () => {
    await page.waitForSelector('[data-testid="report-why"]', { timeout: 15000 })
    for (const id of [
      'sec-core', 'report-core',
      'sec-high', 'report-weak', 'report-accuracy', 'report-hard',
      'sec-deep', 'report-flow', 'report-performance', 'report-activity',
      'report-lookups', 'report-changes', 'report-why'
    ]) {
      assert.equal(await page.locator(`[data-testid="${id}"]`).count(), 1, `少了 ${id}`)
    }
  })

  it('★ ③ 每个新块的头注都写着数据源（不凭空造指标）', async () => {
    // ★ D-467 · 第三层收着的时候读不到头注 —— 一块一块点开来读
    const want: [string, string][] = [
      ['report-activity', 'answers'],
      ['report-performance', 'is_first'],
      ['report-weak', 'review_logs'],
      ['report-lookups', 'ops_log'],
      ['report-changes', 'state_events'],
      ['report-why', 'thresholds']
    ]
    for (const [id, table] of want) {
      const key = id.replace('report-', '')
      if ((await page.locator(`[data-testid="deep-head-${key}"]`).count()) > 0) {
        await openDeep(page, key)
      }
      /**
       * ★★ 2026-09-15（文案审查 L-07）：这一行**默认折起来了** —— 使用者点了采纳。
       *   判据跟着改形态，不是放宽：
       *     ① 那块小字是一个**折叠**（`details.src`），明面上写着「数据源」；
       *     ② ★ **点开之后**读得到是哪张表 —— 折起来不等于可以不说。
       *   原来那条「头一条小字必须以『数据源』开头」现在由 `summary` 接着扛：
       *   把「数据源」三个字换成「说明」，① 当场红。
       */
      const fold = page.locator(`[data-testid="${id}"] details.src`).first()
      assert.equal(await fold.count(), 1, `★ ${id} 的数据源那一块不是折叠（L-07 要求默认收起）`)
      assert.equal(
        (await fold.locator('summary').innerText()).trim(),
        '数据源',
        `★ ${id} 的折叠标题不是「数据源」—— 收起来之后他只看得见这三个字`
      )
      await fold.locator('summary').click()
      const src = await fold.innerText()
      assert.ok(src.includes(table), `★ ${id} 点开之后仍没说清数据源（应含 ${table}）：${src}`)
    }
  })

  it('④ 活动块画的是真数据：作答数与两条线分开的说法都在', async () => {
    await openDeep(page, 'activity')
    const block = page.locator('[data-testid="report-activity"]')
    assert.match(await block.innerText(), /作答 \d+/)
    assert.match(await block.innerText(), /认读判分 \d+/)
    /**
     * ★ 「production 那一半不再数一遍」这句话住在**数据源**那一块里，
     *   而它 2026-09-15 起默认折起来（L-07）。折起来 ≠ 可以不说 —— 点开再读。
     */
    await block.locator('details.src > summary').click()
    const t = await block.innerText()
    assert.ok(t.includes('line=') && t.includes('production'), '没写清 production 那一半不再数一遍')
    assert.equal(await page.locator('[data-testid="report-hours"] i').count(), 24, '按小时该是 24 格')
  })

  it('⑤ 没有查词记录时如实说「没有」，不编一个数出来', async () => {
    // demo 数据不写 ops_log —— 这正好验「算不出来的宁可不显示」
    await openDeep(page, 'lookups')
    const t = await page.locator('[data-testid="report-lookups"]').innerText()
    assert.match(t, /查过的词/)
    assert.ok(t.includes('没有查词记录') || /查过的词（\d+ 次）/.test(t))
  })

  it('★★ ⑥ 「为什么」每句都带阈值与出处，而且点得开看到具体哪几行', async () => {
    await openDeep(page, 'why')
    const box = page.locator('[data-testid="report-why"]')
    const items = box.locator('.whyi')
    const n = await items.count()
    assert.ok(n > 0, '一句「为什么」都没出 —— demo 数据里明明有反复挂与连续过关的条目')

    for (let i = 0; i < n; i++) {
      const meta = await items.nth(i).locator('.mt').innerText()
      assert.ok(meta.includes('阈值') && meta.includes('出处'), `第 ${i + 1} 句没写阈值 / 出处：${meta}`)
    }

    const first = items.first()
    const rule = (await first.getAttribute('data-testid'))!.replace('why-', '')
    await page.click(`[data-testid="why-open-${rule}"]`)
    const refs = await page.locator(`[data-testid="why-refs-${rule}"]`).innerText()
    const tables = ['review_logs', 'answers', 'questions', 'sessions', 'state_events', 'item_events', 'lecture_logs', 'ops_log']
    assert.ok(
      tables.some((t) => refs.includes(t)),
      `★★ 点开之后看不到任何一行事件（指不回出处的结论 = 没有出处的结论）：${refs}`
    )
    assert.match(refs, /#\d+/, '事件行没带行号，对不上库里那一行')
  })

  it('⑦ 换范围，证据层跟着重算（不是拿旧数据画）', async () => {
    await openDeep(page, 'activity')
    const before = await page.locator('[data-testid="report-trend"]').innerText()
    await page.click('[data-testid="range-7"]')
    await page.waitForFunction(
      (b) => document.querySelector('[data-testid="report-trend"]')?.textContent?.trim() !== b,
      before.trim(),
      { timeout: 15000 }
    )
    await page.click('[data-testid="range-30"]')
    await page.waitForSelector('[data-testid="core-did"]')
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
