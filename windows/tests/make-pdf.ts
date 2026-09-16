import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

/**
 * 造一个最小但**合法**的 PDF，用来验文本提取（I-037 / I-063）。
 *
 * 为什么自己拼字节：真 PDF 有版权、体积大，而且看不出解析器到底在哪一步错了。
 * 这一份走的是和真文件完全同一条路径 —— FlateDecode 的内容流 + Tj 操作符，
 * 那正是「文字型 PDF」最常见的形态。
 */
export function makePdf(dest: string, sentence: string): string {
  const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${sentence}) Tj ET`, 'latin1')
  const comp = deflateSync(content)

  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'),
    Buffer.concat([
      Buffer.from(`<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`),
      comp,
      Buffer.from('\nendstream')
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ]

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  let at = parts[0]!.length
  objs.forEach((o, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`)
    offsets.push(at)
    const chunk = Buffer.concat([head, o, Buffer.from('\nendobj\n')])
    parts.push(chunk)
    at += chunk.length
  })

  const xrefAt = at
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`]
  for (const o of offsets) xref.push(`${String(o).padStart(10, '0')} 00000 n \n`)
  parts.push(Buffer.from(xref.join('')))
  parts.push(
    Buffer.from(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
  )

  writeFileSync(dest, Buffer.concat(parts))
  return dest
}
