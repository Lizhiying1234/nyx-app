/**
 * 词典：StarDict / MDict 解析 · D2 Adapter 化 · D5.2 不再全量装载 · D2.1 默认词典 · D3 @@@LINK · D4 富媒体 · 材料格式
 *
 * 原 tests/db-safety.ts 第 2833–4036 行，T-4.6 整段搬过来，用例文本与顺序一个字没改。
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/open.ts'
import { MIGRATIONS } from '../../src/main/db/migrations.ts'
import { StarDict } from '../../src/main/dict/stardict.ts'
import { Dicts } from '../../src/main/dict/index.ts'
import { writeMdx } from '../make-mdx.ts'
import type { DictRow } from '../../src/shared/api.ts'
import { MAX_REDIRECT_HOPS } from '../../src/core/dict/lookup.ts'
import { buildRichCard, toDataUrl, MEDIA_LIMITS } from '../../src/main/dict/rich.ts'
import { mediaRef, parseMediaRef } from '../../src/core/dict/media.ts'
import { Prefs } from '../../src/main/db/prefs.ts'
import { writeDzDict, writePlainDict } from '../make-dict.ts'
import { ripemd128 } from '../../src/main/dict/ripemd128.ts'
import { readDocument, stripSubtitleTiming } from '../../src/main/readdoc.ts'
import { makeDocx } from '../make-docx.ts'
import { makePdf } from '../make-pdf.ts'
import { Study } from '../../src/main/study.ts'
import { Repo } from '../../src/main/db/repo.ts'
import { check, assert, freshDir } from './harness.ts'
import { makeBook } from './fixtures.ts'

// ── 8 · StarDict 解析（D-151 / D-215）─────────────────────────────
// 也跑在 Electron 里，因为 Dicts 要 better-sqlite3。
check('StarDict · 普通 .dict 查得到，大小写无所谓', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-dict-'))
  writePlainDict(join(dir, '朗文'), '朗文', [
    { word: 'apple', body: 'n. 苹果\nShe ate the whole apple in three bites.' },
    { word: 'Brunt', body: 'n. 冲击\nCoastal towns bear the brunt of these storms.' }
  ])
  const d = StarDict.open(join(dir, '朗文', '朗文.ifo'))
  assert(d.wordCount === 2, `词数不对：${d.wordCount}`)
  assert(d.lookup('apple')?.includes('苹果') === true, 'apple 查不到')
  assert(d.lookup('BRUNT')?.includes('冲击') === true, '大小写没归一化')
  assert(d.lookup('nothing') === null, '查不到的词应该返回 null，不是抛错')
  d.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★ StarDict · dictzip 随机读 —— 只解压用到的块，跨块也要读对', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-dictz-'))
  // 刻意让正文远长于块长（64 字节），逼它跨块拼接
  const long = 'X'.repeat(300)
  writeDzDict(join(dir, 'dz'), 'dz', [
    { word: 'short', body: 'tiny entry' },
    { word: 'long', body: `head ${long} tail` },
    { word: 'last', body: '最后一条，用来验偏移没算歪' }
  ])
  const d = StarDict.open(join(dir, 'dz', 'dz.ifo'))
  assert(d.lookup('short') === 'tiny entry', `短条目读错：${d.lookup('short')}`)
  const got = d.lookup('long') ?? ''
  assert(got.startsWith('head ') && got.endsWith('tail'), `跨块拼接错了：${got.slice(0, 40)}…`)
  assert(got.length === `head ${long} tail`.length, `长度对不上：${got.length}`)
  assert(d.lookup('last')?.includes('最后一条') === true, '最后一条读错了')
  d.close()
  rmSync(dir, { recursive: true, force: true })
})

check('D-234 · 优先级与停用真的生效（不是摆设）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const dictsDir = join(dir, 'dicts')
  writePlainDict(join(dictsDir, 'A词典'), 'A词典', [{ word: 'gap', body: 'A 的解释' }])
  writePlainDict(join(dictsDir, 'B词典'), 'B词典', [{ word: 'gap', body: 'B 的解释' }])

  const dicts = new Dicts(r.db, dictsDir)
  const rows = dicts.rescan()
  assert(rows.length === 2, `应该扫到 2 本，实际 ${rows.length}`)

  const first = dicts.lookup('gap')
  assert(first.length === 2, `两本都收了 gap，应该都返回，实际 ${first.length}`)
  const a = rows.find((x) => x.bookname === 'A词典')!
  const b = rows.find((x) => x.bookname === 'B词典')!
  assert(first[0]!.bookname === 'A词典', `默认顺序不对：${first[0]!.bookname}`)

  // 把 B 排到前面
  dicts.reorder([b.id, a.id])
  assert(dicts.lookup('gap')[0]!.bookname === 'B词典', '排序没生效 —— D-234 就是摆设了')

  // 停用 B
  dicts.setEnabled(b.id, false)
  const after = dicts.lookup('gap')
  assert(after.length === 1 && after[0]!.bookname === 'A词典', '停用没生效')

  // 文件没了要标 missing，但**不删记录**
  rmSync(join(dictsDir, 'A词典'), { recursive: true, force: true })
  const rescanned = dicts.rescan()
  assert(rescanned.length === 2, '记录被删了 —— 数据库只增不删，移动硬盘拔了不是删词典')
  assert(rescanned.find((x) => x.id === a.id)!.missing === 1, '文件没了却没标 missing')
  assert(dicts.lookup('gap').length === 0, 'missing 的词典还在参与查词')

  dicts.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Nyx 的条目大多是多词表达，而词典按词目收 —— 这条不成立的话，
// 词典对整个软件基本没用（查 `bear the brunt of` 一次都查不中）。
check('★ 整条查不到时退到词目，并说清查的是哪个词', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const dictsDir = join(dir, 'dicts')
  writePlainDict(join(dictsDir, '词目'), '词目', [
    { word: 'brunt', body: 'n. 冲击\nCoastal towns bear the brunt of these storms.' },
    { word: 'of', body: 'prep. 的' }
  ])
  const dicts = new Dicts(r.db, dictsDir)
  dicts.rescan()

  const hits = dicts.lookup('bear the brunt of')
  assert(hits.length === 1, `词目回退没生效，查到 ${hits.length} 条`)
  assert(hits[0]!.headword === 'brunt', `回退到的词目不对：${hits[0]!.headword}`)
  assert(hits[0]!.text.includes('冲击'), '拿回来的不是 brunt 的词条')

  // 虚词不能被当成词目 —— `of` 的词条对学这条表达毫无用处
  const ex = dicts.examples('bear the brunt of')
  assert(ex.length === 1, `例句应该按命中的词目筛，实际 ${ex.length} 条`)
  assert(ex[0]!.text.includes('bear the brunt of'), `捞错了句子：${ex[0]?.text}`)

  dicts.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// I-031 · MDict 的索引解混淆要用 RIPEMD-128。这东西错一位，
// 表现就是「某些词典读不了」，而且报的是 zlib 的 incorrect header check ——
// 从那个错误根本看不出是哈希算错了。所以用官方测试向量钉死。
check('★ RIPEMD-128 与官方测试向量逐位一致（MDict 索引靠它）', () => {
  const vectors: [string, string][] = [
    ['', 'cdf26213a150dc3ecb610f18f6b38b46'],
    ['a', '86be7afa339d0fc7cfc785e72f578d33'],
    ['abc', 'c14a12199c66e4ba84636b0f69144c77'],
    ['message digest', '9e327b3d6e523062afc1132d7df9d1b8'],
    ['abcdefghijklmnopqrstuvwxyz', 'fd2aa607f71dc8f510714922b371834e'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      'a1aa0689d0fafa2ddc22e88b49133a06'
    ],
    ['a'.repeat(1000000).slice(0, 80), '']
  ]
  for (const [input, want] of vectors) {
    if (!want) continue
    const got = ripemd128(Buffer.from(input, 'ascii')).toString('hex')
    assert(got === want, `ripemd128("${input.slice(0, 20)}") = ${got}，应为 ${want}`)
  }
})

check('D-150 · 词典里捞例句：只要像例句的行，不要释义行', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const dictsDir = join(dir, 'dicts')
  writePlainDict(join(dictsDir, '例句'), '例句', [
    {
      word: 'brunt',
      body: [
        'n. 冲击力',
        'ADJ. 短标签',
        'Coastal towns bear the brunt of these storms every winter.',
        'Junior staff bore the brunt of the cuts that year.'
      ].join('\n')
    }
  ])
  const dicts = new Dicts(r.db, dictsDir)
  dicts.rescan()
  const ex = dicts.examples('brunt')
  assert(ex.length === 2, `应该捞到 2 条例句，实际 ${ex.length}：${JSON.stringify(ex)}`)
  assert(
    ex.every((e) => e.text.includes('brunt') && /[.!?]$/.test(e.text)),
    `捞进来的不像例句：${JSON.stringify(ex)}`
  )
  assert(!ex.some((e) => e.text.startsWith('n.')), '把释义行当例句了')
  dicts.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════
// ★★ D2 · Adapter 化 + 登记处 + 诊断落库（2026-08-19）
//
// D2 是**行为等价重构**：`lookup` / `lookupCard` / `examples` 对外一个字不变
//（他真实 22 本的逐项对拍在 `tests/dict-behavior.ts`，跑 `npm run dict:behavior`）。
// 这一批验的是重构本身带来的那些**新保证**。
// ══════════════════════════════════════════════════════════════

/** 造一本 StarDict，返回它的目录 */

