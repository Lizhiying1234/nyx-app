/**
 * 全局分析 · Windows 维度 5～9 的走查台 · D-491 / D-492
 *
 * ══ 它为什么存在 ★★★ ═══════════════════════════════════════
 *
 * D-491：凡层级 / 功能关系 / 合并 / 删除类判断，**必须实际进入 → 点击 → 看下一级页面**
 * 再下结论，不许看表面 UI 猜。D-492：架构结论只认**行为证据**，
 * **屏上那句话是第一手判据**。
 *
 * 所以这个脚本只做一件事：**把每一站真走一遍，把屏上的字原样抄回来 + 拍一张**。
 * 它不判断对错 —— 判断写在报告里，由人看着证据写。
 *
 * ★ 一条命令只起**一套** Electron（2026-09-15 的教训：两套并发抢同一个工作台，
 *   红一片，而我把它误报成「抖动」三次）。
 *
 * 用法：node scripts/audit-walk.mjs [站名…]　默认全走
 *   出图 shots/audit-<站>.png · 屏上字打到 stdout（用 `> 文件` 收）
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'

const root = join(process.cwd(), '.shots-audit')
rmSync(root, { recursive: true, force: true })
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, NYX_DATA_ROOT: root, NYX_NO_SYNC_TIMERS: '1' }
})
/** ★ `keepGuides` 不传 —— 引导会被标成看过。第二层的「真出没出」另有走查台。 */
const page = await mainWindow(app)
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

/** 铺一份像样的库：三层 + 三条知识点 + 已开学 */
const seeded = await page.evaluate(async () => {
  const p = await window.nyx.data.createProject('走查用的项目')
  const u = await window.nyx.data.createUnit(p, '第一单元')
  const l = await window.nyx.data.createLecture(u, 'Coastal towns and storms')
  const seed = [
    ['bear the brunt', '承受最重的那一下', 'Coastal towns bear the brunt of these storms.'],
    ['hold sway', '占主导、说了算', 'That view still holds sway in the department.'],
    ['a far cry from', '差得远', 'The result was a far cry from what we expected.']
  ]
  /** ★ 接住 id：第三批那两站要按 id 把一条摆成静默、另一条摆成攻坚 */
  const itemIds = []
  for (const [t, g, q] of seed) itemIds.push((await window.nyx.data.addItem(l, t, g, 'B', q)).id)
  await window.nyx.study.startLearning(l)
  return { project: p, unit: u, lecture: l, items: itemIds }
})
await page.reload()
await page.waitForTimeout(1600)

/** 抄屏上的字：只取看得见的那些，原样，不转述 */
const readScreen = async () =>
  (
    await page.evaluate(() => {
      const out = []
      const walk = (el) => {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') return
        for (const n of el.childNodes) {
          if (n.nodeType === 3) {
            const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
            if (t) out.push(t)
          } else if (n.nodeType === 1) walk(n)
        }
      }
      walk(document.body)
      return out
    })
  )
    .filter((t, i, a) => a.indexOf(t) === i)
    .join(' | ')

/**
 * 把一块的 `innerText` 压成一行贴出来。
 * ★ 换行用 `String.fromCharCode(10)` 拿，不写转义（D-460：反斜杠一律绕开）。
 */
const NL = String.fromCharCode(10)
const oneLine = (s) =>
  s
    .split(NL)
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .join(' ／ ')

const openIfClosed = async (rowSel, childSel) => {
  const child = page.locator(childSel).first()
  if (await child.isVisible().catch(() => false)) return
  await page.locator(rowSel).first().click()
  await child.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
}

const gotoLecture = async () => {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(400)
  await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
  await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
  await page.locator('[data-testid^="nav-lecture-"]').first().click()
  await page.waitForTimeout(900)
}

/**
 * 每一站：[名字, 做什么]。
 * ★ 「做什么」里写的每一步都是**真点**，不是读代码推。
 */
