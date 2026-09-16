/**
 * R-4-F-a 裁决持久化：「用本地的」存得住、传得出去、导不回去
 *
 * 原 tests/db-safety.ts 第 11562–12289 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { MIGRATIONS, SYNC_TABLES } from '../../src/main/db/migrations.ts'
import { Exporter } from '../../src/main/export.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, cloudFiles, cloudReady, putChunk, configureSync, syncState, newSync, restoreCase, purgeItem1, fPicks } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ R-4-F-a · 「用本地的」这个决定要存得住、传得出去、导不回去
//
// R-4-F 之后冲突不再劫持整条流水线，但他按下的那个决定**只靠 `applied`
// 那张 500 个包名的缓存兜着**。缓存不是事实：溢出、新设备、导回旧备份 ——
// 三条路都会让被拒绝的那一版重新出现，而那时水位早已越过它，
// `decideRow` 落在最后那一格「取新的那个」→ 悄悄盖掉他留下的内容。
// ══════════════════════════════════════════════════════════════

console.log('\nR-4-F-a · 裁决持久化\n')

interface RScene {
  r: ReturnType<typeof openDatabase>
  backups: string
  bucket: string
  sync: Sync
  /** 那条 picks 的 uid */
  uid: string
  /** 本地留下的那一版的时间戳（**故意比云端那版旧** —— 他选本地正是因为云端刚改过） */
  localAt: number
  /** 云端那一版、也就是会被他拒绝的那一版 */
  remoteAt: number
  /** 装着被拒版本的那个包 */
  pack: string
  /** 库文件与它所在的目录 —— 导回那条用例要用 */
  p: string
  dir: string
}

/**
 * 造「两边都改过同一条」的形状。
 *
 * ★ 本地那版**故意更旧**：他按「用本地的」时，云端那版通常就是刚改的那个
 * （「云端是刚刚改的，本地是 5 分钟前改的，用哪边？」）。
 * D5 那条不变式要守的正是这种形状 —— 本地更新的时候什么都不做也是对的。
 */
async function rScene(bucket: string, packName = `other-${7_000_000}.json`): Promise<RScene> {
  await cloudReady
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  fPicks(r, 1, Date.now() - 1_000_000)
  const sync = newSync(r, backups)
  await sync.run() // 水位落到这一行之后

  const row = r.db.prepare(`select * from picks order by id limit 1`).get() as Record<
    string,
    unknown
  >
  const uid = String(row['uid'])
  const now = Date.now()
  const localAt = now + 100
  const remoteAt = now + 900
  r.db
    .prepare(`update picks set content = '我改的', updated_at = ? where id = ?`)
    .run(localAt, row['id'])
  putChunk(bucket, packName, [
    {
      uid,
      table: 'picks',
      updatedAt: remoteAt,
      data: { ...row, content: '对面改的', updated_at: remoteAt }
    }
  ])
  return { r, backups, bucket, sync, uid, localAt, remoteAt, pack: packName, p, dir }
}

const rContent = (db: Database.Database): string =>
  (db.prepare(`select content from picks limit 1`).get() as { content: string }).content

const rAt = (db: Database.Database): number =>
  Number((db.prepare(`select updated_at as t from picks limit 1`).get() as { t: number }).t)

const rRes = (
  db: Database.Database,
  target: string
): { uid: string; kind: string; rejectedUpTo: number } | undefined =>
  db
    .prepare(
      `select uid, kind, rejected_up_to as rejectedUpTo from resolutions where target_uid = ?`
    )
    .get(target) as { uid: string; kind: string; rejectedUpTo: number } | undefined

const rResCount = (db: Database.Database): number =>
  (db.prepare(`select count(*) as n from resolutions`).get() as { n: number }).n

/** 四个桶的恒等式 —— 每一趟都要成立（R-4-G-e / R-4-F） */
function rBalanced(out: Awaited<ReturnType<Sync['run']>>, where: string): void {
  assert(
    out.received === out.applied + out.skipped + out.failed + out.conflicted,
    `★ ${where} 四个桶对不上账：${JSON.stringify(out)}`
  )
}

