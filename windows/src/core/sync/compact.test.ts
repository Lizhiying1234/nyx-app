/**
 * 云端压实 · T-2.2 —— 判据用例（内存 store 替身）
 *
 * 这一套只验**压实自己的判据**：什么进快照、什么不进、什么时候拒绝动手。
 * 真 HTTP 那一层（WebDAV 的 DELETE 真的删得掉吗）在 `tests/sync.test.ts` 里，
 * 那边跑的是进程内的真 WebDAV。
 *
 * ★ 三条负向对照是这一套的重点，不是附赠品：
 *   ① 核对故意不一致 → 一个老包都不许删
 *   ② 只剩一份     → 拒
 *   ③ 没有删除权限   → 拒，而且**在写任何东西之前**就拒
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyChunk, type LocalIdentity } from '../sync-protocol.ts'
import type { SyncRow } from '../sync-merge.ts'
import type { Relation } from '../fk-map.ts'
import { absorbed, canon, classifyForFold, compactBucket, planSnapshot } from './compact.ts'
import { planTodo } from './session.ts'
import type { RemoteStore } from './store.ts'

const ID: LocalIdentity = {
  schemaVersion: 38,
  schemaFingerprint: 'cadb369e52c0e335',
  protocolVersion: 3
}

const CHUNKS = 'nyx/chunks'

/** 造一个**普通**变更包 —— 字段和 `engine.run()` 推包那一处一字不差 */
function pack(device: string, at: number, rows: SyncRow[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    device,
    at,
    schemaVersion: ID.schemaVersion,
    schemaFingerprint: ID.schemaFingerprint,
    protocolVersion: ID.protocolVersion,
    rows,
    ...over
  })
}

const row = (table: string, uid: string, updatedAt: number, data: Record<string, unknown> | null = { uid, updated_at: updatedAt }): SyncRow =>
  ({ table, uid, updatedAt, data })

/** 内存 store 替身。`list` 的语义照真实现：只返回**这一层**的文件名 */
class MemStore implements RemoteStore {
  files = new Map<string, string>()
  /**
   * ★ `list` 的顺序 —— 真实现**不保证**它（WebDAV 的 PROPFIND 给服务端的顺序）。
   * 默认按插入顺序给，`reverse` 打开就倒着给：压实必须自己排序才确定。
   */
  reverseList = false
  /** 关掉它就是「这把凭据不能删」 */
  canDelete = true
  /** 读的时候动手脚 —— 负向对照 ① 用 */
  tamper: ((path: string, body: string) => string) | null = null
  deleted: string[] = []

  async list(prefix: string): Promise<string[]> {
    const head = `${prefix}/`
    const out = [...this.files.keys()]
      .filter((k) => k.startsWith(head))
      .map((k) => k.slice(head.length))
      .filter((n) => !n.includes('/'))
    return this.reverseList ? out.reverse() : out
  }

  async get(path: string): Promise<string | null> {
    const v = this.files.get(path)
    if (v === undefined) return null
    return this.tamper ? this.tamper(path, v) : v
  }

  async put(path: string, body: string): Promise<void> {
    this.files.set(path, body)
  }

  async delete(path: string): Promise<void> {
    if (!this.canDelete) throw new Error('这把 key 没有删除权限（403）')
    this.deleted.push(path)
    this.files.delete(path)
  }

  async check(): Promise<void> {}
}

const noFks = (): readonly Relation[] => []

function scene(): MemStore {
  const s = new MemStore()
  s.files.set(
    `${CHUNKS}/aaa-1000.json`,
    pack('aaa', 1000, [row('items', 'u-1', 1000), row('lectures', 'l-1', 1000)])
  )
  s.files.set(`${CHUNKS}/aaa-2000.json`, pack('aaa', 2000, [row('items', 'u-1', 2000)]))
  s.files.set(`${CHUNKS}/bbb-3000.json`, pack('bbb', 3000, [row('items', 'u-2', 3000)]))
  return s
}

