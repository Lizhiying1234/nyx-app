/**
 * 红的时候**把现场留下来** · B-11（主控 2026-09-14：「E-3 的下一步是留证不是修」）
 *
 * ── 为什么要它 ────────────────────────────────────────────────
 *
 * 2026-09-14 一次全量 `verify` 里 `smoke:ui` 跑到「勾一条彻底删除」时**应用没了**，
 * 17 条失败全是同一句 `Target page, context or browser has been closed`
 * （**一条断言失败都没有**），外加 20 条取消；紧接着 `smoke:voice` 的应用**也**死了。
 * 两套单独重跑都满绿。
 *
 * 想往下查，要的东西只有三样：**那一刻的库 · 那一刻的日志 · 应用是怎么退出的**。
 * 而这三样当时**全没了** —— 每一套的 `after()` 里都有一句
 * `rmSync(dataRoot, { recursive: true, force: true })`，**红完照删不误**。
 * 于是「现场」跟着现场一起消失，只剩一句指错方向的错误话。
 *
 * ☞ 所以这一条**不修任何 bug**，它只保证下一次红的时候证据还在。
 *
 * ── 怎么知道这一趟红了 ★★ ────────────────────────────────────
 *
 * `after()` 里问不到 —— 那时候 runner 还没算总账。所以判据挪到
 * `process.on('exit')`：**那时候 `process.exitCode` 已经是最终结论了**。
 * 于是删不删由退出码决定，而 `after()` 只管关应用、不再管删。
 * ★ `exit` 回调里只许同步调用，所以下面全用 `*Sync`。
 *
 * ── 留在哪 ────────────────────────────────────────────────────
 *
 * `out/failed/<套名>-<时间>/`（`out/` 本来就不进 git）。套名从命令行里那个
 * `*.test.ts` 认，时间戳到秒 —— 同一套连红两次不会互相盖掉。
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication } from 'playwright-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 这一趟是哪一套 —— 从命令行里那个 `*.test.ts` 认；认不出就叫 `unknown` */
function suiteName(): string {
  const f = process.argv.find((a) => a.endsWith('.test.ts')) ?? ''
  return f ? basename(f).replace(/\.test\.ts$/, '') : 'unknown'
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const roots: string[] = []
/** 应用的 stdout / stderr —— 库里看不到「进程是怎么死的」，只有这里有 */
const streams = new Map<string, string[]>()
let hooked = false

function install(): void {
  if (hooked) return
  hooked = true
  process.on('exit', (code) => {
    const failed = code !== 0 || (process.exitCode ?? 0) !== 0
    if (!failed) {
      for (const d of roots) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {
          /* 绿的时候清不掉不值得把这一趟弄红 */
        }
      }
      return
    }
    let dir = ''
    try {
      dir = join(ROOT, 'out', 'failed', `${suiteName()}-${stamp()}`)
      mkdirSync(dir, { recursive: true })
      for (const d of roots) {
        /**
         * ★★ `dereference: false`（`cpSync` 的默认，这里**写出来**免得谁顺手改掉）：
         *   `ui-dict.test.ts` 会把**他真实的词典目录** junction 进临时数据根。
         *   跟着链接拷 = 把他那几十本词典整份复制进 `out/failed/` ——
         *   不破坏数据，但会凭空多出几个 G，而且没人看得出那是哪来的。
         *   链接按链接拷，指过去是空的也无所谓：我们要的是库和日志。
         */
        if (existsSync(d)) {
          cpSync(d, join(dir, basename(d)), { recursive: true, dereference: false })
        }
      }
      for (const [label, lines] of streams) {
        writeFileSync(join(dir, `${label}.log`), lines.join(''), 'utf8')
      }
      /** ★ 留一张纸条说清这堆东西是哪来的 —— 三天后看见这个目录的人未必记得 */
      writeFileSync(
        join(dir, 'README.txt'),
        [
          `套名：${suiteName()}`,
          `退出码：${code}`,
          `留于：${new Date().toISOString()}`,
          '',
          '这是一次**失败**的验收留下的现场（B-11）。里面是各端的数据根整份拷贝',
          '（含 data/nyx.db 与 data/logs/nyx.log）以及应用的 stdout / stderr。',
          '绿的那几趟不会留下任何东西 —— 看到这个目录就说明那一趟真的红了。',
          '查完直接删掉整个目录即可，它不进 git。'
        ].join('\n'),
        'utf8'
      )
      process.stderr.write(`\n★ 这一趟红了，现场留在：${dir}\n`)
    } catch (e) {
      process.stderr.write(`\n（留现场失败：${String(e)}；原目录没删，还在 ${roots.join(' · ')}）\n`)
      return
    }
    for (const d of roots) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* 拷出来了就够了 */
      }
    }
  })
}

/**
 * 把一个数据根交给它管：**绿了删掉，红了搬进 `out/failed/`**。
 *
 * 用法：把 `after()` 里那句 `rmSync(dataRoot, …)` 换成 `keepOrClean(dataRoot)`。
 * ★ 仍然要在 `after()` 里**先把应用关掉**再调它 —— 进程还开着的话库是拷不干净的。
 */
export function keepOrClean(dir: string): void {
  if (dir && !roots.includes(dir)) roots.push(dir)
  install()
}

/**
 * 接住应用的 stdout / stderr。**只有这里答得出「它是怎么退出的」** ——
 * 库和 `nyx.log` 都只记到它还活着的那一刻为止。
 */
export function captureApp(app: ElectronApplication, label = 'app'): void {
  install()
  const lines: string[] = []
  streams.set(label, lines)
  try {
    const p = app.process()
    p.stdout?.on('data', (b: Buffer) => lines.push(b.toString()))
    p.stderr?.on('data', (b: Buffer) => lines.push('[stderr] ' + b.toString()))
    p.on('exit', (code, signal) => lines.push(`[exit] code=${code} signal=${signal}\n`))
  } catch {
    /* 拿不到子进程就算了 —— 留证是加分项，不许把验收本身弄红 */
  }
}
