/**
 * 开发用 Mock AI（OpenAI 兼容 /v1/chat/completions）—— 只为 ④ 层机制验证：
 * 提示词构造 → 三协议调用 → JSON 解析 → 配额过滤 → 落库/判分推进，全链真跑；
 * 唯一假的是「模型的脑子」。判分质量要真模型 —— key 使用者在设置里填（阶段 6 UI）。
 *
 * 行为：
 *   · 生成（user 里有 "Target expression" + "Learner level"）：从 typesBrief 段
 *     逐行抠出 `type must be exactly \`X\``，按档回齐数量 —— 全部合法、配额正中。
 *   · 判分（user 里有 "Their answer"）：作答含目标短语 → 3；再含 "perfectly" → 4；
 *     否则 2 并给一条 annotation（span 取作答的第一个词）。确定性 —— 测试要可复现。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8733)

function mockGenerate(user) {
  const questions = []
  let tier = 0
  for (const line of user.split('\n')) {
    const t = line.match(/\*\*Tier (\d)\*\*/)
    if (t) tier = Number(t[1])
    const m = line.match(/type must be exactly `([^`]+)`/)
    if (m && tier > 0) {
      questions.push({
        tier,
        type: m[1],
        prompt: `[MOCK·T${tier}·${m[1]}] Use the target expression in one natural sentence (${questions.length + 1}).`,
        context: 'original',
        reference: `Mock reference for slot ${questions.length + 1}.`
      })
    }
  }
  return { questions }
}

function mockScore(user) {
  const term = (user.match(/Target expression: \*\*(.+?)\*\*/) ?? [])[1] ?? ''
  const answer = (user.match(/Their answer:\n([\s\S]*?)\n\nA reference answer/) ?? [])[1] ?? ''
  const hasTerm = term && answer.toLowerCase().includes(term.toLowerCase())
  const grade = hasTerm ? (answer.includes('perfectly') ? 4 : 3) : 2
  const firstWord = answer.trim().split(/\s+/)[0] ?? ''
  return {
    grade,
    note: grade >= 3 ? '目标短语用上了，结构成立' : '没用上目标短语',
    why:
      grade >= 3
        ? '（MOCK 判分）句子里出现了目标短语，语序自然。'
        : '（MOCK 判分）这句没有用到目标短语本身 —— 换个说法绕开了它。',
    annotations:
      grade >= 3 || !firstWord
        ? []
        : [{ span: firstWord, label: 'target-missing', problem: '开头就绕开了目标短语', fix: term }]
  }
}

/**
 * 查词（D-401 机制验证）：user 段以「词：」开头。回**纯文本**（查词不走 json 模式），
 * full 的标题形状故意混着来（## / 粗体 / 行内冒号）—— 专门锤展示层整理器。
 */
function mockLookup(all) {
  const term = (all.match(/词：(.+)/) ?? [])[1]?.trim() ?? '?'
  // D-404 · 简明释义（quick）的提示词特征；旧的 short 提示词也认（不要小节标题）
  if (all.includes('只输出释义本身') || all.includes('不要小节标题')) {
    return `灵活的；可变通的（MOCK 简明释义 · ${term}）`
  }
  return [
    '## 释义',
    `（MOCK）「${term}」结合句子的义项解释 —— 完整版。`,
    '',
    '**用法**：常见搭配与词性说明（MOCK）。',
    '',
    '例句：',
    `- This is a mock example with **${term}**.（这是一条 MOCK 例句。）`,
    '',
    '备注：标题形状故意混着来 —— 展示层整理器的验证样本。'
  ].join('\n')
}

const srv = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      const j = JSON.parse(body || '{}')
      const user = (j.messages ?? []).map((m) => m.content).join('\n')
      const isLookup = /(^|\n)词：/.test(user)
      const out = isLookup
        ? mockLookup(user)
        : user.includes('Their answer:')
          ? mockScore(user)
          : mockGenerate(user)
      const kind = isLookup ? 'lookup' : user.includes('Their answer:') ? 'score' : 'generate'
      console.log(
        new Date().toTimeString().slice(0, 8),
        kind,
        kind === 'lookup' ? '' : kind === 'score' ? `grade=${out.grade}` : `${out.questions.length} 题`
      )
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [
            {
              message: { content: isLookup ? out : JSON.stringify(out) },
              finish_reason: 'stop'
            }
          ]
        })
      )
    } catch (e) {
      res.writeHead(500).end(String(e))
    }
  })
})

srv.listen(PORT, '127.0.0.1', () => {
  console.log(`dev-ai（mock）听着 http://127.0.0.1:${PORT}/ —— 判分脑子是假的，机制是真的`)
})
