import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { checkSplashName, SPLASH_EXTS } from '../core/splash-name.ts'
import type { SplashRes } from '@shared/api.ts'
import type { NyxPaths } from './paths.ts'

/**
 * 启动页图片资源库 · 使用者 2026-09-09「Settings → 资源 → 启动页」
 *
 * ══ 存哪儿：`data/resources/splash/`，**不是** `<软件>/resources/` ══════
 *
 * 这一条不是我选的，是 **I-106** 定死的：
 *
 *   「凡是使用者自己的东西，一律放在 `data/` 里面。**程序目录里只有程序**。」
 *
 * 来历就在 `paths.ts` 那段注释里：更新软件时「删掉软件文件夹里除 data 以外的全部」
 * 把他的 22 本词典删掉了。`<软件>/resources/` 正是 `install.mjs` 每次装机都要覆盖的
 * 那一片 —— 他上传的图片放那儿，装一次新版就没了，而且**不会有任何提示**。
 * 出厂那张 `illustration.webp` 留在程序目录是对的：**它是程序的一部分**。
 *
 * ══ 名字 = 内容 sha1 + 扩展名（判据在 `core/splash-name.ts`）═══════════
 *
 * 白拿三样：同一张图传两次是同一个文件 · 两端算出来的名字必然相同（同步不用协商）·
 * 从外部拿到的名字拼路径之前有一道白名单闸（F-08 的教训，全仓第二处）。
 *
 * ══ 这一层不抛 ═══════════════════════════════════════════════════════
 * 只有 `importSplash` 会抛（他按了「上传」，失败必须当面说）。
 * `list` / `read` / `remove` 一律吞掉异常按「没有」处理 ——
 * 启动页这条路上任何一处抛出去都等于**白屏**，而资源目录是他能用资源管理器动的。
 */

/**
 * 一张图最大 **2MB**。
 *
 * ★ 这个数是**跨端约束**，不是本端节流 —— 改它要两端一起想。
 *   理由（Android 会话 2026-09-09 提的，我认）：**一旦进桶，每一台手机都要
 *   下载 + 解码那一张**。在电脑上选一张 8MB 的照片是随手的事，代价却全落在手机上：
 *     8MB → base64 约 10.7MB → JS 里 UTF-16 约 21MB → `JSON.stringify` 再复制一份
 *     → 单张瞬时约 60–80MB，还要整串走一次 Capacitor 桥。
 *
 * ★ 2MB 对**这件事本身**绰绰有余：启动页画面的上限是窗口的 62% 高 × 70% 宽，
 *   而仓库里那张出厂插画 `illustration.webp` 是 **1293×1013 · 600KB**，
 *   在手机真机上已验过够清楚（Android 会话 B1 装机看过）。
 *   8MB 只帮得到「把没压过的原图直接拖进来」那一种情况 —— 而那正是最伤手机的那一种。
 *
 * ★ 原来是 8MB（本会话第一版拍的），2026-09-09 收到手机侧实数后收紧。
 *   收紧会挡住他手里某些图，所以当面报了使用者 —— **他当天裁「可以」**。
 *   ☞ 报错因此必须说清**怎么办**（见 `importSplash`）：被挡住的那一刻他要知道下一步做什么。
 */
export const SPLASH_MAX_BYTES = 2 * 1024 * 1024

/* SplashRes 的定义在 @shared/api.ts —— 界面也要用它，只能有一份 */

