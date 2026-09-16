/**
 * 启动页图片的名字：**每一次改名都要记时间**（2026-09-13）
 *
 * ── 为什么 ──────────────────────────────────────────────────
 * 使用者 2026-09-13 裁：名字要两端同步，「**以最后一次修改的名称为准**」，
 * 并且追问后补了一条：「**同端多次改名也按这条**」。
 * 「最后一次」要能比，就必须记下每一次改名发生在什么时候 ——
 * 只存名字的话，两边各有一个字符串，谁也说不出谁更新。
 *
 * ★ 同步那一半还没落（core 里那个 `<name>.meta.json` 归 Windows 会话；
 *   而且 Windows 端**现在根本没有改名功能** —— 每张传上去的图都叫「我传的图片」，
 *   `SplashRes.svelte:101` 写死的，我自己 grep 核过）。
 *   **但时间现在就得记**：否则接上那天，他在此之前改的名字全是「没有时间」的，
 *   一律输给对面，而他什么都没做错。
 *
 * ── 这道闸盯的是那个最看不见的地方 ──────────────────────────
 * **旧形状的迁移**：以前存的是 `id → 字符串`。碰到旧数据时给什么时间？
 *   给 0    → 他以前起的名字一律输，等于白起
 *   给 now  → 一律赢，把对面的新改名也压掉
 *   给那一行自己的 `updated_at` → **手上最好的证据**，那是这张表最后被写的真实时刻
 * 选了第三种。选错了不会红、不会抛，只会在某一天默默把名字弄反 —— 所以钉在这儿。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSplashNames, setSplashName } from '../src/db/splash.ts'
import type { Db } from '../src/db/types.ts'
import { checkSplashName } from '../src/core-link.ts'

/** 只够这几条用例使唤的假库：记住写进去的那一行 */
function fakeDb(row: { value: string; updated_at: number } | null): {
  db: Db
  written: () => { value: string; updated_at: number } | null
} {
  let cur = row
  let last: { value: string; updated_at: number } | null = null
  const db = {
    get: async () => (cur === null ? undefined : { ...cur }),
    run: async (_sql: string, args: unknown[]) => {
      last = { value: String(args[1]), updated_at: Number(args[2]) }
      cur = last
    }
  } as unknown as Db
  return { db, written: () => last }
}

describe('SPLASH 名字 · 每次改名都记时间', () => {
  it('① 新形状读得出名字和时间', async () => {
    const { db } = fakeDb({
      value: JSON.stringify({ 'user:a.png': { label: '海', at: 1700000000000 } }),
      updated_at: 1
    })
    assert.deepEqual(await getSplashNames(db), {
      'user:a.png': { label: '海', at: 1700000000000 }
    })
  })

  it('★ ② 旧形状（只有名字）→ 拿那一行自己的 updated_at 当时间', async () => {
    const { db } = fakeDb({
      value: JSON.stringify({ 'user:a.png': '海' }),
      updated_at: 1690000000000
    })
    assert.deepEqual(
      await getSplashNames(db),
      { 'user:a.png': { label: '海', at: 1690000000000 } },
      '★ 旧名字的时间取错了 —— 给 0 等于他以前起的名字白起，给 now 等于压掉对面的新改名'
    )
  })

  it('③ 改名写进去的时间是**现在**，而且只动这一条', async () => {
    const { db, written } = fakeDb({
      value: JSON.stringify({ 'user:a.png': { label: '海', at: 1 } }),
      updated_at: 1
    })
    const before = Date.now()
    const out = await setSplashName(db, 'user:b.png', '山')
    assert.equal(out['user:a.png']?.label, '海', '★ 动了别人那一条')
    assert.equal(out['user:a.png']?.at, 1, '★ 把别人的时间也刷新了 —— 那会让他没改过的名字凭空变新')
    assert.equal(out['user:b.png']?.label, '山')
    assert.ok((out['user:b.png']?.at ?? 0) >= before, '★ 新改的名字没记时间')
    assert.ok(written() !== null, '★ 没落库')
  })

  it('④ 清空 = 删掉这一条（回到出厂名），不是存一个空字符串', async () => {
    const { db } = fakeDb({
      value: JSON.stringify({ 'user:a.png': { label: '海', at: 1 } }),
      updated_at: 1
    })
    const out = await setSplashName(db, 'user:a.png', '   ')
    assert.deepEqual(out, {}, '★ 清空之后该回到出厂名，而不是留一条空名字')
  })

  it('⑤ 脏数据一律丢掉，不抛', async () => {
    for (const v of ['', 'not json', '[1,2]', JSON.stringify({ a: 1 }), JSON.stringify({ a: {} })]) {
      const { db } = fakeDb({ value: v, updated_at: 1 })
      assert.deepEqual(await getSplashNames(db), {}, `★ 这一份没被丢掉：${v}`)
    }
  })
})

describe('SPLASH 图片库 · 只收图，不收 meta（2026-09-13）', () => {
  /**
   * Windows 会话那边抓到一条：同步列**桶**的时候必须排掉 `.meta.json`，
   * 否则会把 `<sha>.webp.meta.json` 当成「名字不合规的图」，
   * **每趟往数据体检里塞一条假问题** —— 假问题比没问题更贵，
   * 它会让他以后不信体检。
   *
   * 他问我这端会不会有同一个毛病，并且说：「你那边今天安全，但那是靠
   * 『桶里的东西不会自己落到本地目录』这个**前提**撑着的，不是靠一道闸。」
   * —— 他说得对，所以把前提变成闸。
   *
   * ★ 结论比「今天安全」硬一档：`listSplashFiles()` 过的是 core 的白名单，
   *   而那条正则末尾是锚死的（`\.(webp|png|jpg|jpeg)$`），
   *   所以 `.meta.json` **压根过不去** —— 挡它的是白名单，不是前提。
   */
  it('★ meta 那一类名字一律不认（白名单末尾锚死）', () => {
    const sha = 'a'.repeat(64)
    for (const bad of [
      `${sha}.webp.meta.json`,
      `${sha}.meta.json`,
      `${sha}.json`,
      `${sha}.webp.json`,
      `${sha}.webp.meta`
    ]) {
      assert.equal(
        checkSplashName(bad).ok,
        false,
        `★ ${bad} 被当成图收了 —— 它会变成一张打不开的候选，或者一条假的体检问题`
      )
    }
  })

  it('真的图仍然认（别把闸收得连正事都挡了）', () => {
    const sha = 'a'.repeat(64)
    for (const good of [`${sha}.webp`, `${sha}.png`, `${sha}.jpg`, `${sha}.jpeg`]) {
      assert.equal(checkSplashName(good).ok, true, `★ ${good} 被挡掉了`)
    }
  })
})

