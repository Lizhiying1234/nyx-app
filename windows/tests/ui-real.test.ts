import { silenceScopeAction } from '../src/core/silence.ts'
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { captureApp, keepOrClean } from './keep-on-fail.ts'

/**
 * 「加了功能」≠「功能有用」· 使用者 2026-08-10
 *
 * 他的原话：「你自己再整体检查一遍，是不是我让你加的功能实际上根本没用」。
 * 他是对的 —— 这一轮我已经栽过两次同一种病：
 *   · 提示词全改了，但他那份没更新，**几轮工作对他一个字没生效**
 *   · SQL 列名写错，静态检查全绿，他一点复选框就炸
 * 两次的共同点：**我验的是「代码在那儿」，不是「点下去有反应」**。
 *
 * 所以这一套只做一件事：**把每个新功能真的操作一遍，断言看得见的结果。**
 * 不查内部状态、不查数据库有没有那一行 —— 只看使用者能看见的东西。
 *
 * 拖拽尤其如此：`reorder()` 的单元测试全绿，而他一拖发现根本拖不动。
 * 后端对了不等于拖得动。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-ui-'))

let app: ElectronApplication
let page: Page

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  captureApp(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')


  // 铺一棵树：1 个项目 · 2 个单元 · 单元 A 下 2 讲
  await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('拖拽验收')
    const u1 = await window.nyx.data.createUnit(p, '单元 A')
    const u2 = await window.nyx.data.createUnit(p, '单元 B')
    await window.nyx.data.createLecture(u1, '第一讲')
    await window.nyx.data.createLecture(u1, '第二讲')
    await window.nyx.data.createLecture(u2, '别处的讲')
    const p2 = await window.nyx.data.createProject('第二个项目')
    void p2
  })
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(400)
})

after(async () => {
  await app?.close()
  keepOrClean(dataRoot)
})

/**
 * 确保某一行是**展开**的。
 *
 * 不能无脑点一下 —— 那一行的 onclick 是 toggle，已经展开时点一下反而收起来。
 * 第一版就是这么写的，三条用例一起超时，而病根是测试自己不稳，不是功能坏。
 */
async function ensureOpen(page: Page, rowSel: string, childSel: string): Promise<void> {
  const child = page.locator(childSel).first()
  if (await child.isVisible().catch(() => false)) return
  await page.locator(rowSel).first().click()
  await page.waitForTimeout(400)
  if (!(await child.isVisible().catch(() => false))) {
    // 点反了（原来是开着的），再点一次
    await page.locator(rowSel).first().click()
    await page.waitForTimeout(400)
  }
}


/**
 * 一路点到某一讲的工作台，**自己纠正展开状态**。
 *
 * 为什么不用 `ensureOpen` 串起来：那个是「一层一层各点各的」，
 * 而侧边栏的展开状态会被前面的用例带偏 —— 项目本来就是展开的时候，
 * 点一下反而收起来。诊断脚本在干净环境里一路都对，
 * 放进整套里就超时，差别只在**进来时的状态不一样**。
 *
 * 所以改成看着结果走：每一轮先看目标可见没有，可见就点它，
 * 否则往上补一层。最多三轮 —— 三轮还进不去就是真坏了，让它超时报出来。
 */
async function openLecture(page: Page, projectName: string, unitName: string, lecId: number): Promise<void> {
  const lecSel = `[data-testid="nav-lecture-${lecId}"]`
  const unitSel = `[data-testid^="nav-toggle-unit-"]:has-text("${unitName}")`
  const projSel = `[data-testid^="nav-toggle-project-"]:has-text("${projectName}")`
  const vis = async (sel: string): Promise<boolean> =>
    await page.locator(sel).first().isVisible().catch(() => false)

  for (let i = 0; i < 3; i++) {
    if (await vis(lecSel)) {
      await page.locator(lecSel).click()
      // 超时就把屏幕上到底是什么一起报出来 —— 光说「等不到 matbar」没法判断是哪一层的事
      await page.waitForSelector('[data-testid="matbar"]', { timeout: 8000 }).catch(async () => {
        throw new Error(
          `点进第 ${lecId} 讲之后没有 matbar。屏幕上是：` +
            (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 500)
        )
      })
      return
    }
    if (await vis(unitSel)) await page.locator(unitSel).first().click()
    else await page.locator(projSel).first().click()
    await page.waitForTimeout(450)
  }
  throw new Error(`点不进《${projectName} / ${unitName}》第 ${lecId} 讲`)
}

describe('★ 拖拽排序：他说「没做好」——先证明它到底动不动', () => {
  it('项目行是可拖的（draggable 属性真的挂上了）', async () => {
    const rows = page.locator('[data-testid^="nav-toggle-project-"]')
    await rows.first().waitFor()
    const n = await rows.count()
    assert.ok(n >= 2, `只有 ${n} 个项目，拖不起来`)
    for (let i = 0; i < n; i++) {
      assert.equal(
        await rows.nth(i).getAttribute('draggable'),
        'true',
        '项目行没有 draggable —— 根本拖不动'
      )
    }
  })

  it('★ 真的拖一次项目：松手之后顺序要变', async () => {
    const before = await page.locator('[data-testid^="nav-toggle-project-"] .nm-t').allInnerTexts()
    assert.ok(before.length >= 2, `项目不够：${before.join('/')}`)

    const a = page.locator('[data-testid^="nav-toggle-project-"]').first()
    const b = page.locator('[data-testid^="nav-toggle-project-"]').nth(1)
    await a.dragTo(b)
    await page.waitForTimeout(700)

    const after = await page.locator('[data-testid^="nav-toggle-project-"] .nm-t').allInnerTexts()
    assert.notDeepEqual(
      after,
      before,
      `拖完顺序没变：${before.join(' / ')} —— 他说的「拖不动」就是这个`
    )
    assert.deepEqual(after, [before[1], before[0]], `换位置换错了：${after.join(' / ')}`)
  })

  it('★ 拖完刷新还在（真的落库了，不是界面自己动了一下）', async () => {
    const shown = await page.locator('[data-testid^="nav-toggle-project-"] .nm-t').allInnerTexts()
    await page.reload()
    await page.waitForSelector('[data-testid^="nav-toggle-project-"]')
    await page.waitForTimeout(400)
    const after = await page.locator('[data-testid^="nav-toggle-project-"] .nm-t').allInnerTexts()
    assert.deepEqual(after, shown, '刷新之后顺序回去了 —— 只改了界面，没落库')
  })
})

