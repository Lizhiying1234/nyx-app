/**
 * 语音两档 · 判据用例 · D-466（使用者 2026-09-07「语音设置简化」）
 *
 * 钉的就是使用者定的那四句：
 *   · 词典有原生语音 → 用词典语音
 *   · 没有词典语音   → 用系统语音（系统语音是通用兜底）
 *   · 词典关着       → 直接系统语音
 *   · 两个都关       → 不出声，但**说一句话**（不是静默）
 * 外加两条结构性的：例句 / 整段不问词典 · 词典慢查不许阻塞系统音。
 *
 * ★★ 三条负向对照（T-7.10 完成标准）：
 *   ① `resolve.ts` 把「词典关着」判反      → 「词典关 → 直接 system」红
 *   ② 「两个都关」改成静默回系统音          → 「两个都关 → 空序列」红
 *   ③ `run.ts` 的 `Promise.race` 拆掉      → 「词典永远不返回」挂到超时红
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BOTH_OFF_SAYS, DICTIONARY_BUDGET_MS, inferVoiceKind, resolve } from './resolve.ts'
import { explain, runVoicePlan } from './run.ts'
import { pickDictAudio, playableDictAudio, unplayableDictSays } from './providers/dict-audio.ts'
import { ttsText, TTS_TEXT_MAX } from '../tts-key.ts'
import {
  ALL_SOURCE_IDS,
  DEFAULT_SWITCHES,
  type SourceId,
  type VoiceAvailability,
  type VoiceKind,
  type VoiceRequest,
  type VoiceSwitches
} from './types.ts'

const BOTH: VoiceAvailability = { dictionary: true, system: true }

const req = (kind: VoiceKind = 'word', origin: VoiceRequest['origin'] = 'lookup'): VoiceRequest => ({
  text: 'serendipity',
  kind,
  origin
})

const order = (p: ReturnType<typeof resolve>): SourceId[] => p.attempts.map((a) => a.source)
const sw = (dictionary: boolean, system: boolean): VoiceSwitches => ({ dictionary, system })

// ══════════════════════════════════════════════════════════════
describe('★★★ D-466 · 只有两档，顺序写死', () => {
  it('★★ 一共就两个来源 —— 加第三个得先有人改这条用例', () => {
    assert.deepEqual([...ALL_SOURCE_IDS], ['dictionary', 'system'])
  })

  it('★★★ 两个开关**出厂都是开的**（使用者原话：「这两个选项默认都开启」）', () => {
    assert.deepEqual(DEFAULT_SWITCHES, { dictionary: true, system: true })
  })

  it('★★★ 都开着 → 词典在前、系统在后（词典有音就优先用词典）', () => {
    assert.deepEqual(order(resolve(req(), DEFAULT_SWITCHES, BOTH)), ['dictionary', 'system'])
  })

  it('★★★ 词典关 → **直接系统音**（负向对照 ① 盯这一条）', () => {
    const p = resolve(req(), sw(false, true), BOTH)
    assert.deepEqual(order(p), ['system'], '★★★ 词典关着还进了序列')
    assert.equal(p.skipped.find((s) => s.source === 'dictionary')?.why, '你把它关了')
  })

  it('★★ 系统关、词典开 → 只有词典这一步（没有兜底了，是他要的）', () => {
    assert.deepEqual(order(resolve(req(), sw(true, false), BOTH)), ['dictionary'])
  })
})

// ══════════════════════════════════════════════════════════════
describe('★★★ D-466 · 两个都关 = 不出声，但要**说一句**（负向对照 ② 盯这一组）', () => {
  it('★★★ 空序列 —— 一步都不排', () => {
    assert.deepEqual(order(resolve(req(), sw(false, false), BOTH)), [])
  })

  it('★★★ `why` 非空，而且说的是「两个开关都关着」，不是「这台机器上用不了」', () => {
    const p = resolve(req(), sw(false, false), BOTH)
    assert.notEqual(p.why.trim(), '', '★★★ 一句话都没有 —— 那就是静默')
    assert.equal(p.why, BOTH_OFF_SAYS)
    assert.match(p.why, /两个开关都关着/)
    assert.match(p.why, /设置/, '★★ 得告诉他去哪儿打开，否则他会去找一个不存在的毛病')
    assert.ok(
      !p.why.includes('这台机器上'),
      '★★★ 把「他关了」说成「机器上用不了」—— 他会去查一个根本不存在的故障'
    )
  })

  it('★★★ 跑一趟：一步都没成，账本里两条都写着「你把它关了」', async () => {
    const plan = resolve(req(), sw(false, false), BOTH)
    const r = await runVoicePlan<string>(plan, req(), { system: async () => 'system' })
    assert.equal(r.source, null, '★★★ 两个都关了还出声 —— 开关形同虚设')
    assert.equal(r.trace.spoke, null)
    assert.deepEqual(
      r.trace.steps.map((s) => `${s.source}:${s.outcome}`),
      ['dictionary:skipped', 'system:skipped']
    )
    assert.match(explain(r), /你把它关了/)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★★ D-466 · 事实压过偏好（可用性）', () => {
  it('★★ 词典开着但这台机器上没接词典层 → 跳过它，不是报错', () => {
    const p = resolve(req(), DEFAULT_SWITCHES, { dictionary: false, system: true })
    assert.deepEqual(order(p), ['system'])
    assert.match(p.skipped.find((s) => s.source === 'dictionary')?.why ?? '', /还没接词典发音/)
  })

  it('★★ 两样都用不了 → 空序列，why 说得出哪几样用不了（≠ 两个都关那句）', () => {
    const p = resolve(req(), DEFAULT_SWITCHES, { dictionary: false, system: false })
    assert.deepEqual(order(p), [])
    assert.match(p.why, /用不了|没有可用/)
    assert.notEqual(p.why, BOTH_OFF_SAYS, '★★ 开关明明开着，却说他关了 —— 冤枉使用者')
  })
})

// ══════════════════════════════════════════════════════════════
describe('★★ D-466 · kind 分流（词典里只有词头键）', () => {
  it('词 / 短语问词典', () => {
    for (const k of ['word', 'phrase'] as VoiceKind[]) {
      assert.ok(order(resolve(req(k), DEFAULT_SWITCHES, BOTH)).includes('dictionary'), k)
    }
  })

  it('★★ 例句 / 整段**不问**词典 —— 问了也是白问，还白花 150 ms', () => {
    for (const k of ['sentence', 'passage'] as VoiceKind[]) {
      const p = resolve(req(k), DEFAULT_SWITCHES, BOTH)
      assert.deepEqual(order(p), ['system'], `${k} 还在问词典`)
      assert.match(p.skipped.find((s) => s.source === 'dictionary')?.why ?? '', /不问词典/)
    }
  })

  it('★★★ origin 不参与选谁读 —— AI 搜索里点的读和详情页点的必须是同一个声音', () => {
    const a = resolve(req('word', 'ai-search'), DEFAULT_SWITCHES, BOTH)
    const b = resolve(req('word', 'detail'), DEFAULT_SWITCHES, BOTH)
    assert.deepEqual(order(a), order(b))
  })
})

// ══════════════════════════════════════════════════════════════
describe('★★★ D-466 · 预算（这一组就是「Assist 慢」的药）', () => {
  it('词典那一步 150 ms，系统那一步没有预算', () => {
    const p = resolve(req(), DEFAULT_SWITCHES, BOTH)
    assert.equal(p.attempts.find((a) => a.source === 'dictionary')?.budgetMs, DICTIONARY_BUDGET_MS)
    assert.equal(
      p.attempts.find((a) => a.source === 'system')?.budgetMs,
      null,
      '★ 给系统音设预算 = 放弃最后的兜底'
    )
  })

  /**
   * ★★★ 负向对照 ③ 盯这一条：把 `run.ts` 的 `Promise.race` 拆掉，
   * 这个**永不 resolve** 的词典步会把整趟挂住 —— 用例超时变红。
   * 那正是「词典慢查阻塞系统音」在真机上的样子。
   */
  it('★★★ 词典永远不返回 → 到点就走，系统音照样出声', { timeout: 5000 }, async () => {
    const plan = resolve(req(), DEFAULT_SWITCHES, BOTH)
    const r = await runVoicePlan<string>(plan, req(), {
      dictionary: () => new Promise<string | null>(() => {}), // 永不 resolve
      system: async () => 'system-said-it'
    })
    assert.equal(r.source, 'system', `★★★ 词典把后面的一切堵住了：${JSON.stringify(r.tried)}`)
    assert.equal(r.value, 'system-said-it')
    assert.equal(r.tried.find((t) => t.source === 'dictionary')?.outcome, 'timeout')
    assert.match(explain(r), /不等了/)
  })

  it('★★★ 词典里没有这个词 → **miss，不是错**，系统音顶上，理由说得出来', async () => {
    const plan = resolve(req(), DEFAULT_SWITCHES, BOTH)
    const r = await runVoicePlan<string>(plan, req(), {
      dictionary: async () => null,
      system: async () => 'system'
    })
    assert.equal(r.source, 'system')
    assert.equal(r.trace.spoke, 'system')
    const step = r.trace.steps.find((s) => s.source === 'dictionary')
    assert.equal(step?.outcome, 'miss')
    assert.match(step?.reason ?? '', /没有这个词的发音/)
  })

  it('★★ 词典有音 → 就是它出的声，系统那一步压根不跑', async () => {
    const plan = resolve(req(), DEFAULT_SWITCHES, BOTH)
    let systemRan = false
    const r = await runVoicePlan<string>(plan, req(), {
      dictionary: async () => 'brunt__gb_1.mp3',
      system: async () => {
        systemRan = true
        return 'system'
      }
    })
    assert.equal(r.source, 'dictionary')
    assert.equal(systemRan, false, '★★ 词典已经出声了还去叫系统音 —— 会听到两遍')
  })

  it('★★ 词典那一步炸了不许把整趟带停 —— 后面还有兜底', async () => {
    const plan = resolve(req(), DEFAULT_SWITCHES, BOTH)
    const r = await runVoicePlan<string>(plan, req(), {
      dictionary: async () => {
        throw new Error('mdx 索引读坏了')
      },
      system: async () => 'system'
    })
    assert.equal(r.source, 'system')
    assert.equal(r.tried[0]?.outcome, 'error')
    assert.match(explain(r), /mdx 索引读坏了/)
  })

  it('★ 平台没接的那一档算 no-handler，不是错', async () => {
    const plan = resolve(req(), DEFAULT_SWITCHES, BOTH)
    const r = await runVoicePlan<string>(plan, req(), { system: async () => 'system' })
    assert.equal(r.source, 'system')
    assert.deepEqual(
      r.tried.map((t) => t.outcome),
      ['no-handler', 'hit']
    )
  })
})

