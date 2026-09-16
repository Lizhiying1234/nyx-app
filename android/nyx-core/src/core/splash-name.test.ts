import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSplashChoice,
  encodeSplashChoice,
  sameChoice,
  shownChoice,
  type SplashChoice
} from './splash-name.ts'

/**
 * 启动页「选了哪一张」· 2026-09-14
 *
 * ★★ 这个文件在今天之前**一条用例都没有**（grep 出来是 0）。
 *   发现它是因为 Android 那边报了一个悬空态的毛病，我来对自己这一侧 ——
 *   一对就对出了同一个形状，而且这边还多一个：同一个删除动作，
 *   在两端按会得到两种结果。没人看着的那条路，就是这样一直红着不出声的。
 */

const ICON: SplashChoice = { kind: 'icon' }
const SHIPPED: SplashChoice = { kind: 'shipped' }
/** ★ 名字必须是「64 位小写十六进制 + 扩展名」（sha256），不是随便一个文件名 */
const MINE: SplashChoice = { kind: 'user', name: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp' }
const OTHER: SplashChoice = { kind: 'user', name: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' }

describe('★ 两个选择是不是同一个', () => {
  it('★ 出厂那两档只看 kind', () => {
    assert.equal(sameChoice(ICON, ICON), true)
    assert.equal(sameChoice(SHIPPED, SHIPPED), true)
    assert.equal(sameChoice(ICON, SHIPPED), false)
  })

  it('★★ 自传图要**连名字一起**比 —— 只比 kind 的话两张图会互相认作自己', () => {
    assert.equal(sameChoice(MINE, MINE), true)
    assert.equal(sameChoice(MINE, OTHER), false)
    assert.equal(sameChoice(MINE, SHIPPED), false)
  })
})

describe('★★ 屏上该给哪一档画「使用中」', () => {
  const ALL = [ICON, SHIPPED, MINE]

  it('★ 他选的那张还在 —— 就是它，不动', () => {
    assert.deepEqual(shownChoice(MINE, ALL), MINE)
    assert.deepEqual(shownChoice(SHIPPED, ALL), SHIPPED)
    assert.deepEqual(shownChoice(ICON, ALL), ICON)
  })

  it('★★★ 他选的那张**不在了** → 退回出厂插画（屏上仍旧恰好一枚）', () => {
    /**
     * 这就是那个悬空态：他在这台机器上删了、或者在手机上删了而碑同步过来了。
     * 库里那一条**故意还记着** `user:<那个 64 位的名字>`（图加回来时选择要跟着回来），
     * 所以屏上不能照着库里那条找卡 —— 找不到，一枚都不亮，
     * 而这一页头上写着「候选可以有很多张，正在用的只有一张」。那句话会当场变成假的。
     */
    assert.deepEqual(shownChoice(MINE, [ICON, SHIPPED]), SHIPPED)
  })

  it('★★ 连出厂插画都读不出来 → 退到图标（图标不依赖任何文件，永远可用）', () => {
    assert.deepEqual(shownChoice(MINE, [ICON]), ICON)
    /** ★ 一张卡都没有也不许抛 —— 那一帧照样得画出来 */
    assert.deepEqual(shownChoice(MINE, []), ICON)
  })

  it('★★★ 退法必须和真正画出来的那一帧一致（main/splash.ts::splashArt）', () => {
    /**
     * `splashArt` 的回退链写着：他选的 → 出厂插画 → null（图标）。
     * 这里要一模一样。不一致的话，徽章会指着一张**开机时根本不会出现的图** ——
     * 那比一枚都不亮更坏：一枚都不亮他知道有问题，指错他不知道。
     */
    assert.deepEqual(shownChoice(MINE, [ICON, SHIPPED]), SHIPPED, '第一层退到出厂')
    assert.deepEqual(shownChoice(MINE, [ICON]), ICON, '第二层退到图标')
  })

  it('★ 选的是出厂那张、而出厂读不出来 → 也退到图标', () => {
    assert.deepEqual(shownChoice(SHIPPED, [ICON]), ICON)
  })
})

describe('★ 存进 settings 的那个字面', () => {
  it('★★ 三种形状来回一趟都不变形', () => {
    for (const c of [ICON, SHIPPED, MINE]) {
      assert.deepEqual(decodeSplashChoice(encodeSplashChoice(c)), c, JSON.stringify(c))
    }
  })

  it('★★ 认不出来给 null（当没设过），什么垃圾都不抛', () => {
    for (const bad of ['', '   ', 'nope', 'user:', 'user:../x', 42, null, undefined, {}]) {
      assert.doesNotThrow(() => decodeSplashChoice(bad))
      assert.equal(decodeSplashChoice(bad), null, String(bad))
    }
  })
})
