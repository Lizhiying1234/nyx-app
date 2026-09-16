/**
 * 同步入口（Android · App 侧）—— **只是把 Capacitor 那套端口绑到唯一执行者上**。
 *
 * ★★★ 红线（D-249 / BUILD_PLAN 阶段 3）：**同步没通之前不在真库上练习** ——
 *   手机记录在同步成功前是孤本。这一层通了，练习才解锁。
 * ★ 编排/判据全部在 core/sync/engine.ts（两端同一份）；
 *   互斥与单入口在 `sync-runner.ts`（T-2.1）；这里只有装配。
 * ★ **这个文件里没有 `new SyncEngine`** —— 全仓只有 `sync-runner.ts` 那一处。
 * ★ D-249 的「练完自动上传」开关放 settings（device 面，不同步）——
 *   练习收尾读它。
 */
import type { EngineRunResult, Resolution, SyncEngine } from '../core-link.ts'
import { engineFor, runAuto, runNow, type SyncOutcome } from './sync-runner.ts'
import { makePorts } from './sync-ports.ts'
import type { Db } from './types.ts'

/**
 * 引擎本身 —— 只给「读配置 / 看状态 / 测连通 / 改开关」用。
 * ★ **跑同步不要用它的 `run()`**：那样就绕过了互斥。走下面两个入口。
 */
export function syncEngine(db: Db): SyncEngine {
  return engineFor(db, makePorts)
}

/** 手动档（设置页那个按钮 / 冲突裁决之后）—— 抢不到租约会等，等不到抛人话 */
export function runSyncNow(db: Db, what: string, resolve?: Resolution): Promise<EngineRunResult> {
  return runNow(db, makePorts, what, resolve)
}

/** 自动档（冷启动 · 切回前台 · 练完）—— 不该跑就安静跳过 */
export function runSyncAuto(
  db: Db,
  what: string,
  o: { gateAuto?: boolean } = {}
): Promise<SyncOutcome> {
  return runAuto(db, makePorts, what, o)
}

export type { SyncOutcome }

export const AUTO_AFTER_PRACTICE_KEY = 'sync.autoAfterPractice'

export async function autoAfterPractice(db: Db): Promise<boolean> {
  const r = await db.get(`select value from settings where key = ?`, [AUTO_AFTER_PRACTICE_KEY])
  return r?.['value'] === '1'
}

export async function setAutoAfterPractice(db: Db, on: boolean): Promise<void> {
  await db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [AUTO_AFTER_PRACTICE_KEY, on ? '1' : '0', Date.now()]
  )
}
