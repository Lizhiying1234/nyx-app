/**
 * 同步包的包头与收包判据 · ★★ Step 1A / D-268 / D-269（2026-08-17）
 *
 * ── 三个版本号各管什么，不许混 ──────────────────────────────
 *
 * | 字段 | 回答的问题 | 什么时候变 |
 * |---|---|---|
 * | `schemaVersion`      | 我的库跑到第几条 migration 了 | 每加一条 migration |
 * | `schemaFingerprint`  | 我的同步表**长什么样**        | 结构真的变了（加列、改约束、加索引…） |
 *
 * ★ 屏上怎么称呼这两样（2026-09-15，使用者点头）：
 *   · `schemaVersion`（v38 那种）→ **结构版本**
 *   · `schemaFingerprint`（八位十六进制）→ **结构编号**
 *   原来两样都写成「版本」，而结构不一致那句报错恰恰是「**版本号一样、结构却不一样**」——
 *   一句话里出现两个「版本」，第一次看到的人读不通。「指纹」也不行：那是内部说法。
 * | `protocolVersion`    | 我按哪一版**语义**在收发      | 语义变了（uid 怎么算、包里带不带 id…） |
 *
 * 三者缺一不可，实测过：
 *   · 只有 `schemaVersion` 不够 —— 删掉一列之后它仍然是 27（架构报告 §3 实测 ⑤）
 *   · 只有指纹不够 —— **Step 2 换 uid 生成规则时，列、索引、触发器名字一个都不变**，
 *     指纹纹丝不动，而两端的语义已经不一样了。那正是 `protocolVersion` 存在的理由。
 *
 * ── 为什么判据写在 core ────────────────────────────────────
 *
 * 「这一包收不收」是**判断**，不是编排。和 `sync-merge.ts` / `tombstone.ts`
 * 同一个性质：两端必须给出同一个答案，否则一端收一端不收，数据永久分叉。
 * 编排（分几批、谁先谁后、事务边界）仍然留在平台层，这一轮不动它。
 */

/**
 * 同步语义的版本号 · ★ **全项目唯一一处**。
 *
 * 改这个数的时机：包的**含义**变了，而不是内容变了。
 *
 * 升级它等于宣布：**版本不同的两台设备互相不收包**。这是有意的 ——
 * 宁可停下来说一句「另一台要先升级」，也不要让半新半旧的两台悄悄写坏对方。
 *
 * ── 历次 ────────────────────────────────────────────────────
 *
 * | 版本 | 什么时候 | 语义变了什么 |
 * |---|---|---|
 * | 1 | Step 1 | 包头开始带 schemaVersion / schemaFingerprint / protocolVersion |
 * | 2 | Step 2 · C-1 | **七张表的跨设备身份由随机改成算出来的**（`core/identity.ts`） |
 * | 3 | Step 3 · C-2 | **包里不再有本地 id 与数字外键**，关系全用 uid（`core/fk-map.ts`） |
 *
 * ★ 第 2、3 版这两次，**结构指纹都一个字没变** —— 本地库长什么样根本没动，
 *   变的是「包里装什么」。这正是「指纹只表达结构、语义由 protocolVersion
 *   表达」（D-269）那条裁决存在的理由。少了它，一台翻译、一台不翻译的
 *   两台设备会互相写坏，而握手一声不吭。
 *
 * 这条依赖不靠记性：`identity.test.ts` 里有一张
 * 「身份算法指纹 → protocolVersion」的历史表，算法改了而版本没加，当场红。
 */
export const SYNC_PROTOCOL_VERSION = 3

/**
 * 「没有版本头的老包」最后能被收下的那一版。
 *
 * 第 1 版还收（那时身份算法没变，只是包头多了三个字段）；
 * 第 2 版起不收（C-1 换了身份算法，老包翻译不过来）。
 * 单独写成常量是为了让「为什么从某一版起不收了」有一个能指的地方。
 */
export const LAST_PROTOCOL_ACCEPTING_LEGACY = 1

/** 一个变更包的包头。老版本推的包没有后三个字段 —— 那就是 legacy */
export interface ChunkHeader {
  device?: unknown
  at?: unknown
  schemaVersion?: unknown
  schemaFingerprint?: unknown
  protocolVersion?: unknown
}

