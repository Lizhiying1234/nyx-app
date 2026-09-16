/**
 * SF · 「写库之前先同步一趟」的口子（I-163）
 *
 * ── 这一组在钉什么 ──────────────────────────────────────────
 *
 * F 从 import 图上看见：`engine/main.ts → db/analysis-runner.ts → db/analyse.ts
 * → db/sync.ts → db/sync-ports.ts`，也就是 **Assist 引擎那个无桥的 WebView
 * 里打进了整个 Capacitor**（D-404）。他报的时候写的是「引擎的 `analysis` op 走
 * `resumeBatch → defaultBatchSync`」——
 *
 *   ★★ 核下来**那条运行路是不存在的**：`resumeBatch` 只调 `tick`，
 *      而 `tick` 每条都显式传 `noSyncPerItem`；`defaultBatchSync` 只有
 *      `startBatch` 用，而 `startBatch` 全仓只有 `ui/views/Lecture.svelte`
 *      一个调用点，引擎没有那个 op。所以引擎**从来没有**去调没有桥的
 *      Capacitor —— 它带的是一份跑不到的死代码，白占包和启动解析。
 *
 * 于是这一组分成两半，两半都要：
 *   · SF-1 钉住那条运行路**永远不要求同步**（今天为真，明天有人加一句就红）
 *   · SF-4 / SF-5 钉住那条**打包边**已经断了，而且不许悄悄接回来
 *
 * ★ SF-4 读的是**源码文本**：它看不见打包器怎么处理这些 import。那一半由
 *   `tools/check-engine-bundle.mjs` 覆盖（走 import 图 + grep 产物，挂在
 *   `npm run build` 上）—— 两侧各问各的，别把其中一侧当成全部。
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { __setKeyProviderForTests } from '../src/db/ai.ts'
import { analyseItem } from '../src/db/analyse.ts'
import { editItem } from '../src/db/edit-item.ts'
import { clearBatch, loadBatch, resumeBatch, startBatch } from '../src/db/analysis-runner.ts'
import {
  installSyncFirst,
  SYNC_FIRST_PORT_NOT_INSTALLED,
  type SyncFirst
} from '../src/db/sync-first.ts'
import { builtDb, cleanup, type Fixture } from './helpers.ts'

after(cleanup)
__setKeyProviderForTests(() => Promise.resolve('mock-key'))

// ── 本地 mock AI（形状照 analysis-batch.test.ts 那一份）──────────

let srv: Server | null = null
let port = 0
const BODY = { inSentence: 'm', chunks: ['c'], verbs: 'v' }

before(async () => {
  await new Promise<void>((resolve) => {
    srv = createServer((_req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(BODY) } }] }))
    })
    srv.listen(0, '127.0.0.1', () => {
      port = (srv!.address() as { port: number }).port
      resolve()
    })
  })
})
after(() => srv?.close())

/** 每条用完还原成「没装」—— 装没装是这一组的主角，不许被上一条带过去 */
after(() => installSyncFirst(null))

const noSync: SyncFirst = () => Promise.resolve({ ran: true, note: '（测试里不真同步）' })

/** 记下「谁要求同步了、报的哪个标签」 */
function spyPort(): { labels: string[] } {
  const box = { labels: [] as string[] }
  installSyncFirst((_db, label) => {
    box.labels.push(label)
    return Promise.resolve({ ran: true, note: '（测试里不真同步）' })
  })
  return box
}

function lectureWith(n: number): Fixture {
  const f = builtDb()
  const t = Date.now()
  const q = (sql: string, ...p: unknown[]): void => {
    f.raw.prepare(sql).run(...(p as never[]))
  }
  q(`insert into projects (id,name,created_at,updated_at) values (1,'P',?,?)`, t, t)
  q(`insert into units (id,project_id,name,created_at,updated_at) values (1,1,'U',?,?)`, t, t)
  q(
    `insert into lectures (id,unit_id,name,status,created_at,updated_at) values (1,1,'L','review',?,?)`,
    t,
    t
  )
  for (let i = 1; i <= n; i++) {
    q(
      `insert into items (id,term,gloss,layer,kind,source,created_at,updated_at)
       values (?,?,'','A','chunk','self',?,?)`,
      i,
      `term-${i}`,
      t,
      t
    )
    q(
      `insert into item_lectures (item_id,lecture_id,created_at,updated_at) values (?,1,?,?)`,
      i,
      t,
      t
    )
  }
  const set = f.raw.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('ai.light.baseUrl', `http://127.0.0.1:${port}/v1`, t)
  set.run('ai.light.model', 'mock', t)
  set.run('ai.light.protocol', 'openai', t)
  return f
}

const src = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/**
 * ★ 先剥注释再判 —— 这一脚 F 在 `check-engine-bundle.mjs` 里踩过一次：
 *   注释里引用一句 `import('./sync.ts')`（下面那三个文件的头注**正好都在**
 *   解释这条边为什么断掉）会被当成真的 import，报一条假红。
 * ★ 只剥整行 `//` 注释与块注释，不碰字符串里的 `//`（`'https://…'` 那种）。
 */
