import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  ABSENT,
  analysisBlockUid,
  decodeParts,
  draftUid,
  escapePart,
  IDENTITY_SPECS,
  IDENTITY_TABLES,
  isNaturalUid,
  itemLectureUid,
  NAT,
  natUid,
  occurrenceLectureUid,
  occurrenceMaterialUid,
  qtypeUid,
  termLedgerUid,
  tombstoneUid
} from './identity.ts'
import { prefUid } from './prefs.ts'
import { SYNC_PROTOCOL_VERSION } from './sync-protocol.ts'
import { canonicalUid, isCanonicalUid, MARK } from './builtin-identity.ts'

/**
 * 确定性跨设备身份 · Step 2 / C-1
 *
 * 这一份守三件事：
 *   ① 编码**可证明无歧义** —— 不同的身份不可能编出同一个串
 *   ② 与既有三种 uid 家族不相交 —— 不会误伤他库里已有的行
 *   ③ 身份算法一变，`SYNC_PROTOCOL_VERSION` 必须跟着变（机器守，不靠记性）
 */

// ══════════════════════════════════════════════════════════════
// ① 编码无歧义
// ══════════════════════════════════════════════════════════════

const NASTY = [
  'a',
  'ab',
  'c',
  'bc',
  '|',
  '||',
  '\\',
  '\\\\',
  '\\p',
  '\\|',
  '|\\',
  'a|b',
  'a\\b',
  'a\\pb',
  'items-3f2a',
  '造句',
  '  前后有空格  ',
  'ＡＢＣ',
  '😀',
  '👨‍👩‍👧‍👦',
  'é',   // 组合字符
  'é',    // 预组合，看起来一样但不是同一个串
  'x'.repeat(1000),
  '\t\n\r',
  'null',
  'undefined',
  '0'
]

describe('编码 · 转义与还原', () => {
  it('转义之后再解回来，一个字节不差', () => {
    for (const s of NASTY) {
      assert.deepEqual(decodeParts(escapePart(s)), [s], `还原不回来：${JSON.stringify(s)}`)
    }
  })

  it('★ 多段拼起来也能原样切回去 —— 这就是「无歧义」的证明', () => {
    for (const a of NASTY) {
      for (const b of NASTY.slice(0, 8)) {
        const joined = [a, b].map(escapePart).join('|')
        assert.deepEqual(decodeParts(joined), [a, b], `切不回来：${JSON.stringify([a, b])}`)
      }
    }
  })

  it('★★ 经典歧义案例：["ab","c"] 和 ["a","bc"] 必须编出不同的串', () => {
    assert.notEqual(natUid('t', ['ab', 'c']), natUid('t', ['a', 'bc']))
  })

  it('★★ 值里带分隔符也不会造成歧义', () => {
    // 不转义的话这两个都会拼成 `a|b|c`
    assert.notEqual(natUid('t', ['a|b', 'c']), natUid('t', ['a', 'b|c']))
    assert.notEqual(natUid('t', ['a\\', 'b']), natUid('t', ['a', '\\b']))
    assert.notEqual(natUid('t', ['a\\p', 'b']), natUid('t', ['a|', 'b']))
  })

  it('同一个身份算两次完全一样', () => {
    for (const s of NASTY) {
      assert.equal(natUid('t', [s, 'x']), natUid('t', [s, 'x']))
    }
  })

  it('不同的表 → 不同的 uid', () => {
    assert.notEqual(natUid('a', ['x']), natUid('b', ['x']))
  })

  it('空段直接抛 —— 空身份不是身份', () => {
    assert.throws(() => natUid('t', []))
    assert.throws(() => natUid('t', ['']))
    assert.throws(() => natUid('t', ['a', '']))
  })

  it('大小写、空白、Unicode 归一化形态**都算不同的身份**（这是决定，不是疏忽）', () => {
    assert.notEqual(qtypeUid('造句'), qtypeUid('造句 '))
    assert.notEqual(qtypeUid('Cloze'), qtypeUid('cloze'))
    assert.notEqual(qtypeUid('é'), qtypeUid('é'))
  })

  it('超长输入不截断 —— 截断会制造碰撞', () => {
    const a = qtypeUid('x'.repeat(5000) + 'A')
    const b = qtypeUid('x'.repeat(5000) + 'B')
    assert.notEqual(a, b)
    assert.ok(a.length > 5000)
  })
})

