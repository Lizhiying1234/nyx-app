import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'
import { GUIDE_SEEN_KEY, ONBOARDING_KEY, PAGE_GUIDES } from '../src/core/onboarding.ts'

/**
 * ★★★ 页面内引导（第二层）· D-484 —— **接线**这一层的闸
 *
 * ══ 为什么非要有这一套 ★★★ ═══════════════════════════════════
 *
 * 判据那一层（`shouldShowGuide` · `parseGuideSeen` · `noteGuideSeen`）在 core，
 * 已经有单测。但这一层**全部的病都不在判据里**，都在接线上：
 *
 *   · 标记打在了另一个元素上   → 框指着一块不相干的地方
 *   · 触发写在「进了这一页」    → 目标还没渲染，屏上一个字都不画
 *   · 量不到目标却占住了闸      → 这一趟剩下七条**全部不出**，一声不响
 *   · 放弃的时候记了「看过」    → 那一条**永久**再也不出现
 *
 * 这四种坏法有一个共同点：**`check` 全绿、单测全绿、屏上是空的**。
 * 只有真起一次 Electron、真点一下、真去看 DOM 里有没有那个框，才分得出来。
 *
 * ★ 这一套**不验文案**（那是 core 的名单说了算，`says` 直接从 core 读进来比）——
 *   验的是「该出的时候出了吗 · 指的是不是那个东西 · 关掉之后记对了吗」。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-guide-'))
const errors: string[] = []
let app: ElectronApplication
let page: Page

/** 读库里那张「看过」表 —— 判「记没记」只认库，不认屏 */
const seenNow = async (): Promise<Record<string, number>> =>
  await page.evaluate(async (k) => {
    const raw = await window.nyx.ui.get(k)
    try {
      return JSON.parse(String(raw ?? '{}')) as Record<string, number>
    } catch {
      return {}
    }
  }, GUIDE_SEEN_KEY)

/** 屏上现在开着的那一条（没有就是 null）*/
const openGuide = async (): Promise<string | null> => {
  const n = await page.locator('.gd-box').count()
  if (n === 0) return null
  const id = await page.locator('.gd-box').first().getAttribute('data-testid')
  return (id ?? '').replace(/^guide-/, '')
}

/**
 * 摆局：把**除了要量的那一条之外**全标成看过，然后重载。
 *
 * ★★★ 清「看过」之后**必须 reload**：渲染层把那张表缓存在模块里
 *   （`ui:get` 每次走 IPC，触发点会被反复碰到，所以只读一次）。
 *   只写库不重载，内存那份还记着「看过了」，`askGuide` 直接返回 ——
 *   屏上什么都不发生，看着像「这一页不出引导」。我在走查脚本里
 *   连着误判了三趟才找到这儿。
 * ★ 只留一条还顺手解决了另一件事：一页上可能有两条（Today 就是），
 *   留一条之后屏上那个框**只可能是**要量的那一条，不用先关谁。
 */
const onlyThisOne = async (keep: string): Promise<void> => {
  const seen = Object.fromEntries(
    PAGE_GUIDES.filter((g) => g.id !== keep).map((g) => [g.id, g.version])
  )
  await page.evaluate(
    async ([k, json]) => await window.nyx.ui.set(String(k), String(json)),
    [GUIDE_SEEN_KEY, JSON.stringify(seen)] as const
  )
  await page.reload()
  await page.waitForTimeout(1600)
}

const setSeen = async (v: Record<string, number>): Promise<void> => {
  await page.evaluate(
    async ([k, json]) => await window.nyx.ui.set(String(k), String(json)),
    [GUIDE_SEEN_KEY, JSON.stringify(v)] as const
  )
}

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  /** ★ 只有这一套要**看得见**引导 —— 别的套在 `mainWindow` 里就被标成看过了 */
  page = await mainWindow(app, 30_000, { keepGuides: true })
  page.setDefaultTimeout(9000)
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(900)
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不该让这条闸变红 */
  }
})

