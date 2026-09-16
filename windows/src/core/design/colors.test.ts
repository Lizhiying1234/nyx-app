import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MODES,
  activeTokens,
  addMode,
  cleanName,
  decodeModes,
  editMode,
  encodeModes,
  isColorValue,
  isTokenName,
  newModeId,
  removeMode,
  toMode,
  type ColorMode
} from './colors.ts'

/**
 * 颜色模式的判据 · 使用者 2026-09-13
 *
 * ── 这一套钉的是三件事，都是「出事的时候他看到什么」──────────
 *
 * ① **坏值不许进 CSS**。这些字符串最后走 `style.setProperty()` 落进页面。
 *    `url(...)` 会发网络请求（这一屏的前提是「颜色是本地的事」）；
 *    而写错一个字浏览器**静默丢弃**那条声明 —— 屏上那块保持原样，
 *    他会以为「这个颜色改不动」。**只有闸挡下来才说得出真话。**
 * ② **读不出来不许抛**。配色是从 `settings` 里读出来的一串字，
 *    上一版写的形状随时可能变。最坏的结果该是「回到出厂那套」，
 *    不该是把设置页带崩。
 * ③ **一个坏值不该让他整套配色消失** —— 逐项丢，不是整条丢。
 */

const OK_VALUES = ['#fff', '#ffff', '#F4F8F7', '#38A8B4ff', 'rgb(12, 34, 56)', 'rgba(1,2,3,.5)']
const BAD_VALUES = [
  'url(https://x/y.png)', // ★ 这一条是这道闸存在的第一个理由
  'var(--color-bg)',
  'red',
  'hsl(200 50% 50%)',
  'color-mix(in srgb, red, blue)',
  '#12345', // 5 位，不是合法写法
  '#GGGGGG',
  'rgb(1,2)', // 少一个分量
  '',
  '   ',
  '#fff;background:url(x)', // 想混进第二条声明
  'expression(alert(1))'
]

describe('颜色值这道闸（坏值不许进 CSS）', () => {
  it('★ 认的就这三种写法', () => {
    for (const v of OK_VALUES) assert.ok(isColorValue(v), `应该认：${v}`)
  })

  it('★★★ 不认的一个都不许漏 —— 尤其 url(...)', () => {
    for (const v of BAD_VALUES) assert.ok(!isColorValue(v), `★★ 放进来了：${JSON.stringify(v)}`)
  })

  it('★ 不是字符串的一律不认（从 JSON 里读出来什么都可能）', () => {
    for (const v of [null, undefined, 0, 1, {}, [], true, { toString: () => '#fff' }]) {
      assert.ok(!isColorValue(v), `放进来了：${String(v)}`)
    }
  })

  it('★ token 名同样要验 —— 它也进 CSS', () => {
    for (const n of ['--color-bg', '--btn-pri-bg', '--aqua-500']) assert.ok(isTokenName(n))
    for (const n of ['color-bg', '--Color-BG', '--a b', '--x;y', '', '--', 42, null]) {
      assert.ok(!isTokenName(n), `放进来了：${String(n)}`)
    }
  })
})

describe('存进去、读回来（绝不抛）', () => {
  const mode: ColorMode = {
    id: 'mabc123',
    name: '深一点',
    tokens: { '--color-bg': '#101418', '--color-text': '#E8F3F2' },
    updatedAt: 1700000000000
  }

  it('★ 来回一趟，东西还是那个东西', () => {
    const back = decodeModes(encodeModes([mode]))
    assert.equal(back.length, 1)
    assert.deepEqual(back[0], mode)
  })

  it('★★★ 什么垃圾都不许抛', () => {
    for (const raw of ['', '   ', 'not json', '{}', '[', 'null', '[null,1,"x"]', '{"a":1}', 42, null, undefined]) {
      assert.doesNotThrow(() => decodeModes(raw), `抛了：${String(raw)}`)
      assert.ok(Array.isArray(decodeModes(raw)))
    }
  })

  it('★★ 一个坏颜色只丢那一项，不丢整套', () => {
    const dirty = decodeModes(
      JSON.stringify([
        {
          id: 'mabc123',
          name: '半坏的一套',
          tokens: { '--color-bg': '#101418', '--color-text': 'url(evil)', 'not-a-token': '#fff' },
          updatedAt: 1
        }
      ])
    )
    assert.equal(dirty.length, 1, '★★ 整套被丢掉了 —— 一个坏值不该让他的配色消失')
    assert.deepEqual(dirty[0]!.tokens, { '--color-bg': '#101418' })
  })

  it('★ 没名字 / 没 id 的那一条整条丢掉（它不是一套配色）', () => {
    const out = decodeModes(
      JSON.stringify([
        { id: 'mabc123', name: '   ', tokens: {} },
        { name: '没有 id', tokens: {} },
        { id: 'mzzz999', name: '好的', tokens: {} }
      ])
    )
    assert.deepEqual(out.map((m) => m.id), ['mzzz999'])
  })

  it('★ id 撞了只留第一条', () => {
    const out = decodeModes(
      JSON.stringify([
        { id: 'mabc123', name: '甲', tokens: {} },
        { id: 'mabc123', name: '乙', tokens: {} }
      ])
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.name, '甲')
  })

  it(`★ 最多 ${MAX_MODES} 套，多的不读进来`, () => {
    const many = Array.from({ length: MAX_MODES + 10 }, (_, i) => ({
      id: 'm' + String(i).padStart(5, '0'),
      name: '第 ' + i + ' 套',
      tokens: {}
    }))
    assert.equal(decodeModes(JSON.stringify(many)).length, MAX_MODES)
  })
})

