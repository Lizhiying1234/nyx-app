/**
 * 讲次内重复知识点的**判据** —— 分组 · 分档 · 选主 · 逐表迁移计划（T-2.11 · D-026）
 *
 * ══ 它回答什么、不回答什么 ═══════════════════════════════════
 *
 * 回答：哪几条是同一个知识点、哪一条留下、被并那条的每张子表该怎么处理。
 * **不回答**：怎么写库（那是 `main/db/merge.ts` 一个事务的事）、
 * 什么时候扫（那是界面的事）。这里一行 SQL 都没有，一个自增 id 都不认 ——
 * 只认 uid，所以两端都能用同一份判据（D-238 / D-365）。
 *
 * ══ 一、什么算「同一条」 ═════════════════════════════════════
 *
 * 同一讲次内 `normalizeTerm(term)` 相同。就这一条，**不做语义相似**：
 * 「同义但不同字面」要不要合，使用者可能有不同看法，猜错的后果是
 * 悄悄并掉两条本来不同的知识点 —— 那是不可逆的。
 *
 * ══ 二、Safe 与 Review ═══════════════════════════════════════
 *
 * **Safe** = 这一组里每一条被并的，相对留下那条都满足全部四条：
 *
 *   ① 同 `layer`     —— ★ 少了这一条，/[A]/ 理解层和 /[B]/ 写作层的同一个词
 *                        会被当成重复并掉。那是两种不同的学习状态，不是重复。
 *   ② `gloss` 相同或一方为空 —— 两条都写了释义而且不一样 = 他有话要说，得他来看
 *   ③ 分析块不冲突   —— 被并那条的块，留下那条要么没有、要么**逐字相同**
 *   ④ 被并那条没有学习史（`answers` / `review_logs`）—— 有学习史 = 并掉会丢历史
 *
 * 其余同字面的组一律 **Review**：不自动动，逐条给差异让他选。
 *
 * ★ 一组里只要有**一条**被并的不满足，**整组**进 Review。
 *   理由：「这组里有两条能安全合、第三条要你看」这种半自动结果，
 *   界面上说不清楚，他也无法一眼验收。宁可整组交给他。
 *
 * ══ 三、留下哪一条（canonical） ══════════════════════════════
 *
 * 学习史最多者（`review_logs` + `answers`）→ 平手取最早 `created_at`
 * （最早那条更可能已经被别处引用）→ 再平手取 uid 字典序。
 * **最后这一条是为了确定性**：同一份输入必须每次都算出同一个主记录，
 * 否则两台设备各并各的，合出来的东西对不上。
 *
 * ══ 四、逐表迁移计划 ═════════════════════════════════════════
 *
 * 判据来自 `core/identity.ts::IDENTITY_SPECS`（不是记忆，是那份清单）：
 *
 *   **自然身份**（uid 由 item uid 算出）→ **不改 FK**，在 canonical 名下**新建**它缺的：
 *     `item_lectures`（知识点, 讲）· `occurrences`（知识点, 材料/讲）
 *     · `analysis_blocks`（知识点, 区块名）· `reading_cards`（知识点，一比一）
 *     改 FK 会让 uid 和正文对不上 —— 那正是同步身份的地基。
 *
 *   **随机身份**（uid 随机，`item_id` 只是一列）→ **直接改 `item_id`**，
 *   同步侧靠 `fk-map.ts` 把 FK 翻成 uid，改了就会同步过去：
 *     `answers` · `review_logs` · `item_events` · `questions` · `state_events`
 *     · `items.derived_from`（自引用，`fk-map` 里那唯一一条）
 *
 *   ★ `questions` · `state_events` · `derived_from` 这三处 PLAN 与需求归档 §六
 *     都没点名，是逐条对 `schema/v38.sql` 里 10 处 `references items(id)` 查出来的。
 *     不处理的话，合并之后它们仍然指着一条已经躺进回收站的知识点。
 *
 *   ★ `term_ledger` 按 `norm` / `verdict` / 讲次记账，**跟 item 无关，不动**。
 */
import { normalizeTerm } from '../normalize-term.ts'

// ── 输入 ────────────────────────────────────────────────────

/** 分组分档要看的那几样。core 不认自增 id，只认 uid。 */
export interface DedupItem {
  uid: string
  term: string
  gloss: string
  layer: string
  createdAt: number
  /** 产出线作答数 */
  answers: number
  /** 认读线复习数 */
  reviewLogs: number
  /** 分析块：区块名 → 正文 */
  blocks: readonly { readonly block: string; readonly content: string }[]
}