describe('① 与第一层互斥 —— 首次引导没看完，第二层一条都不出', () => {
  it('★★ 第一层还开着的时候，空库首屏那条不出', async () => {
    await page.evaluate(
      async ([ob, gs]) => {
        /** 第一层**没看过**（空串 = 没设过，`shouldOnboard` 回 true）*/
        await window.nyx.ui.set(String(ob), '')
        await window.nyx.ui.set(String(gs), '{}')
      },
      [ONBOARDING_KEY, GUIDE_SEEN_KEY] as const
    )
    await page.reload()
    await page.waitForTimeout(1600)

    assert.equal(
      await openGuide(),
      null,
      '★ 第一层没看完就弹了第二层 —— 他第一次进来会被两层框糊一脸'
    )
    assert.deepEqual(
      await seenNow(),
      {},
      '★ 更糟的一种：没出却记了「看过」，那一条从此永久不再出现'
    )
  })
})

describe('② 空库首屏那条（B-1 · today-paste）', () => {
  it('★★★ 第一层看完之后，它站在那颗「开始」旁边', async () => {
    await page.evaluate(
      async ([ob]) => await window.nyx.ui.set(String(ob), String(Date.now())),
      [ONBOARDING_KEY] as const
    )
    await page.reload()
    await page.waitForTimeout(1800)

    assert.equal(await openGuide(), 'today-paste', '★ 空库首屏该出 B-1，屏上没有')

    /**
     * ★★ 「出了」还不够，要验**它指的是不是那颗按钮** ——
     *   标记打错元素的表现就是「框出来了、指着别处」，而那一样是绿的。
     */
    const hole = await page.locator('[data-testid="guide-hole-today-paste"]').boundingBox()
    const btn = await page.locator('[data-testid="home-start-btn"]').boundingBox()
    assert.ok(hole && btn, '洞或按钮量不到')
    assert.ok(
      Math.abs(hole.x + hole.width / 2 - (btn.x + btn.width / 2)) < 20 &&
        Math.abs(hole.y + hole.height / 2 - (btn.y + btn.height / 2)) < 20,
      `★ 洞没套在那颗「开始」上：洞 ${JSON.stringify(hole)} vs 按钮 ${JSON.stringify(btn)}`
    )
  })

  it('★★ 说的就是 core 名单里那一句（CR-7 · 两端同一份字）', async () => {
    const said = (await page.locator('[data-testid="guide-today-paste"] .gd-s').innerText()).trim()
    const want = PAGE_GUIDES.find((g) => g.id === 'today-paste')?.says ?? ''
    assert.equal(said, want, '★ 屏上这句和 core 名单对不上 —— 两端就会各说各的')
  })

  it('★★★ 点「知道了」= 关掉 ＋ 记一笔，再进来不再出', async () => {
    await page.click('[data-testid="guide-ok-today-paste"]')
    await page.waitForTimeout(300)
    assert.equal(await openGuide(), null, '★ 点了「知道了」框还在')

    const seen = await seenNow()
    assert.equal(seen['today-paste'], 1, `★ 没记「看过」，库里是 ${JSON.stringify(seen)}`)

    /**
     * ★ 重进之前先把**别的那几条**也标成看过：改成「进页面即出」之后，
     *   Today 上不止一条有资格（`sidebar-tree` 也在这一页）——
     *   不隔离的话量到的是「另一条出来了」，而这一句问的是「**这一条**还弹不弹」。
     */
    await setSeen(Object.fromEntries(PAGE_GUIDES.map((g) => [g.id, g.version])))
    await page.reload()
    await page.waitForTimeout(1800)
    assert.equal(await openGuide(), null, '★ 看过了还再弹一次 —— 这一层最该避免的就是烦人')
  })
})

