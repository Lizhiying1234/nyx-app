import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createServer, type Server } from 'node:http'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * H-4 · 渲染层失败路径的第 ③ 档验收
 *
 * ── 为什么必须用故障注入 ──────────────────────────────────
 *
 * 这一轮要治的病是「IPC 失败时他什么都看不到」——
 * 而「他看得到什么」只有真软件验得了。不注入故障，就只能验
 * 「代码里有 try」，那正是第九节反复栽跟头的那种验法：
 * 验的是我改的那一层，不是他手指所在的那一层。
 *
 * 开关只在开发/测试环境生效（`app.isPackaged` 为真时连包装都不装），
 * 见 `index.ts / installFaultInjection` 与 `faultMount`。
 *
 * ── H-4-2 · 每条用例自带前置 ──────────────────────────────
 *
 * 上一版有一条「页面没白」靠的是前一条用例留下的导航状态 ——
 * 负向对照时它跟着一起红，分不清是谁的问题。
 * 现在每个 describe 起自己的实例、每条用例自己走到该走的地方，
 * **顺序打乱也应当照样过**。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface App {
  app: ElectronApplication
  page: Page
  dataRoot: string
}

/** 起一个软件实例。`fault` = 让哪几条 IPC 通道必炸；`faultMount` = 让首屏渲染必炸 */
async function launch(fault?: string, faultMount?: boolean): Promise<App> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-err-'))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1'
  }
  if (fault) env['NYX_FAULT'] = fault
  if (faultMount) env['NYX_FAULT_MOUNT'] = '1'
  const app = await electron.launch({ args: ['.'], cwd: root, env })
  const page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')
  return { app, page, dataRoot }
}

async function shut(a: App | undefined): Promise<void> {
  await a?.app.close()
  if (a) keepOrClean(a.dataRoot)
}

/** 铺一个项目 / 单元 / 讲，返回 lecture id。这几条通道都不在故障名单里 */
async function seed(page: Page, name: string): Promise<number> {
  const id = await page.evaluate(async (n) => {
    const p = await window.nyx.data.createProject(n)
    const u = await window.nyx.data.createUnit(p, '单元')
    return await window.nyx.data.createLecture(u, '第一讲')
  }, name)
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(400)
  return id
}

/**
 * 打开这个项目的右键菜单 —— 每条用到它的用例都自己调，不靠别人留下的状态。
 *
 * ★ D-469（2026-09-07）· 项目页取消之后，「随时认读 / 练习」与「导出笔记」
 *   住在树节点的右键菜单里（D-377）。这两个动作失败时该看见什么，
 *   验的还是同一件事，只是入口换了。
 */
async function openProjectMenu(page: Page, name: string): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  for (let i = 0; i < 4; i++) {
    const row = page.locator(`[data-testid^="nav-toggle-project-"]:has-text("${name}")`).first()
    if (await row.isVisible().catch(() => false)) {
      await row.click({ button: 'right' })
      await page.waitForSelector('[data-testid="tree-menu"]', { timeout: 8000 })
      return
    }
    await page.waitForTimeout(300)
  }
  throw new Error(`右键点不开项目《${name}》`)
}

/** 进一个还没有材料的讲（空讲显示的是落区，不是 matbar） */
async function openLectureLoose(page: Page, projectName: string, lecId: number): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  for (let i = 0; i < 5; i++) {
    const lec = page.locator(`[data-testid="nav-lecture-${lecId}"]`)
    if (await lec.isVisible().catch(() => false)) {
      await lec.click()
      await page.waitForSelector('[data-testid="drop-original"], [data-testid="matbar"]', {
        timeout: 8000
      })
      return
    }
    const unit = page.locator('[data-testid^="nav-toggle-unit-"]:has-text("单元")').first()
    const proj = page.locator(`[data-testid^="nav-toggle-project-"]:has-text("${projectName}")`).first()
    if (await unit.isVisible().catch(() => false)) await unit.click()
    else await proj.click()
    await page.waitForTimeout(400)
  }
  throw new Error(`点不进第 ${lecId} 讲`)
}

// ══ 一、普通按钮操作 · 异步查询 ══════════════════════════════

