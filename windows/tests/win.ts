import type { ElectronApplication, Page } from 'playwright-core'

/**
 * 认出**主窗口** · I-157
 *
 * ══ 为什么不能再用 `app.firstWindow()` ══════════════════════════
 *
 * 2026-09-14 加了桌面悬浮球（使用者点名要的：Assist 的桌面开关入口）之后，
 * 全量验收一次 **64 红 + 289 取消**，几乎每一套都断。追下去只有一个原因：
 *
 *   `applyGlance()` 跑在 `registerIpc()` 里，而 `registerIpc()` 在
 *   `createWindow()` **前面** —— 于是那颗球是第一个 BrowserWindow，
 *   `firstWindow()` 忠实地把**球**交给了每一套测试，
 *   然后 20 套 smoke 都在一颗 46px 的球里找侧边栏，齐刷刷等到超时。
 *
 * 启动顺序那一头已经修了（主窗先建）。但**只修顺序不够** ——
 * `firstWindow()` 认的是「谁先开」，那是个和「谁是主窗」无关的属性；
 * 它今天对，只是因为今天的顺序凑巧对。下一次谁在主窗之前多开一个窗口，
 * 又是一场 289 取消，而报出来的症状会是「侧边栏没了」这种完全指错方向的话。
 * `overlay.test.ts` 早就为同一件事写过一句：
 * 「按窗口顺序认（`windows()[1]`）会在主窗重载时认错人。」
 *
 * ★ 判据用的是**渲染进程自己分流用的那把钥匙**（`src/renderer/src/main.ts`:97
 *   读 `?overlay=1` / `?bubble=1` 决定挂哪个根组件），不是测试另起一份名单 ——
 *   另起一份就是第二份判据，而两份必然漂（教训：判据不许自己再造一份）。
 *   主窗就是**两个标记都没有**的那一个。
 */
const SUB = ['overlay=1', 'bubble=1', 'marker=1']

/** 这个 URL 是副窗吗（浮窗 / 悬浮球）。 */
export const isSubWindow = (url: string): boolean => SUB.some((k) => url.includes(k))

/**
 * 等到主窗出现并交出来。
 *
 * ★ 要等：副窗可能先开，主窗晚几十毫秒；直接遍历一次会两手空空。
 * ★ 超时就**抛**，不退回 `firstWindow()` —— 退回去就等于把「主窗没起来」
 *   翻译成「侧边栏少了一行」，那正是这次花掉一小时的那种错话。
 */
export async function mainWindow(
  app: ElectronApplication,
  timeoutMs = 30_000,
  opts: { keepOnboarding?: boolean; keepGuides?: boolean } = {}
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const w of app.windows()) {
      let url = ''
      try {
        url = w.url()
      } catch {
        continue /* 正在关掉的窗口 */
      }
      if (url && !isSubWindow(url)) {
        if (!opts.keepOnboarding) await skipOnboarding(w)
        if (!opts.keepGuides) await markGuidesSeen(w)
        return w
      }
    }
    if (Date.now() >= deadline) {
      const seen = app
        .windows()
        .map((w) => {
          try {
            return w.url()
          } catch {
            return '(已关闭)'
          }
        })
        .join(' · ')
      throw new Error(`等不到主窗口（${timeoutMs}ms）。现在开着的窗口：${seen || '一个都没有'}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * ══ 把首次引导收掉 ★★（SC-25 · 2026-09-15）═══════════════════════
 *
 * 每一套 smoke 都用一个**全新的临时数据目录**起应用，而首次引导的判据就是
 * 「这台设备看过没有」—— 所以它会**在每一套面前都弹出来**，盖住整个主窗。
 * 不收的话，26 套一起红，而报出来的症状会是「侧边栏点不动」这种指错方向的话
 * （和 I-157 那次悬浮球一模一样的形状）。
 *
 * ★ 收的方式是**点那颗「跳过」** —— 真人就是这么做的，走的是产品自己的出口，
 *   不是给测试开一条后门（后门会让这条路在验收里永远是另一种样子）。
 * ★ 「跳过」也算看过，所以点完之后这一趟不会再弹第二次。
 * ★★ **验引导本身的那一套要传 `keepOnboarding: true`**（`first-look.test.ts`），
 *   否则它刚要断言就被这儿收走了 —— 那会变成一条永远绿的用例。
 *
 * ── 等多久 ────────────────────────────────────────────────
 * 引导是在主窗脚本一起来就决定出不出的（读一个键，不查任何业务表），
 * 所以常态下几百毫秒内就在了，下面这个循环一看到就走。
 * 8 秒只是**上限**：万一哪天它不出现（比如某套自己先写了记号），
 * 这儿也不该把那一套挂死 —— 等不到就当没有，继续跑。
 */
async function skipOnboarding(page: Page): Promise<void> {
  const deadline = Date.now() + 8_000
  const skip = page.locator('[data-testid="onboarding-skip"]')
  while (Date.now() < deadline) {
    try {
      if ((await skip.count()) > 0) {
        await skip.click({ timeout: 4_000 })
        await page.locator('[data-testid="onboarding"]').waitFor({ state: 'detached', timeout: 4_000 })
        return
      }
    } catch {
      /* 页面正在换 / 元素刚消失 —— 再看一眼就是了 */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * ★★★ 把页面内引导（第二层 · D-484）全部标成**看过了**，除非这一套要验它。
 *
 * ══ 为什么在这儿，不在每一套各写一遍 ★★★ ═══════════════════
 *
 * 引导一出来就**盖着整页**（聚焦遮罩，那正是它该做的），于是它会把**别处**的
 * 用例弄成假红 —— 报出来的错是「点不到 `nav-home`」，看着像产品坏了。
 *
 * 2026-09-15 这一天，同一张脸出现了**四次**：`smoke:ui` 47→42 · `smoke:study` 4 红 ·
 * `smoke:first` 1 红 · `smoke:layout` 4 红。前三次我是**一套一套去补**的 ——
 * 而那等于承认「下一套还会中招」：仓里 26 套起 Electron 的，当时只有 4 套标过。
 * `smoke:layout` 就是第四次，它在 `verify` 里**静静红着**，是主控查出来的。
 * ☞ 所以补在**每一套都会经过的那一处**：谁拿主窗，谁就已经标好了。
 *
 * ★ 要验引导本身的那一套传 `keepGuides: true`（今天只有 `smoke:guide`）。
 * ★ 名单**从 core 生成**（`tests/guides.ts`）：手抄那版当天就烂了 ——
 *   真正要防的是**新增**一条时手抄名单不会跟着长，于是那条新引导在各套里到处弹，
 *   而红的地方都跟它没关系。
 */
async function markGuidesSeen(page: Page): Promise<void> {
  try {
    const { markGuidesSeen: mark } = await import('./guides.ts')
    await mark(page)
  } catch {
    /**
     * ★ 标不上就算了，**不许把这一套弄红**：库还没开好 / 这个窗口没有 `window.nyx`
     *   都会走到这儿，而它们本来就不是故障。真有引导挡路的话，
     *   那一套自己会在点不到东西时报出来。
     */
  }
}
