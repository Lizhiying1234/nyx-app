import type {
  DictionaryAdapter,
  DictionaryFileSet,
  DictionaryIO,
  OpenDictionary
} from '@core/dict/contract.ts'
import { mdictAdapter } from './mdict.ts'
import { starDictAdapter } from './stardict.ts'

/**
 * Adapter 清单 · D2（2026-08-19）
 *
 * ══ 判据（他 D1 时的原话）★★ ═══════════════════════════════
 *
 *     业务层不认识具体格式。新增一种格式 = 新增一个 Adapter，别处一行不改。
 *
 * 具体到代码：**加第三种格式，只该往下面这个数组里加一项。**
 * `registry.ts` 里没有任何一处 `endsWith('.mdx')`，
 * `index.ts` 里那句 `path.endsWith('.mdx') ? Mdict.open : StarDict.open` 也没了。
 *
 * 顺序 = 认领优先级：第一个 `claims()` 说是的赢。
 */
export const ADAPTERS: readonly BookAdapter[] = [mdictAdapter, starDictAdapter]

/**
 * 一本装载好的词典。契约 `OpenDictionary` + **两样 D2 的过渡品**。
 *
 * ── 为什么要有过渡品 ★★ ───────────────────────────────────
 *
 * D2 是**行为等价重构**：`lookup` / `lookupCard` / `examples` 对外一个字不许变。
 * 而老路径拿的是 `toText()` 压平后的文本、新契约 `raw()` 拿的是原始 HTML ——
 * 两者不是同一样东西。所以 D2 让它们**并存**：
 *
 *   `legacyText()`  老路径逐字不变（`scripts/dict-behavior-baseline.json` 守着）
 *   `raw()`         新契约，D3 接 `lookup.ts` 时才真正启用
 *
 * **D3 的第一件事就是删掉 `legacyText`**，那时老路径整条退休。
 */
export interface OpenBook extends OpenDictionary {
  /** ★ D2 过渡：老 `lookup()` 走的那条路，逐字不变。D3 删 */
  legacyText(word: string): string | null
  /**
   * 建成的索引大小。
   * ★ 注意它**不等于**头部声明的词条数（`meta.entryCount`）——
   *   索引会因为大小写归一而去重（OALD10：283811 → 276902）。
   *   设置页上那个「多少词」显示的一直是这一个，D2 不许改。
   */
  readonly wordCount: number
}

export interface BookAdapter extends DictionaryAdapter {
  /**
   * 主文件的扩展名（小写、带点）。
   * ★ **扫描目录时唯一的格式知识就在这里** —— registry 里一个 `.mdx` 都没有。
   */
  readonly mainExtensions: readonly string[]
  /**
   * 同一本词典的其余文件：资源包 + 同目录散件。
   * 不实现就是「没有资源包，同目录的都算散件」。
   */
  collect?(main: string, siblings: readonly string[]): { resources: string[]; loose: string[] }
  open(files: DictionaryFileSet, io: DictionaryIO): OpenBook
  /**
   * 「这本收没收这个词」· ★★ D5.2 · **可选**
   *
   * 只回答一个布尔值，**不建全量索引**。`lookupCard` 末尾要列「别的哪几本也有它」，
   * 从前的做法是把其余每一本都装载一遍再问 —— 实测其余 20 本 6542 ms，
   * 为了一个布尔值建了 790 万条索引。
   *
   * ★ 不实现就退回老路（装载再问）。StarDict 的索引本来就是一个小文件，
   *   装载几乎免费，没必要为它再写一套。
   */
  hasWord?(files: DictionaryFileSet, io: DictionaryIO, key: string): boolean
}

/** 哪个 adapter 认这组文件。都不认就是 null（那多半根本不是词典） */
export function adapterFor(
  files: DictionaryFileSet,
  io: DictionaryIO,
  adapters: readonly BookAdapter[] = ADAPTERS
): BookAdapter | null {
  for (const a of adapters) {
    try {
      if (a.claims(files, io)) return a
    } catch {
      /** ★ 契约写死了「`claims` 绝不抛异常」。真抛了也不该让整次扫描停下来 */
    }
  }
  return null
}

export { mdictAdapter, starDictAdapter }
