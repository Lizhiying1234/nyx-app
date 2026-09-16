import { isEl, parseHtml, type ElNode, type HtmlNode } from './parse.ts'
import { mediaRef, normalizeResourceKey } from '../media.ts'

/**
 * 词典 HTML 的消毒 · D4（2026-08-20）
 *
 * ══ 这是一道**安全边界**，不是排版工具 ★★★ ═════════════════
 *
 * 词典是**别人做的文件**。他从网上下的 22 本里，`thes.js` 211 KB、
 * `fy.js` 95 KB —— 里面是什么谁也没看过。把那样的 HTML 直接塞进渲染进程，
 * 等于让一份陌生文件在能访问 `nyx` 那座桥的页面里跑代码。
 *（注释里也不写那个全局名 —— `purity.test.ts` 是按字面扫的，
 *  写了会误报，而误报多了那道闸就没人当回事了。）
 *
 * 所以这个文件只做一件事：**把词典 HTML 变成没有执行能力、也不会外联的形状。**
 *
 *   ✗ `<script>`            整块删掉（连同里面的文本）
 *   ✗ `on*` 内联事件         全部剥掉（`onclick` / `onmouseover` / …）
 *   ✗ `javascript:` URL      剥掉
 *   ✗ `http(s)://` 外链       剥掉 —— 一张远程图片就是一次「我在什么时候查了什么词」的外发
 *   ✗ `<iframe>` `<object>` `<embed>` `<link>` `<base>` `<meta>` `<form>`  整块删掉
 *   ✓ 其余标签与 class 原样留着 —— 词典自己的 CSS 全靠它们
 *
 * ══ 资源引用改写成「引用」，不是「路径」★★ ═════════════════
 *
 *   `<img src="brunt.png">`          → `data-nyx-img="<ref>"`，`src` 去掉
 *   `<a href="sound://brunt.mp3">`   → `data-nyx-audio="<ref>"`，`href` 去掉
 *   `<a href="entry://child">`       → `data-nyx-entry="child"`，`href` 去掉
 *
 * `ref` 是 `media.ts::mediaRef` 那套**可逆**编码。渲染层永远只拿 ref，
 * **不知道也拿不到真实文件路径**（他的 D4 第 5 条）。
 *
 * ══ 为什么在 core 里 ═══════════════════════════════════════
 *
 * 它是纯字符串变换，零 I/O、零 DOM —— 两端共用，而且能被单元测试逐条钉死。
 * 安全判据放在能被测试的地方，才不会某天被人「顺手」改松。
 */

/** 整块删掉的标签 —— 里面的内容一并丢弃 */
const DROP = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'link', 'base', 'meta', 'form', 'noscript'])

/** 自闭合标签，序列化时不写闭合标签 */
const VOID = new Set(['br', 'img', 'hr', 'input', 'source', 'track', 'wbr', 'col', 'area'])

/** 允许保留的 URL scheme —— 其余一律剥掉 */
const SAFE_HREF = /^(#|\.\/|\.\.\/)/

export interface SanitizeOptions {
  /** 这本词典的 uid —— 资源 ref 要带上它，不然换本词典就取错资源 */
  bookUid: string
  /**
   * 保留 `style` 属性吗。默认**保留** ——
   * 词典大量用内联样式排版（缩进、颜色），去掉之后版式会散。
   * 内联 `style` 不能执行代码（`expression()` 是 IE 时代的事，Chromium 早就不认）。
   */
  keepInlineStyle?: boolean
}

export interface SanitizeResult {
  html: string
  /** 改写过的资源引用 —— 渲染层按它去要字节 */
  refs: { audio: string[]; image: string[] }
  /** 剥掉了什么，给测试和排查用 */
  stripped: { scripts: number; events: number; external: number; blocked: number }
}

const ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;'
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPE[c] ?? c)
}

function escText(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESCAPE[c] ?? c)
}

/**
 * ★★ 词典 HTML → 可以安全塞进 Shadow DOM 的 HTML。
 *
 * **绝不**在这里做排版决定（隐藏什么、重排什么）—— 那是卡片的事。
 * 这里只管「不许执行、不许外联、资源引用变成 ref」。
 */