// ── ① 裁决落库 ──────────────────────────────────────────────

checkAsync('★★ R-4-F-a · ① 冲突 → 选「用本地」→ 裁决真的落库，内容一个字没动', async () => {
  const s = await rScene('rf1')
  const before = s.r.db.prepare(`select * from picks limit 1`).get() as Record<string, unknown>

  const a = await s.sync.run()
  assert(a.conflicted === 1, `前提：该有 1 处冲突：${JSON.stringify(a)}`)
  rBalanced(a, '未裁决那一趟')
  assert(rResCount(s.r.db) === 0, '★ 他还没做决定，裁决就先写进去了')

  const b = await s.sync.run('local')
  rBalanced(b, '裁决那一趟')
  const res = rRes(s.r.db, s.uid)
  assert(res !== undefined, '★★ 他的决定没落库 —— 下次老包重放就会把它推翻')
  assert(
    res.rejectedUpTo === s.remoteAt,
    `★ 拒绝到哪一刻不对：${res.rejectedUpTo} / ${s.remoteAt}`
  )
  assert(res.uid === `resolutions-${s.uid}`, `★ 裁决行的身份不是算出来的：${res.uid}`)
  assert(res.kind === 'picks', `★ kind 不对：${res.kind}`)

  // 内容一个字不许动 —— 他按的是「用本地的」，不是「改这一行」
  const after = s.r.db.prepare(`select * from picks limit 1`).get() as Record<string, unknown>
  for (const k of Object.keys(before)) {
    if (k === 'updated_at') continue
    assert(
      String(after[k]) === String(before[k]),
      `★★ 裁决顺手改了 \`${k}\`：${String(before[k])} → ${String(after[k])}`
    )
  }
  s.r.db.close()
})

checkAsync('★★ R-4-F-a · ① D5 · 留下的那一版时间戳被顶到被拒版本之后', async () => {
  /**
   * 不顶的话，第三台机器上「留下的那一版」作为远端行到达时
   * `updatedAt <= rejected_up_to`，会被这条裁决**自己**挡掉 ——
   * 那台机器留着的是被拒绝的那一版。
   */
  const s = await rScene('rf1b')
  assert(s.localAt < s.remoteAt, '前提：本地那版本来更旧')
  await s.sync.run()
  await s.sync.run('local')
  assert(
    rAt(s.r.db) > s.remoteAt,
    `★★ 没顶：本地 ${rAt(s.r.db)} 仍然不晚于被拒的 ${s.remoteAt}`
  )
  assert(rContent(s.r.db) === '我改的', '内容变了')
  s.r.db.close()
})

// ── ② 选「用云端」不写裁决 ──────────────────────────────────

checkAsync('★★ R-4-F-a · ② 选「用云端」→ 不写裁决，而且**不需要**写', async () => {
  /**
   * 这条不对称是有意的，不是漏了：选云端之后本地那一行**就是**云端那一版，
   * 两边时间戳一模一样，老包再来一百次也只会被判成 `same`。
   * 下面第二段就是证明 —— 清空 `applied` 重放一次，什么都不会发生。
   */
  const s = await rScene('rf2')
  await s.sync.run()
  const b = await s.sync.run('remote')
  rBalanced(b, '裁决那一趟')
  assert(rResCount(s.r.db) === 0, '★ 选云端也写了裁决 —— 那是一条不需要存在的事实')
  assert(rContent(s.r.db) === '对面改的', `★ 没收下云端那版：${rContent(s.r.db)}`)

  // 证明「不需要」：老包重放，不会有任何变化
  s.r.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  const c = await s.sync.run()
  assert(c.received >= 1, '★ 那一包压根没被重读 —— 下面这句是假绿')
  assert(c.applied === 0 && c.conflicted === 0, `★ 重放动了东西：${JSON.stringify(c)}`)
  assert(rContent(s.r.db) === '对面改的', '★ 重放之后内容变了')
  s.r.db.close()
})

// ── ③ 同事务：一起成功，一起回滚 ────────────────────────────

