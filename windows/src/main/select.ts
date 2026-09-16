import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseSelectLine,
  pickOcrRun,
  unionRect,
  type GlanceVerdict,
  type PointHit,
  type ScreenRect
} from '../core/glance.ts'
import { toDipRect } from './dpi.ts'

/**
 * ══ Point · 主进程这一半（使用者 2026-09-14 第三批）★★ ═══════════
 *
 * 他的原话，三条一起看才说得清这个文件为什么长这样：
 *   1「Point 不应该依赖快捷键来触发。我进入 Point 模式以后，Point 本身就应该
 *      处于工作状态。点击图标打开 → 进入 Point 模式并立即可以使用。」
 *   2「Point 的真正目的：让原本无法选中的文字变得可以选中。使用体验应该尽量
 *      像普通网页 / 普通文本界面一样。我可以直接用鼠标选择原本无法选中的词。」
 *   3「Point 与 Glance 完全独立。开 Point 就只运行 Point。」
 *
 * ══ 上一版错在哪（说清楚，免得哪天又绕回去）═══════════════════
 *
 * 上一版把 Point 做成了一颗全局快捷键（Ctrl+Alt+D）：按一下、查鼠标下面那个词。
 * 两处都不对 ——
 *   · **形态不对**：他要的是一个「开着就生效的模式」，不是一个要先记住的按键。
 *   · **它还查错了词**：那颗键把 Electron 的 DIP 坐标直接喂给了 UI Automation，
 *     而 UIA 说的是物理像素（他这台 150% 缩放，差 1.5 倍）——
 *     于是查到的是屏幕左上方 2/3 处的那个词。他报的正是这一条。
 *     坐标那道缝现在有 `dpi.ts` 守着；快捷键本身则整个撤掉了。
 *
 * ══ 怎么做到「让选不中的字能选」════════════════════════════════
 *
 * Android（`NyxAssistService.java`）的办法是挂一张**吃触摸**的无障碍浮层，
 * 再把不属于选词的手势用 `GestureDescription` 重放回宿主（D-402）。
 *
 * Windows 这边**不需要重放那一半**，因为这个功能的前提自己给出了答案：
 * 那些字**本来就选不中**，所以在它们上面拖动，宿主程序什么都不会做。
 * 于是我们只要**旁观**：`select.ps1` 用 `GetAsyncKeyState` + `GetCursorPos`
 * 看着真鼠标，用 `TextPattern.RangeFromPoint` 把两个端点之间的字取出来。
 * 一次都不碰输入流 ＝ 不可能吃掉他的点击。比 Android 那套**更少**的机器。
 *
 * ★ 一次拖动 = 一串事件（起手 / 拖着 / 松手）。拖着的时候只画高亮，
 *   **松手那一下才查词** —— 中途就查的话，一次拖动会连着弹七八张卡。
 */

let child: ChildProcess | null = null

export function helperPath(resourcesDir: string): string {
  return join(resourcesDir, 'glance', 'select.ps1')
}

export function running(): boolean {
  return !!child
}

/**
 * 开始盯着鼠标。**幂等**：已经在盯就什么都不做。
 *
 * @param onMarks 选区变了 —— 画成高亮（DIP 坐标）。空数组 = 擦掉。
 * @param onPick  松手了，而且这一段过了判据 —— 去查它。
 * @param onNote  说不出结果时留一行日志（不弹东西给他看）。
 */
