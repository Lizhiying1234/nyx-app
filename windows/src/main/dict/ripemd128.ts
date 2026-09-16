import {
  mdxDecryptKeyInfo as coreDecrypt,
  ripemd128 as coreRipemd128
} from '../../core/dict/ripemd128.ts'

/**
 * RIPEMD-128 的 **Node 门面** · D-401 词典批（2026-08-30）
 *
 * 算法本体搬进 `core/dict/ripemd128.ts`（纯数学，Uint8Array 进出，两端共用）。
 * 这里只做 Buffer 包装 —— 老调用点（mdict-header 等）拿到的仍是 Buffer，
 * 一个字不用改。只在带混淆索引的词典 probe 路径上各多一次拷贝，量级是 KB。
 */

export function ripemd128(input: Buffer): Buffer {
  return Buffer.from(coreRipemd128(input))
}

export function mdxDecryptKeyInfo(block: Buffer): Buffer {
  return Buffer.from(coreDecrypt(block))
}
