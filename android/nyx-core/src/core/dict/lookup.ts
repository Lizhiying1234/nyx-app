/**
 * 查词语义 · D1 最后一项（2026-08-19）
 *
 * ══ 这个文件负责什么、不负责什么 ★★ ═════════════════════════
 *
 *     lookup.ts  ——「**哪一条记录**是他要的」
 *     decode/    ——「把那条记录变成 RichDictionaryEntry」
 *     adapter    ——「从磁盘上把那条记录取出来」
 *
 * 三件事分开的判据很具体：**跳转跟随要防环、要记路径、要有跳数上限**，
 * 那是查词语义，不是格式解析，也不是排版。`contract.ts` 里那句
 * 「`@@@LINK=` 已**识别**但未跟随 —— 跟随是 `lookup.ts` 的事」说的就是这里。
 *
 * ══ 它不许知道的东西（`purity.test.ts` 守着）════════════════
 *
 *   MDX · MDD · 文件路径 · Electron · SQLite · node:fs
 *
 * 它只认 `LookupSource` —— 一个「能按键取记录」的抽象。
 * 真实的 MDict adapter 满足它，测试里的假词典也满足它，
 * 将来 Android 上那一份**照搬这个文件，一个字不改**（D-238）。
 *
 * ══ 实测证据（这一节里的数字全是从他那 22 本真词典量出来的）★★ ══
 *
 *   · OALD10 抽样 79%、朗文6 81%、正确运用词汇 82% 的词目是 `@@@LINK` 跳转
 *   · 抽 3000 条跳转目标：2826 条**原样**命中、174 条**小写后**命中、
 *     **0 条**需要去标点。→ 键的归一只做「trim + 按 KeyCaseSensitive 折大小写」，
 *     去标点降级成候选词的一档，见 `STRIPPED_CHARS` 那一节
 *   · 键里**本来就带**空格 15298 次、连字符 15202 次、撇号 1890 次
 *     → 归一时把它们抹掉会把 `re-cover` 和 `recover` 并成一条，那是不可逆的损伤
 *   · 头部实测：`KeyCaseSensitive="Yes"` 只有 LCDT 一本；
 *     `StripKey="Yes"` 18 本、`"No"` 1 本（英语常用词疑难用法手册）、
 *     两本 1.2 版**没写**
 */

import type { RawRecord } from './contract.ts'
import type { DictionaryRef } from './entry.ts'
import type { DictionaryDiagnostic } from './diagnostics.ts'
import { diagnostics } from './diagnostics.ts'

// ══ 一、键的归一 ═══════════════════════════════════════════

/**
 * 一本词典的键规则。**来自文件头，不是我们定的。**
 *
 * ★ 这两条决定了「同一个字串算不算同一个键」。adapter 建索引用哪一套，
 *   查词就必须用同一套 —— 所以归一函数只有 `normalizeKey` 这一个出处，
 *   adapter 建索引时也要调它（D2/D3 接线时的硬要求）。
 *   两边各写一份「差不多的归一」是这个项目付过学费的那类 bug：
 *   99% 的词能查到，剩下 1% 查不到，而且查不到的时候什么都不报。
 */
export interface KeyRules {
  /** 头部 `KeyCaseSensitive`。实测 21 本里只有 LCDT 是 `Yes` */
  caseSensitive: boolean
  /** 头部 `StripKey`。**只影响候选词，不影响主键形**，见下 */
  stripKey: boolean
}

/**
 * 头部没写这两项时用什么。
 *
 * ★ 老实说：`stripKey` 的默认值**没有实测依据** —— 他那两本没写 StripKey 的
 *   都是 1.2 版、都是 LZO，当前根本读不开，没法验。
 *   选 `true` 是因为 StripKey 只会**多给一档候选词**，不会让任何词查不到；
 *   选错的代价是「多试一次索引」，反过来选错的代价是「有些词查不到而且没人知道」。
 *   等哪天真拿到一本能读的 1.2，这一行要回来复核。
 */
