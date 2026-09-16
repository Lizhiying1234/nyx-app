import { SILENCE_ACTIONS } from '../src/core/silence.ts'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { captureApp, keepOrClean } from './keep-on-fail.ts'

/**
 * ★★ F-2-② · 练出来的间隔，重新分析之后必须还在
 *
 * ── 为什么这一套非得走真软件 ──────────────────────────────────
 *
 * 数据层那一块（tests/db-safety.ts）证明的是「库里的数对了」。
 * 但他看不见库。他看见的是那条横幅上写的一句话，而**那句话以前是写死的**：
 *
 *     先过一遍认读卡把它们认熟 —— 明天开始产出练习。
 *
 * 就算后端改对了、间隔真的保住了 12 天，这句话还会告诉他「明天」。
 * 他照着做，明天打开发现没有这一讲 —— 于是他信的是那句话，不是数据。
 * **后端修好、界面还在骗人，对他来说就是没修好。**
 *
 * ── 这一套怎么造「已经练到 12 天」这个前提 ──────────────────
 *
 * 界面上练到 12 天要真的答 6 场、跨 25 天，测试里做不到。
 * 所以直接改那份**测试用的**库（`NYX_DATA_ROOT` 下的临时库，不是他的库），
 * 把 `interval_days` / `due_at` 摆成练过的样子 —— 相当于把时钟拨过去。
 * 从那一刻起，往下的每一步都是他真实的点击。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const TERMS = ['bear the brunt of', 'a far cry from', 'at the mercy of']
const SOURCE = TERMS.map(
  (x) => `Coastal towns ${x} these storms every single year, and the damage compounds.`
).join(' ')

/** 假 AI 这一轮提哪几条 —— 改它就能造出「有新知识点 / 没有新知识点」两种重新分析 */
let picks: string[] = TERMS

let app: ElectronApplication
let page: Page
let server: Server
let dataRoot = ''
let port = 0
let lecId = 0

/** 25 天后的零点 —— 「原排期」就摆在这里 */
const D25 = ((): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 25)
  return d.getTime()
})()

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
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

  dataRoot = mkdtempSync(join(tmpdir(), 'nyx-f2b-'))
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...(process.env as Record<string, string>), NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  captureApp(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')

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
 * 把时钟拨到「已经练了 6 次」那个状态。
 *
 * 直接开这份**临时**库改两列。他的真实库全程只读，这里动的是
 * `NYX_DATA_ROOT` 指向的那个 mkdtemp 目录。
 */
function pretendTrained(interval: number, dueAt: number): void {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
  db.prepare(`update lectures set interval_days = ?, due_at = ? where id = ?`).run(
    interval,
    dueAt,
    lecId
  )
  db.close()
}

/** 把这一讲摆回「待审阅」—— 软件自己产生得出来的状态，这里只是省掉一次分析 */
function forceReview(): void {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
  db.prepare(`update lectures set status = 'review' where id = ?`).run(lecId)
  db.close()
}

function lectureRowFromDb(): {
  status: string
  dueAt: number | null
  interval: number
  silent: number
} {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db
    .prepare(
      `select status, due_at as dueAt, interval_days as interval, silent from lectures where id = ?`
    )
    .get(lecId) as { status: string; dueAt: number | null; interval: number; silent: number }
  db.close()
  return r
}

async function ensureNavRow(): Promise<void> {
  const row = page.locator(`[data-testid="nav-lecture-${lecId}"]`)
  for (let i = 0; i < 8; i++) {
    if (await row.isVisible().catch(() => false)) return
    const unit = page.locator('[data-testid^="nav-toggle-unit-"]:has-text("单元")').first()
    const proj = page.locator('[data-testid^="nav-toggle-project-"]:has-text("排期身份")').first()
    if (await unit.isVisible().catch(() => false)) await unit.click()
    else if (await proj.isVisible().catch(() => false)) await proj.click()
    else await page.click('[data-testid="nav-home"]')
    await page.waitForTimeout(400)
  }
  throw new Error(`项目栏里展不开第 ${lecId} 讲`)
}

async function openLecture(): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await page.waitForTimeout(300)
  await ensureNavRow()
  await page.click(`[data-testid="nav-lecture-${lecId}"]`)
  await page.waitForSelector('[data-testid="matbar"], [data-testid="drop-original"]', {
    timeout: 8000
  })
}