/** 目录不在就建一个，返回它 —— 「在资源管理器里打开」要用 */
export function ensureSplashDir(paths: NyxPaths): string {
  const dir = splashDir(paths)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** `data/resources/splash/` —— 只在这里拼一次，别处一律叫这个函数（audio 那处就是拼两次漂掉的） */
export function splashDir(paths: NyxPaths): string {
  return join(paths.data, 'resources', 'splash')
}

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

/**
 * 真的是一张图吗 —— **看头几个字节，不看扩展名**。
 * 扩展名是他改得动的；把一个 .exe 改名成 .png 传进来，这里要认出来。
 * （这不是杀毒：它只保证「解不出来的东西不会被当成图存进资源库」。）
 */
function looksLikeImage(b: Buffer, ext: string): boolean {
  if (b.length < 64) return false
  const ascii = (n: number): string => b.subarray(0, n).toString('latin1')
  if (ext === '.png') return ascii(8) === '\x89PNG\r\n\x1a\n'
  if (ext === '.jpg' || ext === '.jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (ext === '.webp') return ascii(4) === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
  return false
}

/** 资源库里现在有哪几张。目录不在 / 读不动 → 空数组（不抛）。 */
export function listSplash(paths: NyxPaths): SplashRes[] {
  const dir = splashDir(paths)
  try {
    return readdirSync(dir)
      .filter((n) => checkSplashName(n).ok)
      .map((name) => {
        try {
          const st = statSync(join(dir, name))
          return { name, bytes: st.size, addedAt: st.mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is SplashRes => x !== null)
      .sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    return []
  }
}

/** 读一张的字节，给界面画预览 / 给启动页用。读不出来 → `null`（不抛）。 */
export function readSplash(paths: NyxPaths, name: string): string | null {
  if (!checkSplashName(name).ok) return null
  try {
    const file = join(splashDir(paths), name)
    const mime = MIME[extname(name).toLowerCase()]
    if (!mime) return null
    const bytes = readFileSync(file)
    if (bytes.length < 64) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 把一张图收进资源库。返回它在库里的名字。
 * ★ **这一处抛**：他刚按了「上传」，失败必须当面说清哪一步不行。
 */
export function importSplash(paths: NyxPaths, srcPath: string): SplashRes {
  const ext = extname(srcPath).toLowerCase()
  if (!SPLASH_EXTS.includes(ext)) {
    throw new Error(`只收 webp / png / jpg 三种图片，这个是「${ext || '没有扩展名'}」`)
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(srcPath)
  } catch (err) {
    throw new Error(`这个文件读不出来：${err instanceof Error ? err.message : String(err)}`)
  }
  if (bytes.length > SPLASH_MAX_BYTES) {
    const mb = (bytes.length / 1024 / 1024).toFixed(1)
    /* ★ 挡住他的时候必须说清**怎么办** —— 只说「太大了」等于把问题丢回给他 */
    throw new Error(
      `这张图 ${mb}MB，超过 2MB。启动页的画面最多占窗口的六成高，` +
        `用不上这么大 —— 出厂那张插画是 1293×1013、只有 600KB。\n` +
        `把它导出成 webp 或压一下再传；这个上限是为了手机：` +
        `图片资源两端共用，一张大图会让每一台手机都下载 + 解码一次。`
    )
  }
  if (!looksLikeImage(bytes, ext)) {
    throw new Error('这个文件的开头不像一张图 —— 是不是把别的文件改了扩展名？')
  }
  const name = createHash('sha256').update(bytes).digest('hex') + ext
  const verdict = checkSplashName(name)
  /* 名字是本机算出来的，走到这里不合法说明上面的规则和 core 的判据漂了 —— 当场喊 */
  if (!verdict.ok) throw new Error(`内部错误：算出来的资源名不合法（${verdict.why}）`)
  const dir = splashDir(paths)
  mkdirSync(dir, { recursive: true })
  copyFileSync(srcPath, join(dir, name))
  return { name, bytes: bytes.length, addedAt: Date.now() }
}

/**
 * 从库里删一张。
 * ★ 这是**彻底删除**，不进回收站 —— 图片资源不是学习数据（D-435 说的三档
 *   是给同步表上的行定的，这里是文件）。所以界面上必须先问一句（Dialog）。
 */
export function removeSplash(paths: NyxPaths, name: string): void {
  if (!checkSplashName(name).ok) return
  try {
    rmSync(join(splashDir(paths), name), { force: true })
  } catch {
    /* 删不掉不该把界面炸掉：下次列目录它还在，他会再点一次 */
  }
}
