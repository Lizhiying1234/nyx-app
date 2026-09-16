import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { captureApp, keepOrClean } from './keep-on-fail.ts'

/**
 * 「声音」页 · 第 ③ 档（真 Electron）· D-466（使用者 2026-09-07「语音设置简化」）
 *
 * ══ 这一套盯的是什么 ═════════════════════════════════════════
 *
 * 这一页现在只有两个开关（词典语音 · 系统语音，默认都开）+ 口音 / 语速 +
 * 试听 + 一行「上次朗读走了谁」。所以这一套盯的就是**他看得见的那三件**：
 *
 *   ① 两个开关**画出来了**，出厂**都是开的**
 *   ② 各点一次**真的落库** —— 离开设置页再回来还是那一份
 *   ③ 试听之后诊断行**说得出谁读的、另一个为什么没轮上**（原因非空，不是毫秒）
 *   ④ 两个都关 → 那一次点击**说一句话**，不是静默
 *
 * ★ 上一版这里还有：来源拖动排序、八家提供者的徽章、地址 / 密钥输入框、
 *   「测试」按钮、缓存计数、一台只回 JSON 的假 TTS 服务器（T-9.8 那道闸）。
 *   D-466 把那条线整条撤了，所以那些用例连同那台假服务器一起删掉 ——
 *   守一个不存在的功能的闸，只会在下一次重构时被人当噪音绕过去。
 *
 * ★ 负向对照（`npm run gate` 之外手动做一次，T-7.10 完成标准）：
 *   · `resolve.ts` 把「词典关着」判反 → core 的「词典关 → 直接 system」红
 *   · 「两个都关」改成静默回系统音   → core 的「两个都关 → 空序列」红 + 这一套 ④ 红
 *   · `tts:save` 少存一把开关        → `test:db` 的 save → settings 来回红 + 这一套 ② 红
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-voice-'))

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  captureApp(app)
  page.setDefaultTimeout(8000)
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  await openVoice()
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

/** 进「声音」页，等两个开关画出来（**读到数据才画控件**，等一个确定的标记最稳） */
async function openVoice(): Promise<void> {
  await page.click('[data-testid="nav-settings"]')
  await page.click('[data-testid="set-tab-tts"]')
  await page.waitForSelector('[data-testid="voice-switches"]')
}

/** 离开设置页再回来 —— 强制重新问主进程要，验的才是库不是内存 */
async function reopen(): Promise<void> {
  await page.click('[data-testid="nav-home"]')
  await openVoice()
}

/** 界面上这两个开关现在是开是关 */
const shown = async (): Promise<Record<string, string | null>> =>
  page.evaluate(() => {
    const at = (id: string): string | null =>
      document.querySelector(`[data-testid="voice-on-${id}"]`)?.getAttribute('aria-checked') ?? null
    return { dictionary: at('dictionary'), system: at('system') }
  })

