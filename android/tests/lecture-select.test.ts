/**
 * 讲次页「随时认读 · 全选 · 认读 / 练习选中的」（LS-1 ～ LS-6 · T-5.18 · D-R28）。
 *
 * D-R28 的原话：**排期是推荐，不是门禁** —— 到期只产出推荐，他想认读 / 练习永远允许，
 * 练了照常写事件、照常更新排期。这一组钉的就是「允许」这半边：
 *   ① 全选三态（按钮说的话不许和实际选中对不上）
 *   ② 选中 N 条 → 队列正好是那 N 条（**不看到期日** —— 换回 `dueCards` 一条都不给，
 *      这也是这一组的负向对照：LS-3 里两条断言并排放着）
 *   ③ 判分照写：review_logs 多 N 行、卡的 due_at 真的变了（练了就算数）
 *   ④ ids 那一场**只动卡不动讲次间隔**（与 Windows T-4.13 同一条）
 * ★ 队列 / 判分 / 结算的判据都在 db 层（`reading.ts` · `practice.ts`），
 *   这里不复制一行规则，只钉住「入口给的是 ids 时会发生什么」。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// ★ T-9.18 · 判据搬进 core（`core/selection.ts`，逐字自这一端的老文件）之后，
//   用例也对着 core 那一份跑 —— 对着本地副本跑等于验了一份已经不在生产路上的代码
import { selectAllState, toggleSelectAll } from '../src/core-link.ts'
import { dueCards, gradeCard, testCardsByIds } from '../src/db/reading.ts'
import { queueByIds, settleLectures } from '../src/db/practice.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

/** 这一讲的条目 id（seed 播的三条都挂在讲 1 上） */
const ALL = [1, 2, 3]

const count = (f: Fixture, sql: string, ...p: unknown[]): number =>
  Number((f.raw.prepare(sql).get(...(p as never[])) as { n: number }).n)

