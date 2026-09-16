/**
 * 本地词典对照（DT-1 ～ DT-4 · D-401 词典批）。
 * 夹具 = Windows 仓库 tests/make-mdx.ts **真造**的 .mdx（同一套字节，不是简化版）；
 * 解析 = core/dict/mdx.ts 同一份（这里注入 fs 字节源 + fflate —— 与真机唯一的
 * 差别就是字节从哪来，正是 D-238 说的那一层）。钉：
 *   ① 扫描登记进 dictionaries 表（书名/词数来自真解析；坏文件如实记 diagnostic）
 *   ② 查词命中返回压平正文 ③ assistLookup dict 分支：词典节按书名标注 ④ 停用即跳过
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMdx } from '../nyx-core/tests/make-mdx.ts'
import {
  listDicts,
  lookupCard,
  lookupDicts,
  problemLine,
  reorderDicts,
  scanDictFolder,
  setDictBytesProvider,
  setDictIoProvider,
  setDictEnabled,
  dictSoundBytes,
  dropDictCache,
  type FolderFile,
  hwdSoundLinks,
  parseEntryLink,
  stripDictScripts,
  b64of
} from '../src/db/dict.ts'
import { nativeDictIo, type NativeDictHost } from '../src/db/dict-io.ts'
import { statSync, openSync, readSync, closeSync } from 'node:fs'
import type { DictionaryIO, FileHandle } from '../src/core-link.ts'
import { assistLookup } from '../src/db/lookup.ts'
import { builtDb, cleanup, seed } from './helpers.ts'

const dir = mkdtempSync(join(tmpdir(), 'nyx-dict-'))
after(() => {
  dropDictCache()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录 */
  }
  cleanup()
})

// 与真机唯一的差别：字节源（真机 = SAF content:// + fetch；这里 = fs）
setDictBytesProvider((uri) => Promise.resolve(new Uint8Array(readFileSync(uri))))

const mdxPath = join(dir, 'mini.mdx')
writeMdx(
  mdxPath,
  [
    { word: 'stairwell', body: '<b>stairwell</b> n. 楼梯间<br>the space of a staircase' },
    { word: 'octopus', body: 'octopus n. 章鱼' },
    // 变体词目 = 指路条（真词典里占大头：朗文6 80.4%）—— 查它要跟到 octopus
    { word: 'octopuses', body: '@@@LINK=octopus' },
    { word: 'serendipity', body: 'serendipity n. 意外发现珍宝的运气' },
    // 词典自带脚本（朗文6 每条都引 .js）—— 渲染面开了 JS，脚本必须在判据层剥掉
    { word: 'scripty', body: '<b>ok</b><script src="x.js"></script><script>alert(1)</script>tail' }
  ],
  { title: 'Mini 英汉', version: '2.0', encoding: 'UTF-8' }
)
// 音频数字卷（朗文6英汉双解.1.mdd 的迷你版）：.mdd = 键 UTF-16LE + 原始字节正文，
// writeMdx 的 UTF-16 模式造出来的容器与真卷同构（core 同一个读法）
const volPath = join(dir, 'mini.1.mdd')
writeMdx(
  volPath,
  [
    { word: '\\exa\\bre\\a\\p008-001.mp3', body: 'FAKE-MP3-EXA' },
    { word: '\\hwd\\bre\\c\\use_v0205.mp3', body: 'FAKE-MP3-BRE' }
  ],
  { title: 'vol', version: '2.0', encoding: 'UTF-16' }
)
writeFileSync(join(dir, 'broken.mdx'), Buffer.from('not a dictionary at all'))
// mdx 制作工具的占位标题 —— 书名要退回文件名（真机 Eudic 夹撞到过 3 本）
writeMdx(join(dir, 'GreatDict.mdx'), [{ word: 'aa', body: 'aa!' }], {
  title: 'Title (No HTML code allowed)',
  version: '2.0',
  encoding: 'UTF-8'
})

