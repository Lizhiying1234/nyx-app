import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AI_LOOKUP_NOTE, cleanLine, parseAiSections } from './lookup-sections.ts'

/**
 * 查词 → AI 那一档的分节器 · 从 Android 搬进 core（使用者 2026-09-13）
 *
 * ★ 这一套钉的不是「分得好不好看」，是**标签有没有说谎** ——
 *   屏上写着「例句」，底下却是释义，他会按错的类别去记。
 * ★ 喂的字是**真的**：下面那一大段是 2026-09-13 用他自己的 key 查 `counter`
 *   时 DeepSeek 真的回来的那 822 个字符（截了前两节）。
 */

/** 一眼能看懂的形状：`释义｜第一行 ⏎ 第二行` */
function shape(raw: string): string {
  return parseAiSections(raw)
    .map((s) => s.label + '｜' + s.text.replace(/\n/g, ' ⏎ '))
    .join(' ／ ')
}

const REAL = [
  '**释义**',
  '',
  '1. 柜台；吧台（商店、银行等场所的结账或服务台）——最常见，指实体场所里的长条台面。',
  '2. 计数器；计数筹码（用来数数的工具或小物件）。',
  '',
  '**用法**',
  '',
  '- 名词：常与介词 **at / behind / on** 连用，如 *at the counter*（在柜台）。',
  '',
  '**例句**',
  '',
  '1. *She waited at the counter.*（她在柜台前等着。）'
].join('\n')

describe('真的那一段（DeepSeek · counter · 2026-09-13）', () => {
  const secs = parseAiSections(REAL)

  it('分成三节，标签就是模型写的那三个', () => {
    assert.deepEqual(
      secs.map((s) => s.label),
      ['释义', '用法', '例句']
    )
  })

  it('★★ 星号没漏到屏幕上 —— 他看到的是字，不是 Markdown 记号', () => {
    const all = secs.map((s) => s.text).join('\n')
    assert.ok(!all.includes('**'), '正文里还留着 ** —— 「模型管内容、UI 管呈现」没做到')
    assert.ok(all.includes('at / behind / on'), '剥记号把内容也剥掉了')
    assert.ok(all.includes('She waited at the counter.'), '例句里的斜体记号把句子吃了')
  })

  it('标题那一行不会混进正文', () => {
    assert.ok(!secs[0]!.text.startsWith('释义'), '★ 写着「释义」，底下第一句还是「释义」')
  })
})

describe('标题认得出来', () => {
  it('## 释义 / **释义** / 释义： 三种写法都算标题', () => {
    for (const head of ['## 释义', '**释义**', '释义：', '释义']) {
      const s = parseAiSections(head + '\n柜台，指长条台面。')
      assert.equal(s.length, 1, head)
      assert.equal(s[0]!.label, '释义', head)
      assert.equal(s[0]!.text, '柜台，指长条台面。', head)
    }
  })

  it('英文标题归一成中文（Meaning → 释义）', () => {
    assert.equal(shape('Meaning\n柜台，指长条台面。'), '释义｜柜台，指长条台面。')
    assert.equal(shape('Usage: 常与 at 连用，指在柜台前。'), '用法｜常与 at 连用，指在柜台前。')
  })

  it('★ 表里没有的标题**原样留着**，不塌进「释义」', () => {
    // 他改了提示词、起了自己的小节名 —— 这一条就是「提示词可改」的另一半
    assert.equal(
      shape('为什么这句里是这个意思\n因为它跟在介词后面，只能当名词。'),
      '为什么这句里是这个意思｜因为它跟在介词后面，只能当名词。'
    )
  })
})

describe('★★ 短正文不许被当成标题', () => {
  it('「释义 / 弯曲」—— 弯曲是正文，不是下一节的标题', () => {
    // 真机上撞出来的那个：判成标题的话，「释义」那节就空了
    assert.equal(shape('释义\n弯曲'), '释义｜弯曲')
  })

  it('判据是「下一行像不像一句话」，不是「谁更短」', () => {
    // 标题 11 字、正文 9 字 —— 按长度判会判反
    assert.equal(
      shape('为什么这句里是这个意思\n她把事情藏在心里。'),
      '为什么这句里是这个意思｜她把事情藏在心里。'
    )
  })
})

describe('行内标题只认表里的', () => {
  it('释义：内容 —— 认', () => {
    assert.equal(shape('释义：柜台'), '释义｜柜台')
  })

  it('★ 「她说：……」不许被切成一节 —— 这个形状在正文里太常见', () => {
    assert.equal(shape('她说：这件事我来办。'), '释义｜她说：这件事我来办。')
  })
})

describe('认不出结构也得给得出东西', () => {
  it('一整段没有任何标题 → 整体一节「释义」', () => {
    assert.equal(shape('柜台，指商店里那条长台面。'), '释义｜柜台，指商店里那条长台面。')
  })

  it('```围栏``` 剥掉', () => {
    assert.equal(shape('```\n柜台，指长台面。\n```'), '释义｜柜台，指长台面。')
  })

  it('空的 / 不是字符串 → 空数组，**不抛**', () => {
    // 模型偶尔回空。抛的话整张卡崩掉，而这一档本来就排在保底之后
    assert.deepEqual(parseAiSections(''), [])
    assert.deepEqual(parseAiSections('   \n  \n'), [])
    assert.deepEqual(parseAiSections(undefined as unknown as string), [])
    assert.deepEqual(parseAiSections(null as unknown as string), [])
  })
})

describe('cleanLine 只做减法', () => {
  it('剥列表记号与行内记号，字一个不改', () => {
    assert.equal(cleanLine('- **柜台**（`counter`）'), '柜台（counter）')
    assert.equal(cleanLine('1. 计数器'), '计数器')
    assert.equal(cleanLine('2、 计数器'), '计数器')
  })

  /**
   * ★ 已知边界，**故意留着**：序号后面没空格的（`1、计数器`）剥不掉。
   *   搬家这一趟一个判据都不改 —— 改了的话，同一段字在电脑上剥干净、
   *   在手机上还留着序号，而这次搬进 core 要消灭的正是这种「两边都说得通」。
   *   真撞到再一起改，两端同时生效。
   */
  it('序号后面没空格 —— 剥不掉（记在这儿，不是忘了）', () => {
    assert.equal(cleanLine('1、计数器'), '1、计数器')
  })

  it('没有记号的行原样返回', () => {
    assert.equal(cleanLine('她在柜台前等着。'), '她在柜台前等着。')
  })
})

describe('★★ 「可能有误」那一句', () => {
  it('和手机上逐字相同 —— 同一件事不能两个名字', () => {
    assert.equal(AI_LOOKUP_NOTE, 'AI 搜索 · 可能有误')
  })

  it('里面必须有「可能有误」四个字（D-395 同族的诚实原则）', () => {
    assert.ok(AI_LOOKUP_NOTE.includes('可能有误'))
  })
})
