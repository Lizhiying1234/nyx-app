import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * N-2 · 「我不要这个说法」这条意图，要跨得过删除 → 重新分析 → 恢复
 *
 * ── 为什么必须走真软件 ──────────────────────────────────────
 *
 * 这条 bug 的形状是：**审阅一批新分析结果时逐条 ✕ 剔掉不要的，
 * 重新分析同一份材料，它们全部回来。** 那个 ✕ 只在 `status='review'`
 * 时渲染 —— 也就是说，它只出现在最需要「拒绝」的那一刻。
 *
 * 数据层的用例能证明「两个入口写一样的账」，证明不了「他点那个 ✕ 之后
 * 再分析一次，屏幕上那一条真的不见了」。中间隔着 preload、IPC、
 * 分析流程里那两处 `verdictOf`。所以这一套用假 AI 顶上，真的走一遍。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 假 AI 每次都提这三条 —— 判「删掉的那条还会不会回来」只需要它稳定 */
const TERMS = ['bear the brunt of', 'a far cry from', 'at the mercy of']
const SOURCE = TERMS.map(
  (x) => `Coastal towns ${x} these storms every single year, and the damage compounds.`
).join(' ')

let app: ElectronApplication
let page: Page
let server: Server
let dataRoot = ''
let port = 0

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // analyse-item.md 的 SYSTEM 头一句 —— 逐条写解析那几发不该拿到 items
      const payload = body.includes('You write the full entry for')
        ? { summary: 'ok' }
        : { items: TERMS.map((term) => ({ term, gloss: 'g', kind: 'chunk', layer: 'B' })) }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port

  dataRoot = mkdtempSync(join(tmpdir(), 'nyx-del-'))
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...(process.env as Record<string, string>), NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')

  // 配 AI 指向假服务（默认不分组：三组共用 heavy 那一套）
  await page.click('[data-testid="nav-settings"]')
  await page.waitForSelector('[data-testid="slot-heavy"]')
  await page.fill('[data-testid="baseurl-heavy"]', `http://127.0.0.1:${port}/v1`)
  await page.fill('[data-testid="model-heavy"]', 'fake')
  await page.fill('[data-testid="key-heavy"]', 'sk-fake')
  await page.click('[data-testid="save-ai"]')
  await page.waitForSelector('[data-testid="save-ok"]')
})

after(async () => {
  await app?.close()
  if (dataRoot) keepOrClean(dataRoot)
  await new Promise<void>((r) => server.close(() => r()))
})

/** 建一讲、贴一份含那三个表达的原文，返回 lecture id */
async function seedLecture(name: string): Promise<number> {
  const id = await page.evaluate(
    async ([n, text]) => {
      const p = await window.nyx.data.createProject(n!)
      const u = await window.nyx.data.createUnit(p, '单元')
      const l = await window.nyx.data.createLecture(u, '第一讲')
      await window.nyx.data.addOriginal(l, '测试材料', text!)
      return l
    },
    [name, SOURCE]
  )
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  return id
}

