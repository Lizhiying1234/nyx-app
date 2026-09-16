import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'

/**
 * 打包产物的验收 · D-223 / D-224 / D-233
 *
 * **为什么单独验打包后的 exe**：CLAUDE.md 点名的四条「一旦违反就出事」里，
 * 有一条只在**打包之后**才可能坏 ——
 *
 *   D-223「`prompts/` 必须排除在 asar 归档之外」。
 *   开发时提示词一定是从文件读的，怎么跑都对；一旦被塞进 asar，
 *   使用者**打不开也改不了**，D-213（提示词是文件不是代码）当场失效，
 *   而且软件本身照常运行 —— 没有任何报错，**只有使用者会发现**。
 *
 * 所以这一套跑的是 `release/win-unpacked/Nyx.exe` 本身，不是源码。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exe = join(root, 'release', 'win-unpacked', 'Nyx.exe')
/**
 * ★ I-106 之后**使用者改的那份在 `data/prompts/`**，
 * 根目录那份 `prompts/` 只是出厂种子（首次启动时拷过去）。
 * 这条测试原来盯着根目录那份 —— 改它当然不会生效，
 * 因为软件读的根本不是它。测试过时了，不是软件坏了。
 */
const shippedPrompts = join(root, 'release', 'win-unpacked', 'prompts')
const promptsDir = join(root, 'release', 'win-unpacked', 'data', 'prompts')
const dataDir = join(root, 'release', 'win-unpacked', 'data')

let app: ElectronApplication
let page: Page

const MARK = '<!-- 打包验收留下的记号，跑完会撤掉 -->'

/** 反斜杠一律绕开写（D-460） */
const NL = String.fromCharCode(10)

/**
 * ★ I-128 · 先问一句「是不是已经有一个 Nyx 开着」
 *
 * **判据：操作系统里有没有名叫 `Nyx.exe` 的进程。**
 *
 * 为什么这条判据够 ——
 * · 单实例锁（`src/main/index.ts`，D-218）只在**没有 `NYX_DATA_ROOT`** 时才请求；
 *   它锁的是 Electron 默认的 userData 目录，而本仓**没有任何 `app.setPath('userData')`**。
 *   于是这台机器上每一个不带 `NYX_DATA_ROOT` 起来的 `Nyx.exe` 都在抢同一把锁 ——
 *   包括使用者装在 `D:\Nyx` 的那份。抢输的一方 `app.exit(0)`，
 *   playwright 的 ws 一连上就断（1006），这一套四条会一起被取消。
 *
 * 为什么这条判据也不多 ——
 * · 其余 19 套 smoke 起的是 `electron.exe`，而且**都带 `NYX_DATA_ROOT`**，
 *   压根不请求这把锁。把 `electron.exe` 也数进来，会在别的 smoke 正跑时误报。
 *
 * ★ 它够不着的一处（**已知，没修**）：`npm run dev` 起的开发实例也是 `electron.exe`
 *   且不带 `NYX_DATA_ROOT` —— 它**确实**占着锁，但这里数不出来。那一种落到下面
 *   `launch` 的 catch 里：至少能读到「起不来 + 两个可能的原因 + 原始错误」，
 *   不再是光秃秃一串 playwright 日志。
 */
