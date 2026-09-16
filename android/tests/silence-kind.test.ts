/**
 * ══ SK · 一个库值底下的两件相反的事（D-485 · 2026-09-15）★ ══════
 *
 * 「静默」查下来是**两件相反的事**共用一个 `production_state='silent'`：
 *   自动 —— 连续 N 次高档正确，这套机制的**终点**      → `silenced_by='earned'`
 *   手动 —— 他说「先不练了」，**可逆**                  → `self` / 容器名
 *
 * ★★★ **2026-09-15 晚（D-489）：这两种不再上屏了**，`silenceLabel()` 也从 core 删了。
 *   ☞ 但这一组用例**一条都没减**：区分仍然在（进度只算练成的那一半，D-485），
 *     只是不写到他眼前。**「不显示」和「不区分」是两件事** ——
 *     把这一组跟着删掉，才是真的把判据弄丢了。
 *   ★ 所以下面钉的从「标签是哪个词」改成**「`silenceKind` 判成哪一种」**：
 *     钉词是钉表现，钉 kind 才是钉判据。表现没了，判据还在。
 *
 * 判据在 core（`silenceKind`），本端只负责
 * **把 `silenced_by` 写对**。写不对的坏法是安静的：两件相反的事在库里长得一模一样，
 * 屏上只能二选一地瞎说 —— 而「说错」这件事没有任何闸看得见。
 *
 * ★ 自动那条路要跑 `submitAnswer`，那要一个 mock AI 服务（`practice.test.ts` 那套，
 *   本机端口，最近两个会话并跑时抖过几次）。所以自动那条用**源码形状**钉
 *   （SK-4），不把这一组挂在一个会抖的服务上。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ROTATION_WORDS,
  SILENCE_ACTIONS,
  SILENCE_FILTER_NAME,
  silenceKind
} from '../src/core-link.ts'
import { bulkSilence, restoreItem } from '../src/db/manage.ts'
import { setSilentNode } from '../src/db/manage-nodes.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

const byOf = async (f: Fixture, id: number): Promise<string | null> => {
  const r = await f.db.get(`select silenced_by as by from items where id = ?`, [id])
  return r?.['by'] == null ? null : String(r['by'])
}
const stateOf = async (f: Fixture, id: number): Promise<string> =>
  String((await f.db.get(`select production_state as s from items where id = ?`, [id]))?.['s'])

describe('SK · 已练成 / 收起来了（silenced_by）', () => {
  it('SK-1 · 他手动静默的 → shelved（不再有屏上标签，判据还在）', async () => {
    const f = builtDb()
    await seed(f, { items: 2 })
    await bulkSilence(f.db, [1], true)

    assert.equal(await stateOf(f, 1), 'silent')
    assert.equal(await byOf(f, 1), 'self', '★ 手动那条路没标 self')
    assert.equal(silenceKind(await byOf(f, 1)), 'shelved')
  })

  it('SK-2 · 放回去 → 记号清掉（不留着一个假的「收起来了」）', async () => {
    const f = builtDb()
    await seed(f, { items: 2 })
    await bulkSilence(f.db, [1], true)
    await restoreItem(f.db, 1)

    assert.notEqual(await stateOf(f, 1), 'silent')
    assert.equal(
      await byOf(f, 1),
      null,
      '★★ 放回去了却还留着 silenced_by —— 下次再静默时会显示成上一次那一种'
    )
  })

  it('SK-3 · 老数据没标 → unknown → 按「已练成」算，不猜', async () => {
    const f = builtDb()
    await seed(f, { items: 2 })
    // 搬家之前那些行：state 是 silent，silenced_by 空着
    await f.db.run(
      `update items set production_state = 'silent', silenced_by = null where id = ?`,
      [1]
    )
    assert.equal(
      silenceKind(await byOf(f, 1)),
      'unknown',
      '★ 老数据没标的要判成 unknown —— 不猜。进度那边把 unknown 当练成算，' +
        '是使用者裁的方向，不许在这一端改口'
    )
  })

  it('SK-4 · 自动那条路真的标了 earned（钉源码：它跑在 mock AI 后面）', () => {
    const src = readFileSync(new URL('../src/db/practice.ts', import.meta.url), 'utf8')
    const at = src.indexOf('async function saveProgress')
    assert.ok(at > 0, '★ saveProgress 改名了，这条闸得跟着改')
    /**
     * ★★ 先把注释剥掉再看 —— 2026-09-15 跑负向对照当场撞到：
     *   把 `'earned'` 从代码里拿掉，这条**照样绿**，因为 `saveProgress` 头上那段
     *   注释里写着 `silenced_by = 'earned'`，`includes` 把注释也数进去了。
     *   闸读源码就得读**会跑的那部分**，否则它盯的是自己写的说明。
     */
    const code = src
      .slice(at, src.indexOf(String.fromCharCode(10) + '}', at) + 2)
      .replace(/\/\*[^]*?\*\//g, ' ')
      .replace(/^[ 	]*\/\/.*$/gm, ' ')
    assert.ok(code.includes('silenced_by'), '★★ 判分那条路没写 silenced_by —— 练成的会被当成老数据')
    assert.ok(
      code.includes("'earned'"),
      '★★ 判分那条路没标 earned —— 两件相反的事在库里长得一模一样'
    )
  })

  it('SK-5 · 整讲收起来 → 带下去的那些也是 shelved', async () => {
    const f = builtDb()
    await seed(f, { items: 3 })
    await setSilentNode(f.db, 'lecture', 1, true)

    const rows = await f.db.all(
      `select silenced_by as by from items where production_state = 'silent' and deleted_at is null`
    )
    assert.ok(rows.length > 0, '★ 前提就不对：整讲收起来之后一条都没静默')
    for (const r of rows) {
      const by = r['by'] == null ? null : String(r['by'])
      assert.equal(
        silenceKind(by),
        'shelved',
        `★★ 被上一级带下去的被当成「已练成」了（silenced_by=${JSON.stringify(by)}）—— 他没练成，是被整讲收起来的`
      )
    }
  })

  it('SK-6 · 屏上那几个字全从 core 拿，本端不写第二份', () => {
    /**
     * ★★★ **2026-09-15 晚：这两行字面也到期了，照上一轮说的办。**
     *   上一轮摘掉档名那行字面时，这儿留了一句：「另外四行字面暂时留着 ——
     *   这一轮只点了档名，不顺手动无关的。**它们是同一个形状，哪天那几个词也改，
     *   照这里办。**」当天晚上 D-489 就把这两个动作改成了「静默 / 恢复」，
     *   这两行**当场红了 —— 红在别人改对了**，和上一轮一模一样。
     * ☞ 所以留着的那两行不是「还没轮到」，是**已经知道会坏、却等它坏**。
     *   下次再见到这种形状，别等。
     * ★ `ROTATION_WORDS` 那两行这一轮没动，仍留着 —— 同一句话，同一个到期条件。
     */
    /**
     * ★★★ 这里**故意没有** `assert.equal(SILENCE_FILTER_NAME, '…')`。
     *   它原来钉着字面「不再出题的」，2026-09-15 档名裁回「静默」时坏处当场现形：
     *   那是一条**「别人改对了才会红」**的闸 —— 它不拦错，它拦对。
     *   （同一天 B 在 Windows 侧栽在同形状的 `smoke:study` 上：`assert.match(t, /不再出题/)`
     *     正钉着旧名字，S-3 把名字改对之后它才红。已一并改成钉常量。）
     *   而且它自相矛盾：这条用例的标题写着「本端不写第二份」，**那行字面就是那第二份**。
     * ☞ 值归 core 管，Windows 的 `copy:term-def` 在定义那一行签字钉住；
     *   本端只钉**屏上真的在用这个常量**（下面 `wired` 那张表）。
     * ★ 另外四行字面暂时留着 —— 这一轮只点了档名这一处，**不顺手动无关的**。
     *   它们是同一个形状，哪天那几个词也改，照这里办。
     */
    assert.equal(ROTATION_WORDS.inPractice, '在练')
    assert.equal(ROTATION_WORDS.schedule, '排进练习')
    /**
     * ★★ 2026-09-15 补：`SILENCE_FILTER_NAME` / `ROTATION_WORDS` 也收进 core 了。
     *   这三处以前是本端自己写死的字面量 —— 两端各写一份，一端改了另一端
     *   **不会有任何东西报错**（和 `FACTORY_READING_RULE_TEXTS` 头上那段同一课）。
     */
    const wired: [string, string][] = [
      ['src/ui/views/VaultSilent.svelte', 'SILENCE_ACTIONS'],
      ['src/ui/lib/Menu.svelte', 'SILENCE_ACTIONS'],
      ['src/ui/views/Vault.svelte', 'SILENCE_FILTER_NAME'],
      // ★ 2026-09-15 S-5：档名回归之后这三处也从字面改成了拼常量
      ['src/db/start-learning.ts', 'SILENCE_FILTER_NAME'],
      ['src/ui/views/Practice.svelte', 'SILENCE_FILTER_NAME'],
      ['src/ui/views/VaultItems.svelte', 'SILENCE_FILTER_NAME'],
      ['src/db/start-learning.ts', 'ROTATION_WORDS'],
      ['src/ui/views/Lecture.svelte', 'ROTATION_WORDS']
    ]
    /**
     * ★★ 数**出现次数**，不是「有没有」—— 2026-09-15 跑负向对照当场撞到：
     *   把 Vault 那一档改回本端写死的字面量，这条**照样绿**，
     *   因为 `import { SILENCE_FILTER_NAME }` 那一行还在。
     *   「引进来了」和「真的用上了」是两件事，而未使用的 import 只是个 warning，
     *   `svelte-check --threshold error` 不拦。所以要求 ≥2 次：import 一次 + 至少用一次。
     */
    for (const [f, name] of wired) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      const n = src.split(name).length - 1
      assert.ok(
        n >= 2,
        `★ ${f} 里 ${name} 只出现 ${n} 次 —— 引进来了却没用上（多半是被改回字面量了）`
      )
    }
  })
})
