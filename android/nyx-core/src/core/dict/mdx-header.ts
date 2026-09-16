import { pickMdictEncoding, type MdictEncoding } from './encoding.ts'
import type { DictIdentityInput } from './identity.ts'

/**
 * MDict 头部字段的取法 —— **两条路共用的唯一一份** · T-4.15 第一段（2026-09-07）
 *
 * ══ 它挡的是哪一种事故 ★★★ ══════════════════════════════════
 *
 * 同一段头有两条路要读：
 *
 *   廉价 probe（`main/dict/mdict-header.ts::probeMdict`）  只读头与词表段，不建索引
 *   真正装载（`core/dict/mdx.ts::Mdx`）                     建索引、取正文
 *
 * 分工是**有意的**（`contract.ts` 要求 probe 便宜，否则 D5 的惰性装载没法做：
 * 全量装载 18 本 7.3 秒、常驻 990 MB，还发生在建窗口之前）。
 * 可是「头里哪几个字节是什么」原来在两处**各写一遍**，同源只写在注释里
 * （`mdx.ts` 里那句「与 mdict-header.ts / adapters/mdict.ts 的取法逐项同源」）。
 *
 * ★★ 那不是假想的风险，是**已经发生过一次**的事：
 *   GBK 补上之前，体检那条路认得出 GBK、读词那条路认不出，
 *   于是设置页说「这本是 GBK」而正文按 UTF-8 解 ——
 *   **两句话都是软件自己说的，互相打架，谁都不报错**（D5.1b 两处各修了一次）。
 *   编码判断那一半当时收进了 `encoding.ts`；**剩下这一半到今天才收**。
 *
 * ══ 收的是哪几样 ═══════════════════════════════════════════
 *
 *   · 头长 / 属性串怎么解（UTF-16LE）
 *   · `Encrypted` 两位怎么读（1 = 授权锁 · 2 = 格式自带的固定混淆）
 *   · v1.2 / v2.0 的位宽与词表段五个字段的偏移
 *   · ★ **身份原料**：`formatVersion` 取 `GeneratedByEngineVersion` **原字符串**、
 *     `indexBytes` 取 `keyBlocksLen`（**词条块段**，不是 keyInfo 的长度）
 *     —— 使用者 2026-08-19 裁：这两条永久固定。取错了照样跑得通、照样算出
 *     21 个不重复的 uid，**只是和另一台机器上算的没有一个对得上，而且什么都不报**。
 *
 * ══ 不收的 ═════════════════════════════════════════════════
 *
 * 词表块与正文段的解法（`readKeys` / `readRecordIndex` / `Mdx` 建索引那一段）
 * 仍各在各处：那两条路要的东西**真的不一样**（一个只数词、一个要建全量索引）。
 * 这里只收「读到词表段起点为止」那一段 —— 身份原料全部在这一段里。
 *
 * ══ 纯的 ═══════════════════════════════════════════════════
 *
 * 字节从注入的 `read` 来（Windows 注 node:fs 的 readSync，Android 注 SAF 随机读，
 * 测试注 Buffer）—— 本文件一行 I/O 都没有（D-238）。
 */

/** 取字节：`at` 起、`len` 长。越界由调用方的 io 负责（两侧都已经先查过文件大小） */
export type ByteReader = (at: number, len: number) => Uint8Array

export interface MdxHeaderOk {
  ok: true
  /** 头部属性串的字节数（不含开头那 4 字节长度本身） */
  headerLen: number
  attrs: Record<string, string>
  /** `GeneratedByEngineVersion` 原字符串 —— **身份用它** */
  versionRaw: string
  /** 数值版本，只用来判 v1/v2 的位宽，**不进身份** */
  version: number
  v2: boolean
  numSize: number
  /** 词表键的编码（判断在 `encoding.ts`，这里只是转述） */
  encoding: MdictEncoding
  /** 头部声明的 `Encoding` 原文（空串 = 没声明）—— **身份用它** */
  declaredEncoding: string
  encFlags: number
  numKeyBlocks: number
  /** 头部声明的词条数（不是去重后的索引大小）—— **身份用它** */
  numEntries: number
  keyIndexDecompLen: number | null
  keyIndexCompLen: number
  /** 词条块段的字节数 —— **身份的 indexBytes 用它** */
  keyBlocksLen: number
  /** 词表索引段从哪个字节开始 */
  keySectionAt: number
  title: string
  format: string
  registerBy: string
}

export interface MdxHeaderFail {
  ok: false
  why: 'header-len' | 'no-attrs' | 'key-index'
  detail: string
  attrs?: Record<string, string>
}

export type MdxHeader = MdxHeaderOk | MdxHeaderFail

const utf16le = new TextDecoder('utf-16le')
const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)

/** 头部那串 XML 属性 —— `key="value"` 一路扫出来 */
export function headerAttrs(xml: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of xml.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!
  return out
}