// ══════════════════════════════════════════════════════════════
// ② 与既有 uid 家族不相交
// ══════════════════════════════════════════════════════════════

describe('和库里已有的 uid 不相交', () => {
  it('★★ 十万个真随机 uid，没有一个长得像确定性身份', () => {
    // 触发器那条路：`<表>-` + lower(hex(randomblob(8)))
    const HEX = '0123456789abcdef'
    for (let i = 0; i < 100_000; i++) {
      let tail = ''
      for (let j = 0; j < 16; j++) tail += HEX[Math.floor(Math.random() * 16)]
      assert.equal(isNaturalUid(`items-${tail}`), false, `随机 uid 被认成了确定性身份：items-${tail}`)
    }
  })

  it('结构论证：`nat` 里的 n / t 都不是十六进制字符', () => {
    for (const c of NAT) assert.equal('0123456789abcdef'.includes(c), c === 'a')
    assert.ok(NAT.includes('n') && NAT.includes('t'))
  })

  it('V9 回填那一路（第二段以数字开头）也不相交', () => {
    assert.equal(isNaturalUid('items-1k3j9xab12cd-42'), false)
  })

  it('出厂那一路（builtin）不相交', () => {
    assert.equal(isNaturalUid(`tutors-${MARK}-1`), false)
  })

  it('确定性身份自己认得出来', () => {
    assert.equal(isNaturalUid(itemLectureUid('items-a', 'lectures-b')), true)
    assert.equal(isNaturalUid(qtypeUid('造句')), true)
  })
})

// ══════════════════════════════════════════════════════════════
// ③ 七个具名入口
// ══════════════════════════════════════════════════════════════

describe('七个具名入口', () => {
  it('每一个都带自己的表名前缀', () => {
    assert.ok(itemLectureUid('i', 'l').startsWith(`item_lectures-${NAT}-`))
    assert.ok(analysisBlockUid('i', 'summary').startsWith(`analysis_blocks-${NAT}-`))
    assert.ok(draftUid('s', 'q').startsWith(`drafts-${NAT}-`))
    assert.ok(tombstoneUid('items', 'items-x').startsWith(`tombstones-${NAT}-`))
    assert.ok(qtypeUid('k').startsWith(`qtypes-${NAT}-`))
    assert.ok(occurrenceMaterialUid('i', 'm').startsWith(`occurrences-${NAT}-`))
    assert.ok(termLedgerUid('n', 'deleted', null).startsWith(`term_ledger-${NAT}-`))
  })

  it('★ 参数顺序不能互换 —— 换了就是另一个身份', () => {
    assert.notEqual(itemLectureUid('a', 'b'), itemLectureUid('b', 'a'))
    assert.notEqual(draftUid('a', 'b'), draftUid('b', 'a'))
    assert.notEqual(tombstoneUid('items', 'x'), tombstoneUid('x', 'items'))
  })

  it('★★ occurrences 两个分支永远不会撞', () => {
    // 同一条知识点、material 的 uid 和 lecture 的 uid 恰好相同（构造出来的极端情况）
    assert.notEqual(occurrenceMaterialUid('i', 'same'), occurrenceLectureUid('i', 'same'))
  })

  it('★ term_ledger：全局作用域用占位符，和「真有一讲」分得开', () => {
    assert.equal(termLedgerUid('n', 'v', null), termLedgerUid('n', 'v', ''))
    assert.notEqual(termLedgerUid('n', 'v', null), termLedgerUid('n', 'v', 'lectures-x'))
    // 占位符不可能等于一个真的 uid（uid 一律是 `<表>-…`）
    assert.ok(!ABSENT.includes('-') || ABSENT === '-')
    assert.notEqual(termLedgerUid('n', 'v', ABSENT + 'x'), termLedgerUid('n', 'v', null))
  })

  it('★ 题型：出厂的和他自己建的走同一条规则', () => {
    assert.equal(canonicalUid('qtypes', { builtin: 1, key: '造句' }), qtypeUid('造句'))
    assert.equal(isCanonicalUid(qtypeUid('我自己的题型')), true)
  })

  it('规格表和具名入口对得上', () => {
    assert.deepEqual([...IDENTITY_TABLES].sort(), [
      'analysis_blocks',
      'drafts',
      'item_lectures',
      'occurrences',
      'qtypes',
      /**
       * ★ D-296 · 认读卡（V34 从 items 拆出来）。身份 = 那条知识点，一比一。
       *
       * **协议版本没有跟着加一** —— 和 Step 5A 同一个理由：
       * 线上格式与语义一个字没变，变的是「同步表面多了一张表」，
       * 那件事由**结构指纹**表达（30 → 31 张表），老设备照样被握手挡住。
       * 所以 `identityFingerprint()` 的样本数组**有意不加** `readingCardUid` ——
       * 加了就得往 IDENTITY_HISTORY 加一行，而那要求一个新版本号。
       * 使用者 2026-08-25 明确裁决：先不做协议升级。
       */
      'reading_cards',
      'term_ledger',
      'tombstones',
      // ★ Step 5A · 偏好也走同一套确定性身份（两台改同一项落在同一个 uid 上）
      'user_preferences'
    ])
    for (const s of IDENTITY_SPECS) {
      assert.ok(s.says.length > 0, `${s.table} 没写清楚业务身份是什么`)
      assert.ok(s.sql('x').includes(`${s.table}-${NAT}-`), `${s.table} 的 SQL 没带表名前缀`)
      assert.ok(s.groupBy('x').includes('x.'), `${s.table} 的分组表达式没用别名`)
    }
  })
})

