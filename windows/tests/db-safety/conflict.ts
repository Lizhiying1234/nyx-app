/**
 * R-4-F 一个冲突只能挡它自己 · D-438 自动裁决
 *
 * 原 tests/db-safety.ts 第 10221–10610 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { Study } from '../../src/main/study.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { lastSyncProblems } from '../../src/main/sync/problems.ts'
import { Browse } from '../../src/main/browse.ts'
import { checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, auditIds, cloudFiles, cloudReady, putChunk, configureSync, syncState, fPicks } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ R-4-F · 一个冲突只能挡它自己，不能劫持整条流水线
//
// 实测过的病：一包 100 行、3 行冲突 → 应用 0、推 0。
// 97 行进不来、8 行出不去，而且只要不裁决，之后每一次同步都停在同一处。
// 界面上还写着「没冲突的那些照常同步」—— 那句话是假的。
//
// D-201 原文要的是「不静默覆盖 + 问一句」，**没有一个字要求整次停止**。
// ══════════════════════════════════════════════════════════════

console.log('\nR-4-F · 冲突只挡自己\n')

/** 造 n 条 picks，返回它们的行 */

interface FScene {
  r: ReturnType<typeof openDatabase>
  sync: Sync
  bucket: string
  backups: string
  /** 冲突那几行的 uid */
  conflictUids: string[]
}

/**
 * 造「远端改了全部 N 行、本地也改了其中 k 行」的形状。
 * 本地另外再加 `extra` 条全新的行（它们和冲突毫无关系，必须能推出去）。
 */
async function fScene(bucket: string, n: number, k: number, extra = 5): Promise<FScene> {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const base = Date.now() - 1_000_000
  fPicks(r, n, base)

  const sync = new Sync(r.db, join(backups, 'audio'), backups)
  await sync.run() // 先同步一次，水位落到这些行之后

  const rows = r.db.prepare(`select * from picks order by id`).all() as Record<string, unknown>[]
  const now = Date.now()
  putChunk(
    bucket,
    'other-100.json',
    rows.map((row, i) => ({
      uid: String(row['uid']),
      table: 'picks',
      updatedAt: now + i,
      data: { ...row, content: `对面改的 ${i}`, updated_at: now + i }
    })) as unknown as Record<string, unknown>[]
  )

  // 本地也改前 k 条 → 那 k 条才是真冲突
  const conflictUids = rows.slice(0, k).map((row) => String(row['uid']))
  r.db
    .prepare(`update picks set content = '我改的', updated_at = ? where id <= ?`)
    .run(now + 500_000, k)

  // 再加几条和冲突无关的本地新行
  const ins = r.db.prepare(
    `insert into picks (scope, scope_id, content, created_at, updated_at) values ('lecture', 1, ?, ?, ?)`
  )
  r.db.transaction(() => {
    for (let i = 0; i < extra; i++) {
      ins.run(`本地新增 ${i}`, now + 600_000 + i, now + 600_000 + i)
    }
  })()

  return { r, sync, bucket, backups, conflictUids }
}

/** 云端**我方**包里累计推上去的行（不含对面塞的那一包） */
function pushedUids(bucket: string): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of cloudFiles) {
    if (!k.startsWith(`${bucket}/nyx/chunks/`) || k.includes('other-100')) continue
    try {
      for (const row of (JSON.parse(v) as { rows?: { uid: string }[] }).rows ?? []) out.add(row.uid)
    } catch {
      /* skip */
    }
  }
  return out
}

// ══════════════════════════════════════════════════════════════
// ★★★ D-438 · 自动裁决（**生产默认走的就是这一条**）
//
// 上面那一整组把 `sync.autoResolve` 关掉，验的是冲突裁决机制本身。
// 这一组把它开回来，验**他实际会经历的那条路**：
//   冲突当场按时间新的定掉 · 一次都不问他 · 被盖掉的那一版落进账本。
// 两条路都有覆盖，缺一条都会变成「默认行为没人看」。
// ══════════════════════════════════════════════════════════════

checkAsync('★★★ D-438 · 自动裁决开着：冲突当场定掉，一次都不问他', async () => {
  const s = await fScene('auto-1', 20, 3, 0)
  s.r.db.prepare(`update settings set value = '1' where key = 'sync.autoResolve'`).run()
  const out = await s.sync.run()

  assert(out.conflicted === 0, `★ 不许再有「等你决定」的行：${JSON.stringify(out)}`)
  assert(
    out.applied + out.skipped + out.failed + out.conflicted === out.received,
    `★ 四个桶对不上账：${JSON.stringify(out)}`
  )
  // 本地那三行是 now+500000 改的，比云端的 now+i 新 → 该留本地
  for (const uid of s.conflictUids) {
    const row = s.r.db.prepare(`select content from picks where uid = ?`).get(uid) as
      | { content: string }
      | undefined
    assert(row?.content === '我改的', `★ 本地那版更新，应该留本地：${uid} → ${row?.content}`)
  }
})

