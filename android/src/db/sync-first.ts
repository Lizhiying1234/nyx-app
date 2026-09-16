/**
 * ══ 「先同步一趟」的口子 · 零依赖 ═════════════════════════════
 *
 * 三处在写库之前先同步一趟，形状完全一样，只有那句标签不同：
 *
 *   `analyse.ts::analyseItem`        分析前同步
 *   `analysis-runner.ts::startBatch` 批量分析前同步（一批只在开头一趟）
 *   `edit-item.ts::editItem`         修改前同步
 *
 * 它们防的是**在过时的正文上做写入**（D-R22 / T-5.15）—— 缩窗口，不是消除窗口，
 * 真撞上仍归 D-438。三处都**不阻塞**：跳过 / 失败照常往下做，账带回去由 UI 说。
 *
 * ── 为什么把实现挪出去（I-163）★★ ──────────────────────────
 *
 * 原来三处各写一份 `await import('./sync.ts')`。而 `db/sync.ts` 顶层拉
 * `db/sync-ports.ts`，那一份 import 了 `@capacitor/filesystem` 与
 * secure-storage。于是这条边把整个 Capacitor 拖进了 `assist-engine.js`：
 *
 *   engine/main.ts → db/analysis-runner.ts → db/analyse.ts → db/sync.ts → db/sync-ports.ts
 *
 * 而 Assist 引擎那个 WebView **没有 Capacitor 桥**（D-404）。
 *
 * ★ 写成 `await import()` 不算治：引擎那一份是单文件 IIFE
 *   （`vite.engine.config.ts` · `formats: ['iife']`），动态 import 会被内联进
 *   同一个包 —— 实测过两次，一字未减。判据只能靠**文件边界**。
 *
 * ★★ 引擎那一侧**本来就不该走这条路**，实跑也没走：引擎只有
 *   `analysis` op → `resumeBatch` → `tick`，而 `tick` 每条都显式传
 *   `noSyncPerItem`（「这一批开头已经同步过了」）；`startBatch` 全仓只有
 *   `ui/views/Lecture.svelte` 一个调用点，引擎没有那个 op。所以这条边一直是
 *   **死代码** —— 从来没在引擎里跑过，只是白白把桥外的插件打进了包。
 *
 * ── 没装口子就抛，不返回「跳过了」★ ────────────────────────
 *
 * 与 `db/secret.ts` 同一条理由：返回一个温和的 `{ ran: false }` 会让
 * 「装配漏了」长得和「自动同步关着」一模一样 —— 同一句话说两件事，
 * 正是最难查的那一类。三处调用点都把抛出来的这句记进账（`why: 'error'`），
 * 屏幕上那句因此说的是「没装口子」，不是「你没配」。
 */
import type { Db } from './types.ts'

/** 那一趟同步的账 —— 跳过 / 失败都不阻塞写入，但要说得出来 */
export interface SyncNote {
  ran: boolean
  note: string
  why?: string
}

/** 注入点：② 层测试用假的；**默认那条不许绕过**（负向对照盯着它） */
export type SyncFirst = (db: Db) => Promise<SyncNote>

/** 真实现多带一个标签 —— 三处共用一份，标签是它们唯一的差别 */
export type AppSyncFirst = (db: Db, label: string) => Promise<SyncNote>

/** 还没装口子就来同步 = 装配漏了。**当场说出来**，别讲成「他关了自动同步」 */
export const SYNC_FIRST_PORT_NOT_INSTALLED = '这一端还没装同步口子'

let impl: AppSyncFirst | null = null

/**
 * 装上「先同步一趟」的真实现。
 * 合法的装配点只有一个：App 入口（`src/ui/main.ts` → `installAppSyncFirst()`）。
 * 传 `null` 是给 ② 层用例还原用的。
 */
export function installSyncFirst(fn: AppSyncFirst | null): void {
  impl = fn
}

/** 各处拿自己标签的那一份。★ 装没装是**调用时**问的，不是模块加载时 */
export function syncFirstFor(label: string): SyncFirst {
  return (db) =>
    impl === null ? Promise.reject(new Error(SYNC_FIRST_PORT_NOT_INSTALLED)) : impl(db, label)
}
