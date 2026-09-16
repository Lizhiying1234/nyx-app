/**
 * 启动页图片资源的文件名判据 —— **两端共用一份**（2026-09-09）
 *
 * ── 为什么和 `audio-name.ts` 长得一样 ────────────────────────
 *
 * 因为它防的是同一件事，而且这是全仓**第二处**「从外部拿名字去拼本地路径」：
 * 启动页图片要跟着同步走（使用者 2026-09-09：Win 与 Android **共享图片资源**，
 * 各自选各自的启动页）。于是云端列目录返回的名字会被拼进本地路径 ——
 * 桶里放一个 `..%2F..%2Fevil.exe` 就能把文件写到资源目录之外去。
 * 「桶是他自己的」是一个假设，不是保证（key 泄漏、桶设成公开可写、将来共享桶）。
 *
 * ── 判据：只认本机命名规则能产生的名字（白名单，不是黑名单）──
 *
 * 资源名 = **内容 sha256 的十六进制（64 位）+ 扩展名**。
 *
 * ★★ **为什么不跟音频那条一样用 sha1** —— Android 会话 2026-09-09 顶回来的，
 *   是那一端的硬事实，桌面上看不见：
 *     ① 那台 Android 的 WebView **没有 WebCrypto** —— `capacitor.config.json` 的
 *        `androidScheme: "http"` 换来的代价（当初为同步能打纯 HTTP 端点而定）。
 *        `crypto.subtle` 不是慢，是**没有**。
 *     ② 它手上现成的纯 JS 哈希只有 sha256（`src/db/sha256.ts`，schema 指纹与同步在用）。
 *     ③ 保 sha1 的话它要**手写第二份加密原语**并自己测 ——
 *        在最不该出手写加密的那一端多养一份代码，只为了和一条它从不参与计算的老流对齐。
 *     ④ 音频那条**不构成先例**：Android 从来只**验**音频名、从没**算**过
 *        （名字随桶下来，TTS 在 Windows 端生成）。启动页是它第一次要自己算一个
 *        「两端必须算出同一个值」的名字。
 *   ★ 代价如实说：splash 名 64 位、audio 名 40 位，**两条流不一样长**。这没关系 ——
 *     两条流各验各的正则，本来就是两个函数；真要统一是「把 audio 也换掉」的另一件事。
 *   ★ 换的时候**两端都还没落过盘**，所以不需要迁移；真有旧文件，重新导入一次即可。
 * 用内容哈希当名字顺带白拿两样：
 *   ① **同一张图传两次就是同一个文件**（不会攒出一堆副本）；
 *   ② 两端各自算出来的名字必然相同 —— 同步时不用协商。
 *
 * 黑名单永远漏（`..\`、URL 编码、Unicode 变体、绝对路径、盘符、NTFS 数据流…），
 * 白名单不会。这两处是全仓唯一从外部拿名字拼路径的地方，都用最严的那种写法。
 *
 * ★ 只回答「名字合不合法」，**不碰文件系统** —— 所以它能进 `core/`，
 *   Android 那边路径分隔符还不一样，更不能各写一份。
 */

/** 允许的扩展名 —— 和 `main/splash.ts` 的 MIME 表一一对应，多一个都不许 */
export const SPLASH_EXTS: readonly string[] = ['.webp', '.png', '.jpg', '.jpeg']

const SPLASH_NAME = /^[0-9a-f]{64}\.(webp|png|jpg|jpeg)$/

export type SplashNameVerdict = { ok: true } | { ok: false; why: string }

/** 这个文件名能不能落到本地启动页资源目录里。 */
export function checkSplashName(name: unknown): SplashNameVerdict {
  if (typeof name !== 'string' || name === '') {
    return { ok: false, why: '文件名是空的' }
  }
  /* 先挡掉一眼就不对的，好让报出来的话说得具体一点 ——
     最后那条正则其实已经全包了，这几句是为了诊断，不是为了安全。 */
  if (name.includes('/') || name.includes('\\')) return { ok: false, why: '文件名里带路径分隔符' }
  if (name.includes('..')) return { ok: false, why: '文件名里带上级目录（..）' }
  if (name.includes('\0')) return { ok: false, why: '文件名里带空字符' }
  if (/^[a-zA-Z]:/.test(name)) return { ok: false, why: '这是一个绝对路径（带盘符）' }
  if (!SPLASH_EXTS.some((e) => name.endsWith(e))) {
    return { ok: false, why: '扩展名不在允许的四种里（webp / png / jpg / jpeg）' }
  }
  if (!SPLASH_NAME.test(name)) {
    return { ok: false, why: '不是「64 位小写十六进制（sha256）+ 扩展名」这种形状' }
  }
  return { ok: true }
}

