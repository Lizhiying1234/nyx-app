/**
 * 查词 → AI 那一档的**呈现整理器** · 两端共用（使用者 2026-09-13）
 *
 * D-401⑦ 的原话：**模型自由生成，UI 负责整理成稳定分节**。
 *
 * ══ 为什么这份东西必须搬进 core ═══════════════════════════════
 * 手机上这一段已经跑了两周（`Nyx-Android/src/db/lookup.ts::parseAiSections`），
 * 而 Windows 今天才接上 AI 那一档。**照抄一份留在 Windows 这边**是最省事的路，
 * 也是最坏的路：同一个模型、同一份提示词，出来的字在电脑上分成四节、
 * 在手机上分成三节 —— 他会以为是模型不稳定，而**两边都说得通、都不报错**。
 * 这和今天把提示词搬进 `lookup-prompt.ts` 是同一条理由，只是换了一层：
 * 提示词管「讲什么」，这一份管「怎么摆」，两层都两端一致，那一句才真的统一。
 *
 * ★ 正文**逐字**搬自 Android 那份（连注释一起），一个判据都没改 ——
 *   那些注释里记着的是真机上撞出来的取舍，改文案就等于把教训擦掉。
 * ★ **交接已完成**（Android `3416d28`，2026-09-13）：那边的
 *   `parseAiSections` / `cleanLine` / `LABEL_MAP` 已改成 import 这里，
 *   本地那三段删了，并加了一道「本仓不许再出现第二份」的闸。
 *   ★ 它不是照 diff 读一遍就签字的：把搬家前那个提交里的旧实现整段抠出来，
 *     和这一份并排跑了 20 组分节输入 + 7 组行内清理（空串 · 纯空白 ·
 *     只有标题没正文 · 自造小节名 · ```json 围栏 · 全角半角冒号混用 ·
 *     多重 Markdown 记号），逐字相同 0 处不一致；再用「对照的对照」确认
 *     那个架子分得出差别（`null` 进去：旧的抛、这一份不抛 —— 就是下面
 *     `String(raw ?? '')` 那一层，严格更宽，不改既有行为）。
 *
 * ★★ **有一样有意没统一：`LookupSection` 那个接口。**
 *   手机那份多 `html?` / `css?`（词典档要按词典自己的结构与样式渲染，D-404⑤），
 *   而 core 这份是它的**子集** —— `parseAiSections` 的返回值放得进去，
 *   所以那边**只换函数、不换接口**。
 *   记在这儿是因为：不记的话，下一个人看到「两端接口不一样」会以为是漏搬，
 *   然后把 `html?` / `css?` 补进 core —— 而那正是下面那段注释要挡的事。
 */

/**
 * 一节。
 * ★ 手机那份接口上还有 `html?` / `css?` 两个字段，那是**词典**那一档用的
 *   （按词典自己的结构渲染，D-404⑤）。AI 这一档只有纯文本，所以这里不带 ——
 *   带着会让人以为 AI 也可能给 HTML，而那一路是绝不能有的（注入面）。
 */
export interface LookupSection {
  readonly label: string
  readonly text: string
}

/**
 * ★★ 这张表是**归一**，不是**白名单**（Android 2026-09-01 改）。
 *
 * 原来它是白名单：不在表里的小节名会掉进默认那一桶（「释义」），
 * 而**标题那行的文字被当成正文的一部分**。屏幕上写着「释义」，
 * 底下第一句却是「为什么这句里是这个意思」—— 真机上当场看出来的。
 *
 * ★ 为什么这是个真缺陷：提示词是**他能改的**（Prompt 专区，两端同一条）。
 *   他一改小节名，分节就全塌进「释义」——「提示词可改」等于只做了一半。
 *   现在：表里有就用标准名（Meaning → 释义），**表里没有就原样用他写的**。
 */
const LABEL_MAP: Record<string, string> = {
  meaning: '释义',
  definition: '释义',
  释义: '释义',
  意思: '释义',
  含义: '释义',
  解释: '释义',
  usage: '用法',
  用法: '用法',
  搭配: '用法',
  词性: '用法',
  example: '例句',
  examples: '例句',
  例句: '例句',
  示例: '例句',
  翻译: '例句',
  note: '备注',
  notes: '备注',
  备注: '备注',
  注意: '备注',
  辨析: '备注',
  语域: '备注',
  发音: '发音',
  pronunciation: '发音'
}

/** 去掉行内 Markdown 噪音（粗体/斜体/行内码/列表记号）—— 内容一字不动 */
export function cleanLine(s: string): string {
  return s
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.、)]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim()
}

/**
 * 模型输出 → 稳定分节。认得的小节标题（独行的 `## 释义` / `**释义**` / `释义：`，
 * 或行内的 `释义：内容`）开新节并归一化标签；认不出结构 → 整体作一节「释义」。
 */
