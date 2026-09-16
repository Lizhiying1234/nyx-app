/**
 * 首次引导：**哪一步排在哪一屏**（SC-25 · Android 形态）。
 *
 * ══ 为什么这件事在这儿、而不在组件里 ═══════════════════════
 *
 * core 定的是「讲哪五件、每件怎么说」（`ONBOARDING_STEPS`，两端一字不差）；
 * **分几屏是各端自己的形态**（D-474）：Windows 五步居中卡一步一屏，
 * Android 四屏左右滑、G-5 并进第四屏。派单原话：「并屏是形式，不改文案本身」。
 *
 * 分组写在这里是为了**能被用例盯住**：组件是 `.svelte`，node 用例导不进来，
 * 而这一条判断恰好有一种安静的坏法 —— core 哪天加了一步，它没被排进任何一屏，
 * 屏上少一件事，**没有任何东西会红**。所以：
 *   ① 没点名的步骤一律并进最后一屏（不许凭空消失）
 *   ② 用例钉住「每一步都在某一屏上」（`tests/onboarding.test.ts` O-5）
 */
import type { OnboardStep } from '../../core-link.ts'

/**
 * 四屏，按确认单表 3 的编号点名。
 * ★ G-4「练习分两条线」与 G-5「一段时间不练会静默」同屏：两件事说的是同一条
 *   知识点的后半生，分两屏会让第四屏只剩一句话。
 */
export const PAGE_IDS: readonly (readonly string[])[] = [['G-1'], ['G-2'], ['G-3'], ['G-4', 'G-5']]

/**
 * 把 core 那几步排成屏。
 * ★ 没被点名的步骤并进最后一屏 —— 宁可最后一屏多一段，也不要某一件事
 *   在手机上**根本不出现**（core 加一步是迟早的事，而少一屏不会报错）。
 */
export function pagesOf(steps: readonly OnboardStep[]): OnboardStep[][] {
  const pages = PAGE_IDS.map((ids) => steps.filter((s) => ids.includes(s.id)))
  const named = new Set(PAGE_IDS.flat())
  const rest = steps.filter((s) => !named.has(s.id))
  if (rest.length > 0) pages[pages.length - 1]!.push(...rest)
  return pages
}
