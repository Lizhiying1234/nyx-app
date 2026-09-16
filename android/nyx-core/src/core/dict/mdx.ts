import { mdxDecryptKeyInfo } from './ripemd128.ts'
import { lzo1xDecompress } from './lzo1x.ts'
import type { DictionaryIO, FileHandle, Inflate } from './contract.ts'
import type { DictIdentityInput } from './identity.ts'
import {
  decodeGbk,
  keyTerminatorBytes,
  keyTextBytes,
  trimBodyTerminator,
  type MdictEncoding
} from './encoding.ts'
/** ★★ T-4.15 · 头部字段的取法与体检那条路共用同一份（见那个文件的头注） */
import { identityOf, readMdxHeader } from './mdx-header.ts'

/**
 * MDict（.mdx）解析 · I-031 → **D-401 词典批端口化搬入 core**（2026-08-30）
 *
 * 这是 `main/dict/mdict.ts` 的**同一份逻辑**，只换了两层皮：
 *   · I/O 走注入的 `DictionaryIO`（contract.ts 的那份 —— Windows 注 node:fs，
 *     Android 注内存缓冲；D-238「换掉的只应该是 io 那一个文件」到位）
 *   · 解压走注入的 `Inflate`（Windows 注 node:zlib，Android 注纯 JS unzlib）
 *   · Buffer → Uint8Array + DataView / TextDecoder（字节语义逐位不变；
 *     UTF-8/UTF-16LE 的非法序列两边都换 U+FFFD，与 Buffer.toString 同策）
 * `main/dict/mdict.ts` 现在是 Node 门面（Mdict.open(path) 签名与调用点不变）。
 *
 * ── 以下为原档案注释，事实未变，原样保留 ─────────────────────
 *
 * **为什么改了主意。**
 * D-215 让我验的是「MDict 在 Node 生态里能否用」。我查了 npm 上的三个包，
 * 授权和依赖都不合适，于是按预案退回 StarDict —— 这一步的推理没错，
 * **但我漏了决定性的事实：使用者手上的词典是什么格式**。
 * 他放进来的 7 本全是 .mdx（牛津高阶10、朗文搭配、21世纪大英汉、Synonym 辨析…），
 * StarDict 解析写得再对，读不了他的文件就等于没做。
 *
 * 所以按 StarDict 那条路重来一遍：**格式自己解，一个依赖都不加。**
 *
 * 格式（v1.2 与 v2.0 都要支持，位宽不同）：
 *   ┌ 头部：4B 长度 + UTF-16LE 的 XML 属性串 + 4B 校验
 *   ├ 词条索引：块数 / 词条数 / 索引压缩前后长度 / 词块总长
 *   ├ 词条块：每块 4B 压缩类型 + 4B 校验，解开后是「记录偏移 + 词（NUL 结尾）」
 *   └ 正文段：块数 / 词条数 / 索引长 / 正文总长，然后每块 (压缩后长, 解压后长)
 *
 * 压缩类型 0=不压 · 1=LZO · 2=zlib，**三种都支持**。
 * LZO 是 D5.1a 补的（解码器在 `core/dict/lzo1x.ts`：纯函数、零 I/O，两端共用）。
 *
 * 编码 UTF-8 / UTF-16LE / GBK，**判断只有一处**：`core/dict/encoding.ts`。
 * GBK 是 D5.1b 补的 —— 在那之前这里和 `mdict-header.ts` 对同一本书给的答案不一样。
 * UTF-16 是 D5.1c 修的：它和另外两种**框架不一样**（结尾 NUL 两个字节、
 * 索引里的长度数的是字符数），而原来那两处都按单字节算 ——
 * 症状是**正文只剩半个字符、屏幕上一片空白，而且不报错**。
 */

export interface MdxMeta {
  title: string
  wordCount: number
  version: number
}

interface KeyEntry {
  /** 在解压后的正文流里的偏移 */
  at: number
  word: string
}

interface RecordBlock {
  /** 文件里的位置与压缩后长度 */
  fileAt: number
  compLen: number
  /** 这一块在解压后正文流里覆盖的区间 */
  start: number
  end: number
}

