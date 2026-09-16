/**
 * R-4 同步失败的可恢复性与可见性 · R-4-G V20 出厂身份归一 · 落地验证 · R-4-G-e 四个数对得上账
 *
 * 原 tests/db-safety.ts 第 7036–8547 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { MIGRATIONS, TARGET_VERSION } from '../../src/main/db/migrations.ts'
import { BUILTIN_TABLES, isCanonicalUid } from '../../src/core/builtin-identity.ts'
import { Files } from '../../src/main/files.ts'
import { Sync } from '../../src/main/sync/index.ts'
import { qtypeUid } from '../../src/core/identity.ts'
import { lastSyncProblems } from '../../src/main/sync/problems.ts'
import { startupHeal } from '../../src/main/db/startup-heal.ts'
import { check, checkAsync, assert, freshDir } from './harness.ts'
import { seedTree, snapshotAll, auditIds, cloudFiles, cloudHook, cloudReady, putChunk, configureSync, syncState, packOf, newSync, r4Run } from './fixtures.ts'

// ══════════════════════════════════════════════════════════════
// ★★ R-4 · 同步失败不许悄悄变成永久分歧
//
// 一次同步里，「没成功」以前有三种表现形式，三种都是静默的：
//   · 单行写不进去 → 只有 console.error（打包后无处可看）
//   · 那一行所在的包照样进 applied → **永不重试**
//   · 界面报的「拉下来 N 行」是**尝试数** → 主动告诉他成功了
//
// 三件事叠起来就是这条协议里最贵的失败形态：
// 两台设备从此差一行，而没有任何人、任何检查、任何时刻会发现。
//
// 这一整块的判据只有两条：
//   > 没有成功应用的包，不能进 applied
//   > 报出来的成功数，就是真正落库的数
// ══════════════════════════════════════════════════════════════

console.log('\nR-4 · 同步失败的可恢复性与可见性\n')

/**
 * 造一个「云端」：一个**真的 WebDAV 服务器**，磁盘是一个 Map。
 *
 * 为什么不把 store 换成内存替身：那样就把 `makeStore` 那一层整个绕过去了，
 * 而这一块要验的恰恰是**一次完整的 run() 之后记账对不对** ——
 * 记账发生在拿到包之后，包是怎么拿到的必须是真的那条路。
 * 顺带也验了一遍 PROPFIND / MKCOL / PUT / GET 的解析。
 */
/**
 * ★★ Step 6C · 一个**只在 PUT 真的落地那一刻**触发的钩子。
 *
 * push race 必须是确定性的：他那一次编辑要恰好发生在
 * 「collect 已经取好快照」和「put 成功」之间。用 setTimeout 猜时机
 * 会变成一条时灵时不灵的用例 —— 那比没有用例更坏。
 */

/**
 * ★★ T-9.5 · 这个文件里的假服务器一律**不许服务端主动关空闲连接**（issues I-133）
 *
 * ── 病 ────────────────────────────────────────────────────
 *
 * 假云和它的客户端（`core/sync/store.ts` 的 `fetch`）**在同一个进程里**，
 * 而 `checkAsync` 的身体在声明点就开跑、在每个 `await` 处互相穿插 ——
 * 于是几十条用例并发打同一个假云，undici 的连接池里同时躺着一把空闲的 keep-alive 连接。
 *
 * Node 的 http 服务端默认 `keepAliveTimeout = 5000ms`：一条连接空闲 5 秒，**服务端把它关掉**。
 * 正常情况下不出事 —— 服务端会在响应头里带 `Keep-Alive: timeout=5`，
 * undici 据此把自己的空闲上限设成 4 秒，**总是抢在服务端之前先把连接从池子里撤掉**。
 * 那一秒的余量就是全部的安全边际。
 *
 * 机器被榨干的时候，这一秒不够用：两边的定时器都排在同一个被堵死的事件循环上，
 * undici 那一侧的空闲计时器（粒度 1 秒）晚了，服务端的 5 秒先到 —— 连接被服务端关掉，
 * 而池子里还留着它。下一个请求写上去，收到的是 RST：
 *
 *     TypeError: fetch failed
 *       ↳ cause: read ECONNRESET
 *
 * 2026-09-04 三个会话并行时撞到两次（R-4-C-a · R-4-F 各一次，重跑即绿）。
 * 复现出来之后一次 156 条全红，**156 条的 cause 全是 `ECONNRESET` / syscall=read**，一条不差。
 *
 * ── 药 ────────────────────────────────────────────────────
 *
 * `keepAliveTimeout = 0` = 服务端**永不**主动关空闲连接。
 * 剩下的只有 undici 自己按自己的节奏关 —— 客户端关自己池子里的连接不存在竞态，
 * 它是先撤出池子再关。方向对了，边际就不用再算。
 *
 * ★ 为什么不是「每条响应都带 `Connection: close`」：那样一条连接只用一次，
 *   `test:db` 一轮几万个请求就是几万条 TCP 连接。服务端先关 → 服务端侧堆 TIME_WAIT，
 *   客户端每次都得换一个临时端口，Windows 的临时端口只有一万六千多个。
 *   那是拿一个偶发换一个必现。
 * ★ 进程用 `app.exit()` 收尾（强制退出），连接不关不会让它挂住。
 */

/**
 * 往云端塞一个变更包 —— 名字里的时间戳就是包的时间（I-068 的墓碑靠它）。
 *
 * ★ 每条用例一个**独立的桶**（URL 里多一层）。
 * 第一版是共用一个桶、每条开工前清空 —— 而 `checkAsync` 的用例是**并发**跑的，
 * 于是它们互相把对方的包擦掉了，表现是「收到 0 行」，看着像同步坏了。
 * 红的是夹具，不是被验的东西。
 */
/**
 * ★★ Step 1A · 本机同步表面的身份。
 *
 * 所有测试库都是新建之后跑到同一版结构的，所以指纹只算一次就够。
 * 造包时必须带上它 —— **不带就成了 legacy 包**，那样这一整批用例
 * 验的就全是兼容路径，而新路径一条都没被跑到（那是一种最难发现的假绿）。
 */

/** 老版本推的包：没有版本头。Step 1A 的兼容路径靠它验 */

/** 原样塞一段文本进云端 —— 造坏包用 */

/** 同步的配置得先写进 settings，否则 run() 第一句就拒绝 */

/** 这台机器的记账位 */

/**
 * 造一包远端行：一条好的、一条**注定写不进去**的。
 *
 * 坏的那条用「外键指向一个不存在的讲」——这正是真实世界里最常见的那种失败
 * （对面先推了知识点、它挂的那一讲还在下一个包里）。
 */

/**
 * 一台机器：真 Sync + 真 WebDAV store。
 *
 * ★★ **这里把 D-438 的自动裁决关掉**（`sync.autoResolve = '0'`）。
 *   下面那三十多条用例验的是**冲突裁决机制本身**：检测得准不准、
 *   四个桶对不对、裁决落不落库、重放会不会翻案、第三台机器拿到哪一版。
 *   自动裁决开着时冲突当场就没了，这些不变式**一条都验不到** ——
 *   而它们是这套同步最贵的一部分，不能因为默认不再问他就变成没人看的代码。
 *   ★ 开着的那条路（自动定 + 落账 + 收敛）另有用例专门验，见「D-438 自动裁决」那组。
 */

// ══════════════════════════════════════════════════════════════
// ★★★ T-2.9 · 传输层撞上一次 RST，整趟同步不许因此失败
//
// I-133 量到的形状：服务端关掉空闲 keep-alive 连接，客户端写上去收到
// `ECONNRESET`，`fetch` 抛 `TypeError: fetch failed` —— 于是**整趟同步失败**。
// 修在传输层（`core/sync/retry.ts`：幂等请求重试一次）。
//
// 这两条验的是**接起来之后**的样子，不是判据本身（判据在 `core/sync/retry.test.ts`）：
// 一趟真的同步，中间掐一次连接，结果必须和没掐过一模一样 ——
// 尤其是**桶里的包数**，因为 `put` 也在重试范围里（同名同内容覆盖）。
// ══════════════════════════════════════════════════════════════

