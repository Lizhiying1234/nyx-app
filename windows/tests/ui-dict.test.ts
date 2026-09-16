import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 第 ③ 档 · 词典跳转在**真实屏幕上**的验收 · D3（2026-08-19）
 *
 * ══ 为什么必须是屏幕，不能是 IPC 返回值 ★★★ ═════════════════
 *
 * 他的原话：「第③档必须验证真实屏幕，而不是 IPC 返回值。」
 * 而且点了名的一种假绿：
 *
 *     不要只断言页面里出现 "child"，因为 "@@@LINK=child" 也会让这种测试假绿。
 *
 * 所以这一套的判据是**最终结果**：
 *   · 卡片标题就是 `child`（不是 `children`、更不是一串 `@@@LINK=…`）
 *   · **整张卡片的可见文字里搜不到 `@@@LINK`**
 *   · 正文是真的释义（有长度、有词性、有例句）
 *   · 「查的是 child（你选的是 children）」那一行真的出现在屏幕上
 *
 * ══ 用他真的那 22 本 ═══════════════════════════════════════
 *
 * 词典目录用 junction 指回 `D:\Nyx\data\dicts`（只读）——
 * 造出来的假词典验不出「牛津高阶10 里 children 是一条 `@@@LINK`」这种事实。
 * 找不到那个目录就整套跳过（别人的机器上不该因此变红）。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_DICTS = process.env['NYX_DICTS'] ?? 'D:\\Nyx\\data\\dicts'
const have = existsSync(REAL_DICTS)

let app: ElectronApplication
let page: Page
let dataRoot = ''

/** 他点名的四个词，各自在哪本词典里是跳转 —— 实测出来的，见 dict-behavior 的 redirects 节 */
const CASES = [
  { word: 'children', book: 'oald10', headword: 'child', must: /plural|noun/i },
  { word: 'crises', book: 'oald10', headword: 'crisis', must: /noun|countable/i },
  { word: 'swayed', book: 'oald10', headword: 'sway', must: /verb|move/i },
  { word: 'per cent', book: '朗文6', headword: 'percent', must: /noun|adjective|adverb/i }
]

