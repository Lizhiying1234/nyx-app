import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'

/**
 * ★★★ Point 的 OCR 兜底 · 他拖了一下，屏上**必须有东西回应他**（I-177）
 *
 * ══ 他报的是什么 ══════════════════════════════════════════════
 * 「Windows 端 Assist 的 Point 在原神中……无法正常点击 / 选中界面中的词汇。」
 * 2026-09-14 在他机器上正在跑的真原神里量到，那条路断在两处，各自单独就够：
 *   ① 原神主进程跑在 **SYSTEM 完整性**（反作弊），Nyx 是 Medium ——
 *      `AutomationElement.FromPoint` 不是返回空，是直接抛 `Access is denied`。
 *   ② 就算过得去也没东西可读：顶层是个光秃秃的 `UnityWndClass`，
 *      RAW 视图下**零个子节点**，全树没有 `TextPattern`。
 *
 * ══ 这一套钉的**不是**「OCR 准不准」★★★ ═════════════════════
 * 认得准不准是 `Windows.Media.Ocr` 的事，钉不住也不该我钉。
 * 这一套钉的是**那条路会不会又变哑**：
 *   在这次修之前，助手其实**报了一行**（`{"why":"no-element"}`），
 *   而 `parseSelectLine` 因为它没有 `sel` 字段返回 `null`，
 *   `select.ts` 直接跳过 —— 屏上没卡、日志没有、连 `onNote` 都不调用。
 *   ☞ **功能没坏，是坏了不说。** 他看到的「点不了」就是这个。
 *   一个无声的失败会原样再长回来，而且下一次照样没人发现 —— 所以钉在这里。
 *
 * ══ 为什么走注入点，而不是真的去拖一下 ════════════════════════
 * 上游自动化**做不到**，这是量过的，不是懒：原神跑在 SYSTEM 完整性上，
 * UIPI 把合成输入整个挡在外面 —— 2026-09-14 实测，`SetCursorPos` 期间
 * 光标纹丝不动、`GetAsyncKeyState(LBUTTON)` 全程 False。
 * 所以真游戏那一半只能**他本人拖**（验收截图），而下游这一半
 * 走 `NYX_POINT_FAKE`：它喂的是**助手吐的那一行原文**，
 * 于是 `parseSelectLine → pickOcrRun → judgePoint → 那张卡` 全是真的跑一遍。
 * ★ 和 `NYX_FAULT` / `NYX_GLANCE_FAKE` 同一道锁：**打包产物里恒不成立**。
 *
 * ★ 喂进去的词框是真数：2026-09-14 在真原神里量到的
 *   （`fracturing`，屏幕物理像素 1524,1163 151×31），锚点是真实光标 1533,1169。
 *
 * ══ 负向对照 ══════════════════════════════════════════════════
 * 把 `core/glance.ts` 的 `parseSelectLine` 里那个 `o.ocr === true` 分支删掉
 * （＝退回修之前那条路）→ ①②③ 三条当场红，报的就是「屏上什么都没有」。
 *
 * ★ 数据全在临时目录（NYX_DATA_ROOT）—— 一个字节都不碰他的真库。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-point-ocr-'))

/** 真原神里量到的那个词框 + 真实光标位置 */
const OCR_LINE =
  '{"ocr":true,"proc":"genshinimpact","ax":1533,"ay":1169,"bx":1560,"by":1169,' +
  '"words":[{"t":"fracturing","x":1524,"y":1163,"w":151,"h":31}],"done":true}'
/** 同一条路，但 OCR 一个词都没认出来 —— 这是「说出来」那一档 */
const EMPTY_LINE =
  '{"ocr":true,"proc":"genshinimpact","ax":900,"ay":400,"bx":1100,"by":400,"words":[],"done":true}'
/**
 * ★★ 拖动**途中**那一行（乙，使用者 2026-09-14 裁）：同样的词框，但**没有 `done`**。
 *   它只该画高亮 —— 不许查词、不许弹卡。不拦的话一次拖动会连着弹几十张卡，
 *   而且每一张都真打一次词典 / AI。
 */
