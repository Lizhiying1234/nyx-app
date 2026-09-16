/**
 * 单条完整解析 · Android 执行器（A-1 ～ A-6 · T-5.12 / D-R22）
 *
 * ★★ 这一组盯的是**「判据只有一份」这件事本身**，不是解析质量。
 *
 * 「重新分析怎么处理旧结果」有六条互相咬合的规矩，全在 `core/analysis/plan.ts`
 * （D-149 手改过的一个字不动 · D-150 例句先词典 · R-002 释义回写 · 空块丢弃 ·
 * regen 累加 · I-112 数详情页认得几块）。在执行层另发明一条，后果**全是静默的**：
 * 他手写的那段被盖掉、或者两台机器对同一条知识点写出不一样的解析，
 * 而两边都不报错、都说得通。所以每一条用例都可以这样读：
 * **把它弄红的办法，就是在执行层自己判一次。**
 *
 * AI = 本地 mock（OpenAI 形）：机制全真，脑子是假的。
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { __setKeyProviderForTests } from '../src/db/ai.ts'
import { analyseItem, hasFullAnalysis, type SyncNote } from '../src/db/analyse.ts'
import { loadItemDetail } from '../src/db/read-path.ts'
import { NodeSqliteDb } from '../src/adapters/node-sqlite.ts'
import { AuditDb } from '../src/db/audit-db.ts'
import {
  FINGERPRINT_ALGO,
  isRenderedBlock,
  normalizeSchema,
  readSyncSurface,
  SyncEngine,
  type EnginePorts
} from '../src/core-link.ts'
import type { Db } from '../src/db/types.ts'
import { builtDb, cleanup, seed, type Fixture } from './helpers.ts'

after(cleanup)
__setKeyProviderForTests(() => Promise.resolve('mock-key'))

// ── 本地 mock AI（practice.test.ts 同手法，内嵌以免起子进程）──────
type Mode = 'ok' | 'second' | 'auth' | 'notjson' | 'wrapped'
let mode: Mode = 'ok'
let aiSrv: Server | null = null
let aiPort = 0

/**
 * 第一次解析：三块 + 两条释义。
 * ★ 键照**现在这份提示词**抄（`prompts/analyse-item.md`，D-468 收窄之后）：
 *   正文那一块是 `inSentence`（`meaning` + `barriers` 合并而来），
 *   不再有 `pitfalls`。夹具跟着真链路走，否则用例绿着、真机上白花钱（I-112）。
 */
const FIRST = {
  gloss: 'to make something less severe',
  glossZh: '缓解',
  inSentence: 'first inSentence',
  chunks: ['a', 'b'],
  verbs: 'first verbs'
}
/** 第二次（重新分析）：同样三块，内容全换 */
const SECOND = {
  gloss: 'second gloss',
  glossZh: '第二版',
  inSentence: 'second inSentence',
  chunks: ['c'],
  verbs: 'second verbs'
}

before(async () => {
  await new Promise<void>((resolve) => {
    aiSrv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += String(c)))
      req.on('end', () => {
        if (mode === 'auth') {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"nope"}')
          return
        }
        const content =
          mode === 'notjson'
            ? 'I am afraid I cannot do that.'
            : JSON.stringify(
                mode === 'second' ? SECOND : mode === 'wrapped' ? { analysis: FIRST } : FIRST
              )
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content } }] }))
      })
    })
    aiSrv.listen(0, '127.0.0.1', () => {
      aiPort = (aiSrv!.address() as { port: number }).port
      resolve()
    })
  })
})
after(() => aiSrv?.close())

function armed(f: Fixture): void {
  const t = Date.now()
  const set = f.raw.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  )
  set.run('ai.light.baseUrl', `http://127.0.0.1:${aiPort}/v1`, t)
  set.run('ai.light.model', 'mock', t)
  set.run('ai.light.protocol', 'openai', t)
}

