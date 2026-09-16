/**
 * 悬停 / 按下 / 键盘焦点，三种状态各截一张 —— I-076 的验收手段。
 *
 * 为什么要单独一个脚本：`npm run shot` 拍的是静止画面，而这三种状态**只在交互中存在**。
 * 「按下去有没有反应」这种事，写完 CSS 是看不出来的（我上一轮就只是写了规则），
 * 而常规验收也照不到 —— 它断言的是元素在不在、文字对不对。
 *
 * 用法：node scripts/shot-states.mjs
 * 出图 shots/state-*.png，然后**用眼睛看**：
 *   hover 要有底色变化 · active 要下沉 1px 或底色再深一档 · focus 要有一圈 accent
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'

mkdirSync('shots', { recursive: true })
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-state-'))
const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, NYX_DATA_ROOT: dataRoot }
})
/**
 * ★ 拿主窗走 `tests/win.ts` 那一份判据（B-9，2026-09-14）——
 *   以前这里是 `app.firstWindow()`，它认的是「谁先开」，跟「谁是主窗」无关；
 *   悬浮球开着的库上它拿到的是那颗 46px 的球（I-157 / I-179）。
 */
const page = await mainWindow(app)
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1500)

// 造一条 lecture，好有真按钮可按
await page.evaluate(async () => {
  const p = await window.nyx.data.createProject('状态验收')
  const u = await window.nyx.data.createUnit(p, 'U')
  await window.nyx.data.createLecture(u, 'L1')
})
await page.reload()
await page.waitForTimeout(1500)

/** 只拍按钮附近那一小块 —— 整屏缩下来根本看不出 1px 的下沉 */
const near = (box) => ({
  x: Math.max(0, box.x - 40),
  y: Math.max(0, box.y - 30),
  width: Math.min(520, box.width + 260),
  height: Math.min(160, box.height + 90)
})

async function shoot(sel, name) {
  const el = page.locator(sel).first()
  const box = await el.boundingBox()
  if (!box) {
    console.log(`跳过 ${name}：${sel} 不在屏幕上`)
    return
  }
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const clip = near(box)

  // 常态
  await page.mouse.move(5, 5)
  await page.waitForTimeout(250)
  await page.screenshot({ path: `shots/state-${name}-1-idle.png`, clip })

  // 悬停
  await page.mouse.move(cx, cy)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `shots/state-${name}-2-hover.png`, clip })

  // 按下 —— 关键是**不松手**就拍，松了就回弹，什么都看不到
  await page.mouse.down()
  await page.waitForTimeout(250)
  await page.screenshot({ path: `shots/state-${name}-3-active.png`, clip })
  await page.mouse.up()

  // 键盘焦点（:focus-visible 只认键盘，鼠标点击不该留框）
  await page.mouse.move(5, 5)
  await el.evaluate((e) => e.focus())
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(250)
  await page.screenshot({ path: `shots/state-${name}-4-focus.png`, clip })
  console.log(`出图 state-${name}-{1..4}`)
}

await shoot('[data-testid="home-new"], .btn.pri', 'btn')
await page.click('[data-testid="nav-trash"]')
await page.waitForTimeout(600)
await shoot('[data-testid="nav-settings"]', 'nav')

await app.close()
rmSync(dataRoot, { recursive: true, force: true })
