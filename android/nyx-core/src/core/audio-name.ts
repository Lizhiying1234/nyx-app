/**
 * 同步音频的文件名判据 · ★ Step 1D / D-279 · F-08（2026-08-17）
 *
 * ── 病 ──────────────────────────────────────────────────────
 *
 * `syncAudio` 把云端列目录返回的名字**直接拼进本地路径**：
 *
 *     writeFileSync(join(this.audioDir, f), Buffer.from(b64, 'base64'))
 *
 * `f` 来自远端。桶里放一个叫 `..%2F..%2Fevil.exe.json` 的对象，
 * `join` 会老老实实把 `..` 解析掉，文件就落到 `data/audio` 之外去了。
 * 桶是他自己的 —— 但「桶是自己的」是一个假设，不是保证（key 泄漏、
 * 桶设成公开可写、将来共享桶）。
 *
 * ── 判据：只认本机命名规则能产生的名字 ──────────────────────
 *
 * 音频文件名是**内容哈希**（`tts.ts`：`sha1(文本|口音|语速|模型|音色)` 的十六进制）
 * 加 `.mp3`。也就是说合法名字只有一种形状：**40 位小写十六进制 + `.mp3`**。
 *
 * 用「只认这一种」而不是「排除 `../`」：黑名单永远漏（`..\`、URL 编码、
 * Unicode 变体、绝对路径、盘符、NTFS 数据流…），白名单不会。
 * 这是这个项目里唯一一处从外部拿名字去拼路径的地方，值得用最严的那种写法。
 */

/** `tts.ts` 用的是 sha1 十六进制 —— 40 位小写 hex，扩展名固定 `.mp3` */
const AUDIO_NAME = /^[0-9a-f]{40}\.mp3$/

export type AudioNameVerdict = { ok: true } | { ok: false; why: string }

/**
 * 这个文件名能不能落到本地音频目录里。
 *
 * ★ 只回答「名字合不合法」，**不碰文件系统** —— 所以它能进 `core/`，
 * 两端共用同一份判据（Android 那边的路径分隔符还不一样，更不能各写一份）。
 */
export function checkAudioName(name: unknown): AudioNameVerdict {
  if (typeof name !== 'string' || name === '') {
    return { ok: false, why: '文件名是空的' }
  }
  /**
   * 先挡掉一眼就不对的，好让报出来的话说得具体一点 ——
   * 最后那条正则其实已经全包了，这几句是为了诊断，不是为了安全。
   */
  if (name.includes('/') || name.includes('\\')) return { ok: false, why: '文件名里带路径分隔符' }
  if (name.includes('..')) return { ok: false, why: '文件名里带上级目录（..）' }
  if (name.includes('\0')) return { ok: false, why: '文件名里带空字符' }
  if (/^[a-zA-Z]:/.test(name)) return { ok: false, why: '这是一个绝对路径（带盘符）' }
  if (!name.endsWith('.mp3')) return { ok: false, why: '扩展名不是 .mp3' }

  if (!AUDIO_NAME.test(name)) {
    return { ok: false, why: '不是本软件的音频命名规则（40 位小写十六进制 + .mp3）' }
  }
  return { ok: true }
}

/** 给 `syncAudio` 用的便捷判断 */
export const isAllowedAudioName = (name: unknown): boolean => checkAudioName(name).ok
