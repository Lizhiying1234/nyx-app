/**
 * 词典诊断 · D-262（失败要看得见）· D1（2026-08-19）
 *
 * ── 病 ────────────────────────────────────────────────────────
 *
 * 现在 `main/dict/index.ts` 把装载异常的 `err.message` 直接塞进 `DictRow.problem`
 * 显示给使用者。于是他的设置页上真的写着：
 *
 *     Attempt to access memory outside buffer bounds
 *
 * 那是 V8 的内部报错。真相是「`_._TLD.mdx` 是 macOS 压缩包带出来的附属文件，
 * 根本不是词典，可以删掉」。**他零编程经验，这行英文对他等于没有。**
 *
 * ── 药 ────────────────────────────────────────────────────────
 *
 * 每一种失败都必须回答两个问题，缺一不可：
 *
 *   ① **为什么用不了**   —— 用他的话说，不用我的话说
 *   ② **他能做什么**     —— 删掉？换一本？重新下载？还是「这本就这样，别的不受影响」
 *
 * 话术**只有这一处出处**，renderer 一个字都不许自己拼。
 * 理由和 D-262 一样：「看得见」的前提是那句话有人写过、可复现、可测试。
 *
 * ── 为什么诊断必须能落库 ★★ ──────────────────────────────────
 *
 * 今天 `problems` 只活在内存里，靠**启动时全量装载**重建 —— 而 D5 正要把全量装载
 * 改成惰性。两件事必须一起做：先改惰性、诊断还只在内存，设置页就会变成一片「未知」，
 * 那比现在更糟。所以这些类型从一开始就设计成可序列化的纯数据（能直接 JSON 进库）。
 */

import type { DictionaryCapability } from './capability.ts'

export type DictionaryStatus =
  /** 全部能力可用 */
  | 'READY'
  /** 能查，但少了某些能力。`degradedTo` 必须说清还剩哪些 */
  | 'PARTIAL'
  /** 格式 / 压缩 / 加密不支持（LZO、注册码加密…） */
  | 'UNSUPPORTED_FORMAT'
  /** 文件本身坏了或没下完整 */
  | 'CORRUPTED'
  /** 索引解不开 —— 文件在、头部也对，但结构对不上 */
  | 'INDEX_ERROR'
  /** 编码不认识，或解出来是乱码 */
  | 'ENCODING_ERROR'
  /** 正文引用的资源包不在（.mdd 被删了/没拷过来） */
  | 'RESOURCE_MISSING'
  /** 资源在，但放不了（Speex 音频、认不出的 mime） */
  | 'MEDIA_UNAVAILABLE'
  /** 根本不是词典文件 */
  | 'NOT_A_DICTIONARY'
  /**
   * 这一条的 `@@@LINK` 跳转坏了（转圈 / 太深 / 断链）· D1 补
   *
   * ★ 它是**条目级**的，不是书级的：这本词典别的词照样查得到。
   *   所以 `isFatal` 里它是 false —— 判成致命会让整本词典被排除在查词之外，
   *   而真相只是「这一个词目指错了地方」。
   */
  | 'REDIRECT_BROKEN'

/** 他自己能做的动作。界面按这个决定要不要给按钮、给什么按钮 */
export type DiagnosticAction =
  | { kind: 'none' }
  | { kind: 'delete-file'; hint: string }
  | { kind: 'reconvert'; hint: string }
  | { kind: 'redownload'; hint: string }

export interface DictionaryDiagnostic {
  status: DictionaryStatus
  /** ★ 给他看的一句话。中文，说清「为什么」+「能做什么」 */
  says: string
  /** 给我看的：原始异常、字节偏移、头部属性。他看不到，日志和数据体检里有 */
  detail?: string
  /** `PARTIAL` / `MEDIA_UNAVAILABLE` 时**必填**：还剩哪些能力 */
  degradedTo?: readonly DictionaryCapability[]
  action?: DiagnosticAction
}

/** 这个状态是不是「这本词典压根用不了」 —— 界面据此决定要不要把它排除在查词之外 */
export function isFatal(status: DictionaryStatus): boolean {
  return (
    status === 'UNSUPPORTED_FORMAT' ||
    status === 'CORRUPTED' ||
    status === 'INDEX_ERROR' ||
    status === 'ENCODING_ERROR' ||
    status === 'NOT_A_DICTIONARY'
  )
}

