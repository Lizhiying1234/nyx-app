/**
 * 首次引导：现在出不出（SC-25 · D-483）。
 *
 * ★ 判据不在这儿 —— `shouldOnboard` 在 core，两端一份。这里只负责
 *   「什么时候去问它」和「问完了把答案摆在界面上」。
 * ★ 只问一次（`asked`）：库状态一变就重问的话，同步跑完、库重开都会让引导
 *   在他用到一半时再盖上来。看过没看过是**启动那一刻**的事。
 */
import { shouldOnboard } from '../../core-link.ts'
import { clearOnboardMark, onboardMark, setOnboardDone } from '../../db/onboarding.ts'
import type { Db } from '../../db/types.ts'

class OnboardState {
  /** 引导正盖在屏上 */
  open = $state(false)
  /** 这次启动问过没有 —— 问过就不再问（哪怕库又重开一次） */
  private asked = false

  /** 开库之后问一次：这台设备看过没有 */
  async decide(db: Db): Promise<void> {
    if (this.asked) return
    this.asked = true
    this.open = shouldOnboard(await onboardMark(db))
  }

  /**
   * 收掉（看完 / 跳过 **同一条路**：都算看过）。
   *
   * ★ 先收屏再写记号：写失败也不许把他关在引导里。代价是「下次启动再出一次」——
   *   那正是 core 注释里挑明的那个方向（宁可多出一次，也不要永远见不到）。
   */
  async finish(db: Db): Promise<void> {
    this.open = false
    await setOnboardDone(db)
  }

  /** 「再看一次新手引导」：清掉记号并立刻打开 */
  async again(db: Db): Promise<void> {
    await clearOnboardMark(db)
    this.open = true
  }
}

export const onboard = new OnboardState()