describe('★★ H-4 · 普通按钮：一次 IPC 失败，他到底看得见什么', () => {
  let a: App
  before(async () => {
    a = await launch('data:lecturesUnder')
    await seed(a.page, '错误验收')
  })
  after(async () => shut(a))

  it('★ 右键「随时认读 / 练习…」失败 → 屏幕上必须有话，而且说清是哪一步', async () => {
    await openProjectMenu(a.page, '错误验收')
    await a.page.click('[data-testid="tree-test"]')
    await a.page.waitForTimeout(700)

    const box = a.page.locator('[data-testid="tree-error"]')
    assert.equal(await box.count(), 1, `失败了却什么都没显示：${(await a.page.innerText('body')).replace(/\s+/g, ' ').slice(0, 300)}`)
    const t = await box.innerText()
    assert.ok(t.includes('注入的故障') || t.includes('lecturesUnder'), `没说清是哪一步：${t}`)
    /**
     * ★★ 失败不许长成成功的样子（H-4b）。
     *   这两个动作从项目页搬进树菜单时最容易出的错，就是把错误塞进
     *   那条绿色的 `tree-note` —— 「导出失败」和「导出好了」会一模一样。
     */
    assert.equal(
      await a.page.locator('[data-testid="tree-note"]').count(),
      0,
      '★★ 失败却显示成了绿色的成功提示'
    )
  })

  it('★ 失败之后还点得动，页面没白', async () => {
    await a.page.click('[data-testid="tree-error-ok"]')
    await openProjectMenu(a.page, '错误验收')
    await a.page.click('[data-testid="tree-test"]')
    await a.page.waitForTimeout(600)
    assert.equal(await a.page.locator('[data-testid="nav-home"]').count(), 1, '★ 白屏了')
    await a.page.click('[data-testid="nav-home"]')
    await a.page.waitForTimeout(400)
    assert.ok((await a.page.innerText('body')).length > 100, '★ 回首页之后页面是空的')
  })

  it('★ 未处理的 rejection 也要变成屏幕上的一条（兜底层）', async () => {
    await a.page.click('[data-testid="nav-home"]')
    const n = await a.page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          void Promise.reject(new Error('探针：故意的 rejection'))
          setTimeout(() => resolve(document.querySelectorAll('[data-testid="errbar-item"]').length), 700)
        })
    )
    assert.ok(n >= 1, '★ 未处理的 rejection 没有变成屏幕上的一条')
  })
})

// ══ 二、导出 ═══════════════════════════════════════════════

describe('★★ H-4 · 导出失败：不能点了没反应', () => {
  let a: App
  before(async () => {
    a = await launch('data:exportNotes')
    await seed(a.page, '导出验收')
  })
  after(async () => shut(a))

  it('★ 右键「导出笔记」失败 → 错误框出现，且不是「成功」的样子', async () => {
    await openProjectMenu(a.page, '导出验收')
    await a.page.click('[data-testid="tree-export"]')
    await a.page.waitForTimeout(700)
    assert.equal(await a.page.locator('[data-testid="tree-error"]').count(), 1, '★ 导出失败没有任何提示')
    assert.equal(
      await a.page.locator('[data-testid="tree-note"]').count(),
      0,
      '★ 失败却显示成了绿色的成功提示'
    )
  })
})

// ══ 三、设置修改 ═══════════════════════════════════════════

describe('★★ H-4 · 设置修改失败：参数不许悄悄不动', () => {
  let a: App
  before(async () => {
    a = await launch('params:reset')
  })
  after(async () => shut(a))

  it('★「全部还原成默认值」失败 → 说得出为什么', async () => {
    // 先改一个参数，那颗按钮才会出现（它只在有改动时显示）
    await a.page.evaluate(async () => {
      const list = await window.nyx.params.list()
      const first = list[0]!
      await window.nyx.params.set(first.key, first.value + 1)
    })
    await a.page.click('[data-testid="nav-settings"]')
    await a.page.waitForSelector('[data-testid="set-tab-practice"]')
    await a.page.click('[data-testid="set-tab-practice"]')
    await a.page.waitForSelector('[data-testid="param-reset"]', { timeout: 8000 })
    await a.page.click('[data-testid="param-reset"]')
    await a.page.waitForTimeout(700)

    const body = await a.page.innerText('body')
    assert.ok(
      body.includes('参数没能还原成默认值'),
      `★ 还原失败却没有提示：${body.replace(/\s+/g, ' ').slice(0, 300)}`
    )
    assert.equal(
      await a.page.locator('[data-testid="param-reset"]').isDisabled(),
      false,
      '★ 失败之后按钮点不动了'
    )
  })
})

