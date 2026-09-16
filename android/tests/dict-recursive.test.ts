/**
 * DR · **词典文件夹递归扫描 + 跳过项说出来**（T-5.16）
 *
 * ══ 它防的是哪一件已经发生过的事 ═══════════════════════════
 *
 * 会话 C 在真机上查明使用者「有些词典没显示出来」的真正原因（2026-09-06）：
 * `/sdcard/Eudic dictionary/` 顶层 16 个 `.mdx` 全在库里，**四个子目录里的 6 本
 * （合计约 1.1 GB 数字卷）一本都没被扫到，也没有任何一句话说它们被跳过了**。
 * 根因 `DictPlugin.java::listFolder`：只列第一层、不查 MIME、把子目录与
 * `config.ini` 一起静默 `continue`。
 *
 * ── 这一组钉四条 ─────────────────────────────────────────
 *   ① 子目录里的书也进库 —— 假树 22 本（16 顶层 + 两层子目录里 6 本），
 *      跳过的项数与说法对得上（负向对照：只喂顶层 = 递归被拆掉 → 16 本 → 红）
 *   ② **卷不串** —— 两个目录里各有一本同名的书，各拿各的音频卷。**比字节**，
 *      不比条数（负向对照：拆掉同目录限定 → 后一本拿到前一本的卷 → 红）
 *   ③ **样式也不串** —— 同一条理由的第三处伴生匹配（散 `.css`）
 *   ④ 分类判据是纯函数：`._` 与非词典文件归「跳过」，没看全的三种情形都说得出
 *   ⑤ **I-159 · 旧行退役**：跳过规则补上之后，库里那条「本来就不是词典」的旧行
 *      要退役成「不是词典」，而不是永远挂着「失踪 · 不在夹里了」——
 *      那句话是假的（它就在夹子里）。行不删（D-216），书目不列，诊断查得到
 *
 * ★ 原生那一层 T-5.16 起**一条都不筛**（连 `config.ini` 都回来）——
 *   判据与话术在 `classifyDictFiles`，所以这一组在 node 上就跑得动，不必等装机。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeMdx } from '../nyx-core/tests/make-mdx.ts'
import {
  classifyDictFiles,
  dictPronounce,
  dictSkipped,
  dropDictCache,
  fileNameOfUri,
  isCompanionName,
  listDicts,
  listRetiredDicts,
  lookupCard,
  scanDictFolder,
  setDictIoProvider,
  type FolderFile
} from '../src/db/dict.ts'
import { prefSet } from '../src/db/prefs.ts'
import type { DictionaryIO, FileHandle } from '../src/core-link.ts'
import { builtDb, cleanup } from './helpers.ts'

const root = mkdtempSync(join(tmpdir(), 'nyx-dr-'))
after(() => {
  dropDictCache()
  setDictIoProvider(null)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 临时目录 */
  }
  cleanup()
})

/** uri 就是真路径 —— io 直接读它（PC 上的随机读同形实现） */
const io = (uri: string): DictionaryIO => ({
  open: (path: string): FileHandle => ({ path, size: statSync(uri).size }),
  read: (_h: FileHandle, at: number, len: number): Uint8Array => {
    const b = readFileSync(uri)
    return new Uint8Array(b.subarray(at, Math.min(at + len, b.length)))
  },
  close: (): void => {}
})

/** 写一本真书（标题各不相同 —— 否则 22 本的 `dictUid` 会撞成一个） */
function book(rel: string, title: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeMdx(p, [{ word: 'use', body: '<a href="sound://hwd/bre/c/use.mp3">uk</a> use' }], {
    title,
    version: '2.0',
    encoding: 'UTF-8'
  })
}
/** 与书同名的音频数字卷，里头那段音打上标记 —— ② 就是靠这个标记比字节的 */
function volume(rel: string, tag: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeMdx(p, [{ word: '\\hwd\\bre\\c\\use.mp3', body: `AUDIO-${tag}` }], {
    title: `vol-${tag}`,
    version: '2.0',
    encoding: 'UTF-16'
  })
}
function plain(rel: string, text: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf8')
}

