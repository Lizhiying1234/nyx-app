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
 * 版式验收 · I-066
 *
 * **为什么单独有这一套。**
 * 原来那几套断言的是「元素存在吗 / 文字对吗 / 数据落库了吗」——
 * 它们**看不见布局**。侧边栏底部被顶出屏幕、⋮ 被长名字挤走、标题栏滚没了，
 * 在那些验收里全都是绿的。使用者为侧边栏这一条提了三次，我改了三次都没对，
 * 因为我每次都只跑了那套「看不见」的验收就说做完了。
 *
 * 所以这里断言的是**几何**：谁在窗口里、谁能滚、谁固定不动。
 * 配套还有 `npm run shot`（出一张 PNG 用眼睛看）——
 * 两者一起才叫「改完界面验过了」。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-layout-'))

let app: ElectronApplication
let page: Page

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')

  // 造一棵**必然溢出**的树：10 个项目，每个 3 单元 × 3 讲
  await page.evaluate(async () => {
    for (let i = 1; i <= 25; i++) {
      const p = await window.nyx.data.createProject(
        `项目 ${i} 这个名字故意写得很长很长很长很长很长`
      )
      // 一个单元一讲就够 —— 25 个项目折叠起来已经必然溢出，
      // 不依赖「点开」这个动作，验收才稳
      const uid = await window.nyx.data.createUnit(p, '第 1 单元')
      await window.nyx.data.createLecture(uid, 'L1')
    }
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('[data-testid="project-area"]')
  await page.waitForTimeout(400)
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

describe('I-066 · 侧边栏三段固定（他说了三次，前两次我改错了地方）', () => {
  it('★ 项目区真的在滚 —— 不是把整条撑高', async () => {
    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="project-area"]') as HTMLElement
      return { scroll: el.scrollHeight, client: el.clientHeight }
    })
    assert.ok(
      m.scroll > m.client,
      `项目区没有溢出（内容 ${m.scroll} / 可视 ${m.client}）—— 那它就不是一块独立滚动的区域`
    )
  })

  it('★ 底部那几行始终在窗口里 —— 项目再多也顶不掉', async () => {
    const r = await page.evaluate(() => {
      const trash = document.querySelector('[data-testid="nav-trash"]') as HTMLElement
      const b = trash.getBoundingClientRect()
      return { bottom: b.bottom, top: b.top, win: window.innerHeight }
    })
    assert.ok(
      r.bottom <= r.win + 1 && r.top >= 0,
      `垃圾箱那一行跑到窗口外了（top ${r.top} / bottom ${r.bottom} / 窗口 ${r.win}）`
    )
  })

  it('★ 名字再长，⋮ 也固定在行尾（I-056 那一次没修对）', async () => {
    const r = await page.evaluate(() => {
      const row = document.querySelector('[data-testid^="nav-toggle-project-"]') as HTMLElement
      // `.add:last-of-type` 选的是「最后一个 span」，而那是折叠箭头 .car，
      // 不是 ⋮ —— 一开始就写错了。直接取最后一个 .add
      const all = row.querySelectorAll('.add')
      const dots = all[all.length - 1] as HTMLElement
      const rr = row.getBoundingClientRect()
      const dr = dots.getBoundingClientRect()
      return { rowRight: rr.right, dotsRight: dr.right, dotsWidth: dr.width }
    })
    assert.ok(r.dotsWidth > 0, '⋮ 宽度是 0 —— 等于不存在')
    assert.ok(
      r.dotsRight <= r.rowRight + 1,
      `⋮ 被挤出了行外（图标右沿 ${r.dotsRight} / 行右沿 ${r.rowRight}）`
    )
  })

  it('★ 标题栏固定在顶上，不跟着滚（I-067）', async () => {
    const before = await page.evaluate(
      () => document.querySelector('.titlebar')!.getBoundingClientRect().top
    )
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(300)
    const after = await page.evaluate(
      () => document.querySelector('.titlebar')!.getBoundingClientRect().top
    )
    assert.equal(after, before, `滚了一下标题栏就动了（${before} → ${after}）`)
  })

  /**
   * ★ I-076 · 按下去要有反应
   *
   * 这一条**必须量，不能看**。1px 的下沉肉眼在截图上分辨不出来，
   * 而「写了 CSS」和「CSS 真的生效」是两件事 —— 上一轮我就只做到了前一件。
   * 总原型原本一条 `:active` 都没有：鼠标停上去有变化、真按下去反而毫无动静，
   * 于是「像点空了」。
   */
  it('★ 按下按钮时真的有位移或变色（I-076）', async () => {
    await page.click('[data-testid="nav-home"]')
    /**
     * ★ 2026-09-09（SC-02）· 这里原来取 `.btn.pri` 的第一颗。
     *   IX-16 落地之后首页**只剩一颗 Primary**，而它在「今天没有到期」时是 disabled——
     *   浏览器不给 disabled 派 hover / active，于是这一条量的是一个**按不动**的东西。
     *   旧版首页有三颗 pri，`.first()` 正好落在 AI 引导里那颗能按的上面，一直是碰巧绿的。
     *   ★ 判据一个字没改（**按下去要有反馈**），改的是「按哪一颗」：第一颗按得动的。
     */
    const btn = page.locator('.btn:not([disabled])').first()
    await btn.waitFor({ timeout: 8000 })

    const read = (): Promise<{ top: number; bg: string }> =>
      btn.evaluate((e) => ({
        top: e.getBoundingClientRect().top,
        bg: getComputedStyle(e).backgroundColor
      }))

    const box = (await btn.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(250)
    const hover = await read()

    // 关键：按住**不松手**再读。松开就回弹了，什么都测不到
    await page.mouse.down()
    await page.waitForTimeout(250)
    const active = await read()
    await page.mouse.up()

    assert.ok(
      Math.abs(active.top - hover.top) >= 0.5 || active.bg !== hover.bg,
      `按下去和悬停一模一样（top ${hover.top}→${active.top}，底色 ${hover.bg}→${active.bg}）` +
        ' —— :active 没生效，点了没反馈'
    )
  })

  /**
   * ★ 上面那条撞出来的洞：**禁用的按钮原来和能按的长得一模一样**（全库没有一条
   * `:disabled` 规则）。直接量「摘掉 disabled 前后是不是同一个样子」，
   * 不写死任何颜色值 —— 写死一份颜色名单，换了令牌它照样绿。
   */
  it('★ 禁用的按钮看得出按不动（U-015）', async () => {
    await page.click('[data-testid="nav-home"]')
    const dis = page.locator('.btn[disabled]').first()
    if ((await dis.count()) === 0) {
      // 有到期内容的机器上首页那颗是能按的 —— 这条不适用，不假装验过
      return
    }
    /**
     * ★ 不用「摘掉 disabled 再读一次」—— 同一个元素、同一个任务里重读，
     *   getComputedStyle 拿到的还是旧值（2026-09-09 真撞上了：两次读出来一模一样）。
     *   改成**往旁边插一颗同档、没被禁用的探针**：新元素的样式是现算的，
     *   没有缓存这回事。
     */
    const s = await dis.evaluate((e) => {
      const look = (el: Element): string => {
        const c = getComputedStyle(el)
        return c.backgroundColor + ' / ' + c.color
      }
      const probe = document.createElement('button')
      probe.className = e.className
      probe.textContent = '探针'
      e.parentElement?.appendChild(probe)
      const on = look(probe)
      const off = look(e)
      probe.remove()
      return { off, on }
    })
    assert.notEqual(s.off, s.on, `★ 禁用与可按长得一模一样（${s.off}）—— 看不出按不动`)
  })

  /**
   * 守的是总原型 global.css 第 13 行那条全局 `:focus-visible`。
   * 我一度在 enhancements.css 里按选择器又抄了一遍 —— 把那一块删掉，这条照样绿，
   * 于是知道抄的那份根本没起作用，删了。测试的价值就在这种时候。
   */
  it('★ 键盘 Tab 过去看得出停在哪（I-076）', async () => {
    await page.click('[data-testid="nav-home"]')
    const outline = await page.evaluate(() => {
      const el = document.querySelector('.btn.pri') as HTMLElement | null
      if (!el) return null
      el.focus()
      // 用键盘走一步，:focus-visible 才会亮 —— 鼠标点击不该留下框
      return getComputedStyle(el).outlineWidth
    })
    // focus() 本身不一定触发 focus-visible，所以真按一次 Tab
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    const after = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const cs = getComputedStyle(el)
      return { tag: el.tagName, width: cs.outlineWidth, style: cs.outlineStyle }
    })
    assert.ok(
      parseFloat(after.width) > 0 && after.style !== 'none',
      `键盘走到 ${after.tag} 时没有焦点框（outline ${after.width} / ${after.style}，之前 ${outline}）`
    )
  })

  /**
   * ★★ Today 的功能区跟页面底色分得出来（使用者 2026-09-09）。
   *
   * 他的原话：「功能区之间缺乏区分度、功能区和页面底色几乎一样、
   * 没有明显边界、缺少颜色样式区分，看起来混在一起」。
   * 改之前量到的就是**字面的那回事**：.tmain / 副列两块的
   * background 全是 rgba(0, 0, 0, 0)、border-width 全是 0 ——
   * 整屏唯一有边框的是最不要紧的那条报告横条。
   *
   * ★ **不写死任何颜色值** —— 写死一份名单，换了令牌它就假红；
   *   只问三件事：面不是透明的 · 面和页面底色不是同一个 · 有一圈非零的边。
   * ★ 这三问都是**从屏上量的**，不是从样式表推的——
   *   拿 CSS 文本当判据的话，规则写在那儿但被后面一条盖掉，它照样绿。
   */
  it('★★ Today 的功能区和页面底色分得出来（使用者 2026-09-09）', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="today-card"]')
    await page.waitForTimeout(200)

    type Zone = { bg: string; bw: number } | null
    const m: { ground: string; main: Zone; hero: Zone; hard: Zone } = await page.evaluate(() => {
      const look = (sel: string): { bg: string; bw: number } | null => {
        const e = document.querySelector(sel)
        if (!e) return null
        const c = getComputedStyle(e)
        const bw =
          parseFloat(c.borderTopWidth || '0') +
          parseFloat(c.borderRightWidth || '0') +
          parseFloat(c.borderBottomWidth || '0') +
          parseFloat(c.borderLeftWidth || '0')
        return { bg: c.backgroundColor, bw }
      }
      return {
        ground: getComputedStyle(document.body).backgroundColor,
        main: look('.tmain'),
        hero: look('.thero'),
        hard: look('[data-testid="hard-card"]')
      }
    })

    const cases: Array<[string, Zone, boolean]> = [
      ['主角面板 .tmain', m.main, true],
      ['答案带 .thero', m.hero, true],
      ['攻坚区 hard-card', m.hard, true]
    ]
    for (const [name, z, needBorder] of cases) {
      assert.ok(z, `★ Today 上找不到「${name}」`)
      assert.notEqual(
        z!.bg,
        'rgba(0, 0, 0, 0)',
        `★★「${name}」是透明的 —— 它就直接长在页面底色上`
      )
      assert.notEqual(
        z!.bg,
        m.ground,
        `★★「${name}」和页面底色是同一个（${z!.bg}）—— “几乎一样”`
      )
      if (needBorder) {
        assert.ok(
          z!.bw > 0,
          `★★「${name}」一圈边都没有（border-width 合计 ${z!.bw}）—— “没有明显边界”`
        )
      }
    }

    // 主角和副列不能是同一副长相：主次得看得出来（他的「区分度」）
    assert.notEqual(
      m.main!.bg + '|' + m.main!.bw,
      m.hero!.bg + '|' + m.hero!.bw,
      '★ 主角面板和它顶上那条答案带长得一模一样 —— 那条带就没在分区'
    )
  })
})
