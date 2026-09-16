import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { openLecture } from './tree.ts'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * ★★★ A-1 · 打开一讲的**第一眼**，不许是空白（2026-09-03 UI 审计）
 *
 * ── 病是什么 ────────────────────────────────────────────────
 *
 * 三个 Tab 的默认值原来写死 `'self'`（我的收集）。而「我的收集」只装
 * 「本讲我自己上传的原句」，**绝大多数讲次一条都没有** ——
 * 于是一个有 15 条知识点的讲次，打开之后正中央写着「**这个 Tab 是空的**」。
 * 他会以为这一讲什么都没有。
 *
 * ── ★★ 为什么单开一个文件，而不是塞进 smoke ──────────────────
 *
 * 我第一版就是塞进 `smoke.test.ts` 的，**而且是假绿**：
 * 那份夹具里「我的收集」本来就有 3 条，所以**默认落 self 也照样有内容** ——
 * 负向对照（把默认值退回写死 `'self'`）跑出来还是绿的。
 *
 * 这条闸要成立，前提是**「我的收集」必须是空的**。所以这里自己造数据：
 * 只加主动/被动，一条自收集都不加 —— 这样「默认落哪个 Tab」才真的决定了
 * 他第一眼看见的是内容还是空白。
 *
 * ★ 教训同 9.1 那条：**写完把修复删掉再跑一次，确认它变红。**
 *   不变红就说明这条用例没在验你以为它在验的东西。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-first-'))
const errors: string[] = []
let app: ElectronApplication
let page: Page
let lectureId = 0

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(9000)
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(900)

  // 造一讲：只有主动/被动，**一条自收集都没有**
  lectureId = await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('第一眼')
    const u = await window.nyx.data.createUnit(p, '单元')
    const l = await window.nyx.data.createLecture(u, '这一讲')
    await window.nyx.data.addItem(l, 'hold sway over', 'to dominate', 'B', 'It held sway over them.')
    await window.nyx.data.addItem(l, 'a far cry from', 'very different from', 'A', 'A far cry from it.')
    return l
  })
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不该让这条闸变红 */
  }
})

describe('★★★ A-1 · 进一讲的第一眼就该看见内容', () => {
  it('① 前提成立：这一讲的「我的收集」确实是空的', async () => {
    await openLecture(page, lectureId)
    await page.waitForSelector('[data-testid="tab-self"]')
    const self = (await page.locator('[data-testid="tab-self"]').innerText()).trim()
    assert.match(self, /0\s*$/, `前提不成立 —— 「我的收集」不是 0：「${self}」`)
  })

  it('★★★ ② 第一眼看见的是知识点，不是「这个 Tab 是空的」', async () => {
    assert.equal(
      await page.locator('[data-testid="items-empty"]').count(),
      0,
      '★ 这一讲明明有 2 条，进来第一眼却是空态 —— A-1 又回来了'
    )
    const text = await page.locator('[data-testid="item-rows"]').innerText()
    assert.match(text, /hold sway over/, `第一眼的列表里没有内容：${JSON.stringify(text)}`)
  })

  it('★★ ③ 但他一旦自己点了空的那个 Tab，就以他点的为准 —— 不许被自动落位抢回去', async () => {
    await page.click('[data-testid="tab-self"]')
    await page.waitForSelector('[data-testid="items-empty"]', { timeout: 6000 })
    // 自动落位只管「第一眼」，不替他做决定
    assert.equal(
      await page.locator('[data-testid="item-rows"]').count(),
      0,
      '他点了「我的收集」，界面却把他弹回别的 Tab'
    )
  })

  it('④ 全程没有控制台报错', () => {
    assert.deepEqual(errors, [])
  })
})

/**
 * ══ SC-25 · 首次引导（D-483 · 使用者 2026-09-15）═══════════════════
 *
 * 为什么和上面那一套同住一个文件：它们问的是同一件事的两半 ——
 * **他第一次打开这个软件，看见的是什么。**
 *
 * ★★ 这一段用 `mainWindow(app, 30_000, { keepOnboarding: true })`：
 *   共用帮手默认会把引导点掉（否则 26 套 smoke 全被它盖住），
 *   而这里要验的**就是那一层**，收掉了就成了一条永远绿的用例。
 *
 * ★ 负向对照（做过，见 §四）：把 `App.svelte` 里 `finishOnboarding` 的
 *   `ui.set` 那一句拆掉 → ③「再启动不该再出」当场红；
 *   把 `{#if onboarding}` 改成 `{#if false}` → ① 红。
 */