// ══════════════════════════════════════════════════════════════
// ④ ★★ 身份算法一变，协议版本必须跟着变
// ══════════════════════════════════════════════════════════════

/**
 * 「身份算法长什么样」的指纹：拿一组固定输入算一遍，把结果哈希。
 * 编码规则、分隔符、表名前缀、参数顺序 —— 任何一处变了它都会变。
 */
function identityFingerprint(): string {
  const samples = [
    itemLectureUid('items-aaa', 'lectures-bbb'),
    analysisBlockUid('items-aaa', 'summary'),
    analysisBlockUid('items-aaa', 'a|b\\c'),
    draftUid('sessions-1', 'questions-2'),
    tombstoneUid('items', 'items-zzz'),
    qtypeUid('造句'),
    qtypeUid('a|b'),
    occurrenceMaterialUid('items-aaa', 'materials-ccc'),
    occurrenceLectureUid('items-aaa', 'lectures-bbb'),
    termLedgerUid('hold sway', 'deleted', null),
    termLedgerUid('hold sway', 'deleted', 'lectures-bbb'),
    prefUid('param.dailyTarget'),
    prefUid('a|b')
  ]
  return createHash('sha256').update(samples.join(' ')).digest('hex').slice(0, 16)
}

/**
 * ★★ 历史表：每一版身份语义对应一个协议版本。
 *
 * 加一条的时机：`identityFingerprint()` 变了。而它一变，下面两条断言里
 * 必然有一条红 —— 你要么得往表里加一行、要么得把 `SYNC_PROTOCOL_VERSION` 加一。
 * **两件事被绑在一起，不靠谁记得。**
 *
 * 为什么非得绑：C-1 换的是 uid 怎么算，**结构指纹一个字都不会变**
 * （列、索引、触发器名字全没动）。少了这条绑定，一台回填过、一台没回填的
 * 两台设备会互相写坏，而握手一声不吭。
 */