export const DEFAULT_KEY_RULES: KeyRules = { caseSensitive: false, stripKey: true }

/** 头部属性 → 键规则。`"Yes"` / `"No"` 之外的写法一律按默认值算 */
export function keyRulesFromHeader(attrs: Readonly<Record<string, string>>): KeyRules {
  const yes = (v: string | undefined, dflt: boolean): boolean =>
    v === undefined ? dflt : /^yes$/i.test(v.trim()) ? true : /^no$/i.test(v.trim()) ? false : dflt
  return {
    caseSensitive: yes(attrs['KeyCaseSensitive'], DEFAULT_KEY_RULES.caseSensitive),
    stripKey: yes(attrs['StripKey'], DEFAULT_KEY_RULES.stripKey)
  }
}

/**
 * ★★ 主键形。**索引按它建，查词按它查。**
 *
 * 只做两件事：去首尾空白、按 `caseSensitive` 折大小写。
 * **不去标点、不合并连续空白** —— 见文件头那条实测：
 * 3000 条跳转目标里 0 条需要去标点，而键里本来就带着 1.5 万个空格和连字符。
 */
export function normalizeKey(raw: string, rules: KeyRules): string {
  const s = raw.trim()
  return rules.caseSensitive ? s : s.toLowerCase()
}

/**
 * 去标点形 —— **只作候选词的一档，永远不作主键形**。
 *
 * 判据：主键形合并了就再也分不开（`re-cover` / `recover`、`were` / `we're`
 * 在他的 OALD10 里都是各自独立的词目）。而候选词多一档只是多查一次，
 * 查不到就往下走，没有任何不可逆后果。
 *
 * ★ 它能不能命中取决于 adapter 有没有建去标点索引 —— 那是 D3 的事。
 *   core 只负责**把它排在正确的位置上**。
 */
