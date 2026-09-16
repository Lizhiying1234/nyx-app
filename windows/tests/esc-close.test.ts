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
 * D-440 第三条 · **一套返回逻辑不许两套** —— 关浮层这一半（2026-09-02）
 *
 * ══ 改之前是什么样 ═══════════════════════════════════════════
 * 页面级返回 09-02 已经收敛成一条来路栈（`smoke:nav` 钉着）。
 * 但**关浮层**那一半还是七处各写各的 Esc：
 *   App.svelte（只管 menu / testDlg）· Reading · Search · DictCard 各装一个
 *   window 监听；而 **Practice / AnalyzePanel / 题型面板 / 馆藏那两个浮层
 *   一个都没有**。
 * 于是同一处 `{#if overlay}` 挂载的两个浮层行为不一样 ——
 * **认读能 Esc 关，产出不能**。桌面端没有系统返回键，Esc 就是它的等价物。
 *
 * ══ 现在 ═══════════════════════════════════════════════════
 * `esc-stack.svelte.ts` 是唯一消费点（语义照搬 Android 那份验过的
 * `backstack.svelte.ts`）：从栈顶往下找第一个愿意消费的，**一次 Esc 只关一层**。
 *
 * ★ 负向对照（这套用例的价值全在这里）：
 *   · 把 Practice.svelte 里那段 `registerEsc` 删掉 → 用例 ② 当场红
 *   · 把 esc-stack 的 `handleEsc` 改成「全都调一遍」（不 return） → 用例 ③ 当场红
 *
 * ★ 数据全在临时目录（NYX_DATA_ROOT）—— 一个字节都不碰他的真库。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-esc-'))

let app: ElectronApplication
let page: Page
let projectId = 0
let unitId = 0
let lectureId = 0
let fileId = 0

const esc = async (): Promise<void> => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
}

/**
 * 讲次那一行默认看不见 —— I-072「单元一律折叠」。先把树点开。
 * （脚手架，不是判据 —— 和 `nav-back.test.ts` 里那份同源。）
 */
async function ensureLectureVisible(): Promise<void> {
  if (!(await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]`).isVisible())) {
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(250)
  }
  if (!(await page.locator(`[data-testid="nav-lecture-${lectureId}"]`).isVisible())) {
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`)
    await page.waitForTimeout(250)
  }
}

/**
 * 打开产出练习。走的是三级菜单里的「测试…」——
 * 它按设计就**不看到期日**（「不遵循间隔重复，只要想测都能测」），
 * 所以这条路不依赖今日计划里恰好有东西。
 */
async function openPracticeViaTestDialog(): Promise<void> {
  await ensureLectureVisible()
  await page.click(`[data-testid="menu-lecture-${lectureId}"]`)
  await page.waitForTimeout(300)
  await page.click('[data-testid="tree-test"]')
  await page.waitForTimeout(400)
  await page.click('[data-testid="test-practice"]')
  await page.waitForTimeout(1200)
}

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')

  const ids = await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('Esc 验收')
    const u = await window.nyx.data.createUnit(p, '单元 A')
    const l = await window.nyx.data.createLecture(u, '第一讲')
    await window.nyx.data.addItem(l, 'serendipity', '意外发现的运气', 'B', 'A happy serendipity.')
    await window.nyx.data.addItem(l, 'stairwell', '楼梯间', 'B', 'Down the stairwell.')
    await window.nyx.study.startLearning(l)
    const f = await window.nyx.files.add('Esc 验收用的文章', 'A short passage for the esc test.', null)
    return { p, u, l, f }
  })
  projectId = ids.p
  unitId = ids.u
  lectureId = ids.l
  fileId = ids.f
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(400)
})

after(async () => {
  await app?.close()
  keepOrClean(dataRoot)
})

