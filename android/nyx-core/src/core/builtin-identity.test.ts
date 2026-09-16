import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { qtypeUid } from './identity.ts'
import { randomBytes } from 'node:crypto'
import { BUILTIN_TABLES, canonicalUid, HEX, isCanonicalUid, MARK } from './builtin-identity.ts'

/**
 * ★★ R-4-G · 「同一个出厂内容，在两台设备上是同一个对象」
 *
 * 这一套只验那条推导本身。它没有库、没有网络、跑得飞快 ——
 * 所以「十万个随机 uid 一个都不许撞上」这种断言在这里才写得起。
 */

describe('★★ R-4-G · 出厂内容的跨设备身份', () => {
  it('qtypes 认 key —— 名字改了、序位挪了，身份不变', () => {
    const a = canonicalUid('qtypes', { builtin: 1, key: '造句', ordinal: 1 })
    const b = canonicalUid('qtypes', { builtin: 1, key: '造句', ordinal: 9 })
    /**
     * ★★ Step 2 · C-1 之后**格式换了**：以前是这里自己拼 `qtypes-builtin-<key>`，
     * 而他自己建的题型是随机 uid —— 同一张表两套身份规则，两台各建一个同名题型就撞。
     * 现在出厂的和他自己建的都走 `core/identity.ts::qtypeUid(key)`。
     *
     * **这一条要验的东西一个字没变**：身份是 `key`，序位挪了不算变。
     * 变的只是那个串长什么样，所以断言从写死的字面量改成「必须等于唯一那份规则算出来的」——
     * 写死字面量等于在这里留第二份定义，正是这一轮要消灭的东西。
     */
    assert.equal(a, qtypeUid('造句'))
    assert.equal(a, b, '★ 序位一变身份就变了 —— 那 key 就不是身份')
    assert.notEqual(a, qtypeUid('造句 '), 'key 不同就该是不同的身份')
  })

  it('另外三张认出厂序位 —— 名字随便改，身份不变', () => {
    assert.equal(canonicalUid('tutors', { builtin: 1, ordinal: 1 }), 'tutors-builtin-1')
    assert.equal(canonicalUid('genres', { builtin: 1, ordinal: 4 }), 'genres-builtin-4')
    assert.equal(
      canonicalUid('prompt_presets', { builtin: 1, ordinal: 3 }),
      'prompt_presets-builtin-3'
    )
  })

  it('★ 用户自己建的一律返回 null —— 调用方据此一个字都不动', () => {
    for (const t of BUILTIN_TABLES) {
      assert.equal(canonicalUid(t, { builtin: 0, key: '造句', ordinal: 1 }), null, t)
      assert.equal(canonicalUid(t, { key: '造句', ordinal: 1 }), null, `${t}（builtin 缺省）`)
      assert.equal(canonicalUid(t, { builtin: null, ordinal: 1 }), null, `${t}（builtin 是 null）`)
    }
  })

  it('不是这四张表的，一律 null —— 别的同步表不该有出厂身份这回事', () => {
    for (const t of ['items', 'lectures', 'projects', 'term_ledger', 'settings']) {
      assert.equal(canonicalUid(t, { builtin: 1, ordinal: 1 }), null, t)
    }
  })

  it('算不出来时宁可返回 null，也不许编一个出来', () => {
    assert.equal(canonicalUid('qtypes', { builtin: 1, key: '' }), null, 'key 是空的')
    assert.equal(canonicalUid('qtypes', { builtin: 1, key: '   ' }), null, 'key 只有空白')
    assert.equal(canonicalUid('qtypes', { builtin: 1 }), null, '没给 key')
    assert.equal(canonicalUid('tutors', { builtin: 1, ordinal: 0 }), null, '序位从 1 开始')
    assert.equal(canonicalUid('tutors', { builtin: 1, ordinal: -1 }), null)
    assert.equal(canonicalUid('tutors', { builtin: 1, ordinal: 1.5 }), null, '序位得是整数')
    assert.equal(canonicalUid('tutors', { builtin: 1 }), null, '没给序位')
  })

  it('★ 稳定：同样的输入调一万次，结果一个字不差；也不改传进去的东西', () => {
    const input = { builtin: 1, key: '搭配填空', ordinal: 2 }
    const snapshot = JSON.stringify(input)
    const first = canonicalUid('qtypes', input)
    for (let i = 0; i < 10_000; i++) assert.equal(canonicalUid('qtypes', input), first)
    assert.equal(JSON.stringify(input), snapshot, '★ 它改了调用方的数据')
  })

  it('★ 不依赖时间、不依赖设备 —— 跨进程重算必然一样', () => {
    // 真正的判据是「函数体里没有任何非确定性输入」，这里把它写成可执行的：
    // 隔着时间跑两次、并且断言结果里不含任何时间戳形状的东西
    const a = canonicalUid('genres', { builtin: 1, ordinal: 2 })!
    const b = canonicalUid('genres', { builtin: 1, ordinal: 2 })!
    assert.equal(a, b)
    assert.doesNotMatch(a, /\d{10,}/, `★ 身份里混进了时间戳：${a}`)
  })

  it('★★ 结构上不相交：标记段里必须有非十六进制字符', () => {
    /**
     * ★ 这一条才是真正的证明，下面那条十万次抽样是它的补充。
     *
     * 触发器生成的 uid 是 `<表名>-` + `lower(hex(randomblob(8)))` ——
     * 第二段**只可能**由 [0-9a-f] 组成。所以只要标记段里有一个字符不在里面，
     * 两个命名空间就**不可能**相交，与随机数好坏无关。
     *
     * 抽样验不出这一点：把标记换成 `beef`（全是十六进制字符、真的会相交），
     * 十万次照样一次都抽不中 —— 那条用例会假绿。这条不会。
     */
    const offenders = [...MARK].filter((c) => HEX.includes(c))
    assert.equal(
      offenders.length < MARK.length,
      true,
      `★ 标记段「${MARK}」整段都是十六进制字符 —— 它和触发器生成的 uid 在同一个命名空间里，迟早撞`
    )
    // 而且第二段的长度也对不上：触发器那段恒为 16 位
    assert.notEqual(MARK.length, 16, '★ 标记段正好 16 位，和触发器那段等长')
  })

  it('★★ 十万个真随机 uid，一个都不许撞上 canonical 的命名空间', () => {
    /**
     * 库里的 uid 只有三种来源，这里把前两种**照原样**造出来：
     *   ① 触发器：`<表名>-` + lower(hex(randomblob(8)))
     *   ② V9 回填：`<表名>-<base36 时间戳 + 6 位随机>-<id>`
     * 第三种就是 canonical。三者不相交是这套方案能成立的前提，
     * 而「前提」不能只写在注释里 —— 它得能红。
     */
    const canon = new Set<string>()
    for (const t of BUILTIN_TABLES) {
      for (let i = 1; i <= 50; i++) canon.add(`${t}-builtin-${i}`)
    }
    for (const k of ['造句', '搭配填空', '开放填空', '句子改写', '错误订正']) {
      canon.add(`qtypes-builtin-${k}`)
    }

    for (let i = 0; i < 50_000; i++) {
      const t = BUILTIN_TABLES[i % BUILTIN_TABLES.length]!
      const trigger = `${t}-${randomBytes(8).toString('hex')}`
      assert.equal(isCanonicalUid(trigger), false, `★ 触发器生成的撞进了 canonical：${trigger}`)
      assert.equal(canon.has(trigger), false, `★ 撞上了具体某一个 canonical：${trigger}`)
    }

    for (let i = 0; i < 50_000; i++) {
      const t = BUILTIN_TABLES[i % BUILTIN_TABLES.length]!
      const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const legacy = `${t}-${seed}-${(i % 30) + 1}`
      assert.equal(isCanonicalUid(legacy), false, `★ V9 老格式撞进了 canonical：${legacy}`)
      assert.equal(canon.has(legacy), false, `★ 撞上了具体某一个 canonical：${legacy}`)
    }
  })

  it('isCanonicalUid 认得出自己生成的，也不误认别的', () => {
    assert.equal(isCanonicalUid(canonicalUid('tutors', { builtin: 1, ordinal: 1 })!), true)
    assert.equal(isCanonicalUid(canonicalUid('qtypes', { builtin: 1, key: '造句' })!), true)
    assert.equal(isCanonicalUid('tutors-builtin-'), false, '后面得真有东西')
    assert.equal(isCanonicalUid('items-builtin-1'), false, '不是那四张表')
    assert.equal(isCanonicalUid('tutors-abc123'), false)
  })
})
