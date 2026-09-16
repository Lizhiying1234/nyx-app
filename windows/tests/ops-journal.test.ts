import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { openLecture } from './tree.ts'
import { mainWindow } from './win.ts'
import { keepOrClean } from './keep-on-fail.ts'

/**
 * 动作账本看得见 · 补一条断链（2026-09-03）
 *
 * ══ 断在哪 ═══════════════════════════════════════════════════
 * 同步完成后界面会对他说一句「**旧的那版记在账本里**」
 * （`core/sync/engine.ts`，D-438 那条「不打扰他但绝不悄悄弄丢他写的字」的安全网），
 * 引擎注释里还写着「他随时查得回来」——
 * **而在这之前没有任何地方能查**：`ledger.ops` 这个口零调用方。
 * 软件承诺了一件它做不到的事。
 *
 * ══ 判据 ═════════════════════════════════════════════════════
 * 不是「有个按钮能点开」，是**他被承诺的那样东西真的看得到**：
 * 造一条 `sync-override` 记录，它必须出现在账本里，而且写的是人话不是内部动作名。
 *
 * ★ 负向对照：把 Settings.svelte 里那段 `{#if opsOpen}` 删掉 → 用例 ②③ 当场红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = mkdtempSync(join(tmpdir(), 'nyx-ops-'))

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []
/** ★ T-2.5 · 「被盖过」那条知识点，以及那一笔账记的时刻 */
let probeItemId = 0
/** ★ T-4.14 · 查词那一段要走到真的讲次页上去右键 */
let probeLectureId = 0
let overrideAt = 0

