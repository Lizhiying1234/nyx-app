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
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 侧边栏那个「待同步」数字必须是**现在**的数字 · 阶段⑦「重复状态」查出来的
 *
 * ── 它原来错在哪，为什么这一条值得单独立一道闸 ★★ ─────────────
 *
 * `refreshSync()` 全程只在启动时跑过一次，数字就此定格在开机那一刻。
 * 而徽章只在 `> 0` 时显示 —— **于是它错的方向恰好是危险的那一边**：
 * 开机是 0 就不显示，此后学一整天、攒下几百行没推上去，侧边栏依然干干净净。
 * 他有充分理由以为「都推上去了」。这不是显示不准，是在数据安全上给了假承诺。
 *
 * 所以这里验的**不是「有没有调 refreshSync」**（那是内部状态），
 * 是他眼睛能看见的那个数字，在他做了事情之后有没有跟着变。
 *
 * ── 负向对照顺带扒出来的第二件事 ★★★ ─────────────────────────
 *
 * 把修复拆掉重跑，**①也红了** —— 不只是数字不准：
 * `syncOn` 同样由那次「只跑一次」的读带出来，所以**配好同步之后侧边栏那一行
 * 根本不出现，要重启应用才有**。他配完只会觉得「点了没反应」。
 * 这条比数字那条更显眼，却一直没人报 —— 因为重启一次它就自己好了。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors: string[] = []
let dav: Server
let port = 0
let dataRoot = ''
let app: ElectronApplication
let page: Page

/** 只要能应答就行 —— 这条闸验的是本地那个数字，不验同步本身 */
function startDav(): Promise<void> {
  return new Promise((res) => {
    dav = createServer((req, r) => {
      if (req.method === 'PROPFIND') {
        r.writeHead(207, { 'content-type': 'application/xml' })
        r.end('<?xml version="1.0"?><multistatus xmlns="DAV:"></multistatus>')
        return
      }
      r.writeHead(req.method === 'GET' ? 404 : 201)
      r.end()
    })
    dav.listen(0, '127.0.0.1', () => res())
  })
}

/**
 * 侧边栏徽章现在写着几 —— 不显示就当 0（那正是原来那个 bug 的样子）
 *
 * ★ SC-23（2026-09-09）── 这一枚从 .kb 换到了 .badge 槽（D-456 N-1：
 *   「计数是状态，快捷键是提示」，两者不再共用同一个槽）。
 *   断言的意思一个字没改，改的只是它看哪一个元素 —— 而且改成了 testid，
 *   下一次换槽位不会再把它弄红。
 */
async function badge(): Promise<number> {
  const t = await page
    .locator('[data-testid="sync-badge"]')
    .textContent()
    .catch(() => null)
  return t === null ? 0 : Number(t.trim())
}

before(async () => {
  await startDav()
  port = (dav.address() as { port: number }).port
  dataRoot = mkdtempSync(join(tmpdir(), 'nyx-badge-'))
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')

  await page.click('[data-testid="nav-settings"]')
  await page.click('[data-testid="set-tab-sync"]')
  await page.click('[data-testid="sync-webdav"]')
  await page.fill('[data-testid="sync-url"]', `http://127.0.0.1:${port}/nyx-badge`)
  await page.fill('[data-testid="sync-user"]', 'me')
  await page.fill('[data-testid="sync-secret"]', 'app-password')
  await page.click('[data-testid="sync-save"]')
  await page.waitForSelector('[data-testid="sync-note"]')
})

after(async () => {
  await app?.close()
  dav?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不该让这条闸变红 */
  }
})

describe('侧边栏「待同步」是现在的数字（阶段⑦）', () => {
  it('① 配过同步之后，那一行是看得见的 —— 没有它下面几条都没有意义', async () => {
    await page.click('[data-testid="nav-home"]')
    await page.waitForSelector('[data-testid="nav-sync"]')
  })

  it('★★ ② 开机之后新建了东西，换个页面回来，数字必须跟着涨', async () => {
    await page.click('[data-testid="nav-home"]')
    const before0 = await badge()

    // 新建一个项目 —— 这就是他真会做的事，落库之后 pending 必然变多
    await page.click('[data-testid="add-project"]')
    await page.waitForTimeout(600)

    // 换一次页 —— 原来的写法在这里什么都不会发生
    await page.click('[data-testid="nav-files"]')
    await page.click('[data-testid="nav-home"]')

    await page.waitForFunction(
      (n: number) => {
        const el = document.querySelector('[data-testid="sync-badge"]')
        return el !== null && Number(el.textContent?.trim() ?? '0') > n
      },
      before0,
      { timeout: 6000 }
    )
    const after0 = await badge()
    assert.ok(after0 > before0, `换页之后徽章该涨，实际 ${before0} → ${after0}`)
  })

  it('③ 全程没有控制台报错', () => {
    assert.deepEqual(errors, [])
  })
})