describe('③ 侧栏树那条（B-4 · sidebar-tree）· 框摆在树的右边', () => {
  it('★★★ 进首页就出 —— **不点展开**（I-190 改的就是这里）', async () => {
    /**
     * ══ 原来错在哪 ★★★ ═══════════════════════════════════════
     *
     * 第一版这条绑在「点一下展开」那个动作上，而**他的侧栏本来就是展开的** ——
     * 于是装上真用时这条**从来没出现过**，`smoke:guide` 却绿着：
     * 用例自己去点了一下，把局面摆成了满足条件的样子。
     * ☞ 现在只留「只留这一条 + 进首页」，**一次都不点展开**。
     *   哪天有人把触发又绑回某个点击，这条当场红。
     */
    await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('引导用')
      const u = await window.nyx.data.createUnit(p, '单元')
      const l = await window.nyx.data.createLecture(u, '一讲')
      /**
       * ★ 这一讲**必须有知识点**：`lecture-split` 的目标是析出的那一栏
       *   （`item-rows`），空讲次渲染的是空态，那一栏根本不在 —— 引导会静默放弃。
       *   （第一版就是这么红的：走查里那一讲有条目，这儿没有。）
       */
      await window.nyx.data.addItem(l, 'bear the brunt', '承受最重的那一下', 'B', 'She bore it.')
    })
    await onlyThisOne('sidebar-tree')
    assert.equal(await openGuide(), 'sidebar-tree', '★★★ 进首页没出 B-4 —— 又绑回窄交互了')
  })

  it('★★★ 框在树的**右边**，不压在树上（这条是量出来的，不是推的）', async () => {
    const hole = await page.locator('[data-testid="guide-hole-sidebar-tree"]').boundingBox()
    const box = await page.locator('[data-testid="guide-sidebar-tree"]').boundingBox()
    assert.ok(hole && box, '洞或框量不到')
    /**
     * ★★ 第一版的摆法是「只做上下」，而侧栏这个目标是 249 宽 × 整块高 ——
     *   框摆在它下面**正好盖住他要看的那棵树**。这条钉的就是那个回归。
     */
    assert.ok(
      box.x >= hole.x + hole.width,
      `★ 框压回树上了：框 x=${box.x}，洞右边 ${hole.x + hole.width}`
    )
  })

  it('★★ 看过之后，再进首页不再出', async () => {
    await page.click('[data-testid="guide-ok-sidebar-tree"]')
    await page.waitForTimeout(300)
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(900)
    assert.equal(await openGuide(), null, '★ 看过了还再弹')
  })

  it('★★★ 库**非空**时 Today 那条照样出（I-190 的病根）', async () => {
    /**
     * ★★ 这一条钉的正是使用者碰到的那件事：他库里有几百条，
     *   而第一版 `today-paste` 的条件是「库为空」—— 于是**永远不出**。
     *   目标这时候是 Resume 卡上的「贴一段新的」（空库时是首屏那颗「开始」）。
     */
    await onlyThisOne('today-paste')
    assert.equal(
      await openGuide(),
      'today-paste',
      '★★★ 库非空就不讲了 —— 那正是他一条都没看见的原因'
    )
    const hole = await page.locator('[data-testid="guide-hole-today-paste"]').boundingBox()
    const btn = await page.locator('[data-testid="home-new"]').boundingBox()
    assert.ok(hole && btn, '洞或按钮量不到')
    assert.ok(
      Math.abs(hole.x + hole.width / 2 - (btn.x + btn.width / 2)) < 20,
      `★ 洞没套在「贴一段新的」上：洞 ${JSON.stringify(hole)} vs 按钮 ${JSON.stringify(btn)}`
    )
    await page.click('[data-testid="guide-ok-today-paste"]')
    await page.waitForTimeout(300)
  })
})

