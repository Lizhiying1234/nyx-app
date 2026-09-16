import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * 读文件里的正文 · I-037
 *
 * 「贴入材料也没有支持很多格式，比如 md, docx, pdf 等等。」
 *
 * 三种格式自己解，一个依赖都不加 —— 跟词典那两个解析器同一条路子：
 *   `.txt` / `.md` / `.srt` / `.vtt`  纯文本，md 只去掉会干扰阅读的记号
 *   `.docx`                          就是个 ZIP，正文在 word/document.xml
 *
 * **`.pdf` 已经撤掉（I-073）。** 自己解 Tj / TJ 在使用者的真实 PDF 上一直读不出来
 * —— 字体子集编码、分栏、CID 映射，做到可靠得引一个完整的 PDF 引擎。
 * 与其留一个大概率失败的入口，不如当场说清不支持、并给出可行的替代做法。
 */

export interface ReadDoc {
  title: string
  text: string
  kind: 'text' | 'markdown' | 'docx' | 'subtitle'
  chars: number
  /** 读得可疑时说一句 —— 不装作没事（D-262） */
  note?: string
}

const TEXTY = new Set(['.txt', '.text', '.log'])
const SUBS = new Set(['.srt', '.vtt'])

export function readDocument(path: string): ReadDoc {
  const ext = extname(path).toLowerCase()
  const title = basename(path, ext)

  if (ext === '.docx') return readDocx(path, title)
  if (ext === '.pdf') {
    // I-073 · 不再假装能读
    throw new Error(
      'PDF 读不了 —— 真实 PDF 的字体编码和分栏太复杂，做到可靠得引一个完整的 PDF 引擎。\n' +
        '换个法子转一下：用 Word 打开 PDF 再另存 .docx，或者浏览器里打开、全选正文复制、粘贴进来。'
    )
  }
  if (SUBS.has(ext)) {
    const raw = readFileSync(path, 'utf8')
    const text = stripSubtitleTiming(raw)
    return { title, text, kind: 'subtitle', chars: text.length }
  }
  if (ext === '.md' || ext === '.markdown') {
    const text = stripMarkdown(readFileSync(path, 'utf8'))
    return { title, text, kind: 'markdown', chars: text.length }
  }
  if (TEXTY.has(ext) || ext === '') {
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim()
    return { title, text, kind: 'text', chars: text.length }
  }
  if (ext === '.doc') {
    throw new Error(
      '旧版 .doc 读不了 —— 它是二进制格式，和 .docx 完全不同。\n' +
        '用 Word 另存为 .docx，或者直接把正文复制过来粘贴。'
    )
  }
  throw new Error(
    `不认识 ${ext} 这种格式。\n现在支持：.txt · .md · .docx · .srt · .vtt。\n` +
      '其他格式请复制正文粘贴。'
  )
}

/**
 * Markdown 只去掉**会干扰阅读的记号**，不做完整渲染。
 * 标题的 `#`、强调的 `*`、链接的方括号 —— 留着会让 AI 把它们当成内容的一部分。
 * 代码块整段丢掉：那不是要学的英文。
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '') // front matter
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, (l) => l.replace(/\|/g, ' ').trim())
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 字幕去时间轴 · I-038
 * 「我希望它可以自己把字幕整理给我，去除时间轴」。
 *
 * SRT / VTT / YouTube 抓下来的都走这里。除了去时间轴，还要**把断行接回句子** ——
 * 字幕每行只有几个词，原样喂给 AI 等于每句话都被切碎，判层和出处都会歪。
 */
export function stripSubtitleTiming(raw: string): string {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/^WEBVTT.*$/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^\d+$/.test(l) && // SRT 的序号
        !/^\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}\s*-->/.test(l) && // 时间轴
        !/^(NOTE|STYLE|REGION)\b/.test(l)
    )
    .map((l) =>
      l
        .replace(/<[^>]+>/g, '') // <c>、<v Speaker> 之类
        .replace(/\{\\[^}]*\}/g, '') // ASS 样式
        .trim()
    )
    .filter(Boolean)

  // 相邻重复行去掉（滚动字幕会把上一行重复一遍）
  const dedup: string[] = []
  for (const l of lines) if (l !== dedup[dedup.length - 1]) dedup.push(l)

  // 接回句子：上一行不是以句末标点结尾，就和下一行连起来
  const out: string[] = []
  for (const l of dedup) {
    const prev = out[out.length - 1]
    if (prev && !/[.!?:"'’”)\]]$/.test(prev)) out[out.length - 1] = `${prev} ${l}`
    else out.push(l)
  }
  return out.join('\n').replace(/[ \t]+/g, ' ').trim()
}

// ── docx ──────────────────────────────────────────────────────────
// .docx 是 ZIP。只需要拿出 word/document.xml 这一个条目。

function readDocx(path: string, title: string): ReadDoc {
  const buf = readFileSync(path)
  const xml = unzipEntry(buf, 'word/document.xml')
  if (!xml) {
    throw new Error('这个 .docx 里找不到正文（word/document.xml）—— 文件可能损坏了。')
  }
  const s = xml.toString('utf8')
  const text = s
    // <w:p> 是段落，</w:p> 处断行；<w:br/> 和 <w:tab/> 也要保留
    .replace(/<w:br[^>]*\/?>/g, '\n')
    .replace(/<w:tab[^>]*\/?>/g, ' ')
    .replace(/<\/w:p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, text, kind: 'docx', chars: text.length }
}

/** 从 ZIP 里取一个条目。只认「不压」和 deflate，这两种覆盖了所有 .docx。 */
function unzipEntry(buf: Buffer, want: string): Buffer | null {
  // 从尾部找 End of Central Directory
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localAt = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    if (name === want) {
      // 本地头的额外字段长度可能和中央目录里的不一样，必须现读
      const lNameLen = buf.readUInt16LE(localAt + 26)
      const lExtraLen = buf.readUInt16LE(localAt + 28)
      const dataAt = localAt + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataAt, dataAt + compSize)
      return method === 0 ? data : inflateRawSync(data)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}
