/**
 * ══ 朗读 · Android 两个执行器的公共装配（D-466）════════════════
 *
 * ── 只有两档 ★★★ ────────────────────────────────────────────
 *
 * 使用者 2026-09-07：语音来源只有**词典语音**与**系统语音**，两个都默认开着，
 * 顺序写死 —— 词典有原生音就用词典音，没有就用系统音，系统音是通用兜底。
 * 厂商、Tab、来源排序、缓存那一路（D-040 / D-244 / D-374 的云端半场）全退。
 *
 * ── 这个文件**不是**第二份判据 ★★ ───────────────────────────
 *
 * 「用谁读」仍在 `core/voice/resolve.ts`，「预算怎么执行」仍在
 * `core/voice/run.ts`。这里只做三件平台活：
 *   ① 把两把开关读出来
 *   ② 把请求拼出来（text / kind / origin）
 *   ③ 把两个执行器写法完全一样的两步交出去（dictionary 与 system）
 * 现在两个执行器**每一步都一样**了 —— 以前不一样的只有缓存那一步的取字节方式，
 * 而缓存那一档随云端一起退了（没有云端就没有东西能填进缓存）。
 *
 * ── 为什么每一步只「取」不「播」★★ ─────────────────────────
 *
 * 词典那一步有 150 ms 硬预算。超时之后**那个 Promise 还在跑**
 * （JS 没有取消原语，`run.ts` 的文件头把这件事写清楚了）。
 * 如果 step 自己负责播放，那么一次超时的词典查询会在系统音已经响起来
 * 之后**再响一次** —— 两个声音叠在一起，而且没人说得清为什么。
 * 所以 step 一律只返回字节或一个「交给系统 TTS」的指令，
 * **播放由赢下来的那一步之后统一做**。
 */
import { dictPronounce, pronUnplayable } from './dict.ts'
import { prefRaw, prefSet } from './prefs.ts'
import type { Db } from './types.ts'
import {
  DEFAULT_SWITCHES,
  dictMimeOf,
  inferVoiceKind,
  resolveVoice,
  runVoicePlan,
  ttsText,
  unplayableDictSays,
  type SourceId,
  type VoiceAvailability,
  type VoiceKind,
  type VoiceOrigin,
  type VoicePlan,
  type VoiceRequest,
  type VoiceRunResult,
  type VoiceStep,
  type VoiceSwitches
} from '../core-link.ts'

/**
 * 这台机器上**现在**有什么（事实，不是偏好）· 判据形状来自 core。
 *
 * ★ 与开关分开：他把词典音开着也改变不了「这台机器上词典通道没挂上」。
 *   两者分开之后，「为什么没用词典音」才答得出来。
 */
export type VoiceHave = VoiceAvailability
export type { VoiceSwitches }

/** 朗读偏好。两项，都跟着人走（USER）：口音与语速 */
export interface TtsPrefs {
  accent: string
  rate: number
}

/** 默认值与 Windows `Tts.settings()` 逐字同源 */
export async function ttsPrefs(db: Db): Promise<TtsPrefs> {
  const rate = Number((await prefRaw(db, 'tts.rate')) ?? '1')
  return {
    accent: (await prefRaw(db, 'tts.accent')) ?? 'en-GB',
    // D-040 · 语速 0.7×–1.3×（写入侧也夹，这里再夹一次防手改过库）
    rate: Math.max(0.7, Math.min(1.3, Number.isFinite(rate) ? rate : 1))
  }
}

/**
 * 一步取回来的东西。
 *   `audio`  —— 字节到手，播它就行（词典自带的真人音）
 *   `system` —— 没有字节，请系统 TTS 现读（执行器各自调各自的 TTS）
 */
export type VoiceOutcome =
  | { kind: 'audio'; b64: string; mime: string; from?: string }
  | { kind: 'system'; accent: string; rate: number }

export type VoiceSteps = Partial<Record<SourceId, VoiceStep<VoiceOutcome>>>

export interface VoiceOpts {
  /** 知道就传（中日文整句 `inferVoiceKind` 会判成 word） */
  kind?: VoiceKind
  origin?: VoiceOrigin
  /** 长按喇叭翻口音（词典音那一步用） */
  flip?: boolean
}

/**
 * ══ 两把开关（`tts.dictionary` / `tts.system`）═══════════════════
 *
 * 这就是全部的语音偏好（外加口音与语速）。两把都属 **USER，进同步** ——
 * 「我要不要词典音」是他想要的东西，不是「这台机器怎么实现」，
 * 所以换一台设备应该自动恢复（core `prefs.ts` 白名单那一段写着同一句）。
 *
 * ★ 出厂**两个都开**（使用者原话）。默认值只有一处 —— core 的
 *   `DEFAULT_SWITCHES`；这一端读不到就回它，不在平台层再写一遍 `true`。
 *
 * ★★ **没有回填、没有迁移**（D-466）：旧的 `tts.sources` 那串顺序里
 *   没有任何一个字对得上新的两把开关（那是「云端 + 排序」那个世界的形状），
 *   照着它猜等于替他做一个他从没做过的选择。库里那几行**留着不动**
 *   （D-216 只增不删），只是从此没人读。
 *
 * ★ 值是 `'1'` / `'0'`：core 的 `bool` 那一档只收这两个字符串
 *   （`checkPrefValue`），别的一律拒写。
 */
const SWITCH_KEY = { dictionary: 'tts.dictionary', system: 'tts.system' } as const