/**
 * ══ T-4.10 · 知识库行上的记号（D-R24 ✅ A · 2026-09-06）══════════════
 *
 * 验的是**他眼睛能看见的东西**：哪几行挂着「还没分析」，哪几行挂着修正记号。
 * 判据本身在 `core/library-state.ts`（纯函数用例）与 `test:db`（真落库读回）那两档；
 * 这一档只回答一句话 —— **画出来的和算出来的是不是同一批**。
 *
 * ★★ 这一段同时是那个老 bug 的第三道闸：`libraryItems` 的 SELECT 里少了
 *    `hasSuspect` 那一列时，修正记号会画在**每一行**上（实测 6 / 6）。
 *    数一数就抓得住，而在这之前没有任何一条用例数过它。
 */
describe('T-4.10 · 知识库行上的记号只出现在该出现的行', () => {
  /** 喂真形状：3 条空释义（还没分析）+ 1 条有 suspect 块 + 1 条有释义 */
  it('★★ 「还没分析」只在空释义行，修正记号只在有 suspect 块的那一行', async () => {
    const seeded = await page.evaluate(async () => {
      const w = window as unknown as {
        nyx: {
          data: {
            createProject(n: string): Promise<number>
            createUnit(p: number, n: string): Promise<number>
            createLecture(u: number, n: string): Promise<number>
            addItem(l: number, t: string, g: string, layer: string, q: string): Promise<{ id: number }>
          }
        }
      }
      const p = await w.nyx.data.createProject('T-4.10 · 记号验收')
      const u = await w.nyx.data.createUnit(p, '第一单元 · 真实长度的单元名')
      const l = await w.nyx.data.createLecture(u, '第 1 讲 · 采集来的一批句子')
      // ★ addItem 返回的是 { id, layer, duplicateOf }，不是一个数字 —— 第一版把整个对象当 id 传下去了
      const add = async (t: string, g: string): Promise<number> =>
        (await w.nyx.data.addItem(l, t, g, 'A', 'They said it in the meeting.')).id
      const fresh1 = await add('bear the brunt of', '')
      const fresh2 = await add('at the mercy of', '')
      const fresh3 = await add('a far cry from', '')
      const suspect = await add('tangle up', '')
      const glossed = await add('hold water', '站得住脚')
      return { fresh: [fresh1, fresh2, fresh3], suspect, glossed }
    })

    /**
     * suspect 块 =「这条可能打错了」，修正记号只该出现在它身上。
     *
     * ★ D-468（2026-09-07）之前这一块是拿 `study.editBlock` 那条 IPC 种下去的。
     *   详情页的「改」取消之后那条 IPC 没有调用方，跟着删了 —— 这里改成直接写库。
     *   写的是**这一套自己的临时库**（`dataRoot`），不是他的真库；
     *   软件此刻是空闲的，每次查询都重新读库，所以插完不用重启也读得到。
     */
    const seedDb = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
    seedDb.exec('pragma busy_timeout = 5000')
    const at = Date.now()
    seedDb
      .prepare(
        `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
           values (?, 'suspect', ?, ?, ?)`
      )
      .run(seeded.suspect, '[{"was":"tangle up","should":"tangle with"}]', at, at)
    seedDb.close()

    await page.click('[data-testid="nav-lib-all"]')
    await page.waitForSelector('[data-testid="lib-rows"]')
    await page.waitForSelector(`[data-testid="unan-${seeded.fresh[0]}"]`)

    const unan = await page.locator('[data-testid^="unan-"]').count()
    const fix = await page.locator('[data-testid^="fixmark-"]').count()

    /**
     * suspect 那一条也没有释义，所以它也是「还没分析」？——**不是**。
     * suspect 本身就是一块解析块，它算「分析过了但没写出释义」（state = analysed），
     * 释义位留空。所以「还没分析」应当恰好 3 条。
     */
    assert.equal(unan, 3, `「还没分析」该恰好 3 条（三条空释义、无解析块），实际 ${unan} 条`)
    assert.equal(
      fix,
      1,
      `★★ 修正记号该只有 1 条（只有那条有 suspect 块），实际 ${fix} 条 —— ` +
        `全都有的话就是 libraryItems 的 SELECT 又漏了 hasSuspect 那一列`
    )

    // 记号挂在对的行上，不只是数目对
    for (const id of seeded.fresh) {
      assert.equal(await page.locator(`[data-testid="unan-${id}"]`).count(), 1, `第 ${id} 条该有「还没分析」`)
    }
    assert.equal(
      await page.locator(`[data-testid="unan-${seeded.glossed}"]`).count(),
      0,
      '有释义的那一条不该说「还没分析」'
    )
    assert.equal(
      await page.locator(`[data-testid="fixmark-${seeded.suspect}"]`).count(),
      1,
      '有 suspect 块的那一条该有修正记号'
    )
    assert.equal(
      await page.locator(`[data-testid="fixmark-${seeded.glossed}"]`).count(),
      0,
      '★★ 没有 suspect 块的行不许出现修正记号'
    )
  })

  it('★ 表头把「n 条还没分析」说出来', async () => {
    const t = await page.locator('[data-testid="lib-unanalysed"]').textContent()
    assert.ok(
      (t ?? '').includes('3 条还没分析'),
      `表头该写「3 条还没分析」，实际「${(t ?? '').trim()}」`
    )
  })

  it('★ 这一段全程没有控制台报错', () => {
    assert.deepEqual(errors, [])
  })
})
