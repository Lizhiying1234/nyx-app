/**
 * Vault 列表与写动作对照（阶段 2 · V-1 ～ V-7）。
 *
 * 判据：`vault-lists.ts` / `manage.ts` / `ledger.ts` 与 Windows
 * `study.ts::libraryItems/deleteItems/bulkSilence/restoreItem`、
 * `db/ledger.ts` **逐字同源** —— 这里验的是最容易改坏的几条口径：
 *   ① 默认列表排掉静默（IS_SILENT 分层判据）② 全部筛选维度真实生效
 *   ③ 软删/静默/恢复三个写动作的**账本随行**（4.1 / R-3-e：撤销记一笔）
 *   ④ 恢复轮转清零建立期、认读卡立刻到期。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadHardList, loadLibraryItems, loadTrash } from '../src/db/vault-lists.ts'
import { bulkSilence, restoreItem, softDeleteItems, undoDeleteItems } from '../src/db/manage.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)

const ledgerRow = (f: Fixture, norm: string, verdict: string): Record<string, unknown> | undefined =>
  f.raw
    .prepare(`select * from term_ledger where norm = ? and verdict = ?`)
    .get(norm, verdict) as Record<string, unknown> | undefined

describe('V · Vault 列表与写动作', () => {
  it('V-1 · 默认列表排掉静默；含静默/只看静默两档口径', async () => {
    const f = builtDb()
    seed(f)
    // item2 手动静默（B/chunk → PRODUCTION_APPLIES → 看 production_state）
    await bulkSilence(f.db, [2], true)

    const def = await loadLibraryItems(f.db, {})
    assert.deepEqual(def.map((r) => r.id).sort(), [1, 3], '默认不含静默')

    const inc = await loadLibraryItems(f.db, { includeSilent: true })
    assert.equal(inc.length, 3, '含静默 = 全量')

    const sil = await loadLibraryItems(f.db, { scope: 'silent' })
    assert.deepEqual(sil.map((r) => r.id), [2], '只看静默')
    assert.equal(sil[0]!.productionState, 'silent')
  })

  /**
   * ★★ V-1b · **两条线不一致时会怎样**（2026-09-02 补 · 钉的是**现状**）
   *
   * ── 为什么非要有这一条 ──────────────────────────────────
   * V-1 用的是 `bulkSilence`，而它**两张表一起写**（D-135 明禁中间态）。
   * 两边永远一致，于是「把 `IS_SILENT` 写成只看 `rc.silent`」这种漂移
   * **在 V-1 下照样全绿** —— 实测过：故意改成 `(rc.silent = 1)`，153 条一条不红。
   * 这一条专门制造两条线不一致的局面，把 `IS_SILENT` 的分层语义钉住。
   *
   * ── 这个局面不是假想的 ★★ ────────────────────────────────
   * `gradeCard`（两端唯一的认读写入面，D-296/D-298）**只碰 `reading_cards`**：
   * 认读间隔超过 `silenceDays`（默认 180 天）就写 `rc.silent = 1`，
   * 而 `items.production_state` 一个字不动。于是一条练得好的 B 层知识点
   * 会自然走到「卡退役了、产出线还在跑」。
   *
   * ── 它修掉的那条缝（2026-09-02）★★ ────────────────────────
   * 在这之前，「全部」用的是 `production_state != 'silent' and rc.silent = 0`
   * （**任一线静默就藏**），而「只看静默」用的是分层的 `IS_SILENT`。
   * 两把尺子的后果：上面那条知识点**在「全部」里看不见，在「静默」里也不在** ——
   * 哪个列表都找不到它，只有勾「含静默」才捞得回来。
   * ★ D-158 说的是「静默条目列表里不显示」，而**什么叫静默**由
   *   `core/silence.ts::isItemSilent` 定义 —— 所以那一句是 D-158 的**错误翻译**，
   *   不是另一条产品规则。现在两端都改成 `not IS_SILENT(...)`，
   *   「全部」与「只看静默」恰好互补，一条知识点必在其一。
   * ★ Windows `study.ts::libraryItems` 同一处同一改法。
   */
  it('V-1b · 两条线不一致时按层判 —— 「全部」与「只看静默」必须互补', async () => {
    const f = builtDb()
    seed(f)
    // ① B 层 · 卡退役了但产出线还在跑（= gradeCard 超过 silenceDays 的自然结果）
    f.raw.prepare(`update reading_cards set silent = 1 where item_id = 3`).run()
    // ② A 层 · production_state 是 silent 但卡没静默（不跑产出线 → 那一列没有意义）
    f.raw.prepare(`update items set layer = 'A', production_state = 'silent' where id = 2`).run()

    // 分层判据：B 看产出线（new）· A 看卡（silent=0）→ 两条都不算静默 → 都该在「全部」里
    const def = await loadLibraryItems(f.db, {})
    assert.deepEqual(def.map((r) => r.id).sort(), [1, 2, 3], '两条线不一致的都不算静默')

    const sil = await loadLibraryItems(f.db, { scope: 'silent' })
    assert.equal(sil.length, 0, '「只看静默」按同一份判据 —— 一条都不该有')

    // ★★ 互补性：真静默一条之后，它必须从「全部」消失、同时出现在「只看静默」里
    await bulkSilence(f.db, [1], true)
    const def2 = await loadLibraryItems(f.db, {})
    const sil2 = await loadLibraryItems(f.db, { scope: 'silent' })
    assert.ok(!def2.some((r) => r.id === 1), '静默了就不在「全部」')
    assert.deepEqual(sil2.map((r) => r.id), [1], '而且它在「只看静默」里')
    assert.equal(
      def2.length + sil2.length,
      3,
      '两个列表互补 —— 每条知识点必在其一，不会哪儿都找不到'
    )
  })

  it('V-2 · 层 / 来源 / 重复收集，一个维度一个开关', async () => {
    const f = builtDb()
    seed(f)
    f.raw.prepare(`update items set layer = 'A' where id = 1`).run()
    f.raw.prepare(`update items set source = 'assist' where id = 3`).run()
    f.raw.prepare(`update items set recollected_count = 2 where id = 2`).run()

    assert.deepEqual((await loadLibraryItems(f.db, { layer: 'A' })).map((r) => r.id), [1])
    assert.deepEqual((await loadLibraryItems(f.db, { source: 'assist' })).map((r) => r.id), [3])
    const rep = await loadLibraryItems(f.db, { onlyRepeated: true })
    assert.deepEqual(rep.map((r) => r.id), [2])
    assert.equal(rep[0]!.recollected, 2)
  })

  it('V-3 · 排序：recent=created_at 倒序 · streak 高在前', async () => {
    const f = builtDb()
    seed(f)
    const t = Date.now()
    f.raw.prepare(`update items set created_at = ? where id = 2`).run(t + 99999)
    f.raw.prepare(`update items set streak = 7 where id = 3`).run()

    const recent = await loadLibraryItems(f.db, { sort: 'recent' })
    assert.equal(recent[0]!.id, 2)
    const streak = await loadLibraryItems(f.db, { sort: 'streak' })
    assert.equal(streak[0]!.id, 3)
  })

  it('V-4 · 软删 + 撤销：deleted_at 与账本一来一回（R-3-e 撤销是记一笔）', async () => {
    const f = builtDb()
    seed(f)
    const n = await softDeleteItems(f.db, [1, 2])
    assert.equal(n, 2)

    const gone = f.raw.prepare(`select deleted_at from items where id = 1`).get() as {
      deleted_at: number | null
    }
    assert.ok(gone.deleted_at !== null, '软删落了')
    assert.equal((await loadLibraryItems(f.db, {})).length, 1, '列表只剩 1 条')

    const led = ledgerRow(f, 'term-1', 'deleted')
    assert.ok(led, '账本有 deleted 判决')
    assert.equal(led!['revoked_at'], null)
    const op = f.raw.prepare(`select op, detail from ops_log where op = 'delete'`).get() as {
      op: string
      detail: string
    }
    assert.equal(JSON.parse(op.detail).n, 2, 'ops_log 记了件数')

    await undoDeleteItems(f.db, [1, 2])
    assert.equal((await loadLibraryItems(f.db, {})).length, 3, '撤销后回满')
    assert.ok(ledgerRow(f, 'term-1', 'deleted')!['revoked_at'] !== null, '账是撤销的，不是删的')

    // 再删一次 —— note() 的 upsert 要把 revoked_at 清回 null（判决重新生效）
    await softDeleteItems(f.db, [1])
    assert.equal(ledgerRow(f, 'term-1', 'deleted')!['revoked_at'], null)
  })

  it('V-5 · bulkSilence：两张表同事务 + state_events + silenced_by + 账本', async () => {
    const f = builtDb()
    seed(f)
    await bulkSilence(f.db, [1], true)

    const it1 = f.raw
      .prepare(`select production_state as s, silenced_by as by from items where id = 1`)
      .get() as { s: string; by: string | null }
    assert.equal(it1.s, 'silent')
    assert.equal(it1.by, 'self')
    const rc = f.raw.prepare(`select silent from reading_cards where item_id = 1`).get() as {
      silent: number
    }
    assert.equal(rc.silent, 1, '认读卡同步静默（D-296 两张表）')
    const ev = f.raw
      .prepare(`select from_state, to_state from state_events where item_id = 1 order by id`)
      .all() as { from_state: string; to_state: string }[]
    // ★ 真实语义：种子条目还没练过 → production_state 默认 'new'，事件是 new→silent
    assert.deepEqual(
      ev.map((e) => ({ ...e })),
      [{ from_state: 'new', to_state: 'silent' }],
      'D-043 记了一笔'
    )
    assert.equal(ledgerRow(f, 'term-1', 'silenced')!['revoked_at'], null)

    await bulkSilence(f.db, [1], false)
    const back = f.raw
      .prepare(`select production_state as s, silenced_by as by from items where id = 1`)
      .get() as { s: string; by: string | null }
    assert.equal(back.s, 'training')
    assert.equal(back.by, null)
    assert.equal(ev.length + 1, (f.raw.prepare(`select count(*) c from state_events where item_id = 1`).get() as { c: number }).c)
    assert.ok(ledgerRow(f, 'term-1', 'silenced')!['revoked_at'] !== null, '取消静默 = 撤销那笔账')
  })

  it('V-6 · restoreItem：清零建立期 · 认读卡立刻到期 · 账撤销', async () => {
    const f = builtDb()
    seed(f)
    f.raw.prepare(`update items set streak = 5, attempts_in_stage = 4 where id = 1`).run()
    await bulkSilence(f.db, [1], true)

    const before = Date.now()
    await restoreItem(f.db, 1)
    const it1 = f.raw
      .prepare(
        `select production_state as s, streak, attempts_in_stage as a, silenced_by as by from items where id = 1`
      )
      .get() as { s: string; streak: number; a: number; by: string | null }
    assert.equal(it1.s, 'training')
    assert.equal(it1.streak, 0, '建立期清零')
    assert.equal(it1.a, 0)
    assert.equal(it1.by, null)
    const rc = f.raw.prepare(`select silent, due_at from reading_cards where item_id = 1`).get() as {
      silent: number
      due_at: number
    }
    assert.equal(rc.silent, 0)
    assert.ok(rc.due_at >= before, '认读卡现在就到期（≠ bulkSilence(false)）')
    assert.ok(ledgerRow(f, 'term-1', 'silenced')!['revoked_at'] !== null)
  })

  it('V-7 · 攻坚清单与回收站四类口径', async () => {
    const f = builtDb()
    seed(f)
    f.raw
      .prepare(`update items set production_state = 'hard', attempts = 9, hard_entries = 3 where id = 2`)
      .run()
    const hard = await loadHardList(f.db)
    assert.deepEqual(hard.map((r) => r.id), [2])
    assert.equal(hard[0]!.hardEntries, 3)

    await softDeleteItems(f.db, [1])
    f.raw.prepare(`update lectures set deleted_at = ? where id = 1`).run(Date.now() + 5)
    const trash = await loadTrash(f.db)
    assert.deepEqual(
      trash.map((r) => r.kind).sort(),
      ['item', 'lecture'],
      '词条与容器都列'
    )
    assert.equal(trash[0]!.kind, 'lecture', '按删除时间倒序')
  })
})
