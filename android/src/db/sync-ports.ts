/**
 * 同步引擎的 **Android 装配层** —— 判据一行都不在这里（与 Windows
 * `main/sync/index.ts` 对称：那边 better-sqlite3/safeStorage/node:fs，
 * 这边 Capacitor SQLite / Keystore / Filesystem / WebCrypto）。
 *
 *   · db        = 应用自己的 `Db`（形状即 EngineDb —— D-275 那条线的兑现）
 *   · identity  = `sync-runner.ts::identityOf`（★ **与服务那侧同一份** ——
 *                 指纹差一位就是「每个包都被结构闸拒掉」而且不丢数据所以没人发现）
 *   · backup    = `VACUUM INTO`（纯 SQL、原子；引擎保证在事务外调它）
 *   · audio     = Filesystem Data/audio（D-244 · 内容哈希名，base64 正文）
 *   · secrets   = Android Keystore（D-220 ★ SECRET 永不上云、永不进 settings）
 */
import { Filesystem, Directory } from '@capacitor/filesystem'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { checkAudioName } from '../core-link.ts'
import type { AudioPort, EnginePorts } from '../core-link.ts'
import { sha256hex16 } from './sha256.ts'
import {
  listSplashFiles,
  readSplashFile,
  writeSplashFile,
  deleteSplashFile
} from './splash-files.ts'
import { fromBucketKeys, getSplashNames, toBucketKeys, writeSplashNames } from './splash.ts'
import type { SplashLabel } from '../core-link.ts'
import { identityOf, uuidV4 } from './sync-runner.ts'
import type { Db } from './types.ts'

export const SECRET_KEY = 'sync.secret'

/** ★ 实现搬去了 `sha256.ts`（那份不带 Capacitor 依赖）—— 老调用点照旧 import 得到 */
export { sha256hex16 }

/**
 * ══ 端口碰文件系统的那一层 ★★（B-3 · 2026-09-14）════════════
 *
 * 真那份走 Capacitor `Filesystem`。**抽成参数是为了那条负向对照跑得起来**：
 * 「守卫拆掉之后端口会把目录外的文件读出来」这句话，只有真的看见那份正文
 * 才算验到 —— 而 Capacitor 在 Node 里起不来，用例里换成内存的一份
 * （`tests/port-names.test.ts`）。
 * ★ 它只搬运，一条判据都没有：名字合不合规在上面那层问，路径在这里拼。
 */
export interface AssetIo {
  ensureDir(dir: string): Promise<void>
  readdir(dir: string): Promise<string[]>
  read(path: string): Promise<string | null>
  write(path: string, b64: string): Promise<void>
}

/** 真那份：Data 目录下的文件 */
const capacitorIo: AssetIo = {
  async ensureDir(dir: string): Promise<void> {
    try {
      await Filesystem.mkdir({ directory: Directory.Data, path: dir, recursive: true })
    } catch {
      /* 已存在 */
    }
  },
  async readdir(dir: string): Promise<string[]> {
    const r = await Filesystem.readdir({ directory: Directory.Data, path: dir })
    return r.files.map((f) => f.name)
  },
  async read(path: string): Promise<string | null> {
    try {
      const r = await Filesystem.readFile({ directory: Directory.Data, path })
      return typeof r.data === 'string' ? r.data : null
    } catch {
      return null
    }
  },
  async write(path: string, b64: string): Promise<void> {
    await Filesystem.writeFile({ directory: Directory.Data, path, data: b64 })
  }
}

/**
 * ★★ `nyx/audio` 现在是**一条空管道**（2026-09-14 两端各自实测）：
 *   Android `files/audio` 0 个文件 · Windows `data/audio` 0 个文件。
 *
 * 为什么空：D-466 把语音收成两档（词典音 → 系统音）之后，`cache` 那一档
 * （播电脑用云端合成、随同步落下来的 mp3）跟着退役 —— **两端都不再往里写**。
 *
 * ★ **故意不拆**（2026-09-14 我裁的，这是我的判断不是使用者的话）：
 *   · 它是同步协议的一部分，拆了要两端同时改，而它现在**一个字节都不传**，
 *     留着的代价是 0；
 *   · 真正的代价是**认知**——有人翻到这里会以为语音还走同步。那条注释就能挡住，
 *     不必动协议。
 * ☞ 哪天真要退役，是**两端一起**的动作，且要先确认没有旧包还在往里写。
 */
export const AUDIO_DIR = 'audio'

/**
 * ══ 音频端口 · **每一个名字都先过判据**（F-5 · 2026-09-14 双端对账）★★ ═══
 *
 * 这里的 `name` **不是本机产物** —— 它来自云端的清单，跑过网络、进过 JSON，
 * 而拼路径的那一步对 `../` 不会拦一下。
 *
 * 上一版这里写的是「名字已过 core/audio-name.ts 白名单（**引擎在调它之前验**）」——
 * 那句话当时是真的，**但它把一道安全闸寄存在「调用方会记得先验」上**。
 * 本轮对账撞到的正是它的反例：`splash.delete` 是后加的，
 * 加的时候没人想起这一句，两端一个加了一个没加 —— **同一道闸只守住一端，等于没守**。
 *
 * ★ `read` 的风险**不比 `write` 小**：一个构造出来的名字能让 Nyx 把**本机任意文件**
 *   读出来、当成资源传上桶。（Windows 那边拆掉守卫的对照里，端口真的吐出了
 *   `U0VDUkVU` —— base64 的 `SECRET`。）
 * ★ 判据走 core（`checkAudioName`，两端同一份、有用例），**本地不另写一份**。
 * ★ 不合格就**安静地不做**：这一路由同步引擎叫，抛了会把整趟同步带停。
 * ★ `list` 照旧只按扩展名过滤（与 Windows `audioPort` 逐字同形）——
 *   它列的是**本机目录里真有的东西**，不是外来名字。
 */
