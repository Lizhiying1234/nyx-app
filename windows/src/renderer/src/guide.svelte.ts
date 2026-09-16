import {
  GUIDE_SEEN_KEY,
  guideById,
  noteGuideSeen,
  parseGuideSeen,
  shouldOnboard,
  shouldShowGuide,
  ONBOARDING_KEY,
  type GuideSeen
} from '@core/onboarding.ts'

/**
 * 页面内引导（第二层）的总闸 · D-484
 *
 * ══ 为什么是一个总闸，不是每页各管各的 ★★★ ═══════════════════
 *
 * 七条引导长在六个不同的组件里。各管各的话，有三件事**每一处都要重写一遍**：
 *   ① 看过没有（读 `ui.guide.seen`）
 *   ② 第一层看完没有（没看完不许出第二层）
 *   ③ 同时只许出一条
 * 重写六遍 = 六份判据，而漏掉其中一处的表现是**屏上同时弹两个框**，
 * 或者**他第一次进来就被第二层糊一脸**。
 *
 * 所以页面只说一句「我这儿碰到 X 了」（`askGuide('sidebar-tree')`），
 * 出不出、什么时候记「看过」，全在这里判。
 *
 * ★ 状态读一次就缓存：`ui:get` 每次都走 IPC，而这几个触发点
 *   （展开侧栏 · 进结算屏）会被反复碰到。
 */

/** 现在屏上开着的那一条；`null` = 没有 */
let active = $state<string | null>(null)
/** 库里那张「看过」表。`null` = 还没读过 */
let seen: GuideSeen | null = null
/** 第一层看完没有。`null` = 还没读过 */
let onboardDone: boolean | null = null

export const activeGuide = (): string | null => active

async function load(): Promise<void> {
  if (seen !== null && onboardDone !== null) return
  try {
    const [rawSeen, rawDone] = await Promise.all([
      window.nyx.ui.get(GUIDE_SEEN_KEY),
      window.nyx.ui.get(ONBOARDING_KEY)
    ])
    seen = parseGuideSeen(rawSeen)
    onboardDone = !shouldOnboard(rawDone)
  } catch {
    /**
     * ★ 读不出来就**当这一趟不出引导**（而不是当成没看过）：
     *   读不出来多半是库还没开好，那时候弹一个框只会挡住他要看的东西。
     *   下一次碰到同一个触发点还会再问一次，不会永远错过。
     */
    seen = null
    onboardDone = null
  }
}

/**
 * 页面碰到某个东西了，问一下要不要出。
 *
 * ★★ **与第一层互斥**（派单 G-4）：第一层还没看完就一条都不出 ——
 *   他第一次进来该看的是那五步，不是被六个小框轮流点名。
 * ★ 同时只许出一条：已经开着就不再开第二条（后来的那条下次还会触发）。
 *
 * ══ 为什么要排队 ★★★（I-190 落地时连栽两次）═══════════════════
 *
 * 判断「出不出」中间隔着一次 `await load()`（要读库）。同一拍里问两条
 * （Today 上就是 `today-paste` ＋ `sidebar-tree`）会踩到两种坏法：
 *   ① 只看 `active`：两条都在 await 之前看到 `null`，**后到的把先到的盖掉**，
 *      屏上的表现是「第一条永远不出」——，而它看起来像触发写错了。
 *   ② 加一个同步占位就返回：第一条**没通过**（比如已经看过）时，
 *      第二条也被那半拍的占位挡掉了 —— 变成「这一页一条都不出」。
 * 两种我都写过，都是拿屏幕量出来才知道的。
 *
 * 所以改成**排队**：一条一条来，轮到谁谁再看一眼 `active`。
 * 先问的先得；先问的那条如果没出，后面那条照样有机会。
 */
let chain: Promise<void> = Promise.resolve()

export function askGuide(id: string): Promise<void> {
  chain = chain.then(() => ask(id))
  return chain
}

async function ask(id: string): Promise<void> {
  if (active !== null) return
  if (!guideById(id)) return
  await load()
  if (seen === null || onboardDone !== true) return
  if (!shouldShowGuide(seen, id)) return
  active = id
}

/**
 * 关掉，并记一笔「这一条看过了」。
 *
 * ★★ 记的是**当时那一条的 version**：内容以后改了（version +1），
 *   `shouldShowGuide` 会让它**只重弹这一条**，别的几条不动。
 * ★ 先把屏上关掉再写库：写库失败也不该让那个框卡在屏上 ——
 *   最坏的结果是下次再弹一次，那比关不掉好得多。
 */
export async function closeGuide(): Promise<void> {
  const id = active
  active = null
  if (!id) return
  const def = guideById(id)
  if (!def || seen === null) return
  seen = { ...seen, [id]: def.version }
  try {
    await window.nyx.ui.set(GUIDE_SEEN_KEY, noteGuideSeen(JSON.stringify(seen), id, def.version))
  } catch {
    /* 写不进去就算了，下次再弹一次 */
  }
}

/**
 * 目标不在屏上，这一条这趟不出了 —— **不记「看过」**。
 *
 * ★★ 和 `closeGuide` 的差别就是那一笔记录，而那一笔是**不可逆**的：
 *   记了就等于说「他看过这句话了」，`shouldShowGuide` 从此返回 false，
 *   这条引导**再也不会出现** —— 而他一个字都没看见。
 *   所以量不到目标只清 `active`：下次他再碰到那个控件，它照样会出。
 *
 * ★★★ **必须留一行 warn**（T-3 · I-190）：这条路对使用者是**完全无声**的 ——
 *   有触发、没目标的引导就这么安静地永远不出现，而四门全绿。
 *   `assist-lecture` 曾经就被判成这种（判错了，但**没人能从屏上看出来**
 *   才是真正的问题）。`warn` 不改产品表现，只是让这条路在开发时**看得见**。
 *   ★ 用 `warn` 不用 `error`：几套 smoke 都断言「渲染进程没有 console.error」，
 *     用 error 的话这一行会把别处的用例弄红，而它本身不是故障。
 */
export function dropGuide(id?: string): void {
  console.warn(`[guide] 放弃「${id ?? active ?? '?'}」—— 连着量不到它的 data-guide 目标`)
  active = null
}

/**
 * 「把页面引导重新打开」（设置 › 数据）—— 一条条恢复没意义，整张表清掉。
 *
 * ★★ 回**成没成**，不吞掉：这一条是他亲手点的，写不进库而屏上说「好了」的话，
 *   他下次进页面发现什么都没出，只会以为这个按钮是死的。
 *   （内存里那份不回滚 —— 这一趟它确实会再出，只是重启之后不算数。）
 */
export async function resetGuides(): Promise<boolean> {
  seen = {}
  active = null
  try {
    await window.nyx.ui.set(GUIDE_SEEN_KEY, '{}')
    return true
  } catch {
    return false
  }
}
