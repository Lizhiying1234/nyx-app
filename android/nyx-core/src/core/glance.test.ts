import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BLOCKED,
  MAX_CHARS,
  MIN_CHARS,
  judge,
  isCleared,
  judgePoint,
  parseHit,
  parseRect,
  parsePointHit,
  placeLookup,
  parseSelectLine,
  pickOcrRun,
  POINT_MAX_DIST,
  unionRect,
  type GlanceRules,
  type OcrWord
} from './glance.ts'

/**
 * Glance 的判据 · 使用者 2026-09-13
 *
 * ★★ 这一套钉的是**隐私**，不是功能。
 *   零按键意味着他在任何地方选中的任何东西都会经过 `judge()`。
 *   判错一次的后果不是「查词没出来」，是**一段他没打算给 Nyx 的文字被读走了**。
 *   所以这里每一条「不该抓」的用例都比「该抓」的那几条更要紧。
 */

const ON: GlanceRules = { mode: 'glance', blocked: [...DEFAULT_BLOCKED] }
const hit = (text: string, proc = 'msedge', password = false): Parameters<typeof judge>[0] => ({
  text,
  proc,
  password
})

describe('★★★ 不该抓的（这几条是这个功能的代价）', () => {
  it('★★★ 总开关没开 → 一律不抓，而且**默认就是没开**', () => {
    /**
     * ★ 2026-09-14：`'frame'` 那一档没了（使用者：「留 point 和 glance，
     *   原来的 frame 取消」），所以这里只剩 `'off'` 一个值好试。
     *   判据一个字没变：**总开关没开 → 一律不抓**。
     */
    const v = judge(hit('policy'), { mode: 'off', blocked: [] }, null)
    assert.equal(v.take, false, '★★★ 关着居然抓了')
  })

  it('★★★ 来源是密码框 → 不抓', () => {
    const v = judge(hit('hunter2', 'chrome', true), ON, null)
    assert.equal(v.take, false)
    if (!v.take) assert.match(v.why, /密码/)
  })

  it('★★ 黑名单里的程序 → 不抓（大小写不算区别）', () => {
    for (const p of ['1password', '1Password', 'KeePassXC', 'lsass']) {
      const v = judge(hit('something', p), ON, null)
      assert.equal(v.take, false, `★★ 「${p}」里的选中被抓走了`)
    }
  })

  it('★ 太长的不是查词，是复制', () => {
    const v = judge(hit('a'.repeat(MAX_CHARS + 1)), ON, null)
    assert.equal(v.take, false)
    if (!v.take) assert.match(v.why, /太长/)
  })

  it('★ 太短的当没选（拖鼠标带出来的一两个字母）', () => {
    assert.equal(judge(hit('a'), ON, null).take, false)
    assert.equal(judge(hit(' '.repeat(20)), ON, null).take, false)
  })

  it('★ 全中文不触发 —— 这是个英语软件', () => {
    const v = judge(hit('这是一段中文'), ON, null)
    assert.equal(v.take, false)
    if (!v.take) assert.match(v.why, /英文/)
  })

  it('★★ 和上一次一模一样 → 不抓（他只是挪了下鼠标，不是又查了一次）', () => {
    assert.equal(judge(hit('policy'), ON, 'policy').take, false)
    // ★ 折行不算区别：同一段话拖两次，中间的换行可能不一样
    assert.equal(judge(hit('run\ncounter  to'), ON, 'run counter to').take, false)
  })

  it('★ 什么都没有 / 形状不对 → 不抓，也不抛', () => {
    for (const bad of [null, undefined, { proc: 'x' } as never, { text: 42 } as never]) {
      assert.doesNotThrow(() => judge(bad, ON, null))
      assert.equal(judge(bad, ON, null).take, false)
    }
    assert.doesNotThrow(() => judge(hit('policy'), null as never, null))
  })
})

describe('★ 该抓的', () => {
  it('★ 一个普通的英文词', () => {
    const v = judge(hit('policy'), ON, null)
    assert.equal(v.take, true)
    if (v.take) assert.equal(v.text, 'policy')
  })

  it('★ 一个 chunk，折行压成单空格再交出去', () => {
    const v = judge(hit('  run   counter\nto '), ON, null)
    assert.equal(v.take, true)
    if (v.take) assert.equal(v.text, 'run counter to', '★ 不压的话去重会失效，同一个词会连弹两次卡')
    assert.ok(MIN_CHARS < 'run counter to'.length)
  })

  it('★ 中英混排里有英文 → 抓', () => {
    assert.equal(judge(hit('所谓 soft power 是'), ON, null).take, true)
  })

  it('★ 不在名单里的程序照常抓', () => {
    assert.equal(judge(hit('policy', 'notepad'), ON, null).take, true)
  })
})

