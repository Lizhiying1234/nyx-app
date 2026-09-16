import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 讲次页「一键去重」· T-4.8（判据与落库在 T-2.11）
 *
 * ══ 这一套验的是什么 ═════════════════════════════════════════
 *
 * 只验**他在屏幕上看得见的东西**（第 ③ 档）：
 *   造 3 组重复（1 组可安全合并 · 2 组需要他看）→ 按钮点得开 → 数字对得上
 *   → 点「合并那 1 组」→ 讲次里少 1 条 · 回收站里多 1 条
 *   → **需要他看的那 2 组一根手指都没被碰过**
 *
 * ★★ 最后那一条是这套用例存在的主要理由。跨层 / 释义打架的合并**不可逆**
 *   （软删可以恢复，但他根本不知道发生过），所以「不自动处理 Review」这条
 *   必须有一条会红的用例守着。策略本身在主进程（`db/merge.ts`），
 *   不在界面 —— 界面上的判断挡不住别的调用点。
 *
 * ★ 负向对照（实测）：把 `db/merge.ts` 里 `if (g.bucket !== 'safe') continue` 那一行拿掉
 *   → 用例 ③④⑤ 当场红（`pass 4 · fail 3`）：③ 讲次一次少掉 3 条，
 *   ④⑤ 连一个「需要你看」的组都找不到了 —— 三组全被自动并掉，而他一眼都没看过。
 *
 * ★ 有意**没有**验「canonical 多一条出处」：出处的确定性身份是
 *   (知识点, 材料) 或 (知识点, 讲)（`core/identity.ts`）。同一讲里手工添加的两条
 *   各自都只有一条讲次出处，canonical 已经有了，再插一条会撞 uid 唯一索引 ——
 *   所以那条路在**单讲、手工数据**上根本走不到。它在 `test:db` 里验：
 *   那条用例用 SQL 给被并那条造了一条**第二讲**的出处，走的正是「新建」那一支。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-dedup-'))

let app: ElectronApplication
let page: Page
let lecId = 0
const consoleErrors: string[] = []

before(async () => {
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
  page.on('pageerror', (e) => consoleErrors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)

  /**
   * 三组重复，走的是他自己那条路（D-064 逐条手动输入），不是直插数据库：
   *   ① 可安全合并 —— 同层、一条有释义一条没有
   *   ② 需要他看   —— 同一个词，一条在理解层一条在写作层
   *   ③ 需要他看   —— 同层，但两条都写了释义而且不一样
   * 讲次名给足长度（真数据，不是 'L'）。
   */
  lecId = await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('去重验收 · 2026 秋')
    const u = await window.nyx.data.createUnit(p, '第一单元 · 长句与固定搭配')
    const l = await window.nyx.data.createLecture(u, '第 3 讲 · 天气与处境的隐喻')
    const add = (term: string, gloss: string, layer: 'A' | 'B', quote: string): Promise<unknown> =>
      window.nyx.data.addItem(l, term, gloss, layer, quote)

    await add('weather the storm', '挺过难关', 'A', 'The crew had to weather the storm alone.')
    await add('Weather the Storm.', '', 'A', 'They weather the storm every winter.')

    await add('call it a day', '收工', 'A', 'We should call it a day.')
    await add('call it a day', '收工', 'B', 'Let us call it a day and go home.')

    await add('hold water', '站得住脚', 'B', 'That excuse does not hold water.')
    await add('hold water', '有道理', 'B', 'His theory barely holds water.')
    return l
  })
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

async function openLecture(): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  const row = page.locator(`[data-testid="nav-lecture-${lecId}"]`)
  for (let i = 0; i < 8 && !(await row.isVisible().catch(() => false)); i++) {
    const unit = page.locator('[data-testid^="nav-toggle-unit-"]').first()
    const proj = page.locator('[data-testid^="nav-toggle-project-"]').first()
    if (await unit.isVisible().catch(() => false)) await unit.click()
    else if (await proj.isVisible().catch(() => false)) await proj.click()
    await page.waitForTimeout(300)
  }
  await page.click(`[data-testid="nav-lecture-${lecId}"]`)
  await page.waitForSelector('[data-testid="dedup-open"]', { timeout: 8000 })
}

/** 这一讲现在有几条活着的知识点 —— 直接问主进程，不数 DOM（Tab 会挡住一部分） */
const liveItems = (): Promise<number> =>
  page.evaluate(async (id) => (await window.nyx.data.lecture(id)).items.length, lecId)

