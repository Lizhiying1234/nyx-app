import type { Page } from 'playwright-core'

/**
 * 侧边栏导航的测试小工具 · I-072
 *
 * 单元现在**默认折叠**（使用者要的），折叠的分组是 `visibility:hidden` ——
 * 里面的行点不到，这是对的：屏幕上看不见的东西，测试也不该点得到。
 *
 * 于是测试要先把路径展开。难点只有一个：toggle 是**开关**，
 * 对着已经展开的那个再点一下会把它关上。所以每一步都先问「它开着吗」，
 * 开着就不动 —— 否则展开 A 的同时把 B 关掉，来回拉锯。
 */

/** 这一行的分组展开着吗？展开时它后面那个兄弟 `.grp` 带 `show`。 */
async function isExpanded(page: Page, testid: string): Promise<boolean> {
  return page
    .locator(`[data-testid="${testid}"]`)
    .evaluate((el) => el.nextElementSibling?.classList.contains('show') ?? false)
    .catch(() => false)
}

async function expand(page: Page, testid: string): Promise<void> {
  if (await isExpanded(page, testid)) return
  await page.click(`[data-testid="${testid}"]`, { timeout: 3000 }).catch(() => {})
}

export async function openLecture(page: Page, lectureId: number): Promise<void> {
  const target = `[data-testid="nav-lecture-${lectureId}"]`
  const visible = (): Promise<boolean> =>
    page
      .locator(target)
      .isVisible()
      .catch(() => false)

  // reload 之后树是异步取的 —— 先等它到位，不然一个 toggle 都找不到
  await page.waitForSelector('[data-testid^="nav-toggle-project-"]', { timeout: 8000 })
  if (await visible()) {
    await page.click(target)
    return
  }

  const ids = async (prefix: string): Promise<string[]> =>
    Promise.all(
      (await page.locator(`[data-testid^="${prefix}"]`).all()).map(
        async (e) => (await e.getAttribute('data-testid')) ?? ''
      )
    )

  for (const p of await ids('nav-toggle-project-')) {
    if (await visible()) break
    await expand(page, p)
    for (const u of await ids('nav-toggle-unit-')) {
      if (await visible()) break
      await expand(page, u)
    }
  }

  if (!(await visible())) {
    throw new Error(`侧边栏里展不开 lecture ${lectureId} —— 它所在的项目/单元没找到`)
  }
  await page.click(target)
}
