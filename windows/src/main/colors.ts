import type { Database } from 'better-sqlite3'
import {
  activeTokens,
  decodeModes,
  encodeModes,
  isColorValue,
  type ColorMode,
  type ColorTokens
} from '../core/design/colors.ts'

/**
 * 颜色模式 · 主进程这一半（使用者 2026-09-13「Settings → Resources → Colors」）
 *
 * ══ 存哪儿，为什么 ═══════════════════════════════════════════
 * `settings` 表 —— 它**不在 `SYNC_TABLES` 里**。
 * 他定的是「**Windows 和 Android 的颜色模式不互相同步**，两端分别管理自己的」，
 * 而库里现成就有这条分界：`user_preferences` 进同步、`settings` 不进。
 * 启动页（D-480）走的也是它。**所以这一整个功能没动一个字的同步契约。**
 *
 * ══ 判据不在这儿 ════════════════════════════════════════════
 * 什么叫合法的颜色值、一套配色的形状、增删改 —— 全在 `core/design/colors.ts`，
 * 两端共用。这个文件只做三件主进程才能做的事：
 *   ① 从 `settings` 读 / 写那两行
 *   ② 开窗第一帧的底色（下面那段）
 *   ③ 出错时**不抛**，退回出厂那套
 *
 * ══ ★★ 第一帧底色 —— 这一处是整条链上唯一改不到的地方 ═══════
 * `main/index.ts` 建窗口时要给一个 `backgroundColor`，那一帧在渲染进程
 * 跑起来之前就画出去了，**CSS 令牌那时候还不存在**。
 * 原来那里写死着 `#F4F8F7`（= `--color-bg`），注释自己写着「改令牌要同改这一行」。
 * 他能自己改配色之后，写死的那个值就会**在开窗那一瞬间闪一下旧颜色** ——
 * 时间很短，但那正是「这软件没做完」的观感来源。
 * 所以这里给一个 `windowBg()`：**从他选的那套里取 `--color-bg`**，
 * 取不到就用调用方给的出厂值。
 */

const KEY_MODES = 'colors.modes'
const KEY_ACTIVE = 'colors.active'

/** `--color-bg` —— 第一帧要的就是它 */
export const PAGE_BG_TOKEN = '--color-bg'

function read(db: Database, key: string): string {
  try {
    const r = db.prepare(`select value from settings where key = ?`).get(key) as
      | { value: string }
      | undefined
    return r?.value ?? ''
  } catch {
    return ''
  }
}

function write(db: Database, key: string, value: string): void {
  db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now())
}

/** 他攒下来的那几套。读不出来 → 空数组。**不抛。** */
export function listModes(db: Database | null): ColorMode[] {
  if (!db) return []
  return decodeModes(read(db, KEY_MODES))
}

/** 正在用哪一套。空串 = 出厂那套（Reset to Default 就是把它清成空串）。**不抛。** */
export function activeId(db: Database | null): string {
  if (!db) return ''
  return read(db, KEY_ACTIVE)
}

/**
 * 当前该覆盖哪些 token。没选 / 选的那套没了 → `{}`（= 出厂那套）。
 * ★ 出厂那套的真相**只有 `color-tokens.css` 一份**，这里不存第二份快照。
 */
export function overrides(db: Database | null): ColorTokens {
  if (!db) return {}
  return activeTokens(listModes(db), activeId(db))
}

/**
 * 存那几套。★ **这一处要抛** —— 他刚按了「保存」，存不进去必须当面说
 * （和 `splash.ts::setActiveChoice` 同一条规矩）。
 */
export function saveModes(db: Database, modes: readonly ColorMode[]): void {
  write(db, KEY_MODES, encodeModes(modes))
}

/** 应用某一套 / 重置（传空串）。同上，要抛。 */
export function setActive(db: Database, id: string): void {
  write(db, KEY_ACTIVE, typeof id === 'string' ? id : '')
}

/**
 * 开窗第一帧的底色。
 *
 * @param fallback 出厂值 —— 调用方从 `color-tokens.css` 抄的那一个。
 *   **这个参数不许省**：库读不出来、他没改过底色、值不合法，三种情况下
 *   都得有一个确定的颜色，而「确定」的来源只能是出厂那套。
 */
export function windowBg(db: Database | null, fallback: string): string {
  try {
    const v = overrides(db)[PAGE_BG_TOKEN]
    return isColorValue(v) ? v : fallback
  } catch {
    return fallback
  }
}
