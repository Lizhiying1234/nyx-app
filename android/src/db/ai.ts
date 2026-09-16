/**
 * AI 槽位（Android 装配）—— 客户端/协议/失败态全在 core（同一份），
 * 这里只有「这台手机的配置放在哪」：
 *   · baseUrl / model / protocol → settings `ai.<slot>.*`（本机面，同 Windows 键名）
 *   · **API key → Android Keystore**（D-220 · P1-1 的另一半：加密存放、永不上云，
 *     settings 表里没有它 —— Windows 那侧是 safeStorage 密文进 settings，
 *     手机这侧连密文都不落库）
 * 完整配置界面在阶段 6；judge/generate 现在就要用，键先按同名约定读。
 */
import type { Protocol, Slot, SlotConfig } from '../core-link.ts'
import { prefRaw, prefSet } from './prefs.ts'
import { putSecret, secret } from './secret.ts'
import type { Db } from './types.ts'

/**
 * ★ T-7.6 · 凭据的口子搬进 `db/secret.ts`（**这台手机只有一个**）——
 *   云端朗读那两家的 key 也从同一处过，不再各写一份 `SecureStorage.getItem`。
 *   这两个名字留在这里，是因为引擎端口③ 与三个 ② 层用例都从 `db/ai.ts` 进。
 */
export { __setKeyProviderForTests, setKeyProvider } from './secret.ts'

async function setting(db: Db, key: string): Promise<string | null> {
  const r = await db.get(`select value from settings where key = ?`, [key])
  return r?.['value'] != null ? String(r['value']) : null
}

export async function resolveSlot(db: Db, slot: Slot): Promise<SlotConfig> {
  let apiKey = ''
  try {
    apiKey = (await secret(`ai.${slot}.key`)) ?? ''
  } catch {
    apiKey = '' // Keystore 读不了就当没配 —— callAi 走「还没有配置 API」那条明确失败态
  }
  return {
    apiKey,
    baseUrl: (await setting(db, `ai.${slot}.baseUrl`)) ?? '',
    model: (await setting(db, `ai.${slot}.model`)) ?? '',
    protocol: ((await setting(db, `ai.${slot}.protocol`)) as Protocol | 'auto' | null) ?? 'auto'
  }
}

export async function setSlotKey(slot: Slot, key: string): Promise<void> {
  await putSecret(`ai.${slot}.key`, key)
}

// ══ 三槽配置的读写（D-202 三组 · D-254 默认共用）══════════════
//
// 判据与 Windows `main/ai/config.ts` 逐字同源：
//   · 「分不分开」是**偏好**（跟着人走，user_preferences `ai.split`）；
//     地址/模型/协议是**设备的**（settings），key 在 **Keystore**（D-220）
//   · ★ 关键那条：**关掉分组开关时，保存会把「重任务」那套复制给另外两组** ——
//     于是取配置的那一侧（resolveSlot）永远不必关心自己拿到的是共用还是单配。
//     这也是为什么这里不需要「读的时候合并」的逻辑。

export const AI_SLOTS: Slot[] = ['heavy', 'light', 'long']

export interface SlotSettings {
  baseUrl: string
  model: string
  protocol: Protocol | 'auto'
  /** 只说「配没配」—— key 本身永不回显（D-220） */
  hasKey: boolean
}

export interface AiSettings {
  split: boolean
  slots: Record<Slot, SlotSettings>
}

export async function readAiSettings(db: Db): Promise<AiSettings> {
  const split = (await prefRaw(db, 'ai.split')) === '1'
  const slots = {} as Record<Slot, SlotSettings>
  for (const s of AI_SLOTS) {
    slots[s] = {
      baseUrl: (await setting(db, `ai.${s}.baseUrl`)) ?? '',
      model: (await setting(db, `ai.${s}.model`)) ?? '',
      protocol: ((await setting(db, `ai.${s}.protocol`)) as Protocol | 'auto' | null) ?? 'auto',
      hasKey: await hasSlotKey(s)
    }
  }
  return { split, slots }
}

async function putSetting(db: Db, key: string, value: string): Promise<void> {
  const t = Date.now()
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, t]
  )
}

export interface SlotInput {
  baseUrl: string
  model: string
  protocol: Protocol | 'auto'
  /** 留空 = 不动已存的那把（界面永远拿不到 key，所以「不动」必须支持） */
  apiKey?: string
}

export async function saveAiSettings(
  db: Db,
  input: { split: boolean; slots: Record<Slot, SlotInput> }
): Promise<AiSettings> {
  await prefSet(db, 'ai.split', input.split ? '1' : '0')
  for (const s of AI_SLOTS) {
    const src = input.split ? input.slots[s] : input.slots.heavy // D-254 共用即复制
    await putSetting(db, `ai.${s}.baseUrl`, src.baseUrl.trim())
    await putSetting(db, `ai.${s}.model`, src.model.trim())
    await putSetting(db, `ai.${s}.protocol`, src.protocol)
    const key = src.apiKey?.trim()
    if (key) await setSlotKey(s, key)
  }
  if (!input.split) await fillMissingKeys()
  return readAiSettings(db)
}

/**
 * 共用时，**只把没有 key 的槽补上**（D-254 在这一端的补完）。
 *
 * ★ 为什么需要这一段：Windows 那侧 key 是密文存在 `settings` 里的，属于「配置」
 *   的一部分；这一端 key 在 Keystore，settings 里没有它 —— 上面那个复制循环
 *   只复制得到地址与模型，**key 复制不到**。于是「共用」的三组里会出现
 *   有地址没 key 的槽（真机 2026-08-30 实测：long 就是空的）。
 * ★★ **只补空的，绝不覆盖已有的。** 这条是踩出来的：先写成「一律按重任务那把
 *   覆盖」，结果把 heavy 里留着的旧 `mock-key` 盖到了 light 上，把使用者
 *   真正在用的那把 DeepSeek key **抹掉了**（Keystore 里只有一份，抹了就没了）。
 *   想换 key 只有一条路 —— **他自己填**：填了走上面那个循环，三组一起写。
 * ★ D-220 不受影响：key 从 Keystore 到 Keystore，一次都没经过界面，也没落库。
 */
async function fillMissingKeys(): Promise<void> {
  let heavy = ''
  try {
    heavy = ((await secret('ai.heavy.key')) ?? '').trim()
  } catch {
    return // Keystore 读不了就什么都别做
  }
  if (!heavy) return
  for (const s of AI_SLOTS) {
    if (s === 'heavy') continue
    let cur = ''
    try {
      cur = ((await secret(`ai.${s}.key`)) ?? '').trim()
    } catch {
      return // 读不出来就当它有 —— 宁可不补，也不能覆盖
    }
    if (!cur) await setSlotKey(s, heavy)
  }
}

/** Settings 只显示「已配/没配」—— key 本体不回显（D-220） */
export async function hasSlotKey(slot: Slot): Promise<boolean> {
  try {
    return Boolean(((await secret(`ai.${slot}.key`)) ?? '').trim())
  } catch {
    return false
  }
}

// ③ 档验收通道（同 globalThis.nyx 的纪律）：设置界面在阶段 6，key 先由这里进 Keystore
;(globalThis as Record<string, unknown>)['nyxAi'] = { setSlotKey }
