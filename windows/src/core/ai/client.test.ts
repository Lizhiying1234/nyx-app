import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AiError, callAi, resetFailureStreak, type SlotConfig } from './client.ts'

/**
 * 「请求成功但没有正文」那句话 · 2026-09-13
 *
 * ── 为什么这一套是新写的 ★★ ────────────────────────────────
 *
 * `callAi` 是两端**每一次**连 AI 都要走的那一条路，而在这之前它
 * **一个单元测试都没有**（`src/core/ai/` 下只有 `protocol.test.ts`，
 * 验的是服务商快填清单，碰不到 `callAi` 一行）。
 * 于是这次这个 bug 能活下来：屏上那句话说的是「可能是模型名不对」，
 * 而真相是「模型把额度全写进思考里了」—— 全仓没有一处会红。
 *
 * ── 这一套验什么 ────────────────────────────────────────────
 *
 * **失败的时候那句话说的是不是真的。** 具体四条岔路（三家协议各一遍关键的）：
 *   ① 思考写满 + 被长度切断 → 说「额度全用在思考上」，**不许**再说「模型名不对」
 *   ② 思考写了但说自己正常结束 → 说「只写了思考没写正文」，给 retry
 *   ③ 没有思考 + 被长度切断 → 说「上限太低」
 *   ④ 两样都没有 → **原来那句话原样保留**（那时候「模型名不对」才真的是一种可能）
 * 外加一条更要紧的：
 *   ⑤ **思考绝不许当正文交出去**（D-412）。三家各验一遍。
 *
 * ★ 断言钉的是**那句话里的事实**（有没有把思考的字数说出来 / 有没有还在
 *   说「模型名不对」），不是整句文案 —— 文案是会改的，事实不会。
 * ★ 不联网：把 `globalThis.fetch` 换掉。真实响应体抄的是使用者 2026-09-13
 *   那次的原始返回（Nyx-UI-Android 转的），不是我编的形状。
 */

const CFG: SlotConfig = {
  apiKey: 'k',
  baseUrl: 'https://example.invalid/v1',
  model: 'deepseek-flash',
  protocol: 'openai'
}

let realFetch: typeof globalThis.fetch

function reply(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof globalThis.fetch
}

/** 跑一次，把失败接住。没失败就把正文交出来。 */
async function run(cfg: SlotConfig = CFG): Promise<{ out?: string; err?: AiError }> {
  try {
    return { out: await callAi(cfg, { user: 'hi', maxTokens: 120 }, 'light') }
  } catch (e) {
    if (e instanceof AiError) return { err: e }
    throw e
  }
}

beforeEach(() => {
  realFetch = globalThis.fetch
  resetFailureStreak()
})
afterEach(() => {
  globalThis.fetch = realFetch
  resetFailureStreak()
})

/** 使用者 2026-09-13 拿到的那一份，逐字抄的形状 */
const DEEPSEEK_TRUNCATED = {
  id: '8d600675-x',
  object: 'chat.completion',
  model: 'deepseek-flash',
  choices: [
    {
      index: 0,
      finish_reason: 'length',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content:
          '我们需要回答用户。用户选中词组 "Self government" 没有上下文。' +
          '需要按中文母语者英语助手，词/词组按词条讲。注意拼写：通常 "self-government" 连字符…'
      }
    }
  ]
}

describe('空正文 · 那句话必须说真话（2026-09-13）', () => {
  it('★★★ ① 思考写满 + 被长度切断 —— 说的是「额度用在思考上」，不是「模型名不对」', async () => {
    reply(DEEPSEEK_TRUNCATED)
    const { err } = await run()
    assert.ok(err, '★ 这一份响应必须失败（正文确实是空的）')
    const said = err!.failure.title + ' · ' + err!.failure.detail
    assert.match(said, /思考/, `★★ 没提「思考」两个字，他仍然不知道发生了什么：${said}`)
    const n = DEEPSEEK_TRUNCATED.choices[0].message.reasoning_content.length
    assert.ok(
      said.includes(String(n)),
      `★★ 没把思考的字数（${n}）说出来 —— 「额度花在哪了」正是他要的那个数：${said}`
    )
    assert.ok(
      !said.includes('模型名不对'),
      `★★★ **还在说「模型名不对」** —— 这正是那句假话：它会把他往改一个本来就对的模型名上带。\n${said}`
    )
    assert.ok(
      err!.failure.actions.includes('settings'),
      '★ 正确的动作是去设置里把上限调高 / 换模型，得给他这条出路'
    )
  })

  it('★★ ② 思考写了、却说自己正常结束 —— 是服务商的怪行为，重试有意义', async () => {
    reply({
      choices: [
        { finish_reason: 'stop', message: { content: '', reasoning_content: '想了一段但没写正文' } }
      ]
    })
    const { err } = await run()
    assert.ok(err)
    assert.match(err!.failure.title, /思考/, err!.failure.title)
    assert.ok(err!.failure.actions.includes('retry'), '★ 这一档重试是有意义的')
  })

  it('★★ ③ 没有思考、被长度切断 —— 说的是「上限太低」', async () => {
    reply({ choices: [{ finish_reason: 'length', message: { content: '' } }] })
    const { err } = await run()
    assert.ok(err)
    const said = err!.failure.title + ' · ' + err!.failure.detail
    assert.match(said, /上限/, said)
    assert.ok(!said.includes('模型名不对'), `★★ 服务商已经说了是被长度切断的，不该再猜模型名：${said}`)
  })

  it('★ ④ 两样都没有 —— 原来那句话原样保留（那时候「模型名不对」才真的是一种可能）', async () => {
    reply({ choices: [{ finish_reason: 'stop', message: { content: '' } }] })
    const { err } = await run()
    assert.ok(err)
    assert.match(err!.failure.detail, /模型名不对/, err!.failure.detail)
  })

  it('★ 正文有字时一切照旧 —— 这一套没把好路弄坏', async () => {
    reply({
      choices: [
        { finish_reason: 'stop', message: { content: ' 正文在这里 ', reasoning_content: '想了想' } }
      ]
    })
    const { out, err } = await run()
    assert.equal(err, undefined, err && err.failure.title)
    assert.equal(out, '正文在这里')
  })
})

