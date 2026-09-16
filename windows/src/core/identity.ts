/**
 * 跨设备身份的**唯一定义** · ★★ Step 2 / C-1 / D-280（2026-08-18）
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * 每张同步表的 uid 由触发器随机生成。可其中有七张表**还带着 uid 之外的唯一性**
 * （复合主键、唯一索引）。于是两台设备各自产生**同一件业务事实**时：
 *
 *     A：uid 随机甲 + (item 5, lecture 1)
 *     B：uid 随机乙 + (item 5, lecture 1)
 *     同步 → `on conflict(uid)` 不命中（uid 不同）→ 走 INSERT
 *          → UNIQUE constraint failed: item_lectures.item_id, item_lectures.lecture_id
 *          → 那一行永久失败，那一包永远不进 applied，**每次同步都重试**
 *
 * 五条轴在真 schema 的副本上逐条复现过（架构报告 §2.1），加上后来扫出来的
 * `term_ledger`，一共七张表。
 *
 * ── 药 ──────────────────────────────────────────────────────
 *
 * **身份由业务事实算出来，不再随机。** 同一件事实在两台上算出同一个 uid，
 * `on conflict(uid)` 正常接管，撞车这件事从根上不存在。
 *
 * 这不是新发明：`resolutions`（V25）已经这么做了，而它正是六张表里
 * **唯一一张从来不撞的**（对照实验做过）。这个文件把那条做法推广到其余六张。
 *
 * ── 为什么每种身份都要有自己的函数 ★ ────────────────────────
 *
 * 不写成 `deterministicUid(table, parts[])` 然后各处自己传字符串 ——
 * 那样**业务身份会消失在一个 `parts[]` 里**：调用点传错顺序、传漏一个、
 * 传了个本地 id 而不是 uid，全都编译得过、跑得通，错误只在两台设备
 * 真的撞上时才暴露，而那时候没人记得当初传的是什么。
 *
 * 所以每一种身份是一个**具名函数**，参数名就说明了它要什么。
 * 底层共用 `natUid()` 做编码，但入口是七个各自独立的门。
 *
 * ── 编码为什么不能用「拼接 + 分隔符」★★ ────────────────────
 *
 * `a + '-' + b` 是有歧义的：`["ab","c"]` 和 `["a","bc"]` 拼出来一样。
 * 而这里的 part 里**真的会有分隔符** —— `items-3f2a…` 自带 `-`，
 * `analysis_blocks.block` 和 `qtypes.key` 是他自己写的文本。
 *
 * 所以先转义再拼：
 *
 *     `\` → `\\`      （先转义转义符本身，顺序不能反）
 *     `|` → `\p`
 *     然后用 `|` 连起来
 *
 * 转义之后 part 里不可能再出现裸的 `|`，所以按裸 `|` 切回去必然还原原样 ——
 * **可证明无歧义**，而且解码规则简单到 SQL 里一行 `replace` 就能写出来
 * （长度前缀那种方案在 SQL 里要处理 UTF-8 字节数与 UTF-16 码元的差异，
 * 那是一个两端算不出同一个数的坑）。
 *
 * ── 大小写 · 空白 · Unicode · 数字 ──────────────────────────
 *
 * **一律原样，不做归一。** 理由：这些 part 要么是别的行的 uid（本身已经规范），
 * 要么是业务上就该区分的文本（`analysis_blocks.block` 是内部键名；
 * `qtypes.key` 是他自己起的名字，`造句` 和 `造句 ` 就是两个不同的名字）。
 * 唯一一处例外是 `term_ledger.norm`，它**在写进库之前**就已经被
 * `normTerm()` 归一过了（小写 + 折叠空白），这里拿到的就是归一后的值。
 *
 * 「不归一」是一个决定，不是省事：归一会把两个他眼里不同的东西合成一个，
 * 而合错了的表现是「我明明建了两个，只剩一个」——比撞车更难解释。
 */

/** 转义符与分隔符。改它们等于改身份算法，必须连 `SYNC_PROTOCOL_VERSION` 一起加一 */
const ESC = '\\'
const SEP = '|'

/**
 * uid 的第二段。选 `nat`（natural identity）的理由和 `MARK = 'builtin'` 一样：
 *
 *   · 触发器随机那一路是 `lower(hex(randomblob(8)))` —— 只有十六进制字符，
 *     而 `n` 和 `t` **不是十六进制字符**，所以那条路 structurally 生成不出 `nat`
 *   · V9 回填那一路是 `<表>-<base36 时间戳><随机>-<id>`，第二段以数字开头
 *   · 出厂那一路是 `<表>-builtin-…`
 *
 * 三条都不相交。`identity.test.ts` 里有一条拿十万个真随机 uid 逐个断言的用例守着。
 */
