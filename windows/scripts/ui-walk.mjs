/**
 * UI 走查截图 —— 一次启动，把 Windows 每一屏（含浮层 · 菜单 · 多选 · 小窗口）各截一张。
 *
 * 为什么要它：`npm run shot` 一次只拍一屏、每屏重起一次 Electron；UI 阶段每改一轮都要
 * 看全部屏幕，逐屏起一次太慢。这个脚本走完 40 屏约一分钟。
 * ★ 数据用 `.demo/`（`npm run demo` 灌的半年假数据），**不碰真库**。没有 `.demo` 先跑
 *   `NYX_DATA_ROOT=.demo electron out/main/seed-demo.js`。
 *
 * 用法：npm run build && node scripts/ui-walk.mjs [出图目录，默认 shots/walk]
 * 出图后**用眼睛看**（memory: ui-must-look-not-infer）；找不到的元素会标 FAIL 并仍然截一张。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mainWindow } from '../tests/win.ts'

const cwd = process.cwd()
const out = resolve(process.argv[2] ?? 'shots/walk')
mkdirSync(out, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NYX_DATA_ROOT: join(cwd, '.demo') } })
/**
 * ★★ **不能用 `app.firstWindow()`**（2026-09-14）—— 它现在拿到的是桌面那颗悬浮球。
 *
 * 那颗球是 Assist 的桌面开关入口（使用者 2026-09-14 点名要的），46px、`alwaysOnTop`。
 * 它一加，这条 40 屏的走查会在那颗球里找侧边栏，**全线倒**。
 * 同一类 bug 这是第四张脸（前三张：`firstWindow()` 在24 个测试里 ·
 * `overlay.test.ts` 的 `windows()[1]` · `smoke.test.ts` 的 `getAllWindows()[0]`）。
 * ★ 这一张尤其隐蔽：它是**脚本不是测试**，不在 `verify` 里，
 *   坏了没有任何验收会报 —— 只会在下一个人跑它的时候涌出 40 条超时。
 * ★★ 判据**就是 `tests/win.ts` 那一份**（B-9，2026-09-14 改）。
 *   这里原来是一段**抄过来的**同款循环，注释还写着「判据和 tests/win.ts 同一份」——
 *   抄的不叫同一份：`SUB` 那三个键将来加第四个时，改的人多半只改 `win.ts`，
 *   这边安静地漂走，而漂走的表现又是「40 条超时」这种指错方向的话。
 *   所以直接 import，一份判据一处维护。
 */
const page = await mainWindow(app)
await page.setViewportSize({ width: 1600, height: 1000 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)

const log = []
const t = (id) => `[data-testid="${id}"]`
const first = (prefix) => page.locator(`[data-testid^="${prefix}"]`).first()
async function shot(name, fn, wait = 800) {
  try {
    await fn()
    await page.waitForTimeout(wait)
    await page.screenshot({ path: join(out, name + '.png') })
    log.push(`OK   ${name}`)
  } catch (e) {
    log.push(`FAIL ${name}: ${String(e).split('\n')[0].slice(0, 140)}`)
    try { await page.screenshot({ path: join(out, name + '.FAIL.png') }) } catch {}
  }
}
const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200) }
/**
 * ★ 侧栏第一个项目**开机就是展开的**（App.svelte:189 `openIds = [p<first>]`）——
 *   直接 click 一下是**收起**，后面找单元就 30 秒超时。所以展开一律走这个：
 *   已经开着就不点。2026-09-08 UI-Win 会话补，原来 02→27 全线倒。
 */
const ensureOpen = async (loc) => {
  const cls = (await loc.getAttribute('class')) ?? ''
  if (!cls.split(/\s+/).includes('open')) await loc.click()
  await page.waitForTimeout(300)
}
const openLecture = async () => {
  await ensureOpen(first('nav-toggle-project-'))
  await ensureOpen(first('nav-toggle-unit-'))
  await first('nav-lecture-').click()
}

