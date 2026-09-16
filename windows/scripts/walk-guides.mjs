/**
 * 按**使用者真实的状态**走一遍每个页面，看七条引导各出不出 · I-190
 *
 * ══ 为什么要有这个脚本 ★★★ ═══════════════════════════════════
 *
 * `smoke:guide` 11 条全绿，而他装上真用时**一条都没出现过**（真库里
 * `ui.guide.seen` 那一行根本不存在 = 从来没有一条被看过）。
 * 病不在实现，在**用例摆的局面他的库从来不满足**：
 *   · `today-paste` 我钉的条件是「库为空」—— 他库里有几百条
 *   · `sidebar-tree` 钉在「点击展开那一下」—— 他的侧栏本来就是展开的
 *   · 其余几条要先走到某个状态
 * 用例自己把局面摆成满足条件的样子，于是绿得理直气壮。
 *
 * ☞ 所以判据换成**他的状态**：第一层看完 · `seen` 空 · **库非空**。
 *   这个脚本就是那句验收（「真起软件按他的状态走七个页面」）的可重复版本。
 *
 * 用法：node scripts/walk-guides.mjs　—— 屏上打一张表，出图在 shots/walk-*.png
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'
import { GUIDE_SEEN_KEY, ONBOARDING_KEY, PAGE_GUIDES } from '../src/core/onboarding.ts'

const shot = process.env.NYX_WALK_SHOT === '1'
mkdirSync('shots', { recursive: true })
const root = join(process.cwd(), '.shots-walk')
rmSync(root, { recursive: true, force: true })

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, NYX_DATA_ROOT: root, NYX_NO_SYNC_TIMERS: '1' }
})
const page = await mainWindow(app)
/** ★ T-3 那行 warn 就是给这儿用的：「有触发、没目标」在屏上完全无声 */
const warns = []
page.on('console', (m) => {
  if (m.type() === 'warning' && m.text().includes('[guide]')) warns.push(m.text())
})
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

/** ══ 摆成他的状态：第一层看完 · seen 空 · **库非空** ══ */
await page.evaluate(
  async ([ob, gs]) => {
    await window.nyx.ui.set(String(ob), String(Date.now()))
    await window.nyx.ui.set(String(gs), '{}')
  },
  [ONBOARDING_KEY, GUIDE_SEEN_KEY]
)
await page.evaluate(async () => {
  const p = await window.nyx.data.createProject('他的项目')
  const u = await window.nyx.data.createUnit(p, '第一单元')
  const l = await window.nyx.data.createLecture(u, 'Demo Lecture')
  for (const [t, g, q] of [
    ['bear the brunt', '承受最重的那一下', 'She bore the brunt of the criticism.'],
    ['hold sway', '占主导、说了算', 'That view still holds sway.'],
    ['a far cry from', '差得远', 'A far cry from what we expected.']
  ]) {
    await window.nyx.data.addItem(l, t, g, 'B', q)
  }
})
await page.reload()
await page.waitForTimeout(1600)

const open = async () => {
  const n = await page.locator('.gd-box').count()
  if (n === 0) return null
  return ((await page.locator('.gd-box').first().getAttribute('data-testid')) ?? '').replace(
    /^guide-/,
    ''
  )
}
/**
 * 把屏上开着的框全关掉。
 * ★★ **循环关**，不是关一次：一页上可能有两条（Today 就是 `today-paste` ＋ `sidebar-tree`），
 *   关掉第一条之后第二条可能接着出。只关一次的话，剩下那张遮罩会把下一站的点击整个吃掉 ——
 *   报出来的错是「点不到 nav-home」，跟真正的问题毫无关系。
 */
const closeAll = async () => {
  for (let i = 0; i < 8; i++) {
    if ((await open()) === null) return
    await page.click('.gd-ok .btn')
    await page.waitForTimeout(350)
  }
}

/**
 * 摆局：把**除了要量的那一条之外**全标成看过，然后重载。
 *
 * ══ 为什么不是「清空再走过去」★★★ ═══════════════════════════
 *
 * 清空之后重载，落地那一屏（Today）自己就会弹出它那条 —— 我要是顺手关掉它
 * 再走去下一站，就等于**在量之前把它消费掉了**；不关的话它那张遮罩又会把
 * 下一站的点击整个吃掉。我在这上面连着误判了三趟，三趟都读成「Today 不出引导」。
 *
 * 只留一条就没有这个两难：别的都出不来，屏上那个框**只可能是**要量的那一条。
 *
 * ★★★ 清「看过」之后**必须 reload**：渲染层把那张表**缓存在模块里**
 *   （`ui:get` 每次走 IPC，而触发点会被反复碰到，所以只读一次）。
 *   只写库不重载，内存里那份还记着「看过了」，`askGuide` 直接返回 ——
 *   屏上什么都不发生、**连放弃的 warn 都没有**，看着就像「这一页不出引导」。
 *   ☞ 产品上对应的那一处是对的：设置里「把页面引导重新打开」**同时**
 *     清了内存那份和库里那份，所以它不用重启。
 */
const onlyThisOne = async (keep) => {
  const seen = Object.fromEntries(
    PAGE_GUIDES.filter((g) => g.id !== keep).map((g) => [g.id, g.version])
  )
  await page.evaluate(
    async ([k, json]) => await window.nyx.ui.set(String(k), String(json)),
    [GUIDE_SEEN_KEY, JSON.stringify(seen)]
  )
  await page.reload()
  await page.waitForTimeout(1400)
}

