import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampQuestionsPerItem,
  crossesEnoughTypes,
  cycle,
  DEFAULT_QUESTIONS_PER_ITEM,
  fitQuota,
  isAllowedType,
  pickedTypes,
  planQuestions,
  preferDifferent,
  QUESTIONS_PER_ITEM_MAX,
  QUESTIONS_PER_ITEM_MIN,
  rotate,
  type QTypeLite
} from './qtype-plan.ts'

/**
 * 出厂那 12 种的形状（只有 key —— ★ 2026-09-08 档位取消，D-478）。
 * 顺序就是他在设置里排的顺序：`pickedTypes` 按它过滤，`cycle` 按它轮。
 */
const ALL: QTypeLite[] = [
  { key: '造句' },
  { key: '搭配填空' },
  { key: '开放填空' },
  { key: '句子改写' },
  { key: '释义改写' },
  { key: '句子合并' },
  { key: '错误订正' },
  { key: '语域转换' },
  { key: '限定写作' },
  { key: '摘要写作' },
  { key: '情景任务' },
  { key: '论点应答' }
]

/** 定死的随机源 —— 洗牌可复现，用例才不会时绿时红 */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

/** 他真实的那六种：**没有造句** */
const HIS = ['搭配填空', '句子改写', '释义改写', '语域转换', '限定写作', '摘要写作']

test('★★ 没勾的题型，计划里一次都不许出现（他的真实勾选）', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const plan = planQuestions(ALL, HIS, 15, 'random', seeded(seed))
    for (const s of plan) {
      assert.ok(
        HIS.includes(s.type),
        `★★ 计划里出现了他没勾的「${s.type}」—— 这正是他看到「造句」的那个病`
      )
    }
    assert.ok(!plan.some((s) => s.type === '造句'), '★★ 造句又混进来了')
  }
})

test('★★ 一种都没勾 → 计划是空的（不许悄悄补成全选）', () => {
  assert.deepEqual(planQuestions(ALL, [], 15, 'random', seeded(1)), [])
})

test('★★ 只勾一种 → 如实只出那一种，不兜底（D-478 之后仍然如此）', () => {
  const plan = planQuestions(ALL, ['句子改写'], 6, 'random', seeded(7))
  assert.equal(plan.length, 6, `该出 6 道：${JSON.stringify(plan)}`)
  assert.ok(plan.every((s) => s.type === '句子改写'), '★★ 混进了他没勾的题型')
})

test('★★ 多种题型要轮换，不许连着两道一样', () => {
  const list = ['A', 'B', 'C', 'D']
  for (let seed = 1; seed <= 200; seed++) {
    const seq = rotate(list, 12, seeded(seed))
    assert.equal(seq.length, 12)
    for (let i = 1; i < seq.length; i++) {
      assert.notEqual(seq[i], seq[i - 1], `★ 第 ${i} 道和上一道都是「${seq[i]}」`)
    }
  }
})

test('★ 只勾了一种 → 正常连续出（那是他自己的选择）', () => {
  assert.deepEqual(rotate(['A'], 4, seeded(3)), ['A', 'A', 'A', 'A'])
})

test('★ 队列要洗匀：每一轮把所有题型都用一遍再重复', () => {
  const seq = rotate(['A', 'B', 'C'], 6, seeded(11))
  assert.deepEqual([...new Set(seq.slice(0, 3))].sort(), ['A', 'B', 'C'], '前三道没把三种都用上')
  assert.deepEqual([...new Set(seq.slice(3, 6))].sort(), ['A', 'B', 'C'], '后三道没把三种都用上')
})

test('★ 两种题型 6 道 → 严格交替', () => {
  const seq = rotate(['A', 'B'], 6, seeded(5))
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1])
})

test('pickedTypes 只认他勾过的，而且**按他排的顺序**', () => {
  assert.deepEqual(pickedTypes(ALL, HIS), [
    '搭配填空',
    '句子改写',
    '释义改写',
    '语域转换',
    '限定写作',
    '摘要写作'
  ])
  assert.deepEqual(pickedTypes(ALL, []), [])
  assert.deepEqual(pickedTypes(ALL, ['不存在的题型']), [], '认不出的一律丢掉，不猜')
})