describe('★ 助手进程吐的那一行', () => {
  it('★ 认得出正常的一行', () => {
    const h = parseHit('{"text":"policy","proc":"MsEdge","password":false}')
    /** ★ 没带 `rect` 的那一行读回来就是 `undefined` —— 调用方退回鼠标位置 */
    assert.deepEqual(h, { text: 'policy', proc: 'msedge', password: false, rect: undefined })
  })

  it('★★ 什么垃圾都不抛 —— 这一路死了他不会知道 Glance 什么时候停的', () => {
    for (const bad of ['', '   ', 'not json', '{', '{"a":1}', '[]', 42, null, undefined, '{"text":5}']) {
      assert.doesNotThrow(() => parseHit(bad))
      assert.equal(parseHit(bad), null, `放进来了：${String(bad)}`)
    }
  })

  it('★ PowerShell 那边可能先吐一堆非 JSON 的杂音，一律当没看见', () => {
    assert.equal(parseHit('== Glance helper started =='), null)
  })
})

describe('★★ 「选中没了」那一行（使用者 2026-09-14：点别处弹窗不消失）', () => {
  it('★ 认得出来', () => {
    assert.equal(isCleared('{"cleared":true}'), true)
  })

  it('★★★ 一次真的选中不许被当成「没了」—— 那会让卡刚弹出来就没', () => {
    assert.equal(isCleared('{"text":"policy","proc":"msedge","password":false}'), false)
  })

  it('★★ 同样什么垃圾都不抛，而且一律算 false', () => {
    for (const bad of ['', '   ', 'not json', '{', '{"a":1}', '[]', 42, null, undefined,
                       '{"cleared":"true"}', '{"cleared":1}']) {
      assert.doesNotThrow(() => isCleared(bad))
      assert.equal(isCleared(bad), false, `当成清空了：${String(bad)}`)
    }
  })
})


/**
 * ══ 指到哪个词就查哪个词 · 判据（使用者 2026-09-14）══════════════
 *
 * 他的原话：「为什么 frame 不能像是手机上面的 assist 一样，精准识别文字……
 * 我不太喜欢框选这个东西」。
 *
 * Android 那边的主路是无障碍树 ＋ 逐字符坐标，OCR 只是兜底；
 * Windows 用 UIA 的 `RangeFromPoint` 做同一件事（在他机器上量过：
 * Edge 里连着六个点给了六个不同且正确的词，点都在词框里）。
 *
 * ★★ 这一组钉的是**两条路不许漂**：划词和指词是两个入口，
 *   但「什么不该读」必须是同一份。少钉一条，某一天其中一条路就会松。
 */
describe('★★★ 指到就查 · 判据', () => {
  /**
   * ★★ 2026-09-14 晚：Point 从「一颗两种模式下都能按的键」**升成了一档模式**。
   *   使用者：「Point 和 Glance 是两种独立的功能，不能同时混在一起。」
   *   所以这一组的「开着」现在是 `point`，不再是 `glance`。
   */
  const ON: GlanceRules = { mode: 'point', blocked: [...DEFAULT_BLOCKED] }
  const GLANCE: GlanceRules = { mode: 'glance', blocked: [...DEFAULT_BLOCKED] }
  const OFF: GlanceRules = { mode: 'off', blocked: [...DEFAULT_BLOCKED] }
  const at = (over: Partial<{ text: string; proc: string; password: boolean; inside: boolean; dist: number }> = {}) => ({
    text: 'policy',
    proc: 'msedge',
    password: false,
    inside: true,
    dist: 0,
    ...over
  })

  it('★ 正常一次：指在词上就查', () => {
    const v = judgePoint(at(), ON)
    assert.equal(v.take, true)
    assert.equal(v.take && v.text, 'policy')
  })

  it('★★★ Assist 整体关着就一定不行', () => {
    assert.equal(judgePoint(at(), OFF).take, false)
  })

  it('★★★ 开着 Glance 时 Point **不跑** —— 两种功能不许混在一起', () => {
    /**
     * 使用者 2026-09-14 晚：「当用户开启 Glance 时：Assist 当前只运行 Glance，
     * 不运行 Point。」正常路径上那颗键压根没注册，这里是**第二道**：
     * 哪天注册那一侧漏了，判据这一层也不让它读。
     */
    assert.equal(judgePoint(at(), GLANCE).take, false)
  })

  it('★★★ 指在空白处：UIA 会吸到最近的词上，**那个词他没指**', () => {
    /**
     * 这一条是真量出来的（2026-09-14，他机器上的 Edge）：
     * 指到老远的空白处，RangeFromPoint 照样返回了一个词，dist=407。
     * 不卡这一道，他在空白处按一下会弹出一个完全没指的词。
     */
    assert.equal(judgePoint(at({ inside: false, dist: 407 }), ON).take, false)
  })

  it('★★ 指在行距里（实测 dist≈36）算数 —— 那确实是他在指那一行', () => {
    assert.equal(judgePoint(at({ inside: false, dist: 36 }), ON).take, true)
    assert.ok(36 < POINT_MAX_DIST, '容差被改小了，行距那一档会被误杀')
  })

  it('★★ 助手没量到几何（dist = -1）时放行 —— 那时我们什么都不知道，而他确实按了', () => {
    assert.equal(judgePoint(at({ inside: false, dist: -1 }), ON).take, true)
  })

  it('★★★ 密码框：和划词那条路同一道闸', () => {
    assert.equal(judgePoint(at({ password: true }), ON).take, false)
  })

  it('★★★ 黑名单：和划词那条路同一道闸', () => {
    assert.equal(judgePoint(at({ proc: '1password' }), ON).take, false)
    assert.equal(judgePoint(at({ proc: 'KeePassXC' }), ON).take, false)
  })

  it('★★ 太短 / 没英文：和划词那条路同一道闸', () => {
    assert.equal(judgePoint(at({ text: 'a' }), ON).take, false)
    assert.equal(judgePoint(at({ text: '词典' }), ON).take, false)
  })

  it('★★★ **不去重** —— 按一下键是他主动又问了一遍，同一个词必须还有反应', () => {
    assert.equal(judgePoint(at(), ON).take, true)
    assert.equal(judgePoint(at(), ON).take, true, '第二次被吞掉了 —— 他会以为按键坏了')
  })

  it('★★ 什么垃圾都不抛', () => {
    for (const bad of [null, undefined, {}, { text: 5 }, { text: 'ok', dist: 'x' }]) {
      assert.doesNotThrow(() => judgePoint(bad as never, ON))
    }
  })
})