/**
 * ★ `applied` 默认把 `bbb-3000.json` 算进去 —— 本机已经吸收过对面那个包。
 * 不这么设的话它按新规矩是 untouched（见 compact.ts 头注那一整段），
 * 而那正是下面「别机包还没应用过」那几条要单独验的事。
 */
const opts = (s: MemStore, over: Partial<Parameters<typeof compactBucket>[0]> = {}) => ({
  store: s,
  device: 'aaa',
  formerDevices: [] as readonly string[],
  applied: ['bbb-3000.json'] as readonly string[],
  identity: ID,
  now: 9000,
  terminated: new Map<string, Set<string>>(),
  fksOf: noFks,
  ...over
})

describe('★★ T-2.2 · 压实的快照里装什么', () => {
  it('同一行只留最新的一版', () => {
    const { rows, dropped } = planSnapshot(
      [
        { name: 'a', rows: [row('items', 'u-1', 1000), row('items', 'u-2', 1000)] },
        { name: 'b', rows: [row('items', 'u-1', 2000)] }
      ],
      new Map(),
      noFks
    )
    assert.equal(dropped, 0)
    assert.equal(rows.length, 2)
    const one = rows.find((r) => r.uid === 'u-1')
    assert.equal(one?.updatedAt, 2000, '★ 留下的不是最新那一版')
  })

  it('★★ 立过碑的那一行不进快照（D-435：云端存量也要清）', () => {
    const { rows, dropped } = planSnapshot(
      [{ name: 'a', rows: [row('items', 'dead', 1000), row('items', 'alive', 1000)] }],
      new Map([['items', new Set(['dead'])]]),
      noFks
    )
    assert.equal(dropped, 1)
    assert.deepEqual(rows.map((r) => r.uid), ['alive'])
  })

  it('★★ 父实体被终结的派生行也不进 —— 它们没有自己的碑，但它们是内容', () => {
    const fks = (t: string): readonly Relation[] =>
      t === 'review_logs' ? [{ column: 'item_id', parent: 'items', syncColumn: 'item_uid' }] : []
    const { rows, dropped } = planSnapshot(
      [
        {
          name: 'a',
          rows: [
            row('review_logs', 'r-1', 1000, { uid: 'r-1', item_uid: 'dead' }),
            row('review_logs', 'r-2', 1000, { uid: 'r-2', item_uid: 'alive' })
          ]
        }
      ],
      new Map([['items', new Set(['dead'])]]),
      fks
    )
    assert.equal(dropped, 1)
    assert.deepEqual(rows.map((r) => r.uid), ['r-2'])
  })

  it('★★★ 墓碑自己那些行永远留着 —— 清掉碑 = 把防复活的护栏从云端拆了', () => {
    const { rows, dropped } = planSnapshot(
      [
        {
          name: 'a',
          rows: [
            row('tombstones', 't-1', 1000, { uid: 't-1', kind: 'items', target_uid: 'dead' }),
            row('items', 'dead', 900)
          ]
        }
      ],
      new Map([['items', new Set(['dead'])]]),
      noFks
    )
    assert.equal(dropped, 1, '★ 被终结的那一行该扔')
    assert.deepEqual(rows.map((r) => r.table), ['tombstones'], '★★ 碑被扔掉了')
  })
})

describe('★★ T-2.2 · 哪些包敢折', () => {
  it('普通包 —— 折', () => {
    const v = classifyForFold(pack('aaa', 1, [row('items', 'u', 1)]), ID)
    assert.equal(v.fold, true)
  })

  it('★ 老包（没有版本头）不折也不删 —— 折了等于把收不了的内容洗成收得了的', () => {
    const v = classifyForFold(JSON.stringify({ rows: [row('items', 'u', 1)] }), ID)
    assert.equal(v.fold, false)
  })

  it('★ 指纹对不上的包不折也不删', () => {
    const v = classifyForFold(pack('aaa', 1, [], { schemaFingerprint: '别的指纹' }), ID)
    assert.equal(v.fold, false)
  })

  it('★ 坏 JSON 不折也不删', () => {
    assert.equal(classifyForFold('{不是 json', ID).fold, false)
  })

  it('★ 行认不出来就整包不敢动', () => {
    const bad = JSON.stringify({
      device: 'a',
      at: 1,
      schemaVersion: ID.schemaVersion,
      schemaFingerprint: ID.schemaFingerprint,
      protocolVersion: ID.protocolVersion,
      rows: [{ uid: 'u', table: 'items' }]
    })
    assert.equal(classifyForFold(bad, ID).fold, false)
  })
})