describe('④ ★★★ 目标不在屏上：放弃这一条，但**不许**记「看过」', () => {
  /**
   * ══ 这一条钉的是什么 ═══════════════════════════════════════
   *
   * 「同时只许出一条」是靠 `active` 非空时直接返回实现的。
   * 于是「问了一条、而它的目标不在屏上」会把闸**永久占住**：
   * 屏上什么都不画（量不到就不画）→ 他没有东西可点 → `active` 再也回不到 null
   * → 这一趟剩下的全部不出，**一声不响**。
   *
   * 修法是 `onmiss`（连着量不到就放弃）走 `dropGuide()`：只清 `active`、
   * **不记「看过」** —— 记了就等于说他看过了，那条从此永久消失。
   * 所以这条用例有**两个**断言，缺一不可：① 闸放开了 ② 库里没多那一笔。
   *
   * 造局的办法是把目标那个 `data-guide` 属性摘掉 —— 这正是真实世界里
   * 「数据还没回来 / 他翻页走了 / 折叠区收起来了」那一刻 DOM 的样子。
   */
  it('★★★ 框开着时目标没了：自己收掉、闸放开、「看过」表没多一笔', async () => {
    /**
     * ★★ 造局的办法换了（2026-09-15）：原来是「先摘标记、再触发」，
     *   而触发改成「进页面即出」之后，那条路要靠导航，
     *   **而导航的那一下会被前一条的遮罩挡住**（T-6 之后遮罩还不给点关）——
     *   报出来的错是「点不到 nav-trash」，跟这条用例毫无关系。
     * ☞ 现在直接量**更真实的那一幕**：框正开着，目标从 DOM 里没了
     *   （他翻页走了 · 折叠区收起来了 · 数据重载了）。判据一模一样，局面更干净。
     */
    await onlyThisOne('sidebar-tree')
    assert.equal(await openGuide(), 'sidebar-tree', '前提不成立：框没开起来')
    const before = await seenNow()

    await page.evaluate(() => {
      document.querySelector('[data-guide="sidebar-tree"]')?.removeAttribute('data-guide')
    })
    /** 放弃要等够帧（组件里是连着 90 帧），给它两秒 */
    await page.waitForTimeout(2200)

    assert.equal(await openGuide(), null, '★ 目标没了，框却还画着 —— 它在指一块空白')
    assert.deepEqual(
      await seenNow(),
      before,
      '★★★ 他一个字都没看见，却被记成「看过」—— 这条引导从此永久不再出现'
    )

    /**
     * ★★ 闸真的放开了吗：把标记贴回去、走开再回来，该出就得出。
     *   只断言「没记看过」是不够的 —— 闸卡住的表现同样是「什么都没记」。
     */
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="project-area"]')
        ?.setAttribute('data-guide', 'sidebar-tree')
    })
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(900)
    assert.equal(
      await openGuide(),
      'sidebar-tree',
      '★★★ 闸被那一条占死了 —— 这一趟剩下的引导全部不会再出现'
    )
    await page.click('[data-testid="guide-ok-sidebar-tree"]')
    await page.waitForTimeout(300)
  })
})

