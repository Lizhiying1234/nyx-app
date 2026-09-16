import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { mdxDecryptKeyInfo } from './ripemd128.ts'
/**
 * ★ 相对路径，不用 `@core/…` 别名 —— 取证脚本用裸 node 直接 import 这个模块，
 *   别名在那边解不开（`mdd.ts` 里有同一条注释，同一个坑）。
 */
import { lzo1xDecompress } from '../../core/dict/lzo1x.ts'
import { decodeGbk, keyTerminatorBytes, keyTextBytes } from '../../core/dict/encoding.ts'
/**
 * ★★ T-4.15 · 头部字段的取法收进了 `core/dict/mdx-header.ts` 一份 ——
 *   这条路与读词那条路（`core/dict/mdx.ts::Mdx`）现在读的是**同一段代码**。
 *   在这之前两处各写一遍、同源只写在注释里，而 GBK 那次已经真的漂过一次。
 */
import {
  headerAttrs as coreHeaderAttrs,
  encryptedFlags as coreEncryptedFlags,
  readMdxHeader,
  type MdxHeaderOk
} from '../../core/dict/mdx-header.ts'

/**
 * MDict 头部与词表的**只读**解析 · D2（2026-08-19）
 *
 * ══ 它和 `mdict.ts` 的分工 ★★ ══════════════════════════════
 *
 *     mdict-header.ts  只读头部与词表段 —— **廉价**，不建索引、不碰正文
 *     mdict.ts         真正装载：建全量索引、取正文（软件今天在跑的那一份）
 *
 * ★ T-4.15：分工不变，但**头怎么读**两边不再各写一遍 ——
 *   本文件现在只负责「用 node:fs 把字节取出来」，哪几个字节是什么由
 *   `core/dict/mdx-header.ts` 说了算。词表块与正文段的解法仍各在各处
 *   （那两条路要的东西真的不一样：一个只数词，一个要建全量索引）。
 *
 * 分开的理由写在 `core/dict/contract.ts` 里：`probe` 必须便宜，
 * 否则 D5 的惰性装载没法做（实测启动时全量装载 18 本要 7.3 秒、常驻 990 MB，
 * 而且发生在建窗口之前 —— 他看到的是「双击了半天没反应」）。
 *
 * ══ ★★★ 身份取值约定 —— 实现已经上提 core（T-4.15 · 2026-09-07）══════
 *
 *     formatVersion = `GeneratedByEngineVersion` **原字符串**（`"2.0"`，不是 parseFloat 之后的 `"2"`）
 *     indexBytes    = `keyBlocksLen`（**词条块段**），不是 keyInfo 的长度
 *
 * 他 2026-08-19 裁决：这两条永久固定。**取法今天只有一份**：
 * `core/dict/mdx-header.ts::identityOf()` —— 本文件、读词那条路（`core/dict/mdx.ts`）、
 * 喂 `dictUid` 的 `adapters/mdict.ts` 三处都从它取，Android 端同一份。
 * （在 T-4.15 之前这里写的是「唯一实现在本文件，将来照抄这里」——
 *   而「照抄」出来的第二份正是 GBK 那次漂掉的原因。）
 * 取错了照样跑得通、照样算出 21 个不重复的 uid ——
 * 只是和另一台机器上算的没有一个对得上，而且什么都不报。
 * 规格见 `core/dict/identity.ts` 第二节之二，回归向量见 `identity.test.ts` 第 ④ 段，
 * 两条路是否同答案见 `tests/dict-mdx.test.ts` 的 T-4.15 那一段。
 *
 * （这份代码原来在 `scripts/lib/mdict-read.mjs`；D2 搬进 `src/` 成为生产代码，
 *   脚本改成从这里 re-export —— 取证脚本和软件必须量的是同一把尺子。）
 */

/**
 * probe 的结果 = core 那份头部字段 **加一个** `size`。
 * ★ 字段名与 `MdxHeaderOk` 逐字相同（本来就是从这里搬过去的），
 *   所以 `identityOf(p)` 直接吃它 —— 身份原料不用在这一层再拼一遍。
 */
export interface MdictProbeOk extends MdxHeaderOk {
  size: number
}

export interface MdictProbeFail {
  ok: false
  why: 'size' | 'header-len' | 'no-attrs' | 'key-index' | 'exception'
  detail: string
  attrs?: Record<string, string>
}

export type MdictProbe = MdictProbeOk | MdictProbeFail

interface BlockError extends Error {
  code?: 'LZO' | 'UNKNOWN_COMPRESSION'
  kind?: number
}

