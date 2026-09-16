import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { bookCapabilities, type DictionaryCapability } from '@core/dict/capability.ts'
import {
  DictionaryOpenError,
  type DictionaryFileSet,
  type DictionaryIO,
  type DictionaryProbe,
  type RawRecord
} from '@core/dict/contract.ts'
import { diagnostics } from '@core/dict/diagnostics.ts'
import { dictUid } from '@core/dict/identity.ts'
import { identityOf } from '@core/dict/mdx-header.ts'
import { detectRedirect, keyRulesFromHeader } from '@core/dict/lookup.ts'
import { Mdict } from '../mdict.ts'
import { MddArchive, inventory } from '../mdd.ts'
import { probeMdict } from '../mdict-header.ts'
import { hasKey } from '../mdict-has.ts'
import type { BookAdapter, OpenBook } from './index.ts'

/**
 * MDict adapter · D2（2026-08-19）
 *
 * ══ 它做什么 ═══════════════════════════════════════════════
 *
 *   `claims`  只看扩展名 + 头部认不认得出来。**绝不抛**
 *   `probe`   只读头部 → 身份 / 能力 / 键规则 / 资源清单。**不建索引**
 *   `open`    真正装载（`Mdict`，软件今天跑的那一份，一个字没动）
 *
 * ══ 为什么 `probe` 要数资源包 ★★ ═══════════════════════════
 *
 * 「这本有没有发音」不是猜出来的，是**真的解 `.mdd` 的词表**数出来的。
 * `dict-regression.mjs` 里那句 `resources.map(() => 'mp3')` 是占位 ——
 * 它会把 LDOCE5 的 18.4 万条 Speex 当成 mp3，于是界面给一个按下去没声音的喇叭。
 * 那是这个项目最贵的一类 bug：**静默失效**，他会以为软件坏了。
 *
 * 数一遍要几百毫秒（只读词表段，不碰正文），所以 registry 会把结果**存进库**，
 * 文件没变就不再数第二遍（见 `registry.ts` 的 `fingerprintOf`）。
 */

/** 资源包解出来的那点结果，probe 与 registry 都要 */
export interface ResourceReport {
  name: string
  bytes: number
  ok: boolean
  count: number
  /** 扩展名 → 个数 */
  exts: [string, number][]
  why?: string
}

export function scanResources(
  files: DictionaryFileSet,
  io: DictionaryIO
): { reports: ResourceReport[]; extensions: string[] } {
  const reports: ResourceReport[] = []
  const extensions = new Set<string>()
  for (const path of files.resources) {
    let bytes = 0
    try {
      const h = io.open(path)
      bytes = h.size
      io.close(h)
    } catch {
      /* 大小读不到不影响下面数资源 */
    }
    const inv = inventory(path)
    for (const [e] of inv.extensions) extensions.add(e)
    reports.push({
      name: basename(path),
      bytes,
      ok: inv.ok,
      count: inv.count,
      exts: [...inv.extensions.entries()].sort((a, b) => b[1] - a[1]),
      ...(inv.ok ? {} : { why: inv.why })
    })
  }
  return { reports, extensions: [...extensions] }
}

