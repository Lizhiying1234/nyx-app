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
 * ★★ Glance 的**置顶浮窗** —— 在别的程序上面弹出来的那张查词卡（2026-09-13）
 *
 * ══ 为什么这一套非有不可 ═════════════════════════════════════
 * 浮窗是这一批新长出来的**第二种窗口**，而在这一套写出来之前
 * `grep -rl "overlay\|glance" tests/` 的结果是**零** ——
 * 整条路一个人都没看着，而它恰恰是他用得最多的那条（选中就查）。
 * 契约里那句「不接管」让这张卡不能画在 Nyx 主窗里，所以它是**真的另一个窗口**：
 * 主窗那一套 smoke 一条都罩不到它。
 *
 * ══ 它钉的是三件「只有在别的窗口里才会坏」的事 ═══════════════
 *   ① 浮窗真的起来了，而且里面就是同一张 `DictCard`（不是另写的一张）
 *   ② 卡**装得下**：窗写死 420×520，而卡这一轮在头上多了
 *      「两行简短释义 ＋ AI | Dictionary 标签栏」。装不下的表现是**底下被切掉**，
 *      而切掉的恰好是正文 —— 屏幕上看着像「这个词没解释」。
 *   ③ 标签**点得动**：这个窗是 `focusable: false` 的（不许抢他的焦点）。
 *      不能拿主窗的结果推它 —— 「点得动」在不抢焦点的窗口里是另一回事。
 *
 * ══ 上游为什么不在这儿验 ═════════════════════════════════════
 * 「助手真的读到别的程序里的选中」那一段靠真机（自动化没法稳定地让 Edge
 * 保持前台：拉前台的进程一退出，Windows 就把焦点还给 explorer）。
 * 所以这里走下游注入点 `NYX_GLANCE_FAKE` —— 它和 `NYX_FAULT` 同一道锁，
 * **打包产物里恒不成立**。
 *
 * ★ 数据全在临时目录（NYX_DATA_ROOT）—— 一个字节都不碰他的真库。
 * ★ 这一套**不配 AI**：那两行简短释义和 AI 那一档会各自说出自己的失败态，
 *   而这一套问的是「窗口和骨架对不对」，不是「模型答得好不好」。
 *
 * ══ 负向对照（这一套的价值全在这里）════════════════
 * 把 `.dcw-tabs` 那条改成 `padding: 90px var(--sp-2)` → ④ 当场红：
 *   「头尾吃掉了 351px，窗才 520px —— 长答案进来最多只剩 169px 给正文」
 *
 * ★★ 第一版对照是**假**的，记在这儿：我在规则开头插了
 *   `padding-top/bottom: 70px`，而同一条规则后面本来就有
 *   `padding: 4px var(--sp-2) 0` —— **简写盖住了长写**。
 *   文本上补丁确实落地了（grep 得到），几何数字却一个没动
 *   （前后都是 card 251 / body 77 / chrome 175），于是「没红」看着像「铉不住」。
 *   → **「补丁落地」≠「行为变了」**：对照跑完要核对数字真的动了，不只看红不红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-overlay-'))

/** 注入给它「选中」的那串字。故意用一个普通英文词 —— 判据闸放得过（长度 2–120、不在黑名单） */
const WORD = 'counter'

let app: ElectronApplication
let overlay: Page

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...process.env,
      NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1',
      NYX_GLANCE_FAKE: WORD
    }
  })
  const main = await mainWindow(app)
  await main.waitForLoadState('domcontentloaded')
  /** 设置里把模式打开（注入点在 `applyGlance` 之后才发车） */
  await main.evaluate(() => window.nyx.glance.set('glance', ''))

  /**
   * 等浮窗。★ 认它的判据是「有那张卡、而且**没有**主窗才有的导航」——
   *   按窗口顺序认（`windows()[1]`）会在主窗重载时认错人。
   */
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !overlay) {
    for (const w of app.windows()) {
      if (!(await w.locator('[data-testid="dict-card"]').count())) continue
      const isOverlay = await w.evaluate(() => !document.querySelector('[data-testid="nav-files"]'))
      if (isOverlay) {
        overlay = w
        break
      }
    }
    if (!overlay) await main.waitForTimeout(500)
  }
  if (overlay) await overlay.waitForTimeout(800)
})

after(async () => {
  await app?.close()
  keepOrClean(dataRoot)
})