const STOPS = [
  ['today', async () => await page.click('[data-testid="nav-home"]')],
  ['lecture', gotoLecture],
  [
    'lecture-click-item',
    async () => {
      await gotoLecture()
      /** ★ `lecture-split` 那句说「点一条知识点，就能看到它在原文哪里」—— 就点这一下 */
      await page.locator('[data-testid="item-rows"] .lrow .lt').first().click()
      await page.waitForTimeout(1200)
    }
  ],
  ['trash', async () => await page.click('[data-testid="nav-trash"]')],
  [
    'report',
    async () => {
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(500)
      await page.click('[data-testid="home-report"]')
      await page.waitForTimeout(900)
    }
  ],
  [
    'settings-prompts',
    async () => {
      await page.click('[data-testid="nav-settings"]')
      await page.waitForTimeout(400)
      await page.click('[data-testid="set-tab-tutor"]')
      await page.waitForTimeout(700)
    }
  ],
  ['vault-silent', async () => await page.click('[data-testid="nav-lib-silent"]')],
  ['hard', async () => await page.click('[data-testid="nav-hard"]')],
  ['files', async () => await page.click('[data-testid="nav-files"]')],

  /** ── 第二批：要先把局面摆出来的那几站（2026-09-16）───────── */
  [
    'item-detail-menu',
    async () => {
      /** `item-analysis` 后半句「词和释义你随时可以自己改」—— 找那条路在哪 */
      await gotoLecture()
      await page.locator('[data-testid="item-rows"] .lrow .lt').first().click()
      await page.waitForTimeout(1000)
      /**
       * ★ 用元素自己的 `.click()`，不走坐标：这颗 ⋮ 一点开就铺一张
       *   `detail-menu-scrim`，而 Playwright 的重试会撞在那张遮罩上
       *   —— 报出来的错是「点不到 detail-menu」，其实菜单已经开了。
       */
      await page.evaluate(() => {
        ;(document.querySelector('[data-testid="detail-menu"]'))?.click()
      })
      await page.waitForTimeout(700)
    }
  ],
  [
    'trash-with-item',
    async () => {
      /**
       * `trash-tiers` 后半句要一条**回收站里真有东西**的局面才看得到那颗键。
       * ★ 这里只**软删一条知识点**（可恢复，回收站那条路本来就是给这个用的）；
       *   「彻底删除」**只看不点**（红线）。走查库是 `.shots-audit`，不是他的真库。
       */
      /**
       * ★★ 第一版用 `.xbtn` 并 `.catch(() => {})` 吃掉失败 ——
       *   结果是**没删成**，而这一站报回来一句「回收站是空的」，
       *   看着像结论，其实是**局面根本没摆起来**。
       *   —— 夹具没摆成就报错，不吃；摆不成的走查比没走更坑人。
       * ★ 删的是**整一讲**（侧栏 ⋮ 里那条）—— 知识点详情页的 ⋮ 里没有删，
       *   只有「修改 / 随时认读 / 随时练习」（这一趟量出来的）。
       *   软删可恢复；「彻底删除」**只看不点**（红线）。
       */
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(400)
      await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
      await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
      const lec = page.locator('[data-testid^="nav-lecture-"]').first()
      await lec.click({ button: 'right' })
      await page.waitForTimeout(600)
      /** ★ 菜单那一项屏上写的是「删除…」， testid 是 `tree-delete`（量出来的，不是猜的）*/
      const del = page.locator('[data-testid="tree-delete"]').first()
      if ((await del.count()) === 0) {
        throw new Error('★ 右键菜单里没有 tree-delete —— 局面没摆起来，不往下走')
      }
      await del.click()
      await page.waitForTimeout(700)
      /**
       * ★★ 这个确认框本身就是 `trash-tiers` 要核的证据之一 ——
       *   先抢下它说了什么，再点确认。
       */
      const dlgTitle = await page.locator('[data-testid="tree-del-dlg-title"]').innerText()
      const dlgBody = await page.locator('[data-testid="tree-del-dlg-body"]').innerText()
      await page.screenshot({ path: join('shots', 'audit-del-dialog.png') })
      console.log('')
      console.log('═══ 删除确认框屏上原话 ═══')
      console.log('  标题：' + dlgTitle)
      console.log('  正文：' + dlgBody)
      await page.click('[data-testid="tree-del-dlg-confirm"]')
      await page.waitForTimeout(900)
      await page.click('[data-testid="nav-trash"]')
      await page.waitForTimeout(1200)
      /**
       * ★★ 勾上一条，看看会冒出什么动作 ——
       *   `trash-tiers` 后半句说的「彻底删除」到底在不在这一屏上。
       * ★★★ **只勾不点**：彻底删除是红线，我只读它的字。
       */
      const selAll = page.locator('[data-testid="trash-select-all"], .trash .sel-all').first()
      if (await selAll.isVisible().catch(() => false)) {
        await selAll.click()
        await page.waitForTimeout(700)
      } else {
        const row = page.locator('.lrow .ck, .trow .ck').first()
        if (await row.isVisible().catch(() => false)) {
          await row.click()
          await page.waitForTimeout(700)
        }
      }
    }
  ],
  [
    'settings-assist',
    async () => {
      await page.click('[data-testid="nav-settings"]')
      await page.waitForTimeout(400)
      await page.click('[data-testid="set-tab-assist"]')
      await page.waitForTimeout(700)
    }
  ],

  /** ── 第三批 · 剩下 8 句里**不要 AI** 的那 4 句（2026-09-16）───────
   *
   * ★★ 为什么专门分出「不要 AI」这一批：机器上一次只许有一套 Electron，
   *   而要真调模型的那三站（W-8～W-10）正占着。这四句的判据**全在屏上的字
   *   和库里的状态上**，一次模型调用都不需要 —— 所以机器一空出来就能跑完，
   *   不必排在要花钱的那一批后面。
   * ★ 每一站都写清楚**这一趟核得了哪半句、哪半句核不了**。
   *   核不了的那半句在报告里写「未走到」，**不写「无问题」**（D-494 的规矩）。
   */
  [
    'sidebar-tree',
    async () => {
      /**
       * 句子：「材料按三层放：项目 → 单元 → Lecture。」
       *
       * 这一趟核：**屏上这三级各自叫什么**（不是代码里的 project / unit / lecture），
       * 以及那棵树真的一层套一层。
       * ★ 三级名字必须从**屏上抄**：core 那句写的是 `Lecture`（首字母大写，D-471 专名），
       *   而屏上别处已经量到过小写的 `lecture`（Vault 统计块那三格）。
       *   这句话指着侧栏，所以判据是**侧栏上印的那几个字**。
       */
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(400)
      await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
      await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
      await page.waitForTimeout(600)
      const area = page.locator('[data-testid="project-area"]')
      if ((await area.count()) === 0) {
        throw new Error('★ 侧栏上没有 project-area —— 引导的目标不在屏上，不往下走')
      }
      const lec = page.locator('[data-testid^="nav-lecture-"]')
      if ((await lec.count()) === 0) {
        throw new Error('★ 三层没展开到 Lecture —— 局面没摆起来，不往下走')
      }
      console.log('')
      console.log('═══ 侧栏那棵树 · 屏上原话 ═══')
      console.log('  树里：' + oneLine(await area.innerText()))
      console.log('  分区标题：' + (await page.locator('.secthead').allInnerTexts()).join(' ／ '))
      console.log('  第三层那几行：' + (await lec.allInnerTexts()).join(' ／ '))
    }
  ],
  [
    'filestudy-modes',
    async () => {
      /**
       * 句子：「读的时候可以切两种：让 AI 讲给你听，或者让它反过来问你。」
       *
       * 这一趟核**前半句**：真的有两种、它们在屏上叫什么、进这一页时那两个 Tab
       * 在不在屏上（引导的目标够不够得着 —— I-190 那一类）。
       * ★★ **两个 Tab 一下都不点**：点过去就是一次真 AI 调用。
       *   「切过去之后它真的讲 / 真的反过来问」是**后半句**，排进要 AI 的那一批，
       *   在那之前那半句一律记「未走到」。
       */
      await page.click('[data-testid="nav-files"]')
      await page.waitForTimeout(700)
      const add = page.locator('[data-testid="fs-add"], [data-testid="fs-add-empty"]').first()
      if (!(await add.isVisible().catch(() => false))) {
        throw new Error('★ 文件学习页上找不到「加一篇」的入口 —— 局面没摆起来，不往下走')
      }
      await add.click()
      await page.waitForTimeout(600)
      await page.fill('[data-testid="fs-title"]', '走查用的文章')
      await page.fill(
        '[data-testid="fs-text"]',
        'Coastal towns bear the brunt of these storms. That view still holds sway in the department, and the result was a far cry from what we expected.'
      )
      await page.click('[data-testid="fs-save"]')
      await page.waitForTimeout(1400)
      const card = page.locator('[data-testid^="fs-card-"]').first()
      if ((await card.count()) === 0) {
        throw new Error('★ 文章没收下 —— 局面没摆起来，不往下走（不吃这个失败）')
      }
      await card.click()
      await page.waitForTimeout(1600)
      const modes = page.locator('[data-testid="fs-modes"]')
      console.log('')
      console.log('═══ 两种读法 · 屏上原话 ═══')
      if (!(await modes.isVisible().catch(() => false))) {
        console.log('  ★★ 进这一页时 `fs-modes` **不可见** —— 引导的目标够不着（记一条）')
      } else {
        console.log('  两个 Tab：' + oneLine(await modes.innerText()))
        console.log(
          '  当前模式那一条：' + oneLine(await page.locator('[data-testid="fs-modetag"]').innerText())
        )
      }
    }
  ],
  [
    'vault-learned',
    async () => {
      /**
       * 句子（由常量拼）：「静默的知识点不再出题；想再练，随时恢复。」
       *
       * 这一趟核三件事，**全都不要 AI**：
       *   ① 档名在屏上是不是就这两个字；
       *   ② 这句引导和那个框里印的那句**是不是同一句话**
       *      —— 若是，它就犯了「复述屏上已有的字」（我提的那条判准，等裁）；
       *   ③ 「随时恢复」那条路，**单条**静默的知识点上到底在哪。
       * ★ 静默走产品自己那条 IPC（详情页 ⋮ 调的就是 `study.silenceItem`），不改库。
       */
      const itemId = seeded.items && seeded.items[0]
      if (!itemId) throw new Error('★ 铺数据时没拿到知识点 id —— 局面没摆起来，不往下走')
      await page.evaluate(async (id) => await window.nyx.study.silenceItem(id), itemId)
      await page.click('[data-testid="nav-lib-silent"]')
      await page.waitForTimeout(1400)
      console.log('')
      console.log('═══ 静默档 · 屏上原话 ═══')
      const frame = page.locator('[data-testid="silent-frame"]')
      if (!(await frame.isVisible().catch(() => false))) {
        console.log('  ★★ `silent-frame` 不可见 —— 引导的目标够不着（记一条）')
      } else {
        console.log('  框里那一整块：' + oneLine(await frame.innerText()))
        console.log(
          '  档名那行大字：' + (await page.locator('[data-testid="silent-title"]').innerText())
        )
      }
      /** ③ 勾一条，看「恢复」那颗键在不在这一屏上 —— 只勾不点 */
      const row = page
        .locator('[data-testid^="lib-row-"] .ck, [data-testid^="lib-row-"] input[type=checkbox]')
        .first()
      if (await row.isVisible().catch(() => false)) {
        await row.click()
        await page.waitForTimeout(700)
        const bar = page.locator('[data-testid="selbar"]')
        const seen = (await bar.isVisible().catch(() => false))
          ? oneLine(await bar.innerText())
          : '★★ 没出来（记一条）'
        console.log('  勾一条之后那条操作栏：' + seen)
      } else {
        console.log('  ★★ 静默档的行上勾不着 —— 「随时恢复」在这一屏上没有入口（记一条）')
      }
    }
  ],
  [
    'vault-hard',
    async () => {
      /**
       * 句子：「练了很多次还没过的，会被单独挪到这儿。」
       *
       * 这一趟核**后半句**「单独挪到这儿」：进了攻坚区之后，
       * 这一条**还在不在它原来那一讲里**。
       *   · `core/grading.ts` 那行注释写的是「D-025 · **移出** lecture」，
       *     `leftHard` 那句说「攻出来了，**回原 lecture**」—— 两句都在说「移动」；
       *   · 而 `hardList` 只是 `where production_state = 'hard'`，
       *     `item_lectures` 那条链一个字没动（它还 join 回去取讲次名）。
       *   ☞ 「移出」到底是**真挪走**还是**只换了个状态**，
       *      只有站在那两屏上看才算数（D-491）。两屏上都在 = 「挪」这个字说错了。
       *
       * ★ 前半句「练了很多次还没过」要真答满 5 次产出题 = 真 AI，**这一趟不核**，记「未走到」。
       * ★ 夹具直接写 `production_state='hard'`：它和真路子**落到的是同一个状态**
       *   （`tests/seed-demo.ts` 也是这么摆的），但它跳过了迁移过程本身 ——
       *   所以它只够回答「挪没挪」，不够回答「什么时候挪」。
       */
      const itemId = seeded.items && seeded.items[1]
      if (!itemId) throw new Error('★ 铺数据时没拿到第二条知识点 —— 局面没摆起来，不往下走')
      const out = await app.evaluate(
        async (_el, a) => {
          /**
           * ★★ `require` 在 CJS 里是**模块级变量，不是全局** —— 这段函数被送进主进程时
           *   未必落在有 `require` 的那个作用域里。三条路依次试，别让一个取不到模块的
           *   小事烧掉整个「机器让给我」的窗口（这台机器排队排了半小时）。
           */
          let Database = null
          if (typeof require === 'function') Database = require('better-sqlite3')
          else if (process.mainModule) Database = process.mainModule.require('better-sqlite3')
          else Database = (await import('better-sqlite3')).default
          const db = new Database(a.dbPath)
          const info = db
            .prepare(
              'update items set production_state = ?, streak = ?, attempts = ?,' +
                ' attempts_in_stage = ?, hard_entries = ?, updated_at = ? where id = ?'
            )
            .run('hard', 0, 6, 0, 1, Date.now(), a.itemId)
          const row = db
            .prepare('select production_state as s, term from items where id = ?')
            .get(a.itemId)
          db.close()
          return { changed: info.changes, state: row ? row.s : null, term: row ? row.term : null }
        },
        { dbPath: join(root, 'data', 'nyx.db'), itemId }
      )
      if (out.changed !== 1 || out.state !== 'hard') {
        throw new Error('★ 攻坚夹具没落地：' + JSON.stringify(out) + ' —— 局面没摆起来，不往下走')
      }
      await page.reload()
      await page.waitForTimeout(1600)
      await page.click('[data-testid="nav-hard"]')
      await page.waitForTimeout(1400)
      console.log('')
      console.log('═══ 攻坚区 · 屏上原话（库里真有一条时）═══')
      console.log('  摆进去的那一条：' + out.term)
      console.log('  ' + (await readScreen()))
      await page.screenshot({ path: join('shots', 'audit-vault-hard-full.png') })
      /** ★★ 关键的一下：回那一讲，看这条还在不在 */
      await clearOverlays()
      await gotoLecture()
      const still = await page.locator('[data-testid="item-rows"]').innerText()
      console.log('')
      console.log('═══ 回原讲次 · 那一条还在不在 ═══')
      console.log(
        '  「' + out.term + '」在讲次页列表里：' +
          (still.includes(out.term) ? '★★ 还在（那就不是「挪」）' : '不在了')
      )
      console.log('  讲次页列表原话：' + oneLine(still))
      await page.screenshot({ path: join('shots', 'audit-vault-hard-back-in-lecture.png') })
    }
  ],

  /** ── B 转来的三条 · **我自己走一遍**（2026-09-16）─────────────
   *
   * ★★ 为什么不照抄 B 的结论：同侪的转述不是我的证据（D-491 那条的另一面）。
   *   这一轮已经有两次「照抄同侪的机制陈述」被实测推翻（`assist-lecture`
   *   其实没坏 · E 说的那个 0×0 窗在源码起的 Electron 里不存在）。
   * ★ 三条共用同一个实例，跟上面四站同一趟跑完 —— 机器只排一次队。
   */
  [
    'b-rename-enter',
    async () => {
      /**
       * B 说：**改名框里按 Enter 没反应**。
       *
       * ★★ 这一站带**反向对照**：按完 Enter 看名字变没变，再点「就叫这个」看它变不变。
       *   只测前一半的话，「没反应」分不出是**这个键没接**还是**整条改名路都坏了** ——
       *   那是两件完全不同的事（前者是漏了一行 `onkeydown`，后者是功能断了）。
       */
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(400)
      await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
      await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
      const lec = page.locator('[data-testid^="nav-lecture-"]').first()
      const before = await lec.innerText()
      await lec.click({ button: 'right' })
      await page.waitForTimeout(600)
      const rn = page.locator('[data-testid="tree-rename"]').first()
      if ((await rn.count()) === 0) throw new Error('★ 右键菜单里没有「改名」—— 局面没摆起来')
      await rn.click()
      await page.waitForTimeout(500)
      const box = page.locator('[data-testid="tree-rename-input"]')
      if (!(await box.isVisible().catch(() => false))) {
        throw new Error('★ 点了「改名」没出输入框 —— 局面没摆起来')
      }
      await box.fill('按了 Enter 的名字')
      await box.press('Enter')
      await page.waitForTimeout(900)
      const afterEnter = await page.locator('[data-testid="project-area"]').innerText()
      console.log('')
      console.log('═══ 改名框按 Enter ═══')
      console.log('  按之前那一行：' + oneLine(before))
      console.log('  按 Enter 之后树里：' + oneLine(afterEnter))
      console.log(
        '  名字变了吗：' +
          (afterEnter.includes('按了 Enter 的名字') ? '变了' : '★★ 没变（Enter 没接）')
      )
      console.log('  输入框还在不在：' + ((await box.isVisible().catch(() => false)) ? '还在' : '关了'))
      await page.screenshot({ path: join('shots', 'audit-b-rename-enter.png') })
      /** ★ 反向对照：同一个框，改点那颗「就叫这个」 */
      const go = page.locator('[data-testid="tree-rename-go"]').first()
      if (await go.isVisible().catch(() => false)) {
        await go.click()
        await page.waitForTimeout(900)
        const afterClick = await page.locator('[data-testid="project-area"]').innerText()
        console.log(
          '  改点「就叫这个」之后：' +
            (afterClick.includes('按了 Enter 的名字') ? '★ 变了（说明整条改名路是通的）' : '也没变')
        )
      } else {
        console.log('  ★ 「就叫这个」不在屏上了 —— 对照做不成，这一条只能算一半')
      }
    }
  ],
  [
    'b-new-project',
    async () => {
      /**
       * B 说：**新建项目不问名字**。
       *
       * ★ 要看的不只是「问没问」，还有**建完之后屏上说了什么** ——
       *   若它当场告诉他「去改个名字」，那是**另一种设计**，不是漏掉了一步；
       *   两者在报告里要分开写（一个是缺陷，一个是取舍）。
       */
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(500)
      const beforeN = await page.locator('[data-testid^="nav-toggle-project-"]').count()
      await page.click('[data-testid="add-project"]')
      await page.waitForTimeout(1200)
      const afterN = await page.locator('[data-testid^="nav-toggle-project-"]').count()
      console.log('')
      console.log('═══ 点「＋ 新建项目」之后 ═══')
      console.log('  点之前项目数：' + beforeN + '　点之后：' + afterN)
      console.log('  屏上有没有问名字的框：' + ((await page.locator('[data-testid="tree-rename-input"]').count()) > 0 ? '有' : '★★ 没有'))
      const note = page.locator('[data-testid="tree-note"]')
      console.log(
        '  建完那句提示：' +
          ((await note.isVisible().catch(() => false)) ? await note.innerText() : '★★ 一句话都没有')
      )
      console.log('  树里现在：' + oneLine(await page.locator('[data-testid="project-area"]').innerText()))
      await page.screenshot({ path: join('shots', 'audit-b-new-project.png') })
    }
  ],
  [
    'b-training-badge',
    async () => {
      /**
       * B 说：**`training` 没有徽章**。
       *
       * ★★ 「没有徽章」单说不成结论 —— 要看的是**三种状态并排时分不分得出来**。
       *   所以这一站现造另外两讲：一讲**不点「开始学」**（待审阅）、一讲整支静默，
       *   和已经开学的那讲摆在同一棵树上，拍一张。
       * ★ 造数据走的是产品自己的 IPC，不改库。
       */
      const made = await page.evaluate(async (unitId) => {
        const a = await window.nyx.data.createLecture(unitId, '这一讲没点开始学')
        await window.nyx.data.addItem(a, 'weigh on', '压在心上', 'B', 'It weighs on me.')
        const b = await window.nyx.data.createLecture(unitId, '这一讲整支静默')
        await window.nyx.data.addItem(b, 'call the shots', '说了算', 'B', 'She calls the shots.')
        await window.nyx.study.startLearning(b)
        await window.nyx.data.silenceLecture(b, true)
        return { review: a, silent: b }
      }, seeded.unit)
      await page.reload()
      await page.waitForTimeout(1800)
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(500)
      await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
      await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
      await page.waitForTimeout(800)
      console.log('')
      console.log('═══ 三种状态的讲次并排在树上 ═══')
      console.log('  造了：' + JSON.stringify(made))
      for (const t of await page.locator('[data-testid^="nav-lecture-"]').allInnerTexts()) {
        console.log('  · ' + oneLine(t))
      }
      await page.screenshot({ path: join('shots', 'audit-b-training-badge.png') })
    }
  ],
  [
    'hint-cost-db',
    async () => {
      /**
       * `practice-hint-cost`：「要提示会记一次没答上来，这一条的间隔也会打回去。」
       *
       * ══ 为什么这一句能劈出**不要 AI** 的一半 ★★ ═══════════════
       *
       * 那颗「需要提示」调的是 `study.usedHint(itemId)` —— **它本身不调模型**
       * （只回一句释义 + 把认读卡按「失败」重排）。要模型的是**走到那一屏**：
       * 题面出自题库，题库是 AI 生的。
       * 所以这一句的两半可以分开走：
       *   · **代价这一半**（这一站）：那条 IPC 真做了什么 —— 不要 AI；
       *   · **屏上这一半**（排进要 AI 那批）：按下去的**那一刻**屏上说了什么、
       *     引导在不在那儿。屏上那句话是第一手判据（D-492），代价再真也替不了它。
       *
       * ══ 这一站特别要看的那一格 ★★★ ═════════════════════════
       *
       * `usedHint` 头一句判的是 `card.silent`：**认读卡已静默的话它直接返回，
       * 一个字都不改排期**（回的是「这张认读卡已静默，不再调整排期」）。
       * 而引导那句话**没有任何例外**。「认读静默 × 产出训练中」不是编出来的局面 ——
       * 它是 Vault 那张 4×4 矩阵里真实的一格。
       * ☞ 所以这一站走两格：**普通卡**一格、**认读卡已静默**一格，各量一次。
       * ★ 第二格要先把 `reading_cards.silent` 置 1（夹具）—— 落到的是同一个状态，
       *   但**跳过了它怎么变成静默的**，所以它只够回答「这一格上那句话成不成立」。
       */
      const id = seeded.items && seeded.items[2]
      if (!id) throw new Error('★ 没拿到第三条知识点 —— 局面没摆起来，不往下走')
      const dbPath = join(root, 'data', 'nyx.db')
      const probe = async () =>
        await app.evaluate(
          async (_el, a) => {
            /** ★★ 同上：`require` 是模块级的，三条路依次试 */
            let Database = null
            if (typeof require === 'function') Database = require('better-sqlite3')
            else if (process.mainModule) Database = process.mainModule.require('better-sqlite3')
            else Database = (await import('better-sqlite3')).default
            const db = new Database(a.dbPath)
            const c = db
              .prepare(
                'select ease, interval_days as interval, reps, lapses, silent, due_at' +
                  ' from reading_cards where item_id = ?'
              )
              .get(a.id)
            const n = db
              .prepare("select count(*) as n from review_logs where item_id = ? and line = 'reading'")
              .get(a.id)
            db.close()
            return { card: c ? c : null, readingLogs: n ? n.n : 0 }
          },
          { dbPath, id }
        )
      const setCardSilent = async (on) =>
        await app.evaluate(
          async (_el, a) => {
            /** ★★ 同上：`require` 是模块级的，三条路依次试 */
            let Database = null
            if (typeof require === 'function') Database = require('better-sqlite3')
            else if (process.mainModule) Database = process.mainModule.require('better-sqlite3')
            else Database = (await import('better-sqlite3')).default
            const db = new Database(a.dbPath)
            const r = db
              .prepare('update reading_cards set silent = ?, updated_at = ? where item_id = ?')
              .run(a.on, Date.now(), a.id)
            db.close()
            return r.changes
          },
          { dbPath, id, on: on ? 1 : 0 }
        )

      console.log('')
      console.log('═══ 提示的代价 · ① 普通认读卡 ═══')
      const b1 = await probe()
      if (!b1.card) {
        throw new Error('★ 这一条没有认读卡（startLearning 没建卡？）—— 局面没摆起来，不往下走')
      }
      console.log('  按之前：' + JSON.stringify(b1))
      const r1 = await page.evaluate(async (i) => await window.nyx.study.usedHint(i), id)
      const a1 = await probe()
      console.log('  IPC 回的那句：' + JSON.stringify(r1.reason))
      console.log('  按之后：' + JSON.stringify(a1))
      console.log(
        '  间隔打回了吗：' +
          (a1.card.interval < b1.card.interval || a1.card.lapses > b1.card.lapses
            ? '打回了'
            : '★★ 没动')
      )
      console.log('  多记了几条认读流水：' + (a1.readingLogs - b1.readingLogs))

      console.log('')
      console.log('═══ 提示的代价 · ② 这张认读卡已经静默 ═══')
      if ((await setCardSilent(true)) !== 1) {
        throw new Error('★ 没能把认读卡摆成静默 —— 第二格走不了，不吃这个失败')
      }
      const b2 = await probe()
      const r2 = await page.evaluate(async (i) => await window.nyx.study.usedHint(i), id)
      const a2 = await probe()
      console.log('  按之前：' + JSON.stringify(b2))
      console.log('  IPC 回的那句：' + JSON.stringify(r2.reason))
      console.log('  按之后：' + JSON.stringify(a2))
      console.log(
        '  这一格上「间隔也会打回去」成立吗：' +
          (a2.card.interval < b2.card.interval || a2.card.lapses > b2.card.lapses
            ? '成立'
            : '★★ 不成立 —— 引导那句话没有例外，这儿有')
      )
      console.log('  多记了几条认读流水：' + (a2.readingLogs - b2.readingLogs))
      /** ★ 收尾：把夹具拨回去，免得后面的站踩在这个局面上 */
      await setCardSilent(false)
    }
  ]
]

