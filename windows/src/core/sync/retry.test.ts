/**
 * 传输层重试 · T-2.9 · 判据用例
 *
 * 三组：
 *   ① `withRetry` 本身 —— 什么重试、什么不重试、重试几次
 *   ② `cause` 链 —— 真凶藏在 `err.cause.code` 里（I-133 就是这么量出来的）
 *   ③ 接到两家 store 上之后 —— 尤其是 **`put` 重发的是同一段字节**
 *
 * ★★ 负向对照：
 *   · 把 `withRetry` 里那次重发拆掉  → ①-a、③ 全红
 *   · 把「只一次」拆成循环          → ①-b「第二次也失败要如实抛」红
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTransient, transientCode, withRetry, RETRY_DELAY_MS } from './retry.ts'
import { SupabaseStore, WebDavStore } from './store.ts'

/** 造一个和真 undici 同形的错：真凶在 `cause.code` 上 */
function connReset(code = 'ECONNRESET'): Error {
  const inner = Object.assign(new Error('read ECONNRESET'), { code, syscall: 'read' })
  return Object.assign(new TypeError('fetch failed'), { cause: inner })
}

/** 用例里不真的睡 */
const fast = { delayMs: 0 }

describe('★★ T-2.9 · withRetry —— 什么重试', () => {
  it('★★★ 第一次 ECONNRESET、第二次正常 → 成功，而且**只调了两次**', async () => {
    let calls = 0
    const r = await withRetry(async () => {
      calls += 1
      if (calls === 1) throw connReset()
      return 'ok'
    }, fast)
    assert.equal(r, 'ok')
    assert.equal(calls, 2, `★★★ 调了 ${calls} 次 —— 该是 2`)
  })

  it('★★★ 第二次也失败 → 如实抛（只重试一次，不许无限重试）', async () => {
    let calls = 0
    await assert.rejects(
      withRetry(async () => {
        calls += 1
        throw connReset()
      }, fast),
      /fetch failed/
    )
    assert.equal(calls, 2, `★★★ 调了 ${calls} 次 —— 只许再来一次；无限重试会让他一直等着`)
  })

  it('★ 一次就成 → 只调一次，不多发请求', async () => {
    let calls = 0
    await withRetry(async () => {
      calls += 1
      return 'ok'
    }, fast)
    assert.equal(calls, 1)
  })

  it('EPIPE / UND_ERR_SOCKET 也算「连接被拆了」', async () => {
    for (const code of ['EPIPE', 'UND_ERR_SOCKET']) {
      let calls = 0
      await withRetry(async () => {
        calls += 1
        if (calls === 1) throw connReset(code)
        return 'ok'
      }, fast)
      assert.equal(calls, 2, `${code} 没被当成瞬时错误`)
    }
  })
})

describe('★★★ T-2.9 · withRetry —— 什么**不**重试（名单窄是有意的）', () => {
  const notRetried: [string, Error][] = [
    ['ECONNREFUSED', connReset('ECONNREFUSED')],
    ['ETIMEDOUT', connReset('ETIMEDOUT')],
    ['ENOTFOUND', connReset('ENOTFOUND')],
    ['EAI_AGAIN', connReset('EAI_AGAIN')],
    ['AbortError', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['我们自己抛的人话错误', new Error('删不掉 nyx/chunks/a.json：返回 403。')]
  ]

  for (const [what, err] of notRetried) {
    it(`★ ${what} → 只调一次，原样抛出去`, async () => {
      let calls = 0
      await assert.rejects(
        withRetry(async () => {
          calls += 1
          throw err
        }, fast),
        (e: unknown) => e === err
      )
      assert.equal(calls, 1, `★★ ${what} 被重试了 —— 名单该窄不窄，他要多等一倍才看到真正的原因`)
    })
  }

  it('★★★ 4xx **不是异常** —— `fetch` 成功返回了，重试包装原样放过', async () => {
    let calls = 0
    const res = await withRetry(async () => {
      calls += 1
      return new Response('nope', { status: 403 })
    }, fast)
    assert.equal(calls, 1, '★★★ 把一个 403 响应重发了一遍')
    assert.equal(res.status, 403)
  })
})

describe('★★ T-2.9 · 真凶藏在 cause 链里（I-133 的形状）', () => {
  it('顶层是 `fetch failed`，code 在 cause 上', () => {
    assert.equal(transientCode(connReset()), 'ECONNRESET')
    assert.ok(isTransient(connReset()))
  })

  it('★ 再套一层也找得到', () => {
    const deep = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { cause: connReset() })
    })
    assert.equal(transientCode(deep), 'ECONNRESET')
  })

  it('★ 认不出的一律不是瞬时错误', () => {
    assert.equal(transientCode(new Error('随便什么')), null)
    assert.equal(transientCode(null), null)
    assert.equal(transientCode(undefined), null)
    assert.equal(transientCode({ code: 500 }), null)
  })

  it('★★ cause 成环也不许死循环', () => {
    const a: { cause?: unknown } = {}
    a.cause = a
    assert.equal(transientCode(a), null)
  })

  it('等待时间是几百毫秒这个量级', () => {
    assert.ok(RETRY_DELAY_MS >= 100 && RETRY_DELAY_MS <= 1000, `${RETRY_DELAY_MS} 不在几百毫秒的量级`)
  })
})