export async function loadSwitches(db: Db): Promise<VoiceSwitches> {
  const out = { ...DEFAULT_SWITCHES }
  for (const id of ['dictionary', 'system'] as const) {
    const raw = await prefRaw(db, SWITCH_KEY[id])
    // 没设过（null）或手改过库改成了别的字样 → 出厂值，不猜
    if (raw === '0') out[id] = false
    else if (raw === '1') out[id] = true
  }
  return out
}

/** 开 / 关一档。返回**落库之后重新读回来的**那一份 —— 界面显示的就是库里的事实 */
export async function setSwitch(db: Db, id: keyof VoiceSwitches, on: boolean): Promise<VoiceSwitches> {
  await prefSet(db, SWITCH_KEY[id], on ? '1' : '0')
  return loadSwitches(db)
}

export interface VoiceRun {
  plan: VoicePlan
  request: VoiceRequest
  result: VoiceRunResult<VoiceOutcome>
}

/**
 * 排序 + 照序列跑。**两个执行器都从这里进**，所以「顺序」这件事
 * 在 Android 侧只有一处入口 —— 谁想抄近路都得先删掉这个函数。
 *
 * ★ 顺序**写死**：词典在前、系统在后（D-466 使用者原话）。库里不再存顺序，
 *   只存「这一档要不要」。两个都关 = 空序列 + 一句人话，不静默。
 */
export async function runVoice(
  db: Db,
  text: string,
  have: VoiceHave,
  steps: VoiceSteps,
  opts: VoiceOpts = {}
): Promise<VoiceRun> {
  const clean = ttsText(text)
  const request: VoiceRequest = {
    text: clean,
    kind: opts.kind ?? inferVoiceKind(clean),
    origin: opts.origin ?? 'detail'
  }
  const plan = resolveVoice(request, await loadSwitches(db), have)
  /**
   * ★★ I-165 · 词典那一步 miss 时，**这一端知道一个更具体的原因就说它**。
   *
   * `VoiceStep` 的契约是「拿到了给值，没拿到给 null」—— miss 里没有位置放理由，
   * 所以 core 开了 `missSays` 这个口子问平台。词条**有**发音、只是 `.spx` 放不出来
   * 那一种，说成「这本词典里没有这个词的发音」是假话：他会去换一个词，
   * 而真正该做的是换一本词典。
   * ★ 话术仍在 core（`unplayableDictSays`，与 Windows 同一句），
   *   这一端只把「这一趟到底是哪一种 miss」这个事实递进去。
   */
  const result = await runVoicePlan(plan, request, steps, {
    missSays: (source) =>
      source === 'dictionary' && pronUnplayable.length > 0
        ? unplayableDictSays(pronUnplayable)
        : undefined
  })
  return { plan, request, result }
}

// ── 两端写法完全一样的两步 ────────────────────────────────────

/**
 * 词典里的真人音。判据（键怎么算、找哪几卷、口音怎么挑）全在
 * `db/dict.ts::dictPronounce` —— 与 Lookup 里 `sound://` 同一条底路。
 */
export function dictionaryStep(db: Db, p: TtsPrefs, flip = false): VoiceStep<VoiceOutcome> {
  return async (req, attempt) => {
    const wantAme = /us/i.test(p.accent) !== flip
    /**
     * ★★ T-6.6 · **把 core 给这一步的预算真的递下去。**
     *
     * `runVoicePlan` 那边是 `Promise.race` + `setTimeout`；而这一步底下
     * （`DictionaryIO.read` → `nyxHost.dictRead`）是**同步** JS→Java 调用，
     * 同步循环不让出事件循环，那个 `setTimeout` 永远不会被执行 ——
     * 真机实测「最多多等 150 ms」变成 **53.4 秒**，期间引擎 JS 线程整个堵死
     * （C，2026-09-06）。所以预算必须由 `dictPronounce` **自己在两本书之间看表**。
     *
     * ★ 判据没有搬家：多少毫秒仍然是 core 的 `attempt.budgetMs` 说了算，
     *   这里只是把它交到唯一能执行它的那一层。
     */
    const hit = await dictPronounce(db, req.text, wantAme, {
      ...(attempt.budgetMs === null ? {} : { budgetMs: attempt.budgetMs })
    })
    if (!hit) return null
    /**
     * ★ I-165 · mime **按这条链接算**（core 的 `dictMimeOf`），不再写死 `audio/mpeg`：
     *   `.ogg` / `.wav` 被贴上 mp3 的标签时，放不放得响全看浏览器肯不肯猜。
     *   认不出的扩展名回 `audio/mpeg` —— 到这一步它已经过了「放得响」那道闸。
     */
    return {
      kind: 'audio',
      b64: hit.b64,
      mime: dictMimeOf(hit.key) ?? 'audio/mpeg',
      from: hit.accent
    }
  }
}

/**
 * 系统 TTS。这一步**永远不会 miss** —— 它是最后一根稻草，
 * `resolve()` 给它的预算是 `null`，返回的是「请你现读」的指令而不是字节。
 * 真读不出来（这台手机没装语音）由执行器如实说，不在这里假装成 miss：
 * 那会让序列继续往下走，而下面根本没有东西了。
 */
export function systemStep(p: TtsPrefs): VoiceStep<VoiceOutcome> {
  return () => Promise.resolve({ kind: 'system', accent: p.accent, rate: p.rate })
}
