import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseHtml, type ElNode } from './parse.ts'
import { inlineText, toStructuredText } from './text.ts'

/**
 * 节点树 → 保结构的纯文本
 *
 * ── 这个文件守的是「**没有画像的那 18 本**」★★★ ────────────────
 *
 * 他有 22 本词典，`decode/profiles.ts` 只认得 4 本。剩下 18 本走的是
 * 第 ②/③ 档 —— 而那两档的输入就是这里产出的文本。
 *
 * 换句话说：**画像修得再好，这条规则错了，18 本还是粘成一条。**
 *
 * 判据反过来写（默认成块、白名单是「行内」）的理由：
 *   行内白名单是有限且稳定的（`b i u em strong span a font …`）；
 *   词典自定义的那些（`chn` `defT` `xT` `exat` `deft` `trn`）**全是语义块**，
 *   而它们恰恰是永远列不全的那一类。
 *
 * 两种错法的代价也不对称：多换一行 = 版式松一点；少换一行 = 语义粘死、**不可逆**。
 */

const t = (html: string, opt?: Parameters<typeof toStructuredText>[1]): string =>
  toStructuredText(parseHtml(html), opt)

describe('★ 默认成块：没见过的标签必须换行', () => {
  /**
   * ★★★ 这是实测那条粘连的最小复现。
   *
   * 现行 `mdict.ts::toText()` 的换行判据是块级标签白名单：
   *   `.replace(/<\/(p|div|li|dd|dt|tr|h[1-6])>/gi, '\n')`
   * 而 OALD 的中文挂在 `<chn>` 上、例句挂在 `<span class="x">` 上，
   * 一个都不在白名单里 —— 于是四样东西粘成一条：
   *   `释义承受某事的主要压力Schools will bear…政府削减开支…`
   */
  it('OALD 的 def / chn / x / chn 四样不许粘成一条', () => {
    const html =
      '<span class="def">to receive the main force</span>' +
      '<defT><chn>承受某事的主要压力</chn></defT>' +
      '<span class="x">Schools will bear the brunt.</span>' +
      '<xT><chn>学校将首当其冲。</chn></xT>'
    const out = t(html)
    const lines = out.split('\n').filter(Boolean)
    assert.ok(lines.length >= 3, `应该分开成多行，实际是：\n${out}`)
    for (const l of lines) {
      assert.ok(
        !(/[a-zA-Z]/.test(l) && /[一-鿿]/.test(l)),
        `英文和中文粘在同一行了：${JSON.stringify(l)}`
      )
    }
  })

  it('朗文6 的 EN / TRAN / EXAEN / EXAMPLE 同理', () => {
    const html =
      '<span class="def"><EN>to receive the worst part</EN><TRAN>首当其冲</TRAN></span>' +
      '<span class="example"><EXAEN>The car took the brunt.</EXAEN><EXAMPLE>汽车首当其冲。</EXAMPLE></span>'
    const out = t(html)
    for (const l of out.split('\n').filter(Boolean)) {
      assert.ok(
        !(/[a-zA-Z]/.test(l) && /[一-鿿]/.test(l)),
        `英文和中文粘在同一行了：${JSON.stringify(l)}`
      )
    }
  })

  it('认都没见过的自定义标签也换行（列不全的那一类）', () => {
    const out = t('<frobnicate>一</frobnicate><wibble>二</wibble>')
    assert.deepEqual(out.split('\n').filter(Boolean), ['一', '二'])
  })
})

describe('行内白名单：该在一行的要留在一行', () => {
  it('noun /brʌnt/ 不该被拆成两行', () => {
    const out = t('<span class="pos">noun</span> <span class="phon">/brʌnt/</span>')
    assert.equal(out, 'noun /brʌnt/')
  })

  it('b / i / u / font / a / sup 都是行内', () => {
    const out = t('<b>a</b><i>b</i><u>c</u><font color=red>d</font><a href="x">e</a><sup>f</sup>')
    assert.equal(out, 'abcdef')
  })

  it('<br> 换行', () => {
    assert.equal(t('a<br>b'), 'a\nb')
  })

  it('块级标签之间空一行', () => {
    assert.equal(t('<div>a</div><div>b</div>'), 'a\n\nb')
  })
})

describe('isBlock 钩子：画像可以把语义 span 标成块', () => {
  /**
   * `<span>` 在词典里两种用法都有：`span.pos` + `span.phon` 该同行，
   * 而 `span.def` / `span.x` 各自该独占一行。光看标签名分不出来。
   */
  it('默认 span 行内，画像标了就成块', () => {
    const html = '<span class="def">one</span><span class="def">two</span>'
    assert.equal(t(html), 'onetwo')
    const withHook = t(html, {
      isBlock: (el: ElNode) => (el.classes.includes('def') ? true : undefined)
    })
    assert.deepEqual(withHook.split('\n').filter(Boolean), ['one', 'two'])
  })

  it('钩子返回 undefined 时落回默认判据', () => {
    const out = t('<frobnicate>x</frobnicate><b>y</b>', { isBlock: () => undefined })
    assert.deepEqual(out.split('\n').filter(Boolean), ['x', 'y'])
  })

  it('钩子可以把块强行压成行内', () => {
    assert.equal(t('<div>a</div><div>b</div>', { isBlock: () => false }), 'ab')
  })
})

describe('skip：整棵子树都不要', () => {
  it('噪声子树连同它的孩子一起丢掉', () => {
    const out = t('<div>留下</div><div class="junk">丢掉<span>连孩子一起</span></div>', {
      skip: (el) => el.classes.includes('junk')
    })
    assert.equal(out, '留下')
  })
})

describe('空白处理', () => {
  it('行内空白折成一个空格，换行不动', () => {
    assert.equal(t('<div>a   \t  b</div><div>c</div>'), 'a b\n\nc')
  })

  it('连续空行最多留一个', () => {
    assert.equal(t('<div>a</div><div></div><div></div><div>b</div>'), 'a\n\nb')
  })

  it('&nbsp; 在这一层被归一成普通空格', () => {
    assert.equal(t('<div>a&nbsp;&nbsp;b</div>'), 'a b')
  })
})

describe('inlineText', () => {
  it('整棵子树拼成一行，折叠空白', () => {
    const root = parseHtml('<span class="def">to   receive<b> the</b>\n main force</span>')
    assert.equal(inlineText(root), 'to receive the main force')
  })

  it('块级标签也不换行 —— 它是给「取一个字段的值」用的', () => {
    const root = parseHtml('<div>a</div><div>b</div>')
    assert.equal(inlineText(root), 'ab')
  })
})