function probeOf(files: DictionaryFileSet, io: DictionaryIO, withResources: boolean): DictionaryProbe {
  const p = probeMdict(files.main)
  if (!p.ok) {
    throw new DictionaryOpenError(
      p.why === 'size' || p.why === 'header-len' || p.why === 'no-attrs'
        ? diagnostics.notADictionary('文件太小或没有 MDict 头部', p.detail)
        : diagnostics.indexError(p.detail)
    )
  }

  const exts = withResources ? scanResources(files, io).extensions : []
  const caps: DictionaryCapability[] = bookCapabilities({
    format: p.format,
    resourceExtensions: exts,
    hasRedirects: false
  })

  const probe: DictionaryProbe = {
    title: p.title,
    format: 'mdict',
    /** ★★ 头部原字符串。parseFloat 一道就是另一个身份 —— 见 `identity.ts` 第二节之二 */
    formatVersion: p.versionRaw,
    encoding: p.declaredEncoding,
    entryCount: p.numEntries,
    blockCount: p.numKeyBlocks,
    /** ★★ 词条块段，不是 keyInfo 的长度 */
    indexBytes: p.keyBlocksLen,
    /**
     * ★★ T-4.15 · 身份原料的取法只有一份（`core/dict/mdx-header.ts::identityOf`）。
     *   这里原来自己拼一遍七个字段，与 `Mdx.identity` 靠注释声明同源 ——
     *   取错一项照样跑得通、照样算出 21 个不重复的 uid，只是和另一台机器上算的
     *   没有一个对得上，而且什么都不报。
     */
    uid: dictUid(identityOf(p)),
    capabilities: caps,
    keyRules: keyRulesFromHeader(p.attrs)
  }

  // 注册码加密的：probe 阶段就看得出来，不用等装载
  if (p.encFlags & 1) {
    probe.diagnostic = diagnostics.encrypted(
      `Encrypted=${p.attrs['Encrypted'] ?? ''} RegisterBy=${p.registerBy}`
    )
  }
  return probe
}

export const mdictAdapter: BookAdapter = {
  format: 'mdict',
  mainExtensions: ['.mdx'],

  /**
   * 同一本的资源包：同目录、同词干、`.mdd` 结尾。
   * 分卷有好几种写法，实测他机器上两种都有：
   *   `oald10-V1_4.mdd` / `.1.mdd` / `.2.mdd` / `.3.mdd`
   *   `Longman Dictionary of Contemporary English.mdd` / `… (1).mdd`
   * 所以判据是「以词干打头」，不是「等于词干」。
   */
  collect(main, siblings) {
    const stem = main.replace(/\.mdx$/i, '').toLowerCase()
    const resources: string[] = []
    const loose: string[] = []
    for (const f of siblings) {
      const lf = f.toLowerCase()
      if (lf.endsWith('.mdd') && lf.startsWith(stem)) resources.push(f)
      else if (!lf.endsWith('.mdx') && !lf.endsWith('.mdd')) loose.push(f)
    }
    return { resources, loose }
  },

  /**
   * ★ **只看扩展名**，头部读不读得出来一概不管。
   *
   *   `_._TLD.mdx` 是 macOS 压缩包带出来的 172 字节附属文件，头部当然读不出来。
   *   但认领它才是对的 —— 认领了，`probe` 才会给出「这不是词典文件，可以直接删掉」
   *   那句人话。不认领它就成了「列表里没有、也没人说为什么」，
   *   他会以为软件没发现这个文件。**失败要看得见**（D-262）。
   */
  claims(files, _io) {
    return files.main.toLowerCase().endsWith('.mdx')
  },

  probe(files, io) {
    return probeOf(files, io, true)
  },

  /**
   * ★★ D5.2 · 不建索引就回答「收没收这个词」。判据与实现见 `mdict-has.ts`。
   *   头部读不出来（`_._TLD.mdx` 那种）就是「没有」—— 这一问不负责报错，
   *   真正的诊断在 `registry.handle()` 那边。
   */
  hasWord(files, _io, key) {
    const p = probeMdict(files.main)
    if (!p.ok) return false
    return hasKey(files.main, p, key)
  },

  open(files, io): OpenBook {
    let m: Mdict
    try {
      m = Mdict.open(files.main)
    } catch (err) {
      throw new DictionaryOpenError(classify(err))
    }
    // 装载之后 probe 不必再数一遍资源（registry 已经存过），所以这里 withResources = false
    const meta = probeOf(files, io, false)

    /** 资源包**按需**打开 —— 一本 oald10 的四个包共 2.1 GB，不该在装载时碰 */
    let archives: MddArchive[] | null = null
    const openArchives = (): MddArchive[] => {
      if (archives) return archives
      archives = []
      for (const path of files.resources) {
        try {
          archives.push(MddArchive.open(path))
        } catch {
          /** 一个包坏了不影响别的包 —— 诊断由 registry 那边的清单负责 */
        }
      }
      return archives
    }

    return {
      meta,
      wordCount: m.wordCount,
      legacyText: (word) => m.lookup(word),
      match: (query) => (m.has(query) ? [query.trim().toLowerCase()] : []),
      raw: (headword, occurrence = 0): RawRecord | null => {
        /**
         * ★★ D2 的已知边界：老索引是「小写键 → 第一条」，同形异义在**建索引那一刻**
         *   就丢了（实测 OALD10 丢 6909 条、UrbanDictionary 丢 7254 条）。
         *   所以 `occurrence > 0` 一律 null，`match()` 也只会给一条。
         *
         *   **不在 D2 修**：修它要把索引换成「键 → 词目 → 偏移[]」，
         *   那会让 TLD（436 万词目）的常驻内存翻倍，而老路径这时还占着另一份索引。
         *   D3 删掉 `legacyText` 的同时换索引，两份内存不会叠在一起。
         *   `tests/db-safety.ts` 里有一条用例把这个边界钉住了 ——
         *   D3 改对之后它会红，那是好事。
         */
        if (occurrence !== 0) return null
        const body = m.rawOf(headword)
        if (body === null) return null
        const to = detectRedirect(body)
        return { body, shape: 'html', ...(to ? { redirectTo: to } : {}) }
      },
      keys: () => m.keys(),
      resource: async (key: string) => {
        for (const a of openArchives()) {
          const buf = a.get(key)
          if (buf) return new Uint8Array(buf)
        }
        /**
         * ★ 资源不一定在 `.mdd` 里 —— 也可能是**同目录的散文件**。
         *   实测：OALD10 的样式表 `oald10.css`（186 KB）就躺在目录里，
         *   词条 HTML 用 `<link href="oald10.css">` 引它；
         *   而朗文6 的 `ldoce6ec.css` 在 `.mdd` 里面。两条路都要走得通。
         *
         * ★ 只按**文件名**匹配 `files.loose` 里已经登记过的那些 ——
         *   绝不把 key 当路径去拼（`..\..\Windows\…` 那种事一次都不能有）。
         */
        const want = key.replace(/^[\\/]+/, '').toLowerCase()
        for (const f of files.loose) {
          if (basename(f).toLowerCase() !== want) continue
          try {
            return new Uint8Array(readFileSync(f))
          } catch {
            return null
          }
        }
        return null
      },
      close: () => {
        m.close()
        for (const a of archives ?? []) a.close()
        archives = null
      }
    }
  }
}

