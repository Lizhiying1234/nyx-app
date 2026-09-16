/**
 * 配色模式 —— **设备本地**（`settings` 表，不进 `SYNC_TABLES`）
 *
 * ══ 为什么不同步 ════════════════════════════════════════════
 * 使用者 2026-09-13：「Windows 和 Android 的颜色模式**不互相同步**，
 * 两端分别管理自己的，配色也不需要完全一样」。
 * 这正好落在库里现成的分界上，和启动页那次（D-480）是同一条线：
 *   `settings` 不同步 · `user_preferences` 同步。
 * **同步契约一个字都不用动**，`PREF_KEYS` 也不用动。
 *
 * ══ 「默认模式」为什么不存在库里 ★★ ═══════════════════════
 * 他要的是「回到**最初确定的**默认配色」。存进库的话，换台机器 / 清了数据就没了。
 * 所以默认模式 = **一条 overrides 都没有的那个状态** ——
 * 清掉行内覆盖，页面自然落回样式表里那份出厂值（core 的 color-tokens.css）。
 * 这样「默认」跟着**包**走，永远在，也永远和这一版的出厂配色一致。
 * ☞ 于是 Reset to Default = 切到内置那一档，**不删他建的模式**（那是他的东西）。
 *
 * ══ 只存改过的那几个 ════════════════════════════════════════
 * `overrides` 只放他真的动过的令牌。没动的跟着出厂走 ——
 * 这样以后出厂配色升级，他没动过的部分会自动跟上，而不是被一份旧快照钉死。
 */
import type { Db } from './types.ts'
import { COLOR_TOKENS } from '../ui/lib/color-parts.ts'

const KEY_MODES = 'colors.modes'
const KEY_ACTIVE = 'colors.active'
/** 启动时读的镜像（还没开库就要上色）—— 与启动页那份同一个套路 */
const MIRROR = 'nyx.colors.overrides'

/** 内置那一档的 id —— 它不存在 `modes` 里，是「没有覆盖」这个状态的名字 */
export const DEFAULT_MODE_ID = ''
export const DEFAULT_MODE_NAME = '出厂配色'

export interface ColorMode {
  id: string
  name: string
  /** 令牌名（不带 `--`）→ `#rrggbb`。只放**改过的**。 */
  overrides: Record<string, string>
}

const HEX = /^#[0-9a-fA-F]{6}$/
const TOKENS = new Set(COLOR_TOKENS)

/** 洗一个覆盖表：令牌必须在清单里、值必须是 6 位 HEX。脏的丢掉，不抛。 */
export function cleanOverrides(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!TOKENS.has(k)) continue
    if (typeof v !== 'string' || !HEX.test(v)) continue
    out[k] = v.toLowerCase()
  }
  return out
}

/** 模式名：去两头空白 · 连续空白并一个 · 截到 16 字。空的 → null（调用方给默认名） */
export function cleanModeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (s === '') return null
  return [...s].slice(0, 16).join('')
}

function cleanModes(raw: unknown): ColorMode[] {
  if (!Array.isArray(raw)) return []
  const out: ColorMode[] = []
  for (const m of raw) {
    if (m === null || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const id = typeof o['id'] === 'string' && o['id'] !== '' ? o['id'] : null
    const name = cleanModeName(o['name'])
    if (id === null || name === null) continue
    out.push({ id, name, overrides: cleanOverrides(o['overrides']) })
  }
  return out
}

export async function getColorModes(db: Db): Promise<ColorMode[]> {
  try {
    const r = await db.get(`select value from settings where key = ?`, [KEY_MODES])
    const raw = r?.value
    return typeof raw === 'string' && raw !== '' ? cleanModes(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

export async function saveColorModes(db: Db, modes: ColorMode[]): Promise<void> {
  await put(db, KEY_MODES, JSON.stringify(modes))
}

/** 在用哪一档。读不出来 / 指向一个已经删掉的模式 → 内置那一档。 */
export async function getActiveModeId(db: Db): Promise<string> {
  try {
    const r = await db.get(`select value from settings where key = ?`, [KEY_ACTIVE])
    return typeof r?.value === 'string' ? r.value : DEFAULT_MODE_ID
  } catch {
    return DEFAULT_MODE_ID
  }
}

export async function setActiveModeId(db: Db, id: string): Promise<void> {
  await put(db, KEY_ACTIVE, id)
}

/**
 * 把「现在生效的那份覆盖」抄进镜像。
 * ★ 存不进去只是下次启动先闪一下出厂色，不该让「改配色」这件事失败。
 */
export function writeMirror(overrides: Record<string, string>): void {
  try {
    localStorage.setItem(MIRROR, JSON.stringify(overrides))
  } catch {
    /* 同上 */
  }
}

/** 在用的那一档的覆盖表（内置档 = 空表）—— 应用层只需要这一个函数 */
export async function activeOverrides(db: Db): Promise<Record<string, string>> {
  const id = await getActiveModeId(db)
  if (id === DEFAULT_MODE_ID) return {}
  const m = (await getColorModes(db)).find((x) => x.id === id)
  return m?.overrides ?? {}
}

async function put(db: Db, key: string, value: string): Promise<void> {
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()]
  )
}