// ══ 四、删除 / 恢复 ════════════════════════════════════════

describe('★★ H-4 · 垃圾箱恢复失败：不能装作恢复了', () => {
  let a: App
  before(async () => {
    a = await launch('browse:restoreMany')  // 批量恢复走的是这条，不是 browse:restore
    await seed(a.page, '垃圾箱验收')
    // 删掉一讲，垃圾箱里才有东西
    await a.page.evaluate(async () => {
      const tree = await window.nyx.data.tree()
      const p = tree.find((x) => x.name === '垃圾箱验收')!
      await window.nyx.browse.deleteLecture(p.units[0]!.lectures[0]!.id)
    })
  })
  after(async () => shut(a))

  it('★ 点「恢复」失败 → 有错误框，而且没有假的成功提示', async () => {
    await a.page.click('[data-testid="nav-trash"]')
    await a.page.waitForTimeout(600)
    // 勾中那一行，再点批量恢复（垃圾箱只有批量入口，行上是复选框不是按钮）
    await a.page.locator('[data-testid^="trash-ck-"]').first().click()
    await a.page.waitForSelector('[data-testid="trash-restore-picked"]')
    await a.page.click('[data-testid="trash-restore-picked"]')
    await a.page.waitForTimeout(800)
    const shown =
      (await a.page.locator('[data-testid="trash-error"]').count()) +
      (await a.page.locator('[data-testid="errbar-item"]').count())
    assert.ok(shown > 0, `★ 恢复失败却没有任何提示：${(await a.page.innerText('body')).replace(/\s+/g, ' ').slice(0, 300)}`)
  })
})

// ══ 五、异步查询（H-4-1） ══════════════════════════════════

describe('★★ H-4-1 · 分析范围取不到，不许伪装成「没有内容」', () => {
  let a: App
  let lec = 0
  before(async () => {
    a = await launch('study:analysisCounts')
    lec = await seed(a.page, '分析范围验收')
    await a.page.evaluate(async (id) => {
      await window.nyx.data.addChunks(id, '我的收集', 'a stone throw from the shore')
    }, lec)
  })
  after(async () => shut(a))

  it('★ 打开分析面板、选一个分类 → 说「取不到」并给重试，而不是空白或 0', async () => {
    // 自己走进去：项目 → 讲 → 分析 ▾
    await a.page.click('[data-testid="nav-home"]')
    await a.page.waitForTimeout(300)
    for (let i = 0; i < 4; i++) {
      const lecRow = a.page.locator(`[data-testid="nav-lecture-${lec}"]`)
      if (await lecRow.isVisible().catch(() => false)) {
        await lecRow.click()
        break
      }
      const unit = a.page.locator('[data-testid^="nav-toggle-unit-"]:has-text("单元")').first()
      const proj = a.page
        .locator('[data-testid^="nav-toggle-project-"]:has-text("分析范围验收")')
        .first()
      if (await unit.isVisible().catch(() => false)) await unit.click()
      else await proj.click()
      await a.page.waitForTimeout(400)
    }
    await a.page.waitForSelector('[data-testid="analyze"]', { timeout: 8000 })
    await a.page.click('[data-testid="analyze"]')
    await a.page.waitForTimeout(400)
    await a.page.selectOption('select', 'self')
    await a.page.waitForTimeout(600)

    const note = a.page.locator('[data-testid="scope-note"]')
    const t = await note.innerText()
    assert.ok(t.includes('分析范围暂时取不到'), `★ 取不到却没说：${t}`)
    assert.equal(
      t.includes('这一类下面还没有知识点'),
      false,
      '★ 把「取不到」显示成了「没有内容」—— 正是 H-4-1 那个病'
    )
    assert.equal(await a.page.locator('[data-testid="scope-retry"]').count(), 1, '★ 没有重试的路')
    assert.equal(
      await a.page.locator('[data-testid="run-scope"]').isDisabled(),
      true,
      '★ 数都没数出来，那颗「开始写解析」却是可点的'
    )
  })
})

// ══ 六、首屏挂不起来（H-4-3） ═══════════════════════════════