/** 侧边栏树默认折叠（I-072），要一级级点开才点得到讲次 */
async function openLecture(): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  if (!(await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]`).isVisible().catch(() => false))) {
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`).catch(() => {})
    await page.waitForTimeout(300)
  }
  if (!(await page.locator(`[data-testid="nav-lecture-${lectureId}"]`).isVisible().catch(() => false))) {
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`).catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
  await page.waitForSelector('[data-testid="add-item"]', { timeout: 8000 })
}

describe('D-440 · Esc 关浮层只有一套逻辑', () => {
  it('① 搜索浮层：Esc 关掉（改之前也行 —— 它是当年少数几个装了监听的）', async () => {
    await page.click('[data-testid="nav-search"]')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="search-overlay"]').count(), 1, '搜索浮层该开着')

    await esc()
    assert.equal(await page.locator('[data-testid="search-overlay"]').count(), 0, 'Esc 应该关掉搜索')
  })

  it('★★ ② 产出练习：Esc 关得掉 —— 改之前它是全 App 唯一按不了 Esc 的全屏浮层', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)
    await openPracticeViaTestDialog()
    assert.equal(
      await page.locator('[data-testid="practice-overlay"]').count(),
      1,
      '产出练习该开着'
    )

    await esc()
    assert.equal(
      await page.locator('[data-testid="practice-overlay"]').count(),
      0,
      '★★ Esc 应该关掉产出练习 —— 这一条改之前是红的（认读能关、它不能）'
    )
  })

  /**
   * ★ 「一次 Esc 只关一层」**不在这里验**，在 `tests/esc-stack.test.ts` 里。
   *
   * 原因如实记着：这台沙盒里没有配 AI，产出练习打开就是错误态
   * （`practice-error`），题型面板压根不渲染 —— 唯一不依赖 AI 的两层浮层组合
   * 造不出来。与其把用例写成「碰巧能过」的样子，不如把那条规则放到它真正
   * 住的地方（栈本身）去验。这里只管**接线接上了没有**。
   */

  /**
   * ★★ ③ P-6（2026-09-02 · WINDOWS_INVENTORY.md §5.6）—— Capture 的「选位置」
   * 弹窗以前完全没接 esc-stack，只能点遮罩关。补上之后要按同一套规则验。
   *
   * ★ 负向对照：把 Capture.svelte 里那段 `registerEsc` 删掉 → 这条用例当场红。
   */
  it('③ P-6 · Capture「选位置」弹窗：Esc 关得掉（以前只能点遮罩）', async () => {
    await page.click('[data-testid="nav-files"]')
    // 新建的文章默认「未读」，那一组默认收着（只有「在读」默认展开）——先展开
    if (!(await page.locator(`[data-testid="fs-card-${fileId}"]`).isVisible())) {
      await page.click('[data-testid="fs-group-unread"]')
      await page.waitForTimeout(250)
    }
    await page.waitForSelector(`[data-testid="fs-card-${fileId}"]`, { timeout: 8000 })
    await page.click(`[data-testid="fs-card-${fileId}"]`)
    await page.waitForSelector('[data-testid="fs-doc"] p')

    /**
     * ★ 取字处从左栏正文换成右栏那条提示（`fs-hint`，`.msg` → passage 档）。
     *   文件学习**正文**的右键 2026-09-13 起是 Save 一条道（他的 4.2），
     *   没有「选位置」弹窗了；而这条用例钉的是那个弹窗的 Esc，
     *   所以要走仍然有它的那条路。
     */
    await page.evaluate(() => {
      const p = document.querySelector('[data-testid="fs-hint"]')!
      const r = document.createRange()
      r.selectNodeContents(p)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    })
    await page.locator('[data-testid="fs-hint"]').first().click({ button: 'right' })
    await page.waitForSelector('[data-testid="ctx-menu"]')
    await page.click('[data-testid="ctx-layer-b"]')
    await page.waitForSelector('[data-testid="ctx-elsewhere"]')
    await page.click('[data-testid="ctx-elsewhere"]')
    await page.waitForSelector('[data-testid="ctx-path-dialog"]')

    // ★ 焦点必须挪进弹窗本体再按 Esc —— 右键菜单（`.pm`）自己也手写了一句
    // Escape 判断（`onkeydown={(e)=>e.key==='Escape'&&(menu=null)}`），如果焦点还停
    // 在刚才点的「收进…」按钮上（那个按钮在 `.pm` 里），Escape 会先被 `.pm` 那句
    // 元素级判断截走、把 `menu` 置空，而弹窗的 `{#if picking && menu}` 恰好也依赖
    // `menu`，弹窗会**跟着一起消失**——那不是这条用例要验的东西（会做出「不需要
    // P-6 这次修的 registerEsc 也能通过」的假绿）。真实操作里用户这时候手在弹窗
    // 里（正填项目名），焦点在 PathPicker 的输入框上，所以这里也把焦点点进去。
    await page.click('[data-testid="pp-in-p"]')
    await esc()

    assert.equal(
      await page.locator('[data-testid="ctx-path-dialog"]').count(),
      0,
      '★★ Esc 应该关掉「选位置」弹窗 —— 这一条改之前是红的（只能点遮罩关）'
    )
  })

  /**
   * ★★★ 2026-09-03 · 真机扫描（`scripts/click-sweep.mjs`）扫出来的三处
   *
   * 那次扫描点了 393 个可点元素，报告里有 34 个「点不动」—— 全在回收站和设置面，
   * 而 testid 却是**别的面**的（FileStudy 的新建弹窗、PathPicker…）。
   * 追下去是**同一个根因**：`fs-compose` 这个弹窗按 Esc 关不掉，
   * 而 `.ov` 是整屏遮罩，它开着的时候侧边栏点不动 —— 后面每一个探针都被它挡住。
   *
   * ★ 所以这不是「少一个快捷键」这种小事：不知道要点遮罩的人，
   *   看到的就是**软件不动了**。
   *
   * 查下来 FileStudy / Workbench / ItemDetail **三个组件根本没接 esc-stack**，
   * 它们名下的五个浮层全都按不掉 Esc。下面五条一处一条钉住。
   *
   * ★ 负向对照：把任一组件里那段 `registerEsc` 删掉 → 对应那条当场红。
   */
  it('★★ ④ 文件学习 ·「贴一篇文章」弹窗：Esc 关得掉', async () => {
    await page.click('[data-testid="nav-files"]')
    // ★ 这个组件会停在「正在读某一篇」的状态（上一条用例点进去过），
    //   而「贴一篇」只在列表上 —— 先退回列表再说
    const back = page.locator('[data-testid="fs-back"]')
    if (await back.count()) {
      await back.click()
      await page.waitForTimeout(400)
    }
    await page.waitForSelector('[data-testid="fs-add"]', { timeout: 8000 })
    await page.click('[data-testid="fs-add"]')
    await page.waitForSelector('[data-testid="fs-compose"]')
    await esc()
    assert.equal(
      await page.locator('[data-testid="fs-compose"]').count(),
      0,
      '★★ Esc 应该关掉贴文章弹窗 —— 改之前它按不掉，而且开着时整个侧边栏都点不动'
    )
  })

  it('★★ ⑤ 一个关不掉的弹窗会把整个应用挡住 —— 关掉之后侧边栏立刻又能点了', async () => {
    await page.click('[data-testid="nav-files"]')
    // ★ 这个组件会停在「正在读某一篇」的状态（上一条用例点进去过），
    //   而「贴一篇」只在列表上 —— 先退回列表再说
    const back = page.locator('[data-testid="fs-back"]')
    if (await back.count()) {
      await back.click()
      await page.waitForTimeout(400)
    }
    await page.waitForSelector('[data-testid="fs-add"]', { timeout: 8000 })
    await page.click('[data-testid="fs-add"]')
    await page.waitForSelector('[data-testid="fs-compose"]')
    await esc()
    // 这一下才是真正要验的：Esc 之后**不用点遮罩**就能直接换页
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(400)
    assert.ok(
      (await page.locator('[data-testid="trash-empty"]').count()) +
        (await page.locator('[data-testid="trash-purge"]').count()) >=
        1,
      '★★ Esc 关掉弹窗之后应该能直接点侧边栏 —— 这一条守的是「不会看起来像卡死」'
    )
  })

  it('★★ ⑥ 讲次工作台 ·「添加知识点」弹窗：Esc 关得掉', async () => {
    await openLecture()
    await page.click('[data-testid="add-item"]')
    await page.waitForSelector('[data-testid="add-item-form"]')
    await esc()
    assert.equal(
      await page.locator('[data-testid="add-item-form"]').count(),
      0,
      '★★ Esc 应该关掉添加知识点弹窗'
    )
  })

  it('★★ ⑦ 讲次工作台 · ••• 菜单：Esc 关得掉（真机扫描实测按不掉）', async () => {
    await openLecture()
    await page.click('[data-testid="lecture-menu"]')
    await page.waitForSelector('[data-testid="lecture-menu-open"]')
    await esc()
    assert.equal(
      await page.locator('[data-testid="lecture-menu-open"]').count(),
      0,
      '★★ Esc 应该关掉讲次 ••• 菜单'
    )
  })

  /**
   * ★ D-468（2026-09-07）· 原来这里还有一条 ⑧：词条详情的「编辑」弹窗按 Esc。
   * 使用者取消了详情页每一块旁边的「改」，那个弹窗整条链都删了 ——
   * 没有弹窗，也就没有「它按不按得掉」这个问题。用例跟着删，不留一条永远绿的空壳。
   */
})