/**
 * 让**第 n 次执行**某条语句炸掉（不是第一次就炸）。
 *
 * ★ 这个夹具是被逼出来的：第一版用 `dbThatFailsOn`（`prepare` 一撞就抛），
 * 结果两条用例都是**假绿** —— 语句在任何东西写下去之前就炸了，
 * 于是「什么都没留下」自然成立，**去掉事务照样绿**。
 * 要验的是「已经写了一半再炸」，所以必须让前面那几次真的执行过。
 */
function failOnNthRun(db: Database.Database, sqlPart: string, n: number): Database.Database {
  let hits = 0
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const st = target.prepare(sql)
          if (!sql.includes(sqlPart)) return st
          return new Proxy(st, {
            get(t2, p2, r2) {
              if (p2 === 'run') {
                return (...args: unknown[]) => {
                  hits += 1
                  if (hits === n) throw new Error(`注入的故障：第 ${n} 次 ${sqlPart}`)
                  return (t2 as unknown as { run: (...a: unknown[]) => unknown }).run(...args)
                }
              }
              const v = Reflect.get(t2, p2, r2)
              return typeof v === 'function' ? v.bind(t2) : v
            }
          })
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    }
  }) as Database.Database
}

/** 两条都冲突的形状 —— 「写了一半再炸」要有前一半 */
async function rScene2(bucket: string): Promise<{
  r: ReturnType<typeof openDatabase>
  backups: string
  sync: Sync
  ats: number[]
}> {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  fPicks(r, 2, Date.now() - 1_000_000)
  const sync = newSync(r, backups)
  await sync.run()

  const rows = r.db.prepare(`select * from picks order by id`).all() as Record<string, unknown>[]
  const now = Date.now()
  const up = r.db.prepare(`update picks set content = '我改的', updated_at = ? where id = ?`)
  rows.forEach((row, i) => up.run(now + 100 + i, row['id']))
  putChunk(
    bucket,
    'other-7600000.json',
    rows.map((row, i) => ({
      uid: String(row['uid']),
      table: 'picks',
      updatedAt: now + 900 + i,
      data: { ...row, content: '对面改的', updated_at: now + 900 + i }
    }))
  )
  const ats = (r.db.prepare(`select updated_at as t from picks order by id`).all() as {
    t: number
  }[]).map((x) => x.t)
  return { r, backups, sync, ats }
}

checkAsync('★★ R-4-F-a · ⑲ 裁决写到一半炸了 → 前面写成的那些也不许留下', async () => {
  const s = await rScene2('rf19')
  const first = await s.sync.run()
  assert(first.conflicted === 2, `前提：该有 2 处冲突：${JSON.stringify(first)}`)

  // 第 1 条的顶时间戳 + 写裁决都真的执行过，第 2 条的裁决炸掉
  const bad = new Sync(
    failOnNthRun(s.r.db, 'insert into resolutions', 2),
    join(s.backups, 'audio'),
    s.backups
  )
  let threw = false
  try {
    await bad.run('local')
  } catch {
    threw = true
  }
  assert(threw, '★ 注入的故障没冒出来')
  assert(
    rResCount(s.r.db) === 0,
    `★★ 半截状态：第 1 条的裁决留下了、第 2 条没有（现在有 ${rResCount(s.r.db)} 条）`
  )
  const now = (s.r.db.prepare(`select updated_at as t from picks order by id`).all() as {
    t: number
  }[]).map((x) => x.t)
  assert(
    JSON.stringify(now) === JSON.stringify(s.ats),
    `★★ 时间戳顶了、裁决没写 —— 下一次老包重放就会推翻他：${JSON.stringify(now)}`
  )
  s.r.db.close()
})

checkAsync('★★ R-4-F-a · ⑳ 顶时间戳写到一半炸了 → 裁决也不许单独留下', async () => {
  const s = await rScene2('rf20')
  const first = await s.sync.run()
  assert(first.conflicted === 2, `前提：该有 2 处冲突：${JSON.stringify(first)}`)

  const bad = new Sync(
    failOnNthRun(s.r.db, 'set updated_at = ? where uid', 2),
    join(s.backups, 'audio'),
    s.backups
  )
  let threw = false
  try {
    await bad.run('local')
  } catch {
    threw = true
  }
  assert(threw, '★ 注入的故障没冒出来')
  assert(
    rResCount(s.r.db) === 0,
    `★★ 业务那一半没做完，裁决却留下了 ${rResCount(s.r.db)} 条`
  )
  s.r.db.close()
})