describe('★★ 指到就查 · 助手吐的那一行', () => {
  it('★ 认得出正常的一行', () => {
    const h = parsePointHit('{"text":"unspooling","proc":"MsEdge","password":false,"inside":true,"dist":0}')
    assert.deepEqual(h, {
      text: 'unspooling', proc: 'msedge', password: false, inside: true, dist: 0, rect: undefined
    })
  })

  it('★★ 助手说「这儿没文字」那几种：text 是空串 → null，绝不当成一次命中', () => {
    for (const why of ['no-text-pattern', 'password', 'no-element', 'empty', 'threw']) {
      assert.equal(parsePointHit(`{"text":"","why":"${why}"}`), null, why)
    }
  })

  it('★★ 什么垃圾都不抛', () => {
    for (const bad of ['', '   ', 'not json', '{', '[]', 42, null, undefined, '{"text":5}']) {
      assert.doesNotThrow(() => parsePointHit(bad))
      assert.equal(parsePointHit(bad), null, String(bad))
    }
  })
})


/**
 * ══ 拖选那一路（使用者 2026-09-14 第三批）★★ ════════════════
 *
 * ★ 下面每一行 JSON 都是 2026-09-14 晚在他机器上**真吐出来的**（Edge 里一页
 *   `user-select:none` 的正文），不是我按格式编的 ——
 *   编的样本只能证明解析器和我自己一致。
 */