describe('★★★ 思考绝不许当正文交出去（D-412）· 三家各一遍', () => {
  it('openai-compat · reasoning_content 不进正文', async () => {
    reply({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '真正的释义', reasoning_content: '我们需要回答用户…' }
        }
      ]
    })
    const { out } = await run()
    assert.equal(out, '真正的释义')
    assert.ok(!(out ?? '').includes('我们需要回答用户'), '★★★ 把草稿当释义交出去了')
  })

  it('anthropic · thinking 块不进正文，但它的长度要数得出来', async () => {
    reply({
      stop_reason: 'max_tokens',
      content: [{ type: 'thinking', thinking: '让我想想这个词' }]
    })
    const { err } = await run({ ...CFG, protocol: 'anthropic', model: 'claude-x' })
    assert.ok(err, '★ 只有 thinking 块 = 没有正文，必须失败')
    const said = err!.failure.title + ' · ' + err!.failure.detail
    assert.match(said, /思考/, said)
    assert.ok(
      !said.includes('让我想想这个词'),
      `★★★ 思考的**内容**漏进了屏上的话里 —— 只许出长度：${said}`
    )
  })

  it('gemini · thought 段不进正文（这根保险以前没上）', async () => {
    reply({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [{ text: '先想一想', thought: true }, { text: '真正的释义' }]
          }
        }
      ]
    })
    const { out } = await run({ ...CFG, protocol: 'gemini', model: 'gemini-x' })
    assert.equal(
      out,
      '真正的释义',
      '★★★ thought 段被当成正文拼进去了 —— 这是那根一直没上的保险'
    )
  })
})

/**
 * ★★★ D-496 · 判定为 DeepSeek 就默认关思考（2026-09-16）
 *
 * ── 这一套钉的是**发出去的那份 JSON**，不是「代码看起来怎么写的」──────
 * 使用者的病是真机上「模型把额度全用在思考上了…思考写了 23247 个字符就到顶了，
 * 正文一个字都没轮到」。治它只有一个办法：请求体里真的带着关闭项。
 * 所以断言直接读 `fetch` 收到的 body —— 换掉 fetch，不联网，也不真花钱。
 *
 * ── 四条判据（对应 D-496 他划的四条线）────────────────────────
 *   ① 判定为 DeepSeek → 带关闭项，**任意模型名都成立**（换模型不许再改代码）
 *   ② 按 **API 兼容形状**给字段：官方两个口都是 `thinking`，OpenRouter 是 `reasoning`
 *   ③ **非 DeepSeek 一个字段都不多**（"不支持的 API 不要强行发送导致请求失败"）
 *   ④ 发出去的 `reasoning` 里**不许有 `exclude`** —— 那是「照样想只是不回」，
 *      额度照花，还会把 09-13 那句诊断退化成「模型名不对」的假话
 */