describe('⑤ ★★★ 收掉一条之后，不许有第二条接着弹', () => {
  /**
   * ══ 这一条从哪来 ★★ ═══════════════════════════════════════
   *
   * Nyx-UI-Android 在**真机上**抓到的：收掉一条之后第二条立刻接着弹
   * （那边是「遮罩从 DOM 摘掉」本身就算一次变动 → 立刻扫出下一条），
   * 而他松手的那一下正好落在第二条的遮罩上 ——
   * **第二条被顺手点没了、他一个字没看见、记号却记了「看过」**，
   * 于是那句话**永久**不再出现。四门（静态闸）对它完全是瞎的。
   *
   * Windows 这边形状不同（`askGuide` 没有队列：`active` 非空时直接返回，
   * 被挡下的那条**丢掉**、下次触发再说），所以结构上不该发生。
   * ★★ 但「不该发生」不是判据 —— 摆出那个局面，量一遍。
   *   这条**断言的是「什么都没发生」**，所以它天生是绿的：
   *   负向对照放在这条用例自己的前提里（第二条确实被问过一次），
   *   问都没问过的话，这条用例什么都没在验。
   */
  it('★★★ 开着一条时问第二条：第二条既不弹，也不许被记成「看过」', async () => {
    /**
     * 起局：**只留两条**没看过 —— `sidebar-tree`（首页那条，落地就出）
     * 与 `vault-learned`（第二条的触发点在别的页）。
     * ★ 改成「进页面即出」之后，不能再靠「点一下展开」起局了：
     *   落地那一刻框已经在屏上，那一下点击会被它的遮罩吃掉
     *   （报出来的错是「点不到 nav-toggle-project-N」，跟这条用例毫无关系）。
     */
    await setSeen(
      Object.fromEntries(
        PAGE_GUIDES.filter((g) => g.id !== 'sidebar-tree' && g.id !== 'vault-learned').map((g) => [
          g.id,
          g.version
        ])
      )
    )
    await page.reload()
    await page.waitForTimeout(1600)
    assert.equal(await openGuide(), 'sidebar-tree', '前提不成立：第一条没出来')

    /**
     * 开着的时候去碰第二条的触发点。
     *
     * ★★ 这里**不能用 `page.click`，连 `force: true` 都不行**：
     *   `force` 只是跳过可点性检查，那一下仍然按坐标派发，而坐标上最顶的是遮罩 ——
     *   于是点到的是「点外关」，第一条被关掉，量到的是 `null`。
     *   （第一版就是这么红的，红的是用例不是产品。）
     *   直接在元素上调 `.click()` 绕开命中测试，才真的碰到第二条的触发点。
     */
    await page.evaluate(() => {
      ;(document.querySelector('[data-testid="nav-lib-silent"]') as HTMLElement | null)?.click()
    })
    await page.waitForTimeout(1200)
    assert.equal(
      await openGuide(),
      'sidebar-tree',
      '★ 开着一条的时候又弹出了第二条 —— 屏上同时两个框'
    )

    await page.click('[data-testid="guide-ok-sidebar-tree"]')
    await page.waitForTimeout(800)

    assert.equal(
      await openGuide(),
      null,
      '★★★ 收掉第一条，第二条立刻接上来了 —— 他那一下松手正落在它的遮罩上'
    )
    const seen = await seenNow()
    assert.equal(seen['sidebar-tree'], 1, `★ 他亲手关掉的那条该记上：${JSON.stringify(seen)}`)
    assert.equal(
      seen['vault-learned'],
      undefined,
      `★★★ 被问过、没出来的那条**不许**留下记号 —— 他一个字都没看见，` +
        `记了就等于这句话永久消失。库里是 ${JSON.stringify(seen)}`
    )

    /**
     * ★★★ 上面两条断的都是「什么都没发生」，而**那种断言天生是绿的** ——
     *   第二条压根没被问过的话，它们照样全绿，这条用例就什么都没在验。
     *   所以补一趟**来回**：离开再进来，被挡下的那条必须**照样出得来**。
     *   这一下同时证了两件事：它的触发路真的通（前提成立），
     *   而且它被挡下的那次**没有被顺手消费掉**（记号没记、机会没丢）。
     */
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(500)
    await page.click('[data-testid="nav-lib-silent"]')
    await page.waitForTimeout(1400)
    assert.equal(
      await openGuide(),
      'vault-learned',
      '★★★ 被挡下的那条再也出不来了 —— 它那一次是被吃掉的，不是被推迟的'
    )
    await page.click('[data-testid="guide-ok-vault-learned"]')
    await page.waitForTimeout(300)
  })
})

describe('⑥ 攻坚区那条（B-7 · vault-hard）进页面就讲', () => {
  it('★★★ 攻坚区**空着也讲** —— 讲的是「这一页是什么」（I-190 改判）', async () => {
    /**
     * ★★ 原来的条件是「真有条目才讲」，听着有道理，实测是**永远不讲**：
     *   他点进攻坚区时多半是空的（那是好事），而等真有条目那天，
     *   他早就自己进来看过好几回了。
     *   「第一次容易不理解」说的是**这一页是什么**，不是「这一行是什么」。
     */
    await onlyThisOne('vault-hard')
    await page.click('[data-testid="nav-hard"]')
    await page.waitForTimeout(1400)
    assert.equal(
      await openGuide(),
      'vault-hard',
      '★★★ 进攻坚区没讲 —— 又绑回「真有条目」那道门了'
    )
    await page.click('[data-testid="guide-ok-vault-hard"]')
    await page.waitForTimeout(300)
  })
})

