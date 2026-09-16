/**
 * 首次引导五步分镜各拍一张 —— **一次起 Electron**，交给使用者看长相（G-2 · D-484）。
 *
 * ★ 每趟先清自己那个截图库：第一层只在**没看过**的库上出现一次，
 *   不清的话第二趟就什么都拍不到，而错会报成「引导坏了」。
 * ★★ 必须**先等启动页 detach**：它盖着整屏，而 `onboarding` 那一刻已经在 DOM 里 ——
 *   只等 `onboarding` 的话，五张拍出来全是启动页那张插画（第一版就是，真拍出来才发现）。
 * ★ 每一步都核 `n / 5` 对不对再拍：停错步拍出来的是一张「看着没问题」的图。
 *
 * 用法：node scripts/shot-onboarding.mjs　出图在 shots/onb-1..5.png
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'
const cwd = process.cwd()
const root = join(cwd, '.shots-onb')
rmSync(root, { recursive: true, force: true })
mkdirSync('shots', { recursive: true })
const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NYX_DATA_ROOT: root, NYX_NO_SYNC_TIMERS: '1' } })
const page = await mainWindow(app, 30000, { keepOnboarding: true })
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForLoadState('domcontentloaded')
// ★ 先等启动页走掉：它盖着整屏，`onboarding` 在 DOM 里但拍出来是启动页那张插画
await page.locator('[data-testid="splash"]').waitFor({ state: 'detached', timeout: 20000 })
await page.locator('[data-testid="onboarding"]').waitFor({ timeout: 20000 })
for (let n = 1; n <= 5; n++) {
  await page.waitForTimeout(500)
  const at = (await page.locator('[data-testid="onboarding-step"]').innerText()).trim()
  if (at !== `${n} / 5`) throw new Error(`第 ${n} 步没停在该停的地方：屏上是「${at}」`)
  await page.screenshot({ path: join('shots', `onb-${n}.png`) })
  console.log(`出图：shots/onb-${n}.png  （${at}）`)
  if (n < 5) await page.click('[data-testid="onboarding-next"]')
}
await app.close()
