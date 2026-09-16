/**
 * Assist 接词口（JS 半场）—— 两条通道取到即清：
 *   冷启动：JS 起来后主动 consume()（原生把文本存在 SharePlugin 口袋里）
 *   热启动：原生推 window 'nyxShare' 事件 —— 听到就去掏口袋
 *
 * ★★ D-404① 之后这里**只剩明确的进门动作**（分享 / 选中文本 / 磁贴 /
 *   气泡上的「打开 Nyx ↗」）。气泡的查词与保存**不再经过这里** ——
 *   它们由无障碍服务自己的引擎就地完成（src/engine/main.ts）。
 *   原因写在那个文件头上：RPC 打给 App 的 WebView，就必须 startActivity
 *   才叫得醒它，那就是「查个词被拽回 Nyx」的根因。
 */
import { registerPlugin } from '@capacitor/core'

interface NyxSharePlugin {
  consume(): Promise<{
    text: string | null
    pkg: string | null
    quote?: string | null
    mode?: string | null
  }>
  /** Settings 总开关 → 立即生效（D-400⑨；星随总开关 D-408，不再有单独的 floatIcon） */
  assistConfig(o: { enabled: boolean }): Promise<void>
  /** 无障碍授权状态（选择层的系统前提） */
  assistState(): Promise<{ granted: boolean }>
  openAccessibilitySettings(): Promise<void>
  /** Nyx 自己那一页系统设置（耗电管理 / 自启动）—— T-6.7 */
  openAppSettings(): Promise<void>
}
const NyxShare = registerPlugin<NyxSharePlugin>('NyxShare')

export interface AssistOpen {
  text: string
  pkg: string | null
  /** D-399③ · 词所在完整句子（有就带） */
  quote?: string | null
}

class AssistState {
  open = $state<AssistOpen | null>(null)
  /** 打开时接词（通道③）的原料 —— 开关/去重/英文判定在 App 层（库开了才判） */
  chipRaw = $state<string | null>(null)
  /** 判定通过的小条 */
  chip = $state<string | null>(null)
}
export const assist = new AssistState()

function take(text: unknown, pkg: unknown, quote: unknown, mode: unknown): void {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return
  const p = typeof pkg === 'string' && pkg ? pkg : null
  const q = typeof quote === 'string' && quote.trim() ? quote.trim() : null
  if (mode === 'chip') {
    assist.chipRaw = t
    return
  }
  assist.chip = null
  assist.open = { text: t, pkg: p, quote: q }
}

/** 「像查词的文本」：≤80 字 · 含拉丁词 · 不是光秃秃的链接 */
export function looksLookupable(t: string): boolean {
  if (t.length > 80) return false
  if (/^https?:\/\/\S+$/i.test(t)) return false
  return /[A-Za-z]{2,}/.test(t)
}

async function pull(): Promise<void> {
  try {
    const p = await NyxShare.consume()
    take(p.text, p.pkg, p.quote ?? null, p.mode ?? 'open')
  } catch {
    /* 插件不在（如网页端调试）—— 静默 */
  }
}

export async function startAssistChannel(): Promise<void> {
  // 热启动：原生只摇铃（data 是 CustomEventInit，不携值）—— 听到就去口袋取
  window.addEventListener('nyxShare', () => void pull())
  await pull() // 冷启动：起来先掏一次口袋
}

/** Settings 开关 → 原生（星隐显立即生效，不等下次重启） */
export async function pushAssistConfig(enabled: boolean): Promise<void> {
  try {
    await NyxShare.assistConfig({ enabled })
  } catch {
    /* 静默 */
  }
}

export async function assistGranted(): Promise<boolean | null> {
  try {
    return (await NyxShare.assistState()).granted
  } catch {
    return null // 网页端调试拿不到 —— 界面如实显示「查不到」
  }
}

export async function openA11ySettings(): Promise<void> {
  try {
    await NyxShare.openAccessibilitySettings()
  } catch {
    /* 静默 */
  }
}

/**
 * 打开 Nyx 自己那一页系统设置（T-6.7）—— 耗电管理 / 自启动就在那里。
 * ★ 只打开页面，一个系统设置都不写（见 SharePlugin.openAppSettings 的说明）。
 */
export async function openAppSettings(): Promise<void> {
  try {
    await NyxShare.openAppSettings()
  } catch {
    /* 静默 */
  }
}
