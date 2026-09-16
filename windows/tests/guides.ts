import type { Page } from 'playwright-core'
import { GUIDE_SEEN_KEY, PAGE_GUIDES } from '../src/core/onboarding.ts'

/**
 * 把页面内引导（第二层 · D-484）全部标成**看过了**。
 *
 * ══ 为什么每一套非引导的 smoke 都要先叫它一次 ★★★ ═════════════
 *
 * 第二层引导一出来就**盖着整页**（聚焦遮罩，那正是它该做的）。
 * 不标的话它会把**别处**的用例弄成假红 —— 而报出来的错是
 * 「点不到 `nav-settings`」，看着像产品坏了，实际上是一个框挡在那儿。
 * 2026-09-15 一天之内真栽了三次：`smoke:ui` 47→42 · `smoke:study` 4 红 ·
 * `smoke:first` 1 红，三次的病根都是这一条。
 *
 * ══ 为什么名单从 core 生成，不手抄 ★★★ ═══════════════════════
 *
 * 手抄那一版**当天就烂了**：B-8 一删，三套里那行 `'project-progress': 1`
 * 就指向一个不存在的 id（无害，但已经是假的）。
 * 真正要防的是反过来：**新增**一条引导时，手抄的名单不会跟着长 ——
 * 那条新引导会在三套里到处弹，而三套红的地方**都跟它没关系**，
 * 查起来要先想到「这不是我改的那块坏了」。
 * 从 `PAGE_GUIDES` 生成之后，名单一长这里自动跟上。
 *
 * ★ 引导自己的行为由 `smoke:guide` 钉，不在别的套里验。
 */
export async function markGuidesSeen(page: Page): Promise<void> {
  const seen = Object.fromEntries(PAGE_GUIDES.map((g) => [g.id, g.version]))
  await page.evaluate(
    async ([k, json]) => await window.nyx.ui.set(String(k), String(json)),
    [GUIDE_SEEN_KEY, JSON.stringify(seen)] as const
  )
}