const utf8 = new TextDecoder('utf-8')
const utf16le = new TextDecoder('utf-16le')

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 解一块：前 4 字节是压缩类型，再 4 字节是校验，剩下是数据。 */
function decompress(buf: Uint8Array, inflate: Inflate, expect?: number): Uint8Array {
  const kind = view(buf).getUint32(0, true)
  const body = buf.subarray(8)
  if (kind === 0) return body
  if (kind === 2) return inflate(body)
  if (kind === 1) {
    /**
     * ★ D5.1a · 老版 MDict（1.2）的 LZO1X 压缩。解码器纯函数、零 I/O，两端共用。
     *   `expect` 是块头里写着的解压后长度 —— 一次分配到位，也当一道校验。
     */
    return lzo1xDecompress(body, expect)
  }
  throw new Error(`不认识的压缩方式（${kind}）。`)
}

export interface MdxOpenOptions {
  /** 这是资源包 `.mdd`（键 UTF-16LE，正文是原始字节） */
  mdd?: boolean
}

export class Mdx {
  readonly title: string
  /**
   * 跨设备身份的原料（identity.ts::dictUid 要的**原始头字段** · D2.1）。
   * ★ 为什么单独留一份：display 用的 title/version 都被加工过（title 会退到
   *   文件名、version 被 parseFloat）——身份**只认头里原样的字节**，加工一道
   *   就是另一个身份（identity.ts 第二节之二的教训）。Android 扫描靠它算 uid，
   *   与 Windows `adapters/mdict.ts` 喂 `dictUid()` 的字段逐项同源。
   */
  readonly identity: DictIdentityInput
  readonly version: number
  readonly path: string

  /** 小写词 → 在正文流里的偏移。装载时一次建好 */
  private index = new Map<string, number>()
  /** 有序的词条位置，用来算每条的结束位置 */
  private offsets: number[] = []
  private blocks: RecordBlock[] = []
  private encoding: MdictEncoding = 'utf8'
  private readonly io: DictionaryIO
  private readonly inflate: Inflate
  private h: FileHandle | null

  /** 这是资源包 `.mdd` 吗 —— 它的键是 UTF-16LE，正文是**原始字节**（不是文本） */
  private readonly mdd: boolean

