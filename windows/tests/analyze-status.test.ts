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
 * ★★ F-2-① · 分析途中拔电源，他那一讲必须原地不动
 *
 * ── 为什么这一套非得真的杀进程不可 ────────────────────────────
 *
 * 数据层那一整块矩阵（tests/db-safety.ts）验的是「两条路落到同一个状态」，
 * 但它的崩溃是**模拟**的：在进程里把那一行抄下来、跑完再写回去。
 * 模拟得再像，它也证明不了真被 `TerminateProcess` 掉的那一刻，
 * 库里剩下的就是它抄的那一份 —— WAL 有没有落盘、事务停在哪，都在模拟之外。
 *
 * 所以这里真的启动软件、真的开始一次分析、真的把进程杀掉、再真的重开一次，
 * 断言只看**他在屏幕上看得见的东西**。
 *
 * ── 两条路径，都是他真会走的 ──────────────────────────────────
 *
 * 第一讲：练起来了（有排期），想换套指令重拆一遍 —— 拆到一半电脑关了。
 *         重开之后它必须还在轮转里，排期一天都没挪 —— 不能被打回「待审阅」，
 *         因为再点一次「开始学」，练了几个月扩出来的间隔会重设成 1 天。
 *
 * 第二讲：★ 这一条是分歧点。AI 一条都没捞到（他遇到过好几次），
 *         这一讲停在「待审阅」，**没有排期、也没有一条知识点**。
 *         旧代码这时候 `status` 那一格被 `'analyzing'` 占着，进程一死就没人
 *         知道它原来是什么，重启后按「没排期 + 没内容」猜成 `empty` ——
 *         项目栏上那个「待审阅」标记就这么没了，他会以为自己没分析过。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const TERMS = ['bear the brunt of', 'a far cry from', 'at the mercy of']
const SOURCE = TERMS.map(
  (x) => `Coastal towns ${x} these storms every single year, and the damage compounds.`
).join(' ')

/** 假 AI：`fast` 正常答，`hang` 收下就不理 —— 用来把软件按在「正在分析」上 */
let mode: 'fast' | 'hang' = 'fast'
/** 这一轮让 AI「捞到」哪几条（空数组 = 一条都没捞到，那是他真遇到过的情况） */
let picks: string[] = TERMS
let sawHang: (() => void) | undefined

/** 重新挂一个「假 AI 收到请求了」的信号 —— 一次运行要断电两次 */
function armHang(): Promise<void> {
  return new Promise<void>((r) => (sawHang = r))
}

let app: ElectronApplication
let page: Page
let server: Server
let dataRoot = ''
let port = 0
let projectId = 0
let lecId = 0

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...(process.env as Record<string, string>), NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('[data-testid="nav-home"]')
}

/** 真的拔电源：杀掉主进程，`finally` 一行都不会跑 */
async function killAndRelaunch(): Promise<void> {
  app.process().kill('SIGKILL')
  await app.close().catch(() => {})
  await new Promise<void>((r) => setTimeout(r, 800))
  mode = 'fast'
  await launch()
}

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (mode === 'hang') {
        // 收下请求，永远不回 —— 软件就停在「正在分析」，正好在这里断电
        sawHang?.()
        return
      }
      // analyse-item.md 的 SYSTEM 头一句 —— 逐条写解析那几发不该拿到 items
      const payload = body.includes('You write the full entry for')
        ? { summary: 'ok' }
        : { items: picks.map((term) => ({ term, gloss: 'g', kind: 'chunk', layer: 'B' })) }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port

  dataRoot = mkdtempSync(join(tmpdir(), 'nyx-f2-'))
  await launch()

  await page.click('[data-testid="nav-settings"]')
  await page.waitForSelector('[data-testid="slot-heavy"]')
  await page.fill('[data-testid="baseurl-heavy"]', `http://127.0.0.1:${port}/v1`)
  await page.fill('[data-testid="model-heavy"]', 'fake')
  await page.fill('[data-testid="key-heavy"]', 'sk-fake')
  await page.click('[data-testid="save-ai"]')
  await page.waitForSelector('[data-testid="save-ok"]')
})