/** 原生那一层会回的样子：名字 · uri · 大小 · **相对目录** */
function entry(rel: string): FolderFile {
  const i = rel.lastIndexOf('/')
  return {
    name: i < 0 ? rel : rel.slice(i + 1),
    uri: join(root, rel),
    size: statSync(join(root, rel)).size,
    dir: i < 0 ? '' : rel.slice(0, i + 1)
  }
}

/** 音频字节里那个标记（不假设 mdd 的编码 —— 两种都试一遍） */
function audioTag(b64: string): string {
  const b = Buffer.from(b64, 'base64')
  return /AUDIO-([AB])/.exec(b.toString('utf16le') + '|' + b.toString('latin1'))?.[1] ?? '?'
}

// ══ 假树 ①：真机那份夹子的形状（顶层 16 + 四个子目录里 6，其中一个是第二层）══
const TOP = Array.from({ length: 16 }, (_, i) => `t${String(i).padStart(2, '0')}.mdx`)
const SUB = [
  'Longman 5/same.mdx',
  'Longman 5/l1.mdx',
  'Longman 5/l2.mdx',
  'Longman 5/Collocations/c1.mdx', // ← 第二层
  'Phrasal/same.mdx',
  '朗文当代插图版/p1.mdx'
]
for (const [i, r] of TOP.entries()) book(r, `Top ${i}`)
for (const [i, r] of SUB.entries()) book(r, `Sub ${i}`)
volume('Longman 5/same.1.mdd', 'A')
volume('Phrasal/same.1.mdd', 'B')
plain('Longman 5/same.css', '/* A */ .hwd{color:red}')
plain('Phrasal/same.css', '/* B */ .hwd{color:blue}')
// 不当书的那些：AppleDouble 伴生（真机上就有）· 配置文件 · 缩略图库
plain('._t00.mdx', 'AppleDouble')
// ★★ 真机上那个真名（C，2026-09-07）：`_._` 前缀，不是 `._` —— 172 字节，
//   T-5.16 那版认不出，它闯过扩展名过滤后以 status=error 躺在书目第 6 本
plain('_._TLD.mdx', 'AppleDouble')
plain('_._config.ini', '[main]') // 同族：当时进跳过只是因为扩展名不是词典（碰巧对了）
plain('config.ini', '[main]')
plain('Longman 5/._same.mdx', 'AppleDouble')
plain('Phrasal/Thumbs.db', 'x')

const RAW: FolderFile[] = [
  ...TOP.map(entry),
  ...SUB.map(entry),
  entry('Longman 5/same.1.mdd'),
  entry('Phrasal/same.1.mdd'),
  entry('Longman 5/same.css'),
  entry('Phrasal/same.css'),
  entry('._t00.mdx'),
  entry('_._TLD.mdx'),
  entry('_._config.ini'),
  entry('config.ini'),
  entry('Longman 5/._same.mdx'),
  entry('Phrasal/Thumbs.db')
]

