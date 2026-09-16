import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/*
 * ★★★ 「项目总览」那两套用例（D-462 / D-465）**已经不存在了**
 *
 * 上一轮（D-467）是「入口没了、页面还留着」，所以那两套先摘掉、等他定入口。
 * ★ 2026-09-08 使用者裁 D-R7 = 3（**D-475**）：那一屏**连页面一起删**，
 *   D-462 ～ D-465 一并作废。所以这两套不再是「等入口回来就取回」——
 *   它们验的那一屏不会回来了。
 *
 * ★★ 仍然记在这里而不是删干净：**删掉的测试不留痕迹，等于那份验收从来没存在过**
 *   —— 下一个人会以为那一屏没验过。真要考古，去 git 历史里翻 `40cfa3b`。
 */


/**
 * D-440 · 返回逻辑 —— 真实应用里点，不查内部状态
 *
 * 他报的两句原话：
 *   ①「从别的页面进去，点返回**直接回主界面**」（应该回真正的来源页）
 *   ②「搜索 serendipity → 单词详情 → 返回**直接回主界面**」
 *      （应该回到**带着那次搜索**的浮层）
 *
 * 这两条在改之前都是真的：
 *   · 讲次页的返回写死 `nav = { k: 'home' }`
 *   · 从搜索点进的词条 `from` 写死 `{ k: 'home' }`，而且浮层一卸载搜索词就没了
 *
 * ★ 负向对照怎么做（这套用例的价值全在这里）：
 *   把 App.svelte 里 `onclick={goBack}` 改回 `onclick={() => (nav = { k: 'home' })}`
 *   → 用例 ① 当场红；
 *   把 `onitem={(id) => go({ k: 'item', id })}` 改回带 `from: { k: 'home' }` 的旧写法
 *   → 用例 ②③ 当场红。
 *
 * ★ 数据全在临时目录（NYX_DATA_ROOT）—— 一个字节都不碰他的真库。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-nav-'))

let app: ElectronApplication
let page: Page
let projectId = 0
let unitId = 0
let lectureId = 0

/**
 * 讲次那一行默认看不见 —— I-072「单元一律折叠」。
 * 先把树点开，再谈点它。（这一段是测试脚手架，不是判据。）
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
    const p = await window.nyx.data.createProject('返回验收')
    const u = await window.nyx.data.createUnit(p, '单元 A')
    const l = await window.nyx.data.createLecture(u, '第一讲')
    // 搜得到的一条知识点 —— 用例 ② 要靠它从搜索进详情
    await window.nyx.data.addItem(l, 'serendipity', '意外发现的运气', 'B', 'A happy serendipity.')
    return { p, u, l }
  })
  projectId = ids.p
  unitId = ids.u
  lectureId = ids.l
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(400)
})

after(async () => {
  await app?.close()
  keepOrClean(dataRoot)
})

describe('D-440 · 返回只退一层，回真正的来源页', () => {
  /**
   * ★★ D-469（2026-09-07）· 这一条的「来源页」换了。
   *
   * 原来是**单元页** —— 点单元那一下同时把页面切过去，它就是来处。
   * 项目 / 单元不再是页面之后，树上点它们只展开 / 收起，来处只能是
   * 真正的一级入口（首页 / 知识点库 / 回收站 / 总览 / 报告）。
   * 这一条改成从**知识点库**进讲次：它和首页是两个不同的一级入口，
   * 「回到来处」和「回到首页」在这里才分得开 —— 用首页当来处的话，
   * 写死回首页的老 bug 会照样绿。
   */
  it('① 一级入口（知识点库）→ 讲次 → 返回，回的是知识点库（不是首页）', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })

    // 来源页 → 讲次（树上展开到它，再点讲次那一行）
    await ensureLectureVisible()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="add-item"]').count(), 1, '应该已经在讲次页上')

    // 讲次页的「返回」
    await page.click('[data-testid="global-back"]')
    await page.waitForTimeout(300)

    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '返回应该回到来源页（知识点库）—— 这一条改之前是红的（写死回首页）'
    )
    assert.equal(
      await page.locator('[data-testid="home-hero"]').count(),
      0,
      '返回不该回到首页'
    )
  })

  /**
   * ★★ D-469 · 树上点项目 / 单元**不再进页面** —— 它只展开 / 收起。
   * 这一条是那句话的正面判据：点完之后 nav 一动没动（还在知识点库上），
   * 而下面那一层看得见了。
   */
  it('★★ 点项目 / 单元只展开，不导航（D-469）', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })

    // 先收起，才谈得上「点一下展开」
    if (await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]`).isVisible()) {
      await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
      await page.waitForTimeout(300)
    }
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(300)
    assert.equal(
      await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count(),
      1,
      '点项目没展开它'
    )
    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '★★ 点项目把页面切走了 —— D-469 说树上的节点不是页面'
    )

    /**
     * ★ 单元的展开状态是**记着的**（`openIds`），项目重新展开之后它可能已经是开的。
     *   所以这里不假设初始状态，验的是「点一下就翻转」这件事本身 ——
     *   两次点击，前后必须互为相反，而且两次都不许跳页。
     */
    const lectureShown = async (): Promise<number> =>
      await page.locator(`[data-testid="nav-lecture-${lectureId}"]:visible`).count()
    const was = await lectureShown()
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`)
    await page.waitForTimeout(300)
    assert.notEqual(await lectureShown(), was, '点单元没有翻转它的展开状态')
    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '★★ 点单元把页面切走了'
    )
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`)
    await page.waitForTimeout(300)
    assert.equal(await lectureShown(), was, '再点一次没有翻回去（点 = 展开 / 收起）')
    assert.equal(await page.locator('[data-testid="lib-rows"]').count(), 1, '★★ 点单元把页面切走了')
  })

  it('② 搜索 → 词条详情 → 返回，回到带着那次搜索的浮层', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)

    await page.click('[data-testid="nav-search"]')
    await page.fill('[data-testid="search-input"]', 'serendipity')
    await page.waitForTimeout(600)
    await page.click('[data-testid="hit-0"]')
    await page.waitForTimeout(500)

    assert.equal(
      await page.locator('[data-testid="detail-term"]').count(),
      1,
      '应该已经进了词条详情'
    )

    await page.click('[data-testid="global-back"]')
    await page.waitForTimeout(400)

    // 浮层回来了，而且**词还在**
    assert.equal(
      await page.locator('[data-testid="search-overlay"]').count(),
      1,
      '返回应该把搜索浮层端回来 —— 改之前它是直接回首页的'
    )
    assert.equal(
      await page.inputValue('[data-testid="search-input"]'),
      'serendipity',
      '搜索词必须还在（他要的「保留刚才的状态」）'
    )
  })

  it('③ 那次搜索的结果也还在（不是一个空的搜索框）', async () => {
    // 承接用例 ②：浮层此刻开着、词也在，结果应该已经自己重跑过
    assert.ok(
      (await page.locator('[data-testid="hit-0"]').count()) >= 1,
      '带着词回来时结果要重新出现，不能只剩一个填着字的空框'
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  })

  it('④ 侧边栏一级入口是换入口，不是返回：点了之后栈清空', async () => {
    // 深进两层
    await ensureLectureVisible()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(250)

    // 横轴：点侧边栏的「回收站」= 换入口
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(300)

    // 从回收站再进讲次，返回该回**回收站**（那才是真正的来源页），
    // 而不是回到那个早就离开的项目页
    await ensureLectureVisible()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(300)
    await page.click('[data-testid="global-back"]')
    await page.waitForTimeout(300)

    assert.equal(
      await page.locator('[data-testid="add-item"]').count(),
      0,
      '横轴清过栈，返回不该回到那个早就离开的讲次页'
    )
    assert.ok(
      (await page.locator('[data-testid="trash-empty"]').count()) +
        (await page.locator('[data-testid="trash-purge"]').count()) >=
        1,
      '返回应该回到回收站 —— 它才是这一次的来源页'
    )
  })
})

/**
 * ★★★ P-1 · 全局返回手势（2026-09-02 · WINDOWS_INVENTORY.md §四）
 *
 * 压栈能进的 5 种页面（讲次/词条/项目/单元/文件学习）里，以前只有讲次和词条
 * 屏上有返回入口，其余 3 种没有办法弹栈。这里补 `Alt+←` 与鼠标侧键（XButton1，
 * `mouseup` 的 `button === 3`），覆盖项目/单元页（D-451 之后那两屏也有了屏上返回入口，手势仍要独立成立）。
 *
 * ★★ Alt+← 先问 `handleEsc()`——真关掉了什么（浮层/面板）就到此为止，
 * 和按 Esc 是同一件事，**不会**在同一下按键里又顺带翻页；`handleEsc()`
 * 说「什么都没关」时才轮到 `goBack()`。这条踩过一次坑：`escDepth()` 数的是
 * 「注册了多少个 handler」不是「真开着多少个」——`Capture` 那类组件挂载时
 * 就无条件注册、内部再判断要不要消费，讲次页只要挂着它 `escDepth()` 就 ≥1，
 * 按「escDepth()===0 才放行」的旧写法会让 Alt+← 在整个讲次页永远失效。
 *
 * ★ 负向对照：把 `tryGlobalBack` 里 `if (handleEsc()) return` 那半条删掉
 *   → 用例③当场红（浮层开着时 Alt+← 会把浮层背后的页面也一起切走）；
 *   把 `<svelte:window>` 上的 `onkeydown`/`onmouseup` 整段删掉 → 用例①②当场红。
 */
describe('★★★ P-1 · 全局返回手势（Alt+← / 鼠标侧键）', () => {
  /**
   * ★ D-469（2026-09-07）之后来处只能是一级入口 —— 单元页没了。
   *
   * 改成落在**知识点库**（一个一级入口），并保证讲次那一行可点。
   * 展开是翻转的，所以只在「现在没展开」时才点，免得把树又点回收起。
   */
  async function gotoSourcePage(): Promise<void> {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    if (!(await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]`).isVisible())) {
      await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
      await page.waitForTimeout(250)
    }
    if (!(await page.locator(`[data-testid="nav-lecture-${lectureId}"]`).isVisible())) {
      await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`)
      await page.waitForTimeout(250)
    }
    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '这条用例的前提是先落在知识点库上'
    )
    assert.equal(
      await page.locator(`[data-testid="nav-lecture-${lectureId}"]`).isVisible(),
      true,
      '这条用例的前提是讲次那一行可点'
    )
  }

  it('① Alt+← 在项目/单元页也能退一层（不靠屏上那个入口）', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)
    await gotoSourcePage()

    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="add-item"]').count(), 1, '应该已经在讲次页上')

    await page.keyboard.press('Alt+ArrowLeft')
    await page.waitForTimeout(300)

    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      'Alt+← 应该退回来源页（知识点库）'
    )
  })

  it('② 鼠标侧键（XButton1 · mouseup button===3）也能退一层', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)
    await gotoSourcePage()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(300)

    // Playwright 的 page.mouse 不能直接发 XButton，这里用真实 DOM 事件模拟
    // 硬件上的第 4 颗按钮（button===3）—— 和 App.svelte 的 onmouseup 处理的是同一件事
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 3 })))
    await page.waitForTimeout(300)

    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '鼠标侧键应该和 Alt+← 走同一条 goBack()'
    )
  })

  it('③ 浮层开着时先关浮层（和 Esc 一样），不隔着它去动下面的页面', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)
    await gotoSourcePage()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(300)

    // 搜索浮层（在 esc-stack 上）盖在讲次页上
    await page.click('[data-testid="nav-search"]')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="search-overlay"]').count(), 1, '搜索浮层应该已经开着')

    await page.keyboard.press('Alt+ArrowLeft')
    await page.waitForTimeout(300)

    // Alt+← 先问 handleEsc()：浮层真的关得掉 —— 关掉它，和 Esc 是同一件事
    assert.equal(
      await page.locator('[data-testid="search-overlay"]').count(),
      0,
      'Alt+← 应该先把浮层关掉（handleEsc() 消费了这一下），不是穿透它去翻页'
    )
    // 讲次页原地没动——没有在同一下按键里又顺带 goBack()
    assert.equal(
      await page.locator('[data-testid="add-item"]').count(),
      1,
      '关浮层的同一下 Alt+← 不该再顺带把底下的讲次页也翻走'
    )
  })

  it('④ 没有上一层时安静的无操作（栈空，不报错也不乱跳）', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)
    await page.keyboard.press('Alt+ArrowLeft')
    await page.waitForTimeout(200)
    // 首页没有 backStack，Alt+← 应该什么都不做——还留在首页
    assert.equal(
      (await page.locator('[data-testid="home-stat"]').count()) +
        (await page.locator('[data-testid="home-start"]').count()),
      1,
      '栈空时 Alt+← 不该把人带去别的地方'
    )
  })
})

describe('★★ Q-1 · 手误双击不许建出两个（使用者 2026-09-03 选 B）', () => {
  /**
   * 实测过的病：对侧边栏那颗 `＋` 真 `dblclick` 一次 → 建出**两个**项目，
   * 第二个是空的、默认名，没有撤销，他得自己发现自己删。
   *
   * ★ 两条一起验才算数 —— 去抖必须**只挡手误**：
   *   ① 双击 = 一个（挡住了）
   *   ② 隔开时间的两次点击 = 两个（没有误伤有意的连续新建）
   *
   * ★ 负向对照：把 App.svelte 里那三行去抖删掉 → ① 当场红（会变成 2 个）。
   */
  it('① 真双击一次，只建出一个项目', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(300)
    const before = await page.locator('[data-testid^="nav-toggle-project-"]').count()
    await page.dblclick('[data-testid="add-project"]')
    await page.waitForTimeout(1500)
    const after = await page.locator('[data-testid^="nav-toggle-project-"]').count()
    assert.equal(
      after - before,
      1,
      `★★ 双击应该只建 1 个，实际 ${after - before} 个 —— 改之前是 2 个`
    )
  })

  it('② 有意的连续新建不受影响：隔开一下再点，真的再建一个', async () => {
    const before = await page.locator('[data-testid^="nav-toggle-project-"]').count()
    await page.click('[data-testid="add-project"]')
    await page.waitForTimeout(900) // 超过去抖窗口 —— 这一下是「他看见结果之后」
    await page.click('[data-testid="add-project"]')
    await page.waitForTimeout(1200)
    const after = await page.locator('[data-testid^="nav-toggle-project-"]').count()
    assert.equal(after - before, 2, '★ 去抖不该把有意的连续新建也挡掉')
  })
})

/**
 * ★★★ D-451 · 有来路，就把来路显示出来（P-1 的 B 方案 · 阶段⑧）
 *
 * D-451 定的是：**「一级」是入口的属性，不是页面的属性。**
 * 同一个项目页，从侧边栏那几个扁平入口进就是根，从搜索或别的页面钻进去就是第二层。
 *
 * 于是有一件事页面自己永远答不出来：**「我现在是根，还是被人钻进来的一层？」**
 * 答案不在页面里，在来路里。所以这一屏必须**看得出来**：
 *
 *   看得见返回入口 = 你在第二层，而且它写着你是从哪来的
 *   看不见         = 你在一级入口上，没有上一层
 *
 * ★ 这几条验的不是「能不能返回」（Alt+← 早就能了，P-1/D-450 那一组在验），
 *   验的是**那条信息在不在屏幕上**。D-451 真正扎人的是后面这半。
 */
describe('★★★ D-451 · 有来路才显示返回入口，而且说出从哪来', () => {
  it('① 一级入口（回收站）进去：没有返回入口 —— 你就在根上', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(300)

    assert.equal(
      await page.locator('[data-testid="global-back"]').count(),
      0,
      '★ 侧边栏那一列是一级入口（横轴清栈），站上去就没有上一层，不该给返回入口'
    )
  })

  /**
   * ★ D-469 之后能下钻的只剩「讲次」与「词条」两种，所以这两条改用讲次页。
   *   验的东西一个字没变：**那条信息在不在屏幕上、说的是不是真的来处**。
   */
  it('★★ ② 从回收站钻进讲次页：有返回入口，且写着「回收站」', async () => {
    await ensureLectureVisible()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(400)

    const back = page.locator('[data-testid="global-back"]')
    assert.equal(await back.count(), 1, '下钻进来的一层，必须看得出有来路')
    const txt = (await back.textContent()) ?? ''
    assert.ok(
      txt.includes('回收站'),
      `★ 它得说出**从哪来**，不能只写「返回」—— 实际是「${txt.trim()}」`
    )
  })

  it('★★★ ③ 同一个讲次页，换条路进来，它说的来路就不一样', async () => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    await ensureLectureVisible()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForTimeout(400)

    const txt = ((await page.locator('[data-testid="global-back"]').textContent()) ?? '').trim()
    assert.ok(
      txt.includes('全部'),
      `★★ 这就是 D-451 的原话「页面处在第几层由你怎么来的决定」—— 实际是「${txt}」`
    )
  })
})

/**
 * ★★ D-469（2026-09-07）· 树上的项目 = **展开 / 收起**，不再是「展开并且进它的页面」。
 *
 * 这一族原来叫「I-1 · 点当前项目不许收起它的子树」：那时点项目**一定会导航**，
 * 于是「点我已经在的那个项目反而把内容藏了」是个真 bug（用 `ensureOpen` 只开不关修的）。
 * 现在项目没有页面了 —— 点它表达的就是「展开 / 收起」这一件事，翻转才是对的。
 *
 * ★ 所以这一族改验两件他看得见的事：
 *   ① 点一下展开、再点一下收起（翻转，而且**不跳页**）
 *   ② 行末那颗箭头照旧只管收起（一件事两个入口，行为一致）
 */
describe('★★ D-469 · 树上点项目 = 展开 / 收起（不跳页）', () => {
  /** 确定性地收起 —— 不能靠「它现在多半是关着的」（这一条曾经因此假绿过） */
  const collapse = async (): Promise<void> => {
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    if ((await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count()) > 0) {
      await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
      await page.waitForTimeout(350)
    }
    assert.equal(
      await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count(),
      0,
      '前置没成立：子树本该是收起的'
    )
  }

  it('① 点一次展开，页面不动', async () => {
    await collapse()
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count(),
      1,
      '点项目没展开子树'
    )
    assert.equal(
      await page.locator('[data-testid="lib-rows"]').count(),
      1,
      '★★ 点项目把页面切走了 —— 树上的节点不是页面（D-469）'
    )
  })

  it('★★ ② 再点一次收起（翻转），页面还是不动', async () => {
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count(),
      0,
      '再点一次没收起来'
    )
    assert.equal(await page.locator('[data-testid="lib-rows"]').count(), 1, '收起时把页面切走了')
  })

  /**
   * ★★ 2026-09-09 使用者裁：**把项目行 / 单元行上那个折叠符号删掉，折叠功能保留**。
   *   （Android 侧先做，他看过真机截图后确认；两端同一件事。）
   *
   * 这一条原来叫「行末那颗箭头也管收起」。箭头没了，**守卫不能跟着没**：
   * 改成守两件事 ——
   *   ① 屏上**真的**没有那个符号（`car-*` 一个都不许再出现）
   *   ② **收得起来**（功能一点没少）
   * ★ 第 ① 条不是为了「验证我删干净了」，是为了**把他的裁决钉住** ——
   *   代价（没有任何记号说这一行能展开）他已经知道并接受，
   *   下一个会话若把箭头当 bug 补回去，这一条当场红。
   */
  it('★★ 树上没有折叠符号，但收得起来（使用者 2026-09-09 裁）', async () => {
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(300)
    assert.equal(
      await page.locator('[data-testid^="car-"]').count(),
      0,
      '★★ 折叠符号又回来了 —— 使用者 2026-09-09 明码裁掉的，不是 bug'
    )
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count(),
      0,
      '★ 符号删了，连收起也一起没了 —— 他要的是「删符号，留功能」'
    )
    assert.equal(await page.locator('[data-testid="lib-rows"]').count(), 1, '收起时把页面切走了')
    // 再点开，别把后面的用例坑了
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(300)
  })
})

/**
 * ★★ I-1b（2026-09-03）· 单元展开之后**必须收得回去**
 *
 * ★ 这是 I-1 自己带出来的缺口，不是历史遗留：
 *   I-1 把单元行的点击从 toggle（无条件翻转）改成 ensureOpen（只开不关），
 *   注释写着「收起交给行末的箭头」—— **但那颗箭头从来没接过线**。
 *   它甚至借错了槽位：.sb .n 本来是「数量」位（mono 10px），塞了个 caret 进去。
 *   于是从 0dd24f2 起，**单元展开之后再也收不起来**。
 *
 * ★★ 教训记在这里：**一条修复的注释里写「交给 X」，就必须当场验 X 真的在**。
 *   项目那一层我验了（I-1 用例 ③），单元这一层我只写了注释就走了。
 *
 * ★ 2026-09-09 · 折叠符号按使用者裁决删了，**这一族守的事一个字没变**：
 *   「单元展开之后必须收得回去」。改的只是点哪个元素 —— 以前点行末那颗箭头，
 *   现在点行本身（D-469 之后行本身就是 toggle）。
 * ★ 负向对照：把单元行的 `onclick` 从 `toggle` 改回 `ensureOpen`（只开不关）→ ② 当场红。
 */
describe('★★ I-1b · 单元展开之后必须收得回去', () => {
  it('① 先确保单元是展开的（讲次那一行看得见）', async () => {
    await ensureLectureVisible()
    assert.equal(
      await page.locator(`[data-testid="nav-lecture-${lectureId}"]:visible`).count(),
      1,
      '前置没成立：单元本该是展开的'
    )
  })

  it('★★★ ② 点单元那一行 —— 讲次必须收进去，而且不跳页', async () => {
    const before = await page.locator('h1').first().textContent()
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`)
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator(`[data-testid="nav-lecture-${lectureId}"]:visible`).count(),
      0,
      '★ 点了单元这一行，讲次还在 —— 单元收不起来（I-1b 回来了）'
    )
    assert.equal(
      await page.locator('h1').first().textContent(),
      before,
      '★ 收起子树不该顺带跳页（stopPropagation 没生效）'
    )
  })

  it('③ 再点一次要能展开回来', async () => {
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`)
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator(`[data-testid="nav-lecture-${lectureId}"]:visible`).count(),
      1,
      '这一行只能收不能开'
    )
  })
})


/**
 * ★ H-3 · 讲次页那行面包屑要能点 —— ★ D-469 之后它的**去处变了**
 *
 * 返回入口说「你从哪来」（D-451，来路可变），面包屑说「你在哪」（归属，固定）。
 * 项目页 / 单元页取消之后，「你在哪」唯一的去处就是侧边栏那棵树：
 * 点面包屑 = **在树上展开到那一层**，不跳页。
 *
 * ★ 这一条要挡的是「留着一个点了什么都不发生的控件」——
 *   那正是 `check:dead` 抓不到的那种死控件（它有 onclick，只是什么也没做）。
 */
describe('★ H-3 · 讲次页面包屑把树展开到那一层（D-469）', () => {
  it('① 先把树整个收起，再从讲次页点面包屑里的项目 —— 项目那一支展开了', async () => {
    // 从知识点库进讲次（树此刻是展开的，才点得到讲次那一行）
    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]', { timeout: 8000 })
    await ensureLectureVisible()
    await page.click(`[data-testid="nav-lecture-${lectureId}"]`)
    await page.waitForSelector('[data-testid="crumb-project"]', { timeout: 8000 })

    // 收起整支 —— 不收起就验不到「点了之后展开」（点行本身，树上已经没有折叠符号）
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`)
    await page.waitForTimeout(350)
    assert.equal(
      await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count(),
      0,
      '前置没成立：这一支本该收起了'
    )

    await page.click('[data-testid="crumb-project"]')
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator(`[data-testid="nav-toggle-unit-${unitId}"]:visible`).count(),
      1,
      '★ 点面包屑里的项目，树上没有展开到它 —— 那这个控件点了等于没点'
    )
    // 而且**没跳页**：还站在这一讲上
    assert.equal(
      await page.locator('[data-testid="add-item"]').count(),
      1,
      '★ 点面包屑把人带走了 —— 它说的是「你在哪」，不是「去哪」'
    )
  })

  it('② 点面包屑里的单元 —— 单元那一支也展开到讲次这一层', async () => {
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`)
    await page.waitForTimeout(350)
    assert.equal(
      await page.locator(`[data-testid="nav-lecture-${lectureId}"]:visible`).count(),
      0,
      '前置没成立：单元本该收起了'
    )
    await page.click('[data-testid="crumb-unit"]')
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator(`[data-testid="nav-lecture-${lectureId}"]:visible`).count(),
      1,
      '★ 点面包屑里的单元，树上没有展开到它'
    )
    assert.equal(await page.locator('[data-testid="add-item"]').count(), 1, '★ 点面包屑把人带走了')
  })
})

/**
 * ★★★ D-469（2026-09-07）· 项目页 / 单元页上的动作**搬进了树节点的右键菜单**（D-377）
 *
 * 使用者原话：「不要留下『原来有主页，现在只是把内容删空』的空页面。」
 * 页面删掉不等于功能删掉 —— 那两页上真正有用的三样东西
 * （随时认读 / 练习 · 导出笔记 · 新建下一级）必须在别处够得着，
 * 而且**项目和单元两级都要有**（原来两页各有一份）。
 *
 * ★ 这一条只查他看得见的：右键那一行，菜单里有没有这几项、点了出不出得来。
 * ★ 负向对照：把菜单里 `tree-test` 那一项删掉 → ② 当场红。
 */
describe('★★★ D-469 · 项目 / 单元的动作在右键菜单里（页面没了，功能不许没）', () => {
  it('① 项目行右键 —— 菜单出来了，三样动作都在', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(250)
    await page.click(`[data-testid="nav-toggle-project-${projectId}"]`, { button: 'right' })
    await page.waitForSelector('[data-testid="tree-menu"]', { timeout: 8000 })
    for (const id of ['tree-test', 'tree-export', 'tree-new', 'tree-rename', 'tree-delete']) {
      assert.equal(
        await page.locator(`[data-testid="${id}"]`).count(),
        1,
        `★ 项目的右键菜单里少了「${id}」—— 那这个功能就真的没了`
      )
    }
    assert.match(
      await page.innerText('[data-testid="tree-test"]'),
      /随时认读|随时练习/,
      '★ 「随时认读 / 练习」那一项的文字变了'
    )
  })

  it('★★ ② 点「随时认读 / 练习…」——那个弹窗真的出来了（不是一个死菜单项）', async () => {
    await page.click('[data-testid="tree-test"]')
    await page.waitForSelector('[data-testid="test-dialog"]', { timeout: 8000 })
    const t = await page.innerText('[data-testid="test-dialog-title"]')
    assert.match(t, /随时认读/, `弹窗标题不对：${t}`)
    // 两条线都给得出（I-061 那一个弹窗，不是两个入口）
    assert.equal(await page.locator('[data-testid="test-reading"]').count(), 1)
    assert.equal(await page.locator('[data-testid="test-practice"]').count(), 1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  it('③ 单元那一级也有同样三样（原来单元页上有一份）', async () => {
    await ensureLectureVisible()
    await page.click(`[data-testid="nav-toggle-unit-${unitId}"]`, { button: 'right' })
    await page.waitForSelector('[data-testid="tree-menu"]', { timeout: 8000 })
    for (const id of ['tree-test', 'tree-export', 'tree-new']) {
      assert.equal(
        await page.locator(`[data-testid="${id}"]`).count(),
        1,
        `★ 单元的右键菜单里少了「${id}」`
      )
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  })

  it('④ 空项目那一行说清下一步怎么办（不是一片空白）', async () => {
    const pid = await page.evaluate(async () => await window.nyx.data.createProject('空项目验收'))
    await page.waitForTimeout(600)
    await page.click(`[data-testid="nav-toggle-project-${pid}"]`)
    await page.waitForTimeout(400)
    const side = await page.innerText('.side')
    assert.ok(side.includes('还没有单元'), `★ 空项目展开之后什么都没说：${side.slice(-200)}`)
    assert.ok(side.includes('右键新建'), '★ 没告诉他怎么建 —— 树上又没有 ＋ 了')
  })
})

/**
 * ★★★ T-4.9（D-R19）· 侧边栏四区
 *
 * ① 顶部固定（搜索 · 首页 · 知识点组 · 文件学习）
 * ② 置顶（`projects.pinned`）
 * ③ 普通项目 —— **只有这一区独立滚动**
 * ④ 底部固定（同步 · 垃圾箱 · 设置）
 *
 * ── 这一套验的是「他眼睛看得见的空间关系」，不是 CSS 文本 ──────
 *
 * 判据全是量出来的：谁在滚、谁不动、谁贴着底边、置顶的那几个在哪一区。
 *
 * ★ 负向对照：把 `.side .projects` 的 `overflow-y: auto` 或
 *   `flex: 1 1 auto` 拆掉（= 「只有项目区滚动」这个容器没了），
 *   下面第二条当场红：项目区不再自己滚，撑高的是外层。
 */
describe('★★★ T-4.9 · 侧边栏四区（D-R19）', () => {
  /** 造到项目区**必然溢出** —— 不溢出就验不到「谁在滚」 */
  before(async () => {
    await page.click('[data-testid="nav-home"]')
    await page.evaluate(async () => {
      for (let i = 1; i <= 24; i++) {
        const p = await window.nyx.data.createProject(
          `T-4.9 项目 ${i} · 名字按他真实用的那种长度来写`
        )
        const u = await window.nyx.data.createUnit(p, `第 ${i} 单元`)
        await window.nyx.data.createLecture(u, 'Amy went missing on their fifth anniversary')
      }
      // 置顶两个 —— ② 区要真的有东西
      const tree = await window.nyx.data.tree()
      for (const p of tree.slice(0, 2)) await window.nyx.data.setPinned(p.id, true)
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('[data-testid="project-area"]')
    await page.waitForTimeout(500)
  })

  it('★ 四区都在，导航条目一个不减（D-456 / D-042）', async () => {
    for (const z of ['nav-zone-top', 'nav-zone-pinned', 'nav-zone-projects', 'nav-zone-bottom']) {
      assert.equal(await page.locator(`[data-testid="${z}"]`).count(), 1, `★ 少了一区：${z}`)
    }
    // 入口一个不减 —— 搬了位置不等于少了东西
    for (const id of [
      'nav-search',
      'nav-home',
      'nav-hard',
      'nav-lib-all',
      'nav-lib-upload',
      'nav-lib-silent',
      'nav-files',
      'nav-settings',
      'nav-trash',
      'add-project'
    ]) {
      assert.ok(
        await page.locator(`[data-testid="${id}"]`).isVisible(),
        `★★ 导航少了「${id}」—— D-456：覆盖面一个不减`
      )
    }
    const text = await page.locator('.side').innerText()
    // ★ D-476 术语落地（2026-09-08）：侧栏七个空间名换了，这里跟着换 ——
    //   断言的还是同一件事「覆盖面一个不减」，只是名字按术语表说
    for (const w of ['搜索', 'Today', '项目', 'Vault', '文件学习', 'Settings', '回收站', '置顶']) {
      assert.ok(text.includes(w), `★ 侧边栏缺了「${w}」`)
    }
  })

  it('★★★ 只有项目区在滚 —— 外层一动不动', async () => {
    const m = await page.evaluate(() => {
      const pa = document.querySelector('[data-testid="project-area"]') as HTMLElement
      const sc = document.querySelector('.side .scroll') as HTMLElement
      return {
        proj: { scroll: pa.scrollHeight, client: pa.clientHeight },
        outer: { scroll: sc.scrollHeight, client: sc.clientHeight },
        overflow: getComputedStyle(pa).overflowY
      }
    })
    assert.equal(m.overflow, 'auto', `★ 项目区的 overflow-y 是 ${m.overflow}，那它就不是一块独立滚动区`)
    assert.ok(
      m.proj.scroll > m.proj.client,
      `★★ 项目区没有溢出（内容 ${m.proj.scroll} / 可视 ${m.proj.client}）—— 这一条验不到东西了`
    )
    assert.ok(
      m.outer.scroll <= m.outer.client + 1,
      `★★★ 外层跟着一起滚了（内容 ${m.outer.scroll} / 可视 ${m.outer.client}）——` +
        `「只有项目区独立滚动」没成立，项目一多整条会被撑高`
    )
  })

  it('★★ 顶部 / Vault / 底部三个固定区都不随项目增多而移动', async () => {
    /**
     * ★★ 使用者 2026-09-13 点名：「不应该因为 Project 数量变化
     *   让其他区域跟着移动」。
     *
     * ★ **Vault 是新加进来的那一个，而它恰恰是真出过事的**：
     *   它排在项目区**下面**，所以项目区一旦按内容高（`flex: 0 1 auto`），
     *   树长一行它就被整块往下推一行。同一天我真把 `flex` 改成过 `0 1 auto`，
     *   这条用例当时没有 —— 所以没人拦。现在有了。
     */
    const where = async (): Promise<{
      top: number
      vault: number
      bottom: number
      win: number
    }> =>
      page.evaluate(() => {
        const t = document.querySelector('[data-testid="nav-zone-top"]')!.getBoundingClientRect()
        const v = document.querySelector('[data-testid="nav-zone-vault"]')!.getBoundingClientRect()
        const b = document.querySelector('[data-testid="nav-zone-bottom"]')!.getBoundingClientRect()
        return {
          top: Math.round(t.top),
          vault: Math.round(v.top),
          bottom: Math.round(b.bottom),
          win: window.innerHeight
        }
      })

    /**
     * ★★ **窗口要够高，这条断言才分得出差别。**
     *
     *   默认窗口下，夹具里的项目已经多到把项目区**填满**了 ——
     *   而填满之后 flex 的收缩会把它压回容器内，`0 1 auto` 和 `1 1 auto`
     *   算出来的位置**一模一样**。我第一版就是这么写的：
     *   把 `flex` 改回 `0 1 auto` 跑负向对照，**它没红** —— 一条安慰牌。
     *   放高窗口、让树填不满，`0 1 auto` 的「按内容高」才会把下面的区往下推。
     */
    await page.setViewportSize({ width: 1500, height: 1400 })
    await page.waitForTimeout(400)

    const before = await where()
    await page.evaluate(async () => {
      for (let i = 1; i <= 12; i++) {
        await window.nyx.data.createProject(`再加一个项目 ${i} · 同样是真实长度的名字`)
      }
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('[data-testid="project-area"]')
    await page.waitForTimeout(500)
    const after = await where()

    assert.equal(after.top, before.top, `★★ 又加了 12 个项目，顶部固定区跟着下移了`)
    assert.equal(
      after.vault,
      before.vault,
      `★★ 又加了 12 个项目，Vault 被整块顶下去了（${before.vault} → ${after.vault}）`
    )
    assert.equal(after.bottom, before.bottom, `★★ 又加了 12 个项目，底部固定区被顶走了`)

    /**
     * ★★ 再铉一条**承重的声明本身** —— 因为上面那几条行为断言
     *   **在这个夹具里可能恰好恢真**，我踩过：
     *   项目区有 `max-height: 42vh` 的封顶，夹具里项目一多就顶到那个封顶，
     *   于是 `flex-grow: 0` 和 `1` 算出来的位置一模一样——负向对照两次都没红。
     *
     *   `flex-grow: 1` 是「高度由**窗口**决定、不随内容变」的唯一来源；
     *   改成 0 的那一刻，树长一行下面的区就跟着挪一行（实测过：新库、
     *   1400 高窗口、加 12 个项目 → Vault 下移 **389px**）。
     *   所以它值得被直接铉一条，而不是只指望行为断言。
     */
    assert.equal(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('[data-testid="project-area"]')!).flexGrow
      ),
      '1',
      '★★ 项目区的 flex-grow 不是 1 —— 它的高度会跟着内容变，下面的区就会被顶走'
    )
    assert.ok(
      after.bottom <= after.win + 1,
      `★★ 底部固定区跑到窗口外了（底 ${after.bottom} / 窗口 ${after.win}）`
    )
  })

  it('★★ 置顶的项目在置顶区里，不在普通项目区里', async () => {
    const m = await page.evaluate(() => {
      const ids = (root: Element): string[] =>
        [...root.querySelectorAll('[data-testid^="nav-toggle-project-"]')].map(
          (e) => e.getAttribute('data-testid') ?? ''
        )
      const pinnedZone = document.querySelector('[data-testid="pinned-area"]')!
      const plainZone = document.querySelector('[data-testid="project-area"]')!
      return {
        pinned: ids(pinnedZone),
        plain: ids(plainZone),
        /**
         * ★ 2026-09-14 第七条：那枚图钉 emoji（`.pin`）没了 ——
         *   置顶现在是项目标识自己**亮起来**（`.pmark.on`）。
         *   判据一个字没变（「置顶区里每一行都带着置顶记号」），只是认的那个类名换了。
         */
        pins: document.querySelectorAll('[data-testid="pinned-area"] .pmark.on').length
      }
    })
    assert.equal(m.pinned.length, 2, `★ 置顶区里应该有 2 个项目，实际 ${m.pinned.length}`)
    assert.equal(m.pins, 2, '★ 置顶区里的 📌 记号没了 —— 那他分不出哪个是自己钉上去的')
    for (const id of m.pinned) {
      assert.ok(!m.plain.includes(id), `★★ ${id} 同时出现在两个区里 —— 同一个项目有了两行`)
    }
    assert.ok(m.plain.length > 0, '★ 普通项目区空了')
  })
})