/** 假的「分析前同步」—— 记一次调用；② 层不真发网络 */
function fakeSync(): { calls: number; fn: (db: Db) => Promise<SyncNote> } {
  const box = {
    calls: 0,
    fn: (): Promise<SyncNote> => {
      box.calls += 1
      return Promise.resolve({ ran: true, note: '同步完成' })
    }
  }
  return box
}

const blocksOf = (f: Fixture, id: number): Record<string, { content: string; regen: number; edited: number }> => {
  const out: Record<string, { content: string; regen: number; edited: number }> = {}
  for (const r of f.raw
    .prepare(`select block, content, regen_count as regen, edited from analysis_blocks where item_id = ?`)
    .all(id) as { block: string; content: string; regen: number; edited: number }[]) {
    out[r.block] = { content: r.content, regen: r.regen, edited: r.edited }
  }
  return out
}
const events = (f: Fixture, id: number): { kind: string; detail: string }[] =>
  f.raw.prepare(`select kind, detail from item_events where item_id = ? order by id`).all(id) as {
    kind: string
    detail: string
  }[]

function ready(): Fixture {
  const f = builtDb()
  seed(f, { settings: {} })
  armed(f)
  mode = 'ok'
  return f
}

describe('A · 单条完整解析（Android 执行器）', () => {
  it('A-1 · 首次分析：块按 core 的名单落库 · item_events 记一行 analyzed（origin android）', async () => {
    const f = ready()
    const sync = fakeSync()
    assert.equal(await hasFullAnalysis(f.db, 1), false, '一块解析都没有')

    const r = await analyseItem(f.db, 1, { syncFirst: sync.fn })

    assert.equal(sync.calls, 1, '★ 分析前先同步一趟 —— 这条红了就是那一步被拆掉了')
    assert.equal(r.skipped, false)
    const b = blocksOf(f, 1)
    assert.deepEqual(Object.keys(b).sort(), ['chunks', 'inSentence', 'verbs'], 'gloss/glossZh 不当块存（R-002）')
    assert.equal(b['inSentence']!.content, 'first inSentence')
    assert.equal(b['chunks']!.content, JSON.stringify(['a', 'b']), '非字符串的块存 JSON')
    assert.deepEqual(Object.keys(b).filter((k) => !isRenderedBlock(k)), [], '落库的块详情页都认得')
    for (const k of Object.keys(b)) assert.equal(b[k]!.regen, 0, '第一次不是重来')

    // R-002 · 释义回写到条目上
    const it = f.raw.prepare(`select gloss, gloss_zh as z from items where id = 1`).get() as {
      gloss: string
      z: string
    }
    assert.equal(it.gloss, FIRST.gloss)
    assert.equal(it.z, FIRST.glossZh)
    assert.equal(r.gloss, 2)
    assert.equal(r.shown, 5, 'I-112 · 详情页认得的 = 三块 + 两条释义')

    const ev = events(f, 1)
    assert.equal(ev.length, 1)
    assert.equal(ev[0]!.kind, 'analyzed')
    const d = JSON.parse(ev[0]!.detail) as Record<string, unknown>
    assert.equal(d['origin'], 'android', '同步过去电脑要认得出这是手机做的')
    assert.equal(d['slot'], 'light')
    assert.equal(d['regen'], false)
    assert.ok(!('apiKey' in d) && !('baseUrl' in d), 'D-220 · 这张表会上云，不许带凭据')

    assert.equal(await hasFullAnalysis(f.db, 1), true)
  })

  it('A-2 · 重新分析：非 edited 块换新且 regen+1；★ edited=1 的块一个字不动（D-149）', async () => {
    const f = ready()
    const sync = fakeSync()
    await analyseItem(f.db, 1, { syncFirst: sync.fn })

    // 他手改了 meaning 那一块
    f.raw
      .prepare(`update analysis_blocks set content = '我自己写的', edited = 1 where item_id = 1 and block = 'inSentence'`)
      .run()

    mode = 'second'
    const r = await analyseItem(f.db, 1, { force: true, syncFirst: sync.fn })
    assert.equal(sync.calls, 2, '重新分析之前也要先同步')
    assert.equal(r.skipped, false)

    const b = blocksOf(f, 1)
    assert.equal(b['inSentence']!.content, '我自己写的', '★★ 手改过的一个字都不许动 —— 这条红了就是 edited 跳过被拆了')
    assert.equal(b['inSentence']!.regen, 0, '没重写的块 regen 不动')
    assert.equal(b['verbs']!.content, 'second verbs', '非 edited 块原地覆盖')
    assert.equal(b['verbs']!.regen, 1, 'regen_count + 1')
    assert.equal(b['chunks']!.content, JSON.stringify(['c']))
    assert.equal(b['chunks']!.regen, 1)
    assert.equal(Object.keys(b).length, 3, '不留版本 —— 旧的原地被换掉，不新增行')

    const it = f.raw.prepare(`select gloss from items where id = 1`).get() as { gloss: string }
    assert.equal(it.gloss, SECOND.gloss, '释义跟着更新（gloss 不是块，没有 edited 一说）')

    const ev = events(f, 1)
    assert.equal(ev.length, 2, '两次分析两行事件')
    assert.equal(JSON.parse(ev[1]!.detail)['regen'], true, '他亲手点的重新分析')
  })

  it('A-2b · 已有完整解析、又不是 force → 什么都不做（与 Windows 同）', async () => {
    const f = ready()
    const sync = fakeSync()
    await analyseItem(f.db, 1, { syncFirst: sync.fn })
    mode = 'second'
    const r = await analyseItem(f.db, 1, { syncFirst: sync.fn })
    assert.equal(r.skipped, true)
    assert.equal(r.written, 0)
    assert.equal(blocksOf(f, 1)['inSentence']!.content, 'first inSentence', '一个字没换')
    assert.equal(events(f, 1).length, 1, '没做就不记事件')
  })

  it('A-3 · 失败：401 与非 JSON 都抛人话，且库里零改动（事务）', async () => {
    const f = ready()
    const sync = fakeSync()
    await analyseItem(f.db, 1, { syncFirst: sync.fn })
    const before = { blocks: blocksOf(f, 1), events: events(f, 1).length }

    mode = 'auth'
    await assert.rejects(() => analyseItem(f.db, 1, { force: true, syncFirst: sync.fn }))
    assert.deepEqual(blocksOf(f, 1), before.blocks, '认证失败 —— 库里一个字没动')
    assert.equal(events(f, 1).length, before.events)

    mode = 'notjson'
    await assert.rejects(() => analyseItem(f.db, 1, { force: true, syncFirst: sync.fn }))
    assert.deepEqual(blocksOf(f, 1), before.blocks, '解不出 JSON —— 库里一个字没动')
    assert.equal(events(f, 1).length, before.events)
  })

  it('A-3b · I-112 · 模型多包一层 → force 时抛「详情页认不出来」，不假装成功', async () => {
    const f = ready()
    const sync = fakeSync()
    mode = 'wrapped'
    await assert.rejects(
      () => analyseItem(f.db, 1, { force: true, syncFirst: sync.fn }),
      /详情页认不出来/
    )
    // ★ 块**确实写进去了**（模型返回什么键就写什么）—— 这正是「成功的失败」的形状：
    //   没有报错、写入条数不是 0，而屏幕上一个字没变。所以判据数的是「认得几块」。
    assert.deepEqual(Object.keys(blocksOf(f, 1)), ['analysis'])
  })

  it('A-4 · 保存之后详情页读得到（read-path 同一条路）', async () => {
    const f = ready()
    await analyseItem(f.db, 1, { syncFirst: fakeSync().fn })
    const d = await loadItemDetail(f.db, 1)
    assert.deepEqual(
      d.blocks.map((b) => b.block).sort(),
      ['chunks', 'inSentence', 'verbs'],
      '详情页拿到的就是刚写的那三块'
    )
    assert.equal(d.item.gloss, FIRST.gloss, '释义也在条目上')
  })
})

