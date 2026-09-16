/**
 * 页面引导（第二层）· 一次起 Electron 把几种**摆法**都拍下来 · D-484
 *
 * ══ 为什么是「摆法」而不是「八条」★★ ═══════════════════════════
 *
 * 七条引导共用同一套长相（遮罩 · 洞 · 折线 · 漫画框 · 尾巴），
 * 每条之间真正不同的只有两件事：**说哪一句**（core 名单管，`smoke:guide` 已经在比）
 * 和**框摆在目标的哪一边**（这里管）。
 * 摆法只有三种：目标下面 · 目标上面 · 目标右边（又高又窄的目标）。
 * 所以这里挑的四个目标把三种摆法和四种体量都覆盖了 ——
 * 一颗按钮 · 一整棵树 · 一个选择器 · 一大块框。
 *
 * ★ 没拍的两条与原因，写在这里免得下一个人以为是漏了：
 *   · `practice-settle` 要真答一道题（要 AI）· `vault-hard` 要真有条目掉进攻坚区
 *     （要连着答错够次数）—— 两条都得起假 AI 跑一整轮，而它们的摆法
 *     （宽而矮的目标 → 框在下面）和 `today-paste` 是同一种，看不出新东西。
 *   · `lookup-save` 要 22 本真词典装载一遍（实测 7~10 秒）＋ 一个**不在库里**的词，
 *     `smoke:guide` 之外单为一张图起这一套不值。
 *
 * 用法：node scripts/shot-guides.mjs
 * 出图在 shots/guide-*.png —— 然后**用眼睛看**。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'
import { GUIDE_SEEN_KEY, ONBOARDING_KEY } from '../src/core/onboarding.ts'

mkdirSync('shots', { recursive: true })

/**
 * ★★ 每趟从**空库**开始。
 *   不清的话上一趟建的项目还在，`today-paste`（它的触发条件就是「库是空的」）
 *   这一趟根本不会出 —— 而那看着像「引导坏了」，其实是数据没清。
 * ★ 只清截图自己那个目录，真库一个字不碰。
 */
const shotRoot = process.env.NYX_SHOT_ROOT ?? join(process.cwd(), '.shots-guides')
rmSync(shotRoot, { recursive: true, force: true })

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  /** ★ 只往截图用的那个库写，真库一个字不碰（和 `shot.mjs` 同一条规矩）*/
  env: {
    ...process.env,
    NYX_DATA_ROOT: shotRoot,
    NYX_NO_SYNC_TIMERS: '1'
  }
})
const page = await mainWindow(app)
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

/** 第一层标成看完（不标的话第二层一条都不出，那是设计如此）+ 第二层全部清空 */
const reset = async () => {
  await page.evaluate(
    async ([ob, gs]) => {
      await window.nyx.ui.set(String(ob), String(Date.now()))
      await window.nyx.ui.set(String(gs), '{}')
    },
    [ONBOARDING_KEY, GUIDE_SEEN_KEY]
  )
}

const shoot = async (name) => {
  const box = await page.locator('.gd-box').count()
  if (box === 0) throw new Error(`★ ${name}：框没出来，拍到的会是一张「看着没问题」的空图`)
  const path = join('shots', `guide-${name}.png`)
  await page.screenshot({ path })
  console.log('出图：' + path)
  await page.click('.gd-ok .btn')
  await page.waitForTimeout(300)
}

// ── ① today-paste · 空库首屏那颗「开始」（宽而矮 → 框在上下）────
await reset()
await page.reload()
await page.waitForTimeout(1800)
await shoot('today-paste')

// ── ② sidebar-tree · 整棵树（又高又窄 → 框摆到右边）────────────
const pid = await page.evaluate(async () => {
  const p = await window.nyx.data.createProject('引导截图')
  const u = await window.nyx.data.createUnit(p, '第一单元')
  const l = await window.nyx.data.createLecture(u, 'Demo Lecture')
  await window.nyx.data.addItem(l, 'bear the brunt', '承受最重的那一下', 'B', 'She bore the brunt.')
  return p
})
await reset()
await page.reload()
await page.waitForTimeout(1500)
await page.click(`[data-testid="nav-toggle-project-${pid}"]`)
await page.waitForTimeout(600)
await shoot('sidebar-tree')

// ── ③ assist-lecture · Settings › Assist 那个选择器 ──────────
await reset()
await page.click('[data-testid="nav-settings"]')
await page.waitForTimeout(700)
await page.click('[data-testid="set-tab-assist"]')
await page.waitForTimeout(900)
await shoot('assist-lecture')

// ── ④ vault-learned ·「静默」那一整块框（大块 → 框在下面）──
await reset()
await page.click('[data-testid="nav-lib-silent"]')
await page.waitForTimeout(1400)
await shoot('vault-learned')

await app.close()
console.log('四张都出了 —— 去 shots/ 用眼睛看')