  private constructor(path: string, io: DictionaryIO, inflate: Inflate, opts?: MdxOpenOptions) {
    this.path = path
    this.io = io
    this.inflate = inflate
    this.mdd = opts?.mdd === true
    const h = io.open(path)
    this.h = null // 装载走局部句柄；查词时 readStream 再懒开（与原版 fd 生命周期一致）
    const size = h.size
    const read = (at: number, len: number): Uint8Array => io.read(h, at, len)
    try {
    // ── 头部 ────────────────────────────────────────────────
    /**
     * ★★ T-4.15 · 「头里哪几个字节是什么」不在这里判了 ——
     *   与体检那条路（`main/dict/mdict-header.ts::probeMdict`）读的是同一段代码。
     *   在这之前两处各写一遍：GBK 补上之前，这里和那条路对同一本书给的答案不一样。
     */
    const head = readMdxHeader((at, len) => read(at, len), size, { mdd: this.mdd })
    if (!head.ok) throw new Error(`这本词典的头部读不了（${head.why}）：${head.detail}`)

    this.title =
      head.title || (path.split(/[\\/]/).pop() ?? path).replace(/\.mdx$/i, '')
    this.version = head.version
    this.encoding = head.encoding

    const encFlags = head.encFlags
    // & 1 才是真的授权锁（要使用者的注册码）。& 2 是格式自带的固定混淆，见 ripemd128.ts
    if (encFlags & 1) {
      throw new Error(
        '这本词典的索引是加密的，读不了。\n' +
          'MDict 的加密是给付费词典用的，绕开它属于破解 —— 换一本没加密的。'
      )
    }

    const v2 = head.v2
    const num = (b: Uint8Array, off: number): number =>
      v2 ? Number(view(b).getBigUint64(off)) : view(b).getUint32(off)

    // ── 词条索引段 ──────────────────────────────────────────
    // ★ 名字保持原样：下面建索引那几百行一个字都不用改（这一轮只换「谁算出来的」）
    const numSize = head.numSize
    const numKeyBlocks = head.numKeyBlocks
    const keyBlocksLen = head.keyBlocksLen
    const keyIndexCompLen = head.keyIndexCompLen
    /** ★★ 身份原料也只有一份取法（`identityOf`）—— 这里不再自己拼 */
    this.identity = identityOf(head)
    let pos = head.keySectionAt

    // 索引本身（v2 压缩，v1 不压）
    const idxBuf = read(pos, keyIndexCompLen)
    pos += keyIndexCompLen
    const idx = v2
      ? decompress(encFlags & 2 ? mdxDecryptKeyInfo(idxBuf) : idxBuf, this.inflate)
      : idxBuf

    // 每个词块的 (词条数, 首词, 尾词, 压缩长, 解压长)
    const blockInfo: { compLen: number; decompLen: number }[] = []
    {
      const idv = view(idx)
      let p = 0
      const textLen = (): number => {
        // v2 的词长是 2 字节且带一个结尾符；v1 是 1 字节
        const n = v2 ? idv.getUint16(p) : idv.getUint8(p)
        p += v2 ? 2 : 1
        return n
      }
      /**
       * 首尾词后面那个结尾符占几个「长度单位」——**只看版本，不看编码**。
       *
       * ★ D5.1c 改的就是这一行：原来 UTF-16 那一档写死 1，连 1.2 版也是，
       *   于是 1.2 + UTF-16 的索引每块多跳 2 个字节，从第二块起全飞掉。
       * ★ 凭什么说 1.2 就是 0：体检那条路一直是 `v2 ? 1 : 0`，而他那本
       *   朗文插图版的 .mdd 正好是 1.2 + UTF-16 键，用这条规则读出了
       *   1219 条资源 —— 真文件作的证，不是我推的。
       */
      const pad = v2 ? 1 : 0
      for (let i = 0; i < numKeyBlocks; i++) {
        p += numSize // 这一块里的词条数
        const firstLen = textLen()
        p += keyTextBytes(firstLen, this.encoding, pad)
        const lastLen = textLen()
        p += keyTextBytes(lastLen, this.encoding, pad)
        const compLen = num(idx, p)
        p += numSize
        const decompLen = num(idx, p)
        p += numSize
        blockInfo.push({ compLen, decompLen })
      }
    }

    // ── 词条块：读出「偏移 + 词」 ───────────────────────────
    const keys: KeyEntry[] = []
    {
      let at = pos
      for (const b of blockInfo) {
        const raw = read(at, b.compLen)
        at += b.compLen
        const plain = decompress(raw, this.inflate, b.decompLen)
        let p = 0
        while (p + numSize < plain.length) {
          const recAt = num(plain, p)
          p += numSize
          // 词是 NUL 结尾；utf16 是双字节 NUL（GBK 的字节碰不到 0x00，同 UTF-8）
          let end = p
          if (keyTerminatorBytes(this.encoding) === 2) {
            while (end + 1 < plain.length && !(plain[end] === 0 && plain[end + 1] === 0)) end += 2
          } else {
            while (end < plain.length && plain[end] !== 0) end += 1
          }
          const word = this.text(plain.subarray(p, end))
          p = end + keyTerminatorBytes(this.encoding)
          keys.push({ at: recAt, word })
        }
      }
      pos += keyBlocksLen
    }

    // ── 正文段 ──────────────────────────────────────────────
    const rbHead = read(pos, numSize * 4)
    const numRecBlocks = num(rbHead, 0)
    const recIndexLen = num(rbHead, numSize * 2)
    pos += numSize * 4

    const recIdx = read(pos, recIndexLen)
    pos += recIndexLen

    let fileAt = pos
    let streamAt = 0
    for (let i = 0; i < numRecBlocks; i++) {
      const compLen = num(recIdx, i * numSize * 2)
      const decompLen = num(recIdx, i * numSize * 2 + numSize)
      this.blocks.push({
        fileAt,
        compLen,
        start: streamAt,
        end: streamAt + decompLen
      })
      fileAt += compLen
      streamAt += decompLen
    }
    if (fileAt > size + 1) throw new Error('这个文件的正文段长度对不上，可能没下完整。')

    for (const k of keys) {
      const lower = k.word.trim().toLowerCase()
      if (!this.index.has(lower)) this.index.set(lower, k.at)
    }
    this.offsets = [...new Set(keys.map((k) => k.at))].sort((a, b) => a - b)
    } finally {
      io.close(h)
    }
  }

  /**
   * @param opts.mdd 这个文件是资源包 `.mdd`（不是词典正文 `.mdx`）。
   *   两处不一样：**键**一律 UTF-16LE（头里根本没有 `Encoding` 属性，
   *   见 encoding.ts），**正文**是原始字节而不是文本 —— 所以 mdd 只该走
   *   `bytesOf()`，`lookup()/rawOf()` 那两条会把字节当文本解。
   */
  static open(path: string, io: DictionaryIO, inflate: Inflate, opts?: MdxOpenOptions): Mdx {
    return new Mdx(path, io, inflate, opts)
  }

