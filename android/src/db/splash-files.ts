/**
 * 启动页图片的**本机库** —— 图从电脑那边同步过来（使用者 2026-09-13）
 *
 * ══ 图是怎么来的 ★★ ════════════════════════════════════════
 * 使用者 2026-09-13 原话：「不要有在手机端相册传图的功能，
 * **图片要是电脑端同步进来的**。只保留这一个入口」。
 * 所以这一端**只收不传**：
 *   电脑那边把图放进桶（`nyx/splash/`）→ 同步引擎调 `AssetPort.write`
 *   → 落到 `Data/splash/<sha256>.<ext>` → 这一页把它列成候选。
 * ★ 手机上**没有**「选一张相册里的图」这个入口 —— 那是他明确不要的。
 *   顺带省掉一整套：在手机上算 2 MB 图的 sha256（这台 WebView 没有
 *   `crypto.subtle`，只能纯 JS 算）、大小闸、格式闸，全都不必存在。
 *
 * ══ 名字为什么是内容哈希 ════════════════════════════════════
 * 判据在 core（`core/splash-name.ts`）：**内容 sha256 的 64 位十六进制 + 扩展名**。
 * 名字是**从外部（桶）拿来拼本地路径**的，所以写盘之前一律过 `checkSplashName`
 * —— 白名单不是黑名单：桶里放一个 `..%2F..%2Fevil` 就能写到目录外去。
 * 「桶是他自己的」是假设不是保证（key 泄漏、桶设成公开可写、将来共享桶）。
 *
 * ══ 「删掉」是怎么回事 ★（2026-09-14 改写：上一版这段已经成了假话）════
 * 这里原来写着「`AssetPort` 只有 list / read / write，**故意没有 delete** ——
 * 资源没有墓碑，本地删了下次同步会再下回来」。那是 2026-09-09 的事实。
 * 使用者 2026-09-14 裁「选 a：连桶一起删」之后，墓碑做出来了、`delete` 成了**必填**，
 * 这个文件底下就有 `deleteSplashFile` —— **注释再不改就是在教下一个人一件不存在的事**。
 * 现在的规矩：
 *   · 删除**在哪一端发起都行**，发起那一端立碑（`<name>.meta.json` 的 `gone:true`）
 *   · 另一端读到碑 → 引擎叫 `AssetPort.delete` → 本机那份也没（**服从删除**）
 *   · 这一端**没有**发起删除的入口（他要删就在电脑上删），所以下面那个只服从、不立碑
 */
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import { checkSplashName } from '../core-link.ts'

/** 图片落在哪（Data 目录下）—— 与 `audio/` 并列 */
export const SPLASH_DIR = 'splash'

export async function ensureSplashDir(): Promise<void> {
  try {
    await Filesystem.mkdir({ directory: Directory.Data, path: SPLASH_DIR, recursive: true })
  } catch {
    /* 已经有了 —— mkdir 在这种情况下会抛，不是错 */
  }
}

/** 本机有哪些图（只认过得了 core 白名单的名字） */
export async function listSplashFiles(): Promise<string[]> {
  try {
    await ensureSplashDir()
    const r = await Filesystem.readdir({ directory: Directory.Data, path: SPLASH_DIR })
    return r.files.map((f) => f.name).filter((n) => checkSplashName(n).ok)
  } catch {
    return []
  }
}

export async function readSplashFile(name: string): Promise<string | null> {
  if (!checkSplashName(name).ok) return null
  try {
    const r = await Filesystem.readFile({
      directory: Directory.Data,
      path: `${SPLASH_DIR}/${name}`
    })
    return typeof r.data === 'string' ? r.data : null
  } catch {
    return null
  }
}

export async function writeSplashFile(name: string, b64: string): Promise<void> {
  /**
   * ★ 名字来自**桶**（引擎在调它之前已经验过一次）。这里再验一次是有意的：
   *   这是落盘前的最后一道，防的是绕过引擎直接调它的人。
   *   两道都在，是因为这是全仓**唯二**「拿外部名字拼本地路径」的地方之一。
   */
  if (!checkSplashName(name).ok) return
  await ensureSplashDir()
  await Filesystem.writeFile({
    directory: Directory.Data,
    path: `${SPLASH_DIR}/${name}`,
    data: b64
  })
}

/**
 * 这张图在 WebView 里用什么地址加载。
 * ★ 拿不到就给 null，调用方按「这张图现在显示不了」处理，别拼一个假地址。
 */
export async function splashFileUrl(name: string): Promise<string | null> {
  if (!checkSplashName(name).ok) return null
  try {
    const { uri } = await Filesystem.getUri({
      directory: Directory.Data,
      path: `${SPLASH_DIR}/${name}`
    })
    return Capacitor.convertFileSrc(uri)
  } catch {
    return null
  }
}

/**
 * ══ 服从一次删除（使用者 2026-09-14 裁「选 a：连桶一起删」）★★★ ═════
 *
 * ★★ **这不是界面上那颗按钮。** 他在**哪一端**按的删除，另一端都走这条路：
 *   引擎从桶里读到墓碑（`<name>.meta.json` 里 `gone: true`）之后叫它，
 *   把本机那一份也删掉。「谁发起」是界面的事，「怎么服从」是这里的事。
 *
 * ★ **文件本来就不在 = 成功**（幂等）。同步能中途断、能重跑，
 *   「删一个已经没有的文件」必须安全，否则重跑一次自己就红了。
 *
 * ★★ **一个字都不抛。** 这一路抛出去会把**整趟同步带停**，而代价只是这一张图
 *   这一轮没删掉 —— 下一趟还会再试。所以名字不合规、文件不在、系统不让删，
 *   一律安静返回。
 *   ☞ 名字那一关用同一份白名单（`checkSplashName`）：这里是**拿外部名字拼本地路径**
 *     的地方之一，读写都验过，删也得验 —— 不验的话一个 `../` 就能删到别处去。
 */
export async function deleteSplashFile(name: string): Promise<void> {
  if (!checkSplashName(name).ok) return
  try {
    await Filesystem.deleteFile({
      directory: Directory.Data,
      path: `${SPLASH_DIR}/${name}`
    })
  } catch {
    /* 本来就不在 / 删不掉 —— 都不该把整趟同步带停 */
  }
}
