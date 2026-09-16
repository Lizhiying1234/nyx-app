import { closeSync, openSync, readSync } from 'node:fs'
import { decompressBlock, type MdictProbeOk } from './mdict-header.ts'
import { mdxDecryptKeyInfo } from './ripemd128.ts'
import { decodeGbk, keyTerminatorBytes, keyTextBytes } from '../../core/dict/encoding.ts'

/**
 * 「这本收没收这个词」· D5.2（2026-08-23）
 *
 * ══ 为什么要它 ★★★ ═════════════════════════════════════════
 *
 * `lookupCard` 末尾要回答「别的哪几本也有它」，从前的做法是把**其余每一本
 * 都装载一遍**（建全量索引）再问一句。实测：其余 20 本 6542 ms。
 * 而这一问要的只是一个布尔值 —— 为了一个布尔值建了 790 万条索引。
 *
 * ══ 为什么不是「二分定位到一块就完事」★★★ ═══════════════════
 *
 * 词表索引段里每一块都写着首词目和尾词目，二分定位很自然。取证阶段量过：
 * 解析整段索引 ≤ 2.5 ms（TLD 3432 块也只要 2.5 ms）。**但二分会漏。**
 *
 * 漏的根源不是解析写错了，是**词典自己的排序规则 ≠ 我们的归一化**：
 *
 *   · `Longman Dictionary of Common Errors` 最后一个词目是 `"﻿th"`（带 BOM）。
 *     `trim()` 会把 BOM 去掉 —— 于是那一块的「尾」归一之后变成 `th`，
 *     而 `thankful` > `th`，二分当场判它不在这本里。**它明明在。**
 *   · `英语常用词疑难用法手册` 只有一块，首 `" a. d."` 尾 `"﻿0说明"`，
 *     归一之后区间是 ["a. d.", "0说明"] —— **首比尾还大**，抽样 300 个词全漏。
 *   · `-browed` / `'a` / `.22` 这类词目：词典按去掉前导标点的形式排序，
 *     它们躺在 `brow` 附近，而归一比较会把它们送到第 0 块。
 *
 * 所以这里的规矩是死的：
 *
 *   **块区间只用来证「有」，永远不用来证「没有」。**
 *
 * 二分命中那一块、并且那一块里真的有这个键 → 直接返回 true（几毫秒）。
 * 只要没命中，就老老实实把词表全扫一遍再说「没有」——
 * 这样结果和「装载全书再查」**逐字相同**，不会有词典从选择器里悄悄消失。
 *
 * ══ 全扫为什么还是划算 ══════════════════════════════════════
 *
 * 全扫的成本几乎全在 zlib 解压（TLD：解压 107 MB 要 277 ms，
 * 而 `readKeys` 连解码带建字符串要 737 ms）。这里**不建字符串**：
 * 在字节层比对，400 万个 JS 字符串一个都不生成。TLD 全扫 413 ms、
 * 而装载它要 4196 ms —— 同样是「走完最坏情况」，十倍之差。
 */

/** 词表索引段里一块的样子。`at` 是这一块在文件里的位置 */
interface KeyBlock {
  first: string
  last: string
  compLen: number
  decompLen: number
  at: number
}

const norm = (s: string): string => s.trim().toLowerCase()

/** ASCII 空白 —— 字节层的 `trim()`。BOM 是多字节，交给字符串那条路 */
const isWs = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c

/** ASCII 大小写折叠 —— 字节层的 `toLowerCase()` */
const fold = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 32 : c)

/**
 * 解析词表索引段。**只读索引，不碰词表块本身**（TLD 的索引 8 KB，词表 107 MB）。
 *
 * 和 `readKeys` 里那段走法一致，区别只在这里**留下首尾词目**（它不需要）。
 */
function keyBlocks(fd: number, p: MdictProbeOk): KeyBlock[] {
  const idxBuf = Buffer.alloc(p.keyIndexCompLen)
  readSync(fd, idxBuf, 0, p.keyIndexCompLen, p.keySectionAt)
  const idx = p.v2
    ? decompressBlock(
        p.encFlags & 2 ? mdxDecryptKeyInfo(idxBuf) : idxBuf,
        p.keyIndexDecompLen ?? undefined
      )
    : idxBuf

  const term = keyTerminatorBytes(p.encoding)
  /** 首尾词目后面那个结尾符只有 2.0 版有 —— 和 `readKeys` 同一条规则 */
  const pad = p.v2 ? 1 : 0
  const out: KeyBlock[] = []
  let q = 0
  let at = p.keySectionAt + p.keyIndexCompLen

  const textLen = (): number => {
    const n = p.v2 ? idx.readUInt16BE(q) : idx.readUInt8(q)
    q += p.v2 ? 2 : 1
    return n
  }
  const text = (len: number): string => {
    const bytes = keyTextBytes(len, p.encoding, pad)
    const end = q + bytes - (pad ? term : 0)
    const s =
      p.encoding === 'gbk'
        ? decodeGbk(idx.subarray(q, end))
        : idx.toString(p.encoding, q, end)
    q += bytes
    return s
  }

  for (let i = 0; i < p.numKeyBlocks; i++) {
    q += p.numSize // 这一块里有几条
    const first = text(textLen())
    const last = text(textLen())
    const compLen = p.v2 ? Number(idx.readBigUInt64BE(q)) : idx.readUInt32BE(q)
    q += p.numSize
    const decompLen = p.v2 ? Number(idx.readBigUInt64BE(q)) : idx.readUInt32BE(q)
    q += p.numSize
    out.push({ first, last, compLen, decompLen, at })
    at += compLen
  }
  return out
}