/**
 * 跑一趟一模一样的同步，回来告诉我「桶里几个包、失败几行、推了几行」。
 *
 * `rstMethod` 给了就在这个桶的**第一发那种请求**上掐一次连接。
 * ★★ 定向到**桶**，不用全局开关 —— 这个假云是整个 `test:db` 共用的，
 *   而 `checkAsync` 的身体在声明点就开跑、在每个 `await` 处互相穿插。
 *   第一版我写成了全局一次性开关，那一发 RST 被**别的用例**吃掉了：
 *   我这两条照样绿，红的是隔壁的 `R-4-F-a ④`。那是一次真正的假绿。
 */
async function t29Trip(
  bucket: string,
  rstMethod?: string
): Promise<{ chunks: number; failed: number; pushed: number; rstFired: boolean }> {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const sync = newSync(r, backups)
  try {
    if (rstMethod) cloudHook.rstAt.set(bucket, rstMethod)
    const out = await r4Run(sync)
    const chunks = [...cloudFiles.keys()].filter((k) =>
      k.startsWith(`${bucket}/nyx/chunks/`)
    ).length
    /**
     * ★★ **那一发到底打中了没有** —— 钩子是一次性的，打中了它自己就清空。
     *   没有这一句，「掐一次连接」这件事没发生时用例照样绿（它什么都没验到），
     *   而那正是这一条用例存在的意义。前提不成立要当场说出来。
     */
    const rstFired = rstMethod ? !cloudHook.rstAt.has(bucket) : false
    return { chunks, failed: out.failed, pushed: out.pushed, rstFired }
  } finally {
    // 没被吃掉的话自己收走，别留给下一条用例
    cloudHook.rstAt.delete(bucket)
    r.db.close()
  }
}

checkAsync('★★★ T-2.9 · 读请求（PROPFIND）撞一次 RST → 一趟同步照常成功，桶里包数不变', async () => {
  await cloudReady
  const plain = await t29Trip('t29a-plain')
  assert(plain.chunks > 0, `前提没成立：正常一趟该推出去包，实际 ${plain.chunks} 个`)

  const hit = await t29Trip('t29a-rst', 'PROPFIND')

  assert(hit.rstFired, '★★ 那一发 RST 压根没打中 —— 这一条什么都没验到')
  assert(hit.failed === 0, `★★★ 掐一次连接就整趟失败了（failed=${hit.failed}）—— 重试没接上`)
  assert(
    hit.chunks === plain.chunks,
    `★★★ 桶里包数对不上：掐过的那趟 ${hit.chunks} 个，正常那趟 ${plain.chunks} 个`
  )
  assert(hit.pushed === plain.pushed, `推的行数对不上：${hit.pushed} vs ${plain.pushed}`)
})

checkAsync('★★★ T-2.9 · **写请求（PUT）**撞一次 RST → 也照常成功，且**不重复推送**', async () => {
  await cloudReady
  const plain = await t29Trip('t29b-plain')

  /**
   * ★ 这一条要证的正是「写操作重试是安全的」：重发的是同名同内容
   *   （路径是调用方算好传进来的、正文是已经在手里的字节），
   *   所以桶里**不会多出第二个包**。桶里包数就是判据。
   */
  const hit = await t29Trip('t29b-rst', 'PUT')

  assert(hit.rstFired, '★★ 那一发 RST 压根没打中 —— 这一条什么都没验到')
  assert(hit.failed === 0, `★★★ PUT 撞一次 RST 就整趟失败了（failed=${hit.failed}）`)
  assert(
    hit.chunks === plain.chunks,
    `★★★ 重试把同一个包推成了两份：掐过的那趟 ${hit.chunks} 个，正常那趟 ${plain.chunks} 个`
  )
  assert(hit.pushed === plain.pushed, `推的行数对不上：${hit.pushed} vs ${plain.pushed}`)
})

checkAsync('★ R-4 · ① 全部成功 → 包进 applied，报的数就是落库数', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b1')
  const sync = newSync(r, backups)
  putChunk('b1', 'other-100.json', packOf(true, false))

  const out = await r4Run(sync)
  assert(out.applied === 1, `该落库 1 行，实际 ${out.applied}`)
  assert(out.failed === 0, `不该有失败，实际 ${out.failed}`)
  assert(out.received === 1, `收到的行数不对：${out.received}`)
  const st = syncState(r.db)
  assert(st.applied.includes('other-100.json'), '★ 成功的包没进 applied —— 每次都会重下一遍')
  const got = r.db.prepare(`select name from projects where uid = 'remote-project-1'`).get() as
    | { name: string }
    | undefined
  assert(got?.name === '对面的项目', '★ 报了成功，库里却没有')
  r.db.close()
})

checkAsync('★★ R-4-A · ② 一行失败 → 那个包**不许**进 applied', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b2')
  const sync = newSync(r, backups)
  putChunk('b2', 'other-100.json', packOf(true, true))

  const out = await r4Run(sync)
  assert(out.failed === 1, `该有 1 行失败，实际 ${out.failed}`)
  assert(out.applied === 1, `好的那行该落库，实际 ${out.applied}`)
  const st = syncState(r.db)
  assert(
    !st.applied.includes('other-100.json'),
    '★ 有行没写进去，这个包却进了 applied —— 它永远不会被重试，两台设备从此永久差一行'
  )
  r.db.close()
})

checkAsync('★★ R-4-A · ③ 同一个包重试：成功过的行不会被重写，也不会长出第二行', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b3')
  const sync = newSync(r, backups)
  putChunk('b3', 'other-100.json', packOf(true, true))

  await r4Run(sync)
  const after1 = r.db
    .prepare(`select count(*) as n, max(updated_at) as at from projects where uid = 'remote-project-1'`)
    .get() as { n: number; at: number }

  const out2 = await r4Run(sync)
  const after2 = r.db
    .prepare(`select count(*) as n, max(updated_at) as at from projects where uid = 'remote-project-1'`)
    .get() as { n: number; at: number }

  assert(after2.n === 1 && after1.n === 1, `★ 重试长出了第二行：${after1.n} → ${after2.n}`)
  assert(after2.at === after1.at, '★ 重试把已经成功的行又写了一遍')
  assert(
    out2.applied === 0,
    `★ 第二次不该再「应用」那条已经落库的行（它该被判成一样的）：${out2.applied}`
  )
  assert(out2.failed === 1, `坏的那条该继续失败并继续被数出来：${out2.failed}`)
  r.db.close()
})

checkAsync('★★ R-4-A · ④ 把失败原因修好 → 下一次同步它自己就进来了', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b4')
  const sync = newSync(r, backups)
  putChunk('b4', 'other-100.json', packOf(true, true))

  await r4Run(sync)
  assert(
    (r.db.prepare(`select count(*) as n from item_lectures where lecture_id = 999`).get() as { n: number })
      .n === 0,
    '前提没成立：那一行本来就该写不进去'
  )

  // 把它缺的那一讲补上（真实世界里就是「下一个包把它带来了」）
  const t = Date.now()
  r.db
    .prepare(
      `insert into lectures (id,unit_id,name,status,created_at,updated_at) values (999,1,'补上的','empty',?,?)`
    )
    .run(t, t)

  const out = await r4Run(sync)
  assert(out.failed === 0, `★ 原因修好了还在失败：${out.failed}`)
  assert(
    (r.db.prepare(`select count(*) as n from item_lectures where lecture_id = 999`).get() as { n: number })
      .n === 1,
    '★ 修好之后那一行仍然没进来 —— 重试机制是假的'
  )
  const st = syncState(r.db)
  assert(st.applied.includes('other-100.json'), '★ 这回全成了，包该进 applied 了')
  r.db.close()
})

checkAsync('★★ R-4-A · ⑤ 有失败时水位也不许乱走（推的那一侧不受连累）', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b5')
  const sync = newSync(r, backups)
  putChunk('b5', 'other-100.json', packOf(true, true))

  const before = syncState(r.db).wm
  await r4Run(sync)
  const after = syncState(r.db).wm
  assert(after > before, `水位该往前走（本地这批已经推上去了）：${before} → ${after}`)
  // 关键：**重试靠的是 applied，不是水位** —— 水位管的是推，applied 管的是拉
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★ 拉那一侧的重试凭据没留住'
  )
  r.db.close()
})