/**
 * 装载异常 → 一条诊断。
 *
 * ★ 判据故意保守：认得出来的四种各有各的话术，认不出来的落 `fromUnknownError`
 *   —— 它说的是「还没认出来」，不是瞎猜一个。猜错的诊断比没有诊断更糟：
 *   他会照着错的建议去改文件。
 */
export function classify(err: unknown): ReturnType<typeof diagnostics.lzo> {
  const msg = err instanceof Error ? err.message : String(err)
  /**
   * ★ `detail` 放**完整**的原始异常文本，不是截掉的第一行。
   *   两个理由：
   *     ① 它是给我看的（日志、数据体检），截了就少了排查线索；
   *     ② `DictRow.problem` 现在正是从这里取的 —— D2 是行为等价重构，
   *        设置页上那句话必须和改造前**逐字相同**。
   *        第一版截成一行，`dict-behavior` 对拍当场红了两条（两本 LZO）。
   */
  if (/LZO/.test(msg)) return diagnostics.lzo(msg)
  if (/加密/.test(msg)) return diagnostics.encrypted(msg)
  if (/不完整|对不上|没下完/.test(msg)) return diagnostics.corrupted(msg)
  if (/不认识的压缩方式/.test(msg)) return diagnostics.unknownCompression(msg)
  return diagnostics.indexError(msg)
}