describe('★★ Point 拖选 · 助手吐的那一行', () => {
  it('★ 拖着的时候：认得出文字、矩形、还没松手', () => {
    const e = parseSelectLine(
      '{"sel":"unspooling consequences","proc":"msedge","dist":0,"rects":[[1466,522,482,49]]}'
    )
    assert.ok(e && e.kind === 'sel')
    assert.equal(e.hit.text, 'unspooling consequences')
    assert.equal(e.hit.proc, 'msedge')
    assert.equal(e.done, false, '没带 done 就不该当成松手 —— 否则一次拖动会连弹七八张卡')
    assert.deepEqual([...e.rects], [{ x: 1466, y: 522, w: 482, h: 49 }])
  })

  it('★★ 松手那一行带 done，而且折行是多个矩形（实测：拖过两行 → 两个）', () => {
    const e = parseSelectLine(
      '{"sel":"unspooling consequences of that signed policy counter every reasonable expectation the committee",' +
        '"proc":"msedge","dist":0,"rects":[[1466,522,855,49],[1385,602,966,49]],"done":true}'
    )
    assert.ok(e && e.kind === 'sel')
    assert.equal(e.done, true)
    assert.equal(e.rects.length, 2)
    /**
     * ★ 卡要摆在**整段**下面，所以 `rect` 是并集，不是第一行。
     *   摆第一行下面的话，卡会正好盖住他刚选的第二行。
     */
    assert.deepEqual(e.hit.rect, { x: 1385, y: 522, w: 966, h: 129 })
  })

  it('★ 起手那一下的 clear：把上一次的高亮擦掉', () => {
    const e = parseSelectLine('{"clear":true}')
    assert.ok(e && e.kind === 'clear')
  })

  it('★★ 不是选区的那几种行 → null（ready / why / 垃圾），而且一条都不抛', () => {
    for (const bad of [
      '{"ready":true}',
      '{"why":"no-text-pattern"}',
      '{"why":"password"}',
      '{"sel":""}',
      '',
      '   ',
      'not json',
      '{',
      '[]',
      42,
      null,
      undefined
    ]) {
      assert.doesNotThrow(() => parseSelectLine(bad))
      assert.equal(parseSelectLine(bad), null, String(bad))
    }
  })

  it('★★ 在空白处起拖的那一次，判据要拦住它', () => {
    /**
     * 实测 2026-09-14：在正文下方 300px 的空白处按下开始拖，Edge 照样给了文字
     * （它钳到最近的那一段），只是 dist = 288。而真指在字上时 dist = 0。
     * ★ 容差这一道写在 core（`POINT_MAX_DIST`），不在脚本里 ——
     *   脚本只负责量，量和判分开才有一份可改的判据。
     */
    const blank = parseSelectLine(
      '{"sel":"ordinary highlight attempt whatsoever","proc":"msedge","dist":288,' +
        '"rects":[[1863,883,493,49],[1385,963,211,49]],"done":true}'
    )
    assert.ok(blank && blank.kind === 'sel')
    assert.equal(blank.hit.dist, 288)
    assert.ok(288 > POINT_MAX_DIST, '这条用例的前提：288 必须超出容差')
    assert.equal(judgePoint(blank.hit, { mode: 'point', blocked: [] }).take, false)

    const onText = parseSelectLine(
      '{"sel":"unspooling consequences","proc":"msedge","dist":0,"rects":[[1466,522,482,49]],"done":true}'
    )
    assert.ok(onText && onText.kind === 'sel')
    assert.equal(judgePoint(onText.hit, { mode: 'point', blocked: [] }).take, true)
  })

  it('★★ 开着 Glance 的时候，拖选一样不算数（两种模式完全分开）', () => {
    const e = parseSelectLine(
      '{"sel":"unspooling consequences","proc":"msedge","dist":0,"rects":[[1466,522,482,49]],"done":true}'
    )
    assert.ok(e && e.kind === 'sel')
    assert.equal(judgePoint(e.hit, { mode: 'glance', blocked: [] }).take, false)
    assert.equal(judgePoint(e.hit, { mode: 'off', blocked: [] }).take, false)
  })

  it('★★ 黑名单与密码框走的是同一份判据（不另写一份）', () => {
    const mk = (extra: string): string =>
      '{"sel":"unspooling consequences","proc":"msedge","dist":0,"rects":[[1466,522,482,49]]' +
      extra +
      '}'
    const pwd = parseSelectLine(mk(',"password":true'))
    assert.ok(pwd && pwd.kind === 'sel')
    assert.equal(judgePoint(pwd.hit, { mode: 'point', blocked: [] }).take, false)

    const kp = parseSelectLine(
      '{"sel":"unspooling consequences","proc":"KeePassXC","dist":0,"rects":[[1466,522,482,49]]}'
    )
    assert.ok(kp && kp.kind === 'sel')
    assert.equal(judgePoint(kp.hit, { mode: 'point', blocked: [...DEFAULT_BLOCKED] }).take, false)
  })

  it('★ 并集：一个都没有给 undefined，均不抛', () => {
    assert.equal(unionRect([]), undefined)
    assert.deepEqual(unionRect([{ x: 10, y: 20, w: 5, h: 6 }]), { x: 10, y: 20, w: 5, h: 6 })
    assert.deepEqual(
      unionRect([
        { x: 100, y: 10, w: 50, h: 20 },
        { x: 20, y: 40, w: 30, h: 20 }
      ]),
      { x: 20, y: 10, w: 130, h: 50 }
    )
  })

  it('★★ 矩形里有垃圾就丢掉那一个，不把整条丢了', () => {
    const e = parseSelectLine(
      '{"sel":"x y","proc":"msedge","dist":0,"rects":[[1,2,3,4],[0,0,0,0],"nope",[5,6,7,8]]}'
    )
    assert.ok(e && e.kind === 'sel')
    assert.equal(e.rects.length, 2, '宽高为 0 的和不是数组的都该被滤掉')
  })
})


/**
 * ══ 那段字在屏幕上的位置（使用者 2026-09-14 晚）═══════════════════
 *
 * 他的原话：「弹窗应该**正好出现在当前选中文字的下方**。弹窗位置要根据选中
 * 文字的位置进行定位，而不是固定出现在其他位置。」
 *
 * ★ 这一组钉的是「**取不到就退回鼠标**」那条退路：`rect` 认错一次的表现不是报错，
 *   是卡摆到一个荒唐的地方（比如 0,0 那个角）。宽或高为 0 的矩形摆不出「在它下方」，
 *   所以那种也要当没有。
 */
describe('★★ 选中那段字的矩形', () => {
  it('★ 正常一条读得出来，并且一路带进判决里', () => {
    const v = judge(
      parseHit('{"text":"policy","proc":"msedge","password":false,"rect":[100,200,60,20]}'),
      { mode: 'glance', blocked: [] },
      null
    )
    assert.equal(v.take, true)
    assert.deepEqual(v.take && v.rect, { x: 100, y: 200, w: 60, h: 20 })
  })

  it('★★★ 0 宽 / 0 高的矩形当没有 —— 那种摆不出「在它下方」', () => {
    assert.equal(parseRect([10, 20, 0, 5]), undefined)
    assert.equal(parseRect([10, 20, 5, 0]), undefined)
  })

  it('★★ 什么垃圾都不抛，一律当没有', () => {
    for (const bad of [null, undefined, 'x', [], [1, 2, 3], [1, 2, 3, 'x'], [NaN, 0, 5, 5], {}]) {
      assert.doesNotThrow(() => parseRect(bad))
      assert.equal(parseRect(bad), undefined, JSON.stringify(bad))
    }
  })

  it('★ 没带矩形的那一条照样是一次有效命中（只是没有位置）', () => {
    const v = judge(
      parseHit('{"text":"policy","proc":"msedge","password":false}'),
      { mode: 'glance', blocked: [] },
      null
    )
    assert.equal(v.take, true)
    assert.equal(v.take && v.rect, undefined)
  })
})