const LIVE_LINE =
  '{"ocr":true,"proc":"genshinimpact","ax":1533,"ay":1169,"bx":1560,"by":1169,' +
  '"words":[{"t":"fracturing","x":1524,"y":1163,"w":151,"h":31}]}'
/** 拖动途中、而且一个词都没挑出来 —— 也不许弹「这里没读到文字」那张卡 */
const LIVE_EMPTY_LINE =
  '{"ocr":true,"proc":"genshinimpact","ax":900,"ay":400,"bx":1100,"by":400,"words":[]}'

/**
 * 同一条路，但来源是**出厂黑名单里的密码管理器**。
 * ★ 这一档字是**读到了的**，是判据不给 —— 卡上那句话必须说真正的原因。
 */
const BLOCKED_LINE =
  '{"ocr":true,"proc":"1password","ax":1533,"ay":1169,"bx":1560,"by":1169,' +
  '"words":[{"t":"fracturing","x":1524,"y":1163,"w":151,"h":31}],"done":true}'

let app: ElectronApplication
let overlay: Page | undefined

/** 等那个浮窗出现（认 overlay 的判据和 `overlay.test.ts` 一致：没有主窗的导航）*/
async function waitOverlay(main: Page, sel: string): Promise<Page | undefined> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (!(await w.locator(sel).count())) continue
      const isOverlay = await w.evaluate(() => !document.querySelector('[data-testid="nav-files"]'))
      if (isOverlay) return w
    }
    await main.waitForTimeout(400)
  }
  return undefined
}

async function launch(fake: string): Promise<Page> {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1', NYX_POINT_FAKE: fake }
  })
  const main = await mainWindow(app)
  await main.waitForLoadState('domcontentloaded')
  /** ★ Point 那一档 —— 注入点在 `applyPoint` 起了助手之后才发车 */
  await main.evaluate(() => window.nyx.glance.set('point', ''))
  return main
}

