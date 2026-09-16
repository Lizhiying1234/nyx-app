/**
 * 三协议适配 · D-202
 *
 * 「贴上任何 key 都能接」。判定沿用交接文档第五节：
 *   sk-ant- 或域名含 anthropic       → Anthropic
 *   AIza    或含 generativelanguage  → Gemini
 *   其余                             → OpenAI 兼容
 * Base URL **只有光秃秃的域名才补 `/v1`**。
 */

export type Protocol = 'openai' | 'anthropic' | 'gemini'

/** 三组配置 · D-202。默认三组共用一套，见 D-254。 */
export type Slot = 'heavy' | 'light' | 'long'

export const SLOT_NAMES: Record<Slot, string> = {
  heavy: '重任务',
  light: '轻任务',
  long: '长上下文'
}

export const SLOT_DESC: Record<Slot, string> = {
  heavy: '材料分析 · 判层去重 · 四档判分 · 逐处标注 · 攻坚诊断 · 结算总评 · 水平评估',
  light: '摘要级解析 · 分寸辨析 · 例句补充 · 对话摘要压缩 · 题目生成',
  long: '深挖对话 · 任务链 · 文件 Tutorial'
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  protocol: Protocol
  /** 快填的建议模型 —— 只在他点快填且那一格空着时填第一个（`Settings.svelte::applyProvider`），使用者可改 */
  models: string[]
  note?: string
}

/**
 * 服务商快填 · D-202 —— 点一下自动填好 Base URL 与协议
 *
 * ── 这份清单只有一个消费点，别把它当「支持的模型」读 ★★ ────────
 *
 * `main/index.ts` 的 `ai:providers` → 设置页的服务商小按钮 →
 * `Settings.svelte::applyProvider`：**它只在他点那个按钮时才写**，而且
 *
 *     form[slot].baseUrl = p.baseUrl          // 总是填
 *     if (!form[slot].model) form[slot].model = p.models[0] ?? ''   // ★ 空着才填
 *
 * 所以 `models` 是**「他还没填时给个能用的起点」**，不是白名单：
 * 调用层（`core/ai/client.ts`）从不查这份清单，他手填任何模型名都照发。
 * ★ **改这里动不了他已经填好的配置** —— `model` 那一格非空就一个字不碰。
 * `models[0]` 是唯一会被写出去的那个，所以每家的第一个放**通用主力**，
 * 不放最贵的也不放最便宜的。
 *
 * ── 名字会烂，所以每家都写死来源 ★★★ ────────────────────────
 *
 * R-017 记的就是这件事：2026-08-25 那版填的 `gpt-4o` / `moonshot-v1-32k` /
 * `deepseek-chat` 到 2026-09-06 已经全部下线或改名 —— 点一下快填拿到一个
 * **404 的模型名**，而 404 在界面上最容易被读成「key 不对」。
 * 每家下面那行注释是**这一次核对的凭证**：官方文档 URL + 查看日期。
 * 下次再核对时**逐条重开那些 URL**，不要凭记忆改（改错的表现是他配好了却调不通）。
 *
 * ★ 本轮（T-7.2 · 2026-09-06）九家逐一开过官方页核实，无一家靠猜。
 */
