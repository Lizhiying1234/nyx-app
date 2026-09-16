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
 * D-207 · 没配 AI 的时候，首页给一条引导（使用者 2026-09-03「可以加配置引导」）
 *
 * ══ 为什么要有它 ═══════════════════════════════════════════
 * `isConfigured()` 这个判据从 D-207 起就在，注释写着「首页要用它决定显不显示
 * 配置引导」—— 但**那个引导从来没建过**，所以这个函数一直零调用方
 * （2026-09-03 清死接口那一轮差点把它连同通道一起删掉）。
 *
 * ══ 边界：这不是催也不是数落 ═════════════════════════════
 * D-100「不催」· D-322「不羞辱」两条都管得着这块 UI，所以它必须满足三条：
 *   ① **配好之后永远不再出现**（用例 ③ 钉的就是这一条）
 *   ② **不挡路** —— 没配 AI 照样贴材料、认读、手动加知识点（用例 ②）
 *   ③ 说的是「还没配」这个事实，不是「你怎么还没配」
 *
 * ★ 负向对照：把 Home.svelte 里 `{#if !aiReady}` 那块删掉 → 用例 ① 当场红；
 *   把判据改成永远 false（写死 `aiReady = false`）→ 用例 ③ 当场红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-hint-'))

let app: ElectronApplication
let page: Page
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
  // 首页要有内容才渲染得出来（空库走的是「还没开始」那条路）
  await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('引导验收')
    const u = await window.nyx.data.createUnit(p, 'U')
    await window.nyx.data.createLecture(u, 'L')
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

describe('D-207 · 没配 AI 时首页给一条引导', () => {
  it('★★ ① 全新的库（没配 AI）→ 首页有引导，点它去设置', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="ai-setup-hint"]', { timeout: 8000 })
    const t = await page.innerText('[data-testid="ai-setup-hint"]')
    assert.match(t, /还没配 AI/)
    await page.click('[data-testid="ai-setup-go"]')
    await page.waitForSelector('[data-testid="set-tab-ai"]', { timeout: 8000 })
  })

  it('★★ ② 它不挡路 —— 没配 AI 照样能贴材料、能认读', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="ai-setup-hint"]')
    // 引导在的同时，今日练习那张卡和「贴一段新的」都还在
    assert.equal(await page.locator('[data-testid="today-card"]').count(), 1, '★ 引导不该挤掉今日练习')
    assert.equal(await page.locator('[data-testid="start-reading"]').count(), 1, '★ 认读入口不该消失')
  })

  it('★★★ ③ 配好之后它永远不再出现（D-100 不催 / D-322 不羞辱的落点）', async () => {
    await page.evaluate(async () => {
      await window.nyx.ai.save({
        split: false,
        slots: {
          // 三个槽都要给 —— 类型要求的是完整的 Record<Slot, …>
          heavy: { baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', apiKey: 'k', protocol: 'auto' },
          light: { baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', apiKey: 'k', protocol: 'auto' },
          long: { baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', apiKey: 'k', protocol: 'auto' }
        }
      })
    })
    await page.click('[data-testid="nav-settings"]')
    await page.waitForTimeout(300)
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(900)
    assert.equal(
      await page.locator('[data-testid="ai-setup-hint"]').count(),
      0,
      '★★★ 配好之后还显示引导 —— 那就成了催他'
    )
  })
})

describe('控制台', () => {
  it('渲染进程没有任何 console.error 或未捕获异常', () => {
    assert.deepEqual(
      { consoleErrors },
      { consoleErrors: [] },
      `渲染进程报错了：\n${consoleErrors.join('\n')}`
    )
  })
})
