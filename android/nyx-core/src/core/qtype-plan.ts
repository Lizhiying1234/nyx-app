/**
 * 出题计划：第几道、用哪一种题型 · ★ 使用者 2026-08-14 · **档位取消 2026-09-08（D-478）**
 *
 * ── 2026-09-08 · 档位机制整个取消 ─────────────────────────
 *
 * 使用者裁：「取消档位机制」。原来这里是「五档 × 每档 3 道」，档由答对次数推
 * （`progression.ts::tierFor`，已删）。现在**没有档**了，只剩他勾的那几种题型按顺序轮，
 * **一次出几道由他在设置里定**（`param.questionsPerItem`，出厂 15）。
 *
 * ★★ 连带必须补上的一条：**M-027「连续 3 次正确必须横跨 3 种题型」以前是档位的副产品** ——
 *   答对一次换一档、每档形式不同，所以三连必然跨三种。档一删这条链就断，而且断掉
 *   **不会有任何东西报错**：他连答三道造句照样静默，正是 M-027 那句原话要治的病
 *   （「证明的只是『我会造句』」）。所以判据在这里显式写出来：`preferDifferent` 收的是
 *   **最近几道**而不是「上一道」，`crossesEnoughTypes` 是它的判据本体。
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * 他勾了六种题型（**没有造句**），软件一道接一道地出「造句 · 第 1 档」。
 * 查下来是四处叠在一起：
 *
 *   ① `q.type ?? '造句'` —— AI 没给题型就写死成造句（study.ts 里那一行）
 *   ② 生成结果**从不校验**是不是他勾的那几种
 *   ③ 提示词的输出示例里写着 `"type": "造句"` —— 被当成答案抄（I-108 同款）
 *   ④ 轮换逻辑（当时在 `progression.ts` 里）**只有测试在调用**，
 *      出题那条路自己另写了一套，把选择权整个交给了 AI
 *      —— 那套已经在 F-② 里删掉了，题型的判据从此只有这一个模块
 *
 * 所以这个模块把「这 15 道题分别该是什么」变成一份**算得出来、看得见、可校验**的计划：
 * 生成前照着它写进提示词，生成后照着它把不合规的挡在库外。
 *
 * ── 一条不许破的规矩 ────────────────────────────────────────
 *
 * **实际出的题型 ⊆ 他勾选的题型。** 没有兜底、没有默认、没有「这一档空了就补一个」。
 * 一个都没勾就是不出题（由调用方报一句人话），而不是悄悄替他勾上全部 ——
 * 那正是他这次要取消的东西。
 */

/** 出题用得着的题型信息（`qtypes` 表的子集，纯逻辑不认识数据库） */
export interface QTypeLite {
  key: string
}

/** 一道题的位置：这一批里的第几道、该用哪种题型 */
export interface QSlot {
  /** 这一批里的序号，0 起 */
  seq: number
  type: string
}

/**
 * ★★ 一次给一条知识点出几道 —— **他自己在设置里定**（使用者 2026-09-08：
 * 「一次性出几道可以自己设定，弄到设置里面自己设定」）。数与夹取放 core：
 * 两端同一份（Windows 的 `PARAM_SPEC` 引它，Android 靠同步跟着这个值走）。
 *
 * ★ 出厂 15 = 原来的「五档各 3 道」（D-129），**换了机制但不改他今天拿到的量**。
 * ★ 下限 3 不是随手写的：M-027 要「三连正确跨三种」，一批少于 3 道时这条根本无从谈起。
 * ★ 上限 30 是**成本**不是判据：一次生成是一次 AI 调用，再多他也用不完，
 *   而失败重来的代价随批量线性涨。★ 这两个边界是我提的（D-413）。
 */
export const DEFAULT_QUESTIONS_PER_ITEM = 15
export const QUESTIONS_PER_ITEM_MIN = 3
export const QUESTIONS_PER_ITEM_MAX = 30

export function clampQuestionsPerItem(n: unknown): number {
  /**
   * ★★ 「没设过」要回出厂值，**不能夹成下限**。
   *   `Prefs.raw()` 没设过时给的是 `null`，而 `Number(null)` 是 **0**（不是 NaN）——
   *   少了这一句，他从没碰过这个设置就会被悄悄改成一次 3 道（用例当场抓到）。
   *   空串同理：那是「他清空了输入框」，不是「他要 0 道」。
   */
  if (n === null || n === undefined || (typeof n === 'string' && n.trim() === '')) {
    return DEFAULT_QUESTIONS_PER_ITEM
  }
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return DEFAULT_QUESTIONS_PER_ITEM
  return Math.max(QUESTIONS_PER_ITEM_MIN, Math.min(QUESTIONS_PER_ITEM_MAX, v))
}

/**
 * ★★★ M-027 的判据本体：**连续正确的这几道，覆盖了够多种题型吗。**
 *
 * `window` 道里要出现 `min(window, 他勾的种数)` 种不同题型 —— 后一半是「不兜底」的延续：
 * 他只勾了 2 种，就不可能跨 3 种，那是他的选择，不是软件失职（如实少出，不偷偷补一种）。
 */
