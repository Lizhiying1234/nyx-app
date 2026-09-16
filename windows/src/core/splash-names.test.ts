import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_LABEL,
  SKEW_TOLERANCE,
  cleanLabel,
  decodeLabels,
  decodeMeta,
  isGone,
  defaultLabel,
  encodeLabels,
  encodeMeta,
  isMetaEntry,
  revive,
  tombstone,
  labelSkew,
  metaKey,
  nameOfMeta,
  pickLabel
} from './splash-names.ts'

/**
 * 启动页图片名字的判据 · 使用者 2026-09-13
 *
 * ★★ 这一套里最要紧的不是「取名对不对」，是**两端不会来回覆盖对方**。
 *   「谁赢」两端各写一份必然在某个边角上不一致，而不一致的表现是
 *   两台机器轮流把名字改回自己那一份 —— 最难查的那种抖动。
 */

const L = (label: string, at: number) => ({ label, at })

describe('★★★ 谁赢 —— 最后一次修改为准', () => {
  it('★ 晚的赢', () => {
    assert.deepEqual(pickLabel(L('甲', 100), L('乙', 200)), L('乙', 200))
    assert.deepEqual(pickLabel(L('甲', 300), L('乙', 200)), L('甲', 300))
  })

  it('★★★ 时间一样 → 取字典序大的。**不是它更对，是它稳定**', () => {
    const a = L('apple', 500)
    const b = L('banana', 500)
    // 两端各自算，顺序反过来也得是同一个答案 —— 否则就会来回翻
    assert.deepEqual(pickLabel(a, b), b)
    assert.deepEqual(pickLabel(b, a), b, '★★★ 换个顺序结果就变了 —— 这就是那种来回翻')
  })

  it('★ 只有一边有 → 就是它', () => {
    assert.deepEqual(pickLabel(L('甲', 1), null), L('甲', 1))
    assert.deepEqual(pickLabel(null, L('乙', 1)), L('乙', 1))
    assert.equal(pickLabel(null, null), null)
  })

  it('★★ 反复算不会变（幂等）—— 同步会跑很多趟', () => {
    let cur = pickLabel(L('甲', 100), L('乙', 200))
    for (let i = 0; i < 5; i++) cur = pickLabel(cur, L('甲', 100))
    assert.deepEqual(cur, L('乙', 200), '★★ 跑几趟之后名字变了 = 两端会一直互相覆盖')
  })
})

describe('★★ 时钟偏移 —— 钟快的那一端会永久赢，而屏上什么都不报', () => {
  const seen = 1_700_000_000_000

  it('★ 正常范围内不报', () => {
    assert.equal(labelSkew(seen - 1000, seen), 0)
    assert.equal(labelSkew(seen + SKEW_TOLERANCE - 1, seen), 0)
  })

  it('★★★ 明显超前 → 报出超前了多少', () => {
    const ahead = labelSkew(seen + SKEW_TOLERANCE + 60_000, seen)
    assert.ok(ahead > 0, '★★★ 钟快一天的那一端会永久赢 —— 这一条不报就没人会发现')
    assert.equal(ahead, SKEW_TOLERANCE + 60_000)
  })

  it('★ 还没见过远端（第一次同步）→ 不报（没有可比的基准，报了是噪音）', () => {
    assert.equal(labelSkew(seen + 999_999_999, 0), 0)
  })

  it('★ 脏数据不抛', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.doesNotThrow(() => labelSkew(bad, seen))
      assert.equal(labelSkew(bad, seen), 0)
    }
  })
})

describe('★★ meta 不能被当成图片', () => {
  it('★★★ 列出来的 meta 项要认得出来 —— 不然每同步一次就塞一条假问题', () => {
    assert.ok(isMetaEntry('abc123.webp.meta.json'))
    assert.ok(!isMetaEntry('abc123.webp.json'))
    assert.ok(!isMetaEntry('abc123.webp'))
  })

  it('★ 从 meta 项取回图片名', () => {
    assert.equal(nameOfMeta('abc123.webp.meta.json'), 'abc123.webp')
  })

  it('★ 键的形状', () => {
    assert.equal(metaKey('abc.webp'), 'nyx/splash/abc.webp.meta.json')
  })
})

describe('★ 名字本身', () => {
  it('★ 压掉换行与多余空白、截断', () => {
    assert.equal(cleanLabel('  秋天\n\n 那张 '), '秋天 那张')
    assert.equal(cleanLabel('x'.repeat(200)).length, MAX_LABEL)
    assert.equal(cleanLabel(null), '')
    assert.equal(cleanLabel(42), '')
  })
})

describe('★★ 默认名 —— 算出来的，不存', () => {
  it('★★★ 同一张图两端算出来必须一模一样（否则看起来像同步坏了）', () => {
    const n = '43d66fabc'.padEnd(64, '0') + '.webp'
    assert.equal(defaultLabel(n), '图 43d66f')
  })

  it('★ 脏输入不抛', () => {
    for (const bad of ['', null, 42, undefined]) {
      assert.doesNotThrow(() => defaultLabel(bad as unknown as string))
    }
    assert.equal(defaultLabel(''), '图')
  })

  it('★★ 默认名**不进存储** —— 存了就是两条凭空的改名记录在互相覆盖', () => {
    // 存储里只该有他显式改过的；这里用 encode/decode 代表「存进去的那一份」
    const stored = decodeLabels(encodeLabels({}))
    assert.deepEqual(stored, {}, '★★ 没人起过名 → 存储是空的，没有东西可冲突')
  })
})

