import type { Database } from 'better-sqlite3'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { makeBackup } from './db/backup.ts'
import {
  afterWipe,
  PRESERVED_SYNC_KEYS,
  verifyAfterWipe,
  type SyncMetaSnapshot
} from '@core/sync-metadata.ts'
import type { NyxPaths } from './paths.ts'

/**
 * 清除全部数据 · 恢复出厂
 *
 * 使用者：「让用户将软件恢复到完全没有使用过的初始状态…
 *          表现得像第一次安装 / 第一次打开一样。」
 *
 * ── 和原来的「清空全部学习数据」（I-051）差在哪 ──────────────
 *
 * 那一个只清**数据库里的业务表**，而且默认留着设置 —— 它要的是「重来一遍」。
 * 这一个要的是「像没装过」，所以还要处理**库以外的东西**：
 * TTS 音频、日志、他改过的提示词、Electron 自己的会话存储。
 * 只清库、然后说一句「已恢复初始状态」，是不诚实的。
 *
 * ── 为什么做成一步一报，而不是一把梭 ────────────────────────
 *
 * 使用者点名：「不要留下『实际上没有完全清除，却显示清除成功』的状态。」
 * 这正是 I-102 那次的形状 —— 每张表 `try { delete } catch {}`，
 * 异常被吞掉，界面报「已清空」，31 条知识点原样留着。
 *
 * 所以这里每一步各自 try/catch、各自报成败，**任何一步失败都会如实说出来**，
 * 同时**其余能清的照样清完**（他要的也是这个）。
 *
 * ── 什么不删 ★ 这一段是拿代价换来的 ────────────────────────
 *
 * · **`data/dicts/` 他自己的词典** —— 2026-08-05 我用一条「删掉除 data 以外的全部」
 *   删掉了他 22 本词典、6.5 GB，回收站里都没有。词典不是这个软件产生的数据，
 *   是他自己放进来的资源；「恢复出厂」没有理由动它。
 *   真想删就自己去 `data/dicts` 删 —— 那是一个明确的、他看得见的动作。
 * · **`data/backups/` 备份** —— 包括这次动手前刚做的那一份。
 *   它是他后悔时唯一的退路。把退路一起清掉，这个功能就从「危险」变成「致命」。
 * · **程序本身**：exe、资源、出厂提示词种子、依赖。
 */

export interface ResetStep {
  name: string
  ok: boolean
  /** 做了什么 / 为什么没做成 —— 给他看的，说人话 */
  detail: string
}

export interface ResetResult {
  steps: ResetStep[]
  /** 动手之前那份备份，后悔了从这里回来 */
  backup: string
  ok: boolean
}

/** 目录里的文件全删掉，目录本身留着（下次启动直接能用） */
function emptyDir(dir: string, filter?: (f: string) => boolean): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const f of readdirSync(dir)) {
    if (filter && !filter(f)) continue
    const p = join(dir, f)
    rmSync(p, { recursive: true, force: true })
    n++
  }
  return n
}

export interface ResetDeps {
  db: Database
  paths: NyxPaths
  /** 清 Electron 自己的会话存储（缓存 / localStorage / IndexedDB） */
  clearSession: () => Promise<void>
  /** 同步的墓碑 —— 不挂的话下次同步会把清掉的东西原样拉回来（I-054） */
  markWiped?: () => void | Promise<void>
  /** 连云端那份副本一起清 */
  wipeRemote?: () => Promise<void>
}

