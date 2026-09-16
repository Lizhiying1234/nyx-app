/**
 * ══ O · 首次引导的记号（SC-25 · D-483）★ ════════════════════
 *
 * 这一组盯的**不是**「要不要出引导」—— 那个判据在 core（`shouldOnboard`），
 * core 自己有用例。这里盯的是本端接线的四件事，每一件都有一种安静的坏法：
 *
 *   ① 记号写进了哪张表 —— 写错成 `user_preferences` 会**跟着同步走**，
 *      于是「在电脑上看过了」让这台手机永远见不到引导。两边都不报错。
 *   ② 键名是不是 core 那一个 —— 手写第二份，两端就有两个答案。
 *   ③ 读出来有没有被本端**先解释一遍** —— 解释一次就是第二份判据。
 *   ④ core 的五步有没有真的都排进了某一屏 —— 少一屏不会红，只是屏上少一件事。
 *
 * ★ 负向对照打在 ①：把 `setOnboardDone` 里那句 `insert` 拆掉 → O-2 当场红。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ONBOARDING_KEY, ONBOARDING_STEPS, onboardingSteps, shouldOnboard } from '../src/core-link.ts'
import { clearOnboardMark, onboardMark, setOnboardDone } from '../src/db/onboarding.ts'
import { pagesOf } from '../src/ui/lib/onboarding.ts'
import { builtDb, cleanup } from './helpers.ts'

after(cleanup)

describe('O · 首次引导的记号（DEVICE，两端同键）', () => {
  it('O-1 · 新库：没有记号 → core 说该出', async () => {
    const f = builtDb()
    assert.equal(await onboardMark(f.db), null, '★ 空库里不该有这一行')
    assert.equal(shouldOnboard(await onboardMark(f.db)), true)
  })

  it('O-2 · 看过之后不再出（看完和跳过是同一条路）', async () => {
    const f = builtDb()
    await setOnboardDone(f.db)
    assert.equal(
      shouldOnboard(await onboardMark(f.db)),
      false,
      '★★ 记号没落库 —— 他每次启动都会再看一遍那四屏'
    )
  })

  it('O-3 · 记号进 settings，不进 user_preferences（换台手机该重看）', async () => {
    const f = builtDb()
    await setOnboardDone(f.db)

    const dev = await f.db.get(`select value from settings where key = ?`, [ONBOARDING_KEY])
    assert.ok(dev?.['value'], '★ 不在 settings 里')

    const synced = await f.db.all(`select key from user_preferences where key like ?`, ['%onboarding%'])
    assert.deepEqual(
      synced,
      [],
      '★★ 它进了同步表 —— 「在电脑上看过了」会让这台手机永远见不到引导'
    )
  })

  it('O-3b · 键名用的是 core 那一个，不是本端手写的第二份', () => {
    assert.equal(ONBOARDING_KEY, 'ui.onboarding.doneAt')
    const src = readSelf('src/db/onboarding.ts')
    assert.ok(
      !src.includes(`'${ONBOARDING_KEY}'`) && !src.includes(`"${ONBOARDING_KEY}"`),
      '★ 本端把键名抄成了字面量 —— 两端从此可以各改各的'
    )
  })

  it('O-4 · 「再看一次新手引导」：清掉记号就又该出', async () => {
    const f = builtDb()
    await setOnboardDone(f.db)
    await clearOnboardMark(f.db)
    assert.equal(await onboardMark(f.db), null)
    assert.equal(shouldOnboard(await onboardMark(f.db)), true)
  })

  it('O-4b · 坏值原样交给 core 判，本端不先解释一遍', async () => {
    const f = builtDb()
    // 乱码 / 0 / 负数 —— core 裁「当没看过」（宁可多出一次，也不要永远见不到）
    for (const bad of ['', '0', '-1', '昨天']) {
      await f.db.run(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value`,
        [ONBOARDING_KEY, bad, Date.now()]
      )
      assert.equal(await onboardMark(f.db), bad, `★ 本端把 ${JSON.stringify(bad)} 改写了`)
      assert.equal(shouldOnboard(await onboardMark(f.db)), true)
    }
  })

  it('O-5 · core 的每一步都排进了某一屏（并屏是形式，不许吞掉内容）', () => {
    const pages = pagesOf(ONBOARDING_STEPS)
    assert.equal(pages.length, 4, '★ Android 形态是四屏')
    const shown = pages.flat().map((s) => s.id)
    assert.deepEqual(
      [...shown].sort(),
      ONBOARDING_STEPS.map((s) => s.id).sort(),
      '★★ core 有一步没排进任何一屏 —— 屏上少一件事，而没有任何东西会红'
    )
    assert.equal(new Set(shown).size, shown.length, '★ 同一步排进了两屏')
    assert.deepEqual(pages[3]!.map((s) => s.id), ['G-4', 'G-5'], '★ G-5 并进第四屏')
  })

  /**
   * ★★ O-7 · 引导渲染的必须是**参数化那份**（`onboardingSteps(n)`）。
   *
   * G-5 标题里「连着答对几次」跟着 `param.silenceStreak` 走。渲染写死那份
   * （`ONBOARDING_STEPS`）的话，他把出厂 3 改成 2 之后，引导第一次打开就在说假话 ——
   * **而没有任何东西会红**：文案没有类型，也没有闸去比这两个数。
   * 2026-09-15 我第一版正是写死的，是回头查 core 注释时发现的。
   *
   * ★ 先剥注释再看（同一天第三次栽在这上面）：文件头的说明里也会出现这些名字。
   */
  it('O-7 · 组件用参数化那份，不是写死那份', () => {
    const src = readSelf('src/ui/lib/Onboarding.svelte')
      .replace(/<!--[^]*?-->/g, ' ')
      .replace(/\/\*[^]*?\*\//g, ' ')
      .replace(/^[ 	]*\/\/.*$/gm, ' ')
    assert.ok(src.includes('onboardingSteps('), '★★ 没调参数化那份 —— 他改了次数，引导还在说旧数')
    assert.ok(
      !src.includes('ONBOARDING_STEPS'),
      '★★ 还在渲染写死那份 —— 两份同时在，迟早渲染到错的那一份'
    )
  })

  it('O-7b · 那个数真的会变（对照的对照：分得出差别才算数）', () => {
    const at3 = onboardingSteps(3).find((s) => s.id === 'G-5')!.title
    const at2 = onboardingSteps(2).find((s) => s.id === 'G-5')!.title
    assert.notEqual(at3, at2, '★ 参数没进标题 —— 那上面那条断言就是在验一个不动的东西')
  })

  it('O-5b · core 哪天加一步，它掉在最后一屏，不会凭空消失', () => {
    const extra = { id: 'G-9', title: '将来的一步', body: '一句话。' }
    const pages = pagesOf([...ONBOARDING_STEPS, extra])
    assert.ok(
      pages[pages.length - 1]!.some((s) => s.id === 'G-9'),
      '★★ 没点名的步骤被丢掉了 —— core 加一步，手机上就少一件事'
    )
  })
})

/** 读本仓自己的源码（O-3b 要看的是**怎么写的**，不是跑出来什么） */
function readSelf(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
}