// ══════════════════════════════════════════════════════════════
// ★★★ D5.2 · 启动不再全量装载（2026-08-23）
//
// 老路：`rescan()` 最后一行 `return this.verifyAll()` —— 把每一本都装载一遍，
// 为的是当场查实「能不能用、多少词」。实测 21 本 6831 ms，**同步压在启动上**。
//
// 这一批钉的是四句话，每一句坏掉都**不报错、只是又慢回去了**：
//   ① 扫完，手上开着 0 本
//   ② 查一个词，才开 1 本
//   ③ 查第二个词，还是那 1 本（缓存没丢）
//   ④ `lookupCard` 的「别的哪几本也有它」**不装载任何一本**
// ══════════════════════════════════════════════════════════════

/** 造几本真 .mdx（StarDict 那条路装载几乎免费，验不出全量装载的代价） */
function makeMdxBooks(root: string): void {
  writeMdx(join(root, '甲.mdx'), [
    { word: 'brunt', body: '<b>brunt</b> 甲的解释' },
    { word: 'sway', body: '甲 sway' },
    { word: 'zebra', body: '甲 zebra' }
  ], { title: '甲' })
  writeMdx(join(root, '乙.mdx'), [
    { word: 'brunt', body: '<b>brunt</b> 乙的解释' },
    { word: 'gap', body: '乙 gap' }
  ], { title: '乙' })
  writeMdx(join(root, '丙.mdx'), [
    { word: 'zebra', body: '丙 zebra' },
    { word: 'gap', body: '丙 gap' }
  ], { title: '丙' })
}

