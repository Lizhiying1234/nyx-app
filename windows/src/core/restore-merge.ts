/**
 * 导回旧备份时，哪些东西**不许跟着退回去** · ★★ R-3-f
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * `restoreFrom` 是整库文件替换。真跑一遍量出来的结果：
 *
 *   墓碑        3 → 0      R-3 的保证当场作废
 *   账本撤销    1 → 0      R-3-e 的保证当场作废
 *   purged 账   3 行 → 1 行
 *   wipedAt  2000 → 1000   云端老包重新可读（I-068 那个 bug 的完整复现）
 *   讲 / 知识点  2 → 3      ✔ 这个该退，那正是导回的目的
 *
 * 后果不是「导回之后东西回来了」——两周内彻底删掉的东西**不在**那份备份里，
 * 不会立刻回来。**是挡它们的墓碑没了**：下一次同步，云端那些老包一到，全部复活。
 * 而且界面上只说「导回成功」。
 *
 * ── 分界线 ──────────────────────────────────────────────────
 *
 * > **导回可以把「现在是什么样」恢复到过去，
 * >  但不能把「发生过什么」当成没发生。**
 *
 * 业务数据（项目 / 讲 / 知识点 / 作答 / 进度）回答的是前者 —— 整份用备份的。
 * 墓碑 / 账本撤销 / `wipedAt` 回答的是后者 —— 不许被一份旧文件改写。
 *
 * D-232 说「导回是覆盖，不是合并」，那句话写在这些不可逆事实存在之前，
 * 讲的是业务数据。而项目里其实**早就有先例**：`export.ts` 清设置时
 * 把 `sync.wipedAt` 单独排除掉，注释写着「那是墓碑，清掉等于把云端老数据放回来」。
 *
 * ── 为什么判据放在 core ────────────────────────────────────
 *
 * 四条规则的**方向不一样**：两个取 max、一个取并集、一个取 **min**。
 * 光靠记是记不住的 —— 必须能单独测、能单独红。
 * 尤其是 `watermark` 那条，它和直觉相反，下一个人一定会想「顺手统一成 max」。
 */

/** 一块墓碑在合并时要看的东西 */
export interface TombFact {
  targetUid: string
  kind: string
  purgedAt: number
}

/**
 * 同一块墓碑两边都有时，`purged_at` 取哪个。
 *
 * **取较晚的。** 墓碑挡的是 `updated_at ≤ purged_at`，
 * `purged_at` 越晚，被判成「遗骸」的版本越多，挡得越严。
 *
 * 代价只在**诊断分类**上：一条本来该算「删除之后又改过」的行，
 * 可能被算成「遗骸」，于是少记一笔体检。而 R-3 早已确立
 * **两种都拒绝**，所以这个代价不影响「会不会复活」。
 *
 * 宁可多挡，不可复活。
 */
export function mergePurgedAt(current: number, backup: number): number {
  return Math.max(current, backup)
}

/**
 * 两边都有同一条账本判定时，留哪一行。
 *
 * **不能照抄墓碑的并集。** 墓碑只增，而账本撤销可以来回翻：
 * 删 → 撤销 → 再删 → 再撤销。所以「并集」在这里没有意义。
 *
 * 判据用的是每一行自带的 `updated_at` —— 那本来就是同步的判据。
 * 导回等于「把备份当成一台远端设备合并一次」，规则和 `decideRow`
 * 「只有一边改过」那一格完全一样，不另发明。
 *
 * @returns `true` = 用当前库那一行（当前更新），`false` = 保留备份那一行
 */
export function ledgerKeepsCurrent(currentUpdatedAt: number, backupUpdatedAt: number): boolean {
  return currentUpdatedAt > backupUpdatedAt
}

/**
 * 同一条裁决两边都有时，`rejected_up_to` 取哪个 · ★★ R-4-F-a
 *
 * **取较晚的**，理由和墓碑同一条：导回可以把「现在是什么样」恢复到过去，
 * 但不能把「他做过什么决定」当成没做过。退回旧值 = 那个时间段里被他
 * 拒绝过的远端版本重新可收 —— 下一次同步就悄悄盖掉他留下的内容。
 *
 * ★ 和墓碑**共用运算，不共用语义**：墓碑说「这东西没了」，
 * 裁决说「这一版不要，另一版才对」。两者的判据、接入点、失效条件都不同，
 * 千万不要因为都写着 `Math.max` 就把它们合成一个函数。
 */
export function mergeRejectedUpTo(current: number, backup: number): number {
  return Math.max(current, backup)
}

/**
 * 整库级的删除墓碑（清空云端那一下）。
 *
 * **取较晚的。** 他按过「清空云端」，那件事发生过。
 * 退回旧值 = 比它旧的云端包重新可读 —— I-068 那个 bug 的完整复现
 * （「清完重传，58 句全说以前收集过」）。
 */
export function mergeWipedAt(current: number, backup: number): number {
  return Math.max(current, backup)
}

/**
 * 同步游标。★★ **取较小的，方向和上面两条相反。**
 *
 * ── 为什么不能取 max（这一段千万别删）────────────────────
 *
 * 水位的含义是「比它旧的我都推过了」。备份里可能有一批
 * **当时还没推上去**的行，它们的 `updated_at` 小于当前水位。
 * 取 max 的话，`collectSince` 从此再也收不到它们 ——
 * **静默丢数据**，而且没有任何地方看得出来。
 *
 * 取 min 的代价只有一次流量：重推一批已经推过的行。
 * 对面收到时时间戳一样，`decideRow` 判 `same` 直接跳过；
 * 就算不一样，写入是 upsert（幂等），而墓碑还挡着复活。
 *
 * **一个是「多花一次流量」，一个是「悄悄少一批数据」。** 不对称。
 */
export function mergeWatermark(current: number, backup: number): number {
  return Math.min(current, backup)
}

/**
 * 「哪些变更包我读过」——**这是去重缓存，不是事实**。
 *
 * 多读一个包只是浪费一次网络（写入幂等、墓碑挡着复活）；
 * 少读一个包才会漏数据。所以取并集，两边的都留着。
 *
 * ★ 不要因为墓碑取并集，就以为它也是「不可逆事实」——
 * 它只是碰巧用同一个运算。把它当事实的话，下一次有人会想给它加保护逻辑。
 */
export function mergeApplied(current: string[], backup: string[]): string[] {
  return [...new Set([...backup, ...current])]
}

/** `applied` 存在 settings 里是一段 JSON，坏了也不该让导回失败 */
export function parseApplied(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
