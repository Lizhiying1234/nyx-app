import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openLecture } from './tree.ts'
import {
  convergenceProblems,
  runUntilFixedPoint,
  snapshot,
  type ConvergenceDevice,
  type DbLike
} from './convergence.ts'
import { SYNC_PROTOCOL_VERSION } from '../src/core/sync-protocol.ts'
import { probeDeletePermission, WebDavStore } from '../src/core/sync/store.ts'
import { compactBucket } from '../src/core/sync/compact.ts'
import type { SyncRow } from '../src/core/sync-merge.ts'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mainWindow } from './win.ts'
import { captureApp, keepOrClean } from './keep-on-fail.ts'

/**
 * 同步的端到端验收 · D-201
 *
 * **两台「机器」，一个假 WebDAV 服务器。**
 * 两个 Electron 实例各自一个数据目录（等于两台机器），中间隔着一个真的 HTTP 服务器 ——
 * 走的是真的 PROPFIND / MKCOL / PUT / GET，不是把 store 换成内存 Mock。
 * 换成 Mock 就验不到 WebDAV 那一层，而那一层恰恰是最容易写错的。
 *
 * 合并规则本身在 `src/core/sync-merge.test.ts` 里单独验（纯逻辑，17 项）。
 * 这里验的是**接起来之后真的能把数据搬过去**。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ★★ Step 2 · 手写的「别的设备推上来的包」必须带包头。
 *
 * Step 1 之后没有包头 = legacy；C-1（Step 2）之后 legacy 一律拒收 ——
 * 于是这些夹具塞进去的东西一个都收不到，红的是夹具不是产品。
 *
 * 包头**不在测试里另算一遍**（那就成了第二份指纹算法），
 * 而是从**软件自己刚推上去的那个包**里抄一份 —— 等于让这个假设备
 * 声称「我和你同版本」。抄不到就当场断言失败，绝不悄悄退回「没有包头」。
 */
function peerHeader(): {
  schemaVersion: number
  schemaFingerprint: string
  protocolVersion: number
} {
  for (const [name, body] of files) {
    if (!name.includes('/nyx/chunks/')) continue
    try {
      const p = JSON.parse(body) as {
        schemaVersion?: number
        schemaFingerprint?: string
        protocolVersion?: number
      }
      if (typeof p.schemaFingerprint === 'string' && p.schemaFingerprint !== '') {
        return {
          schemaVersion: p.schemaVersion ?? 0,
          schemaFingerprint: p.schemaFingerprint,
          protocolVersion: p.protocolVersion ?? SYNC_PROTOCOL_VERSION
        }
      }
    } catch {
      /* 不是包就跳过 */
    }
  }
  assert.fail(
    '★ 云端还没有软件自己推的包，抄不到包头 —— 这条用例得排在一次真同步之后'
  )
}

/** 这台机器上这条账**当前有效**的行数（撤销过的不算） */
function liveLedger(dataRoot: string, term: string, verdict: string): number {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db
    .prepare(
      `select count(*) as n from term_ledger
        where norm = ? and verdict = ? and revoked_at is null`
    )
    .get(term.trim().toLowerCase(), verdict) as { n: number }
  db.close()
  return r.n
}

/** 这台机器上这条账**存在**几行（撤销过的也算 —— 它是传播的载体） */
function anyLedger(dataRoot: string, term: string, verdict: string): number {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db
    .prepare(`select count(*) as n from term_ledger where norm = ? and verdict = ?`)
    .get(term.trim().toLowerCase(), verdict) as { n: number }
  db.close()
  return r.n
}

/** 某一讲在这台机器库里的 uid */
function lectureUid(dataRoot: string, id: number): string {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db.prepare(`select uid from lectures where id = ?`).get(id) as { uid: string }
  db.close()
  return r.uid
}

/** 这台机器库里还有没有这个身份的讲（软删的也算「还在」—— 我们验的是硬删） */
function hasLectureUid(dataRoot: string, uid: string): boolean {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db.prepare(`select count(*) as n from lectures where uid = ?`).get(uid) as { n: number }
  db.close()
  return r.n > 0
}

/** 这台机器上这块碑有几份 */
function tombCount(dataRoot: string, targetUid: string): number {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db
    .prepare(`select count(*) as n from tombstones where target_uid = ?`)
    .get(targetUid) as { n: number }
  db.close()
  return r.n
}

/**
 * ★★ D-438 的自动裁决开关（2026-09-04 · 这一整组用例的前提）
 *
 * D-438 之前：两边都改过 → **停下来问他**。
 * D-438 之后：默认**按时间新的那版自动定**，被盖掉的那一版写进 `ops_log`
 *   留痕（他原话「我写的东西也按照时间线来弄，不然太麻烦了」）。
 *
 * ★ 裁决机制本身**一个字都没删** —— 它由 `sync.autoResolve` 控制，
 *   关掉就还是「停下来问」。所以验它的用例必须**自己把开关关掉**，
 *   而不是靠「默认值恰好是那样」。`tests/db-safety.ts` 早就是这么做的，
 *   这个文件当时漏了：D-438 落地之后这里 6 条一起红，
 *   红的原因还全是「话术变了」，看着像同步坏了。
 */
function setAutoResolve(dataRoot: string, on: boolean): void {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
  db.prepare(
    `insert into settings (key, value, updated_at) values ('sync.autoResolve', ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).run(on ? '1' : '0', Date.now())
  db.close()
}

/** D-438 · 这台机器上「被盖掉的那一版」落了几笔账（`ops_log` 的 sync-override） */
function overrideNotes(dataRoot: string): number {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db.prepare(`select count(*) as n from ops_log where op = 'sync-override'`).get() as {
    n: number
  }
  db.close()
  return r.n
}

/**
 * 把 `applied` 清空 —— **这不是造假**：那张名单只留最后 500 个包名，
 * 溢出之后老包必然会被重新下载重放。这里只是把「几个月之后」提前到现在。
 */
function clearApplied(dataRoot: string): void {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
  db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  db.close()
}

/** 打回「新设备」那个状态：applied 空 + 水位 0 */
function resetSyncCursor(dataRoot: string): void {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
  db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
  db.prepare(`update settings set value = '0' where key = 'sync.watermark'`).run()
  db.close()
}

/** 这台机器库里那一讲现在叫什么 —— 直接查库，不看界面那句话 */
function lectureName(dataRoot: string, id: number): string {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db.prepare(`select name from lectures where id = ?`).get(id) as { name: string }
  db.close()
  return r.name
}

/** 这台机器上对某一行的裁决（R-4-F-a）。没有就是 null */
function resolutionOf(dataRoot: string, targetUid: string): { uid: string; upTo: number } | null {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db
    .prepare(`select uid, rejected_up_to as upTo from resolutions where target_uid = ?`)
    .get(targetUid) as { uid: string; upTo: number } | undefined
  db.close()
  return r ?? null
}

/** 这台机器库里那一讲的时间戳 —— D5 顶没顶过看它 */
function lectureAt(dataRoot: string, id: number): number {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db.prepare(`select updated_at as t from lectures where id = ?`).get(id) as { t: number }
  db.close()
  return r.t
}

/** R-4-C-a 那一批知识点在这台机器库里的 uid —— 两边比集合，不看报出来的数 */
function batchItemUids(dataRoot: string): string[] {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const rows = db
    .prepare(`select uid from items where term like 'batched phrase%' order by uid`)
    .all() as { uid: string }[]
  db.close()
  return rows.map((r) => r.uid)
}

/** 这台机器的同步水位 —— 夹具铺干净了没有，看它 */
function syncWatermark(dataRoot: string): number {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db.prepare(`select value from settings where key = 'sync.watermark'`).get() as
    | { value: string }
    | undefined
  db.close()
  return Number(r?.value ?? 0) || 0
}

/**
 * ★ F-015 · 引擎有没有把「见过的最大远端时间戳」落盘。
 *
 * 它是回收站到期硬删唯一的外部时钟参照（core/purge-guard.ts）。
 * 不落盘的话那道闸会**静默退化成永远放行** —— 而这正是本项目
 * 定义的最贵失败形态：能力建好了、没接上、没人发现。
 */
function maxRemoteSeen(dataRoot: string): number {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const r = db.prepare(`select value from settings where key = 'sync.maxRemoteSeen'`).get() as
    | { value: string }
    | undefined
  db.close()
  return Number(r?.value ?? 0) || 0
}

/** 直接读某台机器库里的出厂身份 —— uid 没有 IPC 暴露，只能这么看 */
function builtinUids(dataRoot: string): Record<string, string[]> {
  const db = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'), { readOnly: true })
  const out: Record<string, string[]> = {}
  for (const t of ['tutors', 'genres', 'qtypes', 'prompt_presets']) {
    out[t] = (
      // ★ 末位排序用 `rowid`：V27 之后 genres/qtypes 没有 id 列了（R-3-h），
      //   而 `rowid` 每张表都有，四张表用同一句就够
      db.prepare(`select uid from "${t}" where builtin = 1 order by sort, rowid`).all() as {
        uid: string
      }[]
    ).map((r) => r.uid)
  }
  db.close()
  return out
}
const rootA = mkdtempSync(join(tmpdir(), 'nyx-syncA-'))
const rootB = mkdtempSync(join(tmpdir(), 'nyx-syncB-'))

let dav: Server
let port = 0
/** 假 WebDAV 的「磁盘」 */
const files = new Map<string, string>()
/** ★ T-2.2 · 关掉它 = 这个云端只让写不让删（负向对照 ③ 用） */
let davAllowDelete = true
const filesSeen = (): string[] => [...files.keys()].filter((k) => !k.startsWith('dir:'))

let A: ElectronApplication
let B: ElectronApplication
let pa: Page
let pb: Page
const errors: string[] = []

function startDav(): Promise<void> {
  dav = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').replace(/\/+$/, ''))

    if (req.method === 'MKCOL') {
      res.writeHead(files.has(`dir:${path}`) ? 405 : 201).end()
      files.set(`dir:${path}`, '')
      return
    }

    if (req.method === 'PROPFIND') {
      const kids = [...files.keys()].filter(
        (k) => !k.startsWith('dir:') && k.startsWith(path ? `${path}/` : '')
      )
      const hrefs = kids.map((k) => `<D:response><D:href>/${k}</D:href></D:response>`).join('')
      res
        .writeHead(207, { 'content-type': 'application/xml' })
        .end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${hrefs}</D:multistatus>`)
      return
    }

    if (req.method === 'PUT') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        files.set(path, body)
        res.writeHead(201).end()
      })
      return
    }

    if (req.method === 'GET') {
      const v = files.get(path)
      if (v === undefined) return void res.writeHead(404).end()
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(v)
    }

    /**
     * ★★ T-2.2 · DELETE。以前这个假服务器压根不认它（落到最后那个 405）——
     * 因为 `RemoteStore` 当时就没有删除原语。
     *
     * `davAllowDelete = false` 是**负向对照的开关**：模拟「这把凭据能写不能删」，
     * 压实必须在那种云端上拒绝动手。
     */
    if (req.method === 'DELETE') {
      if (!davAllowDelete) return void res.writeHead(403).end()
      const had = files.delete(path)
      return void res.writeHead(had ? 204 : 404).end()
    }

    res.writeHead(405).end()
  })
  return new Promise((r) => dav.listen(0, '127.0.0.1', () => r()))
}

async function launch(
  dataRoot: string,
  /** ★ Step 7D · 额外环境变量：真 Electron 里注入时间源靠它，每个实例各读各的 */
  extraEnv: Record<string, string> = {}
): Promise<[ElectronApplication, Page]> {
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1', ...extraEnv }
  })
  const page = await mainWindow(app)
  captureApp(app, basename(dataRoot))
  page.setDefaultTimeout(8000)
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  return [app, page]
}

/** 在设置页把同步配好 */
async function configure(page: Page): Promise<void> {
  await page.click('[data-testid="nav-settings"]')
  await page.click('[data-testid="set-tab-sync"]')
  await page.click('[data-testid="sync-webdav"]')
  await page.fill('[data-testid="sync-url"]', `http://127.0.0.1:${port}/nyx-test`)
  await page.fill('[data-testid="sync-user"]', 'me')
  await page.fill('[data-testid="sync-secret"]', 'app-password')
  await page.click('[data-testid="sync-save"]')
  await page.waitForSelector('[data-testid="sync-note"]')
}

/**
 * 点「现在同步」，等**这一次**跑完，把界面上那句话读回来。
 *
 * 不能只等「出现 sync-note」：上一次留下的字还在，选择器立刻就命中了，
 * 于是读到的是上一轮的结果 —— 这条验收前前后后假失败了好几次，症状每次都不同，
 * 病因是同一个。所以界面上挂了一个「跑完几次」的计数，等它变大才算数。
 */
async function runSync(page: Page, testid = 'sync-run'): Promise<string> {
  const sel = `[data-testid="${testid}"]`
  const before = Number(await page.getAttribute(sel, 'data-runs')) || 0
  await page.click(sel)
  await page.waitForFunction(
    ({ s, n }) => Number(document.querySelector(s)?.getAttribute('data-runs') ?? -1) > n,
    { s: '[data-testid="sync-run"]', n: before },
    { timeout: 20000 }
  )
  return page.innerText('[data-testid="sync-note"], [data-testid="sync-conflict"]')
}

before(async () => {
  await startDav()
  port = (dav.address() as { port: number }).port
  ;[A, pa] = await launch(rootA)
  ;[B, pb] = await launch(rootB)
})

after(async () => {
  await A?.close()
  await B?.close()
  dav?.close()
  for (const d of [rootA, rootB]) rmSync(d, { recursive: true, force: true })
})

