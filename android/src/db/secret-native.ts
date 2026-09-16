/**
 * ══ 凭据口子的**真实现** · 只给 App 那一侧 ═══════════════════════
 *
 * 这个文件存在的唯一理由：**把插件的 import 关在 App 这一边**。
 *
 * `db/secret.ts` 是零依赖的口子（读 / 写各一个可注入的函数）。真正调
 * Android Keystore 的那一句在这里，而这里**只有 App 入口 import**
 * （`src/ui/main.ts`）。于是 `engine/main.ts → db/ai.ts → db/secret.ts`
 * 那条链再也摸不到 `@aparajita/capacitor-secure-storage`，
 * `assist-engine.js` 里也就不会再打进一份永远跑不到的 Capacitor（D-404）。
 *
 * ★ 惰性 `await import()` 试过，**不行**：引擎那一份是单文件 IIFE，
 *   动态 import 会被内联。判据靠文件边界，不靠写法。
 * ★ 引擎那一侧照旧走端口③（`setKeyProvider(host.secret)`，原生解密
 *   **同一张表** `WSSecureStorageSharedPreferences`）—— 不是第二处存放，
 *   是同一处的另一条读法（D-404）。
 * ★ `tools/check-engine-bundle.mjs` 守着这条边界：产物里再出现
 *   `SecureStorage` / `registerPlugin` 就红。
 *
 * ══ 这张表里现在存着什么（2026-09-14 真机实测，只看键名不看值）══
 *
 *   sync.secret              活 —— 同步凭据
 *   ai.heavy/light/long.key  活 —— AI 三槽
 *   tts.google-cloud.key     ★ **死的** —— D-466 之后全仓没有任何代码读它
 *
 * ★★ 那把死 key **故意留着，不删**（2026-09-14 我裁的，这是我的判断不是使用者的话）：
 *   · 它是**加密的**（Keystore），不是明文，界面上也看不见 —— 安全面很小；
 *   · 删掉**不可逆**：那是他从服务商那里拿的一串字符，删了要重新去申请；
 *   · 「死配置看起来像活的」这条风险，在 Windows 那边是成立的（那 6 行躺在
 *     `settings` 表里，翻库的人一眼看见就会以为云端语音还在），
 *     在这一端**只有读这个 XML 的人才看得见** —— 拿一条注释就能挡住。
 * ☞ 所以处置是**记在这里**，不是删。哪天真要清，那是使用者的决定，不是我的。
 */
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { setKeyProvider, setKeyWriter } from './secret.ts'

/** App 入口调一次。**只有这一处** —— 调两次也无妨（同一份实现覆盖上去） */
export function installNativeSecrets(): void {
  setKeyProvider((name) => SecureStorage.getItem(name))
  setKeyWriter((name, value) => SecureStorage.setItem(name, value))
}
