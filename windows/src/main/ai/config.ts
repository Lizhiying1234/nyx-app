import { safeStorage } from 'electron'
import type { Database } from 'better-sqlite3'
import type { Protocol, Slot } from './protocol.ts'
import type { SlotConfig } from './client.ts'
import { Prefs } from '../db/prefs.ts'

/**
 * AI 配置的存取 · D-202 / D-220 / D-254
 *
 * **API key 不明文进数据库**（D-220）：用系统凭据加密（Windows 上是 DPAPI），
 * 库里只存密文。而且 **key 不参与云同步**（D-201）。
 *
 * D-254：界面上默认只有一套配置，三组共用；打开开关才分开配。
 * **分组能力完整保留** —— 开关关闭时保存，把重任务那套复制给另外两组，
 * 调用方完全不必关心自己拿到的是共用的还是单配的。
 */

const SLOTS: Slot[] = ['heavy', 'light', 'long']

export interface SlotSettings {
  baseUrl: string
  model: string
  protocol: Protocol | 'auto'
  /** 只告诉界面「配没配」，**永远不把 key 本身发给界面** */
  hasKey: boolean
}

export interface AiSettings {
  /** 是否为轻任务与长上下文单独配一套 · D-254 */
  split: boolean
  slots: Record<Slot, SlotSettings>
}

function get(db: Database, key: string): string | null {
  const r = db.prepare(`select value from settings where key = ?`).get(key) as
    | { value: string }
    | undefined
  return r?.value ?? null
}

function put(db: Database, key: string, value: string): void {
  const t = Date.now()
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, t)
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function readSettings(db: Database): AiSettings {
  // ★ Step 5A · 「三组分不分开」是他的偏好，跟着人走；地址与模型是设备的，留在 settings
  const split = new Prefs(db).raw('ai.split') === '1'
  const slots = {} as Record<Slot, SlotSettings>
  for (const s of SLOTS) {
    slots[s] = {
      baseUrl: get(db, `ai.${s}.baseUrl`) ?? '',
      model: get(db, `ai.${s}.model`) ?? '',
      protocol: (get(db, `ai.${s}.protocol`) as Protocol | 'auto' | null) ?? 'auto',
      hasKey: !!get(db, `ai.${s}.key`)
    }
  }
  return { split, slots }
}

export interface SaveInput {
  split: boolean
  slots: Record<Slot, { baseUrl: string; model: string; protocol: Protocol | 'auto'; apiKey?: string }>
}

/**
 * 保存。`apiKey` 留空 = 不动已存的那把（界面永远拿不到 key，所以「不动」必须支持）。
 */
export function saveSettings(db: Database, input: SaveInput): AiSettings {
  const tx = db.transaction(() => {
    new Prefs(db).set('ai.split', input.split ? '1' : '0')

    for (const s of SLOTS) {
      // D-254 · 开关关闭时，另外两组直接沿用重任务那套
      const src = input.split ? input.slots[s] : input.slots.heavy
      put(db, `ai.${s}.baseUrl`, src.baseUrl.trim())
      put(db, `ai.${s}.model`, src.model.trim())
      put(db, `ai.${s}.protocol`, src.protocol)

      const key = src.apiKey?.trim()
      if (key) {
        if (!encryptionAvailable()) {
          throw new Error(
            '这台机器上的系统加密不可用，为安全起见不保存 API key。' +
              '（D-220：key 不明文进数据库）'
          )
        }
        put(db, `ai.${s}.key`, safeStorage.encryptString(key).toString('base64'))
      }
    }
  })
  tx()
  return readSettings(db)
}

/** 取出可用于真实调用的配置。**只在主进程里用，绝不返回给界面。** */
export function resolveSlot(db: Database, slot: Slot): SlotConfig {
  const enc = get(db, `ai.${slot}.key`)
  let apiKey = ''
  if (enc) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      apiKey = '' // 解不开就当没配，让 callAi 走「还没有配置 API」那条明确的失败态
    }
  }
  return {
    apiKey,
    baseUrl: get(db, `ai.${slot}.baseUrl`) ?? '',
    model: get(db, `ai.${slot}.model`) ?? '',
    protocol: (get(db, `ai.${slot}.protocol`) as Protocol | 'auto' | null) ?? 'auto'
  }
}

/**
 * 有没有配好到能跑的程度 —— 首页要用它决定显不显示配置引导（D-207）。
 *
 * ★ 2026-09-03 查实：**这个引导从来没建过**，所以这个函数目前零调用方。
 *   它的 IPC 通道 `ai:isConfigured` 已经删掉（死接口），
 *   但函数本身留着 —— 它记录的是 D-207 要的一个**还没做的能力**，不是垃圾。
 *   归「缺失能力」那一档（阶段⑥），到时候要么把引导建起来，要么明确不做再删。
 */
export function isConfigured(db: Database): boolean {
  const c = resolveSlot(db, 'heavy')
  return !!c.apiKey && !!c.baseUrl && !!c.model
}