before(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, NYX_DATA_ROOT: dataRoot, NYX_NO_SYNC_TIMERS: '1' }
  })
  page = await mainWindow(app)
  page.setDefaultTimeout(8000)
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`${e.name}: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)

  // 造一条**真的**同步覆盖记录 —— 用引擎自己写的那种形状（D-438）
  const seeded = await page.evaluate(async () => {
    const p = await window.nyx.data.createProject('账本验收')
    const u = await window.nyx.data.createUnit(p, 'U')
    const l = await window.nyx.data.createLecture(u, 'L')
    // 删一条知识点：这一下本身也会进账本，顺带验「普通动作也记」
    const it = await window.nyx.data.addItem(l, 'ledger probe', '账本探针', 'B', 'A probe.')
    await window.nyx.study.deleteItem(it.id)
    // ★ T-2.5 用的探针，另建一条（上面那条已经删了）
    const keep = await window.nyx.data.addItem(l, 'restore probe', '现在这版', 'B', 'A probe.')
    return { item: keep.id, lecture: l }
  })
  probeItemId = seeded.item
  probeLectureId = seeded.lecture

  /**
   * ★★ T-2.5 · 造一笔「它被盖过」的账 —— **形状照 `engine.ts::noteOverrides` 写的那一份**。
   *
   * `kept='remote'` = 被盖的是**本机**那版 → `lost` 是**本地形**（整行原样）。
   * ★ 直接写库而不是真跑一趟同步：这一套没有云端，而这条用例要验的是
   *   **账本那一行点不点得动**，不是同步本身（那在 `tests/db-safety.ts` 的五条场景里，
   *   走的是真引擎、两台假端、连同步形那一半一起）。
   * ★ 必须在**这里**写：`Settings.svelte` 的账本只在第一次展开时取一次
   *   （`opsLoaded` 之后不再重取），页面渲染之后再插就看不见了。
   */
  overrideAt = Date.now()
  const seed = new DatabaseSync(join(dataRoot, 'data', 'nyx.db'))
  const row = seed.prepare(`select * from items where id = ?`).get(probeItemId) as Record<string, unknown>
  seed
    .prepare(
      `insert into ops_log (op, target, target_id, title, detail, created_at, updated_at)
         values ('sync-override', 'items', null, ?, ?, ?, ?)`
    )
    .run(
      'restore probe',
      JSON.stringify({
        uid: String(row['uid']),
        kept: 'remote',
        keptAt: overrideAt,
        lostAt: overrideAt - 1000,
        lost: { ...row, gloss: '被盖掉的那版', updated_at: overrideAt - 1000 }
      }),
      overrideAt,
      overrideAt
    )
  seed.close()
})

after(async () => {
  await app?.close()
  try {
    keepOrClean(dataRoot)
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
})

describe('动作账本：承诺过「记在账本里」，就得看得见', () => {
  it('① 设置 › 数据 里有「动作账本」，默认是收起的', async () => {
    await page.click('[data-testid="nav-settings"]')
    await page.click('[data-testid="set-tab-data"]')
    await page.waitForSelector('[data-testid="ops-head"]')
    assert.equal(
      await page.locator('[data-testid="ops-list"]').count(),
      0,
      '★ 应该默认收起 —— 这是「出事之后来翻」的东西，不是每天要看的'
    )
  })

  it('★★ ② 点开就能看到刚才那笔删除 —— 而且写的是人话', async () => {
    await page.click('[data-testid="ops-head"]')
    await page.waitForSelector('[data-testid="ops-list"]', { timeout: 8000 })
    const t = await page.innerText('[data-testid="ops-list"]')
    assert.match(t, /ledger probe/, '★★ 账本里没有刚才删掉的那一条 —— 断链没修好')
    assert.doesNotMatch(
      t,
      /\bsoft-delete\b|\bdeleteItem\b/,
      '★ 不该把内部动作名直接摆给他看'
    )
  })

  it('③ 记录带时间，不是一堆没头没尾的字', async () => {
    const rows = await page.locator('[data-testid="ops-row"]').count()
    assert.ok(rows >= 1, `账本应该至少有一行，实际 ${rows}`)
    const first = await page.locator('[data-testid="ops-row"]').first().innerText()
    assert.match(first, /\d{4}|\d{1,2}:\d{2}/, '★ 每一笔要看得出是什么时候的事')
  })

  /**
   * ★★★ T-2.5 / D-R4（使用者 2026-09-05 裁「要」）· 账本里那一笔要**点得动**。
   *
   * ══ 为什么在这一套里，而不是 smoke:sync ══════════════════════
   *
   * 第一版写在 `tests/sync.test.ts` 的 D-438 那条后面 —— 真两台、真 WebDAV，
   * 看着更「真」。可那一套是**一条有状态的长链**：还原把那条知识点的层改回去、
   * 把 `updated_at` 顶上去，后面 13 条用例当场全红。
   * 验的东西不该靠改动别人的前提来站住。
   *
   * 所以这里造一笔**形状一模一样**的 `sync-override`（字段照 `engine.ts::noteOverrides`
   * 写的那一份），在这一套自己的库里，跑完谁也不影响。
   * 两台真机 + 同步形（`kept='local'`，外键是 `*_uid`）那一半由
   * `tests/db-safety.ts` 的五条场景验，那边走的是真的引擎。
   *
   * ★ 判据不是「有个按钮能点」，是**点完库里真的变了** ——
   *   界面说「还原好了」而库里没动，是这个项目最贵的一种失败。
   */
  it('★★★ ⑤ T-2.5 · 被盖掉的那一版点得回来，而且只回来一次', async () => {
    const dbPath = join(dataRoot, 'data', 'nyx.db')
    const t = overrideAt

    // ① 账本里那一行有「还原」，点下去（列表在 ② 里已经展开了）
    assert.ok(
      (await page.locator('[data-testid="ops-restore"]').count()) >= 1,
      '★★ 「同步时被盖掉的那一版」那一行上没有「还原」—— D-R4 裁的就是这个入口'
    )
    const btn = page.locator('[data-testid="ops-restore"]').first()
    await btn.click()
    await page.waitForSelector('[data-testid="ops-said"]')
    const said = await page.innerText('[data-testid="ops-said"]')
    assert.match(said, /还原好了/, `★ 还原没做成：${said}`)

    // ③ 库里真的变了，而且顶了新的 updated_at（不顶的话另一端会当场盖回去）
    const after = new DatabaseSync(dbPath, { readOnly: true })
    const now = after.prepare(`select gloss, updated_at from items where id = ?`).get(probeItemId) as {
      gloss: string
      updated_at: number
    }
    const restored = (
      after.prepare(`select count(*) as n from ops_log where op = 'sync-restore'`).get() as { n: number }
    ).n
    after.close()
    assert.equal(now.gloss, '被盖掉的那版', '★★★ 界面说还原好了，库里却没变')
    assert.ok(
      Number(now.updated_at) > t,
      `★★★ 还原必须顶一个比「盖住它的那一版」更新的时间戳，实际 ${now.updated_at} vs ${t}`
    )
    assert.equal(restored, 1, '★ 账本上要留一笔 sync-restore')

    // ④ 再点一次 —— 说「已经还原过」，不许再写一遍
    await btn.click()
    await page.waitForTimeout(400)
    assert.match(
      await page.innerText('[data-testid="ops-said"]'),
      /已经还原过/,
      '★★ 同一笔还原第二次该被挡住'
    )
    const again = new DatabaseSync(dbPath, { readOnly: true })
    const n2 = (
      again.prepare(`select count(*) as n from ops_log where op = 'sync-restore'`).get() as { n: number }
    ).n
    again.close()
    assert.equal(n2, 1, '★ 被挡住就不该再记一笔')
  })

  it('④ 再点一次收起来', async () => {
    await page.click('[data-testid="ops-head"]')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="ops-list"]').count(), 0, '收不起来')
  })
})

/**
 * ★★★ T-4.14 · Windows 端的查词，从今天起记账（使用者 2026-09-07 第四批 三 · 五）
 *
 * ══ 病在哪 ═══════════════════════════════════════════════════
 *
 * 真库里 1,142 条 `lookup` **全是手机写的**（归档 d §三 G）——
 * 电脑上右键「查词典」一行都不记。于是「反复查同一个词」「查了没收」
 * 这两条最便宜的学习信号，在电脑这一半是空白的，
 * 而分析报告将来正是要靠它们说话。
 *
 * ══ 判据 ═════════════════════════════════════════════════════
 *
 * 不是「有个函数被调到了」，是**他真的右键查了一次之后，库里多了一行、
 * 而且那一行说得出从哪查 / 哪一面 / 之后收没收**：
 *   `op = 'lookup'` · `target = 'term'` · `title` = 词面（三样和手机逐字一样）
 *   `detail = { source: 'windows', face: 'dict', saved: item_id | null }`
 * 不加表、不加列 —— `ops_log` 早就在同步合约里，写了自然同步。
 *
 * ★ 负向对照：把 `Capture.svelte::lookUp` 里那句 `ledger.lookup` 删掉 → ① 当场红；
 *   把 `detail` 写成空对象 → ② 红；把 `addTo` 里的回填删掉 → ③ 红。
 */
describe('T-4.14 · 查一次词，账本上多一行', () => {
  const dbPath = join(dataRoot, 'data', 'nyx.db')
  /** 他选中的那串字 —— 就是那条知识点的原文出处 */
  const WORD = 'A probe.'

  type LookupRow = { id: number; op: string; target: string; title: string; detail: string }
  const lookups = (): LookupRow[] => {
    const d = new DatabaseSync(dbPath, { readOnly: true })
    const rows = d
      .prepare(`select id, op, target, title, detail from ops_log where op = 'lookup' order by id`)
      .all() as LookupRow[]
    d.close()
    return rows
  }

  /** 选中 `.quo` 那一段原文 + 派一个真的 contextmenu（和 study.test.ts 那几处同一条路） */
  const rightClick = async (): Promise<void> => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="item-rows"] .quo')
      if (!el) throw new Error('讲次页上没有原文出处那一行 —— 右键取词无从谈起')
      const r = document.createRange()
      r.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
      const box = el.getBoundingClientRect()
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: Math.round(box.left + 8),
          clientY: Math.round(box.top + 4)
        })
      )
    })
    await page.waitForSelector('[data-testid="ctx-menu"]', { timeout: 8000 })
  }

  it('前提：走到那一讲，页面上有可以右键的原文', async () => {
    await page.click('[data-testid="nav-home"]')
    await openLecture(page, probeLectureId)
    await page.waitForSelector('[data-testid="item-rows"]', { timeout: 8000 })
    // Tab 落在第一个非空的那个，通常就对；不对就自己翻一遍（列表在哪个 Tab 不是这条用例要验的事）
    for (const t of ['tab-active', 'tab-self', 'tab-passive']) {
      if ((await page.locator('[data-testid="item-rows"] .quo').count()) > 0) break
      await page.click(`[data-testid="${t}"]`).catch(() => {})
      await page.waitForTimeout(200)
    }
    assert.ok(
      (await page.locator('[data-testid="item-rows"] .quo').count()) > 0,
      '前提没成立：这一讲的列表上看不到原文出处'
    )
    assert.equal(lookups().length, 0, '前提没成立：还没查词，账本上就已经有 lookup 了')
  })

  it('★★★ ① 右键「查词典」→ 账本上多一行 lookup（不是零行，也不是两行）', async () => {
    await rightClick()
    await page.click('[data-testid="ctx-dict"]')
    await page.waitForSelector('[data-testid="dict-card"]', { timeout: 8000 })
    await page.waitForTimeout(500)

    const rows = lookups()
    assert.equal(
      rows.length,
      1,
      `★★★ 查了一次词，账本上却是 ${rows.length} 行 —— 电脑这一半的查词行为还是没人记`
    )
    assert.equal(rows[0].target, 'term', '★ target 要和手机那一行一样是 term')
    assert.equal(rows[0].title, WORD, `★ 记的词面不对：${rows[0].title}`)
  })

  it('★★ ② 那一行说得出「从哪查 · 哪一面 · 之后收没收」', async () => {
    const d = JSON.parse(lookups()[0].detail ?? 'null') as {
      source?: string
      face?: string
      saved?: number | null
    } | null
    assert.ok(d, '★★ detail 是空的 —— 那这一行和手机上那 1,142 条一样，什么都说不出')
    assert.equal(d?.source, 'windows', '★★ 不知道是哪台机器查的')
    assert.equal(d?.face, 'dict', '★★ 不知道查的是词典还是 AI')
    assert.equal(d?.saved ?? null, null, '★ 还没收下，saved 就该是空的')
  })

  it('★★★ ③ 查完把它收下 → 同一行回填 saved（不是再记一行）', async () => {
    await page.click('[data-testid="dict-close"]')
    await page.waitForTimeout(200)

    await rightClick()
    await page.click('[data-testid="ctx-layer-b"]')
    await page.waitForSelector('[data-testid="ctx-here"]', { timeout: 8000 })
    await page.click('[data-testid="ctx-here"]')
    await page.waitForSelector('[data-testid="toast-text"]', { timeout: 8000 })
    await page.waitForTimeout(500)

    const rows = lookups()
    assert.equal(rows.length, 1, `★★ 收下不该再记一行 lookup —— 现在有 ${rows.length} 行`)
    const d = JSON.parse(rows[0].detail ?? 'null') as { saved?: number | null } | null

    const probe = new DatabaseSync(dbPath, { readOnly: true })
    const saved = probe
      .prepare(`select id from items where term = ? and deleted_at is null order by id desc limit 1`)
      .get(WORD) as { id: number } | undefined
    probe.close()
    assert.ok(saved, '前提没成立：右键收下的那条知识点不在库里')
    assert.equal(
      d?.saved ?? null,
      saved?.id,
      '★★★ 「查了之后收下了」没回填 —— 报告只能靠词面 + 时间去猜，那正是今天手机那批的毛病'
    )
  })
})

describe('控制台', () => {
  it('渲染进程没有任何 console.error 或未捕获异常', () => {
    assert.deepEqual(
      { consoleErrors },
      { consoleErrors: [] },
      `渲染进程报错了：\n${consoleErrors.join('\n')}`
    )
  })
})