describe('D-496 · DeepSeek 默认关闭思考（请求体）', () => {
  /** openai / anthropic / gemini 三家的 pick() 都能从里面取到「正文」 */
  const OK_ANY_PROTOCOL = {
    choices: [{ finish_reason: 'stop', message: { content: '正文' } }],
    content: [{ type: 'text', text: '正文' }],
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '正文' }] } }]
  }

  /** 记下每一次 fetch 收到的 body；默认回一份能过的正文 */
  function recorder(status = 200, errText = ''): { bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = []
    let n = 0
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      n += 1
      if (status !== 200 && n === 1) {
        return new Response(errText, { status, headers: { 'content-type': 'application/json' } })
      }
      // ★ 一份能同时喂饱三家 pick() 的响应 —— 这一套验的是**发出去的**那份，
      //   回来的长什么样不是重点，但形状不对会红在「空内容」上（第一遍就这么红过）
      return new Response(JSON.stringify(OK_ANY_PROTOCOL), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof globalThis.fetch
    return { bodies }
  }

  const send = async (cfg: Partial<SlotConfig>): Promise<Record<string, unknown>> => {
    const r = recorder()
    await callAi({ ...CFG, ...cfg } as SlotConfig, { user: 'hi', maxTokens: 900 }, 'light')
    return r.bodies[0] as Record<string, unknown>
  }

  it('★★★ ① 官方口 · 任意模型名都带 thinking.disabled（换模型不用再改代码）', async () => {
    // 三个名字：现在快填给的两个 + 一个还不存在的将来名字
    for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v9-whatever-2027']) {
      const body = await send({ baseUrl: 'https://api.deepseek.com/v1', model })
      assert.deepEqual(
        body['thinking'],
        { type: 'disabled' },
        `★ ${model} 的请求体里没有 thinking:{type:"disabled"} —— 这一次它还会思考`
      )
      assert.equal(
        JSON.stringify(body).includes('"enabled"'),
        false,
        `★ ${model} 的请求体里出现了开启项`
      )
    }
  })

  it('★★ ② Anthropic 兼容口（/anthropic）· 同一个字段名', async () => {
    const body = await send({
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      protocol: 'anthropic'
    })
    assert.deepEqual(
      body['thinking'],
      { type: 'disabled' },
      '★ 官方文档的兼容表里这一口写的就是 thinking（budget_tokens 被忽略）'
    )
  })

  it('★★ ③ OpenRouter 上的 deepseek/… · reasoning 关掉，且不许出现 exclude', async () => {
    const body = await send({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-pro-20260813'
    })
    assert.deepEqual(body['reasoning'], { enabled: false, effort: 'none' })
    assert.equal(
      JSON.stringify(body).includes('exclude'),
      false,
      '★★ exclude 是「照样想只是不回」—— 额度照花，还会让 reasoningChars 归 0，' +
        '把「额度全用在思考上」那句诊断退化回「模型名不对」的假话'
    )
  })

  it('★★★ ④ 非 DeepSeek · 一个字段都不多（不支持的 API 不许强发）', async () => {
    const others: Partial<SlotConfig>[] = [
      { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' },
      { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
      { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', protocol: 'anthropic' },
      // ★ OpenRouter 上**不是** deepseek 路由的
      { baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5-20260723' }
    ]
    for (const cfg of others) {
      const body = await send(cfg)
      assert.equal(
        /thinking|reasoning/i.test(JSON.stringify(body)),
        false,
        `★ ${cfg.baseUrl} · ${cfg.model} 的请求体里多了思考相关字段 —— 可能被服务商拒成 400`
      )
    }
  })

  it('★★ ⑤ 模型名带 deepseek、host 不是 —— 不许因为名字就加（他划的那条线）', async () => {
    const body = await send({ baseUrl: 'https://api.openai.com/v1', model: 'deepseek-v4-pro' })
    assert.equal(
      /thinking|reasoning/i.test(JSON.stringify(body)),
      false,
      '★ 判据落到模型名上了 —— 使用者原话：模型名称不能决定是否关闭思考'
    )
  })

  it('★★ ⑥ 服务商拒了那个字段 → 去掉它重试一次，第二次不带它', async () => {
    const r = recorder(400, JSON.stringify({ error: { message: 'unknown field: thinking' } }))
    const out = await callAi(
      { ...CFG, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
      { user: 'hi', maxTokens: 900 },
      'light'
    )
    assert.equal(r.bodies.length, 2, '★ 没有重试 —— 他会看到一个他没做错任何事的 400')
    assert.deepEqual(r.bodies[0]?.['thinking'], { type: 'disabled' })
    assert.equal('thinking' in (r.bodies[1] ?? {}), false, '★ 第二次还带着那个字段')
    assert.equal(out, '正文', '★ 重试成功了却没把正文交出去')
  })

  it('★ ⑦ 400 但没点名那个字段 —— 不重试（真正的 key 错 / 模型名错不该多花一次钱）', async () => {
    const r = recorder(400, JSON.stringify({ error: { message: 'invalid model' } }))
    await assert.rejects(
      callAi(
        { ...CFG, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
        { user: 'hi', maxTokens: 900 },
        'light'
      )
    )
    assert.equal(r.bodies.length, 1, '★ 无关的 400 也重试了 —— 多花一次钱、失败时间翻倍')
  })
})