/**
 * ★★ 每一站之前先把残留的浮层收掉。
 *   上一站开过 ⋮ 菜单的话，它那张 `detail-menu-scrim` 会把下一站的点击整个吃掉，
 *   而报出来的错是「点不到 nav-home」—— 跟真正的问题毫无关系。
 *   （同一张脸这一轮已经出现过四次。）
 */
const clearOverlays = async () => {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
}

const want = process.argv.slice(2)
for (const [name, go] of STOPS) {
  if (want.length && !want.includes(name)) continue
  await clearOverlays()
  await go()
  await page.waitForTimeout(900)
  await page.screenshot({ path: join('shots', `audit-${name}.png`) })
  console.log('')
  console.log('══════ ' + name + ' ══════')
  console.log(await readScreen())
}

/**
 * ★ 把这一趟起的**每一个窗**都报出来（E 2026-09-16 说打包产物里有一个
 *   `http://nyx.assist/` 、0×0 的隐藏窗，会被 `mainWindow` 当主窗交出去）。
 *   本仓源码里 `grep nyx.assist` 是 **0 处**，四个窗全带标记 ——
 *   所以先量，再决定要不要改那个共用判据。
 */
console.log('')
console.log('这一趟的窗：')
for (const w of app.windows()) {
  try {
    const size = await w.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    console.log('  ' + w.url() + '   ' + size.w + 'x' + size.h)
  } catch {
    console.log('  (读不到，可能正在关) ' + w.url())
  }
}

console.log('')
console.log('铺的数据：' + JSON.stringify(seeded))
await app.close()
