import { deflateRawSync } from 'node:zlib'

/**
 * 按 ZIP 格式拼一个真的 .docx 出来 · I-037
 *
 * 和造 StarDict 那本词典同一个道理：**走的是同一条解析路径**。
 * 塞一个现成的 .docx 进仓库也行，但那样验不到「本地头的额外字段长度
 * 和中央目录里不一样」这类真会踩的坑 —— 自己拼字节才踩得到。
 */

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

interface Entry {
  name: string
  data: Buffer
}

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let at = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const comp = deflateRawSync(e.data)
    const crc = crc32(e.data)

    // 本地头。**故意给一段额外字段** —— 中央目录里那份写 0，
    // 这样才能验出「必须现读本地头的 extraLen」这一条
    const extra = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(8, 8) // deflate
    lh.writeUInt32LE(0, 10)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(extra.length, 28)
    locals.push(lh, name, extra, comp)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(0, 12)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30) // 中央目录里不写额外字段
    ch.writeUInt16LE(0, 32)
    ch.writeUInt32LE(0, 42)
    ch.writeUInt32LE(at, 42)
    centrals.push(ch, name)

    at += 30 + name.length + extra.length + comp.length
  }

  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(at, 16)

  return Buffer.concat([...locals, central, eocd])
}

export function makeDocx(...paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('')
  const doc =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}</w:body></w:document>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  return zip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(doc, 'utf8') }
  ])
}