check('★★★ D5.2 · 扫完一本都没装载，词数先用头部声明值', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  mkdirSync(home, { recursive: true })
  makeMdxBooks(home)

  const d = new Dicts(r.db, home)
  const rows = d.rescan()
  assert(rows.length === 3, `扫到 ${rows.length} 本`)
  assert(
    d.openCount() === 0,
    `★★★ 扫描时装载了 ${d.openCount()} 本 —— 启动的 6.8 秒就是这么来的`
  )
  // 词数不是 0：probe 读的头部声明值已经顶上了（不然设置页会显示「0 词」）
  for (const row of rows) {
    assert(row.wordCount > 0, `${row.bookname} 词数是 ${row.wordCount}`)
  }
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★★ D5.2 · 查一个词才装那一本，第二次走缓存；实测词数回填', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  mkdirSync(home, { recursive: true })
  makeMdxBooks(home)

  const d = new Dicts(r.db, home)
  d.rescan()
  assert(d.openCount() === 0, '扫描时就装载了')

  const hit = d.lookup('gap')
  assert(hit.length > 0, '查不到 gap')
  assert(d.openCount() > 0, '★★ 查了词却一本都没装载？')
  const after = d.openCount()

  d.lookup('gap')
  assert(d.openCount() === after, `★★ 第二次查又装了一遍：${after} → ${d.openCount()}`)

  // 装载过的那几本，词数换成了实测值（和声明值可能差几条，但必须 > 0）
  for (const row of d.list()) {
    assert(row.wordCount > 0, `${row.bookname} 回填之后词数是 0`)
  }
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★★ D5.2 · lookupCard 的「别的哪几本也有它」不装载别的本', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  mkdirSync(home, { recursive: true })
  makeMdxBooks(home)

  const d = new Dicts(r.db, home)
  const rows = d.rescan()
  const first = rows.find((x) => x.bookname === '甲')!
  const card = d.lookupCard('brunt', first.id)

  assert(card.headword.length > 0, `卡片没查到词：${JSON.stringify(card).slice(0, 160)}`)
  assert(
    d.openCount() === 1,
    `★★★ 查一张卡装载了 ${d.openCount()} 本 —— 全词典扇出又回来了`
  )
  // 结果本身一个字不能变：另外那本「乙」也有 brunt
  const names = card.others.map((o) => o.name).sort()
  assert(names.includes('乙'), `★★ others 少了：${JSON.stringify(names)}`)
  assert(!names.includes('丙'), `★★ others 多了没有这个词的：${JSON.stringify(names)}`)

  // 换个只有丙有的词，答案也要对
  const card2 = d.lookupCard('gap', first.id)
  const names2 = card2.others.map((o) => o.name).sort()
  assert(
    names2.includes('乙') && names2.includes('丙'),
    `★★ others 漏了：${JSON.stringify(names2)}`
  )

  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★★ D5.2 · 装不起来的词典：不许伪装成扫描成功，原因要落库', () => {
  const { db: p, backups, dir } = freshDir()
  const home = join(dir, 'dicts')
  mkdirSync(home, { recursive: true })

  // ① 根本不是词典 —— probe 就该看出来（这一档从来不需要装载）
  writeFileSync(join(home, '不是词典.mdx'), Buffer.from('这不是 mdx，只是一堆字节'))
  // ② 头部完好、正文段被砍掉一半 —— probe 看不出来，**装载才会知道**
  const cut = join(home, '砍过的.mdx')
  writeMdx(cut, [
    { word: 'brunt', body: '<b>brunt</b> 正文' },
    { word: 'sway', body: '正文二' }
  ], { title: '砍过的' })
  const whole = readFileSync(cut)
  writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.6)))

  const r = openDatabase(p, backups)
  const d = new Dicts(r.db, home)
  const rows = d.rescan()

  const bad = rows.find((x) => x.bookname === '不是词典')!
  assert(bad, '没扫到那个坏文件')
  const badRow = d.list().find((x) => x.id === bad.id) as DictRow & { status?: string | null }
  assert(
    badRow.status !== 'READY',
    `★★★ 一堆随机字节被当成「扫描成功」了：status = ${String(badRow.status)}`
  )

  // 砍过的那本：查它一次 → 装载失败 → 原因必须**落库**（重启还看得见）
  const hurt = rows.find((x) => x.bookname === '砍过的')!
  d.lookupCard('brunt', hurt.id)
  const hurtRow = d.list().find((x) => x.id === hurt.id) as DictRow & {
    status?: string | null
    problem?: string | null
  }
  assert(
    hurtRow.status !== 'READY' || hurtRow.problem,
    `★★★ 装载失败了，库里却还写着一切正常：status = ${String(hurtRow.status)}`
  )

  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2 · 每一本都算得出 uid，而且 uid 只由内容决定（换路径不变）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const one = join(dir, 'dicts1')
  const two = join(dir, 'dicts2')
  makeBook(one, '甲', [{ word: 'gap', body: '甲的解释' }])
  makeBook(two, '甲', [{ word: 'gap', body: '甲的解释' }])

  const a = new Dicts(r.db, one)
  const rowsA = a.rescan() as { uid?: string | null }[]
  const uidA = rowsA[0]!.uid
  assert(typeof uidA === 'string' && uidA.length > 0, `第一次没算出 uid：${JSON.stringify(rowsA[0])}`)
  a.closeAll()

  // 另一台机器 / 另一个路径上的同一本 —— uid 必须逐字相同
  const { db: p2, backups: b2 } = freshDir()
  const r2 = openDatabase(p2, b2)
  const c = new Dicts(r2.db, two)
  const uidB = (c.rescan() as { uid?: string | null }[])[0]!.uid
  assert(uidB === uidA, `★ 同一本词典换个路径就换了身份：${String(uidA)} / ${String(uidB)}`)
  c.closeAll()
  r.db.close()
  r2.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2 · I-106 · 词典目录搬家：uid 不变、id 可变、启用/排序/默认全保住', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, 'A词典', [{ word: 'gap', body: 'A' }])
  makeBook(home, 'B词典', [{ word: 'gap', body: 'B' }])

  const before = new Dicts(r.db, home)
  const rows = before.rescan()
  const a0 = rows.find((x) => x.bookname === 'A词典')!
  const b0 = rows.find((x) => x.bookname === 'B词典')!
  // 他排了序、停用了一本、设了默认
  before.reorder([b0.id, a0.id])
  before.setEnabled(a0.id, false)
  before.setDefaultBook(b0.id)
  const uidB = (before.list() as (DictRow & { uid?: string | null })[]).find((x) => x.id === b0.id)!.uid
  before.closeAll()

  // ★ 搬家：把整个词典目录挪到别处（**改的是路径，不是内容**）
  const moved = join(dir, 'dicts-moved')
  cpSync(home, moved, { recursive: true })
  rmSync(home, { recursive: true, force: true })

  const after = new Dicts(r.db, moved)
  const now = after.rescan() as (DictRow & { uid?: string | null })[]

  assert(now.length === 2, `★★ 搬完变成了 ${now.length} 行 —— I-106 那次就是这么丢的设置`)
  assert(
    now.every((x) => x.missing === 0),
    `★ 还有行标着 missing：${JSON.stringify(now.map((x) => [x.bookname, x.missing]))}`
  )
  const b1 = now.find((x) => x.bookname === 'B词典')!
  const a1 = now.find((x) => x.bookname === 'A词典')!
  assert(b1.uid === uidB, `★★ uid 变了：${String(uidB)} → ${String(b1.uid)}`)
  assert(a1.enabled === 0, '★★ 他停用的那本又自己启用了')
  assert(b1.sortOrder < a1.sortOrder, '★★ 他排的顺序丢了')

  /**
   * ★★ 「默认不丢」要**验到底**，不能只看「现在默认的是不是 B」。
   *
   *   第一版是这样假绿的：`defaultBook()` 在认不出他要的那本时会**悄悄**退到
   *   「第一本可用的」，而第一本可用的**恰好也是 B**（他排在最前）——
   *   于是认领整个删掉，用例照样绿。反向验收当场把它抓了出来。
   *
   *   D2.1 之后存的是 `dictUid`（跟着人走），判据也跟着变实：
   *   **他存的那个身份，本机有一行对得上**，而且没有发生「临时退回」。
   */
  const storedUid = new Prefs(r.db).raw('dict.default')
  assert(storedUid === uidB, `★★ 存的默认词典身份变了：${String(uidB)} → ${String(storedUid)}`)
  assert(
    now.some((x) => x.uid === storedUid),
    `★★ 他设的默认词典在本机找不到对应的一行了 —— 默认丢了`
  )
  const def = after.defaultBook()
  assert(def.book?.bookname === 'B词典', `★★ 默认词典丢了：${String(def.book?.bookname)}`)
  assert((def.wanted as { uid?: string | null } | null)?.uid === uidB, '★★ 他要的那本认不出来了')
  assert(def.fellBack === false, '★ 不该是「临时退回」—— 那本明明还在')
  after.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2 · 同一个 uid 的两份文件只出一个 provider；不同 uid 并存', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  // 同一本词典的两份拷贝（内容逐字相同 → uid 相同）
  makeBook(join(home, '一份'), '重复', [{ word: 'gap', body: '同一本' }])
  makeBook(join(home, '另一份'), '重复', [{ word: 'gap', body: '同一本' }])
  // 另一本，内容不同 → uid 不同
  makeBook(home, '另一本', [{ word: 'gap', body: '别的书' }])

  const d = new Dicts(r.db, home)
  const rows = d.rescan() as (DictRow & { uid?: string | null })[]
  assert(rows.length === 3, `应该登记 3 个文件，实际 ${rows.length}`)

  const uids = new Set(rows.map((x) => x.uid))
  assert(uids.size === 2, `★ 两份拷贝该是同一个 uid、第三本另一个 —— 实际 ${uids.size} 个`)

  const usable = d.registry.usable()
  assert(usable.length === 2, `★★ 同一本词典出了 ${usable.length} 个 provider —— 查词会重复`)
  // 三个文件都还在列表里看得见（他自己决定要不要删）
  assert(d.list().length === 3, '★ 被挡下的那一份不该从列表里消失')

  const hits = d.lookup('gap')
  assert(hits.length === 2, `★★ 查词结果里出现了重复的同一本：${JSON.stringify(hits.map((h) => h.bookname))}`)
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2 · 诊断落库：重启之后仍然看得见同一个失败原因', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  mkdirSync(home, { recursive: true })
  // macOS 压缩包带出来的那种附属文件：扩展名像词典，内容不是（实测 `_._TLD.mdx` 172 字节）
  writeFileSync(join(home, '_._假的.mdx'), Buffer.alloc(172, 7))

  const d = new Dicts(r.db, home)
  const rows = d.rescan() as (DictRow & { status?: string | null })[]
  assert(rows.length === 1, `应该登记 1 个，实际 ${rows.length}`)
  assert(rows[0]!.status === 'NOT_A_DICTIONARY', `★ 状态不对：${String(rows[0]!.status)}`)
  assert(typeof rows[0]!.problem === 'string', '★ 老字段 problem 不该消失（设置页现在显示的就是它）')
  d.closeAll()
  r.db.close()

  // ★★ 重启：新开一个库连接、**不 rescan**，诊断必须还在
  const r2 = openDatabase(p, backups)
  const d2 = new Dicts(r2.db, home)
  const again = d2.registry.records()[0]!
  assert(again.status === 'NOT_A_DICTIONARY', `★★ 重启之后状态没了：${String(again.status)}`)
  assert(
    typeof again.diagnostic?.says === 'string' && again.diagnostic.says.length > 8,
    `★★ 重启之后诊断没了 —— 那正是 D5 惰性装载之后会发生的事：${JSON.stringify(again.diagnostic)}`
  )
  assert(
    !/Attempt to access memory|undefined is not/i.test(again.diagnostic.says),
    `★ 落库的是 V8 报错，不是人话：${again.diagnostic.says}`
  )
  d2.closeAll()
  r2.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2 · 迁移 V32 不读词典、不扫目录、不做任何词典 I/O', () => {
  /**
   * ★ 判据落在**源码**上，不是落在「跑一次没报错」上 ——
   *   跑一次没报错的原因可能只是那台机器上恰好没有词典。
   *   他的原话：迁移**不读取真实词典 / 不扫描目录 / 不计算大文件 hash / 不做词典 I/O**。
   */
  const v32 = MIGRATIONS.find((m) => m.version === 32)
  const v33 = MIGRATIONS.find((m) => m.version === 33)
  assert(v32 !== undefined, '没有 V32 这条迁移')
  assert(v33 !== undefined, '没有 V33 这条迁移')
  /**
   * ★ V33（默认词典搬进偏好表）也在这道闸里：它**读 `dictionaries` 表**是允许的
   *   ——那是数据库的事；读 `.mdx`、扫目录、算大文件 hash 才是词典 I/O。
   */
  const src = v32.up.toString() + String.fromCharCode(10) + v33.up.toString()
  const forbidden = [
    'readFileSync', 'readdirSync', 'statSync', 'existsSync', 'openSync', 'readSync',
    'Mdict', 'StarDict', 'probeMdict', 'createHash', 'dictsDir'
  ]
  const hit = forbidden.filter((f) => src.includes(f))
  assert(hit.length === 0, `★★ V32 里出现了词典 I/O：${hit.join('、')}`)

  // 词典目录根本不存在时也要能升级 —— 拔了移动硬盘不该让软件打不开
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const cols = (r.db.prepare(`pragma table_info(dictionaries)`).all() as { name: string }[]).map(
    (c) => c.name
  )
  for (const c of ['uid', 'format', 'status', 'diagnostic', 'capabilities', 'resources', 'probed_at']) {
    assert(cols.includes(c), `V32 没加上 ${c} 这一列`)
  }
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2 · 两种格式走同一个契约入口（registry 里一个扩展名都没有）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '星典', [{ word: 'gap', body: 'n. 缺口' }])
  writeFileSync(join(home, '假的.mdx'), Buffer.alloc(172, 7))

  const d = new Dicts(r.db, home)
  d.rescan()

  const star = d.registry.records().find((x) => x.bookname === '星典')!
  assert(star.format?.startsWith('stardict') === true, `格式认错了：${String(star.format)}`)
  const book = d.registry.handle(star.ifoPath)
  assert(book !== null, 'StarDict 装不起来')

  // 契约那几样都在，而且都是真的
  assert(book.meta.uid === star.uid, '契约里的 uid 和库里存的不是同一个')
  assert(book.wordCount === 1, `词数不对：${book.wordCount}`)
  assert(book.match('gap').length === 1, 'match 认不出词目')
  const rec = book.raw('gap')
  assert(rec !== null && rec.body.includes('缺口'), `raw 取不到正文：${JSON.stringify(rec)}`)
  assert(book.legacyText('gap') === d.lookup('gap')[0]!.text, '老路径和 legacyText 不是同一份结果')
  assert([...book.keys()].length === 1, 'keys() 数不对')

  /**
   * ★ D2 的**已知边界**：老索引一个词目只留一条，同形异义在建索引那一刻就丢了。
   *   D3 换索引之后这一条会红 —— **那是好事，到时候改这条用例**。
   */
  assert(book.raw('gap', 1) === null, 'D2 的索引不该给得出第二条 —— 给得出说明 D3 已经做了，改这条用例')

  // 那个假 .mdx 被认领了、也给了诊断（不认领就成了「列表里没有、也没人说为什么」）
  const fake = d.registry.records().find((x) => x.bookname === '假的')!
  assert(fake.status === 'NOT_A_DICTIONARY', `假文件的状态：${String(fake.status)}`)
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2 · 重扫两次：不多出行、uid 不变、他的设置不动', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '甲', [{ word: 'gap', body: '甲' }])
  makeBook(home, '乙', [{ word: 'gap', body: '乙' }])

  const d = new Dicts(r.db, home)
  const first = d.rescan() as (DictRow & { uid?: string | null })[]
  d.setEnabled(first[0]!.id, false)
  d.reorder([first[1]!.id, first[0]!.id])

  const second = d.rescan() as (DictRow & { uid?: string | null })[]
  assert(second.length === 2, `重扫多出了行：${second.length}`)
  assert(second.find((x) => x.id === first[0]!.id)?.enabled === 0, '★ 重扫把他停用的那本又打开了')
  const uidsFirst = new Map(first.map((x) => [x.id, x.uid]))
  for (const row of second) {
    if (uidsFirst.has(row.id)) {
      assert(uidsFirst.get(row.id) === row.uid, `★ 重扫把 uid 改了：${row.bookname}`)
    }
  }
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════
// ★★ D2.1 · 默认词典跟着人走（2026-08-19 他改的裁决）
//
//   user_preferences['dict.default'] = dictUid     ← USER，跟着人走
//   dictionaries.uid                 = 本机 → 稳定身份的映射
//   id / ifo_path / enabled / sort_order / 资源 / 缓存  ← DEVICE
// ══════════════════════════════════════════════════════════════

