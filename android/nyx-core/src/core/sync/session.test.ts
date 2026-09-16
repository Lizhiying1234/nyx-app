import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addBatch,
  apply,
  plan,
  startSession,
  batchIsFull,
  auditCommit,
  auditTally,
  auditWatermark,
  auditWriteOrder,
  nextWatermark,
  orderForWrite,
  planCommit,
  planTodo,
  PULL_PACKS,
  PULL_ROWS,
  pushedUpTo,
  tallyOf,
  type BatchPackages,
  type BatchTally,
  type TodoFacts
} from './session.ts'
import {
  emptyTally,
  type ExecutionResult,
  type FetchedPackage,
  type Step,
  type SyncFacts,
  type SyncState
} from './types.ts'

/**
 * 四桶记账 · Step 6 · Commit B · 第 1 步
 *
 * 这一批要证的不是「加法会不会算」，是三件**只会静默出错**的事：
 *   ① 恒等式是不是靠「每一行恰好落进一个桶」成立的，而不是靠减法凑
 *   ② 冲突行按 `resolve` 落桶，三条路各自唯一（落两个桶 = 重复计数）
 *   ③ 一批一批加，和一次性加，结果必须一样（分批是 R-4-C-a 的既定形态）
 */

const b = (o: Partial<BatchTally> = {}): BatchTally => ({
  received: 0,
  planSkipped: 0,
  applied: 0,
  failed: 0,
  writeSkipped: 0,
  conflicts: 0,
  ...o
})

describe('四桶记账（R-4-G-e）', () => {
  it('空的一批不动任何数', () => {
    assert.deepEqual(addBatch(emptyTally(), b()), emptyTally())
  })

  it('每一类原料各进各的桶', () => {
    const t = addBatch(emptyTally(), b({ received: 10, applied: 4, planSkipped: 2, writeSkipped: 1, failed: 3 }))
    assert.deepEqual(t, { received: 10, applied: 4, skipped: 3, failed: 3, conflicted: 0 })
    assert.deepEqual(auditTally(t), [])
  })

  it('★ 恒等式不是凑出来的 —— 原料少一条，账当场对不上', () => {
    /**
     * 这一条是整批测试的关键。如果 `skipped` 是用 `received - 其余` 算的，
     * 那么无论原料对不对，恒等式都永远成立，`auditTally` 也就永远绿 ——
     * 一个永远不响的报警器比没有报警器更糟。
     */
    const bad = addBatch(emptyTally(), b({ received: 10, applied: 4 }))
    const v = auditTally(bad)
    assert.equal(v.length, 1)
    assert.equal(v[0]!.id, 'tally-identity')
    assert.match(v[0]!.why, /对不上账/)
  })

  it('负数会被抓出来 —— 那说明某处重复扣减了', () => {
    const v = auditTally({ received: 0, applied: -1, skipped: 1, failed: 0, conflicted: 0 })
    assert.ok(v.some((x) => /负数/.test(x.why)))
  })
})

describe('★★ R-4-F · 冲突行落哪个桶，看他做没做过决定', () => {
  const one = b({ received: 5, applied: 2, planSkipped: 0, conflicts: 3 })

  it('没裁决 → conflicted，在等他', () => {
    const t = addBatch(emptyTally(), one, undefined)
    assert.deepEqual(t, { received: 5, applied: 2, skipped: 0, failed: 0, conflicted: 3 })
    assert.deepEqual(auditTally(t), [])
  })

  it('选「用本地的」→ skipped，那是一个做完的决定', () => {
    const t = addBatch(emptyTally(), one, 'local')
    assert.deepEqual(t, { received: 5, applied: 2, skipped: 3, failed: 0, conflicted: 0 })
    assert.deepEqual(auditTally(t), [])
  })

  it('★ 选「用云端的」→ 两个桶都不加：它们已经在 applied 里了', () => {
    /**
     * 这里最容易写错的是「顺手也记一笔 skipped」——
     * 那样同一行被数两次，恒等式当场破。
     */
    const t = addBatch(emptyTally(), b({ received: 5, applied: 5, conflicts: 3 }), 'remote')
    assert.deepEqual(t, { received: 5, applied: 5, skipped: 0, failed: 0, conflicted: 0 })
    assert.deepEqual(auditTally(t), [])
  })

  it('★ 三条路各自唯一 —— 同一批原料，三种裁决下 conflicted + skipped 的去向互不重叠', () => {
    const none = addBatch(emptyTally(), one, undefined)
    const local = addBatch(emptyTally(), one, 'local')
    assert.equal(none.conflicted + none.skipped, local.conflicted + local.skipped)
    assert.notEqual(none.conflicted, local.conflicted)
  })
})