const STRIPPED_CHARS = /[\s.,;:!?'"‘’“”()[\]{}\-–—_/\\&|·]/g

export function strippedKey(raw: string, rules: KeyRules): string {
  return normalizeKey(raw, rules).replace(STRIPPED_CHARS, '')
}

// ══ 二、`@@@LINK` ══════════════════════════════════════════

/**
 * MDict 的变体重定向标记。
 *
 * ★ 这是**唯一出处**。`decode/html-entry.ts` 从这里 import ——
 *   它需要它是为了「看出这条是跳转就别去解析」，而**跟随**是这个文件的事。
 *   两处各写一个正则的话，某天有人给其中一处加了个写法，另一处照旧，
 *   于是「解码认得、查词不认得」，表现是他偶尔看到一行 `@@@LINK=xxx`。
 */
const REDIRECT = /^@@@LINK=\s*/

export function detectRedirect(body: string): string | null {
  const s = body.trimStart()
  if (!REDIRECT.test(s)) return null
  const to = s.replace(REDIRECT, '').split(/[\r\n\0]/)[0]!.trim()
  return to || null
}

/**
 * 最多跟几跳。
 *
 * 实测他的词典里链长几乎都是 1（`children` → `child` 就到头了）。
 * 给到 8 是留余量；**给上限本身**才是重点 —— 没有上限的跟随遇到
 * 互指的两条就会把整个进程转死，而他看到的是软件卡住，不是错误提示。
 */
export const MAX_REDIRECT_HOPS = 8

/** 同一个词目下最多取几条同形异义记录。防的是索引坏掉时的无限循环 */
export const MAX_HOMOGRAPHS = 32

// ══ 三、候选词 ═════════════════════════════════════════════

/**
 * 候选词的种类。**顺序就是优先级**，`CANDIDATE_ORDER` 把它写死。
 *
 * 为什么要分档而不是给一串字符串：查到之后界面要说清
 * 「他查的是 `bear the brunt of`，词典给的是 `brunt`」——
 * 不说的话他会以为词典收错了词（`entry.ts` 里 `redirectedFrom` 同理）。
 */
export type CandidateKind =
  /** 他划拉的那串，原样。**大小写敏感的词典靠它**（LCDT 的 `CD` ≠ `cd`） */
  | 'verbatim'
  /**
   * 折成小写的形。**只有大小写敏感的词典才会有这一档** ——
   * 不敏感的词典里它和 `verbatim` 归一后是同一个键，早就去重掉了。
   *
   * ★ 它存在的理由很具体：句首的词是大写的。他在 LCDT
   *  （21 本里唯一 `KeyCaseSensitive=Yes` 的）里划一个句首的 `Sway`，
   *   严格按大小写查就是查不到，而**查不到的时候什么都不会报** ——
   *   正是这个项目最贵的那种静默失效。
   */
  | 'casefold'
  /** 去标点形（StripKey 开着才有） */
  | 'stripped'
  /** 掐掉首尾虚词之后的短语：`bear the brunt of` → `bear the brunt` */
  | 'phrase'
  /** 里面最实的那个词：`bear the brunt of` → `brunt` */
  | 'word'
  /** 词形还原：`swayed` → `sway`、`crises` → `crisis` */
  | 'inflection'

export const CANDIDATE_ORDER: readonly CandidateKind[] = [
  'verbatim', 'casefold', 'stripped', 'phrase', 'word', 'inflection'
]

export interface LookupCandidate {
  text: string
  kind: CandidateKind
  /** 在 `CANDIDATE_ORDER` 里的位置。越小越优先 */
  rank: number
}

/**
 * 虚词。**查它们没有意义**：`of` 的词条对学 `bear the brunt of` 毫无用处，
 * 而且它们几乎在每一本词典里都有词条 —— 不排掉的话，
 * 「整条查不到就退到里面的词」这一步会稳定地退到 `of` 上去。
 */
const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'out', 'up', 'off', 'over', 'into', 'onto', 'than', 'that', 'this', 'these',
  'be', 'is', 'are', 'was', 'were', 'been', 'being', 'get', 'got', 'have', 'has',
  'had', 'do', 'does', 'did', 'one', 'and', 'or', 'not', 'no', 'it', 'its',
  'their', 'his', 'her', 'your', 'my', 'own', 'some', 'any', 'all'
])

/**
 * 不规则形。**兜底，不是主路** —— 词典自己的 `@@@LINK` 才是主路
 *（OALD10 里 `children` 就是一条指向 `child` 的跳转）。
 * 这张表只管那些**连跳转都没有**的词典，短小是故意的：
 * 长表意味着我在猜词法，而猜错的候选词会把查词引到别的词上去。
 */
const IRREGULAR: Readonly<Record<string, string>> = {
  children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth',
  geese: 'goose', mice: 'mouse', lice: 'louse', oxen: 'ox',
  went: 'go', gone: 'go', done: 'do', said: 'say', made: 'make',
  took: 'take', taken: 'take', came: 'come', saw: 'see', seen: 'see',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad'
}

/**
 * 词形还原的候选。**产出的是「可能的原形」，不是「正确答案」** ——
 * 多给一两个查不到的候选没有代价（查不到就往下走），
 * 少给一个正确的候选就是「这个词永远查不到」。
 *
 * 只对长度 ≥ 4 的词做：`is` `as` `ed` 这种做还原纯属添乱。
 */