describe('★ 单元 / lecture 的拖拽，以及「不许跨级」', () => {
  before(async () => {
    await page.click('[data-testid="nav-home"]')
    await ensureOpen(
      page,
      '[data-testid^="nav-toggle-project-"]:has-text("拖拽验收")',
      '[data-testid^="nav-toggle-unit-"]'
    )
  })

  it('★ 同一项目内的两个单元能换位置', async () => {
    const rows = page.locator('[data-testid^="nav-toggle-unit-"]')
    await rows.first().waitFor()
    const before = await rows.locator('.nm-t').allInnerTexts()
    assert.ok(before.length >= 2, `单元不够：${before.join('/')}`)
    await rows.first().dragTo(rows.nth(1))
    await page.waitForTimeout(700)
    const after = await page.locator('[data-testid^="nav-toggle-unit-"] .nm-t').allInnerTexts()
    assert.deepEqual(after, [before[1], before[0]], `单元没换位置：${after.join(' / ')}`)
  })

  it('★ 同一单元内的两讲能换位置', async () => {
    /**
     * 子元素判据要**认名字**。
     * 第一版用的是 `[data-testid^="nav-lecture-"]` —— 单元 B 底下那一讲已经可见，
     * ensureOpen 就以为单元 A 也开着，于是拖的是别人的行。
     * 「看起来对的选择器」是这类测试最常见的假失败来源。
     */
    await ensureOpen(
      page,
      '[data-testid^="nav-toggle-unit-"]:has-text("单元 A")',
      '[data-testid^="nav-lecture-"]:has-text("第一讲")'
    )
    const a = page.locator('[data-testid^="nav-lecture-"]:has-text("第一讲")')
    const b = page.locator('[data-testid^="nav-lecture-"]:has-text("第二讲")')
    const idsOf = async (): Promise<string[]> =>
      (await page.locator('[data-testid^="nav-lecture-"]:visible').all()).reduce<Promise<string[]>>(
        async (acc, l) => [...(await acc), (await l.getAttribute('data-testid')) ?? ''],
        Promise.resolve([])
      )
    const before = (await idsOf()).filter((x) => x)
    await a.dragTo(b)
    await page.waitForTimeout(700)
    const after = (await idsOf()).filter((x) => x)
    assert.notDeepEqual(after, before, `lecture 顺序没变：${after.join(' / ')}`)
  })

  it('★ 跨级拖不动：把 lecture 拖到单元上，什么都不该发生', async () => {
    const lec = page.locator('[data-testid^="nav-lecture-"]:has-text("第一讲")')
    const unit = page.locator('[data-testid^="nav-toggle-unit-"]:has-text("单元 B")')
    const beforeU = await page.locator('[data-testid^="nav-toggle-unit-"] .nm-t').allInnerTexts()
    const beforeCount = await page.locator('[data-testid^="nav-lecture-"]:visible').count()
    await lec.dragTo(unit)
    await page.waitForTimeout(600)
    assert.deepEqual(
      await page.locator('[data-testid^="nav-toggle-unit-"] .nm-t').allInnerTexts(),
      beforeU,
      '把 lecture 拖到单元上，单元的顺序被改了'
    )
    assert.equal(
      await page.locator('[data-testid^="nav-lecture-"]:visible').count(),
      beforeCount,
      '这一讲被搬走了 —— 6.1 明确说不允许跨级'
    )
  })
})

describe('★ 4.2 静默级联：项目从项目栏消失，静默库里放得回来', () => {
  it('右键静默一个项目 → 它从项目栏消失', async () => {
    await page.click('[data-testid="nav-home"]')
    const row = page.locator('[data-testid^="nav-toggle-project-"]:has-text("第二个项目")')
    await row.waitFor()
    const id = (await row.getAttribute('data-testid'))!.replace('nav-toggle-project-', '')
    await page.evaluate((pid) => window.nyx.data.setSilent('project', Number(pid), true), id)
    await page.reload()
    await page.waitForSelector('[data-testid^="nav-toggle-project-"]')
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('[data-testid^="nav-toggle-project-"]:has-text("第二个项目")').count(),
      0,
      '静默了却还在项目栏里 —— 4.2 说它应该只出现在静默知识库'
    )
  })

  it('★ 静默知识库那一页看得见它，而且点一下就放回来', async () => {
    await page.click('[data-testid="nav-lib-silent"]')
    await page.waitForTimeout(600)
    const node = page.locator('[data-testid^="silent-node-project-"]')
    await node.waitFor({ timeout: 8000 })
    assert.match(await node.innerText(), /第二个项目/, '静默库里看不见这个项目 —— 那就是个陷阱')

    await page.locator('[data-testid^="unsilence-project-"]').first().click()
    await page.waitForTimeout(700)
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('[data-testid^="nav-toggle-project-"]:has-text("第二个项目")').count(),
      1,
      '取消静默之后没回到项目栏'
    )
  })
})

describe('★ 4.3 垃圾箱：单元删得掉、回得来，彻底删除不报错', () => {
  it('删掉一个单元 → 垃圾箱里有「单元」这一格', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.evaluate(async () => {
      const t = await window.nyx.data.tree()
      const p = t.find((x) => x.name === '拖拽验收')!
      await window.nyx.data.softDelete('unit', p.units[0].id)
    })
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(600)
    const rows = page.locator('[data-testid^="trash-unit-"]')
    assert.ok(await rows.count() >= 1, '垃圾箱里没有「单元」这一格 —— 4.3 明确要求新增')
  })

  it('★ 恢复它 → 项目栏里真的看得见（4.3 点名的那个 bug）', async () => {
    const row = page.locator('[data-testid^="trash-unit-"]').first()
    const name = await row.innerText()
    await row.click() // 勾上它
    await page.click('[data-testid="trash-restore-picked"]')
    await page.waitForTimeout(900)
    await page.click('[data-testid="nav-home"]')
    await ensureOpen(
      page,
      '[data-testid^="nav-toggle-project-"]:has-text("拖拽验收")',
      '[data-testid^="nav-toggle-unit-"]'
    )
    const units = await page.locator('[data-testid^="nav-toggle-unit-"] .nm-t').allInnerTexts()
    assert.ok(
      units.some((u) => name.includes(u)),
      `恢复出来的单元在项目栏里看不见：垃圾箱里那条是「${name}」，项目栏里是 ${units.join('/')}`
    )
  })
})

describe('★ 4.3 彻底删除：他报过「出现异常」', () => {
  it('★ 勾一条彻底删除，不许报错，而且真的没了', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.evaluate(async () => {
      const t = await window.nyx.data.tree()
      const p = t.find((x) => x.name === '拖拽验收')!
      await window.nyx.data.softDelete('unit', p.units[0].id)
    })
    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(600)
    const row = page.locator('[data-testid^="trash-unit-"]').first()
    await row.waitFor()
    const before = await page.locator('[data-testid^="trash-unit-"]').count()
    await row.click()
    await page.click('[data-testid="trash-purge"]')
    await page.click('[data-testid="trash-purge-dlg-confirm"]')
    await page.waitForTimeout(1000)

    // 以前这里抛 FOREIGN KEY constraint failed
    assert.equal(
      await page.locator('[data-testid="trash-error"]').count(),
      0,
      '彻底删除报错了：' + (await page.locator('[data-testid="trash-error"]').innerText().catch(() => ''))
    )
    assert.equal(
      await page.locator('[data-testid^="trash-unit-"]').count(),
      before - 1,
      '点了彻底删除，垃圾箱里还在'
    )
  })
})

describe('★ 7 题型多选、9 数据体检：真的点得动吗', () => {
  it('★ 设置里的数据体检点得动，而且给得出条数', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-data"]')
    await page.click('[data-testid="audit-run"]')
    await page.waitForSelector('[data-testid="audit-clean"], [data-testid="audit-findings"]', {
      timeout: 15000
    })
    const clean = await page.locator('[data-testid="audit-clean"]').count()
    const found = await page.locator('[data-testid="audit-findings"]').count()
    assert.equal(clean + found, 1, '体检点完既没说「都通过」也没列出问题')
  })

  /**
   * 「不再收录的表达」和备份列表已从设置页撤掉（使用者 2026-08-10：
   * 「都在界面上面消失…可以在后台文件夹中显示，但是不要在前台显示」）。
   *
   * 撤掉一个东西和加一个东西一样要验收 —— 否则下一轮很容易被顺手加回来，
   * 而他上一次说的话就白说了。
   */
  it('★ 「不再收录的表达」和备份列表都不在设置页了', async () => {
    assert.equal(
      (await page.locator('[data-testid="ledger-empty"]').count()) +
        (await page.locator('[data-testid="ledger-list"]').count()),
      0,
      '「不再收录的表达」又回到界面上了'
    )
    assert.equal(
      await page.locator('[data-testid="backup-row"]').count(),
      0,
      '备份列表又回到界面上了'
    )
    // 撤的是显示不是机制：备份放在哪儿还写在页面上，他要看就去那个文件夹
    assert.match(
      await page.innerText('body'),
      /backups/,
      '连备份放在哪儿都不告诉他了 —— 那才是真的看不见'
    )
  })
})

/**
 * ★ I-114 · 原句摘抄 —— 他的原话「原句摘抄的也不行」
 *
 * 复现的是**他真实的操作顺序**，这一点是关键：
 *
 *     ① 先贴「我的收集」   ← 这一讲还没有原文
 *     ② 再传原文
 *
 * I-107 把「出处必须是原文里真实那一句」做对了，但只在写入那一刻找一次。
 * 第 ① 步时原文还不存在，出处只能记他打的那一行；第 ② 步没有任何东西回头看一眼。
 * 于是同一讲里一半出处是真句子、一半是他自己打的那行，**而且不报错**。
 * 他库里 384 条出处，108 条「出处 = 词条」。
 *
 * 所以这条用例先断言 ① 之后**确实**是坏的（负向对照 —— 拿掉修复它会红），
 * 再断言 ② 之后被补成了真句子。
 */