export function audioPort(io: AssetIo = capacitorIo): AudioPort {
  return {
    async list(): Promise<string[]> {
      await io.ensureDir(AUDIO_DIR)
      return (await io.readdir(AUDIO_DIR)).filter((n) => n.endsWith('.mp3'))
    },
    async read(name: string): Promise<string | null> {
      if (!checkAudioName(name).ok) return null
      return io.read(`${AUDIO_DIR}/${name}`)
    },
    async write(name: string, b64: string): Promise<void> {
      if (!checkAudioName(name).ok) return
      await io.ensureDir(AUDIO_DIR)
      await io.write(`${AUDIO_DIR}/${name}`, b64)
    }
  }
}

export function makePorts(db: Db): EnginePorts {
  return {
    db,
    identity: () => identityOf(db),
    /**
     * 动库之前的整库备份。`VACUUM INTO` 原子、跨驱动，且引擎只在
     * **事务外**调它（SQLite 禁止事务内 VACUUM —— 正好互证）。
     * 只滚一份：手机盘小，同步每次都备，留最后一份就够回退用。
     */
    backup: async (reason: string) => {
      const name = `nyx-backup-${reason}.db`
      const uri = await Filesystem.getUri({ directory: Directory.Data, path: name })
      const path = uri.uri.replace(/^file:\/\//, '')
      try {
        await Filesystem.deleteFile({ directory: Directory.Data, path: name })
      } catch {
        /* 没有旧备份 */
      }
      await db.run(`vacuum into '${path.replace(/'/g, "''")}'`)
    },
    audio: audioPort(),
    /**
     * ★★ 启动页图片（2026-09-13 接上）。
     *
     * core 里它是 `EnginePorts.splash?` —— **可选**：不给端口的那一端
     * 既不传也不收。此前 Android 一直没给，因为「传自己的图」那一档没做；
     * 现在本机图片库做好了（`db/splash-files.ts`），端口跟着接上。
     * ★ 判据一条都不在这儿：名字合不合规（`checkSplashName`）由引擎在调用
     *   之前验，写盘那一层再验一次 —— 那是最后一道，防的是绕过引擎调它的人。
     * ★ 和 `audio` 逐字同形 —— 两条流在 core 里走的是同一套 `AssetPort`。
     */
    splash: {
      list: listSplashFiles,
      read: readSplashFile,
      write: writeSplashFile,
      /**
       * ★★ 服从删除，**不是**界面上那颗按钮（core `AssetPort.delete` 的注释说得更全）。
       *   他在电脑上删了 → 桶里立碑 → 这一趟同步读到碑 → 叫它，手机这份也没了。
       * ★ 这一端**没有**发起删除的入口（见 `views/Settings.svelte` 启动页那一段的说明），
       *   所以这里只服从、不立碑。哪天手机上要能删，立碑那一半再在界面那边补。
       */
      delete: deleteSplashFile
    },
    /**
     * ★★ 图片的**名字**（2026-09-13 · 使用者裁「两端同步、以最后一次修改为准」）。
     *
     * ══ 键要换一次形状 ★ ════════════════════════════════════
     * 引擎认的键是**桶里那个资源名**：`<64 位小写十六进制>.<扩展名>`。
     * 而本机那张表的键是 `encodeSplashChoice(c)`，用户图那些**多一个 `user:` 前缀**。
     * 所以 read 剥掉、write 加回来。
     * ☞ 不剥的话：带前缀的键过不了引擎那道 `checkSplashName`，
     *   **一张都传不上去，而且不报错** —— 这正是这类问题最难查的地方。
     *
     * ══ 内置那两档为什么照样递过去 ════════════════════════════
     * 「出厂插画」在手机上是可以改名的，那个名字是**这台机器自己的叫法**，不该进桶。
     * 两种写法都安全，选的是「整表递过去、整表覆盖」这一种：
     *   引擎的 `next` 从我给的表起步，`shipped` 原样留着；
     *   推那一步 `checkSplashName('shipped')` 不过，于是**它自己被跳过**。
     * ★ 选它是因为**保住 `shipped` 的是一道指得着的闸，不是一条要记住的规矩**。
     *   另一种写法（read 只给 user、write 时自己合并）哪天忘了合并，
     *   他给出厂插画起的名字就**静默消失**，而且找不到是什么时候没的。
     *
     * ★ 判据一条都不在这儿：谁赢（`pickLabel`）· 洗名字（`cleanLabel`）·
     *   没变就不写（`sameLabels`）全在引擎/core。这里只做键的形状转换。
     */
    splashLabels: {
      read: async (): Promise<Record<string, SplashLabel>> =>
        toBucketKeys(await getSplashNames(db)),
      write: async (map: Record<string, SplashLabel>): Promise<void> =>
        writeSplashNames(db, fromBucketKeys(map))
    },
    secrets: {
      async getSyncSecret(): Promise<string> {
        try {
          return (await SecureStorage.getItem(SECRET_KEY)) ?? ''
        } catch {
          return ''
        }
      },
      async setSyncSecret(plain: string): Promise<void> {
        await SecureStorage.setItem(SECRET_KEY, plain)
      },
      async hasSyncSecret(): Promise<boolean> {
        try {
          const v = await SecureStorage.getItem(SECRET_KEY)
          return v !== null && v !== ''
        } catch {
          return false
        }
      }
    },
    clock: { now: () => Date.now() },
    /** ★ 与服务那侧同一份（`sync-runner.ts`）—— http origin 下没有 `randomUUID` */
    uuid: uuidV4
  }
}
