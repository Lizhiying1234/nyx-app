import type { Database } from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_BLOCKED,
  isCleared,
  judge,
  parseHit,
  type GlanceMode,
  type GlanceRules
} from '../core/glance.ts'
import { toDipRect } from './dpi.ts'

/**
 * Glance · 主进程这一半（使用者 2026-09-13）
 *
 * 他要的是「**正常选中文字后直接自动查词**，不需要任何按键」。
 *
 * ══ 为什么是一个 PowerShell 助手进程，不是原生模块 ═══════════
 * 零按键要拿到「别的程序里当前选中的那段文字」，Windows 上只有 UI Automation
 * 这一条路，而 Electron / Node 没有它的绑定。两个选择：
 *   ① 写一个原生模块（C++/N-API）—— 这个仓刚为 `bindings` + asar 赔过一次装机事故
 *   ② 一个**小助手进程**：Windows 自带 UIAutomationClient，什么都不用装、
 *      不用 electron-rebuild、不进 asar（脚本按 `extraResources` 发，同 `prompts/`，D-223）
 * 选 ②。**它只在 Glance 开着的时候活着**，关掉就杀。
 *
 * ══ 验过的事实（2026-09-13，他机器上真跑的）═══════════════════
 *   `HIT | proc=msedge | via=ancestor depth=0 | type=Document | sel=[House Minority]`
 * —— 他在 Edge 里选中一段，**没按任何键**就读到了。这是这条路的地基。
 * 同一次量到：ONLYOFFICE 那类自绘界面**一个文本接口都没有** ——
 * ★ 2026-09-14 晚：那时候补覆盖面的办法是 Frame（框选 + OCR），
 *   而他试过之后把它取消了，换成 Point（指到就查，问 UIA 要真文字）。
 *   代价他听过并确认过：自绘界面 / 图里的字 / 视频字幕从此查不了。
 *
 * ══ 这个文件不做判断 ════════════════════════════════════════
 * 抓不抓由 `core/glance.ts::judge` 定（有 15 条用例）。
 * 理由：零按键意味着**他在任何地方选中的任何东西都会经过那个判断**，
 * 判错一次的后果不是「查词没出来」，是一段他没打算给 Nyx 的文字被读走了。
 * 那种判断必须钉得住，不能埋在进程管理的代码里。
 */

const KEY_MODE = 'glance.mode'
/**
 * ══ 「选的是哪一种」·（2026-09-14 晚**复活**）★★ ═══════════════════
 *
 * 这个键下午刚退役过 —— 那时 Frame 删了、方式只剩一种，它没有意义。
 * 晚上他又说：「**Point 和 Glance 是两种独立的功能，不能同时混在一起**……
 * 设置中选择 Point 或 Glance → 桌面图标负责开启 / 关闭当前模式。」
 * 于是「哪一种」这个维度回来了，而 `mode === 'off'` 照样把它擦掉，
 * 所以仍然要单独记一笔。★ 退役了半天又活过来，写在这儿免得下一轮再删一次。
 *
 * ★ 老值 `'frame'` 一律当 `'glance'`（那一档没了，而它俩里划词更接近）。
 */
const KEY_LAST = 'glance.lastMode'
const KEY_BLOCKED = 'glance.blocked'
/**
 * ══ 收下的东西默认进哪一讲（使用者 2026-09-13 选的「甲」）══════
 * `ASSIST_CONTRACT` §五 第一条：「**零配置**：不问保存到哪，默认目标由 Settings 定」。
 * ★ 这一条不能每次问 —— 划词 / 指词 是在**别的程序里**触发的，
 *   那时候弹一个三级路径选择器，等于把「两次点击」变成「五次点击 + 一次思考」。
 * ★ 存 `settings`（不进 `SYNC_TABLES`）：讲次 id 是**本机库里的行号**，
 *   同步到另一端会指到一个完全不相干的讲次上 —— 那比不同步糟得多。
 */
const KEY_LECTURE = 'glance.lecture'

function read(db: Database | null, key: string): string {
  if (!db) return ''
  try {
    const r = db.prepare(`select value from settings where key = ?`).get(key) as
      | { value: string }
      | undefined
    return r?.value ?? ''
  } catch {
    return ''
  }
}

/**
 * 现在是哪个模式。**读不出来一律当关着** ——
 * 这是唯一安全的默认：一个「读不出设置就开始监听」的功能不该存在。
 */
