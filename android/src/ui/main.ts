/**
 * 入口。样式的加载顺序是有意的：
 *
 *   ① tokens.css   Android 自己的令牌（DS v3 · D-316/D-364）。
 *                  ★ 旧注释说它「与 Windows 逐字相同（D-214）」—— 那是
 *                    已修偏差 W-1 之前的话，2026-08-26 起它按 DS v3 重建
 *   ② mobile.css   手机布局层，全新写的（D-239：布局层 0% 复用）
 *
 * 反过来加载的话，mobile 里没法覆盖任何东西 —— 不过它本来也不该覆盖令牌，
 * 它只决定「哪里用哪一档」。
 *
 * ══ fonts.css 为什么不在这儿了（2026-09-13）★★ ══════════════
 * 它从这里进的时候会被打进**同一份** `index-*.css`，而那份是
 * **阻塞绘制**的：真机上量到 246 KB 里 **200 KB（81%）是 @font-face**，
 * 于是启动页那张图明明早就取回来了，也得等这 246 KB 下完才画得出来
 * （冷启实测：css 66→348ms，图 360→388ms，first-paint 408ms）。
 *
 * 现在它改成**动态引入**：Vite 会把它单独出成一份 CSS，运行时才插 `<link>`，
 * 于是它天然不参与首次绘制。（在 `index.html` 里写 `<link>` 试过，不行 ——
 * Vite 那条路不解析 `@fontsource/*` 的 `@import`，产物里会留 21 条死引用。）
 * ★ 这样做安全的原因是**它只有 @font-face**：字体声明与层叠顺序无关，
 *   晚到只会让文字先用后备字体显示一下，而那段时间启动页正盖在上面。
 *   要是哪天往 fonts.css 里写了真正的规则，这个前提就没了 —— 别写。
 */
void import('./styles/fonts.css')
import './styles/tokens.css'
import './styles/mobile.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { installNativeSecrets } from '../db/secret-native.ts'
import { installAppSyncFirst } from '../db/sync-first-native.ts'

/**
 * ★★ 凭据口子的真实现在这里装，**而且只在这里**（T-7.6 补）。
 *
 * `db/secret.ts` 是零依赖的口子，插件的 import 关在 `db/secret-native.ts` 里 ——
 * 因为 `engine/main.ts → db/ai.ts → db/secret.ts` 那条链要是摸得到插件，
 * 整个 Capacitor 就会被打进 `assist-engine.js`，而那个 WebView **没有桥**
 * （D-404），打进去的是一份永远跑不到的死代码。
 *
 * ★ 装在挂载**之前**：界面一起来就可能读 key（Settings 的「已配 / 没配」、
 *   Lookup 的 AI 搜索）。装晚了那几处会拿到「还没装凭据口子」并当成没配过。
 * ★ 引擎那一侧不走这里，它有自己的端口③（`setKeyProvider(host.secret)`，
 *   原生解密同一张表）—— 同一处存放的另一条读法，不是第二处。
 */
installNativeSecrets()

/**
 * ★★ 「写库之前先同步一趟」的真实现也在这里装，**而且只在这里**（I-163）。
 *
 * 同一条边界、同一个理由：`db/sync.ts` 顶层拉 `sync-ports.ts`（Filesystem +
 * Keystore），而 `analyse.ts` / `analysis-runner.ts` / `edit-item.ts` 都在
 * `engine/main.ts` 的 import 图上 —— 三处从前各写一句 `await import('./sync.ts')`，
 * 就把整个 Capacitor 打进了 `assist-engine.js`（那个 WebView 没有桥，D-404）。
 *
 * ★ 装在挂载**之前**：他一进来就可能点「分析」或改词条。装晚了那几处会拿到
 *   「这一端还没装同步口子」，屏幕上就成了「分析前没同步上」。
 * ★ 引擎那一侧不装这个口子 —— 它压根不同步分析（`resumeBatch` 每条都传
 *   `noSyncPerItem`）；它要同步走自己的 `sync` op（端口⑤，同一个执行者）。
 */
installAppSyncFirst()

mount(App, { target: document.getElementById('app')! })