check('★★ D2.1 · V33 迁移：本机 id → dictUid，搬成功才删旧键', () => {
  const { db: p, backups, dir } = freshDir()
  const home = join(dir, 'dicts')
  makeBook(home, '甲', [{ word: 'gap', body: '甲' }])
  makeBook(home, '乙', [{ word: 'gap', body: '乙' }])

  // ① 先升到 V32（词典表有 uid 列了），扫一遍把 uid 填上
  const mid = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 32))
  const d0 = new Dicts(mid.db, home)
  const rows = d0.rescan()
  const second = rows[1]!
  const uid = (d0.registry.records().find((x) => x.id === second.id) as { uid: string }).uid
  // ② 造出「老写法」：settings 里存本机 id
  const t = Date.now()
  mid.db
    .prepare(
      `insert into settings (key, value, updated_at) values ('dict.default', ?, ?)
         on conflict(key) do update set value = excluded.value`
    )
    .run(String(second.id), t)
  d0.closeAll()
  mid.db.close()

  // ③ 升到最新 → V33 该把它搬进偏好表
  const up = openDatabase(p, backups)
  const prefs = new Prefs(up.db)
  assert(prefs.raw('dict.default') === uid, `★★ 没搬成 uid：${String(prefs.raw('dict.default'))}`)
  assert(
    !up.db.prepare(`select 1 as x from settings where key = 'dict.default'`).get(),
    '★★ 搬进去了却没删旧键 —— 双真相就是这么来的'
  )
  // 搬完之后默认词典还是他选的那本
  const d1 = new Dicts(up.db, home)
  d1.rescan()
  assert(d1.defaultBook().book?.id === second.id, '★★ 搬完默认词典变了')
  d1.closeAll()
  up.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2.1 · 解析不出真实词典 → 一个字都不写，绝不编 uid', () => {
  const { db: p, backups, dir } = freshDir()
  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 32))
  const t = Date.now()
  old.db
    .prepare(`insert into settings (key, value, updated_at) values ('dict.default', '31', ?)`)
    .run(t)
  old.db.close()

  const up = openDatabase(p, backups)
  const prefs = new Prefs(up.db)
  /**
   * ★★ 库里一本词典都没有，`31` 指不到任何东西。
   *   这时候**编一个 uid 出来**是最坏的做法：他换台设备之后，
   *   默认词典指向一本根本不存在的书，而且什么都不报。
   */
  assert(prefs.raw('dict.default') === null, '★★ 编了一个 uid 出来')
  assert(
    (up.db.prepare(`select value from settings where key = 'dict.default'`).get() as
      | { value: string }
      | undefined)?.value === '31',
    '★★ 搬不动却把旧键删了 —— 他的设置丢了'
  )
  up.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D2.1 · 升级当时 uid 还是 NULL（他的真实路径）→ 第一次重扫时自愈', () => {
  /**
   * ★ 这是**他实际会走的那条路**：V32 刚把 `uid` 列加出来，值全是 NULL ——
   *   要等软件起来、`rescan()` 探测一遍才有。所以 V33 迁移当时搬不动，
   *   真正干活的是 registry 里的自愈那一步。
   */
  const { db: p, backups, dir } = freshDir()
  const home = join(dir, 'dicts')
  makeBook(home, '甲', [{ word: 'gap', body: '甲' }])

  const old = openDatabase(p, backups, MIGRATIONS.filter((m) => m.version <= 31))
  const t = Date.now()
  old.db
    .prepare(
      `insert into dictionaries (ifo_path, folder, bookname, word_count, enabled, sort_order, missing, updated_at)
       values (?, ?, '甲', 1, 1, 1, 0, ?)`
    )
    .run(join(home, '甲', '甲.ifo'), join(home, '甲'), t)
  const id = (old.db.prepare(`select id from dictionaries`).get() as { id: number }).id
  old.db
    .prepare(`insert into settings (key, value, updated_at) values ('dict.default', ?, ?)`)
    .run(String(id), t)
  old.db.close()

  const up = openDatabase(p, backups)
  const prefs = new Prefs(up.db)
  // 升级当时：uid 还是 NULL → 按规矩什么都不写
  assert(prefs.raw('dict.default') === null, '★ 迁移不该在 uid 还是 NULL 时硬搬')

  // 第一次重扫 → 探测出 uid → 自愈
  const d = new Dicts(up.db, home)
  d.rescan()
  const uid = d.registry.records()[0]!.uid
  assert(prefs.raw('dict.default') === uid, `★★ 重扫之后没自愈：${String(prefs.raw('dict.default'))}`)
  assert(
    !up.db.prepare(`select 1 as x from settings where key = 'dict.default'`).get(),
    '★★ 自愈之后旧键没删 —— 双真相'
  )
  assert(d.defaultBook().book?.bookname === '甲', '★ 自愈把他的默认词典弄丢了')
  d.closeAll()
  up.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════