const FILES: FolderFile[] = [
  { name: 'mini.mdx', uri: mdxPath, size: 0 },
  { name: 'broken.mdx', uri: join(dir, 'broken.mdx'), size: 0 },
  { name: 'GreatDict.mdx', uri: join(dir, 'GreatDict.mdx'), size: 0 }
]

describe('DT · 本地词典', () => {
  it('DT-1 · 扫描：真解析登记书名/词数；坏文件如实记 diagnostic 不静默', async () => {
    const f = builtDb()
    const r = await scanDictFolder(f.db, FILES)
    assert.equal(r.ok, 2)
    assert.equal(r.failed, 1)
    const rows = await listDicts(f.db)
    assert.equal(rows.length, 3)
    const mini = rows.find((x) => x.bookname === 'Mini 英汉')!
    assert.equal(mini.wordCount, 5, '词数来自真解析，不是文件名猜的')
    assert.equal(mini.status, 'ok')
    const bad = rows.find((x) => x.status === 'error')!
    assert.ok(bad.diagnostic, '坏文件的原因写在行上（设置页直说）')
    assert.ok(
      rows.some((x) => x.bookname === 'GreatDict'),
      '占位标题（No HTML code allowed）退回文件名'
    )
  })

  it('DT-2 · 查词：命中返回压平正文；再扫描后失踪标记生效', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, FILES)
    const hits = await lookupDicts(f.db, 'stairwell')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.book, 'Mini 英汉')
    assert.ok(hits[0]!.text.includes('楼梯间'), 'HTML 压平后中文正文在')
    assert.equal((await lookupDicts(f.db, 'notaword')).length, 0)

    await scanDictFolder(f.db, [FILES[0]!]) // broken 不在夹里了
    const rows = await listDicts(f.db)
    assert.equal(rows.find((x) => x.status === 'error')!.missing, true)
  })

  it('DT-3 · assistLookup dict 分支：词典节按书名标注；词典+库内并存', async () => {
    const f = builtDb()
    seed(f) // term-1 有库内 gloss
    await scanDictFolder(f.db, [FILES[0]!])
    const r1 = await assistLookup(f.db, 'dict', 'octopus', null)
    assert.equal(r1.miss ?? false, false)
    assert.deepEqual(
      r1.sections.map((s) => s.label),
      ['Mini 英汉']
    )
    const r2 = await assistLookup(f.db, 'dict', 'zzz-none', null)
    assert.equal(r2.miss, true)
    assert.ok(r2.note?.includes('词典没命中'), '装了词典后的 miss 话术不再说「没装」')
  })

  it('DT-5 · @@@LINK 变体重定向要跟随（真机 2026-08-30：不跟随就只显示指路条）', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, [FILES[0]!])
    const hits = await lookupDicts(f.db, 'octopuses')
    assert.equal(hits.length, 1)
    assert.ok(hits[0]!.text.includes('章鱼'), '跟到目标词条的正文')
    assert.ok(!hits[0]!.text.includes('@@@LINK'), '指路条本身绝不上屏')
    assert.ok(hits[0]!.html?.includes('章鱼'), 'html 也是目标词条的（词典自己的结构）')
  })

  it('DT-8 · 拖动排序（D-361）：sort_order 整表落库，命中顺序跟着走', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, FILES)
    const before = await listDicts(f.db)
    assert.equal(before[0]!.bookname, 'Mini 英汉', '扫描序 = 插入序')
    // 把最后一本拖到最前
    const ids = before.map((x) => x.id)
    const last = ids.pop()!
    await reorderDicts(f.db, [last, ...ids])
    const after = await listDicts(f.db)
    assert.equal(after[0]!.id, last, '新第一本')
    assert.deepEqual(
      after.map((x) => x.id),
      [last, ...ids],
      '整表新序'
    )
    assert.deepEqual(
      after.map((x) => x.sortOrder),
      [1, 2, 3],
      'sort_order 重新编号'
    )
    // 复原（别影响后面的用例）
    await reorderDicts(f.db, ids.concat(last))
  })

  it('DT-4 · 停用的书不参与查词', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, [FILES[0]!])
    const mini = (await listDicts(f.db))[0]!
    await setDictEnabled(f.db, mini.id, false)
    assert.equal((await lookupDicts(f.db, 'octopus')).length, 0)
    await setDictEnabled(f.db, mini.id, true)
    assert.equal((await lookupDicts(f.db, 'octopus')).length, 1)
  })
})