// ══════════════════════════════════════════════════════════════
describe('★ D-466 · 账本（他能贴给我看的那一行 · D-219）', () => {
  it('★★ 排了什么、谁出的声、每一步为什么 —— 三样都在', async () => {
    const plan = resolve(req(), sw(true, true), { dictionary: false, system: true })
    const r = await runVoicePlan<string>(plan, req(), { system: async () => 'system' })
    assert.deepEqual(r.trace.planned, ['system'])
    assert.equal(r.trace.spoke, 'system')
    assert.equal(r.trace.kind, 'word')
    assert.equal(r.trace.origin, 'lookup')
    assert.ok(r.trace.ms >= 0)
    // 被跳过的那一步也在账上，而且说得出为什么
    const skipped = r.trace.steps.find((s) => s.source === 'dictionary')
    assert.equal(skipped?.outcome, 'skipped')
    assert.ok((skipped?.reason ?? '').length >= 3, '★★ 跳过了却说不出为什么')
  })
})

// ══════════════════════════════════════════════════════════════
describe('★ D-466 · 挑英音 / 美音（`pickDictAudio` 留着，判据一个字没动）', () => {
  it('口音说了算', () => {
    const refs = ['b|brunt__gb_1.mp3', 'b|brunt__us_1.mp3']
    assert.equal(pickDictAudio(refs, 'en-GB'), 'b|brunt__gb_1.mp3')
    assert.equal(pickDictAudio(refs, 'en-US'), 'b|brunt__us_1.mp3')
  })

  it('★ 一条都没有 → null（miss，不是错）', () => {
    assert.equal(pickDictAudio([], 'en-GB'), null)
  })
})