export function inflectionForms(word: string): string[] {
  const w = word.toLowerCase()
  const out: string[] = []
  const add = (s: string): void => {
    if (s.length >= 2 && s !== w && !out.includes(s)) out.push(s)
  }

  const irregular = IRREGULAR[w]
  if (irregular) add(irregular)
  if (w.length < 4) return out

  // 复数
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y')
  /**
   * 希腊系复数：`crises` → `crisis`、`analyses` → `analysis`、`theses` → `thesis`。
   *
   * ★ 必须排在下面那条通用的 `-es` 规则**前面**。实测：`crises` 走通用规则
   *   会先得到 `cris`，而真有词典收了 `cris` 这个词目 —— 于是查 `crises`
   *   给出的是 `cris` 那一条。同一档里的顺序就是优先级。
   */
  if (w.endsWith('ses')) add(w.slice(0, -3) + 'sis')
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('zes') || w.endsWith('ches') || w.endsWith('shes')) {
    add(w.slice(0, -2))
  }
  if (w.endsWith('ves')) {
    add(w.slice(0, -3) + 'f')
    add(w.slice(0, -3) + 'fe')
  }
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1))

  // 过去式 / 过去分词
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('ed')) {
    add(w.slice(0, -2))
    add(w.slice(0, -1))
    if (isDoubled(w.slice(0, -2))) add(w.slice(0, -3))
  }

  // 现在分词
  if (w.endsWith('ing')) {
    add(w.slice(0, -3))
    add(w.slice(0, -3) + 'e')
    if (isDoubled(w.slice(0, -3))) add(w.slice(0, -4))
  }

  // 比较级 / 最高级
  if (w.endsWith('est')) add(w.slice(0, -3))
  if (w.endsWith('ier')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('er')) add(w.slice(0, -2))

  return out
}

/** `stopped` 去掉 `ed` 之后是 `stopp` —— 末尾两个相同辅音，说明重复过 */
function isDoubled(stem: string): boolean {
  const n = stem.length
  if (n < 3) return false
  const a = stem[n - 1]!
  const b = stem[n - 2]!
  return a === b && /[bcdfghjklmnpqrstvwxz]/.test(a)
}

/** 拆词。撇号和连字符**留在词里**（`don't` `well-known` 是一个词） */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-zÀ-ɏ'’-]+/)
    .filter(Boolean)
}

/**
 * ★★ 候选词的完整策略。**判据只有这一处**，`Dicts` / adapter / 界面都不许自己算。
 *
 * 顺序（`CANDIDATE_ORDER`）：
 *
 *   1. `verbatim`    他划拉的那串原样        —— 大小写敏感的词典只认它
 *   2. `normalized`  归一形                  —— 绝大多数命中在这一档
 *   3. `stripped`    去标点形                —— StripKey 开着才有
 *   4. `phrase`      掐掉首尾虚词的短语      —— `bear the brunt of` → `bear the brunt`
 *   5. `word`        里面最实的那个词        —— 长的排前面，虚词不要
 *   6. `inflection`  词形还原                —— 最后一档，因为它是**猜**
 *
 * 为什么整条优先：Nyx 的条目大多是多词表达，而词典按词目收 ——
 * 整条要是真收了（`bear the brunt of` 在朗文里就有），那一条最贴题；
 * 收不了才退到 `brunt`。**退了要说出来**，所以每个候选都带着 `kind`。
 */