/** 走进那一讲的工作台 */
async function openLecture(projectName: string, lecId: number): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  for (let i = 0; i < 5; i++) {
    const lec = page.locator(`[data-testid="nav-lecture-${lecId}"]`)
    if (await lec.isVisible().catch(() => false)) {
      await lec.click()
      await page.waitForSelector('[data-testid="matbar"], [data-testid="drop-original"]', {
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

/** 点「分析 ▾」→「开始分析」，等审阅横幅 */
async function analyze(): Promise<void> {
  await page.click('[data-testid="analyze"]')
  await page.waitForSelector('[data-testid="run-analyze"]', { timeout: 8000 })
  /**
   * 默认只勾**还没分析过**的材料（I-082）。重新分析同一份时默认是空的，
   * 那颗按钮会写着「开始分析（0 份）」并且是灰的 —— 所以先点「全选」。
   * 这一步就是他想重跑一份材料时真实要做的动作。
   */
  if (await page.locator('[data-testid="run-analyze"]').isDisabled()) {
    await page.click('[data-testid="scope-all"]')
    await page.waitForTimeout(200)
  }
  await page.click('[data-testid="run-analyze"]')
  await page.waitForSelector('[data-testid="review-banner"]', { timeout: 30000 })
}

/** 这一讲界面上列着哪些表达 */
async function shownTerms(lecId: number): Promise<string[]> {
  return await page.evaluate(async (id) => {
    const d = await window.nyx.data.lecture(id)
    return d.items.map((i) => i.term).sort()
  }, lecId)
}

describe('★★ N-2 · 审阅时逐条删掉的，重新分析不许回来', () => {
  let lec = 0

  it('分析一次 → 三条都在', async () => {
    lec = await seedLecture('删除语义验收')
    await openLecture('删除语义验收', lec)
    await analyze()
    const terms = await shownTerms(lec)
    assert.equal(terms.length, 3, `第一次分析该有 3 条，实际 ${terms.join('、')}`)
  })

  it('★ 在审阅态点那一条的 ✕（单条删除）', async () => {
    const target = await page.evaluate(async (id) => {
      const d = await window.nyx.data.lecture(id)
      return d.items.find((i) => i.term === 'a far cry from')!.id
    }, lec)
    // AI 提的这三条都是主动词汇（layer B），默认那个 Tab 是「我的收集」，
    // 不切过去的话那一行根本没渲染 —— 那个 ✕ 自然点不到
    await page.click('[data-testid="tab-active"]')
    await page.waitForTimeout(300)
    await page.click(`[data-testid="drop-${target}"]`)
    await page.waitForTimeout(600)
    const terms = await shownTerms(lec)
    assert.equal(terms.includes('a far cry from'), false, `删了却还在：${terms.join('、')}`)
    assert.equal(terms.length, 2, `该剩 2 条，实际 ${terms.join('、')}`)
  })

  it('★★ 重新分析同一份材料 → 那一条不许回来，而且要说清为什么', async () => {
    await analyze()
    const terms = await shownTerms(lec)
    assert.equal(
      terms.includes('a far cry from'),
      false,
      `★ 逐条删掉的表达重新分析又回来了 —— 这正是 N-2：${terms.join('、')}`
    )
    // 不是静默消失：分析结果里要明说「以前删过，没收进来」
    await page.waitForSelector('[data-testid="analyze-skipped"]', { timeout: 8000 })
    const note = await page.innerText('[data-testid="analyze-skipped"]')
    assert.ok(note.includes('a far cry from'), `跳过名单里没点名是哪一条：${note}`)
  })

  it('★ 换一份**别的**材料，同一表达仍然不许进来（账本是全局的）', async () => {
    await page.evaluate(
      async ([id, text]) => {
        await window.nyx.data.addOriginal(
          id as number,
          '第二份材料',
          `A completely different passage. ${text as string}`
        )
      },
      [lec, 'It was a far cry from what the council had promised the residents.']
    )
    await openLecture('删除语义验收', lec)
    await analyze()
    const terms = await shownTerms(lec)
    assert.equal(
      terms.includes('a far cry from'),
      false,
      `★ 换一份材料就又进来了 —— 账本该是按字面全局生效的：${terms.join('、')}`
    )
  })
})

describe('★★ N-2 · 从垃圾箱恢复 → 拒绝撤销 → 重新分析可以再进来', () => {
  let lec = 0

  it('分析、删一条、确认它进了垃圾箱', async () => {
    lec = await seedLecture('恢复语义验收')
    await openLecture('恢复语义验收', lec)
    await analyze()
    const target = await page.evaluate(async (id) => {
      const d = await window.nyx.data.lecture(id)
      return d.items.find((i) => i.term === 'at the mercy of')!.id
    }, lec)
    await page.click('[data-testid="tab-active"]')
    await page.waitForTimeout(300)
    await page.click(`[data-testid="drop-${target}"]`)
    await page.waitForTimeout(600)

    await page.click('[data-testid="nav-trash"]')
    await page.waitForTimeout(600)
    const body = await page.innerText('body')
    assert.ok(body.includes('at the mercy of'), `垃圾箱里找不到它：${body.replace(/\s+/g, ' ').slice(0, 300)}`)
  })

  it('★ 从垃圾箱恢复 → 重新分析 → 它可以再进来', async () => {
    await page.locator('[data-testid^="trash-ck-item-"]').first().click()
    await page.waitForSelector('[data-testid="trash-restore-picked"]')
    await page.click('[data-testid="trash-restore-picked"]')
    await page.waitForTimeout(800)

    await openLecture('恢复语义验收', lec)
    await analyze()
    const terms = await shownTerms(lec)
    assert.ok(
      terms.includes('at the mercy of'),
      `★ 恢复之后重新分析仍然进不来 —— 那条「我不要」没被撤销，而他完全看不出为什么：${terms.join('、')}`
    )
  })
})
