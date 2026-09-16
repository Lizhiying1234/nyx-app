/**
 * 截图 —— 界面改动的验收手段。
 *
 * 为什么需要它：`npm run verify` 断言的是「元素存在吗 / 文字对吗 / 数据落库了吗」，
 * 它**看不见布局**。⋮ 被挤出屏幕、侧边栏底部被顶下去、标题栏滚走 ——
 * 这些在自动化验收里全部是绿的。推理 CSS 会怎么渲染，我错过三次。
 *
 * 用法：node scripts/shot.mjs <名字> [宽] [高]
 * 出图在 shots/<名字>.png，然后**用眼睛看**。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'

const name = process.argv[2] ?? 'shot'
const w = Number(process.argv[3] ?? 1400)
const h = Number(process.argv[4] ?? 900)

mkdirSync('shots', { recursive: true })
const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  /**
   * 默认写到项目里的 `.shots-data/`，**不碰真实数据**。
   *
   * 原来写的是 `'D:\Nyx'` —— JS 里 `\N` 不是转义序列，字符串实际上是 `D:Nyx`，
   * 而那是 Windows 的**盘符相对路径**，等于「D 盘当前目录下的 Nyx/」＝ 项目目录里。
   * 于是每跑一次截图，就往项目目录悄悄写一个库：既没截到真实数据的样子，
   * 也差一点让「清空真实数据」那个脚本清错地方（同一处抄过去的写法）。
   */
  env: {
    ...process.env,
    NYX_DATA_ROOT: process.env.NYX_SHOT_ROOT ?? join(process.cwd(), '.shots-data')
  }
})
/**
 * ★ 拿主窗走 `tests/win.ts` 那一份判据（B-9，2026-09-14）——
 *   以前这里是 `app.firstWindow()`，它认的是「谁先开」，跟「谁是主窗」无关；
 *   悬浮球开着的库上它拿到的是那颗 46px 的球（I-157 / I-179）。
 */
const page = await mainWindow(app)
await page.setViewportSize({ width: w, height: h })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1500)

// 造点东西出来，好看清「项目多了会怎样」
if (process.env.NYX_SHOT_SEED === '1') {
  await page.evaluate(async () => {
    // 一个项目底下塞满单元和 lecture —— 这才是他真实的样子
    const p = await window.nyx.data.createProject('项目名字可以写得非常非常长的那种')
    for (let i = 1; i <= 14; i++) {
      const u = await window.nyx.data.createUnit(p, `第 ${i} 单元`)
      for (let j = 1; j <= 3; j++) await window.nyx.data.createLecture(u, `L${j}`)
    }
    for (let i = 1; i <= 4; i++) await window.nyx.data.createProject(`另一个项目 ${i}`)
  })
  await page.reload()
  await page.waitForTimeout(1200)
  // 全部展开 —— 项目多且展开才是压力最大的状态
  // NYX_SHOT_EXPAND=1 才全展开 —— 那是「项目多且全展开」的压力图。
  // 默认不展开：挨个 toggle 会把已经开着的又关上，之后的步骤就点不到东西了。
  if (process.env.NYX_SHOT_EXPAND === '1') {
    for (const sel of await page.locator('[data-testid^="nav-toggle-"]').all()) {
      // 折叠分组里的行点不到（`.grp` 是 overflow:hidden），失败很正常 —— 但要快
      await sel.click({ timeout: 1200 }).catch(() => {})
    }
    await page.waitForTimeout(600)
  }
}

/**
 * ══ NYX_SHOT_CARDS=1 · 造一批真能进认读 / 练习屏的数据 ★ ══════
 *
 * D-486 要给使用者看**三种产出卡 + 三种认读卡**，而这两屏
 * 没有到期卡就进不去 —— 截图脚本这份 `.shots-data` 是空库。
 *
 * ★ 它只在**截图用的那个数据目录**里跑（`NYX_DATA_ROOT` 默认指向
 *   项目里的 `.shots-data/`），**一个字不碰他的真库**。
 * ★ 走的全是 `window.nyx` 那几条现成 IPC，没有第二条写库的路 ——
 *   另写一段 SQL 就是第二份「怎么建一条知识点」的真相，而它会漂。
 */
if (process.env.NYX_SHOT_CARDS === '1') {
  await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('截图用')
    const u = await window.nyx.data.createUnit(p, '第一单元')
    const l = await window.nyx.data.createLecture(u, 'Demo Lecture')
    const seed = [
      ['bear the brunt', '承受最重的那一下', 'She bore the brunt of the criticism.'],
      ['hold sway', '占主导、说了算', 'That view still holds sway in the department.'],
      ['a far cry from', '差得远', 'The result was a far cry from what we expected.']
    ]
    for (const [term, gloss, quote] of seed) {
      await window.nyx.data.addItem(l, term, gloss, 'B', quote)
    }
    await window.nyx.study.startLearning(l)
  })
  await page.reload()
  await page.waitForTimeout(1200)
}

/**
 * 走到要看的那一屏再拍 —— 弹窗、下拉菜单、勾选态，不点开根本拍不到。
 *
 *   NYX_SHOT_STEPS='[{"click":"[data-testid=\"nav-lecture-1\"]"},{"wait":400}]'
 *
 * 支持 click / rclick（右键）/ wait / fill / eval。找不到就直接报错 ——
 * 悄悄跳过会拍出一张「看着没问题」的图，那比不拍更糟。
 */
if (process.env.NYX_SHOT_STEPS) {
  for (const step of JSON.parse(process.env.NYX_SHOT_STEPS)) {
    console.log('步骤：' + JSON.stringify(step))
    if (step.wait) await page.waitForTimeout(step.wait)
    else if (step.click) await page.click(step.click, { timeout: 8000 })
    else if (step.rclick) await page.click(step.rclick, { button: 'right', timeout: 8000 })
    else if (step.fill) await page.fill(step.fill[0], step.fill[1])
    else if (step.eval) await page.evaluate(step.eval)
    await page.waitForTimeout(250)
  }
}

const shot = join('shots', `${name}.png`)
await page.screenshot({ path: shot })
console.log('出图：' + shot)
await app.close()