describe('★ I-114 原句摘抄：先贴收集、后传原文，出处要补回来', () => {
  /** 他自己打的那一行：大小写、单复数、连字符都和原文对不上 —— 真实数据就长这样 */
  const TYPED = 'The power of disposal of modern nation states'
  const SENTENCE =
    'You compare that to the powers at the disposal of modern nation-states, and you can see the contrast.'
  const ORIGINAL = `Agrarian empires looked mighty on a map. ${SENTENCE} And that gap is what this lecture is about.`

  let lectureId = 0
  let itemId = 0

  it('① 贴收集时原文还没到 —— 出处只能是他打的那一行', async () => {
    const made = await page.evaluate(async (typed) => {
      const p = await window.nyx.data.createProject('摘抄验收')
      const u = await window.nyx.data.createUnit(p, '材料单元')
      const l = await window.nyx.data.createLecture(u, '先收集后传原文')
      const r = await window.nyx.data.addChunks(l, '我的收集', typed)
      return { lectureId: l, itemId: r.added[0]?.id ?? 0 }
    }, TYPED)
    lectureId = made.lectureId
    itemId = made.itemId
    assert.ok(itemId > 0, '收集没落库，后面的都不用看了')

    await openItem(page, lectureId, itemId)
    const q = (await page.locator('[data-testid="detail-quote"]').innerText()).replace(/^"|"$/g, '')
    assert.equal(
      q.trim().toLowerCase(),
      TYPED.toLowerCase(),
      '这一步的出处本来就该等于他打的那行（原文还没到）'
    )
  })

  it('★ ② 原文一传，出处自动补成原文里的那一整句', async () => {
    await page.evaluate(
      ({ lec, text }) => window.nyx.data.addOriginal(lec, '讲稿', text),
      { lec: lectureId, text: ORIGINAL }
    )
    await page.reload()
    await page.waitForSelector('[data-testid^="nav-toggle-project-"]')
    await openItem(page, lectureId, itemId)

    const q = (await page.locator('[data-testid="detail-quote"]').innerText())
      .replace(/^"|"$/g, '')
      .trim()
    assert.equal(
      q,
      SENTENCE,
      `出处没补回来，还是「${q}」—— 他说的「原句摘抄的也不行」就是这个`
    )
  })

  it('原文里确实没有的那种，界面上要说清楚，不能冒充出处', async () => {
    const id = await page.evaluate(async (lec) => {
      const r = await window.nyx.data.addChunks(lec, '我的收集', 'Notice the rhetorical pivot')
      return r.added[0]?.id ?? 0
    }, lectureId)
    assert.ok(id > 0)
    await openItem(page, lectureId, id)
    const note = await page.locator('.qs').first().innerText()
    assert.match(
      note,
      /原文里没找到这句/,
      '这条在原文里根本没有，却当成原文出处显示 —— 认读卡照着它挖空是挖不出来的'
    )
  })
})

describe('★ 题型管理：他能不能真的加一种、停用、删掉', () => {
  before(async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="set-tab-tutor"]')
    await page.waitForTimeout(500)
    // ★ D-488′：题型在侧树的「练习 › 产出练习」那片叶子底下（一次点击就到）
    await page.click('[data-testid="parea-drill"]')
    await page.click('[data-testid="ptab-produce"]')
    await page.waitForTimeout(300)
  })

  it('一张平列表，内置 12 种都在，页面上不出现「档」', async () => {
    await page.locator('[data-testid="qtype-list"]').waitFor()
    assert.equal(
      await page.locator('[data-testid^="qtype-chip-"]').count(),
      12,
      '内置题型没铺满 —— 打开就该能用，不该让他从零配'
    )
    // ★ 2026-09-03 使用者要求：这一页不再有档位概念
    assert.equal(
      await page.locator('[data-testid^="qtype-tier-"]').count(),
      0,
      '档位分组还在 —— 使用者明确要求这一页只管理题型本身'
    )
    assert.doesNotMatch(
      await page.innerText('[data-testid="qtype-list"]'),
      /第 \d 档/,
      '列表上还印着「第 N 档」'
    )
  })

  it('★ 加一种：填名字、写提示词 → 列表里真的多一颗（不用选档）', async () => {
    await page.click('[data-testid="qtype-new"]')
    await page.waitForTimeout(300)
    assert.equal(
      await page.locator('[data-testid="qtype-tier"]').count(),
      0,
      '编辑卡里还有难度档选择器'
    )
    await page.fill('[data-testid="qtype-name"]', '看图说话')
    await page.fill('[data-testid="qtype-brief"]', '给个场景，讲出来')
    /**
     * ★ I-187（2026-09-15）· 自建题型填的是 `qtype-guide`，不再是 `qtype-prompt`。
     *   「自己写出题提示词」那条输入方式退役了：内置题型只按 `guide` 出题，
     *   而自建题型**没有出厂形状可盖** —— `guide` 就是它自己的形状。
     */
    await page.fill('[data-testid="qtype-guide"]', 'Describe a scene and ask them to narrate it.')
    await page.click('[data-testid="qtype-save"]')
    await page.waitForTimeout(600)
    assert.equal(
      await page.locator('.qtm-pill:has-text("看图说话")').count(),
      1,
      '存完在列表里找不到它'
    )
  })

  it('★ 停用它 → 列表上一眼看得出来是关着的', async () => {
    const pill = page.locator('.qtm-pill:has-text("看图说话")')
    await pill.locator('[data-testid^="qtype-toggle-"]').click()
    await page.waitForTimeout(500)
    assert.ok(
      (await pill.getAttribute('class'))?.includes('off'),
      '停用了但看不出来 —— 那这个开关等于没有'
    )
  })

  it('★ 内置题型不给删除按钮，而且说得出为什么', async () => {
    await page.locator('[data-testid="qtype-list"] [data-testid^="qtype-chip-"]').first().click()
    await page.waitForTimeout(300)
    // 内置的删不掉，先加一种自己的凑数再删它 —— 这里直接验内置的删除按钮不给出现
    assert.equal(
      await page.locator('[data-testid="qtype-del"]').count(),
      0,
      '内置题型给了删除按钮 —— 删掉之后历史题目认不出来源'
    )
    await page.click('[data-testid="qtype-cancel"]')
  })

  it('自己加的那种可以删掉', async () => {
    await page.locator('.qtm-pill:has-text("看图说话") [data-testid^="qtype-chip-"]').click()
    await page.waitForTimeout(300)
    await page.click('[data-testid="qtype-del"]')
    await page.waitForTimeout(600)
    assert.equal(
      await page.locator('.qtm-pill:has-text("看图说话")').count(),
      0,
      '删了还在列表里'
    )
  })
})

/**
 * ★★★ 认读测试：**牌面（内容，多选）+ 出题规则（一份 Prompt）**
 *   · D-479（使用者 2026-09-08）· T-9.17
 *
 * ── 这一族原来钉的是什么，为什么整族改写 ──────────────────
 *
 * 原来是「五份整段提示词选一份」：弹窗里五颗 + 新建、点一颗「用这份」、
 * 入口上写「当前：某某」。他 2026-09-08 把这个形状取消了 ——
 * **牌面是可以多选的内容模块，出题规则是一份统一的 Prompt**。
 * 所以这里不是把旧判据放宽，是**换了一件要钉的事**：
 *   ① 设置页上仍然只有入口，正文框不许铺在页面上（2026-09-04 那条原话照旧管用）；
 *   ② 勾了哪几面，屏幕上说得出来，而且**真的落库**（关掉再开还在）；
 *   ③ **至少留一面** —— 关掉最后一面时当场被拒、说人话，而不是静默退回机械挖空；
 *   ④ 规则改过 / 改回出厂，入口上那句跟着变。
 *
 * ★ ③ 是这一族里最值钱的一条：判据在主进程（`main/reading-faces.ts`），
 *   界面不自己判（第二份判据）。所以只有走到屏幕这一层才验得到它接没接上。
 */