describe('★★★ Point · 认出来的那一段（I-177）', () => {
  before(async () => {
    const main = await launch(OCR_LINE)
    overlay = await waitOverlay(main, '[data-testid="dict-card"]')
    if (overlay) await overlay.waitForTimeout(600)
  })
  after(async () => {
    await app?.close()
  })

  it('★★★ ① 拖过一段认出来的字 → 卡真的出来了（这一条红 = 那条路又变哑了）', () => {
    assert.ok(
      overlay,
      '★★ 喂了一行真原神量到的 OCR 结果，浮窗却没起来 —— ' +
        '他拖一下屏上什么都不发生，正是 I-177 报的那件事'
    )
  })

  it('★★★ ② 卡上查的就是光标底下那个词', async () => {
    assert.ok(overlay)
    const t = await overlay.locator('[data-testid="dict-card"]').innerText()
    assert.ok(
      t.includes('fracturing'),
      '★ 卡上没有 fracturing —— 取词那一段挑错了：卡上是「' + t.slice(0, 60) + '」'
    )
  })

  it('★★★ ③ D-395：认出来的必须标「可能有误」', async () => {
    assert.ok(overlay)
    assert.equal(
      await overlay.locator('[data-testid="overlay-ocr"]').count(),
      1,
      '★★★ 没有那条标记。D-304 说得很直白：错的 term 会**静默污染知识库** —— ' +
        '同步回来以后它看起来和真的一模一样，没有任何环节会报错。这条标记是唯一的防线'
    )
    const mark = await overlay.locator('[data-testid="overlay-ocr"]').innerText()
    assert.ok(mark.includes('可能有误'), '★ 标记在，但没说「可能有误」：' + mark)
  })

  it('★ ④ 标记在卡**外面**（它说的是这串字怎么来的，不是释义的一部分）', async () => {
    assert.ok(overlay)
    const inside = await overlay
      .locator('[data-testid="dict-card"] [data-testid="overlay-ocr"]')
      .count()
    assert.equal(inside, 0, '★ 标记跑进卡里去了 —— 他会以为「可能有误」是词典给的释义')
  })

  /**
   * ══ ⑤ 这一条是**截图抓出来的**，不是设计出来的 ★★★ ════════════
   *
   * 上面 ③ 只数了一句 `count() === 1` —— 而第一版跑出来它**就是 1**，
   * 三条全绿。可是截图上一个像素都看不见：
   * `.dcw.fill` 是 `position:absolute; inset:0`，整张卡盖住了标记。
   * ☞ **「DOM 里有」不等于「他看得见」。** 数得到的断言挡不住这一类。
   *
   * 所以这里量的是两个真盒子：标记必须有面积，而且**和卡不重叠**。
   * 这条断言不依赖任何 CSS 写法 —— 换布局、换实现都还成立。
   */
  it('★★★ ⑤ 那条标记**真的看得见**（不是被卡盖住的）', async () => {
    assert.ok(overlay)
    const m = await overlay.evaluate(() => {
      const r = (s: string): DOMRect | null =>
        document.querySelector(s)?.getBoundingClientRect() ?? null
      return {
        mark: r('[data-testid="overlay-ocr"]'),
        card: r('[data-testid="dict-card"]'),
        vp: { w: innerWidth, h: innerHeight }
      }
    })
    assert.ok(m.mark && m.card, '★ 量不到标记或卡')
    assert.ok(
      m.mark.width > 0 && m.mark.height > 0,
      `★★ 标记是个 0 尺寸的盒子（${m.mark.width}×${m.mark.height}）—— 等于没有`
    )
    const overlap =
      m.mark.left < m.card.right &&
      m.mark.right > m.card.left &&
      m.mark.top < m.card.bottom &&
      m.mark.bottom > m.card.top
    assert.ok(
      !overlap,
      '★★★ 标记被卡压住了 —— DOM 里在、用例数得到、屏幕上看不见。' +
        ` 标记 top=${Math.round(m.mark.top)} bottom=${Math.round(m.mark.bottom)}，` +
        ` 卡 top=${Math.round(m.card.top)} bottom=${Math.round(m.card.bottom)}`
    )
    /** ★ 标记和卡之间不许有缝：缝是透明的，却照样吃鼠标（同 overlay.test.ts ③）*/
    assert.ok(
      Math.abs(m.card.top - m.mark.bottom) <= 1,
      `★★ 标记和卡之间有 ${Math.round(m.card.top - m.mark.bottom)}px 的缝 ——` +
        ' 那一条是透明的，但他点上去卡会关掉，而他以为点的是底下那个程序'
    )
    /** ★ 两块加起来要铺满窗，理由同上 */
    assert.ok(
      Math.abs(m.mark.top) <= 1 && Math.abs(m.card.bottom - m.vp.h) <= 1,
      `★★ 标记 ＋ 卡没铺满浮窗：${Math.round(m.mark.top)} .. ${Math.round(m.card.bottom)}` +
        ` vs 窗高 ${m.vp.h}`
    )
  })
})