export function candidates(query: string, rules: KeyRules = DEFAULT_KEY_RULES): LookupCandidate[] {
  const out: LookupCandidate[] = []
  /**
   * ★ 去重按**归一后的键**，不按字面 —— 不敏感的词典里 `CD` 和 `cd`
   *   查的是同一个键，两条都留着只是白查一次。
   */
  const seen = new Set<string>()
  const rankOf = (k: CandidateKind): number => CANDIDATE_ORDER.indexOf(k)
  const push = (text: string, kind: CandidateKind): void => {
    const t = text.trim()
    if (!t) return
    const key = normalizeKey(t, rules)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ text: t, kind, rank: rankOf(kind) })
  }

  const q = query.trim()
  if (!q) return out

  push(q, 'verbatim')
  if (rules.caseSensitive) push(q.toLowerCase(), 'casefold')
  if (rules.stripKey) push(strippedKey(q, rules), 'stripped')

  const ws = words(q)
  if (ws.length > 1) {
    // 掐掉首尾虚词。中间的虚词留着 —— `bear the brunt` 里那个 `the` 是词条的一部分
    let lo = 0
    let hi = ws.length - 1
    while (lo <= hi && STOP.has(ws[lo]!)) lo++
    while (hi >= lo && STOP.has(ws[hi]!)) hi--
    if (hi >= lo && (lo > 0 || hi < ws.length - 1)) push(ws.slice(lo, hi + 1).join(' '), 'phrase')
  }

  /** 最长的那个多半是最实的那个词 */
  const content = [...new Set(ws.filter((w) => w.length > 2 && !STOP.has(w)))].sort(
    (a, b) => b.length - a.length
  )
  for (const w of content) push(w, 'word')

  const bases = ws.length === 1 ? [ws[0]!] : content
  for (const w of bases) for (const f of inflectionForms(w)) push(f, 'inflection')

  return out
}

// ══ 四、查词的抽象来源 ═════════════════════════════════════

/**
 * 一本**已经打开**的词典，从查词语义的角度看只需要这么多。
 *
 * ★ 真实的 `OpenDictionary`（`contract.ts`）结构上满足它，
 *   但这里**故意**只要这三样：没有 `resource()`、没有 `keys()`、没有 `close()`。
 *   查词语义碰不到资源、不遍历全表、不管生命周期 ——
 *   接口窄一分，将来能塞进来的错误就少一分。
 */
export interface LookupSource {
  readonly book: DictionaryRef
  readonly keyRules: KeyRules
  /**
   * 按**已归一**的键找真实词目。可能多条（同形异义、大小写变体）。
   * ★ 传进来的键已经过 `normalizeKey`，adapter 不要再归一一次。
   */
  match(normalizedKey: string): readonly string[]
  /**
   * 取第 `occurrence` 条记录（从 0 开始）。
   * ★ 取不到就返回 `null` —— 调用方靠「返回 null」知道到头了，
   *   所以 adapter **不许**在越界时抛异常。
   */
  raw(headword: string, occurrence?: number): RawRecord | null
}

// ══ 五、同形异义 ═══════════════════════════════════════════

/**
 * 一个词目底下的全部记录。
 *
 * ★ 实测：`OpenDictionary` 之前那版索引写的是
 *   `if (!index.has(lower)) index.set(...)` —— OALD10 丢 6909 条、
 *   UrbanDictionary 丢 7254 条。**丢在索引里就再也拿不回来了**，
 *   所以这一层必须把「有几条」问清楚，而不是默认只有一条。
 */
export function allRecords(
  src: LookupSource,
  headword: string,
  cap = MAX_HOMOGRAPHS
): RawRecord[] {
  const out: RawRecord[] = []
  for (let i = 0; i < cap; i++) {
    const rec = src.raw(headword, i)
    if (!rec) break
    out.push(rec)
  }
  return out
}

// ══ 六、跳转跟随 ═══════════════════════════════════════════

export interface Resolved {
  /** 跟到底之后那条真正的记录。跟坏了就是 `null` */
  record: RawRecord | null
  /** 最终落在哪个词目上 */
  headword: string
  occurrence: number
  /**
   * 跳过来的路径。`['children']` = 从 `children` 跳到了这里。
   * ★ 界面要显示它 —— 他查的是 `children`，看到的是 `child`。
   */
  redirectedFrom: string[]
  diagnostic?: DictionaryDiagnostic
}

/**
 * ★★ 跟着 `@@@LINK` 走到底。
 *
 * 三种坏情况**都必须有话说**，一种都不许静悄悄返回空：
 *
 *   环      `A → B → A`      —— 有环就停，报出整条路径
 *   太深    超过 `maxHops`    —— 停，报出已经走过的路径
 *   断链    目标词目不存在    —— 停，说清「从哪跳向哪、那个词目不在」
 *
 * 这三条是这个文件存在的主要理由。没有它们，第一条互指的词条
 * 就会把查词转死，而他看到的是「软件卡住了」。
 */