before(async () => {
  if (!have) return
  dataRoot = mkdtempSync(join(tmpdir(), 'nyx-dictui-'))
  mkdirSync(dataRoot, { recursive: true })
  // ★ junction：不拷 5.3 GB，也不动他的文件（软件只读词典）
  symlinkSync(REAL_DICTS, join(dataRoot, 'dicts'), 'junction')

  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  // 22 本真词典要全量装载一遍（实测 7~10 秒），比平时给得宽
  page.setDefaultTimeout(60000)
  await page.waitForLoadState('domcontentloaded')

  /**
   * 一棵最小的树 + 五条知识点。
   *
   * ★ 为什么用知识点行而不是原文：右键菜单只在**可捞的地方**给「查词典」
   *  （`Capture.svelte::classify` —— `.lrow` 是已入库条目那一档）。
   *   而他真实的用法本来就是这个：看着自己收进来的词，右键查一下。
   */
  const lecId = await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('词典验收')
    const u = await window.nyx.data.createUnit(p, '单元')
    const l = await window.nyx.data.createLecture(u, '第一讲')
    for (const term of ['children', 'crises', 'swayed', 'per cent', 'home', 'brunt', 'bicycle']) {
      await window.nyx.data.addItem(l, term, '', 'B', `A sentence with ${term} in it.`)
    }
    return l
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  // 走他自己的路进那一讲：展开项目 → 展开单元 → 点讲次
  await page.click('[data-testid="nav-home"]')
  await ensureOpen('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
  await ensureOpen('[data-testid^="nav-toggle-unit-"]', `[data-testid="nav-lecture-${lecId}"]`)
  await page.click(`[data-testid="nav-lecture-${lecId}"]`)
  /** 收成主动词汇的都在「主动」那一栏 —— 讲次工作台默认停在别的栏 */
  await page.click('[data-testid="tab-active"]')
  await page.waitForSelector('[data-testid="item-rows"]')
})

/**
 * 确保某一行是**展开**的。
 *
 * ★ 那一行的 onclick 是 toggle —— 已经展开时再点一下反而收起来。
 *   `ui-real.test.ts` 里同样的坑：三条用例一起超时，而病根是测试自己不稳。
 */
async function ensureOpen(rowSel: string, childSel: string): Promise<void> {
  const child = page.locator(childSel).first()
  if (await child.isVisible().catch(() => false)) return
  await page.locator(rowSel).first().click()
  await child.waitFor({ state: 'visible' })
}

after(async () => {
  await app?.close()
  if (dataRoot) {
    // ★ 只删我自己建的那个临时目录；里面的 dicts 是 junction，
    //   `rmSync` 会顺着它删进他的真目录 —— 所以**先把链接摘掉**再删。
    try {
      const { rmdirSync } = await import('node:fs')
      rmdirSync(join(dataRoot, 'dicts'))
    } catch {
      /* 没建成就没什么可摘的 */
    }
    keepOrClean(dataRoot)
  }
})

/** 把某个词选中并在它身上右键 —— 和他自己的操作一模一样 */
async function rightClickWord(word: string): Promise<void> {
  const box = await page.evaluate((w: string) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walk.nextNode())) {
      const text = node.textContent ?? ''
      const at = text.indexOf(w)
      if (at < 0) continue
      const el = node.parentElement
      if (!el || !el.offsetParent) continue
      // 只认知识点行里的那一份 —— 别处（比如侧栏）选中不给「查词典」
      if (!el.closest('.lrow')) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + w.length)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      const r = range.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }
    return null
  }, word)
  assert.ok(box, `页面上找不到「${word}」这个词 —— 正文没渲染出来？`)
  await page.mouse.click(box.x, box.y, { button: 'right' })
  await page.waitForSelector('[data-testid="ctx-dict"]')
  await page.click('[data-testid="ctx-dict"]')
  await page.waitForSelector('[data-testid="dict-card"]')
  /**
   * ★★ 卡片**默认停在 AI 那一档**（使用者 2026-09-13 第二轮：「默认进入 AI」），
   *   所以这一套要看的东西（音标 · 词典录音 · 词典原文）得先把档切过去。
   *
   * ★ 为什么不是把断言放宽：改版当天这一套里有两条**变成了假绿** ——
   *   「一个播放按钮都不许出现」在整档都藏起来的时候是恒真的。
   *   切档才让每一条重新对着真东西判。
   */
  await page.click('[data-testid="dict-tab-dict"]')
  await page.waitForSelector('[data-testid="dict-tab-dict"][aria-selected="true"]')
}

/** 把默认词典换成书名里带 needle 的那本（他机器上默认就是牛津高阶10） */
async function useBook(needle: string): Promise<string> {
  return await page.evaluate(async (n: string) => {
    const rows = await window.nyx.dict.list()
    const row = rows.find((r) => r.bookname.includes(n) && !r.missing)
    if (!row) throw new Error(`没有这本词典：${n}`)
    await window.nyx.dict.setDefaultBook(row.id)
    return row.bookname
  }, needle)
}


/**
 * 卡片上**他真的看得见**的那些字。
 *
 * ★★★ 不能只用 `innerText` —— 原文那一档关在 Shadow DOM 里，
 *   `innerText` **一个字都看不到**（实测：正文区返回空串）。
 *   初始那一档改成原文之后（2026-08-20），只看 `innerText` 会让
 *   「屏幕上不许出现 @@@LINK」这类断言**假绿** —— 它根本没在看那块内容。
 */
async function screenText(): Promise<string> {
  const t = await page.locator('[data-testid="dict-card"]').evaluate((card) => {
    const parts = [(card as HTMLElement).innerText]
    for (const host of Array.from(card.querySelectorAll('*'))) {
      const root = (host as HTMLElement).shadowRoot
      if (root) parts.push(root.textContent ?? '')
    }
    return parts.join(' ')
  })
  return t.replace(/\s+/g, ' ')
}

/**
 * 点一下播放按钮，**真的看它有没有开始播**。
 *
 * ★ 判据不是「按钮在」，是 `<audio>` 真的动了 ——
 *   他的验收第 1、2 条要的就是这个（「UK 音频真正开始播放」）。
 *   办法：先把 `Audio.prototype.play` 包一层，记下 src 和有没有被调用。
 */
