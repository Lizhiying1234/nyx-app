/**
 * ══ 这台手机的凭据口子 · **只有一个** ═══════════════════════════
 *
 * D-220：key 加密存放、永不上云 —— Android 上是 Keystore
 * （`@aparajita/capacitor-secure-storage`，插件自己那张
 * `WSSecureStorageSharedPreferences`）。`settings` 与 `user_preferences`
 * 两张表里**连密文都没有**（Windows 那侧是 safeStorage 密文进 settings，
 * 这一端连那一步都不做）。
 *
 * ── 为什么 T-7.6 把它从 `db/ai.ts` 里抬出来 ─────────────────
 *
 * 这个口子原来住在 `db/ai.ts`，因为当时只有 AI 三槽有 key。T-7.6 起
 * 云端朗读也要 key（D-374 那句「手机不单配云 TTS key」本轮作废 ——
 * 出处：T-7.6 目标「设置页云端三项由只读改可写」）。
 *
 * 两处各写一份 `SecureStorage.getItem` 的下场是可以预见的：引擎那一侧
 * 拿 key 走的是**原生解密同一张表**（`host.secret`，D-404），谁忘了接谁
 * 就在无头 WebView 里静默拿到空 key —— 而空 key 的症状是「云端老是失败」，
 * 查起来要走一整趟真机。所以口子收成一处：
 *
 *   读   `secret(name)`      —— 默认 Keystore；引擎与 ② 层用例各自注入
 *   写   `putSecret(name, v)` —— 同上（写也要能注入，否则「key 没落库」这件事
 *        在 node 里根本测不了：`SecureStorage.setItem` 在 node 上直接抛）
 *
 * ★ 注入点只有这两个。除此之外**不许**再开：明文 key 不进 settings（D-220）。
 * ★ `setKeyProvider` 是老名字，引擎（`engine/main.ts` 端口③）与三个 ② 层
 *   用例都在用 —— 不改名，改名只会让下一个人以为有两个口子。
 *
 * ── ★★ 插件**不在模块顶层 import**（T-7.6 补）────────────────
 *
 * 会话 D 干净重建时查出来：`assist-engine.js` 里打进了 `@capacitor/core`
 * （含 `CapacitorHttp` 的 web 实现）与 secure-storage。链路是
 * `engine/main.ts → db/ai.ts → 这里 → 插件 → @capacitor/core`。
 *
 * ★ 这条链**不是 T-7.6 长出来的**：`db/ai.ts` 顶上那句
 *   `import { SecureStorage } from '@aparajita/capacitor-secure-storage'`
 *   在 `27870b9`（T-7.6 开工之前）就在，引擎那时就已经带着它。T-7.6 只是把
 *   同一句从 `ai.ts` 搬到了这里 —— 链没变、长度没变。**但它一直是错的**：
 *   D-404 说得很清楚，引擎那个 WebView 没有 Capacitor 桥，打进去的是一份
 *   永远跑不到的死代码（引擎自己用 `setKeyProvider(host.secret)` 覆盖掉了）。
 *   既然查出来了就一起治。
 *
 * ★★ 先试过惰性 `await import()`，**没用，实测**：引擎那一份是
 *   `formats: ['iife']` 的单文件产物（`vite.engine.config.ts`），单文件没法
 *   代码分割，动态 import 会被**内联进同一个包** —— 改完重建，
 *   `assist-engine.js` 还是 185.51 kB，`SecureStorage × 8` 一条不少。
 *   （这就是为什么这一轮顺手把那道闸做了：光看代码看不出来。）
 *
 * ★ 所以真实现挪去 `db/secret-native.ts`，**只有 App 入口 import 它**
 *   （`src/ui/main.ts` 调一次 `installNativeSecrets()`）。这里只剩口子，
 *   零依赖，引擎那条链再也摸不到插件。
 * ★ 没装就读写 → **抛**，不返回 `null`。返回 null 会让每一个
 *   `catch { apiKey = '' }` 把「装配漏了」讲成「他还没配 key」——
 *   同一句话说两件事，正是最难查的那一类。抛出来至少在开发期当场炸。
 */

export type SecretReader = (name: string) => Promise<string | null>
export type SecretWriter = (name: string, value: string) => Promise<void>

/** 还没装口子就来读写 = 装配漏了。**当场说出来**，不静默当成「没配过」 */
export const SECRET_PORT_NOT_INSTALLED = '这一端还没装凭据口子'

let reader: SecretReader = () => Promise.reject(new Error(SECRET_PORT_NOT_INSTALLED))
let writer: SecretWriter = () => Promise.reject(new Error(SECRET_PORT_NOT_INSTALLED))

/**
 * 换掉「怎么读」。两个合法的注入点：
 *   · ② 层测试跑在 node（没有 Keystore）→ 内存版
 *   · ★ D-404 · Assist 引擎跑在无桥的 WebView 里 → 原生解密同一份
 *     `WSSecureStorageSharedPreferences`（就是插件自己那张表，不是第二处）
 */
export function setKeyProvider(fn: SecretReader): void {
  reader = fn
}

/** 换掉「怎么写」—— 只有 ② 层用例用（引擎不写凭据，它只读） */
export function setKeyWriter(fn: SecretWriter): void {
  writer = fn
}

/** 旧名，三个 ② 层用例还在用 */
export const __setKeyProviderForTests = setKeyProvider

export const secret: SecretReader = (name) => reader(name)
export const putSecret: SecretWriter = (name, value) => writer(name, value)
