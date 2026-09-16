/**
 * 原生真随机读的 JS 面 —— **两个 WebView 装的是同一份**（T-5.10）。
 *
 * ══ 为什么有这个文件 ═══════════════════════════════════════════
 *
 * 在这之前，随机读只活在 `src/engine/main.ts` 里（Assist 引擎的无头 WebView）。
 * App 那一侧（Lookup / 设置）只有 `bytesProvider`：`convertFileSrc + fetch`
 * **把整本 .mdx 读进内存**，最多驻 2 本。两个后果，都是使用者报过的形状：
 *   · 大书装不下 → 查词抛异常 → 被 `hitOf` 吞成「这本里没有」（静默）
 *   · 音频卷 1 GB 级 → 不可能进内存 → Lookup 里的 `sound://` 永远播不了
 *
 * 现在原生那半在 `DictFiles.java`（引擎与 App 各挂一个 JS 接口，方法名逐字
 * 相同），JS 这半就是本文件 —— 于是「同一个 `DictionaryIO`」是**机械保证**，
 * 不是「两边写得像」。
 *
 * ★ 这里**一行判据都没有**：只有 base64 解码和三个转手。
 *   词典格式、键归一、重定向、诊断话术全在 core。
 */
import type { DictionaryIO, FileHandle } from '../core-link.ts'

/**
 * 原生那侧挂上来的接口。
 *   引擎：`nyxHost`（`AssistEngine.Host`，还带着 sql / secret / http 等等）
 *   App ：`nyxDictHost`（`DictPlugin.DictHost`，只有这两个方法）
 * 结构上都满足这个形状 —— 所以下面那个工厂两边通用。
 */
export interface NativeDictHost {
  /** 文件多大；< 0 = 读不到 */
  dictSize(uri: string): number
  /** 从 at 读 len 字节，回 base64 */
  dictRead(uri: string, at: number, len: number): string
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 原生随机读 → core 的 `DictionaryIO`。
 *
 * ★ `open` 在读不到时**抛**（不是返回 size 0）：读不到是「这本书出事了」，
 *   不是「这本里没有这个词」。T-5.10 修的正是这两件事被混为一谈。
 * ★ `read` 读到尾返回短的、不抛 —— 契约原文（`core/dict/contract.ts`）。
 */
export function nativeDictIo(host: NativeDictHost, uri: string): DictionaryIO {
  return {
    open(path: string): FileHandle {
      const size = host.dictSize(uri)
      if (size < 0) throw new Error('词典文件读不到（权限丢了，或文件已经挪走）')
      return { path, size }
    },
    read(_h: FileHandle, at: number, len: number): Uint8Array {
      return fromB64(host.dictRead(uri, at, len))
    },
    close(): void {
      /* 句柄按 uri 缓存在原生侧（DictFiles 的 LRU），这一层不持有 */
    }
  }
}