async function playAndWatch(testid: string): Promise<{ played: boolean; src: string }> {
  await page.evaluate(() => {
    const w = window as unknown as { __nyxPlayed?: { src: string } }
    delete w.__nyxPlayed
    const orig = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      ;(window as unknown as { __nyxPlayed?: { src: string } }).__nyxPlayed = { src: this.src }
      return orig.call(this)
    }
  })
  await page.click(`[data-testid="${testid}"]`)
  await page.waitForFunction(() => (window as unknown as { __nyxPlayed?: unknown }).__nyxPlayed !== undefined, null, {
    timeout: 15000
  })
  const got = await page.evaluate(
    () => (window as unknown as { __nyxPlayed?: { src: string } }).__nyxPlayed ?? { src: '' }
  )
  return { played: Boolean(got.src), src: got.src }
}

describe('★★ D3 第③档 · @@@LINK 在真实屏幕上的样子', { skip: !have ? `找不到真词典目录 ${REAL_DICTS}` : false }, () => {
  for (const c of CASES) {
    it(`「${c.word}」→ 屏幕上是 ${c.headword} 的真词条，没有 @@@LINK`, async () => {
      const bookname = await useBook(c.book)
      await rightClickWord(c.word)

      /** ★ 含 Shadow DOM 里的原文 —— 初始那一档就是它 */
      const whole = await screenText()

      /**
       * ★★★ 第一条，也是这一整轮的目的：
       *   **整张卡片的可见文字里搜不到 `@@@LINK`。**
       *   D3 之前，`children` 在牛津高阶10 上显示的就是一行 `@@@LINK=child`。
       */
      assert.ok(
        !whole.includes('@@@LINK'),
        `★★ 屏幕上出现了 @@@LINK（${bookname}）：${whole.slice(0, 160)}`
      )

      // 标题就是跟到底的那个词目 —— 不是他划的那串，也不是跳转文本
      const title = (await page.locator('[data-testid="dict-word"]').innerText()).trim()
      assert.equal(title, c.headword, `★★ 卡片标题不对（${bookname}）`)

      // 「查的是 X（你选的是 Y）」要真的出现 —— 不说他会以为词典收错了词
      const asked = (await page.locator('[data-testid="dict-asked"]').innerText()).replace(/\s+/g, ' ')
      assert.ok(
        asked.includes(c.headword) && asked.includes(c.word),
        `★ 没告诉他实际查的是哪个词：「${asked}」`
      )

      /**
       * 正文得是真的释义，不是空的、也不是一行短标记。
       * ★ D4 之后卡片默认显示的是**结构化释义**（`dict-raw` 那一块整块退休了，
       *   词典原文改到「原文」那一档、关在 Shadow DOM 里）——
       *   所以这里量的是卡片正文区看得见的文字。
       */
      const body = whole
      assert.ok(body.length > 60, `★★ 正文太短，不像真词条（${body.length} 字）：${body}`)
      assert.ok(c.must.test(body), `★ 正文里没有该有的东西：${body.slice(0, 120)}`)
      assert.ok(!body.includes('@@@LINK'), '★★ 正文里有 @@@LINK')

      await page.click('[data-testid="dict-close"]')
    })
  }

  it('没有跳转的词照旧：直接命中，标题就是他划的那个词', async () => {
    await useBook('oald10')
    await rightClickWord('home')
    const title = (await page.locator('[data-testid="dict-word"]').innerText()).trim()
    assert.equal(title, 'home', `★ 没跳转的词也被改了：${title}`)
    const whole = await screenText()
    assert.ok(!whole.includes('@@@LINK'), '★★ 屏幕上出现了 @@@LINK')
    // 没跳转就不该出现「查的是 …」那一行
    assert.equal(
      await page.locator('[data-testid="dict-asked"]').count(),
      0,
      '★ 没跳转却说「查的是别的词」—— 他会以为词典收错了'
    )
    await page.click('[data-testid="dict-close"]')
  })
})