describe('★★ H-4-3 · 首屏渲染抛异常 → 一页人话，不是白屏', () => {
  let a: App
  before(async () => {
    a = await launch(undefined, true)
  })
  after(async () => shut(a))

  it('★ 出现退化页，而不是空的 #app', async () => {
    await a.page.waitForSelector('[data-testid="fatal-page"]', { timeout: 8000 })
    const t = await a.page.innerText('[data-testid="fatal-page"]')
    assert.ok(t.includes('Nyx 界面没能启动'), `退化页上没有人话：${t}`)
    assert.ok(t.includes('你的数据没有动'), '没有告诉他数据是安全的')
  })

  it('★ 退化页上有构建号（他跑的是哪一份）', async () => {
    await a.page.waitForSelector('[data-testid="fatal-build"]')
    const t = await a.page.innerText('[data-testid="fatal-build"]')
    assert.ok(!t.includes('读取中'), `构建号一直停在「读取中」：${t}`)
    assert.ok(t.includes('构建号：'), t)
  })

  it('★ 退化页上「打开日志文件夹」和「重新加载」都在', async () => {
    assert.equal(await a.page.locator('[data-testid="fatal-logs"]').count(), 1, '没有「打开日志文件夹」')
    assert.equal(await a.page.locator('[data-testid="fatal-reload"]').count(), 1, '没有「重新加载」')
  })
})

// ══ 七、不注入故障时，一切照旧 ══════════════════════════════

describe('★★ H-4 · 不注入故障时，一切照旧', () => {
  let a: App
  before(async () => {
    a = await launch()
  })
  after(async () => shut(a))

  it('★ 正常状态下，错误条 / 退化页一个节点都不渲染（否则 DOM 对齐会被带偏）', async () => {
    await a.page.waitForTimeout(600)
    assert.equal(await a.page.locator('[data-testid="errbar"]').count(), 0, '没出错却挂着错误条')
    assert.equal(await a.page.locator('[data-testid="boundary-page"]').count(), 0, '没出错却显示了出错页')
    assert.equal(await a.page.locator('[data-testid="fatal-page"]').count(), 0, '★ 没开注入却进了首屏退化页')
  })

  it('构建号那条路不碰数据库，随时取得到', async () => {
    const b = await a.page.evaluate(() => window.nyx.app.buildInfo())
    assert.ok(b.commit && b.builtAt, `构建号取不到：${JSON.stringify(b)}`)
  })
})

// ══ 八、学习闭环（P-1） ═════════════════════════════════════

describe('★★ P-1 · 开始学习失败：那一讲不许变成半成品', () => {
  let a: App
  let lec = 0
  before(async () => {
    a = await launch('study:startLearning')
    lec = await seed(a.page, '开始学验收')
    await a.page.evaluate(async (id) => {
      await window.nyx.data.addChunks(id, '我的收集', 'alpha one\nbeta two')
    }, lec)
    await a.page.reload()
    await a.page.waitForLoadState('domcontentloaded')
  })
  after(async () => shut(a))

  it('★ 点「开始学」失败 → 有话说、按钮还点得动、那一讲仍是 review', async () => {
    await openLectureLoose(a.page, '开始学验收', lec)
    await a.page.click('[data-testid="start-learning"]')
    await a.page.waitForTimeout(800)

    const body = await a.page.innerText('body')
    assert.ok(
      body.includes('注入的故障') || body.includes('startLearning'),
      `★ 失败了却没有任何提示：${body.replace(/\s+/g, ' ').slice(0, 300)}`
    )
    const d = await a.page.evaluate(async (id) => {
      const x = await window.nyx.data.lecture(id)
      const cards = await window.nyx.study.dueCards(id, 50)
      return { status: x.lecture.status, due: x.lecture.dueAt, cards: cards.length }
    }, lec)
    assert.equal(d.status, 'review', `★ 那一讲变成了 ${d.status} —— 半成品`)
    assert.equal(d.due, null, '★ 失败了却留下了排期')
    assert.equal(d.cards, 0, '★ 失败了却给条目排了认读卡')
  })
})

