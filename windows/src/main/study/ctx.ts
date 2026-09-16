/**
 * `Study` 的依赖清单 · T-4.6 拆分（2026-09-06）
 *
 * 各领域文件（`study/lecture.ts` 等）拿到的就是这一份 —— 谁用了什么，一眼看得见。
 *
 * ★ 为什么带一个 `self`：公共方法名是 IPC 面（`main/index.ts` 直接调，`check:ipc-guard` 守着），
 *   一个都不能改，所以它们仍然挂在类上；领域之间偶尔要互相调（比如今日计划要问认读线
 *   还有多少到期卡），那几处就走 `c.self.<方法>`。私有方法不走这里 —— 它们整个搬进了
 *   自己那一份领域文件，调用点全在同一个文件里（搬之前逐个数过）。
 * ★ 这个文件与 `study.ts` 互相 import 的只有**类型**（`import type`），
 *   `verbatimModuleSyntax` 下会被完全擦掉，运行时没有循环。
 */
import type { Database } from 'better-sqlite3'
import type { ParamStore } from '../params.ts'
import type { Ledger } from '../db/ledger.ts'
import type { Prefs } from '../db/prefs.ts'
import type { QTypes } from '../db/qtypes.ts'
import type { Dicts } from '../dict/index.ts'
import type { Study } from '../study.ts'

export interface StudyCtx {
  readonly db: Database
  readonly params: ParamStore
  readonly ledger: Ledger
  readonly prefs: Prefs
  readonly qt: QTypes
  readonly promptsDir: string
  readonly level: () => string
  readonly dicts?: () => Dicts | null
  /** 兄弟领域的公共方法从这里走 —— 方法名就是 IPC 面，不能改 */
  readonly self: Study
}
