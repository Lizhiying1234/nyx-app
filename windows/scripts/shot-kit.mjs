/**
 * 样式一览页截图 —— 起一次 Electron，进设置 › 数据，展开「样式一览」，整页截一张。
 * 数据根指到临时目录（新建一个空库），**不碰真库**。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mainWindow } from '../tests/win.ts'

const cwd = process.cwd()
const dataRoot = process.argv[3] ?? join(cwd, '.kitdata')
const out = resolve(process.argv[2] ?? 'shots/kit')
mkdirSync(out, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NYX_DATA_ROOT: dataRoot } })
/**
 * ★ 拿主窗走 `tests/win.ts` 那一份判据（B-9，2026-09-14）——
 *   以前这里是 `app.firstWindow()`，它认的是「谁先开」，跟「谁是主窗」无关；
 *   悬浮球开着的库上它拿到的是那颗 46px 的球（I-157 / I-179）。
 */
const page = await mainWindow(app)
await page.setViewportSize({ width: 1440, height: 1000 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)

const t = (id) => `[data-testid="${id}"]`
await page.click(t('nav-settings'))
await page.waitForTimeout(500)
await page.click(t('set-tab-data'))
await page.waitForTimeout(600)
await page.click(t('kit-toggle'))
await page.waitForTimeout(900)
await page.locator(t('kit-panel')).scrollIntoViewIfNeeded()
await page.waitForTimeout(400)

// 整页太高，元素截图会被滚动容器裁掉 —— 改成把视口拉高再截
await page.setViewportSize({ width: 1440, height: 7600 })
await page.waitForTimeout(700)
await page.locator(t('kit-panel')).screenshot({ path: join(out, 'kit-full.png') })
for (const [name, id] of [
  ['buttons', 'kit-buttons'],
  ['feedback', 'kit-feedback'],
  ['states', 'kit-states'],
  ['surfaces', 'kit-surfaces'],
  ['grades', 'kit-grades'],
  ['bilingual', 'kit-bilingual'],
  ['iconsel', 'kit-iconsel'],
  ['heights', 'kit-heights'],
  ['entry', 'kit-entry'],
  ['splash', 'kit-splash'],
  ['font-a', 'kit-font-f-now'],
  ['font-b', 'kit-font-f-hei'],
  ['font-c', 'kit-font-f-three'],
  ['font-d', 'kit-font-f-sys'],
  ['font-d-prime', 'kit-font-f-dp'],
]) {
  await page.locator(t(id)).screenshot({ path: join(out, `kit-${name}.png`) }).catch((e) => console.log('FAIL ' + name + ' ' + e))
}
await page.screenshot({ path: join(out, 'kit-viewport.png') })
console.log('OK ' + out)
await app.close()