export function resolveRedirects(
  src: LookupSource,
  headword: string,
  occurrence = 0,
  maxHops = MAX_REDIRECT_HOPS
): Resolved {
  const path: string[] = []
  const visited = new Set<string>([normalizeKey(headword, src.keyRules)])
  let cur = headword
  let occ = occurrence

  for (let hop = 0; ; hop++) {
    const rec = src.raw(cur, occ)
    if (!rec) {
      // 第 0 跳就没有 = 这个词目本来就不在这本里，不是错误（查不到是常态）
      if (hop === 0) return { record: null, headword: cur, occurrence: occ, redirectedFrom: path }
      return {
        record: null,
        headword: cur,
        occurrence: occ,
        redirectedFrom: path,
        diagnostic: diagnostics.redirectDangling(path[path.length - 1] ?? headword, cur)
      }
    }

    const to = rec.redirectTo ?? detectRedirect(rec.body)
    if (!to) return { record: rec, headword: cur, occurrence: occ, redirectedFrom: path }

    if (hop >= maxHops) {
      return {
        record: null,
        headword: cur,
        occurrence: occ,
        redirectedFrom: path,
        diagnostic: diagnostics.redirectTooDeep([...path, cur], maxHops)
      }
    }

    const next = matchOne(src, to)
    if (next === null) {
      return {
        record: null,
        headword: cur,
        occurrence: occ,
        redirectedFrom: path,
        diagnostic: diagnostics.redirectDangling(cur, to)
      }
    }

    const key = normalizeKey(next, src.keyRules)
    if (visited.has(key)) {
      return {
        record: null,
        headword: cur,
        occurrence: occ,
        redirectedFrom: path,
        diagnostic: diagnostics.redirectCycle([...path, cur, next])
      }
    }

    visited.add(key)
    path.push(cur)
    cur = next
    occ = 0
  }
}

/**
 * 跳转目标 → 真实词目。
 *
 * 实测 3000 条目标：2826 条原样命中、174 条小写后命中（`normalizeKey` 管这一档）、
 * 0 条需要去标点。去标点那一档留着是为了 StripKey 开着的词典里
 * 那些「目标写法与词目写法不一致」的少数条目 —— 试一次不花钱。
 */
function matchOne(src: LookupSource, target: string): string | null {
  const direct = src.match(normalizeKey(target, src.keyRules))
  if (direct.length > 0) return direct[0]!
  if (!src.keyRules.stripKey) return null
  const stripped = src.match(strippedKey(target, src.keyRules))
  return stripped.length > 0 ? stripped[0]! : null
}

// ══ 七、主入口 ═════════════════════════════════════════════

export interface LookupHit {
  book: DictionaryRef
  /** 他划拉的那串，原样 */
  query: string
  /** 真正命中的词目（跟完跳转之后的） */
  headword: string
  /** 靠哪一档候选词命中的 —— 界面要靠它说「实际查的是 X」 */
  candidate: LookupCandidate
  redirectedFrom: string[]
  /** 这是该词目下的第几条（0 起） */
  occurrence: number
  /** 该词目下一共几条 */
  homographs: number
  record: RawRecord
}

export interface LookupResult {
  query: string
  /** 按「候选词档次 → 词典顺序 → 记录序号」排好 */
  hits: LookupHit[]
  /**
   * 查词过程中发现的问题。**查不到不是问题**（词典没收这个词是常态），
   * 跳转坏了才是 —— 那说明这本词典或我们的跟随逻辑有毛病。
   */
  diagnostics: DictionaryDiagnostic[]
}