export const NAT = 'nat'

/** 「这一位没有值」的占位。uid 一律是 `<表名>-…`，不可能等于一个裸的 `-` */
export const ABSENT = '-'

/** 把一段值转义成可以安全拼接的形态。**先转义转义符，顺序反了就有歧义** */
export function escapePart(s: string): string {
  return s.split(ESC).join(ESC + ESC).split(SEP).join(ESC + 'p')
}

/** 反过来解一次 —— 只给测试用，用来证明编码真的无歧义 */
export function decodeParts(encoded: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < encoded.length; i++) {
    const c = encoded[i]!
    if (c === ESC) {
      const n = encoded[i + 1]
      if (n === ESC) cur += ESC
      else if (n === 'p') cur += SEP
      else cur += ESC + (n ?? '')
      i++
      continue
    }
    if (c === SEP) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}

/**
 * 底层：把一串 part 编成这张表的确定性 uid。
 *
 * **不要直接调它。**走下面那七个具名入口 —— 那是为了让业务身份
 * 在调用点上看得见（见文件头）。
 *
 * @throws 任何一段是空的都直接抛。空身份不是一个身份，
 *         悄悄生成一个「看起来像 uid 的东西」比当场炸严重得多。
 */
export function natUid(table: string, parts: readonly string[]): string {
  if (parts.length === 0) throw new Error(`身份不能是空的（${table}）`)
  const clean = parts.map((p, i) => {
    if (typeof p !== 'string' || p === '') {
      throw new Error(`${table} 的身份第 ${i + 1} 段是空的 —— 算不出跨设备身份`)
    }
    return escapePart(p)
  })
  return `${table}-${NAT}-${clean.join(SEP)}`
}

/** 这个 uid 是不是本文件这套规则算出来的 */
export function isNaturalUid(uid: string): boolean {
  const i = uid.indexOf(`-${NAT}-`)
  return i > 0 && uid.length > i + NAT.length + 2
}

// ══════════════════════════════════════════════════════════════
// 七个具名入口。每一个的参数名就是它的业务身份。
// ══════════════════════════════════════════════════════════════

/**
 * 一条知识点挂在一讲上 · `item_lectures`
 *
 * 它**没有独立身份 —— 它就是那一对**。所以两台各自把同一条挂进同一讲时，
 * 算出来必然是同一个 uid，upsert 正常接管。
 */
export const itemLectureUid = (itemUid: string, lectureUid: string): string =>
  natUid('item_lectures', [itemUid, lectureUid])

/**
 * 一条知识点的认读卡 · `reading_cards` · **D-296**
 *
 * 与知识点**一比一**，所以身份就是那条知识点本身 —— 一个参数。
 *
 * ★★ 为什么必须是确定性身份（这一条错了，第一次同步就炸）
 *
 * V34 那条迁移会在**每一台设备上各跑一次**。要是 uid 靠随机触发器生成，
 * 同一条知识点的卡在两台上会拿到**两个不同的 uid** → 同步过去变成两行 →
 * 撞 `unique(item_id)` → 那一行永远写不进去、那一包永远不进 `applied`、
 * 两台永不收敛。和 `item_lectures` 是同一个道理，也是同一套解法。
 */
export const readingCardUid = (itemUid: string): string => natUid('reading_cards', [itemUid])

/**
 * 一条知识点的某一块解析 · `analysis_blocks`
 *
 * `block` 是内部键名（`summary` / `diagnosis` / `suspect` / `drill` …），
 * 不是他写的文本，所以原样进身份。
 */
export const analysisBlockUid = (itemUid: string, block: string): string =>
  natUid('analysis_blocks', [itemUid, block])

/** 一场练习里某一道题的草稿 · `drafts` */
export const draftUid = (sessionUid: string, questionUid: string): string =>
  natUid('drafts', [sessionUid, questionUid])

/**
 * 一块墓碑 · `tombstones`
 *
 * ★ 这一条是本轮最要紧的：**两台都删掉同一个东西**是双设备日常，
 * 而撞车坏掉的正是「删除会传播」这件事本身。
 * `kind` 在前 —— 和 `tombKey()` 的顺序一致，读日志时对得上。
 */
export const tombstoneUid = (kind: string, targetUid: string): string =>
  natUid('tombstones', [kind, targetUid])

/**
 * 一个题型 · `qtypes`
 *
 * 身份是 `key`：它本来就有唯一索引，`restoreBuiltin()` 早就在拿它判「同一条」。
 * 出厂题型与他自己建的**走同一条规则** —— 一张表一个身份定义，不许分叉。
 */