// ★★ D3 · 查词语义接线：@@@LINK 不再当正文交出去（2026-08-19）
//
// 真词典那一档在 `tests/dict-behavior.ts` 的 `redirects` 节里
//（他真实的牛津高阶10 / 朗文6 × 四个词）。这一批用**造出来的**词典
// 验那些真词典里碰不到的形状：环、超长链、断链。
// ══════════════════════════════════════════════════════════════

check('★★ D3 · @@@LINK 跟到底：lookup 与 lookupCard 都不再交出跳转记录', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '跳转', [
    { word: 'children', body: '@@@LINK=child' },
    { word: 'child', body: 'n. 小孩\nThe child ran across the yard every morning.' }
  ])

  const d = new Dicts(r.db, home)
  d.rescan()

  const hits = d.lookup('children')
  assert(hits.length === 1, `该查到 1 条，实际 ${hits.length}`)
  assert(!hits[0]!.text.includes('@@@LINK'), `★★ 跳转记录被当成正文交出去了：${hits[0]!.text}`)
  assert(hits[0]!.text.includes('小孩'), `★★ 没跟到目标词条：${hits[0]!.text}`)
  assert(hits[0]!.headword === 'child', `★★ 命中的词目不对：${hits[0]!.headword}`)
  assert(
    JSON.stringify(hits[0]!.redirectedFrom) === JSON.stringify(['children']),
    `★ 没记下从哪儿跳来的：${JSON.stringify(hits[0]!.redirectedFrom)}`
  )

  const card = d.lookupCard('children')
  assert(card.headword === 'child', `★★ 卡片上的词目不对：${card.headword}`)
  assert(!card.raw.includes('@@@LINK'), `★★ 卡片正文里有 @@@LINK：${card.raw}`)
  assert(card.raw.includes('小孩'), `★★ 卡片没跟到目标：${card.raw}`)
  assert(
    JSON.stringify(card.redirectedFrom) === JSON.stringify(['children']),
    `★ 卡片没记下跳转路径：${JSON.stringify(card.redirectedFrom)}`
  )
  assert(!card.diagnostic, '★ 好好的跳转不该带诊断')

  // D-150 捞例句走的是同一条路 —— 例句得是**目标词条**里的
  const ex = d.examples('children')
  assert(
    ex.length === 1 && ex[0]!.text.includes('child ran'),
    `★ 例句没跟着跳转走：${JSON.stringify(ex)}`
  )
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D3 · A → B → A 转圈：给诊断，不是转死，也不是假装「没这个词」', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '转圈', [
    { word: 'aaa', body: '@@@LINK=bbb' },
    { word: 'bbb', body: '@@@LINK=aaa' }
  ])
  const d = new Dicts(r.db, home)
  d.rescan()

  const t0 = Date.now()
  const card = d.lookupCard('aaa')
  const ms = Date.now() - t0
  assert(ms < 3000, `★★ 转了 ${ms}ms —— 没有防环的话这里根本回不来`)
  assert(card.raw === '', `★ 转圈还给出了正文：${card.raw}`)
  assert(card.diagnostic?.status === 'REDIRECT_BROKEN', `★★ 没给诊断：${JSON.stringify(card.diagnostic)}`)
  assert(/圈/.test(card.diagnostic.says), `★ 诊断没说清是转圈：${card.diagnostic.says}`)
  /**
   * ★★ 这一条是**「说人话」**那条规矩的落点：词目就在词典里，
   *   坏的是它指向的地方。这时候显示「里没有这个词」是假话 ——
   *   他会去怀疑软件，而不是那本词典。
   */
  assert(!/没有这个词/.test(card.diagnostic.says), '★ 诊断把「跳转坏了」说成了「没收这个词」')
  assert(d.lookup('aaa').length === 0, '★ 转圈的词条不该出现在查词结果里')
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D3 · 跳太多次：停下来给诊断（上限由 core 定，不是这里）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  const words: { word: string; body: string }[] = []
  for (let i = 0; i < MAX_REDIRECT_HOPS + 4; i++) words.push({ word: `w${i}`, body: `@@@LINK=w${i + 1}` })
  words.push({ word: `w${MAX_REDIRECT_HOPS + 4}`, body: 'n. 终点\n这是链条的尽头。' })
  makeBook(home, '长链', words)

  const d = new Dicts(r.db, home)
  d.rescan()
  const card = d.lookupCard('w0')
  assert(card.diagnostic?.status === 'REDIRECT_BROKEN', `★★ 超长链没给诊断：${JSON.stringify(card.diagnostic)}`)
  assert(card.raw === '', '★ 超了上限还给正文')

  // 上限之内的照样跟到底
  const near = d.lookupCard(`w${MAX_REDIRECT_HOPS + 2}`)
  assert(near.headword === `w${MAX_REDIRECT_HOPS + 4}`, `★ 上限之内没跟到底：${near.headword}`)
  assert(near.raw.includes('终点'), `★ 上限之内没取到正文：${near.raw}`)
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D3 · 断链：指向一个不存在的词目 → 说清指向了谁', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '断链', [{ word: 'ghost', body: '@@@LINK=nowhere-at-all' }])
  const d = new Dicts(r.db, home)
  d.rescan()
  const card = d.lookupCard('ghost')
  assert(card.diagnostic?.status === 'REDIRECT_BROKEN', `★★ 断链没给诊断：${JSON.stringify(card.diagnostic)}`)
  assert(/nowhere-at-all/.test(card.diagnostic.says), `★ 没说清指向了谁：${card.diagnostic.says}`)
  assert(!card.raw.includes('@@@LINK'), '★ 断链时把跳转记录当正文交出去了')
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D3 · 多本词典：一本坏了不影响别的；顺序由 core 契约定，不由这里定', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  // 扫描顺序 = 目录顺序，所以名字前缀决定 sort_order
  makeBook(home, '1单词本', [{ word: 'brunt', body: 'n. 冲击力' }])
  makeBook(home, '2坏的', [{ word: 'bear the brunt of', body: '@@@LINK=转圈了' }, { word: '转圈了', body: '@@@LINK=bear the brunt of' }])
  makeBook(home, '3整条本', [{ word: 'bear the brunt of', body: 'v. 首当其冲' }])

  const d = new Dicts(r.db, home)
  d.rescan()
  const hits = d.lookup('bear the brunt of')

  /**
   * ★★ 整条命中优先于词目命中 —— 这是 `core/dict/lookup.ts` 的契约
   *   （候选词在外层、词典顺序在内层）。第 3 本收了整条，
   *   第 1 本只收了 brunt：该给他第 3 本那条。
   *   反过来（词典顺序压过候选档次）就会拿第 1 本的 brunt 交差，
   *   而他永远不知道有一本收了整条。
   */
  assert(hits.length === 1, `该只有整条那一本命中，实际 ${hits.length}：${JSON.stringify(hits.map((h) => h.bookname))}`)
  assert(hits[0]!.bookname === '3整条本', `★★ 优先级不对：${hits[0]!.bookname}`)
  assert(hits[0]!.headword === 'bear the brunt of', `★ 词目不对：${hits[0]!.headword}`)

  // 第 2 本那条转圈的没把整次查词带塌
  assert(!hits.some((h) => h.text.includes('@@@LINK')), '★★ 坏的那本把跳转记录漏出来了')
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D3 · 同形异义没有因为接线被吞：三本都收的词，三本都要出来', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '1甲', [{ word: 'gap', body: 'n. 甲的解释' }])
  makeBook(home, '2乙', [{ word: 'gap', body: 'n. 乙的解释' }])
  makeBook(home, '3丙', [{ word: 'gaps', body: '@@@LINK=gap' }, { word: 'gap', body: 'n. 丙的解释' }])

  const d = new Dicts(r.db, home)
  d.rescan()
  assert(d.lookup('gap').length === 3, '★★ 三本都收了 gap，接线之后少了')
  // 跳转过来的那本也照样算一本
  const viaLink = d.lookup('gaps')
  assert(viaLink.length === 1 && viaLink[0]!.bookname === '3丙', `★ 跳转命中的那本没出来：${JSON.stringify(viaLink)}`)
  assert(viaLink[0]!.text.includes('丙的解释'), '★ 跳转之后取错了正文')
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D3 · 没有跳转的词一个字都没变（漂移只许出现在 redirect 上）', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '普通', [
    { word: 'brunt', body: 'n. 冲击力\nCoastal towns bear the brunt of these storms every winter.' },
    { word: 'ASIO', body: 'n. 澳大利亚安全情报组织' }
  ])
  const d = new Dicts(r.db, home)
  d.rescan()

  // 大小写：他划拉的是 ASIO，卡片上就该是 ASIO（索引是小写键的，别让归一漏到屏幕上）
  assert(d.lookupCard('ASIO').headword === 'ASIO', `★★ 词目被归一成小写了：${d.lookupCard('ASIO').headword}`)
  assert(d.lookup('ASIO')[0]!.headword === 'ASIO', '★★ lookup 里的词目也被归一了')
  // 多词表达退到词目：仍然是那个词
  assert(d.lookup('bear the brunt of')[0]!.headword === 'brunt', '★ 退到词目那一档变了')
  // 例句照旧
  const ex = d.examples('bear the brunt of')
  assert(ex.length === 1 && ex[0]!.text.includes('Coastal towns'), `★ 例句变了：${JSON.stringify(ex)}`)
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════
// ★★ D4 · 富媒体链路（2026-08-20）
//
// 真词典那几档在 `tests/dict-behavior.ts` 的 `rich` 节
//（牛津高阶10 / 朗文6 / LDOCE5 × brunt，取到字节、magic 对得上）
// 与第③档 `tests/ui-dict.test.ts`（真屏幕上点了真的响）。
// 这一批用造出来的词典验那些真词典里不好造的边界。
// ══════════════════════════════════════════════════════════════