describe('★★★ Point · 一个字都没认出来的时候（I-177）', () => {
  before(async () => {
    const main = await launch(EMPTY_LINE)
    overlay = await waitOverlay(main, '[data-testid="overlay-none"]')
    if (overlay) await overlay.waitForTimeout(400)
  })
  after(async () => {
    await app?.close()
  })

  it('★★★ ⑤ 什么都没读到 —— 也要有一张卡说出来，绝不无声', () => {
    assert.ok(
      overlay,
      '★★★ 这一条就是 I-177 的病根：他拖了一下，屏上、日志上什么都没有，' +
        '于是「Nyx 坏了」和「这儿确实没字」在他眼里长得一模一样'
    )
  })

  it('★★ ⑥ 那句话说的是人话', async () => {
    assert.ok(overlay)
    const t = await overlay.locator('[data-testid="overlay-none"]').innerText()
    assert.ok(t.includes('这里没读到文字'), '★ 卡出来了但话没说对：' + t)
  })

  it('★★ ⑦ 没有词就**不摆**查词卡（一张空的查词卡比没有更糟）', async () => {
    assert.ok(overlay)
    assert.equal(await overlay.locator('[data-testid="dict-card"]').count(), 0)
  })

  /**
   * ★★★ ⑧ 也是截图抓出来的。第一版这张卡是 `max-width:320px` 的一小块，
   *   坐在 420×520 的窗里 —— 窗里剩下一大片**透明、看不见、却照样吃鼠标**的地方。
   *   他点那儿以为点的是底下那个程序，实际上点的是 Nyx 的窗。
   *   和 `overlay.test.ts` ③ 钉的是同一件事，只是这张新卡差点又犯一次。
   */
  it('★★ ⑨ 那两档话不一样：一个字都没认出来 vs 认出来了但离得远', async () => {
    assert.ok(overlay)
    const t = await overlay.locator('[data-testid="overlay-none"]').innerText()
    assert.ok(
      t.includes('画出来的'),
      '★ 一个词都没认出来那一档，第二行该说「这一块是画出来的」：' + t
    )
  })

  it('★★★ ⑧ 那张卡铺满了窗 —— 不留吃鼠标的透明死区', async () => {
    assert.ok(overlay)
    const m = await overlay.evaluate(() => {
      const b = document.querySelector('[data-testid="overlay-none"]')?.getBoundingClientRect()
      return {
        card: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
        vp: { w: innerWidth, h: innerHeight }
      }
    })
    assert.ok(m.card, '★ 量不到那张卡')
    assert.ok(
      Math.abs(m.card.w - m.vp.w) <= 1 && Math.abs(m.card.h - m.vp.h) <= 1,
      `★★★ 卡没铺满浮窗：卡 ${Math.round(m.card.w)}×${Math.round(m.card.h)}` +
        ` vs 窗 ${m.vp.w}×${m.vp.h} —— 差出来的那一圈是透明的，但照样吃他的点击`
    )
  })
})

/**
 * ★★★ 黑名单挡掉的那一档 —— 卡上不许说假话（I-177）
 *
 * 这一下**字是读到了的**（OCR 认出了 `fracturing`），是判据不给：
 * `1password` 在出厂黑名单里。此时说「这里没读到文字」就是**假话**，
 * 而假话比不说更糟 —— 他会一直换地方拖，永远不知道那个程序被自己拉黑了。
 * ★ 这一条也顺带钉住：**认出来的那一路和真文字那一路走同一份名单**。
 */
describe('★★★ Point · 黑名单里的程序：认出来的也不给，而且说真正的原因', () => {
  before(async () => {
    const main = await launch(BLOCKED_LINE)
    overlay = await waitOverlay(main, '[data-testid="overlay-none"]')
    if (overlay) await overlay.waitForTimeout(400)
  })
  after(async () => {
    await app?.close()
    rmSync(dataRoot, { recursive: true, force: true })
  })

  it('★★★ ⑩ 不查它 —— 一张查词卡都不许出现', async () => {
    assert.ok(overlay, '★ 连「说一声」的卡都没有 —— 又变哑了')
    assert.equal(
      await overlay.locator('[data-testid="dict-card"]').count(),
      0,
      '★★★ 黑名单里的程序被查了 —— 认出来的那一路绕过了那份名单'
    )
  })

  it('★★★ ⑪ 卡上说的是**真正的原因**，不是「这里没读到文字」', async () => {
    assert.ok(overlay)
    const t = await overlay.locator('[data-testid="overlay-none"]').innerText()
    assert.ok(
      t.includes('1password') && t.includes('不抓的名单'),
      '★★★ 没说真正的原因。字是读到了的，是我们不给 —— ' +
        '说成「没读到」他会一直换地方拖，永远不知道那个程序被自己拉黑了。卡上是：' + t
    )
    assert.ok(
      !t.includes('这里没读到文字'),
      '★★★ 说了假话：字读到了，卡上却说没读到。卡上是：' + t
    )
  })
})

