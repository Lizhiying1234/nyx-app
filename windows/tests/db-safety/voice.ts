/**
 * 语音执行器 · 走真主进程的那一半 · D-466（使用者 2026-09-07「语音设置简化」）
 *
 * core 用例（`src/core/voice/voice.test.ts`）验的是判据；这里验的是**接起来之后**：
 * 一次真的 `Tts.speak()` / `Tts.save()`，两把开关真的落进偏好表、真的读得回来，
 * 词典那一步真的取到了字节，两个都关时真的不出声而且说得出话。
 *
 * ── 这一段原来有多少东西 ────────────────────────────────────
 *
 * 上一版是 1450 行：一台只会回 JSON 的假 TTS 服务器（T-9.8 的四种故障夹具）、
 * 云端失败退系统音、D-R26「开着 = 轮到就用」、旧云端槽归家的一次性迁移
 * （I-156 的三张脸）、缓存命中、预算超时、按提供者分家的地址与凭据……
 * D-466 把云端与多厂商整条撤了，那些用例守的功能已经不存在 ——
 * **守一个不存在的功能的闸，只会在下一次重构时被人当噪音绕过去**，所以一起删。
 *
 * 留下来的四件，正是使用者定的那四句（D-466）。
 */

import { app } from 'electron'
import { openDatabase } from '../../src/main/db/open.ts'
import { Tts } from '../../src/main/tts.ts'
import { Prefs } from '../../src/main/db/prefs.ts'
import { BOTH_OFF_SAYS } from '../../src/core/voice/resolve.ts'
import { assert, checkAsync, freshDir } from './harness.ts'

console.log('\nD-466 · 语音两档（词典语音 · 系统语音）\n')

/** 一段假的 mp3 字节 —— 只要「取到了、而且就是这一段」看得出来就够 */
const FAKE_GB = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x67, 0x62])
const FAKE_US = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x75, 0x73])

/**
 * ★★★ 六行的替身 —— 判据（`pickDictAudio`）与取字节这两段**都真的跑**。
 *
 * ★ 为什么不用一本真词典：`makeBook` 造出来的是纯 mdx，**没有 .mdd**，
 *   也就没有发音资源；那样这条只能断言「miss」，而 miss 和「执行器压根没接」
 *   长得一模一样 —— 拆掉执行器它照样绿。（不是假设：第一版就是那么写的，
 *   负向对照当场证明它测不出东西。）
 */
function withDict(tts: Tts, asked: string[] = []): string[] {
  tts.useDictionaries({
    card: (w) => {
      asked.push(w)
      return { refs: { audio: ['book-uid|w__us_1.mp3', 'book-uid|w__gb_1.mp3'] } }
    },
    resource: async (_uid, key) => (key.includes('gb') ? FAKE_GB : FAKE_US)
  })
  return asked
}