describe('★★ R-4-C-a · 分批与不分批必须一样', () => {
  const batches: BatchTally[] = [
    b({ received: 7, applied: 3, planSkipped: 1, writeSkipped: 1, failed: 2 }),
    b({ received: 4, applied: 4 }),
    b({ received: 6, applied: 1, planSkipped: 2, conflicts: 3 })
  ]

  for (const resolve of [undefined, 'local', 'remote'] as const) {
    it(`裁决 = ${resolve ?? '（没裁决）'}：逐批累加 == 一次性合并`, () => {
      const step = tallyOf(batches, resolve)
      const merged = tallyOf(
        [
          batches.reduce((x, y) => ({
            received: x.received + y.received,
            planSkipped: x.planSkipped + y.planSkipped,
            applied: x.applied + y.applied,
            failed: x.failed + y.failed,
            writeSkipped: x.writeSkipped + y.writeSkipped,
            conflicts: x.conflicts + y.conflicts
          }))
        ],
        resolve
      )
      assert.deepEqual(step, merged)
    })
  }

  it('★ 分批之后账还是平的 —— 每批平不等于合起来平，要单独验', () => {
    for (const resolve of [undefined, 'local', 'remote'] as const) {
      /** remote 那条路里冲突行是当成写进去的，原料要自洽才谈得上对账 */
      const fixed = batches.map((x) =>
        resolve === 'remote' ? { ...x, applied: x.applied + x.conflicts } : x
      )
      assert.deepEqual(auditTally(tallyOf(fixed, resolve)), [], `resolve=${resolve}`)
    }
  })
})

describe('★★ R-4-A / R-4-F · 一包算不算处理完（planCommit）', () => {
  const P = (o: Partial<BatchPackages> = {}): BatchPackages => ({
    names: ['a.json', 'b.json', 'c.json'],
    rejected: [],
    withFailedRows: [],
    withUnresolvedConflicts: [],
    ...o
  })

  it('三份名单都空 → 整批全进 applied', () => {
    const p = planCommit(P())
    assert.deepEqual(p.commit, ['a.json', 'b.json', 'c.json'])
    assert.deepEqual(p.retry, [])
  })

  for (const [why, field] of [
    ['有行写不进去', 'withFailedRows'],
    ['还有冲突没裁决', 'withUnresolvedConflicts'],
    ['整包被拒', 'rejected']
  ] as const) {
    it(`★ ${why} → 那一包留下重试，别的照进`, () => {
      const p = planCommit(P({ [field]: ['b.json'] }))
      assert.deepEqual(p.commit, ['a.json', 'c.json'])
      assert.deepEqual(p.retry, ['b.json'])
    })
  }

  it('★ 一包同时中三样 —— 只留一次，不许重复', () => {
    const p = planCommit(
      P({ rejected: ['b.json'], withFailedRows: ['b.json'], withUnresolvedConflicts: ['b.json'] })
    )
    assert.deepEqual(p.retry, ['b.json'])
    assert.deepEqual(p.commit, ['a.json', 'c.json'])
  })

  it('★ 判据是「这一包处理完了」，不是「我下过了」—— 下过但没处理完的一律不进', () => {
    const p = planCommit(P({ withFailedRows: ['a.json'], withUnresolvedConflicts: ['c.json'] }))
    assert.deepEqual(p.commit, ['b.json'])
    assert.deepEqual(p.retry.sort(), ['a.json', 'c.json'])
  })

  it('名单里出现不属于这一批的包名 → 不影响这一批（判据只看 names）', () => {
    const p = planCommit(P({ withFailedRows: ['别人的.json'] }))
    assert.deepEqual(p.retry, [])
  })
})

