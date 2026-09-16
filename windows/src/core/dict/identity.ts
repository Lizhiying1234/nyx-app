/**
 * 词典的跨设备身份 · D1（2026-08-19）
 *
 * ══ 一、病 ═══════════════════════════════════════════════════
 *
 * `dictionaries` 今天的唯一键是 `ifo_path`。**路径一变，这一行的身份就没了。**
 * I-106 那次「22 本文件不见了 + 22 本新的」就是这么来的 ——
 * 排序和启用状态全丢，因为它们记在旧行上。
 *
 * 现在靠 `basename` 认领打了补丁，但那是**在没有身份的前提下猜身份**：
 * 文件名一样就认，有歧义就不动。改个文件名它就认不出来了。
 *
 * ══ 二、规格（deterministic identity specification）★★ ═══════
 *
 * 身份 = 七个**归一后**的分量，交给 `natUid('dictionaries', parts)` 编码。
 *
 *   ┌ 序 ┬ 分量            ┬ 归一规则                                        ┐
 *   │ 1 │ format          │ 小写。`mdict` / `stardict`                      │
 *   │ 2 │ formatVersion   │ 去空白。`2.0` / `1.2` / `3.0.0`                 │
 *   │ 3 │ encoding        │ 大写去空白。`UTF-8` / `GBK`                     │
 *   │ 4 │ title           │ 去首尾空白 + 内部连续空白折成一个空格            │
 *   │ 5 │ entryCount      │ 十进制整数，无分隔符、无正负号                   │
 *   │ 6 │ blockCount      │ 同上                                            │
 *   │ 7 │ indexBytes      │ 同上                                            │
 *   └───┴─────────────────┴─────────────────────────────────────────────────┘
 *
 * 空分量一律写成 `ABSENT`（`-`），**不是空串** —— `natUid` 拒绝空串，
 * 而「这本词典没写 Title」本身就是一个要参与身份的事实。
 *
 * ── 二之二、取值约定：头部的哪个字段填进哪个分量 ★★★ ─────────
 *
 * 使用者 2026-08-19 裁决：**这两条永久固定**，将来 Android 重写照抄。
 *
 *   ┌ 分量          ┬ 取头部的哪一个                      ┬ 取错会怎样            ┐
 *   │ formatVersion │ `GeneratedByEngineVersion` **原字符串** │ parseFloat 之后      │
 *   │               │ `"2.0"`                             │ `"2.0"` → `"2"`，     │
 *   │               │                                     │ **21 本全部另一个身份**│
 *   │ indexBytes    │ **词条块段**的字节数 `keyBlocksLen`  │ 取成 keyInfo 的长度， │
 *   │               │（21 世纪那本 = 2927490）             │ 同样全部漂掉          │
 *   └───────────────┴─────────────────────────────────────┴───────────────────────┘
 *
 * ★ 危险之处在于**取错了照样跑得通**：21 本照样算出 21 个不重复的 uid，
 *   只是和另一台机器上算出来的没有一个对得上 —— 他在第二台设备上
 *   一本词典都认不出来，而且什么都不报。
 *
 * 实现的唯一出处是 `core/dict/mdx-header.ts::identityOf()`（T-4.15 起）——
 * 体检那条路（`main/dict/mdict-header.ts::probeMdict`）、读词那条路
 * （`core/dict/mdx.ts::Mdx`）、喂 `dictUid` 的 adapter，三处**读的是同一段代码**。
 * 在那之前三处各拼一遍、同源只写在注释里，而 GBK 那次已经真的漂过一次。
 * 回归向量在 `identity.test.ts` 第 ④ 段 + `fixtures/identity-uids.json`
 *（他真实 21 本的 uid 逐字钉死）；两条路对同一本书答案是否相同，由
 * `tests/dict-mdx.test.ts` 的「体检那条路与读词那条路读的是同一份头」那一段钉。
 *
 * ══ 三、三条「不许用」★★ ════════════════════════════════════
 *
 *   · **不用路径**   —— 路径会变，这正是 I-106 的病根
 *   · **不用 mtime** —— 拷贝、解压、同步网盘都会改它，而词典内容一个字节没动
 *   · **不用整文件 hash** —— `UrbanDictionary.mdx` 471 MB。每次扫描哈希一遍，
 *                            等于把 D5 好不容易省下来的启动时间又还回去
 *
 * 上面七个分量**全部在解析头部时反正要读**，额外 I/O = 0 字节。
 *
 * ══ 四、为什么不再套一层 hash ═══════════════════════════════
 *
 * 审计报告里写的是 `sha1(...)`。落地时改掉了，三个理由：
 *
 *   ① `natUid` 的转义（`\`→`\\`、`|`→`\p`）**本身就是可证明无歧义的编码**，
 *      它的注释里有证明。hash 是在一个已经无歧义的东西上再加一层。
 *   ② core 里就不必引入哈希原语。`node:crypto` 虽然没被 `purity.test.ts` 拦，
 *      但 Android 端要另找一个「逐位相同」的实现 —— 那是个白付的风险（D-238）。
 *   ③ **uid 能读**。对不上的时候一眼看得出是哪一段变了；
 *      hash 只会告诉你「不一样」，然后你得去 dump 两边的头部。
 *
 * ══ 五、为什么不进 `IDENTITY_SPECS` ═════════════════════════
 *
 * `core/identity.ts` 那七张表的身份是**SQL 表达式**（给 uid 触发器用），
 * 由行里的列算出来。词典身份算自**文件头的字节**，没有任何 SQL 表达式能产出它，
 * 而且 `dictionaries` 根本不进 `SYNC_TABLES`（D-222）。
 * 硬塞进去会让那张表变成「两种含义混在一起」的清单，
 * `identity.test.ts` 里钉死表名的那条用例也会红 —— 它红得对。
 *
 * ══ 六、已知的边界（老老实实写出来）═════════════════════════
 *
 *   · 同一本词典被**重新打包**（改了 Title 或重排了词块）→ 算成新的一本。
 *     后果是排序和启用状态回到默认，不是数据丢失。可接受。
 *   · 两本**内容不同但七个分量全都撞上**的词典 → 会被当成同一本。
 *     实测他那 21 本真词典零碰撞（见 `identity.test.ts` 的向量），
 *     但**这不是证明**，所以 registry 认领时还要比一次文件名，
 *     并且把「uid 相同但文件不同」记成一条诊断而不是静悄悄合并。
 */

