/**
 * 回收站到期清除对照（PG-1~PG-3 · D-087「打开即清」）。
 * 判据：core/cascade.hardDelete（同步引擎同一份）；这里钉：
 *   ① 过期的真删（行没了）② 墓碑写了（清除会随同步走）
 *   ③ 没到期的一根手指都不动 ④ 级联把子行一起带走。
 * ★ F-015：时钟看着不对的时候**一行都不许删**（PG-2/PG-3）——
 *   闸的单元测试在 core（purge-guard.test.ts），这里钉的是它真的被接上了。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { purgeExpired, TRASH_DAYS } from '../src/db/purge.ts'
import { builtDb, cleanup, seed } from './helpers.ts'

after(cleanup)

describe('PG · 到期清除', () => {
  it('PG-1 · 过期硬删+墓碑；未到期不动；级联随行', async () => {
    const f = builtDb()
    seed(f)
    const old = Date.now() - (TRASH_DAYS + 1) * 86_400_000
    const fresh = Date.now() - 2 * 86_400_000
    // item1 过期；item2 未到期；lecture1 过期（其下 item3 活着 —— 级联只追已删行的子行）
    f.raw.prepare(`update items set deleted_at = ? where id = 1`).run(old)
    f.raw.prepare(`update items set deleted_at = ? where id = 2`).run(fresh)

    const r = await purgeExpired(f.db)
    assert.equal(r.skipped, null, '时钟正常 —— 不该被闸拦住')
    assert.ok(r.purged >= 1, `清了 ${r.purged} 行`)

    assert.equal(f.raw.prepare(`select count(*) c from items where id = 1`).get()!['c'], 0, '过期的行没了')
    assert.equal(f.raw.prepare(`select count(*) c from items where id = 2`).get()!['c'], 1, '未到期的不动')
    const tomb = f.raw
      .prepare(`select count(*) c from tombstones where kind = 'items'`)
      .get() as { c: number }
    assert.ok(tomb.c >= 1, '墓碑写了 —— 清除随同步走')
    // 级联：item1 的 reading_card / occurrences 一起没了
    assert.equal(
      f.raw.prepare(`select count(*) c from reading_cards where item_id = 1`).get()!['c'],
      0,
      '子行随行'
    )
  })

  it('PG-2 · 本机比远端见过的最新时刻晚太多 → 一行都不清，如实说一句', async () => {
    const f = builtDb()
    seed(f)
    const old = Date.now() - (TRASH_DAYS + 1) * 86_400_000
    f.raw.prepare(`update items set deleted_at = ? where id = 1`).run(old)
    // 引擎落盘的时钟参照：远端最新时刻在 30 天前 —— 本机比它超前 30 天
    f.raw
      .prepare(`insert into settings (key, value, updated_at) values ('sync.maxRemoteSeen', ?, ?)`)
      .run(String(Date.now() - 30 * 86_400_000), Date.now())

    const r = await purgeExpired(f.db)
    assert.equal(r.purged, 0, '拒绝就是一行都不删')
    /**
     * ★★ I-188（2026-09-15）· 这句话现在要**同时摆出两种成因**，一个都不判定。
     *
     * `now − maxRemoteSeen > 容差` 触发时真相有两种，而且从桶里分不开：
     *   ① 本机的钟被拨快了（危险的那一种，正是这条闸要挡的）
     *   ② **对端干脆好久没同步** —— 本机的钟一点问题都没有
     * 老文案只说了①（「看起来本机时钟不太对」），而且把方向说反了
     * （触发条件是本机**晚**于远端，句子却写「早了」）—— 他照着去调钟只会更偏。
     *
     * ★ 判据方向与 7 天容差**没动**（复核过：翻方向会放行「会多删」的那一边）。
     */
    assert.match(r.skipped ?? '', /没同步过/, '★★ 没说「对端久没同步」这一种成因')
    assert.match(r.skipped ?? '', /本机时间快了/, '★★ 没说「本机钟快了」这一种成因')
    assert.ok(
      !/时钟不太对/.test(r.skipped ?? ''),
      '★★ 又替他判定成「你的钟坏了」了 —— 判据分不开的两件事，文案也不许替它分'
    )
    assert.ok(
      !/早了/.test(r.skipped ?? ''),
      '★ 方向又说反了：触发条件是本机比远端**晚**'
    )
    assert.equal(
      f.raw.prepare(`select count(*) c from items where id = 1`).get()!['c'],
      1,
      '★ 该删的那一行还在 —— 拒绝不是「删一半」'
    )
    assert.equal(
      f.raw.prepare(`select count(*) c from tombstones where kind = 'items'`).get()!['c'],
      0,
      '★★ 没立碑 —— 立了碑就推出去了，那才是不可撤销的那一步'
    )
    const prob = f.raw
      .prepare(`select value from settings where key = 'sync.problems'`)
      .get() as { value?: string } | undefined
    assert.match(String(prob?.value ?? ''), /回收站清理/, '留痕进了他点得开的地方')
  })

  it('PG-3 · 从没同步过（没有时钟参照）→ 照常清，不能因为没证据就停功能', async () => {
    const f = builtDb()
    seed(f)
    f.raw
      .prepare(`update items set deleted_at = ? where id = 1`)
      .run(Date.now() - (TRASH_DAYS + 1) * 86_400_000)
    const r = await purgeExpired(f.db)
    assert.equal(r.skipped, null)
    assert.ok(r.purged >= 1)
  })

  /**
   * ══ ★★ PG-4 · 拦住是**暂时**的：对端同步一次就自己好了（I-188）════
   *
   * PG-2 钉的是「拦住时那句话怎么说」。这一条钉的是**拦住之后怎么解开** ——
   * 而这正是使用者会遇到的那一种：他电脑常常几周不开，`maxRemoteSeen` 就一直是旧的，
   * 于是手机上每次打开回收站都不清、都说一句。
   *
   * ★ 为什么值得单独钉：屏上那句话现在明说了「另一台设备已经约 N 天没同步过」——
   *   **那是一句承诺**（言下之意「去同步一下就好了」）。如果同步之后它照样拦，
   *   那句话就成了假话，而没有任何东西会红。
   * ★ 这一条同时是 PG-2 的「对照的对照」：证明那道闸**分得出**两种时刻参照，
   *   而不是无论如何都拦（无论如何都拦的话 PG-2 也会绿）。
   */
  it('★★ PG-4 · 对端同步一次 → 参照变新 → 当场就清得动了（那句话不是空头承诺）', async () => {
    const f = builtDb()
    seed(f)
    const expired = Date.now() - (TRASH_DAYS + 1) * 86_400_000
    f.raw.prepare(`update items set deleted_at = ? where id = 1`).run(expired)

    // ① 对端 30 天没同步过 —— 本机的钟没问题，但拿不准，所以拦
    const put = (v: number): void => {
      f.raw
        .prepare(
          `insert into settings (key, value, updated_at) values ('sync.maxRemoteSeen', ?, ?)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(String(v), Date.now())
    }
    put(Date.now() - 30 * 86_400_000)
    const blocked = await purgeExpired(f.db)
    assert.equal(blocked.purged, 0, '★ 前提就不对：这一趟本该被拦住')
    assert.ok(blocked.skipped, '★ 前提就不对：被拦住就该留下一句话')

    // ② 对端同步了一次 —— 参照变新
    put(Date.now())
    const after = await purgeExpired(f.db)
    assert.equal(
      after.skipped,
      null,
      '★★ 同步过了还在拦 —— 屏上那句「另一台设备约 N 天没同步过」就成了空头承诺'
    )
    assert.ok(after.purged >= 1, '★★ 解开之后要真的清得动，不是只把话收回去')
    assert.equal(
      f.raw.prepare(`select count(*) c from items where id = 1`).get()!['c'],
      0,
      '★ 那一行这次真的没了'
    )
  })
})