/** 解一块：前 4 字节压缩类型、再 4 字节校验，剩下是数据 */
export function decompressBlock(buf: Buffer, expect?: number): Buffer {
  const kind = buf.readUInt32LE(0)
  const body = buf.subarray(8)
  if (kind === 0) return body
  if (kind === 2) return inflateSync(body)
  if (kind === 1) {
    /**
     * ★ D5.1a · 老版 MDict（1.2）的 LZO1X。解码器在 `core/dict/lzo1x.ts`：
     *   纯函数、零 I/O，Android 端照搬同一份。
     *   `expect` 是块头里写着的解压后长度 —— 一次分配到位，也当一道校验。
     */
    try {
      return Buffer.from(lzo1xDecompress(body, expect))
    } catch (err) {
      const e = new Error(err instanceof Error ? err.message : String(err)) as BlockError
      e.code = 'LZO'
      throw e
    }
  }
  const e = new Error(`unknown-compression:${kind}`) as BlockError
  e.code = 'UNKNOWN_COMPRESSION'
  e.kind = kind
  throw e
}

/**
 * ★ 这两个现在只是 `core/dict/mdx-header.ts` 的转口 ——
 *   老调用点（`mdd.ts` / `adapters/mdict.ts` / 取证脚本）一个字都不用改。
 */
export const headerAttrs = coreHeaderAttrs
export const encryptedFlags = coreEncryptedFlags

/**
 * 只读头部 + 词表段的元数据。**不解词块。**
 * 失败返回 `{ ok:false, why, detail }` —— **不抛**（`claims` 契约要求绝不抛异常）。
 */
export function probeMdict(path: string, opts: { mdd?: boolean } = {}): MdictProbe {
  let size: number
  try {
    size = statSync(path).size
  } catch (err) {
    return { ok: false, why: 'exception', detail: err instanceof Error ? err.message : String(err) }
  }
  if (size < 64) return { ok: false, why: 'size', detail: `文件只有 ${size} 字节` }

  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    return { ok: false, why: 'exception', detail: err instanceof Error ? err.message : String(err) }
  }

  try {
    /**
     * ★ 只负责「把字节取出来」；哪几个字节是什么由 core 那一份说了算。
     *   `readSync` 可能短读（网络盘 / 大偏移），所以循环补满 —— 补不满就让它抛，
     *   下面的 catch 会变成 `why: 'exception'`，和以前一样不抛到调用方。
     */
    const read = (at: number, len: number): Uint8Array => {
      const buf = Buffer.alloc(len)
      let got = 0
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, at + got)
        if (n <= 0) throw new Error(`读到第 ${at + got} 字节就没有了（要 ${len} 字节）`)
        got += n
      }
      return buf
    }
    const h = readMdxHeader(read, size, { mdd: opts.mdd ?? false })
    if (!h.ok) return h
    return { ...h, size }
  } catch (err) {
    return { ok: false, why: 'exception', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    closeSync(fd)
  }
}

export interface KeyReadOk {
  ok: true
  count: number
  stopped?: boolean
}
export interface KeyReadFail {
  ok: false
  why: string
  detail: string
  read?: number
}

/**
 * 把词表键读出来。**只解词块，不碰正文段。**
 *
 * `onKey(word, recordOffset)` 逐个回调，避免把 430 万个键攒在内存里
 *（TLD 就是这个量级）。`recordOffset` 是这条记录在**解压后正文流**里的偏移。
 * 回调返回 `false` 就停。
 */