checkAsync('★★ R-4-E · ⑥ 报出来的数就是真的：applied / received / skipped / failed 各说各的', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b6')
  const sync = newSync(r, backups)
  putChunk('b6', 'other-100.json', packOf(true, true))
  await r4Run(sync)

  // 第二次：那条好的已经在库里了（判成一样 → skipped），坏的继续失败
  const out = await r4Run(sync)
  assert(out.received === 2, `收到 2 行：${out.received}`)
  assert(out.applied === 0, `一行都不该再落库：${out.applied}`)
  assert(out.skipped === 1, `该跳过 1 行：${out.skipped}`)
  assert(out.failed === 1, `该失败 1 行：${out.failed}`)
  assert(
    out.applied + out.skipped + out.failed === out.received,
    `★ 四个数对不上账：${JSON.stringify(out)}`
  )
  const st = syncState(r.db)
  assert(/失败 1 条/.test(st.note), `★ 他看到的那句话里没提失败：${st.note}`)
  r.db.close()
})

checkAsync('★★ R-4-D · 失败要落进他点得开的地方（数据体检 + 设置页）', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b7')
  const sync = newSync(r, backups)
  putChunk('b7', 'other-100.json', packOf(true, true))

  assert(!auditIds(r.db).includes('sync-incomplete'), '动手之前就有这条？')
  await r4Run(sync)

  assert(
    auditIds(r.db).includes('sync-incomplete'),
    `★ 同步没做完，数据体检却说一切正常：${auditIds(r.db).join('、')}`
  )
  const st = await sync.status()
  assert(st.problems.length === 1, `★ 设置页拿不到问题清单：${JSON.stringify(st.problems)}`)
  assert(st.problems[0]!.chunk === 'other-100.json', '★ 没说清是哪个包 —— 他和我都查不下去')

  // 修好之后这条要自己消失，否则就是一块永远亮着的红灯
  const t = Date.now()
  r.db
    .prepare(
      `insert into lectures (id,unit_id,name,status,created_at,updated_at) values (999,1,'补上的','empty',?,?)`
    )
    .run(t, t)
  await r4Run(sync)
  assert(
    !auditIds(r.db).includes('sync-incomplete'),
    '★ 已经好了，体检还在报 —— 报警器一直响就等于不响'
  )
  assert((await sync.status()).problems.length === 0, '★ 设置页那块红也该消失')
  r.db.close()
})

checkAsync('★★ R-4-D · 开机自动同步失败：不弹窗，但要留下痕迹', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const sync = new Sync(r.db, join(backups, 'audio'), backups)

  await sync.noteRunFailure('开机自动同步', new Error('连不上这个 WebDAV 目录：账号或密码不对（401）'))

  const st = await sync.status()
  assert(st.problems.length === 1 && st.problems[0]!.kind === 'run', `没记下来：${JSON.stringify(st.problems)}`)
  assert(
    /401/.test(st.problems[0]!.message),
    '★ 原始错误信息丢了 —— 他贴给 AI 的时候就没线索了'
  )
  assert(
    auditIds(r.db).includes('sync-incomplete'),
    `★ 开机同步失败在数据体检里看不见：${auditIds(r.db).join('、')}`
  )
  r.db.close()
})

/**
 * ★★ R-4-D-a · 上面那条只验了**记账机制**（直接调 `noteRunFailure`），
 * 没有验**接线** —— 而漏的正是接线：`noteRunFailure` 以前只挂在
 * `main/index.ts` 那条开机自动同步的 `.catch` 上，手动点「现在同步」
 * 失败时错误直接抛回渲染进程，**重开软件之后什么痕迹都没有**。
 *
 * 所以这一条走真的 `run()`，一行 `noteRunFailure` 都不自己调。
 * 反向验收：把 `run()` 里那个 try/catch 删掉，这条必须变红。
 */
checkAsync('★★ R-4-D-a · 手动同步失败也要留痕 —— 记账在 run() 里，不在调用方', async () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  const sync = new Sync(r.db, join(backups, 'audio'), backups)

  const threw = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      return false
    } catch {
      return true
    }
  }

  // ① 还没配同步 → 照样抛，但**不许记账**
  //    他根本没开始用这个功能，不该在数据体检里亮一条红。
  assert(await threw(() => sync.run(undefined, '手动同步')), '没配同步却没有拒绝')
  assert(
    lastSyncProblems(r.db) === null,
    '★「还没配同步」被当成故障记进了 sync.problems —— 那是没开始用，不是坏了'
  )

  // ② 配上，但指向一个没人听的端口 → 真的网络失败
  const t = Date.now()
  const set = r.db.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('sync.kind', 'webdav', t)
  set.run('sync.url', 'http://127.0.0.1:1/nobody-home', t)
  set.run('sync.user', 'u', t)
  set.run('sync.secret', 's', t)
  set.run('sync.device', 'me', t)

  assert(await threw(() => sync.run(undefined, '手动同步')), '连不上却没有抛')

  const st = await sync.status()
  assert(
    st.problems.length === 1 && st.problems[0]!.kind === 'run',
    `★ 手动同步失败没留痕 —— 重开之后就查不出原因了：${JSON.stringify(st.problems)}`
  )
  assert(
    st.problems[0]!.what === '手动同步',
    `★ 分不出是哪一次同步失败的：${JSON.stringify(st.problems[0])}`
  )
  assert(
    auditIds(r.db).includes('sync-incomplete'),
    `★ 手动同步失败在数据体检里看不见：${auditIds(r.db).join('、')}`
  )
  r.db.close()
})

checkAsync('★★ R-4-B · ⑦ 一次装不下：不许丢，水位停在真正推完的位置', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b8')

  /**
   * 造 5200 条 `ops_log` —— 它是同步表，而且没有外键，
   * 造得快、不牵连别的表。每条时间戳递增一毫秒，模拟真实写入。
   */
  const t0 = Date.now()
  const ins = r.db.prepare(
    `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
     values ('t','x',null,?,null,?,?)`
  )
  r.db.transaction(() => {
    for (let i = 0; i < 5200; i++) ins.run(`第 ${i} 条`, t0 + i, t0 + i)
  })()

  const sync = newSync(r, backups)
  const first = await r4Run(sync)
  assert(first.pushed >= 5000, `第一次该推 5000 行上下，实际 ${first.pushed}`)
  assert((first.leftOver ?? 0) > 0, `★ 没装下的那些被静默扔掉了：leftOver=${first.leftOver}`)
  const note1 = syncState(r.db).note
  assert(/还有 \d+ 行/.test(note1), `★ 他看不出还有东西没推上去：${note1}`)

  // 第二次必须把剩下的推完 —— 水位停在实推位置，它自己就是游标
  const second = await r4Run(sync)
  assert(second.pushed > 0, '★ 第二次一行都没推 —— 剩下的永远上不去了')
  assert((second.leftOver ?? 0) === 0, `第二次该收尾：leftOver=${second.leftOver}`)

  // 总账：推上去的行数不少于造出来的
  assert(
    first.pushed + second.pushed >= 5200,
    `★ 一共只推了 ${first.pushed + second.pushed} 行，造了 5200 行 —— 丢了`
  )
  r.db.close()
})