await shot('01-home', async () => {})
await shot('02-project', () => ensureOpen(first('nav-toggle-project-')))
await shot('03-unit', () => ensureOpen(first('nav-toggle-unit-')))
await shot('04-lecture', () => first('nav-lecture-').click())
await shot('05-lecture-menu', () => page.click(t('lecture-menu')))
await shot('06-lecture-compose', async () => { await esc(); await page.click(t('drop-paste')) })
await shot('07-lecture-add-item', async () => { await page.click(t('compose-cancel')).catch(() => {}); await page.click(t('add-item')) })
// ★ 07 打开的是「加一条」弹窗，不关掉它遮罩挡住整条侧栏 —— 08～12 原来全线 30 秒超时
await shot('08-lib-all', async () => { await esc(); await page.click(t('nav-lib-all')) })
await shot('09-item-detail', () => first('lib-row-').click(), 1500)
await shot('10-lib-upload', () => page.click(t('nav-lib-upload')))
await shot('11-lib-silent', () => page.click(t('nav-lib-silent')))
await shot('12-lib-multiselect', async () => {
  await page.click(t('nav-lib-all')); await page.waitForTimeout(500)
  for (const i of [0, 1, 2]) await page.locator('[data-testid^="ck-"]').nth(i).click()
})
await shot('13-lib-row-hover', async () => { await esc(); await page.click(t('nav-lib-all')); await page.waitForTimeout(500); await first('lib-row-').hover() }, 400)
await shot('14-hard', () => page.click(t('nav-hard')))
await shot('15-hard-practice', () => page.getByText('测试').first().click(), 2000)
await shot('16-files', async () => { await esc(); await page.click(t('nav-files')) })
await shot('17-report', async () => { await page.click(t('nav-home')); await page.click(t('home-report')) }, 1500)
await shot('18-trash', () => page.click(t('nav-trash')))
for (const tab of ['ai', 'tutor', 'practice', 'tts', 'sync', 'dict', 'data']) {
  await shot(`19-settings-${tab}`, async () => { if (tab === 'ai') await page.click(t('nav-settings')); await page.click(t(`set-tab-${tab}`)) })
}
await shot('20-settings-danger', async () => { await page.getByText('危险操作').first().click() })
// 样式一览（设置 › 数据）—— 令牌的实物页，改完要和 DS 那张对照（DS-Q9 / A10）
await shot('20b-kit', async () => {
  await page.click(t('set-tab-data')); await page.waitForTimeout(300); await page.click(t('kit-toggle'))
  await page.locator(t('kit-panel')).scrollIntoViewIfNeeded()
}, 1200)
await shot('21-search', async () => { await page.click(t('nav-search')); await page.waitForTimeout(300); await page.click(t('search-input')); await page.keyboard.type('the') }, 1200)
await shot('22-reading', async () => { await esc(); await page.click(t('nav-home')); await page.waitForTimeout(400); await page.click(t('start-reading')) }, 1500)
await shot('23-practice', async () => { await esc(); await page.click(t('start-today')) }, 2500)
await shot('24-tree-menu', async () => { await esc(); await first('nav-toggle-project-').click({ button: 'right' }) })
await shot('25-small-home', async () => { await esc(); await page.setViewportSize({ width: 1024, height: 700 }); await page.click(t('nav-home')) })
/**
 * ★ LT-B1（2026-09-09）· <1100 侧栏收成 56 图标条，**树不在上面** ——
 *   直接找 nav-toggle-project- 会等到超时。先把侧栏铺开再点。
 *   （铺开后点一讲它自己会收回去，下一步的 27-small-settings 照常走。）
 */
await shot('26-small-lecture', async () => {
  await page.click(t('rail-toggle'))
  await page.waitForTimeout(300)
  await openLecture()
})
await shot('27-small-settings', () => page.click(t('nav-settings')))

console.log(log.join('\n'))
await app.close()
