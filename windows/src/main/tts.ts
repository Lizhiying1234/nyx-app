import type { Database } from 'better-sqlite3'
import { Prefs } from './db/prefs.ts'
import type { TtsSettings, TtsResult } from '@shared/api.ts'
import { mimeOf, parseMediaRef } from '../core/dict/media.ts'
import { pickDictAudio, unplayableDictSays } from '../core/voice/providers/dict-audio.ts'
import { inferVoiceKind, resolve } from '../core/voice/resolve.ts'
import { explain, runVoicePlan } from '../core/voice/run.ts'
import { ttsText } from '../core/tts-key.ts'
import {
  DEFAULT_SWITCHES,
  SOURCE_LABEL,
  type VoiceAvailability,
  type VoiceRequest,
  type VoiceSwitches,
  type VoiceTrace
} from '../core/voice/types.ts'

/**
 * 朗读 · Windows 执行器 · D-466（使用者 2026-09-07「语音设置简化」）
 *
 * ── 这一层做什么 ────────────────────────────────────────────
 *
 * **不决定用谁读。** 顺序由 `core/voice/resolve.ts` 排（写死的两档：
 * 词典 → 系统），`core/voice/run.ts` 带着 150 ms 预算跑，这里只回答
 * 「这一步具体怎么做」：
 *
 *   词典这一步 —— 问词典层要这个词的发音字节（`pickDictAudio` 挑英音 / 美音）
 *   系统这一步 —— 回一句「轮到你了」，真正出声的是渲染层的 `speechSynthesis`
 *
 * ── 这里原来有多少东西，现在没了 ★★ ─────────────────────────
 *
 * D-040 那版是「云端高质量 TTS + 永久缓存」，T-7.5 ～ T-7.9 又长成了
 * 八家提供者 + 来源顺序 + 地址 / 密钥 / 模型 / 音色 + 缓存目录 + 一次性迁移。
 * D-466 把那一整条撤了：`fromProvider` · `testProvider` · 缓存目录读写 ·
 * 地址与凭据的存取 · `legacyCloudOrder` · `correctLegacySources` ·
 * `setCloudOn` 全部删掉，`tts:test` / `tts:saveSources` / `tts:cacheInfo` /
 * `tts:clearCache` 四口 IPC 一起撤。
 *
 * 旧键**只删代码不删数据**（D-216）：`tts.sources` 与两把记号、
 * `tts.provider.<id>.voice`、`settings` 里的 `tts.<id>.baseUrl`、
 * 安全存储里的 `tts.<id>.key` —— 库里那些行原封不动，只是再没有人读写它们。
 *
 * ── 账本 · D-219 ────────────────────────────────────────────
 *
 * 每次朗读落**一行** `nyx.log`：谁出的声、花了多久、每一步为什么。
 * 一行，不是一份要他自己读的 JSON —— 他要的是能贴给我看的东西。
 */

/**
 * ★★ 朗读向词典层要的**只有两件事**，所以这里只声明这两件。
 *
 * ★ 不直接接 `DictionaryRegistry`：这一层不该知道词典怎么存、怎么扫、怎么解压。
 *   接线在 `main/index.ts`（装配的地方）：`card` 走 `buildRichCard`、
 *   `resource` 走 `registry.resource` —— 和词典正文里点喇叭同一条路。
 * ★ 窄接口还换来一件事：`test:db` 里可以塞一个六行的替身，
 *   那条用例才真的在测「发音取到了没有」，而不是只测到「这一步进了序列」。
 */
interface DictAudioSource {
  /** 这个词的富词条（只用得到 `refs.audio`） */
  card(word: string): { refs: { audio: string[] } }
  /** 一条资源的字节。取不到就是 `null` —— **miss，不是错** */
  resource(bookUid: string, key: string): Promise<Uint8Array | null>
  /**
   * ★★★ T-7.13（I-166）· **现在问得起吗**。
   *
   * `card()` 是**同步**的：那本词典没开过的话，它要先把索引建起来
   * （A 2026-09-07 在他真库上量到 8963 / 14637 ms）。而同步代码堵住事件循环时，
   * `runVoicePlan` 那 150 ms 的预算连计时器都轮不上 —— 预算写了等于没写。
   *
   * 所以先问一句：没开好就当 miss、系统音立刻出声，开书那笔钱由预热去付。
   * ★ 可选：不给就是「随时问得起」（用例里的六行替身不用管这件事）。
   */
  ready?(): { ok: boolean; why?: string }
}

export class Tts {
  private prefs: Prefs
  constructor(
    /**
     * ★ 只用来建 `Prefs` —— 这一层自己**一句 SQL 都不写**。
     *   四把键全在 `user_preferences` 里，唯一的入口是 `Prefs`（判据在
     *   `core/prefs.ts`：不在白名单里的、看着像密钥的一律拒）。
     *   以前这里直接 `insert into settings` 存地址与模型名，那条路随 D-466 一起没了。
     */
    db: Database,
    /**
     * ★ 写 `nyx.log` 的那一支笔（`index.ts` 的 `log()`）。
     *   可选：用例里不给就不写日志 —— 账本本身照样产出。
     */
    private log?: (level: 'info' | 'error', where: string, msg: string) => void
  ) {
    this.prefs = new Prefs(db)
  }