describe('★★ Glance 置顶浮窗 · 那张卡在别的窗口里也立得住', () => {
  it('★★★ ① 浮窗起来了，里面就是同一张查词卡', () => {
    assert.ok(overlay, '★★ 注入了一段选中，浮窗却没起来 —— 「选中就查」这条路是断的')
  })

  it('★★ ② 词条那一层在：喇叭 ＋ 两个标签，默认停在 AI', async () => {
    assert.equal(await overlay.locator('[data-testid="dict-say"]').count(), 1, '★ 喇叭没了')
    assert.equal(await overlay.locator('[data-testid="dict-tabs"]').count(), 1, '★ 标签栏没了')
    assert.equal(
      await overlay.locator('[data-testid="dict-tab-ai"]').getAttribute('aria-selected'),
      'true',
      '★ 他定的是「默认进入 AI」'
    )
  })

  /**
   * ══ ③ 这一条 2026-09-14 换了判据 ★★★ ═══════════════════════════
   *
   * ── 它原来钉什么、为什么现在钉不住了 ────────────────────────
   * 原来钉的是「卡没被窗口切掉」（卡底 ≤ 窗高、卡右 ≤ 窗宽）。那时候卡是
   * 380×460 摆在 420×520 的窗里，量得有意义。
   * 这一轮外面那张卡改成了 `.dcw.fill`（`position:absolute; inset:0`）——
   * 卡的四边就是窗的四边，**那两条断言变成了恒真**。
   * ★ 也就是说它不是「没红」，是**永远不会红** —— 假绿。
   *   （判据搬了，守它的闸也要搬；这一条是我自己搬歪的，写在这儿。）
   *
   * ── 现在钉什么 ──────────────────────────────────────────────
   * 钉他 2026-09-14 第三条**真正报的那个毛病**，两半：
   *   ① 浮窗的 body **必须是透明的**。不透明的话，420×520 会变成一块实心方块、
   *      卡坐在里面 —— 他的原话是「看起来像是一个大弹窗里面又套了一个小弹窗」。
   *      病根是 `global.css:9` 给 body 铺的 `--color-bg` 对**所有**窗口生效，
   *      而这个窗是 `transparent: true` 的。
   *   ② 卡**必须铺满窗**。不铺的话窗四周留一圈完全透明、却照样吃鼠标的死区：
   *      他点那一圈，事件进了浮窗（把卡关掉），而他以为自己点的是底下的网页。
   * ★ 负向对照：把 `main.ts` 里那句 `document.body.classList.add('bare')` 去掉
   *   → ① 当场红（量到的是 rgb(…) 而不是 rgba(0,0,0,0)）。
   */
  it('★★★ ③ 浮窗是真透明的，而且卡铺满了窗（使用者 2026-09-14 第三条）', async () => {
    const m = await overlay.evaluate(() => {
      const card = document.querySelector('[data-testid="dict-card"]')
      const b = card?.getBoundingClientRect()
      const bg = (el: Element | null): string =>
        el ? getComputedStyle(el).backgroundColor : '(no element)'
      return {
        bodyClass: document.body.className,
        bodyBg: bg(document.body),
        htmlBg: bg(document.documentElement),
        card: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
        vp: { w: innerWidth, h: innerHeight }
      }
    })
    assert.ok(m.card, '★ 量不到卡')

    /** ① 透明。`rgba(…, 0)` 是唯一可接受的答案 —— 任何有色底都会画成一个方块 */
    const clear = (c: string): boolean => c === 'transparent' || /,\s*0\)$/.test(c)
    assert.ok(
      clear(m.bodyBg) && clear(m.htmlBg),
      `★★★ 浮窗的底不是透明的（body ${m.bodyBg} · html ${m.htmlBg}）——` +
        ` 他会看到「一个大弹窗里面又套了一个小弹窗」。body 的类：「${m.bodyClass}」`
    )

    /** ② 铺满。差 1px 是取整，差几十像素就是一圈吃鼠标的死区 */
    assert.ok(
      Math.abs(m.card.w - m.vp.w) <= 1 && Math.abs(m.card.h - m.vp.h) <= 1,
      `★★ 卡没铺满浮窗：卡 ${Math.round(m.card.w)}×${Math.round(m.card.h)}` +
        ` vs 窗 ${m.vp.w}×${m.vp.h} —— 四周那一圈是透明的，但照样吃鼠标`
    )
    assert.ok(
      Math.abs(m.card.x) <= 1 && Math.abs(m.card.y) <= 1,
      `★★ 卡没贴着窗的左上角：(${Math.round(m.card.x)}, ${Math.round(m.card.y)})`
    )
  })

  it('★★ ④ 头尾占不满窗 —— 长答案进来时正文区还剩得下', async () => {
    const card = await overlay.locator('[data-testid="dict-card"]').boundingBox()
    const body = await overlay.locator('[data-testid="dict-body"]').boundingBox()
    const vp = await overlay.evaluate(() => ({ h: innerHeight }))
    assert.ok(card && body, '★ 量不到卡或正文区')

    /**
     * ★★ 钉的是**头尾占了多少**，不是正文区此刻多高。
     *
     *   卡是**跟着内容高**的：这一套故意不配 AI，所以 AI 那一档只有一句错 ——
     *   正文区自然就矮（77px），而那是**真实且无害**的。
     *   第一版我直接钉 `body.height >= 120`，钉错了东西：
     *   它量的是「此刻有多少字」，而我担心的是「字多的时候还有没有地方」。
     *
     *   所以量一个和内容无关的数：**头 + 尾占了多少**（卡高 − 正文高）。
     *   窗减掉它，就是长答案进来时正文能拿到的上限。
     */
    const chrome = card.height - body.height
    const roomForBody = vp.h - chrome
    assert.ok(
      roomForBody >= 180,
      `★★ 头尾吃掉了 ${Math.round(chrome)}px，窗才 ${vp.h}px ——` +
        ` 长答案进来最多只剩 ${Math.round(roomForBody)}px 给正文`
    )
  })

  it('★★★ ⑥ app 外面：下面那整段 AI **点了才跑**（使用者 2026-09-13）', async () => {
    /**
     * ★★ 这条铉的是**钱**。
     *
     *   这张卡和 app 里那张是同一个组件，而里面那条路是打开就自动发车。
     *   外面不行：他在别的软件里**顺手划中**一段就弹一次，
     *   自动跑 = 每划一下花一次 1200 token。
     *   ★ 上面那两行简短释义照样自动跑 —— Glance 的全部意义就是
     *     「选中就有意思看」，而它 240 token 顶天。
     *   ★ 这一套没配 AI，所以「没自动跑」的铁证是：
     *     屏上是**一颗按钮**，而不是一条「还没有配置 API」的错。
     *     真自动跑了的话，这一条当场红。
     */
    await overlay.click('[data-testid="dict-tab-ai"]')
    await overlay.waitForTimeout(400)
    assert.equal(
      await overlay.locator('[data-testid="dict-ai-go"]').count(),
      1,
      '★★ 外面这张卡上没有「问 AI」那颗按钮 —— 它多半自己跑了'
    )
    assert.equal(
      await overlay.locator('[data-testid="dict-ai-err"]').count(),
      0,
      '★★ 屏上是一条 AI 的错 —— 说明它**真的发车了**，而外面这条路不该发'
    )
    assert.equal(
      await overlay.locator('[data-testid="dict-ai-out"]').count(),
      0,
      '★ 没点就有答案？那它肯定自己跑了'
    )
  })

  it('★★★ ⑤ 标签点得动 —— 这个窗是 focusable:false 的', async () => {
    await overlay.click('[data-testid="dict-tab-dict"]')
    await overlay.waitForTimeout(500)
    assert.equal(
      await overlay.locator('[data-testid="dict-tab-dict"]').getAttribute('aria-selected'),
      'true',
      '★★ 浮窗里点不动标签 —— 不抢焦点的窗口里「点得动」是另一回事，不能拿主窗的结果推'
    )
    /** 切回去还在 —— 换档不重跑（省的是他的钱） */
    await overlay.click('[data-testid="dict-tab-ai"]')
    await overlay.waitForTimeout(300)
    assert.equal(
      await overlay.locator('[data-testid="dict-tab-ai"]').getAttribute('aria-selected'),
      'true'
    )
  })

  /**
   * ══ ⑦ 拖卡 ≠ 改卡的大小 ★★（使用者 2026-09-14 第三批第 1 条）══
   *
   * 他的原话：「当我拖着弹窗移动时，弹窗会莫名其妙变大。
   * 移动弹窗 ≠ 改变弹窗大小。」
   *
   * ── 为什么得同时盯两件事 ───────────────────────
   * 旧写法（每步把窗口自己的 bounds 读回来当基准）在 150% 缩放下实测是：
   *   **位移 0**（1 DIP = 1.5 物理像素，取整之后挪不动）
   *   **宽度 +60**（取整误差全被尺寸吃了，下一步读回来又叠一次）
   * 两个症状是同一个毛病的两张脸，所以这一条两件都断——
   * 只断尺寸的话，一个「根本拖不动」的版本也是绿的。
   *
   * ★ 宽容度给到 ±2：`getBounds()` 在分数缩放下读回来本身就会±1
   *   （同样传 420，x 不同读回可能是 420 也可能是 421）。
   *   真正的尺寸在物理像素里，那一层 2026-09-14 用 GetWindowRect 量过：
   *   630×780 → 630×780，一个数都没变。这里不再拉一个 PowerShell 进来，
   *   拿得到的那一层加容差就够拿住那个 +60。
   */
  it('★★★ ⑦ 拖卡：真的挪了，而且尺寸没变（使用者 2026-09-14）', async () => {
    const bounds = async (): Promise<{ x: number; y: number; width: number; height: number }> =>
      (await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('overlay=')
        )
        return w?.getBounds()
      })) as { x: number; y: number; width: number; height: number }

    /**
     * ★★ 先把卡挪到**左边有富余**的地方，再开始拖。
     *
     * ── 为什么非加这一步不可（2026-09-15 撞到）────────────────
     * 这一条曾经**跟他鼠标停在哪有关**：同一份代码绿了三趟、红了一趟。
     * 算一遍就清楚 —— 注入的那次「选中」没有矩形（`NYX_GLANCE_FAKE` 只给一串字），
     * 于是 `showLookup` 退回鼠标位置：卡的 x = 光标 x + `GAP`(18)，
     * 再被夹进可用区 `x ≤ 工作区宽 − W`（这台机器 1707 − 420 = 1287）。
     * 要让它真走够 55，就得 `光标 x ≤ 1214` —— 他鼠标往屏幕右边那 29% 一停，
     * 卡开局就贴着右边界，送进去 60 也只能原地不动，断言当场红。
     *
     * ★ y 也一样，而且更阴：卡贴着屏幕下沿时 `moveLookup` 的下边界会把它
     *   往上顶几像素，于是「只送了横向位移」这一条断在 y 上。
     *   → 起点钉到左上角那一带，两道夹边都够不着，剩下的才是真的位移。
     *
     * ☞ **判据不许依赖「他鼠标碰巧在哪」。** 这一步把起点钉死，
     *   断言一个字没放松（还是「挪够 55 且尺寸不变」），只是不再看运气。
     * ★ 钉的是**起点**，不是位移：`moveLookup` 那条路一步没绕开 ——
     *   `dragFrom` 照旧在 `first` 那一下自己读 `getBounds()`。
     *   旧写法（每步读回来当基准）在 150% 缩放下照样是「位移 0 / 宽度 +60」，
     *   这一条该红还是红。
     */
    await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().includes('overlay=')
      )
      if (!w) return
      const b = w.getBounds()
      const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
      /**
       * ★★ **只送 x / y，一个字都不提尺寸**（`setBounds` 收部分矩形）。
       *   第一版这里写的是 `{ ...b, x: ... }` —— 把 `getBounds()` 读回来的
       *   `height` 又原样送了回去，而读回来那个数在 150% 缩放下是涨过的
       *   （实测 520 的窗读回来 **521**）。于是窗真的变成 521，下一次再读
       *   就是 522…… 这一步自己制造了「拖一下就变大」，正是这条用例要抓的病。
       *   ☞ 和上面正文里那条是同一句话：**读回来的数不许再送回去。**
       */
      w.setBounds({ x: area.x + 40, y: area.y + 40 })
    })
    await overlay.waitForTimeout(200)

    const a = await bounds()
    /**
     * ★ 送的是**累计位移**（和 `DictCard.svelte` 里一样），
     *   第一步带 `first = true` 告诉主进程「就从现在这个位置算起」。
     */
    for (let i = 1; i <= 60; i++) {
      await overlay.evaluate((n) => window.nyx.overlay.moveBy(n, 0, n === 1), i)
    }
    await overlay.waitForTimeout(400)
    const b = await bounds()

    assert.ok(
      Math.abs(b.width - a.width) <= 2 && Math.abs(b.height - a.height) <= 2,
      `★★ 拖着拖着就变大了：${a.width}×${a.height} → ${b.width}×${b.height}` +
        '（旧写法在 150% 缩放下每一步肿 1，60 步就是 60）'
    )
    assert.ok(
      b.x - a.x >= 55,
      `★★ 根本没挪：送进去 60，实际只走了 ${b.x - a.x}` +
        '（旧写法在 150% 缩放下是 0 —— 位移被取整抹掉了）'
    )
    assert.equal(b.y, a.y, '只送了横向位移，y 不该动')
  })
})
