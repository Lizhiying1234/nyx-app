import type { DictionaryCapability } from '@core/dict/capability.ts'
import { decodeEntry } from '@core/dict/decode/html-entry.ts'
import type { RichDictionaryEntry } from '@core/dict/entry.ts'
import { sanitizeDictCss, sanitizeDictHtml } from '@core/dict/html/sanitize.ts'
import { lookup as coreLookup, type CandidateKind } from '@core/dict/lookup.ts'
import type { DictionaryRegistry } from './registry.ts'

/**
 * 富词条 · D4.1（2026-08-20）
 *
 * ══ 它和 `lookupCard` 的关系 ★★ ════════════════════════════
 *
 *   `lookupCard`  压平后的文本 + 抽出来的几条释义。**老接口，一个字没动**
 *   `rich`        `RichDictionaryEntry` + 消毒过的原始 HTML + 资源引用
 *
 * 他的要求：「旧接口不要突然删除」。所以两条并存 ——
 * 卡片先用富的那条，出问题时老的那条还在，随时能退回去。
 *
 * ══ 一条原则贯穿始终 ★★★ ═══════════════════════════════════
 *
 *     `text` 是 `html` / 结构化内容的**派生物**，不得反过来。
 *
 * 所以这里的顺序是死的：
 *
 *     raw HTML → decodeEntry → RichDictionaryEntry → （需要时才）text
 *
 * 绝不再出现「先 `toText()` 压平、再从压平的字符串里正则出结构」那条路 ——
 * 音标、发音、插图、对译在压平的那一刻就已经没了。
 *
 * ══ 资源一律只给 ref，不给路径 ★★ ══════════════════════════
 *
 * 消毒把 `<img src="x.png">` 换成 `data-nyx-img="<ref>"`、
 * `sound://x.mp3` 换成 `data-nyx-audio="<ref>"`。渲染层拿着 ref 回来要字节
 *（`dict:resource`），**从头到尾不知道文件在哪**。
 */

/** D3 定的那两档 —— 富词条走的是同一条查词语义，候选词范围也必须一致 */
const KINDS: readonly CandidateKind[] = ['verbatim', 'word']

export interface RichCard {
  /** 他划拉的那串 */
  word: string
  book: { id: number; name: string; uid: string | null } | null
  /** 还有哪几本也收了这个词 */
  others: { id: number; name: string }[]
  /** 默认那本用不了时临时退了一本 —— 说一句 */
  fellBackFrom: string | null
  entry: RichDictionaryEntry | null
  /** 消毒后的词典原始 HTML。**渲染层只把它塞进 Shadow DOM** */
  html: string
  /** 这一条用到的资源引用（渲染层按需去要字节） */
  refs: { audio: string[]; image: string[] }
  /** 这本词典自带的样式表引用（`<link href="x.css">` 那个），没有就是 null */
  styleRef: string | null
  /**
   * 这本词典给的是**纯文本**，不是 HTML（StarDict 的 `m` 类型那些）。
   *
   * ★ 它只影响**怎么呈现**：纯文本要保住它自己的换行，
   *   不能被 HTML 的空白折叠规则揉成一段。
   *   ——「Nyx 不重新解释词典，只安全地呈现词典自己提供的内容」（2026-08-20 定）。
   */
  plain: boolean
  /** 查坏了的原因（跳转转圈之类）。查不到就是 null，两件事不许混 */
  diagnostic: { status: string; says: string } | null
  /**
   * 命中的画像（`oald10` / `ldoce6ec` / `ldoce5` / `c21`），没画像就是 null。
   *
   * ★ 它不是给界面看的，是给**「这份结构可信到什么程度」**用的：
   *   有画像 = D1 逐条量过这本词典的标签含义；没画像 = 通用兜底在猜。
   *   D-150 捞例句只信有画像的那几本，见 `index.ts::richExamples`。
   */
  profileId: string | null
}

/** 空卡片 —— 一本可用的词典都没有 / 他没输入 */
function empty(word: string): RichCard {
  return {
    word,
    book: null,
    others: [],
    fellBackFrom: null,
    entry: null,
    html: '',
    refs: { audio: [], image: [] },
    styleRef: null,
    plain: false,
    diagnostic: null,
    profileId: null
  }
}

/** 词条 HTML 里 `<link rel=stylesheet href="x.css">` 指的那个文件 */
function styleKeyOf(html: string): string | null {
  const m = /<link\b[^>]*href\s*=\s*["']?([^"'\s>]+\.css)["']?[^>]*>/i.exec(html)
  return m ? (m[1] ?? null) : null
}

/**
 * ★★★ T-7.13（I-166）· `others` 那一段**贵得吓人**，所以它可以关掉。
 *
 * 「别的哪几本也有它」是对**其余每一本**各调一次 `match()` —— 而 `match()`
 * 第一次被调到时会把那本书开起来（惰性装载）。于是**一次查词把 22 本全开了**：
 * A 2026-09-07 在他真库上量到第一次 14637 ms，第二次 11 ms，
 * 而换一本没查过的书第一次只要 12 ms —— 慢的从来不是哪一本，是这一段普查。
 *
 * 卡片要它（他要看「哪几本也有」），**朗读不要**：朗读只问默认那一本有没有音。
 */