  /**
   * ★★ 词典发音要用到词典层。
   *
   * ★ 为什么是**事后交进来**而不是构造参数：`Dicts` 在 `index.ts` 里比 `Tts`
   *   晚一步建（它要扫词典目录）。为了接一条发音去调换那两行的顺序，
   *   等于让一个不相干的初始化次序变成隐式依赖 —— 那种东西坏起来没声音。
   * ★ 没交进来 = 这台机器上没有词典发音（`availability.dictionary` 就是 false），
   *   判据会如实跳过这一步，账本也说得出为什么。
   */
  private dicts: DictAudioSource | null = null
  useDictionaries(d: DictAudioSource): void {
    this.dicts = d
  }

  /**
   * 四把键全在偏好表里（USER，跟着人走）。
   *
   * ★ 读不到就用出厂值：两个开关都开（`DEFAULT_SWITCHES`）、英音、1×。
   *   **没有「回填旧键」这一档** —— 退役的那一串（`tts.cloud` / `tts.sources` /
   *   `tts.provider.<id>.voice` …）里没有任何一个字对得上这两把新开关，
   *   硬要翻译只会翻出一个谁也说不清来处的状态。
   */
  settings(): TtsSettings {
    return {
      ...this.switches(),
      accent: (this.prefs.raw('tts.accent') ?? 'en-GB') as TtsSettings['accent'],
      rate: Number(this.prefs.raw('tts.rate') ?? '1') || 1
    }
  }

  private switches(): VoiceSwitches {
    const on = (key: string, d: boolean): boolean => {
      const raw = this.prefs.raw(key)
      return raw === null ? d : raw === '1'
    }
    return {
      dictionary: on('tts.dictionary', DEFAULT_SWITCHES.dictionary),
      system: on('tts.system', DEFAULT_SWITCHES.system)
    }
  }

  /**
   * ★★ 四把一起写。
   *
   * ★ 两把开关**必须都落库**：少存一把的表现是「那个开关按下去、回读还是旧值」，
   *   也就是「看起来永远按不动」—— 2026-09-06 真出过一次
   *   （`test:db` 里那条 save → settings 来回用例盯的就是这一条）。
   */
  save(s: TtsSettings): void {
    this.prefs.set('tts.dictionary', s.dictionary ? '1' : '0')
    this.prefs.set('tts.system', s.system ? '1' : '0')
    this.prefs.set('tts.accent', s.accent)
    // D-040 · 语速 0.7×–1.3×
    this.prefs.set('tts.rate', String(Math.max(0.7, Math.min(1.3, s.rate))))
  }

  /**
   * 这台机器上现在有什么 —— **事实，不是偏好**。
   *
   * ★ `dictionary`：这台机器上有没有词典层。**查得到查不到是下一步的事**
   *   （miss，账本会说「这本词典里没有这个词的发音」）。把「查不查得到」提到
   *   这里判，等于每读一个词都先全库扫一遍 —— 那正是 150 ms 预算在防的事。
   * ★ `system: true`：`speechSynthesis` 在渲染层，主进程查不到。Chromium 一定有它，
   *   而渲染层自己还有一层兜底（`speak.ts` 里那句「这台机器上没有可用的语音引擎」）。
   */
  private availability(): VoiceAvailability {
    return { dictionary: !!this.dicts, system: true }
  }

  /**
   * 词典发音 —— 两档里的第一档。
   *
   * ── 查不到**不是错**，是 miss ──────────────────────────────
   *
   * 返回 `null` = 这一步没命中，判据接着往下走（系统音），
   * 账本记一句「这本词典里没有这个词的发音」。抛异常留给「词典坏了」那种事。
   *
   * ★ 150 ms 的预算由 `runVoicePlan` 管着 —— 全库扫描的成本随启用词典数
   *   线性增长，最坏情况下他也只多等这么久就能听到系统音。
   */
  private async fromDictionary(clean: string, s: TtsSettings): Promise<TtsResult | null> {
    if (!this.dicts) return null
    /**
     * ★★★ T-7.13 · 先问「问得起吗」，再问词。
     *   顺序就是判据：反过来的话，`card()` 已经把事件循环堵住了，
     *   后面再判也来不及 —— 他要等的那 9 秒已经花掉了。
     */
    const ready = this.dicts.ready?.() ?? { ok: true }
    if (!ready.ok) {
      this.dictMiss = ready.why ?? '词典这一档现在还问不了'
      return null
    }
    const refs = this.dicts.card(clean).refs.audio.filter((r) => typeof r === 'string' && r !== '')
    const ref = pickDictAudio(refs, s.accent)
    if (!ref) {
      /**
       * ★★★ T-7.12（I-165）· **有音、只是放不响**，这一种 miss 要单说。
       *
       * 说成通用的「这本词典里没有这个词的发音」是假话 —— 他会去换一个词试，
       * 而真正该换的是词典（LDOCE5 的词头音是 Speex，Chromium 放不出来）。
       * 话术在 core 一处（两端共用），这里只负责把「是哪一种 miss」递给账本。
       */
      if (refs.length > 0) this.dictMiss = unplayableDictSays(refs)
      return null
    }
    const parsed = parseMediaRef(ref)
    if (!parsed) return null
    const bytes = await this.dicts.resource(parsed.bookUid, parsed.key)
    if (!bytes || bytes.byteLength === 0) return null
    return {
      engine: 'dictionary',
      // 界面在 http:// 源下加载不了 file://，所以把字节直接带回去
      data: Buffer.from(bytes).toString('base64'),
      /**
       * ★★ T-7.12 · **真实的 MIME 跟着字节一起走**。
       *   以前渲染层写死 `data:audio/mpeg`，于是 `.ogg` / `.wav` / `.m4a` 这些
       *   明明放得响的格式也会被浏览器拒掉 —— 而拒掉的样子和「没有发音」一模一样。
       */
      mime: mimeOf(parsed.key) ?? 'audio/mpeg',
      accent: s.accent,
      rate: s.rate
    }
  }

