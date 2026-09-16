import { closeSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
/**
 * ★ 这一条**用相对路径**，不用 `@core/…` 别名。
 *   别名是 electron-vite / tsconfig 给的，裸 node 解不开；
 *   而真词典回归脚本（`scripts/dict-regression.mjs`）就是用裸 node 直接 import 这一族模块的（取证脚本 dict-rich-probe 已于 2026-09-04 删除，同一条理由仍成立）。
 *   写成别名的话，打包能过、脚本一跑就 `ERR_MODULE_NOT_FOUND` ——
 *   又一处「我验的那份和跑的那份不是同一份」。
 */
import { normalizeResourceKey, extensionOf } from '../../core/dict/media.ts'
import {
  decompressBlock,
  probeMdict,
  readKeys,
  readRecordIndex,
  type MdictProbeOk,
  type RecordBlock
} from './mdict-header.ts'

/**
 * MDict 资源包（`.mdd`）· D2（2026-08-19）
 *
 * ══ 它解决的是「当前可达性 0」★★ ═══════════════════════════
 *
 * 实测他机器上 17 个 `.mdd`、83.8 万个资源、5.34 GB：
 *
 *   oald10        273,864 条 mp3 + 2009 张 png + 35 个 svg + 18 个 ttf
 *   朗文6          181,390 条 mp3 + 1038 张图
 *   LDOCE5        184,485 条 **spx**（浏览器放不了）+ 1225 张图 · 而且**有两份一模一样的包**
 *   LCDT          8,468 条 mp3
 *
 * 在 D2 之前，软件对这些文件**一无所知** —— 连「这本有没有发音」都答不上来。
 *
 * ══ 两件事，分开做 ═════════════════════════════════════════
 *
 *   `inventory()`  只读词表 → 有几个资源、都是什么扩展名。**给 probe 用**
 *   `open()`       建键索引 + 正文分块索引 → 能按键取字节。**给 D3 渲染用**
 *
 * `inventory()` 不建索引也不解正文块，所以 rescan 时问「这本有没有发音」很便宜；
 * 真要取一条 mp3 的字节才走 `open()`。
 *
 * ══ 键的写法 ═══════════════════════════════════════════════
 *
 * `.mdd` 里存的是**词典内部**的名字（`\brunt__gb_1.mp3`），不是文件系统路径。
 * 正文 HTML 里写的是 `sound://brunt__gb_1.mp3` / `img/spkr_r.png` 这些花样，
 * 归一规则的唯一出处是 `core/dict/media.ts::normalizeResourceKey`（两端共用）。
 */

export interface MddInventory {
  ok: boolean
  /** 解不开时的原因（`LZO` / `exception` …） */
  why?: string
  detail?: string
  /** 词表里的资源个数 */
  count: number
  /** 扩展名 → 个数。`bookCapabilities` 靠它算「有没有发音 / 有没有图」 */
  extensions: Map<string, number>
}

/**
 * 只数一遍**有什么**，不建索引。
 * 一个 1.1 GB 的 `.mdd` 也只读词表段（几 MB），几百毫秒。
 */
export function inventory(path: string): MddInventory {
  const p = probeMdict(path, { mdd: true })
  if (!p.ok) return { ok: false, why: p.why, detail: p.detail, count: 0, extensions: new Map() }

  const extensions = new Map<string, number>()
  let count = 0
  const r = readKeys(path, p, (key) => {
    count++
    const ext = extensionOf(key) || '(无扩展名)'
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1)
  })
  if (!r.ok) return { ok: false, why: r.why, detail: r.detail, count, extensions }
  return { ok: true, count, extensions }
}

/**
 * 一个装载好的资源包 —— 能按键取字节。
 *
 * ★ 和 `Mdict` 的 `readStream` 有一处**关键差别**：不许按 NUL 截断。
 *   正文是文本，遇到 NUL 截断是对的；资源是二进制，
 *   一张 png 里第一个 0x00 通常出现在头几个字节 —— 截了就全毁了。
 */
export class MddArchive {
  private fd: number | null = null
  /** 归一后的键 → 在解压后正文流里的偏移 */
  private index = new Map<string, number>()
  /** 有序的偏移，用来算每条的结束位置 */
  private offsets: number[] = []
  private blocks: RecordBlock[] = []

  /**
   * ★ 字段**显式声明**，不用 TS 的「构造参数即属性」写法。
   *   Node 的 type-stripping（`--experimental-strip-types`）不支持那种写法，
   *   而取证脚本就是用裸 node 直接 import 这个模块的 ——
   *   写成参数属性的话，脚本一跑就是 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
   *   （打包能过、脚本过不了：又一处「我验的那份和跑的那份不是同一份」）。
   */
  readonly path: string
  private probe: MdictProbeOk

  private constructor(path: string, probe: MdictProbeOk) {
    this.path = path
    this.probe = probe
  }

  static open(path: string): MddArchive {
    const p = probeMdict(path, { mdd: true })
    if (!p.ok) throw new Error(`${basename(path)} 不是可读的资源包（${p.why}）：${p.detail}`)
    const a = new MddArchive(path, p)
    const r = readKeys(path, p, (key, at) => {
      const k = normalizeResourceKey(key)
      if (!a.index.has(k)) a.index.set(k, at)
    })
    if (!r.ok) throw new Error(`${basename(path)} 的词表解不开（${r.why}）：${r.detail}`)
    const blocks = readRecordIndex(path, p)
    if (!blocks) throw new Error(`${basename(path)} 的正文段读不了`)
    a.blocks = blocks
    a.offsets = [...new Set(a.index.values())].sort((x, y) => x - y)
    return a
  }

  get count(): number {
    return this.index.size
  }

  keys(): Iterable<string> {
    return this.index.keys()
  }

  has(key: string): boolean {
    return this.index.has(normalizeResourceKey(key))
  }

  /** 取一个资源的字节。取不到返回 null（**不抛** —— 少一张图不该让查词炸掉） */
  get(key: string): Buffer | null {
    const at = this.index.get(normalizeResourceKey(key))
    if (at === undefined) return null
    const i = this.offsets.indexOf(at)
    const end = i >= 0 && i + 1 < this.offsets.length ? this.offsets[i + 1]! : Infinity
    try {
      return this.read(at, end)
    } catch {
      return null
    }
  }

  private read(from: number, to: number): Buffer | null {
    if (this.fd === null) this.fd = openSync(this.path, 'r')
    const parts: Buffer[] = []
    for (const b of this.blocks) {
      if (b.end <= from) continue
      if (b.start >= to) break
      const comp = Buffer.alloc(b.compLen)
      readSync(this.fd, comp, 0, b.compLen, b.fileAt)
      const plain = decompressBlock(comp)
      const s = Math.max(0, from - b.start)
      const e = Math.min(plain.length, to - b.start)
      parts.push(plain.subarray(s, e))
      if (b.end >= to) break
    }
    if (parts.length === 0) return null
    // ★ 二进制：**不按 NUL 截断**
    return Buffer.concat(parts)
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd)
      this.fd = null
    }
  }

  /** 头部里那点元数据，诊断时要看 */
  get meta(): { version: string; entries: number } {
    return { version: this.probe.versionRaw, entries: this.probe.numEntries }
  }
}