describe('★★ Step 6B · auditCommit 是同一件事的第二个说法', () => {
  const plan = planCommit({
    names: ['a.json', 'b.json'],
    rejected: [],
    withFailedRows: ['b.json'],
    withUnresolvedConflicts: []
  })

  it('照着 plan 记的 applied → 一条违规都没有', () => {
    assert.deepEqual(auditCommit(plan, ['a.json']), [])
  })

  it('★ 该重试的包被标成已处理 → 两条判据同时报（它们查的是同一件事的两头）', () => {
    const v = auditCommit(plan, ['a.json', 'b.json'])
    assert.deepEqual(
      v.map((x) => x.id).sort(),
      ['package-completeness', 'retry-eligibility']
    )
  })

  it('★ 该进的没进 → 也要报，否则每次同步重下一遍而他一直看到「有失败」', () => {
    const v = auditCommit(plan, [])
    assert.deepEqual(v.map((x) => x.id), ['package-completeness'])
  })
})

describe('★★ R-3 · 写入顺序（orderForWrite）', () => {
  const R = (table: string, uid: string): { table: string; uid: string } => ({ table, uid })

  it('碑排到最前面', () => {
    const out = orderForWrite([R('items', '1'), R('tombstones', 't'), R('lectures', '2')])
    assert.deepEqual(out.map((x) => x.table), ['tombstones', 'items', 'lectures'])
    assert.deepEqual(auditWriteOrder(out.map((x) => x.table)), [])
  })

  it('本来就没有碑 / 全是碑 → 原样', () => {
    assert.deepEqual(orderForWrite([R('items', '1'), R('items', '2')]).map((x) => x.uid), ['1', '2'])
    assert.deepEqual(
      orderForWrite([R('tombstones', 'a'), R('tombstones', 'b')]).map((x) => x.uid),
      ['a', 'b']
    )
  })

  it('★★ 稳定：同类之间的先后一个都不许动 —— 外键依赖就藏在里面', () => {
    /**
     * 父行在子行之前是包里的顺序带来的。打乱它就是凭空造一批
     * 「外键还没到」的失败，那些包于是不进 applied，表现成「同步永远差一点」。
     */
    const rows = [
      R('lectures', 'L1'),
      R('tombstones', 'T1'),
      R('items', 'I1'),
      R('tombstones', 'T2'),
      R('items', 'I2'),
      R('questions', 'Q1')
    ]
    assert.deepEqual(
      orderForWrite(rows).map((x) => x.uid),
      ['T1', 'T2', 'L1', 'I1', 'I2', 'Q1']
    )
  })

  it('不改原数组', () => {
    const rows = [R('items', '1'), R('tombstones', 't')]
    orderForWrite(rows)
    assert.deepEqual(rows.map((x) => x.table), ['items', 'tombstones'])
  })

  it('★ 判据认得出坏顺序 —— 否则它是个永远不响的报警器', () => {
    const v = auditWriteOrder(['items', 'tombstones'])
    assert.equal(v.length, 1)
    assert.equal(v[0]!.id, 'write-ordering')
    assert.match(v[0]!.why, /复活/)
  })
})

describe('★★ R-4-B · 这一趟推到哪个时刻（pushedUpTo）', () => {
  it('什么都没被截断、也没有翻译不出去的 → null（全推完了）', () => {
    assert.equal(pushedUpTo({ truncated: [], untranslatable: [] }), null)
  })

  it('★ left === 0 的表不算截断 —— 它已经推完了，不该拽住水位', () => {
    assert.equal(
      pushedUpTo({ truncated: [{ table: 'items', edge: 500, left: 0 }], untranslatable: [] }),
      null
    )
  })

  it('一张表被截断 → 停在它的边界那一毫秒**上**', () => {
    assert.equal(
      pushedUpTo({ truncated: [{ table: 'items', edge: 500, left: 3 }], untranslatable: [] }),
      500
    )
  })

  it('多张表被截断 → 取最小的（谁都不许被越过）', () => {
    assert.equal(
      pushedUpTo({
        truncated: [
          { table: 'items', edge: 900, left: 1 },
          { table: 'lectures', edge: 300, left: 5 },
          { table: 'questions', edge: 700, left: 2 }
        ],
        untranslatable: []
      }),
      300
    )
  })

  it('★★ C-2 · 翻译不出去的行 → 停在它**之前**（at - 1），否则它再也不会被收集', () => {
    assert.equal(pushedUpTo({ truncated: [], untranslatable: [{ at: 500 }] }), 499)
  })

  it('at = 0 的坏行不许把水位拽成负数', () => {
    assert.equal(pushedUpTo({ truncated: [], untranslatable: [{ at: 0 }] }), 0)
  })

  it('两种力量一起出现 → 取更靠前的那个', () => {
    assert.equal(
      pushedUpTo({
        truncated: [{ table: 'items', edge: 900, left: 1 }],
        untranslatable: [{ at: 400 }]
      }),
      399
    )
    assert.equal(
      pushedUpTo({
        truncated: [{ table: 'items', edge: 100, left: 1 }],
        untranslatable: [{ at: 400 }]
      }),
      100
    )
  })
})