check('★★ D4 · 没有资源的词典：能力里不许有 audio / image', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '纯文本', [{ word: 'gap', body: 'n. 缺口\nMind the gap when you leave the train.' }])

  const d = new Dicts(r.db, home)
  d.rescan()
  const card = buildRichCard(d.registry, 'gap')
  assert(card.entry !== null, '★ 查不到')
  const caps = card.entry.capabilities
  /**
   * ★★ 他的 D4 第 7 条：不许出现「按钮显示了但点了没声音」。
   *   一本没有任何资源包的词典，能力里就不该有 audio / image ——
   *   界面按能力画按钮，能力错了界面必然错。
   */
  assert(!caps.includes('audio'), `★★ 凭空多出了 audio 能力：${caps.join(' ')}`)
  assert(!caps.includes('image'), `★★ 凭空多出了 image 能力：${caps.join(' ')}`)
  assert(card.refs.audio.length === 0 && card.refs.image.length === 0, '★ 凭空多出了资源引用')
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D4 · 消毒之后的 HTML 里没有可执行的东西，资源只剩 ref', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '带毒', [
    {
      word: 'gap',
      body:
        '<div class="entry"><script>window.nyx.data.softDelete("project",1)</script>' +
        '<a href="sound://gap.mp3" onclick="alert(1)">读</a>' +
        '<img src="https://tracker.example/x.png"><img src="gap.png">' +
        '<span class="def">n. 缺口</span></div>'
    }
  ])

  const d = new Dicts(r.db, home)
  d.rescan()
  const card = buildRichCard(d.registry, 'gap')
  const html = card.html
  assert(!/<script/i.test(html), `★★★ 消毒之后还有 script：${html}`)
  assert(!/softDelete/.test(html), '★★★ 脚本正文还在')
  assert(!/onclick/i.test(html), `★★★ 内联事件还在：${html}`)
  assert(!/tracker\.example/.test(html), '★★★ 外链还在 —— 那是一次外发')
  assert(!/sound:\/\//i.test(html), `★★ 原始 sound:// 还在：${html}`)
  assert(/data-nyx-audio=/.test(html), '★ 发音引用被清没了')
  assert(/class="def"/.test(html), '★ 把该留的 class 也删了 —— 词典 CSS 就失配了')
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D4 · ref 是可逆的，而且认不出的 ref 一律取不到东西', async () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '甲', [{ word: 'gap', body: '<div>n. 缺口</div>' }])
  const d = new Dicts(r.db, home)
  d.rescan()
  const uid = d.registry.records()[0]!.uid!

  // 可逆：拆开来还是那两段
  const ref = mediaRef(uid, '\\a.mp3')
  const back = parseMediaRef(ref)
  assert(back?.bookUid === uid && back.key === '\\a.mp3', `★★ ref 不可逆：${JSON.stringify(back)}`)

  /**
   * ★★ 渲染层传来的东西一律不信：形状不对、指向别的 uid、
   *   或者想拿它当路径用 —— 一律取不到东西，不猜、不回退。
   */
  for (const bad of ['', 'garbage', 'a|b|c', mediaRef('别的书', '\\a.mp3')]) {
    const parsed = parseMediaRef(bad)
    const got = parsed ? await d.registry.resource(parsed.bookUid, parsed.key) : null
    assert(got === null, `★★★ 认不出的 ref 居然取到了东西：${bad}`)
  }
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

check('★★ D4 · 资源有上限：过大的不塞进 IPC', () => {
  const small = toDataUrl(new Uint8Array(1024), 'audio/mpeg', 'audio')
  assert('dataUrl' in small && small.dataUrl.startsWith('data:audio/mpeg;base64,'), '★ 正常大小的没给出 data: URI')
  /**
   * ★ 他点名要有上限。实测他那 22 本里发音最大 13 KB、图片最大约 200 KB，
   *   所以正常内容碰不到 —— 上限挡的是坏掉的、或者故意做大的那种。
   */
  const huge = toDataUrl(new Uint8Array(MEDIA_LIMITS.image + 1), 'image/png', 'image')
  assert('tooBig' in huge, '★★ 超大资源没有被挡住')
  d0()
  function d0(): void {
    /* 这条是纯函数，不需要库 */
  }
})

check('★★ D4 · R4 · 捞例句不写库：已有的 analysis_blocks 一个字不动', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const home = join(dir, 'dicts')
  makeBook(home, '例句本', [
    {
      word: 'brunt',
      // 造的是 StarDict（没有画像），所以走的是老那条「捞行」的路 —— 正合适：
      // 这一条验的是「捞例句不写库」，不是「结构化例句更好」
      body: ['n. 冲击力', 'Coastal towns bear the brunt of these storms every winter.'].join(String.fromCharCode(10))
    }
  ])
  const repo = new Repo(r.db)
  const lec = repo.ensurePath('P', 'U', 'L')
  const item = repo.addItem(lec, 'brunt', '', 'B', '').id
  const t = Date.now()
  r.db
    .prepare(
      `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
       values (?, 'examples', ?, ?, ?)`
    )
    .run(item, JSON.stringify([{ text: '他自己改过的那一条', source: 'user' }]), t, t)
  const before = r.db.prepare(`select content from analysis_blocks where item_id = ?`).get(item) as {
    content: string
  }

  const d = new Dicts(r.db, home)
  d.rescan()
  const ex = d.examples('brunt')
  assert(ex.length >= 1, `★ 一条例句都没捞到：${JSON.stringify(ex)}`)

  /**
   * ★★★ 他的 R4：**不要自动批量覆盖已有 analysis_blocks。**
   *   新的 `examples()` 只影响「以后产生的新内容」——
   *   它本身只是**读**，一个字都不许往库里写。
   *   重新捞是另一个动作（D-149：手动触发、且不覆盖他改过的块），这里不碰。
   */
  const after = r.db.prepare(`select content from analysis_blocks where item_id = ?`).get(item) as {
    content: string
  }
  assert(after.content === before.content, '★★★ 捞例句把他改过的那一块盖掉了')
  d.closeAll()
  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── I-037 / I-038 · 材料格式 ──────────────────────────────────────
check('★ .docx 读得出正文（自己按 ZIP 格式拼一个真的出来）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-doc-'))
  const p = join(dir, '测试.docx')
  writeFileSync(p, makeDocx('Coastal towns bear the brunt of these storms.', '第二段在这里。'))

  const d = readDocument(p)
  assert(d.kind === 'docx', `格式判断错了：${d.kind}`)
  assert(d.text.includes('Coastal towns bear the brunt'), `正文没读出来：${d.text.slice(0, 60)}`)
  assert(d.text.includes('第二段'), '第二段丢了 —— 段落边界没保住')
  rmSync(dir, { recursive: true, force: true })
})

