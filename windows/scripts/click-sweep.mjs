/**
 * 可点面真机扫描 · P-4 要的那份证据（2026-09-03）
 *
 * ══ 它回答什么问题 ══════════════════════════════════════════
 *
 * 台账里 P-4 写着：391 个 `onclick` 在**源码层面**都有函数体，没有空实现 ——
 * **但那不等于点了有反应。** 中间还隔着渲染条件、状态竞态、
 * 「函数跑了但屏幕上什么都没变」。这份脚本把验收点挪到那一层：
 * **真启动应用、真点一遍、看屏幕有没有动。**
 *
 * ══ 怎么判「有反应」★★ ═════════════════════════════════════
 *
 * 不查内部状态（那是第②档），只查**他看得见的东西**：
 *   · 屏幕上的 testid 集合变了（出现/消失了什么）
 *   · 正文长度变了（内容换了）
 *   · 地址（当前视图）变了
 *   · 控制台报了错
 * 四样里任何一样动了 = 有反应。**一样都没动 = 记成可疑**，人工复核。
 *
 * ★ 「可疑」不等于「坏了」：切换到当前已选中的 tab、把已经收起的区块再收一次，
 *   本来就该没反应。所以这份脚本的产物是**一张待核清单**，不是判决。
 *
 * ══ 为什么有黑名单 ═════════════════════════════════════════
 *
 * 三类不点：**会弹系统对话框的**（文件选择/另存为 —— 点了就卡住）、
 * **走网络的**（AI/同步/词典扫描 —— 慢且与本次目的无关）、
 * **不可逆的**（出厂重置/清库/彻底删除）。
 * ★ 删除类不点是因为 `smoke:delete` 已经专门验过语义，不是因为危险。
 *
 * 用法：node scripts/click-sweep.mjs [--keep]   （--keep 保留沙盒目录）
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from '../tests/win.ts'

const root = process.cwd()
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-sweep-'))

/** 会弹系统对话框 / 走网络 / 不可逆 —— 一律不点 */
const DENY = [
  // 窗口控制：点了应用就没了
  'win-close', 'win-min', 'win-max',
  // 系统对话框
  'open-data', 'open-logs', 'open-prompts', 'dict-folder', 'pick-file', 'fs-pick-file',
  'exp-backup', 'exp-notes', 'exp-restore', 'backup-now', 'bulk-export',
  'lecture-export', 'proj-export', 'tree-export',
  // 不可逆
  'reset-', 'wipe-', 'danger-zone', 'trash-purge', 'factory',
  // 走网络 / 很慢
  'sync-run', 'sync-test', 'dict-rescan', 'tts-try',
  'run-analyze', 'analyse-one', 'regen', 'fs-analyse', 'fs-send', 'run-assess',
  'start-cold', 'submit-cold', 'ai-submit',
  'audit-run', 'audit-repair', 'self-test',
  // 删除类：smoke:delete 已经专门验过语义
  'tree-delete', 'lecture-delete', 'del-file-', 'del-material-', 'bulk-del', 'drop-',
  'genre-del', 'tutor-del', 'qtype-del', 'del-preset', 'suspect-dismiss'
]
const denied = (id) => DENY.some((d) => id.startsWith(d) || id === d)

/** 一级入口：每个面扫完都回到这里重来，保证可复现 */
const SURFACES = [
  ['首页', 'nav-home'],
  ['攻坚区', 'nav-hard'],
  ['知识点库 · 全部', 'nav-lib-all'],
  ['知识点库 · 上传', 'nav-lib-upload'],
  ['知识点库 · 静默', 'nav-lib-silent'],
  ['文件学习', 'nav-files'],
  ['回收站', 'nav-trash'],
  ['设置', 'nav-settings']
]

const seeded = spawnSync(
  join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [join(root, 'out', 'main', 'seed-demo.js')],
  { cwd: root, env: { ...process.env, NYX_DATA_ROOT: dataRoot }, encoding: 'utf8' }
)
if (seeded.status !== 0) throw new Error(`灌数据失败：${seeded.stderr ?? ''}`)

