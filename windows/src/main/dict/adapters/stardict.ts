import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bookCapabilities } from '@core/dict/capability.ts'
import {
  DictionaryOpenError,
  type DictionaryFileSet,
  type DictionaryProbe,
  type RawRecord
} from '@core/dict/contract.ts'
import { diagnostics } from '@core/dict/diagnostics.ts'
import { dictUid } from '@core/dict/identity.ts'
import { detectRedirect, DEFAULT_KEY_RULES } from '@core/dict/lookup.ts'
import { extensionOf } from '@core/dict/media.ts'
import { StarDict } from '../stardict.ts'
import type { BookAdapter, OpenBook } from './index.ts'

/**
 * StarDict adapter · D2（2026-08-19）
 *
 * ══ 它存在的意义是那句判据 ★★ ══════════════════════════════
 *
 *     「加 StarDict 那天，registry、IPC、renderer 应该一个字都不用改。」
 *
 * D2 之前那句判据是**假的**：`index.ts` 里写着
 * `path.endsWith('.mdx') ? Mdict.open(path) : StarDict.open(path)`，
 * `scanDicts()` 里还有第二份扩展名分支。
 * 现在两种格式各是一个 adapter，registry 里一个扩展名都没有。
 *
 * ══ 身份分量从哪来 ═════════════════════════════════════════
 *
 *   formatVersion  `.ifo` 的 `version`（**原字符串**，和 MDict 同一条规矩）
 *   encoding       StarDict 规定就是 UTF-8，头部不写，所以填 `UTF-8`
 *   title          `.ifo` 的 `bookname`
 *   entryCount     `.ifo` 的 `wordcount`（**声明值**，不是建出来的索引大小）
 *   blockCount     没有这个概念 → 缺省（`ABSENT`）
 *   indexBytes     `.idx` 的字节数 —— 它就是「词条索引段的字节数」
 *
 * ★ 少一个分量意味着区分力低一档（`identityStrength` 会给 `counts` 而不是 `strong`），
 *   registry 认领时会因此更谨慎地再比一次文件名。这是有意的，不是漏了。
 */

function parseIfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** StarDict 的资源在 `res/` 目录里（不是打包文件）—— 有就数一遍扩展名 */
function resourceExtensions(folder: string): string[] {
  const dir = join(folder, 'res')
  if (!existsSync(dir)) return []
  const exts = new Set<string>()
  try {
    for (const n of readdirSync(dir)) {
      const e = extensionOf(n)
      if (e) exts.add(e)
    }
  } catch {
    /* 读不了就是没有 */
  }
  return [...exts]
}

function probeOf(files: DictionaryFileSet): DictionaryProbe {
  let ifo: Record<string, string>
  try {
    ifo = parseIfo(readFileSync(files.main, 'utf8'))
  } catch (err) {
    throw new DictionaryOpenError(
      diagnostics.notADictionary('这个 .ifo 读不了', err instanceof Error ? err.message : String(err))
    )
  }
  if (!ifo['bookname'] && !ifo['wordcount']) {
    throw new DictionaryOpenError(diagnostics.notADictionary('这个 .ifo 里没有 StarDict 的字段'))
  }

  const stem = files.main.replace(/\.ifo$/i, '')
  const indexBytes = sizeOf(stem + '.idx') || sizeOf(stem + '.idx.gz')
  const title = ifo['bookname'] ?? ''
  const entryCount = Number(ifo['wordcount'] ?? 0)

  return {
    title,
    format: 'stardict',
    formatVersion: (ifo['version'] ?? '').trim(),
    encoding: 'UTF-8',
    entryCount: Number.isSafeInteger(entryCount) ? entryCount : 0,
    /** StarDict 没有词块的概念 —— 缺席比编一个数好（`normInt` 会落成 ABSENT） */
    blockCount: -1,
    indexBytes,
    uid: dictUid({
      format: 'stardict',
      formatVersion: (ifo['version'] ?? '').trim() || null,
      encoding: 'UTF-8',
      title: title || null,
      entryCount,
      blockCount: null,
      indexBytes
    }),
    capabilities: bookCapabilities({
      // `.ifo` 的 `sametypesequence` 说正文是什么形状
      format: (ifo['sametypesequence'] ?? '').includes('h') ? 'Html' : 'Text',
      resourceExtensions: resourceExtensions(dirname(files.main)),
      hasRedirects: false
    }),
    /** StarDict 没有 KeyCaseSensitive / StripKey 这两个头部属性，用缺省 */
    keyRules: DEFAULT_KEY_RULES
  }
}

export const starDictAdapter: BookAdapter = {
  format: 'stardict',
  mainExtensions: ['.ifo'],

  /** `.idx` / `.dict(.dz)` 是同一本的一部分；`res/` 里的资源目前不参与 */
  collect(main, siblings) {
    const stem = main.replace(/\.ifo$/i, '').toLowerCase()
    return {
      resources: [],
      loose: siblings.filter((f) => f.toLowerCase().startsWith(stem))
    }
  },

  claims(files) {
    if (!files.main.toLowerCase().endsWith('.ifo')) return false
    try {
      const ifo = parseIfo(readFileSync(files.main, 'utf8'))
      return Boolean(ifo['bookname'] || ifo['wordcount'])
    } catch {
      return false
    }
  },

  probe(files) {
    return probeOf(files)
  },

  open(files): OpenBook {
    let d: StarDict
    try {
      d = StarDict.open(files.main)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new DictionaryOpenError(
        // detail 放完整原文 —— `DictRow.problem` 从这里取，D2 不许变
        /少了|不完整/.test(msg) ? diagnostics.corrupted(msg) : diagnostics.indexError(msg)
      )
    }
    const meta = probeOf(files)
    return {
      meta,
      wordCount: d.wordCount,
      legacyText: (word) => d.lookup(word),
      match: (query) => {
        const k = query.trim().toLowerCase()
        return d.rawOf(k) === null ? [] : [k]
      },
      raw: (headword, occurrence = 0): RawRecord | null => {
        // 老索引同样是「一个词目一条」—— 边界与 MDict 那边一样，见那边的注释
        if (occurrence !== 0) return null
        const body = d.rawOf(headword)
        if (body === null) return null
        const to = detectRedirect(body)
        return { body, shape: d.shape, ...(to ? { redirectTo: to } : {}) }
      },
      keys: () => d.keys(),
      /**
       * StarDict 的资源是 `res/` 下的散文件，不是打包的。
       * 他那台机器上一本 StarDict 都没有（22 本全是 MDict），
       * 所以这里**老实返回 null**，等真有人放一本进来再按需求做 ——
       * 编一个读不到东西的实现，比明说没有更糟。
       */
      resource: async () => null,
      close: () => d.close()
    }
  }
}

export { parseIfo }