// ── ④ 幂等 ──────────────────────────────────────────────────

checkAsync('★★ R-4-F-a · ④ 同一个 target 再裁决一次 → 还是一条，不倒退', async () => {
  const s = await rScene('rf4')
  await s.sync.run()
  await s.sync.run('local')
  const first = rRes(s.r.db, s.uid)!

  // 再来一趟（老包还在云端，applied 清掉让它重新参与）
  s.r.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  await s.sync.run('local')
  assert(rResCount(s.r.db) === 1, `★ 长出了第二条裁决：${rResCount(s.r.db)}`)
  const again = rRes(s.r.db, s.uid)!
  assert(
    again.rejectedUpTo >= first.rejectedUpTo,
    `★★ 他的决定被改小了：${first.rejectedUpTo} → ${again.rejectedUpTo}`
  )
  s.r.db.close()
})

checkAsync('★★ R-4-F-a · 单调：更早的裁决**推不动**它（数据库那条触发器）', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()
  const ins = r.db.prepare(
    `insert into resolutions (uid, target_uid, kind, rejected_up_to, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`
  )
  ins.run('resolutions-picks-x', 'picks-x', 'picks', 500, t, t)
  ins.run('resolutions-picks-x', 'picks-x', 'picks', 300, t, t) // 更早的
  assert(rRes(r.db, 'picks-x')!.rejectedUpTo === 500, '★★ 更早的裁决把他的决定改小了')
  ins.run('resolutions-picks-x', 'picks-x', 'picks', 900, t, t) // 更晚的
  assert(rRes(r.db, 'picks-x')!.rejectedUpTo === 900, '★ 更晚的裁决推不进去')
  assert(rResCount(r.db) === 1, '★ 长出了第二条')
  r.db.close()
})

// ── ⑤⑦ 老包重放 / 水位归零 ──────────────────────────────────

for (const [name, reset] of [
  ['⑤ applied 溢出（老包重下重放）', (db: Database.Database) => {
    db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  }],
  ['⑦ 水位归零（等于新设备从头拉）', (db: Database.Database) => {
    db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
    db.prepare(`update settings set value = '0' where key = 'sync.watermark'`).run()
  }]
] as [string, (db: Database.Database) => void][]) {
  checkAsync(`★★ R-4-F-a · ${name} → 不许推翻他的决定`, async () => {
    const s = await rScene(`rf5-${name.slice(0, 2)}`)
    await s.sync.run()
    await s.sync.run('local')
    assert(rContent(s.r.db) === '我改的', '前提：裁决之后该是本地那版')

    reset(s.r.db)
    const c = await s.sync.run()
    /**
     * ★ 这一句是防假绿的：包要是根本没被重读，下面「没被推翻」就什么都没验到。
     * R-4-F-a 的病正是「包被重读之后悄悄推翻」——不重读就碰不到它。
     */
    assert(c.received >= 1, `★ 那一包压根没被重读，这条用例什么都没验：${JSON.stringify(c)}`)
    rBalanced(c, '重放那一趟')
    assert(c.conflicted === 0, `★ 又问了他一遍同一个问题：${JSON.stringify(c)}`)
    assert(
      rContent(s.r.db) === '我改的',
      `★★ 他的决定被推翻了 —— 现在库里是「${rContent(s.r.db)}」`
    )
    s.r.db.close()
  })
}

// ── ⑩ 对面之后又改过 → 那是一次新的分歧 ─────────────────────

