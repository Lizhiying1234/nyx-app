/**
 * 词典 `.spx` 发音：Ogg 拆包 + Speex 头（使用者 2026-09-13）
 *
 * ── 夹具是**真机抄的** ──────────────────────────────────────
 * `fixtures/ldoce5.bicycle.spx` 是从使用者那台机器上那本
 * 「Longman Dictionary of Contemporary English」的 1.07 GB `.mdd` 里
 * 按键 `\gb_ld41bicycle.spx` 取出来的**原始字节**（2208 字节）。
 * 自己造的 Ogg 会绿在用例里、坏在真机上 —— 这一条在这个仓里栽过一次
 * （T-5.16 的 `_._TLD.mdx`），所以夹具一律照真机抄。
 *
 * ── 这道闸守什么 ────────────────────────────────────────────
 * 拆包与读头是**纯函数**，可以在这里钉死。
 * 真正的解码要 libspeex 的 WASM（浏览器侧懒加载），那一半只能上机验 ——
 * 所以这里**不假装**测了它，只把「喂给解码器之前的东西对不对」钉住。
 *
 * ★ `framesPerPacket === 1` 这一条尤其要钉：`@caitun/speex` 的 API
 *   一次只解一帧，每包多于一帧就对不上。`decodeSpxToWav` 遇到 >1 会
 *   **如实说这一档还没支持**，而不是只播前 1/N —— 播一半比不播更难发现。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { oggPackets, spxHeader } from '../src/db/spx.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPX = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/ldoce5.bicycle.spx')))

describe('SPX · Ogg 拆包与 Speex 头（夹具照真机抄）', () => {
  it('① 拆得出包：标识头 + 注释头 + 若干音频包', () => {
    const p = oggPackets(SPX)
    assert.ok(p.length >= 3, `★ 只拆出 ${p.length} 个包，音频包一个都没有`)
    assert.equal(String.fromCharCode(...p[0]!.subarray(0, 8)), 'Speex   ', '★ 第一个包不是标识头')
  })

  it('② 头里的数就是真机上量到的那几个', () => {
    const h = spxHeader(oggPackets(SPX)[0]!)
    assert.ok(h, '★ 读不出 Speex 头')
    assert.equal(h.rate, 22050, '★ 播放率变了')
    assert.equal(h.mode, 1, '★ 模式变了（1 = 宽带）')
    assert.equal(h.channels, 1)
    assert.equal(h.frameSize, 320)
    assert.equal(h.framesPerPacket, 1, '★ 每包帧数变了 —— 那个解码器一次只解一帧')
  })

  it('★ ③ 建解码器要用**模式的标称率**，不是文件头里那个播放率', () => {
    const h = spxHeader(oggPackets(SPX)[0]!)!
    // 这本就是 22050 配宽带：拿 22050 去建解码器，选中的模式可能就不是宽带，
    // 解出来是噪音。播放仍按 h.rate 走 —— 两个数是两件事，别合并。
    assert.notEqual(h.rate, [8000, 16000, 32000][h.mode], '★ 这个夹具不再是「播放率 ≠ 标称率」那一种了')
  })

  it('④ 不是 Ogg 的字节 → 空数组，不抛', () => {
    assert.deepEqual(oggPackets(new Uint8Array([1, 2, 3, 4, 5])), [])
    assert.equal(spxHeader(new Uint8Array(80)), null)
  })

  it('★ ⑤ 截断的文件不许读越界 —— 词典里真的有坏条目', () => {
    for (const cut of [30, 60, 100, 500, 1500]) {
      const part = SPX.subarray(0, cut)
      assert.doesNotThrow(() => oggPackets(part), `★ 截到 ${cut} 字节时抛了`)
    }
  })
})
