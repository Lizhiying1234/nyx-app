import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * check:ipc-guard 自己的验收 · H-4c
 *
 * ── 为什么这一套非写不可 ──────────────────────────────────
 *
 * 一道从来不红的闸，和没有闸，对使用者是同一回事 ——
 * 而且更糟：它会让人以为这件事已经有人管了。
 * `check:sql` 当初就为此专门配了一条「尺子自己要准」的用例（9.2）。
 *
 * 所以这里**每一条都是负向对照**：先把源码改坏，跑闸门，断言它红；
 * 再改回来，断言它绿。不接受「跑通了扫描器」这种测法 ——
 * 那只证明脚本能执行，证明不了它在看什么。
 *
 * 做法：把整个仓库需要的几个文件拷进临时目录会很重，所以改的是
 * **真源码文件本身**，用 try/finally 保证无论断言成不成功都原样写回去。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'check-ipc-guard.mjs')
/** 换行写成常量 —— 工具链上反复丢转义层（和 index.ts 里那条 NL 同一个理由） */
const NL = String.fromCharCode(10)

/** 跑一次闸门，返回它的退出码和输出 */
function runGate(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/**
 * 把一段字面量变成对行尾不敏感的正则。
 *
 * 这个仓库里的行尾是**混着的**，而且**会变**：git 的 autocrlf、`.gitattributes`、
 * 编辑器，各自都可能把某个文件从 LF 翻成 CRLF。所以这里**不写死哪个文件是哪种行尾** ——
 * 上一版注释点名说「Trash.svelte 是 LF」，后来它变成了 CRLF，
 * 而第 ③ 条恰好是唯一没走这个助手的裸字符串替换，于是那条闸静静地失效了一整轮。
 * 表现是「改动没生效」，看着像用例写错了 —— 其实是行尾。
 *
 * ★ 规矩：**这个文件里凡是带换行的查找串，一律过 `rx()`。**
 *   ②④ 找的是 `<script lang="ts">`（不含换行），天然免疫。
 */
const rx = (lit: string): RegExp =>
  new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n'))

/** 临时改一份源码，跑完必定原样写回 —— 不管断言成不成功 */
function withEdited(file: string, edit: (src: string) => string, fn: (r: ReturnType<typeof runGate>) => void): void {
  const p = join(ROOT, file)
  const backup = join(mkdtempSync(join(tmpdir(), 'nyx-gate-')), 'backup')
  copyFileSync(p, backup)
  try {
    const src = readFileSync(p, 'utf8')
    const next = edit(src)
    assert.notEqual(next, src, `改动没生效 —— 这条用例什么都没验到（${file}）`)
    writeFileSync(p, next, 'utf8')
    fn(runGate())
  } finally {
    copyFileSync(backup, p)
    rmSync(dirname(backup), { recursive: true, force: true })
  }
}

/** 这套用例会临时改动的那几份 —— 开跑前先记指纹，跑完逐一比对 */
const TOUCHED = [
  'src/renderer/src/Home.svelte',
  'src/renderer/src/Trash.svelte',
  'src/renderer/src/App.svelte',
  'scripts/ipc-guard-allow.json'
]
const BASELINE = new Map(
  TOUCHED.map((f) => [f, createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex')])
)

describe('★★ check:ipc-guard · 这道闸到底在看什么', () => {
  it('① 现状：通过，欠账已清零，每一处都有归属', () => {
    const r = runGate()
    assert.equal(r.code, 0, `现状就该是绿的：\n${r.out}`)
    const m = /需要交代的调用 (\d+) 处 · 永久豁免 (\d+) · 欠账 (\d+)/.exec(r.out)
    assert.ok(m, `输出里读不到统计：\n${r.out}`)
    const [, total, allow, debt] = m.map(Number) as unknown as number[]
    assert.equal(
      allow! + debt!,
      total!,
      '每一处都必须有归属：要么永久豁免、要么记在欠账里，不许有第三种'
    )
    /**
     * ★ H-4b 之后欠账必须是 0。
     * 这一条同时是**棘轮的棘齿**：将来谁想拿 debt 当垃圾桶用，这里就红。
     */
    assert.equal(debt, 0, `★ 欠账不是 0（${debt} 条）—— H-4b 之后不许再往 debt 里塞东西`)
    /**
     * ★★ 2026-09-13 · 上限从 15 抬到 27，**一次抬了 12 条**，所以要在这儿交代清楚。
     *
     *   这一批长出了两种以前没有的东西，它们天生带一批「静默是对的」调用：
     *     · **置顶浮窗 Overlay** —— 它的
     *       `on*` 是**订阅登记**（底下就是 `ipcRenderer.on`，同步返回退订闭包），
     *       根本没有会失败的那一步；`overlay.close` 是单向 `send`，没有回答可等。
     *     · **一堆纯界面偏好**（文件学习字号 · 配色 · Glance 模式）——
     *       写不进去的后果是「下次回到默认」，那是他随手再点一下就能修的状态，
     *       为它弹窗是软件在替自己的内务表功。
     *
     *   ★ 每一条都写满了五个字段（写不出理由的那几条，闸门当场顶回来过）。
     *   ★ 这个数字**不是许可证**：它还是棘轮。下一个人再抬之前，
     *     先问一句「这 27 条里有没有已经能删的」—— 一次抬 12 条这种事不该有第二回。
     *
     * ══ 2026-09-14 · 27 → 29，抬了 2 条（新增 5 · 原有富余 3）═════════
     *
     * 先照上面那句话做了：闸门自己报 stale = 0，
     * 也就是那 27 条里**没有一条是早该删而没删的**。
     *
     * 这一批长出两个新的、漂在桌面上的东西（使用者 2026-09-14 晚点名要的）：
     *   · **桌面悬浮球** —— `bubble.onState`（订阅登记）· `bubble.toggle`（单向 send）
     *     · `bubble.moveBy` / `bubble.rest`（拖拽）
     *   · **查词卡可拖** —— `overlay.moveBy`
     *   拖拽那几条天生就该静默：一次拖动几十上百个事件，
     *   而「卡没跟着手走」是全软件反馈最直接的一个动作，屏上再说一句是噪音。
     *
     * ★ 找到过一条能删的候选，**否掉了**，写在这里免得下一个人再想一遍：
     *   `bubble.rest`（拖完存位置）可以取消 —— 让主进程在 `moveBy` 里防抖自己存。
     *   但那只是把**同一份静默**挪到主进程里，并没有让软件诚实一点；
     *   而这道闸看的是「失败了该不该告诉他」，不是「IPC 通道几条」。
     *   为了把数字压回 28 去改它，就是在凑这个数字、不是在做它要管的那件事。
     *
     * ══ 同一天晚些时候 · 29 → 30，又一条（说清楚）════════════
     *
     * 使用者把 Point 整个重定了（第三批）：不再是一颗快捷键，而是
     * 「开着就能用鼠标拖选原本选不中的字」。于是多了一扇窗口：
     * 选区高亮层（`Marker.svelte`）—— 它在别的程序上面漂着，只画几块色，
     * 只订阅一条频道 `marker.onRects`，从不往回说话。
     *
     * ★ 这一条和 Overlay 那几条 `on*` 是**同一类**：订阅登记，
     *   底下就是 `ipcRenderer.on`，同步返回一个退订闭包 —— 压根没有会失败的那一步。
     * ★ 同样先问了「有没有能删的」：这一轮倒是真删了路 —— Point 的快捷键、
     *   `main/point.ts`、`resources/glance/point.ps1` 全撤了；只是那条路上本来
     *   就没有裸的 `window.nyx` 调用（全在主进程），所以白名单上没有对应的减项。
     *
     * ══ 2026-09-15 · 30 → 32，两条，首次引导那一批（SC-25 / D-483）══════
     *
     * ★★ **先认一件事**：这两条**条目**当时都按五个字段写清楚了，
     *   但**这段注释和上界没跟着改** —— 于是 `main` 上 `npm run gate` 一直红在这一句，
     *   而红的原因不是「有人偷偷加了白名单」，是**加的人只做了一半**。那个人是我。
     *   ☞ 这道闸的规矩本来就是两步：进白名单 **＋** 在这儿逐条说得出为什么。
     *     只做前一步，闸报出来的那句话（「涨了就要逐条重新交代」）说的正是这件事。
     *
     * 两条是同一类：**写一个只影响这台设备、而且失败没有后果的偏好**。
     *
     *   · `App.svelte:ui.set`（清 `onboarding.doneAt`）—— 他点「再看一次新手引导」时
     *     先把记号清掉。**清不掉也不影响这一次**：引导是本地那一行 `onboarding = true`
     *     打开的，屏上照常出现；而他看完点「开始使用」时本来就会把记号写回去。
     *     两条路收敛到同一个状态，所以这一下失败等于什么都没发生 —— 为一个
     *     没有后果的中间步骤弹一句失败，只会让他以为刚点的功能坏了。
     *
     *   · `App.svelte:ui.set#2`（写 `onboarding.doneAt` 时间戳）—— 看完 / 跳过之后记一笔。
     *     失败的症状是**下次启动又出现一次引导**，那本身就是最清楚的提示；
     *     再多一句「没能记住你看过引导」反而更难懂。而且他这一刻正要开始用软件
     *     （刚点完「开始使用」），在那一秒打断他，代价比那个偏好本身大。
     *
     * ★ 照例先问「有没有能删的」：**没有**。这两条各自对应一个真实的交互
     *   （再看一次 · 记住看过），删掉任何一条都是删功能，不是把静默挪个地方。
     *   **不为压数字改别的**（同上面那条否掉的先例）。
     * ══ 同一天 · 32 → 33，第三条（D-485 那一批合回来之后）════════════
     *
     * 上一段末尾预告过的那一条到了：
     *
     *   · `Onboarding.svelte:params.list`（读「练成所需连正确」那个数）—— 引导第五步
     *     要说「连着答对几次就练成了」，而那个次数他能在设置里改（D-485 · E-1-e）。
     *     读不到就退回出厂值，引导照常打开、五步照常走完；失败影响的只是
     *     **一句话里的一个数**，不写库、不改任何状态。这是他第一次打开软件的第一屏，
     *     在那儿弹一条他完全看不懂的「读参数失败」，比那个数偶尔不准糟得多。
     *
     * ★★ **这一条为什么是单独一笔（记下来，因为它会再发生）**：
     *   上界那一笔（30 → 32）和 D-485 那一批是**两条分别基于 main 的线**，
     *   各自自洽 —— 可它们合回来的顺序让 `main` 停在了中间态：
     *   白名单已经 33，而上界还是 32，于是 `gate` 当场红。
     *   ☞ **白名单条数是个「跨分支的全局数」**：两条线各加各的、各自都对，
     *     合起来就超。凡是这种数，**上界那一笔必须排在最后**，或者合完立刻补一笔。
     */
    assert.ok(allow! <= 33, `★ 白名单涨到了 ${allow} 条 —— 它应该极少，涨了就要逐条重新交代`)
  })

  it('★★ ② 故意新增一处裸 window.nyx 调用 → 必须红', () => {
    withEdited(
      'src/renderer/src/Home.svelte',
      (s) =>
        s.replace(
          '<script lang="ts">',
          '<script lang="ts">\n  async function __gateProbe(): Promise<void> {\n    await window.nyx.data.tree()\n  }\n  void __gateProbe'
        ),
      (r) => {
        assert.equal(r.code, 1, `新增一处裸调用，闸门却是绿的：\n${r.out}`)
        assert.ok(r.out.includes('data.tree'), `没点名是哪一处：\n${r.out}`)
      }
    )
  })

  it('★★ ③ 故意拆掉一处已有的 try → 必须红', () => {
    /**
     * Trash.svelte 的 load() 是标准写法：try { await window.nyx… } catch { view = error }
     *
     * ★ 必须走 `rx()`。这里原来是**字面量**（里面带一个换行）—— 而同一个文件在不同
     *   机器上行尾不一样：`core.autocrlf` 一开，checkout 出来就是 CRLF，
     *   `git worktree add` 建出来的那份正是这样。字面量匹配不上 → 替换等于没做 →
     *   **这条用例什么都没验到**，而报出来的是「改动没生效」，看着像用例写错了。
     *   文件头 `rx()` 那段注释说的就是这件事：⑤ 已经在用它，③ 漏了。
     */
    withEdited(
      'src/renderer/src/Trash.svelte',
      // ★ 过 rx()（见上）。替换用回调，把匹配到的那个换行**原样带回去** ——
      //   写死换行会把 CRLF 文件里那一行变成 LF：跑完虽然会还原，
      //   但那等于在验收过程中悄悄改了行尾，不是干净的做法。
      (s) => s.replace(rx('    try {\n'), (m) => m.replace('try {', 'if (true) {')),
      (r) => {
        assert.equal(r.code, 1, `try 被拆掉了，闸门却是绿的：\n${r.out}`)
      }
    )
  })

  it('★★ ④ 故意加一处只有空 .catch 的调用 → 必须红（静默吞掉和裸调用一样糟）', () => {
    /**
     * 注意不能拿「已经在 try 里的调用」去加空 catch —— 那样 try 仍然接得住，
     * 闸门放行是**对的**。要验的是「唯一的处理就是一个空 catch」这种写法。
     */
    withEdited(
      'src/renderer/src/Home.svelte',
      (s) =>
        s.replace(
          '<script lang="ts">',
          '<script lang="ts">\n  async function __gateSilent(): Promise<void> {\n    await window.nyx.data.tree().catch(() => {})\n  }\n  void __gateSilent'
        ),
      (r) => {
        assert.equal(r.code, 1, `空 catch 没被抓出来：\n${r.out}`)
        assert.ok(r.out.includes('静默吞掉'), `没说清是哪一类问题：\n${r.out}`)
      }
    )
  })

  it('★★ ⑤ 把 act() 里的 try 拆掉 → 它带的那 5 处必须一起红（guard 认结构不认名字）', () => {
    withEdited(
      'src/renderer/src/App.svelte',
      (s) =>
        s.replace(
          /**
           * 把 `await fn()` **挪到 try 外面**，而不是把 try 删掉 ——
           * 删 try 会留下悬空的 catch，闸门会因为**解析失败**而红，
           * 那证明不了「guard 认结构」这件事（第一版就是这样假红的）。
           * 挪出去之后语法仍然合法，只是 `act` 不再满足「在 try 里调形参」。
           */
          rx(`    try {${NL}      await fn()`),
          `    await fn()${NL}    try {`
        ),
      (r) => {
        assert.equal(r.code, 1, `guard 里的 try 没了，闸门却是绿的 —— 说明它只认名字：\n${r.out}`)
        for (const call of ['data.setPinned', 'data.setSilent', 'data.markUnread', 'data.forkLecture', 'data.move']) {
          assert.ok(r.out.includes(call), `${call} 没被抓出来：\n${r.out}`)
        }
      }
    )
  })

  it('★★ ⑥ 白名单少写一个字段 → 必须红（写不出理由的就不是白名单）', () => {
    withEdited(
      'scripts/ipc-guard-allow.json',
      (s) => {
        const j = JSON.parse(s) as { allow: Record<string, Record<string, string>> }
        j.allow['src/renderer/src/App.svelte:win.close']!['为什么允许静默'] = '   '
        return JSON.stringify(j, null, 2)
      },
      (r) => {
        assert.equal(r.code, 1, `白名单留空了，闸门却是绿的：\n${r.out}`)
        assert.ok(r.out.includes('为什么允许静默'), `没说清缺的是哪个字段：\n${r.out}`)
      }
    )
  })

  it('★★ ⑦ 删掉一条白名单（那处调用就没归属了）→ 必须红', () => {
    /**
     * H-4b 之前这一条验的是「从欠账里删一条」。欠账清零之后，
     * 同一个性质的判据落在白名单上：**名单里少一条，就有一处调用没人交代**。
     * 守的仍然是那把棘轮 —— 名单和代码必须对得上，少一边都不行。
     */
    withEdited(
      'scripts/ipc-guard-allow.json',
      (s) => {
        const j = JSON.parse(s) as { allow: Record<string, unknown> }
        delete j.allow['src/renderer/src/App.svelte:win.close']
        return JSON.stringify(j, null, 2)
      },
      (r) => {
        assert.equal(r.code, 1, `白名单少了一条，闸门却是绿的：\n${r.out}`)
        assert.ok(r.out.includes('win.close'), `没点名：\n${r.out}`)
      }
    )
  })

  it('⑧ 同一条同时写进 allow 和 debt → 必须红（它到底合不合法？）', () => {
    withEdited(
      'scripts/ipc-guard-allow.json',
      (s) => {
        const j = JSON.parse(s) as { allow: Record<string, unknown>; debt: Record<string, string> }
        j.debt['src/renderer/src/App.svelte:win.close'] = '故意制造的矛盾'
        return JSON.stringify(j, null, 2)
      },
      (r) => {
        assert.equal(r.code, 1, `一条同时是合法的又是欠着的，闸门却放过去了：\n${r.out}`)
      }
    )
  })

  it('⑨ 已有的正确写法不许误报：act 包装 · try/catch · {#await}{:catch} · 非空 .catch', () => {
    const r = runGate()
    // 这几处都是现成的正确写法，一处都不该出现在输出里
    for (const call of [
      'data.setPinned', // App.svelte，act() 包着
      'data.tree', // App.svelte，loadTree 的 try/catch
      'app.buildInfo', // App.svelte，{#await}{:catch}
      'study.analysisCounts' // AnalyzePanel，有 .catch —— 但它是空的，只该出现在欠账里
    ]) {
      const inFindings = new RegExp(`:\\d+\\s+${call.replace('.', '\\.')}`).test(r.out)
      assert.equal(inFindings, false, `${call} 被误报了：\n${r.out}`)
    }
    assert.ok(r.out.includes('✔ 通过'), r.out)
  })

  it('⑩ 白名单和欠账里不许有已经不存在的条目（改完要记得删）', () => {
    const r = runGate()
    assert.ok(
      !r.out.includes('已经不对应任何调用'),
      `名单里有过期条目：\n${r.out}`
    )
  })

  it('⑪ 跑完之后，被改过的那几个文件必须和开跑前逐字节一致', () => {
    /**
     * 前面每条用例都在改真文件，`finally` 里写回去 —— 这一条守的是「真的写回去了」。
     *
     * 判据是**和这一套用例开跑前比**，不是和 git HEAD 比：
     * 工作区本来就可能有没提交的改动（H-4b 自己就是这么跑的），
     * 拿 HEAD 当基准会红在一件与这套用例无关的事情上 —— 那是假红。
     */
    for (const [f, before] of BASELINE) {
      assert.equal(
        createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex'),
        before,
        `★ ${f} 跑完没还原`
      )
    }
  })
})