describe('★★ D4 第③档 · 富媒体在真实屏幕上', { skip: !have ? `找不到真词典目录 ${REAL_DICTS}` : false }, () => {
  it('★★ brunt · 牛津高阶10：英式发音真的开始播了', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    assert.equal(await page.locator('[data-testid="dict-play-uk"]').count(), 1, '★ 没有英式发音按钮')
    const ok = await playAndWatch('dict-play-uk')
    assert.ok(ok.played, `★★ 点了没响：${JSON.stringify(ok)}`)
    assert.ok(ok.src.startsWith('data:audio/'), `★ 不是 data: 音频：${ok.src.slice(0, 40)}`)
    await page.click('[data-testid="dict-close"]')
  })

  it('★★ brunt · 牛津高阶10：美式发音也真的开始播了', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    assert.equal(await page.locator('[data-testid="dict-play-us"]').count(), 1, '★ 没有美式发音按钮')
    const ok = await playAndWatch('dict-play-us')
    assert.ok(ok.played, `★★ 点了没响：${JSON.stringify(ok)}`)
    await page.click('[data-testid="dict-close"]')
  })

  it('★★ brunt · 英美音标分别显示', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    const uk = await page.locator('[data-testid="dict-phonetic-uk"]').innerText()
    const us = await page.locator('[data-testid="dict-phonetic-us"]').innerText()
    assert.ok(/brʌnt/.test(uk), `英式音标不对：${uk}`)
    assert.ok(/brʌnt/.test(us), `美式音标不对：${us}`)
    await page.click('[data-testid="dict-close"]')
  })

  /**
   * ★ 这里原来有两条：「释义 / 中文 / 例句 分块显示」与「bicycle 插图」。
   *   2026-08-20 卡片取消了「释义」那一档（只留词典原文），
   *   那两块**在屏幕上已经不存在** —— 第③档只查他看得见的东西，所以退休。
   *
   *   它们守的东西没有丢，只是换了地方：
   *     结构化解析（义项 / 中文对译 / 例句）→ `tests/dict-behavior.ts` 的 rich 一节逐词对拍
   *     插图真的解得出来               → 下面「词典原文里的插图也真的加载出来」那一条
   */

  it('★★★ LDOCE5 · Speex 发音：一个播放按钮都不许出现', async () => {
    const name = await useBook('Contemporary English')
    await rightClickWord('brunt')
    /**
     * ★★★ 他的 D4 第 7 条：不许出现「按钮显示了但点了没声音」。
     *   LDOCE5 的 18.4 万条发音是 Speex，Chromium 解不了 ——
     *   所以这本上**一个发音按钮都不该有**，而音标该照常显示。
     */
    assert.equal(
      await page.locator('[data-testid="dict-play-uk"]').count(),
      0,
      `★★★ ${name} 上出现了按下去不会响的英式发音按钮`
    )
    assert.equal(await page.locator('[data-testid="dict-play-us"]').count(), 0, `★★★ ${name} 上出现了假的美式发音按钮`)
    assert.ok((await screenText()).length > 40, '★ 正文空了')
    await page.click('[data-testid="dict-close"]')
  })

  it('★★★ 词典原文：Shadow DOM 里样式生效，主页面一点没被污染', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    /** 先记下主页面某个元素的样子 —— 词典 CSS 要是漏出来，它会变 */
    const before = await page.locator('[data-testid="nav-home"]').evaluate((el) => {
      const s = getComputedStyle(el)
      return `${s.fontFamily}|${s.fontSize}|${s.color}`
    })

    await page.waitForSelector('[data-testid="dict-shadow"]')
    const shadow = await page.locator('[data-testid="dict-shadow"]').evaluate((host) => {
      const root = (host as HTMLElement).shadowRoot
      if (!root) return { ok: false as const }
      const styleLen = root.querySelector('style')?.textContent?.length ?? 0
      const el = root.querySelector('[class]') as HTMLElement | null
      return {
        ok: true as const,
        styleLen,
        text: (root.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
        // 词典 CSS 真的作用到了里面的元素上吗
        sample: el ? getComputedStyle(el).fontSize + '/' + getComputedStyle(el).color : ''
      }
    })
    assert.ok(shadow.ok, '★★★ 根本没有 ShadowRoot —— 词典 HTML 进了主文档')
    assert.ok(shadow.styleLen > 1000, `★ 词典自己的样式表没进去（${shadow.styleLen} 字）`)
    assert.ok(shadow.text.length > 40, `★ Shadow 里没内容：${shadow.text}`)

    const after = await page.locator('[data-testid="nav-home"]').evaluate((el) => {
      const s = getComputedStyle(el)
      return `${s.fontFamily}|${s.fontSize}|${s.color}`
    })
    assert.equal(after, before, '★★★ 主页面的样式被词典 CSS 改了 —— Shadow DOM 没关住')

    /** 主文档里不许多出词典的 <style>/<link> */
    const leaked = await page.evaluate(() =>
      [...document.querySelectorAll('style,link[rel=stylesheet]')].filter((e) =>
        /\.sense|\.pron|oald|ldoce/i.test(e.textContent ?? (e as HTMLLinkElement).href ?? '')
      ).length
    )
    assert.equal(leaked, 0, '★★★ 词典样式漏进了主文档')
    await page.click('[data-testid="dict-close"]')
  })

  it('★★★ 词典原文：script 不执行、外链不加载、sound:// 已经换成引用', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    await page.waitForSelector('[data-testid="dict-shadow"]')
    const scan = await page.locator('[data-testid="dict-shadow"]').evaluate((host) => {
      const root = (host as HTMLElement).shadowRoot!
      const html = root.innerHTML
      return {
        scripts: root.querySelectorAll('script').length,
        onclicks: [...root.querySelectorAll('*')].filter((e) => e.getAttributeNames().some((a) => a.startsWith('on'))).length,
        rawSound: /sound:\/\//i.test(html),
        external: [...root.querySelectorAll('[src],[href]')].filter((e) =>
          /^https?:/i.test(e.getAttribute('src') ?? e.getAttribute('href') ?? '')
        ).length,
        audioRefs: root.querySelectorAll('[data-nyx-audio]').length,
        link: /@@@LINK/.test(root.textContent ?? '')
      }
    })
    assert.equal(scan.scripts, 0, '★★★ Shadow 里有 <script>')
    assert.equal(scan.onclicks, 0, '★★★ Shadow 里还有内联事件')
    assert.equal(scan.rawSound, false, '★★★ 原始 sound:// 还在页面上')
    assert.equal(scan.external, 0, '★★★ 有外链元素')
    assert.ok(scan.audioRefs > 0, '★ 发音引用被清没了 —— 那样原文里就点不响了')
    assert.equal(scan.link, false, '★★ 屏幕上出现了 @@@LINK')
    /** ★ 窗口里不许出现新的 <script>（词典 js 被执行的话会留下痕迹） */
    assert.equal(await page.evaluate(() => (window as unknown as { oald10?: unknown }).oald10 ?? null), null)
    await page.click('[data-testid="dict-close"]')
  })

  it('★★ 词典原文里的插图也真的加载出来（走的是消毒时改写的那个 ref）', async () => {
    await useBook('oald10')
    await rightClickWord('bicycle')
    await page.waitForSelector('[data-testid="dict-shadow"]')
    /**
     * ★ 卡片上那几张图走的是 `entry.media`；**原文这一档走的是消毒时
     *   把 `<img src>` 改写成的 `data-nyx-img`** —— 两条路，各验各的。
     *   （反向验收 23 就是把后面那条改写关掉，这条必须因此变红。）
     */
    const got = await page
      .locator('[data-testid="dict-shadow"]')
      .evaluate(async (host) => {
        const root = (host as HTMLElement).shadowRoot!
        const imgs = [...root.querySelectorAll('img')]
        const marked = imgs.filter((i) => i.hasAttribute('data-nyx-img')).length
        for (let i = 0; i < 60; i++) {
          const ok = imgs.find((x) => x.naturalWidth > 0)
          if (ok) return { marked, w: ok.naturalWidth, src: ok.src.slice(0, 12) }
          await new Promise((r) => setTimeout(r, 100))
        }
        return { marked, w: 0, src: '' }
      })
    assert.ok(got.marked > 0, '★★ 原文里的 <img> 没有被改写成引用 —— 那样它永远加载不出来')
    assert.ok(got.w > 0, `★★ 原文里的图没加载出来：${JSON.stringify(got)}`)
    assert.ok(got.src.startsWith('data:image'), `★ 不是 data: 图片：${got.src}`)
    await page.click('[data-testid="dict-close"]')
  })

  /**
   * ★★★ app **里面**这条路：AI 那一档**自动跑**（使用者 2026-09-13）
   *
   * 他定的是「AI 放在第一位，默认进入 AI」—— 一个默认打开却空着、
   * 要再点一下才出东西的界面，等于没有默认。
   *
   * ★★ 它和 `smoke:overlay` 里那条 ⑥ 是**一对**，谁都不能单独删：
   *   里面自动跑 · 外面（Glance 浮窗）点了才跑。
   *   只钉一边的话，谁把 `outside` 那个分支写反（或者删掉），另一边照样绿。
   * ★ 两套都没配 AI，所以分水岭正好是：屏上是**一条 AI 的错**（真发了车、真失败了）
   *   还是**一颗「问 AI」按钮**（没发车）。不用花钱也钉得住。
   *
   * ★ 这条原来放在 `study.test.ts` 里。挪过来是因为**它在那儿会让下一套
   *   （`smoke:sync` 的 R-4-G）红**，而单独跑它、或者换别的套排在 sync 前面都不红 ——
   *   中间那一环我没查出来。详见 `sync.test.ts` R-4-G 上面那段注释。
   *   这里也是它更该待的地方：它讲的是查词卡，不是 study。
   */
  it('★★★ app 里面：AI 那一档自动跑（不需要再点一下）', async () => {
    await rightClickWord('brunt')
    await page.click('[data-testid="dict-tab-ai"]')
    try {
      await page
        .waitForSelector('[data-testid="dict-ai-err"], [data-testid="dict-ai-out"]', {
          timeout: 25000
        })
        .catch(() => {})
      assert.equal(
        await page.locator('[data-testid="dict-ai-go"]').count(),
        0,
        '★★ app 里面出现了「问 AI」那颗按钮 —— 外面那条路的行为漏进来了'
      )
      assert.equal(
        await page.locator('[data-testid="dict-ai-wait"]').count(),
        0,
        '★★ AI 那一档停在「正在看…」上不动了 —— 根本没发车'
      )
    } finally {
      await page.click('[data-testid="dict-close"]').catch(() => {})
    }
  })

  it('★★ 卡片上只有词典原文这一块（同一份内容不说两遍）', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    assert.equal(await page.locator('[data-testid="dict-shadow"]').count(), 1, '★★ 原文那一块没了')
    const blocks = await page
      .locator('[data-testid="dict-body"]')
      .evaluate((b) => Array.from(b.children).map((e) => e.getAttribute('data-testid') ?? e.tagName.toLowerCase()))
    assert.deepEqual(blocks, ['dict-shadow'], '★★ 正文里除了词典原文还挂着别的东西')
    await page.click('[data-testid="dict-close"]')
  })
})