after(async () => {
  await app?.close().catch(() => {})
  if (dataRoot) keepOrClean(dataRoot)
  await new Promise<void>((r) => server.close(() => r()))
})

/**
 * 把项目栏展开到看得见这一讲那一行为止。
 *
 * 每次改动树、或者重开软件之后，展开状态都会收回去 —— 那一行还在 DOM 里，
 * 但父级 `.grp` 没有 `show`，点不到也读不到文字。第一版就栽在这里：
 * 断言超时说「找不到 nav-lecture-1」，看着像数据没了。
 */
async function ensureNavRow(): Promise<void> {
  const row = page.locator(`[data-testid="nav-lecture-${lecId}"]`)
  for (let i = 0; i < 8; i++) {
    if (await row.isVisible().catch(() => false)) return
    const unit = page.locator('[data-testid^="nav-toggle-unit-"]:has-text("单元")').first()
    const proj = page.locator('[data-testid^="nav-toggle-project-"]:has-text("崩溃恢复")').first()
    if (await unit.isVisible().catch(() => false)) await unit.click()
    else if (await proj.isVisible().catch(() => false)) await proj.click()
    else await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(400)
  }
  throw new Error(`项目栏里展不开第 ${lecId} 讲`)
}

/** 项目栏里这一讲那一行的文字 —— 「待审阅」这类标记就挂在上面 */
async function navRowText(): Promise<string> {
  await ensureNavRow()
  return (await page.innerText(`[data-testid="nav-lecture-${lecId}"]`)).replace(/\s+/g, ' ')
}

/**
 * 这一讲现在的状态与排期。
 * ★ D-469（2026-09-07）· 原来读的是 `browse.project()`（项目页那条通道），
 *   项目页取消之后那条 IPC 删了 —— 改读侧边栏那棵树的同一份数据
 *   （`data.tree()` 的 `LectureBrief` 本来就带 status / dueAt）。
 */
async function lectureRow(): Promise<{ status: string; dueAt: number | null }> {
  return await page.evaluate(
    async ([pid, lid]) => {
      const tree = await window.nyx.data.tree()
      const p = tree.find((x) => x.id === pid)!
      const l = p.units.flatMap((u) => u.lectures).find((x) => x.id === lid)!
      return { status: l.status, dueAt: l.dueAt }
    },
    [projectId, lecId]
  )
}

/** 走进那一讲的工作台 */
async function openLecture(): Promise<void> {
  await ensureNavRow()
  await page.click(`[data-testid="nav-lecture-${lecId}"]`)
  await page.waitForSelector('[data-testid="matbar"], [data-testid="drop-original"]', {
    timeout: 8000
  })
}

/** 点「分析 ▾」→（必要时全选）→「开始分析」 */
async function startAnalyze(): Promise<void> {
  await page.click('[data-testid="analyze"]')
  await page.waitForSelector('[data-testid="run-analyze"]')
  // 分析过的材料默认不勾（I-082）—— 重跑一份时他真实要多点这一下
  if (await page.locator('[data-testid="run-analyze"]').isDisabled()) {
    await page.click('[data-testid="scope-all"]')
    await page.waitForTimeout(200)
  }
  await page.click('[data-testid="run-analyze"]')
}

/** 新建一讲，贴上原文 */
async function seedLecture(name: string): Promise<number> {
  return await page.evaluate(
    async ([pid, n, text]) => {
      const tree = await window.nyx.data.tree()
      const u = tree.find((x) => x.id === (pid as number))!.units[0]!.id
      const l = await window.nyx.data.createLecture(u, n as string)
      await window.nyx.data.addOriginal(l, '测试材料', text as string)
      return l
    },
    [projectId, name, SOURCE]
  )
}

