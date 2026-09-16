/**
 * db-safety · **入口**（T-4.6 拆分 · 2026-09-06）
 *
 * 两万行拆成了 tests/db-safety/ 下的十几个段。这里只剩三件事：
 *   ① 按**原顺序** import 各段 —— ES 模块的 import 在本模块正文之前求值，
 *      所以注册顺序与拆分前逐字一致（`checkAsync` 的身体在声明点就开跑，顺序是有意义的）
 *   ② 收尾统计与 `app.exit`
 *   ③ 7E 的场景结果表在最后打
 *
 * 命令行旗标（`--dump-schema` / `--schema` / `--only` / `--sync-baseline`）都在 harness.ts 里，
 * 它是所有段的依赖，先于任何注册求值 —— 与拆分前的时机相同。
 * 构建入口没动（`electron.vite.config.ts` 里的 `db-safety` 仍指这个文件）。
 */

/**
 * 数据安全四件套的验收 · D-216 / D-217 / D-236
 *
 * 这一套跑在 **Electron 主进程里**，不是普通 Node —— better-sqlite3 是按 Electron 的
 * ABI 编译的，系统 node 加载不了它（试过，报 NODE_MODULE_VERSION 不匹配）。
 *
 * 为什么值得单独写一套：**这是全项目唯一一处出错会静默丢数据的代码**。
 * 使用者零编程经验，丢了他发现不了，等发现时备份也轮转掉了。
 */

import { app } from 'electron'
import { cleanupTempDirs, failures, passes, ONLY_BASELINE, pending } from './db-safety/harness.ts'
import { recordBaseline, E7 } from './db-safety/fixtures.ts'

// ★ 顺序 = 拆分前这些段在文件里的先后。改动这里的顺序 = 改动用例的注册顺序。
import './db-safety/safety.ts'
import './db-safety/dict.ts'
import './db-safety/lifecycle.ts'
import './db-safety/lecture-state.ts'
import './db-safety/sync-failure.ts'
import './db-safety/tombstone.ts'
import './db-safety/sync-paging-push.ts'
import './db-safety/conflict.ts'
import './db-safety/reading-entry.ts'
import './db-safety/sync-paging-pull.ts'
import './db-safety/conflict-persist.ts'
import './db-safety/qtypes.ts'
import './db-safety/settings.ts'
import './db-safety/protocol.ts'
import './db-safety/convergence-cases.ts'
import './db-safety/recent.ts'
import './db-safety/voice.ts'
import './db-safety/prompts.ts'
import './db-safety/analytics.ts'
import './db-safety/splash-choice.ts'
import './db-safety/asset-ports.ts'

/**
 * ★ 场景结果表在**收尾**打 —— 这些场景是 `checkAsync`，
 *   同步的 `check` 会在它们还没跑完时就执行，那时表是空的。
 *   第一版就是这么写的，当场报「一个场景都没跑」。
 */
function print7E(): void {
  if (E7.length === 0) return
  console.log(String.fromCharCode(10) + "  ── 7E 场景结果 ──────────────────────────────────────")
  for (const c of E7) {
    console.log(
      `  ${c.id.padEnd(22)} 轮次 ${String(c.rounds).padStart(2)} · ` +
        `收 ${c.received} 应用 ${c.applied} 跳过 ${c.skipped} 失败 ${c.failed} 冲突 ${c.conflicted} · ` +
        `待推 A${c.pendingA}/B${c.pendingB} · 碑 ${c.tombs} · 裁决 ${c.res} · ${c.verdict}`
    )
  }
  console.log('')
}

/**
 * 异步那几条要等完再统计 —— 不等的话它们的失败会落在进程退出之后，
 * 计数永远是「全过」。报警器不响的时候没人会去怀疑报警器。
 *
 * 这里不用顶层 await：这份文件被打成 cjs，顶层 await 会让**整个构建失败**
 * （试过，`Module format "cjs" does not support top-level await`）。
 */
void (ONLY_BASELINE
  ? recordBaseline().then(
      () => {
        cleanupTempDirs()
        app.exit(0)
      },
      (e: unknown) => {
        console.error(e)
        cleanupTempDirs()
        app.exit(1)
      }
    )
  : Promise.all(pending)
).then(() => {
  print7E()
  console.log(`\n通过 ${passes} · 失败 ${failures}\n`)
  /**
   * ★ I-186 · 删掉这一趟造的临时目录。
   *   ★ 实测：`process.on('exit')` 那道兜底在这儿**是会触发**的（只拆这一句，
   *     增量仍是 0）。两处都留是双保险 —— 两道一起拆才复现，一趟漏 657 个。
   */
  cleanupTempDirs()
  app.exit(failures === 0 ? 0 : 1)
})

