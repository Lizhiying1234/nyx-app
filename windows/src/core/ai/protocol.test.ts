/**
 * 服务商快填的形状 · T-7.2（R-017）
 *
 * ── 这一套能验什么、不能验什么 ★★ ──────────────────────────
 *
 * **不能**验「这个模型名今天还在不在」—— 那要联网问九家官方，而单元测试
 * 不许联网（联网的测试会在他断网时红，红的原因还跟他改的东西无关）。
 *
 * **能**验的是「这份清单没有烂成一眼看得出的样子」：
 * id 不重复 · 每家都有模型名且不重复 · baseUrl 是一个能解析的 URL ·
 * ★★ **每家都写了这一次核对的来源**（官方 URL + 日期）。
 *
 * 最后那一条是这一套的重点，也是 R-017 的教训：模型名会烂，而烂掉的表现是
 * 他点一下快填拿到一个 404 —— 404 在界面上最容易被读成「key 不对」。
 * 名字本身没法自动验，**「凭证在不在」可以**：来源没了，下一个人就只能靠猜，
 * 而这份清单上一次正是这么烂掉的。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROVIDERS, detectProtocol, normalizeBaseUrl, providerOf } from './protocol.ts'

/** 这九家 —— 少一家多一家都要有人点头（设置页那排按钮就是它） */
const EXPECTED_IDS = [
  'deepseek',
  'openai',
  'moonshot',
  'zhipu',
  'dashscope',
  'anthropic',
  'gemini',
  'openrouter',
  'ollama'
]

const SRC = readFileSync(fileURLToPath(new URL('./protocol.ts', import.meta.url)), 'utf8')

describe('T-7.2 · 服务商快填清单的形状', () => {
  it('★ 九家都在，id 不重复', () => {
    assert.deepEqual(
      PROVIDERS.map((p) => p.id),
      EXPECTED_IDS,
      '★ 增减服务商是产品决定（D-202 那排按钮），不是顺手改的事'
    )
    assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length)
  })

  it('★★ 每家都有模型名，不空、不重复、不带空白', () => {
    for (const p of PROVIDERS) {
      assert.ok(p.models.length > 0, `${p.id} 一个模型名都没有 —— 快填会写一个空字符串进去`)
      assert.equal(
        new Set(p.models).size,
        p.models.length,
        `${p.id} 的模型名有重复`
      )
      for (const m of p.models) {
        assert.ok(m.trim() !== '', `${p.id} 有一个空的模型名`)
        assert.equal(m, m.trim(), `${p.id} 的「${m}」两头有空白 —— 发出去就是 404`)
      }
    }
  })

  it('baseUrl 是一个解析得开的 URL，而且没有尾斜杠', () => {
    for (const p of PROVIDERS) {
      assert.doesNotThrow(() => new URL(p.baseUrl), `${p.id} 的 baseUrl 不是一个 URL：${p.baseUrl}`)
      assert.ok(!p.baseUrl.endsWith('/'), `${p.id} 的 baseUrl 带了尾斜杠：${p.baseUrl}`)
    }
  })

  it('name 都不空 —— 那是设置页按钮上的字', () => {
    for (const p of PROVIDERS) assert.ok(p.name.trim() !== '', `${p.id} 没有名字`)
  })

  /**
   * ★★★ R-017 的那条：**每家都要留下这一次核对的凭证**。
   * 判据是读源码文本 —— 注释不进运行时，只能这么验。
   */
  it('★★★ 每家的注释里都有「来源：」+ 官方 URL + 查看日期', () => {
    for (let i = 0; i < PROVIDERS.length; i++) {
      const here = SRC.indexOf(`id: '${PROVIDERS[i]!.id}'`)
      assert.ok(here > 0, `源码里找不到 ${PROVIDERS[i]!.id}`)
      const next = PROVIDERS[i + 1] ? SRC.indexOf(`id: '${PROVIDERS[i + 1]!.id}'`) : SRC.length
      const block = SRC.slice(here, next)

      assert.ok(
        block.includes('来源：'),
        `★★ ${PROVIDERS[i]!.id} 没写来源 —— 下一个人就只能靠猜，而这份清单上一次正是这么烂掉的`
      )
      assert.ok(
        /来源：[^\n]*https?:\/\//.test(block),
        `★ ${PROVIDERS[i]!.id} 的来源里没有 URL`
      )
      assert.ok(
        /\d{4}-\d{2}-\d{2} 查/.test(block),
        `★ ${PROVIDERS[i]!.id} 的来源没写查看日期 —— 没有日期的凭证过一年就没法判还算不算数`
      )
    }
  })

  /** 快填写出去的就是 models[0]，它必须能过 normalizeBaseUrl 那一关不被改形 */
  it('baseUrl 过 normalizeBaseUrl 之后原样不变（已经带路径的不许被补 /v1）', () => {
    for (const p of PROVIDERS) {
      assert.equal(
        normalizeBaseUrl(p.baseUrl, p.protocol),
        p.baseUrl,
        `★ ${p.id} 的 baseUrl 被规范化改形了 —— 快填填进去的和真正发出去的就不是一个地址`
      )
    }
  })

  it('每家自报的 protocol 与 detectProtocol 按 URL 判出来的一致', () => {
    for (const p of PROVIDERS) {
      assert.equal(
        detectProtocol('', p.baseUrl),
        p.protocol,
        `★ ${p.id} 自报 ${p.protocol}，而按 baseUrl 判出来是别的 —— 两份判据会打架`
      )
    }
  })
})

