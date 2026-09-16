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
 * M-3 · Settings 分层（使用者 2026-09-03「可以」）
 *
 * ══ 治的是什么病 ═══════════════════════════════════════════
 * `WINDOWS_SETTINGS_AUDIT.md` 的结论：Windows 的 Settings **没有多余功能**，
 * 病在**该分层的地方没分层** —— 8 个 Tab 平铺、约 80 个控件在同一个视觉平面上。
 * 而 §一·六 量到的病根是「**17 个各写各的展开开关、0 个共享组件**」。
 *
 * ══ 这一轮做了什么 ═════════════════════════════════════════
 * ① 复用**已经存在**的 `.fold-head`（词条详情/文件学习/项目页早在用），
 *    让 Settings 的二级块头也走同一套 —— **不新发明第四套**
 * ② 低频的收起来：体裁 · 题型 · 自定义朗读服务商 · 危险操作 · 我的水平
 * ③ 「我的水平」从**一级 Tab 降级**进 AI 页（Tab 8 → 7）
 *
 * ★ 判据不是「有个箭头」，是**默认进来时屏幕上的东西变少了，而功能一个没丢**。
 * ★ 负向对照：把某一项的默认值从 true 改成 false → 对应那条当场红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-fold-'))

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []

before(async () => {
  app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' } })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  /** ★ 页面引导会盖着整页（那正是它该做的）—— 不标的话下面每一条都点不到 */
  await page.click('[data-testid="nav-settings"]')
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

describe('M-3 · Settings 该分层的地方长出层级', () => {
  /**
   * ★ 2026-09-09 · 这一条原来数的是「7 个」。使用者当天加了「资源」Tab
   *   （「在 Settings 中增加一个与『数据』等同级的『资源』Tab」），数字回到 8，
   *   它当场红了 —— **红得对**：悄悄多一个一级 Tab 本来就该被拦一下。
   *
   * ★★ **8 是他裁过的，不是我们没管住。** 我把「M-3 当初正是嫌 8 太多才砍到 7」
   *   这件事当面提了，问要不要把「资源」并进「数据」当二级。他 2026-09-09 的原话：
   *     「加 8 个，之前是因为**功能重合或者我决定有些可以合并**，
   *       但是这一次它是**独立的特殊的功能**，所以加」
   *   —— 所以 M-3 那一轮砍的判据是「**重合的合并**」，不是「一级不许超过 7」。
   *   数字本来就不是判据，这也正是这条用例从数数字改成数名单的理由。
   *
   * ★ 但它守的**不是数字**。标题与第二句断言说的是「**我的水平不再占一级**」（M-3），
   *   7 只是那天 8 减 1 的结果。所以改成**数名单**，三样一起拿到：
   *     ① 「我的水平」没了 —— 原来那条判据一个字没弱
   *     ② 再多 / 再少一个照样当场红，下一个人仍然得当面做决定
   *     ③ 名单本身说清了「Settings 的一级到底有哪几项」，比一个 7 有用
   */
  it('★★ ① 一级 Tab 就是这几项 —— 「我的水平」不在其中（M-3）', async () => {
    const ids = await page.locator('[data-testid^="set-tab-"]').evaluateAll((els) =>
      els.map((e) => (e.getAttribute('data-testid') ?? '').replace('set-tab-', ''))
    )
    /**
     * ★ 2026-09-13 多了 `assist`：他这一批要的「Assist 功能对齐」
     *   （开关、划词、指到就查、黑名单、默认讲次）就长在那儿。
     *   D-397 定的是 **Assist 是独立设置模块**，所以它是一级，不是塞进别的页。
     * ★ 名单照旧写死 —— 这条用例的价值就在于「谁加了一颗 Tab，都得来这儿交代一次」。
     */
    assert.deepEqual(
      ids,
      ['ai', 'tutor', 'practice', 'tts', 'sync', 'dict', 'assist', 'data', 'res'],
      `一级 Tab 的名单变了：${ids.join(' / ')}`
    )
    assert.equal(
      await page.locator('[data-testid="set-tab-level"]').count(),
      0,
      '★ 「我的水平」那颗 Tab 应该已经没了'
    )
  })

  /**
   * ★★ Q-4（2026-09-03 · 使用者裁「移到报告里面」）之后，这条的意思变了。
   *
   * M-3 那一轮只是把它从一级 Tab 降进 AI 页的折叠区 —— 还在设置里。
   * Q-4 把它整块搬去了分析报告：设置回答「软件该怎么运转」，
   * 而水平评估回答「**我现在什么水平**」，那是一条结论，不是一个可调项。
   * 所以现在要验的是**两头**：设置里确实没有了，报告里确实有。
   */
  it('★★★ ② Q-4 · 设置里已经没有它了 —— 两个 Tab 都翻过', async () => {
    for (const tab of ['ai', 'tutor']) {
      await page.click(`[data-testid="set-tab-${tab}"]`)
      await page.waitForTimeout(250)
      assert.equal(
        await page.locator('[data-testid="fold-level"]').count(),
        0,
        `★ 「我的水平」还留在设置的 ${tab} 页里 —— Q-4 是整块搬走，不是搬一半`
      )
    }
  })

  /**
   * ★★ D-467（2026-09-07）· 原来这里还有一条「空库时首页直接够得着『我的水平』」。
   *
   * 使用者取消了「我的水平」整块（事实表单 + AI 评估 + 冷启动五道诊断题 + 历史），
   * 首页空态里那份也跟着删了。所以现在要验的是**两头都没有**，
   * 并且空态仍然给得出下一步 —— 删掉一块之后留下一个什么都不说的空页面，
   * 正是他这次点名不要的（D-469 同一句话）。
   */
  it('★★ ② 续 · 空库首页也没有它了，而空态照常给得出下一步', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="home-start"]', { timeout: 6000 })
    for (const gone of ['mylevel', 'fact-goal', 'fact-exams', 'run-assess', 'start-cold']) {
      assert.equal(
        await page.locator(`[data-testid="${gone}"]`).count(),
        0,
        `★ 「我的水平」的 ${gone} 还在首页上 —— D-467 是整块取消`
      )
    }
    assert.equal(
      await page.locator('[data-testid="home-start-btn"]').count(),
      1,
      '★ 空态连「开始」都没有了 —— 那就是删成了一个空页面'
    )
    await page.click('[data-testid="nav-settings"]')
    await page.waitForTimeout(300)
  })

  /**
   * ★★★ D-488（使用者 2026-09-15）· 这一条换了钉的东西，说清楚换成了什么：
   *
   * **原来钉**：体裁 / 题型默认收起、导师那块展开 —— 那是「折叠」形态下的期待。
   * **现在钉**：这一页**一个折叠都没有**，两级都是平级 Tab。
   *   他的原话：「看起来像父子关系、实际上是平级功能的布局」不许再出现，
   *   而折叠正是那种布局 —— 点一下才展开的东西，读起来就是「它属于上面那个」。
   * ★ 判据没放宽，反而更紧：除了「折叠不许回来」，还钉了**两个 Tab 不许同屏** ——
   *   同屏就等于又变回平铺四块，那是这一单要治的原样。
   */
  it('★★★ ③ Prompt 页：一个折叠都没有，两级都是横向 Tab（使用者 2026-09-15 第二轮）', async () => {
    await page.click('[data-testid="set-tab-tutor"]')
    await page.waitForSelector('[data-testid="prompt-nav"]')
    for (const gone of ['fold-genres', 'fold-qtypes']) {
      assert.equal(
        await page.locator(`[data-testid="${gone}"]`).count(),
        0,
        `★★★ D-488：「${gone}」这个折叠回来了 —— 折叠就是父子关系，而这两块是平级`
      )
    }

    /**
     * ★★ 形状：**两行横向 Tab**（使用者 2026-09-15「平级内容采用横向切换」「不要从侧面展开」）。
     *   一级两个（文件学习 ‖ 练习）· 二级两个（随一级变）。
     * ★ 钉「一级正好两个、且文字是他画的那两个」—— 多一个就是又造出了一层，
     *   而多造一层正是这一单从头到尾在治的病。
     */
    const lv1 = await page.locator('[data-testid="prompt-area"] button').allInnerTexts()
    assert.deepEqual(
      lv1.map((t) => t.trim()),
      ['文件学习', '练习'],
      '★★ 一级不对 —— 他画的树第一层就是这两个'
    )
    assert.equal(
      await page.locator('[data-testid="prompt-area"] button.on').count(),
      1,
      '★ 同时只该有一个一级选中'
    )
    assert.equal(
      await page.locator('[data-testid="prompt-nav"] button').count(),
      2,
      '★ 二级该是两个（随一级变）'
    )
    assert.equal(
      await page.locator('[data-testid="prompt-nav"] button.on').count(),
      1,
      '★ 同时只该有一个二级选中'
    )
    /** ★ 侧树那一版的痕迹不许留下（他明说不要侧边展开）*/
    for (const gone of ['.pnav', '.pnav-g', '.pnav-i', '.prow']) {
      assert.equal(
        await page.locator(gone).count(),
        0,
        `★★ 侧边布局的「${gone}」还在 —— 他点名不要从侧面展开`
      )
    }

    /** 两级切换互不同屏 */
    await page.waitForSelector('[data-testid="mode-genre"]')
    assert.equal(
      await page.locator('[data-testid="tutor-note"]').count(),
      0,
      '★★ 体裁和 AI 导师同屏了 —— 那就不是平级选择，是又平铺回去了'
    )
    await page.click('[data-testid="ptab-tutor"]')
    await page.waitForSelector('[data-testid="tutor-note"]')
    assert.equal(await page.locator('[data-testid="genre-chips"]').count(), 0, '★★ 切走之后体裁还在屏上')

    /** ★ 跨组也是**一下** —— 原来要先点区再点 Tab */
    await page.click('[data-testid="parea-drill"]')
    await page.click('[data-testid="ptab-reading"]')
    await page.waitForSelector('[data-testid="mode-reading"]')
    assert.equal(
      await page.locator('[data-testid="mode-practice"]').count(),
      0,
      '★★ 认读和产出同屏了 —— 他要的是两个平级选项'
    )
    await page.click('[data-testid="ptab-produce"]')
    await page.waitForSelector('[data-testid="qtype-list"]')
    assert.equal(await page.locator('[data-testid="mode-reading"]').count(), 0, '★★ 切走之后认读还在屏上')
  })

  /**
   * ★★★ 层级：一级 > 二级 > 三级（使用者 2026-09-15 原话「层级越低，视觉权重应该越低」）
   *
   * ══ 为什么量**三个**数，而不是只量字号 ══════════════════
   * 他报「三级反而比二级更突出」时，实测是这样：
   *     二级 认读测试 14px / 600 / 明度 0.159
   *     三级 牌面    14px / 600 / 明度 **0.038**
   * **字号和字重完全相同**，三级靠颜色深了四倍多。
   * ★ 只量 font-size / font-weight 的话，这两级在闸眼里一模一样 —— 它会说「没问题」，
   *   而屏上明明是反的。倒挂正好藏在第三个量里。
   *
   * ★ **钉实数，不钉类名**：类名换了这条还成立；换了判据才该红。
   * ★ 明度用相对亮度（越小越深 = 越重），所以三条判据的方向是：
   *   字号递减 · 字重不递增 · 明度不递减。允许相等 —— 要拦的是**倒挂**，不是「必须拉开」。
   */
  it('★★★ ③-b Prompt 页的层级：字号 · 字重 · 明度 三个量都不许倒挂', async () => {
    await page.click('[data-testid="set-tab-tutor"]')
    await page.waitForSelector('[data-testid="prompt-area"]')
    await page.click('[data-testid="parea-drill"]')
    await page.click('[data-testid="ptab-reading"]')
    await page.waitForSelector('[data-testid="mode-reading"]')

    const lv = await page.evaluate(() => {
      /** 相对亮度：越小越深。用它判「谁更重」比直接比颜色字符串可靠 */
      const lum = (c: string): number => {
        const n = (c.match(/[\d.]+/g) ?? []).map(Number)
        const f = (v: number): number => {
          const x = v / 255
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(n[0] ?? 0) + 0.7152 * f(n[1] ?? 0) + 0.0722 * f(n[2] ?? 0)
      }
      const one = (sel: string): { size: number; weight: number; lum: number } | null => {
        const el = document.querySelector(sel)
        if (!el) return null
        const s = getComputedStyle(el)
        return {
          size: parseFloat(s.fontSize),
          weight: parseInt(s.fontWeight, 10),
          lum: lum(s.color)
        }
      }
      return {
        l1: one('[data-testid="prompt-area"] button.on'),
        l2: one('[data-testid="prompt-nav"] button.on'),
        l3: one('[data-testid="mode-reading"] .lyrh .lh-n')
      }
    })

    for (const [k, v] of Object.entries(lv)) {
      assert.ok(v, `★ 量不到 ${k} —— 选择器和屏上对不上，这条用例等于没验`)
    }
    const { l1, l2, l3 } = lv as Record<string, { size: number; weight: number; lum: number }>
    const say = `一级 ${l1.size}/${l1.weight}/${l1.lum.toFixed(3)} · ` +
      `二级 ${l2.size}/${l2.weight}/${l2.lum.toFixed(3)} · ` +
      `三级 ${l3.size}/${l3.weight}/${l3.lum.toFixed(3)}`

    assert.ok(l1.size > l2.size, `★★ 一级字号没比二级大：${say}`)
    assert.ok(l2.size > l3.size, `★★ 二级字号没比三级大：${say}`)
    assert.ok(l1.weight >= l2.weight, `★★ 一级字重比二级轻：${say}`)
    assert.ok(l2.weight >= l3.weight, `★★ 二级字重比三级轻：${say}`)
    assert.ok(l1.lum <= l2.lum, `★★ 一级颜色比二级浅：${say}`)
    assert.ok(
      l2.lum <= l3.lum,
      `★★★ 三级颜色比二级深 —— 这正是他报的那个倒挂，而且只量字号量不出来：${say}`
    )
  })


  /**
   * ★ T-7.7 撤了这一页的「自定义朗读服务商」折叠；D-466 又把它守的那张
   *   提供者表整个删了（语音只剩两个开关）。所以这一条现在盯的是：
   *   **这一页没有任何折叠，两个开关一进来就看得见** ——
   *   一个只有两个开关的页面还要人点开一层，那一层就只剩碍事。
   */
  it('★★ ④ 声音页：没有折叠，两个开关一进来就看得见', async () => {
    await page.click('[data-testid="set-tab-tts"]')
    await page.waitForSelector('[data-testid="voice-switches"]')
    assert.equal(
      await page.locator('[data-testid="fold-tts-provider"]').count(),
      0,
      '★ T-7.7 撤掉了这个折叠，它不该再出现'
    )
    for (const k of ['voice-on-dictionary', 'voice-on-system', 'tts-gb', 'tts-rate']) {
      assert.equal(await page.locator(`[data-testid="${k}"]`).count(), 1, `★ 一进来就该看得见 ${k}`)
    }
    // ★ 撤掉的是**功能**不是显示：那几个输入框一个都不该还在
    for (const gone of ['tts-baseurl', 'tts-key', 'tts-model', 'tts-voice']) {
      assert.equal(await page.locator(`[data-testid="${gone}"]`).count(), 0, `★★ ${gone} 还在`)
    }
  })

  it('★★★ ⑤ 数据页：危险操作默认收起 —— 不可逆的东西不该一进来就摆在眼前', async () => {
    await page.click('[data-testid="set-tab-data"]')
    await page.waitForSelector('[data-testid="fold-danger"]')
    assert.equal(
      await page.locator('[data-testid="danger-zone"]').count(),
      0,
      '★★★ 危险操作默认必须收起'
    )
    await page.click('[data-testid="fold-danger"]')
    await page.waitForSelector('[data-testid="danger-zone"]')
    assert.equal(await page.locator('[data-testid="reset-open"]').count(), 1, '展开后功能要还在')
  })
})

/**
 * ★★★ D-486 · 三层（牌面 · 题型 · 出题规则）在两个模式上长成同一个形状
 *
 * ══ 为什么这几条非在 ③ 档不可 ★★★ ═══════════════════════════
 *
 * 判据那一层（`quiz-rules.ts` 的读法与出厂值）在 core，已经有 40 条单测。
 * 但使用者第二 / 六条要的**不是判据**，是**屏上看得见的结构** ——
 * 「两个模式都要以对应的结构展示三层」「三者区别明显」。
 * 那句话能坏的方式，单测一条都看不见：
 *   · 两块的段序反了（一边牌面在前、一边题型在前）→ 并排看过去对不齐
 *   · 某一段整个没渲染出来（数据没回来 / 分支写错）→ 少一层，没人报错
 *   · 键选了却没存 → 他改了设置，重启回到原样（`key-surface-needs-roundtrip-test`）
 * 这一批交付前只有 ① 档，是我自己 grep 出来的债，这里还上。
 */
describe('★★★ D-486 · 两个模式上的三层结构（屏上那一层）', () => {
  /**
   * ★★ 去那两块的路：**Prompts → 左侧树里点那一叶**（D-488′ 侧树版）。
   *
   * ☞ 这个位置这一轮**变了两次**，两次我都是照上一版写、跑出来才发现：
   *   · 第一版按派单写「Practice 页」→ 四条全红（那是 D-488 之前的位置）
   *   · 第二版按两级 Tab 写，多点一下 `parea-drill` → 侧树版里那颗键**已经不存在**
   *   现在是**一下到位**：跨组不用先点区（B 的用例里那句「原来要先点区再点 Tab」说的就是这件事）。
   * ☞ 所以这个帮手只留**一处**知道路怎么走 —— 位置再变，改这四行就够了。
   *   位置是**待核项不是事实**（`dispatch-premises-are-not-facts`）。
   */
  /**
   * ★ 使用者 2026-09-15 第二轮改成两行横向 Tab 之后，**二级是随一级变的** ——
   *   认读 / 产出住在「练习」那一区里，不先切区就点不到它们（那两颗按钮压根没渲染）。
   *   这个助手统一把两下点击包起来：每条用例自己声明前提，谁都不依赖上一条停在哪儿。
   */
  const goto = async (which: 'reading' | 'produce'): Promise<void> => {
    await page.click('[data-testid="set-tab-tutor"]')
    await page.click('[data-testid="parea-drill"]')
    await page.click(`[data-testid="ptab-${which}"]`)
    await page.waitForSelector(`[data-testid="mode-${which === 'reading' ? 'reading' : 'practice'}"]`)
  }

  const layerNames = async (): Promise<string[]> =>
    (await page.locator('.lyrh .lh-n').allInnerTexts()).map((t) => t.trim())

  it('★ 前提：两个模式各自都进得去', async () => {
    await goto('reading')
    assert.equal(await page.locator('[data-testid="mode-reading"]').count(), 1)
    await goto('produce')
    assert.equal(await page.locator('[data-testid="mode-practice"]').count(), 1)
  })

  it('★★★ 两个模式的段名与段序**逐字一致**：牌面 → 题型 → 出题规则', async () => {
    await goto('reading')
    const reading = await layerNames()
    await goto('produce')
    const practice = await layerNames()
    assert.deepEqual(
      reading,
      ['牌面', '题型', '出题规则'],
      `★ 认读那块的段序不对：${JSON.stringify(reading)}`
    )
    assert.deepEqual(
      practice,
      reading,
      '★★★ 两个模式的段序对不上 —— 切过去三段一一对应，正是使用者第六条要的效果'
    )
  })

  it('★★ 三层各自的形态都真渲染出来了（不是只有段名）', async () => {
    await goto('reading')
    /** 认读牌面 4 张预览卡（多选）· 认读题型 3 行（单选）· 产出牌面 3 张（单选） */
    assert.equal(
      await page.locator('[data-testid="reading-faces"] [data-testid^="face-card-"]').count(),
      4,
      '★ 认读牌面不是 4 张'
    )
    assert.equal(
      await page.locator('[data-testid="reading-qtypes"] [data-testid^="rqtype-"]').count(),
      3,
      '★ 认读题型不是 3 行'
    )
    await goto('produce')
    assert.equal(
      await page.locator('[data-testid="practice-faces"] [data-testid^="pface-"]').count(),
      3,
      '★ 产出牌面不是 3 张'
    )
  })

  it('★★ 出题规则两块都是**弹窗**（使用者第四条）', async () => {
    for (const [open, modal, which, block] of [
      ['rules-open', 'rules-modal', 'reading', '认读'],
      ['prules-open', 'prules-modal', 'produce', '产出']
    ] as const) {
      await goto(which)
      await page.click(`[data-testid="${open}"]`)
      await page.waitForTimeout(400)
      const up = await page.locator(`[data-testid="${modal}"]`).count()
      /**
       * ★ 断言之前先把它关掉：断言失败时 `await` 后面的收尾**不会执行**，
       *   那个浮层就留在屏上，**下一条用例点不到任何东西** ——
       *   报出来的错跟这一条毫无关系（这一轮已经栽过两次，两次都查错了地方）。
       */
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      assert.equal(
        up,
        1,
        `★ 点了${block}那块的「出题规则」没有弹窗 —— 第四条要的就是它不再摊在页面上`
      )
      assert.equal(
        await page.locator(`[data-testid="${modal}"]`).count(),
        0,
        `★ ${block}那个弹窗 Esc 关不掉（IX-04：浮层一律走同一条 Esc 栈）`
      )
    }
  })

  it('★★★ 存取来回：选了「分栏」，重进这一页它还是「分栏」', async () => {
    /**
     * ★★ 这一条钉的是**键面**，不是渲染（`key-surface-needs-roundtrip-test`）：
     *   控件画对了、点得动、屏上也变了，而那一下**没写进库** ——
     *   他下次进来发现又回到「整块」，只会以为这个设置是假的。
     *   所以两头都验：库里那一行 **和** 重进之后屏上的选中态。
     */
    await goto('produce')
    await page.click('[data-testid="pface-split"]')
    await page.waitForTimeout(500)

    /** ★ 走主进程读回来（界面不持有数据副本，D-185）—— 问的是**库**，不是屏 */
    const stored = await page.evaluate(async () => (await window.nyx.study.qtypes()).face)
    assert.equal(stored, 'split', `★★★ 点了但没落库，库里是 ${JSON.stringify(stored)}`)

    await page.reload()
    await page.waitForTimeout(1500)
    await page.click('[data-testid="nav-settings"]')
    await goto('produce')
    await page.waitForSelector('[data-testid="practice-faces"]')
    assert.ok(
      await page.locator('[data-testid="pface-split"]').evaluate((el) => el.classList.contains('on')),
      '★★★ 库里是 split，重进之后屏上却没选中它 —— 读回那一步断了'
    )
  })
})

describe('控制台', () => {
  it('渲染进程没有任何 console.error 或未捕获异常', () => {
    assert.deepEqual({ consoleErrors }, { consoleErrors: [] }, `渲染进程报错了：\n${consoleErrors.join('\n')}`)
  })
})