// ══════════════════════════════════════════════════════════════
checkAsync('★★★ D-466 · 两把开关：save → settings 来回，一把都不许丢', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)
  const prefs = new Prefs(r.db)

  // ① 出厂：两把都开，而且**库里一行都还没有**（默认值来自 core，不是靠先写一遍库）
  const first = tts.settings()
  assert(first.dictionary === true && first.system === true, '★★★ 出厂该是两个都开')
  assert(
    prefs.raw('tts.dictionary') === null && prefs.raw('tts.system') === null,
    '★★ 还没保存过就往库里写了 —— 那份「默认」从此说不清是他选的还是软件写的'
  )

  /**
   * ② 一把一把地存，**每一把都单独验一次来回**。
   *
   * ★ 为什么要逐把验、还要验「另一把没跟着变」：少存一把的表现是
   *   「那个开关按下去、回读还是旧值 —— 看起来永远按不动」，
   *   而两把混在一次断言里的话，只存对一把也能凑出一个「变了」。
   *   T-7.10 的负向对照 ③ 就是拆掉 `tts:save` 里的一句 `prefs.set`。
   */
  for (const [off, other] of [
    ['dictionary', 'system'],
    ['system', 'dictionary']
  ] as const) {
    tts.save({ ...tts.settings(), [off]: false })
    let back = tts.settings()
    assert(back[off] === false, `★★★ ${off} 关了存不进去 —— 那个开关看起来永远按不动`)
    assert(back[other] === true, `★★★ 存 ${off} 顺手把 ${other} 也写了 —— 一次点击改了两件事`)
    assert(prefs.raw(`tts.${off}`) === '0', `★★ ${off} 没落在偏好表里（它要跟着人走）`)

    tts.save({ ...tts.settings(), [off]: true })
    back = tts.settings()
    assert(back[off] === true, `★★★ ${off} 再打开又打不开了`)
  }

  // ③ 口音与语速走同一口，一起验一次（D-040 · 0.7–1.3× 在这里夹）
  tts.save({ ...tts.settings(), accent: 'en-US', rate: 9 })
  const back = tts.settings()
  assert(back.accent === 'en-US', '★★ 口音没存上')
  assert(back.rate === 1.3, `★★ 语速没夹在 0.7–1.3：${back.rate}`)
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
checkAsync('★★★ D-466 · 词典有这个词的音 → **真的取到字节**，口音说了算', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)

  const before = await tts.speak('serendipity')
  assert(
    !(before.trace?.planned ?? []).includes('dictionary'),
    '★★ 前提：没交词典进去时，这一步不该进序列'
  )
  assert(before.engine === 'system', `★★ 没有词典层就该走系统音，实际 ${before.engine}`)

  const asked = withDict(tts)
  const out = await tts.speak('serendipity')
  assert(out.engine === 'dictionary', `★★★ 词典有这段音却没用上：${out.engine}`)
  assert(asked[0] === 'serendipity', `★★ 问词典问的不是这个词：${asked.join(',')}`)
  /**
   * ★★ 口音说了算：出厂口音是 en-GB，所以取的必须是 `__gb_1` 那一条。
   *   取错的表现是「听到的是美音」—— 他一耳朵能发现，而**没有任何东西会报错**。
   */
  assert(out.data === FAKE_GB.toString('base64'), '★★★ 取的不是英音那一条 —— 口音设置形同虚设')
  const step = out.trace?.steps.find((x) => x.source === 'dictionary')
  assert(step?.outcome === 'hit', `★★ 账本没记成命中：${step?.outcome} · ${step?.reason}`)

  // 切成美音 —— 同一个词该换成另一条
  tts.save({ ...tts.settings(), accent: 'en-US' })
  const us = await tts.speak('serendipity')
  assert(us.data === FAKE_US.toString('base64'), '★★★ 切了美音还是那一条英音')
  r.db.close()
})

checkAsync('★★★ T-7.12（I-165）· 发音是 Speex → 不许记成词典出声，系统音接上且账写真话', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)

  /**
   * ★ LDOCE5 词头音的真实形状（A 2026-09-07 在他真库上量的：字节是 `OggS`，
   *   `canPlayType('audio/ogg; codecs=speex')` 回空串 —— 换 MIME 也放不出来）。
   * ★ `resource` 故意**真的给得出字节** —— 这一条要证明的正是
   *   「取得到 ≠ 放得响」：以前这一趟会报 hit，日志写「词典语音出的声」，
   *   而他实际听到的是渲染层保命兜底读出来的系统音。
   */
  const BS = String.fromCharCode(92)
  let askedResource = 0
  tts.useDictionaries({
    card: () => ({ refs: { audio: [`book-uid|${BS}gb_ld41serendipity.spx`] } }),
    resource: async () => {
      askedResource += 1
      return Buffer.from([0x4f, 0x67, 0x67, 0x53])
    }
  })

  const out = await tts.speak('serendipity')
  assert(out.engine === 'system', `★★★ Speex 被当成了词典音（engine=${out.engine}）`)
  assert(askedResource === 0, '★★ 放不响的那条压根不该去取字节 —— 白解一次 .mdd')
  const step = out.trace?.steps.find((x) => x.source === 'dictionary')
  assert(step?.outcome === 'miss', `★★★ 该记成 miss，实际 ${step?.outcome}`)
  assert(
    /\.spx/.test(step?.reason ?? ''),
    `★★★ 账本没说清是什么格式，他会以为是这个词没发音：「${step?.reason}」`
  )
  r.db.close()
})