// ── A-5 · 写下即同步（analysis_blocks / item_events 本来就在 SYNC_TABLES）──

const sha16 = async (text: string): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}
let tick = Date.now()
function portsFor(db: Db): EnginePorts {
  return {
    db,
    identity: async () => {
      const normalized = normalizeSchema(await readSyncSurface(db))
      const v = Number((await db.get(`pragma user_version`))?.['user_version'] ?? 0)
      return {
        schemaVersion: v,
        schemaFingerprint: await sha16(normalized),
        normalized,
        algo: FINGERPRINT_ALGO
      }
    },
    backup: () => Promise.resolve(),
    audio: { list: () => Promise.resolve([]), read: () => Promise.resolve(null), write: () => Promise.resolve() },
    secrets: { getSyncSecret: () => 's', setSyncSecret: () => {}, hasSyncSecret: () => true },
    clock: { now: () => (tick += 1500) },
    uuid: () => crypto.randomUUID()
  }
}

// 微型 dav（sync-engine.test.ts 同手法）
const davFiles = new Map<string, string>()
let davSrv: Server | null = null
let davPort = 0
async function davReady(): Promise<void> {
  if (davSrv) return
  await new Promise<void>((resolve) => {
    davSrv = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').replace(/\/+$/, ''))
      if (req.method === 'MKCOL') {
        const had = davFiles.has(`dir:${path}`)
        davFiles.set(`dir:${path}`, '')
        res.writeHead(had ? 405 : 201).end()
        return
      }
      if (req.method === 'PROPFIND') {
        const kids = [...davFiles.keys()].filter(
          (k) => !k.startsWith('dir:') && k.startsWith(path ? `${path}/` : '')
        )
        res.writeHead(207, { 'content-type': 'application/xml' }).end(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${kids
            .map((k) => `<D:response><D:href>/${k}</D:href></D:response>`)
            .join('')}</D:multistatus>`
        )
        return
      }
      if (req.method === 'GET') {
        const b = davFiles.get(path)
        if (b === undefined) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200).end(b)
        return
      }
      if (req.method === 'PUT') {
        let body = ''
        req.on('data', (c) => (body += String(c)))
        req.on('end', () => {
          davFiles.set(path, body)
          res.writeHead(201).end()
        })
        return
      }
      if (req.method === 'DELETE') {
        davFiles.delete(path)
        res.writeHead(204).end()
        return
      }
      res.writeHead(405).end()
    })
    davSrv.listen(0, '127.0.0.1', () => {
      davPort = (davSrv!.address() as { port: number }).port
      resolve()
    })
  })
}
after(() => davSrv?.close())

const conns: DatabaseSync[] = []
after(() => {
  for (const c of conns) {
    try {
      c.close()
    } catch {
      /* 已经关了 */
    }
  }
})

describe('A-5 · 手机分析出来的东西真的会同步回电脑', () => {
  it('推一趟之后，桶里有这一条的 analysis_blocks 与 item_events', async () => {
    await davReady()
    const f = ready()
    f.raw
      .prepare(
        `insert into settings (key, value, updated_at) values ('sync.device','ph-a',?)
           on conflict(key) do update set value = excluded.value`
      )
      .run(Date.now())
    await analyseItem(f.db, 1, { syncFirst: fakeSync().fn })

    const e = new SyncEngine(portsFor(f.db))
    await e.saveConfig({
      kind: 'webdav',
      url: `http://127.0.0.1:${davPort}/a5`,
      user: 'u',
      secret: 's'
    })
    const r = await e.run()
    assert.equal(r.failed, 0, r.lastNote)
    assert.ok(r.pushed > 0, `一行都没推：${r.lastNote}`)

    const bodies = [...davFiles.entries()]
      .filter(([k]) => k.startsWith('a5/') && k.endsWith('.json'))
      .map(([, v]) => v)
      .join('\n')
    assert.ok(bodies.includes('analysis_blocks'), '★ 解析块进了桶')
    assert.ok(bodies.includes('item_events'), '★ 来源记录也进了桶')
    assert.ok(bodies.includes('first inSentence'), '桶里就是刚写的那一块')
    assert.ok(bodies.includes('android'), 'origin 跟着走 —— 电脑那边分得清是谁写的')
  })
})
