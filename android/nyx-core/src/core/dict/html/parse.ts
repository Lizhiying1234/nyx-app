/**
 * 词典 HTML 解析 · D1（2026-08-19）
 *
 * ── 为什么要自己写 ────────────────────────────────────────────
 *
 * ① core/ 里不许碰浏览器环境（`purity.test.ts` 守着那几个全局对象）——
 *    这套解析要在主进程跑，将来还要能搬到 Android，两处都没有 DOM。
 *    注：那道闸是按**源文本**扫的，注释里写出那几个名字也会让它变红；
 *    这不是它的缺陷 —— 判据宽一点、误伤自己一次，好过漏掉一次真的污染。
 * ② 不引依赖，和 `mdict.ts` / `stardict.ts` 同一个做法。
 *
 * ── 真词典的 HTML 有多脏（全部来自实测，不是想象）★★ ─────────
 *
 * 审计时从使用者那 22 本里 dump 出来的原文，逐条踩到过：
 *
 *   `<font color=#DF0101>`          属性值**没有引号**（LDOCE5）
 *   `<img src="x"></img>`           void 元素**带了结束标签**（LDOCE5）
 *   `</x>` `</rx-g>`                **凭空出现的结束标签**，没有对应的开始（OALD10）
 *   `<chn>` `<defT>` `<xT>` `<exat>` 自定义标签，HTML 标准里根本没有
 *   `<O10></O10>`                   空的自定义标签
 *   `<script src="oald10.js">`      要整段丢掉，里面可能有 `<` `>`
 *
 * 所以判据是 **「绝不抛异常，能认多少认多少」**。解析器崩了 = 那本词典整本查不了，
 * 而词典是使用者自己放进来的、我永远见不到全部 —— 宁可结构差一点，不可炸。
 *
 * ── 遇到对不上的结束标签怎么办 ★ ──────────────────────────────
 *
 * 两种错法：
 *   · 照 pop 一层  → `</x>` 会把真正的 `<span class="x">` 弹掉，**后面全部错位**
 *   · 直接忽略     → 结构少一层嵌套，但别的地方都还对
 * 选后者：**栈里找得到才弹，找不到就当没看见**。这是 HTML5 自己的做法，
 * 也是唯一一个「局部脏不会污染全局」的选择。
 */

/** 元素节点。`tag` 一律小写；`attrs` 的键也一律小写 */
export interface ElNode {
  kind: 'el'
  tag: string
  attrs: Readonly<Record<string, string>>
  /** class 属性拆好的集合，省得各处重复拆 */
  classes: readonly string[]
  children: HtmlNode[]
}

export interface TextNode {
  kind: 'text'
  text: string
}

export type HtmlNode = ElNode | TextNode

/** HTML 里不需要结束标签的元素 */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
])

/** 内容是纯文本、里面的 `<` 不算标签的元素 */
const RAW_TEXT = new Set(['script', 'style'])

/**
 * 同名再次出现就把上一个关掉的元素。
 *
 * 词典 HTML 里 `<p>` `<li>` 不写结束标签是常事（21 世纪那本 `p.additional` 有 236 个）。
 * 不处理的话整篇会嵌套成一根几百层深的针，后面按祖先找角色全部失准。
 */
const AUTO_CLOSE = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'option'])

/** 命名实体。只收词典正文里真出现过的那些，不做全表 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  middot: '·',
  bull: '•',
  times: '×',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™'
}

/**
 * 解实体。
 *
 * ★ 顺序很重要：`&amp;lt;` 应该解成字面的 `&lt;`，不是 `<`。
 *   一次扫描、每个 `&…;` 只解一次，天然满足 —— 千万不要写成
 *   「先 replace &lt; 再 replace &amp;」那种链式，那个顺序反了就会二次解码。
 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const n = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      // 码位非法时原样留着 —— 塞一个 U+FFFD 进去反而更难查
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return whole
      try {
        return String.fromCodePoint(n)
      } catch {
        return whole
      }
    }
    const hit = ENTITIES[body.toLowerCase()]
    return hit ?? whole
  })
}

interface Tag {
  name: string
  attrs: Record<string, string>
  closing: boolean
  selfClosing: boolean
  /** 标签在源串里结束的下一个位置 */
  end: number
}

/**
 * 从 `<` 开始读一个标签。读不出来（比如正文里裸着一个 `<`）返回 null，
 * 调用方会把它当普通文本 —— 这正是「绝不抛异常」的那条判据落地的地方。
 */
