import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 反馈载体 · 第二轮 B4 / B5 / B12（2026-09-08 · UI-Win 地基第二轮）
 *
 * ══ 钉的是三件已裁的事 ═══════════════════════════════════════
 * ① **BTN-Q4 · 删除一律先弹确认框**，而且**三种确认形态收成一种**（X-09）。
 *    Windows 在这之前有三种：不问（侧栏树 · 批量删）· 系统 `confirm()`
 *    （删材料 · 删文章）· 拿 `.errbox` 拼出来的确认块（回收站彻底删除）。
 * ② **BTN-Q5 · 删完给 6 秒撤销的回执条**（NT-Q1 / NT-Q5）。
 *    删除三层保护是「确认框防误点 · **撤销条防手快** · 回收站 30 天防隔日反悔」——
 *    Windows 一直缺中间那层。
 * ③ **IX-05 · 焦点有来有回**；Dialog 的默认焦点在**取消**上（交互宪法 §8.2）——
 *    破坏性动作不该一个回车就发生。
 *
 * ══ 判据摆在最便宜的那一层 ═══════════════════════════════════
 * 「系统 `confirm()` 一处不留」是**源码文本**能判的事，不用起 Electron 也不用点 ——
 * 所以它是一条扫文件的用例。真要靠界面点出来反而钉不住：`confirm()` 会**卡住渲染进程**，
 * 用例只会超时，而超时看起来像「机器慢」。
 *
 * ★ 负向对照（改完拆掉再跑一次，确认它变红）：
 *   · 把 `SelBar.svelte` 的 `onclick={() => (askDel = true)}` 改回 `run('del')` → ①③ 红
 *   · 把 `toast.svelte.ts` 的 `sayUndo` 换成 `say`（不给撤销）→ ② 红
 *   · 把 `Dialog.svelte` 的 `cancelBtn?.focus()` 删掉 → 「默认焦点在取消」红
 *   · 在任何一个 `.svelte` 里写一句 `confirm('x')` → 「一处不留」红
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-fb-'))

let app: ElectronApplication
let page: Page

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  // 造一棵最小的树 —— 删的就是它
  await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('要删的项目')
    const u = await window.nyx.data.createUnit(p, '单元一')
    await window.nyx.data.createLecture(u, '第一讲')
  })
  await page.reload()
  await page.waitForTimeout(1500)
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

/**
 * 把注释挖成同样长度的空格 —— 行号不变，`confirm(` 这种字面只留代码里的那些。
 * 认三种：块注释 · 行注释 · 模板注释 `<!-- -->`。
 * ★ 字符串里恰好出现这些符号会被误伤，但这一条闸只判「有没有调用」，
 *   误伤的方向是**更严**不是更松 —— 宁可多报一处让人去看，也不要漏。
 */
function blank(src: string): string {
  const out = src.split('')
  const kinds: [string, string][] = [
    ['/' + '*', '*' + '/'],
    ['//', String.fromCharCode(10)],
    ['<!--', '-->']
  ]
  for (const [open, close] of kinds) {
    let i = 0
    while (i < out.length) {
      const at = src.indexOf(open, i)
      if (at < 0) break
      const end = src.indexOf(close, at + open.length)
      const stop = end < 0 ? src.length : end + close.length
      for (let k = at; k < stop; k++) if (out[k] !== String.fromCharCode(10)) out[k] = ' '
      i = stop
    }
  }
  return out.join('')
}

/** 打开侧栏第一个项目的 ⋮ 菜单并点「删除」，停在确认框上 */
async function askDeleteProject(): Promise<void> {
  await page.locator('[data-testid^="menu-project-"]').first().click()
  await page.click('[data-testid="tree-delete"]')
  await page.waitForSelector('[data-testid="tree-del-dlg"]')
}

