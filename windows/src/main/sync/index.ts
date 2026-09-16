import type { Database } from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SyncEngine, type CompactAttempt, type RestoreOutcome } from '@core/sync/engine.ts'
import { encodeLabels } from '@core/splash-names.ts'
import { labels as splashLabelsOf } from '../splash.ts'
import type { CompactResult } from '@core/sync/compact.ts'
import type { CompactLimits } from '@core/sync/compact-trigger.ts'
import type { Resolution } from '@core/sync-merge.ts'
import type { InvariantViolation } from '@core/sync/invariants.ts'
import { schemaIdentity } from '../db/fingerprint.ts'
import { wrapDb } from '../db/async-db.ts'
import { makeBackup } from '../db/backup.ts'
import { SecretStore } from '../db/secrets.ts'
import type { SyncConfig } from './store.ts'
import { now as clockNow } from '../clock.ts'
import type { SyncRun as SyncRunResult, SyncStatus } from '@shared/api.ts'
import type { AssetPort, AudioPort } from '../../core/sync/ports.ts'
import { checkAudioName } from '../../core/audio-name.ts'
import { checkSplashName } from '../../core/splash-name.ts'

/**
 * 同步 · Windows 端**装配层** —— 判据一行都不在这里。
 *
 * ★★★ 2026-08-29 · 阶段 3（Android 同步接线）：原来这个文件里的 2,200 行
 * 编排整体搬去了 `core/sync/engine.ts`（两端同一份 —— sync/types.ts 头注：
 * 「写第二份 = 把这个项目最擅长制造、也最难发现的那类 bug 复制到第二个平台」）。
 * 这里剩下的只有平台的事：
 *   · better-sqlite3 包成异步 `EngineDb`（D-275 同款方向：PC 迁就异步）
 *   · 备份 = `makeBackup`（node:fs）· 密钥 = `SecretStore`（safeStorage/DPAPI）
 *   · 身份 = `schemaIdentity`（node:crypto 哈希；规范化在 core）
 *   · 音频目录 = node:fs 读写
 * 公有面（构造签名与全部方法）与旧版一致 —— 唯一形变是**全部变成异步**，
 * 调用点跟着 `await`（IPC handler 本来就吞 Promise）。
 *
 * ★ 事务语义没变：包装的 await 都落在**已经解决的 Promise** 上（better-sqlite3
 *   是同步的），一条 await 链在同一个宏任务里跑完 —— IPC 事件插不进
 *   引擎的事务中间，和旧的同步块一样原子。
 */

/**
 * ══ 资产端口 · **每一个名字都先过判据**（F-08）★★ ══════════
 *
 * 这里每一个 `name` **都不是本机产物** —— 它们来自云端的清单与碑，
 * 跑过网络、进过 JSON。而 `join()` 对 `../` 不会拦一下。
 *
 * 上一版这里写的是「名字已过白名单（引擎在调它之前验）」——
 * 那句话当时是真的，但它把一道安全闸寄存在「调用方会记得先验」上。
 * 2026-09-14 双端对账就碰到了它的反例：`splash.delete` 是后来加的，
 * 加的时候没人想起这一句，Android 那端加了、我这端没加 ——
 * **同一道闸只守住一端，等于没守。**
 *
 * ★ 现在五个方法各自守自己那一道。这不是不信引擎 ——
 *   是因为**端口是碰文件系统前的最后一道**，而引擎以后还会长出新的调用点。
 * ★ `read` 的风险并不比 `delete` 小：一个构造出来的名字能让 Nyx
 *   把**本机任意文件**读出来、当成资源传上桶。
 * ★ 判据一律走 core（`audio-name.ts` / `splash-name.ts`，两端同一份、有用例）。
 *   不合格就**安静地不做**：这一路由同步引擎叫，抛了会把整趟同步带停。
 */
