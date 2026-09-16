/**
 * 朗读（**Android App 执行器**）· D-040 / D-094 / ★ D-466
 *
 * ══ 顺序不在这个文件里 ═══════════════════════════════════════
 *
 * 「用谁读」由 `core/voice/resolve.ts` 排、预算由 `core/voice/run.ts` 执行，
 * 装配在 `db/voice.ts`。这里只回答一句话 —— **「这一步在 App 上具体怎么做」**：
 *   dictionary  dict.ts::dictPronounce（词典自带的真人音）
 *   system      原生 TtsPlugin（WebView 里没有 speechSynthesis，真机探过）
 *
 * ★★ D-466（使用者 2026-09-07「语音设置简化」）：来源只剩这两档。
 *   云端那几家、来源顺序、以及**同步缓存那一档**（D-244 / D-374）一起退 ——
 *   缓存里的 mp3 只有一个来源，就是电脑用云端合成之后随同步落下来的；
 *   没有云端就没有东西能填进去。
 *   ★ 已经同步下来的那些 mp3 **不删文件**，只是不再读它们；
 *     Keystore 里存过的密钥同样不删，只是不再读（D-216 只增不删）。
 */
import { registerPlugin } from '@capacitor/core'
import { explainVoice, ttsText, type SourceId, type VoiceRunResult, type VoiceTrace } from '../core-link.ts'
import type { Db } from './types.ts'
import {
  dictionaryStep,
  loadSwitches,
  runVoice,
  setSwitch,
  systemStep,
  ttsPrefs,
  type VoiceHave,
  type VoiceOpts,
  type VoiceOutcome
} from './voice.ts'

export { loadSwitches, setSwitch, ttsPrefs, type TtsPrefs, type VoiceSwitches } from './voice.ts'

interface NyxTtsPlugin {
  speak(o: { text: string; lang: string; rate: number }): Promise<{ ok: boolean; why?: string }>
  stop(): Promise<void>
}
const NyxTts = registerPlugin<NyxTtsPlugin>('NyxTts')

let current: HTMLAudioElement | null = null

/** 上一次朗读**赢下来的那一步**（`null` = 一步都没成） */
export let lastEngine: SourceId | null = null

/** 上一次的完整账（每一步 hit / miss / timeout / error 与毫秒）—— 真机批要读它 */
export let lastRun: VoiceRunResult<VoiceOutcome> | null = null

/**
 * ★★ 上一次的**运行账本**（`VoiceTrace`，core 一份）。
 *
 * 与 `lastRun.tried` 的差就是它要补的洞：**`tried` 里没有被跳过的那几步**。
 * 「为什么没用词典音」这个问题的答案往往正在跳过里（他关了 / 这台机器上用不了），
 * 设置页那一行「上次读的是谁、为什么」读的就是它。
 * ★ 账本是诊断不是判据：不读它，出声一模一样。
 */
export let lastTrace: VoiceTrace | null = null

/**
 * ★★ T-6.6 · **上一次 `speak()` 的分段墙钟**（③ 档验收通道，同 `nyxDb.busyTimeoutMs` 的纪律）。
 *
 * 为什么要有它：C 在真机上量到 `nyxTts.speak()` **墙钟 662 秒**，而
 * `tried` 里每一步加起来只有 **3.7 秒** —— 差的那部分**不在任何一步里**，
 * 也就没有任何现有的账能解释它。`tried` 只记 `runVoicePlan` 里那几步，
 * 而 `speak()` 还有三段在它之外：读偏好（prefs）· 序列本身（run）· 出声（play）。
 *
 * ★ 纯计时，不参与任何判断；拿掉它 `speak()` 一模一样。
 */
export interface SpeakTiming {
  /** 这一次读的什么（截断到 40 字，只为对得上是哪一次） */
  text: string
  prefsMs: number
  runMs: number
  playMs: number
  totalMs: number
  source: SourceId | null
}
export let lastTiming: SpeakTiming | null = null

/**
 * 词典那一步在这台机器上跑不跑得动 —— **如实报，不为了两端一致伪造**。
 * T-5.10 之后 App 也有随机读通道；没挂上时 `nyxDb.dictIo` 报 `memory`，
 * 那时问词典只会白花 150 ms 预算。
 */
function dictionaryAvailable(): boolean {
  const g = globalThis as unknown as Record<string, { dictIo?: string } | undefined>
  return g['nyxDb']?.dictIo === 'random'
}

/**
 * ★★ **这个执行器报上去的「现在有什么」**（`speak()` 用的就是它）。
 *
 * 抽出来是为了它**能被用例盯住**：原来这几行写在 `speak()` 里是个字面量，
 * 而所有用例喂给 resolver 的都是自己造的 `availability` 对象 ——
 * 于是「App 自己怎么探」这件事**一条用例都没有**（主控 2026-09-06 的负向对照：
 * 把 `dictionaryAvailable()` 改成恒 `true`，244/244 照样全绿）。
 */
export function appAvailability(): VoiceHave {
  return {
    dictionary: dictionaryAvailable(),
    system: true
  }
}

