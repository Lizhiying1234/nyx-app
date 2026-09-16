/**
 * 正文自动分段 · 使用者 5.1
 *
 * 「上传内容必须自动分段，**禁止整段文字粘连在一起**。」
 *
 * 以前只按空行切（`\n\s*\n`）。从 PDF、网页、字幕里粘过来的正文经常
 * **一个空行都没有** —— 于是整篇文章渲染成一个巨大的段落，
 * 读起来像一堵墙，而且「跳到第 3 段」这类定位全部失效（任务卡的 `para` 就靠它）。
 *
 * 分三层，从最可信的信号往下退：
 *   ① 有空行 → 就按空行。这是作者自己的分段，最准
 *   ② 没有空行但有换行 → 按单换行分。多数从 PDF 粘出来的是这一档
 *   ③ 连换行都没有 → **按句子凑段**。这是最后一档，也是最需要小心的一档
 *
 * 第 ③ 档为什么按「凑够多少字」而不是「固定几句」：
 * 英文句子长短差得很远，固定 4 句可能是 60 字也可能是 600 字。
 * 读者眼睛需要的是**大致均匀的块**，所以按字数凑，凑到就断在句子边界上。
 *
 * **不做的事**：不改一个字。分段只是插入边界，正文逐字保留 ——
 * 原文出处（M-012）要能在正文里逐字找到，动了字就全断了。
 */

/** 一段大概多少字符算合适。太短显得碎，太长又变成墙。 */
const TARGET = 420

/**
 * 拆不拆，看**这份正文自己有没有分段**。
 *
 * 这个区分是截图之后才补上的：原来一律用 700 当阈值，
 * 结果一段 640 字、一个换行都没有的正文照样渲染成一整块 ——
 * 而那正是使用者说的「整段文字粘连在一起」。
 *
 *   · 原文**自带分段**（有空行或换行）→ 那是作者的判断，最可信。
 *     只有极端长的块才动它（`KEEP`），不然就是我在替作者重新分段。
 *   · 原文**一个分隔都没有**（从 PDF、网页一坨粘出来的）→ 没有可信的判断可依，
 *     按 `TARGET` 主动拆。这一档不拆就等于没做这个功能。
 */
const KEEP = 1200

/** 切句。规则写死，不用 Intl.Segmenter：版本之间边界会变，分段结果就不稳定。 */
function sentences(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    buf += c
    if (c === '.' || c === '!' || c === '?' || c === '。' || c === '！' || c === '？') {
      // 缩写和小数点后面通常不是句末：Mr. / U.S. / 3.5
      const next = text[i + 1]
      const prev2 = text.slice(Math.max(0, i - 3), i)
      const isAbbrev = /\b(Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|U\.S)$/i.test(prev2)
      const isDecimal = c === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(next ?? '')
      if (!isAbbrev && !isDecimal && (next === undefined || /\s|["'”’)\]]/.test(next))) {
        out.push(buf.trim())
        buf = ''
      }
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** 把一段过长的文字按句子边界凑成大致均匀的几块 */
function packBySentence(block: string): string[] {
  const ss = sentences(block)
  if (ss.length <= 1) return [block]
  const out: string[] = []
  let cur = ''
  for (const s of ss) {
    if (cur && cur.length + s.length + 1 > TARGET) {
      out.push(cur)
      cur = s
    } else {
      cur = cur ? `${cur} ${s}` : s
    }
  }
  if (cur) out.push(cur)
  return out
}

export function paragraphs(content: string): string[] {
  const text = (content ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return []

  // ① 作者自己的分段
  let blocks = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  /** 这份正文自带分段吗？自带就尽量尊重它 */
  let authored = blocks.length > 1

  // ② 只有单换行的（PDF / 字幕粘出来的常见形态）
  if (!authored && text.includes('\n')) {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length > 1) {
      blocks = lines
      authored = true
    }
  }

  // ③ 太长的块按句子凑段。阈值取决于上面那个判断
  const limit = authored ? KEEP : TARGET
  const out: string[] = []
  for (const b of blocks) {
    if (b.length > limit) out.push(...packBySentence(b))
    else out.push(b)
  }
  return out
}