export function audioPort(audioDir: string): AudioPort {
  return {
    async list(): Promise<string[]> {
      if (!existsSync(audioDir)) mkdirSync(audioDir, { recursive: true })
      return readdirSync(audioDir).filter((f) => f.endsWith('.mp3'))
    },
    async read(name: string): Promise<string | null> {
      if (!checkAudioName(name).ok) return null
      try {
        return readFileSync(join(audioDir, name)).toString('base64')
      } catch {
        return null
      }
    },
    async write(name: string, b64: string): Promise<void> {
      if (!checkAudioName(name).ok) return
      writeFileSync(join(audioDir, name), Buffer.from(b64, 'base64'))
    }
  }
}

/** 启动页图片 —— 和音频同一个形状，名字也同样逐个过判据（见上） */
export function splashPort(splashResDir: string): AssetPort {
  return {
    async list(): Promise<string[]> {
      if (!existsSync(splashResDir)) mkdirSync(splashResDir, { recursive: true })
      return readdirSync(splashResDir)
    },
    async read(name: string): Promise<string | null> {
      if (!checkSplashName(name).ok) return null
      try {
        return readFileSync(join(splashResDir, name)).toString('base64')
      } catch {
        return null
      }
    },
    async write(name: string, b64: string): Promise<void> {
      if (!checkSplashName(name).ok) return
      mkdirSync(splashResDir, { recursive: true })
      writeFileSync(join(splashResDir, name), Buffer.from(b64, 'base64'))
    },
    /**
     * ★★ **服从一次删除**（使用者 2026-09-14 裁「选 a」）——
     *   不是界面上那颗按钮。引擎从桶里读到墓碑之后叫它。
     * ★ `force: true` = 文件本来就不在也算成功（幂等）。
     * ★ **不抛**：删不掉（被占用之类）不该把整趟同步带停，
     *   代价只是这一张这一轮没删掉 —— 下一趟还会再试。
     */
    async delete(name: string): Promise<void> {
      /**
       * ★★ **名字先过判据**（F-08，2026-09-14 双端对账补上）。
       *
       * 上一版直接 `rmSync(join(splashResDir, name))` 就删了。
       * 这一句里的 `name` **不是本机产物** —— 它来自**云端那块碑上的键**，
       * 也就是说它跑过网络、进过 JSON。`join()` 对 `../` 不会抦一下：
       * 一个 `../../什么` 就能把删除抓到资源目录外面去。
       *
       * ★ 判据用的是 `core/splash-name.ts::checkSplashName`（两端同一份，有用例）：
       *   只认「64 位小写十六进制（sha256）＋ 四种扩展名」那一种形状。
       *   **不另写一份**—— 写两份就会漂，而漂了的后果是一边收、一边不收。
       * ★ Android 那端 `deleteSplashFile` 第一行就是它。
       *   本轮对账才发现我这端漏了 —— **同一道闸只守住一端，等于没守。**
       * ★ 不合格就**安静地不删**：这一路是同步引擎叫的，抛了会把整趟同步带停；
       *   而一个形状不对的名字本来就不可能是我们自己写进去的文件。
       */
      if (!checkSplashName(name).ok) return
      try {
        rmSync(join(splashResDir, name), { force: true })
      } catch {
        /* 见上：这一路不抛 */
      }
    }
  }
}

export class Sync {
  private engine: SyncEngine