test('★★ isAllowedType 是唯一的收题判据', () => {
  assert.equal(isAllowedType('搭配填空', HIS), true)
  assert.equal(isAllowedType('造句', HIS), false, '★★ 没勾的题型被放行了')
  assert.equal(isAllowedType(undefined, HIS), false, '★★ 没有题型的行被放行了 —— 老代码在这里写死成造句')
  assert.equal(isAllowedType(null, HIS), false)
  assert.equal(isAllowedType('', HIS), false)
  assert.equal(isAllowedType('  ', HIS), false)
  assert.equal(isAllowedType('造句 ', HIS), false)
  assert.equal(isAllowedType(' 搭配填空 ', HIS), true, '两头的空白不该让它被判成外来题型')
})

// ── ★★★ M-027 · 档位取消之后，跨题型由这两个函数**显式**保证 ────────

test('★★★ M-027 · 发题时避开的是「最近两道」，不只是上一道', () => {
  const qs = [
    { id: 1, type: 'A' },
    { id: 2, type: 'B' },
    { id: 3, type: 'C' }
  ]
  // 最近两道是 A、B → 该给 C；只避开上一道的话会给回 A，于是 A B A 只跨了两种
  assert.equal(preferDifferent(qs, ['A', 'B'])?.id, 3, '★★★ A B A —— 三连只跨了两种，M-027 白写')
  assert.equal(preferDifferent(qs, [])?.id, 1, '没有上一道时按原顺序')
  assert.equal(preferDifferent(qs, ['C'])?.id, 1)
  assert.equal(
    preferDifferent([{ id: 9, type: 'A' }], ['A', 'B'])?.id,
    9,
    '只剩同型的也得发，不能卡住'
  )
  assert.equal(preferDifferent([], ['A']), null)
})

test('★★★ M-027 · 连续三道真的跨三种（勾了 ≥3 种时）', () => {
  const picked = ['A', 'B', 'C']
  const pool = picked.map((type, id) => ({ id, type }))
  const served: string[] = []
  for (let i = 0; i < 9; i++) {
    const next = preferDifferent(pool, served)
    assert.ok(next, '池子里有题却挑不出来')
    served.push(next!.type)
  }
  for (let i = 2; i < served.length; i++) {
    const win = served.slice(i - 2, i + 1)
    assert.equal(
      new Set(win).size,
      3,
      `★★★ 第 ${i - 1}～${i + 1} 道只跨了 ${new Set(win).size} 种：${win.join(',')}`
    )
  }
})

test('★★ crossesEnoughTypes：勾得少就如实少跨，不假装满足', () => {
  assert.equal(crossesEnoughTypes(['A', 'B', 'C'], 3), true)
  assert.equal(crossesEnoughTypes(['A', 'B', 'A'], 3), false, '★★ 只跨两种却算通过')
  assert.equal(crossesEnoughTypes(['A', 'A', 'A'], 3), false)
  // 他只勾了 2 种 → 一个窗口里最多也就 2 种，这不算违反（不兜底：如实少出）
  assert.equal(crossesEnoughTypes(['A', 'B', 'A'], 2), true)
  assert.equal(crossesEnoughTypes(['A', 'A', 'A'], 1), true, '只勾一种是他的选择')
  assert.equal(crossesEnoughTypes(['A', 'B'], 3), true, '还没攒够一个窗口')
})

// ── 一次出几道：他自己定（D-478） ─────────────────────────────

test('★★ 一次出几道由他定，出厂 15，越界夹回来', () => {
  assert.equal(DEFAULT_QUESTIONS_PER_ITEM, 15, '出厂值变了就要有人交代为什么（原来是五档各 3 道）')
  assert.equal(clampQuestionsPerItem(15), 15)
  assert.equal(clampQuestionsPerItem(1), QUESTIONS_PER_ITEM_MIN, '下限 3：少于 3 道谈不上跨三种题型')
  assert.equal(clampQuestionsPerItem(999), QUESTIONS_PER_ITEM_MAX)
  assert.equal(clampQuestionsPerItem('8'), 8, '设置页传上来的是字符串')
  assert.equal(clampQuestionsPerItem(7.6), 8, '四舍五入')
  assert.equal(clampQuestionsPerItem('不是数'), DEFAULT_QUESTIONS_PER_ITEM, '坏值退回出厂，不炸')
  /**
   * ★★★ 「没设过」必须回出厂值，不能夹成下限 —— `Prefs.raw()` 没设过给的就是 `null`，
   *   而 `Number(null)` 是 **0**。少了这一条，他从没碰过这个设置就会被悄悄改成一次 3 道。
   */
  assert.equal(clampQuestionsPerItem(null), DEFAULT_QUESTIONS_PER_ITEM, '★★★ 没设过被夹成了下限')
  assert.equal(clampQuestionsPerItem(undefined), DEFAULT_QUESTIONS_PER_ITEM)
  assert.equal(clampQuestionsPerItem(''), DEFAULT_QUESTIONS_PER_ITEM, '清空输入框 ≠ 要 0 道')
})

