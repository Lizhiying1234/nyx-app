/**
 * 批量分析的后台排班（T-5.13）—— **JS 判要不要排，原生只管排**。
 *
 * 「有没有没做完的批次」只有 JS 知道（状态在 `settings['analysis.batch']`），
 * 而 `check:java-sql` 那道闸不许 Java 查库。所以判断留在这一侧，
 * 原生那边（`AnalysisPlugin` → `AnalysisWorker`）一行判据都没有。
 *
 * ★ 排不上不该拖垮任何东西：没有插件（PC 预览）、WorkManager 拒绝、
 *   厂商省电策略压掉 —— 都只是「后台这一档没接上」，
 *   下次他打开 App 时前台自己会接着跑。所以一律吞掉异常。
 */
import { registerPlugin } from '@capacitor/core'
import { hasPending } from '../../db/analysis-runner.ts'
import type { Db } from '../../db/types.ts'

interface NyxAnalysisPlugin {
  scheduleBackground(): Promise<void>
  cancelBackground(): Promise<void>
}
const NyxAnalysis = registerPlugin<NyxAnalysisPlugin>('NyxAnalysis')

/** App 要进后台了：手上还有活就排一次「接着跑」，没有就把任务收掉 */
export async function syncBackgroundAnalysis(db: Db): Promise<void> {
  try {
    if (await hasPending(db)) await NyxAnalysis.scheduleBackground()
    else await NyxAnalysis.cancelBackground()
  } catch {
    /* 见文件头：排不上只是后台这一档没接上，不是错 */
  }
}