/**
 * 每一站：只留那一条 → 走到那一页 → 等一会 → 看有没有框。
 * ★ 不点任何「展开 / 切换」—— 他进页面就该看见，那正是这一轮要改的判据。
 */
const stops = [
  ['Today（库非空）', 'today-paste', async () => await page.click('[data-testid="nav-home"]')],
  ['侧栏树（不点展开）', 'sidebar-tree', async () => await page.click('[data-testid="nav-home"]')],
  [
    'Settings › Assist · 取词入口',
    'capture-entry',
    async () => {
      await page.click('[data-testid="nav-settings"]')
      await page.waitForTimeout(500)
      await page.click('[data-testid="set-tab-assist"]')
    }
  ],
  [
    'Settings › Assist · 收下放哪儿',
    'assist-lecture',
    async () => {
      await page.click('[data-testid="nav-settings"]')
      await page.waitForTimeout(500)
      await page.click('[data-testid="set-tab-assist"]')
    }
  ],
  ['Vault · 静默', 'vault-learned', async () => await page.click('[data-testid="nav-lib-silent"]')],
  ['攻坚区', 'vault-hard', async () => await page.click('[data-testid="nav-hard"]')],

  /** ── 覆盖面清单 §二 那几条（T-2，2026-09-15）────────────── */
  ['Today · 今天这个数', 'today-recommend', async () => await page.click('[data-testid="nav-home"]')],
  [
    '讲次工作台',
    'lecture-split',
    async () => {
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(400)
      await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
      await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
      await page.locator('[data-testid^="nav-lecture-"]').first().click()
    }
  ],
  ['回收站', 'trash-tiers', async () => await page.click('[data-testid="nav-trash"]')],
  [
    '知识点详情',
    'item-analysis',
    async () => {
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(400)
      await openIfClosed('[data-testid^="nav-toggle-project-"]', '[data-testid^="nav-toggle-unit-"]')
      await openIfClosed('[data-testid^="nav-toggle-unit-"]', '[data-testid^="nav-lecture-"]')
      await page.locator('[data-testid^="nav-lecture-"]').first().click()
      await page.waitForTimeout(700)
      await page.locator('[data-testid="item-rows"] .lrow .lt').first().click()
    }
  ],
  [
    '分析报告',
    'report-layers',
    async () => {
      /** ★ 报告页没有侧栏入口（D-467 撤了那一行）—— 入口是 Today 底下那条横条 */
      await page.click('[data-testid="nav-home"]')
      await page.waitForTimeout(500)
      await page.click('[data-testid="home-report"]')
    }
  ],
  [
    '设置 › Prompt',
    'prompt-area',
    async () => {
      await page.click('[data-testid="nav-settings"]')
      await page.waitForTimeout(400)
      await page.click('[data-testid="set-tab-tutor"]')
    }
  ]
]

/** 展开侧栏某一层（已经开着就别再点 —— 那一下会把它收起来） */
async function openIfClosed(rowSel, childSel) {
  const child = page.locator(childSel).first()
  if (await child.isVisible().catch(() => false)) return
  await page.locator(rowSel).first().click()
  await child.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
}

const rows = []
for (const [name, want, go] of stops) {
  await onlyThisOne(want)
  /**
   * ★ 重载落在 Today。要量的那条**已经自己出来了**就别再点导航 ——
   *   它那张遮罩会把点击整个吃掉，而报出来的错是「点不到 nav-home」。
   *   （这正是它该做的：遮罩就是要挡住别的操作。）
   */
  if ((await open()) !== want) {
    await go()
    await page.waitForTimeout(1600)
  }
  const id = await open()
  rows.push([name, id ?? '—', want])
  if (shot && id) await page.screenshot({ path: join('shots', `walk-${id}.png`) })
  await closeAll()
}

console.log('')
console.log('按他的状态走一遍（第一层看完 · seen 空 · 库非空）：')
for (const [name, id, want] of rows)
  console.log('  ' + name.padEnd(22, '　') + ' → ' + id + (id === want ? '' : `（该出 ${want}）`))
console.log('')
const got = new Set(rows.map((r) => r[1]).filter((x) => x !== '—'))
/**
 * ★ 这几条**不在这个脚本的量程里**，别读成「没接上」：
 *   · `lookup-save`     要真打开查词卡 → `scripts/shot-guide-dict.mjs` 单独跑
 *   · `practice-settle` 要真答一道题（要假 AI）→ 今天没有 ③ 档用例，债记在 study.test.ts
 *   · `filestudy-modes` 要**真打开一篇文件**才有那两个 Tab（它们在「文件已打开」那一支里）——
 *     这个库里没有文件。它的触发跟着那一块自己的渲染条件走，碰得上就会出。
 *   · `practice-hint-cost` 在题面那一屏上，和 `practice-settle` 同一条路（要假 AI）
 *   · `assist-star`     Windows 根本没有那个控件 —— 在 `NOT_ON_THIS_END` 里，**永远不会出现在这张表上**
 */
const OUT_OF_RANGE = [
  'lookup-save',
  'practice-settle',
  'practice-hint-cost',
  'filestudy-modes',
  'assist-star'
]
const miss = PAGE_GUIDES.map((g) => g.id).filter(
  (id) => !got.has(id) && !OUT_OF_RANGE.includes(id)
)
console.log('这一趟没出现的：' + (miss.length ? miss.join(' · ') : '（无）'))
console.log('★ 不在这个脚本量程里的：' + OUT_OF_RANGE.join(' · ') + '（理由见脚本注释）')
if (warns.length) {
  console.log('')
  console.log('放弃记录（有触发、量不到目标）：')
  for (const w of warns) console.log('  ' + w)
}

await app.close()
