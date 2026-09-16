/**
 * 朗读两档 · Android 两个执行器（D-466）
 *
 * ★★ 这组用例盯的是**「顺序只有一份」这件事本身**，不是某一次读得响不响。
 *
 * 以前三条路各自决定顺序（App 缓存→系统 · 引擎 词典→缓存→系统 · Windows 系统/云）。
 * 三份判据的症状不是「读错了」，是**改一处只修好一条路**。
 * 所以这里每一条都可以这样读：**把它弄红的唯一办法，就是重新长出第二份顺序。**
 *
 * 判据一个字都不在这个文件里 —— 顺序来自 `core/voice/resolve.ts`，
 * 预算来自 `core/voice/run.ts`，两把开关与写死的先后在 `db/voice.ts`。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  dictionaryStep,
  loadSwitches,
  runVoice,
  setSwitch,
  systemStep,
  type VoiceHave,
  type VoiceOutcome,
  type VoiceSteps
} from '../src/db/voice.ts'
import {
  BOTH_OFF_SAYS,
  DICTIONARY_BUDGET_MS,
  unplayableDictSays,
  type VoiceRunResult
} from '../src/core-link.ts'
import { appAvailability, ttsPrefs } from '../src/db/tts.ts'
import { dropDictCache, scanDictFolder, setDictIoProvider, type FolderFile } from '../src/db/dict.ts'
import { writeMdx } from '../nyx-core/tests/make-mdx.ts'
import { builtDb, cleanup } from './helpers.ts'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'nyx-voice-'))
after(() => {
  dropDictCache()
  setDictIoProvider(null)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录 */
  }
  cleanup()
})

/**
 * ★★ I-165 的两本夹具 —— **照真机那本抄形状**（LDOCE5 的词头音就是 `GB_*.spx`）。
 *
 *   spx    只有 `.spx`：词条**有**发音，浏览器一条都放不响
 *   mixed  英音 `.spx` + 美音 `.ogg`：他要的那一档放不响，另一档放得响
 */
function book(base: string, body: string, volKeys: [string, string][]): FolderFile[] {
  writeMdx(join(dir, `${base}.mdx`), [{ word: 'serendipity', body }], {
    title: base,
    version: '2.0',
    encoding: 'UTF-8'
  })
  writeMdx(
    join(dir, `${base}.1.mdd`),
    volKeys.map(([k, v]) => ({ word: k, body: v })),
    { title: 'vol', version: '2.0', encoding: 'UTF-16' }
  )
  return [
    { name: `${base}.mdx`, uri: join(dir, `${base}.mdx`), size: 0 },
    { name: `${base}.1.mdd`, uri: join(dir, `${base}.1.mdd`), size: 0 }
  ]
}

const SPX = book(
  'spx',
  '<a href="sound://hwd/bre/9/GB_serendipity.spx">uk</a> serendipity',
  [['\\hwd\\bre\\9\\GB_serendipity.spx', 'FAKE-SPEEX']]
)
const MIXED = book(
  'mixed',
  '<a href="sound://hwd/bre/9/GB_serendipity.spx">uk</a>' +
    '<a href="sound://hwd/ame/1/US_serendipity.ogg">us</a> serendipity',
  [
    ['\\hwd\\bre\\9\\GB_serendipity.spx', 'FAKE-SPEEX'],
    ['\\hwd\\ame\\1\\US_serendipity.ogg', 'FAKE-OGG']
  ]
)

/** 与真机唯一的差别就是字节从哪来（那边 SAF content://，这里 fs）—— 同 DT-6 那一条 */
const fsIo = (uri: string) => ({
  open: (path: string) => ({ path, size: statSync(uri).size }),
  read: (_h: { path: string; size: number }, at: number, len: number) => {
    const fd = openSync(uri, 'r')
    try {
      const b = Buffer.alloc(len)
      const n = readSync(fd, b, 0, len, at)
      return new Uint8Array(b.subarray(0, n))
    } finally {
      closeSync(fd)
    }
  },
  close: () => {}
})

