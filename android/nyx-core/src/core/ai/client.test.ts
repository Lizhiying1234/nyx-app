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
