import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

/**
 * StarDict 解析 · D-151 / D-215
 *
 * **为什么是 StarDict 而不是 MDict**（CLAUDE.md 第一周要验的第 2 件）：
 * 2026-08 查过 npm 上的现成实现 ——
 *   · `js-mdict@7` 是 **AGPL-3.0**，接进来整个软件都得跟着 AGPL
 *   · `mdict-js@10` 是 MIT，但拖着 17 个依赖，里面塞了拼写检查器和词形还原器
 *   · `node-stardict@0.0.5` 依赖 express + cors —— 一个词典库带着 Web 服务器
 * .mdx 是逆向出来的私有格式（还有加密与 LZO 变体），而 StarDict 格式公开、结构极简，
 * **自己写不到 200 行，一个依赖都不用加**。所以按 D-215 的预案走 StarDict。
 *
 * 三个文件：
 *   `.ifo`  纯文本 key=value，记着书名、词数、偏移位宽、正文类型
 *   `.idx`  「词（UTF-8，NUL 结尾）+ 偏移 + 长度」重复到底，偏移和长度都是大端
 *   `.dict` 正文；`.dict.dz` 是 dictzip —— 合法 gzip，但 FEXTRA 里藏着分块索引，
 *           所以能**只解压用到的那一两块**，不必把整本词典读进内存
 */


interface Entry {
  off: number
  size: number
}

/** dictzip 的分块索引：每块解压后固定 chlen 字节，压缩后长度各不相同。 */
interface DzIndex {
  chlen: number
  /** 每块在文件中的起始位置与压缩后长度 */
  chunks: { at: number; len: number }[]
}

function parseIfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** gzip 头里那段 dictzip 索引。不是 dictzip（普通 gzip）就返回 null。 */
function readDzIndex(buf: Buffer): DzIndex | null {
  if (buf.length < 12 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 0x08) return null
  const flg = buf[3] ?? 0
  if (!(flg & 0x04)) return null // 没有 FEXTRA，就是普通 gzip

  let p = 10
  const xlen = buf.readUInt16LE(p)
  p += 2
  const xEnd = p + xlen
  let idx: DzIndex | null = null

  while (p + 4 <= xEnd) {
    const si1 = buf[p]
    const si2 = buf[p + 1]
    const len = buf.readUInt16LE(p + 2)
    const data = p + 4
    if (si1 === 0x52 && si2 === 0x41) {
      // 'RA' —— version, chlen, chcnt, 然后 chcnt 个 u16 块长
      const chlen = buf.readUInt16LE(data + 2)
      const chcnt = buf.readUInt16LE(data + 4)
      const sizes: number[] = []
      for (let i = 0; i < chcnt; i++) sizes.push(buf.readUInt16LE(data + 6 + i * 2))
      idx = { chlen, chunks: sizes.map((len2) => ({ at: 0, len: len2 })) }
    }
    p = data + len
  }
  if (!idx) return null

  // 跳过 FNAME / FCOMMENT / FHCRC，剩下的就是第一块压缩数据的起点
  p = xEnd
  const skipCString = (): void => {
    while (p < buf.length && buf[p] !== 0) p++
    p++
  }
  if (flg & 0x08) skipCString() // FNAME
  if (flg & 0x10) skipCString() // FCOMMENT
  if (flg & 0x02) p += 2 // FHCRC

  let at = p
  for (const c of idx.chunks) {
    c.at = at
    at += c.len
  }
  return idx
}

export class StarDict {
  readonly bookname: string
  readonly wordCount: number
  readonly folder: string
  readonly ifoPath: string

  /** 小写词 → 正文位置。一本 10 万词的词典大约几 MB，随手放得下 */
  private index = new Map<string, Entry>()
  private sameType: string
  private dictPath: string
  private dz: DzIndex | null = null
  private fd: number | null = null

  private constructor(ifoPath: string) {
    this.ifoPath = ifoPath
    this.folder = dirname(ifoPath)
    const ifo = parseIfo(readFileSync(ifoPath, 'utf8'))
    this.bookname = ifo['bookname'] || basename(ifoPath).replace(/\.ifo$/i, '')
    this.sameType = ifo['sametypesequence'] ?? ''
    const bits = Number(ifo['idxoffsetbits'] ?? 32) === 64 ? 64 : 32

    const stem = ifoPath.replace(/\.ifo$/i, '')
    this.dictPath = this.pick(stem, ['.dict.dz', '.dict'])
    const idxPath = this.pick(stem, ['.idx', '.idx.gz'])

    let idx = readFileSync(idxPath)
    if (idxPath.endsWith('.gz')) idx = gunzipSync(idx)
    this.readIndex(idx, bits)
    this.wordCount = this.index.size
  }

