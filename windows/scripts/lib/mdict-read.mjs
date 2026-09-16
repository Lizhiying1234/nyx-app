#!/usr/bin/env node
/**
 * MDict 头部与词表的只读解析 —— **转发给生产代码**（D2 起）
 *
 * ══ 为什么只剩一行 ★★ ══════════════════════════════════════
 *
 * D1 那会儿这份解析写在脚本里（`src/main/dict/mdict.ts` 是软件在跑的那一份，
 * D1 一个字节都不许动它）。D2 把 adapter 做出来之后，
 * 它成了**生产代码** `src/main/dict/mdict-header.ts`。
 *
 * 取证脚本必须和软件量的是**同一把尺子** ——
 * 两份「差不多的解析」会让扫描报告和软件各说各话，
 * 而身份的两个取值约定（formatVersion 原字符串 / indexBytes = keyBlocksLen）
 * 一旦在两边漂开，第二台设备就一本词典都认不出来，还什么都不报。
 *
 * 所以这里只做转发。用的人不用改（`dict-scan.mjs` / `dict-lookup-check.mjs`）。
 */

const repo = new URL('../../', import.meta.url).href
const m = await import(repo + 'src/main/dict/mdict-header.ts')

export const { decompressBlock, headerAttrs, encryptedFlags, probeMdict, readKeys, readRecordIndex } = m
