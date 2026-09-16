import { inflateSync } from 'node:zlib'
import { Mdx } from '../../core/dict/mdx.ts'
import { nodeIO } from './adapters/io.ts'

/**
 * MDict 解析的 **Node 门面** · D-401 词典批（2026-08-30）
 *
 * 解析器本体搬进了 `core/dict/mdx.ts`（I/O 与 zlib 都改成注入端口 ——
 * D-238「将来 Android 照搬同一套，换掉的只应该是 io 那一个文件」兑现日）。
 * 这里只剩装配：node:fs 的 `DictionaryIO`（adapters/io.ts）+ node:zlib 的 inflate。
 *
 * `Mdict.open(path)` 的签名与行为对所有调用点（adapters / 取证脚本 / 测试）不变。
 */

export type { MdxMeta } from '../../core/dict/mdx.ts'

export type Mdict = Mdx
export const Mdict = {
  open(path: string): Mdx {
    return Mdx.open(path, nodeIO, (d) => inflateSync(d))
  }
}