export function mode(db: Database | null): GlanceMode {
  const v = read(db, KEY_MODE)
  /**
   * ★★ 老值 `'frame'` **一律当关着**（使用者 2026-09-14：Frame 取消）。
   *
   * 他机器上存的正是 `'frame'`（2026-09-14 读过他的库）。Frame 没了之后
   * 这个值没有归宿，两种映射都得想清楚：
   *   → `'glance'`：Assist 继续开着，但**它会开始盯他选中了什么**，
   *      而 Frame 从来不盯任何东西。等于替他把监听打开了 —— 不行。
   *   → `'off'`：Assist 变成关着，他去设置里自己开一次。
   * 这个文件头上那条写着「读不出来一律当关着 —— 一个『读不出设置就开始监听』
   * 的功能不该存在」。一个**已退役**的值和读不出来是同一回事，所以走后者。
   * ★ 这件事当面跟他说过了，不是悄悄关掉。
   */
  return v === 'glance' || v === 'point' ? v : 'off'
}

/**
 * 关着的时候「关的是哪一种」——**桌面那枚悬浮图标靠它决定点一下开哪个**。
 * 没开过就当 `glance`（划词是零按键的那一种，第一次用更好上手）。
 * ★ 老值 `'frame'` 当 `'glance'`。
 */
export function lastMode(db: Database | null): 'glance' | 'point' {
  const m = mode(db)
  if (m !== 'off') return m
  return read(db, KEY_LAST) === 'point' ? 'point' : 'glance'
}

/** 他自己加的「这些程序里不抓」。出厂那几个在 core 里，这里是他补的 */
export function blocked(db: Database | null): string[] {
  const raw = read(db, KEY_BLOCKED)
  const mine = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length < 64)
  return [...new Set([...DEFAULT_BLOCKED, ...mine])]
}

export function rules(db: Database | null): GlanceRules {
  return { mode: mode(db), blocked: blocked(db) }
}