/**
 * ★★★ 乙 · 拖动途中只画高亮，**不查词**（使用者 2026-09-14 裁「按照乙」）
 *
 * 乙 的形状：起手截一次给高亮、松手再截一次给答案。于是助手在**一次拖动里**
 * 会吐很多行 —— 只有最后那一行带 `done`。
 * 这一套钉的是：没有 `done` 的那些行**一张卡都不许弹**。
 * ☞ 不拦的话，他从左拖到右会连着弹几十张卡，每一张都真打一次词典 / AI ——
 *   屏幕上是一串闪烁，账单上是几十次调用。
 */
describe('★★★ Point · 乙：拖动途中不查词（I-177）', () => {
  before(async () => {
    /** 先喂两行「拖动中」，最后**不**喂 done —— 屏上应该什么卡都没有 */
    const main = await launch([LIVE_LINE, LIVE_EMPTY_LINE].join(''))
    /** 给它足够时间：如果会弹，早就弹了 */
    await main.waitForTimeout(4000)
    overlay = undefined
    for (const w of app.windows()) {
      const card = await w.locator('[data-testid="dict-card"]').count()
      const none = await w.locator('[data-testid="overlay-none"]').count()
      if (!card && !none) continue
      if (await w.evaluate(() => !document.querySelector('[data-testid="nav-files"]'))) overlay = w
    }
  })
  after(async () => {
    await app?.close()
    rmSync(dataRoot, { recursive: true, force: true })
  })

  it('★★★ ⑫ 没有 `done` 的行：一张卡都不许出现', () => {
    assert.equal(
      overlay,
      undefined,
      '★★★ 拖动途中就弹卡了 —— 他从左拖到右会连着弹几十张，每张都真打一次词典 / AI'
    )
  })
})

/**
 * ★★★ 选中之后**不许自己消失**（使用者 2026-09-15）
 *
 * 他的原话：**「我不要拖一下就消失的那种效果」**。
 * 上一版松手那一刻就把高亮擦了（`onPick` 后面跟着一句 `onMarks([])`，
 * 当时我还写了句注释替它辩护：「卡已经在那段字下面了，两个东西不必同时说同一件事」）——
 * 于是他刚选中的那几个词，在他看清之前就没了。
 *
 * Android 那边选区与卡的寿命和手势**彻底解耦**：全文件没有一个自动消失的定时器，
 * 结束只由四种**他自己做的**动作触发。这一套钉的就是「留得住」。
 * ☞ 这一条红 = 那个「一拖就没」的毛病回来了。
 */
