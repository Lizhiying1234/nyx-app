import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeDictCss, sanitizeDictHtml } from './sanitize.ts'
import { parseMediaRef } from '../media.ts'

/**
 * 消毒是**安全边界** —— 这一套的每一条都是「不许发生的事」。
 *
 * 词典是别人做的文件（他那 22 本是从网上下的，`thes.js` 211 KB
 * 里面是什么谁也没看过）。直接塞进渲染进程 = 让陌生代码在能访问
 * `window.nyx` 的页面里跑。
 */

const UID = 'dictionaries-nat-mdict|2.0|UTF-8|OALD10|1|1|1'
const san = (html: string): ReturnType<typeof sanitizeDictHtml> =>
  sanitizeDictHtml(html, { bookUid: UID })

describe('词典 HTML 消毒 · 不许执行', () => {
  it('★★ <script> 整块删掉，连里面的代码一起', () => {
    const r = san('<div>前<script>window.nyx.data.softDelete("project",1)</script>后</div>')
    assert.ok(!r.html.includes('<script'), `还有 script：${r.html}`)
    assert.ok(!r.html.includes('softDelete'), `脚本正文还在：${r.html}`)
    assert.equal(r.html, '<div>前后</div>')
    assert.equal(r.stripped.scripts, 1)
  })

  it('★★ 内联事件一个都不留', () => {
    const r = san('<a onclick="alert(1)" onmouseover="fetch(\'//x\')" class="pron">读</a>')
    assert.ok(!/onclick|onmouseover/i.test(r.html), r.html)
    assert.ok(r.html.includes('class="pron"'), '把该留的 class 也删了')
    assert.equal(r.stripped.events, 2)
  })

  it('★★ javascript: / vbscript: / data:text/html 的 URL 剥掉', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:x', 'data:text/html,<b>']) {
      const r = san(`<a href="${bad}">x</a>`)
      assert.ok(!r.html.includes(bad), `${bad} 还在：${r.html}`)
      assert.ok(r.stripped.blocked >= 1)
    }
  })

  it('★★ 外链不加载 —— 那是一次「我什么时候查了什么词」的外发', () => {
    const r = san('<img src="https://tracker.example/pixel.png"><a href="http://x.com">x</a>')
    assert.ok(!r.html.includes('tracker.example'), r.html)
    assert.ok(!r.html.includes('x.com'), r.html)
    assert.equal(r.stripped.external, 2)
  })

  it('★ srcset / background / data-src 这些不显眼的也剥掉', () => {
    const r = san('<img srcset="//a/b.png 2x" data-src="c.png" background="d.png">')
    assert.ok(!/srcset|data-src|background=/.test(r.html), r.html)
  })

  it('★★ iframe / object / embed / link / base / form 整块删掉', () => {
    const r = san('<div><iframe src="a"></iframe><object></object><form action="x"><input></form>留着</div>')
    assert.equal(r.html, '<div>留着</div>')
  })
})

describe('词典 HTML 消毒 · 资源引用变成 ref', () => {
  it('★★ sound:// → data-nyx-audio，href 不留', () => {
    const r = san('<a href="sound://brunt__gb_1.mp3" class="pron-uk">🔊</a>')
    assert.ok(!r.html.includes('href='), `真地址漏出去了：${r.html}`)
    assert.ok(r.html.includes('data-nyx-audio='), r.html)
    assert.equal(r.refs.audio.length, 1)
    const parsed = parseMediaRef(r.refs.audio[0]!)
    assert.equal(parsed?.bookUid, UID)
    assert.equal(parsed?.key, '\\brunt__gb_1.mp3')
  })

  it('★★ <img src> → data-nyx-img，src 不留（渲染层永远拿不到路径）', () => {
    const r = san('<img src="img/ostrich.png" alt="鸵鸟">')
    assert.ok(!r.html.includes('src='), `路径漏出去了：${r.html}`)
    assert.ok(r.html.includes('alt="鸵鸟"'), '把 alt 也删了')
    assert.equal(parseMediaRef(r.refs.image[0]!)?.key, '\\img\\ostrich.png')
  })

  it('entry:// → data-nyx-entry（D4 不跳转，但也不许它去加载什么）', () => {
    const r = san('<a href="entry://child">child</a>')
    assert.ok(r.html.includes('data-nyx-entry="child"'), r.html)
    assert.ok(!r.html.includes('href='), r.html)
  })

  it('★ 归一失败的引用不造 ref —— 否则界面会多一个点了没反应的按钮', () => {
    const r = san('<a href="sound://"></a><img src="">')
    assert.deepEqual(r.refs, { audio: [], image: [] })
    assert.ok(!r.html.includes('data-nyx-'), r.html)
  })

  it('同一个资源出现两次只记一条 ref', () => {
    const r = san('<a href="sound://a.mp3">1</a><a href="sound://a.mp3">2</a>')
    assert.equal(r.refs.audio.length, 1)
  })
})

describe('词典 HTML 消毒 · 该留的要留住', () => {
  it('★★ 标签、class、嵌套一个不动 —— 词典自己的 CSS 全靠它们', () => {
    const src = '<div class="entry"><span class="pos">noun</span><ol><li class="sense">a</li></ol></div>'
    assert.equal(san(src).html, src)
  })

  it('内联 style 默认留着（词典大量用它排版）', () => {
    assert.ok(san('<span style="color:#a00">x</span>').html.includes('style="color:#a00"'))
    assert.ok(!sanitizeDictHtml('<span style="color:#a00">x</span>', { bookUid: UID, keepInlineStyle: false }).html.includes('style'))
  })

  it('自闭合标签不写闭合', () => {
    assert.equal(san('<p>a<br>b</p>').html, '<p>a<br>b</p>')
  })

  it('文本里的尖括号要转义，不能变成新标签', () => {
    assert.ok(!san('<p>a &lt; b</p>').html.includes('<b>'))
    assert.equal(san('<p>1 < 2</p>').html.includes('&lt;'), true)
  })

  it('空输入不炸', () => {
    assert.equal(san('').html, '')
  })
})

describe('词典 CSS 消毒', () => {
  it('★★ @import 与远程 url() 剥掉', () => {
    const r = sanitizeDictCss('@import url("//evil/x.css");\n.a{background:url(https://x/y.png)}')
    assert.ok(!r.css.includes('@import'), r.css)
    assert.ok(!r.css.includes('evil'), r.css)
    assert.ok(!r.css.includes('https://x'), r.css)
    assert.equal(r.stripped, 2)
  })

  it('★ 选择器一个字不改 —— 它进的是 Shadow DOM，本来就出不去', () => {
    const css = '.entry .pos{color:#900}\n.entry>ol li::before{content:"·"}'
    assert.equal(sanitizeDictCss(css).css, css)
  })

  it('expression() 废掉', () => {
    assert.ok(!/expression\(/.test(sanitizeDictCss('.a{width:expression(alert(1))}').css))
  })
})