export function parseAiSections(raw: string): LookupSection[] {
  let t = String(raw ?? '').trim()
  t = t.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/, '')
  const out: { label: string; text: string }[] = []
  let cur: { label: string; text: string } | null = null
  const push = (): void => {
    if (cur && cur.text.trim()) out.push({ label: cur.label, text: cur.text.trim() })
    cur = null
  }
  const rows = t.split(/\r?\n/)
  for (let ri = 0; ri < rows.length; ri++) {
    const line0 = rows[ri]!
    const line = line0.trim()
    if (!line) {
      if (cur) cur.text += '\n'
      continue
    }
    // 独行标题：## 释义 · **释义** · 释义： · Meaning:
    const solo = /^(?:#{1,4}\s*)?(?:\*\*)?\s*([A-Za-z一-鿿]{2,14})\s*(?:\*\*)?\s*[:：]?\s*$/.exec(
      line
    )
    const soloKey = solo?.[1]?.toLowerCase() ?? ''
    if (soloKey) {
      /**
       * ★ 表里有就归一，没有就**原样用他写的**（见 LABEL_MAP 的说明）。
       *   独占一行、两到十四个字 —— 这就是「它是个标题」的判据。
       *   ★ 判错的代价是不对称的：把一句正文误当标题，屏幕上多一个小标题；
       *     把标题误当正文，**标签就是错的**（写着「释义」，讲的是别的）。
       *     所以这里偏向认它是标题。
       */
      const known = LABEL_MAP[soloKey]
      /**
       * ★ 表里没有的，还要过一条：**下一行得像正文**。
       *
       *   不加这条，任何短的正文行都会变成小标题 —— 当场撞到过：
       *   「释义 / 弯曲」里的「弯曲」被当成了标题，前一节就空了。
       *
       *   ★ 判据不是「标题比正文短」（Android 先按这个写，当场被自己的用例打脸：
       *     标题「为什么这句里是这个意思」11 字，正文「她把事情藏在心里。」9 字）。
       *     真正分得开的是**下一行像不像一句话**：有句末标点，或者明显更长。
       *     标题后面永远跟着正文；而短正文行后面要么没有东西，要么是另一条短正文。
       */
      // 下一条非空行是什么（判据要用它）
      let next = ''
      for (let k = ri + 1; k < rows.length; k++) {
        const v = rows[k]!.trim()
        if (v) {
          next = v
          break
        }
      }
      const looksLikeBody = /[。．.!！?？；;]$/.test(next) || next.length >= 12
      if (!known && !looksLikeBody) {
        if (!cur) cur = { label: '释义', text: '' }
        cur.text += cleanLine(line) + '\n'
        continue
      }
      push()
      cur = { label: known ?? solo![1]!.trim(), text: '' }
      continue
    }
    // 行内标题：释义：弯曲……（标题与内容同一行）
    const inline = /^(?:\*\*)?([A-Za-z一-鿿]{2,14})(?:\*\*)?[:：]\s*(.+)$/.exec(line)
    const inlineKey = inline?.[1]?.toLowerCase() ?? ''
    /**
     * ★ 行内标题这一档**仍然只认表里的**。
     *   「XX：内容」这个形状在正文里太常见（「她说：……」），放开会把大量正文
     *   切成假小节 —— 与上面那档的取舍相反，理由也相反：这里判错是把正文切碎。
     */
    const inlineKnown = inlineKey ? LABEL_MAP[inlineKey] : undefined
    if (inlineKnown) {
      push()
      cur = { label: inlineKnown, text: cleanLine(inline![2]!) + '\n' }
      continue
    }
    if (!cur) cur = { label: '释义', text: '' }
    cur.text += cleanLine(line) + '\n'
  }
  push()
  if (out.length === 0) {
    const whole = t.split(/\r?\n/).map(cleanLine).filter(Boolean).join('\n')
    if (whole) out.push({ label: '释义', text: whole })
  }
  return out
}

/**
 * ★★ **这段字是 AI 生成的，可能有误** —— 这一句不是装饰。
 *
 * D-395 那条原本说的是 OCR（「结果必须带『可能有误』」），但它守的不是 OCR，
 * 是**别让机器编的东西看起来像查到的**。查词卡上词典正文和 AI 正文挨着摆，
 * 不标的话两段字长得一模一样 —— 他会把模型编的例句当成词典里的例句背下去。
 *
 * ★ 文案与手机上那一档**逐字相同**（`note: 'AI 搜索 · 可能有误'`）：
 *   同一件事在两端叫不同的名字，本身就是这次要消灭的毛病。
 */
export const AI_LOOKUP_NOTE = 'AI 搜索 · 可能有误'