export function start(
  resourcesDir: string,
  handlers: {
    onMarks: (rects: ScreenRect[]) => void
    /**
     * @param ocr 这串字是**认出来的**，不是问系统要来的 —— 卡上要标「可能有误」（D-395）
     */
    onPick: (text: string, rect: ScreenRect | undefined, ocr: boolean) => void
    onNote: (why: string) => void
    /**
     * ★★ 这一下什么都没读到 —— **必须让他看见**（I-177）。
     *
     * 在这之前这条路是哑的：助手报了一行、`parseSelectLine` 认不出来就丢掉，
     * 屏上没卡、日志没有、`onNote` 都不调用。他报的「Point 点不了原神的词」
     * 在代码里就是这个样子 —— 功能没坏，是**坏了不说**。
     * @param at 他拖的那一段在屏幕上的位置（DIP），卡摆在那儿
     * @param note 卡上那一句。★★ **说真正的那个原因，不要一律说「没读到文字」** ——
     *   在黑名单程序里那一下其实**读到了字、是我们不给**，说成「没读到」是假话；
     *   而假话比不说更糟：他会去换个地方拖，永远不知道那个程序被自己拉黑了。
     * @param hint 第二行，可选。只有「这儿确实没字」那两档才给得出有用的下一步。
     */
    onEmpty: (at: ScreenRect | undefined, note: string, hint?: string) => void
    /**
     * ★★ 新的一次手势开始了 —— **把上一张卡收走**。
     *
     * 划词那一路早就有这个（`glance.start` 的 `onCleared`，使用者 2026-09-14
     * 第三条「当我点击其他地方时，弹窗仍然不会正常消失」），**指词这一路一直没接**。
     * ★ 它不能并进 `onMarks([])`：那一个在**查完之后**也会叫一次（擦掉高亮），
     *   并进去的话卡刚摆出来就被自己收走了。
     * ★★ 还有一条只在这条路上成立的理由：认出来那一档是**照着屏幕读**的，
     *   而那张卡是个不透明的窗 —— 不收走的话它会被当成宿主的字读回来。
     */
    onCleared: () => void
    /**
     * 这一段要不要。★ **判据不写在这个文件里** —— `core/glance.ts::judgePoint`
     *   有用例钉着，划词那一路用的也是它。各写一份必然漂，而漂的后果是
     *   一段他没打算给 Nyx 的字从其中一条路溢出去、两边都不报错。
     */
    accept: (hit: PointHit) => GlanceVerdict
  },
  onDead: (why: string) => void,
  /** 只有**没打包**时调用方才会传 true —— 见下面那个注入点 */
  allowFake = false
): void {
  if (child) return
  const script = helperPath(resourcesDir)
  if (!existsSync(script)) {
    onDead('找不到 Point 的助手脚本：' + script)
    return
  }
  let buf = ''
  try {
    child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        /**
         * ★ 把我们自己的进程告诉它：他按住**查词卡的卡头拖动**的时候，
         *   那也是一次「按下 + 移动」，不挡的话卡一动就开始选自己。
         */
        '-SelfPid',
        String(process.pid),
        '-SelfName',
        ownName()
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (e) {
    child = null
    onDead('起不来：' + String(e))
    return
  }

  child.on('error', (e) => {
    child = null
    onDead('助手出错：' + String(e))
  })
  child.on('exit', () => {
    child = null
  })

  /**
   * 助手吐的一行 → 屏上的事。
   * ★ 抽成具名函数只为一件事：**注入点喂的是同一条路**（见文件末尾那段）。
   *   注入点若另走一条捷径，它验的就不是他会遇到的那条路了。
   */
  const feed = (line: string): void => {
    const ev = parseSelectLine(line)
    if (!ev) return
    if (ev.kind === 'clear') {
      handlers.onMarks([])
      handlers.onCleared()
      return
    }
    /**
     * ══ 认出来的那一路（I-177）══════════════════════════════
     *
     * 助手只**量**（哪些词、各自的框在哪）；**挑哪一段是 core 的事**
     * （`pickOcrRun`，有用例）。和真文字那一路同一个分工 ——
     * 两份判据必然漂，而漂的后果是一段他没打算给 Nyx 的字
     * 从其中一条路溢出去，两边都不报错。
     */
    if (ev.kind === 'ocr') {
      const run = pickOcrRun(ev.words, ev.a, ev.b)
      if (!run) {
        /**
         * 一个词都没挑出来。
         * ★★ **只有松手那一下才说话**（使用者 2026-09-14 裁「按照乙」）：
         *   拖动途中也会来这一路（那是在画高亮），而他还在拖 ——
         *   那时候弹一张「这里没读到文字」，等于他每划过一段空白就挨一张卡。
         *   擦掉高亮就够了，话留到他松手。
         */
        handlers.onMarks([])
        if (!ev.done) return
        /**
         * ★ 两档分开说：一个词都没认出来（这块是画的 / 太暗）vs 认出来了
         *   但都离他指的地方太远（他拖在空白处）。下一步不一样，话就不能一样。
         */
        const none = ev.words.length === 0
        const note = none ? '这里没读到文字' : '指针下面没有文字'
        const hint = none
          ? '这一块是画出来的，不是文字。换一段带字的地方再拖一次。'
          : '这一带认出了字，但都离你拖过的地方太远。贴着那行字再拖一次。'
        /**
         * ★★ 日志里带上**数**，不只带结论（2026-09-15 的教训）。
         *   他报「原神里选不中」时，日志只有一句「这里没读到文字」——
         *   那句话分不出「这块确实没字」和「认出来一堆但judge 扔了」，
         *   我只能靠在他屏幕上反复复现去猜。判据得自己说出它看见了什么。
         */
        handlers.onNote(
          note + `（认出 ${String(ev.words.length)} 个词，拖动 ` +
            `${String(Math.round(ev.a.x))},${String(Math.round(ev.a.y))}→` +
            `${String(Math.round(ev.b.x))},${String(Math.round(ev.b.y))}）`
        )
        handlers.onEmpty(toDipRect(bandOf(ev.a, ev.b)), note, hint)
        return
      }
      const hit: PointHit = {
        text: run.text,
        proc: ev.proc,
        inside: run.inside,
        dist: run.dist,
        /** ★ 认出来的 —— 这一栏一路带到卡上（D-395）*/
        ocr: true,
        rect: unionRect(run.rects)
      }
      const v = handlers.accept(hit)
      if (!v.take) {
        handlers.onMarks([])
        if (!ev.done) return
        handlers.onNote(
          '没取：' + v.why +
            `（认出 ${String(ev.words.length)} 个词，选中 ${String(run.rects.length)} 个、` +
            `${String(run.text.length)} 字：${run.text.slice(0, 60)}）`
        )
        /**
         * ★★ 判据挡掉了也得说一声，而且要说**判据给的那个理由**。
         *   「这里没读到文字」在这一档是**假话** —— 字读到了，是我们不给
         *   （黑名单 / 太短 / 没有英文）。说假话比不说更糟：
         *   他会一直换地方拖，永远不知道那个程序被自己拉黑了。
         * ★ 不给第二行：这一档没有「再拖一次」这种下一步可给。
         */
        handlers.onEmpty(toDipRect(hit.rect), v.why)
        return
      }
      const dip = run.rects.map(toDipRect).filter((r): r is ScreenRect => !!r)
      handlers.onMarks(dip)
      /**
       * ★★ **松手那一下才查词**（使用者 2026-09-14 裁「按照乙」）。
       *   拖动途中这一路每走几像素就来一次 —— 那是在**画高亮**，
       *   不是在问「这是什么词」。不拦的话一次拖动会连着弹几十张卡，
       *   而且每一张都真打一次词典 / AI。
       * ★ 这一条和真文字那一路的 `if (ev.done)` 是同一个规矩，
       *   只是那边的高亮由 UIA 给、这边由认出来的词框给。
       */
      if (ev.done) {
        handlers.onNote(
          `认出来的：${String(run.rects.length)} 个词 ${String(v.text.length)} 字 · ` +
            `dist ${String(run.dist)} · ${v.text.slice(0, 60)}`
        )
        /**
         * ★★★ **高亮留着，不擦**（使用者 2026-09-15：「我不要拖一下就消失的那种效果」）。
         *
         * 这儿原来有一句 `onMarks([])`，理由写的是「卡已经在那段字下面了，
         * 两个东西不必同时说同一件事」—— 那句话是错的，而且正好错在他最在意的地方：
         * 松手的一瞬间高亮就没了，屏上只剩一张卡，**他刚选中的那几个词自己看不见了**。
         * Android 那边选区与卡的寿命和手势**彻底解耦**（全文件没有一个自动消失的定时器），
         * 他要的就是那个。
         * ☞ 收走它的只有四种**他自己做的**动作，见文件头注「什么时候收」。
         */
        handlers.onPick(v.text, toDipRect(hit.rect), true)
      }
      return
    }
    /**
     * ★★ 先过判据**再画**。顺序不能反：
     *   密码框里的字、黑名单程序里的字，连高亮都不该出现在屏幕上 ——
     *   「只是画一下没查」不是理由，屏幕上出现了就是已经读了。
     */
    const v = handlers.accept(ev.hit)
    if (!v.take) {
      handlers.onMarks([])
      if (ev.done) handlers.onNote('没取：' + v.why)
      return
    }
    /** 助手说的是物理像素，屏上要 DIP（见 `dpi.ts`）*/
    const dip = ev.rects.map(toDipRect).filter((r): r is ScreenRect => !!r)
    handlers.onMarks(dip)
    if (ev.done) {
      /** ★★★ 高亮留着，不擦 —— 理由同上面认出来那一路（2026-09-15）。
       *   真文字这一路一样要留：他选中之后那几个词得一直看得见。 */
      handlers.onPick(v.text, toDipRect(ev.hit.rect), false)
    }
  }

  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    /** ★ 按行切，留着最后一截没换行的 —— 一次 `data` 不保证是整行 */
    for (;;) {
      const i = buf.indexOf('\n')
      if (i < 0) break
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      feed(line)
    }
    if (buf.length > 8192) buf = ''
  })

  /**
   * ══ 验收注入点 ★★ ══════════════════════════
   * 和 `NYX_FAULT` / `NYX_GLANCE_FAKE` 同一道锁：**打包产物里恒不成立**
   * （`app.isPackaged` 为真时调用方压根不传 `allowFake`）。
   *
   * ★★ 它喂的是**助手吐的那一行原文**，不是一个现成的结果 ——
   *   于是 `parseSelectLine` → `pickOcrRun` → `judgePoint` → 那张卡
   *   全都是真的跑了一遍。喂结果的注入点只能证明「卡会画」，
   *   证明不了「他那一拖会走到这张卡」，而后者才是 I-177 报的那件事。
   *
   * 为什么下游需要它：上游（真的在别的程序上拖一下）自动化不了 ——
   * 原神跑在 SYSTEM 完整性上，UIPI 把合成的鼠标输入整个挡在外面
   * （2026-09-14 实测：光标纹丝不动，`GetAsyncKeyState` 全程 False）。
   * 那一半只能他本人拖，所以下游得有一条不依赖鼠标的入口。
   */
  const fake = process.env['NYX_POINT_FAKE']
  if (fake && allowFake) {
    setTimeout(() => {
      for (const line of fake.split('\u0001')) feed(line)
    }, 1500)
  }
}

