import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

/**
 * 这台机器的编号 —— **全项目唯一一处** · D-349 ① / D-355 §6.2
 *
 * ══ 为什么要单独拿出来 ★★ ═══════════════════════════════════
 *
 * 它原来是 `main/sync/index.ts` 里的一个私有方法，只有同步用得着：
 * 推包时给包名和包头盖个戳，仅此而已。
 *
 * **V35 之后它多了第二个消费者** —— 学习事实要记「这一条是哪台设备产生的」
 * （`review_logs` / `answers` / `sessions` 的 `device` 列）。
 *
 * 于是它必须搬出来，而且**只能有一份**：
 * 同步包盖的戳和学习事实盖的戳**必须是同一个值**，
 * 否则电脑那边看到的是「A 设备推来的包，里面装着 B 设备产生的记录」——
 * 而这种不一致**不会报错**，只会让事后分析悄悄得出错误结论。
 *
 * ══ ★★ 生成时机改了（D-355 §6.2 ①）════════════════════════
 *
 * 旧行为：**第一次同步时**才生成。
 * 而手机的典型路径恰恰是「**先练几天，之后才配同步**」——
 * 那几天产生的学习事实**没有编号可写**，事后再也补不上。
 *
 * 现在：**第一次需要时**就生成（写学习事实 or 同步，谁先算谁）。
 *
 * ★ 存放位置一个字没改 —— 还是 `settings['sync.device']`。
 *   换个键名会让所有已经在用的库当场变成「新设备」，重推一遍全部数据。
 *
 * ══ 它只是编号，不是设备名 ★ ═══════════════════════════════
 *
 * 8 位随机十六进制，看不出是手机还是电脑。**这是故意的** ——
 * 「哪个编号是哪台设备」由 `nyx/devices/<设备>.json` 那条既有线索回答。
 * 往每一行学习事实里再塞一个设备名，就是同一件事有两份判据。
 */

/** 设备编号在 `settings` 里的键。**不要改它** —— 改了等于所有库都变成新设备。 */
export const DEVICE_KEY = 'sync.device'

/**
 * 拿这台机器的编号；没有就现生成一个。
 *
 * ★ 幂等：生成之后永远不变。
 * ★ 自己失败不许抛 —— 记不上设备来源是**少一列元数据**，
 *   而把一次本来能成的练习或同步带崩是**丢数据**。两者不是一个量级。
 */
export function deviceId(db: Database): string {
  try {
    const row = db.prepare(`select value from settings where key = ?`).get(DEVICE_KEY) as
      | { value: string }
      | undefined
    const has = row?.value?.trim()
    if (has) return has

    const id = randomUUID().slice(0, 8)
    db.prepare(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
    ).run(DEVICE_KEY, id, Date.now())
    return id
  } catch {
    /**
     * 库还没建好、或者正在迁移中途 —— 这两种情况下拿不到编号是正常的。
     * 返回空串，调用方把它当 `null` 写进去：**「不知道」是事实，不要编一个**。
     */
    return ''
  }
}

/** 写进学习事实的那一列 —— 空串统一成 `null`，别在库里留空字符串 */
export const deviceCol = (db: Database): string | null => deviceId(db) || null
