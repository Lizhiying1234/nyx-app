/**
 * `verify` 到底跑哪几套 —— **只有这一份判据**（2026-09-07）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────
 *
 * `verify` 以前是一条手写的 20 多段 `&&` 长句，`check:suites` 靠顺着
 * `npm run x` 走传递闭包来判断「有没有套掉队」。两边都能工作，但那条长句
 * 有一个更坏的毛病：**`&&` 会短路**。`smoke:study` 一红，它后面 13 套
 * **一次都跑不到**，而屏幕上只有一个非零退出码 —— 人会以为「跑过全量了，红了一条」。
 * 2026-09-07 就是这么发生的：`smoke:study` 上有一条既有的红（朗读文案），
 * 于是那一轮谁跑 `verify` 都没真正跑到 nav / errors / esc / reading / ops / first。
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * 名单**不再手写**：`package.json` 里叫 `smoke` / `smoke:*` 的就是一套，
 * 除了 `PACKAGED_ONLY` 那几条（它们要先 `npm run package`）。
 * 于是 R-018「新加一套忘了接进 verify」这个失败面**结构上不存在了** ——
 * 放进 `package.json` 就自动在册。
 *
 * `scripts/verify.mjs`（跑）与 `scripts/check-suites.mjs`（守）都从这里取名单。
 * 判据搬了，守它的闸也要跟着搬 —— 所以两边共用一份，不各写各的。
 */

/** 只属于 `verify:all` 的：跑之前得先 `npm run package`，放进 `verify` 只会白等一次打包 */
export const PACKAGED_ONLY = new Set(['smoke:packaged'])

/** `package.json` 里所有的 smoke 套（含只属于 verify:all 的那几条） */
export function allSmokes(scripts) {
  return Object.keys(scripts).filter((n) => n === 'smoke' || n.startsWith('smoke:'))
}

/**
 * `verify` 的跑法：先门，再全部 smoke。
 *
 * ★ 顺序：`gate` → `smoke`（主干那一套，当探路的）→ 其余按字母。
 *   按字母是为了**确定** —— 每次跑的顺序一样，出了偶发才比得出来。
 * ★ 这里不做「门红了就别跑 smoke」的短路：那正是要修的东西。
 *   门红的时候 smoke 多半也红，但**红在哪几套**是有信息量的，
 *   而且门红时 Electron 起不来的话每套一秒就退，并不慢。
 */
export function verifyPlan(scripts) {
  const smokes = allSmokes(scripts)
    .filter((n) => !PACKAGED_ONLY.has(n))
    .sort((a, b) => (a === 'smoke' ? -1 : b === 'smoke' ? 1 : a.localeCompare(b)))
  return { gate: 'gate', smokes, suites: ['gate', ...smokes] }
}