describe('★★ R-4-B + R-4-F · 水位推到哪里（nextWatermark）', () => {
  const F = (o: Partial<Parameters<typeof nextWatermark>[0]> = {}) => ({
    watermark: 500,
    startedAt: 1000,
    pushedUpTo: null,
    unresolved: 0,
    ...o
  })

  it('全推完、没冲突 → 走到这一趟开始的时刻', () => {
    assert.equal(nextWatermark(F()), 1000)
  })

  it('没推完 → 停在实推位置，不是 startedAt', () => {
    assert.equal(nextWatermark(F({ pushedUpTo: 700 })), 700)
  })

  it('★★ D-201 · 还有冲突没裁决 → 一步都不许动', () => {
    assert.equal(nextWatermark(F({ unresolved: 1 })), 500)
    assert.equal(nextWatermark(F({ unresolved: 3, pushedUpTo: 900 })), 500)
    assert.deepEqual(auditWatermark(500, nextWatermark(F({ unresolved: 1 })), 1), [])
  })

  it('★★ 冻结优先于「没推完」—— 两者同时成立时冻结说了算', () => {
    /**
     * 顺序反过来（先取 pushedUpTo 再判冲突）水位就会往前走，
     * 于是下一轮那些冲突落到水位之下、不再算「改过」，**自己蒸发**。
     */
    assert.equal(nextWatermark(F({ unresolved: 2, pushedUpTo: 700 })), 500)
  })

  it('★ 判据认得出「冲突未决却动了水位」—— 否则它永远不响', () => {
    const v = auditWatermark(500, 900, 2)
    assert.ok(v.some((x) => x.id === 'conflict-freeze'))
    assert.match(v.find((x) => x.id === 'conflict-freeze')!.why, /蒸发/)
  })

  it('★ 判据认得出水位倒退', () => {
    const v = auditWatermark(900, 500, 0)
    assert.deepEqual(v.map((x) => x.id), ['watermark-monotone'])
  })
})