export const CROSS_TYPE_WINDOW = 3

export function crossesEnoughTypes(
  recent: readonly string[],
  pickedCount: number,
  span: number = CROSS_TYPE_WINDOW
): boolean {
  const last = recent.slice(-span)
  if (last.length < span) return true // 还没攒够一个窗口，谈不上违反
  return new Set(last).size >= Math.min(span, Math.max(1, pickedCount))
}

/** 洗牌用的随机源。测试传一个定死的，结果就可复现 */
export type Rnd = () => number

/** Fisher–Yates。不用 `sort(() => Math.random() - 0.5)` —— 那个不均匀 */
export function shuffle<T>(list: readonly T[], rnd: Rnd = Math.random): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * 这一档里他勾了哪些 —— **严格子集，不兜底**。
 *
 * 老实现（`QTypes.usable`）在这里有两级兜底：这一档没勾 → 退回 canonical →
 * 再没有 → 退回这一档全部。于是「我没勾造句」在第 1 档照样能把造句喂进提示词。
 * 兜底当初是为了「练习不要卡死」，但代价是**他的选择在某些档位上完全不算数**，
 * 而且他看不出为什么。卡不卡死改由上层决定（跳到有题的最近一档并说出来）。
 */
export function pickedTypes(all: readonly QTypeLite[], picked: readonly string[]): string[] {
  const on = new Set(picked)
  return all.filter((q) => on.has(q.key)).map((q) => q.key)
}

/**
 * 「按顺序」：**照他排的顺序轮着来**，用完从头再来一轮。
 *
 * ── 为什么单独一个函数，而不是「洗牌但随机源恒为 0」★ ──────
 *
 * 第一版就是那么写的（`rnd = () => 0`），以为等于「不洗牌」。**不等于。**
 * Fisher–Yates 里 `j` 恒为 0 是一个确定的置换，不是恒等变换：
 *
 *   [A,B,C]   → B,C,A
 *   [A,B,C,D] → B,C,D,A
 *
 * 而 `seq` 还是默认值，于是「按顺序」实际变成了「从你排的第二种开始」——
 * 他在设置里拖的顺序，出题时永远差一位。集合是对的，所以没有任何
 * 子集用例会红；只有一条**按位置逐个比对**的用例抓得住它。
 */
export function cycle(types: readonly string[], count: number, offset = 0): string[] {
  if (types.length === 0 || count <= 0) return []
  const start = ((offset % types.length) + types.length) % types.length
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(types[(start + i) % types.length]!)
  return out
}

/**
 * 「乱序」：洗牌队列 + 防连续重复。
 *
 * 规则（他定的）：
 *   · 打乱成一个队列，按队列依次出；用完再洗一次
 *   · **不许连着两道用同一种** —— 新一轮洗出来的头一个撞上了上一轮的尾巴，
 *     就把它和后面某一个换个位置
 *   · 只勾了一种 → 正常连续出（那是他自己的选择，不是 bug）
 */
export function rotate(types: readonly string[], count: number, rnd: Rnd = Math.random): string[] {
  if (types.length === 0 || count <= 0) return []
  if (types.length === 1) return new Array<string>(count).fill(types[0]!)

  const out: string[] = []
  while (out.length < count) {
    const round = shuffle(types, rnd)
    // 上一轮的最后一个和这一轮的第一个一样 —— 换掉，否则就连着重复了
    const last = out[out.length - 1]
    if (last !== undefined && round[0] === last && round.length > 1) {
      const swapAt = 1 + Math.floor(rnd() * (round.length - 1))
      ;[round[0], round[swapAt]] = [round[swapAt]!, round[0]!]
    }
    for (const t of round) {
      if (out.length >= count) break
      out.push(t)
    }
  }
  return out
}

/**
 * 整份出题计划：**他勾的那几种，按顺序轮，一共 `count` 道**。
 *
 * **一种都没勾就是空计划** —— 提示词里一道都不会出现，由调用方报一句人话。
 * 返回的每一项都带着确定的题型，生成后逐条比对就能挡住 AI 自己发挥。
 *
 * ★ `count` 少于他勾的种数时，这一批只轮到前 `count` 种 —— 剩下的靠 `offset`
 *   在**别的知识点**上轮到（见下面 offset 那段注释）。这是有意的：一批之内
 *   「每种都得出现」和「一批只出 3 道」是矛盾的，而他刚定了后者由他自己说了算。
 */
