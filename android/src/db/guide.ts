/**
 * 页面内引导的「看过」表（第二层 · 使用者 2026-09-15 第六条）。
 *
 * ══ 这个文件只做一件事：往哪张表写 ══════════════════════════
 *
 * **要不要出的判据不在这儿**，在 core（`shouldShowGuide`）；这张表长什么样
 * 也在 core（`parseGuideSeen` / `noteGuideSeen`）。这里只负责读写那一行。
 * 解释一次就是第二份判据 —— 而它坏掉的样子是「某一条引导在手机上永远不出，
 * 电脑上照常出」，两边都不报错。
 *
 * ★★ `settings` 是 **DEVICE** 那张表（不在 `SYNC_TABLES` 里，D-355）：
 *   和第一层的 `ui.onboarding.doneAt` 同一条规矩 —— 换台设备该重看一遍，
 *   这不是学习数据。进偏好白名单就会跟着同步过去，那时「在电脑上看过了」
 *   会让手机永远见不到它。
 * ★ 键名与形状都从 core 拿（`GUIDE_SEEN_KEY`），本端不写第二份。
 */
import { GUIDE_SEEN_KEY, noteGuideSeen, parseGuideSeen, type GuideSeen } from '../core-link.ts'
import type { Db } from './types.ts'

/**
 * 这台设备哪几条看过了。
 *
 * ★ 坏值（乱码 / 不是 JSON / 值不是数）由 core 的 `parseGuideSeen` 当「没看过」处理，
 *   **绝不抛** —— 这一层只是「多说一句话」，不该因为一行脏数据把整页打不开。
 */
export async function guideSeen(db: Db): Promise<GuideSeen> {
  const r = await db.get(`select value from settings where key = ?`, [GUIDE_SEEN_KEY])
  return parseGuideSeen(r?.['value'] == null ? null : String(r['value']))
}

/**
 * 记一笔「这一条看过了」，记的是**当时那一条的 version**。
 *
 * ★ 先读再写整行：这张表是一个 JSON map，不是一行一条。
 *   并发只可能来自同一个 WebView 的两次点击，够用；真要更强就得给 settings 加行锁，
 *   而那是为了一个「多说一句话」的功能付的过高代价。
 */
export async function markGuideSeen(db: Db, id: string, version: number): Promise<void> {
  const cur = await db.get(`select value from settings where key = ?`, [GUIDE_SEEN_KEY])
  const next = noteGuideSeen(cur?.['value'] == null ? null : String(cur['value']), id, version)
  const t = Date.now()
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [GUIDE_SEEN_KEY, next, t]
  )
}

/** 「把页面引导重新打开」：整张表删掉，七条都会再出一次 */
export async function clearGuideSeen(db: Db): Promise<void> {
  await db.run(`delete from settings where key = ?`, [GUIDE_SEEN_KEY])
}