function runningNyx(): string[] {
  try {
    // 直接起 tasklist，不过 shell —— Git Bash 会把 `/NH` 当成路径改写掉
    const out = execFileSync('tasklist', ['/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return out
      .split(NL)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith('"nyx.exe"'))
      .map((line) => line.split('","')[1] ?? '?')
  } catch {
    // 问不出来就别挡路：让它照常往下跑，坏了还是原来那个样子
    return []
  }
}

describe('打包产物 · D-223 / D-224', () => {
  const busy = runningNyx()

  if (busy.length > 0) {
    /**
     * ★ 只登记这一条，别的一条都不建。
     *
     * I-128 抱怨的不是「失败」，是**失败得说不出原因**：四条全被取消（`cancelled 4`），
     * 错误里只有一串 playwright 的启动日志，跟「Nyx 开着」看不出任何关系。
     * 把前置写成一条**会红的用例**，输出就变成 `fail 1` + 一句人话；
     * 而且不注册 `before` / `after`，就不会去动那个正开着的实例的 `data/`。
     */
    it('★ 前提没成立 · 先把 Nyx 关掉再跑 smoke:packaged', () => {
      assert.fail(
        '先把 Nyx 关掉再跑 smoke:packaged。' +
          NL +
          // ★ 报进程数不报「几个 Nyx」：Electron 一个应用本来就是好几个同名进程
          `（检测到 Nyx 正开着：Nyx.exe 有 ${busy.length} 个进程，PID ${busy.join(' · ')}；` +
          'Electron 一个应用本来就是主进程 + GPU + 渲染进程好几个。）' +
          NL +
          '这一套要起打包后的 Nyx.exe，而单实例锁（D-218）会让它撞上已开的实例后直接退出 ——' +
          NL +
          '不关掉的话，四条用例只会一起被取消，错误里看不出跟这件事有关。'
      )
    })
    return
  }

  before(async () => {
    assert.ok(existsSync(exe), `还没打包。先跑 npm run package，再跑这一套。${NL}找不到：${exe}`)

    try {
      app = await electron.launch({ executablePath: exe, args: [] })
      page = await mainWindow(app)
    } catch (err) {
      /**
       * ★ I-128 · 上面那条进程判据够不着的情况落到这里：
       * `npm run dev` 占着锁，或者刚好在这几毫秒里有人把 Nyx 打开了。
       * **不硬说是哪一种** —— 把当场重查的结果、两个可能、原始错误一起摆出来。
       */
      const now = runningNyx()
      throw new Error(
        '打包后的 Nyx 起不来。' +
          NL +
          (now.length > 0
            ? `刚重查了一次：Nyx 正开着（Nyx.exe 有 ${now.length} 个进程，PID ${now.join(' · ')}）—— 先把 Nyx 关掉再跑。`
            : '两个常见原因：① 已经有一个实例占着单实例锁（含 npm run dev 起的那个，它是 electron.exe，进程名查不出来）；② 打包产物本身起不来。') +
          NL +
          `原始错误：${err instanceof Error ? err.message : String(err)}`
      )
    }
    page.setDefaultTimeout(8000)
    await page.waitForLoadState('domcontentloaded')
  })

  after(async () => {
    await app?.close()
    // 验收产生的数据目录不留在打包产物里
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('双击就能开 —— 窗口起得来，数据库是活的', async () => {
    const t = (await page.evaluate(() => window.nyx.app.selfTest())) as {
      ok: boolean
      schemaVersion: number
      targetVersion: number
      counts: Record<string, number>
    }
    assert.equal(t.ok, true, '写进去再读回来对不上 —— better-sqlite3 在打包后的运行时里没活')
    assert.equal(t.schemaVersion, t.targetVersion, '数据库结构没升到最新')
  })

  it('D-263 · 数据就在软件文件夹里（整个文件夹拷走就是完整迁移）', async () => {
    const t = (await page.evaluate(() => window.nyx.app.selfTest())) as {
      paths: { root: string; data: string; db: string }
    }
    assert.equal(
      t.paths.root,
      dirname(exe),
      `数据跑到别处去了：${t.paths.root}\n—— D-224 明确不做安装程序，数据必须跟软件在一起`
    )
    assert.ok(existsSync(t.paths.db), `数据库文件没建出来：${t.paths.db}`)
  })

  it('★ D-223 · prompts 在 asar 外面，记事本改完立刻生效', async () => {
    // 1. 两份都得在 asar 外面：种子那份要能拷，他改的那份要能点开
    assert.ok(existsSync(shippedPrompts), `出厂 prompts 被塞进 asar 了 —— 连种子都拷不出来`)
    assert.ok(existsSync(promptsDir), `data/prompts 没有生成 —— 使用者没有可改的那一份`)
    const file = join(promptsDir, 'analyze-material.md')
    assert.ok(existsSync(file), `找不到 ${file}`)

    // 2. 软件读的是**这个文件**，不是内置兜底
    const before = (await page.evaluate(() =>
      window.nyx.prompts.assembled('analyze-material')
    )) as { source: string; path: string }
    assert.equal(
      before.source,
      'file',
      `读的是内置兜底而不是文件（${before.path}）—— 改了也不会生效，D-213 当场失效`
    )

    // 3. 真去改一下，看软件下一次读到的是不是改过的
    const original = readFileSync(file, 'utf8')
    try {
      writeFileSync(file, `${original}\n${MARK}\n`, 'utf8')
      const after2 = (await page.evaluate(() =>
        window.nyx.prompts.assembled('analyze-material')
      )) as { system: string; userTemplate: string }
      assert.ok(
        `${after2.system}${after2.userTemplate}`.includes(MARK),
        '改了文件但软件还在用旧的 —— 提示词被缓存住了，使用者改不动'
      )
    } finally {
      writeFileSync(file, original, 'utf8')
    }
  })

  it('使用说明就在文件夹里 —— 零编程经验的人要能自己看明白', () => {
    const readme = join(root, 'release', 'win-unpacked', '使用说明.md')
    assert.ok(existsSync(readme), '打包产物里没有使用说明')
    const text = readFileSync(readme, 'utf8')
    assert.match(text, /Program Files/, '没写「别放 Program Files」—— 放进去会打不开')
    assert.match(text, /nyx\.log/, '没写崩了怎么办')
  })
})