/**
 * 卡片上只有词典原文（2026-08-20）
 *
 * 他的话：「取消释义，只保留原文这样子就行了。」
 *
 * ★★ 防假绿：只断言「原文在」是不够的 —— 释义那一块要是还在旁边，
 *   那种断言照样过。所以每一条都成对：**该在的在、该不在的不在**，
 *   而且要确认那两个标签页**从 DOM 里消失了**（不是藏起来）。
 */
describe('★★ 词典卡片 · 只有原文这一块', { skip: !have ? `找不到真词典目录 ${REAL_DICTS}` : false }, () => {
  /**
   * 正文区**直接挂着**的那几块。
   *
   * ★★★ 判据用它，不用「`dict-sense` 有 0 个」—— 后者在释义那套 UI 删掉之后
   *   **永远为真**，再也不会红，就是一张安慰牌。
   *   这一条不一样：谁要是又往正文里塞了第二块（重拼的释义、摘要、任何东西），
   *   它当场变红。
   */
  const bodyBlocks = async (): Promise<string[]> =>
    await page
      .locator('[data-testid="dict-body"]')
      .evaluate((b) =>
        Array.from(b.children).map(
          (e) => e.getAttribute('data-testid') ?? (e.className || e.tagName.toLowerCase())
        )
      )
  /** Shadow DOM 里**真的有字** —— 只看宿主节点在不在会假绿（空壳也在） */
  const shadowText = async (): Promise<string> =>
    await page
      .locator('[data-testid="dict-shadow"]')
      .evaluate((host) => (host as HTMLElement).shadowRoot?.textContent ?? '')

  it('★★★ 打开就是词典原文，旁边没有另一块释义', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    await page.waitForSelector('[data-testid="dict-shadow"]')
    const t = (await shadowText()).replace(/\s+/g, ' ').trim()
    assert.ok(t.length > 40, `★★★ 原文那一块是空的：${t}`)
    assert.ok(/brunt/i.test(t), `★★ 原文里没有这个词：${t.slice(0, 120)}`)
    assert.deepEqual(await bodyBlocks(), ['dict-shadow'], '★★★ 正文里除了词典原文还挂着别的东西')
    await page.click('[data-testid="dict-close"]')
  })

  it('★★★ 「释义 / 原文」那两个标签页已经没有了', async () => {
    await useBook('oald10')
    await rightClickWord('brunt')
    await page.waitForSelector('[data-testid="dict-shadow"]')
    assert.equal(await page.locator('[data-testid="dict-tab-sense"]').count(), 0, '★★★ 「释义」标签页还在')
    assert.equal(await page.locator('[data-testid="dict-tab-raw"]').count(), 0, '★★ 「原文」标签页还在（现在没得可切，不该留一个孤零零的）')
    await page.click('[data-testid="dict-close"]')
  })

  it('★★ 换一本词典，还是只有原文', async () => {
    await useBook('朗文6')
    await rightClickWord('brunt')
    await page.waitForSelector('[data-testid="dict-shadow"]')
    assert.ok((await shadowText()).trim().length > 40, '★★ 换本书之后原文是空的')
    assert.deepEqual(await bodyBlocks(), ['dict-shadow'])
    assert.equal(await page.locator('[data-testid="dict-tab-sense"]').count(), 0)
    await page.click('[data-testid="dict-close"]')
  })
})