const codeOnly = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

describe('SF · 「先同步一趟」的口子（I-163）', () => {
  it('SF-1 · ★★★ 引擎那条路（`analysis` op → `resumeBatch` → `tick`）一次都不要求同步', async () => {
    const f = lectureWith(3)
    await clearBatch(f.db)
    // 起一批但先不跑 —— 起批那一趟同步是 App 那一侧的事，这里注入掉
    await startBatch(f.db, 1, { syncFirst: noSync, run: false })

    // 从这里往下就是引擎那一侧：`AnalysisWorker` 醒来 → 引擎 `analysis` op → resumeBatch
    const spy = spyPort()
    const r = await resumeBatch(f.db)

    assert.equal(r.ran, true, '前提：这一批真的接着跑了（没跑的话下面那句是空绿）')
    assert.equal(
      (await loadBatch(f.db))?.status,
      'done',
      '前提：三条都跑完了 —— 不然「没要求同步」可能只是因为它压根没干活'
    )
    assert.deepEqual(
      spy.labels,
      [],
      '★★★ 引擎那条路要求了同步 —— 那个 WebView 没有 Capacitor 桥（D-404），' +
        '`db/sync.ts` 顶层的 Filesystem / Keystore 在那里是坏的。' +
        '一批只在**开头**同步一趟（`startBatch`，App 侧），接着跑的这一段不许再要'
    )
    installSyncFirst(null)
  })

  it('SF-2 · 口子没装：分析照跑，账上说的是「没装口子」而不是「跳过了」', async () => {
    const f = lectureWith(1)
    installSyncFirst(null)

    const r = await analyseItem(f.db, 1)

    assert.equal(r.sync.ran, false, '没装口子当然没同步成')
    assert.equal(
      r.sync.why,
      'error',
      '★ 装配漏了要报 error —— 报 skip 就和「他把自动同步关了」长得一模一样了'
    )
    assert.ok(
      r.sync.note.includes(SYNC_FIRST_PORT_NOT_INSTALLED),
      `★ 屏幕上那句「分析前没同步上（…）」印的就是这个 note，它得说真话。实得：${r.sync.note}`
    )
    assert.ok(
      r.written > 0,
      '★★ 同步那一趟怎么样都**不阻塞分析** —— 他在等结果，因为装配问题拒绝分析是最坏的选择'
    )
  })

  it('SF-3 · 三处各带自己的标签（搬家没把标签搞混）', async () => {
    const f = lectureWith(2)
    await clearBatch(f.db)
    const spy = spyPort()

    await analyseItem(f.db, 1)
    await editItem(f.db, 2, { term: 'term-two' })
    await startBatch(f.db, 1, { run: false })

    assert.deepEqual(
      spy.labels,
      ['分析前同步', '修改前同步', '批量分析前同步'],
      '★ 同步账本上「这一趟是谁要的」就靠这个标签；三处搬进一个口子之后最容易串的就是它'
    )
    installSyncFirst(null)
  })

  it('SF-4 · 引擎图上那三个文件里，`db/sync.ts` 的 import 一句都没有了', () => {
    // 引擎经 `analysis` op 摸得到的三个文件（第三个是它们共用的类型/口子）
    for (const p of ['src/db/analyse.ts', 'src/db/analysis-runner.ts', 'src/db/edit-item.ts']) {
      const s = codeOnly(src(p))
      assert.ok(
        !/import\s*\(\s*['"]\.\/sync\.ts['"]\s*\)/.test(s) && !/from\s*['"]\.\/sync\.ts['"]/.test(s),
        `★★ ${p} 又 import 回 db/sync.ts 了 —— 它顶层拉 sync-ports.ts（Filesystem + Keystore），` +
          '这条边会把整个 Capacitor 打进 assist-engine.js，而那个 WebView 没有桥（D-404）。' +
          '★ 写成 await import() 不算治：单文件 IIFE 会把它内联，实测一字未减'
      )
    }
    assert.ok(
      /from\s*['"]\.\/sync\.ts['"]/.test(codeOnly(src('src/db/sync-first-native.ts'))),
      '★ 真实现搬走了就得真在那边 —— 这一句没了说明「先同步一趟」变成了空转'
    )
  })

  it('SF-5 · 引擎包闸的 ALLOWED 名单是空的（空着，产物那一段才是硬闸）', () => {
    const s = src('tools/check-engine-bundle.mjs')
    assert.ok(
      /const ALLOWED = \[\]/.test(s),
      '★★ 有人往 ALLOWED 里加了东西。名单一非空，`check-engine-bundle` 的产物那一段' +
        '就从硬闸退回「只报数」—— 引擎包里再混进 Capacitor 也只会打印一行 ✓。' +
        '真要加，先说服人（I-163 把最后一条清掉了）'
    )
  })
})