/**
 * MDict 的「加密」两位，性质完全不同：
 *   1 = 要使用者的注册码（付费词典的授权）—— 不碰
 *   2 = 索引段用写死的公开算法混淆 —— 那是格式的一部分，见 `ripemd128.ts`
 */
export function encryptedFlags(attrs: Record<string, string>): number {
  const raw = attrs['Encrypted'] ?? '0'
  if (raw === 'No') return 0
  if (raw === 'Yes') return 1
  return Number(raw) || 0
}

/**
 * ★★★ 身份原料的**唯一取法**（规格见 `identity.ts` 第二节之二）。
 *
 * 三处曾经各拼一遍：`adapters/mdict.ts` 喂 `dictUid()`、`Mdx` 的 `identity`、
 * 取证脚本。字段名一样、语义靠注释保证 —— 而「靠注释保证」在这个项目里
 * 已经赔过一次（GBK 那次）。现在只有这一份。
 *
 * ★ 空串与 `null` 在 `dictIdentityParts` 里归一到同一个值（`normText`），
 *   所以这里给 `|| null` 或原样给空串**算出来的 uid 相同** ——
 *   写成 `|| null` 是为了让「没有这一项」在类型上看得见，不是行为差别。
 */
export function identityOf(h: MdxHeaderOk): DictIdentityInput {
  return {
    format: 'mdict',
    formatVersion: h.versionRaw || null,
    encoding: h.declaredEncoding || null,
    title: h.title || null,
    entryCount: h.numEntries,
    blockCount: h.numKeyBlocks,
    indexBytes: h.keyBlocksLen
  }
}

/**
 * 读到词表索引段起点为止。**不解词块、不碰正文。**
 *
 * @param read 取字节
 * @param size 文件总字节数（越界判断要它 —— 报「越过文件尾」比报一句 RangeError 有用）
 * @param opts `mdd` = 这是资源包（它的头里没有 `Encoding`，键固定 UTF-16LE）
 */
export function readMdxHeader(
  read: ByteReader,
  size: number,
  opts: { mdd?: boolean } = {}
): MdxHeader {
  const mdd = opts.mdd ?? false

  const headerLen = view(read(0, 4)).getUint32(0)
  if (headerLen <= 0 || headerLen + 8 > size) {
    return {
      ok: false,
      why: 'header-len',
      detail: `头部声明 ${headerLen} 字节，文件共 ${size} 字节`
    }
  }

  const attrs = headerAttrs(utf16le.decode(read(4, headerLen)))
  if (Object.keys(attrs).length === 0) {
    return { ok: false, why: 'no-attrs', detail: '头部里没有任何 MDict 属性' }
  }

  const versionRaw = (attrs['GeneratedByEngineVersion'] ?? '2.0').trim()
  const version = parseFloat(versionRaw) || 2.0
  /**
   * ★ .mdd 的词表键编码**不看头部** —— 资源包的头部里根本没有 `Encoding`。
   *   1.2 和 2.0 都是 UTF-16LE；两版的差别在有没有结尾 NUL，不在编码。
   */
  const encoding = pickMdictEncoding(attrs['Encoding'], { mdd })
  const encFlags = encryptedFlags(attrs)

  const v2 = version >= 2.0
  const numSize = v2 ? 8 : 4
  const num = (b: Uint8Array, off: number): number =>
    v2 ? Number(view(b).getBigUint64(off)) : view(b).getUint32(off)

  // 头部 + 4 字节校验
  let pos = 4 + headerLen + 4
  const kbHeadLen = v2 ? 8 * 5 : 4 * 4
  const kbHead = read(pos, kbHeadLen + (v2 ? 4 : 0))

  // v2 的 5 个字段：块数 / 词条数 / 索引解压长 / 索引压缩长 / 词块总长
  const numKeyBlocks = num(kbHead, 0)
  const numEntries = num(kbHead, numSize)
  const keyIndexDecompLen = v2 ? num(kbHead, numSize * 2) : null
  const keyIndexCompLen = v2 ? num(kbHead, numSize * 3) : num(kbHead, numSize * 2)
  const keyBlocksLen = v2 ? num(kbHead, numSize * 4) : num(kbHead, numSize * 3)
  pos += kbHeadLen + (v2 ? 4 : 0) // v2 头部后还有 4 字节校验

  if (keyIndexCompLen <= 0 || pos + keyIndexCompLen > size) {
    return {
      ok: false,
      why: 'key-index',
      detail: `词表索引段 ${keyIndexCompLen} 字节，越过文件尾（文件 ${size} 字节）`,
      attrs
    }
  }

  return {
    ok: true,
    headerLen,
    attrs,
    versionRaw,
    version,
    v2,
    numSize,
    encoding,
    declaredEncoding: attrs['Encoding'] ?? '',
    encFlags,
    numKeyBlocks,
    numEntries,
    keyIndexDecompLen,
    keyIndexCompLen,
    keyBlocksLen,
    keySectionAt: pos,
    title: (attrs['Title'] ?? '').trim(),
    format: attrs['Format'] ?? '',
    registerBy: attrs['RegisterBy'] ?? ''
  }
}