describe('★★★ T-2.2 · 压实整趟', () => {
  it('正路：写快照 → 核对 → 删老包；快照就是一个普通变更包', async () => {
    const s = scene()
    const r = await compactBucket(opts(s))

    assert.equal(r.ok, true, `★ 压实没成：${r.why}`)
    assert.equal(r.before, 3)
    assert.equal(r.folded, 3)
    assert.equal(r.deleted, 3)
    assert.equal(r.dropped, 0)
    assert.equal(r.rows, 3, '★ items u-1 / lectures l-1 / items u-2')

    const left = await s.list(CHUNKS)
    assert.deepEqual(left, ['aaa-9000.json'], `★ 桶里剩下的不对：${left.join(' · ')}`)

    // ★★ 另一端（哪怕旧版本的 core）读它时不需要知道压实存在
    const body = s.files.get(`${CHUNKS}/aaa-9000.json`)!
    const parsed = JSON.parse(body) as Record<string, unknown>
    assert.deepEqual(
      Object.keys(parsed),
      ['device', 'at', 'schemaVersion', 'schemaFingerprint', 'protocolVersion', 'rows'],
      '★★ 快照的包头多了或少了字段 —— 它就不再是一个普通的包了'
    )
    assert.equal(classifyChunk(parsed, ID).kind, 'accept', '★★ 快照自己都收不进来')
    assert.equal(parsed['device'], 'aaa')
    assert.equal(parsed['at'], 9000)
  })

  it('★ 包名撞上了就往后挪一毫秒，绝不覆盖', async () => {
    const s = scene()
    s.files.set(`${CHUNKS}/aaa-9000.json`, pack('aaa', 9000, [row('materials', 'm-1', 9000)]))
    const r = await compactBucket(opts(s))
    assert.equal(r.ok, true, `★ ${r.why}`)
    assert.equal(r.snapshot, `${CHUNKS}/aaa-9001.json`)
    assert.equal(r.rows, 4, '★ 原来那个 9000 包的行也该折进来')
  })

  it('★ 读不懂的包既不折也不删，如实报出来', async () => {
    const s = scene()
    s.files.set(`${CHUNKS}/zzz-4000.json`, '{坏掉的')
    const r = await compactBucket(opts(s))

    assert.equal(r.ok, true, `★ ${r.why}`)
    assert.equal(r.folded, 3)
    assert.equal(r.untouched.length, 1)
    assert.equal(r.untouched[0]?.name, 'zzz-4000.json')
    assert.ok(
      (await s.list(CHUNKS)).includes('zzz-4000.json'),
      '★★ 把读不懂的包删掉了 —— 不理解的东西不许删'
    )
  })

  it('★ 再压实一次：只剩快照一个包 → 拒（幂等，不会越压越多）', async () => {
    const s = scene()
    assert.equal((await compactBucket(opts(s))).ok, true)
    const again = await compactBucket(opts(s, { now: 10000 }))
    assert.equal(again.ok, false)
    assert.match(again.why ?? '', /只有 1 个变更包/)
    assert.equal((await s.list(CHUNKS)).length, 1, '★ 第二趟不该动任何东西')
  })
})