describe('D-201 · 两台机器，一个 WebDAV', () => {
  /**
   * ★★ 每条用例开跑前把 D-438 的自动裁决**拨回默认**（2026-09-04）
   *
   * `sync.autoResolve` 是这台机器上的一项设置，不是某条用例的私有变量。
   * 验裁决机制的那几条要把它关掉，关掉之后如果不还原，
   * 后面验「零冲突」的用例会莫名其妙红，而红的原因和它们自己毫无关系
   * —— 这一轮就真的绊了一次（R-4-G 报「出厂内容变成了冲突」）。
   *
   * 与其指望每条用例都记得收尾，不如在这里统一拨回来：
   * **每条用例自己声明前提**，谁都不依赖上一条留下了什么。
   */
  beforeEach(() => {
    setAutoResolve(rootA, true)
    setAutoResolve(rootB, true)
  })

  it('连得上（PROPFIND / MKCOL 那一层是真的）', async () => {
    await configure(pa)
    await pa.click('[data-testid="sync-test"]')
    await pa.waitForFunction(() =>
      (document.querySelector('[data-testid="sync-note"]')?.textContent ?? '').includes('连得上')
    )
  })

  it('★ A 机器建的东西，同步之后 B 机器上有', async () => {
    // A 上建一讲、贴一份材料
    await pa.click('[data-testid="nav-home"]')
    await pa.click('[data-testid="home-start-btn"]')
    await pa.waitForSelector('[data-testid="drop-original"]')
    await pa.click('[data-testid="drop-original"] button')
    await pa.fill('[data-testid="compose-title"]', 'A 机器上的材料')
    await pa.fill('[data-testid="compose-text"]', 'Something A wrote on machine A.')
    await pa.click('[data-testid="compose-submit"]')
    await pa.waitForSelector('[data-testid="matbar"]')

    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    const pending = await pa.innerText('[data-testid="sync-pending"]')
    assert.notEqual(pending, '0 行', '刚建完东西，待推送不该是 0')
    await runSync(pa)
    assert.match(await pa.innerText('[data-testid="sync-note"]'), /推上去 \d+ 行/)

    // B 上拉下来
    await configure(pb)
    await runSync(pb)
    /**
     * ★ R-4-E 之后这句话换了措辞：以前是「拉下来 N 行」（**尝试数**），
     * 现在四个数各说各的。顺带会看到「失败 N 条」—— 那是 R-4-G
     * （两台机器的出厂内容 id 相同、uid 不同，撞主键），**本轮不修，已记录**。
     * 这条用例关心的是「A 建的东西到没到 B」，下面那句断言才是它的正题。
     */
    assert.match(await pb.innerText('[data-testid="sync-note"]'), /收到 \d+ 行/)

    // B 的首页上应该出现那一讲
    await pb.click('[data-testid="nav-home"]')
    await pb.waitForSelector('[data-testid="nav-lecture-1"]', { state: 'attached', timeout: 8000 })

    /**
     * ★★ F-015 · B 刚收了 A 的行，就必须记下「见过的最远端时刻」。
     * 这是回收站硬删那道时钟闸唯一的外部参照 ——
     * 它要是不落盘，闸就永远放行，而且没有任何人会发现。
     */
    const seen = maxRemoteSeen(rootB)
    assert.ok(seen > 0, `收过行之后 sync.maxRemoteSeen 应该有值，实际 ${seen}`)
    assert.ok(
      Math.abs(Date.now() - seen) < 24 * 3600_000,
      `它该是「刚才 A 写那些行的时刻」，不是随便一个数：${new Date(seen).toISOString()}`
    )
    // A 没收过任何行 —— 它那边应该还是空的（单调：没见过就不该凭空有）
    assert.equal(maxRemoteSeen(rootA), 0, 'A 这一趟一行都没收，参照不该凭空出现')
  })

  it('★ 只传变过的行 —— 什么都没改时，推上去 0 行', async () => {
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    assert.match(
      await pa.innerText('[data-testid="sync-note"]'),
      /推上去 0 行/,
      'D-201 修订的正题就是增量 —— 没改动却还在传，等于回到了全量快照'
    )
  })

  it('外键没指歪 —— 知识点还挂在原来那一讲上', async () => {
    // 走「我的收集」那条路建知识点：原样入库，不用 AI（D-006）
    await pa.click('[data-testid="nav-home"]')
    await openLecture(pa, 1)
    await pa.click('[data-testid="add-chunk"]')
    await pa.fill('[data-testid="compose-title"]', 'A 收集的')
    await pa.fill('[data-testid="compose-text"]', 'hold sway over\na far cry from')
    await pa.click('[data-testid="compose-submit"]')
    await pa.waitForSelector('[data-testid="chunk-receipt"]')

    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)

    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    await runSync(pb)

    // 同步只按 uid 认行；要是插入时把 id 丢了让本地重新编号，
    // item_lectures 记的就是对面的 id —— 这一讲下面会一条都查不到
    const terms = await pb.evaluate(async () =>
      (await window.nyx.data.lecture(1)).items.map((i) => i.term)
    )
    assert.ok(
      terms.includes('hold sway over'),
      `知识点没挂在这一讲下面（拿到的是 ${JSON.stringify(terms)}）—— 外键指歪了`
    )
  })

  it('★★ D-438 · 两边都改同一条 → 按时间新的自动定，被盖掉的那版落账（不打扰他）', async () => {
    // ★ 这一条验的是**默认行为**。D-201 的检测一个字没动（下面仍然要求
    //   同步结果里说出「两边都改过」），变的只是处置：不再问他。
    //   「停下来问」那条路由 `sync.autoResolve = 0` 走，见下一条用例。
    setAutoResolve(rootA, true)
    setAutoResolve(rootB, true)
    // 两边把同一条知识点判成不同的层。改完都先不同步，
    // 制造「上次同步之后两边都改过」
    const setLayer = async (page: Page, layer: 'A' | 'B'): Promise<number> =>
      page.evaluate(async (l) => {
        const d = await window.nyx.data.lecture(1)
        const it = d.items.find((x) => x.term === 'hold sway over')!
        await window.nyx.study.setLayer(it.id, l)
        return it.id
      }, layer)

    await setLayer(pa, 'A')
    /**
     * ★ 两次改动**必须落在不同的毫秒**。
     *
     * 时间戳一样时 `decideRow` 判的是 `same`（两边没动过），
     * 于是这一条会红在「B 没认出冲突」上 —— 而真正的原因是两次
     * `setLayer` 挤进了同一毫秒。整条链跑起来时真的撞到过一次。
     * R-4-F 那条双机用例早就为同一件事加了偏移。
     */
    await pb.waitForTimeout(5)
    await setLayer(pb, 'B')

    // A 先推上去。**A 这边不该有冲突** —— 只有 A 改过这一条。
    // A 要是自己先卡在冲突上，它就什么都没推，B 那边自然也不会冲突，
    // 于是下面的断言会挂在一个跟真正原因毫无关系的地方
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    const aNote = await runSync(pa)
    const aDiag = JSON.stringify(await pa.evaluate(async () => window.nyx.sync.status()))
    assert.match(aNote, /推上去 [1-9]/, `A 这边没推出去：${aNote} ${aDiag}`)

    // B 再同步 —— 这时 B 本地也改过。D-438 默认路径：按时间新的那版自动定，不问
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const text = await runSync(pb)
    const diag = await pb.evaluate(async () => window.nyx.sync.status())
    assert.match(
      text,
      /两边都改过/,
      `B 没认出冲突：${text}\nB 状态 ${JSON.stringify(diag)}\nA 说 ${aNote} ${aDiag}\n云端文件 ${JSON.stringify([...filesSeen()])}`
    )
    // ★ 自动定了要**说一句**。不打扰他 ≠ 不告诉他
    assert.match(text, /已按时间新的那版定|记在账本里/, `没说清这一版是怎么定的：${text}`)

    /**
     * ★★ 关键：B 后改（上面特意等了 5ms），所以按时间线**该留 B 那版**。
     *   这不是「没动库」，是「按规则定了，而且定的是新的那一版」。
     */
    const layer = await pb.evaluate(async () => {
      const d = await window.nyx.data.lecture(1)
      return d.items.find((x) => x.term === 'hold sway over')?.layer
    })
    assert.equal(layer, 'B', '★ 后改的那一版没赢 —— 时间线定不出这个结果')

    /**
     * ★★★ D-438 的另一半：**被盖掉的那一版必须留痕**。
     *   「不打扰他」是他要的，「悄悄弄丢他写的字」不是。
     */
    assert.ok(
      overrideNotes(rootB) > 0,
      '★★ 被盖掉的那一版没落进 ops_log —— 那就是悄悄弄丢了'
    )
  })

  it('关掉自动裁决 → 停下来问；选「用云端的」之后才真的覆盖', async () => {
    /**
     * ★ 裁决机制**一个字都没删**，只是 D-438 之后默认不走它。
     *   关掉 `sync.autoResolve` 就还是「停下来问 + 两个按钮」——
     *   这一条验的正是那条路还在（`tests/db-safety.ts` 同一套做法）。
     */
    setAutoResolve(rootA, false)
    setAutoResolve(rootB, false)
    // 上一条已经把那一行定掉了，这里两边再各改一次，重新造一个冲突出来
    await pa.evaluate(async () => {
      const d = await window.nyx.data.lecture(1)
      const it = d.items.find((x) => x.term === 'hold sway over')!
      await window.nyx.study.setLayer(it.id, 'A')
    })
    await pb.waitForTimeout(5)
    await pb.evaluate(async () => {
      const d = await window.nyx.data.lecture(1)
      const it = d.items.find((x) => x.term === 'hold sway over')!
      await window.nyx.study.setLayer(it.id, 'B')
    })
    await runSync(pa)
    const asked = await runSync(pb)
    assert.match(asked, /两边都改过/, `关掉自动裁决之后还是没问：${asked}`)
    assert.match(asked, /用哪|一个字都还没动|等你决定/, `没给出「你来选」那句话：${asked}`)

    await runSync(pb, 'sync-take-remote')
    const layer = await pb.evaluate(async () => {
      const d = await window.nyx.data.lecture(1)
      return d.items.find((x) => x.term === 'hold sway over')?.layer
    })
    assert.equal(layer, 'A', '选了用云端却没覆盖')
    /**
     * ★ 收尾：把这条用例造出来的冲突真正清掉，别留给下一条。
     *   开关本身由 `beforeEach` 统一拨回默认，这里不用管。
     */
    setAutoResolve(rootA, true)
    setAutoResolve(rootB, true)
    await runSync(pa)
    await runSync(pb)
  })

  /**
   * ★★ R-4 · 一行写不进去时，他必须看得见，而且点一下就能重来
   *
   * 这一条是整轮 R-4 的验收点。数据层那一块证明了记账对了（包不进 applied、
   * 数字是真的），但他看不见 `applied`，也看不见库。他看见的只有
   * 设置页那几行字 —— 而以前那几行字**主动告诉他成功了**。
   *
   * 造法：往云端塞一个手写的包，里面那一行的外键指向一个不存在的讲。
   * 这正是真实世界里最常见的那种失败（对面先推了知识点、它挂的那一讲
   * 还在下一个包里），而且它是**可修复**的 —— 正好用来验重试。
   */
  it('★★ R-4 · 一行写不进去 → 界面说「没有完全成功」，修好之后重试就进来了', async () => {
    const t = Date.now()
    // 手写一个「别的设备推上来的」包。lecture_id = 4242 现在还不存在
    files.set(
      'nyx-test/nyx/chunks/ghost-9999999999999.json',
      JSON.stringify({
        device: 'ghost',
        at: t,
        ...peerHeader(),
        rows: [
          {
            uid: 'r4-project',
            table: 'projects',
            updatedAt: t,
            data: {
              id: 4242, name: 'R-4 的项目', color: '#666', sort: 0, pinned: 0, silent: 0,
              deleted_at: null, created_at: t, updated_at: t, uid: 'r4-project'
            }
          },
          {
            uid: 'r4-link',
            table: 'item_lectures',
            updatedAt: t,
            data: {
              item_id: 1, lecture_id: 4242, is_owner: 0,
              created_at: t, updated_at: t, uid: 'r4-link'
            }
          }
        ]
      })
    )

    const note = await runSync(pb)
    assert.match(note, /失败 \d+ 条/, `★ 那句话里没提失败，他会以为同步好了：${note}`)

    /**
     * ★ 断言按**包名**来，不按总数。
     *
     * 这台机器上还有一片既有的失败：两台设备的出厂内容 id 相同、uid 不同，
     * 撞主键（R-4-G，本轮明确不修）。拿总数断言的话，这条用例验的就成了那片噪声。
     * 按包名断言，验的才是「这一次这个包没应用干净 → 说出来 → 重试 → 进来了」。
     */
    await pb.waitForSelector('[data-testid="sync-problems"]', { timeout: 8000 })
    const box = (await pb.innerText('[data-testid="sync-problems"]')).replace(/\s+/g, ' ')
    assert.match(box, /没有完全成功/, `★ 提示里没说清发生了什么：${box}`)
    assert.match(box, /点上面的「现在同步」就会重试/, `★ 没告诉他下一步能干什么：${box}`)
    // 红框上只列前几条（23 条全铺出来是噪音）—— 精确到行的断言走界面读的同一条 IPC
    const badRows = async (): Promise<string[]> =>
      (await pb.evaluate(async () => (await window.nyx.sync.status()).problems.map((x) => x.what)))
    assert.ok(
      (await badRows()).includes('item_lectures/r4-link'),
      `★ 失败清单里没有那一行：${(await badRows()).join('、')}`
    )

    /**
     * ── 把失败原因修好 ──
     * 那一讲由**下一个包**送过来 —— 这正是真实世界里最常见的顺序：
     * 对面分两次推，知识点的关联先到、它挂的那一讲后到。
     */
    files.set(
      'nyx-test/nyx/chunks/ghost-9999999999998.json',
      JSON.stringify({
        device: 'ghost',
        at: t,
        ...peerHeader(),
        rows: [
          {
            uid: 'r4-lecture',
            table: 'lectures',
            updatedAt: t,
            data: {
              id: 4242, unit_id: 1, name: '迟到的那一讲', status: 'empty', due_at: null,
              interval_days: 0, silent: 0, sort: 0, deleted_at: null,
              created_at: t, updated_at: t, uid: 'r4-lecture'
            }
          }
        ]
      })
    )

    // ── 点一下「现在同步」重试 ──
    await runSync(pb)
    assert.ok(
      !(await badRows()).includes('item_lectures/r4-link'),
      `★ 修好之后那一行还在失败清单里 —— 一直亮着的红灯等于没有红灯：${(await badRows()).join('、')}`
    )

    // 原来失败的那一行现在真的进来了
    const linked = await pb.evaluate(async () => {
      const d = await window.nyx.data.lecture(4242)
      return d.items.length
    })
    assert.equal(linked, 1, '★ 重试之后那一行仍然没进来 —— 重试机制是假的')
  })

  /**
   * ★★ R-4-G · 这一条是整轮的正题。
   *
   * ★★ **这一套对「前面跑过什么」敏感 —— 2026-09-14 实测记在这儿。**
   *
   *   `smoke:study` 里加了一条会真发一次 `ai:explain` 的用例之后，
   *   紧跟其后的这一套当场红两条（「改完却没东西可推：推上去 0 行」＋
   *   「genres 两台机器对不上」）。而：
   *     · 摘掉那一条 → 绿      · 换 `smoke:reading` 排在前面 → 绿
   *     · 本套单跑两次 → 绿    · 单独跑那一条用例再跑本套 → 绿
   *   也就是说，**它在整套 study 里跑**才触发；中间那一环没查出来。
   *   当时的处置是把那条用例挪去 `ui-dict`（它本来就更该在那儿），
   *   **没有修掉这里的敏感性**。
   *
   *   ★ 一条闸的结果取决于前面跑过什么，本身就是脆的 ——
   *     下一个人如果看到这里莫名其妙地红，先问「前面那一套换过吗」，
   *     再怀疑同步本身。真要根治，得先找出这两条断言依赖的到底是什么外部状态。
   *
   * 两台**各自独立**的机器（两个 dataRoot、各自跑完整迁移、各自播种出厂内容），
   * 第一次同步：出厂内容既不能失败，也不能变成冲突。
   *
   * 归一之前这里是 27 行里 22 行 `UNIQUE constraint failed: <表>.id`；
   * 归一之后如果只统一 uid 不统一 `updated_at`，就变成 22 处「两边都改过」——
   * 而那 22 条他一条都没碰过。两种都不许有。
   */
  it('★★ R-4-G · 两台独立机器：出厂内容 0 失败 0 冲突，也不占「待推送」', async () => {
    const shape = async (page: Page): Promise<{ n: number; sample: string[] }> =>
      await page.evaluate(async () => {
        const rows = (await window.nyx.study.qtypes()).all.map((q) => q.key).sort()
        return { n: rows.length, sample: rows.slice(0, 3) }
      })

    // 前提：两边确实是各自播种出来的（不是复用同一份库）
    const da = await pa.evaluate(async () => (await window.nyx.sync.status()).device)
    const db2 = await pb.evaluate(async () => (await window.nyx.sync.status()).device)
    assert.notEqual(da, db2, '★ 两台机器的设备号一样 —— 那就不是两台机器，这条用例是假的')
    assert.deepEqual(await shape(pa), await shape(pb), '前提：两边出厂题型应该一样')

    for (const page of [pa, pb]) {
      await page.click('[data-testid="nav-settings"]')
      await page.click('[data-testid="set-tab-sync"]')
      const note = await runSync(page)
      assert.doesNotMatch(note, /失败/, `★ 出厂内容同步失败了：${note}`)
      assert.doesNotMatch(note, /冲突/, `★ 出厂内容变成了冲突 —— 而他一条都没碰过：${note}`)
      assert.ok(
        !(await page.locator('[data-testid="sync-conflict"]').count()),
        '★ 界面上弹出了「两边都改过，用哪边」——那 22 条他从没碰过'
      )
    }
    // 没动过的出厂内容不该排在「待推送」里
    const pending = await pa.innerText('[data-testid="sync-pending"]')
    assert.equal(pending, '0 行', `★ 没动过的东西排在待推送里：${pending}`)

    /**
     * ★★ 上面那半只证明了「没动过的不产生同步变更」——
     * 把 uid 换成随机的，它照样绿（pristine 根本不推送，身份没被考到）。**那是假绿。**
     * 所以这里必须再走一步：**A 真的改一个出厂内容，看 B 认不认得出是同一条。**
     * 认不出来就会当成新行插入 → 撞主键 → 失败。这才验到 canonical 身份。
     */
    const renamed = '我在 A 上改的体裁名'
    await pa.evaluate(async (name) => {
      const list = await window.nyx.files.genres()
      const first = list[0]!
      await window.nyx.files.saveGenre({ uid: first.uid, name: name as string, prompt: first.prompt })
    }, renamed)

    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    const pushNote = await runSync(pa)
    assert.match(pushNote, /推上去 [1-9]/, `★ 改完却没东西可推：${pushNote}`)

    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const pullNote = await runSync(pb)
    assert.doesNotMatch(pullNote, /失败/, `★ B 认不出这是同一条出厂内容（撞主键）：${pullNote}`)
    assert.doesNotMatch(pullNote, /冲突/, `★ 变成了冲突：${pullNote}`)

    const onB = await pb.evaluate(async () => {
      const list = await window.nyx.files.genres()
      return { n: list.length, names: list.map((g) => g.name) }
    })
    assert.ok(
      onB.names.includes(renamed),
      `★ A 改的名字没到 B：${onB.names.join('、')}`
    )
    assert.equal(onB.n, 4, `★ B 上长出了第二行 —— 身份没对上：${onB.names.join('、')}`)
  })

  /**
   * ★★ R-4-G 落地 · 四张出厂表全都要对得上，不能只验一张。
   *
   * 前面那条只查了题型（它认 `key`，是最容易对的一张）。
   * 另外三张认的是**出厂序位** —— 那条路完全不同，必须单独验到。
   */
  it('★★ R-4-G 落地 · 四张出厂表的身份，两台机器逐行相同', async () => {
    const ids = async (page: Page): Promise<Record<string, string[]>> =>
      await page.evaluate(async () => {
        const out: Record<string, string[]> = {}
        out.qtypes = (await window.nyx.study.qtypes()).all.map((q) => q.key).sort()
        out.genres = (await window.nyx.files.genres()).map((g) => g.name).sort()
        out.tutors = (await window.nyx.files.tutors()).map((t) => t.name).sort()
        return out
      })
    const a = await ids(pa)
    const b = await ids(pb)
    for (const k of Object.keys(a)) {
      assert.deepEqual(a[k], b[k], `★ ${k} 两台机器对不上：${a[k]?.join('、')} ≠ ${b[k]?.join('、')}`)
    }

    /**
     * ★ 上面比的是**名字** —— 那个在随机 uid 下也一样，比了等于没比。
     * 真正要比的是**身份**，而 uid 没有任何 IPC 暴露出来，
     * 所以直接读两台机器的库文件。这一条才是有牙齿的那一半。
     */
    assert.deepEqual(
      builtinUids(rootA),
      builtinUids(rootB),
      '★★ 两台机器的出厂身份对不上 —— 名字一样但不是同一个对象，一同步就撞主键'
    )
    for (const [table, list] of Object.entries(builtinUids(rootA))) {
      assert.ok(
        // ★ Step 2 · 题型的身份改由 `qtypeUid(key)` 算（C-1），别的三张仍是出厂序位
        list.every((u) => u.startsWith(table === 'qtypes' ? `${table}-nat-` : `${table}-builtin-`)),
        `★ ${table} 有出厂行没拿到确定性身份：${list.join('、')}`
      )
    }
  })

  /**
   * ★★ R-4-G 落地 · 软删也要跨得过去。
   *
   * 「A 上删掉的出厂内容，B 上还在」和「同步不过去」是同一个病的两张脸：
   * 都是因为 B 认不出这是同一条。软删是普通更新，走的是同一套合并路径 ——
   * 它能过去，就说明身份真的对上了。
   */
  it('★★ R-4-G 落地 · A 软删一个出厂体裁 → B 同步后也没了，且不长第二行', async () => {
    const target = await pa.evaluate(async () => {
      const list = await window.nyx.files.genres()
      const g = list[list.length - 1]!
      await window.nyx.files.deleteGenre(g.uid)
      return { name: g.name, left: (await window.nyx.files.genres()).length }
    })
    assert.equal(target.left, 3, `★ A 上没删掉：还剩 ${target.left}`)

    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const note = await runSync(pb)
    assert.doesNotMatch(note, /失败/, `★ 删除同步失败了：${note}`)

    const onB = await pb.evaluate(async () => (await window.nyx.files.genres()).map((g) => g.name))
    assert.ok(!onB.includes(target.name), `★ A 上删掉的体裁在 B 上还在：${onB.join('、')}`)
    assert.equal(onB.length, 3, `★ B 上数目不对（可能长了第二行）：${onB.join('、')}`)
  })

  it('★ R-4-G 落地 · 出厂内容归一没碰他自己的数据', async () => {
    // 前面几条已经在 A 上建过项目/讲/知识点，同步过来的那些必须原样还在
    const onB = await pb.evaluate(async () => {
      const tree = await window.nyx.data.tree()
      const lec = await window.nyx.data.lecture(1)
      return { projects: tree.length, items: lec.items.length, name: tree[0]?.name }
    })
    assert.ok(onB.projects > 0, '★ B 上的项目没了')
    assert.ok(onB.items > 0, '★ B 上那一讲的知识点没了')
  })

  /**
   * ★★ R-4-G · 升级前推上去的那些包，uid 是随机的 —— 不能因为本地已经 V20 就拒收。
   * 题型认 `key`，所以它必须能被重算成 canonical 并正常 upsert：
   * 不撞主键、不长出第二行、内容照常更新。
   */
  it('★★ R-4-G · 历史包（随机 uid 的出厂内容）→ 重算身份，正常更新且不长第二行', async () => {
    const before = await pb.evaluate(async () => {
      const all = (await window.nyx.study.qtypes()).all
      return { n: all.length, one: all.find((q) => q.key === '造句')?.name }
    })
    assert.equal(before.one, '造句', '前提：B 上该有出厂的「造句」')

    // 手工塞一个「升级前」的包：uid 是随机的，内容改过
    const t = Date.now()
    // 包名末尾那段是时间戳（墓碑判据要用），跟着这一套现有的写法走
    files.set(
      'nyx-test/nyx/chunks/ghost-9999999999997.json',
      JSON.stringify({
        device: 'ghost',
        at: t,
        ...peerHeader(),
        rows: [
          {
            uid: 'qtypes-deadbeefdeadbeef',
            table: 'qtypes',
            updatedAt: t,
            data: {
              key: '造句', name: '老包改过的名字', tier: 1, brief: '', guide: '', prompt: '',
              enabled: 1, canonical: 1, builtin: 1, sort: 1, deleted_at: null,
              created_at: t - 1000, updated_at: t,
              uid: 'qtypes-deadbeefdeadbeef'
            }
          }
        ]
      })
    )

    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const note = await runSync(pb)
    assert.doesNotMatch(note, /失败/, `★ 历史包被判失败了（多半是撞主键）：${note}`)

    const after = await pb.evaluate(async () => {
      const all = (await window.nyx.study.qtypes()).all
      return { n: all.length, one: all.find((q) => q.key === '造句')?.name }
    })
    assert.equal(after.n, before.n, `★ 长出了第二行：${before.n} → ${after.n}`)
    assert.equal(after.one, '老包改过的名字', '★ 历史包里的改动没生效 —— 身份没被重算上')
  })

  /**
   * ══════════════════════════════════════════════════════════
   * ★★ R-3 · 删掉的东西不许被旧同步包复活
   *
   * 这几条必须走真双机：复活的四条路径（旧包重放 / `applied` 溢出 /
   * 新设备从头拉 / 导回备份）全都发生在**包和设备之间**，
   * 数据层的用例造不出来。
   * ══════════════════════════════════════════════════════════
   */

  /** 在 A 上建一讲，同步给 B，返回它的 uid —— 后面几条都从这个形状开始 */
  async function seedShared(name: string): Promise<{ lecId: number; uid: string }> {
    const lecId = await pa.evaluate(async (n) => {
      const p = await window.nyx.data.createProject(n as string)
      const u = await window.nyx.data.createUnit(p, '单元')
      return await window.nyx.data.createLecture(u, `要删的一讲 · ${n as string}`)
    }, name)
    const uid = lectureUid(rootA, lecId)

    for (const page of [pa, pb]) {
      await page.click('[data-testid="nav-settings"]')
      await page.click('[data-testid="set-tab-sync"]')
      await runSync(page)
    }
    assert.ok(hasLectureUid(rootB, uid), '前提没成立：B 上没拿到这一讲')
    return { lecId, uid }
  }

  /** 在 A 上把它彻底删掉（软删 → 垃圾箱 → 彻底删），返回墓碑数 */
  async function purgeOnA(lecId: number): Promise<void> {
    await pa.evaluate(async (id) => {
      await window.nyx.browse.deleteLecture(id as number)
      await window.nyx.browse.purgeMany([{ kind: 'lecture', id: id as number }])
    }, lecId)
  }

  it('★★ R-3 · ⑬ A 彻底删 → B 同步 → B 上也没了，而且 B 拿到了墓碑', async () => {
    const { lecId, uid } = await seedShared('R-3 删除传播')
    await purgeOnA(lecId)
    assert.equal(hasLectureUid(rootA, uid), false, 'A 上没删掉')
    assert.equal(tombCount(rootA, uid), 1, '★ A 上没立碑')

    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const note = await runSync(pb)

    assert.doesNotMatch(note, /失败/, `★ 墓碑同步失败了：${note}`)
    assert.equal(tombCount(rootB, uid), 1, '★ B 没收到墓碑 —— 它不知道你删了什么')
    assert.equal(
      hasLectureUid(rootB, uid),
      false,
      '★★ B 收到了墓碑，自己那一份却还留着 —— 他换台机器一看，删过的东西还在'
    )
  })

  it('★★ R-3 · ⑭ 把那个包重放一遍（B 再同步一次）→ 不许复活', async () => {
    const { lecId, uid } = await seedShared('R-3 旧包重放')
    // A 删之前，B 那边已经有它了；A 删掉并推上去
    await purgeOnA(lecId)
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)

    // B 同步：收到墓碑，本地那一行被删
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    await runSync(pb)

    /**
     * 现在把 B 的 `applied` 清空 —— 这不是造假，是**必然会发生的事**：
     * 那张名单只留最后 500 个包名，溢出之后老包会被重新下载重放。
     * 重放的包里就有那一讲**删除之前**的版本。
     */
    clearApplied(rootB)
    const out = await pb.evaluate(async () => await window.nyx.sync.run('local'))
    assert.equal(out.failed, 0, `重放时有失败：${JSON.stringify(out)}`)

    assert.equal(hasLectureUid(rootB, uid), false, '★★ 删掉的一讲被旧包复活了 —— 这正是 R-3')

    /**
     * ★ 光看末态是**不够**的。
     *
     * 收到墓碑时还会顺手清掉本地那一份（`applyTombstones`），所以就算
     * 挡的那一层完全失效、老行先被写了进来，末态照样是「它不在」——
     * 这条用例就会假绿（把 `isBlocked` 整个短路掉验证过，它确实还是绿的）。
     *
     * 所以要验**它压根没进来过**：进来过的话就会有东西需要事后清理，
     * 那句话里会出现「这边也清掉了」。
     */
    assert.doesNotMatch(
      out.lastNote,
      /这边也清掉了/,
      `★★ 老行是先被写进来、再被清掉的 —— 挡的那一层没生效：${out.lastNote}`
    )
  })

  it('★★ R-3 · ⑮⑯ applied 清空 + 水位归零（等于新设备从头拉）→ 仍然不复活', async () => {
    const { lecId, uid } = await seedShared('R-3 从头拉')
    await purgeOnA(lecId)
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    await runSync(pb)

    /**
     * 「新设备从头同步」的本质是两件事：`applied` 是空的、水位是 0。
     * 这里把 B 打回那个状态 —— 比新建一个 Electron 实例快得多，
     * 而验的是同一件事。（真·第三台的那一份留给后面那条。）
     */
    resetSyncCursor(rootB)
    /**
     * 水位归零之后，本地已有的行会和云端那份「两边都改过」——
     * 那是 D-201 的正常冲突，会停下来问。这里直接给裁决让它往下走：
     * 被删掉的那一行**本地根本不存在**，走的不是冲突那一支，
     * 而是 `!local` → 问墓碑，正是要验的那一格。
     */
    const out = await pb.evaluate(async () => await window.nyx.sync.run('local'))
    assert.equal(out.failed, 0, `从头拉时有失败：${JSON.stringify(out)}`)
    assert.equal(hasLectureUid(rootB, uid), false, '★★ 从头拉一遍，删掉的东西回来了')
    // 同上：必须是**没让它进来**，不是「进来了又被清掉」
    assert.doesNotMatch(
      out.lastNote,
      /这边也清掉了/,
      `★★ 老行进来过又被清掉 —— 挡的那一层没生效：${out.lastNote}`
    )
  })

  it('★★ R-3 · ⑰ B 已经有墓碑，之后又收到那一讲的老版本 → 仍然挡住，且算 skipped 不算 failed', async () => {
    const { lecId, uid } = await seedShared('R-3 墓碑先到')
    await purgeOnA(lecId)
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    await runSync(pb)
    assert.equal(tombCount(rootB, uid), 1, '前提：B 该有碑了')

    // 手工塞一个「第三台设备推上来的」包，里面是那一讲删除之前的样子
    const t = Date.now() - 60_000
    files.set(
      'nyx-test/nyx/chunks/ghost-9999999999995.json',
      JSON.stringify({
        device: 'ghost',
        at: t,
        ...peerHeader(),
        rows: [
          {
            uid,
            table: 'lectures',
            updatedAt: t,
            data: {
              id: 4444, unit_id: 1, name: '从坟里爬出来的', status: 'empty', sort: 0,
              silent: 0, due_at: null, interval_days: 0, preset_id: null,
              deleted_at: null, created_at: t, updated_at: t, uid
            }
          }
        ]
      })
    )

    const out = await pb.evaluate(async () => await window.nyx.sync.run())
    assert.equal(out.failed, 0, `★ 被墓碑挡下算成了失败：${JSON.stringify(out)}`)
    assert.ok(out.skipped >= 1, `★ 挡下的没算进 skipped：${JSON.stringify(out)}`)
    assert.equal(
      out.applied + out.skipped + out.failed,
      out.received,
      `★ 四个数对不上账：${JSON.stringify(out)}`
    )
    assert.equal(hasLectureUid(rootB, uid), false, '★★ 老版本被写进来了')
  })

  it('★★ R-3 · ⑱ 删掉之后重建一个看起来一样的 → 新身份，正常同步，旧碑不挡它', async () => {
    const { lecId, uid } = await seedShared('R-3 重建')
    await purgeOnA(lecId)

    // 重建一个同名的
    const again = await pa.evaluate(async () => {
      const tree = await window.nyx.data.tree()
      const unit = tree.find((p) => p.name === 'R-3 重建')!.units[0]!
      return await window.nyx.data.createLecture(unit.id, '要被删掉的一讲')
    })
    const newUid = lectureUid(rootA, again)
    assert.notEqual(newUid, uid, '★★ 重建的对象拿到了旧身份 —— 身份和内容必须分开')

    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const note = await runSync(pb)
    assert.doesNotMatch(note, /失败/, `重建的对象同步失败了：${note}`)

    assert.ok(hasLectureUid(rootB, newUid), '★ 重建的那一讲没同步过去 —— 旧碑不该挡新身份')
    assert.equal(hasLectureUid(rootB, uid), false, '★ 旧身份又回来了')
  })

  it('★★ R-3 · ⑲ 一边删、一边改 → 拒绝复活，并且在体检里说得出为什么', async () => {
    const { lecId, uid } = await seedShared('R-3 删后修改')
    await purgeOnA(lecId)
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)

    // 另一台在「删除之后」还改过它 —— 时间戳比墓碑新
    const later = Date.now() + 60_000
    files.set(
      'nyx-test/nyx/chunks/ghost-9999999999994.json',
      JSON.stringify({
        device: 'ghost',
        at: later,
        ...peerHeader(),
        rows: [
          {
            uid,
            table: 'lectures',
            updatedAt: later,
            data: {
              id: 4445, unit_id: 1, name: '我在你删掉之后改的名字', status: 'empty', sort: 0,
              silent: 0, due_at: null, interval_days: 0, preset_id: null,
              deleted_at: null, created_at: later, updated_at: later, uid
            }
          }
        ]
      })
    )

    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const out = await pb.evaluate(async () => await window.nyx.sync.run())
    assert.equal(out.failed, 0, `★ 删后修改被当成了失败（会永远重试）：${JSON.stringify(out)}`)
    assert.equal(hasLectureUid(rootB, uid), false, '★★ 删后修改让它复活了 —— 删除是他明确按下去的')

    // 而且要说得出来 —— 这一格是唯一需要他知道的
    const findings = await pb.evaluate(
      async () => (await window.nyx.health.audit()).findings.map((f) => f.id)
    )
    assert.ok(
      findings.includes('sync-incomplete'),
      `★ 删后修改被静静丢掉了，体检里一句话都没有：${findings.join('、')}`
    )
  })

  /**
   * ══════════════════════════════════════════════════════════
   * ★★ R-3-e · 「我改主意了」也要跨得过去
   *
   * 完整走一遍：A 删 → B 跳过 → A 恢复 → B 能收 → A 再删 → B 又跳过。
   * 每一步之前都**先断言前提真的成立** —— 不然「B 能收了」可能只是因为
   * 那条账根本没到过 B，那是假绿。
   * ══════════════════════════════════════════════════════════
   */
  it('★★ R-3-e · 删 → 撤销 → 再删，三次都要传到另一台', async () => {
    const TERM = 'bear the brunt of'
    const sync = async (page: Page): Promise<void> => {
      await page.click('[data-testid="nav-settings"]')
      await page.click('[data-testid="set-tab-sync"]')
      await runSync(page)
    }

    // ── ① A 上记一条「我不要这个说法」──────────────────────
    await pa.evaluate(async (term) => {
      const p = await window.nyx.data.createProject('R-3-e 账本')
      const u = await window.nyx.data.createUnit(p, '单元')
      const l = await window.nyx.data.createLecture(u, '一讲')
      const r = await window.nyx.data.addItem(l, term as string, '', 'B', '')
      await window.nyx.study.deleteItem(r.id)
    }, TERM)
    assert.equal(liveLedger(rootA, TERM, 'deleted'), 1, '前提：A 上该有这条账')

    await sync(pa)
    await sync(pb)

    /**
     * ★ 这个前提断言是**必须的**，不是装饰。
     * 后面「B 又能收它了」如果是因为那条账压根没到过 B，
     * 这一整条用例就是假绿 —— 而它验的恰恰是「撤销传过去了」。
     */
    assert.equal(
      liveLedger(rootB, TERM, 'deleted'),
      1,
      '★ 那条「我不要」根本没到过 B —— 后面的断言全都不算数'
    )

    // ── ② A 恢复它 → 撤销 ────────────────────────────────
    await pa.evaluate(async () => {
      const t = await window.nyx.browse.trash()
      const bucket = t.find((b) => b.kind === 'item')!
      await window.nyx.browse.restore('item', bucket.rows[0]!.id)
    })
    assert.equal(liveLedger(rootA, TERM, 'deleted'), 0, 'A 上该撤销了')
    assert.equal(anyLedger(rootA, TERM, 'deleted'), 1, '★★ A 把行删掉了 —— 撤销传不出去')

    await sync(pa)
    await sync(pb)

    assert.equal(
      liveLedger(rootB, TERM, 'deleted'),
      0,
      '★★ 撤销没传到 B —— 他在 B 上重新分析，这条表达还是进不来'
    )
    assert.equal(anyLedger(rootB, TERM, 'deleted'), 1, '★ B 那边行也被删了？')

    // ── ③ A 再删一次 → 撤销要被清回去，并且传过去 ────────
    await pa.evaluate(async (term) => {
      const tree = await window.nyx.data.tree()
      const lec = tree.find((p) => p.name === 'R-3-e 账本')!.units[0]!.lectures[0]!
      const d = await window.nyx.data.lecture(lec.id)
      const it = d.items.find((i) => i.term === (term as string))!
      await window.nyx.study.deleteItem(it.id)
    }, TERM)
    assert.equal(liveLedger(rootA, TERM, 'deleted'), 1, '★ 第二次删除没重新生效（A 侧）')

    await sync(pa)
    await sync(pb)

    assert.equal(
      liveLedger(rootB, TERM, 'deleted'),
      1,
      '★★ 第二次删除没传到 B —— B 上那条表达又会被 AI 收进来'
    )
  })

  /**
   * ★★ R-4-C · 两台真 Electron + 真 HTTP，跨一次「一包装不下」的边界。
   *
   * 前面那些用例在数据层证明了「云端一条不少」，这一条证明的是另一件事：
   * **那些行真的到了 B 的库里**。中间隔着 preload、IPC、真 HTTP、
   * 以及 `applied` / 水位那一整套记账。
   *
   * 用 5001 条（PACK_ROWS + 1）—— 刚好越过边界，跑得也快。
   */
  it('★★ R-4-C · A 有 5001 条一次装不下的行 → 同步几次之后 B 上一条不少', async () => {
    const N = 5001

    // 直接往 A 的库里灌（走界面要点五千次，那不是这条用例要验的东西）
    const seeded = ((): string[] => {
      const db = new DatabaseSync(join(rootA, 'data', 'nyx.db'))
      /**
       * ★ 时间戳要落在 A **当前水位之后**。
       * A 在前面的用例里已经同步过好几次，水位就在「刚才」——
       * 播在过去的行 `updated_at > wm` 不成立，一条都不会被收集，
       * 那样这条用例验的就是「什么都没发生」。
       */
      const base = Date.now() + 1000
      db.exec('begin')
      const ins = db.prepare(
        `insert into picks (scope, scope_id, content, created_at, updated_at)
         values ('lecture', 1, ?, ?, ?)`
      )
      for (let i = 0; i < N; i++) ins.run(`R-4-C 第 ${i} 条`, base + i, base + i)
      db.exec('commit')
      const uids = (
        db.prepare(`select uid from picks where content like 'R-4-C %'`).all() as { uid: string }[]
      ).map((r) => r.uid)
      db.close()
      return uids
    })()
    assert.equal(seeded.length, N, `前提没成立：A 上该有 ${N} 条`)

    // A 推到没得推为止
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    for (let i = 0; i < 6; i++) {
      const note = await runSync(pa)
      if (!/没装下/.test(note)) break
    }

    // B 拉
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    for (let i = 0; i < 6; i++) {
      const note = await runSync(pb)
      assert.doesNotMatch(note, /失败/, `★ B 拉的时候有失败：${note}`)
      if (!/没装下/.test(note)) break
    }

    /**
     * ★ 判据是 **B 库里的 uid 集合**，不是界面上那个数字 ——
     * 「拉下来 N 行」是报出来的数，而报数正是 R-4-E 修过的地方，
     * 拿它当自己的尺子就等于没验。
     */
    const onB = ((): Set<string> => {
      const db = new DatabaseSync(join(rootB, 'data', 'nyx.db'), { readOnly: true })
      const got = new Set(
        (
          db.prepare(`select uid from picks where content like 'R-4-C %'`).all() as {
            uid: string
          }[]
        ).map((r) => r.uid)
      )
      db.close()
      return got
    })()

    const missing = seeded.filter((u) => !onB.has(u))
    assert.equal(
      missing.length,
      0,
      `★★ B 上少了 ${missing.length} 条 —— 一包装不下的那部分没过去（A ${N} · B ${onB.size}）`
    )
    assert.equal(onB.size, N, `★ B 上多出来了：${onB.size}`)
  })

  /**
   * ★★ R-4-F · 两台真 Electron + 真 HTTP：一个冲突不许劫持整条流水线。
   *
   * 数据层那几条证明了「97 条写进了库、8 条上了云」。
   * 这一条证明的是另一件事：**那些行真的到了对面的库里**，
   * 而且冲突提示是他在界面上看得见的。
   */
  it('★★ R-4-F · A/B 各改各的 + 3 条撞车 → 没撞车的照常收敛，撞车的等裁决', async () => {
    // ★ 验的是**裁决机制本身** —— D-438 之后它默认不走，先关掉开关
    //   （同 `tests/db-safety.ts` 的做法；理由见 setAutoResolve 的说明）
    setAutoResolve(rootA, false)
    setAutoResolve(rootB, false)
    const N = 20
    const CLASH = 3

    /** 直接读某台机器库里的 picks 内容 */
    const picksOf = (root: string): Map<string, string> => {
      const db = new DatabaseSync(join(root, 'data', 'nyx.db'), { readOnly: true })
      const out = new Map<string, string>()
      for (const r of db.prepare(`select uid, content from picks`).all() as {
        uid: string
        content: string
      }[]) {
        out.set(r.uid, r.content)
      }
      db.close()
      return out
    }

    /**
     * ★ 时间戳必须落在**两台机器当前水位之上**。
     *
     * 前面那些用例把水位推到过未来（R-4-C 那条灌了 5001 行），
     * 写死 `Date.now()` 会让这些行落在水位之下、根本不算「改过」——
     * 那样这条用例验的就是「什么都没发生」。读真实水位来定。
     */
    const wmOf = (root: string): number => {
      const db = new DatabaseSync(join(root, 'data', 'nyx.db'), { readOnly: true })
      const r = db.prepare(`select value from settings where key = 'sync.watermark'`).get() as
        | { value: string }
        | undefined
      db.close()
      return Number(r?.value ?? '0') || 0
    }
    const above = (): number => Math.max(wmOf(rootA), wmOf(rootB), Date.now()) + 5_000

    // ① A 上造 20 条，推给 B
    const uids = ((): string[] => {
      const db = new DatabaseSync(join(rootA, 'data', 'nyx.db'))
      const base = above()
      db.exec('begin')
      const ins = db.prepare(
        `insert into picks (scope, scope_id, content, created_at, updated_at)
         values ('lecture', 1, ?, ?, ?)`
      )
      for (let i = 0; i < N; i++) ins.run(`F 原始 ${i}`, base + i, base + i)
      db.exec('commit')
      const list = (
        db.prepare(`select uid from picks where content like 'F 原始 %' order by id`).all() as {
          uid: string
        }[]
      ).map((r) => r.uid)
      db.close()
      return list
    })()
    assert.equal(uids.length, N, '前提：A 上该有 20 条')

    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    await runSync(pb)
    assert.equal(picksOf(rootB).size >= N, true, '前提：B 该收到那 20 条')

    // ② 两边各改各的：前 3 条两边都改（撞车），其余 A 改 B 不改
    const stamp = above()
    /**
     * ★ 两边的时间戳**必须不同**。用同一个毫秒的话 `decideRow`
     * 第一句就判成 `same` 直接跳过 —— 那不是冲突，是「两边一模一样」。
     * 差几毫秒才是真的「两边各改各的」。
     */
    for (const [root, tag, off] of [
      [rootA, 'A 改的', 0],
      [rootB, 'B 改的', 7]
    ] as const) {
      const db = new DatabaseSync(join(root, 'data', 'nyx.db'))
      const up = db.prepare(`update picks set content = ?, updated_at = ? where uid = ?`)
      db.exec('begin')
      for (let i = 0; i < (tag === 'A 改的' ? N : CLASH); i++) {
        up.run(`${tag} ${i}`, stamp + off, uids[i]!)
      }
      db.exec('commit')
      db.close()
    }

    // ③ A 推、B 拉
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    await runSync(pa)
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    await runSync(pb)

    // ④ B 上：撞车的 3 条保持 B 自己的，没撞车的 17 条收敛成 A 的
    const onB = picksOf(rootB)
    let converged = 0
    for (let i = CLASH; i < N; i++) {
      if (onB.get(uids[i]!) === `A 改的 ${i}`) converged += 1
    }
    assert.equal(
      converged,
      N - CLASH,
      `★★ 没撞车的 ${N - CLASH} 条被那 3 条挟持了 —— 只收敛了 ${converged} 条`
    )
    for (let i = 0; i < CLASH; i++) {
      assert.equal(
        onB.get(uids[i]!),
        `B 改的 ${i}`,
        `★★ 撞车那一条被静默覆盖了（D-201）：${uids[i]}`
      )
    }

    // ⑤ 界面上要能看见冲突，而且要说清「别的已经同步好了」
    assert.ok(
      await pb.locator('[data-testid="sync-conflict"]').count(),
      '★ 界面上没有冲突提示'
    )
    const text = await pb.innerText('[data-testid="sync-conflict"]')
    assert.match(text, /已经同步了/, `★ 没告诉他「别的已经同步好了」：${text}`)
    assert.match(text, /等你决定/, `★ 没说清在等什么：${text}`)

    // ⑥ 裁决「用云端的」→ 两边收敛
    await pb.click('[data-testid="sync-take-remote"]')
    await pb.waitForTimeout(800)
    const after = picksOf(rootB)
    for (let i = 0; i < CLASH; i++) {
      assert.equal(after.get(uids[i]!), `A 改的 ${i}`, `★ 裁决之后没收敛：${uids[i]}`)
    }
    assert.equal(
      await pb.locator('[data-testid="sync-conflict"]').count(),
      0,
      '★★ 裁决完了冲突提示还挂着'
    )
  })

  /**
   * ══════════════════════════════════════════════════════════
   * ★★ R-4-C-a · 拉的时候一批一批来，超过一批也要一行不少
   *
   * 以前拉这一侧把**所有**包的行堆进一个数组再统一处理 ——
   * 新设备第一次同步等于把云端全部历史一次性读进内存。
   *
   * 这一条是真的两台 Electron + 真 HTTP：A 上「加一条 → 推一次」重复 30 次，
   * 云端就真的有 30 个包（一批装 25 个，**必须**分两批），
   * 然后看 B 收全了没有。判据是**直接比两边库里的 uid 集合** ——
   * 不看 `applied`、不看 `pushed`、不看界面那句话，那正是 R-4-E 修过的地方。
   * ══════════════════════════════════════════════════════════
   */
  it('★★ R-4-C-a · A 推出 30 个包（超过一批）→ B 全收到，uid 一条不差', async () => {
    const PACKS = 30
    const chunkCount = (): number =>
      filesSeen().filter((k) => k.includes('/nyx/chunks/')).length

    /**
     * ★★ 先把 A 那边的同步状态铺干净，**并且断言它真的干净了**。
     *
     * 两件事要先处理掉，都是前面几条用例留下的：
     *   · 待裁决的冲突 —— 有它在，A 的水位是冻着的（R-4-F），
     *     每一次推都把全部历史重推一遍
     *   · **水位停在未来** —— R-4-C 那条故意把行的时间戳播在水位之后，
     *     一次装不下时水位就落在那个未来的时刻上。那之后新加的东西
     *     **一出生就在水位之下，永远不会被收集**
     *
     * 第二件事真的把这条用例弄红过一次，而且红在「B 少了第 0 条」上 ——
     * 看着像分批漏了行，其实是夹具没铺干净。所以这里不光铺，还要**断言**。
     */
    await pa.evaluate(async () => {
      for (let i = 0; i < 3; i++) await window.nyx.sync.run('local')
    })
    const wmA = syncWatermark(rootA)
    assert.ok(
      wmA <= Date.now(),
      `前提没成立：A 的水位停在未来（${wmA}），接下来加的东西一出生就在水位之下`
    )
    const before = chunkCount()

    // ── ① A 上「加一条 → 推一次」重复 30 次 ────────────────
    const madeA = await pa.evaluate(async (n) => {
      const terms: string[] = []
      for (let i = 0; i < n; i++) {
        const r = await window.nyx.data.addChunks(1, `分批 ${i}`, `batched phrase number ${i}`)
        for (const a of r.added) terms.push(a.term)
        const out = await window.nyx.sync.run()
        if (i < 3) console.log('CYCLE', i, JSON.stringify({ added: r.added, pushed: out.pushed, wm: out.wm, left: out.leftOver, at: Date.now() }))
      }
      return terms
    }, PACKS)
    assert.equal(madeA.length, PACKS, `前提没成立：A 上只加进去 ${madeA.length} 条`)
    assert.equal(
      chunkCount() - before,
      PACKS,
      `★ 云端只多了 ${chunkCount() - before} 个包 —— 这条用例要的就是「超过一批」`
    )

    // ── ② B 拉一次 ────────────────────────────────────────
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    const out = await pb.evaluate(async () => await window.nyx.sync.run())
    assert.equal(out.failed, 0, `★ 拉的时候有行失败了：${JSON.stringify(out)}`)
    assert.ok(
      (out.batches ?? 0) >= 2,
      `★★ 30 个包却只跑了 ${out.batches} 批 —— 分批没生效，全部历史又一次性进内存了`
    )
    /**
     * ★★ 内存判据的现场版：**任何一批装的行都少于这一趟收到的总行数**。
     * 相等就说明还是一次性聚成了一个数组 —— 那个数组才是内存峰值。
     */
    assert.ok(
      (out.maxBatchRows ?? 0) < out.received,
      `★★ 单批装了 ${out.maxBatchRows} 行 = 这一趟全部 ${out.received} 行，根本没分批`
    )

    // ── ③ 判据：直接比两边库里的 uid 集合 ──────────────────
    const onA = batchItemUids(rootA)
    const onB = batchItemUids(rootB)
    assert.equal(onA.length, PACKS, `前提：A 库里该有 ${PACKS} 条，实际 ${onA.length}`)
    assert.deepEqual(onB, onA, `★★ 分批之后 B 少了行：A ${onA.length} 条 · B ${onB.length} 条`)

    // ── ④ 再推 2 个包，走他真正点的那条路（按钮）再来一次 ──
    await pa.evaluate(async () => {
      for (let i = 0; i < 2; i++) {
        await window.nyx.data.addChunks(1, `分批尾 ${i}`, `batched phrase tail ${i}`)
        await window.nyx.sync.run()
      }
    })
    const note = await runSync(pb)
    assert.doesNotMatch(note, /失败/, `★ 他点的那条路上报了失败：${note}`)
    assert.equal(
      batchItemUids(rootB).length,
      PACKS + 2,
      `★★ 按钮点完之后还是不全：${batchItemUids(rootB).length} 条`
    )

    /**
     * ── ⑤ 再同步一次：重放不许多出东西也不许少东西 ──────────
     *
     * 这里**不**断言「一个包都不再读」。这台 B 身上还挂着前面用例留下的
     * 未裁决冲突，那些包按 R-4-F 的规矩本来就不该进 `applied`、本来就该重读。
     * 「一个包都不再读」那一档在 `db-safety` 的 ⑮ 里验（那边的夹具是干净的）。
     * 这里验的是它的**后果**：重放一遍，库里的东西一个不多、一个不少。
     */
    const settled = batchItemUids(rootB)
    const again = await pb.evaluate(async () => await window.nyx.sync.run())
    assert.equal(again.failed, 0, `★ 重放时有行失败了：${JSON.stringify(again)}`)
    assert.deepEqual(batchItemUids(rootB), settled, '★★ 重放一遍之后 B 上的东西变了')
  })

  /**
   * ══════════════════════════════════════════════════════════
   * ★★ 同一行出现在好几个包里 → 设置页当场崩掉（R-4-C-a 撞出来的真 bug）
   *
   * 「同一行躺在好几个包里」是再正常不过的形状：对面每改一次就推一个包。
   * 而冲突 / 失败是**按包记一条**的，于是同一条记了 3 次；
   * 设置页那份清单的 key 是 `p.what` —— 重复 key，Svelte 直接抛
   * `each_key_duplicate`，**整页变成「这一页出错了」**。
   *
   * 不是样式错乱：他一点设置就什么都做不了，而且同步得越多越必然。
   * 这一条走的就是他手指那条路 —— 点按钮、看页面还在不在。
   * ══════════════════════════════════════════════════════════
   */
  it('★★ 同一行在 3 个包里都冲突 → 设置页不许崩，那一行只报一次', async () => {
    // ★ 验的是**裁决机制本身** —— D-438 之后它默认不走，先关掉开关
    //   （同 `tests/db-safety.ts` 的做法；理由见 setAutoResolve 的说明）
    setAutoResolve(rootA, false)
    setAutoResolve(rootB, false)
    // ① B 上先改这一讲（改完**不同步**，它就是「本地改过」的那一边）
    await pb.evaluate(async () => {
      await window.nyx.data.rename('lecture', 1, 'B 改的名字')
    })

    // ② A 改同一讲三次，每次推一个包 → 三个包里都有这一行
    await pa.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        await window.nyx.data.rename('lecture', 1, `A 改的名字 ${i}`)
        await window.nyx.sync.run()
      }
    })

    // ③ B 点「现在同步」—— 崩掉的话这一句会直接超时（按钮跟着整页没了）
    await pb.click('[data-testid="nav-settings"]')
    await pb.click('[data-testid="set-tab-sync"]')
    await runSync(pb)

    assert.equal(
      await pb.locator('[data-testid="sync-run"]').count(),
      1,
      '★★ 设置页崩了 —— 同一行在多个包里各记了一条，清单 key 撞车'
    )
    assert.doesNotMatch(
      await pb.innerText('body'),
      /这一页出错了/,
      '★★ 整页挂了：他一点设置就什么都做不了'
    )

    // ④ 那一行只许报一次 —— 重复的话前 5 条会被同一句话占满
    const lines = await pb.evaluate(() =>
      (window.nyx as unknown as { sync: { status: () => Promise<{ problems: { what: string }[] }> } })
        .sync.status()
        .then((s) => s.problems.map((p) => p.what))
    )
    /**
     * ★ 先确认**真的有冲突**。
     *
     * 没有的话上面那句「没有重复」是空的 —— 一份空清单当然不重复，
     * 那是一条假绿。这一条的前提就是「同一行在三个包里都撞了」。
     */
    assert.ok(lines.length >= 1, '★ 一处冲突都没有 —— 这一条什么都没验到')
    assert.equal(
      new Set(lines).size,
      lines.length,
      `★★ 同一行报了好几遍：${lines.join('、')}`
    )

    // 收尾：把这条冲突裁掉，别留给后面的用例
    await runSync(pb, 'sync-take-remote')
  })

  /**
   * ══════════════════════════════════════════════════════════
   * ★★ R-4-F-a · 「用本地的」这个决定要跨机器、跨重放地活着
   *
   * 两台真 Electron + 真 HTTP，走完整生命周期：
   *
   *   A / B 都改同一条 → A 上冲突 → A 点「用本地的」→ 裁决落库
   *   → 同步 → B 拿到裁决 → 清空 applied 模拟老包重读
   *   → 被拒的那一版又出现 → **不许覆盖 A 的决定**
   *   → B 再改一次 → 时间戳越过 rejected_up_to → **重新变成冲突**
   *
   * 判据全部**直接查两边的库**（讲名、时间戳、裁决行），
   * 不看 `applied` / `pushed` / 界面那句话 —— 那正是 R-4-E 修过的地方。
   * ══════════════════════════════════════════════════════════
   */
  it('★★ R-4-F-a · 全生命周期：裁决落库 → 传到 B → 老包重放不翻案 → 新改动重新问', async () => {
    // ★ 验的是**裁决机制本身** —— D-438 之后它默认不走，先关掉开关
    //   （同 `tests/db-safety.ts` 的做法；理由见 setAutoResolve 的说明）
    setAutoResolve(rootA, false)
    setAutoResolve(rootB, false)
    const uid = lectureUid(rootA, 1)
    const settle = async (page: Page): Promise<string> => {
      await page.click('[data-testid="nav-settings"]')
      await page.click('[data-testid="set-tab-sync"]')
      return runSync(page)
    }
    // ★ 同上：这一条走的是**手动裁决**那条路（D-438 之后默认不问人），
    //   所以两台都把自动裁决关掉。两条路各有覆盖，见 setAutoResolve 的说明。
    setAutoResolve(rootA, false)
    setAutoResolve(rootB, false)
    // 先把两边铺平：都同步到没有待决冲突为止
    await settle(pa)
    await settle(pb)

    // ── ① 两边各改各的（都先不同步）────────────────────────
    await pb.evaluate(async () => {
      await window.nyx.data.rename('lecture', 1, 'B 起的名字')
    })
    await pb.waitForTimeout(5) // 两次改动落在不同毫秒（R-3-c）
    await pa.evaluate(async () => {
      await window.nyx.data.rename('lecture', 1, 'A 起的名字')
    })

    // ── ② B 先推上去，A 再同步 → A 这边冲突 ────────────────
    await settle(pb)
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    const note = await runSync(pa)
    assert.match(note, /两边都改过/, `★ A 这边没认出冲突：${note}`)
    assert.equal(lectureName(rootA, 1), 'A 起的名字', '★ 没裁决就动了库')
    const rejected = lectureAt(rootB, 1)
    /**
     * ★ 这一套用例共用同两台机器，前面几条可能已经在这一讲上裁决过
     * （R-4-C-a 那条的铺垫就按过「用本地的」）。所以判据是**相对**的：
     * 按之前是多少、按之后必须推进到 max —— 而不是「按之前必须没有」。
     * 写成绝对值的话，红的是夹具，不是被验的东西。
     */
    const prior = resolutionOf(rootA, uid)?.upTo ?? 0
    assert.ok(prior < rejected, `前提：老裁决该挡不住 B 这一版（${prior} / ${rejected}）`)

    // ── ③ A 点「用本地的」（他手指那条路）─────────────────
    await runSync(pa, 'sync-keep-local')
    const res = resolutionOf(rootA, uid)
    assert.ok(res, '★★ 他按了「用本地的」，裁决却没落库')
    assert.equal(res.uid, `resolutions-${uid}`, `★ 裁决身份不是算出来的：${res.uid}`)
    assert.equal(
      res.upTo,
      Math.max(prior, rejected),
      `★ 拒绝到哪一刻不对：${res.upTo} / ${rejected}`
    )
    assert.ok(
      lectureAt(rootA, 1) > rejected,
      `★★ D5 没顶：本地 ${lectureAt(rootA, 1)} 仍不晚于被拒的 ${rejected}`
    )
    assert.equal(lectureName(rootA, 1), 'A 起的名字', '★ 裁决顺手改了内容')

    // ── ④ B 同步 → 裁决和结果都要过去（⑫）──────────────────
    await settle(pb)
    assert.equal(
      lectureName(rootB, 1),
      'A 起的名字',
      `★★ A 的决定没传到 B —— B 上还是「${lectureName(rootB, 1)}」`
    )
    const onB = resolutionOf(rootB, uid)
    assert.ok(onB, '★★ 裁决本身没同步过去 —— B 下次重读老包就会翻案')
    assert.equal(onB.upTo, res.upTo, `★ B 上那条裁决的时刻不对：${onB.upTo} / ${res.upTo}`)

    // ── ⑤ B 重读老包（applied 溢出的提前版）→ 不许翻案（⑬）──
    clearApplied(rootB)
    const replay = await pb.evaluate(async () => await window.nyx.sync.run())
    assert.ok(
      replay.received >= 1,
      `★ 老包压根没被重读，下面那句是假绿：${JSON.stringify(replay)}`
    )
    assert.equal(replay.conflicted, 0, `★ 又问了 B 一遍同一个问题：${JSON.stringify(replay)}`)
    assert.equal(
      lectureName(rootB, 1),
      'A 起的名字',
      `★★ 老包重放把 A 的决定推翻了 —— B 上变回了「${lectureName(rootB, 1)}」`
    )

    // ── ⑥ B 再改一次 → 那是新的分歧，必须重新问（⑭）────────
    await pb.evaluate(async () => {
      await window.nyx.data.rename('lecture', 1, 'B 后来又改的')
    })
    await settle(pb)
    await pa.click('[data-testid="nav-settings"]')
    await pa.click('[data-testid="set-tab-sync"]')
    const again = await runSync(pa)
    assert.match(again, /两边都改过/, `★★ B 之后的新改动被那条裁决无声吞掉了：${again}`)
    assert.ok(
      await pa.locator('[data-testid="sync-conflict"]').count(),
      '★★ 界面上没有再问他 —— 那条裁决把新的分歧也一起吞了'
    )

    // ── ⑦ 再选一次「用本地的」→ rejected_up_to 往前走（⑮）──
    await runSync(pa, 'sync-keep-local')
    const moved = resolutionOf(rootA, uid)
    assert.ok(moved && moved.upTo > res.upTo, `★★ 裁决没有前进：${moved?.upTo} / ${res.upTo}`)
    assert.equal(lectureName(rootA, 1), 'A 起的名字', '★ 第二次裁决没守住本地那版')

    // 收尾：让 B 收敛，别把冲突留给后面的用例
    await settle(pb)
    assert.equal(lectureName(rootB, 1), 'A 起的名字', '★ 第二次裁决之后 B 没收敛')
  })

  it('★★ Step 7D · 真 Electron 里注入时间源：环境变量真的走到了同步的 startedAt', async () => {
    /**
     * ★★ 这一条补的是 7D 唯一一段没被验过的链路。
     *
     * I 层已经证明「时间源 → 同步的包名与包头」是通的，但 I 层是在
     * **同一个进程里**直接 `installClock`。S 层多一段：
     *
     *     环境变量 → Electron 主进程启动时 `makeClock` → `Sync`
     *
     * 中间隔着一次进程启动。而 CLAUDE.md 第九节说的正是这种事：
     * 「我改的这份，怎么到他手上？中间隔着几层？」——
     * 隔着的那一层不验，就等于没验。
     *
     * ★ 用**新起的第三个实例**，不碰 A / B：注入是按进程走的，
     *   所以它天然不会污染同一套件里别的用例（并行隔离是免费得到的）。
     */
    const FIXED = 1_600_000_000_000
    const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-clock-'))
    const [app, page] = await launch(dataRoot, { NYX_TEST_CLOCK: `fixed:${FIXED}` })
    try {
      await configure(page)
      await runSync(page)

      /**
       * ★ 读设备心跳而不是变更包。
       *
       *   一台**全新**的机器只有出厂内容（`updated_at = 0` = PRISTINE），
       *   按协议它不是本地待推变更 —— 所以这一趟一个变更包都不会推。
       *   而设备心跳那一次 PUT 是无条件的，它的 `at` 就是 `startedAt`，
       *   同样能证明时间源走到了真 Electron 里，而且不用先造数据。
       */
      const beacons = filesSeen().filter((k) => k.includes('/nyx/devices/'))
      assert.ok(beacons.length > 0, '一个设备心跳都没推上去，验不到时间源')
      const ats = beacons.map((k) => (JSON.parse(files.get(k)!) as { at: number }).at)
      assert.ok(
        ats.includes(FIXED),
        '★★ 环境变量没走到真 Electron 里 —— 心跳里的时刻是 ' +
          ats.join('、') +
          '，没有一个是注入的 ' + FIXED +
          '。那么 S 层就造不出时钟偏移 / 回拨 / 未来戳'
      )
    } finally {
      await app.close()
      keepOrClean(dataRoot)
    }
  })

  // ══════════════════════════════════════════════════════════
  // ★★ Step 7 · S 层 · 两个真 Electron + 真 HTTP + 真同步按钮
  //
  // I 层（db-safety）是「同一进程里两个库 + 真 HTTP」。
  // S 层多的是**两个真进程**和**真的那条 IPC 路径** —— 他手指按下去的那一层。
  //
  // ── 每一步哪个是真的 ────────────────────────────────────
  //
  //   共同基础    **真 UI**：首页 → 开始 → 贴原文 → 提交
  //   同步动作    **真 UI 按钮** `sync-run` → 真 IPC → 真 Sync → 真 HTTP
  //   云端        **真 HTTP**（进程内 WebDAV：PROPFIND / MKCOL / PUT / GET）
  //   收敛判据    与 I 层**同一份** Oracle（`tests/convergence.ts`）
  //   离线改动    直接写库 —— 那正是他离线时软件在做的事
  //
  // ── 夹具踩过的三层，全部写在这里 ────────────────────────
  //
  //   ① 蹭上文那对 Electron → 它们跑过二十多条用例，留下 5001 行只推一半、
  //      被删的出厂题型、被人为拨过的水位。「已同步的共同基础」立不住
  //   ② 共用同一个 WebDAV 桶 → 新起的一对会把上文所有包全拉下来
  //   ③ 造完材料页面已经不在设置页 → `runSync` 找不到那个按钮
  //
  //   所以：**每条用例一对全新的 Electron + 一个全新的桶**，
  //   而且同步这个动作**自己保证前置导航**。
  // ══════════════════════════════════════════════════════════

  /** 关掉一对 S 层机器并清掉它们的磁盘 */
  const sClose = async (p: SPair): Promise<void> => {
    await p.appA.close()
    await p.appB.close()
    for (const d of [p.rootA, p.rootB]) rmSync(d, { recursive: true, force: true })
  }

  interface SPair {
    appA: ElectronApplication
    appB: ElectronApplication
    pageA: Page
    pageB: Page
    rootA: string
    rootB: string
    devs: ConvergenceDevice[]
  }

  /**
   * ★★ 同步这个动作**自己保证前置导航**。
   *
   * 造完材料之后页面停在讲次工作台，`sync-run` 那颗按钮根本不在视图里 ——
   * 第一版就是这么超时的。让每一次同步先把自己导航到同步入口，
   * 以后所有 S 场景都不会再踩这一脚。
   *
   * ★ 只动测试助手，**不碰 renderer / IPC / 产品代码**。
   */
  const sSync = async (page: Page): Promise<string> => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-sync"]')
    await page.waitForSelector('[data-testid="sync-run"]')
    return runSync(page)
  }

  /**
   * 体检里和**时钟**有关的那几句。
   * ★ 只挑这一类：别的问题（冲突、没对过账……）不该让 I-178 那两条红 ——
   *   一条会被无关变化拖红的用例，用不了几次就会被人当噪音忽略掉。
   */
  const clockNotes = async (page: Page): Promise<string[]> =>
    (
      await page.evaluate(async () =>
        (await window.nyx.sync.status()).problems.map((x) => x.message)
      )
    ).filter((m) => /时钟/.test(m))

  /** 起一对全新的机器，用**自己的桶**，并用真 UI 建立共同基础 */
  const newSPair = async (bucket: string): Promise<SPair> => {
    const rootA = mkdtempSync(join(tmpdir(), 'nyx-sA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'nyx-sB-'))
    const [appA, pageA] = await launch(rootA)
    const [appB, pageB] = await launch(rootB)
    for (const pg of [pageA, pageB]) {
      await pg.click('[data-testid="nav-settings"]')
      await pg.click('[data-testid="set-tab-sync"]')
      await pg.click('[data-testid="sync-webdav"]')
      await pg.fill('[data-testid="sync-url"]', `http://127.0.0.1:${port}/${bucket}`)
      await pg.fill('[data-testid="sync-user"]', 'me')
      await pg.fill('[data-testid="sync-secret"]', 'app-password')
      await pg.click('[data-testid="sync-save"]')
      await pg.waitForSelector('[data-testid="sync-note"]')
    }

    /** ★ 共同基础用**真 UI** 造 —— S 层与 I 层唯一真正不同的那一段 */
    await pageA.click('[data-testid="nav-home"]')
    await pageA.click('[data-testid="home-start-btn"]')
    await pageA.waitForSelector('[data-testid="drop-original"]')
    await pageA.click('[data-testid="drop-original"] button')
    await pageA.fill('[data-testid="compose-title"]', 'S 层共同基础')
    await pageA.fill('[data-testid="compose-text"]', 'Shared baseline for S-tier convergence.')
    await pageA.click('[data-testid="compose-submit"]')
    await pageA.waitForSelector('[data-testid="matbar"]')

    const mk = (name: string, page: Page, root: string): ConvergenceDevice => ({
      name,
      sync: async () => {
        await sSync(page)
      },
      snapshot: () => {
        const db = new DatabaseSync(join(root, 'data', 'nyx.db'), { readOnly: true })
        try {
          return snapshot(name, db as unknown as DbLike, join(root, 'data', 'audio'))
        } finally {
          db.close()
        }
      }
    })
    const devs = [mk('A', pageA, rootA), mk('B', pageB, rootB)]

    // A 推、B 拉、A 再拉 —— 到这里两台才真的在同一个共同基上
    await sSync(pageA)
    await sSync(pageB)
    await sSync(pageA)
    return { appA, appB, pageA, pageB, rootA, rootB, devs }
  }

  const sWrite = (root: string, fn: (db: DatabaseSync) => void): void => {
    const db = new DatabaseSync(join(root, 'data', 'nyx.db'))
    try {
      fn(db)
    } finally {
      db.close()
    }
  }
  /** 多行版 —— 断言失败时把账本摊开给人看，省得再跑一趟才知道里面有什么 */
  const sReadAll = <T>(root: string, sql: string, ...p: unknown[]): T[] => {
    const db = new DatabaseSync(join(root, 'data', 'nyx.db'), { readOnly: true })
    try {
      return db.prepare(sql).all(...(p as never[])) as T[]
    } finally {
      db.close()
    }
  }
  const sRead = <T>(root: string, sql: string, ...p: unknown[]): T | undefined => {
    const db = new DatabaseSync(join(root, 'data', 'nyx.db'), { readOnly: true })
    try {
      return db.prepare(sql).get(...(p as never[])) as T | undefined
    } finally {
      db.close()
    }
  }

  /** 跑到不动点 → Oracle → 再同步一轮 → 再 Oracle */
  /**
   * ★★ 在测试进程里**模拟产品那条硬删路径**（`hardDelete`）。
   *
   * 两件事一件都不能少，少了就会造出产品在真删时不会有的东西：
   *   ① **先删子行再删父** —— 裸 `delete from lectures` 会撞外键。
   *      子表是按 `pragma foreign_key_list` 问出来的，不写死清单。
   *      ★ **不是关掉外键**：关掉会留下业务孤儿，而孤儿正是 Oracle 要抓的，
   *        那样等于自己把判据废了。
   *   ② **连基状态一起带走** —— `hardDelete` 就是这么做的（G1）。
   *      少这一步会留下孤儿基状态，而那是产品真删时不会留的
   *      （实测漏过 materials / lecture_logs 两条）。
   */
  const sCascadeDelete = (db: DatabaseSync, lectureId: number): void => {
    const tables = (
      db.prepare(`select name from sqlite_master where type='table'`).all() as { name: string }[]
    ).map((t) => t.name)
    for (const name of tables) {
      const fk = (
        db.prepare(`pragma foreign_key_list("${name}")`).all() as { from: string; table: string }[]
      ).find((f) => f.table === 'lectures')
      if (!fk) continue
      const hasUid = (
        db.prepare(`pragma table_info("${name}")`).all() as { name: string }[]
      ).some((c) => c.name === 'uid')
      const gone = !hasUid
        ? []
        : (db.prepare(`select uid from "${name}" where "${fk.from}" = ?`).all(lectureId) as {
            uid: string | null
          }[])
            .map((r) => r.uid)
            .filter((u): u is string => typeof u === 'string')
      db.prepare(`delete from "${name}" where "${fk.from}" = ?`).run(lectureId)
      for (const u of gone) {
        db.prepare(`delete from row_sync_state where table_name = ? and uid = ?`).run(name, u)
      }
    }
    const lecUid = (
      db.prepare(`select uid from lectures where id = ?`).get(lectureId) as { uid: string } | undefined
    )?.uid
    db.prepare(`delete from lectures where id = ?`).run(lectureId)
    if (lecUid) {
      db.prepare(`delete from row_sync_state where table_name = 'lectures' and uid = ?`).run(lecUid)
    }
  }

  /** 只拍一张快照（不需要整台设备时用它） */
  const sDevSnapshotOf = (root: string): ReturnType<typeof snapshot> | null => {
    const db = new DatabaseSync(join(root, 'data', 'nyx.db'), { readOnly: true })
    try {
      return snapshot('x', db as unknown as DbLike, join(root, 'data', 'audio'))
    } finally {
      db.close()
    }
  }

  const sConverge = async (p: SPair, id: string, max = 8): Promise<number> => {
    const out = await runUntilFixedPoint(p.devs, { maxRounds: max })
    assert.equal(
      out.problems.length,
      0,
      `★★ ${id} 没有收敛：\n  ${out.problems.slice(0, 8).join('\n  ')}\n  ${out.trace.join('\n  ')}`
    )
    return out.rounds
  }

  it('★★ S1 · #1 两台离线各建 100 条 → 都在，谁也没盖掉谁', async () => {
    const p = await newSPair('nyx-s1')
    try {
      await sConverge(p, 'S1 前提')
      const lec = sRead<{ id: number }>(p.rootA, `select id from lectures limit 1`)
      assert.ok(lec, '前提没成立：真 UI 没造出讲')

      for (const [tag, root] of [
        ['SA', p.rootA],
        ['SB', p.rootB]
      ] as const) {
        sWrite(root, (db) => {
          const lid = (db.prepare(`select id from lectures limit 1`).get() as { id: number }).id
          const ins = db.prepare(
            `insert into picks (scope, scope_id, content, uid, created_at, updated_at)
               values ('lecture', ?, ?, ?, ?, ?)`
          )
          const t = Date.now()
          for (let i = 0; i < 100; i++) {
            ins.run(lid, `${tag} 第 ${i} 条`, `picks-${tag}-${i}`, t + i, t + i)
          }
        })
      }

      const rounds = await sConverge(p, 'S1')
      for (const [who, root] of [
        ['A', p.rootA],
        ['B', p.rootB]
      ] as const) {
        const n = sRead<{ n: number }>(root, `select count(*) as n from picks`)!.n
        assert.equal(n, 200, `★★ ${who} 上是 ${n} 条，该是 200 —— 有一边的离线改动被吃掉了`)
        const dup = sRead<{ n: number }>(
          root,
          `select count(*) as n from (select uid from picks group by uid having count(*) > 1)`
        )!.n
        assert.equal(dup, 0, `★★ ${who} 上有重复 uid`)
      }
      console.log(`    S1 收敛 ${rounds} 轮 · 真按钮 · 真 HTTP · 200 条无重复无覆盖`)
    } finally {
      await sClose(p)
    }
  })

  it('★★ S2 · #3 共同基 V1 → A=V2 / B=V3 → 冲突，不静默覆盖', async () => {
    const p = await newSPair('nyx-s2')
    try {
      await sConverge(p, 'S2 前提')
      // ★ 同上：这一条验的是裁决机制，先关掉 D-438 的自动裁决
      setAutoResolve(p.rootA, false)
      setAutoResolve(p.rootB, false)
      const lec = sRead<{ uid: string; updated_at: number }>(
        p.rootA,
        `select uid, updated_at from lectures limit 1`
      )!
      const onB = sRead<{ updated_at: number }>(
        p.rootB,
        `select updated_at from lectures where uid = ?`,
        lec.uid
      )
      assert.ok(onB, '前提没成立：B 上没有那一讲')
      assert.equal(onB.updated_at, lec.updated_at, '前提没成立：两台不在同一版本上（没有共同基）')

      const t = Date.now()
      sWrite(p.rootA, (db) => {
        db.prepare(`update lectures set name = 'A 的 V2', updated_at = ? where uid = ?`).run(t + 1000, lec.uid)
      })
      sWrite(p.rootB, (db) => {
        db.prepare(`update lectures set name = 'B 的 V3', updated_at = ? where uid = ?`).run(t + 2000, lec.uid)
      })

      await sSync(p.pageA) // 真按钮
      const note = await sSync(p.pageB) // 真按钮
      assert.match(note, /两边都改过|等你决定|用哪边/, `★★ B 没有停下来问：${note}`)
      assert.equal(
        sRead<{ name: string }>(p.rootB, `select name from lectures where uid = ?`, lec.uid)!.name,
        'B 的 V3',
        '★★ 没裁决就动了库（静默覆盖）'
      )
      const probs = convergenceProblems(p.devs[0]!.snapshot(), p.devs[1]!.snapshot())
      assert.ok(probs.length > 0, '★★ 冲突还挂着，Oracle 却说已经收敛了')
      console.log(`    S2 冲突挂起 · 库一个字没动 · Oracle 报出 ${probs.length} 处不一致`)
    } finally {
      await sClose(p)
    }
  })

  it('★★ S4 · #5 两台离线都删同一个 → 一块碑、purged_at 取更早（F-1/F-2 的 S 回归）', async () => {
    const p = await newSPair('nyx-s4')
    try {
      await sConverge(p, 'S4 前提')
      const lec = sRead<{ id: number; uid: string }>(
        p.rootA,
        `select id, uid from lectures order by id desc limit 1`
      )!
      const onB = sRead<{ id: number }>(p.rootB, `select id from lectures where uid = ?`, lec.uid)
      assert.ok(onB, '前提没成立：B 上没有那一讲')

      const early = Date.now() - 5000
      const late = Date.now()
      for (const [root, id, at] of [
        [p.rootA, lec.id, early],
        [p.rootB, onB.id, late]
      ] as const) {
        sWrite(root, (db) => {
          db.prepare(
            `insert into tombstones (target_uid, kind, target_id, purged_at, created_at, updated_at)
               values (?, 'lectures', ?, ?, ?, ?)`
          ).run(lec.uid, id, at, at, at)
          sCascadeDelete(db, id)
        })
      }

      const rounds = await sConverge(p, 'S4')
      const purged: number[] = []
      for (const [who, root] of [
        ['A', p.rootA],
        ['B', p.rootB]
      ] as const) {
        const n = sRead<{ n: number }>(
          root,
          `select count(*) as n from tombstones where target_uid = ?`,
          lec.uid
        )!.n
        assert.equal(n, 1, `★★ ${who} 上同一个对象长出了 ${n} 块碑`)
        purged.push(
          sRead<{ p: number }>(root, `select purged_at as p from tombstones where target_uid = ?`, lec.uid)!.p
        )
        assert.equal(
          sRead<{ n: number }>(root, `select count(*) as n from lectures where uid = ?`, lec.uid)!.n,
          0,
          `★★ ${who} 上那一讲还在`
        )
      }
      assert.equal(purged[0], purged[1], `★★ 两台 purged_at 不一致：${purged.join(' / ')}`)
      assert.equal(purged[0], early, `★★ purged_at 没收敛到更早那一刻：${purged[0]} ≠ ${early}`)
      console.log(`    S4 收敛 ${rounds} 轮 · 一块碑 · purged_at 两台一致且取更早 = ${purged[0]}`)
    } finally {
      await sClose(p)
    }
  })

  /**
   * ★★ 裁决也走**真按钮**（`sync-keep-local` / `sync-take-remote`）。
   *
   * 绝不用 `sync.run('local')` 那条内部入口 —— 那样验的是「函数收不收得下
   * 这个参数」，不是「他按下去会发生什么」。S 层的全部意义就在这一层。
   */
  const sResolve = async (page: Page, which: 'local' | 'remote'): Promise<string> => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-sync"]')
    const btn = which === 'local' ? 'sync-keep-local' : 'sync-take-remote'
    await page.waitForSelector(`[data-testid="${btn}"]`)
    return runSync(page, btn)
  }

  /** 这台机器上某张表的孤儿基状态（`row_sync_state` 有、业务表没有） */
  const sOrphanState = (root: string): string[] =>
    (sDevSnapshotOf(root) ?? { local: { orphanState: [] } }).local.orphanState

  it('★★ S3 · #4 A 改 / B 删 → 碑赢，收到的碑不被当成本地新改动（F-2 的 S 回归）', async () => {
    const p = await newSPair('nyx-s3')
    try {
      await sConverge(p, 'S3 前提')
      const lec = sRead<{ id: number; uid: string }>(
        p.rootA,
        `select id, uid from lectures order by id desc limit 1`
      )!
      const onB = sRead<{ id: number }>(p.rootB, `select id from lectures where uid = ?`, lec.uid)!

      /** A 改名（离线）；B 彻底删掉它（离线） */
      sWrite(p.rootA, (db) => {
        db.prepare(`update lectures set name = 'A 改过的', updated_at = ? where id = ?`).run(
          Date.now() + 1000,
          lec.id
        )
      })
      const purgedOnB = Date.now()
      sWrite(p.rootB, (db) => {
        db.prepare(
          `insert into tombstones (target_uid, kind, target_id, purged_at, created_at, updated_at)
             values (?, 'lectures', ?, ?, ?, ?)`
        ).run(lec.uid, onB.id, purgedOnB, purgedOnB, purgedOnB)
        sCascadeDelete(db, onB.id)
      })

      /** ── 中间态：B 先推，A 收到那块碑 ────────────────────── */
      await sSync(p.pageB)
      await sSync(p.pageA)

      const tombOnA = sRead<{ p: number; u: number }>(
        p.rootA,
        `select purged_at as p, updated_at as u from tombstones where target_uid = ?`,
        lec.uid
      )
      assert.ok(tombOnA, '★★ A 没收到那块碑')
      /**
       * ★★ F-2 的正题：A 收到的碑**不许**被本机时间重新盖过。
       *   盖了就等于「我这边又改了它」，那一行会变成待推再推回去 ——
       *   一个纯粹由「应用」这个动作制造出来的往返。
       */
      assert.equal(
        tombOnA.p,
        purgedOnB,
        `★★ A 把收到的碑重新盖了 purged_at：${tombOnA.p} ≠ 收到的 ${purgedOnB}（F-2 复发）`
      )
      const pendA = sDevSnapshotOf(p.rootA)!.local.pending.filter((x) => x.startsWith('tombstones|'))
      assert.equal(
        pendA.length,
        0,
        `★★ 收到的碑变成了待推（phantom pending）：${pendA.join('、')}`
      )

      const rounds = await sConverge(p, 'S3')
      for (const [who, root] of [
        ['A', p.rootA],
        ['B', p.rootB]
      ] as const) {
        assert.equal(
          sRead<{ n: number }>(root, `select count(*) as n from lectures where uid = ?`, lec.uid)!.n,
          0,
          `★★ ${who} 上那一讲还在 —— 碑没赢`
        )
      }
      console.log(`    S3 收敛 ${rounds} 轮 · 碑赢 · 收到的碑没被重新盖时间戳 · 无 phantom pending`)
    } finally {
      await sClose(p)
    }
  })

  it('★★ S5 · #6 A 删父 / B 在父下建子 → 子被挡住，不留业务孤儿', async () => {
    const p = await newSPair('nyx-s5')
    try {
      await sConverge(p, 'S5 前提')
      const lec = sRead<{ id: number; uid: string }>(
        p.rootA,
        `select id, uid from lectures order by id desc limit 1`
      )!
      const onB = sRead<{ id: number }>(p.rootB, `select id from lectures where uid = ?`, lec.uid)!

      /**
       * ★ 子行选**有外键的** `occurrences`，不选 `picks`。
       *
       *   `picks` 是唯一一张没有外键的派生表（它用 scope/scope_id，不是 FK），
       *   父碑挡不住它 —— 那是代码里早就记着的 **R-4-C-a-1**，
       *   `main/sync/index.ts` 有整段说明，明确「本轮不处理」。
       *   拿它来验「父删子增」等于在验一个已知不成立的东西。
       *   要验的是**父碑真的挡得住子行**这条路，那要有外键。
       */
      /**
       * ★ 用 `lecture_logs`：它有真外键指向 `lectures`，而且**不依赖 AI** ——
       *   `items` 要跑完分析才有，这对全新机器上没有（第一版就是这么红的）。
       */
      sWrite(p.rootB, (db) => {
        db.prepare(
          `insert into lecture_logs (lecture_id, event, detail, uid, created_at, updated_at)
             values (?, 'S5', '子行', 'llog-s5-child', ?, ?)`
        ).run(onB.id, Date.now(), Date.now())
      })
      /** A 同时把那一讲彻底删掉（离线） */
      const at = Date.now()
      sWrite(p.rootA, (db) => {
        db.prepare(
          `insert into tombstones (target_uid, kind, target_id, purged_at, created_at, updated_at)
             values (?, 'lectures', ?, ?, ?, ?)`
        ).run(lec.uid, lec.id, at, at, at)
        sCascadeDelete(db, lec.id)
      })

      const out = await runUntilFixedPoint(p.devs, { maxRounds: 8 })

      /** ── 业务侧：全部断言死 ─────────────────────────────── */
      for (const [who, root] of [
        ['A', p.rootA],
        ['B', p.rootB]
      ] as const) {
        assert.equal(
          sRead<{ n: number }>(root, `select count(*) as n from lectures where uid = ?`, lec.uid)!.n,
          0,
          `★★ ${who} 上父还在`
        )
        const fk = sRead<{ n: number }>(root, `select count(*) as n from pragma_foreign_key_check`)
        assert.equal(fk?.n ?? 0, 0, `★★ ${who} 上有业务孤儿（外键指向不存在的父）`)
      }
      /** ★ 那条子行不许留在任何一台上（父都没了） */
      for (const [who, root] of [
        ['A', p.rootA],
        ['B', p.rootB]
      ] as const) {
        assert.equal(
          sRead<{ n: number }>(root, `select count(*) as n from lecture_logs where uid = 'llog-s5-child'`)!.n,
          0,
          `★★ ${who} 上留下了孤儿子行 —— 父都没了`
        )
      }
      assert.equal(
        out.problems.length,
        0,
        `★★ S5 没收敛：${out.problems.slice(0, 6).join(' | ')}`
      )

      /**
       * ★★ F-3 · 基状态侧现在也是硬断言。
       *
       * 根因在 `Sync.run()` 的一处时序：`mine` 是本轮开头取的快照，
       * 批循环里收到父级墓碑把行删了（连基状态一起，G1 一直在做），
       * 而 push 侧还照着旧快照回写 —— 把刚做完的清理覆盖掉。
       * 不是漏了清理，是清理之后又被重建。
       */
      const orphans = [...sOrphanState(p.rootA), ...sOrphanState(p.rootB)]
      assert.equal(
        orphans.length,
        0,
        `★★ 留下了孤儿基状态（F-3 复发）：${orphans.join("、")}`
      )
      console.log(
        `    S5 收敛 ${out.rounds} 轮 · 无业务孤儿 · 无孤儿基状态 · 外键干净`
      )
    } finally {
      await sClose(p)
    }
  })

  it('★★ S6 · #9 V1→V2/V3 冲突 →（真按钮）用本地 → 对面出 V4 → 必须再次冲突', async () => {
    const p = await newSPair('nyx-s6')
    try {
      // ★ 同上：这一条点的是**真按钮**「用本地」，那条路只有关掉自动裁决才走得到
      setAutoResolve(p.rootA, false)
      setAutoResolve(p.rootB, false)
      await sConverge(p, 'S6 前提')
      // ★ 同上：这一条验的是裁决机制，先关掉 D-438 的自动裁决
      setAutoResolve(p.rootA, false)
      setAutoResolve(p.rootB, false)
      const lec = sRead<{ uid: string; updated_at: number }>(
        p.rootA,
        `select uid, updated_at from lectures order by id desc limit 1`
      )!
      const v1 = lec.updated_at
      assert.equal(
        sRead<{ updated_at: number }>(p.rootB, `select updated_at from lectures where uid = ?`, lec.uid)!
          .updated_at,
        v1,
        '前提没成立：两台不在同一个 V1 上'
      )

      /** ── V2 / V3：两边离线各改一次 ───────────────────────── */
      const t = Date.now()
      sWrite(p.rootA, (db) => {
        db.prepare(`update lectures set name = 'A 的 V2', updated_at = ? where uid = ?`).run(t + 1000, lec.uid)
      })
      sWrite(p.rootB, (db) => {
        db.prepare(`update lectures set name = 'B 的 V3', updated_at = ? where uid = ?`).run(t + 2000, lec.uid)
      })

      await sSync(p.pageA)
      const note1 = await sSync(p.pageB)
      assert.match(note1, /两边都改过|等你决定|用哪边/, `★★ 第一次没停下来问：${note1}`)
      assert.equal(
        sRead<{ name: string }>(p.rootB, `select name from lectures where uid = ?`, lec.uid)!.name,
        'B 的 V3',
        '★★ 没裁决就动了库'
      )

      /** ── 他按下「用本地的」（**真按钮**）───────────────────── */
      await sResolve(p.pageB, 'local')
      assert.equal(
        sRead<{ name: string }>(p.rootB, `select name from lectures where uid = ?`, lec.uid)!.name,
        'B 的 V3',
        '★★ 裁决没留住他的版本'
      )
      const res1 = sRead<{ v: number }>(
        p.rootB,
        `select rejected_up_to as v from resolutions where target_uid = ?`,
        lec.uid
      )
      assert.ok(res1 && res1.v > 0, '★★ 裁决没落库 —— 老包重放就会推翻他')

      /** ── A 在 B 的版本传过去**之前**又改出 V4（与那个决定并发）── */
      sWrite(p.rootA, (db) => {
        db.prepare(`update lectures set name = 'A 的 V4', updated_at = ? where uid = ?`).run(t + 3000, lec.uid)
      })
      await sSync(p.pageA)
      const note2 = await sSync(p.pageB)

      /**
       * ★★ 这是 S6 的正题：V4 是**新的分歧**，不能因为 V3 被裁决过就吞掉它。
       *   吞掉 = 他刚做的决定被一个他没看过的版本静默推翻。
       */
      assert.match(
        note2,
        /两边都改过|等你决定|用哪边/,
        `★★ 对面裁决后的新改动被静默吞掉了：${note2}`
      )
      assert.equal(
        sRead<{ name: string }>(p.rootB, `select name from lectures where uid = ?`, lec.uid)!.name,
        'B 的 V3',
        '★★ 没裁决就动了库（V4 静默覆盖）'
      )
      const res2 = sRead<{ v: number }>(
        p.rootB,
        `select rejected_up_to as v from resolutions where target_uid = ?`,
        lec.uid
      )!
      assert.ok(res2.v >= res1.v, `★★ 裁决倒退了：${res2.v} < ${res1.v}`)

      /** ── 他这次选「用云端的」，收工 ──────────────────────── */
      await sResolve(p.pageB, 'remote')
      assert.equal(
        sRead<{ name: string }>(p.rootB, `select name from lectures where uid = ?`, lec.uid)!.name,
        'A 的 V4',
        '★★ 选了用云端却没收下 V4'
      )
      /**
       * ★★ F-4（P2，已记录，本轮不修）在真双进程下同样出现：
       *   走过冲突的那一行只顶了 `pushed`、没顶 `synced`（R-4-F-a ⑩ 的既定规则），
       *   而它的共同基只能靠「对面把这一版原样送回来」推进 —— 对面收下之后
       *   就没有新东西可推，那一版回不来。**状态是稳定的，不是震荡。**
       *   序列本身（冲突 → 用本地 → V4 再冲突 → 用云端收下）全部成立，逐条断言在上面。
       */
      const out6 = await runUntilFixedPoint(p.devs, { maxRounds: 8 })
      const rounds = out6.rounds
      const rest6 = out6.problems.filter((x) => !/没对过账/.test(x))
      assert.equal(rest6.length, 0, `★★ S6 除 F-4 残留之外还有别的没收敛：${rest6.join(' | ')}`)
      console.log(`    S6 收敛 ${rounds} 轮 · V3 保住 → V4 再次问 → 用云端收下 · 裁决不倒退`)
    } finally {
      await sClose(p)
    }
  })

  it('★★ S7 · #17 两台各 2000+ 离线改动 + applied 溢出 500 → 多轮收敛', async () => {
    const p = await newSPair('nyx-s7')
    try {
      await sConverge(p, 'S7 前提')
      const N = 2000
      for (const [tag, root] of [
        ['LA', p.rootA],
        ['LB', p.rootB]
      ] as const) {
        sWrite(root, (db) => {
          const lid = (db.prepare(`select id from lectures limit 1`).get() as { id: number }).id
          const ins = db.prepare(
            `insert into picks (scope, scope_id, content, uid, created_at, updated_at)
               values ('lecture', ?, ?, ?, ?, ?)`
          )
          const t = Date.now()
          db.exec('begin')
          for (let i = 0; i < N; i++) {
            ins.run(lid, `${tag} 第 ${i} 条`, `picks-${tag}-${i}`, t + i, t + i)
          }
          db.exec('commit')
        })
      }

      const out = await runUntilFixedPoint(p.devs, { maxRounds: 8 })
      assert.equal(
        out.problems.length,
        0,
        `★★ S7 没收敛：\n  ${out.problems.slice(0, 6).join('\n  ')}\n  ${out.trace.join('\n  ')}`
      )

      for (const [who, root] of [
        ['A', p.rootA],
        ['B', p.rootB]
      ] as const) {
        const n = sRead<{ n: number }>(root, `select count(*) as n from picks`)!.n
        assert.ok(n >= N * 2, `★★ ${who} 上只有 ${n} 条，该有 ${N * 2} 以上`)
      }

      /** ★ 把 applied 清空 = 把「几个月后溢出」提前到现在，重放不许改变状态 */
      const before = p.devs[1]!.snapshot().digest
      sWrite(p.rootB, (db) => {
        db.prepare(`update settings set value = '[]' where key = 'sync.applied'`).run()
      })
      await sSync(p.pageB)
      assert.equal(
        p.devs[1]!.snapshot().digest,
        before,
        '★★ applied 溢出重放改变了状态'
      )
      const applied = sRead<{ v: string }>(
        p.rootB,
        `select value as v from settings where key = 'sync.applied'`
      )!.v
      console.log(
        `    S7 收敛 ${out.rounds} 轮 · 两台各 ${N} 条 · applied 名单 ${JSON.parse(applied).length} 个 · 重放不改状态`
      )
    } finally {
      await sClose(p)
    }
  })

  it('D-220 · 云端那堆文件里不能出现 API key', async () => {
    const all = [...files.values()].join('\n')
    assert.doesNotMatch(all, /sk-[A-Za-z0-9]{16,}/, 'API key 被同步上去了')
    assert.doesNotMatch(all, /"sync\.secret"/, '同步密码自己被同步上去了')
  })

  /**
   * ★★★ D-438 · 他真正会遇到的那条路：**默认就是不问**
   *
   * ── 为什么补这一条 ─────────────────────────────────────────
   *
   * 上面那几条冲突用例，现在全都**先把自动裁决关掉**才走得到 ——
   * 也就是说它们验的是一条**他永远走不到**的路（D-438 之后默认不问人）。
   * 那条路该验（D-438 明说按钮留着），但只验它就等于
   * **整个界面层没有一条用例盖住他每天真正会遇到的行为**。
   *
   * ── 这一条钉的是 D-438 那句承诺 ★★ ────────────────────────
   *
   * 「**不打扰他是他要的；悄悄弄丢他写的字不是。**」
   * 所以三件事一起验，缺一件这条承诺就是空的：
   *   ① 不问 —— 结果那句话里不许出现「用哪」这种要他选的话
   *   ② 按时间新的那版定 —— 库里留下的是晚改的那个名字
   *   ③ **被盖掉的那版落进账本** —— `ops_log` 里有 `sync-override`，
   *      而且里面存着旧那版的名字。没有这一条，「不问」就变成了「悄悄吃掉」。
   */
  it('★★★ D-438 · 默认不问人：按时间新的定，且旧那版落进账本', async () => {
    const p = await newSPair('nyx-d438')
    try {
      await sConverge(p, 'D-438 前提')
      const lec = sRead<{ uid: string }>(
        p.rootA,
        `select uid from lectures order by id desc limit 1`
      )!

      // 两边离线各改一次；B 的时间明确更晚 —— 谁赢是确定的，不靠运气
      const t = Date.now()
      sWrite(p.rootA, (db) => {
        db.prepare(`update lectures set name = 'A 早改的', updated_at = ? where uid = ?`).run(
          t + 1000,
          lec.uid
        )
      })
      sWrite(p.rootB, (db) => {
        db.prepare(`update lectures set name = 'B 晚改的', updated_at = ? where uid = ?`).run(
          t + 5000,
          lec.uid
        )
      })

      await sSync(p.pageA) // A 先推
      const note = await sSync(p.pageB) // B 收到 A 的，两边都改过

      // ① 不问
      assert.doesNotMatch(
        note,
        /用哪|一个字都还没动/,
        `★ 默认路径不该把选择题摆到他面前 —— 实际那句话是「${note}」`
      )
      assert.match(note, /两边都改过/, `★★ 也不许一声不吭 —— 实际是「${note}」`)

      // 让两边都收敛到同一版
      await sSync(p.pageA)
      await sSync(p.pageB)

      // ② 时间新的那版赢
      for (const root of [p.rootA, p.rootB]) {
        const nm = sRead<{ name: string }>(root, `select name from lectures where uid = ?`, lec.uid)!
          .name
        assert.equal(nm, 'B 晚改的', `★ 该由时间新的那版定，实际留下的是「${nm}」`)
      }

      /**
       * ③ ★★ 被盖掉的那版必须落进账本 —— 这是「不问」能成立的全部前提。
       *
       * ★ 两台都查：**裁决发生在哪一台，账就落在哪一台**。
       *   谁先同步、谁的那版更晚，决定了这一笔记在 A 还是 B ——
       *   而他关心的只有一件事：**被盖掉的那行字，在某台机器上找得回来**。
       */
      const found = [p.rootA, p.rootB].map((root) =>
        sRead<{ n: number }>(
          root,
          `select count(*) as n from ops_log where op = 'sync-override' and detail like ?`,
          '%A 早改的%'
        )!.n
      )
      const all = [p.rootA, p.rootB]
        .map((root, i) => {
          const rows = sReadAll<{ op: string; title: string }>(
            root,
            `select op, title from ops_log order by id desc limit 8`
          )
          return `${i === 0 ? 'A' : 'B'}: ${rows.map((r) => `${r.op}/${r.title}`).join(' , ') || '（空）'}`
        })
        .join('\n')
      assert.ok(
        found[0]! + found[1]! > 0,
        `★★★ 旧那版没落进账本 —— 那「不打扰他」就成了「悄悄弄丢他写的字」，D-438 承诺的正是这一条。\n两台的账本最近几笔：\n${all}`
      )
    } finally {
      await sClose(p)
    }
  })


  /**
   * ★★★ I-178 · 改完启动页图片的名字之后，**本机不许回头骂自己时钟不准**
   *
   * ── 那条 bug 长什么样 ──────────────────────────────────
   * 警告的判据是 meta 的 `at` 和 `sync.maxRemoteSeen` 比大小，而水位**只被别的
   * 设备推的包抬**。可 `store.list('nyx/splash')` 列出来的 meta 里
   * **有本机自己刚推上去的那几份** —— 于是「本机刚改名 ＋ 对端半天没同步」
   * 就是拿自己的 `at` 去和一个不含自己的水位比，必然超前、必然报。
   * 使用者 2026-09-14 看到的那句「10 小时以上」，骂的是他自己这台机器。
   *
   * ── 为什么这一条非要在 S 层再钉一次 ────────────────────
   * core（`splash-sync.test.ts`）钉的是判据的三态。它钉不到的是**这条真实路径**：
   * 真 IPC 改名 → 真 settings → 真 PUT 进桶 → **下一趟把自己写的那份读回来比**。
   * 「自己读回自己」这一步只有整条路接起来才存在，而 bug 就长在那一步上。
   */
  it('★★★ I-178 · 改完名字**再同步一趟** → 体检里没有时钟警告（自己不骂自己）', async () => {
    const p = await newSPair('i178-self')
    try {
      /** 合法资源名 = 64 位小写 hex（sha256）+ 扩展名 */
      const pic = `${'a'.repeat(64)}.webp`
      const meA = await p.pageA.evaluate(async () => (await window.nyx.sync.status()).device)
      assert.ok(meA, '★ 拿不到本机设备号 —— 那「是不是自己写的」就无从判起，这条用例是假的')

      /**
       * ★★★ **先把那条 bug 的真实局面摆出来**：A 上一次见到对端的改动是 10 小时前。
       *
       * 不摆这个局面，这条用例就是**白拿的绿**：一对全新的机器上 `sync.maxRemoteSeen` 是 0，
       * 而判据在「没有远端参照」时直接给 0 —— 于是把修复整个删掉它也照样绿。
       * 2026-09-15 第一版真就是这样，**负向对照抓出来的**（删掉「本机不算」那一行，
       * smoke:sync 仍然 41/41）。一条反向对照不会红的用例，钉的是零。
       *
       * 取 10 小时：使用者那台实测 9.933 h，容差 6 h。水位是 `settings` 里的一行、
       * 不在 `SYNC_TABLES` 里，直接写它就是在说「上次听到对面的消息是 10 小时前」。
       * ★ 这一趟 A 拉不到任何新行（`maxRemoteAt = 0`），所以引擎不会把水位覆盖回去。
       */
      const staleSeen = Date.now() - 10 * 3_600_000
      sWrite(p.rootA, (db) => {
        db.prepare(
          `insert into settings (key, value, updated_at) values ('sync.maxRemoteSeen', ?, ?)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
        ).run(String(staleSeen), Date.now())
      })
      assert.equal(
        maxRemoteSeen(p.rootA),
        staleSeen,
        '★★ 水位没摆进去 —— 那下面那条断言又变成白拿的绿了'
      )

      await p.pageA.evaluate((n) => window.nyx.res.renameSplash(n, '我刚起的名字'), pic)

      /**
       * ★★★ **要同步两趟**，出事的是第二趟。
       *
       * `syncSplashNames` 是**先拉后推**：改完名的那一趟，拉的时候桶里还什么都没有，
       * 本机写的那份是这一趟**末尾**才 PUT 上去的。所以「自己读回自己」要到**下一趟**
       * 才发生 —— 而那正是这条 bug 唯一会出现的地方。
       * ★ 只同步一趟的话这条用例又是白拿的绿：2026-09-15 第二次负向对照抓出来的
       *   （水位摆好了、修复删掉了，仍然 41/41 全绿，因为根本没走到出事那一步）。
       */
      await sSync(p.pageA)
      await sSync(p.pageA)
      assert.equal(
        maxRemoteSeen(p.rootA),
        staleSeen,
        '★ 这两趟不该动水位（A 一行新的远端数据都没拉到）—— 动了就说明局面没摆住'
      )
      assert.deepEqual(
        await clockNotes(p.pageA),
        [],
        '★★★ 他刚改完一个名字，下一趟同步软件就回头告诉他「另一端的时钟可能不准」—— 那个「另一端」就是他自己'
      )

      /**
       * 对面拉一趟，别把桶留在半截状态。
       * ★ 这一句**钉不住多少东西**，如实说：B 的水位是新的（它刚跟 A 对过账），
       *   所以 B 这边本来就算不出超前量，修不修都绿。真正有牙的是上面那条和下面那条反面。
       *   不写成「钉住了对面也不报」—— 那是拿一条白拿的绿冒充守卫。
       */
      await sSync(p.pageB)
      assert.deepEqual(await clockNotes(p.pageB), [], '对面拉到这份 meta 之后也没多出时钟警告')

      /**
       * ★ 桶里那份真的盖上本机编号了吗。
       *   不盖的话它下一趟读回来就是「没有设备号」= 老 meta = 永远跳过，
       *   于是这条闸对**新写的** meta 也等于关掉了 —— 而那是它唯一还管着的一半。
       */
      const key = [...files.keys()].find((k) => k.endsWith(`/nyx/splash/${pic}.meta.json`))
      assert.ok(key, '★ 桶里没有那份 meta —— 名字那条流根本没跑起来')
      const body = JSON.parse(files.get(key)!) as { label?: string; device?: string }
      assert.equal(body.label, '我刚起的名字')
      assert.equal(body.device, meA, '★★ 推上去的 meta 没盖本机编号，下一趟它就退化成老数据')
    } finally {
      await sClose(p)
    }
  })

  /**
   * ★★★ I-178 的**反面**：修完之后这条闸还得有牙。
   *
   * 不钉这一条的话，「一个都不报」也能让上面那条全绿 —— 那是把闸关掉，不是修好。
   *
   * ── 为什么别机那份 meta 是手写进桶里的 ────────────────────
   * 和本文件手写「别的设备推上来的包」同一个办法。**不能**改用「让 B 顶着一个
   * 超前的钟跑」：B 推的**行**也会带着超前的时间戳，A 的 `maxRemoteSeen` 跟着一起抬，
   * 差值当场归零 —— 警告永远不出现，而用例会绿得像是修好了。
   * 真实形状是「**改名那一刻**比它最后写数据那一刻晚得多」，手写正好摆出这个形状。
   */
  it('★★★ I-178 反面 · 别的设备那份 meta 真超前 → 照样报（闸没被修成哑巴）', async () => {
    /**
     * ★★ 桶名写成常量，下面**直接用它拼键** —— 别再从 `files` 里「随便找一个键」反推前缀：
     *   `files` 是整个套件**共用**的一张假磁盘，里面混着前面每个桶的键，
     *   `find()` 拿到的是最早插进去的那个（`nyx-test`），于是夹具会被塞进**别的桶**，
     *   本桶什么都没多，用例报「一声不吭」—— 看着像产品坏了，其实是夹具喂错了地方。
     *   2026-09-15 真踩过一次。
     */
    const BUCKET = 'i178-skew'
    const p = await newSPair(BUCKET)
    try {
      const pic = `${'b'.repeat(64)}.webp`

      /** ① 先让 B 用正常的钟推一批行上去 —— A 的水位由它立起来 */
      sWrite(p.rootB, (db) => {
        db.prepare(`update lectures set name = ?, updated_at = ? where id = 1`).run(
          'B 用正常时间改的',
          Date.now()
        )
      })
      await sSync(p.pageB)
      await sSync(p.pageA)
      assert.ok(
        maxRemoteSeen(p.rootA) > 0,
        '★ A 的水位没立起来 —— 没有参照就永远算不出超前量，这条用例会假绿'
      )

      /** ② 桶里放一份**别的设备**写的 meta，时刻比 A 见过的最新远端时刻晚 48 小时 */
      assert.ok(
        [...files.keys()].some((k) => k.startsWith(`${BUCKET}/nyx/`)),
        `★ 桶 ${BUCKET} 下一个键都没有 —— 桶名写错了，夹具会喂进别人的桶而这条用例会假红`
      )
      files.set(
        `${BUCKET}/nyx/splash/${pic}.meta.json`,
        JSON.stringify({
          label: '钟快的那端起的名',
          at: maxRemoteSeen(p.rootA) + 48 * 3_600_000,
          device: 'OTHER-DEVICE'
        })
      )

      /** ③ A 拉到它 —— 必须说话 */
      await sSync(p.pageA)
      const notes = await clockNotes(p.pageA)
      assert.equal(
        notes.length,
        1,
        `★★★ 别的设备的钟真快了却一声不吭 —— 这条闸已经被修成哑巴了。体检里是：${notes.join(' | ') || '（空）'}`
      )
      assert.match(notes[0]!, /还晚了/, '★★ 文案要和判定同向：报的是「远端更晚」')
      assert.match(notes[0]!, /48 小时以上/, '★ 顺带钉住量：48 小时那个数要算对')
      /** ★★ K-5 · 两种成因都说、一个都不判定（和回收站那条闸同一口径） */
      assert.match(notes[0]!, /没改过数据/, '★★ 成因一要出现在他真会看到的那句话里')
      assert.match(notes[0]!, /时钟快了/, '★★ 成因二要出现在他真会看到的那句话里')
      assert.doesNotMatch(notes[0]!, /时钟可能不准/, '★★★ 不许替他下证不出的断言')
    } finally {
      await sClose(p)
    }
  })

  it('渲染进程没有未捕获异常', () => {
    assert.deepEqual(errors, [], errors.join('\n'))
  })
})

/**
 * ★★ T-2.2 · 云端删除原语 + 压实 —— **走真 HTTP**（D-435 · 审计 R-008）
 *
 * 判据本身在 `src/core/sync/compact.test.ts`（内存 store 替身，21 条）。
 * 这里验的是另一半：**WebDAV 那一层的 DELETE 真的删得掉吗**，
 * 以及整趟压实接在真传输层上还成不成立。
 *
 * 换成 Mock 就验不到 WebDAV 那一层，而那一层恰恰是最容易写错的
 * —— 这是这个文件开头那句话，删除也不例外。
 *
 * ★ 不走 Electron、不走 IPC：本轮**不给压实接任何入口**（触发策略等使用者定），
 *   所以这里直接拿 `WebDavStore` 对着同一个假服务器说话。
 */
describe('★★ T-2.2 · 云端删除与压实（真 WebDAV）', () => {
  const BUCKET = 't22-compact'
  const ID = { schemaVersion: 38, schemaFingerprint: 'cadb369e52c0e335', protocolVersion: SYNC_PROTOCOL_VERSION }

  const store = (): WebDavStore =>
    new WebDavStore({
      kind: 'webdav',
      url: `http://127.0.0.1:${port}/${BUCKET}`,
      user: 'u',
      secret: 'p'
    })

  const row = (table: string, uid: string, at: number): SyncRow => ({
    table,
    uid,
    updatedAt: at,
    data: { uid, updated_at: at }
  })

  const pack = (device: string, at: number, rows: SyncRow[]): string =>
    JSON.stringify({ device, at, ...ID, rows })

  /** 这一趟自己的桶，别的用例碰不到 */
  async function seed(): Promise<WebDavStore> {
    const s = store()
    for (const n of await s.list('nyx/chunks')) await s.delete(`nyx/chunks/${n}`)
    await s.put('nyx/chunks/aaa-1000.json', pack('aaa', 1000, [row('items', 'u-1', 1000)]))
    await s.put('nyx/chunks/aaa-2000.json', pack('aaa', 2000, [row('items', 'u-1', 2000)]))
    await s.put('nyx/chunks/bbb-3000.json', pack('bbb', 3000, [row('items', 'u-2', 3000)]))
    return s
  }

  it('★ DELETE 真的删得掉，而且删两次不炸（幂等）', async () => {
    const s = store()
    await s.put('nyx/chunks/probe-1.json', pack('x', 1, []))
    assert.ok((await s.list('nyx/chunks')).includes('probe-1.json'))

    await s.delete('nyx/chunks/probe-1.json')
    assert.ok(
      !(await s.list('nyx/chunks')).includes('probe-1.json'),
      '★ DELETE 回了成功，但那个对象还在'
    )
    // 幂等：压实要能重跑、能中途断
    await s.delete('nyx/chunks/probe-1.json')
  })

  it('★ 删除权限探测：能删的云端 → ok，而且探针文件不留在桶里', async () => {
    davAllowDelete = true
    const s = store()
    const r = await probeDeletePermission(s)
    assert.equal(r.ok, true, `★ 明明删得掉却说不能删：${r.ok ? '' : r.why}`)
    assert.deepEqual(
      filesSeen().filter((k) => k.includes('nyx/probe/')),
      [],
      '★ 探针文件留在云端了'
    )
  })

  it('★★★ 正路：三个包 → 一个快照，老包真的从服务器上消失', async () => {
    davAllowDelete = true
    const s = await seed()

    const r = await compactBucket({
      store: s,
      device: 'aaa',
      formerDevices: [],
      // ★ 本机吸收过对面那个包才折得动它（compact.ts 头注那条规矩）
      applied: ['bbb-3000.json'],
      identity: ID,
      now: 9_000_000,
      terminated: new Map(),
      fksOf: () => []
    })

    assert.equal(r.ok, true, `★ 压实没成：${r.why}`)
    assert.equal(r.folded, 3)
    assert.equal(r.deleted, 3)
    assert.equal(r.rows, 2, '★ items u-1 去重之后只剩一版，加上 u-2')

    const left = await s.list('nyx/chunks')
    assert.deepEqual(left, ['aaa-9000000.json'], `★ 服务器上剩下的不对：${left.join(' · ')}`)

    // ★ 老包是真的从服务器的「磁盘」上没了，不是被覆盖成空包
    assert.deepEqual(
      filesSeen().filter((k) => k.startsWith(`${BUCKET}/nyx/chunks/`)),
      [`${BUCKET}/nyx/chunks/aaa-9000000.json`],
      '★★ 老包还在服务器上 —— 那就还是覆盖，不是删除（D-435 要的是清掉）'
    )

    // ★ 快照就是一个普通的包：留下的那一行是最新那一版
    const body = await s.get('nyx/chunks/aaa-9000000.json')
    const rows = (JSON.parse(body!) as { rows: SyncRow[] }).rows
    assert.equal(rows.find((x) => x.uid === 'u-1')?.updatedAt, 2000)
  })

  it('★★★ 负向对照：云端只让写不让删 → 压实拒跑，桶原封不动', async () => {
    davAllowDelete = true
    const s = await seed()
    const before = await s.list('nyx/chunks')

    davAllowDelete = false
    try {
      const r = await compactBucket({
        store: s,
        device: 'aaa',
        formerDevices: [],
        applied: ['bbb-3000.json'],
        identity: ID,
        now: 9_100_000,
        terminated: new Map(),
        fksOf: () => []
      })

      assert.equal(r.ok, false, '★★★ 删不掉东西却说压实成功了')
      assert.equal(r.snapshot, undefined, '★★★ 明知删不掉还是把快照写上去了')
      assert.match(r.why ?? '', /能写、不能删/)
      assert.deepEqual(await s.list('nyx/chunks'), before, '★★★ 拒了却还动了桶')
    } finally {
      davAllowDelete = true
      // 探测卡在「能写不能删」时会留下一个探针文件 —— 它自己说了，这里收拾掉
      for (const n of await s.list('nyx/probe')) await s.delete(`nyx/probe/${n}`)
    }
  })
})
