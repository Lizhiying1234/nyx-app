/**
 * 补拍两张走查脚本够不着的引导 · I-190
 *
 *   `lookup-save`     查词卡上那一行 —— 要真把卡打开（右键一个词 →「查词典」）
 *   `practice-settle` 结算屏那四档   —— 要真答一道题（要 AI），**这一张仍然拍不到**
 *
 * ★ 这里只拍第一张。查词卡**不需要装词典也打得开**：
 *   我要拍的那一行（`dict-nyx`「Nyx 里有没有它」＋「收下」）读的是**自己的库**，
 *   不是词典；词典那一档空着不影响这一行。—— 这是量出来的，不是推的。
 * ★ `practice-settle` 要起一个假 AI 跑完一整轮产出题（`study.test.ts` 那套夹具），
 *   单为一张图起那一套不值；等下一次跑 `smoke:study` 时顺手拍。写在这儿免得当成漏了。
 *
 * 用法：node scripts/shot-guide-dict.mjs　出图 shots/walk-lookup-save.png
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'
import { GUIDE_SEEN_KEY, ONBOARDING_KEY, PAGE_GUIDES } from '../src/core/onboarding.ts'

mkdirSync('shots', { recursive: true })
const root = join(process.cwd(), '.shots-dict')
rmSync(root, { recursive: true, force: true })

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, NYX_DATA_ROOT: root, NYX_NO_SYNC_TIMERS: '1' }
})
const page = await mainWindow(app)
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

/** 他的状态：第一层看完 · 库非空 · **只留 lookup-save 没看过**（别的都别来抢） */
const lecId = await page.evaluate(async () => {
  const p = await window.nyx.data.createProject('他的项目')
  const u = await window.nyx.data.createUnit(p, '第一单元')
  const l = await window.nyx.data.createLecture(u, 'Demo Lecture')
  await window.nyx.data.addItem(l, 'bear the brunt', '承受最重的那一下', 'B', 'She bore the brunt.')
  await window.nyx.data.addItem(l, 'hold sway', '占主导、说了算', 'B', 'That view still holds sway.')
  return l
})
await page.evaluate(
  async ([ob, gs, json]) => {
    await window.nyx.ui.set(String(ob), String(Date.now()))
    await window.nyx.ui.set(String(gs), String(json))
  },
  [
    ONBOARDING_KEY,
    GUIDE_SEEN_KEY,
    JSON.stringify(
      Object.fromEntries(
        PAGE_GUIDES.filter((g) => g.id !== 'lookup-save').map((g) => [g.id, g.version])
      )
    )
  ]
)
await page.reload()
await page.waitForTimeout(1600)

/** 走他自己的路进那一讲：展开项目 → 展开单元 → 点讲次 */
const openIfClosed = async (rowSel, childSel) => {
  const child = page.locator(childSel).first()
  if (await child.isVisible().catch(() => false)) return
  await page.locator(rowSel).first().click()
  await child.waitFor({ state: 'visible', timeout: 8000 })
}
await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
await openIfClosed('[data-testid^="nav-toggle-unit-"]', `[data-testid="nav-lecture-${lecId}"]`)
await page.click(`[data-testid="nav-lecture-${lecId}"]`)
await page.click('[data-testid="tab-active"]')
await page.waitForSelector('[data-testid="item-rows"]')

/**
 * 选中知识点行里的那个词并右键 —— 和他自己的操作一模一样。
 * ★ 右键菜单只在**可捞的地方**给「查词典」（`Capture.svelte::classify`：`.lrow` 那一档）。
 */
const box = await page.evaluate((w) => {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walk.nextNode())) {
    const at = (node.textContent ?? '').indexOf(w)
    if (at < 0) continue
    const el = node.parentElement
    if (!el || !el.offsetParent || !el.closest('.lrow')) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + w.length)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    const r = range.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }
  return null
}, 'brunt')
if (!box) throw new Error('★ 页面上找不到「brunt」—— 知识点行没渲染出来？')

await page.mouse.click(box.x, box.y, { button: 'right' })
await page.waitForSelector('[data-testid="ctx-dict"]', { timeout: 15000 })
await page.click('[data-testid="ctx-dict"]')
await page.waitForSelector('[data-testid="dict-card"]', { timeout: 30000 })
await page.waitForTimeout(2500)

const up = await page.locator('.gd-box').count()
if (up === 0) throw new Error('★ 查词卡开了，但 lookup-save 那个框没出来 —— 拍了也是张空图')
await page.screenshot({ path: join('shots', 'walk-lookup-save.png') })
console.log('出图：shots/walk-lookup-save.png')

await app.close()