/** 两端都报「什么都在」时的事实 —— 用来证明同样的输入走出同样的序列 */
const ALL_ON: VoiceHave = { dictionary: true, system: true }

const P = { accent: 'en-GB', rate: 1 }

const audio = (b64: string): VoiceOutcome => ({ kind: 'audio', b64, mime: 'audio/mpeg' })
const order = (r: VoiceRunResult<VoiceOutcome>): string[] =>
  r.tried.map((t) => `${t.source}:${t.outcome}`)

/**
 * 造一个执行器的步骤表。两个执行器的两步现在**写法完全一样**
 * （以前不一样的只有缓存那一步的取字节方式，那一档随云端一起退了）。
 */
function stepsOf(hits: { dictionary?: boolean }): VoiceSteps {
  return {
    dictionary: () => Promise.resolve(hits.dictionary ? audio('DICT') : null),
    system: systemStep(P)
  }
}

describe('V · 朗读两档 · Android 执行器', () => {
  it('V-1 · 出厂两档都开：词典有音 → 词典音；两个执行器同一个序列', async () => {
    const f = builtDb()
    const app = await runVoice(f.db, 'stairwell', ALL_ON, stepsOf({ dictionary: true }))
    const engine = await runVoice(f.db, 'stairwell', ALL_ON, stepsOf({ dictionary: true }))

    assert.deepEqual(
      app.plan.attempts.map((a) => a.source),
      ['dictionary', 'system'],
      '写死的先后：词典在前、系统兜底'
    )
    assert.deepEqual(
      engine.plan.attempts.map((a) => a.source),
      app.plan.attempts.map((a) => a.source),
      '★ 两个执行器的序列必须逐项相同 —— 不同就说明谁又自己排了一遍'
    )
    assert.equal(app.result.source, 'dictionary', '★ 词典有音就该是它出的声')
    assert.deepEqual(order(app.result), ['dictionary:hit'])
    assert.deepEqual(order(engine.result), order(app.result))
  })

  it('V-2 · 词典没有这个词 → 系统音兜底', async () => {
    const f = builtDb()
    const r = await runVoice(f.db, 'stairwell', ALL_ON, stepsOf({}))
    assert.equal(r.result.source, 'system')
    assert.deepEqual(order(r.result), ['dictionary:miss', 'system:hit'])
  })

  it('V-3 · 预算：词典那一步卡住，系统音照样出声（不是等它）', async () => {
    const f = builtDb()
    const started = Date.now()
    const r = await runVoice(f.db, 'stairwell', ALL_ON, {
      // ★ 永不 resolve —— 真机上就是「一次全词典扫描」那一下
      dictionary: () => new Promise<VoiceOutcome | null>(() => undefined),
      system: systemStep(P)
    })
    const ms = Date.now() - started
    assert.equal(r.result.source, 'system', '★ 这条红了 = 慢查又把后面全堵住了')
    assert.equal(r.result.tried[0]?.outcome, 'timeout')
    assert.ok(
      ms < DICTIONARY_BUDGET_MS * 6,
      `不该等到天荒地老（等了 ${ms} ms，预算 ${DICTIONARY_BUDGET_MS} ms）`
    )
  })

  it('V-4 · 出厂两把开关都开着（他没设过 = 都开）', async () => {
    const f = builtDb()
    assert.deepEqual(await loadSwitches(f.db), { dictionary: true, system: true })
  })

  it('V-5 · 开关落库来回：关掉词典 → 直接系统音，而且**读回来还是关着**', async () => {
    const f = builtDb()
    const back = await setSwitch(f.db, 'dictionary', false)
    assert.deepEqual(back, { dictionary: false, system: true }, '★ 返回的是落库之后读回来的那一份')
    assert.deepEqual(
      await loadSwitches(f.db),
      { dictionary: false, system: true },
      '★★ 只改内存不落库的话，这里会读回「开着」—— 他关掉的东西下次开机又回来了'
    )
    /**
     * ★★★ 负向对照的落点：词典里**有**这个词（dictionary 步会命中），
     *   但他把词典音关了。任何绕过序列的近路都会在这里拿到 DICT 而不是走到 system。
     */
    const r = await runVoice(f.db, 'stairwell', ALL_ON, stepsOf({ dictionary: true }))
    assert.deepEqual(r.plan.attempts.map((a) => a.source), ['system'], '关掉的那一档不排进序列')
    assert.equal(r.result.source, 'system', '★ 拿到词典音就说明有人又抄了近路')
    assert.ok(!order(r.result).some((x) => x.startsWith('dictionary')), '账上也不该有词典那一步')

    // 再翻回来 —— 开关是双向的，不是一次性的
    assert.deepEqual(await setSwitch(f.db, 'dictionary', true), { dictionary: true, system: true })
  })

  it('V-6 · 两个都关 → 一步都不排，说一句人话（不静默、不偷偷出声）', async () => {
    const f = builtDb()
    await setSwitch(f.db, 'dictionary', false)
    await setSwitch(f.db, 'system', false)
    const r = await runVoice(f.db, 'stairwell', ALL_ON, stepsOf({ dictionary: true }))
    assert.equal(r.plan.attempts.length, 0)
    assert.equal(r.result.source, null, '★ 两个都关还出声 = 他的开关是假的')
    /**
     * ★★ 话术**逐字来自 core**（`BOTH_OFF_SAYS`），平台一个字都不拼。
     *   两个都关和「这台机器上一个来源都用不了」是两件事，说成一句的话
     *   他会去找一个不存在的毛病 —— 所以这里钉的是**那一句**，不是「包含某几个字」。
     */
    assert.equal(r.plan.why, BOTH_OFF_SAYS, '话术来自 core，不在平台层拼')
    assert.deepEqual(
      r.plan.skipped.map((s) => `${s.source}:${s.why}`),
      ['dictionary:你把它关了', 'system:你把它关了'],
      '★ 要说清是**他关的**，不是「这台机器不行」'
    )
  })

  it('V-7 · 能不能跑是事实，压过偏好：词典通道没挂上就不问词典', async () => {
    const f = builtDb()
    let asked = 0
    const r = await runVoice(
      f.db,
      'stairwell',
      { dictionary: false, system: true },
      {
        dictionary: () => {
          asked++
          return Promise.resolve(audio('DICT'))
        },
        system: systemStep(P)
      }
    )
    assert.equal(asked, 0, '★ 报了「用不了」还去问，就是白花 150 ms 预算')
    assert.deepEqual(r.plan.attempts.map((a) => a.source), ['system'])
    assert.equal(r.result.source, 'system')
  })

  it('V-8 · kind 分流：整段不问词典（词典里只有词头键）', async () => {
    const f = builtDb()
    const long = 'This is a whole paragraph that nobody would ever look up in a dictionary.'
    const r = await runVoice(f.db, long, ALL_ON, stepsOf({ dictionary: true }), { kind: 'passage' })
    assert.deepEqual(r.plan.attempts.map((a) => a.source), ['system'], 'passage 不该进词典那一步')
    assert.equal(r.result.source, 'system')
  })

  it('V-9 · 词典那一步走的是 dict.ts 那一份（没有词典就 miss，不炸）', async () => {
    const f = builtDb()
    // 一本词典都没装：dictPronounce 会如实返回 null（没有 ioProvider 时也是）
    const r = await runVoice(f.db, 'stairwell', ALL_ON, {
      dictionary: dictionaryStep(f.db, P),
      system: systemStep(P)
    })
    assert.equal(r.result.tried[0]?.source, 'dictionary')
    assert.ok(
      r.result.tried[0]?.outcome === 'miss' || r.result.tried[0]?.outcome === 'timeout',
      '没有词典 = 没有现成的，不是错'
    )
    assert.equal(r.result.source, 'system', '照样出声')
  })

  it('V-10 · 账本连**被跳过的**一起讲（tried 里没有它们 —— 这就是要补的那个洞）', async () => {
    const f = builtDb()
    await setSwitch(f.db, 'dictionary', false)
    const r = await runVoice(f.db, 'stairwell', ALL_ON, stepsOf({ dictionary: true }))

    assert.equal(r.result.source, 'system', '兜底照样出声')
    assert.ok(
      !r.result.tried.some((t) => t.source === 'dictionary'),
      'tried 里本来就不会有它 —— 所以只看 tried 答不出「为什么没用词典音」'
    )
    const sk = r.result.trace.steps.find((x) => x.source === 'dictionary')
    assert.ok(sk, '★★ 账本里必须有它 —— 设置页那一行读的就是它')
    assert.equal(sk.outcome, 'skipped')
    assert.ok(sk.reason.includes('你把它关了'), `★ 跳过要说得出为什么：${sk.reason}`)
    assert.equal(r.result.trace.spoke, 'system', '账本要记下**实际出声的**是谁')
  })

  it('V-11 · App 执行器**自己探**词典通道：memory → 不问词典，random → 问', async () => {
    /**
     * ★★ 主控 2026-09-06 的负向对照发现的洞：把 `dictionaryAvailable()` 改成恒 `true`
     *   （通道没挂上也说有）→ **244/244 全绿**。因为上面每一条 V-* 喂给 resolver 的
     *   都是**自己造的**事实对象，没有一条走 App 执行器自己的探测。
     *
     * ★ 探的是 `globalThis.nyxDb.dictIo`（`random` = 真随机读通道挂上了）。
     *   报错了的代价不是「读不出来」而是**白花 150 ms 预算**。
     */
    const g = globalThis as unknown as Record<string, unknown>
    const keep = g['nyxDb']
    try {
      g['nyxDb'] = { dictIo: 'memory' }
      assert.equal(
        appAvailability().dictionary,
        false,
        '★★ 通道没挂上却报有 —— 每次朗读都要白等一次 150 ms 预算'
      )
      const f1 = builtDb()
      const r1 = await runVoice(f1.db, 'stairwell', appAvailability(), stepsOf({}))
      assert.ok(
        !r1.plan.attempts.some((a) => a.source === 'dictionary'),
        '★ 用不了的那一档不该排进序列'
      )

      g['nyxDb'] = { dictIo: 'random' }
      assert.equal(appAvailability().dictionary, true, '通道挂上了就要报有')
      const f2 = builtDb()
      const r2 = await runVoice(f2.db, 'stairwell', appAvailability(), stepsOf({}))
      assert.ok(
        r2.plan.attempts.some((a) => a.source === 'dictionary'),
        '★ 通道在就该问词典 —— 否则真人音永远轮不上'
      )
      assert.equal(appAvailability().system, true, '系统音是这个执行器的常量事实')
    } finally {
      if (keep === undefined) delete g['nyxDb']
      else g['nyxDb'] = keep
    }
  })

  it('V-12 · 偏好只剩两项，默认与夹取与 Windows 同源', async () => {
    const f = builtDb()
    assert.deepEqual(await ttsPrefs(f.db), { accent: 'en-GB', rate: 1 })
  })

  it('V-13 · 两个执行器交出去的**就是这两步**（读源码文本问的，硬闸）', () => {
    /**
     * ★★★ 为什么要读源码：上面每一条 V-* 喂的都是**用例自己造的**步骤表，
     *   所以「App 执行器 / 引擎执行器实际把哪几步交给 core」这件事，
     *   在这个文件里一条都没验到。P-17（已删的那条闸）当年守的正是这半边：
     *   它是**读源码文本**问「这一端接了哪几家」的。两档之后那条闸的对象没了，
     *   但那半边的洞还在 —— 引擎那一侧少交一步的症状不是报错，
     *   是**词典 miss 之后什么都没发生**，而 App 那一侧一切正常。
     *
     * ★ 它宁可炸也不肯绿着什么都没验：文件读不到 / 找不到那一段就当场失败。
     */
    const both: [string, string][] = [
      ['App 执行器', 'src/db/tts.ts'],
      ['Assist 引擎执行器', 'src/engine/main.ts']
    ]
    for (const [who, file] of both) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      const steps = [...src.matchAll(/^\s+(dictionary|system): (dictionaryStep|systemStep)\(/gm)].map(
        (m) => `${m[1]}=${m[2]}`
      )
      assert.deepEqual(
        steps,
        ['dictionary=dictionaryStep', 'system=systemStep'],
        `★★ ${who}（${file}）交给 core 的步骤表不是「词典 + 系统」两步 —— ` +
          '少一步 = 那一档在这一端永远轮不上，而另一端一切正常'
      )
    }
  })

  it('V-14 · 全是放不响的（.spx）→ 词典那一步 miss，账本说的是**真话**（I-165）', async () => {
    /**
     * ★★★ 这一条守的是「账本不许说假话」。
     *
     * LDOCE5 的词头音是 `GB_serendipity.spx`（Speex），Chromium 没有这个解码器。
     * 不挡的后果不是「没声音」那么简单：词典那一步报 **hit**、账本写「词典语音出的声」，
     * 而渲染层 `play()` 抛了、他实际听到的是系统音 —— **两句话对不上，谁也没报错**。
     *
     * ★ 所以这里钉三件：① 那一步是 miss 不是 hit；② 兜底真的出声（系统音）；
     *   ③ 理由说得出**是什么格式**（core 的 `unplayableDictSays`，与 Windows 同一句）——
     *   说成「这本词典里没有这个词的发音」他会去换一个词，而该做的是换一本词典。
     */
    const f = builtDb()
    // ★ io 要在**扫描之前**装上：scanDictFolder 也靠它解析（不然书登记成 status=error）
    setDictIoProvider(fsIo)
    try {
      await scanDictFolder(f.db, SPX)
      const r = await runVoice(f.db, 'serendipity', ALL_ON, {
        dictionary: dictionaryStep(f.db, P),
        system: systemStep(P)
      })
      const step = r.result.trace.steps.find((x) => x.source === 'dictionary')
      assert.equal(step?.outcome, 'miss', '★★ 报了 hit = 那道挡没了，账本又开始说假话')
      assert.equal(
        step?.reason,
        unplayableDictSays(['hwd/bre/9/GB_serendipity.spx']),
        '★ 理由要说得出是什么格式（话术在 core，两端同一句）'
      )
      assert.equal(r.result.source, 'system', '兜底照样出声')
      assert.equal(r.result.value?.kind, 'system')
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('V-15 · 混着时只挑放得响的那一条，mime 按扩展名算（不再写死 audio/mpeg）', async () => {
    /**
     * 他要的是英音，而这本的英音是 `.spx`、美音是 `.ogg`：
     * **挡在挑口音之前**，所以拿到的是美音那条（真人音错口音也比没有强，
     * 那是 `dictPronounce` 一直以来的判据）。
     * ★ 顺序反过来（先挑口音再挡）就会「挑中英音的 .spx 然后静悄悄失败」——
     *   那正是这条要拦的事。
     */
    const f = builtDb()
    setDictIoProvider(fsIo)
    try {
      await scanDictFolder(f.db, MIXED)
      const r = await runVoice(f.db, 'serendipity', ALL_ON, {
        dictionary: dictionaryStep(f.db, P), // P.accent = en-GB，他要英音
        system: systemStep(P)
      })
      assert.equal(r.result.source, 'dictionary', '★ 放得响的那条还在，就该用它')
      assert.equal(r.result.value?.kind, 'audio')
      assert.equal(
        r.result.value?.kind === 'audio' ? r.result.value.from : null,
        'ame',
        '英音放不响 → 退到美音（不是退到系统音）'
      )
      assert.equal(
        r.result.value?.kind === 'audio' ? r.result.value.mime : null,
        'audio/ogg',
        '★★ mime 按这条链接算（core 的 dictMimeOf）—— 写死 audio/mpeg 时 .ogg 全靠浏览器猜'
      )
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

})
