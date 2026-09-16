import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

/**
 * 造一本真的 StarDict 词典，用来验解析器。
 *
 * **为什么要自己造字节而不是塞一个词典文件进仓库**：
 * 真词典动辄几十上百 MB，而且有版权。自己按格式拼出来的这一本，
 * 走的是**同一条解析路径** —— 包括 dictzip 那段分块索引（这是最容易写错、
 * 也最难在真词典上定位的一段）。
 */

export interface FakeEntry {
  word: string
  body: string
}

/** 普通 .dict（不压缩）。 */
export function writePlainDict(dir: string, name: string, entries: FakeEntry[]): string {
  mkdirSync(dir, { recursive: true })
  const stem = join(dir, name)

  const idxParts: Buffer[] = []
  const dictParts: Buffer[] = []
  let off = 0
  for (const e of entries) {
    const body = Buffer.from(e.body, 'utf8')
    dictParts.push(body)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(off, 0)
    head.writeUInt32BE(body.length, 4)
    idxParts.push(Buffer.from(e.word + '\0', 'utf8'), head)
    off += body.length
  }
  const idx = Buffer.concat(idxParts)

  writeFileSync(`${stem}.dict`, Buffer.concat(dictParts))
  writeFileSync(`${stem}.idx`, idx)
  writeFileSync(
    `${stem}.ifo`,
    [
      `StarDict's dict ifo file`,
      `version=3.0.0`,
      `bookname=${name}`,
      `wordcount=${entries.length}`,
      `idxfilesize=${idx.length}`,
      `sametypesequence=m`,
      ``
    ].join('\n'),
    'utf8'
  )
  return `${stem}.ifo`
}

/**
 * dictzip 版的 .dict.dz —— gzip 外壳，FEXTRA 里藏着每块压缩后的长度，
 * 因此能只解压用到的那一两块。块开小一点（64 字节），好让测试数据也跨块。
 */
export function writeDzDict(
  dir: string,
  name: string,
  entries: FakeEntry[],
  chlen = 64
): string {
  mkdirSync(dir, { recursive: true })
  const stem = join(dir, name)

  const idxParts: Buffer[] = []
  const bodies: Buffer[] = []
  let off = 0
  for (const e of entries) {
    const body = Buffer.from(e.body, 'utf8')
    bodies.push(body)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(off, 0)
    head.writeUInt32BE(body.length, 4)
    idxParts.push(Buffer.from(e.word + '\0', 'utf8'), head)
    off += body.length
  }
  const raw = Buffer.concat(bodies)
  const idx = Buffer.concat(idxParts)

  // 按 chlen 切块，每块单独 deflate（raw，无 zlib 头）
  const chunks: Buffer[] = []
  for (let p = 0; p < raw.length; p += chlen) {
    chunks.push(deflateRawSync(raw.subarray(p, p + chlen)))
  }

  const ra = Buffer.alloc(6 + chunks.length * 2)
  ra.writeUInt16LE(1, 0) // VER
  ra.writeUInt16LE(chlen, 2) // CHLEN
  ra.writeUInt16LE(chunks.length, 4) // CHCNT
  chunks.forEach((c, i) => ra.writeUInt16LE(c.length, 6 + i * 2))

  const sub = Buffer.alloc(4 + ra.length)
  sub[0] = 0x52 // 'R'
  sub[1] = 0x41 // 'A'
  sub.writeUInt16LE(ra.length, 2)
  ra.copy(sub, 4)

  const header = Buffer.alloc(12)
  header[0] = 0x1f
  header[1] = 0x8b
  header[2] = 0x08
  header[3] = 0x04 // FEXTRA
  header.writeUInt32LE(0, 4) // MTIME
  header[8] = 0x00 // XFL
  header[9] = 0x03 // OS
  header.writeUInt16LE(sub.length, 10) // XLEN

  writeFileSync(`${stem}.dict.dz`, Buffer.concat([header, sub, ...chunks]))
  writeFileSync(`${stem}.idx`, idx)
  writeFileSync(
    `${stem}.ifo`,
    [
      `StarDict's dict ifo file`,
      `version=3.0.0`,
      `bookname=${name}`,
      `wordcount=${entries.length}`,
      `idxfilesize=${idx.length}`,
      `sametypesequence=m`,
      ``
    ].join('\n'),
    'utf8'
  )
  return `${stem}.ifo`
}