const app = await electron.launch({
  args: ['.'], cwd: root, env: { ...process.env, NYX_DATA_ROOT: dataRoot }
})
/**
 * ★ 拿主窗走 `tests/win.ts` 那一份判据（B-9，2026-09-14）——
 *   以前这里是 `app.firstWindow()`，它认的是「谁先开」，跟「谁是主窗」无关；
 *   悬浮球开着的库上它拿到的是那颗 46px 的球（I-157 / I-179）。
 */
const page = await mainWindow(app)
page.setDefaultTimeout(6000)
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`${e.name}: ${e.message}`))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1500)

/** 屏幕现在长什么样 —— 只取他看得见的四样 */
const snap = () => page.evaluate(() => ({
  ids: [...document.querySelectorAll('[data-testid]')]
    .filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => e.getAttribute('data-testid')).sort().join('|'),
  len: (document.body.innerText || '').length,
  // ★ 补一条：输入框的值。少了它，「35 → 40」会被当成没反应（首页 qty-± 就是这么被误判的）
  vals: [...document.querySelectorAll('input,select,textarea')].map((e) => e.value).join('|'),
  title: document.querySelector('h1,h2,.hero')?.textContent?.trim() ?? ''
}))

const results = []
for (const [name, entry] of SURFACES) {
  await page.click(`[data-testid="${entry}"]`).catch(() => {})
  await page.waitForTimeout(500)

  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid]')]
      .filter((e) => {
        const r = e.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return false
        const t = e.tagName
        return t === 'BUTTON' || t === 'A' || e.getAttribute('role') === 'button' ||
               typeof e.onclick === 'function' || e.classList.contains('li') || e.classList.contains('mi')
      })
      .map((e) => e.getAttribute('data-testid'))
  )
  const todo = [...new Set(ids)].filter((id) => id && !denied(id) && !id.startsWith('nav-'))

  for (const id of todo) {
    const before = await snap()
    const errsBefore = consoleErrors.length
    const el = page.locator(`[data-testid="${id}"]`).first()
    if (!(await el.count()) || !(await el.isVisible().catch(() => false))) continue
    try {
      await el.click({ timeout: 2500 })
    } catch {
      results.push({ surface: name, id, verdict: '点不动', note: '元素在但点击超时' })
      continue
    }
    await page.waitForTimeout(280)
    const after = await snap()
    const newErrs = consoleErrors.slice(errsBefore)
    const changed = before.ids !== after.ids || before.len !== after.len ||
      before.title !== after.title || before.vals !== after.vals
    results.push({
      surface: name, id,
      verdict: newErrs.length ? '报错' : changed ? '有反应' : '★ 没反应',
      note: newErrs.join(' / ')
    })
    // 回到本面重来，保证下一个点击的起点是确定的
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(80)
    await page.click(`[data-testid="${entry}"]`).catch(() => {})
    await page.waitForTimeout(280)
  }
}

await app.close()

const by = (v) => results.filter((r) => r.verdict === v)
const lines = []
lines.push(`# 可点面真机扫描 · ${new Date().toISOString().slice(0, 10)}`)
lines.push('')
lines.push(`共点了 **${results.length}** 个（八个一级入口下当时可见的、不在黑名单里的）`)
lines.push(`- 有反应：${by('有反应').length}`)
lines.push(`- ★ 没反应：${by('★ 没反应').length}`)
lines.push(`- 报错：${by('报错').length}`)
lines.push(`- 点不动：${by('点不动').length}`)
lines.push('')
for (const v of ['报错', '点不动', '★ 没反应']) {
  const rows = by(v)
  if (!rows.length) continue
  lines.push(`## ${v}（${rows.length}）`)
  lines.push('')
  lines.push('| 在哪 | testid | 备注 |')
  lines.push('|---|---|---|')
  for (const r of rows) lines.push(`| ${r.surface} | \`${r.id}\` | ${r.note || ''} |`)
  lines.push('')
}
const out = join(root, 'click-sweep-report.md')
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(lines.slice(0, 8).join('\n'))
console.log(`\n报告：${out}`)

if (!process.argv.includes('--keep')) rmSync(dataRoot, { recursive: true, force: true })