checkAsync('★★ R-4-B · 5000 行卡在同一毫秒也要有进展（不许原地打转）', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'b9')

  /**
   * 一次贴几千条时，`updated_at` 会有一大批**同一毫秒**。
   * 水位是 `> wm`，边界要是切在这堆中间：
   * 设成那个毫秒会跳过同伴，设成「减一」会永远原地打转。
   * 所以边界那一毫秒的行必须整组带上 —— 这条用例守的就是这一点。
   */
  const t0 = Date.now()
  const ins = r.db.prepare(
    `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
     values ('t','x',null,?,null,?,?)`
  )
  r.db.transaction(() => {
    for (let i = 0; i < 5100; i++) ins.run(`第 ${i} 条`, t0, t0) // 全同一毫秒
  })()

  const sync = newSync(r, backups)
  const first = await r4Run(sync)
  assert(first.pushed >= 5100, `★ 同一毫秒的那一组被切开了：只推了 ${first.pushed}`)
  const second = await r4Run(sync)
  assert(second.pushed === 0, `★ 水位没走过那一毫秒，第二次又推了 ${second.pushed} 行 —— 原地打转`)
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ R-4-G 第一阶段 · V20：出厂内容的跨设备身份归一
//
// 两台全新机器第一次同步，27 行里 22 行失败，全是
// `UNIQUE constraint failed: <表>.id` —— 出厂内容每台各自播种，
// 身份却每台各自随机。V20 把这四张表的 `builtin = 1` 行
// 换成由内容确定推导出来的 uid。
//
// 这一块验的是**它在真库上做了什么、又绝不做什么**。
// 判据只有两条：
//   > 归一之后，两台机器的出厂身份逐行相同
//   > 除了 uid 和 updated_at，一个字都没动
// ══════════════════════════════════════════════════════════════

console.log('\nR-4-G · V20 出厂身份归一\n')