describe('LS · 讲次页选中即练', () => {
  it('LS-1 · 全选三态：不在多选 / 选了一部分 / 全都选上', () => {
    assert.equal(selectAllState(null, ALL), 'none', '不在多选态')
    assert.equal(selectAllState([], ALL), 'none', '空选 = 这一屏的退出态')
    assert.equal(selectAllState([2], ALL), 'some')
    assert.equal(selectAllState([3, 1, 2], ALL), 'all', '顺序不影响')
    assert.equal(selectAllState([1, 2, 3, 99], ALL), 'all', '选中里混进列表外的 id 也算全选')
    assert.equal(selectAllState([1, 2], ALL), 'some', '差一条就不是全选')
    assert.equal(selectAllState([1], []), 'none', '一条都没有 → 按钮不出现（D-431②）')
  })

  it('LS-2 · 按一下：没全选 → 全选那 N 条；已全选 → 退出多选', () => {
    assert.deepEqual(toggleSelectAll([2], ALL), [1, 2, 3], '按列表顺序全选')
    assert.equal(toggleSelectAll([1, 2, 3], ALL), null, '再按一次 = 取消全选 = 退出多选')
    assert.equal(toggleSelectAll(null, []), null)
  })

  it('LS-3 · 选中 N 条 → 认读队列正好那 N 条（不看到期日）', async () => {
    const f = builtDb()
    seed(f) // 三条卡的 due_at 都在将来 —— 今天一条都不到期

    // 负向对照就在这一行：换回讲次那条「到期卡」入口，这三条一条都不给
    assert.equal((await dueCards(f.db, 1, 40)).length, 0, 'dueCards：不到期 = 不给')

    const picked = [1, 3]
    const q = await testCardsByIds(f.db, picked)
    assert.deepEqual(
      q.map((c) => c.id).sort((a, b) => a - b),
      picked,
      '选中几条就是几条 —— 不多不少，不看排期'
    )
  })

  it('LS-4 · 选中 N 条 → 练习队列正好那 N 条', async () => {
    const f = builtDb()
    seed(f)
    const picked = [1, 2]
    const q = await queueByIds(f.db, picked)
    assert.deepEqual(
      q.map((i) => i.id).sort((a, b) => a - b),
      picked
    )
  })

  it('LS-5 · 判分照写：review_logs 多 N 行 · 每张卡的 due_at 都变了', async () => {
    const f = builtDb()
    seed(f)
    const picked = [1, 3]
    const before = count(f, `select count(*) as n from review_logs`)
    const dueBefore = picked.map((id) =>
      Number((f.raw.prepare(`select due_at as n from reading_cards where item_id = ?`).get(id) as { n: number }).n)
    )

    for (const id of picked) await gradeCard(f.db, id, 3, 1200)

    assert.equal(
      count(f, `select count(*) as n from review_logs`) - before,
      picked.length,
      '判几条写几行（D-017 自第一天起完整记录）'
    )
    picked.forEach((id, i) => {
      const now = Number(
        (f.raw.prepare(`select due_at as n from reading_cards where item_id = ?`).get(id) as { n: number }).n
      )
      assert.notEqual(now, dueBefore[i], `第 ${id} 条的 due_at 真的变了 —— 练了就算数`)
    })
  })

  it('LS-6 · ids 那一场只动卡，不动讲次间隔（与 Windows T-4.13 同一条）', async () => {
    const f = builtDb()
    seed(f)
    const t = Date.now()
    f.raw.prepare(`update lectures set interval_days = 7, due_at = ? where id = 1`).run(t + 999)
    for (const id of [1, 2]) {
      f.raw
        .prepare(
          `insert into answers (item_id, attempt_no, is_first, text, grade, created_at, updated_at)
           values (?, 1, 1, 'x', 4, ?, ?)`
        )
        .run(id, t, t)
    }

    // ① 按 ids 练的那一场：结算拿不到 lectureIds —— 讲次一个字不动
    const byIds = await settleLectures(f.db, [], null)
    assert.equal(byIds.perLecture.length, 0, 'ids 场没有讲次级结算')
    const lec = f.raw.prepare(`select interval_days as iv, due_at as due from lectures where id = 1`).get() as {
      iv: number
      due: number
    }
    assert.equal(lec.iv, 7, '讲次间隔没被这一场动过')
    assert.equal(lec.due, t + 999, '讲次的 due_at 也没动')
    assert.equal(count(f, `select count(*) as n from lecture_logs`), 0, '讲次级事件一行都没写')

    // ② 对照：按讲次练的那一场照旧结算 —— 上面那三条不是「结算坏了」
    const byLecture = await settleLectures(f.db, [1], null)
    assert.equal(byLecture.perLecture.length, 1, '讲次场仍然结算')
    assert.equal(count(f, `select count(*) as n from lecture_logs`), 1, '讲次场写 lecture_logs')
  })

  it('LS-7 · 讲次页给的是 ids 那条入口（换回 dueCards 就等于把不到期的挡在外面）', () => {
    const page = readFileSync(fileURLToPath(new URL('../src/ui/views/Lecture.svelte', import.meta.url)), 'utf8')

    // ① 「随时认读（全讲）」：走 ids —— 队列就是这一屏列着的这些条
    assert.ok(page.includes("{ kind: 'reading', ids: allIds }"), '随时认读走 ids，不是 lectureId')
    // ② 批量条选中的那 N 条：认读 / 练习都走 ids
    assert.ok(page.includes("onreadnow={() => (practice.open = { kind: 'reading', ids: [...(sel ?? [])] })}"),
      '「认读这 N 条」走 ids')
    assert.ok(page.includes("onprodnow={() => (practice.open = { kind: 'production', ids: [...(sel ?? [])] })}"),
      '「练习这 N 条」走 ids')
    // ③ 到期那一档仍在，但它现在明写「推荐」（D-R28：排期只产出推荐）
    assert.ok(page.includes('推荐&nbsp;· {due}'), '到期那一档标「推荐 · N」')
    assert.ok(page.includes("{ kind: 'reading', lectureId: id }"), '推荐那一档仍走到期卡（dueCards）')
    // ④ 全选用的是 lib 里那一份三态，不在页面里现编
    assert.ok(page.includes('toggleSelectAll(sel, allIds)'), '全选走 selection.ts')
    assert.ok(page.includes("selAll === 'all'"), '按钮按三态说话')
  })
})
