import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeEntities, hasClass, parseHtml, textOf, tidy, walk, type ElNode } from './parse.ts'

/**
 * 词典 HTML 解析
 *
 * 每一条**畸形输入都来自实测**（审计时从他那 22 本里 dump 出来的原文），
 * 不是想象出来的边界情况。判据只有一条：**绝不抛异常**。
 * 解析器炸了 = 那本词典整本查不了，而词典是他自己放进来的、我永远见不到全部。
 */

const el = (root: ElNode, pred: (e: ElNode) => boolean): ElNode | undefined =>
  [...walk(root)].find(pred)

describe('容错：实测踩到过的畸形写法', () => {
  it('属性值没有引号（LDOCE5 的 <font color=#DF0101>）', () => {
    const r = parseHtml('<font color=#DF0101>noun</font>')
    const f = el(r, (e) => e.tag === 'font')
    assert.equal(f?.attrs['color'], '#DF0101')
    assert.equal(textOf(r), 'noun')
  })

  it('void 元素带了结束标签（LDOCE5 的 <img ...></img>）', () => {
    const r = parseHtml('<a href="x"><img src="snd_uk.png"></img></a> after')
    const img = el(r, (e) => e.tag === 'img')
    assert.equal(img?.attrs['src'], 'snd_uk.png')
    // `</img>` 不该把 <a> 弹掉 —— 弹掉的话 "after" 会跑到 <a> 外面/里面的错误位置
    assert.equal(tidy(textOf(r)), 'after')
    const a = el(r, (e) => e.tag === 'a')
    assert.ok(a, '<a> 还在')
  })

  /**
   * ★★ 这条是解析器最关键的一条。
   *
   * OALD10 的 `brunt` 原文里有一个凭空的 `</rx-g>`（没有对应的开始标签）。
   * 照着 pop 一层的话，会把真正的 `<span class="x">` 弹掉，**后面全部错位**。
   */
  it('凭空的结束标签被忽略，不会弹掉真正的祖先（OALD10 的 </rx-g>）', () => {
    const r = parseHtml('<span class="x">例句</span></rx-g><span class="def">释义</span>')
    const spans = [...walk(r)].filter((e) => e.tag === 'span')
    assert.equal(spans.length, 2)
    assert.ok(hasClass(spans[0]!, 'x'))
    assert.ok(hasClass(spans[1]!, 'def'))
    // 两个 span 都该是根的直接孩子，谁也没被吞进谁里面
    assert.equal(r.children.filter((c) => c.kind === 'el').length, 2)
  })

  it('自定义标签（chn / defT / exat / O10）照常成树', () => {
    const r = parseHtml('<defT><chn>中文</chn></defT><O10></O10>')
    assert.ok(el(r, (e) => e.tag === 'chn'))
    assert.ok(el(r, (e) => e.tag === 'deft'), '标签名统一小写')
    assert.ok(el(r, (e) => e.tag === 'o10'))
  })

  it('<script> / <style> 整段丢掉，里面的 < > 不当标签', () => {
    const r = parseHtml('<script src="oald10.js">if (a < b) { x() }</script><b>留下</b>')
    assert.equal(el(r, (e) => e.tag === 'script'), undefined)
    assert.equal(tidy(textOf(r)), '留下')
  })

  it('<p> 不写结束标签时不会嵌成一根深针（21世纪那本 236 个 p.additional）', () => {
    const r = parseHtml('<p>一</p><p>二<p>三<p>四')
    const ps = [...walk(r)].filter((e) => e.tag === 'p')
    assert.equal(ps.length, 4)
    for (const p of ps) {
      assert.equal([...walk(p)].filter((e) => e.tag === 'p').length, 0, '<p> 不该套 <p>')
    }
  })

  it('正文里裸着一个 < 当普通文本', () => {
    const r = parseHtml('a < b and c > d')
    assert.equal(textOf(r), 'a < b and c > d')
  })

  it('标签没闭合、文件被截断 —— 不抛，能认多少认多少', () => {
    for (const bad of ['<div class="entry"><span>没写完', '<div', '<<<>>>', '</>', '<a href="', '']) {
      assert.doesNotThrow(() => parseHtml(bad), `炸在：${JSON.stringify(bad)}`)
    }
  })

  it('未结束的标签不会死循环', () => {
    const r = parseHtml('<div ///// class=')
    assert.ok(r)
  })
})

describe('实体', () => {
  it('常见命名实体与数字实体', () => {
    assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>')
    assert.equal(decodeEntities('&#10;'), '\n')
    assert.equal(decodeEntities('&#x41;'), 'A')
    assert.equal(decodeEntities('&amp;'), '&')
  })

  /**
   * ★ 两步分工，别在解码这一步就把空白归一掉：
   *   解码**忠于 HTML**（`&nbsp;` 就是 U+00A0），
   *   归一交给 `tidy` / `toStructuredText`。
   * 合成一步的话，「这里本来是不断行空格」这个事实在第一步就没了 ——
   * 而词典里 `&nbsp;` 有时候是**有意义的**（音标与词性之间不许断行）。
   */
  it('&nbsp; 解成真正的 U+00A0，归一是下游的事', () => {
    const decoded = decodeEntities('a&nbsp;b')
    assert.equal(decoded, 'a b')
    assert.equal(tidy(decoded), 'a b')
  })

  /** ★ 一次扫描、每个 `&…;` 只解一次 —— 链式 replace 会把这个解成 `<` */
  it('不二次解码：&amp;lt; 解成字面的 &lt;', () => {
    assert.equal(decodeEntities('&amp;lt;'), '&lt;')
  })

  it('认不出的实体原样留着，不吞', () => {
    assert.equal(decodeEntities('&frobnicate;'), '&frobnicate;')
    assert.equal(decodeEntities('&#999999999;'), '&#999999999;')
  })

  it('属性值里的实体也解（OALD 的 title="… &#10; English"）', () => {
    const r = parseHtml('<a title="brunt&#10;English">x</a>')
    assert.equal(el(r, (e) => e.tag === 'a')?.attrs['title'], 'brunt\nEnglish')
  })
})

describe('class', () => {
  it('多个 class 拆开', () => {
    const r = parseHtml('<a class="sound audio_play_button pron-uk icon-audio">x</a>')
    const a = el(r, (e) => e.tag === 'a')!
    assert.deepEqual([...a.classes], ['sound', 'audio_play_button', 'pron-uk', 'icon-audio'])
    assert.ok(hasClass(a, 'pron-uk'))
    assert.ok(!hasClass(a, 'pron-us'))
  })
})

describe('相邻文本合并', () => {
  it('实体与普通文本不会碎成多个节点', () => {
    const r = parseHtml('a&nbsp;b c')
    assert.equal(r.children.length, 1)
    assert.equal(r.children[0]!.kind, 'text')
  })
})
