/**
 * E · **手机改词条**（T-5.14 · D-R23 已裁「可以」）
 *
 * 钉的是四件会静默坏掉的事：
 *   ① uid 不变（换了 = 对面看见「删一条、来一条新的」，学习史与归属全断）
 *   ② 出处摘句跟着改（不跟改 = 详情页把词条从摘句里划出来那一下再也划不中，M-012）
 *   ③ 留痕带 `field`（不带 = 改一次中文释义就把整份解析报成「写的是改之前的词条」）
 *   ④ 没有改动就一个字都不许写（写了 = 凭空推一行上云，还让解析白白失效）
 *
 * 判据一行都不在 Android：`normalizeTerm` 与 `staleAfterEdit` 都是 core 的
 * （指针 `ff41358`），这里只验**这一侧的装配**。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { editItem, isAnalysisStale } from '../src/db/edit-item.ts'
import type { SyncNote } from '../src/db/analyse.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'
import type { Db } from '../src/db/types.ts'

after(cleanup)

/**
 * 假的「保存前那一趟同步」（T-5.15）—— 与 `analyse.test.ts::fakeSync` 同一形状。
 *
 * ★ 每条用例都注入它，**不是为了跳过那一步**，恰恰相反：默认那条在 node 里必然
 *   失败（I-163 之后是「这一端还没装同步口子」，之前是动态 import `db/sync.ts`
 *   拉不动 Capacitor 插件）—— 那样每条用例都在验「失败也不阻塞」，而**没有一条**
 *   在验「它真的跑了」。注入之后才分得清这两件事。
 * @param onCall 可以在「同步那一刻」做点什么（E-6 用它证明这一趟排在写库之前）
 */
function fakeSync(onCall?: (db: Db) => void | Promise<void>): {
  calls: number
  fn: (db: Db) => Promise<SyncNote>
} {
  const box = {
    calls: 0,
    fn: async (db: Db): Promise<SyncNote> => {
      box.calls += 1
      await onCall?.(db)
      return { ran: true, note: '同步完成' }
    }
  }
  return box
}

/** E-1～E-5 不关心那一趟同步，给一个总是成功的；真正验它的是 E-6 / E-7 */
const SYNC = { syncFirst: fakeSync().fn }

/**
 * 种子不带出处与解析块 —— 这两样是这一组的主角，各自摆上。
 *
 * ★ `occurrences.uid` 是**自然身份**（`occurrences-nat-l|<条目uid>|<讲次uid>`，
 *   见 v36 的 `trg_occurrences_uid`），所以同一条在同一讲里只能有一处 ——
 *   要两处就得挂在两个讲次上。这一条是撞出来的，记在这里省得下次再撞。
 */
function occurrence(f: Fixture, itemId: number, quote: string, lectureId = 1): void {
  const t = Date.now() - 60_000
  f.raw
    .prepare(
      `insert into occurrences (item_id, material_id, lecture_id, quote, created_at, updated_at)
       values (?, null, ?, ?, ?, ?)`
    )
    .run(itemId, lectureId, quote, t, t)
}

/** 再加一个讲次（只为让同一条挂得下第二处出处） */
function secondLecture(f: Fixture): void {
  const t = Date.now() - 60_000
  f.raw
    .prepare(
      `insert into lectures (id, unit_id, name, status, created_at, updated_at)
       values (2, 1, 'L2', 'review', ?, ?)`
    )
    .run(t, t)
}

/** ★ 解析块的 updated_at 要**明显早于**这次修改，否则「晚于所有块」判不出来 */
function analysis(f: Fixture, itemId: number, block: string, content: string): void {
  const t = Date.now() - 60_000
  f.raw
    .prepare(
      `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
       values (?, ?, ?, ?, ?)`
    )
    .run(itemId, block, content, t, t)
}

const rowOf = (f: Fixture, id: number): Record<string, unknown> =>
  f.raw.prepare(`select * from items where id = ?`).get(id) as Record<string, unknown>