describe('★★ P-1 · 结算失败：错误页 + 重试，而且重试不许再扩一次间隔', () => {
  let a: App
  let lec = 0
  before(async () => {
    // 结算这一条炸，其余照常 —— 要能正常答完题才走得到结算
    a = await launch('study:settleLectures')
    lec = await seed(a.page, '结算验收')
  })
  after(async () => shut(a))

  it('★ 直接调结算：失败了，讲的间隔和排期一个字都不许动', async () => {
    const before = await a.page.evaluate(async (id) => {
      await window.nyx.data.addChunks(id, '我的收集', 'aa bb\ncc dd\nee ff\ngg hh\nii jj\nkk ll')
      await window.nyx.study.startLearning(id)
      const x = await window.nyx.data.lecture(id)
      return { due: x.lecture.dueAt }
    }, lec)

    const failed = await a.page.evaluate(async (id) => {
      try {
        await window.nyx.study.settleLectures([id], null)
        return null
      } catch (e) {
        return String(e)
      }
    }, lec)
    assert.ok(failed?.includes('注入的故障'), `结算没被注入的故障拦住：${failed}`)

    const after = await a.page.evaluate(async (id) => {
      const x = await window.nyx.data.lecture(id)
      return { due: x.lecture.dueAt }
    }, lec)
    assert.equal(after.due, before.due, '★ 结算失败了，排期却被改了')
  })

  it('★ 重试两次也只结算一次（幂等在后端，不靠界面挡）', async () => {
    // 这一条不注入故障：另起一个干净实例，验「重试 = 不重复结算」
    const b = await launch()
    try {
      const id = await seed(b.page, '幂等验收')
      const r = await b.page.evaluate(async (lid) => {
        await window.nyx.data.addChunks(lid, '我的收集', 'aa bb\ncc dd\nee ff\ngg hh\nii jj\nkk ll')
        await window.nyx.study.startLearning(lid)
        const sid = await window.nyx.study.startSession('production', 'lecture', lid)
        const first = await window.nyx.study.settleLectures([lid], sid)
        const l1 = await window.nyx.data.lecture(lid)
        const second = await window.nyx.study.settleLectures([lid], sid)
        const l2 = await window.nyx.data.lecture(lid)
        return {
          due1: l1.lecture.dueAt,
          due2: l2.lecture.dueAt,
          reason: second.perLecture[0]?.reason ?? '',
          sample1: first.sample,
          sample2: second.sample
        }
      }, id)
      assert.equal(r.due2, r.due1, '★ 第二次结算把排期又往后推了一次')
      assert.ok(r.reason.includes('已经结算过'), `第二次没说清是重试：${r.reason}`)
      assert.equal(r.sample2, r.sample1, '重试之后统计变了')
    } finally {
      await shut(b)
    }
  })
})

// ══ 九、P-1 · 结算失败之后那颗「重试」到底重试了什么 ═══════════

/**
 * 这一节是补 H-4b 那次的教训：
 * 上面「结算失败」两条都是**直接调 IPC**，所以把「重试」改回 `loadQuestion`
 * 之后它们照样绿 —— 负向对照打不红，说明没人在验那颗按钮。
 *
 * 所以这一条必须走界面：真的答到最后一题、真的点那颗「重试」。
 * 出题要 AI，这里起一个假的 OpenAI 兼容服务顶上（和 study.test.ts 同一套做法）。
 */
/** 判分请求靠它认出来 —— 提交的答案会原样出现在请求体里 */
const ANSWER = 'The junior staff bore the brunt of the cuts.'

