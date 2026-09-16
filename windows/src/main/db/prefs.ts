import type { Database } from 'better-sqlite3'
import { checkPrefKey, checkPrefValue, PREF_KEYS, prefUid } from '@core/prefs.ts'

/**
 * 用户偏好的存取 · ★★ Step 5A / F-07 / D-290
 *
 * ── 唯一入口 ────────────────────────────────────────────────
 *
 * 偏好只从这里读、只从这里写。`study.ts` / `params.ts` / `tts.ts` /
 * `ai/config.ts` 四处**全部**改成调它 —— 那四处原来各自 `insert into settings`，
 * 各写一份 upsert，正是「同一件事四种写法」的形状。
 *
 * ── 判据不在这里 ────────────────────────────────────────────
 *
 * 「哪些键算偏好」「值该长什么样」「uid 怎么算」全在 `core/prefs.ts`，
 * 两端共用。这个文件只负责把它们翻译成 SQL。
 */
export class Prefs {
  constructor(private db: Database) {}

  /** 原样读。没设置过返回 `null` —— 和「他清空了」是两回事，调用方自己分 */
  raw(key: string): string | null {
    const r = this.db.prepare(`select value from user_preferences where key = ?`).get(key) as
      | { value: string }
      | undefined
    return r?.value ?? null
  }

  get(key: string, fallback: string): string {
    return this.raw(key) ?? fallback
  }

  /**
   * 写一项。
   *
   * ★ 键与值都先过 `core/prefs.ts` 的判据：不在清单里的、看着像密钥的、
   *   值的形状不对的，一律抛 —— 悄悄写进去的后果是它跟着同步上了云。
   * ★ uid 由键算出来（Step 2 那套 canonical identity），不是随机：
   *   两台设备改同一项落在同一个 uid 上，upsert 正常接管。
   */
  set(key: string, value: string): void {
    const k = checkPrefKey(key)
    if (!k.ok) throw new Error(k.why)
    const v = checkPrefValue(key, value)
    if (!v.ok) throw new Error(v.why)
    const t = Date.now()
    this.db
      .prepare(
        `insert into user_preferences (uid, key, value, created_at, updated_at) values (?, ?, ?, ?, ?)
           on conflict(uid) do update set value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(prefUid(key), key, v.value, t, t)
  }

  /**
   * ★ `del()` 已删除（D-435 / D-436 · 2026-09-02）。
   *   `user_preferences` 是同步表，而删行不立墓碑 —— 删除到不了另一台设备。
   *   唯一的调用点是「还原默认值」，它现在**写默认值**（见 `params.ts::reset`）。
   */

  /** 全部偏好，给自检与测试用 */
  all(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const r of this.db
      .prepare(`select key, value from user_preferences order by key`)
      .all() as { key: string; value: string }[]) {
      out[r.key] = r.value
    }
    return out
  }

  /** 库里有没有清单之外的键 —— 体检与测试用。正常永远是空的 */
  strays(): string[] {
    const known = new Set(PREF_KEYS)
    return (this.db.prepare(`select key from user_preferences`).all() as { key: string }[])
      .map((r) => r.key)
      .filter((k) => !known.has(k))
  }
}