export function planQuestions(
  all: readonly QTypeLite[],
  picked: readonly string[],
  count = DEFAULT_QUESTIONS_PER_ITEM,
  /**
   * ★ 他在练习面板上选的「同一条知识点内部，题型的先后」。
   *   · `seq`    照他排的顺序（`qtypes` 表的 `sort`），**一位都不许偏**
   *   · `random` 洗牌 + 防连续重复
   */
  mode: 'seq' | 'random' = 'seq',
  rnd: Rnd = Math.random,
  /**
   * ★ 「按顺序」时从他排的第几种开始（跨条目错开用）。
   *
   * 一批只出 `count` 道，而他可以勾**更多种**。
   * 每一条知识点都从第一种开始的话，第 4 种往后**永远轮不到**——
   * 他勾了却一次都见不到，和「勾了不算数」是同一种失望。
   * 传知识点 id 进来，不同条目起点不同，几条下来所有形式都用得到，
   * 而每一条**内部**仍然严格按他排的顺序往后走。
   */
  offset = 0
): QSlot[] {
  const list = pickedTypes(all, picked)
  if (list.length === 0) return [] // ★ 不兜底：一种都没勾就是不出题
  const n = clampQuestionsPerItem(count)
  const seqs = mode === 'random' ? rotate(list, n, rnd) : cycle(list, n, offset)
  return seqs.map((type, seq) => ({ seq, type }))
}

/**
 * AI 回来的一道题，收不收 · ★ 硬闸
 *
 * 判据只有这一处。`study.ts` 落库之前问它，界面不需要再判一遍。
 * 收不下的**直接丢掉**，不改写成别的题型 —— AI 是照着某个题型写的题面，
 * 换个标签挂上去等于骗他：题目形式和标签对不上，而他会以为是自己看错了。
 */
export function isAllowedType(type: unknown, picked: readonly string[]): boolean {
  if (typeof type !== 'string') return false
  const t = type.trim()
  return t.length > 0 && picked.includes(t)
}

/**
 * ★★ B-lite · 按**这一档的配额**收题，不按位置对齐。
 *
 * ── 为什么不逐道对齐（`actual[i] === plan[i]`）★ ───────────
 *
 * 位置对齐太脆：AI 少写一道、多写一道、把第 3 档排到第 2 档前面 —— 都是常事。
 * 一旦错位，从那一道起后面**全部**判不合规，整批丢掉，他看到的是「出不了题」。
 * 用严格性换来的是可用性崩塌，而逐道指派本来也带不来额外保证。
 *
 * ── 配额是什么 ────────────────────────────────────────────
 *
 * 就是计划本身的**多重集**。计划 `[改写, 释义, 改写]` → 配额
 * `{改写: 2, 释义: 1}`。收题时按出现顺序贪心地扣配额，扣完的丢掉。
 *
 *   他勾 1 种 · AI 给 A A A   → 全收（配额就是 {A:3}）
 *   他勾 2 种 · AI 给 A A A   → 收 A A，第三道丢 —— **一批不会被单一题型垄断**
 *   他勾 3 种 · AI 给 A A B   → 收 A B，第二道 A 丢
 *
 * ── 配额不是「必须凑满」★ ──────────────────────────────────
 *
 * 只回来 1 道合规的，就收 1 道。**绝不为了凑满而伪造**，也绝不改标签 ——
 * AI 是照着某个形式写的题面，换个标签挂上去等于骗他。
 * 只有两个动作：**收下**、**丢掉**。
 */
export function fitQuota<T extends { type: string }>(
  rows: readonly T[],
  plan: readonly QSlot[]
): { kept: T[]; dropped: T[] } {
  /** 每一种题型还能收几道 */
  const left = new Map<string, number>()
  for (const s of plan) {
    left.set(s.type, (left.get(s.type) ?? 0) + 1)
  }
  const kept: T[] = []
  const dropped: T[] = []
  for (const r of rows) {
    const k = r.type
    const n = left.get(k) ?? 0
    if (n > 0) {
      left.set(k, n - 1)
      kept.push(r)
    } else {
      dropped.push(r)
    }
  }
  return { kept, dropped }
}

/**
 * 下一道题该避开哪几种题型 · ★★ **M-027 落在这里**（2026-09-08 起）。
 *
 * ── 为什么收的是「最近几道」而不是「上一道」 ────────────────
 *
 * 档位还在的时候，M-027 是**副产品**：答对一次换一档、每档形式不同，三连必然跨三种。
 * 档取消之后，只避开「上一道」是不够的 —— A B A 也满足「相邻不同」，
 * 而它只跨了两种，他连着三次答对的仍然是同两种形式。
 *
 * 所以这里收 `recent`（最近**真的发给过他**的那几道的题型，新的在后），
 * 优先挑一个**它们都不是**的；挑不出来再退到「至少不等于上一道」；再挑不出来才给第一个
 * （他只勾了一两种时就是这样 —— 那是他的选择，不是 bug，`crossesEnoughTypes` 也认这一条）。
 */
export function preferDifferent<T extends { type: string }>(
  candidates: readonly T[],
  recent: readonly string[]
): T | null {
  if (candidates.length === 0) return null
  /** ★ 不叫 `window` —— core 里不许出现环境相关的全局名（`qtypes.test.ts` 那道闸扫文本） */
  const tail = recent.slice(-(CROSS_TYPE_WINDOW - 1))
  if (tail.length === 0) return candidates[0]!
  const seen = new Set(tail)
  const fresh = candidates.find((q) => !seen.has(q.type))
  if (fresh) return fresh
  const last = tail[tail.length - 1]
  return candidates.find((q) => q.type !== last) ?? candidates[0]!
}