describe('★ 存进去、读回来（绝不抛）', () => {
  it('★ 来回一趟', () => {
    const m = { 'a.webp': L('秋天', 100), 'b.png': L('冬天', 200) }
    assert.deepEqual(decodeLabels(encodeLabels(m)), m)
  })

  it('★★ 什么垃圾都不抛', () => {
    for (const bad of ['', '  ', 'x', '[]', 'null', '{"a":1}', '{"a":{"label":""}}', 42, null, undefined]) {
      assert.doesNotThrow(() => decodeLabels(bad))
      assert.deepEqual(typeof decodeLabels(bad), 'object')
    }
  })

  it('★ 没名字的那一条整条丢掉（一张没有名字的图 = 没存过名字）', () => {
    assert.deepEqual(decodeLabels('{"a.webp":{"label":"   ","at":1}}'), {})
  })

  it('★ 桶里那一份来回一趟，坏的给 null', () => {
    assert.deepEqual(decodeMeta(encodeMeta(L('秋天', 7))), L('秋天', 7))
    for (const bad of ['', 'x', '{}', '{"label":"  "}', null, 42]) {
      assert.doesNotThrow(() => decodeMeta(bad))
      assert.equal(decodeMeta(bad), null)
    }
  })

  it('★ at 缺了就当 0 —— 有名字总比因为缺个数字丢掉强', () => {
    assert.deepEqual(decodeMeta('{"label":"秋天"}'), L('秋天', 0))
  })
})


/**
 * ══ 墓碑（使用者 2026-09-14 裁「选 a：连桶一起删」）═══════════════════
 *
 * `gone` 是**三态**，而三态里最容易写错的是「缺失」那一档 ——
 * 把它当成 `false` 的话，任何一条老 meta 都会变成一次「声明它活着」，
 * 于是**能压过另一端刚写的墓碑**：他删的东西又回来了，而屏上什么都不说。
 */
describe('★★★ 墓碑 · 三态与谁赢', () => {
  it('★★★ 平局时**活的赢** —— 判错一次的后果不对称', () => {
    const dead = { label: 'x', at: 100, gone: true }
    const live = { label: 'a', at: 100, gone: false }
    /**
     * ★ 注意 label 字典序是 'x' > 'a'，所以**只看名字的话死的会赢**。
     *   这一条钉的正是「死活先于名字」。
     *   理由：误留一张图他自己再删一次就行；误删一张（桶里那份也删了）要从头找回来。
     */
    assert.equal(pickLabel(dead, live), live)
    assert.equal(pickLabel(live, dead), live)
  })

  it('★★★ 「没表态」压不过墓碑（平局时也算活的，但更新的碑要赢）', () => {
    const none = { label: 'zzz', at: 100 }
    const dead = { label: 'a', at: 900, gone: true }
    assert.equal(pickLabel(none, dead), dead, '更新的碑输给了一条老名字')
  })

  it('★★ 死活相同时仍然按字典序 —— 两端各自算要得到同一个结果', () => {
    const a = { label: 'a', at: 100, gone: true }
    const b = { label: 'b', at: 100, gone: true }
    assert.equal(pickLabel(a, b), b)
    assert.equal(pickLabel(b, a), b)
  })

  it('★★★ encodeMeta 没表态时**不写那一栏** —— 写了就成了「声明它活着」', () => {
    assert.equal(JSON.parse(encodeMeta({ label: 'x', at: 1 })).gone, undefined)
    assert.equal(JSON.parse(encodeMeta({ label: 'x', at: 1, gone: true })).gone, true)
    assert.equal(JSON.parse(encodeMeta({ label: 'x', at: 1, gone: false })).gone, false)
  })

  it('★★★ 只有碑、没有名字的 meta 也算数 ——「没名字就丢掉」对碑是致命的', () => {
    const m = decodeMeta(JSON.stringify({ label: '', at: 5, gone: true }))
    assert.ok(m, '★★ 一张从没起过名的图被删掉之后，碑被扔了 —— 它会从桶里回来')
    assert.equal(isGone(m), true)
  })

  it('★★ 只有名字、没有碑的 meta 照旧（不许凭空补一个 gone）', () => {
    const m = decodeMeta(JSON.stringify({ label: '秋天', at: 5 }))
    assert.deepEqual(m, { label: '秋天', at: 5 })
  })

  it('★★★ `gone` 只认真正的布尔 —— "false" / 0 / null 一律当没表态', () => {
    for (const junk of ['false', 0, 1, null, 'true', {}]) {
      const m = decodeMeta(JSON.stringify({ label: 'x', at: 5, gone: junk }))
      assert.equal(m?.gone, undefined, String(junk))
    }
  })

  it('★★★ 墓碑穿得过本地那张表的存 → 读（写漏一栏就是「删了又回来」）', () => {
    const back = decodeLabels(encodeLabels({ [hexName]: { label: '', at: 7, gone: true } }))
    assert.equal(isGone(back[hexName]), true)
  })

  it('★★ tombstone / revive：名字留着，时间推走，gone 写显式值', () => {
    const prev = { label: '秋天', at: 100 }
    const t = tombstone(prev, 500)
    assert.deepEqual(t, { label: '秋天', at: 500, gone: true })
    const r = revive(t, 900)
    assert.deepEqual(r, { label: '秋天', at: 900, gone: false })
    assert.equal(pickLabel(t, r), r, '加回来的那一次没压过碑')
  })
})

/** 一个合法资源名的形状（64 位 hex + 扩展名）*/
const hexName = 'a'.repeat(64) + '.webp'