test('★★★ 勾 3 种、出 15 道：三种都出现，而且相邻不重复', () => {
  const picked = ['A', 'B', 'C']
  const all: QTypeLite[] = picked.map((key) => ({ key }))
  for (const mode of ['seq', 'random'] as const) {
    for (let seed = 1; seed <= 30; seed++) {
      const types = planQuestions(all, picked, 15, mode, seeded(seed)).map((s) => s.type)
      assert.equal(types.length, 15, `${mode} 没出满 15 道`)
      assert.equal(new Set(types).size, 3, `★★ ${mode} 有他勾了的题型一次都没出现：${types.join(',')}`)
      for (let i = 1; i < types.length; i++) {
        assert.notEqual(types[i], types[i - 1], `★★ ${mode} 第 ${i} 道和上一道都是「${types[i]}」`)
      }
    }
  }
})

test('★ 计划的规模就是他设的那个数（不再是 5 × 3）', () => {
  for (const n of [3, 6, 15, 20]) {
    assert.equal(planQuestions(ALL, HIS, n, 'random', seeded(2)).length, n, `${n} 道没出满`)
  }
  assert.equal(
    planQuestions(ALL, HIS, 999, 'random', seeded(2)).length,
    QUESTIONS_PER_ITEM_MAX,
    '越界的数要夹到上限，不能让一次生成无限大'
  )
})

// ── G-1 · 「按顺序」必须真的是他排的那个顺序 ──────────────────

test('★★ G-1 · seq：输入 A/B/C，出来必须严格是 A/B/C', () => {
  /**
   * ★ 判据是**逐位相等**，不是集合相等。
   *
   * 上一版把「不洗牌」写成了「洗牌但随机源恒为 0」，而 Fisher–Yates 里
   * j 恒为 0 是一个确定的置换：[A,B,C] → B,C,A。集合完全一样，
   * 所有子集用例照绿 —— 只有按位置比对抓得住。
   */
  assert.deepEqual(cycle(['A', 'B', 'C'], 3), ['A', 'B', 'C'])
  assert.deepEqual(cycle(['A', 'B'], 3), ['A', 'B', 'A'], '用完要从头再来一轮')
  assert.deepEqual(cycle(['A'], 3), ['A', 'A', 'A'], '只有一种就连着出')
  assert.deepEqual(cycle([], 3), [])
  assert.deepEqual(cycle(['A', 'B'], 0), [])
})

test('★★ G-1 · seq 模式的计划：按他排的顺序，一位都不偏', () => {
  const picked = ['T1a', 'T1b', 'T1c']
  const all: QTypeLite[] = picked.map((key) => ({ key }))
  assert.deepEqual(
    planQuestions(all, picked, 5, 'seq').map((s) => s.type),
    ['T1a', 'T1b', 'T1c', 'T1a', 'T1b'],
    '★★ 没按他排的顺序 —— 「按顺序」这个设置就是假的'
  )
})