describe('DT-5 · 发音链接解析（D-406④ —— 键从词条 sound:// 拿，不从文件名正推）', () => {
  // 四个词的真实词条链形（真机 .mdx 实探）：变体号 / 词性后缀 / l3 / ld41 前缀全在
  it('bre/ame 各取第一条 hwd 链接', () => {
    const html =
      '<a href="sound://hwd/bre/c/use_v0205.mp3">uk</a>' +
      '<a href="sound://hwd/ame/1/l3use.mp3">us</a>' +
      '<a href="sound://exa/bre/a/p008-001620175.mp3">例句</a>'
    assert.deepEqual(hwdSoundLinks(html), { bre: 'hwd/bre/c/use_v0205.mp3', ame: 'hwd/ame/1/l3use.mp3' })
  })
  it('ld41 前缀 · 只有一种口音也行', () => {
    const html = '<a href="sound://hwd/bre/9/ld41serendipity.mp3"></a>'
    assert.deepEqual(hwdSoundLinks(html), { bre: 'hwd/bre/9/ld41serendipity.mp3', ame: null })
  })
  it('例句音（exa/）与非 hwd 路径不取', () => {
    const html = '<a href="sound://exa/bre/f/p008.mp3"></a><a href="sound://img/x.png"></a>'
    assert.deepEqual(hwdSoundLinks(html), { bre: null, ame: null })
  })
  it('重复链接只取第一条（词条里常见同链多次）', () => {
    const html =
      '<a href="sound://hwd/bre/8/flexible0205.mp3"></a>' +
      '<a href="sound://hwd/bre/8/flexible0205.mp3"></a>' +
      '<a href="sound://hwd/ame/e/flexible.mp3"></a>'
    const r = hwdSoundLinks(html)
    assert.equal(r.bre, 'hwd/bre/8/flexible0205.mp3')
    assert.equal(r.ame, 'hwd/ame/e/flexible.mp3')
  })
  it('b64of 与 Buffer 逐字节一致（含 8192 分片边界）', () => {
    const sizes = [0, 1, 8191, 8192, 8193, 20000]
    for (const n of sizes) {
      const b = new Uint8Array(n)
      for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) & 0xff
      assert.equal(b64of(b), Buffer.from(b).toString('base64'), `n=${n}`)
    }
  })
})