checkAsync('★★★ D-438 · 被盖掉的那一版必须落账（不打扰他 ≠ 悄悄弄丢）', async () => {
  const s = await fScene('auto-2', 20, 3, 0)
  s.r.db.prepare(`update settings set value = '1' where key = 'sync.autoResolve'`).run()
  await s.sync.run()

  const notes = s.r.db
    .prepare(`select target, title, detail from ops_log where op = 'sync-override'`)
    .all() as { target: string; title: string; detail: string }[]
  assert(notes.length === 3, `★★ 三行被自动定掉，账本上就该有三笔，实测 ${notes.length}`)
  for (const n of notes) {
    assert(n.target === 'picks', `落错表了：${n.target}`)
    const d = JSON.parse(n.detail) as { kept: string; keptAt: number; lostAt: number; lost: unknown }
    assert(d.kept === 'local', `留下的该是本地那版：${d.kept}`)
    assert(d.keptAt > d.lostAt, '★ 留下的那版时间戳必须更大 —— 这就是「按时间线定」的全部含义')
    assert(d.lost !== undefined, '★★ 被盖掉的那一行**整行**要在账里，不然他找不回来')
  }
})

checkAsync('★★★ D-438 · 云端那版更新时留云端；下一轮收敛，不重复落账', async () => {
  const s = await fScene('auto-3', 20, 2, 0)
  s.r.db.prepare(`update settings set value = '1' where key = 'sync.autoResolve'`).run()
  // 把本地那两行改回**更旧**的时间戳 → 这次该云端赢
  s.r.db.prepare(`update picks set updated_at = 1000 where id <= 2`).run()
  const first = await s.sync.run()
  assert(first.conflicted === 0, `★ 不该再有等他决定的行：${JSON.stringify(first)}`)
  for (const uid of s.conflictUids) {
    const row = s.r.db.prepare(`select content from picks where uid = ?`).get(uid) as
      | { content: string }
      | undefined
    assert(String(row?.content).startsWith('对面改的'), `★ 云端那版更新，应该取云端：${row?.content}`)
  }
  const n1 = (
    s.r.db.prepare(`select count(*) as n from ops_log where op='sync-override'`).get() as { n: number }
  ).n
  // 再跑一趟：已经定过的不该再被判成冲突，也不该再记一笔
  const second = await s.sync.run()
  assert(second.conflicted === 0, `★ 第二趟也不该再问：${JSON.stringify(second)}`)
  const n2 = (
    s.r.db.prepare(`select count(*) as n from ops_log where op='sync-override'`).get() as { n: number }
  ).n
  assert(n1 === n2, `★★ 收敛了就不该再记账：${n1} → ${n2}（否则账本会被同一件事刷屏）`)
})

checkAsync('★★ R-4-F · 100 行里 3 行冲突 → 97 行真的进库、8 行真的上云', async () => {
  const s = await fScene('f-97', 100, 3, 5)
  const out = await s.sync.run()

  assert(out.conflicted === 3, `★ 冲突数不对：${JSON.stringify(out)}`)
  assert(
    out.applied === 97,
    `★★ 没冲突的 97 行被那 3 行挟持了：${JSON.stringify(out)}`
  )
  assert(
    out.applied + out.skipped + out.failed + out.conflicted === out.received,
    `★ 四个桶对不上账：${JSON.stringify(out)}`
  )

  /**
   * ★ 判据必须直接查库和查云端 —— `applied` / `pushed` / `lastNote`
   * 都是**报出来的数**，拿它们当自己的尺子等于没验（R-4-E 的教训）。
   */
  const landed = (
    s.r.db.prepare(`select count(*) as n from picks where content like '对面改的%'`).get() as {
      n: number
    }
  ).n
  assert(landed === 97, `★★ 报了应用 97 条，库里只有 ${landed} 条`)

  // 冲突那 3 行**一个字都不许动**（D-201：不静默覆盖）
  const kept = (
    s.r.db.prepare(`select count(*) as n from picks where content = '我改的'`).get() as {
      n: number
    }
  ).n
  assert(kept === 3, `★★ 冲突那几行被静默覆盖了：还剩 ${kept} 条`)

  // 本地那 8 行（3 条冲突的新版本 + 5 条新增）必须真的推上云端
  const up = pushedUids(s.bucket)
  for (const uid of s.conflictUids) {
    assert(up.has(uid), `★★ 冲突行的本地版本没推上去 —— 对面永远看不到他改了什么：${uid}`)
  }
  const mine = s.r.db
    .prepare(`select uid from picks where content like '本地新增%'`)
    .all() as { uid: string }[]
  for (const m of mine) {
    assert(up.has(m.uid), `★★ 和冲突无关的本地新行被挡住了：${m.uid}`)
  }

  // 还有未裁决的冲突 → 这一包不许进 applied
  assert(
    !syncState(s.r.db).applied.includes('other-100.json'),
    '★★ 有未裁决的冲突，包却进了 applied'
  )
  s.r.db.close()
})