checkAsync('★★ R-4-F-a · ⑩ 对面在裁决之后又改了一次 → 重新问他', async () => {
  /**
   * `rejected_up_to` 不是「永久拒绝这个对象」。写成永久的话，
   * 对面之后每一次正常修改都会被无声吞掉，两台机器再也无法达成一致。
   */
  const s = await rScene('rf10')
  await s.sync.run()
  await s.sync.run('local')

  const row = s.r.db.prepare(`select * from picks limit 1`).get() as Record<string, unknown>
  const later = s.remoteAt + 10_000
  putChunk(s.bucket, `other-${7_100_000}.json`, [
    { uid: s.uid, table: 'picks', updatedAt: later, data: { ...row, content: '对面又改了', updated_at: later } }
  ])
  const c = await s.sync.run()
  rBalanced(c, '新分歧那一趟')
  assert(c.conflicted === 1, `★★ 对面的新改动被裁决无声吞掉了：${JSON.stringify(c)}`)
  assert(rContent(s.r.db) === '我改的', '★ 没裁决就动了库')
  s.r.db.close()
})

// ── ⑥/㉒㉑ 新设备：谁赢不取决于包的到达顺序 ─────────────────

/**
 * 另一台机器：同一个桶，**不同的设备号**（不然它会把对面的包当成自己的、直接跳过）。
 *
 * ★ 故意**不** `seedTree` —— 它要的就是「一台真正空的新机器」。
 *   播一遍的话两边各自长出 id 相同、uid 不同的项目 / 讲 / 知识点，
 *   同步过去全撞主键（那是 R-3-h，不是这一轮要验的东西）。
 */
function rSecond(bucket: string, device: string): { r: ReturnType<typeof openDatabase>; sync: Sync } {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  configureSync(r, bucket)
  r.db.prepare(`update settings set value = ? where key = 'sync.device'`).run(device)
  return { r, sync: newSync(r, backups) }
}

for (const [tag, packName] of [
  ['⑥/㉒ 留下的那版先到', `other-${7_200_000}.json`],
  ['㉑ 被拒的那版先到', `aaa-${7_200_000}.json`]
] as [string, string][]) {
  checkAsync(`★★ R-4-F-a · ${tag} → 第三台机器拿到的都是他留下的那一版`, async () => {
    /**
     * ★★ 这两条是 D5 的直接证明。
     *
     * 他留下的那一版**比被拒的那一版旧**（`rScene` 就是这么造的）。
     * 不顶时间戳的话：留下的那版 `updatedAt <= rejected_up_to` →
     * 被裁决自己挡掉 → 第三台机器留着**被拒绝的那一版**；
     * 而且谁赢取决于哪个包先到 —— 那不是他的决定，是推送时间。
     *
     * 包名决定读取顺序（`todo` 是排过序的）：`aaa-…` 排在 `me-…` 前面。
     */
    const bucket = `rf6-${packName.slice(0, 3)}`
    const s = await rScene(bucket, packName)
    await s.sync.run()
    await s.sync.run('local')
    assert(rContent(s.r.db) === '我改的', '前提：这台机器上是本地那版')

    const b = rSecond(bucket, 'me2')
    const out = await b.sync.run()
    rBalanced(out, '新设备那一趟')
    assert(out.failed === 0, `★ 新设备拉的时候有失败：${JSON.stringify(out)}`)
    assert(
      rContent(b.r.db) === '我改的',
      `★★ 第三台机器上是「${rContent(b.r.db)}」—— 他的决定没传过去`
    )
    // 裁决本身也要过去：新设备从此自己也挡得住
    const res = rRes(b.r.db, s.uid)
    assert(res !== undefined, '★★ 裁决没同步过去 —— 新设备下次重读老包还会被推翻')
    assert(res.rejectedUpTo === s.remoteAt, `★ 传过去的时刻不对：${res.rejectedUpTo}`)

    // 再重放一次老包：新设备也不许被推翻
    b.r.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
    const again = await b.sync.run()
    assert(again.received >= 1, '★ 老包没被重读，这一句是假绿')
    assert(rContent(b.r.db) === '我改的', '★★ 新设备重放时被推翻了')
    s.r.db.close()
    b.r.db.close()
  })
}

// ── ⑪ 删掉重建：新对象不受老决定影响 ────────────────────────

