import { app } from 'electron'
import { dirname, join } from 'node:path'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * 便携根目录 · D-263 / D-224
 *
 * 打包后 = exe 所在的文件夹；开发时 = 仓库根目录。
 * 数据、备份、日志、提示词全部挂在它下面 ——「整个文件夹拷走就是完整迁移，备份就是复制文件夹」。
 *
 * 明确不做的事：**不静默退回 AppData**。放进不可写目录时直接报错说清原因（见 ensureWritable），
 * 静默退回等于埋一个「数据不在你以为的地方」的雷。
 */
export function portableRoot(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath()
}

/**
 * 学习数据的根目录。默认就是软件文件夹（D-263 绿色便携）。
 *
 * **和 portableRoot 分开**是有原因的：`prompts/`、图标这些是**软件的一部分**，
 * 跟着软件走；`data/` 是**你的东西**。把数据指到别处时，提示词仍然应该从软件目录读 ——
 * 否则换个数据目录就等于把提示词弄丢了。
 *
 * 允许改的两个真实用途：
 *   ① 学习数据放到另一块盘 / 同步盘，软件本体留在原处
 *   ② 冒烟验收跑在用完就扔的目录上，不往真实数据里塞垃圾
 */
export function dataRoot(): string {
  const override = process.env['NYX_DATA_ROOT']
  if (override && override.trim()) return override.trim()
  return portableRoot()
}

export interface NyxPaths {
  root: string
  data: string
  backups: string
  logs: string
  prompts: string
  /** 打包时随软件发出去的那份默认提示词 —— 只读，用来播种 data/prompts */
  shippedPrompts: string
  dicts: string
  /**
   * TTS 音频（D-244 · 进同步、不进备份）。
   * 收进这里是因为它原来在两处各拼一次 `join(data,'audio')` ——
   * 两处会漂，而漂了的表现是「清除全部数据说清了，音频还在」。
   */
  audio: string
  resources: string
  db: string
}

export function resolvePaths(app_ = portableRoot(), data_ = dataRoot()): NyxPaths {
  const data = join(data_, 'data')
  return {
    root: data_,
    data,
    backups: join(data, 'backups'),
    audio: join(data, 'audio'),
    logs: join(data, 'logs'),
    /**
     * ★ I-106 · **凡是使用者自己的东西，一律放在 `data/` 里面。**
     *
     * 来历：更新软件时「删掉软件文件夹里除 data 以外的全部」把他的 22 本词典
     * 删掉了 —— 词典在 `<软件>/dicts`，跟 data 平级。
     * 当时的补救是「安装只覆盖不删除」，但那治的是症状：
     * 只要程序目录里还混着他的东西，下一次任何形式的清理都可能再删一次。
     *
     * 所以把边界画清楚：**程序目录里只有程序**。
     *   · `data/dicts`   —— 他放进来的词典
     *   · `data/prompts` —— 他改过的提示词（D-213 明确要他能用记事本改）
     * `<软件>/prompts` 降级成**出厂默认**，只在 `data/prompts` 不存在时播种一次。
     * 这样删掉整个程序目录再装一遍，他的改动一个字都不会丢。
     */
    prompts: join(data, 'prompts'),
    shippedPrompts: join(app_, 'prompts'),
    dicts: join(data, 'dicts'),
    resources: join(app_, 'resources'),
    db: join(data, 'nyx.db')
  }
}

/**
 * 把旧位置的东西搬进 `data/` · I-106
 *
 * 只在启动时做一次，**只搬不删**：
 *   · `<软件>/dicts`   → `data/dicts`（目标已存在就不动，避免覆盖新的）
 *   · `<软件>/prompts` → `data/prompts`（**复制**，不是搬 —— 出厂那份要留着当默认）
 *
 * 失败不该挡住启动：搬不动就退回原位置继续用，返回一句话让上层记进日志。
 * 词典和提示词都不是「没有就不能跑」的东西。
 */
export function migrateUserDirs(paths: NyxPaths, appDir = portableRoot()): string[] {
  const notes: string[] = []

  /**
   * 旧的词典目录在**数据根**下面（旧代码写的是 `join(paths.root,'dicts')`），
   * 不是软件目录下面 —— 打包运行时两者恰好相同，开发时不同。
   * 第一版我照着「软件目录」找，于是开发环境下永远搬不动，还建了个空目录出来。
   * 两个地方都找一遍，先找哪个都不影响结果。
   */
  const olds = [join(paths.root, 'dicts'), join(appDir, 'dicts')].filter(
    (d) => d !== paths.dicts && existsSync(d)
  )
  // 判据是「目标**空着**」而不是「目标不存在」——
  // 下面那句 mkdirSync 会把目录建出来，用「不存在」当条件等于只有一次机会
  const targetEmpty = !existsSync(paths.dicts) || readdirSync(paths.dicts).length === 0
  const oldDicts = olds[0]
  if (targetEmpty && oldDicts) {
    try {
      // 目标可能已经是个空目录 —— rename 到已存在的目录会失败，先清掉
      if (existsSync(paths.dicts)) rmSync(paths.dicts, { recursive: true, force: true })
      renameSync(oldDicts, paths.dicts)
      notes.push(`词典已从 ${oldDicts} 搬到 ${paths.dicts}`)
    } catch {
      try {
        cpSync(oldDicts, paths.dicts, { recursive: true })
        notes.push(`词典已复制到 ${paths.dicts}（原处保留，可自行删除）`)
      } catch (err) {
        notes.push(`词典没搬成：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  mkdirSync(paths.dicts, { recursive: true })

  /**
   * 提示词的播种与升级 · I-113
   *
   * 播种只发生一次；**升级**每次启动都要过一遍 ——
   * 见 `prompt-sync.ts`：他没动过的直接更新，改过的不动，
   * 改过但结构上跑不起来的先另存再换。
   * 这一步在 `openDatabase` 之后由 index.ts 调用（要用 settings 存指纹）。
   */
  mkdirSync(paths.prompts, { recursive: true })

  return notes
}

/** 目录不可写时返回一段人话，可写返回 null。 */
export function ensureWritable(paths: NyxPaths): string | null {
  try {
    mkdirSync(paths.data, { recursive: true })
    mkdirSync(paths.backups, { recursive: true })
    mkdirSync(paths.logs, { recursive: true })
    const probe = join(paths.data, '.write-probe')
    writeFileSync(probe, 'ok')
    rmSync(probe)
    return null
  } catch (err) {
    return [
      `Nyx 没法在这个位置写数据：`,
      ``,
      `    ${paths.data}`,
      ``,
      `原因：${err instanceof Error ? err.message : String(err)}`,
      ``,
      `Nyx 是绿色软件，数据就放在软件文件夹里，所以这个文件夹必须可写。`,
      `最常见的原因是把它放进了 C:\\Program Files —— 那个目录默认不让写。`,
      ``,
      `解决办法：把整个 Nyx 文件夹移到 D:\\ 之类的地方，再双击打开。`
    ].join('\n')
  }
}