const quotesOf = (f: Fixture, id: number): string[] =>
  (f.raw.prepare(`select quote from occurrences where item_id = ? order by id`).all(id) as {
    quote: string
  }[]).map((r) => r.quote)

const correctionsOf = (f: Fixture, id: number): Record<string, unknown>[] => {
  const r = f.raw
    .prepare(`select content from analysis_blocks where item_id = ? and block = 'corrections'`)
    .get(id) as { content: string } | undefined
  return r ? (JSON.parse(r.content) as Record<string, unknown>[]) : []
}

describe('E · 手机改词条（T-5.14）', () => {
  it('E-1 · 改 term：uid 不变 · 出处摘句跟着换 · 留痕一条 field=term', async () => {
    const f = builtDb()
    seed(f)
    secondLecture(f)
    occurrence(f, 1, 'I could not term-1 the whole thing.')
    occurrence(f, 1, '这一句里根本没有那个词。', 2)
    const uidBefore = String(rowOf(f, 1)['uid'])
    const otherBefore = rowOf(f, 2)

    const r = await editItem(f.db, 1, { term: 'term-one' }, SYNC)

    assert.deepEqual(r.changed, ['term'])
    assert.equal(r.term, 'term-one')
    assert.equal(r.quotesTouched, 1, '只有真的含旧词条的那一条出处该被算进来')

    const after = rowOf(f, 1)
    assert.equal(String(after['uid']), uidBefore, '★ uid 变了 —— 对面会看成「删一条、来一条新的」')
    assert.equal(String(after['term']), 'term-one')
    assert.equal(String(after['gloss']), 'g', '没让改的列不许动')
    assert.ok(Number(after['updated_at']) > Number(otherBefore['updated_at']) - 1, 'updated_at 要前进')
    assert.equal(
      Number(f.raw.prepare(`select count(*) as n from items`).get()!['n']),
      3,
      '★ 只能是 update —— 多出一行就是「新建了条目」'
    )
    assert.deepEqual(rowOf(f, 2), otherBefore, '别的条目一个字都不该动')

    assert.deepEqual(
      quotesOf(f, 1),
      ['I could not term-one the whole thing.', '这一句里根本没有那个词。'],
      'M-012 · 含旧串的换掉，不含的原样'
    )

    const log = correctionsOf(f, 1)
    assert.equal(log.length, 1)
    assert.equal(log[0]!['field'], 'term', '★ 没有 field，core 的失效判定就没法把改释义排除掉')
    assert.equal(log[0]!['was'], 'term-1')
    assert.equal(log[0]!['should'], 'term-one')
    assert.equal(log[0]!['why'], '手动修改')
    assert.equal(typeof log[0]!['at'], 'number')
  })

  it('E-2 · 改 gloss / gloss_zh：只有那一列变，出处一个字不动，留痕带对应 field', async () => {
    const f = builtDb()
    seed(f)
    occurrence(f, 1, 'I could not term-1 the whole thing.')
    const before = rowOf(f, 1)

    const r = await editItem(f.db, 1, { gloss: 'to fail at', glossZh: '搞不定' }, SYNC)

    assert.deepEqual(r.changed.sort(), ['gloss', 'gloss_zh'])
    assert.equal(r.quotesTouched, 0, '词条没改，出处不该被碰')
    const after = rowOf(f, 1)
    assert.equal(String(after['term']), String(before['term']), '词条没让改就不许动')
    assert.equal(String(after['gloss']), 'to fail at')
    assert.equal(String(after['gloss_zh']), '搞不定')
    assert.equal(String(after['uid']), String(before['uid']))
    assert.deepEqual(quotesOf(f, 1), ['I could not term-1 the whole thing.'])

    const log = correctionsOf(f, 1)
    assert.equal(log.length, 2, '两列各留一笔')
    assert.deepEqual(
      log.map((x) => x['field']).sort(),
      ['gloss', 'gloss_zh'],
      '留痕要说清改的是哪一列'
    )
    assert.equal(log.find((x) => x['field'] === 'gloss_zh')!['was'], '', '原来是空的就如实写空')
  })

  it('E-3 · 空 / 只空白 / 与原值相同 / 条目不在：抛人话，库里逐列零改动', async () => {
    const f = builtDb()
    seed(f)
    occurrence(f, 1, 'I could not term-1 the whole thing.')
    analysis(f, 1, 'meaning', '旧解析')
    const snap = {
      item: rowOf(f, 1),
      quotes: quotesOf(f, 1),
      blocks: f.raw.prepare(`select * from analysis_blocks where item_id = 1`).all()
    }

    await assert.rejects(() => editItem(f.db, 1, { term: '' }, SYNC), /知识点不能空着/)
    await assert.rejects(() => editItem(f.db, 1, { term: '   ' }, SYNC), /知识点不能空着/)
    await assert.rejects(() => editItem(f.db, 1, { term: 'term-1' }, SYNC), /没有改动/)
    await assert.rejects(
      () => editItem(f.db, 1, { term: '  term-1  ', gloss: 'g' }, SYNC),
      /没有改动/,
      '首尾空白不算改动 —— 归一之后一样就是一样'
    )
    await assert.rejects(() => editItem(f.db, 1, {}, SYNC), /没有改动/)
    await assert.rejects(() => editItem(f.db, 999, { term: 'x' }, SYNC), /不在了/)

    assert.deepEqual(rowOf(f, 1), snap.item, '★ 被拒之后 items 一列都不许变（含 updated_at）')
    assert.deepEqual(quotesOf(f, 1), snap.quotes, '出处也不许变')
    assert.deepEqual(
      f.raw.prepare(`select * from analysis_blocks where item_id = 1`).all(),
      snap.blocks,
      '连留痕都不该多出来一条'
    )
  })

  it('E-4 · 失效判定（判据在 core）：只改大小写/尾标点不算，改成别的词才算，改释义不算', async () => {
    // ① 归一之后相同（大小写 + 尾标点）→ 不失效
    const a = builtDb()
    seed(a)
    analysis(a, 1, 'meaning', '旧解析')
    const ra = await editItem(a.db, 1, { term: 'Term-1.' }, SYNC)
    assert.deepEqual(ra.changed, ['term'], '它确实是一次真的改动（正文变了）')
    assert.equal(ra.stale, false, '只改大小写 / 尾标点 —— 解析讲的还是同一个词')
    assert.equal(await isAnalysisStale(a.db, 1), false)

    // ② 改成别的词 → 失效
    const b = builtDb()
    seed(b)
    analysis(b, 1, 'meaning', '旧解析')
    const rb = await editItem(b.db, 1, { term: 'something else' }, SYNC)
    assert.equal(rb.stale, true, '词换了，而解析还在讲旧词 —— 该报失效')
    assert.equal(await isAnalysisStale(b.db, 1), true)

    // ③ 只改释义 → 不失效（★ 这条全靠留痕里的 field）
    const c = builtDb()
    seed(c)
    analysis(c, 1, 'meaning', '旧解析')
    const rc = await editItem(c.db, 1, { gloss: '改个释义' }, SYNC)
    assert.equal(rc.stale, false, '★ 改释义不该让整份解析失效 —— 靠 field 区分')

    // ④ 压根没有解析块 → 谈不上过时
    const d = builtDb()
    seed(d)
    const rd = await editItem(d.db, 1, { term: 'something else' }, SYNC)
    assert.equal(rd.stale, false, '没有解析，就没有「解析过时了」这回事')
  })

  it('E-5 · 改成同讲次里另一条的同一个说法：不拦，只把重复的那条指出来', async () => {
    const f = builtDb()
    seed(f) // term-1 / term-2 / term-3 都在讲次 1 里
    const r = await editItem(f.db, 1, { term: 'Term-2.' }, SYNC)
    assert.equal(r.term, 'Term-2.', '★ 不拦 —— 合并按归一分组，改完自然落新组（T-2.11）')
    assert.ok(r.duplicateOf, '撞上了却没报出来 —— UI 就提不了那一句')
    assert.equal(r.duplicateOf!.id, 2)
    assert.equal(r.duplicateOf!.term, 'term-2')

    const alone = await editItem(f.db, 3, { term: '独一份的说法' }, SYNC)
    assert.equal(alone.duplicateOf, null, '没撞上就不许瞎报')
  })

  /**
   * ══ T-5.15 · 保存之前先同步一趟 ════════════════════════════════
   *
   * 它防的不是「同步不及时」，是**在过时的正文上做修改**：`editItem` 读的那一版
   * 决定了「改了哪几列」「留痕里的 `was`」「出处里要换掉的旧串」。
   * 所以这一趟必须排在**读旧值之前** —— E-6 证的就是这个顺序，不只是「调了一次」。
   */
  it('E-6 · 保存前跑了一趟同步，而且它排在读旧值之前', async () => {
    const f = builtDb()
    seed(f)
    occurrence(f, 1, 'I could not term-1 the whole thing.')

    /**
     * ★ 这个假同步**在同步那一刻改库**，扮演「电脑刚改过这一条、这一趟把它拉下来了」。
     *   于是「顺序对不对」就有了一个**看得见的判据**：
     *   顺序对 → `was` 是同步带来的新值；顺序错（先读后同步）→ `was` 还是老值。
     */
    const sync = fakeSync((db) =>
      db.run(`update items set term = ?, updated_at = ? where id = 1`, [
        '电脑刚改成这样',
        Date.now()
      ])
    )

    const r = await editItem(f.db, 1, { term: 'term-one' }, { syncFirst: sync.fn })

    assert.equal(sync.calls, 1, '★ 保存前那一趟没跑 —— 这条红了就是那一步被拆掉了')
    assert.equal(r.sync.ran, true, '账要带回来')

    const log = correctionsOf(f, 1)
    assert.equal(log.length, 1)
    assert.equal(
      log[0]!['was'],
      '电脑刚改成这样',
      '★★ 留痕记的 `was` 是**同步之前**那一版 —— 说明这一趟排在读旧值后面，顺序反了'
    )
    assert.deepEqual(
      quotesOf(f, 1),
      ['I could not term-1 the whole thing.'],
      '出处替换用的旧串也来自同步后那一版：同步后的词条不在这句里，所以这句原样不动'
    )
    assert.equal(String(rowOf(f, 1)['term']), 'term-one')
  })

  it('E-7 · 那一趟失败 / 跳过：照样保存，结果把原因带回来', async () => {
    // ① 抛了 —— 不许把保存带崩
    const a = builtDb()
    seed(a)
    const boom = await editItem(
      a.db,
      1,
      { term: 'term-one' },
      {
        syncFirst: () => {
          throw new Error('没网')
        }
      }
    )
    assert.equal(String(rowOf(a, 1)['term']), 'term-one', '★ 同步没跑成就拒绝保存 = 最坏的选择')
    assert.equal(boom.sync.ran, false)
    assert.equal(boom.sync.why, 'error')
    assert.match(boom.sync.note, /没网/, '原因要说得出来，不能只说「失败了」')

    // ② 安静跳过（自动同步关着 / 还没配）—— 同样照常保存
    const b = builtDb()
    seed(b)
    const skip = await editItem(
      b.db,
      1,
      { gloss: '改个释义' },
      { syncFirst: () => Promise.resolve({ ran: false, note: '自动同步关着', why: 'auto-off' }) }
    )
    assert.equal(String(rowOf(b, 1)['gloss']), '改个释义')
    assert.equal(skip.sync.ran, false)
    assert.equal(skip.sync.why, 'auto-off', 'UI 那句「保存前没同步上（原因）」就靠它')
  })
})