checkAsync('★★ T-7.12 · 放得响的那条：真实 MIME 跟着字节一起交给界面', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)
  const BS = String.fromCharCode(92)
  tts.useDictionaries({
    card: () => ({ refs: { audio: [`book-uid|${BS}gb_x.ogg`] } }),
    resource: async () => FAKE_GB
  })

  const out = await tts.speak('serendipity')
  assert(out.engine === 'dictionary', `★★ .ogg 是放得响的，该走词典音：${out.engine}`)
  /**
   * ★★★ 以前渲染层写死 `data:audio/mpeg` —— 一段 ogg 贴上 mpeg 的标签，
   *   浏览器直接拒掉，而拒掉的样子和「这个词没有发音」一模一样。
   */
  assert(out.mime === 'audio/ogg', `★★★ MIME 不是真实的那个：${out.mime}`)
  r.db.close()
})

checkAsync('★★★ D-466 · 词典里没有这个词 → **miss，不是错**，系统音接上', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)
  tts.useDictionaries({ card: () => ({ refs: { audio: [] } }), resource: async () => null })

  const out = await tts.speak('serendipity')
  const step = out.trace?.steps.find((x) => x.source === 'dictionary')
  assert(step?.outcome === 'miss', `★★★ 查不到该是 miss（不是错、不是 no-handler）：${step?.outcome}`)
  assert(out.engine === 'system', `★★ 词典没命中就该往下走到系统音，实际 ${out.engine}`)
  assert(
    (step?.reason ?? '').length >= 3 && !/^[\d\s.,:ms]+$/.test(step?.reason ?? ''),
    `★★ 账本说不出为什么没用词典音：「${step?.reason}」`
  )
  r.db.close()
})

checkAsync('★★★ T-7.13（I-166）· 索引还没好 → 词典步当场 miss，≤ 150 ms 落系统音', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)

  /**
   * ★★★ 这一条盯的是**同步阻塞**那件事。
   *
   * `card()` 是同步的：那本词典没开过时它要先建索引（真库上 8963 / 14637 ms）。
   * 同步代码堵住事件循环，`runVoicePlan` 那 150 ms 的预算连计时器都轮不上 ——
   * **预算写了等于没写**。所以判据是「先问 `ready()`，没好就一次都不问词典」。
   *
   * ★ 替身里 `card()` 故意**同步睡 400 ms**：真在这条路上被调到的话，
   *   下面那句 `ms < 150` 一定红 —— 而这正是他冷启动后等的那几秒的小样。
   */
  let cardCalls = 0
  tts.useDictionaries({
    ready: () => ({ ok: false, why: '「牛津高阶」还在建索引，这次先用系统语音' }),
    card: () => {
      cardCalls += 1
      const until = Date.now() + 400
      while (Date.now() < until) {
        /* 同步空转 —— 模拟一次冷开索引 */
      }
      return { refs: { audio: ['book-uid|w__gb_1.mp3'] } }
    },
    resource: async () => FAKE_GB
  })

  const out = await tts.speak('serendipity')

  assert(cardCalls === 0, `★★★ 索引没好还是去问了词典（${cardCalls} 次）—— 他就是这么等掉那几秒的`)
  assert(out.engine === 'system', `★★ 没好就该立刻走系统音，实际 ${out.engine}`)
  const step = out.trace?.steps.find((x) => x.source === 'dictionary')
  /**
   * ★★★ 判据是**结构性**的（`cardCalls === 0`），不是计时的 —— 而且更强。
   *
   * T-7.13 的完成标准写的是「词典步 ≤ 150 ms 内返回 miss」。**这一套里量不了时间**：
   * `checkAsync` 的身体在每个 await 处互相穿插着跑（见 `harness.ts`），
   * 别的用例的同步活儿会算进这一步的毫秒里 —— 实测这一步什么都没做，
   * 账上仍是 265 ms（整趟墙钟 287 ms）。拿它当判据会偶发地红，
   * 而偶发红的闸最后都会被人当噪音绕过去。
   *
   * 「一次都没去问词典」比「这次花了几毫秒」更强：`card()` 是那 9 秒的**唯一**来源，
   * 没调它就不可能慢。计时那一面由预算本身的用例守着（`voice.test.ts` 里
   * 「词典永远不返回 → 到点就走」那条，判据是 core 的 `DICTIONARY_BUDGET_MS`）。
   */
  assert(step?.outcome === 'miss', `★★ 该记成 miss，实际 ${step?.outcome}`)
  assert(
    /建索引/.test(step?.reason ?? ''),
    `★★ 账本没说清是「还在建索引」，他会以为这个词没发音：「${step?.reason}」`
  )
  r.db.close()
})