function readTag(src: string, at: number): Tag | null {
  let i = at + 1
  const closing = src[i] === '/'
  if (closing) i++
  const nameStart = i
  while (i < src.length && /[a-zA-Z0-9:_-]/.test(src[i]!)) i++
  if (i === nameStart) return null
  const name = src.slice(nameStart, i).toLowerCase()

  const attrs: Record<string, string> = {}
  let selfClosing = false

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++
    if (i >= src.length) break
    if (src[i] === '>') {
      i++
      break
    }
    if (src[i] === '/' && src[i + 1] === '>') {
      selfClosing = true
      i += 2
      break
    }
    // 属性名
    const kStart = i
    while (i < src.length && !/[\s=>/]/.test(src[i]!)) i++
    if (i === kStart) {
      // 卡住了（碰到 `/` 之类的怪字符），往前挪一格免得死循环
      i++
      continue
    }
    const key = src.slice(kStart, i).toLowerCase()
    while (i < src.length && /\s/.test(src[i]!)) i++
    let value = ''
    if (src[i] === '=') {
      i++
      while (i < src.length && /\s/.test(src[i]!)) i++
      const q = src[i]
      if (q === '"' || q === "'") {
        i++
        const vStart = i
        while (i < src.length && src[i] !== q) i++
        value = src.slice(vStart, i)
        i++ // 吃掉引号
      } else {
        // ★ 无引号属性值：`<font color=#DF0101>` —— LDOCE5 真的这么写
        const vStart = i
        while (i < src.length && !/[\s>]/.test(src[i]!)) i++
        value = src.slice(vStart, i)
      }
    }
    attrs[key] = decodeEntities(value)
  }
  return { name, attrs, closing, selfClosing, end: i }
}

function splitClasses(attrs: Record<string, string>): string[] {
  const raw = attrs['class']
  if (!raw) return []
  return raw.split(/\s+/).filter(Boolean)
}

/**
 * 解析一段词典正文。**任何输入都返回一棵树，永远不抛。**
 *
 * 返回的是一个虚拟根节点（`tag: '#root'`），这样调用方不用处理「多个顶层节点」。
 */
export function parseHtml(src: string): ElNode {
  const root: ElNode = { kind: 'el', tag: '#root', attrs: {}, classes: [], children: [] }
  const stack: ElNode[] = [root]
  const top = (): ElNode => stack[stack.length - 1]!

  const pushText = (text: string): void => {
    if (!text) return
    const decoded = decodeEntities(text)
    const kids = top().children
    const last = kids[kids.length - 1]
    // 相邻文本合并 —— 后面按节点判角色时，碎片会让判断变难
    if (last && last.kind === 'text') last.text += decoded
    else kids.push({ kind: 'text', text: decoded })
  }

  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      pushText(src.slice(i))
      break
    }
    if (lt > i) pushText(src.slice(i, lt))

    // 注释 / DOCTYPE / CDATA：整段跳过
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4)
      i = e < 0 ? src.length : e + 3
      continue
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const e = src.indexOf('>', lt)
      i = e < 0 ? src.length : e + 1
      continue
    }

    const tag = readTag(src, lt)
    if (!tag) {
      // 裸的 `<`，当文本
      pushText('<')
      i = lt + 1
      continue
    }
    i = tag.end

    if (tag.closing) {
      /**
       * ★★ 找得到才弹，找不到当没看见。见文件头「遇到对不上的结束标签」。
       * OALD10 的 `brunt` 里就有一个凭空的 `</rx-g>`。
       */
      let hit = -1
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k]!.tag === tag.name) {
          hit = k
          break
        }
      }
      if (hit >= 1) stack.length = hit
      continue
    }

    if (RAW_TEXT.has(tag.name)) {
      // `<script>` / `<style>`：整段吃掉，**不产生任何节点**（连文本都不要）
      const close = src.toLowerCase().indexOf(`</${tag.name}`, i)
      i = close < 0 ? src.length : src.indexOf('>', close) + 1 || src.length
      continue
    }

    if (AUTO_CLOSE.has(tag.name) && top().tag === tag.name) stack.pop()

    const el: ElNode = {
      kind: 'el',
      tag: tag.name,
      attrs: tag.attrs,
      classes: splitClasses(tag.attrs),
      children: []
    }
    top().children.push(el)
    if (!tag.selfClosing && !VOID.has(tag.name)) stack.push(el)
  }

  return root
}

// ── 走树的小工具 ────────────────────────────────────────────────

export function isEl(n: HtmlNode): n is ElNode {
  return n.kind === 'el'
}

/** 深度优先遍历所有元素（不含虚拟根） */
export function* walk(node: ElNode): Generator<ElNode> {
  for (const c of node.children) {
    if (c.kind !== 'el') continue
    yield c
    yield* walk(c)
  }
}

export function hasClass(el: ElNode, cls: string): boolean {
  return el.classes.includes(cls)
}

/** 这棵子树里的纯文本，按原样拼接（不加分隔）。判角色时够用 */
export function textOf(node: HtmlNode): string {
  if (node.kind === 'text') return node.text
  let out = ''
  for (const c of node.children) out += textOf(c)
  return out
}

/** 折叠空白后的文本 —— 比较、判空、当释义用的时候都要它 */
export function tidy(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim()
}