describe('★★★ 认读测试：牌面（多选）+ 出题规则（一份）· D-479', () => {
  /**
   * ★★ D-488 之后这里改成 `beforeEach`，理由值得写下来：
   *
   * 这个 describe 里**每一条都站在「练习 › 认读测试」那一页上**。原来 `before()` 跑一次就够，
   * 因为那时候认读块是常开的、谁也切不走。现在它是个 Tab，**任何一条用例只要切去别处，
   * 后面全部踩空** —— 而且报出来的错是「点不到 faces-open」，看着像产品坏了。
   * 2026-09-15 真踩了一次：新加的那条要切到「产出」去数三段，后面三条当场全红。
   *
   * ★ 与其指望每条用例记得收尾，不如**每条开跑前统一拨回来**（和 sync 那套 D-438
   *   自动裁决的处理同一条道理）：每条用例自己声明前提，谁都不依赖上一条留下了什么。
   */
  beforeEach(async () => {
    /**
     * ★ 先收掉上一条留下的浮层。弹窗是整屏 `.ov.on`，**它会把导航的点击整个吃掉** ——
     *   报出来的错是「点不到 nav-settings，超时 8000ms」，看着像导航坏了，
     *   其实是上一条没关窗。2026-09-15 真踩过一次（三条用例连带 cancelled）。
     */
    for (let i = 0; i < 3 && (await page.locator('.ov.on').count()) > 0; i++) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
    }
    await page.click('[data-testid="nav-settings"]')
    await page.waitForTimeout(250)
    await page.click('[data-testid="set-tab-tutor"]')
    await page.waitForTimeout(250)
    await page.click('[data-testid="parea-drill"]')
    await page.click('[data-testid="ptab-reading"]')
    await page.waitForSelector('[data-testid="mode-reading"]')
  })

  /**
   * ══ 这一条 2026-09-15 换了钉的东西（D-486），说清楚 ══════════════
   *
   * **原来钉**：设置页上只有「牌面」「出题规则」两颗入口，正文框不许铺在页面上
   *   （2026-09-04 要改掉的是「十四行正文框铺满一页」那个形态）。
   * **现在钉**：三层 × 两模式 —— 牌面已经从弹窗搬到页面上（预览卡，使用者第五条
   *   要「看得见这张卡最后长什么样」），所以「只有两颗入口」这句话已经不成立了。
   *
   * 仍然值得钉的那一半**一个字没松**：**正文框不许铺在页面上**
   *   （`rules-text` 已随 D-482 整条退役，这里连它的名字一起钉死：再出现就是有人把它加回来了）。
   * 新钉的那一半：**两块 × 三段，段名逐字一致、段序一致** —— 那正是使用者第六条要的效果，
   *   而它是「看着对」的东西，没有闸就会在下一次改版里悄悄散掉。
   */
  /**
   * ══ D-488（2026-09-15）这一条又换了一次形态，逐条说清换了什么、**没换**什么 ══
   *
   * **没换**（一个字没松）：三段逐字一致 · 正文框不许铺在页面上 · 牌面是预览卡不是入口。
   * **换了**：认读 / 产出是两个平级 Tab，不再同屏，所以各自切过去数。
   * **补上了一个洞**：原来这条的标题写着「两模式……逐字一致」，可它**只断言了认读那一块** ——
   *   `seg('mode-practice')` 那个助手写好了却一次都没调。于是「两块一致」这句话
   *   从头到尾**没有任何东西在验**。现在两块都数，而且**互相比**。
   * **新钉**：块里不许再顶一个和 Tab 同名的标题（他点名的第一条）。
   */
  it('★★★ 三层 × 两模式：两块段名段序互相逐字对齐；名字只在 Tab 上；正文框仍不许铺在页面上', async () => {
    /** 三段同序、同名 —— 逐字比，差一个字都算漂 */
    const seg = async (mode: string): Promise<string[]> =>
      (await page.locator(`[data-testid="${mode}"] ~ * .lyrh .lh-n, [data-testid="${mode}"] .lyrh .lh-n`)
        .allInnerTexts()).map((x) => x.trim())

    for (const id of ['faces-modal', 'rules-modal', 'rules-text']) {
      assert.equal(
        await page.locator(`[data-testid="${id}"]`).count(),
        0,
        `★ 还没点就把「${id}」摆在设置页上了 —— 2026-09-04 要改掉的正是这个形态`
      )
    }
    const readSeg = await seg('mode-reading')
    assert.deepEqual(readSeg, ['牌面', '题型', '出题规则'], '★★ 认读那块的三段名字 / 顺序不对')
    /** 认读牌面现在在页面上（预览卡），不是入口 */
    assert.ok(
      (await page.locator('[data-testid^="face-card-"]').count()) >= 4,
      '★★ 认读牌面没铺成预览卡 —— 他就看不见这张卡最后长什么样'
    )

    await page.click('[data-testid="parea-drill"]')
    await page.click('[data-testid="ptab-produce"]')
    await page.locator('[data-testid="mode-practice"]').waitFor()
    const prodSeg = await seg('mode-practice')
    assert.deepEqual(prodSeg, ['牌面', '题型', '出题规则'], '★★ 产出那块的三段名字 / 顺序不对')
    assert.deepEqual(
      prodSeg,
      readSeg,
      '★★★ 两块的三段没对齐 —— 使用者第六条要的正是「两块并排看过去三段一一对齐」'
    )

    /** ★★★ D-488 他点名的第一条：名字归 Tab，块里不许再顶一个同名标题 */
    assert.match(
      await page.innerText('[data-testid="prompt-nav"] button.on'),
      /产出练习/,
      '★ 名字要在**选中的那个二级 Tab** 上说 —— 不然他不知道自己在配哪一个'
    )
    assert.doesNotMatch(
      await page.innerText('[data-testid="mode-practice"]'),
      /产出练习/,
      '★★★ D-488：块里又顶了一个「产出练习」—— 那正是他点名删掉的空标题'
    )
  })

  it('★ 点开牌面 → 四面都在，每一面都说得出「给他看什么」', async () => {
    await page.click('[data-testid="faces-open"]')
    await page.waitForSelector('[data-testid="faces-modal"]')
    /**
     * ★ 2026-09-14：这一弹窗里现在还有「新建牌面」那一套控件
     *   （`face-new` / `face-form` / `face-name` …），它们也是 `face-` 开头。
     *   判据一个字没变（「出厂四面」），只是认得更准：**只数那几行**。
     */
    const rows = page.locator('.sr[data-testid^="face-"]')
    assert.equal(await rows.count(), 4, '出厂四面（改条数要有人交代为什么）')
    for (const id of ['cloze', 'scenario', 'zh-recall', 'define']) {
      const t = await page.innerText(`[data-testid="face-${id}"]`)
      assert.ok(t.trim().length > 6, `「${id}」那一行只有名字，没说这一面给他看什么`)
    }
    /**
     * ★★ 开完要关上（D-486 之后必须有这一句）——
     *   勾选搜到页面上之后，后面那几条点的是**页面上**的牌面卡，
     *   浮层不关就把它们全挡住 —— 表现是三条一起 8 秒超时，
     *   而那看着像“那几条自己坏了”。
     */
    await page.click('[data-testid="faces-close"]')
    await page.waitForSelector('[data-testid="faces-modal"]', { state: 'detached', timeout: 5000 })
  })

  /**
   * ★ 2026-09-15（D-486）· 勾选从弹窗搬到了页面上的预览卡，判据一个字没变：
   *   **取消了就要真落库**，不许「关掉再开又自己勾回来」——那是「我的选择不算数」。
   *   原来还钉「入口上的数字跟着减」，那颗入口已经不显示数字了（牌面本身就在页面上，
   *   数不数得清一眼看得见），所以那半改成钉**选中态**本身。
   */
  it('★★ 取消一面 → 真落库：重新进这一页还是取消着', async () => {
    await page.click('[data-testid="face-card-scenario"]')
    await page.waitForTimeout(600)
    assert.equal(
      await page.locator('[data-testid="face-card-scenario"].on').count(),
      0,
      '★ 点了没取消'
    )

    /** 离开这一页再回来 —— 值是从库里重新读的，不是组件里的残留状态 */
    await page.click('[data-testid="set-tab-practice"]')
    await page.waitForTimeout(300)
    await page.click('[data-testid="set-tab-tutor"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="parea-drill"]')
    await page.click('[data-testid="ptab-reading"]')
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('[data-testid="face-card-scenario"].on').count(),
      0,
      '★★ 回到这一页又自己勾回来了 —— 那就是「我的选择不算数」'
    )
  })

  /**
   * ★★★ 一面都不勾 = 认读再也出不了 AI 牌面（安静退回机械挖空），
   *   而那件事他在屏幕上看不出原因。所以最后一面必须**当场拒绝 + 说人话**。
   *   判据在主进程（`main/reading-faces.ts::saveReadingFaces`），界面不自己判 ——
   *   这一条钉的就是「那句人话真的走到屏幕上了」。
   */
  it('★★★ 关掉最后一面 → 当场拒绝，说清会发生什么（不静默、也不替他勾回来）', async () => {
    for (const id of ['zh-recall', 'define']) {
      await page.click(`[data-testid="face-card-${id}"]`)
      await page.waitForTimeout(400)
    }
    assert.equal(
      await page.locator('[data-testid^="face-card-"].on').count(),
      1,
      '★ 只该剩一面了'
    )

    await page.click('[data-testid="face-card-cloze"]') // 最后一面
    await page.waitForSelector('[data-testid="readp-error"]', { timeout: 5000 })
    assert.match(
      await page.innerText('[data-testid="readp-error"]'),
      /至少留一面|机械挖空/,
      '★★★ 拒是拒了，但没说清为什么 —— 他只会以为这个开关坏了'
    )
    assert.equal(
      await page.locator('[data-testid="face-card-cloze"].on').count(),
      1,
      '★★★ 被拒之后那一面居然真的关掉了 —— 库和屏幕对不上'
    )

    // 收尾：勾回全开，别影响后面的用例
    for (const id of ['scenario', 'zh-recall', 'define']) {
      await page.click(`[data-testid="face-card-${id}"]`)
      await page.waitForTimeout(400)
    }
  })

  /**
   * ══ 这一条 2026-09-15 整条换了（D-482）══════════════════════════
   *
   * **原来钉**：整段正文编辑 —— 改过之后入口标「改过」，「改回出厂」能还原。
   * **那条输入方式退役了**（使用者裁：出题规则改成点选项），`rules-text` /
   *   `rules-save` / `rules-restore` 三个控件与它们背后的两条 IPC 一起撤掉。
   *   继续钉它 = 钉一个已经不存在的行为，而闸会一直绿着说「没问题」。
   *
   * **现在钉**：三个选项**点了真生效、真落库**，而且入口上说得出现在选的是哪一档 ——
   *   那是他不点进去也看得见的唯一一处。
   */
  it('★★ 出题规则三个选项：点了落库，入口上说得出当前那一档', async () => {
    await page.click('[data-testid="rules-open"]')
    await page.waitForSelector('[data-testid="rules-modal"]')
    /** 出厂是「先用原文」；换成「轮着来」 */
    await page.click('[data-testid="facepick-rotate"]')
    await page.waitForSelector('[data-testid="rules-note"]')
    await page.click('[data-testid="rules-close"]')
    await page.waitForSelector('[data-testid="rules-modal"]', { state: 'detached', timeout: 5000 })
    assert.match(
      await page.innerText('[data-testid="rules-open"]'),
      /轮着来/,
      '★ 换了考法，入口上一点表示都没有 —— 他得点进去才知道自己现在用哪一档'
    )

    /** 离开再回来：值是从库里读回来的，不是组件残留 */
    await page.click('[data-testid="set-tab-practice"]')
    await page.waitForTimeout(300)
    await page.click('[data-testid="set-tab-tutor"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="parea-drill"]')
    await page.click('[data-testid="ptab-reading"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="rules-open"]')
    await page.waitForSelector('[data-testid="rules-modal"]')
    assert.equal(
      await page.locator('[data-testid="facepick-rotate"].on').count(),
      1,
      '★★ 关掉再开又变回出厂了 —— 那就是「我的选择不算数」'
    )
    /** 收尾：改回出厂，别影响后面的用例 */
    await page.click('[data-testid="facepick-quote"]')
    await page.waitForTimeout(500)
  })

  it('★ Esc 关得掉（和别的浮层同一条栈）', async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="rules-modal"]', { state: 'detached', timeout: 5000 })
  })
})