// ══════════════════════════════════════════════════════════════
describe('★★★ T-7.12（I-165）· 放不响的发音不许当成词典出声', () => {
  /** LDOCE5 词头音的真实形状（A 2026-09-07 在他真库上量的：字节是 OggS） */
  /** ★ 反斜杠绕开写（D-460）—— 真实的 ref 是 `bookUid|\gb_x.spx` 那个形状 */
  const BS = String.fromCharCode(92)
  const SPX = [`b|${BS}gb_ld41serendipity.spx`, `b|${BS}us_serendipity.spx`]

  it('★★★ 全是 Speex → 挑不出来（负向对照盯这一条）', () => {
    assert.equal(
      pickDictAudio(SPX, 'en-GB'),
      null,
      '★★★ 挑中了一条 Chromium 放不出来的音 —— 账本会写「词典语音出的声」，而他听到的是系统音'
    )
    assert.deepEqual(playableDictAudio(SPX), [])
  })

  it('★★ 混着的时候只挑放得响的那条，口音其次', () => {
    const mixed = [`b|${BS}gb_x.spx`, `b|${BS}us_x.mp3`]
    // 英音那条放不响 —— 宁可给美音的 mp3，也不给一条放不出来的英音
    assert.equal(pickDictAudio(mixed, 'en-GB'), `b|${BS}us_x.mp3`)
  })

  it('★ 放得响的那几种都认（mp3 / ogg / wav / m4a / opus / flac）', () => {
    for (const ext of ['mp3', 'ogg', 'wav', 'm4a', 'opus', 'flac']) {
      assert.equal(playableDictAudio([`b|${BS}x.${ext}`]).length, 1, ext)
    }
    for (const ext of ['spx', 'wma', 'amr', 'mid']) {
      assert.deepEqual(playableDictAudio([`b|${BS}x.${ext}`]), [], ext)
    }
  })

  it('★★ 那句话说得出是什么格式 —— 他才知道该换词典而不是换个词', () => {
    const said = unplayableDictSays(SPX)
    assert.match(said, /\.spx/)
    assert.match(said, /系统语音/)
  })

  it('★★★ 跑一趟：Speex 那条记成 miss、系统音出声，账本写的是格式那句话', async () => {
    const plan = resolve(req(), DEFAULT_SWITCHES, BOTH)
    const r = await runVoicePlan<string>(
      plan,
      req(),
      {
        // 执行器照 pickDictAudio 的结果办事：挑不出来就是 miss
        dictionary: async () => (pickDictAudio(SPX, 'en-GB') === null ? null : 'dict'),
        system: async () => 'system'
      },
      { missSays: (id) => (id === 'dictionary' ? unplayableDictSays(SPX) : undefined) }
    )
    assert.equal(r.trace.spoke, 'system', '★★★ Speex 被记成了词典出声')
    const step = r.trace.steps.find((x) => x.source === 'dictionary')
    assert.equal(step?.outcome, 'miss')
    assert.match(step?.reason ?? '', /\.spx/, `★★ 账本没说清是什么格式：${step?.reason}`)
  })
})

describe('★ D-466 · 读多长 / 猜什么 kind', () => {
  it('超过上限就截断，前后空白不算', () => {
    assert.equal(ttsText('  hold sway over  '), 'hold sway over')
    assert.equal(ttsText('x'.repeat(TTS_TEXT_MAX + 50)).length, TTS_TEXT_MAX)
  })

  it('单个词 → word；短语 → phrase；一句话 → sentence（于是不问词典）', () => {
    assert.equal(inferVoiceKind('serendipity'), 'word')
    assert.equal(inferVoiceKind('  hold sway over  '), 'phrase')
    const t = 'Amy went missing on the morning of their fifth anniversary.'
    assert.equal(inferVoiceKind(t), 'sentence')
    const p = resolve({ text: t, kind: inferVoiceKind(t), origin: 'reading' }, DEFAULT_SWITCHES, BOTH)
    assert.ok(!order(p).includes('dictionary'))
  })

  it('★ 很长 → passage；空文本不炸', () => {
    assert.equal(inferVoiceKind('word '.repeat(30)), 'passage')
    assert.equal(inferVoiceKind('x'.repeat(240)), 'passage')
    assert.equal(inferVoiceKind('   '), 'word')
  })
})