describe('★★ D5.1a 第③档 · 两本老版 MDict（LZO）真的打得开', { skip: !have ? `找不到真词典目录 ${REAL_DICTS}` : false }, () => {
  it('★★★ 21世纪英汉汉英双向词典：查得到，而且中文正常', async () => {
    const name = await useBook('21世纪英汉汉英双向')
    await rightClickWord('brunt')
    const body = await screenText()
    /**
     * ★★★ 在这之前这本词典的设置页上写着「这本是老版 MDict（1.2 版，LZO 压缩），当前读不了」。
     *   现在它得真的查得出东西 —— 而且是**中文**（这本是英汉，正文就是中文）。
     */
    assert.ok(body.length > 40, `★★ ${name} 查不出内容：${body}`)
    assert.ok(/[一-鿿]/.test(body), `★★★ 正文里没有中文，多半是解压或编码出了问题：${body.slice(0, 120)}`)
    assert.ok(!body.includes('LZO'), '★ 屏幕上还在说 LZO 读不了')
    assert.ok(!/�/.test(body), `★★ 正文里有替换字符（乱码）：${body.slice(0, 120)}`)
    await page.click('[data-testid="dict-close"]')
  })

  it('★★★ 朗文英文当代大词典（插图版）：查得到，正文是像样的英文', async () => {
    const name = await useBook('朗文英文当代大词典')
    await rightClickWord('brunt')
    const body = await screenText()
    assert.ok(body.length > 40, `★★ ${name} 查不出内容：${body}`)
    assert.ok(/[a-zA-Z]{6,}/.test(body), `★ 正文里没有像样的英文：${body.slice(0, 120)}`)
    assert.ok(!/�/.test(body), `★★ 正文里有替换字符（乱码）：${body.slice(0, 120)}`)
    await page.click('[data-testid="dict-close"]')
  })

  it('★★ 设置页里这两本不再显示「读不了」', async () => {
    const problems = await page.evaluate(async () => {
      const rows = await window.nyx.dict.list()
      return rows
        .filter((r) => r.bookname.includes('21世纪英汉汉英双向') || r.bookname.includes('朗文英文当代大词典'))
        .map((r) => ({ name: r.bookname.slice(0, 12), problem: r.problem ?? null, words: r.wordCount }))
    })
    assert.equal(problems.length, 2, `没找到那两本：${JSON.stringify(problems)}`)
    for (const p of problems) {
      assert.equal(p.problem, null, `★★★ ${p.name} 还带着失败原因：${p.problem}`)
      assert.ok(p.words > 1000, `★★ ${p.name} 的词数不对：${p.words}`)
    }
  })
})