describe('★★★ Point · 选中之后留得住（I-177 · 使用者 2026-09-15）', () => {
  before(async () => {
    const main = await launch(OCR_LINE)
    overlay = await waitOverlay(main, '[data-testid="dict-card"]')
    /** ★ 等足够久 —— 如果有哪个定时器会来收它，这段时间里早该收了 */
    if (overlay) await overlay.waitForTimeout(3500)
  })
  after(async () => {
    await app?.close()
    rmSync(dataRoot, { recursive: true, force: true })
  })

  it('★★★ ⑬ 松手 3.5 秒之后，卡还在（没有任何定时器来收它）', async () => {
    assert.ok(overlay, '★★★ 卡自己没了 —— 这就是他说的「拖一下就消失」')
    assert.equal(
      await overlay.locator('[data-testid="dict-card"]').count(),
      1,
      '★★★ 卡在这 3.5 秒里消失了。他要的是它一直在，直到他自己收走'
    )
  })

  /**
   * ══ ⑭ 这一条**第一版是假绿的**，记在这儿 ★★★ ════════════════════
   *
   * 第一版数的是高亮层里 `marker-box` 这个 DOM 节点还在不在 —— 结果把
   * 「擦高亮」那句加回去做对照，**它照样绿**。实测量出来的原因：
   *   高亮窗 `visible=false`，而它 DOM 里那个框**还留着**（`hideMarks` 是
   *   先发空列表再 `hide()`，窗藏了、节点没清干净）。
   * ☞ 又一次「DOM 里有 ≠ 他看得见」，同一个坑这一轮踩了第二次。
   *
   * 所以这一版问的是**主进程**：那个高亮窗现在到底显不显示。
   * 这是他眼睛看到的那件事，换任何渲染写法都还成立。
   */
  it('★★★ ⑭ 高亮层**真的还显示着** —— 他刚选中的那几个词得一直看得见', async () => {
    const wins = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        url: w.webContents.getURL(),
        visible: w.isVisible()
      }))
    )
    const marker = wins.find((w) => w.url.includes('marker=1'))
    assert.ok(marker, '★ 连高亮层这个窗都没有')
    assert.equal(
      marker.visible,
      true,
      '★★★ 高亮层藏起来了 —— 松手就把他选中的词擦掉了，' +
        '正是他说的「我不要拖一下就消失的那种效果」。' +
        ' 所有窗：' + JSON.stringify(wins.map((w) => (w.url.split('?')[1] ?? 'main') + '=' + String(w.visible)))
    )
  })

  /**
   * ★★★ ⑮ **从 Point 切到 Glance，Point 的卡不许赖在屏上**（2026-09-15 撞到的）
   *
   * 选区和卡是同一件事的两半，屏上只许「都在」或「都没」。
   * `applyPoint(false)` 原来只 `destroyMarker()`：高亮销毁了而**卡还挂着**。
   *
   * ★★ 为什么切 **Glance** 而不是切 **off**（这一条我一开始写错了）：
   *   `off` 那一支后面跟着 `destroyOverlay()`，卡本来就会被销毁 ——
   *   拿 `off` 做用例，把修复回退掉它**照样绿**，因为它验的是别人保证的事。
   *   真正只由这条修复守着的是 **point → glance**：那一支只调 `applyPoint(false)`，
   *   没有 `destroyOverlay()`，卡就会留在屏上。
   * ☞ 教训和 ⑭ 是同一个：**用例要钉在只有这条修复能守住的那一格**，
   *   否则它绿得理直气壮，却什么都没看着。
   */
  it('★★★ ⑮ Point → Glance：Point 的卡和高亮一起走，不留半个', async () => {
    const snap = async (): Promise<{ url: string; visible: boolean }[]> =>
      app.evaluate(async ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({
          url: w.webContents.getURL(),
          visible: w.isVisible()
        }))
      )
    /**
     * ★★★ **先钉前提**：关之前卡必须是**显示着**的。
     *   不钉这一条，这一条用例会在「卡本来就没显示」的时候**空过** ——
     *   我把修复回退做对照时它照样绿，就是因为这个。
     *   一个能空过的用例不是用例。
     */
    const before = await snap()
    const cardBefore = before.find((w) => w.url.includes('overlay=1'))
    assert.ok(
      cardBefore && cardBefore.visible,
      '★★★ 前提就不成立：关 Point 之前卡本来就没显示，这一条根本没验到东西。' +
        ' 关之前所有窗：' + JSON.stringify(before.map((w) => (w.url.split('?')[1] ?? 'main') + '=' + String(w.visible)))
    )
    const main = await mainWindow(app)
    await main.evaluate(() => window.nyx.glance.set('glance', ''))
    await main.waitForTimeout(1500)
    const wins = await snap()
    const card = wins.find((w) => w.url.includes('overlay=1'))
    assert.ok(
      !card || !card.visible,
      '★★★ 切到 Glance 了，Point 那张卡还挂在屏上 —— 他再也关联不到任何东西。' +
        ' 所有窗：' + JSON.stringify(wins.map((w) => (w.url.split('?')[1] ?? 'main') + '=' + String(w.visible)))
    )
    const marker = wins.find((w) => w.url.includes('marker=1'))
    assert.ok(
      !marker || !marker.visible,
      '★★ Point 的高亮层也该没了（切走时是销毁不是藏）'
    )
  })
})