describe('⑦ ★★★ 点遮罩：不关、不穿透、不记（T-6 · I-192）', () => {
  /**
   * ══ 这一条从哪来 ★★★ ═══════════════════════════════════════
   *
   * C 在 Android 真机上量到的：引导刚弹出来时，他的手指**已经在去点列表了** ——
   * 那一下落在遮罩上，于是 **引导关了 · 页面没跳 · 记号却记了「看过」**，
   * 这句话从此再也不出现。他得到的是「闪了一下就没了」，而四门全绿。
   * 改成「进页面即出」之后只会更容易撞上。使用者裁：两端都不许有。
   *
   * ★ 所以这一条断三件事，缺一不可：框还在 · 页面没跳 · 库里那张表没变。
   *   只断「框还在」是不够的 —— 最坏的那种是「框还在但下面的页面已经跳走了」。
   */
  it('★★★ 点在遮罩上：框还在 · 页面没跳 · 「看过」表一个字没变', async () => {
    await onlyThisOne('vault-learned')
    await page.click('[data-testid="nav-lib-silent"]')
    await page.waitForTimeout(1400)
    assert.equal(await openGuide(), 'vault-learned', '前提不成立：框没出来')

    const before = await seenNow()
    const where = await page.locator('[data-testid="nav-hard"]').boundingBox()
    assert.ok(where, '量不到攻坚区那一行')

    /**
     * ★ 按坐标点在**遮罩盖住的地方**（底下正好是「攻坚区」那一行）——
     *   这就是他手指落下去的那一下：既要验框不关，也要验那一下**没穿透**。
     */
    await page.mouse.click(where.x + where.width / 2, where.y + where.height / 2)
    await page.waitForTimeout(900)

    assert.equal(
      await openGuide(),
      'vault-learned',
      '★★★ 点遮罩把框关掉了 —— 他一眼没看见，而记号会记上，这句话从此消失'
    )
    assert.equal(
      await page.locator('[data-testid="silent-frame"]').count(),
      1,
      '★★★ 那一下穿透了 —— 页面跳去攻坚区了'
    )
    assert.deepEqual(
      await seenNow(),
      before,
      '★★★ 点一下遮罩就记了「看过」—— 正是真机上那条病'
    )

    /** 出口只剩两个：Esc 也得还管用（IX-04 同一条栈） */
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    assert.equal(await openGuide(), null, '★ Esc 关不掉 —— 出口只剩「知道了」了')
  })
})

/**
 * ★★★ 覆盖面清单 §二 那几条（T-2 · 2026-09-15）
 *
 * 每条一句：**走到那一页 → 它自己出来 → 洞套在该套的那个元素上**。
 * ★ 不是「框出来了」就算：标记打错元素的表现同样是「框出来了」，而它指着别处。
 * ★ 摆局用 `onlyThisOne`（只留要量的那一条）—— 这几页上不止一条有资格，
 *   不隔离的话量到的可能是另一条，而断言照样绿。
 */
