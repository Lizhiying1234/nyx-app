/**
 * 出厂内容的跨设备身份 · ★★ R-4-G
 *
 * ── 病根 ────────────────────────────────────────────────────
 *
 * 出厂的导师 / 体裁 / 题型 / 分析预设是**每台设备各自播种**的：
 * 同样三个导师、同样的顺序、同样的内容。可它们的 `uid`
 * （跨设备行身份）却是**每台设备各自随机**生成的。
 *
 * 于是「A 上的严谨学术型」和「B 上的严谨学术型」在系统里是两个东西，
 * 而它们的 `id` 都是 1 —— A 推给 B 时 `on conflict(uid)` 不命中，
 * 走 INSERT，当场 `UNIQUE constraint failed: tutors.id`。
 * 实测：两台全新机器第一次同步，27 行里 22 行是这么失败的。
 *
 * **凡是确定性生成的东西，身份就必须同样由内容确定地推导出来。**
 * 这个文件就是那条推导，而且**全项目只有这一份**：
 * V20 迁移、`ensureBuiltins` 播种、`writeRows` 收远端行，三处共用它。
 * 各写一份的后果是三处慢慢漂开，而漂开的表现是「同步偶尔失败」——
 * 这个项目已经为「判据有两份」付过好几次学费了。
 *
 * ── 身份取什么 ──────────────────────────────────────────────
 *
 * 不能取 `name`：他改得动（他真实库里那个导师已经叫 Lumen 了）。
 * 不能取 `id`：自增的，两台机器各排各的。
 * 不能取时间、不能取设备。剩下的只有两种：
 *
 *   · `qtypes` —— **`key`**。它本来就有唯一索引，
 *     `QTypes.restoreBuiltin()` 早就在用 `where key = ?` 判「同一条」，
 *     也就是说项目里早把 key 当身份用了，只有同步那一层没跟上。
 *   · 其余三张 —— **出厂序位**（第 1、2、3 个）。播种顺序是写死的，
 *     而这三张表没有任何重排入口（已逐处核对），所以序位是稳的。
 */

import { isNaturalUid, qtypeUid } from './identity.ts'

/** 会被自动播种的四张表 —— 除了它们，没有第五处出厂内容 */
export const BUILTIN_TABLES = ['tutors', 'genres', 'qtypes', 'prompt_presets'] as const
export type BuiltinTable = (typeof BUILTIN_TABLES)[number]

export function isBuiltinTable(t: string): t is BuiltinTable {
  return (BUILTIN_TABLES as readonly string[]).includes(t)
}

export interface BuiltinIdent {
  /** 库里那一列。**只有 1 才算出厂内容** —— 他自己建的一律不碰 */
  builtin?: number | string | null
  /** `qtypes` 用它 */
  key?: string | null
  /**
   * 其余三张用它：**出厂序位，从 1 开始**。
   *
   * 由调用方按 `sort, id` 排出来 —— 纯函数不该去查库。
   * 软删过的行**也要算进序位**：它还是那一行，只是被删了；
   * 另一台设备上同一行可能没删，序位必须两边一致才对得上。
   */
  ordinal?: number | null
}

/**
 * canonical uid 的中间那一段。
 *
 * 选它的**唯一理由**：`u` `i` `l` `t` `n` 都不是十六进制字符，
 * 所以 `lower(hex(randomblob(8)))` 这条路**永远生成不出**这一段。
 * 这不是「概率很低」，是**structurally impossible**。
 * `builtin-identity.test.ts` 里有一条直接验这个性质的用例 ——
 * 抽样验不出来（换成 `beef` 一样抽不中），只有验结构才验得到。
 */
export const MARK = 'builtin'

/** 十六进制字符集 —— 触发器那条路只能生成这些 */
export const HEX = '0123456789abcdef' 

/**
 * 这一行的跨设备身份。**不是出厂内容就返回 `null`**（调用方据此一个字都不动）。
 *
 * ── 为什么它绝不会撞上用户自己的 uid ────────────────────────
 *
 * 库里的 uid 一共只有三种来源：
 *
 *   1. 触发器新建的     `<表名>-` + `lower(hex(randomblob(8)))`  → 16 个**十六进制**字符
 *   2. V9 回填的老行     `<表名>-<设备种子>-<id>`，种子 = base36 时间戳(8~9 位) + 6 位随机
 *   3. 这里生成的        `<表名>-builtin-<key 或序位>`
 *
 * 和 ① 不相交：`builtin` 里的 `u` `i` `l` `t` `n` **都不是十六进制字符**，
 * `hex()` 生成不出来。
 * 和 ② 不相交：② 的第二段固定 14~15 位且以数字开头（时间戳的 base36），
 * 而这里的第二段是 7 个字母。
 *
 * 这段推理不是留在注释里就算数的 —— `builtin-identity.test.ts` 里有一条
 * 拿十万个真随机 uid 逐个断言的用例守着它。
 */
export function canonicalUid(table: string, r: BuiltinIdent): string | null {
  if (!isBuiltinTable(table)) return null
  if (Number(r.builtin ?? 0) !== 1) return null

  if (table === 'qtypes') {
    /**
     * ★★ Step 2 · C-1 · 题型的身份**改由 `core/identity.ts` 说了算**（D-280）。
     *
     * 以前这里自己拼 `qtypes-builtin-<key>`，而他自己建的题型是随机 uid ——
     * **同一张表两套身份规则**。于是两台各建一个同名题型时，
     * uid 不同、`key` 撞唯一索引，永久失败（架构报告 §2.1 轴 ⑤）。
     *
     * 现在出厂的和他自己建的走同一条规则：身份就是 `key`。
     * 这里不再自己算，改成转调 —— 一张表一个定义，不许分叉。
     */
    const key = (r.key ?? '').trim()
    return key ? qtypeUid(key) : null
  }

  const n = Number(r.ordinal ?? 0)
  if (!Number.isInteger(n) || n < 1) return null
  return `${table}-${MARK}-${n}`
}

/** 这个 uid 是不是这套规则生成的 —— 迁移和测试都要问 */
export function isCanonicalUid(uid: string): boolean {
  // ★ Step 2 · 题型改走确定性身份之后，它也算「认得出的身份」
  if (isNaturalUid(uid)) return true
  for (const t of BUILTIN_TABLES) {
    if (uid.startsWith(`${t}-${MARK}-`) && uid.length > `${t}-${MARK}-`.length) return true
  }
  return false
}
