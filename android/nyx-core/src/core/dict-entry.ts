/**
 * 词典原文 → 能摆进卡片第一屏的那几样 · D-151
 *
 * ── 这个模块只做一件事 ────────────────────────────────────
 *
 * `raw`（某一本词典对某个词的原文）→ **音标 / 词性 / 核心释义**。
 * 它不认识数据库、不认识哪本词典是默认的、不决定任何业务语义 ——
 * 那些是 `main/dict` 的事。这里只做"看得懂多少算多少"。
 *
 * ── 为什么必须允许失败 ★★ ─────────────────────────────────
 *
 * 他机器上 22 本词典，排版各不相同：21 世纪是 `[音标]` 换行 `vt.` 换行释义；
 * OALD 是 `noun /brʌnt/`；朗文是 `brunt /brʌnt/ noun`；TLD 里夹着
 * `VERB60267282`、`TEM8GRE`、光秃秃的 `209` 这种词频编号；同义词典整篇是列表。
 *
 * **抽不出来就不抽。** 卡片会原样显示 `raw`，他照样看得到内容。
 * 反过来 —— 猜一个释义标上去 —— 是这个功能最坏的失败方式：
 * 他信了，然后用错。错的结构化结果比没有结构化结果更糟。
 */

export interface DictSense {
  /** 词性，抽不出就没有 */
  pos?: string
  /** 释义正文 */
  gloss: string
}

export interface DictParsed {
  /** 音标（不含方括号 / 斜线），抽不出就没有 */
  phonetic?: string
  /** 前几条释义。抽不出就是空数组 —— 那时卡片直接显示 `raw` */
  senses: DictSense[]
  /** 原文，一个字都不删。滚动区显示它 */
  raw: string
}

/**
 * 音标里必然出现的那些字符。
 *
 * 判据故意收得很紧：`[俚语]` 也是方括号，`(unspool 的现在分词)` 也是括号。
 * 要求括号内**至少有一个国际音标专用字符**，才认它是音标。
 * 宁可漏认（他还能在原文里看到），不可错认（把「俚语」当成音标摆在标题下）。
 */
const IPA = /[ˈˌːəʌɪʊæɒɔɜɑθðʃʒŋɡɹɾʧʤ]/
const CJK = /[一-鿿]/

/** 词性：英文缩写（`vt.` `n.` `adj.`）或整词（`noun` `verb`） */
const POS_ABBR = /^(n|v|vt|vi|adj|adv|prep|conj|pron|int|interj|aux|abbr|num|art)\.\s*/i
const POS_WORD =
  /^(noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|determiner)\b\s*/i

/**
 * 这一行是不是**噪声**。
 *
 * 全部来自他真实词典里的样本，不是想象出来的：
 *   `VERB60267282` `NOUN1817715952`  TLD 的词性 + 编号
 *   `TEM8GRE` `n14157915` `209`      词频 / 考试标签 / 编号
 *   `Spoken:`                        栏目名后面跟一串数字
 *   `以上来源于：《21世纪大英汉词典》`  版权尾巴
 *   `更多收起结果` `jump to other results`  网页版残留的交互文案
 */
function isNoise(line: string): boolean {
  const s = line.trim()
  if (!s) return true
  if (/^\d+$/.test(s)) return true // 光秃秃一串数字
  if (/^[A-Z]{2,}\d+$/.test(s)) return true // VERB60267282
  if (/^[A-Za-z]{1,6}\d{4,}$/.test(s)) return true // n14157915
  if (/^(TEM\d|GRE|CET\d|IELTS|TOEFL|考研|专[四八])+$/i.test(s)) return true
  if (/^[A-Za-z]+:\s*$/.test(s)) return true // Spoken:
  if (/^以上来源于/.test(s)) return true
  if (/^更多(收起)?结果$/.test(s)) return true
  if (/^jump to other results$/i.test(s)) return true
  if (/^Word Origin/i.test(s)) return true
  return false
}

/** 一行里如果同时有词性和释义（`vt.[俚语]上演(电影)`），拆开 */
function splitPos(line: string): DictSense {
  const s = line.trim()
  const abbr = POS_ABBR.exec(s)
  if (abbr) return { pos: abbr[0].trim(), gloss: s.slice(abbr[0].length).trim() }
  const word = POS_WORD.exec(s)
  if (word && s.length > word[0].length) {
    return { pos: word[0].trim(), gloss: s.slice(word[0].length).trim() }
  }
  return { gloss: s }
}

/**
 * 抽音标。
 *
 * 只在**前几行**里找 —— 靠后的括号多半是例句里的东西。
 * `[brʌnt]` `/brʌnt/` `[,ʌn'spu:l]` 都要认；
 * `[俚语]`（没有音标字符）、`(unspool 的现在分词)`（有中文）都不认。
 */
function findPhonetic(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(0, 6)) {
    for (const m of line.matchAll(/[[/]([^[\]/\n]{2,40})[\]/]/g)) {
      const body = m[1]!.trim()
      if (!body || CJK.test(body)) continue
      if (!IPA.test(body) && !/['ˈ]/.test(body)) continue
      return body
    }
  }
  return undefined
}

/**
 * 把一本词典对一个词的原文，解析成卡片要的那几样。
 *
 * @param raw       词典返回的原文
 * @param headword  实际命中的词目 —— 用来认出「第一行就是词条本身」那一行
 */
export function parseEntry(raw: string, headword = ''): DictParsed {
  const text = String(raw ?? '')
  const out: DictParsed = { senses: [], raw: text }
  if (!text.trim()) return out

  const lines = text.split(/\r?\n/)
  out.phonetic = findPhonetic(lines)

  const hw = headword.trim().toLowerCase()
  const senses: DictSense[] = []
  /** 上一行是光秃秃的词性（`vt.` 自成一行）时，把它接到下一行的释义上 */
  let pending: string | undefined

  for (const line of lines) {
    if (senses.length >= 3) break
    const s = line.trim()
    if (isNoise(s)) continue
    // 第一行通常就是词条本身，不是释义
    if (hw && s.toLowerCase() === hw) continue
    // 整行就是音标
    if (out.phonetic && s.replace(/^[[/]|[\]/]$/g, '').trim() === out.phonetic) continue

    // 光秃秃的词性行：`vt.` / `noun` —— 记下来等下一行
    if (/^(n|v|vt|vi|adj|adv|prep|conj|pron|int|interj|aux|abbr|num|art)\.$/i.test(s)) {
      pending = s
      continue
    }
    if (POS_WORD.test(s) && s.split(/\s+/).length === 1) {
      pending = s
      continue
    }

    const sense = splitPos(s)
    if (!sense.gloss) continue
    /**
     * ★ 太短的不收。像 `n.` 后面跟半个字，或者残留的单个符号 ——
     * 摆到第一屏上他会以为词典只有这么点内容。
     */
    if (sense.gloss.length < 2) continue
    if (pending && !sense.pos) sense.pos = pending
    pending = undefined
    senses.push(sense)
  }

  out.senses = senses
  return out
}
