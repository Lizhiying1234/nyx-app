/**
 * 朗读偏好与开关（TS-1 ～ TS-3）· D-466
 *
 * ★★ 这个文件在 D-466 之前守的是**缓存文件名**（sha1 与 `ttsKeyMaterial`）。
 *   缓存那一档随云端一起退了（缓存里的 mp3 只有一个来源：电脑用云端合成之后
 *   随同步落下来），所以那三条一起删。剩下的两件事都还在，而且都很怕漂：
 *     ① 偏好只剩口音与语速，默认值与夹取与 Windows `Tts.settings()` 同源
 *     ② 两把开关**落库来回** —— 只改内存的话，他关掉的东西下次开机又回来了
 *
 * ★ 顺序那一半在 `tests/voice-android.test.ts`（V-*）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadSwitches, setSwitch, ttsPrefs } from '../src/db/tts.ts'
import { prefSet } from '../src/db/prefs.ts'
import { builtDb, cleanup } from './helpers.ts'

after(cleanup)

describe('TS-1 · 偏好默认值与夹取（与 Windows Tts.settings 同源）', () => {
  it('空库默认 en-GB · 1', async () => {
    const f = builtDb()
    assert.deepEqual(await ttsPrefs(f.db), { accent: 'en-GB', rate: 1 })
  })

  it('写入后读回；语速夹在 0.7–1.3（D-040）', async () => {
    const f = builtDb()
    await prefSet(f.db, 'tts.accent', 'en-US')
    await prefSet(f.db, 'tts.rate', '2') // 手改过库的形状 —— 读侧再夹一次
    const p = await ttsPrefs(f.db)
    assert.equal(p.accent, 'en-US')
    assert.equal(p.rate, 1.3)
  })
})

describe('TS-2 · 两把开关落库来回', () => {
  it('没设过 = 两个都开（使用者定的默认，D-466）', async () => {
    const f = builtDb()
    assert.deepEqual(await loadSwitches(f.db), { dictionary: true, system: true })
  })

  it('★★ 关掉 → 读回来还是关着；再开 → 读回来是开着', async () => {
    /**
     * 这条守的是「设置页那两个开关**真的落库**」。
     * 只改内存的症状不会是报错，是**下次开机又回到开着** ——
     * 他会以为自己关过，而机器这边什么都没记住。
     */
    const f = builtDb()
    await setSwitch(f.db, 'system', false)
    assert.deepEqual(await loadSwitches(f.db), { dictionary: true, system: false })

    await setSwitch(f.db, 'dictionary', false)
    assert.deepEqual(await loadSwitches(f.db), { dictionary: false, system: false })

    await setSwitch(f.db, 'system', true)
    assert.deepEqual(await loadSwitches(f.db), { dictionary: false, system: true })
  })

  it('两把互不干扰（翻一把不许顺手动另一把）', async () => {
    const f = builtDb()
    await setSwitch(f.db, 'dictionary', false)
    await setSwitch(f.db, 'dictionary', true)
    assert.deepEqual(await loadSwitches(f.db), { dictionary: true, system: true })
  })
})

describe('TS-3 · 退役的那几把：写不进去了，库里那几行不动', () => {
  it('★ 退役键不许再写进 USER 偏好（D-216：只是不读，不删）', async () => {
    /**
     * `tts.cloud` 在 T-7.9 就退出了白名单；D-466 之后云端那一路整条退。
     * **退役 ≠ 删掉**：写 —— `prefSet` 从此拒绝；库里已有的那几行照旧留着，
     * Keystore 里存过的密钥也不删，只是没有任何代码再去读它们。
     */
    const f = builtDb()
    await assert.rejects(
      () => prefSet(f.db, 'tts.cloud', '1'),
      /不在偏好清单里/,
      '退役的键不许再写进 USER 偏好'
    )
  })
})