describe('DT-6 · 词条链接活化（阶段 7 第一件 —— 判据一份在 dict.ts）', () => {
  // 三种链形全部来自真机 .mdx 实探（use / happy / used to，2026-08-31）
  it('parseEntryLink · 同页锚（entry://#…）→ word=null', () => {
    const r = parseEntryLink('entry://#6504937708254a64972bf4d4ccdfcc9d_LDOCE6_use_1')
    assert.deepEqual(r, { word: null, anchor: '6504937708254a64972bf4d4ccdfcc9d_LDOCE6_use_1' })
  })
  it('parseEntryLink · 跨词条 + URL 编码的词（entry://used%20to#…）', () => {
    const r = parseEntryLink('entry://used%20to#6504937708254a64972bf4d4ccdfcc9d_used_to')
    assert.deepEqual(r, { word: 'used to', anchor: '6504937708254a64972bf4d4ccdfcc9d_used_to' })
  })
  it('parseEntryLink · 纯词无锚 / 非 entry 协议', () => {
    assert.deepEqual(parseEntryLink('entry://satisfied'), { word: 'satisfied', anchor: null })
    assert.equal(parseEntryLink('sound://hwd/bre/c/use_v0205.mp3'), null)
    assert.equal(parseEntryLink('#plain'), null)
  })
  it('stripDictScripts · 成对/自闭/带 src 的全剥，正文一个字不动', () => {
    const html = '<b>ok</b><script src="x.js"></script><script>alert(1)</script>tail<script defer>'
    const out = stripDictScripts(html)
    assert.equal(out, '<b>ok</b>tail')
  })
  it('查词命中的 html 已剥词典脚本、附我们的部件开关（两个渲染面开 JS 的前提）', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, FILES)
    const hits = await lookupDicts(f.db, 'scripty')
    assert.equal(hits.length, 1)
    const html = hits[0]!.html!
    assert.ok(html.includes('tail'), '正文还在')
    assert.ok(!html.includes('alert(1)') && !html.includes('x.js'), '词典脚本一个不剩')
    assert.ok(html.includes('popup-button'), '尾部附了我们的弹层方框开关（同一份喂两面）')
  })
})

// 模拟原生那侧的端口：fs 上的真随机读（与真机唯一差别 = 字节从哪来）
const fsIo = (uri: string): DictionaryIO => ({
  open(path: string): FileHandle {
    return { path, size: statSync(uri).size }
  },
  read(_h: FileHandle, at: number, len: number): Uint8Array {
    const fd = openSync(uri, 'r')
    try {
      const b = Buffer.alloc(len)
      const n = readSync(fd, b, 0, len, at)
      return new Uint8Array(b.subarray(0, n))
    } finally {
      closeSync(fd)
    }
  },
  close(): void {}
})

/**
 * ══ T-5.10 · 随机读通道 · 不吞错 · 无声排除 ══════════════════════
 *
 * 这一组钉的是**病**，不是实现：使用者报的「词典显示不出来、也不说为什么」
 * 有三个来源，每一个都要有一条用例，而且每一条都带负向对照。
 */
describe('DT-9 · 读不了 ≠ 没这个词（T-5.10 (b)：hitOf 不许再吞异常）', () => {
  it('扫描时能开、查词时开不了 → 说「这本读不了」+ core 的话术，不是「这本里没有」', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, [FILES[0]!]) // 这一刻文件是好的，登记 status=ok
    dropDictCache()
    /**
     * ★ 真机形状：大书在 App 侧整本进内存装不下 / 权限掉了 / 文件被挪走 ——
     *   扫描当时好好的，查词那一刻才炸。旧代码在这里 `catch { return null }`，
     *   屏幕上于是写着「这本里没有」。
     */
    setDictBytesProvider(() => Promise.reject(new Error('读不了词典文件（HTTP 403）')))
    try {
      const card = await lookupCard(f.db, 'stairwell')
      assert.equal(card.hit, null, '确实没拿到词条')
      assert.ok(card.problem, '★★ 必须说得出为什么 —— 这一条红了就是又开始吞错了')
      assert.equal(card.problem!.book, 'Mini 英汉')
      assert.ok(card.problem!.says.length > 0, '话术来自 core/dict/diagnostics.ts')
      assert.equal(card.problem!.recognized, false, 'Mdx 抛的是裸 Error → 走 core 的兜底分类')
      assert.ok(
        problemLine(card.problem!).includes('HTTP 403'),
        'core 还没认出来的时候，词典自己报的原话要摆出来（否则只剩「原因还没认出来」）'
      )
    } finally {
      setDictBytesProvider((uri) => Promise.resolve(new Uint8Array(readFileSync(uri))))
      dropDictCache()
    }
  })

  it('真的没这个词 → problem 是 null（两态分得开，才叫说了真话）', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, [FILES[0]!])
    const card = await lookupCard(f.db, 'notaword-at-all')
    assert.equal(card.hit, null)
    assert.equal(card.problem, null, '没命中就是没命中 —— 不许反过来编一个「读不了」')
  })
})