  constructor(
    db: Database,
    audioDir: string,
    backupDir: string,
    clock: { now(): number } = { now: () => clockNow() },
    /**
     * 启动页资源目录（`data/resources/splash/`）。
     *
     * ★ **可选**：不给就不接那条流 —— 一堆老用例是 `new Sync(db, audioDir, backupDir)`
     *   三个参数调的，它们不该为了一个用不上的功能全部改一遍。
     * ★★ **加在末尾，不插在中间**：第一版我把它塞在 `clock` 前面，
     *   于是 `new Sync(db, audio, backups, clock)` 那两处把 clock 传成了资源目录。
     *   这次是两者类型不同才被 svelte-check 抓住 —— 要是新参数也是 string，
     *   它会**安静地传错**。位置参数只许往后加。
     */
    splashResDir?: string
  ) {
    const secrets = new SecretStore(db)
    this.engine = new SyncEngine({
      db: wrapDb(db),
      identity: () => schemaIdentity(db),
      backup: (reason) => {
        makeBackup(db, backupDir, reason)
      },
      audio: audioPort(audioDir),
      splash: splashResDir ? splashPort(splashResDir) : undefined,
      /**
       * 启动页图片的**名字**（使用者 2026-09-13）。
       * ★ 单独一个口子、不塞进上面那个 `splash` —— 那三个方法的语义是
       *   「本机的那些文件」，而名字不是文件。
       * ★ 存在 `settings` 里（`splash.labels`），和「选了哪张」同一张表、
       *   但**性质相反**：选了哪张各端自管（D-480），名字两端一致。
       */
      splashLabels: {
        async read() {
          return splashLabelsOf(db)
        },
        async write(map) {
          db.prepare(
            `insert into settings (key, value, updated_at) values (?, ?, ?)
               on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
          ).run('splash.labels', encodeLabels(map), Date.now())
        }
      },
      secrets: {
        getSyncSecret: () => secrets.getSyncSecret(),
        setSyncSecret: (plain) => {
          secrets.setSyncSecret(plain)
        },
        hasSyncSecret: () => secrets.hasSyncSecret()
      },
      clock,
      uuid: () => randomUUID()
    })
  }

  // ── 全部转发 —— 返回类型对齐 @shared/api.ts（结构相同，零转换）────
  run(resolve?: Resolution, what?: string): Promise<SyncRunResult> {
    return this.engine.run(resolve, what) as Promise<SyncRunResult>
  }

  /**
   * ★ T-2.10 · 压实的触发点。**接线就这一句** —— 该不该压、压出什么后果，
   * 判据全在 `core/sync/compact-trigger.ts`，Android 那半场调的是同一个方法。
   * 它绝不抛：压实坏了不许改变这一趟同步的结果（问题落进 `sync.problems`）。
   */
  compactIfNeeded(now?: number, limits?: CompactLimits): Promise<CompactAttempt> {
    return this.engine.compactIfNeeded(now, limits)
  }

  /** 「叫我我就压」—— 不问理由那一条。验收与以后的手动入口要它 */
  compact(now?: number, limits?: CompactLimits): Promise<CompactResult> {
    return this.engine.compact(now, limits)
  }

  /**
   * ★ T-2.5 · 还原账本里被盖掉的那一版。**接线就这一句** ——
   * 判据在 `core/sync/restore.ts`、执行在引擎里（要用到同一份关系翻译），
   * Android 那半以后调的是同一个方法。它绝不抛：拒绝也是一句人话。
   */
  restoreOverride(opsLogId: number, now?: number): Promise<RestoreOutcome> {
    return this.engine.restoreOverride(opsLogId, now)
  }

  config(): Promise<SyncConfig> {
    return this.engine.config()
  }

  saveConfig(c: SyncConfig): Promise<void> {
    return this.engine.saveConfig(c)
  }

  auto(): Promise<boolean> {
    return this.engine.auto()
  }

  setAuto(on: boolean): Promise<void> {
    return this.engine.setAuto(on)
  }

  markWiped(at?: number): Promise<void> {
    return this.engine.markWiped(at)
  }

  status(): Promise<SyncStatus> {
    return this.engine.status() as Promise<SyncStatus>
  }

  markAllApplied(): Promise<number> {
    return this.engine.markAllApplied()
  }

  wipeRemote(): Promise<number> {
    return this.engine.wipeRemote()
  }

  test(): Promise<void> {
    return this.engine.test()
  }

  noteRunFailure(what: string, err: unknown): Promise<void> {
    return this.engine.noteRunFailure(what, err)
  }

  schemaInfo(): Promise<{
    schemaVersion: number
    schemaFingerprint: string
    protocolVersion: number
    algo: string
  }> {
    return this.engine.schemaInfo()
  }

  // ── 验收观察器（内存读，同步）────────────────────────────────
  violations(): readonly InvariantViolation[] {
    return this.engine.violations()
  }

  writeOrder(): readonly string[] {
    return this.engine.writeOrder()
  }

  stateLookupCount(): number {
    return this.engine.stateLookupCount()
  }

  pendingQueryCount(): number {
    return this.engine.pendingQueryCount()
  }

  boundaryLookups(): number {
    return this.engine.boundaryLookups()
  }
}