  private pick(stem: string, exts: string[]): string {
    for (const e of exts) {
      const p = stem + e
      try {
        if (statSync(p).isFile()) return p
      } catch {
        /* 试下一个 */
      }
    }
    throw new Error(`${basename(stem)} 少了 ${exts.join(' 或 ')} 文件 —— 这本词典不完整。`)
  }

  private readIndex(buf: Buffer, bits: number): void {
    const step = bits === 64 ? 8 : 4
    let p = 0
    while (p < buf.length) {
      const nul = buf.indexOf(0, p)
      if (nul < 0 || nul + 1 + step + 4 > buf.length) break
      const word = buf.toString('utf8', p, nul)
      const at = nul + 1
      const off = bits === 64 ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at)
      const size = buf.readUInt32BE(at + step)
      p = at + step + 4
      // 同一个词多个义项时保留第一条 —— 词典自己就是按重要性排的
      const k = word.toLowerCase()
      if (!this.index.has(k)) this.index.set(k, { off, size })
    }
  }

  static open(ifoPath: string): StarDict {
    return new StarDict(ifoPath)
  }

  has(word: string): boolean {
    return this.index.has(word.trim().toLowerCase())
  }

  /** 查一个词。查不到返回 null —— 查不到是常态，不是错误。 */
  lookup(word: string): string | null {
    const e = this.index.get(word.trim().toLowerCase())
    if (!e) return null
    const raw = this.readAt(e.off, e.size)
    return this.toText(raw)
  }

  /** 索引里的全部词目（已归一成小写）· D2 加。纯新增，`lookup()` 一个字没动 */
  keys(): Iterable<string> {
    return this.index.keys()
  }

  /**
   * **未经 `toText()`** 的正文 · D2 加。
   * StarDict 的正文多半本来就是纯文本（`sametypesequence=m`），
   * 但 `x`（xdxf）和 `h`（html）两种是带标签的 —— 契约要的是原样。
   */
  rawOf(word: string): string | null {
    const e = this.index.get(word.trim().toLowerCase())
    if (!e) return null
    return this.readAt(e.off, e.size).toString('utf8')
  }

  /** 正文的形状。`sametypesequence` 说了算 */
  get shape(): 'html' | 'text' | 'xdxf' {
    if (this.sameType.includes('h')) return 'html'
    if (this.sameType.includes('x')) return 'xdxf'
    return 'text'
  }

  private ensureOpen(): number {
    if (this.fd === null) {
      this.fd = openSync(this.dictPath, 'r')
      if (this.dictPath.endsWith('.dz')) {
        // 头部够读出 FEXTRA 就行，不用把整本读进来
        const head = Buffer.alloc(Math.min(65536 + 64, statSync(this.dictPath).size))
        readSync(this.fd, head, 0, head.length, 0)
        this.dz = readDzIndex(head)
      }
    }
    return this.fd
  }

  private readAt(off: number, size: number): Buffer {
    const fd = this.ensureOpen()
    if (!this.dz) {
      const b = Buffer.alloc(size)
      readSync(fd, b, 0, size, off)
      return b
    }

    // dictzip：只解压覆盖到 [off, off+size) 的那几块
    const { chlen, chunks } = this.dz
    const first = Math.floor(off / chlen)
    const last = Math.floor((off + size - 1) / chlen)
    const parts: Buffer[] = []
    for (let i = first; i <= last && i < chunks.length; i++) {
      const c = chunks[i]!
      const comp = Buffer.alloc(c.len)
      readSync(fd, comp, 0, c.len, c.at)
      parts.push(inflateRawSync(comp))
    }
    const joined = Buffer.concat(parts)
    const start = off - first * chlen
    return joined.subarray(start, start + size)
  }

  /** 正文可能是纯文本、HTML 或 XDXF。一律压成人读的纯文本。 */
  private toText(buf: Buffer): string {
    let type = this.sameType
    let body = buf

    if (!type) {
      // 没有 sametypesequence 时，每段正文自带一个类型字符
      const t = String.fromCharCode(buf[0] ?? 0x6d)
      type = t
      body = /[A-Z]/.test(t) ? buf.subarray(5) : buf.subarray(1)
      const nul = body.indexOf(0)
      if (/[a-z]/.test(t) && nul >= 0) body = body.subarray(0, nul)
    }

    const s = body.toString('utf8').replace(/\0+$/, '')
    if (type[0] === 'h' || type[0] === 'x' || type[0] === 'g') {
      return s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|dd|dt|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }
    return s.trim()
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd)
      this.fd = null
    }
  }
}