checkAsync('★★ R-4-F-a · ⑪ 另建一条新的（新 uid）→ 老裁决管不着它', async () => {
  const s = await rScene('rf11')
  await s.sync.run()
  await s.sync.run('local')

  // 一条**全新**的 picks，时间戳故意落在被拒的那个区间里
  const inside = s.remoteAt - 100
  putChunk(s.bucket, `other-${7_300_000}.json`, [
    {
      uid: 'picks-brand-new',
      table: 'picks',
      updatedAt: inside,
      data: {
        id: 90_001, scope: 'lecture', scope_id: 1, content: '新建的',
        created_at: inside, updated_at: inside, uid: 'picks-brand-new'
      }
    }
  ])
  const c = await s.sync.run()
  rBalanced(c, '新对象那一趟')
  const got = (
    s.r.db.prepare(`select count(*) as n from picks where uid = 'picks-brand-new'`).get() as {
      n: number
    }
  ).n
  assert(got === 1, `★★ 新对象被一条与它无关的老决定挡住了：${JSON.stringify(c)}`)
  s.r.db.close()
})

checkAsync('★★ R-4-F-a · 彻底删掉那个对象，裁决**留着**（和墓碑同一条纪律）', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const uid = (r.db.prepare(`select uid from items where id = 1`).get() as { uid: string }).uid
  const t = Date.now()
  r.db
    .prepare(
      `insert into resolutions (uid, target_uid, kind, rejected_up_to, created_at, updated_at)
       values (?, ?, 'items', ?, ?, ?)`
    )
    .run(`resolutions-${uid}`, uid, t, t, t)
  await purgeItem1(r)
  assert(rResCount(r.db) === 1, '★ 硬删把裁决顺手带走了 —— 那是「发生过什么」，不是「现在有什么」')
  r.db.close()
})

// ── 身份：两台机器对同一 target 落在同一个 uid ───────────────

checkAsync('★★ R-4-F-a · D1 · 两台机器各自裁决同一条 → 同一个 uid，只有一条', async () => {
  const bucket = 'rf-id'
  const s = await rScene(bucket, `other-${7_400_000}.json`)
  await s.sync.run()
  await s.sync.run('local')

  // 另一台机器：同一条 picks，同一份老包 → 它自己也裁一次
  const b = rSecond(bucket, 'me2')
  await b.sync.run() // 先把 picks 和裁决拉过来
  // 让它自己也产生一次冲突：本地改一版，云端再来一版更新的
  const row = b.r.db.prepare(`select * from picks limit 1`).get() as Record<string, unknown>
  const later = s.remoteAt + 5_000
  b.r.db.prepare(`update picks set content = 'B 改的', updated_at = ? where uid = ?`).run(later + 1, s.uid)
  putChunk(bucket, `other-${7_400_001}.json`, [
    { uid: s.uid, table: 'picks', updatedAt: later, data: { ...row, content: '第三方改的', updated_at: later } }
  ])
  const out = await b.sync.run('local')
  assert(out.failed === 0, `★★ 两台机器的裁决撞车了（多半是主键）：${JSON.stringify(out)}`)
  assert(rResCount(b.r.db) === 1, `★★ 同一条 target 长出了 ${rResCount(b.r.db)} 条裁决`)
  assert(
    rRes(b.r.db, s.uid)!.uid === `resolutions-${s.uid}`,
    '★ 两台机器的裁决身份不一致 —— 同步过去会变成两行'
  )

  // 传回第一台：不许失败，也不许倒退
  const back = await s.sync.run()
  assert(back.failed === 0, `★★ 裁决回传失败了：${JSON.stringify(back)}`)
  assert(rResCount(s.r.db) === 1, '★ 回传之后长出了第二条')
  assert(
    rRes(s.r.db, s.uid)!.rejectedUpTo === later,
    `★★ 两边合并没取到较晚的：${rRes(s.r.db, s.uid)!.rejectedUpTo} / ${later}`
  )
  s.r.db.close()
  b.r.db.close()
})