checkAsync('★★★ T-7.13 · 索引好了 → 照样命中词典音（这道闸不许把词典音判没了）', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)
  let cardCalls = 0
  tts.useDictionaries({
    ready: () => ({ ok: true }),
    card: () => {
      cardCalls += 1
      return { refs: { audio: ['book-uid|w__gb_1.mp3'] } }
    },
    resource: async () => FAKE_GB
  })

  const out = await tts.speak('serendipity')
  assert(cardCalls === 1, `★★ 索引好了就该问词典，实际问了 ${cardCalls} 次`)
  assert(out.engine === 'dictionary', `★★★ 索引好了却没用词典音：${out.engine}`)
  assert(out.data === FAKE_GB.toString('base64'), '★★ 取回来的不是那段字节')
  r.db.close()
})

checkAsync('★★★ D-466 · 词典关着 → **直接系统音**，词典层一次都不问', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)
  const asked = withDict(tts)
  tts.save({ ...tts.settings(), dictionary: false })

  const out = await tts.speak('serendipity')
  assert(out.engine === 'system', `★★★ 词典关着还是走了词典：${out.engine}`)
  assert(
    asked.length === 0,
    `★★★ 关着还去问了词典 ${asked.length} 次 —— 关掉它的意义有一半是「别去扫词典」`
  )
  const step = out.trace?.steps.find((x) => x.source === 'dictionary')
  assert(step?.outcome === 'skipped', `★★ 账本没记成跳过：${step?.outcome}`)
  assert(/关了/.test(step?.reason ?? ''), `★★ 没说清是他关的：「${step?.reason}」`)
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
checkAsync('★★★ D-466 · 两个都关 → 一声不出，但**说得出那句话**（不是静默）', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)
  withDict(tts)
  tts.save({ ...tts.settings(), dictionary: false, system: false })

  const out = await tts.speak('serendipity')
  /**
   * ★★★ `engine: 'none'` 是判据本身：渲染层看到它就**不出声**。
   *   这里如果回 `system`，`speak.ts` 会照旧用浏览器的语音合成读出来 ——
   *   他关掉了系统语音却照样听见系统语音，那两个开关就白拨了。
   */
  assert(
    out.engine === 'none',
    `★★★ 两个都关了还回 ${out.engine} —— 渲染层会照样读出来，开关白拨`
  )
  assert(!out.data, '★★★ 两个都关了却带回了音频字节')
  assert(out.note === BOTH_OFF_SAYS, `★★★ 那句话不对：「${out.note}」`)
  assert(/两个开关都关着/.test(out.note ?? ''), '★★★ 没说清是「两个开关都关着」')
  assert(/设置/.test(out.note ?? ''), '★★ 没告诉他去哪儿打开')
  assert(out.trace?.spoke === null, '★★ 账本说有人出声了')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
checkAsync('★★ D-466 · 每次朗读落一行 `nyx.log`（D-219：他能贴给我看）', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const lines: string[] = []
  const tts = new Tts(r.db, (_l, where, msg) => lines.push(`[${where}] ${msg}`))

  // ① 词典音那一趟
  withDict(tts)
  await tts.speak('serendipity')
  // ② 系统音那一趟（词典关掉）
  tts.save({ ...tts.settings(), dictionary: false })
  await tts.speak('serendipity')
  // ③ 一声都不出那一趟
  tts.save({ ...tts.settings(), system: false })
  await tts.speak('serendipity')

  assert(lines.length === 3, `★★ 三次朗读该落三行账，实际 ${lines.length} 行`)
  for (const l of lines) {
    assert(l.startsWith('[voice] '), `★★ 账没落在 voice 这一支笔下：${l}`)
    assert(l.includes('序列'), `★★ 那一行看不出排了什么顺序：${l}`)
  }
  assert(/词典语音/.test(lines[0] ?? ''), `★★ 第一趟该是词典语音出的声：${lines[0]}`)
  assert(/系统语音/.test(lines[1] ?? ''), `★★ 第二趟该是系统语音出的声：${lines[1]}`)
  assert(/没读/.test(lines[2] ?? ''), `★★ 第三趟一声都没出，账上该写「没读」：${lines[2]}`)
  /** ★ 一行，不是一堆 —— 他要的是能贴给我看的东西，不是一份要他自己读的 JSON */
  for (const l of lines) assert(!l.includes('\n'), `★★ 一次朗读落了不止一行：${l}`)
  r.db.close()
})