describe('★★★ T-2.2 · 负向对照 —— 三种情况都必须拒绝动手', () => {
  it('★★★ ① 读回来跟写出去的对不上 → 一个老包都不删', async () => {
    const s = scene()
    // 快照读回来时少一行 —— 模拟「写上去的和读回来的不是一份东西」
    s.tamper = (path, body) => {
      if (!path.includes('-9000.json')) return body
      const p = JSON.parse(body) as { rows: SyncRow[] }
      p.rows = p.rows.slice(1)
      return JSON.stringify(p)
    }

    const r = await compactBucket(opts(s))

    assert.equal(r.ok, false, '★★★ 核对不上却说压实成功了')
    assert.equal(r.deleted, 0, '★★★ 核对不上还是删了老包')
    assert.deepEqual(s.deleted.filter((p) => p.startsWith(CHUNKS)), [], '★★★ 有老包被删掉了')
    assert.match(r.why ?? '', /行数对不上/)
    // 云端仍然是内容的超集：三个老包 + 那个对不上的快照
    assert.equal((await s.list(CHUNKS)).length, 4)
  })

  it('★★★ ①b 行数对但**内容**被改了 → 也不删', async () => {
    const s = scene()
    s.tamper = (path, body) => {
      if (!path.includes('-9000.json')) return body
      const p = JSON.parse(body) as { rows: SyncRow[] }
      p.rows[0]!.data = { 动过手脚: true }
      return JSON.stringify(p)
    }
    const r = await compactBucket(opts(s))
    assert.equal(r.ok, false)
    assert.equal(r.deleted, 0)
    assert.match(r.why ?? '', /内容对不上/)
  })

  it('★★★ ② 只剩一份 → 拒，而且什么都没写', async () => {
    const s = new MemStore()
    s.files.set(`${CHUNKS}/aaa-1000.json`, pack('aaa', 1000, [row('items', 'u-1', 1000)]))
    const r = await compactBucket(opts(s))

    assert.equal(r.ok, false)
    assert.match(r.why ?? '', /只有 1 个变更包/)
    assert.equal(r.deleted, 0)
    assert.deepEqual(await s.list(CHUNKS), ['aaa-1000.json'], '★★ 拒了却还动了桶')
  })

  it('★★★ ③ 没有删除权限 → 拒，而且**在写快照之前**就拒', async () => {
    const s = scene()
    s.canDelete = false
    const before = await s.list(CHUNKS)

    const r = await compactBucket(opts(s))

    assert.equal(r.ok, false)
    assert.equal(r.snapshot, undefined, '★★★ 明知删不掉还是把快照写上去了')
    assert.match(r.why ?? '', /能写、不能删/)
    assert.deepEqual(await s.list(CHUNKS), before, '★★★ 桶被动过了')
  })

  it('★ 核对全过、删到一半失败 → 快照留着，如实报，再跑一次接着删', async () => {
    const s = scene()
    let n = 0
    const realDelete = s.delete.bind(s)
    s.delete = async (path: string): Promise<void> => {
      if (++n === 2) throw new Error('网络断了')
      return realDelete(path)
    }

    const r = await compactBucket(opts(s))

    assert.equal(r.ok, false)
    assert.equal(r.deleted, 2, '★ 删得掉的那些应该照常删掉')
    assert.ok(r.snapshot, '★ 快照该留着')
    assert.match(r.why ?? '', /删不掉/)
    // 云端仍然可读：快照 + 那个没删掉的老包
    const left = await s.list(CHUNKS)
    assert.equal(left.length, 2)
    assert.ok(left.includes('aaa-9000.json'))
  })
})