describe('★★ I-068 · 这一趟要处理哪些包（planTodo）', () => {
  const F = (o: Partial<TodoFacts> = {}): TodoFacts => ({
    available: [],
    device: 'me',
    applied: [],
    wipedAt: 0,
    ...o
  })

  it('自己推的包不下 —— 下回来只会判成 same，纯浪费', () => {
    assert.deepEqual(planTodo(F({ available: ['me-100.json', 'you-100.json'] })), ['you-100.json'])
  })

  /**
   * ★★ F-009 · 从备份恢复到新机器会重新铸号（否则两台同号，各自把对方的包
   * 全部跳过 —— 永远收不到对方的数据，两边还都显示「同步成功」）。
   * 铸新号之后，**旧号推的包也是自己推的**，一样不下。
   */
  it('旧编号推的包也不下（F-009 · 换过号之后）', () => {
    assert.deepEqual(
      planTodo(
        F({
          available: ['me-100.json', 'old1-90.json', 'old2-80.json', 'you-100.json'],
          formerDevices: ['old1', 'old2']
        })
      ),
      ['you-100.json']
    )
  })

  it('没换过号时行为一个字不变（Windows 就是这样，不填这个字段）', () => {
    const av = ['me-100.json', 'you-100.json', 'other-50.json']
    assert.deepEqual(planTodo(F({ available: av })), planTodo(F({ available: av, formerDevices: [] })))
  })

  it('★ 空的旧编号不算 —— 否则前缀是「-」，会把别人的包也误伤掉', () => {
    assert.deepEqual(
      planTodo(F({ available: ['-100.json', 'you-100.json'], formerDevices: ['', '  '] })),
      ['-100.json', 'you-100.json']
    )
  })

  it('已经处理完的不下', () => {
    assert.deepEqual(
      planTodo(F({ available: ['a-1.json', 'a-2.json'], applied: ['a-1.json'] })),
      ['a-2.json']
    )
  })

  it('★ 排序：按包名（= 按推送先后），因为分批是按这个顺序切的', () => {
    assert.deepEqual(
      planTodo(F({ available: ['a-300.json', 'a-100.json', 'a-200.json'] })),
      ['a-100.json', 'a-200.json', 'a-300.json']
    )
  })

  describe('清空墓碑之后（wipedAt > 0）', () => {
    it('比碑新的收，比碑旧的不收', () => {
      assert.deepEqual(
        planTodo(F({ available: ['a-100.json', 'a-300.json'], wipedAt: 200 })),
        ['a-300.json']
      )
    })

    it('★★ 名字里解析不出时间戳的**也不收** —— 宁可漏不可错', () => {
      /**
       * 收一个来路不明的包进来，等于让「清空数据」这个动作失效：
       * 他清完，下一次同步又原样长回来，而每一步看起来都正常。
       */
      for (const weird of ['随便一个文件.json', 'a-abc.json', 'noplace.json']) {
        assert.deepEqual(planTodo(F({ available: [weird], wipedAt: 200 })), [])
      }
    })

    it('正好等于碑的时刻 → 不收（判据是严格大于）', () => {
      assert.deepEqual(planTodo(F({ available: ['a-200.json'], wipedAt: 200 })), [])
    })

    it('没清空过（wipedAt === 0）→ 名字再怪也照收', () => {
      assert.deepEqual(planTodo(F({ available: ['随便.json'], wipedAt: 0 })), ['随便.json'])
    })
  })

  it('三道过滤叠在一起', () => {
    assert.deepEqual(
      planTodo(
        F({
          available: ['me-900.json', 'you-100.json', 'you-500.json', 'you-900.json', '怪.json'],
          applied: ['you-500.json'],
          wipedAt: 200
        })
      ),
      ['you-900.json']
    )
  })
})

describe('★★ R-4-C-a · 装到这一批为止了吗（batchIsFull）', () => {
  it('空批永远没满 —— 否则单个超大包会切出空批，一个包都处理不动', () => {
    assert.equal(batchIsFull(0, 0), false)
    assert.equal(batchIsFull(0, 999999), false)
  })

  it('包数到闸 / 行数到闸 → 满（先到者为准）', () => {
    assert.equal(batchIsFull(PULL_PACKS, 0), true)
    assert.equal(batchIsFull(1, PULL_ROWS), true)
    assert.equal(batchIsFull(PULL_PACKS - 1, PULL_ROWS - 1), false)
  })

  it('★ 一个包永远不拆开：装了一个超大包之后才算满，那一批就它一个', () => {
    assert.equal(batchIsFull(1, PULL_ROWS * 10), true)
  })
})