/** 不盯了。★ 幂等。 */
export function stop(): void {
  const c = child
  child = null
  if (!c) return
  try {
    c.kill()
  } catch {
    /* 已经死了 */
  }
}

/**
 * 拖动那两个端点围出来的那一小块（屏幕物理像素）。
 * ★ 只用来**摆那张「没读到文字」的卡** —— 一个词都没挑出来时没有词框可用，
 *   而卡还是得出现在他刚拖过的地方，不是屏幕角落。
 * ★ 高宽至少 1：`unionRect` 对 0 宽 0 高给 `undefined`（它那边是对的 ——
 *   摆不出「在它下方」），而这里横着拖一条线正好就是 0 高。
 */
function bandOf(a: { x: number; y: number }, b: { x: number; y: number }): ScreenRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(1, Math.abs(b.x - a.x)),
    h: Math.max(1, Math.abs(b.y - a.y))
  }
}

/** 打包之后是 `Nyx`，开发时是 `electron`。助手拿它认「这是 Nyx 自己的窗口」。 */
function ownName(): string {
  /** ★ 反斜杠绕开写（D-460）—— 正则里的反斜杠在这个仓里被吃掉过四次 */
  const exe = process.execPath.split(String.fromCharCode(92)).join('/')
  const base = exe.slice(exe.lastIndexOf('/') + 1)
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base
}