describe('D-466 ·「声音」页：两个开关看得见、按得动、存得住', () => {
  it('★★★ ① 两个开关都画出来了，而且**出厂都是开的**', async () => {
    assert.deepEqual(
      await shown(),
      { dictionary: 'true', system: 'true' },
      '★★★ 出厂两个都该是开的（使用者原话：「这两个选项默认都开启」）'
    )
    // 那条「顺序是写死的」的说明也要在 —— 他得知道为什么没有排序控件
    assert.match(
      await page.innerText('[data-testid="voice-order-says"]'),
      /词典.*没有.*系统|系统语音是通用兜底/s,
      '★★ 没告诉他两档之间是什么关系'
    )
  })

  it('★★★ ② 词典语音那个开关点一下**真的落库** —— 离开再回来还是关着', async () => {
    await page.click('[data-testid="voice-on-dictionary"]')
    await page.waitForTimeout(300)
    assert.equal((await shown()).dictionary, 'false', '点了没反应')

    await reopen()
    assert.equal(
      (await shown()).dictionary,
      'false',
      '★★★ 回来之后又变回开着了 —— 界面上改了、库里没改（少存一把开关就是这个形状）'
    )
    // 放回去，别影响后面的用例
    await page.click('[data-testid="voice-on-dictionary"]')
    await page.waitForTimeout(300)
    await reopen()
    assert.equal((await shown()).dictionary, 'true')
  })

  it('★★★ ② 系统语音那个开关也一样 —— 两把都要各自落库', async () => {
    await page.click('[data-testid="voice-on-system"]')
    await page.waitForTimeout(300)
    await reopen()
    assert.equal(
      (await shown()).system,
      'false',
      '★★★ 系统语音这一把没落库 —— 两把开关只存了一把，另一把按下去像是坏的'
    )
    // ★ 两把是**互不影响**的：刚才只关了系统，词典那把必须还开着
    assert.equal((await shown()).dictionary, 'true', '★★ 存一把把另一把也写了')
    await page.click('[data-testid="voice-on-system"]')
    await page.waitForTimeout(300)
    await reopen()
    assert.equal((await shown()).system, 'true')
  })

  it('口音、语速存得住，重开设置页还在（D-040 · 0.7–1.3×）', async () => {
    await page.click('[data-testid="tts-us"]')
    await page.locator('[data-testid="tts-rate"]').fill('0.8')
    await page.locator('[data-testid="tts-rate"]').dispatchEvent('input')
    await page.waitForTimeout(300)
    await reopen()
    await page.waitForSelector('[data-testid="tts-us"].on')
    assert.equal(await page.locator('[data-testid="tts-rate"]').inputValue(), '0.8')
    assert.deepEqual(
      [
        await page.locator('[data-testid="tts-rate"]').getAttribute('min'),
        await page.locator('[data-testid="tts-rate"]').getAttribute('max')
      ],
      ['0.7', '1.3']
    )
  })

  it('★★★ ③ 试听之后诊断行说得出谁读的，每一步的「为什么」不是空的', async () => {
    await page.click('[data-testid="tts-try"]')
    await page.waitForSelector('[data-testid="tts-note"]')
    await page.waitForTimeout(400)

    const trace = await page.innerText('[data-testid="voice-trace"]')
    assert.match(
      trace,
      /出的声|一个都没成/,
      `★★ 读完了，诊断行还是空的 —— 他没地方看「为什么不是词典音」：${trace.slice(0, 120)}`
    )
    assert.ok(
      /系统语音|词典语音/.test(trace),
      `★★ 诊断行里没有任何一档的名字：${trace.slice(0, 120)}`
    )

    /**
     * ★★ 「为什么」**单独读**，不按 `——` 切整行 —— 切出来的那半截里还带着毫秒，
     *   于是「原因是空的」也能凑够长度，对照照样绿（主控 2026-09-07 抓到）。
     * ★ 下限取 3：`core/voice/run.ts::reasonOf` 里最短的一句真话是「超时了」。
     */
    const steps = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="voice-trace"] .vtrace-steps li')].map((li) => ({
        who: (li.querySelector('b')?.textContent ?? '').trim(),
        why: (li.querySelector('[data-testid="vtrace-reason"]')?.textContent ?? '').trim()
      }))
    )
    assert.ok(steps.length > 0, '★★ 账本一步都没有')
    for (const st of steps) {
      assert.notEqual(st.why, '', `★★★ 账本点了「${st.who}」的名，「为什么」那一格是空的`)
      assert.ok(
        !/^[\d\s.,:msMS]+$/.test(st.why),
        `★★★ 「${st.who}」的「为什么」只有数字 / 毫秒：「${st.why}」—— 那不是原因，是耗时`
      )
      assert.ok(st.why.length >= 3, `★★★ 「${st.who}」的原因短得不像话：「${st.why}」`)
    }
  })

  it('★★★ ④ 两个都关 → 那一次点击**说一句话**，不是静默', async () => {
    await page.click('[data-testid="voice-on-dictionary"]')
    await page.waitForTimeout(250)
    await page.click('[data-testid="voice-on-system"]')
    await page.waitForTimeout(250)
    assert.deepEqual(await shown(), { dictionary: 'false', system: 'false' }, '前提没成立')

    const before = await page.innerText('[data-testid="tts-note"]').catch(() => '')
    await page.click('[data-testid="tts-try"]')
    await page.waitForFunction(
      (prev: string) => {
        const t = document.querySelector('[data-testid="tts-note"]')?.textContent ?? ''
        return t !== '' && t !== prev
      },
      before,
      { timeout: 8000 }
    )
    const note = await page.innerText('[data-testid="tts-note"]')
    assert.match(
      note,
      /两个开关都关着/,
      `★★★ 两个都关了却没说清是他关的 —— 他会去查一个不存在的故障。它说的是：${note}`
    )
    assert.match(note, /设置/, '★★ 没告诉他去哪儿打开')
    assert.ok(
      !/读出来了/.test(note),
      '★★★ 两个都关着却说「读出来了」—— 那就是偷偷用系统音读了，开关白拨'
    )

    // 放回去
    await page.click('[data-testid="voice-on-dictionary"]')
    await page.waitForTimeout(250)
    await page.click('[data-testid="voice-on-system"]')
    await page.waitForTimeout(250)
    await reopen()
    assert.deepEqual(await shown(), { dictionary: 'true', system: 'true' })
  })

  it('★★ 多厂商那一整套控件**一个都不许再出现**（D-466 撤的是功能，不是隐藏）', async () => {
    for (const gone of [
      'voice-sources',
      'voice-src-dictionary',
      'voice-prov-cloud',
      'tts-baseurl',
      'tts-key',
      'tts-model',
      'tts-voice',
      'tts-clear',
      'tts-cache',
      'tts-save-key'
    ]) {
      assert.equal(
        await page.locator(`[data-testid="${gone}"]`).count(),
        0,
        `★★ 「${gone}」还在页面上 —— 撤掉的功能留着控件，点下去只会让他更糊涂`
      )
    }
  })
})

describe('控制台', () => {
  it('渲染进程没有任何 console.error 或未捕获异常', () => {
    assert.deepEqual(consoleErrors, [], consoleErrors.join('\n'))
  })
})