/** 一条知识点在各张子表上现有的东西 —— 算迁移计划要看的 */
export interface ItemRows {
  /** 归属的讲（`item_lectures`），元素是 lecture 的 uid */
  lectures: readonly string[]
  /**
   * 出处（`occurrences`）的自然键。
   * `identity.ts` 的规则：material 非空时是 (知识点, 材料)，否则是 (知识点, 讲) ——
   * 所以这里的元素写成 `m|<材料 uid>` 或 `l|<讲 uid>`，和那份规则一一对应。
   */
  occurrences: readonly string[]
  /** 分析块的区块名（`analysis_blocks`） */
  blocks: readonly string[]
  /** 有没有认读卡（`reading_cards` 一比一，`unique(item_id)`） */
  card: boolean
  /** 随机身份那几张表各有多少行 */
  answers: number
  reviewLogs: number
  itemEvents: number
  questions: number
  stateEvents: number
  /** 以它为父的析出项条数（`items.derived_from`） */
  derived: number
  /** 「再收一次」的计数（D-026），合并时相加 */
  recollected: number
}

// ── 输出 ────────────────────────────────────────────────────

export type Bucket = 'safe' | 'review'

export interface DedupGroup {
  /** 归一之后的字面 —— 界面上给他看的就是它 */
  norm: string
  bucket: Bucket
  /** 留下的那条 */
  canonical: string
  /** 被并掉的那些 */
  losers: readonly string[]
  /** 进 Review 的理由，一条一句人话；Safe 时为空 */
  reasons: readonly string[]
}

export interface DedupScan {
  groups: readonly DedupGroup[]
  /** 受影响的条数 = 所有组的成员总数（含 canonical） */
  affected: number
  safe: number
  review: number
}

export type MergeStep =
  /** 自然身份：在 canonical 名下新建一行（uid 由触发器按自然键算） */
  | { kind: 'create'; table: string; key: string }
  /** 自然身份：canonical 已经有了 —— 旧行留在被并那条名下，不动 */
  | { kind: 'keep'; table: string; key: string }
  /** 随机身份：把这么多行的 `item_id` 改到 canonical */
  | { kind: 'repoint'; table: string; rows: number }
  /** 计数相加 */
  | { kind: 'add'; table: string; column: string; value: number }

export interface MergePlan {
  canonical: string
  loser: string
  steps: readonly MergeStep[]
}

// ── 分组 ────────────────────────────────────────────────────

/** gloss 判据：相同，或者一方为空（空 = 没话要说，不算分歧） */
const glossCompatible = (a: string, b: string): boolean => {
  const x = a.trim()
  const y = b.trim()
  return x === '' || y === '' || x === y
}

/** 分析块判据：被并那条的每一块，canonical 要么没有、要么逐字相同 */
function blocksCompatible(canonical: DedupItem, loser: DedupItem): boolean {
  const mine = new Map(canonical.blocks.map((b) => [b.block, b.content]))
  for (const b of loser.blocks) {
    const c = mine.get(b.block)
    if (c !== undefined && c !== b.content) return false
  }
  return true
}

const history = (i: DedupItem): number => i.answers + i.reviewLogs

/**
 * 选主：学习史最多 → 最早 `created_at` → uid 字典序。
 * 最后一档不是凑数，是**确定性**：两台设备算出不同的主记录就对不上了。
 */
const canonicalOrder = (a: DedupItem, b: DedupItem): number =>
  history(b) - history(a) ||
  a.createdAt - b.createdAt ||
  (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)

function pickCanonical(items: readonly DedupItem[]): DedupItem {
  /**
   * ★★ 这里原来是 `[...items].sort(…)[0]`，判据一模一样，**但 Android 编不过**：
   *   那边 `tsconfig` 开着 `noUncheckedIndexedAccess`，于是 `[0]` 的类型是
   *   `DedupItem | undefined`，而这个函数声明返回 `DedupItem`（T-9.13，C 撞出来的）。
   *
   * ★ 为什么不是「先判 `items.length === 0` 再取 `[0]`」：**那样编译器仍然不放行** ——
   *   `length` 的判断不会让 TS 收窄 `arr[0]` 的类型（它没有这条推理）。
   *   能收窄的是**对取出来的那个值本身**判 `undefined`，所以这里解构出 `head` 再判。
   * ★ 也不用 `!`：那是「我保证不会」，而这个函数拿到空数组是**真的会**发生的编程错误
   *   （调用点漏了 `members.length < 2` 那道过滤），断言只会把它推到更远的地方去炸。
   * ★ 判据一个字没变：`reduce` 取的就是这套比较器下的最小元 —— 与「排完取第一个」等价，
   *   平手时保留先到的那条（比较器只在 uid 相同才回 0，所以不存在真正的平手）。
   */
  const [head, ...rest] = items
  if (head === undefined) {
    throw new Error('选主时收到空的一组 —— 一组至少要有两条（scanDuplicates 只把 ≥2 条的算一组）')
  }
  return rest.reduce((best, x) => (canonicalOrder(x, best) < 0 ? x : best), head)
}

