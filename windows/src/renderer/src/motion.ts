/**
 * 动效 —— **全 App 只有三样**（DS-Q25 定案，2026-09-07）
 *
 *   ① hover 变色            —— 纯 CSS，在 enhancements.css 里
 *   ② 折叠展开 180ms 对称    —— 就是这个文件
 *   ③ 右栏滑入              —— 右栏还不存在（D-477，归 SC-06 那一批）
 *
 * 不做页面转场、不做浮层进出动画（DS-Q6：两端即显即收）、不弹跳、不转圈。
 *
 * ── 为什么折叠要在 TS 里 ──────────────────────────────────
 * 折叠的内容是 `{#if}` 出来的：收起时它**根本不在 DOM 里**，
 * 而 CSS 只能给「在 DOM 里、有高度」的东西做过渡。想只靠 CSS 就得让内容常驻，
 * 而报告页那六块「深入」里各有一张图 —— 常驻等于每次进报告都画六张图，
 * 而且 T-4.16 定的是「默认收起，**一次一块**」。所以这一处用 Svelte 的 slide。
 *
 * ★ 这不是「在组件里写样式」（D-227）：这里没有任何视觉值 ——
 *   时长是一个数，方向由 slide 自己算。视觉值仍然只有一处：
 *   `tokens.css` 的 `--t-state: 180ms`。**两处要一起改**，所以下面写死了对照。
 *
 * ── 对称是判据不是偏好 ────────────────────────────────────
 * DS §五：状态切换「**进出同曲线同时长** —— 对称让人相信这件事可逆」。
 * slide 默认进出同参数，所以只要不给 in / out 各写一份，就自动是对称的。
 *
 * ── reduced-motion ────────────────────────────────────────
 * global.css 里那条 `@media (prefers-reduced-motion:reduce)` 只关得掉 CSS 的
 * transition / animation，**关不掉 JS 动画**。所以这里自己问一次系统。
 */

/** = `tokens.css` 的 `--t-state`。改一处就要改另一处。 */
export const FOLD_MS = 180

/** 系统说「少动一点」时就别动 —— 每次现问，他中途改设置也跟得上。 */
function reduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 折叠展开 / 收起的参数。用法：
 *
 *     import { slide } from 'svelte/transition'
 *     import { fold } from './motion'
 *     {#if open}<div transition:slide={fold()}>…</div>{/if}
 *
 * ★ 用 `transition:` 不是 `in:` / `out:` —— 那才是同一套参数进出两遍。
 */
export function fold(): { duration: number } {
  return { duration: reduced() ? 0 : FOLD_MS }
}