/** 本机的身份，用来和包头比 */
export interface LocalIdentity {
  schemaVersion: number
  schemaFingerprint: string
  protocolVersion: number
}

export type ChunkVerdict =
  /** 新包，三样都对得上 —— 严格模式收，本机没有的列一律算错，不许丢 */
  | { kind: 'accept' }
  /**
   * 老包（没有版本头）。**允许收，但走单独一条明确标着 legacy 的路**（D-268）。
   * 判据在这里，处理方式由平台层决定，但它不许假装自己是新包。
   */
  | { kind: 'legacy' }
  /** 不收。`reason` 是给他看的人话，`code` 是给日志和测试用的 */
  | { kind: 'reject'; code: RejectCode; reason: string }

export type RejectCode =
  | 'legacy-unsupported'
  | 'malformed'
  | 'protocol-mismatch'
  | 'schema-mismatch'
  | 'partial-header'
  | 'bad-rows'

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * 这一包收不收。
 *
 * 顺序是刻意的：**先判协议，再判结构**。
 * 协议不兼容时结构多半也对不上，但对他有用的那句话是「另一台要先升级」——
 * 报「结构不一致」会把他往改数据库的方向指，那是错的方向。
 */
export function classifyChunk(header: ChunkHeader | null | undefined, local: LocalIdentity): ChunkVerdict {
  if (!header || typeof header !== 'object') {
    return { kind: 'reject', code: 'malformed', reason: '这个变更包读不出包头 —— 多半不是本软件写的，没有收。' }
  }

  const hasProto = header.protocolVersion !== undefined && header.protocolVersion !== null
  const hasPrint = header.schemaFingerprint !== undefined && header.schemaFingerprint !== null

  // ── 老包：三样都没有 ────────────────────────────────────
  if (!hasProto && !hasPrint) {
    /**
     * ★★ Step 2 · C-1 之后，没有版本头的老包**不能再收了**。
     *
     * 老包里那些行的 uid 是**升级前随机生成**的。收进来会发生什么：
     * 一条 `item_lectures` 的 (item, lecture) 本机已经有了、uid 却不一样
     * → `on conflict(uid)` 不命中 → INSERT → 撞复合主键 → 永久失败。
     * **那正是 C-1 要根除的那个病**，从兼容这道门原样放回来。
     *
     * 所以判据是：能不能安全翻译。翻译不了就明确拒绝、说清楚原因、
     * 不进 applied（D-268 定的那三条）。
     *
     * 不会因此丢数据：另一台升级之后，V28 会把它那边的身份也算成同一个值，
     * 重推一次两边就收敛了。
     */
    if (local.protocolVersion > LAST_PROTOCOL_ACCEPTING_LEGACY) {
      return {
        kind: 'reject',
        code: 'legacy-unsupported',
        reason:
          `这是另一台设备在升级「之前」推上去的变更包（没有版本信息）。\n` +
          `第 ${local.protocolVersion} 版改了跨设备身份的算法，老包里的身份翻译不过来 —— ` +
          `硬收会和本机已有的数据撞车。\n` +
          `把另一台设备也升级到同一个版本，它会自动重推一次，两边就对上了。\n` +
          `（这一包没有收，也没有标成已处理。）`
      }
    }
    return { kind: 'legacy' }
  }

  /**
   * ★ 半个包头比没有包头更危险：它说明写包的那一版**知道**要带版本，
   * 却只带了一半 —— 要么写坏了，要么被人改过。不猜，直接拒。
   */
  if (!hasProto || !hasPrint) {
    return {
      kind: 'reject',
      code: 'partial-header',
      reason: '这个变更包的版本信息不完整（只有一半），没有收 —— 它可能在传输中损坏了。'
    }
  }

  if (!isFiniteNum(header.protocolVersion)) {
    return { kind: 'reject', code: 'malformed', reason: '这个变更包的协议版本号不是一个数，没有收。' }
  }
  if (header.protocolVersion !== local.protocolVersion) {
    const theirs = header.protocolVersion
    return {
      kind: 'reject',
      code: 'protocol-mismatch',
      reason:
        `同步协议版本不兼容 —— 另一台设备用的是第 ${theirs} 版，这台是第 ${local.protocolVersion} 版。` +
        `\n请先把${theirs > local.protocolVersion ? '这台' : '另一台'}设备升级到同一个版本，再同步。` +
        `\n（这一包没有收，也没有标成已处理，升级之后会自动重来。）`
    }
  }

  if (!isNonEmptyStr(header.schemaFingerprint)) {
    return { kind: 'reject', code: 'malformed', reason: '这个变更包没写数据库结构编号，没有收。' }
  }
  if (header.schemaFingerprint !== local.schemaFingerprint) {
    const sv = isFiniteNum(header.schemaVersion) ? `v${header.schemaVersion}` : '未知版本'
    return {
      kind: 'reject',
      code: 'schema-mismatch',
      reason:
        `两台设备的数据库结构不一样 —— 另一台是 ${sv}（结构编号 ${String(header.schemaFingerprint).slice(0, 8)}），` +
        `这台是 v${local.schemaVersion}（结构编号 ${local.schemaFingerprint.slice(0, 8)}）。` +
        `\n整包没有收 —— 结构对不上时逐行去收会悄悄丢字段。` +
        `\n把两台都升级到同一个版本，再同步。`
    }
  }

  return { kind: 'accept' }
}