const IDENTITY_HISTORY: { protocolVersion: number; fingerprint: string; what: string }[] = [
  { protocolVersion: 2, fingerprint: '7cf22e88bc80358c', what: 'C-1 · 七张表改用确定性身份' },
  /**
   * ★ Step 5A 多了第八种身份（`user_preferences` 按键名算）。
   *
   * 协议版本**没有跟着加一**，因为线上格式与语义一个字没变 ——
   * 变的是「同步表面多了一张表」，那件事由**结构指纹**表达
   * （它确实变了：dba617f71fadcab4 → 9dde78ab1d916501），老设备照样被握手挡住。
   * 所以这一版仍记在第 3 版名下。
   *
   * 这条注释本身就是那道闸要的东西：改身份必须停下来，说清楚它属于哪一版、为什么。
   */
  { protocolVersion: 3, fingerprint: 'c73765c111c68a3d', what: 'Step 5A · 偏好也用确定性身份' }
]

describe('★★ 身份算法与协议版本绑在一起', () => {
  it('当前算法的指纹必须在历史表里', () => {
    const fp = identityFingerprint()
    const hit = IDENTITY_HISTORY.find((h) => h.fingerprint === fp)
    assert.ok(
      hit,
      `★★ 身份算法变了（指纹 ${fp}），但 IDENTITY_HISTORY 里没有这一版。\n` +
        `  改身份算法就等于改同步语义 —— 往历史表里加一行，并把 SYNC_PROTOCOL_VERSION 加一。\n` +
        `  不加的后果：一台回填过、一台没回填，两台互相写坏，而握手不会拦。`
    )
  })

  it('★ 协议版本不许低于当前算法那一版', () => {
    /**
     * ★★ 为什么是 `>=` 而不是 `==`（Step 3 放宽的）：
     *
     * 协议版本会因为**别的**语义变化而升（C-2 把 id 换成 uid 就是一次，
     * 身份算法一个字没动）。硬要求相等，会逼着每次协议升级都假装身份变了。
     *
     * 「改了身份却不升协议」这条仍然堵得死 —— 靠的是下面那条唯一性：
     * 改身份 → 指纹变 → 上一条要求你往表里加一行 → 那一行要写一个协议版本 →
     * 已经用过的版本号不许再用 → 你只能填一个新的 → 而它又不许超过当前版本
     * → 于是你必须把 `SYNC_PROTOCOL_VERSION` 也加一。
     */
    const fp = identityFingerprint()
    const hit = IDENTITY_HISTORY.find((h) => h.fingerprint === fp)
    if (!hit) return // 上一条已经红了
    assert.ok(
      SYNC_PROTOCOL_VERSION >= hit.protocolVersion,
      `★★ 身份算法是第 ${hit.protocolVersion} 版，而 SYNC_PROTOCOL_VERSION = ${SYNC_PROTOCOL_VERSION}`
    )
    for (const h of IDENTITY_HISTORY) {
      assert.ok(
        h.protocolVersion <= SYNC_PROTOCOL_VERSION,
        `★★ 历史表里有一版（${h.protocolVersion}）比当前协议版本还新 —— 改了身份没升协议`
      )
    }
  })

  it('★ 历史表里的版本号不许重复 —— 否则「加一行」就能绕过上面那条', () => {
    const seen = new Set<number>()
    for (const h of IDENTITY_HISTORY) {
      assert.ok(!seen.has(h.protocolVersion), `协议版本 ${h.protocolVersion} 在历史表里出现了两次`)
      seen.add(h.protocolVersion)
    }
  })

  it('身份历史与当前协议版本的对应关系', () => {
    /**
     * C-1（七张表）记在第 2 版；Step 5A（偏好）记在第 3 版 ——
     * 后者**没有**让协议加一，因为线上格式没变，变的是同步表面多了一张表，
     * 那件事由结构指纹表达。两条线各管各的，正是 D-269 那条裁决。
     */
    assert.equal(IDENTITY_HISTORY.find((h) => h.what.startsWith('C-1'))?.protocolVersion, 2)
    assert.equal(IDENTITY_HISTORY.at(-1)?.protocolVersion, 3)
    assert.equal(SYNC_PROTOCOL_VERSION, 3)
  })
})