describe('★★ Step 6B · plan / apply —— 编排本身', () => {
  const S = (o: Partial<Parameters<typeof startSession>[0]> = {}): SyncState =>
    startSession({
      startedAt: 1000,
      watermark: 500,
      wipedAt: 0,
      device: 'me',
      identity: { schemaVersion: 30, schemaFingerprint: 'f'.repeat(16), protocolVersion: 3 },
      applied: [],
      ...o
    })

  const pkg = (name: string): FetchedPackage => ({ name, header: null, rows: [] })

  const write = (
    o: Partial<Extract<ExecutionResult, { step: 'write' }>> = {}
  ): ExecutionResult => ({
    step: 'write',
    received: 0,
    planSkipped: 0,
    applied: 0,
    skipped: 0,
    failed: [],
    conflicted: 0,
    conflictChunks: [],
    rejected: [],
    ...o
  })

  /** 把一整趟跑完，记下每一步是什么 —— **顺序本身就是被验的东西** */
  function walk(
    start: SyncState,
    facts: SyncFacts,
    results: (step: Step) => ExecutionResult
  ): { steps: Step[]; state: SyncState } {
    let st = start
    const steps: Step[] = []
    for (let i = 0; i < 100; i++) {
      const step = plan(st, facts)
      steps.push(step)
      if (step.kind === 'done') break
      st = apply(st, results(step))
    }
    return { steps, state: st }
  }

  /** 一台「什么都成功」的执行器 */
  const happy =
    (available: string[], perBatch = 1) =>
    (step: Step): ExecutionResult => {
      switch (step.kind) {
        case 'list':
          return { step: 'list', packages: available }
        case 'collect':
          return { step: 'collect', rows: [], upTo: null, untranslatable: 0 }
        case 'fetch':
          return { step: 'fetch', packages: step.packages.slice(0, perBatch).map(pkg) }
        case 'write':
          return write()
        case 'purge':
          return { step: 'purge', purged: 0 }
        case 'commitApplied':
          return { step: 'commitApplied', packages: step.packages }
        case 'push':
          return { step: 'push', rows: 0 }
        case 'advanceWatermark':
          return { step: 'advanceWatermark', to: step.to }
        case 'done':
          return { step: 'push', rows: 0 }
      }
    }

  it('★★ R-4-C-a · 坑 1 · collect 排在**第一个 fetch 之前**，而且只做一次', () => {
    /**
     * 反过来的话，刚从云端拉下来的行会被算成「我这边的新改动」原样推回去 ——
     * 数据在两台机器之间来回弹，第三台还会看到同一条内容被两个设备
     * 分别声明改过。这是不变量，不是「先做哪个好看」。
     */
    const { steps } = walk(S(), {}, happy(['a-1.json', 'a-2.json']))
    const kinds = steps.map((s) => s.kind)
    assert.equal(kinds.filter((k) => k === 'collect').length, 1, 'collect 只许做一次')
    assert.ok(kinds.indexOf('collect') < kinds.indexOf('fetch'), '★★ collect 必须早于第一个 fetch')
  })

  it('★★ 坑 2 · commitApplied 是**批级**的 —— 每批一次，不是收尾一次', () => {
    /**
     * 第 N+1 批炸了，前 N 批的成果要算数。收尾才落盘的话中途一炸整趟白干。
     */
    const { steps } = walk(S(), {}, happy(['a-1.json', 'a-2.json', 'a-3.json']))
    const kinds = steps.map((s) => s.kind)
    assert.equal(kinds.filter((k) => k === 'commitApplied').length, 3, '三批就该落三次盘')
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === 'commitApplied') assert.equal(kinds[i - 1], 'purge')
    }
    assert.ok(kinds.indexOf('commitApplied') < kinds.indexOf('push'), 'commitApplied 不许拖到收尾')
  })

  it('★ 水位排在 push **之后** —— 推到哪儿才算到哪儿', () => {
    const { steps } = walk(S(), {}, happy([]))
    assert.deepEqual(steps.map((s) => s.kind), [
      'list',
      'collect',
      'push',
      'advanceWatermark',
      'done'
    ])
  })

  it('★ 一批装得下三个包时，只走一轮批循环', () => {
    const { steps } = walk(S(), {}, happy(['a-1.json', 'a-2.json', 'a-3.json'], 3))
    assert.deepEqual(steps.map((s) => s.kind), [
      'list',
      'collect',
      'fetch',
      'write',
      'purge',
      'commitApplied',
      'push',
      'advanceWatermark',
      'done'
    ])
  })

  it('★★ 冲突未决 → plan 给出的水位就是原地不动，那一包也不进 applied', () => {
    let st = S()
    st = apply(st, { step: 'list', packages: ['a-1.json'] })
    st = apply(st, { step: 'collect', rows: [], upTo: null, untranslatable: 0 })
    st = apply(st, { step: 'fetch', packages: [pkg('a-1.json')] })
    st = apply(st, write({ received: 2, conflicted: 2, conflictChunks: ['a-1.json'] }))
    assert.equal(st.unresolved, 2)
    st = apply(st, { step: 'purge', purged: 0 })
    const commit = plan(st)
    assert.deepEqual(commit.kind === 'commitApplied' ? commit.packages : null, [])
    st = apply(st, { step: 'commitApplied', packages: [] })
    st = apply(st, { step: 'push', rows: 0 })
    const wm = plan(st)
    assert.equal(wm.kind === 'advanceWatermark' ? wm.to : null, 500, '★★ 冲突未决，水位必须冻住')
  })

  it('★ 裁决过了 → 冲突不再挡 applied，水位照常前进', () => {
    let st = S({ resolve: 'local' })
    st = apply(st, { step: 'list', packages: ['a-1.json'] })
    st = apply(st, { step: 'collect', rows: [], upTo: null, untranslatable: 0 })
    st = apply(st, { step: 'fetch', packages: [pkg('a-1.json')] })
    st = apply(st, write({ received: 2, conflicted: 2, conflictChunks: [] }))
    assert.equal(st.unresolved, 0)
    assert.equal(st.tally.skipped, 2, '选「用本地的」→ 冲突行归 skipped')
    st = apply(st, { step: 'purge', purged: 0 })
    const commit = plan(st)
    assert.deepEqual(commit.kind === 'commitApplied' ? commit.packages : null, ['a-1.json'])
    st = apply(st, { step: 'commitApplied', packages: ['a-1.json'] })
    st = apply(st, { step: 'push', rows: 0 })
    const wm = plan(st)
    assert.equal(wm.kind === 'advanceWatermark' ? wm.to : null, 1000)
  })

  it('★ 有行失败的包留在 applied 之外，同批别的包照进', () => {
    let st = S()
    st = apply(st, { step: 'list', packages: ['a-1.json', 'a-2.json'] })
    st = apply(st, { step: 'collect', rows: [], upTo: null, untranslatable: 0 })
    st = apply(st, { step: 'fetch', packages: [pkg('a-1.json'), pkg('a-2.json')] })
    st = apply(st, write({ received: 2, applied: 1, failed: [{ chunk: 'a-2.json', message: 'x' }] }))
    st = apply(st, { step: 'purge', purged: 0 })
    const commit = plan(st)
    assert.deepEqual(commit.kind === 'commitApplied' ? commit.packages : null, ['a-1.json'])
  })

  it('★ 整包被拒的也留在 applied 之外', () => {
    let st = S()
    st = apply(st, { step: 'list', packages: ['a-1.json'] })
    st = apply(st, { step: 'collect', rows: [], upTo: null, untranslatable: 0 })
    st = apply(st, { step: 'fetch', packages: [pkg('a-1.json')] })
    st = apply(st, write({ rejected: ['a-1.json'] }))
    st = apply(st, { step: 'purge', purged: 0 })
    const commit = plan(st)
    assert.deepEqual(commit.kind === 'commitApplied' ? commit.packages : null, [])
  })

  it('★ 云端一个包都没有 → 直接 collect → push，不空转', () => {
    let st = S()
    st = apply(st, { step: 'list', packages: [] })
    assert.deepEqual(st.todo, [])
    st = apply(st, { step: 'collect', rows: [], upTo: null, untranslatable: 0 })
    assert.equal(plan(st).kind, 'push')
  })

  it('★ 没推完（collect 报了 upTo）→ 水位停在那儿，不是 startedAt', () => {
    let st = S()
    st = apply(st, { step: 'list', packages: [] })
    st = apply(st, { step: 'collect', rows: [], upTo: 640, untranslatable: 2 })
    st = apply(st, { step: 'push', rows: 1 })
    const wm = plan(st)
    assert.equal(wm.kind === 'advanceWatermark' ? wm.to : null, 640)
  })

  it('★ apply 是纯的 —— 不改传进来的 state', () => {
    const st = S()
    const snap = JSON.stringify(st)
    apply(st, { step: 'list', packages: ['a-1.json'] })
    assert.equal(JSON.stringify(st), snap)
  })

  it('★ 执行器只拿走了一部分包 → 游标只走那么多（一个包永远不拆开）', () => {
    let st = S()
    st = apply(st, { step: 'list', packages: ['a-1.json', 'a-2.json', 'a-3.json'] })
    st = apply(st, { step: 'collect', rows: [], upTo: null, untranslatable: 0 })
    const step = plan(st)
    assert.deepEqual(step.kind === 'fetch' ? [...step.packages] : null, [
      'a-1.json',
      'a-2.json',
      'a-3.json'
    ])
    st = apply(st, { step: 'fetch', packages: [pkg('a-1.json')] })
    assert.equal(st.cursor, 1)
    assert.deepEqual(st.batch, ['a-1.json'])
    assert.equal(plan(st).kind, 'write')
  })

  it('★★ 整趟跑完，四个桶还是平的', () => {
    const { state } = walk(S(), {}, (step) =>
      step.kind === 'write'
        ? write({ received: 10, applied: 6, planSkipped: 2, skipped: 1, failed: [{ message: 'x' }] })
        : happy(['a-1.json', 'a-2.json'])(step)
    )
    assert.deepEqual(auditTally(state.tally), [])
    assert.equal(state.tally.received, 20)
  })
})
