/**
 * 词典资源（发音 / 插图）· D1（2026-08-19）
 *
 * ── 实测：他的词典里到底有多少东西读不到 ★★★ ─────────────────
 *
 * 15 个 `.mdd` 全部解出来过（审计报告 §6）：
 *   OALD10        27.4 万条 mp3（含**例句朗读**）+ 2009 张 png + 35 个 svg
 *   朗文6英汉双解   18.1 万条 mp3 + 1038 张图
 *   LDOCE5        18.4 万条 **spx** + 1225 张图
 *   LCDT          8468 条 mp3
 *   ————————————————————————————————————————
 *   合计约 110 万个音频、2200 张图、5.7 GB，**当前可达性 0**
 *
 * ── `ref` 为什么不是 hash ★★（对审计报告的一处修正）─────────
 *
 * 报告里写的是 `ref = bookUid + ':' + sha1(key)`。**落地时发现那是错的**：
 * hash 不可逆，主进程拿到 `ref` 之后**没法知道要去 `.mdd` 里取哪个键**，
 * 除非再维护一张「hash → key」的反查表 —— 而那张表要装下 110 万个键。
 *
 * 所以 `ref` 用**可逆**编码：`escapePart(bookUid)|escapePart(key)`，
 * 和 `core/identity.ts` 同一套转义（可证明无歧义）。主进程解开就知道去哪取。
 *
 * 泄漏面也想过：MDD 的键是**词典内部**的名字（`\brunt__gb_1.mp3`），
 * 不是文件系统路径 —— 它不暴露他机器上的任何东西，
 * 而且在 Android 的缓存里也是同一个名字（这正是我们要的）。
 *
 * ── 键的归一：三种写法指向同一个文件 ★ ───────────────────────
 *
 *   HTML 里写的            MDD 里存的
 *   `sound://brunt__gb_1.mp3`   `\brunt__gb_1.mp3`
 *   `img/spkr_r.png`            `\img\spkr_r.png`
 *   `snd_uk.png`                `\snd_uk.png`
 *
 * 所以要：去掉 scheme → `/` 换成 `\` → 补前导 `\` → 解 `%XX` → 小写。
 * 大小写不敏感是实测的：同一本词典里 `.PNG` 和 `.png` 混着用（童哥说单词那本）。
 */

import { escapePart, decodeParts } from '../identity.ts'
import type { DictionaryDiagnostic } from './diagnostics.ts'
import { diagnostics } from './diagnostics.ts'
import { isImageExt, isPlayableAudioExt, isAudioExt, type DictionaryCapability } from './capability.ts'

export type MediaKind = 'audio' | 'image' | 'font' | 'style' | 'script' | 'other'

export interface DictionaryMedia {
  kind: MediaKind
  /** 归一后的词典内部资源键。`\brunt__gb_1.mp3` */
  key: string
  /**
   * ★ 渲染层唯一拿得到的东西。它只把这个字符串递回主进程换字节，
   *   **永远不接触路径**（路径会变、会泄漏文件系统、Android 上不存在）。
   */
  ref: string
  mime: string | null
  /** `uk` / `us` / `sentence`（例句朗读）/ 图片的 alt */
  label?: string
  /** 取不到、或取得到但放不了 —— **必须说清为什么** */
  unavailable?: DictionaryDiagnostic
}

const MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  spx: 'audio/ogg; codecs=speex',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  css: 'text/css', js: 'text/javascript',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2'
}

export function extensionOf(key: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(key)
  return m ? m[1]!.toLowerCase() : ''
}

export function mimeOf(key: string): string | null {
  return MIME[extensionOf(key)] ?? null
}

export function kindOf(key: string): MediaKind {
  const ext = extensionOf(key)
  if (isAudioExt(ext)) return 'audio'
  if (isImageExt(ext)) return 'image'
  if (ext === 'css') return 'style'
  if (ext === 'js') return 'script'
  if (ext === 'ttf' || ext === 'otf' || ext === 'woff' || ext === 'woff2') return 'font'
  return 'other'
}

/** 词典正文里出现的资源引用 scheme */
const SCHEME = /^(sound|entry|file|res):\/*/i

/**
 * 把正文里的一个引用归一成 MDD 的键。
 * 归一失败（空串、只有 scheme）返回空串 —— 调用方跳过它，不要造一个指不到东西的 media。
 */
