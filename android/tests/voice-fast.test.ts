/**
 * VF · **Assist 语音快路径**（T-6.6 · P0）
 *
 * ══ 它防的是哪一件已经发生过的事 ═══════════════════════════
 *
 * 会话 C 在真机 6ccc1ca9 上量到（2026-09-06）：词典**未命中**时，发音要把启用的
 * 15 本全部现开 = **53.4 秒**；连点三次排到 142.6 秒，期间引擎 JS 线程整个堵死。
 * 而 T-7.5 给词典那一步的预算是 **150 ms** —— 它没起作用，因为
 * `runVoicePlan` 用 `Promise.race` + `setTimeout` 掐，而 `DictionaryIO.read`
 * 是**同步** JS→Java 调用：同步循环不让出事件循环，那个 `setTimeout` 永远不触发。
 *
 * ── 这一组怎么复现它 ────────────────────────────────────────
 *
 * 注一个**同步 sleep** 的 `DictionaryIO`（每次 `open` 阻塞 200 ms）——
 * 那正是真机上「开一本书」的形状：同步、不让出、`setTimeout` 掐不断。
 * 于是「预算有没有真的生效」在 node 上就能证伪，不必等装机。
 *
 * 钉四条（每条都对应一个已经量到的数字）：
 *   ① 预算真的生效 —— 15 本、每本 200 ms，也要在 ~一本的时间内回答（`deadlineHit`）
 *   ② 没有音频卷的书**一本都不开** —— 那个「有 audio 能力」的标记就是同名数字卷
 *   ③ 命中仍然快 —— 默认书排头，命中那一趟只开它一本
 *   ④ 预热之后**首次发音一本都不用现开**（第二段）—— 否则未命中那趟仍是「一本冷开」
 *     （真机约 3.5 秒），达不到「与 A 组差 ≤ 200 ms」那条完成标准
 *   ⑤ 预热那本**扛得住中间的查词**（第三段）—— 预热与首次发音之间他会查词，
 *     `lookupDicts` 逐本开进 `MDX_CACHE_MAX = 2` 的 LRU；没钉住的话预热那本正好被挤掉，
 *     首次发音又变回一本冷开。★ 主控 2026-09-06 的负向对照发现：钉在代码里，
 *     但**没有任何用例守着它** —— 把钉拆掉 233/233 照样全绿。VF-7 就是补这个洞
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMdx } from '../nyx-core/tests/make-mdx.ts'
import {
  dictPronounce,
  dropDictCache,
  listDicts,
  lookupDicts,
  pinDictionary,
  prewarmPronounce,
  pronStats,
  pronounceOrder,
  scanDictFolder,
  setDictIoProvider,
  type FolderFile
} from '../src/db/dict.ts'
import { prefSet } from '../src/db/prefs.ts'
import type { DictionaryIO, FileHandle } from '../src/core-link.ts'
import { builtDb, cleanup } from './helpers.ts'
import { readFileSync, statSync } from 'node:fs'

const dir = mkdtempSync(join(tmpdir(), 'nyx-vf-'))
after(() => {
  dropDictCache()
  setDictIoProvider(null)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录 */
  }
  cleanup()
})

/** 一本带词头发音链接的书（正文里那条 `sound://hwd/...` 是发音链的入口） */
const bookPath = join(dir, 'src.mdx')
writeMdx(
  bookPath,
  [{ word: 'use', body: '<a href="sound://hwd/bre/c/use_v0205.mp3">uk</a> use' }],
  { title: 'Src', version: '2.0', encoding: 'UTF-8' }
)
/** 与书同名的数字卷 —— `soundVolumesOf` 认的就是这个文件名形状 */
const volPath = join(dir, 'src.1.mdd')
writeMdx(volPath, [{ word: '\\hwd\\bre\\c\\use_v0205.mp3', body: 'FAKE-MP3' }], {
  title: 'vol',
  version: '2.0',
  encoding: 'UTF-16'
})

/**
 * ★★ 同步 sleep 的 io —— **这就是真机那条路的形状**。
 *
 * `open` 每次阻塞 `perOpenMs`（默认 200，真机实测每本约 3.5 秒，这里按比例缩）。
 * 同步阻塞意味着事件循环不转 —— `Promise.race` 里那个 `setTimeout` 没有机会跑，
 * 所以预算**只能**靠 `dictPronounce` 自己在两本之间看表。
 */
function slowIo(perOpenMs = 200): { io: (uri: string) => DictionaryIO; opens: number } {
  const box = {
    opens: 0,
    io: (uri: string): DictionaryIO => ({
      open(path: string): FileHandle {
        box.opens += 1
        const until = Date.now() + perOpenMs
        while (Date.now() < until) {
          /* 同步阻塞：不让出事件循环 —— 正是它让 setTimeout 掐不断 */
        }
        return { path, size: statSync(real(uri)).size }
      },
      read(_h: FileHandle, at: number, len: number): Uint8Array {
        const b = readFileSync(real(uri))
        return new Uint8Array(b.subarray(at, Math.min(at + len, b.length)))
      },
      close(): void {}
    })
  }
  return box
}
/** 十五个不同的 uri 都指向同一份真书 / 真卷 —— 只是为了造出「启用了很多本」 */
const real = (uri: string): string => (uri.endsWith('.mdd') ? volPath : bookPath)