/**
 * ══ 认出来的那一路 · I-177（使用者 2026-09-14「可以兜底，按你说的办」）══
 *
 * ★★ 这一套的**靶子不是"能不能取到字"，是"取到的是不是他指的那个词"**。
 *   OCR 取错词的后果和 Glance 那一套一样贵：D-395 写死的那条 ——
 *   错的 term 同步回来以后看起来和真的一模一样，**没有任何环节会报错**。
 *
 * ── 喂进来的数是真的 ──────────────────────────────────────
 * 下面这三个词框是 2026-09-14 在**他这台机器上正在跑的原神**里量出来的
 * （背包 → 任务道具 → Gliding Instruction Manual，那一行
 *  "jumped from his two-story house, resulting in the fracturing of"）：
 *   带的原点是屏幕物理像素 1484,1138，`Windows.Media.Ocr` en-US 报的框是
 *   he @0,26 32x23 · fracturing @40,25 151x31 · of @200,25 31x24
 * 这里换算成屏幕坐标写死。**不许用代码算出来再喂给自己**（那样两边一起漂也全绿）。
 */
describe('Point · OCR 兜底取词（I-177）', () => {
  /** 真·量出来的那三个词，按阅读顺序 */
  const WORDS: OcrWord[] = [
    { t: 'he', x: 1484, y: 1164, w: 32, h: 23 },
    { t: 'fracturing', x: 1524, y: 1163, w: 151, h: 31 },
    { t: 'of', x: 1684, y: 1163, w: 31, h: 24 }
  ]
  /** 那一次真的量到的光标位置（`GetCursorPos`，DPI-aware） */
  const CURSOR = { x: 1533, y: 1169 }

  it('★★★ 指在词框里 —— 就是那个词，dist 0', () => {
    const r = pickOcrRun(WORDS, CURSOR, CURSOR)
    assert.equal(r?.text, 'fracturing')
    assert.equal(r?.dist, 0)
    assert.equal(r?.inside, true)
  })

  it('★★ 拖过三个词 —— 拿到中间那一整段，按阅读顺序', () => {
    const r = pickOcrRun(WORDS, { x: 1490, y: 1170 }, { x: 1695, y: 1170 })
    assert.equal(r?.text, 'he fracturing of')
    assert.equal(r?.rects.length, 3)
  })

  it('★★ 反着拖（从右往左）拿到的是同一段 —— 起止点谁先谁后不算数', () => {
    const fwd = pickOcrRun(WORDS, { x: 1490, y: 1170 }, { x: 1695, y: 1170 })
    const back = pickOcrRun(WORDS, { x: 1695, y: 1170 }, { x: 1490, y: 1170 })
    assert.equal(back?.text, fwd?.text)
  })

  it('★★ 松手时滑出了文字 —— 留住起手那个词（浏览器就是这么做的）', () => {
    const r = pickOcrRun(WORDS, CURSOR, { x: 1533, y: 1900 })
    assert.equal(r?.text, 'fracturing')
  })

  /**
   * ★★★ **负向对照钉的就是这一条**：把 `POINT_MAX_DIST` 改成 0，
   *   这一条当场红（它是唯一"没指在框里、但容差内"的用例）。
   *   ★ 30px 是行距那个量级 —— 指在两行之间确实是在指那一行，
   *     而 400px 外的那个不是（下一条）。
   */
  it('★★★ 没指在框里、但在容差内 —— 算他指的那个词', () => {
    const r = pickOcrRun(WORDS, { x: 1600, y: 1133 }, { x: 1600, y: 1133 })
    assert.equal(r?.text, 'fracturing')
    assert.equal(r?.inside, false)
    assert.equal(r?.dist, 30)
    assert.ok((r as { dist: number }).dist <= POINT_MAX_DIST)
  })

  it('★★★ 离得老远 —— 一个字都不给（卡上要说「这里没读到文字」）', () => {
    assert.equal(pickOcrRun(WORDS, { x: 1600, y: 600 }, { x: 1600, y: 600 }), null)
  })

  it('★★ OCR 一个词都没认出来 —— 给 null，不是给空串', () => {
    assert.equal(pickOcrRun([], CURSOR, CURSOR), null)
  })

  it('★★ 什么垃圾都不抛', () => {
    for (const bad of [null, undefined, 'x', {}, [1, 2, 3]]) {
      assert.doesNotThrow(() => pickOcrRun(bad as never, CURSOR, CURSOR))
      assert.equal(pickOcrRun(bad as never, CURSOR, CURSOR), null, JSON.stringify(bad))
    }
    assert.doesNotThrow(() => pickOcrRun(WORDS, null as never, CURSOR))
  })

  /**
   * ★★★ 这一条钉的是第一段查明里那个**彻底无声**的 bug：
   *   助手报了一行，而 `parseSelectLine` 因为它没有 `sel` 字段返回 `null`，
   *   于是 `select.ts` 直接 continue —— 屏上没卡、日志没有、`onNote` 都不调用。
   *   他报的「点不了」在代码里就是这个样子。
   */
  it('★★★ 认出来的那一行认得出来（不再当垃圾丢掉）', () => {
    const line =
      '{"ocr":true,"proc":"GenshinImpact","ax":1533,"ay":1169,"bx":1695,"by":1170,' +
      '"words":[{"t":"fracturing","x":1524,"y":1163,"w":151,"h":31}],"done":true}'
    const ev = parseSelectLine(line)
    assert.equal(ev?.kind, 'ocr')
    assert.equal(ev?.kind === 'ocr' && ev.proc, 'genshinimpact')
    assert.equal(ev?.kind === 'ocr' && ev.done, true)
    assert.equal(ev?.kind === 'ocr' && ev.words.length, 1)
    assert.deepEqual(ev?.kind === 'ocr' && ev.a, { x: 1533, y: 1169 })
  })

  it('★★ OCR 认了个空 —— 行还是认得出来，只是一个词都没有', () => {
    const ev = parseSelectLine('{"ocr":true,"proc":"x","ax":1,"ay":2,"bx":3,"by":4,"words":[],"done":true}')
    assert.equal(ev?.kind, 'ocr')
    assert.equal(ev?.kind === 'ocr' && ev.words.length, 0)
  })

  it('★★ 缺端点的那一行不认 —— 没有锚点就没法判「他指的是哪个」', () => {
    assert.equal(parseSelectLine('{"ocr":true,"words":[],"done":true}'), null)
  })

  it('★★ 坏词框逐个丢掉，不带塌整行', () => {
    const ev = parseSelectLine(
      '{"ocr":true,"ax":1,"ay":2,"bx":3,"by":4,"words":[' +
        '{"t":"good","x":1,"y":2,"w":3,"h":4},' +
        '{"t":"","x":1,"y":2,"w":3,"h":4},' +
        '{"t":"zerowide","x":1,"y":2,"w":0,"h":4},' +
        '{"t":"nan","x":"a","y":2,"w":3,"h":4}],"done":true}'
    )
    assert.equal(ev?.kind === 'ocr' && ev.words.length, 1)
    assert.equal(ev?.kind === 'ocr' && ev.words[0]?.t, 'good')
  })

  it('★★ `{"why":…}` 照旧是 null —— 那是给日志的，不是给屏幕的', () => {
    assert.equal(parseSelectLine('{"why":"no-element"}'), null)
    assert.equal(parseSelectLine('{"why":"denied"}'), null)
  })

  /**
   * ★★★ 认出来的那一段走的是**同一道闸**：Point 没开就不许过。
   *   各写一份的后果不是查不出词，是一段他没打算给 Nyx 的字
   *   从其中一条路溢出去了，而两边都不报错。
   */
  it('★★★ OCR 来的那一段照样过 judgePoint：Glance 那一档不许过', () => {
    const r = pickOcrRun(WORDS, CURSOR, CURSOR)
    const hitOcr = { text: r?.text ?? '', proc: 'genshinimpact', ocr: true, inside: r?.inside, dist: r?.dist }
    assert.equal(judgePoint(hitOcr, { mode: 'point', blocked: [] }).take, true)
    assert.equal(judgePoint(hitOcr, { mode: 'glance', blocked: [] }).take, false)
    assert.equal(judgePoint(hitOcr, { mode: 'off', blocked: [] }).take, false)
  })

  it('★★★ 黑名单里的程序：认出来的也不许过（和真文字那一路同一份名单）', () => {
    const r = pickOcrRun(WORDS, CURSOR, CURSOR)
    const v = judgePoint(
      { text: r?.text ?? '', proc: '1password', ocr: true, inside: r?.inside, dist: r?.dist },
      { mode: 'point', blocked: ['1password'] }
    )
    assert.equal(v.take, false)
  })
})