/** 四张出厂表的身份快照 —— 两台机器要逐行相同 */
function builtinIds(db: Database.Database): string {
  const out: Record<string, unknown[]> = {}
  for (const t of BUILTIN_TABLES) {
    const cols = (db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map(
      (c) => c.name
    )
    if (cols.length === 0) continue
    const hasKey = cols.includes('key')
    out[t] = db
      .prepare(
        // ★ 末位排序用 `rowid` 不用 `id` —— V27 之后 genres/qtypes 没有 id 列了，
        //   而 `rowid` 每张表都有，两边的判据保持一致
        `select uid, builtin, sort${hasKey ? ', key' : ''} from "${t}"
          where builtin = 1 order by sort, rowid`
      )
      .all()
  }
  return JSON.stringify(out)
}

/** 除了 uid / updated_at 之外的一切 —— 用来证明「什么都没动」 */
function builtinBody(db: Database.Database): string {
  const out: Record<string, unknown[]> = {}
  for (const t of BUILTIN_TABLES) {
    const cols = (db.prepare(`pragma table_info("${t}")`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c !== 'uid' && c !== 'updated_at')
    if (cols.length === 0) continue
    out[t] = db
      .prepare(`select ${cols.map((c) => `"${c}"`).join(',')} from "${t}" order by id`)
      .all()
  }
  return JSON.stringify(out)
}

/** 把 V20 单独再跑一次 —— 幂等要验的就是它 */
function runV20(db: Database.Database): void {
  const m = MIGRATIONS.find((x) => x.version === 20)
  assert(m, '找不到 V20 —— 迁移编号被改动过')
  m.up(db)
}

check('★★ R-4-G · ① 两个全新库：出厂身份逐行相同', () => {
  const a = freshDir()
  const b = freshDir()
  const ra = openDatabase(a.db, a.backups)
  const rb = openDatabase(b.db, b.backups)

  const ia = builtinIds(ra.db)
  const ib = builtinIds(rb.db)
  assert(
    ia === ib,
    `★ 两台全新机器的出厂身份不一样 —— 一同步就撞主键：\n  A：${ia.slice(0, 300)}\n  B：${ib.slice(0, 300)}`
  )
  // 而且真的是 canonical 形状，不是「碰巧都随机成一样」
  const uids = (JSON.parse(ia) as Record<string, { uid: string }[]>)['qtypes'] ?? []
  assert(uids.length > 0, '前提没成立：全新库里应该有出厂题型')
  assert(
    uids.every((r) => isCanonicalUid(r.uid)),
    `★ 有出厂题型没拿到确定性身份：${uids.map((r) => r.uid).slice(0, 3).join('、')}`
  )
  ra.db.close()
  rb.db.close()
})

/**
 * 造一个「V19 时代的库」：出厂内容都在，但 uid 是**每台各自随机**的。
 *
 * 直接把已经归一好的 uid 打回随机 —— 这正是升级前那些库的真实形状。
 */
function legacyDb(seed: string): ReturnType<typeof openDatabase> {
  const { db: p, backups } = freshDir()
  /**
   * ★ 停在 **V19**。V20 是冻结的历史迁移，它按 `id` 定位 genres/qtypes ——
   *   那在 V19 那个年代是对的。以前这里开的是**最新**结构的库，
   *   V27 把这两张表的 `id` 去掉之后，V20 一跑就 `no such column: id`。
   *   那不是软件坏了，是夹具造的库不是 V20 该面对的那种库。
   *   造一个真正的 V19 库，V20 才验得到它真正要做的事。
   */
  const r = openDatabase(p, backups, MIGRATIONS.slice(0, 19))
  for (const t of BUILTIN_TABLES) {
    const cols = (r.db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map(
      (c) => c.name
    )
    if (cols.length === 0) continue
    /**
     * V19 时代的真实形状有两半，缺一不可：
     *   · uid 是**每台设备各自随机**的
     *   · `updated_at` 还是播种那一刻的值，也就是 `= created_at`（pristine）
     * 只打回 uid 而不打回时间戳的话，这些行会被当成「用户改过」，
     * 整块用例就验不到 pristine 那条路了。
     */
    r.db
      .prepare(
        // ★ V27 之后 genres/qtypes 没有 `id` 列了（uid 才是主键）——
        //   用 SQLite 的隐式 `rowid`，它在每张表上都有，效果一样
        `update "${t}" set uid = '${t}-${seed}-' || rowid, updated_at = created_at where builtin = 1`
      )
      .run()
  }
  return r
}

check('★★ R-4-G · ② 两个旧库（各自随机 uid）→ 各跑一次 V20 → 身份逐行相同', () => {
  const a = legacyDb('devAAAA')
  const b = legacyDb('devBBBB')
  assert(builtinIds(a.db) !== builtinIds(b.db), '前提没成立：旧库的身份本来就该不一样')

  runV20(a.db)
  runV20(b.db)

  assert(
    builtinIds(a.db) === builtinIds(b.db),
    `★ 归一之后两边还是对不上：\n  A：${builtinIds(a.db).slice(0, 300)}\n  B：${builtinIds(b.db).slice(0, 300)}`
  )
  a.db.close()
  b.db.close()
})

check('★★ R-4-G · pristine 的出厂内容归一到共同基准 0 —— 两台机器逐行相同', () => {
  /**
   * ★ 这条取代了原来那条「V20 必须把 updated_at 抬成 now」。
   *
   * 那条的因果是错的：他改一个出厂导师时，是**那次修改**写的 `now` 把变更推出去，
   * 跟 V20 写什么没关系。而 V20 抬 `now` 反而闯了祸 ——
   * A 抬成 A 的时刻、B 抬成 B 的时刻，uid 归一之后成了「同一行」，
   * 时间戳却不同且都 > 水位 0，**第一次同步就是 22 处冲突**，
   * 而那 22 条他一条都没碰过。
   *
   * 所以真正要验的是：**两台独立的全新机器，pristine 出厂内容的同步事实完全一样。**
   */
  const a = legacyDb('devAAAA')
  const b = legacyDb('devBBBB')
  runV20(a.db)
  runV20(b.db)

  for (const t of BUILTIN_TABLES) {
    const rowsA = a.db
      .prepare(`select uid, updated_at as u from "${t}" where builtin = 1 order by sort, id`)
      .all() as { uid: string; u: number }[]
    const rowsB = b.db
      .prepare(`select uid, updated_at as u from "${t}" where builtin = 1 order by sort, id`)
      .all() as { uid: string; u: number }[]
    assert(
      JSON.stringify(rowsA) === JSON.stringify(rowsB),
      `★ ${t} 两台机器的同步事实不一样 —— 第一次同步就会变成冲突：
  A：${JSON.stringify(rowsA).slice(0, 200)}
  B：${JSON.stringify(rowsB).slice(0, 200)}`
    )
    assert(
      rowsA.every((r) => r.u === 0),
      `★ ${t} 有 pristine 的出厂内容没归到基准 0：${JSON.stringify(rowsA).slice(0, 200)}`
    )
  }
  // 而且它们不该出现在「待推送」里 —— 没动过的东西不该假装自己变过
  const pending = BUILTIN_TABLES.reduce((n, t) => {
    const c = a.db.prepare(`select count(*) as n from "${t}" where updated_at > 0`).get() as {
      n: number
    }
    return n + c.n
  }, 0)
  assert(pending === 0, `★ 有 ${pending} 条没动过的出厂内容排在待推送里`)
  a.db.close()
  b.db.close()
})

check('★★ R-4-G · 被用户改过的出厂内容：保留它真实的修改时间，绝不抹成 0', () => {
  /**
   * 判据不是猜的：播种时 `created_at` 和 `updated_at` 写的是同一个值，
   * 而**全部 13 条用户修改入口都不动 `created_at`**（逐条追过调用链）。
   * 所以 `created_at === updated_at` ⟺ 这一行自入库起没被改过。
   *
   * 他真实库里就有一条这样的行：qtypes 第 7 行「错误订正」，
   * 修改发生在入库之后约 4 分 51 秒。抹掉它等于把他的修改从同步里吞掉。
   */
  const r = legacyDb('devAAAA')
  const mod = Date.now()
  r.db.prepare(`update qtypes set name = '我改过的', updated_at = ? where sort = 7`).run(mod)
  const untouched = r.db
    .prepare(`select created_at as c, updated_at as u from qtypes where sort = 6`)
    .get() as { c: number; u: number }
  assert(untouched.c === untouched.u, '前提没成立：第 6 行本该是 pristine')

  runV20(r.db)

  const row = r.db
    .prepare(`select uid, name, updated_at as u from qtypes where sort = 7`)
    .get() as { uid: string; name: string; u: number }
  assert(row.u === mod, `★ 真实的用户修改时间被抹掉了：${mod} → ${row.u}`)
  assert(row.name === '我改过的', '★ 内容被改回去了')
  assert(row.uid === qtypeUid('错误订正'), `★ 改过的那条没拿到身份（该是 ${qtypeUid('错误订正')}）：${row.uid}`)
  // 旁边那条没改过的照样归 0 —— 两件事互不干扰
  const six = r.db.prepare(`select updated_at as u from qtypes where sort = 6`).get() as { u: number }
  assert(six.u === 0, `★ 没改过的那条没归到基准：${six.u}`)
  r.db.close()
})

check('★★ R-4-G · 生命周期 pristine → 改名 → 软删，每一步的同步事实都对', () => {
  const r = legacyDb('devAAAA')
  runV20(r.db)
  /**
   * ★ 拿「第 2 行」不能写 `where sort = 2` —— `sort` 是 0 起的，
   *   那样取到的是第 3 行（身份 `genres-builtin-3`），断言当场就红。
   *   V27 之前这里写的是 `where id = 2`，id 是 1 起的所以对。
   *   现在按顺序取第 2 行，跟位置绑定，不跟某个列的起点约定绑定。
   */
  const row2 = () =>
    r.db
      .prepare(`select uid, name, updated_at as u, deleted_at as d from genres order by sort, rowid limit 1 offset 1`)
      .get() as { uid: string; name: string; u: number; d: number | null }
  const uid = row2().uid
  assert(uid === 'genres-builtin-2', `身份不对：${uid}`)
  assert(row2().u === 0, 'pristine 该是 0')

  // ── 改名：走真业务入口，不是手写 SQL ──
  const files = new Files(r.db, join(process.cwd(), 'prompts'))
  files.saveGenre({ uid, name: '我改的体裁', prompt: 'x' })
  const named = row2()
  assert(named.name === '我改的体裁', '改名没生效')
  assert(named.u > 0, '★ 用户改名之后 updated_at 还是 0 —— 这次修改传不出去')
  assert(named.uid === uid, `★ 改名把身份也改了：${uid} → ${named.uid}`)

  // ── 软删：同样要能传出去，而且身份不变 ──
  files.deleteGenre(uid)
  const gone = row2()
  assert(gone.d !== null, '软删没生效')
  assert(gone.u >= named.u, '★ 软删没抬 updated_at —— 删除传不到另一台')
  assert(gone.uid === uid, `★ 软删把身份改了：${gone.uid}`)
  r.db.close()
})

check('★★ R-4-G · ⑦ 同一个身份被两行抢：保留原样、记一笔，绝不删也绝不合并', () => {
  const r = legacyDb('devAAAA')
  // 手工造一个「已经有人占着 tutors-builtin-2」的怪库
  const t = Date.now()
  r.db
    .prepare(
      `insert into tutors (name, persona, strictness, task_density, answer_timing,
                           builtin, is_default, sort, uid, created_at, updated_at)
       values ('冒名顶替的', '', 5, 5, 'after', 0, 0, 98, 'tutors-builtin-2', ?, ?)`
    )
    .run(t, t)
  const before = builtinBody(r.db)
  const rows = (r.db.prepare(`select count(*) as n from tutors`).get() as { n: number }).n

  runV20(r.db) // 不许抛

  assert(
    (r.db.prepare(`select count(*) as n from tutors`).get() as { n: number }).n === rows,
    '★ 删了行 —— 绝不允许为了让迁移成功就挑一个删掉'
  )
  assert(builtinBody(r.db) === before, '★ 内容被合并/覆盖了')
  const second = (r.db.prepare(`select uid from tutors where id = 2`).get() as { uid: string }).uid
  assert(
    second !== 'tutors-builtin-2' && second.includes('devAAAA'),
    `★ 抢占的那一行该保留原 uid，实际 ${second}`
  )
  /**
   * 而且要看得见 —— 不然这几行以后会一直同步失败而没人知道原因。
   *
   * ★ D-296（V34）· 体检是**按当前结构**写的（有一条要 join `reading_cards`），
   *   而这条夹具的库停在 V19/V20。所以先把它升到当前版本再体检 ——
   *   产品里体检也只会跑在迁移完成之后的库上，这样才是真实条件。
   */
  const legacyPath = r.db.name
  const legacyBackups = join(dirname(legacyPath), 'backups')
  r.db.close()
  const upped = openDatabase(legacyPath, legacyBackups)
  assert(
    auditIds(upped.db).includes('builtin-identity-dup'),
    `★ 没归一的那几行在体检里看不见：${auditIds(upped.db).join('、')}`
  )
  upped.db.close()
})

check('★★ R-4-G · ⑧⑨ 他真实库那种形状：presets 空 + 只有自建导师 → 不崩、不凭空插行', () => {
  const r = legacyDb('devAAAA')
  const t = Date.now()
  // 他真实库就是这样：prompt_presets 一行都没有，tutors 只剩一条自己建的
  r.db.prepare(`delete from prompt_presets`).run()
  r.db.prepare(`delete from tutors`).run()
  r.db
    .prepare(
      `insert into tutors (name, persona, strictness, task_density, answer_timing,
                           builtin, is_default, sort, created_at, updated_at)
       values ('Lumen', '', 5, 5, 'after', 0, 1, 1, ?, ?)`
    )
    .run(t, t)
  const lumenUid = (r.db.prepare(`select uid from tutors`).get() as { uid: string }).uid

  runV20(r.db) // 不许抛

  assert(
    (r.db.prepare(`select count(*) as n from prompt_presets`).get() as { n: number }).n === 0,
    '★ V20 在空表里凭空插了行 —— 补种是 ensureBuiltins 的职责，不是迁移的'
  )
  const tutors = r.db.prepare(`select uid, name from tutors`).all() as { uid: string; name: string }[]
  assert(tutors.length === 1 && tutors[0]!.name === 'Lumen', '★ 动了他的导师表')
  assert(tutors[0]!.uid === lumenUid, `★ 动了自建导师的身份：${lumenUid} → ${tutors[0]!.uid}`)
  r.db.close()
})

check('★ R-4-G · ⑩ 归一之后外键完整性照旧', () => {
  const r = legacyDb('devAAAA')
  seedTree(r)
  runV20(r.db)
  const bad = r.db.pragma('foreign_key_check') as unknown[]
  assert(bad.length === 0, `★ 外键坏了：${JSON.stringify(bad).slice(0, 200)}`)
  r.db.close()
})

check('★★ R-4-G · ⑪ 再跑一次 V20：整库一个字都不变（幂等）', () => {
  const r = legacyDb('devAAAA')
  seedTree(r)
  runV20(r.db)
  const snap = snapshotAll(r.db)
  const uids = builtinIds(r.db)

  runV20(r.db)

  assert(snapshotAll(r.db) === snap, '★ 第二遍动了数据 —— 迁移不幂等')
  assert(builtinIds(r.db) === uids, '★ 第二遍改了身份')
  r.db.close()
})

check('★ R-4-G · 正常升级路径：user_version 到 20，全新库一次到位', () => {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const v = r.db.pragma('user_version', { simple: true }) as number
  assert(v === TARGET_VERSION, `user_version 该是 ${TARGET_VERSION}，实际 ${v}`)
  assert(TARGET_VERSION >= 20, `TARGET_VERSION 没跟上：${TARGET_VERSION}`)
  assert(
    !auditIds(r.db).includes('builtin-identity-dup'),
    '★ 全新库归一就报冲突 —— 那说明规则本身有问题'
  )
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ R-4-G 封板前的落地验证（post-migration verification）
//
// 上一轮证明了「规则是对的」。这一块验的是另一件事：
// **拿他机器现在那个真实形状，装上新版之后会变成什么样。**
//
// 那个形状不是理论上的：prompt_presets 一行都没有（sqlite_sequence 里
// 连这张表都没有，说明从来没插入过），tutors 只剩一条他自己建的 Lumen，
// genres 4 条 / qtypes 12 条出厂内容俱全，其中一条被他改过。
// ══════════════════════════════════════════════════════════════

console.log('\nR-4-G · 落地验证\n')

/**
 * 造一个「他现在那台机器」的库。
 *
 * 不是随手编的形状 —— 逐项对着真实库副本抄下来的（只读查过，没有改动）。
 */
function hisShape(): ReturnType<typeof openDatabase> {
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  const t = Date.now()

  // prompt_presets：一行都没有，而且从来没插入过（自增序列里也没有它）
  r.db.prepare(`delete from prompt_presets`).run()
  r.db.prepare(`delete from sqlite_sequence where name = 'prompt_presets'`).run()

  // tutors：出厂那三个不在了，只有他自己建的一条
  r.db.prepare(`delete from tutors`).run()
  r.db
    .prepare(
      `insert into tutors (name, persona, strictness, task_density, answer_timing,
                           builtin, is_default, sort, created_at, updated_at)
       values ('Lumen', '', 5, 5, 'after', 0, 1, 1, ?, ?)`
    )
    .run(t, t)

  // qtypes：第 7 条被他改过（真实库里那条差了约 4 分 51 秒）
  r.db.prepare(`update qtypes set name = '我改过的', updated_at = ? where sort = 7`).run(t + 291214)
  return r
}

const presetRows = (db: Database.Database): { uid: string; u: number; name: string }[] =>
  db
    .prepare(`select uid, updated_at as u, name from prompt_presets order by sort, id`)
    .all() as { uid: string; u: number; name: string }[]

check('★★ R-4-G 落地 · ① 他那种形状：启动自愈把 prompt_presets 补回 3 条', () => {
  const r = hisShape()
  assert(presetRows(r.db).length === 0, '前提没成立：这张表本该是空的')

  // 这就是 index.ts 启动时调的那一个函数（补出厂内容 + 收拾状态）
  const heal = startupHeal(r.db)

  assert(heal.problems.length === 0, `自愈报了毛病：${JSON.stringify(heal.problems)}`)
  const rows = presetRows(r.db)
  assert(rows.length === 3, `★ 没补回来（或补多了）：${rows.length} 条`)
  assert(
    rows.every((x) => x.uid.startsWith('prompt_presets-builtin-')),
    `★ 补回来的没拿到确定性身份 —— 换台机器同步会撞主键：${rows.map((x) => x.uid).join('、')}`
  )
  assert(
    JSON.stringify(rows.map((x) => x.uid)) ===
      JSON.stringify(['prompt_presets-builtin-1', 'prompt_presets-builtin-2', 'prompt_presets-builtin-3']),
    `★ 序位对不上：${rows.map((x) => x.uid).join('、')}`
  )
  assert(
    rows.every((x) => x.u === 0),
    `★ 刚播下去的出厂内容不是 pristine —— 它会去跟另一台机器抢：${JSON.stringify(rows)}`
  )
  r.db.close()
})

check('★★ R-4-G 落地 · ① 第二次启动完全幂等，不会重复播种', () => {
  const r = hisShape()
  startupHeal(r.db)
  const snap = snapshotAll(r.db)

  startupHeal(r.db) // 再开一次软件

  assert(snapshotAll(r.db) === snap, '★ 第二次启动动了数据')
  assert(presetRows(r.db).length === 3, `★ 又播了一遍：${presetRows(r.db).length} 条`)
  r.db.close()
})

check('★★ R-4-G 落地 · ① 自愈不碰他自己的东西，也不把改过的出厂内容洗掉', () => {
  const r = hisShape()
  const lumen = r.db.prepare(`select uid, name from tutors`).get() as { uid: string; name: string }
  const mine = r.db.prepare(`select uid, name, updated_at as u from qtypes where sort = 7`).get() as {
    uid: string
    name: string
    u: number
  }

  startupHeal(r.db)

  const tutors = r.db.prepare(`select uid, name from tutors`).all() as { uid: string; name: string }[]
  assert(
    tutors.length === 1 && tutors[0]!.name === 'Lumen' && tutors[0]!.uid === lumen.uid,
    `★ 动了他自己建的导师：${JSON.stringify(tutors)}`
  )
  const after = r.db.prepare(`select name, updated_at as u from qtypes where sort = 7`).get() as {
    name: string
    u: number
  }
  assert(after.name === '我改过的', '★ 他改过的题型被洗回出厂了')
  assert(after.u === mine.u, `★ 他那次修改的时间被抹了：${mine.u} → ${after.u}`)
  assert(auditIds(r.db).length === 0, `体检不干净：${auditIds(r.db).join('、')}`)
  r.db.close()
})

check('★ R-4-G 落地 · ① 「表空了才补」这条判据没被破坏：只剩一条也不补', () => {
  /**
   * 判据是**整张表空**，不是「少于三条」。他删掉两个只留一个是他的选择，
   * 不该在下次启动时又冒出两个。这条守的是那个边界 ——
   * R-4-G 给播种加了 uid 和时间戳，别把这条判据顺手改了。
   */
  const r = hisShape()
  startupHeal(r.db)
  r.db.prepare(`delete from prompt_presets where sort > 1`).run()
  const before = presetRows(r.db)
  assert(before.length === 1, `前提没成立：${before.length}`)

  startupHeal(r.db)

  assert(presetRows(r.db).length === 1, `★ 只剩一条时又补了一遍：${presetRows(r.db).length}`)
  r.db.close()
})

// ── ④ 同步记账没有被 builtin 归一破坏 ──────────────────────────

/** 一个「升级前推上去的」出厂内容行 —— uid 是随机的 */
function legacyBuiltinRow(table: string, extra: Record<string, unknown>): Record<string, unknown> {
  const t = Date.now()
  return {
    uid: `${table}-deadbeefdeadbee0`,
    table,
    updatedAt: t,
    data: { builtin: 1, deleted_at: null, created_at: t - 1000, updated_at: t, uid: `${table}-deadbeefdeadbee0`, ...extra }
  }
}

checkAsync('★★ R-4-G 落地 · ④ 认不出的出厂内容算 skipped，不算 failed，包照常进 applied', async () => {
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'g1')
  const sync = newSync(r, backups)
  const tutorsBefore = (r.db.prepare(`select count(*) as n from tutors`).get() as { n: number }).n

  // tutors 认的是「在发送方那张表里排第几」—— 一行数据里推不出来，只能跳过
  putChunk('g1', 'other-100.json', [
    legacyBuiltinRow('tutors', {
      id: 4242, name: '老包里的导师', persona: '', strictness: 5, task_density: 5,
      answer_timing: 'after', free_prompt: '', is_default: 0, sort: 9
    })
  ] as unknown as Record<string, unknown>[])

  const out = await r4Run(sync)
  assert(out.failed === 0, `★ 有意跳过被当成了失败 —— 这一包会永远重试：${out.failed}`)
  assert(out.applied === 0, `不该写进去，实际 ${out.applied}`)
  assert(out.skipped === 1, `该跳过 1 行，实际 ${out.skipped}`)
  assert(out.received === 1, `收到的行数不对：${out.received}`)
  assert(
    out.applied + out.skipped + out.failed === out.received,
    `★ 四个数对不上账：${JSON.stringify(out)}`
  )
  assert(/跳过 1 条/.test(syncState(r.db).note), `★ 他看到的那句话里没提跳过：${syncState(r.db).note}`)
  assert(
    syncState(r.db).applied.includes('other-100.json'),
    '★ 有意跳过的包没进 applied —— 它会被无限重下'
  )
  assert(
    (r.db.prepare(`select count(*) as n from tutors`).get() as { n: number }).n === tutorsBefore,
    '★ 认不出来的那一行还是被写进去了'
  )
  r.db.close()
})

checkAsync('★★ R-4-G 落地 · ④ 归一之后，真正的失败照样不进 applied、照样重试', async () => {
  /**
   * R-4-A 的保证是「没写干净的包不许进 applied」，靠的是拿 `SyncRow` 的
   * **对象身份**反查它来自哪个包。R-4-G 归一时如果把行复制了一份，这条就断了 ——
   * 实施那天真的踩过一次。这条用例把两件事放在同一个包里，守住它。
   */
  await cloudReady
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, 'g2')
  const sync = newSync(r, backups)

  const t = Date.now()
  putChunk('g2', 'other-100.json', [
    // ① 认不出的出厂内容 → skipped
    legacyBuiltinRow('genres', { id: 4243, name: '老包里的体裁', prompt: '', is_default: 0, sort: 9 }),
    // ② 题型能按 key 重算 → 正常落库
    {
      uid: 'qtypes-deadbeefdeadbee1',
      table: 'qtypes',
      updatedAt: t,
      data: {
        key: '造句', name: '老包改的名字', tier: 1, brief: '', guide: '', prompt: '',
        enabled: 1, canonical: 1, builtin: 1, sort: 1, deleted_at: null,
        created_at: t - 1000, updated_at: t, uid: 'qtypes-deadbeefdeadbee1'
      }
    },
    // ③ 外键指向不存在的东西 → 真失败
    {
      uid: 'g2-il', table: 'item_lectures', updatedAt: t,
      data: { item_id: 1, lecture_id: 999, is_owner: 0, created_at: t, updated_at: t, uid: 'g2-il' }
    }
  ] as unknown as Record<string, unknown>[])

  const out = await r4Run(sync)
  assert(out.failed === 1, `该有 1 行真失败：${JSON.stringify(out)}`)
  assert(out.applied === 1, `题型那行该落库：${JSON.stringify(out)}`)
  assert(out.received === 3, `收到的行数不对：${JSON.stringify(out)}`)
  assert(out.skipped === 1, `该跳过 1 行：${JSON.stringify(out)}`)
  assert(
    out.applied + out.skipped + out.failed === out.received,
    `★ 四个数对不上账：${JSON.stringify(out)}`
  )
  assert(/跳过 1 条/.test(syncState(r.db).note), `★ 那句话里没提跳过：${syncState(r.db).note}`)
  assert(/失败 1 条/.test(syncState(r.db).note), `★ 那句话里没提失败：${syncState(r.db).note}`)
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★★ 包里有真失败，却进了 applied —— R-4-A 的重试保证被 R-4-G 破坏了'
  )
  // 题型是按 key 重算落库的：不长第二行，身份最终是 canonical
  const q = r.db.prepare(`select uid, name from qtypes where key = '造句'`).all() as {
    uid: string
    name: string
  }[]
  assert(q.length === 1, `★ 长出了第二条「造句」：${q.length}`)
  assert(q[0]!.uid === qtypeUid('造句'), `★ 身份没归一：${q[0]!.uid}`)
  assert(q[0]!.name === '老包改的名字', '★ 历史包里的改动没生效')
  r.db.close()
})

// ══════════════════════════════════════════════════════════════
// ★★ R-4-G-e · received = applied + skipped + failed，八种组合都要成立
//
// 这条恒等式坏掉的时候，什么都不会崩 —— 它只会让**下一次真出问题时
// 没人相信这些数**。所以它必须被逐种组合钉死，而不是「看起来对」。
//
// 判据：**每一行都恰好落进一个桶**。不是拿减法凑出来的 ——
// 用减法的话这条测试永远绿，验的是我的算术，不是他的数据。
// ══════════════════════════════════════════════════════════════

console.log('\nR-4-G-e · 四个数对得上账\n')

/** 一行普通的用户数据，能正常落库 */
function rowOk(n: number): Record<string, unknown> {
  const t = Date.now()
  return {
    uid: `e-project-${n}`,
    table: 'projects',
    updatedAt: t,
    data: {
      id: 500 + n, name: `对面的项目 ${n}`, color: '#666', sort: 0, pinned: 0, silent: 0,
      deleted_at: null, created_at: t, updated_at: t, uid: `e-project-${n}`
    }
  }
}

/** 外键指向不存在的东西 —— 真失败，下次要重试 */
function rowFail(n: number): Record<string, unknown> {
  const t = Date.now()
  return {
    uid: `e-il-${n}`,
    table: 'item_lectures',
    updatedAt: t,
    data: { item_id: 1, lecture_id: 900 + n, is_owner: 0, created_at: t, updated_at: t, uid: `e-il-${n}` }
  }
}

/** 认不出身份的出厂内容 —— 有意跳过（R-4-G） */
function rowUnknownBuiltin(n: number): Record<string, unknown> {
  const t = Date.now()
  return {
    uid: `tutors-deadbeefdeadbe0${n}`,
    table: 'tutors',
    updatedAt: t,
    data: {
      id: 700 + n, name: `老包里的导师 ${n}`, persona: '', strictness: 5, task_density: 5,
      answer_timing: 'after', free_prompt: '', is_default: 0, builtin: 1, sort: 9,
      deleted_at: null, created_at: t - 1000, updated_at: t, uid: `tutors-deadbeefdeadbe0${n}`
    }
  }
}

/** 认得出身份的出厂内容（题型按 key 重算）—— 正常落库 */
function rowKnownBuiltin(): Record<string, unknown> {
  const t = Date.now()
  return {
    uid: 'qtypes-deadbeefdeadbeef',
    table: 'qtypes',
    updatedAt: t,
    data: {
      key: '造句', name: '老包改的名字', tier: 1, brief: '', guide: '', prompt: '',
      enabled: 1, canonical: 1, builtin: 1, sort: 1, deleted_at: null,
      created_at: t - 1000, updated_at: t, uid: 'qtypes-deadbeefdeadbeef'
    }
  }
}

/** 已经在本地、时间戳一模一样 —— 合并阶段就判「不用动」 */
function rowSame(r: ReturnType<typeof openDatabase>): Record<string, unknown> {
  const row = r.db.prepare(`select * from projects where id = 1`).get() as Record<string, unknown>
  return {
    uid: String(row['uid']),
    table: 'projects',
    updatedAt: Number(row['updated_at']),
    data: row
  }
}

const COMBOS: {
  name: string
  rows: (r: ReturnType<typeof openDatabase>) => Record<string, unknown>[]
  want: { received: number; applied: number; skipped: number; failed: number }
}[] = [
  { name: '① 全成功', rows: () => [rowOk(1), rowOk(2)], want: { received: 2, applied: 2, skipped: 0, failed: 0 } },
  {
    name: '② 全 skipped（认不出的出厂内容）',
    rows: () => [rowUnknownBuiltin(1), rowUnknownBuiltin(2)],
    want: { received: 2, applied: 0, skipped: 2, failed: 0 }
  },
  { name: '③ 全失败', rows: () => [rowFail(1), rowFail(2)], want: { received: 2, applied: 0, skipped: 0, failed: 2 } },
  {
    name: '④ 成功 + skipped',
    rows: () => [rowOk(1), rowUnknownBuiltin(1)],
    want: { received: 2, applied: 1, skipped: 1, failed: 0 }
  },
  {
    name: '⑤ 成功 + 失败',
    rows: () => [rowOk(1), rowFail(1)],
    want: { received: 2, applied: 1, skipped: 0, failed: 1 }
  },
  {
    name: '⑥ skipped + 失败',
    rows: () => [rowUnknownBuiltin(1), rowFail(1)],
    want: { received: 2, applied: 0, skipped: 1, failed: 1 }
  },
  {
    name: '⑦ 成功 + skipped + 失败',
    rows: () => [rowOk(1), rowUnknownBuiltin(1), rowFail(1)],
    want: { received: 3, applied: 1, skipped: 1, failed: 1 }
  },
  {
    name: '⑧ 认得出的出厂内容 + 认不出的 + 普通用户行',
    rows: () => [rowKnownBuiltin(), rowUnknownBuiltin(1), rowOk(1)],
    want: { received: 3, applied: 2, skipped: 1, failed: 0 }
  },
  {
    name: '⑨ 合并阶段判「不用动」的那一类也要算进 skipped',
    rows: (r) => [rowSame(r), rowOk(1)],
    want: { received: 2, applied: 1, skipped: 1, failed: 0 }
  }
]

let combo = 0
for (const c of COMBOS) {
  checkAsync(`★★ R-4-G-e · ${c.name}`, async () => {
    await cloudReady
    const bucket = `e${++combo}`
    const { db: p, backups } = freshDir()
    const r = openDatabase(p, backups)
    seedTree(r)
    configureSync(r, bucket)
    const sync = newSync(r, backups)
    putChunk(bucket, 'other-100.json', c.rows(r) as unknown as Record<string, unknown>[])

    const out = await r4Run(sync)

    assert(
      out.received === c.want.received &&
        out.applied === c.want.applied &&
        out.skipped === c.want.skipped &&
        out.failed === c.want.failed,
      `★ 四个数不对：想要 ${JSON.stringify(c.want)}，拿到 ${JSON.stringify({
        received: out.received, applied: out.applied, skipped: out.skipped, failed: out.failed
      })}`
    )
    assert(
      out.applied + out.skipped + out.failed === out.received,
      `★★ 恒等式破了：${out.applied} + ${out.skipped} + ${out.failed} ≠ ${out.received}`
    )
    // 界面上那句话和返回值必须是同一份数 —— 以前就是这两处各加各的才出的事
    const note = syncState(r.db).note
    assert(
      note.includes(`收到 ${out.received} 行`) && note.includes(`应用 ${out.applied} 条`) &&
        note.includes(`跳过 ${out.skipped} 条`),
      `★ 他看到的那句话和返回值对不上：${note}`
    )
    r.db.close()
  })
}

checkAsync('★★ R-4-F · 有冲突的那一趟：没冲突的照写，冲突的进 conflicted，四个数对得上', async () => {
  /**
   * ★★ R-4-F · 这条用例的**语义变了**，不是放松，是收紧。
   *
   * 以前断言的是「一行都没写」—— 那正是那个 bug 本身：
   * 一行冲突会把同一批里没冲突的行、以及本地要推的行**一起挡住**。
   * 现在断言的是：**冲突只挡它自己**，别的行照常落库。
   *
   * 顺带把 R-4-G-e 那条恒等式扩到四个桶。
   */
  await cloudReady
  const bucket = 'ec1'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const sync = newSync(r, backups)

  // 造一个真冲突：本地这一行在水位之后改过，远端也改过
  const t = Date.now()
  r.db.prepare(`update projects set name = '我改的', updated_at = ? where id = 1`).run(t)
  const local = r.db.prepare(`select * from projects where id = 1`).get() as Record<string, unknown>
  putChunk(bucket, 'other-100.json', [
    { uid: String(local['uid']), table: 'projects', updatedAt: t + 1,
      data: { ...local, name: '对面改的', updated_at: t + 1 } },
    rowOk(1)
  ] as unknown as Record<string, unknown>[])

  const out = await r4Run(sync)
  assert(out.conflictNote, '前提没成立：这一趟该报出冲突')
  assert(
    out.applied + out.skipped + out.failed + out.conflicted === out.received,
    `★★ 四个桶对不上账：${JSON.stringify({
      r: out.received, a: out.applied, s: out.skipped, f: out.failed, c: out.conflicted
    })}`
  )
  assert(out.conflicted === 1, `★ 冲突那一行该进 conflicted：${JSON.stringify(out)}`)
  assert(
    out.applied === 1,
    `★★ 没冲突的那一行被冲突挟持了 —— 一个冲突不该阻塞别的数据：${JSON.stringify(out)}`
  )
  assert(out.failed === 0, `不该有失败：${JSON.stringify(out)}`)
  // D-201：冲突那一行**绝不静默覆盖**
  assert(
    (r.db.prepare(`select name from projects where id = 1`).get() as { name: string }).name === '我改的',
    '★★ 冲突那一行被静默覆盖了（D-201）'
  )
  // 而没冲突的那一行是真的写进库了 —— 不看返回值，直接查库
  assert(
    (r.db.prepare(`select count(*) as n from projects where uid = 'e-project-1'`).get() as {
      n: number
    }).n === 1,
    '★★ 报了 applied，库里却没有'
  )
  // 这一包有未裁决的冲突 → 不许进 applied（下次还要再问）
  assert(
    !syncState(r.db).applied.includes('other-100.json'),
    '★★ 还有没裁决的冲突，这一包却进了 applied —— 那三行再也不会被问起'
  )
  r.db.close()
})

checkAsync('★★ R-4-G-e · 选「用本地的」：被丢掉的冲突行要算进 skipped', async () => {
  await cloudReady
  const bucket = 'ec2'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const sync = newSync(r, backups)

  const t = Date.now()
  r.db.prepare(`update projects set name = '我改的', updated_at = ? where id = 1`).run(t)
  const local = r.db.prepare(`select * from projects where id = 1`).get() as Record<string, unknown>
  putChunk(bucket, 'other-100.json', [
    { uid: String(local['uid']), table: 'projects', updatedAt: t + 1,
      data: { ...local, name: '对面改的', updated_at: t + 1 } },
    rowOk(1)
  ] as unknown as Record<string, unknown>[])

  const out = await sync.run('local')
  assert(
    out.applied + out.skipped + out.failed === out.received,
    `★★ 选「用本地的」那一趟账对不上：${JSON.stringify({ r: out.received, a: out.applied, s: out.skipped, f: out.failed })}`
  )
  assert(out.skipped >= 1, `★ 被丢掉的冲突行没算进 skipped：${JSON.stringify(out)}`)
  assert(
    (r.db.prepare(`select name from projects where id = 1`).get() as { name: string }).name === '我改的',
    '★ 选了用本地的，本地却被覆盖了'
  )
  r.db.close()
})

checkAsync('★★ R-4-G-e · 没有数据的行也要落进一个桶，不许从账里漏掉', async () => {
  await cloudReady
  const bucket = 'ec3'
  const { db: p, backups } = freshDir()
  const r = openDatabase(p, backups)
  seedTree(r)
  configureSync(r, bucket)
  const sync = newSync(r, backups)
  putChunk(bucket, 'other-100.json', [
    { uid: 'e-null-1', table: 'projects', updatedAt: Date.now(), data: null },
    rowOk(1)
  ] as unknown as Record<string, unknown>[])

  const out = await r4Run(sync)
  assert(
    out.applied + out.skipped + out.failed === out.received,
    `★★ 空数据行从账里漏了：${JSON.stringify({ r: out.received, a: out.applied, s: out.skipped, f: out.failed })}`
  )
  assert(out.applied === 1 && out.skipped === 1 && out.failed === 0, `分桶不对：${JSON.stringify(out)}`)
  r.db.close()
})