checkAsync('★★ R-4-F · 50 / 50 也一样：一半冲突不影响另一半', async () => {
  const s = await fScene('f-50', 100, 50, 0)
  const out = await s.sync.run()
  assert(out.conflicted === 50 && out.applied === 50, `★ ${JSON.stringify(out)}`)
  assert(
    out.applied + out.skipped + out.failed + out.conflicted === out.received,
    `★ 账不平：${JSON.stringify(out)}`
  )
  s.r.db.close()
})

checkAsync('★★ R-4-F · 冲突 + 墓碑 + 真失败 同批：各归各的桶，碑优先于冲突', async () => {
  await cloudReady
  const bucket = 'f-mix'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const t0 = Date.now() - 1_000_000
  fPicks(r, 1, t0)
  const sync = new Sync(r.db, join(backups, 'audio'), backups)
  await sync.run()

  const pick = r.db.prepare(`select * from picks`).get() as Record<string, unknown>
  const itemUid = (r.db.prepare(`select uid from items where id = 1`).get() as { uid: string }).uid
  new Study(r.db, join(process.cwd(), 'prompts'), () => 'B2').deleteItem(1)
  await new Browse(r.db).purgeMany([{ kind: 'item', id: 1 }])

  const now = Date.now()
  putChunk(bucket, 'other-100.json', [
    // ① 真冲突
    { uid: String(pick['uid']), table: 'picks', updatedAt: now,
      data: { ...pick, content: '对面改的', updated_at: now } },
    // ② 被墓碑挡的 —— **必须算 skipped，不许变成 conflicted**
    { uid: itemUid, table: 'items', updatedAt: now,
      data: {
        id: 1, term: '从坟里爬出来的', gloss: '', layer: 'B', source: 'self',
        production_state: 'new', streak: 0, attempts: 0, attempts_in_stage: 0, corrects: 0,
        hard_entries: 0, card_ease: 2.5, card_interval: 0, card_reps: 0, card_lapses: 0,
        card_silent: 0, recollected_count: 0, deleted_at: null,
        created_at: now, updated_at: now, uid: itemUid
      } },
    // ③ 真失败（外键指向不存在的）
    { uid: 'il-ghost-f', table: 'item_lectures', updatedAt: now,
      data: { item_id: 4242, lecture_id: 1, is_owner: 0, created_at: now, updated_at: now,
              uid: 'il-ghost-f' } }
  ] as unknown as Record<string, unknown>[])
  r.db.prepare(`update picks set content = '我改的', updated_at = ?`).run(now + 1000)

  const out = await sync.run()
  assert(out.received === 3, `前提：该收到 3 行 —— ${JSON.stringify(out)}`)
  assert(out.conflicted === 1, `★ 冲突该是 1：${JSON.stringify(out)}`)
  assert(
    out.skipped === 1,
    `★★ 被墓碑挡下的该算 skipped（删除事实优先于冲突），不许变成 conflicted：${JSON.stringify(out)}`
  )
  assert(out.failed === 1, `★ 真失败该是 1：${JSON.stringify(out)}`)
  assert(
    out.applied + out.skipped + out.failed + out.conflicted === out.received,
    `★ 账不平：${JSON.stringify(out)}`
  )
  assert(
    (r.db.prepare(`select count(*) as n from items where uid = ?`).get(itemUid) as { n: number })
      .n === 0,
    '★★ 被墓碑挡的行进来了'
  )
  r.db.close()
})