  get wordCount(): number {
    return this.index.size
  }

  has(word: string): boolean {
    return this.index.has(word.trim().toLowerCase())
  }

  /**
   * 按这本词典声明的编码解一段字节 · D5.1b
   * UTF-8 / UTF-16LE 走 TextDecoder（与 Buffer.toString 同为 U+FFFD 替换策略）；
   * GBK 走 `core/dict/encoding.ts::decodeGbk`（判断只有那一处）。
   */
  private text(bytes: Uint8Array): string {
    if (this.encoding === 'gbk') return decodeGbk(bytes)
    return this.encoding === 'utf16le' ? utf16le.decode(bytes) : utf8.decode(bytes)
  }

  /** 索引里的全部词目（已归一成小写）· D2 加 */
  keys(): Iterable<string> {
    return this.index.keys()
  }

  /**
   * **未压平**的正文 · D2 加。
   * `lookup()` 返回压平后的纯文本（老路径）；`raw()` 契约要原始 HTML ——
   * 富文本渲染、`@@@LINK` 识别、资源引用全在标签里。
   */
  rawOf(word: string): string | null {
    const at = this.index.get(word.trim().toLowerCase())
    if (at === undefined) return null
    const i = binarySearch(this.offsets, at)
    const end = i >= 0 && i + 1 < this.offsets.length ? this.offsets[i + 1]! : Infinity
    const raw = this.readStream(at, end)
    return raw ? this.text(raw) : null
  }

  /**
   * **原始字节** · D-404（Android 词典资源批要的那条）。
   *
   * `.mdd` 里存的是文件（css / png / mp3），不是文本 —— 拿它必须走这里：
   * 不按编码解码，也不剪「正文以 NUL 结尾」那一刀（那是文本正文的规矩，
   * 对二进制会啃掉一个字节）。键的归一（`sound://x.mp3` → `\x.mp3`）
   * 是调用方的事（core/dict/media.ts 有那把尺）。
   */
  bytesOf(key: string): Uint8Array | null {
    const at = this.index.get(key.trim().toLowerCase())
    if (at === undefined) return null
    const i = binarySearch(this.offsets, at)
    const end = i >= 0 && i + 1 < this.offsets.length ? this.offsets[i + 1]! : Infinity
    return this.readStream(at, end, true)
  }

  lookup(word: string): string | null {
    const at = this.index.get(word.trim().toLowerCase())
    if (at === undefined) return null

    // 这一条到下一条之间就是它的正文
    const i = binarySearch(this.offsets, at)
    const end = i >= 0 && i + 1 < this.offsets.length ? this.offsets[i + 1]! : Infinity

    const raw = this.readStream(at, end)
    if (!raw) return null
    return toText(this.text(raw))
  }

  /** 从解压后的正文流里取 [from, to)。只解开覆盖到的那几块。 */
  private readStream(from: number, to: number, raw = false): Uint8Array | null {
    if (this.h === null) this.h = this.io.open(this.path)
    const parts: Uint8Array[] = []
    for (const b of this.blocks) {
      if (b.end <= from) continue
      if (b.start >= to) break
      const comp = this.io.read(this.h, b.fileAt, b.compLen)
      const plain = decompress(comp, this.inflate)
      const s = Math.max(0, from - b.start)
      const e = Math.min(plain.length, to - b.start)
      parts.push(plain.subarray(s, e))
      // 一条词条通常不会跨很多块，够了就停
      if (b.end >= to) break
      if (parts.length > 4) break
    }
    if (parts.length === 0) return null
    const all = concatBytes(parts)
    if (raw) return all // 资源包：字节原样给 —— 剪结尾符是文本正文的规矩
    /**
     * 正文以 NUL 结尾。★ D5.1c：这条规则在 `core/dict/encoding.ts` ——
     * `all.indexOf(0)` 对 UTF-16 是致命的（第一个 0 字节在第 2 个字节）。
     */
    return trimBodyTerminator(all, this.encoding)
  }

  close(): void {
    if (this.h !== null) {
      this.io.close(this.h)
      this.h = null
    }
  }
}

function binarySearch(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === v) return mid
    if (arr[mid]! < v) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/**
 * .mdx 的正文几乎都是 HTML，而且带着词典自己的 CSS 类名。
 * 压成人读的纯文本 —— 我们只要词义和例句，不要排版。
 */
export function toText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|dd|dt|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, a) => l.length > 0 || (i > 0 && a[i - 1]!.length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