describe('T-4.8 · 讲次页一键去重', () => {
  it('① 讲次页上有「查重」这个入口，点开是一个对话框', async () => {
    await openLecture()
    await page.click('[data-testid="dedup-open"]')
    await page.waitForSelector('[data-testid="dedup-dialog"]')
    assert.ok(
      await page.locator('[data-testid="dedup-summary"]').isVisible(),
      '★ 打开了却没有汇总行 —— 他不知道扫出了什么'
    )
  })

  it('② 汇总说的是人话：3 组 · 6 条受影响 · 1 组可安全合并 · 2 组需要你看', async () => {
    const text = (await page.innerText('[data-testid="dedup-summary"]')).replace(/\s+/g, ' ')
    assert.ok(text.includes('3 组'), `扫出来的组数不对：${text}`)
    assert.ok(text.includes('6 条受影响'), `受影响条数不对：${text}`)
    assert.ok(text.includes('1 组可安全合并'), `可安全合并的组数不对：${text}`)
    assert.ok(text.includes('2 组需要你看'), `需要他看的组数不对：${text}`)
  })

  it('③ 点「合并那 1 组」→ 讲次少 1 条，回收站多 1 条', async () => {
    const before = await liveItems()
    assert.equal(before, 6, '前提：造了 6 条')
    const trashBefore = await page.evaluate(async () => {
      const b = await window.nyx.browse.trash()
      return b.reduce((n, x) => n + x.rows.length, 0)
    })

    await page.click('[data-testid="dedup-merge-safe"]')
    await page.waitForSelector('[data-testid="dedup-done"]', { timeout: 8000 })

    assert.equal(await liveItems(), before - 1, '★ 讲次里没有少掉那一条')
    const trashAfter = await page.evaluate(async () => {
      const b = await window.nyx.browse.trash()
      return b.reduce((n, x) => n + x.rows.length, 0)
    })
    assert.equal(
      trashAfter,
      trashBefore + 1,
      '★★ 被并那条没进回收站 —— 合并必须是软删（D-435 第二档，30 天可反悔），不是硬删'
    )
  })

  it('④ ★★ 需要他看的那 2 组一条都没被动过', async () => {
    const text = (await page.innerText('[data-testid="dedup-summary"]')).replace(/\s+/g, ' ')
    assert.ok(
      text.includes('2 组') && text.includes('0 组可安全合并'),
      `★★ 合并之后剩下的应该正好是那 2 组需要他看的：${text}`
    )
    assert.equal(
      await page.locator('[data-testid="dedup-group-review"]').count(),
      2,
      '★★ 需要他看的组不见了 —— 说明被自动处理掉了，而他没看见'
    )
    assert.ok(
      await page.locator('[data-testid="dedup-merge-safe"]').isDisabled(),
      '没有可安全合并的组时，那个按钮该是灰的'
    )
  })

  it('⑤ Review 组给得出差异与理由，他能挑主记录', async () => {
    const why = await page.locator('[data-testid="dedup-group-review"]').first().innerText()
    assert.ok(
      why.includes('层不同') || why.includes('释义'),
      `★ 只说「需要你看」不说为什么，他没法判断：${why}`
    )
    const picks = await page.locator('[data-testid^="dedup-pick-"]').count()
    assert.ok(picks >= 4, `每组每条都该有「以这条为主」，实际只有 ${picks} 个`)
  })

  it('⑥ 没有重复的讲次说「没有重复」，不是一张空表', async () => {
    // ★ 先把对话框关掉：它的遮罩盖住整个窗口，不关就点不到侧边栏
    //   （第一版就漏了这一步，playwright 报的是「ddscrim intercepts pointer events」）
    await page.click('[data-testid="dedup-close"]')
    await page.waitForSelector('[data-testid="dedup-dialog"]', { state: 'detached' })

    const empty = await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('干净的项目')
      const u = await window.nyx.data.createUnit(p, '干净的单元')
      const l = await window.nyx.data.createLecture(u, '第 1 讲 · 没有任何重复')
      await window.nyx.data.addItem(l, 'a far cry from', '相差甚远', 'A', 'It is a far cry from home.')
      return l
    })
    lecId = empty
    await openLecture()
    await page.click('[data-testid="dedup-open"]')
    await page.waitForSelector('[data-testid="dedup-empty"]')
    assert.equal(await page.locator('[data-testid="dedup-summary"]').count(), 0)
  })

  it('⑦ 整个过程里没有控制台错误', () => {
    assert.deepEqual(consoleErrors, [], `控制台有错：${consoleErrors.join(' | ')}`)
  })
})