/** 包里的一行，验过之后的样子 */
export interface CheckedRow {
  uid: string
  table: string
  updatedAt: number
  data: Record<string, unknown> | null
}

export type RowsCheck =
  | { ok: true; rows: CheckedRow[] }
  | { ok: false; code: RejectCode; reason: string }

/**
 * 包里的行本身合不合法。
 *
 * ★ **新包老包同一份判据。**D-268 说 legacy 不许「继续无条件走列过滤」——
 * 那说的是「本机没有的列怎么办」（那一条由 `strict` / `legacy` 两种写入模式区分），
 * **不是**说老包可以少几个必要字段。行长得不对就是不对，两边一样严。
 *
 * 判据故意只查「没有它就没法安全处理」的那几样：
 *   · `rows` 得是个数组
 *   · 每行得有非空 `uid`（跨设备身份，没有它这一行谁都认不出）
 *   · `table` 得是本机认得的同步表（不认得就没法安全落库）
 *   · `updatedAt` 得是个数（合并全靠它）
 *   · `data` 要么是对象、要么是 null（null = 这一行被删了）
 *
 * 任何一行不合格 → **整包拒绝**。不做「跳过这一行、其余照收」——
 * 那正是「静默丢东西」的另一种写法。
 */
export function checkRows(raw: unknown, knownTables: readonly string[]): RowsCheck {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'bad-rows', reason: '这个变更包里没有 rows 数组 —— 不是本软件写的包，没有收。' }
  }
  const known = new Set(knownTables)
  const out: CheckedRow[] = []
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null | undefined
    const where = `第 ${i + 1} 行`
    if (!r || typeof r !== 'object') {
      return { ok: false, code: 'bad-rows', reason: `这个变更包的${where}不是一条记录，整包没有收。` }
    }
    if (!isNonEmptyStr(r['uid'])) {
      return { ok: false, code: 'bad-rows', reason: `这个变更包的${where}没有跨设备身份（uid），整包没有收。` }
    }
    if (!isNonEmptyStr(r['table'])) {
      return { ok: false, code: 'bad-rows', reason: `这个变更包的${where}没有说自己属于哪张表，整包没有收。` }
    }
    if (!known.has(r['table'])) {
      return {
        ok: false,
        code: 'bad-rows',
        reason: `这个变更包的${where}指向一张本机不认识的表「${r['table']}」，整包没有收。`
      }
    }
    if (!isFiniteNum(r['updatedAt'])) {
      return { ok: false, code: 'bad-rows', reason: `这个变更包的${where}没有可用的时间戳，整包没有收 —— 合并要靠它。` }
    }
    const data = r['data']
    if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
      return { ok: false, code: 'bad-rows', reason: `这个变更包的${where}的内容不是一条记录，整包没有收。` }
    }
    out.push({
      uid: r['uid'],
      table: r['table'],
      updatedAt: r['updatedAt'],
      data: (data as Record<string, unknown> | null) ?? null
    })
  }
  return { ok: true, rows: out }
}