export const qtypeUid = (key: string): string => natUid('qtypes', [key])

/**
 * 一条原文出处 · `occurrences` · 两个分支
 *
 * 业务身份（使用者 2026-08-18 裁决）：
 *   · `material_id` 非空 → `(item, material)`
 *   · `material_id` 为空 → `(item, lecture)`   ← 「我的收集」那条路不带 material
 *
 * D-152 / M-013 说的是「一个表达在**多篇材料**中出现时全部摘句保存」——
 * 多篇材料仍然是多条 occurrence（material 不同 → 身份不同 → 两行都在）。
 * 变的只是「同一篇材料重新分析一次」不再长出第二条。
 */
export const occurrenceMaterialUid = (itemUid: string, materialUid: string): string =>
  natUid('occurrences', ['m', itemUid, materialUid])

export const occurrenceLectureUid = (itemUid: string, lectureUid: string): string =>
  natUid('occurrences', ['l', itemUid, lectureUid])

/**
 * 一条行为账 · `term_ledger`
 *
 * ★ 这张表是本轮**重新全扫 schema 时才找出来的第七条轴**，不在原名单里。
 * 它的唯一索引是 `(norm, verdict, coalesce(lecture_id, 0))` ——
 * 两台各自删掉同一个表达，就各写一行同 `(norm, verdict)` 的账，撞。
 *
 * `lectureUid` 为空表示全局作用域，用 `ABSENT` 占位 ——
 * 和索引里那个 `coalesce(lecture_id, 0)` 是同一个意思。
 *
 * `norm` 进来之前已经被 `normTerm()` 归一过（小写 + 折叠空白），这里不再动它。
 */
export const termLedgerUid = (norm: string, verdict: string, lectureUid: string | null): string =>
  natUid('term_ledger', [norm, verdict, lectureUid && lectureUid !== '' ? lectureUid : ABSENT])

// ══════════════════════════════════════════════════════════════
// SQL 侧：**由上面那份规则生成**，不是另写一份
// ══════════════════════════════════════════════════════════════

/**
 * 生成「把一个 SQL 表达式转义成 part」的 SQL。
 *
 * 和 `escapePart` 逐字对应，顺序一样（先转义转义符）。
 * SQLite 的字符串字面量里反斜杠**没有特殊含义**，所以 `'\'` 就是一个反斜杠 ——
 * 这也是选 `\` 当转义符的原因之一：两端写法一样，不用互相翻译。
 */
export function sqlEscapePart(expr: string): string {
  return `replace(replace(${expr}, '${ESC}', '${ESC}${ESC}'), '${SEP}', '${ESC}p')`
}

/**
 * 生成「算出这张表的确定性 uid」的 SQL 表达式。
 *
 * @param table 表名（进 uid 的第一段）
 * @param exprs 每一段身份对应的 SQL 表达式（调用方保证顺序与 TS 那一侧一致）
 *
 * ★ 任何一段是 NULL，整个表达式就是 NULL —— **这是有意的**：
 *   身份算不出来时宁可留一个空 uid 让自检当场红，也不要编一个出来。
 *   V28 的回填自检查的就是「uid 个数 == 行数」。
 */
export function sqlNatUid(table: string, exprs: readonly string[]): string {
  const parts = exprs.map(sqlEscapePart).join(` || '${SEP}' || `)
  return `('${table}-${NAT}-' || ${parts})`
}

/**
 * 七张表各自的身份规格 —— **迁移、触发器、对拍测试都从这里取**。
 *
 * `parts` 里写的是 SQL 表达式，`new.` 前缀由调用方按场景替换：
 * 触发器里是 `new.item_id`，回填时是 `o.item_id`。所以这里用 `{alias}` 占位。
 */
export interface IdentitySpec {
  table: string
  /** 一句话说清它的业务身份，报错和文档都用它 */
  says: string
  /** 生成 uid 的 SQL 表达式。`{a}` 会被替换成行别名（触发器里是 `new`） */
  sql: (a: string) => string
  /** 「同一身份有几行」的分组表达式，迁移前的重复体检用它 */
  groupBy: (a: string) => string
}

/** 一行的某个外键指向的那张表的 uid —— 子查询形态 */
const parentUid = (parentTable: string, fkExpr: string): string =>
  `(select p.uid from ${parentTable} p where p.id = ${fkExpr})`