/** 造 n 本书；`withVol` 里的那几本另带一个同名数字卷 */
function folder(n: number, withVol: number[]): FolderFile[] {
  const out: FolderFile[] = []
  for (let i = 0; i < n; i++) {
    out.push({ name: `b${i}.mdx`, uri: `${dir}/b${i}.mdx`, size: 1 })
    if (withVol.includes(i)) out.push({ name: `b${i}.1.mdd`, uri: `${dir}/b${i}.1.mdd`, size: 1 })
  }
  return out
}

describe('VF · Assist 语音快路径（T-6.6）', () => {
  it('VF-1 · 预算真的生效：15 本 × 200 ms，也在「一本」的时间内回答', async () => {
    const f = builtDb()
    const files = folder(15, [...Array(15).keys()]) // 15 本全有音频卷（最坏情形）
    const io = slowIo(200)
    setDictIoProvider(io.io)
    try {
      await scanDictFolder(f.db, files)
      dropDictCache() // 扫描留下的缓存清掉 —— 量的是冷开
      io.opens = 0

      const t0 = Date.now()
      const hit = await dictPronounce(f.db, 'nosuchword', false, { budgetMs: 150 })
      const took = Date.now() - t0

      assert.equal(hit, null, '没这个词 —— 如实 miss')
      assert.equal(pronStats.deadlineHit, true, '★ 被预算掐断了，就要说被掐断了')
      assert.ok(
        pronStats.opened <= 1,
        `★★ 开了 ${pronStats.opened} 本 —— 预算没生效（真机上这就是 53 秒那一下）`
      )
      assert.ok(
        took < 1000,
        `★★ 用了 ${took}ms —— 同步循环里没看表，setTimeout 掐不断它（这条红=回到审计前）`
      )
      assert.ok(pronStats.skipped >= 13, `没开的应当被如实记成 skipped，现在 ${pronStats.skipped}`)
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('VF-2 · 没有音频卷的书一本都不开（「标了 audio 能力」= 同名数字卷）', async () => {
    const f = builtDb()
    const files = folder(15, [7]) // 只有第 8 本有卷
    const io = slowIo(5)
    setDictIoProvider(io.io)
    try {
      await scanDictFolder(f.db, files)
      dropDictCache()
      io.opens = 0

      await dictPronounce(f.db, 'nosuchword', false, { budgetMs: 5000 })

      assert.equal(pronStats.books, 1, '★ 只该问有音频卷的那一本')
      assert.equal(pronStats.skipped, 14, '其余 14 本如实记成 skipped')
      assert.ok(
        io.opens <= 2,
        `★★ 开了 ${io.opens} 次 —— 没有音频卷的书被白开了索引（这正是 15 本全扫的成因）`
      )
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('VF-3 · 命中仍然快：默认书排头，命中那一趟只开它一本', async () => {
    const f = builtDb()
    // 三本都有卷；把最后一本设成默认 —— 它应当被排到最前面
    const files = folder(3, [0, 1, 2])
    const io = slowIo(120)
    setDictIoProvider(io.io)
    try {
      await scanDictFolder(f.db, files)
      const rows = (await import('../src/db/dict.ts')).listDicts
      const all = await rows(f.db)
      const last = all.at(-1)!
      await prefSet(f.db, 'dict.default', last.uid!)
      dropDictCache()
      io.opens = 0

      const hit = await dictPronounce(f.db, 'use', false, { budgetMs: 1000 })

      assert.ok(hit, '默认书里有这个词的词头音，应当命中')
      assert.equal(pronStats.hitAt, 1, '★ 命中在第 1 本 —— 默认书没排到最前面')
      assert.equal(pronStats.deadlineHit, false, '命中这一趟不该被掐')
      assert.equal(pronStats.opened, 1, `命中只该开一本，现在 ${pronStats.opened}`)
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('VF-4 · 顺序判据是纯函数：没有卷的滤掉、默认书排头（不碰库）', () => {
    const mk = (i: number, uid: string): Parameters<typeof pronounceOrder>[0][number] => ({
      id: i,
      uri: `${dir}/b${i}.mdx`,
      bookname: `b${i}`,
      wordCount: 1,
      enabled: true,
      sortOrder: i,
      missing: false,
      status: 'ok',
      diagnostic: null,
      uid
    })
    const rows = [mk(0, 'u0'), mk(1, 'u1'), mk(2, 'u2')]
    const files = folder(3, [1, 2])

    assert.deepEqual(
      pronounceOrder(rows, files, null).map((d) => d.bookname),
      ['b1', 'b2'],
      '没有数字卷的 b0 根本不该进来'
    )
    assert.deepEqual(
      pronounceOrder(rows, files, 'u2').map((d) => d.bookname),
      ['b2', 'b1'],
      '默认书排头'
    )
    assert.deepEqual(
      pronounceOrder(rows, files, 'u0').map((d) => d.bookname),
      ['b1', 'b2'],
      '默认书自己没有卷 —— 就按原顺序，不为它破例'
    )
  })

  it('VF-5 · 预热之后首次发音不再冷开（预热的正是「发音会先问的那一本」）', async () => {
    const f = builtDb()
    const files = folder(3, [0, 1, 2]) // 三本都有音频卷
    const io = slowIo(200)
    setDictIoProvider(io.io)
    try {
      await scanDictFolder(f.db, files)
      const all = await listDicts(f.db)
      await prefSet(f.db, 'dict.default', all.at(-1)!.uid!) // 默认书 = 最后一本
      dropDictCache() // 扫描留下的缓存清掉 —— 量的是冷开
      io.opens = 0

      const w = await prewarmPronounce(f.db)

      assert.ok(w, '三本都带音频卷 —— 应当预热一本')
      assert.equal(w.err, null, `预热不该出错：${w.err}`)
      assert.equal(w.opened, true, '冷启动这一次，预热是真的开了索引')
      assert.equal(io.opens, 1, `★ 预热只许开一本，现在开了 ${io.opens} 本`)

      /**
       * ★★ `opened === false` 是什么意思 —— 真机 2026-09-07 那一行
       *   `dict prewarm … opened=false 15ms` 让人猜了一轮，所以钉在这里：
       *   **它本来就在缓存里**（之前查过词典页或发过音），这一趟只负责钉住。
       *   探针从此把两种印成不同的词（`opened=true` / `cached=true`）。
       */
      const again = await prewarmPronounce(f.db)
      assert.equal(again?.opened, false, '第二趟不该再开一次 —— 它已经在缓存里了')
      assert.equal(io.opens, 1, '★ 而且**真的一次文件都没再开**，不只是标志位改了')

      // ── 这才是要钉的那一句：首次发音一本都不用现开 ──
      const hit = await dictPronounce(f.db, 'use', false, { budgetMs: 150 })

      assert.ok(hit, '默认书里有词头音，应当命中')
      assert.equal(
        pronStats.opened,
        0,
        `★★ 首次发音又现开了 ${pronStats.opened} 本 —— 预热没落在发音会先问的那一本上`
      )
      assert.equal(pronStats.hitAt, 1, '命中仍在第 1 本（默认书排头）')
      assert.equal(pronStats.deadlineHit, false, '索引本该已经在，150 ms 预算下不该被掐')
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('VF-6 · 没有一本带音频卷时，预热什么都不做（预热了也永远发不出音）', async () => {
    const f = builtDb()
    const files = folder(3, []) // 三本书，一个数字卷都没有
    const io = slowIo(200)
    setDictIoProvider(io.io)
    try {
      await scanDictFolder(f.db, files)
      dropDictCache()
      io.opens = 0

      assert.equal(await prewarmPronounce(f.db), null, '一本都排不出来 —— 如实什么都不做')
      assert.equal(io.opens, 0, `★ 一本都不该开，现在开了 ${io.opens} 本`)
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('VF-7 · 预热那本扛得住中间的查词（不钉就会被 LRU 挤掉）', async () => {
    const f = builtDb()
    // 四本都有音频卷；默认书 = **第一本**（不是最后一本）——
    // 这样中间那趟查词是在它之后才逐本开的，挤不挤得掉它才分得出来
    const files = folder(4, [0, 1, 2, 3])
    const io = slowIo(50)
    setDictIoProvider(io.io)
    try {
      await scanDictFolder(f.db, files)
      const all = await listDicts(f.db)
      await prefSet(f.db, 'dict.default', all[0]!.uid!)
      dropDictCache()
      pinDictionary(null) // 上一条用例钉过 —— 这条从「什么都没钉」开始，不吃别人的状态
      io.opens = 0

      await prewarmPronounce(f.db)
      assert.equal(io.opens, 1, `预热只开一本，现在 ${io.opens}`)

      // ★ 中间这一趟就是他在气泡里查词：逐本开，`MDX_CACHE_MAX = 2` 的 LRU 开始换人
      await lookupDicts(f.db, 'nosuchword') // 没命中 → 四本都要开，不会提前 break
      assert.ok(
        io.opens >= 4,
        `查词该把别的书开进缓存，现在总共才开了 ${io.opens} 次 —— 这条用例没造出挤压`
      )

      const hit = await dictPronounce(f.db, 'use', false, { budgetMs: 150 })

      assert.ok(hit, '默认书里有词头音，应当命中')
      assert.equal(
        pronStats.opened,
        0,
        `★★ 首次发音又现开了 ${pronStats.opened} 本 —— 预热那本被中间的查词挤掉了（钉没生效）`
      )
      assert.equal(pronStats.hitAt, 1, '命中仍在第 1 本')
    } finally {
      setDictIoProvider(null)
      dropDictCache()
      pinDictionary(null)
    }
  })
})