/** 把要找的词编成这本词典的字节。非 ASCII 就返回 null（走字符串那条路） */
function wantBytes(word: string, enc: MdictProbeOk['encoding']): Buffer | null {
  for (let i = 0; i < word.length; i++) if (word.charCodeAt(i) > 0x7f) return null
  if (enc === 'utf16le') return Buffer.from(word, 'utf16le')
  // UTF-8 与 GBK 在 ASCII 区逐字节相同 —— 所以同一串字节两边都能用
  return Buffer.from(word, 'latin1')
}

/**
 * 在**解开的一块词表**里找这个键。
 *
 * ★ 走的是和 `readKeys` 同一条切分（`numSize` 偏移 + NUL 结尾），
 *   但**不建字符串**：ASCII 的词直接在字节上比，
 *   非 ASCII 的词才解码出来比（那种查询很少，慢一点无所谓）。
 */
function blockHas(plain: Buffer, p: MdictProbeOk, want: string, bytes: Buffer | null): boolean {
  const term = keyTerminatorBytes(p.encoding)
  let q = 0
  while (q + p.numSize < plain.length) {
    q += p.numSize
    let end = q
    if (term === 2) {
      while (end + 1 < plain.length && !(plain[end] === 0 && plain[end + 1] === 0)) end += 2
    } else {
      while (end < plain.length && plain[end] !== 0) end += 1
    }

    if (bytes) {
      // 字节层：先掐掉首尾 ASCII 空白，再逐字节折叠比较
      let s = q
      let e = end
      while (s < e && isWs(plain[s]!)) s += term
      while (e > s && isWs(plain[e - term]!)) e -= term
      let same = e - s === bytes.length
      if (same) {
        for (let i = 0; i < bytes.length; i++) {
          if (fold(plain[s + i]!) !== bytes[i]!) {
            same = false
            break
          }
        }
      }
      if (same) return true
      /**
       * ★★★ 字节层的 `trim()` 只掐得掉 ASCII 空白，而索引用的是
       *   `String.trim()` —— 它**连 BOM 一起去**（U+FEFF 在规范里算空白）。
       *
       *   `Longman Dictionary of Common Errors` 的最后一个词目就是 `"﻿th"`：
       *   索引里它是 `th`，字节层看到的却是 `EF BB BF 74 68`，两边对不上，
       *   于是那一条**从此查不到**。所以键里只要有非 ASCII 字节、
       *   而且比要找的词更长，就解出来按字符串再比一次。
       *
       *   这一步只对**这一类键**掏钱：纯 ASCII 的词目走不到这里。
       */
      if (e - s > bytes.length) {
        let high = false
        for (let i = s; i < e; i++) {
          if (plain[i]! > 0x7f) {
            high = true
            break
          }
        }
        if (high) {
          const w =
            p.encoding === 'gbk'
              ? decodeGbk(plain.subarray(q, end))
              : plain.toString(p.encoding, q, end)
          if (norm(w) === want) return true
        }
      }
    } else {
      const w =
        p.encoding === 'gbk'
          ? decodeGbk(plain.subarray(q, end))
          : plain.toString(p.encoding, q, end)
      if (norm(w) === want) return true
    }
    q = end + term
  }
  return false
}

/** 解开某一块 */
function openBlock(fd: number, b: KeyBlock): Buffer | null {
  try {
    const raw = Buffer.alloc(b.compLen)
    readSync(fd, raw, 0, b.compLen, b.at)
    return decompressBlock(raw, b.decompLen)
  } catch {
    return null
  }
}

/**
 * 这本词典收没收这个词。**不建全量索引。**
 *
 * 结果与「装载全书再查」**逐字相同** —— 见文件头「只用来证有」那一节。
 * 出任何岔子一律返回 `false`：这一问只决定选择器里那本要不要点亮，
 * 让它因为一本坏词典整条查词路崩掉是不划算的（真正的诊断在 `handle()` 那边）。
 */
export function hasKey(path: string, p: MdictProbeOk, key: string): boolean {
  const want = norm(key)
  if (!want) return false
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const blocks = keyBlocks(fd, p)
    const bytes = wantBytes(want, p.encoding)

    // ── 快路：二分定位一块，只解那一块 ──────────────────────
    let lo = 0
    let hi = blocks.length - 1
    let guess = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const b = blocks[mid]!
      if (want < norm(b.first)) hi = mid - 1
      else if (want > norm(b.last)) lo = mid + 1
      else {
        guess = mid
        break
      }
    }
    if (guess >= 0) {
      const plain = openBlock(fd, blocks[guess]!)
      if (plain && blockHas(plain, p, want, bytes)) return true
    }

    // ── 慢路：没证出「有」就得走完，才说得出「没有」──────────
    for (let i = 0; i < blocks.length; i++) {
      if (i === guess) continue // 刚看过
      const plain = openBlock(fd, blocks[i]!)
      if (plain && blockHas(plain, p, want, bytes)) return true
    }
    return false
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}