  /**
   * 这一趟词典那一步为什么 miss —— **只在有更具体的说法时有值**，
   * 每次 `speak()` 开头清掉（它是一趟的账，不是状态）。
   */
  private dictMiss: string | null = null

  /**
   * 读一段话。
   *
   * 返回 `engine: 'system'` 时，界面用浏览器自带的语音合成读 —— 不算失败，是序列里的一步。
   * 返回 `engine: 'none'` 时**一声都不出**，只把 `note` 说给他听（D-466：
   * 两个开关都关 = 不出声，但那一次点击要说一句，不许静默）。
   */
  async speak(text: string): Promise<TtsResult> {
    const s = this.settings()
    const clean = ttsText(text)
    if (!clean) throw new Error('没有可读的内容。')

    /**
     * ★ `origin` 固定 `detail`：判据不拿它选谁读（`resolve()` 里写了理由），
     *   它只是账面上的来处。调用点不用为了朗读改签名。
     */
    const request: VoiceRequest = { text: clean, kind: inferVoiceKind(clean), origin: 'detail' }
    const plan = resolve(request, this.switches(), this.availability())

    this.dictMiss = null
    const run = await runVoicePlan<TtsResult>(
      plan,
      request,
      {
        dictionary: async () => this.fromDictionary(clean, s),
        // 系统语音由渲染层出声 —— 这里只是把「轮到它了」交出去
        system: async () => ({ engine: 'system', accent: s.accent, rate: s.rate })
      },
      // ★ T-7.12 · 词典那一步 miss 时，如果知道得更具体就让账本说具体的那一句
      { missSays: (id) => (id === 'dictionary' ? (this.dictMiss ?? undefined) : undefined) }
    )

    /** ★★ 每一次朗读都落一行账（D-219） */
    this.lastTrace = run.trace
    this.writeTrace(run.trace)

    const note = explain(run)
    if (run.value) return { ...run.value, ...(note ? { note } : {}), trace: run.trace }

    /**
     * ★★★ 一步都没成。**这里不再偷偷用系统音兜底** ——
     *   序列里没有系统音只有两种可能：他把它关了，或者这台机器上没有语音引擎。
     *   前者偷偷读出来等于开关白拨；后者读也读不出来。两种都该说话，不该装作没事。
     */
    return { engine: 'none', accent: s.accent, rate: s.rate, note: plan.why || note, trace: run.trace }
  }

  /** 上一次朗读的账本 —— 设置页那一行「走了谁、为什么」读它 */
  private lastTrace: VoiceTrace | null = null
  lastVoiceTrace(): VoiceTrace | null {
    return this.lastTrace
  }

  /**
   * 把账本写成 `nyx.log` 里的一行。格式：
   *
   *   [voice] 读了 word → 词典语音 42ms · 序列 dictionary → system
   *   [voice] 读了 word → 系统语音 8ms · 序列 dictionary → system · dictionary：这本词典里没有这个词的发音
   *   [voice] 读了 word → 没读 0ms · 序列（空）· dictionary：你把它关了 · system：你把它关了
   *
   * ★ **写不出来不影响出声**：账本是诊断，不是判据。
   */
  private writeTrace(t: VoiceTrace): void {
    if (!this.log) return
    const steps = t.steps.map((x) => `${x.source}：${x.reason}`).join(' · ')
    try {
      this.log(
        'info',
        'voice',
        `读了 ${t.kind} → ${t.spoke ? SOURCE_LABEL[t.spoke] : '没读'} ${t.ms}ms` +
          ` · 序列 ${t.planned.join(' → ') || '（空）'}` +
          `${steps ? ` · ${steps}` : ''}`
      )
    } catch {
      /* 日志写不出来不能因此让他听不到声 */
    }
  }
}