check('Markdown 只去记号，不吃掉正文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-md-'))
  const p = join(dir, 'a.md')
  writeFileSync(
    p,
    ['# 标题', '', 'This is **important** and [a link](http://x).', '', '```', 'code() // 不该留下', '```', '', '> 引用的一句话。'].join('\n'),
    'utf8'
  )
  const d = readDocument(p)
  assert(d.text.includes('This is important and a link.'), `记号没去干净：${d.text}`)
  assert(d.text.includes('标题'), '标题内容被连着记号一起删了')
  assert(d.text.includes('引用的一句话'), '引用被吃掉了')
  assert(!d.text.includes('code()'), '代码块留下来了 —— 那不是要学的英文')
  rmSync(dir, { recursive: true, force: true })
})

check('★ I-038 · 字幕去时间轴，而且把断行接回句子', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    'Coastal towns bear the brunt',
    '',
    '2',
    '00:00:03,500 --> 00:00:06,000',
    'of these storms every winter.',
    '',
    '3',
    '00:00:06,000 --> 00:00:08,000',
    'of these storms every winter.',
    '',
    '4',
    '00:00:08,000 --> 00:00:10,000',
    'The damage compounds.'
  ].join('\n')

  const out = stripSubtitleTiming(srt)
  assert(!/-->/.test(out), `时间轴还在：${out}`)
  assert(!/^\d+$/m.test(out), '序号还在')
  assert(
    out.includes('Coastal towns bear the brunt of these storms every winter.'),
    `断行没接回句子 —— 每句被切碎，判层和出处都会歪：\n${out}`
  )
  assert(
    (out.match(/every winter/g) ?? []).length === 1,
    `滚动字幕的重复行没去掉：\n${out}`
  )
  assert(out.includes('The damage compounds.'), '最后一句丢了')
})