export function readKeys(
  path: string,
  p: MdictProbeOk,
  onKey: (word: string, at: number) => boolean | void
): KeyReadOk | KeyReadFail {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    return { ok: false, why: 'exception', detail: err instanceof Error ? err.message : String(err) }
  }
  try {
    const idxBuf = Buffer.alloc(p.keyIndexCompLen)
    readSync(fd, idxBuf, 0, p.keyIndexCompLen, p.keySectionAt)
    let idx: Buffer
    try {
      idx = p.v2
        ? decompressBlock(p.encFlags & 2 ? mdxDecryptKeyInfo(idxBuf) : idxBuf, p.keyIndexDecompLen ?? undefined)
        : idxBuf
    } catch (err) {
      const e = err as BlockError
      return { ok: false, why: e.code ?? 'index', detail: String(e.message) }
    }

    const blockInfo: { compLen: number; decompLen: number }[] = []
    {
      let q = 0
      const textLen = (): number => {
        const n = p.v2 ? idx.readUInt16BE(q) : idx.readUInt8(q)
        q += p.v2 ? 2 : 1
        return n
      }
      /**
       * ★ 首尾词后面那个 NUL **只有 2.0 版有**。
       *   1.2 版的索引项是「1 字节字符数 + 字符本体」，没有结尾符 ——
       *   多跳 2 个字节，从第二块起偏移就全飞了，报出来是
       *   `The value of "offset" is out of range`（正是 D-262 说的那种报错：
       *   报出来的不是真原因。修对之后才看见真原因是 LZO）。
       */
      const pad = p.v2 ? 1 : 0
      for (let i = 0; i < p.numKeyBlocks; i++) {
        q += p.numSize
        const firstLen = textLen()
        q += keyTextBytes(firstLen, p.encoding, pad)
        const lastLen = textLen()
        q += keyTextBytes(lastLen, p.encoding, pad)
        const compLen = p.v2 ? Number(idx.readBigUInt64BE(q)) : idx.readUInt32BE(q)
        q += p.numSize
        const decompLen = p.v2 ? Number(idx.readBigUInt64BE(q)) : idx.readUInt32BE(q)
        q += p.numSize
        blockInfo.push({ compLen, decompLen })
      }
    }

    let at = p.keySectionAt + p.keyIndexCompLen
    let n = 0
    for (const b of blockInfo) {
      const raw = Buffer.alloc(b.compLen)
      readSync(fd, raw, 0, b.compLen, at)
      at += b.compLen
      let plain: Buffer
      try {
        plain = decompressBlock(raw, b.decompLen)
      } catch (err) {
        const e = err as BlockError
        return { ok: false, why: e.code ?? 'block', detail: String(e.message), read: n }
      }
      let q = 0
      while (q + p.numSize < plain.length) {
        /** 这条记录在**解压后的正文流**里的偏移 —— 取正文要靠它 */
        const recAt = p.v2 ? Number(plain.readBigUInt64BE(q)) : plain.readUInt32BE(q)
        q += p.numSize
        /**
         * 词是 NUL 结尾。★ GBK 的两个字节都落在 0x81–0xFE / 0x40–0xFE，
         *   **不可能撞上 0x00** —— 所以它和 UTF-8 用同一条扫法（见 encoding.ts）。
         */
        let end = q
        if (keyTerminatorBytes(p.encoding) === 2) {
          while (end + 1 < plain.length && !(plain[end] === 0 && plain[end + 1] === 0)) end += 2
        } else {
          while (end < plain.length && plain[end] !== 0) end += 1
        }
        const word =
          p.encoding === 'gbk'
            ? decodeGbk(plain.subarray(q, end))
            : plain.toString(p.encoding, q, end)
        q = end + keyTerminatorBytes(p.encoding)
        n++
        if (onKey(word, recAt) === false) return { ok: true, count: n, stopped: true }
      }
    }
    return { ok: true, count: n }
  } catch (err) {
    return { ok: false, why: 'exception', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    closeSync(fd)
  }
}

export interface RecordBlock {
  /** 文件里的位置与压缩后长度 */
  fileAt: number
  compLen: number
  /** 这一块在解压后正文流里覆盖的区间 */
  start: number
  end: number
}

/**
 * 正文段的分块索引。词表段之后紧接着它。
 * **只读索引，不解任何一块** —— 取哪一块由调用方按需要决定（D5 惰性的前提）。
 */
export function readRecordIndex(path: string, p: MdictProbeOk): RecordBlock[] | null {
  const fd = openSync(path, 'r')
  try {
    let pos = p.keySectionAt + p.keyIndexCompLen + p.keyBlocksLen
    const head = Buffer.alloc(p.numSize * 4)
    readSync(fd, head, 0, head.length, pos)
    const num = (b: Buffer, off: number): number =>
      p.v2 ? Number(b.readBigUInt64BE(off)) : b.readUInt32BE(off)
    const numRecBlocks = num(head, 0)
    const recIndexLen = num(head, p.numSize * 2)
    pos += head.length
    if (recIndexLen <= 0 || pos + recIndexLen > p.size) return null

    const recIdx = Buffer.alloc(recIndexLen)
    readSync(fd, recIdx, 0, recIndexLen, pos)
    pos += recIndexLen

    const out: RecordBlock[] = []
    let fileAt = pos
    let streamAt = 0
    for (let i = 0; i < numRecBlocks; i++) {
      const compLen = num(recIdx, i * p.numSize * 2)
      const decompLen = num(recIdx, i * p.numSize * 2 + p.numSize)
      out.push({ fileAt, compLen, start: streamAt, end: streamAt + decompLen })
      fileAt += compLen
      streamAt += decompLen
    }
    return out
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