for (const choice of ['local', 'remote'] as const) {
  checkAsync(`★★ R-4-F · 裁决「用${choice === 'local' ? '本地' : '云端'}的」→ 收敛，下一轮不再问`, async () => {
    const s = await fScene(`f-res-${choice}`, 10, 3, 0)
    const first = await s.sync.run()
    assert(first.conflicted === 3, `前提：该有 3 条冲突 —— ${JSON.stringify(first)}`)

    const resolved = await s.sync.run(choice)
    assert(resolved.conflicted === 0, `★ 裁决之后不该还有冲突：${JSON.stringify(resolved)}`)
    assert(
      resolved.applied + resolved.skipped + resolved.failed + resolved.conflicted ===
        resolved.received,
      `★ 账不平：${JSON.stringify(resolved)}`
    )

    const want = choice === 'local' ? '我改的' : '对面改的'
    const got = (
      s.r.db.prepare(`select count(*) as n from picks where content like ?`).get(`${want}%`) as {
        n: number
      }
    ).n
    assert(got >= 3, `★ 裁决没落地：想要「${want}」的有 ${got} 条`)

    // 下一轮不许再问
    const again = await s.sync.run()
    assert(again.conflicted === 0, `★★ 同一个裁决又被问了一遍：${JSON.stringify(again)}`)
    // 幂等：再裁决一次也不该改变结果
    const third = await s.sync.run(choice)
    assert(third.conflicted === 0, '★ 重复裁决不幂等')
    const still = (
      s.r.db.prepare(`select count(*) as n from picks where content like ?`).get(`${want}%`) as {
        n: number
      }
    ).n
    assert(still === got, `★ 重复裁决改变了结果：${got} → ${still}`)
    s.r.db.close()
  })
}

checkAsync('★★ R-4-F · 冲突要落进他点得开的地方；全部裁决完之后自己消失', async () => {
  /**
   * 开机自动同步撞上冲突时，以前他**完全看不到** ——
   * 只写进 `lastNote`，体检不亮、设置页不打开就没有任何提示，
   * 而这期间所有数据都不再同步。
   */
  const s = await fScene('f-prob', 10, 3, 0)
  await s.sync.run()

  const ids = auditIds(s.r.db)
  assert(
    ids.includes('sync-incomplete'),
    `★★ 有 3 条冲突等着，体检里却一句话都没有：${ids.join('、')}`
  )
  const probs = lastSyncProblems(s.r.db)
  assert((probs?.problems.length ?? 0) >= 3, `★ 冲突没进 sync.problems：${JSON.stringify(probs)}`)

  await s.sync.run('remote')

  assert(
    !auditIds(s.r.db).includes('sync-incomplete'),
    '★★ 全部裁决完了，红灯还挂着 —— 不许留下永久红灯'
  )
  assert(lastSyncProblems(s.r.db) === null, '★ sync.problems 没被清掉')
  s.r.db.close()
})

checkAsync('★★ R-4-F · 下一轮重读那一包：已经成功的行不重复写', async () => {
  const s = await fScene('f-idem', 10, 3, 0)
  await s.sync.run()
  const snapshot = s.r.db
    .prepare(`select uid, content, updated_at as u from picks order by id`)
    .all() as { uid: string; content: string; u: number }[]

  // 那一包没进 applied（还有未裁决冲突），所以下一轮会重读
  assert(
    !syncState(s.r.db).applied.includes('other-100.json'),
    '前提没成立：这一包本该留在外面'
  )
  const again = await s.sync.run()
  const after = s.r.db
    .prepare(`select uid, content, updated_at as u from picks order by id`)
    .all() as { uid: string; content: string; u: number }[]

  assert(
    JSON.stringify(after) === JSON.stringify(snapshot),
    '★★ 重读那一包把已经成功的行又写了一遍'
  )
  assert(again.applied === 0, `★ 重读时不该再有新落库：${JSON.stringify(again)}`)
  /**
   * ★★ 冲突必须**一直挂着直到他裁决**。
   *
   * 水位同时被「我推到哪了」和「这一行改过没有」两件事用着。
   * 冲突未决时要是让水位往前走，下一轮远端那一版就落到水位之下、
   * 不再算「改过」→ 判成 keep-local → **他从没做过的决定被替他做了**。
   * 那正是 D-201 要防的静默覆盖，而且比原来的 bug 更隐蔽。
   */
  assert(
    again.conflicted === 3,
    `★★ 待裁决的冲突自己蒸发了 —— 等于替他做了决定：${JSON.stringify(again)}`
  )
  const third = await s.sync.run()
  assert(third.conflicted === 3, `★★ 第三轮又少了：${JSON.stringify(third)}`)
  s.r.db.close()
})