check('★ I-073 · PDF 不再假装能读 —— 当场说清，并给出可行的替代做法', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-pdf-'))
  const f = join(dir, 'a.pdf')
  makePdf(f, 'Coastal towns bear the brunt of these storms every winter.')

  let msg = ''
  try {
    readDocument(f)
  } catch (e) {
    msg = (e as Error).message
  }
  assert(msg.includes('PDF'), `报错里没说是 PDF：${msg}`)
  assert(msg.includes('docx') || msg.includes('粘贴'), `没告诉他下一步怎么办：${msg}`)
  rmSync(dir, { recursive: true, force: true })
})

check('不认识的格式说人话，并给下一步', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-x-'))
  const p = join(dir, 'a.pptx')
  writeFileSync(p, 'x')
  let msg = ''
  try {
    readDocument(p)
  } catch (e) {
    msg = (e as Error).message
  }
  assert(msg.includes('.docx'), `没告诉他支持什么：${msg}`)
  assert(msg.includes('粘贴'), '没给下一步')
  rmSync(dir, { recursive: true, force: true })
})

// I-046 - the original must stay untouched until he accepts
check('★ I-046 · 建议摆着不改原句；接受之后才改，而且留痕', () => {
  const { db: p, backups, dir } = freshDir()
  const r = openDatabase(p, backups)
  const study = new Study(r.db, join(dir, 'prompts'), () => 'B2')

  const t = Date.now()
  const ORIGINAL = 'For all intensive purposes the rule still holds.'
  const itemId = Number(
    r.db
      .prepare(
        `insert into items (term, layer, kind, source, created_at, updated_at)
         values (?, 'A', 'sentence', 'self', ?, ?)`
      )
      .run(ORIGINAL, t, t).lastInsertRowid
  )
  r.db
    .prepare(`insert into occurrences (item_id, quote, created_at, updated_at) values (?, ?, ?, ?)`)
    .run(itemId, ORIGINAL, t, t)
  r.db
    .prepare(
      `insert into analysis_blocks (item_id, block, content, created_at, updated_at)
       values (?, 'suspect', ?, ?, ?)`
    )
    .run(
      itemId,
      JSON.stringify([
        { was: 'For all intensive purposes', should: 'For all intents and purposes', why: '听岔的同音词' }
      ]),
      t,
      t
    )

  // 建议存在，但原句必须原封不动 —— D-006 保护的就是这个
  const before = (r.db.prepare(`select term from items where id = ?`).get(itemId) as { term: string })
    .term
  assert(before === ORIGINAL, `建议一存进去原句就被改了：${before}`)

  const after = study.acceptSuspect(itemId, 0)
  assert(after.startsWith('For all intents and purposes'), `接受之后没改对：${after}`)

  // 出处也要跟着改，否则条目和原文摘句对不上（M-012）
  const q = (r.db.prepare(`select quote from occurrences where item_id = ?`).get(itemId) as {
    quote: string
  }).quote
  assert(q.includes('intents and purposes'), `出处没跟着改：${q}`)

  // 改过什么要留痕
  const ev = r.db
    .prepare(`select content from analysis_blocks where item_id = ? and block = 'corrections'`)
    .get(itemId) as { content: string } | undefined
  assert(ev?.content.includes('intensive'), '改了却没留痕 —— 回头查不到当时到底记的是什么')

  // 只有那一条建议，接受完这一块就该收掉
  const left = r.db
    .prepare(`select count(*) as n from analysis_blocks where item_id = ? and block = 'suspect'`)
    .get(itemId) as { n: number }
  assert(left.n === 0, '建议接受完了还留在那里')

  r.db.close()
  rmSync(dir, { recursive: true, force: true })
})

