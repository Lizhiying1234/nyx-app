/**
 * 语音判据 —— **纯函数**：两把开关 + 可用性 + 请求 → 带预算的尝试序列 · D-466
 *
 * 这是「用谁读」的唯一一份答案。两端的执行器（Android App · Assist 引擎 ·
 * Windows 主进程）照它给的序列跑，谁都不再自己决定顺序。
 *
 * ── 顺序是写死的，不是排出来的 ★★ ──────────────────────────
 *
 * 使用者 2026-09-07 定的（D-466 原话）：
 *   · 词典有原生语音时优先用词典语音
 *   · 没有词典语音时用系统语音
 *   · 系统语音是通用兜底
 *
 * 所以这里**没有**「他排的顺序」这个概念了 —— 以前那份有序列表（`tts.sources`）、
 * 那两把「他亲手排过 / 迁移纠过」的记号、那套一次性纠正，随多厂商方案整条撤掉。
 * 少了「顺序」这一个自由度，2026-09-07 那一整天的 I-156（库里一份、界面一份、
 * 谁也不知道对方是什么）在结构上就不可能再发生。
 */

import type {
  SourceId,
  VoiceAttempt,
  VoiceAvailability,
  VoiceKind,
  VoicePlan,
  VoiceRequest,
  VoiceSkip,
  VoiceSwitches
} from './types.ts'

/**
 * ★★ 词典那一步的硬预算 · 150 ms。
 *
 * 它不是「性能调优」，是**病本身的药**：Assist 慢的最可能解释是
 * 「系统音排在一次全词典扫描之后」，而扫描成本随启用词典数线性增长。
 * 有了这一条，最坏情况下他也只多等 150 ms 就能听到系统音。
 */
export const DICTIONARY_BUDGET_MS = 150

/** 哪些 kind 允许问词典 —— 词典里只有**词头键**，例句 / 整段问了也是白问 */
const DICTIONARY_KINDS: readonly VoiceKind[] = ['word', 'phrase']

/**
 * ★★★ 两个开关都关时说的那一句 —— **界面直接显示它**（D-466：不出声也要说一句）。
 *
 * 写成常量而不是拼在下面：这句话他会看见，改它是改产品文案，
 * 得改在一个找得到的地方，而不是藏在某个三元表达式里。
 *
 * ★★ **不写页名**（主控 2026-09-07）：原来写的是「去『设置 › 声音』打开任意一个」——
 *   「声音」是 Windows 那一页的名字，Android 那一页叫 Speech。这句话两端共用，
 *   照着页名去找的人在手机上会找一个不存在的入口。**共用的话术里不许出现单端的专名。**
 */
export const BOTH_OFF_SAYS =
  '两个开关都关着 —— 词典语音和系统语音都关了，现在没有东西能读。到设置里打开任意一个。'

/**
 * 排出这一次该怎么试。
 *
 * ── 顺序固定：词典 → 系统。三道过滤，顺序不能换 ────────────
 *
 *   ① 关掉的不排        —— 他说不用就是不用
 *   ② kind 分流        —— 例句 / 整段不问词典（词典里只有条目音）
 *   ③ 平台报不可用的不排 —— 事实压过偏好
 *
 * 每一条被跳过的都进 `plan.skipped`，带一句人话 ——
 * 「为什么没用词典音」必须答得出来（不许静默回退）。
 *
 * ── ★★ 「你把它关了」这句话现在是**真话** ────────────────────
 *
 * 2026-09-06 那次事故里，账本对着一个他根本没有入口能打开的来源说
 * 「你把它关了」—— 关它的是迁移。所以当时判据里还带着一个 `origin` 参数，
 * 专门用来决定该不该这么说。D-466 之后**界面上就是这两个开关**，
 * off 只可能是他拨的（或者出厂默认，而出厂默认是开），所以那个参数没了。
 *
 * ── `origin` 为什么不参与选谁读 ────────────────────────────
 *
 * 「从哪儿点的读」不该改变「用谁读」——「AI 搜索里点的读」和
 * 「详情页点的读」听起来必须是同一个声音，否则他会以为坏了。
 */
export function resolve(
  request: VoiceRequest,
  switches: VoiceSwitches,
  availability: VoiceAvailability
): VoicePlan {
  const attempts: VoiceAttempt[] = []
  const skipped: VoiceSkip[] = []

  // ★★ 顺序写死在这里：词典在前、系统在后。这一行就是 D-466 那条规则本身
  for (const id of ['dictionary', 'system'] as const) {
    if (!switches[id]) {
      skipped.push({ source: id, why: '你把它关了' })
      continue
    }
    if (id === 'dictionary' && !DICTIONARY_KINDS.includes(request.kind)) {
      skipped.push({ source: id, why: `词典里只有条目音，${kindSays(request.kind)}不问词典` })
      continue
    }
    if (!availability[id]) {
      skipped.push({ source: id, why: needsSays(id) })
      continue
    }
    attempts.push({ source: id, budgetMs: budgetOf(id), why: whyOf(id, request.kind) })
  }

  return { attempts, skipped, why: whySays(attempts, switches, skipped) }
}

/**
 * 词典那一步有预算，系统那一步没有。
 * ★ 给系统音设预算 = 放弃最后的兜底（见 `types.ts` 上那条注释）。
 */
const budgetOf = (id: SourceId): number | null => (id === 'dictionary' ? DICTIONARY_BUDGET_MS : null)

/** 一步都排不上时说什么 —— **两个都关**要单说，它和「这台机器上用不了」不是一回事 */
function whySays(
  attempts: readonly VoiceAttempt[],
  switches: VoiceSwitches,
  skipped: readonly VoiceSkip[]
): string {
  if (attempts.length > 0) return `按 ${attempts.map((a) => a.source).join(' → ')} 试`
  /**
   * ★★★ 两个开关都关：**他关的**，而且他自己就能打开 —— 所以话要说到「去哪儿开」。
   *   跟「这台机器上没有可用的来源」混成一句的话，他会去找一个不存在的毛病。
   */
  if (!switches.dictionary && !switches.system) return BOTH_OFF_SAYS
  const said = skipped.map((s) => `${s.source}：${s.why}`).join('、')
  return `这台机器上一个可用的朗读来源都没有${said ? `（${said}）` : ''}。`
}

/** 「这台机器上用不了」具体差什么 —— 能说得具体就不说笼统的 */
function needsSays(id: SourceId): string {
  return id === 'dictionary' ? '这台机器上还没接词典发音' : '这台机器上没有可用的语音引擎'
}

const kindSays = (k: VoiceKind): string =>
  k === 'sentence' ? '整句' : k === 'passage' ? '整段' : k

function whyOf(id: SourceId, kind: VoiceKind): string {
  return id === 'dictionary'
    ? `词典里的${kind === 'word' ? '词头' : '条目'}音，最像真人`
    : '系统语音，零配置、永远在'
}

/**
 * 猜这段文字是词 / 短语 / 句子 / 整段。
 *
 * ★ 这是**启发式**，不是判据 —— 调用方知道 kind 时应该自己给。
 *   它只影响「要不要问词典」，猜错的代价上限就是白花一次 150 ms 预算，
 *   或者少问一次词典（照样有系统音）。**不会读不出来。**
 */
const SENTENCE_END = /[.!?。！？]/
export function inferVoiceKind(text: string): VoiceKind {
  const t = text.trim()
  if (t === '') return 'word'
  if (t.length > 200) return 'passage'
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length >= 25) return 'passage'
  if (!/\s/.test(t)) return 'word'
  if (words.length <= 4 && !SENTENCE_END.test(t)) return 'phrase'
  return 'sentence'
}
