/**
 * 从原文里把「包含这个表达的那一句」找出来 · M-012 / I-103
 *
 * 使用者：「我的收集里面的知识点是从我上传的原文文件中来的，
 *          所以摘录的时候，直接根据原文文件中的内容进行原文摘录。
 *          从我的收集中析出来的知识点，也按照原文文件里面的内容进行原文摘录。」
 *
 * 以前的做法是拿**他贴进来的那一行**当出处 —— 那一行常常已经是他手动摘短的，
 * 甚至就是词条本身（`hold sway over`）。出处等于词条，认读卡就挖不出空，
 * M-012 说的「原文出处是知识点身份的一半」也就落空了。
 *
 * 纯逻辑，不碰数据库、不碰界面（D-238）。
 */

/**
 * 把一段文字切成句子。
 *
 * 不用 `Intl.Segmenter`：它在不同 Electron/Node 版本上的分句边界会变，
 * 而出处是要落库的**事实**，同一段文字今天切成这样、明天切成那样，
 * 是最难查的那种漂移。所以用一条写死的规则，行为永远一致。
 *
 * 规则：`. ! ?` 后面跟空白算断句；常见缩写（Mr. / U.S. / e.g. / i.e. / etc.）不断。
 * 换行也算断句 —— 字幕、诗、清单里一行就是一句。
 */
export function sentences(text: string): string[] {
  const NO_BREAK = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|cf|No|Fig|Vol|approx|U\.S|U\.K)\.$/i
  const out: string[] = []
  let cur = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    let i = 0
    while (i < line.length) {
      cur += line[i]
      const c = line[i]
      const next = line[i + 1]
      if ((c === '.' || c === '!' || c === '?') && (next === undefined || /\s|["')\]]/.test(next))) {
        if (!NO_BREAK.test(cur.trim())) {
          out.push(cur.trim())
          cur = ''
        }
      }
      i++
    }
    if (cur.trim()) {
      out.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

/** 归一化到「能比对」的形态：小写、把各种引号和连字符拉平、空白折叠 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 在原文里找包含 `term` 的那一句。
 *
 * 三档，逐档放宽 —— 越往后越可能找错，所以顺序不能反：
 *   ① 整串原样出现（大小写、引号、连字符归一之后）
 *   ② 词形有变化：把 term 拆成词，要求**同一句里按顺序**都出现
 *      （`hold sway over` 能匹配 `held sway over`，因为只有中间的词换了形）
 *   ③ 找不到就返回 null —— **不硬凑**。宁可没有出处，也不要一个错的出处：
 *      错的出处会一路带进认读卡和导出的笔记里。
 */
export function findQuote(text: string, term: string): string | null {
  const t = norm(term)
  if (!t || !text.trim()) return null
  const list = sentences(text)

  for (const s of list) {
    if (norm(s).includes(t)) return s
  }

  /**
   * 词形变化：按**词序**找。只保留 4 个字母以上的实词 —— 虚词到处都是，会乱命中。
   *
   * 允许**漏一个词**（三词以上时）。因为屈折变化里最常变的就是那个动词，
   * 而且常常是不规则的：`hold sway over` 在原文里是 `held sway over`，
   * 去后缀救不了 `hold → held`。放宽到「漏一个」正好能接住这一类，
   * 又不至于变成「只要有一个词命中就算」。
   * 两个词以内不给这个宽容 —— 那时候漏一个等于只剩一个词，太容易找错。
   */
  const words = t.split(' ').filter((w) => w.length >= 4)
  if (words.length === 0) return null
  const allowMiss = words.length >= 3 ? 1 : 0

  for (const s of list) {
    const n = norm(s)
    let at = 0
    let missed = 0
    for (const w of words) {
      // 去掉常见屈折后缀再找，`holds` / `holding` 都能落到 `hold`
      const stem = w.replace(/(ing|ed|es|s)$/, '')
      const found = n.indexOf(stem, at)
      if (found < 0) {
        missed++
        if (missed > allowMiss) break
        continue
      }
      at = found + stem.length
    }
    if (missed <= allowMiss) return s
  }
  return null
}

/**
 * 一次找一批。原文可能有好几份材料，按顺序找，第一份找到就用它。
 * 返回 `null` 表示这一条在所有原文里都没找到 —— 交给调用方决定怎么办。
 */
export function findQuoteIn(texts: string[], term: string): string | null {
  for (const t of texts) {
    const q = findQuote(t, term)
    if (q) return q
  }
  return null
}