describe('★★ F-2-① · 分析途中真的把进程杀掉', () => {
  it('① 分析成功 → 停在待审阅', async () => {
    const ids = await page.evaluate(
      async ([text]) => {
        const p = await window.nyx.data.createProject('崩溃恢复验收')
        const u = await window.nyx.data.createUnit(p, '单元')
        const l = await window.nyx.data.createLecture(u, '第一讲')
        await window.nyx.data.addOriginal(l, '测试材料', text!)
        return [p, l]
      },
      [SOURCE]
    )
    projectId = ids[0]!
    lecId = ids[1]!

    await openLecture()
    await startAnalyze()
    await page.waitForSelector('[data-testid="review-banner"]', { timeout: 30000 })
    assert.equal((await lectureRow()).status, 'review', '分析成功该停在待审阅')
    assert.ok((await navRowText()).includes('待审阅'), '项目栏上没显示「待审阅」')
  })

  it('② 开始学 → 进轮转，「开始学」的横幅收起来', async () => {
    await page.click('[data-testid="start-learning"]')
    await page.waitForTimeout(1200)
    const l = await lectureRow()
    assert.equal(l.status, 'training', `该进轮转，实际 ${l.status}`)
    assert.ok(l.dueAt !== null, '进轮转却没有排期')

    /**
     * 屏幕上的证据：那条「这批我看过了 · 开始学」的横幅没了。
     *
     * 不去查「今日练习」里有没有它 —— `startLearning` 排的是**明天**，
     * 今天本来就不该出现。第一版拿它当断言，红的是断言不是代码。
     */
    await openLecture()
    assert.equal(
      await page.locator('[data-testid="start-learning"]').count(),
      0,
      '已经开始学了，工作台上还挂着「开始学」'
    )
  })

  it('★★ ③ 重新分析途中把进程杀掉 → 重开 → 还在轮转，排期一天没挪', async () => {
    const before = await lectureRow()
    const hang = armHang()
    mode = 'hang'
    await openLecture()
    await startAnalyze()
    // 等分析真的打出去了才动手 —— 早了就成了「什么都没发生就重启」
    await Promise.race([
      hang,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('假 AI 一直没收到请求')), 20000))
    ])

    await killAndRelaunch()

    const after = await lectureRow()
    assert.equal(
      after.status,
      'training',
      `★ 分析途中断电，重开之后这一讲变成了「${after.status}」—— 他什么都没做`
    )
    assert.equal(after.dueAt, before.dueAt, '★ 排期被挪动了 —— 他的进度不该因为一次断电而变')
    // 屏幕上：它没有被打回「待审阅」，工作台上不该冒出「开始学」
    await openLecture()
    assert.equal(
      await page.locator('[data-testid="start-learning"]').count(),
      0,
      '★ 断电重开之后它被打回了待审阅 —— 再点一次「开始学」，间隔会重设成 1 天'
    )
  })

  it('④ 另起一讲：AI 一条都没捞到 → 仍然是「待审阅」', async () => {
    picks = []
    lecId = await seedLecture('第二讲')
    await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(400)
    await openLecture()
    await startAnalyze()
    await page.waitForSelector('[data-testid="review-banner"]', { timeout: 30000 })

    const l = await lectureRow()
    assert.equal(l.status, 'review', `一条都没捞到也该停在待审阅，实际 ${l.status}`)
    assert.equal(l.dueAt, null, '还没开始学就有排期了')
    assert.ok((await navRowText()).includes('待审阅'), '项目栏上没显示「待审阅」')
  })

  it('★★ ⑤ 这一讲重新分析途中断电 → 重开 → 项目栏上「待审阅」必须还在', async () => {
    const hang = armHang()
    mode = 'hang'
    await openLecture()
    await startAnalyze()
    await Promise.race([
      hang,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('假 AI 一直没收到请求')), 20000))
    ])

    await killAndRelaunch()

    const after = await lectureRow()
    assert.equal(
      after.status,
      'review',
      `★ 断电之后这一讲从「待审阅」变成了「${after.status}」——\n` +
        `  没排期、没内容，旧代码重启时只能这么猜。他看到的是：分析过的一讲，标记没了。`
    )
    assert.ok(
      (await navRowText()).includes('待审阅'),
      `★ 项目栏上的「待审阅」不见了：${await navRowText()}`
    )
  })
})