/**
 * ★★★ `providerOf` · 这一次调用是不是 DeepSeek（D-496，2026-09-16）
 *
 * 判据只有两条（host 一条 · 聚合器路由段一条），所以这一套要钉住的是**边界**：
 *   · 换模型名不许改变结论 —— 使用者原话「模型名称不能决定是否关闭思考」
 *   · 长得像的域名不许认成 DeepSeek（`includes` 会中招，这是不用它的理由）
 *   · 判不出来就是 `unknown`，上层据此**一个字段都不加**
 */
describe('providerOf · 判定「这是不是 DeepSeek」', () => {
  it('★★★ 官方 host · 任何模型名都算 DeepSeek（换模型不改结论）', () => {
    for (const m of ['deepseek-v4-pro', 'deepseek-v9-将来的名字', '', 'random-name']) {
      assert.equal(providerOf('https://api.deepseek.com/v1', m), 'deepseek', `模型名：${m}`)
    }
  })

  it('★★ 官方的两个口都算（/v1 与 /anthropic），子域也算', () => {
    assert.equal(providerOf('https://api.deepseek.com/anthropic', 'x'), 'deepseek')
    assert.equal(providerOf('https://deepseek.com', 'x'), 'deepseek')
    // 没写 scheme 的也要认（设置页允许他只填域名，normalizeBaseUrl 后面才补）
    assert.equal(providerOf('api.deepseek.com/v1', 'x'), 'deepseek')
  })

  it('★★★ 长得像的域名不算 —— 这是不用 includes 的理由', () => {
    for (const u of [
      'https://api.deepseek.com.evil.net/v1',
      'https://deepseek.com.cn/v1',
      'https://notdeepseek.com/v1',
      'https://my-deepseek-proxy.example.com/v1'
    ]) {
      assert.equal(providerOf(u, 'deepseek-v4-pro'), 'unknown', `★ ${u} 被认成了官方 DeepSeek`)
    }
  })

  it('★★ OpenRouter + deepseek/ 路由段 → 算（那一段是 Provider，不是模型名）', () => {
    assert.equal(
      providerOf('https://openrouter.ai/api/v1', 'deepseek/deepseek-v4-pro-20260813'),
      'deepseek-openrouter'
    )
    assert.equal(
      providerOf('https://openrouter.ai/api/v1', 'deepseek/将来的任何一个'),
      'deepseek-openrouter'
    )
  })

  it('★★ OpenRouter 上别人家的路由 → 不算', () => {
    assert.equal(
      providerOf('https://openrouter.ai/api/v1', 'anthropic/claude-opus-5-20260723'),
      'unknown'
    )
  })

  it('★★★ 模型名带 deepseek 但 host 不是 → 不算（他划的那条线）', () => {
    assert.equal(providerOf('https://api.openai.com/v1', 'deepseek-v4-pro'), 'unknown')
    assert.equal(providerOf('http://localhost:11434/v1', 'deepseek-r1:7b'), 'unknown')
  })

  it('★ 空的 / 畸形的 baseUrl → unknown（判不出来就什么都不加）', () => {
    assert.equal(providerOf('', 'deepseek-v4-pro'), 'unknown')
    assert.equal(providerOf('   ', 'deepseek-v4-pro'), 'unknown')
    assert.equal(providerOf('http://', 'deepseek-v4-pro'), 'unknown')
  })
})