describe('⑧ ★★★ 清单 §二 新加的那几条', () => {
  /**
   * ★★ 一条一个 `it(`，**不用表驱动的 for 循环**：`check:gates` 数的是源码里
   *   `it(` 的条数（它扫的是文本，不是跑出来的结果）——
   *   一个循环在它眼里只有 **1 条**，于是「有人把四条拿走了」它看不见。
   *   闸的判据是什么形状，用例就得写成什么形状；为了少写几行让闸变瞎，方向反了。
   */
  const seeIt = async (id: string, target: string, go: () => Promise<void>): Promise<void> => {
    await onlyThisOne(id)
    if ((await openGuide()) !== id) {
      await go()
      await page.waitForTimeout(1600)
    }
    assert.equal(await openGuide(), id, `★★★ 进那一页没出「${id}」`)
    const hole = await page.locator(`[data-testid="guide-hole-${id}"]`).boundingBox()
    const el = await page.locator(target).first().boundingBox()
    assert.ok(hole && el, `洞或目标量不到（${target}）`)
    assert.ok(
      Math.abs(hole.x + hole.width / 2 - (el.x + el.width / 2)) < 20 &&
        Math.abs(hole.y + hole.height / 2 - (el.y + el.height / 2)) < 20,
      `★ 「${id}」的洞没套在 ${target} 上：洞 ${JSON.stringify(hole)} vs 目标 ${JSON.stringify(el)}`
    )
    await page.click(`[data-testid="guide-ok-${id}"]`)
    await page.waitForTimeout(300)
  }

  it('★★★ today-recommend · 进那一页就出，而且指的是该指的那个东西', async () => {
    await seeIt('today-recommend', '[data-testid="today-recommend"]', async () => {
      await page.click('[data-testid="nav-home"]')
    })
  })

  it('★★★ trash-tiers · 进那一页就出，而且指的是该指的那个东西', async () => {
    await seeIt('trash-tiers', '[data-guide="trash-tiers"]', async () => {
      await page.click('[data-testid="nav-trash"]')
    })
  })

  it('★★★ report-layers · 进那一页就出，而且指的是该指的那个东西', async () => {
    await seeIt('report-layers', '[data-guide="report-layers"]', async () => {
      await page.click('[data-testid="nav-home"]')
        await page.waitForTimeout(500)
        await page.click('[data-testid="home-report"]')
    })
  })

  it('★★★ capture-entry · 进 Assist 那一页就出，指的是那个总开关行', async () => {
    /**
     * ★★ 这一页上有**两条**（`capture-entry` ＋ `assist-lecture`）——
     *   使用者 2026-09-15 把 CR-3 放宽到「每页最多两条、必须是两件不同的事」。
     *   所以这条用例必须用 `onlyThisOne` 隔离：不隔离的话量到的可能是另一条，
     *   而断言照样绿。
     */
    await seeIt('capture-entry', '[data-testid="assist-switch-row"]', async () => {
      await page.click('[data-testid="nav-settings"]')
      await page.waitForTimeout(400)
      await page.click('[data-testid="set-tab-assist"]')
    })
  })

  it('★★★ prompt-area · 进那一页就出，而且指的是该指的那个东西', async () => {
    await seeIt('prompt-area', '[data-testid="prompt-nav"]', async () => {
      await page.click('[data-testid="nav-settings"]')
        await page.waitForTimeout(400)
        await page.click('[data-testid="set-tab-tutor"]')
    })
  })

  /**
   * ★★ 讲次工作台与知识点详情那两条要先铺一条路（展开侧栏 → 进讲次 → 点条目），
   *   和上面那几条不是同一种走法，单写一条。
   */
  it('★★★ lecture-split / item-analysis · 进讲次页与详情页各出一次', async () => {
    const openIfClosed = async (rowSel: string, childSel: string): Promise<void> => {
      const child = page.locator(childSel).first()
      if (await child.isVisible().catch(() => false)) return
      await page.locator(rowSel).first().click()
      await child.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    }
    const gotoLecture = async (): Promise<void> => {
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(400)
      await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
      await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
      await page.locator('[data-testid^="nav-lecture-"]').first().click()
      await page.waitForTimeout(900)
    }

    await onlyThisOne('lecture-split')
    await gotoLecture()
    assert.equal(await openGuide(), 'lecture-split', '★★★ 进讲次页没出 lecture-split')
    await page.click('[data-testid="guide-ok-lecture-split"]')
    await page.waitForTimeout(300)

    await onlyThisOne('item-analysis')
    await gotoLecture()
    await page.locator('[data-testid="item-rows"] .lrow .lt').first().click()
    await page.waitForTimeout(1400)
    assert.equal(await openGuide(), 'item-analysis', '★★★ 进知识点详情没出 item-analysis')
    await page.click('[data-testid="guide-ok-item-analysis"]')
    await page.waitForTimeout(300)
  })
})

describe('控制台', () => {
  it('渲染进程没有任何 console.error 或未捕获异常', () => {
    assert.deepEqual(errors, [], errors.join('\n'))
  })
})
