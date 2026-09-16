import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * ★★ F-2-②-a · 他真的能立刻练到刚加进去的那一条
 *
 * 数据层那十一条证明了「触发器发了卡」。这一条证明的是另一件事：
 * **他在界面上加完，不重启，认读练习里就能看见它。**
 * 中间隔着 preload、IPC、`dueCards` 那个查询、以及首页那个数字。
 *
 * 病的原形是静默失效：那几条好好地列在讲次页上，就是永远轮不到 ——
 * 而他零编程经验，发现时早就过去很久了。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TERM = 'brand new expression'

let app: ElectronApplication
let page: Page
let dataRoot = ''

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'nyx-f2a-'))
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...(process.env as Record<string, string>), NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')
})

after(async () => {
  await app?.close()
  if (dataRoot) keepOrClean(dataRoot)
})

const db = (): DatabaseSync => new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))

describe('★★ F-2-②-a · 轮转中的讲加新表达 → 立刻能认读', () => {
  let lecId = 0

  it('造一条已经在轮转的讲（走真入口：贴材料 → 审阅 → 开始学）', async () => {
    lecId = await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('F-2-a')
      const u = await window.nyx.data.createUnit(p, '单元')
      const l = await window.nyx.data.createLecture(u, '一讲')
      await window.nyx.data.addChunks(l, '我的收集', 'hold sway over')
      return l
    })
    // 走真业务入口进轮转
    await page.evaluate(async (id) => {
      await window.nyx.study.startLearning(id as number)
    }, lecId)

    const d = db()
    const row = d
      .prepare(`select status, due_at as due, interval_days as iv from lectures where id = ?`)
      .get(lecId) as { status: string; due: number; iv: number }
    d.close()
    assert.equal(row.status, 'training', '前提没成立：这一讲该在轮转中')
    assert.ok(row.due !== null, '前提：该有排期')
  })

  it('★★ 在这一讲里加一条新表达 → 不重启，认读队列里立刻有它', async () => {
    const before = ((): { due: number; iv: number; cards: number } => {
      const d = db()
      const l = d
        .prepare(`select due_at as due, interval_days as iv from lectures where id = ?`)
        .get(lecId) as { due: number; iv: number }
      const c = d
        /** ★ D-296（V34）· 认读到期日在 `reading_cards`；读 items 那份冻结列会是假绿 */
        .prepare(`select count(*) as n from reading_cards where due_at is not null`)
        .get() as { n: number }
      d.close()
      return { due: l.due, iv: l.iv, cards: c.n }
    })()

    /**
     * ★ 真的走界面那条路：讲次页 →「＋ 我的表达」→ 贴一条 → 提交。
     *
     * 不用 IPC 抄近道 —— 抄了的话首页那个数字不会刷新（`onchanged` 没触发），
     * 而「他加完之后看不看得见」正是这条用例要验的东西。
     */
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(300)
    for (let i = 0; i < 5; i++) {
      const lec = page.locator(`[data-testid="nav-lecture-${lecId}"]`)
      if (await lec.isVisible().catch(() => false)) {
        await lec.click()
        break
      }
      const unit = page.locator('[data-testid^="nav-toggle-unit-"]').first()
      const proj = page.locator('[data-testid^="nav-toggle-project-"]').first()
      if (await unit.isVisible().catch(() => false)) await unit.click()
      else await proj.click()
      await page.waitForTimeout(300)
    }
    await page.waitForSelector('[data-testid="add-chunk"]')
    await page.click('[data-testid="add-chunk"]')
    await page.fill('[data-testid="compose-title"]', '又贴一段')
    await page.fill('[data-testid="compose-text"]', TERM)
    await page.click('[data-testid="compose-submit"]')
    await page.waitForSelector('[data-testid="chunk-receipt"]', { timeout: 8000 })

    /**
     * ★ 判据是**他点得到的那个队列**，不是库里那一列。
     * `dueCards` 是认读练习真正取题的地方 —— 它拿不到，界面上就没有。
     */
    const inQueue = await page.evaluate(
      async (term) => {
        const cards = await window.nyx.study.dueCards(null, 999)
        return cards.some((c) => c.term === (term as string))
      },
      TERM
    )
    assert.ok(
      inQueue,
      '★★ 刚加的那条进不了认读队列 —— 它会好好地列在讲次页上，但永远轮不到'
    )

    // 首页那个数字也要跟着涨（他看得见的地方）
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(400)
    const label = await page.innerText('[data-testid="start-reading"]')
    // T-4.13 · 这颗按钮现在写的是「认读练习 · 推荐 N」——「推荐」两个字是 D-R28 要的，数字照旧要跟上
    assert.match(label, /推荐\s*[1-9]/, `★ 首页认读练习那个数字没跟上：${label}`)

    // 这一讲的排期和间隔一个字都不许动
    const after = ((): { due: number; iv: number } => {
      const d = db()
      const l = d
        .prepare(`select due_at as due, interval_days as iv from lectures where id = ?`)
        .get(lecId) as { due: number; iv: number }
      d.close()
      return l
    })()
    assert.equal(after.due, before.due, '★★ 加一条新表达改了这一讲的排期')
    assert.equal(after.iv, before.iv, '★★ 加一条新表达改了这一讲的间隔')
  })

  it('★ 真的能练：翻开那张卡，评一次分', async () => {
    await page.click('[data-testid="start-reading"]')
    await page.waitForTimeout(600)
    const body = await page.innerText('body')
    assert.ok(
      !/认读练习出问题了/.test(body),
      `★ 认读练习报错了：${body.replace(/\s+/g, ' ').slice(0, 200)}`
    )
  })

  /**
   * ★ I-125 / T-4.1 · 浮层卡片的标题行不是一个 250px 灰块
   *
   * `global.css` 里有两条 `.side`：基础那条是**左侧栏本体**（250px 定宽 + 灰底 +
   * 右边框 + flex 列 + 内边距），`.acard .side` 原来只覆盖字体属性 ——
   * 于是浮层里那行小标题把整个侧栏的盒子继承了下来，看着像个输入框。
   *
   * 这一条量的是**他眼睛看得见的那几件事**，不是 CSS 文本：
   * 宽度不是侧栏那 250（而是铺满卡片内容宽度）· 没有侧栏底色 · 没有右边框 ·
   * 不是 flex 列（是列的话，同一行的「1 / 3」会掉到第二行去）。
   *
   * 负向对照：把 `.acard .side` 补的那几个属性删回去，这一条必须变红。
   */
  it('★ I-125 · 浮层标题是一行小字，不是 250px 灰块', async () => {
    const sel = '[data-testid="reading-overlay"] .acard .side'
    await page.waitForSelector(sel)

    const m = await page.evaluate((s) => {
      const el = document.querySelector(s as string) as HTMLElement
      const card = el.closest('.acard') as HTMLElement
      const cs = getComputedStyle(el)
      const cc = getComputedStyle(card)
      const r = el.getBoundingClientRect()
      // 侧栏那个灰不写死：从令牌解析出来再比，换了令牌这一条也还准
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--sidebar-bg)'
      document.body.appendChild(probe)
      const sidebarBg = getComputedStyle(probe).backgroundColor
      probe.remove()
      const span = el.querySelector('span')
      return {
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        width: Math.round(r.width),
        height: Math.round(r.height),
        cardInner: Math.round(
          card.getBoundingClientRect().width -
            parseFloat(cc.paddingLeft) -
            parseFloat(cc.paddingRight)
        ),
        bg: cs.backgroundColor,
        sidebarBg,
        borderRight: cs.borderRightWidth,
        display: cs.display,
        // span 的顶比标题的顶低一大截 = 被 flex 列挤到了第二行
        spanDrop: span ? Math.round(span.getBoundingClientRect().top - r.top) : 0
      }
    }, sel)

    assert.match(m.text, /正面/, `★ 前提没成立：量到的不是卡片正面那行标题（“${m.text}”）`)
    assert.notEqual(m.width, 250, '★★ I-125 还在：标题行宽度正好是左侧栏那 250px')
    assert.ok(
      Math.abs(m.width - m.cardInner) <= 1,
      `★★ I-125 还在：标题行没铺满卡片内容宽度（量到 ${m.width}px，卡片内宽 ${m.cardInner}px）`
    )
    assert.notEqual(m.bg, m.sidebarBg, `★★ I-125 还在：标题行带着左侧栏的灰底 ${m.bg}`)
    assert.equal(m.borderRight, '0px', `★★ I-125 还在：标题行带着左侧栏的右边框 ${m.borderRight}`)
    assert.notEqual(m.display, 'flex', '★★ I-125 还在：标题行还是 flex 列')
    assert.ok(
      m.spanDrop <= 2,
      `★★ I-125 还在：同一行的「n / N」被挤到了第二行（掉了 ${m.spanDrop}px）`
    )
    assert.ok(m.height <= 20, `★★ 标题行不是一行小字：高 ${m.height}px`)
  })
})