/** 换掉全局 fetch，跑完还回去 —— 别的用例还要用真的 */
async function withFakeFetch<T>(
  fake: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = ((u: unknown, i?: unknown) =>
    fake(String(u), i as RequestInit | undefined)) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

describe('★★★ T-2.9 · 接到两家 store 上', () => {
  const dav = (): WebDavStore =>
    new WebDavStore({ kind: 'webdav', url: 'http://x/bucket', user: 'u', secret: 'p' })
  const sb = (): SupabaseStore =>
    new SupabaseStore({ kind: 'supabase', url: 'http://x', user: 'nyx', secret: 'k' })

  it('★★★ WebDAV `put`：撞一次 ECONNRESET → 成功，而且**重发的是同一段字节**', async () => {
    const seen: { url: string; method: string; body: string }[] = []
    await withFakeFetch(
      async (url, init) => {
        seen.push({
          url,
          method: String(init?.method ?? 'GET'),
          body: String(init?.body ?? '')
        })
        // MKCOL 那几发照常过；第一次 PUT 撞一次
        if (init?.method === 'PUT' && seen.filter((s) => s.method === 'PUT').length === 1) {
          throw connReset()
        }
        return new Response('', { status: 201 })
      },
      async () => dav().put('nyx/chunks/aaa-1000.json', '{"rows":[]}')
    )

    const puts = seen.filter((s) => s.method === 'PUT')
    assert.equal(puts.length, 2, `★ PUT 该发两次，实际 ${puts.length}`)
    assert.deepEqual(
      puts[0],
      puts[1],
      '★★★ 重发的不是同一段字节 —— `put` 能重试的全部理由就是「同名同内容」'
    )
  })

  it('★★ WebDAV `get`：撞一次 → 拿得到内容', async () => {
    let calls = 0
    const body = await withFakeFetch(
      async () => {
        calls += 1
        if (calls === 1) throw connReset()
        return new Response('hello', { status: 200 })
      },
      async () => dav().get('nyx/chunks/a.json')
    )
    assert.equal(body, 'hello')
    assert.equal(calls, 2)
  })

  it('★★ WebDAV `get` 的 403：**不重试**，人话原样出来', async () => {
    let calls = 0
    await assert.rejects(
      withFakeFetch(
        async () => {
          calls += 1
          return new Response('', { status: 403 })
        },
        async () => dav().get('nyx/chunks/a.json')
      ),
      /账号或密码不对/
    )
    assert.equal(calls, 1, '★★ 403 被重发了一次 —— 那只会让他多等，原因一个字都不会变')
  })

  it('★★★ Supabase `list`：撞一次 ECONNRESET → 列得出来（五个方法走同一个出口）', async () => {
    let calls = 0
    const names = await withFakeFetch(
      async () => {
        calls += 1
        if (calls === 1) throw connReset()
        return new Response(JSON.stringify([{ name: 'aaa-1.json' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      },
      async () => sb().list('nyx/chunks')
    )
    assert.deepEqual(names, ['aaa-1.json'])
    assert.equal(calls, 2)
  })

  it('★★ Supabase 的 NoSuchBucket（HTTP 400 但正文说 404）：**不重试**', async () => {
    let calls = 0
    await assert.rejects(
      withFakeFetch(
        async () => {
          calls += 1
          return new Response(
            JSON.stringify({ statusCode: '404', error: 'Bucket not found', code: 'NoSuchBucket' }),
            { status: 400 }
          )
        },
        async () => sb().check()
      ),
      /没有叫「nyx」的桶/
    )
    assert.equal(calls, 1, '★★ 桶不存在是配置问题，重试改变不了它')
  })

  it('★ Supabase `delete`：撞一次 → 删得掉', async () => {
    let calls = 0
    await withFakeFetch(
      async () => {
        calls += 1
        if (calls === 1) throw connReset()
        return new Response('', { status: 200 })
      },
      async () => sb().delete('nyx/chunks/a.json')
    )
    assert.equal(calls, 2)
  })
})
