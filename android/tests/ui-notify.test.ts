/**
 * 通知形态：**成功自己走，失败留着**（使用者 2026-09-14 第五条）
 *
 * 他的原话：「查找是否存在：操作完成 → 弹出提醒 → 必须点击"好"。如果属于普通的
 * 信息 / 成功反馈，也统一改为自动消失的 Toast / 非阻塞提示。……纯信息 / 成功反馈 →
 * 自动消失；需要用户决策或确认 → 才使用需要点击的弹窗。」
 *
 * 判据用房子自己那份（`docs/ui/NOTIFICATION_RULES.md` §二），**不另发明**：
 *   一次性、不跟控件绑着 → 回执条（4 秒自走） · 跟控件绑着 → Inline · 失败 → 不自动消失
 *
 * ── 为什么需要闸 ────────────────────────────────────────────
 * 这一类**坏了不会报**：把成功写进常驻的 `note`，屏上照常显示，只是它不走了；
 * 把失败写进 4 秒回执条，也照常显示，只是**他一眼没看见就永远错过了**。
 * 类型对、用例绿、界面能用 —— 唯一的症状是他的体验一点点变糟。
 *
 * ★ 两个方向都钉。只钉一头的话，下一个人「顺手统一成回执条」会把失败一起带走。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../src/ui/views/Settings.svelte', import.meta.url)
const BLOCK = /\/\*[\s\S]*?\*\//g
const LINE = /^\s*\/\/.*$/gm

/** ★ 剥注释再扫 —— 这份文件的说明里就写着「改好了」「没改成」这些词 */
const body = (): string => readFileSync(SRC, 'utf8').replace(BLOCK, '').replace(LINE, '')

/** 「刚做成了一件事」的说法 */
const SUCCESS = ['改好了', '建好了', '删掉了', '记住了', '回到默认了', '回到出厂配色了', '换成']
/** 「这一次没成」的说法 */
const FAIL = ['没改成', '没成', '读不了', '失败']

describe('UI-NOTIFY · 成功自己走，失败留着', () => {
  it('★ 一次性的成功不许写进常驻的 note', () => {
    // ★ `note` 画在整个 Settings 视图的**顶部**，不在产生它的控件旁边 ——
    //   既不就地、也不会自己走，两头不靠。一次性的成功该进 `snacks.show`。
    const bad: string[] = []
    for (const line of body().split(/\r?\n/)) {
      if (!/\bnote =/.test(line)) continue
      for (const w of SUCCESS) if (line.includes(w)) bad.push(line.trim().slice(0, 60))
    }
    assert.deepEqual(bad, [], `★ 这些成功反馈还留在常驻的 note 里，该进回执条：\n${bad.join('\n')}`)
  })

  it('★★ 失败不许写进 4 秒回执条（没看见就没了，对失败不可接受）', () => {
    const bad: string[] = []
    for (const line of body().split(/\r?\n/)) {
      if (!line.includes('snacks.show(')) continue
      for (const w of FAIL) if (line.includes(w)) bad.push(line.trim().slice(0, 60))
    }
    assert.deepEqual(bad, [], `★ 这些失败被塞进了会自己跑掉的回执条：\n${bad.join('\n')}`)
  })

  it('★ note 这一行还活着 —— 剩下的两类得有地方放', () => {
    // ★ 负向的另一半：别因为「统一成回执条」把 Inline 这一档整个删掉。
    //   跟 Assist 开关绑着的状态、以及失败，都还要它。
    const b = body()
    assert.ok(/\bnote =/.test(b), '★ Settings 里一条 note 都没有了 —— 失败和开关状态放哪？')
    assert.ok(b.includes('snacks.show('), '★ 回执条没人用了')
  })
})