export const IDENTITY_SPECS: readonly IdentitySpec[] = [
  {
    table: 'item_lectures',
    says: '(知识点, 讲)',
    sql: (a) =>
      sqlNatUid('item_lectures', [parentUid('items', `${a}.item_id`), parentUid('lectures', `${a}.lecture_id`)]),
    groupBy: (a) => `${a}.item_id, ${a}.lecture_id`
  },
  /**
   * ★★ D-296 · 认读卡与知识点一比一，身份就是那条知识点。
   *   两台各自迁移出来的同一张卡必然同 uid —— 这是拆表能安全落地的前提。
   */
  {
    table: 'reading_cards',
    says: '(知识点)',
    sql: (a) => sqlNatUid('reading_cards', [parentUid('items', `${a}.item_id`)]),
    groupBy: (a) => `${a}.item_id`
  },
  {
    table: 'analysis_blocks',
    says: '(知识点, 区块名)',
    sql: (a) => sqlNatUid('analysis_blocks', [parentUid('items', `${a}.item_id`), `${a}.block`]),
    groupBy: (a) => `${a}.item_id, ${a}.block`
  },
  {
    table: 'drafts',
    says: '(练习场次, 题目)',
    sql: (a) =>
      sqlNatUid('drafts', [parentUid('sessions', `${a}.session_id`), parentUid('questions', `${a}.question_id`)]),
    groupBy: (a) => `${a}.session_id, ${a}.question_id`
  },
  {
    table: 'tombstones',
    says: '(实体种类, 被终结那一行的 uid)',
    sql: (a) => sqlNatUid('tombstones', [`${a}.kind`, `${a}.target_uid`]),
    groupBy: (a) => `${a}.kind, ${a}.target_uid`
  },
  {
    table: 'qtypes',
    says: '题型的 key',
    sql: (a) => sqlNatUid('qtypes', [`${a}.key`]),
    groupBy: (a) => `${a}.key`
  },
  {
    table: 'occurrences',
    says: 'material 非空时 (知识点, 材料)，否则 (知识点, 讲)',
    sql: (a) =>
      `(case when ${a}.material_id is not null then ` +
      sqlNatUid('occurrences', [`'m'`, parentUid('items', `${a}.item_id`), parentUid('materials', `${a}.material_id`)]) +
      ` else ` +
      sqlNatUid('occurrences', [`'l'`, parentUid('items', `${a}.item_id`), parentUid('lectures', `${a}.lecture_id`)]) +
      ` end)`,
    groupBy: (a) => `${a}.item_id, coalesce(${a}.material_id, 0), case when ${a}.material_id is null then ${a}.lecture_id else null end`
  },
  {
    table: 'user_preferences',
    says: '偏好的键名',
    sql: (a) => sqlNatUid('user_preferences', [`${a}.key`]),
    groupBy: (a) => `${a}.key`
  },
  {
    table: 'term_ledger',
    says: '(归一后的字面, 判定, 作用域那一讲)',
    sql: (a) =>
      sqlNatUid('term_ledger', [
        `${a}.norm`,
        `${a}.verdict`,
        `coalesce(${parentUid('lectures', `${a}.lecture_id`)}, '${ABSENT}')`
      ]),
    groupBy: (a) => `${a}.norm, ${a}.verdict, coalesce(${a}.lecture_id, 0)`
  }
]

/** 有确定性身份的那几张表 —— 迁移、触发器、体检都问它 */
export const IDENTITY_TABLES: readonly string[] = IDENTITY_SPECS.map((s) => s.table)

export const identitySpecOf = (table: string): IdentitySpec | undefined =>
  IDENTITY_SPECS.find((s) => s.table === table)

/**
 * 生成这张表的 uid 触发器。
 *
 * ── 为什么是 `after insert` + `when new.uid is null` ────────
 *
 * 和 V9 那批触发器同一个形状，两条理由没变：
 *   · 管住**所有**插入路径，包括以后新写的代码（漏一处的后果是
 *     「那张表的那些行永远同步不出去」，而且不报错）
 *   · `new.uid` 有值时不动 —— 同步收下来的行自带 uid，不许被本机重算覆盖
 *
 * ── 为什么**没有** update 触发器 ★ ──────────────────────────
 *
 * uid 是**身份**，不是派生字段。业务字段改了不该换身份，
 * 而身份字段（`item_id` / `block` / `key` …）在生产代码里从来不被 UPDATE
 * （`identity.test.ts` 里有一条扫源码的用例守着这一点）。
 * 加一条 update 触发器去「重算」反而会把同步收下来的 uid 改掉 ——
 * 那正是 D-281 说的「一次修复之后又被改回去」。
 */
export function uidTriggerSql(table: string): string {
  const spec = identitySpecOf(table)
  const value = spec ? spec.sql('new') : `('${table}-' || lower(hex(randomblob(8))))`
  return `create trigger if not exists trg_${table}_uid after insert on "${table}"
            when new.uid is null
          begin
            update "${table}" set uid = ${value} where rowid = new.rowid;
          end`
}