export const PROVIDERS: Provider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    // 来源：https://api-docs.deepseek.com/quick_start/pricing 与 /api/list-models（2026-09-06 查）
    // ★ 老的 deepseek-chat / deepseek-reasoner 已经不在 list-models 的返回里了。
    models: ['deepseek-v4-pro', 'deepseek-v4-flash']
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    // 来源：https://developers.openai.com/api/docs/models（2026-09-06 查）
    // 官方把 gpt-6-astra 列为多数用例的起点；gpt-5.6-terra 是「智能与成本平衡」那一档。
    // ★ 老的 gpt-4o / gpt-4o-mini 已经不在清单里。
    models: ['gpt-6-astra', 'gpt-5.6-terra']
  },
  {
    id: 'moonshot',
    name: 'Kimi · 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    // 来源：https://platform.kimi.com/docs/models（2026-09-06 查）；base URL 见 /docs/api/chat，未变
    // ★★ moonshot-v1 全系（含 -32k / -128k）**2026-08-31 下线**，官方让迁到 kimi-k3。
    models: ['kimi-k3', 'kimi-k2.6']
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    // 来源：https://docs.bigmodel.cn/cn/guide/start/model-overview（2026-09-06 查）；base URL 未变
    // glm-5.3 是旗舰；glm-4.7-flash 那一档官方标「免费」。老的 glm-4-plus / glm-4-flash 已不在清单。
    models: ['glm-5.3', 'glm-4.7-flash']
  },
  {
    id: 'dashscope',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    // 来源：https://help.aliyun.com/zh/model-studio/models（2026-09-06 查）
    // ★ 老的 qwen-max / qwen-plus 别名**据称仍能调通**，但官方清单里已经换成带版本号的这几个，
    //   而且指向的是被降级的旧模型 —— 快填给新的。
    // ★ base URL 不动：阿里现在推荐 workspace 专属域名（含 WorkspaceId，快填给不出来），
    //   dashscope.aliyuncs.com 这条按官方说法仍然可用。
    models: ['qwen3.8-max', 'qwen3.7-plus']
  },
  {
    id: 'anthropic',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic',
    // 来源：https://platform.claude.com/docs/en/docs/about-claude/models/overview（2026-09-06 查）
    // claude-sonnet-5 官方描述是「速度与智能的最佳组合」，放第一；claude-opus-5 是复杂任务那一档。
    // ★ 老的 claude-sonnet-4-5 / claude-opus-4-5 仍在「legacy（still available）」里，没有断，但不再是当前款。
    models: ['claude-sonnet-5', 'claude-opus-5']
  },
  {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    // 来源：https://ai.google.dev/gemini-api/docs/models（2026-09-06 查）
    // ★ 老的 gemini-2.5-pro / gemini-2.5-flash **仍在 stable 清单里**（他已经填了的不会坏），
    //   只是不再是最新的一代；快填给当前 stable 里最强的两个 flash。
    //   当前没有 3.x 的 stable pro（gemini-3.1-pro-preview 还是 preview，快填不给 preview）。
    models: ['gemini-3.8-flash', 'gemini-3.5-flash']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    // 来源：https://openrouter.ai/api/v1/models 那份公开清单（2026-09-06 查）；id 形状是 {author}/{slug}
    // ★ 这里抄的是清单里**逐字**的 id（带日期的快照名）——不自己拼无日期的别名，拼错就是 404。
    models: ['anthropic/claude-opus-5-20260723', 'deepseek/deepseek-v4-pro-20260813']
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'openai',
    // 来源：https://ollama.com/library（2026-09-06 查，按 pulls 排序）
    // ★ 这两个**没换**：llama3.1 仍是库里第一（1.19 亿次拉取）、qwen2.5 仍在前六。
    //   本地模型是他自己 pull 下来才有的，快填给的名字必须是库里长期在的那几个 ——
    //   给一个刚出的新名字，他没 pull 过，点了照样调不通。
    models: ['qwen2.5:14b', 'llama3.1:8b'],
    note: '本地跑，不花钱也不联网'
  }
]

/** 自动判协议。使用者仍可手动覆盖（D-202 保留手动协议覆盖）。 */
export function detectProtocol(apiKey: string, baseUrl: string): Protocol {
  const k = apiKey.trim()
  const u = baseUrl.trim().toLowerCase()
  if (k.startsWith('sk-ant-') || u.includes('anthropic')) return 'anthropic'
  if (k.startsWith('AIza') || u.includes('generativelanguage')) return 'gemini'
  return 'openai'
}

/**
 * 规范化 Base URL。
 * 「只有光秃秃域名才补 /v1」—— 已经带了路径的（/api/paas/v4、/compatible-mode/v1）不许动，
 * 补上去会得到一个 404，而 404 会被人误读成「key 不对」。
 */
export function normalizeBaseUrl(raw: string, protocol: Protocol): string {
  let u = raw.trim().replace(/\/+$/, '')
  if (!u) return u
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  if (protocol !== 'openai') return u

  const afterHost = u.replace(/^https?:\/\/[^/]+/i, '')
  if (afterHost === '') return u + '/v1'
  return u
}