describe('B5 · 删除先问一句，而且只有一种问法', () => {
  it('★★ 系统 confirm() 一处不留（X-09 · 它在 Electron 里会卡住渲染进程）', () => {
    const dir = join(root, 'src', 'renderer', 'src')
    const bad: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.svelte') || n.endsWith('.ts'))) {
      const raw = readFileSync(join(dir, f), 'utf8')
      /**
       * ★ **先把注释挖空再扫**，行号不能变，所以用同样长度的空格替换。
       *   第一版没挖，五处命中全是**注释里讲这段历史的句子**（「原来用的是系统 confirm()」）——
       *   闸红了，被测的东西却是对的。这正是 `check-css.mjs` 学过的那一课：
       *   判据要按语言的真实规则走，不能按「字面出现过」。
       */
      const txt = blank(raw)
      // 只找**调用**：`confirm(` 前面不是字母 / 点，才是全局那个 window.confirm
      for (let i = 0; i < txt.length; i++) {
        const at = txt.indexOf('confirm(', i)
        if (at < 0) break
        i = at
        const prev = at > 0 ? txt[at - 1]! : ' '
        if (/[A-Za-z0-9_.$]/.test(prev)) continue // onconfirm( / .confirm( / confirmLabel 之类
        bad.push(`${f}:${txt.slice(0, at).split('\n').length}`)
      }
    }
    assert.deepEqual(
      bad,
      [],
      `★★ 还有 ${bad.length} 处系统 confirm()：${bad.join(' · ')} —— BTN-Q4 要求收成应用内 Dialog 一种`
    )
  })

  it('★★ 侧栏树删除**先弹确认框**（在这之前点了就没了），标题给对象名', async () => {
    await askDeleteProject()
    assert.match(
      await page.innerText('[data-testid="tree-del-dlg-title"]'),
      /要删的项目/,
      '★ 标题里没有对象名 —— 泛指的「确认删除？」正是 BTN-Q4 要改掉的那一种'
    )
    // 文案说真话：软删不许写「不可撤销」「永久删除」（交互宪法 §8.2）
    const body = await page.innerText('[data-testid="tree-del-dlg-body"]')
    assert.match(body, /回收站|30 天/, `★ 正文没说清真正会发生什么：${body}`)
    assert.doesNotMatch(body, /不可撤销|永久删除/, `★ 软删的确认框在吓唬人：${body}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  it('★★ 默认焦点在「取消」上 —— 破坏性动作不该一个回车就发生', async () => {
    await askDeleteProject()
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
    assert.equal(focused, 'tree-del-dlg-cancel', `★ 焦点落在了 ${focused}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  it('★ Esc 与点遮罩都等于取消，而且**东西还在**（IX-03 同一个出口的两种手势）', async () => {
    await askDeleteProject()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="tree-del-dlg"]').count(), 0, '★ Esc 没关掉确认框')

    await askDeleteProject()
    await page.click('[data-testid="tree-del-dlg-scrim"]', { position: { x: 8, y: 8 } })
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="tree-del-dlg"]').count(), 0, '★ 点遮罩没关掉确认框')

    assert.equal(
      await page.locator('[data-testid^="nav-toggle-project-"]').count(),
      1,
      '★★ 取消了两次，项目却已经没了 —— 取消不是取消'
    )
  })

  it('★ 内容区高度上限是**全局**的 70vh（不许各屏再加一个局部值）', async () => {
    await askDeleteProject()
    const h = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tree-del-dlg"] .dlg-body')
      return el ? getComputedStyle(el).maxHeight : null
    })
    const vh = await page.evaluate(() => window.innerHeight)
    assert.ok(h, '★ 没有内容区，或者它没有 max-height')
    const px = Number.parseFloat(h!)
    assert.ok(
      Math.abs(px - vh * 0.7) < 2,
      `★ 内容区 max-height 是 ${h}，不是 70vh（窗口 ${vh}px）`
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })
})

describe('B4 · 删完给带撤销的回执条', () => {
  it('★★ 删掉之后出现回执条，**带一颗撤销**，而且说的是真实结果', async () => {
    await askDeleteProject()
    await page.click('[data-testid="tree-del-dlg-confirm"]')
    await page.waitForSelector('[data-testid="toast"]')

    const txt = await page.innerText('[data-testid="toast-text"]')
    assert.match(txt, /要删的项目/, `★ 回执没说是哪一个：${txt}`)
    assert.doesNotMatch(txt, /成功/, `★ 回执说了「成功」而不是真实结果（D-400）：${txt}`)
    assert.equal(await page.locator('[data-testid="toast-undo"]').count(), 1, '★★ 回执条上没有撤销')
    assert.equal(
      await page.locator('[data-testid^="nav-toggle-project-"]').count(),
      0,
      '★ 确认了却没真删'
    )
  })

  it('★★ 撤销**当场把东西拿回来**（不是记下来待会儿再说）', async () => {
    await page.click('[data-testid="toast-undo"]')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="nav-toggle-project-"]').length === 1,
      undefined,
      { timeout: 8000 }
    )
    /**
     * ★★ 2026-09-15 · 改判据的**形态**，不放宽（D-489 两端文案整理）
     *
     * 原来钉的是屏上那四个字「放回来了」。那四个字已经不在了 —— 而且把它改掉
     * 正是这一轮查出来的**真 bug**：撤销一次删除的回执写「放回来了」，
     * 静默那条路的回执也写「放回来了」，**回收站借走了静默的词**。
     * 现在这一条说的是「已从回收站恢复」。
     *
     * 断言跟着改形态，钉这条回执必须答全两件事（原来一件都没钉）：
     *   ① **哪样东西**回来了 —— 名字得在里头（上面那条删除回执已经这么钉了）
     *   ② 它**从哪儿**回来的 —— 回收站，而不是从静默里
     *
     * ★ 比原来严：原来句子里有那四个字就算过 —— 回执报错名字、或者张冠李戴
     *   说成是从静默里拿回来的，都照样绿。
     */
    const back = await page.innerText('[data-testid="toast-text"]')
    assert.match(back, /要删的项目/, `★ 回执没说是哪样东西回来了：${back}`)
    assert.match(
      back,
      /回收站/,
      `★ 回执没说它从哪儿回来 —— 撤销一次删除不等于从静默里拿回来：${back}`
    )
  })

  it('★ 不带撤销的那条 4 秒自己走（NT-Q5）', async () => {
    // 上一条那句「已从回收站恢复」就是不带撤销的那种
    assert.equal(await page.locator('[data-testid="toast-undo"]').count(), 0)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="toast"]').length === 0,
      undefined,
      { timeout: 8000 }
    )
  })
})
