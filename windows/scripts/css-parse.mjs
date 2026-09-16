/**
 * 一个够用的 CSS 拆解器 —— 不引任何依赖。
 *
 * 只要做三件事：认注释、认 `@media` 这类带块的 at-rule、认普通规则。
 * 总原型和 global.css 都是手写的平铺 CSS，没有嵌套语法、没有 CSS 变量函数体，
 * 所以不需要一个真正的解析器。**但也不能用正则硬切** ——
 * `content:"{"` 这种字符串里的花括号会把正则切错，而切错的表现是
 * 「明明一样却报不一样」，比不查还糟。所以这里老老实实扫一遍字符。
 */

/** @typedef {{ at: string, selector: string, decls: string[] }} Rule */

/** 去掉注释，但保留字符串里的 `/*`（CSS 里几乎不会出现，稳妥起见还是处理） */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 把一段声明体切成 `prop:value` 数组。分号在字符串或括号里不算分隔符。 */
function splitDecls(body) {
  const out = []
  let cur = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      cur += c
      if (c === '\\') {
        cur += body[i + 1] ?? ''
        i++
      } else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ';' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map(normalizeDecl).filter(Boolean)
}

/**
 * 声明归一化：只吃掉**无意义**的差别（首尾空白、`prop :value` 的空格、末尾分号）。
 * 值里面的空格一律保留 —— `1px solid red` 和 `1px  solid red` 虽然等价，
 * 但真出现这种差别，说明有人手改过，那正是要报出来的东西。
 */
function normalizeDecl(d) {
  const t = d.trim()
  if (!t) return ''
  const i = t.indexOf(':')
  if (i < 0) return t
  return `${t.slice(0, i).trim()}:${t.slice(i + 1).trim()}`
}

/** 选择器归一化：折叠空白、逗号后统一一个空格、组合符两侧去空格 */
function normalizeSelector(sel) {
  return sel
    .replace(/\s+/g, ' ')
    .split(',')
    .map((s) => s.trim().replace(/\s*([>+~])\s*/g, '$1'))
    .filter(Boolean)
    .join(', ')
    .trim()
}

/**
 * 拆成规则数组。`at` 是所在的 at-rule 上下文（如 `@media (max-width:900px)`），
 * 顶层为空串 —— 同一个选择器在不同 media 下是两条不同的规则，不能混为一谈。
 */
export function parseCss(src) {
  const s = stripComments(src)
  /** @type {Rule[]} */
  const rules = []

  /** @param {string} text @param {string} at */
  function walk(text, at) {
    let i = 0
    let buf = ''
    let quote = null
    while (i < text.length) {
      const c = text[i]
      if (quote) {
        buf += c
        if (c === '\\') {
          buf += text[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === quote) quote = null
        i++
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        buf += c
        i++
        continue
      }
      if (c === ';' && buf.trim().startsWith('@')) {
        // `@import` / `@charset` 这类无块 at-rule，原样记一条
        rules.push({ at, selector: buf.trim(), decls: [] })
        buf = ''
        i++
        continue
      }
      if (c === '{') {
        // 找到配对的 `}`
        let depth = 1
        let j = i + 1
        let q2 = null
        while (j < text.length && depth > 0) {
          const d = text[j]
          if (q2) {
            if (d === '\\') j++
            else if (d === q2) q2 = null
          } else if (d === '"' || d === "'") q2 = d
          else if (d === '{') depth++
          else if (d === '}') depth--
          j++
        }
        const head = buf.trim()
        const body = text.slice(i + 1, j - 1)
        buf = ''
        i = j
        if (head.startsWith('@') && /^@(media|supports|layer|container|scope)\b/.test(head)) {
          walk(body, `${at} ${head.replace(/\s+/g, ' ')}`.trim())
        } else if (head.startsWith('@')) {
          // @keyframes / @font-face —— 整块当成一条，内容原样比对
          rules.push({ at, selector: head.replace(/\s+/g, ' '), decls: [body.replace(/\s+/g, ' ').trim()] })
        } else {
          rules.push({ at, selector: normalizeSelector(head), decls: splitDecls(body) })
        }
        continue
      }
      buf += c
      i++
    }
  }

  walk(s, '')
  return rules
}

/** 规则的身份：上下文 + 选择器。同一身份可以出现多次（后面的覆盖前面的）。 */
export const keyOf = (r) => `${r.at}||${r.selector}`
