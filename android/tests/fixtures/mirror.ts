/**
 * ══ 镜像的**唯一一份样例**（G-3 · 2026-09-14）★★ ═════════════
 *
 * 启动那一帧要在**开库之前**画出来，所以它读的是 `localStorage` 镜像，
 * 而且只能写成 `index.html` 里那段**手写内联脚本**（那时候 JS 包还没起来，import 不进去）。
 * 于是同一个格式有两个当事人：**写的那一侧是 TS**（`db/splash.ts` · `db/colors.ts`），
 * **读的那一侧是内联脚本**。
 *
 * 本轮对账之前那边还各有一份「读」：`splashChoiceFromMirror` / `splashUrlFromMirror` /
 * `overridesFromMirror` —— 三个都没人调，而它们看上去仍然是权威实现。
 * 格式一改，活的那个手动改，死的那个静静漂走（收敛结论 D-3 变种二）。
 * 死的那三个已经删了（A-3），**判据只有一份**那一半靠这份 fixture：
 * 写那一侧和读那一侧**用同一组样例值**，格式改一处两边同红。
 *
 * ★ 值本身要像真的：名字是 sha256 那一种、地址是 Capacitor 换出来的那一种、
 *   颜色是六位 HEX —— 内联脚本里有白名单，样例不像真的就试不出它。
 */
import type { SplashChoice } from '../../src/core-link.ts'

/** 他选中的那张「我的图」（名字 = 内容 sha256 + 扩展名，判据在 core） */
export const FIX_CHOICE: SplashChoice = {
  kind: 'user',
  name: 'b142e4caf1d6c50d38b4408401892c79febfb8007988dee85d59150d3ab59089.webp'
}

/** 那张图在 WebView 里的地址（`Capacitor.convertFileSrc` 换出来的形状） */
export const FIX_URL =
  'capacitor://localhost/_capacitor_file_/data/user/0/com.nyx.app/files/splash/' +
  'b142e4caf1d6c50d38b4408401892c79febfb8007988dee85d59150d3ab59089.webp'

/** 他改过的两格颜色（令牌名 + 六位 HEX —— 内联脚本只认这个形状） */
export const FIX_OVERRIDES: Record<string, string> = {
  'color-bg': '#0b0f14',
  'color-ink': '#e8eef5'
}
