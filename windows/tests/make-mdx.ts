import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname } from 'node:path'

/**
 * 造一本**真的** .mdx，用来验编码 · D5.1b（2026-08-20）
 *
 * ══ 为什么必须自己造 ★★★ ══════════════════════════════════
 *
 * 他手上 22 本里只有一本声明 GBK（朗文插图版 v1.2），而那本的正文 27.3 MB 里
 * **一个 >= 0x80 的字节都没有** —— 全是 ASCII。也就是说：
 * GBK 解对解错，在他现有的词典上**看不出任何差别**。
 * 拿真词典跑十遍全绿，也证明不了 GBK 这条路是通的。
 *
 * 所以这一版的验收只能靠自己按格式拼出来的这一本：
 * 里面是**真的中文**，字节**真的不是合法 UTF-8** —— 解错了当场乱码。
 * （`tests/make-dict.ts` 造 StarDict 是同一个道理，同一套办法。）
 *
 * ══ 造出来的是真字节，不是「测试用的简化版」══════════════
 *
 * 走的是解析器的同一条路：头部 → 词表索引 → 词表块 → 正文索引 → 正文块，
 * 该压缩的压缩、该分块的分块。1.2 和 2.0 两种形状都能造 ——
 * 1.2 的索引不压缩、位宽 4 字节、首尾词后面没有结尾符，
 * 这几处正是最容易写错、也最难在真词典上定位的地方。
 */

export interface MdxEntry {
  word: string
  body: string
}

export interface MdxOptions {
  /**
   * 头部里声明的编码。**词与正文就按它编码**（这才叫「真的 GBK 文件」）。
   *
   * ★ D5.1c 加了 UTF-16：它和另外两种**框架就不一样** ——
   *   结尾 NUL 是两个字节，索引里的长度字段数的是**字符数**不是字节数。
   *   造得对不对，看的就是这两处。
   */
  encoding?: 'UTF-8' | 'GBK' | 'UTF-16'
  version?: '1.2' | '2.0'
  title?: string
  /**
   * 一块塞几条。默认 2 —— 故意**逼出多块**：
   * 只有一块的话，块与块之间的偏移算错了也看不出来。
   */
  perBlock?: number
}

let table: Map<string, [number, number]> | null = null

/**
 * 把字符串编成 GBK 字节。
 *
 * ★ Node 只有 GBK 的**解码**器（`TextDecoder`），没有编码器 ——
 *   所以这里用解码器把双字节区整个跑一遍，反着建一张表。
 *   查不到的字**直接抛**，不许悄悄换成 `?`：
 *   fixture 要是缺了字，测试会变成「解出来是问号，期望也是问号」的假绿。
 */
export function encodeGbk(s: string): Buffer {
  if (!table) {
    const t = new Map<string, [number, number]>()
    const dec = new TextDecoder('gbk')
    const two = Buffer.alloc(2)
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue
        two[0] = lead
        two[1] = trail
        const ch = dec.decode(two)
        if (ch.length === 1 && ch !== '\uFFFD' && !t.has(ch)) t.set(ch, [lead, trail])
      }
    }
    table = t
  }
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) {
      out.push(c)
      continue
    }
    const pair = table.get(ch)
    if (!pair) throw new Error(`GBK 里没有「${ch}」（U+${c.toString(16).toUpperCase()}）—— 换个字`)
    out.push(pair[0], pair[1])
  }
  return Buffer.from(out)
}

type Enc = 'UTF-8' | 'GBK' | 'UTF-16'

const enc = (s: string, encoding: Enc): Buffer =>
  encoding === 'GBK'
    ? encodeGbk(s)
    : encoding === 'UTF-16'
      ? Buffer.from(s, 'utf16le')
      : Buffer.from(s, 'utf8')

/** 一块数据：4 字节压缩方式（2 = zlib）+ 4 字节校验 + 压缩后的数据 */
function block(data: Buffer): { buf: Buffer; decompLen: number } {
  const body = deflateSync(data)
  const head = Buffer.alloc(8)
  head.writeUInt32LE(2, 0)
  head.writeUInt32BE(0, 4) // 校验位：解析器不看，真文件里是 adler32
  return { buf: Buffer.concat([head, body]), decompLen: data.length }
}

