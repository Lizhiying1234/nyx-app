/**
 * 开发用种子数据 —— **不是产品功能。**
 *
 * ══ 为什么需要它 ══════════════════════════════════════════════
 *
 * 新装的手机在第一次同步之前**一条内容都没有**（内容在电脑上整理，
 * 靠 Sync 下来，而 Sync 是 UI 第 6 步）。前五步全在空库上做，
 * 界面对不对根本看不出来。所以先给一份假数据。
 *
 * ══ 三条自律 ★★ ═══════════════════════════════════════════════
 *
 * ① **只从「样式一览」里手动触发**，不在启动时自己跑 ——
 *    自动播种迟早会在真实数据上跑一次
 * ② 名字全部带 `[开发]` 前缀，一眼认得出不是真数据
 * ③ **不碰 uid**：uid 由触发器算（D-267 / D-280）。
 *    手写 uid 会和 Sync 的身份判据打架，那种错很难查。
 */
import type { Db } from '../../db/types.ts'

const P = '[开发] '

export async function seedDev(db: Db): Promise<string> {
  const t = Date.now()
  const has = await db.get(`select count(*) as n from projects where name like '${P}%'`)
  if (Number(has?.['n'] ?? 0) > 0) return '已经播过了 —— 先清掉再播'

  // 项目 → 单元 → 讲次 → 知识点，一条完整的链
  const plan: [string, string, [string, string[]][]][] = [
    [
      `${P}雅思写作`,
      '#6d5efc',
      [
        ['Unit 1 · 图表描述', ['L1 · 趋势动词', 'L2 · 比较结构']],
        ['Unit 2 · 议论文', ['L1 · 让步转折']]
      ]
    ],
    [`${P}学术阅读`, '#2f9e57', [['Unit 1 · 长难句', ['L1 · 后置定语']]]]
  ]

  const TERMS = [
    'surge', 'plummet', 'level off', 'fluctuate', 'peak at',
    'in contrast to', 'albeit', 'notwithstanding', 'by and large', 'a case in point'
  ]

  let pid = 0
  let uidx = 0
  let iid = 0

  for (const [pname, color, units] of plan) {
    pid++
    await db.run(
      `insert into projects (id, name, color, pinned, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
      [pid, pname, color, pid === 1 ? 1 : 0, t, t]
    )

    for (const [uname, lectures] of units) {
      uidx++
      await db.run(
        `insert into units (id, project_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)`,
        [uidx, pid, uname, t, t]
      )

      for (const [n, lname] of lectures.entries()) {
        const lid = uidx * 10 + n
        // 第一条讲次做成「已到期」，好看清到期条长什么样
        const due = n === 0 ? t - 86400000 : t + 3 * 86400000
        await db.run(
          `insert into lectures (id, unit_id, name, number, status, due_at, created_at, updated_at)
           values (?, ?, ?, ?, 'review', ?, ?, ?)`,
          [lid, uidx, lname, n + 1, due, t, t]
        )

        for (let k = 0; k < 3 + (n % 3); k++) {
          iid++
          const term = TERMS[iid % TERMS.length]!
          await db.run(
            `insert into items (id, term, gloss, layer, kind, source, created_at, updated_at)
             values (?, ?, ?, ?, 'chunk', 'self', ?, ?)`,
            [iid, term, `${term} 的中文释义`, iid % 3 === 0 ? 'A' : 'B', t, t]
          )
          await db.run(
            `insert into item_lectures (item_id, lecture_id, created_at, updated_at)
             values (?, ?, ?, ?)`,
            [iid, lid, t, t]
          )
        }
      }
    }
  }

  return `播了 ${pid} 个项目 · ${uidx} 个单元 · ${iid} 条知识点`
}

/** 只清开发数据，真实数据一条不碰 */
export async function clearDev(db: Db): Promise<string> {
  const ids = (await db.all(`select id from projects where name like '${P}%'`)).map((r) =>
    Number(r['id'])
  )
  if (ids.length === 0) return '没有开发数据'
  const list = ids.join(',')
  // 从叶子往回删 —— 外键还开着
  await db.exec(`delete from item_lectures where lecture_id in (
    select l.id from lectures l join units u on u.id = l.unit_id where u.project_id in (${list}))`)
  await db.exec(`delete from items where id not in (select item_id from item_lectures)`)
  await db.exec(`delete from reading_cards where item_id not in (select id from items)`)
  await db.exec(`delete from review_logs where item_id not in (select id from items)`)
  await db.exec(`delete from lectures where unit_id in (select id from units where project_id in (${list}))`)
  await db.exec(`delete from units where project_id in (${list})`)
  await db.exec(`delete from projects where id in (${list})`)
  return `清掉了 ${ids.length} 个开发项目`
}