/**
 * ★★★ 他在真原神里撞出来的那个（2026-09-15）—— 合成用例为什么没抓到
 *
 * 他装完之后报「原神里面都不能选中」。日志里只有两行：
 *   `[point] 这里没读到文字`
 *   `[point] 没取：太长了 —— 这不是查词，是复制`
 * 第二行是关键：**OCR 明明读到了字，是我自己的判据把它扔了。**
 *
 * 原因：上一版 `pickOcrRun` 取的是「起点词」和「终点词」在**阅读顺序里的下标区间**，
 * 把中间所有词一并切下来。合成用例里那条带**只有一行字**，怎么切都对；
 * 真游戏界面里那条带有好几行，于是一次普通的拖动就把**下一行**的字也切了进来。
 *
 * 下面这组词框是 2026-09-15 从真原神那一帧（`gs-01.png`，Gliding Instruction Manual）
 * 量出来的，OCR 报了 2 行 12 个词；拖动 500,512 → 900,554 在旧版下切出 12 个词 69 字。
 * ☞ 这一套钉的是：**他没划过的词不许进来**。
 */
describe('★★★ Point · 取词只能跟着拖动线走（真原神撞出来的）', () => {
  /** 真数：第 4 条那一行（y≈500）与第 5 条那一行（y≈540），屏幕物理像素 */
  const TWO_LINES: OcrWord[] = [
    { t: '4.', x: 492, y: 500, w: 30, h: 30 },
    { t: 'Pay', x: 529, y: 500, w: 52, h: 30 },
    { t: 'attention', x: 589, y: 499, w: 133, h: 31 },
    { t: 'to', x: 730, y: 502, w: 30, h: 28 },
    { t: 'air', x: 768, y: 499, w: 40, h: 31 },
    { t: 'traffic', x: 816, y: 499, w: 97, h: 31 },
    { t: 'conditions', x: 921, y: 506, w: 160, h: 24 },
    { t: 'glider', x: 492, y: 540, w: 84, h: 31 },
    { t: 'while', x: 584, y: 540, w: 77, h: 31 },
    { t: 'your', x: 669, y: 547, w: 68, h: 24 },
    { t: 'gliding', x: 745, y: 540, w: 98, h: 31 },
    { t: 'license', x: 851, y: 540, w: 96, h: 31 }
  ]

  it('★★★ 横着拖过一行 —— 只拿这一行划过的那几个词', () => {
    const r = pickOcrRun(TWO_LINES, { x: 500, y: 512 }, { x: 900, y: 512 })
    assert.ok(r, '★ 一个词都没挑出来')
    assert.ok(
      !r.text.includes('glider') && !r.text.includes('license'),
      '★★★ 把下一行的字也切进来了 —— 他的鼠标压根没碰过那儿。拿到的是：' + r.text
    )
    assert.ok(r.text.startsWith('4. Pay attention'), '★ 起手那个词丢了：' + r.text)
  })

  /**
   * ★★★ 这一条就是他撞的那一下：起点在上一行、终点在下一行。
   *   旧版切出 12 个词 69 字（屏幕再密一点就超过 MAX_CHARS 被判「太长了」）。
   *   新版只拿拖动线真扫过的那些。
   */
  it('★★★ 斜着拖到下一行 —— 拿的是划过的，不是"中间全部"', () => {
    const r = pickOcrRun(TWO_LINES, { x: 500, y: 512 }, { x: 900, y: 554 })
    assert.ok(r, '★ 一个词都没挑出来')
    assert.ok(
      r.text.length <= MAX_CHARS,
      '★★★ 超过 MAX_CHARS 就会被 judgePoint 判「太长了 —— 这不是查词，是复制」，' +
        '而他看到的就是那张看不懂的卡。这次 ' + r.text.length + ' 字：' + r.text
    )
    /** 线段从 (500,512) 斜到 (900,554)：中途不会经过第一行最右边那个 conditions */
    assert.ok(
      !r.text.includes('conditions'),
      '★★ conditions 在第一行最右边，这条斜线没扫到它：' + r.text
    )
  })

  it('★★ 反着拖（从右往左）读出来仍然是正着的那一串', () => {
    const fwd = pickOcrRun(TWO_LINES, { x: 500, y: 512 }, { x: 900, y: 512 })
    const back = pickOcrRun(TWO_LINES, { x: 900, y: 512 }, { x: 500, y: 512 })
    assert.equal(back?.text, fwd?.text, '★ 倒着拖读出来的顺序反了：' + back?.text)
  })

  it('★★ 只点一下不拖（起止同点）—— 就那一个词', () => {
    const r = pickOcrRun(TWO_LINES, { x: 620, y: 512 }, { x: 620, y: 512 })
    assert.equal(r?.text, 'attention')
  })

  it('★★ 拖在两行中间的空白上 —— 擦到的那几个算数，远的不算', () => {
    const r = pickOcrRun(TWO_LINES, { x: 500, y: 532 }, { x: 700, y: 532 })
    assert.ok(r, '★ 行距里拖一下应该还能收到附近那几个词')
    assert.ok(r.text.length <= MAX_CHARS)
  })
})