describe('当前涂哪一套', () => {
  const modes: ColorMode[] = [
    { id: 'maaa111', name: '甲', tokens: { '--color-bg': '#111111' }, updatedAt: 1 },
    { id: 'mbbb222', name: '乙', tokens: { '--color-bg': '#222222' }, updatedAt: 2 }
  ]

  it('★ 选中的那一套', () => {
    assert.deepEqual(activeTokens(modes, 'mbbb222'), { '--color-bg': '#222222' })
  })

  it('★★ 认不出来的 id = 出厂那套（空覆盖），不是报错', () => {
    for (const bad of ['', 'mzzz999', null, undefined, 42, {}]) {
      assert.deepEqual(activeTokens(modes, bad), {}, `★ ${String(bad)} 没退回出厂`)
    }
  })

  it('★★★ Reset to Default 就是「把活动 id 清掉」—— 出厂那套的真相只在样式表里，不存第二份', () => {
    assert.deepEqual(activeTokens(modes, ''), {})
  })
})

describe('增删改', () => {
  const now = 1700000000000
  const seq = (start: number) => {
    let n = start
    return () => ((n = (n * 1103515245 + 12345) % 2147483648), n / 2147483648)
  }

  it('★ 加一套，id 是新的', () => {
    const r = addMode([], '我的配色', { '--color-bg': '#fff' }, now, seq(7))
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(r.modes.length, 1)
    assert.equal(r.modes[0]!.name, '我的配色')
    assert.match(r.id, /^m[0-9a-z]{8}$/)
  })

  it('★ 没名字不给建 —— 一排「未命名」他自己也认不出来', () => {
    const r = addMode([], '   ', {}, now)
    assert.ok(!r.ok)
  })

  it(`★ 满 ${MAX_MODES} 套之后要说人话，不是静默失败`, () => {
    const full = Array.from({ length: MAX_MODES }, (_, i) => ({
      id: 'm' + String(i).padStart(5, '0'),
      name: '第 ' + i,
      tokens: {},
      updatedAt: now
    }))
    const r = addMode(full, '再来一套', {}, now)
    assert.ok(!r.ok)
    if (r.ok) return
    assert.match(r.why, new RegExp(String(MAX_MODES)), '★ 那句话里得有那个数，他才知道删几套')
  })

  it('★ 改名不动 id —— 改个名字不该让「正在用的是哪套」失效', () => {
    const base: ColorMode[] = [{ id: 'maaa111', name: '甲', tokens: {}, updatedAt: 1 }]
    const out = editMode(base, 'maaa111', { name: '甲改' }, now)
    assert.equal(out[0]!.id, 'maaa111')
    assert.equal(out[0]!.name, '甲改')
    assert.equal(out[0]!.updatedAt, now)
  })

  it('★ 改一个不存在的 id → 原样返回，不抛', () => {
    const base: ColorMode[] = [{ id: 'maaa111', name: '甲', tokens: {}, updatedAt: 1 }]
    assert.deepEqual(editMode(base, 'mzzz999', { name: 'x' }, now), base)
  })

  it('★ 改名改成空的 → 保住原名，不让它变成没名字的一套', () => {
    const base: ColorMode[] = [{ id: 'maaa111', name: '甲', tokens: {}, updatedAt: 1 }]
    assert.equal(editMode(base, 'maaa111', { name: '   ' }, now)[0]!.name, '甲')
  })

  it('★ 删一套', () => {
    const base: ColorMode[] = [
      { id: 'maaa111', name: '甲', tokens: {}, updatedAt: 1 },
      { id: 'mbbb222', name: '乙', tokens: {}, updatedAt: 1 }
    ]
    assert.deepEqual(removeMode(base, 'maaa111').map((m) => m.id), ['mbbb222'])
    assert.deepEqual(removeMode(base, 'mzzz999').length, 2)
  })
})

describe('名字与 id 的小事', () => {
  it('★ 名字压掉换行和多余空白', () => {
    assert.equal(cleanName('  深  一点\n\n 些 '), '深 一点 些')
    assert.equal(cleanName(null), '')
    assert.equal(cleanName('x'.repeat(200)).length, 40)
  })

  it('★ id 的形状固定 —— toMode 认的就是这个形状', () => {
    const id = newModeId()
    assert.match(id, /^m[0-9a-z]{8}$/)
    assert.ok(toMode({ id, name: 'x', tokens: {} }), '★ 自己发的 id 自己不认，那就永远存不进去')
  })
})