describe('★★ P-1 · 结算失败 → 点「重试」，重试的必须是结算，不是出题', () => {
  let a: App
  let server: Server
  let port = 0
  let lec = 0

  before(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        /**
         * 两种请求靠**请求体里有没有那句答案**分辨：判分那一发会把他写的句子带上。
         * 判分必须回一个**过关**的分数 —— 没过关时结果页上只有「改好了，再提交」，
         * 「下一题」要过关才出现（D-121/D-122），那样就走不到结算。
         */
        const grading = body.includes(ANSWER)
        const payload = grading
          ? { grade: 4, why: '分寸到位', annotations: [] }
          : {
              /**
               * ★ 题型必须是**真的题型 key**（2026-08-14）。
               *
               * 这里原来写的是 `'rewrite'` —— 一个库里根本不存在的名字。
               * 老代码不校验，照收；现在收题有硬闸（他没勾的题型一道都不进），
               * 于是这三道会被全部丢掉，这条用例就走不到「结算失败」那一步了。
               * 假服务器要像真的服务商那样回话，否则挡住的是夹具、不是被验的东西。
               */
              questions: [1, 2, 3].map((tier) => ({
                tier,
                type: ['造句', '句子改写', '错误订正'][tier - 1],
                prompt: `用这个表达写一句话（第 ${tier} 档）`,
                reference: 'A reference sentence.'
              }))
            }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port

    a = await launch('study:settleLectures')

    // 配 AI 指向假服务
    await a.page.click('[data-testid="nav-settings"]')
    // 默认不分组：三组共用 heavy 那一套，所以只有 slot-heavy 会渲染
    await a.page.waitForSelector('[data-testid="slot-heavy"]')
    await a.page.fill('[data-testid="baseurl-heavy"]', `http://127.0.0.1:${port}/v1`)
    await a.page.fill('[data-testid="model-heavy"]', 'fake')
    await a.page.fill('[data-testid="key-heavy"]', 'sk-fake')
    await a.page.click('[data-testid="save-ai"]')
    await a.page.waitForSelector('[data-testid="save-ok"]')

    // 一讲、一条主动词汇、进轮转
    lec = await seed(a.page, '重试验收')
    await a.page.evaluate(async (id) => {
      await window.nyx.data.addItem(id, 'bear the brunt of', 'take the worst part', 'B', 'bear the brunt of')
      await window.nyx.study.startLearning(id)
    }, lec)
  })

  after(async () => {
    await shut(a)
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('★ 答到最后一题 → 跳过 → 结算失败 → 错误页出现', async () => {
    // 从工作台进产出练习 —— 这一讲已经在 training，那颗按钮就在
    await openLectureLoose(a.page, '重试验收', lec)
    await a.page.click('[data-testid="go-practice"]')
    // 题目出来了才有输入框。要推进到结算必须先答一题 ——
    // 「跳过这一题」只在**答完之后**的结果视图里，答之前只有「提交」
    await a.page.waitForSelector('[data-testid="answer"]', { timeout: 25000 }).catch(async () => {
      throw new Error(
        '等不到题目。屏幕上是：' + (await a.page.innerText('body')).replace(/\s+/g, ' ').slice(0, 400)
      )
    })
    await a.page.fill('[data-testid="answer"]', ANSWER)
    await a.page.click('[data-testid="submit"]')
    /**
     * 判分之后出现哪一颗，取决于过没过关（D-121：没过关只给判定，先改）。
     * 假 AI 回的不是判分 JSON，`grade` 落到默认的第 1 档 = 没过关，
     * 所以这里两颗都等，谁在点谁 —— 用例要验的是「到了队尾会去结算」，
     * 不是「一定过关」。
     */
    /**
     * 判分之后出现哪一颗，取决于过没过关（D-121：没过关只给判定，先改）。
     * 假 AI 回的不是判分 JSON，`grade` 落到默认的第 1 档 = 没过关，
     * 所以两颗都等、谁在点谁 —— 用例要验的是「到了队尾会去结算」，不是「一定过关」。
     *
     * 用 `attached` 而不是默认的 `visible`：结果区在下面，按钮一开始在可视区外，
     * 等「可见」会一直超时（第一版就卡在这里，看着像判分没回来，其实只是没滚到）。
     */
    await a.page
      .waitForSelector('[data-testid="next-question"], [data-testid="give-up"]', {
        state: 'attached',
        timeout: 20000
      })
      .catch(async () => {
        throw new Error(
          '提交之后没有推进按钮。屏幕上是：' +
            (await a.page.innerText('body')).replace(/\s+/g, ' ').slice(0, 500)
        )
      })
    const nextBtn = a.page.locator('[data-testid="next-question"]')
    const target = (await nextBtn.count()) > 0 ? nextBtn : a.page.locator('[data-testid="give-up"]')
    await target.scrollIntoViewIfNeeded()
    // 只有一条 —— 推进一次就到队尾，直接进结算
    await target.click()
    await a.page.waitForSelector('[data-testid="practice-error"]', { timeout: 15000 })
    const t = await a.page.innerText('[data-testid="practice-error"]')
    assert.ok(t.includes('注入的故障') || t.includes('settleLectures'), `错误页说的不是结算失败：${t}`)
  })

  it('★★ 点「重试」→ 它必须再试一次**结算**（而不是去出一道不存在的题）', async () => {
    await a.page.click('[data-testid="practice-retry"]')
    await a.page.waitForTimeout(1200)
    // 结算仍然被注入的故障挡着，所以还是错误页 —— 但错的必须还是「结算」
    await a.page.waitForSelector('[data-testid="practice-error"]', { timeout: 15000 })
    const t = await a.page.innerText('[data-testid="practice-error"]')
    assert.ok(
      t.includes('注入的故障') || t.includes('settleLectures'),
      `★ 重试之后报的不是结算失败 —— 它跑去出题了：${t}`
    )
  })
})