/**
 * 当前用哪一张 —— 这个值**存在设备本地**（`settings` 表，不进 `SYNC_TABLES`）。
 *
 * ★ 使用者 2026-09-09 改的需求：「win 和 android 可以有不同的启动页，
 *   **共享的是图片资源**」。所以：
 *     资源本体 → 跟着同步走（两端看得见同一批候选）
 *     选了哪张 → **各端自己的事**，不同步
 *   这正好落在现成的分界上：`user_preferences` 同步、`settings` 不同步。
 *   不用动偏好白名单，也不用改同步契约的项数。
 */
export type SplashChoice =
  /**
   * 内置图标那一档 —— **永远可用，不依赖任何文件**。
   *
   * ★★ 字面两端共用，**意思按端解释** —— 这是「正确的不同」（CP-14 / X-16），别去统一：
   *   Windows ：窗口内**画一帧**（去底的兔子 168px）
   *   Android ：**不画任何应用内帧**，落到系统 Splash 那一帧
   *
   * 出处是 docs/ui/DESIGN_SYSTEM.md §12.0b（:466 那张表 · :485-486）：
   *   「Android 有图 → 系统帧（图标）+ 应用帧（插画）；没图 → 只有系统帧，直接进应用。
   *     （Windows 两版都要，它没有系统帧。）」
   * 理由：去掉字之后系统 Splash 本来就是「一枚图标居中」，应用内那一帧如果也只剩图标，
   * **两帧长得一模一样 = 白多等一次**。
   *
   * ★ 单独写一段是因为它差点被漏掉：2026-09-09 我把这份跨端契约发给 Android 会话时
   *   只写了「回退到图标」，没说两端的「图标」不是同一件事 —— 照那个写下去，
   *   Android 会多画一帧。是对面按 DS 顶回来的，核过原文属实（就是上面那两行）。
   */
  | { kind: 'icon' }
  /** 出厂那张插画（随软件发的 `resources/splash/illustration.webp`）*/
  | { kind: 'shipped' }
  /** 他自己传的一张，`name` 必过 `checkSplashName` */
  | { kind: 'user'; name: string }

/** 存进 `settings` 的字面。**只有这三种形状**，解析不了就当没设过。 */
export function encodeSplashChoice(c: SplashChoice): string {
  return c.kind === 'user' ? `user:${c.name}` : c.kind
}

/**
 * 从 `settings` 读回来。
 * ★ 认不出来 / 名字不合法 → 返回 `null`，由调用方按「没设过」走默认。
 *   **绝不抛** —— 启动页这条路上任何一处抛都等于白屏。
 */
export function decodeSplashChoice(raw: unknown): SplashChoice | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (raw === 'icon') return { kind: 'icon' }
  if (raw === 'shipped') return { kind: 'shipped' }
  if (raw.startsWith('user:')) {
    const name = raw.slice('user:'.length)
    return checkSplashName(name).ok ? { kind: 'user', name } : null
  }
  return null
}

/** 两个选择是不是同一个。★ 纯函数，两端共用 —— 界面里别再各写一份。 */
export function sameChoice(a: SplashChoice, b: SplashChoice): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'user' && b.kind === 'user' ? a.name === b.name : true
}

/**
 * ══ 屏上该给哪一档画「使用中」 ★★（2026-09-14）═════════════
 *
 * 他选的那张可能**已经不在了** —— 他在这台机器上删了、
 * 或者在手机上删了而碑同步过来了。那时候库里那一条还记着
 * `user:<不在了的名字>`（**故意不清**，见 `main/splash.ts::deleteUserSplash`）。
 *
 * 于是屏上会出现一个从来没人想过的态：哪一张卡都对不上，
 * 「使用中」**一枚都不亮** —— 而设置页上白纸黑字写着
 * 「候选可以有很多张，正在用的只有一张」。那句话当场就是假的。
 *
 * ★ 退法和**真正画出来的那一帧**完全一致（`main/splash.ts::splashArt`）：
 *   他选的 → 出厂插画 → 图标。不一致的话，徐上那枚徽章就在指一张
 *   开机时根本不会出现的图 —— 那比一枚都不亮更坏。
 * ★ 它**不写库** —— 只回答「现在屏上该亮哪一枚」。库里那一条记着的是
 *   **他本来要哪一张**；同一张图再加回来时（碑被 `gone:false` 压过）
 *   他的选择要跟着回来，不用重新挑一次。
 *
 * @param available 现在真实拿得出来的那几档（卡片名单）
 */
export function shownChoice(
  active: SplashChoice,
  available: readonly SplashChoice[]
): SplashChoice {
  if (available.some((c) => sameChoice(c, active))) return active
  if (available.some((c) => c.kind === 'shipped')) return { kind: 'shipped' }
  return { kind: 'icon' }
}
