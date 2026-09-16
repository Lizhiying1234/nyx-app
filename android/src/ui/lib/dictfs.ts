/**
 * 词典文件面（JS 半场，D-401 词典批）：
 *   · SAF 选夹 / 列 .mdx / .mdd / .css —— NyxDict 插件
 *   · **随机读** —— `nyxDictHost`（原生 `DictPlugin.DictHost` → `DictFiles.java`），
 *     与 Assist 引擎那条同一份实现（T-5.10）
 *   · 字节源（兜底）—— convertFileSrc(content://…) + fetch，整本进内存
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { nativeDictIo, type NativeDictHost } from '../../db/dict-io.ts'
import { classifyDictFiles } from '../../db/dict.ts'
import type { FolderFile, FolderLimits, FolderListing, IoProvider } from '../../db/dict.ts'

interface NyxDictPlugin {
  pickFolder(): Promise<{ uri: string | null }>
  /**
   * ★ T-5.16 · 契约变了：**递归**（条目带相对目录 `dir`）、而且原生**一条都不筛** ——
   *   `config.ini` 那些也回来，由 `classifyDictFiles` 判。`limits` 带着「没看全」的事实。
   */
  listFolder(o: { uri: string }): Promise<{ files: FolderFile[]; limits?: FolderLimits }>
}
const NyxDict = registerPlugin<NyxDictPlugin>('NyxDict')

/** 打开系统文件夹选择器；用户取消返回 null */
export async function pickDictFolder(): Promise<string | null> {
  const r = await NyxDict.pickFolder()
  return r.uri ?? null
}

/**
 * 列夹子并当场分类。★ 判据与话术都在 `db/dict.ts` 那一份 ——
 * 这里只负责把原生给的事实喂进去（T-5.16）。
 */
export async function listDictFolder(uri: string): Promise<FolderListing> {
  const r = await NyxDict.listFolder({ uri })
  return classifyDictFiles(r.files ?? [], r.limits)
}

/**
 * ★★ T-5.10 · App 这一侧的真随机读。
 *
 * `nyxDictHost` 是 `DictPlugin.load()` 挂上来的 JS 接口（同步 JS→Java），
 * 与 Assist 引擎的 `nyxHost.dictSize/dictRead` **方法名逐字相同** ——
 * 所以两边装的是同一个 `DictionaryIO`（`db/dict-io.ts`），不是两份写得像的。
 *
 * 拿不到就返回 null：调用方退回整本进内存那条老路，并且
 * `globalThis.nyxDb.dictIo` 会报 `memory` —— 不静默降级。
 */
export function uiDictIo(): IoProvider | null {
  const host = (globalThis as { nyxDictHost?: NativeDictHost }).nyxDictHost
  if (!host || typeof host.dictRead !== 'function') return null
  return (uri: string) => nativeDictIo(host, uri)
}

/**
 * content:// → 本地服务器 URL → 整本字节。
 * ★ 只在**没有** `nyxDictHost` 时才走得到（PC 预览、或者通道没挂上）——
 *   大书会在这里失败，而失败现在**说得出原因**（不再被 hitOf 吞掉）。
 */
export async function uiDictBytes(uri: string): Promise<Uint8Array> {
  const src = Capacitor.convertFileSrc(uri)
  const r = await fetch(src)
  if (!r.ok) throw new Error(`读不了词典文件（HTTP ${r.status}）—— 文件夹权限可能丢了，重选一次。`)
  return new Uint8Array(await r.arrayBuffer())
}
