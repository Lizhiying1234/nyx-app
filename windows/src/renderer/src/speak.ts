/**
 * 点击即读 · D-040 / D-094 —— **渲染层的执行器**（T-7.5）
 *
 * D-094 定的是「**详情页与卡片上有**，列表行里**没有**」——
 * 列表一行放个喇叭，扫列表时满屏都是图标，反而看不清内容。
 *
 * ── 这里不决定「用谁读」★★ ─────────────────────────────────
 *
 * 以前这里有一半判据：`if (r.engine === 'cloud' && r.data)` 播字节，否则系统语音。
 * 那是**第三份**「顺序与回退」——Android App 一份、Assist 引擎一份、这里一份，
 * 三条路各自决定，于是「现在到底该谁读」没人答得上来。
 *
 * 现在顺序由 `core/voice/resolve.ts` 排（D-466：词典 → 系统，写死的两档）、
 * `core/voice/run.ts` 带预算跑，主进程（`main/tts.ts`）是词典那一步的执行器。
 * **这里只剩三件事**：
 *   ① 主进程给了字节 → 播它（词典音就是一段现成的 mp3）
 *   ② 主进程说轮到系统语音了 → 用浏览器自带的读
 *   ③ 主进程说一步都没排上 → **不出声**，把那句话交回去让界面显示
 * 外加一层「主进程挂了也还能出声」的兜底 —— 那不是判据，是保命。
 */

let current: HTMLAudioElement | null = null

/**
 * 上一次主进程报上来的口音与语速 —— **只给保命兜底用**。
 * 主进程整个挂掉时读不到设置，那时候拿这两个总比拿出厂值离他近。
 */
let lastAccent = 'en-GB'
let lastRate = 1

/** 上一次朗读的说明（用的不是词典音时的原因；一声都没出时那句话）。界面顺手显示出来。 */
export let lastNote = ''

/**
 * ★★★ T-7.12（I-165）· **这段字节，这台机器上的浏览器放得响吗。**
 *
 * 主进程那边已经按扩展名挡过一道（Speex 那种在 `pickDictAudio` 里就不进序列了），
 * 这里是第二道 —— 判据是浏览器**自己**的回答，不是我们抄的一张格式表：
 * `canPlayType` 回空串就是「放不了」，回 `maybe` / `probably` 都算能放。
 *
 * 为什么两道都要：格式表说得出「.ogg 是音频」，说不出「这台机器上的 Chromium
 * 编进了哪几个解码器」。而放不响的表现是**静音** —— 他会以为是这个词没发音。
 */
function canPlay(mime: string | undefined): boolean {
  if (!mime) return true // 没说是什么就照旧试一次（老行为）
  try {
    return new Audio().canPlayType(mime) !== ''
  } catch {
    return true // 问不出来就别拦着 —— 拦错了是听不到声，试错了顶多是回退一次
  }
}

function systemSpeak(text: string, accent: string, rate: number): void {
  const synth = window.speechSynthesis
  if (!synth) {
    lastNote = '这台机器上没有可用的语音引擎。'
    return
  }
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = accent
  u.rate = rate
  // 挑一个口音对得上的嗓子；挑不到就用默认的，总比不读强
  const v = synth.getVoices().find((x) => x.lang.replace('_', '-') === accent)
  if (v) u.voice = v
  synth.speak(u)
}

/** 读一段话。任何失败都只写进 `lastNote`，不抛给界面 —— 读不出来不该挡住学习。 */
export async function speak(text: string): Promise<string> {
  const clean = text.trim()
  if (!clean) return ''

  stop()
  try {
    const r = await window.nyx.tts.speak(clean)
    lastNote = r.note ?? ''
    lastAccent = r.accent
    lastRate = r.rate

    /**
     * ★ 判据是**有没有字节**，不是 `engine` 是什么。
     *   缓存音、云端音、将来接上的词典音都是「一段现成的 mp3」——
     *   按来源分支就等于把 `resolve()` 的序列在这里抄第二遍，
     *   而每加一个来源就要记得回来改这里一次。
     */
    if (r.data && canPlay(r.mime)) {
      // ★ T-7.12 · 用**真实的** MIME，不再写死 audio/mpeg
      const audio = new Audio(`data:${r.mime ?? 'audio/mpeg'};base64,${r.data}`)
      current = audio
      await audio.play()
      return lastNote
    }
    /**
     * ★★ 有字节、但这台机器放不响 —— **不静默**，用系统语音把这个词读出来，
     *   并且用**他设的**口音语速（以前落进最外层 catch，读出来的是默认 en-GB / 1×）。
     */
    if (r.data) {
      lastNote = '这段发音这台电脑放不出来，改用系统语音。'
      systemSpeak(clean, r.accent, r.rate)
      return lastNote
    }

    /**
     * ★★★ D-466 · **一步都没排上就一声都不出**，只把那句话交回去。
     *
     *   两个开关都关 → 「两个开关都关着 …… 到设置里打开任意一个。」
     *
     * 这里偷偷用系统音读出来的话，那两个开关就白拨了 —— 他关掉系统语音
     * 却照样听见系统语音，然后来问我这个设置是不是坏的。
     * 调用点负责把这句话摆出来（详情页 `speak-note` · Capture 的 toast ·
     * 设置页 `tts-note`），**不许静默**。
     */
    if (r.engine === 'none') return lastNote

    systemSpeak(clean, r.accent, r.rate)
    return lastNote
  } catch (err) {
    lastNote = err instanceof Error ? err.message : String(err)
    /**
     * 主进程那边挂了也还能读 —— 退到系统语音。
     * ★ 这一条不是「顺序判据」，是保命：序列本身在 core，这里只是最后一根稻草。
     * ★ T-7.12 · 口音语速用**上一次读到的那份**，读不到才用出厂值 ——
     *   保命不是「顺便把他的设置也换掉」。
     */
    systemSpeak(clean, lastAccent, lastRate)
    return lastNote
  }
}

/**
 * ══ 就用系统语音读（使用者 2026-09-13 第二轮）════════════════
 *
 * 他的原话：「这个查词界面的音频按钮对应的是：系统语音。」
 * 查词卡顶上那颗喇叭走这一条 —— 词典自己那几段真人录音在 Dictionary 那一档里，
 * 是**另一件东西**（他定的两档：词典语音 + 系统语音）。
 *
 * ★ 为什么不直接调 `speak()`：那一条走 D-466 的序列（词典 → 系统），
 *   有词典录音时会用词典录音 —— 而他要的是词条层那颗按钮**固定**是系统语音。
 * ★ 但开关照样认：系统语音关着就**不出声**，把那句话交回去让界面说出来。
 *   偷偷读出来的话，那个开关就白拨了（`speak()` 里那条注释同一个理）。
 */
export async function speakSystem(text: string): Promise<string> {
  const clean = text.trim()
  if (!clean) return ''
  stop()
  try {
    const s = await window.nyx.tts.settings()
    if (!s.system) {
      lastNote = '系统语音关着 —— 到「设置 → 朗读」里打开它。'
      return lastNote
    }
    lastNote = ''
    systemSpeak(clean, s.accent, s.rate)
    return lastNote
  } catch (err) {
    /** 设置读不出来也别哑着 —— 用上一次读到的那份口音语速（保命，不是判据）*/
    lastNote = err instanceof Error ? err.message : String(err)
    systemSpeak(clean, lastAccent, lastRate)
    return lastNote
  }
}

export function stop(): void {
  window.speechSynthesis?.cancel()
  if (current) {
    current.pause()
    current = null
  }
}