/**
 * 读一段话。返回值是给界面的一句话说明：**空串 = 读出来了，别打扰**；
 * 非空 = 读不出来的原因（读不出来不抛 —— 朗读失败不该挡住学习，D-338 同款态度）。
 */
export async function speak(db: Db, text: string, opts: VoiceOpts = {}): Promise<string> {
  /**
   * ★ 没什么可读 = 什么都不做，**连 `stopSpeak()` 都不许调**。
   *   少了它，一次空文本会先把正在播的那一声掐掉、再让整条序列跑一遍、
   *   最后让系统 TTS 读一个空串。返回空串的含义照旧 ——「没什么可说的，别打扰」。
   */
  if (!ttsText(text)) return ''
  stopSpeak()
  lastEngine = null
  lastRun = null
  lastTrace = null
  const wall0 = Date.now()
  lastTiming = null
  const p = await ttsPrefs(db)
  const wallPrefs = Date.now()

  const { plan, request, result } = await runVoice(
    db,
    text,
    appAvailability(),
    {
      dictionary: dictionaryStep(db, p, opts.flip),
      system: systemStep(p)
    },
    opts
  )
  lastRun = result
  lastTrace = result.trace
  lastEngine = result.source
  const wallRun = Date.now()
  /** 出声那一段记完才能定案 —— 三条 return 路径各调一次，忘不掉 */
  const mark = (): void => {
    const now = Date.now()
    lastTiming = {
      text: text.slice(0, 40),
      prefsMs: wallPrefs - wall0,
      runMs: wallRun - wallPrefs,
      playMs: now - wallRun,
      totalMs: now - wall0,
      source: result.source
    }
  }

  if (!result.value) {
    mark()
    // 一步都没成。序列本来就是空的（两个开关都关着）→ 说 plan 的话；试过没成 → 说每一步的账
    return plan.attempts.length === 0 ? plan.why : `读不出来：${explainVoice(result)}`
  }
  if (result.value.kind === 'audio') {
    const said = await playAudioB64(result.value.b64, result.value.mime)
    mark()
    return said
  }
  try {
    const r = await NyxTts.speak({ text: request.text, lang: result.value.accent, rate: result.value.rate })
    mark()
    if (!r.ok) lastEngine = null
    return r.ok ? '' : (r.why ?? '这台手机读不了。')
  } catch (e) {
    mark()
    lastEngine = null
    return `朗读没起来：${(e as Error)?.message ?? e}`
  }
}

/**
 * ★ 播一段**词典自带的**真人音频（`sound://` 那条链接取回来的字节）。
 *
 * 为什么放在这个文件：它和 `speak` 抢的是同一个喇叭 —— 共用同一个
 * `current`，新的一声自动掐掉上一声。两处各拿一个 `Audio` 会叠着响。
 * 返回值同 `speak` 的纪律：**空串 = 响了，别打扰**；非空 = 播不出来的原因。
 *
 * ★ **它不动 `lastEngine`** —— 那个变量记的是「上一次 speak() 赢下来的那一步」。
 *   词条里点 `sound://` 直接播不是一次 speak，不该把账改掉。
 */
export async function playAudioB64(b64: string, mime = 'audio/mpeg'): Promise<string> {
  stopSpeak()
  try {
    const audio = new Audio(`data:${mime};base64,${b64}`)
    current = audio
    await audio.play()
    return ''
  } catch (e) {
    /**
     * ★ `AbortError` = **这一声是被我们自己掐掉的**（下一次 `stopSpeak()` 调了
     *   `pause()`，而上一次的 `play()` 还在路上）。把它报成「放不出来」是假话
     *   （D-412）：他刚点的那一声其实正常，被顶掉的是上一声。
     *   2026-09-13 真机撞到：第一次点词典发音要先加载 Speex 的 WASM，
     *   那个窗口足够长，手快点第二下就必现。
     */
    if ((e as Error)?.name === 'AbortError') return ''
    return `这段音频放不出来：${(e as Error)?.message ?? e}`
  }
}

export function stopSpeak(): void {
  if (current) {
    current.pause()
    current = null
  }
  void NyxTts.stop().catch(() => {})
}

/**
 * ③ 档验收通道（同 globalThis.nyx 的纪律：不看界面，看变量）。
 *
 * `engine()` 报**赢下来的那一步的 id**，`tried()` 报每一步的
 * hit / miss / timeout / error 与毫秒，`trace()` 比 `tried()` 多的正是
 * **被跳过的那几步与原因** —— 「为什么没用词典音」在真机上答得出来，不用猜。
 */
;(globalThis as Record<string, unknown>)['nyxTts'] = {
  speak,
  ttsPrefs,
  /** 两把开关 —— 真机上验「点一下真的落库了」读的是它 */
  switches: loadSwitches,
  setSwitch,
  engine: () => lastEngine,
  tried: () => lastRun?.tried ?? [],
  trace: () => lastTrace,
  why: () => (lastRun ? explainVoice(lastRun) : ''),
  /** ★ T-6.6 · 上一次 speak() 的分段墙钟 */
  timing: () => lastTiming
}