checkAsync('★★ D-466 · 账本取得回来（设置页那一行诊断读的就是它）', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const tts = new Tts(r.db)
  assert(tts.lastVoiceTrace() === null, '★ 还没读过就不该有账')
  await tts.speak('serendipity')
  const t = tts.lastVoiceTrace()
  assert(!!t, '★★ 读完了却取不到账本 —— 设置页那一行就没得显示')
  assert(t!.spoke === 'system', `★★ 账上说是 ${t!.spoke} 出的声`)
  assert(t!.kind === 'word', '★ kind 没记对')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
checkAsync('★★★ D-466 · 退役的那些键：**代码不再写它们，库里那几行不动**（D-216）', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()

  /**
   * 他升级前那台机器上真有的东西：`settings` 里的地址与凭据、
   * `user_preferences` 里的来源顺序与两把记号。**一个字都不许被动。**
   */
  const put = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value`
  )
  put.run('tts.baseUrl', 'https://texttospeech.googleapis.com/v1', t)
  put.run('tts.key', 'ENCRYPTED-OLD-BLOB', t)
  put.run('tts.google-cloud.model', 'en-US-Neural2-F', t)
  const putPref = r.db.prepare(
    `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)`
  )
  const legacy: [string, string][] = [
    ['tts.sources', '[{"id":"dictionary","on":true}]'],
    ['tts.sourcesEditedAt', String(t)],
    ['tts.sourcesMigratedAt', String(t)],
    ['tts.provider.google-cloud.voice', 'en-US-Neural2-F']
  ]
  /** ★ 直接走 SQL 塞进去 —— `Prefs.set` 现在会拒收它们，这几行只可能是升级前留下的 */
  for (const [k, v] of legacy) putPref.run(`d466-${k}`, k, v, t, t)

  const tts = new Tts(r.db)
  withDict(tts)
  await tts.speak('serendipity')
  tts.save({ ...tts.settings(), dictionary: false, accent: 'en-US' })
  await tts.speak('serendipity')

  const prefs = new Prefs(r.db)
  for (const [key] of legacy) {
    assert(prefs.raw(key) !== null, `★★★ 退役键 ${key} 被删掉了 —— 只增不删（D-216）`)
  }
  assert(
    prefs.raw('tts.sources') === '[{"id":"dictionary","on":true}]',
    '★★★ 退役的 tts.sources 被改写了 —— 代码不该再碰它'
  )
  for (const k of ['tts.baseUrl', 'tts.key', 'tts.google-cloud.model']) {
    assert(
      !!r.db.prepare(`select 1 as x from settings where key = ?`).get(k),
      `★★★ ${k} 被删了 —— 地址与凭据退役只读，不删（D-216 / D-220）`
    )
  }
  /** ★ 反过来也要成立：新的两把开关真的按新键落库了，不是又写回旧键 */
  assert(prefs.raw('tts.dictionary') === '0', '★★ 新开关没落在 tts.dictionary 上')
  r.db.close()
})

checkAsync('★★★ D-466 · 退役键**写不进去了**（白名单拒收，D-220 那两道闸还在）', async () => {
  await app.whenReady()
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const prefs = new Prefs(r.db)
  for (const k of [
    'tts.sources',
    'tts.sourcesEditedAt',
    'tts.sourcesMigratedAt',
    'tts.provider.google-cloud.voice',
    'tts.cloud',
    'tts.model',
    'tts.voice',
    'tts.baseUrl',
    'tts.key'
  ]) {
    let threw = false
    try {
      prefs.set(k, '1')
    } catch {
      threw = true
    }
    assert(threw, `★★★ ${k} 居然还能写进偏好表 —— 它会跟着同步上云`)
  }
  r.db.close()
})