check('★★ R-4-F-a · D1 · resolutions **没有 id 列**（跨设备撞车的根）', () => {
  /**
   * 两台机器各自第一次裁决都会拿到 `id = 1`，uid 不同。
   * 同步过去时 `insert (id, uid, ...) on conflict(uid)` 撞在**主键**上，
   * 而 `on conflict(uid)` 是指定索引的，它不接管 → 那一行永远失败 →
   * 那一包永远不进 applied → 「没有完全成功」永久挂着。
   *
   * 这一条守的是将来：谁要是「顺手统一一下表结构」给它加回 id，这里当场红。
   */
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const cols = (r.db.prepare(`pragma table_info('resolutions')`).all() as { name: string }[]).map(
    (c) => c.name
  )
  assert(!cols.includes('id'), `★★ resolutions 又长出了 id 列：${cols.join(', ')}`)
  assert(cols.includes('uid'), '★ 身份列没了')
  for (const c of ['target_uid', 'kind', 'rejected_up_to', 'created_at', 'updated_at']) {
    assert(cols.includes(c), `★ 少了列 ${c}`)
  }
  r.db.close()
})

// ── 裁决自己同步失败 → 不进 applied，下次重试 ────────────────

checkAsync('★★ R-4-F-a · 裁决行自己写不进去 → 那一包不进 applied，下次重来', async () => {
  await cloudReady
  const bucket = 'rf-fail'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const t = Date.now()
  // target_uid 是 not null —— 这一行注定写不进去
  putChunk(bucket, 'other-7500000.json', [
    {
      uid: 'resolutions-broken',
      table: 'resolutions',
      updatedAt: t,
      data: {
        uid: 'resolutions-broken', target_uid: null, kind: 'picks',
        rejected_up_to: t, created_at: t, updated_at: t
      }
    }
  ])
  const out = await newSync(r, backups).run()
  rBalanced(out, '裁决写失败那一趟')
  assert(out.failed === 1, `★ 该算失败：${JSON.stringify(out)}`)
  assert(
    !syncState(r.db).applied.includes('other-7500000.json'),
    '★★ 没写成的裁决包进了 applied —— 下次不会再来，那条决定就永远丢了'
  )
  r.db.close()
})

// ── 裁决走的就是普通同步表那条路 ─────────────────────────────

checkAsync('★★ R-4-F-a · 裁决是**同步表**：水位归零重推时它也在包里', async () => {
  /**
   * ★ 「他按过的决定要跨设备生效」不能只靠「裁决那一趟顺手带上它」——
   * 那只覆盖了产生它的那一次。之后的每一次重推（导回之后水位取 min、
   * 换云端重新灌一遍）都得带着它，否则新设备只在特定时机才拿得到。
   *
   * 所以判据是**它在 `SYNC_TABLES` 里**，走的是和别的行完全一样的路。
   */
  assert(
    (SYNC_TABLES as readonly string[]).includes('resolutions'),
    '★★ 裁决不在同步表名单里 —— 另一台机器不知道他做过什么决定'
  )

  const s = await rScene('rf-tbl')
  await s.sync.run()
  await s.sync.run('local')

  // 水位归零 = 「把我这边的东西整个重推一遍」（导回之后就是这个形状）
  s.r.db.prepare(`update settings set value = '0' where key = 'sync.watermark'`).run()
  const mark = Object.keys(Object.fromEntries(cloudFiles)).length
  void mark
  await s.sync.run()

  let found = false
  for (const [k, v] of cloudFiles) {
    if (!k.startsWith(`${s.bucket}/nyx/chunks/me-`)) continue
    for (const row of (JSON.parse(v) as { rows?: { table: string }[] }).rows ?? []) {
      if (row.table === 'resolutions') found = true
    }
  }
  assert(found, '★★ 重推的时候裁决没跟着走 —— 它不是同步表，只有产生它那一趟才传得出去')
  s.r.db.close()
})

// ── ⑯⑰⑱ 导回：旧备份不许让他做过的决定倒退 ─────────────────