import { ABSENT, natUid } from '../identity.ts'

/** 算词典身份要的全部东西。**全部来自文件头** */
export interface DictIdentityInput {
  /** `mdict` / `stardict` */
  format: string
  /** 头部里的引擎版本。`GeneratedByEngineVersion` / `.ifo` 的 `version` */
  formatVersion?: string | null
  /** 头部里的 `Encoding` */
  encoding?: string | null
  /** 头部里的 `Title` / `.ifo` 的 `bookname` */
  title?: string | null
  /** 头部声明的词条数（**不是**建出来的索引大小 —— 那个会因去重而变） */
  entryCount?: number | null
  /** 词块数 */
  blockCount?: number | null
  /** 词条索引段的字节数 */
  indexBytes?: number | null
}

/** 文本分量的归一：去首尾空白 + 内部连续空白折成一个空格 */
function normText(v: string | null | undefined): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim()
  return s === '' ? ABSENT : s
}

/**
 * 整数分量的归一。
 *
 * ★ 非整数、负数、`NaN`、`Infinity` 一律落成 `ABSENT`，**不许静默取整**。
 *   取整会让「读错了的头部」和「真的是这个数」产生同一个身份，
 *   而那正是最难查的一类：两台机器上同一个文件算出不同的 uid。
 */
function normInt(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return ABSENT
  return String(v)
}

/**
 * 身份分量。**按规格表的顺序**，顺序本身就是身份的一部分。
 * 单独导出是为了让测试和诊断能逐段比对（「是哪一段变了」）。
 */
export function dictIdentityParts(input: DictIdentityInput): string[] {
  return [
    normText(input.format).toLowerCase(),
    normText(input.formatVersion),
    normText(input.encoding).toUpperCase(),
    normText(input.title),
    normInt(input.entryCount),
    normInt(input.blockCount),
    normInt(input.indexBytes)
  ]
}

/**
 * 词典的跨设备身份。
 *
 * 同一本词典在任何机器、任何路径、任何文件名下，算出来的都是这一个字符串。
 */
export function dictUid(input: DictIdentityInput): string {
  return natUid('dictionaries', dictIdentityParts(input))
}

/**
 * 两个身份差在哪一段 —— 给诊断和排查用。
 * 返回规格表里的分量名，没有差异就是空数组。
 */
export const IDENTITY_PART_NAMES: readonly string[] = [
  'format', 'formatVersion', 'encoding', 'title', 'entryCount', 'blockCount', 'indexBytes'
]

export function identityDiff(a: DictIdentityInput, b: DictIdentityInput): string[] {
  const pa = dictIdentityParts(a)
  const pb = dictIdentityParts(b)
  const out: string[] = []
  for (let i = 0; i < IDENTITY_PART_NAMES.length; i++) {
    if (pa[i] !== pb[i]) out.push(IDENTITY_PART_NAMES[i]!)
  }
  return out
}

/**
 * ★★ Title 大部分时候是**没有信息的** —— 这是实测出来的，不是设计时想到的。
 *
 * 把使用者那 21 本可读词典的头部逐个 dump 出来之后：
 *
 *     5 本  Title = "Title (No HTML code allowed)"   ← MdxBuilder 的默认占位，做词典的人没填
 *     3 本  Title = 空
 *     13 本 有真名字
 *
 * 也就是说 **8/21 的 Title 对身份零贡献**，区分力全在那三个计数上
 *（实测：只用 format+版本+编码+Title 会撞出「4 本一组」和「3 本一组」两组；
 *  补上三个计数之后 21 本 → 21 个身份）。
 *
 * 这个函数把那件事说出来，让 registry 在 Title 没信息时**更谨慎**：
 * 认领旧行时要再比一次文件名，「uid 相同但文件明显不是同一个」要记一条诊断，
 * 而不是静悄悄合并掉他的排序和启用状态。
 */
const PLACEHOLDER_TITLE = /^(title\s*\(no html code allowed\)|untitled|无标题|dictionary)$/i

export function titleIsInformative(title: string | null | undefined): boolean {
  const t = normText(title)
  return t !== ABSENT && !PLACEHOLDER_TITLE.test(t)
}

/**
 * 身份有多强。
 *
 *   `strong` —— Title 有信息，且三个计数齐全
 *   `counts` —— Title 没信息，全靠计数撑着（**实测里 8/21 是这一档**）
 *   `weak`   —— 连计数都缺，只能靠格式与版本。registry 不该拿它自动认领任何东西
 */
export function identityStrength(input: DictIdentityInput): 'strong' | 'counts' | 'weak' {
  const counts = [input.entryCount, input.blockCount, input.indexBytes].map(normInt)
  const known = counts.filter((c) => c !== ABSENT).length
  if (known < 2) return 'weak'
  return titleIsInformative(input.title) ? 'strong' : 'counts'
}