/** 收下的东西默认进哪一讲。没设过 / 读不出来给 `null`（界面会说「还没设」）*/
export function lecture(db: Database | null): number | null {
  const n = Number(read(db, KEY_LECTURE))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 设一次。★ 要抛 —— 他刚设完，存不进去必须当面说。 */
export function setLecture(db: Database, id: number | null): void {
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(KEY_LECTURE, id && id > 0 ? String(id) : '', Date.now())
}

/** 存。★ 要抛 —— 他刚按了开关，存不进去必须当面说。 */
export function save(db: Database, m: GlanceMode, extraBlocked: string): void {
  const put = db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  const now = Date.now()
  put.run(KEY_MODE, m, now)
  /** 只在真的选了一档时记 —— 「关」不是一种方式，不该覆盖掉上一次的选择 */
  if (m !== 'off') put.run(KEY_LAST, m, now)
  put.run(KEY_BLOCKED, String(extraBlocked ?? ''), now)
}

/* ══ 助手进程 ═══════════════════════════════════════════════ */

let child: ChildProcess | null = null
let lastText: string | null = null

/** 脚本在哪 —— 开发时在仓里，打包后在 `<软件>/resources/glance/` */
export function helperPath(resourcesDir: string): string {
  const packed = join(resourcesDir, 'glance', 'glance.ps1')
  if (existsSync(packed)) return packed
  return join(process.cwd(), 'resources', 'glance', 'glance.ps1')
}

export function running(): boolean {
  return child !== null
}

/**
 * 开始盯。已经在盯就什么都不做。
 *
 * @param onText 判过了、确实该查的那串字
 * @param onDead 助手进程意外没了 —— **必须报上去**：
 *   一个「以为开着、其实早就停了」的监听比关着更糟，
 *   因为他会以为选中没反应是软件坏了。
 */
export function start(
  resourcesDir: string,
  getRules: () => GlanceRules,
  /**
   * ★ 递的是文字**和那段字的屏幕矩形** —— 卡要摆在它下方
   *   （使用者 2026-09-14 晚）。取不到几何时第二个参数是 `undefined`，
   *   调用方退回鼠标位置。
   */
  onText: (text: string, rect?: { x: number; y: number; w: number; h: number }) => void,
  onDead: (why: string) => void,
  /** 只有**没打包**时调用方才会传 true —— 见下面那个注入点 */
  allowFake = false,
  /**
   * ★★ 选中清空了（使用者 2026-09-14：「点击其他地方时，弹窗仍然不会正常消失」）。
   *
   * 可选 —— 不传就是以前那个行为（卡一直挂着）。
   * ★ 它不走 `judge`：`judge` 答的是「要不要查」，而这一条是「别看了」——
   *   两件事。混进去的话，黑名单里的程序里清一次选中就收不走卡了。
   */
  onCleared?: () => void
): void {
  if (child) return
  const script = helperPath(resourcesDir)
  if (!existsSync(script)) {
    onDead('找不到 Glance 的助手脚本：' + script)
    return
  }
  lastText = null
  let buf = ''
  try {
    child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '500'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (e) {
    child = null
    onDead('起不来：' + String(e))
    return
  }

  const dbg = (...a: unknown[]): void => {
    if (process.env['NYX_GLANCE_DEBUG'] === '1') console.log('[glance]', ...a)
  }
  dbg('script =', script, '| pid =', child.pid)
  child.stderr?.on('data', (d: Buffer) => dbg('stderr:', d.toString('utf8').slice(0, 300)))
  child.on('spawn', () => dbg('spawned'))
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    /**
     * ★ 按行切，**留着最后一截没换行的** —— 一次 `data` 不保证是整行，
     *   不留的话长一点的选中会被劈成两半、两半都解析不出来。
     */
    for (;;) {
      const i = buf.indexOf('\n')
      if (i < 0) break
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      dbg('raw', JSON.stringify(line))
      /**
       * ★ 先问「是不是清空了」再问「是不是一次选中」—— 两种行长得不一样，
       *   不会互相认错（`isCleared` 对带 text 的行返回 false，有用例钉着）。
       * ★ 清空了就要把 `lastText` 也清掉：他很可能就是要**再查一次同一个词**，
       *   不清的话第二次会被去重那一闸挡掉，而屏上什么都不会发生。
       */
      if (isCleared(line)) {
        lastText = null
        onCleared?.()
        continue
      }
      const hit = parseHit(line)
      if (!hit) continue
      const v = judge(hit, getRules(), lastText)
      if (!v.take) continue
      lastText = v.text
      /** ★ 物理像素 → DIP（见 `dpi.ts`）。不换的话卡会摆在偏左上的地方 */
      onText(v.text, toDipRect(v.rect))
    }
    // 一行都没有却已经攒了很多 = 对面在吐不带换行的垃圾，丢掉别涨内存
    if (buf.length > 8192) buf = ''
  })

  /**
   * ★ 验收注入点 —— 和 `NYX_FAULT` / `NYX_FAULT_MOUNT` / 注入时间源同一道锁：
   *   **打包产物里恒不成立**（`app.isPackaged` 为真时调用方压根不传）。
   *
   * 为什么需要它：上游（助手真的读到别的程序里的选中）已经在他机器上量过了，
   * 但**下游**（判据 → 置顶浮窗 → 那张卡）没法在自动化里验 ——
   * 自动化没办法稳定地让 Edge 一直保持前台：那个负责拉前台的进程一退出，
   * Windows 就把焦点还给 explorer（实测，助手日志里一路 `proc=explorer`）。
   * 所以给下游一个不依赖焦点的入口，上游照旧靠真机。
   */
  const fake = process.env['NYX_GLANCE_FAKE']
  if (fake && allowFake) {
    setTimeout(() => {
      const v = judge({ text: fake, proc: 'msedge' }, getRules(), lastText)
      if (v.take) {
        lastText = v.text
        onText(v.text, v.rect)
      }
    }, 1500)
  }

  child.on('exit', (code) => {
    const was = child
    child = null
    if (was) onDead(`助手进程退出了（code ${String(code)}）`)
  })
  child.on('error', (e) => {
    child = null
    onDead('助手进程出错：' + String(e))
  })
}

/** 停。★ 幂等：没在跑也能叫。 */
export function stop(): void {
  const c = child
  child = null
  lastText = null
  if (!c) return
  try {
    // 先摘掉 exit 处理器：这是**我们要它停**，不是它死了，不该报一句「意外退出」
    c.removeAllListeners('exit')
    c.removeAllListeners('error')
    c.kill()
  } catch {
    /* 已经没了就算了 */
  }
}
