
/**
 * 产出题型 · 使用者 7
 *
 * 「在产出练习时，提供复选框让用户选择题型。题型需要尽量覆盖语言测试的各种形式
 *   （排除中英互译，尽量不出现中文）。题型由系统整理提供，用户多选后生成对应练习。」
 *
 * ── 这里和 D-116 的关系（★ 必须先读懂再改）────────────────────
 *
 * D-116 定的是**五种题型、按难度递进、随训练进度自动升级**；
 * M-027 又要求「连续 3 次正确必然横跨 3 种题型 —— 否则只证明了『我会造句』」。
 * 如果让使用者直接勾「我只要造句」，那 3 次正确就可以全是造句 ——
 * **静默判定当场失效**，而那是这套方法的核心检验。
 *
 * 所以这里不是把五种换成十几种，而是**多加一层**：
 *
 *   · ★ 2026-09-08（D-478）· **档位机制取消**：这里原来写「五个难度档不变，那是机制」，
 *     现在没有档了 —— 题型只有「勾了哪几种、按什么顺序」，一次出几道由他在设置里定
 *   · 每一档下面有若干**同难度的题型变体** —— 那是形式，可以由他挑
 *   · 他勾的是变体。出题仍然按档走，从这一档里**他勾了的**变体中挑
 *
 * 结果：他要的「覆盖各种测试形式」有了，递进和静默判定一个字没动。
 *
 * ── 为什么没有选择题 / 连线题 / 选项式完形填空 ──────────────
 *
 * CLAUDE.md 的绝对约束里点名禁掉了这三种，理由不是保守：
 * **它们测的是认得出，不是写得出。** 而这个软件存在的全部理由，
 * 就是把「读得懂但写不出」变成「写得出」。给四个选项让他挑一个，
 * 恰好绕过了要练的那件事 —— 而且分数还会好看，那是最坏的组合。
 *
 * 「排除中英互译、尽量不出现中文」是他自己提的，和 M-038 / D-157 一致：
 * 所以下面每一种的题面都是英文，中文只在界面说明里出现。
 */

export interface QTypeDef {
  /** 稳定标识，落进 `questions.type`。**老数据里的五个名字原样保留**，不许改 */
  id: string
  /** 界面上显示的名字 */
  name: string
  /** 一句话：这一题让他干什么。给他看的 */
  brief: string
  /** 给提示词的说明。英文 —— 它是要拼进 system 的 */
  guide: string
  /**
   * D-116 原本那五种。★ 2026-09-08 档位取消后它**不再是兜底**
   * （「不兜底」是这一整套的规矩：他一种都没勾就是不出题）——
   * 留着只为标出「这五个是最早那一批」，`builtins` 建库时按它排在前面。
   */
  canonical?: boolean
}

export const QTYPES: QTypeDef[] = [
  // ── 第 1 档 · 先写得出来（1 句）────────────────────────────
  {
    id: '造句',
    name: '造句',
    brief: '给一个场景，用这条知识点写一句',
    guide: 'Give a concrete situation and ask for one sentence using the target expression.',
    canonical: true
  },
  {
    id: '搭配填空',
    name: '搭配填空',
    brief: '句子里空掉搭配的那一半，自己填',
    guide:
      'Write one sentence with the collocating part of the expression left as a blank ' +
      '(e.g. the preposition, or the verb it takes). No options — they write it themselves.',
    canonical: false
  },
  {
    id: '开放填空',
    name: '开放填空',
    brief: '整条挖空，没有选项',
    guide:
      'Write one sentence where the whole target expression is blanked out with underscores, ' +
      'one underscore group per word. Never offer options.',
    canonical: false
  },

  // ── 第 2 档 · 换个说法（1 句）──────────────────────────────
  {
    id: '句子改写',
    name: '句子改写',
    brief: '给一句平淡的，用这条知识点重写',
    guide:
      'Give a flat but correct sentence carrying the same meaning, and ask them to rewrite it ' +
      'using the target expression.',
    canonical: true
  },
  {
    id: '释义改写',
    name: '释义改写',
    brief: '给一句解释性的说法，压缩成这条知识点',
    guide:
      'Give a wordy paraphrase of the idea and ask them to say the same thing more economically ' +
      'with the target expression.',
    canonical: false
  },
  {
    id: '句子合并',
    name: '句子合并',
    brief: '两句并成一句，用上这条知识点',
    guide:
      'Give two short sentences and ask them to combine into one, using the target expression ' +
      'to carry the relation between them.',
    canonical: false
  },

  // ── 第 3 档 · 认出错在哪（1 句）────────────────────────────
  {
    id: '错误订正',
    name: '错误订正',
    brief: '给一句用错的，找出来改对',
    guide:
      'Give one sentence that misuses the expression in a way a learner plausibly would, ' +
      'and ask them to fix it. The error must be in the expression itself, not elsewhere.',
    canonical: true
  },
  {
    id: '语域转换',
    name: '语域转换',
    brief: '同一件事，换一个语域说',
    guide:
      'Give one sentence using the expression in one register and ask them to rewrite it for ' +
      'a different setting (spoken ↔ written, or neutral → academic), keeping the expression apt.',
    canonical: false
  },

  // ── 第 4 档 · 撑住一小段（3 句）────────────────────────────
  {
    id: '限定写作',
    name: '限定写作',
    brief: '三句话，带着约束写',
    guide:
      'Ask for three sentences on a given topic under an explicit constraint ' +
      '(a stance to take, a word to avoid, a structure to use), with the expression carrying weight.',
    canonical: true
  },
  {
    id: '摘要写作',
    name: '摘要写作',
    brief: '把一段压成三句，用上这条知识点',
    guide:
      'Give a short passage (4–6 sentences) and ask them to summarise it in three sentences, ' +
      'using the target expression where it genuinely fits.',
    canonical: false
  },

  // ── 第 5 档 · 完整任务（80–120 词）────────────────────────
  {
    id: '情景任务',
    name: '情景任务',
    brief: '一个真实场景，写 80–120 词',
    guide:
      'Give a realistic writing task (an email, a comment, a short argument) in 80–120 words ' +
      'where the expression is the natural choice, not a bolt-on.',
    canonical: true
  },
  {
    id: '论点应答',
    name: '论点应答',
    brief: '回应一个观点，80–120 词',
    guide:
      'State a position they are likely to disagree with, and ask for an 80–120 word response ' +
      'that concedes something and then pushes back, using the expression to carry the pivot.',
    canonical: false
  }
]

export const ALL_QTYPE_IDS: string[] = QTYPES.map((q) => q.id)


export function qtypeById(id: string): QTypeDef | null {
  return QTYPES.find((q) => q.id === id) ?? null
}