describe('DR · 词典文件夹递归扫描（T-5.16）', () => {
  it('DR-1 · 子目录里的书也进库：22 本，跳过 6 项且说得出是哪些', async () => {
    const f = builtDb()
    setDictIoProvider(io)
    try {
      const listing = classifyDictFiles(RAW)
      assert.equal(listing.incomplete, null, '这一趟看全了，不该说没看全')

      const r = await scanDictFolder(f.db, listing.files, listing.skipped)

      assert.equal(
        r.ok,
        22,
        `★★ 入库 ${r.ok} 本 —— 递归没生效的话就是 16（真机上正是那 6 本没被看见）`
      )
      assert.equal(r.failed, 0, '这批都是真书，一本都不该读不了')
      assert.equal(r.skipped, 6, `跳过项应当是 6，现在 ${r.skipped}`)

      // 子目录里那几本真的在库里，而且认得出它们在第几层
      const names = (await listDicts(f.db)).map((d) => d.bookname)
      assert.ok(names.includes('Sub 3'), '★ 第二层（Longman 5/Collocations/）那本没进来')
      assert.ok(names.includes('Sub 5'), '★ 中文名子目录那本没进来')

      // 跳过的**列得出来**（设置页进页面就读这一份，不必重扫）
      const skipped = await dictSkipped(f.db)
      assert.equal(skipped.length, 6)
      const apple = skipped.filter((s) => /^_?\._/.test(s.name))
      assert.equal(apple.length, 4, '伴生文件四个（`._` 两个 + `_._` 两个）')
      assert.ok(
        apple.every((s) => s.why.includes('伴生文件')),
        `★ 说法要是人话，现在是「${apple[0]?.why}」`
      )
      /**
       * ★★ 真机那一个（C，2026-09-07 装 `a8219e1`）：`_._TLD.mdx`。
       *   T-5.16 那版只认 `._`，于是它**照旧被当成一本书**登记、解析失败，
       *   以 status=error 躺在书目第 6 本 —— 「跳过了」这件事对它没发生。
       */
      assert.ok(
        skipped.some((s) => s.name === '_._TLD.mdx'),
        '★★ `_._` 前缀那个没被拦住 —— 它会被当书登记，然后以「坏」的样子躺在书目里'
      )
      assert.ok(
        skipped.some((s) => s.name === 'config.ini' && s.why === '不是词典文件'),
        '★ config.ini 原来是被 Java 静默扔掉的，现在要说出来'
      )
      assert.ok(
        skipped.some((s) => s.dir === 'Phrasal/' && s.name === 'Thumbs.db'),
        '跳过项要带着它在哪一层'
      )
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('DR-1b · 负向对照的形状：只喂顶层（= 递归被拆掉）就只有 16 本', async () => {
    const f = builtDb()
    setDictIoProvider(io)
    try {
      // 这正是 T-5.16 之前 `listFolder` 会给的清单：第一层，且已被 Java 筛过
      const flat = classifyDictFiles(TOP.map(entry))
      const r = await scanDictFolder(f.db, flat.files, flat.skipped)
      assert.equal(r.ok, 16, '顶层就是 16 本 —— 这一条钉住「16 与 22 的差就是子目录」')
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('DR-2 · 卷不串：两个目录里同名的书各拿各的音频卷（比字节）', async () => {
    const f = builtDb()
    setDictIoProvider(io)
    try {
      const listing = classifyDictFiles(RAW)
      await scanDictFolder(f.db, listing.files, listing.skipped)
      const all = await listDicts(f.db)
      const inA = all.find((d) => d.uri === join(root, 'Longman 5/same.mdx'))!
      const inB = all.find((d) => d.uri === join(root, 'Phrasal/same.mdx'))!
      assert.ok(inA && inB, '两个目录里的同名书都该在库里')

      // ★ 先问 B 那一本 —— 它才是能证伪的那一边：清单顺序里 A 的卷排在前面，
      //   没有同目录限定的话 B 会先撞上 A 的卷、拿到 AUDIO-A 还「找得到音」。
      dropDictCache()
      await prefSet(f.db, 'dict.default', inB.uid!)
      const hitB = await dictPronounce(f.db, 'use', false)
      assert.ok(hitB, 'Phrasal 那本自己带着卷，应当发得出音')
      assert.equal(
        audioTag(hitB.b64),
        'B',
        '★★ Phrasal 那本拿到了别家目录的卷 —— 同目录限定没生效（真机上那是 1.1 GB 的卷）'
      )

      dropDictCache()
      await prefSet(f.db, 'dict.default', inA.uid!)
      const hitA = await dictPronounce(f.db, 'use', false)
      assert.ok(hitA, 'Longman 那本也该发得出音')
      assert.equal(audioTag(hitA.b64), 'A', 'Longman 那本要拿自己目录里的卷')

      assert.notEqual(hitA.b64, hitB.b64, '两本同名的书拿到了一模一样的字节 —— 卷串了')
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('DR-3 · 样式也不串：同名书各拿各目录里的 .css', async () => {
    const f = builtDb()
    setDictIoProvider(io)
    try {
      const listing = classifyDictFiles(RAW)
      await scanDictFolder(f.db, listing.files, listing.skipped)
      const all = await listDicts(f.db)
      const inB = all.find((d) => d.uri === join(root, 'Phrasal/same.mdx'))!

      // 同一条理由的第三处伴生匹配：散在夹子里的样式表
      const card = await lookupCard(f.db, 'use', inB.id)
      assert.ok(card.hit, 'Phrasal 那本里有 use 这个词')
      assert.ok(
        card.hit.css?.includes('/* B */'),
        `★★ 拿到的是别家目录的样式表（现在是「${card.hit.css?.slice(0, 12)}」）`
      )
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('DR-4 · 分类判据是纯函数：跳过什么、没看全时怎么说（不碰库）', () => {
    const mk = (name: string, dir = ''): FolderFile => ({ name, uri: dir + name, size: 1, dir })

    const r = classifyDictFiles([
      mk('a.mdx'),
      mk('a.1.mdd'),
      mk('a.css'),
      mk('._a.mdx'), // AppleDouble：**今天是会被当书登记的**，所以必须在这里就拦掉
      // ★★ 真机上那个（C，2026-09-07）是 `_._` 前缀 —— T-5.16 那版只认 `._`，
      //   于是 `_._TLD.mdx` 照旧被当成一本书登记、解析失败，躺在书目第 6 本
      mk('_._TLD.mdx'),
      mk('config.ini'),
      mk('b.mdx', 'sub/')
    ])
    assert.deepEqual(
      r.files.map((f) => f.dir + f.name),
      ['a.mdx', 'a.1.mdd', 'a.css', 'sub/b.mdx'],
      '.mdx / .mdd / .css 留下，别的都不是词典文件'
    )
    assert.deepEqual(
      r.skipped.map((s) => s.name),
      ['._a.mdx', '_._TLD.mdx', 'config.ini'],
      '跳过的三项 —— 两种伴生前缀都要认出来'
    )
    assert.equal(r.skipped[0]!.why.includes('伴生文件'), true)
    assert.equal(r.skipped[1]!.why.includes('伴生文件'), true, '★★ `_._` 那个也要说成伴生文件')
    assert.equal(r.incomplete, null, '没有任何上限被撞到 —— 不许平白说「没看全」')

    // 没看全的三种：条数到顶 · 层数到顶 · 读不了
    const cut = classifyDictFiles([mk('a.mdx')], {
      maxDepth: 8,
      maxEntries: 20000,
      truncated: true,
      tooDeep: ['x/y/z/'],
      unreadable: ['w/']
    })
    assert.ok(cut.incomplete?.includes('20000'), `★ 条数到顶要说出来：${cut.incomplete}`)
    assert.ok(
      cut.skipped.some((s) => s.name === 'x/y/z/' && s.why.includes('8')),
      '★ 没进去的目录要如实报，不许悄悄少看'
    )
    assert.ok(
      cut.skipped.some((s) => s.name === 'w/' && s.why.includes('权限')),
      '★ 读不了的目录也要报'
    )
  })

  it('DR-5 · I-159 · 旧行退役：文件名现在命中跳过规则 → 不在书目里、行还在库里、不算失踪', async () => {
    const f = builtDb()
    setDictIoProvider(io)
    try {
      /**
       * ① 库里先有那一行 —— T-5.16 之前那一趟扫描留下的样子（真机 C，2026-09-07）：
       *    `_._TLD.mdx` 闯过扩展名过滤当书登记了，172 字节解析失败 → status=error。
       *    直接插一行而不是「用旧代码扫一遍」：旧代码已经不在了，这一行才是**库里的事实**。
       */
      const tld = entry('_._TLD.mdx')
      const t0 = Date.now() - 86_400_000
      f.raw
        .prepare(
          `insert into dictionaries (ifo_path, folder, bookname, word_count, enabled, sort_order,
                                     missing, format, status, diagnostic, updated_at)
           values (?, 'saf', '_._TLD', 0, 1, 99, 0, 'mdict', 'error', '读不了 —— 这个文件只有 172 字节', ?)`
        )
        .run(tld.uri, t0)
      assert.ok(
        (await listDicts(f.db)).some((d) => d.bookname === '_._TLD'),
        '★ 前提：这一行本来就列在书目里（不成立的话这条用例什么也证明不了）'
      )

      // ② 今天这一趟重扫：分类判据把它归到跳过，于是它不在文件清单里
      const listing = classifyDictFiles(RAW)
      const r = await scanDictFolder(f.db, listing.files, listing.skipped)

      assert.ok(
        !(await listDicts(f.db)).some((d) => d.bookname === '_._TLD'),
        '★★ 书目里不该再有它 —— 它本来就不是词典'
      )
      const row = f.raw
        .prepare(`select status, missing, diagnostic, enabled from dictionaries where ifo_path = ?`)
        .get(tld.uri) as { status: string; missing: number; diagnostic: string; enabled: number } | undefined
      assert.ok(row, '★★ 行不许被删（D-216 只增不删）')
      assert.equal(row.status, 'notdict', '★★ 退役是一个状态，不是删除、也不是失踪')
      assert.equal(
        Number(row.missing),
        0,
        '★★ 不是「失踪」—— 它就在夹子里，说「不在夹里了 —— 重新扫描或放回去」是假话'
      )
      assert.ok(String(row.diagnostic).includes('伴生文件'), '诊断说得出为什么退役')
      assert.equal(Number(row.enabled), 1, '他的开关不动（不删行的同一条精神）')

      assert.equal(r.missing, 0, '★★ missing 计数不再算它')
      assert.equal(r.retired, 1, '这一趟看下来有一行是退役的')

      assert.deepEqual(
        (await listRetiredDicts(f.db)).map((d) => d.bookname),
        ['_._TLD'],
        '书目不列它，但诊断这一路查得到'
      )
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('DR-5b · 对照：真的不在夹里了的书仍然是「失踪」，也仍然列在书目里（两条路分得开）', async () => {
    const f = builtDb()
    setDictIoProvider(io)
    try {
      const listing = classifyDictFiles(RAW)
      await scanDictFolder(f.db, listing.files, listing.skipped)
      const before = (await listDicts(f.db)).length

      // 只喂一本 —— 其余的「真的不在夹里了」
      const fewer = classifyDictFiles([entry('t00.mdx')])
      const r = await scanDictFolder(f.db, fewer.files, fewer.skipped)

      assert.equal(r.missing, before - 1, '少掉的那些都标了失踪')
      assert.equal(r.retired, 0, '这一批里没有本来就不是词典的行')
      const books = await listDicts(f.db)
      assert.equal(books.length, before, '★ 失踪的仍然列在书目里 —— 他的排序与开关还在，放回去就好')
      assert.ok(books.some((d) => d.missing), '至少有一行是失踪态')
    } finally {
      setDictIoProvider(null)
      dropDictCache()
    }
  })

  it('DR-6 · I-159 的两把尺都是纯函数：伴生名 · 从 SAF URI 反推文件名（不碰库）', () => {
    assert.equal(isCompanionName('._a.mdx'), true)
    assert.equal(isCompanionName('_._TLD.mdx'), true, '真机上那个是 _._ 前缀')
    assert.equal(isCompanionName('_TLD.mdx'), false, '一条下划线开头的正经书名不算')
    assert.equal(isCompanionName('TLD.mdx'), false)

    // SAF 文档 URI：末段把整条路径转义了进去
    assert.equal(
      fileNameOfUri(
        'content://com.android.externalstorage.documents/tree/primary%3ADict/document/primary%3ADict%2F_._TLD.mdx'
      ),
      '_._TLD.mdx'
    )
    // 夹子根上那种（只有冒号，没有 %2F）
    assert.equal(
      fileNameOfUri('content://com.android.externalstorage.documents/document/primary%3A_._TLD.mdx'),
      '_._TLD.mdx'
    )
    // PC 上的用例喂的是真路径（Windows 上是反斜杠，Linux 上是斜杠，两种都要认）
    assert.equal(fileNameOfUri(join('Dict', '_._TLD.mdx')), '_._TLD.mdx')
    // 半截转义：原样用，不抛（宁可少认出一个，也不要让重扫整趟挂掉）
    assert.equal(fileNameOfUri('%zz/_._TLD.mdx'), '_._TLD.mdx')
  })
})
