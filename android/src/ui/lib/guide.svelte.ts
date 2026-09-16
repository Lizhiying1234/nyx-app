/**
 * 页面内功能引导（第二层）· 什么时候出、出哪一条。
 *
 * ══ 判据一条都不在这儿 ═════════════════════════════════════
 * 「有哪几条」「这一条要不要出」「看过表长什么样」全在 core
 * （`PAGE_GUIDES` / `shouldShowGuide` / `parseGuideSeen`）。
 * 这一层只干三件事：**什么时候去问**、**问完摆在哪**、**看过了记一笔**。
 *
 * ══ 为什么按「元素挂载」触发，不按「进页面」触发 ★★ ═══════════
 * D 核过 `Practice.svelte`：结算块在 `{#if result}` 里，**答完一题才挂上**，
 * 而且 `loadNext()` 每出一道新题都会把它卸掉重挂 —— 一次练习 15 道题 = 挂 15 次。
 * 按「路由进入」触发根本抓不到它；按挂载触发则会被打 15 次，
 * **全靠「看过」这一笔挡住**。
 *
 * ★★★ 所以「记一笔」和「摆上去」是**同一拍**做的，中间不许有异步窗口：
 *   原来打算「弹出 → 播动画 → 收尾时写库」，那样第 2 题那一次会挤进窗口里，
 *   于是同一次练习里对着他弹两次。宁可少出一次，也不要重复弹 ——
 *   真机上重复弹很刺眼，而用例里不会红（这一条是 D 提醒的，抄在这里）。
 */
import { PAGE_GUIDES, shouldShowGuide, type GuideSeen } from '../../core-link.ts'
import { guideSeen, markGuideSeen } from '../../db/guide.ts'
import type { Db } from '../../db/types.ts'

/** 屏上正指着的那一条 */
export interface GuideShown {
  id: string
  says: string
  /** 目标在视口里的位置（挖洞与折线都按它算） */
  rect: { x: number; y: number; w: number; h: number }
}

class GuideState {
  open = $state<GuideShown | null>(null)
  /** 这台设备看过哪几条 —— 开库之后读一次，之后本地维护（不每次回库） */
  private seen: GuideSeen = {}
  private loaded = false
  /**
   * 第一层还没看完时**一条都不出**（派单：两层互斥）。
   * 由 App 在挂 `<Guide />` 那一层告诉我们，这里不自己去读第一层的记号 ——
   * 读两处就会有两个答案。
   */
  blocked = $state(true)
  /**
   * ★★★ 收掉一条之后**这一屏不再出下一条**，直到他自己走到别处去（2026-09-15 真机上抓到的）。
   *
   * 不加这一条的话：收掉第一条 → 遮罩那层从 DOM 上摘掉 → 那本身就是一次
   * childList 变动 → 立刻扫出第二条弹上来。真机上的样子是「点掉一句又冒一句」，
   * 而我那一下点 Tab 其实是点在第二条的遮罩上 —— **它被我顺手点没了，他一眼没看见**，
   * 记号却记下了「看过」。
   *
   * 使用者第四条明写「不能变成长篇教程」「不要一次介绍太多功能」。
   * 所以判据是：**一次页面停留只出一条**，下一条等他走到别的地方再说。
   */
  private paused = false

  async load(db: Db): Promise<void> {
    if (this.loaded) return
    this.seen = await guideSeen(db)
    this.loaded = true
  }

  /**
   * 扫一遍屏上有没有该出的引导，出**第一条**。
   *
   * ★ 一次只出一条：同时挖两个洞、连两条线，屏上就没有「现在看这里」了。
   * ★ `document.querySelectorAll` 的顺序 = DOM 顺序 = 从上到下，正好是他视线的顺序。
   */
  async scan(db: Db): Promise<void> {
    if (this.blocked || this.open || this.paused) return
    await this.load(db)
    for (const el of document.querySelectorAll('[data-guide]')) {
      const id = (el as HTMLElement).dataset['guide'] ?? ''
      const def = PAGE_GUIDES.find((g) => g.id === id)
      /**
       * ★ 名单在 core：认不出的 id **什么都不做**。那是代码写错了，
       *   不该表现成「屏幕上多出一句没人认领的话」（core 注释原话）。
       */
      if (!def || !shouldShowGuide(this.seen, id, def.version)) continue
      const r = el.getBoundingClientRect()
      // 还没排版好（高宽为 0）就跳过 —— 下一次挂载再说，别指着一个点
      if (r.width < 4 || r.height < 4) continue
      /**
       * ★★★ 先记一笔再摆上去 —— 两件事同一拍，中间不留异步窗口。
       *   本地这份 `seen` 立刻更新，所以紧接着的第二次 `scan`（下一题重挂）
       *   已经看得见「看过了」，不必等库写完。
       */
      this.seen = { ...this.seen, [id]: def.version }
      void markGuideSeen(db, id, def.version)
      this.open = { id, says: def.says, rect: { x: r.x, y: r.y, w: r.width, h: r.height } }
      return
    }
  }

  /** 收掉（点遮罩 / 点「知道了」/ 返回键 —— 同一条路） */
  close(): void {
    this.open = null
    this.paused = true
  }

  /** 他走到别的地方去了 —— 下一条可以出了（由 App 按路由变化调） */
  resume(): void {
    this.paused = false
  }

  /** 「把页面引导重新打开」之后要让本地这份也忘掉，否则这一次运行里还是不出 */
  forget(): void {
    this.seen = {}
    this.loaded = false
    this.open = null
    this.paused = false
  }
}

export const guide = new GuideState()