describe('DT-10 · 坏书被排除要说出来（T-5.10 (c)：无声排除）', () => {
  it('status=error 的书进 skipped，并带扫描时落库的 core 话术', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, FILES) // broken.mdx 会 status=error
    const card = await lookupCard(f.db, 'stairwell')
    assert.ok(card.hit, '好书照常命中')
    const sk = card.skipped.find((s) => s.book === 'broken')
    assert.ok(sk, '★ 被排除的那本必须报出来 —— 这一条红了就是又无声排除了')
    assert.ok(sk!.says.length > 0, '为什么排除，说得出来')
  })

  it('扫描落库的 diagnostic 是 core 的话术，不是裸异常（D-262 的 Android 版）', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, FILES)
    const bad = (await listDicts(f.db)).find((x) => x.status === 'error')!
    assert.ok(
      bad.diagnostic!.includes('这本词典装不起来'),
      'says 来自 core/dict/diagnostics.ts::fromUnknownError'
    )
    assert.ok(bad.diagnostic!.includes('词典报的原话'), '词典自己那句也没丢')
  })
})

describe('DT-11 · 随机读通道：App 与引擎装的是同一个 DictionaryIO（T-5.10 (a)(d)）', () => {
  it('nativeDictIo（原生 host 形状）读得出词条，且 nyxDb.dictIo 报 random', async () => {
    const f = builtDb()
    /**
     * 直接用**产品代码**的 `nativeDictIo` —— 只把原生那半换成 fs：
     * 真机上 `dictSize/dictRead` 由 `DictFiles.java` 实现，
     * 引擎（nyxHost）与 App（nyxDictHost）挂的是同一份。
     */
    const host = (uri: string): NativeDictHost => ({
      dictSize: () => statSync(uri).size,
      dictRead: (_u: string, at: number, len: number) => {
        const fd = openSync(uri, 'r')
        try {
          const b = Buffer.alloc(len)
          const n = readSync(fd, b, 0, len, at)
          return b.subarray(0, n).toString('base64')
        } finally {
          closeSync(fd)
        }
      }
    })
    setDictIoProvider((uri) => nativeDictIo(host(uri), uri))
    try {
      assert.equal(
        ((globalThis as unknown as Record<string, { dictIo?: string }>)['nyxDb'] ?? {}).dictIo,
        'random',
        '③ 档验收变量：接上了就报 random（报 memory = 原生通道没挂上）'
      )
      await scanDictFolder(f.db, [FILES[0]!])
      const card = await lookupCard(f.db, 'stairwell')
      assert.ok(card.hit?.text.includes('楼梯间'), '整本没进内存也查得到')
      assert.equal(card.problem, null)
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })
})

describe('DT-7 · 词条内 sound:// 音频（随机读数字卷 —— 现在两侧都有）', () => {

  it('键逐字来自链接：hwd 与 exa 都按需读得出；不存在的键如实 null', async () => {
    const f = builtDb()
    await scanDictFolder(f.db, [FILES[0]!, { name: 'mini.1.mdd', uri: volPath, size: 0 }])
    setDictIoProvider(fsIo)
    try {
      const bre = await dictSoundBytes(f.db, 'hwd/bre/c/use_v0205.mp3')
      assert.ok(bre, '词头音频键命中')
      assert.ok(
        Buffer.from(bre, 'base64').toString('utf16le').startsWith('FAKE-MP3-BRE'),
        '字节逐位就是卷里存的那块'
      )
      const exa = await dictSoundBytes(f.db, 'exa/bre/a/p008-001.mp3')
      assert.ok(exa, '例句音频同一条路')
      assert.equal(await dictSoundBytes(f.db, 'hwd/ame/zzz.mp3'), null, '没有就说没有')
    } finally {
      dropDictCache()
    }
  })
})
