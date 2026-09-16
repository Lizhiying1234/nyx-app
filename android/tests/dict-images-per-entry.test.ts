/**
 * 钉住一条**真机查出来的 bug**：词典插图要按**词典条目**取，不能跟着书缓存（2026-09-13）
 *
 * ── 病长什么样 ──────────────────────────────────────────────
 * 使用者 2026-09-13：「词典中有些图片资源无法正常显示」。
 * 真机复现（LDOCE5 · 先查 resilient 再查 bicycle）：bicycle 那条词典条目里 6 张图，
 * **5 张是前一条留下的喇叭图标（已内联成 data:），唯独 `bicycle.jpg` 还是原始文件名**
 * —— 于是 WebView 解不了，画成一个灰底破图框。
 *
 * ── 根因 ────────────────────────────────────────────────────
 * `bookAssets()` 第一句是 `const hit = assetCache.get(dict.id); if (hit) return hit` ——
 * 缓存整份按**书**存，把 `html` 参数完全忽略。
 * 可 `images` 是按**词典条目**找的（扫的是这一条里的 `<img src>`）。
 * 于是一本书里你查的**第一条**决定了哪些图这辈子能被内联。
 *
 * ★ 它不是「资源坏了」也不是「图太大」：探针直接问过那本 1.07 GB 的 .mdd ——
 *   `\bicycle.jpg` 在里面，**只有 50 KB**，`bytesOf` 取得出来。
 *   所以任何「把上限调大」「重新扫描词典」的修法都是修错地方。
 *
 * ── 为什么要一道闸 ──────────────────────────────────────────
 * 这个缓存**看起来完全正确**：css 几十～两百 KB，每次查词重解确实浪费。
 * 下一个人很容易为了省事把图一起缓存回去，而且**改完自己测一条词是看不出来的**
 * —— 第一条词条永远是对的。病只在「同一本书的第二条」上出现。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DICT = readFileSync(join(ROOT, 'src/db/dict.ts'), 'utf8')

/** 注释里提这件事是应该的（那正是记录根因的地方），扫之前剥掉 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}
const BODY = stripComments(DICT)

/** 取一个函数的正文（到下一个顶层 `\n}` 为止 —— 这个文件是平铺的顶层函数） */
function bodyOf(name: string): string {
  const i = BODY.indexOf(`function ${name}(`)
  assert.ok(i >= 0, `★ 找不到 ${name}()`)
  const j = BODY.indexOf('\n}', i)
  return BODY.slice(i, j < 0 ? undefined : j)
}

describe('DICT · 插图按词典条目取，不跟着书缓存（2026-09-13 真机 bug）', () => {
  it('① 缓存命中之后仍要补这一条的图 —— 不许裸 return', () => {
    const fn = bodyOf('bookAssets')
    const hit = /if \(hit\)[\s\S]*?\n  \}/.exec(fn)?.[0] ?? ''
    assert.ok(hit.length > 0, '★ 缓存命中那一段不见了')
    assert.match(
      hit,
      /addEntryImages\(/,
      '★ 缓存命中直接 return 了 —— 一本书就只有第一条词典条目的图能出来（原病）'
    )
  })

  it('② 扫 <img> 这件事只许住在 addEntryImages 里', () => {
    const inBook = /<img\[\^>\]\+src=/.test(bodyOf('bookAssets'))
    assert.ok(!inBook, '★ bookAssets 里又开始扫图了 —— 那一段跟着书缓存，第二条就漏')
    assert.match(bodyOf('addEntryImages'), /<img\[\^>\]\+src=/, '★ addEntryImages 不扫图了')
  })

  it('③ 张数上限按**这一条**算，不跟着累积表长', () => {
    const fn = bodyOf('addEntryImages')
    assert.match(fn, /let n = 0/, '★ 计数器没了')
    assert.match(fn, /n >= imgMax\(\)/, '★ 上限判据没了')
    // 计数器必须在函数里初始化 —— 提到模块级就会把后面的词典条目全挡掉
    assert.ok(
      !/^const n = 0|^let n = 0/m.test(BODY.replace(fn, ' ')),
      '★ 计数器跑到函数外面了：累积到 imgMax 之后，后面每一条词典条目都取不到图'
    )
  })

  it('★ ④ 取不到图要说出来 —— 而且「太大」和「没有」是两句不同的话', () => {
    const fn = bodyOf('addEntryImages')
    assert.match(fn, /assetWhy \+=/, '★ 又变回静默跳过了：屏上一个破图框，账上一个字没有')
    assert.match(fn, /超过单张上限/, '★ 「找到了但太大」这一种没说法了')
    assert.match(fn, /资源包里没有这个键/, '★ 「压根没有」这一种没说法了')
    assert.ok(
      /tooBig/.test(fn),
      '★ 两种失败合并成一句了 —— 它们要的动作不一样（调上限 vs 换词典）'
    )
  })
})

describe('DICT · 词典资源的键只许用 core 那一份（2026-09-13 真机 bug）', () => {
  /**
   * 病：词条 HTML 里写 `sound://GB_brelasdebicycle.spx`（大写），
   * .mdd 里存的键是 `\gb_brelasdebicycle.spx`（小写）。
   * `normalizeResourceKey` 会转小写；而发音那两处是**手搓**的
   * `'\' + …split('/').join('\')` —— 一模一样的活，少了转小写那一步，
   * 于是**图是好的、音是坏的**，差别就在那一行。
   * ★ 这正是这个项目一再付学费的那一类：同一件事两份判据。
   */
  it('① 不许手搓 mdd 的键', () => {
    const hand = /const key\s*=\s*'\\'\s*\+/.test(BODY)
    assert.ok(!hand, '★ 又有人手搓 mdd 的键了 —— 走 normalizeResourceKey，它会转小写')
  })

  it('② 音频卷的编号那一位可有可无', () => {
    const fn = bodyOf('soundVolumesOf')
    // 字面比对，不再和正则的转义较劲
    assert.ok(
      !fn.includes(String.raw`/\.\d+\.mdd$/i`),
      '★ 又只认带编号的卷了 —— 使用者那本 LDOCE5 整本只有一个 ….mdd（1.07 GB，' +
        '18.4 万条发音都在里头），这样会说「哪本的卷里都没有」，而那句话是假的'
    )
    assert.ok(
      fn.includes(String.raw`/\.(\d+\.)?mdd$/i`),
      '★ 音频卷的匹配式被改了 —— 编号那一位必须可有可无'
    )
  })
})