/**
 * ══ I-182 · 那张卡摆在哪（2026-09-15）════════════════════════
 *
 * 数字全是他那台机器上量到的真数：可用区 1707×1019（2560×1600 缩放 150%），
 * 卡 420×520，带「可能有误」那条时 420×576，间隙 18。
 * 他真拖的那两张卡是 `@846,0` 和 `@1198,0` —— y 都是 0，正是这一组要挡的东西。
 *
 * ★ 负向对照（做过）：把 `placeLookup` 里那句 `else y = bottom` 改回
 *   老写法的「翻上方之后硬夹」，下面「死区」那三条当场红，报的就是 `y === 0`。
 */
const AREA = { x: 0, y: 0, w: 1707, h: 1019 }
const CARD = { w: 420, h: 520 }
/** 带「可能有误」那条的卡（`OCR_BAR` 56）—— 死区更宽，单独钉 */
const OCR_CARD = { w: 420, h: 576 }
const FAR = { x: 9999, y: 9999 }

describe('★★★ I-182 · 查词卡摆在哪 —— 放不下的时候不许倒扣在原文上', () => {
  it('★★★ ① 放得下就在选中那段字的正下方（他定的那条，没改）', () => {
    const p = placeLookup({ x: 300, y: 200, w: 160, h: 24 }, FAR, CARD, AREA)
    assert.equal(p.x, 300, '★ x 要和那段字左边对齐')
    assert.equal(p.y, 200 + 24 + 18, '★ y 要在那段字下沿加一点空隙')
  })

  it('★★ ② 下面放不下、上面放得下 → 翻到上方（理由不变：别盖住原文）', () => {
    const a = { x: 300, y: 700, w: 160, h: 24 }
    const p = placeLookup(a, FAR, CARD, AREA)
    assert.equal(p.y, 700 - 520 - 18, '★ 该翻面')
    assert.ok(p.y + CARD.h < a.y, '★★ 翻上去之后整张卡都得在那段字**上面**，不许压住它')
  })

  /**
   * ★★★ 这三条是这次修复的全部要害。482～537 是算出来的那一段：
   *   放得下下方要 `选区顶 + 选区高 ≤ 481`；翻上方不出界要 `选区顶 ≥ 538`。
   */
  it('★★★ ③ 死区 482～537：一个都不许落到屏幕顶上', () => {
    for (let top = 482; top <= 537; top++) {
      const p = placeLookup({ x: 300, y: top, w: 160, h: 24 }, FAR, CARD, AREA)
      assert.notEqual(p.y, 0, `★★ 选区顶 ${top} 时卡又贴到屏幕顶了（老写法就是这样）`)
      assert.equal(p.y, AREA.h - CARD.h, `★ 选区顶 ${top} 应该夹在下边界 ${AREA.h - CARD.h}`)
    }
  })

  it('★★★ ④ 死区里卡的上沿要贴着选区，不许整张倒扣在原文上方', () => {
    const a = { x: 300, y: 500, w: 160, h: 24 }
    const p = placeLookup(a, FAR, CARD, AREA)
    /**
     * ★ 这一档屏幕上确实没有够 520 高又不碰选区的空位，重叠躲不掉；
     *   能选的只有压住哪一半。断言钉的是**方向**：卡的上沿不能高过选区顶太多，
     *   也就是他视线从原文往下走就进卡里 —— 而不是整张卡扣在原文上面。
     */
    assert.ok(p.y >= a.y - 24, `★★ 卡顶 ${p.y} 跑到选区顶 ${a.y} 上面去了 —— 方向反了`)
    assert.ok(p.y + CARD.h > a.y, '★ 卡得在选区这一带，不是别处')
  })

  it('★★★ ⑤ 带「可能有误」那条的卡（高 576）死区更宽，同样不许贴顶', () => {
    for (let top = 430; top <= 590; top += 8) {
      const p = placeLookup({ x: 300, y: top, w: 160, h: 24 }, FAR, OCR_CARD, AREA)
      assert.notEqual(p.y, 0, `★★ OCR 卡在选区顶 ${top} 时贴到屏幕顶了`)
      assert.ok(p.y + OCR_CARD.h <= AREA.h, `★ OCR 卡在选区顶 ${top} 时有一截插到屏幕外面`)
    }
  })

  it('★★ ⑥ 选区贴着屏幕最上面时，下方本来就放得下 —— 不该被这次改动影响', () => {
    const p = placeLookup({ x: 300, y: 0, w: 160, h: 24 }, FAR, CARD, AREA)
    assert.equal(p.y, 42, '★ 老老实实放在下面')
  })

  it('★★ ⑦ 右边缘：卡不许有一截在屏幕外面', () => {
    const p = placeLookup({ x: 1650, y: 100, w: 40, h: 24 }, FAR, CARD, AREA)
    assert.equal(p.x, AREA.w - CARD.w, '★ 该夹到右边界')
    assert.ok(p.x + CARD.w <= AREA.w)
  })

  it('★ ⑧ 助手拿不到几何（anchor 为 null）→ 退回鼠标旁边，这条路没动', () => {
    const p = placeLookup(null, { x: 400, y: 300 }, CARD, AREA)
    assert.deepEqual(p, { x: 418, y: 318 })
  })

  it('★ ⑨ 卡比整块屏还高 —— 不许算出负数把卡顶到屏幕外面', () => {
    const p = placeLookup({ x: 300, y: 500, w: 160, h: 24 }, FAR, { w: 420, h: 1200 }, AREA)
    assert.ok(p.y >= 0, '★ 这一档只能从屏幕顶开始，但不能是负的')
    assert.ok(p.x >= 0)
  })
})