describe('★★★ SC-25 · 第一次打开这个软件（D-483）', () => {
  const root2 = mkdtempSync(join(tmpdir(), 'nyx-onb-'))
  let a2: ElectronApplication
  let p2: Page

  before(async () => {
    a2 = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NYX_DATA_ROOT: root2 } })
    p2 = await mainWindow(a2, 30_000, { keepOnboarding: true })
    /**
     * ★ 这一套自己**另起一个 app、另一个数据目录**（`root2`），
     *   `before` 里给第一个 app 标的「看过」对它一个字都不算 ——
     *   每起一次就得再标一次。
     *   不标的话：第一层一走完，空库首屏那条第二层引导立刻盖上来，
     *   下一条点 `nav-settings` 就永远点不到（真红过一次，报的错是「点不到」）。
     */
    await p2.waitForLoadState('domcontentloaded')
  })

  after(async () => {
    await a2?.close()
    keepOrClean(root2)
  })

  it('★★★ ① 新库第一次启动 —— 引导真的出来了', async () => {
    await p2.locator('[data-testid="onboarding"]').waitFor({ timeout: 20_000 })
    assert.equal(await p2.locator('[data-testid="onboarding"]').count(), 1)
  })

  it('★★★ ② 五步走得完，最后一颗键是「开始使用」', async () => {
    /** 第一步先对上：标题和正文都不是空的，而且说的是 core 里那一份 */
    assert.equal(await p2.locator('[data-testid="onboarding-step"]').innerText(), '1 / 5')
    const seen: string[] = []
    for (let n = 1; n <= 5; n++) {
      const title = (await p2.locator('[data-testid="onboarding-title"]').innerText()).trim()
      const body = (await p2.locator('[data-testid="onboarding-body"]').innerText()).trim()
      assert.ok(title.length > 0, `★ 第 ${n} 步没有标题`)
      assert.ok(body.length > 0, `★ 第 ${n} 步没有正文`)
      seen.push(title)
      assert.equal(await p2.locator('[data-testid="onboarding-step"]').innerText(), `${n} / 5`)
      const label = (await p2.locator('[data-testid="onboarding-next"]').innerText()).trim()
      assert.equal(
        label,
        n === 5 ? '开始使用' : '下一步',
        `★★ 第 ${n} 步那颗键写的是「${label}」`
      )
      if (n < 5) await p2.click('[data-testid="onboarding-next"]')
    }
    /** ★ 五步各不相同 —— 卡住不动的话上面每一步都会「通过」，但他看到的是同一句话 */
    assert.equal(new Set(seen).size, 5, `★★ 五步里有重复的标题：${seen.join(' / ')}`)
  })

  it('★★★ ③ 点「开始使用」之后引导就走了，背后是正常的软件', async () => {
    await p2.click('[data-testid="onboarding-next"]')
    await p2.locator('[data-testid="onboarding"]').waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(await p2.locator('[data-testid="onboarding"]').count(), 0)
    /** ★ 背后那一屏是活的 —— 只验主窗自己的导航在，不碰任何业务数据 */
    assert.equal(await p2.locator('[data-testid="nav-files"]').count(), 1, '★★ 引导收了，主窗却没露出来')
  })

  it('★★★ ④ 同一个库再启动一次 —— 不许再来一遍', async () => {
    await a2.close()
    a2 = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NYX_DATA_ROOT: root2 } })
    p2 = await mainWindow(a2, 30_000, { keepOnboarding: true })
    /**
     * ★ 这一套自己**另起一个 app、另一个数据目录**（`root2`），
     *   `before` 里给第一个 app 标的「看过」对它一个字都不算 ——
     *   每起一次就得再标一次。
     *   不标的话：第一层一走完，空库首屏那条第二层引导立刻盖上来，
     *   下一条点 `nav-settings` 就永远点不到（真红过一次，报的错是「点不到」）。
     */
    await p2.waitForLoadState('domcontentloaded')
    /** ★ 等主窗自己先出来，再断言引导没有 —— 不等的话「还没画出来」会冒充「没有」 */
    await p2.locator('[data-testid="nav-files"]').waitFor({ timeout: 20_000 })
    await p2.waitForTimeout(1500)
    assert.equal(
      await p2.locator('[data-testid="onboarding"]').count(),
      0,
      '★★★ 看完一次之后又弹了一遍 —— 使用者原话：「不要每次启动都重新显示」'
    )
  })

  it('★★★ ⑤ 设置里「再看一次新手引导」点了真的再看一次', async () => {
    await p2.click('[data-testid="nav-settings"]')
    await p2.click('[data-testid="set-tab-data"]')
    await p2.click('[data-testid="replay-onboarding"]')
    await p2.locator('[data-testid="onboarding"]').waitFor({ timeout: 10_000 })
    assert.equal(await p2.locator('[data-testid="onboarding-step"]').innerText(), '1 / 5', '★ 要从第一步开始')
    /** 收掉，别留给下一条 */
    await p2.click('[data-testid="onboarding-skip"]')
    await p2.locator('[data-testid="onboarding"]').waitFor({ state: 'detached', timeout: 10_000 })
  })

  it('★★ ⑥ 「跳过」也算看过 —— 再启动不许再弹', async () => {
    await a2.close()
    a2 = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NYX_DATA_ROOT: root2 } })
    p2 = await mainWindow(a2, 30_000, { keepOnboarding: true })
    /**
     * ★ 这一套自己**另起一个 app、另一个数据目录**（`root2`），
     *   `before` 里给第一个 app 标的「看过」对它一个字都不算 ——
     *   每起一次就得再标一次。
     *   不标的话：第一层一走完，空库首屏那条第二层引导立刻盖上来，
     *   下一条点 `nav-settings` 就永远点不到（真红过一次，报的错是「点不到」）。
     */
    await p2.locator('[data-testid="nav-files"]').waitFor({ timeout: 20_000 })
    await p2.waitForTimeout(1500)
    assert.equal(
      await p2.locator('[data-testid="onboarding"]').count(),
      0,
      '★★ 上一条是**跳过**关掉的，而跳过也该算看过'
    )
  })
})