export async function factoryReset(deps: ResetDeps): Promise<ResetResult> {
  const { db, paths } = deps
  const steps: ResetStep[] = []
  const step = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
    try {
      steps.push({ name, ok: true, detail: await fn() })
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * ① 先备份。**在任何删除之前**，而且它的失败必须能中止整件事 ——
   * 没有退路的不可逆操作，不该开始。
   */
  const backup = makeBackup(db, paths.backups, 'before-reset')
  steps.push({
    name: '动手前先备份',
    ok: !!backup,
    detail: backup ? `完整备份写在：${backup}` : '备份没做成 —— 已经停下，什么都没删。'
  })
  if (!backup) return { steps, backup: '', ok: false }

  /**
   * ② 同步墓碑要**在清数据之前**挂。
   * 它记的是「这个时间点之前的云端包一律不认」，不依赖任何网络操作成功；
   * 只靠「去云端删包」的那一版，列举一失败就静默什么都没做，
   * 下次同步照样把清掉的东西拉回来（I-054 使用者遇到的就是这个）。
   */
  if (deps.markWiped) {
    await step('挂上同步墓碑', async () => {
      await deps.markWiped!()
      return '云端现有的包已标成「不再拉回」。'
    })
  }
  if (deps.wipeRemote) {
    await step('清空云端那份副本', async () => {
      await deps.wipeRemote!()
      return '云端的包也删掉了。'
    })
  }

  /**
   * ③ 数据库：**所有表**（含设置）。
   * 表名从库里问，不手抄名单 —— I-102 的教训：手抄的名单漏了一张新表，
   * 外键挡住删除、异常被吞，界面报「已清空」而数据还在。
   * 将来加表默认就在清空范围内。
   */
  await step('清空数据库', () => {
    const all = (
      db
        .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`)
        .all() as { name: string }[]
    ).map((r) => r.name)
    // migration_log 留着：它是这个库的升级履历，不是他的数据；清掉会让日后排查断线
    const tables = all.filter((t) => t !== 'migration_log')

    /**
     * ★★ Step 1C · D-273 · **同步身份与不可逆事实，要在清空之前抄下来。**
     *
     * ── 病 ──────────────────────────────────────────────
     *
     * 上一版的顺序是：② `markWiped()` 把墓碑写进 `settings` → ③ 把**整张
     * `settings` 清空**。也就是说，第 ③ 步把第 ② 步刚立的碑一起抹掉了。
     * 于是正确性退回到「`wipeRemote()` 必须成功」—— 而 I-068 的整个结论
     * 就是**不能依赖它**（列举一失败就静默什么都没做，下次同步全拉回来）。
     *
     * ── 判据不写在这里 ──────────────────────────────────
     *
     * 「哪几个键要活下来、值该是多少」在 `core/sync-metadata.ts`。
     * 另一条清空路径（`export.ts::wipeStudyData`）调的是同一份 ——
     * 一条规则写在两个地方就会长成两个样子，这个洞本身就是那么来的。
     */
    const before: SyncMetaSnapshot = {}
    for (const k of PRESERVED_SYNC_KEYS) {
      const r = db.prepare(`select value from settings where key = ?`).get(k) as
        | { value: string }
        | undefined
      before[k] = r?.value ?? null
    }
    const keep = afterWipe(before, Date.now())

    const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1
    db.pragma('foreign_keys = OFF')
    let rows = 0
    try {
      db.transaction(() => {
        for (const t of tables) {
          rows += (db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n
          db.prepare(`delete from "${t}"`).run()
        }
        // 自增号归零 —— 新装的软件第一个项目就该是 1 号
        db.prepare(`delete from sqlite_sequence`).run()

        /**
         * ★ 写回**在同一个事务里**。
         * 分成两步的话，中间失败就会留下「清空了、碑没了」——
         * 而那正是这次要消灭的状态。
         *
         * `sync.device` 为空说明这台机器还没同步过，不写 ——
         * 让 `Sync.deviceId()` 照常去生成一个新的。
         */
        const put = db.prepare(
          `insert into settings (key, value, updated_at) values (?, ?, ?)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
        )
        const t = Date.now()
        for (const k of PRESERVED_SYNC_KEYS) {
          if (k === 'sync.device' && keep[k] === '') continue
          put.run(k, keep[k], t)
        }
      })()
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON')
    }

    /**
     * 清完**再数一遍**（同 D-216 迁移自检的思路）。
     * 「清空」是他看不见过程的操作，只能看见一句话；
     * 真出问题时表现恰好是「说清空了、数据还在」。
     *
     * ★ `settings` 例外：它现在应该**正好**只剩上面写回去的那几行。
     *   不是「随便剩几行都行」—— 多一行就说明有东西没清掉。
     */
    const kept = new Set<string>(PRESERVED_SYNC_KEYS)
    const left = tables
      .map((t) => ({ t, n: (db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n }))
      .filter((x) => {
        if (x.t !== 'settings') return x.n > 0
        const rest = db
          .prepare(
            `select count(*) as n from settings where key not in (${[...kept].map(() => '?').join(',')})`
          )
          .get(...kept) as { n: number }
        return rest.n > 0
      })
    if (left.length > 0) {
      throw new Error(`这几张表没清干净：${left.map((x) => `${x.t}(${x.n})`).join('、')}`)
    }

    /**
     * ★ 再验一遍同步元数据。判据同样在 core ——
     * 「碑不许倒退」「编号不许换」这两条要是坏了，表现是
     * 「重置之后下一次同步把清掉的东西全拉回来」，而那时候早就查不清了。
     */
    const now: SyncMetaSnapshot = {}
    for (const k of PRESERVED_SYNC_KEYS) {
      const r = db.prepare(`select value from settings where key = ?`).get(k) as
        | { value: string }
        | undefined
      now[k] = r?.value ?? null
    }
    const bad = verifyAfterWipe(before, now, 0)
    if (bad) throw new Error(`同步元数据没保住：${bad}`)

    return (
      `${tables.length} 张表全空了（清掉 ${rows} 行）。` +
      `同步编号与墓碑保留（${PRESERVED_SYNC_KEYS.join('、')}）。`
    )
  })

  // ④ TTS 音频（D-244 · 它在 data/audio，进同步不进备份）
  await step('清空朗读缓存', () => {
    const n = emptyDir(paths.audio)
    return n > 0 ? `删掉 ${n} 个音频文件。` : '本来就是空的。'
  })

  // ⑤ 日志
  await step('清空日志', () => {
    const n = emptyDir(paths.logs)
    return n > 0 ? `删掉 ${n} 个日志文件。` : '本来就是空的。'
  })

  /**
   * ⑥ 他改过的提示词回到出厂。
   *
   * 删掉 `data/prompts/` 里的 .md，下次启动 `syncPrompts` 会从出厂那份重新播种 ——
   * **复用现有的首启逻辑，不另写一套**（使用者点名要求的）。
   * `_旧版本/` 一起删：那是以前替换时另存的他的旧稿，属于用户数据。
   * 指纹存在 settings 表里，上一步已经清掉，所以播种会当成全新的来。
   */
  await step('提示词回到出厂设置', () => {
    const n = emptyDir(paths.prompts)
    return n > 0 ? `清掉 ${n} 项，下次启动会重新放一份出厂提示词。` : '本来就是出厂的那份。'
  })

  /**
   * ⑦ Electron 自己的会话存储。
   *
   * 这个软件的界面层不用 localStorage / IndexedDB（`core/` 的纯度闸连提都不许提），
   * 但 **Electron 本身**会写缓存、GPU 缓存、会话数据。
   * 「像第一次打开一样」要连这些一起清 —— 不清的话下次打开会带着上次的渲染缓存。
   */
  await step('清空浏览器缓存与会话数据', async () => {
    await deps.clearSession()
    return '缓存、localStorage、IndexedDB 都清了。'
  })

  const ok = steps.every((s) => s.ok)
  return { steps, backup, ok }
}

/** 词典有多少 —— 界面上要**明说不删**，并给出量，他才知道这个决定的分量 */
export function dictsInfo(paths: NyxPaths): { files: number; bytes: number; dir: string } {
  const dir = paths.dicts
  if (!existsSync(dir)) return { files: 0, bytes: 0, dir }
  let files = 0
  let bytes = 0
  for (const f of readdirSync(dir)) {
    try {
      const st = statSync(join(dir, f))
      if (st.isFile()) {
        files++
        bytes += st.size
      }
    } catch {
      /* 单个文件读不到不影响总数 */
    }
  }
  return { files, bytes, dir }
}