// ── 话术 · 唯一出处 ──────────────────────────────────────────────

export const diagnostics = {
  ready(): DictionaryDiagnostic {
    return { status: 'READY', says: '这本词典可以用。' }
  },

  /**
   * 少了一部分能力，但主体能用。
   * ★ `degradedTo` 是必填参数而不是可选字段 —— 说了「部分可用」却不说
   *   「哪部分」的诊断，对他等于没说。类型层就堵死。
   */
  partial(says: string, degradedTo: readonly DictionaryCapability[], detail?: string): DictionaryDiagnostic {
    return { status: 'PARTIAL', says, degradedTo, ...(detail ? { detail } : {}) }
  },

  /** LZO 压缩 —— 实测使用者 22 本里有 2 本（都是 MDict 1.2 版） */
  lzo(detail?: string): DictionaryDiagnostic {
    return {
      status: 'UNSUPPORTED_FORMAT',
      says:
        '这本是老版 MDict（1.2 版，LZO 压缩），当前读不了。' +
        '用 MdxBuilder 之类的工具把它重存成 zlib 压缩就能用了。',
      ...(detail ? { detail } : {}),
      action: { kind: 'reconvert', hint: '用 MdxBuilder 重存成 zlib' }
    }
  },

  /** 付费词典的注册码加密。**不碰** —— 绕开它属于破解 */
  encrypted(detail?: string): DictionaryDiagnostic {
    return {
      status: 'UNSUPPORTED_FORMAT',
      says:
        '这本词典的索引上了锁，要原厂注册码才能打开，软件读不了。' +
        '这是付费词典的授权保护，换一本没上锁的。',
      ...(detail ? { detail } : {}),
      action: { kind: 'none' }
    }
  },

  /** 认不出的压缩方式 */
  unknownCompression(kind: number | string): DictionaryDiagnostic {
    return {
      status: 'UNSUPPORTED_FORMAT',
      says: `这本词典用了软件不认识的压缩方式（${kind}），读不了。`,
      detail: `compression=${kind}`,
      action: { kind: 'none' }
    }
  },

  /**
   * 编码不支持。
   *
   * ★ 2026-08-20 起这条**不再是给 GBK 的**：那本朗文插图版（v1.2 + LZO + GBK）
   *   压缩这关在 D5.1a 过了、编码这关在 D5.1b 过了，现在能读。
   *   现在认得 UTF-8 / UTF-16 / GBK（含 GB2312 · GB18030）——
   *   这条留给别的（Big5 之类）。**话术里要写清认得哪几种**，别让他自己猜。
   */
  encoding(encoding: string, detail?: string): DictionaryDiagnostic {
    return {
      status: 'ENCODING_ERROR',
      says:
        `这本词典的正文是 ${encoding} 编码，软件读不了（现在认得 UTF-8 / UTF-16 / GBK），读出来会是乱码。`,
      ...(detail ? { detail } : {}),
      action: { kind: 'reconvert', hint: `把词典转存成 UTF-8` }
    }
  },

  /** 文件没下完整 / 被截断 */
  corrupted(detail?: string): DictionaryDiagnostic {
    return {
      status: 'CORRUPTED',
      says: '这个词典文件不完整（正文段的长度对不上），多半是没下载完。重新下载一份。',
      ...(detail ? { detail } : {}),
      action: { kind: 'redownload', hint: '重新下载这本词典' }
    }
  },

  /** 头部读得了，索引解不开 */
  indexError(detail?: string): DictionaryDiagnostic {
    return {
      status: 'INDEX_ERROR',
      says: '这本词典的条目索引解不开 —— 文件在，但内部结构对不上，软件读不了它的词表。',
      ...(detail ? { detail } : {}),
      action: { kind: 'redownload', hint: '重新下载这本词典' }
    }
  },

  /**
   * 根本不是词典。
   *
   * ★ 实测：`_._TLD.mdx`（172 字节）是 macOS 压缩包带出来的 AppleDouble 附属文件。
   *   同目录还有 `_._config.ini` / `_._fy.js` / `_._p.css` 三个同类。
   *   它今天在他的词典列表里占着一行，报着一句 V8 的英文异常。
   */
  notADictionary(why: string, detail?: string): DictionaryDiagnostic {
    return {
      status: 'NOT_A_DICTIONARY',
      says: `这不是词典文件（${why}），可以直接删掉。`,
      ...(detail ? { detail } : {}),
      action: { kind: 'delete-file', hint: '这个文件可以删掉' }
    }
  },

  /** 正文引用的资源包不在 */
  resourceMissing(names: readonly string[], degradedTo: readonly DictionaryCapability[]): DictionaryDiagnostic {
    return {
      status: 'RESOURCE_MISSING',
      says:
        `这本词典的资源包不在（${names.join('、')}），发音和插图看不了，查词和释义不受影响。` +
        '把资源包和词典正文放在同一个文件夹里就能恢复。',
      detail: `missing: ${names.join(', ')}`,
      degradedTo,
      action: { kind: 'none' }
    }
  },

  /**
   * 资源在，但浏览器放不了。
   *
   * ★ 实测：LDOCE5 的 18.4 万条发音是 `.spx`（Speex），Chromium 解不了这个编码。
   *   所以这本的发音按钮**根本不该出现** —— 出现了按下去没声音，
   *   比没有按钮糟得多（他会以为是软件坏了）。
   */
  mediaUnavailable(why: string, degradedTo: readonly DictionaryCapability[], detail?: string): DictionaryDiagnostic {
    return {
      status: 'MEDIA_UNAVAILABLE',
      says: why,
      ...(detail ? { detail } : {}),
      degradedTo,
      action: { kind: 'none' }
    }
  },

  /**
   * 跳转转圈：`A → B → A`。
   *
   * ★ 没有这条诊断的话，跟随会一直转下去 —— 而他看到的是**软件卡住**，
   *   不是错误提示。查不清的死法里这种最贵。
   */
  redirectCycle(path: readonly string[]): DictionaryDiagnostic {
    return {
      status: 'REDIRECT_BROKEN',
      says:
        '这个词在词典里绕成了一个圈（几个词典条目互相指来指去），取不到正文。' +
        '这是词典本身的问题；换一本词典查同一个词即可，其他词不受影响。',
      detail: `cycle: ${path.join(' → ')}`,
      action: { kind: 'none' }
    }
  },

  /** 跳转链太长 —— 到上限还没到底 */
  redirectTooDeep(path: readonly string[], max: number): DictionaryDiagnostic {
    return {
      status: 'REDIRECT_BROKEN',
      says:
        `这个词在词典里连着跳了 ${max} 次还没跳到正文，软件停下了。` +
        '这是词典本身的问题；换一本词典查同一个词即可，其他词不受影响。',
      detail: `too deep (max ${max}): ${path.join(' → ')}`,
      action: { kind: 'none' }
    }
  },

  /** 跳转的目标词目根本不在这本里 */
  redirectDangling(from: string, to: string): DictionaryDiagnostic {
    return {
      status: 'REDIRECT_BROKEN',
      says:
        `这个词在词典里指向了「${to}」，但这本词典里没有这个条目，取不到正文。` +
        '这是词典本身的问题；换一本词典查同一个词即可，其他词不受影响。',
      detail: `dangling: ${from} → ${to}`,
      action: { kind: 'none' }
    }
  },

  /** Speex 发音 —— 单独给一条，因为它是实测里唯一真出现的媒体不可用原因 */
  speex(degradedTo: readonly DictionaryCapability[], detail?: string): DictionaryDiagnostic {
    return diagnostics.mediaUnavailable(
      '这本词典的发音是 Speex 格式，浏览器放不了。查词、释义、例句、插图都正常，别的词典的发音也不受影响。',
      degradedTo,
      detail
    )
  }
} as const

/**
 * 兜底：任何没被上面认出来的异常。
 *
 * ★ 判据故意保守 —— 认不出来就说「认不出来」，**绝不猜**。
 *   猜错的诊断比没有诊断更糟：他会照着错的建议去改文件。
 *   原始异常放进 `detail`（数据体检里看得到），不放进 `says`。
 */
export function fromUnknownError(err: unknown): DictionaryDiagnostic {
  const raw = err instanceof Error ? err.message : String(err)
  return {
    status: 'INDEX_ERROR',
    says: '这本词典装不起来，原因还没认出来。把它从词典文件夹里挪走可以先让别的词典正常工作。',
    detail: raw,
    action: { kind: 'none' }
  }
}