export interface RichCardOptions {
  /** 要不要顺带问「别的哪几本也有它」。默认要（卡片的老行为一个字没变） */
  others?: boolean
}

export function buildRichCard(
  registry: DictionaryRegistry,
  word: string,
  bookId?: number,
  opts: RichCardOptions = {}
): RichCard {
  const query = word.trim()
  const out = empty(query)
  if (!query) return out

  const usable = registry.usable()
  const def = registry.defaultBook()
  const picked = (bookId ? usable.find((r) => r.id === bookId) : null) ?? def.book
  out.fellBackFrom = def.fellBack && def.wanted ? def.wanted.bookname : null
  if (!picked) return out

  const providers = registry.providersForLookup()
  const mine = providers.find((p) => p.row.id === picked.id)
  out.book = { id: picked.id, name: picked.bookname, uid: mine?.row.uid ?? null }
  if (!mine) return out

  const r = coreLookup([mine.source], query, { maxBooks: 1, kinds: KINDS })
  const hit = r.hits[0]
  if (!hit) {
    if (r.diagnostics.length > 0) {
      const d = r.diagnostics[0]!
      out.diagnostic = { status: d.status, says: d.says }
    }
    return out
  }

  const bookUid = mine.row.uid ?? `local-${mine.row.id}`
  const bookCaps = (mine.row.capabilities ?? []) as DictionaryCapability[]
  const decoded = decodeEntry({
    book: { uid: bookUid, id: picked.id, name: picked.bookname },
    query,
    headword: hit.headword,
    record: hit.record,
    bookCapabilities: bookCaps,
    homographs: hit.homographs
  })

  /**
   * ★ `decodeEntry` 只会在**这条记录本身**是跳转时返回 `redirect` ——
   *   而查词语义那一层已经把跳转跟完了。真到了这里说明跟随漏了一步，
   *   老实返回空，别装作查到了。
   */
  if (decoded.kind !== 'entry') return out

  const entry = decoded.entry
  entry.redirectedFrom = hit.redirectedFrom
  out.entry = entry
  out.profileId = decoded.profileId

  const raw = hit.record.body ?? ''
  /** 这本没给 HTML → 它给的就是纯文本，原样呈现（连换行一起） */
  out.plain = entry.html == null
  const clean = sanitizeDictHtml(entry.html ?? raw, { bookUid })
  out.html = clean.html
  out.refs = clean.refs

  const styleKey = styleKeyOf(raw)
  if (styleKey) out.styleRef = styleKey

  /**
   * 别的哪几本也有它 —— 只问「有没有」，不解析（和老卡片同一条判据）。
   * ★★ T-7.13 · `others: false` 时整段跳过：`match()` 会把每一本都开起来，
   *   而朗读那条路等不起（见上面 `RichCardOptions` 的注释）。
   */
  if (opts.others !== false) {
    for (const p of providers) {
      if (p.row.id === picked.id) continue
      if (p.source.match(entry.headword.toLowerCase()).length > 0) {
        out.others.push({ id: p.row.id, name: p.row.bookname })
      }
    }
  }
  return out
}

/**
 * 这本词典自带的样式表 —— **消毒之后**的。
 *
 * ★ 单独一条路，不跟着每次查词一起送：`oald10.css` 有 186 KB，
 *   而它对同一本词典是不变的，渲染层拿一次缓存起来就够了。
 */
export async function bookStyle(
  registry: DictionaryRegistry,
  bookId: number,
  key: string
): Promise<{ css: string; stripped: number } | null> {
  const row = registry.records().find((r) => r.id === bookId)
  if (!row?.uid) return null
  const bytes = await registry.resource(row.uid, key)
  if (!bytes) return null
  /** 样式表再大也有个头 —— 400 KB 已经比他那 22 本里最大的一份还宽 */
  if (bytes.byteLength > 400 * 1024) return null
  return sanitizeDictCss(Buffer.from(bytes).toString('utf8'))
}

/**
 * 一条资源的字节 → `data:` URI。
 *
 * ══ 为什么是 `data:` ★★ ════════════════════════════════════
 *
 * 他定的：沿用现有 CSP，不加自定义协议、不解压到临时目录、不改 CSP。
 * 一条发音 1.5–13 KB、一张图几十到几百 KB —— 走 `data:` 完全够用，
 * 而且**用完就没了**，不会在磁盘上留下一堆解压出来的临时文件。
 *
 * ══ 上限 ════════════════════════════════════════════════════
 *
 * 他点名要有上限。实测他那 22 本里：发音最大 13 KB，图片最大约 200 KB。
 * 定在音频 8 MB / 图片 4 MB —— 正常内容碰不到，
 * 而一份坏掉的、或者故意做大的资源不会把整个渲染进程撑爆。
 */
export const MEDIA_LIMITS = { audio: 8 * 1024 * 1024, image: 4 * 1024 * 1024, other: 1024 * 1024 }

export function toDataUrl(
  bytes: Uint8Array,
  mime: string | null,
  kind: 'audio' | 'image' | 'other'
): { dataUrl: string } | { tooBig: number } {
  const cap = MEDIA_LIMITS[kind]
  if (bytes.byteLength > cap) return { tooBig: bytes.byteLength }
  const type = mime ?? 'application/octet-stream'
  return { dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}` }
}