describe('★ Enlighten / Quest：Tab 切换，两条流分开', () => {
  before(async () => {
    await page.click('[data-testid="nav-files"]')
    await page.waitForTimeout(500)
    await page.evaluate(() =>
      window.nyx.files.add('测试文章', 'One sentence. Another sentence here.', null)
    )
    await page.reload()
    await page.click('[data-testid="nav-files"]')
    await page.waitForTimeout(700)
    for (const g of await page.locator('[data-testid^="fs-group-"]').all()) {
      await g.click().catch(() => {})
    }
    await page.waitForTimeout(400)
    await page.locator('[data-testid^="fs-card-"]').first().click()
    await page.waitForTimeout(700)
  })

  it('两个 Tab 都在，默认停在 Enlighten', async () => {
    await page.locator('[data-testid="fs-mode-enlighten"]').waitFor()
    await page.locator('[data-testid="fs-mode-quest"]').waitFor()
    assert.match(
      await page.locator('[data-testid="fs-modetag"]').innerText(),
      /Enlighten/,
      '聊天框顶部没说清当前是哪个模式'
    )
  })

  it('★ 切到 Quest：顶部那一条跟着变，「下一个问题」出现', async () => {
    await page.click('[data-testid="fs-mode-quest"]')
    await page.waitForTimeout(500)
    assert.match(
      await page.locator('[data-testid="fs-modetag"]').innerText(),
      /Quest/,
      '切了 Quest，顶部还写着 Enlighten —— 「我明明选了 Quest 它怎么在讲课」就是这么来的'
    )
    assert.equal(
      await page.locator('[data-testid="fs-quest-next"]').count(),
      1,
      'Quest 下没有「出第一题 / 下一个问题」—— 那他根本开不了局'
    )
  })

  it('★ 切回 Enlighten：那颗按钮要消失（它只属于 Quest）', async () => {
    await page.click('[data-testid="fs-mode-enlighten"]')
    await page.waitForTimeout(500)
    assert.equal(
      await page.locator('[data-testid="fs-quest-next"]').count(),
      0,
      'Enlighten 下还挂着「下一个问题」—— 两个模式就没「完全分开」'
    )
  })
})

/**
 * 一路点进某条词条的详情页 —— **不开测试专用后门**。
 *
 * 加一个 `window.nyx.__openItem` 会方便得多，但那样测的就是后门通不通，
 * 而不是他点得进去。这一套的规矩就是只走他走的那条路（见文件头）。
 */
async function openItem(page: Page, lecId: number, itemId: number): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  await ensureOpen(
    page,
    '[data-testid^="nav-toggle-project-"]:has-text("摘抄验收")',
    '[data-testid^="nav-toggle-unit-"]:has-text("单元")'
  )
  await ensureOpen(
    page,
    '[data-testid^="nav-toggle-unit-"]:has-text("单元")',
    `[data-testid="nav-lecture-${lecId}"]`
  )
  await page.click(`[data-testid="nav-lecture-${lecId}"]`)
  await page.waitForSelector('[data-testid="item-rows"]', { timeout: 8000 })
  await page.click(`[data-testid="row-${itemId}"]`)
  await page.waitForSelector('[data-testid="detail-quote"]', { timeout: 8000 })
  await page.waitForTimeout(300)
}