async function analyze(): Promise<void> {
  await page.click('[data-testid="analyze"]')
  await page.waitForSelector('[data-testid="run-analyze"]')
  if (await page.locator('[data-testid="run-analyze"]').isDisabled()) {
    await page.click('[data-testid="scope-all"]')
    await page.waitForTimeout(200)
  }
  await page.click('[data-testid="run-analyze"]')
  await page.waitForSelector('[data-testid="review-banner"]', { timeout: 30000 })
}

/** 点「这批我看过了 · 开始学」，把横幅上他看得见的话读回来 */
async function clickStart(): Promise<{ banner: string; due: string; interval: string }> {
  await page.click('[data-testid="start-learning"]')
  await page.waitForSelector('[data-testid="started-banner"]', { timeout: 8000 })
  return {
    banner: (await page.innerText('[data-testid="started-banner"]')).replace(/\s+/g, ' '),
    due: await page.innerText('[data-testid="started-due"]'),
    interval: await page.innerText('[data-testid="started-interval"]')
  }
}

const zh = (t: number): string => new Date(t).toLocaleDateString('zh-CN')

describe('★★ F-2-② · training(12 天) → 重新分析 → review → 开始学', () => {
  it('① 第一次开始学：横幅说「间隔 1 天」，到期日是明天', async () => {
    const ids = await page.evaluate(
      async ([text]) => {
        const p = await window.nyx.data.createProject('排期身份验收')
        const u = await window.nyx.data.createUnit(p, '单元')
        const l = await window.nyx.data.createLecture(u, '第一讲')
        await window.nyx.data.addOriginal(l, '测试材料', text!)
        return [p, l]
      },
      [SOURCE]
    )
    lecId = ids[1]!

    await openLecture()
    await analyze()
    const shown = await clickStart()

    assert.match(shown.interval, /间隔 1 天/, `横幅上的间隔不对：${shown.interval}`)
    const tomorrow = new Date()
    tomorrow.setHours(0, 0, 0, 0)
    tomorrow.setDate(tomorrow.getDate() + 1)
    assert.equal(shown.due, zh(tomorrow.getTime()), `到期日不是明天：${shown.due}`)

    const l = lectureRowFromDb()
    assert.equal(l.status, 'training')
    assert.equal(l.interval, 1, '第一次开始学的间隔该是 1 天')
    assert.equal(l.dueAt, tomorrow.getTime(), '第一次开始学该排在明天')
  })

  it('★★ ② 练到 12 天间隔 → 重新分析（没有新知识点）→ 开始学：间隔仍是 12，排期一天没挪', async () => {
    pretendTrained(12, D25)

    // 和上次一模一样的三条 —— 全部会被判成「这一讲已经有了」，一条新的都不进来
    picks = TERMS
    await openLecture()
    await analyze()
    assert.equal(lectureRowFromDb().status, 'review', '重新分析完该停在待审阅')
    assert.equal(lectureRowFromDb().interval, 12, '重新分析本身就把间隔改了')

    const shown = await clickStart()
    assert.match(
      shown.interval,
      /间隔 12 天/,
      `★ 横幅告诉他间隔变了：${shown.interval} —— 那是练了 6 次攒出来的`
    )
    assert.equal(
      shown.due,
      zh(D25),
      `★ 横幅上的下次到期日被提前了：${shown.due}，应该还是 ${zh(D25)}`
    )
    assert.ok(
      !/明天开始产出练习/.test(shown.banner),
      `★ 横幅还在说「明天开始产出练习」，而实际排期在 25 天后：${shown.banner}`
    )

    const l = lectureRowFromDb()
    assert.equal(l.interval, 12, `★ 库里的间隔被打回 ${l.interval}`)
    assert.equal(l.dueAt, D25, '★ 库里的排期被改了')
    assert.equal(l.status, 'training')
  })

  it('★★ ③ 再重新分析一次，这回有 1 条新知识点 → 间隔与排期照旧，新知识点进认读', async () => {
    // 回到待审阅：加一份新材料，让分析有活干
    picks = [...TERMS, 'in the wake of']
    await page.evaluate(
      async ([id, text]) => {
        await window.nyx.data.addOriginal(id as number, '第二份材料', text as string)
      },
      [lecId, 'The town rebuilt in the wake of the flood, and life went on.']
    )
    await openLecture()
    await analyze()

    const shown = await clickStart()
    assert.match(shown.interval, /间隔 12 天/, `★ 新增了一条就把间隔打回去：${shown.interval}`)
    assert.equal(shown.due, zh(D25), `★ 新增了一条就把整讲提前到明天：${shown.due}`)
    /**
     * ★ B-7（2026-09-14）·「表达」→「知识点」（TM-31）跟着 core 的 `reason` 一起改。
     *   这一条是那次改动的**第二个正向对照**：`core/start-learning.ts` 那句话改完，
     *   它在这里当场红（actual 是横幅上真显示的新那句）—— 证明 core 那五句
     *   **真的会走到他眼前的横幅上**，不是只活在单测里。
     */
    assert.match(
      shown.banner,
      /1 条新知识点/,
      `★ 横幅没说清楚那条新知识点现在能干什么：${shown.banner}`
    )

    const l = lectureRowFromDb()
    assert.equal(l.interval, 12)
    assert.equal(l.dueAt, D25)

    // 新知识点真的进了认读队列 —— 「说了」和「做了」必须是同一件事
    const readable = await page.evaluate(async (id) => {
      const cards = await window.nyx.study.dueCards(id as number, 99)
      return cards.map((c) => c.term)
    }, lecId)
    assert.ok(
      readable.includes('in the wake of'),
      `★ 横幅说它现在就能认读，认读队列里却没有它：${readable.join('、')}`
    )
  })

  /**
   * ★★ F-2-②-e · ⑧ 绕过界面，直接从渲染层调那条 IPC。
   *
   * 这才是这条约束真正的验收点。界面上归档的讲根本不在项目栏里、
   * 那颗按钮也只在 `status==='review'` 时渲染 —— 光点界面**永远点不到**，
   * 于是「后端有没有拦住」这件事在界面上是验不出来的（假绿）。
   * `page.evaluate` 里的 `window.nyx.study.startLearning` 走的是
   * preload → ipcRenderer.invoke → 主进程 handler，和界面那颗按钮同一条路，
   * 只是没有按钮挡在前面。
   */
  it('★★ ⑧ 归档一个**待审阅**的讲，绕过界面直接调 IPC → 必须被拒绝，理由是「已归档」', async () => {
    /**
     * ★ 前提必须是 `silent=1 ∧ status='review'`，不能是 training。
     *
     * 第一版写的是「归档它、然后调 IPC」，而那时它已经是 training ——
     * `status='review'` 那一半就把它挡住了，`silent` 那一半**根本没被考到**。
     * 把 `and silent = 0` 删掉跑负向对照，这条用例照样绿。**假绿。**
     * 所以先把它摆回待审阅，再归档 —— 那正是他真会遇到的形状：
     * 分析完还没点「开始学」，先把这一讲归档了。
     */
    forceReview()
    await page.evaluate(async (id) => {
      // 右键菜单的「归档」走的就是这个 setSilent
      await window.nyx.data.setSilent('lecture', id as number, true)
    }, lecId)

    const before = lectureRowFromDb()
    assert.equal(before.silent, 1, '前提没成立：这一讲没归档')
    assert.equal(
      before.status,
      'review',
      `★ 前提没成立：要的是「归档 + 待审阅」，实际是 ${before.status} —— ` +
        `那样这条用例考不到 silent 那一半（假绿）`
    )
    assert.equal(before.dueAt, null, '归档该把排期清掉')

    const out = await page.evaluate(
      async (id) => await window.nyx.study.startLearning(id as number),
      lecId
    )
    assert.equal(
      out.refused,
      'archived',
      `★ 后端没拦住已归档的讲，或者说错了理由：${JSON.stringify(out)}`
    )
    /**
     * ★ 钉的是「有没有告诉他下一步」，不是钉某四个字 ——
     *   所以认的是**那颗按钮现在写的词**（D-489 把全部层统一成「静默 / 恢复」）。
     *   按钮改名而这句话没跟上，就是把他指向一个不存在的东西。
     */
    assert.ok(
      out.reason.includes(SILENCE_ACTIONS.restore),
      `没告诉他下一步该干什么：${out.reason}`
    )

    const after = lectureRowFromDb()
    assert.equal(after.dueAt, null, '★ 给一个已归档的讲写上了到期日 —— 这正是 silent-but-due')
    assert.equal(after.interval, before.interval, '★ 间隔被动了')
    assert.equal(after.status, before.status, '★ 状态被动了')

    // 体检也必须干净 —— 这条约束的最终判据就是它
    const findings = await page.evaluate(
      async () => (await window.nyx.health.audit()).findings.map((f) => f.id)
    )
    assert.ok(
      !findings.includes('silent-but-due'),
      `★ 「开始学」自己造出了一条 error 级异常：${findings.join('、')}`
    )
  })
})