export function writeMdx(file: string, entries: MdxEntry[], opts: MdxOptions = {}): string {
  const encoding = opts.encoding ?? 'UTF-8'
  const version = opts.version ?? '2.0'
  const v2 = version === '2.0'
  const numSize = v2 ? 8 : 4
  const perBlock = opts.perBlock ?? 2
  /** 首尾词后面有没有结尾符 —— 2.0 有，1.2 没有。**跟编码无关** */
  const pad = v2 ? 1 : 0
  /** 一个「长度单位」几个字节：UTF-16 的索引数的是字符数 */
  const unit = encoding === 'UTF-16' ? 2 : 1
  /** 结尾 NUL：UTF-16 是两个字节 */
  const nul = (): Buffer => Buffer.alloc(unit)

  const num = (n: number): Buffer => {
    const b = Buffer.alloc(numSize)
    if (v2) b.writeBigUInt64BE(BigInt(n), 0)
    else b.writeUInt32BE(n, 0)
    return b
  }

  // ── 正文流：每条正文后面跟一个 NUL ──────────────────────────
  const offsets: number[] = []
  const bodyParts: Buffer[] = []
  let at = 0
  for (const e of entries) {
    const b = Buffer.concat([enc(e.body, encoding), nul()])
    offsets.push(at)
    bodyParts.push(b)
    at += b.length
  }

  // ── 词表块：每条是「正文偏移 + 词 + NUL」──────────────────
  const keyBlocks: Buffer[] = []
  const keyIndexParts: Buffer[] = []
  for (let i = 0; i < entries.length; i += perBlock) {
    const chunk = entries.slice(i, i + perBlock)
    const plain = Buffer.concat(
      chunk.map((e, j) =>
        Buffer.concat([num(offsets[i + j]!), enc(e.word, encoding), nul()])
      )
    )
    const { buf, decompLen } = block(plain)
    keyBlocks.push(buf)

    const first = enc(chunk[0]!.word, encoding)
    const last = enc(chunk[chunk.length - 1]!.word, encoding)
    const lenField = (n: number): Buffer => {
      const b = Buffer.alloc(v2 ? 2 : 1)
      if (v2) b.writeUInt16BE(n, 0)
      else b.writeUInt8(n, 0)
      return b
    }
    const tail = pad ? nul() : Buffer.alloc(0)
    keyIndexParts.push(
      num(chunk.length),
      // ★ 长度字段数的是「长度单位」：UTF-16 是字符数，其余是字节数
      lenField(first.length / unit),
      first,
      tail,
      lenField(last.length / unit),
      last,
      tail,
      num(buf.length),
      num(decompLen)
    )
  }
  const keyIndexPlain = Buffer.concat(keyIndexParts)
  // 2.0 的词表索引本身也是压缩块；1.2 是明文
  const keyIndex = v2 ? block(keyIndexPlain).buf : keyIndexPlain
  const keyBlocksBuf = Buffer.concat(keyBlocks)

  // ── 正文块 ────────────────────────────────────────────────
  const recBlocks: Buffer[] = []
  const recIndexParts: Buffer[] = []
  for (let i = 0; i < bodyParts.length; i += perBlock) {
    const { buf, decompLen } = block(Buffer.concat(bodyParts.slice(i, i + perBlock)))
    recBlocks.push(buf)
    recIndexParts.push(num(buf.length), num(decompLen))
  }
  const recIndex = Buffer.concat(recIndexParts)
  const recBlocksBuf = Buffer.concat(recBlocks)

  // ── 头部 ──────────────────────────────────────────────────
  const xml =
    `<Dictionary GeneratedByEngineVersion="${version}" RequiredEngineVersion="${version}" ` +
    `Encoding="${encoding}" Format="Html" Encrypted="No" ` +
    `Title="${opts.title ?? 'fixture'}" Description="D5.1b fixture"/>`
  const header = Buffer.from(xml, 'utf16le')
  const headLen = Buffer.alloc(4)
  headLen.writeUInt32BE(header.length, 0)

  // ── 词表段头：2.0 是 5 个字段 + 4 字节校验；1.2 是 4 个字段 ──
  const keySection = v2
    ? Buffer.concat([
        num(keyBlocks.length),
        num(entries.length),
        num(keyIndexPlain.length),
        num(keyIndex.length),
        num(keyBlocksBuf.length),
        Buffer.alloc(4)
      ])
    : Buffer.concat([
        num(keyBlocks.length),
        num(entries.length),
        num(keyIndex.length),
        num(keyBlocksBuf.length)
      ])

  const recSection = Buffer.concat([
    num(recBlocks.length),
    num(entries.length),
    num(recIndex.length),
    num(recBlocksBuf.length)
  ])

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    Buffer.concat([
      headLen,
      header,
      Buffer.alloc(4), // 头部校验位
      keySection,
      keyIndex,
      keyBlocksBuf,
      recSection,
      recIndex,
      recBlocksBuf
    ])
  )
  return file
}
