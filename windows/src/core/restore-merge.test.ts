import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ledgerKeepsCurrent,
  mergeApplied,
  mergePurgedAt,
  mergeWatermark,
  mergeWipedAt,
  parseApplied
} from './restore-merge.ts'

/**
 * ★★ R-3-f · 四条规则，**方向各不相同**
 *
 * 这一套存在的唯一理由：`watermark` 取 min，另外几条取 max / 并集。
 * 光靠记是记不住的 —— 下一个人（包括几个月后的我）一定会想
 * 「顺手统一成 max」。这里让那个念头当场变红。
 */

describe('★★ R-3-f · 导回时哪些事实不许倒退', () => {
  it('墓碑时刻取较晚的 —— 宁可多挡，不可复活', () => {
    assert.equal(mergePurgedAt(2000, 1000), 2000)
    assert.equal(mergePurgedAt(1000, 2000), 2000)
    assert.equal(mergePurgedAt(1000, 1000), 1000)
  })

  it('wipedAt 取较晚的 —— 他按过「清空云端」，那件事发生过', () => {
    assert.equal(mergeWipedAt(2000, 1000), 2000)
    assert.equal(mergeWipedAt(0, 1000), 1000, '当前没清过、备份清过 → 也要认那一次')
  })

  it('★★ watermark 取较**小**的 —— 这一条和上面两条方向相反', () => {
    /**
     * 取 max 的话，备份里那些「当时还没推上去」的行
     * （`updated_at` < 当前水位）从此再也收不到 —— **静默丢数据**。
     * 取 min 的代价只有一次流量：重推一批已经推过的行，
     * 对面判 `same` 跳过，而且写入本来就是幂等的。
     *
     * 一个是「多花一次流量」，一个是「悄悄少一批数据」。不对称。
     */
    assert.equal(mergeWatermark(2000, 1000), 1000, '★★ 取成 max 了 —— 会静默丢数据')
    assert.equal(mergeWatermark(1000, 2000), 1000)
    assert.equal(mergeWatermark(0, 5000), 0, '当前是新装的（水位 0）→ 就该从头收一遍')
  })

  it('★ 三条规则的方向必须**互不相同**，不许被统一', () => {
    // 同一组输入，三个函数应当给出两种不同答案 —— 全一样就说明有人统一过了
    const [a, b] = [2000, 1000]
    assert.equal(mergeWipedAt(a, b), 2000)
    assert.equal(mergeWatermark(a, b), 1000)
    assert.notEqual(
      mergeWipedAt(a, b),
      mergeWatermark(a, b),
      '★★ wipedAt 和 watermark 给出了同一个答案 —— 有人把方向统一了'
    )
  })

  it('applied 取并集 —— 它是缓存，不是事实', () => {
    assert.deepEqual(mergeApplied(['b'], ['a']).sort(), ['a', 'b'])
    assert.deepEqual(mergeApplied(['a'], ['a']), ['a'], '不许重复')
    assert.deepEqual(mergeApplied([], []), [])
  })

  it('applied 那段 JSON 坏了也不能让导回失败', () => {
    assert.deepEqual(parseApplied(null), [])
    assert.deepEqual(parseApplied('这不是 JSON'), [])
    assert.deepEqual(parseApplied('{"a":1}'), [], '不是数组也当空的')
    assert.deepEqual(parseApplied('["a",1,"b"]'), ['a', 'b'], '混进来的非字符串扔掉')
  })

  it('★ 账本按 updated_at 取新的那一行 —— 不是并集', () => {
    assert.equal(ledgerKeepsCurrent(2000, 1000), true, '当前更新 → 留当前（撤销不许被旧备份擦掉）')
    assert.equal(ledgerKeepsCurrent(1000, 2000), false, '备份更新 → 用备份的')
    assert.equal(ledgerKeepsCurrent(1000, 1000), false, '一样新就不动 —— 少写一次')
  })
})