describe('★★★ T-2.2 · 只折本机吸收过的包（不然快照本机自己永远读不到）', () => {
  it('资格判据和 planTodo 的 `mine` 同一份算法（含旧号、空号不算）', () => {
    const none = new Set<string>()
    assert.equal(absorbed('aaa-1.json', 'aaa', [], none), true, '本机推的')
    assert.equal(absorbed('old-1.json', 'aaa', ['old'], none), true, '旧号推的也是自己推的')
    assert.equal(absorbed('bbb-1.json', 'aaa', [], none), false, '别机推的、没吸收过')
    assert.equal(absorbed('bbb-1.json', 'aaa', [], new Set(['bbb-1.json'])), true, 'applied 里有')
    // ★ 空号不算 —— `-` 开头的前缀会把别人的包全误伤成自己的（planTodo 同款）
    assert.equal(absorbed('bbb-1.json', '', [''], none), false)
  })

  it('★★★ a) 别机包不在 applied 里 → untouched、没被删，其余照折', async () => {
    const s = scene()
    // 对面又推了一个，本机这一趟还没应用过它
    s.files.set(`${CHUNKS}/bbb-4000.json`, pack('bbb', 4000, [row('items', 'u-3', 4000)]))

    const r = await compactBucket(opts(s)) // applied 里只有 bbb-3000

    assert.equal(r.ok, true, `★ ${r.why}`)
    assert.equal(r.folded, 3, '★ 该折的是 aaa-1000 / aaa-2000 / bbb-3000')
    assert.deepEqual(
      r.untouched.map((u) => u.name),
      ['bbb-4000.json']
    )
    assert.match(r.untouched[0]!.why, /还没应用过/)

    const left = await s.list(CHUNKS)
    assert.ok(left.includes('bbb-4000.json'), '★★★ 把本机还没应用过的包删掉了 —— 那些行就丢了')
    assert.equal(left.length, 2, `★ 桶里该剩快照 + bbb-4000：${left.join(' · ')}`)

    // 它的行也不该混进快照 —— 快照本机不读，混进去等于把它藏起来
    const rows = (JSON.parse(s.files.get(`${CHUNKS}/aaa-9000.json`)!) as { rows: SyncRow[] }).rows
    assert.ok(!rows.some((x) => x.uid === 'u-3'), '★★ 没吸收过的行进了快照')

    // ★ 它仍然轮得到：本机下一趟 run 照常会读它
    assert.deepEqual(
      planTodo({ available: left, device: 'aaa', formerDevices: [], applied: [], wipedAt: 0 }),
      ['bbb-4000.json']
    )
  })

  it('★★★ b) 负向对照：资格闸放行 → 那个包被删，而快照本机永远不会再读', async () => {
    const s = scene()
    s.files.set(`${CHUNKS}/bbb-4000.json`, pack('bbb', 4000, [row('items', 'u-3', 4000)]))

    // 把资格闸打开（= 修复之前的行为：不问吸收过没有，一律折）
    const r = await compactBucket(opts(s, { applied: ['bbb-3000.json', 'bbb-4000.json'] }))

    assert.equal(r.ok, true)
    assert.equal(r.folded, 4)
    const left = await s.list(CHUNKS)
    assert.deepEqual(left, ['aaa-9000.json'], '★ 前提：这一路会把别机包也删掉')

    /**
     * ★★★ 这就是那条数据丢失：桶里只剩本机名下的快照，
     * 而 `planTodo` 的第一道过滤是「自己推的不下」 —— 本机永远读不到它。
     * u-3 那一行对本机就没了，而对面的水位早已走过去。
     */
    assert.deepEqual(
      planTodo({ available: left, device: 'aaa', formerDevices: [], applied: [], wipedAt: 0 }),
      [],
      '★★★ 如果这里不是空的，说明 planTodo 的判据变了 —— 那 a) 那条闸的理由要重写'
    )
  })
})

describe('★★ T-2.2 · 折之前先按包名排序（store.list 的顺序不保证）', () => {
  /** 同一行、**同一个 updatedAt**、内容不同 —— 只有排序能让「谁赢」确定 */
  function tie(): MemStore {
    const s = new MemStore()
    s.files.set(`${CHUNKS}/aaa-1000.json`, pack('aaa', 1000, [row('items', 'u-1', 5000, { v: '早' })]))
    s.files.set(`${CHUNKS}/aaa-2000.json`, pack('aaa', 2000, [row('items', 'u-1', 5000, { v: '晚' })]))
    return s
  }

  const winner = async (s: MemStore): Promise<unknown> => {
    const r = await compactBucket(opts(s, { applied: [] }))
    assert.equal(r.ok, true, `★ ${r.why}`)
    const rows = (JSON.parse(s.files.get(r.snapshot!)!) as { rows: SyncRow[] }).rows
    return rows[0]!.data
  }

  it('★★ list 正着给和倒着给，赢的必须是同一版', async () => {
    const a = tie()
    const b = tie()
    b.reverseList = true
    assert.deepEqual(await winner(a), { v: '晚' }, '★ 包名大的那一版该赢')
    assert.deepEqual(await winner(b), { v: '晚' }, '★★ 顺序一反结果就变了 —— 那它就不是一条规则')
  })
})