export interface LookupOptions {
  /** 最多几本词典出结果。界面上「N 本查到」用得着 */
  maxBooks?: number
  maxHomographs?: number
  maxHops?: number
  /**
   * 只用这几档候选词。不给就是全用。
   *
   * ★★ D3 接线时用它把改动**限制在 `@@@LINK` 这一件事上**。
   *
   * 他的规矩：「D2 行为等价；**D3 第一次允许改变用户可见查词结果**，
   * 但只能出现在 redirect 相关路径。」
   * 而 `stripped`（`per cent` → `percent`）、`inflection`（`swayed` → `sway`）、
   * `phrase` 这三档会在**没有跳转**的词典里也改变结果 —— 那不是 redirect 带来的。
   * 所以 D3 只开老路径本来就有的两档（`verbatim` + `word`），
   * 剩下三档留着，等他点头再开。
   *
   * 顺序仍然由 `CANDIDATE_ORDER` 说了算 —— 这里只做筛选，不做重排。
   */
  kinds?: readonly CandidateKind[]
}

/**
 * ★★ 按优先级在多本词典里查一个词。
 *
 * ── 两层循环的顺序是有讲究的 ★ ──────────────────────────────
 *
 *     for 候选词 (外层)
 *       for 词典 (内层，就是他在设置页拖出来的顺序)
 *
 * **整条命中优先于词目命中**：`bear the brunt of` 在第 5 本里有整条，
 * 在第 1 本里只有 `brunt` —— 该给他第 5 本那条。
 * 反过来写（词典在外层）就会拿第 1 本的 `brunt` 交差，
 * 而他永远不知道有一本收了整条。
 *
 * ── 一档命中就收手 ─────────────────────────────────────────
 *
 * 某一档候选词只要有词典命中，就不再往下试更弱的档次 ——
 * 否则 `swayed` 会同时返回 `swayed`（整条）和 `sway`（还原），
 * 界面上并排摆着两条，他分不清哪条才是他查的。
 */
export function lookup(
  books: readonly LookupSource[],
  query: string,
  opts: LookupOptions = {}
): LookupResult {
  const maxBooks = opts.maxBooks ?? 3
  const maxHomographs = opts.maxHomographs ?? MAX_HOMOGRAPHS
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS
  const out: LookupResult = { query, hits: [], diagnostics: [] }
  if (!query.trim() || books.length === 0) return out

  /** 每本词典各自试过哪些键 —— 键规则各不相同，所以去重要按本记 */
  const tried = books.map(() => new Set<string>())

  const allowed = opts.kinds ? CANDIDATE_ORDER.filter((k) => opts.kinds!.includes(k)) : CANDIDATE_ORDER
  for (const kind of allowed) {
    const hits: LookupHit[] = []
    const booksHit = new Set<string>()

    for (let b = 0; b < books.length; b++) {
      const src = books[b]!
      if (booksHit.size >= maxBooks && !booksHit.has(src.book.uid)) continue

      for (const cand of candidates(query, src.keyRules)) {
        if (cand.kind !== kind) continue
        const key = normalizeKey(cand.text, src.keyRules)
        if (tried[b]!.has(key)) continue
        tried[b]!.add(key)

        const heads = src.match(key)
        if (heads.length === 0) continue

        for (const head of heads) {
          const records = allRecords(src, head, maxHomographs)
          for (let i = 0; i < records.length; i++) {
            const r = resolveRedirects(src, head, i, maxHops)
            if (r.diagnostic) out.diagnostics.push(r.diagnostic)
            if (!r.record) continue
            hits.push({
              book: src.book,
              query,
              headword: r.headword,
              candidate: cand,
              redirectedFrom: r.redirectedFrom,
              occurrence: r.occurrence,
              homographs: records.length,
              record: r.record
            })
            booksHit.add(src.book.uid)
          }
        }
        if (booksHit.has(src.book.uid)) break // 这本已经在这一档命中了，别再试更弱的候选
      }
    }

    if (hits.length > 0) {
      out.hits = hits
      return out
    }
  }
  return out
}