export function sanitizeDictHtml(src: string, opts: SanitizeOptions): SanitizeResult {
  const text = src ?? ''
  const root = parseHtml(text)
  const refs = { audio: [] as string[], image: [] as string[] }
  /**
   * ★ 脚本是在**解析那一层**就被吃掉的（`parse.ts` 的 `RAW_TEXT`：
   *   `<script>` / `<style>` 整段不产生任何节点）。所以这里数不到它 ——
   *   得直接看输入。两层都拦是有意的：解析器哪天改了写法，这一层还在。
   */
  const stripped = {
    scripts: (text.match(/<script[\s>]/gi) ?? []).length,
    events: 0,
    external: 0,
    blocked: 0
  }
  const keepStyle = opts.keepInlineStyle !== false

  const refOf = (raw: string): string | null => {
    const key = normalizeResourceKey(raw)
    return key ? mediaRef(opts.bookUid, key) : null
  }

  const attrsOf = (el: ElNode): string => {
    const out: string[] = []
    for (const [rawName, value] of Object.entries(el.attrs)) {
      const name = rawName.toLowerCase()

      // ① 内联事件：一个都不留
      if (name.startsWith('on')) {
        stripped.events++
        continue
      }
      if (name === 'style' && !keepStyle) continue
      /**
       * ★ `srcset` / `background` / `data-src` 这些也能把资源拉起来，
       *   而它们不像 `src` 那样显眼 —— 一律剥掉，宁可少显示一张图。
       */
      if (name === 'srcset' || name === 'background' || name === 'data-src' || name === 'formaction') {
        stripped.external++
        continue
      }

      if (name === 'src' || name === 'href' || name === 'xlink:href') {
        const v = value.trim()
        if (/^javascript:/i.test(v) || /^data:text\/html/i.test(v) || /^vbscript:/i.test(v)) {
          stripped.blocked++
          continue
        }
        if (/^(https?|ftp):\/\//i.test(v) || v.startsWith('//')) {
          // ② 外链一律不加载 —— 那是一次「我什么时候查了什么词」的外发
          stripped.external++
          continue
        }
        if (/^entry:\/\//i.test(v)) {
          const target = v.replace(/^entry:\/*/i, '').split('#')[0]!
          if (target) out.push(`data-nyx-entry="${esc(decodeSafe(target))}"`)
          continue
        }
        if (/^sound:\/\//i.test(v) || (name === 'href' && /\.(mp3|ogg|wav|spx|m4a|aac|flac)$/i.test(v))) {
          const r = refOf(v)
          if (r) {
            out.push(`data-nyx-audio="${esc(r)}"`)
            if (!refs.audio.includes(r)) refs.audio.push(r)
          }
          continue
        }
        if (name === 'src' && el.tag === 'img') {
          const r = refOf(v)
          if (r) {
            out.push(`data-nyx-img="${esc(r)}"`)
            if (!refs.image.includes(r)) refs.image.push(r)
          }
          continue
        }
        // 其余的 href：只留页内锚点与相对路径的**壳**，不留真地址
        if (SAFE_HREF.test(v)) out.push(`${name}="${esc(v)}"`)
        continue
      }

      out.push(value === '' ? name : `${name}="${esc(value)}"`)
    }
    return out.length > 0 ? ' ' + out.join(' ') : ''
  }

  const render = (node: HtmlNode): string => {
    if (!isEl(node)) return escText(node.text)
    const tag = node.tag.toLowerCase()
    if (DROP.has(tag)) {
      if (tag === 'script') stripped.scripts++
      else stripped.blocked++
      return ''
    }
    const attrs = attrsOf(node)
    if (VOID.has(tag)) return `<${tag}${attrs}>`
    const inner = node.children.map(render).join('')
    return `<${tag}${attrs}>${inner}</${tag}>`
  }

  // 根节点是解析器包出来的容器，只渲染它的孩子
  const html = root.children.map(render).join('')
  return { html, refs, stripped }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 词典自带的 CSS 也要消毒。
 *
 * 两件事：
 *   ① `@import` / `url(http…)` 剥掉 —— 同样是外联
 *   ② `}` 之后再补一层作用域是**没必要**的：它进的是 Shadow DOM，
 *      本来就出不去（他的 D4 第 3 条）。所以这里不改选择器，
 *      改了反而会让词典自己的样式失配。
 */
export function sanitizeDictCss(src: string): { css: string; stripped: number } {
  let stripped = 0
  const css = (src ?? '')
    .replace(/@import[^;]*;/gi, () => {
      stripped++
      return ''
    })
    .replace(/url\(\s*["']?\s*(https?:)?\/\/[^)]*\)/gi, () => {
      stripped++
      return 'url()'
    })
    .replace(/expression\s*\(/gi, () => {
      stripped++
      return 'none('
    })
  return { css, stripped }
}