describe('★ T-2.2 · canon —— 「每行内容一样吗」不受键序影响', () => {
  it('键序不同、内容相同 → 一样', () => {
    assert.equal(canon({ a: 1, b: [2, { d: 4, c: 3 }] }), canon({ b: [2, { c: 3, d: 4 }], a: 1 }))
  })
  it('内容不同 → 不一样', () => {
    assert.notEqual(canon({ a: 1 }), canon({ a: 2 }))
  })
  it('null 与 undefined 不混为一谈', () => {
    assert.notEqual(canon({ a: null }), canon({}))
  })
})

// ══════════════════════════════════════════════════════════════
// T-2.10 · 桶大小上限 —— 「压实要把整个桶读进内存」这条的护栏
// ══════════════════════════════════════════════════════════════

describe('★★ T-2.10 · 桶太大就拒，而且一个字都不动', () => {
  it('★ 行数超上限 → 拒；快照没写、老包一个没删', async () => {
    const s = scene()
    const r = await compactBucket(opts(s, { limits: { maxRows: 1, maxChars: 1e9 } }))

    assert.equal(r.ok, false)
    assert.match(r.why!, /行/)
    assert.equal(r.snapshot, undefined, '★ 拒的时候不许写快照')
    assert.equal(r.deleted, 0)
    assert.deepEqual(await s.list(CHUNKS), ['aaa-1000.json', 'aaa-2000.json', 'bbb-3000.json'])
    assert.deepEqual(
      s.deleted.filter((p) => p.startsWith(CHUNKS)),
      [],
      '★★ 变更包上一次删除都不许发（探针自己那一次不算）'
    )
  })

  it('★ 字符数超上限 → 拒，同上', async () => {
    const s = scene()
    const r = await compactBucket(opts(s, { limits: { maxRows: 1e9, maxChars: 10 } }))

    assert.equal(r.ok, false)
    assert.match(r.why!, /MB/)
    assert.equal(r.snapshot, undefined)
    assert.equal((await s.list(CHUNKS)).length, 3)
  })

  it('★ 认不出的包正文也算进上限 —— 一个巨大的坏包照样能把内存吃光', async () => {
    const s = scene()
    // 读得出来、但不是一份记录 → untouched；正文却实实在在读进过内存
    s.files.set(`${CHUNKS}/aaa-4000.json`, JSON.stringify('x'.repeat(4000)))
    const r = await compactBucket(opts(s, { limits: { maxRows: 1e9, maxChars: 3000 } }))

    assert.equal(r.ok, false)
    assert.match(r.why!, /MB/)
    assert.equal((await s.list(CHUNKS)).length, 4, '★ 桶不许被动过')
  })

  it('★ 负向对照：上限够大 → 照常压实（证明上面三条红的是上限，不是别的）', async () => {
    const s = scene()
    const r = await compactBucket(opts(s, { limits: { maxRows: 1e9, maxChars: 1e9 } }))
    assert.equal(r.ok, true, `★ ${r.why}`)
    assert.equal(r.folded, 3)
  })

  it('★ D-458 · 折了几个包要能答「是哪些」', async () => {
    const s = scene()
    const r = await compactBucket(opts(s))
    assert.equal(r.ok, true, `★ ${r.why}`)
    assert.equal(r.foldedNames.length, r.folded)
    assert.deepEqual(r.foldedNames, ['aaa-1000.json', 'aaa-2000.json', 'bbb-3000.json'])
  })
})