/**
 * ★ 使用者 2026-08-10：「在 lecture 中和在文件学习中上传的文件可以删除（用小 × 表示）」
 *
 * 两条都走**他的操作路径**：找到那个 ×、点下去、看东西有没有从列表上消失。
 * 不查数据库有没有那一行 —— 这一套的规矩就是只看他看得见的（见文件头）。
 *
 * 确认框要拦掉：Electron 里 `confirm` 会挂住渲染进程，测试点不下去。
 */
describe('★ 材料和文章都删得掉（小 ×）', () => {
  it('★ lecture 里的材料：× 点得到，点完就不在了', async () => {
    const lecId = await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('删材料验收')
      const u = await window.nyx.data.createUnit(p, '材料单元')
      const l = await window.nyx.data.createLecture(u, '有材料的一讲')
      await window.nyx.data.addOriginal(l, '要删掉的原文', 'Some text to analyse later.')
      return l
    })
    // 直接走 IPC 建的东西，界面不知道 —— 刷一次让项目栏重新取（别的用例也是这么做的）
    await page.reload()
    await page.waitForSelector('[data-testid^="nav-toggle-project-"]')
    await page.evaluate(() => {
      window.confirm = () => true
    })
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, '删材料验收', '材料单元', lecId)

    const before = await page.locator('[data-testid="matbar"]').innerText()
    assert.match(before, /要删掉的原文/, '材料都没显示出来，后面不用测了')

    const x = page.locator('[data-testid^="del-material-"]').first()
    await x.waitFor()
    await x.click({ force: true }) // 平时是 hover 才显形的
    // ★ B5 · 删材料原来走系统 confirm()（Electron 里会卡住渲染进程），
    //   现在是应用内 Dialog —— 多一步确认
    await page.waitForSelector('[data-testid="del-material-dlg"]')
    await page.click('[data-testid="del-material-dlg-confirm"]')
    await page.waitForTimeout(700)

    /**
     * 删掉最后一份材料之后，工作台**回到空态**（两个大落区），`matbar` 整条不再渲染 ——
     * 所以不能再对着 matbar 断言。改成看他真正看得见的两件事：
     * 材料名字没了、落区回来了。
     *
     * 这一条是写断言的时候才发现的：原来那句 `matbar.innerText()` 一直超时，
     * 不是功能坏，是我以为它还在。
     */
    await page.waitForSelector('[data-testid="drop-original"]', { timeout: 8000 })
    /**
     * 断言只看**材料条上还有没有它**。
     * 第一版是整页搜「要删掉的原文」—— 永远失败，因为删完的提示语里
     * 就写着这个名字（「删掉了《要删掉的原文》」）。
     * 判据要对准要验的那个东西，别对准整块屏幕。
     */
    assert.equal(
      await page.locator('.mchip:has-text("要删掉的原文")').count(),
      0,
      '点了 × 材料还在材料条上 —— 他会以为没反应'
    )
  })

  it('★ 文件学习里的文章：× 点得到，点完列表里没了', async () => {
    await page.evaluate(async () => {
      window.confirm = () => true
      await window.nyx.files.add('要删掉的文章', 'Just some article text.', null)
    })
    await page.reload()
    await page.waitForSelector('[data-testid="nav-files"]')
    await page.evaluate(() => {
      window.confirm = () => true
    })
    await page.click('[data-testid="nav-files"]')
    await page.waitForTimeout(800)
    // I-095 · 除「在读」外默认收起。新贴的这篇是「未读」，得先把那一组展开
    const grp = page.locator('[data-testid="fs-group-unread"]')
    if (await grp.count()) await grp.click()
    await page.waitForTimeout(400)
    const card = page.locator('.fcard:has-text("要删掉的文章")')
    await card.waitFor({ timeout: 8000 }).catch(async () => {
      throw new Error(
        '文件学习页里找不到那篇文章。屏幕上是：' +
          (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 500)
      )
    })

    await card.locator('[data-testid^="del-file-"]').click({ force: true })
    // ★ B5 · 同上：系统 confirm() → 应用内 Dialog
    await page.waitForSelector('[data-testid="del-file-dlg"]')
    await page.click('[data-testid="del-file-dlg-confirm"]')
    await page.waitForTimeout(700)
    assert.equal(
      await page.locator('.fcard:has-text("要删掉的文章")').count(),
      0,
      '点了 × 文章还在列表里'
    )
  })
})

/**
 * ★ 清除全部数据 · 两阶段确认（使用者 2026-08-10）
 *
 * 这一条**只验拦不拦得住**，不真的清 —— 真清一遍会把后面所有用例的世界拆掉，
 * 而且主进程那一步还会重启软件。完整清除的效果由 `tests/db-safety.ts` 那条验
 * （它在临时库上真跑一遍 factoryReset，逐表数完再数一遍）。
 *
 * 这里要钉住的是**误操作防护**：他要求「不能点击一次按钮就直接删除」。
 * 防护写了没人验，等于没写。
 */
describe('★ 清除数据：两阶段确认拦得住（Q-3 合并后 · 两档一条路）', () => {
  before(async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-data"]')
    // ★ M-3（2026-09-03）之后危险区默认是收起的 —— 先展开。
    //   这一条当时没跑 smoke:ui，断了一整轮才被发现（记进台账 §5.19）。
    await page.click('[data-testid="fold-danger"]')
    await page.waitForSelector('[data-testid="danger-zone"]', { timeout: 8000 })
  })

  it('危险操作区在，而且默认没有输入框（点一次删不掉）', async () => {
    assert.equal(await page.locator('[data-testid="reset-open"]').count(), 1)
    assert.equal(
      await page.locator('[data-testid="reset-input"]').count(),
      0,
      '还没点就有输入框 —— 两阶段的第一阶段没了'
    )
  })

  it('★ 第一阶段：点开只是确认框，不删任何东西', async () => {
    await page.click('[data-testid="reset-open"]')
    await page.waitForSelector('[data-testid="reset-confirm"]')
    const t = await page.innerText('[data-testid="reset-confirm"]')
    assert.match(t, /不可撤销/, '没说清这一步不可撤销')
    assert.match(t, /不会动的/, '没说清什么不删 —— 词典那 6.5 GB 的教训')
    assert.equal(
      await page.locator('[data-testid="reset-input"]').count(),
      0,
      '第一阶段就出现了输入框'
    )
  })

  /**
   * ★★ Q-3（使用者 2026-09-03 裁「合并」）· 两条不可逆流程并成一条之后，
   * 第一步先选**清到什么程度**。判据是他那句：**凡是包含设置就必须手打 DELETE。**
   */
  it('★★ Q-3 · 默认停在轻的那一档，说的范围也是轻的那一档', async () => {
    const scope = await page.innerText('[data-testid="reset-scope"]')
    assert.match(scope, /设置不动/, '默认档说的范围不对 —— 不可逆操作的默认值该是伤害最小的那个')
    assert.doesNotMatch(scope, /含 AI key/, '默认档不该说要清 AI key')
  })

  it('★★★ Q-3 · 轻档只要打「清空」，重档必须打 DELETE', async () => {
    // 轻档
    await page.click('[data-testid="reset-continue"]')
    await page.waitForSelector('[data-testid="reset-input"]')
    const go = page.locator('[data-testid="reset-go"]')

    await page.fill('[data-testid="reset-input"]', 'DELETE')
    await page.waitForTimeout(120)
    assert.equal(await go.isDisabled(), true, '★ 轻档不该认 DELETE —— 两档的确认词必须各是各的')

    await page.fill('[data-testid="reset-input"]', '清空')
    await page.waitForTimeout(120)
    assert.equal(await go.isDisabled(), false, '轻档打对了「清空」还是点不动')

    // 退回去换重档
    await page.click('[data-testid="reset-cancel2"]')
    await page.waitForTimeout(200)
    await page.click('[data-testid="reset-open"]')
    await page.waitForSelector('[data-testid="reset-confirm"]')
    await page.click('[data-testid="reset-lv-all"]')
    await page.waitForTimeout(120)
    const scope = await page.innerText('[data-testid="reset-scope"]')
    assert.match(scope, /含 AI key/, '重档没说清连 AI key 一起清')

    await page.click('[data-testid="reset-continue"]')
    await page.waitForSelector('[data-testid="reset-input"]')
    await page.fill('[data-testid="reset-input"]', '清空')
    await page.waitForTimeout(120)
    assert.equal(
      await page.locator('[data-testid="reset-go"]').isDisabled(),
      true,
      '★★ 重档认了轻档的词 —— 那就等于「连 AI key 一起清」只要点两下，确认闸漏了'
    )
    await page.click('[data-testid="reset-cancel2"]')
    await page.waitForTimeout(200)
  })

  it('★ 第二阶段：字没打对时按钮是灰的，点了也什么都不做', async () => {
    await page.click('[data-testid="reset-open"]')
    await page.waitForSelector('[data-testid="reset-confirm"]')
    await page.click('[data-testid="reset-lv-all"]')
    await page.click('[data-testid="reset-continue"]')
    await page.waitForSelector('[data-testid="reset-input"]')
    const go = page.locator('[data-testid="reset-go"]')
    assert.equal(await go.isDisabled(), true, '一个字没打，按钮就是可点的')

    for (const wrong of ['delete', 'Delete', 'DELET', 'DELETE ME']) {
      await page.fill('[data-testid="reset-input"]', wrong)
      await page.waitForTimeout(120)
      assert.equal(await go.isDisabled(), true, `输入「${wrong}」按钮却可点 —— 匹配太松`)
    }
  })

  it('★ 输入 DELETE 之后按钮才允许点', async () => {
    await page.fill('[data-testid="reset-input"]', 'DELETE')
    await page.waitForTimeout(150)
    assert.equal(
      await page.locator('[data-testid="reset-go"]').isDisabled(),
      false,
      '打对了还是点不动'
    )
    // 到此为止 —— 点下去会重启软件，把后面的用例一起带走
    await page.click('[data-testid="reset-cancel2"]')
    await page.waitForTimeout(200)
    assert.equal(
      await page.locator('[data-testid="reset-input"]').count(),
      0,
      '取消之后输入框还在'
    )
  })
})

