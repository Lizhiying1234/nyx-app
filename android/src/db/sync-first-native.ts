/**
 * ══ 「先同步一趟」的**真实现** · 只给 App 那一侧 ═════════════════
 *
 * 这个文件存在的唯一理由：**把 `db/sync.ts` 关在 App 这一边**（I-163）。
 *
 * `db/sync.ts` 顶层拉 `db/sync-ports.ts`（`@capacitor/filesystem` +
 * secure-storage）。只要 `analyse.ts` / `analysis-runner.ts` / `edit-item.ts`
 * 里还留着 `await import('./sync.ts')`，那条边就会把整个 Capacitor 打进
 * `assist-engine.js` —— 而 Assist 引擎那个 WebView 没有桥（D-404）。
 * 现在这句 import 只出现在这里，而这里**只有 App 入口 import**
 * （`src/ui/main.ts` 调一次 `installAppSyncFirst()`）。
 *
 * ★ 与 `db/secret-native.ts` 同一个形状、同一条理由。两处一起看：
 *   零依赖的口子在 `db/*.ts`，带插件的那一份在 `db/*-native.ts`。
 * ★ 引擎那一侧不走这里：它压根不同步分析（`resumeBatch` → `tick` 每条都传
 *   `noSyncPerItem`），要同步走的是它自己的 `sync` op（端口⑤ ·
 *   `engine/main.ts::nativePorts`，与这一份是**同一个执行者**的两套端口）。
 * ★ `tools/check-engine-bundle.mjs` 守着这条边界：引擎的 import 图上再出现
 *   Capacitor 就红，并打出完整链路。
 */
import { runSyncAuto } from './sync.ts'
import { installSyncFirst, type SyncNote } from './sync-first.ts'
import type { Db } from './types.ts'

/**
 * App 入口调一次。**只有这一处** —— 调两次也无妨（同一份实现覆盖上去）。
 *
 * 三处的差别只有那句标签（同步账本上写「这一趟是谁要的」），
 * 判据（自动档开没开、有没有配、另一处是不是正在跑）全在 `runSyncAuto` 里。
 */
export function installAppSyncFirst(): void {
  installSyncFirst(async (db: Db, label: string): Promise<SyncNote> => {
    const r = await runSyncAuto(db, label, { gateAuto: true })
    return { ran: r.ran, note: r.note, ...(r.ran ? {} : { why: r.why ?? 'skip' }) }
  })
}
