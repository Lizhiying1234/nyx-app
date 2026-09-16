/**
 * 首次引导的记号（SC-25 · D-483）—— 这台设备看过没有。
 *
 * ══ 这个文件只做一件事：往哪张表写 ══════════════════════════
 *
 * **要不要出引导的判据不在这儿**，在 core（`shouldOnboard`）。这里读出来的是
 * 库里那一行的**原值**，一个字都不解释 —— 解释一次，判据就成了两份，
 * 而两份判据坏掉的方式是「手机上还会再弹一次，电脑上不弹」，两边都不报错。
 *
 * ★★ `settings` 是 **DEVICE** 那张表（不在 `SYNC_TABLES` 里，D-355）：
 *   换了台手机该重看一遍 —— 这不是学习数据，不跟着人走。
 *   进偏好白名单就会跟着同步过去，那时「在电脑上看过了」会让手机永远见不到它。
 * ★ 键名从 core 拿（`ui.onboarding.doneAt`）：两端同键。手写第二份 = 给
 *   「换台设备该不该重看」留两个答案。
 */
import { ONBOARDING_KEY } from '../core-link.ts'
import type { Db } from './types.ts'

/**
 * 库里那一行的原值。没设过是 `null`。
 *
 * ★ 不判断、不规整、不给默认 —— 坏值（乱码 · 0 · 负数）原样交给 `shouldOnboard`，
 *   它裁「当没看过」。宁可多出一次引导，也不要因为一个读不懂的值让他永远见不到。
 */
export async function onboardMark(db: Db): Promise<string | null> {
  const r = await db.get(`select value from settings where key = ?`, [ONBOARDING_KEY])
  return r?.['value'] != null ? String(r['value']) : null
}

/**
 * 记下「看过了」。**看完和跳过写同一个值** —— 跳过就是不想看，再弹一次是不尊重他的选择。
 */
export async function setOnboardDone(db: Db, now = Date.now()): Promise<void> {
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [ONBOARDING_KEY, String(now), now]
  )
}

/** 「再看一次新手引导」：把记号删掉，下一次问 `shouldOnboard` 就又该出了 */
export async function clearOnboardMark(db: Db): Promise<void> {
  await db.run(`delete from settings where key = ?`, [ONBOARDING_KEY])
}