export function normalizeResourceKey(raw: string): string {
  let s = (raw ?? '').trim()
  if (!s) return ''
  s = s.replace(SCHEME, '')
  // `#anchor` / `?query` 不属于资源名
  s = s.split('#')[0]!.split('?')[0]!
  try {
    if (s.includes('%')) s = decodeURIComponent(s)
  } catch {
    /* 解不开就用原样 —— 归一失败不该让整条词条炸掉 */
  }
  s = s.replace(/\//g, '\\')
  /**
   * ★ 只剩下分隔符 = 归一失败。
   *   不挡的话 `sound://` 会变成一个键为 `\` 的「资源」——
   *   它取不到任何字节，但界面上会多出一个点了没反应的按钮。
   */
  if (s.replace(/\\/g, '') === '') return ''
  if (!s.startsWith('\\')) s = '\\' + s
  // 词典里 `.PNG` 和 `.png` 混着用，MDD 查找按小写
  return s.toLowerCase()
}

/**
 * 资源的稳定引用。**可逆** —— 见文件头「`ref` 为什么不是 hash」。
 */
export function mediaRef(bookUid: string, key: string): string {
  return `${escapePart(bookUid)}|${escapePart(key)}`
}

/** 解开 `ref`。形状不对返回 null —— 渲染层传来的东西一律不信 */
export function parseMediaRef(ref: string): { bookUid: string; key: string } | null {
  const parts = decodeParts(ref)
  if (parts.length !== 2) return null
  const [bookUid, key] = parts as [string, string]
  if (!bookUid || !key) return null
  return { bookUid, key }
}

/**
 * 造一个 media。
 *
 * ★ **放不了的要在这里就标出来**，不要等渲染层发现没声音。
 *   `degradedTo` 传书级能力去掉 `audio` 之后的那一份。
 */
export function makeMedia(
  bookUid: string,
  rawKey: string,
  opts: { label?: string; degradedTo?: readonly DictionaryCapability[] } = {}
): DictionaryMedia | null {
  const key = normalizeResourceKey(rawKey)
  if (!key) return null
  const kind = kindOf(key)
  const media: DictionaryMedia = {
    kind,
    key,
    ref: mediaRef(bookUid, key),
    mime: mimeOf(key),
    ...(opts.label ? { label: opts.label } : {})
  }
  if (kind === 'audio' && !isPlayableAudioExt(extensionOf(key))) {
    media.unavailable =
      extensionOf(key) === 'spx'
        ? diagnostics.speex(opts.degradedTo ?? [], key)
        : diagnostics.mediaUnavailable(
            `这个发音是 ${extensionOf(key) || '未知'} 格式，浏览器放不了。`,
            opts.degradedTo ?? [],
            key
          )
  }
  return media
}

/** 这条 media 现在真的能用吗 —— 界面按它决定要不要画按钮 */
export function usable(m: DictionaryMedia): boolean {
  return m.unavailable === undefined
}

/**
 * 发音的口音标签。
 *
 * 判据来自实测的真实 class / 文件名（审计报告 §6）：
 *   OALD10   `a.pron-uk` / `a.pron-us`，文件名 `brunt__gb_1.mp3` / `brunt__us_1.mp3`
 *            例句朗读是 `_brunt__gbs_1.mp3`（多一个前导下划线 + `s`）
 *   LDOCE5   `GB_brunt0205.spx` / `US_brunt.spx`
 *   朗文6     `hwd/bre/b/brunt0205.mp3` / `hwd/ame/a/brunt.mp3`，例句在 `exa/`
 */
export function accentOf(key: string, classes: readonly string[] = []): 'uk' | 'us' | 'sentence' | undefined {
  const k = key.toLowerCase()
  if (classes.includes('pron-uk')) return uk(k)
  if (classes.includes('pron-us')) return us(k)
  if (/\\exa\\|__gbs_|__uss_|_sfx|\\p\d{3}__/.test(k)) return 'sentence'
  if (/\bgb\b|_gb_|\\bre\\|^\\gb_|uk/.test(k)) return 'uk'
  if (/\bus\b|_us_|\\ame\\|^\\us_/.test(k)) return 'us'
  return undefined

  function uk(x: string): 'uk' | 'sentence' {
    return /__gbs_|\\exa\\/.test(x) ? 'sentence' : 'uk'
  }
  function us(x: string): 'us' | 'sentence' {
    return /__uss_|\\exa\\/.test(x) ? 'sentence' : 'us'
  }
}