/** 直接写一条裁决（导回那几条的夹具用） */
function putRes(r: ReturnType<typeof openDatabase>, target: string, at: number): void {
  const t = Date.now()
  r.db
    .prepare(
      `insert into resolutions (uid, target_uid, kind, rejected_up_to, created_at, updated_at)
       values (?, ?, 'picks', ?, ?, ?)`
    )
    .run(`resolutions-${target}`, target, at, t, t)
}

checkAsync('★★ R-4-F-a · ⑯ 当前有裁决、备份里没有 → 裁决留着', async () => {
  const { final } = await restoreCase(
    () => {},
    (r) => putRes(r, 'picks-x', 900)
  )
  assert(
    final.resolutions.length === 1 && final.resolutions[0]!.at === 900,
    `★★ 导回一份旧备份把他的决定抹掉了：${JSON.stringify(final.resolutions)}`
  )
})

checkAsync('★★ R-4-F-a · ⑰ 备份里那条更晚 → 备份能把它推进', async () => {
  const { final } = await restoreCase(
    (r) => putRes(r, 'picks-x', 900),
    (r) => {
      // 当前库这条比备份旧（另一台机器上做的决定还没传过来的形状）
      r.db.prepare(`delete from resolutions`).run()
      putRes(r, 'picks-x', 300)
    }
  )
  assert(
    final.resolutions.length === 1 && final.resolutions[0]!.at === 900,
    `★★ 备份里更晚的裁决没被采纳：${JSON.stringify(final.resolutions)}`
  )
})

checkAsync('★★ R-4-F-a · ⑱ 两边都有、时刻不同 → 取较晚的那个', async () => {
  const { final } = await restoreCase(
    (r) => putRes(r, 'picks-x', 500),
    (r) => putRes(r, 'picks-x', 900) // 单调触发器会把它推到 900
  )
  assert(
    final.resolutions.length === 1 && final.resolutions[0]!.at === 900,
    `★★ 没取到较晚的：${JSON.stringify(final.resolutions)}`
  )
})

checkAsync('★★ R-4-F-a · ⑧ 导回「裁决之前」的备份，再真同步一次 → 仍然不翻案', async () => {
  /**
   * ★ 这一条走的是**真的 `restoreFrom()`**（验来源 → 安全备份 → 临时副本 →
   * 合并不可逆事实 → 原子替换），不是手工拼一个库。
   *
   * 导回之后业务数据回到了备份那一刻：那条 picks 的时间戳又落回被拒版本之前。
   * 这时候唯一还挡着它的就是裁决 —— 它要是跟着退回去，
   * 下一次同步云端那一版就正大光明地盖回来了。
   */
  const s = await rScene('rf8')
  await s.sync.run()
  const old = join(s.dir, `before-decision-${Date.now()}.db`)
  new Exporter(s.r.db).backupTo(old) // 裁决**之前**的样子

  await s.sync.run('local')
  assert(rResCount(s.r.db) === 1, '前提：裁决该落库了')

  await new Exporter(s.r.db).restoreFrom(old, s.p, s.backups, MIGRATIONS.length)
  s.r.db.close()

  const back = openDatabase(s.p, s.backups)
  assert(rResCount(back.db) === 1, '★★ 导回把他的决定抹掉了')
  assert(rContent(back.db) === '我改的', '前提：业务数据该回到备份那一刻')

  /**
   * 再真同步一次，并且**逼它把老包重读一遍**。
   *
   * `applied` 在导回时取的是并集（R-3-f：它是去重缓存，不是事实），
   * 所以那一包不会自己回来。清掉它不是造假 —— 那张名单只留最后 500 个，
   * 他同步得多一点就会溢出，这里只是把「几个月之后」提前到现在。
   */
  back.db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  const again = newSync(back, s.backups)
  const out = await again.run()
  assert(out.received >= 1, '★ 老包压根没被重读，这条用例什么都没验')
  rBalanced(out, '导回之后那一趟')
  assert(out.conflicted === 0, `★ 又问了他一遍：${JSON.stringify(out)}`)
  assert(
    rContent(back.db) === '我改的',
    `★★ 导回之后老包把他的决定盖掉了 —— 现在是「${rContent(back.db)}」`
  )
  back.db.close()
})


