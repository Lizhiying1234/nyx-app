/**
 * Adapter 契约 · D1（2026-08-19）
 *
 * ── 目标（使用者的原话，不是「支持所有格式」）★★ ─────────────
 *
 *     业务层不认识具体词典格式。新增一种格式 = 新增一个 Adapter，别处一行不改。
 *
 * 判据很具体：**加 StarDict 那天，registry、IPC、renderer 应该一个字都不用改。**
 *
 * D1 写这段话时不成立 —— `main/dict/index.ts` 里是一个二元分支：
 *
 *     path.toLowerCase().endsWith('.mdx') ? Mdict.open(path) : StarDict.open(path)
 *
 * 加第三种格式要改这一行，`scanDicts()` 里还有第二份扩展名分支要跟着改。
 * **D2 把这两处都消灭了**：格式知识只剩 `adapters/*.ts` 里的 `mainExtensions` 与
 * `claims()`，`registry.ts` 与 `index.ts` 里一个扩展名都没有。
 * 加一种格式 = 往 `adapters/index.ts` 的 `ADAPTERS` 里加一项。
 *
 * ── 为什么 `probe` 和 `open` 要分开 ★★ ───────────────────────
 *
 * 实测：启动时全量装载 18 本要 **7.3 秒**，常驻 990 MB，而且发生在**建窗口之前**
 *（审计报告 §14）。D5 要把它改成惰性 —— 前提就是有一个**廉价**的 `probe`：
 * 只读头部那几百字节，就能拿到书名、词数、能力、身份、以及「这本能不能用」。
 *
 * 所以契约把「知道这本是什么」和「把这本装起来」分成两件事。
 * **`probe` 里一旦有人为了算能力去解正文，惰性就白做了** —— 这条要靠 review 守。
 *
 * ── 为什么 `claims` / `probe` / `open` 是**同步**的（D2 定的）★★ ──
 *
 * D1 写这份契约时它们是 `Promise` 的。D2 落地时改成同步，三个理由：
 *
 *   ① **调用点全是同步的。** `Study` 在写库事务的前一行调 `examples()`，
 *      改成 await 就等于在那里插进一个可被别的 IPC 打断的点 ——
 *      而 D2 是**行为等价重构**，不该顺手改变时序。
 *   ② 异步在这里买不到任何东西：读头部是几百字节的 `readSync`，
 *      两端（Node / Android）都能同步读。D5 的惰性是「**什么时候**装」，
 *      不是「装的时候让不让出线程」。
 *   ③ 唯一真正会读大块字节的是 `resource()`（一条 mp3、一张 png），
 *      **它保持异步** —— 那是 D3 按需取资源要走的路。
 *
 * 也就是说：便宜的同步，昂贵的异步。这条边界正好落在 `.mdd` 上。
 *
 * ── 失败必须带诊断，不许抛裸 Error ★ ─────────────────────────
 *
 * 今天 `handle()` 把 `err.message` 直接显示给使用者，于是设置页上写着
 * `Attempt to access memory outside buffer bounds`。
 * 所以 `open` / `probe` 失败一律抛 `DictionaryOpenError`，里面**必须**有
 * 一条 `DictionaryDiagnostic`（`diagnostics.ts` 是话术的唯一出处）。
 */

import type { DictionaryCapability } from './capability.ts'
import type { KeyRules } from './lookup.ts'
import type { DictionaryDiagnostic } from './diagnostics.ts'
import { fromUnknownError } from './diagnostics.ts'

/**
 * 一本词典在磁盘上的**一组**文件。
 *
 * ★ 是「一组」不是「一个」：MDict 的资源包会分卷
 *（实测 `oald10-V1_4.mdd` / `.1.mdd` / `.2.mdd` / `.3.mdd` 四个，共 2.1 GB），
 * 而且还有一堆**散落在同目录**、不在任何 `.mdd` 里的资源
 *（`oald10.css` 186 KB、`thes.js` 211 KB…）。
 * 今天的代码对这两条路径都一无所知。
 */
export interface DictionaryFileSet {
  /** 主文件：`.mdx` / `.ifo` */
  main: string
  /** 资源包：`.mdd` 及其分卷；StarDict 的 `res/` */
  resources: readonly string[]
  /** 与主文件同目录的散文件 */
  loose: readonly string[]
  folder: string
}