/**
 * ★★ R-2 · 「静默这个 Lecture」的两个入口必须是同一条路
 *
 * ── 为什么这一条非得放在这一档 ──────────────────────────────
 *
 * 病根不是某个函数写错了，是**同一个业务动作有两份实现**，
 * 而两份分别挂在两个入口上：项目栏右键走 `setSilent`，
 * 工作台那颗按钮走另一份只翻 silent 位的 `silenceLecture`。
 *
 * 那份已经删了、`repo` 那一层也有用例守着。但 `repo` 对了不等于
 * **他点下去走的是那一份** —— 中间还隔着 preload、IPC 通道、main 的 handler。
 * 「我改的那份怎么到他手上」这一问在这里的答案就是这三层，
 * 所以这一条走真软件：`window.nyx.*` 一路穿到主进程，和他点按钮时同一条链。
 */
describe('★★ R-2 · 静默：工作台入口和项目栏入口是同一条路', () => {
  /** 两条结构完全相同的讲：同一个单元、同样多的条目、都进了轮转 */
  let LA = 0
  let LB = 0

  /** 只看**看得见的东西**：状态、有没有排期、每条条目的两条线状态 */
  type Shot = { status: string; hasDue: boolean; items: string[]; cards: number }
  const shotOf = async (id: number): Promise<Shot> =>
    await page.evaluate(async (lid) => {
      const d = await window.nyx.data.lecture(lid)
      const cards = await window.nyx.study.dueCards(lid, 200)
      return {
        status: d.lecture.status,
        hasDue: d.lecture.dueAt !== null,
        // 词条本身两条讲不一样，所以只留状态位 —— 比的是「入口有没有差别」
        items: d.items
          .map((i) => `${i.productionState}/${i.cardSilent ? 'cs1' : 'cs0'}/${i.streak}/${i.attempts}`)
          .sort(),
        cards: cards.length
      }
    }, id)

  /** 进这一节之前体检本来就报了什么 —— 只比「这一趟有没有**新增**」 */
  let auditBefore: string[] = []

  it('铺两条一模一样的讲', async () => {
    auditBefore = await page.evaluate(async () => {
      const r = await window.nyx.health.audit()
      return r.findings.map((f) => `${f.id}×${f.count}`)
    })
    const ids = await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('静默验收')
      const u = await window.nyx.data.createUnit(p, '同一个单元')
      const a = await window.nyx.data.createLecture(u, '走工作台的那讲')
      const b = await window.nyx.data.createLecture(u, '走项目栏的那讲')
      // 词条不能重名 —— 重名会触发「重复收集即攻坚」，两条讲就不再对称了
      await window.nyx.data.addChunks(a, '我的收集', 'alpha one\nalpha two\nalpha three')
      await window.nyx.data.addChunks(b, '我的收集', 'beta one\nbeta two\nbeta three')
      await window.nyx.study.startLearning(a)
      await window.nyx.study.startLearning(b)
      return [a, b]
    })
    LA = ids[0]!
    LB = ids[1]!
    const [a, b] = [await shotOf(LA), await shotOf(LB)]
    assert.deepEqual(a, b, '起点就不一样，后面比什么都没意义')
    assert.equal(a.cards, 3, `认读队列该有 3 张，实际 ${a.cards}`)
    assert.equal(a.hasDue, true, '进了轮转却没有排期')
  })

  it('★ 静默：两个入口穿过真实 IPC 之后，看得见的结果逐项相同', async () => {
    await page.evaluate(
      async ([a, b]) => {
        await window.nyx.data.silenceLecture(a!, true) // 工作台那颗按钮走的通道
        await window.nyx.data.setSilent('lecture', b!, true) // 项目栏右键走的通道
      },
      [LA, LB]
    )
    const a = await shotOf(LA)
    const b = await shotOf(LB)
    assert.deepEqual(a, b, '★ 两个入口做同一件事，结果却不一样 —— 又长出第二份实现了')
    assert.equal(a.status, 'silent', '状态没变成静默')
    assert.equal(a.hasDue, false, '静默了还排着到期日')
    assert.equal(a.cards, 0, `★ 静默之后认读队列还剩 ${a.cards} 张 —— 界面写着「不再排进今日练习」`)
    assert.ok(
      a.items.every((x) => x.startsWith('silent/cs1/')),
      `★ 条目没跟着进静默库：${a.items.join(' · ')}`
    )
  })

  it('★ 取消静默：两个入口仍然逐项相同，排期真的回来了，进度没被清零', async () => {
    await page.evaluate(
      async ([a, b]) => {
        await window.nyx.data.silenceLecture(a!, false)
        await window.nyx.data.setSilent('lecture', b!, false)
      },
      [LA, LB]
    )
    const a = await shotOf(LA)
    const b = await shotOf(LB)
    assert.deepEqual(a, b, '★ 取消静默两个入口结果不一样')
    assert.equal(a.hasDue, true, '★ 取消静默之后没有排期 —— 那一讲再也不进「今日」')
    assert.notEqual(a.status, 'silent', '静默位没放下')
    assert.equal(a.cards, 3, `★ 认读队列没回来：${a.cards}`)
    assert.ok(
      a.items.every((x) => x.startsWith('training/cs0/')),
      `★ 条目没被放出来：${a.items.join(' · ')}`
    )
  })

  it('★ 真的在工作台上点那颗「静默这个 Lecture」：队列少了，静默库里出得来', async () => {
    await openLecture(page, '静默验收', '同一个单元', LA)
    await page.click('[data-testid="lecture-menu"]')
    await page.waitForSelector('[data-testid="lecture-menu-open"]')
    /**
     * ★ 文案按术语表 TM-30（使用者 2026-09-08 定：界面统一说 Lecture）。
     *   这里**故意精确比**：改名当场红，正是术语表 §六 要的那道闸。
     *
     * ★★ 断言之前先把菜单关掉 —— 这一条 2026-09-08 真栽过一次：
     *   文案改了之后这句断言抛出，而**菜单连同它那张全屏遮罩留在屏幕上**，
     *   后面三条（N-1 那一组）全被遮罩挡住，报的却是「项目那一行点不动」——
     *   一条失败拖垮三条，而且症状指向完全无关的地方。
     */
    /** ★ 钉常量拼出来的那一句，不钉字面（D-489 之后是「静默这个 Lecture」）*/
    const want = silenceScopeAction(false, 'Lecture')
    const onMenu = await page.locator('[data-testid="lecture-silence"]').innerText()
    if (onMenu !== want) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      assert.fail(`菜单上那一项文案不对：「${onMenu}」，应该是「${want}」`)
    }
    await page.click('[data-testid="lecture-silence"]')
    await page.waitForTimeout(600)

    const after = await shotOf(LA)
    assert.equal(after.status, 'silent', '★ 点了没反应')
    assert.equal(after.cards, 0, `★ 点完认读队列还剩 ${after.cards} 张`)
    assert.ok(
      after.items.every((x) => x.startsWith('silent/cs1/')),
      `★ 点完条目没进静默库：${after.items.join(' · ')}`
    )

    // 静默知识库那一页要看得见它 —— 藏起来却没有出口就是个陷阱
    const inSilent = await page.evaluate(async (lid) => {
      const rows = await window.nyx.data.silentTree()
      return rows.some((x) => x.kind === 'lecture' && x.id === lid)
    }, LA)
    assert.ok(inSilent, '★ 静默了，静默知识库里却找不到它')

    // 从同一个入口取消，必须完全回得来
    await page.click('[data-testid="lecture-menu"]')
    await page.waitForSelector('[data-testid="lecture-menu-open"]')
    assert.equal(
      await page.locator('[data-testid="lecture-silence"]').innerText(),
      silenceScopeAction(true, 'Lecture'),
      '静默之后菜单文案没跟着变'
    )
    await page.click('[data-testid="lecture-silence"]')
    await page.waitForTimeout(600)
    const back = await shotOf(LA)
    assert.equal(back.hasDue, true, '★ 从工作台取消静默之后没有排期')
    assert.equal(back.cards, 3, `★ 认读队列没回来：${back.cards}`)
  })

  it('★ 这一趟走完，体检不许多出任何一条', async () => {
    /**
     * 比的是**增量**，不是「体检全绿」。
     *
     * 这一整套用例跑在同一个软件实例里，前面几节留下的东西也会被体检看见 ——
     * 拿绝对值断言就变成了「谁最后跑谁背锅」，红了也定位不到人。
     * 静默这一趟该负责的是「我没有把库弄脏」，那就是增量。
     */
    const after = await page.evaluate(async () => {
      const r = await window.nyx.health.audit()
      return r.findings.map((f) => `${f.id}×${f.count}`)
    })
    const added = after.filter((x) => !auditBefore.includes(x))
    assert.deepEqual(added, [], `★ 静默来回一趟之后体检多出了：${added.join('、')}`)
  })
})