test('★★ G-1 · 勾了 4 种、这一批只出 3 道 → 换条目要能轮到第 4 种', () => {
  /**
   * 他可以勾比一批道数更多的种类。每条都从第一种开始的话，第 4 种**永远轮不到** ——
   * 勾了却一次都见不到，和「勾了不算数」是同一种失望。
   * 这一条是 db-safety 那条「他写的提示词真的进了出题上下文」逼出来的：
   * 他新加的题型排在最后，起点固定时它永远进不了计划。
   */
  const picked = ['A', 'B', 'C', 'D']
  const all: QTypeLite[] = picked.map((key) => ({ key }))
  const seen = new Set<string>()
  for (let item = 0; item < 4; item++) {
    const types = planQuestions(all, picked, 3, 'seq', Math.random, item).map((s) => s.type)
    assert.equal(types.length, 3)
    // 每一条**内部**仍然严格按他排的顺序（环形）往后走
    const start = picked.indexOf(types[0]!)
    assert.deepEqual(
      types,
      [picked[start]!, picked[(start + 1) % 4]!, picked[(start + 2) % 4]!],
      `★★ 条目 ${item} 内部没按他排的顺序：${types.join(',')}`
    )
    for (const t of types) seen.add(t)
  }
  assert.deepEqual([...seen].sort(), ['A', 'B', 'C', 'D'], '★★ 有他勾了的题型一次都没轮到')
})

test('★ G-1 · seq 是确定的：同样的输入跑十遍，结果逐位相同', () => {
  const all: QTypeLite[] = [{ key: 'A' }, { key: 'B' }]
  const first = JSON.stringify(planQuestions(all, ['A', 'B'], 3, 'seq'))
  for (let i = 0; i < 10; i++) {
    assert.equal(JSON.stringify(planQuestions(all, ['A', 'B'], 3, 'seq')), first, '★ seq 居然有随机性')
  }
})

test('★★ 勾了 2 种 → 那几道真的换着来（random 也一样）', () => {
  /**
   * 补 E-1 那个缺口：以前只验了「成员资格」和「道数」，
   * 没有一条断言「勾了两种时那几道真的交替」——「固定取第一项」也能过。
   */
  const all: QTypeLite[] = [{ key: 'A' }, { key: 'B' }]
  for (let seed = 1; seed <= 50; seed++) {
    const types = planQuestions(all, ['A', 'B'], 3, 'random', seeded(seed)).map((s) => s.type)
    assert.equal(types.length, 3)
    assert.equal(new Set(types).size, 2, `★★ 三道全是同一种：${types.join(',')}`)
    for (let i = 1; i < types.length; i++) {
      assert.notEqual(types[i], types[i - 1], `★ 连着两道都是「${types[i]}」`)
    }
  }
})

// ── G-2 · B-lite：一批不许被单一题型垄断 ────────────────────

/** 把「他勾了哪几种 → AI 回了哪几道」写成一句话，省得每条用例重复搭台 */
function quota(picked: string[], back: string[], count = 3): string[] {
  const all: QTypeLite[] = picked.map((key) => ({ key }))
  const plan = planQuestions(all, picked, count, 'seq')
  const rows = back.map((type) => ({ type }))
  return fitQuota(rows, plan).kept.map((r) => r.type)
}

test('★★ NC-B1 · 他勾了 A+B，AI 全给 A → 收不到三道 A', () => {
  const kept = quota(['A', 'B'], ['A', 'A', 'A'])
  assert.ok(kept.length < 3, `★★ 三道全是 A 也收下了：${kept.join(',')}`)
  assert.deepEqual(kept, ['A', 'A'], '配额是计划的多重集（A 两道、B 一道）')
})

test('★★ NC-B2 · 他勾了 A+B+C，AI 给 A A B → 这一批不许偏向 A', () => {
  assert.deepEqual(quota(['A', 'B', 'C'], ['A', 'A', 'B']), ['A', 'B'], '第二道 A 该被丢掉')
})

test('★★ NC-B3 · 他只勾了 A，AI 给 A A A → 全收（防垄断不是禁止重复）', () => {
  assert.deepEqual(quota(['A'], ['A', 'A', 'A']), ['A', 'A', 'A'])
})

test('★★ 勾 4 种只出 3 道 → 尽量覆盖 3 种，不要求四种都出现', () => {
  const picked = ['A', 'B', 'C', 'D']
  const all: QTypeLite[] = picked.map((key) => ({ key }))
  const plan = planQuestions(all, picked, 3, 'seq')
  assert.equal(new Set(plan.map((s) => s.type)).size, 3, '计划该覆盖 3 种')
  const kept = fitQuota(
    plan.map((s) => ({ type: s.type })),
    plan
  ).kept
  assert.equal(kept.length, 3, '照着计划回的题该一道不丢')
})