/**
 * 平台注入的 I/O。**core 只认这个接口，不认 `node:fs`** ——
 * `purity.test.ts` 守着这条（D-238：将来要搬到 Android）。
 */
export interface FileHandle {
  readonly path: string
  readonly size: number
}

export interface DictionaryIO {
  open(path: string): FileHandle
  /** 从 `at` 读 `len` 字节。读到文件尾就返回短的，**不抛** */
  read(h: FileHandle, at: number, len: number): Uint8Array
  close(h: FileHandle): void
}

/**
 * zlib inflate 的端口（D-401 词典批加）：格式层不 import `node:zlib` ——
 * Windows 注 `inflateSync`，Android 注纯 JS 实现（fflate.unzlibSync）。
 * 与 `DictionaryIO` 同一条纪律：便宜的同步。
 */
export type Inflate = (data: Uint8Array) => Uint8Array

/** `probe` 的产物：不解正文就能知道的一切 */
export interface DictionaryProbe {
  title: string
  /** `mdict` / `stardict` */
  format: string
  formatVersion: string
  encoding: string
  /** 头部**声明**的词条数（不是去重后的索引大小） */
  entryCount: number
  blockCount: number
  indexBytes: number
  /** 跨设备身份（`dict/identity.ts::dictUid`） */
  uid: string
  capabilities: readonly DictionaryCapability[]
  /**
   * 键规则（`KeyCaseSensitive` / `StripKey`）—— 也来自头部，所以属于 probe。
   * D2 只负责**读出来并存住**；真正拿它查词是 D3 接 `lookup.ts` 那一步。
   */
  keyRules?: KeyRules
  /** probe 阶段就判得出的问题（LZO、加密、不是词典…） */
  diagnostic?: DictionaryDiagnostic
}

export interface RawRecord {
  /** 正文原文，已解压、已按 encoding 解码 */
  body: string
  shape: 'html' | 'text' | 'xdxf'
  /**
   * `@@@LINK=` 已**识别**但未跟随 —— 跟随是 `lookup.ts` 的事。
   * 分开的理由：跟随要防环、要记跳转链、要有跳数上限，
   * 那是查词语义，不是格式解析。adapter 只管「这条记录说它是个跳转」。
   */
  redirectTo?: string
}

export interface OpenDictionary {
  readonly meta: DictionaryProbe
  /**
   * 命中的**真实词目**，可能多条。
   *
   * ★ 返回数组是 R11 的修法：今天 `if (!index.has(lower)) index.set(...)`
   *   把同形异义词丢掉了 —— 实测 OALD10 丢 6909 条、UrbanDictionary 丢 7254 条。
   *   丢在索引里就再也拿不回来了，所以这一层必须能返回全部。
   */
  match(query: string): readonly string[]
  raw(headword: string, occurrence?: number): RawRecord | null
  keys(): Iterable<string>
  resource(key: string): Promise<Uint8Array | null>
  close(): void
}

export interface DictionaryAdapter {
  readonly format: string
  /** 认不认这组文件。**只看字节与扩展名，绝不抛异常** */
  claims(files: DictionaryFileSet, io: DictionaryIO): boolean
  /** 廉价：只读头部。失败抛 `DictionaryOpenError` */
  probe(files: DictionaryFileSet, io: DictionaryIO): DictionaryProbe
  /** 真正装载。失败抛 `DictionaryOpenError` */
  open(files: DictionaryFileSet, io: DictionaryIO): OpenDictionary
}

/**
 * 装载失败。**唯一允许从 adapter 抛出来的异常类型。**
 *
 * `message` 用 `says` —— 万一哪里漏了处理、异常一路冒到界面上，
 * 他看到的至少也是一句人话，而不是 V8 的报错。
 */
export class DictionaryOpenError extends Error {
  readonly diagnostic: DictionaryDiagnostic

  constructor(diagnostic: DictionaryDiagnostic) {
    super(diagnostic.says)
    this.name = 'DictionaryOpenError'
    this.diagnostic = diagnostic
  }
}

/** 任何异常 → 一条诊断。adapter 的 `catch` 里统一用它兜底 */
export function toDiagnostic(err: unknown): DictionaryDiagnostic {
  if (err instanceof DictionaryOpenError) return err.diagnostic
  return fromUnknownError(err)
}