/**
 * 扫一讲。返回的组按 `norm` 排序 —— 界面上顺序稳定，用例也好写。
 *
 * ★ 只有**两条以上**才算一组：一条不是重复。
 */
export function scanDuplicates(items: readonly DedupItem[]): DedupScan {
  const byNorm = new Map<string, DedupItem[]>()
  for (const it of items) {
    const norm = normalizeTerm(it.term)
    if (!norm) continue // 空字面不参与查重：那是脏数据，不是重复
    const arr = byNorm.get(norm)
    if (arr) arr.push(it)
    else byNorm.set(norm, [it])
  }

  const groups: DedupGroup[] = []
  let affected = 0
  for (const [norm, members] of [...byNorm.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (members.length < 2) continue
    const canonical = pickCanonical(members)
    const losers = members.filter((m) => m.uid !== canonical.uid)

    const reasons: string[] = []
    for (const l of losers) {
      if (l.layer !== canonical.layer) {
        reasons.push(`层不同（${canonical.layer} / ${l.layer}）—— 理解层和写作层是两种状态，不是重复`)
      }
      if (!glossCompatible(canonical.gloss, l.gloss)) reasons.push('两条都写了释义，而且不一样')
      if (!blocksCompatible(canonical, l)) reasons.push('分析块内容不一致')
      if (history(l) > 0) reasons.push(`被并那条有学习史（作答 ${l.answers} · 复习 ${l.reviewLogs}）`)
    }

    groups.push({
      norm,
      bucket: reasons.length === 0 ? 'safe' : 'review',
      canonical: canonical.uid,
      losers: losers.map((l) => l.uid),
      // 同一句理由在一组里可能出现多次（多条 loser），去重之后才是人话
      reasons: [...new Set(reasons)]
    })
    affected += members.length
  }

  return {
    groups,
    affected,
    safe: groups.filter((g) => g.bucket === 'safe').length,
    review: groups.filter((g) => g.bucket === 'review').length
  }
}

// ── 逐表迁移计划 ────────────────────────────────────────────

/**
 * 被并那条的东西怎么落到 canonical 头上。
 *
 * 自然身份的四张表：canonical 没有的**新建**，已有的**留旧行不动**
 * （旧行跟着被并那条一起躺进回收站，保留期到了随级联清掉）。
 * 随机身份的五处：直接改 `item_id`。
 */
export function planMerge(
  canonical: string,
  loser: string,
  c: ItemRows,
  l: ItemRows
): MergePlan {
  const steps: MergeStep[] = []

  const natural = (table: string, mine: readonly string[], theirs: readonly string[]): void => {
    const have = new Set(mine)
    for (const key of theirs) {
      steps.push(have.has(key) ? { kind: 'keep', table, key } : { kind: 'create', table, key })
    }
  }

  natural('item_lectures', c.lectures, l.lectures)
  natural('occurrences', c.occurrences, l.occurrences)
  natural('analysis_blocks', c.blocks, l.blocks)
  // 认读卡一比一：canonical 没有卡而被并那条有，才在 canonical 名下建一张
  if (l.card) {
    steps.push(
      c.card
        ? { kind: 'keep', table: 'reading_cards', key: canonical }
        : { kind: 'create', table: 'reading_cards', key: canonical }
    )
  }

  const repoint = (table: string, rows: number): void => {
    if (rows > 0) steps.push({ kind: 'repoint', table, rows })
  }
  repoint('answers', l.answers)
  repoint('review_logs', l.reviewLogs)
  repoint('item_events', l.itemEvents)
  repoint('questions', l.questions)
  repoint('state_events', l.stateEvents)
  repoint('items.derived_from', l.derived)

  if (l.recollected > 0) {
    steps.push({
      kind: 'add',
      table: 'items',
      column: 'recollected_count',
      value: l.recollected
    })
  }

  return { canonical, loser, steps }
}