/**
 * ★★ N-1 · 贴完「我的收集」，那颗「开始学」必须当场出现
 *
 * ── 为什么必须验到这一档 ──────────────────────────────────
 *
 * N-1 的实际伤害不是「体检报了一条」，是**界面死胡同**：
 * `start-learning` 那颗按钮只在 `status === 'review'` 时渲染，
 * 而它是全项目唯一进入 `startLearning` 的路径。状态卡在 `empty`，
 * 这一讲就有内容、有列表、没有任何出口 —— 重启一次才被启动自愈救回来。
 *
 * 实测过修复前的样子：`status=empty · 知识点 2 条`、
 * 「开始学」按钮 0 个、整页搜不到「开始学」三个字。
 * 所以这条用例查的就是那颗按钮，不查数据库有没有那一行。
 */
describe('★★ N-1 · 贴完「我的收集」不用重启就能开始学', () => {
  let lec = 0

  /**
   * 进一个**还没有材料**的讲。
   *
   * 不能用 `openLecture` —— 它等的是 `matbar`，而那一条只在
   * `d.materials.length > 0` 时才渲染；空讲显示的是两个落区。
   * 第一版就栽在这里：工作台其实已经打开了，用例却报「没有 matbar」。
   */
  async function openBareLecture(id: number): Promise<void> {
    const lecSel = `[data-testid="nav-lecture-${id}"]`
    const unitSel = '[data-testid^="nav-toggle-unit-"]:has-text("单元")'
    const projSel = '[data-testid^="nav-toggle-project-"]:has-text("N-1 验收")'
    const vis = async (sel: string): Promise<boolean> =>
      await page.locator(sel).first().isVisible().catch(() => false)
    // 和 openLecture 一样「看着结果走」：单元这一层也要展开，只点项目是不够的
    for (let i = 0; i < 4; i++) {
      if (await vis(lecSel)) {
        await page.locator(lecSel).click()
        await page.waitForSelector('[data-testid="drop-original"], [data-testid="matbar"]', {
          timeout: 8000
        })
        return
      }
      if (await vis(unitSel)) await page.locator(unitSel).first().click()
      else await page.locator(projSel).first().click()
      await page.waitForTimeout(450)
    }
    throw new Error(`点不进第 ${id} 讲`)
  }

  it('新建一讲、贴一段收集', async () => {
    lec = await page.evaluate(async () => {
      const p = await window.nyx.data.createProject('N-1 验收')
      const u = await window.nyx.data.createUnit(p, '单元')
      const l = await window.nyx.data.createLecture(u, '只贴收集的那讲')
      return l
    })
    await openBareLecture(lec)
    // 贴之前：确实没有那颗按钮（空讲本来就不该有）
    assert.equal(
      await page.locator('[data-testid="start-learning"]').count(),
      0,
      '还没贴东西就有「开始学」了'
    )
    await page.evaluate(
      async (id) => {
        await window.nyx.data.addChunks(id, '我的收集', 'a stone throw from the shore\nat the mercy of the tide')
      },
      lec
    )
    // 让工作台重新取一次数据 —— 和他贴完之后看到的是同一份
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openLecture(page, 'N-1 验收', '单元', lec)
  })

  it('★ 那颗「这批我看过了 · 开始学」当场就在（不用重启软件）', async () => {
    await page.waitForSelector('[data-testid="start-learning"]', { timeout: 8000 }).catch(async () => {
      throw new Error(
        '★ 贴完收集之后没有「开始学」—— 这一讲是个死胡同。屏幕上是：' +
          (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 400)
      )
    })
    assert.equal(
      await page.locator('[data-testid="start-learning"]').isVisible(),
      true,
      '按钮在 DOM 里但看不见'
    )
    assert.equal(
      await page.locator('[data-testid="review-banner"]').count(),
      1,
      '「看一遍，删掉不要的」那条提示也该出来 —— 它和按钮是同一道门'
    )
  })

  it('★ 点下去真的进轮转：认读队列有卡、下次到期日出得来', async () => {
    await page.click('[data-testid="start-learning"]')
    await page.waitForTimeout(800)
    const d = await page.evaluate(async (id) => {
      const x = await window.nyx.data.lecture(id)
      const cards = await window.nyx.study.dueCards(id, 50)
      return { status: x.lecture.status, due: x.lecture.dueAt, cards: cards.length }
    }, lec)
    assert.equal(d.status, 'training', `点完不是 training：${d.status}`)
    assert.ok(d.due !== null, '★ 进了轮转却没有排期')
    assert.equal(d.cards, 2, `★ 认读队列该有 2 张，实际 ${d.cards}`)
    assert.equal(
      await page.locator('[data-testid="go-reading"]').count(),
      1,
      '进了 training，认读练习那颗按钮该出来'
    )
  })

  it('★ 这一趟不许给体检添新的东西', async () => {
    const bad = await page.evaluate(async () => {
      const r = await window.nyx.health.audit()
      return r.findings.filter((f) => f.id === 'empty-with-items').map((f) => `${f.id}×${f.count}`)
    })
    assert.deepEqual(bad, [], `★ 还在报：${bad.join('、')}`)
  })
})
